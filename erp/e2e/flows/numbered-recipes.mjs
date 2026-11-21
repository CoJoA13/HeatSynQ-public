import assert from "node:assert/strict";
import { login } from "../lib/auth.mjs";
import { rolePermissions, setRolePermissions } from "../lib/roles.mjs";
import { createOrderViaUi, hubSection } from "../lib/orders.mjs";
import { assertNeverVisible, waitForValue, fillReliable, waitForProcessSaveSettled } from "../lib/ui.mjs";
import { newProcessStep, saveProcessViaApi } from "../lib/process-document.mjs";
import { routeRequests } from "../route-keep-alive.mjs";
import { openRecordTab } from "../lib/record-tabs.mjs";

const section = page => page.locator("section").filter({ has: page.getByRole("heading", { name: "Process steps", exact: true }) });
// The hub's Process section sits on its Process tab (PR 2), which `hubSection` opens first.
const process = page => hubSection(page, "Process");

async function bounded(promise, label) {
  let timer;
  try {
    const result = await Promise.race([promise.then(value => ({ value })),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 10000); })]);
    assert.ok(result, label);
    return result.value;
  } finally { clearTimeout(timer); }
}

// Forward this one real UI request through the harness's counted transport. The
// browser's response alone is controlled; the saved record is never fabricated.
async function controlledRecipeSave(page, ctx, partId, recipeNumber, during, after, loseResponse = false) {
  const url = `${ctx.baseURL}/api/parts/${partId}/process/recipe-number`;
  let release, ready, finished, started = false;
  const held = new Promise(resolve => { release = resolve; });
  const committed = new Promise(resolve => { ready = resolve; });
  const completed = new Promise(resolve => { finished = resolve; });
  const handler = async route => {
    if (route.request().method() !== "PATCH") { await route.continue(); return; }
    try {
      assert.equal(started, false, "Exactly one recipe submission may be intercepted");
      started = true;
      const data = route.request().postDataJSON();
      assert.equal(data.recipeNumber, recipeNumber);
      const response = await ctx.apiMutate(page, url, { method: "PATCH", data });
      assert.equal(response.status(), 200, "The real recipe save must commit before controlling its response");
      assert.equal((await response.json()).recipeNumber, recipeNumber);
      ready({ ok: true });
      await held;
      if (loseResponse) await route.abort("failed");
      else await route.fulfill({ response });
      finished({ ok: true });
    } catch (error) {
      ready({ ok: false, error });
      await route.abort().catch(() => {});
      finished({ ok: false, error });
    }
  };
  const stopHandler = await routeRequests(page, url, handler);
  try {
    await page.getByRole("button", { name: "Save recipe", exact: true }).click();
    const result = await bounded(committed, "The intercepted recipe request must reach a committed result");
    assert.equal(result.ok, true, String(result.error));
    await during();
    release();
    const completion = await bounded(completed, "The controlled recipe response must finish");
    assert.equal(completion.ok, true, String(completion.error));
    await stopHandler();
    await after();
  } finally {
    release();
    await stopHandler();
    if (started) await bounded(completed, "The intercepted route must drain before cleanup");
  }
}

