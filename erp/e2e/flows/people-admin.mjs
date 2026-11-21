// Flow: Users and Roles in their tabs (the UX redesign PR 12, owner 2026-11-02 on #827). No other
// flow drives either page's controls. It creates one user and one role, both reaped by exact name
// (`peopleUsername`, `peopleRoleName`), and proves what vitest cannot render: a row opening its tab,
// Display name's blur-save and refusal, Set password's dialog staying open on a refusal, a tick on
// each permission tab, and Delete unused role through the reason dialog.
import assert from "node:assert/strict";
import { fillPasswordModal, modalTitle, answerModal } from "../lib/modal.mjs";
import { openRecordTab } from "../lib/record-tabs.mjs";
import { waitForFocused } from "../lib/ui.mjs";

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;
  const username = fixtures.peopleUsername;
  const roleName = fixtures.peopleRoleName;

  // --- 1. Add user takes the cursor to the form, and the new row reads the list's five columns. ---
  await page.goto(`${ctx.baseURL}/admin/users`);
  await page.getByRole("heading", { name: "Users", exact: true }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Add user", exact: true }).click();
  const usernameBox = page.getByPlaceholder("Username", { exact: true });
  await waitForFocused(usernameBox, "the Add user form's Username box");
  await usernameBox.fill(username);
  await page.getByPlaceholder("Display name", { exact: true }).fill("E2E Person");
  await page.getByPlaceholder("Password", { exact: true }).fill("e2e-people-pass-1");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const row = page.getByRole("row").filter({ hasText: username });
  await row.waitFor({ state: "visible" });
  assert.equal((await row.getByRole("cell").allTextContents()).join("|"), `${username}|E2E Person|—|Yes|Not set`);
  assert.equal(await row.locator("input, select").count(), 0, "the list holds no box");
  await shot("users-list");

  // --- 2. The row opens Selected user. ---
  await row.getByRole("button", { name: username, exact: true }).click();
  await page.getByRole("heading", { name: `${username} — E2E Person`, exact: true }).waitFor({ state: "visible" });

  // --- 3. Display name refuses a blank in its panel, keeps it out of the store, and saves a name. ---
  const nameBox = page.getByLabel(`Display name for ${username}`, { exact: true });
  await nameBox.fill("  ");
  await nameBox.blur();
  await page.getByText("Display name cannot be blank.", { exact: true }).waitFor({ state: "visible" });
  await nameBox.fill("E2E Person Two");
  await nameBox.blur();
  await page.getByRole("heading", { name: `${username} — E2E Person Two`, exact: true }).waitFor({ state: "visible" });
  assert.equal(await page.getByText("Display name cannot be blank.", { exact: true }).count(), 0, "a landed save clears the refusal");

  // --- 4. Set password stays open on a refusal, in the server's sentence, then lands. ---
  await page.getByRole("button", { name: "Set password", exact: true }).click();
  assert.equal(await modalTitle(page), `Set password for ${username}`);
  await fillPasswordModal(page, "short");
  const refusal = page.locator("dialog[open]").getByRole("alert");
  await refusal.waitFor({ state: "visible" });
  assert.match((await refusal.textContent()) ?? "", /password/i);
  // The button that was clicked is closed during the send, so the cursor goes back to the box.
  await waitForFocused(page.locator("dialog[open]").getByLabel("New password", { exact: true }), "Set password's box after a refusal");
  await shot("users-set-password");
  await fillPasswordModal(page, "e2e-people-pass-2");
  await page.locator("dialog[open]").waitFor({ state: "hidden" });

  // --- 5. Active saves on click and the list reads it. ---
  await page.getByLabel(`Active for ${username}`, { exact: true }).click();
  await openRecordTab(page, "User list");
  await row.getByRole("cell", { name: "No", exact: true }).waitFor({ state: "visible" });

  // --- 6. Add role takes the cursor to its row; a row opens Area permissions. ---
  await page.goto(`${ctx.baseURL}/admin/roles`);
  await page.getByRole("heading", { name: "Roles", exact: true }).waitFor({ state: "visible" });
  const deleteRole = page.getByRole("button", { name: "Delete unused role", exact: true });
  // The title follows the page's permission read, so it is waited on rather than read at once.
  await page.locator('button[title="Select a role first."]').waitFor({ state: "visible" });
  assert.equal(await deleteRole.isDisabled(), true, "Delete unused role waits for a role");
  await page.getByRole("button", { name: "Add role", exact: true }).click();
  const roleBox = page.getByPlaceholder("New role name", { exact: true });
  await waitForFocused(roleBox, "the Add role row's name box");
  await roleBox.fill(roleName);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const roleRow = page.getByRole("row").filter({ hasText: roleName });
  await roleRow.waitFor({ state: "visible" });
  await roleRow.getByRole("button", { name: roleName, exact: true }).click();
  await page.getByRole("heading", { name: `${roleName} — permissions`, exact: true }).waitFor({ state: "visible" });

  // --- 7. A tick on each permission tab saves on its own, and both survive a reload of the role. ---
  // A tick shows once its PUT and the read after it land, so each waits on the box being checked.
  const viewOrders = page.getByLabel("orders view", { exact: true });
  await viewOrders.click();
  await page.locator('input[aria-label="orders view"]:checked').waitFor({ state: "visible" });
  await openRecordTab(page, "Special actions");
  await page.getByRole("heading", { name: `${roleName} — special actions`, exact: true }).waitFor({ state: "visible" });
  await page.getByLabel("manage users", { exact: true }).click();
  await page.locator('input[aria-label="manage users"]:checked').waitFor({ state: "visible" });
  await shot("roles-special-actions");
  await page.goto(`${ctx.baseURL}/admin/roles`);
  await roleRow.getByRole("button", { name: roleName, exact: true }).click();
  await page.getByRole("heading", { name: `${roleName} — permissions`, exact: true }).waitFor({ state: "visible" });
  assert.equal(await viewOrders.isChecked(), true, "the area tick was stored");
  await openRecordTab(page, "Special actions");
  assert.equal(await page.getByLabel("manage users", { exact: true }).isChecked(), true, "the special tick was stored");

  // --- 8. Delete unused role asks for a reason, a blank one held, and the row goes. ---
  await deleteRole.click();
  assert.equal(await modalTitle(page), `Delete role "${roleName}"?`);
  await page.locator("dialog[open]").getByRole("button", { name: "Continue", exact: true }).click();
  await page.locator("dialog[open]").getByRole("alert").waitFor({ state: "visible" });
  await answerModal(page, { reason: "people-admin flow" });
  await openRecordTab(page, "Roles");
  await roleRow.waitFor({ state: "hidden" });
}
