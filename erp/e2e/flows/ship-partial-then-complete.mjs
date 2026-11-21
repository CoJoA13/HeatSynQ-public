// Flow 11 (Phase 4, Task 20): the ship ledger end to end (design spec §13.1). Keys a two-line
// order, ships part of it from /shipping/new (the Task 14b create page), watches the board flip
// to "Partially shipped", then ships the rest — deliberately over-shipping one line by 10 on the
// way, so the §5.7 save-with-warnings panel fires (warns, never blocks) — and watches the board
// flip to "Shipped". The first save ships short and leaves the order Partially shipped; the
// second ships the rest and the order becomes Shipped with no tick, because every line reached
// its ordered quantity (quantity corrections design §3.1). It ends by closing a line short: a
// second order ships under its ordered quantity with "close short" ticked and reads Shipped.
//
// Also carries the Cust Cont Id round-trip pin (Task 17's data-loss fix, adjudication B: the hub
// containers grid's whole-array replace silently blanked stored customerContainerId on every
// save until the grid composed the column — no vitest seam exists client-side, so THIS is the
// regression proof): a container is saved with a Cust Cont Id, then a second save touches ONLY
// its count, and after a full reload the stored id must still be there.
//
// Also the shipment's own tare each (the weights design §12): the form's box filled from the
// order's row and then typed over, so that Save shipment sends a figure the order's row does not
// hold, a typed figure through Save containers and a reload, a save that changes only the number
// of containers, a shipped container row that stays on its order row when the order's Containers
// are saved again (issue #493), and a kept row's box typed and saved after that order row is
// removed. The totals tables are read at each of these steps.
//
// Also #483 and #487 in a browser. The order hub's clean Save containers says "No unsaved
// changes". And the saved shipment is opened once with the page's and the grids' reads of the
// signed-in user held (Shell's reads made before its navigation shows go through): while the
// page's own read is held it shows "Loading…" and never its heading, and while the grids' own
// first reads are held the Containers grid's Save and the text beside its empty Add picker say
// "Checking access to this editor…" (`openShipmentHoldingItsReads`).
import assert from "node:assert/strict";
import { assertNeverVisible, waitForTitle, waitForValue } from "../lib/ui.mjs";
import { bounded } from "../lib/order-entry-workspace.mjs";
import { boardRow, createOrderViaUi, hubAnchor, startNewShipment, orderPanel, waitForShipmentPage, openOrderTab } from "../lib/orders.mjs";
import { SHIPMENT_TOTALS, totalsFor, waitForShipmentTotals } from "../lib/shipment-totals.mjs";
import { routeRequests } from "../route-keep-alive.mjs";

async function assertBoardStatus(page, ctx, orderNumber, statusText, absentText) {
  await page.goto(`${ctx.baseURL}/`);
  await page.getByRole("heading", { name: "Orders" }).waitFor({ state: "visible" });
  // #167a: the ORDER-NUMBER CELL, never "any cell holding these digits" — and this flow's own
  // order is the one whose Weight cell collided (e2e/lib/orders.mjs's `boardRow`).
  const row = await boardRow(page, orderNumber);
  await row.waitFor({ state: "visible", timeout: 10000 });
  await row.getByText(statusText, { exact: true }).waitFor({ state: "visible" });
  if (absentText) {
    await assertNeverVisible(
      row.getByText(absentText, { exact: true }),
      `board row for #${orderNumber} should show "${statusText}", not "${absentText}"`,
      500,
    );
  }
}

// The grey line above a Containers table that holds a kept row, whole (C7 of the design's §12.3).
const KEPT_SENTENCE = "Containers marked Kept are from earlier selections (the order-side rows were since corrected away). "
  + "Only their Tare each can be changed.";

/**
 * What this flow waits for the totals tables to read, step by step: the first shipment's net
 * weight in the order's one container row. That shipment has one order, so each reading is
 * waited for in the order's table and in the shipment's. tests/e2e-shipment-totals.test.ts holds
 * each reading to what the totals leaf gives for the same figures.
 */
