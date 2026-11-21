// Flow 13 (Phase 4, Task 20): the certification lifecycle (design spec §13.3). Keys an order for
// the cert-required part — the ORDER-scope cert is created by the order save itself (§6.2) — and
// finds it on the hub already SEEDED from the part's two inspections, with the frozen
// min/max/scale/location rendered read-only (§4.1: a part edit next month must never rewrite a
// cert being filled in). Enters readings and watches pass/fail compute LIVE on screen (§3.21:
// screen only — the page itself says it never prints), overrides a failing reading to Pass with
// the explicit override control, prints, and confirms the stored file is byte-identical on
// re-download (the stored-bytes reprint guarantee; two FRESH renders are never byte-compared —
// the renderPdf non-determinism rule) plus a second print archiving a second document.
import assert from "node:assert/strict";
import { assertNeverVisible, waitForTitle } from "../lib/ui.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { createOrderViaUi, openOrderTab } from "../lib/orders.mjs";
import { openRecordTab } from "../lib/record-tabs.mjs";

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;

  // --- The order; its save creates the order-scope cert (§6.2). ---
  await createOrderViaUi(page, ctx, {
    customerCode: fixtures.shipCustomerCode,
    lines: [{ partNumber: fixtures.certPartNumber, qty: 12 }],
  });

  // --- Hub Certifications section (on Shipping & certs since PR 2) lists it; the scope label
  // links to the cert page. ---
  await openOrderTab(page, "Shipping & certs");
  await page.getByRole("link", { name: "By order", exact: true }).waitFor({ state: "visible", timeout: 15000 });
  await shot("hub-cert-listed");
  await page.getByRole("link", { name: "By order", exact: true }).click();
  await page.getByRole("heading", { name: /^Certification #\d+/ }).waitFor({ state: "visible", timeout: 15000 });

  // --- Seeded from PartInspection, frozen (§4.1/§6.3): both requirements, in the part's own
  // sort order, with scale/min/max/sample qty/location copied at creation. ---
  const hardnessBlock = page.locator("div.border-line.p-3").filter({ hasText: fixtures.inspectionCodeAName });
  const caseDepthBlock = page.locator("div.border-line.p-3").filter({ hasText: fixtures.inspectionCodeBName });
  await hardnessBlock.waitFor({ state: "visible" });
  await caseDepthBlock.waitFor({ state: "visible" });
  // PR 5: the frozen scale, min and max read as one line, "Required 40–50 E2E HRC".
  await hardnessBlock.getByText(`Required 40–50 ${fixtures.inspectionScaleName}`, { exact: true }).waitFor({ state: "visible" });
  await hardnessBlock.getByRole("columnheader", { name: `Value (${fixtures.inspectionScaleName})`, exact: true }).waitFor({ state: "visible" });
  await hardnessBlock.getByText("E2E flange OD", { exact: true }).waitFor({ state: "visible" });
  await page.getByText("No readings yet.").first().waitFor({ state: "visible" });
  await shot("cert-seeded-frozen");

  // --- Readings: 45 passes the frozen 40–50 band, 60 fails it — both verdicts computed LIVE
  // client-side with the same computePassed the server runs, before any save. ---
  const valueInput = (row) => row.locator('input:not([type="checkbox"])').first();
  await hardnessBlock.getByRole("button", { name: "Add another reading", exact: true }).click();
  const row1 = hardnessBlock.locator("tbody tr").nth(0);
  await valueInput(row1).fill("45");
  await row1.getByText("Pass", { exact: true }).waitFor({ state: "visible" });
  await hardnessBlock.getByRole("button", { name: "Add another reading", exact: true }).click();
  const row2 = hardnessBlock.locator("tbody tr").nth(1);
  await valueInput(row2).fill("60");
  await row2.getByText("Fail", { exact: true }).waitFor({ state: "visible" });
  await shot("computed-pass-fail-live");

  // --- PR 5 (review focus 1): the unsaved block badges its tab, survives a switch to Wording &
  // signature and back, and the header's Print certificate stays refused meanwhile, with the
  // reason in its title (unsaved readings refuse the print; they never merely warn). ---
  const printButton = page.getByRole("button", { name: /^Print certificate$|^Printing…$/ });
  await waitForTitle(printButton, /^Save the readings first/, "the print's refusal while a block is unsaved");
  assert.ok(await printButton.isDisabled(), "Print certificate must be disabled while a block is unsaved");
  await openRecordTab(page, "Wording & signature");
  await page.getByRole("tab", { name: /^Inspection results/ }).getByText("Unsaved changes", { exact: true })
    .waitFor({ state: "visible" });
  await waitForTitle(printButton, /^Save the readings first/, "the print's refusal while the other tab is open");
  await page.getByText("Certification text", { exact: false }).first().waitFor({ state: "visible" });
  await openRecordTab(page, "Inspection results");
  assert.equal(await valueInput(hardnessBlock.locator("tbody tr").nth(0)).inputValue(), "45",
    "the unsaved reading must survive a tab switch");

  let saved = page.waitForResponse((res) =>
    res.url().includes("/results") && res.request().method() === "PUT" && res.ok());
  await hardnessBlock.getByRole("button", { name: "Save readings", exact: true }).click();
  await saved;
  // The summary reads the SERVER's stored verdicts back — three explicit states, never inferred
  // by subtraction (the Task 15 lesson).
  await page.getByText("1 passed", { exact: true }).waitFor({ state: "visible", timeout: 10000 });
  await page.getByText("1 failed", { exact: true }).waitFor({ state: "visible" });
  await page.getByText("0 pending", { exact: true }).waitFor({ state: "visible" });
  await shot("readings-saved");

  // --- Override the failing reading to Pass: explicit checkbox + verdict choice, audited, and
  // flagged on screen (§6.3). The block remounted after the save, so re-locate its rows. ---
  const row2Fresh = hardnessBlock.locator("tbody tr").nth(1);
  await row2Fresh.getByRole("checkbox").check();
  await row2Fresh.getByRole("combobox").selectOption("pass");
  saved = page.waitForResponse((res) =>
    res.url().includes("/results") && res.request().method() === "PUT" && res.ok());
  await hardnessBlock.getByRole("button", { name: "Save readings", exact: true }).click();
  await saved;
  await page.getByText("2 passed", { exact: true }).waitFor({ state: "visible", timeout: 10000 });
  await page.getByText("0 failed", { exact: true }).waitFor({ state: "visible" });
  await shot("override-round-trip");

  // The §3.21 explanation the page itself carries: pass/fail (and min/max/scale/override marks)
  // never appear on the printed certification.
  await page.getByText(/never appears on the printed certification/).waitFor({ state: "visible" });

  // --- Print: archives the document and stamps first-print printedAt. ---
  const popup = page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null);
  await page.getByRole("button", { name: "Print certificate", exact: true }).click();
  // The stored print is listed on the Documents & history tab (PR 5), its row's link "Open PDF";
  // a role locator finds nothing inside a hidden panel, so the tab is opened first and the href
  // read while it is open.
  await openRecordTab(page, "Documents & history");
  const certLink = page.getByRole("link", { name: "Open PDF", exact: true }).first();
  await certLink.waitFor({ state: "visible", timeout: 30000 });
  const href = await certLink.getAttribute("href");
  await (await popup)?.close().catch(() => {});
  // The subtitle and the card now carry the first-print date in place of "Not printed" (the page
  // reloaded server truth after the print, which is also what arms the §5.16 post-print results
  // gate).
  await assertNeverVisible(
    page.getByText("Not printed", { exact: true }),
    "the Printed facts should show the first-print date once printed",
  );
  const shotPath = await shot("cert-printed");

  // --- The stored file is exact: fetching the SAME archived document twice returns identical
  // bytes (Buffer.compare — the reprint guarantee, spec §12.12). ---
  const url = new URL(href, ctx.baseURL).toString();
  const first = await (await page.request.get(url, { maxRetries: 1 })).body();
  const second = await (await page.request.get(url, { maxRetries: 1 })).body();
  assert.ok(first.subarray(0, 5).toString() === "%PDF-", "the stored certification must be a PDF");
  assert.equal(Buffer.compare(first, second), 0,
    "re-downloading the stored certification must return byte-identical content");
  await fs.writeFile(path.join(path.dirname(shotPath), "certification.pdf"), first);

  // --- A second print action archives a SECOND document (each print is stored forever; the two
  // fresh renders are deliberately NOT byte-compared — renderPdf output is not deterministic). ---
  const popup2 = page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null);
  await page.getByRole("button", { name: "Print certificate", exact: true }).click();
  const deadline = Date.now() + 30000;
  for (;;) {
    if (await page.getByRole("link", { name: "Open PDF", exact: true }).count() >= 2) break;
    if (Date.now() > deadline) assert.fail("second print never appeared in the Documents list");
    await new Promise((r) => setTimeout(r, 250));
  }
  await (await popup2)?.close().catch(() => {});
  await shot("reprint-archived");
}
