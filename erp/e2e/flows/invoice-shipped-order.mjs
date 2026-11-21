// Flow 16 (Phase 5A, Task 20): the invoicing lifecycle, end to end (P5A design spec §5.4/§5.5/
// §10, ruling 3). Keys an order against a TWO-PartPrice part (one order line, two priced
// operations — the multi-operation case ruling 3 exists for), ships it complete, watches the
// board flip to Shipped, moves it through /invoicing's Ready-to-invoice worklist into a DRAFT
// invoice, confirms the invoice page shows both priced operations plus a surcharge and a sales-
// tax line, Finalizes it (locking the draft-edit controls and writing the order's INVOICED
// status), Prints it (the print→archive seam Task 19 built and no flow before this one has
// exercised — the document must appear in the invoice page's OWN Documents list, which Task 19's
// brief owed but never actually built; Task 20 closes that gap, see `documents.ts`'s
// `listDocumentsForInvoice` and its route), then Unlocks it with a reason and confirms both the
// invoice returns to Draft and the order's board status returns to its ship-derived Shipped
// (never Open — the order shipped its full ordered quantity, so Shipped is derived from quantity).
//
// #588: before that Print, the fixture customer's Invoice folder is set on the customer page, on the
// office share the harness owns (`ctx.officeShare`, e2e/run.mjs): a path outside the share is
// refused in the share's own words, and the customer's folder, made on disk first, is "Folder
// found." with the box's help line beside it. The finalized invoice's Print then files a copy in
// that folder under the name its download carries (`Invoice-<order#>.pdf`), the stored document's
// bytes exactly, with no temp file left and no line by Print. With the share's marker file renamed
// away, a second Print is archived and says by Print, amber, that the share is not connected,
// leaving the first copy as it was. The folder is put back to blank afterwards. Only an invoice is
// filed here: no flow prints a credit.
//
// Never `page.waitForURL(/\/invoicing\/[^/?]+$/)` for the /invoicing -> /invoicing/<id> hop (the
// Phase 3/4 URL trap, now armed twice already) — that pattern would also match the literal
// `/invoicing` list page's own URL at the instant the link is clicked. Every wait below is for
// POST-navigation-ONLY content: the invoice page's own h1 (kind + document-number badge), which
// only renders once the parent `invoice` state has loaded. The child line editor separately
// checks identity and the saved record before admitting its rows, so row assertions also wait
// for that editor's own fixture content below.
//
// Tax is exercised via the fixture customer's OWN `salesTaxRate` override, not by mutating the
// global `BillingConfig` singleton row — see the comment on `FIXTURE.invCustomerCode` in
// `e2e/lib/db-fixtures.ts` for why.
//
// The Finalize is pressed beside a refused PO number save, to prove the page reads once more after
// a write it overlapped (#573, owner ruling 2026-10-20, the hub's #550 rule), in both orderings.
// Finalize happens once on the way to the finalized paper, and the header boxes are read-only from
// then until Unlock, so a refused header save can sit beside Finalize alone: ordering (a) is proved
// on that Finalize, and ordering (b) on a second Finalize at the end, after the Unlock has returned
// the invoice to Draft, followed by a second Unlock so the flow ends where it did (Draft; the order
// Shipped on the board). The brief's fallback for (b), Unlock, cannot host it: a finalized
// invoice's PO number is read-only, so no refused save, and so no rollback read, can be sent
// beside Unlock. Neither can Recalculate: nothing on the page changes when the lines come back the
// same.
//   (a) Finalize is held before the server sees it. A PO number save is refused here with a 503,
//       so the page reads the invoice back, and the server serves that read as a draft. The page
//       applies it: the refusal is on the page, the box is back at its stored text, and the badge
//       still reads Draft. Then Finalize is let go; its answer is older than the applied read, so
//       the page drops it, and only the read the page sends after that answer can show Finalized.
//   (b) The same, with the answers the other way round: the server serves the rollback read as a
//       draft at once, and this flow's route keeps that answer from the page. Finalize's answer
//       lands first and the badge reads Finalized from it. Then the held answer lands, newer than
//       the write, and the badge reads Draft again; the read the page sends after it is held too
//       while the hold is on, so Draft stays until it is let go, and lands Finalized again. Both
//       beats are waited for in turn, so the Draft one is proved, not inferred.
// The header PATCH, the page's reads and the lines grid's recovery reads share the invoice's
// address, so the route answers only the PATCH, and a held read is shown to be the page's by what
// its landing does to the badge.
//
// The invoice's first print is the Invoicing list's Print selected (#591, the owner's rulings and
// words of 2026-10-20), taken while it is finalized and has never printed: the row's box, the
// confirm, the zip and what it holds, the closing line, the row's Printed cell, and the row's
// folder sentence under its Document No (the customer has no folder yet; the owner's ruling of
// 2026-10-21). The single Print on the invoice page follows it, so its Documents hold the selected
// print alone before that Print and two after it. The second Finalize blanks the row's Printed
// cell and gives it its box again, and the second Unlock leaves a draft that reads its newest print
// and has no box.
//
// Between the two prints, the same list's Export to PDF, the Invoice register (#592, the owner's
// rulings of 2026-10-20 and 2026-10-21). The Customer filter is set to this flow's customer, whom
// no earlier flow invoices, and the list's read of it is held after the server has answered: both
// export links still point at the unfiltered list while it is held, and carry the filter once it
// lands, as the list on screen does. The download is named for the plant's date, and its one page
// draws the title, the filter line, the Made line, the ten headers, the invoice's row, the summary
// of one document with its total, and `Page 1 of 1`. The filter goes with the page: every later
// step loads /invoicing afresh.
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { assertNeverVisible, waitForEnabled, waitForState, waitForTitle, waitForValue } from "../lib/ui.mjs";
import { openRecordTab } from "../lib/record-tabs.mjs";
import { answerModal, modalTitle } from "../lib/modal.mjs";
import { chooseMenuItem, glanceCard, glanceValue, invoicesSection as registerSection, menuItem, openInvoicingView } from "../lib/invoicing.mjs";
import { boardRow, createOrderViaUi, hubSection, startNewShipment, orderPanel, waitForShipmentPage } from "../lib/orders.mjs";
import { bounded, holdRequest, readJson } from "../lib/order-entry-workspace.mjs";
import { assertRun, printedPages, storedPdf } from "../lib/printed-page.mjs";
import { heardAfter, readAfter, readAfterAnswerFrom, withCleanups, wireRecordReads, writeBeforeRead } from "../lib/record-reads.mjs";
import { waitForRedLines, watchRequests } from "../lib/refusal-lines.mjs";
import { routeRequests } from "../route-keep-alive.mjs";
// The app's own words and marker name, with their `.ts` endings: plain node runs this file and
// resolves a relative name no other way, and both leaves import nothing (their headers).
import {
  FOLDER_FOUND, INVOICE_FOLDER_HELP, INVOICE_FOLDER_LABEL, notInsideShare, PRINT_FOLDER_NOT_FOUND, PRINT_NO_FOLDER,
  PRINT_NOT_CONNECTED, PRINT_REFUSED, PRINT_SKIPPED, PRINT_TIMED_OUT, PRINT_WARNING_UNREADABLE,
} from "../../src/lib/customer-folder-words.ts";
import { CUSTOMER_FOLDERS_MARKER } from "../../src/lib/invoice-folder-entry.ts";

const UNLOCK_REASON =
  "E2E invoice-shipped-order flow: intentional unlock, demonstrating the unlock UX for the demo.";
const SECOND_UNLOCK_REASON =
  "E2E invoice-shipped-order flow: intentional second unlock, after the #573 part's second finalize.";
// What this flow's own route answers a PO number save with in the #573 parts. No server sentence
// reads so.
const PO_SAVE_ANSWERED_HERE = "Answered by the invoice-shipped-order flow: the PO number was not saved.";
// #568: the answers this flow gives in place of the server's, each its own sentence so that no
// exact text match can find the other.
const CREATE_ANSWER_LOST = "E2E invoice-shipped-order: the Create was committed and its answer lost";
const CANDIDATES_READ_LOST = "E2E invoice-shipped-order: the candidates read after the lost answer failed too";
// #591: the owner's words for a run of one row (`confirmText` and `resultText`,
// src/lib/print-selected.ts), written out because a flow cannot import a src/ TypeScript module.
const PRINT_ONE_TITLE = "Print 1 document?"; // the modal's title (PR 6, `confirmParts`)
const PRINTED_ONE_OF_ONE = "Printed 1 of 1.";
// #592: the Invoice register's ten column headers and its summary's words for one row
// (src/server/pdf/invoice-register.ts, `summaryLabel` in src/lib/invoice-register-summary.ts),
// written out for the same reason.
const REGISTER_HEADERS = [
  "Document No", "Kind", "Order No", "Customer Code", "Customer Name",
  "Invoice Date", "Status", "Total", "Finalized", "Printed",
];
const ONE_DOCUMENT = "Total of 1 document";

