// The quotes list's leaf (spec 2026-10-30-ux-redesign-design.md §4.5; PR 3, owner 2026-10-31).
// The filter shape and `buildQuery` moved here from Quotes.tsx so the page, its Export link and
// the presets read one definition: `buildQuery` mirrors `src/app/api/quotes/query.ts`'s
// `parseQuoteFilter` in reverse (the InvoicingList precedent), so the list and its Excel export can
// never disagree about what a query string means. A preset (Follow-up due / Expired / All quotes)
// is a setting of two controls the list already has, the Follow-up due box and the Status select,
// never a filter of its own: `followUpDue=1` and `expired=1` are the worklist predicates verbatim
// (`src/server/quotes.ts`, the two §5.4 predicates), so the tabs show exactly the rows the two
// worklist sections showed. The active tab is DERIVED from the filters (`presetFor`), so nothing
// keeps a stale tab lit; Search, Customer and the date ranges narrow within a preset and keep it
// shown (the board's rule, `board-presets.ts`). Client-safe; imports one type.
import type { QuoteStatusValue } from "./quote-constants";

/** The status filter offers the DERIVED "Expired" display state as a third option beside the two
 *  stored statuses (ruling 3) — it maps to `expired=1`, not to a status token the server would
 *  reject. */
export type StatusFilter = "" | QuoteStatusValue | "EXPIRED";

export type QuoteFilters = {
  search: string; status: StatusFilter; followUpDue: boolean; customerId: string;
  quoteFrom: string; quoteTo: string;
  effectiveFrom: string; effectiveTo: string;
  expiryFrom: string; expiryTo: string;
};

export const DEFAULT_FILTERS: QuoteFilters = {
  search: "", status: "", followUpDue: false, customerId: "",
  quoteFrom: "", quoteTo: "", effectiveFrom: "", effectiveTo: "", expiryFrom: "", expiryTo: "",
};

export function buildQuery(filters: QuoteFilters): string {
  const params = new URLSearchParams();
  if (filters.search.trim()) params.set("search", filters.search.trim());
  if (filters.status === "EXPIRED") params.set("expired", "1");
  else if (filters.status) params.set("status", filters.status);
  if (filters.followUpDue) params.set("followUpDue", "1");
  if (filters.customerId) params.set("customerId", filters.customerId);
  if (filters.quoteFrom) params.set("quoteFrom", filters.quoteFrom);
  if (filters.quoteTo) params.set("quoteTo", filters.quoteTo);
  if (filters.effectiveFrom) params.set("effectiveFrom", filters.effectiveFrom);
  if (filters.effectiveTo) params.set("effectiveTo", filters.effectiveTo);
  if (filters.expiryFrom) params.set("expiryFrom", filters.expiryFrom);
  if (filters.expiryTo) params.set("expiryTo", filters.expiryTo);
  return params.toString();
}

export type QuotePresetKey = "followUp" | "expired" | "all";

export const QUOTE_PRESETS: { key: QuotePresetKey; label: string }[] = [
  { key: "followUp", label: "Follow-up due" },
  { key: "expired", label: "Expired" },
  { key: "all", label: "All quotes" },
];

export function applyPreset(filters: QuoteFilters, key: QuotePresetKey): QuoteFilters {
  return { ...filters, followUpDue: key === "followUp", status: key === "expired" ? "EXPIRED" : "" };
}

/** The preset the Follow-up due box and the Status select equal, or null. */
export function presetFor(filters: QuoteFilters): QuotePresetKey | null {
  if (filters.followUpDue) return filters.status === "" ? "followUp" : null;
  if (filters.status === "EXPIRED") return "expired";
  return filters.status === "" ? "all" : null;
}

/** A worklist view is worked oldest debt down, as the two worklist sections were (`quoteWorklist`
 *  ordered `followUpDate asc` / `expiryDate asc`, the newer quote first on a tie), while the register
 *  stays in the server's order (`quoteNumber desc`); the list has no window, so the view is sorted
 *  here. A null date, which the view's predicate never admits, sorts last. Never sorts in place. */
export function sortForPreset<R extends { quoteNumber: number; followUpDate: string | null; expiryDate: string | null }>(
  rows: R[], key: QuotePresetKey | null,
): R[] {
  if (key !== "followUp" && key !== "expired") return rows;
  const date = key === "followUp" ? (r: R) => r.followUpDate : (r: R) => r.expiryDate;
  return [...rows].sort((a, b) => {
    const da = date(a); const db = date(b);
    if (da !== db) {
      if (da === null) return 1;
      if (db === null) return -1;
      return da < db ? -1 : 1;
    }
    return b.quoteNumber - a.quoteNumber;
  });
}
