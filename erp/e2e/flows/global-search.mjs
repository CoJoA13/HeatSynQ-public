// Real Shell keyboard/async/unsaved-guard coverage. All destinations belong to the normal
// fixtures or order-entry-full; only GET /api/search replies are controlled. No business writes.
import { openOrderTab } from "../lib/orders.mjs";
import assert from "node:assert/strict";
import { assertNeverVisible, waitForValue } from "../lib/ui.mjs";
import { routeRequests } from "../route-keep-alive.mjs";

const empty = { exactOrderId: null, orders: [], parts: [], customers: [] };
const search = (page) => page.getByPlaceholder("Search order, PO, part, customer", { exact: false });
const searchResults = (page) => page.getByRole("listbox", { name: "Search results", exact: true });

function payload(ctx, { exact = false, marker = "Keyboard result" } = {}) {
  assert.ok(ctx.created.orderId && ctx.created.orderNumber, "global-search requires order-entry-full");
  return {
    exactOrderId: exact ? ctx.created.orderId : null,
    orders: [{ id: ctx.created.orderId, orderNumber: ctx.created.orderNumber,
      customerCode: ctx.fixtures.orderCustomerCode, poNumber: marker,
      leadPartNumber: ctx.fixtures.orderLeadPartNumber }],
    parts: [{ id: ctx.fixtures.partId, partNumber: ctx.fixtures.partNumber,
      customerCode: ctx.fixtures.customerCode, name: marker }],
    customers: [{ id: ctx.fixtures.customerId, code: ctx.fixtures.customerCode, name: marker }],
  };
}

async function board(page, ctx) {
  await page.goto(`${ctx.baseURL}/`);
  await page.getByRole("heading", { name: "Orders", exact: true }).waitFor({ state: "visible" });
  await search(page).waitFor({ state: "visible" });
}

async function within(promise, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new assert.AssertionError({ message })), 10000);
    })]);
  } finally { clearTimeout(timer); }
}

// A bounded, single read reply hold, local to this flow. The browser still runs all React
// events and response handling. Finally always releases an outstanding route before removal.
async function reply(page, ctx, term, body, { hold = false, status = 200 } = {}) {
  const url = `${ctx.baseURL}/api/search?q=${encodeURIComponent(term)}`;
  let release;
  let arrived;
  let count = 0;
  const handled = [];
  const gate = new Promise((resolve) => { release = resolve; });
  const received = new Promise((resolve) => { arrived = resolve; });
  const handler = (route) => {
    // Observe rejection immediately; dispose reports it after joining every released handler.
    // Returning the observed task keeps route errors from escaping as unhandled rejections.
    const task = (async () => {
      assert.equal(route.request().method(), "GET", "controlled search boundary must stay read-only");
      count += 1;
      arrived();
      if (hold) await gate;
      await route.fulfill({ status, json: body });
    })().then(() => null, (error) => error);
    handled.push(task);
    return task;
  };
  const stopHandler = await routeRequests(page, url, handler);
  return {
    count: () => count,
    async wait() {
      await within(received, `Search ${term} must reach its controlled reply within 10 seconds`);
    },
    async send() {
      const response = page.waitForResponse(url);
      release();
      assert.equal(await within((await response).finished(), `Search ${term} response must finish`), null,
        `Search ${term} response must finish successfully`);
    },
    async dispose(preserveFailure = false) {
      try {
        release();
        await within(stopHandler(), `Search ${term} route must detach`);
        const errors = await within(Promise.all(handled), `Search ${term} handlers must finish after release`);
        assert.deepEqual(errors.filter(Boolean), [], `Search ${term} route fulfillment must succeed`);
      } catch (error) {
        if (!preserveFailure) throw error;
        console.error(`Secondary search cleanup failure (original failure preserved): ${error.stack ?? error}`);
      }
    },
  };
}

