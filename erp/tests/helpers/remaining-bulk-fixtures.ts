import type { ShipmentBulkSnapshot } from "../../src/lib/shipment-bulk-recovery";
import type { InvoiceBulkSnapshot } from "../../src/lib/invoice-bulk-recovery";
import type { PaymentBulkSnapshot } from "../../src/lib/payment-bulk-recovery";

export function shipmentFixture(): ShipmentBulkSnapshot {
  return {
    shipper: { id: "ship-1", customerId: "cust-1", customerCreditHold: false, deletedAt: null,
      reversesShipperId: null, reversedByShipperNumber: null,
      orders: [{ id: "so-1", orderId: "order-1", orderNumber: 101, sequence: 1, position: 1,
        poNumber: "PO", customerJobNo: "JOB", label: "101-1",
        orderLineShippedToDate: [{ orderLineId: "ol-1", shippedToDateQty: 2, shippedToDateWeight: 4 }],
        lines: [{ id: "sl-1", orderLineId: "ol-1", linePosition: 1, partNumber: "P-10", partName: "Shaft",
          orderedQty: 10, orderedWeight: 20, shippedToDateQty: 2, shippedToDateWeight: 4, qty: 2, weight: 4, lineComplete: false },
          { id: "sl-2", orderLineId: "ol-2", linePosition: 2, partNumber: "P-20", partName: "Pin",
            orderedQty: 5, orderedWeight: 10, shippedToDateQty: 0, shippedToDateWeight: 0, qty: 1, weight: 2, lineComplete: false }],
        // Each shipment row's tare each differs from its order row's below, so a case can tell the two apart.
        containers: [{ id: "sc-1", orderContainerId: "oc-1", typeName: "Box", customerContainerId: "B-10", count: 2, tareEach: 42.5, position: 1 },
          { id: "sc-2", orderContainerId: "oc-2", typeName: "Drum", customerContainerId: "D-20", count: 1, tareEach: 310, position: 2 }],
        serials: [{ id: "ss-1", orderSerialId: "os-1", serial: "S001", description: "Blue", printOnShipper: true },
          { id: "ss-2", orderSerialId: "os-2", serial: "S002", description: "Red", printOnShipper: false }],
      }] },
    catalogs: new Map([["order-1", {
      lines: [{ id: "ol-1", position: 1, partNumber: "P-10", partName: "Shaft", qty: 10, weight: 20, eachWeight: 2 },
        { id: "ol-2", position: 2, partNumber: "P-20", partName: "Pin", qty: 5, weight: 10, eachWeight: 2 }],
      containers: [{ id: "oc-1", typeName: "Box", customerContainerId: "B-10", count: 2, tareEach: 55 },
        { id: "oc-2", typeName: "Drum", customerContainerId: "D-20", count: 1, tareEach: 12.25 }],
      serials: [{ id: "os-1", lineId: "ol-1", serial: "S001", description: "Blue" },
        { id: "os-2", lineId: "ol-2", serial: "S002", description: "Red" }],
    }]]), permissions: ["shipping.view", "shipping.edit", "orders.view"],
  };
}
export function invoiceFixture(): InvoiceBulkSnapshot {
  return { permissions: ["invoicing.view", "invoicing.edit", "action.change_prices"], invoice: {
    id: "inv-1", orderId: "order-1", customerId: "cust-1", kind: "INVOICE", status: "DRAFT", finalizedAt: null, deletedAt: null, taxRate: 0.07,
    lines: [{ id: "il-1", position: 1, kind: "OPERATION", parentLineId: "il-parent", orderLineId: "ol-1", processStepCodeId: "step-1",
      surchargeId: "sur-1", orderChargeId: "charge-1", glAccountId: "gl-1", partNumber: "P-10", partName: "Shaft", partDescription: "Turned shaft",
      description: "Hardening", glAccountName: "Sales", qty: 10, weight: 20, eachWeight: 2, pricePer: "POUND", unitPrice: 3.5,
      setupCharge: 4, minimumCharge: 25, breakThreshold: 8, minimumApplied: false, rate: 0.05, priceSource: "QUOTE", sourceQuoteNumber: 1006, needsPrice: true, wordsChosen: true, amount: 70 },
      { id: "il-2", position: 2, kind: "CHARGE", parentLineId: null, orderLineId: null, processStepCodeId: null,
        surchargeId: null, orderChargeId: null, glAccountId: null, partNumber: "", partName: "", partDescription: "", description: "Handling", glAccountName: "",
        qty: null, weight: null, eachWeight: null, pricePer: null, unitPrice: null, setupCharge: null, minimumCharge: null, breakThreshold: null,
        minimumApplied: false, rate: null, priceSource: "MANUAL", sourceQuoteNumber: null, needsPrice: false, wordsChosen: false, amount: 5 }],
  } };
}
export function paymentFixture(): PaymentBulkSnapshot {
  return { batch: { id: "batch-1", status: "POSTED", deletedAt: null, depositDate: "2026-09-12", payments: [
    { id: "pay-1", customerId: "cust-1", customerCode: "C1", customerName: "Customer", paymentTypeId: "check", paymentTypeName: "Check",
      amount: 100, reference: "123", receivedDate: "2026-09-12", onAccount: 100, applications: [] },
  ] }, paymentId: "pay-1", permissions: ["receivables.view", "receivables.create", "action.apply_payments", "action.write_off"], candidates: [
    { id: "i1", orderId: "o1", orderNumber: 101, documentNumber: "INV-101", customerId: "cust-1", customerCode: "C1", customerName: "Customer",
      invoiceDate: "2026-09-10", dueDate: "2026-10-10", total: 100, open: 100, discount: { amount: 2, settlingAmount: null, wouldEarn: null } },
    { id: "i2", orderId: "o2", orderNumber: 102, documentNumber: "INV-102", customerId: "cust-2", customerCode: "C2", customerName: "Division",
      invoiceDate: "2026-09-11", dueDate: null, total: 200, open: 180, discount: { amount: 0, settlingAmount: 176, wouldEarn: 4 } },
  ] };
}
