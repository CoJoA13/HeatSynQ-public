// erp/src/lib/shipment-totals.ts
// Client-safe and pure. It decides every cell and every sentence of a shipment's totals tables
// (the weights design §12.2): one table for each order on the shipment, and one for the shipment.
// The words are that design's §12.3, T1 to T16. Do not reword one here.
//
// It adds nothing up itself. The figures are `shipmentWeightTotals`'s (src/lib/net-weight.ts), in
// whole cents under that leaf's ceiling, and that function alone says when a shipment has a gross.
// The cell words, the row sentence and a figure's form are the order totals leaf's
// (src/lib/order-totals.ts), read from it and not written again.
//
// The second half builds the tables' input on each of the two shipment pages. It reads only what
// it is handed, as stored numbers or as typed text.
import { formatNumber } from "./format";
import { shipmentWeightTotals, type TareRow, type WeightInput, type WeightTotals } from "./net-weight";
import { STRIP_SEPARATOR } from "./order-reconciliation";
import { INCOMPLETE, NOT_AVAILABLE, NOT_ENTERED, ORDER_TOTALS_COLUMNS, pounds, rowsWithout } from "./order-totals";

/** T1: the caption and the accessible name of the shipment's table. */
export const SHIPMENT_TOTALS_CAPTION = "Shipment totals";
/** T4: the column headings, in order. They are the order totals table's, without Pieces. */
export const SHIPMENT_TOTALS_COLUMNS: readonly [string, string, string] =
  [ORDER_TOTALS_COLUMNS[1], ORDER_TOTALS_COLUMNS[2], ORDER_TOTALS_COLUMNS[3]];

/** T2 and T3: the caption and the accessible name of one order's table. */
export function totalsForCaption(label: string): string {
  return `Totals for ${label}`;
}

/** One order on a shipment: the words after "Totals for", its line weights and its container rows,
 *  each a stored number or typed text. `unsaved` says a grid that feeds its table has unsaved edits. */
export type ShipmentTotalsOrder = {
  label: string; lineWeights: readonly WeightInput[]; containers: readonly TareRow[]; unsaved?: boolean;
};

/** One table: its caption, its three cells, the line under it or null, and whether it is tagged. */
export type TotalsTableView = {
  caption: string; net: string; tare: string; gross: string; note: string | null; unsaved: boolean;
};

/** One table for each order, in the order handed in, and the shipment's. `shipment` is null when
 *  there is no order. */
export type ShipmentTotalsView = { orders: readonly TotalsTableView[]; shipment: TotalsTableView | null };

/** The three cells of one table, an order's or the shipment's. */
function cells(
  totals: Pick<WeightTotals, "netCents" | "tareCents" | "grossCents" | "containerRows" | "rowsWithoutTare">,
): Pick<TotalsTableView, "net" | "tare" | "gross"> {
  return {
    net: pounds(totals.netCents),
    tare: totals.containerRows === 0 ? NOT_ENTERED : totals.rowsWithoutTare > 0 ? INCOMPLETE : pounds(totals.tareCents),
    gross: totals.grossCents === null ? NOT_AVAILABLE : pounds(totals.grossCents),
  };
}

/** T12: "1 order has no containers" or "2 orders have no containers", the count grouped. */
function ordersWithout(orders: number): string {
  return orders === 1 ? "1 order has no containers" : `${formatNumber(orders)} orders have no containers`;
}

/** Every table of a shipment: the cells of the design's §12.2, and the line under each. */
export function shipmentTotals(orders: readonly ShipmentTotalsOrder[]): ShipmentTotalsView {
  const totals = shipmentWeightTotals(orders);
  const tables = orders.map((order, index): TotalsTableView => {
    const own = totals.orders[index];
    return {
      caption: totalsForCaption(order.label), ...cells(own),
      note: own.rowsWithoutTare > 0 ? rowsWithout(own.rowsWithoutTare, "Tare each") : null,
      unsaved: order.unsaved === true,
    };
  });
  if (tables.length === 0) return { orders: tables, shipment: null };
  const notes: string[] = [];
  if (totals.rowsWithoutTare > 0) notes.push(rowsWithout(totals.rowsWithoutTare, "Tare each"));
  // Said only while the shipment has a container row. With none on any order, Tare reads NOT_ENTERED.
  if (totals.containerRows > 0 && totals.ordersWithoutContainers > 0) notes.push(ordersWithout(totals.ordersWithoutContainers));
  return {
    orders: tables,
    shipment: {
      caption: SHIPMENT_TOTALS_CAPTION, ...cells(totals),
      note: notes.length === 0 ? null : notes.join(STRIP_SEPARATOR),
      unsaved: tables.some((table) => table.unsaved),
    },
  };
}

// A saved shipment. Each of its Lines and Containers grids keeps its own rows, so each hands up
// what its order's table adds up, and the page keeps those reports by the shipment order's id.

/** What a Lines grid hands up: every line weight its order's table adds up, and its unsaved flag. */
export type LinesReport = { lineWeights: readonly WeightInput[]; unsaved: boolean };
/** What a Containers grid hands up: every container row its order's table adds up, and its
 *  unsaved flag. */
