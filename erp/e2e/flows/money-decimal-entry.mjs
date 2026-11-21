// Decimal entry, pull request 5a (#517): the money screens check a typed figure through the one
// rule, name each refused box by its place, list every refusal at once, and send nothing.
//
//   - An invoice draft with a weight of `1.234` on the first Part / operation line (the PART row,
//     the one that carries the weight) and a charge line's Amount of `$5`: Save lines lists both in
//     the grid's own message under Save lines (P6 step 5b) and sends no PUT. Fixed, with `.36` as the charge's Amount, it saves, and
//     the stored charge line reads 0.36.
//   - A receipt batch: Add a payment with a blank Amount is refused by name and sends nothing. On a
//     payment's apply grid, Amount `0` on one row and a Write-off of `1.234` (with a reason) on the
//     other: Apply lists both in the panel's own message (P6 step 5b) and sends no application.
//   - The customer page: an open credit's Apply credit with `1.234` puts the refusal in that row's
//     own red line, keeps `1.234` in the box and sends nothing. Credit limit `1.234` on blur names
//     the box in the page's banner, puts back the figure the box held and sends no PUT.
//
// Its records belong to the money fixture customer (`moneyCustomer` in e2e/lib/db-fixtures.ts), whose
// teardown reaps them: three orders and their shipments, one draft invoice (the charge-line one), two
// finalized invoices, one finalized credit memo against the first of those, and one receipt batch
// with one payment. The charge-line invoice stays a draft: close-month-end's export refuses a
// finalized invoice line with no GL account, and an added charge line has none. The finalized paper
// is priced on a step code that carries a GL account, as the A/R flow's is. The payment is voided
// before the flow ends, failing or not: close-month-end asserts that no open batch carries a live
// payment dated this month. The flow writes no shared fixture state, and Credit limit is never
// saved. Out-of-band writes go through `mutate` (the counted `ctx.apiMutate`); what is stored is read
// back through a GET. It ends with nothing unsaved.
import assert from "node:assert/strict";
import { mutate, readJson } from "../lib/order-entry-workspace.mjs";
import { assertNeverVisible, waitForValue } from "../lib/ui.mjs";
import { openRecordTab } from "../lib/record-tabs.mjs";
import { panelMessage, redLine, waitForRedLines, watchRequests } from "../lib/refusal-lines.mjs";

const sectionByHeading = (page, name) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) });

/** The table under one of the invoice's two line headings. */
const linesTable = (lines, heading) =>
  lines.getByRole("heading", { name: heading, exact: true }).locator("xpath=following-sibling::table[1]");

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;
  const customerId = fixtures.moneyCustomerId;
  const today = new Date().toISOString().slice(0, 10);

  /** One order of the money part, shipped whole, with a draft invoice raised on it. */
  async function shippedDraftInvoice(poNumber) {
    const saved = await mutate(page, ctx, "/api/orders", {
      clientRequestId: crypto.randomUUID(), customerId, poNumber,
      lines: [{ partId: fixtures.moneyPartId, qty: 10, weight: 50 }],
    });
    const order = await readJson(page, ctx, `/api/orders/${saved.order.id}`);
    assert.equal(order.lines.length, 1, "the fixture order must have one line");
    await mutate(page, ctx, "/api/shippers", {
      clientRequestId: crypto.randomUUID(), customerId, shipDate: today,
      orders: [{ orderId: order.id, lines: [{ orderLineId: order.lines[0].id, qty: 10, weight: 50, lineComplete: true }] }],
    });
    const { invoice } = await mutate(page, ctx, "/api/invoices", { orderId: order.id, clientRequestId: crypto.randomUUID() });
    return invoice;
  }
  const finalize = async (invoiceId) => (await mutate(page, ctx, `/api/invoices/${invoiceId}/finalize`)).invoice;

  const draft = await shippedDraftInvoice("DECIMAL-MONEY-DRAFT");
  const first = await finalize((await shippedDraftInvoice("DECIMAL-MONEY-1")).id);
  const second = await finalize((await shippedDraftInvoice("DECIMAL-MONEY-2")).id);
  const credit = await finalize((await mutate(page, ctx, `/api/invoices/${first.id}/credit`)).invoice.id);
  assert.equal(credit.kind, "CREDIT", "the credit memo must be finalized as a credit");

  // The batch and its payment are created back to back, and the payment is voided in `finally`. The
  // batch carries a note (`FIXTURE.moneyBatchNote` in db-fixtures.ts) so that teardown can reap it
  // empty if the payment POST below fails: it finds a batch only through its payments otherwise.
  const batch = await mutate(page, ctx, "/api/receivables/batches", {
    depositDate: today, controlTotal: null, notes: "E2E money-decimal-entry",
  });
  const reference = "DECIMAL-MONEY-CHECK";
  const withPayment = await mutate(page, ctx, `/api/receivables/batches/${batch.id}/payments`, {
    customerId, paymentTypeId: fixtures.arPaymentTypeId, amount: "500.00", reference, receivedDate: today,
  });
  const payment = withPayment.payments.find((row) => row.reference === reference);
  assert.ok(payment, "the fixture payment must be on the batch");

  let failed = true;
  try {
    await invoiceDraft(page, shot, ctx, draft);
    await receiptBatch(page, shot, ctx, batch.id, reference, [first, second]);
    await customerPage(page, shot, ctx, customerId);
    failed = false;
  } finally {
    try {
      await mutate(page, ctx, `/api/receivables/batches/${batch.id}/payments/${payment.id}`,
        { reason: "E2E money-decimal-entry flow: the fixture payment is voided so no open batch carries it." }, "DELETE");
    } catch (error) {
      if (!failed) throw error;
      console.error(`money-decimal-entry: voiding the fixture payment failed after the flow failed: ${error}`);
    }
  }
}

