import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createDraftStore } from "../src/lib/draft-store";
import { createDraftSession } from "../src/lib/draft-session";
import type { QuoteDetailData } from "../src/app/quotes/quote-form";
import { quoteBaselineFrom, quoteDraftFrom, quoteRecoveryAdapter, runQuoteNative, type QuoteRecoveryCatalogs } from "../src/lib/quote-recovery";

const catalogs: QuoteRecoveryCatalogs = {
  permissions: ["quotes.edit", "quotes.view", "parts.view", "customers.view", "action.manage_users"],
  contacts: [{ id: "contact-a", name: "Pat Example", active: true }],
  users: [{ id: "user-a", displayName: "Quinn Example", active: true }],
  statements: [{ id: "statement-a", name: "Standard terms", active: true }],
  steps: [{ id: "step-a", name: "HT", active: true }],
  parts: [{ id: "part-a", customerId: "customer-a", partNumber: "P-10", name: "Bracket", active: true }],
  materials: [{ id: "material-a", name: "4140", active: true }],
};
function detail(): QuoteDetailData {
  return {
    id: "quote-a", quoteNumber: 101, status: "OPEN", expired: false, customerId: "customer-a", customerCode: "ACME", customerName: "Example Company",
    contactId: "contact-a", contactName: "Pat Example", quoteDate: "2026-09-12", effectiveDate: "2026-09-12", expiryDate: "2026-10-12", followUpDate: null,
    rfqNumber: "Saved RFQ", quotedById: "user-a", quotedByName: "Quinn Example", endingStatementId: "statement-a", endingStatementName: "Standard terms", endingStatementText: "Terms",
    closeReason: "", closedAt: null, closedByName: "", notes: "Saved notes", internalNotes: "Saved private notes", deletedAt: null,
    lines: [{ id: "line-a", position: 1, partId: null, partNumber: "RAW-10", partName: "Raw bracket", partDescription: "Description", material: "Steel", materialId: null, materialText: "Steel", partMaterialId: null, eachWeight: 1.25,
      quotedQty: 10, quotedUnlimited: false, linkedOrderCount: 0, linkedOrders: [], prices: [
        { id: "price-a", processStepCodeId: "step-a", stepCode: "HT", stepName: "Heat treat", position: 1, setupCharge: 5, unitPrice: 2.5, minimumCharge: null,
          pricePer: "EACH", notes: "Process notes", breaks: [{ id: "break-a", threshold: 100, price: 2 }] },
      ] }],
  };
}

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  const store = createDraftStore(); const session = createDraftSession(store);
  const owner = store.acceptIdentity(store.beginIdentityCheck(), "u1")!;
  const baseline = quoteBaselineFrom(detail(), catalogs); const clean = quoteDraftFrom(baseline);
  const binding = store.bind({ owner, record: { kind: "quote", id: "quote-a" }, editor: quoteRecoveryAdapter.kind }, { label: "Quote", href: "/quotes/quote-a" }, quoteRecoveryAdapter);
  const detach = binding.attach("original"); binding.acceptRead({ kind: "authorized", readId: binding.beginRead(), baseline, editable: true }, clean);
  binding.change(d => ({ ...d, breakDrafts: { "price-a": { threshold: "  00.50  ", price: "bad" } } }));
  const ticket = session.readAuthorizationTicket()!; let live = true;
  const held = deferred<QuoteRecoveryCatalogs>(); const ackStarted = deferred<void>();
  const response = { ...detail(), status: "CLOSED" as const };
  const write = vi.fn(async () => response); const rollback = vi.fn(async () => detail()); const accepted = vi.fn();
  const acknowledged = vi.fn(() => { ackStarted.resolve(); throw new Error("history listener failed"); });
  const running = runQuoteNative({ binding, write, detail: value => value, catalogs: () => held.promise,
    authorized: () => live && session.isReadAuthorized(ticket), acknowledged, accepted, rollback })
    .then(value => ({ value }), error => ({ error })); // Attach rejection handling before the intentional throw.
  return { binding, store, session, baseline, clean, held, ackStarted, write, rollback, accepted, acknowledged, running,
    detach: () => { live = false; detach(); } };
}
describe("known quote native persistence survives a throwing history acknowledgement", () => {
  for (const result of ["granted", "denied", "failed"] as const) it(`${result} catalogs still finalize original native access after the history listener throws`, async () => {
    const h = fixture(); await h.ackStarted.promise;
    expect(h.write).toHaveBeenCalledTimes(1); expect(h.acknowledged).toHaveBeenCalledTimes(1);
    expect(h.accepted).not.toHaveBeenCalled();
    if (result === "failed") h.held.reject(new Error("catalog unavailable"));
    else h.held.resolve(result === "denied" ? { ...catalogs, permissions: ["quotes.edit"] } : catalogs);
    await h.running; // Error-reporting policy is deliberately not specified by this test.
    expect(h.write).toHaveBeenCalledTimes(1); expect(h.rollback).not.toHaveBeenCalled();
    const view = h.binding.getSnapshot();
    if (result === "granted") {
      expect(view.savedBaseline?.status).toBe("CLOSED"); expect(view.canRestore).toBe(false);
      const retained = view.current ?? view.reference;
      expect(retained?.data.breakDrafts["price-a"]).toEqual({ threshold: "  00.50  ", price: "bad" });
    } else {
      expect(view.mode).toBe("unavailable"); expect(view.current).toBeUndefined(); expect(view.reference).toBeUndefined();
      expect(h.accepted).not.toHaveBeenCalled(); expect(h.store.getSnapshot().count).toBe(1);
    }
  });
  it("an old throwing acknowledgement cannot adopt into a replacement live lease", async () => {
    const h = fixture(); await h.ackStarted.promise; h.detach(); h.binding.attach("replacement");
    const readId = h.binding.beginRead(); h.binding.acceptRead({ kind: "authorized", readId, baseline: h.baseline, editable: true }, h.clean);
    const newer = h.binding.getSnapshot(); h.held.resolve(catalogs); await h.running;
    expect(h.binding.getSnapshot()).toBe(newer); expect(h.accepted).not.toHaveBeenCalled();
    expect(h.rollback).not.toHaveBeenCalled(); expect(h.write).toHaveBeenCalledTimes(1);
  });
});

