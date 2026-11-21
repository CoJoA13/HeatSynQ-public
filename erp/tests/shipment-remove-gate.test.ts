// #472 (R-Q1, R-Q2): Remove order is greyed up front. `removeOrderRefusal`, the leaf the server's
// own check also calls, decides from facts. This file proves the page builds those facts from what
// it holds, and that the gate puts the page's edit gate first and unsaved work last.
// Pure: no database, no renderer.
import { describe, expect, it } from "vitest";
import type { InvoicedOrder } from "@/lib/invoice-freeze";
import type { Gate } from "@/lib/permission-ui";
import { removeOrderFacts, removeOrderGate, removeOrderUnsavedSentence } from "@/lib/shipment-gates";
import { NOTHING_PRINTED, removeOrderRefusal, type PrintedOrders } from "@/lib/shipment-remove-order";

const OPEN: Gate = { allowed: true, disabled: false, title: undefined };
const VOIDED: Gate = { allowed: false, disabled: true, title: "Shipment is voided" };

const A = { id: "so-a", orderId: "order-a" };
const B = { id: "so-b", orderId: "order-b" };
type Shipment = Parameters<typeof removeOrderFacts>[0];
/** Packing List 5001 carrying order A (2 pieces) and order B (3 pieces), nothing invoiced. */
function shipment(over: Partial<Shipment> = {}): Shipment {
  return { shipperNumber: 5001, invoicedOrders: [],
    orders: [{ ...A, lines: [{ qty: 2 }] }, { ...B, lines: [{ qty: 3 }] }], ...over };
}
const refusalFor = (s: Shipment, printed: PrintedOrders, order: typeof A) =>
  removeOrderRefusal(removeOrderFacts(s, printed, order));

// The server's sentences for Packing List 5001, as src/server/shippers.ts words them.
const ONLY_ORDER = "This is the only order on the shipment — void the shipment (Packing List 5001) instead of removing its last order.";
const PAPER = "Shipment paper covering this order has already printed (Packing List 5001) — void the shipment instead of removing it.";
const NO_SURVIVOR = "A shipment needs at least one line with a positive quantity";
const CERT = "This order's shipment certification has already printed (Packing List 5001) — void the shipment instead of removing it.";

