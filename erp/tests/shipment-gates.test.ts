import { describe, expect, it } from "vitest";
import type { Gate } from "@/lib/permission-ui";
import type { InvoicedOrder } from "@/lib/invoice-freeze";
import { invoiceNotice, shipmentFreightGate, shipmentLinesGate } from "@/lib/shipment-gates";

// #472: the gates the saved shipment page composes for a finalized invoice, and the condition for
// the amber line that names it. The page (ShipmentDetail.tsx) calls them with what it already holds
// and decides nothing more about the invoice for the controls and the line they reach, so these
// are that whole decision; tests/shipment-detail-wiring.test.ts proves which control reads which
// gate.
//
// Each title is written out here in full, not built from the leaf, so a change to the words reds
// this file. They are the server's own refusals: `replaceShipperLines` and `addOrderToShipper`
// for the first, `updateShipper` for the second (src/server/shippers.ts).

const OPEN: Gate = { allowed: true, disabled: false, title: undefined };
const closed = (title: string): Gate => ({ allowed: false, disabled: true, title });

const FIRST: InvoicedOrder = { orderId: "ord-1", orderNumber: 300, invoiceId: "inv-1" };
const SECOND: InvoicedOrder = { orderId: "ord-2", orderNumber: 301, invoiceId: "inv-2" };

const LINES_FROZEN =
  "This shipment cannot be changed — Invoice 300 is finalized; unlock it or raise a credit (see /invoicing/inv-1)";
const FREIGHT_FROZEN =
  "This shipment's freight cannot be changed — Invoice 300 is finalized; unlock it or raise a credit (see /invoicing/inv-1)";

/** What the page's own ladder closes a gate with before an invoice is asked about: voided, the
 *  reversal pair, the permission, and the credit hold without the override. */
const CLOSED_FIRST = [
  "Shipment is voided",
  "This is a reversal of Packing List 5000 — a reversal is machine-generated mirror paper; void it and re-reverse instead of editing it",
  "Requires shipping.edit",
  "ACME · Acme Heat is on credit hold — adding orders or changing lines requires the override_credit_hold action",
];

describe("shipmentLinesGate: the Lines grid, the Add order list and its button", () => {
  it("hands back the gate it was given when no order on the shipment is invoiced", () => {
    expect(shipmentLinesGate(OPEN, [])).toBe(OPEN);
  });

  it("closes an open gate with the server's change refusal, naming the invoice", () => {
    expect(shipmentLinesGate(OPEN, [FIRST])).toEqual(closed(LINES_FROZEN));
  });

  it.each(CLOSED_FIRST)("leaves a gate that is already closed alone: %s", (title) => {
    const already = closed(title);
    expect(shipmentLinesGate(already, [FIRST])).toBe(already);
  });

  it("names the first invoiced order, the one the server's refusal names", () => {
    expect(shipmentLinesGate(OPEN, [FIRST, SECOND]).title).toBe(LINES_FROZEN);
    expect(shipmentLinesGate(OPEN, [SECOND, FIRST]).title).toBe(
      "This shipment cannot be changed — Invoice 301 is finalized; unlock it or raise a credit (see /invoicing/inv-2)");
  });
});

describe("shipmentFreightGate: Bill freight and Freight amount", () => {
  it("hands back the gate it was given when no order on the shipment is invoiced", () => {
    expect(shipmentFreightGate(OPEN, [])).toBe(OPEN);
  });

  it("closes an open gate with the server's freight refusal, naming the invoice", () => {
    expect(shipmentFreightGate(OPEN, [FIRST])).toEqual(closed(FREIGHT_FROZEN));
  });

  it.each(CLOSED_FIRST)("leaves a gate that is already closed alone: %s", (title) => {
    const already = closed(title);
    expect(shipmentFreightGate(already, [FIRST])).toBe(already);
  });

  it("names the first invoiced order", () => {
    expect(shipmentFreightGate(OPEN, [SECOND, FIRST]).title).toBe(
      "This shipment's freight cannot be changed — Invoice 301 is finalized; unlock it or raise a credit (see /invoicing/inv-2)");
  });
});

describe("invoiceNotice: when the amber line shows, and which invoice it names", () => {
  const live = {
    deletedAt: null, reversesShipperId: null, reversedByShipperNumber: null,
    invoicedOrders: [FIRST, SECOND],
  };

  it("names the first invoiced order on a live shipment outside a reversal pair", () => {
    expect(invoiceNotice(live)).toBe(FIRST);
  });

  it("is null when no order on the shipment is invoiced", () => {
    expect(invoiceNotice({ ...live, invoicedOrders: [] })).toBeNull();
  });

  it("is null on a voided shipment, whose own banner says why everything is locked", () => {
    expect(invoiceNotice({ ...live, deletedAt: "2026-08-05T10:00:00.000Z" })).toBeNull();
  });

  it("is null on a reversal document, where the pair banner is up", () => {
    expect(invoiceNotice({ ...live, reversesShipperId: "shp-0" })).toBeNull();
  });

  it("is null on a reversed original, whose pair banner already leads with the invoice", () => {
    expect(invoiceNotice({ ...live, reversedByShipperNumber: 5002 })).toBeNull();
  });
});
