// Shared by the five Phase 4 flows (Task 20): keys an order through the REAL /orders/new entry
// page and lands on its hub. Unlike Phase 3's order flows (which share ctx.created's single
// order), each Phase 4 flow creates its own order(s), so this lives as a lib helper rather than
// being copy-pasted five times. Deliberately thin: customer + N part lines + quantities, any
// container rows it is handed, the caller's own step before the save when it is handed one, and
// Save — the entry page's own richer behaviours (drafts, serial ranges, warnings panel) are
// order-entry-full.mjs's job to demonstrate, not this helper's.
import assert from "node:assert/strict";
import { pickCombobox } from "./ui.mjs";
import { hubTabForId, orderHubTabs } from "../../src/lib/order-hub-tabs.ts";
import { openRecordTab } from "./record-tabs.mjs";

/**
 * A leftover autosaved draft makes /orders/new open with the "Draft from MM/DD/YYYY, h:mm:ss AM — Resume /
 * Discard" banner instead of a blank form. createOrder clears the draft in the save's own
 * transaction, but the entry page's debounced autosave PUT can land AFTER the save committed
 * (typed-state written back a beat later), so a flow that keys two orders back-to-back — or any
 * flow running after another flow's order entry — can meet the banner. Discarding is always
 * right here: every Phase 4 flow wants a blank form.
 */
async function discardDraftIfOffered(page) {
  const discard = page.getByRole("button", { name: "Discard", exact: true });
  try {
    await discard.waitFor({ state: "visible", timeout: 2000 });
    await discard.click();
  } catch {
    // no banner — the normal case
  }
}

/**
 * Keys an order (customer + lines of `{ partNumber, qty }`) and returns `{ id, number }` once the
 * HUB is on screen. `expectWarnings: true` takes the save-with-warnings interstitial path (a
 * credit-hold customer's save always warns) and clicks through "Go to order".
 *
 * `containers`: rows of `{ typeId, count, pieces }`, keyed on Parts & containers after the last
 * part line. For row N: the button "Add container"; `Container N type` by `selectOption(typeId)`;
 * `Container N count` filled with `String(count)`; `Container N pieces` filled with
 * `String(pieces)` only when `pieces` is neither undefined nor null. No Tare each, Scale gross or
 * Cust Cont Id is typed.
 * `beforeSave`: awaited once, with no argument, after the rows and before the tab changes.
 *
 * Never `waitForURL` (the Phase 3 trap, spec §13): the hub heading "Order #N" can only render
 * post-navigation, so waiting for it and then reading the URL is unambiguous.
 */
