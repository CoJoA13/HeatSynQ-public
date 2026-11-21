// erp/src/lib/order-totals.ts
// Client-safe and pure. It decides every cell and every sentence of the order totals table (the
// weights design §4.2, §4.3 and §10.2), and words the weight figure of the saved order's strip of
// quantities (§4.5; owner ruling W10, 2026-10-09). The words are that design's §10.3, B1 to U1.
// Do not reword one here.
//
// It adds nothing up itself. Weights are `net-weight.ts`'s, in whole cents under that leaf's
// ceiling. Pieces are `order-reconciliation.ts`'s, in BigInt, and `BigInt()` throws on a number
// that is not whole. The numbers that leaf reads of what this file hands it are a line's `qty`,
// what `statedPieces` answers, what `impliedPieces` answers, and that leaf's own piece sums and
// count of rows, handed back to it.
// `partsPieces` is handed the lines whole, each with its `weight`, and reads `qty` alone.
//
// It reads only what it is handed, as stored numbers or as typed text.
import { formatNumber } from "./format";
import {
  impliedPieces, weighedDifferenceCents, weighedNet, weightTotals, type ImpliedLine, type WeightInput,
} from "./net-weight";
import { INT4_MAX } from "./order-constants";
import {
  STRIP_SEPARATOR, containerPieces, formatPieces, partsPieces, piecesOverOrUnder, rowsLeftOut,
} from "./order-reconciliation";

/** B1: the table's caption and its accessible name. */
export const ORDER_TOTALS_CAPTION = "Order totals";
/** B2: the column headings, in order. */
export const ORDER_TOTALS_COLUMNS = ["Pieces", "Net (lb)", "Tare (lb)", "Gross (lb)"] as const;
/** U1: the tag's words. */
export const UNSAVED_TOTALS = "Unsaved totals";
/** C1 to C3 of the design's §10.3: what a cell says where it has no figure. A shipment's totals
 *  tables say the same three, read from here (src/lib/shipment-totals.ts). */
export const NOT_ENTERED = "Not entered";
export const INCOMPLETE = "Incomplete";
export const NOT_AVAILABLE = "Not available";

const NO_WEIGHED_NET = "Weighed net not available";

/** A part line's figures. `qty` is a whole number: it goes to BigInt as it is. */
export type TotalsLine = { qty: number; weight: WeightInput };

/** A container row, as stored numbers or as typed text. */
export type TotalsContainer = {
  count: WeightInput; pieces: number | string | null; tareEach: WeightInput; scaleGross: WeightInput;
};

export type OrderTotalsInput = {
  /** Each part line's checked quantity and weight, or null while they cannot all be given. */
  lines: readonly TotalsLine[] | null;
  /** One entry for each part line: its part and that part's each weight, whether or not `lines`
   *  can be given. Implied pieces is judged by this list and by nothing in `lines` (owner ruling
   *  W6; the design's §10.7, point 3). */
  lineParts: readonly ImpliedLine[];
  containers: readonly TotalsContainer[];
};

export type OrderTotalsRow = {
  heading: "Parts" | "Containers" | "Order"; pieces: string; net: string; tare: string; gross: string;
};

/** `rows` is Parts, Containers, Order. A cell the design leaves empty is "". `note` is the
 *  sentence under the table, or null. `weighed` is the weighed lines under that: none, one or two. */
export type OrderTotalsView = {
  rows: readonly [OrderTotalsRow, OrderTotalsRow, OrderTotalsRow];
  note: string | null;
  weighed: readonly string[];
};

/** The Pieces a row states: `Number(value)` when that is a whole number from 1 to INT4_MAX, else
 *  null. Typed text is read with `Number`, as both order screens' saves read a Pieces box.
 *  `Number` reads null and blank text as 0, which the lower bound leaves out. */
export function statedPieces(value: number | string | null | undefined): number | null {
  const pieces = Number(value);
  return Number.isInteger(pieces) && pieces >= 1 && pieces <= INT4_MAX ? pieces : null;
}

/** Whole cents as a cell or a sentence shows them: grouped, two decimals, no unit. The formatter's
 *  own dash for none. `cents / 100` is not an exact division. A case of
 *  `tests/order-totals.test.ts` holds that the weight leaf's ceiling, 999,999,999,999 cents, is
 *  shown as 9,999,999,999.99. */
export function pounds(cents: number | null): string {
  return formatNumber(cents === null ? null : cents / 100, 2);
}

/** "12.50 lb over" or "12.50 lb under": a weighed net less Net, in whole cents. Never asked about
 *  zero. The table's weighed line and the strip's figure both end with it. */
function poundsOverOrUnder(differenceCents: number): string {
  return `${pounds(Math.abs(differenceCents))} lb ${differenceCents > 0 ? "over" : "under"}`;
}

/** "1 row has no Tare each" or "2 rows have no Scale gross", the count grouped. */
export function rowsWithout(rows: number, box: "Tare each" | "Scale gross"): string {
  return rows === 1 ? `1 row has no ${box}` : `${formatNumber(rows)} rows have no ${box}`;
}

