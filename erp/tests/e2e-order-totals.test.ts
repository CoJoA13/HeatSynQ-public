import { describe, expect, it } from "vitest";
import { orderTotalsBlock, pounds, readTotals, waitForTotals } from "../e2e/lib/order-totals.mjs";

// The flows read the Order totals table through e2e/lib/order-totals.mjs.
// A wait that returned early, or took a missing table for an empty one, would turn every one of
// those reads into a green step that proves nothing, and no browser run would show it. So what the
// helper does with one pass over the block is proven here against a stand-in for a Playwright
// locator, the way tests/e2e-wait-for-title.test.ts proves `waitForTitle`. The pass itself runs
// inside a page. Here the function the helper hands the page is run once, over a stand-in for a
// table with nothing in it: only a browser run proves that it reads a table.

/** What the helper's in-page function hands back for one pass over the block. */
type Pass = { caption: string | null; tag: string | null; rows: { heading: string; cells: string[] }[];
  notes: string[]; weighed: string[]; paragraphs: number };

const ROWS = [
  { heading: "Parts", cells: ["30", "3,810.00", "", ""] },
  { heading: "Containers", cells: ["Not entered", "", "Incomplete", ""] },
  { heading: "Order", cells: ["", "3,810.00", "Incomplete", "Not available"] },
];
/** One container row with no Pieces and no Tare each, on an order of 30 pieces and 3,810.00 lb. */
const pass = (over: Partial<Pass> = {}): Pass => ({ caption: "Order totals", tag: null, rows: ROWS,
  notes: ["1 row has no Tare each"], weighed: [], paragraphs: 1, ...over });
/** That pass as a reading. */
const READING = { tag: null, rows: { Parts: ROWS[0].cells, Containers: ROWS[1].cells, Order: ROWS[2].cells },
  note: "1 row has no Tare each", weighed: [] };

/** A stand-in for the block's locator. Each pass takes the next answer, and the last answer
 *  repeats. An Error is thrown, the way a locator rejects. `found` records how each pass looked
 *  for the table, `handed` what each pass handed `evaluate`, argument by argument, and `passes()`
 *  says how many were made. */