export const EXPECTED_TOTALS = Object.freeze({
  // The form as Add order fills it: 1000 and 200 lb, 5 containers at 42.5.
  asAdded: { tag: null, cells: ["1,200.00", "212.50", "1,412.50"], note: null },
  // The form's Tare each typed over: 5 at 45.
  typedOver: { tag: null, cells: ["1,200.00", "225.00", "1,425.00"], note: null },
  // 600 and 0 lb typed, on the form and then on the saved shipment, 5 at 45 still.
  shipped: { tag: null, cells: ["600.00", "225.00", "825.00"], note: null },
  // 5 at 40: typed, then saved.
  typed: { tag: "Unsaved totals", cells: ["600.00", "200.00", "800.00"], note: null },
  saved: { tag: null, cells: ["600.00", "200.00", "800.00"], note: null },
  // 4 at 40, saved.
  fewer: { tag: null, cells: ["600.00", "160.00", "760.00"], note: null },
  // The kept row, 4 at 12.5: typed, then saved.
  keptTyped: { tag: "Unsaved totals", cells: ["600.00", "50.00", "650.00"], note: null },
  keptSaved: { tag: null, cells: ["600.00", "50.00", "650.00"], note: null },
});

/** The row of a panel's Containers table that holds the box of this spoken name. */
function containerRow(page, panel, boxName) {
  return panel.locator("tbody tr").filter({ has: page.getByLabel(boxName, { exact: true }) });
}

/** Presses the panel's Save containers and waits for the shipment's own save to be answered. */
async function saveShipmentContainers(page, panel, shipmentId) {
  const answered = page.waitForResponse((res) => {
    const path = new URL(res.url()).pathname;
    return path.startsWith(`/api/shippers/${shipmentId}/orders/`) && path.endsWith("/containers")
      && res.request().method() === "PUT";
  });
  await panel.getByRole("button", { name: "Save containers", exact: true }).click();
  assert.ok((await answered).ok(), "the shipment's Save containers must be accepted");
}

/** The draft-recovery notice's loading sentence, `CHECKING_ACCESS` (src/lib/draft-recovery-words.ts).
 *  While a saved shipment's grid has its own first read in flight, its Save carries it under an
 *  open page gate (`gridGate`), and so does the text beside its empty Add picker
 *  (`pickerEmptyReason`, both in src/lib/shipment-gates.ts; #483). */
const CHECKING_ACCESS = "Checking access to this editor…";

/**
 * Opens the saved shipment with its reads of /api/auth/me held, in two phases, after the
 * order-entry-workspace-print flow's hold of the order hub's permission read. Shell's own reads,
 * made before its navigation shows, go straight through, so the page mounts (Shell renders no page
 * until it has confirmed the session).
 *
 * 1. The page's own permission read (`usePermissions`) is held. With the page's reads of the
 *    shipment answered, the page shows "Loading…" and never its "Packing list" heading: it waits
 *    for its permissions too (`permissionsPending`, #483).
 * 2. Released, the page renders, and the grids make their own first reads, each of which reads
 *    /api/auth/me (`readBulkPermissions`). Those are held: the order's Containers grid is still
 *    loading, so its Save carries the loading sentence, and so does the text beside its Add
 *    picker, which has nothing to offer without the grid's read (#483).
 *
 * Then everything is released, and the caller's waits read the loaded page. Only reads are held,
 * and each is answered with the server's own response: nothing is written.
 */
