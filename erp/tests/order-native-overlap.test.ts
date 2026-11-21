import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { makeMutationGate } from "../src/lib/use-latest";
import { createDraftSession } from "../src/lib/draft-session";
import { createBulkRecoveryAdapter, emptyBulkDraft } from "../src/lib/bulk-grid-recovery";
import { createOrderBulkSource, orderBulkOptions, projectLoads, type OrderBulkSnapshot } from "../src/lib/order-bulk-recovery";
import { openDraftHarness } from "./helpers/draft-store";
import { orderBulkFixture } from "./helpers/order-bulk-fixture";

type Fields = { loadNumber: string; qty: string; weight: string };
type Access = { editable: boolean; containerTypes: OrderBulkSnapshot["containerTypes"] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function changed(id: string, printed = false) {
  const snapshot = orderBulkFixture();
  snapshot.order.loads = [{ id, loadNumber: 1, qty: 10, weight: 20 }];
  snapshot.order.travelerPrinted = printed;
  return snapshot;
}
function hookMountedCallback<T>(environment: Record<string, unknown>): T {
  const filename = fileURLToPath(new URL("../src/lib/bulk-grid.ts", import.meta.url));
  const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let callback: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "register") callback = node.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(source); if (!callback) throw new Error("Production mounted registration callback missing");
  const javascript = ts.transpileModule(`return (${callback.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(environment), javascript)(...Object.values(environment)) as T;
}
function open(readAccess: () => Promise<Access> = async () => ({ editable: true, containerTypes: [] }), dirty = true) {
  const saved = orderBulkFixture();
  const adapter = createBulkRecoveryAdapter<Fields>("order-loads", "v1");
  const harness = openDraftHarness(adapter, emptyBulkDraft<Fields>(), projectLoads(saved).baseline);
  const { binding, store } = harness;
  const session = createDraftSession(store);
  if (dirty) binding.change(d => ({ ...d, edits: new Map([["load-1", { qty: "manual typed" }]]) }));
  const source = createOrderBulkSource(async () => saved.order, readAccess);
  const options = orderBulkOptions(source, saved.order.id, "order-loads", "Loads", projectLoads);
  const readRef = { current: harness.readId };
  options.register(hookMountedCallback<Parameters<typeof options.register>[0]>({ binding, readRef, options, emptyBulkDraft, getBrowserDraftSession: () => session }));
  const gate = makeMutationGate();
  let page = saved.order;
  function dispatch() {
    const ticket = gate.next(); const captured = source.begin();
    return {
      async accept(snapshot: OrderBulkSnapshot) {
        const accepted = gate.accept(ticket);
        if (accepted) { page = snapshot.order; await captured.accept(snapshot.order); }
        return accepted;
      },
      reject(status: number) { if (status === 401 || status === 403) captured.unavailable(); },
    };
  }
  return { ...harness, session, dispatch, readRef, page: () => page };
}

describe("page-accepted native recovery ordering", () => {
  it("consumed mounted IDs cannot masquerade as ordinary reads after the cohort empties or discard", () => {
    const { binding } = open();
    const readId = binding.beginMountedRead()!;
    binding.acceptRead({ kind: "authorized", readId, ...projectLoads(changed("accepted-load")) }, emptyBulkDraft());
    const accepted = binding.getSnapshot();
    binding.acceptRead({ kind: "authorized", readId, ...projectLoads(changed("duplicate-load")) }, emptyBulkDraft());
    expect(binding.getSnapshot()).toBe(accepted);
    binding.discard(binding.getSnapshot().current!.stamp);
    binding.change(d => ({ ...d, edits: new Map([["accepted-load", { qty: "new generation" }]]) }));
    const replacement = binding.getSnapshot();
    binding.acceptRead({ kind: "authorized", readId, ...projectLoads(changed("must-not-replace")) }, emptyBulkDraft());
    expect(binding.getSnapshot()).toBe(replacement);
    const ordinary = binding.beginRead();
    binding.acceptRead({ kind: "authorized", readId: ordinary, baseline: replacement.current!.baseline, editable: true }, emptyBulkDraft());
    expect(binding.getSnapshot().mode).toBe("editing");
    expect(binding.getSnapshot().current!.data.edits.get("accepted-load")).toEqual({ qty: "new generation" });
  });
  it("acceptance feedback distinguishes a consumed outcome from permission or readiness", () => {
    const { binding } = open();
    const stale = binding.beginRead(); const current = binding.beginRead();
    expect(binding.acceptRead({ kind: "unavailable", readId: stale }, emptyBulkDraft())).toBe(false);
    expect(binding.getSnapshot().mode).toBe("loading");
    expect(binding.acceptRead({ kind: "unavailable", readId: current }, emptyBulkDraft())).toBe(true);
    expect(binding.getSnapshot().mode).toBe("unavailable");
    expect(binding.getSnapshot().canRestore).toBe(false);
    expect(binding.getSnapshot().savedBaseline).toBeUndefined();
  });
  it("does not keep a detached clean binding alive for pending cohort responses", async () => {
    const { binding, store, dispatch, detach } = open(undefined, false);
    const first = dispatch(); const later = dispatch();
    await first.accept(changed("clean-load"));
    const key = binding.getSnapshot().current!.stamp.key;
    detach();
    expect(store.getSnapshot().count).toBe(0);
    const replacement = store.bind(key, { label: "Loads", href: "/orders/order-1" }, createBulkRecoveryAdapter<Fields>("order-loads", "v1"));
    expect(replacement).not.toBe(binding);
    replacement.attach("new-visit");
    await later.accept(changed("old-clean-response"));
    expect(replacement.getSnapshot().mode).toBe("loading");
    expect(replacement.getSnapshot().current).toBeUndefined();
  });
  it("adopts an earlier accepted response when a newer issued save rejects 409", async () => {
    const { binding, dispatch, page } = open();
    const first = dispatch(); const later = dispatch();
    binding.change(d => ({ ...d, edits: new Map([["load-1", { qty: "last input during requests" }]]) }));
    expect(binding.getSnapshot().mode).toBe("editing");
    expect(await first.accept(changed("replacement-load"))).toBe(true);
    later.reject(409);
    expect(binding.getSnapshot().current!.baseline.rows.map(r => r.id)).toEqual(page().loads.map(r => r.id));
    expect(binding.getSnapshot().current!.data.edits.size).toBe(0);
    expect(binding.getSnapshot().current!.data.orphanWarning).toContain("changed on the server");
  });
  it("never reverts a newer accepted result to an older response", async () => {
    const { binding, dispatch, page } = open();
    const first = dispatch(); const later = dispatch();
    expect(await later.accept(changed("newest-load"))).toBe(true);
    expect(await first.accept(changed("stale-load"))).toBe(false);
    expect(binding.getSnapshot().current!.baseline.rows.map(r => r.id)).toEqual(["newest-load"]);
    expect(page().loads[0].id).toBe("newest-load");
  });
  it("delivers an accepted older result after its auxiliary access finishes despite newer rejection", async () => {
    const firstAccess = deferred<Access>(); const secondAccess = deferred<Access>();
    const accesses = [firstAccess, secondAccess];
    const { binding, dispatch, page } = open(() => accesses.shift()!.promise);
    const first = dispatch(); const later = dispatch();
    const pending = first.accept(changed("accepted-load"));
    expect(page().loads[0].id).toBe("accepted-load");
    later.reject(409);
    secondAccess.resolve({ editable: true, containerTypes: [] });
    firstAccess.resolve({ editable: true, containerTypes: [] }); await pending;
    expect(binding.getSnapshot().current!.baseline.rows[0].id).toBe("accepted-load");
  });
  it("marks parent acceptance before awaiting auxiliary reads so old auxiliary completion cannot win", async () => {
    const firstAccess = deferred<Access>(); const secondAccess = deferred<Access>();
    const accesses = [firstAccess, secondAccess];
    const { binding, dispatch, page } = open(() => accesses.shift()!.promise);
    const first = dispatch(); const later = dispatch();
    const oldPending = first.accept(changed("older-load"));
    const newPending = later.accept(changed("newer-load"));
    expect(page().loads[0].id).toBe("newer-load");
    firstAccess.resolve({ editable: true, containerTypes: [] }); await oldPending;
    expect(binding.getSnapshot().current!.baseline.rows[0].id).not.toBe("older-load");
    secondAccess.resolve({ editable: true, containerTypes: [] }); await newPending;
    expect(binding.getSnapshot().current!.baseline.rows[0].id).toBe("newer-load");
  });
  it("lets consecutive accepted updates refresh an initially clean mounted generation", async () => {
    const { binding, dispatch } = open(undefined, false);
    const first = dispatch(); const later = dispatch();
    await first.accept(changed("first-load"));
    expect(binding.getSnapshot().current!.baseline.rows[0].id).toBe("first-load");
    await later.accept(changed("second-load"));
    expect(binding.getSnapshot().current!.baseline.rows[0].id).toBe("second-load");
  });
  it("uses the earlier accepted access ticket for Start fresh after a writer-context conflict", async () => {
    const { binding, dispatch, readRef } = open();
    const first = dispatch(); const later = dispatch();
    await first.accept(changed("changed-load", true)); later.reject(409);
    expect(binding.getSnapshot().mode).toBe("conflict");
    expect(binding.getSnapshot().current!.data.edits.get("load-1")).toEqual({ qty: "manual typed" });
    expect(binding.startFresh(readRef.current, emptyBulkDraft())).toBe(true);
    expect(binding.getSnapshot().current!.baseline.rows[0].id).toBe("changed-load");
    expect(binding.getSnapshot().reference!.data.edits.get("load-1")).toEqual({ qty: "manual typed" });
  });
  for (const invalidation of ["generation", "lease", "identity", "ordinary-read"] as const) it(`rejects old native captures after ${invalidation} invalidation`, async () => {
    const { binding, dispatch, detach, session, readRef } = open();
    const first = dispatch(); const later = dispatch();
    if (invalidation === "generation") {
      binding.discard(binding.getSnapshot().current!.stamp);
      binding.change(d => ({ ...d, edits: new Map([["load-1", { qty: "replacement generation" }]]) }));
    } else if (invalidation === "lease") { detach(); binding.attach("first-view"); }
    else if (invalidation === "identity") await session.validateIdentity(async () => ({ id: "u1" }));
    else {
      const readId = binding.beginRead(); readRef.current = readId;
      expect(binding.getSnapshot().mode).toBe("loading");
    }
    const before = binding.getSnapshot();
    await first.accept(changed("stale-first")); await later.accept(changed("stale-second"));
    expect(binding.getSnapshot()).toBe(before);
    if (before.current) expect(before.current.baseline.rows[0].id).toBe("load-1");
  });
  it("preserves a newer ordinary offer and its Restore action against delayed native access", async () => {
    const access = deferred<Access>();
    const { binding, dispatch, detach, readRef, baseline } = open(() => access.promise);
    const native = dispatch(); const delayed = native.accept(changed("stale-native"));
    detach(); binding.attach("return");
    const readId = binding.beginRead(); readRef.current = readId;
    binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, emptyBulkDraft());
    expect(binding.getSnapshot().mode).toBe("offer");
    access.resolve({ editable: true, containerTypes: [] }); await delayed;
    expect(binding.getSnapshot().mode).toBe("offer");
    expect(readRef.current).toBe(readId);
    expect(binding.restore(binding.getSnapshot().current!.stamp, readRef.current)).toBe(true);
    expect(binding.getSnapshot().current!.data.edits.get("load-1")).toEqual({ qty: "manual typed" });
  });
  it.each([401, 403])("a later raw %s refusal prevents an older auxiliary success from reauthorizing", async status => {
    const firstAccess = deferred<Access>(); const secondAccess = deferred<Access>();
    const accesses = [firstAccess, secondAccess];
    const { binding, dispatch } = open(() => accesses.shift()!.promise);
    const first = dispatch(); const later = dispatch();
    const delayed = first.accept(changed("old-authorized"));
    later.reject(status);
    expect(binding.getSnapshot().mode).toBe("unavailable");
    expect(binding.getSnapshot().savedBaseline).toBeUndefined();
    firstAccess.resolve({ editable: true, containerTypes: [] }); await delayed;
    secondAccess.resolve({ editable: true, containerTypes: [] });
    expect(binding.getSnapshot().mode).toBe("unavailable");
    expect(binding.getSnapshot().current).toBeUndefined();
  });
  it("start-fresh retires the previous mounted cohort before accepting new edits", async () => {
    const { binding, dispatch, readRef } = open();
    const first = dispatch(); const later = dispatch();
    await first.accept(changed("changed-load", true));
    expect(binding.startFresh(readRef.current, emptyBulkDraft())).toBe(true);
    binding.change(d => ({ ...d, edits: new Map([["changed-load", { qty: "new current copy" }]]) }));
    const before = binding.getSnapshot();
    await later.accept(changed("must-not-rebase-new-copy", true));
    expect(binding.getSnapshot()).toBe(before);
    expect(binding.getSnapshot().current!.data.edits.get("changed-load")).toEqual({ qty: "new current copy" });
    expect(binding.getSnapshot().reference!.data.edits.get("load-1")).toEqual({ qty: "manual typed" });
  });
  it("an ignored old-generation callback cannot replace the ticket for later conflict actions", async () => {
    const { binding, dispatch, readRef } = open();
    const first = dispatch(); const later = dispatch();
    await first.accept(changed("changed-load", true));
    expect(binding.startFresh(readRef.current, emptyBulkDraft())).toBe(true);
    binding.change(d => ({ ...d, edits: new Map([["changed-load", { qty: "new current copy" }]]) }));
    const acceptedActionId = readRef.current;
    await later.accept(changed("ignored-old-generation", true));
    expect(readRef.current).toBe(acceptedActionId);
    binding.discard(binding.getSnapshot().current!.stamp);
    expect(binding.getSnapshot().mode).toBe("conflict");
    expect(binding.startFresh(readRef.current, emptyBulkDraft())).toBe(true);
    expect(binding.getSnapshot().reference!.data.edits.get("load-1")).toEqual({ qty: "manual typed" });
  });
  it("does not run the mounted orphan pruner on work already frozen by an earlier context conflict", async () => {
    const { binding, dispatch } = open();
    const first = dispatch(); const later = dispatch();
    await first.accept(changed("first-conflict", true));
    expect(binding.getSnapshot().mode).toBe("conflict");
    const retained = binding.getSnapshot().current!;
    await later.accept(changed("second-conflict", false));
    expect(binding.getSnapshot().mode).toBe("conflict");
    expect(binding.getSnapshot().current).toBe(retained);
    expect(binding.getSnapshot().savedBaseline!.rows[0].id).toBe("second-conflict");
    expect(retained.data.edits.get("load-1")).toEqual({ qty: "manual typed" });
  });
  for (const invalidation of ["identity", "capture", "discard", "ordinary-read", "lease"] as const) it(`core independently rejects an entire cohort after ${invalidation}`, () => {
    const { binding, store, detach } = open();
    const first = binding.beginMountedRead()!; const later = binding.beginMountedRead()!;
    expect(first).not.toBeNull(); expect(later).not.toBeNull();
    if (invalidation === "identity") store.acceptIdentity(store.beginIdentityCheck(), "u1");
    if (invalidation === "capture") binding.capture([], "queued-own-save");
    if (invalidation === "discard") {
      binding.discard(binding.getSnapshot().current!.stamp);
      binding.change(d => ({ ...d, edits: new Map([["load-1", { qty: "new copy" }]]) }));
    }
    if (invalidation === "ordinary-read") binding.beginRead();
    if (invalidation === "lease") { detach(); binding.attach("first-view"); }
    const before = binding.getSnapshot();
    for (const readId of [first, later]) binding.acceptRead({ kind: "authorized", readId, ...projectLoads(changed("stale-core")) }, emptyBulkDraft());
    expect(binding.getSnapshot()).toBe(before);
  });
});