export type ContainersReport = { containers: readonly TareRow[]; unsaved: boolean };
/** One grid's report. A null value takes that grid's report away. */
export type TotalsReport =
  | { part: "lines"; value: LinesReport | null }
  | { part: "containers"; value: ContainersReport | null };
/** The reports a page holds, by the shipment order's id. */
export type ShipmentReports = Readonly<Record<string, { lines?: LinesReport; containers?: ContainersReport }>>;
/** How a grid hands a report up. */
export type ReportTotals = (orderKey: string, report: TotalsReport) => void;
/** No grid has reported. */
export const NO_REPORTS: ShipmentReports = {};

/** Whether two Lines reports say the same, by content. No report on both sides is the same too. */
function sameLines(held: LinesReport | undefined, next: LinesReport | undefined): boolean {
  if (held === undefined || next === undefined) return held === next;
  return held.unsaved === next.unsaved && held.lineWeights.length === next.lineWeights.length
    && held.lineWeights.every((weight, index) => Object.is(weight, next.lineWeights[index]));
}

/** The same for two Containers reports. The length is compared first: `every` then meets no row
 *  that the other report lacks. */
function sameContainers(held: ContainersReport | undefined, next: ContainersReport | undefined): boolean {
  if (held === undefined || next === undefined) return held === next;
  return held.unsaved === next.unsaved && held.containers.length === next.containers.length
    && held.containers.every((row, index) =>
      Object.is(row.count, next.containers[index].count) && Object.is(row.tareEach, next.containers[index].tareEach));
}

/** The reports with one grid's report put in, or taken out when its value is null. An order left
 *  with no report loses its key. When the report says what is already held, by content, the
 *  answer is the object that was handed in. Otherwise it is a new object: the one handed in is
 *  never written to. */
export function withReport(reports: ShipmentReports, orderKey: string, report: TotalsReport): ShipmentReports {
  const held: { lines?: LinesReport; containers?: ContainersReport } = reports[orderKey] ?? {};
  const lines = report.part === "lines" ? report.value ?? undefined : held.lines;
  const containers = report.part === "containers" ? report.value ?? undefined : held.containers;
  if (report.part === "lines" ? sameLines(held.lines, lines) : sameContainers(held.containers, containers)) return reports;
  const next = Object.fromEntries(Object.entries(reports).filter(([key]) => key !== orderKey));
  if (lines !== undefined || containers !== undefined) {
    next[orderKey] = { ...(lines === undefined ? {} : { lines }), ...(containers === undefined ? {} : { containers }) };
  }
  return next;
}

/** What a Lines grid hands up: null until the grid has a baseline, and then its kept lines' saved
 *  weights followed by each row's weight box as typed. */
export function linesReport(
  hasBaseline: boolean, keptLines: readonly { weight: number }[], rows: readonly { weight: string }[], unsaved: boolean,
): LinesReport | null {
  if (!hasBaseline) return null;
  return { lineWeights: [...keptLines.map((line) => line.weight), ...rows.map((row) => row.weight)], unsaved };
}

/** What a Containers grid hands up: null until the grid has a baseline, and then each row's number
 *  of containers and tare each, and nothing more of the row. */
export function containersReport(hasBaseline: boolean, rows: readonly TareRow[], unsaved: boolean): ContainersReport | null {
  if (!hasBaseline) return null;
  return { containers: rows.map((row) => ({ count: row.count, tareEach: row.tareEach })), unsaved };
}

/** A saved shipment's order, as much of it as the tables read. */
export type SavedTotalsOrder = {
  id: string; label: string; lines: readonly { weight: number }[];
  containers: readonly { count: number; tareEach: number | null }[];
};

/** The tables' input on a saved shipment. For each order: what its grids reported, and the page's
 *  saved rows in place of a grid that has reported nothing. A report under a key no order has is
 *  not read. */
export function savedShipmentTotalsInput(
  orders: readonly SavedTotalsOrder[], reports: ShipmentReports,
): ShipmentTotalsOrder[] {
  return orders.map((order) => {
    const held: { lines?: LinesReport; containers?: ContainersReport } = reports[order.id] ?? {};
    return {
      label: order.label,
      lineWeights: held.lines ? held.lines.lineWeights : order.lines.map((line) => line.weight),
      containers: held.containers ? held.containers.containers : order.containers.map((row) => ({ count: row.count, tareEach: row.tareEach })),
      unsaved: (held.lines?.unsaved ?? false) || (held.containers?.unsaved ?? false),
    };
  });
}

/** A picked order of the new-shipment form, as much of it as the tables read. */
export type NewTotalsOrder = {
  orderNumber: number; lines: readonly { weight: string }[]; containers: readonly TareRow[];
};

/** The tables' input on the new-shipment form: each picked order under "#" and its number, with
 *  each line's weight box and each container row's two boxes as typed. Nothing there is saved
 *  yet, so no order is marked unsaved. */
export function newShipmentTotalsInput(selected: readonly NewTotalsOrder[]): ShipmentTotalsOrder[] {
  return selected.map((order) => ({
    label: `#${order.orderNumber}`,
    lineWeights: order.lines.map((line) => line.weight),
    containers: order.containers.map((row) => ({ count: row.count, tareEach: row.tareEach })),
  }));
}
