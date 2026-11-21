import { prisma } from "../db";
import { HttpError } from "../errors";
import { parseDateOnly, formatDateOnly } from "../../lib/business-days";
import { lineCompletionDate } from "@/lib/line-completion";

// -------------------------------------------------------------------------------------------
// Phase 8A Task 3 (spec §4.2 / §12): the Turnaround report — average order-to-ship days.
// `buildTurnaround` is the PURE core (the `bucketAging`/`buildBacklog`/`buildShipped` shape — no
// Prisma, no I/O), and `reportTurnaround` is the thin Prisma-reading wrapper. A report is a pure
// READ: no row claim, no audit, no Serializable (main spec §12, reports/README.md).
//
// The measure, pinned (the hard part — the completion date is DERIVED; there is NO stored
// order-completion timestamp; do NOT reconstruct it from the audit log):
//   • Completion date = FULL-SHIP (owner default, §12), NOT first-ship. Each order line's date comes
//     from `lineCompletionDate` (line-completion.ts), which MIRRORS ship-ledger.ts's rule: the ship
//     date on which the line's running shipped quantity reached its ordered quantity, or the earliest
//     close short. The order's completion date is the MAX of those per-line dates.
//   • Population — only orders CURRENTLY `status === "SHIPPED"` and `deletedAt: null` (open/partial
//     work lives in Backlog; INVOICED is done-and-billed, not "just completed"). The range filter is
//     on the DERIVED completion date, so it is applied in memory after the derivation, not in SQL.
//   • REOPENED-then-re-completed — a reversal is a live negative-quantity shipment, so the running
//     quantity falls below ordered and the re-ship is the date that stands. A close short on a
//     shipment reversed by a LIVE reversal does not count.
//   • Measure — `completionDate − receivedDate` in whole days; the report shows the average (with
//     count, min, max). Both dates are `@db.Date` (UTC-midnight) — an exact whole-day difference.
//   • Group by customer · part · completion-month. The per-order measure is attributed to EACH
//     distinct part on the order for the "by part" slice.
// -------------------------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

export type TurnaroundGroupBy = "none" | "customer" | "part" | "month";
const GROUP_BYS: readonly TurnaroundGroupBy[] = ["none", "customer", "part", "month"];

/** One completed order — the pure-core input. `completionDate` is already DERIVED (the wrapper does
 *  the shipment math); the core only measures `completionDate − receivedDate`. `parts` is the set of
 *  distinct parts on the order, used for the "by part" slice. */
export type CompletedOrder = {
  orderId: string;
  orderNumber: number;
  customerId: string;
  customerCode: string;
  customerName: string;
  receivedDate: string; // yyyy-mm-dd
  completionDate: string; // yyyy-mm-dd (derived: the latest of the lines' `lineCompletionDate`s)
  parts: { partId: string; partNumber: string; partName: string }[];
};

/** One detail row — a single completed order and its turnaround. */
export type TurnaroundDetailRow = {
  orderId: string;
  orderNumber: number;
  customerCode: string;
  customerName: string;
  receivedDate: string;
  completionDate: string;
  turnaroundDays: number;
};

/** An aggregate over the base grain — one row per customer / part / completion-month. `orderCount`
 *  is DISTINCT orders in the group; `avgDays`/`minDays`/`maxDays` summarize their turnaround. */
export type TurnaroundGroupRow = {
  key: string;
  label: string;
  orderCount: number;
  avgDays: number;
  minDays: number;
  maxDays: number;
};

export type TurnaroundResult =
  | { groupBy: "none"; rows: TurnaroundDetailRow[]; orderCount: number; avgDays: number }
  | { groupBy: "customer" | "part" | "month"; rows: TurnaroundGroupRow[]; orderCount: number; avgDays: number };

/** Whole days between two UTC-midnight date-only strings — an exact DAY_MS multiple; `Math.round`
 *  guards any float noise. */
function turnaroundDays(receivedDate: string, completionDate: string): number {
  return Math.round((parseDateOnly(completionDate).getTime() - parseDateOnly(receivedDate).getTime()) / DAY_MS);
}

