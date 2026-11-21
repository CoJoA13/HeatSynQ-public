// The traveler notice: which loads' printed traveler is out of date, and the sentence that says
// so. Design: docs/superpowers/specs/2026-10-06-quantity-corrections-auto-complete-design.md, §6
// and §10.3, with the owner's rulings of 2026-10-08.
//
// A pure leaf, safe in a client component. It imports the print record's leaf, the screen
// formatter and the client's list of order statuses, and nothing else. vitest has no component
// renderer, so every decision is here and TravelerNoticeView.tsx only renders what
// `travelerNoticeText` returns.
//
// It is handed two things the order hub already holds: the page's order, as the server last sent
// it, and the order's document list. Each traveler print on that list carries the record of what
// it printed (traveler-print-record.ts). The rule compares figures and reads no clock, so a value
// put back clears the notice with no reprint, and a save that changes nothing raises none.
import {
  parseTravelerPrintRecord, recordLines, recordLoad,
  type PrintRecordOrder, type RecordLine, type TravelerPrintRecord,
} from "./traveler-print-record";
import { formatNumber } from "./format";
import { ORDER_STATUSES, type OrderStatusValue } from "./order-constants";

/** One row of the order's document list, as far as the notice reads it. A row of another kind
 *  than `"TRAVELER"` is passed over. */
export type NoticePrint = {
  kind: string;
  loadNumber: number | null;
  travelerLoadNumbers?: readonly number[];
  travelerPrintRecord?: string | null;
};

/** The order as the page holds it. The page's `OrderDetail` satisfies this as it is: its status
 *  is typed by the same list, `ORDER_STATUSES` in order-constants.ts. */
export type NoticeOrder = PrintRecordOrder & { status: OrderStatusValue; voided: boolean };

/** Whether an order of each status shows the notice (owner ruling P3-Q3). It shows while the
 *  order is still on the floor. A shipped or invoiced order corrected afterwards would carry the
 *  notice for good.
 *
 *  One answer for every status in `ORDER_STATUSES`, and no other key: this is a Record over that
 *  list's type, so a status renamed or added there does not compile here until it has an answer. */
const SHOWS_NOTICE: Record<OrderStatusValue, boolean> = {
  OPEN: true, PARTIAL_SHIPPED: true, SHIPPED: false, INVOICED: false, REOPENED: true,
};

/** The statuses that show the notice, in the order `ORDER_STATUSES` lists them. */
export const NOTICE_STATUSES: readonly OrderStatusValue[] = ORDER_STATUSES.filter((status) => SHOWS_NOTICE[status]);

/** The most load numbers the sentence spells out. Past it the sentence gives the count: a line
 *  change puts every printed load out of date, and the summary stays on screen. */
export const NOTICE_LIST_LIMIT = 8;

/** `loadNumbers` is ascending. `loadCount` is how many loads the order has now. An order with no
 *  loads can be `stale` with no load listed. */
export type StaleTravelers = { stale: boolean; loadNumbers: number[]; loadCount: number };

const isTraveler = (print: NoticePrint): boolean => print.kind === "TRAVELER";

/** An all-loads print: it names no single load and no selected set. */
const coversEveryLoad = (print: NoticePrint): boolean =>
  print.loadNumber === null && !print.travelerLoadNumbers?.length;

const covers = (print: NoticePrint, loadNumber: number): boolean => isTraveler(print)
  && (coversEveryLoad(print) || print.loadNumber === loadNumber
    || (print.travelerLoadNumbers ?? []).includes(loadNumber));

/** A line is known by its part and its place, so the two lists are compared place by place. */
function sameLines(printed: readonly RecordLine[], now: readonly RecordLine[]): boolean {
  return printed.length === now.length && printed.every((line, index) =>
    line.partId === now[index].partId && line.qty === now[index].qty && line.weightCents === now[index].weightCents);
}

