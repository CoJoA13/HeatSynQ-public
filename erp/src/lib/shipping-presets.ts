// The shipping list's presets (spec 2026-10-30-ux-redesign-design.md §4.5; the UX redesign PR 4,
// owner 2026-10-31): Shipments and Shipment history are the two states of the Include voided box
// the list already has, never a filter of their own, so one is always lit: the active tab is DERIVED
// from the filters (`presetFor`), a hand tick of the box lights Shipment history, and Search,
// Customer and the ship-date range narrow within a preset (the board's rule, `board-presets.ts`).
// Structural over the page's own filters type; import-free, client-safe.

export type ShippingPresetKey = "shipments" | "history";

export const SHIPPING_PRESETS: { key: ShippingPresetKey; label: string }[] = [
  { key: "shipments", label: "Shipments" },
  { key: "history", label: "Shipment history" },
];

export function applyPreset<F extends { includeVoided: boolean }>(filters: F, key: ShippingPresetKey): F {
  return { ...filters, includeVoided: key === "history" };
}

/** The preset the Include voided box equals: one of the two, always. */
export function presetFor<F extends { includeVoided: boolean }>(filters: F): ShippingPresetKey {
  return filters.includeVoided ? "history" : "shipments";
}
