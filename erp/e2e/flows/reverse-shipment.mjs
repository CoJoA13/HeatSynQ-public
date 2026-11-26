// Flow (Round 3 Group B, #161): REVERSE a shipment — the correction for a load that has already
// been invoiced, and the only writer of `OrderStatus.REOPENED`.
//
// The route (`POST /api/shippers/[id]/reverse`) and its service have existed and been 17-test
// covered since Phase 4; until this flow there was no screen that could call either, so the whole
// reversal STORY the shipment page already knows how to tell — the #139 pair freeze, the #65 Void
// precedence, the `reversesShipperId` relationship, the board's own Reopened filter — had never once
// been reachable by a human. This walks it end to end:
//
//   1. ship an order complete, invoice it and FINALIZE — the order sits at Invoiced;
//   2. on the shipment, VOID is refused (§5.7: a finalized invoice freezes it) while REVERSE is
//      offered — the single most important assertion in this file, and the one that fails if the
//      Reverse gate is ever "tidied up" into a clone of the Void ladder beside it. Since #472 the
//      same page also says the rest up front: Lines, Add order and billed freight are greyed with
//      the server's own sentence, one amber line links the invoice, and what an invoice does not
//      freeze (the rest of the header, the Containers grid) stays open;
//   3. reverse it: a new packing list of negative lines, both documents frozen as a pair, and the
//      order at REOPENED — asserted on the board AND through the board's own Reopened filter,
//      which until now could never match anything;
//   4. unlock the invoice — the order settles on its ship-derived Partially shipped (never
//      Shipped: the reversal cleared the completion), and Void's blocker changes from the invoice
//      sentence to the reversal one (#65's precedence, both halves);
//   5. void the reversal — the blessed undo. The completion is restored, the order returns to
//      Shipped, and the pair unfreezes;
//   6. re-reverse. Step 5 + step 6 are literally the "void the reversal, then edit, then
//      re-reverse" instruction the server's own edit refusals print, walked with real buttons.
//
// Runs immediately after `invoice-shipped-order` and, like it, leaves its invoice UNLOCKED (a
// DRAFT has no `finalizedAt`, so it can never enter `close-month-end`'s readiness or export scope
// — see that flow's own header for why a finalized fixture invoice left in the current month is a
// trap for the flows behind it). It creates its own order against the invoicing fixture customer
// and nothing later depends on its state.
//
// It also reads the totals tables of the weights design §12, on the invoiced original and on the
// reversal, whose net weight is below zero.
import assert from "node:assert/strict";
import { waitForEnabled, waitForState, waitForTitle, waitForValue } from "../lib/ui.mjs";
import { answerModal, modalTitle } from "../lib/modal.mjs";
import { watchRequests } from "../lib/refusal-lines.mjs";
import { openRecordTab } from "../lib/record-tabs.mjs";
import { chooseMenuItem, invoicesSection as registerSection, openInvoicingView } from "../lib/invoicing.mjs";
import { boardRow, openBoardAllOrders, createOrderViaUi, startNewShipment, orderPanel, waitForShipmentPage } from "../lib/orders.mjs";
import { SHIPMENT_TOTALS, totalsFor, waitForShipmentTotals } from "../lib/shipment-totals.mjs";

const REVERSE_REASON =
  "E2E reverse-shipment flow: wrong parts loaded, demonstrating the reversal UX for the demo.";
const RE_REVERSE_REASON =
  "E2E reverse-shipment flow: re-reversing after voiding the first reversal, demonstrating the " +
  "correction loop the server's own edit refusals instruct.";
const UNLOCK_REASON =
  "E2E reverse-shipment flow: unlocking so the reversal pair can be corrected, demonstrating the " +
  "§5.7 escape route the disabled Void names.";
const VOID_REVERSAL_REASON =
  "E2E reverse-shipment flow: voiding the reversal, the blessed undo, for the demo.";

/**
 * What this flow waits for the totals tables to read: ten pieces at 5 lb each and no container
 * row, on the invoiced original and then negated on its reversal. Each shipment has one order, so
 * each reading is waited for in the order's table and in the shipment's.
 * tests/e2e-shipment-totals.test.ts holds each reading to what the totals leaf gives for the
 * same figures.
 */
