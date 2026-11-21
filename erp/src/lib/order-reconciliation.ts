// erp/src/lib/order-reconciliation.ts
// Client-safe and pure: its one import is the screen formatter. The order hub's strip of
// quantities (the quantity corrections design §5 and §10.2): Parts, Container pieces, Loads and
// Serials for a saved order, each as the sentence the screen shows, and whether it disagrees with
// Parts. The sentences are that design's §10.5, S1 to S9, except the container figure's, which are
// the weights design's §9.5, S2 to S5 (owner ruling W7, 2026-10-09). Do not reword one here.
//
// It reads only what it is handed. The design hands `reconcileOrder` the order payload the server
// last sent, never a grid's unsaved rows. It informs only: no save, print or status may read it.
//
// `containerPieces`, `partsPieces`, `formatPieces`, `piecesOverOrUnder` and `rowsLeftOut` are
// exported for `order-totals.ts`, which decides the order totals table and may be handed rows as
// they are typed (the weights design §10.2). Pieces only: this file words no weight. The design's
// weight figure for the strip (§4.5) is worded there, by `weighedFigure`.
//
// Every number it is handed must be whole: `BigInt()` throws on any other. The order payload's
// are: a line's qty, a container row's Pieces and a load's qty are INTEGER columns the server
// validates. A container row's Pieces is the total in all of that row's containers, so nothing
// here multiplies it by the row's `count`, and this file does not read a container row's `count`.
// Sums are BigInt: exact at any size, so no ceiling is stated for one.
// (`BigInt(0)`, not a `0n` literal: tsconfig targets ES2017, which refuses the literal while the
// BigInt global is available.)
import { formatNumber } from "./format";

/** The part of an order the strip reads. The page's `OrderDetail` satisfies it as it is. */
export type ReconciliationOrder = {
  lines: readonly { id: string; position: number; qty: number }[];
  containers: readonly { pieces: number | null }[];
  loads: readonly { qty: number | null }[];
  serials: readonly { lineId: string }[];
};

export type StripSection = "lines" | "containers" | "loads" | "serials";

export type StripFigure = {
  key: "parts" | "containers" | "loads" | "serials";
  /** The whole sentence for this figure, as the strip shows it. */
  text: string;
  /** True when the figure is entered and disagrees. Never true for Parts. */
  differs: boolean;
  /** The section this figure links to, or null when it is plain text. */
  section: StripSection | null;
};

/** `figures` always has four entries, in the order Parts, Container pieces, Loads, Serials. */
export type Reconciliation = { figures: StripFigure[]; agrees: boolean };

/** Goes between two figures, and between the parts of one figure. */
export const STRIP_SEPARATOR = " · ";

const ZERO = BigInt(0);

/** Pieces by the parts: every line's qty added up, the lead and the riders. No lines add up to 0. */
export function partsPieces(lines: readonly { qty: number }[]): bigint {
  return lines.reduce((sum, line) => sum + BigInt(line.qty), ZERO);
}

/**
 * Pieces in the containers: each row's Pieces, added over the rows that state one. A row's Pieces
 * is the total in all of that row's containers (the weights design, decision 5), so it is never
 * multiplied by the row's `count`, and the input type does not carry `count`. `stated` counts the
 * rows that state Pieces and `skipped` the rest.
 */
export function containerPieces(
  containers: ReconciliationOrder["containers"],
): { pieces: bigint; stated: number; skipped: number } {
  let pieces = ZERO;
  let stated = 0;
  let skipped = 0;
  for (const row of containers) {
    if (row.pieces === null) {
      skipped += 1;
      continue;
    }
    pieces += BigInt(row.pieces);
    stated += 1;
  }
  return { pieces, stated, skipped };
}

type Summed = { pieces: bigint; stated: number; skipped: number };

/** Pieces in the loads: qty added over the loads that state one. A weight-only load is left out. */
function loadPieces(loads: ReconciliationOrder["loads"]): Summed {
  let pieces = ZERO;
  let stated = 0;
  let skipped = 0;
  for (const load of loads) {
    if (load.qty === null) {
      skipped += 1;
      continue;
    }
    pieces += BigInt(load.qty);
    stated += 1;
  }
  return { pieces, stated, skipped };
}

/** A whole count as the screen shows it: grouped, no decimals. The shared screen formatter
 *  wherever a plain number holds the value exactly, as `LoadAllocationSummary` does it. Past that,
 *  the BigInt's own en-US grouping. */
