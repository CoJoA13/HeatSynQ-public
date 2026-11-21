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