export const EXPECTED_TOTALS = Object.freeze({
  original: { tag: null, cells: ["50.00", "Not entered", "Not available"], note: null },
  reversed: { tag: null, cells: ["-50.00", "Not entered", "Not available"], note: null },
});


/** A plain `<section>` found by its own `<h2>`. Both `/invoicing`'s sections are that — the
 *  `invoice-shipped-order.mjs` `sectionByHeading` precedent — and so is the saved shipment page's
 *  Add order section, which step 3 reads through this since #472. */
function sectionByHeading(page, headingText) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: headingText, exact: true }) });
}

const reverseButton = (page) => page.getByRole("button", { name: "Reverse shipment", exact: true });
const voidButton = (page) => page.getByRole("button", { name: "Void shipment", exact: true });

// `waitForEnabled` and `waitForTitle` (e2e/lib/ui.mjs) wait out the beat in which a gate still
// reads the in-flight permission array as "no grants". The saved shipment page has had no such
// beat since #483: it renders none of its controls until that read answers. A grid has a beat of
// its own while its first read is in flight, but a closed page gate keeps its own title through
// it (`gridGate`, src/lib/shipment-gates.ts). The #472 titles step 3 reads are all closed-gate
// titles, which no grid beat changes: the Lines quantity box is waited for because its row renders
// only once the grid's read lands, and the other waits are a precaution. In step 3 only the
// untitled Add container list has the grid's beat, "Checking access to this editor…", to wait out.
// The Void and Reverse refusal titles this flow reads once never needed a wait: each sits ABOVE
// the permission rung of its ladder.

/**
 * The board, narrowed to one order by its OWN inline search box (placeholder "Order #, PO, VS #,
 * lead part, customer" — distinct from the Shell's global search, HANDOFF §5a), then asserted to
 * carry `statusText`. Returns the row locator so a caller can go on to drive the status filters.
 */
async function boardRowFor(page, ctx, orderNumber) {
  // #1057: the board opens on Open orders; this flow's order is Invoiced or Shipped at times.
  await openBoardAllOrders(page, ctx.baseURL);
  await page.getByPlaceholder("Order #, PO, VS #, lead part, customer").fill(String(orderNumber));
  // #167a: narrowing by the board's own search is not enough on its own — the search matches PO,
  // VS #, lead part and customer too, so it can still return several rows, and the row picked out
  // of them must be picked by the ORDER-NUMBER CELL (e2e/lib/orders.mjs's `boardRow`), never by
  // "any cell holding these digits".
  return boardRow(page, orderNumber);
}

async function assertBoardStatus(page, ctx, orderNumber, statusText) {
  const row = await boardRowFor(page, ctx, orderNumber);
  await row.getByText(statusText, { exact: true }).waitFor({ state: "visible", timeout: 15000 });
  return row;
}

/**
 * Waits for the REVERSAL's page after the navigate `reverseAction` fires. Never
 * `waitForShipmentPage` alone: the original's page carries a "Packing List N" heading too, so that
 * wait can be satisfied by the page we are leaving. The #139 freeze banner naming the original is
 * reversal-page-only content, so waiting for it and then reading the heading/URL is unambiguous —
 * the same reasoning `waitForShipmentPage`'s own doc comment gives for not using `waitForURL`.
 */
async function waitForReversalPage(page, originalNumber) {
  await page.getByText(new RegExp(`This is a reversal of Packing List ${originalNumber}\\b`))
    .waitFor({ state: "visible", timeout: 30000 });
  const shipment = await waitForShipmentPage(page);
  assert.notEqual(shipment.shipperNumber, originalNumber,
    "the reversal must be its OWN packing list, never the original's number reused");
  return shipment;
}

async function openShippingList(page, ctx, orderNumber) {
  await page.goto(`${ctx.baseURL}/shipping`);
  await page.getByRole("heading", { name: "Shipping", exact: true }).waitFor({ state: "visible" });
  for (const name of ["Search", "Customer", "Ship date from", "Ship date to", "Include voided"]) {
    assert.equal(await page.getByLabel(name, { exact: true }).count(), 1,
      `the Shipping list must expose exactly one ${name} filter control`);
  }
  await page.getByLabel("Search", { exact: true }).fill(String(orderNumber));
}

