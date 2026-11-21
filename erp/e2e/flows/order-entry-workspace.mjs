import assert from "node:assert/strict";
import { entryFixture, startEntry, entryTab, waitPlan, saveEntry, readJson, loadsOnly, archiveEvidence, ownedOrders, keyboardFill, openHubTabSettled } from "../lib/order-entry-workspace.mjs";
import { waitForValue } from "../lib/ui.mjs";
import { hubAnchor, hubTabLabel } from "../lib/orders.mjs";
import { orderTotalsBlock, pounds, waitForTotals } from "../lib/order-totals.mjs";

/** Opens the saved order's hub tab `label` once the hub has consumed its automatic-print query
 *  (`print`, `printIntent`). The hub's sections sit in tabs (the UX redesign's PR 2), every panel
 *  mounted and the inactive ones hidden, and the saved order opens on Overview; `archiveEvidence`
 *  waits on the Documents list, which is on Loads & travelers. A tab click rewrites the address
 *  from `window.location.search`, as the query's own removal does, and the later rewrite wins: a
 *  click in between could put the query back, and the next reload would print again. Bounded: a
 *  query never consumed is left for the flow's own checks to report. */

// The weighed order this flow keys (the weights design §10.5): 30 pieces, in 6 containers that
// weigh 10 lb each when empty, on a scale that reads 3,997 lb. The container row's Pieces is the
// parts' 30 by the time these figures are read.
const WEIGHED = { pieces: 30, containers: 6, tareEachLb: 10, scaleGrossLb: 3997 };

/**
 * What the order totals read for that order: the table's three rows, the two weighed lines under
 * it, and the last figure of the saved order's top line. Worked out here from what this flow keys
 * and not by the page's own rule. `eachLb` is the part's each weight.
 *
 * Both differences are worded "over". A part whose each weight puts the scale at or under the
 * lines' weight, or the implied pieces at or under the parts', fails here and not at a wait.
 */
export function weighedOrderFigures(eachLb) {
  const net = WEIGHED.pieces * eachLb;
  const tare = WEIGHED.containers * WEIGHED.tareEachLb;
  const weighedNet = WEIGHED.scaleGrossLb - tare;
  const implied = Math.round(weighedNet / eachLb);
  assert.ok(weighedNet > net && implied > WEIGHED.pieces, "This flow's figures must weigh over, in pounds and in pieces");
  const over = `${pounds.format(weighedNet - net)} lb over`;
  return {
    rows: {
      Parts: [String(WEIGHED.pieces), pounds.format(net), "", ""],
      Containers: [String(WEIGHED.pieces), "", pounds.format(tare), ""],
      Order: ["", pounds.format(net), pounds.format(tare), pounds.format(net + tare)],
    },
    weighed: [`Weighed net ${pounds.format(weighedNet)} lb · ${over}`, `Implied pieces ${implied} · ${implied - WEIGHED.pieces} over`],
    topLine: `Net ${pounds.format(net)} lb · weighed ${pounds.format(weighedNet)} lb · ${over}`,
  };
}

