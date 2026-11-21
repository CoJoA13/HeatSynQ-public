// The Net, Tare and Gross tables of both shipment screens, as a flow reads them (the weights
// design §12.2 and §12.3). A shipment screen holds several: one for each order on it and one for
// the whole shipment. So a flow says which table it means by the scope it looks in and the
// table's exact name. One reading and one wait, so no flow writes a second reader of the tables.
//
// A reading is the tag, the three figures and the note, taken in one pass inside the page, so no
// figure in it comes from a later render than another:
//
//   { tag, cells, note }
//
// `cells` is the body row's three cells in column order: Net, Tare, Gross. `tag` is what the
// caption holds after its first child, as text, or null when it holds nothing more. `note` is the
// status paragraph under the table, or null. The head row is not read.
//
// The table is looked for inside a block that carries the component's mark, and nowhere else in
// the scope. The note is read from that block's own children.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { unreadReason } from "./ui.mjs";

const BLOCK = "[data-shipment-totals]";
const READING_KEYS = ["tag", "cells", "note"];

/** The caption and spoken name of the whole shipment's table, on both shipment screens. */
export const SHIPMENT_TOTALS = "Shipment totals";

/** The caption and spoken name of one order's table. `label` is the text of the order panel's own
 *  link: "#1031" on the new-shipment form, "1031-1" on a saved shipment. */
export const totalsFor = (label) => `Totals for ${label}`;

/** Runs inside the page, on the table element. It names nothing outside itself: the browser gets
 *  its source and nothing of this module, so the block's mark is written here a second time. The
 *  table was found inside a marked block, so `closest` finds that block. Runs of white space read
 *  as one space. */
function readInPage(table) {
  const text = (element) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();
  const captionParts = [...(table.caption?.children ?? [])].map(text);
  const block = table.closest("[data-shipment-totals]");
  return {
    caption: captionParts[0] ?? null,
    tag: captionParts.length > 1 ? captionParts.slice(1).join(" ") : null,
    rows: [...table.tBodies].flatMap((body) => [...body.rows]).map((row) => [...row.querySelectorAll("td")].map(text)),
    notes: [...block.children].filter((child) => child.getAttribute("role") === "status").map(text),
  };
}

/** One pass over the table named `name` in `scope`: a page, or the locator of an order's panel.
 *  Rejects, as a locator does, while no marked block in the scope holds a table of that role and
 *  that exact name, and when more than one does. */
function snapshot(scope, name, timeoutMs) {
  return scope.locator(BLOCK).getByRole("table", { name, exact: true }).evaluate(readInPage, undefined, { timeout: timeoutMs });
}

/** A pass as a reading. It fails here by `node:assert`, and is never read as an empty table, when
 *  the pass is not the table's shape: a caption whose first child does not read `name`, a body
 *  that is not one row, a row that has not three cells, or more than one status paragraph. */
function reading(raw, name) {
  const seen = JSON.stringify(raw);
  assert.equal(raw.caption, name, `The table's caption must read ${name}; read ${seen}`);
  assert.equal(raw.rows.length, 1, `${name} must have one body row; read ${seen}`);
  assert.equal(raw.rows[0].length, 3, `The row of ${name} must have three cells; read ${seen}`);
  assert.ok(raw.notes.length <= 1, `${name} must have at most one status paragraph; read ${seen}`);
  return { tag: raw.tag, cells: raw.rows[0], note: raw.notes[0] ?? null };
}

/** One reading of the table named `name` in `scope`, as the header gives it. */
export async function readShipmentTotals(scope, name) {
  return reading(await snapshot(scope, name, 5000), name);
}

/**
 * Waits until every key of `expected` equals its reading, whole, and fails with the last reading.
 * `expected` holds any of `tag`, `cells` and `note`, and at least one. A thing that must be gone
 * is said the same way: `tag: null`, `note: null`.
 *
 * A read that gave no answer is never taken for an empty table, and does not end the wait: the
 * failure names why there was none, in `unreadReason`'s words. A reading of the wrong shape ends
 * the wait at once.
 */
export async function waitForShipmentTotals(scope, name, expected, timeoutMs = 10000) {
  const keys = Object.keys(expected);
  assert.ok(keys.length > 0 && keys.every((key) => READING_KEYS.includes(key)),
    `waitForShipmentTotals takes at least one of ${READING_KEYS.join(", ")}; got ${JSON.stringify(keys)}`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // `totals` is a reading. `rejection` is set in its place when the pass gave no answer at all.
    const read = await snapshot(scope, name, 1000).then((raw) => ({ totals: reading(raw, name) }), (rejection) => ({ rejection }));
    if ("totals" in read && keys.every((key) => isDeepStrictEqual(read.totals[key], expected[key]))) return;
    if (Date.now() > deadline) {
      assert.fail(`Timed out waiting for ${name} to read ${JSON.stringify(expected)}; `
        + `last read ${"rejection" in read ? `nothing (${unreadReason(read.rejection)})` : JSON.stringify(read.totals)}`);
    }
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
}
