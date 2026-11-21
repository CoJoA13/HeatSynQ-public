// Flow: the document-template admin screen (Phase 7 Task 16) — the first template-designer screen.
//
// As admin: reach /admin/templates via the Admin > Templates nav entry (NOT a top-level entry —
// the nav decision, spec §5.5), see the 9 document types each with its seeded "Standard" default
// starred, create a template (which opens its v1 draft — "opening a draft"), publish it, and open
// a fresh draft from the published version (the lifecycle end to end).
//
// Then open the Task 17 structured editor on that v2 draft and exercise the contract-driven panels:
// a LOCKED element (the traveler barcode / Process-steps section) renders locked and disabled with
// its §5.6 reason; a free section toggles (and the draft goes dirty); a field label override is set;
// a format knob is picked; the fixture logo is uploaded through the Task 4 sniff/cap route with
// a header placement chosen; and a width typed into a flex column takes a table past the right
// margin on paper, which the Column widths panel warns about in amber without refusing it (#457).
//
// Then Task 18's SAVE + updatedAt-409 CONFLICT UX (the load-bearing §5.13 proof): with those edits
// unsaved, a COMPETING change lands on the same draft from another request (bumping its updatedAt),
// so the editor's save precondition is stale. Saving surfaces the named 409 as a reload-vs-overwrite
// choice: the editor rolls back to server truth FIRST, THEN shows a persistent conflict banner that
// the reload does NOT wipe (§5.13), and the set-aside edits can be re-applied and saved over the new
// version (a deliberate overwrite). This flow drives both — the safe reload AND the overwrite.
//
// Then, re-logged-in as the restricted VIEW-ONLY user (holds templates.view but NOT admin.view):
// prove the nav decision + §5.16 — that user still sees the Templates entry and reaches the page
// (the silent-dead-end rule) while NOT seeing the admin.view-gated entries, and every mutating
// control there is disabled with a tooltip naming the missing permission. The credit-hold /
// permission-gating precedent for a mid-flow re-login.
//
// It runs last in run.mjs's FLOWS but for `backups` (ruling C22): its canvas print needs an order
// of the fixture customer, and entering that order locks E2E-PART-1's current process revision,
// which process-traveler-editor expects to find working. `backups` follows it because the backup
// it takes clears the backup banner this flow's first step waits for.
//
// Then a Shipping ticket template is designed on the canvas from a single-order shipment of that
// order, published and printed, its printed logo and Company name moved as the inspector moved them
// (PR 2b of the shipping ticket canvas lane); the shipment and its ticket ride the customer-scoped
// shipper reap. Then a Bill of lading template is designed on the canvas from that same shipment,
// published and printed, its printed logo and title moved as the inspector moved them and the
// untouched lines left where they were (PR 2 of the bill of lading canvas lane); its stored bills of
// lading ride the same reap, which deletes every StoredDocument by the shipment's id. Then a
// Certification template is designed on the canvas from a load 1 certification of that order, made
// for this path alone, published and printed, its printed logo and title moved as the inspector moved
// them and the part lines' heading and the freeform text left where they were (PR 2 of the
// certification canvas lane); the certification and its stored pages ride the customer-scoped reap,
// which deletes every StoredDocument by the certification's id. Then an Invoice / credit template
// is designed on the canvas from a DRAFT invoice of that order, made for this path alone and never
// finalized, published and printed, its printed logo, Remit To box and identity lines moved as the
// designer moved them and the column headers' Quantity heading left where it was (PR 3 of the
// invoice canvas lane); the invoice, its lines and its stored pages ride the customer-scoped reap
// (`deleteInvoicesAndLines`). Then a Statement template is designed on the canvas from the fixture
// customer, published and printed through the statements route, its printed logo, Remit To box,
// customer line, statement date and Bill To moved as the designer moved them and the open items'
// Document # heading left where it was (PR 2 of the statement canvas lane); its stored statements
// ride the customer-scoped reap (`deleteStatementDocuments`). Then a Quotation template is designed
// on the canvas from a quote of the quote fixture customer, made for this path alone, published and
// printed, its printed logo, quotation number and parties moved as the designer moved them and the
// column headers' Net weight / Price heading left where it was (PR 2 of the quote canvas lane); the
// quote and its stored pages ride the quote customer's reap (`deleteQuotesAndChildren`).
//
// The created templates ("E2E Doc Template", "E2E BOL Template", "E2E Ticket Template", "E2E BOL
// Canvas Template", "E2E Cert Canvas Template", "E2E Invoice Canvas Template", "E2E Statement
// Canvas Template" and "E2E Quote Canvas Template") are fully owned by this flow and reaped by name
// in db-fixtures.ts
// (deleteDocumentTemplatesByName, whose list
// tests/e2e-fixture-lists.test.ts holds to this file's `…_TEMPLATE_NAME` constants); the seeded
// Standard templates are only read, and this flow never sets a type DEFAULT.
//
// ONE ambient claim remains, deliberately (#234's own fix text sanctions it): each document type's
// starred default is asserted to be named exactly "Standard", the seeded name. A dev DB whose owner
// has made their own template the default for some type will red this flow, and `preflight.mjs`
// does not cover it. That is a narrowed, named residual of what #234 removed, not an oversight.
//
// It DOES assign that template to a customer (the Task 20 section below), and the ticket, the bill
// of lading, the certification, the invoice, the statement and the quote canvas templates too — the
// header used to say it never did, a false guarantee corrected with #234. Two things keep that
// honest: each assignment targets this run's OWN fixture customer (the quote's, the quote fixture
// customer), matched by exact code or id, and each is cleared back to use-default/inherit
// in the same section. `deleteDocumentTemplatesByName` also reaps any assignment pointing at this
// flow's template, so a mid-flow failure cannot leave one behind.
import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { login } from "../lib/auth.mjs";
import { assertRailReachableOnShortWindow, railHeadings } from "../lib/rail.mjs";
import { assertNeverVisible, pickCombobox, waitForValue } from "../lib/ui.mjs";
import { printedImages, printedPages, printedRuns, storedPdf } from "../lib/printed-page.mjs";
import { pageCount } from "../../tests/helpers/pdf.ts";
import { openRecordTab } from "../lib/record-tabs.mjs";
import { orderPanel, startNewShipment, waitForShipmentPage } from "../lib/orders.mjs";
import { bounded } from "../lib/order-entry-workspace.mjs";
import { routeRequests } from "../route-keep-alive.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_FIXTURE = path.join(__dirname, "..", "fixtures", "logo.png");

const DOC_TEMPLATE_NAME = "E2E Doc Template";
const BOL_TEMPLATE_NAME = "E2E BOL Template";
const TICKET_TEMPLATE_NAME = "E2E Ticket Template";
const BOL_CANVAS_TEMPLATE_NAME = "E2E BOL Canvas Template";
const CERT_CANVAS_TEMPLATE_NAME = "E2E Cert Canvas Template";
const INVOICE_CANVAS_TEMPLATE_NAME = "E2E Invoice Canvas Template";
const STATEMENT_CANVAS_TEMPLATE_NAME = "E2E Statement Canvas Template";
const QUOTE_CANVAS_TEMPLATE_NAME = "E2E Quote Canvas Template";

/** The quote's canvas items the flow waits for by their exact names: the header's four field items
 *  (each its field's name) and the six blocks (each its section's name and " table"), in the
 *  contract's order. Plain node cannot load the contract (`src/lib/template-contracts/quote.ts`), so
 *  the names are restated here, and tests/e2e-fixture-lists.test.ts holds them to the stage's own
 *  (`itemTitle` over `QUOTE_CONTRACT`). */
const QUOTE_CANVAS_FIELDS = ["Document title", "Company name", "Company address", "Quotation number"];
const QUOTE_CANVAS_BLOCKS = [
  "Attention / quote fields table", "Intro line table", "Column headers table", "Quote lines and prices table",
  "Closing and signature table", "Liability text table",
];

/** Opens a section's Section actions menu and answers its item (PR 13, #828). */
async function sectionItem(page, section, item) {
  const group = page.getByRole("group", { name: section, exact: true });
  await group.locator("summary").click();
  const found = group.getByRole("menuitem", { name: item, exact: true });
  await found.waitFor({ state: "visible" });
  return found;
}

/** Fields & widths, by the Part lines menu's own way there. */
async function openWidths(page) {
  await openRecordTab(page, "Sections");
  await (await sectionItem(page, "Part lines", "Edit fields and widths")).click();
  await page.getByRole("tabpanel", { name: "Fields & widths" }).waitFor({ state: "visible" });
}
/** Waits until `locator`'s value is no longer `previous`, and answers the new one. */
async function changedFrom(locator, previous, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await locator.inputValue();
    if (value !== previous) return value;
    assert.ok(Date.now() < deadline, `${what}: the box still reads ${JSON.stringify(previous)}`);
    await delay(50);
  }
}

/** Fails unless `actual` is within 2 pt of `expected` (ruling C20's tolerance). */
function within2pt(actual, expected, what) {
  assert.ok(Math.abs(actual - expected) <= 2, `${what}: ${actual.toFixed(2)} pt, where ${expected.toFixed(2)} pt ± 2 was expected`);
}

/** The canvas's grid step in points: `CANVAS_GRID` (`src/lib/template-contracts/canvas.ts`, which
 *  plain node cannot load), restated. A drop snaps to it. */
const CANVAS_GRID = 4.5;

/** The stage's title on a table the picked record leaves empty (#958): `DESIGNER_WORDS.printsNothing`
 *  (`src/lib/canvas-designer.ts`, which plain node cannot load), restated. */
const PRINTS_NOTHING = "Prints nothing for this record";

/** Fails unless a dragged move `actual` is within half a grid step (the drop's snap) and 2 pt of the
 *  `dragged` amount. */
function withinSnap(actual, dragged, what) {
  const tolerance = CANVAS_GRID / 2 + 2;
  assert.ok(Math.abs(actual - dragged) <= tolerance,
    `${what}: ${actual.toFixed(2)} pt, where the dragged ${dragged.toFixed(2)} pt ± ${tolerance} was expected`);
}

