import type { OrderDetail } from "../../src/app/orders/[id]/page";
import type { OrderBulkSnapshot } from "../../src/lib/order-bulk-recovery";

export function orderBulkFixture(): OrderBulkSnapshot {
  const order: OrderDetail = {
    id: "order-1", orderNumber: 101, customerId: "customer-1", customer: { code: "ACME", name: "Acme" },
    poNumber: "", vsOrderNumber: "", customerJobNo: "", certRequired: false, certScope: "ORDER",
    receivedDate: "2026-09-12", requestDate: "2026-09-13", targetDate: null, status: "OPEN", notes: "", linkGroupId: null,
    voided: false, light: "on_target", travelerPrinted: false, linkedOrders: [],
    orderLineShippedToDate: [{ orderLineId: "line-1", shippedToDateQty: 0, shippedToDateWeight: 0 }],
    lines: [{ id: "line-1", position: 1, partId: "part-1", revisionNumber: 1, qty: 20, weight: 40,
      quoteLineId: null, quoteId: null, quoteNumber: null,
      part: { id: "part-1", partNumber: "P1", name: "Part", customer: { code: "ACME" }, serializationRequired: true, eachWeight: 2 } }],
    containers: [{ id: "container-1", position: 1, typeId: "type-1", count: 2, pieces: null, tareEach: 1.25,
      scaleGross: 4.5, customerContainerId: "  Bin-7  ", type: { name: "Basket" } }],
    charges: [{ id: "charge-1", position: 1, description: "  handling  ", amount: null }],
    loads: [{ id: "load-1", loadNumber: 1, qty: 20, weight: 40 }],
    serials: [{ id: "serial-1", lineId: "line-1", position: 1, serial: " R1 ", description: " raw " }],
  };
  return { order, editable: true, containerTypes: [{ id: "type-1", name: "Basket" }] };
}