async function activeOption(page, index) {
  const input = search(page);
  const options = searchResults(page).getByRole("option");
  const id = await options.nth(index).getAttribute("id");
  assert.ok(id, "each result needs an option ID");
  await page.waitForFunction(({ id }) => {
    const input = document.querySelector('input[role="combobox"]');
    return input?.getAttribute("aria-activedescendant") === id;
  }, { id });
  assert.equal(await input.evaluate((el) => el === document.activeElement), true,
    "arrow selection must keep DOM focus in the search input");
  assert.equal(await options.nth(index).getAttribute("aria-selected"), "true");
  assert.equal(await searchResults(page).getByRole("option", { selected: true }).count(), 1);
  assert.equal(await page.locator("[id]").evaluateAll((els, id) => els.filter((el) => el.id === id).length, id), 1,
    "the active ID must resolve uniquely in the document");
  return options.nth(index);
}

// Account for both viewport edges and whichever ancestor actually clips the popup. A plain
// Playwright isVisible check is insufficient: an offscreen option still has visible CSS.
function fullyVisible(el) {
  const rect = el.getBoundingClientRect();
  let top = 0, bottom = innerHeight, left = 0, right = innerWidth;
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const box = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      top = Math.max(top, box.top + parent.clientTop);
      bottom = Math.min(bottom, box.top + parent.clientTop + parent.clientHeight);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      left = Math.max(left, box.left + parent.clientLeft);
      right = Math.min(right, box.left + parent.clientLeft + parent.clientWidth);
    }
  }
  return rect.height > 0 && rect.width > 0 && rect.top >= top - 1 && rect.bottom <= bottom + 1
    && rect.left >= left - 1 && rect.right <= right + 1;
}

export async function runScroll(page, shot, ctx) {
  await board(page, ctx);
  const response = await page.request.get(`${ctx.baseURL}/api/search?q=E2E`, { maxRetries: 1 });
  assert.equal(response.status(), 200, "scroll setup must read real search results");
  const data = await response.json();
  const f = ctx.fixtures;
  const partIds = new Set([f.partId, f.orderLeadPartId, f.orderRiderPartId, f.shipPartAId,
    f.shipPartBId, f.certPartId, f.holdPartId, f.invPartId, f.arPartId, f.closePartId, f.quotePartId]);
  const customerIds = new Set([f.customerId, f.orderCustomerId, f.shipCustomerId,
    f.holdCustomerId, f.invCustomerId, f.arCustomerId, f.closeCustomerId, f.quoteCustomerId]);
  const owned = {
    exactOrderId: null,
    orders: data.orders.filter((row) => row.id === ctx.created.orderId),
    parts: data.parts.filter((row) => partIds.has(row.id)),
    customers: data.customers.filter((row) => customerIds.has(row.id)),
  };
  const count = owned.orders.length + owned.parts.length + owned.customers.length;
  assert.ok(count >= 8, "existing fixture search rows must be sufficient to exercise popup scrolling");
  const viewport = page.viewportSize();
  assert.ok(viewport, "scroll coverage requires the normal harness viewport");
  const result = await reply(page, ctx, "scroll-owned-results", owned);
  let completed = false;
  try {
    await page.setViewportSize({ width: viewport.width, height: 320 });
    await search(page).fill("scroll-owned-results");
    const options = searchResults(page).getByRole("option");
    await options.nth(count - 1).waitFor({ state: "attached" });
    const last = options.nth(count - 1);
    assert.equal(await last.evaluate(fullyVisible), false,
      "the final owned result must begin outside the visible popup/viewport");
    await search(page).press("ArrowDown");
    await activeOption(page, 0);
    // Real key presses, with no locator action on the target that could scroll it for us.
    for (let index = 1; index < count; index += 1) await page.keyboard.press("ArrowDown");
    await activeOption(page, count - 1);
    const deadline = Date.now() + 3000;
    while (!(await last.evaluate(fullyVisible))) {
      assert.ok(Date.now() < deadline, "arrow selection must scroll the final owned result fully into view");
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    }
    await shot("global-search-scrolls-selected-result");
    await page.keyboard.press("Escape");
    completed = true;
  } finally {
    try { await result.dispose(!completed); }
    finally {
      await page.setViewportSize(viewport);
      await page.evaluate(() => window.scrollTo(0, 0));
    }
  }
}

