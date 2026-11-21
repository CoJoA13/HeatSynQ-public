// Decimal entry, pull request 4 (#517): New shipment and a saved shipment check a typed figure
// through the one rule, name each refused box by its place, list every refusal at once, and send
// nothing.
//
//   - New shipment with a Ship now net weight of `$5`, a Tare each of `-1` and a Freight amount of
//     `$5`: Save shipment lists the three in the page's red line, takes the cursor to the weight,
//     marks the three boxes and keeps the line on screen (ruling R13), and no shipment is created
//     (no POST, and the customer's shipment list is what it was). Fixed, with `.36` as the freight,
//     it saves, and the shipment stores a freight of 0.36.
//   - The saved shipment: Save containers with Tare each `-1` on container 1 and `1.234` on
//     container 2 lists both in that order panel, not in the page's banner, and sends no PUT. A
//     Freight amount of `-1` on blur goes back to the stored figure, the banner names it and no
//     PATCH is sent; `.5` then saves and is stored as 0.5.
//
// What is stored is read from the API (a GET is a read, which the harness allows). The order
// belongs to the shipping fixture customer, whose teardown reaps it and its shipments; the flow
// changes no shared fixture state, so it has nothing to restore. It ends with nothing unsaved.
import assert from "node:assert/strict";
import { mutate, readJson } from "../lib/order-entry-workspace.mjs";
import { orderPanel, startNewShipment, waitForShipmentPage } from "../lib/orders.mjs";
import { assertNeverVisible, waitForFocused, waitForValue } from "../lib/ui.mjs";
import { openRecordTab } from "../lib/record-tabs.mjs";
import { assertRefusalShown, panelMessage, redLine, waitForRedLines, watchRequests } from "../lib/refusal-lines.mjs";

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;
  const saved = await mutate(page, ctx, "/api/orders", {
    clientRequestId: crypto.randomUUID(), customerId: fixtures.shipCustomerId, poNumber: "DECIMAL-SHIP",
    lines: [{ partId: fixtures.shipPartAId, qty: 10, weight: 100 }],
    containers: [{ typeId: fixtures.containerTypeId, count: 2 }, { typeId: fixtures.containerTypeId, count: 3 }],
  });
  const order = { id: saved.order.id, number: saved.order.orderNumber };
  const shipmentIds = async () =>
    (await readJson(page, ctx, `/api/shippers?customerId=${fixtures.shipCustomerId}&includeVoided=1`)).map((row) => row.id).sort();
  const before = await shipmentIds();

  // 1. New shipment: three refused boxes, listed at once, and nothing created.
  await startNewShipment(page, ctx, fixtures.shipCustomerId, [order]);
  const form = orderPanel(page, `#${order.number}`);
  await form.getByLabel("Container 2 tare each", { exact: true }).waitFor();
  const weight = form.getByLabel("Line 1 ship-now weight", { exact: true });
  const creates = watchRequests(page, "POST", "/api/shippers", { exact: true });
  await weight.fill("$5");
  await form.getByLabel("Container 1 tare each", { exact: true }).fill("-1");
  await openRecordTab(page, "Freight & review"); // the freight boxes' tab (PR 4)
  await page.getByLabel("Freight amount", { exact: true }).fill("$5");
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  await waitForRedLines(redLine(page), [
    `Order #${order.number}, Line 1, Ship now net weight (lb): enter a number without $ or commas, such as 0.36.`,
    `Order #${order.number}, Container 1, Tare each (lb): cannot be negative.`,
    "Freight amount: enter a number without $ or commas, such as 0.36.",
  ]);
  // Ruling R13: the cursor goes to the first refused box, each refused box is marked, and the
  // banner stays on screen with the page scrolled to its foot.
  await waitForFocused(weight, "the Line 1 Ship now net weight box after Save shipment listed its refusals");
  await shot("new-shipment-refused");
  await assertRefusalShown(page, redLine(page),
    [weight, form.getByLabel("Container 1 tare each", { exact: true }), page.getByLabel("Freight amount", { exact: true })],
    "New shipment's refused Save");
  assert.equal(creates.count(), 0, "Save shipment with refused boxes must send nothing");
  assert.deepEqual(await shipmentIds(), before, "refused boxes must not create a shipment");

  // 1b. Only the Freight amount refused, with Orders & containers open at Save: the refusal opens
  //     Freight & review first and puts the cursor in that box (PR 4; its plan's review focus 1).
  await openRecordTab(page, "Orders & containers");
  await weight.fill("80");
  await form.getByLabel("Container 1 tare each", { exact: true }).fill("1.5");
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  await waitForRedLines(redLine(page), ["Freight amount: enter a number without $ or commas, such as 0.36."]);
  await page.getByRole("tab", { name: "Freight & review", selected: true }).waitFor({ state: "visible" });
  await waitForFocused(page.getByLabel("Freight amount", { exact: true }), "the Freight amount box after Save shipment named it alone");
  assert.equal(creates.count(), 0, "a refused Freight amount alone must send nothing");

  // 2. Fixed, with `.36` as the freight: it saves, and the shipment stores that freight.
  await page.getByLabel("Freight amount", { exact: true }).fill(".36");
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  const shipment = await waitForShipmentPage(page);
  assert.equal(creates.count(), 1, "the fixed shipment must be one save");
  creates.stop();
  const stored = async () => {
    const { shipper } = await readJson(page, ctx, `/api/shippers/${shipment.id}`);
    const row = shipper.orders[0];
    return {
      freight: shipper.freightAmount, weight: row.lines[0].weight,
      tares: row.containers.map((container) => container.tareEach),
    };
  };
  assert.deepEqual(await stored(), { freight: 0.36, weight: 80, tares: [1.5, null] },
    "the shipment must store the fixed figures, and a freight of .36 as 0.36");

  // 3. The saved shipment: Save containers with two refused rows lists both in the order's panel.
  const panel = orderPanel(page, `${order.number}-1`);
  await panel.getByLabel("Container 2 tare each", { exact: true }).waitFor();
  const puts = watchRequests(page, "PUT", `/api/shippers/${shipment.id}/orders/`);
  await panel.getByLabel("Container 1 tare each", { exact: true }).fill("-1");
  await panel.getByLabel("Container 2 tare each", { exact: true }).fill("1.234");
  await panel.getByRole("button", { name: "Save containers", exact: true }).click();
  await waitForRedLines(panelMessage(panel), [
    "Container 1, Tare each (lb): cannot be negative.",
    "Container 2, Tare each (lb): use at most 2 digits after the point.",
  ]);
  await assertNeverVisible(page.locator("p.mb-3.bg-red-50"),
    "a refused grid save must show in its own panel, not in the page's banner", 300);
  await shot("saved-shipment-containers-refused");
  assert.equal(puts.count(), 0, "Save containers with refused rows must send nothing");
  puts.stop();
  assert.deepEqual((await stored()).tares, [1.5, null], "refused rows must not change what the shipment stores");
  await panel.getByRole("button", { name: "Discard changes to containers", exact: true }).click();
  await panelMessage(panel).waitFor({ state: "hidden" });
  await waitForValue(panel.getByLabel("Container 1 tare each", { exact: true }), "1.5");

  // 4. A Freight amount the rule refuses goes back to the stored figure and is named in the banner.
  await openRecordTab(page, "Header & freight"); // the saved shipment's header tab (PR 4)
  const freight = page.getByLabel("Freight amount", { exact: true });
  const banner = page.locator("p.mb-3.bg-red-50");
  const patches = watchRequests(page, "PATCH", `/api/shippers/${shipment.id}`, { exact: true });
  await waitForValue(freight, "0.36");
  await freight.fill("-1");
  await freight.press("Tab");
  await waitForRedLines(banner, ["Freight amount: cannot be negative."]);
  await waitForValue(freight, "0.36");
  await shot("saved-shipment-freight-refused");
  assert.equal(patches.count(), 0, "a refused Freight amount must send nothing");
  assert.equal((await stored()).freight, 0.36, "a refused Freight amount must not be stored");

  // 5. `.5` is a figure: it saves and is stored.
  const answered = page.waitForResponse((res) =>
    new URL(res.url()).pathname === `/api/shippers/${shipment.id}`
    && res.request().method() === "PATCH" && res.ok());
  await freight.fill(".5");
  await freight.press("Tab");
  await answered;
  assert.equal(patches.count(), 1, "a Freight amount typed as .5 must be one save");
  patches.stop();
  assert.equal((await stored()).freight, 0.5, "a Freight amount typed as .5 must be stored as 0.5");
  await waitForValue(freight, "0.5");
}
