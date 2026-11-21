// Decimal entry, pull request 5b (#517): the rate screens check a typed figure through the one rule,
// name each refused box, and send nothing.
//
//   - The customer page, on the money fixture customer (`moneyCustomer` in e2e/lib/db-fixtures.ts):
//     Sales tax rate `7.12345` on blur names the box in the page's banner, puts back what the box
//     held and sends no PUT. Then `7.25` saves, and a GET reads the stored fraction 0.0725.
//   - The same page's Surcharge overrides: the fixture surcharge's Rate override `-1` is named with
//     its surcharge in that section's own message (P6 step 5c), the box shows the stored figure and
//     nothing is sent. Then `5` makes an override, whose Clear override asks through the one modal
//     (ruling 5): Cancel sends nothing, and the confirm removes it.
//   - Accounting: Finance charge `1,5` is named in the banner, the box goes back and nothing is sent.
//     `BillingConfig` is global, so nothing on Accounting is saved, and the stored row is read before
//     and after to show it did not move.
//   - Pick lists, Container types: the fixture tote's Tare each `-1` is named with its row in the
//     table's red line and sends no PUT; the Add row's `1.234` is listed by its label, keeps what was
//     typed and sends no POST.
//
// The two writes are the money customer's Sales tax rate and that override, both shared fixture
// state: the flow reads the rate first, arms the restore BEFORE the first write (#321) and puts each
// back through `ctx.apiMutate`, the rate by an exact-value PUT and an override still standing by its
// DELETE, reading it back after, failing or not. The money customer is not taxable, so the rate
// prices nothing while it is set. Every other step sends nothing. It ends with nothing typed.
import assert from "node:assert/strict";
import { readJson } from "../lib/order-entry-workspace.mjs";
import { assertNeverVisible, waitForValue } from "../lib/ui.mjs";
import { openRecordTab } from "../lib/record-tabs.mjs";
import { answerModal, modalTitle } from "../lib/modal.mjs";
import { panelMessage, redLine, waitForRedLines, watchRequests } from "../lib/refusal-lines.mjs";

/** The page-top banner on the customer page and on Accounting (one refusal at a time). */
const banner = (page) => page.locator("p.mb-3.bg-red-50");

export async function run(page, shot, ctx) {
  const customerId = ctx.fixtures.moneyCustomerId;
  const customerPath = `/api/customers/${customerId}`;
  const startingRate = (await readJson(page, ctx, customerPath)).salesTaxRate;
  assert.equal(startingRate, null, "the money customer starts with no Sales tax rate of its own");

  // Armed before the first write. An exact-value PUT is safe to send twice.
  const restoreSalesTaxRate = async () => {
    const res = await ctx.apiMutate(page, `${ctx.baseURL}${customerPath}`, {
      method: "PUT", data: { salesTaxRate: startingRate }, idempotent: true });
    assert.equal(res.ok(), true, `restoring the money customer's Sales tax rate: ${await res.text()}`);
    assert.equal((await readJson(page, ctx, customerPath)).salesTaxRate, startingRate,
      "the money customer's Sales tax rate must be restored");
  };
  // The step clears its own override; this one is for a run that failed before it did.
  const surchargeOption = async () => (await readJson(page, ctx, `${customerPath}/surcharges`))
    .find((o) => o.surchargeName === ctx.fixtures.invSurchargeName);
  const restoreOverride = async () => {
    const option = await surchargeOption();
    if (!option?.hasOverride) return;
    const res = await ctx.apiMutate(page, `${ctx.baseURL}${customerPath}/surcharges`, {
      method: "DELETE", data: { surchargeId: option.surchargeId } });
    assert.equal(res.ok(), true, `restoring the money customer's surcharge override: ${await res.text()}`);
    assert.equal((await surchargeOption())?.hasOverride, false, "the money customer's surcharge override must be gone");
  };

  let failed = true;
  try {
    await customerPage(page, shot, ctx, customerId);
    failed = false;
  } finally {
    try {
      await restoreSalesTaxRate();
      await restoreOverride();
    } catch (error) {
      if (!failed) throw error;
      console.error(`rates-decimal-entry: restoring the money customer failed after the flow failed: ${error}`);
    }
  }
  await accounting(page, shot, ctx);
  await containerTypes(page, shot, ctx);
}

