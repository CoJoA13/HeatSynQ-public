// Correcting a saved order line (the quantity corrections design §4), in a real browser. An order
// line's Qty and Weight save as you leave the box or press Enter, and this flow proves what the
// screen says about each save and what it offers afterwards:
//
//   A. A quantity saved with Enter is one save: focus stays in the box, the box reads Saved, and
//      Tab afterwards sends nothing more. The line is then offered quantity × the part's each
//      weight, as a sum, with one control to accept it. Accepted with focus in the Weight box and
//      refused, the figure stays in that box marked Not saved, and leaving the box does not send
//      it again. Accepting is one save of that figure, even with other text typed into the Weight
//      box. The mark and the offer last for the visit only.
//   B. A value the browser refuses is never sent. It stays in its box marked Not saved, with the
//      reason under the line and in the Lines section's message; the traveler print waits; leaving the page
//      asks first, and so does Re-split in the Loads section; Restore puts the stored value back
//      with no save. A Not saved value on a line that is then removed stops counting.
//   C. On a new shipment, a ship-now quantity typed key by key is offered its weight without the
//      row losing focus, and accepting fills the weight box and saves nothing. Back on the order,
//      a quantity below what has shipped is refused by the server, in the server's words, at the
//      box; Tab then sends nothing more, Enter retries, and Restore puts the stored quantity back
//      with no save; a quantity equal to what has shipped is saved, the order reads Shipped, the
//      Shipments section's row for that shipment turns from Partial to Complete with no reload
//      (#473), and the offered weight is shown but cannot be used, because more than that has
//      shipped. Typed by hand, that weight is refused by the server and reads Not saved, and
//      Create invoice in the Invoices section asks first.
//   D. On the saved shipment a changed ship-now quantity is offered its weight; Discard takes the
//      offer away with the typed quantity; accepting fills the weight box and saves nothing. Save
//      lines saves what the boxes hold, and the row, at its newly saved quantity, is offered
//      nothing over a weight that is not that quantity × each weight.
//   E. Back on the order, a quantity save whose answer never reaches the page although the server
//      has committed it. The box reads Not saved while the server holds the typed quantity, and
//      the traveler print waits. Restore then SAVES the stored quantity, as one save: the box
//      reads that quantity, Saved, the server holds it again, and the print is free. After a
//      refusal Restore sends nothing: part B checks that for a value the browser refuses and
//      part C for one the server refuses, and it is not repeated here.
//   F. Then a rider's removal whose answer never reaches the page although the server has
//      committed it (#475). The line stays on the page marked Removal not confirmed, with the
//      reason under the line; its Remove and its boxes stay usable, the traveler print waits and
//      Re-split asks first. Remove pressed again is answered that the order does not hold the
//      line. The page then reads the order: the line goes, the Lines message says it had already been
//      removed, and the print is free. That the section asks for that read once is pinned in
//      tests/lines-section-wiring.test.ts, not here; the page reads once more only when a hub
//      write was out as its read was sent (#550; part H checks that rule for Refresh order before
//      printing).
//   G. Then a quantity save whose answer the page cannot read although the server has committed
//      it (#547). The page stays up. The box reads Not saved, with the owner's sentence for a write
//      under the line and on the Lines message, while the server holds the typed quantity; the History
//      panel and the Shipments section read again, as after a save that lands; and the traveler
//      print waits. Enter then saves the same quantity once more: the box reads Saved and the
//      print is free.
//   H. Then Refresh order before printing, pressed while a quantity save is out (#550). The click
//      takes focus from the box, so the save goes out before the click's reads of the order, and
//      the server is kept from seeing it until they have been answered. The page applies its read,
//      which does not hold the save, and drops the save's answer as older. It reads nothing more
//      while the save is held. Once the save has been answered the page reads the order once more,
//      and only once: the strip shows the saved quantity, the box reads Saved, and nothing but the
//      save was sent.
//   I. Last, the same click with the answers the other way round: the server answers the page's
//      read before it sees the save, the save's answer reaches the page first, and the read's
//      answer, which does not hold the save, after it. That answer puts the old quantity back and
//      takes the box's Saved mark, and the page then reads once more: the box and the strip end on
//      the saved quantity, with no Saved mark (the owner's ruling of 2026-10-18).
//
// Along the way it reads the strip of order quantities in the At a glance card (the same design's
// §5 and §10.2). On the order as entered every figure agrees and none is a link. The corrected
// quantity of part A moves Parts and turns the Loads figure into a link that reads over, in the
// answer to that one save, and a reload reads the same. In part B the refused value leaves the
// strip at the stored figures, and the strip's links to Loads and to Lines jump there without
// asking first, without leaving the order's page and without the card covering the heading.
//
// The hub's sections sit in tabs (the UX redesign's PR 2): every section stays mounted, but a
// section on another tab is hidden, so a box cannot be typed into and nothing of it is visible
// until its tab is open. Each turn to a section on another tab opens that tab first, through
// `openOrderTab` or `hubSection`; the card at the right is on every tab. A refused value or an
// unconfirmed removal in Lines badges the Parts & containers tab "Unsaved changes".
//
// The Lines section's message and the line show the same sentence, so every text locator here is
// scoped to the line's row or to that message (the page banner held it before P6 step 5a). The
// order belongs to the shipping fixture customer, whose teardown reaps it; nothing here is invoiced, paid or printed, and ctx.created is not touched.
// Re-split and Create invoice are clicked and declined: neither sends a request. A request from
// Create invoice would make an invoice that teardown does not delete, so for that one check the
// flow answers a create request itself and none can reach the server, pass or fail. Part A's
// refused weight is answered here as well: the order holds nothing a real weight save would be
// refused for at that point, and the check is about what the page sends, not what the server says.
//
// Parts E and F each lose one answer on purpose. The suite's helper for that holds the page's
// request, sends the same request to the server through the harness's counted call, and then fails
// the page's own copy, so the browser reports two failed requests in this flow when nothing is
// wrong. They come after part D: no earlier part reads what they do. Part E leaves the order as
// part D left it. Part F adds a rider through the harness's counted call, and the removal it loses
// takes that rider away again, so the order ends with its lead line only.
//
// Part G uses the same helper to send the page's request to the server through the counted call,
// and then answers the page's own copy with the server's status and a body cut short, so no request
// fails. It comes after E and F, and before H and I, which read the order again: it leaves the lead
// line saved at 22 pieces, with the page and the server agreeing.
//
// Refresh order before printing shows only while a same-order scan's read of the order has failed,
// or while the Loads editor holds loads newer than the page. So parts H and I each scan the order's
// first load and answer that scan's read of the order here with a 503, which is an answer, not a
// failed request; it never reaches the server. A read of the order that fails marks the bulk
// grids unavailable, and Refresh reads again for the Loads grid alone, so Containers, Serials and
// Charges stay unavailable from part H's scan to the end of the flow, which uses none of them. Each
// part then holds the save at the lead line's own address with the suite's helper, which sends it
// to the server through the counted call when it is let go; part I also holds the answer to the
// page's read of the order, which the same helper fetches from the server at once.
import assert from "node:assert/strict";
import { answerModal, modalBody, modalTitle, waitForModal } from "../lib/modal.mjs";
import { assertNeverVisible, unreadReason, waitForFocused, waitForValue } from "../lib/ui.mjs";
import { createOrderViaUi, hubSection, hubTabLabel, openOrderTab, orderPanel, startNewShipment, waitForShipmentPage } from "../lib/orders.mjs";
import { bounded, holdRequest, mutate, pageDown, readJson } from "../lib/order-entry-workspace.mjs";
import { routeRequests } from "../route-keep-alive.mjs";

const QTY_REFUSED = "Lead: quantity must be a whole number of at least 1.";
// What the page says when the answer to a write it sent was a 2xx it could not read (#547, the
// owner's answer of 2026-10-18): on the Lines message and under the line, in part G.
const WRITE_ANSWER_UNREADABLE = "The change was saved, but the answer could not be read. Reload the page to see it.";
// What this flow's own route answers a create-invoice request with. No server sentence reads so.
const RESPLIT_QUESTION = "Re-split loads using the part’s current defaults? This replaces the current load rows and their unsaved edits.";
const INVOICE_ANSWERED_HERE = "Answered by the hub-line-corrections flow: no invoice was created.";
// What this flow's own route answers the offered weight's save with in part A.
const WEIGHT_ANSWERED_HERE = "Answered by the hub-line-corrections flow: the weight was not saved.";
// What this flow's own route answers a scan's read of the order with in parts H and I.
const ORDER_READ_ANSWERED_HERE = "Answered by the hub-line-corrections flow: the order was not read.";
const PRINT_WAITS =
  "Save the changes first, restore a value marked Not saved, or press Remove again on a line marked Removal not confirmed — a print archives what the server holds";
// The mark beside the Remove of a line whose removal the server did not answer, and the reason
// under line 2 when it is that line.
const REMOVAL_NOT_CONFIRMED = "Removal not confirmed";
const LINE_2_REMOVAL_REASON = "Line 2: the app could not tell whether the removal went through. "
  + "Press Remove to try again, or reload the page to see what the order holds.";
