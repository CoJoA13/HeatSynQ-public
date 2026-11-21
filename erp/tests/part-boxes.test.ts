import { describe, expect, it } from "vitest";
import { EACH_WEIGHT_LB } from "@/lib/weight-terms";
import { EACH_WEIGHT, INSPECTION_MAX, INSPECTION_MIN, LOAD_WEIGHT, READING_VALUE } from "@/lib/part-boxes";

describe("part boxes", () => {
  it.each([
    [EACH_WEIGHT, EACH_WEIGHT_LB, { intDigits: 6, scale: 4, min: "positive" }],
    [LOAD_WEIGHT, "Load weight (lb)", { intDigits: 8, scale: 2, min: "positive" }],
    [INSPECTION_MIN, "Min", { intDigits: 6, scale: 4, min: "nonnegative" }],
    [INSPECTION_MAX, "Max", { intDigits: 6, scale: 4, min: "nonnegative" }],
    [READING_VALUE, "Value", { intDigits: 6, scale: 4, min: "nonnegative" }],
  ] as const)("%j", (partBox, label, box) => {
    expect(partBox).toEqual({ label, box });
  });

  it("Max is Min's box", () => {
    expect(INSPECTION_MAX.box).toBe(INSPECTION_MIN.box);
  });
});
