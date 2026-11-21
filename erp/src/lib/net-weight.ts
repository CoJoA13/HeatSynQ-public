// Client-safe and pure: the one statement of net weight = quantity × each weight (the quantity
// corrections design §4 and §8; owner ruling 2026-10-07, one exact rounding rule everywhere).
// `computeLineWeight` (order entry and the order hub's add-rider default) returns this figure, and
// the two offer functions below decide when a screen offers it over a weight a person entered.
//
// The leaf also states a container row's tare total (tare each × containers), and net, tare and
// gross for a set of line weights and container rows (the weights design §9.4; owner ruling W1 of
// 2026-10-09: no container rows, no gross). Net there is the line weights added up as they are
// stored or typed, not quantity × each weight worked out again. Beside those it states the weighed
// net (the rows' scale gross added up, less their tare totals), its difference from a net, and
// implied pieces, a weighed net divided by one part's each weight (the design's §10.2; owner
// rulings W5 and W6). It adds up no pieces: the piece sums of the order totals table and of the
// saved order's strip of quantities are `order-reconciliation.ts`'s.
// For a shipment of several orders it states net, tare and gross once more, from each order's own
// (`shipmentWeightTotals`; the design's §12.2; owner answers 1 to 3 of 2026-10-10): a shipment has
// a gross only when every order on it has one.
//
// The arithmetic is on integers. An each weight has four decimals, so a product can sit exactly on a
// half cent, and the float product can land a hair under it: 1.005 * 1 * 100 is 100.49999999999999,
// which rounds down to 1.00 where the figure is 1.01. Counting ten-thousandths of a pound keeps the
// half exact. Every other weight is turned into whole cents before it is multiplied or added.
//
// No BigInt: the tsconfig target (ES2017) refuses its literals, and none is needed. Every product
// and every sum of whole cents this leaf works out is at most MAX_CENTS in size, or it is null.
// That is not said of turning a weight into cents, which has no ceiling of its own, nor of
// `calculate`'s product, which is in ten-thousandths and is held to the ceiling once it is cents,
// nor of `impliedPieces`, which works in ten-thousandths and answers pieces.
// For a tare total and for the sums, the check against that ceiling is exact. A product or a sum
// of whole numbers that is truly at or under the ceiling is far below 2^53, so a plain number
// holds it exactly. One that is truly over it may be held inexactly, but it can never round down
// to the ceiling, because the ceiling plus one cent is itself a whole number a plain number holds
// exactly. `calculate` says the same of its own product. So a product or a sum past the ceiling is
// null, never an inexact figure.
import { formatNumber } from "./format";
import { readFinishedDecimal, type DecimalBox } from "./decimal-entry";

/** A value as the server serialises it (number) or as a person typed it (string). */
export type WeightInput = number | string | null | undefined;

// A string must be a COMPLETE decimal. A partly typed value is "not a number", never zero.
const QUANTITY = /^\d{1,10}$/;
const EACH_WEIGHT: DecimalBox = { intDigits: 6, scale: 4, min: "nonnegative" }; // Part.eachWeight is Decimal(10,4)
const WEIGHT: DecimalBox = { intDigits: 10, scale: 2 }; // a line weight is Decimal(12,2), decimalField(12, 2)
/** The largest Decimal(12,2), in cents: 9,999,999,999.99 lb. */
const MAX_CENTS = 999_999_999_999;

/** A finite number, or the number a complete decimal string spells. Text ending at its point
 *  (`42.`) is still being typed, and is none (the weights design's point 4). */
function readNumber(value: WeightInput, read: RegExp | DecimalBox): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (read instanceof RegExp) return read.test(text) ? Number(text) : null;
  return readFinishedDecimal(text, read);
}

/** A whole number of pieces, zero or more. */
function wholeQuantity(value: WeightInput): number | null {
  const quantity = readNumber(value, QUANTITY);
  return quantity !== null && Number.isInteger(quantity) && quantity >= 0 ? quantity : null;
}

/** An each weight above zero, in ten-thousandths of a pound. */
function eachWeightTenThousandths(value: WeightInput): number | null {
  const eachWeight = readNumber(value, EACH_WEIGHT);
  if (eachWeight === null) return null;
  const tenThousandths = Math.round(eachWeight * 1e4);
  return tenThousandths > 0 ? tenThousandths : null;
}

