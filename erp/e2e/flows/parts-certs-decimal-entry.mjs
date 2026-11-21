// Decimal entry, pull request 5c (#517): the part page, its Inspections and a certification's
// readings check a typed figure through the one rule, name each refused box, and send nothing.
//
//   - The part page, on the cert fixture part (`certPartNumber` in e2e/lib/db-fixtures.ts): Each
//     weight `1.23456` on blur names the box in the page's banner, puts back what the box held and
//     sends no PATCH of the part.
//   - The same part's Inspections: the Hardness row's Min `-1` on blur is named with its code in
//     the Inspections section's own message (P6 step 5c), the box goes back and no PATCH of the
//     row is sent.
//   - A certification: an order keyed on the cert part mints its order-scope cert, and in the
//     Hardness block readings `-1` and `1.23456` with Save readings list both refusals, one line
//     each, in that block's own red line, and no PUT of readings is sent. The block's Discard
//     (ruling 28) then puts back its saved readings, none, and takes the red line with it.
//
// The part's stored Each weight and inspection rows are read before and after and must not move;
// cert-results-print reads that part's inspections when its own cert is created, so nothing here
// writes them. The one write is the order this flow keys against the shipping fixture customer,
// which fixture cleanup removes with that customer's other orders; its cert is this flow's own and
// is left with no readings stored. The refused readings stay only in this page's own draft store
// until Discard drops them.
import assert from "node:assert/strict";
import { createOrderViaUi, openOrderTab } from "../lib/orders.mjs";
import { readJson } from "../lib/order-entry-workspace.mjs";
import { assertNeverVisible, waitForValue } from "../lib/ui.mjs";
import { panelMessage, redLine, waitForRedLines, watchRequests } from "../lib/refusal-lines.mjs";
import { openRecordTab } from "../lib/record-tabs.mjs";
import { glanceValue } from "../lib/invoicing.mjs";

export async function run(page, shot, ctx) {
  await partPage(page, shot, ctx);
  await certReadings(page, shot, ctx);
}

/** The part page: Each weight, then a saved inspection row's Min. Refusals only. */
async function partPage(page, shot, ctx) {
  const { fixtures } = ctx;
  const partId = fixtures.certPartId;
  const partPath = `/api/parts/${partId}`;
  const inspectionsPath = `${partPath}/inspections`;
  const storedEachWeight = async () => (await readJson(page, ctx, partPath)).eachWeight;
  const storedInspections = async () => readJson(page, ctx, inspectionsPath);
  const startingEachWeight = await storedEachWeight();
  const startingInspections = await storedInspections();

  await page.goto(`${ctx.baseURL}/parts/${partId}`);
  // The label holds the box, so the box is found inside the label.
  const eachWeight = page.locator("label", { hasText: "Each weight (lb)" }).locator("input");
  await eachWeight.waitFor({ state: "visible", timeout: 15000 });
  const held = await eachWeight.inputValue();
  assert.notEqual(held, "", "the cert part's Each weight box must show its stored figure");
  assert.equal(await glanceValue(page, "Each weight").innerText(), `${held} lb`, "the card reads the box's figure with its unit");

  // A refused figure: named in the banner, the box goes back to what it held, nothing is sent.
  const partPatches = watchRequests(page, "PATCH", partPath, { exact: true });
  await eachWeight.fill("1.23456");
  await eachWeight.press("Tab");
  await waitForRedLines(redLine(page), ["Each weight (lb): use at most 4 digits after the point."]);
  await waitForValue(eachWeight, held);
  await shot("each-weight-refused");
  assert.equal(partPatches.count(), 0, "a refused Each weight must send nothing");
  partPatches.stop();
  assert.equal(await storedEachWeight(), startingEachWeight, "a refused Each weight must not change what is stored");

  // Inspections: the fixture's first row is Hardness (sort 1). The code cell is a select listing
  // every code, so the row is taken by position and its select's value proves which row it is.
  await openRecordTab(page, "Specifications & inspections");
  const inspections = page.locator("section").filter({ has: page.getByRole("heading", { name: "Inspection requirements", exact: true }) });
  const row = inspections.locator("tbody tr").nth(0);
  const code = row.locator("select").first();
  await code.waitFor({ state: "visible", timeout: 15000 });
  await waitForValue(code, fixtures.inspectionCodeAId);
  const min = row.locator("td").nth(2).locator("input");
  const heldMin = await min.inputValue();
  assert.notEqual(heldMin, "", "the Hardness row's Min must show its stored figure");

  const rowPatches = watchRequests(page, "PATCH", `${inspectionsPath}/`);
  await min.fill("-1");
  await min.press("Tab");
  // In the Inspections section's own message (ruling R1, P6 step 5c), never the page banner.
  await waitForRedLines(panelMessage(inspections), [`${fixtures.inspectionCodeAName}, Min: cannot be negative.`]);
  // The banner may still hold the Each weight refusal above (a header box, which stays there by the
  // owner's ruling of 2026-10-28), so the check is that the inspection's sentence is not in it.
  await assertNeverVisible(redLine(page).filter({ hasText: `${fixtures.inspectionCodeAName}, Min:` }),
    "a refused inspection Min must not show in the page banner", 300);
  await waitForValue(min, heldMin);
  await shot("inspection-min-refused");
  assert.equal(rowPatches.count(), 0, "a refused inspection Min must send nothing");
  rowPatches.stop();
  assert.deepEqual(await storedInspections(), startingInspections, "a refused inspection Min must not change what is stored");
}

