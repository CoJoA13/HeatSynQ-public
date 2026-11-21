// #318: exercise real scan lookup against the flow-owned order, including another writer's
// load changes. Restore its original loads so later shipment/invoice flows keep their fixture.
import assert from "node:assert/strict";
import { assertNeverVisible, waitForValue } from "./ui.mjs";
import { routeRequests } from "../route-keep-alive.mjs";
import { panelMessage, waitForRedLines } from "./refusal-lines.mjs";

export async function exerciseTravelerScans(page, shot, ctx) {
  const { orderId, orderNumber } = ctx.created;
  const url = `${ctx.baseURL}/api/orders/${orderId}`;
  const response = await page.request.get(url, { maxRetries: 1 });
  assert.equal(response.status(), 200);
  const original = (await response.json()).loads.map(({ loadNumber, qty, weight }) => ({
    loadNumber, qty, weight: weight === null ? null : String(weight),
  }));
  const five = [1, 2, 3, 4, 5].map(loadNumber => ({ loadNumber, qty: 14, weight: "110.00" }));
  async function replace(data) {
    const result = await ctx.apiMutate(page, `${url}/loads`, { method: "PUT", data });
    assert.equal(result.status(), 200, "flow-owned load replacement must succeed");
  }
  const search = page.getByPlaceholder("Search order, PO, part, customer", { exact: false });
  const section = page.locator("#loads");
  // PR 2: the scan's hash opens the hub's Loads & travelers tab; the row is read once it has.
  const loadsTab = page.getByRole("tab", { name: /^Loads & travelers/, selected: true }); // the badge may follow the name
  const searchResults = page.getByRole("listbox", { name: "Search results", exact: true });
  async function scan(load, via = "enter") {
    const previousScan = new URL(page.url()).searchParams.get("scan");
    await search.fill(`${orderNumber}-${load}`);
    if (via === "click") {
      await searchResults.getByRole("option", { name: new RegExp(`Load ${load} ·`) }).click();
    } else {
      if (via === "arrow") {
        await searchResults.getByRole("option", { name: new RegExp(`Load ${load} ·`) }).waitFor();
        await search.press("ArrowDown");
      }
      await search.press("Enter");
    }
    await page.waitForURL(u => u.pathname === `/orders/${orderId}` && u.searchParams.get("load") === String(load)
      && u.searchParams.has("scan") && u.searchParams.get("scan") !== previousScan);
  }
  async function highlighted(load) {
    await loadsTab.waitFor({ state: "visible", timeout: 15000 });
    await section.getByRole("status").filter({ hasText: `Scanned Load ${load} is highlighted below.` }).waitFor();
    const row = section.locator('tr[aria-current="true"]');
    assert.equal(await row.count(), 1, "only one load can be selected");
    assert.equal(await row.getByLabel(`Load ${load} number`, { exact: true }).inputValue(), String(load));
    const box = await row.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(box && viewport && box.y >= 0 && box.y + box.height <= viewport.height,
      "scanning brings the matching load into view");
  }
  let dialogCount = 0;
  const dialog = d => { dialogCount += 1; void d.dismiss(); };
  page.on("dialog", dialog);
  try {
    // The current page still holds the old load list: this simulates another writer.
    await replace(five);
    await scan(2); await highlighted(2);
    for (const [load, via] of [[1, "enter"], [3, "click"], [4, "arrow"], [5, "enter"]]) {
      await scan(load, via); await highlighted(load);
    }
    await shot("traveler-load-five-highlighted");

    // A repeated identical scan must also refresh, including changes from another session.
    await replace(five.map(load => load.loadNumber === 5 ? { ...load, weight: "111.00" } : load));
    const before = page.url();
    await scan(5);
    await page.waitForURL(u => u.toString() !== before);
    await highlighted(5);
    await waitForValue(page.getByLabel("Load 5 weight", { exact: true }), "111");

    // A failed same-order refresh can be retried in place without leaving row printing stuck.
    const failRead = route => route.fulfill({ status: 503, contentType: "application/json",
      body: JSON.stringify({ error: "Simulated unavailable order read" }) });
    const stopFailRead = await routeRequests(page, url, failRead);
    try {
      await scan(2);
      await section.getByRole("status").filter({ hasText: "Could not refresh this load" }).waitFor();
      await assertNeverVisible(section.locator("button:not(:disabled)").filter({ hasText: /^Print Load \d+ traveler$/ }),
        "an unavailable editor must not expose an enabled per-load print action");
    } finally {
      await stopFailRead();
    }
    await section.getByRole("button", { name: "Refresh order before printing", exact: true }).click();
    await highlighted(2);
    await section.getByRole("button", { name: "Print Load 2 traveler", exact: true }).waitFor();
    assert.equal(await section.getByRole("button", { name: "Print Load 2 traveler", exact: true }).isEnabled(), true,
      "a successful retry restores printing for the verified saved load");

    await page.getByLabel("Load 1 weight", { exact: true }).fill("109.25");
    await page.getByLabel("Load 1 number", { exact: true }).fill("0");
    await section.getByRole("button", { name: "Save loads", exact: true }).click();
    // Every refusal is listed: the refused load # and the numbering line a refused load # also brings.
    const actionErrorLines = [
      "Load 1: load # must be a whole number of at least 1.",
      "Load numbers must be 1..N with no gaps or repeats — try Renumber.",
    ];
    await waitForRedLines(panelMessage(section), actionErrorLines);
    await assertNeverVisible(page.locator("p.mb-3.bg-red-50"),
      "a refused Save loads must show under the Loads grid, not in the page's banner", 300);
    await scan(2);
    await section.getByRole("status").filter({ hasText: "Save or discard load edits" }).waitFor();
    assert.equal(await section.locator('tr[aria-current="true"]').count(), 0,
      "unsaved load edits must not be labeled as a confirmed scan match");
    assert.equal(await page.getByLabel("Load 1 weight", { exact: true }).inputValue(), "109.25");
    assert.equal(dialogCount, 0, "same-order scans never discard or prompt about surviving drafts");
    // A scan refresh cannot clear an action's validation error: the same lines are still listed.
    await waitForRedLines(panelMessage(section), actionErrorLines, 2000);
    await section.getByRole("button", { name: "Discard changes to loads", exact: true }).click();
    await highlighted(2);

    for (const suffix of ["6", "0"]) {
      const current = page.url();
      await search.fill(`${orderNumber}-${suffix}`); await search.press("Enter");
      await page.getByText(/Invalid traveler barcode|No current load matches traveler/).waitFor();
      assert.equal(page.url(), current, "an invalid or missing load must not navigate elsewhere");
    }
    // A pause during manual entry and unmatched alphanumeric identifiers are normal
    // searches, including after Enter. Neither may report a bad barcode or navigate.
    for (const term of [`1001-A-${orderNumber}`, `${orderNumber}-`, `${orderNumber}-2-extra`]) {
      const current = page.url();
      await search.fill(term);
      await searchResults.getByText("No matches", { exact: true }).waitFor();
      await assertNeverVisible(page.getByText(/Invalid traveler barcode|No current load matches traveler/),
        "ordinary empty searches must not display a barcode error while typing");
      const response = page.waitForResponse(r => {
        const u = new URL(r.url());
        return u.pathname === "/api/search" && u.searchParams.get("q") === term;
      });
      await search.press("Enter");
      assert.equal((await response).status(), 200);
      await searchResults.getByText("No matches", { exact: true }).waitFor();
      await assertNeverVisible(page.getByText(/Invalid traveler barcode|No current load matches traveler/),
        "ordinary empty searches must not display a barcode error after Enter");
      assert.equal(page.url(), current, "an incomplete or alphanumeric query must not select a load");
    }
    // Existing paper remains usable and clears the load-specific selection.
    await search.fill(String(orderNumber)); await search.press("Enter");
    await page.waitForURL(u => u.pathname === `/orders/${orderId}` && !u.search);
    assert.equal(await section.locator('tr[aria-current="true"]').count(), 0);
  } finally {
    page.off("dialog", dialog);
    await replace(original);
  }
}
