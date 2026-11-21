// #484 (owner ruling 2026-10-15, "Payload address after commit, select open"): the saved shipment
// page shows the shipment's own ship-to address whether or not the page could read the customer's
// address list. Each shipment answer carries the address; when the list lacks it, the Ship-to
// select offers it as its own option, in the list's own format, and "Ships to:" reads it.
//
//   1. As admin: key an order of 5 for the shipping fixture customer and ship it whole.
//   2. The list read: the select offers the fixture address once, from the list. Picking it saves,
//      and "Ships to:" spells it out. "Requires customers.view" is not shown.
//   3. A failed list read (this browser answers it 500): the banner names the failure, and the
//      select still shows the address as its one option beside "— none —", from the shipment's
//      answer, with "Ships to:" under the freight fields. "Requires customers.view" is not shown:
//      the cause is a failed read, not a permission.
//   4. No customers.view: the restricted user, narrowed to parts.view (login's checkpoint),
//      shipping.view and shipping.edit, reads no list. The select is open, its accessible name is
//      still exactly "Ship-to address", it shows the address as its one option, and "Requires
//      customers.view" shows beside it.
//   5. That user clears the address. The select then holds only "— none —", and "Ships to:" is
//      gone: the clear is one-way for a viewer without customers.view, as the owner was told.
//
// The restricted role's narrowing is armed before the write and restored first, as admin, in
// `finally` (#321): later flows sign in as that user. An address made inactive or deleted is left
// to vitest (tests/shipper-routes.test.ts, tests/shipment-ship-to.test.ts): doing that here would
// write customerAddress audit rows, which the fixture teardown does not remove. The order and the
// shipment belong to the shipping fixture customer, whose teardown reaps them; the address goes
// with that customer. The flow leaves a fully shipped order and a shipment with no ship-to.
//
// The select is found by role and accessible name, never by an exact getByLabel: Playwright's
// label match reads the whole text of the <label> that wraps this <select>, its options included,
// so it never equals "Ship-to address" exactly. The accessible name leaves the select's own
// options out, and it would take in "Requires customers.view" if that text sat inside the label.
import assert from "node:assert/strict";
import { login } from "../lib/auth.mjs";
import { createOrderViaUi, orderPanel, startNewShipment, waitForShipmentPage } from "../lib/orders.mjs";
import { rolePermissions, setRolePermissions } from "../lib/roles.mjs";
import { assertNeverVisible, waitForEnabled, waitForValue } from "../lib/ui.mjs";
import { openRecordTab } from "../lib/record-tabs.mjs";
import { routeRequests } from "../route-keep-alive.mjs";

const NONE = "— none —";
const REQUIRES = "Requires customers.view";
const REFUSED = "E2E address read refused";

/** The saved shipment page's Header section, which holds the Ship-to select, its reason and the
 *  "Ships to:" line. */
const header = (page) => page.locator("section").filter({ has: page.getByRole("heading", { name: "Header", exact: true }) });
const shipToSelect = (page) => header(page).getByRole("combobox", { name: "Ship-to address", exact: true });

/** Polls until the select's option texts are exactly `expected`, in order. */
async function waitForOptions(select, expected, what, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await select.locator("option").allTextContents().catch(() => undefined);
    if (JSON.stringify(last) === JSON.stringify(expected)) return;
    if (Date.now() > deadline) {
      assert.fail(`${what}: timed out waiting for the Ship-to options ${JSON.stringify(expected)}; last saw ${JSON.stringify(last)}`);
    }
    await new Promise((r) => { setTimeout(r, 100); });
  }
}

/** The select holds `options`, its value is `value`, and the option it shows reads `shown`. */
async function assertShipTo(select, { options, value, shown }, what) {
  await waitForOptions(select, options, what);
  await waitForValue(select, value);
  assert.equal(await select.evaluate((el) => el.selectedOptions[0]?.textContent ?? null), shown,
    `${what}: the Ship-to select must show ${JSON.stringify(shown)}`);
}

/** The answer to the next header PATCH of this shipment, which must succeed. Armed before the
 *  change that sends it. */
function nextPatch(page, shipmentId) {
  return page.waitForResponse((res) => new URL(res.url()).pathname === `/api/shippers/${shipmentId}`
    && res.request().method() === "PATCH")
    .then(async (res) => {
      assert.equal(res.ok(), true, `the Ship-to save must succeed: ${res.status()} ${await res.text()}`);
      return res.json();
    });
}

