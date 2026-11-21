// #309: local Discard must clear a scoped removal refusal without saving unwanted rows or losing
// another grid's work. On the order hub the flow still raises that refusal, by removing a line
// whose serials are unsaved, and discards its way out. On the saved shipment it raises none since
// #472: Remove order is greyed, with the refusal's sentence as its title, while its order's grids
// hold unsaved work, so there the flow reads the greyed button and discards one grid at a time
// until the last one opens it. These orders belong to the shipping fixture customer, whose existing
// teardown reaps them; this flow does not alter ctx.created or another flow's required records.
//
// The same shipment carries the totals tables of the weights design §12: two orders, one with a
// container row and one without, on the form and saved; the "Unsaved totals" tag while a grid
// that feeds a table is unsaved; and, after Discard, a table back at its saved figures: order
// A's once its three grids are discarded, and the shipment's, by then of order B alone, once
// order B's Lines grid is discarded. Order B's own table is not read after its Discard.
//
// It also reads two titles of #487 on the saved shipment: Add order's "Pick an order first" once
// order A is off the shipment and in the Add order list, with none picked, and a clean Save lines'
// "No unsaved changes" after order B's Lines grid is discarded.
//
// Last, back on the saved shipment, it proves the page reads once more after a write it overlapped
// (#573, owner ruling 2026-10-20, the hub's #550 rule), with Add order as the write and a refused
// Route save beside it, in both orderings:
//   (a) Add order for A is held before the server sees it. A Route save is refused here with a
//       503, so the page reads the shipment back, and the server serves that read without A. The
//       page applies it: the refusal is on the page and the box is back at its stored text. Then
//       Add order is let go; its answer is older than the applied read, so the page drops it, and
//       only the read the page sends after that answer can show A's panel. It does, once.
//   (b) The same, with the answers the other way round: the server serves the rollback read
//       without A at once, and this flow's route keeps that answer from the page. Add order's
//       answer lands first and the page shows A's panel from it. Then the held answer lands, newer
//       than the write, and takes A off the page; the read the page sends after it is held too while
//       the hold is on, so A stays off until it is let go, and lands A's panel again. Both beats are
//       waited for in turn, so the hidden one is proved, not inferred.
// The flow ends with both orders on the shipment, A added back by that last beat; no later flow reads
// this shipment or either order (each later shipping-customer flow keys its own).
// The header PATCH, the page's reads and the grids' recovery reads share the shipment's address, so
// the route answers only the PATCH, and a held read is shown to be the page's by what its landing
// does to A's panel. A's panel is found by its link to A's own hub page, never by a number.
import assert from "node:assert/strict";
import { assertShipmentLoadPreservesWarning } from "../lib/shipment-load-warning.mjs";
import { assertNeverVisible, waitForChecked, waitForEnabled, waitForState, waitForTitle, waitForValue } from "../lib/ui.mjs";
import { answerModal, modalTitle } from "../lib/modal.mjs";
import { openRecordTab } from "../lib/record-tabs.mjs";
import { createOrderViaUi, hubSection, openOrderTab, orderPanel, startNewShipment, waitForShipmentPage } from "../lib/orders.mjs";
import { bounded, holdRequest } from "../lib/order-entry-workspace.mjs";
import { heardAfter, readAfter, readAfterAnswerFrom, withCleanups, wireRecordReads, writeBeforeRead } from "../lib/record-reads.mjs";
import { routeRequests } from "../route-keep-alive.mjs";
import { SHIPMENT_TOTALS, totalsFor, waitForShipmentTotals } from "../lib/shipment-totals.mjs";

// What this flow's own route answers a Route save with in the #573 part. No server sentence reads so.
const ROUTE_SAVE_ANSWERED_HERE = "Answered by the discard-grid-edits flow: the route was not saved.";

function serialEditor(page, label) {
  return page.getByLabel(`${label} add serial`, { exact: true }).locator("xpath=ancestor::div[1]");
}

function discard(scope, name) {
  return scope.getByRole("button", { name: `Discard changes to ${name}`, exact: true });
}

/**
 * What this flow waits for the totals tables to read. Order A ships 100.00 lb with one container
 * row of 3, which has no tare each. Order B ships 50.00 lb and has no container row.
 * tests/e2e-shipment-totals.test.ts holds each reading to what the totals leaf gives for the
 * same figures.
 */
