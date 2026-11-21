import assert from "node:assert/strict";
import { entryFixture, startEntry, entryTab, waitPlan, saveEntry, readJson, mutate, ownedOrders, holdRequest, archiveEvidence, SAVE_PRINT } from "../lib/order-entry-workspace.mjs";
import { waitForValue, assertNeverVisible } from "../lib/ui.mjs";
import { routeRequests } from "../route-keep-alive.mjs";

// What New order says when its Save was answered with a 2xx the page could not read (#547, the
// owner's answer of 2026-10-18).
const ORDER_ANSWER_UNREADABLE = "The order was saved, but the answer could not be read. Click Save only again to open it. "
  + "Its travelers will not print automatically, and save warnings were not shown: check the customer's credit hold "
  + "on the customer page and the order's Serials.";

export async function run(page, shot, ctx) {
  const part = await entryFixture(page, ctx, "E2E-ENTRY-RECOVERY");
  await startEntry(page, ctx, part, 30);
  await entryTab(page, "Order details");
  await page.getByText("Draft saved", { exact: true }).waitFor();
  const old = await holdRequest(page, ctx, "/api/order-drafts", { method: "PUT" });
  let newer;
  try {
    await page.getByLabel("PO number", { exact: true }).fill("OLD-ACK");
    assert.equal((await old.arrived()).response.status(), 200);
    newer = await holdRequest(page, ctx, "/api/order-drafts", { method: "PUT", before: true,
      match: request => request.postDataJSON().payload.poOverride === "NEW-UNACKNOWLEDGED" });
    await page.getByLabel("PO number", { exact: true }).fill("NEW-UNACKNOWLEDGED");
    await old.close();
    await newer.arrived();
    await assertNeverVisible(page.getByText("Draft saved", { exact: true }), "Old acknowledgement must not label newer edits saved", 500);
    assert.equal((await readJson(page, ctx, "/api/order-drafts")).payload.poOverride, "OLD-ACK");
    await newer.close();
    await page.getByText("Draft saved", { exact: true }).waitFor();
    assert.equal((await readJson(page, ctx, "/api/order-drafts")).payload.poOverride, "NEW-UNACKNOWLEDGED");
  } finally { await old.close(); await newer?.close(); }
  const draftUrl = `${ctx.baseURL}/api/order-drafts`;
  const failAutosave = route => route.request().method() === "PUT"
    ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Fictional autosave outage" }) }) : route.continue();
  const stopFailAutosave = await routeRequests(page, draftUrl, failAutosave);
  try {
    await page.getByLabel("PO number", { exact: true }).fill("FAILED-AUTOSAVE-RETAINED");
    await page.getByText("Draft autosave failed", { exact: true }).waitFor();
    await waitForValue(page.getByLabel("PO number", { exact: true }), "FAILED-AUTOSAVE-RETAINED");
    assert.equal((await readJson(page, ctx, "/api/order-drafts")).payload.poOverride, "NEW-UNACKNOWLEDGED");
  } finally { await stopFailAutosave(); }
  await page.getByLabel("PO number", { exact: true }).fill("NEW-UNACKNOWLEDGED");
  await page.getByText("Draft saved", { exact: true }).waitFor();
  await entryTab(page, "Parts & containers");
  await page.getByLabel("Line 1 quantity", { exact: true }).fill("not-a-quantity");
  await page.getByText("Draft saved", { exact: true }).waitFor();
  assert.equal((await readJson(page, ctx, "/api/order-drafts")).payload.lines[0].qty, "not-a-quantity");
  // Exercise real reload of a legacy persisted payload with the optional additions absent.
  const legacy = (await readJson(page, ctx, "/api/order-drafts")).payload;
  delete legacy.loadAdjustmentDraft;
  delete legacy.travelerSelection;
  await mutate(page, ctx, "/api/order-drafts", { payload: legacy }, "PUT");
  await page.reload();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await entryTab(page, "Order details");
  await waitForValue(page.getByLabel("PO number", { exact: true }), "NEW-UNACKNOWLEDGED");
  await entryTab(page, "Parts & containers");
  await waitForValue(page.getByLabel("Line 1 quantity", { exact: true }), "not-a-quantity");
  await entryTab(page, "Order details");
  await page.getByRole("button", { name: "Save only", exact: true }).click();
  assert.equal(await page.getByRole("tab", { name: "Parts & containers", exact: true }).getAttribute("aria-selected"), "true");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Line 1 quantity");
  await shot("raw-draft-reload-and-validation-focus");
  await page.getByLabel("Line 1 quantity", { exact: true }).fill("30");
  await entryTab(page, "Process & loads");
  await waitPlan(page, 2);
  await waitForValue(page.locator("#entry-traveler-selection"), "all");
  assert.equal(await page.getByRole("button", { name: "Adjust for this order", exact: true }).isEnabled(), true);

  const before = await ownedOrders(page, ctx);
  const lost = await holdRequest(page, ctx, "/api/orders", { lose: true });
  let committed;
  try {
    await page.getByRole("button", { name: SAVE_PRINT(2), exact: true }).click();
    const held = await lost.arrived();
    assert.equal(held.response.status(), 200);
    committed = await held.response.json();
    assert.equal((await ownedOrders(page, ctx)).length, before.length + 1, "Lost response still has one committed order");
    await lost.close();
  } finally { await lost.close(); }
  await page.getByRole("button", { name: "Save only", exact: true }).waitFor({ state: "visible" });
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "Save only" && !button.disabled));
  await entryTab(page, "Parts & containers");
  await waitForValue(page.getByLabel("Line 1 quantity", { exact: true }), "30");
  await mutate(page, ctx, `/api/parts/${part.id}`, { loadQty: 14 }, "PATCH");
  await entryTab(page, "Process & loads");
  const replay = await saveEntry(page, ctx, { print: true, count: 2 });
  assert.equal(replay.deduped, true, "Lost-response retry deduplicates before stale preview validation");
  assert.equal(replay.order.id, committed.order.id);
  assert.equal((await ownedOrders(page, ctx)).length, before.length + 1);
  assert.equal((await readJson(page, ctx, `/api/orders/${replay.order.id}/documents`)).length, 0, "A replay never automatically prints");
  await shot("lost-create-response-replayed-for-review");

  // Both mounted pages resume the actual same server draft and request nonce.
  await startEntry(page, ctx, part, 31);
  await entryTab(page, "Process & loads");
  await waitPlan(page, 3);
  await page.getByText("Draft saved", { exact: true }).waitFor();
  const shared = await readJson(page, ctx, "/api/order-drafts");
  const second = await page.context().newPage();
  try {
    await second.goto(`${ctx.baseURL}/orders/new`);
    await second.getByRole("button", { name: "Resume", exact: true }).click();
    await entryTab(second, "Process & loads");
    await waitPlan(second, 3);
    const firstRequest = page.waitForRequest(r => new URL(r.url()).pathname === "/api/orders" && r.method() === "POST");
    const first = await saveEntry(page, ctx, { print: true, count: 3 });
    assert.equal((await firstRequest).postDataJSON().clientRequestId, shared.payload.clientRequestId);
    await archiveEvidence(page, ctx, first, [1, 2, 3], shot, "two-tab-first-print");
    await mutate(page, ctx, `/api/parts/${part.id}`, { loadQty: 13 }, "PATCH");
    const secondRequest = second.waitForRequest(r => new URL(r.url()).pathname === "/api/orders" && r.method() === "POST");
    const duplicate = await saveEntry(second, ctx, { print: true, count: 3 });
    assert.equal((await secondRequest).postDataJSON().clientRequestId, shared.payload.clientRequestId);
    assert.equal(duplicate.deduped, true);
    assert.equal(duplicate.order.id, first.order.id);
    assert.equal((await ownedOrders(page, ctx)).length, before.length + 2);
    assert.equal((await readJson(page, ctx, `/api/orders/${first.order.id}/documents`)).length, 1, "Second mounted tab cannot archive another traveler");
  } finally { await second.close(); }

  // A Save & Print the server commits but whose answer the page cannot read (#547): the page's copy
  // is answered 200 with the answer cut short. The draft is frozen as after a save that lands, so
  // nothing sends it again, and Save, as the owner's sentence says, opens the order it committed.
  await startEntry(page, ctx, part, 32);
  await entryTab(page, "Process & loads");
  // The part's load quantity is 13 since the step above, so 32 pieces make three loads.
  await waitPlan(page, 3);
  await page.getByText("Draft saved", { exact: true }).waitFor();
  const beforeUnreadable = await ownedOrders(page, ctx);
  const unreadable = await holdRequest(page, ctx, "/api/orders", { unreadable: true });
  let saved, sentRequestId;
  try {
    await page.getByRole("button", { name: SAVE_PRINT(3), exact: true }).click();
    const held = await unreadable.arrived();
    assert.equal(held.response.status(), 200);
    saved = await held.response.json();
    sentRequestId = held.data.clientRequestId;
    assert.equal(typeof sentRequestId, "string", "The held save carries its draft's request key");
    assert.equal((await ownedOrders(page, ctx)).length, beforeUnreadable.length + 1, "An unreadable answer still has one committed order");
    await unreadable.close();
  } finally { await unreadable.close(); }
  const notice = page.getByRole("alert").filter({ hasText: ORDER_ANSWER_UNREADABLE });
  await notice.waitFor();
  assert.equal(((await notice.textContent()) ?? "").trim(), `${ORDER_ANSWER_UNREADABLE}Review in Process & loads`,
    "The page must say the owner's sentence, and nothing else beside its Review control");
  await page.waitForFunction(() => document.activeElement?.id === "entry-save");
  assert.equal(await page.locator("#entry-save").isDisabled(), false, "Save stays enabled after an unreadable answer");
  await assertNeverVisible(page.getByRole("heading", { name: /^Order #\d+/ }), "An unreadable answer must not open the order", 500);
  // Longer than the autosave's two-second wait: the page sends no draft write at all. The counter
  // starts only once the checks above have run, so a write sent before it would be missed by it;
  // the draft read below would then find the draft stored again, and fails in its place.
  const draftWrites = [];
  const noteDraftWrite = request => {
    if (new URL(request.url()).pathname === "/api/order-drafts" && ["PUT", "DELETE"].includes(request.method())) draftWrites.push(request.method());
  };
  page.on("request", noteDraftWrite);
  try { await page.waitForTimeout(3000); } finally { page.off("request", noteDraftWrite); }
  assert.deepEqual(draftWrites, [], "An unreadable answer must not send the draft again");
  assert.equal((await readJson(page, ctx, "/api/order-drafts"))?.payload ?? null, null, "The committed save's draft clear stands");
  await shot("unreadable-create-answer");
  // Plain Save, the control the sentence names and the cursor is on: the same request, deduplicated.
  const retryRequest = page.waitForRequest(r => new URL(r.url()).pathname === "/api/orders" && r.method() === "POST");
  const reopened = await saveEntry(page, ctx);
  assert.equal((await retryRequest).postDataJSON().clientRequestId, sentRequestId, "Save resends the frozen draft's request key");
  assert.equal(reopened.deduped, true, "Save after an unreadable answer deduplicates into the committed order");
  assert.equal(reopened.order.id, saved.order.id);
  assert.equal((await ownedOrders(page, ctx)).length, beforeUnreadable.length + 1);
  assert.equal((await readJson(page, ctx, `/api/orders/${reopened.order.id}/documents`)).length, 0,
    "Neither the Save & Print whose answer was unreadable nor the Save after it prints");
  await shot("unreadable-create-reopened");
}
