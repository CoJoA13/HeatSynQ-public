import { describe, expect, it } from "vitest";
import { RAIL_ADMIN_KEY, readAdminExpanded, storeAdminExpanded } from "@/lib/rail-admin-toggle";
import { initials } from "@/lib/initials";

/**
 * The rail's "Settings & administration" toggle (spec 2026-10-30 §4.2, ruling 6): expanded by
 * default, collapsed only by the user's own click, remembered per browser. The leaf decides what a
 * stored value means and what to store, so the Shell's storage code is one read and one write.
 */
describe("rail admin toggle", () => {
  it("has one storage key", () => { expect(RAIL_ADMIN_KEY).toBe("heatsynq.rail.admin"); });
  it("is expanded unless the stored value says collapsed", () => {
    expect(readAdminExpanded(null)).toBe(true);
    expect(readAdminExpanded("collapsed")).toBe(false);
    expect(readAdminExpanded("anything else")).toBe(true);
  });
  it("stores collapsed, and removes the key when expanded", () => {
    expect(storeAdminExpanded(false)).toBe("collapsed");
    expect(storeAdminExpanded(true)).toBeNull();
  });
});

describe("initials", () => {
  it("takes the first letter of the first two words, upper-cased; blank-safe", () => {
    expect(initials("Colton Jones")).toBe("CJ");
    expect(initials("admin")).toBe("A");
    expect(initials("  mary   ann smith ")).toBe("MA");
    expect(initials("")).toBe("");
  });
});
