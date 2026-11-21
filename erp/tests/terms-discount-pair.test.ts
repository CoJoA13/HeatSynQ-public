import { describe, expect, it } from "vitest";
import { discountPairSave } from "@/lib/terms-discount-pair";

// Owner ruling 2026-11-02 on #680: Terms' Discount % and Discount days save as a pair. Leaving one
// box holds its text until the other is filled, one save then sends both, and clearing both removes
// the discount. This leaf decides it; the table sends what it is told (reference-table-inline-edit).
const NONE = { discountPercent: null, discountDays: null };
const TWO_TEN = { discountPercent: "2", discountDays: 10 };

describe("discountPairSave", () => {
  it("a row with no discount: one box filled holds, whichever box it is", () => {
    expect(discountPairSave(NONE, { discountPercent: "2" })).toEqual({ kind: "hold" });
    expect(discountPairSave(NONE, { discountDays: "10" })).toEqual({ kind: "hold" });
  });

  it("a row with no discount: both boxes filled sends both", () => {
    expect(discountPairSave(NONE, { discountPercent: " 2 ", discountDays: " 10 " }))
      .toEqual({ kind: "send", discountPercent: "2", discountDays: "10" });
  });

  it("a row with a discount: changing one box sends both, the other as it stands", () => {
    expect(discountPairSave(TWO_TEN, { discountPercent: "3" }))
      .toEqual({ kind: "send", discountPercent: "3", discountDays: "10" });
    expect(discountPairSave(TWO_TEN, { discountDays: "15" }))
      .toEqual({ kind: "send", discountPercent: "2", discountDays: "15" });
  });

  it("a row with a discount: clearing one box holds, and clearing both removes it", () => {
    expect(discountPairSave(TWO_TEN, { discountPercent: "" })).toEqual({ kind: "hold" });
    expect(discountPairSave(TWO_TEN, { discountDays: "  " })).toEqual({ kind: "hold" });
    expect(discountPairSave(TWO_TEN, { discountPercent: "", discountDays: "" }))
      .toEqual({ kind: "send", discountPercent: null, discountDays: null });
  });

  it("nothing changed sends nothing, the stored figures spelled another way included", () => {
    expect(discountPairSave(NONE, {})).toEqual({ kind: "none" });
    expect(discountPairSave(NONE, { discountPercent: "", discountDays: " " })).toEqual({ kind: "none" });
    expect(discountPairSave(TWO_TEN, {})).toEqual({ kind: "none" });
    expect(discountPairSave(TWO_TEN, { discountPercent: "2.00", discountDays: "10" })).toEqual({ kind: "none" });
  });

  it("a stored row whose discount is undefined reads as none", () => {
    expect(discountPairSave({}, { discountPercent: "2" })).toEqual({ kind: "hold" });
  });
});