// The card's one traveler control, however many loads the order has.
const PRINT = /^Print (\d+ travelers?|traveler)$/;
// The tabs this flow turns between: Lines and the Loads section's Re-split and Refresh.
const PARTS = hubTabLabel("parts");
const LOADS = hubTabLabel("loads");
// Any offer's control: "Use 320.00 lb".
const USE = /^Use /;

/** A hub section by its heading, with no wait on its tab: the caller opens that tab. */
function section(page, name) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) });
}

/** Whether `a` and `b`, two boxes, share any point. */
function overlap(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

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

/** The page's address without its hash: a jump inside the page changes the hash alone, and a tab
 *  click the `tab` query. */
function addressOf(page) {
  const url = new URL(page.url());
  return `${url.origin}${url.pathname}${url.search}`;
}

/** The order's own page: its address without query or hash. */
function pageOf(page) {
  const url = new URL(page.url());
  return `${url.origin}${url.pathname}`;
}

/** The Lines section's own message, by its words (ruling R1, P6 step 5a): the shared panel
 *  message under the lines table, where the hub's page banner used to say them. */
function linesMessage(page, sentence) {
  return section(page, "Lines").locator('p[role="alert"].whitespace-pre-line').filter({ hasText: sentence });
}

/** The page banner, by its words: the paragraph that says them outside every section. A Lines
 *  refusal must never reach it. */
function pageBanner(page, sentence) {
  return page.locator("xpath=//p[not(ancestor::section)]").filter({ hasText: sentence });
}

function savedMark(lines, field) {
  return lines.getByRole("status", { name: `${field} saved`, exact: true });
}

function notSavedMark(lines, field) {
  return lines.getByRole("alert", { name: `${field} not saved`, exact: true });
}

/** The reason a Not saved box gives: the paragraph, inside the Lines section, that the box names
 *  as its description. */
async function reasonAt(lines, box) {
  assert.equal(await box.getAttribute("aria-invalid"), "true", "a Not saved box must be marked invalid");
  const id = await box.getAttribute("aria-describedby");
  assert.ok(id, "a Not saved box must name the paragraph that says why");
  return ((await lines.locator(`[id="${id}"]`).textContent()) ?? "").trim();
}

/** Waits for a control to be disabled, or enabled, and fails by name when it never is. */
async function waitForDisabled(control, expected, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await control.isDisabled({ timeout: 1000 }).catch(() => undefined) === expected) return;
    if (Date.now() > deadline) assert.fail(what);
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
}

/** Clicks a control that must ask before it acts; answers Cancel; returns the prompt's words. A
 *  click that raises no prompt fails here with `mustAsk`, the control having already acted. */
async function declinePrompt(page, click, mustAsk) {
  let asked = null;
  const cancel = (dialog) => {
    asked = { message: dialog.message(), failure: dialog.dismiss().then(() => null, (error) => error) };
  };
  page.once("dialog", cancel);
  try { await click(); } finally { page.off("dialog", cancel); }
  assert.ok(asked, mustAsk);
  assert.equal(await asked.failure, null, "the prompt must be answered");
  return asked.message;
}

/** Clicks a control that must ask through the modal; answers Cancel; returns the question's title
 *  and sentence. A click that raises none fails here with `mustAsk`, the control having acted. */
async function declineModal(page, click, mustAsk) {
  await click();
  await waitForModal(page, mustAsk);
  const asked = { title: await modalTitle(page), body: await modalBody(page) };
  await answerModal(page, { confirm: false });
  return asked;
}

// What the strip reads for this flow's order (the design's §10.5, S1 to S4), worked out here from
// the quantities this flow keys and not from the page's own rule. No containers and no serials
// are entered, and the one load keeps the 140 pieces the order was entered with: nothing in this
// flow saves the loads. `parts` is what the lines hold, never more than 140. The container
// figure's words are the weights design's (its §9.5, S3).
function stripAt(parts) {
  const loads = parts === 140 ? "Loads 140" : `Loads 140 · ${140 - parts} over`;
  return `Parts ${parts} pcs · Container pieces not entered · ${loads} · Serials not entered`;
}

/** Waits until the strip reads exactly `expected`, its four figures joined by " · ", and fails
 *  with the text it last read. Runs of white space are read as one space.
 *
 *  A read that gave no text is never taken for an empty strip. The failure says why there was
 *  none, in the words `waitForTitle` uses (e2e/lib/ui.mjs): no strip on the page is "the element
 *  could not be read", and any other rejection, two groups of that name or a closed page, is
 *  named by its own message. A rejected read does not end the wait: one that passes costs nothing. */
async function waitForStrip(strip, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // `text` is what the strip read. `rejection` is set, and `text` left undefined, when the read
    // gave no answer at all.
    const read = await strip.textContent({ timeout: 1000 }).then(
      (text) => ({ text: text === null ? null : text.replace(/\s+/g, " ").trim() }),
      (rejection) => ({ text: undefined, rejection }));
    if (!("rejection" in read) && read.text === expected) return;
    if (Date.now() > deadline) {
      assert.fail(`Timed out waiting for the strip to read ${JSON.stringify(expected)}; `
        + `last read ${"rejection" in read ? `nothing (${unreadReason(read.rejection)})` : JSON.stringify(read.text)}`);
    }
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
}

/** Clicks a link of the strip and requires what a jump inside the page does: it asks nothing, the
 *  page and its query stay (the link is a plain `#id` anchor, so the hash changes, and that hash
 *  opens the section's tab), and the heading of the section it names comes into view, clear of the
 *  At a glance card. */
async function jumpFromStrip(page, summary, link, headingName) {
  const address = addressOf(page);
  const prompts = [];
  const notePrompt = (dialog) => { prompts.push(dialog.message()); void dialog.dismiss().catch(() => {}); };
  page.on("dialog", notePrompt);
  try { await link.click(); } finally { page.off("dialog", notePrompt); }
  assert.deepEqual(prompts, [], `the strip's link to ${headingName} must not ask before it jumps`);
  assert.equal(addressOf(page), address, `the strip's link to ${headingName} must change nothing of the address but its hash`);
  const headingLocator = page.getByRole("heading", { name: headingName, exact: true });
  await headingLocator.waitFor({ state: "visible", timeout: 5000 });
  const heading = await waitForInView(page, headingLocator, `the ${headingName} heading a strip link jumped to`);
  const card = await summary.boundingBox();
  assert.ok(card, "the At a glance card must be on the page");
  assert.ok(!overlap(card, heading), `the At a glance card must not cover the ${headingName} heading a strip link jumped to`);
}

/** The order's own traffic, in the order the page sent and heard it: "GET" for each read of the
 *  order the page sends to `orderPath`, "PATCH" for each request it sends to `savePath`, and
 *  "PATCH answered" for each answer to one. A request the flow sends apart from the page (a
 *  `readJson`, a hold forwarding the page's request to the server) is not in it. `heard(test)`
 *  resolves once `test` holds of the log, and is raced against a time limit where it is awaited.
 *  `stop` takes the listeners off. */
