// The gates the saved shipment page composes (#472, design 2026-10-08 §3.2). Pure and client-safe:
// each takes the gate the page already built and the facts the payload carries, and answers the
// gate a control reads. The page (src/app/shipping/[id]/ShipmentDetail.tsx) calls these, so a
// vitest suite can prove every rung here without rendering the page. The order hub's four Save
// buttons (Containers, Serials, Charges, Loads) are handed `gridGate` too (#483, #487).
//
// Everything here is a snapshot of what the page last read. The server decides again under its own
// claims, and its refusal stays the enforcement.
import { gate, type Gate } from "./permission-ui";
import { editorAccessSentence, type EditorMode } from "./draft-recovery-words";
import { INVOICE_FREEZE, invoiceLocked, type InvoicedOrder } from "./invoice-freeze";
import type { PrintedOrders, RemoveOrderFacts } from "./shipment-remove-order";

/**
 * The Lines grid's gate, and the Add order select's and button's. `replaceShipperLines` and
 * `addOrderToShipper` refuse while any order on the shipment has a finalized invoice, naming the
 * first by order number, so the title is that refusal and names `invoicedOrders[0]`.
 *
 * The invoice rung is last. `extendGate` already carries voided, the reversal pair, the permission
 * and the credit hold without the override, and a gate closed for one of those keeps its own reason.
 */
export function shipmentLinesGate(extendGate: Gate, invoicedOrders: readonly InvoicedOrder[]): Gate {
  return invoiceLocked(extendGate, INVOICE_FREEZE.changeShipment, invoicedOrders[0]);
}

/**
 * Bill freight's gate and Freight amount's, and no other header field's. `updateShipper` refuses a
 * patch under a finalized invoice only when it carries one of those two fields, so the rest of the
 * header stays on the page's edit gate.
 */
export function shipmentFreightGate(editGate: Gate, invoicedOrders: readonly InvoicedOrder[]): Gate {
  return invoiceLocked(editGate, INVOICE_FREEZE.changeFreight, invoicedOrders[0]);
}

/**
 * The invoice the amber line under the page heading names, or null when the line is not shown.
 * Hidden on a voided shipment, whose own banner says why everything is locked, and on either side
 * of a reversal pair, where the pair banner is up (owner ruling R-Q4). On a reversed original that
 * banner already leads with the invoice sentence when the pair is invoiced. It names the same
 * invoice as the titles above.
 */
export function invoiceNotice(shipper: {
  deletedAt: string | null;
  reversesShipperId: string | null;
  reversedByShipperNumber: number | null;
  invoicedOrders: readonly InvoicedOrder[];
}): InvoicedOrder | null {
  if (shipper.deletedAt !== null) return null;
  if (shipper.reversesShipperId !== null || shipper.reversedByShipperNumber !== null) return null;
  return shipper.invoicedOrders[0] ?? null;
}

// ---- Remove order (#472, R-Q1 and R-Q2) ----

/**
 * What `removeOrderRefusal` needs to know about one order, read from what the page holds: the
 * shipment as it last read it, and the printed-paper answers it has merged. The server builds the
 * same facts under its claims (`removeOrderFromShipper`) and calls the same function, so the title
 * and the refusal cannot differ in order or in words. This is a snapshot. The server decides again.
 *
 * `survivorHasPositiveLine` mirrors the server's query: a saved line with a quantity above zero on
 * any OTHER order of the shipment, released rows included. `printed` is keyed by the order's id
 * (`orderId`), never by the shipper order's id.
 */
export function removeOrderFacts(
  shipper: {
    shipperNumber: number;
    invoicedOrders: readonly InvoicedOrder[];
    orders: readonly { id: string; orderId: string; lines: readonly { qty: number }[] }[];
  },
  printed: PrintedOrders,
  order: { id: string; orderId: string },
): RemoveOrderFacts {
  const invoiced = shipper.invoicedOrders.find((i) => i.orderId === order.orderId);
  return {
    shipperNumber: shipper.shipperNumber,
    orderCount: shipper.orders.length,
    paperPrinted: printed.paperOrderIds.includes(order.orderId),
    invoice: invoiced === undefined ? null : { invoiceId: invoiced.invoiceId, orderNumber: invoiced.orderNumber },
    survivorHasPositiveLine: shipper.orders.some((o) => o.id !== order.id && o.lines.some((l) => l.qty > 0)),
    certPrinted: printed.certOrderIds.includes(order.orderId),
  };
}

