// The Order totals table of both order screens, as a flow reads it (the weights design §10.2 and
// §10.3). One locator, one reading and one wait, so no flow writes a second reader of the table.
// And `pounds`, the one formatter a flow words a worked-out weight with.
//
// A reading is the tag, each body row's cells, the note and the weighed lines, taken in one pass
// inside the page, so no figure in it comes from a later render than another:
//
//   { tag, rows: { Parts, Containers, Order }, note, weighed }
//
// It does not read the head row: tests/order-totals-table.test.tsx holds the column headings, on
// static markup. Outside the table it reads only the paragraphs that are children of the block's
// root, so any other element there is not read.
//
// `rows` gives each row's four cells in column order, Pieces, Net (lb), Tare (lb), Gross (lb), with
// "" for an empty cell. `tag` is what the caption holds after its first child, as text, or null when
// it holds nothing more. `note` is the status paragraph under the table, or null. `weighed` is each
// paragraph under the table that has no role, in order.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { unreadReason } from "./ui.mjs";

const TABLE_NAME = "Order totals";
const ROW_HEADINGS = ["Parts", "Containers", "Order"];
const READING_KEYS = ["tag", "rows", "note", "weighed"];

/** A weight as both order screens print it: grouped, with two decimals. These are the settings
 *  `formatNumber(weight, 2)` uses in src/lib/format.ts. */
export const pounds = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The block's root inside `scope`: a page, or the locator of a section. */
export function orderTotalsBlock(scope) {
  return scope.locator("[data-order-totals]");
}

/** Runs inside the page, on the table element. It names nothing outside itself: the browser gets
 *  its source and nothing of this module. Runs of white space read as one space. */
function readInPage(table) {
  const text = (element) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();
  const captionParts = [...(table.caption?.children ?? [])].map(text);
  const root = table.closest("[data-order-totals]");
  const paragraphs = [...(root?.children ?? [])].filter((child) => child.tagName === "P");
  return {
    caption: captionParts[0] ?? null,
    tag: captionParts.length > 1 ? captionParts.slice(1).join(" ") : null,
    rows: [...table.tBodies].flatMap((body) => [...body.rows]).map((row) => ({
      heading: text(row.querySelector("th")),
      cells: [...row.querySelectorAll("td")].map(text),
    })),
    notes: paragraphs.filter((paragraph) => paragraph.getAttribute("role") === "status").map(text),
    weighed: paragraphs.filter((paragraph) => !paragraph.hasAttribute("role")).map(text),
    paragraphs: paragraphs.length,
  };
}

/** One pass over the block. Rejects, as a locator does, while the table cannot be found by its
 *  role and its name. */
function snapshot(block, timeoutMs) {
  return block.getByRole("table", { name: TABLE_NAME, exact: true }).evaluate(readInPage, undefined, { timeout: timeoutMs });
}

/** A pass as a reading. It fails here by `node:assert`, and is never read as an empty table, when
 *  its caption, its row headings, a row's count of cells or its paragraphs are not the table's: a
 *  caption whose first child does not read the table's name, body rows whose headings are not
 *  Parts, Containers and Order in that order, a row without four cells, more than one status
 *  paragraph, or a paragraph that is neither the note nor a weighed line. */
function reading(raw) {
  const seen = JSON.stringify(raw);
  assert.equal(raw.caption, TABLE_NAME, `The table's caption must read ${TABLE_NAME}; read ${seen}`);
  assert.deepEqual(raw.rows.map((row) => row.heading), ROW_HEADINGS, `Order totals must have the rows ${ROW_HEADINGS.join(", ")}; read ${seen}`);
  for (const row of raw.rows) assert.equal(row.cells.length, 4, `The ${row.heading} row must have four cells; read ${seen}`);
  assert.ok(raw.notes.length <= 1, `Order totals must have at most one status paragraph; read ${seen}`);
  assert.equal(raw.notes.length + raw.weighed.length, raw.paragraphs, `Every paragraph of Order totals must be the note or a weighed line; read ${seen}`);
  return {
    tag: raw.tag,
    rows: Object.fromEntries(raw.rows.map((row) => [row.heading, row.cells])),
    note: raw.notes[0] ?? null,
    weighed: raw.weighed,
  };
}

/** One reading of the block, as the header gives it. */
export async function readTotals(block) {
  return reading(await snapshot(block, 5000));
}

/**
 * Waits until every key of `expected` equals its reading, whole, and fails with the last reading.
 * `expected` holds any of `tag`, `rows`, `note` and `weighed`, and at least one. A thing that must
 * be gone is said the same way: `note: null`, `tag: null`, `weighed: []`.
 *
 * A read that gave no answer is never taken for an empty table, and does not end the wait: the
 * failure names why there was none, in `unreadReason`'s words. A reading of the wrong shape ends
 * the wait at once.
 */
export async function waitForTotals(block, expected, timeoutMs = 10000) {
  const keys = Object.keys(expected);
  assert.ok(keys.length > 0 && keys.every((key) => READING_KEYS.includes(key)),
    `waitForTotals takes at least one of ${READING_KEYS.join(", ")}; got ${JSON.stringify(keys)}`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // `totals` is a reading. `rejection` is set in its place when the pass gave no answer at all.
    const read = await snapshot(block, 1000).then((raw) => ({ totals: reading(raw) }), (rejection) => ({ rejection }));
    if ("totals" in read && keys.every((key) => isDeepStrictEqual(read.totals[key], expected[key]))) return;
    if (Date.now() > deadline) {
      assert.fail(`Timed out waiting for Order totals to read ${JSON.stringify(expected)}; `
        + `last read ${"rejection" in read ? `nothing (${unreadReason(read.rejection)})` : JSON.stringify(read.totals)}`);
    }
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
}