/** A certification this flow owns: two refused readings listed in the block, nothing sent. */
async function certReadings(page, shot, ctx) {
  const { fixtures } = ctx;
  await createOrderViaUi(page, ctx, {
    customerCode: fixtures.shipCustomerCode,
    lines: [{ partNumber: fixtures.certPartNumber, qty: 4 }],
  });
  await openOrderTab(page, "Shipping & certs"); // PR 2: the hub's Certifications sit there
  const byOrder = page.getByRole("link", { name: "By order", exact: true });
  await byOrder.waitFor({ state: "visible", timeout: 15000 });
  await byOrder.click();
  await page.getByRole("heading", { name: /^Certification #\d+/ }).waitFor({ state: "visible", timeout: 15000 });
  const certId = new URL(page.url()).pathname.split("/").pop();
  assert.ok(certId, "the certification page's address must carry its id");

  const block = page.locator("div.border-line.p-3").filter({ hasText: fixtures.inspectionCodeAName });
  await block.waitFor({ state: "visible" });
  const valueInput = (tr) => tr.locator('input:not([type="checkbox"])').first();
  const addReading = block.getByRole("button", { name: "Add another reading", exact: true });
  await addReading.click();
  await valueInput(block.locator("tbody tr").nth(0)).fill("-1");
  await addReading.click();
  await valueInput(block.locator("tbody tr").nth(1)).fill("1.23456");

  const puts = watchRequests(page, "PUT", `/api/certs/${certId}/results`, { exact: true });
  await block.getByRole("button", { name: "Save readings", exact: true }).click();
  await waitForRedLines(block.locator("p.whitespace-pre-line.bg-red-50"), [
    "Reading 1, Value: cannot be negative.",
    "Reading 2, Value: use at most 4 digits after the point.",
  ]);
  // What was typed stays in the block.
  await waitForValue(valueInput(block.locator("tbody tr").nth(0)), "-1");
  await waitForValue(valueInput(block.locator("tbody tr").nth(1)), "1.23456");
  await shot("readings-refused");
  // Ruling 28 (P7 step 8): the block's Discard puts the saved readings back, none here, takes its
  // red line with it, leaves the block editable and sends nothing.
  await block.getByRole("button", { name: "Discard changes to cert results", exact: true }).click();
  await block.getByText("No readings yet.", { exact: true }).waitFor({ state: "visible" });
  await assertNeverVisible(block.locator("p.whitespace-pre-line.bg-red-50"),
    "Discard must take the block's refusal with it");
  await assertNeverVisible(block.getByText("Unsaved changes", { exact: true }),
    "a discarded block holds no unsaved work");
  assert.equal(await addReading.isEnabled(), true, "the block stays open for editing after Discard");
  assert.equal(puts.count(), 0, "refused readings and their Discard must send nothing");
  puts.stop();
  const cert = await readJson(page, ctx, `/api/certs/${certId}`);
  const stored = cert.requirements.find((r) => r.inspectionCodeName === fixtures.inspectionCodeAName);
  assert.ok(stored, "the certification must carry the Hardness requirement");
  assert.deepEqual(stored.readings, [], "refused readings must store nothing");
}
