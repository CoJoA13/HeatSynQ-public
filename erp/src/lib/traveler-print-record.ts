/**
 * The record of what one traveler print printed (owner ruling P3-Q1, 2026-10-08; the design
 * docs/superpowers/specs/2026-10-06-quantity-corrections-auto-complete-design.md, §10.3).
 *
 * The server builds one inside the print transaction, from the order it read under the claim, and
 * stores it as JSON text in `StoredDocument.travelerPrintRecord`. The order page reads it back
 * from the order's document list and compares it with the order as it is now, to say when printed
 * paper is out of date.
 *
 * What it holds, and nothing else: every order line's part, quantity and weight, in position
 * order, and the number, quantity and weight of each load this print covered. Weights are whole
 * cents, as integers. A line is known by its part and its place, never its row id. A load is known
 * by its number, which is what its sheet's barcode carries. Containers are left out by ruling
 * P3-Q4.
 *
 * Client-safe: its one import is a type. The page and the server both call it, so the two sides
 * cannot disagree about what a record holds.
 */
import type { TravelerSelection } from "./traveler-selection";

export type RecordLine = { partId: string; qty: number; weightCents: number };
export type RecordLoad = { loadNumber: number; qty: number | null; weightCents: number | null };
export type TravelerPrintRecord = { v: 1; lines: RecordLine[]; loads: RecordLoad[] };

/** The part of an order a record is built from. The server's `OrderDetail` and the page's both
 *  satisfy it as they are. Weights are the saved two-decimal figures, as numbers. */
export type PrintRecordOrder = {
  lines: readonly { position: number; partId: string; qty: number; weight: number }[];
  loads: readonly { loadNumber: number; qty: number | null; weight: number | null }[];
};

/** A saved weight has two decimals, so times 100 it is a whole number give or take float error
 *  (2.05 * 100 is 204.99999999999997). Rounding gives the exact cents. */
const cents = (weight: number): number => Math.round(weight * 100);

/** Every line, ascending by position. */
export function recordLines(order: PrintRecordOrder): RecordLine[] {
  return [...order.lines].sort((a, b) => a.position - b.position)
    .map((line) => ({ partId: line.partId, qty: line.qty, weightCents: cents(line.weight) }));
}

/** One load as a record holds it. A quantity or weight that was not entered stays null: it is
 *  not zero, and the paper prints an empty box for it. */
export function recordLoad(load: PrintRecordOrder["loads"][number]): RecordLoad {
  return {
    loadNumber: load.loadNumber,
    qty: load.qty,
    weightCents: load.weight === null ? null : cents(load.weight),
  };
}

/** The record of a print of `selection`: every line, and the loads the print covered, ascending
 *  by load number. An all-loads print covers every load, so an order with no loads records none.
 *  The caller has already refused a selection that names a load the order does not have. */
export function buildTravelerPrintRecord(order: PrintRecordOrder, selection: TravelerSelection): TravelerPrintRecord {
  const covered = selection.mode === "all" ? order.loads
    : order.loads.filter((load) => selection.loadNumbers.includes(load.loadNumber));
  return {
    v: 1,
    lines: recordLines(order),
    loads: [...covered].sort((a, b) => a.loadNumber - b.loadNumber).map(recordLoad),
  };
}

/** The text stored in the column and carried in the print's audit entry. */
export function serializeTravelerPrintRecord(record: TravelerPrintRecord): string {
  return JSON.stringify(record);
}

const isWhole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * Reads a stored record back. Null means "no record": the print was made before the column
 * existed, or the text is not one this code can read (not a string, not JSON, another `v`, a
 * field missing or of the wrong type). The reader then says nothing about that print. It never
 * throws. A key it does not know is ignored, and the answer holds the known keys only, so a
 * later version may add a key without breaking this reader.
 */
export function parseTravelerPrintRecord(text: unknown): TravelerPrintRecord | null {
  if (typeof text !== "string") return null;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!isObject(raw) || raw.v !== 1 || !Array.isArray(raw.lines) || !Array.isArray(raw.loads)) return null;

  const lines: RecordLine[] = [];
  for (const line of raw.lines as unknown[]) {
    if (!isObject(line) || typeof line.partId !== "string" || !isWhole(line.qty) || !isWhole(line.weightCents))
      return null;
    lines.push({ partId: line.partId, qty: line.qty, weightCents: line.weightCents });
  }

  const loads: RecordLoad[] = [];
  for (const load of raw.loads as unknown[]) {
    if (!isObject(load) || !isWhole(load.loadNumber)) return null;
    const { qty, weightCents } = load;
    if (!(qty === null || isWhole(qty)) || !(weightCents === null || isWhole(weightCents))) return null;
    loads.push({ loadNumber: load.loadNumber, qty, weightCents });
  }
  return { v: 1, lines, loads };
}