export function formatPieces(value: bigint): string {
  return Number.isSafeInteger(Number(value)) ? formatNumber(String(value)) : value.toLocaleString("en-US");
}

/** "2 over" or "108 under": a figure minus what it is held against. Never asked about zero. */
export function piecesOverOrUnder(difference: bigint): string {
  return difference > ZERO ? `${formatPieces(difference)} over` : `${formatPieces(-difference)} under`;
}

/** "1 row has no Pieces" or "2 rows have no Pieces": the rows `containerPieces` left out. */
export function rowsLeftOut(rows: number): string {
  return rows === 1 ? "1 row has no Pieces" : `${formatPieces(BigInt(rows))} rows have no Pieces`;
}

function loadsLeftOut(loads: number): string {
  return loads === 1 ? "1 load has no Qty" : `${formatPieces(BigInt(loads))} loads have no Qty`;
}

/**
 * Container pieces or Loads against Parts. Nothing stated reads "not entered" and is no mismatch.
 * A sum that agrees says no more, whatever was left out of it. A sum that differs says by how
 * much, and then how many rows were left out of it.
 */
function summedFigure(
  key: "containers" | "loads",
  label: string,
  parts: bigint,
  sum: Summed,
  leftOut: (count: number) => string,
): StripFigure {
  if (sum.stated === 0) return { key, text: `${label} not entered`, differs: false, section: null };
  if (sum.pieces === parts) return { key, text: `${label} ${formatPieces(sum.pieces)}`, differs: false, section: null };
  const said = [`${label} ${formatPieces(sum.pieces)}`, piecesOverOrUnder(sum.pieces - parts)];
  if (sum.skipped > 0) said.push(leftOut(sum.skipped));
  return { key, text: said.join(STRIP_SEPARATOR), differs: true, section: key };
}

/** A line as the Serials section names it. */
function lineName(position: number): string {
  return position === 1 ? "Lead" : `Line ${position}`;
}

/**
 * Serials, judged line by line and never as one total. Each line that has at least one serial has
 * its count held against its own qty, in position order. A line with none is not judged, a part
 * that requires serials included: the Serials section's own badge says that. The question is asked
 * of the lines, so a serial row whose line is not on the order is never counted.
 */
function serialsFigure(order: ReconciliationOrder): StripFigure {
  const counts = new Map<string, number>();
  for (const serial of order.serials) counts.set(serial.lineId, (counts.get(serial.lineId) ?? 0) + 1);
  const judged = [...order.lines]
    .sort((a, b) => a.position - b.position)
    .map((line) => ({ line, count: counts.get(line.id) ?? 0 }))
    .filter((entry) => entry.count > 0);
  if (judged.length === 0) return { key: "serials", text: "Serials not entered", differs: false, section: null };
  const wrong = judged.filter((entry) => entry.count !== entry.line.qty);
  if (wrong.length === 0) {
    const total = judged.reduce((sum, entry) => sum + BigInt(entry.count), ZERO);
    return { key: "serials", text: `Serials ${formatPieces(total)}`, differs: false, section: null };
  }
  const said = wrong.map(({ line, count }) => {
    const held = `${lineName(line.position)}: ${formatPieces(BigInt(count))} of ${formatPieces(BigInt(line.qty))}`;
    return [held, piecesOverOrUnder(BigInt(count) - BigInt(line.qty))].join(STRIP_SEPARATOR);
  });
  return { key: "serials", text: `Serials ${said.join(STRIP_SEPARATOR)}`, differs: true, section: "serials" };
}

/**
 * The strip's four figures for a saved order. Parts is every line's qty, the lead and the riders,
 * and is what the other three are held against. Parts links to Lines when another figure
 * disagrees, because the figure that disagrees may be the right one.
 */
export function reconcileOrder(order: ReconciliationOrder): Reconciliation {
  const parts = partsPieces(order.lines);
  const containers = summedFigure("containers", "Container pieces", parts, containerPieces(order.containers), rowsLeftOut);
  const loads = summedFigure("loads", "Loads", parts, loadPieces(order.loads), loadsLeftOut);
  const serials = serialsFigure(order);
  const agrees = !containers.differs && !loads.differs && !serials.differs;
  const partsFigure: StripFigure = {
    key: "parts",
    text: `Parts ${formatPieces(parts)} pcs`,
    differs: false,
    section: agrees ? null : "lines",
  };
  return { figures: [partsFigure, containers, loads, serials], agrees };
}
