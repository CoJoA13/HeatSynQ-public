// Client-safe leaf (no src/server imports): the edit page's Lines grid decisions that vitest cannot
// reach inside a component, the `break-drafts.ts` precedent. Three things live here:
//  - what a save SENDS (the close-short flag is only meaningful on a row that ships short);
//  - where the grid's two completion figures come from (this shipment's saved quantity and "shipped
//    to date"), always read out of ONE baseline;
//  - the baseline a successful save settles to, whose rows and ledger both come from the save's own
//    answer. Rows from the answer beside a ledger from before the save made the two disagree until
//    the next catalog read: ordered 10, saved 4, raised to 10 and saved read 4 - 10 + 10 = 4, so a
//    finished line offered the close-short box, and the reverse example stripped a legitimate tick.
import type { BulkBaseline } from "./bulk-grid-recovery";
import type { LineFields, ShippedInfo, LineInfo } from "../app/shipping/ShipmentGrids";
import type { ShipperOrder } from "../app/shipping/[id]/ShipmentDetail";
import { rowFinishesLine } from "./line-completion";
import { decimalRefusal } from "./decimal-entry";
import { SHIP_NOW_NET_WEIGHT } from "./shipment-boxes";
import { shipmentLineFields, lineLedgerContext } from "./shipment-bulk-recovery";

export type LinePayloadRow = { orderLineId: string; qty: number; weight: string; lineComplete: boolean };

/** The wire rows for a lines save, or every refusal, one per line of `error`: rows in the order
 *  given, and within a row the quantity before the weight. The weight is read through the one rule
 *  (`decimalRefusal`) and named panel-locally by its row and its label (owner answer 1); a blank
 *  weight is refused with the rule's sentence (owner answer 2). `lineComplete` goes out false on a
 *  row that finishes its line: the server derives completion from quantity there. */
export function shipmentLinesPayload(
  rows: readonly LineFields[],
  infoByLineId: ReadonlyMap<string, Pick<LineInfo, "orderedQty">>,
  shippedByLineId: ReadonlyMap<string, Pick<ShippedInfo, "qty">>,
  savedQtyByLineId: ReadonlyMap<string, number>,
): { ok: true; payload: LinePayloadRow[] } | { ok: false; error: string } {
  const payload: LinePayloadRow[] = [];
  const refusals: string[] = [];
  for (const [i, row] of rows.entries()) {
    const label = `Line ${i + 1}`;
    const qty = Number(row.qty);
    const qtyRefused = !Number.isInteger(qty) || qty < 0;
    if (qtyRefused) refusals.push(`${label}: ship-now quantity must be a whole number of at least 0.`);
    const weightRefusal = decimalRefusal(`${label}, ${SHIP_NOW_NET_WEIGHT.label}`, row.weight, SHIP_NOW_NET_WEIGHT.box, { required: true });
    if (weightRefusal !== null) refusals.push(weightRefusal);
    if (qtyRefused || weightRefusal !== null) continue;
    const weight = row.weight.trim();
    const completes = rowFinishesLine(row, infoByLineId.get(row.orderLineId)?.orderedQty,
      shippedByLineId.get(row.orderLineId)?.qty, savedQtyByLineId.get(row.orderLineId) ?? 0);
    payload.push({ orderLineId: row.orderLineId, qty, weight, lineComplete: row.lineComplete === "true" && !completes });
  }
  return refusals.length > 0 ? { ok: false, error: refusals.join("\n") } : { ok: true, payload };
}

/** "Shipped to date" and THIS shipment's saved quantity per order line, both from one baseline. */
export function lineLedgerFromBaseline(baseline: BulkBaseline<LineFields> | undefined): {
  shippedByLineId: Map<string, ShippedInfo>; savedQtyByLineId: Map<string, number>;
} {
  const shipped = (baseline?.context.shipped ?? []) as ShipperOrder["orderLineShippedToDate"];
  const shippedByLineId = new Map<string, ShippedInfo>();
  for (const s of shipped) shippedByLineId.set(s.orderLineId, { qty: s.shippedToDateQty, weight: s.shippedToDateWeight });
  const savedQtyByLineId = new Map<string, number>();
  for (const r of baseline?.rows ?? []) savedQtyByLineId.set(r.fields.orderLineId, Number(r.fields.qty));
  return { shippedByLineId, savedQtyByLineId };
}

/** The baseline after a persisted lines save: the submitted one with its rows AND its ordered/shipped
 *  ledger replaced by the answer's, so the two stay one snapshot. */
export function settledLinesBaseline(
  submitted: BulkBaseline<LineFields>,
  savedOrder: Pick<ShipperOrder, "lines" | "orderLineShippedToDate"> | undefined,
): BulkBaseline<LineFields> {
  return {
    ...submitted,
    rows: (savedOrder?.lines ?? []).filter(l => l.orderLineId !== null).map(l => ({ id: l.id, fields: shipmentLineFields(l) })),
    context: savedOrder ? { ...submitted.context, ...lineLedgerContext(savedOrder) } : submitted.context,
  };
}
