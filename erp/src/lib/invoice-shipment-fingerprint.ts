// Client-safe (no src/server imports, no node: imports): the canonical text of the shipment-side
// inputs an invoice's lines are calculated from (owner ruling 2026-10-06). The server hashes this
// text and stores the digest on the invoice when it creates or recalculates the lines; finalize
// builds the text again from the same read and refuses when the digest differs, so a draft cannot
// be finalized over shipments that changed after it was calculated.
//
// What is in it is exactly what the pricing input reads off the shipments, and nothing else:
//   - per order line, the live shipped quantity and weight (`shippedTotals`), for lines whose net
//     is not zero. A line that nets to nothing is never priced, so it is left out here too: a
//     rider added and never shipped, or a line shipped and fully reversed, changes nothing billed.
//   - per live shipment that bills freight with an amount, that amount.
// Prices, surcharges, order charges, tax and terms are not shipment changes and are not in it.

export type ShipmentFingerprintInput = {
  /** One entry per order line: its live shipped totals. */
  lines: { orderLineId: string; qty: number; weight: number }[];
  /** One entry per live shipment that bills freight. */
  freight: { shipperId: string; amount: number }[];
};

/** Integer cents. Weights and money are Decimal(12,2), so cents are exact, and rounding here makes
 *  0.1 + 0.2 and 0.3 the same text. */
const cents = (n: number): number => Math.round(n * 100);

const byFirst = (a: [string, ...number[]], b: [string, ...number[]]): number =>
  a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;

/** Deterministic text: entries sorted by id, quantities as integers, weights and money in integer
 *  cents, zero-net lines dropped. The same inputs in any order give the same text. */
export function shipmentFingerprintSource(input: ShipmentFingerprintInput): string {
  const lines = input.lines
    .map((l): [string, number, number] => [l.orderLineId, Math.round(l.qty), cents(l.weight)])
    .filter(([, qty, weight]) => qty !== 0 || weight !== 0)
    .sort(byFirst);
  const freight = input.freight
    .map((f): [string, number] => [f.shipperId, cents(f.amount)])
    .sort(byFirst);
  return JSON.stringify({ v: 1, lines, freight });
}
