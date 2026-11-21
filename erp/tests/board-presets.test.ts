// The board's view presets (spec 2026-10-30-ux-redesign-design.md §4.5; PR 2): a preset is a set
// of the existing filter controls, derived from the filters the page already holds, so the tab
// row has no state of its own. The status boxes alone define a preset; Include voided is the
// explicit filter spec §4.5 leaves it (PR 3, owner 2026-10-31), and Search, Customer and the date
// ranges narrow within a preset and keep it shown (the executor's call, PR 2's plan, Task 1).
import { describe, expect, it } from "vitest";
import { defaultFilters } from "@/lib/board-columns";
import { BOARD_PRESETS, applyPreset, presetFor } from "@/lib/board-presets";

const OPEN = ["OPEN", "PARTIAL_SHIPPED", "REOPENED"] as const;

describe("board presets", () => {
  it("names the two presets in order", () => {
    expect(BOARD_PRESETS).toEqual([{ key: "open", label: "Open orders" }, { key: "all", label: "All orders" }]);
  });

  it("applies open: the three open statuses, every other field kept, Include voided too", () => {
    const out = applyPreset({ ...defaultFilters(), search: "x", includeVoided: true }, "open");
    expect(out.status).toEqual([...OPEN]);
    expect(out.includeVoided).toBe(true);
    expect(out.search).toBe("x");
  });

  it("applies all: no status predicate", () => {
    const out = applyPreset({ ...defaultFilters(), status: ["SHIPPED"], includeVoided: true, customerId: "c" }, "all");
    expect(out.status).toEqual([]);
    expect(out.includeVoided).toBe(true);
    expect(out.customerId).toBe("c");
  });

  it("names the preset the filters equal, as a set", () => {
    expect(presetFor(defaultFilters())).toBe("all");
    expect(presetFor({ ...defaultFilters(), status: ["REOPENED", "OPEN", "PARTIAL_SHIPPED"] })).toBe("open");
    expect(presetFor({ ...defaultFilters(), status: [...OPEN], includeVoided: true })).toBe("open");
    expect(presetFor({ ...defaultFilters(), status: ["OPEN"] })).toBeNull();
  });

  it("round-trips both presets", () => {
    for (const { key } of BOARD_PRESETS) expect(presetFor(applyPreset(defaultFilters(), key))).toBe(key);
  });

  it("a search, date or voided edit keeps the preset, a status edit clears it", () => {
    const open = applyPreset(defaultFilters(), "open");
    expect(presetFor({ ...open, search: "x", requestFrom: "2026-10-01" })).toBe("open");
    expect(presetFor({ ...open, status: [...OPEN, "SHIPPED"] })).toBeNull();
    expect(presetFor({ ...open, includeVoided: true })).toBe("open");
  });
});