/** A weight in whole cents. `Math.round`, never a bare `* 100`: 4.35 * 100 is 434.99999999999994. */
function weightCents(value: WeightInput): number | null {
  const weight = readNumber(value, WEIGHT);
  return weight === null ? null : Math.round(weight * 100);
}

type Calculated = { quantity: number; eachWeight: number; cents: number };

function calculate(quantity: WeightInput, eachWeight: WeightInput): Calculated | null {
  const pieces = wholeQuantity(quantity);
  const each = eachWeightTenThousandths(eachWeight);
  if (pieces === null || each === null) return null;
  // Half up: 50 ten-thousandths is half a cent. A product past 2^53 loses precision only far above
  // the ceiling, so the worst an inexact multiply can do is return null.
  const cents = Math.floor((each * pieces + 50) / 100);
  if (cents > MAX_CENTS) return null;
  return { quantity: pieces, eachWeight: each / 1e4, cents };
}

/** quantity × each weight in whole cents of a pound, rounded half up. null when it cannot be
 *  calculated: quantity not a whole number >= 0, each weight missing or not > 0 or with more than
 *  four decimals (as text), or a result past Decimal(12,2) (999_999_999_999 cents). */
export function netWeightCents(quantity: WeightInput, eachWeight: WeightInput): number | null {
  return calculate(quantity, eachWeight)?.cents ?? null;
}

/** The same figure in pounds, at most two decimals. */
export function calculatedNetWeight(quantity: WeightInput, eachWeight: WeightInput): number | null {
  const cents = netWeightCents(quantity, eachWeight);
  return cents === null ? null : cents / 100;
}

export type WeightOffer = {
  readonly quantity: number;
  readonly eachWeight: number;
  readonly pounds: number;
  /** The shipped-to-date weight this figure falls below, when the order line cannot take it. */
  readonly belowShipped: number | null;
};

/** Order hub. null = offer nothing: not calculable, not > 0 (an order line weight must be > 0),
 *  or equal to the stored weight to the cent. A missing or unreadable stored weight is offered to. */
export function lineWeightOffer(input: {
  quantity: WeightInput; eachWeight: WeightInput; storedWeight: WeightInput; shippedWeight?: WeightInput;
}): WeightOffer | null {
  const calculated = calculate(input.quantity, input.eachWeight);
  if (calculated === null || !(calculated.cents > 0)) return null;
  if (weightCents(input.storedWeight) === calculated.cents) return null;
  // Strictly below, as the server refuses it: a weight equal to what has shipped is allowed.
  const shipped = weightCents(input.shippedWeight);
  return {
    quantity: calculated.quantity, eachWeight: calculated.eachWeight, pounds: calculated.cents / 100,
    belowShipped: shipped !== null && calculated.cents < shipped ? shipped / 100 : null,
  };
}

/** Shipment Lines grid. null unless the typed ship-now quantity is a whole number >= 0 that differs
 *  from `startQty`, the figure is calculable, and it differs from the typed weight to the cent
 *  (an unreadable typed weight differs). `belowShipped` is always null here. */
export function shipNowWeightOffer(input: {
  shipNowQty: string; startQty: number | null | undefined; eachWeight: WeightInput; typedWeight: string;
}): WeightOffer | null {
  // The quantity is read the way the grid reads it, not through QUANTITY. Its save takes Number(text)
  // (shipment-line-save.ts), so "8.0" offers as 8 does. A blank box is not a number, as the grid's
  // completion reader has it (typedQty, line-completion.ts); the save would send a blank as 0, and
  // a blank offers nothing all the same. `calculate` then refuses what is not a whole number >= 0,
  // a reversal row's "-10" included.
  if (input.shipNowQty.trim() === "") return null;
  const shipNow = Number(input.shipNowQty);
  if (input.startQty === null || input.startQty === undefined || shipNow === input.startQty) return null;
  const calculated = calculate(shipNow, input.eachWeight);
  if (calculated === null) return null;
  if (weightCents(input.typedWeight) === calculated.cents) return null;
  return {
    quantity: calculated.quantity, eachWeight: calculated.eachWeight, pounds: calculated.cents / 100,
    belowShipped: null,
  };
}

