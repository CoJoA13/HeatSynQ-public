// #348: the controls the owner reported dead on the production install's plain-HTTP LAN address,
// driven in a REAL insecure browser context against the real server.
//
// Every other flow browses `http://localhost`, which Chromium treats as a secure context, so
// `crypto.randomUUID` exists there and no flow could see that client code threw without it.
// This one re-signs in on `http://heatsynq.test:<port>`: the same server, reached through a name
// the shared browser alone resolves to loopback (e2e/lib/insecure-origin.mjs). The session cookie
// is host-scoped, so the sign-in happens on that origin. It goes through this flow's own page, so
// the harness's request counters see everything that follows. The environment is PROVED before
// anything is clicked: a green run on an origin that quietly turned out to be secure would prove
// nothing.
//
// The part and the order are this flow's own. They are created through the counted
// `ctx.apiMutate` on the harness's localhost session, which stays valid alongside the new one. An
// APIRequestContext call is issued from Node, which cannot resolve the mapped name, so those writes
// cannot target the insecure origin anyway. They are reaped by exact natural key: the part number
// comes from the fixtures payload, and the order falls under the owned order customer.
//
// Shared state is only READ: the admin fixture user, and step code B, which this flow's own part
// comes to reference. Deliberately B and never A. blocked-code-delete asserts an EXACT live-use
// count for step code A, so every extra reference to A is an ordering dependency on that flow; B
// is the fixture's shared-reference code (the `stepCodeB` precedent in e2e/lib/db-fixtures.ts), and
// no flow counts its uses. The reference goes with the owned part at cleanup, and nothing about
// step code B itself changes, so nothing needs restoring.
import { openOrderTab } from "../lib/orders.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { login } from "../lib/auth.mjs";
import { insecureOrigin } from "../lib/insecure-origin.mjs";
import { mutate } from "../lib/order-entry-workspace.mjs";
import { fillReliable, pickProcessCode, processRows, waitForProcessSaveSettled, waitForValue } from "../lib/ui.mjs";
import { openRecordTab } from "../lib/record-tabs.mjs";

// Lowercase and case-sensitive, like order-print-intent.ts's storage-key pattern. A copy, because a
// flow cannot import a src/ TypeScript module. The source of truth is idempotent-save.ts's V4_UUID,
// which tests/client-id.test.ts holds newId() to.
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const section = (page, name) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) });
const pathIs = (response, path, method) =>
  new URL(response.url()).pathname === path && response.request().method() === method;

export async function run(page, shot, ctx) {
  const f = ctx.fixtures;
  const code = f.stepCodeB; // never stepCodeA: see the header

  const part = await mutate(page, ctx, "/api/parts", {
    customerId: f.orderCustomerId, partNumber: f.insecurePartNumber, eachWeight: 127, loadQty: 15,
  });
  assert.equal(typeof part.id, "string", "The owned part must be created");

  // An uncaught exception is how the defect presented: the click handler's first line threw and
  // the error reached only the console. So any page error on this origin fails the flow.
  // A waiter raced against `pageErrorGate` fails on the error itself, instead of timing out 45 s
  // later on the row the thrown handler never added.
  const pageErrors = [];
  let failOnPageError;
  const pageErrorGate = new Promise((_, reject) => { failOnPageError = reject; });
  pageErrorGate.catch(() => {}); // observed through each race below; never an unhandled rejection
  page.on("pageerror", (error) => {
    pageErrors.push(String(error?.stack ?? error));
    failOnPageError(new assert.AssertionError({
      message: `A page error occurred on the insecure origin: ${error?.message ?? error}`,
    }));
  });
  const unlessPageError = (promise) => Promise.race([promise, pageErrorGate]);

  const origin = insecureOrigin(ctx.baseURL);
  await login(page, origin, f.adminUsername, f.adminPassword);
  const env = await page.evaluate(() => ({
    origin: location.origin,
    secure: window.isSecureContext,
    randomUUID: typeof crypto.randomUUID,
    getRandomValues: typeof crypto.getRandomValues,
  }));
  assert.equal(env.origin, origin, "The flow must be on the mapped non-loopback origin");
  assert.equal(env.secure, false, "The mapped origin must be an INSECURE context, or this flow proves nothing");
  assert.equal(env.randomUUID, "undefined", "crypto.randomUUID must be absent, as it is on a LAN HTTP origin");
  assert.equal(env.getRandomValues, "function", "crypto.getRandomValues must remain, since newId() falls back to it");
  await shot("insecure-origin-signed-in");

  // 1. The part page: pick a code in the step search, and the row appears (the pick mints its
  //    `new:` identity with newId()); then Save, and it persists.
  await page.goto(`${origin}/parts/${part.id}`);
  await openRecordTab(page, "Process recipe");
  const steps = section(page, "Process steps");
  const rows = processRows(page);
  await pickProcessCode(page, code.code, code);
  await unlessPageError(rows.first().getByText(code.code, { exact: true }).waitFor());
  assert.equal(await rows.count(), 1, "The pick must add exactly one row");
  const draftId = await rows.first().getAttribute("data-step-id");
  assert.ok(draftId?.startsWith("new:"), `An added step carries a new: client identity, saw ${draftId}`);
  assert.match(draftId.slice("new:".length), V4, "The client identity must be a v4 UUID minted without randomUUID");
  await shot("part-step-added");
  await steps.getByRole("button", { name: "Save process steps", exact: true }).click();
  await waitForProcessSaveSettled(page);
  await page.reload();
  await rows.first().getByText(code.code, { exact: true }).waitFor();
  assert.equal(await rows.count(), 1, "Exactly the one added step persists");
  const savedId = await rows.first().getAttribute("data-step-id");
  assert.ok(savedId && !savedId.startsWith("new:"), `The saved step must carry its server identity, saw ${savedId}`);
  await shot("part-step-saved");

  // 2. One idempotent bulk-grid save on the order hub: Add charge mints the row's client id and
  // Save charges captures the submission's. The part is orderable now that step 1 saved.
  const created = await mutate(page, ctx, "/api/orders", {
    clientRequestId: randomUUID(), customerId: f.orderCustomerId, poNumber: "INSECURE-ORIGIN",
    lines: [{ partId: part.id, qty: 31, weight: 3937 }],
  });
  const orderId = created.order?.id;
  assert.equal(typeof orderId, "string", "The owned order must be created");
  await page.goto(`${origin}/orders/${orderId}`);
  await page.getByRole("heading", { name: /^Order #\d+/ }).waitFor();
  // PR 2: Charges sits on the hub's Parts & containers tab (the reload below keeps `?tab=parts`).
  await openOrderTab(page, "Parts & containers");
  const charges = section(page, "Charges");
  const description = "Insecure-origin charge (#348)";
  await charges.getByRole("button", { name: "Add charge", exact: true }).click();
  await unlessPageError(page.getByLabel("Charge 1 description", { exact: true }).waitFor());
  await fillReliable(page.getByLabel("Charge 1 description", { exact: true }), description);
  const saved = page.waitForResponse((r) => pathIs(r, `/api/orders/${orderId}/charges`, "PUT"));
  await charges.getByRole("button", { name: "Save charges", exact: true }).click();
  assert.equal((await unlessPageError(saved)).status(), 200, "Save charges must be sent and accepted");
  await page.reload();
  await waitForValue(page.getByLabel("Charge 1 description", { exact: true }), description);
  await shot("order-charge-saved");

  assert.deepEqual(pageErrors, [], "No page error may occur on the insecure origin");
}