/**
 * The sentence for an order whose Lines, Containers or Serials grid holds unsaved work. It has two
 * homes on purpose. The click-time check in ShipmentDetail's `removeOrder` carries it as a literal,
 * because the archival-gate sweep and tests/shipment-order-retained-scope.test.ts pin that function
 * as written. This is the same sentence for the greyed button's title. Two suites pin the words,
 * each against a literal of its own: tests/shipment-remove-gate.test.ts this function's, and
 * tests/shipment-order-retained-scope.test.ts the page's. What holds the two equal is
 * tests/shipment-panel-messages.test.ts, which runs the page's `removeOrder` and compares what it
 * reports with this function's answer.
 */
export function removeOrderUnsavedSentence(label: string): string {
  return `Order ${label} has unsaved lines, containers or serials on this shipment. Removing ` +
    `it drops those rows, so save them first — or use Discard beside each unsaved grid's Save button.`;
}

/**
 * The Remove order gate. The page's edit gate comes first (voided, reversal pair, shipping.edit)
 * and keeps its own title. Then the server's refusal as the page last read it. Unsaved work comes
 * last: it is the one reason the operator can clear on the spot, and shown first it would send
 * them to save or discard and then into a refusal that says to void the shipment.
 */
export function removeOrderGate(editGate: Gate, refusal: string | null, gridsUnsaved: boolean, label: string): Gate {
  if (!editGate.allowed) return editGate;
  if (refusal !== null) return { allowed: false, disabled: true, title: refusal };
  if (gridsUnsaved) return { allowed: false, disabled: true, title: removeOrderUnsavedSentence(label) };
  return editGate;
}

// ---- #472, Task 4: true titles in the grids, the blank override reason, the Add order select ----

/** A grid's own title over a retained draft: the page would let this viewer edit, and the grid's
 *  draft cannot be edited until the recovery notice above the grid is answered. Under an open page
 *  gate `gridGate` gives it in every mode but editing, loading, unavailable and error. Those three
 *  hold no draft to resolve and take their notice's own first sentence instead (#483). */
export const DRAFT_RECOVERY_TITLE = "Resolve draft recovery before editing.";

/** The gate a grid's controls show, from the page gate and the grid's mode. On the order hub only
 *  each grid's Save button is handed it, over the gate its section is handed (the hub's edit gate,
 *  or the charges gate for Save charges, so a finalized invoice's sentence still comes first
 *  there); the page reasons named below are the saved shipment page's. A closed page gate keeps
 *  its own reason in every mode, and the grid words nothing over it. For four of those reasons
 *  (voided, the reversal pair, the permission, the credit hold without the override) the grid's
 *  own baseline says not editable as well (`context` in shipment-bulk-recovery.ts), which is why
 *  those four read the draft-recovery title before #472. A finalized invoice is not one of them,
 *  and nor is Save lines' blank override reason: that baseline knows nothing of either.
 *  There the grid stays in editing mode and can hold a live or a retained draft, and only the page
 *  gate closes anything: every Lines control under an invoice (design 2026-10-08 §3.2, "A draft
 *  caught by the freeze"), Save lines alone for the blank reason. The grid's own title is left for
 *  an open page gate over a grid that is not in editing mode: in loading, unavailable and error
 *  the notice's own first sentence (`editorAccessSentence`, draft-recovery-words.ts; #483), and in
 *  every other mode `DRAFT_RECOVERY_TITLE`. */
export function gridGate(pageGate: Gate, mode: EditorMode): Gate {
  if (!pageGate.allowed || mode === "editing") return pageGate;
  return { allowed: false, disabled: true, title: editorAccessSentence(mode) ?? DRAFT_RECOVERY_TITLE };
}

/** The gate a grid's inputs show while its own Save is in transport (`useBulkGrid`'s `saving`; R23,
 *  owner ruling 2026-10-22, #702): closed and untitled, since the Save button's "Saving…" says why.
 *  A closed gate keeps its own reason. Only the inputs, the add and remove controls take it, never
 *  the Save button, whose own title rule needs its gate open while it saves (waiting-titles.ts). */
