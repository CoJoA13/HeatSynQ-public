import { describe, expect, it } from "vitest";
import { UNSAVED_TOTALS } from "@/lib/order-totals";
import {
  SHIPMENT_TOTALS_CAPTION, shipmentTotals, totalsForCaption, type ShipmentTotalsOrder, type TotalsTableView,
} from "@/lib/shipment-totals";
import { SHIPMENT_TOTALS, readShipmentTotals, totalsFor, waitForShipmentTotals } from "../e2e/lib/shipment-totals.mjs";
import { EXPECTED_TOTALS as DISCARD_GRID_EDITS } from "../e2e/flows/discard-grid-edits.mjs";
import { EXPECTED_TOTALS as REVERSE_SHIPMENT } from "../e2e/flows/reverse-shipment.mjs";
import { EXPECTED_TOTALS as SHIP_PARTIAL } from "../e2e/flows/ship-partial-then-complete.mjs";

// The flows read the Net, Tare and Gross tables of both shipment screens through
// e2e/lib/shipment-totals.mjs. A wait that returned early, or took a missing table for an empty
// one, would turn every one of those reads into a green step that proves nothing, and no browser
// run would show it. So what the helper does with one pass over a table is proven here against a
// stand-in for a Playwright locator, as tests/e2e-order-totals.test.ts proves the order table's
// reader. The pass itself runs inside a page. Here the function the helper hands the page is run
// over stand-ins for a table element, which are plain objects: only a browser run proves that it
// reads a real table.
//
// The last describe holds the readings three flows wait for to what the totals leaf gives for the
// same figures.

/** What the helper's in-page function hands back for one pass over a table. */
type Pass = { caption: string | null; tag: string | null; rows: string[][]; notes: string[] };

const NAME = "Totals for 1031-1";
const CELLS = ["1,600.00", "Incomplete", "Not available"];
/** Order 1031 on a saved shipment: 1,600.00 lb in one container row with no Tare each. */
const pass = (over: Partial<Pass> = {}): Pass => ({ caption: NAME, tag: null, rows: [CELLS], notes: ["1 row has no Tare each"], ...over });
/** That pass as a reading. */
const READING = { tag: null, cells: CELLS, note: "1 row has no Tare each" };

/** A stand-in for the scope a flow looks in: a page, or an order panel's locator. Each pass takes
 *  the next answer, and the last answer repeats. An Error is thrown, the way a locator rejects.
 *  `found` records how each pass looked for the table: the selector it asked the scope for, then
 *  what it asked that locator for. `handed` records what each pass handed `evaluate`, argument by
 *  argument, and `passes()` says how many were made. */
