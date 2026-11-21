// The order hub's two invoice gates (#472, owner ruling R-Q5 of 2026-10-08). Client-safe and pure.
//
// Under a finalized invoice the server refuses four of the saves behind the hub's edit gate with
// the invoice's sentence: a line change (`updateLine`), a removed line (`removeLine`, since #486),
// an added line (`addLine`) and a charges save (`replaceCharges`). No other save behind that gate
// asks about the invoice (`finalizedInvoiceFor` has no other caller among them). So the hub closes
// its Lines and Charges sections up front, each with the sentence its own save would be refused
// with, and leaves every other section on the edit gate. The server refuses one more thing on the
// hub under an invoice, Void order (`voidOrder`). That has a gate of its own: see the last
// paragraph.
//
// One gate serves the whole Lines section. The Add rider strip therefore reads "A line cannot be
// changed", where the server would say "A line cannot be added" to an added rider. Wording per
// control would need a second gate inside the section. A rider's Remove reads the same sentence,
// and the server refuses a removal with it (owner ruling 2026-10-15, #486).
//
// Void order is not gated here. With money applied to the invoice the server names that first,
// and no payload tells the page, so an invoice title there could point at an unlock that is itself
// refused.
import { INVOICE_FREEZE, invoiceLocked } from "./invoice-freeze";
import type { Gate } from "./permission-ui";

/**
 * The gates the hub hands its Lines and Charges sections.
 *
 * `finalizedInvoiceId` is what the hub last read from `GET /api/orders/[id]`: the id of the
 * order's finalized invoice, or null. With null both gates are `editGate` itself. With an id each
 * is `editGate` with the invoice rung after it. The rung closes an open gate and leaves a closed
 * one alone, so a voided order and a missing permission keep their own reason.
 *
 * `orderNumber` is the order's own number. An invoice has no number of its own: the server's
 * sentence names it by its order's number, and on the hub that is this order.
 */
export function orderInvoiceGates(
  editGate: Gate, orderNumber: number, finalizedInvoiceId: string | null,
): { linesGate: Gate; chargesGate: Gate } {
  const invoice = finalizedInvoiceId === null ? null : { invoiceId: finalizedInvoiceId, orderNumber };
  return {
    linesGate: invoiceLocked(editGate, INVOICE_FREEZE.changeLine, invoice),
    chargesGate: invoiceLocked(editGate, INVOICE_FREEZE.changeCharges, invoice),
  };
}
