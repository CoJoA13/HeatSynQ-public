// The parts list's presets (spec 2026-10-30-ux-redesign-design.md §4.5; the UX redesign PR 9, owner
// 2026-11-01 on #824): Active parts and Include inactive are the two states of the Show inactive
// box the list already sends (`includeInactive=1`), never a filter of their own, so one is always
// lit: the active tab is DERIVED from the box (`presetFor`), the customers list's rule
// (`customer-list.ts`). Structural over the page's own filter type; import-free, client-safe.

export type PartPresetKey = "active" | "inactive";

/** The `ListTabs` group's name, what the E2E helper `openPartsView` finds. */
export const PART_VIEWS_LABEL = "Part views";

export const PART_PRESETS: { key: PartPresetKey; label: string }[] = [
  { key: "active", label: "Active parts" },
  { key: "inactive", label: "Include inactive" },
];

export function applyPreset<F extends { showInactive: boolean }>(filters: F, key: PartPresetKey): F {
  return { ...filters, showInactive: key === "inactive" };
}

/** The preset the Show inactive box equals: one of the two, always. */
export function presetFor(filters: { showInactive: boolean }): PartPresetKey {
  return filters.showInactive ? "inactive" : "active";
}
