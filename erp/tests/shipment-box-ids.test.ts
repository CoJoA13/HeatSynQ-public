import { describe, expect, it } from "vitest";
import { SHIPMENT_BOX, shipmentContainerBoxId, shipmentLineBoxId, shipmentServerRefusalBox } from "@/lib/shipment-box-ids";

describe("New shipment's box ids", () => {
  it("names a row's box by its order and its place, so two order panels never share one", () => {
    expect(shipmentLineBoxId("o1", 0, "qty")).toBe("shipment-o1-line-0-qty");
    expect(shipmentLineBoxId("o2", 0, "qty")).not.toBe(shipmentLineBoxId("o1", 0, "qty"));
    expect(shipmentLineBoxId("o1", 2, "weight")).toBe("shipment-o1-line-2-weight");
    expect(shipmentContainerBoxId("o1", 1, "tareEach")).toBe("shipment-o1-container-1-tareEach");
    expect(new Set(Object.values(SHIPMENT_BOX)).size).toBe(Object.values(SHIPMENT_BOX).length);
  });
});

describe("shipmentServerRefusalBox", () => {
  const orders = ["o1", "o2"];
  it("routes a refused field's path to its box, the order taken from the body's order list", () => {
    expect(shipmentServerRefusalBox("orders.1.lines.0.weight: cannot be negative.", orders)).toBe(shipmentLineBoxId("o2", 0, "weight"));
    expect(shipmentServerRefusalBox("orders.0.lines.3.qty: Too small", orders)).toBe(shipmentLineBoxId("o1", 3, "qty"));
    expect(shipmentServerRefusalBox("orders.0.containers.1.tareEach: use at most 2 digits after the point.", orders))
      .toBe(shipmentContainerBoxId("o1", 1, "tareEach"));
    expect(shipmentServerRefusalBox("orders.1.containers.0.count: Too small", orders)).toBe(shipmentContainerBoxId("o2", 0, "count"));
    expect(shipmentServerRefusalBox("freightAmount: cannot be negative.", orders)).toBe(SHIPMENT_BOX.freightAmount);
    expect(shipmentServerRefusalBox("packageCount: Too small", orders)).toBe(SHIPMENT_BOX.packageCount);
    expect(shipmentServerRefusalBox("shipDate: Invalid input", orders)).toBe(SHIPMENT_BOX.shipDate);
  });

  it("routes the credit-hold reason's own sentence to the reason box", () => {
    expect(shipmentServerRefusalBox("A reason is required to override a credit hold", orders)).toBe(SHIPMENT_BOX.creditHoldReason);
  });

  it("routes nothing else: a stale row, a voided order, a path it cannot place, a field with no box", () => {
    for (const message of [
      "Order #701: that line does not belong to this order",
      "Order #701 has been voided",
      "A shipment needs at least one line with a positive quantity",
      "orders.5.lines.0.weight: cannot be negative.",
      "orders.0.lines.0.lineComplete: Invalid input",
      "orders.0.serials.0.printOnShipper: Invalid input",
      "carrierId: Invalid input",
      "Line orders.0.lines.0.weight: cannot be negative.",
    ]) expect(shipmentServerRefusalBox(message, orders)).toBeNull();
  });
});
