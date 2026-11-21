// Both shipment pages' tabs (spec 2026-10-30-ux-redesign-design.md §4.4; PR 4, owner 2026-10-31):
// New shipment's three, the saved shipment's four, and the tab a New shipment box id sits on, so a
// refused Save opens it before the cursor lands (review focus 1).
import { describe, expect, it } from "vitest";
import { tabForLocation, tabsWithUnsaved } from "@/lib/record-tabs";
import { SHIPMENT_BOX, shipmentContainerBoxId, shipmentLineBoxId } from "@/lib/shipment-box-ids";
import {
  NEW_SHIPMENT_TAB_LABEL, SHIPMENT_TAB_LABEL, newShipmentTabForBox, newShipmentTabs, shipmentTabs,
} from "@/lib/shipment-tabs";

describe("New shipment's tabs", () => {
  it("names the three tabs in order, Customer & route first", () => {
    expect(newShipmentTabs().map((t) => [t.key, t.label])).toEqual([
      ["route", "Customer & route"], ["orders", "Orders & containers"], ["freight", "Freight & review"],
    ]);
    expect(NEW_SHIPMENT_TAB_LABEL).toBe("New shipment sections");
    expect(tabForLocation(newShipmentTabs(), "", "")).toBe("route");
  });

  it("names the tab each refusable box sits on", () => {
    expect(newShipmentTabForBox(SHIPMENT_BOX.customer)).toBe("route");
    expect(newShipmentTabForBox(SHIPMENT_BOX.creditHoldReason)).toBe("route");
    expect(newShipmentTabForBox(SHIPMENT_BOX.shipDate)).toBe("route");
    expect(newShipmentTabForBox(SHIPMENT_BOX.addOrder)).toBe("orders");
    expect(newShipmentTabForBox(shipmentLineBoxId("order-1", 0, "weight"))).toBe("orders");
    expect(newShipmentTabForBox(shipmentContainerBoxId("order-1", 2, "tareEach"))).toBe("orders");
    expect(newShipmentTabForBox(SHIPMENT_BOX.freightAmount)).toBe("freight");
    expect(newShipmentTabForBox(SHIPMENT_BOX.packageCount)).toBe("freight");
    expect(newShipmentTabForBox("something-else")).toBe("route");
  });
});

describe("the saved shipment's tabs", () => {
  it("names the four tabs in order, Orders & quantities first", () => {
    expect(shipmentTabs().map((t) => [t.key, t.label])).toEqual([
      ["orders", "Orders & quantities"], ["header", "Header & freight"], ["documents", "Documents"], ["history", "History"],
    ]);
    expect(SHIPMENT_TAB_LABEL).toBe("Shipment sections");
    expect(tabForLocation(shipmentTabs(), "", "#documents")).toBe("documents");
    expect(tabForLocation(shipmentTabs(), "", "#history")).toBe("history");
    expect(tabForLocation(shipmentTabs(), "?tab=header", "")).toBe("header");
  });

  it("badges the grids' unsaved work on Orders & quantities alone (review focus 2)", () => {
    for (const label of ["Lines", "Containers", "Serials"]) {
      expect([...tabsWithUnsaved(shipmentTabs(), [label])]).toEqual(["orders"]);
    }
    expect(tabsWithUnsaved(shipmentTabs(), []).size).toBe(0);
  });
});
