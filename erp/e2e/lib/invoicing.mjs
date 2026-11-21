// The Invoicing pages' helpers (PR 6 of the UX redesign; src/lib/invoicing-list.ts,
// src/lib/invoice-tabs.ts). The list's four views are ListTabs, a group named "Invoicing views" of
// pressed buttons: Ready to invoice draws the candidates table alone, the other three the
// register, so a flow opens the view it reads before it reads it. On the invoice page the seven
// totals and the totals message are the At a glance card's rows, Recalculate lines, Create credit
// and Unlock are More actions items (hidden in a closed menu until it is opened, so a flow reads
// one with `menuItem` and chooses one with `chooseMenuItem`), and Finalize and Print are header
// buttons. Swept suite source: no routing, no raw requests, assertions through node:assert.
import assert from "node:assert/strict";

/** The section heading each view shows: the candidates, or the register. */
const VIEW_HEADINGS = {
  "Ready to invoice": "Ready to invoice", Drafts: "Invoices & credits", "To print": "Invoices & credits", Register: "Invoices & credits",
};

/** Opens the Invoicing view named `label` unless it is already lit, and waits for its heading.
 *  Drafts, To print and Register share the register's heading, so a switch between those three
 *  waits on the pill alone; a flow that reads one of them after another waits on its rows. */
export async function openInvoicingView(page, label) {
  const heading = VIEW_HEADINGS[label];
  assert.ok(heading, `no Invoicing view is named ${JSON.stringify(label)}`);
  const pill = page.getByRole("group", { name: "Invoicing views", exact: true }).getByRole("button", { name: label, exact: true });
  await pill.waitFor({ state: "visible", timeout: 15000 });
  if ((await pill.getAttribute("aria-pressed")) !== "true") await pill.click();
  await page.getByRole("heading", { name: heading, exact: true }).waitFor({ state: "visible", timeout: 15000 });
}

/** The register's section, "Invoices & credits", on any of its three views. */
export function invoicesSection(page) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: "Invoices & credits", exact: true }) });
}

/** The At a glance card's value under the row labelled `label` ("Invoice total", "Status"). */
export function glanceValue(page, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.getByRole("region", { name: "At a glance", exact: true })
    .locator("dl > div").filter({ has: page.locator("dt", { hasText: new RegExp(`^${escaped}$`) }) })
    .locator("dd");
}

/** The At a glance card itself, for its messages. */
export function glanceCard(page) {
  return page.getByRole("region", { name: "At a glance", exact: true });
}

/** A More actions item by name, found while the menu is closed too, for its disabled state. */
export function menuItem(page, name) {
  return page.getByRole("menuitem", { name, exact: true, includeHidden: true });
}

/** Opens More actions and chooses the item named `name`. */
export async function chooseMenuItem(page, name) {
  await page.locator("summary", { hasText: "More actions" }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}