/** The invoice draft: two refused boxes in two tables, listed at once, and nothing sent. */
async function invoiceDraft(page, shot, ctx, draft) {
  await page.goto(`${ctx.baseURL}/invoicing/${draft.id}`);
  await openRecordTab(page, "Lines"); // PR 6: the grid is on the Lines tab
  const lines = sectionByHeading(page, "Lines");
  const partOps = linesTable(lines, "Part / operation lines");
  const weight = partOps.getByLabel("Line 1 weight", { exact: true });
  await weight.waitFor({ state: "visible", timeout: 20000 });
  const heldWeight = await weight.inputValue();
  assert.equal(Number(heldWeight), 50, "the PART line must carry the shipped weight");
  await lines.getByRole("button", { name: "Add charge line", exact: true }).click();
  const others = linesTable(lines, "Surcharges, freight, charges, cert & tax");
  const charge = others.getByLabel("Line 1 amount", { exact: true });
  await charge.waitFor({ state: "visible" });
  assert.equal(await others.locator("tbody tr").count(), 1, "the added charge must be the only row of the second table");

  const puts = watchRequests(page, "PUT", `/api/invoices/${draft.id}/lines`, { exact: true });
  await weight.fill("1.234");
  await others.getByLabel("Line 1 description", { exact: true }).fill("E2E money charge");
  await charge.fill("$5");
  await lines.getByRole("button", { name: "Save lines", exact: true }).click();
  // Under the lines grid's own Save row (ruling R1, P6 step 5b), never the page banner.
  await waitForRedLines(panelMessage(lines), [
    "Part / operation line 1, Net weight (lb): use at most 2 digits after the point.",
    "Surcharges line 1, Amount: enter a number without $ or commas, such as 0.36.",
  ]);
  await assertNeverVisible(redLine(page), "a refused Save lines must not show in the page banner", 300);
  await shot("invoice-draft-refused");
  assert.equal(puts.count(), 0, "Save lines with refused boxes must send nothing");
  await waitForValue(weight, "1.234");
  await waitForValue(charge, "$5");

  // Fixed, with `.36` as the charge's Amount: one save, and the stored charge line reads 0.36.
  await weight.fill(heldWeight);
  await charge.fill(".36");
  const saved = page.waitForResponse((res) =>
    new URL(res.url()).pathname === `/api/invoices/${draft.id}/lines` && res.request().method() === "PUT");
  await lines.getByRole("button", { name: "Save lines", exact: true }).click();
  assert.equal((await saved).ok(), true, "the fixed Save lines must succeed");
  await panelMessage(lines).waitFor({ state: "hidden" });
  assert.equal(puts.count(), 1, "the fixed Save lines must be one save");
  puts.stop();
  const { invoice } = await readJson(page, ctx, `/api/invoices/${draft.id}`);
  const stored = invoice.lines.filter((line) => line.kind === "CHARGE");
  assert.deepEqual(stored.map((line) => ({ description: line.description, amount: line.amount })),
    [{ description: "E2E money charge", amount: 0.36 }], "a charge typed as .36 must be stored as 0.36");
  assert.equal(invoice.lines.find((line) => line.kind === "PART").weight, 50, "the PART line's weight must be stored as typed back");
  await lines.getByRole("button", { name: "Save lines", exact: true }).waitFor({ state: "visible" });
  await shot("invoice-draft-saved");
}

