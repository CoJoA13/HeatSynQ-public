// Tests-only preparation. Fixture bridge/placement is pending formal Task 11 review.
// All controls below are production editors. The required descriptor contains only owned
// fixture identities/labels; it must be populated by the suite's create/reap lifecycle.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { openOrderTab } from "../lib/orders.mjs";
import { openInvoicingView } from "../lib/invoicing.mjs";
import { openRecordTab } from "../lib/record-tabs.mjs";

const section = (page, title) => page.locator("section").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
const sectionQuery = title => `Array.from(document.querySelectorAll('section')).find(s=>s.querySelector('h2')?.textContent.trim()===${JSON.stringify(title)})`;
const labelQuery = (label, root = "document") => `Array.from((${root})?.querySelectorAll('label')??[]).find(l=>l.textContent.trim().startsWith(${JSON.stringify(label)}))?.querySelector('input,textarea,select')`;
const ariaQuery = label => `document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)})`;
const offersQuery = "Array.from(document.querySelectorAll('button')).filter(b=>b.textContent.trim()==='Restore').length";
async function until(read, label, timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { if (await read()) return; await delay(30); }
  assert.fail(`Timed out: ${label}`);
}
// `tab` names the order-hub tab the field sits on (PR 2): a hidden tab's box cannot be waited on
// or filled, so `recover` opens it before either; the DOM reads (`query`) need no tab.
function field(label, raw, { aria = true, checkbox = false, select = false, root, locate, query, savedDisplay, touchedFalse = false, tab } = {}) {
  return { label, raw, checkbox, select, savedDisplay, touchedFalse, tab,
    query: query ?? (aria ? ariaQuery(label) : labelQuery(label, root)),
    locate: locate ?? (page => page.getByLabel(label, { exact: true })) };
}
const valuesQuery = fields => `[${fields.map(f => `(${f.query})?.${f.checkbox ? "checked" : "value"}??null`).join(",")}]`;
const enabledQuery = fields => fields.map(f => `((${f.query}) && !(${f.query}).matches(':disabled') && !(${f.query}).readOnly)`).join("&&");
const disabledQuery = fields => fields.map(f => `((${f.query})?.matches(':disabled') || (${f.query})?.readOnly===true)`).join("&&");

function fixtureInput(ctx) {
  const f = ctx.fixtures.draftRecovery;
  assert.ok(f, "Task 11 fixture bridge missing: ctx.fixtures.draftRecovery; see preparation report. Never skip editor cases.");
  for (const key of ["order", "shipment", "invoice", "payment", "quote", "newShipment", "cert", "part", "documentTemplate"]) {
    assert.ok(f[key] && typeof f[key] === "object", `Missing owned recovery fixture ${key}`);
  }
  for (const key of ["order", "shipment", "invoice", "quote", "cert", "part", "documentTemplate"]) assert.equal(typeof f[key].id, "string", `${key}.id`);
  assert.equal(typeof f.order.number, "number");
  assert.equal(typeof f.shipment.orderId, "string");
  assert.equal(typeof f.payment.batchId, "string"); assert.equal(typeof f.payment.reference, "string"); assert.equal(typeof f.payment.orderNumber, "number");
  assert.equal(typeof f.newShipment.orderId, "string"); assert.equal(typeof f.newShipment.orderNumber, "number"); assert.equal(typeof f.newShipment.customerId, "string");
  assert.equal(f.cert.requirementNames?.length, 2, "Two real cert requirements required");
  assert.equal(f.part.customFields?.length, 3, "Owned TEXT, NUMBER and CHECKBOX definitions required");
  assert.deepEqual(f.part.customFields.map(d => d.type), ["TEXT", "NUMBER", "CHECKBOX"]);
  assert.equal(f.part.stepCodes?.length, 2, "Two real selected-revision steps required");
  assert.ok(Number.isSafeInteger(f.part.revision) && f.part.revision > 0);
  assert.equal(typeof f.documentTemplate.name, "string");
  assert.equal(f.documentTemplate.version, 1, "Reviewed ordinary raw template case uses an owned draft v1");
  return f;
}

