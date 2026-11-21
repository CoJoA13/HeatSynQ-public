// erp/src/lib/invoice-freeze.ts
// Client-safe: its one import is a type. The finalized-invoice refusal, stated once (#472, the
// 2026-10-08 design §3.1). Every such refusal is `invoiceFreezeSentence` below, given one
// `INVOICE_FREEZE` clause. The server reaches it two ways. The throw sites in
// src/server/shippers.ts and src/server/order-edit.ts go through `invoiceBlockMessage`
// (src/server/invoice-guards.ts), for every clause but `removeOrder`. That one is built by
// `removeOrderRefusal` (src/lib/shipment-remove-order.ts), which calls `invoiceFreezeSentence`
// itself and whose answer `removeOrderFromShipper` throws. The pages build a greyed control's title
// with the same function, so a title and the refusal it predicts are the same sentence from the
// same clause. There is one ruled exception, on the order hub (owner, 2026-10-08, the design's
// §11 point 3). The hub hands its whole Lines section one gate, built from `changeLine`
// (src/lib/order-invoice-gates.ts), so the Add rider strip is titled "A line cannot be changed",
// where the server answers an added rider with the `addLine` clause. A rider's Remove carries the
// same title, and since #486 (owner, 2026-10-15) that is the server's own refusal of a removal.
// `addLine` and `voidOrder` are refusals only; no page builds a title from either.
import type { Gate } from "./permission-ui";

/** The invoice a refusal names. An invoice has no number of its own: it is known by its order's
 *  number, and `invoiceId` is what its page link needs. */
export type InvoiceRef = { invoiceId: string; orderNumber: number };

/** One finalized invoice on one order of a shipment, as the shipment detail carries it. It is an
 *  `InvoiceRef` plus the order it freezes. */
export type InvoicedOrder = { orderId: string; orderNumber: number; invoiceId: string };

/** The leading clause of every refusal a finalized invoice raises. The first four are the
 *  shipment's, the last four the order's. The order's four are thrown from
 *  src/server/order-edit.ts, `changeLine` at two sites (`updateLine` and `removeLine`, #486). Of
 *  the shipment's, `voidShipment`, `changeShipment` and `changeFreight` are thrown from
 *  src/server/shippers.ts through `invoiceBlockMessage`. `removeOrder` is thrown there too, as
 *  `removeOrderRefusal` (src/lib/shipment-remove-order.ts) builds it. */
export const INVOICE_FREEZE = {
  voidShipment: "This shipment cannot be voided",
  changeShipment: "This shipment cannot be changed",
  changeFreight: "This shipment's freight cannot be changed",
  removeOrder: "This order cannot be removed from the shipment",
  addLine: "A line cannot be added",
  changeLine: "A line cannot be changed",
  changeCharges: "Charges cannot be changed",
  voidOrder: "This order cannot be voided",
} as const;

export type InvoiceFreezeAction = (typeof INVOICE_FREEZE)[keyof typeof INVOICE_FREEZE];

/** The whole sentence: the clause, the invoice, and the way out with the page that offers it. */
export function invoiceFreezeSentence(action: string, inv: InvoiceRef): string {
  return `${action} — Invoice ${inv.orderNumber} is finalized; unlock it or raise a credit ` +
    `(see /invoicing/${inv.invoiceId})`;
}

/** The invoice rung of a gate ladder. It closes an open gate with the sentence and leaves a closed
 *  gate alone, so a voided shipment, a reversal pair or a missing permission keeps its own reason. */
export function invoiceLocked(g: Gate, action: InvoiceFreezeAction, inv: InvoiceRef | null | undefined): Gate {
  if (!g.allowed || inv === null || inv === undefined) return g;
  return { allowed: false, disabled: true, title: invoiceFreezeSentence(action, inv) };
}