function block(...answers: (Pass | Error)[]) {
  const found: unknown[][] = [];
  const handed: unknown[][] = [];
  let made = 0;
  return {
    found,
    handed,
    passes: () => made,
    getByRole: (...how: unknown[]) => ({ evaluate: async (...what: unknown[]) => {
      found.push(how);
      handed.push(what);
      const answer = answers[Math.min(made++, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer;
    } }),
  };
}

describe("orderTotalsBlock and readTotals (e2e/lib/order-totals.mjs)", () => {
  it("finds the block by its data attribute, inside the scope it is given", () => {
    expect(orderTotalsBlock({ locator: (selector: string) => ({ selector }) })).toEqual({ selector: "[data-order-totals]" });
  });

  it("finds the table by its role and its exact name, and gives its rows by heading", async () => {
    const totals = block(pass());
    expect(await readTotals(totals)).toEqual(READING);
    expect(totals.found).toEqual([["table", { name: "Order totals", exact: true }]]);
  });

  it("hands the page its own pass, no argument, and five seconds to find the table", async () => {
    const totals = block(pass());
    await readTotals(totals);
    // A locator's `evaluate` takes the function, its one argument and then the options. Were the
    // argument's place left out, the options would be handed to the function as its argument.
    expect(totals.handed).toHaveLength(1);
    expect(totals.handed[0]).toHaveLength(3);
    const [inPage, argument, options] = totals.handed[0];
    expect(argument).toBeUndefined();
    expect(options).toEqual({ timeout: 5000 });
    // The function, run over a stand-in for a table element with nothing in it: no caption, no
    // body and no root round it. It answers a pass with nothing in it, which is refused.
    const nothing = (inPage as (table: unknown) => Pass)({ caption: null, closest: () => null, tBodies: [] });
    expect(nothing).toEqual({ caption: null, tag: null, rows: [], notes: [], weighed: [], paragraphs: 0 });
    await expect(readTotals(block(nothing))).rejects.toMatchObject({ code: "ERR_ASSERTION" });
  });

  it("gives null for no note, the tag when there is one, and each weighed line in order", async () => {
    const weighed = ["Weighed net 3,937.00 lb · 127.00 lb over", "Implied pieces 31 · 1 over"];
    expect(await readTotals(block(pass({ notes: [], weighed, paragraphs: 2 })))).toEqual({ ...READING, note: null, weighed });
    expect(await readTotals(block(pass({ tag: "Unsaved totals" })))).toEqual({ ...READING, tag: "Unsaved totals" });
  });

  it.each<[string, Partial<Pass>]>([
    ["has no caption", { caption: null }],
    ["has two rows", { rows: ROWS.slice(0, 2) }],
    ["has its rows out of order", { rows: [ROWS[1], ROWS[0], ROWS[2]] }],
    ["has a row of three cells", { rows: [ROWS[0], ROWS[1], { heading: "Order", cells: ["", "3,810.00", "Incomplete"] }] }],
    ["has two status paragraphs", { notes: ["1 row has no Pieces", "1 row has no Tare each"], paragraphs: 2 }],
    ["has a paragraph that is neither the note nor a weighed line", { paragraphs: 2 }],
  ])("refuses a pass that %s", async (_what, over) => {
    await expect(readTotals(block(pass(over)))).rejects.toMatchObject({ code: "ERR_ASSERTION" });
  });
});

describe("waitForTotals (e2e/lib/order-totals.mjs)", () => {
  it("waits past an earlier reading for the one it was asked for", async () => {
    const with24 = { heading: "Containers", cells: ["24", "", "Incomplete", ""] };
    const totals = block(pass(), pass({ rows: [ROWS[0], with24, ROWS[2]] }));
    await waitForTotals(totals, { ...READING, rows: { ...READING.rows, Containers: with24.cells } });
    expect(totals.passes()).toBe(2);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a note that must be gone", { rows: READING.rows, note: null }],
    ["a tag that is not there", { rows: READING.rows, tag: "Unsaved totals" }],
    ["a weighed line that is not there", { rows: READING.rows, weighed: ["Weighed net 3,937.00 lb"] }],
    ["one row of the three", { rows: { Parts: ROWS[0].cells } }],
  ])("holds every key it is given, whole: %s", async (_what, expected) => {
    await expect(waitForTotals(block(pass()), expected, 300)).rejects.toMatchObject({
      code: "ERR_ASSERTION",
      message: `Timed out waiting for Order totals to read ${JSON.stringify(expected)}; last read ${JSON.stringify(READING)}`,
    });
  });

  it("keeps polling past a rejected pass, and never takes one for an empty table", async () => {
    const totals = block(new Error("locator.evaluate: Execution context was destroyed"), pass());
    await waitForTotals(totals, { note: "1 row has no Tare each" });
    expect(totals.passes()).toBe(2);
    // No table on the page is not a table with no tag, no note and no weighed line. This is what a
    // locator rejects with while its element is not there: the read's own timeout runs out.
    const notAttached = Object.assign(new Error("locator.evaluate: Timeout 1000ms exceeded."), { name: "TimeoutError" });
    await expect(waitForTotals(block(notAttached), { tag: null, note: null, weighed: [] }, 300)).rejects.toMatchObject({
      code: "ERR_ASSERTION",
      message: 'Timed out waiting for Order totals to read {"tag":null,"note":null,"weighed":[]}; '
        + "last read nothing (the element could not be read)",
    });
  });

  it("gives each pass one second though the wait is given twenty, and hands the page what readTotals hands it", async () => {
    const totals = block(new Error("locator.evaluate: Execution context was destroyed"), pass());
    await waitForTotals(totals, { note: "1 row has no Tare each" }, 20000);
    const read = block(pass());
    await readTotals(read);
    expect(totals.handed).toEqual([
      [read.handed[0][0], undefined, { timeout: 1000 }],
      [read.handed[0][0], undefined, { timeout: 1000 }],
    ]);
  });

  it("ends at once on a pass that is not the table's shape", async () => {
    const totals = block(pass({ rows: ROWS.slice(0, 2) }), pass());
    await expect(waitForTotals(totals, { note: "1 row has no Tare each" })).rejects.toMatchObject({ code: "ERR_ASSERTION" });
    expect(totals.passes()).toBe(1);
  });

  it.each<[string, Record<string, unknown>]>([
    ["no key", {}],
    ["a key no reading has", { row: READING.rows }],
  ])("refuses an expectation with %s, before any pass", async (_what, expected) => {
    const totals = block(pass());
    await expect(waitForTotals(totals, expected, 300)).rejects.toMatchObject({ code: "ERR_ASSERTION" });
    expect(totals.passes()).toBe(0);
  });
});

describe("pounds (e2e/lib/order-totals.mjs)", () => {
  it("prints a weight as the screens do: grouped, with two decimals", () => {
    expect([3810, 60, 1234.5, 0].map((weight) => pounds.format(weight))).toEqual(["3,810.00", "60.00", "1,234.50", "0.00"]);
  });
});