export async function createOrderViaUi(page, ctx, { customerCode, lines, expectWarnings = false, containers = [], beforeSave }) {
  await page.goto(`${ctx.baseURL}/orders/new`);
  await page.getByRole("heading", { name: "New order" }).waitFor({ state: "visible" });
  await discardDraftIfOffered(page);

  await pickCombobox(page, "Customer", customerCode, new RegExp(`^${customerCode}`));
  await page.getByRole("tab", { name: "Parts & containers", exact: true }).click();
  for (const [i, line] of lines.entries()) {
    if (i > 0) await page.getByRole("button", { name: "Add part line" }).click();
    await pickCombobox(page, `Line ${i + 1} part`, line.partNumber, new RegExp(`^${line.partNumber}`));
    await page.getByLabel(`Line ${i + 1} quantity`, { exact: true }).fill(String(line.qty));
  }
  for (const [i, row] of containers.entries()) {
    await page.getByRole("button", { name: "Add container", exact: true }).click();
    await page.getByLabel(`Container ${i + 1} type`, { exact: true }).selectOption(row.typeId);
    await page.getByLabel(`Container ${i + 1} count`, { exact: true }).fill(String(row.count));
    if (row.pieces !== undefined && row.pieces !== null) {
      await page.getByLabel(`Container ${i + 1} pieces`, { exact: true }).fill(String(row.pieces));
    }
  }
  if (beforeSave) await beforeSave();
  // The coherent workspace preview is current before saving.
  await page.getByRole("tab", { name: "Process & loads", exact: true }).click();
  await page.getByText("Fully allocated · 0 pieces remaining", { exact: true }).waitFor();

  await page.getByRole("button", { name: "Save only", exact: true }).click();
  if (expectWarnings) {
    await page.getByText(/^Order #\d+ saved\.$/).waitFor({ state: "visible", timeout: 20000 });
    await page.getByRole("button", { name: "Go to order", exact: true }).click();
  }
  const hubHeading = page.getByRole("heading", { name: /^Order #\d+/ });
  await hubHeading.waitFor({ state: "visible", timeout: 20000 });
  const headingText = (await hubHeading.textContent()) ?? "";
  const match = headingText.match(/#(\d+)/);
  assert.ok(match, `Could not parse an order number out of the hub heading "${headingText}"`);
  return { id: page.url().split("/").pop(), number: Number(match[1]) };
}

/**
 * Starts a shipment on /shipping/new for `customerId` and adds each order by id, waiting for its
 * panel (the h3 link "#N") to render. Returns nothing — the caller edits the panels and saves.
 */
export async function startNewShipment(page, ctx, customerId, orders) {
  await page.goto(`${ctx.baseURL}/shipping/new`);
  await page.getByRole("heading", { name: "New shipment" }).waitFor({ state: "visible" });
  await page.getByLabel("Customer", { exact: true }).selectOption(customerId);
  // The Add order list and the order panels sit on Orders & containers (PR 4); the page is left
  // on that tab, where the callers edit the panels. The customer's own tab is Customer & route.
  await openRecordTab(page, "Orders & containers");
  for (const order of orders) {
    await page.getByLabel("Add order", { exact: true }).selectOption(order.id);
    await page.getByRole("button", { name: "Add order", exact: true }).click();
    await page.getByRole("link", { name: `#${order.number}`, exact: true }).waitFor({ state: "visible", timeout: 15000 });
  }
}

/** A stored document's row in the saved shipment's Documents table, by its Type cell ("Shipping
 *  ticket", "Bill of lading"); the row's link reads "Open PDF" (PR 4). Opens the Documents tab,
 *  so a caller that goes on to an order panel opens Orders & quantities again. */
export async function shipmentDocument(page, kind) {
  await openRecordTab(page, "Documents");
  return page.locator("tbody tr").filter({ has: page.getByRole("cell", { name: kind, exact: true }) });
}

/** The per-order panel on either shipment page, located by its h3 link text — `#N` on
 *  /shipping/new, `N-seq` (the ShipperOrder label) on /shipping/[id]. */
export function orderPanel(page, linkText) {
  return page.locator("section").filter({ has: page.getByRole("link", { name: linkText, exact: true }) });
}

/**
 * Waits for the shipment page (post-save or post-navigation) and returns
 * `{ id, shipperNumber }`. Never `waitForURL` — a `/\/shipping\/[^/?]+$/` pattern also matches
 * the literal `/shipping/new` route still on screen at the instant Save is clicked (the Phase 3
 * trap, spec §13 / task-20 brief Step 2). The "Packing list #N" heading is shipment-page-only
 * content, so waiting for it and then reading the URL is unambiguous.
 */
export async function waitForShipmentPage(page) {
  const heading = page.getByRole("heading", { name: /^Packing list #\d+/ });
  await heading.waitFor({ state: "visible", timeout: 20000 });
  const text = (await heading.textContent()) ?? "";
  const match = text.match(/Packing list #(\d+)/);
  assert.ok(match, `Could not parse a packing-list number out of "${text}"`);
  return { id: page.url().split("/").pop(), shipperNumber: Number(match[1]) };
}

/**
 * ONE order-board row, identified by its ORDER-NUMBER CELL.
 *
 * Never `page.locator("tr").filter({ has: page.getByText(String(n), { exact: true }) })` — which is
 * what all four board call sites did until #167a. That asks "does ANY cell of this row hold exactly
 * these digits", and the board prints six other bare-number columns beside the order number (PO,
 * Qty, Weight, Loads, VS #). It went red for real on 2026-08-22: `ship-partial-then-complete`'s
 * order is 100 x 10 lb + 40 x 5 lb, so its **Weight** cell reads exactly `1200`, and the moment the
 * order counter reached #1200 the filter resolved to two rows and Playwright's strict mode refused
 * both. Not a substring match — an exact match against the wrong column. Which digits are on screen
 * is ambient state; which COLUMN they sit in is not, so that is what this matches on.
 *
 * The column INDEX is read from the header rather than assumed to be the first: the board's columns
 * are user-arrangeable (a saved view reorders and hides them), so a positional guess would be one
 * more ambient assumption — the exact thing this helper exists to remove. A hidden Order # column
 * throws by name rather than silently matching nothing.
 *
 * Returns the row locator; the caller waits on it (a row that has not rendered yet is the normal
 * case immediately after a navigation).
 */
export async function boardRow(page, orderNumber) {
  // Anchored on the table that CARRIES the Order # header rather than on "the page's table"
  // (#167a fix round). `/` renders exactly one table today, so `page.locator("table thead th")`
  // was correct — and silently so: a second table on the page would have concatenated both
  // headers into one list and offset the column index, which is the same class of ambient
  // assumption this helper exists to remove. If two tables ever carry an Order # header the row
  // locator resolves across both and Playwright's strict mode says so out loud.
  const board = page.locator("table").filter({ has: page.locator("thead th", { hasText: "Order #" }) });
  const headers = board.locator("thead th");
  await headers.first().waitFor({ state: "visible", timeout: 15000 });
  // The sort indicator is part of the header's own text ("Order # ▲"), so it is stripped before
  // comparing rather than matched around.
  const labels = (await headers.allInnerTexts()).map((label) => label.replace(/[▲▼]/g, "").trim());
  const index = labels.indexOf("Order #");
  assert.ok(index >= 0, `the order board is showing no "Order #" column — headers: ${JSON.stringify(labels)}`);
  return board.locator("tbody tr").filter({
    has: page.locator(`td:nth-child(${index + 1})`, { hasText: new RegExp(`^\\s*${orderNumber}\\s*$`) }),
  });
}

// ---- the order hub's tabs (PR 2 of the UX redesign; src/lib/order-hub-tabs.ts) ----
//
// Every hub section stays mounted, but the inactive tabs' panels are hidden, so a locator on a
// section waits forever unless its tab is open first. A flow reaches a hub section through these
// helpers, never through a bare section locator it waits on itself: `hubSection` opens the tab the
// heading lives on and returns the section, `hubAnchor` does the same for an element id. The
// heading → tab map below names the tab by its KEY; the labels come from the app's own leaf, so
// a renamed tab moves here by itself.

/** Which tab each hub section heading sits on. "Record history" is the History panel's heading. */
const HEADING_TAB = {
  Overview: "overview", Notes: "overview",
  Lines: "parts", Containers: "parts", Serials: "parts", Charges: "parts",
  Process: "process",
  Loads: "loads", Documents: "loads",
  Shipments: "shipping", Certifications: "shipping",
  Invoices: "billing",
  Attachments: "files", "Record history": "files",
};

/** A hub tab's label by its key, from the app's leaf. */
export function hubTabLabel(key) {
  const tab = orderHubTabs([]).find((t) => t.key === key);
  assert.ok(tab, `no hub tab with key ${key}`);
  return tab.label;
}

/** Opens the hub tab named `label` unless it is already selected, and waits for its panel
 *  (`openRecordTab`, shared with every record page's tabs since PR 3). */
export async function openOrderTab(page, label) {
  await openRecordTab(page, label);
}

/** Opens the tab the hub section headed `heading` sits on and returns that section. */
export async function hubSection(page, heading) {
  const key = HEADING_TAB[heading];
  assert.ok(key, `no hub tab holds a section headed ${heading}`);
  await openOrderTab(page, hubTabLabel(key));
  return page.locator("section").filter({ has: page.getByRole("heading", { name: heading, exact: true }) });
}

/** Opens the tab the hub element `id` sits on (a `load-N` row's included) and returns it. */
export async function hubAnchor(page, id) {
  const key = hubTabForId(id);
  assert.ok(key, `no hub tab holds #${id}`);
  await openOrderTab(page, hubTabLabel(key));
  return page.locator(`#${id}`);
}