export const EXPECTED_TOTALS = Object.freeze({
  // The new-shipment form as Add order fills it.
  form: {
    a: { tag: null, cells: ["100.00", "Incomplete", "Not available"], note: "1 row has no Tare each" },
    b: { tag: null, cells: ["50.00", "Not entered", "Not available"], note: null },
    shipment: { tag: null, cells: ["150.00", "Incomplete", "Not available"], note: "1 row has no Tare each · 1 order has no containers" },
  },
  // The saved shipment with order A's row typed to 2 at 42.5, and a grid of each order unsaved.
  typed: {
    a: { tag: "Unsaved totals", cells: ["100.00", "85.00", "185.00"], note: null },
    b: { tag: "Unsaved totals", cells: ["50.00", "Not entered", "Not available"], note: null },
    shipment: { tag: "Unsaved totals", cells: ["150.00", "85.00", "Not available"], note: "1 order has no containers" },
  },
  // Order A's grids discarded, order B's Lines grid still unsaved.
  discarded: {
    a: { tag: null, cells: ["100.00", "Incomplete", "Not available"], note: "1 row has no Tare each" },
    shipment: { tag: "Unsaved totals", cells: ["150.00", "Incomplete", "Not available"], note: "1 row has no Tare each · 1 order has no containers" },
  },
  // Order B alone on the shipment, with nothing unsaved.
  alone: { tag: null, cells: ["50.00", "Not entered", "Not available"], note: null },
});

async function saveGrid(page, scope, label, path) {
  const response = page.waitForResponse((res) =>
    new URL(res.url()).pathname.startsWith(path) && res.request().method() === "PUT");
  await scope.getByRole("button", { name: label, exact: true }).click();
  assert.ok((await response).ok(), `${label} must succeed while setting up its baseline`);
  await scope.getByRole("button", { name: label, exact: true }).waitFor({ state: "visible" });
}

