import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createDraftStore } from "../src/lib/draft-store";
import { type QuoteDetailData } from "../src/app/quotes/quote-form";
import { quoteBaselineFrom, quoteDraftFrom, quoteRecoveryAdapter, type QuoteRecoveryCatalogs } from "../src/lib/quote-recovery";

// #618 (2026-10-22 review, landing unit 23): quote detail's `load` read the quote, then `/me`,
// then the catalogs, three serial round trips on mount and after every Save. Now the quote GET
// and `/me` go out together, and the catalogs wait for BOTH: the quote's identity (its id and the
// retained customer), the owner match and `quotes.view` are all checked before any catalog request
// (the draft-recovery design's rule: identity resolved before retained content shows). The
// callbacks are lifted from the production source (the `quote-save-read-overlap` precedent), so a
// catalog sent early, or a `/me` sent late, is red here.

const catalogs: QuoteRecoveryCatalogs = {
  permissions: ["quotes.edit", "quotes.view", "parts.view", "customers.view", "action.manage_users"],
  contacts: [], users: [], statements: [], steps: [], parts: [], materials: [],
};
function detail(customerId = "customer-a"): QuoteDetailData {
  return {
    id: "quote-a", quoteNumber: 101, status: "OPEN", expired: false, customerId, customerCode: "ACME", customerName: "Example Company",
    contactId: null, contactName: "", quoteDate: "2026-09-12", effectiveDate: "2026-09-12", expiryDate: "2026-10-12", followUpDate: null,
    rfqNumber: "Saved RFQ", quotedById: "", quotedByName: "", endingStatementId: null, endingStatementName: "", endingStatementText: "",
    closeReason: "", closedAt: null, closedByName: "", notes: "", internalNotes: "", deletedAt: null, lines: [],
  };
}
function openQuote() {
  const baseline = quoteBaselineFrom(detail(), catalogs); const clean = quoteDraftFrom(baseline);
  const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "u1")!;
  const binding = store.bind({ owner, record: { kind: "quote", id: "quote-a" }, editor: quoteRecoveryAdapter.kind }, { label: "Quote", href: "/quotes/quote-a" }, quoteRecoveryAdapter);
  binding.attach("first"); const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
  return { binding, store };
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const source = (() => {
  const path = new URL("../src/app/quotes/[id]/QuoteDetail.tsx", import.meta.url);
  return ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
})();
function lifted<T>(name: string, environment: Record<string, unknown>): T {
  let found: ts.FunctionDeclaration | ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer
      && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === "useCallback") found = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(source); if (!found) throw new Error(`Missing quote callback ${name}`);
  const code = ts.transpileModule(`return (${found.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(environment), code)(...Object.values(environment)) as T;
}

/** The production `load` over a held `api`: the quote GET and `/me` are deferred, every other URL
 *  answers at once and is recorded. */
function heldLoad(opts: { me: { id: string; permissions: string[] }; quote: QuoteDetailData; retained?: boolean }) {
  const { binding, store } = openQuote();
  // A retained edit is what carries the customer id into the read's requirements.
  if (opts.retained) binding.change((d) => ({ ...d, header: { ...d.header, rfqNumber: "retained private" } }));
  const session = { store, readAuthorizationTicket: () => ({}), isReadAuthorized: () => true };
  const seen: string[] = [];
  const quote = deferred<QuoteDetailData>(); const me = deferred<{ id: string; permissions: string[] }>();
  const api = async (url: string) => {
    seen.push(url);
    if (url === "/api/quotes/quote-a") return quote.promise;
    if (url === "/api/auth/me") return me.promise;
    return [];
  };
  const checkIdentity = lifted<() => Promise<readonly string[]>>("checkIdentity", { api, getBrowserDraftSession: () => session });
  const readCatalogs = lifted<(customerId: string, permissions: readonly string[]) => Promise<QuoteRecoveryCatalogs>>("readCatalogs", { api });
  const showAccepted = vi.fn(); const setError = vi.fn();
  const load = lifted<() => Promise<void>>("load", { binding, api, id: "quote-a", mounted: { current: true },
    getBrowserDraftSession: () => session, checkIdentity, readCatalogs, quoteBaselineFrom, quoteDraftFrom, showAccepted, setError, readIdRef: { current: 0 } });
  return { binding, seen, quote, me, load, showAccepted, setError, answers: opts };
}

describe("quote detail's load (#618)", () => {
  it("sends /me beside the quote GET, and the catalogs only after both answered", async () => {
    const h = heldLoad({ me: { id: "u1", permissions: [...catalogs.permissions] }, quote: detail() });
    const running = h.load(); await flush();
    expect(h.seen).toEqual(["/api/quotes/quote-a", "/api/auth/me"]);
    h.me.resolve(h.answers.me); await flush();
    expect(h.seen).toHaveLength(2);
    h.quote.resolve(h.answers.quote); await flush();
    expect(h.seen.slice(2).sort()).toEqual([
      "/api/admin/users", "/api/customers/customer-a/contacts?includeInactive=1", "/api/parts?includeInactive=1&customerId=customer-a",
      "/api/picklists/endingStatement?includeInactive=1", "/api/picklists/material?includeInactive=1", "/api/picklists/processStepCode?includeInactive=1",
    ]);
    await running;
    expect(h.setError.mock.calls).toEqual([[null]]);
    expect(h.showAccepted).toHaveBeenCalledTimes(1);
    expect(h.binding.getSnapshot().mode).toBe("editing");
  });

  it("a /me without quotes.view fails the load before the quote answers, and the quote's answer sends nothing", async () => {
    const h = heldLoad({ me: { id: "u1", permissions: ["quotes.edit"] }, quote: detail() });
    const running = h.load().then(() => undefined, (error: Error) => error.message);
    await flush(); h.me.resolve(h.answers.me);
    expect(await running).toBe("Requires quotes.view");
    expect(h.seen).toEqual(["/api/quotes/quote-a", "/api/auth/me"]);
    h.quote.resolve(h.answers.quote); await flush();
    expect(h.seen).toHaveLength(2);
    expect(h.binding.getSnapshot().mode).toBe("unavailable");
  });

  it("a quote whose customer is not the retained one is refused before any catalog, whichever answers first", async () => {
    for (const quoteFirst of [true, false]) {
      const h = heldLoad({ me: { id: "u1", permissions: [...catalogs.permissions] }, quote: detail("customer-b"), retained: true });
      const running = h.load().then(() => undefined, (error: Error) => error.message);
      await flush();
      if (quoteFirst) { h.quote.resolve(h.answers.quote); await flush(); h.me.resolve(h.answers.me); }
      else { h.me.resolve(h.answers.me); await flush(); h.quote.resolve(h.answers.quote); }
      expect(await running).toBe("The quote response did not match this editor.");
      expect(h.seen).toEqual(["/api/quotes/quote-a", "/api/auth/me"]);
    }
  });

  it("nativeAction's catalogs seam checks identity, then reads the catalogs under those permissions", async () => {
    const order: string[] = [];
    let captured: { catalogs: () => Promise<QuoteRecoveryCatalogs> } | undefined;
    const nativeAction = lifted<(...args: unknown[]) => Promise<void>>("nativeAction", {
      binding: {}, detail: detail(), id: "quote-a", mounted: { current: true }, readIdRef: { current: 0 },
      getBrowserDraftSession: () => ({ readAuthorizationTicket: () => ({}), isReadAuthorized: () => true }),
      runQuoteNative: async (args: { catalogs: () => Promise<QuoteRecoveryCatalogs> }) => { captured = args; return { kind: "accepted", readId: 1 }; },
      checkIdentity: async () => { order.push("identity"); return ["quotes.view"]; },
      readCatalogs: async (customerId: string, permissions: readonly string[]) => { order.push(`catalogs:${customerId}:${permissions.join(",")}`); return catalogs; },
      invalidateHistory: () => {}, showAccepted: () => {}, api: () => {},
    });
    await nativeAction(() => {}, () => detail(), () => {});
    expect(captured).toBeDefined();
    await captured!.catalogs();
    expect(order).toEqual(["identity", "catalogs:customer-a:quotes.view"]);
  });
});
