// Harness proposal only: prepare separate real records for flows/draft-recovery.mjs.
// The mandatory DB reaper runs after acknowledged writes plus context closure; uncertain writes
// first require the existing owned-server shutdown boundary, including failure.
import assert from "node:assert/strict";
import { createOrderViaUi, hubSection, openOrderTab, startNewShipment, waitForShipmentPage } from "./orders.mjs";
import { pickComboboxValue, waitForValue } from "./ui.mjs";
import { openRecordTab } from "./record-tabs.mjs";

// A section on a page other than the order hub (the invoicing list, the quote page); a hub
// section is reached through `hubSection`, which opens its tab first (PR 2).
const section = (page, title) => page.locator("section").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
const serialEditor = (page, label) => page.getByLabel(`${label} add serial`, { exact: true }).locator("xpath=ancestor::div[1]");

export async function prepareDraftRecoveryFixtures(page, ctx) {
  const seed = ctx.fixtures.draftRecoverySeed, owned = ctx.created.draftRecovery;
  assert.ok(seed && owned, "Parent must create and register the isolated recovery seed before running setup");
  assert.equal(owned.phase, "seeded", "Do not repeat partially committed fixture setup");
  owned.phase = "setting-up";
  const remember = (kind, id) => {
    assert.equal(typeof id, "string", `Actual ${kind} creation must return an ID`);
    if (!owned.ids.some(row => row.kind === kind && row.id === id)) owned.ids.push({ kind, id });
    return id;
  };
  // Own rejection before the UI action can fail or context closure rejects its response.
  // The response callback also captures known IDs independently of later UI continuation.
  async function response(predicate, action, accept = res => res) {
    const outcome = page.waitForResponse(predicate).then(accept)
      .then(value => ({ ok: true, value }), error => ({ ok: false, error }));
    await action(); // Preserve this exact UI error; the response already has a rejection owner.
    const result = await outcome;
    if (!result.ok) throw result.error;
    return result.value;
  }
  // Exact customer/name/notes fallback covers creations whose JSON response never arrives.
  async function created(kind, endpoint, action) {
    return response(res => new URL(res.url()).pathname === endpoint && res.request().method() === "POST", action,
      async res => {
        assert.equal(res.ok(), true, `${kind} fixture creation must succeed`);
        const body = await res.json();
        const entity = body.order ?? body.shipper ?? body.invoice ?? body;
        remember(kind, entity.id); return entity;
      });
  }
  async function save(scope, name, endpoint) {
    const saved = await response(res => new URL(res.url()).pathname === endpoint && res.request().method() === "PUT",
      () => scope.getByRole("button", { name, exact: true }).click());
    assert.equal(saved.ok(), true, `${name} baseline Save`);
  }
  async function order(lines) {
    let result;
    await created("order", "/api/orders", async () => {
      result = await createOrderViaUi(page, ctx, { customerCode: seed.customerCode, lines });
    });
    remember("order", result.id); return result;
  }
  async function containerAndSerials(orderId, labels) {
    const containers = await hubSection(page, "Containers");
    await containers.getByRole("button", { name: "Add container", exact: true }).click();
    await page.getByLabel("Container 1 type", { exact: true }).selectOption(seed.containerTypeId);
    await page.getByLabel("Container 1 count", { exact: true }).fill("2");
    await save(containers, "Save containers", `/api/orders/${orderId}/containers`);
    for (const [index, label] of labels.entries()) {
      const input = page.getByLabel(`${label} add serial`, { exact: true });
      await input.fill(`DR273-${orderId}-${index + 1}`); await input.press("Enter");
      const saved = await response(res => new URL(res.url()).pathname.startsWith(`/api/orders/${orderId}/lines/`) && res.request().method() === "PUT",
        () => serialEditor(page, label).getByRole("button", { name: "Save serials", exact: true }).click());
      assert.equal(saved.ok(), true, "Saved fixture serials");
    }
  }
  async function ship(selected) {
    await startNewShipment(page, ctx, seed.customerId, [selected]);
    let result;
    await created("shipment", "/api/shippers", async () => {
      await page.getByRole("button", { name: "Save shipment", exact: true }).click();
      result = await waitForShipmentPage(page);
    });
    return result;
  }
  async function invoice(selected) {
    await page.goto(`${ctx.baseURL}/invoicing`);
    const row = section(page, "Ready to invoice").locator("tr").filter({ has: page.getByText(String(selected.number), { exact: true }) });
    await row.locator('input[type="checkbox"]').check();
    const result = await created("invoice", "/api/invoices", async () => { await page.getByRole("button", { name: "Create invoices", exact: true }).click(); });
    await page.goto(`${ctx.baseURL}/invoicing/${result.id}`);
    await openRecordTab(page, "Lines"); // PR 6: the grid is on the Lines tab
    await page.getByLabel("Line 1 description", { exact: true }).waitFor({ state: "visible" });
    return { id: result.id };
  }

  // All orderable parts/customer/codes are separate from existing order/shipping/AR flows.
  const gridOrder = await order([{ partNumber: seed.parts[0].partNumber, qty: 10 }, { partNumber: seed.parts[1].partNumber, qty: 4 }]);
  await containerAndSerials(gridOrder.id, ["Lead", "Line 2"]);
  const charges = await hubSection(page, "Charges");
  await charges.getByRole("button", { name: "Add charge", exact: true }).click();
  await page.getByLabel("Charge 1 description", { exact: true }).fill("Saved recovery fixture charge");
  await page.getByLabel("Charge 1 amount", { exact: true }).fill("12.50");
  await save(charges, "Save charges", `/api/orders/${gridOrder.id}/charges`);

  const shippingOrder = await order([{ partNumber: seed.parts[2].partNumber, qty: 10 }]);
  await containerAndSerials(shippingOrder.id, ["Lead"]);
  const shipment = await ship(shippingOrder);
  const draftInvoice = await invoice(shippingOrder);

  const paymentOrder = await order([{ partNumber: seed.parts[2].partNumber, qty: 10 }]);
  await ship(paymentOrder);
  const paymentInvoice = await invoice(paymentOrder);
  const finalized = await response(res => new URL(res.url()).pathname === `/api/invoices/${paymentInvoice.id}/finalize` && res.request().method() === "POST",
    () => page.getByRole("button", { name: "Finalize invoice", exact: true }).click());
  assert.equal(finalized.ok(), true); await page.getByText("Finalized", { exact: true }).waitFor({ state: "visible" });
  const date = new Date().toISOString().slice(0, 10);
  // The real create API supports notes; the New batch UI exposes only date/controlTotal.
  // The exact marker lets the reaper recover an empty batch if this response is lost.
  const batchResponse = await ctx.apiMutate(page, `${ctx.baseURL}/api/receivables/batches`, {
    method: "POST", data: { depositDate: date, controlTotal: null, notes: seed.batchMarker },
  });
  assert.equal(batchResponse.ok(), true, "Owned marker-bearing receipt batch");
  const batch = await batchResponse.json(); remember("receipt-batch", batch.id);
  await page.goto(`${ctx.baseURL}/receivables/batches/${batch.id}`);
  await pickComboboxValue(page, "Payer customer", seed.customerId);
  await page.locator("label", { hasText: "Payment type" }).locator("select").selectOption(seed.paymentTypeId);
  await page.getByLabel("Amount", { exact: true }).fill("700.00");
  const reference = "DR273-RAW-RECOVERY-PAYMENT";
  await page.getByLabel("Check #", { exact: true }).fill(reference);
  await page.getByLabel("Received date", { exact: true }).fill(date);
  // addPayment returns the entire batch, so capture the new payment from the resulting detail.
  await response(res => new URL(res.url()).pathname === `/api/receivables/batches/${batch.id}/payments` && res.request().method() === "POST",
    () => page.getByRole("button", { name: "Add payment", exact: true }).click(), async res => {
      assert.equal(res.ok(), true);
      const batchDetail = await res.json();
      const payment = batchDetail.payments.find(row => row.reference === reference);
      assert.ok(payment); remember("payment", payment.id);
    });
  await page.getByText(reference, { exact: true }).waitFor({ state: "visible" });

  const newShipmentOrder = await order([{ partNumber: seed.parts[2].partNumber, qty: 10 }]);
  await containerAndSerials(newShipmentOrder.id, ["Lead"]);
  await order([{ partNumber: seed.parts[3].partNumber, qty: 12 }]);
  // The order-scope cert the save minted is listed on the hub's Shipping & certs tab (PR 2).
  await openOrderTab(page, "Shipping & certs");
  const certLink = page.getByRole("link", { name: "By order", exact: true });
  await certLink.waitFor({ state: "visible" });
  const certPath = await certLink.getAttribute("href"); assert.match(certPath, /^\/certs\/[^/]+$/);
  const certId = remember("cert", certPath.split("/").at(-1));

  await page.goto(`${ctx.baseURL}/quotes`);
  const form = section(page, "New quote");
  await pickComboboxValue(form, "Customer", seed.customerId);
  await pickComboboxValue(form, "First line: part", seed.parts[4].id);
  const quote = await created("quote", "/api/quotes", async () => { await form.getByRole("button", { name: "New quote", exact: true }).click(); });
  await page.getByRole("heading", { name: /^Quote #\d+/ }).waitFor({ state: "visible" });
  const card = section(page, "Lines").locator("div.space-y-4 > div").first();
  await pickComboboxValue(card, "Add operation", seed.priceCodeId);
  await card.getByLabel("Unit price", { exact: true }).fill("4.50");
  const quoteSave = await response(res => new URL(res.url()).pathname === `/api/quotes/${quote.id}` && res.request().method() === "PATCH",
    () => page.getByRole("button", { name: "Save quote", exact: true }).click());
  assert.equal(quoteSave.ok(), true);
  // The badge is drawn in the header and on the dirty tab (PR 3): wait until none is left.
  await page.getByText("Unsaved changes", { exact: true }).first().waitFor({ state: "hidden" });

  // seed.parts[5] already carries its two process steps (db-fixtures.ts's
  // createDraftRecoveryFixtures appends them), so the part case needs no setup write here.
  await page.goto(`${ctx.baseURL}/admin/part-fields`);
  const customFields = [];
  for (const [index, type] of ["TEXT", "NUMBER", "CHECKBOX"].entries()) {
    const row = page.locator("tr").filter({ has: page.getByPlaceholder("Name", { exact: true }) });
    await row.getByPlaceholder("Name", { exact: true }).fill(seed.fieldNames[index]); await row.locator("select").selectOption(type);
    const definition = await created("part-field-def", "/api/admin/part-fields", async () => { await row.getByRole("button", { name: "Add", exact: true }).click(); });
    customFields.push({ id: definition.id, name: seed.fieldNames[index], type });
    await waitForValue(row.getByPlaceholder("Name", { exact: true }), "");
  }
  await page.goto(`${ctx.baseURL}/admin/templates`);
  await page.getByRole("combobox", { name: "New template document type", exact: true }).selectOption("TRAVELER");
  await page.getByPlaceholder("Template name", { exact: true }).fill(seed.documentTemplateName);
  const documentTemplate = await created("document-template", "/api/templates", async () => { await page.getByRole("button", { name: "Create template", exact: true }).click(); });
  await page.getByText("Open draft: v1", { exact: true }).waitFor({ state: "visible" });
  // The Process Steps table prints each step's code under its name; the flow finds a row by it.
  const stepCodes = [seed.stepCodeA, seed.stepCodeB].map(code => code.code);
  const descriptor = {
    order: gridOrder, shipment: { id: shipment.id, orderId: shippingOrder.id }, invoice: draftInvoice,
    payment: { batchId: batch.id, reference, orderNumber: paymentOrder.number }, quote: { id: quote.id },
    newShipment: { customerId: seed.customerId, orderId: newShipmentOrder.id, orderNumber: newShipmentOrder.number },
    cert: { id: certId, requirementNames: seed.inspectionNames },
    part: { id: seed.parts[5].id, revision: 1, stepCodes, customFields },
    documentTemplate: { id: documentTemplate.id, name: seed.documentTemplateName, version: 1 },
  };
  ctx.fixtures.draftRecovery = descriptor;
  owned.phase = "ready";
  return descriptor;
}
