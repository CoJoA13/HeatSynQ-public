// The customers list's presets (spec 2026-10-30-ux-redesign-design.md §4.5; the UX redesign PR 8,
// owner 2026-11-01 on #823): Active customers and Include inactive are the two states of the
// Show inactive box the list already sends (`includeInactive=1`), never a filter of their own, so
// one is always lit: the active tab is DERIVED from the box (`presetFor`), the shipping list's rule
// (`shipping-presets.ts`). Structural over the page's own filter type; import-free, client-safe.

export type CustomerPresetKey = "active" | "inactive";

/** The `ListTabs` group's name, what the E2E helper `openCustomersView` finds. */
export const CUSTOMER_VIEWS_LABEL = "Customer views";

export const CUSTOMER_PRESETS: { key: CustomerPresetKey; label: string }[] = [
  { key: "active", label: "Active customers" },
  { key: "inactive", label: "Include inactive" },
];

export function applyPreset<F extends { showInactive: boolean }>(filters: F, key: CustomerPresetKey): F {
  return { ...filters, showInactive: key === "inactive" };
}

/** The preset the Show inactive box equals: one of the two, always. */
export function presetFor(filters: { showInactive: boolean }): CustomerPresetKey {
  return filters.showInactive ? "inactive" : "active";
}
