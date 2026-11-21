// #587 (owner rulings 2026-10-20, the lane's Amendment 26): a step picked on a Needs price line.
//
// The fixture part (`stepPickPart` in e2e/lib/db-fixtures.ts) has no price row, so its invoice's one
// operation line is the engine's tier-3 line, reading "Needs price". Its one process step is on the
// fixture step code, which carries the fixture GL account. Its customer opts out of surcharge and tax,
// so the invoice holds that operation line under its PART line and nothing else. The flow keys and
// ships an order of the part, raises the invoice from /invoicing's Ready to invoice list, and then:
//   1. The operation row reads "Needs price", flagged, with no GL account.
//   2. A price typed on its Amount is saved (Save lines): the line is now a typed price with no step.
//   3. Finalize is refused, and the page shows the server's sentence for that line, word for word
//      (`finalizeInvoiceInTx`, ruling 587-13).
//   4. The row's description box, focused, opens its whole suggestion list; the part's own step is
//      the first option (`CODE — Name`). Before the pick, the box's keys (the fix wave): Enter with
//      no option active picks nothing and leaves the list open; Escape closes it and leaves the
//      words; text that matches nothing keeps it closed; ArrowDown then brings the whole list back
//      with its first option active. It is picked with the keyboard (the lane's addition to the
//      brief): the box names that option as its `aria-activedescendant`, and Enter picks it. The
//      box reads the step's name. Save lines, and the row's GL account, which read none until then,
//      reads the step code's own, which the server took from the code (Amendment 17).
//   5. Recalculate keeps the step's name, the step code, its account and the typed price: Amendment
//      19 (the tier-3 slot); words and price ride through `manualWrite`; its account is re-read from
//      the step code (Amendment 17). Only the server answer's `deepEqual` proves the Recalculate: the
//      page checks after it show values the page already held.
//   6. Finalize: the invoice reads Finalized, and its finalized lines carry the step's name and
//      account.
// Each step reads the server's own answer as well as the page.
//
// The box's keyboard path has no other coverage: vitest has no DOM, and the mouse path (a pick on
// mouse-down) is pinned at source level (tests/operational-formatting.test.tsx).
//
// What it leaves: the order, its shipment and the FINALIZED invoice, all its own customer's, which
// the run's clean-up removes. The invoice is finalized this month, so `close-month-end` counts it;
// run.mjs says why that is safe and where the flow sits.
import assert from "node:assert/strict";
import { assertNeverVisible, waitForEnabled, waitForState, waitForValue } from "../lib/ui.mjs";
import { openRecordTab } from "../lib/record-tabs.mjs";
import { chooseMenuItem, glanceCard, invoicesSection as registerSection, menuItem, openInvoicingView } from "../lib/invoicing.mjs";
import { createOrderViaUi, orderPanel, startNewShipment, waitForShipmentPage } from "../lib/orders.mjs";

/** The engine's words on a tier-3 line (`NEEDS_PRICE_LABEL`, src/server/pricing.ts). */
const NEEDS_PRICE = "Needs price";
/** Typed in the Amount box. The page shows a saved amount as `String(amount)`, so a whole figure
 *  with no decimals reads back exactly as typed. */
const TYPED_PRICE = "150";

/** Both `/invoicing`'s sections and the invoice's Lines are `<section>`s headed by their own
 *  heading — the `invoice-shipped-order.mjs` precedent. */
function sectionByHeading(page, headingText) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: headingText, exact: true }) });
}

/** Polls `read()` until it answers `expected`, failing with `what` and the last answer. */
async function waitForReading(read, expected, what, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await read().catch(() => undefined);
    if (last === expected) return;
    if (Date.now() > deadline) {
      assert.fail(`Timed out waiting for ${what} to read ${JSON.stringify(expected)}; last read ${JSON.stringify(last)}`);
    }
    await new Promise((r) => { setTimeout(r, 100); });
  }
}

