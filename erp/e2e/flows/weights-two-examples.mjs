// The owner's two examples, keyed as an operator keys them (the weights design §14.2, and
// tables A and B of §14.3).
//
// For each example in turn, the bins and then the skids, this flow keys one order in order entry
// for the shipping fixture customer: one part line and the example's container rows, all before
// the first save. It types no Tare each, no Scale gross and no Cust Cont Id. The bins row's Tare
// each is the figure its container type remembers. It reads order entry while Parts & containers
// still shows, saves, reads the saved order, and prints the traveler once with the summary's own
// button.
//
// Then the shipment side. A shipment is started for that order alone and read on the
// new-shipment form, then saved and read again: the ship-now quantity, each container row, and
// Net, Tare and Gross in the order's table and in the shipment's. The shipping ticket and the
// bill of lading are then each printed once with the page's own button. Nothing is typed on a
// shipment: no quantity, no Tare each, no Package count, no carrier and no address. The
// certifications box stays ticked, as the page has it, and neither order has a certification.
//
// A screen's text is waited for until it reads what `expectedReadings` holds for that place.
// Three readings are made once, each after a wait: a Type list's chosen text, how many links the
// saved order's top line holds, and how many boxes are named for a shipment's container row. Each
// page is read from the stored document. The print's own answer names it, and
// e2e/lib/printed-page.mjs reads its bytes once and gives the whole lines the page draws, in the
// order it draws them. A page is held by runs of whole lines, by its whole list of weight lines
// and by its whole list of piece lines. The two lists are what hold that something did not print.
// No screen is compared with a page here. tests/e2e-two-examples.test.ts holds the table to the
// program's own leaves and to pages the real builders print, and holds the rules that set a page
// against a screen: the ticket's totals text for text, the traveler and the bill of lading by
// amount.
//
// ONE ambient claim: each page prints through its type's default template as the database holds
// it. On a database whose default traveler, shipping ticket or bill of lading template was
// edited, this flow can fail though nothing is wrong. A run that is not on the page fails with
// every line the page drew, and a list that differs fails with that list as the page drew it.
// `npm run db:reset` clears it. The pre-flight does not look for it.
//
// It leaves two shipped orders, two shipments and six stored pages under the shipping fixture
// customer. The run's clean-up removes them. Nothing here is invoiced or corrected.
import { openRecordTab } from "../lib/record-tabs.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { unreadReason, waitForEnabled, waitForValue } from "../lib/ui.mjs";
import { createOrderViaUi, hubAnchor, orderPanel, startNewShipment, waitForShipmentPage } from "../lib/orders.mjs";
import { orderTotalsBlock, waitForTotals } from "../lib/order-totals.mjs";
import { SHIPMENT_TOTALS, totalsFor, waitForShipmentTotals } from "../lib/shipment-totals.mjs";
import { assertRun, piecesLines, printedPages, storedPdf, weightLines } from "../lib/printed-page.mjs";

/** What each example keys. A type is picked by ctx.fixtures[typeIdKey] and a part by ctx.fixtures[partNumberKey]. */
export const EXAMPLES = Object.freeze({
  bins: Object.freeze({
    partNumberKey: "binsPartNumber", partNumber: "E2E-BINS-PART", partName: "E2E Bins Part", qty: 192, eachLb: 21.5,
    containers: Object.freeze([
      Object.freeze({ typeIdKey: "binTypeId", typeName: "E2E Bin", count: 14, pieces: null, typeTareEach: 310 }),
    ]),
  }),
  skids: Object.freeze({
    partNumberKey: "shipPartANumber", partNumber: "E2E-SHIP-A", partName: "E2E Ship Part A", qty: 30, eachLb: 10,
    containers: Object.freeze([
      Object.freeze({ typeIdKey: "skidTypeId", typeName: "E2E Skid", count: 3, pieces: 15, typeTareEach: null }),
      Object.freeze({ typeIdKey: "wireBasketTypeId", typeName: "E2E Wire Basket", count: 1, pieces: 15, typeTareEach: null }),
    ]),
  }),
});