export async function runKeyboard(page, shot, ctx) {
  await board(page, ctx);
  const input = search(page);
  assert.equal(await page.getByRole("combobox", { name: "Global search", exact: true }).count(), 1,
    "Shell search must expose a distinctly named combobox");
  assert.equal(await input.getAttribute("aria-autocomplete"), "list");
  const response = await reply(page, ctx, "keyboard", payload(ctx));
  let completed = false;
  try {
    await input.fill("keyboard");
    const list = searchResults(page);
    await list.waitFor({ state: "visible" });
    assert.equal(await input.getAttribute("aria-expanded"), "true");
    assert.equal(await input.getAttribute("aria-controls"), await list.getAttribute("id"));
    assert.ok(await list.getAttribute("id"));
    const ids = await list.getByRole("option").evaluateAll((els) => els.map((el) => el.id));
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3, "option IDs must be unique");
    assert.ok(ids.every(Boolean));
    assert.ok(!(await input.getAttribute("aria-activedescendant")), "no automatic highlight");
    for (const name of ["Orders", "Parts", "Customers"]) {
      assert.equal(await list.getByRole("group", { name, exact: true }).count(), 1);
    }
    await input.press("ArrowDown");
    const first = await activeOption(page, 0);
    const selectedColor = await first.evaluate((el) => getComputedStyle(el).backgroundColor);
    await input.press("ArrowUp");
    await activeOption(page, 0); // upper clamp
    await input.press("ArrowDown");
    await activeOption(page, 1);
    assert.notEqual(await first.evaluate((el) => getComputedStyle(el).backgroundColor), selectedColor,
      "the keyboard selection must be visible, not only announced");
    await input.press("ArrowDown");
    await activeOption(page, 2);
    await input.press("ArrowDown");
    await activeOption(page, 2); // lower clamp across all three groups
    await shot("global-search-keyboard-selection");
    const beforeTab = page.url();
    await input.press("Tab");
    assert.equal(await page.getByRole("button", { name: /^Drafts in this tab \(\d+\)$/ })
      .evaluate((el) => el === document.activeElement), true, "Tab must move past all options to Drafts in this tab");
    await assertNeverVisible(list, "Tab must dismiss search without selecting", 350);
    assert.equal(page.url(), beforeTab);
    await waitForValue(input, "keyboard");
    await page.keyboard.press("Tab");
    // Sign out moved to the rail foot on 2026-10-30 (ruling 6), so the header's next stop is Help.
    assert.equal(await page.getByRole("link", { name: "Help", exact: true })
      .evaluate((el) => el === document.activeElement), true, "The next native Tab must reach Help");

    await input.focus();
    await input.fill("keyboard-again");
    await input.fill("keyboard");
    await list.waitFor({ state: "visible" });
    await input.press("ArrowUp");
    await activeOption(page, 2); // first Up intentionally chooses the last result
    await input.press("ArrowUp");
    await input.press("ArrowUp");
    await activeOption(page, 0);
    await input.press("Enter");
    await page.waitForURL(`${ctx.baseURL}/orders/${ctx.created.orderId}`);
    await waitForValue(input, "");
    completed = true;
  } finally { await response.dispose(!completed); }

  // Editing while a selected destination is still visible must invalidate it immediately.
  await board(page, ctx);
  const old = await reply(page, ctx, "old-highlight", payload(ctx));
  const fresh = await reply(page, ctx, "new-empty", empty, { hold: true });
  completed = false;
  try {
    await input.fill("old-highlight");
    await searchResults(page).waitFor({ state: "visible" });
    await input.press("ArrowDown");
    await activeOption(page, 0);
    await input.fill("new-empty");
    assert.ok(!(await input.getAttribute("aria-activedescendant")), "typing must immediately clear stale selection");
    await input.press("Enter");
    await fresh.wait();
    await fresh.send();
    await page.getByText("No matches", { exact: true }).waitFor({ state: "visible" });
    assert.equal(page.url(), `${ctx.baseURL}/`, "Enter after an edit must never choose the old result");
    assert.ok(!(await input.getAttribute("aria-activedescendant")));
    await input.press("ArrowDown");
    assert.ok(!(await input.getAttribute("aria-activedescendant")), "empty results have no fictional active option");
    await input.press("Escape");
    await assertNeverVisible(searchResults(page), "Escape closes results", 350);
    await waitForValue(input, "new-empty");
    completed = true;
  } finally {
    try { await old.dispose(!completed); } finally { await fresh.dispose(!completed); }
  }
  await runScroll(page, shot, ctx);
}