/** The receipt batch: Add a payment with no amount, then two refused boxes on the apply grid. */
async function receiptBatch(page, shot, ctx, batchId, reference, invoices) {
  const { fixtures } = ctx;
  await page.goto(`${ctx.baseURL}/receivables/batches/${batchId}`);
  const paymentRow = page.locator("tr").filter({ has: page.getByText(reference, { exact: true }) });
  await paymentRow.waitFor({ state: "visible", timeout: 15000 });

  // Add a payment: customer, type and date set, Amount blank.
  const adds = watchRequests(page, "POST", `/api/receivables/batches/${batchId}/payments`, { exact: true });
  await page.locator("label", { hasText: "Payer customer" }).locator("select").selectOption(fixtures.moneyCustomerId);
  await page.locator("label", { hasText: "Payment type" }).locator("select").selectOption(fixtures.arPaymentTypeId);
  await page.getByLabel("Received date", { exact: true }).fill(new Date().toISOString().slice(0, 10));
  await page.getByLabel("Amount", { exact: true }).fill("");
  await page.getByRole("button", { name: "Add payment", exact: true }).click();
  await waitForRedLines(panelMessage(sectionByHeading(page, "Add payment")), ["Payment amount: must be greater than zero."]);
  await assertNeverVisible(redLine(page), "a refused Add payment must not show in the page banner", 300);
  await shot("add-payment-refused");
  assert.equal(adds.count(), 0, "Add a payment with no amount must send nothing");
  adds.stop();

  // The apply grid: the two finalized invoices, in the grid's own order.
  await paymentRow.getByRole("button", { name: "Apply", exact: true }).click();
  const applyTable = page.getByRole("columnheader", { name: "Write-off", exact: true }).locator("xpath=ancestor::table[1]");
  const rows = applyTable.locator("tbody tr");
  await rows.first().waitFor({ state: "visible", timeout: 15000 });
  const shown = (await rows.locator("td:first-child").allTextContents()).map((text) => text.trim());
  assert.deepEqual([...shown].sort(), invoices.map((invoice) => invoice.documentNumber).sort(),
    "the apply grid must list the customer's two open invoices");
  const [top, next] = shown;

  const applications = watchRequests(page, "POST", "/api/receivables/applications", { exact: true });
  await applyTable.getByLabel(`${top} amount`, { exact: true }).fill("0");
  await applyTable.getByLabel(`${next} write-off amount`, { exact: true }).fill("1.234");
  await applyTable.getByLabel(`${next} write-off reason`, { exact: true })
    .fill("E2E money-decimal-entry flow: a write-off the rule refuses.");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  // Inside the expanded payment row, through the Apply panel's own message (P6 step 5b).
  await waitForRedLines(panelMessage(sectionByHeading(page, "Payments")), [
    `${top}, Amount: must be greater than zero.`,
    `${next}, Write-off: use at most 2 digits after the point.`,
  ]);
  await assertNeverVisible(redLine(page), "a refused Apply must not show in the page banner", 300);
  await shot("apply-refused");
  assert.equal(applications.count(), 0, "Apply with refused boxes must send nothing");
  applications.stop();
  await waitForValue(applyTable.getByLabel(`${top} amount`, { exact: true }), "0");
  await waitForValue(applyTable.getByLabel(`${next} write-off amount`, { exact: true }), "1.234");

  await page.getByRole("button", { name: "Discard changes to payment application", exact: true }).click();
  await waitForValue(applyTable.getByLabel(`${next} write-off amount`, { exact: true }), "");
}

/** The customer page: Apply credit and Credit limit. */
async function customerPage(page, shot, ctx, customerId) {
  await page.goto(`${ctx.baseURL}/customers/${customerId}`);
  await openRecordTab(page, "Receivables"); // the section is on its own tab (PR 8)
  const receivables = sectionByHeading(page, "Receivables");
  const creditRow = receivables.locator("tbody tr").filter({ has: page.getByRole("cell", { name: "Credit", exact: true }) });
  await creditRow.waitFor({ state: "visible", timeout: 15000 });

  // An open credit's Apply credit: the refusal goes to that row's own red line.
  const posts = watchRequests(page, "POST", "/api/receivables/credit-applications", { exact: true });
  await creditRow.getByRole("button", { name: "Apply", exact: true }).click();
  const amount = receivables.getByLabel("Amount to apply", { exact: true });
  await amount.waitFor({ state: "visible" });
  await amount.fill("1.234");
  await receivables.getByRole("button", { name: "Apply credit", exact: true }).click();
  const rowError = receivables.locator("tr p.bg-red-50");
  await waitForRedLines(rowError, ["Amount to apply: use at most 2 digits after the point."]);
  await shot("apply-credit-refused");
  assert.equal(posts.count(), 0, "a refused Apply credit must send nothing");
  posts.stop();
  await waitForValue(amount, "1.234");
  await receivables.getByRole("button", { name: "Cancel", exact: true }).click();
  await amount.waitFor({ state: "hidden" });

  // Credit limit on blur: named in the banner, the box goes back to what it held, nothing is sent.
  await openRecordTab(page, "Terms & billing"); // Credit limit is in Commercial settings (PR 8)
  const banner = page.locator("p.mb-3.bg-red-50");
  const limit = page.getByLabel("Credit limit", { exact: true });
  await waitForValue(limit, "2500");
  const puts = watchRequests(page, "PUT", `/api/customers/${customerId}`, { exact: true });
  await limit.fill("1.234");
  await limit.press("Tab");
  await waitForRedLines(banner, ["Credit limit: use at most 2 digits after the point."]);
  await waitForValue(limit, "2500");
  await shot("credit-limit-refused");
  assert.equal(puts.count(), 0, "a refused Credit limit must send nothing");
  puts.stop();
  const stored = await readJson(page, ctx, `/api/customers/${customerId}`);
  assert.equal(Number(stored.creditLimit), 2500, "a refused Credit limit must not change what is stored");
}