// What each example reads on the order side: rows A1, A2, B1 and B2 of the design's §14.3, as
// §14.2's table holds each, in each place's own form. `rows`, `totals` and `strip` are the
// screens': order entry and the saved order read the same rows and the same table. `traveler` is
// the stored page: `totals` is the figure after each word of its Order totals lines, or null
// where the word prints alone. Only `orderReadings` reads this table, and it hands out copies.
const ORDER_SIDE = {
  bins: {
    quantity: "192",
    rows: [{ type: "E2E Bin", count: "14", pieces: "", tareEach: "310", tareTotal: "4,340.00" }],
    totals: {
      tag: null,
      rows: {
        Parts: ["192", "4,128.00", "", ""],
        Containers: ["Not entered", "", "4,340.00", ""],
        Order: ["", "4,128.00", "4,340.00", "8,468.00"],
      },
      note: null,
      weighed: [],
    },
    strip: "Parts 192 pcs · Container pieces not entered · Loads 192 · Serials not entered",
    traveler: {
      pages: 1,
      runs: [
        ["Net weight", "192"],
        ["21.5 lb", "4,128 lb", "Order Quantity"],
        ["Order totals", "192", "192", "4,128 lb", "E2E Bin", "14", "4,340 lb", "310 lb each",
          "Net 4,128 lb", "Tare 4,340 lb", "Gross 8,468 lb", "Process:"],
      ],
      weights: ["21.5 lb", "4,128 lb", "4,128 lb", "4,340 lb", "310 lb each"],
      pieces: [],
      totals: { net: "4,128 lb", tare: "4,340 lb", gross: "8,468 lb" },
    },
  },
  skids: {
    quantity: "30",
    rows: [
      { type: "E2E Skid", count: "3", pieces: "15", tareEach: "", tareTotal: "—" },
      { type: "E2E Wire Basket", count: "1", pieces: "15", tareEach: "", tareTotal: "—" },
    ],
    totals: {
      tag: null,
      rows: {
        Parts: ["30", "300.00", "", ""],
        Containers: ["30", "", "Incomplete", ""],
        Order: ["", "300.00", "Incomplete", "Not available"],
      },
      note: "2 rows have no Tare each",
      weighed: [],
    },
    strip: "Parts 30 pcs · Container pieces 30 · Loads 30 · Serials not entered",
    traveler: {
      pages: 1,
      runs: [
        ["Net weight", "30"],
        ["10 lb", "300 lb", "Order Quantity"],
        ["Order totals", "30", "30", "300 lb", "E2E Skid", "15 pcs", "3", "Net 300 lb", "Tare", "Gross",
          "E2E Wire Basket", "15 pcs", "1", "Process:"],
      ],
      weights: ["10 lb", "300 lb", "300 lb"],
      pieces: ["15 pcs", "15 pcs"],
      totals: { net: "300 lb", tare: null, gross: null },
    },
  },
};

/** The order side's readings for one example: order entry, the saved order and the traveler. No
 *  reading here holds the order's number. Every object in the answer is a copy of its own. */
function orderReadings(example) {
  const { quantity, rows, totals, strip, traveler } = structuredClone(ORDER_SIDE[example]);
  return {
    entry: { quantity, rows, totals },
    saved: { rows: structuredClone(rows), totals: structuredClone(totals), strip },
    traveler,
  };
}

