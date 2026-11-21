import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { drawnText, pageCount, textLinesWithY, textRunsWithY } from "./helpers/pdf";
import { RULE, leftColumn } from "./helpers/traveler-header";
import { runWithContext } from "@/server/context";
import { createOrder, getOrder } from "@/server/orders";
import { bolSettings, createShipper, readBolData } from "@/server/shippers";
import { addPartPrice } from "@/server/part-prices";
import { createCredit, createInvoice, finalizeInvoice, invoicePrintSettings, readInvoicePdfData } from "@/server/invoices";
import { certPrintSettings, createCert, readCertPdfData, updateCert } from "@/server/certs";
import { replaceReadings } from "@/server/cert-results";
import { buildStatement } from "@/server/statements";
import { createTemplate } from "@/server/templates";
import { createQuote, quotePrintSettings, readQuotePdfData } from "@/server/quotes";
import {
  TRAVELER_DEFAULT_CONFIG, SHIPPER_DEFAULT_CONFIG, MOS_SHIPPER_DEFAULT_CONFIG, CERT_DEFAULT_CONFIG, STATEMENT_DEFAULT_CONFIG, INVOICE_DEFAULT_CONFIG,
  BOL_DEFAULT_CONFIG, QUOTE_DEFAULT_CONFIG, validateConfig, type TemplateConfig, type TemplateDocTypeString,
} from "@/lib/template-contracts/index";
import { POST as previewRoute } from "@/app/api/templates/[id]/preview/route";
import { bandTop, canvasWarnings, regionHeights, validateCanvasLayout, type CanvasMeasure } from "@/lib/template-canvas";
import { standardLayout } from "./helpers/canvas-fixtures";
import { standardTicketLayout } from "./helpers/ticket-canvas-fixtures";
import { standardBolLayout } from "./helpers/bol-canvas-fixtures";
import { standardCertLayout } from "./helpers/cert-canvas-fixtures";
import { sampleInvoice, standardInvoiceLayout } from "./helpers/invoice-canvas-fixtures";
import { standardStatementLayout } from "./helpers/statement-canvas-fixtures";
import { standardQuoteLayout } from "./helpers/quote-canvas-fixtures";
import { buildCertDefinition } from "@/server/pdf/cert";
import { formatDateOnly, todayDateOnly } from "@/lib/business-days";
import { buildBolDefinition } from "@/server/pdf/bol";
import {
  buildTravelerDefinitions, readTravelerData, travelerCanvasItemContent, travelerSettings,
} from "@/server/traveler";
import { renderPdf, renderSheetGroupsWithPositions } from "@/server/pdf/render";
import { CANVAS_IDS, aloneLayouts } from "@/server/pdf/canvas-sheet";
import { CANVAS_GRID, type CanvasItem, type CanvasLayout } from "@/lib/template-contracts/canvas";
import { readPreviewContext, renderInvoiceCanvasPreview, renderPreview, renderQuoteCanvasPreview, renderStatementCanvasPreview } from "@/server/template-preview";
import { buildInvoiceDefinition, type InvoicePdfData } from "@/server/pdf/invoice";
import { INVOICE_CONTRACT } from "@/lib/template-contracts/invoice";

/**
 * Phase 7 Task 19 — the PREVIEW: `POST /api/templates/[id]/preview` renders the SUBMITTED
 * (working, possibly-unsaved) config against a real record the user picks, streaming PDF bytes
 * with ZERO side effects (spec §5.5). Gated on `templates.view` PLUS the record's own print-route
 * permission; the statement preview forces finance-charge assessment OFF and takes asOf/combineFamily.
 */

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

function previewReq(id: string, cookie: string | undefined, body: unknown): Request {
  return new Request(`http://t/api/templates/${id}/preview`, {
    method: "POST",
    headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function pdfOf(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

const cfgOf = (docType: TemplateDocTypeString): TemplateConfig => {
  const defaults: Record<string, TemplateConfig> = {
    TRAVELER: TRAVELER_DEFAULT_CONFIG, SHIPPER: SHIPPER_DEFAULT_CONFIG, MOS_SHIPPER: MOS_SHIPPER_DEFAULT_CONFIG,
    CERT: CERT_DEFAULT_CONFIG, STATEMENT: STATEMENT_DEFAULT_CONFIG,
    INVOICE: INVOICE_DEFAULT_CONFIG, QUOTE: QUOTE_DEFAULT_CONFIG,
  };
  return structuredClone(defaults[docType]);
};
const sectionOf = (c: TemplateConfig, key: string) => c.sections.find((s) => s.key === key)!;
const fieldOf = (c: TemplateConfig, section: string, key: string) =>
  sectionOf(c, section).fields.find((f) => f.key === key)!;

// ------------------------------------------------------------------------------------------------
// Fixtures — a real order (traveler), cert, and customer-with-A/R (statement), the shapes the
// print-path suites (traveler-/cert-/statement-templates) already use.
// ------------------------------------------------------------------------------------------------

let seq = 0;
async function miniOrder() {
  seq += 1;
  const customer = await prisma.customer.create({ data: { code: `PRV${seq}`, name: `Preview Co ${seq}` } });
  const code = await prisma.processStepCode.create({ data: { code: `AUS${seq}`, name: "Austemper" } });
  const part = await prisma.part.create({
    data: { customerId: customer.id, partNumber: `PRV-${seq}`, name: "Preview Part", eachWeight: "1.0000", loadQty: 100 },
  });
  const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Pre-heat, then quench." },
  });
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, lines: [{ partId: part.id, qty: 10, weight: "10.00" }],
  }));
  return { customer, order };
}

async function certFixture() {
  seq += 1;
  const customer = await prisma.customer.create({ data: { code: `CPV${seq}`, name: `Cert Preview Co ${seq}` } });
  await prisma.customerAddress.create({
    data: {
      customerId: customer.id, kind: "BILL_TO", name: "AP", street: "1 St",
      city: "Anniston", state: "AL", zip: "36201", isDefault: true,
    },
  });
  const material = await prisma.material.create({ data: { name: `steel ${seq}` } });
  const scale = await prisma.inspectionScale.create({ data: { name: `HRC${seq}` } });
  const inspCode = await prisma.inspectionCode.create({
    data: { name: `As per P.O. (${seq})`, defaultScaleId: scale.id },
  });
  const part = await prisma.part.create({
    data: { customerId: customer.id, partNumber: `CPV-${seq}`, name: "Track Shoe", eachWeight: "21.5000", materialId: material.id },
  });
  await prisma.partInspection.create({
    data: { partId: part.id, inspectionCodeId: inspCode.id, scaleId: scale.id, min: "28.0000", max: "32.0000", sampleQty: "9", location: "OD", sort: 1 },
  });
  const stepCode = await prisma.processStepCode.create({ data: { code: `CPC-${seq}`, name: "Austenitize" } });
  const partRev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({ data: { revisionId: partRev.id, position: 1, codeId: stepCode.id, instruction: "Austenitize at 1650F." } });
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, poNumber: "PT1", lines: [{ partId: part.id, qty: 192, weight: "4128.00" }],
  }));
  let cert = await asSystem(() => createCert({ orderId: order.id, scope: "ORDER" }));
  cert = await asSystem(() => replaceReadings(cert.id, {
    requirements: [{ id: cert.requirements[0].id, readings: [{ value: 30 }, { value: 31 }] }],
  }, { afterPrint: false }));
  return { customer, cert };
}

/** A customer with a past-due, non-exempt, finalized invoice AND a finance-charge rate — enough
 *  that assessing finance charges WOULD produce a nonzero line, so a preview that suppresses it is
 *  a real proof, not a vacuous one. */
async function statementCustomer(): Promise<{ id: string; total: number }> {
  seq += 1;
  const customer = await prisma.customer.create({
    data: { code: `SPV${seq}`, name: `Statement Preview Co ${seq}`, financeChargeRate: "1.5000" },
  });
  await prisma.customerAddress.create({
    data: { customerId: customer.id, kind: "BILL_TO", name: "AP", street: "500 Example St", city: "Columbus", state: "GA", zip: "31902", isDefault: true },
  });
  const order = await prisma.order.create({
    data: { orderNumber: 80000 + seq, customerId: customer.id, status: "SHIPPED", receivedDate: new Date("2026-05-01"), requestDate: new Date("2026-05-05") },
  });
  await prisma.invoice.create({
    data: {
      orderId: order.id, customerId: customer.id, kind: "INVOICE", status: "FINALIZED",
      invoiceDate: new Date("2026-05-10"), dueDate: new Date("2026-05-20"), finalizedAt: new Date("2026-05-10"), total: 400,
    },
  });
  return { id: customer.id, total: 400 };
}

/** A draft invoice for a shipped, priced order with a PO, a material and a process name: the shape
 *  tests/invoice-pdf.test.ts raises, copied in short (copying across test files is this repo's
 *  convention). */