/** "32 × 1.5000 lb = 48.00 lb" */
export function weightOfferSum(offer: WeightOffer): string {
  return `${formatNumber(offer.quantity)} × ${formatNumber(offer.eachWeight, 4)} lb = ${formatNumber(offer.pounds, 2)} lb`;
}

/** "Use 48.00 lb" */
export function weightOfferUse(offer: WeightOffer): string {
  return `Use ${formatNumber(offer.pounds, 2)} lb`;
}

/** "Below the 95.00 lb already shipped", or null when the figure is not below shipped. */
export function weightOfferBlocked(offer: WeightOffer): string | null {
  return offer.belowShipped === null ? null : `Below the ${formatNumber(offer.belowShipped, 2)} lb already shipped`;
}

// Tare, and net, tare and gross (the weights design §9.4). Add beside these and do not change
// them: the weighed figures below read a row's scale gross through this same row shape, and the
// design's later pull requests count on these names, this input shape and the ceiling staying as
// they are.

/** A container row as the calculation reads it: how many containers, and the weight of one empty
 *  container. An order's container row, a shipment's container row and a row of typed text all fit
 *  as they are. Nothing else a row carries is read. */
export type TareRow = { count: WeightInput; tareEach: WeightInput };

/** A tare each in whole cents. A typed 0 counts as entered. null when there is none: a missing
 *  value, a blank or partly typed string, text with more than two decimals or more than ten
 *  integer digits, a figure below zero, or one past Decimal(12,2). A number is rounded to the cent
 *  first, as `weightCents` rounds it, and is judged as that many cents. Never negative zero. */
export function tareEachCents(value: WeightInput): number | null {
  const cents = weightCents(value);
  if (cents === null || cents < 0 || cents > MAX_CENTS) return null;
  // `weightCents` gives -0 for "-0", and -0 < 0 is false. The traveler would print it as "-0".
  return cents === 0 ? 0 : cents;
}

/** How many containers a row holds: a whole number of at least 1. */
function containerCount(value: WeightInput): number | null {
  const count = wholeQuantity(value);
  return count !== null && count >= 1 ? count : null;
}

/** One row's tare total in whole cents: tare each × containers. null when the row has no tare
 *  each, when its count is not a whole number of at least 1, or when the product is past
 *  Decimal(12,2). */
export function tareTotalCents(row: TareRow): number | null {
  const each = tareEachCents(row.tareEach);
  const count = containerCount(row.count);
  if (each === null || count === null) return null;
  const cents = each * count;
  return cents > MAX_CENTS ? null : cents;
}

/** The same figure in pounds, at most two decimals. */
export function tareTotal(row: TareRow): number | null {
  const cents = tareTotalCents(row);
  return cents === null ? null : cents / 100;
}

/**
 * Net, tare and gross in whole cents. Why there is no tare is read from the two counts:
 * `containerRows === 0` is none entered; `rowsWithoutTare > 0` is incomplete; neither, with
 * `tareCents` null, is a tare total that cannot be worked out (a row has a tare each and a count
 * that cannot be read yet, or a figure is past the ceiling).
 */
export type WeightTotals = {
  /** The line weights added up. 0 for no lines. null when a weight cannot be read, and when the
   *  running sum passes the ceiling. */
  netCents: number | null;
  /** The rows' tare totals added up. null with no rows, when any row has no tare total, and when
   *  the running sum passes the ceiling. */
  tareCents: number | null;
  /** Net + tare. null unless both are there, so no container rows means no gross. null too when
   *  the two together pass the ceiling. */
  grossCents: number | null;
  /** How many container rows were handed in. */
  containerRows: number;
  /** How many of them have no tare each. A row with a tare each and no readable count is not one. */
  rowsWithoutTare: number;
};

/** Whole cents added up. null when a figure is missing, never a partial sum, and null as soon as
 *  the running sum's size passes the ceiling: a later figure does not bring it back. */
function sumCents(values: readonly (number | null)[]): number | null {
  let sum = 0;
  for (const cents of values) {
    if (cents === null) return null;
    sum += cents;
    if (Math.abs(sum) > MAX_CENTS) return null;
  }
  return sum;
}