export async function run(page, shot, ctx) {
  const f = fixtureInput(ctx);
  const cdp = await page.context().newCDPSession(page);
  const writes = [], dialogs = [], pageErrors = [], consoleErrors = [], responses = [], dialogTasks = [];
  const requestIds = new WeakMap(); let sequence = 0;
  const onRequest = request => {
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return;
    requestIds.set(request, ++sequence);
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) writes.push({ path, method: request.method() });
  };
  const onResponse = response => {
    const request = response.request(), requestId = requestIds.get(request); if (!requestId) return;
    const item = { requestId, path: new URL(response.url()).pathname, method: request.method(), status: response.status(), finished: false };
    responses.push(item);
    response.finished().then(error => { item.finished = !error; }, () => {});
  };
  const onDialog = dialog => { dialogs.push({ type: dialog.type(), message: dialog.message() }); dialogTasks.push(dialog.dismiss()); };
  const onPageError = error => pageErrors.push(error.message);
  const onConsole = message => { if (message.type() === "error") consoleErrors.push(message.text()); };
  page.on("request", onRequest); page.on("response", onResponse); page.on("dialog", onDialog);
  page.on("pageerror", onPageError); page.on("console", onConsole);
  const observe = async expression => {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, userGesture: false });
    assert.equal(result.exceptionDetails, undefined, "Nonactivating observation must succeed");
    return result.result.value;
  };
  async function clearRetained(expected) {
    const toggle = page.getByRole("button", { name: /^Drafts in this tab/ });
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    const list = page.getByRole("region", { name: "Drafts in this tab", exact: true });
    await until(async () => await list.locator("li").count() === expected, "exact retained editor count");
    for (let remaining = expected; remaining > 0; remaining--) {
      await list.getByRole("button", { name: "Discard", exact: true }).first().click();
      await until(async () => await list.locator("li").count() === remaining - 1, "scoped local Discard");
    }
    await list.getByText("No unsaved drafts.", { exact: true }).waitFor({ state: "visible" });
    await list.getByRole("button", { name: "Close", exact: true }).click();
  }
  const completed = [];
  const show = async input => { if (input.tab) await openOrderTab(page, input.tab); };
  // Restore, one offer at a time. An order-hub case's offers sit on more than one tab (PR 2), and
  // a hidden tab's buttons are not found by role: such a case names its tabs (`offerTabs`), each
  // opened in turn and its visible offers taken until none is left, the total held to `offers`.
  async function restoreAll(test) {
    const restore = page.getByRole("button", { name: "Restore", exact: true });
    if (!test.offerTabs) {
      for (let i = 0; i < test.offers; i++) await restore.first().click();
      return;
    }
    let taken = 0;
    for (const tab of test.offerTabs) {
      await openOrderTab(page, tab);
      for (let shown = await restore.count(); shown > 0; shown = await restore.count()) {
        await restore.first().click();
        taken++;
        await until(async () => await restore.count() < shown, `${test.name} Restore taken on ${tab}`);
      }
    }
    assert.equal(taken, test.offers, `${test.name} every offer restored across its tabs`);
  }
  async function recover(test) {
    await page.goto(ctx.baseURL);
    await page.getByRole("navigation").getByRole("link", { name: test.navigation, exact: true }).click();
    await until(() => observe(`location.pathname===${JSON.stringify(test.listPath)}`), `${test.name} list`);
    if (test.open) await test.open(); else await page.locator(`a[href="${test.path}"]`).click();
    if (test.enter) await test.enter();
    for (const input of test.fields ?? []) { await show(input); await input.locate(page).waitFor({ state: "visible" }); }
    await until(() => observe(test.ready ?? enabledQuery(test.fields)), `${test.name} authorized controls`);
    const saved = await observe(test.values ?? valuesQuery(test.fields));
    if (test.initial) assert.deepEqual(saved, test.initial, `${test.name} required saved fixture shape`);
    if (test.prepare) await test.prepare(saved);
    const history = await cdp.send("Page.getNavigationHistory");
    assert.ok(history.currentIndex >= 2);
    assert.equal(new URL(history.entries[history.currentIndex - 2].url).pathname, "/");
    assert.equal(new URL(history.entries[history.currentIndex - 1].url).pathname, test.listPath);
    assert.equal(new URL(history.entries[history.currentIndex].url).pathname, test.path);
    const beforeWrites = writes.length;
    if (test.edit) await test.edit();
    else for (const input of test.fields) {
      await show(input);
      const control = input.locate(page);
      if (input.touchedFalse) { await control.check(); await control.uncheck(); }
      else if (input.checkbox) await control.setChecked(input.raw);
      else if (input.select) await control.selectOption(input.raw);
      else await control.fill(input.raw);
    }
    // Critical sequence: nothing activating after the final real input event, until all four
    // original-entry traversals and the history check finish. No locator/evaluate/screenshot.
    let returnBoundary;
    for (const index of [history.currentIndex - 1, history.currentIndex - 2, history.currentIndex - 1, history.currentIndex]) {
      if (index === history.currentIndex) returnBoundary = sequence;
      const entry = history.entries[index];
      await cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id });
      await until(() => observe(`location.pathname===${JSON.stringify(new URL(entry.url).pathname)}`), `${test.name} existing history entry`);
    }
    const returnedHistory = await cdp.send("Page.getNavigationHistory");
    assert.deepEqual(returnedHistory.entries.map(e => e.id), history.entries.map(e => e.id), "Exact original entry IDs/count");
    assert.equal(returnedHistory.currentIndex, history.currentIndex);
    if (test.returnSelection) await test.returnSelection();
    await until(() => observe(`${offersQuery}===${test.offers}`), `${test.name} explicit offers`);
    await until(() => test.reads.every(path => responses.some(r => r.requestId > returnBoundary && r.path === path && r.method === "GET" && r.status === 200 && r.finished)), `${test.name} completed fresh entity/auth reads`);
    const returned = await observe(test.values ?? valuesQuery(test.fields));
    if (test.beforeRestore) await test.beforeRestore(returned, saved);
    else assert.deepEqual(returned, test.fields.map((input, index) => input.savedDisplay ?? saved[index]), `${test.name} saved display before Restore`);
    assert.equal(await observe(test.disabled ?? disabledQuery(test.fields)), true, `${test.name} disabled before Restore`);
    assert.equal(writes.length, beforeWrites, `${test.name} traversal must not write`);
    await restoreAll(test);
    await until(() => observe(test.ready ?? enabledQuery(test.fields)), `${test.name} editable after Restore`);
    const expected = test.expected ?? test.fields.map(input => input.raw);
    await until(async () => JSON.stringify(await observe(test.values ?? valuesQuery(test.fields))) === JSON.stringify(expected), `${test.name} exact raw Restore`);
    assert.deepEqual(await observe(test.values ?? valuesQuery(test.fields)), expected);
    if (test.afterRestore) await test.afterRestore();
    assert.equal(writes.length, beforeWrites, `${test.name} Restore must not write`);
    assert.deepEqual(dialogs, [], "CDP client traversal must not produce discard dialogs");
    assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []);
    await shot(`draft-recovery-${test.name}`);
    await clearRetained(test.offers);
    if (test.afterDiscard) await test.afterDiscard();
    assert.equal(writes.length, beforeWrites, `${test.name} explicit cleanup must not write`);
    completed.push(...test.types);
  }
  // The document template's canvas variant (PR C of #926, ruling C21): a layout is no labelled
  // control, so `recover`'s field table cannot hold it. The template's editor is reached as the
  // ordinary case reaches it, an order is picked in Preview and Design on a canvas seeds the layout
  // (the one write this tolerates is that seed, a POST that reads and saves nothing, beside the live
  // page's renders, POSTs that save nothing either). The same history traversal then leaves the
  // editor and comes back; one offer stands, the saved draft (no layout) shows until Restore, and
  // Restore brings the Design tab back with every seeded item.
  const canvasItemsQuery = "document.querySelectorAll('[role=\"list\"][aria-label=\"Canvas items\"] [role=\"listitem\"]').length";
  const designTabQuery = "Array.from(document.querySelectorAll('[role=\"tab\"]')).some(t=>/^Design(\\s*Unsaved changes)?$/.test(t.textContent.trim()))";
  async function recoverCanvas() {
    const template = f.documentTemplate;
    const path = `/admin/templates/${template.id}/edit`;
    const seedPath = `/api/templates/${template.id}/draft/canvas`;
    const previewPath = `/api/templates/${template.id}/preview`;
    const base = writes.length;
    await page.goto(ctx.baseURL);
    await page.getByRole("navigation").getByRole("link", { name: "Document templates", exact: true }).click();
    await until(() => observe(`location.pathname==="/admin/templates"`), "canvas list");
    const list = page.getByRole("list", { name: "Traveler", exact: true });
    await list.getByRole("button", { name: new RegExp(`^${template.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).click();
    await page.locator(`a[href="${path}"]`).click();
    await page.getByText("Traveler · editing draft v1", { exact: true }).waitFor({ state: "visible" });
    await openRecordTab(page, "Preview");
    const record = page.getByRole("combobox", { name: "Preview record", exact: true });
    const option = record.locator("option").filter({ hasText: new RegExp(`^#${f.order.number} — `) });
    const recordId = await option.getAttribute("value");
    assert.ok(recordId, `the owned order #${f.order.number} is offered in Preview`);
    await record.selectOption(recordId);
    await openRecordTab(page, "Sections");
    await page.getByRole("button", { name: "Design on a canvas", exact: true }).click();
    const confirm = page.getByRole("dialog");
    await confirm.waitFor({ state: "visible" });
    // The last real input event: nothing activating after it until the traversal is done.
    await confirm.getByRole("button", { name: "Design on a canvas", exact: true }).click();
    await until(async () => await observe(designTabQuery) && await observe(canvasItemsQuery) > 0, "canvas seeded onto the Design tab");
    const seeded = await observe(canvasItemsQuery);
    // The live page's first render settles before the editor is left, so no request is cut off.
    await until(() => observe(`!!document.querySelector('iframe[title="Live page"]')`), "canvas live page rendered");
    const seedWrites = writes.slice(base);
    assert.deepEqual(seedWrites.filter(w => !(w.method === "POST" && w.path === previewPath)), [{ path: seedPath, method: "POST" }],
      "the canvas variant's one tolerated write is its seed POST, beside the live page's renders");
    const history = await cdp.send("Page.getNavigationHistory");
    assert.ok(history.currentIndex >= 2);
    assert.equal(new URL(history.entries[history.currentIndex - 2].url).pathname, "/");
    assert.equal(new URL(history.entries[history.currentIndex - 1].url).pathname, "/admin/templates");
    assert.equal(new URL(history.entries[history.currentIndex].url).pathname, path);
    const beforeWrites = writes.length;
    let returnBoundary;
    for (const index of [history.currentIndex - 1, history.currentIndex - 2, history.currentIndex - 1, history.currentIndex]) {
      if (index === history.currentIndex) returnBoundary = sequence;
      const entry = history.entries[index];
      await cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id });
      await until(() => observe(`location.pathname===${JSON.stringify(new URL(entry.url).pathname)}`), "canvas existing history entry");
    }
    const returnedHistory = await cdp.send("Page.getNavigationHistory");
    assert.deepEqual(returnedHistory.entries.map(e => e.id), history.entries.map(e => e.id), "Exact original entry IDs/count");
    assert.equal(returnedHistory.currentIndex, history.currentIndex);
    await until(() => observe(`${offersQuery}===1`), "canvas explicit offer");
    await until(() => [`/api/templates/${template.id}`, readMe].every(read => responses.some(r => r.requestId > returnBoundary && r.path === read && r.method === "GET" && r.status === 200 && r.finished)),
      "canvas completed fresh entity/auth reads");
    // A positive sign first: the saved draft's own tabs are drawn (Sections, which a canvas
    // replaces), so the Design tab's absence is read off a rendered editor, not an empty page.
    await until(() => observe("Array.from(document.querySelectorAll('[role=\"tab\"]')).some(t=>/^Sections(\\s*Unsaved changes)?$/.test(t.textContent.trim()))"),
      "canvas saved draft's Sections tab drawn");
    assert.equal(await observe(designTabQuery), false, "the saved draft, which has no canvas, shows until Restore");
    assert.equal(writes.length, beforeWrites, "canvas traversal must not write");
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await until(() => observe(designTabQuery), "canvas Design tab back after Restore");
    await openRecordTab(page, "Design");
    await until(async () => await observe(canvasItemsQuery) === seeded, "every seeded canvas item back after Restore");
    assert.equal(await page.getByRole("list", { name: "Canvas items", exact: true }).getByRole("listitem").count(), seeded);
    assert.equal(writes.length, beforeWrites, "canvas Restore must not write");
    assert.deepEqual(dialogs, [], "CDP client traversal must not produce discard dialogs");
    assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []);
    await shot("draft-recovery-document-template-canvas");
    await clearRetained(1);
    assert.equal(writes.length, beforeWrites, "canvas explicit cleanup must not write");
  }
  const readMe = "/api/auth/me";
  try {
    await recover({ name: "order-grids", types: ["order-containers", "order-charges", "order-loads", "order-serials"], navigation: "Parts & processes", listPath: "/parts", path: `/orders/${f.order.id}`, offers: 5,
      reads: [`/api/orders/${f.order.id}`, readMe],
      open: async () => {
        const search = page.getByRole("combobox", { name: "Global search", exact: true });
        await search.fill(String(f.order.number)); await search.press("Enter");
      },
      // Containers, Charges and Serials sit on Parts & containers, Loads on Loads & travelers (PR 2).
      // The last box typed is on Parts & containers, so the history return lands there, and the
      // offers are taken tab by tab.
      offerTabs: ["Parts & containers", "Loads & travelers"],
      fields: [field("Container 1 count", " 3 ", { tab: "Parts & containers" }), field("Charge 1 description", "Keep this charge exactly  ", { tab: "Parts & containers" }),
        field("Charge 1 amount", "not-a-price", { tab: "Parts & containers" }), field("Load 1 weight", "not-a-weight", { tab: "Loads & travelers" }),
        field("Lead serial 1 description", "Keep the lead description", { tab: "Parts & containers" }), field("Line 2 add serial", "  R273-BAD{unfinished  ", { tab: "Parts & containers" })],
    });
    await recover({ name: "shipment-grids", types: ["shipment-lines", "shipment-containers", "shipment-serials"], navigation: "Shipping", listPath: "/shipping", path: `/shipping/${f.shipment.id}`, offers: 3,
      reads: [`/api/shippers/${f.shipment.id}`, `/api/orders/${f.shipment.orderId}`, readMe],
      fields: [field("Line 1 ship-now quantity", " 9 "), field("Line 1 ship-now weight", "not-a-weight"),
        field("Serial 1 print on ticket", false, { checkbox: true }), field("Container 1 count", " 3 ")],
    });
    // PR 6: the grid and its offer sit on the invoice page's Lines tab (Header opens first).
    await recover({ name: "invoice-lines", types: ["invoice-lines"], navigation: "Invoicing", listPath: "/invoicing", path: `/invoicing/${f.invoice.id}`, offers: 1,
      reads: [`/api/invoices/${f.invoice.id}`, readMe], offerTabs: ["Lines"],
      // The list opens on Ready to invoice; the draft's link is on the register's views.
      open: async () => { await openInvoicingView(page, "Register"); await page.locator(`a[href="/invoicing/${f.invoice.id}"]`).click(); },
      fields: [field("Line 1 description", "  Keep the invoice description  ", { tab: "Lines" }), field("Line 2 amount", "not-an-amount", { savedDisplay: "$1,000.00", tab: "Lines" })],
    });
    await recover({ name: "payment-application", types: ["payment-application"], navigation: "Receivables", listPath: "/receivables", path: `/receivables/batches/${f.payment.batchId}`, offers: 1,
      reads: [`/api/receivables/batches/${f.payment.batchId}`, readMe],
      enter: async () => { await page.locator("tr").filter({ has: page.getByText(f.payment.reference, { exact: true }) }).getByRole("button", { name: "Apply", exact: true }).click(); },
      returnSelection: async () => {
        const toggle = page.getByRole("button", { name: /^Drafts in this tab/ });
        if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
        const region = page.getByRole("region", { name: "Drafts in this tab", exact: true });
        const row = region.locator("li").filter({ hasText: "Payment application" });
        await until(async () => await row.count() === 1, "one selected payment retained");
        const link = row.getByRole("link", { name: "Return to editor", exact: true });
        assert.equal(await link.getAttribute("href"), `/receivables/batches/${f.payment.batchId}`);
        await link.click(); // Same-path explicit selection, not automatic expansion after history.
        await region.getByRole("button", { name: "Close", exact: true }).click();
      },
      fields: [field(`${f.payment.orderNumber} amount`, " 123.00 "), field(`${f.payment.orderNumber} write-off amount`, "not-an-amount"), field(`${f.payment.orderNumber} write-off reason`, "  Keep this unapplied reason  ")],
    });
    // The quote's halves sit on two tabs since PR 3: the header on Details & wording, the lines
    // (and the unadded break's boxes) on Parts & pricing.
    const quoteFields = [field("RFQ number (prints)", "  R273 quoted header  ", { aria: false, tab: "Details & wording" }),
      field("Unit price", "not-a-unit-price", { aria: false, tab: "Parts & pricing" }),
      ...[["Threshold", " 100 "], ["Price", "not-an-added-price"]].map(([placeholder, raw]) => field(placeholder, raw, {
        query: `document.querySelector(${JSON.stringify(`[placeholder="${placeholder}"]`)})`, locate: p => p.getByPlaceholder(placeholder, { exact: true }),
        tab: "Parts & pricing",
      }))];
    await recover({ name: "quote", types: ["quote"], navigation: "Quotes", listPath: "/quotes", path: `/quotes/${f.quote.id}`, offers: 1,
      reads: [`/api/quotes/${f.quote.id}`, readMe], fields: quoteFields,
      open: async () => { await page.getByRole("region", { name: "Quotes list", exact: true }).locator(`a[href="/quotes/${f.quote.id}"]`).click(); },
      afterRestore: async () => {
        await openOrderTab(page, "Parts & pricing");
        assert.equal(await section(page, "Lines").locator("table tbody tr").count(), 0, "Unadded break stays outside the saved price tree");
      },
    });
    // New shipment's halves sit on three tabs since PR 4: the route fields on Customer & route, the
    // freight block on Freight & review, the grids on Orders & containers.
    const ROUTE = "Customer & route", FREIGHT = "Freight & review", ORDERS = "Orders & containers";
    const newFields = [field("Ship date", "2026-09-15", { aria: false, tab: ROUTE }), field("Route", "  R273 shipment route  ", { aria: false, tab: ROUTE }),
      field("Comments", "  Keep new shipment comments  ", { aria: false, tab: ROUTE, locate: p => p.locator("label").filter({ hasText: /^Comments(?:\s|$)/ }).locator("textarea") }),
      field("Bill freight", true, { aria: false, checkbox: true, tab: FREIGHT }), field("Freight amount", "not-a-freight-amount", { aria: false, tab: FREIGHT }),
      field("Terms", "COLLECT", { aria: false, select: true, tab: FREIGHT, locate: p => p.locator("label").filter({ hasText: "Terms" }).locator("select") }),
      ...[["Freight class", "  Class 273  "], ["Freight description", "  Mixed containers  "], ["Package count", "not-a-package-count"], ["Pro number", "  PRO273  "], ["SCAC", "  SCAC273  "]].map(([label, raw]) => field(label, raw, { aria: false, tab: FREIGHT })),
      field("Line 1 ship-now quantity", " 9 ", { tab: ORDERS }), field("Line 1 ship-now weight", "not-a-weight", { tab: ORDERS }), field("Line 1 close short", true, { checkbox: true, tab: ORDERS }),
      field("Serial 1 print on ticket", false, { checkbox: true, tab: ORDERS }), field("Container 1 count", " 3 ", { tab: ORDERS })];
    await recover({ name: "new-shipment", types: ["new-shipment"], navigation: "Shipping", listPath: "/shipping", path: "/shipping/new", offers: 1,
      reads: [`/api/orders/${f.newShipment.orderId}`, `/api/customers/${f.newShipment.customerId}`, readMe], fields: newFields,
      open: async () => { await page.getByRole("button", { name: "New Shipment", exact: true }).click(); },
      enter: async () => {
        // The Shipping list also labels its customer filter "Customer"; wait for the new page.
        await page.getByRole("heading", { name: "New shipment", exact: true }).waitFor({ state: "visible" });
        await page.locator('select[aria-label="Customer"]').selectOption(f.newShipment.customerId);
        await openOrderTab(page, ORDERS);
        await page.getByLabel("Add order", { exact: true }).selectOption(f.newShipment.orderId);
        await page.getByRole("button", { name: "Add order", exact: true }).click();
        await page.getByRole("link", { name: `#${f.newShipment.orderNumber}`, exact: true }).waitFor({ state: "visible" });
        // Adding the order prefills the whole remainder (10 of 10), and a row that finishes its line
        // shows "Completes line" instead of the close-short box this flow drives. Ship short first.
        await page.getByLabel("Line 1 ship-now quantity", { exact: true }).fill("9");
      },
      // Unlike saved-record grids, the approved new-entry view presents retained values read-only
      // before Restore. Task 6's raw GREEN records these exact values in its returned observation.
      beforeRestore: async returned => { assert.deepEqual(returned, newFields.map(input => input.raw)); },
      disabled: disabledQuery(newFields),
      afterRestore: async () => {
        assert.equal(await page.getByLabel("Customer", { exact: true }).inputValue(), f.newShipment.customerId);
        await openOrderTab(page, ORDERS);
        await page.getByRole("link", { name: `#${f.newShipment.orderNumber}`, exact: true }).waitFor({ state: "visible" });
      },
      // #456: this form takes a new seed after a discard, and the panel's Discard is outside the
      // page. The blank form must come back by itself; nothing here clicks the re-check link.
      afterDiscard: async () => {
        await until(() => observe(`Array.from(document.querySelectorAll('h1')).some(h=>h.textContent.trim()==='New shipment')&&document.querySelector('select[aria-label="Customer"]')?.value===''&&(${labelQuery("Route")})?.value===''`),
          "new-shipment blank form back after the panel's Discard, with no click");
        assert.deepEqual(pageErrors, [], "new-shipment reload after the panel's Discard: page errors");
        assert.deepEqual(consoleErrors, [], "new-shipment reload after the panel's Discard: console errors");
      },
    });
    const blocks = f.cert.requirementNames;
    const certScope = name => page.locator("div.border-line.p-3").filter({ hasText: name });
    const certRows = `(${JSON.stringify(blocks)}).map(name=>{const block=Array.from(document.querySelectorAll('div.border-line.p-3')).find(n=>n.textContent.includes(name));return Array.from(block?.querySelectorAll('tbody tr')??[]).filter(r=>r.querySelector('input')).map(r=>{const text=r.querySelectorAll('input:not([type="checkbox"])');return [text[0]?.value,r.querySelector('input[type="checkbox"]')?.checked,r.querySelector('select')?.value??null,text[1]?.value];});})`;
    const readings = [[["not-a-reading", true, "fail", "  raw failed note  "], [" 45.0000 ", true, "", "  Pending choice stays pending  "]], [[" 0.0300 ", false, null, "  Keep sibling final note  "]]];
    await recover({ name: "cert-readings", types: ["cert-readings"], navigation: "Certifications", listPath: "/certs", path: `/certs/${f.cert.id}`, offers: 2,
      reads: [`/api/certs/${f.cert.id}`, readMe], values: certRows, initial: [[], []], expected: readings,
      ready: `(${JSON.stringify(blocks)}).every(name=>{const b=Array.from(document.querySelectorAll('div.border-line.p-3')).find(n=>n.textContent.includes(name));return Array.from(b?.querySelectorAll('button')??[]).some(n=>n.textContent.trim()==='Add another reading'&&!n.disabled);})`,
      disabled: `(${JSON.stringify(blocks)}).every(name=>{const b=Array.from(document.querySelectorAll('div.border-line.p-3')).find(n=>n.textContent.includes(name));const buttons=Array.from(b?.querySelectorAll('button')??[]).filter(n=>['Add another reading','Save readings'].includes(n.textContent.trim()));return buttons.length===2&&buttons.every(n=>n.disabled);})`,
      beforeRestore: async returned => { assert.deepEqual(returned, [[], []]); },
      edit: async () => {
        for (const [index, name] of blocks.entries()) for (const [rowIndex, values] of readings[index].entries()) {
          const scope = certScope(name); await scope.getByRole("button", { name: "Add another reading", exact: true }).click();
          const row = scope.locator("tbody tr").nth(rowIndex);
          await row.locator('input:not([type="checkbox"])').first().fill(values[0]);
          if (values[1]) { await row.getByRole("checkbox").check(); await row.getByRole("combobox").selectOption(values[2]); }
          await row.locator('input:not([type="checkbox"])').nth(1).fill(values[3]);
        }
      },
    });
    const custom = f.part.customFields;
    // Touching the checkbox adds the nested clear button to its accessible label.
    const checkboxName = new RegExp(`^${custom[2].name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s*clear)?$`);
    const customFields = custom.map((definition, index) => field(definition.name, ["  raw field text  ", "not-a-number", false][index], {
      aria: false, root: sectionQuery("Custom fields"), checkbox: index === 2, touchedFalse: index === 2, tab: "Fields & files",
      locate: p => index === 2 ? section(p, "Custom fields").getByRole("checkbox", { name: checkboxName })
        : section(p, "Custom fields").getByLabel(definition.name, { exact: true }),
    }));
    const checkboxLabel = `Array.from((${sectionQuery("Custom fields")})?.querySelectorAll('label')??[]).find(l=>l.textContent.trim().startsWith(${JSON.stringify(custom[2].name)}))`;
    await recover({ name: "custom-fields", types: ["part-custom-fields"], navigation: "Parts & processes", listPath: "/parts", path: `/parts/${f.part.id}`, offers: 1, offerTabs: ["Fields & files"],
      reads: [`/api/parts/${f.part.id}/fields`, readMe], fields: customFields,
      values: `[${customFields.map(input => `(${input.query})?.${input.checkbox ? "checked" : "value"}??null`).join(",")},!!(${checkboxLabel})?.querySelector('button')]`,
      initial: ["", "", false, false], expected: ["  raw field text  ", "not-a-number", false, true],
      beforeRestore: async returned => { assert.deepEqual(returned, ["", "", false, false]); },
    });
    // The Process Steps table: a step is the `tr` whose Step column prints its code, and each of its
    // controls is named "Step N <what>" (spec 2026-09-26 §4), exactly.
    function stepField(title, codes, step, what, raw, checkbox = false) {
      const name = `Step ${step + 1} ${what}`;
      const root = `Array.from((${sectionQuery(title)})?.querySelectorAll('tr[data-step-id]')??[]).find(r=>Array.from(r.querySelectorAll('td div')).some(d=>d.textContent===${JSON.stringify(codes[step])}))`;
      return field(name, raw, { checkbox, tab: "Process recipe", query: `(${root})?.querySelector(${JSON.stringify(`[aria-label="${name}"]`)})`,
        locate: p => section(p, title).locator("tr[data-step-id]").filter({ has: p.getByText(codes[step], { exact: true }) }).getByLabel(name, { exact: true }) });
    }
    await recover({ name: "process-steps", types: ["part-process-steps"], navigation: "Parts & processes", listPath: "/parts", path: `/parts/${f.part.id}`, offers: 1, offerTabs: ["Process recipe"],
      // PR 9: the notice is not on the first tab, so the draft's link rides the tab that holds it.
      returnSelection: async () => {
        const back = await cdp.send("Page.getNavigationHistory");
        await cdp.send("Page.navigateToHistoryEntry", { entryId: back.entries[back.currentIndex - 1].id });
        await until(() => observe(`location.pathname==="/parts"`), "process-steps back on the list");
        const toggle = page.getByRole("button", { name: /^Drafts in this tab/ });
        if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
        const region = page.getByRole("region", { name: "Drafts in this tab", exact: true });
        const row = region.locator("li").filter({ hasText: "Process steps" });
        await until(async () => await row.count() === 1, "one process draft retained");
        const link = row.getByRole("link", { name: "Return to editor", exact: true });
        assert.equal(await link.getAttribute("href"), `/parts/${f.part.id}?tab=process`);
        await link.click();
        await page.getByRole("tab", { name: /^Process recipe/ }).and(page.locator('[aria-selected="true"]')).waitFor({ state: "visible" });
        await region.getByRole("button", { name: "Close", exact: true }).click();
      },
      // #657: the current revision and the catalog come from the document answer; neither is read
      // on its own any more.
      reads: [`/api/parts/${f.part.id}/process/revisions`, `/api/parts/${f.part.id}/process/document`, readMe],
      initial: ["Heat to target temperature and hold.", "", false, "Rinse and inspect the load."],
      fields: [stepField("Process steps", f.part.stepCodes, 0, "instructions", "  Raw first instruction\nsecond line  "),
        stepField("Process steps", f.part.stepCodes, 0, "Temperature", "not-a-temperature"), stepField("Process steps", f.part.stepCodes, 0, "Passed", true, true),
        stepField("Process steps", f.part.stepCodes, 1, "instructions", "  Last sibling instruction  ")],
    });
    const documentFields = [field("Show field Part quantity", false, { checkbox: true, tab: "Sections" }), field("Group thousands", false, { checkbox: true, tab: "Appearance" }), field("Label for Order number", "  Unsaved order label  ", { tab: "Sections" })];
    await recover({ name: "document-template", types: ["document-template"], navigation: "Document templates", listPath: "/admin/templates", path: `/admin/templates/${f.documentTemplate.id}/edit`, offers: 1,
      reads: [`/api/templates/${f.documentTemplate.id}`, readMe], fields: documentFields,
      prepare: async saved => {
        assert.equal(saved[0], true, "Owned default traveler begins with Part quantity shown");
        documentFields[1].raw = !saved[1];
      },
      open: async () => {
        const list = page.getByRole("list", { name: "Traveler", exact: true });
        await list.getByRole("button", { name: new RegExp(`^${f.documentTemplate.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).click();
        await page.locator(`a[href="/admin/templates/${f.documentTemplate.id}/edit"]`).click();
        await page.getByText("Traveler · editing draft v1", { exact: true }).waitFor({ state: "visible" });
      },
    });
    assert.equal(new Set(completed).size, 15, "All fifteen approved ordinary editor types must execute; none may be skipped");
    assert.equal(completed.length, 15);
    assert.deepEqual(writes, [], "Ordinary raw recovery flow has no server mutation at all");
    assert.deepEqual(dialogs, []); assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []);
    await recoverCanvas();
  } finally {
    await Promise.allSettled(dialogTasks);
    page.off("request", onRequest); page.off("response", onResponse); page.off("dialog", onDialog);
    page.off("pageerror", onPageError); page.off("console", onConsole);
    await cdp.detach();
  }
}
