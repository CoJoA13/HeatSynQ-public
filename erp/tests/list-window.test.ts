import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LIST_WINDOW, cutToWindow, showAllClicked, showAllFor, windowNotice } from "../src/lib/list-window";

// Ruling R3 (2026-10-22 review, #612; landing unit 24, PR B): the board, shipping and invoicing
// lists default to the newest 200 rows with a visible "Showing newest 200, refine or show all";
// exports stay unlimited. The owner's PR B answer (2026-10-25): the window is the FIRST 200 rows of
// the applied sort, the newest 200 under the default order-number sort. The rule is the pure leaf
// `src/lib/list-window.ts`: the window's size, the cut of a read taken one past it, and the
// sentence, which says "newest" only under a newest-first sort (under another sort the first 200
// are not the newest, and a sentence must be true).

describe("list window leaf (#612, ruling R3)", () => {
  it("is 200 rows", () => { expect(LIST_WINDOW).toBe(200); });

  it("cuts a read taken one past the window, and says so", () => {
    const rows = Array.from({ length: 201 }, (_, i) => i);
    expect(cutToWindow(rows)).toEqual({ rows: rows.slice(0, 200), cut: true });
    expect(cutToWindow(rows.slice(0, 200))).toEqual({ rows: rows.slice(0, 200), cut: false });
    expect(cutToWindow([])).toEqual({ rows: [], cut: false });
    expect(cutToWindow([1, 2, 3], 2)).toEqual({ rows: [1, 2], cut: true });
  });

  it("says the ruled sentence under a newest-first sort, names the sort otherwise, and nothing when not cut", () => {
    expect(windowNotice(false, { newestFirst: true })).toBeNull();
    expect(windowNotice(true, { newestFirst: true })).toEqual({ lead: "Showing newest 200, refine or", action: "show all" });
    expect(windowNotice(true, { newestFirst: false })).toEqual({ lead: "Showing first 200 of this sort, refine or", action: "show all" });
  });
});

describe("show all is for the query it was clicked under, and every click is a new request (#612 PR B, Codex)", () => {
  it("a click records the query and a new attempt, so a repeat click after a failed read sends again", () => {
    const first = showAllClicked(null, "search=4471");
    expect(first).toEqual({ query: "search=4471", attempt: 1 });
    const again = showAllClicked(first, "search=4471");
    expect(again).toEqual({ query: "search=4471", attempt: 2 });
    expect(again).not.toBe(first);
  });

  it("the override holds for its own query and is dropped the moment the query leaves it, so a revisited query is windowed again", () => {
    const clicked = showAllClicked(null, "search=4471");
    expect(showAllFor(clicked, "search=4471")).toBe(clicked);
    expect(showAllFor(clicked, "search=447")).toBeNull();
    expect(showAllFor(null, "search=4471")).toBeNull();
    // Dropped, not retained: back on the first query the window applies again.
    expect(showAllFor(showAllFor(clicked, "search=447"), "search=4471")).toBeNull();
  });
});

describe("the board reads through the window (#612 PR B)", () => {
  const page = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  it("asks the route for the windowed envelope, shows all for the current query only, and draws the leaf's sentence", () => {
    expect(page).toContain('import { showAllClicked, showAllFor, windowNotice, type ListWindow, type ShowAll } from "@/lib/list-window";');
    expect(page).toContain("window=1");
    expect(page).toContain("showAll=1");
    // The override is the leaf's, asked by `load` itself: a stored click under another query is
    // dropped before any read and the drop re-runs the load windowed; each click is a new attempt.
    expect(page).toContain("const override = showAllFor(showAllState, query);");
    expect(page).toContain("if (override !== showAllState) { setShowAllState(override); return; }");
    expect(page).toContain('window=1${override !== null ? "&showAll=1" : ""}');
    expect(page).toContain("}, [query, showAllState, latest]);");
    expect(page).toContain("windowNotice(cut, { newestFirst: sort.sort === \"orderNumber\" && sort.dir === \"desc\" })");
    expect(page).toContain("onClick={() => setShowAllState((prev) => showAllClicked(prev, queryString))}");
  });
});

describe("the shipping list reads through the window (#612 PR C)", () => {
  const page = readFileSync(new URL("../src/app/shipping/ShippingList.tsx", import.meta.url), "utf8");
  it("asks the route for the windowed envelope, shows all for the current query only, and draws the ruled sentence", () => {
    expect(page).toContain('import { showAllClicked, showAllFor, windowNotice, type ListWindow, type ShowAll } from "@/lib/list-window";');
    expect(page).toContain("const override = showAllFor(showAllState, query);");
    expect(page).toContain("if (override !== showAllState) { setShowAllState(override); return; }");
    expect(page).toContain('api<ListWindow<ShipperRow>>(`/api/shippers?${query ? `${query}&` : ""}window=1${override !== null ? "&showAll=1" : ""}`)');
    expect(page).toContain("}, [query, showAllState, latest]);");
    // The list's sort is fixed, newest ship date first, so the ruled sentence applies as written.
    expect(page).toContain("windowNotice(cut, { newestFirst: true })");
    expect(page).toContain("onClick={() => setShowAllState((prev) => showAllClicked(prev, query))}");
    // The Export link's query string is never windowed.
    expect(page).toContain('href={`/api/shippers/export${query ? `?${query}` : ""}`}');
  });
});

describe("the Invoicing list reads through the window (#612 PR D)", () => {
  const page = readFileSync(new URL("../src/app/invoicing/InvoicingList.tsx", import.meta.url), "utf8");
  it("asks the route for the windowed envelope, shows all for the current query only, and draws the ruled sentence", () => {
    expect(page).toContain('import { showAllClicked, showAllFor, windowNotice, type ListWindow, type ShowAll } from "@/lib/list-window";');
    expect(page).toContain("const override = showAllFor(showAllState, query);");
    expect(page).toContain("if (override !== showAllState) { setShowAllState(override); return; }");
    expect(page).toContain('api<ListWindow<InvoiceRegisterRow>>(`/api/invoices?${query ? `${query}&` : ""}window=1${override !== null ? "&showAll=1" : ""}`)');
    expect(page).toContain("}, [query, showAllState, invoicesLatest]);");
    // The list's sort is fixed, newest invoice date first, so the ruled sentence applies as written.
    expect(page).toContain("windowNotice(cut, { newestFirst: true })");
    expect(page).toContain("onClick={() => setShowAllState((prev) => showAllClicked(prev, query))}");
    // Both exports follow the applied query, which is never windowed.
    expect(page).toContain("setAppliedQuery(query);");
    expect(page).toContain('<ExportLink base="/api/invoices/export" query={appliedQuery} ready={exportable} />');
  });
});
