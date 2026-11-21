import { openOrderTab } from "./orders.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pickCombobox } from "./ui.mjs";
import { newProcessStep, saveProcessViaApi } from "./process-document.mjs";
import { routeRequests } from "../route-keep-alive.mjs";

export const loadsOnly = loads => loads.map(({ loadNumber, qty, weight }) => ({ loadNumber, qty, weight }));
export async function readJson(page, ctx, route) {
  // Recover one expired keep-alive socket on a read; Playwright retries only ECONNRESET.
  const response = await page.request.get(`${ctx.baseURL}${route}`, { maxRetries: 1 });
  assert.equal(response.status(), 200, `Read ${route}`);
  return response.json();
}
export async function mutate(page, ctx, route, data, method = "POST") {
  const response = await ctx.apiMutate(page, `${ctx.baseURL}${route}`, { method, ...(data === undefined ? {} : { data }) });
  assert.equal(response.status(), 200, `${method} ${route}: ${await response.text()}`);
  return response.json();
}
export const ownedOrders = (page, ctx) => readJson(page, ctx, `/api/orders?customerId=${ctx.fixtures.orderCustomerId}&includeVoided=1`);
export async function entryFixture(page, ctx, partNumber, options = {}) {
  assert.equal(typeof ctx.fixtures.orderCustomerId, "string", "Entry fixtures require the owned order customer ID");
  assert.equal(typeof ctx.fixtures.orderCustomerCode, "string", "Entry fixtures require the owned order customer code");
  assert.equal(typeof partNumber, "string", "Entry fixture part number must be explicit");
  const created = await mutate(page, ctx, "/api/parts", { customerId: ctx.fixtures.orderCustomerId, partNumber,
    eachWeight: 127, loadQty: 15, ...options });
  // Part creation intentionally returns only {id}; resolve the saved picker identity
  // through its public read instead of treating the acknowledgement as a Part row.
  assert.equal(typeof created.id, "string", "Part creation must acknowledge a saved ID");
  const part = await readJson(page, ctx, `/api/parts/${created.id}`);
  assert.equal(part.id, created.id, "Fixture read must name the created part");
  assert.equal(part.customerId, ctx.fixtures.orderCustomerId, "Fixture part must belong to the owned customer");
  assert.equal(part.partNumber, partNumber, "Fixture picker number must come from the saved part");
  await saveProcessViaApi(page, ctx, part.id, steps => [...steps, newProcessStep(ctx.fixtures.stepCodeA.id,
    `Fictional ${partNumber}: verify this part's traveler settings.`)]);
  return part;
}
export async function entryTab(page, name, keyboard = false) {
  const tab = page.getByRole("tab", { name, exact: true });
  if (keyboard) {
    const active = page.getByRole("tab", { selected: true });
    await active.focus();
    for (let i = 0; i < 3 && await tab.getAttribute("aria-selected") !== "true"; i++) await page.keyboard.press("ArrowRight");
    assert.equal(await tab.evaluate(element => element === document.activeElement), true, "Keyboard tab selection moves focus");
  } else await tab.click();
  assert.equal(await tab.getAttribute("aria-selected"), "true");
  await page.getByRole("tabpanel", { name, exact: true }).waitFor();
}
async function keyboardPick(page, label, text) {
  await page.getByLabel(label, { exact: true }).focus();
  await page.keyboard.type(text);
  await page.getByRole("option").first().waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.equal(new URL(page.url()).pathname, "/orders/new", "Picker Enter selects without submitting");
}
export async function startEntry(page, ctx, part, qty, { keyboard = false } = {}) {
  assert.equal(typeof ctx.fixtures.orderCustomerCode, "string", "Customer picker requires the owned fixture code");
  assert.equal(typeof part.partNumber, "string", "Part picker requires the resolved saved fixture row");
  assert.equal(part.customerId, ctx.fixtures.orderCustomerId, "Part picker fixture must belong to the selected customer");
  await page.goto(`${ctx.baseURL}/orders/new`);
  await page.getByRole("heading", { name: "New order", exact: true }).waitFor();
  // Only this run's dedicated admin has an entry draft in this disposable database.
  const discard = page.getByRole("button", { name: "Discard", exact: true });
  await page.getByRole("tab", { name: "Order details", exact: true }).or(discard).waitFor();
  if (await discard.isVisible()) await discard.click();
  if (keyboard) await keyboardPick(page, "Customer", ctx.fixtures.orderCustomerCode);
  else await pickCombobox(page, "Customer", ctx.fixtures.orderCustomerCode, new RegExp(`^${ctx.fixtures.orderCustomerCode}`));
  await entryTab(page, "Parts & containers", keyboard);
  if (keyboard) await keyboardPick(page, "Line 1 part", part.partNumber);
  else await pickCombobox(page, "Line 1 part", part.partNumber, new RegExp(`^${part.partNumber}(?:\\s|$)`));
  if (keyboard) await keyboardFill(page, page.getByLabel("Line 1 quantity", { exact: true }), String(qty));
  else await page.getByLabel("Line 1 quantity", { exact: true }).fill(String(qty));
}
export async function keyboardFill(page, locator, value) {
  await locator.focus();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(value);
}
/** The primary button's name once the plan is current (PR 2: no middot, the owner's rename). */
export const SAVE_PRINT = count => `Save & Print ${count} travelers`;
/** Clicks "Save only", New order's non-printing save (PR 2's rename of "Save"). */
export async function saveOnly(page) {
  await page.getByRole("button", { name: "Save only", exact: true }).click();
}
export async function waitPlan(page, count) {
  await page.getByRole("button", { name: SAVE_PRINT(count), exact: true }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => /^Save & Print \d/.test(button.textContent) && !button.disabled));
}
export async function saveEntry(page, ctx, { print = false, count = 1, doubleWarning = false, keyboard = false } = {}) {
  const response = page.waitForResponse(r => r.url() === `${ctx.baseURL}/api/orders` && r.request().method() === "POST");
  const save = page.getByRole("button", { name: print ? SAVE_PRINT(count) : "Save only", exact: true });
  if (keyboard) { await save.focus(); await page.keyboard.press("Enter"); } else await save.click();
  const saved = await response;
  assert.equal(saved.status(), 200);
  const result = await saved.json();
  assert.match(result.printExpectation, /^[a-f0-9]{64}$/);
  if (result.warnings.length) {
    const go = page.getByRole("button", { name: print && !result.deduped ? "Go to order and print" : "Go to order", exact: true });
    await go.waitFor();
    if (doubleWarning) {
      // Two synchronous activations close the before-rerender warning handoff window.
      await go.evaluate(button => { button.click(); button.click(); });
    } else if (keyboard) { await go.focus(); await page.keyboard.press("Enter"); } else await go.click();
  }
  await page.getByRole("heading", { name: `Order #${result.order.orderNumber}`, exact: true }).waitFor();
  return result;
}
/** Opens a hub tab once the automatic-print query (`print` / `printIntent`) has been consumed:
 *  that consumption and a tab click both rewrite the URL from `window.location.search`, and the
 *  later one wins, so a click in between could put the query back and print again on reload. */
