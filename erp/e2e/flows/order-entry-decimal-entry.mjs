// Decimal entry, pull request 3 (#517): New order checks every decimal box through the one rule
// before it sends, names each refused box by its place, lists them all, and jumps to the first.
//
//   - A Lead line Net weight of `0`, a Tare each of `-1` on container 1 and a charge Amount of
//     `abc` are all refused by one Save. The banner lists the three, in the order the page
//     checks them (part lines, containers, then charges), the Parts & containers tab shows with
//     the Lead line's weight box focused, nothing is sent, and no order exists. Each of the three
//     boxes carries aria-invalid and a red border, and the banner stays in the window with the
//     page scrolled to its foot (ruling R13).
//   - The three are fixed (a Tare each of `.5`, a charge Amount of `.36`), Save works, and the
//     stored order holds the charge at 0.36 and the Tare each at 0.5.
//
// What is stored is read from the API (a GET is a read, which the harness allows). The flow keys
// its own part and order against the order fixture customer, whose teardown reaps the order, and
// it changes no shared fixture state, so it has nothing to restore.
import assert from "node:assert/strict";
import { entryFixture, startEntry, entryTab, waitPlan, saveEntry, readJson, ownedOrders } from "../lib/order-entry-workspace.mjs";
import { waitForFocused, waitForValue } from "../lib/ui.mjs";
import { assertRefusalShown, entryAlert, waitForAlertLines, watchRequests } from "../lib/refusal-lines.mjs";

export async function run(page, shot, ctx) {
  const part = await entryFixture(page, ctx, "E2E-DECIMAL-ENTRY");
  const before = await ownedOrders(page, ctx);

  await startEntry(page, ctx, part, 30);
  await waitPlan(page, 2);

  // Container 1 (Tare each `-1`) and the lead line's weight (`0`) are on Parts & containers.
  await page.getByRole("button", { name: "Add container", exact: true }).click();
  await page.getByLabel("Container 1 type", { exact: true }).selectOption(ctx.fixtures.containerTypeId);
  await page.getByLabel("Container 1 count", { exact: true }).fill("2");
  const tareEach = page.getByLabel("Container 1 tare each", { exact: true });
  await tareEach.fill("-1");
  const weight = page.getByLabel("Line 1 weight", { exact: true });
  await weight.fill("0");

  // The charge is on Order details, so Save is pressed from there and must come back.
  await entryTab(page, "Order details");
  await page.getByRole("button", { name: "Review extra charges", exact: true }).click();
  await page.getByRole("dialog", { name: "Extra charges" }).getByRole("button", { name: "Add charge", exact: true }).click();
  await page.getByLabel("Charge 1 description", { exact: true }).fill("Decimal entry charge");
  const amount = page.getByLabel("Charge 1 amount", { exact: true });
  await amount.fill("abc");

  const creates = watchRequests(page, "POST", "/api/orders", { exact: true });
  await page.getByRole("button", { name: "Save only", exact: true }).click();
  await waitForAlertLines(entryAlert(page), [
    "Lead line, Net weight (lb): must be greater than zero.",
    "Container 1, Tare each (lb): cannot be negative.",
    "Charge 1, Amount: enter a number without $ or commas, such as 0.36.",
  ]);
  // The first refusal's tab is showing and its box has the cursor.
  assert.equal(await page.getByRole("tab", { name: "Parts & containers", exact: true }).getAttribute("aria-selected"), "true",
    "Save must show the tab of the first refused box");
  await waitForFocused(weight, "the Lead line's Net weight box after Save listed its refusals");
  await shot("new-order-decimal-refusals");
  // Ruling R13: each refused box is marked, the charge's on the hidden Order details tab too, and
  // the banner in the sticky header stays on screen with the page scrolled to its foot.
  await assertRefusalShown(page, entryAlert(page), [weight, tareEach, amount], "New order's refused Save");
  assert.equal(creates.count(), 0, "a Save with refused boxes must send nothing");
  assert.equal((await ownedOrders(page, ctx)).length, before.length, "no order may be created by a refused Save");
  creates.stop();

  // Fixed: a weight, a Tare each typed as `.5`, and a charge typed as `.36`.
  await weight.fill("3810");
  await tareEach.fill(".5");
  await entryTab(page, "Order details");
  await amount.fill(".36");
  await waitForValue(amount, ".36");
  await waitPlan(page, 2);
  const saved = await saveEntry(page, ctx);

  const order = await readJson(page, ctx, `/api/orders/${saved.order.id}`);
  assert.equal(order.charges.length, 1, "the order must hold the one charge");
  assert.equal(Number(order.charges[0].amount), 0.36, "a charge Amount typed as .36 must be stored as 0.36");
  assert.equal(order.containers.length, 1, "the order must hold the one container row");
  assert.equal(Number(order.containers[0].tareEach), 0.5, "a Tare each typed as .5 must be stored as 0.5");
  assert.equal(Number(order.lines[0].weight), 3810, "the corrected Net weight must be stored");
  assert.equal((await ownedOrders(page, ctx)).length, before.length + 1, "exactly one order must exist after the corrected Save");
}