/** Net, tare and gross for a set of line weights and container rows. Net is the line weights added
 *  up, and a weight may be negative, as a reversal's is. Tare is the rows' tare totals added up.
 *  Gross is net + tare. */
export function weightTotals(input: {
  lineWeights: readonly WeightInput[]; containers: readonly TareRow[];
}): WeightTotals {
  const netCents = sumCents(input.lineWeights.map((weight) => weightCents(weight)));
  const containerRows = input.containers.length;
  const rowsWithoutTare = input.containers.filter((row) => tareEachCents(row.tareEach) === null).length;
  // No container rows, no tare, and so no gross (owner ruling W1, 2026-10-09). An empty sum is 0,
  // and a tare of 0 here would give a gross equal to net.
  const tareCents = containerRows === 0 ? null : sumCents(input.containers.map((row) => tareTotalCents(row)));
  const grossCents = sumCents([netCents, tareCents]);
  return { netCents, tareCents, grossCents, containerRows, rowsWithoutTare };
}

// A shipment of several orders (the weights design §12.2; owner answers 1 to 3 of 2026-10-10).
// Added beside `weightTotals`, whose result gains no field.

/** One order's part of a shipment, as `weightTotals` reads it. */
export type ShipmentOrderWeights = { lineWeights: readonly WeightInput[]; containers: readonly TareRow[] };

/** Net, tare and gross for a shipment in whole cents, with each order's own. */
export type ShipmentWeightTotals = {
  /** `weightTotals` of each order, in the order handed in. */
  orders: readonly WeightTotals[];
  /** The orders' nets added up. 0 for no orders. null when an order's net is null, and when the
   *  running sum passes the ceiling. */
  netCents: number | null;
  /** The tare of the orders that have container rows, added up. null when no order has a row,
   *  when one of those tares is null, and when the running sum passes the ceiling. */
  tareCents: number | null;
  /** Net + tare, only when every order has a gross of its own. null unless both are there: with
   *  a gross on every order, the shipment's own net or tare is still null when the orders' nets or
   *  tares, added up, pass the ceiling. null too when the two together pass the ceiling. */
  grossCents: number | null;
  /** Every order's container rows, counted together. */
  containerRows: number;
  /** Every order's rows with no tare each, counted together. */
  rowsWithoutTare: number;
  /** How many orders have no container row. */
  ordersWithoutContainers: number;
};

/** Net, tare and gross for a shipment of several orders: the one statement of that rule. Each
 *  order is `weightTotals` of its own lines and rows, so an order with no line has a net of 0
 *  (owner answer 3). The shipment has a gross only when every order on it has one (answer 1), and
 *  its tare is still the listed rows' (answer 2). With no order there is no row, so no tare and
 *  no gross. */
export function shipmentWeightTotals(orders: readonly ShipmentOrderWeights[]): ShipmentWeightTotals {
  const each = orders.map((order) => weightTotals(order));
  const withRows = each.filter((order) => order.containerRows > 0);
  const netCents = sumCents(each.map((order) => order.netCents));
  // An order with no container row has no tare of its own. Left in the sum it would make the
  // shipment's tare null.
  const tareCents = withRows.length === 0 ? null : sumCents(withRows.map((order) => order.tareCents));
  const grossCents = each.every((order) => order.grossCents !== null) ? sumCents([netCents, tareCents]) : null;
  return {
    orders: each, netCents, tareCents, grossCents,
    containerRows: each.reduce((rows, order) => rows + order.containerRows, 0),
    rowsWithoutTare: each.reduce((rows, order) => rows + order.rowsWithoutTare, 0),
    ordersWithoutContainers: each.length - withRows.length,
  };
}

// Weighed net, its difference from a net, and implied pieces (the weights design §10.2). Added
// beside `weightTotals`, whose result gains no field.

/** A container row as the weighed figures read it: a `TareRow`, and the weight of the row's
 *  containers on a scale. An order's container row and a grid row of typed text fit as they are. */
export type WeighedRow = TareRow & { scaleGross: WeightInput };

