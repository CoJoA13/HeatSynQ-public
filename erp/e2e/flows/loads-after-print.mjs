// Flow 9: print the traveler, watch the documents archive grow, then edit the order's one
// auto-split load and confirm the edit saves (design spec §5b/§5.4: loads stay editable after a
// traveler prints, owner ruling §3.3). The save answers no warning of its own.
//
// The fixture lead part (db-fixtures.ts) leaves loadQty/loadWeight both null, so splitLoads
// (src/lib/load-split.ts) returns exactly ONE load covering the order's full qty/weight — this
// flow edits THAT one row rather than juggling several.
//
// A print button opens a blank tab in the click and shows the stored copy in it once the print
// lands (#692, DocumentsSection.tsx); a refused print closes that tab. Whether the environment lets
// the tab open is its popup policy, the app's own blocked line covers the case where it does not,
// and this flow doesn't assert which branch fires (best-effort: capture a popup if one appears,
// for a bonus screenshot). The refused print below opens and closes one more tab, and no page
// event is waited on after it, so a late report of that closed tab (#345) reaches no wait. What IS asserted, either
// way, is the one thing both branches guarantee: the documents table gains a row with a working
// `/api/documents/[id]` link, which this flow fetches directly (same session, via the page's request context)
// to archive `traveler.pdf` alongside the numbered screenshots — the source for the demo doc's
// "printed traveler PDF page" screenshot (rendered to PNG afterward with a local PDF tool; the
// flow itself only touches portable Node/Playwright APIs, no new system dependency).
//
// After that print is archived, one more all-loads print is answered as the server answers a print
// whose claim expired (#521), and the summary must show the refusal alone.
//
// After the saved load edit the flow follows the standing notice (quantity corrections design §6
// and §10.3). The At a glance card says the printed traveler is out of date, says so again after a
// reload, and stops saying so once the load is printed again. In between it measures the card at
// the two sizes the owner named, 1440×1000 and 1024×768, with three things showing: the notice, a
// Loads figure that disagrees, and the strip's weighed figure. It prints the heights, then requires
// that the card has no sideways overflow and does not cover a heading it jumps to. (The 40% bound
// on the height was the sticky summary's, which the card replaced in the UX redesign's PR 2: beside
// the tabs from 1360 px and under them below that, the card takes no band off the window, so that
// bound is not asked.) For the strip's Loads figure to disagree it saves the load at 60 pieces
// against the order's 70, and saves 70 again before it prints. For the weighed figure it saves one
// weighed container row (the weights design §10.5), and reads the Containers section's totals
// table while that row is typed and after it is saved. The order is left printed and not voided,
// with that row on it.
//
// The hub's sections sit in tabs (PR 2): every section stays mounted, the inactive tabs' panels
// hidden, so a section is reached through `openOrderTab`, `hubSection` or `hubAnchor`, which open
// its tab. The Loads and Documents sections are on Loads & travelers, the Containers section on
// Parts & containers; the card is on every tab.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { routeRequests } from "../route-keep-alive.mjs";
import { assertNeverVisible, waitForEnabled } from "../lib/ui.mjs";
import { hubAnchor, hubTabLabel, openOrderTab } from "../lib/orders.mjs";
import { readJson } from "../lib/order-entry-workspace.mjs";
import { orderTotalsBlock, pounds, waitForTotals } from "../lib/order-totals.mjs";

async function within(promise, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new assert.AssertionError({ message })), 10000);
    })]);
  } finally { clearTimeout(timer); }
}

// The notice on an order with one load (the quantity corrections design's §10.5, N1).
const NOTICE = "The printed traveler is out of date: a quantity, a weight or the loads changed after it printed.";
// The two sizes the card is checked at (owner ruling P3-Q5).
const HEADER_SIZES = [{ width: 1440, height: 1000 }, { width: 1024, height: 768 }];
// The tabs this flow opens by name.
const LOADS_TAB = hubTabLabel("loads");

/** Polls until `locator`'s box is inside the window, and returns that box. A hash jump shows the
 *  tab when React commits and scrolls a frame later (RecordTabs), so one reading is too early. */
async function waitForInView(page, locator, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await locator.boundingBox().catch(() => null);
    const viewport = page.viewportSize();
    if (last && viewport && last.y >= 0 && last.y + last.height <= viewport.height) return last;
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what} to come into view; last read ${JSON.stringify(last)}`);
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
}

/** Whether `a` and `b`, two boxes, share any point. */
function overlap(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** One reading of the At a glance card at one viewport size. Jumps to `heading` through `jump`, a
 *  link in the card (a plain `#loads` anchor, whose hash opens Loads & travelers and scrolls to the
 *  section), waits for the heading to come into view, and returns what it measured. It requires
 *  nothing of the numbers. */
