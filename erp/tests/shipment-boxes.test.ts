import { describe, expect, it } from "vitest";
import { TARE_EACH } from "@/lib/order-boxes";
import { FREIGHT_AMOUNT, SHIPMENT_TARE_EACH, SHIP_NOW_NET_WEIGHT } from "@/lib/shipment-boxes";
import { TARE_EACH_LB } from "@/lib/weight-terms";

describe("shipment boxes", () => {
  it.each([
    [SHIP_NOW_NET_WEIGHT, "Ship now net weight (lb)", { intDigits: 10, scale: 2, min: "nonnegative" }],
    [SHIPMENT_TARE_EACH, TARE_EACH_LB, { intDigits: 10, scale: 2, min: "nonnegative" }],
    [FREIGHT_AMOUNT, "Freight amount", { intDigits: 10, scale: 2, min: "nonnegative" }],
  ] as const)("%j", (shipmentBox, label, box) => {
    expect(shipmentBox).toEqual({ label, box });
  });

  it("a shipment's Tare each is the order's one definition, not a second copy", () => {
    expect(SHIPMENT_TARE_EACH).toBe(TARE_EACH);
  });
});