/**
 * Which loads' printed traveler is out of date.
 *
 * `prints` is NEWEST FIRST, as `GET /api/orders/[id]/documents` answers it. This function does
 * not sort it: a row carries no time the leaf could sort by, and the caller hands the list on as
 * it arrived.
 *
 * Each load on the order now is judged by the newest traveler print that covers it (owner ruling
 * P3-Q2). An all-loads print covers every load, a one-load or selected-loads print its own.
 *
 * - No print covers the load: it was never printed, and there is nothing to say.
 * - That print has no record, or one this code cannot read: unknown, nothing to say. It still
 *   hides any older print of the same load.
 * - Otherwise the load is listed when the record's lines differ from the order's, or the record
 *   has no entry for the load, or the entry's quantity or weight differs.
 *
 * So a changed line lists every printed load and a changed load only itself. A load added after
 * an all-loads print is listed, because that print covers it and its record has no entry for it.
 * A load added to an order printed only load by load is not, because no print covers it.
 *
 * An order with no loads is one sheet, judged by its newest all-loads print.
 *
 * Never out of date: a voided order, and a status outside `NOTICE_STATUSES`.
 */
export function staleTravelers(order: NoticeOrder, prints: readonly NoticePrint[]): StaleTravelers {
  const result: StaleTravelers = { stale: false, loadNumbers: [], loadCount: order.loads.length };
  if (order.voided || !NOTICE_STATUSES.includes(order.status)) return result;

  const linesNow = recordLines(order);
  // Each print's record is read once, however many loads that print decides. An all-loads record
  // of 100 loads is about 5 KB of JSON. On the order page this runs when the order's lines, loads,
  // status or void, or the document list, is a new value: `TravelerNotice` memoizes the view.
  const records = new Map<NoticePrint, TravelerPrintRecord | null>();
  const recordOf = (print: NoticePrint): TravelerPrintRecord | null => {
    let record = records.get(print);
    if (record === undefined) {
      record = parseTravelerPrintRecord(print.travelerPrintRecord);
      records.set(print, record);
    }
    return record;
  };

  if (order.loads.length === 0) {
    const print = prints.find((candidate) => isTraveler(candidate) && coversEveryLoad(candidate));
    const record = print === undefined ? null : recordOf(print);
    result.stale = record !== null && (!sameLines(record.lines, linesNow) || record.loads.length > 0);
    return result;
  }

  for (const load of [...order.loads].sort((a, b) => a.loadNumber - b.loadNumber)) {
    const print = prints.find((candidate) => covers(candidate, load.loadNumber));
    if (print === undefined) continue;
    const record = recordOf(print);
    if (record === null) continue;
    const printed = record.loads.find((entry) => entry.loadNumber === load.loadNumber);
    const now = recordLoad(load);
    if (!sameLines(record.lines, linesNow) || printed === undefined
        || printed.qty !== now.qty || printed.weightCents !== now.weightCents) {
      result.loadNumbers.push(load.loadNumber);
    }
  }
  result.stale = result.loadNumbers.length > 0;
  return result;
}

/** How N2 to N4 end, and N1 after its colon. */
const ENDING = "a quantity, a weight or the loads changed after it printed.";

/**
 * The notice's sentence, or null when no traveler is out of date. The wording is the design's
 * §10.5, rows N1 to N4, and is not to be reworded here.
 *
 * It names no load when the order has one load or none (N1): there is only one traveler to mean.
 * The same sentence answers a result that lists no load, which `staleTravelers` gives only for an
 * order with no loads. N4's count is a screen number and is grouped. A load number is an
 * identifier and is written plain.
 */
export function travelerNoticeText(result: StaleTravelers): string | null {
  if (!result.stale) return null;
  const listed = result.loadNumbers;
  if (result.loadCount <= 1 || listed.length === 0) return `The printed traveler is out of date: ${ENDING}`;
  if (listed.length === 1) return `The printed traveler for Load ${listed[0]} is out of date: ${ENDING}`;
  if (listed.length > NOTICE_LIST_LIMIT) return `The printed travelers for ${formatNumber(listed.length)} loads are out of date: ${ENDING}`;
  const last = listed[listed.length - 1];
  return `The printed travelers for Loads ${listed.slice(0, -1).join(", ")} and ${last} are out of date: ${ENDING}`;
}