// Two exact owned part numbers are also known to db-fixtures.ts's normal and interrupted
// run cleanup. All orders belong to the harness's owned order customer.
export async function run(page, shot, ctx) {
  const f = ctx.fixtures;
  async function mutate(path, data, method = "POST") {
    const res = await ctx.apiMutate(page, `${ctx.baseURL}${path}`, { method, data });
    assert.equal(res.ok(), true, `${method} ${path}: ${res.status()} ${await res.text()}`);
    return res.json();
  }
  async function savedRevision(partId, revisionNumber = 2) {
    const res = await page.request.get(`${ctx.baseURL}/api/parts/${partId}/process/revisions/${revisionNumber}`, { maxRetries: 1 });
    assert.equal(res.ok(), true, "Independent saved-revision read succeeds");
    return res.json();
  }
  const part = await mutate("/api/parts", { customerId: f.orderCustomerId, partNumber: "E2E-RECIPE", eachWeight: 1, loadQty: 10 });
  await saveProcessViaApi(page, ctx, part.id, steps => [...steps, newProcessStep(f.stepCodeA.id, "Original numbered settings")]);
  const catalogRes = await page.request.get(`${ctx.baseURL}/api/process/editor-catalog`, { maxRetries: 1 });
  assert.equal(catalogRes.ok(), true);
  const code = (await catalogRes.json()).find(c => c.id === f.stepCodeA.id);
  assert.ok(code);
  const temperature = code.fields.find(field => field.label === "Temperature");
  assert.ok(temperature);
  let renamed = false, priorPermissions = null;
  try {
    await page.goto(`${ctx.baseURL}/parts/${part.id}`);
    await openRecordTab(page, "Process recipe");
    await waitForValue(page.getByLabel("Recipe number", { exact: true }), "");
    await page.getByLabel("Recipe number", { exact: true }).fill("001207");
    const saved = page.waitForResponse(r => r.url().endsWith(`/parts/${part.id}/process/recipe-number`) && r.request().method() === "PATCH");
    await page.getByRole("button", { name: "Save recipe", exact: true }).click();
    assert.equal((await saved).status(), 200);
    await page.waitForFunction(() => [...document.querySelectorAll("section")].some(section =>
      [...section.querySelectorAll("h2")].some(h => h.textContent === "Process steps") &&
      [...section.querySelectorAll('[role="status"]')].some(s => ["Process saved", "Unsaved process changes"].includes(s.textContent)) &&
      [...section.querySelectorAll("button")].some(b => b.textContent === "Save recipe" && b.disabled)));
    await page.reload();
    await page.getByLabel("Recipe number", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("Recipe number", { exact: true }).inputValue(), "001207", "Leading zeros survive reload");
    // Exact: the value input is "Step 1 Temperature"; its unit input and ✕ button carry longer
    // names that also contain "Temperature".
    await fillReliable(section(page).getByLabel("Step 1 Temperature", { exact: true }), "1550");
    await section(page).getByRole("button", { name: "Save process steps", exact: true }).click();
    await waitForProcessSaveSettled(page);
    await shot("number-and-settings-saved");
    const order = await createOrderViaUi(page, ctx, { customerCode: f.orderCustomerCode, lines: [{ partNumber: "E2E-RECIPE", qty: 10 }], expectWarnings: true });
    await (await process(page)).getByText("Recipe 001207 · Rev 1 · locked at order save", { exact: true }).waitFor();
    await (await process(page)).getByText(`Temperature: 1550 ${temperature.unit}`, { exact: true }).waitFor();
    await shot("order-captured-recipe");
    // Create the second fixture after the real order picker has selected E2E-RECIPE.
    // Its longer part number otherwise matches the shared helper's prefix locator too.
    const draftPart = await mutate("/api/parts", { customerId: f.orderCustomerId, partNumber: "E2E-RECIPE-DRAFT", eachWeight: 1, loadQty: 10 });
    await saveProcessViaApi(page, ctx, draftPart.id, steps => [...steps, newProcessStep(f.stepCodeA.id, "Original numbered settings")]);

    // Renaming the suggestion never relabels the part's row (spec 2026-09-26 §8: labels are
    // part-owned): the row stays "Temperature" on the locked revision AND on the working
    // revision the next edit cuts.
    renamed = true; // armed before the write, like priorPermissions below
    await mutate(`/api/admin/step-codes/${code.id}`, { fields: code.fields.map(field => ({ ...field, label: field.id === temperature.id ? "Renamed temperature" : field.label })) }, "PUT");
    // A parameter's name is an input VALUE in the table, so the name input is read: text on the
    // page could never show "Renamed temperature" either way (pre-flight M15).
    const rowName = () => section(page).getByLabel("Step 1 parameter 1 name", { exact: true });
    await page.goto(`${ctx.baseURL}/parts/${part.id}`);
    await openRecordTab(page, "Process recipe");
    await waitForValue(section(page).getByLabel("Step 1 Temperature", { exact: true }), "1550");
    await waitForValue(rowName(), "Temperature");
    assert.equal(await page.getByLabel("Recipe number", { exact: true }).isDisabled(), true);
    await fillReliable(section(page).getByPlaceholder("Instruction"), "New revision settings");
    await section(page).getByRole("button", { name: "Save process steps", exact: true }).click();
    await section(page).getByText("Rev 2 · working", { exact: true }).waitFor();
    await waitForValue(section(page).getByLabel("Step 1 Temperature", { exact: true }), "1550");
    await waitForValue(rowName(), "Temperature");
    await fillReliable(section(page).getByLabel("Step 1 Temperature", { exact: true }), "1600");
    await section(page).getByRole("button", { name: "Save process steps", exact: true }).click();
    await waitForProcessSaveSettled(page);
    await page.goto(`${ctx.baseURL}/orders/${order.id}`);
    await (await process(page)).getByText("Recipe 001207 · Rev 1 · locked at order save", { exact: true }).waitFor();
    await (await process(page)).getByText(`Temperature: 1550 ${temperature.unit}`, { exact: true }).waitFor();
    await (await process(page)).getByText(/Original numbered settings/).waitFor();
    await shot("original-order-after-revision-cut");

    // Duplicate refusal is visible and retains the attempted number.
    await page.goto(`${ctx.baseURL}/parts/${draftPart.id}`);
    await openRecordTab(page, "Process recipe");
    await waitForValue(page.getByLabel("Recipe number", { exact: true }), "");
    await page.getByLabel("Recipe number", { exact: true }).fill("001207");
    const duplicate = page.waitForResponse(r => r.url().endsWith(`/parts/${draftPart.id}/process/recipe-number`) && r.request().method() === "PATCH");
    await page.getByRole("button", { name: "Save recipe", exact: true }).click();
    assert.equal((await duplicate).status(), 409);
    await waitForValue(page.getByLabel("Recipe number", { exact: true }), "001207");
    await page.getByText(/already assigned/i).waitFor();
    await shot("duplicate-refused-input-retained");
    // Remove the overlay locally, then establish actual client navigation history.
    await page.getByLabel("Recipe number", { exact: true }).fill("");
    await page.goto(ctx.baseURL);
    await page.getByRole("navigation").getByRole("link", { name: "Parts & processes", exact: true }).click();
    await page.locator(`a[href="/parts/${draftPart.id}"]`).click();
    await openRecordTab(page, "Process recipe");
    await waitForValue(page.getByLabel("Recipe number", { exact: true }), "");
    const cdp = await page.context().newCDPSession(page);
    const history = await cdp.send("Page.getNavigationHistory");
    await page.getByLabel("Recipe number", { exact: true }).fill("DRAFT-001");
    await section(page).getByPlaceholder("Instruction").fill("Retained process instruction");
    for (const index of [history.currentIndex - 1, history.currentIndex]) {
      await cdp.send("Page.navigateToHistoryEntry", { entryId: history.entries[index].id });
      // Nonactivating observation preserves the native navigation recovery behavior.
      for (let attempt = 0; attempt < 100; attempt++) {
        const observation = await cdp.send("Runtime.evaluate", { expression: "location.pathname", returnByValue: true, userGesture: false });
        if (observation.result.value === new URL(history.entries[index].url).pathname) break;
        assert.ok(attempt < 99, "Client history traversal completed");
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await waitForValue(page.getByLabel("Recipe number", { exact: true }), "DRAFT-001");
    await waitForValue(section(page).getByPlaceholder("Instruction"), "Retained process instruction");
    await cdp.detach();
    await shot("recipe-and-step-draft-restored");
    // The unused, unnumbered revision is locked; assigning its first number must copy
    // steps and carry the pending instruction to the new server-issued ID.
    assert.equal(ctx.lockRevision(draftPart.id, 1).ok, true);
    await page.getByRole("button", { name: "Save recipe", exact: true }).click();
    await section(page).getByText("Rev 2 · working", { exact: true }).waitFor();
    await waitForValue(section(page).getByPlaceholder("Instruction"), "Retained process instruction");
    await section(page).getByRole("button", { name: "Save process steps", exact: true }).click();
    await waitForProcessSaveSettled(page);
    await page.reload();
    await waitForValue(section(page).getByPlaceholder("Instruction"), "Retained process instruction");
    await shot("number-only-cut-rekeyed-step-draft");

    // Hold an acknowledged save while both inputs change. The subsequent real
    // save proves refresh accepted the first number as its expected baseline.
    await page.getByLabel("Recipe number", { exact: true }).fill("HELD-001");
    let refreshed;
    await controlledRecipeSave(page, ctx, draftPart.id, "HELD-001", async () => {
      const actual = await savedRevision(draftPart.id);
      assert.equal(actual.recipeNumber, "HELD-001");
      assert.equal(actual.steps[0].instruction, "Retained process instruction");
      await page.getByLabel("Recipe number", { exact: true }).fill("HELD-002");
      await section(page).getByPlaceholder("Instruction").fill("Instruction typed during save");
      refreshed = page.waitForResponse(r => new URL(r.url()).pathname === "/api/auth/me" && r.request().method() === "GET")
        .then(async response => { assert.equal(response.status(), 200); await response.finished(); })
        .then(() => ({ ok: true }), error => ({ ok: false, error }));
    }, async () => {
      const result = await bounded(refreshed, "Acknowledged recipe save performs its authorized refresh");
      assert.equal(result.ok, true, String(result.error));
      await waitForValue(page.getByLabel("Recipe number", { exact: true }), "HELD-002");
      await waitForValue(section(page).getByPlaceholder("Instruction"), "Instruction typed during save");
      const saved = page.waitForResponse(r => r.url().endsWith(`/parts/${draftPart.id}/process/recipe-number`) && r.request().method() === "PATCH");
      await shot("later-number-and-step-survive-save-refresh");
      await page.getByRole("button", { name: "Save recipe", exact: true }).click();
      const response = await saved;
      assert.equal(response.request().postDataJSON().expectedRecipeNumber, "HELD-001");
      assert.equal(response.status(), 200);
      await page.waitForFunction(() => [...document.querySelectorAll("section")].some(section =>
      [...section.querySelectorAll("h2")].some(h => h.textContent === "Process steps") &&
      [...section.querySelectorAll('[role="status"]')].some(s => ["Process saved", "Unsaved process changes"].includes(s.textContent)) &&
      [...section.querySelectorAll("button")].some(b => b.textContent === "Save recipe" && b.disabled)));
      await waitForValue(section(page).getByPlaceholder("Instruction"), "Instruction typed during save");
    });
    await section(page).getByRole("button", { name: "Save process steps", exact: true }).click();
    await waitForProcessSaveSettled(page);
    const savedLater = await savedRevision(draftPart.id);
    assert.equal(savedLater.recipeNumber, "HELD-002");
    assert.equal(savedLater.steps[0].instruction, "Instruction typed during save");

    // Commit once, then lose only the browser response. Fresh reconciliation
    // displays actual server state while keeping the later copy for review.
    await page.getByLabel("Recipe number", { exact: true }).fill("LOST-001");
    await controlledRecipeSave(page, ctx, draftPart.id, "LOST-001", async () => {
      assert.equal((await savedRevision(draftPart.id)).recipeNumber, "LOST-001");
      await page.getByLabel("Recipe number", { exact: true }).fill("LOST-002");
      await section(page).getByPlaceholder("Instruction").fill("Instruction retained after lost response");
    }, async () => {
      const recovery = section(page).getByRole("complementary", { name: "Draft recovery", exact: true });
      await recovery.getByText("The saved record changed or is read-only. Review your retained copy before starting fresh.", { exact: true }).waitFor();
      const retained = recovery.locator("section").filter({ has: page.getByRole("heading", { name: "Retained changes", exact: true }) });
      await retained.getByText("LOST-002", { exact: true }).waitFor();
      await retained.getByText("Instruction retained after lost response", { exact: true }).waitFor();
      await recovery.getByRole("button", { name: "Check access and saved record again", exact: true }).click();
      await waitForValue(page.getByLabel("Recipe number", { exact: true }), "LOST-001");
      assert.equal(await page.getByLabel("Recipe number", { exact: true }).isDisabled(), true);
      await retained.getByText("LOST-002", { exact: true }).waitFor();
      await retained.getByText("Instruction retained after lost response", { exact: true }).waitFor();
      await assertNeverVisible(recovery.getByRole("button", { name: "Restore", exact: true }), "Uncertain save cannot silently resume a conflicting draft");
      const actual = await savedRevision(draftPart.id);
      assert.equal(actual.recipeNumber, "LOST-001");
      assert.equal(actual.steps[0].instruction, "Instruction typed during save");
      await shot("lost-response-retained-copy-and-actual-saved-number");
      await recovery.getByRole("button", { name: "Discard retained changes", exact: true }).click();
      await waitForValue(page.getByLabel("Recipe number", { exact: true }), "LOST-001");
    }, true);

    // An emptied local process draft survives a recipe-number save: the number save writes the
    // number alone, and the removal stays a draft until the process save commits it (Task 2's
    // review; the staging is the part's only step removed through ⋮ → Remove step).
    const noSteps = section(page).getByText("No steps yet. Search for a code below to add the first step.", { exact: true });
    await page.getByLabel("Recipe number", { exact: true }).fill("EMPTY-PENDING");
    await section(page).getByRole("button", { name: "Step 1 actions", exact: true }).click();
    await section(page).getByRole("menuitem", { name: "Remove step", exact: true }).click();
    await noSteps.waitFor();
    await waitForValue(page.getByLabel("Recipe number", { exact: true }), "EMPTY-PENDING");
    await page.getByRole("button", { name: "Save recipe", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll("section")].some(section =>
      [...section.querySelectorAll("h2")].some(h => h.textContent === "Process steps") &&
      [...section.querySelectorAll('[role="status"]')].some(s => s.textContent === "Unsaved process changes") &&
      [...section.querySelectorAll("button")].some(b => b.textContent === "Save recipe" && b.disabled)));
    await noSteps.waitFor();
    const afterNumberSave = await savedRevision(draftPart.id);
    assert.equal(afterNumberSave.recipeNumber, "EMPTY-PENDING", "The recipe number saved");
    assert.deepEqual(afterNumberSave.steps.map(s => s.instruction), ["Instruction typed during save"], "The emptied draft stays local through the recipe-number save");
    await section(page).getByRole("button", { name: "Save process steps", exact: true }).click();
    await waitForProcessSaveSettled(page);
    await noSteps.waitFor();
    assert.equal((await savedRevision(draftPart.id)).steps.length, 0, "The process save then commits the emptied draft");
    await shot("emptied-draft-kept-through-number-save");

    await login(page, ctx.baseURL, f.restrictedUsername, f.restrictedPassword);
    await page.goto(`${ctx.baseURL}/parts/${draftPart.id}`);
    await openRecordTab(page, "Process recipe");
    await waitForValue(page.getByLabel("Recipe number", { exact: true }), "EMPTY-PENDING");
    assert.equal(await page.getByLabel("Recipe number", { exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Save recipe", exact: true }).getAttribute("title"), "Requires processes.edit");
    await shot("restricted-process-reader");
    await login(page, ctx.baseURL, f.adminUsername, f.adminPassword);
    // Armed before the write: a narrowing whose answer is lost may still have committed (#321).
    priorPermissions = await rolePermissions(page, ctx, f.restrictedRoleId);
    await setRolePermissions(page, ctx, f.restrictedRoleId, ["parts.view", "orders.view"]);
    await login(page, ctx.baseURL, f.restrictedUsername, f.restrictedPassword);
    await page.goto(`${ctx.baseURL}/orders/${order.id}`);
    await (await process(page)).getByText("Recipe 001207 · Rev 1 · locked at order save", { exact: true }).waitFor();
    await (await process(page)).getByText(`Temperature: 1550 ${temperature.unit}`, { exact: true }).waitFor();
    await shot("orders-view-alone-captured-recipe");
  } finally {
    if (renamed || priorPermissions) {
      await login(page, ctx.baseURL, f.adminUsername, f.adminPassword);
      // The fixture's own permissions, not a hand copy: a copy had already dropped templates.view.
      // First, because later flows sign in as this role's user.
      if (priorPermissions) await setRolePermissions(page, ctx, f.restrictedRoleId, priorPermissions);
      if (renamed) {
        // Fields sync by id, so replaying this exact-value restore is idempotent.
        const res = await ctx.apiMutate(page, `${ctx.baseURL}/api/admin/step-codes/${code.id}`, { method: "PUT", data: { fields: code.fields }, idempotent: true });
        assert.equal(res.ok(), true, `Restore step-code fields: ${res.status()} ${await res.text()}`);
      }
    }
  }
}
