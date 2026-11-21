// The Customers list's helper (PR 8 of the UX redesign; src/lib/customer-list.ts). The list's two
// views are ListTabs, a group named "Customer views" of pressed buttons over the Show inactive
// state. The customer page's tabs are opened through `openRecordTab` (e2e/lib/record-tabs.mjs) by
// the labels src/lib/customer-tabs.ts gives them. Swept suite source: no routing, no raw requests,
// assertions through node:assert.
import assert from "node:assert/strict";

const VIEWS = ["Active customers", "Include inactive"];

/** Opens the customers list's view named `label` unless it is already lit. */
export async function openCustomersView(page, label) {
  assert.ok(VIEWS.includes(label), `no customers view is named ${JSON.stringify(label)}`);
  const pill = page.getByRole("group", { name: "Customer views", exact: true }).getByRole("button", { name: label, exact: true });
  await pill.waitFor({ state: "visible", timeout: 15000 });
  if ((await pill.getAttribute("aria-pressed")) !== "true") await pill.click();
  await page.getByRole("heading", { name: "Customers", exact: true }).waitFor({ state: "visible", timeout: 15000 });
}
