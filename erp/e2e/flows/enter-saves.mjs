// Owner ruling R7 (2026-10-22): Enter commits a single-line blur-save box as its blur would, the
// cursor stays in the box, a refused Enter does what a refused blur does, and one green Saved mark
// shows beside a box while it holds what was saved.
//
//   - The order hub's PO number, on an order this flow keys against the shipping fixture customer:
//     Enter stores the typed PO with one PATCH, the cursor stays in the box and "PO number saved"
//     shows. The cursor then leaves by Tab and nothing more is sent (the guard's fresh session after
//     an accepted Enter). Typing on takes the mark away.
//   - The customer page's Credit limit, on the shipping fixture customer: Enter on a figure the
//     rule refuses names the box in the page's banner, puts back what the box held, keeps the
//     cursor in the box and sends nothing, and leaving it then sends nothing either (the commit's
//     `false`, which keeps the guard's session). No Saved mark shows.
//
//   - Settings' Company phone, a box outside the edit guard (P8 step 5: it keeps its own record of
//     its text at focus): Enter stores it with one PUT, the cursor stays and "Company phone saved"
//     shows; Tab then sends nothing more. The fixture's phone is put back by an exact-value PUT,
//     armed before the write. Session timeout (minutes) left blank is refused on Enter in the page's
//     banner and sends nothing, and leaving it sends nothing either.
//
// Each count is read after a barrier: a read of the record through the API, issued once the cursor
// has left the box, so any save the blur would send has gone out first. The one write is the PO
// number of this flow's own order, which fixture cleanup removes with that customer's other
// orders. The refused Credit limit writes nothing.
import assert from "node:assert/strict";
import { createOrderViaUi, openOrderTab } from "../lib/orders.mjs";
import { readJson } from "../lib/order-entry-workspace.mjs";
import { assertNeverVisible, waitForValue } from "../lib/ui.mjs";
import { watchRequests } from "../lib/refusal-lines.mjs";
import { openRecordTab } from "../lib/record-tabs.mjs";
import { openCustomersView } from "../lib/customers.mjs";
import { openPartsView } from "../lib/parts.mjs";

export async function run(page, shot, ctx) {
  await hubPoNumber(page, shot, ctx);
  await customerCreditLimit(page, shot, ctx);
  await settingsBoxes(page, shot, ctx);
}

const focused = (box) => box.evaluate((el) => el === document.activeElement);

async function hubPoNumber(page, shot, ctx) {
  const { fixtures } = ctx;
  const order = await createOrderViaUi(page, ctx, {
    customerCode: fixtures.shipCustomerCode,
    lines: [{ partNumber: fixtures.certPartNumber, qty: 2 }],
  });
  const orderPath = `/api/orders/${order.id}`;
  // The hub's sections sit in tabs (the UX redesign's PR 2); Overview is the first, open by
  // default, and opened by name here so the box below is never on a hidden panel.
  await openOrderTab(page, "Overview");
  // The label holds the box, so the box is found inside the label.
  const box = page.locator("#overview label", { hasText: "PO number" }).locator("input");
  await box.waitFor({ state: "visible", timeout: 15000 });

  const patches = watchRequests(page, "PATCH", orderPath, { exact: true });
  await box.fill("E2E-ENTER-PO");
  const [saved] = await Promise.all([
    page.waitForResponse((res) => new URL(res.url()).pathname === orderPath && res.request().method() === "PATCH"),
    box.press("Enter"),
  ]);
  assert.equal(saved.ok(), true, "Enter must store the PO number");
  await page.getByRole("status", { name: "PO number saved" }).waitFor({ state: "visible" });
  assert.equal(await focused(box), true, "the cursor stays in the box after Enter");
  await shot("po-number-saved-on-enter");

  await box.press("Tab");
  assert.equal((await readJson(page, ctx, orderPath)).poNumber, "E2E-ENTER-PO", "the stored PO number is the one Enter sent");
  assert.equal(patches.count(), 1, "leaving the box after Enter stored it must send nothing more");
  patches.stop();

  // Typing on takes the mark away: the box no longer holds what was saved.
  await box.fill("E2E-ENTER-PO2");
  await assertNeverVisible(page.getByRole("status", { name: "PO number saved" }),
    "the Saved mark must go once the box holds something else");
  await box.press("Escape");
}