/** Round an average to one decimal place — a single, deterministic display precision (the raw
 *  inputs are integer days, so the only fraction is the division). */
function roundAvg(sum: number, count: number): number {
  return count === 0 ? 0 : Math.round((sum / count) * 10) / 10;
}

/** The (key, label) each order contributes to for a grouping dimension. customer/month map an order
 *  to exactly ONE group; part maps it to one group per DISTINCT part it carries. */
function dimensionKeys(o: CompletedOrder, groupBy: "customer" | "part" | "month"): { key: string; label: string }[] {
  if (groupBy === "customer") return [{ key: o.customerId, label: `${o.customerCode} · ${o.customerName}` }];
  if (groupBy === "month") { const m = o.completionDate.slice(0, 7); return [{ key: m, label: m }]; }
  return o.parts.map((p) => ({ key: p.partId, label: p.partName ? `${p.partNumber} · ${p.partName}` : p.partNumber }));
}

/**
 * PURE. Shapes the completed orders into the requested view.
 *   • `none` → one detail row per order, sorted by completion date then order number, each carrying
 *     its turnaround days; plus the overall average and order count.
 *   • `customer`/`part`/`month` → aggregate rows: distinct order count, average / min / max
 *     turnaround, sorted by label. A part appearing on two lines of one order counts that order
 *     ONCE (per-order dedupe of the dimension keys).
 * The overall `orderCount`/`avgDays` are always over the DISTINCT orders in the population (never
 * derivable by weighting the part-slice rows, which double-count an order across its parts).
 */