// Rows A3 to A5 and B3 to B5 of the weights design's §14.3, as §14.2's table holds each, with the
// order's number left out. A screen's texts are in that screen's form and a page's lines in that
// page's. A run is whole printed lines in the order the page draws them. `totalsRun` is the
// ticket's totals as far as the last row that prints: `shipmentReadings` ends it with the strip's
// first line, which holds the order's number.
const SHIPMENT_SIDE = {
  bins: {
    quantity: "192",
    rows: [{ type: "E2E Bin", count: "14", tareEach: "310", tareTotal: "4,340.00" }],
    totals: { tag: null, cells: ["4,128.00", "4,340.00", "8,468.00"], note: null },
    ticket: {
      runs: [
        ["Net weight", "192"],
        ["4,128 lb", "Container Type"],
        ["Cust Cont Id", "E2E Bin", "14", "4,340 lb", "310 lb each"],
      ],
      totalsRun: ["Quantity Shipped:", "192", "Net weight:", "4,128.00 lb", "Tare:", "4,340.00 lb", "Gross weight:", "8,468.00 lb"],
      stripRun: ["Quantity Shipped:", "192.00", "Net weight:", "4,128.00 lb", "Received By: _______________________"],
      weights: ["4,128 lb", "4,340 lb", "310 lb each", "4,128.00 lb", "4,340.00 lb", "8,468.00 lb", "4,128.00 lb"],
    },
    bol: { run: ["Check Column", "14", "8,468 lb", "Gross weight"], weights: ["8,468 lb"] },
  },
  skids: {
    quantity: "30",
    rows: [
      { type: "E2E Skid", count: "3", tareEach: "", tareTotal: "—" },
      { type: "E2E Wire Basket", count: "1", tareEach: "", tareTotal: "—" },
    ],
    totals: { tag: null, cells: ["300.00", "Incomplete", "Not available"], note: "2 rows have no Tare each" },
    ticket: {
      runs: [
        ["Net weight", "30"],
        ["300 lb", "Container Type"],
        ["Cust Cont Id", "E2E Skid", "3", "E2E Wire Basket", "1"],
      ],
      totalsRun: ["Quantity Shipped:", "30", "Net weight:", "300.00 lb"],
      stripRun: ["Quantity Shipped:", "30.00", "Net weight:", "300.00 lb", "Received By: _______________________"],
      weights: ["300 lb", "300.00 lb", "300.00 lb"],
    },
    bol: { run: ["Check Column", "4", "300 lb", "Net weight"], weights: ["300 lb"] },
  },
};

/**
 * The shipment side of what the flow reads for one example: the new shipment, the saved shipment,
 * the shipping ticket and the bill of lading. The order's number is in five strings and no other:
 * the two panels' link texts, the two order tables' names, and the last line of the ticket's
 * totals run. A ticket's `totals` and a bill of lading's `packages`, `weight` and `word` are read
 * out of the runs above them, so neither can say something its run does not. Every call hands
 * back objects of its own.
 */
function shipmentReadings(example, orderNumber) {
  const { quantity, rows, totals, ticket, bol } = structuredClone(SHIPMENT_SIDE[example]);
  const screen = (panel) => structuredClone({ panel, quantity, rows, orderTable: totalsFor(panel), totals });
  const printedAfter = (label) => (ticket.totalsRun.includes(label) ? ticket.totalsRun[ticket.totalsRun.indexOf(label) + 1] : null);
  const [, packages, weight, word] = bol.run;
  return {
    newShipment: screen(`#${orderNumber}`),
    savedShipment: screen(`${orderNumber}-1`),
    ticket: {
      pages: 1,
      runs: [...ticket.runs, [...ticket.totalsRun, `Order No.: ${orderNumber}`], ticket.stripRun],
      weights: ticket.weights,
      pieces: [],
      totals: { net: printedAfter("Net weight:"), tare: printedAfter("Tare:"), gross: printedAfter("Gross weight:") },
    },
    bol: { pages: 1, runs: [bol.run], weights: bol.weights, pieces: [], packages, weight, word },
  };
}

/** What the flow reads for one example. `example` is "bins" or "skids". `orderNumber` is a whole number above 0, or the call fails by node:assert. A fresh object each call. */
export function expectedReadings(example, orderNumber) {
  assert.ok(Object.hasOwn(EXAMPLES, example), `expectedReadings takes "bins" or "skids"; got ${JSON.stringify(example)}`);
  assert.ok(Number.isInteger(orderNumber) && orderNumber > 0, `expectedReadings takes the order's number; got ${JSON.stringify(orderNumber)}`);
  return { ...orderReadings(example), ...shipmentReadings(example, orderNumber) };
}

// The At a glance card's print control on an order with one load. Both examples' parts have no
// load limit, so each order is one load.
const PRINT_TRAVELER = "Print 1 traveler";

/** Runs the readings of one place. A reading that fails by node:assert fails again with `where`,
 *  the example and the place, before its own words. Any other error passes through as it is. */
async function at(where, readings) {
  try {
    return await readings();
  } catch (error) {
    if (error?.code !== "ERR_ASSERTION") throw error;
    assert.fail(`${where}: ${error.message}`);
  }
}

/** Polls `locator`'s text until it reads `expected`, with each run of white space read as one
 *  space. Fails with `what` and the text it last read. A read that gave no text is never taken for
 *  an empty one and does not end the wait: the failure says why there was none. */