export async function run(page, shot, ctx) {
  const part = await entryFixture(page, ctx, "E2E-ENTRY-WORKSPACE");
  const before = await ownedOrders(page, ctx);
  const legacyProcessRequests = [];
  const observeLegacyProcessRequest = request => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "GET" && (pathname === `/api/parts/${part.id}/process/revisions`
      || pathname.startsWith(`/api/parts/${part.id}/process/revisions/`))) legacyProcessRequests.push(pathname);
  };
  page.on("request", observeLegacyProcessRequest);
  try {
    await startEntry(page, ctx, part, 30, { keyboard: true });
    await waitPlan(page, 2);
    assert.deepEqual(legacyProcessRequests, [], "Coordinated entry uses its current preview without legacy revision requests");
  } finally {
    page.off("request", observeLegacyProcessRequest);
  }
  await entryTab(page, "Order details", true);
  for (const [label, value] of [["PO number", "ENTRY-30"], ["VS reference", "VS-FICTIONAL"], ["Customer job", "JOB-FICTIONAL"]]) {
    await page.getByLabel(label, { exact: true }).focus();
    await page.keyboard.type(value);
  }
  await entryTab(page, "Parts & containers", true);
  await page.getByRole("button", { name: "Add container", exact: true }).focus();
  await page.keyboard.press("Enter");
  const type = page.getByLabel("Container 1 type", { exact: true });
  const optionIndex = await type.evaluate((select, id) => [...select.options].findIndex(option => option.value === id), ctx.fixtures.containerTypeId);
  assert.ok(optionIndex > 0);
  await type.focus();
  await page.keyboard.press("Home");
  for (let i = 0; i < optionIndex; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Tab");
  await waitForValue(type, ctx.fixtures.containerTypeId);
  await keyboardFill(page, page.getByLabel("Container 1 count", { exact: true }), "6");
  const save = page.getByRole("button", { name: "Save only", exact: true });
  // Order totals, under the container rows. The one part line is 30 pieces at 127 lb each:
  // 3,810.00 lb. The fixture's container type has no default tare each and none is typed here, so
  // in all three states below both Tare cells read Incomplete, the note counts the row, and there
  // is no gross. Only the containers' pieces move: nothing stated, then 24, then 30.
  const entryTotalsBlock = orderTotalsBlock(page);
  const untaredTotals = containerPieces => ({
    rows: { Parts: ["30", "3,810.00", "", ""], Containers: [containerPieces, "", "Incomplete", ""],
      Order: ["", "3,810.00", "Incomplete", "Not available"] },
    note: "1 row has no Tare each", weighed: [],
  });
  await waitForTotals(entryTotalsBlock, untaredTotals("Not entered"));
  await waitPlan(page, 2);
  assert.equal(await save.isEnabled(), true, "Save is not disabled while a container row has no Pieces");
  // Tare each is in the row itself. Scale gross is in the optional section, which is closed here:
  // nothing has been typed in it and the row has no error.
  const containerDetails = page.getByText("Container weights & IDs (optional)", { exact: true });
  const scaleGross = page.getByLabel("Container 1 scale gross", { exact: true });
  await page.getByLabel("Container 1 tare each", { exact: true }).waitFor();
  assert.equal(await scaleGross.isVisible(), false, "Scale gross is out of view until the optional section is opened");
  await containerDetails.focus();
  await page.keyboard.press("Enter");
  await scaleGross.waitFor();
  // Pieces is the row's total, not a figure per container: 24 in the six containers, then 30.
  // The 6 in the Containers box does not enter the containers' pieces.
  const pieces = page.getByLabel("Container 1 pieces", { exact: true });
  await keyboardFill(page, pieces, "24");
  await waitForTotals(entryTotalsBlock, untaredTotals("24"));
  assert.equal(await save.isEnabled(), true, "Save is not disabled while the containers' pieces differ from the parts'");
  await keyboardFill(page, pieces, "30");
  await waitForTotals(entryTotalsBlock, untaredTotals("30"));
  // A Tare each makes Tare a figure and Gross Net plus Tare, and takes the note away. A Scale gross
  // then adds the two weighed lines. The fixture's container type has no default tare each, so
  // the box is blank until this step types in it.
  const weighedOrder = weighedOrderFigures(part.eachWeight);
  await keyboardFill(page, page.getByLabel("Container 1 tare each", { exact: true }), String(WEIGHED.tareEachLb));
  await waitForTotals(entryTotalsBlock, { rows: weighedOrder.rows, note: null, weighed: [] });
  await keyboardFill(page, scaleGross, String(WEIGHED.scaleGrossLb));
  await waitForTotals(entryTotalsBlock, { rows: weighedOrder.rows, note: null, weighed: weighedOrder.weighed });
  // The page's width with the Parts & containers tab showing and both weighed lines under the
  // table. The check further down is made on the Process & loads tab, where this panel is hidden.
  const entryWindow = page.viewportSize();
  assert.ok(entryWindow, "The width check needs the suite's own window size, to put it back");
  try {
    for (const width of [1440, 1024, 760]) {
      await page.setViewportSize({ width, height: 900 });
      const wide = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, window: innerWidth }));
      assert.ok(wide.page <= wide.window,
        `No page overflow at ${width}px with Parts & containers showing: the page is ${wide.page}px wide in a ${wide.window}px window`);
      await shot(`totals-${width}`);
    }
  } finally {
    await page.setViewportSize(entryWindow);
  }
  await entryTab(page, "Process & loads", true);
  await waitPlan(page, 2);
  assert.equal(await page.getByRole("tabpanel", { includeHidden: true }).count(), 3, "All three panels remain mounted");
  await page.getByText("Fully allocated · 0 pieces remaining", { exact: true }).waitFor();
  for (const width of [1440, 1024, 760]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No page overflow at ${width}px`);
    await shot(`workspace-${width}`);
  }
  await entryTab(page, "Order details", true);
  await waitForValue(page.getByLabel("PO number", { exact: true }), "ENTRY-30");
  await entryTab(page, "Parts & containers", true);
  await waitForValue(page.getByLabel("Line 1 quantity", { exact: true }), "30");
  await waitForValue(page.getByLabel("Container 1 count", { exact: true }), "6");
  await entryTab(page, "Process & loads", true);
  const first = await saveEntry(page, ctx, { print: true, count: 2, keyboard: true });
  await openHubTabSettled(page, hubTabLabel("loads"));
  const firstDoc = await archiveEvidence(page, ctx, first, [1, 2], shot, "all-loads");
  // The saved order shows the same table inside its Containers section, on Parts & containers.
  // Nothing in that grid is unsaved here, so the table has no tag. The top line, in the At a
  // glance card, ends with the weighed net against Net (owner ruling W10), as plain text: a span
  // with no class, and not inside a link.
  await waitForTotals(orderTotalsBlock(await hubAnchor(page, "containers")),
    { tag: null, rows: weighedOrder.rows, note: null, weighed: weighedOrder.weighed });
  const weighedTopLine = page.getByRole("region", { name: "At a glance" })
    .getByRole("group", { name: "Order quantities", exact: true }).getByText(weighedOrder.topLine, { exact: true });
  await weighedTopLine.waitFor();
  // `last` is judged against the Order quantities group itself: a figure wrapped in another element
  // is not that group's last child. tests/reconciliation-strip.test.tsx holds that the group is
  // named by `aria-label`.
  assert.deepEqual(await weighedTopLine.evaluate((element) => ({
    tag: element.tagName, classes: element.className, inLink: element.closest("a") !== null,
    last: element.closest('[role="group"][aria-label="Order quantities"]')?.lastElementChild === element,
  })), { tag: "SPAN", classes: "", inLink: false, last: true },
  "The weighed figure is the top line's last figure, as plain text: a span with no class, not inside a link");
  const saved = await readJson(page, ctx, `/api/orders/${first.order.id}`);
  assert.deepEqual(loadsOnly(saved.loads), [{ loadNumber: 1, qty: 15, weight: 1905 }, { loadNumber: 2, qty: 15, weight: 1905 }]);
  assert.deepEqual(saved.lines.map(({ qty, weight }) => ({ qty, weight })), [{ qty: 30, weight: 3810 }]);
  assert.deepEqual(
    saved.containers.map((row) => ({ count: row.count, pieces: row.pieces, tareEach: row.tareEach, scaleGross: row.scaleGross })),
    [{ count: WEIGHED.containers, pieces: WEIGHED.pieces, tareEach: WEIGHED.tareEachLb, scaleGross: WEIGHED.scaleGrossLb }]);
  assert.equal(saved.poNumber, "ENTRY-30");
  assert.equal(saved.vsOrderNumber, "VS-FICTIONAL");
  assert.equal(saved.customerJobNo, "JOB-FICTIONAL");
  const partSnapshot = await readJson(page, ctx, `/api/parts/${part.id}`);
  const processSnapshot = await readJson(page, ctx, `/api/parts/${part.id}/process/revisions/1`);

  await startEntry(page, ctx, part, 31);
  await entryTab(page, "Process & loads");
  await waitPlan(page, 3);
  await page.locator("#entry-traveler-selection").selectOption("loads");
  await page.getByLabel("Print load 2", { exact: true }).uncheck();
  const second = await saveEntry(page, ctx, { print: true, count: 2, doubleWarning: true });
  await openHubTabSettled(page, hubTabLabel("loads"));
  const secondDoc = await archiveEvidence(page, ctx, second, [1, 3], shot, "selected-loads", true);
  assert.deepEqual(loadsOnly((await readJson(page, ctx, `/api/orders/${second.order.id}`)).loads), [
    { loadNumber: 1, qty: 15, weight: 1905 }, { loadNumber: 2, qty: 15, weight: 1905 }, { loadNumber: 3, qty: 1, weight: 127 },
  ]);
  const printedUrl = page.url();
  await page.reload();
  await page.getByRole("heading", { name: `Order #${second.order.orderNumber}`, exact: true }).waitFor();
  await page.goto(ctx.baseURL);
  await page.goBack();
  await page.getByRole("heading", { name: `Order #${second.order.orderNumber}`, exact: true }).waitFor();
  assert.equal(new URL(printedUrl).searchParams.has("printIntent"), false);
  assert.equal((await readJson(page, ctx, `/api/orders/${second.order.id}/documents`)).length, 1, "Reload and Back never reprint");
  await startEntry(page, ctx, part, 30);
  await entryTab(page, "Process & loads");
  await waitPlan(page, 2);
  await page.getByRole("button", { name: "Adjust for this order", exact: true }).click();
  await page.getByLabel("Pieces per load", { exact: true }).fill("10");
  await page.getByLabel("Weight per load (lb)", { exact: true }).fill("2000");
  await waitPlan(page, 3);
  const adjusted = await saveEntry(page, ctx);
  assert.deepEqual(loadsOnly((await readJson(page, ctx, `/api/orders/${adjusted.order.id}`)).loads), [
    { loadNumber: 1, qty: 10, weight: 1270 }, { loadNumber: 2, qty: 10, weight: 1270 }, { loadNumber: 3, qty: 10, weight: 1270 },
  ]);
  assert.equal((await readJson(page, ctx, `/api/orders/${adjusted.order.id}/documents`)).length, 0, "Save is separate from printing");
  assert.equal((await ownedOrders(page, ctx)).length, before.length + 3, "Exactly three persisted orders");
  assert.deepEqual(await readJson(page, ctx, `/api/parts/${part.id}`), partSnapshot, "Further entry and printing leave part defaults unchanged");
  assert.deepEqual(await readJson(page, ctx, `/api/parts/${part.id}/process/revisions/1`), processSnapshot, "Captured instructions and recipe semantics stay byte-equivalent");
  for (const document of [firstDoc, secondDoc]) {
    const response = await page.request.get(`${ctx.baseURL}/api/documents/${document.id}`, { maxRetries: 1 });
    assert.equal(response.status(), 200);
    assert.deepEqual(await response.body(), document.bytes, "Archived bytes remain identical after later entry and reload");
  }
}
