// Flow 15 (Phase 4, Task 20; runs as the fixture CLERK): the credit-hold gate — this phase's
// headline feature (owner ruling §3.7, spec §5.4/§13.5), human-reachable since Task 14b built
// /shipping/new. First half, as the clerk (shipping permissions but NOT
// action.override_credit_hold): the held customer's refusal is NAMED and LINKED on the create
// page, no override-reason field is offered (a control that can lead nowhere is a dead end, not
// an affordance), and Save is disabled with a §5.16 title naming the missing action. Second
// half, re-logged-in as the fixture admin (who holds the action): a blank reason is refused, a
// real reason saves the shipment, and the reason lands in the shipment's CREATE audit entry —
// and on no piece of paper (§5.4: audit-only, deliberately not a Shipper column).
//
// Note the order ENTRY save for the held customer only WARNS (P3 owner ruling: credit hold warns
// at entry; the squeeze is at shipping) — this flow walks through exactly that pair.
import assert from "node:assert/strict";
import { login } from "../lib/auth.mjs";
import { createOrderViaUi, orderPanel, startNewShipment, waitForShipmentPage } from "../lib/orders.mjs";
import { waitForEnabled, waitForTitle, waitForValue } from "../lib/ui.mjs";
import { openRecordTab } from "../lib/record-tabs.mjs";

const REASON = "E2E credit-hold flow: owner approved this shipment by phone, demo override.";

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;

  // --- As the clerk: keying the ORDER warns but succeeds (entry never blocks on hold). ---
  const order = await createOrderViaUi(page, ctx, {
    customerCode: fixtures.holdCustomerCode,
    lines: [{ partNumber: fixtures.holdPartNumber, qty: 10 }],
    expectWarnings: true, // the held customer's save always returns the credit-hold warning
  });
  await shot("order-saved-despite-hold");

  // --- As the clerk: the SHIPMENT is where the hold bites. Named, linked, and no dead-end
  // reason field for an actor who cannot override. ---
  await startNewShipment(page, ctx, fixtures.holdCustomerId, [order]);
  await openRecordTab(page, "Customer & route"); // the hold's notice and reason box sit there (PR 4)
  await page.getByText(/is on credit hold/).first().waitFor({ state: "visible" });
  await page.getByRole("link", { name: "see their record", exact: true }).first().waitFor({ state: "visible" });
  await page.getByText(/requires the/).waitFor({ state: "visible" });
  await page.getByText("override_credit_hold", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await page.getByLabel("Credit hold override reason", { exact: true }).count(), 0,
    "an actor without the override action must not be offered a reason field");

  const saveButton = page.getByRole("button", { name: "Save shipment", exact: true });
  assert.equal(await saveButton.isDisabled(), true, "Save must be disabled for a held customer without the override action");
  assert.match((await saveButton.getAttribute("title")) ?? "",
    /is on credit hold — saving requires the override_credit_hold action$/);
  await shot("clerk-blocked");

  // --- Re-login as the admin (holds action.override_credit_hold) for the override half. ---
  await login(page, ctx.baseURL, fixtures.adminUsername, fixtures.adminPassword);
  await startNewShipment(page, ctx, fixtures.holdCustomerId, [order]);
  await openRecordTab(page, "Customer & route"); // the hold's notice and reason box sit there (PR 4)
  await page.getByText(/records a credit-hold override/).waitFor({ state: "visible" });
  await shot("admin-sees-reason-field");

  // A blank reason is refused before the request even goes out (the server enforces the same
  // rule authoritatively — spec §12.7's route tests pin that side).
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  await page.getByText("A reason is required to override the credit hold.").waitFor({ state: "visible" });
  await shot("blank-reason-refused");

  await page.getByLabel("Credit hold override reason", { exact: true }).fill(REASON);
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  const shipment = await waitForShipmentPage(page);
  await shot("override-saved");

  // --- #472: on the saved shipment, Save lines waits for the override reason, with the sentence
  // Add order has always carried. The reason is this page's own state, so it starts blank whatever
  // the new form held. A line is edited FIRST: a clean Save is disabled whatever its gate says, so
  // on a clean grid the disabled assertion would pass with the gate deleted. Nothing is written to
  // the server: the edit is discarded. ---
  const panel = orderPanel(page, `${order.number}-1`);
  const shipNow = panel.getByLabel("Line 1 ship-now quantity", { exact: true });
  await waitForValue(shipNow, "10");
  await waitForEnabled(shipNow, "the Lines grid on the override holder's saved shipment");
  await shipNow.fill("9");
  await panel.getByText("Unsaved changes", { exact: true }).waitFor({ state: "visible" });
  const saveLines = panel.getByRole("button", { name: "Save lines", exact: true });
  await waitForTitle(saveLines, "A reason is required to override the credit hold", "Save lines with a blank override reason");
  assert.equal(await saveLines.isDisabled(), true, "Save lines must wait for the override reason");
  assert.equal(await shipNow.isDisabled(), false, "the Lines boxes stay open; only Save waits for the reason");
  await waitForTitle(page.getByRole("button", { name: "Add order", exact: true }),
    "A reason is required to override the credit hold", "Add order with a blank override reason");
  await shot("save-lines-waits-for-reason");
  await page.getByLabel("Credit hold override reason", { exact: true }).fill(REASON);
  await waitForEnabled(saveLines, "Save lines once a reason is typed");
  await waitForTitle(saveLines, null, "Save lines once a reason is typed");
  await panel.getByRole("button", { name: "Discard changes to lines", exact: true }).click();
  await waitForValue(shipNow, "10");

  // --- The reason reaches the shipment's CREATE audit entry (and nothing printable). Asserted
  // against the same authenticated audit API the History panel reads; the panel itself is
  // screenshotted for the demo. ---
  const res = await page.request.get(
    `${ctx.baseURL}/api/admin/audit?entity=shipper&entityId=${shipment.id}`,
    { maxRetries: 1 });
  assert.ok(res.ok(), `audit fetch failed: ${res.status()}`);
  // `{ rows, hasMore }` since #153 — the single-record branch is a capped union over the parent's
  // child sections, not a bare array.
  const { rows } = await res.json();
  const create = rows.find((e) => e.action === "create");
  assert.ok(create, "the shipment's create audit entry must exist");
  assert.equal(create.after?.creditHoldOverrideReason, REASON,
    "the override reason must land in the create audit entry");

  await page.getByText("History", { exact: false }).first().waitFor({ state: "visible" }).catch(() => {});
  await shot("override-in-history");
}
