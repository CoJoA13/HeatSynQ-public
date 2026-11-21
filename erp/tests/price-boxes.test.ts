import { describe, expect, it } from "vitest";
import {
  BREAK_PRICE, BREAK_THRESHOLD, MINIMUM_CHARGE, QUOTE_EACH_WEIGHT, SETUP_CHARGE, UNIT_PRICE,
} from "@/lib/price-boxes";
import { EACH_WEIGHT_LB } from "@/lib/weight-terms";

describe("price boxes", () => {
  it.each([
    [SETUP_CHARGE, "Setup charge", { intDigits: 10, scale: 2, min: "nonnegative" }],
    [UNIT_PRICE, "Unit price", { intDigits: 8, scale: 4, min: "nonnegative" }],
    [MINIMUM_CHARGE, "Minimum charge", { intDigits: 10, scale: 2, min: "nonnegative" }],
    [BREAK_THRESHOLD, "Threshold", { intDigits: 10, scale: 2, min: "positive" }],
    [BREAK_PRICE, "Price", { intDigits: 8, scale: 4, min: "nonnegative" }],
    [QUOTE_EACH_WEIGHT, EACH_WEIGHT_LB, { intDigits: 6, scale: 4, min: "positive" }],
  ] as const)("%j", (priceBox, label, box) => {
    expect(priceBox).toEqual({ label, box });
  });
});
