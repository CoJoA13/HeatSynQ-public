import { expect, it } from "vitest";
import { newShipmentBaselineFrom } from "../src/lib/new-shipment-recovery";
it("retains an explicit minimal shipment baseline rather than whole endpoint response objects", () => {
  const response = {
    permissions: ["shipping.create", "customers.view", "orders.view"],
    customer: { id: "customer", code: "C", name: "Customer", creditHold: false, creditLimit: "PRIVATE UNRELATED CUSTOMER VALUE" },
    addresses: [{ id: "address", kind: "SHIP_TO", name: "Dock", street: "Main", city: "Town", state: "IL", zip: "12345", audit: "PRIVATE ADDRESS AUDIT" }],
    carriers: [{ id: "carrier", name: "Carrier", internalMetadata: "PRIVATE CARRIER METADATA" }],
    orders: [{ id: "order", customerId: "customer", orderNumber: 42, poNumber: "PO", customerJobNo: "Job", status: "OPEN", voided: false,
      notes: "PRIVATE ORDER NOTES", loads: [{ contents: "PRIVATE LOAD" }], charges: [{ contents: "PRIVATE CHARGE" }],
      lines: [{ id: "line", position: 1, qty: 10, weight: 20, quoteId: "PRIVATE QUOTE ID", part: { partNumber: "P", name: "Part", internalMetadata: "PRIVATE PART" } }],
      containers: [{ id: "container", count: 1, customerContainerId: "Box", type: { name: "Box", metadata: "PRIVATE TYPE" } }],
      serials: [{ id: "serial", lineId: "line", serial: "Serial", description: "Description", audit: "PRIVATE SERIAL AUDIT" }],
      orderLineShippedToDate: [{ orderLineId: "line", shippedToDateQty: 2, shippedToDateWeight: 4, metadata: "PRIVATE LEDGER" }],
    }],
  };
  const baseline = newShipmentBaselineFrom(response);
  expect(JSON.stringify(baseline)).not.toContain("PRIVATE");
  expect(baseline).toMatchObject({ kind: "form", source: { customer: { id: "customer", code: "C" }, orders: [{ id: "order", lines: [{ id: "line", qty: 10, weight: 20 }] }] } });
  response.orders[0].lines[0].qty = 999;
  expect(baseline).toMatchObject({ source: { orders: [{ lines: [{ qty: 10 }] }] } });
});
it("copies a container row's tare each when it is a number, a 0 included, and leaves the key out when the order's row has none", () => {
  const container = (tareEach?: number | null) =>
    ({ id: "container", count: 1, customerContainerId: "Box", type: { name: "Box" }, ...(tareEach === undefined ? {} : { tareEach }) });
  const baseline = newShipmentBaselineFrom({ permissions: [], customer: null, addresses: [], carriers: [],
    orders: [{ id: "order", customerId: "customer", orderNumber: 42, poNumber: "PO", customerJobNo: "Job", status: "OPEN", voided: false,
      lines: [], serials: [], orderLineShippedToDate: [], containers: [container(42.5), container(0), container(null), container()] }] });
  expect(baseline.kind === "form" && baseline.source.orders[0].containers).toStrictEqual([
    { id: "container", count: 1, customerContainerId: "Box", type: { name: "Box" }, tareEach: 42.5 },
    { id: "container", count: 1, customerContainerId: "Box", type: { name: "Box" }, tareEach: 0 },
    { id: "container", count: 1, customerContainerId: "Box", type: { name: "Box" } },
    { id: "container", count: 1, customerContainerId: "Box", type: { name: "Box" } },
  ]);
});
