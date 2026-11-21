import { describe, expect, it } from "vitest";
import {
  CHARGE_AMOUNT, LINE_NET_WEIGHT, LOAD_NET_WEIGHT, SCALE_GROSS, TARE_EACH, WEIGHT_PER_LOAD,
} from "@/lib/order-boxes";
import { NET_WEIGHT_LB, TARE_EACH_LB } from "@/lib/weight-terms";

describe("order boxes", () => {
  it.each([
    [LINE_NET_WEIGHT, NET_WEIGHT_LB, { intDigits: 10, scale: 2, min: "positive" }],
    [LOAD_NET_WEIGHT, NET_WEIGHT_LB, { intDigits: 10, scale: 2, min: "nonnegative" }],
    [TARE_EACH, TARE_EACH_LB, { intDigits: 10, scale: 2, min: "nonnegative" }],
    [SCALE_GROSS, "Scale gross (lb)", { intDigits: 10, scale: 2, min: "nonnegative" }],
    [CHARGE_AMOUNT, "Amount", { intDigits: 10, scale: 2, min: "nonnegative" }],
    [WEIGHT_PER_LOAD, "Weight per load (lb)", { intDigits: 8, scale: 2, min: "positive" }],
  ] as const)("%j", (orderBox, label, box) => {
    expect(orderBox).toEqual({ label, box });
  });
});