export function savingGate(gate: Gate, saving: boolean): Gate {
  if (!gate.allowed || !saving) return gate;
  return { allowed: false, disabled: true, title: undefined };
}

/** The sentence the Add order button has carried since 2026-08-06. The server's refusal says "a
 *  credit hold" and the new form's ends in a full stop; the three spellings are left as they are. */
export const OVERRIDE_REASON_REQUIRED = "A reason is required to override the credit hold";

/** Closes an open gate while a required override reason is blank. Whitespace is blank. A closed
 *  gate is returned as it is, so a reason is never asked for where typing one would not help. */
export function reasonRequiredGate(g: Gate, required: boolean, reason: string): Gate {
  if (!g.allowed || !required || reason.trim() !== "") return g;
  return { allowed: false, disabled: true, title: OVERRIDE_REASON_REQUIRED };
}

/** What the page's read of the Add order candidates last did. */
export type AddableState = "loading" | "ready" | "failed";

// `gate()` always titles a closed gate; the assertion is for the type, which allows undefined.
const REQUIRES_ORDERS_VIEW: string = gate([], "orders.view").title!;

/**
 * What the Add order select shows. The first option says what the list is, in this order: the
 * permission it needs, loading, failed, nothing to add, a prompt to choose. The permission comes
 * before loading because without `orders.view` the page never starts the read, so the state stays
 * "loading" for good. A closed lines gate still wins the title; the first option tells the truth
 * about the list either way.
 */
export function addOrderSelect(input: { gate: Gate; ordersGate: Gate; state: AddableState; count: number }): {
  disabled: boolean; title: string | undefined; placeholder: string;
} {
  const { gate: linesGate, ordersGate, state, count } = input;
  const placeholder = !ordersGate.allowed ? ordersGate.title ?? REQUIRES_ORDERS_VIEW
    : state === "loading" ? "Loading orders…"
      : state === "failed" ? "Orders could not be loaded"
        : count === 0 ? "No unshipped orders for this customer"
          : "Choose an order…";
  const title = !linesGate.allowed ? linesGate.title : !ordersGate.allowed ? ordersGate.title : undefined;
  return { disabled: linesGate.disabled || !ordersGate.allowed || state !== "ready" || count === 0, title, placeholder };
}

/** An order as the Add order picker lists it, on both shipment pages: `#N`, then its PO when it has
 * one. The picker keeps the server's order, newest first (#1056 ruling 3). */
export function addOrderOptionLabel(o: { orderNumber: number; poNumber: string | null }): string {
  return `#${o.orderNumber}${o.poNumber ? ` · PO ${o.poNumber}` : ""}`;
}

/**
 * Why a grid's Add picker is empty when the reason is not "everything is on the shipment already".
 * `context` is the grid's accepted baseline context (`shipment-bulk-recovery.ts`): it names the
 * shipment order and says whether the order's catalog was read, which needs `orders.view`. With no
 * baseline the text follows the grid's mode: in loading, unavailable and error it is the recovery
 * notice's own first sentence (`editorAccessSentence`, draft-recovery-words.ts; #483), and in the
 * other modes, which the draft store reports with a baseline whenever it reaches them, nothing.
 * With a baseline the mode changes nothing, and an order no longer on the shipment gives no
 * reason. Where this gives none, the view keeps its own sentence.
 */
export function pickerEmptyReason(context: { readonly [key: string]: unknown } | undefined, mode: EditorMode): string | undefined {
  if (context === undefined) return editorAccessSentence(mode);
  if (context.order == null || context.catalogAuthorized === true) return undefined;
  return REQUIRES_ORDERS_VIEW;
}

/**
 * The text beside an Add picker that offers nothing, when the view was handed no reason (#698,
 * G8-4): an order with no rows of that kind says so and where to add them, since a shipment row
 * must name an order row; otherwise the old sentence, word for word (ship-partial-then-complete
 * pins it). The permission and access sentences (`pickerEmptyReason`) stay ahead of both.
 */
export function pickerEmptySentence(noun: "line" | "container" | "serial", orderHasNone: boolean): string {
  if (!orderHasNone) return `Every order ${noun} is on this shipment`;
  if (noun === "container") return "This order has no container rows. Add them on the order's Containers grid first.";
  if (noun === "serial") return "This order has no serials. Add them on the order's Serials grid first.";
  return "This order has no lines. Add them on the order first.";
}