// Lowercase and case-sensitive, like order-print-intent.ts's storage-key pattern: a stricter form of
// idempotent-save.ts's V4_UUID, which takes either case (a flow cannot import a src/ TypeScript
// module). tests/client-id.test.ts holds newId()'s fallback to V4_UUID.
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// #588: every line the invoice page can show by Print for a finalized print it did not file.
const PRINT_FOLDER_LINES = [
  PRINT_NO_FOLDER, PRINT_FOLDER_NOT_FOUND, PRINT_NOT_CONNECTED, PRINT_SKIPPED, PRINT_TIMED_OUT, PRINT_REFUSED,
  PRINT_WARNING_UNREADABLE,
];
// The invoice page's red line for a print whose tab was blocked or whose answer named no document,
// typed from InvoiceDetail.tsx's `printInvoice`, which holds it inline (no leaf a flow can import).
const PRINT_WINDOW_BLOCKED =
  "The browser blocked the print window — the document was archived and is in Documents & history.";

async function assertBoardStatus(page, ctx, orderNumber, statusText, absentText) {
  await page.goto(`${ctx.baseURL}/`);
  await page.getByRole("heading", { name: "Orders" }).waitFor({ state: "visible" });
  // #167a: `boardRow` matches the ORDER-NUMBER CELL, never "any cell holding these digits" — see
  // its comment in e2e/lib/orders.mjs for the collision that shape produced for real.
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

/** Both `/invoicing`'s two sections are plain `<section>`s, each headed by its own `<h2>` — the
 *  cleanest scope for a row lookup that must not cross into the other table. */
function sectionByHeading(page, headingText) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: headingText, exact: true }) });
}

/** #591: the zip's name on `date`'s local calendar day, `zipFileName`'s rule
 *  (src/lib/print-selected.ts) written out. The browser takes the host's time zone here, as node
 *  does: the harness's context sets none. */
function zipNameOn(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `invoices-${date.getFullYear()}-${month}-${day}.zip`;
}

// #592: the Invoice register's clock, the plant's (`PLANT_TIME_ZONE`, src/lib/build-version.ts),
// whatever zone this host runs in. `plantClock` in src/server/invoice-register.ts written out: each
// part read by its type from `formatToParts`, never `format()`'s own string, and no seconds.
const PLANT_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "numeric", minute: "2-digit", hour12: true,
});

/** An instant on the plant's clock: its date as MM/DD/YYYY and as YYYY-MM-DD, and `h:mm AM`. */
function plantClock(at) {
  const parts = PLANT_CLOCK.formatToParts(at);
  const part = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${part("month")}/${part("day")}/${part("year")}`,
    isoDate: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")} ${part("dayPeriod")}`,
  };
}

/** `10/19/2026, 9:02 AM` on the plant's clock, as the register's Finalized and Printed cells read. */
function plantDateTime(at) {
  const { date, time } = plantClock(at);
  return `${date}, ${time}`;
}

/** A `yyyy-mm-dd` date, as the list answers one, as MM/DD/YYYY. */
function civilDate(isoDate) {
  const [year, month, day] = isoDate.split("-");
  return `${month}/${day}/${year}`;
}

