// P6 step 3 (#634, #632 bug a): what a read-backed list and a detail page's pre-load branch show,
// decided once. The leaf and the hook's effect run here from the production source; the census at
// the end holds every pre-load branch and stored-documents list to the shared pieces.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { emptyListState, landFailure, landRows, listStatus, type ListState } from "../src/lib/list-status";
import { ListStatus, PageStatus } from "../src/components/PageStatus";
import { runNode, source } from "./helpers/lift-callback";
import { NOTICE, TEXT_MUTED } from "@/lib/ui-classes";

const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

describe("listStatus", () => {
  const base = { allowed: true, error: null, loadedFor: "a", key: "a", count: 1 };
  it("denied before anything, then an error, then loading until the key's read lands", () => {
    expect(listStatus({ ...base, allowed: false, error: "x" })).toBe("denied");
    expect(listStatus({ ...base, error: "x" })).toBe("error");
    expect(listStatus({ ...base, loadedFor: null })).toBe("loading");
    expect(listStatus({ ...base, loadedFor: "b" })).toBe("loading");
    expect(listStatus({ ...base, key: null })).toBe("loading");
    expect(listStatus({ ...base, count: 0 })).toBe("empty");
    expect(listStatus(base)).toBe("rows");
  });
  it("a pending first read is not loaded, so the empty sentence never shows before it lands", () => {
    const s = emptyListState<number>();
    expect(listStatus({ allowed: true, error: s.error, loadedFor: s.loadedFor, key: "a", count: s.rows.length })).toBe("loading");
  });
  it("a failed read then a landed one: rows and no error", () => {
    let s: ListState<number> = landFailure(emptyListState<number>(), "Request failed (503)");
    expect(s).toEqual({ rows: [], error: "Request failed (503)", loadedFor: null });
    s = landRows(s, "a", [1, 2]);
    expect(s).toEqual({ rows: [1, 2], error: null, loadedFor: "a" });
  });
  it("a refresh that fails keeps the key a read landed for: it never clears loaded", () => {
    const s = landFailure(landRows(emptyListState<number>(), "a", [1]), "Request failed (503)");
    expect(s.loadedFor).toBe("a");
    expect(s.rows).toEqual([1]);
  });
});

describe("useStoredDocuments' read", () => {
  const file = source("lib/use-stored-documents.ts");
  let effect: ts.Expression | undefined;
  (function walk(n: ts.Node) {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "useEffect") effect = n.arguments[0];
    ts.forEachChild(n, walk);
  })(file);
  const run = async (opts: { url: string | null; allowed: boolean; api: () => Promise<unknown>; current?: boolean }) => {
    let state: ListState<unknown> = emptyListState();
    const setState = vi.fn((u: (s: ListState<unknown>) => ListState<unknown>) => { state = u(state); });
    const api = vi.fn(opts.api);
    runNode<() => unknown>(effect!, file, {
      url: opts.url, allowed: opts.allowed, api, setState, landRows, landFailure,
      latest: { next: () => 1, isCurrent: () => opts.current ?? true },
    })();
    await flush();
    return { state, api };
  };
  it("lands rows under its url", async () => {
    const r = await run({ url: "/api/x", allowed: true, api: () => Promise.resolve([{ id: "d1" }]) });
    expect(r.state).toEqual({ rows: [{ id: "d1" }], error: null, loadedFor: "/api/x" });
  });
  it("lands a failure as its error, leaving the list unloaded", async () => {
    const r = await run({ url: "/api/x", allowed: true, api: () => Promise.reject(new Error("Request failed (503)")) });
    expect(r.state).toEqual({ rows: [], error: "Request failed (503)", loadedFor: null });
  });
  it("a superseded answer lands nothing, on either path", async () => {
    expect((await run({ url: "/api/x", allowed: true, current: false, api: () => Promise.resolve([1]) })).state).toEqual(emptyListState());
    expect((await run({ url: "/api/x", allowed: true, current: false, api: () => Promise.reject(new Error("x")) })).state).toEqual(emptyListState());
  });
  it("reads nothing without the permission or a url", async () => {
    expect((await run({ url: "/api/x", allowed: false, api: () => Promise.resolve([]) })).api).not.toHaveBeenCalled();
    expect((await run({ url: null, allowed: true, api: () => Promise.resolve([]) })).api).not.toHaveBeenCalled();
  });
});

