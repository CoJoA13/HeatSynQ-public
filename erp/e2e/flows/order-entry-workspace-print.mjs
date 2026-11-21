import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { entryFixture, readJson, mutate, ownedOrders, holdRequest, archiveEvidence, bounded, openHubTabSettled } from "../lib/order-entry-workspace.mjs";
import { boardRow, hubAnchor, hubTabLabel, openOrderTab } from "../lib/orders.mjs";
import { waitForValue, assertNeverVisible } from "../lib/ui.mjs";
import { routeRequests } from "../route-keep-alive.mjs";

// The hub's sections sit in tabs (the UX redesign's PR 2): every panel stays mounted, the inactive
// ones hidden, and the hub opens on Overview. The Loads and Documents sections are on Loads &
// travelers, so a load box is typed into and `archiveEvidence`'s wait on the Documents list is made
// with that tab open. A hub mounted from history mounts on Overview again: the address put there
// carries no tab.
const LOADS_TAB = hubTabLabel("loads");

/** Opens the hub tab `label` once the hub has consumed its automatic-print query (`print`,
 *  `printIntent`). A tab click rewrites the address from `window.location.search`, as the query's
 *  own removal does, and the later rewrite wins: a click in between could put the query back, and
 *  the next reload would print again. Bounded: a query never consumed is left for the flow's own
 *  checks to report. */

async function intentUrl(page, ctx, result) {
  const key = await page.evaluate(({ orderId, expectedPrintFingerprint }) => {
    const key = `heatsynq:order-print:${crypto.randomUUID()}`;
    sessionStorage.setItem(key, JSON.stringify({ version: 1, orderId,
      expectedPrintFingerprint, selection: { mode: "loads", loadNumbers: [1, 3] } }));
    return key;
  }, { orderId: result.order.id, expectedPrintFingerprint: result.printExpectation });
  return { key, url: `${ctx.baseURL}/orders/${result.order.id}?printIntent=${encodeURIComponent(key)}` };
}
async function createSaved(page, ctx, part, poNumber) {
  return mutate(page, ctx, "/api/orders", { clientRequestId: crypto.randomUUID(), customerId: ctx.fixtures.orderCustomerId,
    poNumber, lines: [{ partId: part.id, qty: 31, weight: 3937 }] });
}
async function historyTo(cdp, entry) {
  await cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id });
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await cdp.send("Runtime.evaluate", { expression: "location.pathname", returnByValue: true, userGesture: false });
    if (result.result.value === new URL(entry.url).pathname) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`History navigation did not reach ${entry.url}`);
}

