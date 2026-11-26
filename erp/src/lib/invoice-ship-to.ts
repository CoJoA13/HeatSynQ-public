/**
 * Which shipment a new invoice takes its Ship-to from (#1055, owner ruling 2026-11-25).
 *
 * An invoice covers every shipment of its order. Its Ship-to is the LATEST one's address: the
 * newest live (not voided), non-reversal shipment, by ship date, then by when it was created, then
 * by id (so two shipments created in the same millisecond still pick one), that names a ship-to.
 * A shipment with no ship-to is skipped; when none names one the caller falls back to the
 * customer's default SHIP_TO row, the rule before #1055. A reversal is never a candidate: it
 * copies its original's ship-to and records goods coming back, not where they went.
 *
 * The invoice reads this at CREATE only (ruling 3): Recalculate leaves the Ship-to as it stands, so
 * a hand edit on the draft is never overwritten, and a raised invoice keeps the block it printed.
 *
 * A dependency-free leaf, the `party-address.ts` precedent: no Prisma, no permission, no service
 * import, so the rule is stated once and tested without a database.
 */

export type ShipToCandidate = {
  id: string;
  shipToAddressId: string | null;
  /** The shipment's civil ship date (a date-only column). */
  shipDate: Date;
  createdAt: Date;
  deletedAt: Date | null;
  reversesShipperId: string | null;
};

/** Positive when `a` is later than `b`: ship date, then created time, then id. */
function laterThan(a: ShipToCandidate, b: ShipToCandidate): number {
  return a.shipDate.getTime() - b.shipDate.getTime()
    || a.createdAt.getTime() - b.createdAt.getTime()
    || (a.id > b.id ? 1 : a.id < b.id ? -1 : 0);
}

/** The ship-to address id of the latest live, non-reversal shipment that names one, else null. */
export function invoiceShipToAddressId(shipments: readonly ShipToCandidate[]): string | null {
  let latest: ShipToCandidate | null = null;
  for (const s of shipments) {
    if (s.deletedAt !== null || s.reversesShipperId !== null || s.shipToAddressId === null) continue;
    if (latest === null || laterThan(s, latest) > 0) latest = s;
  }
  return latest?.shipToAddressId ?? null;
}
