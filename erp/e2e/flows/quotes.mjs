// Flow 19 (Phase 6, Task 11): the quoting lifecycle, end to end (P6 design spec §5, plan Task 11).
// Creates an ending statement on the admin reference page and marks it the default; answers the
// Quotes page's worklist read with a 200 it cannot read and sees the page stay up and say so on the
// worklist's own line (#547); creates a
// quote for the fixture quoting customer and verifies the server-side entry defaults (allocated
// number, today's dates, THE default ending statement — ruling 13); builds the agreement out to
// one part-linked line carrying a price row WITH a price break plus one free-text line carrying
// its own each-weight (ruling 1's XOR); prints it and sees the archived QUOTE document appear in
// the page's own Documents list (Task 10's print→archive seam); keys an order through the real
// entry page and watches the "Quote #N" auto-link preview appear BEFORE saving (spec §5.2,
// ruling 7), then finds the stored link on the hub's Lines table (ruling 6 — the STORED link, not
// a re-fetch); ships the order complete and raises a DRAFT invoice whose single operation row
// names its source "Quote #N" (tier-1 wholesale substitution, ruling 4 — the fixture part
// deliberately carries NO PartPrice, so that row can ONLY have come from the quote, which the
// zero "needs price" assertion pins); closes the quote with a reason and sees the warn-and-list
// banner name the still-open, not-yet-fully-invoiced order (ruling 6's close warning — the
// invoice DELIBERATELY stays a draft so the order qualifies); and finally backdates a second
// quote to land in BOTH §5.4 worklist sections (follow-up due AND expired — the same-quote
// overlap the spec calls information, not a bug).
//
// The invoice is NEVER finalized, for three stacked reasons: (1) the close warning above needs a
// linked order that is not fully invoiced; (2) this flow runs AFTER close-month-end, which leaves
// the current month CLOSED until teardown — finalize is period-guarded (`assertPeriodOpen`) and
// would be refused, while draft creation is not a posting mutation; (3) a draft has no
// `finalizedAt`, so it can never contaminate the close flow's readiness/export scope (which is
// also why the quote fixtures carry no GL accounts).
//
// Never `page.waitForURL` for any list -> detail hop (the Phase 3/4/5 URL trap): every wait below
// is for post-navigation-ONLY content (the quote page's own "Quote #N" h1, the hub's "Order #N"
// h1, the invoice page's kind+number h1).
//
// HANDOFF §5a's select-inside-label trap is live on this page: the quote header's "Ending
// statement" is a `<select>` nested inside its own `<label>`, whose Playwright label-text is
// polluted by every option's text — so it is located with the scoped
// `locator("label", { hasText: … }).locator("select")` shape, never `getByLabel`. The record-list
// pickers (customer, part, step code) are Combobox inputs since #1056, each with its own
// `aria-label`, so `pickCombobox` / `pickComboboxValue` find them by it. Plain `<input>`s (the date fields) keep `getByLabel`. The invoice grid's amount
// is a React controlled `<input>` (value invisible to getByText — the same §5a trap the
// invoice-shipped-order flow documents), so it is read via `waitForValue` on its aria-label.
import assert from "node:assert/strict";
import { assertNeverVisible, pickCombobox, pickComboboxValue, waitForEnabled, waitForValue } from "../lib/ui.mjs";
import { startNewShipment, orderPanel, waitForShipmentPage, openOrderTab } from "../lib/orders.mjs";
import { openRecordTab } from "../lib/record-tabs.mjs";
import { answerModal, modalTitle } from "../lib/modal.mjs";
import { invoicesSection as registerSection, openInvoicingView } from "../lib/invoicing.mjs";
import { redLine, waitForRedLines, watchRequests } from "../lib/refusal-lines.mjs";
import { pageDown } from "../lib/order-entry-workspace.mjs";
import { routeRequests } from "../route-keep-alive.mjs";

const EM_DASH = "—";
// What the page says when the answer to a read was a 2xx it could not read (#547, the owner's
// answer of 2026-10-18).
const READ_ANSWER_UNREADABLE = "The answer could not be read. Reload the page to try again.";

const STATEMENT_TEXT = "Thank you for the opportunity to quote. E2E harness fixture statement.";
const FREE_TEXT_PART = "E2E-QUOTE-FT-1";
const FOLLOW_UP_PART = "E2E-QUOTE-FUP-1";
const CLOSE_REASON =
  "E2E quotes flow: intentional close, demonstrating the linked-order warning for the demo.";

