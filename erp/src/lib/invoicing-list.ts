// The Invoicing list's four views (spec 2026-10-30-ux-redesign-design.md §4.5; the UX redesign
// PR 6, owner 2026-10-31 on #821). Ready to invoice is the candidates table alone, a VIEW the page
// switches, never a filter of the register; Drafts, To print and Register are settings of the
// register's Status and Printed selects, which the list already has (the Printed select is PR 6's,
// the server's filter of the same name behind it), never a filter of their own: the active tab is
// DERIVED from the view and the two selects (`presetFor`), so Status = Finalized chosen by hand
// with Printed blank lights nothing, and Customer and the dates narrow within a preset (the
// board's rule, `board-presets.ts`). Ready leaves the register's selects as they stand, so
// returning to the register finds them. Structural over the page's own filters type; client-safe.
import type { InvoicePrinted, InvoiceStatusValue } from "./invoice-constants";

export type InvoicingView = "ready" | "invoices";
export type InvoicingPresetKey = "ready" | "drafts" | "toPrint" | "register";

export const INVOICING_PRESETS: { key: InvoicingPresetKey; label: string }[] = [
  { key: "ready", label: "Ready to invoice" },
  { key: "drafts", label: "Drafts" },
  { key: "toPrint", label: "To print" },
  { key: "register", label: "Register" },
];

type PresetFields = { view: InvoicingView; status: InvoiceStatusValue | ""; printed: InvoicePrinted | "" };

export function applyPreset<F extends PresetFields>(filters: F, key: InvoicingPresetKey): F {
  switch (key) {
    case "ready": return { ...filters, view: "ready" };
    case "drafts": return { ...filters, view: "invoices", status: "DRAFT", printed: "" };
    case "toPrint": return { ...filters, view: "invoices", status: "FINALIZED", printed: "0" };
    case "register": return { ...filters, view: "invoices", status: "", printed: "" };
  }
}

/** The preset the view and the two selects equal, or null for a pair no preset sets. */
export function presetFor(filters: PresetFields): InvoicingPresetKey | null {
  if (filters.view === "ready") return "ready";
  if (filters.status === "DRAFT" && filters.printed === "") return "drafts";
  if (filters.status === "FINALIZED" && filters.printed === "0") return "toPrint";
  if (filters.status === "" && filters.printed === "") return "register";
  return null;
}

/** Ready to invoice's own filters (#1057 ruling 6, owner 2026-11-26): a Customer and a ship-date
 *  range From/To, which the server applies to each order's last live shipment
 *  (`listInvoiceCandidates`). Their own, never the register's: the register's dates are invoice
 *  dates (ruling 3), and its Customer narrows the register. */
export type ReadyFilters = { customerId: string; from: string; to: string };

export const READY_DEFAULTS: ReadyFilters = { customerId: "", from: "", to: "" };

/** The candidates read's query string, `GET /api/invoices?candidates=1` and the filters set, each
 *  under the name `parseInvoiceFilter` reads (src/app/api/invoices/query.ts). A blank filter is left
 *  out, so the default read is the one the page always sent. */
export function candidatesQuery(filters: ReadyFilters): string {
  const params = new URLSearchParams({ candidates: "1" });
  if (filters.customerId) params.set("customerId", filters.customerId);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  return params.toString();
}

/** Create all shown's confirm (#1057 ruling 6b): it names how many drafts it will make, before
 *  anything is sent. */
export function createAllConfirmParts(count: number): { title: string; body: string } {
  return count === 1
    ? { title: "Create 1 draft invoice?", body: "One draft for the order listed, dated today." }
    : { title: `Create ${count} draft invoices?`, body: `One draft for each of the ${count} orders listed, dated today.` };
}

/** Said when the list changed while Create all shown's confirm was open, so nothing was sent. */
export const CREATE_ALL_LIST_CHANGED = "The list changed while you were asked; nothing was created. Check it and try again.";