// #275 crosses two browser mechanisms: Shell's capture-phase confirm and native beforeunload.
// This anchor is a test fixture for a document load; the grid, registry, Shell and dialogs are
// real. The rendered BlockerPanel and source census separately prove the production markers.
export async function runNavigationGuard(page, shot, ctx, orderId) {
  const originalUrl = `${ctx.baseURL}/orders/${orderId}`;
  await page.goto(originalUrl);
  // The serial editor sits on the hub's Parts & containers tab (PR 2); opening it puts `?tab=parts`
  // on the URL, so "still on this order" is read from the pathname below.
  await openOrderTab(page, "Parts & containers");
  const draft = page.getByLabel("Lead serial 1 description", { exact: true });
  await draft.waitFor({ state: "visible" });
  const original = await draft.inputValue();
  const editor = serialEditor(page, "Lead");
  const draftValue = "Keep this native-navigation draft";
  const dialogs = [];
  const handling = [];
  const dialogErrors = [];
  let acceptDialogs = false;
  const handleDialog = (dialog) => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    handling.push((acceptDialogs ? dialog.accept() : dialog.dismiss())
      .catch((error) => { dialogErrors.push(error); }));
  };
  page.on("dialog", handleDialog);

  async function expectDialog(action, type, label) {
    const start = dialogs.length;
    const observed = page.waitForEvent("dialog", { timeout: 5000 });
    const results = await Promise.allSettled([action(), observed]);
    for (const result of results) {
      assert.equal(result.status, "fulfilled",
        `${label} must produce its dialog and finish its action: ${result.reason ?? ""}`);
    }
    await Promise.all(handling);
    assert.deepEqual(dialogErrors, [], `${label} must handle every dialog successfully`);
    assert.deepEqual(dialogs.slice(start).map((dialog) => dialog.type), [type],
      `${label} must ask exactly once using ${type}`);
    return dialogs[start];
  }

  async function assertDraftPreserved() {
    assert.equal(new URL(page.url()).pathname, new URL(originalUrl).pathname,
      "declining navigation must keep the current order");
    await waitForValue(draft, draftValue);
    assert.equal(await editor.getByRole("button", { name: "Save serials", exact: true }).isEnabled(), true,
      "declining navigation must leave the unsaved editor available");
  }

  try {
    await draft.fill(draftValue);
    await discard(editor, "serials").waitFor({ state: "visible" });
    await page.evaluate((destination) => {
      const anchor = document.createElement("a");
      anchor.id = "e2e-document-navigation";
      anchor.href = destination;
      anchor.dataset.navigation = "document";
      anchor.textContent = "Native document navigation fixture";
      anchor.style.cssText = "position:fixed;top:0;right:0;z-index:1000;background:white;padding:8px";
      document.body.append(anchor);
    }, `${ctx.baseURL}/reports`);
    const nativeLink = page.locator("#e2e-document-navigation");
    await expectDialog(() => nativeLink.click({ noWaitAfter: true }), "beforeunload", "native navigation");
    await assertDraftPreserved();
    await expectDialog(() => nativeLink.click({ noWaitAfter: true }), "beforeunload", "repeated native navigation");
    await assertDraftPreserved();

    const clientDialog = await expectDialog(() => page.getByRole("navigation")
      .getByRole("link", { name: "Reports", exact: true }).click(), "confirm", "Next Link navigation");
    assert.match(clientDialog.message, /Serials.*unsaved/i);
    await assertDraftPreserved();

    // Trigger the reload without Playwright's navigation-completion waiter: declining
    // beforeunload intentionally prevents any new document from reaching its load event.
    // The dialog and unchanged draft assertions still prove that the browser refused to leave.
    await expectDialog(() => page.evaluate(() => window.location.reload()),
      "beforeunload", "reload after canceled navigations");
    await assertDraftPreserved();
    await shot("native-navigation-preserves-draft");

    acceptDialogs = true;
    await expectDialog(async () => {
      await nativeLink.click({ noWaitAfter: true });
      await page.waitForURL(`${ctx.baseURL}/reports`);
    }, "beforeunload", "accepted native navigation");
    await page.getByRole("heading", { name: "Reports", exact: true }).waitFor({ state: "visible" });
  } finally {
    // Restore the saved fixture for later flows even if a guard mutation navigated unexpectedly.
    acceptDialogs = true;
    try {
      await page.goto(originalUrl);
      await openOrderTab(page, "Parts & containers");
      await draft.waitFor({ state: "visible" });
      await waitForValue(draft, original);
      await Promise.all(handling);
    } finally { page.off("dialog", handleDialog); }
  }
}

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;
  const orderA = await createOrderViaUi(page, ctx, {
    customerCode: fixtures.shipCustomerCode,
    lines: [
      { partNumber: fixtures.shipPartANumber, qty: 10 },
      { partNumber: fixtures.shipPartBNumber, qty: 4 },
    ],
  });
  const ownedPaths = [`/api/orders/${orderA.id}/`];
  const writes = [];
  page.on("request", (req) => {
    const path = new URL(req.url()).pathname;
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method())
        && ownedPaths.some((prefix) => path.startsWith(prefix))) writes.push(path);
  });

  // Containers, Serials, Lines and Charges share the Parts & containers tab; Loads has its own
  // (PR 2). Each section is reached through `hubSection`, which opens its tab, and a tab left for
  // another is opened again before the next action on it.
  const containers = await hubSection(page, "Containers");
  const charges = await hubSection(page, "Charges");
  await containers.getByRole("button", { name: "Add container", exact: true }).click();
  await page.getByLabel("Container 1 type", { exact: true }).selectOption(fixtures.containerTypeId);
  await page.getByLabel("Container 1 count", { exact: true }).fill("2");
  await saveGrid(page, containers, "Save containers", `/api/orders/${orderA.id}/containers`);
  for (const [label, serials] of [["Lead", "D309-LEAD"], ["Line 2", "D309-R{01-02}"]]) {
    const editor = serialEditor(page, label);
    await page.getByLabel(`${label} add serial`, { exact: true }).fill(serials);
    await page.getByLabel(`${label} add serial`, { exact: true }).press("Enter");
    await saveGrid(page, editor, "Save serials", `/api/orders/${orderA.id}/lines/`);
  }

  const rider = serialEditor(page, "Line 2");
  const range = page.getByLabel("Line 2 add serial", { exact: true });
  const riderDiscard = discard(rider, "serials");
  // Exercise all overlay shapes together: edit an existing row, remove another, add a third.
  await page.getByLabel("Line 2 serial 1 description", { exact: true }).fill("discard this edit");
  await rider.getByRole("button", { name: "Remove serial D309-R02", exact: true }).click();
  await range.fill("D309-R03");
  await range.press("Enter");
  const beforeReset = writes.length;
  await riderDiscard.click();
  await waitForValue(page.getByLabel("Line 2 serial 1", { exact: true }), "D309-R01");
  await waitForValue(page.getByLabel("Line 2 serial 2", { exact: true }), "D309-R02");
  await waitForValue(page.getByLabel("Line 2 serial 1 description", { exact: true }), "");
  assert.equal(writes.length, beforeReset, "Discard must not PUT the restored serial rows");

  // The input's blur auto-expands a valid range before the click. Discard must clear that result
  // as well as entry text, rather than leave a freshly added row behind after the button vanishes.
  await range.fill("D309-R{03-04}");
  assert.equal(await rider.getByRole("button", { name: "Save serials", exact: true }).isDisabled(), true);
  await riderDiscard.click();
  await waitForValue(range, "");
  await assertNeverVisible(page.getByLabel("Line 2 serial 3", { exact: true }),
    "a focused serial range must not survive its Discard click", 300);
  // Keyboard focus can legitimately expand the range; activating Discard must still reset it.
  await range.fill("D309-R05");
  await riderDiscard.focus();
  await riderDiscard.press("Enter");
  await waitForValue(range, "");
  await assertNeverVisible(page.getByLabel("Line 2 serial 3", { exact: true }),
    "keyboard activation must discard the expanded range too", 300);
  await range.fill("D309-BAD{");
  await range.press("Tab");
  await rider.getByText(/is not a valid serial range/).waitFor({ state: "visible" });
  await range.focus();
  await riderDiscard.click();
  await waitForValue(range, "");
  await assertNeverVisible(rider.getByText(/is not a valid serial range/),
    "Discard must also clear the serial range's validation error", 300);

  // The Loads reset uses the same shared control, but has its own baseline and Save handler.
  const loads = await hubSection(page, "Loads");
  const loadWeight = page.getByLabel("Load 1 weight", { exact: true });
  const originalWeight = await loadWeight.inputValue();
  await loadWeight.fill("987.65");
  const beforeLoadDiscard = writes.length;
  await discard(loads, "loads").click();
  await waitForValue(loadWeight, originalWeight);
  assert.equal(writes.length, beforeLoadDiscard, "discarding a load edit must not replace server loads");

  await openOrderTab(page, "Parts & containers");
  await charges.getByRole("button", { name: "Add charge", exact: true }).click();
  await page.getByLabel("Charge 1 description", { exact: true }).fill("Keep this unrelated draft");
  await page.getByLabel("Charge 1 amount", { exact: true }).fill("12.50");
  await page.getByLabel("Line 2 serial 1 description", { exact: true }).fill("do not save this");
  const lines = await hubSection(page, "Lines");
  const lineRow = lines.locator("tbody tr")
    .filter({ has: page.getByLabel("Line 2 quantity", { exact: true }) });
  const removeLine = lineRow.getByRole("button", { name: "Remove", exact: true });
  const beforeRefusal = writes.length;
  await removeLine.click();
  // The refusal shows in the Lines section's own message, beside Remove (ruling R1, P6 step 5a).
  await lines.getByRole("alert").filter({ hasText: /Line 2 has unsaved serials/ }).waitFor({ state: "visible" });
  await assertNeverVisible(page.locator("p.mb-3.bg-red-50"), "a refused Remove must not show in the page's banner", 300);
  assert.equal(writes.length, beforeRefusal, "the dirty target must refuse before DELETE");
  await riderDiscard.click();
  const removed = page.waitForResponse((res) =>
    new URL(res.url()).pathname.startsWith(`/api/orders/${orderA.id}/lines/`)
      && res.request().method() === "DELETE");
  await removeLine.click();
  assert.match(await modalTitle(page), /Remove .*Line 2/);
  await answerModal(page);
  assert.ok((await removed).ok(), "discarding target serials must release the scoped refusal");
  await page.getByLabel("Line 2 quantity", { exact: true }).waitFor({ state: "hidden" });
  await waitForValue(page.getByLabel("Charge 1 description", { exact: true }), "Keep this unrelated draft");
  await waitForValue(page.getByLabel("Charge 1 amount", { exact: true }), "12.50");
  assert.equal(await charges.getByRole("button", { name: "Save charges", exact: true }).isEnabled(), true);
  await shot("target-discard-keeps-other-grid");

  // Hold a REAL successful response after the server commits. The grid cannot discard a sent
  // save; a different dirty grid remains usable. There is no fabricated failure or fixed delay.
  const containerPath = `/api/orders/${orderA.id}/containers`;
  const routeUrl = `${ctx.baseURL}${containerPath}`;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let ready;
  const responseReady = new Promise((resolve) => { ready = resolve; });
  const routeHandler = async (route) => {
    if (route.request().method() !== "PUT") { await route.continue(); return; }
    try {
      const response = await route.fetch();
      ready(response.status());
      await held;
      await route.fulfill({ response });
    } catch (error) { ready(error); await route.abort().catch(() => {}); }
  };
  const stopRouteHandler = await routeRequests(page, routeUrl, routeHandler);
  const saved = page.waitForResponse((res) =>
    new URL(res.url()).pathname === containerPath && res.request().method() === "PUT")
    .catch((error) => error);
  let savedResponse;
  try {
    await page.getByLabel("Container 1 count", { exact: true }).fill("3");
    await containers.getByRole("button", { name: "Save containers", exact: true }).click();
    // An ordinary promise has no Playwright timeout: a missing request must fail, not hang.
    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(null), 10000); });
    try {
      const status = await Promise.race([responseReady, deadline]);
      assert.notEqual(status, null, "the container save must reach its held response within 10 seconds");
      assert.equal(status, 200, "hold a genuine committed save response");
    } finally { clearTimeout(timer); }
    assert.equal(await discard(containers, "containers").isDisabled(), true);
    assert.match(await discard(containers, "containers").getAttribute("title"), /this save to finish/);
    assert.equal(await discard(charges, "charges").isEnabled(), true);
    // R23 (#702): the grid's own boxes close while its save is held, since the landed save would
    // drop what was typed meanwhile; the other grid's boxes stay open.
    assert.equal(await page.getByLabel("Container 1 count", { exact: true }).isDisabled(), true,
      "Containers' boxes must close while its own save is in transport");
    assert.equal(await page.getByLabel("Charge 1 description", { exact: true }).isEnabled(), true,
      "Charges' boxes must stay open while another grid saves");
    const beforeOtherDiscard = writes.length;
    await discard(charges, "charges").click();
    await page.getByLabel("Charge 1 description", { exact: true }).waitFor({ state: "hidden" });
    assert.equal(writes.length, beforeOtherDiscard, "discarding Charges during another save writes nothing");
    await shot("pending-save-isolated-to-one-grid");
  } finally {
    release();
    try { savedResponse = await saved; }
    finally { await stopRouteHandler(); }
  }
  assert.ok(!(savedResponse instanceof Error), "the released save response must reach the page");
  assert.ok(savedResponse.ok(), "the released container save must succeed");
  await containers.getByRole("button", { name: "Save containers", exact: true }).waitFor({ state: "visible" });
  await page.getByLabel("Container 1 count", { exact: true }).fill("4");
  // PR 2: a tab switch is never a departure. The unsaved Containers edit badges its tab (polled:
  // a grid registers its unsaved work in an effect, one commit after the keystroke), the badge
  // stays while another tab is open, and the box still holds its text on the way back.
  const partsTab = page.getByRole("tab", { name: /^Parts & containers/ });
  const partsBadge = partsTab.getByText("Unsaved changes", { exact: true });
  await waitForState(partsBadge, "visible", "the Parts & containers tab must badge an unsaved Containers edit");
  await openOrderTab(page, "Billing");
  await waitForState(partsBadge, "visible", "the badge must stay on Parts & containers while Billing is open");
  await assertNeverVisible(page.getByLabel("Container 1 count", { exact: true }),
    "the Containers grid must be off screen while Billing is open", 300);
  await shot("unsaved-badge-across-tabs");
  await openOrderTab(page, "Parts & containers");
  await waitForValue(page.getByLabel("Container 1 count", { exact: true }), "4");
  await discard(containers, "containers").click();
  await waitForValue(page.getByLabel("Container 1 count", { exact: true }), "3");
  await waitForState(partsBadge, "hidden", "a discarded edit must take the badge off its tab");

  const orderB = await createOrderViaUi(page, ctx, {
    customerCode: fixtures.shipCustomerCode,
    lines: [{ partNumber: fixtures.shipPartANumber, qty: 5 }],
  });
  await startNewShipment(page, ctx, fixtures.shipCustomerId, [orderA, orderB]);
  // Two orders on the form, one with a container row and one without. Order A's row has no tare
  // each on the order, so its box is empty and its Tare is incomplete. The shipment has no Gross
  // for two reasons, and the line under its table gives both. No table on the form is tagged.
  const formA = orderPanel(page, `#${orderA.number}`);
  const formB = orderPanel(page, `#${orderB.number}`);
  await waitForValue(formA.getByLabel("Line 1 ship-now weight", { exact: true }), "100");
  await waitForValue(formB.getByLabel("Line 1 ship-now weight", { exact: true }), "50");
  await waitForValue(formA.getByLabel("Container 1 count", { exact: true }), "3");
  await waitForValue(formA.getByLabel("Container 1 tare each", { exact: true }), "");
  await waitForShipmentTotals(formA, totalsFor(`#${orderA.number}`), EXPECTED_TOTALS.form.a);
  await waitForShipmentTotals(formB, totalsFor(`#${orderB.number}`), EXPECTED_TOTALS.form.b);
  await waitForShipmentTotals(page, SHIPMENT_TOTALS, EXPECTED_TOTALS.form.shipment);
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  const shipment = await waitForShipmentPage(page);
  ownedPaths.push(`/api/shippers/${shipment.id}/`);
  await assertShipmentLoadPreservesWarning(page, ctx.baseURL, shipment.id, `${orderA.number}-1`, ctx.serverMode);
  const panelA = orderPanel(page, `${orderA.number}-1`);
  const panelB = orderPanel(page, `${orderB.number}-1`);
  await waitForValue(panelA.getByLabel("Line 1 ship-now quantity", { exact: true }), "10");
  await panelA.getByLabel("Line 1 ship-now quantity", { exact: true }).fill("9");
  await panelA.getByLabel("Container 1 count", { exact: true }).fill("2");
  await panelA.getByLabel("Container 1 tare each", { exact: true }).fill("42.5");
  await panelA.getByLabel("Serial 1 print on ticket", { exact: true }).uncheck();
  await panelB.getByLabel("Line 1 ship-now quantity", { exact: true }).fill("4");
  // Every table follows the boxes as typed, tagged while a grid that feeds it is unsaved: 2 at
  // 42.5 on order A, and on order B a typed quantity alone. Order A now has a Gross of its own.
  // The shipment has none, because order B has no containers.
  await waitForShipmentTotals(panelA, totalsFor(`${orderA.number}-1`), EXPECTED_TOTALS.typed.a);
  await waitForShipmentTotals(panelB, totalsFor(`${orderB.number}-1`), EXPECTED_TOTALS.typed.b);
  await waitForShipmentTotals(page, SHIPMENT_TOTALS, EXPECTED_TOTALS.typed.shipment);
  await shot("shipment-totals-follow-typing");
  const removeOrder = panelA.getByRole("button", { name: "Remove order", exact: true });
  // #472 (R-Q1): while any of this order's three grids holds unsaved work the button is greyed, and
  // its title is the sentence the click-time check still raises underneath. Panel B's unsaved
  // quantity neither greys it nor is disturbed. Polled first: a grid registers its unsaved work in
  // an effect, one commit after the keystroke.
  const unsavedTitle = `Order ${orderA.number}-1 has unsaved lines, containers or serials on this shipment. `
    + "Removing it drops those rows, so save them first — or use Discard beside each unsaved grid's Save button.";
  const removeOrderOpen = panelA.getByRole("button", { name: "Remove order", exact: true, disabled: false });
  await waitForTitle(removeOrder, unsavedTitle, "Remove order with all three of its grids unsaved");
  const gridNames = ["lines", "containers", "serials"];
  for (const [index, gridName] of gridNames.entries()) {
    const before = writes.length;
    assert.equal(await removeOrder.isDisabled(), true, `Remove order must be greyed while the ${gridName} grid is unsaved`);
    assert.equal(await removeOrder.getAttribute("title"), unsavedTitle, "the greyed button names the unsaved grids");
    await discard(panelA, gridName).click();
    await discard(panelA, gridName).waitFor({ state: "hidden" });
    assert.equal(writes.length, before, "each shipment grid discards locally");
    await waitForValue(panelB.getByLabel("Line 1 ship-now quantity", { exact: true }), "4");
    if (index < gridNames.length - 1) {
      // One grid is clean and others are not: the button must not open. A bounded wait for the
      // wrong state, because the registry settles a commit after the Discard button goes.
      await assertNeverVisible(removeOrderOpen,
        `Remove order must stay greyed after only the ${gridName} grid is discarded`, 300);
    }
  }
  await waitForTitle(removeOrder, null, "Remove order once its three grids are clean");
  await waitForEnabled(removeOrder, "Remove order once its three grids are clean");
  await waitForValue(panelA.getByLabel("Line 1 ship-now quantity", { exact: true }), "10");
  await waitForValue(panelA.getByLabel("Container 1 count", { exact: true }), "3");
  await waitForChecked(panelA.getByLabel("Serial 1 print on ticket", { exact: true }), true);
  // Discard put order A's table back at its saved figures, with no tag. The shipment's is still
  // tagged, for order B's unsaved quantity.
  await waitForValue(panelA.getByLabel("Container 1 tare each", { exact: true }), "");
  await waitForShipmentTotals(panelA, totalsFor(`${orderA.number}-1`), EXPECTED_TOTALS.discarded.a);
  await waitForShipmentTotals(page, SHIPMENT_TOTALS, EXPECTED_TOTALS.discarded.shipment);
  const orderRemoved = page.waitForResponse((res) =>
    new URL(res.url()).pathname.startsWith(`/api/shippers/${shipment.id}/orders/`)
      && res.request().method() === "DELETE");
  await removeOrder.click();
  assert.match(await modalTitle(page), /^Remove order/); // the question through the modal (PR 4)
  await answerModal(page);
  assert.ok((await orderRemoved).ok(), "all three target grids are clean, so removal can proceed");
  await panelA.waitFor({ state: "hidden" });
  await waitForValue(panelB.getByLabel("Line 1 ship-now quantity", { exact: true }), "4");
  assert.equal(await panelB.getByRole("button", { name: "Save lines", exact: true }).isEnabled(), true);
  // #487 (owner answer 1): order A is off the shipment, so the list offers it (the removal sets its
  // status from what is still shipped, which is nothing, and the page reads the list again). The
  // option is found by order A's id, so another order of the same customer cannot answer for it.
  // Polled: the list reads "Loading orders…" first, and Add order is untitled while it does. With
  // none picked, Add order says what it waits for: `PICK_AN_ORDER_FIRST` (src/lib/waiting-titles.ts).
  const addOrderSection = page.locator("section")
    .filter({ has: page.getByRole("heading", { name: "Add order", exact: true }) });
  await addOrderSection.locator(`select option[value="${orderA.id}"]`).waitFor({ state: "attached" });
  await waitForTitle(addOrderSection.getByRole("button", { name: "Add order", exact: true }), "Pick an order first",
    "Add order while its list offers an order and none is picked");
  await shot("removed-order-keeps-other-order-draft");
  // #472 (owner ruling R-Q3): a refused save reports in its own order panel, under that grid's Save
  // row, and not in the banner at the top of the page. The page's own check refuses this one, so
  // nothing is sent. The sentence is `shipmentLinesPayload`'s (src/lib/shipment-line-save.ts).
  const refusedSave = "Line 1: ship-now quantity must be a whole number of at least 0.";
  const beforeRefusedSave = writes.length;
  await panelB.getByLabel("Line 1 ship-now quantity", { exact: true }).fill("4.5");
  await panelB.getByRole("button", { name: "Save lines", exact: true }).click();
  await panelB.getByRole("alert").filter({ hasText: refusedSave }).waitFor({ state: "visible" });
  assert.equal(await page.getByText(refusedSave, { exact: true }).count(), 1,
    "a refused save must show once, in its own panel, and not also at the top of the page");
  assert.equal(writes.length, beforeRefusedSave, "a save refused by the page's own check must send nothing");
  await shot("refused-save-shows-in-its-panel");
  await discard(panelB, "lines").click();
  await waitForValue(panelB.getByLabel("Line 1 ship-now quantity", { exact: true }), "5");
  // #487: the grid is clean, so its greyed Save says there is nothing to save: `NO_UNSAVED_CHANGES`
  // (src/lib/waiting-titles.ts).
  await waitForTitle(panelB.getByRole("button", { name: "Save lines", exact: true }), "No unsaved changes",
    "a clean Save lines on a saved shipment");
  await assertNeverVisible(page.getByText(refusedSave, { exact: true }),
    "a grid's Discard must clear the message that grid raised", 300);
  // Order A is off the shipment and order B's grid is discarded: one order, no containers, no tag.
  await waitForShipmentTotals(page, SHIPMENT_TOTALS, EXPECTED_TOTALS.alone);
  await runNavigationGuard(page, shot, ctx, orderA.id);

  // --- #573: Add order answered beside a refused Route save: the page reads once more. ---
  // Back on the saved shipment, which holds order B alone and offers order A in the Add order list.
  // The rollback read a refused header save sends is `load`, which snapshots the writes out as its
  // GET goes and reads once more after they settle (#573); Add order is such a write, and the panel
  // its answer brings is what the page can show only from a read that holds it. A's panel is found
  // by its link to A's own hub page: the saved page labels a panel by the order's shipment sequence,
  // which the removal above freed and this part does not assume.
  const recordPath = `/api/shippers/${shipment.id}`;
  const addPath = `/api/shippers/${shipment.id}/orders`;
  // The shipment's traffic and this flow's route at its address (e2e/lib/record-reads.mjs); a held
  // read's `served` entry is the order ids the server answered with.
  const wireReads = () => wireRecordReads(page, ctx, {
    recordPath, writePath: addPath, refusal: ROUTE_SAVE_ANSWERED_HERE,
    summarise: (body) => body.shipper.orders.map((o) => o.orderId),
  });
  await page.goto(`${ctx.baseURL}/shipping/${shipment.id}`);
  await waitForShipmentPage(page);
  const addOrderButton = addOrderSection.getByRole("button", { name: "Add order", exact: true });
  const panelOfA = page.locator("section").filter({ has: page.locator(`a[href="/orders/${orderA.id}"]`) });
  const routeBox = page.getByLabel("Route", { exact: true });
  const refusalLine = page.getByText(ROUTE_SAVE_ANSWERED_HERE, { exact: true });
  const pickOrderA = async () => {
    await addOrderSection.locator(`select option[value="${orderA.id}"]`).waitFor({ state: "attached" });
    await addOrderSection.locator("select").selectOption(orderA.id);
    await waitForEnabled(addOrderButton, "Add order with order A picked");
  };
  // Click Add order, which the hold keeps from the server, then type a route and leave the box: its
  // save goes out from the blur, is refused here, and the page reads the shipment back with Add
  // order still out. Returns the route the box held, which the rollback must put back.
  const addOrderABeside = async (heldAdd) => {
    await addOrderButton.click();
    assert.deepEqual((await heldAdd.arrived()).data, { orderId: orderA.id }, "the held Add order must be the one the button sent");
    // The Route box sits on Header & freight (PR 4); back to Orders & quantities once its blur
    // has sent the save, where the rest of the pass reads the panels.
    await openRecordTab(page, "Header & freight");
    const routeAtStart = await routeBox.inputValue();
    await routeBox.fill("Not this route (#573)");
    await routeBox.press("Tab");
    await openRecordTab(page, "Orders & quantities");
    return routeAtStart;
  };
  const addAnswered = () => page.waitForResponse((res) =>
    new URL(res.url()).pathname === addPath && res.request().method() === "POST");

  // (a) The rollback read is answered first, without A; Add order's answer is dropped as older.
  await pickOrderA();
  const firstWires = await wireReads();
  const heldAdd = await holdRequest(page, ctx, addPath, { method: "POST", before: true });
  await withCleanups(async () => {
    const routeAtStart = await addOrderABeside(heldAdd);
    // The refusal is set after the rollback read lands, so this is the read applied: the box is
    // back at its stored text, and A, which the server has not been asked to add, is not on the page.
    await waitForState(refusalLine, "visible", "a refused Route save must be named on the page once its rollback read lands");
    await waitForValue(routeBox, routeAtStart);
    assert.ok(writeBeforeRead(firstWires.log),
      `Add order must have gone out before the page's rollback read; heard ${JSON.stringify(firstWires.log)}`);
    assert.ok(heardAfter(firstWires.log, "POST", "GET answered") && !firstWires.log.includes("POST answered"),
      `the rollback read must be answered while Add order is still held; heard ${JSON.stringify(firstWires.log)}`);
    await assertNeverVisible(panelOfA, "order A must not be on the page while its Add order is held from the server", 300);
    const answer = addAnswered();
    heldAdd.release();
    assert.equal((await answer).status(), 200, "the held Add order must add order A");
    // That answer is older than the applied read, so the page drops it: only the read the page
    // sends after it can show A. With the follow-up gone this wait runs out.
    await waitForState(panelOfA, "visible",
      "#573: the page must read the shipment again after the Add order it overlapped was answered, and show order A");
    assert.ok(readAfter(firstWires.log, "POST answered"),
      `the page must read the shipment after Add order's answer; heard ${JSON.stringify(firstWires.log)}`);
    assert.equal(await panelOfA.count(), 1, "order A must be on the page once");
  }, [() => heldAdd.close(), () => firstWires.stop()]);
  await shot("add-order-read-again-after-the-answer");

  // (b) The other ordering: Add order's answer lands before the rollback read's. Order A goes off
  // the shipment again first, and the list offers it again.
  const removedAgain = page.waitForResponse((res) =>
    new URL(res.url()).pathname.startsWith(`${addPath}/`) && res.request().method() === "DELETE");
  await panelOfA.getByRole("button", { name: "Remove order", exact: true }).click();
  assert.match(await modalTitle(page), /^Remove order/);
  await answerModal(page);
  assert.ok((await removedAgain).ok(), "order A must come off the shipment again");
  await panelOfA.waitFor({ state: "hidden" });
  await pickOrderA();
  const laterWires = await wireReads();
  laterWires.holdReads(true);
  const laterAdd = await holdRequest(page, ctx, addPath, { method: "POST", before: true });
  await withCleanups(async () => {
    const routeAtStart = await addOrderABeside(laterAdd);
    // The server serves the rollback read at once, without A (Add order has not reached it), and
    // the route keeps that answer from the page.
    await bounded(laterWires.heard((log) => heardAfter(log, "POST", "GET served")),
      "the server must serve the page's rollback read while Add order is held");
    assert.ok(writeBeforeRead(laterWires.log),
      `Add order must have gone out before the page's rollback read; heard ${JSON.stringify(laterWires.log)}`);
    assert.ok(laterWires.served.every((orderIds) => !orderIds.includes(orderA.id)),
      `the server must have served the rollback read before it saw Add order; it answered with ${JSON.stringify(laterWires.served)}`);
    // Add order's answer lands first. Nothing newer has been applied, so the page takes it.
    const answer = addAnswered();
    laterAdd.release();
    assert.equal((await answer).status(), 200, "the held Add order must add order A");
    await waitForState(panelOfA, "visible", "the page must show order A from Add order's own answer");
    assert.ok(!heardAfter(laterWires.log, "POST", "GET answered"),
      `no read of the shipment sent beside Add order may be answered before Add order's answer; heard ${JSON.stringify(laterWires.log)}`);
    // Then the held answer, newer than the write and without A: it takes A off the page, and the
    // refusal it was sent for is named. Every read held so far goes with it (A's grids' own reads,
    // sent as its panel mounted, among them). The hold stays on, so the read the page sends after
    // the stale answer (#573's follow-up) is held too, and A stays off until that read is let go:
    // the hidden beat is waited for, not inferred.
    const releaseMark = laterWires.log.length;
    await laterWires.releaseReads();
    await waitForState(panelOfA, "hidden",
      "a read served without order A, landing after Add order's answer, must take order A off the page");
    await waitForState(refusalLine, "visible", "the refused Route save must be named once its rollback read lands");
    // A wait, not a check: up to the discriminator's own limit, for a read the page sent after the
    // stale answer to be served and held, so the beat below is let go by this flow rather than
    // passing through the hold's end. It asserts nothing, since the log cannot tell the page's own
    // read from a grid's; the wait after the release is what proves the page read again.
    await laterWires.heardWithin((log) => readAfterAnswerFrom(log, releaseMark, { held: true }), 10000);
    laterWires.holdReads(false);
    await laterWires.releaseReads();
    await waitForState(panelOfA, "visible", "#573: the read sent after the stale one must show order A again");
    assert.ok(readAfterAnswerFrom(laterWires.log, releaseMark),
      `the page must read the shipment after the stale answer landed; heard ${JSON.stringify(laterWires.log)}`);
    assert.equal(await panelOfA.count(), 1, "order A must be on the page once");
    await waitForValue(routeBox, routeAtStart);
    assert.equal(await refusalLine.isVisible(), true, "the refusal stays on the page: the read after the stale one clears nothing");
  }, [() => laterAdd.close(), () => laterWires.stop()]);
  await shot("stale-read-read-again");
}