async function waitForText(locator, expected, what, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // `text` is what was read. `rejection` is set, and `text` left undefined, when the read gave
    // no answer at all.
    const read = await locator.textContent({ timeout: 1000 }).then(
      (text) => ({ text: text === null ? null : text.replace(/\s+/g, " ").trim() }),
      (rejection) => ({ text: undefined, rejection }));
    if (!("rejection" in read) && read.text === expected) return;
    if (Date.now() > deadline) {
      assert.fail(`Timed out waiting for ${what} to read ${JSON.stringify(expected)}; `
        + `last read ${"rejection" in read ? `nothing (${unreadReason(read.rejection)})` : JSON.stringify(read.text)}`);
    }
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
}

/** Closes whichever other tabs the browser reports. Waits for none. */
async function closeOtherTabs(page) {
  for (const other of page.context().pages()) {
    if (other !== page) await other.close().catch(() => {});
  }
}

/**
 * Presses a print control and reads the stored page it made. One Promise.all of the wait for the print's answer
 * (`isPrint(response)`) and the click; the answer must be ok and carry x-document-id; that id's link
 * (`a[href="/api/documents/<id>"]`) must show in `documents`; the bytes come from storedPdf and are written to
 * `path.join(dir, file)` before anything is held; other tabs are closed; the pages come from printedPages.
 */
async function printAndRead(page, ctx, { button, isPrint, documents, dir, file, pages, what }) {
  const said = (error) => (error instanceof Error ? error.message : String(error));
  const [answer] = await Promise.all([page.waitForResponse(isPrint, { timeout: 30000 }), button.click()])
    .catch((error) => assert.fail(`${what}: pressing the print control brought no answer to read (${said(error)})`));
  assert.ok(answer.ok(), `${what}: the print must be answered ok; it was answered ${answer.status()}`);
  const documentId = answer.headers()["x-document-id"];
  assert.ok(documentId, `${what}: the print's answer must name the stored document it made`);
  await documents.locator(`a[href="/api/documents/${documentId}"]`).waitFor({ state: "visible", timeout: 20000 })
    .catch((error) => assert.fail(`${what}: the stored document's link did not show in the Documents list (${said(error)})`));
  const bytes = await storedPdf(page, ctx.baseURL, documentId, what);
  await fs.writeFile(path.join(dir, file), bytes);
  await closeOtherTabs(page);
  return printedPages(bytes, { pages, what });
}

/** The chosen option's text of a Type list. */
async function typeText(select) {
  return select.evaluate((element) => element.selectedOptions[0]?.textContent ?? null);
}

/** Polls the Tare total beside a Tare each box of either order screen until it reads `expected`: the paragraph in the element that follows the label holding `box`. Fails with what it last read. */
async function waitForTareTotal(box, expected, timeoutMs = 5000) {
  const total = box.locator("xpath=ancestor::label[1]/following-sibling::*[1]").locator("p");
  await waitForText(total, expected, "the Tare total", timeoutMs);
}

/** Polls the saved order's top line until it reads `expected`, whole, as hub-line-corrections' local function of the same name does. */
async function waitForStrip(strip, expected, timeoutMs = 5000) {
  await waitForText(strip, expected, "the top line", timeoutMs);
}

