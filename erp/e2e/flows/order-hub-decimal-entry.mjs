// Decimal entry, pull request 3 (#517): a saved order's Containers grid and Lines boxes check a
// typed figure through the one rule, name each refused box by its place, and send nothing.
//
//   - Containers with two refused rows (Tare each `-1` on container 1, Scale gross `1.234` on the
//     added container 2): Save containers lists both, one per line, in the grid's own message
//     under its Save row (ruling R1, P6 step 5a), never the page's banner, and sends no PUT. What the order stores is unchanged.
//   - A Lead Net weight left holding `1e2`: the box reads Not saved, the line under the row and the
//     Lines section's message say it by place, and nothing is sent. `.5` then saves, the box reads
//     Saved, the message goes, and the order stores 0.5.
//
// What is stored is read from the API (a GET is a read, which the harness allows). The flow keys
// its own part and order against the order fixture customer, whose teardown reaps the order, and
// it changes no shared fixture state, so it has nothing to restore. It ends with nothing unsaved.
import assert from "node:assert/strict";
import { entryFixture, mutate, readJson } from "../lib/order-entry-workspace.mjs";
import { assertNeverVisible, waitForValue } from "../lib/ui.mjs";
import { panelMessage, waitForRedLines, watchRequests } from "../lib/refusal-lines.mjs";
import { hubSection } from "../lib/orders.mjs";

export async function run(page, shot, ctx) {
  const part = await entryFixture(page, ctx, "E2E-DECIMAL-HUB");
  const saved = await mutate(page, ctx, "/api/orders", {
    clientRequestId: crypto.randomUUID(), customerId: ctx.fixtures.orderCustomerId, poNumber: "DECIMAL-HUB",
    lines: [{ partId: part.id, qty: 10, weight: 1270 }],
    containers: [{ typeId: ctx.fixtures.containerTypeId, count: 2 }],
  });
  const orderId = saved.order.id;
  const stored = async () => {
    const order = await readJson(page, ctx, `/api/orders/${orderId}`);
    return {
      containers: order.containers.map((row) => ({ count: row.count, tareEach: row.tareEach, scaleGross: row.scaleGross })),
      weight: Number(order.lines[0].weight),
    };
  };
  const starting = await stored();
  assert.deepEqual(starting, { containers: [{ count: 2, tareEach: null, scaleGross: null }], weight: 1270 },
    "the order's starting rows");

  await page.goto(`${ctx.baseURL}/orders/${orderId}`);
  // Containers and Lines share the hub's Parts & containers tab (PR 2), opened by `hubSection`.
  const containers = await hubSection(page, "Containers");
  await containers.waitFor({ state: "visible" });
  await containers.getByLabel("Container 1 type", { exact: true }).waitFor();

  // 1. Two refused rows: both lines at once, and no PUT.
  const puts = watchRequests(page, "PUT", `/api/orders/${orderId}/containers`);
  await containers.getByLabel("Container 1 tare each", { exact: true }).fill("-1");
  await containers.getByRole("button", { name: "Add container", exact: true }).click();
  await containers.getByLabel("Container 2 type", { exact: true }).selectOption(ctx.fixtures.containerTypeId);
  await containers.getByLabel("Container 2 count", { exact: true }).fill("3");
  await containers.getByLabel("Container 2 scale gross", { exact: true }).fill("1.234");
  await containers.getByRole("button", { name: "Save containers", exact: true }).click();
  await waitForRedLines(panelMessage(containers), [
    "Container 1, Tare each (lb): cannot be negative.",
    "Container 2, Scale gross (lb): use at most 2 digits after the point.",
  ]);
  await assertNeverVisible(page.locator("p.mb-3.bg-red-50"),
    "a refused grid save must show under its own Save row, not in the page's banner", 300);
  await shot("hub-containers-refused");
  assert.equal(puts.count(), 0, "Save containers with refused boxes must send nothing");
  assert.deepEqual(await stored(), starting, "refused rows must not change what the order stores");
  puts.stop();
  // Leave the grid as it was: Discard clears the typed rows and the grid's message.
  await containers.getByRole("button", { name: "Discard changes to containers", exact: true }).click();
  await panelMessage(containers).waitFor({ state: "hidden" });
  await containers.getByLabel("Container 2 type", { exact: true }).waitFor({ state: "detached" });

  // 2. A Lines Net weight the rule refuses: Not saved, named by place, nothing sent.
  const lines = await hubSection(page, "Lines");
  const leadWeight = lines.getByLabel("Lead weight", { exact: true });
  await waitForValue(leadWeight, "1270");
  const patches = watchRequests(page, "PATCH", `/api/orders/${orderId}/lines/`);
  const sentence = "Lead, Net weight (lb): enter a number without $ or commas, such as 0.36.";
  await leadWeight.fill("1e2");
  await leadWeight.press("Tab");
  await lines.getByRole("alert", { name: "Lead weight not saved", exact: true }).waitFor();
  await waitForRedLines(panelMessage(lines), [sentence]);
  await assertNeverVisible(page.locator("p.mb-3.bg-red-50"),
    "a refused Lines box must show in the Lines section, not in the page's banner", 300);
  const reasonId = await leadWeight.getAttribute("aria-describedby");
  assert.ok(reasonId, "a Not saved box must name the paragraph that says why");
  assert.equal(((await lines.locator(`[id="${reasonId}"]`).textContent()) ?? "").trim(), sentence,
    "the refusal must be under the line, by the box's place");
  await shot("hub-line-weight-refused");
  assert.equal(patches.count(), 0, "a refused Net weight must send nothing");
  assert.equal((await stored()).weight, 1270, "a refused Net weight must not be stored");

  // 3. `.5` is a figure: it saves, reads Saved, takes the refusal off the section's message, and is stored.
  const answered = page.waitForResponse((res) =>
    new URL(res.url()).pathname.startsWith(`/api/orders/${orderId}/lines/`)
    && res.request().method() === "PATCH" && res.ok());
  await leadWeight.fill(".5");
  await leadWeight.press("Tab");
  await answered;
  await lines.getByRole("status", { name: "Lead weight saved", exact: true }).waitFor();
  await panelMessage(lines).waitFor({ state: "hidden" });
  assert.equal(patches.count(), 1, "a Net weight typed as .5 must be one save");
  patches.stop();
  assert.equal((await stored()).weight, 0.5, "a Net weight typed as .5 must be stored as 0.5");
}