/** The lines under the table once a row has a Scale gross (G1 to G8). None while no row has one,
 *  an order with no container rows included. */
function weighedLines(
  netCents: number | null, parts: bigint | null, lineParts: readonly ImpliedLine[],
  containers: readonly TotalsContainer[],
): string[] {
  const scale = weighedNet(containers);
  if (scale.rowsWithoutScaleGross === scale.containerRows) return [];
  if (scale.rowsWithoutScaleGross > 0) {
    return [[NO_WEIGHED_NET, rowsWithout(scale.rowsWithoutScaleGross, "Scale gross")].join(STRIP_SEPARATOR)];
  }
  if (scale.weighedNetCents === null) return [NO_WEIGHED_NET];
  const first = [`Weighed net ${pounds(scale.weighedNetCents)} lb`];
  const difference = weighedDifferenceCents(scale.weighedNetCents, netCents);
  if (difference !== null && difference !== 0) first.push(poundsOverOrUnder(difference));
  const said = [first.join(STRIP_SEPARATOR)];
  const implied = impliedPieces({ weighedNetCents: scale.weighedNetCents, lines: lineParts });
  if (implied !== null) {
    const second = [`Implied pieces ${formatPieces(BigInt(implied))}`];
    if (parts !== null && BigInt(implied) !== parts) second.push(piecesOverOrUnder(BigInt(implied) - parts));
    said.push(second.join(STRIP_SEPARATOR));
  }
  return said;
}

/** The table for a set of part lines and container rows: the cells of the design's §10.3, second
 *  table, the note (N1 to N3) and the weighed lines. */
export function orderTotals(input: OrderTotalsInput): OrderTotalsView {
  const { lines, lineParts, containers } = input;
  // While the lines cannot be given, one weight that cannot be read stands for them: that gives
  // no net and no gross, and keeps the tare.
  const totals = weightTotals({ lineWeights: lines === null ? [null] : lines.map((line) => line.weight), containers });
  const parts = lines === null ? null : partsPieces(lines);
  const inContainers = containerPieces(containers.map((row) => ({ pieces: statedPieces(row.pieces) })));
  const net = pounds(totals.netCents);
  const tare = totals.containerRows === 0 ? NOT_ENTERED
    : totals.rowsWithoutTare > 0 ? INCOMPLETE
    : pounds(totals.tareCents);
  const notes: string[] = [];
  if (inContainers.stated > 0 && inContainers.skipped > 0) notes.push(rowsLeftOut(inContainers.skipped));
  if (totals.rowsWithoutTare > 0) notes.push(rowsWithout(totals.rowsWithoutTare, "Tare each"));
  return {
    rows: [
      { heading: "Parts", pieces: parts === null ? formatNumber(null) : formatPieces(parts), net, tare: "", gross: "" },
      { heading: "Containers", pieces: inContainers.stated === 0 ? NOT_ENTERED : formatPieces(inContainers.pieces), net: "", tare, gross: "" },
      { heading: "Order", pieces: "", net, tare, gross: totals.grossCents === null ? NOT_AVAILABLE : pounds(totals.grossCents) },
    ],
    note: notes.length === 0 ? null : notes.join(STRIP_SEPARATOR),
    weighed: weighedLines(totals.netCents, parts, lineParts, containers),
  };
}

/** A saved order's line, as much of it as the table reads. */
export type SavedTotalsLine = { partId: string; qty: number; weight: number; part: { eachWeight: number } };

/** The table's input for a saved order: its lines, beside container rows that may be the saved
 *  rows or a grid's rows of typed text. */
export function savedOrderTotalsInput(
  lines: readonly SavedTotalsLine[], containers: readonly TotalsContainer[],
): OrderTotalsInput {
  return {
    lines: lines.map((line) => ({ qty: line.qty, weight: line.weight })),
    lineParts: lines.map((line) => ({ partId: line.partId, eachWeight: line.part.eachWeight })),
    containers,
  };
}

/** What `weighedFigure` reads of a saved order. Its fields are numbers, so a grid row of typed
 *  text does not fit it. */
export type WeighedOrder = {
  lines: readonly { weight: number }[];
  containers: readonly { count: number; tareEach: number | null; scaleGross: number | null }[];
};

/** The strip's weight figure (T1 to T3): Net against the weighed net. null unless Net, the weighed
 *  net and their difference can all be worked out: `weighedDifferenceCents` answers null when
 *  either of the first two is missing. */
export function weighedFigure(order: WeighedOrder): string | null {
  const { netCents } = weightTotals({ lineWeights: order.lines.map((line) => line.weight), containers: order.containers });
  const { weighedNetCents } = weighedNet(order.containers);
  const difference = weighedDifferenceCents(weighedNetCents, netCents);
  if (difference === null) return null;
  const said = [`Net ${pounds(netCents)} lb`, `weighed ${pounds(weighedNetCents)} lb`];
  if (difference !== 0) said.push(poundsOverOrUnder(difference));
  return said.join(STRIP_SEPARATOR);
}
