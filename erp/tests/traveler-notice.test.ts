import { describe, expect, it } from "vitest";
import { ORDER_STATUSES } from "@/lib/order-constants";
import { buildTravelerPrintRecord, serializeTravelerPrintRecord } from "@/lib/traveler-print-record";
import type { TravelerSelection } from "@/lib/traveler-selection";
import {
  NOTICE_LIST_LIMIT, NOTICE_STATUSES, staleTravelers, travelerNoticeText,
  type NoticeOrder, type NoticePrint,
} from "@/lib/traveler-notice";

// The traveler notice's rule and its sentences (design 2026-10-06, §10.3 and §10.5; owner rulings
// of 2026-10-08). Hand-built orders and prints, every answer by value. No server and no database:
// a print here is the row the order's document list carries, made with the same two functions the
// print itself uses to store its record.

const ENDING = "a quantity, a weight or the loads changed after it printed.";
const N1 = `The printed traveler is out of date: ${ENDING}`;

/** One lead line of 100 pieces and three loads of 50, 30 and 20. Open, not voided. */
function order(over: Partial<NoticeOrder> = {}): NoticeOrder {
  return {
    status: "OPEN", voided: false,
    lines: [{ position: 1, partId: "part-a", qty: 100, weight: 150 }],
    loads: [
      { loadNumber: 1, qty: 50, weight: 75 },
      { loadNumber: 2, qty: 30, weight: 45 },
      { loadNumber: 3, qty: 20, weight: 30 },
    ],
    ...over,
  };
}

/** A traveler print of `printed`, as the document list carries it: the coverage columns the print
 *  writes (no load number and no list for all loads, the number for one load, the list for
 *  several) and the record it stores. No load numbers means an all-loads print. */
function print(printed: NoticeOrder, ...loadNumbers: number[]): NoticePrint {
  const selection: TravelerSelection = loadNumbers.length === 0 ? { mode: "all" } : { mode: "loads", loadNumbers };
  return {
    kind: "TRAVELER",
    loadNumber: loadNumbers.length === 1 ? loadNumbers[0] : null,
    travelerLoadNumbers: loadNumbers.length > 1 ? loadNumbers : [],
    travelerPrintRecord: serializeTravelerPrintRecord(buildTravelerPrintRecord(printed, selection)),
  };
}

/** A traveler print made before prints kept a record. */
const unrecorded = (loadNumber: number | null = null): NoticePrint =>
  ({ kind: "TRAVELER", loadNumber, travelerLoadNumbers: [], travelerPrintRecord: null });

const quiet = (loadCount: number) => ({ stale: false, loadNumbers: [], loadCount });
const text = (now: NoticeOrder, prints: NoticePrint[]) => travelerNoticeText(staleTravelers(now, prints));

const asPrinted = order();
/** The lead's quantity corrected from 100 to 32. */
const corrected = order({ lines: [{ position: 1, partId: "part-a", qty: 32, weight: 150 }] });