async function readHeader(page, orderSummary, jump, heading, size) {
  await page.setViewportSize(size);
  await jump.click();
  await heading.waitFor({ state: "visible", timeout: 5000 });
  const target = await waitForInView(page, heading, `the Loads heading at ${size.width}×${size.height}`);
  const header = await orderSummary.boundingBox();
  assert.ok(header, `the card must be on the page at ${size.width}×${size.height}`);
  const widths = await orderSummary.evaluate((element) => ({
    content: element.scrollWidth,
    box: element.clientWidth,
    right: element.getBoundingClientRect().right,
    viewportWidth: document.documentElement.clientWidth,
    viewportHeight: window.innerHeight,
    pageWidth: document.documentElement.scrollWidth,
  }));
  return { size, header, target, ...widths };
}

/** One line for the run's log: the card's height and the viewport's, and how wide the page is. */
function headerLine(r) {
  return `  card check ${r.size.width}×${r.size.height}: At a glance ${r.header.height} px of ${r.viewportHeight} px `
    + `(${Math.round((100 * r.header.height) / r.viewportHeight)}%), page ${r.pageWidth} px wide of ${r.viewportWidth} px`;
}

/** What one reading breaks, in words; nothing when the card is within both bounds. A whole pixel
 *  is allowed on the widths, because the browser rounds each of them on its own. */
function headerFaults(r) {
  const at = `at ${r.size.width}×${r.size.height}`;
  const faults = [];
  if (r.content > r.box + 1 || r.right > r.viewportWidth + 1) {
    faults.push(`sideways overflow ${at}: ${r.content} px of content in a ${r.box} px box, its right edge at ${r.right} px of ${r.viewportWidth} px`);
  }
  if (overlap(r.header, r.target)) {
    faults.push(`the Loads heading it jumped to is covered ${at}: the heading is at ${JSON.stringify(r.target)} and the card at ${JSON.stringify(r.header)}`);
  }
  return faults;
}

/** Closes whichever other tabs the browser reports. A print may open one, and nothing here waits
 *  for it (#345): a tab that was never reported is left to the harness, which closes the context. */
async function closeOtherTabs(page) {
  for (const other of page.context().pages()) {
    if (other !== page) await other.close().catch(() => {});
  }
}

// The one container row this flow weighs (the weights design §10.5): one container that weighs
// 10 lb empty, on a scale keyed 110 lb above the Net of the order this flow reads. So that order's
// weighed net is 100.00 lb over its Net.
const WEIGHED_ROW = { containers: 1, tareEachCents: 1000, overCents: 10000 };

/**
 * What that row's Scale gross box is keyed with, and what the page then reads, for an order whose
 * saved line weights add up to `netCents`. Worked out here in whole cents, and not by the page's
 * own rule: the weighed line under the Containers section's totals table, and the last figure of
 * the top line.
 */
export function weighedRowFigures(netCents) {
  const lb = (cents) => pounds.format(cents / 100);
  const weighedCents = netCents + WEIGHED_ROW.overCents;
  const over = `${lb(WEIGHED_ROW.overCents)} lb over`;
  return {
    scaleGross: ((weighedCents + WEIGHED_ROW.containers * WEIGHED_ROW.tareEachCents) / 100).toFixed(2),
    weighedLine: `Weighed net ${lb(weighedCents)} lb · ${over}`,
    topLine: `Net ${lb(netCents)} lb · weighed ${lb(weighedCents)} lb · ${over}`,
  };
}

/**
 * Types that row into the saved order's Containers grid and saves it. Returns the strip's weighed
 * figure, a locator, for the header reading that follows.
 *
 * While the row is typed the section's totals table follows it, under the Loads card's own tag,
 * and the strip shows no weighed figure: the strip reads saved state only (owner ruling P5). After Save
 * containers the tag is gone and the strip ends with the weighed net against Net (owner ruling W10).
 * The order's two lines name two parts, so no Implied pieces line shows (owner ruling W6).
 */