/** The answer's one OPERATION line, with the columns this flow asserts on. */
function operationLine(invoice, what) {
  const operations = invoice.lines.filter((l) => l.kind === "OPERATION");
  assert.equal(operations.length, 1, `${what}: the invoice must hold exactly one operation line; it holds ${JSON.stringify(operations)}`);
  const [l] = operations;
  return {
    position: l.position, description: l.description, processStepCodeId: l.processStepCodeId,
    glAccountId: l.glAccountId, glAccountName: l.glAccountName, priceSource: l.priceSource,
    needsPrice: l.needsPrice, wordsChosen: l.wordsChosen, amount: l.amount,
  };
}

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;
  const step = { id: fixtures.stepPickStepCodeId, code: fixtures.stepPickStepCodeCode, name: fixtures.stepPickStepCodeName };
  // The server's refusal of a typed price with no step picked (`finalizeInvoiceInTx`). The line is
  // the invoice's second (its PART line is the first, step 2 checks the position), and it carries
  // the part number, so its label is `<part number> — <words>`.
  const unpickedRefusal = `Line 2 · ${fixtures.stepPickPartNumber} — ${NEEDS_PRICE} is a typed price with no step picked — `
    + "pick its step in the description box, then Save lines and Recalculate before finalizing";

  // --- An order of the unpriced part, shipped complete, so it is ready to invoice. ---
  const order = await createOrderViaUi(page, ctx, {
    customerCode: fixtures.stepPickCustomerCode,
    lines: [{ partNumber: fixtures.stepPickPartNumber, qty: 10 }],
  });
  await startNewShipment(page, ctx, fixtures.stepPickCustomerId, [order]);
  await waitForValue(orderPanel(page, `#${order.number}`).getByLabel("Line 1 ship-now quantity", { exact: true }), "10");
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  await waitForShipmentPage(page);
  await shot("shipment-saved");

  // --- 1. Raise the draft invoice and open it: the operation row reads "Needs price". ---
  await page.goto(`${ctx.baseURL}/invoicing`);
  await page.getByRole("heading", { name: "Invoicing", exact: true }).waitFor({ state: "visible" });
  const readySection = sectionByHeading(page, "Ready to invoice");
  const readyRow = readySection.locator("tr").filter({ has: page.getByText(String(order.number), { exact: true }) });
  await readyRow.waitFor({ state: "visible", timeout: 15000 });
  await readyRow.locator('input[type="checkbox"]').check();
  const createAnswer = page.waitForResponse((res) =>
    new URL(res.url()).pathname === "/api/invoices" && res.request().method() === "POST");
  await page.getByRole("button", { name: "Create invoices", exact: true }).click();
  const created = await createAnswer;
  const createdBody = await created.json();
  assert.equal(created.status(), 200, `the invoice must be created: ${JSON.stringify(createdBody)}`);

  await openInvoicingView(page, "Register"); // PR 6: the register is behind its view
  const invoiceRow = registerSection(page).locator("tr")
    .filter({ has: page.getByText(String(order.number), { exact: true }) });
  await invoiceRow.waitFor({ state: "visible", timeout: 15000 });
  await invoiceRow.getByRole("link").click();
  // Post-navigation-only content: the invoice page's own heading (invoice-shipped-order's header).
  await page.getByRole("heading", { name: new RegExp(`Invoice.*${order.number}`) }).waitFor({ state: "visible", timeout: 20000 });
  const invoiceId = page.url().split("/").pop();
  assert.equal(invoiceId, createdBody.invoice.id, "the invoice opened must be the one Create invoices made");

  await openRecordTab(page, "Lines"); // PR 6: the grid is on the Lines tab
  const linesSection = sectionByHeading(page, "Lines");
  // The fixture part's identity line appears once the lines grid's recovery read admits its rows.
  await linesSection.getByText(new RegExp(`^${fixtures.stepPickPartNumber} ·`)).first()
    .waitFor({ state: "visible", timeout: 20000 });
  const partOps = linesSection.getByRole("heading", { name: "Part / operation lines", exact: true })
    .locator("xpath=following-sibling::table[1]");
  const rows = partOps.locator("tbody tr");
  await waitForReading(() => rows.count(), 2, "the part / operation rows (one PART row and one OPERATION row for the unpriced part)");
  const opRow = rows.nth(1);
  assert.equal(await opRow.locator("td").first().textContent(), "Operation", "the second row must be the part's operation");
  // The PART row is Line 1 and keeps a plain box; the OPERATION row's box is the combobox.
  const box = opRow.getByRole("combobox", { name: "Line 2 description", exact: true });
  const amount = opRow.getByRole("textbox", { name: "Line 2 amount", exact: true });
  const glColumn = (await partOps.locator("thead th").allTextContents()).indexOf("GL account");
  assert.ok(glColumn >= 0, "the part / operation table must have a GL account column");
  const glCell = () => opRow.locator("td").nth(glColumn).textContent();
  await waitForValue(box, NEEDS_PRICE, 15000);
  await waitForState(opRow.getByText("needs price", { exact: true }), "visible", "the tier-3 line must be flagged as needing a price");
  assert.equal(await glCell(), "—", "a Needs price line carries no GL account");
  await shot("needs-price");

  // --- 2. Type a price on that row's Amount, Save lines. ---
  const saveLines = linesSection.getByRole("button", { name: "Save lines", exact: true });
  const linesPath = `/api/invoices/${invoiceId}/lines`;
  const linesSaved = () => page.waitForResponse((res) =>
    new URL(res.url()).pathname === linesPath && res.request().method() === "PUT");
  await amount.fill(TYPED_PRICE);
  const typedAnswer = linesSaved();
  await saveLines.click();
  const typedSave = await typedAnswer;
  const typedBody = await typedSave.json();
  assert.equal(typedSave.status(), 200, `Save lines must save the typed price: ${JSON.stringify(typedBody)}`);
  assert.deepEqual(operationLine(typedBody.invoice, "after the typed price's save"), {
    position: 2, description: NEEDS_PRICE, processStepCodeId: null, glAccountId: null, glAccountName: "",
    priceSource: "MANUAL", needsPrice: false, wordsChosen: false, amount: Number(TYPED_PRICE),
  }, "the saved line must be a typed price on the Needs price line, with no step and no GL account");
  await waitForValue(amount, TYPED_PRICE);
  await assertNeverVisible(opRow.getByText("needs price", { exact: true }), "a priced line must no longer be flagged", 500);
  await shot("typed-price-saved");

  // --- 3. Finalize: refused, with the server's sentence for that line on the page. ---
  const finalizeButton = page.getByRole("button", { name: "Finalize invoice", exact: true });
  const finalizedBadge = page.getByText("Finalized", { exact: true });
  const finalizePath = `/api/invoices/${invoiceId}/finalize`;
  const finalizeAnswered = () => page.waitForResponse((res) =>
    new URL(res.url()).pathname === finalizePath && res.request().method() === "POST");
  await waitForEnabled(finalizeButton, "Finalize once the typed price is saved");
  const refusedAnswer = finalizeAnswered();
  await finalizeButton.click();
  const refused = await refusedAnswer;
  const refusedBody = await refused.json();
  assert.equal(refused.status(), 400, `Finalize must refuse a typed price with no step picked: ${JSON.stringify(refusedBody)}`);
  assert.equal(refusedBody.error, unpickedRefusal, "Finalize must name the line in ruling 587-13's sentence");
  // In the At a glance card, Recalculate's and Finalize's own slot (ruling R1, P6 step 5b; PR 6), never the page banner.
  await waitForState(glanceCard(page).getByText(unpickedRefusal, { exact: true }), "visible", "the page must show the refusal word for word, in the At a glance card");
  await assertNeverVisible(page.locator("p.mb-3.bg-red-50"), "a refused Finalize must not show in the page banner", 300);
  await assertNeverVisible(finalizedBadge, "a refused Finalize must leave the invoice a draft", 500);
  await shot("finalize-refused");

  // --- 4. The description box: the part's step first; its keys; picked with the keyboard; Save lines. ---
  const list = opRow.getByRole("listbox", { name: "Step suggestions", exact: true });
  const options = list.getByRole("option");
  const first = options.first();
  await box.focus();
  await waitForState(list, "visible", "focusing the operation line's description box must open its step suggestions", 15000);
  assert.equal(await first.textContent(), `${step.code} — ${step.name}`, "the part's own step must be the first suggestion");
  assert.equal(await box.getAttribute("aria-activedescendant"), null, "no option may be active before an arrow key");
  const wholeList = await options.count();
  await shot("suggestions-open");

  // Enter with no option active: nothing picked, the words and the list as they were.
  await box.press("Enter");
  await waitForValue(box, NEEDS_PRICE);
  await waitForState(list, "visible", "Enter with no option active must leave the list open");
  assert.equal(await box.getAttribute("aria-activedescendant"), null, "Enter must not make an option active");
  // Escape closes the list and leaves the words.
  await box.press("Escape");
  await waitForState(list, "hidden", "Escape must close the suggestion list");
  await waitForValue(box, NEEDS_PRICE);
  // Text that matches no suggestion keeps the list closed, and stands in the box.
  const noMatch = "qq-587-no-such-step";
  await box.fill(noMatch);
  await waitForValue(box, noMatch);
  await assertNeverVisible(list, "text that matches no suggestion must keep the list closed", 500);
  // ArrowDown brings the whole list back, its first option active.
  await box.press("ArrowDown");
  await waitForState(list, "visible", "ArrowDown with nothing matching must bring the list back");
  await waitForReading(() => options.count(), wholeList, "the options after ArrowDown (the whole list, unfiltered)");
  const firstId = await first.getAttribute("id");
  assert.ok(firstId, "the first option must carry an id the box can name");
  await waitForReading(() => box.getAttribute("aria-activedescendant"), firstId,
    "the box's aria-activedescendant after ArrowDown (the first option)");
  assert.equal(await first.textContent(), `${step.code} — ${step.name}`, "the list brought back must start with the part's own step");
  assert.equal(await first.getAttribute("aria-selected"), "true", "ArrowDown must make the first option the active one");
  await box.press("Enter");
  await waitForState(list, "hidden", "a pick must close the suggestion list");
  await waitForValue(box, step.name);
  await shot("step-picked");

  const pickedAnswer = linesSaved();
  await saveLines.click();
  const pickedSave = await pickedAnswer;
  const pickedBody = await pickedSave.json();
  assert.equal(pickedSave.status(), 200, `Save lines must save the pick: ${JSON.stringify(pickedBody)}`);
  const picked = {
    position: 2, description: step.name, processStepCodeId: step.id,
    glAccountId: fixtures.stepPickGlAccountId, glAccountName: fixtures.stepPickGlAccountName,
    priceSource: "MANUAL", needsPrice: false, wordsChosen: true, amount: Number(TYPED_PRICE),
  };
  assert.deepEqual(operationLine(pickedBody.invoice, "after the pick's save"), picked,
    "the saved line must carry the step's words and code, the code's GL account, the mark and the typed price");
  await waitForReading(glCell, fixtures.stepPickGlAccountName, "the row's GL account after Save lines (the step code's own)");
  await waitForValue(box, step.name);
  await waitForValue(amount, TYPED_PRICE);
  await shot("pick-saved");

  // --- 5. Recalculate: the row keeps the step's name and the typed price. Only the answer's
  // deepEqual below proves it: the page's checks after it read values the page already held. ---
  const recalculateItem = menuItem(page, "Recalculate lines"); // a More actions item (PR 6)
  await waitForEnabled(recalculateItem, "Recalculate once the pick is saved");
  const recalculatedAnswer = page.waitForResponse((res) =>
    new URL(res.url()).pathname === `/api/invoices/${invoiceId}/recalculate` && res.request().method() === "POST");
  await chooseMenuItem(page, "Recalculate lines");
  const recalculated = await recalculatedAnswer;
  const recalculatedBody = await recalculated.json();
  assert.equal(recalculated.status(), 200, `Recalculate must succeed: ${JSON.stringify(recalculatedBody)}`);
  assert.deepEqual(operationLine(recalculatedBody.invoice, "after Recalculate"), picked,
    "Recalculate must keep the picked line in its slot with its words, step, GL account and typed price");
  await waitForReading(() => rows.count(), 2, "the part / operation rows after Recalculate (one PART row and one OPERATION row)");
  await waitForValue(box, step.name);
  await waitForValue(amount, TYPED_PRICE);
  await waitForReading(glCell, fixtures.stepPickGlAccountName, "the row's GL account after Recalculate");
  await shot("recalculated");

  // --- 6. Finalize: the Finalized badge shows. ---
  await waitForEnabled(finalizeButton, "Finalize after Recalculate");
  const finalAnswer = finalizeAnswered();
  await finalizeButton.click();
  const finalized = await finalAnswer;
  const finalizedBody = await finalized.json();
  assert.equal(finalized.status(), 200, `Finalize must succeed once the step is picked: ${JSON.stringify(finalizedBody)}`);
  assert.equal(finalizedBody.invoice.status, "FINALIZED", "the answer must hold the finalized invoice");
  await waitForState(finalizedBadge, "visible", "the invoice must read Finalized", 15000);
  // Its finalized lines: the read-only operation row carries the step's words and its account.
  await waitForState(opRow.getByText(step.name, { exact: true }), "visible", "the finalized operation line must read the step's name");
  await waitForReading(glCell, fixtures.stepPickGlAccountName, "the finalized operation line's GL account");
  await shot("finalized");
}