describe("which loads' printed traveler is out of date", () => {
  it("says nothing about an order that was never printed", () => {
    expect(staleTravelers(asPrinted, [])).toEqual(quiet(3));
    expect(staleTravelers(corrected, [])).toEqual(quiet(3));
  });

  it("says nothing while the order is as it printed, which is what a save that changes nothing leaves", () => {
    expect(staleTravelers(asPrinted, [print(asPrinted)])).toEqual(quiet(3));
    expect(staleTravelers(order(), [print(asPrinted)])).toEqual(quiet(3));
  });

  it("names every printed load when a line's quantity changed", () => {
    expect(staleTravelers(corrected, [print(asPrinted)])).toEqual({ stale: true, loadNumbers: [1, 2, 3], loadCount: 3 });
  });

  it("names every printed load when a line's weight changed by one cent", () => {
    const heavier = order({ lines: [{ position: 1, partId: "part-a", qty: 100, weight: 150.01 }] });
    expect(staleTravelers(heavier, [print(asPrinted)]).loadNumbers).toEqual([1, 2, 3]);
  });

  it("clears with no reprint when the value is put back", () => {
    const stored = [print(asPrinted)];
    expect(staleTravelers(corrected, stored).stale).toBe(true);
    expect(staleTravelers(order(), stored)).toEqual(quiet(3));
  });

  it("raises nothing for a re-split to the same loads: a load is known by its number, not by its row or where the row sits", () => {
    // The same three loads come back as new rows. The leaf's types carry no row id, so a new id
    // alone could not show here. What could tell the rows apart is where each sits in the order's
    // list, so they come back in another order: Load 3 first, where the print's record lists
    // Load 1. (A match by place among the loads sorted by number is other cases': a print of
    // selected loads lists fewer than the order has.)
    const [one, two, three] = asPrinted.loads;
    const resplit = order({ loads: [{ ...three }, { ...one }, { ...two }] });
    expect(resplit.loads.map((load) => load.loadNumber)).toEqual([3, 1, 2]);
    expect(staleTravelers(resplit, [print(asPrinted)])).toEqual(quiet(3));
  });

  it("names only the load whose own quantity or weight changed", () => {
    const [one, two, three] = asPrinted.loads;
    const stored = [print(asPrinted)];
    expect(staleTravelers(order({ loads: [one, { ...two, weight: 45.01 }, three] }), stored).loadNumbers).toEqual([2]);
    expect(staleTravelers(order({ loads: [one, { ...two, qty: 29 }, three] }), stored).loadNumbers).toEqual([2]);
    expect(staleTravelers(order({ loads: [one, { ...two, qty: null }, three] }), stored).loadNumbers).toEqual([2]);
    expect(staleTravelers(order({ loads: [one, { ...two, weight: null }, three] }), stored).loadNumbers).toEqual([2]);
  });

  it("lists the loads in ascending order however the order holds them", () => {
    const backwards = order({ ...corrected, loads: [...asPrinted.loads].reverse() });
    expect(staleTravelers(backwards, [print(asPrinted)]).loadNumbers).toEqual([1, 2, 3]);
  });

  it("judges each load by its own newest print: one load reprinted leaves the others named", () => {
    // The quantity is corrected, then Load 1 alone is printed again.
    expect(staleTravelers(corrected, [print(corrected, 1), print(asPrinted)]).loadNumbers).toEqual([2, 3]);
  });

  it("reads the prints newest first: the same two prints oldest first give another answer", () => {
    expect(staleTravelers(corrected, [print(asPrinted), print(corrected, 1)]).loadNumbers).toEqual([1, 2, 3]);
  });

  it("clears a load's own change when that load is printed again", () => {
    const [one, two, three] = asPrinted.loads;
    const edited = order({ loads: [one, { ...two, weight: 46 }, three] });
    expect(staleTravelers(edited, [print(edited, 2), print(asPrinted)])).toEqual(quiet(3));
  });

  it("counts a selected-loads print for the loads it lists", () => {
    expect(staleTravelers(corrected, [print(corrected, 1, 3), print(asPrinted)]).loadNumbers).toEqual([2]);
  });

  it("names Loads 1 and 3 when they printed before a line change and Load 2 after it", () => {
    expect(staleTravelers(corrected, [print(corrected, 2), print(asPrinted, 1, 3)]).loadNumbers).toEqual([1, 3]);
  });

  it("says nothing about a load no print covers", () => {
    // Only Loads 1 and 3 ever printed. Load 2 has no paper to be out of date.
    expect(staleTravelers(asPrinted, [print(asPrinted, 1, 3)])).toEqual(quiet(3));
    expect(staleTravelers(corrected, [print(asPrinted, 1, 3)]).loadNumbers).toEqual([1, 3]);
    expect(staleTravelers(corrected, [print(asPrinted, 2)]).loadNumbers).toEqual([2]);
  });

  it("names a load added after an all-loads print: that print covers it and its record has no entry", () => {
    const added = order({ loads: [...asPrinted.loads, { loadNumber: 4, qty: null, weight: 5 }] });
    expect(staleTravelers(added, [print(asPrinted)])).toEqual({ stale: true, loadNumbers: [4], loadCount: 4 });
  });

  it("does not name a load added to an order that only ever printed load by load", () => {
    const added = order({ loads: [...asPrinted.loads, { loadNumber: 4, qty: null, weight: 5 }] });
    const stored = [print(asPrinted, 3), print(asPrinted, 2), print(asPrinted, 1)];
    expect(staleTravelers(added, stored)).toEqual(quiet(4));
  });

  it("says nothing about the loads that stay when a load is removed", () => {
    const fewer = order({ loads: asPrinted.loads.slice(0, 2) });
    expect(staleTravelers(fewer, [print(asPrinted)])).toEqual(quiet(2));
  });

  it("names both loads when their contents exchange numbers", () => {
    const [one, two, three] = asPrinted.loads;
    const exchanged = order({ loads: [{ ...two, loadNumber: 1 }, { ...one, loadNumber: 2 }, three] });
    expect(staleTravelers(exchanged, [print(asPrinted)]).loadNumbers).toEqual([1, 2]);
  });

  it("counts a rider added, and one removed", () => {
    const rider = { position: 2, partId: "part-b", qty: 5, weight: 1 };
    const withRider = order({ lines: [...asPrinted.lines, rider] });
    expect(staleTravelers(withRider, [print(asPrinted)]).loadNumbers).toEqual([1, 2, 3]);
    expect(staleTravelers(asPrinted, [print(withRider)]).loadNumbers).toEqual([1, 2, 3]);
    // Removed and put back as it was: the line is known by its part and its place, not its row.
    expect(staleTravelers(order({ lines: [...asPrinted.lines, { ...rider }] }), [print(withRider)])).toEqual(quiet(3));
  });

  it("counts a rider swapped for another part with the same figures, and two riders that exchange places", () => {
    const lead = asPrinted.lines[0];
    const b = { position: 2, partId: "part-b", qty: 5, weight: 1 };
    const c = { position: 3, partId: "part-c", qty: 5, weight: 1 };
    const printed = order({ lines: [lead, b, c] });
    const swapped = order({ lines: [lead, { ...b, partId: "part-d" }, c] });
    const exchanged = order({ lines: [lead, { ...c, position: 2 }, { ...b, position: 3 }] });
    expect(staleTravelers(swapped, [print(printed)]).stale).toBe(true);
    expect(staleTravelers(exchanged, [print(printed)]).stale).toBe(true);
    // The same lines handed over in another array order are no change: position decides.
    expect(staleTravelers(order({ lines: [c, lead, b] }), [print(printed)])).toEqual(quiet(3));
  });

  it("says nothing when the newest print that covers a load has no record, or one it cannot read", () => {
    expect(staleTravelers(corrected, [unrecorded()])).toEqual(quiet(3));
    expect(staleTravelers(corrected, [{ kind: "TRAVELER", loadNumber: null }])).toEqual(quiet(3));
    for (const travelerPrintRecord of ["{", "", '{"v":2,"lines":[],"loads":[]}']) {
      expect(staleTravelers(corrected, [{ ...unrecorded(), travelerPrintRecord }])).toEqual(quiet(3));
    }
  });

  it("lets a newer print with no record hide an older one, for the loads the newer one covers", () => {
    expect(staleTravelers(corrected, [unrecorded(), print(asPrinted)])).toEqual(quiet(3));
    expect(staleTravelers(corrected, [unrecorded(2), print(asPrinted)]).loadNumbers).toEqual([1, 3]);
  });

  it("reads traveler prints only: another kind of document on the order covers nothing", () => {
    const shipper: NoticePrint = { kind: "SHIPPER", loadNumber: null, travelerLoadNumbers: [], travelerPrintRecord: null };
    expect(staleTravelers(corrected, [shipper, print(asPrinted)]).loadNumbers).toEqual([1, 2, 3]);
    expect(staleTravelers(corrected, [shipper])).toEqual(quiet(3));
  });

  it("names the order's one load", () => {
    const single = order({ loads: [{ loadNumber: 1, qty: 100, weight: 150 }] });
    const edited = order({ loads: [{ loadNumber: 1, qty: 100, weight: 151 }] });
    expect(staleTravelers(edited, [print(single)])).toEqual({ stale: true, loadNumbers: [1], loadCount: 1 });
    expect(staleTravelers(edited, [print(edited, 1), print(single)])).toEqual(quiet(1));
  });

  it("reads each print's record once in a call, however many loads that print decides", () => {
    // One all-loads print decides all three loads. Its record's text is handed over through a
    // getter that counts each read, and the leaf reads that text only where it parses it.
    const stored = print(asPrinted);
    let reads = 0;
    const counted: NoticePrint = {
      ...stored,
      get travelerPrintRecord() { reads += 1; return stored.travelerPrintRecord; },
    };
    expect(staleTravelers(corrected, [counted]).loadNumbers).toEqual([1, 2, 3]);
    expect(reads).toBe(1);
  });
});