/** The customer page: Sales tax rate, then a surcharge's Rate override. */
async function customerPage(page, shot, ctx, customerId) {
  const customerPath = `/api/customers/${customerId}`;
  await page.goto(`${ctx.baseURL}/customers/${customerId}`);
  // Sales tax rate and the Surcharge overrides are both on Terms & billing (PR 8).
  await openRecordTab(page, "Terms & billing");
  // The label also holds the box's hint, so the box is found inside the label rather than by name.
  const salesTax = page.locator("label", { hasText: "Sales tax rate (%)" }).locator("input");
  await salesTax.waitFor({ state: "visible", timeout: 15000 });
  await waitForValue(salesTax, "");

  // A refused figure: named in the banner, the box goes back to what it held, nothing is sent.
  const puts = watchRequests(page, "PUT", customerPath, { exact: true });
  await salesTax.fill("7.12345");
  await salesTax.press("Tab");
  await waitForRedLines(banner(page), ["Sales tax rate (%): use at most 4 digits after the point."]);
  await waitForValue(salesTax, "");
  await shot("sales-tax-refused");
  assert.equal(puts.count(), 0, "a refused Sales tax rate must send nothing");
  assert.equal((await readJson(page, ctx, customerPath)).salesTaxRate, null,
    "a refused Sales tax rate must not change what is stored");

  // `7.25` is a figure: one save, the banner goes, and the stored figure is the fraction.
  const saved = page.waitForResponse((res) =>
    new URL(res.url()).pathname === customerPath && res.request().method() === "PUT");
  await salesTax.fill("7.25");
  await salesTax.press("Tab");
  assert.equal((await saved).ok(), true, "an accepted Sales tax rate must save");
  await banner(page).waitFor({ state: "hidden" });
  assert.equal(puts.count(), 1, "an accepted Sales tax rate must be one save");
  puts.stop();
  await waitForValue(salesTax, "7.25");
  assert.equal(Number((await readJson(page, ctx, customerPath)).salesTaxRate), 0.0725,
    "a Sales tax rate typed as 7.25 must be stored as the fraction 0.0725");

  // Surcharge overrides: the fixture surcharge's row, found by its name.
  const surchargeName = ctx.fixtures.invSurchargeName;
  const overrides = page.locator("section").filter({ has: page.getByRole("heading", { name: "Surcharge overrides", exact: true }) });
  const row = overrides.locator("div.flex").filter({ has: page.getByText(surchargeName, { exact: true }) });
  const rate = row.getByLabel("Rate override (%)", { exact: true });
  await rate.waitFor({ state: "visible", timeout: 15000 });
  await waitForValue(rate, "");
  const overridePuts = watchRequests(page, "PUT", `${customerPath}/surcharges`, { exact: true });
  await rate.fill("-1");
  await rate.press("Tab");
  // In the Surcharge overrides section's own message (ruling R1, P6 step 5c), never the banner.
  await waitForRedLines(panelMessage(overrides), [`${surchargeName}, Rate override (%): cannot be negative.`]);
  await assertNeverVisible(banner(page), "a refused Rate override must not show in the page banner", 300);
  await waitForValue(rate, "");
  await shot("rate-override-refused");
  assert.equal(overridePuts.count(), 0, "a refused Rate override must send nothing");
  overridePuts.stop();
  const options = await readJson(page, ctx, `${customerPath}/surcharges`);
  const option = options.find((o) => o.surchargeName === surchargeName);
  assert.ok(option, "the fixture surcharge must be listed for the customer");
  assert.deepEqual({ hasOverride: option.hasOverride, rate: option.rate }, { hasOverride: false, rate: null },
    "a refused Rate override must store no override");

  // Clear override asks through the one modal (ruling 5). A figure the box takes makes the
  // override; Cancel sends nothing, and the confirm leaves the row as the flow found it.
  const overrideSaved = page.waitForResponse((res) =>
    new URL(res.url()).pathname === `${customerPath}/surcharges` && res.request().method() === "PUT" && res.ok());
  await rate.fill("5");
  await rate.press("Tab");
  await overrideSaved;
  const clear = row.getByRole("button", { name: "Clear override", exact: true });
  await clear.waitFor({ state: "visible", timeout: 15000 });
  const overrideDeletes = watchRequests(page, "DELETE", `${customerPath}/surcharges`, { exact: true });
  await clear.click();
  assert.equal(await modalTitle(page), `Clear the "${surchargeName}" override?`);
  await answerModal(page, { confirm: false });
  assert.equal(overrideDeletes.count(), 0, "a cancelled Clear override must send nothing");
  await clear.click();
  await answerModal(page);
  await row.getByText(/^no override/).waitFor({ state: "visible", timeout: 15000 });
  assert.equal(overrideDeletes.count(), 1, "Clear override must send one removal");
  overrideDeletes.stop();
}