describe("removeOrderFacts: what the page knows about one order", () => {
  it("a two-order shipment with nothing printed or invoiced refuses nothing", () => {
    expect(removeOrderFacts(shipment(), NOTHING_PRINTED, A)).toEqual({
      shipperNumber: 5001, orderCount: 2, paperPrinted: false, invoice: null,
      survivorHasPositiveLine: true, certPrinted: false,
    });
    expect(refusalFor(shipment(), NOTHING_PRINTED, A)).toBeNull();
  });

  it("counts the orders on the shipment, so its only order is told to void instead", () => {
    const alone = shipment({ orders: [{ ...A, lines: [{ qty: 2 }] }] });
    expect(removeOrderFacts(alone, NOTHING_PRINTED, A).orderCount).toBe(1);
    expect(refusalFor(alone, NOTHING_PRINTED, A)).toBe(ONLY_ORDER);
  });

  it("reads printed paper by the order's id, never by the shipper order's", () => {
    const paper: PrintedOrders = { paperOrderIds: ["order-a"], certOrderIds: [] };
    expect(removeOrderFacts(shipment(), paper, A)).toMatchObject({ paperPrinted: true, certPrinted: false });
    expect(removeOrderFacts(shipment(), paper, B).paperPrinted).toBe(false);
    expect(removeOrderFacts(shipment(), { paperOrderIds: ["so-a"], certOrderIds: [] }, A).paperPrinted).toBe(false);
    expect(refusalFor(shipment(), paper, A)).toBe(PAPER);
    expect(refusalFor(shipment(), paper, B)).toBeNull();
  });

  it("reads a printed certification from its own list, by the order's id", () => {
    const cert: PrintedOrders = { paperOrderIds: [], certOrderIds: ["order-a"] };
    expect(removeOrderFacts(shipment(), cert, A)).toMatchObject({ paperPrinted: false, certPrinted: true });
    expect(removeOrderFacts(shipment(), cert, B).certPrinted).toBe(false);
    expect(removeOrderFacts(shipment(), { paperOrderIds: [], certOrderIds: ["so-a"] }, A).certPrinted).toBe(false);
    expect(refusalFor(shipment(), cert, A)).toBe(CERT);
  });

  it("names this order's own invoice and no other order's", () => {
    const invoiced: InvoicedOrder = { orderId: "order-b", orderNumber: 1032, invoiceId: "inv-b" };
    const s = shipment({ invoicedOrders: [invoiced] });
    expect(removeOrderFacts(s, NOTHING_PRINTED, A).invoice).toBeNull();
    expect(removeOrderFacts(s, NOTHING_PRINTED, B).invoice).toEqual({ invoiceId: "inv-b", orderNumber: 1032 });
    expect(refusalFor(s, NOTHING_PRINTED, A)).toBeNull();
    expect(refusalFor(s, NOTHING_PRINTED, B)).toBe(
      "This order cannot be removed from the shipment — Invoice 1032 is finalized; unlock it or raise a credit (see /invoicing/inv-b)");
  });

  it("needs a positive saved line on ANOTHER order: the order's own lines do not count", () => {
    const bEmpty = shipment({ orders: [{ ...A, lines: [{ qty: 2 }] }, { ...B, lines: [] }] });
    expect(removeOrderFacts(bEmpty, NOTHING_PRINTED, A).survivorHasPositiveLine).toBe(false);
    expect(removeOrderFacts(bEmpty, NOTHING_PRINTED, B).survivorHasPositiveLine).toBe(true);
    expect(refusalFor(bEmpty, NOTHING_PRINTED, A)).toBe(NO_SURVIVOR);
    expect(refusalFor(bEmpty, NOTHING_PRINTED, B)).toBeNull();
  });

  it("counts a quantity above zero only, as the server's query does", () => {
    const bZero = shipment({ orders: [{ ...A, lines: [{ qty: 2 }] }, { ...B, lines: [{ qty: 0 }, { qty: -4 }] }] });
    expect(removeOrderFacts(bZero, NOTHING_PRINTED, A).survivorHasPositiveLine).toBe(false);
  });

  it("counts a released row, and any other order of several", () => {
    // A released row has lost its order-side link. The server's query does not look at the link.
    const released: { qty: number; orderLineId: string | null }[] = [{ qty: 4, orderLineId: null }];
    const bReleased = shipment({ orders: [{ ...A, lines: [{ qty: 2 }] }, { ...B, lines: released }] });
    expect(removeOrderFacts(bReleased, NOTHING_PRINTED, A).survivorHasPositiveLine).toBe(true);
    const three = shipment({ orders: [{ ...A, lines: [] }, { ...B, lines: [{ qty: 3 }] },
      { id: "so-c", orderId: "order-c", lines: [{ qty: 0 }] }] });
    expect(removeOrderFacts(three, NOTHING_PRINTED, A).survivorHasPositiveLine).toBe(true);
    expect(removeOrderFacts(three, NOTHING_PRINTED, B).survivorHasPositiveLine).toBe(false);
  });
});

describe("removeOrderUnsavedSentence", () => {
  it("is the sentence the click-time check raises, which shipment-order-retained-scope.test.ts pins for 101", () => {
    expect(removeOrderUnsavedSentence("101")).toBe(
      "Order 101 has unsaved lines, containers or serials on this shipment. Removing it drops those rows, so save them first — or use Discard beside each unsaved grid's Save button.");
  });
});

describe("removeOrderGate: the page's edit gate, then the server's refusal, then unsaved work", () => {
  it("hands back a closed edit gate untouched, whatever else is true", () => {
    expect(removeOrderGate(VOIDED, PAPER, true, "101-1")).toBe(VOIDED);
  });

  it("closes with the server's refusal as the title", () => {
    expect(removeOrderGate(OPEN, PAPER, false, "101-1")).toEqual({ allowed: false, disabled: true, title: PAPER });
  });

  it("puts the server's refusal above unsaved work", () => {
    // Shown first, the unsaved sentence would send the operator to save or discard and then into
    // a refusal that tells them to void the shipment.
    expect(removeOrderGate(OPEN, PAPER, true, "101-1").title).toBe(PAPER);
  });

  it("closes with the unsaved sentence, naming the order, when that is all that stands in the way", () => {
    expect(removeOrderGate(OPEN, null, true, "101-1")).toEqual({
      allowed: false, disabled: true, title: removeOrderUnsavedSentence("101-1"),
    });
  });

  it("is the edit gate itself when nothing refuses", () => {
    expect(removeOrderGate(OPEN, null, false, "101-1")).toBe(OPEN);
  });

  it("composes with the facts: the only order reads the void sentence even with unsaved grids", () => {
    const alone = shipment({ orders: [{ ...A, lines: [{ qty: 2 }] }] });
    expect(removeOrderGate(OPEN, refusalFor(alone, NOTHING_PRINTED, A), true, "101-1").title).toBe(ONLY_ORDER);
  });
});