export async function openHubTabSettled(page, label) {
  await page.waitForFunction(() => {
    const params = new URL(location.href).searchParams;
    return !params.has("print") && !params.has("printIntent");
  }, null, { timeout: 15000 }).catch(() => {});
  await openOrderTab(page, label);
}
export async function archiveEvidence(page, ctx, result, coverage, shot, name, selected = false) {
  // The stored documents list sits on the hub's Loads & travelers tab (PR 2).
  await openHubTabSettled(page, "Loads & travelers");
  const links = page.locator('#documents a[href^="/api/documents/"]');
  await links.first().waitFor({ timeout: 30000 });
  const docs = await readJson(page, ctx, `/api/orders/${result.order.id}/documents`);
  assert.equal(docs.length, 1, "One automatic action archives exactly one PDF");
  assert.equal(docs[0].kind, "TRAVELER");
  assert.deepEqual(docs[0].travelerLoadNumbers, selected ? coverage : []);
  assert.equal(docs[0].loadNumber, null);
  const response = await page.request.get(`${ctx.baseURL}/api/documents/${docs[0].id}`, { maxRetries: 1 });
  assert.equal(response.status(), 200);
  const bytes = await response.body();
  assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
  const shotPath = await shot(name);
  await fs.writeFile(path.join(path.dirname(shotPath), `${name}.pdf`), bytes);
  await fs.writeFile(path.join(path.dirname(shotPath), `${name}.json`), JSON.stringify({ order: result.order,
    expectedBarcodes: coverage.map(number => `${result.order.orderNumber}-${number}`), document: docs[0] }, null, 2));
  return { id: docs[0].id, bytes };
}

