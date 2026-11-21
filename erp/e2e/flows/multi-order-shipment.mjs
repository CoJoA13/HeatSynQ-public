// Flow 12 (Phase 4, Task 20): one shipment covering two orders (design spec §13.2) — the
// emergent multi-order shipment (owner ruling §3.10: several orders on one truck is one shipment
// with one ship-to; there is no MOS layout, §3.20 — the tickets stay one sheet per order and the
// BOL is the one multi-order document). Prints the tickets (asserting the archived PDF really
// carries TWO sheets via the uncompressed /Count page marker) and the BOL, and confirms BOTH
// order hubs list the same stored documents.
//
// This flow is also the durable browser recapture of the Task 14 shipment page (its original
// browser verification was lost in the machine move; both fix rounds were code-verified only):
// a two-order shipment rendered as one panel per order, and a LINE EDIT through the edit page's
// grid (PUT …/lines) round-tripping through the server.
//
// The tail end pins the Task 19 fix-round contract (§9 amendment 2026-08-05) in a real browser:
// after this order's only cert is VOIDED, printing tickets with the cert checkbox still ticked
// prints the tickets and WARNS — x-print-warnings decoded and rendered amber — never refuses.
//
// Before the real whole-set print, one Print shipping ticket is answered in the browser as the server
// answers a ticket print that ran past its time (#556), and the print bar must show that sentence.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { openRecordTab } from "../lib/record-tabs.mjs";
import { waitForEnabled, waitForTitle, waitForValue } from "../lib/ui.mjs";
import { answerModal, modalTitle } from "../lib/modal.mjs";
import { watchRequests } from "../lib/refusal-lines.mjs";
import { createOrderViaUi, startNewShipment, orderPanel, waitForShipmentPage, openOrderTab, shipmentDocument } from "../lib/orders.mjs";
import { routeRequests } from "../route-keep-alive.mjs";

const CERT_VOID_REASON = "E2E multi-order flow: voiding the cert to demonstrate the print-time missing-cert warning.";

/** Identify an archive row by the exact document returned by the print response, not by its
 *  repeated "Shipping ticket" caption or its position among earlier prints. */
async function assertTicketScope(page, href, label) {
  await openRecordTab(page, "Documents");
  const documents = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Documents", exact: true }),
  });
  const row = documents.locator("tbody tr").filter({ has: page.locator(`a[href="${href}"]`) });
  await row.getByRole("cell", { name: `Order ${label}`, exact: true })
    .waitFor({ state: "visible", timeout: 15000 });
  // Type / Scope / Created / Open PDF (PR 4): the kind is the row's first cell, the link "Open PDF".
  await row.getByRole("cell", { name: "Shipping ticket", exact: true }).waitFor({ state: "visible" });
  assert.equal(await row.getByRole("link", { name: "Open PDF", exact: true }).getAttribute("href"), href);
}

