// The batch list's presets (spec 2026-10-30-ux-redesign-design.md §4.5; the UX redesign PR 7,
// owner 2026-11-01 on #822): Open, Posted and All are the three settings of the Status filter the
// list already sends (`?status=`), never a filter of their own, so one is always lit: the active
// tab is DERIVED from the filter (`presetFor`), the shipping list's rule (`shipping-presets.ts`).
// Structural over the page's own filter type; client-safe.
import type { ReceiptBatchStatusValue } from "./ar-constants";

export type ReceivablesPresetKey = "open" | "posted" | "all";

/** The `ListTabs` group's name, what the E2E helper `openBatchesView` finds. */
export const RECEIVABLES_VIEWS_LABEL = "Batch views";

export const RECEIVABLES_PRESETS: { key: ReceivablesPresetKey; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "posted", label: "Posted" },
  { key: "all", label: "All" },
];

const STATUS_OF: Record<ReceivablesPresetKey, ReceiptBatchStatusValue | ""> = { open: "OPEN", posted: "POSTED", all: "" };

export function applyPreset<F extends { status: ReceiptBatchStatusValue | "" }>(filters: F, key: ReceivablesPresetKey): F {
  return { ...filters, status: STATUS_OF[key] };
}

/** The preset the status filter equals: one of the three, always (they cover its range). */
export function presetFor(filters: { status: ReceiptBatchStatusValue | "" }): ReceivablesPresetKey {
  return filters.status === "OPEN" ? "open" : filters.status === "POSTED" ? "posted" : "all";
}