// Independent of the new roles: baseline Shell must reach the known obsolete-exact-response
// navigation failure even when runKeyboard fails at its first combobox assertion.
export async function runCancellation(page, shot, ctx) {
  for (const key of ["Escape", "Tab", "Edit"]) {
    await board(page, ctx);
    const input = search(page);
    const term = String(ctx.created.orderNumber);
    const held = await reply(page, ctx, term, payload(ctx, { exact: true }), { hold: true });
    const edited = key === "Edit" ? await reply(page, ctx, "edited-exact", empty) : null;
    let completed = false;
    try {
      await input.fill(term);
      await input.press("Enter");
      await held.wait();
      if (key === "Edit") {
        await input.fill("edited-exact");
        await page.getByText("No matches", { exact: true }).waitFor({ state: "visible" });
      } else { await input.press(key); }
      await held.send();
      await assertNeverVisible(page.getByRole("heading", { name: `Order #${ctx.created.orderNumber}`, exact: true }),
        `${key} during exact lookup must prevent late navigation`, 700);
      assert.equal(page.url(), `${ctx.baseURL}/`);
      await waitForValue(input, key === "Edit" ? "edited-exact" : term);
      await assertNeverVisible(page.getByText("Keyboard result", { exact: false }),
        `${key} must not let a late response reopen results`, 350);
      completed = true;
    } finally {
      try { await held.dispose(!completed); } finally { await edited?.dispose(!completed); }
    }
  }

  // Pause browser time only for this debounce deadline; no React/state hooks are replaced.
  await board(page, ctx);
  const clockStart = new Date("2026-09-10T12:00:00Z");
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(new Date(clockStart.getTime() + 1000));
  const escaped = await reply(page, ctx, "escape-before-debounce", empty);
  let completed = false;
  try {
    await search(page).fill("escape-before-debounce");
    await search(page).press("Escape");
    await page.clock.runFor(300);
    assert.equal(escaped.count(), 0, "Escape must cancel a not-yet-fired debounce");
    await waitForValue(search(page), "escape-before-debounce");
    completed = true;
  } finally { try { await escaped.dispose(!completed); } finally { await page.clock.resume(); } }

  // The new response is rendered BEFORE releasing the old success or failure.
  for (const status of [200, 500]) {
    await board(page, ctx);
    const stale = await reply(page, ctx, `stale-${status}`,
      status === 200 ? payload(ctx, { marker: "Obsolete response" }) : { error: "Obsolete search failure" },
      { hold: true, status });
    const current = await reply(page, ctx, `current-${status}`, payload(ctx, { marker: "Current response" }));
    completed = false;
    try {
      await search(page).fill(`stale-${status}`);
      await stale.wait();
      await search(page).fill(`current-${status}`);
      await page.locator("header").getByText(/PO Current response/).waitFor({ state: "visible" });
      await stale.send();
      await assertNeverVisible(page.locator("header").getByText(/Obsolete/),
        "obsolete success/error must not overwrite newer results", 350);
      await page.locator("header").getByText(/PO Current response/).waitFor({ state: "visible" });
      completed = true;
    } finally {
      try { await stale.dispose(!completed); } finally { await current.dispose(!completed); }
    }
  }

  await board(page, ctx);
  const failure = await reply(page, ctx, "current-error", { error: "Current search failure" }, { status: 500 });
  completed = false;
  try {
    await search(page).fill("current-error");
    await page.getByText("Current search failure", { exact: true }).waitFor({ state: "visible" });
    await search(page).press("ArrowDown");
    assert.ok(!(await search(page).getAttribute("aria-activedescendant")), "failure has no active option");
    completed = true;
  } finally { await failure.dispose(!completed); }

  // The original real HTTP barcode path is also retained in board-search-scan. Here a held
  // exact response proves the immediate path makes exactly one request, without arrow selection.
  await board(page, ctx);
  const scan = await reply(page, ctx, String(ctx.created.orderNumber), payload(ctx, { exact: true }), { hold: true });
  completed = false;
  try {
    await search(page).fill(String(ctx.created.orderNumber));
    await search(page).press("Enter");
    await scan.wait();
    await scan.send();
    await page.waitForURL(`${ctx.baseURL}/orders/${ctx.created.orderId}`);
    assert.equal(scan.count(), 1, "rapid barcode Enter must cancel its duplicate debounce");
    await shot("global-search-barcode");
    completed = true;
  } finally { await scan.dispose(!completed); }
}