/** One example's order side. Resolves with the saved order. */
async function orderSide(page, shot, ctx, example) {
  const { fixtures } = ctx;
  const keyed = EXAMPLES[example];
  // Each container row of an order screen: the Type list, the three boxes and the Tare total. The
  // Type list is waited for by the id the row was keyed with, because it shows the type's name
  // only once the screen's own read of the container types has landed.
  const holdRows = async (scope, rows) => {
    for (const [index, row] of rows.entries()) {
      const box = (name) => scope.getByLabel(`Container ${index + 1} ${name}`, { exact: true });
      await waitForValue(box("type"), fixtures[keyed.containers[index].typeIdKey], 15000);
      const shown = await typeText(box("type"));
      assert.equal(shown, row.type, `row ${index + 1}'s Type list must show ${JSON.stringify(row.type)}; it shows ${JSON.stringify(shown)}`);
      await waitForValue(box("count"), row.count);
      await waitForValue(box("pieces"), row.pieces);
      await waitForValue(box("tare each"), row.tareEach);
      await waitForTareTotal(box("tare each"), row.tareTotal);
    }
  };

  const order = await createOrderViaUi(page, ctx, {
    customerCode: fixtures.shipCustomerCode,
    lines: [{ partNumber: fixtures[keyed.partNumberKey], qty: keyed.qty }],
    containers: keyed.containers.map((row) => ({ typeId: fixtures[row.typeIdKey], count: row.count, pieces: row.pieces })),
    beforeSave: async () => {
      const { entry } = orderReadings(example);
      await at(`${example} example, order entry`, async () => {
        await waitForValue(page.getByLabel("Line 1 quantity", { exact: true }), entry.quantity);
        await holdRows(page, entry.rows);
        await waitForTotals(orderTotalsBlock(page), entry.totals);
      });
      await shot(`${example}-order-entry`);
    },
  });

  const expected = expectedReadings(example, order.number);
  // The hub's sections sit in tabs (the UX redesign's PR 2): the card is on every tab, the
  // Containers section on Parts & containers and the Documents list on Loads & travelers, each
  // opened through `hubAnchor` before it is read.
  const summary = page.getByRole("region", { name: "At a glance" });
  await at(`${example} example, saved order`, async () => {
    const strip = summary.getByRole("group", { name: "Order quantities", exact: true });
    await waitForStrip(strip, expected.saved.strip, 15000);
    // Only a link is drawn amber in the top line, so no link is what holds that nothing is amber.
    const links = await strip.getByRole("link").count();
    assert.equal(links, 0, `no figure of the top line may be a link; ${links} of them are`);
    const containers = await hubAnchor(page, "containers");
    await holdRows(containers, expected.saved.rows);
    await waitForTotals(orderTotalsBlock(containers), expected.saved.totals);
  });
  const dir = path.dirname(await shot(`${example}-saved-order`));

  const what = `${example} example, traveler`;
  const printAll = summary.getByRole("button", { name: PRINT_TRAVELER, exact: true });
  await waitForEnabled(printAll, `${what}: the card's ${PRINT_TRAVELER}`);
  const travelerPath = `/api/orders/${order.id}/traveler`;
  const [lines] = await printAndRead(page, ctx, {
    button: printAll,
    isPrint: (response) => new URL(response.url()).pathname === travelerPath && response.request().method() === "POST",
    documents: await hubAnchor(page, "documents"),
    dir,
    file: `${example}-traveler.pdf`,
    pages: expected.traveler.pages,
    what,
  });
  for (const run of expected.traveler.runs) assertRun(lines, run, what);
  assert.deepEqual(weightLines(lines), expected.traveler.weights,
    `${what}: the page's weight lines must read ${JSON.stringify(expected.traveler.weights)}; it drew ${JSON.stringify(weightLines(lines))}`);
  assert.deepEqual(piecesLines(lines), expected.traveler.pieces,
    `${what}: the page's piece lines must read ${JSON.stringify(expected.traveler.pieces)}; it drew ${JSON.stringify(piecesLines(lines))}`);
  return order;
}

/**
 * The cells' texts, in order, of the one table row in `panel` that holds the box named `boxName`:
 * on both shipment screens the first is the type's name and the fifth the Tare total. A cell that
 * holds a box reads as an empty text. An empty list while no row holds the box. Fails when more
 * than one row does.
 */
async function shipmentRowCells(panel, boxName) {
  const rows = panel.locator("tbody tr").filter({ has: panel.page().getByLabel(boxName, { exact: true }) });
  const found = await rows.count();
  assert.ok(found <= 1, `${found} table rows hold a box named ${boxName}; one expected`);
  if (found === 0) return [];
  return (await rows.locator("td").allTextContents()).map((text) => text.replace(/\s+/g, " ").trim());
}

/**
 * One example's shipment side. A shipment for that order alone is started and read, saved and read
 * again, and its shipping ticket and bill of lading are each printed once with the page's own
 * button and read from the stored page. Nothing is typed on either screen: no quantity, no Tare
 * each, no Package count, no carrier and no address, and the certifications box stays as it is.
 */
