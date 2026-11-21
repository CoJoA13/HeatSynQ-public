// erp/src/lib/shipment-remove-order.ts
// Client-safe: it imports only the invoice-freeze leaf. Why Remove order is refused, stated once
// (#472, owner ruling R-Q2 of 2026-10-08, the design's §3.3). `removeOrderFromShipper`
// (src/server/shippers.ts) reads its facts under its claims and calls `removeOrderRefusal`; the
// shipment page builds the same facts from what it last read and calls it too. The button's title
// and the server's refusal are then one function: same order, same words.
import { INVOICE_FREEZE, invoiceFreezeSentence, type InvoiceRef } from "./invoice-freeze";

/** The orders of one shipment that printed paper pins to it: `paperOrderIds` by a ticket or a
 *  bill of lading, `certOrderIds` by a print of the order's certification for this shipment. */
export type PrintedOrders = { paperOrderIds: string[]; certOrderIds: string[] };

/** An empty list no holder can change. `Object.freeze` types its result read-only; the cast keeps
 *  the list a plain `string[]`, as `PrintedOrders` declares it. */
const frozenIds = (): string[] => Object.freeze<string[]>([]) as string[];

/** Nothing printed: where a page starts. It is one object shared by every importer, so it is
 *  frozen at run time, both lists as well: a push or an assignment is refused and cannot reach
 *  the next reader. Its type stays the mutable `PrintedOrders` that every consumer takes. */
export const NOTHING_PRINTED: PrintedOrders = Object.freeze({
  paperOrderIds: frozenIds(), certOrderIds: frozenIds(),
});

function grow(seen: string[], arrived: readonly string[]): string[] {
  const out = [...seen];
  for (const id of arrived) if (!out.includes(id)) out.push(id);
  return out.length === seen.length ? seen : out;
}

/** What the page knows after one more answer: everything it knew, plus what arrived. It never
 *  drops an id, because the facts only grow: a stored document is never deleted, its coverage is
 *  never rewritten, and an order that paper covers cannot leave the shipment. So an answer that
 *  arrives late and knows less cannot make Remove order clickable again. It returns `seen` itself
 *  when nothing was added, so a React state setter given the result does not render again. */
export function mergePrinted(seen: PrintedOrders, arrived: PrintedOrders): PrintedOrders {
  const paperOrderIds = grow(seen.paperOrderIds, arrived.paperOrderIds);
  const certOrderIds = grow(seen.certOrderIds, arrived.certOrderIds);
  if (paperOrderIds === seen.paperOrderIds && certOrderIds === seen.certOrderIds) return seen;
  return { paperOrderIds, certOrderIds };
}

/** One stored document that may pin an order to its shipment, reduced to what the rule reads. A
 *  ticket or a bill of lading has `certOrderId: null`; its `orderId` is the one order a per-order
 *  ticket is for, or null for whole-shipment paper, whose `coveredOrderIds` then say which orders
 *  it printed. A certification print has `orderId: null`, `coveredOrderIds: []` and its
 *  certification's order in `certOrderId`. */
export type PinningDocument = {
  orderId: string | null; coveredOrderIds: readonly string[]; certOrderId: string | null;
};

/** Which of `orderIds` each kind of paper pins, in the order `orderIds` gives them. Whole-shipment
 *  paper pins only the orders its recorded coverage names (#140): an order added after that print
 *  is not on the paper. */
export function printedOrdersFrom(
  docs: readonly PinningDocument[], orderIds: readonly string[],
): PrintedOrders {
  const onPaper = (id: string) => docs.some((d) => d.certOrderId === null
    && (d.orderId === id || (d.orderId === null && d.coveredOrderIds.includes(id))));
  const onCert = (id: string) => docs.some((d) => d.certOrderId === id);
  return { paperOrderIds: orderIds.filter(onPaper), certOrderIds: orderIds.filter(onCert) };
}

/** Everything the rule reads about one order on one shipment. `invoice` is that order's finalized
 *  invoice, not any invoice on the shipment. `survivorHasPositiveLine` is whether another order on
 *  the shipment has a saved line with a quantity above zero. */
export type RemoveOrderFacts = {
  shipperNumber: number; orderCount: number; paperPrinted: boolean; invoice: InvoiceRef | null;
  survivorHasPositiveLine: boolean; certPrinted: boolean;
};

/** The refusal, or null when the order may be removed. First match wins, and the order is the
 *  server's own: it is what `removeOrderFromShipper` has always checked, in this sequence. */
export function removeOrderRefusal(facts: RemoveOrderFacts): string | null {
  // A shipment with no orders is a document about nothing. Voiding it keeps every sequence claimed.
  if (facts.orderCount === 1) {
    return `This is the only order on the shipment — void the shipment (Packing List ${facts.shipperNumber}) ` +
      "instead of removing its last order.";
  }
  // Removal frees the order's sequence on this shipment, and printed paper already carries it.
  if (facts.paperPrinted) {
    return `Shipment paper covering this order has already printed (Packing List ${facts.shipperNumber}) — ` +
      "void the shipment instead of removing it.";
  }
  // Removal takes away shipped quantity that a finalized invoice has billed.
  if (facts.invoice !== null) return invoiceFreezeSentence(INVOICE_FREEZE.removeOrder, facts.invoice);
  if (!facts.survivorHasPositiveLine) return "A shipment needs at least one line with a positive quantity";
  // The certification's paper carries the same sequence as a ticket would.
  if (facts.certPrinted) {
    return `This order's shipment certification has already printed (Packing List ${facts.shipperNumber}) — ` +
      "void the shipment instead of removing it.";
  }
  return null;
}