export async function runGuard(page, shot, ctx) {
  assert.ok(ctx.created.orderId, "global-search guard requires order-entry-full");
  await page.goto(`${ctx.baseURL}/orders/${ctx.created.orderId}`);
  await openOrderTab(page, "Parts & containers"); // PR 2: the serial editor sits there
  const draft = page.getByLabel("Line 2 serial 1 description", { exact: true });
  await draft.waitFor({ state: "visible" });
  const original = await draft.inputValue();
  const editor = page.getByLabel("Line 2 add serial", { exact: true }).locator("xpath=ancestor::div[1]");
  const dialogs = [];
  const dismiss = async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); };
  page.on("dialog", dismiss);
  const result = await reply(page, ctx, "guarded-search", payload(ctx));
  let completed = false;
  try {
    await draft.fill("Keep this keyboard-search draft");
    await editor.getByRole("button", { name: "Discard changes to serials", exact: true }).waitFor({ state: "visible" });
    await search(page).fill("guarded-search");
    await searchResults(page).waitFor({ state: "visible" });
    await search(page).press("ArrowDown");
    await search(page).press("ArrowDown");
    await activeOption(page, 1);
    await search(page).press("Enter");
    assert.equal(dialogs.length, 1, "keyboard selection must reach the real unsaved registry confirmation");
    assert.match(dialogs[0], /unsaved/i);
    // The address carries the hub's `?tab=parts` (PR 2), so the page is judged by its path.
    assert.equal(new URL(page.url()).pathname, `/orders/${ctx.created.orderId}`);
    await waitForValue(draft, "Keep this keyboard-search draft");
    await waitForValue(search(page), "guarded-search");
    await activeOption(page, 1);
    await searchResults(page).getByRole("option").nth(1).click();
    assert.equal(dialogs.length, 2, "pointer selection must preserve the same declined confirmation");
    await waitForValue(draft, "Keep this keyboard-search draft");
    await search(page).press("ArrowUp");
    await activeOption(page, 0);
    await search(page).press("Enter");
    await waitForValue(search(page), "");
    assert.equal(dialogs.length, 2, "same-page result must not ask to discard edits");
    await waitForValue(draft, "Keep this keyboard-search draft");
    await shot("global-search-preserves-draft");
    completed = true;
  } finally {
    try { await result.dispose(!completed); }
    finally {
      try {
        await editor.getByRole("button", { name: "Discard changes to serials", exact: true }).click();
        await waitForValue(draft, original);
      } finally { page.off("dialog", dismiss); }
    }
  }
}

export async function run(page, shot, ctx) {
  await runKeyboard(page, shot, ctx);
  await runCancellation(page, shot, ctx);
  await runGuard(page, shot, ctx);
}