async function shipmentSide(page, shot, ctx, example, order) {
  const expected = expectedReadings(example, order.number);

  // One shipment screen held to its reading: the ship-now quantity, each container row, and the
  // same three cells in the order's table and in the shipment's. `at` puts the example and the
  // place before a failed wait's own words.
  const holdScreen = async (reading, place) => {
    const where = `${example} example, ${place}`;
    const panel = orderPanel(page, reading.panel);
    await at(`${where}, the ship-now quantity`,
      () => waitForValue(panel.getByLabel("Line 1 ship-now quantity", { exact: true }), reading.quantity));
    for (const [index, row] of reading.rows.entries()) {
      const name = `Container ${index + 1}`;
      await at(`${where}, ${name}, Containers`, () => waitForValue(panel.getByLabel(`${name} count`, { exact: true }), row.count));
      await at(`${where}, ${name}, Tare each`, () => waitForValue(panel.getByLabel(`${name} tare each`, { exact: true }), row.tareEach));
      // The type and the Tare total have no spoken name, so each is found by its place: the first
      // and the fifth cell of the row that holds the Tare each box.
      const deadline = Date.now() + 10000;
      for (;;) {
        const cells = await at(`${where}, ${name}`, () => shipmentRowCells(panel, `${name} tare each`));
        if (cells[0] === row.type && cells[4] === row.tareTotal) break;
        if (Date.now() > deadline) {
          assert.fail(`${where}, ${name}: the row's first cell must read ${JSON.stringify(row.type)} and its fifth `
            + `${JSON.stringify(row.tareTotal)}; its cells read ${JSON.stringify(cells)}`);
        }
        await new Promise((resolve) => { setTimeout(resolve, 100); });
      }
      const boxes = await panel.getByLabel(new RegExp(`^${name} `)).count();
      assert.equal(boxes, 2, `${where}, ${name}: a shipment's container row has two boxes, Containers and Tare each, `
        + `and no Pieces box; ${boxes} boxes are named for it`);
    }
    await at(`${where}, the order's table`, () => waitForShipmentTotals(panel, reading.orderTable, reading.totals));
    await at(`${where}, the shipment's table`, () => waitForShipmentTotals(page, SHIPMENT_TOTALS, reading.totals));
  };

  await startNewShipment(page, ctx, ctx.fixtures.shipCustomerId, [order]);
  await holdScreen(expected.newShipment, "the new shipment");
  await shot(`${example}-new-shipment`);

  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  const shipment = await waitForShipmentPage(page);
  await holdScreen(expected.savedShipment, "the saved shipment");
  const dir = path.dirname(await shot(`${example}-saved-shipment`));

  // The stored rows sit on the Documents tab (PR 4); the print buttons are the header's.
  await openRecordTab(page, "Documents");
  const documents = page.locator("section").filter({ has: page.getByRole("heading", { name: "Documents", exact: true }) });
  const printPath = `/api/shippers/${shipment.id}/print`;
  for (const [key, buttonName, pageName] of [["ticket", "Print shipping ticket", "the shipping ticket"], ["bol", "Print BOL", "the bill of lading"]]) {
    const what = `${example} example, ${pageName}`;
    const button = page.getByRole("button", { name: buttonName, exact: true });
    await waitForEnabled(button, `${what}: the button ${buttonName}`);
    const [lines] = await printAndRead(page, ctx, {
      button,
      isPrint: (response) => {
        const url = new URL(response.url());
        return url.pathname === printPath && url.searchParams.get("doc") === key && response.request().method() === "POST";
      },
      documents, dir, file: `${example}-${key}.pdf`, pages: expected[key].pages, what,
    });
    for (const run of expected[key].runs) assertRun(lines, run, what);
    const weights = weightLines(lines);
    assert.deepEqual(weights, expected[key].weights,
      `${what}: the page's weight lines must be ${JSON.stringify(expected[key].weights)}; it drew ${JSON.stringify(weights)}`);
    const pieces = piecesLines(lines);
    assert.deepEqual(pieces, expected[key].pieces,
      `${what}: the page's piece lines must be ${JSON.stringify(expected[key].pieces)}; it drew ${JSON.stringify(pieces)}`);
  }
}

export async function run(page, shot, ctx) {
  for (const example of Object.keys(EXAMPLES)) {
    const order = await orderSide(page, shot, ctx, example);
    await shipmentSide(page, shot, ctx, example, order);
  }
}