export async function run(page, shot, ctx) {
  const part = await entryFixture(page, ctx, "E2E-ENTRY-PRINT");
  const before = await ownedOrders(page, ctx);
  // Every print below uses the mounted controller and the actual saved expectation.
  await page.addInitScript(() => { window.open = () => null; });
  const authOrder = await createSaved(page, ctx, part, "ENTRY-AUTH-DELAY");
  const authIntent = await intentUrl(page, ctx, authOrder);
  const authUrl = `${ctx.baseURL}/api/auth/me`;
  let releaseAuth, childAuthArrived;
  const authGate = new Promise(resolve => { releaseAuth = resolve; });
  const childAuth = new Promise(resolve => { childAuthArrived = resolve; });
  const authHandlers = [];
  let bootstrapAuthReads = 0, heldAuthReads = 0, printRequests = 0;
  const printPath = `/api/orders/${authOrder.order.id}/traveler`;
  const countPrints = request => { if (new URL(request.url()).pathname === printPath && request.method() === "POST") printRequests++; };
  const holdAuth = route => {
    const task = (async () => {
      // Shell must confirm identity before it mounts the hub. Admit those real reads
      // until the authorized navigation is visible, including any StrictMode replay.
      // Hub permission effects run after that DOM commit and are held independently.
      const shellReady = await page.getByRole("navigation").getByRole("link", { name: "Parts & processes", exact: true }).isVisible();
      if (shellReady) { heldAuthReads++; childAuthArrived(); await authGate; }
      else bootstrapAuthReads++;
      // This read is issued after a deliberate hold, when the pooled keep-alive socket may have
      // idled past the dev server's timeout: one reset socket is survived (Playwright retries
      // ECONNRESET only), as the suite's other reads after a wait do.
      await route.fulfill({ response: await page.request.get(authUrl, { maxRetries: 1 }) });
    })().then(() => null, async error => { await route.abort().catch(() => {}); return error; });
    authHandlers.push(task);
    return task;
  };
  const stopHoldAuth = await routeRequests(page, authUrl, holdAuth);
  page.on("request", countPrints);
  try {
    const orderRead = page.waitForResponse(r => new URL(r.url()).pathname === `/api/orders/${authOrder.order.id}` && r.request().method() === "GET");
    await page.goto(authIntent.url);
    assert.equal((await orderRead).status(), 200);
    await page.getByRole("heading", { name: `Order #${authOrder.order.orderNumber}`, exact: true }).waitFor();
    await bounded(childAuth, "The mounted order must request its own permissions after shell bootstrap");
    assert.ok(bootstrapAuthReads > 0, "Real shell identity reads must be admitted before mounting the order");
    assert.ok(heldAuthReads > 0, "Mounted order permission reads must remain held after its GET succeeds");
    assert.equal(printRequests, 0, "Unresolved auth cannot consume or print the intent");
    assert.ok(await page.evaluate(key => sessionStorage.getItem(key), authIntent.key));
    releaseAuth();
    assert.deepEqual((await bounded(Promise.all(authHandlers), "Auth responses drain")).filter(Boolean), []);
    await openHubTabSettled(page, LOADS_TAB);
    await archiveEvidence(page, ctx, authOrder, [1, 3], shot, "delayed-auth-popup-blocked", true);
    assert.equal(printRequests, 1);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), authIntent.key), null);
    await page.getByText(/blocked|saved traveler/i).first().waitFor();
  } finally {
    releaseAuth();
    await bounded(Promise.all(authHandlers), "Join auth route handlers");
    await stopHoldAuth();
    page.off("request", countPrints);
  }

  const staleOrder = await createSaved(page, ctx, part, "ENTRY-STALE-PRINT");
  const staleIntent = await intentUrl(page, ctx, staleOrder);
  await mutate(page, ctx, `/api/orders/${staleOrder.order.id}/loads`, [
    { loadNumber: 1, qty: 14, weight: 1778 }, { loadNumber: 2, qty: 15, weight: 1905 }, { loadNumber: 3, qty: 2, weight: 254 },
  ], "PUT");
  const refused = page.waitForResponse(r => new URL(r.url()).pathname === `/api/orders/${staleOrder.order.id}/traveler` && r.request().method() === "POST");
  await page.goto(staleIntent.url);
  assert.equal((await refused).status(), 412, "Persisted load change is refused under the print claim");
  await page.getByText(/Its loads or order details changed after save/).waitFor();
  assert.equal((await readJson(page, ctx, `/api/orders/${staleOrder.order.id}/documents`)).length, 0);
  assert.equal(await page.evaluate(key => sessionStorage.getItem(key), staleIntent.key), null);
  await page.reload();
  await page.getByRole("heading", { name: `Order #${staleOrder.order.orderNumber}`, exact: true }).waitFor();
  assert.equal((await readJson(page, ctx, `/api/orders/${staleOrder.order.id}/documents`)).length, 0);
  await shot("changed-saved-plan-refused");

  const ambiguousOrder = await createSaved(page, ctx, part, "ENTRY-AMBIGUOUS-PRINT");
  const ambiguousIntent = await intentUrl(page, ctx, ambiguousOrder);
  const lost = await holdRequest(page, ctx, `/api/orders/${ambiguousOrder.order.id}/traveler`, { lose: true });
  let original;
  try {
    await page.goto(ambiguousIntent.url);
    const committed = await lost.arrived();
    assert.equal(committed.response.status(), 200);
    assert.deepEqual(committed.data.selection, { mode: "loads", loadNumbers: [1, 3] });
    assert.equal(committed.data.expectedPrintFingerprint, ambiguousOrder.printExpectation);
    original = { id: committed.response.headers()["x-document-id"], bytes: await committed.response.body() };
    assert.ok(original.id);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), ambiguousIntent.key), null, "Intent is consumed before receiving the print response");
    await lost.close();
  } finally { await lost.close(); }
  await page.getByText(/Review the document archive before printing again/).waitFor();
  assert.equal((await readJson(page, ctx, `/api/orders/${ambiguousOrder.order.id}/documents`)).length, 1);
  await page.reload();
  await page.getByRole("heading", { name: `Order #${ambiguousOrder.order.orderNumber}`, exact: true }).waitFor();
  await openHubTabSettled(page, LOADS_TAB);
  const recovered = await archiveEvidence(page, ctx, ambiguousOrder, [1, 3], shot, "ambiguous-print-archive-recovery", true);
  assert.equal(recovered.id, original.id);
  assert.deepEqual(recovered.bytes, original.bytes);

  // Mandatory first-mount race. The draft is produced by actual load typing, then
  // retained across native same-document history. Only navigation metadata is set up:
  // the native History prototype changes the existing entry's query without firing
  // Next's current-instance URL wrapper. Forward mounts the real hub from that entry.
  const retainedOrder = await createSaved(page, ctx, part, "ENTRY-RETAINED-FIRST-MOUNT");
  // Reuse the clean saved order but produce a fresh real draft for each mechanism.
  // Both cases share the exact auth/order-response ordering and irreversible guards.
  for (const mode of ["selected", "legacy"]) {
    await page.goto(ctx.baseURL);
    const row = await boardRow(page, retainedOrder.order.orderNumber);
    await row.click();
    await openOrderTab(page, LOADS_TAB);
    await waitForValue(page.getByLabel("Load 1 weight", { exact: true }), "1905");
    await page.getByLabel("Load 1 weight", { exact: true }).fill("1888");
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "Save loads" && !button.disabled));
    const retainedIntent = mode === "selected" ? await intentUrl(page, ctx, retainedOrder)
      : { key: null, url: `${ctx.baseURL}/orders/${retainedOrder.order.id}?print=1` };
    await page.evaluate(url => History.prototype.replaceState.call(history, history.state, "", url), retainedIntent.url);
    const cdp = await page.context().newCDPSession(page);
    let firstRead;
    let forwardAuthReads = [];
    const noteForwardAuth = request => { if (new URL(request.url()).pathname === "/api/auth/me") forwardAuthReads.push(request); };
    let retainedPrints = 0;
    const observeRetained = request => {
      if (new URL(request.url()).pathname === `/api/orders/${retainedOrder.order.id}/traveler` && request.method() === "POST") retainedPrints++;
    };
    page.on("request", observeRetained);
    try {
      const history = await cdp.send("Page.getNavigationHistory");
      await historyTo(cdp, history.entries[history.currentIndex - 1]);
      await page.getByRole("navigation").getByRole("link", { name: "Parts & processes", exact: true }).waitFor();
      firstRead = await holdRequest(page, ctx, `/api/orders/${retainedOrder.order.id}`, { method: "GET", before: true });
      // Only an identity read issued by the forward navigation counts (#340): the board mounted by
      // the back step issues its own read, whose late answer used to satisfy this wait early.
      forwardAuthReads = [];
      page.on("request", noteForwardAuth);
      const authReady = page.waitForResponse(r => forwardAuthReads.includes(r.request()) && r.ok());
      await historyTo(cdp, history.entries[history.currentIndex]);
      await firstRead.arrived();
      await authReady;
      // Release only; the route is removed in `finally`. Removing it here once stranded a request
      // of the mounting hub (#340: it was the page's last route, so interception turned off). The
      // hold's route is no longer a page's last (#342), and the hub still needs no removal here.
      firstRead.release();
      await page.getByRole("heading", { name: `Order #${retainedOrder.order.orderNumber}`, exact: true }).waitFor();
      // The automatic request is decided and consumed as the drafts become ready, which is when
      // the recovery panel shows: the tab is opened once that query is gone (see openHubTabSettled).
      await openHubTabSettled(page, LOADS_TAB);
      const recovery = (await hubAnchor(page, "loads")).getByRole("complementary", { name: "Draft recovery", exact: true });
      await recovery.getByText("1888", { exact: true }).waitFor();
      // Wait (bounded) for the automatic request to be decided rather than for a fixed interval:
      // decided means the query is gone, the handoff intent is taken, and the refusal is shown.
      // The state is then asserted field by field below, so a timeout here still reports which part
      // never happened.
      await page.waitForFunction(({ param, key }) => !new URL(location.href).searchParams.has(param) &&
        (key === null || sessionStorage.getItem(key) === null) &&
        document.body.innerText.includes("Automatic printing was not started"),
      { param: mode === "selected" ? "printIntent" : "print", key: retainedIntent.key }, { timeout: 10_000 }).catch(() => {});
      const refusalShown = await page.getByText(/Automatic printing was not started/).first().isVisible();
      const retainedShot = await shot(mode === "selected" ? "retained-draft-first-mount-before-restore" : "legacy-retained-first-mount-before-restore");
      const retainedDocuments = await readJson(page, ctx, `/api/orders/${retainedOrder.order.id}/documents`);
      const retainedIntentValue = retainedIntent.key === null ? null : await page.evaluate(key => sessionStorage.getItem(key), retainedIntent.key);
      const automaticQueryRemoved = !new URL(page.url()).searchParams.has(mode === "selected" ? "printIntent" : "print");
      await fs.writeFile(path.join(path.dirname(retainedShot), mode === "selected" ? "retained-first-mount.json" : "legacy-retained-first-mount.json"), JSON.stringify({
        mode, orderId: retainedOrder.order.id, orderNumber: retainedOrder.order.orderNumber, automaticQueryRemoved,
        travelerPostCount: retainedPrints, documents: retainedDocuments, intentConsumed: retainedIntentValue === null,
        refusalShown, recoveryText: await recovery.innerText(),
      }, null, 2));
      // Check the irreversible boundary before Restore: an unintended print changes
      // the baseline and turns the genuine retained draft into a conflict with no Restore.
      assert.equal(retainedPrints, 0, `${mode}: a retained traveler-affecting draft must block the FIRST mounted automatic print`);
      assert.equal(retainedDocuments.length, 0, "First mounted print cannot archive over the retained load draft");
      assert.equal(retainedIntentValue, null, "Blocked intent is consumed, never deferred until Restore");
      assert.equal(automaticQueryRemoved, true, `${mode}: the blocked automatic request is consumed before Restore`);
      assert.equal(refusalShown, true, `${mode}: the consumed request is reported as refused, not started`);
      await recovery.getByRole("button", { name: "Restore", exact: true }).click();
      await waitForValue(page.getByLabel("Load 1 weight", { exact: true }), "1888");
      assert.equal((await readJson(page, ctx, `/api/orders/${retainedOrder.order.id}`)).loads[0].weight, 1905);
      await (await hubAnchor(page, "loads")).getByRole("button", { name: "Discard changes to loads", exact: true }).click();
      await waitForValue(page.getByLabel("Load 1 weight", { exact: true }), "1905");
      await page.waitForTimeout(500); // Observe any automatic effect unlocked by discard.
      assert.equal(retainedPrints, 0, `${mode}: clearing the draft cannot trigger deferred printing`);
      assert.equal((await readJson(page, ctx, `/api/orders/${retainedOrder.order.id}/documents`)).length, 0,
        `${mode}: discarding the retained draft must not archive a deferred print`);
    } finally {
      await firstRead?.close();
      page.off("request", noteForwardAuth);
      page.off("request", observeRetained);
      await cdp.detach();
    }
  }

  // The slow-permission ordering (#340, #341). The hub's drafts are ready and blocking while its
  // permission read is still out; the draft is then cleared; only then do permissions arrive. The
  // request was refused when the drafts were first judged, and clearing them must not turn it into
  // a print. In the loop above permissions land while the draft still exists, so the print gate is
  // closed whatever the wiring passes; here the gate is open by the time the request is decided,
  // and only the judgement made at first readiness stands between the request and a traveler.
  for (const mode of ["selected", "legacy"]) {
    await page.goto(ctx.baseURL);
    await (await boardRow(page, retainedOrder.order.orderNumber)).click();
    await openOrderTab(page, LOADS_TAB);
    await waitForValue(page.getByLabel("Load 1 weight", { exact: true }), "1905");
    await page.getByLabel("Load 1 weight", { exact: true }).fill("1888");
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "Save loads" && !button.disabled));
    const slowIntent = mode === "selected" ? await intentUrl(page, ctx, retainedOrder)
      : { key: null, url: `${ctx.baseURL}/orders/${retainedOrder.order.id}?print=1` };
    const param = mode === "selected" ? "printIntent" : "print";
    await page.evaluate(url => History.prototype.replaceState.call(history, history.state, "", url), slowIntent.url);
    const cdp = await page.context().newCDPSession(page);
    const partsLink = page.getByRole("navigation").getByRole("link", { name: "Parts & processes", exact: true });
    let releaseHub, hubReadArrived;
    const hubGate = new Promise(resolve => { releaseHub = resolve; });
    const hubRead = new Promise(resolve => { hubReadArrived = resolve; });
    const slowHandlers = [];
    let heldHubReads = 0, slowPrints = 0;
    const observeSlow = request => {
      if (new URL(request.url()).pathname === `/api/orders/${retainedOrder.order.id}/traveler` && request.method() === "POST") slowPrints++;
    };
    const holdPermissions = route => {
      const task = (async () => {
        // The Shell re-checks identity on no route change (R2, #607), so every identity read after
        // the forward traversal is the mounted hub's permission read, and it is held. The Shell's
        // navigation stays drawn throughout: a read with it hidden would be a re-check's, and the
        // assertion below that the holding screen never shows is what proves there is none.
        if (await partsLink.isVisible()) { heldHubReads++; hubReadArrived(); await hubGate; }
        await route.fulfill({ response: await page.request.get(authUrl, { maxRetries: 1 }) });
      })().then(() => null, async error => { await route.abort().catch(() => {}); return error; });
      slowHandlers.push(task);
      return task;
    };
    let stopHoldPermissions;
    page.on("request", observeSlow);
    try {
      const history = await cdp.send("Page.getNavigationHistory");
      await historyTo(cdp, history.entries[history.currentIndex - 1]);
      await partsLink.waitFor();
      stopHoldPermissions = await routeRequests(page, authUrl, holdPermissions);
      // The Shell re-checks nothing on the route change (R2, #607): no holding screen, the hub
      // mounts once under the rail that never went away. Armed before the traversal, so a
      // re-check's holding screen, which came up at once before the hub, would be seen.
      const noHoldingScreen = assertNeverVisible(page.getByRole("button", { name: "Retry session check", exact: true }), `${mode}: a route change raises no session holding screen`, 3000);
      await historyTo(cdp, history.entries[history.currentIndex]);
      await page.getByRole("heading", { name: `Order #${retainedOrder.order.orderNumber}`, exact: true }).waitFor();
      await noHoldingScreen;
      await bounded(hubRead, `${mode}: the mounted order must request its permissions after the Shell is ready`);
      const drafts = page.getByRole("button", { name: /^Drafts in this tab/ });
      await page.getByRole("button", { name: "Drafts in this tab (1)", exact: true }).waitFor();
      // The hold is real: with permissions still out, nothing has been decided or consumed.
      assert.ok(heldHubReads > 0, `${mode}: the order's permission read must still be held`);
      assert.equal(slowPrints, 0, `${mode}: nothing prints while permissions are unresolved`);
      assert.ok(new URL(page.url()).searchParams.has(param), `${mode}: the automatic request is not consumed before permissions arrive`);
      if (slowIntent.key !== null) assert.ok(await page.evaluate(key => sessionStorage.getItem(key), slowIntent.key), "The handoff intent is still stored");
      // Clear the retained draft without an identity read, through the Shell's own panel.
      await drafts.click();
      const list = page.getByRole("region", { name: "Drafts in this tab", exact: true });
      await list.locator("li").first().waitFor();
      assert.equal(await list.locator("li").count(), 1, `${mode}: exactly the one retained load draft is listed`);
      await list.getByRole("button", { name: "Discard", exact: true }).click();
      await list.getByText("No unsaved drafts.", { exact: true }).waitFor();
      await list.getByRole("button", { name: "Close", exact: true }).click();
      // The draft store is empty, which is what the print gate reads. (The hub's own recovery
      // panel is still drawn at this point; it is not what the gate or the wiring consults.)
      await page.getByRole("button", { name: "Drafts in this tab (0)", exact: true }).waitFor();
      assert.equal(slowPrints, 0, `${mode}: clearing the draft prints nothing while permissions are still out`);
      assert.ok(new URL(page.url()).searchParams.has(param), `${mode}: clearing the draft decides nothing by itself`);
      // Permissions arrive with no draft left and the print gate open.
      releaseHub();
      assert.deepEqual((await bounded(Promise.all(slowHandlers), `${mode}: permission responses drain`)).filter(Boolean), []);
      await page.waitForFunction(({ param, key }) => !new URL(location.href).searchParams.has(param) &&
        (key === null || sessionStorage.getItem(key) === null) &&
        document.body.innerText.includes("Automatic printing was not started"),
      { param, key: slowIntent.key }, { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(500); // Observe a print the decision may have started.
      await shot(mode === "selected" ? "slow-permission-draft-cleared" : "legacy-slow-permission-draft-cleared");
      assert.equal(slowPrints, 0, `${mode}: a request refused at the drafts' first readiness stays refused once they are cleared`);
      assert.equal((await readJson(page, ctx, `/api/orders/${retainedOrder.order.id}/documents`)).length, 0,
        `${mode}: no traveler is archived for the refused request`);
      assert.equal(new URL(page.url()).searchParams.has(param), false, `${mode}: the refused request is consumed`);
      if (slowIntent.key !== null) assert.equal(await page.evaluate(key => sessionStorage.getItem(key), slowIntent.key), null, "The refused intent is consumed");
      assert.equal(await page.getByText(/Automatic printing was not started/).first().isVisible(), true,
        `${mode}: the consumed request is reported as refused`);
      // Read with its tab open, after the query checks above: a tab click rewrites the address.
      await openOrderTab(page, LOADS_TAB);
      await waitForValue(page.getByLabel("Load 1 weight", { exact: true }), "1905");
    } finally {
      releaseHub();
      await bounded(Promise.all(slowHandlers), "Join permission route handlers");
      await stopHoldPermissions?.();
      page.off("request", observeSlow);
      await cdp.detach();
    }
  }
  assert.equal((await ownedOrders(page, ctx)).length, before.length + 4, "All print recovery paths leave the four fixture orders intact");
}