export async function run(page, shot, ctx) {
  const f = ctx.fixtures;
  const option = f.shipToOptionText;
  const select = shipToSelect(page);
  const shipsTo = header(page).getByText(`Ships to: ${f.shipToShipsToText}`, { exact: true });
  const requires = header(page).getByText(REQUIRES, { exact: true });
  let prior = null;
  try {
    // 1. An order of 5, shipped whole, so it is no later flow's Add order candidate.
    const order = await createOrderViaUi(page, ctx, {
      customerCode: f.shipCustomerCode, lines: [{ partNumber: f.shipPartANumber, qty: 5 }],
    });
    await startNewShipment(page, ctx, f.shipCustomerId, [order]);
    await waitForValue(orderPanel(page, `#${order.number}`).getByLabel("Line 1 ship-now quantity", { exact: true }), "5");
    await page.getByRole("button", { name: "Save shipment", exact: true }).click();
    const shipment = await waitForShipmentPage(page);
    await openRecordTab(page, "Header & freight"); // the Ship-to select's tab (PR 4)

    // 2. The list read: the address is offered once, from the list, and picking it saves it.
    await assertShipTo(select, { options: [NONE, option], value: "", shown: NONE }, "the list read, nothing set");
    const picked = nextPatch(page, shipment.id);
    await select.selectOption({ label: option });
    assert.equal((await picked).shipper.shipToAddressId, f.shipToAddressId, "the pick must save the fixture address");
    await assertShipTo(select, { options: [NONE, option], value: f.shipToAddressId, shown: option }, "the list read, the address set");
    await shipsTo.waitFor();
    await assertNeverVisible(requires, `an admin must not see "${REQUIRES}"`);
    await shot("ship-to-listed");

    // 3. A failed list read: the address still shows, from the shipment's answer.
    let refusals = 0;
    const stopRefusing = await routeRequests(page, new RegExp(`/api/customers/${f.shipCustomerId}/addresses(\\?|$)`), async (route) => {
      if (route.request().method() !== "GET") { await route.continue(); return; }
      refusals += 1;
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: REFUSED }) });
    });
    try {
      await page.reload();
      await waitForShipmentPage(page);
      await openRecordTab(page, "Header & freight");
      await page.getByText(`Could not load ship-to addresses: ${REFUSED}`, { exact: true }).waitFor();
      assert.ok(refusals > 0, "the address list read must have been refused");
      await assertShipTo(select, { options: [NONE, option], value: f.shipToAddressId, shown: option }, "a failed list read");
      await shipsTo.waitFor();
      await assertNeverVisible(requires, `a failed list read is not a missing permission: "${REQUIRES}" must not show`);
      await shot("ship-to-list-read-failed");
    } finally {
      await stopRefusing();
    }

    // 4. No customers.view. Armed before the write: a narrowing whose answer is lost may still
    // have committed (#321).
    prior = await rolePermissions(page, ctx, f.restrictedRoleId);
    await setRolePermissions(page, ctx, f.restrictedRoleId, ["parts.view", "shipping.view", "shipping.edit"]);
    await login(page, ctx.baseURL, f.restrictedUsername, f.restrictedPassword);
    await page.goto(`${ctx.baseURL}/shipping/${shipment.id}`);
    await waitForShipmentPage(page);
    await openRecordTab(page, "Header & freight");
    await waitForEnabled(select, "the Ship-to select without customers.view");
    await assertShipTo(select, { options: [NONE, option], value: f.shipToAddressId, shown: option }, "without customers.view");
    await requires.waitFor();
    await shipsTo.waitFor();
    await shot("ship-to-without-customers-view");

    // 5. The one-way clear: once cleared, this viewer has no address to pick again.
    const cleared = nextPatch(page, shipment.id);
    await select.selectOption({ value: "" });
    assert.equal((await cleared).shipper.shipToAddressId, null, "the clear must save no ship-to address");
    await assertShipTo(select, { options: [NONE], value: "", shown: NONE }, "after the clear");
    await assertNeverVisible(header(page).getByText(/Ships to:/), `"Ships to:" must be gone after the clear`);
    await requires.waitFor();
    await shot("ship-to-cleared");
  } finally {
    if (prior) {
      // First, because later flows sign in as this role's user.
      await login(page, ctx.baseURL, f.adminUsername, f.adminPassword);
      await setRolePermissions(page, ctx, f.restrictedRoleId, prior);
    }
  }
}