export async function bounded(promise, message) {
  let timer;
  try {
    const result = await Promise.race([promise.then(value => ({ value })), new Promise(resolve => { timer = setTimeout(() => resolve(null), 20000); })]);
    assert.ok(result, message);
    return result.value;
  } finally { clearTimeout(timer); }
}

/** Hold one real response after its operation, or before forwarding. Every writer uses
 * the harness's counted transport, and every handler is joined before route removal.
 * `lose` fails the page's copy of the request once the server has answered. `unreadable`
 * answers the page's copy with the server's own status and the first characters of its body,
 * too few to read as JSON: no request fails, and the page cannot read the answer (#547). The
 * two are exclusive. */
export async function holdRequest(page, ctx, routePath, { method = "POST", before = false, lose = false, unreadable = false, match = () => true } = {}) {
  assert.ok(!(lose && unreadable), "holdRequest: lose and unreadable are exclusive");
  const url = `${ctx.baseURL}${routePath}`;
  let release, arrive, selected = false;
  const gate = new Promise(resolve => { release = resolve; });
  const arrived = new Promise(resolve => { arrive = resolve; });
  const pending = [];
  const handler = route => {
    if (selected || route.request().method() !== method || !match(route.request())) return route.continue();
    selected = true;
    const task = (async () => {
      const request = route.request();
      const data = method === "GET" ? undefined : request.postDataJSON();
      if (before) { arrive({ data }); await gate; }
      const response = method === "GET" ? await page.request.get(url, { maxRetries: 1 })
        : await ctx.apiMutate(page, url, { method, ...(data === null ? {} : { data }) });
      // A cut that would still read as JSON is never handed to the page: it fails the helper.
      const cut = unreadable ? (await response.text()).slice(0, 10) : null;
      if (unreadable) assert.throws(() => JSON.parse(cut), SyntaxError, `The cut answer to ${method} ${routePath} must not read as JSON`);
      if (!before) { arrive({ data, response }); await gate; }
      if (lose) await route.abort("failed");
      else if (unreadable) await route.fulfill({ status: response.status(), contentType: "application/json", body: cut });
      else await route.fulfill({ response });
    })().then(() => null, async error => { arrive({ error }); await route.abort().catch(() => {}); return error; });
    pending.push(task);
    return task;
  };
  const stopHandler = await routeRequests(page, url, handler);
  return {
    arrived: async () => { const value = await bounded(arrived, `Expected ${method} ${routePath}`); assert.equal(value.error, undefined, String(value.error)); return value; },
    release,
    async close() { release(); try { assert.deepEqual((await bounded(Promise.all(pending), `Drain ${routePath}`)).filter(Boolean), []); }
      finally { await stopHandler(); } },
  };
}

/** What Next draws in place of the whole page when a render throws and no error boundary of the
 * app's own catches it: the heading of its built-in global error, read from the installed Next
 * 16.4.0 (next/dist/client/components/builtin/global-error.js; the app has no error.tsx or
 * global-error.tsx). The apostrophe is U+2019. A Next release that rewords it would leave an
 * absence check of it passing, so each flow that asks also waits for content the crash removes. */
export const pageDown = page => page.getByRole("heading", { name: "This page couldn’t load", exact: true });