export async function run(page, shot, ctx) {
  const { fixtures } = ctx;

  // --- Two orders for the same customer: C carries the cert-required part (its ORDER-scope cert
  // is created by the order save itself, spec §6.2), D a plain part. ---
  const orderC = await createOrderViaUi(page, ctx, {
    customerCode: fixtures.shipCustomerCode,
    lines: [{ partNumber: fixtures.certPartNumber, qty: 12 }],
  });
  const orderD = await createOrderViaUi(page, ctx, {
    customerCode: fixtures.shipCustomerCode,
    lines: [{ partNumber: fixtures.shipPartANumber, qty: 10 }],
  });

  // --- One shipment, both orders (each at its full prefilled remainder). ---
  await startNewShipment(page, ctx, fixtures.shipCustomerId, [orderC, orderD]);
  await shot("two-order-panels");
  await page.getByRole("button", { name: "Save shipment", exact: true }).click();
  const shipment = await waitForShipmentPage(page);
  // One panel per order, each labeled with its own never-reused sequence (spec §4.2).
  await page.getByRole("link", { name: `${orderC.number}-1`, exact: true }).waitFor({ state: "visible" });
  await page.getByRole("link", { name: `${orderD.number}-1`, exact: true }).waitFor({ state: "visible" });
  await shot("shipment-saved");

  // #472 (R-Q2): nothing has printed, and each order leaves the other a positive line, so both
  // Remove order buttons are open.
  const removeC = orderPanel(page, `${orderC.number}-1`).getByRole("button", { name: "Remove order", exact: true });
  const removeD = orderPanel(page, `${orderD.number}-1`).getByRole("button", { name: "Remove order", exact: true });
  for (const [button, name] of [[removeC, "the first order"], [removeD, "the second order"]]) {
    await waitForEnabled(button, `Remove order on ${name} before any print`);
    assert.equal(await button.getAttribute("title"), null, `Remove order on ${name} carries no reason before any print`);
  }

  // --- Line edit through the EDIT page's grid (the Task 14 recapture): ship 8 of D's 10. ---
  const panelD = orderPanel(page, `${orderD.number}-1`);
  await panelD.getByLabel("Line 1 ship-now quantity", { exact: true }).fill("8");
  await panelD.getByLabel("Line 1 ship-now weight", { exact: true }).fill("80");
  const linesSaved = page.waitForResponse((res) =>
    res.url().includes("/lines") && res.request().method() === "PUT" && res.ok());
  await panelD.getByRole("button", { name: "Save lines", exact: true }).click();
  await linesSaved;
  // The grid re-composes from the server's own fresh response — the round-tripped value.
  await waitForValue(panelD.getByLabel("Line 1 ship-now quantity", { exact: true }), "8");
  await shot("line-edited");

  // --- #556: a ticket print whose claims expire is refused, a 400 carrying the owner's sentence.
  // A render past the 15 s budget cannot be produced here, so this one Print shipping ticket is answered
  // in the browser as the server answers it and never reaches the server. It proves the page's half
  // only: the print bar, the print buttons' own row, shows the server's sentence as written. The
  // sentence is a copy of the whole-set one in printShippingTickets (src/server/shippers.ts), and
  // nothing here would notice the two drifting apart, so a change to that sentence is made here by
  // hand. No absence check: the page's "archived and is in Documents below" line is set only on an
  // OK answer. Nothing was stored, so the print below is still the shipment's first. ---
  const EXPIRED = "These shipping tickets took too long to print, so nothing was stored and no certifications were printed. Print each order's ticket from its own panel.";
  const printAll = page.getByRole("button", { name: "Print shipping ticket", exact: true });
  const wholeSetPrint = (url) => url.pathname === `/api/shippers/${shipment.id}/print`
    && url.searchParams.get("doc") === "ticket" && !url.searchParams.has("order");
  const stopRefusing = await routeRequests(page, wholeSetPrint, async (route) => {
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: EXPIRED }) });
  });
  try {
    await printAll.click();
    // The print's message is the At a glance card's (PR 4); the button, in the header, reads
    // Print shipping ticket again once the request has failed, which its name-based wait proves.
    await page.getByRole("region", { name: "At a glance", exact: true }).getByText(EXPIRED, { exact: true }).waitFor();
    await printAll.waitFor({ state: "visible" });
  } finally {
    await stopRefusing();
  }

  // --- Print shipping ticket (cert checkbox is pre-ticked, §3.14). The whole-set ticket archives as
  // ONE document scoped "Whole shipment"; order C's cert archives as its own CERT document
  // (surfaced via the info line — cert documents live on the cert page and the order hubs, not
  // in the shipment's own list). ---
  const popup1 = page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null);
  await page.getByRole("button", { name: "Print shipping ticket", exact: true }).click();
  const ticketLink = (await shipmentDocument(page, "Shipping ticket")).first().getByRole("link", { name: "Open PDF", exact: true });
  await ticketLink.waitFor({ state: "visible", timeout: 30000 });
  // Read while its tab is open: a role locator finds nothing inside a hidden panel.
  const ticketHref = await ticketLink.getAttribute("href");
  await page.getByText(/1 certification archived/).waitFor({ state: "visible" });
  await page.getByText("Whole shipment", { exact: true }).waitFor({ state: "visible" });
  await openRecordTab(page, "Orders & quantities"); // the panels' Remove order titles are read next
  // The whole-set ticket covers both orders. The page reads the shipment once more after its own
  // print, so both buttons grey with the server's sentence and NO reload. Polled: that read is
  // detached and lands after the print does.
  const paperPrinted = `Shipment paper covering this order has already printed (Packing List ${shipment.shipperNumber}) — `
    + "void the shipment instead of removing it.";
  for (const [button, name] of [[removeC, "the first order"], [removeD, "the second order"]]) {
    await waitForTitle(button, paperPrinted, `Remove order on ${name} after the whole-set print`);
    assert.equal(await button.isDisabled(), true, `Remove order on ${name} is greyed once its paper has printed`);
  }
  const shotPath = await shot("tickets-printed");
  const flowDir = path.dirname(shotPath);
  await (await popup1)?.close().catch(() => {});

  // Two orders on the truck = two ticket sheets in the one archived PDF (§3.20: one ticket per
  // order, never a merged MOS sheet). The page-tree "/Count 2" marker is written uncompressed by
  // this PDF stack (the P3 test technique), so it is grep-able straight off the stored bytes.
  const ticketPdf = await (await page.request.get(new URL(ticketHref, ctx.baseURL).toString(), { maxRetries: 1 })).body();
  assert.ok(ticketPdf.subarray(0, 5).toString() === "%PDF-", "the stored ticket document must be a PDF");
  assert.match(ticketPdf.toString("latin1"), /\/Count 2/,
    "the whole-set ticket PDF must carry exactly two sheets (one per order)");
  await fs.writeFile(path.join(flowDir, "tickets.pdf"), ticketPdf);

  // #231: each order's own print must name that order in the archive. Skip the optional cert
  // here: the whole-set print above already archived C's cert and the later warning tests it.
  const scopedTicketHrefs = new Map();
  for (const order of [orderC, orderD]) {
    await openRecordTab(page, "Orders & quantities"); // the previous pass left Documents open
    const panel = orderPanel(page, `${order.number}-1`);
    await panel.getByLabel("Also print certification", { exact: true }).uncheck();
    const popup = page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null);
    const [response] = await Promise.all([
      page.waitForResponse((res) => {
        const url = new URL(res.url());
        return url.pathname === `/api/shippers/${shipment.id}/print`
          && url.searchParams.get("order") === order.id && res.request().method() === "POST";
      }, { timeout: 30000 }),
      panel.getByRole("button", { name: "Print this order's ticket", exact: true }).click(),
    ]);
    assert.ok(response.ok(), `Order ${order.number}'s ticket must print successfully`);
    const documentId = response.headers()["x-document-id"];
    assert.ok(documentId, "a per-order print must return its archived document ID");
    const href = `/api/documents/${documentId}`;
    scopedTicketHrefs.set(order.id, href);
    await assertTicketScope(page, href, `${order.number}-1`);
    await (await popup)?.close().catch(() => {});
    const saved = await page.request.get(new URL(href, ctx.baseURL).toString(), { maxRetries: 1 });
    assert.ok(saved.ok(), "the named per-order ticket must remain downloadable");
    assert.match((await saved.body()).toString("latin1"), /\/Count 1/,
      "each per-order ticket contains only that order's sheet");
  }
  await page.reload();
  await waitForShipmentPage(page);
  for (const order of [orderC, orderD]) {
    await assertTicketScope(page, scopedTicketHrefs.get(order.id), `${order.number}-1`);
  }
  await shot("per-order-document-scopes");

  // --- Print the BOL: lazily allocates the BOL number (§3.19), archives as its own document. ---
  const popup2 = page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null);
  await page.getByRole("button", { name: "Print BOL", exact: true }).click();
  const bolLink = (await shipmentDocument(page, "Bill of lading")).first().getByRole("link", { name: "Open PDF", exact: true });
  await bolLink.waitFor({ state: "visible", timeout: 30000 });
  await (await popup2)?.close().catch(() => {});
  const bolPdf = await (await page.request.get(new URL(await bolLink.getAttribute("href"), ctx.baseURL).toString(), { maxRetries: 1 })).body();
  await fs.writeFile(path.join(flowDir, "bol.pdf"), bolPdf);
  // The heading's "· BOL N" badge reads the shipper state loaded at page load — reload to see
  // the just-allocated number.
  await page.reload();
  await waitForShipmentPage(page);
  await page.getByText(/· BOL \d+/).waitFor({ state: "visible" });
  await shot("bol-printed");

  // --- Both order hubs list the SAME stored documents (the §8 union: a shipment's documents
  // surface on every order it covers). The hub's generic list names every kind by its friendly
  // label now (P5A spec §10 completed DocumentsSection's KIND_LABELS — the cosmetic gap HANDOFF
  // §6 recorded, which this flow used to encode by matching the raw enum names). ---
  await page.goto(`${ctx.baseURL}/orders/${orderC.id}`);
  await page.getByRole("heading", { name: /^Order #\d+/ }).waitFor({ state: "visible" });
  await openOrderTab(page, "Loads & travelers"); // PR 2: the hub's Documents list sits there
  const bolOnC = page.getByRole("link", { name: "Bill of lading", exact: true });
  await bolOnC.waitFor({ state: "visible", timeout: 15000 });
  await page.locator(`a[href="${ticketHref}"]`).waitFor({ state: "visible" });
  await page.locator(`a[href="${scopedTicketHrefs.get(orderC.id)}"]`).waitFor({ state: "visible" });
  await page.getByRole("link", { name: "Certification", exact: true }).waitFor({ state: "visible" });
  const bolHrefOnC = await bolOnC.getAttribute("href");
  await shot("hub-c-documents");

  await page.goto(`${ctx.baseURL}/orders/${orderD.id}`);
  await page.getByRole("heading", { name: /^Order #\d+/ }).waitFor({ state: "visible" });
  await openOrderTab(page, "Loads & travelers");
  const bolOnD = page.getByRole("link", { name: "Bill of lading", exact: true });
  await bolOnD.waitFor({ state: "visible", timeout: 15000 });
  await page.locator(`a[href="${ticketHref}"]`).waitFor({ state: "visible" });
  await page.locator(`a[href="${scopedTicketHrefs.get(orderD.id)}"]`).waitFor({ state: "visible" });
  assert.equal(await bolOnD.getAttribute("href"), bolHrefOnC,
    "both hubs must list the SAME stored BOL document, not two copies");
  // D's Shipments section names its own slice of the shared shipment (on Shipping & certs).
  await openOrderTab(page, "Shipping & certs");
  await page.getByRole("link", { name: `${orderD.number}-1`, exact: true }).waitFor({ state: "visible" });
  await page.getByText("(+1 other order)", { exact: true }).waitFor({ state: "visible" });
  await shot("hub-d-documents");

  // --- The Task 19 pin: void order C's cert, then print tickets WITH the cert box ticked. The
  // tickets print and the §9-amended warning arrives via x-print-warnings, rendered amber. ---
  await page.goto(`${ctx.baseURL}/orders/${orderC.id}`);
  await page.getByRole("heading", { name: /^Order #\d+/ }).waitFor({ state: "visible" });
  // The Certifications section row (on Shipping & certs since PR 2) links to the cert by its scope label.
  await openOrderTab(page, "Shipping & certs");
  await page.getByRole("link", { name: "By order", exact: true }).click();
  await page.getByRole("heading", { name: /^Certification #\d+/ }).waitFor({ state: "visible", timeout: 15000 });
  // Through the modal (PR 5): a Cancel pass first proves no DELETE goes, then the reason voids.
  const certDeletes = watchRequests(page, "DELETE", "/api/certs/");
  await page.getByRole("button", { name: "Void certification", exact: true }).click();
  assert.match(await modalTitle(page), /^Void certification #\d+\?/);
  await answerModal(page, { confirm: false });
  assert.equal(certDeletes.count(), 0, "Cancel on the void question must send nothing");
  await page.getByRole("button", { name: "Void certification", exact: true }).click();
  await answerModal(page, { reason: CERT_VOID_REASON });
  await page.getByText(`Voided — ${CERT_VOID_REASON}`).waitFor({ state: "visible", timeout: 10000 });
  assert.equal(certDeletes.count(), 1, "the reason sends one DELETE");
  certDeletes.stop();
  await shot("cert-voided");

  await page.goto(`${ctx.baseURL}/shipping/${shipment.id}`);
  await waitForShipmentPage(page);
  const popup3 = page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null);
  await page.getByRole("button", { name: "Print shipping ticket", exact: true }).click();
  await page.getByText(/requires a certification and none exists to print/).waitFor({ state: "visible", timeout: 30000 });
  await page.getByText(/its ticket printed without one/).waitFor({ state: "visible" });
  await (await popup3)?.close().catch(() => {});
  await shot("print-warns-missing-cert");
}
