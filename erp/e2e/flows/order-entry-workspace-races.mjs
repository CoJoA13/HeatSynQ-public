import assert from "node:assert/strict";
import { entryFixture, startEntry, entryTab, waitPlan, saveEntry, readJson, mutate, ownedOrders, holdRequest, loadsOnly } from "../lib/order-entry-workspace.mjs";
import { pickCombobox, waitForValue, assertNeverVisible } from "../lib/ui.mjs";
import { login } from "../lib/auth.mjs";
import { rolePermissions, setRolePermissions } from "../lib/roles.mjs";
import { saveProcessViaApi } from "../lib/process-document.mjs";
import { routeRequests } from "../route-keep-alive.mjs";

export async function run(page, shot, ctx) {
  const part = await entryFixture(page, ctx, "E2E-ENTRY-RACES");
  const other = await entryFixture(page, ctx, "E2E-ENTRY-OTHER", { loadQty: 10 });
  const before = await ownedOrders(page, ctx);
  await startEntry(page, ctx, part, 30);
  await entryTab(page, "Process & loads");
  await waitPlan(page, 2);
  await page.getByRole("button", { name: "Adjust for this order", exact: true }).click();
  await page.getByLabel("Pieces per load", { exact: true }).fill("12");
  await waitPlan(page, 3);
  await page.locator("#entry-traveler-selection").selectOption("loads");
  await page.getByLabel("Print load 2", { exact: true }).uncheck();
  const delayed = await holdRequest(page, ctx, "/api/orders/preview");
  try {
    await entryTab(page, "Parts & containers");
    await page.getByLabel("Line 1 quantity", { exact: true }).fill("31");
    const stale = await delayed.arrived();
    assert.equal(stale.response.status(), 200);
    assert.equal(stale.data.lines[0].partId, part.id);
    await pickCombobox(page, "Line 1 part", other.partNumber, new RegExp(`^${other.partNumber}(?:\\s|$)`));
    await entryTab(page, "Process & loads");
    await waitPlan(page, 4);
    await delayed.close();
    await page.getByText(`Fictional ${other.partNumber}: verify this part's traveler settings.`, { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Adjust for this order", exact: true }).isEnabled(), true, "Lead change resets the order adjustment");
    await waitForValue(page.locator("#entry-traveler-selection"), "all");
    await assertNeverVisible(page.getByText(`Fictional ${part.partNumber}: verify this part's traveler settings.`, { exact: true }), "Old preview cannot replace changed lead", 500);
  } finally { await delayed.close(); }
  assert.equal((await readJson(page, ctx, `/api/parts/${part.id}`)).loadQty, 15, "Adjustment never changes saved part defaults");
  assert.equal((await ownedOrders(page, ctx)).length, before.length, "Preview and tab changes create no orders");

  // A transport failure makes the plan unavailable; explicit Refresh restores it.
  const previewUrl = `${ctx.baseURL}/api/orders/preview`;
  const failure = route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Fictional preview unavailable" }) });
  const stopFailure = await routeRequests(page, previewUrl, failure);
  try {
    await page.getByRole("button", { name: "Refresh plan", exact: true }).click();
    await page.getByText("Fictional preview unavailable", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Save & Print", exact: true }).isDisabled(), true);
    await shot("preview-unavailable");
  } finally { await stopFailure(); }
  await page.getByRole("button", { name: "Refresh plan", exact: true }).click();
  await waitPlan(page, 4);

  // Both stale causes are real server mutations; 412 must not automatically POST again.
  let creates = 0;
  const observe = request => { if (new URL(request.url()).pathname === "/api/orders" && request.method() === "POST") creates++; };
  page.on("request", observe);
  try {
    await mutate(page, ctx, `/api/parts/${other.id}`, { loadQty: 8 }, "PATCH");
    const capConflict = page.waitForResponse(r => new URL(r.url()).pathname === "/api/orders" && r.request().method() === "POST");
    await page.getByRole("button", { name: "Save only", exact: true }).click();
    assert.equal((await capConflict).status(), 412);
    await page.getByText(/Review the refreshed process and load plan, then click Save only again/).waitFor();
    await waitPlan(page, 4);
    assert.equal(creates, 1);
    assert.equal((await ownedOrders(page, ctx)).length, before.length);
    const revision = await readJson(page, ctx, `/api/parts/${other.id}/process/revisions/1`);
    await saveProcessViaApi(page, ctx, other.id, steps => steps.map(step => step.stepId === revision.steps[0].id
      ? { ...step, instruction: "Changed instruction without a revision-number change" } : step));
    assert.equal((await readJson(page, ctx, `/api/parts/${other.id}/process/revisions/1`)).revisionNumber, revision.revisionNumber);
    const revisionConflict = page.waitForResponse(r => new URL(r.url()).pathname === "/api/orders" && r.request().method() === "POST");
    await page.getByRole("button", { name: "Save only", exact: true }).click();
    assert.equal((await revisionConflict).status(), 412);
    await page.getByText("Changed instruction without a revision-number change", { exact: true }).waitFor();
    assert.equal(creates, 2);
    assert.equal((await ownedOrders(page, ctx)).length, before.length);
    await shot("same-revision-conflict-retained-entry");
    const saved = await saveEntry(page, ctx);
    assert.deepEqual(loadsOnly(saved.order.loads), [
      { loadNumber: 1, qty: 8, weight: 1016 }, { loadNumber: 2, qty: 8, weight: 1016 },
      { loadNumber: 3, qty: 8, weight: 1016 }, { loadNumber: 4, qty: 7, weight: 889 },
    ]);
    assert.equal(creates, 3, "Only explicit review clicks create attempts");
    assert.equal((await ownedOrders(page, ctx)).length, before.length + 1);
  } finally { page.off("request", observe); }

  // A real role without process viewing still has valid planning and creation.
  const f = ctx.fixtures;
  const priorPermissions = await rolePermissions(page, ctx, f.restrictedRoleId);
  try {
    // Inside the try: a narrowing whose answer is lost may still have committed (#321).
    await setRolePermissions(page, ctx, f.restrictedRoleId, ["customers.view", "parts.view", "orders.view", "orders.create"]);
    await login(page, ctx.baseURL, f.restrictedUsername, f.restrictedPassword);
    const plan = page.waitForResponse(r => new URL(r.url()).pathname === "/api/orders/preview" && r.request().method() === "POST" && r.ok());
    await startEntry(page, ctx, part, 30);
    await entryTab(page, "Process & loads");
    const body = await (await plan).json();
    assert.equal(Object.hasOwn(body, "process"), false, "Preview must omit restricted process content entirely");
    await page.getByText(/Process content unavailable: requires processes.view/).waitFor();
    await assertNeverVisible(page.getByText(`Fictional ${part.partNumber}: verify this part's traveler settings.`, { exact: true }));
    await waitPlan(page, 2);
    const saved = await saveEntry(page, ctx);
    assert.equal(saved.order.loads.length, 2);
    await shot("create-without-process-view");
  } finally {
    await login(page, ctx.baseURL, f.adminUsername, f.adminPassword);
    await setRolePermissions(page, ctx, f.restrictedRoleId, priorPermissions);
  }
}
