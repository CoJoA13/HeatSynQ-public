// The Parts list's helper (PR 9 of the UX redesign; src/lib/part-list.ts). The list's two views are
// ListTabs, a group named "Part views" of pressed buttons over the Show inactive state. The part
// page's tabs are opened through `openRecordTab` (e2e/lib/record-tabs.mjs) by the labels
// src/lib/part-tabs.ts gives them. Swept suite source: no routing, no raw requests, assertions
// through node:assert.
import assert from "node:assert/strict";

const VIEWS = ["Active parts", "Include inactive"];

/** Opens the parts list's view named `label` unless it is already lit. */
export async function openPartsView(page, label) {
  assert.ok(VIEWS.includes(label), `no parts view is named ${JSON.stringify(label)}`);
  const pill = page.getByRole("group", { name: "Part views", exact: true }).getByRole("button", { name: label, exact: true });
  await pill.waitFor({ state: "visible", timeout: 15000 });
  if ((await pill.getAttribute("aria-pressed")) !== "true") await pill.click();
  await page.getByRole("heading", { name: "Parts", exact: true }).waitFor({ state: "visible", timeout: 15000 });
}