async function invoiceFixture() {
  seq += 1;
  const customer = await prisma.customer.create({ data: { code: `IPV${seq}`, name: `Invoice Preview Co ${seq}` } });
  await prisma.customerAddress.create({
    data: { customerId: customer.id, kind: "BILL_TO", name: "AP", street: "500 Example St", city: "Columbus", state: "GA", zip: "31902", isDefault: true },
  });
  const material = await prisma.material.create({ data: { name: `Ductile Iron ${seq}` } });
  const part = await prisma.part.create({
    data: { customerId: customer.id, partNumber: `IPV-${seq}`, name: "Equalizer", eachWeight: "21.0000", materialId: material.id, processName: "Austemper" },
  });
  const code = await prisma.processStepCode.create({ data: { code: `IPC${seq}`, name: "Austemper" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({ data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austemper at 1650F." } });
  const { order: created } = await asSystem(() => createOrder({
    customerId: customer.id, poNumber: "89499", lines: [{ partId: part.id, qty: 144, weight: "3024.00" }],
  }));
  await createShipper({
    customerId: customer.id, shipDate: "2026-07-29",
    orders: [{
      orderId: created.id,
      lines: [{ orderLineId: created.lines[0].id, qty: created.lines[0].qty, weight: created.lines[0].weight, lineComplete: true }],
      containers: [], serials: [],
    }],
  }, { canOverrideCreditHold: false });
  const gl = await prisma.glAccount.create({ data: { name: `40${seq}`, description: "Sales" } });
  const priced = await prisma.processStepCode.create({ data: { code: `IPP${seq}`, name: "Austemper", glAccountId: gl.id } });
  await asSystem(() => addPartPrice(part.id, {
    processStepCodeId: priced.id, position: 1, unitPrice: "6.5100", minimumCharge: "600.00", pricePer: "EACH",
  }));
  const order = await getOrder(created.id);
  const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
  return { invoice, material: material.name };
}

/** `miniOrder` with its loads replaced by `count` loads numbered 1..count. */
async function orderWithLoads(count: number) {
  const { order } = await miniOrder();
  await prisma.load.deleteMany({ where: { orderId: order.id } });
  if (count > 0) await prisma.load.createMany({ data: Array.from({ length: count }, (_, i) => ({ orderId: order.id, loadNumber: i + 1, qty: 1 })) });
  return order;
}

/** A never-published TRAVELER template — create opens its v1 DRAFT; nothing is ever published. */
async function draftTemplate(docType: TemplateDocTypeString) {
  return asSystem(() => createTemplate(docType, `Draft ${docType} ${(seq += 1)}`));
}

// ------------------------------------------------------------------------------------------------

let full: string;          // templates.view + every record area
let templatesOnly: string; // templates.view, no record areas
let ordersOnly: string;    // orders.view, no templates.view

beforeEach(async () => {
  await truncateAll();
  await seedOrderGatePrereqs();
  full = await signInWith(
    ["templates.view", "orders.view", "shipping.view", "certs.view", "invoicing.view", "receivables.view", "quotes.view"],
    "pfull");
  templatesOnly = await signInWith(["templates.view"], "ptpl");
  ordersOnly = await signInWith(["orders.view"], "pord");
});

describe("POST /api/templates/[id]/preview — permission pairing (templates.view + the record area)", () => {
  it("401 signed out", async () => {
    const tpl = await draftTemplate("TRAVELER");
    const res = await previewRoute(previewReq(tpl.id, undefined, { recordId: "x", config: cfgOf("TRAVELER") }), withParams({ id: tpl.id }));
    expect(res.status).toBe(401);
  });

  it("403 with templates.view but NOT the record area (orders.view for a traveler)", async () => {
    const { order } = await miniOrder();
    const tpl = await draftTemplate("TRAVELER");
    const res = await previewRoute(
      previewReq(tpl.id, templatesOnly, { recordId: order.id, config: cfgOf("TRAVELER") }), withParams({ id: tpl.id }));
    expect(res.status).toBe(403);
  });

  it("403 with the record area but NOT templates.view", async () => {
    const { order } = await miniOrder();
    const tpl = await draftTemplate("TRAVELER");
    const res = await previewRoute(
      previewReq(tpl.id, ordersOnly, { recordId: order.id, config: cfgOf("TRAVELER") }), withParams({ id: tpl.id }));
    expect(res.status).toBe(403);
  });

  it("200 with BOTH — streams application/pdf", async () => {
    const { order } = await miniOrder();
    const tpl = await draftTemplate("TRAVELER");
    const res = await previewRoute(
      previewReq(tpl.id, full, { recordId: order.id, config: cfgOf("TRAVELER") }), withParams({ id: tpl.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect((await pdfOf(res)).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("404 for a missing/deleted template", async () => {
    const res = await previewRoute(previewReq("nope", full, { recordId: "x", config: cfgOf("TRAVELER") }), withParams({ id: "nope" }));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/templates/[id]/preview — the submitted config renders", () => {
  it("a label override in the SUBMITTED config appears in the preview bytes", async () => {
    const { order } = await miniOrder();
    const tpl = await draftTemplate("TRAVELER");
    const c = cfgOf("TRAVELER");
    fieldOf(c, "header", "order_number").label = "WO-PREVIEW-MARKER";
    const res = await previewRoute(previewReq(tpl.id, full, { recordId: order.id, config: c }), withParams({ id: tpl.id }));
    expect(res.status).toBe(200);
    const text = drawnText(await pdfOf(res));
    expect(text).toContain("WO-PREVIEW-MARKER");
    expect(text).not.toContain("Order Number");
  });

  it("an invalid / over-budget config 400s BEFORE any render", async () => {
    const { order } = await miniOrder();
    const tpl = await draftTemplate("TRAVELER");
    const c = cfgOf("TRAVELER");
    fieldOf(c, "lines", "line_qty").width = 900; // 900 alone blows the 564pt content-width budget
    const res = await previewRoute(previewReq(tpl.id, full, { recordId: order.id, config: c }), withParams({ id: tpl.id }));
    expect(res.status).toBe(400);
  });

  it("a NEVER-PUBLISHED draft still previews — it renders the submitted config directly (no resolve)", async () => {
    const { order } = await miniOrder();
    const tpl = await draftTemplate("TRAVELER"); // created, v1 DRAFT open, never published
    const publishedCount = await prisma.documentTemplateVersion.count({
      where: { templateId: tpl.id, status: "PUBLISHED" },
    });
    expect(publishedCount).toBe(0);
    const c = cfgOf("TRAVELER");
    fieldOf(c, "header", "order_number").label = "NEVER-PUBLISHED-MARKER";
    const res = await previewRoute(previewReq(tpl.id, full, { recordId: order.id, config: c }), withParams({ id: tpl.id }));
    expect(res.status).toBe(200);
    expect(drawnText(await pdfOf(res))).toContain("NEVER-PUBLISHED-MARKER");
  });
});

describe("POST /api/templates/[id]/preview — the order's PO, as a print reads it (#518)", () => {
  it("prints the order's PO as the order holds it at the preview, and the write-in rule when it has none", async () => {
    const { order } = await miniOrder(); // created with no PO
    const tpl = await draftTemplate("TRAVELER");
    const preview = async (config: TemplateConfig) => {
      const res = await previewRoute(previewReq(tpl.id, full, { recordId: order.id, config }), withParams({ id: tpl.id }));
      expect(res.status).toBe(200);
      return pdfOf(res);
    };
    expect(leftColumn(await preview(cfgOf("TRAVELER"))).at(-1)).toBe(`PO: ${RULE}`);

    await prisma.order.update({ where: { id: order.id }, data: { poNumber: "ADSE-3335" } });
    const pdf = await preview(cfgOf("TRAVELER"));
    expect(drawnText(pdf)).toContain("PO: ADSE-3335");
    expect(leftColumn(pdf).at(-1)).toBe("PO: ADSE-3335");
  });

  it("a relabel in the SUBMITTED config prints its own label, and the built-in one nowhere", async () => {
    const { order } = await miniOrder();
    await prisma.order.update({ where: { id: order.id }, data: { poNumber: "ADSE-3335" } });
    const tpl = await draftTemplate("TRAVELER");
    const c = cfgOf("TRAVELER");
    fieldOf(c, "header", "po_number").label = "Cust PO:";
    const res = await previewRoute(previewReq(tpl.id, full, { recordId: order.id, config: c }), withParams({ id: tpl.id }));
    expect(res.status).toBe(200);
    const pdf = await pdfOf(res);
    expect(drawnText(pdf)).toContain("Cust PO: ADSE-3335");
    // Read by line: the drawn text joined whole holds "PO: ADSE" inside "Cust PO: ADSE-3335".
    const column = leftColumn(pdf);
    expect(column.at(-1)).toBe("Cust PO: ADSE-3335");
    expect(column.filter((line) => line.startsWith("PO:"))).toEqual([]);
    // The whole page, past the left column too: no "PO:" but inside the relabelled line.
    expect(drawnText(pdf).replace("Cust PO: ADSE-3335", "")).not.toContain("PO:");
  });

  it("hidden in the SUBMITTED config, the preview prints no PO line", async () => {
    const { order } = await miniOrder();
    await prisma.order.update({ where: { id: order.id }, data: { poNumber: "ADSE-3335" } });
    const tpl = await draftTemplate("TRAVELER");
    const c = cfgOf("TRAVELER");
    fieldOf(c, "header", "po_number").visible = false;
    const res = await previewRoute(previewReq(tpl.id, full, { recordId: order.id, config: c }), withParams({ id: tpl.id }));
    expect(res.status).toBe(200);
    const text = drawnText(await pdfOf(res));
    expect(text).not.toContain("PO:");
    expect(text).not.toContain("ADSE-3335");
  });
});

describe("POST /api/templates/[id]/preview — the invoice's order strip on one line (#590)", () => {
  // The preview renders through the same builder and renderer as a print, so it prints the strip as a
  // print does: Our Order #, Your PO #, Material and Process side by side, their labels on one y, left
  // to right. tests/invoice-pdf.test.ts holds the strip's cases on the printed page.
  it("prints the four labels on one line, left to right, with the invoice's values", async () => {
    const { invoice, material } = await invoiceFixture();
    const tpl = await draftTemplate("INVOICE");
    const res = await previewRoute(previewReq(tpl.id, full, { recordId: invoice.id, config: cfgOf("INVOICE") }), withParams({ id: tpl.id }));
    expect(res.status).toBe(200);
    const page = textRunsWithY(await pdfOf(res))[0];
    const labels = ["Our Order #:", "Your PO #:", "Material:", "Process:"]
      .map((label) => page.find((r) => r.text.trim() === label));
    expect(labels.every((r) => r !== undefined), "every label is drawn").toBe(true);
    expect(labels.map((r) => r!.y)).toEqual(labels.map(() => labels[0]!.y));
    expect(labels.every((r, i) => i === 0 || r!.x > labels[i - 1]!.x), "the labels' x, left to right").toBe(true);
    const line = page.filter((r) => r.y === labels[0]!.y).map((r) => r.text).join("");
    expect(line).toContain("Your PO #: 89499");
    expect(line).toContain(`Material: ${material}`);
    expect(line).toContain("Process: Austemper");
  });
});

describe("POST /api/templates/[id]/preview — a canvas invoice answers X-Preview-Measure", () => {
  // The route reaches `renderPreview`'s INVOICE arm, `renderInvoiceCanvasPreview` whole, since PR 3
  // put INVOICE in CANVAS_PRINTS (design 2026-11-10 §7, §11 "Measure header"). These cases are the
  // arm's proof through its real door: made a bare `renderPdf` of the flow definition, the arm answers
  // no X-Preview-Measure, and every case below that asserts the header reds (Task 3 Step 3).
  const invCfg = (): TemplateConfig => cfgOf("INVOICE");
  const canvasCfg = (): TemplateConfig => ({ ...invCfg(), layout: standardInvoiceLayout() });
  const preview = async (config: unknown, recordId: string, cookie: string = full) => {
    const tpl = await draftTemplate("INVOICE");
    return previewRoute(previewReq(tpl.id, cookie, { config, recordId }), withParams({ id: tpl.id }));
  };
  const measureOf = (res: Response): CanvasMeasure =>
    JSON.parse(decodeURIComponent(res.headers.get("X-Preview-Measure")!)) as CanvasMeasure;

  it("a canvas invoice preview carries the six blocks in y order, their regions, and every item with a height", async () => {
    // Reds when the INVOICE arm renders the flow bare: the header is absent.
    const { invoice } = await invoiceFixture();
    const layout = standardInvoiceLayout();
    const res = await preview(canvasCfg(), invoice.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("X-Preview-Measure")).not.toBeNull();
    const measure = measureOf(res);
    expect(pageCount(await pdfOf(res))).toBe(1);
    expect(measure.pages).toBe(1);
    const blocks = layout.items.filter((i) => i.kind === "table").sort((a, b) => a.box.y - b.box.y)
      .map((i) => (i.kind === "table" ? i.key : ""));
    expect(blocks).toEqual(["parties", "column_header", "order_strip", "parts", "price", "totals"]);
    expect(measure.tables.map((t) => t.key)).toEqual(blocks);
    // One region below each block, and no spare one after the last (red under a spare region pushed
    // after the totals in `canvasMeasure`).
    expect(measure.regions).toHaveLength(blocks.length);
    const drawn = regionHeights(layout);
    for (const [i, table] of measure.tables.entries()) {
      expect(table.page, table.key).toBe(1);
      expect(table.height, table.key).toBeGreaterThan(0);
      const region = measure.regions[i];
      expect(region).toMatchObject({ after: table.key, page: 1, height: drawn[i].height });
      expect(region.top).toBeCloseTo(table.top + table.height, 6);
      if (i > 0) expect(table.top).toBeCloseTo(measure.regions[i - 1].top + measure.regions[i - 1].height, 6);
    }
    // Every item but the blocks is measured with a height, at its stored box (the standard layout
    // anchors none below a block).
    for (const item of layout.items.filter((i) => i.kind !== "table")) {
      const entry = measure.items.find((candidate) => candidate.id === item.id);
      expect(entry, item.id).toBeDefined();
      expect(entry!.height, item.id).toBeGreaterThan(0);
      expect(entry, item.id).toMatchObject({ page: 1, left: item.box.x, top: item.box.y });
    }
    // The band's three, each with a height (the fixture's company address is one line,
    // `seedOrderGatePrereqs`' "1 Test Way, Testville").
    const band = layout.items.filter((i) => i.kind === "field" && i.anchor.kind === "page-bottom");
    expect(band.map((i) => (i.kind === "field" ? i.key : i.kind))).toEqual(["footer_address", "footer_contact", "footer_phone"]);
    for (const item of band) {
      expect(measure.items.find((candidate) => candidate.id === item.id)!.height, item.id).toBeGreaterThan(0);
    }
    // The order strip's row id sits inside its block's wrapper and enters no entry (pin: no sampled
    // mutation reds these two lines).
    expect(measure.tables.some((t) => (t.key as string) === "invoice-order-strip")).toBe(false);
    expect(measure.items.some((entry) => entry.id === "invoice-order-strip")).toBe(false);
  });

  it("(pin) a flow invoice config previews with no X-Preview-Measure through the route", async () => {
    // The route's half of the direct flow case in the describe below; no sampled mutation reds it
    // (the arm made a bare flow render answers no header either).
    const { invoice } = await invoiceFixture();
    const res = await preview(invCfg(), invoice.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("X-Preview-Measure")).toBeNull();
  });

  it("a credit previews its canvas: its title prints Credit, and the measure holds the six blocks", async () => {
    // Design call 10: one canvas prints invoices and credit memos. Reds when the INVOICE arm renders
    // the flow bare: the header is absent.
    const { invoice } = await invoiceFixture();
    await asSystem(() => finalizeInvoice(invoice.id));
    const credit = await asSystem(() => createCredit(invoice.id));
    expect(credit.kind).toBe("CREDIT");
    // The title item prints the row's own kind as the page's top line: "Invoice" on the invoice, so
    // the credit's "Credit" below is the data, not a fixed label.
    const topLine = async (res: Response) => textLinesWithY(await pdfOf(res))[0][0].text.trim();
    const own = await preview(canvasCfg(), invoice.id);
    expect(own.status).toBe(200);
    expect(await topLine(own)).toBe("Invoice");

    const res = await preview(canvasCfg(), credit.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Preview-Measure")).not.toBeNull();
    const measure = measureOf(res);
    expect(measure.tables.map((t) => t.key)).toEqual(["parties", "column_header", "order_strip", "parts", "price", "totals"]);
    expect(await topLine(res)).toBe("Credit");
  });

  it("templates.view alone is 403 without invoicing.view, storing and auditing nothing", async () => {
    // Reds when the route's record-area `mustCan` is deleted: the real invoice and a valid canvas
    // config then render, 200.
    const { invoice } = await invoiceFixture();
    const tpl = await draftTemplate("INVOICE");
    const stored = await prisma.storedDocument.count();
    const audits = await prisma.auditLog.count();
    const res = await previewRoute(previewReq(tpl.id, templatesOnly, { config: canvasCfg(), recordId: invoice.id }), withParams({ id: tpl.id }));
    expect(res.status).toBe(403);
    // Pins: a 403 thrown before the render writes nothing on either branch.
    expect(await prisma.storedDocument.count()).toBe(stored);
    expect(await prisma.auditLog.count()).toBe(audits);
  });

  it("the side-effect-free invariant holds for a canvas invoice: nothing stored or audited, the draft and the invoice unchanged", async () => {
    // Reds, at its header line, when the INVOICE arm renders the flow bare; the invariant's own lines
    // are pins (the preview writes nothing on either branch).
    const { invoice } = await invoiceFixture();
    const tpl = await draftTemplate("INVOICE");
    const draftBefore = await prisma.documentTemplateVersion.findFirstOrThrow({ where: { templateId: tpl.id, status: "DRAFT" } });
    const invoiceBefore = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    const stored = await prisma.storedDocument.count();
    const audits = await prisma.auditLog.count();
    const res = await previewRoute(previewReq(tpl.id, full, { config: canvasCfg(), recordId: invoice.id }), withParams({ id: tpl.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Preview-Measure")).not.toBeNull();
    expect(await prisma.storedDocument.count()).toBe(stored);
    expect(await prisma.auditLog.count()).toBe(audits);
    const draftAfter = await prisma.documentTemplateVersion.findFirstOrThrow({ where: { templateId: tpl.id, status: "DRAFT" } });
    expect(draftAfter.updatedAt.getTime()).toBe(draftBefore.updatedAt.getTime());
    expect(draftAfter.config).toEqual(draftBefore.config);
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).toEqual(invoiceBefore);
  });
});

describe("renderInvoiceCanvasPreview: an invoice canvas previews with its measure (design 2026-11-10 §5.2, §7)", () => {
  // The function is the preview's whole INVOICE branch, called here directly (the route reaches it
  // through `renderPreview`): a canvas config is validated against the invoice's profile and handed
  // to the function. These cases prove the function; that `renderPreview`'s INVOICE arm delegates to
  // it is proven by the route's canvas cases in the describe above, which red when the arm renders
  // the flow bare. The flow case below stays a pin: such an arm renders a flow config the same.
  const invCfg = (): TemplateConfig => cfgOf("INVOICE");
  const canvasCfg = (layout: CanvasLayout): TemplateConfig => {
    validateCanvasLayout(layout, INVOICE_CONTRACT, { pageFooter: false });
    return { ...invCfg(), layout };
  };
  const options = () => ({ pageFooter: invCfg().pageFooter, fonts: invCfg().fonts });
  /** `sampleInvoice` with `n` parts, each with one priced operation: it pages. */
  const manyParts = (n: number): InvoicePdfData => {
    const parts = Array.from({ length: n }, (_, i) => ({
      qty: 10 + i, partNumber: `DEMO-${9100 + i}`, partName: `PART ${i + 1}`, partDescription: "", eachWeight: 2, totalWeight: 2 * (10 + i),
    }));
    return sampleInvoice({
      parts,
      priceRows: parts.map((p, i) => ({
        description: `Operation ${i + 1}`, pricePerLabel: "Each", unitPrice: 1, minimumCharge: null, setupCharge: null, amount: p.qty, partIndex: i,
      })),
    });
  };
  const withItem = (layout: CanvasLayout, item: CanvasItem): CanvasLayout => ({ ...layout, items: [...layout.items, item] });

  it("a canvas invoice answers a measure holding the six blocks in y order, their regions and every item with a height, the band's three at their alone heights; the order strip's block is measured by its wrapper and the strip row's own id enters no entry", async () => {
    const layout = standardInvoiceLayout();
    const config = canvasCfg(layout);
    const { pdf, measure } = await renderInvoiceCanvasPreview(sampleInvoice(), config, undefined);
    expect(measure).not.toBeNull();
    const m = measure!;
    expect(pageCount(pdf)).toBe(1);
    expect(m.pages).toBe(1);
    expect(m.tables.map((t) => t.key)).toEqual(["parties", "column_header", "order_strip", "parts", "price", "totals"]);
    const drawn = regionHeights(layout);
    for (const [i, table] of m.tables.entries()) {
      expect(table.page, table.key).toBe(1);
      expect(table.height, table.key).toBeGreaterThan(0);
      const region = m.regions[i];
      expect(region).toMatchObject({ after: table.key, page: 1, height: drawn[i].height });
      expect(region.top).toBeCloseTo(table.top + table.height, 6);
      if (i > 0) expect(table.top).toBeCloseTo(m.regions[i - 1].top + m.regions[i - 1].height, 6);
    }
    // Every item but the blocks is measured with a height: page-top at its stored box, in the band at
    // its stored box, each band item one small-size line as its alone render laid it out.
    for (const item of layout.items.filter((i) => i.kind !== "table")) {
      const entry = m.items.find((candidate) => candidate.id === item.id);
      expect(entry, item.id).toBeDefined();
      expect(entry!.height, item.id).toBeGreaterThan(0);
      expect(entry, item.id).toMatchObject({ page: 1, left: item.box.x, top: item.box.y });
    }
    // The band's three, measured alone: the company address as many small-size lines as it holds
    // (two here, past its drawn 9), the contact label and the phone one each.
    const small = invCfg().fonts.smallSize;
    const band = layout.items.filter((i) => i.kind === "field" && i.anchor.kind === "page-bottom");
    const lines: Record<string, number> = {
      footer_address: sampleInvoice().company.address.split("\n").length, footer_contact: 1, footer_phone: 1,
    };
    expect(lines.footer_address).toBe(2);
    expect(band.map((i) => (i.kind === "field" ? i.key : i.kind))).toEqual(Object.keys(lines));
    for (const item of band) {
      const entry = m.items.find((candidate) => candidate.id === item.id)!;
      const count = lines[item.kind === "field" ? item.key : ""];
      expect(entry.height, item.id).toBeGreaterThan(count * small);
      expect(entry.height, item.id).toBeLessThan((count + 1) * small);
    }
    // The strip row prints under its own id inside the block's wrapper, which carries the block's; the
    // measure reads canvas ids alone, so the block is measured from the wrapper's flow point to its end
    // mark and no entry is keyed by the row's id.
    const { groups } = await renderSheetGroupsWithPositions([buildInvoiceDefinition(sampleInvoice(), config)]);
    const at = (id: string) => groups[0].positions.find((n) => n.id === id);
    expect(at("invoice-order-strip")).toBeDefined();
    const wrapper = at(CANVAS_IDS.table("order_strip"))!;
    const strip = m.tables.find((t) => t.key === "order_strip")!;
    expect(wrapper.page).toBe(strip.page);
    expect(wrapper.top).toBeCloseTo(strip.top, 2);
    expect(strip.top + strip.height).toBeCloseTo(at(CANVAS_IDS.end("order_strip"))!.top, 6);
    expect(m.items.some((entry) => entry.id === "invoice-order-strip")).toBe(false);
  });

  it("a flow invoice answers no measure, and its text is renderPreview's for the same invoice (pin: the arm a bare delegation)", async () => {
    const { invoice } = await invoiceFixture();
    const tpl = await draftTemplate("INVOICE");
    const ctx = await readPreviewContext(tpl.id);
    const data = await prisma.$transaction(async (tx) => readInvoicePdfData(tx, invoice.id, await invoicePrintSettings()));
    const own = await renderInvoiceCanvasPreview(data, invCfg(), undefined);
    expect(own.measure).toBeNull();
    const routed = await renderPreview(ctx, { recordId: invoice.id, config: invCfg() }, "nobody");
    expect(routed.measure).toBeNull();
    expect(textRunsWithY(own.pdf)).toEqual(textRunsWithY(routed.pdf));
  });

  it("warning (b): an invoice's Remit To box drawn 20 tall over a two-line company address is warned taller than drawn; drawn as tall as it prints it is not", async () => {
    const data = sampleInvoice();
    expect(data.remitTo.lines).toHaveLength(2);
    const standard = standardInvoiceLayout();
    const remitTo = standard.items.find((i) => i.kind === "field" && i.key === "remit_to")!;
    const drawnAt = (h: number): CanvasLayout => ({
      ...standard, items: standard.items.map((i) => (i === remitTo ? { ...remitTo, box: { ...remitTo.box, h } } : i)),
    });
    const tallerThanDrawn = (layout: CanvasLayout, m: CanvasMeasure) => canvasWarnings(layout, INVOICE_CONTRACT, m, options())
      .filter((w) => w.itemIds.includes(remitTo.id) && w.sentence.includes("is taller than its box"))
      .map((w) => w.sentence);

    const short = drawnAt(20);
    const { measure } = await renderInvoiceCanvasPreview(data, canvasCfg(short), undefined);
    const printed = measure!.items.find((entry) => entry.id === remitTo.id)!.height;
    expect(printed).toBeGreaterThan(20);
    expect(tallerThanDrawn(short, measure!)).toEqual([
      `The Remit-to box field is taller than its box by ${Math.round((printed - 20) * 100) / 100} pt and prints over what is drawn under it.`,
    ]);

    // The neighbour: the same box drawn as tall as it printed, the same data.
    const tall = drawnAt(Math.ceil(printed));
    const tallRun = await renderInvoiceCanvasPreview(data, canvasCfg(tall), undefined);
    expect(tallRun.measure!.items.find((entry) => entry.id === remitTo.id)!.height).toBeCloseTo(printed, 6);
    expect(tallerThanDrawn(tall, tallRun.measure!)).toEqual([]);
  });

  it("warning (c): a Text item anchored below the totals of a 30-part invoice, printing taller than drawn, ends past the band and is warned; under a one-part invoice it is not", async () => {
    const text: CanvasItem = {
      id: "below-totals", kind: "text", text: "Thank you for your business. ".repeat(32).trim(),
      box: { x: 24, y: CANVAS_GRID, w: 200, h: 12 },
      anchor: { kind: "below-table", table: "totals" }, repeat: false, style: { size: 9, bold: false, align: "left" },
    };
    const layout = withItem(standardInvoiceLayout(), text);
    const config = canvasCfg(layout);
    const pastBand = (m: CanvasMeasure) => canvasWarnings(layout, INVOICE_CONTRACT, m, options())
      .filter((w) => w.itemIds.includes(text.id) && w.sentence.includes("would be cut off"));

    const one = await renderInvoiceCanvasPreview(sampleInvoice(), config, undefined);
    expect(one.measure!.pages).toBe(1);
    expect(pastBand(one.measure!)).toEqual([]);

    const { measure } = await renderInvoiceCanvasPreview(manyParts(30), config, undefined);
    const m = measure!;
    expect(m.pages).toBeGreaterThanOrEqual(2);
    const entry = m.items.find((candidate) => candidate.id === text.id)!;
    const region = m.regions.find((r) => r.after === "totals")!;
    expect(entry.page).toBe(region.page);
    const bottom = Math.round((entry.top + entry.height) * 100) / 100;
    expect(pastBand(m).map((w) => w.sentence)).toEqual([
      `The Text (text ${text.id}) ends at ${bottom} pt, past ${bandTop(layout, options().pageFooter)}, the top of the page-bottom band, and would be cut off.`,
    ]);
  });
});

describe("POST /api/templates/[id]/preview — the load-bearing side-effect-free invariant", () => {
  it("writes NO StoredDocument row", async () => {
    const { order } = await miniOrder();
    const tpl = await draftTemplate("TRAVELER");
    const before = await prisma.storedDocument.count();
    const res = await previewRoute(previewReq(tpl.id, full, { recordId: order.id, config: cfgOf("TRAVELER") }), withParams({ id: tpl.id }));
    expect(res.status).toBe(200);
    expect(await prisma.storedDocument.count()).toBe(before);
  });

  it("does NOT set the cert's printedAt", async () => {
    const { cert } = await certFixture();
    const tpl = await draftTemplate("CERT");
    expect((await prisma.cert.findUniqueOrThrow({ where: { id: cert.id } })).printedAt).toBeNull();
    const res = await previewRoute(previewReq(tpl.id, full, { recordId: cert.id, config: cfgOf("CERT") }), withParams({ id: tpl.id }));
    expect(res.status).toBe(200);
    expect((await prisma.cert.findUniqueOrThrow({ where: { id: cert.id } })).printedAt).toBeNull();
  });

  it("does NOT bump the draft's updatedAt", async () => {
    const { order } = await miniOrder();
    const tpl = await draftTemplate("TRAVELER");
    const before = (await prisma.documentTemplateVersion.findFirstOrThrow({ where: { templateId: tpl.id, status: "DRAFT" } })).updatedAt;
    const res = await previewRoute(previewReq(tpl.id, full, { recordId: order.id, config: cfgOf("TRAVELER") }), withParams({ id: tpl.id }));
    expect(res.status).toBe(200);
    const after = (await prisma.documentTemplateVersion.findFirstOrThrow({ where: { templateId: tpl.id, status: "DRAFT" } })).updatedAt;
    expect(after.getTime()).toBe(before.getTime());
  });
});

describe("POST /api/templates/[id]/preview — the statement preview (finance off, asOf/combineFamily)", () => {
  const ASOF = "2026-07-29";

  it("forces finance-charge assessment OFF — the line the same data WOULD produce is absent", async () => {
    const { id } = await statementCustomer();
    // Control: with assessment ON the setup produces a real finance charge, so the absence below is not vacuous.
    const assessed = await asSystem(() => buildStatement(id, { asOf: ASOF, combineFamily: false, assessFinanceCharges: true }));
    expect(assessed.financeCharge).not.toBeNull();

    const tpl = await draftTemplate("STATEMENT");
    const res = await previewRoute(previewReq(tpl.id, full, { recordId: id, asOf: ASOF, config: cfgOf("STATEMENT") }), withParams({ id: tpl.id }));
    expect(res.status).toBe(200);
    // Matched on the label's STEM, not its full text: #162 relabelled the contract default, and a
    // negative assertion pinned to the old literal would have gone vacuously green instead of red.
    expect(drawnText(await pdfOf(res))).not.toContain("Finance Charge");
  });

  it("honors asOf — an invoice not yet finalized as of the date does not appear", async () => {
    const { id } = await statementCustomer(); // finalizedAt 2026-05-10
    const tpl = await draftTemplate("STATEMENT");
    const early = await previewRoute(previewReq(tpl.id, full, { recordId: id, asOf: "2026-04-01", config: cfgOf("STATEMENT") }), withParams({ id: tpl.id }));
    expect(early.status).toBe(200);
    expect(drawnText(await pdfOf(early))).not.toContain("$400.00");

    const late = await previewRoute(previewReq(tpl.id, full, { recordId: id, asOf: ASOF, config: cfgOf("STATEMENT") }), withParams({ id: tpl.id }));
    expect(drawnText(await pdfOf(late))).toContain("$400.00");
  });

  it("honors combineFamily — a child's open item appears only when the family is combined", async () => {
    const parent = await prisma.customer.create({ data: { code: `PAR${(seq += 1)}`, name: `Parent ${seq}` } });
    await prisma.customerAddress.create({
      data: { customerId: parent.id, kind: "BILL_TO", name: "AP", street: "1 St", city: "Columbus", state: "GA", zip: "31902", isDefault: true },
    });
    const child = await statementCustomer();
    await prisma.customer.update({ where: { id: child.id }, data: { parentId: parent.id } });

    const tpl = await draftTemplate("STATEMENT");
    const alone = await previewRoute(previewReq(tpl.id, full, { recordId: parent.id, asOf: ASOF, combineFamily: false, config: cfgOf("STATEMENT") }), withParams({ id: tpl.id }));
    expect(alone.status).toBe(200);
    expect(drawnText(await pdfOf(alone))).not.toContain("$400.00");

    const combined = await previewRoute(previewReq(tpl.id, full, { recordId: parent.id, asOf: ASOF, combineFamily: true, config: cfgOf("STATEMENT") }), withParams({ id: tpl.id }));
    expect(drawnText(await pdfOf(combined))).toContain("$400.00");
  });
});

describe("POST /api/templates/[id]/preview — a canvas statement answers X-Preview-Measure", () => {
  // The route reaches `renderPreview`'s STATEMENT arm, `renderStatementCanvasPreview` whole, since
  // statement canvas PR 2 put STATEMENT in CANVAS_PRINTS (design 2026-11-11 §5.2, §7). Made a bare
  // `renderPdf` of the flow definition, the arm answers no X-Preview-Measure, and the measure case
  // reds.
  const ASOF = "2026-07-29";
  const BLOCKS = ["bill_to", "open_items", "aging", "finance_charge", "total"];
  const measureOf = (res: Response): CanvasMeasure =>
    JSON.parse(decodeURIComponent(res.headers.get("X-Preview-Measure")!)) as CanvasMeasure;

  it("a canvas statement preview carries the five blocks in y order, one region a block, the measure the arm's own, and stores and audits nothing", async () => {
    const { id } = await statementCustomer();
    const tpl = await draftTemplate("STATEMENT");
    const layout = standardStatementLayout();
    const config = { ...cfgOf("STATEMENT"), layout };
    const stored = await prisma.storedDocument.count();
    const audits = await prisma.auditLog.count();
    const before = await prisma.documentTemplateVersion.findFirstOrThrow({ where: { templateId: tpl.id, status: "DRAFT" } });
    const res = await previewRoute(previewReq(tpl.id, full, { recordId: id, asOf: ASOF, config }), withParams({ id: tpl.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("X-Preview-Measure")).not.toBeNull();
    const measure = measureOf(res);
    const pdf = await pdfOf(res);
    expect(pageCount(pdf)).toBe(1);
    expect(measure.pages).toBe(1);
    expect(measure.tables.map((t) => t.key)).toEqual(BLOCKS);
    expect(measure.regions).toHaveLength(BLOCKS.length);
    // The arm's own measure: the same data (`buildStatement`'s, never assessed) previewed directly.
    const data = await buildStatement(id, { asOf: ASOF, combineFamily: false, assessFinanceCharges: false });
    expect(data.financeCharge).toBeNull();
    expect(measure).toEqual((await renderStatementCanvasPreview(data, validateConfig("STATEMENT", config), undefined)).measure);
    // Nothing written: no document, no audit row, no draft edit, no finance-charge line.
    expect(await prisma.storedDocument.count()).toBe(stored);
    expect(await prisma.auditLog.count()).toBe(audits);
    const after = await prisma.documentTemplateVersion.findFirstOrThrow({ where: { templateId: tpl.id, status: "DRAFT" } });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(drawnText(pdf)).not.toContain("Finance Charge");
  });

  // (pin) No mutation of the route or the gate reds it: the arm's flow half is
  // `renderStatementCanvasPreview`'s null-layout branch, which tests/statement-canvas-seed.test.ts's own
  // pin holds.
  it("a flow statement's preview answers no X-Preview-Measure (pin)", async () => {
    const { id } = await statementCustomer();
    const tpl = await draftTemplate("STATEMENT");
    const res = await previewRoute(previewReq(tpl.id, full, { recordId: id, asOf: ASOF, config: cfgOf("STATEMENT") }), withParams({ id: tpl.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Preview-Measure")).toBeNull();
  });

  // Red under `RECORD_AREA.STATEMENT` set to "invoicing" (the caller holds that area) and under the
  // route's second `mustCan` deleted; neither is among the gate's named mutations, both were run.
  it("a canvas statement preview without receivables.view is 403, storing and auditing nothing", async () => {
    const { id } = await statementCustomer();
    const tpl = await draftTemplate("STATEMENT");
    const noReceivables = await signInWith(
      ["templates.view", "orders.view", "shipping.view", "certs.view", "invoicing.view", "quotes.view"], "pnorecv");
    const stored = await prisma.storedDocument.count();
    const audits = await prisma.auditLog.count();
    const res = await previewRoute(previewReq(tpl.id, noReceivables, {
      recordId: id, asOf: ASOF, config: { ...cfgOf("STATEMENT"), layout: standardStatementLayout() },
    }), withParams({ id: tpl.id }));
    expect(res.status).toBe(403);
    expect(await prisma.storedDocument.count()).toBe(stored);
    expect(await prisma.auditLog.count()).toBe(audits);
  });
});

// Ruling R17 (#674): a traveler preview is the order's first load unless All loads is asked for.
describe("POST /api/templates/[id]/preview — a TRAVELER previews one load unless All loads is asked for", () => {
  const preview = async (body: Record<string, unknown>) => {
    const tpl = await draftTemplate("TRAVELER");
    return previewRoute(previewReq(tpl.id, full, { config: cfgOf("TRAVELER"), ...body }), withParams({ id: tpl.id }));
  };
  it("three loads: the first load's one sheet by default, every sheet with allLoads, the named load with loadNumber", async () => {
    const order = await orderWithLoads(3);
    const first = await pdfOf(await preview({ recordId: order.id }));
    expect(pageCount(first)).toBe(1);
    expect(drawnText(first)).toBe(drawnText(await pdfOf(await preview({ recordId: order.id, loadNumber: 1 }))));
    expect(drawnText(first)).not.toBe(drawnText(await pdfOf(await preview({ recordId: order.id, loadNumber: 2 }))));
    expect(pageCount(await pdfOf(await preview({ recordId: order.id, allLoads: true })))).toBe(3);
  });
  it("an order with no loads keeps its one blank sheet", async () => {
    const order = await orderWithLoads(0);
    const res = await preview({ recordId: order.id });
    expect(res.status).toBe(200);
    expect(pageCount(await pdfOf(res))).toBe(1);
  });
  it("an order of more than 100 loads previews its first load; All loads keeps the print's #43 refusal", async () => {
    const order = await orderWithLoads(101);
    const res = await preview({ recordId: order.id });
    expect(res.status).toBe(200);
    expect(pageCount(await pdfOf(res))).toBe(1);
    const all = await preview({ recordId: order.id, allLoads: true });
    expect(all.status).toBe(400);
    expect((await all.json()).error).toMatch(/101 loads .* Print the loads one at a time/);
  });
  it("refuses a load number together with All loads", async () => {
    const order = await orderWithLoads(2);
    expect((await preview({ recordId: order.id, loadNumber: 1, allLoads: true })).status).toBe(400);
  });
});

// The canvas traveler's measure report (PR B of #926, task 6; design 2026-11-07 §5.3): a canvas
// config's preview answers where it laid each table, region and page-top item out, in one header.
describe("POST /api/templates/[id]/preview — a canvas TRAVELER answers X-Preview-Measure", () => {
  const canvasCfg = () => ({ ...cfgOf("TRAVELER"), layout: standardLayout() });
  const preview = async (config: unknown, body: Record<string, unknown>) => {
    const tpl = await draftTemplate("TRAVELER");
    return previewRoute(previewReq(tpl.id, full, { config, ...body }), withParams({ id: tpl.id }));
  };
  const measureOf = (res: Response): CanvasMeasure =>
    JSON.parse(decodeURIComponent(res.headers.get("X-Preview-Measure")!)) as CanvasMeasure;

  it("a canvas config's preview carries X-Preview-Measure with the tables', regions' and page-top items' positions for the first load, and a flow config's carries none", async () => {
    const order = await orderWithLoads(1);
    const layout = standardLayout();
    const res = await preview(canvasCfg(), { recordId: order.id });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const measure = measureOf(res);
    expect(pageCount(await pdfOf(res))).toBe(1);
    expect(measure.pages).toBe(1);

    // The four tables, top to bottom, on page 1, each as tall as its rows printed; the first at its
    // drawn top (the head spacer's end), each later one where the region above it ends.
    expect(measure.tables.map((t) => t.key)).toEqual(["lines", "quantities", "inspections", "steps"]);
    expect(measure.tables[0].top).toBe(140);
    const drawn = regionHeights(layout);
    for (const [i, table] of measure.tables.entries()) {
      expect(table.page).toBe(1);
      expect(table.height).toBeGreaterThan(0);
      // Its region starts where the table ends (the end mark) and is its drawn height tall.
      const region = measure.regions[i];
      expect(region).toMatchObject({ after: table.key, page: 1, height: drawn[i].height });
      expect(region.top).toBeCloseTo(table.top + table.height, 6);
      if (i > 0) expect(table.top).toBeCloseTo(measure.regions[i - 1].top + measure.regions[i - 1].height, 6);
    }
    expect(measure.regions.every((region) => region.height > 0)).toBe(true);

    // The page-top items that printed, each at its drawn top-left exactly (its wrapper's position).
    // The logo (this draft carries no logo bytes), the empty phone and the received-from address (the
    // customer has none) printed nothing and are left out.
    const ids = measure.items.map((item) => item.id);
    for (const id of ["field-customer_name", "field-order_number", "field-load_number", "barcode"]) expect(ids).toContain(id);
    for (const id of ["logo", "field-customer_phone", "field-received_from"]) expect(ids).not.toContain(id);
    const anchorOf = (id: string) => layout.items.find((candidate) => candidate.id === id)!.anchor;
    for (const item of measure.items.filter((entry) => anchorOf(entry.id).kind === "page-top")) {
      const box = layout.items.find((candidate) => candidate.id === item.id)!.box;
      expect(item).toMatchObject({ page: 1, left: box.x, top: box.y });
      expect(item.height).toBeGreaterThan(0);
    }
    // The items below a table, measured on their region's own alone render (the shipping ticket
    // design's §5.2): the Results box 8 pt under the Steps region's top, the process field one grid
    // step under Quantities', each on its region's page with a height.
    const regionOf = (key: string) => measure.regions.find((region) => region.after === key)!;
    const results = measure.items.find((item) => item.id === "field-results")!;
    expect(results).toMatchObject({ page: regionOf("steps").page, left: 24 });
    expect(results.top).toBeCloseTo(regionOf("steps").top + 8, 2);
    expect(results.height).toBeGreaterThan(0);
    const process = measure.items.find((item) => item.id === "field-process")!;
    expect(process).toMatchObject({ page: regionOf("quantities").page, left: 24 });
    expect(process.top).toBeCloseTo(regionOf("quantities").top + 4.5, 2);
    expect(process.height).toBeGreaterThan(0);
    // One 8 pt line inside a 12 pt field box; the barcode image exactly its drawn 44 pt.
    expect(measure.items.find((item) => item.id === "field-customer_name")!.height).toBeLessThan(12);
    expect(measure.items.find((item) => item.id === "barcode")!.height).toBeCloseTo(44, 6);

    // The same order previewed with the flow config: the same PDF answer, and no measure.
    const flow = await preview(cfgOf("TRAVELER"), { recordId: order.id });
    expect(flow.status).toBe(200);
    expect(flow.headers.get("X-Preview-Measure")).toBeNull();
    expect(flow.headers.get("cache-control")).toBe("no-store");
    expect(pageCount(await pdfOf(flow))).toBe(1);
  });

  it("measures a page-bottom item at its own y on the last page, from the band's alone render", async () => {
    const order = await orderWithLoads(1);
    const sig = {
      id: "sig", kind: "text", text: "Signed for the plant", box: { x: 24, y: 700, w: 200, h: 12 },
      anchor: { kind: "page-bottom" }, repeat: false, style: { size: 8, bold: false, align: "left" },
    } as const;
    const layout = { ...standardLayout(), items: [...standardLayout().items, sig] };
    const res = await preview({ ...cfgOf("TRAVELER"), layout }, { recordId: order.id });
    expect(res.status).toBe(200);
    const measure = measureOf(res);
    const entry = measure.items.find((item) => item.id === "sig")!;
    expect(entry).toMatchObject({ page: measure.pages, left: 24, top: 700 });
    // One 8 pt line.
    expect(entry.height).toBeGreaterThan(0);
    expect(entry.height).toBeLessThan(12);
  });

  it("a boxed item measures the box its wrapper was placed at: its bottom is its end mark's, below a table and page-top alike (Ruling 7)", async () => {
    const order = await orderWithLoads(1);
    // The standard layout with the Tested by box moved page-top, into the free room under the logo.
    const layout = {
      ...standardLayout(),
      items: standardLayout().items.map((item): CanvasItem => (item.id === "field-tested_by"
        ? { ...item, anchor: { kind: "page-top" }, box: { x: 24, y: 100, w: 90, h: 12 } } : item)),
    };
    const config = { ...cfgOf("TRAVELER"), layout };
    const res = await preview(config, { recordId: order.id });
    expect(res.status).toBe(200);
    const measure = measureOf(res);

    // The end marks, read from the same first sheet laid out as the preview lays it: the sheet for a
    // page-top item, the Steps region's alone page for a below-table one.
    const settings = await travelerSettings();
    const data = await prisma.$transaction((tx) => readTravelerData(tx, order.id, settings, 1));
    const sheet = await renderSheetGroupsWithPositions(buildTravelerDefinitions(data, config));
    const alone = aloneLayouts({
      layout, pageFooter: config.pageFooter, fonts: config.fonts, itemContent: travelerCanvasItemContent(data, config),
    });
    const steps = alone.findIndex((a) => a.after === "steps");
    const laid = await renderSheetGroupsWithPositions([alone[steps].def]);
    const endIn = (positions: { id: string; top: number }[], id: string) =>
      positions.find((node) => node.id === CANVAS_IDS.itemEnd(id))!.top;

    // Below Steps: the Results box, drawn 12 tall, its cell grown by its 8 pt label; measured from its
    // placed offset (8), so its bottom is the end mark's, carried onto the region.
    const region = measure.regions.find((r) => r.after === "steps")!;
    const results = measure.items.find((item) => item.id === "field-results")!;
    expect(results.height).toBeGreaterThanOrEqual(12 - 0.5);
    expect(results.top + results.height).toBeCloseTo(region.top + endIn(laid.groups[0].positions, "field-results"), 2);

    // Page-top: the Tested by box at its stored place, its bottom the sheet's end mark.
    const tested = measure.items.find((item) => item.id === "field-tested_by")!;
    expect(tested).toMatchObject({ page: 1, left: 24, top: 100 });
    expect(tested.height).toBeGreaterThanOrEqual(12 - 0.5);
    expect(tested.top + tested.height).toBeCloseTo(endIn(sheet.groups[0].positions, "field-tested_by"), 2);
  });

  it("with All loads the measure is the first group's: one sheet's page count, not the document's", async () => {
    const order = await orderWithLoads(3);
    const all = await preview(canvasCfg(), { recordId: order.id, allLoads: true });
    expect(all.status).toBe(200);
    expect(pageCount(await pdfOf(all))).toBe(3);
    const measure = measureOf(all);
    expect(measure.pages).toBe(1);
    // The first load's sheet, laid out alone, measures the same.
    expect(measure).toEqual(measureOf(await preview(canvasCfg(), { recordId: order.id })));
  });
});

// The canvas shipping ticket's measure (PR 2a of the ticket lane, task 5; the ticket design §5.2): a
// canvas SHIPPER or MOS_SHIPPER preview answers where it laid the first ticket's five tables,
// regions and items out, from the real shipment (no seed ids, no placeholder serial line).
describe("POST /api/templates/[id]/preview — a canvas shipping ticket answers X-Preview-Measure", () => {
  /** A shipment with one order per entry of `lineCounts`, each holding that many order lines (each
   *  its own part, so its Part lines table is that many rows tall), shipped whole; the first order
   *  carries one flagged serial when `serial` is true. */
  async function shipment(lineCounts: number[], serial: boolean) {
    seq += 1;
    const customer = await prisma.customer.create({ data: { code: `TKV${seq}`, name: `Ticket Preview Co ${seq}` } });
    const shipped = [];
    for (const [i, lineCount] of lineCounts.entries()) {
      const lines: { partId: string; qty: number; weight: string }[] = [];
      for (let n = 0; n < lineCount; n++) {
        seq += 1;
        const part = await prisma.part.create({
          data: { customerId: customer.id, partNumber: `TKV-${seq}`, name: "Ticket Part", eachWeight: "2.0000" },
        });
        const code = await prisma.processStepCode.create({ data: { code: `TKC${seq}`, name: "Austemper" } });
        const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
        await prisma.partProcessStep.create({ data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austemper." } });
        lines.push({ partId: part.id, qty: 10, weight: "20.00" });
      }
      seq += 1;
      const { order } = await asSystem(() => createOrder({ customerId: customer.id, poNumber: `TK${seq}`, lines }));
      const orderSerial = serial && i === 0
        ? await prisma.orderSerial.create({ data: { orderId: order.id, lineId: order.lines[0].id, position: 1, serial: `SN-${seq}`, description: "Heat A1" } })
        : null;
      shipped.push({
        orderId: order.id,
        lines: order.lines.map((line) => ({ orderLineId: line.id, qty: line.qty, weight: line.weight, lineComplete: true })),
        containers: [],
        serials: orderSerial === null ? [] : [{ orderSerialId: orderSerial.id, printOnShipper: true }],
      });
    }
    const { shipper } = await createShipper({ customerId: customer.id, shipDate: "2026-07-29", orders: shipped }, { canOverrideCreditHold: false });
    return shipper;
  }
  const canvasCfg = (docType: "SHIPPER" | "MOS_SHIPPER") => ({ ...cfgOf(docType), layout: standardTicketLayout() });
  const preview = async (docType: "SHIPPER" | "MOS_SHIPPER", config: unknown, recordId: string) => {
    const tpl = await draftTemplate(docType);
    return previewRoute(previewReq(tpl.id, full, { config, recordId }), withParams({ id: tpl.id }));
  };
  const measureOf = (res: Response): CanvasMeasure =>
    JSON.parse(decodeURIComponent(res.headers.get("X-Preview-Measure")!)) as CanvasMeasure;
  const regionOf = (m: CanvasMeasure, key: string) => m.regions.find((r) => r.after === key)!;

  it("a canvas SHIPPER preview carries the five tables in y order, their regions, the page-top fields and the strip's items below the totals; a flow config's carries none", async () => {
    const shipper = await shipment([1], true);
    const layout = standardTicketLayout();
    const res = await preview("SHIPPER", canvasCfg("SHIPPER"), shipper.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const measure = measureOf(res);
    expect(measure.pages).toBe(1);
    expect(measure.tables.map((t) => t.key)).toEqual(["field_strip", "lines", "containers", "serials", "totals"]);
    const drawn = regionHeights(layout);
    for (const [i, table] of measure.tables.entries()) {
      expect(table.page).toBe(1);
      const region = measure.regions[i];
      expect(region).toMatchObject({ after: table.key, page: 1, height: drawn[i].height });
      expect(region.top).toBeCloseTo(table.top + table.height, 6);
      if (i > 0) expect(table.top).toBeCloseTo(measure.regions[i - 1].top + measure.regions[i - 1].height, 6);
    }
    expect(measure.regions.every((region) => region.height > 0)).toBe(true);

    // A page-top field at its stored box.
    const orderNo = layout.items.find((item) => item.id === "field-order_no")!.box;
    expect(measure.items.find((item) => item.id === "field-order_no")).toMatchObject({ page: 1, left: orderNo.x, top: orderNo.y });

    // The strip's items hang under the totals region, each at its stored offset with a height.
    const totals = regionOf(measure, "totals");
    const stripFields = layout.items.filter((item) => item.kind === "field" && item.anchor.kind === "below-table" && item.anchor.table === "totals");
    expect(stripFields.length).toBeGreaterThan(0);
    for (const item of stripFields) {
      const entry = measure.items.find((candidate) => candidate.id === item.id);
      expect(entry, item.id).toBeDefined();
      expect(entry!.page).toBe(totals.page);
      expect(entry!.top).toBeCloseTo(totals.top + item.box.y, 2);
      expect(entry!.height, item.id).toBeGreaterThan(0);
    }

    const flow = await preview("SHIPPER", cfgOf("SHIPPER"), shipper.id);
    expect(flow.status).toBe(200);
    expect(flow.headers.get("X-Preview-Measure")).toBeNull();
    expect(pageCount(await pdfOf(flow))).toBe(1);
  });

  it("a MOS_SHIPPER two-order shipment's measure is its first ticket's: equal to a one-order shipment of the first order's shape, and unlike one of the second order's (whose Part lines table is taller)", async () => {
    const two = await shipment([1, 3], false);
    const firstShape = await shipment([1], false);
    const secondShape = await shipment([3], false);
    const res = await preview("MOS_SHIPPER", canvasCfg("MOS_SHIPPER"), two.id);
    expect(res.status).toBe(200);
    expect(pageCount(await pdfOf(res))).toBe(2);
    const measure = measureOf(res);
    expect(measure.pages).toBe(1);
    expect(measure.tables).toHaveLength(5);
    expect(measure).toEqual(measureOf(await preview("MOS_SHIPPER", canvasCfg("MOS_SHIPPER"), firstShape.id)));
    expect(measure).not.toEqual(measureOf(await preview("MOS_SHIPPER", canvasCfg("MOS_SHIPPER"), secondShape.id)));
  });

  it("a shipment with no flagged serial measures the serial list 0 tall, and the totals follow it directly (the preview adds no placeholder line)", async () => {
    const shipper = await shipment([1], false);
    const measure = measureOf(await preview("SHIPPER", canvasCfg("SHIPPER"), shipper.id));
    const serials = measure.tables.find((t) => t.key === "serials")!;
    expect(serials.height).toBe(0);
    const totals = measure.tables.find((t) => t.key === "totals")!;
    const serialRegion = regionOf(measure, "serials");
    expect(totals.top).toBeCloseTo(serialRegion.top + serialRegion.height, 6);
  });
});

// The canvas bill of lading's measure (BOL canvas PR 2, Task 6; the BOL design §5.3): a canvas BOL
// preview answers where it laid the one sheet's three blocks, their regions and every item out, from
// the real shipment (no seed ids, no placeholder PO line); a flow BOL answers none and prints as before.
describe("POST /api/templates/[id]/preview — a canvas bill of lading answers X-Preview-Measure", () => {
  /** A one-order shipment, freight COLLECT, with a carrier, a pro number, a SCAC code and a PO. */
  async function bolShipment() {
    seq += 1;
    const customer = await prisma.customer.create({ data: { code: `BLV${seq}`, name: `BOL Preview Co ${seq}` } });
    const carrier = await prisma.carrier.create({ data: { name: `Preview Truck ${seq}` } });
    const part = await prisma.part.create({
      data: { customerId: customer.id, partNumber: `BLV-${seq}`, name: "BOL Part", eachWeight: "2.0000" },
    });
    const code = await prisma.processStepCode.create({ data: { code: `BLC${seq}`, name: "Austemper" } });
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    await prisma.partProcessStep.create({ data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austemper." } });
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: `BL${seq}`, lines: [{ partId: part.id, qty: 10, weight: "20.00" }],
    }));
    const { shipper } = await asSystem(() => createShipper({
      customerId: customer.id, shipDate: "2026-07-29", carrierId: carrier.id, freightTerms: "COLLECT",
      proNumber: "PRO-77", scacCode: "GFMC", freightDescription: "Castings", freightClass: "70",
      orders: [{
        orderId: order.id,
        lines: [{ orderLineId: order.lines[0].id, qty: 10, weight: "20.00", lineComplete: true }],
        containers: [], serials: [],
      }],
    }, { canOverrideCreditHold: false }));
    return shipper;
  }
  const bolCfg = (): TemplateConfig => structuredClone(BOL_DEFAULT_CONFIG);
  const canvasCfg = () => ({ ...bolCfg(), layout: standardBolLayout() });
  const preview = async (config: unknown, recordId: string) => {
    const tpl = await draftTemplate("BOL");
    return previewRoute(previewReq(tpl.id, full, { config, recordId }), withParams({ id: tpl.id }));
  };
  const measureOf = (res: Response): CanvasMeasure =>
    JSON.parse(decodeURIComponent(res.headers.get("X-Preview-Measure")!)) as CanvasMeasure;

  it("a canvas BOL preview carries the three blocks in y order, their regions, and every item with a height, the items below the PO block among them", async () => {
    const shipper = await bolShipment();
    const layout = standardBolLayout();
    const res = await preview(canvasCfg(), shipper.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const measure = measureOf(res);
    expect(measure.pages).toBe(1);
    expect(measure.tables.map((t) => t.key)).toEqual(["consignee_ref", "trv", "freight"]);
    const drawn = regionHeights(layout);
    for (const [i, table] of measure.tables.entries()) {
      expect(table.page).toBe(1);
      expect(table.height).toBeGreaterThan(0);
      const region = measure.regions[i];
      expect(region).toMatchObject({ after: table.key, page: 1, height: drawn[i].height });
      expect(region.top).toBeCloseTo(table.top + table.height, 6);
      if (i > 0) expect(table.top).toBeCloseTo(measure.regions[i - 1].top + measure.regions[i - 1].height, 6);
    }

    // Every item the layout holds, a block excepted, is measured with a height: page-top at its
    // stored box, below a block at its region's top plus its stored offset.
    const items = layout.items.filter((item) => item.kind !== "table");
    for (const item of items) {
      const entry = measure.items.find((candidate) => candidate.id === item.id);
      expect(entry, item.id).toBeDefined();
      expect(entry!.height, item.id).toBeGreaterThan(0);
      if (item.anchor.kind === "page-top") {
        expect(entry, item.id).toMatchObject({ page: 1, left: item.box.x, top: item.box.y });
      } else if (item.anchor.kind === "below-table") {
        const table = item.anchor.table;
        const region = measure.regions.find((r) => r.after === table)!;
        expect(entry!.page, item.id).toBe(region.page);
        expect(entry!.top, item.id).toBeCloseTo(region.top + item.box.y, 2);
      }
    }
    const belowRef = items.filter((item) => item.anchor.kind === "below-table" && item.anchor.table === "consignee_ref");
    expect(belowRef.map((item) => item.id)).toEqual(expect.arrayContaining(["field-scac_code", "field-carrier_name", "field-consigned_to"]));
  });

  it("a flow BOL preview answers no measure, and its text is today's flow render of the same shipment", async () => {
    const shipper = await bolShipment();
    const res = await preview(bolCfg(), shipper.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Preview-Measure")).toBeNull();
    const data = await prisma.$transaction(async (tx) =>
      readBolData(tx, shipper.id, shipper.shipperNumber, await bolSettings()));
    const today = await renderPdf(buildBolDefinition(data, bolCfg()));
    expect(textRunsWithY(await pdfOf(res))).toEqual(textRunsWithY(today));
  });

  it("a canvas BOL preview allocates nothing: the shipment's BOL number stays null, the counter row and the stored documents unchanged", async () => {
    const shipper = await bolShipment();
    const counter = () => prisma.setting.findUnique({ where: { key: "bol_number_next" } });
    const before = { counter: await counter(), documents: await prisma.storedDocument.count() };
    const res = await preview(canvasCfg(), shipper.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Preview-Measure")).not.toBeNull();
    expect((await prisma.shipper.findUniqueOrThrow({ where: { id: shipper.id } })).bolNumber).toBeNull();
    expect({ counter: await counter(), documents: await prisma.storedDocument.count() }).toEqual(before);
  });
});

// The canvas certification's measure (cert canvas PR 2, Task 6; the cert design §5.3, §7): a canvas
// CERT preview answers where it laid the seven blocks, their regions and every item out, the band's
// two strip items from the band's alone render; a flow CERT answers none and prints as before.
describe("POST /api/templates/[id]/preview — a canvas certification answers X-Preview-Measure", () => {
  const certCfg = (): TemplateConfig => cfgOf("CERT");
  const canvasCfg = () => ({ ...certCfg(), layout: standardCertLayout() });
  const preview = async (config: unknown, recordId: string) => {
    const tpl = await draftTemplate("CERT");
    return previewRoute(previewReq(tpl.id, full, { config, recordId }), withParams({ id: tpl.id }));
  };
  const measureOf = (res: Response): CanvasMeasure =>
    JSON.parse(decodeURIComponent(res.headers.get("X-Preview-Measure")!)) as CanvasMeasure;

  it("a canvas certification preview carries the seven blocks in y order, their regions, and every item with a height: the parties' rule and the band's two strip items among them", async () => {
    const { cert } = await certFixture();
    // A serial and freeform text, so every one of the seven blocks prints something.
    const order = await prisma.order.findUniqueOrThrow({ where: { id: cert.orderId }, include: { lines: true } });
    await prisma.orderSerial.create({
      data: { orderId: order.id, lineId: order.lines[0].id, position: 1, serial: "SN-1", description: "Heat 1" },
    });
    await asSystem(() => updateCert(cert.id, { freeform: "Freeform under the preview." }));
    const layout = standardCertLayout();
    const res = await preview(canvasCfg(), cert.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const measure = measureOf(res);
    expect(pageCount(await pdfOf(res))).toBe(1);
    expect(measure.pages).toBe(1);
    expect(measure.tables.map((t) => t.key)).toEqual(["to", "parts", "statement", "requirements", "serials", "freeform", "signature"]);
    const drawn = regionHeights(layout);
    for (const [i, table] of measure.tables.entries()) {
      expect(table.page).toBe(1);
      expect(table.height, table.key).toBeGreaterThan(0);
      const region = measure.regions[i];
      expect(region).toMatchObject({ after: table.key, page: 1, height: drawn[i].height });
      expect(region.top).toBeCloseTo(table.top + table.height, 6);
      if (i > 0) expect(table.top).toBeCloseTo(measure.regions[i - 1].top + measure.regions[i - 1].height, 6);
    }

    // Every item the layout holds, a block excepted, is measured: page-top at its stored box, below
    // a block at its region's top plus its stored offset, in the band at its stored box.
    const items = layout.items.filter((item) => item.kind !== "table");
    for (const item of items) {
      const entry = measure.items.find((candidate) => candidate.id === item.id);
      expect(entry, item.id).toBeDefined();
      // Every item but the 0-tall parties' rule prints something with a height.
      if (item.kind !== "line") expect(entry!.height, item.id).toBeGreaterThan(0);
      if (item.anchor.kind === "below-table") {
        const table = item.anchor.table;
        const region = measure.regions.find((r) => r.after === table)!;
        expect(entry!.page, item.id).toBe(region.page);
        expect(entry!.top, item.id).toBeCloseTo(region.top + item.box.y, 2);
      } else {
        expect(entry, item.id).toMatchObject({ page: 1, left: item.box.x, top: item.box.y });
      }
    }
    // The parties' rule rides the To block; the strip's two items are each one small-size line, as
    // the band's alone render laid them out.
    // The rule is a 0-tall line (its drawn `h`), and is measured 0 tall.
    expect(measure.items.find((item) => item.id === "parties-rule")!.height).toBe(0);
    const small = certCfg().fonts.smallSize;
    for (const id of ["field-footer_address", "field-footer_phone"]) {
      const entry = measure.items.find((item) => item.id === id)!;
      expect(entry.height, id).toBeGreaterThan(small);
      expect(entry.height, id).toBeLessThan(2 * small);
    }
  });

  it("a flow certification preview answers no measure, and its text is today's flow render of the same cert", async () => {
    const { cert } = await certFixture();
    const res = await preview(certCfg(), cert.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Preview-Measure")).toBeNull();
    const signer = await prisma.user.findFirstOrThrow({ where: { username: "pfull" } });
    const settings = await certPrintSettings();
    const { data } = await prisma.$transaction((tx) => readCertPdfData(tx, cert.id,
      { ...settings, statement: certCfg().textBlocks.cert_statement }, signer, formatDateOnly(todayDateOnly())));
    const today = await renderPdf(buildCertDefinition(data, certCfg()));
    expect(textRunsWithY(await pdfOf(res))).toEqual(textRunsWithY(today));
  });

  it("a canvas certification preview stamps no printedAt and stores nothing", async () => {
    const { cert } = await certFixture();
    const before = await prisma.storedDocument.count();
    const res = await preview(canvasCfg(), cert.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Preview-Measure")).not.toBeNull();
    expect((await prisma.cert.findUniqueOrThrow({ where: { id: cert.id } })).printedAt).toBeNull();
    expect(await prisma.storedDocument.count()).toBe(before);
  });
});

describe("the preview's alone pages lay out positions alone", () => {
  it("measuredPreview's alone block calls layOutSheetGroups, and the module's one renderSheetGroupsWithPositions call is the paper's", () => {
    const source = readFileSync(new URL("../src/server/template-preview.ts", import.meta.url), "utf8");
    expect(source.match(/renderSheetGroupsWithPositions\(/g) ?? []).toHaveLength(1);
    expect(source).toMatch(/layOutSheetGroups\(\s*alone\.map\(/);
    expect(source.slice(source.indexOf("async function measuredPreview"))).toMatch(
      /renderSheetGroupsWithPositions\(defs\)[\s\S]*layOutSheetGroups\(/);
  });
});

describe("POST /api/templates/[id]/preview — a canvas quotation answers X-Preview-Measure", () => {
  // The route reaches `renderPreview`'s QUOTE arm, `renderQuoteCanvasPreview` whole, since quote canvas
  // PR 2 put QUOTE in CANVAS_PRINTS (design 2026-11-12 §4.6, §5.1). Made a bare `renderPdf` of the
  // flow definition, the arm answers no X-Preview-Measure, and the measure case reds; with "QUOTE" out
  // of CANVAS_PRINTS the canvas config is refused, a 400 in the later-release sentence.
  const BLOCKS = ["parties", "intro", "column_header", "lines", "closing", "liability"];
  const measureOf = (res: Response): CanvasMeasure =>
    JSON.parse(decodeURIComponent(res.headers.get("X-Preview-Measure")!)) as CanvasMeasure;

  /** One live quote, tests/quote-pdf.test.ts's `sampleFixture` in miniature: a customer, a quoted-by
   *  user and one free-text line with no price rows. */
  async function previewQuote() {
    seq += 1;
    const customer = await prisma.customer.create({ data: { code: `QPV${seq}`, name: `Quote Preview Co ${seq}` } });
    const quotedBy = await prisma.user.create({
      data: { username: `qpv${seq}`, displayName: "Quote Preview Seller", passwordHash: "x", title: "Sales" },
    });
    return asSystem(() => createQuote({
      customerId: customer.id, quotedById: quotedBy.id,
      lines: [{ partNumberText: "QPV-1", partNameText: "Preview part", quotedQty: 10, prices: [] }],
    }));
  }

  it("a canvas quotation preview carries the six blocks in y order, one region a block, the measure the arm's own, and stores and audits nothing", async () => {
    const quote = await previewQuote();
    const tpl = await draftTemplate("QUOTE");
    const layout = standardQuoteLayout();
    const config = { ...cfgOf("QUOTE"), layout };
    const stored = await prisma.storedDocument.count();
    const audits = await prisma.auditLog.count();
    const before = await prisma.documentTemplateVersion.findFirstOrThrow({ where: { templateId: tpl.id, status: "DRAFT" } });
    const res = await previewRoute(previewReq(tpl.id, full, { recordId: quote.id, config }), withParams({ id: tpl.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("X-Preview-Measure")).not.toBeNull();
    const measure = measureOf(res);
    const pdf = await pdfOf(res);
    expect(pageCount(pdf)).toBe(1);
    expect(measure.pages).toBe(1);
    expect(measure.tables.map((t) => t.key)).toEqual(BLOCKS);
    expect(measure.regions).toHaveLength(BLOCKS.length);
    // The arm's own measure: the same data (the preview's read, its two wordings the config's) previewed directly.
    const validated = validateConfig("QUOTE", config);
    const settings = await quotePrintSettings();
    const data = await prisma.$transaction((tx) => readQuotePdfData(tx, quote.id, {
      ...settings,
      introText: validated.textBlocks.quote_intro_text,
      liabilityText: validated.textBlocks.quote_liability_text,
    }));
    expect(measure).toEqual((await renderQuoteCanvasPreview(data, validated, undefined)).measure);
    // Nothing written: no document, no audit row, no draft edit.
    expect(await prisma.storedDocument.count()).toBe(stored);
    expect(await prisma.auditLog.count()).toBe(audits);
    const after = await prisma.documentTemplateVersion.findFirstOrThrow({ where: { templateId: tpl.id, status: "DRAFT" } });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  }, 60_000);

  // (pin) No mutation of the route or the gate reds it: the arm's flow half is
  // `renderQuoteCanvasPreview`'s null-layout branch, which tests/quote-canvas-seed.test.ts's own pin holds.
  it("a flow quotation's preview answers no X-Preview-Measure, storing nothing (pin)", async () => {
    const quote = await previewQuote();
    const tpl = await draftTemplate("QUOTE");
    const stored = await prisma.storedDocument.count();
    const res = await previewRoute(previewReq(tpl.id, full, { recordId: quote.id, config: cfgOf("QUOTE") }), withParams({ id: tpl.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("X-Preview-Measure")).toBeNull();
    expect(await prisma.storedDocument.count()).toBe(stored);
  });

  // Green on arrival; red under the route's second `mustCan` deleted (run). The nothing-written half
  // is a pin.
  it("a canvas quotation preview without quotes.view is 403, storing and auditing nothing", async () => {
    const quote = await previewQuote();
    const tpl = await draftTemplate("QUOTE");
    const noQuotes = await signInWith(
      ["templates.view", "orders.view", "shipping.view", "certs.view", "invoicing.view", "receivables.view"], "pnoquote");
    const stored = await prisma.storedDocument.count();
    const audits = await prisma.auditLog.count();
    const res = await previewRoute(previewReq(tpl.id, noQuotes, {
      recordId: quote.id, config: { ...cfgOf("QUOTE"), layout: standardQuoteLayout() },
    }), withParams({ id: tpl.id }));
    expect(res.status).toBe(403);
    expect(await prisma.storedDocument.count()).toBe(stored);
    expect(await prisma.auditLog.count()).toBe(audits);
  });
});