/** A scale gross in whole cents. It is read exactly as `tareEachCents` reads a tare each: a typed 0
 *  counts as entered, what is no tare each is no scale gross (null), and the answer is never
 *  negative zero. */
export function scaleGrossCents(value: WeightInput): number | null {
  return tareEachCents(value);
}

/**
 * The weighed net in whole cents. When there is none, the counts say why, read in this order:
 * `containerRows === 0` is no container rows; `rowsWithoutScaleGross === containerRows` is no row
 * weighed; `rowsWithoutScaleGross > 0` is partly weighed; `rowsWithoutTare > 0` is weighed with
 * tare incomplete; otherwise a tare total or a sum cannot be worked out (a row's count cannot be
 * read yet, or a figure is past the ceiling).
 */
export type WeighedNet = {
  /** The rows' scale gross added up, less their tare totals added up. null with no rows, when any
   *  row has no scale gross or no tare total, and when either sum passes the ceiling. It may be
   *  below zero. Never negative zero. */
  weighedNetCents: number | null;
  /** How many container rows were handed in. */
  containerRows: number;
  /** How many of them have no scale gross. */
  rowsWithoutScaleGross: number;
  /** How many of them have no tare each, counted as `weightTotals` counts them. */
  rowsWithoutTare: number;
};

/** The weighed net for a set of container rows. */
export function weighedNet(containers: readonly WeighedRow[]): WeighedNet {
  const containerRows = containers.length;
  const scaleGross = containers.map((row) => scaleGrossCents(row.scaleGross));
  const rowsWithoutScaleGross = scaleGross.filter((cents) => cents === null).length;
  const rowsWithoutTare = containers.filter((row) => tareEachCents(row.tareEach) === null).length;
  const grossCents = sumCents(scaleGross);
  const tareCents = sumCents(containers.map((row) => tareTotalCents(row)));
  // No container rows, no weighed net. An empty list has no row without a scale gross or a tare
  // total, and both of its sums are 0: without the first test it would have a weighed net of 0.
  const weighedNetCents =
    containerRows === 0 || grossCents === null || tareCents === null ? null : grossCents - tareCents;
  return { weighedNetCents, containerRows, rowsWithoutScaleGross, rowsWithoutTare };
}

/** Weighed net less net, in whole cents: above zero the scale reads over the net, below zero under
 *  it (owner rulings W5 and W10). null when either is missing, and when the difference's size is
 *  past Decimal(12,2). Never negative zero. */
export function weighedDifferenceCents(weighedNetCents: number | null, netCents: number | null): number | null {
  if (weighedNetCents === null || netCents === null) return null;
  const cents = weighedNetCents - netCents;
  if (Math.abs(cents) > MAX_CENTS) return null;
  // -0 less 0 is -0, and it is answered as 0.
  return cents === 0 ? 0 : cents;
}

/** A part line as implied pieces reads it: the part it names, and that part's each weight. */
export type ImpliedLine = { partId: string | null | undefined; eachWeight: WeightInput };

/** Implied pieces: a weighed net divided by the one part's each weight, to the nearest whole piece,
 *  an exact half up (owner ruling W6). A weighed net of 0 gives 0. null when there is no weighed
 *  net or it is below zero, when there are no lines, when a line names no part or the lines name
 *  more than one, and when the first line's each weight is missing, not above zero, or text that
 *  is not an each weight (more than four decimals, for one). */
export function impliedPieces(input: { weighedNetCents: number | null; lines: readonly ImpliedLine[] }): number | null {
  const { weighedNetCents, lines } = input;
  if (weighedNetCents === null || weighedNetCents < 0 || lines.length === 0) return null;
  const partId = lines[0].partId;
  if (!partId || lines.some((line) => line.partId !== partId)) return null;
  const each = eachWeightTenThousandths(lines[0].eachWeight);
  if (each === null) return null;
  // Whole cents × 100 are ten-thousandths of a pound, as the each weight is. Twice the weight plus
  // one each weight, over twice the each weight, floors to the nearest whole piece with an exact
  // half taken up. For a weighed net up to the ceiling at an each weight a part can hold
  // (Decimal(10,4)), the numerator is a whole number far below 2^53, so a plain number holds it.
  return Math.floor((2 * weighedNetCents * 100 + each) / (2 * each));
}