/** The app's date-only "today" is the UTC calendar day — `todayDateOnly()` (src/lib/
 *  business-days.ts) floors to UTC midnight and `formatDateOnly` renders UTC fields — so at 10pm
 *  CDT the app's today is already the NEXT local date (caught live on this flow's first run:
 *  the entry-default assertion saw "tomorrow"). Every date this flow computes or asserts against
 *  therefore uses the UTC calendar, never the machine's local one. */
function utcIso(d) {
  return d.toISOString().slice(0, 10);
}
function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return utcIso(d);
}

/** Same shape as e2e/lib/orders.mjs's module-private helper (not exported there): a leftover
 *  autosaved draft opens /orders/new with the Resume/Discard banner; this flow always wants a
 *  blank form. */
async function discardDraftIfOffered(page) {
  const discard = page.getByRole("button", { name: "Discard", exact: true });
  try {
    await discard.waitFor({ state: "visible", timeout: 2000 });
    await discard.click();
  } catch {
    // no banner — the normal case
  }
}

/** A page section located by its own heading — the invoice-shipped-order precedent. */
function sectionByHeading(page, name) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name }) });
}

/** Creates a quote from /quotes' New-quote section (customer + first line) and waits for the
 *  detail page; returns `{ id, number }`. `firstLine` is `{ partId }` or `{ partNumberText }` —
 *  the section's own XOR. */
