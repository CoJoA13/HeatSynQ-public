import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createDraftStore } from "../src/lib/draft-store";
import { createDraftSession } from "../src/lib/draft-session";
import { type QuoteDetailData } from "../src/app/quotes/quote-form";
import { quoteBaselineFrom, quoteDraftFrom, quoteRecoveryAdapter, runQuoteSave, type QuoteRecoveryCatalogs, type QuoteDraft } from "../src/lib/quote-recovery";
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
function openQuote() {
  const baseline = quoteBaselineFrom(detail(), catalogs); const clean = quoteDraftFrom(baseline);
  const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "u1")!;
  const binding = store.bind({ owner, record: { kind: "quote", id: "quote-a" }, editor: quoteRecoveryAdapter.kind }, { label: "Quote", href: "/quotes/quote-a" }, quoteRecoveryAdapter);
  const detach = binding.attach("first"); const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
  return { binding, store, baseline, clean, detach };
}

function actualQuoteCallback<T>(name: string, environment: Record<string, unknown>): T {
  const path = new URL("../src/app/quotes/[id]/QuoteDetail.tsx", import.meta.url);
  const source = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: ts.FunctionDeclaration | ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer
      && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === "useCallback") found = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(source); if (!found) throw new Error(`Missing actual quote callback ${name}`);
  const code = ts.transpileModule(`return (${found.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(environment), code)(...Object.values(environment)) as T;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}
describe("actual quote return read crossing detached Save settlement", () => {
  for (const scenario of ["clean", "unadded", "first-failed", "fresh-denied", "fresh-closed", "second-change"] as const) it(`qualified return read after settlement: ${scenario}`, async () => {
    const unadded = scenario === "unadded";
    const f = openQuote(); const session = createDraftSession(f.store);
    const breakDrafts: QuoteDraft["breakDrafts"] = unadded ? { "price-a": { threshold: " 100 ", price: "unadded raw" } } : {};
    f.binding.change(d => ({ ...d, header: { ...d.header, rfqNumber: "acknowledged RFQ" },
      lines: d.lines.map(l => ({ ...l, prices: l.prices.map(p => ({ ...p, unitPrice: "5.25" })) })),
      breakDrafts }));
    const patch = deferred<QuoteDetailData>(); const write = vi.fn(() => patch.promise);
    const oldLifetime = { current: true }; const staleUi = vi.fn();
    const saving = runQuoteSave({ binding: f.binding, requestId: "held-save", write, rejected: () => false,
      persisted: () => { if (oldLifetime.current) staleUi(); } });
    expect(write).toHaveBeenCalledTimes(1); expect(write.mock.calls[0]).toBeDefined();
    const secondPatch = deferred<QuoteDetailData>();
    const secondSaving = scenario === "second-change" ? runQuoteSave({ binding: f.binding, requestId: "second-held-save",
      write: () => secondPatch.promise, rejected: () => false, persisted: () => {} }) : null;
    oldLifetime.current = false; f.detach(); f.binding.attach("returned component");
    const me = deferred<{ id: string; permissions: string[] }>(); const meStarted = deferred<void>();
    const saved = detail(); saved.rfqNumber = "acknowledged RFQ"; saved.lines[0].prices[0].unitPrice = 5.25;
    let quoteGets = 0, meGets = 0;
    const api = async (url: string) => {
      if (url === "/api/quotes/quote-a") { quoteGets++; return quoteGets === 1 ? detail() : { ...saved, ...(scenario === "fresh-closed" ? { status: "CLOSED" } : {}) }; }
      if (url === "/api/auth/me") { meGets++; if (meGets === 1) { meStarted.resolve(); return me.promise; } if (secondSaving) { secondPatch.resolve(saved); await secondSaving; } return { id: "u1", permissions: scenario === "fresh-denied" ? ["quotes.edit"] : [...catalogs.permissions] }; }
      if (url.includes("/contacts?")) return [...catalogs.contacts];
      if (url === "/api/admin/users") return [...catalogs.users];
      if (url.includes("/endingStatement?")) return [...catalogs.statements];
      if (url.includes("/processStepCode?")) return [...catalogs.steps];
      if (url.startsWith("/api/parts?")) return [...catalogs.parts];
      throw new Error(`Unexpected actual callback read: ${url}`);
    };
    const checkIdentity = actualQuoteCallback<() => Promise<readonly string[]>>("checkIdentity", { api, getBrowserDraftSession: () => session });
    const readCatalogs = actualQuoteCallback<(customerId: string, permissions: readonly string[]) => Promise<QuoteRecoveryCatalogs>>("readCatalogs", { api });
    const load = actualQuoteCallback<() => Promise<void>>("load", { binding: f.binding, api, id: "quote-a", mounted: { current: true },
      getBrowserDraftSession: () => session, checkIdentity, readCatalogs, quoteBaselineFrom, quoteDraftFrom,
      showAccepted: vi.fn(), setError: vi.fn(), readIdRef: { current: 0 } });
    const loading = load(); await meStarted.promise;
    expect(quoteGets).toBe(1); expect(meGets).toBe(1); expect(f.binding.getSnapshot().current).toBeUndefined();
    patch.resolve(saved); expect((await saving).kind).toBe("persisted"); expect(staleUi).not.toHaveBeenCalled();
    // The returned lease has no accepted access yet. Core deliberately projects
    // loading without exposing internal settlement flags or retained payloads.
    expect(f.binding.getSnapshot().mode).toBe("loading");
    expect(f.binding.getSnapshot().current).toBeUndefined();
    expect(f.binding.getSnapshot().savedBaseline).toBeUndefined();
    expect(f.binding.getSnapshot().canRestore).toBe(false);
    if (scenario === "first-failed") me.reject(new Error("old identity read failed"));
    else me.resolve({ id: "u1", permissions: [...catalogs.permissions] });
    if (scenario === "fresh-denied") await expect(loading).rejects.toThrow("Requires quotes.view");
    else await loading;
    const after = f.binding.getSnapshot();
    // Either a qualified fresh continuation or a safely blocked view is acceptable.
    // A stale pre-save tree must never become writable clean truth.
    expect(after.mode === "editing" && !after.needsRefresh && after.current?.data.header.rfqNumber === "Saved RFQ").toBe(false);
    expect(quoteGets).toBe(2); expect(meGets).toBe(2);
    if (scenario === "second-change") {
      expect(after.mode).toBe("loading"); expect(after.current).toBeUndefined(); expect(after.canRestore).toBe(false);
      expect(write).toHaveBeenCalledTimes(1); return;
    }
    expect(after.mode).not.toBe("loading");
    if (scenario === "fresh-denied") {
      expect(after.mode).toBe("unavailable"); expect(after.current).toBeUndefined();
    } else {
      expect(after.savedBaseline?.header.rfqNumber).toBe("acknowledged RFQ");
      expect(after.needsRefresh).toBe(false);
      if (scenario === "fresh-closed") expect(after.mode).toBe("conflict");
      else if (!unadded) expect(after.mode).toBe("editing");
    }
    if (unadded) {
      expect(after.mode).toBe("offer"); expect(after.canRestore).toBe(true);
    }
    if (after.mode === "editing" && !after.needsRefresh) {
      expect(after.current?.data.header.rfqNumber).toBe("acknowledged RFQ");
      expect(after.current?.data.lines[0].prices[0].unitPrice).toBe("5.25");
    }
    if (unadded && after.current) {
      expect(after.current.data.header.rfqNumber).toBe("acknowledged RFQ");
      expect(after.current.data.lines[0].prices[0].unitPrice).toBe("5.25");
      expect(after.current.data.breakDrafts["price-a"]).toEqual({ threshold: " 100 ", price: "unadded raw" });
    }
    expect(write).toHaveBeenCalledTimes(1);
  });
});
