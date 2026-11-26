// The board's view presets (spec 2026-10-30-ux-redesign-design.md §4.5; PR 2, 2026-10-31). A
// preset is a setting of the filter controls the board already has, never a filter of its own:
// "Open orders" is the three open statuses, "All orders" no status predicate. The active tab is
// DERIVED from the filters (`presetFor`), so a saved view shows the preset its filters equal and
// nothing keeps a stale tab lit. The status boxes alone define a preset; Include voided is the
// explicit filter spec §4.5 leaves it (a preset neither sets nor reads it; PR 3, owner
// 2026-10-31), and Search, Customer and the date ranges narrow within a preset and keep it shown.
// The board opens on Open orders (`defaultFilters()`, #1057, owner ruling 2026-11-26) unless a default
// saved view replaces it. Import-free but for the filters type and the open statuses; client-safe.
import { OPEN_ORDER_STATUSES, type BoardFilters } from "./board-columns";

export type BoardPresetKey = "open" | "all";

export const BOARD_PRESETS: { key: BoardPresetKey; label: string }[] = [
  { key: "open", label: "Open orders" },
  { key: "all", label: "All orders" },
];

const OPEN_STATUSES = OPEN_ORDER_STATUSES;

export function applyPreset(filters: BoardFilters, key: BoardPresetKey): BoardFilters {
  return { ...filters, status: key === "open" ? [...OPEN_STATUSES] : [] };
}

/** The preset the status boxes equal (as a set), or null. */
export function presetFor(filters: BoardFilters): BoardPresetKey | null {
  if (filters.status.length === 0) return "all";
  const set = new Set(filters.status);
  const open = set.size === OPEN_STATUSES.length && OPEN_STATUSES.every((s) => set.has(s));
  return open ? "open" : null;
}