it("successful native reconciliation returns a truthful history warning only after held catalogs", async () => {
  const h = fixture(); let finished = false; void h.running.then(() => { finished = true; });
  await h.ackStarted.promise; expect(finished).toBe(false); expect(h.accepted).not.toHaveBeenCalled();
  h.held.resolve(catalogs); const result = await h.running;
  expect("value" in result).toBe(true);
  if (!("value" in result)) return;
  const value = result.value as { kind: string; readId?: number; warning?: Error };
  expect(value.kind).toBe("accepted"); expect(value.readId).toBeTypeOf("number");
  expect(value.warning?.message).toMatch(/Quote action completed.*history.*history listener failed/i);
  expect(h.binding.getSnapshot().savedBaseline?.status).toBe("CLOSED"); expect(h.accepted).toHaveBeenCalledTimes(1);
  expect(h.rollback).not.toHaveBeenCalled(); expect(h.write).toHaveBeenCalledTimes(1);
});
for (const failed of [false, true]) it(`known persistence reports history and catalog ${failed ? "failure" : "denial"} after access closes`, async () => {
  const h = fixture(); await h.ackStarted.promise;
  if (failed) h.held.reject(new Error("catalog unavailable")); else h.held.resolve({ ...catalogs, permissions: ["quotes.edit"] });
  const result = await h.running;
  const error = "error" in result ? result.error : "error" in result.value ? result.value.error : undefined;
  expect(h.binding.getSnapshot().mode).toBe("unavailable");
  expect((error as Error | undefined)?.message).toMatch(/Quote action completed/i);
  expect((error as Error | undefined)?.message).toContain("history listener failed");
  expect((error as Error | undefined)?.message).toContain(failed ? "catalog unavailable" : "Requires quotes.view");
  expect(h.rollback).not.toHaveBeenCalled(); expect(h.write).toHaveBeenCalledTimes(1);
});
function actualNativeAction(environment: Record<string, unknown>) {
  const path = "src/app/quotes/[id]/QuoteDetail.tsx"; const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === "nativeAction") found = node; ts.forEachChild(node, visit); }; visit(file); expect(found).toBeDefined();
  const code = ts.transpileModule(`return (${found!.getText(file)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(environment), code)(...Object.values(environment)) as (...args: unknown[]) => Promise<void>;
}
for (const live of [true, false]) it(`actual nativeAction ${live ? "reports warning after read bookkeeping" : "does not publish an obsolete warning"}`, async () => {
  const warning = new Error("Quote action completed, but history could not be refreshed: history listener failed");
  const held = deferred<{ kind: "accepted"; readId: number; warning: Error }>();
  const readIdRef = { current: 0 }; const mounted = { current: true }; let authorized = true;
  const callback = actualNativeAction({ binding: {}, detail: detail(), id: "quote-a", mounted, readIdRef,
    getBrowserDraftSession: () => ({ readAuthorizationTicket: () => ({}), isReadAuthorized: () => authorized }),
    runQuoteNative: () => held.promise, readCatalogs: () => catalogs, invalidateHistory: () => {}, showAccepted: () => {}, api: () => {},
  });
  const running = callback(() => {}, () => detail(), () => {}).then(() => undefined, error => error);
  if (!live) { mounted.current = false; authorized = false; }
  held.resolve({ kind: "accepted", readId: 91, warning }); const observed = await running;
  if (live) { expect(readIdRef.current).toBe(91); expect(observed).toBe(warning); }
  else { expect(observed).toBeUndefined(); }
});
