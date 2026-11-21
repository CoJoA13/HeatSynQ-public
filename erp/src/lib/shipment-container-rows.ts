// Client-safe and pure: the rules a shipment's container row follows on both shipment screens
// (the weights design §12.2). The new-shipment form and the saved shipment draw one grid view
// (src/app/shipping/ShipmentGrids.tsx) and keep their rows in different places, so what a row is,
// what it takes when it is added, what its boxes send and how it is named are stated here once.
// vitest has no component renderer, so both screens call these functions and show or send what
// they return (tests/shipment-container-rows.test.ts).
//
// A row's fields are `orderContainerId`, `count` and `tareEach`, each text, in that order: a draft
// recovery notice names its lines from them in that order.
//
// A Tare each box is filled once, when its row is added, from the order's row
// (`prefillContainerRow`). After that the shipment owns the figure. A save sends every box as it
// stands: its trimmed text, or null for an empty box. The key is never left out: for a row sent
// with no key the server keeps the figure the shipment holds, so a cleared box would stay stored.
import type { BulkBaseline } from "./bulk-grid-recovery";
import type { ContainerFields, ContainerRow } from "../app/shipping/ShipmentGrids";
import type { ShipperOrder } from "../app/shipping/[id]/ShipmentDetail";
import { tareEachText } from "./container-tare-prefill";
import { decimalRefusal } from "./decimal-entry";
import { SHIPMENT_TARE_EACH } from "./shipment-boxes";

/** A stored shipment container row as the grid's three fields. A stored figure is spelled as
 *  `tareEachText` spells it ("42.5", "310", "0", "" for none), and the grid compares its texts
 *  exactly, so a box that holds that spelling reads as saved. */
export function shipmentContainerFields(c: { orderContainerId: string | null; count: number; tareEach: number | null }): ContainerFields {
  return { orderContainerId: c.orderContainerId ?? "", count: String(c.count), tareEach: tareEachText(c.tareEach) };
}

/** The row an order's container row gives when it is added to a shipment: the order row's whole
 *  number of containers and its tare each, or an empty box when the order's row has none. Add and
 *  Add all remaining on both screens and Add order on the new-shipment form all call this. */
export function prefillContainerRow(c: { id: string; count: number; tareEach?: number | null }): ContainerFields {
  return { orderContainerId: c.id, count: String(c.count), tareEach: tareEachText(c.tareEach ?? null) };
}

/** What a Tare each box sends: its trimmed text, or null when it is empty. */
export function tareEachForSave(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

/** A kept row: its order-side row was corrected away, so it names no order container. */
export function isKeptContainer(row: Pick<ContainerFields, "orderContainerId">): boolean {
  return row.orderContainerId === "";
}

/** Stored rows in the order the grid lists them: the kept rows, whose `orderContainerId` is null,
 *  then the others, each kind in the order given. */
export function keptFirst<T extends { orderContainerId: string | null }>(containers: readonly T[]): T[] {
  return [...containers.filter((c) => c.orderContainerId === null), ...containers.filter((c) => c.orderContainerId !== null)];
}

/** How each row is named in a refusal and in a box's spoken name. Each kind is numbered apart, so
 *  the first row that is not kept is "Container 1" wherever it is drawn. */
export function containerLabels(rows: readonly Pick<ContainerFields, "orderContainerId">[]): string[] {
  let kept = 0;
  let others = 0;
  return rows.map((row) => (isKeptContainer(row) ? `Kept container ${++kept}` : `Container ${++others}`));
}

/** The body of Save containers on a saved shipment. */
export type ShipmentContainersBody = {
  containers: { orderContainerId: string; count: number; tareEach: string | null }[];
  kept: { id: string; tareEach: string | null }[];
};

/** The body of Save containers, or every refusal, one per line of `error`: rows in the order drawn,
 *  and within a row the number of containers (not typed on a kept row, so not checked there) before
 *  the tare each. A tare each is read through the one rule (`decimalRefusal`) and named by the row's
 *  label and the box's (owner answer 1). A kept row sends its tare each alone, by the shipment row's
 *  own id, which is the row's key. */
export function shipmentContainersPayload(rows: readonly ContainerRow[]):
  { ok: true; payload: ShipmentContainersBody } | { ok: false; error: string } {
  const labels = containerLabels(rows);
  const payload: ShipmentContainersBody = { containers: [], kept: [] };
  const refusals: string[] = [];
  for (const [i, row] of rows.entries()) {
    const label = labels[i];
    const kept = isKeptContainer(row);
    const count = Number(row.count);
    const countRefused = !kept && (!Number.isInteger(count) || count < 1);
    if (countRefused) refusals.push(`${label}: containers must be a whole number of at least 1.`);
    const tareRefusal = decimalRefusal(`${label}, ${SHIPMENT_TARE_EACH.label}`, row.tareEach, SHIPMENT_TARE_EACH.box);
    if (tareRefusal !== null) refusals.push(tareRefusal);
    if (countRefused || tareRefusal !== null) continue;
    if (kept) payload.kept.push({ id: row.key, tareEach: tareEachForSave(row.tareEach) });
    else payload.containers.push({ orderContainerId: row.orderContainerId, count, tareEach: tareEachForSave(row.tareEach) });
  }
  return refusals.length > 0 ? { ok: false, error: refusals.join("\n") } : { ok: true, payload };
}

/** The baseline a save settles to: the submitted one with the answer's rows, kept rows first. */
export function settledContainersBaseline(
  submitted: BulkBaseline<ContainerFields>, savedOrder: Pick<ShipperOrder, "containers"> | undefined,
): BulkBaseline<ContainerFields> {
  return { ...submitted, rows: keptFirst(savedOrder?.containers ?? []).map((row) => ({ id: row.id, fields: shipmentContainerFields(row) })) };
}