/** The register's money: `1,250.00`, and `0.00` for zero. */
function registerMoney(n) {
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** A cell's text, trimmed. */
async function textOf(locator) {
  return (await locator.textContent()).trim();
}

/** A wait armed before a click, as an outcome: it never rejects unhandled while an earlier step
 *  fails, and the step that reads it fails by `node:assert`. */
function settled(promise) {
  return promise.then((value) => ({ value }), (error) => ({ error }));
}

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;

  // --- Key an order against the two-PartPrice part (one line, ten units). ---
  const order = await createOrderViaUi(page, ctx, {
    customerCode: fixtures.invCustomerCode,
    lines: [{ partNumber: fixtures.invPartNumber, qty: 10 }],
  });
  await shot("order-created");

  // --- Ship it complete. ---
  await startNewShipment(page, ctx, fixtures.invCustomerId, [order]);
  const panel = orderPanel(page, `#${order.number}`);
  await waitForValue(panel.getByLabel("Line 1 ship-now quantity", { exact: true }), "10");
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  await waitForShipmentPage(page);
  await shot("shipment-saved");

  await assertBoardStatus(page, ctx, order.number, "· Shipped");
  await shot("board-shipped");

  // --- /invoicing: the order shows up under "Ready to invoice". Tick it and create. ---
  await page.goto(`${ctx.baseURL}/invoicing`);
  await page.getByRole("heading", { name: "Invoicing", exact: true }).waitFor({ state: "visible" });
  // PR 6: the register's filters are on its three views, the candidates on Ready to invoice.
  await openInvoicingView(page, "Register");
  for (const name of ["Customer", "Status", "Printed", "Invoice date from", "Invoice date to"]) {
    assert.equal(await page.getByLabel(name, { exact: true }).count(), 1,
      `the Invoicing list must expose exactly one ${name} filter control`);
  }
  await openInvoicingView(page, "Ready to invoice");
  const readySection = sectionByHeading(page, "Ready to invoice");
  const readyRow = readySection.locator("tr").filter({ has: page.getByText(String(order.number), { exact: true }) });
  await readyRow.waitFor({ state: "visible", timeout: 15000 });
  await readyRow.locator('input[type="checkbox"]').check();
  await shot("ready-to-invoice-ticked");

  // --- #568 (owner ruling 2026-10-19, "List only"): a create whose answer is lost, run again. ---
  //
  // The list keeps an order's request key from its first create until an answer lands, and its next
  // run sends that key again. The ruled case, end to end: the create reaches the server and commits,
  // its answer is lost (a 500 this flow gives in place of the server's), and the candidates read
  // after the run fails too, so the order's row stays ticked beside its failure. Before #568 the next
  // run was refused 400 "already has an invoice"; now it carries the same key, and the server answers
  // it with the invoice the first create made, deduped. The route answers only the first create
  // (sent on to the server first through `route.fetch()`, the discard-grid-edits shape) and the first
  // candidates read after it. Every other request to these addresses goes on its way, the run's read
  // of the invoice list included, so the invoice is listed under Invoices after the first run already:
  // only the second run's answer proves the retry. The flow still makes one draft invoice, as it did
  // before #568, and adds no fixture row.
  const createPosts = [];
  let upstream = null; // the server's own answer to the first create, or what kept it from one
  let candidatesReadsRefused = 0;
  const loseCreateAnswer = async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      createPosts.push(request.postDataJSON());
      if (createPosts.length > 1) { await route.continue(); return; }
      try {
        const response = await route.fetch();
        upstream = { status: response.status(), body: await response.json() };
      } catch (error) {
        upstream = { error: String(error) };
        await route.abort().catch(() => {});
        return;
      }
      await route.fulfill({
        status: 500, contentType: "application/json", body: JSON.stringify({ error: CREATE_ANSWER_LOST }),
      });
      return;
    }
    if (upstream !== null && candidatesReadsRefused === 0
      && new URL(request.url()).searchParams.get("candidates") === "1") {
      candidatesReadsRefused += 1;
      await route.fulfill({
        status: 500, contentType: "application/json", body: JSON.stringify({ error: CANDIDATES_READ_LOST }),
      });
      return;
    }
    await route.continue();
  };
  const stopAnswering = await routeRequests(page, `${ctx.baseURL}/api/invoices*`, loseCreateAnswer);
  const createButton = page.getByRole("button", { name: "Create invoices", exact: true });

  // The first run: the create commits, its answer and the candidates read after it are lost.
  await createButton.click();
  await readySection.getByText(`Could not load candidates: ${CANDIDATES_READ_LOST}`, { exact: true })
    .waitFor({ state: "visible", timeout: 15000 });
  assert.equal(upstream?.status, 200,
    `the first create must reach the server and be committed there: ${JSON.stringify(upstream)}`);
  assert.equal(upstream.body.deduped, false, "the first create must make the invoice, not find one");
  await readyRow.getByText(CREATE_ANSWER_LOST, { exact: true }).waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await readyRow.locator('input[type="checkbox"]').isChecked(), true,
    "an order whose create got no answer must stay ticked beside its failure");
  await shot("create-answer-lost");

  // The second run sends the same key, and the server answers with the first create's invoice.
  const retried = page.waitForResponse((res) =>
    new URL(res.url()).pathname === "/api/invoices" && res.request().method() === "POST");
  await createButton.click();
  const retry = await retried;
  const retryBody = await retry.json();
  assert.equal(retry.status(), 200, `the second run's create must succeed: ${JSON.stringify(retryBody)}`);
  assert.equal(retryBody.deduped, true, "the second run's create must be answered as the first create's own result");
  assert.equal(retryBody.invoice.id, upstream.body.invoice.id,
    "the second run's create must answer with the invoice the first create made");
  assert.equal(createPosts.length, 2, "the two runs must have sent one create each");
  const [firstPost, retryPost] = createPosts;
  assert.equal(firstPost.orderId, order.id, "the first create must name this flow's order");
  assert.match(String(firstPost.clientRequestId), V4, "the first create must carry newId()'s request key");
  assert.deepEqual(retryPost, firstPost, "the second run must send the same order and the same request key");

  // Its candidates read no longer lists the order: the row goes, its failure and tick with it.
  await readyRow.waitFor({ state: "hidden", timeout: 15000 });
  await assertNeverVisible(readySection.getByText(/^Could not load candidates:/),
    "a candidates read that landed must take the banner away", 500);
  // The button names itself again only once the run is over (it reads "Creating…" until both of
  // the run's reads have landed), and with nothing ticked it says so. No request to these addresses
  // is in flight then, so the route can go (#340). A check that fails above leaves the route
  // answering until the harness closes the page.
  await waitForTitle(createButton, "Tick at least one order first", "Create invoices once the second run is over");
  await stopAnswering();

  // --- The new DRAFT invoice appears in the "Invoices" table; open it. ---
  // PR 6: the new draft is on the register, behind the Register view (Ready shows candidates alone).
  await openInvoicingView(page, "Register");
  const invoicesSection = registerSection(page);
  const invoiceRow = invoicesSection.locator("tr")
    .filter({ has: page.getByText(String(order.number), { exact: true }) });
  await invoiceRow.waitFor({ state: "visible", timeout: 15000 });
  await shot("invoice-created");
  await invoiceRow.getByRole("link").click();

  // Post-navigation-only content — see the file's top comment. Tolerant of any invoice_number_
  // prefix (the badge is "Invoice <prefix> - <orderNumber>" or bare "Invoice <orderNumber>").
  const invoiceHeading = page.getByRole("heading", { name: new RegExp(`Invoice.*${order.number}`) });
  await invoiceHeading.waitFor({ state: "visible", timeout: 20000 });
  const invoiceId = page.url().split("/").pop();
  // PR 6: the grid sits on the Lines tab (Header opens first); a hidden panel's boxes are not found.
  // The card's Printed row reads Not printed once the documents read lands with no print (PR 6).
  await glanceValue(page, "Printed").getByText("Not printed", { exact: true })
    .waitFor({ state: "visible", timeout: 15000 });
  await openRecordTab(page, "Lines");
  const linesSection = page.locator("section")
    .filter({ has: page.getByRole("heading", { name: "Lines", exact: true }) });
  // The parent heading precedes the child recovery read. This fixture part only appears once
  // that read admits the grid; both line tables then render from the same rows in one commit.
  await linesSection.getByText(new RegExp(`^${fixtures.invPartNumber} ·`)).first()
    .waitFor({ state: "visible", timeout: 20000 });
  await shot("invoice-draft");

  // --- Two priced OPERATION rows (ruling 3's multi-operation part), a SURCHARGE row and a
  // SALES TAX row (the fixture customer's own salesTaxRate). ---
  assert.equal(await page.locator("td", { hasText: "Operation" }).count(), 2,
    "the two-PartPrice part must produce two OPERATION rows on the invoice");
  assert.equal(await page.locator("td", { hasText: "Sales tax" }).count(), 1,
    "the customer's own salesTaxRate must produce one TAX row");
  // --- The fixture's OWN surcharge produced exactly one SURCHARGE row. ---
  //
  // #167a: this used to assert `count() === 1` over EVERY surcharge row on the invoice, which is a
  // statement about the plant rather than about this flow — every active plant-wide surcharge lands
  // on every invoice, and the demonstration dataset (docs/manual/dataset.md) seeds three, so the
  // documented demo data red this flow at `4 !== 1`. What the flow actually owns is its own
  // surcharge, so that is what is counted.
  //
  // The description cell is a controlled <input> (InvoiceLinesGrid's `otherRow`), so its value
  // never reaches `getByText` and cannot be filtered on in a locator (React controlled inputs don't
  // expose `value` as an HTML attribute or as text content — HANDOFF §5a's own documented trap):
  // every SURCHARGE row's description input is read, and the matches counted here. That also closes
  // the latent half of the same bug — the old `.locator("input").first()` read whichever surcharge
  // row happened to sort first, which was only ever the fixture's own by luck.
  // Both tables render in the same commit as the admitted fixture row above. Keep these exact
  // counts and input reads unretried after that readiness boundary: a missing line still fails.
  const surchargeRows = page.locator("tr").filter({ has: page.locator("td", { hasText: "Surcharge" }) });
  const surchargeDescriptions = [];
  for (let i = 0; i < await surchargeRows.count(); i += 1) {
    surchargeDescriptions.push(await surchargeRows.nth(i).locator("input").first().inputValue());
  }
  assert.equal(
    surchargeDescriptions.filter((d) => d === fixtures.invSurchargeName).length, 1,
    `exactly one SURCHARGE row must carry this run's own surcharge name ` +
    `(${JSON.stringify(fixtures.invSurchargeName)}) — rows on this invoice: ` +
    `${JSON.stringify(surchargeDescriptions)}`,
  );
  assert.equal(await page.locator("td", { hasText: "needs price" }).count(), 0,
    "both priced operations must resolve a price — nothing should need one");

  // --- #281: a locally-ADDED charge row must be editable and removable. ---
  //
  // The only coverage of this in either gate. `useBulkGrid` owns `key` on every composed row, and
  // the invoice grid's own `LineFields` used to declare a `key` of its own that shadowed it — so an
  // added row composed under `key: ""`, which matched no `clientId`. The row could not be typed
  // into (`updateAdded("")` patches nothing) and could not be removed (`removeAdded("")` filters
  // nothing), which held the grid dirty forever and disabled Finalize below for the rest of the
  // page's life. Both halves are silent: the fill LOOKS like it worked until the value is read back.
  //
  // Deliberately writes NOTHING — the row is added, typed into, then removed, and Save is never
  // clicked. This invoice is finalized a few lines down and its lines are the frozen paper the
  // assertions above and below are about; a probe that saved a charge line onto it would be
  // changing the document it is meant to be checking.
  //
  // Row-scoped rather than label-scoped on purpose: `partOpRow` and `otherRow` both label their
  // inputs `Line <n> …`, each numbered within its OWN table, so "Line 1 description" can genuinely
  // match twice on this page and a label locator would trip strict mode.
  const chargeTable = linesSection.locator("table").last();
  const rowsBefore = await chargeTable.locator("tbody tr").count();

  await page.getByRole("button", { name: "Add charge line", exact: true }).click();
  // `.nth(rowsBefore)` rather than `.last()`: added rows append, so this names the new row
  // positionally and still resolves to nothing once it is removed — where `.last()` would slide
  // onto a surviving row and make the absence check below pass with the row still on screen.
  const addedRow = chargeTable.locator("tbody tr").nth(rowsBefore);
  const addedDescription = addedRow.getByRole("textbox").first();
  await addedDescription.fill("E2E row-identity probe");
  // The load-bearing read: under the defect the fill is a no-op and this never settles.
  await waitForValue(addedDescription, "E2E row-identity probe");

  await addedRow.getByRole("button", { name: "Remove", exact: true }).click();
  await assertNeverVisible(addedRow,
    "an added charge row must disappear when Remove is clicked (#281: removeAdded matched no clientId)");
  assert.equal(await chargeTable.locator("tbody tr").count(), rowsBefore,
    "removing the added charge row must restore the original row count");

  // The user-visible consequence, and the reason this mattered beyond the grid: an un-removable row
  // keeps the section registered unsaved, and the finalize gate refuses over a dirty editor.
  await page.getByRole("button", { name: "Finalize invoice", exact: true })
    .waitFor({ state: "visible", timeout: 10000 });
  assert.equal(
    await page.getByRole("button", { name: "Finalize invoice", exact: true }).isDisabled(), false,
    "Finalize must be enabled again once the added row is removed — a stuck row disables it",
  );

  // --- #594: a computed line removed from the draft stays out through Recalculate, until Restore.
  // This run's own surcharge row is removed and saved; Recalculate leaves it out; Restore takes it off
  // the Lines tab's Removed lines list; a second Recalculate bills it again. So the invoice the steps
  // below finalize holds the lines it was raised with, and each step reads the server's answer.
  const ownSurcharge = (body) => body.invoice.lines.filter((l) => l.kind === "SURCHARGE" && l.description === fixtures.invSurchargeName);
  const answerTo = (suffix, method) => page.waitForResponse((res) =>
    new URL(res.url()).pathname === `/api/invoices/${invoiceId}/${suffix}` && res.request().method() === method);
  const recalculateOnce = async (what) => {
    await waitForEnabled(menuItem(page, "Recalculate lines"), what);
    const answer = answerTo("recalculate", "POST");
    await chooseMenuItem(page, "Recalculate lines");
    const res = await answer;
    const body = await res.json();
    assert.equal(res.status(), 200, `Recalculate must succeed (${what}): ${JSON.stringify(body)}`);
    return body;
  };
  await surchargeRows.nth(surchargeDescriptions.indexOf(fixtures.invSurchargeName))
    .getByRole("button", { name: "Remove", exact: true }).click();
  const removedAnswer = answerTo("lines", "PUT");
  await linesSection.getByRole("button", { name: "Save lines", exact: true }).click();
  const removedSave = await removedAnswer;
  const removedBody = await removedSave.json();
  assert.equal(removedSave.status(), 200, `Save lines must save the removal: ${JSON.stringify(removedBody)}`);
  assert.deepEqual(ownSurcharge(removedBody), [], "the saved lines must not hold this run's surcharge");
  assert.deepEqual(removedBody.invoice.removedLines.map((m) => [m.kind, m.label]), [["SURCHARGE", fixtures.invSurchargeName]],
    "Save lines must remember the removed surcharge, and only it");
  const removedList = page.getByRole("region", { name: "Removed lines", exact: true });
  await removedList.getByText("Recalculate leaves these out. Restore one and the next Recalculate bills it again.", { exact: true })
    .waitFor({ state: "visible", timeout: 10000 });
  await removedList.getByText(/ when removed$/).waitFor({ state: "visible", timeout: 10000 });

  const leftOut = await recalculateOnce("after the removal is saved");
  assert.deepEqual(ownSurcharge(leftOut), [], "Recalculate must leave the removed surcharge out");

  const restoreAnswer = answerTo("restore-line", "POST");
  await removedList.getByRole("button", { name: `Restore ${fixtures.invSurchargeName}`, exact: true }).click();
  const restoreRes = await restoreAnswer;
  const restoreBody = await restoreRes.json();
  assert.equal(restoreRes.status(), 200, `Restore must succeed: ${JSON.stringify(restoreBody)}`);
  assert.deepEqual(restoreBody.invoice.removedLines, [], "Restore must take the line off the removed lines");
  assert.deepEqual(ownSurcharge(restoreBody), [], "Restore must not re-price: the line comes back at Recalculate");
  await removedList.getByText(`${fixtures.invSurchargeName} comes back at the next Recalculate.`, { exact: true })
    .waitFor({ state: "visible", timeout: 10000 });

  const billedAgain = await recalculateOnce("after Restore");
  assert.equal(ownSurcharge(billedAgain).length, 1, "the Recalculate after Restore must bill the surcharge again");

  // --- Finalize, beside a refused PO number save (#573, ordering (a)): controls lock, the order
  // becomes Invoiced. ---
  // The rollback read a refused header save sends is `load`, which snapshots the writes out as its
  // GET goes and reads once more after they settle (#573); Finalize is such a write, and the
  // Finalized badge is what the page can show only from a read that holds it.
  const poInput = page.getByLabel("PO number", { exact: true });
  // PR 6: Finalize invoice is the header's primary; Recalculate lines and Unlock invoice are More
  // actions items, read closed for their state and chosen through the menu.
  const recalcItem = menuItem(page, "Recalculate lines");
  const finalizeButton = page.getByRole("button", { name: "Finalize invoice", exact: true });
  const unlockItem = menuItem(page, "Unlock invoice");
  const finalizedBadge = page.getByText("Finalized", { exact: true });
  const draftBadge = page.getByText("Draft", { exact: true });
  const refusalLine = page.getByText(PO_SAVE_ANSWERED_HERE, { exact: true });
  const invoicePath = `/api/invoices/${invoiceId}`;
  const finalizePath = `/api/invoices/${invoiceId}/finalize`;
  // The invoice's traffic and this flow's route at its address (e2e/lib/record-reads.mjs); a held
  // read's `served` entry is the status the server answered with.
  const wireReads = () => wireRecordReads(page, ctx, {
    recordPath: invoicePath, writePath: finalizePath, refusal: PO_SAVE_ANSWERED_HERE,
    summarise: (body) => body.invoice.status,
  });
  // Click Finalize, which the hold keeps from the server, then type a PO number and leave the box:
  // its save goes out from the blur, is refused here, and the page reads the invoice back with
  // Finalize still out. Returns the PO number the box held, which the rollback must put back.
  const finalizeBeside = async (heldFinalize) => {
    await finalizeButton.click();
    await openRecordTab(page, "Header"); // the PO box is on the Header tab (PR 6)
    assert.equal((await heldFinalize.arrived()).data, null, "the held Finalize must be the button's own, which sends no body");
    const poAtStart = await poInput.inputValue();
    await poInput.fill("Not this PO (#573)");
    await poInput.press("Tab");
    return poAtStart;
  };
  const finalizeAnswered = () => page.waitForResponse((res) =>
    new URL(res.url()).pathname === finalizePath && res.request().method() === "POST");

  const firstWires = await wireReads();
  const heldFinalize = await holdRequest(page, ctx, finalizePath, { method: "POST", before: true });
  await withCleanups(async () => {
    const poAtStart = await finalizeBeside(heldFinalize);
    // #651: while its own request is out the button reads "Finalizing…" and is held, so a second
    // click cannot send a second finalize.
    const finalizing = page.getByRole("button", { name: "Finalizing…", exact: true });
    await finalizing.waitFor({ state: "visible" });
    assert.equal(await finalizing.isDisabled(), true, "Finalize must be held while its request is out");
    // The refusal is set after the rollback read lands, so this is the read applied: the box is
    // back at its stored text, and the invoice, which the server has not been asked to finalize,
    // still reads Draft.
    await waitForState(refusalLine, "visible", "a refused PO number save must be named on the page once its rollback read lands");
    await waitForValue(poInput, poAtStart);
    assert.ok(writeBeforeRead(firstWires.log),
      `Finalize must have gone out before the page's rollback read; heard ${JSON.stringify(firstWires.log)}`);
    assert.ok(heardAfter(firstWires.log, "POST", "GET answered") && !firstWires.log.includes("POST answered"),
      `the rollback read must be answered while Finalize is still held; heard ${JSON.stringify(firstWires.log)}`);
    await assertNeverVisible(finalizedBadge, "the invoice must still read Draft while Finalize is held from the server", 300);
    const answer = finalizeAnswered();
    heldFinalize.release();
    assert.equal((await answer).status(), 200, "the held Finalize must finalize the invoice");
    // That answer is older than the applied read, so the page drops it: only the read the page
    // sends after it can show Finalized. With the follow-up gone this wait runs out.
    await waitForState(finalizedBadge, "visible",
      "#573: the page must read the invoice again after the Finalize it overlapped was answered, and read Finalized", 15000);
    assert.ok(readAfter(firstWires.log, "POST answered"),
      `the page must read the invoice after Finalize's answer; heard ${JSON.stringify(firstWires.log)}`);
  }, [() => heldFinalize.close(), () => firstWires.stop()]);
  await shot("invoice-finalized");

  assert.equal(await poInput.evaluate((el) => el.readOnly), true,
    "a header field must lock once the invoice is finalized");
  assert.equal(await recalcItem.isDisabled(), true, "Recalculate must lock once finalized");
  assert.equal(await finalizeButton.isDisabled(), true, "Finalize must lock once already finalized");
  assert.equal(await finalizeButton.getAttribute("title"), "Already finalized");
  assert.equal(await unlockItem.isDisabled(), false, "Unlock must be available once finalized");

  // --- S3 (#239): the finalized lines are PAPER, not a disabled editor. ---
  //
  // The only behavioural proof of that branch in either gate — the render test in
  // `tests/operational-formatting.test.tsx` asserts the markup, but only Playwright proves the
  // page actually reaches it once a real invoice is finalized through the real Finalize button.
  // Asserted here and nowhere earlier on purpose: this is the first moment on this page where the
  // invoice is FINALIZED, and the same controls are asserted PRESENT again after Unlock below, so
  // a branch stuck on would red there rather than passing quietly.
  await openRecordTab(page, "Lines");
  await linesSection
    .getByText("Finalized — these are the figures this invoice was issued on.",
      { exact: true })
    .first().waitFor({ state: "visible", timeout: 15000 });
  // The readiness boundary, so the input-count assertion below cannot pass vacuously against a
  // grid that has simply not drawn its rows yet: this fixture part's identity line is rendered by
  // the read-only row itself, exactly as it was by the editable one at the top of this section.
  await linesSection.getByText(new RegExp(`^${fixtures.invPartNumber} ·`)).first()
    .waitFor({ state: "visible", timeout: 20000 });
  for (const [name, why] of [
    ["Add charge line", "a finalized invoice must offer no Add charge line control"],
    ["Save lines", "a finalized invoice must offer no Save lines control"],
    ["Remove", "a finalized invoice's line must offer no Remove control"],
  ]) {
    await assertNeverVisible(
      linesSection.getByRole("button", { name, exact: true }).first(), `${why} (S3, #239)`);
  }
  assert.equal(await linesSection.locator("input").count(), 0,
    "a finalized invoice's lines must render as plain cells, with no input left to look editable (S3, #239)");

  await assertBoardStatus(page, ctx, order.number, "· Invoiced", "· Shipped");
  await shot("board-invoiced");

  // --- #472 (owner ruling R-Q5, 2026-10-08): the order hub under the finalized invoice. ---
  //
  // Lines and Charges are greyed out before anything is typed, each with the sentence its own
  // save would be refused with, and a field the server still accepts stays open. The hub learns
  // of the invoice from `finalizedInvoiceId` on its read of the order, so only a real server and
  // a real page prove that the field reaches these attributes.
  //
  // Each title asserted here sits BELOW the permission rung of its gate. Until the permissions
  // land the edit gate is closed with "Requires orders.edit", and the invoice rung leaves a closed
  // gate alone. So the titles are polled, never read once. The PO number is read after them on
  // purpose: an invoice sentence on screen means the edit gate has opened, so `readOnly` has
  // settled too.
  await page.goto(`${ctx.baseURL}/orders/${order.id}`);
  await page.getByRole("heading", { name: /^Order #\d+/ }).waitFor({ state: "visible", timeout: 20000 });
  const frozen = (clause) =>
    `${clause} — Invoice ${order.number} is finalized; unlock it or raise a credit (see /invoicing/${invoiceId})`;
  // Lines and Charges sit on the hub's Parts & containers tab and the PO number on Overview (PR 2):
  // `hubSection` opens each tab before the section is read.
  const hubLeadQty = (await hubSection(page, "Lines")).getByLabel("Lead quantity", { exact: true });
  await waitForTitle(hubLeadQty, frozen("A line cannot be changed"),
    "the hub's Lead quantity under a finalized invoice");
  assert.equal(await hubLeadQty.isDisabled(), true,
    "a line's quantity must be greyed out on the hub once the invoice is finalized");
  const hubAddCharge = (await hubSection(page, "Charges")).getByRole("button", { name: "Add charge", exact: true });
  await waitForTitle(hubAddCharge, frozen("Charges cannot be changed"),
    "the hub's Add charge under a finalized invoice");
  assert.equal(await hubAddCharge.isDisabled(), true,
    "Charges must be greyed out on the hub once the invoice is finalized");
  const hubPo = (await hubSection(page, "Overview")).getByLabel("PO number", { exact: true });
  assert.equal(await hubPo.evaluate((el) => el.readOnly), false,
    "the PO number must stay editable on the hub: the server accepts it under a finalized invoice");
  assert.equal(await hubPo.getAttribute("title"), null, "an editable PO number carries no refusal title");
  await shot("hub-frozen-under-invoice");

  // #486 (owner ruling 2026-10-15): under the finalized invoice the server refuses a line removal
  // with the same sentence the hub's Lines section is titled with, before it reads the line. So the
  // lead's removal, sent through the harness's counted call because the hub offers no Remove on a
  // lead, is answered with the invoice and not with the lead rule's "void the order instead". The
  // refused removal leaves the order its line.
  const orderLines = async () => (await readJson(page, ctx, `/api/orders/${order.id}`)).lines;
  const leadLineId = (await orderLines()).find((line) => line.position === 1)?.id;
  assert.ok(leadLineId, "the invoiced order must have its lead line");
  const refusedRemoval = await ctx.apiMutate(page,
    `${ctx.baseURL}/api/orders/${order.id}/lines/${leadLineId}`, { method: "DELETE" });
  assert.equal(refusedRemoval.status(), 400, "a line removal under a finalized invoice must be refused");
  assert.equal((await refusedRemoval.json()).error, frozen("A line cannot be changed"),
    "a line removal under a finalized invoice must be refused in the hub's own words, ahead of the lead rule");
  assert.deepEqual((await orderLines()).map((line) => line.id), [leadLineId],
    "a refused removal must leave the order its line");

  // --- #591: Print selected on the Invoicing list, the invoice finalized and never printed. ---
  //
  // This invoice's row in the Invoices table, found by its Document No link, the row's only link
  // (the other flows that open an invoice from this table click it). #591 put the row's box in its
  // first cell and Printed in its last, which the header is read for below.
  const listedInvoice = async () => {
    await page.goto(`${ctx.baseURL}/invoicing`);
    await page.getByRole("heading", { name: "Invoicing", exact: true }).waitFor({ state: "visible" });
    await openInvoicingView(page, "Register");
    const row = invoicesSection.locator("tbody tr")
      .filter({ has: page.locator(`a[href="/invoicing/${invoiceId}"]`) });
    await waitForState(row, "visible", `the Invoices table must list invoice ${invoiceId}`, 15000);
    return { row, box: row.locator('input[type="checkbox"]'), printed: row.locator("td").last() };
  };
  const unprinted = await listedInvoice();
  assert.equal(await textOf(invoicesSection.locator("thead th").last()), "Printed",
    "#591: the Invoices table's last column must be Printed");
  assert.equal(await unprinted.box.count(), 1,
    "#591: a finalized invoice that has not printed must take a Print selected box");
  assert.equal(await textOf(unprinted.printed), "", "#591: a finalized invoice that has not printed reads blank under Printed");
  await unprinted.box.check();

  // The confirm, the selected print's answer and the zip are each armed before the click.
  const printSelectedButton = invoicesSection.getByRole("button", { name: "Print selected", exact: true });
  const selectedAnswer = settled(page.waitForResponse((res) => {
    const url = new URL(res.url());
    return url.pathname === `/api/invoices/${invoiceId}/print` && url.searchParams.get("selected") === "1"
      && res.request().method() === "POST";
  }, { timeout: 30000 }));
  const downloaded = settled(page.waitForEvent("download", { timeout: 30000 }));
  const ranFrom = new Date();
  await printSelectedButton.click();
  // Ruling 5 (PR 6): the modal, its title the ruled sentence's question.
  assert.equal(await modalTitle(page), PRINT_ONE_TITLE, "#591: the confirm must name the one ticked row in the owner's words");
  await answerModal(page);
  const answer = await selectedAnswer;
  assert.ok(answer.value, `#591: Print selected must send the row's selected print (?selected=1): ${answer.error?.message}`);
  assert.equal(answer.value.status(), 200,
    `#591: the selected print of a finalized invoice that has not printed must print it: ${answer.value.ok() ? "" : await answer.value.text()}`);
  const selectedDocumentId = answer.value.headers()["x-document-id"];
  assert.ok(selectedDocumentId, "#591: the selected print must name the document it stored");
  const download = await downloaded;
  assert.ok(download.value, `#591: Print selected must download a zip: ${download.error?.message}`);
  // The browser's local date when the run ended, which falls between these two.
  const zipNames = [zipNameOn(ranFrom), zipNameOn(new Date())];
  assert.ok(zipNames.includes(download.value.suggestedFilename()),
    `#591: the zip must be named for the day it was made, ${JSON.stringify(zipNames)}; it is ${JSON.stringify(download.value.suggestedFilename())}`);
  const zipPath = await settled(bounded(download.value.path(), "#591: the zip must finish downloading"));
  assert.ok(zipPath.value, `#591: the zip must finish downloading: ${zipPath.error?.message}`);
  const zipped = unzipSync(new Uint8Array(await readFile(zipPath.value)));
  const entryName = `Invoice-${order.number}.pdf`;
  assert.deepEqual(Object.keys(zipped), [entryName], "#591: the zip must hold the one print, under the invoice's file name");
  assert.equal(Buffer.from(zipped[entryName].subarray(0, 4)).toString("latin1"), "%PDF", "#591: the zip's entry must be a PDF");
  const storedBytes = await storedPdf(page, ctx.baseURL, selectedDocumentId, "#591: the selected print");
  assert.ok(Buffer.from(zipped[entryName]).equals(storedBytes), "#591: the zip's entry must be the bytes the print stored");

  // The closing line is set after the run's reload of the list has been awaited; when that reload
  // applied (no load error on screen), the row read below is the reloaded one.
  await waitForState(invoicesSection.getByText(PRINTED_ONE_OF_ONE, { exact: true }), "visible",
    "#591: the run must say how many of its rows printed", 15000);
  await assertNeverVisible(invoicesSection.getByText(/^Could not load invoices:/),
    "#591: the run's reload of the list must have applied", 300);
  const printedShown = await textOf(unprinted.printed);
  assert.notEqual(printedShown, "", "#591: a row that printed must read its print under Printed");
  await assertNeverVisible(unprinted.box, "#591: a row that has printed since it was finalized must take no box");
  // The owner's ruling of 2026-10-21: a row that printed but was not filed in its customer folder
  // says why beside it, as a refusal does, in the single Print's sentence. The #588 part below sets
  // this customer's folder, so here it is still blank, and the run's server has the harness's share:
  // the answer says no folder is set (`fileCustomerCopy`, src/server/customer-folders.ts).
  assert.deepEqual(JSON.parse(decodeURIComponent(answer.value.headers()["x-print-warnings"] ?? "null")), [PRINT_NO_FOLDER],
    "#591: the selected print of a customer with no invoice folder must say it was not filed");
  const documentNoCell = unprinted.row.locator("td").filter({ has: page.locator(`a[href="/invoicing/${invoiceId}"]`) });
  await waitForState(documentNoCell.getByText(PRINT_NO_FOLDER, { exact: true }), "visible",
    "#591: a row that printed but was not filed must say why under its Document No", 15000);
  await waitForTitle(printSelectedButton, "Tick at least one invoice first",
    "#591: Print selected once the row it printed has no box");
  await shot("invoicing-print-selected");

  // --- #592: Export to PDF, the Invoice register of the list on screen. ---
  //
  // Both exports follow the list the page last put on screen, never the filters as typed (plan
  // Amendment 3, ExportLink in src/lib/report-ui.tsx). So the list's read of this flow's customer is
  // held after the server has answered it: until the page has that answer, both links still point
  // at the unfiltered list, and once it lands they carry the filter. A link on the filters as typed
  // would carry it the moment the option is chosen, which a wait for the filtered link alone could
  // not tell apart. The held answer is the one the page then receives, so the register's expected
  // row is read from it.
  const customerFilter = page.getByLabel("Customer", { exact: true });
  const pdfLink = invoicesSection.getByRole("link", { name: "Export to PDF", exact: true });
  const excelLink = invoicesSection.getByRole("link", { name: "Export to Excel", exact: true });
  const filteredPdfLink = invoicesSection.locator('a[href*="customerId="]', { hasText: "Export to PDF" });
  const filteredQuery = new URLSearchParams({ customerId: fixtures.invCustomerId }).toString();
  // The list reads through its window (#612 PR D): the page asks `?…&window=1` and is answered an
  // envelope `{ rows, cut }`; the exports' query never carries the window.
  const heldList = await holdRequest(page, ctx, `/api/invoices?${filteredQuery}&window=1`, {
    method: "GET",
    match: (request) => new URL(request.url()).searchParams.get("customerId") === fixtures.invCustomerId,
  });
  const registerRows = await withCleanups(async () => {
    await customerFilter.selectOption({ value: fixtures.invCustomerId }, { timeout: 15000 });
    const served = await heldList.arrived();
    assert.equal(served.response.status(), 200, "#592: the server must answer the list's read of the flow's customer");
    const { rows, cut } = await served.response.json();
    assert.equal(cut, false, "#612: the flow's customer's list must not be cut by the window");
    assert.equal(await pdfLink.getAttribute("href", { timeout: 5000 }), "/api/invoices/register",
      "#592: while the filtered list is held, Export to PDF must still export the unfiltered list on screen");
    assert.equal(await excelLink.getAttribute("href", { timeout: 5000 }), "/api/invoices/export",
      "#592: while the filtered list is held, Export to Excel must still export the unfiltered list on screen");
    await assertNeverVisible(filteredPdfLink,
      "#592: Export to PDF must not carry the filter before the filtered list has landed", 300);
    heldList.release();
    await waitForState(filteredPdfLink, "visible",
      "#592: Export to PDF must carry the filter once the filtered list has landed", 15000);
    assert.equal(await filteredPdfLink.getAttribute("href"), `/api/invoices/register?${filteredQuery}`,
      "#592: Export to PDF must export exactly the filtered list on screen");
    assert.equal(await excelLink.getAttribute("href", { timeout: 5000 }), `/api/invoices/export?${filteredQuery}`,
      "#592: Export to Excel must export exactly the filtered list on screen");
    return rows;
  }, [() => heldList.close()]);
  // No flow before this one invoices this customer, so its register is this invoice alone.
  assert.deepEqual(registerRows.map((r) => r.id), [invoiceId],
    `#592: the flow's customer must list this invoice alone: ${JSON.stringify(registerRows.map((r) => r.documentNumber))}`);
  const [registered] = registerRows;
  assert.equal(registered.kind, "INVOICE", "#592: the listed document must be an invoice");
  assert.equal(registered.status, "FINALIZED", "#592: the listed invoice must still be finalized");
  assert.equal(registered.customerCode, fixtures.invCustomerCode, "#592: the listed invoice must be the flow's customer's");
  assert.ok(registered.finalizedAt && registered.printedAt,
    `#592: the listed invoice must carry its finalize and its selected print: ${JSON.stringify(registered)}`);
  // The filter line names the customer as its picker option does: code · name, both read live.
  const customerOption = await textOf(customerFilter.locator(`option[value="${fixtures.invCustomerId}"]`));
  assert.ok(customerOption.startsWith(`${fixtures.invCustomerCode} · `),
    `#592: the customer's option must read code · name; it reads ${JSON.stringify(customerOption)}`);

  // The download, armed before the click. The Made line and the file's plant date are read off one
  // moment on the server, between the click and the download's start, a span this wait bounds to
  // 30 seconds, so that moment's minute and date are those at one side or the other.
  const registerDownload = settled(page.waitForEvent("download", { timeout: 30000 }));
  const exportedFrom = new Date();
  await filteredPdfLink.click();
  const exported = await registerDownload;
  const exportedBy = new Date();
  assert.ok(exported.value, `#592: Export to PDF must download the Invoice register: ${exported.error?.message}`);
  const registerNames = [exportedFrom, exportedBy].map((at) => `invoice-register-${plantClock(at).isoDate}.pdf`);
  assert.ok(registerNames.includes(exported.value.suggestedFilename()),
    `#592: the register must be named for the plant's date it was made, ${JSON.stringify(registerNames)}; it is ${JSON.stringify(exported.value.suggestedFilename())}`);
  const registerPath = await settled(bounded(exported.value.path(), "#592: the register must finish downloading"));
  assert.ok(registerPath.value, `#592: the register must finish downloading: ${registerPath.error?.message}`);
  const [registerLines] = printedPages(await readFile(registerPath.value), { pages: 1, what: "#592: the Invoice register" });
  const madeLines = [exportedFrom, exportedBy].map((at) => {
    const { date, time } = plantClock(at);
    return `Made ${date}, ${time}`;
  });
  const madeLine = madeLines.find((line) => registerLines.includes(line));
  assert.ok(madeLine,
    `#592: the register must say when it was made, on the plant's clock, ${JSON.stringify(madeLines)}; it drew ${JSON.stringify(registerLines)}`);
  assertRun(registerLines, [
    "Invoice register",
    `Customer: ${customerOption}   Status: All statuses   Invoice date: Any date`,
    madeLine,
    ...REGISTER_HEADERS,
  ], "#592: the register's title, filter line, Made line and headers");
  const registerTotal = registerMoney(registered.total);
  assertRun(registerLines, [
    registered.documentNumber, "Invoice", String(registered.orderNumber), registered.customerCode, registered.customerName,
    civilDate(registered.invoiceDate), "Finalized", registerTotal,
    plantDateTime(new Date(registered.finalizedAt)), plantDateTime(new Date(registered.printedAt)),
    ONE_DOCUMENT, registerTotal,
  ], "#592: the invoice's row, then the summary of one document and its total");
  assert.equal(registerLines.at(-1), "Page 1 of 1", "#592: the register's one page must say so at its foot");
  await shot("invoicing-export-pdf");

  // --- #588: the customer's Invoice folder, on the share the harness owns (ctx.officeShare). ---
  //
  // The folder is made on disk, named after the customer's name as the server holds it (read, not
  // typed here), and saved on the customer page as the office pastes it from Explorer, built from
  // the share's root (e2e/run.mjs hands the server that same root). The box is first sent a path
  // outside the share, which is refused. A cleanup armed before the box is first written (#321)
  // puts the folder back to blank (a blank runs no check) and reads it back: the later flows that
  // ship for this customer must file nothing.
  const share = ctx.officeShare;
  const customerPath = `/api/customers/${fixtures.invCustomerId}`;
  const customer = await readJson(page, ctx, customerPath);
  assert.equal(customer.invoiceFolder, "", "the fixture customer must start with no invoice folder");
  const folder = path.join(share.dir, "Customers", customer.name);
  await mkdir(folder, { recursive: true });
  const pastedFolder = `${share.root.replace(/\\$/, "")}\\Customers\\${customer.name}`;
  const fileName = `Invoice-${order.number}.pdf`;
  const filedPath = path.join(folder, fileName);
  const putFolderBack = async () => {
    const answer = await ctx.apiMutate(page, `${ctx.baseURL}${customerPath}`,
      { method: "PUT", data: { invoiceFolder: "" }, idempotent: true });
    assert.equal(answer.status(), 200, `putting the invoice folder back to blank: ${await answer.text()}`);
    assert.equal((await readJson(page, ctx, customerPath)).invoiceFolder, "",
      "the fixture customer's invoice folder must be blank again for the flows after this one");
  };

  // --- Print: the print→archive seam Task 19 built — the document must appear in the invoice
  // page's own Documents list — and, for a finalized invoice, the copy filed in the customer's
  // folder (#588). ---
  const documentsSection = sectionByHeading(page, "Documents");
  const invoiceDocuments = documentsSection.getByRole("link", { name: "Invoice", exact: true });
  const documentTime = (documentId) => documentsSection.locator("tr")
    .filter({ has: page.locator(`a[href="/api/documents/${documentId}"]`) }).locator("td").last();
  let newestPrintShown = "";
  // The one line by Print (InvoiceDetail's printWarning paragraph; the page's other amber block is a
  // list).
  const printLine = glanceCard(page).locator("p.bg-accent-50"); // the card holds the print's messages (PR 6)
  // Print opens its tab at the click and fills it with the stored copy before it refreshes
  // Documents, so the tab is closed only once the print's own Documents link shows, and only when
  // Playwright reported the tab at all: the event is intermittent (#345), and a tab reported late,
  // already closed, is skipped. The page sets the blocked-window line before it refreshes Documents,
  // so once the link shows, that line is on screen if it is ever going to be: with the answer naming
  // its document, its absence says the browser did not block the tab the click opened. Answers the
  // print's answer and the document it archived.
  const printFromPage = async () => {
    const popup = page.context()
      .waitForEvent("page", { predicate: (tab) => !tab.isClosed(), timeout: 5000 }).catch(() => null);
    const printed = page.waitForResponse((res) =>
      res.url().endsWith(`/api/invoices/${invoiceId}/print`) && res.request().method() === "POST" && res.ok());
    await page.getByRole("button", { name: "Print invoice", exact: true }).click();
    const answer = await printed;
    const documentId = answer.headers()["x-document-id"];
    assert.ok(documentId, "a print's answer must name the document it archived (x-document-id)");
    await documentsSection.locator(`a[href="/api/documents/${documentId}"]`)
      .waitFor({ state: "visible", timeout: 15000 });
    await assertNeverVisible(page.getByText(PRINT_WINDOW_BLOCKED, { exact: true }),
      "a print's tab, opened in the click, must not be reported blocked", 300);
    await (await popup)?.close().catch(() => {});
    return { answer, documentId };
  };

  await withCleanups(async () => {
    await page.goto(`${ctx.baseURL}/customers/${fixtures.invCustomerId}`);
    await openRecordTab(page, "Terms & billing"); // the Invoice folder box is in Commercial settings (PR 8)
    // The box's label also holds its help line and its notice, so it is matched from its start.
    // Exact: the box names itself (R7), and its Saved mark's own name, "Invoice folder saved", would
    // match a pattern that only anchors the start.
    const folderBox = page.getByLabel(INVOICE_FOLDER_LABEL, { exact: true });
    const folderRow = page.locator("label").filter({ has: folderBox });
    const folderFound = folderRow.getByText(FOLDER_FOUND, { exact: true });
    // The page's own red banner, a direct child of the page's root `div.min-w-0` (PR 8: the root
    // carries `p-3 sm:p-6`, so it is no longer matched by `div.p-6`): the Receivables section draws
    // a red paragraph of the same classes inside its own <section> (ReceivablesSection.tsx), which
    // this selector does not reach.
    const banner = page.locator("div.min-w-0 > p.mb-3.bg-red-50");
    await waitForState(folderRow.getByText(INVOICE_FOLDER_HELP, { exact: true }), "visible",
      "the Invoice folder box must carry its help line", 15000);
    await waitForValue(folderBox, "");

    // Outside the share: refused with the share's root as the server shows it (ctx's root is in
    // that form), nothing saved, and the box back at the stored blank.
    await folderBox.fill("C:\\Elsewhere");
    await folderBox.press("Tab");
    await waitForRedLines(banner, [notInsideShare(share.root)]);
    await waitForValue(folderBox, "");
    await assertNeverVisible(folderFound, "a refused folder must not be called found", 300);
    assert.equal((await readJson(page, ctx, customerPath)).invoiceFolder, "", "a refused folder must not be saved");
    await shot("invoice-folder-refused");

    // The customer's own folder: found, saved as pasted, and the refusal before it cleared.
    await folderBox.fill(pastedFolder);
    await folderBox.press("Tab");
    await waitForState(folderFound, "visible", "a folder that exists inside the share must be called found", 15000);
    await waitForState(banner, "hidden", "a found folder's save must clear the refusal before it");
    await waitForValue(folderBox, pastedFolder);
    assert.equal((await readJson(page, ctx, customerPath)).invoiceFolder, pastedFolder,
      "the found folder must be stored as it was pasted");
    await shot("invoice-folder-found");

    // PR 8: Delete customer is the title row's danger action and asks through the modal. This
    // customer holds the flow's own order, so the server refuses the delete and the page shows the
    // blocker panel in its place; dismissed, the page stands and nothing was deleted.
    const deletes = watchRequests(page, "DELETE", customerPath, { exact: true });
    await page.getByRole("button", { name: "Delete customer", exact: true }).click();
    assert.match(await modalTitle(page), /^Delete customer "/, "Delete asks the ruled question as the modal's title");
    await answerModal(page, { reason: "E2E: a delete the order refuses" });
    const blockerPanel = page.getByText(/^Cannot delete customer /);
    await waitForState(blockerPanel, "visible", "the refused delete must show the blocker panel", 15000);
    assert.equal(deletes.count(), 1, "the delete must have been sent once and refused by the server");
    deletes.stop();
    assert.equal((await readJson(page, ctx, customerPath)).code, fixtures.invCustomerCode,
      "the refused delete must leave the customer in place");
    await page.getByRole("button", { name: "dismiss", exact: true }).click();
    await waitForState(blockerPanel, "hidden", "dismiss must close the blocker panel");
    // The path alone: the open tab rides in the query (`?tab=terms`).
    assert.equal(new URL(page.url()).pathname, `/customers/${fixtures.invCustomerId}`, "a refused delete stays on the customer page");
    await shot("customer-delete-refused");

    // The first print files the copy: the route files it before it answers.
    await page.goto(`${ctx.baseURL}/invoicing/${invoiceId}`);
    await invoiceHeading.waitFor({ state: "visible", timeout: 15000 });
    await openRecordTab(page, "Documents & history"); // the list is on its own tab (PR 6)
    // #591: before this Print the invoice's Documents hold the selected print alone, and its time is
    // the one the list's Printed cell read.
    await waitForState(invoiceDocuments.first(), "visible",
      "#591: the selected print must be filed under the invoice's own Documents", 15000);
    assert.equal(await invoiceDocuments.count(), 1,
      "#591: before the single Print the invoice's Documents must hold the selected print alone");
    assert.equal(await invoiceDocuments.first().getAttribute("href"), `/api/documents/${selectedDocumentId}`,
      "#591: the one document before the single Print must be the selected print's");
    assert.equal(await textOf(documentTime(selectedDocumentId)), printedShown,
      "#591: the list's Printed cell must read the selected print's own time");
    const first = await printFromPage();
    assert.equal(first.answer.headers()["x-print-warnings"], undefined, "a filed print must carry no folder warning");
    assert.equal(await invoiceDocuments.count(), 2,
      "#591: after the single Print the invoice's Documents must hold exactly the two prints");
    // The newest print, which the list reads for the invoice once it is a draft again (below).
    newestPrintShown = await textOf(documentTime(first.documentId));
    assert.notEqual(newestPrintShown, printedShown,
      "#591: the two prints must read apart, or the draft check below cannot tell the newest");
    const stored = await page.request.get(`${ctx.baseURL}/api/documents/${first.documentId}`, { maxRetries: 1 });
    assert.equal(stored.status(), 200, `the printed invoice ${first.documentId} must be served from Documents`);
    assert.equal(stored.headers()["content-disposition"], `inline; filename="${fileName}"`,
      "the stored invoice must download under the name its filed copy carries");
    const storedBytes = await stored.body();
    assert.deepEqual(await readdir(folder), [fileName],
      "the customer's folder must hold the filed copy alone, with no temp file left beside it");
    const filed = await readFile(filedPath);
    assert.ok(filed.equals(storedBytes),
      `the filed copy must be the stored document's bytes (${filed.length} bytes filed, ${storedBytes.length} stored)`);
    for (const line of PRINT_FOLDER_LINES) {
      await assertNeverVisible(page.getByText(line, { exact: true }), `a filed print must show no folder line: "${line}"`, 300);
    }
    await shot("invoice-printed-archived");

    // The share disconnected: its marker is renamed away, and renamed back however what follows
    // ends. The second print is archived, says by Print that it was not filed, and leaves the first
    // print's copy as it was.
    const marker = path.join(share.dir, CUSTOMER_FOLDERS_MARKER);
    const markerAway = `${marker}.away`;
    await rename(marker, markerAway);
    await withCleanups(async () => {
      const second = await printFromPage();
      assert.deepEqual(JSON.parse(decodeURIComponent(second.answer.headers()["x-print-warnings"] ?? "null")),
        [PRINT_NOT_CONNECTED], "a print the share could not take must say why in its answer");
      await waitForState(printLine, "visible", "a print that was not filed must say so by Print");
      assert.equal(await printLine.innerText(), PRINT_NOT_CONNECTED,
        "the line by Print must be the not-connected sentence alone");
      assert.equal(await invoiceDocuments.count(), 3,
        "the selected print and both single prints must be listed under Documents");
      // The newest print is now this one; the draft below reads it.
      newestPrintShown = await textOf(documentTime(second.documentId));
      assert.deepEqual(await readdir(folder), [fileName], "a print that was not filed must add nothing to the folder");
      assert.ok((await readFile(filedPath)).equals(filed), "a print that was not filed must leave the earlier copy as it was");
      await shot("invoice-print-not-filed");
    }, [() => rename(markerAway, marker)]);
  }, [putFolderBack]);

  // --- Unlock with a reason: controls unlock, the invoice returns to Draft, the order returns
  // to Shipped (its ship-derived status — NOT Open; spec §5.2, the reversing-shipment precedent
  // Task 15 set for invoice-owned states). ---
  // Ruling 5 (PR 6): Unlock invoice is a More actions item asking through the modal.
  await chooseMenuItem(page, "Unlock invoice");
  assert.match(await modalTitle(page), /^Unlock Invoice/);
  await answerModal(page, { reason: UNLOCK_REASON });
  await page.getByText("Draft", { exact: true }).waitFor({ state: "visible", timeout: 15000 });
  await shot("invoice-unlocked");

  await openRecordTab(page, "Header");
  assert.equal(await poInput.evaluate((el) => el.readOnly), false, "a header field must unlock after Unlock");
  assert.equal(await recalcItem.isDisabled(), false, "Recalculate must unlock after Unlock");
  assert.equal(await finalizeButton.isDisabled(), false, "Finalize must be available again after Unlock");
  assert.equal(await unlockItem.isDisabled(), true, "Unlock must lock again once there is nothing to unlock");
  await openRecordTab(page, "Lines");
  // S3's other direction: back at Draft the editor returns. Without this the read-only branch
  // could be stuck ON and the absence assertions above would still pass.
  await linesSection.getByRole("button", { name: "Add charge line", exact: true })
    .waitFor({ state: "visible", timeout: 15000 });
  await linesSection.locator("input").first().waitFor({ state: "visible", timeout: 20000 });

  // --- #573, ordering (b): Finalize once more, its answer landing before the rollback read's. ---
  // The invoice is a draft again and its header is open, so a refused PO number save can sit
  // beside this Finalize as it did beside the first. The server serves the rollback read as a
  // draft at once (Finalize has not reached it), and the route keeps that answer from the page.
  const laterWires = await wireReads();
  laterWires.holdReads(true);
  const laterFinalize = await holdRequest(page, ctx, finalizePath, { method: "POST", before: true });
  await withCleanups(async () => {
    const poAtStart = await finalizeBeside(laterFinalize);
    await bounded(laterWires.heard((log) => heardAfter(log, "POST", "GET served")),
      "the server must serve the page's rollback read while Finalize is held");
    assert.ok(writeBeforeRead(laterWires.log),
      `Finalize must have gone out before the page's rollback read; heard ${JSON.stringify(laterWires.log)}`);
    assert.ok(laterWires.served.every((status) => status === "DRAFT"),
      `the server must have served the rollback read before it saw Finalize; it answered ${JSON.stringify(laterWires.served)}`);
    // Finalize's answer lands first. Nothing newer has been applied, so the page takes it.
    const answer = finalizeAnswered();
    laterFinalize.release();
    assert.equal((await answer).status(), 200, "the held Finalize must finalize the invoice again");
    await waitForState(finalizedBadge, "visible", "the page must read Finalized from Finalize's own answer");
    assert.ok(!heardAfter(laterWires.log, "POST", "GET answered"),
      `no read of the invoice sent beside Finalize may be answered before Finalize's answer; heard ${JSON.stringify(laterWires.log)}`);
    // Then the held answer, newer than the write and a draft: the badge reads Draft again, with
    // the refusal it was sent for named. Every read held so far goes with it. The hold stays on,
    // so the read the page sends after the stale answer (#573's follow-up) is held too, and Draft
    // stays until that read is let go: the beat is waited for, not inferred.
    const releaseMark = laterWires.log.length;
    await laterWires.releaseReads();
    await waitForState(draftBadge, "visible",
      "a read served as a draft, landing after Finalize's answer, must show the invoice as a draft again");
    await waitForState(refusalLine, "visible", "the refused PO number save must be named once its rollback read lands");
    // A wait, not a check (see discard-grid-edits): the lines grid, back as a draft, sends a read of
    // its own here, which this wait cannot tell from the page's; the wait after the release can.
    await laterWires.heardWithin((log) => readAfterAnswerFrom(log, releaseMark, { held: true }), 10000);
    laterWires.holdReads(false);
    await laterWires.releaseReads();
    await waitForState(finalizedBadge, "visible", "#573: the read sent after the stale one must read Finalized again");
    assert.ok(readAfterAnswerFrom(laterWires.log, releaseMark),
      `the page must read the invoice after the stale answer landed; heard ${JSON.stringify(laterWires.log)}`);
    await waitForValue(poInput, poAtStart);
    assert.equal(await poInput.evaluate((el) => el.readOnly), true, "the header locks again with the read that holds the finalize");
    assert.equal(await refusalLine.isVisible(), true, "the refusal stays on the page: the read after the stale one clears nothing");
  }, [() => laterFinalize.close(), () => laterWires.stop()]);
  await shot("stale-read-read-again");

  // #591 (owner ruling 591-1): the second Finalize moved `finalizedAt` past both prints, so the
  // list reads the invoice as not printed since and gives it its box again. Then back to the
  // invoice, still finalized, for the second Unlock.
  const refinalized = await listedInvoice();
  assert.equal(await textOf(refinalized.printed), "",
    "#591: an invoice finalized again after its prints reads blank under Printed");
  assert.equal(await refinalized.box.count(), 1,
    "#591: an invoice finalized again after its prints must take a Print selected box again");
  await page.goto(`${ctx.baseURL}/invoicing/${invoiceId}`);
  await invoiceHeading.waitFor({ state: "visible", timeout: 15000 });

  // Back to Draft, where the flow left the invoice before that part: the order's board status
  // below is read after this second unlock.
  await chooseMenuItem(page, "Unlock invoice");
  assert.match(await modalTitle(page), /^Unlock Invoice/);
  await answerModal(page, { reason: SECOND_UNLOCK_REASON });
  await waitForState(draftBadge, "visible", "the second Unlock must return the invoice to Draft", 15000);
  assert.equal(await poInput.evaluate((el) => el.readOnly), false, "a header field must unlock after the second Unlock");

  // #591 (owner ruling 591-1): a draft reads its newest print, the single Print's, and takes no box.
  const unlocked = await listedInvoice();
  assert.equal(await textOf(unlocked.printed), newestPrintShown, "#591: a draft must read its newest print under Printed");
  await assertNeverVisible(unlocked.box, "#591: a draft must take no Print selected box");

  await assertBoardStatus(page, ctx, order.number, "· Shipped", "· Invoiced");
  await shot("board-shipped-again");
}