describe("an order with no loads: one sheet, judged by its newest all-loads print", () => {
  const bare = order({ loads: [] });
  const bareCorrected = order({ ...corrected, loads: [] });

  it("says nothing while its lines are as they printed", () => {
    expect(staleTravelers(bare, [print(bare)])).toEqual(quiet(0));
  });

  it("is out of date, with no load to name, when a line changed", () => {
    expect(staleTravelers(bareCorrected, [print(bare)])).toEqual({ stale: true, loadNumbers: [], loadCount: 0 });
  });

  it("is out of date when the print listed a load the order no longer has", () => {
    expect(staleTravelers(bare, [print(asPrinted)])).toEqual({ stale: true, loadNumbers: [], loadCount: 0 });
  });

  it("is not judged by a one-load print, by another kind of document, or by a print with no record", () => {
    const shipper: NoticePrint = { kind: "SHIPPER", loadNumber: null, travelerLoadNumbers: [], travelerPrintRecord: null };
    expect(staleTravelers(bareCorrected, [print(asPrinted, 1)])).toEqual(quiet(0));
    expect(staleTravelers(bareCorrected, [print(asPrinted, 1, 2)])).toEqual(quiet(0));
    expect(staleTravelers(bareCorrected, [shipper])).toEqual(quiet(0));
    expect(staleTravelers(bareCorrected, [unrecorded(), print(bare)])).toEqual(quiet(0));
    // The newest all-loads TRAVELER print decides: a one-load print and another kind of document
    // in front of it are both passed over.
    expect(staleTravelers(bareCorrected, [print(asPrinted, 1), print(bare)]).stale).toBe(true);
    expect(staleTravelers(bareCorrected, [shipper, print(bare)]).stale).toBe(true);
  });
});