async function saveWeighedContainerRow(page, ctx, strip) {
  const { created, fixtures } = ctx;
  const order = await readJson(page, ctx, `/api/orders/${created.orderId}`);
  assert.deepEqual(order.containers, [], "the shared order must reach this flow with no container row");
  const netCents = order.lines.reduce((sum, line) => sum + Math.round(line.weight * 100), 0);
  const expected = weighedRowFigures(netCents);

  const containers = await hubAnchor(page, "containers");
  const totals = orderTotalsBlock(containers);
  await containers.getByRole("button", { name: "Add container", exact: true }).click();
  await containers.getByLabel("Container 1 type", { exact: true }).selectOption(fixtures.containerTypeId);
  await containers.getByLabel("Container 1 count", { exact: true }).fill(String(WEIGHED_ROW.containers));
  await containers.getByLabel("Container 1 tare each", { exact: true }).fill(String(WEIGHED_ROW.tareEachCents / 100));
  await containers.getByLabel("Container 1 scale gross", { exact: true }).fill(expected.scaleGross);
  // The weighed line is read with the tag, so the table is known to hold the typed Tare each and
  // Scale gross before the strip is asked about.
  await waitForTotals(totals, { tag: "Unsaved totals", weighed: [expected.weighedLine] });
  await assertNeverVisible(strip.getByText(/weighed/),
    "the top line must not show the weighed figure while the container row is unsaved");

  const containersPath = `/api/orders/${created.orderId}/containers`;
  const saved = page.waitForResponse((res) =>
    new URL(res.url()).pathname === containersPath && res.request().method() === "PUT", { timeout: 20000 });
  // Marked handled where it is made, as the waiters in `followNotice` are.
  saved.catch(() => {});
  await containers.getByRole("button", { name: "Save containers", exact: true }).click();
  assert.equal((await saved).status(), 200, "a weighed container row must save");
  await waitForTotals(totals, { tag: null, weighed: [expected.weighedLine] });
  const figure = strip.getByText(expected.topLine, { exact: true });
  await figure.waitFor({ state: "visible", timeout: 10000 });
  const line = ((await strip.textContent()) ?? "").replace(/\s+/g, " ").trim();
  assert.ok(line.endsWith(` · ${expected.topLine}`), `the top line must end with the weighed figure; it reads ${JSON.stringify(line)}`);
  return figure;
}

/**
 * The standing notice, the header's height and a reprint, on the order as the steps above leave
 * it: one load, printed twice, then its weight saved at 999.99 lb with nothing printed since.
 * `lastPrintLink` is the Documents row of the newest print so far. Before the header is read it
 * saves one weighed container row, which the order keeps.
 */