async function customerCreditLimit(page, shot, ctx) {
  const { fixtures } = ctx;
  const customerPath = `/api/customers/${fixtures.shipCustomerId}`;
  const stored = async () => (await readJson(page, ctx, customerPath)).creditLimit;
  const before = await stored();

  // PR 9 of the UX redesign: the parts list's two views are the two states of its Show inactive box,
  // each a read of /api/parts, and Add part only takes the cursor to the inline row.
  const partRead = (inactive) => page.waitForResponse((res) => {
    const url = new URL(res.url());
    return url.pathname === "/api/parts" && (url.searchParams.get("includeInactive") === "1") === inactive
      && res.request().method() === "GET" && res.ok();
  });
  const partPosts = watchRequests(page, "POST", "/api/parts", { exact: true });
  const firstPartRead = partRead(false);
  await page.goto(`${ctx.baseURL}/parts`);
  await firstPartRead;
  const inactivePartRead = partRead(true);
  await openPartsView(page, "Include inactive");
  await inactivePartRead;
  const activePartRead = partRead(false);
  await openPartsView(page, "Active parts");
  await activePartRead;
  await page.getByRole("button", { name: "Add part", exact: true }).click();
  assert.equal(await focused(page.locator("select").filter({ hasText: "Customer…" })), true, "Add part puts the cursor in the inline row's Customer select");
  assert.equal(partPosts.count(), 0, "Add part creates nothing by itself");
  partPosts.stop();

  // PR 8 of the UX redesign: the customers list on the way to the page. Its two views are the two
  // states of the Show inactive box the list always sent, each a read of /api/customers; the
  // header's Add customer only takes the cursor to the inline row's Code box and creates nothing.
  const listRead = (inactive) => page.waitForResponse((res) => {
    const url = new URL(res.url());
    return url.pathname === "/api/customers" && (url.searchParams.get("includeInactive") === "1") === inactive
      && res.request().method() === "GET" && res.ok();
  });
  const posts = watchRequests(page, "POST", "/api/customers", { exact: true });
  const firstRead = listRead(false);
  await page.goto(`${ctx.baseURL}/customers`);
  await firstRead;
  const inactiveRead = listRead(true);
  await openCustomersView(page, "Include inactive");
  await inactiveRead;
  const activeRead = listRead(false);
  await openCustomersView(page, "Active customers");
  await activeRead;
  await page.getByRole("button", { name: "Add customer", exact: true }).click();
  const codeBox = page.getByPlaceholder("Code", { exact: true });
  assert.equal(await focused(codeBox), true, "Add customer puts the cursor in the inline row's Code box");
  assert.equal(posts.count(), 0, "Add customer creates nothing by itself");
  posts.stop();
  await shot("customers-list-views");

  await page.goto(`${ctx.baseURL}/customers/${fixtures.shipCustomerId}`);
  await openRecordTab(page, "Terms & billing"); // Credit limit is in Commercial settings (PR 8)
  const box = page.locator("label", { hasText: "Credit limit" }).locator("input");
  await box.waitFor({ state: "visible", timeout: 15000 });
  const held = await box.inputValue();

  const puts = watchRequests(page, "PUT", customerPath, { exact: true });
  await box.fill("1.234");
  await box.press("Enter");
  const banner = page.locator("p.bg-red-50", { hasText: "Credit limit:" });
  await banner.waitFor({ state: "visible" });
  assert.equal((await banner.innerText()).trim(), "Credit limit: use at most 2 digits after the point.");
  await waitForValue(box, held);
  assert.equal(await focused(box), true, "a refused Enter keeps the cursor in the box");
  await shot("credit-limit-refused-on-enter");

  await box.press("Tab");
  assert.equal(await stored(), before, "a refused Credit limit must not change what is stored");
  assert.equal(puts.count(), 0, "a refused Enter, and leaving the box after it, must send nothing");
  puts.stop();
  await assertNeverVisible(page.getByRole("status", { name: "Credit limit saved" }),
    "a refused Credit limit shows no Saved mark");
}

const SETTINGS_PATH = "/api/admin/settings";

async function settingsBoxes(page, shot, ctx) {
  const stored = async (key) => (await readJson(page, ctx, SETTINGS_PATH)).find((r) => r.key === key)?.value;
  const phoneBefore = await stored("company_phone");
  const timeoutBefore = await stored("session_timeout_minutes");
  assert.equal(typeof phoneBefore, "string", "the fixture's company phone must be set");

  // Armed before the first write. An exact-value PUT is safe to send twice.
  const restorePhone = async () => {
    const res = await ctx.apiMutate(page, `${ctx.baseURL}${SETTINGS_PATH}`, {
      method: "PUT", data: { key: "company_phone", value: phoneBefore }, idempotent: true });
    assert.equal(res.ok(), true, `restoring the company phone: ${await res.text()}`);
    assert.equal(await stored("company_phone"), phoneBefore, "the company phone must be restored");
  };

  let failed = true;
  try {
    await page.goto(`${ctx.baseURL}/admin/settings`);
    const phone = page.getByLabel("Company phone", { exact: true });
    await phone.waitFor({ state: "visible", timeout: 15000 });
    await waitForValue(phone, phoneBefore);

    const puts = watchRequests(page, "PUT", SETTINGS_PATH, { exact: true });
    await phone.fill("555-0199");
    const [saved] = await Promise.all([
      page.waitForResponse((res) => new URL(res.url()).pathname === SETTINGS_PATH && res.request().method() === "PUT"),
      phone.press("Enter"),
    ]);
    assert.equal(saved.ok(), true, "Enter must store the company phone");
    await page.getByRole("status", { name: "Company phone saved" }).waitFor({ state: "visible" });
    assert.equal(await focused(phone), true, "the cursor stays in the box after Enter");
    await shot("company-phone-saved-on-enter");
    await phone.press("Tab");
    assert.equal(await stored("company_phone"), "555-0199", "the stored phone is the one Enter sent");
    assert.equal(puts.count(), 1, "leaving the box after Enter stored it must send nothing more");

    await openRecordTab(page, "System");
    const timeout = page.getByLabel("Session timeout (minutes)", { exact: true });
    await timeout.fill("");
    await timeout.press("Enter");
    await page.locator("p.bg-red-50", { hasText: "Enter a value" }).waitFor({ state: "visible" });
    assert.equal(await focused(timeout), true, "a refused Enter keeps the cursor in the box");
    await timeout.press("Tab");
    assert.equal(await stored("session_timeout_minutes"), timeoutBefore, "a refused timeout must not change what is stored");
    assert.equal(puts.count(), 1, "a refused Enter, and leaving the box after it, must send nothing");
    puts.stop();
    failed = false;
  } finally {
    try {
      await restorePhone();
    } catch (error) {
      if (!failed) throw error;
      console.error(`enter-saves: restoring the company phone failed after the flow failed: ${error}`);
    }
  }
}