async function openShipmentHoldingItsReads(page, baseURL, shipmentId, panel) {
  const authUrl = `${baseURL}/api/auth/me`;
  const shipmentPath = `/api/shippers/${shipmentId}`;
  const shellReady = page.getByRole("navigation").getByRole("link", { name: "Parts & processes", exact: true });
  const heading = page.getByRole("heading", { name: /^Packing list #\d+/ });
  // Whose read a held read is, taken as its handler starts. A grid's read can be made only once the
  // page has rendered, which is after the page's own read is answered, and the flow moves this on
  // before it answers that read.
  let phase = "page";
  let releasePage, releaseGrids, pageReadHeld, gridReadHeld;
  const pageGate = new Promise((resolve) => { releasePage = resolve; });
  const gridGate = new Promise((resolve) => { releaseGrids = resolve; });
  const pageHeld = new Promise((resolve) => { pageReadHeld = resolve; });
  const gridHeld = new Promise((resolve) => { gridReadHeld = resolve; });
  const handlers = [];
  const holdAuth = (route) => {
    const owner = phase;
    const task = (async () => {
      if (!(await shellReady.isVisible())) { await route.continue(); return; }
      // Fetched at once and kept as the answer, so no connection idles through the hold.
      const response = await route.fetch({ maxRetries: 1 });
      if (owner === "page") { pageReadHeld(); await pageGate; } else { gridReadHeld(); await gridGate; }
      await route.fulfill({ response });
    })().then(() => null, async (error) => { await route.abort().catch(() => {}); return error; });
    handlers.push(task);
    return task;
  };
  const shipmentReads = [];
  const noteShipmentRead = (request) => {
    if (request.method() === "GET" && new URL(request.url()).pathname === shipmentPath) shipmentReads.push(request);
  };
  // Retire the hub's document before the hold is armed, so none of its reads is taken for the page's.
  await page.goto("about:blank");
  const stopHoldAuth = await routeRequests(page, authUrl, holdAuth);
  page.on("request", noteShipmentRead);
  let finished = false;
  try {
    await page.goto(`${baseURL}/shipping/${shipmentId}`);
    await bounded(pageHeld, "the shipment page must read its permissions once Shell has confirmed the session");
    const answers = await bounded(Promise.all(shipmentReads.map((request) => request.response())),
      "the shipment page's reads of its shipment must be answered while its permission read is held");
    assert.ok(answers.length > 0, "the shipment page must read its shipment while its permission read is held");
    for (const answer of answers) assert.equal(answer?.status(), 200, "the shipment page's read of its shipment must succeed");
    await page.getByRole("main").getByText("Loading…", { exact: true }).waitFor({ state: "visible" });
    await assertNeverVisible(heading,
      "with its shipment read answered and its permission read held, the saved shipment page must stay on Loading… (#483)", 1500);
    phase = "grids";
    releasePage();
    await waitForShipmentPage(page);
    await bounded(gridHeld, "the shipment's grids must make their own first reads once the page has rendered");
    await waitForTitle(panel.getByRole("button", { name: "Save containers", exact: true }), CHECKING_ACCESS,
      "the Containers grid's Save while the grid's own first read is held");
    // The picker's row only: each grid's recovery notice above it says the same sentence.
    await panel.getByLabel("Add container", { exact: true }).locator("xpath=..")
      .getByText(CHECKING_ACCESS, { exact: true }).waitFor({ state: "visible" });
    releaseGrids();
    assert.deepEqual((await bounded(Promise.all(handlers), "the held reads must be answered")).filter(Boolean), [],
      "every held read must be answered with the server's own response");
    finished = true;
  } finally {
    releasePage();
    releaseGrids();
    // The handlers are joined before the route is removed. The route and the listener are removed
    // even if the join fails, and a failed join is reported only when nothing above failed first.
    try {
      await bounded(Promise.all(handlers), "the held reads must be let go");
    } catch (error) {
      if (finished) throw error;
    } finally {
      await stopHoldAuth();
      page.off("request", noteShipmentRead);
    }
  }
}

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;

  // --- The order: two lines, 100 of part A (1000 lb) and 40 of part B (200 lb). ---
  const order = await createOrderViaUi(page, ctx, {
    customerCode: fixtures.shipCustomerCode,
    lines: [
      { partNumber: fixtures.shipPartANumber, qty: 100 },
      { partNumber: fixtures.shipPartBNumber, qty: 40 },
    ],
  });
  await shot("order-created");

  // --- Cust Cont Id round-trip (the Task 17 pin) on the hub's containers grid (PR 2: on the
  // Parts & containers tab). ---
  await openOrderTab(page, "Parts & containers");
  await page.getByRole("button", { name: "Add container", exact: true }).click();
  await page.getByLabel("Container 1 type", { exact: true }).selectOption(fixtures.containerTypeId);
  await page.getByLabel("Container 1 count", { exact: true }).fill("4");
  await page.getByLabel("Container 1 customer container id", { exact: true }).fill("BIN-0007");
  // The order's row carries a tare each, for the new-shipment form below to fill its box from.
  await page.getByLabel("Container 1 tare each", { exact: true }).fill("42.5");
  let saved = page.waitForResponse((res) =>
    res.url().includes(`/api/orders/${order.id}/containers`) && res.request().method() === "PUT" && res.ok());
  await page.getByRole("button", { name: "Save containers", exact: true }).click();
  await saved;
  // Second save touches ONLY the count — the exact shape that used to blank the stored id.
  await page.getByLabel("Container 1 count", { exact: true }).fill("5");
  saved = page.waitForResponse((res) =>
    res.url().includes(`/api/orders/${order.id}/containers`) && res.request().method() === "PUT" && res.ok());
  await page.getByRole("button", { name: "Save containers", exact: true }).click();
  await saved;
  await page.reload();
  await page.getByRole("heading", { name: /^Order #\d+/ }).waitFor({ state: "visible", timeout: 15000 });
  await waitForValue(page.getByLabel("Container 1 count", { exact: true }), "5");
  await waitForValue(page.getByLabel("Container 1 customer container id", { exact: true }), "BIN-0007");
  await waitForValue(page.getByLabel("Container 1 tare each", { exact: true }), "42.5");
  await shot("cust-cont-id-preserved");

  // --- Shipment 1: partial. Prefill is the FULL remainder (nothing shipped yet); ship 60 of
  // line 1 and none of line 2, completing nothing. ---
  await startNewShipment(page, ctx, fixtures.shipCustomerId, [order]);
  const panel1 = orderPanel(page, `#${order.number}`);
  await waitForValue(panel1.getByLabel("Line 1 ship-now quantity", { exact: true }), "100");
  await waitForValue(panel1.getByLabel("Line 2 ship-now quantity", { exact: true }), "40");
  // The two ship-now net weight boxes are waited for before the tables that add them up.
  await waitForValue(panel1.getByLabel("Line 1 ship-now weight", { exact: true }), "1000");
  await waitForValue(panel1.getByLabel("Line 2 ship-now weight", { exact: true }), "200");
  // The form's container row is filled from the order's row, 5 at 42.5, and its Tare total and
  // both tables follow it. Nothing is saved yet, so no table is tagged.
  await waitForValue(panel1.getByLabel("Container 1 count", { exact: true }), "5");
  await waitForValue(panel1.getByLabel("Container 1 tare each", { exact: true }), "42.5");
  await containerRow(page, panel1, "Container 1 tare each").getByText("212.50", { exact: true }).waitFor({ state: "visible" });
  await waitForShipmentTotals(panel1, totalsFor(`#${order.number}`), EXPECTED_TOTALS.asAdded);
  await waitForShipmentTotals(page, SHIPMENT_TOTALS, EXPECTED_TOTALS.asAdded);
  // The form's box is typed over with 45, a figure the order's row does not hold. The row's Tare
  // total and both tables follow the box.
  await panel1.getByLabel("Container 1 tare each", { exact: true }).fill("45");
  await containerRow(page, panel1, "Container 1 tare each").getByText("225.00", { exact: true }).waitFor({ state: "visible" });
  await waitForShipmentTotals(panel1, totalsFor(`#${order.number}`), EXPECTED_TOTALS.typedOver);
  await waitForShipmentTotals(page, SHIPMENT_TOTALS, EXPECTED_TOTALS.typedOver);
  await panel1.getByLabel("Line 1 ship-now quantity", { exact: true }).fill("60");
  await panel1.getByLabel("Line 1 ship-now weight", { exact: true }).fill("600");
  await panel1.getByLabel("Line 2 ship-now quantity", { exact: true }).fill("0");
  await panel1.getByLabel("Line 2 ship-now weight", { exact: true }).fill("0");
  // The tables follow the ship-now net weight boxes as they are typed: 600 and 0.
  await waitForShipmentTotals(panel1, totalsFor(`#${order.number}`), EXPECTED_TOTALS.shipped);
  await waitForShipmentTotals(page, SHIPMENT_TOTALS, EXPECTED_TOTALS.shipped);
  await shot("new-shipment-partial");
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  // No warnings on this save, so the page navigates straight to the shipment. NEVER
  // waitForURL(/\/shipping\/[^/?]+$/) here — that also matches the literal /shipping/new still on
  // screen (the Phase 3 trap, spec §13); waitForShipmentPage waits for the packing-list badge.
  const shipment1 = await waitForShipmentPage(page);
  await page.getByRole("link", { name: `${order.number}-1`, exact: true }).waitFor({ state: "visible" });
  await shot("shipment-1-saved");

  // --- The shipment keeps its own tare each. The saved row holds the figure the form sent, 45,
  // where the order's row holds 42.5. A typed figure moves the row's Tare total and both tables,
  // tagged until it is saved, and is there after a reload. A second save that changes only the
  // number of containers leaves it. Each reload waits for the tag to go first, so the page is not
  // reloaded over an unsaved grid. ---
  const saved1 = orderPanel(page, `${order.number}-1`);
  const totals1 = totalsFor(`${order.number}-1`);
  const tare1 = saved1.getByLabel("Container 1 tare each", { exact: true });
  const count1 = saved1.getByLabel("Container 1 count", { exact: true });
  await waitForValue(tare1, "45");
  // The saved lines' weight boxes are waited for before the tables that add them up: 600 and 0,
  // as the form sent them.
  await waitForValue(saved1.getByLabel("Line 1 ship-now weight", { exact: true }), "600");
  await waitForValue(saved1.getByLabel("Line 2 ship-now weight", { exact: true }), "0");
  await waitForShipmentTotals(saved1, totals1, EXPECTED_TOTALS.shipped);
  await waitForShipmentTotals(page, SHIPMENT_TOTALS, EXPECTED_TOTALS.shipped);
  await tare1.fill("40");
  await containerRow(page, saved1, "Container 1 tare each").getByText("200.00", { exact: true }).waitFor({ state: "visible" });
  await waitForShipmentTotals(saved1, totals1, EXPECTED_TOTALS.typed);
  await waitForShipmentTotals(page, SHIPMENT_TOTALS, EXPECTED_TOTALS.typed);
  await saveShipmentContainers(page, saved1, shipment1.id);
  await waitForShipmentTotals(saved1, totals1, EXPECTED_TOTALS.saved);
  await page.reload();
  await waitForShipmentPage(page);
  await waitForValue(tare1, "40");
  await waitForShipmentTotals(page, SHIPMENT_TOTALS, EXPECTED_TOTALS.saved);
  await count1.fill("4");
  await saveShipmentContainers(page, saved1, shipment1.id);
  await waitForShipmentTotals(saved1, totals1, EXPECTED_TOTALS.fewer);
  await page.reload();
  await waitForShipmentPage(page);
  await waitForValue(count1, "4");
  await waitForValue(tare1, "40");
  await containerRow(page, saved1, "Container 1 tare each").getByText("160.00", { exact: true }).waitFor({ state: "visible" });
  await waitForShipmentTotals(page, SHIPMENT_TOTALS, EXPECTED_TOTALS.fewer);
  await shot("shipment-1-tare-each-kept");

  await assertBoardStatus(page, ctx, order.number, "· Partially shipped");
  await shot("board-partially-shipped");

  // --- Shipment 2: the rest. The prefill must equal the REMAINDER (design
  // §5.1: ordered − shipped, a default never a cap) — line 1 was 100 ordered / 60 shipped. Then
  // ship 50 anyway: over-shipping WARNS and still saves (§5.7). ---
  await startNewShipment(page, ctx, fixtures.shipCustomerId, [order]);
  const panel2 = orderPanel(page, `#${order.number}`);
  await waitForValue(panel2.getByLabel("Line 1 ship-now quantity", { exact: true }), "40");
  await waitForValue(panel2.getByLabel("Line 1 ship-now weight", { exact: true }), "400");
  await waitForValue(panel2.getByLabel("Line 2 ship-now quantity", { exact: true }), "40");
  // The form takes the order's own row again, 5 at 42.5. The 45 typed on the first form and the
  // 4 at 40 saved after it are shipment 1's alone.
  await waitForValue(panel2.getByLabel("Container 1 count", { exact: true }), "5");
  await waitForValue(panel2.getByLabel("Container 1 tare each", { exact: true }), "42.5");
  await panel2.getByLabel("Line 1 ship-now quantity", { exact: true }).fill("50");
  // Both rows now finish their lines, so each says so in place of the close-short box.
  await panel2.getByText("Completes line").nth(1).waitFor();
  assert.equal(await panel2.getByText("Completes line").count(), 2, "both rows must say they complete their line");
  await assertNeverVisible(panel2.getByLabel("Line 1 close short", { exact: true }),
    "a row that finishes its line by quantity must not offer the close-short box");
  await assertNeverVisible(panel2.getByLabel("Line 2 close short", { exact: true }),
    "line 2 (40 remaining, 40 typed) finishes its line and must not offer the close-short box");
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();

  // §5.7 rendered in a real browser: the save SUCCEEDED ("Packing List N saved.") and the
  // over-ship warning is listed on the amber panel rather than raced past by a navigate.
  await page.getByText(/^Packing List \d+ saved\.$/).waitFor({ state: "visible", timeout: 20000 });
  await page.getByText(/exceeds the remaining/).waitFor({ state: "visible" });
  await shot("save-warnings-overship");
  await page.getByRole("button", { name: "Go to shipment", exact: true }).click();
  const shipment2 = await waitForShipmentPage(page);
  assert.notEqual(shipment2.id, shipment1.id, "the second save must create a SECOND shipment");
  assert.ok(shipment2.shipperNumber > shipment1.shipperNumber,
    "packing-list numbers must be allocated in sequence");
  await page.getByRole("link", { name: `${order.number}-2`, exact: true }).waitFor({ state: "visible" });
  await shot("shipment-2-saved");

  // Both lines reach their ordered quantity -> SHIPPED (design §3.1)
  await assertBoardStatus(page, ctx, order.number, "· Shipped", "· Partially shipped");
  await shot("board-shipped");

  // --- The order's Containers saved again (issue #493). The save updates the order's row in
  // place, so each shipment's row stays on it: shipment 1 still draws Container 1 with its own
  // boxes, 4 at 40 (the number of containers and the tare each are the shipment's own, so the
  // order's 6 does not reach them), no row is kept, and Add container offers nothing, the order's
  // one row being on the shipment already. The shipment is opened with the page's and the grids'
  // reads of the signed-in user held first (Shell's reads made before its navigation shows go
  // through), so the page's and the grid's waits are seen before the loaded page is read (#483). ---
  // The hub's sections sit in tabs (the UX redesign's PR 2) and the saved order opens on Overview:
  // Containers is on Parts & containers, opened through `hubAnchor` on each visit.
  const orderContainers = page.locator("section#containers");
  await page.goto(`${ctx.baseURL}/orders/${order.id}`);
  await page.getByRole("heading", { name: /^Order #\d+/ }).waitFor({ state: "visible", timeout: 15000 });
  await hubAnchor(page, "containers");
  await waitForValue(page.getByLabel("Container 1 count", { exact: true }), "5");
  await page.getByLabel("Container 1 count", { exact: true }).fill("6");
  saved = page.waitForResponse((res) =>
    res.url().includes(`/api/orders/${order.id}/containers`) && res.request().method() === "PUT" && res.ok());
  await page.getByRole("button", { name: "Save containers", exact: true }).click();
  await saved;
  // The order's grid is clean again before the page is left: its Discard button shows only while
  // the grid is unsaved.
  await page.getByRole("button", { name: "Discard changes to containers", exact: true }).waitFor({ state: "hidden" });
  const linkedPanel = orderPanel(page, `${order.number}-1`);
  await openShipmentHoldingItsReads(page, ctx.baseURL, shipment1.id, linkedPanel);
  const linkedRow = containerRow(page, linkedPanel, "Container 1 tare each");
  await waitForValue(linkedPanel.getByLabel("Container 1 count", { exact: true }), "4");
  await waitForValue(linkedPanel.getByLabel("Container 1 tare each", { exact: true }), "40");
  for (const text of [fixtures.containerTypeName, "BIN-0007", "160.00"]) {
    await linkedRow.getByText(text, { exact: true }).waitFor({ state: "visible" });
  }
  await linkedRow.getByRole("button", { name: "Remove", exact: true }).waitFor({ state: "visible" });
  await assertNeverVisible(linkedPanel.getByLabel("Kept container 1 tare each", { exact: true }),
    "a shipment row whose order row was saved in place stays linked and is not kept", 500);
  await assertNeverVisible(linkedPanel.getByText(KEPT_SENTENCE, { exact: true }),
    "a panel with no kept container row must not explain kept rows", 500);
  const addContainer = linkedPanel.getByLabel("Add container", { exact: true });
  await addContainer.waitFor({ state: "visible" });
  assert.equal(await addContainer.isDisabled(), true,
    "the order's one container row is on the shipment, so Add container must offer nothing");
  assert.deepEqual(await addContainer.locator("option").allTextContents(), ["Add container…"],
    "Add container must list no order container row");
  await linkedPanel.getByText("Every order container is on this shipment", { exact: true }).waitFor({ state: "visible" });
  await waitForShipmentTotals(linkedPanel, totals1, EXPECTED_TOTALS.fewer);
  await waitForShipmentTotals(page, SHIPMENT_TOTALS, EXPECTED_TOTALS.fewer);
  await shot("shipment-1-container-still-linked");

  // --- A kept container row. Removing the row on the order's Containers and saving releases each
  // shipment's row from it, and the row is kept. A kept row is drawn in the table with its type,
  // Cust Cont Id and number of containers as text. Its Tare each can still be typed and saved, and
  // it counts in the totals. No later step reads this order's containers, so no row is added back. ---
  await page.goto(`${ctx.baseURL}/orders/${order.id}`);
  await page.getByRole("heading", { name: /^Order #\d+/ }).waitFor({ state: "visible", timeout: 15000 });
  await hubAnchor(page, "containers");
  await waitForValue(page.getByLabel("Container 1 count", { exact: true }), "6");
  await orderContainers.getByRole("button", { name: "Remove", exact: true }).click();
  await assertNeverVisible(page.getByLabel("Container 1 count", { exact: true }),
    "the order's one container row must be gone from the grid once removed", 500);
  saved = page.waitForResponse((res) =>
    res.url().includes(`/api/orders/${order.id}/containers`) && res.request().method() === "PUT" && res.ok());
  await page.getByRole("button", { name: "Save containers", exact: true }).click();
  await saved;
  await page.getByRole("button", { name: "Discard changes to containers", exact: true }).waitFor({ state: "hidden" });
  // #487: the grid is clean, so its greyed Save says there is nothing to save: `NO_UNSAVED_CHANGES`
  // (src/lib/waiting-titles.ts). Polled: while its save is in flight it reads "Saving…" and carries
  // no title.
  await waitForTitle(page.getByRole("button", { name: "Save containers", exact: true }), "No unsaved changes",
    "a clean Save containers on the order hub");
  await orderContainers.getByText("None.", { exact: true }).waitFor({ state: "visible" });
  await page.goto(`${ctx.baseURL}/shipping/${shipment1.id}`);
  await waitForShipmentPage(page);
  const keptPanel = orderPanel(page, `${order.number}-1`);
  const keptTare = keptPanel.getByLabel("Kept container 1 tare each", { exact: true });
  const keptRow = containerRow(page, keptPanel, "Kept container 1 tare each");
  await waitForValue(keptTare, "40");
  await keptPanel.getByText(KEPT_SENTENCE, { exact: true }).waitFor({ state: "visible" });
  for (const text of [fixtures.containerTypeName, "BIN-0007", "4", "160.00", "Kept"]) {
    await keptRow.getByText(text, { exact: true }).waitFor({ state: "visible" });
  }
  await assertNeverVisible(keptPanel.getByLabel("Container 1 tare each", { exact: true }),
    "a panel whose only container row is kept must draw no box named for a row that is not kept", 500);
  await waitForShipmentTotals(keptPanel, totals1, EXPECTED_TOTALS.fewer);
  await keptTare.fill("12.5");
  await keptRow.getByText("50.00", { exact: true }).waitFor({ state: "visible" });
  await waitForShipmentTotals(keptPanel, totals1, EXPECTED_TOTALS.keptTyped);
  await waitForShipmentTotals(page, SHIPMENT_TOTALS, EXPECTED_TOTALS.keptTyped);
  await saveShipmentContainers(page, keptPanel, shipment1.id);
  await waitForShipmentTotals(keptPanel, totals1, EXPECTED_TOTALS.keptSaved);
  await page.reload();
  await waitForShipmentPage(page);
  await waitForValue(keptTare, "12.5");
  await keptRow.getByText("Kept", { exact: true }).waitFor({ state: "visible" });
  await waitForShipmentTotals(page, SHIPMENT_TOTALS, EXPECTED_TOTALS.keptSaved);
  await shot("kept-container-tare-each-saved");

  // --- Close short end to end: a second order ships 12 of 20 and the person ticks close short.
  // Under its ordered quantity the row offers the box (no "Completes line"); the order then reads
  // Shipped though only 12 of 20 went, even after a mistyped full quantity hid the box on the way. ---
  const shortOrder = await createOrderViaUi(page, ctx, {
    customerCode: fixtures.shipCustomerCode,
    lines: [{ partNumber: fixtures.shipPartANumber, qty: 20 }],
  });
  await startNewShipment(page, ctx, fixtures.shipCustomerId, [shortOrder]);
  const shortPanel = orderPanel(page, `#${shortOrder.number}`);
  await waitForValue(shortPanel.getByLabel("Line 1 ship-now quantity", { exact: true }), "20");
  await shortPanel.getByLabel("Line 1 ship-now quantity", { exact: true }).fill("12");
  await assertNeverVisible(shortPanel.getByText("Completes line"),
    "a row shipping 12 of 20 does not finish its line and must not say so");
  const closeShort = shortPanel.getByLabel("Line 1 close short", { exact: true });
  await closeShort.check();
  // A mistyped quantity that completes the line hides the box but must not discard the tick: type
  // the full 20, see "Completes line" and no box, then type 12 back and find the box still checked.
  await shortPanel.getByLabel("Line 1 ship-now quantity", { exact: true }).fill("20");
  await shortPanel.getByText("Completes line").waitFor();
  await assertNeverVisible(closeShort, "a row typed to 20 of 20 finishes its line and must hide the close-short box");
  await shortPanel.getByLabel("Line 1 ship-now quantity", { exact: true }).fill("12");
  await closeShort.waitFor({ state: "visible" });
  assert.equal(await closeShort.isChecked(), true, "the close-short tick must survive a quantity that briefly completed the line");
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  await waitForShipmentPage(page);
  await assertBoardStatus(page, ctx, shortOrder.number, "· Shipped", "· Partially shipped");
  await shot("board-closed-short");
}