export function buildTurnaround(orders: CompletedOrder[], opts: { groupBy: TurnaroundGroupBy }): TurnaroundResult {
  const overallSum = orders.reduce((s, o) => s + turnaroundDays(o.receivedDate, o.completionDate), 0);
  const orderCount = orders.length;
  const avgDays = roundAvg(overallSum, orderCount);

  if (opts.groupBy === "none") {
    const rows: TurnaroundDetailRow[] = orders
      .map((o) => ({
        orderId: o.orderId, orderNumber: o.orderNumber,
        customerCode: o.customerCode, customerName: o.customerName,
        receivedDate: o.receivedDate, completionDate: o.completionDate,
        turnaroundDays: turnaroundDays(o.receivedDate, o.completionDate),
      }))
      .sort((a, b) => a.completionDate.localeCompare(b.completionDate) || a.orderNumber - b.orderNumber);
    return { groupBy: "none", rows, orderCount, avgDays };
  }

  const groupBy = opts.groupBy;
  type Acc = { key: string; label: string; count: number; sum: number; min: number; max: number };
  const groups = new Map<string, Acc>();
  for (const o of orders) {
    const days = turnaroundDays(o.receivedDate, o.completionDate);
    const seen = new Set<string>(); // one order counts once per group, even across duplicate parts
    for (const { key, label } of dimensionKeys(o, groupBy)) {
      if (seen.has(key)) continue;
      seen.add(key);
      let acc = groups.get(key);
      if (!acc) { acc = { key, label, count: 0, sum: 0, min: days, max: days }; groups.set(key, acc); }
      acc.count += 1;
      acc.sum += days;
      acc.min = Math.min(acc.min, days);
      acc.max = Math.max(acc.max, days);
    }
  }
  const rows: TurnaroundGroupRow[] = [...groups.values()]
    .map((a) => ({
      key: a.key, label: a.label, orderCount: a.count,
      avgDays: roundAvg(a.sum, a.count), minDays: a.min, maxDays: a.max,
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  return { groupBy, rows, orderCount, avgDays };
}

// -------------------------------------------------------------------------------------------
// reportTurnaround — the Prisma-reading wrapper. Read-only: no claim, no transaction, no audit.
// -------------------------------------------------------------------------------------------

export type TurnaroundFilter = {
  customerId?: string;
  partId?: string;
  from?: string; // completionDate >=
  to?: string; // completionDate <=
  groupBy?: TurnaroundGroupBy;
};

/** `parseDateOnly` at the service boundary — the `buildBacklog`/`buildShipped` `parseDate`
 *  precedent: a malformed bound fails as a field-anchored 400, not a status-less 500. */
function parseDate(value: string, field: string): Date {
  try {
    return parseDateOnly(value);
  } catch {
    throw new HttpError(400, `"${value}" is not a valid date (yyyy-mm-dd) for ${field}`);
  }
}

/** The service owns groupBy validation (the parse layer passes the raw string through), so an
 *  unknown value fails as a 400 rather than silently falling back to a view the caller did not ask
 *  for. */
function normalizeGroupBy(value: string | undefined): TurnaroundGroupBy {
  if (value === undefined) return "none";
  if ((GROUP_BYS as readonly string[]).includes(value)) return value as TurnaroundGroupBy;
  throw new HttpError(400, `Cannot group turnaround by "${value}"`);
}

export async function reportTurnaround(filter: TurnaroundFilter = {}): Promise<TurnaroundResult> {
  const groupBy = normalizeGroupBy(filter.groupBy);
  const fromDate = filter.from ? parseDate(filter.from, "Completed from") : null;
  const toDate = filter.to ? parseDate(filter.to, "Completed to") : null;

  // Only currently-SHIPPED, live orders. The completion date is DERIVED from each line's live
  // shipper lines, so it cannot be a SQL WHERE — the range filter is applied in memory
  // after the derivation.
  const orderRows = await prisma.order.findMany({
    where: {
      deletedAt: null,
      status: "SHIPPED",
      ...(filter.customerId ? { customerId: filter.customerId } : {}),
      ...(filter.partId ? { lines: { some: { partId: filter.partId } } } : {}),
    },
    select: {
      id: true, orderNumber: true, receivedDate: true, customerId: true,
      customer: { select: { code: true, name: true } },
      lines: {
        select: {
          partId: true, qty: true,
          part: { select: { partNumber: true, name: true } },
          // Every LIVE shipper line for this order line. `lineCompletionDate` applies the rule: the
          // day the running quantity reached ordered, or the earliest close short whose shipment is
          // not reversed by a live reversal.
          shipperLines: {
            where: { shipperOrder: { shipper: { deletedAt: null } } },
            select: {
              qty: true, lineComplete: true,
              shipperOrder: { select: {
                sequence: true,
                shipper: { select: { shipDate: true, reversedBy: { where: { deletedAt: null }, select: { id: true } } } },
              } },
            },
          },
        },
      },
    },
  });

  const completed: CompletedOrder[] = [];
  for (const o of orderRows) {
    // Full-ship: each line's completion date comes from `lineCompletionDate`; the order completes on
    // the MAX (the day the last line completed). A line that never completed leaves the order
    // un-derivable — skip it (a currently-SHIPPED order should always have one per the ship-ledger's
    // own SHIPPED rule, but this stays safe against a stale status rather than emitting a wrong date).
    const partsMap = new Map<string, { partId: string; partNumber: string; partName: string }>();
    let orderComplete: Date | null = null;
    let derivable = true;
    for (const line of o.lines) {
      partsMap.set(line.partId, { partId: line.partId, partNumber: line.part.partNumber, partName: line.part.name });
      const lineComplete = lineCompletionDate(line.shipperLines.map((sl) => ({
        shipDate: sl.shipperOrder.shipper.shipDate,
        sequence: sl.shipperOrder.sequence,
        qty: sl.qty,
        closedShort: sl.lineComplete,
        reversedLive: sl.shipperOrder.shipper.reversedBy.length > 0,
      })), line.qty);
      if (lineComplete === null) { derivable = false; break; }
      if (orderComplete === null || lineComplete.getTime() > orderComplete.getTime()) orderComplete = lineComplete; // MAX
    }
    if (!derivable || orderComplete === null) continue;
    if (fromDate && orderComplete.getTime() < fromDate.getTime()) continue;
    if (toDate && orderComplete.getTime() > toDate.getTime()) continue;
    completed.push({
      orderId: o.id, orderNumber: o.orderNumber,
      customerId: o.customerId, customerCode: o.customer.code, customerName: o.customer.name,
      receivedDate: formatDateOnly(o.receivedDate),
      completionDate: formatDateOnly(orderComplete),
      parts: [...partsMap.values()],
    });
  }

  return buildTurnaround(completed, { groupBy });
}
