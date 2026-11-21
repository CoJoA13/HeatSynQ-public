// erp/tests/invoice-freeze.test.ts
import { describe, it, expect } from "vitest";
import {
  INVOICE_FREEZE, invoiceFreezeSentence, invoiceLocked, type InvoicedOrder,
} from "@/lib/invoice-freeze";
import type { Gate } from "@/lib/permission-ui";

// The finalized-invoice refusal, stated once (#472). The server throws these sentences and the
// shipment page and the order hub show them as titles, so every word is pinned here as text.

const open: Gate = { allowed: true, disabled: false, title: undefined };
const voided: Gate = { allowed: false, disabled: true, title: "Shipment is voided" };
const inv = { invoiceId: "inv1", orderNumber: 1031 };

describe("INVOICE_FREEZE", () => {
  it("holds the eight leading clauses, word for word", () => {
    expect(INVOICE_FREEZE).toEqual({
      voidShipment: "This shipment cannot be voided",
      changeShipment: "This shipment cannot be changed",
      changeFreight: "This shipment's freight cannot be changed",
      removeOrder: "This order cannot be removed from the shipment",
      addLine: "A line cannot be added",
      changeLine: "A line cannot be changed",
      changeCharges: "Charges cannot be changed",
      voidOrder: "This order cannot be voided",
    });
  });
});

describe("invoiceFreezeSentence", () => {
  it("names the action, the invoice by its order number, and the page that unlocks it", () => {
    expect(invoiceFreezeSentence(INVOICE_FREEZE.changeShipment, inv)).toBe(
      "This shipment cannot be changed — Invoice 1031 is finalized; unlock it or raise a credit (see /invoicing/inv1)");
  });

  it("builds the same tail after every clause", () => {
    for (const action of Object.values(INVOICE_FREEZE)) {
      expect(invoiceFreezeSentence(action, inv)).toBe(
        `${action} — Invoice 1031 is finalized; unlock it or raise a credit (see /invoicing/inv1)`);
    }
  });
});

describe("invoiceLocked", () => {
  it("closes an open gate with the sentence for its action", () => {
    expect(invoiceLocked(open, INVOICE_FREEZE.changeFreight, inv)).toEqual({
      allowed: false, disabled: true,
      title: "This shipment's freight cannot be changed — Invoice 1031 is finalized; unlock it or raise a credit (see /invoicing/inv1)",
    });
  });

  it("leaves a closed gate alone, so it keeps its own reason", () => {
    expect(invoiceLocked(voided, INVOICE_FREEZE.changeShipment, inv)).toBe(voided);
  });

  it("leaves an open gate alone when no invoice is named", () => {
    expect(invoiceLocked(open, INVOICE_FREEZE.changeShipment, null)).toBe(open);
    expect(invoiceLocked(open, INVOICE_FREEZE.changeShipment, undefined)).toBe(open);
    // What the shipment page passes when nothing is invoiced: the first entry of an empty list.
    const none: InvoicedOrder[] = [];
    expect(invoiceLocked(open, INVOICE_FREEZE.changeShipment, none[0])).toBe(open);
  });

  it("takes a shipment's invoiced order as it stands", () => {
    const first: InvoicedOrder = { orderId: "o1", orderNumber: 1031, invoiceId: "inv1" };
    expect(invoiceLocked(open, INVOICE_FREEZE.changeLine, first).title).toBe(
      "A line cannot be changed — Invoice 1031 is finalized; unlock it or raise a credit (see /invoicing/inv1)");
  });
});
