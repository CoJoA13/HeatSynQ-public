import { describe, it, expect } from "vitest";
import { containerTotal } from "@/lib/container-total";

// #743: the order's container total, every row's count added up (owner confirmation, 2026-10-23: the
// figure order entry's Loads card shows as Containers). Stated once, read by the tag mapping and by
// order entry's summary.
describe("containerTotal", () => {
  it("adds every row's count", () => {
    expect(containerTotal([{ count: 2 }, { count: 3 }, { count: 1 }])).toBe(6);
  });
  it("is 0 for no rows", () => {
    expect(containerTotal([])).toBe(0);
  });
  it("counts rows, never their pieces: a row's count is how many containers it is", () => {
    expect(containerTotal([{ count: 3, pieces: 252 } as { count: number }])).toBe(3);
  });
});