function orderTraffic(page, orderPath, savePath) {
  const log = [];
  const waiters = new Set();
  const note = (entry) => {
    log.push(entry);
    for (const waiter of waiters) waiter();
  };
  const onRequest = (req) => {
    const path = new URL(req.url()).pathname;
    if (req.method() === "GET" && path === orderPath) note("GET");
    else if (req.method() === "PATCH" && path === savePath) note("PATCH");
  };
  const onResponse = (res) => {
    if (res.request().method() === "PATCH" && new URL(res.url()).pathname === savePath) note("PATCH answered");
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  return {
    log,
    heard: (test) => new Promise((resolve) => {
      const check = () => {
        if (!test(log)) return;
        waiters.delete(check);
        resolve();
      };
      waiters.add(check);
      check();
    }),
    stop() {
      page.off("request", onRequest);
      page.off("response", onResponse);
      waiters.clear();
    },
  };
}

/** Whether, in an `orderTraffic` log, the save went out before the page's first read of the order. */
function saveBeforeRead(log) {
  const save = log.indexOf("PATCH");
  const read = log.indexOf("GET");
  return save !== -1 && read !== -1 && save < read;
}

/** Whether, in an `orderTraffic` log, the page read the order after the save's first answer. */
function readAfterAnswer(log) {
  const answered = log.indexOf("PATCH answered");
  return answered !== -1 && log.indexOf("GET", answered + 1) !== -1;
}

/** How many reads of the order an `orderTraffic` log holds; with `afterAnswer`, only those after the
 *  save's first answer. */
function readsIn(log, { afterAnswer = false } = {}) {
  const answered = log.indexOf("PATCH answered");
  if (afterAnswer && answered === -1) return 0;
  return log.slice(afterAnswer ? answered + 1 : 0).filter((entry) => entry === "GET").length;
}

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;

  // Part A weighs 10 lb each and part B 5 lb each, so the order is entered at 1000 lb and 200 lb.
  const order = await createOrderViaUi(page, ctx, {
    customerCode: fixtures.shipCustomerCode,
    lines: [
      { partNumber: fixtures.shipPartANumber, qty: 100 },
      { partNumber: fixtures.shipPartBNumber, qty: 40 },
    ],
  });
  const hubUrl = `${ctx.baseURL}/orders/${order.id}`;
  const linePath = `/api/orders/${order.id}/lines/`;

  // Every write these pages send to this order, to a shipment or to an invoice, in order, as
  // "METHOD body".
  const writes = [];
  page.on("request", (req) => {
    const path = new URL(req.url()).pathname;
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method())) return;
    if (path.startsWith(`/api/orders/${order.id}/`) || path.startsWith("/api/shippers")
      || path.startsWith("/api/invoices")) {
      writes.push(`${req.method()} ${req.postData() ?? ""}`.trim());
    }
  });
  // What was written since `mark`. A save leaves the page in the task of the event that causes it
  // and is heard of here a moment later, so the list is read after a pause, never at once.
  const sentSince = async (mark) => {
    await page.waitForTimeout(300);
    return writes.slice(mark);
  };
  // A waiter for a response, marked handled where it is made. Every one here is made before the
  // step that causes its response and awaited after it. When a step in between fails, the waiter
  // rejects with nobody awaiting it (the page closing under it, or its own time limit running out
  // first), and the harness ends the whole run on a rejection nothing handles: the flows after this
  // one would never run, and the failure would not be reported as this flow's. The handler below
  // takes only that. What is handed back is the waiter itself, so the await at the place of use
  // still fails inside this flow when no such response comes.
  const answerTo = (matches) => {
    const waiter = page.waitForResponse(matches);
    waiter.catch(() => {});
    return waiter;
  };
  // The same, for a request the page makes. It is met only by a request made after it is armed.
  const requestTo = (matches) => {
    const waiter = page.waitForRequest(matches);
    waiter.catch(() => {});
    return waiter;
  };
  const lineSaveAnswer = () => answerTo((res) =>
    new URL(res.url()).pathname.startsWith(linePath) && res.request().method() === "PATCH");

  const lines = section(page, "Lines");
  const summary = page.getByRole("region", { name: "At a glance" });
  const leadQty = lines.getByLabel("Lead quantity", { exact: true });
  const leadWeight = lines.getByLabel("Lead weight", { exact: true });
  const line2Qty = lines.getByLabel("Line 2 quantity", { exact: true });
  const line2Weight = lines.getByLabel("Line 2 weight", { exact: true });
  const anyOffer = lines.getByRole("button", { name: USE });
  const print = summary.getByRole("button", { name: PRINT });
  // The strip of order quantities, and its link to the Loads section while the lines hold `parts`.
  const strip = summary.getByRole("group", { name: "Order quantities", exact: true });
  const stripLoads = (parts) => strip.getByRole("link", { name: `Loads 140 · ${140 - parts} over`, exact: true });
  // What the SERVER holds for the lead line, read apart from the page: nothing on screen changes.
  const leadOnServer = async () => {
    const detail = await readJson(page, ctx, `/api/orders/${order.id}`);
    const lead = detail.lines.find((line) => line.position === 1);
    assert.ok(lead, "the order must still have its lead line");
    return lead;
  };
  // The saved order opens on Overview; the lines are on Parts & containers.
  await openOrderTab(page, PARTS);
  await waitForValue(leadQty, "100");
  await waitForValue(leadWeight, "1000");
  // Nothing is checked about an offer here. Both stored weights are their quantity × each weight
  // (100 × 10 lb, 40 × 5 lb), and a line in that state is offered nothing whether or not anyone
  // changed it. That a line nobody changed in this visit is offered nothing is checked where it can
  // fail: after the reload below, with line 2 holding 200 lb against 30 × 5 lb.

  // As entered: 100 + 40 pieces, one load of 140, no containers, no serials. Every figure agrees,
  // so the strip holds no link.
  await waitForStrip(strip, stripAt(140));
  assert.equal(await strip.getByRole("link").count(), 0, "a strip whose figures all agree must hold no link");

  // --- A. Enter saves in place; the line is then offered its calculated weight. ---
  let mark = writes.length;
  let answer = lineSaveAnswer();
  await leadQty.fill("32");
  await leadQty.press("Enter");
  assert.equal((await answer).status(), 200, "the corrected quantity must save");
  await savedMark(lines, "Lead quantity").waitFor();
  await waitForFocused(leadQty, "the Lead quantity box after Enter saved it");
  await lines.getByText("32 × 10.0000 lb = 320.00 lb", { exact: true }).waitFor();
  const useLead = lines.getByRole("button", { name: "Use 320.00 lb", exact: true });
  await useLead.waitFor();
  // The answer to that one save moved the strip as well: Parts is 32 + 40, and the load nobody
  // changed still holds 140. The Loads figure is now a link to its section and Parts a link to
  // Lines; the two figures with nothing entered stay plain text. Reading them moves no focus.
  await waitForStrip(strip, stripAt(72));
  assert.equal(await stripLoads(72).getAttribute("href"), "#loads", "the Loads figure must link to the Loads section");
  assert.equal(await strip.getByRole("link", { name: "Parts 72 pcs", exact: true }).getAttribute("href"), "#lines",
    "Parts must link to the Lines section while a figure disagrees");
  assert.equal(await strip.getByRole("link").count(), 2, "a figure with nothing entered must not be a link");
  // Tab leaves the box. The Enter save already landed, so leaving sends nothing and the mark stays.
  await page.keyboard.press("Tab");
  await waitForFocused(leadWeight, "the Lead weight box after Tab");
  assert.deepEqual(await sentSince(mark), ['PATCH {"qty":32}'], "Enter and then Tab must be one save");
  assert.equal(await savedMark(lines, "Lead quantity").isVisible(), true, "Tab must not take the Saved mark away");
  await shot("quantity-saved-weight-offered");

  // The offer is accepted with the mouse while focus is in the Weight box, and its save is
  // refused. The Use control leaves focus in the box, so no focus event says the box now holds
  // the offered figure. Leaving the box must not send that figure again: a value marked Not saved
  // is retried with Enter or with Use, never by leaving its box. While this check runs, a weight
  // save of the lead line is answered here with a 409 and kept in `refusedWeightSaves`; it never
  // reaches the server, so the stored weight stays 1000 lb. Any other request to that address
  // goes on its way.
  const leadLineId = (await leadOnServer()).id;
  const refusedWeightSaves = [];
  const refuseWeightSave = async (route) => {
    const sent = route.request().method() === "PATCH" ? route.request().postDataJSON() : null;
    if (sent === null || !Object.hasOwn(sent, "weight")) { await route.continue(); return; }
    refusedWeightSaves.push(route.request().postData() ?? "");
    await route.fulfill({
      status: 409, contentType: "application/json", body: JSON.stringify({ error: WEIGHT_ANSWERED_HERE }),
    });
  };
  mark = writes.length;
  const stopRefusing = await routeRequests(page, `${ctx.baseURL}${linePath}${leadLineId}`, refuseWeightSave);
  await useLead.click();
  await notSavedMark(lines, "Lead weight").waitFor();
  await waitForValue(leadWeight, "320");
  assert.equal(await reasonAt(lines, leadWeight), WEIGHT_ANSWERED_HERE, "the refusal must be under the line");
  await linesMessage(page, WEIGHT_ANSWERED_HERE).waitFor();
  await assertNeverVisible(pageBanner(page, WEIGHT_ANSWERED_HERE), "a Lines refusal must not show in the page banner", 300);
  await waitForFocused(leadWeight, "the Lead weight box after its offer was accepted with the mouse");
  // Tab leaves the box for the Restore control beside its mark, which names the stored 1000 lb.
  await page.keyboard.press("Tab");
  await waitForFocused(lines.getByRole("button", { name: "Restore Lead weight to 1000", exact: true }),
    "the Lead weight box's Restore control after Tab");
  // Both lists are read after the one pause: a save the blur sent would be heard of a moment later.
  const sentAfterLeaving = await sentSince(mark);
  assert.deepEqual(refusedWeightSaves, ['{"weight":"320"}'],
    "leaving the box after a refused offer must not send the figure again");
  assert.deepEqual(sentAfterLeaving, ['PATCH {"weight":"320"}'], "a refused offer and then Tab must be one save");
  await waitForValue(leadWeight, "320");
  assert.equal(await notSavedMark(lines, "Lead weight").isVisible(), true, "the refused figure must still read Not saved");
  assert.equal(await useLead.isVisible(), true, "a refused weight save must leave the offer");
  // The one refused save was answered above, so none is in flight when the route goes (#340). A
  // check that fails above leaves the route where it is, still answering, until the harness
  // closes the page.
  await stopRefusing();
  await shot("refused-offer-not-saved");

  // Other text is typed into the Weight box and focus is still in it when the offer is accepted
  // with the mouse. The offered figure is what is saved; the typed text is never sent. The box
  // read Not saved a moment ago: the save that lands takes that mark, and the refusal's words
  // off the Lines message.
  mark = writes.length;
  await leadWeight.fill("999");
  answer = lineSaveAnswer();
  await useLead.click();
  assert.equal((await answer).status(), 200, "the offered weight must save");
  await waitForValue(leadWeight, "320");
  await savedMark(lines, "Lead weight").waitFor();
  await assertNeverVisible(anyOffer, "an accepted offer must go");
  assert.deepEqual(await sentSince(mark), ['PATCH {"weight":"320"}'],
    "accepting an offer must be one save, of the offered figure");
  await assertNeverVisible(linesMessage(page, WEIGHT_ANSWERED_HERE), "a weight save that lands must clear the earlier refusal from the Lines message", 500);

  // Line 2, saved by leaving the box this time: 30 × 5 lb = 150 lb is offered over the stored 200.
  mark = writes.length;
  answer = lineSaveAnswer();
  await line2Qty.fill("30");
  await page.keyboard.press("Tab");
  assert.equal((await answer).status(), 200, "a quantity must save on leaving its box");
  await savedMark(lines, "Line 2 quantity").waitFor();
  await lines.getByText("30 × 5.0000 lb = 150.00 lb", { exact: true }).waitFor();
  await lines.getByRole("button", { name: "Use 150.00 lb", exact: true }).waitFor();
  assert.deepEqual(await sentSince(mark), ['PATCH {"qty":30}'], "leaving the box must be one save");

  // The marks and the offer are for this visit only. After a reload line 2 still holds 200 lb
  // against 30 × 5 lb = 150 lb, and it is offered nothing: a stored weight may be a received weight.
  await page.reload();
  await page.getByRole("heading", { name: /^Order #\d+/ }).waitFor({ state: "visible", timeout: 15000 });
  // The tab rides in the address, so a reload keeps it; opened again so the checks below see it.
  await openOrderTab(page, PARTS);
  await waitForValue(leadQty, "32");
  await waitForValue(leadWeight, "320");
  await waitForValue(line2Qty, "30");
  await waitForValue(line2Weight, "200");
  await assertNeverVisible(lines.getByRole("status", { name: /saved$/ }), "a Saved mark must not outlive the visit");
  await assertNeverVisible(anyOffer, "an offered weight must not outlive the visit");
  // The strip is standing state, not a message about the last save: read again from the server,
  // it says the same of 32 + 30 pieces against the load's 140.
  await waitForStrip(strip, stripAt(62));

  // A weight typed by hand on an offered line is the operator's own: the offer goes. The box then
  // shows the stored spelling of what was typed and still reads Saved.
  mark = writes.length;
  answer = lineSaveAnswer();
  await line2Qty.fill("20");
  await line2Qty.press("Enter");
  assert.equal((await answer).status(), 200, "the second correction must save");
  await lines.getByRole("button", { name: "Use 100.00 lb", exact: true }).waitFor();
  answer = lineSaveAnswer();
  await line2Weight.fill("120.50");
  await line2Weight.press("Enter");
  assert.equal((await answer).status(), 200, "a weight typed by hand must save");
  await waitForValue(line2Weight, "120.5");
  await savedMark(lines, "Line 2 weight").waitFor();
  await assertNeverVisible(anyOffer, "a weight saved by hand must take the offer away");
  assert.deepEqual(await sentSince(mark), ['PATCH {"qty":20}', 'PATCH {"weight":"120.50"}'],
    "two corrections must be two saves");

  // --- B. A value the browser refuses: never sent, marked at the box, and counted as unsaved. ---
  await waitForDisabled(print, false, "the traveler print must be available before anything is refused");
  // The lines hold 32 + 20 pieces now, and the strip says so before anything is refused.
  await waitForStrip(strip, stripAt(52));
  mark = writes.length;
  await leadQty.fill("0");
  await page.keyboard.press("Tab");
  await notSavedMark(lines, "Lead quantity").waitFor();
  assert.equal(await reasonAt(lines, leadQty), QTY_REFUSED, "the reason must be under the line");
  await linesMessage(page, QTY_REFUSED).waitFor();
  await waitForValue(leadQty, "0");
  // The box shows a figure the server does not hold, so the traveler print waits and says why.
  await waitForDisabled(print, true, "the traveler print must wait while a value is marked Not saved");
  assert.equal(await print.getAttribute("title"), PRINT_WAITS, "the waiting print must name the way out");
  const asked = await declinePrompt(page,
    () => page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Reports", exact: true }).click(),
    "leaving the page with a value marked Not saved must ask first");
  assert.match(asked, /^Lines has unsaved changes/, "the leave prompt must name the Lines section");
  assert.equal(pageOf(page), hubUrl, "declining the prompt must keep the order on screen");
  await waitForValue(leadQty, "0");
  assert.equal(await notSavedMark(lines, "Lead quantity").isVisible(), true, "declining must change nothing");
  await shot("refused-quantity-not-saved");
  // The refused 0 is in the box and nowhere else: the strip reads saved state only, so it still
  // says 52. Its links are jumps inside the page, each into the section's own tab: Loads on
  // Loads & travelers, Lines back on Parts & containers. The main menu asked first a moment ago; a
  // strip link must not, and must leave the refused value in its box.
  await waitForStrip(strip, stripAt(52));
  await jumpFromStrip(page, summary, stripLoads(52), "Loads");
  await shot("strip-link-jumped-to-loads");
  await jumpFromStrip(page, summary, strip.getByRole("link", { name: "Parts 52 pcs", exact: true }), "Lines");
  assert.equal(pageOf(page), hubUrl, "the strip's links must leave the order's own page");
  await waitForValue(leadQty, "0");
  assert.equal(await notSavedMark(lines, "Lead quantity").isVisible(), true,
    "a strip link must leave a value marked Not saved as it was");

  // Re-split replaces the order's load rows, and it too asks first while a value in Lines is Not
  // saved. Its question is its own, with the Lines section named in front. Declined, it sends
  // nothing, and the load rows on screen are the ones that were there. Re-split is on Loads &
  // travelers, so that tab is opened for it, and Parts & containers again for Lines after it.
  const loads = await hubSection(page, "Loads");
  const loadBoxes = loads.locator("tbody input");
  const loadValues = () => loadBoxes.evaluateAll((boxes) => boxes.map((box) => box.value));
  const loadsBefore = await loadValues();
  assert.ok(loadsBefore.length > 0, "the order must have a load row for Re-split to replace");
  const resplitAsked = await declineModal(page,
    () => loads.getByRole("button", { name: "Re-split", exact: true }).click(),
    "Re-split must ask first while a value in Lines is marked Not saved");
  assert.equal(resplitAsked.title, RESPLIT_QUESTION, "Re-split's modal must ask its own question");
  assert.match(resplitAsked.body, /^Lines has unsaved changes\. Re-split loads /,
    "Re-split's question must name the Lines section");
  assert.deepEqual(await sentSince(mark), [], "a declined Re-split must send nothing");
  assert.deepEqual(await loadValues(), loadsBefore, "a declined Re-split must leave the load rows as they were");
  await openOrderTab(page, PARTS);
  await waitForValue(leadQty, "0");
  assert.equal(await notSavedMark(lines, "Lead quantity").isVisible(), true,
    "declining Re-split must change nothing in Lines");

  const restoreLead = lines.getByRole("button", { name: "Restore Lead quantity to 32", exact: true });
  await restoreLead.click();
  await waitForValue(leadQty, "32");
  await assertNeverVisible(notSavedMark(lines, "Lead quantity"), "Restore must clear the Not saved mark", 500);
  await assertNeverVisible(linesMessage(page, QTY_REFUSED), "Restore must clear the Lines message", 500);
  await waitForDisabled(print, false, "Restore must free the traveler print");
  assert.deepEqual(await sentSince(mark), [], "a refused value and its Restore must send nothing");

  // Refused again with Enter: the reason's row appears under the line and focus stays in the box,
  // so the keys that follow still land in it. 31 would be saved if focus left the box. The mouse
  // going down on Restore must not move focus, and Restore must put 32 back with no save.
  await leadQty.fill("0");
  await leadQty.press("Enter");
  await notSavedMark(lines, "Lead quantity").waitFor();
  await waitForFocused(leadQty, "the Lead quantity box after Enter was refused");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("31");
  await waitForValue(leadQty, "31");
  await restoreLead.click();
  await waitForValue(leadQty, "32");
  await assertNeverVisible(notSavedMark(lines, "Lead quantity"), "Restore must clear a retyped value too", 500);
  assert.deepEqual(await sentSince(mark), [], "Restore pressed with the mouse must not save the retyped value");

  // A Not saved value on a line that is then removed stops counting: the print is free again.
  await line2Qty.fill("0");
  await page.keyboard.press("Tab");
  await notSavedMark(lines, "Line 2 quantity").waitFor();
  await waitForDisabled(print, true, "a Not saved value on line 2 must hold the traveler print too");
  const removed = answerTo((res) =>
    new URL(res.url()).pathname.startsWith(linePath) && res.request().method() === "DELETE");
  await lines.locator("tbody tr").filter({ has: page.getByLabel("Line 2 quantity", { exact: true }) })
    .getByRole("button", { name: "Remove", exact: true }).click();
  assert.match(await modalTitle(page), /Remove .*\(Line 2\)/);
  await answerModal(page);
  assert.ok((await removed).ok(), "a line with a Not saved quantity can still be removed");
  await line2Qty.waitFor({ state: "hidden" });
  await waitForDisabled(print, false, "a removed line's Not saved value must stop holding the traveler print");

  // --- C. A received weight, a short shipment, and the server's refusal at the box. ---
  // The lead's weight is corrected by hand to a received 330 lb. The lead's quantity was not saved
  // since the reload, so nothing is offered, though 32 × 10 lb = 320 lb is not 330 lb.
  answer = lineSaveAnswer();
  await leadWeight.fill("330");
  await page.keyboard.press("Tab");
  assert.equal((await answer).status(), 200, "the received weight must save");
  await savedMark(lines, "Lead weight").waitFor();
  await assertNeverVisible(anyOffer, "a weight save alone must offer nothing", 500);

  await startNewShipment(page, ctx, fixtures.shipCustomerId, [order]);
  const entry = orderPanel(page, `#${order.number}`);
  const shipQty = entry.getByLabel("Line 1 ship-now quantity", { exact: true });
  const shipWeight = entry.getByLabel("Line 1 ship-now weight", { exact: true });
  const entryOffer = entry.getByRole("button", { name: USE });
  await waitForValue(shipQty, "32");
  await waitForValue(shipWeight, "330");
  await assertNeverVisible(entryOffer, "a row at its prefilled quantity must be offered nothing", 500);
  // Typed with the keyboard. The first key makes the offer's row appear under the row being typed
  // into; the second key goes to whatever holds focus then, with no locator finding the box again.
  mark = writes.length;
  await shipQty.selectText();
  await shipQty.pressSequentially("2");
  await entry.getByText("2 × 10.0000 lb = 20.00 lb", { exact: true }).waitFor();
  await page.keyboard.type("0");
  await waitForValue(shipQty, "20");
  await waitForFocused(shipQty, "the ship-now quantity box, across its offer appearing");
  await entry.getByText("20 × 10.0000 lb = 200.00 lb", { exact: true }).waitFor();
  await shot("ship-now-weight-offered");
  await entry.getByRole("button", { name: "Use 200.00 lb", exact: true }).click();
  await waitForValue(shipWeight, "200");
  await assertNeverVisible(entryOffer, "an accepted ship-now weight must take its offer away", 500);
  assert.deepEqual(await sentSince(mark), [], "accepting a ship-now weight fills the box and saves nothing");
  // What goes on the truck is heavier than the calculated 200 lb: 20 pieces at 250 lb.
  await shipWeight.fill("250");
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  const shipment = await waitForShipmentPage(page);

  await page.goto(hubUrl);
  await page.getByRole("heading", { name: /^Order #\d+/ }).waitFor({ state: "visible", timeout: 15000 });
  await summary.getByText(/ · Partially shipped$/).waitFor();
  await openOrderTab(page, PARTS);
  await waitForValue(leadQty, "32");
  // 20 of the 32 pieces have shipped, so the Shipments section's row for that shipment reads
  // Partial. The row is a body row: the column's heading, which always reads Complete, is not in it.
  // The section is on Shipping & certs, Lines on Parts & containers: the flow turns between them.
  const shipmentRow = (await hubSection(page, "Shipments")).locator("tbody tr")
    .filter({ has: page.getByRole("link", { name: `${order.number}-1`, exact: true }) });
  await shipmentRow.getByRole("cell", { name: "Partial", exact: true }).waitFor();
  await openOrderTab(page, PARTS);
  // 19 is below the 20 shipped. The server refuses it, and its sentence is at the box and on the Lines message.
  const belowShipped = `Line 1 (${fixtures.shipCustomerCode} · ${fixtures.shipPartANumber}): cannot reduce qty below 20 `
    + `already shipped — Packing List ${shipment.shipperNumber} — void the shipment first`;
  mark = writes.length;
  answer = lineSaveAnswer();
  await leadQty.fill("19");
  await leadQty.press("Enter");
  assert.equal((await answer).status(), 400, "a quantity below what has shipped must be refused");
  await notSavedMark(lines, "Lead quantity").waitFor();
  assert.equal(await reasonAt(lines, leadQty), belowShipped, "the server's sentence must be under the line");
  await linesMessage(page, belowShipped).waitFor();
  await waitForValue(leadQty, "19");
  await shot("server-refusal-at-the-box");
  // Leaving the box does not send the refused value again.
  await page.keyboard.press("Tab");
  assert.deepEqual(await sentSince(mark), ['PATCH {"qty":19}'], "Tab after a refused Enter must send nothing more");
  // Enter, back in the box, retries the value it holds: one more save, refused again.
  answer = lineSaveAnswer();
  await leadQty.press("Enter");
  assert.equal((await answer).status(), 400, "the retry must reach the server and be refused again");
  await waitForDisabled(restoreLead, false, "Restore must be usable again once the retry has been answered");
  assert.equal(await notSavedMark(lines, "Lead quantity").isVisible(), true, "a refused retry must stay Not saved");
  assert.deepEqual(await sentSince(mark), ['PATCH {"qty":19}', 'PATCH {"qty":19}'],
    "Enter on a Not saved value must be one more save of the same value");
  await restoreLead.click();
  await waitForValue(leadQty, "32");
  await assertNeverVisible(linesMessage(page, belowShipped), "Restore must clear the server's sentence from the Lines message", 500);
  // The server's 400 is an answer: it wrote nothing, so the 32 on the page is what it holds, and
  // Restore puts it back with no request. The list still holds the two refused saves and no third.
  assert.deepEqual(await sentSince(mark), ['PATCH {"qty":19}', 'PATCH {"qty":19}'],
    "Restore after the server's own refusal must send nothing");

  // 20 is exactly what has shipped: it saves, and every line of the order has now shipped in full.
  answer = lineSaveAnswer();
  await leadQty.fill("20");
  await leadQty.press("Enter");
  assert.equal((await answer).status(), 200, "a quantity equal to what has shipped must save");
  await savedMark(lines, "Lead quantity").waitFor();
  await summary.getByText(/ · Shipped$/).waitFor();
  // #473: the tag follows the line save. The page has not been loaded again since it read Partial;
  // opening the section's tab shows what the section already holds.
  await openOrderTab(page, hubTabLabel("shipping"));
  await shipmentRow.getByRole("cell", { name: "Complete", exact: true }).waitFor();
  await assertNeverVisible(shipmentRow.getByRole("cell", { name: "Partial", exact: true }),
    "the Shipments row must not still read Partial once the order is Shipped", 500);
  await openOrderTab(page, PARTS);
  // 20 × 10 lb = 200 lb is offered over the stored 330 lb, and 250 lb has already shipped: the
  // order line cannot take 200 lb, so the figure is shown with its control disabled and the reason.
  await lines.getByText("20 × 10.0000 lb = 200.00 lb", { exact: true }).waitFor();
  const blocked = lines.getByRole("button", { name: "Use 200.00 lb", exact: true });
  assert.equal(await blocked.isDisabled(), true, "a weight below what has shipped must not be usable");
  assert.equal(await blocked.getAttribute("title"), "Below the 250.00 lb already shipped");
  await lines.getByText("Below the 250.00 lb already shipped", { exact: true }).waitFor();
  await shot("shipped-offer-below-shipped-weight");

  // 200 lb typed by hand meets what the blocked offer states: the server refuses a weight below
  // the 250 lb shipped, and the Weight box reads Not saved. The order is Shipped and has no
  // invoice, so the Invoices section, on Billing, offers Create invoice, which leaves this page
  // for the new invoice. It asks first. Declined, it sends nothing and the order stays on screen.
  mark = writes.length;
  answer = lineSaveAnswer();
  await leadWeight.fill("200");
  await leadWeight.press("Enter");
  assert.equal((await answer).status(), 400, "a weight below what has shipped must be refused");
  await notSavedMark(lines, "Lead weight").waitFor();
  const invoices = await hubSection(page, "Invoices");
  const createInvoice = invoices.getByRole("button", { name: "Create invoice", exact: true });
  await waitForDisabled(createInvoice, false, "a Shipped order with no invoice must offer Create invoice");
  // A create request that reached the server would leave a draft invoice on this order. The
  // harness's cleanup deletes no invoice of the shipping fixture customer, so it could not reap
  // the order, in this run's teardown or in any later run's fixture step. So while this check
  // runs, a POST to /api/invoices is answered here with a 409 and kept in `invoicePosts`; it
  // never reaches the server. Any other request to that address goes on its way.
  const invoicePosts = [];
  const answerInvoicePost = async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    invoicePosts.push(route.request().postData() ?? "");
    await route.fulfill({
      status: 409, contentType: "application/json", body: JSON.stringify({ error: INVOICE_ANSWERED_HERE }),
    });
  };
  const stopAnswering = await routeRequests(page, `${ctx.baseURL}/api/invoices`, answerInvoicePost);
  let invoiceAsked;
  try {
    invoiceAsked = await declineModal(page, () => createInvoice.click(),
      "Create invoice must ask first while a value in Lines is marked Not saved");
  } catch (failure) {
    // A click that raised no prompt has acted, and its request is on its way to the route. The
    // section prints the route's answer when it lands. Waiting for that, five seconds at most,
    // lets the check fail with the request answered and not with the page closing over it.
    await invoices.getByText(INVOICE_ANSWERED_HERE, { exact: true }).waitFor({ timeout: 5000 }).catch(() => {});
    throw failure;
  }
  assert.equal(invoiceAsked.title, "Discard unsaved changes?", "Create invoice leaves the page, so it asks the leave question");
  assert.match(invoiceAsked.body, /^Lines has unsaved changes/, "Create invoice's prompt must name the Lines section");
  // Both lists are read after the one pause: the route hears of a request a moment after the click.
  const sentAfterDecline = await sentSince(mark);
  assert.deepEqual(invoicePosts, [], "a declined Create invoice must leave the route no create request to answer");
  assert.deepEqual(sentAfterDecline, ['PATCH {"weight":"200"}'],
    "after the refused save, a declined Create invoice must send nothing");
  assert.equal(pageOf(page), hubUrl, "declining Create invoice must keep the order on screen");
  await openOrderTab(page, PARTS);
  assert.equal(await notSavedMark(lines, "Lead weight").isVisible(), true,
    "declining Create invoice must change nothing in Lines");
  // No create request was issued, so none is in flight when the route goes (#340). A check that
  // fails above leaves the route where it is, still answering, until the harness closes the page.
  await stopAnswering();
  await lines.getByRole("button", { name: "Restore Lead weight to 330", exact: true }).click();
  await waitForValue(leadWeight, "330");
  await assertNeverVisible(notSavedMark(lines, "Lead weight"), "Restore must clear the Weight box's mark too", 500);

  // --- D. The saved shipment: the same offer, cleared by Discard, saved by Save lines. ---
  await page.goto(`${ctx.baseURL}/shipping/${shipment.id}`);
  await waitForShipmentPage(page);
  const panel = orderPanel(page, `${order.number}-1`);
  const savedQty = panel.getByLabel("Line 1 ship-now quantity", { exact: true });
  const savedWeight = panel.getByLabel("Line 1 ship-now weight", { exact: true });
  const panelOffer = panel.getByRole("button", { name: USE });
  await waitForValue(savedQty, "20");
  await waitForValue(savedWeight, "250");
  // 20 × 10 lb = 200 lb is not the 250 lb this row shipped at, and nobody has changed the row.
  await assertNeverVisible(panelOffer, "a saved row at its saved quantity must be offered nothing", 500);
  mark = writes.length;
  await savedQty.fill("15");
  await panel.getByText("15 × 10.0000 lb = 150.00 lb", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Discard changes to lines", exact: true }).click();
  await waitForValue(savedQty, "20");
  await assertNeverVisible(panelOffer, "Discard must take the offer away with the typed quantity");
  assert.deepEqual(await sentSince(mark), [], "an offer shown and discarded must send nothing");

  await savedQty.fill("15");
  await panel.getByRole("button", { name: "Use 150.00 lb", exact: true }).click();
  await waitForValue(savedWeight, "150");
  await assertNeverVisible(panelOffer, "an accepted weight must take its offer away", 500);
  await panel.getByText("Unsaved changes", { exact: true }).waitFor();
  assert.deepEqual(await sentSince(mark), [], "accepting a weight on a saved shipment saves nothing by itself");
  // What went on the truck weighed 160 lb, typed over the accepted 150. The row is still at 15
  // against the 20 this shipment saved, and 160 lb is not 15 × 10 lb, so the offer is back.
  await savedWeight.fill("160");
  await panel.getByRole("button", { name: "Use 150.00 lb", exact: true }).waitFor();
  const linesSaved = answerTo((res) =>
    new URL(res.url()).pathname.startsWith(`/api/shippers/${shipment.id}/orders/`) && res.request().method() === "PUT");
  await panel.getByRole("button", { name: "Save lines", exact: true }).click();
  assert.ok((await linesSaved).ok(), "Save lines must save what the row's boxes hold");
  await panel.getByText("Unsaved changes", { exact: true }).waitFor({ state: "hidden" });
  // Read back from the server: the shipment holds 15 pieces at 160 lb. The same two figures were
  // offered 150 lb a moment ago. They are offered nothing now, and the one thing that changed is
  // the quantity this shipment has saved: the row starts from 15, not from 20.
  await page.reload();
  await waitForShipmentPage(page);
  await waitForValue(savedQty, "15");
  await waitForValue(savedWeight, "160");
  await assertNeverVisible(panelOffer, "a row at its newly saved quantity must be offered nothing", 500);
  await shot("shipment-row-at-its-newly-saved-quantity");

  // --- E. A save whose answer is lost after the server commits it; Restore then saves. ---
  // The order holds 20 pieces at 330 lb, with 15 of them shipped, so 21 and 20 are both quantities
  // the server takes.
  await page.goto(hubUrl);
  await page.getByRole("heading", { name: /^Order #\d+/ }).waitFor({ state: "visible", timeout: 15000 });
  await openOrderTab(page, PARTS);
  await waitForValue(leadQty, "20");
  await waitForValue(leadWeight, "330");
  const leadLine = await leadOnServer();
  assert.equal(leadLine.qty, 20, "the server must hold 20 pieces before the lost save");
  await waitForDisabled(print, false, "the traveler print must be available before the lost save");

  // The one save of 21 is held at the lead line's own address. The server takes it and answers
  // 200; the page's request is then failed, so the page never hears that answer.
  mark = writes.length;
  const lost = await holdRequest(page, ctx, `${linePath}${leadLine.id}`, { method: "PATCH", lose: true });
  try {
    await leadQty.fill("21");
    await leadQty.press("Enter");
    const held = await lost.arrived();
    assert.deepEqual(held.data, { qty: 21 }, "the held save must be the one the box sent");
    assert.equal(held.response.status(), 200, "the server must commit the save whose answer is then lost");
    await lost.close();
  } finally { await lost.close(); }
  // The page and the server now disagree, and the page cannot know it. The box keeps 21 and reads
  // Not saved. Its reason is the browser's own sentence for a request that failed, which is not
  // checked. The stored quantity the page still has is 20, and that is what Restore names.
  await notSavedMark(lines, "Lead quantity").waitFor();
  await waitForValue(leadQty, "21");
  assert.equal((await leadOnServer()).qty, 21, "the server must hold the typed quantity under a box that reads Not saved");
  await waitForDisabled(print, true, "the traveler print must wait after a save whose answer was lost");
  assert.equal(await print.getAttribute("title"), PRINT_WAITS, "the waiting print must name the way out");
  assert.deepEqual(await sentSince(mark), ['PATCH {"qty":21}'], "the page must have sent the lost save once");
  await shot("lost-answer-not-saved");

  // Restore cannot put 20 back by clearing the box: the server holds 21. It saves 20. The contrast
  // is in parts B and C: a refusal is an answer, the stored value is then still what the server
  // holds, and Restore is local. Part B fails when it is not: a Restore that saves leaves the Not
  // saved mark up until its answer, which "Restore must clear the Not saved mark" sees, and its
  // request is in the list that "a refused value and its Restore must send nothing" reads. Part C
  // reads the same list after the server's own refusal. Here the list is read before the answer
  // is waited for, so a Restore that sent nothing fails by name and at once.
  const restoreLost = lines.getByRole("button", { name: "Restore Lead quantity to 20", exact: true });
  mark = writes.length;
  answer = lineSaveAnswer();
  await restoreLost.click();
  await waitForValue(leadQty, "20");
  assert.deepEqual(await sentSince(mark), ['PATCH {"qty":20}'],
    "Restore after a save the server did not answer must send exactly one save, of the stored value");
  assert.equal((await answer).status(), 200, "the stored quantity must save");
  await savedMark(lines, "Lead quantity").waitFor();
  await waitForValue(leadQty, "20");
  await assertNeverVisible(notSavedMark(lines, "Lead quantity"), "a Restore that saved must take the Not saved mark away", 500);
  assert.equal((await leadOnServer()).qty, 20, "the server must hold the stored quantity again");
  await waitForDisabled(print, false, "a Restore that saved must free the traveler print");
  // Read again now that the answer has landed and the page has settled: still the one save.
  assert.deepEqual(await sentSince(mark), ['PATCH {"qty":20}'], "a Restore that saved must send nothing more once it lands");
  await shot("restore-saved-the-stored-value");

  // --- F. A rider's removal whose answer is lost after the server commits it; Remove again. ---
  // A rider of 4 pieces at 20 lb is added through the harness's counted call. Part B removed line
  // 2, so the rider is line 2 again, and nothing has shipped against it.
  const withRider = await mutate(page, ctx, `/api/orders/${order.id}/lines`,
    { partId: fixtures.shipPartBId, qty: 4, weight: "20" });
  const rider = withRider.lines.find((line) => line.position === 2);
  assert.ok(rider, "the added rider must be line 2");
  // The line as the Remove confirm names it.
  const riderNaming = `${fixtures.shipCustomerCode} · ${fixtures.shipPartBNumber} (Line 2)`;
  await page.reload();
  await page.getByRole("heading", { name: /^Order #\d+/ }).waitFor({ state: "visible", timeout: 15000 });
  await openOrderTab(page, PARTS);
  await waitForValue(line2Qty, "4");
  await waitForDisabled(print, false, "the traveler print must be available before the lost removal");
  const line2Remove = lines.locator("tbody tr").filter({ has: page.getByLabel("Line 2 quantity", { exact: true }) })
    .getByRole("button", { name: "Remove", exact: true });
  const removalMark = lines.getByRole("alert", { name: "Line 2 removal not confirmed", exact: true });

  // The one removal is held at the rider's own address. The server takes it and answers 200; the
  // page's request is then failed, so the page never hears that answer. The page sends no body,
  // and the helper sends none on.
  mark = writes.length;
  const lostRemoval = await holdRequest(page, ctx, `${linePath}${rider.id}`, { method: "DELETE", lose: true });
  try {
    await line2Remove.click();
    assert.equal(await modalTitle(page), `Remove ${riderNaming} from this order?`);
    await answerModal(page);
    const held = await lostRemoval.arrived();
    assert.equal(held.data, null, "the held removal must carry no body");
    assert.equal(held.response.status(), 200, "the server must commit the removal whose answer is then lost");
    await lostRemoval.close();
  } finally { await lostRemoval.close(); }
  // The page cannot know the server took it, so line 2 stays on the page, marked beside its
  // Remove, and the reason is the paragraph that Remove names as its description. The Lines message holds
  // the browser's own sentence for a request that failed, which is not checked. Remove is the
  // retry, so it stays usable, and the line's boxes stay as editable as any other line's.
  await removalMark.waitFor();
  assert.equal(((await removalMark.textContent()) ?? "").trim(), REMOVAL_NOT_CONFIRMED,
    "the mark must say the removal is not confirmed");
  await waitForValue(line2Qty, "4");
  const reasonId = await line2Remove.getAttribute("aria-describedby");
  assert.ok(reasonId, "a marked line's Remove must name the paragraph that says why");
  assert.equal(((await lines.locator(`[id="${reasonId}"]`).textContent()) ?? "").trim(), LINE_2_REMOVAL_REASON,
    "the reason must be under the line");
  assert.equal(await line2Remove.isDisabled(), false, "the Remove of a marked line must stay usable: it is the retry");
  assert.equal(await line2Qty.isDisabled(), false, "a marked line's quantity must stay editable");
  assert.equal(await line2Weight.isDisabled(), false, "a marked line's weight must stay editable");
  assert.deepEqual((await readJson(page, ctx, `/api/orders/${order.id}`)).lines.map((line) => line.id), [leadLine.id],
    "the server must have removed the line whose removal the page marks not confirmed");
  // Lines counts the marked line as unsaved work, so the traveler print waits and Re-split asks
  // first. Declined, it sends nothing. Re-split is on Loads & travelers; Lines is turned back to
  // for the retry below.
  await waitForDisabled(print, true, "the traveler print must wait while a removal is not confirmed");
  assert.equal(await print.getAttribute("title"), PRINT_WAITS, "the waiting print must name the way out");
  await openOrderTab(page, LOADS);
  const resplitAskedAgain = await declineModal(page,
    () => loads.getByRole("button", { name: "Re-split", exact: true }).click(),
    "Re-split must ask first while a removal in Lines is not confirmed");
  assert.equal(resplitAskedAgain.title, RESPLIT_QUESTION, "Re-split's modal must ask its own question");
  assert.match(resplitAskedAgain.body, /^Lines has unsaved changes\. Re-split loads /,
    "Re-split's question must name the Lines section");
  assert.deepEqual(await sentSince(mark), ["DELETE"],
    "the page must have sent the lost removal once, and the declined Re-split nothing");
  await shot("removal-not-confirmed");

  // Remove again. The server no longer holds the line and answers so, which proves it gone. The
  // page then reads the order (that the section asks for it once is pinned in
  // tests/lines-section-wiring.test.ts).
  // That read, which does not list the line, is the one answer in this step that carries an order,
  // so it is what takes the row away. The Lines message then names the line as the confirm does. The row
  // going is what this step checks: the mark sits in that row's Remove cell, so it cannot outlive
  // the row on screen. That the record of marks is pruned with the line is pinned in
  // tests/lines-section-wiring.test.ts and tests/line-removals.test.ts (`removalsListed`).
  mark = writes.length;
  const refused = answerTo((res) =>
    new URL(res.url()).pathname === `${linePath}${rider.id}` && res.request().method() === "DELETE");
  const reread = answerTo((res) =>
    new URL(res.url()).pathname === `/api/orders/${order.id}` && res.request().method() === "GET");
  await openOrderTab(page, PARTS);
  await line2Remove.click();
  assert.equal(await modalTitle(page), `Remove ${riderNaming} from this order?`);
  await answerModal(page);
  const refusal = await refused;
  assert.equal(refusal.status(), 404, "a removal of a line the server no longer holds must be answered 404");
  assert.equal((await refusal.json()).error, "Order line not found");
  assert.equal((await reread).status(), 200, "the page must read the order after the removal proved the line gone");
  await line2Qty.waitFor({ state: "hidden" });
  const alreadyRemoved = `${riderNaming} had already been removed from this order.`;
  await linesMessage(page, alreadyRemoved).waitFor();
  assert.equal(((await linesMessage(page, alreadyRemoved).textContent()) ?? "").trim(), alreadyRemoved,
    "the Lines message must say the line had already been removed, and nothing else");
  await waitForDisabled(print, false, "a removal proved gone must free the traveler print");
  assert.deepEqual(await sentSince(mark), ["DELETE"], "the retry must be one more removal and nothing else");
  await shot("removal-gone-after-retry");

  // --- G. A save whose answer the page cannot read, after the server commits it (#547). ---
  // The order holds its lead line only, at 20 pieces with 15 shipped, so 22 is a quantity the
  // server takes. The one save of 22 is held at the lead line's own address. The server takes it
  // and answers 200; the page's copy is then answered 200 with that answer cut short.
  mark = writes.length;
  const unreadable = await holdRequest(page, ctx, `${linePath}${leadLine.id}`, { method: "PATCH", unreadable: true });
  let historyRead, shipmentsRead;
  try {
    await leadQty.fill("22");
    await leadQty.press("Enter");
    const held = await unreadable.arrived();
    assert.deepEqual(held.data, { qty: 22 }, "the held save must be the one the box sent");
    assert.equal(held.response.status(), 200, "the server must commit the save whose answer the page then cannot read");
    // Armed only now, with the server's answer in and the page's copy not yet answered, so that no
    // read made before this point can meet them: the Certifications section also reads the order's
    // shipments, when it mounts.
    historyRead = requestTo((req) => {
      const url = new URL(req.url());
      return url.pathname === "/api/admin/audit" && req.method() === "GET"
        && url.searchParams.get("entity") === "order" && url.searchParams.get("entityId") === order.id;
    });
    shipmentsRead = requestTo((req) =>
      new URL(req.url()).pathname === `/api/orders/${order.id}/shipments` && req.method() === "GET");
    // Answers the page's copy and waits until it has been answered.
    await unreadable.close();
  } finally { await unreadable.close(); }
  // The page is still there. Asked first, so that an answer which takes the page down fails here,
  // by name, before any wait for what the page shows.
  await assertNeverVisible(pageDown(page), "an answer the page cannot read must not take the page down", 3000);
  assert.equal(await page.getByRole("heading", { name: /^Order #\d+/ }).isVisible(), true,
    "the order must stay on screen after an answer the page cannot read");
  // History and Shipments are told, as a save that lands tells them, although nothing was applied.
  await bounded(historyRead, "the History panel must read the order's history again after an answer the page cannot read");
  await bounded(shipmentsRead, "the Shipments section must read its list again after an answer the page cannot read");
  // The box keeps 22 and reads Not saved, with the owner's sentence under the line and in
  // the Lines message, while the server holds 22.
  await notSavedMark(lines, "Lead quantity").waitFor();
  await waitForValue(leadQty, "22");
  assert.equal(await reasonAt(lines, leadQty), WRITE_ANSWER_UNREADABLE, "the owner's sentence must be under the line");
  await linesMessage(page, WRITE_ANSWER_UNREADABLE).waitFor();
  assert.equal(((await linesMessage(page, WRITE_ANSWER_UNREADABLE).textContent()) ?? "").trim(), WRITE_ANSWER_UNREADABLE,
    "the Lines message must say the owner's sentence, and nothing else");
  assert.equal((await leadOnServer()).qty, 22, "the server must hold the typed quantity under a box that reads Not saved");
  await waitForDisabled(print, true, "the traveler print must wait after a save whose answer the page cannot read");
  assert.equal(await print.getAttribute("title"), PRINT_WAITS, "the waiting print must name the way out");
  assert.deepEqual(await sentSince(mark), ['PATCH {"qty":22}'], "the page must have sent the save once");
  await shot("unreadable-answer-not-saved");

  // Enter saves the box again: one more save of 22, which the server answers in full. The box
  // reads Saved, the sentence leaves the Lines message and the print is free.
  mark = writes.length;
  answer = lineSaveAnswer();
  await leadQty.press("Enter");
  assert.equal((await answer).status(), 200, "Enter must save the box again");
  await savedMark(lines, "Lead quantity").waitFor();
  await assertNeverVisible(notSavedMark(lines, "Lead quantity"), "a save that landed must take the Not saved mark away", 500);
  await assertNeverVisible(linesMessage(page, WRITE_ANSWER_UNREADABLE), "a save that landed must take the sentence off the Lines message", 500);
  await waitForDisabled(print, false, "a save that landed must free the traveler print");
  assert.deepEqual(await sentSince(mark), ['PATCH {"qty":22}'], "Enter must send exactly one more save");
  assert.equal((await leadOnServer()).qty, 22, "the server must still hold 22");
  await shot("unreadable-answer-saved-again");

  // --- H. Refresh pressed while a quantity save is out: the page reads the order once more (#550). ---
  // The order holds its lead line only, at 22 pieces with 15 shipped, so 24, and in part I 23, are
  // quantities the server takes. The strip reads 22 already.
  //
  // Refresh order before printing shows only while a same-order scan's read of the order has
  // failed, or while the Loads editor holds loads newer than the page. So a scan's read is answered
  // here with a 503 and never reaches the server, and the route goes before anything is held.
  //
  // The scan lands on Loads & travelers (its hash opens that tab), where Refresh is; the box is on
  // Parts & containers. So the quantity is typed with that tab open, and opening Loads & travelers
  // for the click takes focus from the box: the save goes out from that blur, before the click's
  // read, as it did when the click itself took the focus.
  const search = page.getByPlaceholder("Search order, PO, part, customer", { exact: false });
  const refresh = loads.getByRole("button", { name: "Refresh order before printing", exact: true });
  const scanLine = (sentence) => loads.getByRole("status").filter({ hasText: sentence });
  const failScanRead = async () => {
    const answerUnavailable = async (route) => {
      if (route.request().method() !== "GET") { await route.continue(); return; }
      await route.fulfill({
        status: 503, contentType: "application/json", body: JSON.stringify({ error: ORDER_READ_ANSWERED_HERE }),
      });
    };
    const stopFailing = await routeRequests(page, `${ctx.baseURL}/api/orders/${order.id}`, answerUnavailable);
    try {
      const previousScan = new URL(page.url()).searchParams.get("scan");
      await search.fill(`${order.number}-1`);
      await search.press("Enter");
      await page.waitForURL((url) => url.pathname === `/orders/${order.id}` && url.searchParams.get("load") === "1"
        && url.searchParams.has("scan") && url.searchParams.get("scan") !== previousScan);
      await scanLine("Could not refresh this load. Scan again to retry.").waitFor();
    } finally { await stopFailing(); }
    await refresh.waitFor();
  };
  await failScanRead();

  // The save of 24 is held before the server sees it, so the server answers the reads of the order
  // the click makes without it. The page applies the first of those, and the save's answer, sent
  // before it, is then dropped as older.
  const heldSave = await holdRequest(page, ctx, `${linePath}${leadLine.id}`, { method: "PATCH", before: true });
  // Listening from before the click: the read that follows the save's answer can go out while the
  // hold is still handing that answer to the page.
  const refreshTraffic = orderTraffic(page, `/api/orders/${order.id}`, `${linePath}${leadLine.id}`);
  try {
    mark = writes.length;
    await openOrderTab(page, PARTS);
    await leadQty.fill("24");
    // Opening the Loads tab takes focus from the box first, so the save goes out from the blur,
    // ahead of the click's read.
    await openOrderTab(page, LOADS);
    await refresh.click();
    assert.deepEqual((await heldSave.arrived()).data, { qty: 24 }, "the held save must be the one the box sent");
    // The click reads the order through the page, and then the Loads editor reads it again. The
    // status reads so only once both have been answered: the scan status is ready only after the
    // page's read, and the failed scan read left the Loads editor no saved row to highlight until
    // its own read lands. No strip wait here: the strip read 22 before the click.
    await scanLine("Scanned Load 1 is highlighted below.").waitFor();
    assert.ok(saveBeforeRead(refreshTraffic.log),
      `the save must have gone out before the page's read of the order; heard ${JSON.stringify(refreshTraffic.log)}`);
    // Both of the click's reads have been answered and the save is still held: the read that
    // follows waits for the save to settle, so nothing more reads the order meanwhile.
    const readsWhileHeld = readsIn(refreshTraffic.log);
    await page.waitForTimeout(300);
    assert.equal(readsIn(refreshTraffic.log), readsWhileHeld,
      `the page must not read the order again while the save it overlapped is out; heard ${JSON.stringify(refreshTraffic.log)}`);
    answer = lineSaveAnswer();
    heldSave.release();
    await heldSave.close();
    assert.equal((await answer).status(), 200, "the held save must save");
    await bounded(refreshTraffic.heard(readAfterAnswer),
      "the page must read the order again after the save it overlapped was answered");
    // That read was sent after the save was answered, so it brings the saved 24. The box reads
    // Saved whether or not it comes: a save that lands marks its box even when its answer is
    // dropped. The strip, and the read itself, are what show the page took the order the server
    // holds. It was sent with no write out, so it is the last: one read after the answer.
    await waitForStrip(strip, stripAt(24));
    await page.waitForTimeout(300);
    assert.equal(readsIn(refreshTraffic.log, { afterAnswer: true }), 1,
      `the page must read the order exactly once after the save's answer; heard ${JSON.stringify(refreshTraffic.log)}`);
  } finally {
    refreshTraffic.stop();
    await heldSave.close();
  }
  await openOrderTab(page, PARTS);
  await savedMark(lines, "Lead quantity").waitFor();
  await waitForValue(leadQty, "24");
  assert.equal((await leadOnServer()).qty, 24, "the server must hold the saved quantity");
  assert.deepEqual(await sentSince(mark), ['PATCH {"qty":24}'], "the click and the read after it must send only the save");
  await shot("refresh-read-again-after-the-save");

  // --- I. The other ordering: the save's answer lands before the read's (#550, the owner's answer A). ---
  // The status reads ready again after part H, so Refresh is hidden: one more scan read fails.
  await failScanRead();
  // The save of 23 is held before the server sees it. The page's read of the order is answered by
  // the server at once, so without the save, and that answer is held on its way to the page. The
  // first read of the order after the click is the page's: the Loads editor reads only once the
  // page's read has landed.
  const laterSave = await holdRequest(page, ctx, `${linePath}${leadLine.id}`, { method: "PATCH", before: true });
  const staleRead = await holdRequest(page, ctx, `/api/orders/${order.id}`, { method: "GET" });
  const staleTraffic = orderTraffic(page, `/api/orders/${order.id}`, `${linePath}${leadLine.id}`);
  try {
    mark = writes.length;
    await openOrderTab(page, PARTS);
    await leadQty.fill("23");
    // As in part H: the save goes out from the blur the tab change makes, before the click's read.
    await openOrderTab(page, LOADS);
    await refresh.click();
    assert.deepEqual((await laterSave.arrived()).data, { qty: 23 }, "the held save must be the one the box sent");
    const served = await staleRead.arrived();
    assert.equal(served.response.status(), 200, "the server must answer the page's read of the order");
    assert.equal((await served.response.json()).lines.find((line) => line.position === 1)?.qty, 24,
      "the server must have answered the page's read before it saw the save");
    assert.ok(saveBeforeRead(staleTraffic.log),
      `the save must have gone out before the page's read of the order; heard ${JSON.stringify(staleTraffic.log)}`);
    // The save's answer lands first. Nothing newer has been applied, so the page takes it.
    answer = lineSaveAnswer();
    laterSave.release();
    await laterSave.close();
    assert.equal((await answer).status(), 200, "the held save must save");
    await waitForStrip(strip, stripAt(23));
    await openOrderTab(page, PARTS);
    await savedMark(lines, "Lead quantity").waitFor();
    await waitForValue(leadQty, "23");
    // Then the read's answer, which is newer than the save and holds 24.
    staleRead.release();
    await staleRead.close();
  } finally {
    staleTraffic.stop();
    await laterSave.close().finally(() => staleRead.close());
  }
  // Only that read's answer takes the box's Saved mark, and nothing marks the box again without a
  // save of it, so the mark going says the page has drawn the read's 24. Any 23 after this is the
  // read the page sends once more.
  await savedMark(lines, "Lead quantity").waitFor({ state: "hidden" });
  await waitForStrip(strip, stripAt(23));
  await waitForValue(leadQty, "23");
  await assertNeverVisible(savedMark(lines, "Lead quantity"),
    "a box whose save was answered before a read served without it must not read Saved again", 1000);
  assert.equal((await leadOnServer()).qty, 23, "the server must hold the saved quantity");
  assert.deepEqual(await sentSince(mark), ['PATCH {"qty":23}'], "the click and the read after it must send only the save");
  await shot("stale-read-read-again");
}