function scope(...answers: (Pass | Error)[]) {
  const found: unknown[][] = [];
  const handed: unknown[][] = [];
  let made = 0;
  return {
    found,
    handed,
    passes: () => made,
    locator: (selector: string) => ({ getByRole: (...how: unknown[]) => ({ evaluate: async (...what: unknown[]) => {
      found.push([selector, ...how]);
      handed.push(what);
      const answer = answers[Math.min(made++, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer;
    } }) }),
  };
}

/** The function the helper hands the page, taken from one read. */
async function inPage(): Promise<(table: unknown) => Pass> {
  const panel = scope(pass());
  await readShipmentTotals(panel, NAME);
  return panel.handed[0][0] as (table: unknown) => Pass;
}
/** A stand-in for an element, as far as that function reads one. */
const element = (textContent: string, role: string | null = null) =>
  ({ textContent, getAttribute: (name: string) => (name === "role" ? role : null) });
/** A stand-in for a table element: its caption's children, its body rows' cells, and the children
 *  of the block round it. `asked` records each selector the function asks it for. */
function table(caption: string[] | null, rows: string[][], blockChildren: ReturnType<typeof element>[]) {
  const asked: string[] = [];
  return {
    asked,
    caption: caption && { children: caption.map((text) => element(text)) },
    tBodies: [{ rows: rows.map((cells) => ({ querySelectorAll: (selector: string) => { asked.push(selector); return cells.map((text) => element(text)); } })) }],
    closest: (selector: string) => { asked.push(selector); return { children: blockChildren }; },
  };
}

describe("the tables' names (e2e/lib/shipment-totals.mjs)", () => {
  it("names the shipment's table and an order's as the leaf the screens read captions them", () => {
    expect([SHIPMENT_TOTALS, totalsFor("1031-1"), totalsFor("#1031")])
      .toEqual([SHIPMENT_TOTALS_CAPTION, totalsForCaption("1031-1"), totalsForCaption("#1031")]);
  });
});

describe("readShipmentTotals (e2e/lib/shipment-totals.mjs)", () => {
  it("finds the table by its role and its exact name, inside a marked block", async () => {
    const panel = scope(pass());
    await readShipmentTotals(panel, NAME);
    expect(panel.found).toEqual([["[data-shipment-totals]", "table", { name: NAME, exact: true }]]);
  });

  it("hands the page its own pass, no argument, and five seconds to find the table", async () => {
    const panel = scope(pass());
    await readShipmentTotals(panel, NAME);
    // A locator's `evaluate` takes the function, its one argument and then the options. Were the
    // argument's place left out, the options would be handed to the function as its argument.
    expect(panel.handed).toEqual([[expect.any(Function), undefined, { timeout: 5000 }]]);
  });

  it("gives the tag, the three cells and the note of a pass", async () => {
    expect(await readShipmentTotals(scope(pass({ tag: "Unsaved totals" })), NAME)).toEqual({ ...READING, tag: "Unsaved totals" });
  });

  it("gives null, and not undefined, for no note", async () => {
    expect(await readShipmentTotals(scope(pass({ notes: [] })), NAME)).toStrictEqual({ ...READING, note: null });
  });

  it.each<[string, Partial<Pass>]>([
    ["has no caption", { caption: null }],
    ["is captioned for another table", { caption: "Shipment totals" }],
    ["has no body row", { rows: [] }],
    ["has two body rows", { rows: [CELLS, CELLS] }],
    ["has a row of two cells", { rows: [["1,600.00", "Incomplete"]] }],
    ["has a row of four cells", { rows: [["250", ...CELLS]] }],
    ["has two status paragraphs", { notes: ["1 row has no Tare each", "1 order has no containers"] }],
  ])("refuses a pass that %s", async (_what, over) => {
    await expect(readShipmentTotals(scope(pass(over)), NAME)).rejects.toMatchObject({ code: "ERR_ASSERTION" });
  });
});

describe("the pass inside the page (e2e/lib/shipment-totals.mjs)", () => {
  it("reads the caption's first child, the tag after it, the row's cells and the block's status child", async () => {
    const drawn = table([NAME, "Unsaved  totals"], [["600.00", " 200.00 ", "800.00"]],
      [element("the table itself"), element("1 order has\n no containers", "status"), element("not a note")]);
    expect((await inPage())(drawn)).toStrictEqual({ caption: NAME, tag: "Unsaved totals", rows: [["600.00", "200.00", "800.00"]], notes: ["1 order has no containers"] });
  });

  it("gives no tag for a caption of one child, and asks the table for its marked block and each row for its cells", async () => {
    const drawn = table([NAME], [CELLS], []);
    expect((await inPage())(drawn)).toStrictEqual({ caption: NAME, tag: null, rows: [CELLS], notes: [] });
    expect(drawn.asked).toEqual(["[data-shipment-totals]", "td"]);
  });

  it("answers a table with no caption, no row and no note with nulls and empty lists", async () => {
    expect((await inPage())(table(null, [], []))).toStrictEqual({ caption: null, tag: null, rows: [], notes: [] });
  });
});

describe("waitForShipmentTotals (e2e/lib/shipment-totals.mjs)", () => {
  it("waits past an earlier reading for the one it was asked for", async () => {
    const typed = ["1,600.00", "127.50", "1,727.50"];
    const panel = scope(pass(), pass({ tag: "Unsaved totals", rows: [typed], notes: [] }));
    await waitForShipmentTotals(panel, NAME, { tag: "Unsaved totals", cells: typed, note: null });
    expect(panel.passes()).toBe(2);
  });

  it("takes cells that read the same, though they are not the list the pass handed back", async () => {
    // The pass hands back one list, and the case expects another that holds the same three texts.
    const panel = scope(pass({ rows: [[...CELLS]] }));
    await expect(waitForShipmentTotals(panel, NAME, { cells: [...CELLS] }, 300)).resolves.toBeUndefined();
  });

  it.each<[string, Record<string, unknown>]>([
    ["a note that must be gone", { cells: CELLS, note: null }],
    ["a tag that is not there", { cells: CELLS, tag: "Unsaved totals" }],
    ["one cell of the three that differs", { tag: null, cells: ["1,600.00", "127.50", "Not available"] }],
  ])("holds every key it is given, whole, and fails with the last reading: %s", async (_what, expected) => {
    await expect(waitForShipmentTotals(scope(pass()), NAME, expected, 300)).rejects.toMatchObject({
      code: "ERR_ASSERTION",
      message: `Timed out waiting for Totals for 1031-1 to read ${JSON.stringify(expected)}; last read ${JSON.stringify(READING)}`,
    });
  });

  it("keeps polling past a rejected pass", async () => {
    const panel = scope(new Error("locator.evaluate: Execution context was destroyed"), pass());
    await waitForShipmentTotals(panel, NAME, { note: "1 row has no Tare each" });
    expect(panel.passes()).toBe(2);
  });

  it("never takes a table that is not there for one with no tag and no note", async () => {
    // What a locator rejects with while its element is not there: the read's own timeout runs out.
    const notAttached = Object.assign(new Error("locator.evaluate: Timeout 1000ms exceeded."), { name: "TimeoutError" });
    await expect(waitForShipmentTotals(scope(notAttached), SHIPMENT_TOTALS, { tag: null, note: null }, 300)).rejects.toMatchObject({
      code: "ERR_ASSERTION",
      message: 'Timed out waiting for Shipment totals to read {"tag":null,"note":null}; last read nothing (the element could not be read)',
    });
  });

  it("gives each pass one second though the wait is given twenty, and hands the page what readShipmentTotals hands it", async () => {
    const panel = scope(new Error("locator.evaluate: Execution context was destroyed"), pass());
    await waitForShipmentTotals(panel, NAME, { note: "1 row has no Tare each" }, 20000);
    const handed = await inPage();
    expect(panel.handed).toEqual([[handed, undefined, { timeout: 1000 }], [handed, undefined, { timeout: 1000 }]]);
  });

  it("ends at once on a pass that is not the table's shape", async () => {
    // The second pass is the one asked for: a wait that went on past the first would end well.
    const panel = scope(pass({ rows: [] }), pass());
    await expect(waitForShipmentTotals(panel, NAME, { note: "1 row has no Tare each" })).rejects.toMatchObject({ code: "ERR_ASSERTION" });
  });

  it.each<[string, Record<string, unknown>]>([
    ["no key", {}],
    ["a key no reading has", { rows: [CELLS] }],
  ])("refuses an expectation with %s, before any pass", async (_what, expected) => {
    const panel = scope(pass());
    await expect(waitForShipmentTotals(panel, NAME, expected, 300)).rejects.toMatchObject({ code: "ERR_ASSERTION" });
    expect(panel.passes()).toBe(0);
  });
});

describe("the readings the flows wait for (e2e/flows)", () => {
  /** A table's view as a flow reads the table drawn from it. */
  const read = (view: TotalsTableView | null) =>
    view && { tag: view.unsaved ? UNSAVED_TOTALS : null, cells: [view.net, view.tare, view.gross], note: view.note };
  /** Every table of a shipment as a flow reads them: each order's in order, then the shipment's. */
  const tables = (...orders: ShipmentTotalsOrder[]) => {
    const view = shipmentTotals(orders);
    return [...view.orders, view.shipment].map(read);
  };
  /** A flow whose shipment has one order waits for one reading in both of its tables. */
  const inBothTables = (readings: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(readings).map(([step, reading]) => [step, [reading, reading]]));
  const row = (count: number | string, tareEach: number | string) => [{ count, tareEach }];

  it("ship-partial-then-complete: one order in one container row, as the boxes stand at each step", () => {
    expect(inBothTables(SHIP_PARTIAL)).toEqual({
      asAdded: tables({ label: "#1", lineWeights: ["1000", "200"], containers: row("5", "42.5") }),
      typedOver: tables({ label: "#1", lineWeights: ["1000", "200"], containers: row("5", "45") }),
      shipped: tables({ label: "#1", lineWeights: ["600", "0"], containers: row("5", "45") }),
      typed: tables({ label: "1-1", lineWeights: ["600", "0"], containers: row("5", "40"), unsaved: true }),
      saved: tables({ label: "1-1", lineWeights: [600, 0], containers: row(5, 40) }),
      fewer: tables({ label: "1-1", lineWeights: [600, 0], containers: row(4, 40) }),
      keptTyped: tables({ label: "1-1", lineWeights: ["600", "0"], containers: row("4", "12.5"), unsaved: true }),
      keptSaved: tables({ label: "1-1", lineWeights: [600, 0], containers: row(4, 12.5) }),
    });
  });

  it("discard-grid-edits: two orders, one with a container row and one without", () => {
    const [formA, formB, form] = tables(
      { label: "#1", lineWeights: ["100"], containers: row("3", "") }, { label: "#2", lineWeights: ["50"], containers: [] });
    const [typedA, typedB, typed] = tables(
      { label: "1-1", lineWeights: ["100"], containers: row("2", "42.5"), unsaved: true },
      { label: "2-1", lineWeights: ["50"], containers: [], unsaved: true });
    const [discardedA, , discarded] = tables(
      { label: "1-1", lineWeights: ["100"], containers: row("3", "") }, { label: "2-1", lineWeights: ["50"], containers: [], unsaved: true });
    const [, alone] = tables({ label: "2-1", lineWeights: ["50"], containers: [] });
    expect(DISCARD_GRID_EDITS).toEqual({
      form: { a: formA, b: formB, shipment: form },
      typed: { a: typedA, b: typedB, shipment: typed },
      discarded: { a: discardedA, shipment: discarded },
      alone,
    });
  });

  it("reverse-shipment: an order with no container row, and its reversal", () => {
    expect(inBothTables(REVERSE_SHIPMENT)).toEqual({
      original: tables({ label: "1-1", lineWeights: [50], containers: [] }),
      reversed: tables({ label: "1-2", lineWeights: [-50], containers: [] }),
    });
  });
});