function shippingListRow(page, shipperNumber) {
  return page.locator("tbody tr").filter({
    has: page.getByRole("link", { name: String(shipperNumber), exact: true }),
  });
}

/** #232: assert the actual Status cell, scoped to the owned packing-list link. Waiting for each
 *  label proves the async list loaded; counting all labels also refuses a stale extra badge. */
async function assertShippingListStatus(page, shipperNumber, labels) {
  const status = shippingListRow(page, shipperNumber).getByRole("cell").last();
  for (const label of labels) {
    await status.getByText(label, { exact: true }).waitFor({ state: "visible", timeout: 15000 });
  }
  assert.deepEqual((await status.locator("span").allTextContents()).map((text) => text.trim()), labels,
    `Packing List ${shipperNumber} must show exactly its current document status`);
}

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;

  // --- 1. An order, shipped complete. ---
  const order = await createOrderViaUi(page, ctx, {
    customerCode: fixtures.invCustomerCode,
    lines: [{ partNumber: fixtures.invPartNumber, qty: 10 }],
  });
  await startNewShipment(page, ctx, fixtures.invCustomerId, [order]);
  const newPanel = orderPanel(page, `#${order.number}`);
  await waitForValue(newPanel.getByLabel("Line 1 ship-now quantity", { exact: true }), "10");
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  const shipment = await waitForShipmentPage(page);

  // Before any invoice exists, Reverse is simply available — the base case of the gate.
  await waitForEnabled(reverseButton(page), "Reverse on a live shipment");
  assert.equal(await reverseButton(page).isDisabled(), false,
    "Reverse must be offered on a live, un-reversed shipment");
  assert.equal(await reverseButton(page).getAttribute("title"), null,
    "an available Reverse control carries no refusal title");
  await shot("shipped-reverse-available");
  await openShippingList(page, ctx, order.number);
  await assertShippingListStatus(page, shipment.shipperNumber, ["—"]);

  // --- 2. Invoice it and FINALIZE. ---
  await page.goto(`${ctx.baseURL}/invoicing`);
  await page.getByRole("heading", { name: "Invoicing", exact: true }).waitFor({ state: "visible" });
  const readyRow = sectionByHeading(page, "Ready to invoice").locator("tr")
    .filter({ has: page.getByText(String(order.number), { exact: true }) });
  await readyRow.waitFor({ state: "visible", timeout: 15000 });
  await readyRow.locator('input[type="checkbox"]').check();
  const created = page.waitForResponse((res) =>
    new URL(res.url()).pathname === "/api/invoices" && res.request().method() === "POST" && res.ok());
  await page.getByRole("button", { name: "Create invoices", exact: true }).click();
  await created;

  await openInvoicingView(page, "Register"); // PR 6: the register is behind its view
  const invoiceRow = registerSection(page).locator("tr")
    .filter({ has: page.getByText(String(order.number), { exact: true }) });
  await invoiceRow.waitFor({ state: "visible", timeout: 15000 });
  await invoiceRow.getByRole("link").click();
  const invoiceHeading = page.getByRole("heading", { name: new RegExp(`Invoice.*${order.number}`) });
  await invoiceHeading.waitFor({ state: "visible", timeout: 20000 });
  const invoiceId = page.url().split("/").pop();
  await page.getByRole("button", { name: "Finalize invoice", exact: true }).click();
  await page.getByText("Finalized", { exact: true }).waitFor({ state: "visible", timeout: 15000 });
  await assertBoardStatus(page, ctx, order.number, "· Invoiced");
  await shot("invoiced");

  // --- 3. THE POINT OF THIS FEATURE. On an invoiced shipment the Void is refused — and Reverse,
  // which is the correction for exactly that refusal, is offered. `reverseShipper` carries no
  // invoice guard at all (src/server/shippers.ts); a Reverse gate built by copying `voidGate`'s
  // ladder would disable the control here, in the one case it exists for. ---
  await page.goto(`${ctx.baseURL}/shipping/${shipment.id}`);
  await waitForShipmentPage(page);
  await waitForEnabled(reverseButton(page), "Reverse on an invoiced shipment");
  assert.equal(await voidButton(page).isDisabled(), true, "a finalized invoice must freeze the Void (§5.7)");
  const voidTitle = await voidButton(page).getAttribute("title");
  assert.match(voidTitle, /^This shipment cannot be voided — Invoice .* is finalized; unlock it or raise a credit/,
    `the Void title must be the server's own invoice refusal, got: ${voidTitle}`);
  assert.equal(await reverseButton(page).isDisabled(), false,
    "Reverse must stay AVAILABLE while a finalized invoice blocks the Void — it is the correction for it");
  assert.equal(await reverseButton(page).getAttribute("title"), null,
    "an available Reverse control carries no refusal title");

  // #472: the same finalized invoice greys what the server would refuse, each control carrying the
  // server's own sentence, and leaves the rest of the page open. Every title here sits below the
  // permission rung of its gate, a rung with no beat on this page since #483 (above). Each is a
  // closed gate's own title, which no grid beat changes, so it shows from the control's first
  // render: the Lines quantity box is waited for because its row renders only once the grid's read
  // lands, and the other waits are a precaution. Each is waited for and never read once.
  const changeFrozen = `This shipment cannot be changed — Invoice ${order.number} is finalized; ` +
    `unlock it or raise a credit (see /invoicing/${invoiceId})`;
  const freightFrozen = `This shipment's freight cannot be changed — Invoice ${order.number} is finalized; ` +
    `unlock it or raise a credit (see /invoicing/${invoiceId})`;
  const invoicedPanel = orderPanel(page, `${order.number}-1`);
  const lineQty = invoicedPanel.getByLabel("Line 1 ship-now quantity", { exact: true });
  await waitForTitle(lineQty, changeFrozen, "a Lines input under a finalized invoice");
  assert.equal(await lineQty.isDisabled(), true, "a finalized invoice must grey the shipment's lines");
  await waitForTitle(invoicedPanel.getByRole("button", { name: "Save lines", exact: true }), changeFrozen,
    "Save lines under a finalized invoice");
  const addOrder = sectionByHeading(page, "Add order");
  const addOrderList = addOrder.getByRole("combobox", { name: "Add order", exact: true });
  await waitForTitle(addOrderList, changeFrozen, "the Add order list under a finalized invoice");
  assert.equal(await addOrderList.isDisabled(), true, "a finalized invoice must grey the Add order list");
  const addOrderButton = addOrder.getByRole("button", { name: "Add order", exact: true });
  await waitForTitle(addOrderButton, changeFrozen, "the Add order button under a finalized invoice");
  assert.equal(await addOrderButton.isDisabled(), true, "a finalized invoice must grey Add order");
  await openRecordTab(page, "Header & freight"); // the header's boxes sit on their own tab (PR 4)
  const billFreight = page.getByLabel("Bill freight", { exact: true });
  await waitForTitle(billFreight, freightFrozen, "Bill freight under a finalized invoice");
  assert.equal(await billFreight.isDisabled(), true, "a finalized invoice must grey Bill freight");
  const freightAmount = page.getByLabel("Freight amount", { exact: true });
  await waitForTitle(freightAmount, freightFrozen, "Freight amount under a finalized invoice");
  assert.equal(await freightAmount.evaluate((el) => el.readOnly), true,
    "a finalized invoice must make Freight amount read-only");
  // What an invoice does not freeze stays open. This order has no container, so the Containers
  // grid is read at its picker: closed only because there is nothing to add, and carrying no title
  // once the grid's read lands. Until then it carries the grid's beat, "Checking access to this
  // editor…", which the wait for no title waits out.
  const routeField = page.getByLabel("Route", { exact: true });
  await waitForTitle(routeField, null, "Route under a finalized invoice");
  assert.equal(await routeField.evaluate((el) => el.readOnly), false,
    "a finalized invoice must leave the rest of the header editable");
  await openRecordTab(page, "Orders & quantities");
  await waitForTitle(invoicedPanel.getByLabel("Add container", { exact: true }), null,
    "the Containers grid under a finalized invoice");
  // The totals show under a finalized invoice. This order has no container, so Tare is not
  // entered and there is no Gross.
  await waitForValue(invoicedPanel.getByLabel("Line 1 ship-now weight", { exact: true }), "50");
  await waitForShipmentTotals(invoicedPanel, totalsFor(`${order.number}-1`), EXPECTED_TOTALS.original);
  await waitForShipmentTotals(page, SHIPMENT_TOTALS, EXPECTED_TOTALS.original);
  // The amber line names the same invoice as the titles, and links to it.
  const invoiceLink = page.getByRole("link", { name: `Invoice ${order.number}`, exact: true });
  await invoiceLink.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await invoiceLink.getAttribute("href"), `/invoicing/${invoiceId}`,
    "the amber line must link to the invoice it names");
  assert.equal(((await invoiceLink.locator("xpath=..").textContent()) ?? "").replace(/\s+/g, " ").trim(),
    `Invoice ${order.number} is finalized — lines, added orders and billed freight on this shipment are frozen. ` +
    "Unlock the invoice, raise a credit, or reverse this shipment.");
  await shot("invoiced-void-blocked-reverse-offered");

  // --- 4. Reverse it. ---
  // Through the modal (PR 4): the title is the question, the reason typed into the dialog. Cancel
  // first, which sends nothing and leaves the page as it was (the plan's review focus 3).
  const reverses = watchRequests(page, "POST", `/api/shippers/${shipment.id}/reverse`, { exact: true });
  await reverseButton(page).click();
  await answerModal(page, { confirm: false });
  await waitForEnabled(reverseButton(page), "Reverse after its dialog was cancelled");
  assert.equal(reverses.count(), 0, "a cancelled reason dialog must send no reverse");
  reverses.stop();
  await reverseButton(page).click();
  assert.match(await modalTitle(page), new RegExp(`^Reverse shipment \\(Packing list #${shipment.shipperNumber}\\)\\?`));
  await answerModal(page, { reason: REVERSE_REASON });
  const reversal = await waitForReversalPage(page, shipment.shipperNumber);

  // The reversal is mirror paper: the same order line, negated.
  const reversalPanel = orderPanel(page, `${order.number}-2`);
  await waitForValue(reversalPanel.getByLabel("Line 1 ship-now quantity", { exact: true }), "-10");
  // A reversal's tables: the same line negated, so a net weight below zero, and no containers.
  await waitForValue(reversalPanel.getByLabel("Line 1 ship-now weight", { exact: true }), "-50");
  await waitForShipmentTotals(reversalPanel, totalsFor(`${order.number}-2`), EXPECTED_TOTALS.reversed);
  await waitForShipmentTotals(page, SHIPMENT_TOTALS, EXPECTED_TOTALS.reversed);
  // It is frozen on BOTH the header and its own Reverse control (#139 + the gate's second rung).
  assert.equal(await routeField.evaluate((el) => el.readOnly), true,
    "a reversal is machine-generated mirror paper — its header must be read-only");
  assert.equal(await reverseButton(page).isDisabled(), true, "a reversal cannot itself be reversed");
  assert.equal(
    await reverseButton(page).getAttribute("title"),
    `This shipment is itself a reversal of Packing List ${shipment.shipperNumber} — reverse the original shipment instead`);
  // The REVERSAL's own Void, while the invoice is still finalized. `voidShipper` runs
  // `refuseIfInvoiced` over the pair's orders BEFORE its #65 blocker, and a reversal's orders are
  // its original's — so the invoice sentence wins here too, and "voiding a reversal is the blessed
  // undo" is true only once the invoice is out of the way (step 7 does that, and step 9 then voids
  // it for real). Since #182 the pair-freeze BANNER on the ORIGINAL defers to that same precedence
  // (the invoice sentence first, not "void the reversal first") — asserted at step 6 below.
  assert.match(await voidButton(page).getAttribute("title"), /^This shipment cannot be voided — Invoice /,
    "the reversal's own Void must name the invoice while it is finalized");
  await shot("reversal-created");
  await openShippingList(page, ctx, order.number);
  await assertShippingListStatus(page, shipment.shipperNumber, [`Reversed by ${reversal.shipperNumber}`]);
  await assertShippingListStatus(page, reversal.shipperNumber, [`Reversal of ${shipment.shipperNumber}`]);
  await shot("shipping-list-reversal-pair");

  // --- 5. `OrderStatus.REOPENED`, reachable from a screen for the first time — and the board's
  // Reopened filter, which until this feature existed could never match anything. ---
  const reopenedRow = await assertBoardStatus(page, ctx, order.number, "· Reopened");
  await page.getByLabel("Reopened", { exact: true }).check();
  await reopenedRow.getByText("· Reopened", { exact: true }).waitFor({ state: "visible", timeout: 15000 });
  await shot("board-reopened-filter-matches");
  // ...and it is a real filter, not a no-op that shows everything: narrowing to Open drops the row.
  await page.getByLabel("Reopened", { exact: true }).uncheck();
  await page.getByLabel("Open", { exact: true }).check();
  await page.getByText("No orders match these filters.").waitFor({ state: "visible", timeout: 15000 });
  await page.getByLabel("Open", { exact: true }).uncheck();

  // --- 6. Back on the ORIGINAL: the pair is frozen, Reverse names the reversal to void first, and
  // both the Void button AND (since #182) the edit-freeze BANNER name the INVOICE — `voidShipper`
  // checks `refuseIfInvoiced` BEFORE its reversal blocker, so "void the reversal first" here would be
  // an action the server also refuses (the Codex MR !141 precedence, now shared by the banner). ---
  await page.goto(`${ctx.baseURL}/shipping/${shipment.id}`);
  await waitForShipmentPage(page);
  // #182: on the invoiced pair the banner leads with the invoice sentence, not "void the reversal
  // first" — the same precedence the Void button uses. (After the unlock at step 7 it becomes the
  // reversal step; pinned at step 8.)
  await page.getByText(/^This shipment cannot be voided — Invoice .* is finalized/).first()
    .waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await page.getByText(/void the reversal first, then edit, then re-reverse/).count(), 0,
    "#182: while the invoice is finalized the banner must NOT lead with 'void the reversal first'");
  assert.equal(await reverseButton(page).isDisabled(), true, "an already-reversed original cannot be reversed again");
  assert.equal(
    await reverseButton(page).getAttribute("title"),
    `This shipment has already been reversed by Packing List ${reversal.shipperNumber} — void that reversal first`);
  assert.match(await voidButton(page).getAttribute("title"), /^This shipment cannot be voided — Invoice /,
    "while the invoice is finalized the Void must keep naming it, not the reversal");
  await shot("original-frozen-by-the-pair");

  // --- 7. Unlock the invoice (the step the Void title names). The order leaves the invoice-owned
  // REOPENED for its ship-derived value — Partially shipped, never Shipped, because the reversal
  // cleared the completion. ---
  await page.goto(`${ctx.baseURL}/invoicing/${invoiceId}`);
  await invoiceHeading.waitFor({ state: "visible", timeout: 20000 });
  // Ruling 5 (PR 6): Unlock invoice is a More actions item asking through the modal.
  await chooseMenuItem(page, "Unlock invoice");
  assert.match(await modalTitle(page), /^Unlock Invoice/);
  await answerModal(page, { reason: UNLOCK_REASON });
  await page.getByText("Draft", { exact: true }).waitFor({ state: "visible", timeout: 15000 });
  await assertBoardStatus(page, ctx, order.number, "· Partially shipped");
  await shot("invoice-unlocked-order-partially-shipped");

  // --- 8. With the invoice unfrozen, the Void's blocker becomes the REVERSAL (#65) — the second
  // rung of the same ladder, now reachable. ---
  await page.goto(`${ctx.baseURL}/shipping/${shipment.id}`);
  await waitForShipmentPage(page);
  // #182: with the invoice out of the way, the banner now leads with the reversal step — the same
  // transition the Void button makes. The invoice-first precedence has cleared, so this is where
  // "void the reversal first, then edit, then re-reverse" finally belongs.
  await page.getByText(
    `This shipment has been reversed by Packing List ${reversal.shipperNumber} — void the reversal first, then edit, then re-reverse`,
    { exact: true }).waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await voidButton(page).isDisabled(), true, "an original with a live reversal cannot be voided");
  assert.equal(
    await voidButton(page).getAttribute("title"),
    `This shipment has been reversed by Packing List ${reversal.shipperNumber} — void the reversal first`);
  await shot("void-now-names-the-reversal");

  // --- 9. Void the reversal: the blessed undo. Every control on it locks — including the Reverse
  // control this feature added, which is what keeps `void-shipment.mjs`'s lock-every-control sweep
  // honest on the one document type only this flow can produce. ---
  await page.goto(`${ctx.baseURL}/shipping/${reversal.id}`);
  await waitForShipmentPage(page);
  await voidButton(page).click();
  await answerModal(page, { reason: VOID_REVERSAL_REASON });
  await page.getByText(`Voided — ${VOID_REVERSAL_REASON}`).waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await reverseButton(page).isDisabled(), true, "a voided shipment locks every control (§5.6)");
  assert.equal(await reverseButton(page).getAttribute("title"), "Shipment is voided");
  const unlocked = await page.$$eval("main input, main select, main textarea, main button:not([role=tab])", (els) =>
    els.filter((el) => !(el.disabled === true || el.readOnly === true))
      .map((el) => `${el.tagName.toLowerCase()}[${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? ""}]`));
  assert.deepEqual(unlocked, [], `a voided reversal must lock every control; still unlocked: ${unlocked.join(", ")}`);
  await shot("reversal-voided");
  await openShippingList(page, ctx, order.number);
  await assertShippingListStatus(page, shipment.shipperNumber, ["—"]);
  assert.equal(await shippingListRow(page, reversal.shipperNumber).count(), 0,
    "the voided reversal stays hidden in the default list");
  await page.getByLabel("Include voided", { exact: true }).check();
  // PR 4: the box is the Shipment history preset's own state, so the tab reads pressed with it.
  await waitForState(page.getByRole("button", { name: "Shipment history", exact: true, pressed: true }), "visible", "the Shipment history preset lit by the box");
  await assertShippingListStatus(page, reversal.shipperNumber, ["voided", `Reversal of ${shipment.shipperNumber}`]);
  await assertShippingListStatus(page, shipment.shipperNumber, ["—"]);
  await shot("shipping-list-voided-reversal");

  // --- 10. The original is free again — the completion restored (Shipped), the pair banner gone,
  // and Reverse offered once more. ---
  await page.goto(`${ctx.baseURL}/shipping/${shipment.id}`);
  await waitForShipmentPage(page);
  await waitForEnabled(reverseButton(page), "Reverse after the reversal was voided");
  await waitForEnabled(voidButton(page), "Void after the reversal was voided");
  assert.equal(await reverseButton(page).isDisabled(), false, "voiding the reversal must free the original to reverse again");
  assert.equal(await reverseButton(page).getAttribute("title"), null);
  assert.equal(await voidButton(page).isDisabled(), false, "voiding the reversal must free the original's own Void too");
  assert.equal(await page.getByText(/void the reversal first, then edit, then re-reverse/).count(), 0,
    "the pair-freeze banner must clear once the reversal is voided");
  await assertBoardStatus(page, ctx, order.number, "· Shipped");
  await shot("original-unfrozen");

  // --- 11. Re-reverse. Steps 9-11 together are the "void the reversal, then edit, then re-reverse"
  // instruction the server's own edit refusals print — every step of it now has a button. ---
  await page.goto(`${ctx.baseURL}/shipping/${shipment.id}`);
  await waitForShipmentPage(page);
  await reverseButton(page).click();
  await answerModal(page, { reason: RE_REVERSE_REASON });
  const reversal2 = await waitForReversalPage(page, shipment.shipperNumber);
  assert.ok(reversal2.shipperNumber > reversal.shipperNumber,
    "a re-reversal takes a NEW packing-list number — the voided reversal's is never reused");
  await shot("re-reversed");
  await openShippingList(page, ctx, order.number);
  await assertShippingListStatus(page, shipment.shipperNumber, [`Reversed by ${reversal2.shipperNumber}`]);
  await assertShippingListStatus(page, reversal2.shipperNumber, [`Reversal of ${shipment.shipperNumber}`]);
  await page.getByLabel("Include voided", { exact: true }).check();
  await assertShippingListStatus(page, reversal.shipperNumber, ["voided", `Reversal of ${shipment.shipperNumber}`]);
  await assertShippingListStatus(page, shipment.shipperNumber, [`Reversed by ${reversal2.shipperNumber}`]);
  await shot("shipping-list-re-reversed");
}
