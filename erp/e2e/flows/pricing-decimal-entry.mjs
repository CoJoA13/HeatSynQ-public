// Decimal entry, pull request 2 (#517): a part's Pricing section checks a typed figure through the
// one rule before it saves. Runs on the fixture part's single priced operation (setup 25.00,
// unit price 2.5000, minimum 50.00, no breaks), so every refusal reads "Operation 1".
//
//   - Unit price left holding `1e2`: the red line names the box by its place, the box shows the
//     stored figure again, and no request is made.
//   - `.36` is a figure: it saves, and a reload shows 0.36.
//   - Add price break with Threshold `0` and Price `0.12345`: both refusals are listed, one per line,
//     and no break is added.
//
// What is stored is read from the API (a read through the page's request context, with one retry of a reset socket),
// never from a box's text. The flow changes shared fixture state (the part's unit price), so it
// reads the stored price first and arms the restore BEFORE the first write (#321): a failure or the
// end of the flow puts it back through `ctx.apiMutate` and reads it back, whatever happens in between. The price
// route has only a PATCH, and `apiMutate` allows `idempotent: true` on a PUT alone, so the restore
// is an exact-value PATCH that tries a second time itself when the first does not answer ok.
import assert from "node:assert/strict";
import { assertNeverVisible, waitForValue } from "../lib/ui.mjs";
import { panelMessage, redLine, waitForRedLines, watchRequests } from "../lib/refusal-lines.mjs";
import { openRecordTab } from "../lib/record-tabs.mjs";
import { answerModal, modalTitle } from "../lib/modal.mjs";

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;
  const pricesUrl = `${ctx.baseURL}/api/parts/${fixtures.partId}/prices`;
  const stored = async () => {
    const res = await page.request.get(pricesUrl, { maxRetries: 1 });
    assert.equal(res.ok(), true, "reading the stored prices must succeed");
    const rows = await res.json();
    assert.equal(rows.length, 1, "the fixture part must hold exactly one priced operation");
    return { unitPrice: rows[0].unitPrice, breaks: rows[0].breaks.length };
  };
  const startingRes = await page.request.get(pricesUrl, { maxRetries: 1 });
  assert.equal(startingRes.ok(), true, "reading the starting prices must succeed");
  const startingRows = await startingRes.json();
  assert.equal(startingRows.length, 1, "the fixture part must hold exactly one priced operation");
  const priceId = startingRows[0].id;
  const startingUnitPrice = startingRows[0].unitPrice;
  assert.equal(startingUnitPrice, 2.5, "the fixture's starting unit price");

  // Armed before the first write. An exact-value PATCH is safe to send twice.
  const restoreUnitPrice = async () => {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const res = await ctx.apiMutate(page, `${pricesUrl}/${priceId}`, {
        method: "PATCH", data: { unitPrice: String(startingUnitPrice) } }).catch((e) => e);
      if (!(res instanceof Error) && res.ok()) break;
    }
    assert.equal((await stored()).unitPrice, startingUnitPrice, "the fixture's unit price must be restored");
  };

  try {
    await page.goto(`${ctx.baseURL}/parts/${fixtures.partId}`);
    await openRecordTab(page, "Pricing & quotes");
    const pricing = page.locator("section").filter({ has: page.getByRole("heading", { name: "Operation prices", exact: true }) });
    await pricing.waitFor({ state: "visible" });
    const unitPrice = pricing.getByLabel("Unit price", { exact: true });
    await waitForValue(unitPrice, "2.5");
    assert.deepEqual(await stored(), { unitPrice: 2.5, breaks: 0 }, "the fixture's starting price");

    // 1. A refused figure: the stored figure comes back, the box is named, nothing is sent.
    const saves = watchRequests(page, "PATCH", `/api/parts/${fixtures.partId}/prices/`);
    await unitPrice.fill("1e2");
    await unitPrice.blur();
    // In the Pricing section's own message (ruling R1, P6 step 5c), never the page banner.
    await waitForRedLines(panelMessage(pricing), [
      "Operation 1, Unit price: enter a number without $ or commas, such as 0.36.",
    ]);
    await assertNeverVisible(redLine(page), "a refused Pricing box must not show in the page banner", 300);
    await waitForValue(unitPrice, "2.5");
    await shot("pricing-unit-price-refused");
    assert.equal(saves.count(), 0, "leaving a refused box must send nothing");
    assert.deepEqual(await stored(), { unitPrice: 2.5, breaks: 0 }, "a refused figure must not be stored");
    saves.stop();

    // 2. `.36` is a figure: it saves, clears the red line, and a reload shows it.
    const saved = page.waitForResponse((res) =>
      new URL(res.url()).pathname.startsWith(`/api/parts/${fixtures.partId}/prices/`)
      && res.request().method() === "PATCH" && res.ok());
    await unitPrice.fill(".36");
    await unitPrice.blur();
    await saved;
    // The response resolves before the page renders the cleared line, so wait for it to go.
    await panelMessage(pricing).waitFor({ state: "hidden" });
    assert.deepEqual(await stored(), { unitPrice: 0.36, breaks: 0 }, "a Unit price typed as .36 must be stored as 0.36");
    await page.reload();
    await pricing.waitFor({ state: "visible" });
    await waitForValue(pricing.getByLabel("Unit price", { exact: true }), "0.36");

    // 3. Add price break with two refused boxes: both are listed, and no break is added.
    const breakSaves = watchRequests(page, "POST", `/api/parts/${fixtures.partId}/prices/`);
    await pricing.getByPlaceholder("Threshold", { exact: true }).fill("0");
    await pricing.getByPlaceholder("Price", { exact: true }).fill("0.12345");
    await pricing.getByRole("button", { name: "Add price break", exact: true }).click();
    await waitForRedLines(panelMessage(pricing), [
      "Operation 1, new break, Threshold: must be greater than zero.",
      "Operation 1, new break, Price: use at most 4 digits after the point.",
    ]);
    await shot("pricing-new-break-refused");
    assert.equal(breakSaves.count(), 0, "Add price break with refused boxes must send nothing");
    assert.deepEqual(await stored(), { unitPrice: 0.36, breaks: 0 }, "no break may be added");
    assert.equal(await pricing.locator("table tbody tr").count(), 0, "no break row may appear");
    breakSaves.stop();

    // 4. Remove operation price asks first (PR 9): Cancel sends nothing and the row stays.
    const removals = watchRequests(page, "DELETE", `/api/parts/${fixtures.partId}/prices/`);
    await pricing.getByRole("button", { name: "Remove operation price", exact: true }).click();
    assert.match(await modalTitle(page), /^Remove .+ pricing\?$/);
    await answerModal(page, { confirm: false });
    assert.equal(removals.count(), 0, "a cancelled Remove operation price must send nothing");
    await unitPrice.waitFor({ state: "visible" });
    removals.stop();
  } catch (error) {
    // Restore, and report the failure that got us here rather than a restore problem it caused.
    await restoreUnitPrice().catch(() => {});
    throw error;
  }
  await restoreUnitPrice();
}