describe("which orders show the notice (owner ruling P3-Q3)", () => {
  // Written out here by hand, not read from the leaf: these two lists are the ruling.
  const SHOWN = ["OPEN", "PARTIAL_SHIPPED", "REOPENED"] as const;
  const NEVER = ["SHIPPED", "INVOICED"] as const;

  it("is Open, Partially shipped and Reopened, and no other status", () => {
    expect(NOTICE_STATUSES).toEqual([...SHOWN]);
  });

  it("gives every order status the app has a side: one renamed or added goes red here until it has one", () => {
    // `ORDER_STATUSES` is the client's own list (src/lib/order-constants.ts), which the page's
    // order is typed by. The two lists above are it, each status once.
    expect([...SHOWN, ...NEVER].sort()).toEqual([...ORDER_STATUSES].sort());
  });

  it.each(SHOWN)("shows on a %s order", (status) => {
    expect(staleTravelers({ ...corrected, status }, [print(asPrinted)]).stale).toBe(true);
  });

  it.each(NEVER)("never shows on a %s order", (status) => {
    expect(staleTravelers({ ...corrected, status }, [print(asPrinted)])).toEqual(quiet(3));
  });

  it("never shows on a voided order, whatever its status", () => {
    expect(staleTravelers({ ...corrected, voided: true }, [print(asPrinted)])).toEqual(quiet(3));
  });
});

describe("the notice's sentence (design §10.5, N1 to N4)", () => {
  const stale = (loadNumbers: number[], loadCount: number) => ({ stale: true, loadNumbers, loadCount });
  const upTo = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

  it("is nothing when no traveler is out of date", () => {
    expect(travelerNoticeText({ stale: false, loadNumbers: [], loadCount: 3 })).toBeNull();
    expect(text(asPrinted, [print(asPrinted)])).toBeNull();
  });

  it("N1: names no load when the order has one load, or none", () => {
    expect(N1).toBe("The printed traveler is out of date: a quantity, a weight or the loads changed after it printed.");
    expect(travelerNoticeText(stale([1], 1))).toBe(N1);
    expect(travelerNoticeText(stale([], 0))).toBe(N1);
  });

  it("N3: names the one load of several", () => {
    expect(travelerNoticeText(stale([2], 3))).toBe(`The printed traveler for Load 2 is out of date: ${ENDING}`);
  });

  it("N2: names two to eight loads, with 'and' before the last", () => {
    expect(travelerNoticeText(stale([2, 3], 3))).toBe(`The printed travelers for Loads 2 and 3 are out of date: ${ENDING}`);
    expect(travelerNoticeText(stale([1, 2, 3], 3))).toBe(`The printed travelers for Loads 1, 2 and 3 are out of date: ${ENDING}`);
    expect(NOTICE_LIST_LIMIT).toBe(8);
    expect(travelerNoticeText(stale(upTo(8), 20)))
      .toBe(`The printed travelers for Loads 1, 2, 3, 4, 5, 6, 7 and 8 are out of date: ${ENDING}`);
  });

  it("N4: gives the count when more than eight would be named", () => {
    expect(travelerNoticeText(stale(upTo(9), 20))).toBe(`The printed travelers for 9 loads are out of date: ${ENDING}`);
    expect(travelerNoticeText(stale(upTo(14), 14))).toBe(`The printed travelers for 14 loads are out of date: ${ENDING}`);
    // The count is a screen number and is grouped as every other one is. Load numbers are not.
    expect(travelerNoticeText(stale(upTo(1250), 1250))).toBe(`The printed travelers for 1,250 loads are out of date: ${ENDING}`);
  });

  it("names no load when none is listed, which the rule above never answers for an order with loads", () => {
    expect(travelerNoticeText(stale([], 3))).toBe(N1);
  });

  it("reads end to end from an order and its prints", () => {
    expect(text(corrected, [print(asPrinted)])).toBe(`The printed travelers for Loads 1, 2 and 3 are out of date: ${ENDING}`);
    expect(text(corrected, [print(corrected, 1), print(asPrinted)]))
      .toBe(`The printed travelers for Loads 2 and 3 are out of date: ${ENDING}`);
    const single = order({ loads: [{ loadNumber: 1, qty: 100, weight: 150 }] });
    expect(text(order({ loads: [{ loadNumber: 1, qty: 100, weight: 151 }] }), [print(single)])).toBe(N1);
  });
});