const DOC_TYPES = [
  "Traveler", "Shipping ticket", "Multi-order shipping ticket", "Bill of lading",
  "Certification", "Invoice / credit", "Statement", "Quotation", "Container tag",
];

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;

  // --- As admin: reach the screen via the Configuration > Document templates rail entry. The
  // admin's rail is the tallest one the app renders (all seven groups) and the fixture admin sees
  // all three banners above the Shell (setup unfinished, default password, no backup yet), so this
  // is where the short-window rule is proved: from the top of the page, under the banners, the rail
  // fits the window and scrolls to its last entry; it re-fits when the page scrolls past the
  // banners and when the password reminder is dismissed in place (e2e/lib/rail.mjs). ---
  await assertRailReachableOnShortWindow(page, "admin rail", {
    banners: [
      page.getByText(/Setup isn.t finished/),
      page.getByText(/still uses the default password/),
      page.getByLabel("Backup status"),
    ],
    dismiss: page.getByRole("button", { name: "Not now" }),
  });
  assert.deepEqual(
    await railHeadings(page),
    ["Daily work", "Billing", "Reference", "Configuration", "People", "System"],
    "the admin sees every headed group",
  );
  const navTemplates = page.getByRole("link", { name: "Document templates", exact: true });
  await navTemplates.waitFor({ state: "visible" });
  await navTemplates.click();
  await page.waitForURL(`${ctx.baseURL}/admin/templates`);
  await page.getByRole("heading", { name: "Document templates" }).waitFor({ state: "visible" });

  // The list loads via an async GET /api/templates, so the rows appear AFTER the (static) heading —
  // and on the E2E run this route is compiled by `next dev` on first hit, widening that gap to
  // seconds. `locator.count()` does NOT auto-wait, so wait for the list to render (a starred
  // default is visible) before counting, or the count reads 0 against an empty list.
  await page.locator('li [aria-label="default"]').first().waitFor({ state: "visible" });

  // #234: assert PER DOCUMENT TYPE, never plant-wide. The old form counted every list item whose
  // text contained "Standard" and every starred row on the page, expecting exactly one of each per type — a
  // claim about the whole plant that any custom template breaks, on a dev DB the run does not own.
  // Each type's list carries an aria-label, so the scope is the type's own <ul>.
  async function assertStandardDefault(typeName) {
    // `exact: true` is LOAD-BEARING: getByRole's name option is a case-insensitive SUBSTRING
    // match by default, and "Shipping ticket" is a substring of "Multi-order shipping ticket" —
    // so the loose form matched two lists and died on a strict-mode violation (caught by the
    // E2E run, not by reading).
    const list = page.getByRole("list", { name: typeName, exact: true });
    await list.waitFor({ state: "visible" });
    const starred = list.locator("li").filter({ has: page.locator('[aria-label="default"]') });
    assert.equal(await starred.count(), 1, `${typeName}: exactly one starred default template`);
    // Exact name, not a substring: "Standard Plus" must not satisfy "the seeded default is Standard".
    await starred.getByText("Standard", { exact: true }).waitFor({ state: "visible" });
  }

  // All 9 document types are offered (the create picker) and each has its Standard default starred.
  const docTypePicker = page.getByRole("combobox", { name: "New template document type" });
  await assert.equal(await docTypePicker.locator("option").count(), 9, "the create picker offers all 9 document types");
  assert.deepEqual(
    await docTypePicker.locator("option").allTextContents(), DOC_TYPES,
    "the 9 document types render in spec order",
  );
  for (const typeName of DOC_TYPES) await assertStandardDefault(typeName);
  await shot("templates-list-9-types-standard-starred");

  // --- Create a template under Traveler — creating opens its v1 draft ---
  await docTypePicker.selectOption("TRAVELER");
  await page.getByPlaceholder("Template name").fill(DOC_TEMPLATE_NAME);
  await page.getByRole("button", { name: "Create template" }).click();

  const newRow = page.getByRole("listitem").filter({ hasText: DOC_TEMPLATE_NAME });
  await newRow.waitFor({ state: "visible" });
  // The v1 draft is open (create opened it) and the row is NOT the default (star is the default's).
  await newRow.getByText("Draft", { exact: true }).waitFor({ state: "visible" });
  await assert.equal(
    await newRow.locator('[aria-label="default"]').count(), 0,
    "a freshly created template is not the default (it carries no star)",
  );
  await shot("template-created-with-open-draft");

  // Establish an unselected precondition through the real seeded Traveler selector. Creating the
  // template already selected it, so activating it immediately would not prove its callback works.
  const travelerList = page.getByRole("list", { name: "Traveler", exact: true });
  const standardRow = travelerList.getByRole("listitem").filter({
    has: page.getByText("Standard", { exact: true }),
  });
  const standardSelector = standardRow.getByRole("button");
  assert.equal(await standardSelector.count(), 1,
    "the seeded Standard Traveler template must expose one native selector button");
  await standardSelector.focus();
  await page.keyboard.press("Enter");
  // The default star contributes "default" to the heading's accessible name.
  await page.getByRole("heading", { name: /Standard$/ }).waitFor({ state: "visible" });

  const templateSelector = travelerList.getByRole("button", { name: new RegExp(`^${DOC_TEMPLATE_NAME}`) });
  assert.equal(await templateSelector.count(), 1,
    "the new Traveler template must expose one native selector button");
  assert.equal(await standardSelector.getAttribute("aria-current"), "true",
    "the seeded Standard template must become current before the keyboard transition");
  assert.equal(await templateSelector.getAttribute("aria-current"), null,
    "the created template must be unselected before keyboard activation");
  await assertNeverVisible(
    page.getByText("Open draft: v1", { exact: true }),
    "the created template's lifecycle detail must be absent while Standard is selected",
    500,
  );

  // Select the created template — the detail pane transitions back to its open v1 draft.
  await templateSelector.focus();
  await page.keyboard.press("Enter");
  await page.getByText("Open draft: v1").waitFor({ state: "visible" });
  assert.equal(await templateSelector.getAttribute("aria-current"), "true",
    "the selected template button must expose current state");
  assert.equal(await standardSelector.getAttribute("aria-current"), null,
    "keyboard selection must clear current state from the previous template");

  // Publish the draft (admin holds the edit_templates special) — v1 becomes the published version.
  await page.getByRole("button", { name: "Publish saved draft", exact: true }).click();
  await newRow.getByText("Published v1").waitFor({ state: "visible" });

  // Open a fresh draft from the published version (the ordinary edit-after-publish path) — v2.
  await page.getByRole("button", { name: "Open draft", exact: true }).click();
  await page.getByText("Open draft: v2").waitFor({ state: "visible" });
  await shot("template-published-then-redrafted-v2");

  // --- The structured editor (Task 17): open the v2 draft and exercise the contract-driven panels ---
  // The panels are exercised first; Task 18's SAVE + updatedAt-409 conflict UX follows below.
  await page.getByRole("link", { name: "Edit draft" }).click();
  await page.waitForURL(new RegExp(`${ctx.baseURL}/admin/templates/[^/]+/edit`));
  await page.getByRole("heading", { name: DOC_TEMPLATE_NAME }).waitFor({ state: "visible" });
  await page.getByText("Traveler · editing draft v2").waitFor({ state: "visible" });

  // A LOCKED element renders locked and its controls are disabled (spec §5.6): the traveler barcode
  // and the whole Process-steps section cannot be hidden — the padlock + reason are shown.
  const barcodeToggle = page.getByRole("checkbox", { name: "Show field Order barcode" });
  await barcodeToggle.waitFor({ state: "visible" });
  assert.equal(await barcodeToggle.isDisabled(), true, "the locked barcode field cannot be hidden");
  const hideSteps = await sectionItem(page, "Process steps", "Hide section");
  assert.equal(await hideSteps.isDisabled(), true, "the locked steps section cannot be hidden");
  await page.getByRole("group", { name: "Process steps", exact: true }).locator("summary").click();
  await page.locator('[aria-label^="locked:"]').first().waitFor({ state: "visible" });
  await shot("editor-locked-elements");

  // Toggle a FREE section (Part lines is hideable) — it flips and the draft is marked dirty.
  const partLinesHidden = page.getByRole("group", { name: "Part lines", exact: true }).getByText("Hidden", { exact: true });
  const hidePartLines = await sectionItem(page, "Part lines", "Hide section");
  assert.equal(await hidePartLines.isDisabled(), false, "a hideable section's item is enabled");
  await hidePartLines.click();
  await partLinesHidden.waitFor({ state: "visible" });
  await page.getByText("Unsaved changes").waitFor({ state: "visible" });

  // Set a LABEL override on a free field.
  const labelInput = page.getByRole("textbox", { name: "Label for Order number" });
  await labelInput.fill("Work Order #");
  assert.equal(await labelInput.inputValue(), "Work Order #", "the label override is held in state");

  // Pick a FORMAT knob — the traveler declares thousands grouping (the FormatsPanel renders exactly
  // the knobs the contract declares; the billing docs' negative-style/date dropdowns are the same
  // panel, no per-type branch).
  await openRecordTab(page, "Appearance");
  const thousands = page.getByRole("checkbox", { name: "Group thousands" });
  await thousands.waitFor({ state: "visible" });
  const wasGrouped = await thousands.isChecked();
  await thousands.setChecked(!wasGrouped);
  assert.equal(await thousands.isChecked(), !wasGrouped, "the format knob flips");

  // Upload the FIXTURE logo (the Task 4 route sniffs + caps the bytes) and choose a placement.
  await page.getByText("No image uploaded").waitFor({ state: "visible" });
  await page.getByLabel("Upload logo image").setInputFiles(LOGO_FIXTURE);
  await page.getByText(/Image on file \(image\/png\)/).waitFor({ state: "visible" });
  await page.getByRole("combobox", { name: "Logo placement" }).selectOption("header-left");
  await shot("editor-panels-exercised-logo-uploaded");

  // --- #991: a table whose headings pass the page is warned about, never refused ---
  // Type 150pt into the quantities table's Order quantity column. Its columns and their padding then
  // take 530pt and the flexible Container column keeps 34pt, under the 34.8pt its heading needs: the
  // column clamp keeps the table inside the page and the heading breaks, which the amber status under
  // the table says (owner ruling 2026-11-15). A table whose fixed columns and padding pass the page is
  // refused instead (owner ruling R-B, 2026-11-17), so the #457 past-the-margin warning this block
  // once raised is gone. The typed width is one of the unsaved edits the 409 below sets aside and
  // re-applies.
  const QUANTITIES_HEADINGS_BREAK =
    "On paper the “quantities” table's flexible column has what its fixed columns leave: Container gets 34 pt, " +
    "under the 34.8 pt its widest heading word needs, so its heading words break inside their cells. Its headings " +
    "print whole from 564.8 pt wide, past the 564 pt content width. You can still save. Narrow a column to fit.";
  // The quantities table's block under Column widths: the nearest div above its width total that
  // holds its list of columns.
  const quantitiesBlock = page.getByLabel("quantities width total", { exact: true })
    .locator("xpath=ancestor::div[ul][1]");
  // `exact: true` is LOAD-BEARING: the same table has a "Width for Containers" box (the Containers
  // column), and the name option is a substring match by default, so the loose form matches both.
  const containerWidth = quantitiesBlock.getByRole("spinbutton", { name: "Width for Container", exact: true });
  const orderQtyWidth = quantitiesBlock.getByRole("spinbutton", { name: "Width for Order quantity", exact: true });
  const containerRow = containerWidth.locator("xpath=ancestor::li[1]");
  const quantitiesStatus = quantitiesBlock.getByRole("status");
  const headingsWarning = quantitiesBlock.getByText(QUANTITIES_HEADINGS_BREAK, { exact: true });
  await openWidths(page);
  assert.equal(await containerRow.getByText("flex column (fills remaining width)", { exact: true }).count(), 1,
    "the Container column reads as flex while its box is empty");
  await orderQtyWidth.fill("150");
  await headingsWarning.waitFor({ state: "visible" });
  assert.equal(await headingsWarning.getAttribute("role"), "status",
    "the headings warning is the warning status under the quantities table");
  const headingsWarningClass = (await headingsWarning.getAttribute("class")) ?? "";
  assert.ok(/\bbg-accent-50\b/.test(headingsWarningClass),
    `the headings warning has the warning background, its class reading "${headingsWarningClass}"`);
  assert.ok(/\btext-accent-600\b/.test(headingsWarningClass),
    `the headings warning has the warning text, its class reading "${headingsWarningClass}"`);
  assert.equal(await quantitiesStatus.count(), 1, "one amber line under the quantities table");
  assert.equal(await quantitiesBlock.getByRole("alert").count(), 0,
    "the fixed columns and their padding fit the page, so nothing is refused");
  assert.equal(await containerRow.getByText("flex column (fills remaining width)", { exact: true }).count(), 1,
    "the Container column stays flex beside the typed Order quantity");
  await shot("editor-width-headings-break-warning");

  // --- Task 18: the updatedAt-409 conflict UX (reload-vs-overwrite, HANDOFF §5.13) ---
  // The editor now holds several UNSAVED edits (the hidden Part-lines section, the "Work Order #"
  // label, the flipped format knob, the header logo placement, the typed Container width). Land a
  // COMPETING change on the same draft from another request so the editor's save precondition goes
  // stale.
  const templateId = page.url().match(/\/admin\/templates\/([^/]+)\/edit/)[1];
  assert.ok(templateId, "extracted the template id from the editor URL");

  // Read the current server draft and PATCH it back with a real change (flip the page footer),
  // matching its own updatedAt so this competing write succeeds and advances updatedAt past what the
  // editor loaded. The read shares the browser context's cookies, so it acts as this same admin.
  //
  // The WRITE goes through `ctx.apiMutate` rather than the APIRequestContext directly (#184 fix
  // round, finding 1): Playwright emits no context request/response event for one, so a raw call
  // here is a real dev-DB write the retry gate's mutation counters cannot see — it would read
  // "this flow changed nothing" and re-run the flow from step 1. `run.mjs` refuses the whole run
  // on a raw one now, so this is enforced rather than remembered.
  const draftBefore = await (await page.request.get(`${ctx.baseURL}/api/templates/${templateId}`, { maxRetries: 1 })).json();
  const competing = { ...draftBefore.draft.config, pageFooter: !draftBefore.draft.config.pageFooter };
  const competingRes = await ctx.apiMutate(page, `${ctx.baseURL}/api/templates/${templateId}/draft`, {
    method: "PATCH",
    data: { config: competing, updatedAt: draftBefore.draft.updatedAt },
  });
  assert.equal(competingRes.ok(), true, "the competing change saved, bumping the draft's updatedAt");

  // Save the editor's stale edits → the named 409, surfaced as the conflict banner. The editor rolls
  // back to server truth FIRST, THEN shows the banner — §5.13, so the reload never wipes it.
  await page.getByRole("button", { name: "Save draft" }).click();
  const conflictBanner = page.getByText(/reloaded the current draft/i);
  await conflictBanner.waitFor({ state: "visible" });
  await shot("editor-save-conflict-banner");

  // The reload DID roll back to server truth: the section the stale edit had hidden is visible again
  // and the stale label override is gone — the editor shows the current draft, not the stale edits.
  await openRecordTab(page, "Sections");
  assert.equal(await partLinesHidden.count(), 0, "the reload restored the section the stale edit had hidden");
  assert.equal(await labelInput.inputValue(), "", "the reload discarded the stale label override");
  await openRecordTab(page, "Fields & widths");
  // The typed Order quantity width went with them, and so did the warning it raised.
  await quantitiesStatus.waitFor({ state: "hidden" });
  assert.equal(await orderQtyWidth.inputValue(), "", "the reload discarded the typed Order quantity width");
  assert.equal(await quantitiesStatus.count(), 0, "the reload took the headings warning away");
  // ...and the banner SURVIVED that reload — the load-bearing §5.13 assertion.
  assert.equal(await conflictBanner.isVisible(), true, "the conflict banner persists through the reload");

  // The overwrite half of the choice: re-apply the set-aside edits onto the fresh precondition and
  // save over the competing version. Acting on the conflict clears the banner and the save succeeds.
  await page.getByRole("button", { name: "Re-apply my changes" }).click();
  await conflictBanner.waitFor({ state: "hidden" }); // acting on the conflict dismissed the banner
  await openRecordTab(page, "Sections");
  await partLinesHidden.waitFor({ state: "visible" }); // re-apply put the stale edits back onto server truth
  await openRecordTab(page, "Fields & widths");
  // The typed width came back with them, and so did its warning. The save below still lands,
  // because the warning refuses nothing.
  await headingsWarning.waitFor({ state: "visible" });
  assert.equal(await orderQtyWidth.inputValue(), "150", "re-apply put the typed Order quantity width back");
  assert.equal(await quantitiesStatus.textContent(), QUANTITIES_HEADINGS_BREAK,
    "re-apply brought the headings warning back under the quantities table");
  // The typed width is emptied again before the save, so the canvas below is seeded from the
  // Standard's quantities, as it was before #991. Emptied, the warning goes with it.
  await orderQtyWidth.fill("");
  await quantitiesStatus.waitFor({ state: "hidden" });
  assert.equal(await containerRow.getByText("flex column (fills remaining width)", { exact: true }).count(), 1,
    "the Container column still reads as flex");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.locator("span", { hasText: /^Saved$/ }).waitFor({ state: "visible" });
  await shot("editor-conflict-overwrite-saved");
  // The template — logo bytes and the now-saved config — is reaped by name in teardown.

  // --- An order of the fixture customer (PR C of #926, ruling C3), entered through New order ---
  // The Preview picker and the canvas below need an order this run owns: a focused run has no other,
  // and another customer's order would print through that customer's template, not this one. The
  // draft above is saved, so leaving the editor sets nothing aside. The customer-scoped teardown
  // (`deleteOrdersAndChildren`) reaps the order, its loads and the travelers printed from it.
  await page.goto(`${ctx.baseURL}/orders/new`);
  await pickCombobox(page, "Customer", fixtures.customerCode, new RegExp(`^${fixtures.customerCode}`));
  await page.getByRole("tab", { name: "Parts & containers", exact: true }).click();
  await pickCombobox(page, "Line 1 part", fixtures.partNumber, new RegExp(`^${fixtures.partNumber}`));
  await page.getByLabel("Line 1 quantity", { exact: true }).fill("10");
  await page.getByRole("tab", { name: "Process & loads", exact: true }).click();
  await page.getByText("Fully allocated · 0 pieces remaining", { exact: true }).waitFor();
  const orderResponse = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/orders" && r.request().method() === "POST");
  await page.getByRole("button", { name: "Save only", exact: true }).click();
  const savedOrderResponse = await orderResponse;
  assert.equal(savedOrderResponse.ok(), true, "the fixture customer's order saves");
  const savedOrder = await savedOrderResponse.json();
  if (savedOrder.warnings.length) {
    await page.getByText(/^Order #\d+ saved\.$/).waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: "Go to order", exact: true }).click();
  }
  const hubHeading = page.getByRole("heading", { name: /^Order #\d+/ });
  await hubHeading.waitFor();
  const orderNumber = Number(((await hubHeading.textContent()) ?? "").match(/#(\d+)/)?.[1]);
  assert.ok(Number.isSafeInteger(orderNumber), "the hub names the saved order's number");
  const orderId = page.url().split("/").pop();
  // The Preview picker's own words for the order (PreviewPane's `optionsFor`).
  const orderLabel = `#${orderNumber} — ${fixtures.customerCode} — ${fixtures.partNumber}`;
  await page.goto(`${ctx.baseURL}/admin/templates/${templateId}/edit`);
  await page.getByText("Traveler · editing draft v2").waitFor({ state: "visible" });

  // --- Task 19: the live PREVIEW pane (side-effect-free render of the WORKING config) ---
  // Pick the order this run entered above, by its picker label, and render a preview. The preview
  // POSTs the editor's WORKING config to /api/templates/<id>/preview and streams a PDF — nothing is
  // saved, printed, or archived.
  await openRecordTab(page, "Preview");
  const recordSelect = page.getByRole("combobox", { name: "Preview record" });
  await recordSelect.waitFor({ state: "visible" });
  await recordSelect.selectOption({ label: orderLabel });

  // `bodyLabel` reads a field's label override out of a submitted config — the preview's proof is
  // that the config the pane POSTs is the WORKING one, edits and all.
  const bodyLabel = (config, section, field) =>
    config.sections.find((s) => s.key === section)?.fields.find((f) => f.key === field)?.label ?? null;

  // Preview 1: the working config already carries the re-applied "Work Order #" override, so it
  // must ride in the POST body — and the rendered PDF appears in the iframe.
  const [previewReq1] = await Promise.all([
    page.waitForRequest((r) => r.url().includes(`/api/templates/${templateId}/preview`) && r.method() === "POST"),
    page.getByRole("button", { name: "Generate preview" }).click(),
  ]);
  assert.equal(
    bodyLabel(previewReq1.postDataJSON().config, "header", "order_number"), "Work Order #",
    "the preview POSTs the WORKING config (the saved 'Work Order #' override rides in the body)",
  );
  await page.getByTitle("Template preview").waitFor({ state: "visible" });
  await shot("editor-preview-rendered");

  // Edit the label again and RE-preview — the second POST must carry the just-made edit, proving
  // the preview reflects the working config live (the unit suite proves the byte shows up).
  await openRecordTab(page, "Sections");
  await labelInput.fill("PREVIEW-EDIT-Order");
  await openRecordTab(page, "Preview");
  const [previewReq2] = await Promise.all([
    page.waitForRequest((r) => r.url().includes(`/api/templates/${templateId}/preview`) && r.method() === "POST"),
    page.getByRole("button", { name: "Generate preview" }).click(),
  ]);
  assert.equal(
    bodyLabel(previewReq2.postDataJSON().config, "header", "order_number"), "PREVIEW-EDIT-Order",
    "the re-preview reflects the just-made label edit — the WORKING config, not the saved one",
  );
  await page.getByTitle("Template preview").waitFor({ state: "visible" });
  await shot("editor-preview-reflects-edit");

  // --- Task 20: the customer-page template-assignment picker (§5.2, §5.15, §5.16) ---
  // Still as admin. Assign the just-published "E2E Doc Template" (a Traveler template) to THIS
  // RUN'S OWN fixture customer through the picker, watch the resolved state reflect it, then clear
  // back to the type's default. The page's request context shares the browser cookies, so it reads
  // /api/customers as this admin.
  //
  // #234: this used to take `customers[0]` — the alphabetically-FIRST customer in the dev DB.
  // `listCustomers` orders by code ascending and every fixture customer is E2E*-coded, so any
  // ambient customer ("ACME") sorted first and won: the flow then asserted that stranger's picker
  // state and PUT a real, audited assignment onto a row the run does not own. Matching the fixture
  // by its exact code is every other flow's pattern.
  const customers = await (await page.request.get(`${ctx.baseURL}/api/customers`, { maxRetries: 1 })).json();
  assert.ok(Array.isArray(customers), "the customers list reads as an array");
  const target = customers.find((c) => c.code === fixtures.customerCode);
  assert.ok(target, `the fixture customer ${fixtures.customerCode} is present to assign a template to`);
  await page.goto(`${ctx.baseURL}/customers/${target.id}`);
  await openRecordTab(page, "Defaults & documents"); // the templates picker is on that tab (PR 8)

  // The picker is its own section; its two reads (the requireUser-only names + the customers.view
  // resolved state) are async and compiled by `next dev` on first hit, so wait for the Traveler
  // select to render rather than the loading line.
  const travelerPicker = page.getByRole("combobox", { name: "Template for Traveler" });
  await travelerPicker.waitFor({ state: "visible" });
  // The FIXTURE customer carries no TRAVELER assignment before this flow (#234: previously stated
  // of whichever customer sorted first, which is not this run's to claim), so the select starts on
  // the use-default/inherit option (§5.15 shows the resolved state beside it, never blank).
  assert.equal(await travelerPicker.inputValue(), "",
    `${fixtures.customerCode}'s Traveler picker starts on use-default/inherit`);

  // Assign the published template — the PUT lands and the resolved state reloads to show it OWNED.
  // #677: the PUT is held, and the select must show the pick while it is out, where it used to snap
  // back to use-default/inherit until the PUT and the re-read after it had both landed.
  const assignUrl = `${ctx.baseURL}/api/customers/${target.id}/template-assignments`;
  let letGo;
  const release = new Promise((resolve) => { letGo = resolve; });
  let heard;
  const arrived = new Promise((resolve) => { heard = resolve; });
  const holdPut = async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    heard();
    await release;
    await route.continue();
  };
  const stopHolding = await routeRequests(page, assignUrl, holdPut);
  try {
    await travelerPicker.selectOption({ label: DOC_TEMPLATE_NAME });
    await bounded(arrived, "picking a template must send its PUT");
    const shown = await travelerPicker.evaluate((el) => el.selectedOptions[0]?.textContent ?? "");
    assert.equal(shown.trim(), DOC_TEMPLATE_NAME, "the select shows the pick while its PUT is out (#677)");
  } finally {
    letGo();
  }
  await page.getByText(`Assigned: ${DOC_TEMPLATE_NAME}`).waitFor({ state: "visible" });
  await stopHolding();
  assert.notEqual(await travelerPicker.inputValue(), "", "the picker now holds the assigned template id");
  await shot("customer-template-assigned");

  // --- PR C of #926: the traveler designed on a canvas, published and printed (rulings C4, C20) ---
  // The fixture customer is assigned this template, so its order's traveler prints from the
  // template's published version. First the draft above (the sections layout, its logo at
  // header-left) is published and load 1 printed: today's paper, which the canvas's seed lays out.
  // A new draft is designed on the canvas from that order, two items dragged, the Company name also
  // typed and nudged by the keyboard, the draft saved and published, and load 1 printed again. For the Company name's text and the logo's image, the
  // printed move equals the inspector's move (ruling C20: a delta, so the gap between a box's top
  // and its text's baseline never enters it), and the barcode's image does not move.
  const printLoad1 = async (what) => {
    const printed = await ctx.apiMutate(page, `${ctx.baseURL}/api/orders/${orderId}/traveler?load=1`, { method: "POST" });
    assert.equal(printed.ok(), true, `${what}: the traveler prints`);
    const documentId = printed.headers()["x-document-id"];
    assert.ok(documentId, `${what}: the print names its stored document`);
    return storedPdf(page, ctx.baseURL, documentId, what);
  };
  /** Opens the templates list and selects the template `name` in the type's list `list`; answers
   *  its row. `exact: true` on the list is load-bearing: "Shipping ticket" is a substring of
   *  "Multi-order shipping ticket". */
  const selectTemplate = async ({ list = "Traveler", name = DOC_TEMPLATE_NAME } = {}) => {
    await page.goto(`${ctx.baseURL}/admin/templates`);
    await page.getByRole("heading", { name: "Document templates" }).waitFor({ state: "visible" });
    const typeList = page.getByRole("list", { name: list, exact: true });
    await typeList.getByRole("button", { name: new RegExp(`^${name}`) }).click();
    return typeList.getByRole("listitem").filter({ hasText: name });
  };
  /** Publishes the template's saved draft `version` (the traveler's by default). */
  const publishDraft = async (version, which = {}) => {
    const row = await selectTemplate(which);
    await page.getByText(`Open draft: v${version}`).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Publish saved draft", exact: true }).click();
    await row.getByText(`Published v${version}`).waitFor({ state: "visible" });
  };
  const settings = await (await page.request.get(`${ctx.baseURL}/api/admin/settings`, { maxRetries: 1 })).json();
  const companyName = settings.find((setting) => setting.key === "company_name")?.value;
  assert.ok(typeof companyName === "string" && companyName.trim() !== "", "the plant's company name is set, so the traveler prints one");
  /** A printed phrase: its first run's place, where one run per word prints the phrase whole. */
  const phraseRun = (runs, phrase, what, name) => {
    const words = phrase.trim().split(/\s+/);
    const starts = runs.flatMap((run, index) =>
      words.every((word, offset) => runs[index + offset]?.text.trim() === word) ? [run] : []);
    assert.equal(starts.length, 1,
      `${what}: ${name} ${JSON.stringify(phrase)} prints once, word by word, among ${JSON.stringify(runs.map((run) => run.text))}`);
    return starts[0];
  };
  /** The printed Company name. */
  const companyRun = (runs, what) => phraseRun(runs, companyName, what, "the company name");
  // The fixture logo is 160 × 48 px and prints in proportion; the barcode is the other image.
  const LOGO_ASPECT = 160 / 48;
  const imagesOf = (boxes, what) => {
    assert.equal(boxes.length, 2, `${what}: page 1 paints two images, the logo and the barcode`);
    const logos = boxes.filter((box) => Math.abs(box.w / box.h - LOGO_ASPECT) < 0.05);
    assert.equal(logos.length, 1, `${what}: one image is the logo, in its 160:48 proportions: ${JSON.stringify(boxes)}`);
    return { logo: logos[0], barcode: boxes.find((box) => box !== logos[0]) };
  };
  // Page 1 of load 1, whatever the print's length (ruling C23): run after process-traveler-editor,
  // the part's later revision and its Load quantity can make a longer steps table, and the logo,
  // the Company name and the barcode print on page 1 whatever follows. The readers are handed the
  // stored document's own page count, which they hold the decoded pages to.
  const paperOf = (bytes, what) => {
    const pages = pageCount(bytes);
    return {
      company: companyRun(printedRuns(bytes, { pages, what })[0], what),
      ...imagesOf(printedImages(bytes, { pages, what })[0], what),
    };
  };

  // v2 is published here, before the canvas path, because the published v1 carries no logo: the
  // logo was uploaded on the v2 draft, so only v2's paper has the logo the drag is measured against.
  // The delta therefore also rests on the seed reproducing this sections paper: a seed that drifted
  // from it would read below as a wrong move, not as a wrong seed.
  await publishDraft(2);
  const before = paperOf(await printLoad1("the sections traveler"), "the sections traveler");
  await page.getByRole("button", { name: "Open draft", exact: true }).click();
  await page.getByText("Open draft: v3").waitFor({ state: "visible" });
  await page.getByRole("link", { name: "Edit draft" }).click();
  await page.waitForURL(`${ctx.baseURL}/admin/templates/${templateId}/edit`);
  await page.getByText("Traveler · editing draft v3").waitFor({ state: "visible" });

  // The live page sits beside the stage only once the Design panel itself is 76 rem wide (ruling
  // C28), and under it otherwise, as at this 1440 window, whose rail and status card take their share.
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 1440, height: 900 });
  const designOnCanvas = page.getByRole("button", { name: "Design on a canvas", exact: true });
  await openRecordTab(page, "Sections");
  await designOnCanvas.waitFor({ state: "visible" });
  assert.equal(await designOnCanvas.isDisabled(), true, "Design on a canvas waits for an order picked in Preview");
  assert.equal(await designOnCanvas.getAttribute("title"), "Pick an order in Preview first");
  await openRecordTab(page, "Preview");
  await page.getByRole("combobox", { name: "Preview record" }).selectOption({ label: orderLabel });
  await openRecordTab(page, "Sections");
  await designOnCanvas.click();
  const confirm = page.getByRole("dialog");
  await confirm.waitFor({ state: "visible" });
  await confirm.getByRole("button", { name: "Design on a canvas", exact: true }).click();
  await confirm.waitFor({ state: "hidden" });
  // The seed opens the Design tab; the Sections tab is gone while the template has a canvas.
  const designPanel = page.getByRole("tabpanel", { name: /^Design(\s*Unsaved changes)?$/ });
  await designPanel.waitFor({ state: "visible" });
  assert.equal(await page.getByRole("tab", { name: /^Sections/ }).count(), 0, "a canvas template shows Design in place of Sections");
  const canvasItems = page.getByRole("list", { name: "Canvas items", exact: true });
  const logoItem = canvasItems.getByRole("listitem", { name: "Logo", exact: true });
  const companyItem = canvasItems.getByRole("listitem", { name: "Company name", exact: true });
  await logoItem.waitFor({ state: "visible" });
  await companyItem.waitFor({ state: "visible" });
  // The live page renders the seeded canvas by itself (no button): its first page shows.
  const livePage = page.getByTitle("Live page");
  await livePage.waitFor({ state: "visible" });
  await shot("canvas-seeded");

  const xBox = designPanel.getByLabel("X (in)", { exact: true });
  const yBox = designPanel.getByLabel("Y (in)", { exact: true });
  /** Selects `item` (a focus selects it) and answers the inspector's X and Y as shown, in inches. */
  const inspect = async (item, name) => {
    await item.focus();
    await designPanel.getByRole("heading", { name, exact: true, level: 3 }).waitFor({ state: "visible" });
    return { x: await xBox.inputValue(), y: await yBox.inputValue() };
  };
  /** Where a drag grabs `item`, scrolled into view: a quarter in from its left edge, clear of the
   *  selected item's handles, at its middle height, in the viewport's px; and the stage's px per pt,
   *  its width over the page's 612 pt. */
  const grabPoint = async (item, name) => {
    await item.scrollIntoViewIfNeeded();
    const box = await item.boundingBox();
    const stage = await canvasItems.boundingBox();
    assert.ok(box && stage, `${name}: the item and the stage are on screen`);
    return { x0: box.x + box.width / 4, y0: box.y + box.height / 2, scale: stage.width / 612 };
  };
  /** Drags `item` by (dx, dy) points: the pointer goes down at its grab point (`grabPoint`), moves
   *  in steps and comes up. Answers the inspector's X and Y once both have changed. */
  const drag = async (item, from, dx, dy, name) => {
    const { x0, y0, scale } = await grabPoint(item, name);
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x0 + dx * scale, y0 + dy * scale, { steps: 8 });
    await page.mouse.up();
    return { x: await changedFrom(xBox, from.x, `${name} X after the drag`), y: await changedFrom(yBox, from.y, `${name} Y after the drag`) };
  };
  /** Drags `item` straight down by `dy` points (up, for a negative `dy`), from its grab point in
   *  the same steps as `drag`, and answers the inspector's Y once it has changed from `fromY`:
   *  `drag` waits for both boxes, and a block drawn the full width between the margins moves down
   *  alone. */
  const dragY = async (item, fromY, dy, name) => {
    const { x0, y0, scale } = await grabPoint(item, name);
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x0, y0 + dy * scale, { steps: 8 });
    await page.mouse.up();
    return changedFrom(yBox, fromY, `${name} Y after the drag`);
  };
  /** What the pointer lands on at `item`'s grab point: "the item" when it is the list item itself
   *  (an item's drawing takes no pointer), else the list item, or the element, it lands on. */
  const hitAt = async (item, name) => {
    const { x0, y0 } = await grabPoint(item, name);
    return item.evaluate((el, [x, y]) => {
      const hit = document.elementFromPoint(x, y);
      if (hit === el) return "the item";
      return hit?.closest("[role=listitem]")?.getAttribute("aria-label") ?? hit?.tagName ?? "nothing";
    }, [x0, y0]);
  };
  const logoFrom = await inspect(logoItem, "Logo");
  const logoTo = await drag(logoItem, logoFrom, 36, 18, "Logo");
  const companyFrom = await inspect(companyItem, "Company name");
  const companyDragged = await drag(companyItem, companyFrom, 18, 9, "Company name");
  // An inch figure typed off the grid is kept as typed while its box has the cursor and shows the
  // stored, snapped figure once it is left (ruling C15): 1.1 in snaps to 81 pt, 1.125 in.
  await xBox.fill("1.1");
  assert.equal(await xBox.inputValue(), "1.1", "the X box keeps the typed figure while it has the cursor");
  await xBox.press("Tab");
  await waitForValue(xBox, "1.13");
  assert.equal(await yBox.inputValue(), companyDragged.y, "typing the X moved the Company name across only");
  // A width that snaps under one grid step is refused with the panel's sentence and commits nothing;
  // the box shows the stored width once it is left (ruling C31).
  const widthBox = designPanel.getByLabel("Width (in)", { exact: true });
  const companyWidth = await widthBox.inputValue();
  await widthBox.fill("0");
  await designPanel.getByText("Width must be at least 0.06 in, one grid step.", { exact: true }).waitFor({ state: "visible" });
  await widthBox.press("Tab");
  await waitForValue(widthBox, companyWidth);
  // The keyboard (ruling C32): with the Company name focused, ArrowRight nudges it one fine step
  // across (1/16 in, 0.06 as the box shows two decimals) and Shift+ArrowDown one coarse step down
  // (1/4 in); Delete on the Barcode is refused with the panel's sentence and the item stays on the
  // page. The two nudges ride into the printed move below: the Company name's end place is read
  // from the boxes after them.
  const keyFrom = await inspect(companyItem, "Company name");
  assert.equal(keyFrom.x, "1.13", "the Company name is where the typed X left it");
  await companyItem.press("ArrowRight");
  const nudgedX = await changedFrom(xBox, keyFrom.x, "Company name X after ArrowRight");
  assert.ok(Math.abs(Number(nudgedX) - Number(keyFrom.x) - 0.0625) < 0.01,
    `ArrowRight moves one fine step across: X ${keyFrom.x} → ${nudgedX}`);
  assert.equal(await yBox.inputValue(), keyFrom.y, "ArrowRight moves across only");
  await companyItem.press("Shift+ArrowDown");
  const nudgedY = await changedFrom(yBox, keyFrom.y, "Company name Y after Shift+ArrowDown");
  assert.ok(Math.abs(Number(nudgedY) - Number(keyFrom.y) - 0.25) < 0.01,
    `Shift+ArrowDown moves one coarse step down: Y ${keyFrom.y} → ${nudgedY}`);
  assert.equal(await xBox.inputValue(), nudgedX, "Shift+ArrowDown moves down only");
  const barcodeItem = canvasItems.getByRole("listitem", { name: "Barcode", exact: true });
  await inspect(barcodeItem, "Barcode");
  await barcodeItem.press("Delete");
  // DESIGNER_WORDS.cannotRemove (`src/lib/canvas-designer.ts`, which plain node cannot load).
  await designPanel.getByRole("alert").filter({ hasText: "they can be moved, not removed." }).waitFor({ state: "visible" });
  assert.equal(await barcodeItem.count(), 1, "Delete refuses the Barcode: it is still on the page");
  const companyTo = { x: nudgedX, y: nudgedY };
  await shot("canvas-items-moved");

  const saveDraft = page.getByRole("button", { name: "Save draft", exact: true });
  assert.equal(await saveDraft.isDisabled(), false, `the moved canvas saves; Save draft's title reads ${JSON.stringify(await saveDraft.getAttribute("title"))}`);
  await saveDraft.click();
  await page.getByRole("region", { name: "Template status" }).getByText("Saved", { exact: true }).waitFor({ state: "visible" });
  // The brief's "the Preview tab's pane shows a PDF" step is not taken here. The live page above
  // already showed one, and the v3 print below is the proof that the saved canvas renders; a
  // Generate preview click would race the live page's own automatic POST (the Task 6 carry).
  await shot("canvas-saved-live-page");
  await page.setViewportSize(viewport);

  await publishDraft(3);
  const after = paperOf(await printLoad1("the canvas traveler"), "the canvas traveler");
  const moved = (from, to) => ({ x: (Number(to.x) - Number(from.x)) * 72, y: (Number(to.y) - Number(from.y)) * 72 });
  const logoMove = moved(logoFrom, logoTo);
  const companyMove = moved(companyFrom, companyTo);
  assert.ok(logoMove.x !== 0 && logoMove.y !== 0, `the drag moved the logo both ways: ${JSON.stringify({ logoFrom, logoTo })}`);
  assert.ok(companyMove.x !== 0 && companyMove.y !== 0, `the drag, the typed X and the two nudges moved the Company name both ways: ${JSON.stringify({ companyFrom, companyTo })}`);
  within2pt(after.logo.x - before.logo.x, logoMove.x, "the printed logo's move across");
  within2pt(after.logo.y - before.logo.y, logoMove.y, "the printed logo's move down");
  within2pt(after.logo.w, before.logo.w, "the printed logo's width");
  within2pt(after.logo.h, before.logo.h, "the printed logo's height");
  within2pt(after.company.x - before.company.x, companyMove.x, "the printed Company name's move across");
  within2pt(after.company.y - before.company.y, companyMove.y, "the printed Company name's move down");
  for (const side of ["x", "y", "w", "h"]) within2pt(after.barcode[side], before.barcode[side], `the printed barcode's ${side}`);

  // Back to the customer for the clear below.
  await page.goto(`${ctx.baseURL}/customers/${target.id}`);
  await openRecordTab(page, "Defaults & documents");
  await travelerPicker.waitFor({ state: "visible" });
  await page.getByText(`Assigned: ${DOC_TEMPLATE_NAME}`).waitFor({ state: "visible" });

  // Clear back to the default — the DELETE lands and future paper falls back down the §5.2 chain.
  await travelerPicker.selectOption({ label: "Use default / inherit" });
  await page.getByText(`Assigned: ${DOC_TEMPLATE_NAME}`).waitFor({ state: "hidden" });
  assert.equal(await travelerPicker.inputValue(), "", "the picker is back on use-default/inherit");
  await shot("customer-template-cleared-to-default");

  // --- PR 2b of the shipping ticket canvas lane: a shipping ticket designed on a canvas, published
  // and printed (design §11). The order above is shipped whole on a shipment of its own, so the
  // shipment is single-order and its first ticket is the one the canvas seeds from. A Shipping
  // ticket template of this run's own carries the logo at header-left on v1, which is published,
  // assigned to the fixture customer, and printed: today's paper. A v2 draft is designed on the
  // canvas from that shipment, the logo and the Company name dragged and the Sold-to box resized by
  // its bottom handle, and the draft saved, published and printed again: the logo's and the Company
  // name's printed moves equal the inspector's, and the title stays where it was. The customer-scoped
  // teardown reaps the shipment and the ticket printed from it; the template is reaped by name.
  await startNewShipment(page, ctx, target.id, [{ id: orderId, number: orderNumber }]);
  await waitForValue(orderPanel(page, `#${orderNumber}`).getByLabel("Line 1 ship-now quantity", { exact: true }), "10");
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  const shipment = await waitForShipmentPage(page);

  await page.goto(`${ctx.baseURL}/admin/templates`);
  await page.getByRole("heading", { name: "Document templates" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "New template", exact: true }).click();
  await docTypePicker.selectOption("SHIPPER");
  await page.getByPlaceholder("Template name").fill(TICKET_TEMPLATE_NAME);
  await page.getByRole("button", { name: "Create template" }).click();
  await page.getByRole("link", { name: "Edit draft" }).click();
  await page.waitForURL(new RegExp(`${ctx.baseURL}/admin/templates/[^/]+/edit`));
  await page.getByRole("heading", { name: TICKET_TEMPLATE_NAME }).waitFor({ state: "visible" });
  await page.getByText("Shipping ticket · editing draft v1").waitFor({ state: "visible" });
  await openRecordTab(page, "Appearance");
  await page.getByText("No image uploaded").waitFor({ state: "visible" });
  await page.getByLabel("Upload logo image").setInputFiles(LOGO_FIXTURE);
  await page.getByText(/Image on file \(image\/png\)/).waitFor({ state: "visible" });
  await page.getByRole("combobox", { name: "Logo placement" }).selectOption("header-left");
  await saveDraft.click();
  await page.getByRole("region", { name: "Template status" }).getByText("Saved", { exact: true }).waitFor({ state: "visible" });
  const ticketTemplate = { list: "Shipping ticket", name: TICKET_TEMPLATE_NAME };
  await publishDraft(1, ticketTemplate);

  // `exact: true` is load-bearing: "Multi-order shipping ticket" holds the picker's name.
  const ticketPicker = page.getByRole("combobox", { name: "Template for Shipping ticket", exact: true });
  const ticketAssigned = page.getByText(`Assigned: ${TICKET_TEMPLATE_NAME}`);
  await page.goto(`${ctx.baseURL}/customers/${target.id}`);
  await openRecordTab(page, "Defaults & documents");
  await ticketPicker.waitFor({ state: "visible" });
  assert.equal(await ticketPicker.inputValue(), "", `${fixtures.customerCode}'s Shipping ticket picker starts on use-default/inherit`);
  await ticketPicker.selectOption({ label: TICKET_TEMPLATE_NAME });
  await ticketAssigned.waitFor({ state: "visible" });

  const printTicket = async (what) => {
    const printed = await ctx.apiMutate(page, `${ctx.baseURL}/api/shippers/${shipment.id}/print?doc=ticket`, { method: "POST" });
    assert.equal(printed.ok(), true, `${what}: the shipping ticket prints`);
    const documentId = printed.headers()["x-document-id"];
    assert.ok(documentId, `${what}: the print names its stored document`);
    return storedPdf(page, ctx.baseURL, documentId, what);
  };
  // Page 1 of the ticket: the Company name, the one image a ticket paints (the logo; a ticket has no
  // barcode) and the document title, each read from the stored document's own pages.
  const ticketPaperOf = (bytes, what) => {
    const pages = pageCount(bytes);
    const runs = printedRuns(bytes, { pages, what })[0];
    const images = printedImages(bytes, { pages, what })[0];
    assert.equal(images.length, 1, `${what}: page 1 paints one image, the logo: ${JSON.stringify(images)}`);
    assert.ok(Math.abs(images[0].w / images[0].h - LOGO_ASPECT) < 0.05,
      `${what}: the image is the logo, in its 160:48 proportions: ${JSON.stringify(images[0])}`);
    return { company: companyRun(runs, what), logo: images[0], title: phraseRun(runs, "Shipping Ticket", what, "the title") };
  };
  const ticketBefore = ticketPaperOf(await printTicket("the sections ticket"), "the sections ticket");

  const ticketRow = await selectTemplate(ticketTemplate);
  await ticketRow.getByText("Published v1").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Open draft", exact: true }).click();
  await page.getByText("Open draft: v2").waitFor({ state: "visible" });
  await page.getByRole("link", { name: "Edit draft" }).click();
  await page.waitForURL(new RegExp(`${ctx.baseURL}/admin/templates/[^/]+/edit`));
  await page.getByText("Shipping ticket · editing draft v2").waitFor({ state: "visible" });

  await page.setViewportSize({ width: 1440, height: 900 });
  await openRecordTab(page, "Sections");
  await designOnCanvas.waitFor({ state: "visible" });
  assert.equal(await designOnCanvas.isDisabled(), true, "Design on a canvas waits for a shipment picked in Preview");
  assert.equal(await designOnCanvas.getAttribute("title"), "Pick a single-order shipment in Preview first");
  await openRecordTab(page, "Preview");
  await page.getByRole("combobox", { name: "Preview record" })
    .selectOption({ label: `Shipment #${shipment.shipperNumber} — ${fixtures.customerCode} (1 order)` });
  await openRecordTab(page, "Sections");
  await designOnCanvas.click();
  await confirm.waitFor({ state: "visible" });
  const confirmText = (await confirm.textContent()) ?? "";
  assert.ok(confirmText.includes(`shipment #${shipment.shipperNumber}'s first ticket`),
    `the confirm names the shipment's first ticket as the seed: ${JSON.stringify(confirmText)}`);
  await confirm.getByRole("button", { name: "Design on a canvas", exact: true }).click();
  await confirm.waitFor({ state: "hidden" });
  await designPanel.waitFor({ state: "visible" });
  assert.equal(await page.getByRole("tab", { name: /^Sections/ }).count(), 0, "a canvas ticket shows Design in place of Sections");
  const soldToItem = canvasItems.getByRole("listitem", { name: "Sold-to box", exact: true });
  const totalsItem = canvasItems.getByRole("listitem", { name: "Totals table", exact: true });
  for (const item of [logoItem, companyItem, soldToItem, totalsItem,
    canvasItems.getByRole("listitem", { name: "Liability text wording", exact: true })]) {
    await item.waitFor({ state: "visible" });
  }
  await assertNeverVisible(barcodeItem, "a shipping ticket's canvas holds no barcode", 500);
  await livePage.waitFor({ state: "visible" });
  await shot("ticket-canvas-seeded");

  // The Totals table is a rows block: its inspector shows each row's Show and Label boxes and no
  // column Width box.
  await inspect(totalsItem, "Totals table");
  await designPanel.getByLabel("Show Quantity shipped", { exact: true }).waitFor({ state: "visible" });
  await designPanel.getByLabel("Label for Quantity shipped", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await designPanel.getByLabel(/^Width for /).count(), 0, "a rows block's inspector shows no column Width box");

  const ticketLogoFrom = await inspect(logoItem, "Logo");
  const ticketLogoTo = await drag(logoItem, ticketLogoFrom, 36, 18, "Logo");
  const ticketCompanyFrom = await inspect(companyItem, "Company name");
  const ticketCompanyTo = await drag(companyItem, ticketCompanyFrom, 18, 9, "Company name");

  // The handle resize (Task 3's review carry): the Sold-to box's bottom handle dragged 9 pt down,
  // two grid steps, grows its height by 0.125 in and leaves its X, Y and Width as they were.
  const heightBox = designPanel.getByLabel("Height (in)", { exact: true });
  const soldToFrom = await inspect(soldToItem, "Sold-to box");
  const soldToWidth = await widthBox.inputValue();
  const soldToHeight = await heightBox.inputValue();
  const southHandle = soldToItem.locator('[data-handle="s"]');
  await southHandle.waitFor({ state: "visible" });
  const handleBox = await southHandle.boundingBox();
  const stageBox = await canvasItems.boundingBox();
  assert.ok(handleBox && stageBox, "the Sold-to box's bottom handle and the stage are on screen");
  const stageScale = stageBox.width / 612;
  const hx = handleBox.x + handleBox.width / 2;
  const hy = handleBox.y + handleBox.height / 2;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(hx, hy + 9 * stageScale, { steps: 8 });
  await page.mouse.up();
  const soldToGrown = await changedFrom(heightBox, soldToHeight, "Sold-to box Height after the resize");
  assert.ok(Math.abs(Number(soldToGrown) - Number(soldToHeight) - 0.125) <= 0.0101,
    `the bottom handle dragged 9 pt grows the height by 0.125 in: ${soldToHeight} → ${soldToGrown}`);
  assert.equal(await xBox.inputValue(), soldToFrom.x, "the bottom handle leaves the Sold-to box's X");
  assert.equal(await yBox.inputValue(), soldToFrom.y, "the bottom handle leaves the Sold-to box's Y");
  assert.equal(await widthBox.inputValue(), soldToWidth, "the bottom handle leaves the Sold-to box's Width");
  await shot("ticket-canvas-items-moved");

  assert.equal(await saveDraft.isDisabled(), false, `the moved canvas ticket saves; Save draft's title reads ${JSON.stringify(await saveDraft.getAttribute("title"))}`);
  await saveDraft.click();
  await page.getByRole("region", { name: "Template status" }).getByText("Saved", { exact: true }).waitFor({ state: "visible" });
  await page.setViewportSize(viewport);

  await publishDraft(2, ticketTemplate);
  const ticketAfter = ticketPaperOf(await printTicket("the canvas ticket"), "the canvas ticket");
  const ticketLogoMove = moved(ticketLogoFrom, ticketLogoTo);
  const ticketCompanyMove = moved(ticketCompanyFrom, ticketCompanyTo);
  assert.ok(ticketLogoMove.x !== 0 && ticketLogoMove.y !== 0, `the drag moved the ticket's logo both ways: ${JSON.stringify({ ticketLogoFrom, ticketLogoTo })}`);
  assert.ok(ticketCompanyMove.x !== 0 && ticketCompanyMove.y !== 0, `the drag moved the ticket's Company name both ways: ${JSON.stringify({ ticketCompanyFrom, ticketCompanyTo })}`);
  within2pt(ticketAfter.logo.x - ticketBefore.logo.x, ticketLogoMove.x, "the ticket's printed logo's move across");
  within2pt(ticketAfter.logo.y - ticketBefore.logo.y, ticketLogoMove.y, "the ticket's printed logo's move down");
  within2pt(ticketAfter.logo.w, ticketBefore.logo.w, "the ticket's printed logo's width");
  within2pt(ticketAfter.logo.h, ticketBefore.logo.h, "the ticket's printed logo's height");
  within2pt(ticketAfter.company.x - ticketBefore.company.x, ticketCompanyMove.x, "the ticket's printed Company name's move across");
  within2pt(ticketAfter.company.y - ticketBefore.company.y, ticketCompanyMove.y, "the ticket's printed Company name's move down");
  within2pt(ticketAfter.title.x, ticketBefore.title.x, "the ticket's printed title's x");
  within2pt(ticketAfter.title.y, ticketBefore.title.y, "the ticket's printed title's y");

  // Back to the customer: the Shipping ticket picker cleared to the default.
  await page.goto(`${ctx.baseURL}/customers/${target.id}`);
  await openRecordTab(page, "Defaults & documents");
  await ticketPicker.waitFor({ state: "visible" });
  await ticketAssigned.waitFor({ state: "visible" });
  await ticketPicker.selectOption({ label: "Use default / inherit" });
  await ticketAssigned.waitFor({ state: "hidden" });
  assert.equal(await ticketPicker.inputValue(), "", "the Shipping ticket picker is back on use-default/inherit");
  await shot("customer-ticket-template-cleared");

  // --- PR 2 of the bill of lading canvas lane: a bill of lading designed on a canvas, published and
  // printed (design §11). The single-order shipment above is the one it seeds from: its one order's
  // PO list prints one line, so the seed's one-line Consignee's ref/PO block is the flow's own place.
  // A Bill of lading template of this run's own carries the logo at header-left at the editor's
  // default width on v1, which is published, assigned to the fixture customer and printed (the first
  // print allocates the shipment's bill-of-lading number, which no flow reads): today's paper. A v2
  // draft is designed on the canvas from that shipment, the freight block narrowed by its right
  // handle, the logo dragged into the header's empty middle and the title moved, and the draft saved,
  // published and printed again: the logo's and the title's printed moves equal the designer's, the
  // Carrier's Pro No. stays where it was, and the TRV list moves by no more than the seed's repeat
  // shift (CANVAS_GRID less the form rule's 3 pt margin, 1.5 pt). The customer-scoped teardown
  // deletes the stored bills of lading with the shipment (by its id); the template, and any
  // assignment of it a failure leaves behind, is reaped by name.
  await page.goto(`${ctx.baseURL}/admin/templates`);
  await page.getByRole("heading", { name: "Document templates" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "New template", exact: true }).click();
  await docTypePicker.selectOption("BOL");
  await page.getByPlaceholder("Template name").fill(BOL_CANVAS_TEMPLATE_NAME);
  await page.getByRole("button", { name: "Create template" }).click();
  await page.getByRole("link", { name: "Edit draft" }).click();
  await page.waitForURL(new RegExp(`${ctx.baseURL}/admin/templates/[^/]+/edit`));
  await page.getByRole("heading", { name: BOL_CANVAS_TEMPLATE_NAME }).waitFor({ state: "visible" });
  await page.getByText("Bill of lading · editing draft v1").waitFor({ state: "visible" });
  await openRecordTab(page, "Appearance");
  await page.getByText("No image uploaded").waitFor({ state: "visible" });
  await page.getByLabel("Upload logo image").setInputFiles(LOGO_FIXTURE);
  await page.getByText(/Image on file \(image\/png\)/).waitFor({ state: "visible" });
  await page.getByRole("combobox", { name: "Logo placement" }).selectOption("header-left");
  await saveDraft.click();
  await page.getByRole("region", { name: "Template status" }).getByText("Saved", { exact: true }).waitFor({ state: "visible" });
  const bolTemplate = { list: "Bill of lading", name: BOL_CANVAS_TEMPLATE_NAME };
  await publishDraft(1, bolTemplate);

  // Assigned to the fixture customer, whose picker starts on use-default/inherit; it is cleared back
  // at the end of this section, and deleteDocumentTemplatesByName reaps any assignment of this
  // template by name should the flow stop before then.
  const bolPicker = page.getByRole("combobox", { name: "Template for Bill of lading", exact: true });
  const bolAssigned = page.getByText(`Assigned: ${BOL_CANVAS_TEMPLATE_NAME}`);
  await page.goto(`${ctx.baseURL}/customers/${target.id}`);
  await openRecordTab(page, "Defaults & documents");
  await bolPicker.waitFor({ state: "visible" });
  assert.equal(await bolPicker.inputValue(), "", `${fixtures.customerCode}'s Bill of lading picker starts on use-default/inherit`);
  await bolPicker.selectOption({ label: BOL_CANVAS_TEMPLATE_NAME });
  await bolAssigned.waitFor({ state: "visible" });

  const printBol = async (what) => {
    const printed = await ctx.apiMutate(page, `${ctx.baseURL}/api/shippers/${shipment.id}/print?doc=bol`, { method: "POST" });
    assert.equal(printed.ok(), true, `${what}: the bill of lading prints`);
    const documentId = printed.headers()["x-document-id"];
    assert.ok(documentId, `${what}: the print names its stored document`);
    return storedPdf(page, ctx.baseURL, documentId, what);
  };
  // The bill of lading's one page: the one image it paints (the logo; a bill of lading has no
  // barcode), the title, and three lines the designer leaves alone: the Carrier's Pro No. above the
  // Consignee's ref/PO block, the SCAC code's label below it and the TRV list's label, each read
  // from the stored document's own page.
  const bolPaperOf = (bytes, what) => {
    const pages = pageCount(bytes);
    assert.equal(pages, 1, `${what}: the bill of lading prints one page`);
    const runs = printedRuns(bytes, { pages, what })[0];
    const images = printedImages(bytes, { pages, what })[0];
    assert.equal(images.length, 1, `${what}: page 1 paints one image, the logo: ${JSON.stringify(images)}`);
    assert.ok(Math.abs(images[0].w / images[0].h - LOGO_ASPECT) < 0.05,
      `${what}: the image is the logo, in its 160:48 proportions: ${JSON.stringify(images[0])}`);
    return {
      logo: images[0],
      title: phraseRun(runs, "STRAIGHT BILL OF LADING", what, "the title"),
      pro: phraseRun(runs, "Carrier's Pro No.", what, "the pro number's label"),
      scac: phraseRun(runs, "Carrier's Code (SCAC)", what, "the SCAC code's label"),
      trv: phraseRun(runs, "TRV NO.", what, "the TRV list's label"),
    };
  };
  const bolBefore = bolPaperOf(await printBol("the sections bill of lading"), "the sections bill of lading");

  const bolRow = await selectTemplate(bolTemplate);
  await bolRow.getByText("Published v1").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Open draft", exact: true }).click();
  await page.getByText("Open draft: v2").waitFor({ state: "visible" });
  await page.getByRole("link", { name: "Edit draft" }).click();
  await page.waitForURL(new RegExp(`${ctx.baseURL}/admin/templates/[^/]+/edit`));
  await page.getByText("Bill of lading · editing draft v2").waitFor({ state: "visible" });

  await page.setViewportSize({ width: 1440, height: 900 });
  await openRecordTab(page, "Sections");
  await designOnCanvas.waitFor({ state: "visible" });
  assert.equal(await designOnCanvas.isDisabled(), true, "Design on a canvas waits for a shipment picked in Preview");
  assert.equal(await designOnCanvas.getAttribute("title"), "Pick a shipment in Preview first");
  await openRecordTab(page, "Preview");
  await page.getByRole("combobox", { name: "Preview record" })
    .selectOption({ label: `Shipment #${shipment.shipperNumber} — ${fixtures.customerCode} (1 order)` });
  await openRecordTab(page, "Sections");
  await designOnCanvas.click();
  await confirm.waitFor({ state: "visible" });
  const bolConfirmText = (await confirm.textContent()) ?? "";
  assert.ok(bolConfirmText.includes(`shipment #${shipment.shipperNumber}'s bill of lading`),
    `the confirm names the shipment's bill of lading as the seed: ${JSON.stringify(bolConfirmText)}`);
  await confirm.getByRole("button", { name: "Design on a canvas", exact: true }).click();
  await confirm.waitFor({ state: "hidden" });
  await designPanel.waitFor({ state: "visible" });
  assert.equal(await page.getByRole("tab", { name: /^Sections/ }).count(), 0, "a canvas bill of lading shows Design in place of Sections");
  const titleItem = canvasItems.getByRole("listitem", { name: "Document title", exact: true });
  const freightItem = canvasItems.getByRole("listitem", { name: "Freight table", exact: true });
  for (const item of [logoItem, titleItem, freightItem,
    canvasItems.getByRole("listitem", { name: "Consignee's ref/PO table", exact: true }),
    canvasItems.getByRole("listitem", { name: "TRV numbers table", exact: true }),
    canvasItems.getByRole("listitem", { name: "Received clause wording", exact: true })]) {
    await item.waitFor({ state: "visible" });
  }
  await assertNeverVisible(barcodeItem, "a bill of lading's canvas holds no barcode", 500);
  // The Section 7 clause prints inside the freight block's sidebar: it is no item of its own.
  await assertNeverVisible(canvasItems.getByRole("listitem", { name: "Section 7 clause wording", exact: true }),
    "the Section 7 clause is the freight block's, not an item", 500);
  await livePage.waitFor({ state: "visible" });
  await shot("bol-canvas-seeded");

  // The freight block's inspector: its five columns each with a Width box, its Collect checkbox a
  // toggle with Show and Label and no Width (`DESIGNER_WORDS.columnWidth`'s words).
  await inspect(freightItem, "Freight table");
  await designPanel.getByLabel("Show Collect checkbox", { exact: true }).waitFor({ state: "visible" });
  await designPanel.getByLabel("Label for Collect checkbox", { exact: true }).waitFor({ state: "visible" });
  await designPanel.getByLabel("Width for Package count (pt)", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await designPanel.getByLabel("Width for Collect checkbox (pt)", { exact: true }).count(), 0,
    "the Collect checkbox, a toggle, has no Width box");

  // The freight block narrowed by its right handle, 36 pt (eight grid steps): WHILE the handle is
  // held, the stage draws the strip in the box being dragged, so the sidebar's outline rides the
  // block's moving right edge (Task 9's carry: a strip drawn from the stored box leaves the outline
  // at the old edge until the drop).
  const freightWidth = await widthBox.inputValue();
  const eastHandle = freightItem.locator('[data-handle="e"]');
  await eastHandle.scrollIntoViewIfNeeded();
  const eastBox = await eastHandle.boundingBox();
  const freightBox = await freightItem.boundingBox();
  const freightStage = await canvasItems.boundingBox();
  assert.ok(eastBox && freightBox && freightStage, "the freight block, its right handle and the stage are on screen");
  const freightScale = freightStage.width / 612;
  const ex = eastBox.x + eastBox.width / 2;
  const ey = eastBox.y + eastBox.height / 2;
  await page.mouse.move(ex, ey);
  await page.mouse.down();
  await page.mouse.move(ex - 36 * freightScale, ey, { steps: 8 });
  const narrowing = Date.now() + 5000;
  let shownFreight = await freightItem.boundingBox();
  while (shownFreight && shownFreight.width > freightBox.width - 30 * freightScale) {
    assert.ok(Date.now() < narrowing, `the freight block is drawn narrower while its handle is held: ${JSON.stringify({ freightBox, shownFreight })}`);
    await delay(50);
    shownFreight = await freightItem.boundingBox();
  }
  const sidebar = await freightItem.locator('[data-sidebar="true"]').boundingBox();
  assert.ok(shownFreight && sidebar, "the freight block and its sidebar's outline are drawn");
  assert.ok(Math.abs(sidebar.x + sidebar.width - (shownFreight.x + shownFreight.width)) <= 2,
    `the sidebar's outline rides the held block's right edge: ${JSON.stringify({ shownFreight, sidebar })}`);
  await page.mouse.up();
  const freightNarrowed = await changedFrom(widthBox, freightWidth, "Freight table Width after the resize");
  assert.ok(Math.abs(Number(freightWidth) - Number(freightNarrowed) - 0.5) <= 0.0101,
    `the right handle dragged 36 pt narrows the freight block by 0.5 in: ${freightWidth} → ${freightNarrowed}`);

  // The logo into the header's empty middle, 144 pt across and one grid step down. The title down and
  // across: dropped below the one-line Consignee's ref/PO block, it is anchored below it, where its Y
  // box holds the offset from the block's bottom (ruling C14), so its move down is read off the stage,
  // which draws every item at its place on the page, and its move across off the X box.
  const bolLogoFrom = await inspect(logoItem, "Logo");
  const bolLogoTo = await drag(logoItem, bolLogoFrom, 144, 4.5, "Logo");
  /** The title's top on the stage, in points from the page's top: its drawn box against the stage's,
   *  both read at once, so a scroll between two reads moves neither. */
  const titleStageTop = async () => {
    const [item, stage] = [await titleItem.boundingBox(), await canvasItems.boundingBox()];
    assert.ok(item && stage, "the title and the stage are on screen");
    return (item.y - stage.y) / (stage.width / 612);
  };
  const titleFrom = await inspect(titleItem, "Document title");
  const titleTopFrom = await titleStageTop();
  const titleTo = await drag(titleItem, titleFrom, 18, 9, "Document title");
  const titleTopTo = await titleStageTop();
  assert.equal(await designPanel.getByLabel("Anchor", { exact: true }).inputValue(), "below:consignee_ref",
    "the title dropped below the Consignee's ref/PO block is anchored below it");
  await shot("bol-canvas-items-moved");

  assert.equal(await saveDraft.isDisabled(), false, `the moved canvas bill of lading saves; Save draft's title reads ${JSON.stringify(await saveDraft.getAttribute("title"))}`);
  await saveDraft.click();
  await page.getByRole("region", { name: "Template status" }).getByText("Saved", { exact: true }).waitFor({ state: "visible" });
  await page.setViewportSize(viewport);

  await publishDraft(2, bolTemplate);
  const bolAfter = bolPaperOf(await printBol("the canvas bill of lading"), "the canvas bill of lading");
  const bolLogoMove = moved(bolLogoFrom, bolLogoTo);
  const titleMove = { x: moved(titleFrom, titleTo).x, y: titleTopTo - titleTopFrom };
  // The designer moved each by the dragged amount, within 2 pt across (the drags' 144 and 18 are on
  // the grid) and within the drop's snap down.
  within2pt(bolLogoMove.x, 144, "the designer's move of the bill of lading's logo across");
  withinSnap(bolLogoMove.y, 4.5, "the designer's move of the bill of lading's logo down");
  within2pt(titleMove.x, 18, "the designer's move of the title across");
  withinSnap(titleMove.y, 9, "the designer's move of the title down");
  within2pt(bolAfter.logo.x - bolBefore.logo.x, bolLogoMove.x, "the bill of lading's printed logo's move across");
  within2pt(bolAfter.logo.y - bolBefore.logo.y, bolLogoMove.y, "the bill of lading's printed logo's move down");
  within2pt(bolAfter.logo.w, bolBefore.logo.w, "the bill of lading's printed logo's width");
  within2pt(bolAfter.logo.h, bolBefore.logo.h, "the bill of lading's printed logo's height");
  within2pt(bolAfter.title.x - bolBefore.title.x, titleMove.x, "the printed title's move across");
  within2pt(bolAfter.title.y - bolBefore.title.y, titleMove.y, "the printed title's move down");
  within2pt(bolAfter.pro.x, bolBefore.pro.x, "the printed Carrier's Pro No.'s x");
  within2pt(bolAfter.pro.y, bolBefore.pro.y, "the printed Carrier's Pro No.'s y");
  within2pt(bolAfter.scac.x, bolBefore.scac.x, "the printed SCAC code label's x");
  within2pt(bolAfter.scac.y, bolBefore.scac.y, "the printed SCAC code label's y, within the seed's repeat shift");
  within2pt(bolAfter.trv.x, bolBefore.trv.x, "the printed TRV list's x");
  within2pt(bolAfter.trv.y, bolBefore.trv.y, "the printed TRV list's y, within the seed's repeat shift");

  // Back to the customer: the Bill of lading picker cleared to the default and read back.
  await page.goto(`${ctx.baseURL}/customers/${target.id}`);
  await openRecordTab(page, "Defaults & documents");
  await bolPicker.waitFor({ state: "visible" });
  await bolAssigned.waitFor({ state: "visible" });
  await bolPicker.selectOption({ label: "Use default / inherit" });
  await bolAssigned.waitFor({ state: "hidden" });
  assert.equal(await bolPicker.inputValue(), "", "the Bill of lading picker is back on use-default/inherit");
  await shot("customer-bol-template-cleared");

  // --- PR 2 of the certification canvas lane: a certification designed on a canvas, published and
  // printed (design §11). The certification is this path's own: a LOAD-scope certification on load 1
  // of the order above, made on demand (a load certification is never made eagerly), its freeform
  // text typed before any print. The fixture part carries no inspection, so it holds no requirement,
  // and it lists no serial. A Certification template of this run's own carries the logo at
  // header-left at the editor's default width on v1, which is published, assigned to the fixture
  // customer and printed: today's paper. A v2 draft is designed on the canvas from that
  // certification, the title moved a little and the logo dragged into the header's middle, and the
  // draft saved, published and printed again: the logo's and the title's printed moves equal the
  // designer's, and the part lines' heading and the freeform text stay where they were. The
  // customer-scoped teardown deletes the certification with its readings, its requirements and its
  // stored pages (by its id); the template, and any assignment of it a failure leaves behind, is
  // reaped by name.
  const madeCert = await ctx.apiMutate(page, `${ctx.baseURL}/api/certs`, {
    method: "POST", data: { orderId, scope: "LOAD", loadNumber: 1 },
  });
  assert.equal(madeCert.ok(), true, `the load 1 certification of order #${orderNumber} is made: ${madeCert.status()}`);
  const cert = await madeCert.json();
  assert.equal(cert.requirements.length, 0, "the fixture part carries no inspection, so the certification holds no requirement");
  const typedFreeform = await ctx.apiMutate(page, `${ctx.baseURL}/api/certs/${cert.id}`, {
    method: "PATCH", data: { freeform: "E2E canvas certification." },
  });
  assert.equal(typedFreeform.ok(), true, `the certification's freeform text saves: ${typedFreeform.status()}`);

  await page.goto(`${ctx.baseURL}/admin/templates`);
  await page.getByRole("heading", { name: "Document templates" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "New template", exact: true }).click();
  await docTypePicker.selectOption("CERT");
  await page.getByPlaceholder("Template name").fill(CERT_CANVAS_TEMPLATE_NAME);
  await page.getByRole("button", { name: "Create template" }).click();
  await page.getByRole("link", { name: "Edit draft" }).click();
  await page.waitForURL(new RegExp(`${ctx.baseURL}/admin/templates/[^/]+/edit`));
  await page.getByRole("heading", { name: CERT_CANVAS_TEMPLATE_NAME }).waitFor({ state: "visible" });
  await page.getByText("Certification · editing draft v1").waitFor({ state: "visible" });
  await openRecordTab(page, "Appearance");
  await page.getByText("No image uploaded").waitFor({ state: "visible" });
  await page.getByLabel("Upload logo image").setInputFiles(LOGO_FIXTURE);
  await page.getByText(/Image on file \(image\/png\)/).waitFor({ state: "visible" });
  await page.getByRole("combobox", { name: "Logo placement" }).selectOption("header-left");
  await saveDraft.click();
  await page.getByRole("region", { name: "Template status" }).getByText("Saved", { exact: true }).waitFor({ state: "visible" });
  const certTemplate = { list: "Certification", name: CERT_CANVAS_TEMPLATE_NAME };
  await publishDraft(1, certTemplate);

  // Assigned to the fixture customer, whose picker starts on use-default/inherit; it is cleared back
  // at the end of this section, and deleteDocumentTemplatesByName reaps any assignment of this
  // template by name should the flow stop before then.
  const certPicker = page.getByRole("combobox", { name: "Template for Certification", exact: true });
  const certAssigned = page.getByText(`Assigned: ${CERT_CANVAS_TEMPLATE_NAME}`);
  await page.goto(`${ctx.baseURL}/customers/${target.id}`);
  await openRecordTab(page, "Defaults & documents");
  await certPicker.waitFor({ state: "visible" });
  assert.equal(await certPicker.inputValue(), "", `${fixtures.customerCode}'s Certification picker starts on use-default/inherit`);
  await certPicker.selectOption({ label: CERT_CANVAS_TEMPLATE_NAME });
  await certAssigned.waitFor({ state: "visible" });

  const printCert = async (what) => {
    const printed = await ctx.apiMutate(page, `${ctx.baseURL}/api/certs/${cert.id}/print`, { method: "POST" });
    assert.equal(printed.ok(), true, `${what}: the certification prints`);
    const documentId = printed.headers()["x-document-id"];
    assert.ok(documentId, `${what}: the print names its stored document`);
    return storedPdf(page, ctx.baseURL, documentId, what);
  };
  // The certification's one page: the logo, told by its 160:48 proportions from a signature image
  // the printing user may have on file; the title; and two lines the designer leaves alone, the part
  // lines' Quantity heading above the freeform text and the freeform text itself, each read from the
  // stored document's own page.
  const certPaperOf = (bytes, what) => {
    const pages = pageCount(bytes);
    assert.equal(pages, 1, `${what}: the certification prints one page`);
    const runs = printedRuns(bytes, { pages, what })[0];
    const logos = printedImages(bytes, { pages, what })[0].filter((box) => Math.abs(box.w / box.h - LOGO_ASPECT) < 0.05);
    assert.equal(logos.length, 1, `${what}: page 1 paints one image in the logo's 160:48 proportions: ${JSON.stringify(logos)}`);
    return {
      logo: logos[0],
      title: phraseRun(runs, "Certification", what, "the title"),
      quantity: phraseRun(runs, "Quantity", what, "the part lines' Quantity heading"),
      freeform: phraseRun(runs, "E2E canvas certification.", what, "the freeform text"),
    };
  };
  const certBefore = certPaperOf(await printCert("the sections certification"), "the sections certification");

  const certRow = await selectTemplate(certTemplate);
  await certRow.getByText("Published v1").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Open draft", exact: true }).click();
  await page.getByText("Open draft: v2").waitFor({ state: "visible" });
  await page.getByRole("link", { name: "Edit draft" }).click();
  await page.waitForURL(new RegExp(`${ctx.baseURL}/admin/templates/[^/]+/edit`));
  await page.getByText("Certification · editing draft v2").waitFor({ state: "visible" });

  await page.setViewportSize({ width: 1440, height: 900 });
  await openRecordTab(page, "Sections");
  await designOnCanvas.waitFor({ state: "visible" });
  assert.equal(await designOnCanvas.isDisabled(), true, "Design on a canvas waits for a certification picked in Preview");
  assert.equal(await designOnCanvas.getAttribute("title"), "Pick a certification in Preview first");
  await openRecordTab(page, "Preview");
  await page.getByRole("combobox", { name: "Preview record" })
    .selectOption({ label: `Cert — order #${orderNumber} — ${fixtures.customerCode} (LOAD)` });
  await openRecordTab(page, "Sections");
  await designOnCanvas.click();
  await confirm.waitFor({ state: "visible" });
  const certConfirmText = (await confirm.textContent()) ?? "";
  assert.ok(certConfirmText.includes(`certification ${orderNumber}, load 1`),
    `the confirm names the load certification as the seed: ${JSON.stringify(certConfirmText)}`);
  await confirm.getByRole("button", { name: "Design on a canvas", exact: true }).click();
  await confirm.waitFor({ state: "hidden" });
  await designPanel.waitFor({ state: "visible" });
  assert.equal(await page.getByRole("tab", { name: /^Sections/ }).count(), 0, "a canvas certification shows Design in place of Sections");
  const requirementsItem = canvasItems.getByRole("listitem", { name: "Requirements and readings table", exact: true });
  for (const item of [logoItem, titleItem, ...[
    "To box table", "Part lines table", "Certification statement table",
    "Freeform text table", "Signature block table",
  ].map((name) => canvasItems.getByRole("listitem", { name, exact: true }))]) {
    await item.waitFor({ state: "visible" });
  }
  // The fixture part carries no inspection and lists no serial, so this certification prints no
  // requirements block and no serials block (cert canvas design §4.5: an empty several-node block
  // prints nothing). The live measure reports each at 0 pt, and the stage then draws each at its
  // drawn box, hatched and titled with PRINTS_NOTHING (#958). The stage marks an item `data-empty`
  // only once the measure has landed (`printsNothing` reads it), so the flow waits for the mark, which
  // keeps #955's race closed: the item is visible both before and after the measure lands, so a
  // visibility check proves nothing about the measure. The requirements item is still selected below,
  // by focus.
  /** Waits for the stage to mark `item` empty, then reads its title for the words. */
  const waitEmpty = async (item, name) => {
    await page.waitForFunction((el) => el.dataset.empty === "true", await item.elementHandle());
    const title = (await item.getAttribute("title")) ?? "";
    assert.ok(title.includes(PRINTS_NOTHING), `${name}: the stage titles it ${JSON.stringify(PRINTS_NOTHING)}: ${JSON.stringify(title)}`);
  };
  await waitEmpty(requirementsItem, "Requirements and readings table");
  await waitEmpty(canvasItems.getByRole("listitem", { name: "Serial numbers table", exact: true }), "Serial numbers table");
  await assertNeverVisible(barcodeItem, "a certification's canvas holds no barcode", 500);
  await livePage.waitFor({ state: "visible" });
  await shot("cert-canvas-seeded");

  const anchorBox = designPanel.getByLabel("Anchor", { exact: true });
  const inspecting = (name) => designPanel.getByRole("heading", { name, exact: true, level: 3 }).count();
  // The requirements block is a rows block: its inspector shows each row's Show box and no column
  // Width box (`DESIGNER_WORDS.columnWidth`'s words).
  const requirementsFrom = await inspect(requirementsItem, "Requirements and readings table");
  await designPanel.getByLabel("Show Specification line", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await designPanel.getByLabel(/^Width for /).count(), 0, "a rows block's inspector shows no column Width box");

  // The empty requirements block can be grabbed and dragged by the pointer (#958): selected, it is
  // what the pointer lands on at the grab point, and two grid steps down move its Y down. The seed
  // draws it the full width between the margins, so the drag is straight down. Moved down it may meet
  // the next table's drawn box, which the rules refuse; dragged back up by the same two steps, its Y
  // reads as seeded and nothing refuses the layout, so the flow publishes the layout it seeded below.
  // A move alone does not clear the empty mark: it follows the table's key in the measure, not its
  // place. A refused preview of the dragged-down layout that lands before the drag back would clear
  // the measure until the next preview lands, so the flow does not read the mark again.
  assert.equal(await hitAt(requirementsItem, "Requirements and readings table"), "the item",
    "the selected empty requirements block is what the pointer lands on at its grab point");
  const requirementsDown = await dragY(requirementsItem, requirementsFrom.y, 2 * CANVAS_GRID, "Requirements and readings table");
  assert.ok(Number(requirementsDown) > Number(requirementsFrom.y),
    `the drag moved the empty requirements block down: Y ${requirementsFrom.y} → ${requirementsDown}`);
  assert.equal(await inspecting("Requirements and readings table"), 1, "the drag moved the requirements block: the inspector still names it");
  const requirementsBack = await dragY(requirementsItem, requirementsDown, -2 * CANVAS_GRID, "Requirements and readings table");
  assert.equal(requirementsBack, requirementsFrom.y, "dragged back up, the empty requirements block's Y reads as seeded");
  assert.equal(await inspecting("Requirements and readings table"), 1, "the drag back moved the requirements block: the inspector still names it");
  assert.equal(await xBox.inputValue(), requirementsFrom.x, "the drags moved the requirements block down and up alone");
  assert.equal(await saveDraft.isDisabled(), false,
    `the canvas dragged back as seeded saves; Save draft's title reads ${JSON.stringify(await saveDraft.getAttribute("title"))}`);

  // The title first, a little down and across, then the logo into the header's middle, 144 pt across
  // and one grid step down: the title is centred in that middle, so a logo moved there first could
  // lie over the point the title's drag grabs. After each drop the inspector still names the item
  // dragged, and its anchor is still the page's top, so its X and Y boxes measure its move.
  const certTitleFrom = await inspect(titleItem, "Document title");
  const certTitleTo = await drag(titleItem, certTitleFrom, 18, 9, "Document title");
  assert.equal(await inspecting("Document title"), 1, "the title's drag moved the title: the inspector still names it");
  assert.equal(await anchorBox.inputValue(), "page-top", "the moved title is still anchored at the page's top");
  const certLogoFrom = await inspect(logoItem, "Logo");
  const certLogoTo = await drag(logoItem, certLogoFrom, 144, 4.5, "Logo");
  assert.equal(await inspecting("Logo"), 1, "the logo's drag moved the logo: the inspector still names it");
  assert.equal(await anchorBox.inputValue(), "page-top", "the moved logo is still anchored at the page's top");
  await shot("cert-canvas-items-moved");

  assert.equal(await saveDraft.isDisabled(), false, `the moved canvas certification saves; Save draft's title reads ${JSON.stringify(await saveDraft.getAttribute("title"))}`);
  await saveDraft.click();
  await page.getByRole("region", { name: "Template status" }).getByText("Saved", { exact: true }).waitFor({ state: "visible" });
  await page.setViewportSize(viewport);

  await publishDraft(2, certTemplate);
  const certAfter = certPaperOf(await printCert("the canvas certification"), "the canvas certification");
  const certLogoMove = moved(certLogoFrom, certLogoTo);
  const certTitleMove = moved(certTitleFrom, certTitleTo);
  // The designer moved each by the dragged amount, within 2 pt across (the drags' 144 and 18 are on
  // the grid) and within the drop's snap down.
  within2pt(certLogoMove.x, 144, "the designer's move of the certification's logo across");
  withinSnap(certLogoMove.y, 4.5, "the designer's move of the certification's logo down");
  within2pt(certTitleMove.x, 18, "the designer's move of the certification's title across");
  withinSnap(certTitleMove.y, 9, "the designer's move of the certification's title down");
  within2pt(certAfter.logo.x - certBefore.logo.x, certLogoMove.x, "the certification's printed logo's move across");
  within2pt(certAfter.logo.y - certBefore.logo.y, certLogoMove.y, "the certification's printed logo's move down");
  within2pt(certAfter.logo.w, certBefore.logo.w, "the certification's printed logo's width");
  within2pt(certAfter.logo.h, certBefore.logo.h, "the certification's printed logo's height");
  within2pt(certAfter.title.x - certBefore.title.x, certTitleMove.x, "the certification's printed title's move across");
  within2pt(certAfter.title.y - certBefore.title.y, certTitleMove.y, "the certification's printed title's move down");
  within2pt(certAfter.quantity.x, certBefore.quantity.x, "the printed Quantity heading's x");
  within2pt(certAfter.quantity.y, certBefore.quantity.y, "the printed Quantity heading's y");
  within2pt(certAfter.freeform.x, certBefore.freeform.x, "the printed freeform text's x");
  within2pt(certAfter.freeform.y, certBefore.freeform.y, "the printed freeform text's y");

  // Back to the customer: the Certification picker cleared to the default and read back.
  await page.goto(`${ctx.baseURL}/customers/${target.id}`);
  await openRecordTab(page, "Defaults & documents");
  await certPicker.waitFor({ state: "visible" });
  await certAssigned.waitFor({ state: "visible" });
  await certPicker.selectOption({ label: "Use default / inherit" });
  await certAssigned.waitFor({ state: "hidden" });
  assert.equal(await certPicker.inputValue(), "", "the Certification picker is back on use-default/inherit");
  await shot("customer-cert-template-cleared");

  // --- PR 3 of the invoice canvas lane: an invoice designed on a canvas, published and printed
  // (design §11). The invoice is this path's own: a DRAFT invoice of the order above, which the
  // ticket section shipped whole, made through the counted request and never finalized. A draft is
  // not period-guarded (close-month-end leaves the month closed), it has no finalizedAt, so it stays
  // out of the close's figures, and its print files no copy in the customer's folder. The fixture
  // part carries the fixture's one price row (`create()` in db-fixtures.ts: the "E2E Price Op" step,
  // $25 setup, $2.50 each, $50 minimum), so its operation line is a priced line. An Invoice /
  // credit template of this run's own carries the logo at header-left at the editor's default width
  // on v1, which is published, assigned to the fixture customer and printed: today's paper. A v2
  // draft is designed on the canvas from that invoice, the logo dragged into the header's middle,
  // the Remit To box moved to the left margin and the three identity lines to the right by their
  // typed X (no drag grabs across another item), and the draft saved, published and printed again:
  // each moved item's printed move equals the designer's, and the Quantity heading stays where it
  // was. The customer-scoped teardown deletes the invoice with its lines and its stored pages; the
  // template, and any assignment of it a failure leaves behind, is reaped by name.
  const madeInvoice = await ctx.apiMutate(page, `${ctx.baseURL}/api/invoices`, { method: "POST", data: { orderId } });
  assert.equal(madeInvoice.ok(), true, `the draft invoice of order #${orderNumber} is made: ${madeInvoice.status()}`);
  const { invoice } = await madeInvoice.json();
  assert.equal(invoice.status, "DRAFT", "the flow's invoice is a draft");
  // The number the paper, the Preview option and the confirm carry, read from the answer.
  const invoiceNumber = invoice.documentNumber;
  assert.ok(typeof invoiceNumber === "string" && invoiceNumber !== "", "the made invoice names its document number");

  await page.goto(`${ctx.baseURL}/admin/templates`);
  await page.getByRole("heading", { name: "Document templates" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "New template", exact: true }).click();
  await docTypePicker.selectOption("INVOICE");
  await page.getByPlaceholder("Template name").fill(INVOICE_CANVAS_TEMPLATE_NAME);
  await page.getByRole("button", { name: "Create template" }).click();
  await page.getByRole("link", { name: "Edit draft" }).click();
  await page.waitForURL(new RegExp(`${ctx.baseURL}/admin/templates/[^/]+/edit`));
  await page.getByRole("heading", { name: INVOICE_CANVAS_TEMPLATE_NAME }).waitFor({ state: "visible" });
  await page.getByText("Invoice / credit · editing draft v1").waitFor({ state: "visible" });
  await openRecordTab(page, "Appearance");
  await page.getByText("No image uploaded").waitFor({ state: "visible" });
  await page.getByLabel("Upload logo image").setInputFiles(LOGO_FIXTURE);
  await page.getByText(/Image on file \(image\/png\)/).waitFor({ state: "visible" });
  await page.getByRole("combobox", { name: "Logo placement" }).selectOption("header-left");
  await saveDraft.click();
  await page.getByRole("region", { name: "Template status" }).getByText("Saved", { exact: true }).waitFor({ state: "visible" });
  const invoiceTemplate = { list: "Invoice / credit", name: INVOICE_CANVAS_TEMPLATE_NAME };
  await publishDraft(1, invoiceTemplate);

  // Assigned to the fixture customer, whose picker starts on use-default/inherit; it is cleared back
  // at the end of this section, and deleteDocumentTemplatesByName reaps any assignment of this
  // template by name should the flow stop before then.
  const invoicePicker = page.getByRole("combobox", { name: "Template for Invoice / credit", exact: true });
  const invoiceAssigned = page.getByText(`Assigned: ${INVOICE_CANVAS_TEMPLATE_NAME}`);
  await page.goto(`${ctx.baseURL}/customers/${target.id}`);
  await openRecordTab(page, "Defaults & documents");
  await invoicePicker.waitFor({ state: "visible" });
  assert.equal(await invoicePicker.inputValue(), "", `${fixtures.customerCode}'s Invoice / credit picker starts on use-default/inherit`);
  await invoicePicker.selectOption({ label: INVOICE_CANVAS_TEMPLATE_NAME });
  await invoiceAssigned.waitFor({ state: "visible" });

  const printInvoice = async (what) => {
    const printed = await ctx.apiMutate(page, `${ctx.baseURL}/api/invoices/${invoice.id}/print`, { method: "POST" });
    assert.equal(printed.ok(), true, `${what}: the invoice prints`);
    const documentId = printed.headers()["x-document-id"];
    assert.ok(documentId, `${what}: the print names its stored document`);
    return storedPdf(page, ctx.baseURL, documentId, what);
  };
  // The invoice's one page: the logo, told by its 160:48 proportions; the Remit To box's label (the
  // contract's "Remit To", printed as given); the three identity lines' labels; and the column
  // headers' Quantity heading, which the designer leaves alone, each read from the stored document's
  // own page.
  const invoicePaperOf = (bytes, what) => {
    const pages = pageCount(bytes);
    assert.equal(pages, 1, `${what}: the invoice prints one page`);
    const runs = printedRuns(bytes, { pages, what })[0];
    const logos = printedImages(bytes, { pages, what })[0].filter((box) => Math.abs(box.w / box.h - LOGO_ASPECT) < 0.05);
    assert.equal(logos.length, 1, `${what}: page 1 paints one image in the logo's 160:48 proportions: ${JSON.stringify(logos)}`);
    return {
      logo: logos[0],
      remitTo: phraseRun(runs, "Remit To", what, "the Remit To box's label"),
      number: phraseRun(runs, "Invoice No.:", what, "the invoice number's label"),
      date: phraseRun(runs, "Invoice Date:", what, "the invoice date's label"),
      terms: phraseRun(runs, "Terms:", what, "the terms' label"),
      quantity: phraseRun(runs, "Quantity", what, "the column headers' Quantity heading"),
    };
  };
  const invoiceBefore = invoicePaperOf(await printInvoice("the sections invoice"), "the sections invoice");

  const invoiceRow = await selectTemplate(invoiceTemplate);
  await invoiceRow.getByText("Published v1").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Open draft", exact: true }).click();
  await page.getByText("Open draft: v2").waitFor({ state: "visible" });
  await page.getByRole("link", { name: "Edit draft" }).click();
  await page.waitForURL(new RegExp(`${ctx.baseURL}/admin/templates/[^/]+/edit`));
  await page.getByText("Invoice / credit · editing draft v2").waitFor({ state: "visible" });

  await page.setViewportSize({ width: 1440, height: 900 });
  await openRecordTab(page, "Sections");
  await designOnCanvas.waitFor({ state: "visible" });
  assert.equal(await designOnCanvas.isDisabled(), true, "Design on a canvas waits for an invoice or credit picked in Preview");
  assert.equal(await designOnCanvas.getAttribute("title"), "Pick an invoice or credit in Preview first");
  await openRecordTab(page, "Preview");
  await page.getByRole("combobox", { name: "Preview record" })
    .selectOption({ label: `Invoice ${invoiceNumber} — ${fixtures.customerCode}` });
  await openRecordTab(page, "Sections");
  await designOnCanvas.click();
  await confirm.waitFor({ state: "visible" });
  const invoiceConfirmText = (await confirm.textContent()) ?? "";
  assert.ok(invoiceConfirmText.includes(`invoice ${invoiceNumber}`),
    `the confirm names the invoice as the seed: ${JSON.stringify(invoiceConfirmText)}`);
  await confirm.getByRole("button", { name: "Design on a canvas", exact: true }).click();
  await confirm.waitFor({ state: "hidden" });
  await designPanel.waitFor({ state: "visible" });
  assert.equal(await page.getByRole("tab", { name: /^Sections/ }).count(), 0, "a canvas invoice shows Design in place of Sections");
  const canvasItem = (name) => canvasItems.getByRole("listitem", { name, exact: true });
  const remitItem = canvasItem("Remit-to box");
  const identityItems = ["Invoice number", "Invoice date", "Terms"].map((name) => ({ name, item: canvasItem(name) }));
  const partsItem = canvasItem("Part rows table");
  const headersItem = canvasItem("Column headers table");
  // Every item the seed places for this invoice. The fixture customer has no address, and its bill-to
  // stack is the customer's name alone (`billToLines`), so the addresses print; the strip prints Our
  // Order #; the part, its priced operation and the totals print: each of the six blocks is
  // measured taller than 0 and drawn at that height, so each is waited for visible.
  for (const item of [logoItem, titleItem, companyItem, remitItem, ...identityItems.map(({ item }) => item),
    ...["Company address", "Contact line", "Company phone"].map(canvasItem),
    ...["Bill to / ship to table", "Column headers table", "Order strip table", "Part rows table", "Price block table",
      "Totals table"].map(canvasItem)]) {
    await item.waitFor({ state: "visible" });
  }
  await assertNeverVisible(barcodeItem, "an invoice's canvas holds no barcode", 500);
  await livePage.waitFor({ state: "visible" });
  await shot("invoice-canvas-seeded");

  // The part rows are a rows block: its inspector shows each row's Show box and no column Width box.
  // The column headers are the column table: its inspector shows each column's Width box
  // (`DESIGNER_WORDS.columnWidth`'s words).
  await inspect(partsItem, "Part rows table");
  await designPanel.getByLabel("Show Part quantity", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await designPanel.getByLabel(/^Width for /).count(), 0, "a rows block's inspector shows no column Width box");
  await inspect(headersItem, "Column headers table");
  await designPanel.getByLabel("Width for Quantity column (pt)", { exact: true }).waitFor({ state: "visible" });

  /** The warnings the stage draws on `item`: its title joins its sentences, none drawn none. */
  const drawnTitle = async (item) => (await item.getAttribute("title")) ?? "";
  /** Waits until `test` holds of `item`'s drawn title, the live page's measure landing between. */
  const titleUntil = async (item, test, what) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const title = await drawnTitle(item);
      if (test(title)) return;
      assert.ok(Date.now() < deadline, `${what}: the stage's title reads ${JSON.stringify(title)}`);
      await delay(100);
    }
  };
  /** The overlap of the Remit To box with an identity line (warning (a)), in the stage's words. */
  const overlapsIdentity = (title) =>
    /(Remit-to box field and the (Invoice number|Invoice date|Terms) field|(Invoice number|Invoice date|Terms) field and the Remit-to box field) overlap/.test(title);
  assert.equal(overlapsIdentity(await drawnTitle(remitItem)), false,
    "the seeded Remit To box overlaps no identity line (pin: the title is read once, unwaited; titleUntil below is the proof)");

  // The logo into the header's middle, 144 pt across and one grid step down, by a drag: nothing lies
  // over the point a quarter in from its left edge, at its middle height.
  const invoiceLogoFrom = await inspect(logoItem, "Logo");
  const invoiceLogoTo = await drag(logoItem, invoiceLogoFrom, 144, 4.5, "Logo");
  assert.equal(await anchorBox.inputValue(), "page-top", "the moved logo is still anchored at the page's top");

  // The Remit To box and the identity lines by their typed X: each item focused (which selects it,
  // whatever lies over it), its X typed and left, and the box's snapped figure waited for. No drag
  // crosses another item: the Remit To box moved first lands over the identity lines' grab points,
  // and the identity lines moved first over the Remit To box's.
  /** Types `inches` into the X box, leaves it and waits for `shown`; answers the item's X and Y as
   *  its boxes show them. The wait (`waitForValue(xBox, shown)`) is the proof of the designer's place:
   *  it fails unless the box comes to show the snapped figure, so the X answered is `shown` itself and
   *  no check of it against the place it was typed for could fail. */
  const typeX = async (inches, shown) => {
    await xBox.fill(inches);
    await xBox.press("Tab");
    await waitForValue(xBox, shown);
    return { x: await xBox.inputValue(), y: await yBox.inputValue() };
  };
  /** The snapped grid figure in points at or left of `pt`, and the X box's two-decimal figure for it. */
  const gridAtOrLeft = (pt) => {
    const snapped = Math.floor(pt / CANVAS_GRID + 1e-9) * CANVAS_GRID;
    return { pt: snapped, shown: (snapped / 72).toFixed(2) };
  };
  // The Remit To box to the first grid line at or right of the left margin: 0.375 in, 27 pt
  // (CANVAS_PAGE.margin is 24 pt, off the grid).
  const remitFrom = await inspect(remitItem, "Remit-to box");
  const remitWidth = Number(await widthBox.inputValue()) * 72;
  const remitTo = await typeX("0.375", "0.38");
  // The stored left edge the typed 0.375 in snaps to: six grid steps, 27 pt (the box shows 0.38).
  const remitLeftPt = CANVAS_GRID * 6;
  assert.equal(remitTo.y, remitFrom.y, "typing the X moved the Remit To box across only");
  assert.equal(await anchorBox.inputValue(), "page-top", "the moved Remit To box is still anchored at the page's top");
  // Over the identity lines now, so the stage warns of the overlap (warning (a)): the silence below,
  // once the identity lines have moved right of it, is the warning cleared, not one never raised.
  await titleUntil(remitItem, overlapsIdentity, "the Remit To box at the left margin overlaps the identity lines");

  // Each identity line to the right margin less the width the inspector shows, snapped to the grid at
  // or left of it.
  const RIGHT_MARGIN = 612 - 24;
  const identityMoves = [];
  for (const { name, item } of identityItems) {
    const from = await inspect(item, name);
    const width = Number(await widthBox.inputValue()) * 72;
    const place = gridAtOrLeft(RIGHT_MARGIN - width);
    assert.ok(place.pt > remitLeftPt + remitWidth,
      `${name}'s new left edge, ${place.pt} pt, lies right of the moved Remit To box's right edge`);
    const to = await typeX(String(place.pt / 72), place.shown);
    assert.equal(to.y, from.y, `typing the X moved ${name} across only`);
    assert.equal(await anchorBox.inputValue(), "page-top", `the moved ${name} is still anchored at the page's top`);
    identityMoves.push({ name, from, to });
  }
  // The Remit To box now lies left of every identity line: the overlap is gone.
  await titleUntil(remitItem, (title) => !overlapsIdentity(title), "the Remit To box clear of the moved identity lines");
  await shot("invoice-canvas-items-moved");

  // Nothing refuses the moved canvas; a warning the dragged logo raises over the header's pieces
  // refuses nothing either.
  assert.equal(await saveDraft.isDisabled(), false, `the moved canvas invoice saves; Save draft's title reads ${JSON.stringify(await saveDraft.getAttribute("title"))}`);
  assert.equal(await saveDraft.getAttribute("title"), null, "Save draft carries no refusal");
  await saveDraft.click();
  await page.getByRole("region", { name: "Template status" }).getByText("Saved", { exact: true }).waitFor({ state: "visible" });
  await page.setViewportSize(viewport);

  await publishDraft(2, invoiceTemplate);
  const invoiceAfter = invoicePaperOf(await printInvoice("the canvas invoice"), "the canvas invoice");
  const invoiceLogoMove = moved(invoiceLogoFrom, invoiceLogoTo);
  const remitMove = moved(remitFrom, remitTo);
  // The designer moved the logo by the dragged amount, within 2 pt across (144 is on the grid) and
  // within the drop's snap down; the Remit To box's typed 27 pt is typeX's wait on its X box.
  within2pt(invoiceLogoMove.x, 144, "the designer's move of the invoice's logo across");
  withinSnap(invoiceLogoMove.y, 4.5, "the designer's move of the invoice's logo down");
  within2pt(invoiceAfter.logo.x - invoiceBefore.logo.x, invoiceLogoMove.x, "the invoice's printed logo's move across");
  within2pt(invoiceAfter.logo.y - invoiceBefore.logo.y, invoiceLogoMove.y, "the invoice's printed logo's move down");
  within2pt(invoiceAfter.logo.w, invoiceBefore.logo.w, "the invoice's printed logo's width");
  within2pt(invoiceAfter.logo.h, invoiceBefore.logo.h, "the invoice's printed logo's height");
  within2pt(invoiceAfter.remitTo.x - invoiceBefore.remitTo.x, remitMove.x, "the printed Remit To label's move across");
  within2pt(invoiceAfter.remitTo.y - invoiceBefore.remitTo.y, remitMove.y, "the printed Remit To label's move down");
  const printedIdentity = { "Invoice number": "number", "Invoice date": "date", Terms: "terms" };
  for (const { name, from, to } of identityMoves) {
    const move = moved(from, to);
    const key = printedIdentity[name];
    within2pt(invoiceAfter[key].x - invoiceBefore[key].x, move.x, `the printed ${name} label's move across`);
    within2pt(invoiceAfter[key].y - invoiceBefore[key].y, move.y, `the printed ${name} label's move down`);
  }
  within2pt(invoiceAfter.quantity.x, invoiceBefore.quantity.x, "the printed Quantity heading's x");
  within2pt(invoiceAfter.quantity.y, invoiceBefore.quantity.y, "the printed Quantity heading's y");

  // Back to the customer: the Invoice / credit picker cleared to the default and read back. The draft
  // invoice stays for the teardown to reap.
  await page.goto(`${ctx.baseURL}/customers/${target.id}`);
  await openRecordTab(page, "Defaults & documents");
  await invoicePicker.waitFor({ state: "visible" });
  await invoiceAssigned.waitFor({ state: "visible" });
  await invoicePicker.selectOption({ label: "Use default / inherit" });
  await invoiceAssigned.waitFor({ state: "hidden" });
  assert.equal(await invoicePicker.inputValue(), "", "the Invoice / credit picker is back on use-default/inherit");
  await shot("customer-invoice-template-cleared");

  // --- PR 2 of the statement canvas lane: a statement designed on the canvas, published and printed
  // (design §11). The statement is the fixture customer's own, printed through the counted request
  // to the statements route, which stores each print: the customer has no division (so the route's
  // #136 refusal does not reach it), the single print skips nothing at a zero net (only the run
  // does), and the print takes no period guard (close-month-end leaves the month closed). The
  // invoice above is a draft, so the statement holds no open item: its open items block prints its
  // heading row alone, its aging all zeros and Total Due $0.00, its Bill To the customer's name alone
  // (the customer has no address). A Statement template of this run's own carries the logo at
  // header-left at the editor's default width on v1, which is published, assigned to the fixture
  // customer and printed: today's paper. A v2 draft is designed on the canvas from that customer, the
  // logo dragged into the header's middle, the Remit To box moved to the left margin and the customer
  // line, the statement date and the Bill To block to the right by their typed X (no drag grabs
  // across another item), and the draft saved, published and printed again: each moved item's
  // printed move equals the designer's, and the open items' Document # heading stays where it was, the
  // held Bill To keeping the open items where the flow printed them. The customer-scoped teardown
  // deletes the stored statements (`deleteStatementDocuments`); the template, and any assignment of it
  // a failure leaves behind, is reaped by name.
  await page.goto(`${ctx.baseURL}/admin/templates`);
  await page.getByRole("heading", { name: "Document templates" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "New template", exact: true }).click();
  await docTypePicker.selectOption("STATEMENT");
  await page.getByPlaceholder("Template name").fill(STATEMENT_CANVAS_TEMPLATE_NAME);
  await page.getByRole("button", { name: "Create template" }).click();
  await page.getByRole("link", { name: "Edit draft" }).click();
  await page.waitForURL(new RegExp(`${ctx.baseURL}/admin/templates/[^/]+/edit`));
  await page.getByRole("heading", { name: STATEMENT_CANVAS_TEMPLATE_NAME }).waitFor({ state: "visible" });
  await page.getByText("Statement · editing draft v1").waitFor({ state: "visible" });
  await openRecordTab(page, "Appearance");
  await page.getByText("No image uploaded").waitFor({ state: "visible" });
  await page.getByLabel("Upload logo image").setInputFiles(LOGO_FIXTURE);
  await page.getByText(/Image on file \(image\/png\)/).waitFor({ state: "visible" });
  await page.getByRole("combobox", { name: "Logo placement" }).selectOption("header-left");
  await saveDraft.click();
  await page.getByRole("region", { name: "Template status" }).getByText("Saved", { exact: true }).waitFor({ state: "visible" });
  const statementTemplate = { list: "Statement", name: STATEMENT_CANVAS_TEMPLATE_NAME };
  await publishDraft(1, statementTemplate);

  // Assigned to the fixture customer, whose picker starts on use-default/inherit; it is cleared back
  // at the end of this section, and deleteDocumentTemplatesByName reaps any assignment of this
  // template by name should the flow stop before then.
  const statementPicker = page.getByRole("combobox", { name: "Template for Statement", exact: true });
  const statementAssigned = page.getByText(`Assigned: ${STATEMENT_CANVAS_TEMPLATE_NAME}`);
  await page.goto(`${ctx.baseURL}/customers/${target.id}`);
  await openRecordTab(page, "Defaults & documents");
  await statementPicker.waitFor({ state: "visible" });
  assert.equal(await statementPicker.inputValue(), "", `${fixtures.customerCode}'s Statement picker starts on use-default/inherit`);
  await statementPicker.selectOption({ label: STATEMENT_CANVAS_TEMPLATE_NAME });
  await statementAssigned.waitFor({ state: "visible" });

  const printStatementDoc = async (what) => {
    const printed = await ctx.apiMutate(page, `${ctx.baseURL}/api/receivables/statements`, {
      method: "POST", data: { customerId: target.id },
    });
    assert.equal(printed.ok(), true, `${what}: the statement prints: ${printed.status()}`);
    const documentId = printed.headers()["x-document-id"];
    assert.ok(documentId, `${what}: the print names its stored document`);
    return storedPdf(page, ctx.baseURL, documentId, what);
  };
  // The statement's one page: the logo, told by its 160:48 proportions; the Remit To box's label (the
  // contract's "Remit To", printed as given); the customer line's and the statement date's labels; the
  // Bill To's label; and the open items' Document # heading, which the designer leaves alone, each
  // read from the stored document's own page.
  const statementPaperOf = (bytes, what) => {
    const pages = pageCount(bytes);
    assert.equal(pages, 1, `${what}: the statement prints one page`);
    const runs = printedRuns(bytes, { pages, what })[0];
    const logos = printedImages(bytes, { pages, what })[0].filter((box) => Math.abs(box.w / box.h - LOGO_ASPECT) < 0.05);
    assert.equal(logos.length, 1, `${what}: page 1 paints one image in the logo's 160:48 proportions: ${JSON.stringify(logos)}`);
    return {
      logo: logos[0],
      remitTo: phraseRun(runs, "Remit To", what, "the Remit To box's label"),
      customer: phraseRun(runs, "Customer:", what, "the customer line's label"),
      date: phraseRun(runs, "Statement Date:", what, "the statement date's label"),
      billTo: phraseRun(runs, "Bill To", what, "the Bill To's label"),
      documentNo: phraseRun(runs, "Document #", what, "the open items' Document # heading"),
    };
  };
  const statementBefore = statementPaperOf(await printStatementDoc("the sections statement"), "the sections statement");

  const statementRow = await selectTemplate(statementTemplate);
  await statementRow.getByText("Published v1").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Open draft", exact: true }).click();
  await page.getByText("Open draft: v2").waitFor({ state: "visible" });
  await page.getByRole("link", { name: "Edit draft" }).click();
  await page.waitForURL(new RegExp(`${ctx.baseURL}/admin/templates/[^/]+/edit`));
  await page.getByText("Statement · editing draft v2").waitFor({ state: "visible" });

  await page.setViewportSize({ width: 1440, height: 900 });
  await openRecordTab(page, "Sections");
  await designOnCanvas.waitFor({ state: "visible" });
  assert.equal(await designOnCanvas.isDisabled(), true, "Design on a canvas waits for a customer picked in Preview");
  assert.equal(await designOnCanvas.getAttribute("title"), "Pick a customer in Preview first");
  // The Preview tab's own as-of date box, scoped to its panel: once the Design panel mounts its live
  // page, that panel holds a box of the same name. The date is the machine's local day, so a run that
  // crosses midnight seeds and prints on different days; nothing measured here moves with it, the
  // fixture customer holding no open items.
  const asOfToday = new Date().toLocaleDateString("en-CA");
  await openRecordTab(page, "Preview");
  const previewPanel = page.getByRole("tabpanel", { name: "Preview", exact: true });
  await previewPanel.getByRole("combobox", { name: "Preview record" })
    .selectOption({ label: `${fixtures.customerCode} — ${target.name}` });
  const previewAsOf = previewPanel.getByLabel("Statement as-of date", { exact: true });
  await previewAsOf.fill(asOfToday);
  await waitForValue(previewAsOf, asOfToday);
  await openRecordTab(page, "Sections");
  await designOnCanvas.click();
  await confirm.waitFor({ state: "visible" });
  const statementConfirmText = (await confirm.textContent()) ?? "";
  assert.ok(statementConfirmText.includes(`customer ${fixtures.customerCode}`),
    `the confirm names the customer as the seed: ${JSON.stringify(statementConfirmText)}`);
  await confirm.getByRole("button", { name: "Design on a canvas", exact: true }).click();
  await confirm.waitFor({ state: "hidden" });
  await designPanel.waitFor({ state: "visible" });
  assert.equal(await page.getByRole("tab", { name: /^Sections/ }).count(), 0, "a canvas statement shows Design in place of Sections (pin)");
  // The Design panel's own as-of date box reads the date set on the Preview tab: the editor holds the
  // one value both panes read, since statement canvas PR 2.
  await waitForValue(designPanel.getByLabel("Statement as-of date", { exact: true }), asOfToday);
  const statementFields = ["Customer", "Statement date", "Remit-to box"];
  const statementBlocks = ["Bill-to address table", "Open items table", "Aging strip table", "Finance charge table", "Total due table"];
  const statementRemit = canvasItem("Remit-to box");
  const billToItem = canvasItem("Bill-to address table");
  const leftColumnItems = [
    { name: "Customer", item: canvasItem("Customer") },
    { name: "Statement date", item: canvasItem("Statement date") },
    { name: "Bill-to address table", item: billToItem },
  ];
  // Every item the seed places, by its exact name: the logo, the header's two pieces, the identity's
  // three fields and the five blocks. The fixture customer's statement prints the Bill To, the open
  // items' heading row, the aging and Total Due, so those four blocks are measured taller than 0 and
  // drawn at that height, and each is waited for visible. The single print assesses no finance charge,
  // so the finance block prints nothing for this customer: the stage marks it `data-empty` once the
  // measure lands, and the flow waits for the mark, never for visibility (#955, #958).
  for (const item of [logoItem, titleItem, companyItem, ...statementFields.map(canvasItem),
    ...statementBlocks.filter((name) => name !== "Finance charge table").map(canvasItem)]) {
    await item.waitFor({ state: "visible" });
  }
  await waitEmpty(canvasItem("Finance charge table"), "Finance charge table");
  // The Bill To is a block keyed by its field, never a field item of its own (the profile's `keyed:
  // "field"`), and a statement's canvas holds no barcode.
  await assertNeverVisible(canvasItem("Bill-to address"), "a statement's Bill To is a block, never a field item", 500);
  await assertNeverVisible(barcodeItem, "a statement's canvas holds no barcode", 500);
  await livePage.waitFor({ state: "visible" });
  await shot("statement-canvas-seeded");

  // The open items are a rows block: its inspector shows each row's Show box and no column Width box.
  // The aging strip is a column table: its inspector shows each column's Width box
  // (`DESIGNER_WORDS.columnWidth`'s words, over the field's own name).
  await inspect(canvasItem("Open items table"), "Open items table");
  await designPanel.getByLabel("Show Document number", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await designPanel.getByLabel(/^Width for /).count(), 0, "a rows block's inspector shows no column Width box (pin)");
  await inspect(canvasItem("Aging strip table"), "Aging strip table");
  await designPanel.getByLabel("Width for Current bucket (pt)", { exact: true }).waitFor({ state: "visible" });

  /** The overlap of the Remit To box with a left-column item (warning (a)), in the stage's words, in
   *  either order. */
  const overlapsLeftColumn = (title) =>
    /(Remit-to box field and the (Customer field|Statement date field|Bill-to address table)|(Customer field|Statement date field|Bill-to address table) and the Remit-to box field) overlap/.test(title);
  assert.equal(overlapsLeftColumn(await drawnTitle(statementRemit)), false,
    "the seeded Remit To box overlaps no left-column item (pin: the title is read once, unwaited; titleUntil below is the proof)");

  // The logo into the header's middle, 144 pt across and one grid step down, by a drag: nothing lies
  // over the point a quarter in from its left edge, at its middle height.
  const statementLogoFrom = await inspect(logoItem, "Logo");
  const statementLogoTo = await drag(logoItem, statementLogoFrom, 144, 4.5, "Logo");
  assert.equal(await anchorBox.inputValue(), "page-top", "the moved logo is still anchored at the page's top");

  // The Remit To box to the first grid line at or right of the left margin, by its typed X: 0.375 in,
  // 27 pt (the box shows 0.38). Over the left column now, so the stage warns of the overlap (warning
  // (a)): the silence below, once the left column has moved right of it, is the warning cleared, not
  // one never raised.
  const statementRemitFrom = await inspect(statementRemit, "Remit-to box");
  const statementRemitWidth = Number(await widthBox.inputValue()) * 72;
  const statementRemitTo = await typeX("0.375", "0.38");
  assert.equal(statementRemitTo.y, statementRemitFrom.y, "typing the X moved the Remit To box across only");
  assert.equal(await anchorBox.inputValue(), "page-top", "the moved Remit To box is still anchored at the page's top");
  await titleUntil(statementRemit, overlapsLeftColumn, "the Remit To box at the left margin overlaps the left column");

  // The customer line, the statement date and the Bill To block each to the right margin less the
  // width the inspector shows, snapped to the grid at or left of it. A field keeps its page-top anchor;
  // a table shows no Anchor box (it stacks with the tables), so the Bill To's move is read by its X
  // and Y alone.
  const leftColumnMoves = [];
  for (const { name, item } of leftColumnItems) {
    const from = await inspect(item, name);
    const width = Number(await widthBox.inputValue()) * 72;
    const place = gridAtOrLeft(RIGHT_MARGIN - width);
    assert.ok(place.pt > remitLeftPt + statementRemitWidth,
      `${name}'s new left edge, ${place.pt} pt, lies right of the moved Remit To box's right edge`);
    const to = await typeX(String(place.pt / 72), place.shown);
    assert.equal(to.y, from.y, `typing the X moved ${name} across only`);
    if (name === "Bill-to address table") {
      assert.equal(await anchorBox.count(), 0, "a table's inspector shows no Anchor box (pin)");
    } else {
      assert.equal(await anchorBox.inputValue(), "page-top", `the moved ${name} is still anchored at the page's top`);
    }
    leftColumnMoves.push({ name, from, to });
  }
  // The Remit To box now lies left of every left-column item: the overlap is gone.
  await titleUntil(statementRemit, (title) => !overlapsLeftColumn(title), "the Remit To box clear of the moved left column");
  await shot("statement-canvas-items-moved");

  // Nothing refuses the moved canvas; a warning the dragged logo raises over the header's pieces
  // refuses nothing either.
  assert.equal(await saveDraft.isDisabled(), false, `the moved canvas statement saves; Save draft's title reads ${JSON.stringify(await saveDraft.getAttribute("title"))}`);
  assert.equal(await saveDraft.getAttribute("title"), null, "Save draft carries no refusal");
  await saveDraft.click();
  await page.getByRole("region", { name: "Template status" }).getByText("Saved", { exact: true }).waitFor({ state: "visible" });
  await page.setViewportSize(viewport);

  await publishDraft(2, statementTemplate);
  const statementAfter = statementPaperOf(await printStatementDoc("the canvas statement"), "the canvas statement");
  const statementLogoMove = moved(statementLogoFrom, statementLogoTo);
  const statementRemitMove = moved(statementRemitFrom, statementRemitTo);
  // The designer moved the logo by the dragged amount, within 2 pt across (144 is on the grid) and
  // within the drop's snap down; the Remit To box's typed 27 pt is typeX's wait on its X box.
  within2pt(statementLogoMove.x, 144, "the designer's move of the statement's logo across");
  withinSnap(statementLogoMove.y, 4.5, "the designer's move of the statement's logo down");
  within2pt(statementAfter.logo.x - statementBefore.logo.x, statementLogoMove.x, "the statement's printed logo's move across");
  within2pt(statementAfter.logo.y - statementBefore.logo.y, statementLogoMove.y, "the statement's printed logo's move down");
  within2pt(statementAfter.logo.w, statementBefore.logo.w, "the statement's printed logo's width");
  within2pt(statementAfter.logo.h, statementBefore.logo.h, "the statement's printed logo's height");
  within2pt(statementAfter.remitTo.x - statementBefore.remitTo.x, statementRemitMove.x, "the statement's printed Remit To label's move across");
  within2pt(statementAfter.remitTo.y - statementBefore.remitTo.y, statementRemitMove.y, "the statement's printed Remit To label's move down");
  const printedLeftColumn = { Customer: "customer", "Statement date": "date", "Bill-to address table": "billTo" };
  for (const { name, from, to } of leftColumnMoves) {
    const move = moved(from, to);
    const key = printedLeftColumn[name];
    within2pt(statementAfter[key].x - statementBefore[key].x, move.x, `the printed ${name} label's move across`);
    within2pt(statementAfter[key].y - statementBefore[key].y, move.y, `the printed ${name} label's move down`);
  }
  // The held Bill To keeps the open items where the flow printed them.
  within2pt(statementAfter.documentNo.x, statementBefore.documentNo.x, "the printed Document # heading's x");
  within2pt(statementAfter.documentNo.y, statementBefore.documentNo.y, "the printed Document # heading's y");

  // Back to the customer: the Statement picker cleared to the default and read back. The stored
  // statements stay for the teardown to reap.
  await page.goto(`${ctx.baseURL}/customers/${target.id}`);
  await openRecordTab(page, "Defaults & documents");
  await statementPicker.waitFor({ state: "visible" });
  await statementAssigned.waitFor({ state: "visible" });
  await statementPicker.selectOption({ label: "Use default / inherit" });
  await statementAssigned.waitFor({ state: "hidden" });
  assert.equal(await statementPicker.inputValue(), "", "the Statement picker is back on use-default/inherit");
  await shot("customer-statement-template-cleared");

  // --- PR 2 of the quote canvas lane: a quotation designed on the canvas, published and printed
  // (design §11). The quote is this section's own, made through the counted request for the quote
  // fixture customer with one free-text line and no price rows. That customer is opted out of
  // surcharges, so no estimate row prints (the rows are held in vitest); it has no address, so its
  // bill-to is its name alone. A Quotation template of this run's own carries the logo at header-left
  // at the editor's default width on v1, which is published, assigned to that customer and printed:
  // today's paper. A v2 draft is designed on the canvas from that quote, the logo dragged into the
  // header's middle and the quotation number and the parties block each moved a grid step down by
  // their typed Y, and the draft saved, published and printed again: each moved item's printed move
  // equals the designer's, and the column headers' Net weight / Price heading stays where it was. A
  // typed Y moves the one block it is typed for: the blocks under the parties keep their drawn y, so
  // the gap under the parties shrinks by the move and the intro, and every block after it, prints
  // where it did. The quote and its stored pages ride the quote customer's reap
  // (`deleteQuotesAndChildren`); the template, and any assignment of it a failure leaves behind, is
  // reaped by name.
  const quotePartNumber = "E2EQUOTECANVAS";
  const madeQuote = await ctx.apiMutate(page, `${ctx.baseURL}/api/quotes`, {
    method: "POST",
    data: {
      customerId: fixtures.quoteCustomerId,
      lines: [{ partNumberText: quotePartNumber, partNameText: "E2E canvas part", eachWeight: 2, quotedQty: 10 }],
    },
  });
  assert.equal(madeQuote.ok(), true, `the quote of ${fixtures.quoteCustomerCode} is made: ${madeQuote.status()}`);
  const quote = await madeQuote.json();
  // The number the paper, the Preview option and the confirm carry, read from the answer.
  assert.ok(Number.isInteger(quote.quoteNumber), `the made quote names its number: ${JSON.stringify(quote.quoteNumber)}`);

  await page.goto(`${ctx.baseURL}/admin/templates`);
  await page.getByRole("heading", { name: "Document templates" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "New template", exact: true }).click();
  await docTypePicker.selectOption("QUOTE");
  await page.getByPlaceholder("Template name").fill(QUOTE_CANVAS_TEMPLATE_NAME);
  await page.getByRole("button", { name: "Create template" }).click();
  await page.getByRole("link", { name: "Edit draft" }).click();
  await page.waitForURL(new RegExp(`${ctx.baseURL}/admin/templates/[^/]+/edit`));
  await page.getByRole("heading", { name: QUOTE_CANVAS_TEMPLATE_NAME }).waitFor({ state: "visible" });
  await page.getByText("Quotation · editing draft v1").waitFor({ state: "visible" });
  await openRecordTab(page, "Appearance");
  await page.getByText("No image uploaded").waitFor({ state: "visible" });
  await page.getByLabel("Upload logo image").setInputFiles(LOGO_FIXTURE);
  await page.getByText(/Image on file \(image\/png\)/).waitFor({ state: "visible" });
  await page.getByRole("combobox", { name: "Logo placement" }).selectOption("header-left");
  await saveDraft.click();
  await page.getByRole("region", { name: "Template status" }).getByText("Saved", { exact: true }).waitFor({ state: "visible" });
  const quoteTemplate = { list: "Quotation", name: QUOTE_CANVAS_TEMPLATE_NAME };
  await publishDraft(1, quoteTemplate);

  // Assigned to the quote customer, whose picker starts on use-default/inherit; it is cleared back at
  // the end of this section, and deleteDocumentTemplatesByName reaps any assignment of this template by
  // name should the flow stop before then.
  const quotePicker = page.getByRole("combobox", { name: "Template for Quotation", exact: true });
  const quoteAssigned = page.getByText(`Assigned: ${QUOTE_CANVAS_TEMPLATE_NAME}`);
  await page.goto(`${ctx.baseURL}/customers/${fixtures.quoteCustomerId}`);
  await openRecordTab(page, "Defaults & documents");
  await quotePicker.waitFor({ state: "visible" });
  assert.equal(await quotePicker.inputValue(), "", `${fixtures.quoteCustomerCode}'s Quotation picker starts on use-default/inherit`);
  await quotePicker.selectOption({ label: QUOTE_CANVAS_TEMPLATE_NAME });
  await quoteAssigned.waitFor({ state: "visible" });

  const printQuoteDoc = async (what) => {
    const printed = await ctx.apiMutate(page, `${ctx.baseURL}/api/quotes/${quote.id}/print`, { method: "POST" });
    assert.equal(printed.ok(), true, `${what}: the quote prints: ${printed.status()}`);
    const documentId = printed.headers()["x-document-id"];
    assert.ok(documentId, `${what}: the print names its stored document`);
    return storedPdf(page, ctx.baseURL, documentId, what);
  };
  /** A printed phrase: the first run's place, where the runs from it, joined as they are and each run
   *  of white space read as one space, read the phrase whole; it must print exactly once. Unlike
   *  `phraseRun` it takes a run that holds more than one word (the column heading prints "weight / "
   *  as one run). */
  const printedAt = (runs, phrase, what, name) => {
    const starts = runs.flatMap((run, index) => {
      let joined = "";
      for (const next of runs.slice(index)) {
        joined += next.text;
        const read = joined.replace(/\s+/g, " ").trim();
        if (read === phrase) return [run];
        if (!phrase.startsWith(read)) return [];
      }
      return [];
    });
    assert.equal(starts.length, 1,
      `${what}: ${name} ${JSON.stringify(phrase)} prints once among ${JSON.stringify(runs.map((run) => run.text))}`);
    return starts[0];
  };
  // The quote's one page: the logo, told by its 160:48 proportions; the title and the number's line,
  // the bill-to's first line (the customer's name: the customer has no address), the line's part
  // number, the column headers' Net weight / Price heading and the page line with its colon, each
  // read from the stored document's own page; and no line holding "(estimate)", the customer being
  // opted out of surcharges. The title is read as a whole line, since the number's label begins with
  // the same word.
  const quotePaperOf = (bytes, what) => {
    const pages = pageCount(bytes);
    assert.equal(pages, 1, `${what}: the quote prints one page`);
    const lines = printedPages(bytes, { pages, what })[0];
    const runs = printedRuns(bytes, { pages, what })[0];
    const logos = printedImages(bytes, { pages, what })[0].filter((box) => Math.abs(box.w / box.h - LOGO_ASPECT) < 0.05);
    assert.equal(logos.length, 1, `${what}: page 1 paints one image in the logo's 160:48 proportions: ${JSON.stringify(logos)}`);
    assert.ok(lines.includes("Quotation"), `${what}: the title prints: ${JSON.stringify(lines)}`);
    assert.ok(lines.includes(`Quotation Number: ${quote.quoteNumber}`), `${what}: the number's line prints: ${JSON.stringify(lines)}`);
    assert.ok(lines.some((line) => line.includes(quotePartNumber)), `${what}: the line's part number prints: ${JSON.stringify(lines)}`);
    assert.ok(lines.includes("Page: 1 of 1"), `${what}: the page line prints with its colon: ${JSON.stringify(lines)}`);
    assert.equal(lines.some((line) => line.includes("(estimate)")), false, `${what}: no surcharge estimate row prints: ${JSON.stringify(lines)}`);
    return {
      logo: logos[0],
      number: printedAt(runs, "Quotation Number:", what, "the number's label"),
      billTo: printedAt(runs, quote.customerName, what, "the bill-to's first line"),
      amount: printedAt(runs, "Net weight / Price", what, "the column headers' Net weight / Price heading"),
    };
  };
  const quoteBefore = quotePaperOf(await printQuoteDoc("the sections quote"), "the sections quote");

  const quoteRow = await selectTemplate(quoteTemplate);
  await quoteRow.getByText("Published v1").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Open draft", exact: true }).click();
  await page.getByText("Open draft: v2").waitFor({ state: "visible" });
  await page.getByRole("link", { name: "Edit draft" }).click();
  await page.waitForURL(new RegExp(`${ctx.baseURL}/admin/templates/[^/]+/edit`));
  await page.getByText("Quotation · editing draft v2").waitFor({ state: "visible" });

  await page.setViewportSize({ width: 1440, height: 900 });
  await openRecordTab(page, "Sections");
  await designOnCanvas.waitFor({ state: "visible" });
  assert.equal(await designOnCanvas.isDisabled(), true, "Design on a canvas waits for a quote picked in Preview");
  assert.equal(await designOnCanvas.getAttribute("title"), "Pick a quote in Preview first");
  await openRecordTab(page, "Preview");
  await page.getByRole("tabpanel", { name: "Preview", exact: true }).getByRole("combobox", { name: "Preview record" })
    .selectOption({ label: `Quote #${quote.quoteNumber} — ${quote.customerCode} (${quote.status})` });
  await openRecordTab(page, "Sections");
  await designOnCanvas.click();
  await confirm.waitFor({ state: "visible" });
  const quoteConfirmText = (await confirm.textContent()) ?? "";
  assert.ok(quoteConfirmText.includes(`quote #${quote.quoteNumber}`),
    `the confirm names the quote as the seed: ${JSON.stringify(quoteConfirmText)}`);
  await confirm.getByRole("button", { name: "Design on a canvas", exact: true }).click();
  await confirm.waitFor({ state: "hidden" });
  await designPanel.waitFor({ state: "visible" });
  assert.equal(await page.getByRole("tab", { name: /^Sections/ }).count(), 0, "a canvas quote shows Design in place of Sections (pin)");
  const [partiesName, introName, columnHeadersName, linesName, closingName, liabilityName] = QUOTE_CANVAS_BLOCKS;
  const quoteNumberItem = canvasItem("Quotation number");
  const partiesItem = canvasItem(partiesName);
  // Every item the seed places for this quote, by its exact name: the logo, the header's four fields
  // and the six blocks. The quote prints the parties, the intro, the column headers, its one line and
  // the closing, so those five blocks are measured taller than 0 and drawn at that height, and each is
  // waited for visible. The liability's wording is the Standard's, blank, so the liability prints
  // nothing: the stage marks it `data-empty` once the measure lands, and the flow waits for the mark,
  // never for visibility (#955, #958).
  for (const item of [logoItem, ...QUOTE_CANVAS_FIELDS.map(canvasItem),
    ...[partiesName, introName, columnHeadersName, linesName, closingName].map(canvasItem)]) {
    await item.waitFor({ state: "visible" });
  }
  await waitEmpty(canvasItem(liabilityName), liabilityName);
  // A rows block's rows are its own, never field items of their own (the parties' bill-to, the lines'
  // Material, the closing's ending statement), and a quote's canvas holds no barcode.
  for (const row of ["Bill-to address", "Material", "Ending statement"]) {
    await assertNeverVisible(canvasItem(row), `a quote's ${row} row is its block's, never a field item`, 500);
  }
  await assertNeverVisible(barcodeItem, "a quote's canvas holds no barcode", 500);
  await livePage.waitFor({ state: "visible" });
  await shot("quote-canvas-seeded");

  // The lines are a rows block: its inspector shows each row's Show box and no column Width box. The
  // column headers are the column table: its inspector shows each column's Width box
  // (`DESIGNER_WORDS.columnWidth`'s words, over the field's own name).
  await inspect(canvasItem(linesName), linesName);
  await designPanel.getByLabel("Show Material", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await designPanel.getByLabel(/^Width for /).count(), 0, "a rows block's inspector shows no column Width box (pin)");
  await inspect(canvasItem(columnHeadersName), columnHeadersName);
  await designPanel.getByLabel("Width for Amount column (pt)", { exact: true }).waitFor({ state: "visible" });

  /** Types the Y box one grid step (1/16 in) below the inches it shows, leaves it, and answers the
   *  item's X and Y once the Y box shows another stored figure: two decimals, as the box shows the
   *  stored place once it is left, never the typed text. The seeded Y's are off the grid and the box
   *  shows two decimals, so the snapped figure is read back, never worked out here: the typed figure
   *  snaps to the grid line nearest it, a move of between half a grid step and a grid step and a half. */
  const typeYDown = async (from, name) => {
    await yBox.fill(String(Number(from.y) + CANVAS_GRID / 72));
    await yBox.press("Tab");
    const deadline = Date.now() + 5000;
    for (;;) {
      const y = await yBox.inputValue();
      if (y !== from.y && /^\d+\.\d{2}$/.test(y)) return { x: await xBox.inputValue(), y };
      assert.ok(Date.now() < deadline, `${name} Y after the typed Y: the box reads ${JSON.stringify(y)}`);
      await delay(50);
    }
  };
  /** Fails unless a typed Y moved `name` straight down by a grid step as the boxes show it: more than
   *  the 2 pt the printed moves are held to (so a print that moved nothing cannot pass for it), and at
   *  most a grid step and a half (the snap) and the box's rounding. */
  const movedDown = (from, to, name) => {
    assert.equal(to.x, from.x, `typing the Y moved ${name} down only`);
    const dy = moved(from, to).y;
    assert.ok(dy > 2.5 && dy <= CANVAS_GRID * 1.5 + 0.72, `${name} moved down a grid step: ${dy.toFixed(2)} pt`);
  };
  const repeatBox = designPanel.getByLabel("Repeat on every page", { exact: true });

  // The logo into the header's middle, 144 pt across and one grid step down, by a drag: nothing lies
  // over the point a quarter in from its left edge, at its middle height.
  const quoteLogoFrom = await inspect(logoItem, "Logo");
  const quoteLogoTo = await drag(logoItem, quoteLogoFrom, 144, 4.5, "Logo");
  assert.equal(await anchorBox.inputValue(), "page-top", "the moved logo is still anchored at the page's top");

  // The quotation number a grid step down by its typed Y. The seed flagged it to repeat (call 2, ruled
  // (a)); moved down it still ends well above the parties, so it keeps its Repeat.
  const quoteNumberFrom = await inspect(quoteNumberItem, "Quotation number");
  assert.equal(await repeatBox.isChecked(), true, "the seeded quotation number repeats on every page");
  const quoteNumberTo = await typeYDown(quoteNumberFrom, "the quotation number");
  movedDown(quoteNumberFrom, quoteNumberTo, "the quotation number");
  assert.equal(await anchorBox.inputValue(), "page-top", "the moved quotation number is still anchored at the page's top");
  assert.equal(await repeatBox.isChecked(), true, "the moved quotation number still repeats on every page");

  // The parties block a grid step down by its typed Y. The seeded gap under it is 10 pt (the parties'
  // 8 and the intro's 2), so the move leaves its bottom above the intro's top, read from the intro's
  // own Y box; a table shows no Anchor box (it stacks with the tables).
  const introTop = Number((await inspect(canvasItem(introName), introName)).y);
  const quotePartiesFrom = await inspect(partiesItem, partiesName);
  const partiesHeight = Number(await heightBox.inputValue());
  const quotePartiesTo = await typeYDown(quotePartiesFrom, partiesName);
  movedDown(quotePartiesFrom, quotePartiesTo, partiesName);
  assert.ok(Number(quotePartiesTo.y) + partiesHeight < introTop,
    `the moved parties end above the intro: ${quotePartiesTo.y} + ${partiesHeight} in, the intro at ${introTop} in`);
  assert.equal(await anchorBox.count(), 0, "a table's inspector shows no Anchor box (pin)");
  await shot("quote-canvas-items-moved");

  // Nothing refuses the moved canvas; a warning the dragged logo raises over the header's pieces
  // refuses nothing either.
  assert.equal(await saveDraft.isDisabled(), false, `the moved canvas quote saves; Save draft's title reads ${JSON.stringify(await saveDraft.getAttribute("title"))}`);
  assert.equal(await saveDraft.getAttribute("title"), null, "Save draft carries no refusal");
  await saveDraft.click();
  await page.getByRole("region", { name: "Template status" }).getByText("Saved", { exact: true }).waitFor({ state: "visible" });
  await page.setViewportSize(viewport);

  await publishDraft(2, quoteTemplate);
  const quoteAfter = quotePaperOf(await printQuoteDoc("the canvas quote"), "the canvas quote");
  const quoteLogoMove = moved(quoteLogoFrom, quoteLogoTo);
  const quoteNumberMove = moved(quoteNumberFrom, quoteNumberTo);
  const quotePartiesMove = moved(quotePartiesFrom, quotePartiesTo);
  // The designer moved the logo by the dragged amount, within 2 pt across (144 is on the grid) and
  // within the drop's snap down.
  within2pt(quoteLogoMove.x, 144, "the designer's move of the quote's logo across");
  withinSnap(quoteLogoMove.y, 4.5, "the designer's move of the quote's logo down");
  within2pt(quoteAfter.logo.x - quoteBefore.logo.x, quoteLogoMove.x, "the quote's printed logo's move across");
  within2pt(quoteAfter.logo.y - quoteBefore.logo.y, quoteLogoMove.y, "the quote's printed logo's move down");
  within2pt(quoteAfter.logo.w, quoteBefore.logo.w, "the quote's printed logo's width");
  within2pt(quoteAfter.logo.h, quoteBefore.logo.h, "the quote's printed logo's height");
  within2pt(quoteAfter.number.x - quoteBefore.number.x, quoteNumberMove.x, "the printed quotation number's move across");
  within2pt(quoteAfter.number.y - quoteBefore.number.y, quoteNumberMove.y, "the printed quotation number's move down");
  within2pt(quoteAfter.billTo.x - quoteBefore.billTo.x, quotePartiesMove.x, "the printed bill-to line's move across");
  within2pt(quoteAfter.billTo.y - quoteBefore.billTo.y, quotePartiesMove.y, "the printed bill-to line's move down");
  // The intro and every block after it keep their drawn y, so the column headers print where the flow
  // printed them: the shrunk gap under the parties absorbs the parties' move.
  within2pt(quoteAfter.amount.x, quoteBefore.amount.x, "the printed Net weight / Price heading's x");
  within2pt(quoteAfter.amount.y, quoteBefore.amount.y, "the printed Net weight / Price heading's y");

  // Back to the customer: the Quotation picker cleared to the default and read back. The quote and its
  // stored pages stay for the teardown to reap.
  await page.goto(`${ctx.baseURL}/customers/${fixtures.quoteCustomerId}`);
  await openRecordTab(page, "Defaults & documents");
  await quotePicker.waitFor({ state: "visible" });
  await quoteAssigned.waitFor({ state: "visible" });
  await quotePicker.selectOption({ label: "Use default / inherit" });
  await quoteAssigned.waitFor({ state: "hidden" });
  assert.equal(await quotePicker.inputValue(), "", "the Quotation picker is back on use-default/inherit");
  await shot("customer-quote-template-cleared");

  // --- PR 13: the Bill of lading's Standing clauses: one box, and a clause's text kept across picks ---
  await page.goto(`${ctx.baseURL}/admin/templates`);
  await page.getByRole("heading", { name: "Document templates" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "New template", exact: true }).click();
  await docTypePicker.selectOption("BOL");
  await page.getByPlaceholder("Template name").fill(BOL_TEMPLATE_NAME);
  await page.getByRole("button", { name: "Create template" }).click();
  await page.getByRole("link", { name: "Edit draft" }).click();
  await page.waitForURL(new RegExp(`${ctx.baseURL}/admin/templates/[^/]+/edit`));
  await page.getByRole("heading", { name: BOL_TEMPLATE_NAME }).waitFor({ state: "visible" });
  await openRecordTab(page, "Wording");
  const propertyClause = page.getByRole("button", { name: "Property clause", exact: true });
  assert.equal(await propertyClause.getAttribute("aria-current"), "true", "Property clause is first picked");
  assert.equal(await page.getByRole("tabpanel", { name: "Wording" }).getByRole("textbox").count(), 1, "one clause, one box");
  const clauseBox = page.getByRole("textbox", { name: "Property clause", exact: true });
  await clauseBox.fill("E2E property wording");
  await page.getByRole("button", { name: "Received clause", exact: true }).click();
  await page.getByRole("textbox", { name: "Received clause", exact: true }).waitFor({ state: "visible" });
  await propertyClause.click();
  assert.equal(await clauseBox.inputValue(), "E2E property wording", "a clause's text survives picking another");
  await shot("editor-bol-standing-clauses");
  const statusCard = page.getByRole("region", { name: "Template status" });
  await statusCard.getByText("Unsaved", { exact: true }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await statusCard.getByText("Saved", { exact: true }).waitFor({ state: "visible" });

  // --- Re-logged-in as the restricted VIEW-ONLY user (templates.view, NOT admin.view) ---
  await login(page, ctx.baseURL, fixtures.restrictedUsername, fixtures.restrictedPassword);

  // The nav decision: this user SEES the Document templates entry (reaches the page) but NOT the
  // admin.view-gated entries — and only the groups that hold something they can open. The fixture
  // restricted role holds parts.view + processes.view + templates.view, so the rail is exactly
  // Reference (Parts & processes) and Configuration (Document templates): no Daily work, Billing,
  // People or System heading, and no admin.view-gated entry inside the two groups that do show.
  await page.getByRole("link", { name: "Document templates", exact: true }).waitFor({ state: "visible" });
  await assert.equal(
    await page.getByRole("link", { name: "Users" }).count(), 0,
    "a templates.view-only user (no admin.view) does not see the admin.view-gated entries",
  );
  assert.deepEqual(
    await railHeadings(page), ["Reference", "Configuration"],
    "a restricted user sees only the group headings that hold an entry they can open",
  );
  assert.deepEqual(
    await page.getByRole("navigation", { name: "Main" }).getByRole("link").allTextContents(),
    ["Parts & processes", "Document templates"],
    "the restricted rail holds exactly the entries this role's view grants reach",
  );
  await page.getByRole("link", { name: "Document templates", exact: true }).click();
  await page.waitForURL(`${ctx.baseURL}/admin/templates`);
  await page.getByRole("heading", { name: "Document templates" }).waitFor({ state: "visible" });

  // §5.16: every mutating control is disabled with a tooltip naming the missing permission.
  const createBtn = page.getByRole("button", { name: "Create template" });
  await assert.equal(await createBtn.isDisabled(), true, "Create is disabled for a view-only user");
  await assert.equal(
    await createBtn.getAttribute("title"), "Requires templates.create",
    "the disabled Create names the missing permission",
  );
  // The list still renders fully for a viewer — this is the disabled-with-reason path, not denied.
  // Wait for the async list before counting (same reason as the admin section above).
  await page.locator('li [aria-label="default"]').first().waitFor({ state: "visible" });
  // #234: per-type again — the claim is "a viewer still sees every type's seeded default", which
  // is exactly what this asserts, without counting rows the run does not own.
  for (const typeName of DOC_TYPES) await assertStandardDefault(typeName);
  await shot("templates-view-only-user-controls-disabled");
}
