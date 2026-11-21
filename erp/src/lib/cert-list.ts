// The certifications list's presets and its Scope cell (spec 2026-10-30-ux-redesign-design.md
// §4.5; the UX redesign PR 5, owner 2026-10-31 on #820). Not printed and All certifications are
// two of the three states of the Printed select the list already has, never a filter of their
// own: the active tab is DERIVED from the filters (`presetFor`), so choosing "Printed" by hand
// lights neither, and Search, Customer, Scope and Show voided narrow within a preset (the board's
// rule, `board-presets.ts`). The Scope cell holds the subject the row carries ("Load 3", "Shipper
// #1042") and the scope's label where it carries none, one rule for the list; the page's own
// subtitle keeps its "Packing List N" wording. Structural over the page's own filters type;
// client-safe.
import { CERT_SCOPE_LABELS, type CertScopeValue } from "./cert-constants";

export type CertPresetKey = "notPrinted" | "all";
/** The Printed select's three states: any, printed, not printed. */
export type CertPrinted = "" | "1" | "0";

export const CERT_PRESETS: { key: CertPresetKey; label: string }[] = [
  { key: "notPrinted", label: "Not printed" },
  { key: "all", label: "All certifications" },
];

export function applyPreset<F extends { printed: CertPrinted }>(filters: F, key: CertPresetKey): F {
  return { ...filters, printed: key === "notPrinted" ? "0" : "" };
}

/** The preset the Printed select equals, or null under "Printed", which no preset sets. */
export function presetFor(filters: { printed: CertPrinted }): CertPresetKey | null {
  if (filters.printed === "0") return "notPrinted";
  if (filters.printed === "") return "all";
  return null;
}

/** The list's Scope cell: the subject the scope carries, else the scope's label. */
export function scopeCell(row: { scope: CertScopeValue; loadNumber: number | null; shipperNumber: number | null }): string {
  if (row.scope === "LOAD" && row.loadNumber !== null) return `Load ${row.loadNumber}`;
  if (row.scope === "SHIPMENT" && row.shipperNumber !== null) return `Shipper #${row.shipperNumber}`;
  return CERT_SCOPE_LABELS[row.scope];
}