async function createQuoteViaUi(page, ctx, firstLine) {
  await page.goto(`${ctx.baseURL}/quotes`);
  await page.getByRole("heading", { name: "Quotes", exact: true }).waitFor({ state: "visible" });
  // The register is one region under the three preset tabs (PR 3); its filter controls stay.
  const quoteList = page.getByRole("region", { name: "Quotes list", exact: true });
  for (const name of [
    "Search", "Status", "Customer", "Quote date from", "Quote date to",
    "Effective date from", "Effective date to", "Expiry date from", "Expiry date to",
  ]) {
    assert.equal(await quoteList.getByLabel(name, { exact: true }).count(), 1,
      `the Quotes list must expose exactly one ${name} filter control`);
  }
  const section = sectionByHeading(page, "New quote");
  // The customer is typed, proving the picker filters (#1056); the part is picked by its id.
  await pickCombobox(section, "Customer", ctx.fixtures.quoteCustomerCode, new RegExp(`^${ctx.fixtures.quoteCustomerCode} · `));
  if (firstLine.partId) {
    await pickComboboxValue(section, "First line: part", firstLine.partId);
  } else {
    await section.locator("label", { hasText: "free-text part number" }).locator("input")
      .fill(firstLine.partNumberText);
  }
  await section.getByRole("button", { name: "New quote", exact: true }).click();
  // Post-navigation-only content: the detail page's own h1.
  const heading = page.getByRole("heading", { name: /^Quote #\d+/ });
  await heading.waitFor({ state: "visible", timeout: 20000 });
  const text = (await heading.textContent()) ?? "";
  const match = text.match(/#(\d+)/);
  assert.ok(match, `Could not parse a quote number out of the heading "${text}"`);
  return { id: page.url().split("/").pop(), number: Number(match[1]) };
}

/** A hidden dirty badge can also mean the entire form is checking access. Join
 * the original write and a subsequently started same-quote read, then the admitted form. */
async function saveQuoteForm(page, quoteId) {
  const endpoint = new URL(`/api/quotes/${quoteId}`, page.url()).href;
  let patchRequest;
  const followingReads = new WeakSet();
  const onRequest = request => {
    if (request.url() !== endpoint) return;
    if (!patchRequest && request.method() === "PATCH") patchRequest = request;
    else if (patchRequest && request.method() === "GET") followingReads.add(request);
  };
  page.on("request", onRequest);
  // Attach rejection ownership immediately, including response-body completion.
  // Both waits remain bounded when a failed click never dispatches its request.
  const watch = predicate => {
    let timer;
    const response = page.waitForResponse(predicate, { timeout: 15000 }).then(async res => {
      assert.equal(res.ok(), true, "Quote Save/read must succeed");
      assert.equal(await res.finished(), null, "Quote response must finish");
      return res;
    });
    return Promise.race([response, new Promise((resolve, reject) => {
      void resolve;
      timer = setTimeout(() => reject(new assert.AssertionError({ message: "Quote response completion deadline" })), 20000);
    })]).then(value => ({ ok: true, value }), error => ({ ok: false, error }))
      .finally(() => clearTimeout(timer));
  };
  const saved = watch(res => !!patchRequest && res.request() === patchRequest);
  const refreshed = watch(res => followingReads.has(res.request()));
  try {
    await page.getByRole("button", { name: "Save quote", exact: true }).click();
    const write = await saved; if (!write.ok) throw write.error;
    const read = await refreshed; if (!read.ok) throw read.error;
    await page.getByRole("heading", { name: /^Quote #\d+/ }).waitFor({ state: "visible", timeout: 20000 });
    // The page stays on whichever tab the save was clicked from (PR 3), so the one thing every
    // save shows is the header's Save quote, back on screen with nothing unsaved.
    await page.getByRole("button", { name: "Save quote", exact: true }).waitFor({ state: "visible" });
    // The badge is drawn in the header AND on the dirty tab (PR 3), so a page-wide one-element
    // wait would trip strict mode while both still show: wait until none is left.
    await page.getByText("Unsaved changes", { exact: true }).first().waitFor({ state: "hidden", timeout: 10000 });
  } finally {
    page.off("request", onRequest);
    // Preserve the primary action/assertion error while draining handled waiters.
    await Promise.all([saved, refreshed]);
  }
}

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;
  const today = utcIso(new Date());

  // ---------------------------------------------------------------------------------------
  // 1. The ending statement: created on the admin reference page WITH Default ticked (one
  //    audited create exercising the at-most-one-live-default promote; any pre-existing dev-DB
  //    default is demoted by the real service and restored by cleanup — db-fixtures.ts).
  // ---------------------------------------------------------------------------------------
  await page.goto(`${ctx.baseURL}/admin/reference`);
  await page.getByRole("heading", { name: "Pick lists", exact: true }).waitFor({ state: "visible" });
  await page.getByText("Ending statements", { exact: true }).click();

  // The "Text" placeholder only exists once the endingStatement table has remounted (key={kind})
  // — waiting on the generic "Name" placeholder could match the PREVIOUS kind's add row for a
  // render tick.
  await page.getByPlaceholder("Text").waitFor({ state: "visible", timeout: 10000 });
  const addRow = page.locator("tr").filter({ has: page.getByPlaceholder("Name") });
  await addRow.getByPlaceholder("Name").fill(fixtures.quoteEndingStatementName);
  await addRow.getByPlaceholder("Text").fill(STATEMENT_TEXT);
  // The add row's single checkbox is the Default draft (the boolean extra column).
  await addRow.locator('input[type="checkbox"]').check();
  await shot("ending-statement-drafted");
  await addRow.getByRole("button", { name: "Add", exact: true }).click();

  const statementRow = page.locator("tr").filter({
    has: page.getByLabel(`Name for ${fixtures.quoteEndingStatementName}`, { exact: true }) });
  await statementRow.waitFor({ state: "visible", timeout: 10000 });
  // Extras render before Active, so the row's FIRST checkbox is the Default flag — checked.
  assert.equal(await statementRow.locator('input[type="checkbox"]').first().isChecked(), true,
    "the new ending statement must hold the Default flag");
  await shot("ending-statement-default");

  // ---------------------------------------------------------------------------------------
  // 1b. A register answer the page cannot read (#547): the list read is answered here with a 200
  //     whose body is cut short, and the page's own refusal line gives the owner's sentence. Since
  //     PR 3 the register is the page's one list read (the worklist request is gone), so the route
  //     answers every list read while it stands and lets anything else through — the pickers'
  //     reads report on their own line, never this one (P6).
  // ---------------------------------------------------------------------------------------
  const isRegister = (url) => url.pathname === "/api/quotes";
  const cutRegister = (route) => (route.request().method() === "GET"
    ? route.fulfill({ status: 200, contentType: "application/json", body: '[{"id":' })
    : route.continue());
  const stopCutting = await routeRequests(page, isRegister, cutRegister);
  try {
    await page.goto(`${ctx.baseURL}/quotes`);
    // Asked first, so that an answer which takes the page down fails here, by name, before any
    // wait for what the page shows.
    await assertNeverVisible(pageDown(page), "a register answer the page cannot read must not take the page down", 3000);
    await page.getByRole("heading", { name: "Quotes", exact: true }).waitFor({ state: "visible" });
    await page.getByText(READ_ANSWER_UNREADABLE, { exact: true }).waitFor({ state: "visible" });
    await shot("register-answer-unreadable");
  } finally {
    // The register read was answered when the route took it, so none is in flight when the route
    // goes (#340). createQuoteViaUi below loads the page again, with the real register.
    await stopCutting();
  }

  // ---------------------------------------------------------------------------------------
  // 2. The quote: created from /quotes with the part-linked first line; the detail page then
  //    surfaces the server-side entry defaults (spec §5.1).
  // ---------------------------------------------------------------------------------------
  const quote = await createQuoteViaUi(page, ctx, { partId: fixtures.quotePartId });
  // The header grid is the Details & wording tab (PR 3); Parts & pricing is the default.
  await openRecordTab(page, "Details & wording");
  await waitForValue(page.getByLabel("Quote date", { exact: true }), today);
  await waitForValue(page.getByLabel("Effective", { exact: true }), today);
  const expiry = await page.getByLabel("Expires", { exact: true }).inputValue();
  assert.ok(expiry >= today,
    `the default expiry (${expiry}) must be on or after the default effective date (${today})`);
  // The default ending statement (ruling 13): the header select sits on the fixture statement,
  // and its text renders beneath. Select-inside-label -> the scoped-locator shape (§5a).
  const statementSelect = page.locator("label", { hasText: "Ending statement" }).locator("select");
  const selectedStatement = await statementSelect.evaluate((el) => el.selectedOptions[0]?.textContent ?? "");
  assert.equal(selectedStatement, fixtures.quoteEndingStatementName,
    "a new quote must default to THE default ending statement");
  await page.getByText(STATEMENT_TEXT, { exact: true }).waitFor({ state: "visible" });
  await shot("quote-created-defaults");

  // ---------------------------------------------------------------------------------------
  // 3. Build the agreement: line 1 gets a priced operation (setup/unit/minimum) plus a price
  //    break; line 2 is free text with its own each-weight. One Save (the single-save form).
  // ---------------------------------------------------------------------------------------
  await openRecordTab(page, "Parts & pricing");
  const linesSection = sectionByHeading(page, "Lines");
  const cards = linesSection.locator("div.space-y-4 > div");
  const card1 = cards.nth(0);

  await pickCombobox(card1, "Add operation", fixtures.quoteStepCodeCode,
    new RegExp(`^${fixtures.quoteStepCodeCode} ${EM_DASH} ${fixtures.quoteStepCodeName}$`));
  await card1.getByLabel("Setup charge", { exact: true }).fill("25.00");
  await card1.getByLabel("Unit price", { exact: true }).fill("4.50");
  await card1.getByLabel("Minimum charge", { exact: true }).fill("50.00");
  await card1.locator("label", { hasText: "Quoted qty" }).locator("input").fill("10");
  await card1.getByPlaceholder("Threshold").fill("100");
  await card1.getByPlaceholder("Price").fill("4.00");
  await card1.getByRole("button", { name: "Add break", exact: true }).click();

  await linesSection.getByRole("button", { name: "Add quote line", exact: true }).click();
  const card2 = cards.nth(1);
  await card2.getByLabel("Part number (free text)", { exact: true }).fill(FREE_TEXT_PART);
  await card2.getByLabel("Name", { exact: true }).fill("E2E Free Text Widget");
  await card2.getByLabel("Each weight (lb)", { exact: true }).fill("2.5");
  // #541: the free-text line's Material comes from the Materials pick list. The select sits
  // inside its own label (the §5a trap above), so it is located by the scoped shape.
  const materialSelect = () => card2.locator("label", { hasText: /^\s*Material/ }).locator("select");
  await waitForEnabled(materialSelect(), "the free-text line's Material select");
  await materialSelect().selectOption(fixtures.quoteMaterialId);
  await shot("quote-lines-drafted");

  await saveQuoteForm(page, quote.id);
  // The break survived the round trip: the breaks table (card 1's only table) holds one row,
  // its threshold input re-populated from server truth.
  assert.equal(await card1.locator("table tbody tr").count(), 1,
    "the saved price row must carry exactly the one break entered");
  await waitForValue(card1.locator("table tbody tr input").first(), "100");
  await shot("quote-saved");

  // #541: the picked material is kept. A reload reads the page back from the server: the select
  // greys until the Materials list lands, then holds the fixture material by id and by name. The
  // API stores the id with the typed text blank, and resolves the line's material to the name.
  // The save left nothing to recover: a clean saved form is a baseline, not a draft the page
  // offers (src/lib/draft-store.ts), so the reloaded select is not held behind a recovery notice.
  await page.reload();
  await page.getByRole("heading", { name: /^Quote #\d+/ }).waitFor({ state: "visible", timeout: 20000 });
  await waitForEnabled(materialSelect(), "the reloaded free-text line's Material select");
  await waitForValue(materialSelect(), fixtures.quoteMaterialId);
  assert.equal(
    await materialSelect().evaluate((el) => el.selectedOptions[0]?.textContent ?? null),
    fixtures.quoteMaterialName,
    "the reloaded free-text line must show the picked material by name",
  );
  {
    const res = await page.request.get(`${ctx.baseURL}/api/quotes/${quote.id}`, { maxRetries: 1 });
    assert.equal(res.ok(), true, "reading the stored quote must succeed");
    const line = (await res.json()).lines[1];
    assert.deepEqual(
      { materialId: line.materialId, materialText: line.materialText, material: line.material },
      { materialId: fixtures.quoteMaterialId, materialText: "", material: fixtures.quoteMaterialName },
      "the free-text line must store the picked material's id with blank typed text",
    );
  }
  await shot("quote-material-kept");

  // ---------------------------------------------------------------------------------------
  // 3b. Decimal entry (#517): the page checks every price box before it sends, names each
  //     refused box by its place, and lists every refusal. `.36` is a figure; `$4` and a break
  //     threshold of `0` are not. What is stored is read from the API, never from a box.
  // ---------------------------------------------------------------------------------------
  const storedFirstOperation = async () => {
    const res = await page.request.get(`${ctx.baseURL}/api/quotes/${quote.id}`, { maxRetries: 1 });
    assert.equal(res.ok(), true, "reading the stored quote must succeed");
    const detail = await res.json();
    const op = detail.lines[0].prices[0];
    return { unitPrice: op.unitPrice, breaks: op.breaks.map((b) => [b.threshold, b.price]) };
  };
  await card1.getByLabel("Unit price", { exact: true }).fill(".36");
  await saveQuoteForm(page, quote.id);
  assert.deepEqual(await storedFirstOperation(), { unitPrice: 0.36, breaks: [[100, 4]] },
    "a Unit price typed as .36 must be stored as 0.36");

  const quoteSaves = watchRequests(page, "PATCH", `/api/quotes/${quote.id}`);
  await card1.getByLabel("Unit price", { exact: true }).fill("$4");
  await card1.locator("table tbody tr input").first().fill("0");
  await page.getByRole("button", { name: "Save quote", exact: true }).click();
  await waitForRedLines(redLine(page), [
    "Line 1, operation 1, Unit price: enter a number without $ or commas, such as 0.36.",
    "Line 1, operation 1, break 1, Threshold: must be greater than zero.",
  ]);
  await shot("quote-decimal-refusals");
  assert.equal(quoteSaves.count(), 0, "a Save with refused boxes must send nothing");
  assert.deepEqual(await storedFirstOperation(), { unitPrice: 0.36, breaks: [[100, 4]] },
    "a Save the page refused must leave the stored figures unchanged");
  quoteSaves.stop();

  // Put the figures the invoice below prices from back, through the page's own Save.
  await card1.getByLabel("Unit price", { exact: true }).fill("4.50");
  await card1.locator("table tbody tr input").first().fill("100");
  await saveQuoteForm(page, quote.id);
  assert.deepEqual(await storedFirstOperation(), { unitPrice: 4.5, breaks: [[100, 4]] },
    "the corrected boxes must save");
  await assertNeverVisible(redLine(page), "a saved quote must clear the red line");

  // ---------------------------------------------------------------------------------------
  // 4. Print: the Task 10 print→archive seam — the stored QUOTE document appears in the page's
  //    own Documents list.
  // ---------------------------------------------------------------------------------------
  const popup = page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null);
  const printed = page.waitForResponse((res) =>
    res.url().endsWith(`/api/quotes/${quote.id}/print`) && res.request().method() === "POST" && res.ok());
  await page.getByRole("button", { name: "Print quotation", exact: true }).click();
  await printed;
  await (await popup)?.close().catch(() => {});
  await openRecordTab(page, "Documents & history");
  await sectionByHeading(page, "Documents").getByRole("link", { name: "Open PDF", exact: true })
    .waitFor({ state: "visible", timeout: 15000 });
  await shot("quote-printed-archived");

  // ---------------------------------------------------------------------------------------
  // 5. Order entry: the quoted part's line shows the auto-link preview BEFORE saving (spec
  //    §5.2 — the preview is display, ABSENT stays the wire state, the server resolves the
  //    same answer at save). Inlined rather than createOrderViaUi so the preview can be
  //    asserted between the part pick and the save.
  // ---------------------------------------------------------------------------------------
  await page.goto(`${ctx.baseURL}/orders/new`);
  await page.getByRole("heading", { name: "New order" }).waitFor({ state: "visible" });
  await discardDraftIfOffered(page);
  await pickCombobox(page, "Customer", fixtures.quoteCustomerCode, new RegExp(`^${fixtures.quoteCustomerCode}`));
  await page.getByRole("tab", { name: "Parts & containers", exact: true }).click();
  await pickCombobox(page, "Line 1 part", fixtures.quotePartNumber, new RegExp(`^${fixtures.quotePartNumber}`));
  await page.getByLabel("Line 1 quantity", { exact: true }).fill("10");

  await page.getByText(/Quote link \(auto\):/).waitFor({ state: "visible", timeout: 15000 });
  await page.getByRole("link", { name: `Quote #${quote.number}`, exact: true }).waitFor({ state: "visible" });
  await shot("order-entry-quote-preview");

  await page.getByRole("tab", { name: "Process & loads", exact: true }).click();
  await page.getByText("Fully allocated · 0 pieces remaining", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Save only", exact: true }).click();
  const hubHeading = page.getByRole("heading", { name: /^Order #\d+/ });
  await hubHeading.waitFor({ state: "visible", timeout: 20000 });
  const headingText = (await hubHeading.textContent()) ?? "";
  const orderMatch = headingText.match(/#(\d+)/);
  assert.ok(orderMatch, `Could not parse an order number out of the hub heading "${headingText}"`);
  const order = { id: page.url().split("/").pop(), number: Number(orderMatch[1]) };

  // The hub's Lines table shows the STORED link (ruling 6) as a link to the quote; PR 2 put
  // Lines on the Parts & containers tab.
  await openOrderTab(page, "Parts & containers");
  await page.getByRole("link", { name: `Quote #${quote.number}`, exact: true })
    .waitFor({ state: "visible", timeout: 15000 });
  await shot("order-hub-linked-quote");

  // ---------------------------------------------------------------------------------------
  // 6. Ship complete, then raise the DRAFT invoice; its one operation row names "Quote #N"
  //    and nothing needs a price (tier-1 wholesale substitution — the part has NO PartPrice,
  //    so the priced row can only be the quote's, and the amount is the quote's arithmetic in
  //    the 5A "Setup … Plus / Price per … Or / Minimum" reading: 25.00 setup + max(10 × 4.50,
  //    50.00 minimum) = 75 — the minimum beats the 45.00 unit total, and the 100-piece break is
  //    not reached).
  // ---------------------------------------------------------------------------------------
  await startNewShipment(page, ctx, fixtures.quoteCustomerId, [order]);
  const panel = orderPanel(page, `#${order.number}`);
  await waitForValue(panel.getByLabel("Line 1 ship-now quantity", { exact: true }), "10");
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  await waitForShipmentPage(page);
  await shot("order-shipped");

  await page.goto(`${ctx.baseURL}/invoicing`);
  await page.getByRole("heading", { name: "Invoicing", exact: true }).waitFor({ state: "visible" });
  const readyRow = sectionByHeading(page, "Ready to invoice").locator("tr")
    .filter({ has: page.getByText(String(order.number), { exact: true }) });
  await readyRow.waitFor({ state: "visible", timeout: 15000 });
  await readyRow.locator('input[type="checkbox"]').check();
  const invoiceCreated = page.waitForResponse((res) =>
    new URL(res.url()).pathname === "/api/invoices" && res.request().method() === "POST" && res.ok());
  await page.getByRole("button", { name: "Create invoices", exact: true }).click();
  await invoiceCreated;

  await openInvoicingView(page, "Register"); // PR 6: the register is behind its view
  const invoiceRow = registerSection(page).locator("tr")
    .filter({ has: page.getByText(String(order.number), { exact: true }) });
  await invoiceRow.waitFor({ state: "visible", timeout: 15000 });
  await invoiceRow.getByRole("link").click();
  await page.getByRole("heading", { name: new RegExp(`Invoice.*${order.number}`) })
    .waitFor({ state: "visible", timeout: 20000 });
  await openRecordTab(page, "Lines"); // PR 6: the grid is on the Lines tab

  // The heading uses the parent read; the line grid admits its own fresh record/access read.
  // Wait for this quote's source in the admitted grid before taking row-count snapshots.
  await page.getByText(`Quote #${quote.number}`, { exact: true }).waitFor({ state: "visible" });
  assert.equal(await page.locator("td", { hasText: "Operation" }).count(), 1,
    "the quote's single priced operation must produce exactly one OPERATION row");
  assert.equal(await page.locator("td", { hasText: "needs price" }).count(), 0,
    "the quote-priced line must resolve — the part has no PartPrice, so needs-price here would mean the link failed");
  const opRow = page.locator("tr").filter({ has: page.locator("td", { hasText: "Operation" }) });
  await waitForValue(opRow.getByLabel(/amount$/), "75");
  await shot("invoice-draft-quote-sourced");
  // DELIBERATELY not finalized — see the file header (close warning + closed month + close scope).

  // ---------------------------------------------------------------------------------------
  // 7. Close with a reason: the warn-and-list banner names the open, not-fully-invoiced linked
  //    order (ruling 6 — closing never re-prices; the stored link keeps pricing it).
  // ---------------------------------------------------------------------------------------
  await page.goto(`${ctx.baseURL}/quotes/${quote.id}`);
  await page.getByRole("heading", { name: /^Quote #\d+/ }).waitFor({ state: "visible", timeout: 15000 });
  // Close quote is a More actions item asking through the modal (PR 3, ruling 5): Cancel closes
  // nothing, a blank reason holds the dialog open with the refusal, a typed reason closes.
  const closedBanner = page.locator("p.bg-surface-50").filter({ hasText: "Closed —" });
  const closeQuote = async () => {
    await page.locator("summary", { hasText: "More actions" }).click();
    // The item's accessible name is its label and its sub-line ("Close quote Stops pricing new
    // orders"), so the match is on the label at the start.
    await page.getByRole("menuitem", { name: /^Close quote\b/ }).click();
  };
  await closeQuote();
  assert.match(await modalTitle(page), /^Close quote #\d+\?/);
  await answerModal(page, { confirm: false });
  await assertNeverVisible(closedBanner, "Cancel must close nothing");
  await closeQuote();
  const dialog = page.locator("dialog[open]");
  await dialog.getByRole("textbox").fill("");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog.getByText("A reason is required to close a quote.", { exact: true }).waitFor({ state: "visible" });
  await answerModal(page, { reason: CLOSE_REASON });

  await page.getByText(/1 open order\(s\) still price from this quote and are not yet fully/)
    .waitFor({ state: "visible", timeout: 15000 });
  // Scoped to the amber warning banner: the line card's own "Priced on order(s)" §5.14 indicator
  // links the SAME order number, so a page-wide link lookup resolves two elements.
  const warnBanner = page.locator("div.border-accent-600");
  await warnBanner.getByRole("link", { name: `#${order.number}`, exact: true }).waitFor({ state: "visible" });
  // Scoped to the CLOSED banner, for the same reason as the amber one above — and this scoping is
  // newly REQUIRED by #158. A page-wide lookup for the reason used to resolve one element; it now
  // resolves three, because the History panel refetches on close and shows the same text twice more
  // (the `update` row and its `closeReason: "" → …` diff). That the locator went ambiguous is the
  // fix working end to end: before this group the panel sat stale until a reload, so those two rows
  // simply were not on the page. Assert the banner, and assert the panel separately below.
  await closedBanner.getByText(CLOSE_REASON).waitFor({ state: "visible" });
  // The other half, now that it is real: the panel shows the close WITHOUT a reload (#158). This is
  // the only end-to-end proof of the invalidation — the sweep cannot see an effect, and there is no
  // DOM test environment for one.
  await openRecordTab(page, "Documents & history");
  await page.getByText(`closeReason: "" → "${CLOSE_REASON}"`, { exact: true })
    .waitFor({ state: "visible", timeout: 15000 });
  await shot("quote-closed-linked-order-warning");

  // ---------------------------------------------------------------------------------------
  // 8. The §5.4 worklist: a second quote backdated into BOTH sections — follow-up date in the
  //    past AND already expired (the deliberate same-quote overlap). The closed first quote
  //    appears in neither (worklists are OPEN-only).
  // ---------------------------------------------------------------------------------------
  const quote2 = await createQuoteViaUi(page, ctx, { partNumberText: FOLLOW_UP_PART });
  await openRecordTab(page, "Details & wording");
  await page.getByLabel("Effective", { exact: true }).fill(daysAgo(40));
  await page.getByLabel("Expires", { exact: true }).fill(daysAgo(2));
  await page.getByLabel("Follow-up", { exact: true }).fill(daysAgo(5));
  await saveQuoteForm(page, quote2.id);
  // The heading now carries the derived Expired badge (ruling 3).
  await page.getByRole("heading", { name: /^Quote #\d+.*Expired/ }).waitFor({ state: "visible", timeout: 10000 });
  await shot("quote2-backdated-expired");

  // PR 3: the two worklists are the Follow-up due and Expired presets over the one register
  // (the same server predicates), each a pill that reads pressed while the filters equal it.
  await page.goto(`${ctx.baseURL}/quotes`);
  await page.getByRole("heading", { name: "Quotes", exact: true }).waitFor({ state: "visible" });
  const register = page.getByRole("region", { name: "Quotes list", exact: true });
  const preset = (label) => page.getByRole("button", { name: label, exact: true });
  const quoteLink = (n) => register.getByRole("link", { name: String(n), exact: true });
  // A preset click is a filter edit: the register's rows change only when its read lands, so the
  // click waits for the read that carries the preset's own query (a row the previous view also
  // showed is visible before it, and a count taken then reads the old view).
  const PRESET_QUERY = { "Follow-up due": "followUpDue=1", "Expired": "expired=1" };
  const selectPreset = async (label) => {
    const landed = page.waitForResponse((res) => res.request().method() === "GET"
      && res.url().includes("/api/quotes?") && res.url().includes(PRESET_QUERY[label]) && res.ok());
    await preset(label).click();
    await landed;
  };
  for (const label of ["Follow-up due", "Expired"]) {
    await selectPreset(label);
    await quoteLink(quote2.number).waitFor({ state: "visible", timeout: 15000 });
    assert.equal(await preset(label).getAttribute("aria-pressed"), "true", `${label} is lit`);
    assert.equal(await quoteLink(quote.number).count(), 0,
      `the CLOSED first quote must not sit under ${label} (the worklists are OPEN-only)`);
  }
  await shot("worklist-sections");

  // The follow-up date edited in place (the "bump it a week" action): under Follow-up due a date
  // moved into the future PATCHes the quote, the list is read again and the row leaves it, the
  // tab still lit (review focus 2 of PR 3's plan).
  await selectPreset("Follow-up due");
  await quoteLink(quote2.number).waitFor({ state: "visible", timeout: 15000 });
  const bumped = page.waitForResponse((res) =>
    res.url().endsWith(`/api/quotes/${quote2.id}`) && res.request().method() === "PATCH" && res.ok());
  await register.getByLabel(`Quote ${quote2.number} follow-up date`, { exact: true }).fill(daysAgo(-7));
  await bumped;
  await quoteLink(quote2.number).waitFor({ state: "hidden", timeout: 15000 });
  assert.equal(await preset("Follow-up due").getAttribute("aria-pressed"), "true", "a bump keeps the preset lit");
  await selectPreset("Expired");
  await quoteLink(quote2.number).waitFor({ state: "visible", timeout: 15000 });
  await shot("worklist-bumped");
}