describe("PageStatus and ListStatus", () => {
  it("PageStatus: Loading… with no error, and the banner's red, never the refusal-list class, with one", () => {
    expect(renderToStaticMarkup(<PageStatus />)).toBe(`<div class="p-6"><p class="${TEXT_MUTED}">Loading…</p></div>`);
    const failed = renderToStaticMarkup(<PageStatus error="Request failed (404)" />);
    expect(failed).toBe(`<div class="p-6"><p role="alert" class="${NOTICE.refusal}">Request failed (404)</p></div>`);
    expect(failed).not.toContain("whitespace-pre-line");
    expect(renderToStaticMarkup(<PageStatus error={null}><span>notice</span></PageStatus>)).toContain("<span>notice</span>");
  });
  it("ListStatus draws each state's sentence", () => {
    expect(renderToStaticMarkup(<ListStatus status="loading" empty="Nothing printed yet." />)).toContain("Loading…");
    expect(renderToStaticMarkup(<ListStatus status="empty" empty="Nothing printed yet." />)).toContain("Nothing printed yet.");
    expect(renderToStaticMarkup(<ListStatus status="denied" denied="Requires x" empty="e" />)).toContain("Requires x");
    expect(renderToStaticMarkup(<ListStatus status="error" error="boom" empty="e" />)).toContain("text-red-700\">boom");
    expect(renderToStaticMarkup(<ListStatus status="error" empty="e" />)).toBe("");
  });
});

// The census. Each detail page's pre-load branch returns `PageStatus`, and no client file returns a
// bare `<div className="p-6">` holding "Loading…" (#634). Each stored-documents list reads through
// `useStoredDocuments` and draws its other states through `ListStatus` (#632 bug a).
const read = (path: string) => readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), "utf8");
const PRE_LOAD = [
  "app/orders/[id]/page.tsx", "app/shipping/[id]/ShipmentDetail.tsx", "app/quotes/[id]/QuoteDetail.tsx",
  "app/parts/[id]/page.tsx", "app/customers/[id]/page.tsx", "app/invoicing/[id]/InvoiceDetail.tsx",
  "app/certs/[id]/CertDetail.tsx", "app/receivables/batches/[id]/BatchDetail.tsx", "app/admin/billing/page.tsx",
];
describe("the pre-load branches and the documents lists use the shared pieces", () => {
  for (const path of PRE_LOAD) it(`${path}: PageStatus`, () => {
    const text = read(path);
    expect(text).toMatch(/<PageStatus error=\{/);
    expect(text).not.toMatch(/<div className="p-6">\{[^}]*"Loading…"\}/);
  });
  for (const [path, list] of [
    ["app/receivables/statements/Statements.tsx", "StatementDocumentsList"],
    ["app/invoicing/[id]/InvoiceDetail.tsx", "InvoiceDocumentsList"],
    ["app/certs/[id]/CertDetail.tsx", "CertDocumentsList"],
    ["app/shipping/[id]/ShipmentDetail.tsx", "ShipmentDocumentsList"],
    ["app/quotes/[id]/QuoteDetail.tsx", "QuoteDocumentsList"],
  ] as const) it(`${list}`, () => {
    const file = source(path); let body = "";
    for (const s of file.statements) if (ts.isFunctionDeclaration(s) && s.name?.text === list) body = s.getText(file);
    // The invoice page's read is the page's own since PR 6 (its card reads the newest print from
    // the same answer) and handed to its list; every other list reads for itself.
    expect(list === "InvoiceDocumentsList" ? read(path) : body).toContain("useStoredDocuments<");
    expect(body).toMatch(/<ListStatus status=\{status\}/);
    expect(body).not.toContain("docs.length === 0");
  });
});

describe("the hub's Shipments section before its read lands", () => {
  it("says Loading…, never Nothing shipped yet. (#632)", async () => {
    const { ShipmentsSection } = await import("../src/app/orders/[id]/ShipmentsSection");
    const html = renderToStaticMarkup(<ShipmentsSection orderId="o1" orderNumber={1} viewGate={{ allowed: true, disabled: false, title: undefined }} />);
    expect(html).toContain("Loading…");
    expect(html).not.toContain("Nothing shipped yet.");
  });
});