async function followNotice(page, shot, ctx, { orderSummary, printUrl, lastPrintLink }) {
  const { created } = ctx;
  const strip = orderSummary.getByRole("group", { name: "Order quantities", exact: true });
  const notice = orderSummary.getByText(NOTICE, { exact: true });
  const printAll = orderSummary.getByRole("button", { name: "Print 1 traveler", exact: true });
  const loadsSettled = page.getByText("No unsaved load changes", { exact: true });
  const saveLoads = page.getByRole("button", { name: "Save loads" });
  // The row print above may have left a tab open. This page is left as the only one before
  // anything about the card's size is read.
  await closeOtherTabs(page);

  // The newest print of Load 1 recorded 550 lb and the order now holds 999.99 lb.
  await notice.waitFor({ state: "visible", timeout: 10000 });
  await shot("traveler-notice-after-load-edit");

  // It is standing state. A reload reads the order and the Documents list again, and the notice
  // is worked out from both, so it is looked for once the newest row of that list is on the page.
  await loadsSettled.waitFor({ state: "visible", timeout: 10000 });
  await page.reload();
  await page.getByRole("heading", { name: `Order #${created.orderNumber}` }).waitFor({ state: "visible", timeout: 15000 });
  // The tab rides in the address, so the reload keeps Loads & travelers; opened again so the
  // Documents list and the loads below are seen.
  await openOrderTab(page, LOADS_TAB);
  await lastPrintLink.waitFor({ state: "visible", timeout: 15000 });
  await notice.waitFor({ state: "visible", timeout: 10000 });

  // The card's size, with the notice, a disagreeing strip and the strip's weighed figure all
  // showing. The saved edit so far is a load's weight, which the strip does not read, so the load
  // is saved at 60 pieces against the order's 70 (order-entry-full keys 50 + 20): the strip's Loads
  // figure reads 10 under and is a link. Then one weighed container row is saved, on Parts &
  // containers; the card's Loads link brings Loads & travelers back for each reading.
  const loadQty = page.getByLabel("Load 1 quantity", { exact: true });
  await loadsSettled.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await loadQty.inputValue(), "70", "the shared order's one load must hold the order's 70 pieces");
  const loadsPath = `/api/orders/${created.orderId}/loads`;
  // A waiter for the answer to a loads save, marked handled where it is made: a step that fails
  // between making it and awaiting it must fail this flow, not end the run on a rejection nothing
  // handles. What is handed back is the waiter itself, so the await below still fails here.
  const loadsSaved = () => {
    const waiter = page.waitForResponse((res) =>
      new URL(res.url()).pathname === loadsPath && res.request().method() === "PUT", { timeout: 20000 });
    waiter.catch(() => {});
    return waiter;
  };
  let saved = loadsSaved();
  await loadQty.fill("60");
  await saveLoads.click();
  assert.equal((await saved).status(), 200, "a load quantity that disagrees with the parts must still save");
  const loadsLink = strip.getByRole("link", { name: "Loads 60 · 10 under", exact: true });
  await loadsLink.waitFor({ state: "visible", timeout: 10000 });
  await loadsSettled.waitFor({ state: "visible", timeout: 10000 });
  const weighedFigure = await saveWeighedContainerRow(page, ctx, strip);
  // With nothing unsaved the print is open and its reason is not in the card: the card is
  // measured at rest.
  await waitForEnabled(printAll, "the card's print, with nothing unsaved");
  assert.equal(await notice.isVisible(), true, "the notice must be showing while the card is measured");
  assert.equal(await weighedFigure.isVisible(), true, "the weighed figure must be showing while the card is measured");

  const loadsHeading = page.getByRole("heading", { name: "Loads", exact: true });
  const suiteViewport = page.viewportSize();
  assert.ok(suiteViewport, "the header check needs the suite's own viewport, to put it back");
  const readings = [];
  try {
    for (const size of HEADER_SIZES) {
      const reading = await readHeader(page, orderSummary, loadsLink, loadsHeading, size);
      // Printed as it is read, before anything is required of it: a run that fails at the next
      // size, or on a fault below, has still reported every reading it took.
      console.log(headerLine(reading));
      readings.push(reading);
      await shot(`header-${size.width}x${size.height}`);
    }
  } finally {
    await page.setViewportSize(suiteViewport);
  }
  const faults = readings.flatMap(headerFaults);
  assert.equal(faults.length, 0, `The At a glance card does not fit its place: ${faults.join("; ")}`);

  // The quantity goes back to 70, so the load is left as this flow found it but for the weight
  // saved above. The Loads figure agrees again and is plain text. The weight still differs from
  // the paper, so the notice stays.
  saved = loadsSaved();
  await loadQty.fill("70");
  await saveLoads.click();
  assert.equal((await saved).status(), 200, "the load's own quantity must save again");
  await strip.getByText("Loads 70", { exact: true }).waitFor({ state: "visible", timeout: 10000 });
  await loadsSettled.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await notice.isVisible(), true,
    "putting the quantity back must leave the notice: the weight still differs from the paper");

  // Printing the load again is what clears it. The print may open a tab, as the two prints above
  // may have. This step waits for the answer and for the new row of the Documents list, never for
  // a tab; a tab the browser reports afterwards is closed, and none is required.
  await waitForEnabled(printAll, "the card's print, once the loads are saved");
  const printed = page.waitForResponse((res) => res.url() === printUrl && res.request().method() === "POST", { timeout: 20000 });
  printed.catch(() => {});
  await printAll.click();
  const reprint = await printed;
  assert.equal(reprint.status(), 200, "the reprint must be archived");
  const reprintId = reprint.headers()["x-document-id"];
  assert.ok(reprintId, "the reprint identifies its archived document");
  await (await hubAnchor(page, "documents")).locator(`a[href="/api/documents/${reprintId}"]`).waitFor({ state: "visible", timeout: 20000 });
  await assertNeverVisible(notice, "a fresh print of the load must take the out-of-date notice away");
  await closeOtherTabs(page);
  await shot("traveler-notice-cleared-by-reprint");
}

