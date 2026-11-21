import { describe, expect, it } from "vitest";
import { breakTextKey, retainBreakTexts, withoutBreakText } from "@/lib/price-break-texts";

// #652: a price break's typed text lives in an id-keyed draft map composed at render, never in the
// rows, so a reload replacing the rows wholesale cannot put the stored figure back under the
// cursor. The map's keys are break ids, the key space the rendered rows use (#288), and every
// landed payload prunes it to the breaks it still lists: an entry left behind would render over
// a break that re-entered under the same id. Mutation: drop the prefix test in `retainBreakTexts`.
describe("retainBreakTexts", () => {
  it("keeps every field of a live break and drops the entries of one the payload no longer lists", () => {
    const cur = {
      [breakTextKey("b1", "threshold")]: "10", [breakTextKey("b1", "price")]: "1.5",
      [breakTextKey("b2", "price")]: "2.",
    };
    expect(retainBreakTexts(cur, ["b1", "b9"])).toEqual({
      [breakTextKey("b1", "threshold")]: "10", [breakTextKey("b1", "price")]: "1.5",
    });
  });

  it("returns the same map when nothing is dropped, so a landed payload re-renders nothing for it", () => {
    const cur = { [breakTextKey("b1", "price")]: "1.5" };
    expect(retainBreakTexts(cur, ["b1", "b2"])).toBe(cur);
  });

  it("matches a break by its whole id: a break whose id begins with another's is its own", () => {
    const cur = { [breakTextKey("b10", "price")]: "3" };
    expect(retainBreakTexts(cur, ["b1"])).toEqual({});
  });
});

describe("withoutBreakText", () => {
  it("drops one field's text and leaves the break's other field", () => {
    const cur = { [breakTextKey("b1", "threshold")]: "10", [breakTextKey("b1", "price")]: "1.5" };
    expect(withoutBreakText(cur, breakTextKey("b1", "price"))).toEqual({ [breakTextKey("b1", "threshold")]: "10" });
    expect(withoutBreakText(cur, breakTextKey("b1", "price"))).not.toBe(cur);
  });
});
