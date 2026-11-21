import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createBulkRecoveryAdapter, emptyBulkDraft } from "../src/lib/bulk-grid-recovery";
import { openDraftHarness } from "./helpers/draft-store";
import { orderBulkFixture } from "./helpers/order-bulk-fixture";
import { projectLoads, projectSerials, orderAckSnapshot, createOrderBulkSource } from "../src/lib/order-bulk-recovery";
import { ApiError } from "../src/lib/fetcher";
import { gate } from "../src/lib/permission-ui";
import { newId } from "../src/lib/client-id";

function source(path: string) {
  const filename = fileURLToPath(new URL(`../src/${path}`, import.meta.url));
  return ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, path.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
function find(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  function walk(node: ts.Node) { if (!found && predicate(node)) found = node; if (!found) ts.forEachChild(node, walk); }
  walk(root); if (!found) throw new Error("Expected production callback not found"); return found;
}
function evaluateCallback<T>(callback: ts.Node, file: ts.SourceFile, environment: Record<string, unknown>): T {
  const javascript = ts.transpileModule(`return (${callback.getText(file)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(environment), javascript)(...Object.values(environment)) as T;
}

describe("production order recovery lifecycle callbacks", () => {
  it("reschedules real reads after identity authorization changes even if React batches the hidden state", () => {
    const file = source("lib/bulk-grid.ts");
    const registration = find(file, node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "register");
    let effect: ts.Node = registration;
    while (effect.parent && !(ts.isCallExpression(effect) && ts.isIdentifier(effect.expression) && effect.expression.text === "useEffect")) effect = effect.parent;
    expect(ts.isCallExpression(effect)).toBe(true);
    if (!ts.isCallExpression(effect)) return;
    const dependencies = effect.arguments[1];
    expect(dependencies && ts.isArrayLiteralExpression(dependencies)).toBe(true);
    if (!dependencies || !ts.isArrayLiteralExpression(dependencies)) return;
    expect(dependencies.elements.map(element => element.getText(file))).toEqual(expect.arrayContaining(["authorizationRevision", "drafts.identityReady"]));
    const revision = find(file, node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "authorizationRevision") as ts.VariableDeclaration;
    expect(revision.initializer?.getText(file)).toContain("getReadAuthorizationRevision()");
  });
  it("actual re-split acknowledges before an outer UI failure and retains raw failures", async () => {
    const file = source("app/orders/[id]/LoadsSection.tsx");
    const callback = find(file, node => ts.isFunctionDeclaration(node) && node.name?.text === "resplit");
    const original = orderBulkFixture();
    const adapter = createBulkRecoveryAdapter<{ loadNumber: string; qty: string; weight: string }>("order-loads", "v1");
    const { binding } = openDraftHarness(adapter, emptyBulkDraft<{ loadNumber: string; qty: string; weight: string }>(), projectLoads(original).baseline);
    binding.change(d => ({ ...d, edits: new Map([["load-1", { qty: "raw manual" }]]) }));
    const saved = orderBulkFixture(); saved.order.loads[0].qty = 10;
    const onError = vi.fn();
    let rejectRaw = true;
    const resplit = evaluateCallback<() => Promise<void>>(callback, file, {
      grid: { binding, canEdit: true }, editGate: { allowed: true }, orderId: "order-1", projectLoads, orderAckSnapshot, onError, ApiError, newId,
      api: async () => { if (rejectRaw) throw new ApiError("re-split refused", 409); return saved.order; },
      applyMutation: async (run: () => Promise<unknown>) => {
        await run();
        expect(binding.getSnapshot().current!.data.edits.size).toBe(0);
        expect(binding.getSnapshot().current!.baseline.rows[0].fields.qty).toBe("10");
        throw new Error("later UI adoption failed");
      },
    });
    await resplit();
    expect(binding.getSnapshot().current!.data.edits.get("load-1")).toEqual({ qty: "raw manual" });
    expect(onError).toHaveBeenLastCalledWith("re-split refused");
    rejectRaw = false; await resplit();
    expect(binding.getSnapshot().current!.data.edits.size).toBe(0);
    expect(binding.getSnapshot().submitted).toBeUndefined();
    expect(onError).toHaveBeenLastCalledWith("later UI adoption failed");
  });
  it("actual late re-split response cannot consume a replacement generation", async () => {
    const file = source("app/orders/[id]/LoadsSection.tsx");
    const callback = find(file, node => ts.isFunctionDeclaration(node) && node.name?.text === "resplit");
    const original = orderBulkFixture();
    const adapter = createBulkRecoveryAdapter<{ loadNumber: string; qty: string; weight: string }>("order-loads", "v1");
    const { binding } = openDraftHarness(adapter, emptyBulkDraft<{ loadNumber: string; qty: string; weight: string }>(), projectLoads(original).baseline);
    binding.change(d => ({ ...d, edits: new Map([["load-1", { qty: "old manual" }]]) }));
    const resplit = evaluateCallback<() => Promise<void>>(callback, file, {
      grid: { binding, canEdit: true }, editGate: { allowed: true }, orderId: "order-1", projectLoads, orderAckSnapshot, onError: vi.fn(), ApiError, newId,
      api: async () => {
        binding.discard(binding.getSnapshot().current!.stamp);
        binding.change(d => ({ ...d, edits: new Map([["load-1", { qty: "replacement manual" }]]) }));
        return original.order;
      },
      applyMutation: async (run: () => Promise<unknown>) => { await run(); },
    });
    await resplit();
    expect(binding.getSnapshot().current!.data.edits.get("load-1")).toEqual({ qty: "replacement manual" });
  });
  it("actual serial Save preserves unsubmitted raw text even when outer adoption throws", async () => {
    const file = source("app/orders/[id]/SerialsSection.tsx");
    const callback = find(file, node => ts.isFunctionDeclaration(node) && node.name?.text === "save");
    const original = orderBulkFixture();
    const adapter = createBulkRecoveryAdapter<{ serial: string; description: string }>("order-serials", "v1");
    const { binding } = openDraftHarness(adapter, emptyBulkDraft<{ serial: string; description: string }>(""), projectSerials(original, "line-1").baseline);
    binding.change(d => ({ ...d, added: [{ clientId: "new-1", serial: " R2 ", description: " raw description " }], rangeInput: "R{unfinished" }));
    const saved = orderBulkFixture(); saved.order.serials.push({ id: "serial-2", lineId: "line-1", position: 2, serial: "R2", description: " raw description " });
    const api = vi.fn(async () => saved.order);
    const save = evaluateCallback<() => Promise<void>>(callback, file, {
      grid: { binding, canEdit: true }, editGate: { allowed: true }, orderId: "order-1", projectSerials, orderAckSnapshot, onError: vi.fn(), ApiError, newId,
      dupes: new Set(), line: original.order.lines[0], lineLabel: () => "Lead", rows: [{ serial: " R2 ", description: " raw description " }], api,
      applyMutation: async (run: () => Promise<unknown>) => { await run(); throw new Error("stale UI"); },
    });
    await save();
    expect(api).toHaveBeenCalledWith("/api/orders/order-1/lines/line-1/serials", { method: "PUT", body: JSON.stringify([{ serial: "R2", description: " raw description " }]) });
    expect(binding.getSnapshot().current!.data.added).toEqual([]);
    expect(binding.getSnapshot().current!.data.rangeInput).toBe("R{unfinished");
    expect(binding.getSnapshot().submitted).toBeUndefined();
  });
  it("bounds draft-label readers to explicit record routes and encodes IDs as one path segment", async () => {
    const file = source("components/DraftsInTab.tsx");
    const declaration = find(file, node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "labelReaders") as ts.VariableDeclaration;
    const api = vi.fn(async (url: string) => url);
    const readers = evaluateCallback<Record<string, (id: string, signal: AbortSignal) => Promise<string>>>(declaration.initializer!, file, { api });
    const expected: Record<string, string> = { order: "orders", shipment: "shippers", invoice: "invoices", quote: "quotes", part: "parts",
      cert: "certs", "document-template": "templates", "receipt-batch": "receivables/batches", payment: "receivables/batches" };
    expect(Object.keys(readers).sort()).toEqual(Object.keys(expected).sort());
    const signal = new AbortController().signal;
    for (const [kind, prefix] of Object.entries(expected)) {
      await expect(readers[kind]("child/with?syntax", signal)).resolves.toBe(`/api/${prefix}/child%2Fwith%3Fsyntax`);
      expect(api).toHaveBeenLastCalledWith(`/api/${prefix}/child%2Fwith%3Fsyntax`, { signal });
    }
    expect(readers.practice).toBeUndefined();
  });
  it.each([
    { ready: true, owner: "u1", returned: "u2" },
    { ready: false, owner: "u1", returned: "u1" },
    { ready: true, owner: null, returned: "u1" },
  ])("refuses permission data for unmatched or hidden ownership: %j", async ({ ready, owner, returned }) => {
    const file = source("app/orders/[id]/page.tsx");
    const factory = find(file, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createOrderBulkSource") as ts.CallExpression;
    const readAccess = evaluateCallback<() => Promise<unknown>>(factory.arguments[1], file, {
      api: async (url: string) => url === "/api/auth/me" ? { id: returned, permissions: ["orders.view", "orders.edit"] } : [],
      gate,
      getBrowserDraftSession: () => ({ store: { getSnapshot: () => ({ identityReady: ready, owner: owner ? { userId: owner, authGeneration: 0 } : null }) } }),
    });
    await expect(readAccess()).rejects.toThrow();
  });
  it("accepts fresh permissions only for the ready current owner", async () => {
    const file = source("app/orders/[id]/page.tsx");
    const factory = find(file, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createOrderBulkSource") as ts.CallExpression;
    const readAccess = evaluateCallback<() => Promise<{ editable: boolean }>>(factory.arguments[1], file, {
      api: async (url: string) => url === "/api/auth/me" ? { id: "u1", permissions: ["orders.view", "orders.edit"] } : [],
      gate,
      getBrowserDraftSession: () => ({ store: { getSnapshot: () => ({ identityReady: true, owner: { userId: "u1", authGeneration: 0 } }) } }),
    });
    expect((await readAccess()).editable).toBe(true);
  });
  it.each([
    { permissions: ["orders.view", "orders.edit"], editable: true },
    { permissions: ["orders.view"], editable: false },
  ])("fresh view permission admits the correct editability: $permissions", async ({ permissions, editable }) => {
    const file = source("app/orders/[id]/page.tsx");
    const factory = find(file, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createOrderBulkSource") as ts.CallExpression;
    const readAccess = evaluateCallback<() => Promise<{ editable: boolean }>>(factory.arguments[1], file, {
      api: async (url: string) => url === "/api/auth/me" ? { id: "u1", permissions } : [], gate,
      getBrowserDraftSession: () => ({ store: { getSnapshot: () => ({ identityReady: true, owner: { userId: "u1", authGeneration: 0 } }) } }),
    });
    expect((await readAccess()).editable).toBe(editable);
  });
  it.each(["return", "mounted"] as const)("fresh view denial closes %s recovery after the order response was authorized", async lane => {
    const file = source("app/orders/[id]/page.tsx");
    const factory = find(file, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createOrderBulkSource") as ts.CallExpression;
    let releaseIdentity!: (me: { id: string; permissions: string[] }) => void;
    const identity = new Promise<{ id: string; permissions: string[] }>(resolve => { releaseIdentity = resolve; });
    const readAccess = evaluateCallback<() => Promise<{ editable: boolean; containerTypes: [] }>>(factory.arguments[1], file, {
      api: async (url: string) => url === "/api/auth/me" ? identity : [], gate,
      getBrowserDraftSession: () => ({ store: { getSnapshot: () => ({ identityReady: true, owner: { userId: "u1", authGeneration: 0 } }) } }),
    });
    const saved = orderBulkFixture().order;
    const readOrder = vi.fn(async () => saved);
    const coordinator = createOrderBulkSource(readOrder, readAccess);
    const accepted = vi.fn(); coordinator.register(() => accepted);
    if (lane === "return") {
      const result = coordinator.read().then(value => ({ value }), error => ({ error }));
      // One order GET per read(); a SECOND read() begun while this one is out under the same ticket
      // joins it (#608, tests/bulk-read-share.test.ts), which this sequential case does not touch.
      expect(readOrder).toHaveBeenCalledTimes(1);
      releaseIdentity({ id: "u1", permissions: ["orders.edit"] });
      const settled = await result;
      expect(settled).toHaveProperty("error");
      if ("error" in settled) expect(settled.error.message).toBe("Requires orders.view");
    } else {
      const read = coordinator.begin();
      const result = read.accept(saved);
      expect(accepted).not.toHaveBeenCalled();
      releaseIdentity({ id: "u1", permissions: ["orders.edit"] });
      await result;
      expect(accepted).toHaveBeenCalledExactlyOnceWith(null);
    }
  });
  it("a late mounted response cannot regress the action ticket for a newer Restore offer", () => {
    const file = source("lib/bulk-grid.ts");
    const registration = find(file, node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "register") as ts.CallExpression;
    type Fields = { serial: string };
    const adapter = createBulkRecoveryAdapter<Fields>("order-serials", "v1");
    const baseline = { rows: [{ id: "a", fields: { serial: "saved" } }], context: {} };
    const { binding, detach } = openDraftHarness(adapter, emptyBulkDraft<Fields>(""), baseline);
    binding.change(d => ({ ...d, rangeInput: "last input" }));
    const readRef = { current: 1 };
    const register = evaluateCallback<() => ((value: { baseline: typeof baseline; editable: boolean }) => void)>(registration.arguments[0], file, {
      binding, readRef, options: { rangeInput: "" }, emptyBulkDraft,
      getBrowserDraftSession: () => ({ readAuthorizationTicket: () => ({}), isReadAuthorized: () => true }),
    });
    const acceptOld = register();
    detach(); binding.attach("returned-view");
    const readId = binding.beginRead(); readRef.current = readId;
    binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, emptyBulkDraft(""));
    expect(binding.getSnapshot().mode).toBe("offer");
    acceptOld({ baseline, editable: true });
    expect(readRef.current).toBe(readId);
    expect(binding.restore(binding.getSnapshot().current!.stamp, readRef.current)).toBe(true);
    expect(binding.getSnapshot().current!.data.rangeInput).toBe("last input");
  });
  it.each([401, 403])("a raw %s mutation refusal revokes captured mounted access", async status => {
    const file = source("app/orders/[id]/page.tsx");
    const declaration = find(file, node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "applyMutation") as ts.VariableDeclaration;
    const callback = (declaration.initializer as ts.CallExpression).arguments[0];
    const unavailable = vi.fn();
    class ApiError extends Error { constructor(public status: number) { super("refused"); } }
    const apply = evaluateCallback<(run: () => Promise<never>) => Promise<void>>(callback, file, {
      ApiError, UnreadableAnswerError: class extends Error {}, mutations: { next: () => 1 }, recoverySource: { begin: () => ({ unavailable }) },
      writes: { dispatched: () => {} }, // #550's registry of writes in flight: order-hub-reads.test.ts
    });
    await expect(apply(async () => { throw new ApiError(status); })).rejects.toThrow("refused");
    expect(unavailable).toHaveBeenCalledTimes(1);
  });
});
