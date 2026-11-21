// Keyboard regression for the five admin master-list selectors. Templates are exercised in
// templates-admin.mjs because that flow owns its dynamically created template row; this read-only
// flow uses only fixture rows that already exist before the browser opens.
import assert from "node:assert/strict";
import { openRecordTab } from "../lib/record-tabs.mjs";
import { waitForFocused } from "../lib/ui.mjs";

async function activateSelector(page, selector, outcome, description) {
  assert.equal(await selector.count(), 1, `${description} must expose one native selector button`);
  await selector.focus();
  await page.keyboard.press("Enter");
  await outcome.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await selector.getAttribute("aria-current"), "true",
    `${description} must expose current state after keyboard selection`);
}

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;

  await page.goto(`${ctx.baseURL}/admin/roles`);
  await page.getByRole("heading", { name: "Roles", exact: true }).waitFor({ state: "visible" });
  // PR 12: the Roles tab's table, whose row opens Area permissions; delete is the title row's.
  const roleRow = page.getByRole("row").filter({ hasText: fixtures.adminRoleName });
  await roleRow.waitFor({ state: "visible" });
  const roleSelector = roleRow.getByRole("button", { name: fixtures.adminRoleName, exact: true });
  assert.equal(await roleRow.getByRole("button").count(), 1, "the row's one control is its selector");
  await roleSelector.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: `${fixtures.adminRoleName} — permissions`, exact: true }).waitFor({ state: "visible", timeout: 15000 });
  await openRecordTab(page, "Roles");
  assert.equal(await roleSelector.getAttribute("aria-current"), "true", "the fixture role must expose current state");

  await page.goto(`${ctx.baseURL}/admin/surcharges`);
  await page.getByRole("heading", { name: "Surcharges", exact: true }).waitFor({ state: "visible" });
  // PR 11: the list's table, whose row opens Selected surcharge; the row sits on the first tab.
  const surchargeRow = page.getByRole("row").filter({ hasText: fixtures.invSurchargeName });
  await surchargeRow.waitFor({ state: "visible" });
  const surchargeSelector = surchargeRow.getByRole("button", { name: fixtures.invSurchargeName, exact: true });
  const surchargeHeading = page.getByRole("heading", { name: fixtures.invSurchargeName, exact: true });
  await surchargeSelector.focus();
  await page.keyboard.press("Enter");
  await surchargeHeading.waitFor({ state: "visible", timeout: 15000 });
  await openRecordTab(page, "Surcharge list");
  assert.equal(await surchargeSelector.getAttribute("aria-current"), "true", "the fixture surcharge must expose current state");
  await page.getByRole("button", { name: "Add surcharge", exact: true }).click();
  await waitForFocused(page.getByPlaceholder("Name", { exact: true }), "the Add surcharge row's Name box");

  await page.goto(`${ctx.baseURL}/admin/step-codes`);
  await page.getByRole("heading", { name: "Process step codes", exact: true }).waitFor({ state: "visible" });
  // PR 9: the Codes tab's table, the row's one selector its Code cell's button. A row opens Selected
  // code, and opens it again after going back to Codes.
  const stepRow = page.getByRole("row").filter({ hasText: fixtures.stepCodeA.code });
  await stepRow.waitFor({ state: "visible" });
  const stepSelector = stepRow.getByRole("button", { name: fixtures.stepCodeA.code, exact: true });
  const stepHeading = page.getByRole("heading", { name: `${fixtures.stepCodeA.code} — ${fixtures.stepCodeA.name}`, exact: true });
  // With no code picked the header's Add parameter suggestion is closed, and says why.
  const addSuggestion = page.getByRole("button", { name: "Add parameter suggestion", exact: true });
  assert.equal(await addSuggestion.isDisabled(), true, "Add parameter suggestion waits for a code");
  assert.equal(await addSuggestion.getAttribute("title"), "Select a process step code first.");
  await stepSelector.focus();
  await page.keyboard.press("Enter");
  await stepHeading.waitFor({ state: "visible", timeout: 15000 });
  await openRecordTab(page, "Codes"); // the row sits on Codes, which the selection left
  assert.equal(await stepSelector.getAttribute("aria-current"), "true", "the fixture step code must expose current state");
  await stepSelector.click();
  await stepHeading.waitFor({ state: "visible", timeout: 15000 });
  // Each header button opens its panel, hidden when it was clicked, and the cursor lands in its row.
  await openRecordTab(page, "Codes");
  await addSuggestion.click();
  await waitForFocused(page.getByPlaceholder("Parameter name", { exact: true }), "the Add parameter suggestion row's name box");
  await page.getByRole("button", { name: "Add step code", exact: true }).click();
  await waitForFocused(page.getByPlaceholder("Code", { exact: true }), "the Add step code row's Code box");

  await page.goto(`${ctx.baseURL}/admin/reference`);
  await page.getByRole("heading", { name: "Pick lists", exact: true }).waitFor({ state: "visible" });
  await page.getByText("Ending statements", { exact: true }).waitFor({ state: "visible" });
  const referenceSelector = page.getByRole("button", { name: "Ending statements", exact: true });
  await activateSelector(page, referenceSelector, page.getByPlaceholder("Text"), "Ending statements");
  // A list change remounts the table around the selector (PR 11's review): the cursor stays on it.
  await waitForFocused(referenceSelector, "the Ending statements selector, after choosing it from the keyboard");

  await shot("admin-selectors-keyboard");
}
