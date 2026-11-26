// Ruling R20 (#683): a saved view the board no longer matches is named "(changed)" in the View
// select, and Update view writes the on-screen arrangement into it. Saves a view, changes one
// filter, sees the mark, updates, reloads and picks the view again to find the filter kept. Delete
// view asks through the one modal (ruling 5): Cancel keeps the view, the confirm deletes it. A view
// a run leaves behind belongs to the e2e admin user and is reaped with that user.
import assert from "node:assert/strict";
import { answerModal, modalTitle } from "../lib/modal.mjs";
import { assertNeverVisible } from "../lib/ui.mjs";

export async function run(page, shot, ctx) {
  await page.goto(`${ctx.baseURL}/`);
  await page.getByRole("heading", { name: "Orders" }).waitFor({ state: "visible" });
  const name = `E2E view ${Date.now()}`;
  // The label's text includes its options' text, so an exact label lookup never matches it.
  const select = page.locator("label").filter({ hasText: "View:" }).locator("select");
  const checked = () => select.locator("option:checked").textContent();
  // A response the flow awaited lands before React has applied it (seen on CI: the select still
  // read "Default board" right after the POST answered), so each reading waits for the option
  // it expects to be the checked one, and only then reads its exact text.
  // An option inside a select is never "visible" to Playwright, so the wait is for attachment.
  const settled = (text, marked) => select.locator("option:checked", { hasText: text, ...(marked ? {} : { hasNotText: "(changed)" }) }).waitFor({ state: "attached" });

  // #1057 (owner ruling 2026-11-26): with no default saved view the board opens on Open orders.
  // The rest of this flow starts from no status box, as it did before, so it shows All orders first.
  const openPill = page.getByRole("button", { name: "Open orders", exact: true });
  await page.getByRole("checkbox", { name: "Open", exact: true, checked: true }).waitFor();
  assert.equal(await openPill.getAttribute("aria-pressed"), "true", "#1057: the board opens on Open orders");
  assert.equal(await select.locator("option:checked").textContent(), "Default board",
    "#1057: Open orders is the Default board, with no saved view picked");
  await page.getByRole("button", { name: "All orders", exact: true }).click();
  await page.getByRole("checkbox", { name: "Open", exact: true, checked: false }).waitFor();

  // Save the board as it stands under a name; the select then shows it, unmarked.
  const created = page.waitForResponse((res) =>
    new URL(res.url()).pathname === "/api/saved-views" && res.request().method() === "POST" && res.ok());
  await page.getByRole("button", { name: "Save view", exact: true }).click();
  await page.getByPlaceholder("View name").fill(name);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await created;
  await settled(name, false);
  assert.equal((await checked())?.trim(), name, "the saved view is selected after Save view");

  // Change one filter: the mark appears, and goes once Update view has written the arrangement.
  const includeVoided = page.getByLabel("Include voided", { exact: true });
  await includeVoided.check();
  await settled("(changed)", true);
  assert.equal((await checked())?.trim(), `${name} (changed)`, "a changed arrangement marks the selected view");
  await shot("view-changed");
  const updated = page.waitForResponse((res) =>
    /\/api\/saved-views\/[^/]+$/.test(new URL(res.url()).pathname) && res.request().method() === "PATCH" && res.ok());
  await page.getByRole("button", { name: "Update view", exact: true }).click();
  await updated;
  await settled(name, false);
  assert.equal((await checked())?.trim(), name, "Update view clears the mark");
  await assertNeverVisible(page.getByText("(changed)"), "the mark must stay gone after Update view", 300);

  // The stored view carries the change: reload, pick it, and the filter is set.
  await page.reload();
  await page.getByRole("heading", { name: "Orders" }).waitFor({ state: "visible" });
  const option = select.locator("option", { hasText: name });
  await option.waitFor({ state: "attached" });
  await select.selectOption({ label: name });
  await page.getByRole("checkbox", { name: "Include voided", exact: true, checked: true }).waitFor();
  assert.equal(await page.getByLabel("Include voided", { exact: true }).isChecked(), true, "the updated view applies its filter");
  await settled(name, false);
  assert.equal((await checked())?.trim(), name, "a view just applied is not marked changed");
  await shot("view-updated");

  // PR 2 (spec §4.5): the Order views presets are settings of the status boxes alone. Include
  // voided is the explicit filter it is (PR 3, owner 2026-10-31): the view's voided filter leaves
  // "All orders" lit, Open orders sets the three open statuses and leaves the box as it is, marking
  // the view changed; All orders clears every status box.
  const preset = (label) => page.getByRole("button", { name: label, exact: true });
  const pressed = async (label) => preset(label).getAttribute("aria-pressed");
  assert.equal(await pressed("All orders"), "true", "Include voided on, no status box: All orders is lit");
  assert.equal(await pressed("Open orders"), "false", "Include voided on, no status box: Open orders is not");
  await preset("Open orders").click();
  await page.getByRole("checkbox", { name: "Open", exact: true, checked: true }).waitFor();
  for (const status of ["Partially shipped", "Reopened"]) {
    assert.equal(await page.getByLabel(status, { exact: true }).isChecked(), true, `Open orders checks ${status}`);
  }
  for (const status of ["Shipped", "Invoiced"]) {
    assert.equal(await page.getByLabel(status, { exact: true }).isChecked(), false, `Open orders leaves ${status} unchecked`);
  }
  assert.equal(await includeVoided.isChecked(), true, "Open orders leaves Include voided as it was");
  assert.equal(await pressed("Open orders"), "true", "the preset the filters equal is lit");
  await settled("(changed)", true);
  await preset("All orders").click();
  await page.getByRole("checkbox", { name: "Open", exact: true, checked: false }).waitFor();
  for (const status of ["Partially shipped", "Reopened", "Shipped", "Invoiced"]) {
    assert.equal(await page.getByLabel(status, { exact: true }).isChecked(), false, `All orders unchecks ${status}`);
  }
  assert.equal(await pressed("All orders"), "true", "All orders is lit with no status predicate");
  await includeVoided.check();
  await page.getByRole("checkbox", { name: "Include voided", exact: true, checked: true }).waitFor();
  assert.equal(await pressed("All orders"), "true", "a voided edit keeps the preset lit");
  await shot("view-presets");

  // Delete view (ruling 5). The sentence is the title; Cancel sends nothing and keeps the view.
  const deleteView = page.getByRole("button", { name: "Delete view", exact: true });
  await deleteView.click();
  assert.equal(await modalTitle(page), `Delete saved view "${name}"?`);
  await answerModal(page, { confirm: false });
  assert.equal(await option.count(), 1, "a cancelled Delete view must keep the view");
  const deleted = page.waitForResponse((res) =>
    /\/api\/saved-views\/[^/]+$/.test(new URL(res.url()).pathname) && res.request().method() === "DELETE" && res.ok());
  await deleteView.click();
  await answerModal(page);
  await deleted;
  await option.waitFor({ state: "detached" });
}