/** Accounting: Finance charge refused; the global row is read before and after and must not move. */
async function accounting(page, shot, ctx) {
  const before = await readJson(page, ctx, "/api/admin/billing");
  await page.goto(`${ctx.baseURL}/admin/billing`);
  await openRecordTab(page, "Statement finance charge");
  const finance = page.getByLabel("Monthly rate (%)", { exact: true });
  await finance.waitFor({ state: "visible", timeout: 15000 });
  const held = await finance.inputValue();
  assert.notEqual(held, "1,5", "the Finance charge box must not already hold the refused text");

  const puts = watchRequests(page, "PUT", "/api/admin/billing", { exact: true });
  await finance.fill("1,5");
  await finance.press("Tab");
  await waitForRedLines(banner(page), ["Monthly rate (%): enter a number without % or commas, such as 7.25."]);
  await waitForValue(finance, held);
  await shot("finance-charge-refused");
  assert.equal(puts.count(), 0, "a refused Finance charge must send nothing");
  puts.stop();
  assert.deepEqual(await readJson(page, ctx, "/api/admin/billing"), before, "Accounting must store nothing");
}

/** Pick lists, Container types: an existing row's Tare each, then the Add row. */
async function containerTypes(page, shot, ctx) {
  const name = ctx.fixtures.containerTypeName;
  const listPath = "/api/admin/reference/containerType";
  const storedTare = async () => {
    const rows = await readJson(page, ctx, listPath);
    const row = rows.find((r) => r.name === name);
    assert.ok(row, `the fixture container type ${name} must be listed`);
    return row.tareEach;
  };
  const startingTare = await storedTare();
  await page.goto(`${ctx.baseURL}/admin/reference`);
  await page.getByRole("button", { name: "Container types", exact: true }).click();
  const tare = page.getByLabel(`Tare each (lb) for ${name}`, { exact: true });
  await tare.waitFor({ state: "visible", timeout: 15000 });
  const shown = await tare.inputValue();

  // An existing row: named with its row, under that row (ruling R1, P6 step 5d), and the box shows
  // the stored figure. The page's line, the list read's, stays empty.
  const puts = watchRequests(page, "PUT", `${listPath}/`);
  await tare.fill("-1");
  await tare.press("Tab");
  const tareRow = page.getByRole("row").filter({ has: tare });
  await waitForRedLines(panelMessage(tareRow), [`${name}, Tare each (lb): cannot be negative.`]);
  await assertNeverVisible(redLine(page), "a refused Tare each must not write the page's line");
  await waitForValue(tare, shown);
  await shot("tare-each-refused");
  assert.equal(puts.count(), 0, "a refused Tare each must send nothing");
  puts.stop();
  assert.equal(await storedTare(), startingTare, "a refused Tare each must not change what is stored");

  // The Add row: the refusal is listed by the column's label, what was typed stays, nothing is sent.
  const posts = watchRequests(page, "POST", listPath, { exact: true });
  const addTare = page.getByPlaceholder("Tare each (lb)", { exact: true });
  await addTare.fill("1.234");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const addRow = page.getByRole("row").filter({ has: addTare });
  await waitForRedLines(panelMessage(addRow), ["Tare each (lb): use at most 2 digits after the point."]);
  await assertNeverVisible(redLine(page), "a refused Add row must not write the page's line");
  await waitForValue(addTare, "1.234");
  await shot("add-tare-each-refused");
  assert.equal(posts.count(), 0, "a refused Add row must send nothing");
  posts.stop();
  await addTare.fill("");
}
