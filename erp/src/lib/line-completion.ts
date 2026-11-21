// erp/src/lib/line-completion.ts
// Client-safe (no src/server imports): the one statement of when an order line is finished shipping
// (owner ruling 2026-10-06, the quantity corrections design §3.1). Quantity decides; weight never
// enters. `closedShort` is `ShipperLine.lineComplete`, which since that ruling means a person closed
// a line that shipped under its ordered quantity. The ledger, the shipping list, the ticket, the
// turnaround report and the shipment Lines grid all read these functions.

export type LineShipState = { orderedQty: number; shippedQty: number; closedShort: boolean };

export function lineIsComplete(s: LineShipState): boolean {
  return s.shippedQty >= s.orderedQty || s.closedShort;
}

export type DerivedShipStatus = "OPEN" | "PARTIAL_SHIPPED" | "SHIPPED";

/** `hasLiveShipment` is separate from `shippedQty` because a live reversal leaves a line with live
 *  shipper lines and a net quantity of zero: that order is Partially shipped, not Open. */
export function deriveShipStatus(lines: (LineShipState & { hasLiveShipment: boolean })[]): DerivedShipStatus {
  if (!lines.some((l) => l.hasLiveShipment)) return "OPEN";
  return lines.every(lineIsComplete) ? "SHIPPED" : "PARTIAL_SHIPPED";
}

export type ShipRow = { sequence: number; qty: number; closedShort: boolean };

/** Was the line complete once the shipment carrying `sequence` had gone? `sequence` is
 *  `ShipperOrder.sequence`, allocated once per order in shipment order and never reused. */
export function completeAsOf(rows: ShipRow[], orderedQty: number, sequence: number): boolean {
  const upTo = rows.filter((r) => r.sequence <= sequence);
  return lineIsComplete({
    orderedQty,
    shippedQty: upTo.reduce((sum, r) => sum + r.qty, 0),
    closedShort: upTo.some((r) => r.closedShort),
  });
}

/** One order line's rows in sequence order with the running total after each: `shippedQty` is the net
 *  quantity and `closedShort` whether any row so far closed the line short, both counting this row
 *  and every row before it. Built once per line by `buildShipPrefix`; read by `shipStateBelow`. */
export type ShipPrefixEntry = { sequence: number; shippedQty: number; closedShort: boolean };

/** Sorts one line's rows by `sequence` (input order does not matter) and accumulates them, so the
 *  state below any sequence is a binary search rather than a rescan of every row. A reversal's row
 *  carries a negative quantity and simply lowers the running total. */
export function buildShipPrefix(rows: ShipRow[]): ShipPrefixEntry[] {
  let shippedQty = 0;
  let closedShort = false;
  return [...rows].sort((a, b) => a.sequence - b.sequence).map((r) => {
    shippedQty += r.qty;
    closedShort = closedShort || r.closedShort;
    return { sequence: r.sequence, shippedQty, closedShort };
  });
}

/** Net shipped quantity and close-short over the rows with `sequence` STRICTLY BELOW `sequence`:
 *  zero and false when no row is below it. The caller adds the shipment's own row itself. */
export function shipStateBelow(
  prefix: ShipPrefixEntry[], sequence: number,
): { shippedQty: number; closedShort: boolean } {
  let lo = 0;
  let hi = prefix.length; // first index whose sequence is not below `sequence`
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prefix[mid].sequence < sequence) lo = mid + 1; else hi = mid;
  }
  if (lo === 0) return { shippedQty: 0, closedShort: false };
  return { shippedQty: prefix[lo - 1].shippedQty, closedShort: prefix[lo - 1].closedShort };
}

export type DatedShipRow = ShipRow & { shipDate: Date; reversedLive: boolean };

/** The day the line became complete and stayed complete, or null. By quantity: the ship date of the
 *  row at which the running total last rose to the ordered quantity. By close short: the earliest
 *  closed-short row whose shipment is not reversed by a live reversal. The earlier of the two. */
export function lineCompletionDate(rows: DatedShipRow[], orderedQty: number): Date | null {
  const ordered = [...rows].sort((a, b) => a.shipDate.getTime() - b.shipDate.getTime() || a.sequence - b.sequence);
  let running = 0;
  let byQty: Date | null = null;
  for (const r of ordered) {
    const before = running;
    running += r.qty;
    if (before < orderedQty && running >= orderedQty) byQty = r.shipDate;
    else if (running < orderedQty) byQty = null;
  }
  let byClose: Date | null = null;
  for (const r of ordered) {
    if (r.closedShort && !r.reversedLive) { byClose = r.shipDate; break; }
  }
  if (byQty === null) return byClose;
  if (byClose === null) return byQty;
  return byQty.getTime() <= byClose.getTime() ? byQty : byClose;
}

/** Does saving this shipment row finish the line? `shippedToDateQty` already includes this
 *  shipment's own saved quantity, so that is taken back out before ship-now is added. */
export function shipmentCompletesLine(s: {
  orderedQty: number; shippedToDateQty: number; savedQty: number; shipNowQty: number;
}): boolean {
  if (!Number.isFinite(s.shipNowQty)) return false;
  return s.shippedToDateQty - s.savedQty + s.shipNowQty >= s.orderedQty;
}

/** The quantity a person has typed in a ship-now box: a blank box is not a number, so it reads
 *  as NaN and never completes anything. */
export function typedQty(text: string): number {
  return text.trim() === "" ? Number.NaN : Number(text);
}

/** Does this typed row finish its line? One statement for the grid, the create page's payload and
 *  the edit page's payload. An unknown ordered quantity reads as "no", so the close-short box
 *  stays available rather than vanishing on a row nobody can describe. */
export function rowFinishesLine(
  row: { qty: string }, orderedQty: number | undefined, shippedToDateQty: number | undefined, savedQty: number,
): boolean {
  if (orderedQty === undefined) return false;
  return shipmentCompletesLine({ orderedQty, shippedToDateQty: shippedToDateQty ?? 0, savedQty, shipNowQty: typedQty(row.qty) });
}