export async function run(page, shot, ctx) {
  const { created } = ctx;
  assert.ok(created.orderId, "loads-after-print requires order-entry-full to have set ctx.created.orderId");

  await page.goto(`${ctx.baseURL}/orders/${created.orderId}`);
  await page.getByRole("heading", { name: `Order #${created.orderNumber}` }).waitFor({ state: "visible" });
  // The Documents list is on Loads & travelers; the saved order opens on Overview.
  await openOrderTab(page, LOADS_TAB);
  await page.getByText("Nothing printed yet.").waitFor({ state: "visible" });
  await shot("hub-before-print");

  // Tab changes retain local rows: every panel stays mounted, so an unsaved load edit survives a
  // visit to another tab, the Loads & travelers tab badges it meanwhile, and the card's print
  // refuses it from any tab.
  const orderSummary = page.getByRole("region", { name: "At a glance" });
  const loadWeight = page.getByLabel("Load 1 weight", { exact: true });
  const originalWeight = await loadWeight.inputValue();
  await loadWeight.fill("123.45");
  const loadsTab = page.getByRole("tab", { name: /^Loads & travelers/ });
  await loadsTab.getByText("Unsaved changes", { exact: true }).waitFor({ state: "visible" });
  await openOrderTab(page, hubTabLabel("billing"));
  assert.equal(await orderSummary.getByRole("button", { name: "Print 1 traveler", exact: true }).isDisabled(), true,
    "header print refuses unsaved load changes");
  await openOrderTab(page, LOADS_TAB);
  assert.equal(await loadWeight.inputValue(), "123.45", "tab changes preserve unsaved load edits");
  assert.equal(await loadsTab.getByText("Unsaved changes", { exact: true }).isVisible(), true,
    "the Loads & travelers tab must badge the unsaved load edit");
  assert.equal(await page.getByRole("button", { name: "Print Load 1 traveler", exact: true }).isDisabled(), true,
    "row print refuses the same unsaved load changes");
  await loadWeight.fill(originalWeight);
  await page.getByText("No unsaved load changes", { exact: true }).waitFor();
  await assertNeverVisible(loadsTab.getByText("Unsaved changes", { exact: true }),
    "the badge must go once the load edit is put back");

  const popupPromise = page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null);

  // Hold the real POST so every entry point's shared busy state can be observed.
  let releasePrint;
  let printArrived;
  const handled = [];
  const printHeld = new Promise(resolve => { releasePrint = resolve; });
  const arrived = new Promise(resolve => { printArrived = resolve; });
  const printRoute = `${ctx.baseURL}/api/orders/${created.orderId}/traveler`;
  const handler = route => {
    // Observe errors immediately and join the released handler BEFORE removing its route.
    const task = (async () => {
      assert.equal(route.request().method(), "POST");
      printArrived();
      await printHeld;
      await route.continue();
    })().then(() => null, error => error);
    handled.push(task);
    return task;
  };
  const stopHandler = await routeRequests(page, printRoute, handler);
  try {
    await orderSummary.getByRole("button", { name: "Print 1 traveler", exact: true }).click();
    await within(arrived, "The all-travelers POST must reach its controlled boundary");
    const busyActions = page.getByRole("button", { name: "Printing…", exact: true });
    assert.ok(await busyActions.count() >= 3, "header, row and documents share printing state");
    for (const button of await busyActions.all()) assert.equal(await button.isDisabled(), true,
      "a second entry point cannot start a concurrent print");
  } finally {
    releasePrint();
    try {
      const failures = await within(Promise.all(handled), "Released print handlers must finish");
      assert.deepEqual(failures.filter(Boolean), [], "Print request handling must succeed");
    } finally {
      await stopHandler();
    }
  }
  const travelerLink = page.getByRole("link", { name: "Traveler" }).first();
  await travelerLink.waitFor({ state: "visible", timeout: 20000 });
  const docsShotPath = await shot("documents-list-grown");
  const flowDir = path.dirname(docsShotPath);

  // Best-effort popup screenshot — see the top-of-file comment on why this isn't asserted either
  // way. `close()` afterward so a rendered popup doesn't linger and confuse the next `waitForEvent`
  // this same context might see (none in this flow, but cheap to be tidy).
  const popup = await popupPromise;
  if (popup) {
    try {
      await popup.waitForLoadState("load", { timeout: 5000 }).catch(() => {});
      await popup.waitForTimeout(500); // let a PDF viewer, if any, finish painting
      await popup.screenshot({ path: path.join(flowDir, "printed-traveler-popup.png") }).catch(() => {});
    } finally {
      await popup.close().catch(() => {});
    }
  }

  // Archive the actual PDF bytes regardless of the popup outcome — the page's request context shares
  // the logged-in page's cookies, so this GET is authenticated the same way clicking the link would be.
  const docHref = await travelerLink.getAttribute("href");
  assert.match(docHref ?? "", /^\/api\/documents\/[^/]+$/, "the archived row links to /api/documents/[id]");
  const pdfResp = await page.request.get(new URL(docHref, ctx.baseURL).toString(), { maxRetries: 1 });
  // #233 item 3: this GET's response was never checked, so the header's "a working
  // /api/documents/[id] link, which this flow fetches directly" was a claim the flow did not
  // verify — a 404 or 500 wrote its error body to traveler.pdf and the flow passed. Assert the
  // link WORKS, which is what the header promises and the one guarantee both popup branches share.
  assert.equal(pdfResp.status(), 200, "the archived traveler link serves the stored PDF");
  const pdfBytes = await pdfResp.body();
  assert.ok(pdfBytes.subarray(0, 5).toString("latin1") === "%PDF-", "the archived bytes are a PDF");
  await fs.writeFile(path.join(flowDir, "traveler.pdf"), pdfBytes);

  // #521: the expired-claim refusal needs a render past 15 s and cannot be produced here, so one
  // all-loads print is answered as the server answers it (a 400 carrying { error }). This proves the
  // page's half only: a 5xx would add that the request may already have archived a traveler.
  const EXPIRED = "This traveler took too long to print, so nothing was stored. Print the loads one at a time.";
  const stopRefusal = await routeRequests(page, printRoute, route => route.fulfill({
    status: 400, contentType: "application/json", body: JSON.stringify({ error: EXPIRED }) }));
  try {
    await orderSummary.getByRole("button", { name: "Print 1 traveler", exact: true }).click();
    await orderSummary.getByText(EXPIRED, { exact: true }).waitFor();
    await assertNeverVisible(page.getByText(/may already have archived a traveler/),
      "a refusal that stored nothing must not say a traveler may have been archived");
  } finally { await stopRefusal(); }

  // A row action requests only its saved load and archives that same identity.
  const singleResponse = page.waitForResponse(response =>
    response.url() === `${printRoute}?load=1` && response.request().method() === "POST", { timeout: 20000 });
  await page.getByRole("button", { name: "Print Load 1 traveler", exact: true }).click();
  const single = await singleResponse;
  assert.equal(single.status(), 200, "saved row printing succeeds for its exact load");
  const singleId = single.headers()["x-document-id"];
  assert.ok(singleId, "single-load print identifies its archived document");
  const singleLink = (await hubAnchor(page, "documents")).locator(`a[href="/api/documents/${singleId}"]`);
  await singleLink.waitFor({ state: "visible" });
  assert.match(await singleLink.locator("xpath=ancestor::tr").innerText(), /Load 1/,
    "the archive identifies the same load as the row print action");
  // Nothing has been saved since the order was read: the 123.45 typed above was put back before
  // either print. So both prints recorded the order as it stands, and the one-load print, now the
  // newest print that covers Load 1, raises no notice. Its row is in the Documents list, so the
  // list the notice reads holds it. Without this the wait for the notice after the edit below
  // would pass on a notice that a print alone had raised.
  await assertNeverVisible(orderSummary.getByText(NOTICE, { exact: true }),
    "a one-load print of an unchanged order must raise no notice");

  // Edit the order's one load — its aria-label is "Load 1 ..." (splitLoads returns a single
  // qty-70/weight-550 load here; loadNumber is always 1-based). The edit saves though a traveler
  // has printed: the PUT answers 200 and the grid has nothing left unsaved.
  await page.getByLabel("Load 1 weight", { exact: true }).fill("999.99");
  const loadsSaved = page.waitForResponse(response =>
    response.url() === `${ctx.baseURL}/api/orders/${created.orderId}/loads` && response.request().method() === "PUT", { timeout: 20000 });
  // Marked handled where it is made, as the two waiters in `followNotice` are: if the click below
  // cannot act, this waiter's 20 s run out first, and a rejection nothing handles ends the whole
  // run. The await below still fails here.
  loadsSaved.catch(() => {});
  await page.getByRole("button", { name: "Save loads" }).click();
  assert.equal((await loadsSaved).status(), 200, "a load edit saves after a traveler has printed");
  await page.getByText("No unsaved load changes", { exact: true }).waitFor();
  await shot("load-edit-saved-after-print");
  await followNotice(page, shot, ctx, { orderSummary, printUrl: printRoute, lastPrintLink: singleLink });
}
