import { describe, expect, it } from "vitest";
import { normalizeTravelerSelection, travelerCoverageLabel } from "@/lib/traveler-selection";

describe("traveler selection", () => {
  it("sorts a valid set without changing the caller's selection", () => {
    const input = { mode: "loads", loadNumbers: [3, 1] };
    expect(normalizeTravelerSelection(input)).toEqual({ mode: "loads", loadNumbers: [1, 3] });
    expect(input.loadNumbers).toEqual([3, 1]);
    expect(normalizeTravelerSelection({ mode: "all" })).toEqual({ mode: "all" });
  });
  it.each([
    [], [1, 1], [0], [-1], [1.2], [Infinity], [NaN], ["1"],
    Array.from({ length: 101 }, (_, i) => i + 1),
  ].map(loadNumbers => ({ loadNumbers })))("rejects an invalid set: $loadNumbers", ({ loadNumbers }) => {
    expect(() => normalizeTravelerSelection({ mode: "loads", loadNumbers })).toThrow();
  });
  it.each([null, {}, [], { mode: "all", loadNumbers: [1] }, { mode: "loads", loadNumbers: [1], extra: true }]
    .map(input => ({ input })))("rejects malformed objects: $input",
    ({ input }) => expect(() => normalizeTravelerSelection(input)).toThrow());
  it("accepts the 100-load boundary", () => {
    const loadNumbers = Array.from({ length: 100 }, (_, i) => 100 - i);
    expect(normalizeTravelerSelection({ mode: "loads", loadNumbers })).toEqual({
      mode: "loads", loadNumbers: Array.from({ length: 100 }, (_, i) => i + 1),
    });
  });
  it("labels immutable subset metadata separately from legacy all/single rows", () => {
    expect(travelerCoverageLabel({ loadNumber: null, travelerLoadNumbers: [1, 3] })).toBe("Loads 1, 3");
    expect(travelerCoverageLabel({ loadNumber: null, travelerLoadNumbers: [] })).toBe("All loads");
    expect(travelerCoverageLabel({ loadNumber: 3, travelerLoadNumbers: [] })).toBe("Load 3");
    expect(travelerCoverageLabel({ loadNumber: null })).toBe("All loads");
  });
});
