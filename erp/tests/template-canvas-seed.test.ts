import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs, templateId } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import {
  alphaPng, drawnText, pageCount, pageStreams, pagesInOrder, paintedImageCounts, parseObjects, runFonts, strokedLines, textLinesWithY, textRunsWithY,
  type StrokedLine,
} from "./helpers/pdf";
import { runWithContext } from "@/server/context";
import { createOrder, type OrderDetail } from "@/server/orders";
import {
  bolSettings, createShipper, printBol, printShippingTickets, readBolData, readShippingTicketData, reverseShipper, ticketSettings,
} from "@/server/shippers";
import { BOL_SEED_IDS, BOL_WIDTHS, buildBolDefinition } from "@/server/pdf/bol";
import { bolRepeatShift, seedBolItems, withRepeat as withBolRepeat } from "@/server/bol-canvas-seed";
import { seedCertItems, seedCertLayout, withRepeat } from "@/server/cert-canvas-seed";
import { HttpError } from "@/server/errors";
import { buildShippingTicketDefinitions, type TicketDocType } from "@/server/pdf/shipping-ticket";
import { createTemplate, editDraft, publishDraft, uploadLogo } from "@/server/templates";
import { assignTemplate } from "@/server/template-assignments";
import { LAYOUT, TABLE_LAYOUTS, barcodePng, pngDataUri, renderPdf, renderSheetGroupsWithPositions, type LaidOutNode } from "@/server/pdf/render";
import { buildTravelerDefinitions, printTraveler, readTravelerData, travelerSettings } from "@/server/traveler";
import { readPreviewContext, renderInvoiceCanvasPreview, renderPreview } from "@/server/template-preview";
import { BOXED, seedCanvasLayout } from "@/server/template-canvas-seed";
import { POST as seedRoute } from "@/app/api/templates/[id]/draft/canvas/route";
import { certPrintSettings, createCert, printCert, readCertPdfData, updateCert } from "@/server/certs";
import { replaceReadings } from "@/server/cert-results";
import { CERT_FLOW, CERT_PAGE, CERT_SEED_IDS, CERT_WIDTHS, buildCertDefinition } from "@/server/pdf/cert";
import { mark } from "@/server/pdf/canvas-nodes";
import { getSetting, setSetting } from "@/server/settings";
import { CERT_CONTRACT } from "@/lib/template-contracts/cert";
import {
  BOL_DEFAULT_CONFIG, CERT_DEFAULT_CONFIG, INVOICE_DEFAULT_CONFIG, defaultConfigFor, MOS_SHIPPER_DEFAULT_CONFIG, QUOTE_DEFAULT_CONFIG, SHIPPER_DEFAULT_CONFIG, STATEMENT_DEFAULT_CONFIG, TRAVELER_DEFAULT_CONFIG, validateConfig,
  type TemplateConfig, type TemplateContract,
} from "@/lib/template-contracts/index";
import { BOL_CONTRACT } from "@/lib/template-contracts/bol";
import { DEFAULT_LOGO_WIDTH, canvasSaveBlock } from "@/lib/template-editor";
import { CONTENT_WIDTH, FONT_FAMILIES, type FontFamily } from "@/lib/template-contracts/types";
import { TRAVELER_CONTRACT } from "@/lib/template-contracts/traveler";
import { SHIPPER_CONTRACT } from "@/lib/template-contracts/shipper";
import { MOS_SHIPPER_CONTRACT } from "@/lib/template-contracts/mos-shipper";
import {
  CANVAS_GRID, CANVAS_PAGE, CONTINUED_FONT_SIZE, CONTINUED_WIDTH, canvasLayoutSchema, type CanvasItem, type CanvasLayout,
} from "@/lib/template-contracts/canvas";
import { bandTop, canvasProfile, canvasRefusal, canvasWarnings, drawnBox, leastWidth, pageFoot, tablesByY, validateCanvasLayout } from "@/lib/template-canvas";
import { dragStart, stageBox } from "@/lib/canvas-designer";
import type { Customer } from "../prisma/generated/prisma/client";
import { sampleBol } from "./helpers/bol-canvas-fixtures";
import { trvLines, trvListRuns, wrappedRuns } from "./helpers/trv-list";
import { CANVAS_IDS } from "@/server/pdf/canvas-sheet";
import { TEXT_TOLERANCE, fontOf } from "./helpers/keep-in-box-cases";
import { textWidthOf } from "@/lib/tag-font-metrics";
import { namedWarnings } from "./helpers/named-warnings";
import { sampleCert } from "./helpers/cert-canvas-fixtures";
import { TEST_DOC_TYPE, withTestContract } from "./helpers/test-contract";
import { INVOICE_STAND_IN, invoiceStandIn, invoiceStrip, seedInvoiceItems, seedInvoiceLayout } from "@/server/invoice-canvas-seed";
import { INVOICE_PAGE, INVOICE_SEED_IDS, INVOICE_WIDTHS, buildInvoiceDefinition, type InvoicePdfData } from "@/server/pdf/invoice";
import { createCredit, createInvoice, finalizeInvoice, invoicePrintSettings, readInvoicePdfData } from "@/server/invoices";
import { addPartPrice } from "@/server/part-prices";
import { nextFilingTicket } from "@/server/customer-folders";
import { INVOICE_CONTRACT } from "@/lib/template-contracts/invoice";
import { STATEMENT_CONTRACT } from "@/lib/template-contracts/statement";
import { TemplateConfigError } from "@/lib/template-contracts/types";
import { topMargin } from "@/lib/template-canvas";
import { gridDiffers, withRepeat as withInvoiceRepeat } from "@/server/invoice-canvas-seed";
import { makeBillTo, makeCustomer as makeQuoteCustomer, quoteFor } from "./helpers/quote-print-fixtures";

/**
 * The canvas SEED (design 2026-11-07 §5.4, ruling 5; PR B of #926, task 7): a traveler draft's
 * canvas starts from today's paper. `seedCanvasLayout` lays the flow config out once for the picked
 * order and answers a `CanvasLayout`; its acceptance is the golden case, which prints the same order
 * under the flow config and under a template holding the seeded layout and compares the two papers
 * line by line and stroke by stroke.
 */

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

/** The LETTER page's height: the PDF readers report a text baseline from the page's BOTTOM edge. */
const PAGE_HEIGHT = 792;

const cfg = (): TemplateConfig => structuredClone(TRAVELER_DEFAULT_CONFIG);
const fieldOf = (c: TemplateConfig, section: string, key: string) =>
  c.sections.find((s) => s.key === section)!.fields.find((f) => f.key === key)!;

let seq = 0;
/** A real order whose header prints every piece: a customer with a phone and a received-from
 *  address, a PO, a part with a process name, one step. `loadQty` splits it (10 pieces). */
async function seededOrder(options: { loadQty?: number; street?: string; steps?: number } = {}) {
  seq += 1;
  const customer = await prisma.customer.create({
    data: { code: `SEED${seq}`, name: "Seed Castings Group", phone: "256-555-0199" },
  });
  await prisma.customerAddress.create({
    data: {
      customerId: customer.id, kind: "RECEIVED_FROM", isDefault: true,
      street: options.street ?? "200 Demo Drive", city: "Anniston", state: "AL", zip: "36206",
    },
  });
  const code = await prisma.processStepCode.create({ data: { code: `AUS${seq}`, name: "Austemper" } });
  const part = await prisma.part.create({
    data: {
      customerId: customer.id, partNumber: `SEED-${seq}`, name: "Seed Part", processName: "Austemper",
      eachWeight: "1.0000", loadQty: options.loadQty ?? 100,
    },
  });
  const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  for (let position = 1; position <= (options.steps ?? 1); position++) {
    await prisma.partProcessStep.create({
      data: { revisionId: rev.id, position, codeId: code.id, instruction: position === 1 ? "Pre-heat, then quench." : `Step ${position}.` },
    });
  }
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, poNumber: "PO-4471",
    lines: [{ partId: part.id, qty: 10, weight: "10.00" }],
  }));
  return { customer, order };
}

/** A TRAVELER template whose v1 draft holds `config` (and the logo, when given). */
async function draftWith(config: TemplateConfig, logo?: Buffer) {
  seq += 1;
  const t = await asSystem(() => createTemplate("TRAVELER", `Seed ${seq}`));
  await asSystem(() => editDraft(t.id, { config, updatedAt: t.draft.updatedAt }));
  if (logo) await asSystem(() => uploadLogo(t.id, logo, "image/png"));
  return t;
}

/** Publishes `config` as a template, the logo with it, and assigns it to the customer. */
async function assigned(customerId: string, config: TemplateConfig, logo?: Buffer) {
  const t = await draftWith(config, logo);
  await asSystem(() => publishDraft(t.id));
  await asSystem(() => assignTemplate(customerId, "TRAVELER", t.id));
  return t;
}

/** The seed for `config`, as the editor of a draft holding it would ask for it. */
async function seed(orderId: string, config: TemplateConfig, logo?: Buffer): Promise<CanvasLayout> {
  const t = await draftWith(config, logo);
  return seedCanvasLayout(await readPreviewContext(t.id), { recordId: orderId, config }, "nobody");
}

/** A stroke page as the set of distinct straight strokes it inks: each stroke on its line (its axis,
 *  its y or x, its width), collinear strokes that touch or overlap merged into one. Two coincident
 *  strokes therefore count once, and a rule pdfmake draws as one segment per cell or per row reads
 *  the same as one an item draws whole. */
type Ink = { axis: "h" | "v"; at: number; from: number; to: number; width: number };
function inkOf(page: StrokedLine[]): Ink[] {
  const lines = new Map<string, Ink[]>();
  for (const s of page) {
    const axis = Math.abs(s.y1 - s.y2) < 0.01 ? "h" : Math.abs(s.x1 - s.x2) < 0.01 ? "v" : null;
    if (axis === null) throw new Error(`A diagonal stroke: ${JSON.stringify(s)}`);
    const at = axis === "h" ? s.y1 : s.x1;
    const [from, to] = axis === "h" ? [Math.min(s.x1, s.x2), Math.max(s.x1, s.x2)] : [Math.min(s.y1, s.y2), Math.max(s.y1, s.y2)];
    const key = `${axis}|${at.toFixed(1)}|${s.width.toFixed(2)}`;
    lines.set(key, [...(lines.get(key) ?? []), { axis, at, from, to, width: s.width }]);
  }
  const out: Ink[] = [];
  for (const strokes of lines.values()) {
    strokes.sort((a, b) => a.from - b.from);
    let cur = { ...strokes[0] };
    for (const s of strokes.slice(1)) {
      if (s.from <= cur.to + 0.05) cur.to = Math.max(cur.to, s.to);
      else { out.push(cur); cur = { ...s }; }
    }
    out.push(cur);
  }
  return out;
}

/** A printed line's text as the comparison reads it. The process row is the one line whose
 *  spacing differs: the flow prints each pair as a label cell and a value cell, which the reader
 *  joins with no space ("Process:Austemper"), and a canvas process field prints `label value` on one
 *  line (`fieldContent`, traveler-canvas.ts), so its spaces are set aside there and only there. */
const PROCESS_LABELS = ["Process:", "Material:", "Process ID:"];
const comparable = (text: string) => (PROCESS_LABELS.some((label) => text.includes(label)) ? text.replace(/\s+/g, "") : text);

/** The flow's and the canvas's papers, compared: the same pages; on each, the same printed lines
 *  in the reader's order, each within 2 pt of its flow y; the same distinct strokes, each end
 *  within 1 pt; the same image paints. */
function expectSamePaper(flow: Buffer, canvas: Buffer) {
  expect(pageCount(canvas)).toBe(pageCount(flow));
  const flowLines = textLinesWithY(flow);
  const canvasLines = textLinesWithY(canvas);
  flowLines.forEach((lines, page) => {
    expect(canvasLines[page].map((l) => comparable(l.text)), `page ${page + 1}'s lines`)
      .toEqual(lines.map((l) => comparable(l.text)));
    lines.forEach((line, i) => {
      expect(Math.abs(canvasLines[page][i].y - line.y), `page ${page + 1}, "${line.text}" at ${line.y}`).toBeLessThanOrEqual(2);
    });
  });
  const flowInk = strokedLines(flow).map(inkOf);
  const canvasInk = strokedLines(canvas).map(inkOf);
  flowInk.forEach((strokes, page) => {
    const left = [...canvasInk[page]];
    const missing: Ink[] = [];
    for (const s of strokes) {
      const i = left.findIndex((c) => c.axis === s.axis && Math.abs(c.width - s.width) < 0.01
        && Math.abs(c.at - s.at) <= 1 && Math.abs(c.from - s.from) <= 1 && Math.abs(c.to - s.to) <= 1);
      if (i === -1) missing.push(s);
      else left.splice(i, 1);
    }
    expect({ page: page + 1, missing, extra: left }).toEqual({ page: page + 1, missing: [], extra: [] });
  });
  expect(paintedImageCounts(canvas)).toEqual(paintedImageCounts(flow));
}

/** Prints the order under the customer's flow template (the Standard when `flowConfig` is
 *  omitted), then under a template holding the seeded layout, and compares the two papers. */
async function golden(customerId: string, orderId: string, layout: CanvasLayout, flowConfig?: TemplateConfig, logo?: Buffer) {
  if (flowConfig) await assigned(customerId, flowConfig, logo);
  const flow = await asSystem(() => printTraveler(orderId));
  await assigned(customerId, validateConfig("TRAVELER", { ...(flowConfig ?? cfg()), layout }), logo);
  const canvas = await asSystem(() => printTraveler(orderId));
  expectSamePaper(flow.pdf, canvas.pdf);
  return { flow: flow.pdf, canvas: canvas.pdf };
}

const fields = (layout: CanvasLayout) => layout.items.filter((i): i is Extract<CanvasItem, { kind: "field" }> => i.kind === "field");
const fieldItem = (layout: CanvasLayout, key: string) => fields(layout).find((i) => i.key === key);

/** The seed for `config` and the warnings the editor draws on it: the layout seeded for the record,
 *  previewed for the same record (`renderPreview`, whose measure is the Design tab's), and judged by
 *  `canvasWarnings` on that measure. */
async function seededPreviewWarnings(templateId: string, recordId: string, config: TemplateConfig, signerId = "nobody") {
  const ctx = await readPreviewContext(templateId);
  const layout = await seedCanvasLayout(ctx, { recordId, config }, signerId);
  const working = { ...config, layout };
  const { measure } = await renderPreview(ctx, { recordId, config: working }, signerId);
  expect(measure).not.toBeNull();
  const contract = ctx.docType === "TRAVELER" ? TRAVELER_CONTRACT : ctx.docType === "SHIPPER" ? SHIPPER_CONTRACT
    : ctx.docType === "BOL" ? BOL_CONTRACT : ctx.docType === "CERT" ? CERT_CONTRACT
    : ctx.docType === "INVOICE" ? INVOICE_CONTRACT : ctx.docType === "STATEMENT" ? STATEMENT_CONTRACT : MOS_SHIPPER_CONTRACT;
  const options = { pageFooter: working.pageFooter, fonts: working.fonts };
  return {
    layout,
    measure: measure!,
    measured: namedWarnings(layout, canvasWarnings(layout, contract, measure!, options)),
  };
}

beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

describe("seedCanvasLayout", () => {
  it("answers a layout validateCanvasLayout accepts, holding the barcode, the four tables stacked, the header fields placed, the footer below steps, repeat on order, load and barcode", async () => {
    const { order } = await seededOrder();
    const layout = await seed(order.id, cfg());

    expect(canvasLayoutSchema.parse(layout)).toEqual(layout);
    expect(() => validateCanvasLayout(layout, TRAVELER_CONTRACT, { pageFooter: false })).not.toThrow();
    expect(new Set(layout.items.map((i) => i.id)).size).toBe(layout.items.length);

    const barcodes = layout.items.filter((i) => i.kind === "barcode");
    expect(barcodes).toHaveLength(1);
    expect(barcodes[0].box).toMatchObject({ x: 398, w: 186, h: 44 });
    expect(barcodes[0].repeat).toBe(true);

    // The four tables, stacked top to bottom in the flow's order, each the content width wide, each
    // starting at or under the one above's bottom.
    const tables = tablesByY(layout);
    expect(tables.map((t) => t.key)).toEqual(["lines", "quantities", "inspections", "steps"]);
    for (const t of tables) expect(t.box).toMatchObject({ x: 24, w: 564 });
    tables.slice(1).forEach((t, i) => expect(t.box.y).toBeGreaterThanOrEqual(tables[i].box.y + tables[i].box.h));
    expect(tables[0].anchor).toEqual({ kind: "page-top" });
    expect(tables.slice(1).map((t) => t.anchor)).toEqual([
      { kind: "below-table", table: "lines" }, { kind: "below-table", table: "quantities" },
      { kind: "below-table", table: "inspections" },
    ]);

    // Every header piece the order prints, page-top, in the order the header draws them; the
    // order and load numbers repeat, nothing else in the header does.
    const header = fields(layout).filter((i) => i.anchor.kind === "page-top");
    expect(header.map((i) => i.key)).toEqual([
      "customer_name", "received_from", "customer_phone", "po_number",
      "company_name", "company_address", "company_phone", "order_number", "load_number",
    ]);
    expect(header.filter((i) => i.repeat).map((i) => i.key)).toEqual(["order_number", "load_number"]);
    expect(fieldItem(layout, "customer_name")!.style).toEqual({ size: 9.5, bold: true, align: "left" });
    expect(fieldItem(layout, "company_name")!.style).toEqual({ size: 12, bold: true, align: "center" });
    expect(fieldItem(layout, "order_number")!.box).toMatchObject({ x: 398, w: 146 });
    expect(fieldItem(layout, "load_number")!.box).toMatchObject({ x: 544, w: 44 });

    // The process pairs hang below the quantities table, the sign-off below the steps table, all of
    // it under the steps table's drawn bottom.
    expect(fields(layout).filter((i) => i.key.startsWith("process") || i.key === "material").map((i) => i.anchor))
      .toEqual(Array(3).fill({ kind: "below-table", table: "quantities" }));
    const footerKeys = ["results", "tempered_results", "final_inspection", "pass", "fail", "tested_by", "tested_date", "ok_to_ship", "ship_date"];
    const footer = fields(layout).filter((i) => footerKeys.includes(i.key));
    expect(footer.map((i) => i.key).sort()).toEqual([...footerKeys].sort());
    const steps = tables[3];
    for (const item of footer) {
      expect(item.anchor).toEqual({ kind: "below-table", table: "steps" });
      expect(drawnBox(item, layout).y).toBeGreaterThanOrEqual(steps.box.y + steps.box.h);
    }
    expect(layout.items.filter((i) => i.kind === "line").length).toBeGreaterThan(0);
  });

  it("composed: the seeded Standard, previewed for the same order, warns through the preview's measure of the Results/sign-off block's overlaps alone", async () => {
    // The Results box, the Notes / comments box, Final inspection, the Pass and Fail checkboxes,
    // Tested by, Tested date, OK to ship, the OK-to-ship date and four Lines, each with its
    // neighbours. No item is warned taller than its box (Ruling 17: the measure's heights differ
    // from the seed's thousandth-snapped ones by a figure that prints as 0 pt) and none past the
    // page.
    const { order } = await seededOrder();
    const t = await draftWith(cfg());
    const { measured } = await seededPreviewWarnings(t.id, order.id, cfg());
    expect(measured).toEqual([
      { items: ["results", "line 3"], sentence: "The Results box field and the Line (line 3) overlap; one prints over the other." },
      { items: ["tempered_results", "final_inspection"], sentence: "The Notes / comments box field and the Final inspection field overlap; one prints over the other." },
      { items: ["tempered_results", "line 4"], sentence: "The Notes / comments box field and the Line (line 4) overlap; one prints over the other." },
      { items: ["final_inspection", "pass"], sentence: "The Final inspection field and the Pass checkbox field overlap; one prints over the other." },
      { items: ["final_inspection", "fail"], sentence: "The Final inspection field and the Fail checkbox field overlap; one prints over the other." },
      { items: ["final_inspection", "line 5"], sentence: "The Final inspection field and the Line (line 5) overlap; one prints over the other." },
      { items: ["final_inspection", "line 6"], sentence: "The Final inspection field and the Line (line 6) overlap; one prints over the other." },
      { items: ["pass", "fail"], sentence: "The Pass checkbox field and the Fail checkbox field overlap; one prints over the other." },
      { items: ["pass", "tested_by"], sentence: "The Pass checkbox field and the Tested by field overlap; one prints over the other." },
      { items: ["pass", "tested_date"], sentence: "The Pass checkbox field and the Tested date field overlap; one prints over the other." },
      { items: ["pass", "line 5"], sentence: "The Pass checkbox field and the Line (line 5) overlap; one prints over the other." },
      { items: ["fail", "tested_by"], sentence: "The Fail checkbox field and the Tested by field overlap; one prints over the other." },
      { items: ["fail", "tested_date"], sentence: "The Fail checkbox field and the Tested date field overlap; one prints over the other." },
      { items: ["fail", "line 6"], sentence: "The Fail checkbox field and the Line (line 6) overlap; one prints over the other." },
      { items: ["tested_by", "tested_date"], sentence: "The Tested by field and the Tested date field overlap; one prints over the other." },
      { items: ["tested_by", "ok_to_ship"], sentence: "The Tested by field and the OK to ship field overlap; one prints over the other." },
      { items: ["tested_by", "ship_date"], sentence: "The Tested by field and the OK-to-ship date field overlap; one prints over the other." },
      { items: ["tested_by", "line 5"], sentence: "The Tested by field and the Line (line 5) overlap; one prints over the other." },
      { items: ["tested_date", "ok_to_ship"], sentence: "The Tested date field and the OK to ship field overlap; one prints over the other." },
      { items: ["tested_date", "ship_date"], sentence: "The Tested date field and the OK-to-ship date field overlap; one prints over the other." },
      { items: ["tested_date", "line 6"], sentence: "The Tested date field and the Line (line 6) overlap; one prints over the other." },
      { items: ["ok_to_ship", "ship_date"], sentence: "The OK to ship field and the OK-to-ship date field overlap; one prints over the other." },
    ]);
  });

  it("golden: the seeded canvas prints the flow template's lines in the same order, each within 2 pt where positions are read, and the same set of distinct strokes within 1 pt", async () => {
    const { customer, order } = await seededOrder();
    const layout = await seed(order.id, cfg());
    const { flow } = await golden(customer.id, order.id, layout);
    // The paper compared holds every piece the seed places: the header's, the tables', the process
    // pairs' and the sign-off's.
    const printed = textLinesWithY(flow)[0].map((l) => l.text).join("\n");
    for (const text of ["Seed Castings Group", "200 Demo Drive", "Ph: 256-555-0199", "PO: PO-4471", "PROCESS STEPS:", "RESULTS:", "OK to Ship:"]) {
      expect(printed).toContain(text);
    }
  });

  it("a typed label and a hidden field in the working config survive the seed", async () => {
    const { customer, order } = await seededOrder();
    const working = cfg();
    fieldOf(working, "header", "customer_phone").visible = false;
    fieldOf(working, "header", "po_number").label = "Cust PO#";
    // A hidden half of a sign-off row leaves its empty cell, borders and all, on the flow's paper,
    // which the seed draws as lines where no item stands.
    fieldOf(working, "footer", "fail").visible = false;
    fieldOf(working, "footer", "tested_by").visible = false;
    const layout = await seed(order.id, working);

    expect(fieldItem(layout, "customer_phone")).toBeUndefined();
    expect(fieldItem(layout, "fail")).toBeUndefined();
    expect(fieldItem(layout, "tested_by")).toBeUndefined();
    expect(fieldItem(layout, "po_number")!.label).toBe("Cust PO#");
    // The hidden phone's line is gone from the stack, so the PO sits where the phone would have.
    const flowSeed = await seed(order.id, cfg());
    expect(fieldItem(layout, "po_number")!.box.y).toBe(fieldItem(flowSeed, "customer_phone")!.box.y);
    const { canvas } = await golden(customer.id, order.id, layout, working);
    const printed = textLinesWithY(canvas)[0].map((l) => l.text).join("\n");
    expect(printed).toContain("Cust PO# PO-4471");
    expect(printed).not.toContain("256-555-0199");
  });

  it("a multi-load order seeds from its first load and prints every load the same", async () => {
    const { customer, order } = await seededOrder({ loadQty: 4 }); // 10 pieces: 4 / 4 / 2
    expect(order.loads.map((l) => l.loadNumber)).toEqual([1, 2, 3]);
    const layout = await seed(order.id, cfg());
    const { canvas } = await golden(customer.id, order.id, layout);
    expect(pageCount(canvas)).toBe(3);
    // Each sheet prints its own load's number under the one seeded load item.
    textLinesWithY(canvas).forEach((page, i) => {
      expect(page.some((line) => line.text.endsWith(`${order.orderNumber}${i + 1}`))).toBe(true);
    });
  });

  it("an order with no loads seeds the blank sheet", async () => {
    const { customer, order } = await seededOrder();
    await prisma.load.deleteMany({ where: { orderId: order.id } });
    const layout = await seed(order.id, cfg());
    // The blank sheet still prints the load's label and its dash, and the bare order-number barcode.
    expect(fieldItem(layout, "load_number")).toBeDefined();
    expect(layout.items.filter((i) => i.kind === "barcode")).toHaveLength(1);
    const { canvas } = await golden(customer.id, order.id, layout);
    expect(pageCount(canvas)).toBe(1);
    expect(textLinesWithY(canvas)[0].map((l) => l.text).join("\n")).toContain("—");
  });

  it("an order whose address wraps to five lines seeds taller header boxes and a layout the validator accepts", async () => {
    const { customer, order } = await seededOrder({ street: "Building 4\nDock 2\nAttn: Receiving\n1200 Industrial Parkway" });
    const layout = await seed(order.id, cfg());
    expect(() => validateCanvasLayout(layout, TRAVELER_CONTRACT, { pageFooter: false })).not.toThrow();

    const short = await seededOrder();
    const shortLayout = await seed(short.order.id, cfg());
    const received = fieldItem(layout, "received_from")!.box;
    const shortReceived = fieldItem(shortLayout, "received_from")!.box;
    // Five lines where the short address prints two, each 9.375 pt at the base size.
    expect(received.h).toBeCloseTo(shortReceived.h * 5 / 2, 3);
    // The left stack is now the header's tallest, so the lines table starts lower.
    expect(tablesByY(layout)[0].box.y).toBeGreaterThan(tablesByY(shortLayout)[0].box.y);
    expect(fieldItem(layout, "po_number")!.box.y).toBeGreaterThan(fieldItem(shortLayout, "po_number")!.box.y);
    await golden(customer.id, order.id, layout);
  });

  it("a placed logo seeds a logo item where the flow printed it, its height from the printed image", async () => {
    const { customer, order } = await seededOrder();
    const logo = await barcodePng("LOGO");
    const working = cfg();
    working.logo = { placement: "header-center", width: 120 };
    const layout = await seed(order.id, working, logo);
    const logos = layout.items.filter((i) => i.kind === "logo");
    expect(logos).toHaveLength(1);
    // Centred in the centre slot (211..388) at its configured width.
    expect(logos[0].box.x).toBeCloseTo(211 + (177 - 120) / 2, 3);
    expect(logos[0].box.w).toBe(120);
    const { flow, canvas } = await golden(customer.id, order.id, layout, working, logo);
    expect(paintedImageCounts(canvas)).toEqual([2]);
    const [flowImages, canvasImages] = [drawnImages(flow)[0], drawnImages(canvas)[0]];
    expect(canvasImages).toHaveLength(flowImages.length);
    for (const image of flowImages) {
      expect(canvasImages.some((c) => ["x", "y", "w", "h"].every((k) =>
        Math.abs(c[k as keyof typeof c] - image[k as keyof typeof image]) <= 1))).toBe(true);
    }
  });

  it("a sheet whose steps run onto a second page seeds the steps table to the page's foot and the sign-off below its rendered bottom", async () => {
    const { customer, order } = await seededOrder({ steps: 30 });
    const layout = await seed(order.id, cfg());
    expect(() => validateCanvasLayout(layout, TRAVELER_CONTRACT, { pageFooter: false })).not.toThrow();
    const steps = tablesByY(layout).at(-1)!;
    expect(steps.box.y + steps.box.h).toBe(768);
    // The sign-off hangs the flow's 6 pt under the steps table's rendered bottom, on page two.
    expect(Math.min(...fields(layout).filter((i) => i.anchor.kind === "below-table" && i.anchor.table === "steps")
      .map((i) => i.box.y))).toBeCloseTo(6, 3);
    await assigned(customer.id, validateConfig("TRAVELER", { ...cfg(), layout }));
    const { pdf } = await asSystem(() => printTraveler(order.id));
    const printed = textLinesWithY(pdf).flat().map((l) => l.text).join("\n");
    for (const text of ["Step 30.", "RESULTS:", "OK to Ship:"]) expect(printed).toContain(text);
  });

  it("a seeded two-page sheet prints \"(continued)\" on page 2 at the band's bottom-left, level with the barcode's bottom, never on a repeated item (Ruling 16)", async () => {
    const { customer, order } = await seededOrder({ steps: 30 });
    const layout = await seed(order.id, cfg());
    // Today's paper: the order and load numbers sit directly over the barcode in the header's right
    // slot, so the barcode is the lowest repeated item, and nothing of the left column repeats.
    const repeated = layout.items.filter((i) => i.kind !== "table" && i.repeat && i.anchor.kind === "page-top");
    expect(repeated.map((i) => (i.kind === "field" ? i.key : i.kind)).sort()).toEqual(["barcode", "load_number", "order_number"]);
    const barcodeItem = layout.items.find((i) => i.kind === "barcode")!;
    for (const item of repeated) {
      const box = drawnBox(item, layout);
      expect(box.y + box.h).toBeLessThanOrEqual(barcodeItem.box.y + barcodeItem.box.h);
    }
    await assigned(customer.id, validateConfig("TRAVELER", { ...cfg(), layout }));
    const { pdf } = await asSystem(() => printTraveler(order.id));
    expect(pageCount(pdf)).toBe(2);
    // The barcode on page 2, as drawn (top-down page coordinates), from its image's `cm` box.
    const images = drawnImages(pdf)[1];
    expect(images).toHaveLength(1);
    const image = images[0];
    expect(image.y).toBeCloseTo(barcodeItem.box.y, 1);
    // The "(continued)" run on page 2 alone: its x, and its baseline in top-down page coordinates.
    const runs = textRunsWithY(pdf).map((page) => page.filter((r) => r.text.includes("(continued)")));
    expect(runs.map((page) => page.length)).toEqual([0, 1]);
    const run = runs[1][0];
    const baseline = PAGE_HEIGHT - run.y;
    // The run's box: from Roboto's ascent above the baseline to its descent below it (1900 and 500
    // of 2048 units of the 8 pt size), as wide as the "(continued)" box at most (the reader carries
    // no width; the word, about 40 pt, prints inside its 60 pt box).
    const runBox = {
      x: run.x, y: baseline - (1900 / 2048) * CONTINUED_FONT_SIZE,
      w: CONTINUED_WIDTH, h: (2400 / 2048) * CONTINUED_FONT_SIZE,
    };
    const meets = (a: typeof runBox, b: typeof runBox) =>
      Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) && Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);
    // At the left margin, its bottom within 2 pt of the barcode's bottom.
    expect(run.x).toBeGreaterThanOrEqual(23);
    expect(run.x).toBeLessThanOrEqual(25);
    expect(Math.abs(runBox.y + runBox.h - (image.y + image.h))).toBeLessThanOrEqual(2);
    // Outside the barcode's printed image and every repeated item's drawn box.
    expect(meets(runBox, image)).toBe(false);
    for (const item of repeated) {
      expect(meets(runBox, drawnBox(item, layout)), `the run on the ${item.kind === "field" ? item.key : item.kind}`).toBe(false);
    }
  });

  it("the route: templates.edit alone is 403 without orders.view; the draft is not written", async () => {
    const { order } = await seededOrder();
    const traveler = await draftWith(cfg());
    const editOnly = await signInWith(["templates.edit"], "seed-edit");
    const both = await signInWith(["templates.edit", "orders.view", "certs.view"], "seed-both");
    const ordersOnly = await signInWith(["orders.view"], "seed-orders");

    const ask = (id: string, cookie: string, body: unknown) => seedRoute(new Request(`http://t/api/templates/${id}/draft/canvas`, {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
    }), { params: Promise.resolve({ id }) });
    const body = { recordId: order.id, config: cfg() };

    expect((await ask(traveler.id, "", body)).status).toBe(401);
    expect((await ask(traveler.id, editOnly, body)).status).toBe(403);
    expect((await ask(traveler.id, ordersOnly, body)).status).toBe(403);
    expect((await ask(traveler.id, both, { config: cfg() })).status).toBe(400); // a picked order is required

    const draft = () => prisma.documentTemplateVersion.findFirstOrThrow({ where: { templateId: traveler.id, status: "DRAFT" } });
    const before = await draft();
    const documents = await prisma.storedDocument.count();
    const audits = await prisma.auditLog.count();
    const res = await ask(traveler.id, both, body);
    expect(res.status).toBe(200);
    const layout = canvasLayoutSchema.parse(await res.json());
    expect(layout.items.some((i) => i.kind === "barcode")).toBe(true);
    const after = await draft();
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.config).toEqual(before.config);
    expect(await prisma.storedDocument.count()).toBe(documents);
    expect(await prisma.auditLog.count()).toBe(audits);
  });

  it("the flow renders no seed id unless asked: a print's definition carries none", async () => {
    const { order } = await seededOrder();
    const settings = await travelerSettings();
    const data = await prisma.$transaction((tx) => readTravelerData(tx, order.id, settings));
    const ids = (defs: unknown) => JSON.stringify(defs).match(/"seed:[^"]*"/g) ?? [];
    expect(ids(buildTravelerDefinitions(data, cfg()))).toEqual([]);
    expect(ids(buildTravelerDefinitions(data, cfg(), undefined, { seedIds: true })).length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------------------------------------
// The shipping ticket's seed (the shipping ticket design of 2026-11-08 §5.3; PR 2a, Task 4): a
// SHIPPER or MOS_SHIPPER draft's canvas starts from the picked shipment's first ticket as it prints
// today. Its acceptance is the traveler's golden method: the same shipment printed under the flow
// config and under a template holding the seeded layout, compared line by line and stroke by stroke.
// ------------------------------------------------------------------------------------------------

const TICKET_DEFAULTS: Record<TicketDocType, TemplateConfig> = { SHIPPER: SHIPPER_DEFAULT_CONFIG, MOS_SHIPPER: MOS_SHIPPER_DEFAULT_CONFIG };
const ticketCfg = (docType: TicketDocType = "SHIPPER"): TemplateConfig => structuredClone(TICKET_DEFAULTS[docType]);
const LIABILITY = "FIRST LIABILITY PARAGRAPH, SET IN THE SMALL SIZE.\n\nSECOND LIABILITY PARAGRAPH.";

let ticketSeq = 0;
/**
 * A real shipment of `orders` orders of one customer, every piece on its tickets printed unless
 * turned off: a BILL_TO row whose name differs from the customer's (so the Sold To box stacks it,
 * R14), a SHIP_TO row, one part line, one container row with a tare each (so the order has a gross),
 * a serial flagged for the ticket, and the line shipped complete.
 */
async function ticketShipment(options: {
  orders?: number; gross?: boolean; serial?: boolean; complete?: boolean; customer?: Customer; lines?: number;
} = {}) {
  ticketSeq += 1;
  const customer = options.customer ?? await prisma.customer.create({
    data: { code: `TS${ticketSeq}`, name: `Seed Ticket Customer ${ticketSeq}` },
  });
  await prisma.customerAddress.create({
    data: {
      customerId: customer.id, kind: "BILL_TO", name: "Accounts payable", street: "300 Example Way",
      city: "Anniston", state: "AL", zip: "36201", isDefault: true,
    },
  });
  const shipTo = await prisma.customerAddress.create({
    data: {
      customerId: customer.id, kind: "SHIP_TO", name: "Example Coating", street: "88 Dock Rd.",
      city: "Oxford", state: "AL", zip: "36203", isDefault: true,
    },
  });
  const bin = await prisma.containerType.create({ data: { name: `Bin ${ticketSeq}` } });
  const orders: OrderDetail[] = [];
  const shipped: unknown[] = [];
  for (let i = 0; i < (options.orders ?? 1); i++) {
    ticketSeq += 1;
    const part = await prisma.part.create({
      data: {
        customerId: customer.id, partNumber: `TSP-${ticketSeq}`, name: "Track Shoe, Vehicular",
        description: "D-001", eachWeight: "21.5000",
      },
    });
    const code = await prisma.processStepCode.create({ data: { code: `TS-${ticketSeq}`, name: "Austenitize" } });
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    await prisma.partProcessStep.create({ data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize." } });
    const lineCount = options.lines ?? 1;
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: `PO-${ticketSeq}`, customerJobNo: "JOB-9",
      lines: Array.from({ length: lineCount }, () => ({ partId: part.id, qty: 192, weight: "4128.00" })),
    }));
    orders.push(order);
    const container = await prisma.orderContainer.create({
      data: {
        orderId: order.id, position: 1, typeId: bin.id, count: 3, customerContainerId: "DEMO-COMP-77",
        tareEach: options.gross === false ? null : "42.5",
      },
    });
    const serial = options.serial === false ? null : await prisma.orderSerial.create({
      data: { orderId: order.id, lineId: order.lines[0].id, position: 1, serial: `SN-${ticketSeq}`, description: "Heat A1" },
    });
    const complete = options.complete !== false;
    shipped.push({
      orderId: order.id,
      lines: order.lines.map((line) => ({
        orderLineId: line.id, qty: complete ? 192 : 100, weight: complete ? "4128.00" : "2150.00", lineComplete: complete,
      })),
      containers: [{ orderContainerId: container.id, count: 3 }],
      serials: serial === null ? [] : [{ orderSerialId: serial.id, printOnShipper: true }],
    });
  }
  const { shipper } = await asSystem(() => createShipper({
    customerId: customer.id, shipDate: "2026-07-29", shipToAddressId: shipTo.id, route: "South", orders: shipped,
  }, { canOverrideCreditHold: false }));
  return { customer, shipper, orders };
}

/** A ticket template of `docType` whose v1 draft holds `config`. */
async function ticketDraft(docType: TicketDocType, config: TemplateConfig) {
  ticketSeq += 1;
  const t = await asSystem(() => createTemplate(docType, `Seed ticket ${ticketSeq}`));
  await asSystem(() => editDraft(t.id, { config, updatedAt: t.draft.updatedAt }));
  return t;
}

/** Publishes `config` as a ticket template and assigns it to the customer. */
async function ticketAssigned(customerId: string, docType: TicketDocType, config: TemplateConfig) {
  const t = await ticketDraft(docType, config);
  await asSystem(() => publishDraft(t.id));
  await asSystem(() => assignTemplate(customerId, docType, t.id));
  return t;
}

/** The seed for `config`, as the editor of a ticket draft holding it would ask for it. */
async function ticketSeed(shipperId: string, config: TemplateConfig, docType: TicketDocType = "SHIPPER"): Promise<CanvasLayout> {
  const t = await ticketDraft(docType, config);
  return seedCanvasLayout(await readPreviewContext(t.id), { recordId: shipperId, config }, "nobody");
}

/** Every stroked rectangle's four edges per page (`x y w h re` then a stroke), as `StrokedLine`s:
 *  the canvas's static Box prints as one, which `strokedLines` does not read. The zero-size filled
 *  marks and spacers (`re f`) are not strokes and are left out. */
function strokedRectEdges(pdf: Buffer): StrokedLine[][] {
  const objs = parseObjects(pdf);
  const STROKE = new Set(["S", "s", "B", "B*", "b", "b*"]);
  const PAINT = new Set([...STROKE, "f", "F", "f*", "n"]);
  return pagesInOrder(objs).map((page) => {
    const contents = /\/Contents\s+(\[[\s\S]*?\]|\d+\s+0\s+R)/.exec(page.body);
    const refs = contents ? [...contents[1].matchAll(/(\d+)\s+0\s+R/g)].map((r) => Number(r[1])) : [];
    const out: StrokedLine[] = [];
    for (const ref of refs) {
      const tokens = (objs.get(ref)?.stream?.toString("latin1") ?? "").split(/\s+/);
      let width = 1;
      let open: { x: number; y: number; w: number; h: number } | null = null;
      tokens.forEach((token, i) => {
        if (token === "w") width = Number(tokens[i - 1]);
        else if (token === "re") {
          const [x, y, w, h] = tokens.slice(i - 4, i).map(Number);
          open = { x, y, w, h };
        } else if (open !== null && PAINT.has(token)) {
          if (STROKE.has(token)) {
            const { x, y, w, h } = open as { x: number; y: number; w: number; h: number };
            out.push(
              { x1: x, y1: y, x2: x + w, y2: y, width }, { x1: x, y1: y + h, x2: x + w, y2: y + h, width },
              { x1: x, y1: y, x2: x, y2: y + h, width }, { x1: x + w, y1: y, x2: x + w, y2: y + h, width },
            );
          }
          open = null;
        }
      });
    }
    return out;
  });
}

/** The flow's and the canvas's papers, compared as the traveler's are (`expectSamePaper`), the
 *  stroked rectangles' edges counted with the lines on both sides. */
function expectSameTicket(flow: Buffer, canvas: Buffer) {
  expect(pageCount(canvas)).toBe(pageCount(flow));
  const flowLines = textLinesWithY(flow);
  const canvasLines = textLinesWithY(canvas);
  flowLines.forEach((lines, page) => {
    expect(canvasLines[page].map((l) => l.text), `page ${page + 1}'s lines`).toEqual(lines.map((l) => l.text));
    lines.forEach((line, i) => {
      expect(Math.abs(canvasLines[page][i].y - line.y), `page ${page + 1}, "${line.text}" at ${line.y}`).toBeLessThanOrEqual(2);
    });
  });
  const strokes = (pdf: Buffer) => {
    const rects = strokedRectEdges(pdf);
    return strokedLines(pdf).map((page, i) => inkOf([...page, ...rects[i]]));
  };
  const flowInk = strokes(flow);
  const canvasInk = strokes(canvas);
  flowInk.forEach((page, n) => {
    const left = [...canvasInk[n]];
    const missing: Ink[] = [];
    for (const s of page) {
      const i = left.findIndex((c) => c.axis === s.axis && Math.abs(c.width - s.width) < 0.01
        && Math.abs(c.at - s.at) <= 1 && Math.abs(c.from - s.from) <= 1 && Math.abs(c.to - s.to) <= 1);
      if (i === -1) missing.push(s);
      else left.splice(i, 1);
    }
    expect({ page: n + 1, missing, extra: left }).toEqual({ page: n + 1, missing: [], extra: [] });
  });
  expect(paintedImageCounts(canvas)).toEqual(paintedImageCounts(flow));
}

/** Prints the shipment under the customer's flow template (the Standard when `flowConfig` is
 *  omitted), then under a template holding the seeded layout, and compares the two papers. */
async function ticketGolden(
  customerId: string, shipperId: string, layout: CanvasLayout, docType: TicketDocType = "SHIPPER", flowConfig?: TemplateConfig,
) {
  if (flowConfig) await ticketAssigned(customerId, docType, flowConfig);
  const flow = await asSystem(() => printShippingTickets(shipperId));
  await ticketAssigned(customerId, docType, validateConfig(docType, { ...(flowConfig ?? ticketCfg(docType)), layout }));
  const canvas = await asSystem(() => printShippingTickets(shipperId));
  expectSameTicket(flow.pdf, canvas.pdf);
  return { flow: flow.pdf, canvas: canvas.pdf };
}

const ticketFields = (layout: CanvasLayout) => fields(layout);
const belowTotals = (layout: CanvasLayout) =>
  layout.items.filter((i) => i.kind !== "table" && i.anchor.kind === "below-table" && i.anchor.table === "totals");

describe("seedTicketLayout: a shipping ticket draft seeds its canvas from today's paper", () => {
  it("answers a layout the rules accept: the five tables stacked in order, the text block below serials, the strip below totals, the order number repeating, and the warnings named", async () => {
    const { shipper } = await ticketShipment();
    const layout = await ticketSeed(shipper.id, ticketCfg());

    expect(canvasLayoutSchema.parse(layout)).toEqual(layout);
    expect(() => validateCanvasLayout(layout, SHIPPER_CONTRACT, { pageFooter: false })).not.toThrow();
    expect(new Set(layout.items.map((i) => i.id)).size).toBe(layout.items.length);
    expect(layout.items.some((i) => i.kind === "barcode")).toBe(false);

    const tables = tablesByY(layout);
    expect(tables.map((t) => t.key)).toEqual(["field_strip", "lines", "containers", "serials", "totals"]);
    for (const t of tables) expect(t.box).toMatchObject({ x: 24, w: 564 });
    tables.slice(1).forEach((t, i) => expect(t.box.y).toBeGreaterThanOrEqual(tables[i].box.y + tables[i].box.h));
    expect(tables.map((t) => t.anchor)).toEqual([
      { kind: "page-top" }, { kind: "below-table", table: "field_strip" }, { kind: "below-table", table: "lines" },
      { kind: "below-table", table: "containers" }, { kind: "below-table", table: "serials" },
    ]);
    // The serial list a heading alone, the totals its five rows (no width), the columns the config's.
    expect(tables[3].columns).toEqual([]);
    expect(tables[4].columns.map((c) => c.key)).toEqual(["shipped_complete", "total_qty", "total_weight", "total_tare", "total_gross"]);
    expect(tables[4].columns.every((c) => c.width === null && c.visible)).toBe(true);
    expect(tables[2].columns.map((c) => c.key)).toEqual(["container_type", "container_count", "container_tare", "cust_cont_id"]);

    // The header, page-top, in the order it draws: the left stack, the centre, the right; only the
    // order number repeats. The slots are the flow's: 24..268, 278..448, 458..588.
    const header = ticketFields(layout).filter((i) => i.anchor.kind === "page-top");
    expect(header.map((i) => i.key)).toEqual(["company_name", "title", "order_no", "ship_date", "company_address", "company_phone", "sold_to", "ship_to"]);
    expect(header.filter((i) => i.repeat).map((i) => i.key)).toEqual(["order_no"]);
    expect(fieldItem(layout, "company_name")!.box).toMatchObject({ x: 24, w: 244 });
    expect(fieldItem(layout, "order_no")!.box).toMatchObject({ x: 278, w: 170 });
    expect(fieldItem(layout, "company_phone")!.box).toMatchObject({ x: 458, w: 130 });
    expect(fieldItem(layout, "company_phone")!.style).toEqual({ size: 7, bold: false, align: "right" });
    expect(fieldItem(layout, "title")!.style).toEqual({ size: 16, bold: true, align: "left" });
    expect(fieldItem(layout, "sold_to")!.box).toMatchObject({ x: 24, w: 257 });
    expect(fieldItem(layout, "ship_to")!.box).toMatchObject({ x: 331, w: 257 });
    // The Sold To box stacks the bill-to row's name, so it is the taller of the two.
    expect(fieldItem(layout, "sold_to")!.box.h).toBeGreaterThan(fieldItem(layout, "ship_to")!.box.h);

    // The liability wording and its rule below the serial list; the strip below totals.
    const wording = layout.items.find((i) => i.kind === "textBlock")!;
    expect(wording).toMatchObject({ key: "shipper_liability_text", anchor: { kind: "below-table", table: "serials" }, style: { size: 5.5, bold: false, align: "left" } });
    expect(wording.box).toMatchObject({ x: 24, w: 564 });
    const lines = layout.items.filter((i): i is Extract<CanvasItem, { kind: "line" }> => i.kind === "line");
    expect(lines.filter((l) => l.weight === 1.5).map((l) => l.anchor)).toEqual([
      { kind: "below-table", table: "serials" }, { kind: "below-table", table: "totals" },
    ]);
    const strip = belowTotals(layout);
    expect(strip.map((i) => (i.kind === "field" ? i.key : i.kind))).toEqual([
      "line", "tear_order_no", "tear_shipped_complete", "tear_total_qty", "tear_total_weight", "box", "line", "line",
      "received_by", "received_date", "tear_sold_to", "shipped_on",
    ]);
    expect(fieldItem(layout, "tear_shipped_complete")!.box).toMatchObject({ x: 230, w: 150 });
    expect(fieldItem(layout, "tear_shipped_complete")!.style).toEqual({ size: 11, bold: true, align: "center" });
    expect(fieldItem(layout, "shipped_on")!.box).toMatchObject({ x: 408, w: 180 });
    expect(fieldItem(layout, "shipped_on")!.style).toEqual({ size: 9.5, bold: true, align: "right" });
    expect(fieldItem(layout, "received_date")!.box).toMatchObject({ x: 244, w: 344 });
    // The pair's Box at the pair table's outline (388..588), its two Lines from its inner faces.
    const box = layout.items.find((i) => i.kind === "box")!;
    expect(box.box).toMatchObject({ x: 388.4, w: 199.2 });
    const [divider, column] = lines.filter((l) => l.weight === 0.8);
    // From the Box's inner faces, half its 0.8 pt weight in from each edge, less a thousandth.
    expect(divider.box.x).toBeCloseTo(box.box.x + 0.401, 3);
    expect(divider.box.w).toBeCloseTo(box.box.w - 0.802, 3);
    expect(column.box.y).toBeCloseTo(box.box.y + 0.401, 3);
    expect(column.box.h).toBeCloseTo(box.box.h - 0.802, 3);
    expect([divider.box.h, column.box.w]).toEqual([0, 0]);

    // The warnings the seeded Standard ticket draws: the pair's two rows each print across the
    // figure column's rule (a pair row is one field item spanning both cells, as the flow's row
    // spans both), and the two Lines cross; neither Line meets the Box's ink, nothing else meets.
    const warnings = canvasWarnings(layout, SHIPPER_CONTRACT, undefined, { pageFooter: false, fonts: ticketCfg().fonts });
    const name = (id: string) => {
      const item = layout.items.find((i) => i.id === id)!;
      return item.kind === "field" ? item.key : item === divider ? "divider" : item === column ? "column rule" : item.kind;
    };
    expect(warnings.map((w) => w.itemIds.map(name))).toEqual([
      ["tear_total_qty", "column rule"], ["tear_total_weight", "column rule"], ["divider", "column rule"],
    ]);
  });

  it("composed: the seeded Standard, previewed for the same shipment, warns through the preview's measure of Ruling 11's three alone", async () => {
    // Each pair row across the figure column's Line (line 4), and the two Lines crossing. No item is
    // warned taller than its box (Ruling 17) or overlapping by a depth that prints as 0 pt (Ruling
    // 21: the measure's heights pass the seed's thousandth-snapped boxes by less), and none past the
    // page.
    const { shipper } = await ticketShipment();
    const t = await ticketDraft("SHIPPER", ticketCfg());
    const { measured } = await seededPreviewWarnings(t.id, shipper.id, ticketCfg());
    expect(measured).toHaveLength(3);
    expect(measured).toEqual([
      { items: ["tear_total_qty", "line 4"], sentence: "The Quantity shipped field and the Line (line 4) overlap; one prints over the other." },
      { items: ["tear_total_weight", "line 4"], sentence: "The Net weight field and the Line (line 4) overlap; one prints over the other." },
      { items: ["line 3", "line 4"], sentence: "The Line (line 3) and the Line (line 4) overlap; one prints over the other." },
    ]);
  });

  it("golden: the seeded canvas prints the flow Standard's lines in the same order, each within 2 pt, and the same merged strokes within 1 pt", async () => {
    const { customer, shipper, orders } = await ticketShipment();
    const layout = await ticketSeed(shipper.id, ticketCfg());
    const { flow } = await ticketGolden(customer.id, shipper.id, layout);
    // The paper compared holds every piece the seed places.
    const printed = textLinesWithY(flow)[0].map((l) => l.text).join("\n");
    for (const text of [
      "Shipping Ticket", `Order No.: ${orders[0].orderNumber}-1`, "Ship Date: 7/29/2026", "Accounts payable", "Example Coating",
      "Serial Numbers:", "Shipped Complete", "Gross weight:", "Tare:", "Received By:", "Shipped ON: 07/29/2026",
    ]) {
      expect(printed).toContain(text);
    }
  });

  it("a shipment with no gross, no flagged serial and not complete seeds the serial list one line tall and the totals two rows shorter, and the layout passes the rules", async () => {
    const full = await ticketShipment();
    const bare = await ticketShipment({ gross: false, serial: false, complete: false });
    const fullLayout = await ticketSeed(full.shipper.id, ticketCfg());
    const layout = await ticketSeed(bare.shipper.id, ticketCfg());
    expect(() => validateCanvasLayout(layout, SHIPPER_CONTRACT, { pageFooter: false })).not.toThrow();
    const table = (l: CanvasLayout, key: string) => tablesByY(l).find((t) => t.key === key)!;
    // One serial line under the heading, as the flagged one prints.
    expect(table(layout, "serials").box.h).toBeCloseTo(table(fullLayout, "serials").box.h, 3);
    // The banner and the Tare and Gross rows gone: the totals block is exactly those three rows
    // shorter, each row's height read from the full shipment's rendered ticket (the banner's from its
    // baseline to the next row's, the Tare and Gross rows' from the Net weight row's to Tare's and
    // Tare's to Gross's), never a constant.
    const printed = textLinesWithY((await asSystem(() => printShippingTickets(full.shipper.id))).pdf)[0];
    const yOf = (text: string) => {
      const found = printed.filter((l) => l.text.startsWith(text)).sort((p, q) => q.y - p.y)[0];
      expect(found, text).toBeDefined();
      return found.y;
    };
    const bannerRow = Math.abs(yOf("Shipped Complete") - yOf("Quantity Shipped:"));
    const tareRow = Math.abs(yOf("Tare:") - yOf("Net weight:"));
    const grossRow = Math.abs(yOf("Gross weight:") - yOf("Tare:"));
    const dropped = table(fullLayout, "totals").box.h - table(layout, "totals").box.h;
    expect(Math.abs(dropped - (bannerRow + tareRow + grossRow))).toBeLessThanOrEqual(1);
    expect(table(layout, "totals").columns.map((c) => c.key)).toEqual(table(fullLayout, "totals").columns.map((c) => c.key));
    // The strip still holds the banner's item, which prints only for a complete order.
    expect(fieldItem(layout, "tear_shipped_complete")).toBeDefined();
  });

  it("a typed label and a hidden column survive the seed and print", async () => {
    const { customer, shipper } = await ticketShipment();
    const working = ticketCfg();
    working.sections.find((s) => s.key === "header")!.fields.find((f) => f.key === "order_no")!.label = "Order:";
    working.sections.find((s) => s.key === "containers")!.fields.find((f) => f.key === "cust_cont_id")!.visible = false;
    working.textBlocks.shipper_liability_text = LIABILITY;
    const checked = validateConfig("SHIPPER", working);
    const layout = await ticketSeed(shipper.id, checked);

    expect(fieldItem(layout, "order_no")!.label).toBe("Order:");
    expect(tablesByY(layout).find((t) => t.key === "containers")!.columns.find((c) => c.key === "cust_cont_id"))
      .toEqual({ key: "cust_cont_id", visible: false, label: null, width: null });
    const { canvas } = await ticketGolden(customer.id, shipper.id, layout, "SHIPPER", checked);
    const printed = textLinesWithY(canvas)[0].map((l) => l.text).join("\n");
    expect(printed).toMatch(/Order: \d+-1/);
    expect(printed).not.toContain("Cust Cont Id");
    expect(printed).toContain("SECOND LIABILITY PARAGRAPH.");
  });

  it("a working config with the containers section hidden seeds a stack that skips it, and the layout passes the rules", async () => {
    const { shipper } = await ticketShipment();
    const working = ticketCfg();
    working.sections.find((s) => s.key === "containers")!.visible = false;
    const layout = await ticketSeed(shipper.id, validateConfig("SHIPPER", working));
    expect(tablesByY(layout).map((t) => t.key)).toEqual(["field_strip", "lines", "serials", "totals"]);
    expect(() => validateCanvasLayout(layout, SHIPPER_CONTRACT, { pageFooter: false })).not.toThrow();
  });

  it("a placed logo seeds a logo item where the flow printed it", async () => {
    const { customer, shipper } = await ticketShipment();
    const logo = await barcodePng("TICKETLOGO");
    const working = ticketCfg();
    working.logo = { placement: "header-right", width: 90 };
    const t = await ticketDraft("SHIPPER", working);
    await asSystem(() => uploadLogo(t.id, logo, "image/png"));
    const layout = await seedCanvasLayout(await readPreviewContext(t.id), { recordId: shipper.id, config: working }, "nobody");
    const logos = layout.items.filter((i) => i.kind === "logo");
    expect(logos).toHaveLength(1);
    expect(logos[0].box.w).toBe(90);

    const flowTemplate = await ticketDraft("SHIPPER", working);
    await asSystem(() => uploadLogo(flowTemplate.id, logo, "image/png"));
    await asSystem(() => publishDraft(flowTemplate.id));
    await asSystem(() => assignTemplate(customer.id, "SHIPPER", flowTemplate.id));
    const flow = await asSystem(() => printShippingTickets(shipper.id));
    const canvasTemplate = await ticketDraft("SHIPPER", validateConfig("SHIPPER", { ...working, layout }));
    await asSystem(() => uploadLogo(canvasTemplate.id, logo, "image/png"));
    await asSystem(() => publishDraft(canvasTemplate.id));
    await asSystem(() => assignTemplate(customer.id, "SHIPPER", canvasTemplate.id));
    const canvas = await asSystem(() => printShippingTickets(shipper.id));
    expectSameTicket(flow.pdf, canvas.pdf);
    const [flowImages, canvasImages] = [drawnImages(flow.pdf)[0], drawnImages(canvas.pdf)[0]];
    expect(flowImages).toHaveLength(1);
    expect(canvasImages).toHaveLength(1);
    for (const k of ["x", "y", "w", "h"] as const) expect(Math.abs(canvasImages[0][k] - flowImages[0][k]), k).toBeLessThanOrEqual(1);
  });

  /** The flow's and the canvas's ticket for the shipment, the canvas under `layout` (`ticketGolden`'s
   *  prints, without its comparison). */
  async function ticketPrints(customerId: string, shipperId: string, layout: CanvasLayout, flowConfig: TemplateConfig) {
    await ticketAssigned(customerId, "SHIPPER", flowConfig);
    const flow = await asSystem(() => printShippingTickets(shipperId));
    await ticketAssigned(customerId, "SHIPPER", validateConfig("SHIPPER", { ...flowConfig, layout }));
    const canvas = await asSystem(() => printShippingTickets(shipperId));
    return { flow: flow.pdf, canvas: canvas.pdf };
  }
  /** Every stroke (lines and rectangle edges) reaching past `edge`, and every run ending past it. */
  function inkPast(pdf: Buffer, edge: number): string[] {
    const rects = strokedRectEdges(pdf);
    const strokes = strokedLines(pdf).flatMap((page, i) => [...page, ...rects[i]])
      .filter((l) => Math.max(l.x1, l.x2) > edge + 0.5).map((l) => `stroke ${l.x1}..${l.x2}@${l.y1}`);
    const runs = runFonts(pdf).filter((r) => r.text.trim() !== "").filter((r) => {
      const [family, face] = fontOf(r.font);
      return r.x + textWidthOf(r.text.trimEnd(), family, face, r.size) > edge + TEXT_TOLERANCE;
    }).map((r) => `run "${r.text.trim()}"@${r.x}`);
    return [...strokes, ...runs];
  }

  it("a template whose base size passes the pair's 10.5 pt label draws the pair's Box round its taller figure cells (Ruling 13)", async () => {
    const { customer, shipper } = await ticketShipment();
    const working = ticketCfg();
    // 11 pt: the figure is the pair's taller cell, and the flow's tables fit their width, so the
    // seeded canvas prints the flow's paper (the 12 pt case below is where the flow overflows).
    working.fonts.baseSize = 11;
    const checked = validateConfig("SHIPPER", working);
    const layout = await ticketSeed(shipper.id, checked);
    expect(() => validateCanvasLayout(layout, SHIPPER_CONTRACT, { pageFooter: false })).not.toThrow();
    const box = layout.items.find((i): i is Extract<CanvasItem, { kind: "box" }> => i.kind === "box")!;
    const rows = ["tear_total_qty", "tear_total_weight"].map((key) => fieldItem(layout, key)!.box);
    // Each row is as tall as its taller cell. At the default size the 10.5 pt label is the taller
    // cell; at this 11 pt base the figure is, so the same shipment's pair rows are taller than at the default.
    const atDefault = await ticketSeed(shipper.id, validateConfig("SHIPPER", ticketCfg()));
    for (const [i, key] of ["tear_total_qty", "tear_total_weight"].entries()) {
      expect(rows[i].h, key).toBeGreaterThan(fieldItem(atDefault, key)!.box.h);
    }
    // The Box's outer bottom (its centreline bottom plus half its weight) is the last row's bottom
    // plus the boxed table's bottom padding and rule: the figure cells close the outline, so a seed
    // that read the label cells alone would end the Box short of it.
    const boxed = TABLE_LAYOUTS[LAYOUT.boxed] as { hLineWidth: () => number };
    const closing = BOXED.padY + boxed.hLineWidth();
    const last = rows.at(-1)!;
    expect(box.box.y + box.box.h + box.weight / 2).toBeCloseTo(last.y + last.h + closing, 2);
    // The flow's pair outline, which closes under the figure cell, is the Box's within 1 pt.
    await ticketGolden(customer.id, shipper.id, layout, "SHIPPER", checked);
  });

  it("at a 12 pt base, where the flow's folded containers overflowed before #991, the flow and the seeded canvas both keep them in their box", async () => {
    const { customer, shipper } = await ticketShipment();
    const working = ticketCfg();
    working.fonts.baseSize = 12;
    const checked = validateConfig("SHIPPER", working);
    const layout = await ticketSeed(shipper.id, checked);
    const containers = tablesByY(layout).find((t) => t.key === "containers")!;
    expect(containers.box).toMatchObject({ x: 24, w: 564 });
    const { flow, canvas } = await ticketPrints(customer.id, shipper.id, layout, checked);
    // Before #991 the flow's containers printed past the margin (pdfmake's case 1), rules and a heading
    // word ("Cont"@571.66), and only the canvas kept them in (#971). The flow's table sections now take
    // the clamp too: neither prints a stroke past 588, and what each still prints past it is the same
    // ship-to field's last word, a field the clamp does not reach on either layout (#991 design §4.1).
    const flowPast = inkPast(flow, 588);
    const canvasPast = inkPast(canvas, 588);
    expect(flowPast.filter((ink) => ink.startsWith("stroke"))).toEqual([]);
    expect(canvasPast).toEqual(['run "Testville"@562.337891']);
    expect(flowPast).toEqual(canvasPast);
    // Line for line the same paper, the containers heading's wrapped lines included.
    expect(pageCount(canvas)).toBe(pageCount(flow));
    const flowLines = textLinesWithY(flow);
    const canvasLines = textLinesWithY(canvas);
    flowLines.forEach((lines, page) => {
      expect(canvasLines[page].map((l) => l.text), `page ${page + 1}`).toEqual(lines.map((l) => l.text));
    });
  });

  it("a shipment whose first ticket prints more than one page is refused, the draft untouched (Ruling 12)", async () => {
    const { shipper } = await ticketShipment({ lines: 40 });
    const t = await ticketDraft("SHIPPER", ticketCfg());
    const draft = () => prisma.documentTemplateVersion.findFirstOrThrow({ where: { templateId: t.id, status: "DRAFT" } });
    const before = await draft();
    const settings = await ticketSettings();
    const data = await prisma.$transaction(async (tx) => readShippingTicketData(tx, shipper.id, settings));
    const { pdf } = await renderSheetGroupsWithPositions(buildShippingTicketDefinitions([data[0]], "SHIPPER", ticketCfg()));
    const pages = pageCount(pdf);
    expect(pages).toBeGreaterThan(1);
    await expect(seedCanvasLayout(await readPreviewContext(t.id), { recordId: shipper.id, config: ticketCfg() }, "nobody"))
      .rejects.toMatchObject({
        status: 400,
        message: `The canvas starts from a one-page ticket; this shipment's first ticket prints ${pages} pages. Pick a shipment whose ticket fits one page.`,
      });
    const after = await draft();
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.config).toEqual(before.config);
  });

  it("a MOS_SHIPPER two-order shipment seeds from its first order and prints every order the same", async () => {
    const { customer, shipper, orders } = await ticketShipment({ orders: 2 });
    const layout = await ticketSeed(shipper.id, ticketCfg("MOS_SHIPPER"), "MOS_SHIPPER");
    expect(() => validateCanvasLayout(layout, MOS_SHIPPER_CONTRACT, { pageFooter: false })).not.toThrow();
    const { canvas } = await ticketGolden(customer.id, shipper.id, layout, "MOS_SHIPPER");
    expect(pageCount(canvas)).toBe(2);
    // Each sheet names its own order under the one seeded order item.
    textLinesWithY(canvas).forEach((page, i) => {
      expect(page.some((line) => line.text.includes(`Order No.: ${orders[i].orderNumber}-1`))).toBe(true);
    });
  });

  it("the route: templates.edit alone is 403 without shipping.view; the draft is not written", async () => {
    const { shipper } = await ticketShipment();
    const ticket = await ticketDraft("SHIPPER", ticketCfg());
    const editOnly = await signInWith(["templates.edit"], "ticket-seed-edit");
    const both = await signInWith(["templates.edit", "shipping.view"], "ticket-seed-both");

    const ask = (id: string, cookie: string, body: unknown) => seedRoute(new Request(`http://t/api/templates/${id}/draft/canvas`, {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
    }), { params: Promise.resolve({ id }) });
    const body = { recordId: shipper.id, config: ticketCfg() };

    expect((await ask(ticket.id, "", body)).status).toBe(401);
    expect((await ask(ticket.id, editOnly, body)).status).toBe(403);

    const draft = () => prisma.documentTemplateVersion.findFirstOrThrow({ where: { templateId: ticket.id, status: "DRAFT" } });
    const before = await draft();
    const documents = await prisma.storedDocument.count();
    const audits = await prisma.auditLog.count();
    const res = await ask(ticket.id, both, body);
    expect(res.status).toBe(200);
    const layout = canvasLayoutSchema.parse(await res.json());
    expect(tablesByY(layout).map((t) => t.key)).toEqual(["field_strip", "lines", "containers", "serials", "totals"]);
    const after = await draft();
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.config).toEqual(before.config);
    expect(await prisma.storedDocument.count()).toBe(documents);
    expect(await prisma.auditLog.count()).toBe(audits);
  });

  it("the seed refuses a docType whose contract offers no canvas in the profile's sentence, a 400 before any record is read", async () => {
    // Called directly: no template can be created under a docType the registry does not know. The
    // helper's promise is awaited, so the stub is gone before the case ends.
    await withTestContract(async () => {
      await expect(seedCanvasLayout({ docType: TEST_DOC_TYPE, logoImage: null, logoMimeType: null }, { recordId: "no-such-record", config: defaultConfigFor(TEST_DOC_TYPE) }, "nobody"))
        .rejects.toMatchObject({ status: 400, message: "The Test template offers no canvas; it keeps its sections." });
    });
  });

  it("the seed: since the quotation's paper landed, the later-release sentence is reached only through the stubbed docType given a profile, a 400 before any record is read", async () => {
    // Every real docType's canvas prints since quote canvas PR 2, so the later-release refusal stands on
    // the stub given the certification's profile (tests/helpers/test-contract.ts). Red when
    // `assertCanvasPrints`' set check is deleted (the switch's default then throws a plain Error, no
    // status), and when `withTestContract` ignores its `canvas` option (the profile's own sentence
    // answers instead).
    await withTestContract(async () => {
      await expect(seedCanvasLayout({ docType: TEST_DOC_TYPE, logoImage: null, logoMimeType: null }, { recordId: "no-such-record", config: defaultConfigFor(TEST_DOC_TYPE) }, "nobody"))
        .rejects.toMatchObject({
          status: 400,
          message: "The Test template's canvas prints in a later release; it keeps its sections until then.",
        });
    }, { canvas: CERT_CONTRACT.canvas });
  });

  it("a print's definition carries no seed id and no placeholder line", async () => {
    const { shipper } = await ticketShipment({ serial: false });
    const data = await prisma.$transaction(async (tx) => readShippingTicketData(tx, shipper.id, await ticketSettings()));
    const json = (defs: unknown) => JSON.stringify(defs);
    const ids = (defs: unknown) => json(defs).match(/"seed:[^"]*"/g) ?? [];
    expect(ids(buildShippingTicketDefinitions(data, "SHIPPER", ticketCfg()))).toEqual([]);
    expect(json(buildShippingTicketDefinitions(data, "SHIPPER", ticketCfg()))).not.toContain('"text":" "');
    const seeded = buildShippingTicketDefinitions(data, "SHIPPER", ticketCfg(), undefined, { seedIds: true, seedPlaceholders: true });
    expect(ids(seeded).length).toBeGreaterThan(0);
    expect(json(seeded)).toContain('"text":" "');
  });
});

/** Every painted image's drawn box per page, from the `cm` before its `Do` (traveler-canvas.test.ts's
 *  reader): pdfkit draws an image as `q w 0 0 -h x y+h cm /Ix Do Q` inside the page's top-down flip. */
function drawnImages(pdf: Buffer): { x: number; y: number; w: number; h: number }[][] {
  const objs = parseObjects(pdf);
  const cm = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+cm\s+\/\w+\s+Do\b/g;
  return pagesInOrder(objs).map((page) => {
    const contents = /\/Contents\s+(\[[\s\S]*?\]|\d+\s+0\s+R)/.exec(page.body);
    const refs = contents ? [...contents[1].matchAll(/(\d+)\s+0\s+R/g)].map((r) => Number(r[1])) : [];
    const stream = refs.map((ref) => objs.get(ref)?.stream?.toString("latin1") ?? "").join("\n");
    return [...stream.matchAll(cm)].map((m) => {
      const [a, , , d, e, f] = m.slice(1, 7).map(Number);
      return { x: e, y: d < 0 ? f + d : f, w: Math.abs(a), h: Math.abs(d) };
    });
  });
}

// ------------------------------------------------------------------------------------------------
// The bill of lading's seed (design 2026-11-09 §5.3, §4.4; BOL canvas PR 2, Task 5): the flow laid
// out once for the picked shipment, the PO list one line tall, the BOL number repeated where it
// prints above the PO list, the blocks moved down by the shortfall rule 3 needs.
// ------------------------------------------------------------------------------------------------

const bolCfg = (): TemplateConfig => structuredClone(BOL_DEFAULT_CONFIG);
const bolFieldOf = (c: TemplateConfig, section: string, key: string) => fieldOf(c, section, key);

let bolSeq = 0;
/**
 * A real shipment of `orders` orders of one customer: freight COLLECT, a carrier, a pro number, a SCAC
 * code, a ship-to address and a PO on every order (`po(i)`, a short one by default); one part serves
 * every order, each order's one line shipped whole.
 */
async function bolShipment(options: { orders?: number; customer?: Customer; po?: (i: number) => string } = {}) {
  bolSeq += 1;
  const customer = options.customer ?? await prisma.customer.create({
    data: { code: `BS${bolSeq}`, name: `Seed BOL Customer ${bolSeq}` },
  });
  const shipTo = await prisma.customerAddress.create({
    data: {
      customerId: customer.id, kind: "SHIP_TO", name: "Example Coating", street: "400 Demo Drive",
      city: "Birmingham", state: "AL", zip: "35217", isDefault: true,
    },
  });
  const carrier = await prisma.carrier.create({ data: { name: `Demo Foundry Truck ${bolSeq}` } });
  const part = await prisma.part.create({
    data: { customerId: customer.id, partNumber: `BSP-${bolSeq}`, name: "Seed BOL Part", eachWeight: "21.5000" },
  });
  const code = await prisma.processStepCode.create({ data: { code: `BS-${bolSeq}`, name: "Normalize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({ data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Normalize." } });
  const po = options.po ?? ((i: number) => `PO-${bolSeq}-${i}`);
  const shipped: unknown[] = [];
  for (let i = 0; i < (options.orders ?? 1); i++) {
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: po(i), lines: [{ partId: part.id, qty: 10, weight: "215.00" }],
    }));
    shipped.push({
      orderId: order.id,
      lines: [{ orderLineId: order.lines[0].id, qty: 10, weight: "215.00", lineComplete: true }],
      containers: [], serials: [],
    });
  }
  const { shipper } = await asSystem(() => createShipper({
    customerId: customer.id, shipDate: "2026-07-06", shipToAddressId: shipTo.id, carrierId: carrier.id,
    freightTerms: "COLLECT", proNumber: "PRO-4471", scacCode: "GFMC",
    freightDescription: "Manufactured Castings I/S", freightClass: "70", orders: shipped,
  }, { canOverrideCreditHold: false }));
  return { customer, shipper };
}

/** A BOL template whose v1 draft holds `config` (and the logo, when given). */
async function bolDraft(config: TemplateConfig, logo?: Buffer) {
  bolSeq += 1;
  const t = await asSystem(() => createTemplate("BOL", `Seed BOL ${bolSeq}`));
  await asSystem(() => editDraft(t.id, { config, updatedAt: t.draft.updatedAt }));
  if (logo) await asSystem(() => uploadLogo(t.id, logo, "image/png"));
  return t;
}

/** Publishes `config` as a BOL template, the logo with it, and assigns it to the customer. */
async function bolAssigned(customerId: string, config: TemplateConfig, logo?: Buffer) {
  const t = await bolDraft(config, logo);
  await asSystem(() => publishDraft(t.id));
  await asSystem(() => assignTemplate(customerId, "BOL", t.id));
  return t;
}

/** The seed for `config`, as the editor of a BOL draft holding it would ask for it. */
async function bolSeed(shipperId: string, config: TemplateConfig, logo?: Buffer): Promise<CanvasLayout> {
  const t = await bolDraft(config, logo);
  return seedCanvasLayout(await readPreviewContext(t.id), { recordId: shipperId, config }, "nobody");
}

/** The flow under `config` laid out for the shipment with the seed's marks, as the seed lays it out
 *  (`placeholders` false: the shipment's own PO list), read as the preview reads (no allocation). */
async function bolLaidOut(shipperId: string, config: TemplateConfig, options: { placeholders?: boolean; logo?: Buffer } = {}) {
  const data = await prisma.$transaction(async (tx) => {
    const s = await tx.shipper.findFirstOrThrow({ where: { id: shipperId }, select: { bolNumber: true, shipperNumber: true } });
    return readBolData(tx, shipperId, s.bolNumber ?? s.shipperNumber, await bolSettings());
  });
  const def = buildBolDefinition(data, config, options.logo === undefined ? undefined : pngDataUri(options.logo),
    { seedIds: true, seedPlaceholders: options.placeholders ?? true });
  const { groups } = await renderSheetGroupsWithPositions([def]);
  return { positions: groups[0].positions, pages: groups[0].pages, data };
}

function laid(positions: LaidOutNode[], id: string): LaidOutNode {
  const node = positions.find((n) => n.id === id);
  if (node === undefined) throw new Error(`No laid-out position for ${id}`);
  return node;
}

const bolTables = (layout: CanvasLayout) => tablesByY(layout);
const bolBlock = (layout: CanvasLayout, key: string) => {
  const t = tablesByY(layout).find((table) => table.key === key);
  if (t === undefined) throw new Error(`The layout has no ${key} block`);
  return t;
};
const heavyRules = (layout: CanvasLayout) =>
  layout.items.filter((i): i is Extract<CanvasItem, { kind: "line" }> => i.kind === "line" && i.weight === 1.2);

type StyledRun = { text: string; x: number; y: number; font: string; size: number };

/** A page's text runs, each with its font and size (`runFonts` reads page 1, which is every page the
 *  seeded goldens print; a later page's runs carry none). */
function styledRuns(pdf: Buffer): StyledRun[][] {
  const fonts = runFonts(pdf);
  return textRunsWithY(pdf).map((runs, page) =>
    runs.map((r, i) => ({ ...r, font: page === 0 ? fonts[i].font : "", size: page === 0 ? fonts[i].size : 0 })));
}

/** Runs grouped into printed lines as `textLinesWithY` groups them (by baseline to half a point, left
 *  to right, the spacing collapsed), each with the x, the font and the size of every run that is not
 *  white space alone, a line of white space alone left out: a blank write-in prints one space, which
 *  the flow's "Per" rule does too where the canvas draws a Line, and neither inks. The runs' x, font
 *  and size hold what a baseline does not: an alignment, an indent, a size and a weight. */
function linesOfRuns(runs: StyledRun[]): { text: string; y: number; xs: number[]; styles: string[] }[] {
  const byLine = new Map<number, StyledRun[]>();
  for (const run of runs) {
    const key = Math.round(run.y * 2) / 2;
    byLine.set(key, [...(byLine.get(key) ?? []), run]);
  }
  return [...byLine.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([y, parts]) => {
      const sorted = parts.sort((a, b) => a.x - b.x);
      return {
        y,
        text: sorted.map((p) => p.text).join("").replace(/\s+/g, " ").trim(),
        xs: sorted.filter((p) => p.text.trim() !== "").map((p) => p.x),
        styles: sorted.filter((p) => p.text.trim() !== "").map((p) => `${p.font} ${p.size}`),
      };
    })
    .filter((line) => line.text !== "");
}

/**
 * The flow's and the canvas's bills of lading, compared (design §5.3's acceptance): the same pages;
 * on each, the same printed lines in the reader's order, each within 2 pt of the flow's, its runs in
 * the flow's fonts and sizes and at the flow's x within 2 pt (an alignment, an indent); the same
 * distinct strokes, each end within 1 pt, the collect box's uprights among them; the same image
 * paints. The canvas prints everything below the page-top items `shift` lower than the flow (the
 * repeat shift), so the comparison first moves every canvas run and stroke that lies outside the
 * layout's page-top items back up by `shift`; a page-top item's are compared where they print. The
 * lines are grouped after that move, so a page-top line and a moved one that share a baseline on the
 * flow are one line on both sides.
 */
function expectSameBol(flow: Buffer, canvas: Buffer, layout: CanvasLayout, shift: number) {
  expect(pageCount(canvas)).toBe(pageCount(flow));
  const fixed = layout.items.filter((i) => i.kind !== "table" && i.anchor.kind === "page-top").map((i) => i.box);
  const inFixed = (x: number, top: number) =>
    fixed.some((b) => x >= b.x - 0.5 && x <= b.x + b.w + 0.5 && top >= b.y - 0.5 && top <= b.y + b.h + 0.5);
  const flowRuns = styledRuns(flow);
  const canvasRuns = styledRuns(canvas);
  flowRuns.forEach((runs, page) => {
    const lines = linesOfRuns(runs);
    // A baseline is counted from the page's BOTTOM: a moved run reads `shift` less, so it is put back.
    const back = canvasRuns[page].map((r) => (page === 0 && !inFixed(r.x, PAGE_HEIGHT - r.y) ? { ...r, y: r.y + shift } : r));
    const canvasLines = linesOfRuns(back);
    expect(canvasLines.map((l) => l.text), `page ${page + 1}'s lines`).toEqual(lines.map((l) => l.text));
    lines.forEach((line, i) => {
      expect(Math.abs(canvasLines[i].y - line.y), `page ${page + 1}, "${line.text}" at ${line.y}`).toBeLessThanOrEqual(2);
      expect(canvasLines[i].styles, `page ${page + 1}, "${line.text}"'s fonts and sizes`).toEqual(line.styles);
      line.xs.forEach((x, j) => {
        expect(Math.abs(canvasLines[i].xs[j] - x), `page ${page + 1}, "${line.text}", run ${j + 1} at x ${x}`).toBeLessThanOrEqual(2);
      });
    });
  });
  const flowInk = strokedLines(flow).map(inkOf);
  const canvasInk = strokedLines(canvas).map((page, n) => inkOf(page.map((st) => {
    const top = Math.min(st.y1, st.y2);
    const x = Math.min(st.x1, st.x2);
    return n === 0 && !inFixed(x, top) ? { ...st, y1: st.y1 - shift, y2: st.y2 - shift } : st;
  })));
  flowInk.forEach((strokes, page) => {
    const left = [...canvasInk[page]];
    const missing: Ink[] = [];
    for (const s of strokes) {
      const i = left.findIndex((c) => c.axis === s.axis && Math.abs(c.width - s.width) < 0.01
        && Math.abs(c.at - s.at) <= 1 && Math.abs(c.from - s.from) <= 1 && Math.abs(c.to - s.to) <= 1);
      if (i === -1) missing.push(s);
      else left.splice(i, 1);
    }
    expect({ page: page + 1, missing, extra: left }).toEqual({ page: page + 1, missing: [], extra: [] });
  });
  expect(paintedImageCounts(canvas)).toEqual(paintedImageCounts(flow));
}

/** Prints the shipment under the customer's flow template (the Standard when `flowConfig` is
 *  omitted), then under a template holding the seeded layout, and compares the two papers, the seed's
 *  shift read as the PO block's drawn top less its top in the flow laid out as the seed lays it out. */
async function bolGolden(
  customerId: string, shipperId: string, layout: CanvasLayout, flowConfig?: TemplateConfig, logo?: Buffer,
) {
  const config = flowConfig ?? bolCfg();
  const { positions } = await bolLaidOut(shipperId, config, { logo });
  if (flowConfig) await bolAssigned(customerId, flowConfig, logo);
  const flow = await asSystem(() => printBol(shipperId));
  await bolAssigned(customerId, validateConfig("BOL", { ...config, layout }), logo);
  const canvas = await asSystem(() => printBol(shipperId));
  const shift = bolBlock(layout, "consignee_ref").box.y - laid(positions, BOL_SEED_IDS.piece("consignee_ref")).top;
  expectSameBol(flow.pdf, canvas.pdf, layout, shift);
  return { flow: flow.pdf, canvas: canvas.pdf, shift };
}

/** The seed's one-page refusal (design §5.3, Ruling 12's sentence), naming the template's own settings
 *  beside the shipment, since a font or size can put every shipment's bill of lading on two pages. */
const bolTwoPages = (pages: number) =>
  `The canvas starts from a one-page bill of lading; this shipment's bill of lading prints ${pages} pages. Pick a shipment whose bill of lading fits one page, or change this template's settings (its font or sizes) so it does.`;

/** The seed's canvas refusal (#947): the shipment's bill of lading prints one page in the seed's
 *  render, its flow and its seeded canvas past one page, and its drawn stack runs past the canvas's one
 *  page (the page line among the settings named). */
const bolPastCanvas =
  "The canvas starts from a one-page bill of lading; laid out on the canvas, this shipment's bill of lading runs past one page. Pick a shipment whose bill of lading fits one page, or change this template's settings (its font, sizes or page line) so it does.";

/** The seed's refusal where the flow fits (#947): the shipment's bill of lading prints one page in
 *  the seed's render and in its own flow, but its seeded canvas, printed for it, runs past one page. */
const bolFlowFits =
  "The canvas starts from a one-page bill of lading; laid out on the canvas, this shipment's bill of lading runs past one page, though it fits one page in its sections. Pick another shipment, or change this template's settings (its font, sizes, logo or page line) so it fits.";

/** The Standard's header fields in `order` (the left slot's two first). */
function withHeaderOrder(config: TemplateConfig, order: string[]): TemplateConfig {
  const header = config.sections.find((s) => s.key === "header")!;
  header.fields = ["original_label", "title", ...order].map((key) => header.fields.find((f) => f.key === key)!);
  return config;
}

describe("seedBolLayout: a bill of lading draft seeds its canvas from a shipment's paper", () => {
  it("answers a layout validateConfig accepts: the three blocks stacked, the PO block in the right slot, the BOL number repeating", async () => {
    const { shipper } = await bolShipment();
    const layout = await bolSeed(shipper.id, bolCfg());

    expect(canvasLayoutSchema.parse(layout)).toEqual(layout);
    expect(() => validateConfig("BOL", { ...bolCfg(), layout })).not.toThrow();
    expect(new Set(layout.items.map((i) => i.id)).size).toBe(layout.items.length);
    expect(bolTables(layout).map((t) => t.key)).toEqual(["consignee_ref", "trv", "freight"]);
    expect(bolBlock(layout, "consignee_ref").box).toMatchObject({ x: 338, w: 244 });
    expect(bolBlock(layout, "trv").box).toMatchObject({ x: 24, w: 564 });
    expect(bolBlock(layout, "freight").box).toMatchObject({ x: 24, w: 564 });
    expect(fieldItem(layout, "bol_number")).toMatchObject({ repeat: true, anchor: { kind: "page-top" } });
    // The carrier's label column, its gap and its 260 pt rule, from the left margin (owner ruling R1, 2026-11-24).
    expect(fieldItem(layout, "carrier_name")!.box).toMatchObject({ x: 24, w: 334 });
    expect(layout.items.filter((i) => i.repeat).map((i) => (i.kind === "field" ? i.key : i.kind))).toEqual(["bol_number"]);
    // The freight block's columns are the config's, its Collect checkbox toggle after them.
    expect(bolBlock(layout, "freight").columns.map((c) => c.key))
      .toEqual(["package_count", "freight_description", "freight_weight", "freight_class", "check_column", "collect_checkbox"]);
    // The furniture the flow printed: five full rules, the delivery caption and footnote, "Per" and its rule.
    expect(layout.items.filter((i) => i.kind === "line")).toHaveLength(6);
    expect(layout.items.filter((i): i is Extract<CanvasItem, { kind: "text" }> => i.kind === "text").map((i) => i.text))
      .toEqual(["Delivery Address *", "* To be filled in only when shipper desires and governing tariffs provide for delivery thereof.", "Per"]);
    // A write-in is as tall as the taller of its label and its blank value: the 8 pt label here.
    const { positions } = await bolLaidOut(shipper.id, bolCfg());
    const value = laid(positions, BOL_SEED_IDS.piece("delivering_carrier"));
    const labelEnd = laid(positions, BOL_SEED_IDS.end("delivering_carrier:label")).top;
    expect(labelEnd).toBeGreaterThan(laid(positions, BOL_SEED_IDS.end("delivering_carrier")).top);
    expect(fieldItem(layout, "delivering_carrier")!.box.h).toBeCloseTo(labelEnd - value.top, 3);
  }, 60_000);

  it("composed: the seeded Standard, previewed for the same shipment, warns of nothing through the preview's measure, which holds every item", async () => {
    // The accepted set (design §5.3) is empty: no two items' printed ink meets, none measures taller
    // than its seeded box at `figure`'s two decimals (Ruling 17: the boxes are snapped to 0.001 pt)
    // and none passes the page. The silence is the measure's, not an absent one: the preview measured
    // every item but the three blocks (which are measured as tables), and the same measure judging the
    // carrier's name drawn 10 pt tall warns that it prints taller.
    const { shipper } = await bolShipment();
    const t = await bolDraft(bolCfg());
    const { layout, measure, measured } = await seededPreviewWarnings(t.id, shipper.id, bolCfg());
    expect(measured).toEqual([]);
    expect(measure.tables.map((table) => table.key)).toEqual(["consignee_ref", "trv", "freight"]);
    const ids = new Set(measure.items.map((item) => item.id));
    expect(layout.items.filter((item) => item.kind !== "table" && !ids.has(item.id))).toEqual([]);

    const carrier = fieldItem(layout, "carrier_name")!;
    const printed = measure.items.find((item) => item.id === carrier.id)!.height;
    expect(printed).toBeGreaterThan(10);
    const short: CanvasLayout = {
      ...layout, items: layout.items.map((i) => (i === carrier ? { ...carrier, box: { ...carrier.box, h: 10 } } : i)),
    };
    const options = { pageFooter: false, fonts: bolCfg().fonts };
    expect(namedWarnings(short, canvasWarnings(short, BOL_CONTRACT, measure, options)).map((w) => w.items))
      .toEqual([["carrier_name"]]);
  }, 60_000);

  it("golden: the seeded canvas prints the flow Standard's lines and strokes, everything from the PO list down moved by the repeat shift", async () => {
    const { customer, shipper } = await bolShipment();
    const layout = await bolSeed(shipper.id, bolCfg());
    const { flow, shift } = await bolGolden(customer.id, shipper.id, layout);
    expect(shift).toBeCloseTo(CANVAS_GRID - 3, 2);
    // The collect box's uprights (#557) print on the flow, so the comparison held them.
    const uprights = strokedLines(flow)[0].filter((s) => Math.abs(s.x1 - s.x2) < 0.01).map((s) => s.x1);
    expect(uprights.some((x) => Math.abs(x - 574.4) < 0.05)).toBe(true);
    expect(uprights.some((x) => Math.abs(x - 587.6) < 0.05)).toBe(true);
  }, 60_000);

  it("the shift: on the Standard's order every block starts CANVAS_GRID − 3 below its laid-out top, without which rule 3 refuses the layout", async () => {
    const { shipper } = await bolShipment();
    const layout = await bolSeed(shipper.id, bolCfg());
    const { positions } = await bolLaidOut(shipper.id, bolCfg());
    const shift = CANVAS_GRID - 3;
    expect(bolBlock(layout, "consignee_ref").box.y - laid(positions, BOL_SEED_IDS.piece("consignee_ref")).top).toBeCloseTo(shift, 2);
    for (const key of ["trv", "freight"]) {
      expect(bolBlock(layout, key).box.y - laid(positions, BOL_SEED_IDS.start(key)).top).toBeCloseTo(shift, 2);
    }
    expect(fieldItem(layout, "bol_number")!.repeat).toBe(true);
    const unshifted: CanvasLayout = {
      ...layout,
      items: layout.items.map((i) => (i.kind === "table" ? { ...i, box: { ...i.box, y: i.box.y - shift } } : i)),
    };
    expect(() => validateCanvasLayout(unshifted, BOL_CONTRACT, { pageFooter: false })).toThrow(/repeats on every page but ends at/);
  }, 60_000);

  it("the shift: the number printed first repeats with no shift; the PO list hidden repeats with no shift over the TRV block; the number after the PO list does not repeat", async () => {
    const { shipper } = await bolShipment();

    const first = withHeaderOrder(bolCfg(), ["bol_number", "pro_number", "consignee_ref", "scac_code"]);
    const firstLayout = await bolSeed(shipper.id, first);
    const firstLaid = await bolLaidOut(shipper.id, first);
    expect(fieldItem(firstLayout, "bol_number")!.repeat).toBe(true);
    expect(bolBlock(firstLayout, "consignee_ref").box.y)
      .toBeCloseTo(laid(firstLaid.positions, BOL_SEED_IDS.piece("consignee_ref")).top, 2);
    expect(() => validateConfig("BOL", { ...first, layout: firstLayout })).not.toThrow();

    const hidden = bolCfg();
    bolFieldOf(hidden, "header", "consignee_ref").visible = false;
    const hiddenLayout = await bolSeed(shipper.id, hidden);
    const hiddenLaid = await bolLaidOut(shipper.id, hidden);
    expect(bolTables(hiddenLayout).map((t) => t.key)).toEqual(["trv", "freight"]);
    expect(fieldItem(hiddenLayout, "bol_number")!.repeat).toBe(true);
    expect(bolBlock(hiddenLayout, "trv").box.y).toBeCloseTo(laid(hiddenLaid.positions, BOL_SEED_IDS.start("trv")).top, 2);
    expect(() => validateConfig("BOL", { ...hidden, layout: hiddenLayout })).not.toThrow();

    const after = withHeaderOrder(bolCfg(), ["pro_number", "consignee_ref", "bol_number", "scac_code"]);
    const afterLayout = await bolSeed(shipper.id, after);
    expect(fieldItem(afterLayout, "bol_number")).toMatchObject({ repeat: false, anchor: { kind: "below-table", table: "consignee_ref" } });
    expect(afterLayout.items.some((i) => i.repeat)).toBe(false);
    expect(() => validateConfig("BOL", { ...after, layout: afterLayout })).not.toThrow();
  }, 60_000);

  it("a shipment whose POs wrap seeds the PO block one line tall, and its own print moves the header's rule down by the wrap", async () => {
    const one = await bolShipment();
    const oneLayout = await bolSeed(one.shipper.id, bolCfg());
    const five = await bolShipment({ orders: 5, po: (i) => `CUSTOMER-PURCHASE-ORDER-00000${i}` });
    const layout = await bolSeed(five.shipper.id, bolCfg());
    expect(bolBlock(layout, "consignee_ref").box.h).toBe(bolBlock(oneLayout, "consignee_ref").box.h);

    // The wrap: the PO list as the shipment prints it, less the one line it was seeded at.
    const real = await bolLaidOut(five.shipper.id, bolCfg(), { placeholders: false });
    const po = (positions: LaidOutNode[]) =>
      laid(positions, BOL_SEED_IDS.end("consignee_ref")).top - laid(positions, BOL_SEED_IDS.piece("consignee_ref")).top;
    const wrap = po(real.positions) - bolBlock(layout, "consignee_ref").box.h;
    expect(wrap).toBeGreaterThan(2 * bolBlock(layout, "consignee_ref").box.h);

    await bolAssigned(five.customer.id, validateConfig("BOL", { ...bolCfg(), layout }));
    const { pdf } = await asSystem(() => printBol(five.shipper.id));
    const [rule] = heavyRules(layout);
    const drawn = drawnBox(rule, layout).y;
    const printed = strokedLines(pdf)[0].filter((s) => Math.abs(s.width - 1.2) < 0.01 && Math.abs(s.y1 - s.y2) < 0.01);
    expect(printed).toHaveLength(1);
    expect(printed[0].y1).toBeCloseTo(drawn + wrap, 1);
  }, 60_000);

  it("a typed label (the PO block's and the TRV list's headings among them), a hidden field and a hidden freight column survive the seed and print", async () => {
    const { customer, shipper } = await bolShipment();
    const config = bolCfg();
    bolFieldOf(config, "header", "consignee_ref").label = "Customer PO";
    bolFieldOf(config, "header", "pro_number").label = "PRO #";
    bolFieldOf(config, "trv", "trv_no").label = "ORDERS:";
    bolFieldOf(config, "consigned", "destination_zip").visible = false;
    bolFieldOf(config, "freight", "freight_class").visible = false;
    const layout = await bolSeed(shipper.id, config);
    expect(bolBlock(layout, "consignee_ref").heading).toBe("Customer PO");
    expect(bolBlock(layout, "trv").heading).toBe("ORDERS:");
    expect(fieldItem(layout, "pro_number")!.label).toBe("PRO #");
    expect(fieldItem(layout, "destination_zip")).toBeUndefined();
    expect(bolBlock(layout, "freight").columns.find((c) => c.key === "freight_class")).toMatchObject({ visible: false });
    const { canvas } = await bolGolden(customer.id, shipper.id, layout, config);
    const text = textLinesWithY(canvas)[0].map((l) => l.text).join("\n");
    expect(text).toContain("Customer PO");
    expect(text).toContain("PRO #");
    expect(text).toContain("ORDERS:");
    expect(text).not.toContain("TRV NO.");
  }, 60_000);

  it("a shipment whose bill of lading prints two pages is refused in the seed's sentence, the draft untouched", async () => {
    const { shipper } = await bolShipment();
    const config = bolCfg();
    config.textBlocks.bol_property_text = Array.from({ length: 7 }, () => BOL_DEFAULT_CONFIG.textBlocks.bol_property_text).join("\n\n");
    const flow = await bolLaidOut(shipper.id, config);
    expect(flow.pages).toBe(2);
    const t = await bolDraft(config);
    const draft = () => prisma.documentTemplateVersion.findFirstOrThrow({ where: { templateId: t.id, status: "DRAFT" } });
    const before = await draft();
    await expect(seedCanvasLayout(await readPreviewContext(t.id), { recordId: shipper.id, config }, "nobody"))
      .rejects.toMatchObject({
        status: 400,
        message: bolTwoPages(2),
      });
    const after = await draft();
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.config).toEqual(before.config);
  }, 60_000);

  // One page in the flow is not yet one page on the canvas (#947): the seed draws every block lower
  // than its render laid it out, by the repeat shift rule 3 needs below the BOL number (about 1.5 pt on
  // the Standard, 1.502 in Liberation Sans) and by the row-floor clamps above it (`lift`), and the
  // items below the last block ride it. The sheet prints each block at its rendered height, so the
  // printed canvas stands the whole shift below the flow, in every face, and the drawn stack stands the
  // lift below that (drawn = flow + shift + lift; printed = drawn - lift). So a shipment whose flow
  // ends within the shift of the page's foot seeded a layout whose last region ends past the foot and
  // moves whole to page 2, and rule 4 judges no item below a block, so Save accepted it. The seed now
  // prints the seeded layout for the shipment's own data: one page seeds; past one page where the
  // shipment's own flow prints one is refused in the sentence that says the flow fits; past one page
  // with the flow is judged by the drawn stack, the PO list one line tall (`fitsTheCanvas`), in the
  // canvas sentence. The property clause's lengths are measured at the boundary (the issue's two
  // reproductions, the paragraphs joined by "\n", base size 7.5 in both: the issue's 749.02 is the Sans
  // figure at 7.5); the sweep below states the invariant itself.
  const withPropertyLines = (lines: number, family: FontFamily, pageFooter: boolean, baseSize = 7.5): TemplateConfig => {
    const config = bolCfg();
    config.fonts.family = family;
    config.fonts.baseSize = baseSize;
    config.pageFooter = pageFooter;
    config.textBlocks.bol_property_text = [
      BOL_DEFAULT_CONFIG.textBlocks.bol_property_text, ...Array.from({ length: lines }, (_, i) => `Paragraph ${i + 1}.`),
    ].join("\n");
    return config;
  };
  /** The pages a canvas prints for the shipment, rendered directly as the preview reads it (no
   *  allocation): the shipment's own data under the flow config with the layout set (null: its flow). */
  const bolCanvasPages = async (shipperId: string, config: TemplateConfig, layout: CanvasLayout | null, logo?: Buffer) => {
    const { data } = await bolLaidOut(shipperId, config, { logo });
    const uri = logo === undefined ? undefined : pngDataUri(logo);
    const { groups } = await renderSheetGroupsWithPositions([buildBolDefinition(data, validateConfig("BOL", { ...config, layout }), uri)]);
    return groups[0].pages;
  };
  /** The seed's clearance (#947's review), asked only where the canvas and the flow both page: a drawn
   *  bottom keeps two thousandths of a point above the foot. */
  const BOL_FIT_CLEARANCE = 2;
  /** The lowest drawn bottom less the page's foot, in whole thousandths of a point (negative: above it). */
  const bolFootMargin = (layout: CanvasLayout, pageFooter: boolean) => {
    const lowest = Math.max(...layout.items.map((item) => { const box = drawnBox(item, layout); return box.y + box.h; }));
    return Math.round(lowest * 1000) - Math.round(pageFoot(pageFooter) * 1000);
  };
  /** The seeded stack as the seed builds it from its own render (`seedBolItems`, then the repeat), for
   *  a case the seed refuses and so answers no layout; and its lift, every block's drawn height less
   *  its rendered one, in thousandths. */
  const bolSeededStack = async (shipperId: string, config: TemplateConfig, logo?: Buffer) => {
    const { positions, pages } = await bolLaidOut(shipperId, config, { logo });
    expect(pages).toBe(1);
    const layout: CanvasLayout = { version: 1, items: withBolRepeat(seedBolItems(config, positions, logo !== undefined)) };
    let lift = 0;
    for (const key of ["consignee_ref", "trv", "freight"]) {
      const start = laid(positions, key === "consignee_ref" ? BOL_SEED_IDS.piece(key) : BOL_SEED_IDS.start(key));
      lift += bolBlock(layout, key).box.h - (laid(positions, BOL_SEED_IDS.end(key)).top - start.top);
    }
    return { layout, lift: Math.round(lift * 1000) };
  };
  /** A layout's items without their ids, which each seed draws afresh. */
  const bolStackOf = (layout: CanvasLayout) => layout.items.map((item) => ({ ...item, id: "" }));
  // Re-measured for owner ruling R1 of 2026-11-24 (the carrier's caption and the sidebar's moved beside
  // their rules, the paper a little shorter): at base 7.5 no whole clause line now lands the flow's end
  // within the shift of the foot, so each reproduction also sets the base size (the clause prints at the
  // small size, so the base size moves the stack above it a fraction of a line at a time). Measured: at
  // these base sizes 30 and 25 lines are the last the seed's render prints on one page, the canvas pages,
  // and the 6-order stack is drawn past the foot (311 and 218 thousandths).
  const reproductions = [
    ["Liberation Serif, page line off", "Liberation Serif", false, 30, 7.75],
    ["Liberation Sans, page line on", "Liberation Sans", true, 25, 7.55],
  ] as const;

  it.each(reproductions)(
    "a one-order shipment whose bill of lading prints one page in the seed's render and in its own flow, but whose seeded canvas prints two, is refused in the sentence that says the flow fits (%s, #947)",
    async (_why, family, pageFooter, lines, base) => {
      const { shipper } = await bolShipment();
      const config = withPropertyLines(lines, family, pageFooter, base);
      // The seed's own render and the shipment's flow each print one page; the stack the seed builds,
      // printed for the shipment, prints two.
      expect((await bolLaidOut(shipper.id, config)).pages).toBe(1);
      expect(await bolCanvasPages(shipper.id, config, null)).toBe(1);
      const { layout } = await bolSeededStack(shipper.id, config);
      expect(await bolCanvasPages(shipper.id, config, layout)).toBe(2);
      const t = await bolDraft(config);
      await expect(seedCanvasLayout(await readPreviewContext(t.id), { recordId: shipper.id, config }, "nobody"))
        .rejects.toMatchObject({ status: 400, message: bolFlowFits });
      // One line more prints two pages in the seed's render, refused in the page-count sentence.
      await expect(bolSeed(shipper.id, withPropertyLines(lines + 1, family, pageFooter, base)))
        .rejects.toMatchObject({ status: 400, message: bolTwoPages(2) });
    },
    60_000,
  );

  it.each(reproductions)(
    "the boundary: the longest property clause that seeds (%s) seeds a layout whose canvas, rendered directly, prints one page, as printBol prints it, and one line more is refused (#947)",
    async (_why, family, pageFooter, refusedAt, base) => {
      const { customer, shipper } = await bolShipment();
      const lines = refusedAt - 1;
      const config = withPropertyLines(lines, family, pageFooter, base);
      const layout = await bolSeed(shipper.id, config);
      const accepted = validateConfig("BOL", { ...config, layout });
      // One line more is refused by the seed in the sentence that says the flow fits (the case above),
      // so this is the boundary.
      await expect(bolSeed(shipper.id, withPropertyLines(lines + 1, family, pageFooter, base)))
        .rejects.toMatchObject({ status: 400, message: bolFlowFits });
      // The seeded canvas itself, rendered for the shipment, prints one page; and so does the
      // shipment's print under the template holding it.
      expect(await bolCanvasPages(shipper.id, config, layout)).toBe(1);
      await bolAssigned(customer.id, accepted);
      const { pdf } = await asSystem(() => printBol(shipper.id));
      expect(pageCount(pdf)).toBe(1);
    },
    60_000,
  );

  it("the invariant across the boundary: every property clause length either seeds a layout whose canvas prints one page, or is refused in the sentence that says the flow fits or the page-count one, under each page-line setting (#947)", async () => {
    const { shipper } = await bolShipment();
    // At the Serif reproduction's base size (above), where the flow-fits window lies on a whole line.
    const sweeps = [[false, [26, 27, 28, 29, 30, 31]], [true, [21, 22, 23, 24, 25, 26, 27]]] as const;
    const refused = new Set<string>();
    for (const [pageFooter, lengths] of sweeps) {
      let seeded = 0;
      for (const lines of lengths) {
        const config = withPropertyLines(lines, "Liberation Serif", pageFooter, reproductions[0][4]);
        const why = `${lines} lines, page line ${pageFooter ? "on" : "off"}`;
        let layout: CanvasLayout;
        try {
          layout = await bolSeed(shipper.id, config);
        } catch (err) {
          const message = (err as Error).message;
          // A one-order shipment's flow prints the seed's own one PO line, so where the seed's render
          // fits one page the flow does too and the drawn stack is never judged.
          expect([bolFlowFits, bolTwoPages(2)], why).toContain(message);
          refused.add(message);
          continue;
        }
        expect(await bolCanvasPages(shipper.id, config, layout), why).toBe(1);
        seeded += 1;
      }
      // Each page-line setting seeds at least one length, so the sweep reaches the seeding side too.
      expect(seeded, `page line ${pageFooter ? "on" : "off"}`).toBeGreaterThan(0);
    }
    // Both sentences are reached, so the sweep spans the boundary of each.
    expect(refused).toEqual(new Set([bolFlowFits, bolTwoPages(2)]));
  }, 300_000);

  // The row-floor lift draws the stack lower than it prints (#947's review). Judged by its drawn
  // bottoms, a stack drawn past the foot by less than the lift was refused though its canvas prints one
  // page. The seed now prints the canvas first and answers it, so that stack seeds. A whole-line sweep
  // steps past a window a seventh of a point wide (Serif's lift; Sans's is about a sixteenth); a
  // header-left logo's width moves the stack point for point (the logo is square, so its height
  // follows its width). So each case finds where the drawn bottom meets the foot from one stack well
  // inside it, and seeds half the lift past it.
  it.each([
    ["Liberation Serif, page line off", "Liberation Serif", false],
    ["Liberation Sans, page line on", "Liberation Sans", true],
  ] as const)("a stack drawn past the foot by less than the row-floor lift, whose canvas prints one page, seeds (%s, #947)", async (_why, family, pageFooter) => {
    const { shipper } = await bolShipment();
    const logo = alphaPng(40, 40);
    const configAt = (width: number) => {
      const config = withPropertyLines(4, family, pageFooter);
      config.logo = { placement: "header-left", width };
      return config;
    };
    const inside = await bolSeededStack(shipper.id, configAt(110), logo);
    expect(inside.lift).toBeGreaterThan(0);
    const width = Math.round((110 - (bolFootMargin(inside.layout, pageFooter) - inside.lift / 2) / 1000) * 1000) / 1000;
    const config = configAt(width);
    const { layout, lift } = await bolSeededStack(shipper.id, config, logo);
    // Drawn past the foot, by less than the lift.
    const margin = bolFootMargin(layout, pageFooter);
    expect(margin, `width ${width}`).toBeGreaterThan(0);
    expect(margin, `width ${width}`).toBeLessThan(lift);
    // The seed answers that very stack, and its canvas, rendered for the shipment, prints one page.
    expect(bolStackOf(await bolSeed(shipper.id, config, logo))).toEqual(bolStackOf(layout));
    expect(await bolCanvasPages(shipper.id, config, layout, logo)).toBe(1);
  }, 120_000);

  // In Roboto nothing is clamped, so there is no lift under the drawn stack: each block prints at its
  // rendered height, which its drawn one rounds to the nearest thousandth. A drawn bottom exactly on
  // the foot printed two canvas pages at some widths (#947's review, a 40 × 40 logo at header-left
  // about 121.329 pt wide). A whole-line sweep cannot reach that grain; the logo's width can, its
  // height following it point for point. So each case finds where the margin crosses the foot from
  // one seed well inside it, then sweeps the width in quarter-thousandths across it: every width
  // either seeds a layout whose canvas prints one page or is refused in the sentence that says the
  // flow fits (a one-order flow prints one page here), and both happen. The seed's answer is the
  // print's, not the drawn stack's, so `FIT_CLEARANCE`, which judges the drawn stack only where the
  // flow pages, plays no part here: the highest seeded bottom stands exactly on the foot in both cases
  // (measured), where the clearance used to hold every seeded bottom two thousandths above it.
  it.each([
    ["page line off, 6 lines", false, 6],
    ["page line on, 3 lines", true, 3],
  ] as const)("Roboto at the grain: every logo width across the foot seeds a layout whose canvas prints one page, or is refused in the sentence that says the flow fits (%s, #947)", async (_why, pageFooter, lines) => {
    const { customer, shipper } = await bolShipment();
    const logo = alphaPng(40, 40);
    const configAt = (width: number) => {
      const config = withPropertyLines(lines, "Roboto", pageFooter);
      config.logo = { placement: "header-left", width };
      return config;
    };
    // Well inside the foot, where the logo's height alone moves the stack.
    const inside = 110;
    const centre = inside - bolFootMargin(await bolSeed(shipper.id, configAt(inside), logo), pageFooter) / 1000;
    let highest: { margin: number; config: TemplateConfig; layout: CanvasLayout } | null = null;
    let refusals = 0;
    for (let step = -16; step <= 16; step++) {
      const width = Math.round((centre + step * 0.00025) * 100000) / 100000;
      const config = configAt(width);
      const why = `width ${width}`;
      let layout: CanvasLayout;
      try {
        layout = await bolSeed(shipper.id, config, logo);
      } catch (err) {
        expect((err as Error).message, why).toBe(bolFlowFits);
        refusals += 1;
        continue;
      }
      expect(await bolCanvasPages(shipper.id, config, layout, logo), why).toBe(1);
      const margin = bolFootMargin(layout, pageFooter);
      if (highest === null || margin > highest.margin) highest = { margin, config, layout };
    }
    expect(refusals).toBeGreaterThan(0);
    expect(highest?.margin).toBe(0);
    // The highest seeded layout, published and assigned, prints one page through printBol.
    await bolAssigned(customer.id, validateConfig("BOL", { ...highest!.config, layout: highest!.layout }), logo);
    const { pdf } = await asSystem(() => printBol(shipper.id));
    expect(pageCount(pdf)).toBe(1);
  }, 600_000);

  // The seed judges the stack with the PO list one line tall only where the flow pages; the picked
  // shipment's own list can wrap (#947's review). On paper the canvas grows by the wrap as the flow
  // does, and still stands the whole repeat shift lower than the flow from the first block down; under
  // a left slot taller than the right (a header-left logo) it grows by the whole wrap where the flow
  // grows inside the header's height. So a shipment whose real flow ends within that of the foot
  // seeded, and its canvas printed two pages where its flow prints one. The seed now prints the seeded
  // canvas for the shipment's own data, and refuses in the sentence that says the flow fits when that
  // pages and the shipment's flow does not. Each case pins its preconditions, so a metrics drift that
  // moves the window cannot leave it passing vacuously: the seed's render and the shipment's flow each
  // print one page, the seeded stack (the PO list one line tall) stands the clearance above the foot,
  // so the drawn-stack check would pass it, and the stack printed for the 6 orders pages.
  it.each([
    // The Standard, no logo: the wrap moves the flow and the canvas alike, and the canvas's shift is
    // the window (23 lines at base 7.5, re-measured for owner ruling R1 of 2026-11-24: the seeded stack
    // stands 43 pt above the foot and the 6 orders' canvas pages).
    ["the Standard, Liberation Serif, no logo", () => withPropertyLines(23, "Liberation Serif", false), undefined, (i: number) => `PO-LONG-NUMBER-${i}-XYZ`],
    // A header-left logo taller than the right slot: the flow takes the wrap inside the header's
    // height, the canvas below it (the implementer's fix-round-1 case; 7 lines since owner ruling R1 of
    // 2026-11-24, re-measured: the seeded stack 8.5 pt above the foot, the 6 orders' canvas two pages).
    ["Roboto, a header-left logo 120 wide", () => {
      const config = withPropertyLines(7, "Roboto", false);
      config.logo = { placement: "header-left", width: 120 };
      return config;
    }, alphaPng(40, 40), undefined],
  ] as const)("a 6-order shipment whose own PO list wraps, its flow one page and its seeded canvas two, is refused in the sentence that says the flow fits, its seeded stack inside the foot (%s, #947)", async (_why, configOf, logo, po) => {
    const config = configOf();
    const { shipper } = await bolShipment({ orders: 6, po });
    expect(await bolCanvasPages(shipper.id, config, null, logo)).toBe(1);
    const { layout } = await bolSeededStack(shipper.id, config, logo);
    expect(bolFootMargin(layout, config.pageFooter)).toBeLessThanOrEqual(-BOL_FIT_CLEARANCE);
    expect(await bolCanvasPages(shipper.id, config, layout, logo)).toBe(2);
    await expect(bolSeed(shipper.id, config, logo)).rejects.toMatchObject({ status: 400, message: bolFlowFits });
  }, 120_000);

  // Where the flow pages too, the print of the shipment's own data says nothing about the seeded
  // stack (the canvas pages as the flow does, §4.4 "When it pages"), so the seed judges the stack as
  // drawn, the PO list one line tall, against the foot (`fitsTheCanvas`, with its clearance). The
  // 6-order shipment's long POs page its flow; the reproductions' clauses put its seeded stack past the
  // foot, and one line fewer inside it.
  it.each(reproductions)(
    "a shipment whose flow and seeded canvas both page is judged by its drawn stack: drawn past the foot it is refused in the canvas sentence, and one line fewer seeds (%s, #947)",
    async (_why, family, pageFooter, lines, base) => {
      const { shipper } = await bolShipment({ orders: 6, po: (i) => `PO-LONG-NUMBER-${i}-XYZ` });
      const config = withPropertyLines(lines, family, pageFooter, base);
      // The seed's render fits one page (in `bolSeededStack`), the shipment's flow pages, the seeded
      // stack is drawn past the foot, and printed for the 6 orders it pages.
      expect(await bolCanvasPages(shipper.id, config, null)).toBeGreaterThan(1);
      const { layout } = await bolSeededStack(shipper.id, config);
      expect(bolFootMargin(layout, pageFooter)).toBeGreaterThan(0);
      expect(await bolCanvasPages(shipper.id, config, layout)).toBeGreaterThan(1);
      await expect(bolSeed(shipper.id, config)).rejects.toMatchObject({ status: 400, message: bolPastCanvas });
      // One line fewer: the flow and the canvas still page, and the stack, drawn inside the foot, seeds.
      const fewer = withPropertyLines(lines - 1, family, pageFooter, base);
      expect(await bolCanvasPages(shipper.id, fewer, null)).toBeGreaterThan(1);
      const inside = await bolSeededStack(shipper.id, fewer);
      expect(bolFootMargin(inside.layout, pageFooter)).toBeLessThanOrEqual(-BOL_FIT_CLEARANCE);
      expect(await bolCanvasPages(shipper.id, fewer, inside.layout)).toBeGreaterThan(1);
      expect(bolStackOf(await bolSeed(shipper.id, fewer))).toEqual(bolStackOf(inside.layout));
    },
    120_000,
  );

  // Owner ruling of 2026-11-15 on #943 ("One line, like PO"): the TRV list is laid out one line tall,
  // whatever the shipment's order count, as the PO list is (`seedPlaceholders`), so a long list grows
  // at print. Red when the seed lays out the shipment's own list: 22.266 pt at 30 orders, 44.531 at 80.
  it("lays the TRV list out one line tall at 1, 30 and 80 orders, and a 30- or 80-order print grows the block inside the page (#943)", async () => {
    const seeded: { layout: CanvasLayout; data: Awaited<ReturnType<typeof bolLaidOut>>["data"] }[] = [];
    for (const orders of [1, 30, 80]) {
      const { shipper } = await bolShipment({ orders });
      seeded.push({ layout: await bolSeed(shipper.id, bolCfg()), data: (await bolLaidOut(shipper.id, bolCfg())).data });
    }
    const [one, ...many] = seeded;
    const trvBox = bolBlock(one.layout, "trv").box;
    for (const s of many) {
      expect(bolBlock(s.layout, "trv").box).toEqual(trvBox);
      expect(bolBlock(s.layout, "freight").box).toEqual(bolBlock(one.layout, "freight").box);
    }
    // Printed for its own orders, the seeded canvas grows the TRV block past its one drawn line, every
    // number whole and in order inside the right margin, and nothing prints or strokes off the page.
    for (const s of many) {
      const { pdf, groups } = await renderSheetGroupsWithPositions([buildBolDefinition(s.data, { ...bolCfg(), layout: s.layout })]);
      const at = (id: string) => groups[0].positions.find((n) => n.id === id)!;
      const height = at(CANVAS_IDS.end("trv")).top - at(CANVAS_IDS.table("trv")).top;
      const runs = trvListRuns(pdf, 24 + BOL_WIDTHS.trvLabel);
      expect(runs.map((r) => r.text)).toEqual(wrappedRuns(s.data.orderNumbers));
      expect(height).toBeGreaterThan(trvBox.h + (trvLines(runs).length - 1) * 11 - 0.5);
      for (const r of runFonts(pdf)) {
        if (r.text === "") continue;
        const [family, face] = fontOf(r.font);
        expect(r.x, r.text).toBeGreaterThanOrEqual(24 - 0.01);
        expect(r.x + textWidthOf(r.text, family, face, r.size), r.text).toBeLessThanOrEqual(588 + TEXT_TOLERANCE);
      }
      textLinesWithY(pdf).forEach((lines, p) => {
        for (const l of lines) expect(PAGE_HEIGHT - l.y, `page ${p + 1}: ${l.text}`).toBeLessThanOrEqual(pageFoot(false));
      });
      strokedLines(pdf).forEach((strokes, p) => {
        for (const st of strokes) {
          expect(Math.min(st.x1, st.x2), `page ${p + 1}`).toBeGreaterThanOrEqual(24 - 0.5);
          expect(Math.max(st.x1, st.x2), `page ${p + 1}`).toBeLessThanOrEqual(588 + 0.5);
          expect(Math.max(st.y1, st.y2), `page ${p + 1}`).toBeLessThanOrEqual(pageFoot(false) + 0.5);   // top-down already
        }
      });
    }
  }, 300_000);

  it("an 80-order shipment seeds from a one-page render, and the seeded Standard printed for it pages with the number and (continued) on page 2, and with the page line on, the line under every body line (Review Focus 4)", async () => {
    const { customer, shipper } = await bolShipment({ orders: 80 });
    const seedRender = await bolLaidOut(shipper.id, bolCfg());
    const flowRender = await bolLaidOut(shipper.id, bolCfg(), { placeholders: false });
    // The controller's call: the seed's own render (the PO list one line tall) is what is refused
    // past one page, so the flow's own page count is on record beside it.
    console.log(`80-order bill of lading: the seed's render ${seedRender.pages} page(s), the flow's own ${flowRender.pages}`);
    expect(seedRender.pages).toBe(1);
    expect((await bolSeed(shipper.id, bolCfg())).items.length).toBeGreaterThan(0);

    // The build target: the Standard seeded from a one-order shipment of the same customer.
    const small = await bolShipment({ customer });
    const layout = await bolSeed(small.shipper.id, bolCfg());
    await bolAssigned(customer.id, validateConfig("BOL", { ...bolCfg(), layout }));
    const { pdf, bolNumber } = await asSystem(() => printBol(shipper.id));
    console.log(`80-order bill of lading under the seeded Standard: ${pageCount(pdf)} page(s)`);
    expect(pageCount(pdf)).toBe(2);
    const page2 = textLinesWithY(pdf)[1].map((l) => l.text);
    expect(page2.some((text) => text.includes(String(bolNumber)))).toBe(true);
    expect(page2).toContain("(continued)");

    // The same seed with the page line on, printed for the 80 orders again: page 2 holds the number,
    // "(continued)" and "Page 2 of 2" below the band's foot, and nothing else prints or strokes under it.
    const footed = { ...bolCfg(), pageFooter: true };
    const footedLayout = await bolSeed(small.shipper.id, footed);
    await bolAssigned(customer.id, validateConfig("BOL", { ...footed, layout: footedLayout }));
    const again = await asSystem(() => printBol(shipper.id));
    expect(again.bolNumber).toBe(bolNumber);
    console.log(`80-order bill of lading under the seeded Standard with the page line: ${pageCount(again.pdf)} page(s)`);
    expect(pageCount(again.pdf)).toBe(2);
    const lines = textLinesWithY(again.pdf)[1].map((l) => ({ text: l.text, top: PAGE_HEIGHT - l.y }));
    expect(lines.some((l) => l.text.includes(String(bolNumber)))).toBe(true);
    expect(lines.map((l) => l.text)).toContain("(continued)");
    const pageLines = lines.filter((l) => l.text.startsWith("Page "));
    expect(pageLines.map((l) => l.text)).toEqual(["Page 2 of 2"]);
    expect(pageLines[0].top).toBeGreaterThan(pageFoot(true));
    for (const line of lines) if (line !== pageLines[0]) expect(line.top).toBeLessThan(pageLines[0].top);
    for (const line of lines) if (line !== pageLines[0]) expect(line.top).toBeLessThanOrEqual(pageFoot(true));
    for (const stroke of strokedLines(again.pdf)[1]) expect(Math.max(stroke.y1, stroke.y2)).toBeLessThanOrEqual(pageFoot(true) + 0.5);
  }, 240_000);

  it("a taller left slot (a logo at header-left): the header's rule sits under the left slot by the flow's gap, nothing overlaps, and the print is the flow's plus the shift", async () => {
    const { customer, shipper } = await bolShipment();
    const config = bolCfg();
    config.logo = { placement: "header-left", width: DEFAULT_LOGO_WIDTH };
    const logo = alphaPng(160, 48);
    const layout = await bolSeed(shipper.id, config, logo);
    const { positions } = await bolLaidOut(shipper.id, config, { logo });

    const logoItem = layout.items.find((i) => i.kind === "logo");
    expect(logoItem?.box).toMatchObject({ x: 24, w: DEFAULT_LOGO_WIDTH });
    // The left slot is the taller: its title ends below the right slot's last rule.
    const titleEnd = laid(positions, BOL_SEED_IDS.end("title")).top;
    expect(titleEnd).toBeGreaterThan(laid(positions, BOL_SEED_IDS.end("scac_code")).top);
    const gap = laid(positions, BOL_SEED_IDS.piece("header_rule")).top - titleEnd;
    const shift = bolBlock(layout, "consignee_ref").box.y - laid(positions, BOL_SEED_IDS.piece("consignee_ref")).top;
    const [rule] = heavyRules(layout);
    const title = fieldItem(layout, "title")!;
    expect(drawnBox(rule, layout).y - (title.box.y + title.box.h)).toBeCloseTo(gap + shift, 2);

    const leftSlot = new Set(layout.items.filter((i) => i.kind === "logo" || (i.kind === "field" && ["original_label", "title"].includes(i.key))).map((i) => i.id));
    const meetings = canvasWarnings(layout, BOL_CONTRACT).filter((w) => w.itemIds.includes(rule.id) && w.itemIds.some((id) => leftSlot.has(id)));
    expect(meetings).toEqual([]);

    await bolGolden(customer.id, shipper.id, layout, config, logo);
  }, 60_000);

  it.each(FONT_FAMILIES.map((family) => [family]))(
    "under the %s family the seed answers a layout validateConfig accepts, every block at least the profile's row floor, or the one-page refusal",
    async (family) => {
      const { customer, shipper } = await bolShipment();
      const config = bolCfg();
      config.fonts.family = family;
      const flow = await bolLaidOut(shipper.id, config);
      const seeding = bolSeed(shipper.id, config);
      if (flow.pages > 1) {
        // Roboto Mono's wider glyphs put the one-order Standard on two pages: the seed refuses it, and
        // its sentence names the template's own settings, the remedy that works for every shipment.
        expect(family).toBe("Roboto Mono");
        await expect(seeding).rejects.toMatchObject({ status: 400, message: bolTwoPages(flow.pages) });
        return;
      }
      const layout = await seeding;
      expect(() => validateConfig("BOL", { ...config, layout })).not.toThrow();
      const floor = canvasProfile(BOL_CONTRACT).rowFloor;
      for (const table of bolTables(layout)) expect(table.box.h, `${family}: ${table.key}`).toBeGreaterThanOrEqual(floor);
      // The blocks after the PO block are drawn lower by its clamp (and the repeat shift), so the sheet,
      // which spaces them from its drawn bottom, prints them at the flow's place.
      const po = laid(flow.positions, BOL_SEED_IDS.end("consignee_ref")).top - laid(flow.positions, BOL_SEED_IDS.piece("consignee_ref")).top;
      const clamp = Math.max(0, floor - po);
      for (const key of ["trv", "freight"]) {
        expect(bolBlock(layout, key).box.y - laid(flow.positions, BOL_SEED_IDS.start(key)).top, `${family}: ${key}`)
          .toBeCloseTo(CANVAS_GRID - 3 + clamp, 2);
      }
      // The clamp moves no item below the PO block (they ride its rendered bottom); the blocks after it
      // print the clamp's hundredths of a point above their drawn tops, which warns of nothing and
      // prints the flow's paper.
      const { measured } = await seededPreviewWarnings((await bolDraft(config)).id, shipper.id, config);
      expect(measured).toEqual([]);
      await bolGolden(customer.id, shipper.id, layout, config);
    },
    120_000,
  );

  it("a logo at header-right: it heads the right slot at page-top, the layout validates and prints the flow's lines", async () => {
    const { customer, shipper } = await bolShipment();
    const config = bolCfg();
    config.logo = { placement: "header-right", width: DEFAULT_LOGO_WIDTH };
    const logo = alphaPng(160, 48);
    const layout = await bolSeed(shipper.id, config, logo);
    const { positions } = await bolLaidOut(shipper.id, config, { logo });
    const logoItem = layout.items.find((i) => i.kind === "logo");
    expect(logoItem).toMatchObject({ anchor: { kind: "page-top" }, box: { w: DEFAULT_LOGO_WIDTH } });
    expect(logoItem!.box.x).toBeCloseTo(laid(positions, BOL_SEED_IDS.piece("logo")).left, 3);
    expect(logoItem!.box.x).toBeGreaterThan(300);
    expect(() => validateConfig("BOL", { ...config, layout })).not.toThrow();
    await bolGolden(customer.id, shipper.id, layout, config, logo);
  }, 60_000);

  it("a reordered section list (the freight block before the TRV list): the blocks stack in the flow's order, validate and print the flow's lines", async () => {
    const { customer, shipper } = await bolShipment();
    const config = bolCfg();
    const keys = config.sections.map((sec) => sec.key);
    const freight = config.sections.splice(keys.indexOf("freight"), 1)[0];
    config.sections.splice(keys.indexOf("trv"), 0, freight);
    expect(config.sections.map((sec) => sec.key).indexOf("freight")).toBeLessThan(config.sections.map((sec) => sec.key).indexOf("trv"));
    const layout = await bolSeed(shipper.id, config);
    expect(bolTables(layout).map((t) => t.key)).toEqual(["consignee_ref", "freight", "trv"]);
    expect(() => validateConfig("BOL", { ...config, layout })).not.toThrow();
    await bolGolden(customer.id, shipper.id, layout, config);
  }, 60_000);

  it("allocates no BOL number: the shipment's stays null and the counter row is unchanged", async () => {
    const { shipper } = await bolShipment();
    const counter = () => prisma.setting.findUnique({ where: { key: "bol_number_next" } });
    const before = await counter();
    await bolSeed(shipper.id, bolCfg());
    expect((await prisma.shipper.findUniqueOrThrow({ where: { id: shipper.id } })).bolNumber).toBeNull();
    expect(await counter()).toEqual(before);
  }, 60_000);

  it("seedBolItems passes over a laid-out id outside the seed's namespace, and refuses by name a laid-out piece it has no item for, never dropping it", () => {
    const node = (id: string, top: number): LaidOutNode => ({ id, page: 1, left: 24, top });
    // The carrier is a ruled pair (owner ruling R1, 2026-11-24): its value column and its label column.
    const known = [
      node(BOL_SEED_IDS.piece("carrier_name"), 40), node(BOL_SEED_IDS.end("carrier_name"), 50),
      node(BOL_SEED_IDS.piece("carrier_name:label"), 40), node(BOL_SEED_IDS.end("carrier_name:label"), 49),
    ];
    expect(seedBolItems(bolCfg(), known, false).map((i) => (i.kind === "field" ? i.key : i.kind))).toEqual(["carrier_name"]);
    // An id the render reports that the seed did not place (a measurement id, say) seeds nothing.
    const foreign = [node("bol-measure", 30), ...known, node("other:end:carrier_name", 60)];
    expect(seedBolItems(bolCfg(), foreign, false).map((i) => (i.kind === "field" ? i.key : i.kind))).toEqual(["carrier_name"]);
    // The piece and its end mark both there, so `must()` answers and the chain itself is what refuses.
    const unknown = [...known, node(BOL_SEED_IDS.piece("stray"), 60), node(BOL_SEED_IDS.end("stray"), 70)];
    expect(() => seedBolItems(bolCfg(), unknown, false)).toThrow("The bill of lading's seed has no item for stray.");
  });

  it("bolRepeatShift: room already answers 0, a shortfall within a grid step answers it, and more than a grid step is refused by name", () => {
    const bottom = 52;
    expect(bolRepeatShift(bottom, bottom + CANVAS_GRID + 1)).toBe(0);
    expect(bolRepeatShift(bottom, bottom + CANVAS_GRID - 1.5)).toBeCloseTo(1.5, 3);
    expect(bolRepeatShift(bottom, bottom)).toBeCloseTo(CANVAS_GRID, 3);
    const refuse = () => bolRepeatShift(bottom, bottom - 2.5);
    expect(refuse).toThrow(HttpError);
    expect(refuse).toThrow(
      `The canvas cannot repeat the bill-of-lading number above the Consignee's ref/PO table: it needs the table ${CANVAS_GRID + 2.5} pt lower, more than one grid step.`,
    );
  });

  it("the route: no session is 401, templates.edit alone is 403 without shipping.view, both is 200 and nothing is written", async () => {
    const { shipper } = await bolShipment();
    const t = await bolDraft(bolCfg());
    const editOnly = await signInWith(["templates.edit"], "bol-seed-edit");
    const both = await signInWith(["templates.edit", "shipping.view"], "bol-seed-both");
    const ask = (cookie: string) => seedRoute(new Request(`http://t/api/templates/${t.id}/draft/canvas`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ recordId: shipper.id, config: bolCfg() }),
    }), { params: Promise.resolve({ id: t.id }) });

    expect((await ask("")).status).toBe(401);
    expect((await ask(editOnly)).status).toBe(403);
    const draft = () => prisma.documentTemplateVersion.findFirstOrThrow({ where: { templateId: t.id, status: "DRAFT" } });
    const before = await draft();
    const documents = await prisma.storedDocument.count();
    const audits = await prisma.auditLog.count();
    const res = await ask(both);
    expect(res.status).toBe(200);
    const layout = canvasLayoutSchema.parse(await res.json());
    expect(tablesByY(layout).map((table) => table.key)).toEqual(["consignee_ref", "trv", "freight"]);
    const after = await draft();
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.config).toEqual(before.config);
    expect(await prisma.storedDocument.count()).toBe(documents);
    expect(await prisma.auditLog.count()).toBe(audits);
  }, 60_000);

  it("a print's definition carries no seed id and prints the PO list; the seed's carries its ids and one blank PO line", () => {
    const data = { ...sampleBol(), poNumbers: ["PO-ALPHA", "", "PO-BRAVO"] };
    const json = (def: unknown) => JSON.stringify(def);
    const ids = (def: unknown) => json(def).match(/"seed:[^"]*"/g) ?? [];
    const plain = buildBolDefinition(data, bolCfg());
    expect(ids(plain)).toEqual([]);
    expect(json(plain)).toContain("PO-ALPHA, PO-BRAVO");
    const seeded = buildBolDefinition(data, bolCfg(), undefined, { seedIds: true, seedPlaceholders: true });
    expect(ids(seeded)).toContain(`"${BOL_SEED_IDS.piece("consignee_ref")}"`);
    expect(json(seeded)).not.toContain("PO-ALPHA");
  });
});

// ------------------------------------------------------------------------------------------------
// The certification's seed (design 2026-11-10 §5.3, §4.4; cert canvas PR 2, Task 5): a stand-in of
// the picked certification laid out once at its least, every block at least the row floor, the
// parties' right column anchored as the To block is, the company strip in the band, the order number
// repeated with no shift.
// ------------------------------------------------------------------------------------------------

const certCfg = (): TemplateConfig => structuredClone(CERT_DEFAULT_CONFIG);
/** Measured, pinned (design §4.5's predictions in brackets): the long fixture's flow pages [2]; how
 *  much lower the signature's rule prints on a cert with no freeform text [6 pt]; how much higher a
 *  cert that pages starts its page 1 than its flow print [16 pt]. */
const LONG_CERT_PAGES = 3;
const FREEFORM_RESIDUAL = 6;
const PAGED_RISE = 16;
const certFieldOf = (c: TemplateConfig, section: string, key: string) => fieldOf(c, section, key);

let certSeq = 0;

/** A part with a material, one process step and (unless `inspected` is false) one inspection
 *  requirement, the cert suites' shape. */
async function certPart(customerId: string, options: { inspected?: boolean; scope?: "SHIPMENT" } = {}) {
  certSeq += 1;
  const material = await prisma.material.create({ data: { name: `steel ${certSeq}` } });
  const part = await prisma.part.create({
    data: {
      customerId, partNumber: `SEED-HT-${certSeq}`, name: `Track Shoe ${certSeq}`, description: "D-001",
      eachWeight: "21.5000", materialId: material.id,
      ...(options.scope !== undefined ? { certRequired: true, certScope: options.scope } : {}),
    },
  });
  if (options.inspected !== false) {
    const scale = await prisma.inspectionScale.create({ data: { name: `HRC${certSeq}` } });
    const code = await prisma.inspectionCode.create({
      data: { name: `Were heat treated as per P.O. NONE (${certSeq})`, defaultScaleId: scale.id },
    });
    await prisma.partInspection.create({
      data: {
        partId: part.id, inspectionCodeId: code.id, scaleId: scale.id,
        min: "28.0000", max: "32.0000", sampleQty: "9", location: "flange OD", sort: 1,
      },
    });
  }
  const stepCode = await prisma.processStepCode.create({ data: { code: `CS-${certSeq}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({ data: { revisionId: rev.id, position: 1, codeId: stepCode.id, instruction: "Austenitize." } });
  return part;
}

/**
 * A real ORDER certification: a customer whose default bill-to row carries a name of its own (the
 * `attn` line, unless `attn` is false), `parts` part lines (each inspected unless `inspected` is
 * false), `readings` readings on the first requirement, `serials` serials on the first line, and the
 * freeform text. Readings are typed before any print.
 */
async function certOrder(options: {
  parts?: number; readings?: number; serials?: number; freeform?: string; attn?: boolean; inspected?: boolean;
} = {}) {
  certSeq += 1;
  const customer = await prisma.customer.create({ data: { code: `CS${certSeq}`, name: `Seed Cert Customer ${certSeq}` } });
  await prisma.customerAddress.create({
    data: {
      customerId: customer.id, kind: "BILL_TO", name: options.attn === false ? "" : "Accounts payable",
      street: "300 Example Way", city: "Anniston", state: "AL", zip: "36201", isDefault: true,
    },
  });
  const parts: { id: string }[] = [];
  for (let i = 0; i < (options.parts ?? 1); i++) parts.push(await certPart(customer.id, { inspected: options.inspected }));
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, poNumber: "DEMO-PO-24115",
    lines: parts.map((p) => ({ partId: p.id, qty: 192, weight: "4128.00" })),
  }));
  const cert = await asSystem(() => createCert({ orderId: order.id, scope: "ORDER" }));
  const readings = options.readings ?? 9;
  if (cert.requirements.length > 0 && readings > 0) {
    await asSystem(() => replaceReadings(cert.id, {
      requirements: [{
        id: cert.requirements[0].id,
        readings: Array.from({ length: readings }, (_, i) => ({ value: (28 + (i % 40) / 10).toFixed(1) })),
      }],
    }, { afterPrint: false }));
  }
  const serials = options.serials ?? 1;
  if (serials > 0) {
    await prisma.orderSerial.createMany({
      data: Array.from({ length: serials }, (_, i) => ({
        orderId: order.id, lineId: order.lines[0].id, position: i + 1, serial: `SN-${i + 1}`, description: `Heat ${i + 1}`,
      })),
    });
  }
  const freeform = options.freeform ?? "FREEFORM BLOCK UNDER TEST";
  if (freeform !== "") await asSystem(() => updateCert(cert.id, { freeform }));
  return { customer, order, cert };
}

/** A signer: with a signature image unless `image` is false, and a title when given. */
async function certSigner(options: { image?: boolean; title?: string } = {}) {
  certSeq += 1;
  return prisma.user.create({
    data: {
      username: `cert-seed-${certSeq}`, displayName: "Quality Signer", passwordHash: "x", title: options.title ?? "",
      ...(options.image === false ? {} : { signatureImage: new Uint8Array(alphaPng(120, 40)), signatureMimeType: "image/png" }),
    },
  });
}

/** A CERT template whose v1 draft holds `config` (and the logo, when given). */
async function certDraft(config: TemplateConfig, logo?: Buffer) {
  certSeq += 1;
  const t = await asSystem(() => createTemplate("CERT", `Seed Cert ${certSeq}`));
  await asSystem(() => editDraft(t.id, { config, updatedAt: t.draft.updatedAt }));
  if (logo) await asSystem(() => uploadLogo(t.id, logo, "image/png"));
  return t;
}

/** Publishes `config` as a CERT template, the logo with it, and assigns it to the customer. */
async function certAssigned(customerId: string, config: TemplateConfig, logo?: Buffer) {
  const t = await certDraft(config, logo);
  await asSystem(() => publishDraft(t.id));
  await asSystem(() => assignTemplate(customerId, "CERT", t.id));
  return t;
}

/** The seed for `config`, as the editor of a CERT draft holding it would ask for it, signed by `signerId`. */
async function certSeed(certId: string, config: TemplateConfig, signerId: string, logo?: Buffer): Promise<CanvasLayout> {
  const t = await certDraft(config, logo);
  return seedCanvasLayout(await readPreviewContext(t.id), { recordId: certId, config }, signerId);
}

/** The flow's certification under `config`, rendered as the preview renders it (no print). */
async function certFlowPdf(certId: string, signerId: string, config: TemplateConfig = certCfg()) {
  const settings = await certPrintSettings();
  const signer = await prisma.user.findUniqueOrThrow({ where: { id: signerId } });
  const { data } = await readCertPdfData(prisma, certId, { ...settings, statement: config.textBlocks.cert_statement }, signer, "2026-08-06");
  return renderPdf(buildCertDefinition(data, config));
}

/** The flow's and the canvas's certifications compared (design §5.3's acceptance, the bill of lading's
 *  comparison with no shift): printed lines grouped by baseline top to bottom, the same text, each
 *  within 2 pt of the flow's, in the flow's fonts and sizes and at its x within 2 pt; the same merged
 *  strokes within 1 pt; the same image paints. */
function expectSameCert(flow: Buffer, canvas: Buffer) {
  expectSameBol(flow, canvas, { version: 1, items: [] }, 0);
}

/** Prints the cert under the customer's flow template (the Standard when `flowConfig` is omitted),
 *  then under a template holding `layout` over `canvasConfig` (default: the flow config), and
 *  compares the two papers. */
async function certGolden(
  customerId: string, certId: string, signerId: string, layout: CanvasLayout,
  options: { flowConfig?: TemplateConfig; canvasConfig?: TemplateConfig; logo?: Buffer } = {},
) {
  const config = options.flowConfig ?? certCfg();
  if (options.flowConfig) await certAssigned(customerId, options.flowConfig, options.logo);
  const flow = await asSystem(() => printCert(certId, signerId));
  await certAssigned(customerId, validateConfig("CERT", { ...(options.canvasConfig ?? config), layout }), options.logo);
  const canvas = await asSystem(() => printCert(certId, signerId));
  expectSameCert(flow.pdf, canvas.pdf);
  return { flow: flow.pdf, canvas: canvas.pdf };
}

const certBlock = (layout: CanvasLayout, key: string) => {
  const t = tablesByY(layout).find((table) => table.key === key);
  if (t === undefined) throw new Error(`The layout has no ${key} block`);
  return t;
};
const CERT_BLOCKS = ["to", "parts", "statement", "requirements", "serials", "freeform", "signature"];
/** The warnings the seeded Standard draws through the preview's measure on a one-page certification
 *  (design §5.3's accepted set): none, as the run reported it; listed in Task 6's report for the
 *  controller to accept or rule on. */
const CERT_ACCEPTED_WARNINGS: ReturnType<typeof namedWarnings> = [];
const CERT_FLOOR = canvasProfile(CERT_CONTRACT).rowFloor;
/** The seed's one-page refusal (the plan's call), naming the template's settings. */
const certTwoPages = (pages: number) =>
  `The canvas starts from a one-page certification; laid out at its least, this template's certification prints ${pages} pages. Change this template's settings (its font, sizes, logo or certification statement) so it fits one page.`;
/** The seed's canvas refusal: the stand-in prints one page in the flow, but its drawn stack runs past
 *  the canvas's one page (the page line among the settings named). */
const certPastCanvas =
  "The canvas starts from a one-page certification; laid out at its least on the canvas, this template's certification runs past one page. Change this template's settings (its font, sizes, logo, page line or certification statement) so it fits one page.";
/** The seed's header refusal: a header column the template's settings leave no width. */
const certHeaderTooWide =
  "The canvas starts from a certification whose header fits the page; laid out at its least, this template's header runs past the page's right margin. Change this template's settings (its logo's width, font or heading size) so the header fits the page's width.";
/** The seed's parties refusal: the parties' right column pushed past the page's right margin. */
const certPartiesTooWide =
  "The canvas starts from a certification whose To / order fields fit the page; laid out at its least, this template's To / order fields run past the page's right margin. Change this template's settings (its font, sizes or To label) so they fit the page's width.";
const bandItems = (layout: CanvasLayout) => fields(layout).filter((i) => i.anchor.kind === "page-bottom");
/** The figures the seed places by, from the flow's and the page's constants (never retyped). */
const CW = CERT_WIDTHS;
const MARGIN = CANVAS_PAGE.margin;
const RIGHT_EDGE = CANVAS_PAGE.width - CANVAS_PAGE.margin;
const TO_WIDTH = CONTENT_WIDTH - CW.partiesRight - CW.partiesGap;
const SIGNATURE_X = RIGHT_EDGE - CW.signature;
const PARTIES_RIGHT_X = RIGHT_EDGE - CW.partiesRight;
const HEADER_RIGHT_X = RIGHT_EDGE - CW.headerRight;
const centreWidth = (left: number) => CONTENT_WIDTH - left - CW.headerRight - 2 * CW.headerGap;
/** The flow's strip top: the page less its bottom margin, plus the strip's inset (754). */
const STRIP_TOP = CANVAS_PAGE.height - CERT_PAGE.bottomMargin + CERT_PAGE.stripInset;
const ADDRESS_BESIDE_PHONE = CONTENT_WIDTH - CW.footerPhone;
const PHONE_X = RIGHT_EDGE - CW.footerPhone;

/** The signature's rule on a page: the 1 pt stroke `CERT_WIDTHS.signature` long, its y from the
 *  page's top (the stroke reader's own frame). */
function signatureRuleY(pdf: Buffer, page = 0): number {
  const rules = strokedLines(pdf)[page].filter((s) => Math.abs(s.width - 1) < 0.01 && Math.abs(Math.abs(s.x2 - s.x1) - CERT_WIDTHS.signature) < 1);
  expect(rules).toHaveLength(1);
  return rules[0].y1;
}

/** A page's printed lines (baseline from the page's top), top to bottom. */
const pageLines = (pdf: Buffer, page: number) =>
  linesOfRuns(styledRuns(pdf)[page]).map((l) => ({ text: l.text, top: PAGE_HEIGHT - l.y }));

describe("seedCertLayout: a certification draft seeds its canvas from a stand-in laid out at its least", () => {
  it("answers a layout validateConfig accepts: the seven blocks stacked, the right column beside the To block, the rule below it, the strip in the band, the order number repeating", async () => {
    const { cert } = await certOrder();
    const signer = await certSigner();
    const layout = await certSeed(cert.id, certCfg(), signer.id);

    expect(canvasLayoutSchema.parse(layout)).toEqual(layout);
    expect(() => validateConfig("CERT", { ...certCfg(), layout })).not.toThrow();
    expect(new Set(layout.items.map((i) => i.id)).size).toBe(layout.items.length);
    expect(tablesByY(layout).map((t) => t.key)).toEqual(CERT_BLOCKS);
    expect(certBlock(layout, "to").box).toMatchObject({ x: MARGIN, w: TO_WIDTH });
    expect(certBlock(layout, "signature").box).toMatchObject({ x: SIGNATURE_X, w: CW.signature });
    for (const key of ["parts", "statement", "requirements", "serials", "freeform"]) {
      expect(certBlock(layout, key).box, key).toMatchObject({ x: MARGIN, w: CONTENT_WIDTH });
    }
    for (const key of ["po_number", "packing_list_no", "material"]) {
      expect(fieldItem(layout, key), key).toMatchObject({ anchor: { kind: "page-top" }, box: { x: PARTIES_RIGHT_X, w: CW.partiesRight } });
    }
    const rule = layout.items.find((i) => i.kind === "line")!;
    expect(rule).toMatchObject({ anchor: { kind: "below-table", table: "to" }, weight: 1.5, box: { x: MARGIN, w: CONTENT_WIDTH, h: 0 } });
    expect(fieldItem(layout, "company_name")).toMatchObject({
      box: { x: MARGIN + CW.headerLeft + CW.headerGap, w: centreWidth(CW.headerLeft) }, style: { size: 12, bold: true, align: "center" },
    });
    expect(fieldItem(layout, "order_no")).toMatchObject({
      repeat: true, box: { x: HEADER_RIGHT_X, w: CW.headerRight }, style: { size: 10.5, bold: true, align: "left" },
    });
    const band = bandItems(layout);
    expect(band.map((i) => [i.key, i.box.x, i.box.y, i.box.w, i.repeat])).toEqual([
      ["footer_address", MARGIN, STRIP_TOP, ADDRESS_BESIDE_PHONE, true], ["footer_phone", PHONE_X, STRIP_TOP, CW.footerPhone, true],
    ]);
    // Each strip item's height is its own laid-out line, never a grid step.
    for (const item of band) {
      expect(item.box.h).toBeGreaterThan(CERT_DEFAULT_CONFIG.fonts.smallSize);
      expect(item.box.h).toBeLessThan(2 * CERT_DEFAULT_CONFIG.fonts.smallSize);
    }
    expect(band.map((i) => i.style)).toEqual([
      { size: CERT_DEFAULT_CONFIG.fonts.smallSize, bold: false, align: "left" },
      { size: CERT_DEFAULT_CONFIG.fonts.smallSize, bold: true, align: "right" },
    ]);
  }, 60_000);

  it("golden: on the Standard with a typed statement, a cert printing every piece on one page prints the flow's lines and strokes under its seed", async () => {
    const { customer, cert } = await certOrder({ parts: 2, readings: 9, serials: 2 });
    const signer = await certSigner();
    const config = certCfg();
    config.textBlocks.cert_statement = "We certify the TYPED statement.\n\nIts second paragraph, after a blank line.";
    const flow = await certFlowPdf(cert.id, signer.id, config);
    expect(pageCount(flow)).toBe(1);
    const text = drawnText(flow);
    for (const piece of ["Accounts payable", "SN-1", "SN-2", "FREEFORM BLOCK UNDER TEST", "TYPED statement", "28.0   |   28.1   |   28.2"]) {
      expect(text, piece).toContain(piece);
    }
    const layout = await certSeed(cert.id, config, signer.id);
    const { flow: printed } = await certGolden(customer.id, cert.id, signer.id, layout, { flowConfig: config });
    // The strokes compared include the parties' rule (1.5 pt, the content's width), the parts table's rules and
    // the signature's rule.
    const ink = strokedLines(printed)[0];
    expect(ink.some((s) => Math.abs(s.width - 1.5) < 0.01 && Math.abs(Math.abs(s.x2 - s.x1) - CONTENT_WIDTH) < 1)).toBe(true);
    expect(signatureRuleY(printed)).toBeGreaterThan(0);
  }, 60_000);

  it("each block at its stand-in's least: a long cert seeds every block as tall as a one-page cert seeds it", async () => {
    const long = await certOrder({ readings: 100, serials: 50, freeform: "Freeform words run on. ".repeat(130).slice(0, 3000) });
    const short = await certOrder();
    const signer = await certSigner();
    expect(pageCount(await certFlowPdf(long.cert.id, signer.id))).toBe(LONG_CERT_PAGES);
    const a = await certSeed(long.cert.id, certCfg(), signer.id);
    const b = await certSeed(short.cert.id, certCfg(), signer.id);
    for (const key of CERT_BLOCKS) expect(certBlock(a, key).box.h, key).toBeCloseTo(certBlock(b, key).box.h, 2);
  }, 120_000);

  it("placeholders: a cert with no requirements, serials or freeform text seeds all seven blocks; the multi-part heading alone seeds the requirements block taller than the floor", async () => {
    const { cert } = await certOrder({ inspected: false, serials: 0, freeform: "" });
    const signer = await certSigner();
    const layout = await certSeed(cert.id, certCfg(), signer.id);
    expect(tablesByY(layout).map((t) => t.key)).toEqual(CERT_BLOCKS);
    expect(() => validateConfig("CERT", { ...certCfg(), layout })).not.toThrow();

    const config = certCfg();
    certFieldOf(config, "requirements", "spec_line").visible = false;
    certFieldOf(config, "requirements", "readings").visible = false;
    const headingOnly = await certSeed(cert.id, config, signer.id);
    expect(certBlock(headingOnly, "requirements").box.h).toBeGreaterThan(CERT_FLOOR);
    expect(certBlock(headingOnly, "requirements").columns.map((c) => [c.key, c.visible]))
      .toEqual([["part_heading", true], ["spec_line", false], ["readings", false]]);
  }, 60_000);

  it("the clamp: every signature row hidden seeds the signature block at the row floor with every row hidden", async () => {
    const { cert } = await certOrder();
    const signer = await certSigner();
    const config = certCfg();
    for (const key of ["signature_mark", "signer_name", "signer_title", "signer_company"]) certFieldOf(config, "signature", key).visible = false;
    const layout = await certSeed(cert.id, config, signer.id);
    const block = certBlock(layout, "signature");
    expect(block.box.h).toBe(CERT_FLOOR);
    expect(block.columns.map((c) => [c.key, c.visible])).toEqual([
      ["signature_mark", false], ["signer_name", false], ["signer_title", false], ["signer_company", false],
    ]);
    expect(() => validateConfig("CERT", { ...config, layout })).not.toThrow();
  }, 60_000);

  it("the clamp and lift: every parts column hidden seeds the part lines at the row floor, draws the statement lower by the clamp, and prints the flow's lines", async () => {
    const { customer, cert } = await certOrder();
    const signer = await certSigner();
    const config = certCfg();
    for (const key of ["part_qty", "part_identity", "part_pounds"]) certFieldOf(config, "parts", key).visible = false;
    const layout = await certSeed(cert.id, config, signer.id);
    const parts = certBlock(layout, "parts");
    expect(parts.box.h).toBe(CERT_FLOOR);
    expect(parts.columns.map((c) => [c.key, c.visible])).toEqual([["part_qty", false], ["part_identity", false], ["part_pounds", false]]);
    // The part lines lay out 0 tall between their marks, so the statement's drawn top is the clamp
    // (the floor) lower than its laid-out top: its drawn distance from the part lines' drawn bottom is
    // the statement's own 2 pt top margin, the flow's.
    const statement = certBlock(layout, "statement");
    const statementTopMargin = (CERT_FLOW.statementNode(sampleCert()) as { margin: number[] }).margin[1];
    expect(statementTopMargin).toBeGreaterThan(0);
    expect(statement.box.y - (parts.box.y + parts.box.h)).toBeCloseTo(statementTopMargin, 3);
    await certGolden(customer.id, cert.id, signer.id, layout, { flowConfig: config });
  }, 60_000);

  it.each(FONT_FAMILIES.map((family) => [family]))(
    "under the %s family the seeded Standard is accepted, every block at least the row floor",
    async (family) => {
      const { cert } = await certOrder();
      const signer = await certSigner();
      const config = certCfg();
      config.fonts.family = family;
      const layout = await certSeed(cert.id, config, signer.id);
      expect(() => validateConfig("CERT", { ...config, layout })).not.toThrow();
      for (const table of tablesByY(layout)) expect(table.box.h, `${family}: ${table.key}`).toBeGreaterThanOrEqual(CERT_FLOOR);
    },
    60_000,
  );

  // #960 (controller's ruling A, 2026-11-12): in Roboto, the Standard's face, the serials meet the
  // requirements with a thousandth rounded the wrong way and `sealed` moves them down 0.001 pt; the
  // carried shift moves the freeform and signature blocks with them, so the serials-to-freeform gap is
  // the flow's 6 pt, where moving the serials alone drew 5.999 (freeform 274.775, signature 309.908).
  // Liberation Serif and Roboto Mono move no block, with or without the carry.
  it.each([
    ["Roboto", { serials: 239.682, freeform: 274.776, signature: 309.909 }],
    ["Liberation Serif", { serials: 232.076, freeform: 266.009, signature: 300.53 }],
    ["Roboto Mono", { serials: 257.024, freeform: 294.763, signature: 331.292 }],
  ] as const)("the carried shift (#960): in %s the Standard seeds the serials, freeform and signature where pinned", async (family, at) => {
    const { cert } = await certOrder();
    const signer = await certSigner();
    const config = certCfg();
    config.fonts.family = family;
    const layout = await certSeed(cert.id, config, signer.id);
    const block = (key: string) => tablesByY(layout).find((t) => t.key === key)!.box;
    expect(block("serials").y).toBe(at.serials);
    expect(block("freeform").y).toBe(at.freeform);
    expect(block("signature").y).toBe(at.signature);
    if (family === "Roboto") {
      expect(block("freeform").y - (block("serials").y + block("serials").h)).toBeCloseTo(6, 6);
    }
  }, 60_000);

  it.each([["header-left"], ["header-center"], ["header-right"]] as const)(
    "a logo at %s seeds a logo item where the flow printed it, and the seeded canvas prints the flow's paper",
    async (placement) => {
      const { customer, cert } = await certOrder();
      const signer = await certSigner();
      const config = certCfg();
      config.logo = { placement, width: DEFAULT_LOGO_WIDTH };
      const logo = alphaPng(160, 48);
      const layout = await certSeed(cert.id, config, signer.id, logo);
      const logoItem = layout.items.find((i) => i.kind === "logo");
      expect(logoItem).toMatchObject({ anchor: { kind: "page-top" }, box: { w: DEFAULT_LOGO_WIDTH } });
      const centre = centreWidth(placement === "header-left" ? DEFAULT_LOGO_WIDTH : CW.headerLeft);
      expect(fieldItem(layout, "company_name")!.box.w).toBe(centre);
      expect(fieldItem(layout, "title")!.box.w).toBe(centre);
      await certGolden(customer.id, cert.id, signer.id, layout, { flowConfig: config, logo });
    },
    60_000,
  );

  // The width is the template's settings' too (the whole-branch review's reproductions, and the To
  // label beside them): a header-left logo wider than the centre column's room, a header-center logo
  // wide enough to push the right column past the page's right margin, a monospaced title at a heading
  // size whose one word does the same, and a To label of one long word that pushes the parties' right
  // column. Each is a 400 in the seed's own sentence, never the canvas rules' raw refusal.
  it.each([
    ["a header-left logo 400 pt wide", (c: TemplateConfig) => { c.logo = { placement: "header-left", width: 400 }; }, certHeaderTooWide],
    ["a header-center logo 500 pt wide", (c: TemplateConfig) => { c.logo = { placement: "header-center", width: 500 }; }, certHeaderTooWide],
    ["Roboto Mono at heading size 60", (c: TemplateConfig) => { c.fonts.family = "Roboto Mono"; c.fonts.headingSize = 60; }, certHeaderTooWide],
    ["a To label of 80 W's", (c: TemplateConfig) => { certFieldOf(c, "parties", "to").label = "W".repeat(80); }, certPartiesTooWide],
  ] as const)("a layout that does not fit the page's width (%s) is refused in the seed's own sentence", async (_why, settings, message) => {
    const { cert } = await certOrder();
    const signer = await certSigner();
    const config = certCfg();
    settings(config);
    const logo = config.logo === null ? undefined : alphaPng(160, 48);
    const t = await certDraft(config, logo);
    await expect(seedCanvasLayout(await readPreviewContext(t.id), { recordId: cert.id, config }, signer.id))
      .rejects.toMatchObject({ status: 400, message });
  }, 60_000);

  it("the strip with Page N of M on: its bottom at the page's foot with the line's room, the two tops level", async () => {
    const { cert } = await certOrder();
    const signer = await certSigner();
    const config = certCfg();
    config.pageFooter = true;
    const layout = await certSeed(cert.id, config, signer.id);
    const band = bandItems(layout);
    expect(band.map((i) => i.key)).toEqual(["footer_address", "footer_phone"]);
    expect(band[0].box.y).toBe(band[1].box.y);
    expect(Math.max(...band.map((i) => i.box.y + i.box.h))).toBeCloseTo(pageFoot(true), 3);
    expect(() => validateConfig("CERT", { ...config, layout })).not.toThrow();
  }, 60_000);

  it("the strip: a two-line company address seeds its bottom at the foot, the phone's top level with it; seeded with the page line off, turning it on is refused naming the address", async () => {
    const { cert } = await certOrder();
    const signer = await certSigner();
    const one = bandItems(await certSeed(cert.id, certCfg(), signer.id));
    await asSystem(() => setSetting("company_address", "100 Example Way\nAnniston AL 36207"));
    const layout = await certSeed(cert.id, certCfg(), signer.id);
    const [address, phone] = bandItems(layout);
    expect(address.box.h).toBeGreaterThan(1.8 * one[0].box.h);
    expect(address.box.y + address.box.h).toBeCloseTo(pageFoot(false), 3);
    expect(phone.box.y).toBe(address.box.y);
    expect(phone.box.h).toBeCloseTo(one[1].box.h, 3);
    expect(() => validateConfig("CERT", { ...certCfg(), layout })).not.toThrow();

    const standard = await certSeed(cert.id, certCfg(), signer.id);
    const refusal = canvasRefusal(standard, CERT_CONTRACT, { pageFooter: true });
    expect(refusal?.itemIds).toEqual([bandItems(standard)[0].id]);
    const standardAddress = bandItems(standard)[0];
    expect(standardAddress.box.y + standardAddress.box.h).toBeCloseTo(pageFoot(false), 3);
    expect(refusal?.sentence).toBe(`The Company address field lies outside the page: its bottom edge is at ${
      Math.round((standardAddress.box.y + standardAddress.box.h) * 100) / 100} pt, past ${pageFoot(true)}, where the page line's room begins.`);
  }, 60_000);

  it.each([
    ["the phone hidden", ["footer_phone"], [["footer_address", MARGIN, CONTENT_WIDTH]]],
    ["the address hidden", ["footer_address"], [["footer_phone", MARGIN, CW.footerPhone]]],
    ["the right parties column hidden", ["po_number", "packing_list_no", "material"],
      [["footer_address", MARGIN, ADDRESS_BESIDE_PHONE], ["footer_phone", PHONE_X, CW.footerPhone]]],
  ] as const)("%s: the strip seeds at the flow's columns and the canvas prints the flow's paper", async (_name, hidden, strip) => {
    const { customer, cert } = await certOrder();
    const signer = await certSigner();
    const config = certCfg();
    for (const key of hidden) certFieldOf(config, key.startsWith("footer") ? "footer" : "parties", key).visible = false;
    const layout = await certSeed(cert.id, config, signer.id);
    expect(bandItems(layout).map((i) => [i.key, i.box.x, i.box.w])).toEqual(strip);
    expect(certBlock(layout, "to").box.w).toBe((hidden as readonly string[]).includes("po_number") ? CONTENT_WIDTH : TO_WIDTH);
    await certGolden(customer.id, cert.id, signer.id, layout, { flowConfig: config });
  }, 60_000);

  it.each([
    ["the phone alone", ["footer_address"], [["footer_phone", MARGIN, CW.footerPhone]], false],
    ["the address alone", ["footer_phone"], [["footer_address", MARGIN, CONTENT_WIDTH]], false],
    ["a two-line address beside the phone", [], [["footer_address", MARGIN, ADDRESS_BESIDE_PHONE], ["footer_phone", PHONE_X, CW.footerPhone]], true],
  ] as const)("with Page N of M on, %s: the strip seeds at the flow's columns, its tops level and the taller's bottom at the line's foot", async (_name, hidden, strip, twoLines) => {
    const { cert } = await certOrder();
    const signer = await certSigner();
    if (twoLines) await asSystem(() => setSetting("company_address", "100 Example Way\nAnniston AL 36207"));
    const config = certCfg();
    config.pageFooter = true;
    for (const key of hidden) certFieldOf(config, "footer", key).visible = false;
    const layout = await certSeed(cert.id, config, signer.id);
    const band = bandItems(layout);
    expect(band.map((i) => [i.key, i.box.x, i.box.w])).toEqual(strip);
    expect(new Set(band.map((i) => i.box.y)).size).toBe(1);
    expect(Math.max(...band.map((i) => i.box.y + i.box.h))).toBeCloseTo(pageFoot(true), 3);
    expect(() => validateConfig("CERT", { ...config, layout })).not.toThrow();
  }, 60_000);

  it("the footer section hidden seeds no band item", async () => {
    const { cert } = await certOrder();
    const signer = await certSigner();
    const config = certCfg();
    config.sections.find((s) => s.key === "footer")!.visible = false;
    const layout = await certSeed(cert.id, config, signer.id);
    expect(layout.items.filter((i) => i.kind !== "table" && i.anchor.kind === "page-bottom")).toEqual([]);
    expect(() => validateConfig("CERT", { ...config, layout })).not.toThrow();
  }, 60_000);

  it.each([
    ["the To box", "parties", "to"], ["the serial numbers", "serials", "serials"], ["the freeform text", "freeform", "freeform"],
  ] as const)("%s hidden seeds no block for it, a layout the rules accept, and the flow's paper", async (_name, section, key) => {
    const { customer, cert } = await certOrder();
    const signer = await certSigner();
    const config = certCfg();
    certFieldOf(config, section, key).visible = false;
    const layout = await certSeed(cert.id, config, signer.id);
    expect(tablesByY(layout).map((t) => t.key)).toEqual(CERT_BLOCKS.filter((block) => block !== key));
    expect(() => validateConfig("CERT", { ...config, layout })).not.toThrow();
    if (key === "to") {
      // No To block: the right column is the parties' only column, at the left margin and page-top by
      // the walk, and the parties' rule page-top below it.
      for (const field of ["po_number", "packing_list_no", "material"]) {
        expect(fieldItem(layout, field), field).toMatchObject({ anchor: { kind: "page-top" }, box: { x: MARGIN, w: CW.partiesRight } });
      }
      const rule = layout.items.find((i) => i.kind === "line")!;
      expect(rule.anchor).toEqual({ kind: "page-top" });
      expect(rule.box.y).toBeGreaterThan(fieldItem(layout, "material")!.box.y);
    }
    await certGolden(customer.id, cert.id, signer.id, layout, { flowConfig: config });
  }, 60_000);

  it.each([["statement"], ["requirements"], ["signature"]] as const)(
    "the %s section hidden seeds no block for it, a layout the rules accept, and the flow's paper",
    async (key) => {
      const { customer, cert } = await certOrder();
      const signer = await certSigner();
      const config = certCfg();
      config.sections.find((s) => s.key === key)!.visible = false;
      const layout = await certSeed(cert.id, config, signer.id);
      expect(tablesByY(layout).map((t) => t.key)).toEqual(CERT_BLOCKS.filter((block) => block !== key));
      expect(() => validateConfig("CERT", { ...config, layout })).not.toThrow();
      await certGolden(customer.id, cert.id, signer.id, layout, { flowConfig: config });
    },
    60_000,
  );

  it("the repeat: the order number repeats on the Standard and printed last in its column; nothing repeats with it hidden or printed below the part lines", async () => {
    const { cert } = await certOrder();
    const signer = await certSigner();
    const repeated = (layout: CanvasLayout) => layout.items.filter((i) => i.repeat && i.anchor.kind !== "page-bottom")
      .map((i) => (i.kind === "field" ? i.key : i.kind));
    expect(repeated(await certSeed(cert.id, certCfg(), signer.id))).toEqual(["order_no"]);

    const last = certCfg();
    const header = last.sections.find((s) => s.key === "header")!;
    header.fields = ["company_name", "title", "print_date", "entry_date", "order_no"].map((k) => header.fields.find((f) => f.key === k)!);
    const lastLayout = await certSeed(cert.id, last, signer.id);
    expect(repeated(lastLayout)).toEqual(["order_no"]);
    expect(() => validateConfig("CERT", { ...last, layout: lastLayout })).not.toThrow();

    const hidden = certCfg();
    certFieldOf(hidden, "header", "order_no").visible = false;
    expect(repeated(await certSeed(cert.id, hidden, signer.id))).toEqual([]);

    const below = certCfg();
    const parts = below.sections.find((s) => s.key === "parts")!;
    below.sections = [parts, ...below.sections.filter((s) => s.key !== "parts")];
    const belowLayout = await certSeed(cert.id, below, signer.id);
    expect(fieldItem(belowLayout, "order_no")!.anchor).toEqual({ kind: "below-table", table: "parts" });
    expect(repeated(belowLayout)).toEqual([]);
    expect(() => validateConfig("CERT", { ...below, layout: belowLayout })).not.toThrow();
  }, 60_000);

  it("a typed label and a hidden field survive the seed and print: the To label, the serials heading, a column label, a hidden quantity column and a hidden title row", async () => {
    const { customer, cert } = await certOrder();
    const signer = await certSigner({ title: "Production Manager" });
    const config = certCfg();
    certFieldOf(config, "parties", "to").label = "Sold To:";
    certFieldOf(config, "serials", "serials").label = "Heat lots";
    certFieldOf(config, "parts", "part_pounds").label = "Weight";
    certFieldOf(config, "parts", "part_qty").visible = false;
    certFieldOf(config, "signature", "signer_title").visible = false;
    const layout = await certSeed(cert.id, config, signer.id);
    expect(certBlock(layout, "to").heading).toBe("Sold To:");
    expect(certBlock(layout, "serials").heading).toBe("Heat lots");
    expect(certBlock(layout, "parts").columns.map((c) => [c.key, c.visible, c.label])).toEqual([
      ["part_qty", false, null], ["part_identity", true, null], ["part_pounds", true, "Weight"],
    ]);
    expect(certBlock(layout, "signature").columns.find((c) => c.key === "signer_title")!.visible).toBe(false);
    const { canvas } = await certGolden(customer.id, cert.id, signer.id, layout, { flowConfig: config });
    const text = drawnText(canvas);
    expect(text).toContain("Sold To:");
    expect(text).toContain("Heat lots");
    expect(text).not.toContain("Production Manager");
  }, 60_000);

  it("the statement: seeded with the wording empty it prints the flow's paper, and a statement typed later with a blank line moves what is below it as the flow's does", async () => {
    const { customer, cert } = await certOrder();
    const signer = await certSigner();
    const empty = certCfg();
    empty.textBlocks.cert_statement = "";
    const layout = await certSeed(cert.id, empty, signer.id);
    await certGolden(customer.id, cert.id, signer.id, layout, { flowConfig: empty });

    const typed = certCfg();
    typed.textBlocks.cert_statement = "The typed statement's first paragraph.\n\nIts second, after a blank line.";
    await certGolden(customer.id, cert.id, signer.id, layout, { flowConfig: typed, canvasConfig: typed });
  }, 60_000);

  it("the residuals, measured: no requirements or no serials print the signature's rule where the flow does; no freeform text prints it lower; a cert that pages starts page 1 higher", async () => {
    const signer = await certSigner();
    const base = await certOrder();
    const layout = await certSeed(base.cert.id, certCfg(), signer.id);
    const cases = {
      noRequirements: await certOrder({ inspected: false }),
      noSerials: await certOrder({ serials: 0 }),
      noFreeform: await certOrder({ freeform: "" }),
      pages: await certOrder({ readings: 100, serials: 50, freeform: "Freeform words run on. ".repeat(130).slice(0, 3000) }),
    };
    const flows = new Map<string, Buffer>();
    for (const [name, c] of Object.entries(cases)) flows.set(name, (await asSystem(() => printCert(c.cert.id, signer.id))).pdf);
    for (const c of Object.values(cases)) await certAssigned(c.customer.id, validateConfig("CERT", { ...certCfg(), layout }));
    const canvases = new Map<string, Buffer>();
    for (const [name, c] of Object.entries(cases)) canvases.set(name, (await asSystem(() => printCert(c.cert.id, signer.id))).pdf);

    for (const name of ["noRequirements", "noSerials", "noFreeform"]) {
      expect(pageCount(flows.get(name)!), name).toBe(1);
      expect(pageCount(canvases.get(name)!), name).toBe(1);
    }
    const ruleDrop = (name: string) => signatureRuleY(canvases.get(name)!) - signatureRuleY(flows.get(name)!);
    expect(Math.abs(ruleDrop("noRequirements"))).toBeLessThanOrEqual(0.5);
    expect(Math.abs(ruleDrop("noSerials"))).toBeLessThanOrEqual(0.5);
    expect(ruleDrop("noFreeform")).toBeCloseTo(FREEFORM_RESIDUAL, 1);

    const flowPaged = flows.get("pages")!;
    const canvasPaged = canvases.get("pages")!;
    expect(pageCount(flowPaged)).toBeGreaterThan(1);
    const rise = pageLines(flowPaged, 0)[0].top - pageLines(canvasPaged, 0)[0].top;
    expect(pageLines(canvasPaged, 0)[0].text).toBe(pageLines(flowPaged, 0)[0].text);
    expect(rise).toBeCloseTo(PAGED_RISE, 1);
  }, 180_000);

  it("a cert of 300 readings, serials and freeform text under the seeded Standard pages: the order number and (continued) on every later page, the strip on every page, the signature last; with the page line on, no line under it", async () => {
    const { customer, cert, order } = await certOrder({ readings: 300, serials: 50, freeform: "Freeform words run on. ".repeat(130).slice(0, 3000) });
    const signer = await certSigner();
    for (const pageFooter of [false, true]) {
      const config = certCfg();
      config.pageFooter = pageFooter;
      const layout = await certSeed(cert.id, config, signer.id);
      await certAssigned(customer.id, validateConfig("CERT", { ...config, layout }));
      const { pdf } = await asSystem(() => printCert(cert.id, signer.id));
      const pages = pageCount(pdf);
      expect(pages).toBeGreaterThan(1);
      for (let page = 0; page < pages; page++) {
        const lines = pageLines(pdf, page);
        const texts = lines.map((l) => l.text);
        expect(texts.some((t) => t.includes("1 Test Way, Testville")), `page ${page + 1}'s strip`).toBe(true);
        if (page > 0) {
          expect(texts.some((t) => t.includes(`Order No.: ${order.orderNumber}`)), `page ${page + 1}'s order number`).toBe(true);
          expect(texts.some((t) => t.includes("(continued)")), `page ${page + 1}'s (continued)`).toBe(true);
        }
        if (pageFooter) {
          const pageLine = lines.find((l) => /^Page \d+ of \d+$/.test(l.text));
          expect(pageLine, `page ${page + 1}'s page line`).toBeDefined();
          expect(Math.max(...lines.map((l) => l.top)), `page ${page + 1}: nothing under the page line`).toBe(pageLine!.top);
        }
      }
      const lastText = pageLines(pdf, pages - 1).map((l) => l.text);
      expect(lastText.filter((t) => t === "Quality Signer").length).toBeGreaterThan(0);
      for (let page = 0; page < pages - 1; page++) {
        expect(pageLines(pdf, page).some((l) => l.text === "Quality Signer"), `page ${page + 1}`).toBe(false);
      }
    }
  }, 180_000);

  it("the signer reaches the seed: seeded by a user with a signature image, the signature block is taller than seeded by one without by the image's height less the typed name's", async () => {
    const { cert } = await certOrder();
    const withImage = await certSigner();
    const without = await certSigner({ image: false });
    const a = certBlock(await certSeed(cert.id, certCfg(), withImage.id), "signature").box.h;
    const b = certBlock(await certSeed(cert.id, certCfg(), without.id), "signature").box.h;
    // The image fitted to the flow's signature fit box (220 × 45) and the name typed at 13 pt, each
    // laid out alone.
    const alone = async (node: object) => {
      const { groups } = await renderSheetGroupsWithPositions([{
        pageSize: "LETTER", pageMargins: [24, 0, 24, 0],
        defaultStyle: { font: CERT_DEFAULT_CONFIG.fonts.family, fontSize: CERT_DEFAULT_CONFIG.fonts.baseSize },
        content: [mark("top"), node as never, mark("end")],
      }]);
      const at = (id: string) => groups[0].positions.find((n) => n.id === id)!.top;
      return at("end") - at("top");
    };
    const image = await alone({ image: pngDataUri(alphaPng(120, 40)), fit: [CW.signatureFit, CW.signatureFitHeight] });
    const name = await alone({ text: "Quality Signer", fontSize: 13 });
    expect(a - b).toBeCloseTo(image - name, 0);
    expect(Math.abs(a - b - (image - name))).toBeLessThanOrEqual(1);
  }, 60_000);

  it("a template whose statement runs the stand-in past one page is refused in the seed's sentence, the draft untouched", async () => {
    const { cert } = await certOrder();
    const signer = await certSigner();
    const config = certCfg();
    config.textBlocks.cert_statement = Array.from({ length: 62 }, (_, i) => `Statement line ${i + 1}.`).join("\n");
    expect(pageCount(await certFlowPdf(cert.id, signer.id, config))).toBe(2);
    const t = await certDraft(config);
    const draft = () => prisma.documentTemplateVersion.findFirstOrThrow({ where: { templateId: t.id, status: "DRAFT" } });
    const before = await draft();
    await expect(seedCanvasLayout(await readPreviewContext(t.id), { recordId: cert.id, config }, signer.id))
      .rejects.toMatchObject({ status: 400, message: certTwoPages(2) });
    const after = await draft();
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  }, 60_000);

  // The canvas, not the flow, decides the fit (design §5.3: the drawn stack fits the one page rule 4
  // judges). Two settings put a stand-in that prints one page in the flow past the canvas's page: the
  // page line, whose strip stands in the band above the flow's bottom margin, and hidden rows, whose
  // row-floor clamps draw every later block lower. The statement lengths are measured at the boundary
  // (the reproductions of the whole-branch review); the sweep below states the invariant itself.
  const pageLineOn = (c: TemplateConfig) => { c.pageFooter = true; };
  const rowsHidden = (c: TemplateConfig) => {
    for (const key of ["part_qty", "part_identity", "part_pounds"]) certFieldOf(c, "parts", key).visible = false;
    for (const key of ["signature_mark", "signer_name", "signer_title", "signer_company"]) certFieldOf(c, "signature", key).visible = false;
    for (const key of ["part_heading", "spec_line", "readings"]) certFieldOf(c, "requirements", key).visible = false;
  };
  const withStatement = (lines: number, settings: (c: TemplateConfig) => void) => {
    const config = certCfg();
    settings(config);
    config.textBlocks.cert_statement = Array.from({ length: lines }, (_, i) => `Statement line ${i + 1}.`).join("\n");
    return config;
  };

  it.each([
    ["with Page N of M on, the strip's band above the flow's bottom margin", pageLineOn, 33],
    ["with every parts column, signature row and requirements row hidden, the row-floor lift", rowsHidden, 48],
  ] as const)(
    "a statement that prints one page in the flow but whose drawn stack runs past the canvas's page is refused in the seed's canvas sentence (%s)",
    async (_why, settings, lines) => {
      const { cert } = await certOrder();
      const signer = await certSigner();
      const config = withStatement(lines, settings);
      const t = await certDraft(config);
      await expect(seedCanvasLayout(await readPreviewContext(t.id), { recordId: cert.id, config }, signer.id))
        .rejects.toMatchObject({ status: 400, message: certPastCanvas });
      // The seed asks the flow first: at this length its stand-in printed one page, and one line more
      // prints two, refused in the page-count sentence.
      await expect(certSeed(cert.id, withStatement(lines + 1, settings), signer.id))
        .rejects.toMatchObject({ status: 400, message: certTwoPages(2) });
    },
    60_000,
  );

  it.each([
    ["with Page N of M on", pageLineOn, 32],
    ["with every parts column, signature row and requirements row hidden", rowsHidden, 47],
  ] as const)(
    "the boundary: the longest statement that seeds (%s) seeds a layout validateConfig accepts",
    async (_why, settings, lines) => {
      const { cert } = await certOrder();
      const signer = await certSigner();
      const config = withStatement(lines, settings);
      const layout = await certSeed(cert.id, config, signer.id);
      expect(() => validateConfig("CERT", { ...config, layout })).not.toThrow();
      // One line more is refused by the seed (the case above), so this is the boundary.
      const longer = withStatement(lines + 1, settings);
      await expect(certSeed(cert.id, longer, signer.id)).rejects.toMatchObject({ status: 400, message: certPastCanvas });
    },
    60_000,
  );

  it("the invariant across the boundary: every statement length either seeds a layout validateConfig accepts or is refused in one of the seed's two page-fit sentences", async () => {
    const { cert } = await certOrder();
    const signer = await certSigner();
    const sweeps = [[pageLineOn, [30, 31, 32, 33, 34, 35]], [rowsHidden, [45, 46, 47, 48, 49, 50]]] as const;
    const refused = new Set<string>();
    for (const [settings, lengths] of sweeps) {
      for (const lines of lengths) {
        const config = withStatement(lines, settings);
        let layout: CanvasLayout;
        try {
          layout = await certSeed(cert.id, config, signer.id);
        } catch (err) {
          const message = (err as Error).message;
          expect([certPastCanvas, certTwoPages(2)], `${lines} lines`).toContain(message);
          refused.add(message);
          continue;
        }
        expect(() => validateConfig("CERT", { ...config, layout }), `${lines} lines`).not.toThrow();
      }
    }
    // Both sentences are reached, so the sweep spans the boundary of each.
    expect(refused).toEqual(new Set([certPastCanvas, certTwoPages(2)]));
  }, 300_000);

  it("a reversal shipment's cert is refused in #183's sentence", async () => {
    certSeq += 1;
    const customer = await prisma.customer.create({ data: { code: `CR${certSeq}`, name: `Seed Reversal ${certSeq}` } });
    const shipTo = await prisma.customerAddress.create({
      data: { customerId: customer.id, kind: "SHIP_TO", street: "1 Dock", city: "Anniston", state: "AL", zip: "36201", isDefault: true },
    });
    const part = await certPart(customer.id, { scope: "SHIPMENT" });
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: "PO-R", lines: [{ partId: part.id, qty: 10, weight: "20.00" }],
    }));
    const { shipper } = await asSystem(() => createShipper({
      customerId: customer.id, shipDate: "2026-07-29", shipToAddressId: shipTo.id,
      orders: [{ orderId: order.id, lines: [{ orderLineId: order.lines[0].id, qty: 10, weight: "20.00", lineComplete: true }], containers: [], serials: [] }],
    }, { canOverrideCreditHold: false }));
    const { shipper: reversal } = await asSystem(() => reverseShipper(shipper.id, { reason: "returned" }));
    const legacy = await prisma.cert.create({ data: { orderId: order.id, scope: "SHIPMENT", shipperId: reversal.id } });
    const signer = await certSigner();
    await expect(certSeed(legacy.id, certCfg(), signer.id)).rejects.toMatchObject({
      status: 400, message: "This certification is on a reversing shipment and cannot be printed — a reversal un-ships its parts",
    });
  }, 60_000);

  it("a print's definition carries no seed id and is the definition with seedIds off; the seed's carries its marks", () => {
    const json = (def: unknown) => JSON.stringify(def);
    const ids = (def: unknown) => json(def).match(/"seed:[^"]*"/g) ?? [];
    const plain = buildCertDefinition(sampleCert(), certCfg());
    expect(ids(plain)).toEqual([]);
    expect(json(buildCertDefinition(sampleCert(), certCfg(), undefined, { seedIds: false }))).toBe(json(plain));
    const seeded = ids(buildCertDefinition(sampleCert(), certCfg(), undefined, { seedIds: true }));
    for (const block of CERT_BLOCKS) {
      expect(seeded, block).toContain(`"${CERT_SEED_IDS.start(block)}"`);
      expect(seeded, block).toContain(`"${CERT_SEED_IDS.sectionEnd(block)}"`);
    }
    for (const piece of ["company_name", "title", "order_no", "print_date", "entry_date", "po_number", "packing_list_no", "material", "parties_rule"]) {
      expect(seeded, piece).toContain(`"${CERT_SEED_IDS.piece(piece)}"`);
    }
  });

  it("seedCertItems passes over a laid-out id outside the seed's namespace, and still refuses by name a seed piece it has no item for", () => {
    const node = (id: string, top: number): LaidOutNode => ({ id, page: 1, left: 400, top });
    const strip = { address: null, phone: null };
    const names = (items: CanvasItem[]) => items.map((i) => (i.kind === "field" ? i.key : i.kind));
    const known = [node(CERT_SEED_IDS.piece("order_no"), 40), node(CERT_SEED_IDS.end("order_no"), 50)];
    expect(names(seedCertItems(certCfg(), known, strip, false, false))).toEqual(["order_no"]);
    // An id the render reports that the seed did not place (a measurement id, say) seeds nothing.
    const foreign = [node("cert-measure", 30), ...known, node("other:end:order_no", 60)];
    expect(names(seedCertItems(certCfg(), foreign, strip, false, false))).toEqual(["order_no"]);
    // The piece and its end mark both there, so `endOf` answers and the chain itself is what refuses.
    const unknown = [...known, node(CERT_SEED_IDS.piece("stray"), 60), node(CERT_SEED_IDS.end("stray"), 70)];
    expect(() => seedCertItems(certCfg(), unknown, strip, false, false)).toThrow("The certification's seed has no item for stray.");
  });

  // #960, hand-built positions: no face or setting found lays out more than one pair of blocks with
  // nothing between them (the requirements and the serials), so no real cert reaches the sum. Seven
  // blocks 20.0006 pt tall stand back to back from 100 pt: each height snaps to 20.001 and the tops
  // creep a little under it, so each block's snapped top starts above the drawn bottom before it.
  // `sealed` moving each block on its own (the certification's before #960) leaves a later block
  // 0.003 pt above the one before it, past `ROUNDING`, and rule 5 refuses; carrying each move to
  // every block below keeps the drawn stack the flow's.
  it("sealed carries each block's rounding move to every block below it, so back-to-back blocks never add up to an overlap (#960)", () => {
    const node = (id: string, top: number): LaidOutNode => ({ id, page: 1, left: 36, top });
    const strip = { address: null, phone: null };
    const top = (i: number) => 100 + i * 20.0006;
    const BLOCK_KEYS = ["to", "parts", "statement", "requirements", "serials", "freeform", "signature"];
    const positions = BLOCK_KEYS.flatMap((block, i) => [
      node(CERT_SEED_IDS.start(block), top(i)), node(CERT_SEED_IDS.sectionEnd(block), top(i + 1)),
    ]);
    const layout = { version: 1 as const, items: seedCertItems(certCfg(), positions, strip, false, false) };
    const tables = tablesByY(layout);
    expect(tables.map((t) => t.key)).toEqual(BLOCK_KEYS);
    for (let i = 1; i < tables.length; i++) {
      const bottom = tables[i - 1].box.y + tables[i - 1].box.h;
      expect(tables[i].box.y, tables[i].key).toBeGreaterThanOrEqual(bottom);
      // Moved by a rounding step at most: the drawn gap stays under a thousandth and a half.
      expect(tables[i].box.y - bottom, tables[i].key).toBeLessThan(0.0015);
    }
    expect(() => validateCanvasLayout(layout, CERT_CONTRACT, { pageFooter: false })).not.toThrow();
  });

  it("withRepeat ticks a page-top order number ending one grid step above the first block, and not one ending nearer", () => {
    // Hand-built positions: today's header keeps CERT_PAGE.headerBottom (more than a grid step) under
    // the number, so only a hand-built gap reaches the comparison's refusing side.
    const node = (id: string, top: number): LaidOutNode => ({ id, page: 1, left: HEADER_RIGHT_X, top });
    const strip = { address: null, phone: null };
    const numberEnd = 50;
    const seeded = (gap: number) => {
      const toTop = numberEnd + gap;
      const items = withRepeat(seedCertItems(certCfg(), [
        node(CERT_SEED_IDS.piece("order_no"), 40), node(CERT_SEED_IDS.end("order_no"), numberEnd),
        node(CERT_SEED_IDS.start("to"), toTop), node(CERT_SEED_IDS.sectionEnd("to"), toTop + 30),
      ], strip, false, false));
      const number = fieldItem({ version: 1, items }, "order_no")!;
      expect(number.anchor).toEqual({ kind: "page-top" });
      expect(number.box.y + number.box.h).toBe(numberEnd);
      expect(certBlock({ version: 1, items }, "to").box.y).toBe(toTop);
      return number.repeat;
    };
    expect(seeded(CANVAS_GRID)).toBe(true);
    expect(seeded(CANVAS_GRID - 0.5)).toBe(false);
  });

  it("composed: the seeded Standard, previewed for the same certification, warns through the preview's measure of the accepted set, and the measure holds every item", async () => {
    const { cert } = await certOrder();
    const signer = await certSigner();
    const t = await certDraft(certCfg());
    const { layout, measure, measured } = await seededPreviewWarnings(t.id, cert.id, certCfg(), signer.id);
    expect(measured).toEqual(CERT_ACCEPTED_WARNINGS);
    expect(measure.pages).toBe(1);
    expect(measure.tables.map((table) => table.key)).toEqual(CERT_BLOCKS);
    const ids = new Set(measure.items.map((item) => item.id));
    expect(layout.items.filter((item) => item.kind !== "table" && !ids.has(item.id))).toEqual([]);
    // The silence is the measure's, not an absent one: the same measure judging the order number drawn
    // shorter than it printed warns that it prints taller, and of nothing else.
    const orderNo = fieldItem(layout, "order_no")!;
    const printed = measure.items.find((item) => item.id === orderNo.id)!.height;
    const short: CanvasLayout = {
      ...layout, items: layout.items.map((i) => (i === orderNo ? { ...orderNo, box: { ...orderNo.box, h: printed - 2 } } : i)),
    };
    const options = { pageFooter: certCfg().pageFooter, fonts: certCfg().fonts };
    expect(namedWarnings(short, canvasWarnings(short, CERT_CONTRACT, measure, options)).map((w) => w.items))
      .toEqual([["order_no"]]);
  }, 60_000);

  it("a page-2 item (design §15): a Text item below the signature, previewed for a 300-reading cert, is measured, staged and dragged on the page it laid out on; on paper no line or stroke reaches the band, and its warnings are the accepted set, the paging blocks judged against the repeated strip only down to the band", async () => {
    const { cert } = await certOrder({ readings: 300, serials: 50, freeform: "Freeform words run on. ".repeat(130).slice(0, 3000) });
    const signer = await certSigner();
    const t = await certDraft(certCfg());
    const ctx = await readPreviewContext(t.id);
    const seeded = await seedCanvasLayout(ctx, { recordId: cert.id, config: certCfg() }, signer.id);
    // The seed places nothing below the signature block; the added item hangs two grid steps under it.
    expect(seeded.items.some((i) => i.anchor.kind === "below-table" && i.anchor.table === "signature")).toBe(false);
    const added: CanvasItem = {
      id: "added-text", kind: "text", text: "Released for shipment", box: { x: MARGIN, y: 2 * CANVAS_GRID, w: 200, h: 12 },
      anchor: { kind: "below-table", table: "signature" }, repeat: false, style: { size: 9, bold: false, align: "left" },
    };
    const layout: CanvasLayout = { ...seeded, items: [...seeded.items, added] };
    const working = validateConfig("CERT", { ...certCfg(), layout });
    const { pdf, measure } = await renderPreview(ctx, { recordId: cert.id, config: working }, signer.id);
    expect(measure).not.toBeNull();
    const m = measure!;
    expect(m.pages).toBeGreaterThanOrEqual(2);
    expect(pageCount(pdf)).toBe(m.pages);

    // On paper nothing reaches the band, which is why warning (a) judges a paging block against the
    // strip only down to the band's top. On every page the strip prints (read by its text, the
    // settings `truncateAll` seeds), every other line's ink is above the band's top and so is every
    // stroke (`strokedLines` reads strokes, not filled rects). A line's ink ends one descent under its
    // top-down baseline: bounded here by the deepest `/Descent` of the fonts the PDF embeds (its
    // FontDescriptors, in thousandths of an em) at the largest size the page sets (its `Tf`
    // operators). On each page but the last the lowest body line sits less than one line pitch above
    // the band: the page broke because the next line would cross it, so the bound is met by a block
    // that fills the page, not by one that stops short.
    const band = bandTop(layout, working.pageFooter);
    const address = await getSetting("company_address");
    const phone = await getSetting("company_phone");
    expect(address).not.toBe("");
    expect(phone).not.toBe("");
    const isStrip = (text: string) => text.includes(address) || text.includes(phone);
    const descents = [...parseObjects(pdf).values()]
      .filter((obj) => /\/Type\s*\/FontDescriptor/.test(obj.body))
      .map((obj) => -Number(/\/Descent\s+(-?[\d.]+)/.exec(obj.body)![1]) / 1000);
    expect(descents.length).toBeGreaterThan(0);
    const descent = Math.max(...descents);
    expect(descent).toBeGreaterThan(0);
    const largestSize = pageStreams(pdf).map((ops) => Math.max(...[...ops.matchAll(/\/[\w-]+\s+([\d.]+)\s+Tf/g)].map((t) => Number(t[1]))));
    const strokes = strokedLines(pdf);
    textLinesWithY(pdf).forEach((page, i) => {
      const tops = page.map((line) => ({ text: line.text, top: PAGE_HEIGHT - line.y }));
      expect(tops.some((line) => isStrip(line.text)), `page ${i + 1}'s strip`).toBe(true);
      const body = tops.filter((line) => !isStrip(line.text)).map((line) => line.top).sort((a, b) => b - a);
      expect(body.length, `page ${i + 1}'s body`).toBeGreaterThan(1);
      expect(largestSize[i], `page ${i + 1}'s largest size`).toBeGreaterThan(0);
      expect(body[0] + descent * largestSize[i], `page ${i + 1}'s lowest body line's ink`).toBeLessThan(band);
      for (const line of strokes[i]) expect(PAGE_HEIGHT - Math.min(line.y1, line.y2), `page ${i + 1}'s stroke`).toBeLessThan(band);
      if (i + 1 < m.pages) expect(band - body[0], `page ${i + 1}'s room left`).toBeLessThan(body[0] - body[1]);
    });
    const signature = m.tables.find((table) => table.key === "signature")!;
    expect(signature.page).toBeGreaterThan(1);

    const rule = layout.items.find((i) => i.kind === "line")!;
    expect(stageBox(rule, layout, m).page).toBe(1);
    const entry = m.items.find((item) => item.id === added.id)!;
    expect(entry.page).toBe(m.regions.find((r) => r.after === "signature")!.page);
    expect(entry.page).toBeGreaterThan(1);
    const staged = stageBox(added, layout, m);
    expect(staged.page).toBe(entry.page);
    // The stage draws an item on another page dashed at its drawn box, and a drag starts there.
    expect(dragStart(added, layout, m)).toEqual(drawnBox(added, layout));

    // The accepted set, no (b) or (c) for the region that moved whole to the last page and fits
    // there, and no (a): a block that pages is measured as ONE box, its top on its first page and its
    // height the flow extent across every page it prints on (`canvasMeasure`), so the requirements
    // block (page 1 onto page 3) and the serials block (page 3 onto page 4) each run past the band,
    // where the strip's two repeated items print; the paper above shows neither block reaches it, and
    // warning (a) judges each only down to the band's top.
    const pagingBlocks = m.tables.filter((table) => table.top + table.height > band);
    expect(pagingBlocks.map((table) => table.key)).toEqual(["requirements", "serials"]);
    expect(bandItems(layout).map((item) => item.repeat)).toEqual([true, true]);
    const options = { pageFooter: working.pageFooter, fonts: working.fonts };
    expect(namedWarnings(layout, canvasWarnings(layout, CERT_CONTRACT, m, options))).toEqual(CERT_ACCEPTED_WARNINGS);
  }, 180_000);

  it("the route: no session is 401, templates.edit alone is 403 without certs.view, both is 200 and nothing is written", async () => {
    const { cert } = await certOrder();
    const t = await certDraft(certCfg());
    const editOnly = await signInWith(["templates.edit"], "cert-seed-edit");
    const both = await signInWith(["templates.edit", "certs.view"], "cert-seed-both");
    const ask = (cookie: string) => seedRoute(new Request(`http://t/api/templates/${t.id}/draft/canvas`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ recordId: cert.id, config: certCfg() }),
    }), { params: Promise.resolve({ id: t.id }) });

    expect((await ask("")).status).toBe(401);
    expect((await ask(editOnly)).status).toBe(403);
    const draft = () => prisma.documentTemplateVersion.findFirstOrThrow({ where: { templateId: t.id, status: "DRAFT" } });
    const before = await draft();
    const documents = await prisma.storedDocument.count();
    const audits = await prisma.auditLog.count();
    const res = await ask(both);
    expect(res.status).toBe(200);
    const layout = canvasLayoutSchema.parse(await res.json());
    expect(tablesByY(layout).map((table) => table.key)).toEqual(CERT_BLOCKS);
    const after = await draft();
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.config).toEqual(before.config);
    expect(await prisma.storedDocument.count()).toBe(documents);
    expect(await prisma.auditLog.count()).toBe(audits);
    expect((await prisma.cert.findUniqueOrThrow({ where: { id: cert.id } })).printedAt).toBeNull();
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// The invoice's and the credit memo's seed (invoice canvas design 2026-11-10 §5.3, PR 2 Task 8).
// Written while INVOICE stood outside CANVAS_PRINTS (before PR 3), when no route, preview or print
// reached an invoice layout: the cases call `seedInvoiceLayout` directly, check its answer with
// `validateCanvasLayout`, and print both papers in memory, the flow's and the canvas's definitions
// over the same `InvoicePdfData`, through `renderPdf`. The picked record is a real draft invoice (or credit) whose
// customer's bill-to row carries a name of its own, so R14's line is frozen on it; the paper compared
// is that record's own print data overlaid with the rows the fixture cannot type (open question 6).
// ---------------------------------------------------------------------------------------------

const invCfg = (): TemplateConfig => structuredClone(INVOICE_DEFAULT_CONFIG);
const invSection = (c: TemplateConfig, key: string) => c.sections.find((s) => s.key === key)!;
/** Moves section `key` to just before section `before`. */
const moveSectionBefore = (c: TemplateConfig, key: string, before: string): void => {
  const [moved] = c.sections.splice(c.sections.findIndex((s) => s.key === key), 1);
  c.sections.splice(c.sections.findIndex((s) => s.key === before), 0, moved);
};
const IW = INVOICE_WIDTHS;
const INV_FLOOR = canvasProfile(INVOICE_CONTRACT).rowFloor;
const INV_BLOCKS = ["parties", "column_header", "order_strip", "parts", "price", "totals"];
/** The flow's strip top: the page less its bottom margin, plus the strip's inset (754). */
const INV_STRIP_TOP = CANVAS_PAGE.height - INVOICE_PAGE.bottomMargin + INVOICE_PAGE.stripInset;
/** The R14 name line the fixture's bill-to row stacks above the customer's name. */
const INV_ATTN = "Accounts payable";
const invTwoPages = (pages: number) =>
  `The canvas starts from a one-page invoice; laid out at its least, this template's invoice prints ${pages} pages. Change this template's settings (its font, sizes or logo) so it fits one page.`;

let invSeq = 0;
/**
 * A real DRAFT invoice: a customer whose default bill-to row names "Accounts payable" (R14's line,
 * frozen at create), `parts` part lines (one by default), each priced by one EACH operation.
 */
async function invoiceDraft(options: { parts?: number } = {}) {
  invSeq += 1;
  const customer = await prisma.customer.create({ data: { code: `IS${invSeq}`, name: `Seed Invoice Customer ${invSeq}` } });
  await prisma.customerAddress.create({
    data: {
      customerId: customer.id, kind: "BILL_TO", name: INV_ATTN, street: "500 Example Street",
      city: "Columbus", state: "GA", zip: "31902", isDefault: true,
    },
  });
  const gl = await prisma.glAccount.create({ data: { name: `40${invSeq}`, description: "Sales" } });
  const code = await prisma.processStepCode.create({ data: { code: `IAUS${invSeq}`, name: "Austemper", glAccountId: gl.id } });
  const parts: { id: string }[] = [];
  for (let i = 0; i < (options.parts ?? 1); i++) {
    const part = await prisma.part.create({
      data: { customerId: customer.id, partNumber: `INV-${invSeq}-${i + 1}`, name: "EQUALIZER-RR SUSP", eachWeight: "21.0000" },
    });
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    await prisma.partProcessStep.create({ data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austemper." } });
    await asSystem(() => addPartPrice(part.id, {
      processStepCodeId: code.id, position: 1, unitPrice: "1.0000", minimumCharge: null, pricePer: "EACH",
    }));
    parts.push(part);
  }
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, poNumber: "89499",
    lines: parts.map((p) => ({ partId: p.id, qty: 10, weight: "210.00" })),
  }));
  await createShipper({
    customerId: customer.id, shipDate: "2026-07-29",
    orders: [{
      orderId: order.id,
      lines: order.lines.map((l) => ({ orderLineId: l.id, qty: l.qty, weight: l.weight, lineComplete: true })),
      containers: [], serials: [],
    }],
  }, { canOverrideCreditHold: false });
  const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
  return { customer, order, invoice };
}

/** A DRAFT credit memo, raised from the finalized invoice of `invoiceDraft`. */
async function creditDraft() {
  const { invoice } = await invoiceDraft();
  await asSystem(() => finalizeInvoice(invoice.id));
  const credit = await asSystem(() => createCredit(invoice.id));
  return { invoice, credit };
}

/** The picked record's own print data, as the seed reads it. */
async function invData(invoiceId: string): Promise<InvoicePdfData> {
  return readInvoicePdfData(prisma, invoiceId, await invoicePrintSettings());
}

/** The record's data overlaid with every piece the flow prints (open question 6): a long Process that
 *  wraps within its share, three parts, prices grouped by part with a quote source, a unit price, a
 *  minimum and a setup, a price that lost its part, two surcharges, two charges, the cert, freight
 *  and tax lines. `sign` -1 makes every amount a credit's. The record's identity is kept. */
function richOverlay(d: InvoicePdfData, sign = 1): InvoicePdfData {
  const $ = (n: number) => sign * n;
  return {
    ...d,
    poNumber: "PO-89499-A",
    materialName: "Ductile Iron",
    processNames: "Austemper, Temper, Normalize, Stress relieve, Straighten, Shot blast, Inspect and pack for export",
    parts: [
      { qty: 144, partNumber: "DEMO-9001-000", partName: "EQUALIZER-RR SUSP", partDescription: "Cast", eachWeight: 21, totalWeight: 3024 },
      { qty: 50, partNumber: "DEMO-9002-000", partName: "SPRING SEAT", partDescription: "", eachWeight: 3.2, totalWeight: 160 },
      { qty: 12, partNumber: "DEMO-9003-000", partName: "BRACKET", partDescription: "", eachWeight: 1.5, totalWeight: 18 },
    ],
    priceRows: [
      { description: "Austemper", pricePerLabel: "Each", unitPrice: $(6.51), minimumCharge: $(600), setupCharge: null, sourceQuoteNumber: 1006, amount: $(937.44), partIndex: 0 },
      { description: "Temper", pricePerLabel: "Each", unitPrice: null, minimumCharge: null, setupCharge: $(75), amount: $(75), partIndex: 0 },
      { description: "Normalize", pricePerLabel: "Pound", unitPrice: $(0.5), minimumCharge: null, setupCharge: null, amount: $(80), partIndex: 1 },
      { description: "Rework", pricePerLabel: "Each", unitPrice: null, minimumCharge: null, setupCharge: null, amount: $(40), partIndex: null },
    ],
    surchargeRows: [{ description: "EnergySur", amount: $(37.5) }, { description: "FuelSur", amount: $(12) }],
    chargeRows: [{ description: "Expedite", amount: $(25) }, { description: "Handling", amount: $(15) }],
    certRow: { description: "Certification", amount: $(20) },
    freightRow: { description: "Freight", amount: $(40) },
    taxRow: { description: "Sales tax", amount: $(12) },
  };
}

/** The record's data with `n` parts, each with one priced operation, and every totals line: it pages. */
function manyParts(d: InvoicePdfData, n = 30): InvoicePdfData {
  const parts = Array.from({ length: n }, (_, i) => ({
    qty: 10 + i, partNumber: `DEMO-${9100 + i}`, partName: `PART ${i + 1}`, partDescription: "", eachWeight: 2, totalWeight: 2 * (10 + i),
  }));
  return {
    ...richOverlay(d),
    parts,
    priceRows: parts.map((p, i) => ({
      description: `Operation ${i + 1}`, pricePerLabel: "Each", unitPrice: 1, minimumCharge: null, setupCharge: null, amount: p.qty, partIndex: i,
    })),
  };
}

/** The config carrying `layout`, the layout validated first under the config's page line. */
function invCanvasCfg(config: TemplateConfig, layout: CanvasLayout): TemplateConfig {
  validateCanvasLayout(layout, INVOICE_CONTRACT, { pageFooter: config.pageFooter });
  return { ...config, layout };
}

/** The flow's and the canvas's papers for `data` under `config`, in memory. */
async function invPapers(data: InvoicePdfData, config: TemplateConfig, layout: CanvasLayout, logo?: string) {
  const flow = await renderPdf(buildInvoiceDefinition(data, config, logo));
  const canvas = await renderPdf(buildInvoiceDefinition(data, invCanvasCfg(config, layout), logo));
  return { flow, canvas };
}

/** The flow's and the canvas's invoices compared (§5.3's acceptance): the certification's
 *  comparison, printed lines grouped by baseline top to bottom, the same text within 2 pt, in the
 *  flow's fonts and sizes and at its x within 2 pt, the same merged strokes within 1 pt and the same
 *  image paints. */
function expectSameInvoice(flow: Buffer, canvas: Buffer) {
  expectSameBol(flow, canvas, { version: 1, items: [] }, 0);
}

/** `invPapers`, the flow's paper on ONE page first (a paging canvas prints page 1 16 pt higher than
 *  its flow, past the golden's 2 pt), then compared. */
async function invGolden(data: InvoicePdfData, config: TemplateConfig, layout: CanvasLayout, logo?: string) {
  const papers = await invPapers(data, config, layout, logo);
  expect(pageCount(papers.flow), "the flow prints one page").toBe(1);
  expectSameInvoice(papers.flow, papers.canvas);
  return papers;
}

/** The seed's own layout pass of the stand-in: the seed ids' positions. */
async function invLaid(data: InvoicePdfData, config: TemplateConfig, logo?: string) {
  const { groups } = await renderSheetGroupsWithPositions([buildInvoiceDefinition(invoiceStandIn(data, config), config, logo, { seedIds: true })]);
  const at = (id: string) => {
    const node = groups[0].positions.find((n) => n.id === id);
    if (node === undefined) throw new Error(`no laid-out node "${id}"`);
    return node;
  };
  return {
    positions: groups[0].positions,
    start: (key: string) => at(INVOICE_SEED_IDS.start(key)).top,
    height: (key: string) => at(INVOICE_SEED_IDS.sectionEnd(key)).top - at(INVOICE_SEED_IDS.start(key)).top,
  };
}

const invRows = (layout: CanvasLayout, key: string) => certBlock(layout, key).columns.map((c) => [c.key, c.visible, c.label]);
const invItems = (layout: CanvasLayout) => layout.items.map((item) => ({ ...item, id: "" }));
const runsOnPage = (pdf: Buffer, page: number) => textLinesWithY(pdf)[page].map((l) => ({ text: l.text, top: PAGE_HEIGHT - l.y }));
const LOGO = pngDataUri(alphaPng(40, 20));
/** A page's printed lines as `textLinesWithY` groups them (by baseline to half a point), each with
 *  its topmost run's RAW baseline from the page's top, so a measured figure is not rounded to the
 *  grouping's half point. */
function rawLines(pdf: Buffer, page: number): { text: string; top: number }[] {
  const byLine = new Map<number, { text: string; x: number; y: number }[]>();
  for (const run of textRunsWithY(pdf)[page]) {
    const key = Math.round(run.y * 2) / 2;
    byLine.set(key, [...(byLine.get(key) ?? []), run]);
  }
  return [...byLine.values()].map((runs) => ({
    text: runs.sort((a, b) => a.x - b.x).map((r) => r.text).join("").replace(/\s+/g, " ").trim(),
    top: PAGE_HEIGHT - Math.max(...runs.map((r) => r.y)),
  })).filter((l) => l.text !== "");
}

/** The seed's residuals on the Standard in Roboto (design §4.4, §4.5, §15), measured by Task 8 and
 *  pinned to a hundredth, the rendered ones read from the raw baselines (`rawLines`), the rooms and
 *  the hidden Footer's arithmetic from the seeded layout (the predictions in brackets; the task's
 *  report lists them): the invoice
 *  number's seeded top and bottom [73, 84.7]; the repeat band's height, `topMargin` [89.2]; the
 *  strip's height [9]; the addresses' drawn distance to the column headers [6]; the header's height,
 *  the title's top to the company name's bottom [not predicted]; each continuation page's room less
 *  than the flow's with the page line off and on [43, 58]; a one-page canvas invoice's room more than
 *  its flow print with the page line off, and less with it on [6, 9]; a hidden Footer's room more than
 *  the flow's per page [20]; the empty column headers block's distance to the block below it [not
 *  predicted]; a paging invoice's page 1 higher than its flow print [16] and its page 2's first body
 *  line lower [49]; with the page line on, the strip higher than the flow's [15], the page line's
 *  baseline under the band's bottom (its 8 pt margin and its line's ascent) and the page line higher
 *  than the flow's [15]. */
const INVOICE_SEED_RESIDUALS: Record<string, number> = {
  invoiceNoTop: 73.016, invoiceNoBottom: 84.735, repeatBand: 89.235, stripHeight: 8.789, partiesToColumnHeaders: 5.999,
  headerHeight: 43.016, continuationRoomLessOff: 43.235, continuationRoomLessOn: 58.024, onePageRoomMoreOff: 6,
  onePageRoomLessOn: 8.789, hiddenFooterRoomMore: 20, emptyColumnHeadersBelow: 0, pagedRise: 16, page2BodyLower: 49.235,
  stripRiseOn: 14.789, pageLineUnderBand: 15.886, pageLineRiseOn: 14.789,
};
/** "(continued)"'s rendered right edge in each face, at the canvas's 8 pt italic from the left margin
 *  (design §4.4's advance-width predictions 63.61, 64.02, 60.88 and 75.65, against the invoice
 *  number's label at 64). */
const CONTINUED_RIGHT_EDGES: Record<string, number> = {
  Roboto: 63.609, "Liberation Sans": 64.023, "Liberation Serif": 60.875, "Roboto Mono": 75.648,
};

/** The warnings the invoice's seeded Standard draws through the preview's measure (Task 10, the
 *  composed case and the page-2 item): warning (e) alone, for the invoice number, which repeats where
 *  "(continued)" prints (call 2; design §4.4's residual, a warning, never a refusal), as predicted. */
const INVOICE_ACCEPTED_WARNINGS: ReturnType<typeof namedWarnings> = [{
  items: ["invoice_no"],
  sentence: "The Invoice number field repeats where \"(continued)\" prints on continuation pages, at the repeat band's bottom-left; the two print over each other.",
}];

describe("seedInvoiceLayout: an invoice or credit draft seeds its canvas from a stand-in laid out at its least", () => {
  it("answers a layout the canvas rules accept: the six blocks stacked at the margins, the header and identity page-top, the strip in the band, the invoice number repeating; the stand-in prints one canvas page", async () => {
    const { invoice } = await invoiceDraft();
    const config = invCfg();
    const layout = await seedInvoiceLayout(invoice.id, config, undefined);

    expect(canvasLayoutSchema.parse(layout)).toEqual(layout);
    expect(() => validateCanvasLayout(layout, INVOICE_CONTRACT, { pageFooter: false })).not.toThrow();
    expect(new Set(layout.items.map((i) => i.id)).size).toBe(layout.items.length);
    expect(tablesByY(layout).map((t) => t.key)).toEqual(INV_BLOCKS);
    for (const key of INV_BLOCKS) {
      expect(certBlock(layout, key).box, key).toMatchObject({ x: MARGIN, w: CONTENT_WIDTH });
      expect(certBlock(layout, key).box.h, key).toBeGreaterThanOrEqual(INV_FLOOR);
    }
    for (const key of ["title", "company_name", "invoice_no", "invoice_date", "terms", "remit_to"]) {
      expect(fieldItem(layout, key)?.anchor, key).toEqual({ kind: "page-top" });
    }
    expect(fieldItem(layout, "title")).toMatchObject({ box: { x: MARGIN, w: CONTENT_WIDTH }, style: { size: 20, bold: true, align: "center" } });
    expect(fieldItem(layout, "company_name")).toMatchObject({ box: { x: MARGIN, w: CONTENT_WIDTH }, style: { size: 15, bold: true, align: "center" } });
    expect(fieldItem(layout, "remit_to")).toMatchObject({
      box: { x: RIGHT_EDGE - IW.remitTo, w: IW.remitTo }, style: { size: 13, bold: true, align: "left" },
    });
    expect(fieldItem(layout, "invoice_no")).toMatchObject({ repeat: true, box: { x: MARGIN + IW.identityIndent } });
    const band = bandItems(layout);
    const small = INVOICE_DEFAULT_CONFIG.fonts.smallSize;
    expect(band.map((i) => [i.key, i.box.x, i.box.y, i.box.w, i.repeat, i.style])).toEqual([
      ["footer_address", MARGIN, INV_STRIP_TOP, CONTENT_WIDTH - IW.footerContact - IW.footerPhone, true, { size: small, bold: false, align: "left" }],
      ["footer_contact", RIGHT_EDGE - IW.footerPhone - IW.footerContact, INV_STRIP_TOP, IW.footerContact, true, { size: small, bold: false, align: "center" }],
      ["footer_phone", RIGHT_EDGE - IW.footerPhone, INV_STRIP_TOP, IW.footerPhone, true, { size: small, bold: false, align: "right" }],
    ]);
    // The stand-in, printed under its own seed: one page.
    const standIn = invoiceStandIn(await invData(invoice.id), config);
    expect(pageCount(await renderPdf(buildInvoiceDefinition(standIn, invCanvasCfg(config, layout))))).toBe(1);
  }, 60_000);

  it("the stand-in keeps the picked record's identity and lays every growing piece out at its least", async () => {
    const { invoice } = await invoiceDraft({ parts: 3 });
    const data = await invData(invoice.id);
    const standIn = invoiceStandIn(data, invCfg());
    const s = INVOICE_STAND_IN;
    expect(standIn).toEqual({
      ...data,
      billTo: [...s.address], shipTo: [...s.address], poNumber: s.poNumber, materialName: s.materialName, processNames: s.processNames,
      parts: [{ ...s.part }], priceRows: [{ ...s.priceRow }],
      surchargeRows: [], chargeRows: [], certRow: null, freightRow: null, taxRow: null,
    });
    expect(standIn.orderNumber).toBe(data.orderNumber);
    expect(standIn.total).toBe(data.total);
  }, 60_000);

  it("sentence 2: a header-centre logo tall enough to page the stand-in is refused with the page count", async () => {
    const { invoice } = await invoiceDraft();
    const config = invCfg();
    config.logo = { placement: "header-center", width: 80 };
    const tall = pngDataUri(alphaPng(1, 6));
    const standIn = invoiceStandIn(await invData(invoice.id), config);
    expect(pageCount(await renderPdf(buildInvoiceDefinition(standIn, config, tall)))).toBe(2);
    // Its class, its 400 and its whole sentence (`expectInvoiceRefusal`, below).
    await expectInvoiceRefusal(seedInvoiceLayout(invoice.id, config, tall), invTwoPages(2));
  }, 60_000);

  it("the identity widths: each identity line is the content less its indent, and less the Remit To column and gap while that box is shown", async () => {
    const { invoice } = await invoiceDraft();
    const shown = await seedInvoiceLayout(invoice.id, invCfg(), undefined);
    const config = invCfg();
    fieldOf(config, "identity", "remit_to").visible = false;
    const hidden = await seedInvoiceLayout(invoice.id, config, undefined);
    for (const key of ["invoice_no", "invoice_date", "terms"]) {
      expect(fieldItem(shown, key)!.box.w, key).toBe(CONTENT_WIDTH - IW.identityIndent - IW.remitTo - IW.identityGap);
      expect(fieldItem(shown, key)!.box.w, key).toBe(262);
      expect(fieldItem(hidden, key)!.box.w, key).toBe(CONTENT_WIDTH - IW.identityIndent);
      expect(fieldItem(hidden, key)!.box.w, key).toBe(524);
    }
    expect(fieldItem(hidden, "remit_to")).toBeUndefined();
  }, 60_000);

  it("golden: on the Standard, an invoice printing every piece on one page prints the flow's lines and strokes under its seed, and so does a credit memo seeded from the credit", async () => {
    const { invoice } = await invoiceDraft();
    const data = await invData(invoice.id);
    expect(data.billTo[0]).toBe(INV_ATTN);
    const config = invCfg();
    const layout = await seedInvoiceLayout(invoice.id, config, undefined);
    const { flow } = await invGolden(richOverlay(data), config, layout);
    const text = drawnText(flow);
    for (const piece of [INV_ATTN, "Quote #1006", "Setup Charge:", "Minimum Charge:", "Rework", "FuelSur", "Handling", "Sales tax", "Freight"]) {
      expect(text, piece).toContain(piece);
    }
    // The strokes compared include the column headers' box, the Remit To box and every #589 rule
    // (three groups: two parts' and the lost part's), margin to margin.
    const rules = strokedLines(flow)[0].filter((s) => s.y1 === s.y2 && s.width === 0.5);
    expect(rules).toHaveLength(3);
    for (const r of rules) expect([Math.min(r.x1, r.x2), Math.max(r.x1, r.x2)]).toEqual([MARGIN, RIGHT_EDGE]);

    const { credit } = await creditDraft();
    const creditData = await invData(credit.id);
    expect(creditData.title).toBe("Credit");
    const creditLayout = await seedInvoiceLayout(credit.id, config, undefined);
    const papers = await invGolden(richOverlay(creditData, -1), config, creditLayout);
    expect(drawnText(papers.canvas)).toContain("$-937.44");
  }, 120_000);

  it("each block at its stand-in's least: an invoice of 40 parts seeds every block as tall as a one-part invoice seeds it", async () => {
    const long = await invoiceDraft({ parts: 40 });
    const short = await invoiceDraft();
    expect(pageCount(await renderPdf(buildInvoiceDefinition(await invData(long.invoice.id), invCfg())))).toBeGreaterThan(1);
    const a = await seedInvoiceLayout(long.invoice.id, invCfg(), undefined);
    const b = await seedInvoiceLayout(short.invoice.id, invCfg(), undefined);
    for (const key of INV_BLOCKS) expect(certBlock(a, key).box.h, key).toBeCloseTo(certBlock(b, key).box.h, 2);
  }, 180_000);

  // Red in Liberation Serif under `sealed` moving each block on its own (Task 8's M10): the only
  // case holding the shift `sealed` carries down to every block below. One 9 pt line measures at
  // least 9.97 pt in every face (design §14), so on the Standard no block clamps and `lift` is 0.
  it.each(FONT_FAMILIES)("every face: in %s the seeded Standard is accepted and no block is clamped", async (family) => {
    const { invoice } = await invoiceDraft();
    const config = invCfg();
    config.fonts.family = family as FontFamily;
    const layout = await seedInvoiceLayout(invoice.id, config, undefined);
    expect(() => validateCanvasLayout(layout, INVOICE_CONTRACT, { pageFooter: false })).not.toThrow();
    const laid = await invLaid(await invData(invoice.id), config);
    for (const key of INV_BLOCKS) {
      expect(laid.height(key), key).toBeGreaterThan(INV_FLOOR);
      expect(certBlock(layout, key).box.h, key).toBeCloseTo(laid.height(key), 2);
      expect(certBlock(layout, key).box.y, key).toBeCloseTo(laid.start(key), 2);
    }
  }, 60_000);

  describe("the clamp and lift", () => {
    /** Hides every field of `section`. */
    const hideAll = (c: TemplateConfig, section: string) => { for (const f of invSection(c, section).fields) f.visible = false; };

    it("an Order strip shown with every row hidden seeds its block at the row floor and every block below it lower by the clamp; the canvas prints each where the flow does", async () => {
      const { invoice } = await invoiceDraft();
      const data = await invData(invoice.id);
      const config = invCfg();
      hideAll(config, "order_strip");
      const laid = await invLaid(data, config);
      expect(laid.height("order_strip")).toBe(0);
      const layout = await seedInvoiceLayout(invoice.id, config, undefined);
      expect(certBlock(layout, "order_strip").box.h).toBe(INV_FLOOR);
      expect(invRows(layout, "order_strip").every(([, visible]) => visible === false)).toBe(true);
      for (const key of ["parties", "column_header", "order_strip"]) expect(certBlock(layout, key).box.y, key).toBeCloseTo(laid.start(key), 2);
      for (const key of ["parts", "price", "totals"]) expect(certBlock(layout, key).box.y, key).toBeCloseTo(laid.start(key) + INV_FLOOR, 2);
      await invGolden(richOverlay(data), config, layout);
    }, 60_000);

    it("a Totals section shown with every row hidden seeds the last block at the row floor, nothing below it; the canvas prints the flow's paper", async () => {
      const { invoice } = await invoiceDraft();
      const data = await invData(invoice.id);
      const config = invCfg();
      hideAll(config, "totals");
      const layout = await seedInvoiceLayout(invoice.id, config, undefined);
      expect(certBlock(layout, "totals").box.h).toBe(INV_FLOOR);
      await invGolden(richOverlay(data), config, layout);
    }, 60_000);

    it("Column headers shown with every column hidden seed that block and the parts block at the row floor (the parts print nothing under no grid); the price block prints its heading alone on the stand-in", async () => {
      const { invoice } = await invoiceDraft();
      const data = await invData(invoice.id);
      const config = invCfg();
      hideAll(config, "column_header");
      const laid = await invLaid(data, config);
      expect(laid.height("column_header")).toBe(0);
      expect(laid.height("parts")).toBe(0);
      const layout = await seedInvoiceLayout(invoice.id, config, undefined);
      expect(certBlock(layout, "column_header").box.h).toBe(INV_FLOOR);
      expect(certBlock(layout, "column_header").columns.every((c) => !c.visible)).toBe(true);
      expect(certBlock(layout, "parts").box.h).toBe(INV_FLOOR);
      // The price block's stand-in height is the PRICE heading alone (its 8 pt above and 2 pt below).
      expect(certBlock(layout, "price").box.h).toBeGreaterThan(INV_FLOOR);
      expect(certBlock(layout, "price").box.y).toBeCloseTo(laid.start("price") + 2 * INV_FLOOR, 2);
      await invGolden(richOverlay(data), config, layout);
    }, 60_000);

    it("a section shown with every field hidden (the parts, the prices) seeds its block with every row hidden and prints the flow's blank rows and rules", async () => {
      const { invoice } = await invoiceDraft();
      const data = await invData(invoice.id);
      for (const section of ["parts", "price"]) {
        const config = invCfg();
        hideAll(config, section);
        const layout = await seedInvoiceLayout(invoice.id, config, undefined);
        expect(invRows(layout, section).every(([, visible]) => visible === false), section).toBe(true);
        await invGolden(richOverlay(data), config, layout);
      }
    }, 60_000);
  });

  it.each(["header-left", "header-center", "header-right"] as const)("the logo at %s prints the flow's paper; at the side the header's width shrinks by the logo's", async (placement) => {
    const { invoice } = await invoiceDraft();
    const data = await invData(invoice.id);
    const config = invCfg();
    config.logo = { placement, width: 60 };
    const layout = await seedInvoiceLayout(invoice.id, config, LOGO);
    const logoItem = layout.items.find((i) => i.kind === "logo")!;
    expect(logoItem).toMatchObject({ anchor: { kind: "page-top" }, box: { w: 60 } });
    const side = placement === "header-center" ? 0 : 60 + IW.headerLogoGap;
    for (const key of ["title", "company_name"]) {
      expect(fieldItem(layout, key)!.box.w, key).toBe(CONTENT_WIDTH - side);
      expect(fieldItem(layout, key)!.box.x, key).toBe(placement === "header-left" ? MARGIN + side : MARGIN);
    }
    if (placement === "header-right") expect(logoItem.box.x).toBe(RIGHT_EDGE - 60);
    const { flow, canvas } = await invGolden(richOverlay(data), config, layout, LOGO);
    // The logo prints where the flow prints it, at its size (the comparison counts image paints only).
    const [flowLogo] = drawnImages(flow)[0];
    const [canvasLogo] = drawnImages(canvas)[0];
    expect(drawnImages(canvas)[0]).toHaveLength(1);
    for (const k of ["x", "y", "w", "h"] as const) expect(Math.abs(canvasLogo[k] - flowLogo[k]), k).toBeLessThanOrEqual(1);
  }, 60_000);

  it("typed labels survive the seed: each item's and row's stored label is the typed one, and the paper is the flow's; a 30-part invoice prints the typed number label on page 2", async () => {
    const { invoice } = await invoiceDraft();
    const data = await invData(invoice.id);
    const config = invCfg();
    const typed: [string, string, string][] = [
      ["identity", "invoice_no", "Inv #:"], ["identity", "remit_to", "Pay To"], ["footer", "footer_contact", "Contact: Billing"],
      ["footer", "footer_phone", "Tel:"],
      ["parties", "bill_to", "Sold to:"], ["order_strip", "your_po", "PO:"], ["price", "price_heading", "CHARGES"],
      ["totals", "subtotal", "Subtotal:"], ["totals", "total", "Amount due:"],
    ];
    for (const [section, key, label] of typed) fieldOf(config, section, key).label = label;
    const layout = await seedInvoiceLayout(invoice.id, config, undefined);
    for (const key of ["invoice_no", "remit_to", "footer_contact", "footer_phone"]) {
      expect(fieldItem(layout, key)!.label, key).toBe(typed.find(([, k]) => k === key)![2]);
    }
    for (const [section, key, label] of typed.filter(([s]) => INV_BLOCKS.includes(s))) {
      expect(certBlock(layout, section).columns.find((c) => c.key === key)!.label, key).toBe(label);
    }
    // An untyped label is stored as the config holds it.
    expect(fieldItem(layout, "invoice_date")!.label).toBeNull();
    await invGolden(richOverlay(data), config, layout);

    const long = await invPapers(manyParts(data), config, layout);
    expect(pageCount(long.canvas)).toBeGreaterThan(1);
    expect(runsOnPage(long.canvas, 1).some((l) => l.text.startsWith("Inv #:"))).toBe(true);
    expect(runsOnPage(long.canvas, 1).some((l) => l.text === "(continued)")).toBe(true);
    expect(runsOnPage(long.flow, 1).some((l) => l.text.startsWith("Inv #:"))).toBe(true);
  }, 120_000);

  it("a typed column label is stored, an untyped one null; a hidden row and column are stored hidden, the parties' rows in their order and the sections in theirs, and the paper is the flow's", async () => {
    const { invoice } = await invoiceDraft();
    const data = await invData(invoice.id);
    const standard = await seedInvoiceLayout(invoice.id, invCfg(), undefined);
    expect(certBlock(standard, "column_header").columns.find((c) => c.key === "col_amount")!.label).toBeNull();
    expect(certBlock(standard, "column_header").columns.map((c) => c.key)).toEqual(["col_qty", "col_info", "col_each_weight", "col_amount"]);

    const labelled = invCfg();
    fieldOf(labelled, "column_header", "col_amount").label = "Amount";
    expect(certBlock(await seedInvoiceLayout(invoice.id, labelled, undefined), "column_header").columns.find((c) => c.key === "col_amount")!.label)
      .toBe("Amount");

    const config = invCfg();
    fieldOf(config, "parts", "part_qty").visible = false;
    fieldOf(config, "column_header", "col_each_weight").visible = false;
    invSection(config, "parties").fields.reverse();
    moveSectionBefore(config, "totals", "price");
    const layout = await seedInvoiceLayout(invoice.id, config, undefined);
    expect(invRows(layout, "parts")[0]).toEqual(["part_qty", false, null]);
    expect(certBlock(layout, "column_header").columns.find((c) => c.key === "col_each_weight")!.visible).toBe(false);
    expect(invRows(layout, "parties").map(([key]) => key)).toEqual(["ship_to", "bill_to"]);
    expect(tablesByY(layout).map((t) => t.key)).toEqual(["parties", "column_header", "order_strip", "parts", "totals", "price"]);
    await invGolden(richOverlay(data), config, layout);
  }, 60_000);

  it("the addresses: either one hidden prints the flow's paper; both hidden seed no parties block and the column headers where the flow lays them out", async () => {
    const { invoice } = await invoiceDraft();
    const data = await invData(invoice.id);
    for (const hidden of [["bill_to"], ["ship_to"]]) {
      const config = invCfg();
      for (const key of hidden) fieldOf(config, "parties", key).visible = false;
      const layout = await seedInvoiceLayout(invoice.id, config, undefined);
      expect(invRows(layout, "parties").filter(([, visible]) => visible).length, hidden[0]).toBe(1);
      await invGolden(richOverlay(data), config, layout);
    }
    const config = invCfg();
    fieldOf(config, "parties", "bill_to").visible = false;
    fieldOf(config, "parties", "ship_to").visible = false;
    const layout = await seedInvoiceLayout(invoice.id, config, undefined);
    expect(tablesByY(layout).map((t) => t.key)).toEqual(INV_BLOCKS.slice(1));
    const laid = await invLaid(data, config);
    expect(certBlock(layout, "column_header").box.y).toBeCloseTo(laid.start("column_header"), 2);
    await invGolden(richOverlay(data), config, layout);
  }, 60_000);

  it("a hidden Header seeds no title or company name, a hidden Identity none of its four; each prints the flow's paper", async () => {
    const { invoice } = await invoiceDraft();
    const data = await invData(invoice.id);
    const cases: [string, string[]][] = [["header", ["title", "company_name"]], ["identity", ["invoice_no", "invoice_date", "terms", "remit_to"]]];
    for (const [section, keys] of cases) {
      const config = invCfg();
      invSection(config, section).visible = false;
      const layout = await seedInvoiceLayout(invoice.id, config, undefined);
      for (const key of keys) expect(fieldItem(layout, key), key).toBeUndefined();
      await invGolden(richOverlay(data), config, layout);
    }
  }, 60_000);

  describe("the strip", () => {
    it("at 754 with the page line off; its bottom at the page's foot with it on; each band item as tall as its alone layout", async () => {
      const { invoice } = await invoiceDraft();
      const data = await invData(invoice.id);
      const off = await seedInvoiceLayout(invoice.id, invCfg(), undefined);
      expect(bandItems(off).map((i) => i.box.y)).toEqual([INV_STRIP_TOP, INV_STRIP_TOP, INV_STRIP_TOP]);
      const heights = await invoiceStrip(invoiceStandIn(data, invCfg()), invCfg());
      expect(bandItems(off).map((i) => i.box.h)).toEqual([heights.address, heights.contact, heights.phone].map((h) => Math.round(h! * 1000) / 1000));
      for (const item of bandItems(off)) expect(item.box.h).toBeGreaterThan(INVOICE_DEFAULT_CONFIG.fonts.smallSize);

      const config = invCfg();
      config.pageFooter = true;
      const on = await seedInvoiceLayout(invoice.id, config, undefined);
      expect(() => validateCanvasLayout(on, INVOICE_CONTRACT, { pageFooter: true })).not.toThrow();
      for (const item of bandItems(on)) expect(item.box.y + item.box.h).toBeCloseTo(pageFoot(true), 3);

      // Seeded with the page line off, the strip ends past the foot the page line leaves.
      let refusal: unknown = null;
      try { validateCanvasLayout(off, INVOICE_CONTRACT, { pageFooter: true }); } catch (err) { refusal = err; }
      expect(refusal).toBeInstanceOf(TemplateConfigError);
      expect((refusal as TemplateConfigError).itemIds).toEqual([fieldItem(off, "footer_address")!.id]);
    }, 60_000);

    it("each of its fields hidden in turn takes the flow's widths and prints the flow's paper; a hidden Footer seeds no band item", async () => {
      const { invoice } = await invoiceDraft();
      const data = await invData(invoice.id);
      const cases: [string, [string, number, number][]][] = [
        ["footer_address", [["footer_contact", MARGIN, IW.footerContact], ["footer_phone", MARGIN + IW.footerContact, IW.footerPhone]]],
        ["footer_contact", [["footer_address", MARGIN, CONTENT_WIDTH - IW.footerPhone], ["footer_phone", RIGHT_EDGE - IW.footerPhone, IW.footerPhone]]],
        ["footer_phone", [["footer_address", MARGIN, CONTENT_WIDTH - IW.footerContact], ["footer_contact", RIGHT_EDGE - IW.footerContact, IW.footerContact]]],
      ];
      for (const [hidden, expected] of cases) {
        const config = invCfg();
        fieldOf(config, "footer", hidden).visible = false;
        const layout = await seedInvoiceLayout(invoice.id, config, undefined);
        expect(bandItems(layout).map((i) => [i.key, i.box.x, i.box.w]), hidden).toEqual(expected);
        await invGolden(richOverlay(data), config, layout);
      }
      const config = invCfg();
      invSection(config, "footer").visible = false;
      const layout = await seedInvoiceLayout(invoice.id, config, undefined);
      expect(bandItems(layout)).toEqual([]);
      await invGolden(richOverlay(data), config, layout);
    }, 60_000);
  });

  it("the repeat: the invoice number repeats on the Standard's order; nothing repeats with it hidden, nor with the addresses ordered above the identity, whose pieces ride the addresses and print the flow's paper", async () => {
    const { invoice } = await invoiceDraft();
    const standard = await seedInvoiceLayout(invoice.id, invCfg(), undefined);
    expect(standard.items.filter((i) => i.repeat && i.anchor.kind !== "page-bottom").map((i) => i.kind === "field" ? i.key : i.kind)).toEqual(["invoice_no"]);
    const hidden = invCfg();
    fieldOf(hidden, "identity", "invoice_no").visible = false;
    const reordered = invCfg();
    moveSectionBefore(reordered, "parties", "identity");
    for (const config of [hidden, reordered]) {
      const layout = await seedInvoiceLayout(invoice.id, config, undefined);
      expect(layout.items.filter((i) => i.repeat && i.anchor.kind !== "page-bottom")).toEqual([]);
    }
    const reorderedLayout = await seedInvoiceLayout(invoice.id, reordered, undefined);
    expect(fieldItem(reorderedLayout, "invoice_no")!.anchor).toEqual({ kind: "below-table", table: "parties" });
    // The identity's pieces ride the addresses' rendered bottom, each at its offset from the block's
    // laid-out end: a longer bill-to than the stand-in's moves them down with it, as the flow does.
    await invGolden(richOverlay(await invData(invoice.id)), reordered, reorderedLayout);
  }, 60_000);

  describe("the grid", () => {
    it("the Column headers hidden over the contract's grid seed no column headers block and print the flow's paper", async () => {
      const { invoice } = await invoiceDraft();
      const config = invCfg();
      invSection(config, "column_header").visible = false;
      const layout = await seedInvoiceLayout(invoice.id, config, undefined);
      expect(tablesByY(layout).map((t) => t.key)).toEqual(INV_BLOCKS.filter((k) => k !== "column_header"));
      await invGolden(richOverlay(await invData(invoice.id)), config, layout);
    }, 60_000);

    // (pin, open question 3) The residual: under a grid with no "*" column the boxed header strip
    // prints narrower than its drawn box, while warning (g) judges the totals' right edge against
    // the drawn one; the canvas prints its totals where the flow prints them, the flow's own way.
    it("a typed Information width of 200 (no \"*\" column) (pin): the totals print where the flow's do", async () => {
      const { invoice } = await invoiceDraft();
      const config = invCfg();
      fieldOf(config, "column_header", "col_info").width = 200;
      const layout = await seedInvoiceLayout(invoice.id, config, undefined);
      expect(certBlock(layout, "column_header").columns.find((c) => c.key === "col_info")!.width).toBe(200);
      await invGolden(richOverlay(await invData(invoice.id)), config, layout);
    }, 60_000);
  });

  it("the walk skips every id outside the seed's namespace", async () => {
    const { invoice } = await invoiceDraft();
    const data = await invData(invoice.id);
    const config = invCfg();
    const laid = await invLaid(data, config);
    const strip = await invoiceStrip(invoiceStandIn(data, config), config);
    const mid = Math.floor(laid.positions.length / 2);
    const foreign = [
      { id: "invoice-order-strip", page: 1, left: 30, top: 300 },
      { id: "foreign-node", page: 1, left: 40, top: 310 },
    ] as LaidOutNode[];
    const withForeign = [...laid.positions.slice(0, mid), ...foreign, ...laid.positions.slice(mid)];
    expect(invItems({ version: 1, items: seedInvoiceItems(config, withForeign, strip, false, false) }))
      .toEqual(invItems({ version: 1, items: seedInvoiceItems(config, laid.positions.filter((n) => n.id.startsWith("seed:")), strip, false, false) }));
  }, 60_000);

  it("an invoice with no part lines, and one with no operation lines, print where the flow prints them under the Standard's seed", async () => {
    const { invoice } = await invoiceDraft();
    const data = await invData(invoice.id);
    const layout = await seedInvoiceLayout(invoice.id, invCfg(), undefined);
    await invGolden({ ...richOverlay(data), parts: [], priceRows: richOverlay(data).priceRows.map((p) => ({ ...p, partIndex: null })) }, invCfg(), layout);
    await invGolden({ ...richOverlay(data), priceRows: [] }, invCfg(), layout);
  }, 60_000);

  it("the residuals, measured and pinned (§4.4, §4.5, §15)", async () => {
    const { invoice } = await invoiceDraft();
    const data = await invData(invoice.id);
    const config = invCfg();
    const layout = await seedInvoiceLayout(invoice.id, config, undefined);
    const figures: Record<string, number> = {};
    const number = fieldItem(layout, "invoice_no")!;
    figures.invoiceNoTop = number.box.y;
    figures.invoiceNoBottom = number.box.y + number.box.h;
    figures.repeatBand = topMargin(layout);
    figures.stripHeight = bandItems(layout)[0].box.h;
    figures.partiesToColumnHeaders = certBlock(layout, "column_header").box.y - (certBlock(layout, "parties").box.y + certBlock(layout, "parties").box.h);
    figures.headerHeight = fieldItem(layout, "company_name")!.box.y + fieldItem(layout, "company_name")!.box.h - fieldItem(layout, "title")!.box.y;
    // The continuation pages' and a one-page invoice's room, against the flow's (page 1 of a paging
    // flow and every continuation page start at its 40 pt overflow margin; every flow page ends at
    // its 44 pt bottom margin).
    const flowContinuationRoom = CANVAS_PAGE.height - INVOICE_PAGE.bottomMargin - INVOICE_PAGE.overflowTopMargin;
    const flowOnePageEnd = CANVAS_PAGE.height - INVOICE_PAGE.bottomMargin;
    figures.continuationRoomLessOff = flowContinuationRoom - (bandTop(layout, false) - topMargin(layout));
    figures.onePageRoomMoreOff = bandTop(layout, false) - flowOnePageEnd;
    const lineOn = invCfg();
    lineOn.pageFooter = true;
    const onLayout = await seedInvoiceLayout(invoice.id, lineOn, undefined);
    figures.continuationRoomLessOn = flowContinuationRoom - (bandTop(onLayout, true) - topMargin(onLayout));
    figures.onePageRoomLessOn = flowOnePageEnd - bandTop(onLayout, true);
    const noFooter = invCfg();
    invSection(noFooter, "footer").visible = false;
    const noFooterLayout = await seedInvoiceLayout(invoice.id, noFooter, undefined);
    figures.hiddenFooterRoomMore = bandTop(noFooterLayout, false) - flowOnePageEnd;
    // The empty column headers block's distance below it.
    const emptyGrid = invCfg();
    for (const f of invSection(emptyGrid, "column_header").fields) f.visible = false;
    const emptyGridLayout = await seedInvoiceLayout(invoice.id, emptyGrid, undefined);
    const ch = certBlock(emptyGridLayout, "column_header").box;
    figures.emptyColumnHeadersBelow = certBlock(emptyGridLayout, "order_strip").box.y - (ch.y + ch.h);

    // A paging invoice: its page 1 against its flow print, its page 2's first body line against the flow's.
    const paging = await invPapers(manyParts(data), config, layout);
    const firstTop = (pdf: Buffer, page: number, skip: (text: string) => boolean = () => false) =>
      rawLines(pdf, page).filter((l) => !skip(l.text)).sort((a, b) => a.top - b.top)[0].top;
    figures.pagedRise = firstTop(paging.flow, 0) - firstTop(paging.canvas, 0);
    const notBody = (text: string) => text.startsWith("Invoice No.:") || text === "(continued)";
    figures.page2BodyLower = firstTop(paging.canvas, 1, notBody) - firstTop(paging.flow, 1, notBody);
    // The strip with the page line on, against the flow's.
    const stripOn = await invPapers(richOverlay(data), lineOn, onLayout);
    const stripTop = (pdf: Buffer) => rawLines(pdf, 0).find((l) => l.text.includes("Contact: Accounts Receivable"))!.top;
    const pageLineTop = (pdf: Buffer) => rawLines(pdf, 0).find((l) => /^Page 1 of 1/.test(l.text))!.top;
    figures.stripRiseOn = stripTop(stripOn.flow) - stripTop(stripOn.canvas);
    // The page line's baseline under the band's bottom: its 8 pt top margin and its 8.5 pt bold line's ascent.
    figures.pageLineUnderBand = pageLineTop(stripOn.canvas) - pageFoot(true);
    figures.pageLineRiseOn = pageLineTop(stripOn.flow) - pageLineTop(stripOn.canvas);
    for (const [key, value] of Object.entries(INVOICE_SEED_RESIDUALS)) {
      expect(Math.abs(figures[key] - value), `${key}: measured ${figures[key]}`).toBeLessThanOrEqual(0.01);
    }

    // "(continued)"'s right edge in each face, against the invoice number's label's x.
    const continuedRight: Record<string, number> = {};
    for (const family of FONT_FAMILIES) {
      const pdf = await renderPdf({
        pageSize: "LETTER", pageMargins: [MARGIN, MARGIN, MARGIN, MARGIN], defaultStyle: { font: family },
        content: [{ text: [{ text: "(continued)", italics: true, fontSize: CONTINUED_FONT_SIZE }, { text: "X", fontSize: CONTINUED_FONT_SIZE }] }],
      });
      continuedRight[family] = textRunsWithY(pdf)[0].find((r) => r.text === "X")!.x;
    }
    for (const [family, right] of Object.entries(CONTINUED_RIGHT_EDGES)) {
      expect(Math.abs(continuedRight[family] - right), `${family}: measured ${continuedRight[family]}`).toBeLessThanOrEqual(0.01);
    }
    // The invoice number's label starts at the identity's indent; in Roboto Mono "(continued)" runs
    // past it, under the label (the residual design §4.4 predicts; a warning names it, never a refusal).
    expect(number.box.x).toBe(MARGIN + IW.identityIndent);
  }, 120_000);

  it("composed: the invoice's seeded Standard, previewed for the same invoice through renderInvoiceCanvasPreview, warns through its measure of the accepted set, and the measure holds every item", async () => {
    // The cert's `seededPreviewWarnings` composition, written over `seedInvoiceLayout` and
    // `renderInvoiceCanvasPreview` directly, from before PR 3, when `seedCanvasLayout` and
    // `renderPreview` refused an invoice layout; they reach the same two functions now.
    const { invoice } = await invoiceDraft();
    const config = invCfg();
    const layout = await seedInvoiceLayout(invoice.id, config, undefined);
    const working = invCanvasCfg(config, layout);
    const { measure } = await renderInvoiceCanvasPreview(await invData(invoice.id), working, undefined);
    expect(measure).not.toBeNull();
    const m = measure!;
    const options = { pageFooter: working.pageFooter, fonts: working.fonts };
    expect(namedWarnings(layout, canvasWarnings(layout, INVOICE_CONTRACT, m, options))).toEqual(INVOICE_ACCEPTED_WARNINGS);
    expect(m.pages).toBe(1);
    expect(m.tables.map((table) => table.key)).toEqual(INV_BLOCKS);
    const ids = new Set(m.items.map((item) => item.id));
    expect(layout.items.filter((item) => item.kind !== "table" && !ids.has(item.id))).toEqual([]);
    // The set is the measure's, not the drawn boxes': the same measure judging the Remit To box drawn
    // shorter than it printed warns that it prints taller, beside the accepted set.
    const remitTo = fieldItem(layout, "remit_to")!;
    const printed = m.items.find((item) => item.id === remitTo.id)!.height;
    const short: CanvasLayout = {
      ...layout, items: layout.items.map((i) => (i === remitTo ? { ...remitTo, box: { ...remitTo.box, h: printed - 2 } } : i)),
    };
    expect(namedWarnings(short, canvasWarnings(short, INVOICE_CONTRACT, m, options)).map((w) => w.items))
      .toEqual([["remit_to"], ...INVOICE_ACCEPTED_WARNINGS.map((w) => w.items)]);
  }, 60_000);

  it("a page-2 item (design §15): the invoice's seeded Standard plus a Text item below the totals, previewed for a 30-part invoice, is measured and staged on the page it laid out on, the Remit To box on page 1, and its warnings are the accepted set", async () => {
    const { invoice } = await invoiceDraft();
    const config = invCfg();
    const seeded = await seedInvoiceLayout(invoice.id, config, undefined);
    // The seed places nothing below the totals block; the added item hangs two grid steps under it.
    expect(seeded.items.some((i) => i.anchor.kind === "below-table" && i.anchor.table === "totals")).toBe(false);
    const added: CanvasItem = {
      id: "added-text", kind: "text", text: "Thank you for your business", box: { x: MARGIN, y: 2 * CANVAS_GRID, w: 200, h: 12 },
      anchor: { kind: "below-table", table: "totals" }, repeat: false, style: { size: 9, bold: false, align: "left" },
    };
    const layout: CanvasLayout = { ...seeded, items: [...seeded.items, added] };
    const working = invCanvasCfg(config, layout);
    const { pdf, measure } = await renderInvoiceCanvasPreview(manyParts(await invData(invoice.id)), working, undefined);
    expect(measure).not.toBeNull();
    const m = measure!;
    expect(m.pages).toBeGreaterThanOrEqual(2);
    expect(pageCount(pdf)).toBe(m.pages);
    const totals = m.tables.find((table) => table.key === "totals")!;
    expect(totals.page).toBeGreaterThan(1);

    const remitTo = fieldItem(layout, "remit_to")!;
    expect(stageBox(remitTo, layout, m).page).toBe(1);
    const entry = m.items.find((item) => item.id === added.id)!;
    expect(entry.page).toBe(m.regions.find((r) => r.after === "totals")!.page);
    expect(entry.page).toBeGreaterThan(1);
    expect(stageBox(added, layout, m).page).toBe(entry.page);
    // The stage draws an item on another page dashed at its drawn box, and a drag starts there.
    expect(dragStart(added, layout, m)).toEqual(drawnBox(added, layout));
    // The accepted set and no (a): the blocks that page are measured as ONE box each, its height the
    // flow extent across every page it prints on (`canvasMeasure`), so they run past the band, where
    // the strip's three repeated items print; warning (a) judges each only down to the band's top.
    const band = bandTop(layout, working.pageFooter);
    expect(m.tables.filter((table) => table.top + table.height > band).map((table) => table.key)).toEqual(["parts", "price"]);
    expect(bandItems(layout).map((item) => item.repeat)).toEqual([true, true, true]);
    const options = { pageFooter: working.pageFooter, fonts: working.fonts };
    expect(namedWarnings(layout, canvasWarnings(layout, INVOICE_CONTRACT, m, options))).toEqual(INVOICE_ACCEPTED_WARNINGS);
  }, 60_000);

  // (pin) The seed has no write to delete; no mutation of this task reds it.
  it("writes nothing (pin): no stored document, audit row, draft or filing ticket, and the invoice's derived Printed is unchanged", async () => {
    const { invoice } = await invoiceDraft();
    const documents = await prisma.storedDocument.count();
    const audits = await prisma.auditLog.count();
    const versions = await prisma.documentTemplateVersion.findMany({ orderBy: { id: "asc" } });
    const drafts = await prisma.orderDraft.count();
    const before = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    const ticket = nextFilingTicket();
    await seedInvoiceLayout(invoice.id, invCfg(), undefined);
    expect(nextFilingTicket()).toBe(ticket + 1);
    expect(await prisma.storedDocument.count()).toBe(documents);
    expect(await prisma.storedDocument.count({ where: { invoiceId: invoice.id } })).toBe(0);
    expect(await prisma.auditLog.count()).toBe(audits);
    expect(await prisma.documentTemplateVersion.findMany({ orderBy: { id: "asc" } })).toEqual(versions);
    expect(await prisma.orderDraft.count()).toBe(drafts);
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).toEqual(before);
  }, 60_000);

  // (pin) The refusal is `readInvoiceDetail`'s own; no mutation of this task reds it.
  it("an id naming no invoice is refused with the invoice's 404 (pin)", async () => {
    await expect(seedInvoiceLayout("no-such-invoice", invCfg(), undefined)).rejects.toThrow("Invoice not found");
  });
});

// ---------------------------------------------------------------------------------------------
// The invoice's seed refusals (invoice canvas design 2026-11-10 §5.3, §15; PR 2 Task 9): the
// Column headers sentence first, before any read, then the page count (Task 8's), the header's and
// the identity's widths, and the drawn stack's fit, each pinned whole. A case's preconditions (the
// stand-in's one flow page, the laid-out left that runs past the margin, the drawn bottom past the
// band) are asserted first on the seed's own layout, built from its exported pieces with no refusal
// run (`unjudgedInvoiceLayout`). `FIT_CLEARANCE` at 0 reds no case: the clearance is the bill of
// lading's own residual (its value pinned by no case there either), carried here as built.
// ---------------------------------------------------------------------------------------------

const INV_GRID_SENTENCE =
  "The canvas starts from today's paper, and this template hides its Column headers while setting their columns apart from the Standard's (their order, widths or which are shown); a canvas with no Column headers block prints the body under the Standard's columns. Show the Column headers, or set their columns back to the Standard's, before designing on a canvas.";
const INV_HEADER_SENTENCE =
  "The canvas starts from an invoice whose header fits the page; laid out at its least, this template's header runs past the page's right margin. Change this template's settings (its logo's width, font or heading size) so the header fits the page's width.";
const INV_IDENTITY_SENTENCE =
  "The canvas starts from an invoice whose identity lines and Remit To box fit the page; laid out at its least, this template's Remit To box runs past the page's right margin. Change this template's settings (its font, sizes or labels) so they fit the page's width.";
const INV_FIT_SENTENCE =
  "The canvas starts from a one-page invoice; laid out at its least on the canvas, this template's invoice runs past one page. Change this template's settings (its font, sizes, logo or page line) so it fits one page.";

/** The seed's refusal, its class, status and whole sentence. */
async function expectInvoiceRefusal(seeding: Promise<unknown>, sentence: string) {
  let refusal: unknown = null;
  try { await seeding; } catch (err) { refusal = err; }
  expect(refusal).toBeInstanceOf(HttpError);
  expect((refusal as HttpError).status).toBe(400);
  expect((refusal as HttpError).message).toBe(sentence);
}

/** The seed's own layout for `config`, built from its exported pieces with none of its refusals run,
 *  beside the stand-in's flow page count and the band's top: a refusal case's preconditions. */
async function unjudgedInvoiceLayout(invoiceId: string, config: TemplateConfig, logo?: string) {
  const data = await invData(invoiceId);
  const standIn = invoiceStandIn(data, config);
  const laid = await invLaid(data, config, logo);
  const strip = await invoiceStrip(standIn, config, logo);
  const layout: CanvasLayout = {
    version: 1, items: withInvoiceRepeat(seedInvoiceItems(config, laid.positions, strip, logo !== undefined, config.pageFooter)),
  };
  return {
    layout,
    laid,
    band: bandTop(layout, config.pageFooter),
    flowPages: pageCount(await renderPdf(buildInvoiceDefinition(standIn, config, logo))),
    bottom: (item: CanvasItem) => { const box = drawnBox(item, layout); return box.y + box.h; },
  };
}

/** A square logo: its printed height is its placed width. */
const SQUARE_LOGO = pngDataUri(alphaPng(10, 10));
/** A wide, short logo (64:1), so a wide header logo stays one short row. */
const WIDE_LOGO = pngDataUri(alphaPng(64, 1));
/** A header-centre square logo's width that draws the Standard's totals block's bottom between the
 *  band's top with the page line on (about 739.2) and the flow's 748: the stand-in's totals end at
 *  about 301.4 with no logo, and the logo adds its height. */
const FIT_LOGO_WIDTH = 442;
/** The seed's clearance: a drawn bottom other than the band's keeps two thousandths of a point above
 *  the band's top (the bill of lading's, `BOL_FIT_CLEARANCE` above). */
const INV_FIT_CLEARANCE = 2;

describe("seedInvoiceLayout's refusals: a template's settings that the canvas cannot start from are refused in their own sentences", () => {
  describe("sentence 1: a hidden Column headers section over columns of its own", () => {
    const hiddenHeaders = (edit: (c: TemplateConfig) => void): TemplateConfig => {
      const c = invCfg();
      invSection(c, "column_header").visible = false;
      edit(c);
      return c;
    };
    const differing: [string, (c: TemplateConfig) => void][] = [
      ["a typed Quantity width of 60", (c) => { fieldOf(c, "column_header", "col_qty").width = 60; }],
      ["the Each weight column hidden", (c) => { fieldOf(c, "column_header", "col_each_weight").visible = false; }],
      ["the Amount column moved before the Quantity column", (c) => {
        const fields = invSection(c, "column_header").fields;
        const [amount] = fields.splice(fields.findIndex((f) => f.key === "col_amount"), 1);
        fields.unshift(amount);
      }],
    ];

    it.each(differing)("refused under %s", async (_why, edit) => {
      const { invoice } = await invoiceDraft();
      const config = hiddenHeaders(edit);
      expect(gridDiffers(config)).toBe(true);
      await expectInvoiceRefusal(seedInvoiceLayout(invoice.id, config, undefined), INV_GRID_SENTENCE);
    }, 60_000);

    it("refused before any read: an id naming no invoice answers the same sentence", async () => {
      const config = hiddenHeaders(differing[0][1]);
      await expectInvoiceRefusal(seedInvoiceLayout("no-such-invoice", config, undefined), INV_GRID_SENTENCE);
    });

    // Green on arrival: each names the mutation that reds it.
    it("not refused under a typed Quantity width of 52, the Standard's own (red under the typed widths compared raw)", async () => {
      const { invoice } = await invoiceDraft();
      const config = hiddenHeaders((c) => { fieldOf(c, "column_header", "col_qty").width = IW.qty; });
      expect(gridDiffers(config)).toBe(false);
      const layout = await seedInvoiceLayout(invoice.id, config, undefined);
      expect(tablesByY(layout).map((t) => t.key)).toEqual(INV_BLOCKS.filter((k) => k !== "column_header"));
    }, 60_000);

    it("not refused under a typed column label alone (red under the labels compared too)", async () => {
      const { invoice } = await invoiceDraft();
      const config = hiddenHeaders((c) => { fieldOf(c, "column_header", "col_amount").label = "Price"; });
      expect(gridDiffers(config)).toBe(false);
      const layout = await seedInvoiceLayout(invoice.id, config, undefined);
      expect(tablesByY(layout).map((t) => t.key)).toEqual(INV_BLOCKS.filter((k) => k !== "column_header"));
    }, 60_000);

    it("not refused with the section shown over those same columns (red under the section's visibility ignored)", async () => {
      const { invoice } = await invoiceDraft();
      const config = invCfg();
      for (const [, edit] of differing) edit(config);
      expect(gridDiffers(config)).toBe(false);
      const layout = await seedInvoiceLayout(invoice.id, config, undefined);
      expect(certBlock(layout, "column_header").columns.map((c) => [c.key, c.visible, c.width])).toEqual([
        ["col_amount", true, null], ["col_qty", true, 60], ["col_info", true, null], ["col_each_weight", false, null],
      ]);
    }, 60_000);
  });

  describe("sentence 3: the header past the page's right margin", () => {
    it.each(["header-left", "header-right"] as const)("a %s logo 564 pt wide, the schema's most, is refused in the header sentence", async (placement) => {
      const { invoice } = await invoiceDraft();
      const config = invCfg();
      config.logo = { placement, width: CONTENT_WIDTH };
      const u = await unjudgedInvoiceLayout(invoice.id, config, WIDE_LOGO);
      expect(u.flowPages, "the stand-in prints one flow page").toBe(1);
      if (placement === "header-left") {
        // The title's and the company name's laid-out left: the margin, the logo and the gap, past 588.
        for (const key of ["title", "company_name"]) {
          const left = u.laid.positions.find((n) => n.id === INVOICE_SEED_IDS.piece(key))!.left;
          expect(left, key).toBe(MARGIN + CONTENT_WIDTH + IW.headerLogoGap);
          expect(left, key).toBeGreaterThan(RIGHT_EDGE);
        }
      }
      for (const key of ["title", "company_name"]) expect(fieldItem(u.layout, key)!.box.w, key).toBeLessThanOrEqual(0);
      await expectInvoiceRefusal(seedInvoiceLayout(invoice.id, config, WIDE_LOGO), INV_HEADER_SENTENCE);
    }, 60_000);

    it("the width before the fit: a 564 pt header-left logo over a band raised past the blocks is refused in the header sentence, not the canvas one", async () => {
      await asSystem(() => setSetting("company_address", "100 Example Way\nAnniston AL 36207"));
      const { invoice } = await invoiceDraft();
      const config = invCfg();
      config.logo = { placement: "header-left", width: CONTENT_WIDTH };
      config.pageFooter = true;
      config.fonts.smallSize = 72;
      const u = await unjudgedInvoiceLayout(invoice.id, config, WIDE_LOGO);
      expect(u.flowPages, "the stand-in prints one flow page").toBe(1);
      for (const key of ["title", "company_name"]) expect(fieldItem(u.layout, key)!.box.w, key).toBeLessThanOrEqual(0);
      expect(u.bottom(certBlock(u.layout, "totals")), "the drawn stack does not fit the canvas either").toBeGreaterThan(u.band);
      await expectInvoiceRefusal(seedInvoiceLayout(invoice.id, config, WIDE_LOGO), INV_HEADER_SENTENCE);
    }, 60_000);

    // (pin) Open question 11: a title pushed only part of the way seeds, clamped to the margin, as the
    // certification's does; pdfmake widens the flow's "*" title column to its word, so the flow prints
    // the title past the margin while the canvas prints it in the clamped box (the residual design §14
    // states). No mutation of this task reds it.
    it("a header-left logo 500 pt wide seeds, the title and company name clamped to the 56 pt left them (pin)", async () => {
      const { invoice } = await invoiceDraft();
      const config = invCfg();
      config.logo = { placement: "header-left", width: 500 };
      const layout = await seedInvoiceLayout(invoice.id, config, WIDE_LOGO);
      for (const key of ["title", "company_name"]) {
        expect(fieldItem(layout, key)!.box, key).toMatchObject({ x: MARGIN + 500 + IW.headerLogoGap, w: RIGHT_EDGE - (MARGIN + 500 + IW.headerLogoGap) });
        expect(fieldItem(layout, key)!.box.w, key).toBe(56);
      }
    }, 60_000);
  });

  it("sentence 4: an Invoice No. label of 100 unbroken W's pushes the Remit To box past the page's right margin, refused in the identity sentence", async () => {
    const { invoice } = await invoiceDraft();
    const config = invCfg();
    fieldOf(config, "identity", "invoice_no").label = "W".repeat(100);
    const u = await unjudgedInvoiceLayout(invoice.id, config);
    expect(u.flowPages, "the stand-in prints one flow page").toBe(1);
    const flow = await renderPdf(buildInvoiceDefinition(invoiceStandIn(await invData(invoice.id), config), config));
    const remit = textRunsWithY(flow)[0].find((r) => r.text.startsWith("Remit"))!;
    expect(remit.x, "the flow prints its Remit To box past the right margin").toBeGreaterThanOrEqual(RIGHT_EDGE);
    expect(fieldItem(u.layout, "remit_to")!.box.w).toBeLessThanOrEqual(0);
    for (const key of ["title", "company_name"]) expect(fieldItem(u.layout, key)!.box.w, key).toBeGreaterThan(0);
    await expectInvoiceRefusal(seedInvoiceLayout(invoice.id, config, undefined), INV_IDENTITY_SENTENCE);
  }, 60_000);

  describe("sentence 5: one flow page that is not one canvas page", () => {
    it("a header-centre logo drawing the totals block past the band the page line leaves is refused in the canvas sentence; with the page line off it seeds", async () => {
      const { invoice } = await invoiceDraft();
      const config = invCfg();
      config.pageFooter = true;
      config.logo = { placement: "header-center", width: FIT_LOGO_WIDTH };
      const u = await unjudgedInvoiceLayout(invoice.id, config, SQUARE_LOGO);
      expect(u.flowPages, "the stand-in prints one flow page").toBe(1);
      const totals = certBlock(u.layout, "totals");
      expect(u.bottom(totals)).toBeGreaterThan(u.band);
      expect(u.bottom(totals)).toBeLessThanOrEqual(CANVAS_PAGE.height - INVOICE_PAGE.bottomMargin);
      for (const item of u.layout.items) expect(item.box.w, item.kind).toBeGreaterThan(0);
      await expectInvoiceRefusal(seedInvoiceLayout(invoice.id, config, SQUARE_LOGO), INV_FIT_SENTENCE);

      config.pageFooter = false;
      const layout = await seedInvoiceLayout(invoice.id, config, SQUARE_LOGO);
      const off = drawnBox(certBlock(layout, "totals"), layout);
      expect(off.y + off.h).toBeLessThan(bandTop(layout, false));
    }, 60_000);

    it("a large small size over a two-line company address raises the band past the blocks with the page line on, refused in the canvas sentence", async () => {
      await asSystem(() => setSetting("company_address", "100 Example Way\nAnniston AL 36207"));
      const { invoice } = await invoiceDraft();
      const config = invCfg();
      config.pageFooter = true;
      config.fonts.smallSize = 72;
      const u = await unjudgedInvoiceLayout(invoice.id, config);
      expect(u.flowPages, "the stand-in prints one flow page").toBe(1);
      expect(u.bottom(certBlock(u.layout, "totals"))).toBeGreaterThan(u.band);
      for (const item of u.layout.items) expect(item.box.w, item.kind).toBeGreaterThan(0);
      await expectInvoiceRefusal(seedInvoiceLayout(invoice.id, config, undefined), INV_FIT_SENTENCE);
    }, 60_000);

    it("an item below a block that runs past the band: the identity ordered after the totals under the same logo, its Remit To box riding them past the band while every block clears it, is refused in the canvas sentence", async () => {
      const { invoice } = await invoiceDraft();
      const config = invCfg();
      // The identity's own 8 pt bottom margin leaves the flow less than a point past the Standard's
      // band, so a 12 pt small size raises the band (about 733.9) and opens the window.
      config.pageFooter = true;
      config.fonts.smallSize = 12;
      config.logo = { placement: "header-center", width: FIT_LOGO_WIDTH };
      moveSectionBefore(config, "identity", "footer");
      const u = await unjudgedInvoiceLayout(invoice.id, config, SQUARE_LOGO);
      expect(u.flowPages, "the stand-in prints one flow page").toBe(1);
      const grains = (n: number) => Math.round(n * 1000);
      for (const block of tablesByY(u.layout)) expect(grains(u.bottom(block)), block.key).toBeLessThanOrEqual(grains(u.band) - INV_FIT_CLEARANCE);
      const remit = fieldItem(u.layout, "remit_to")!;
      expect(remit.anchor).toEqual({ kind: "below-table", table: "totals" });
      expect(u.bottom(remit)).toBeGreaterThan(u.band);
      expect(u.bottom(remit)).toBeLessThanOrEqual(CANVAS_PAGE.height - INVOICE_PAGE.bottomMargin);
      const past = u.layout.items.filter((i) => i.anchor.kind !== "page-bottom" && u.bottom(i) > u.band);
      expect(past.map((i) => (i.kind === "field" ? i.key : i.kind))).toEqual(["remit_to"]);
      await expectInvoiceRefusal(seedInvoiceLayout(invoice.id, config, SQUARE_LOGO), INV_FIT_SENTENCE);
    }, 60_000);

    // Green on arrival: red under the clearance applied to a page-bottom item.
    it("the Standard with the page line on is not refused: its strip ends on the page's foot, judged with no clearance", async () => {
      const { invoice } = await invoiceDraft();
      const config = invCfg();
      config.pageFooter = true;
      const layout = await seedInvoiceLayout(invoice.id, config, undefined);
      expect(bandItems(layout)).toHaveLength(3);
      for (const item of bandItems(layout)) expect(item.box.y + item.box.h).toBe(pageFoot(true));
      // The foot the page line leaves is the flow's own bottom margin's top (748).
      expect(pageFoot(true)).toBe(CANVAS_PAGE.height - INVOICE_PAGE.bottomMargin);
    }, 60_000);
  });

  // (pin) No mutation of this task reds it; it is red under Task 8's stand-in keeping the record's
  // parts (refused in sentence 2).
  it("a picked invoice of 40 parts is refused by none (pin): the stand-in lays every growing block out at its least", async () => {
    const { invoice } = await invoiceDraft({ parts: 40 });
    const layout = await seedInvoiceLayout(invoice.id, invCfg(), undefined);
    expect(tablesByY(layout).map((t) => t.key)).toEqual(INV_BLOCKS);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------
// The invoice's and the credit memo's seed through its real door (invoice canvas PR 3, Task 2):
// with INVOICE in CANVAS_PRINTS, `POST /api/templates/[id]/draft/canvas` reaches `seedCanvasLayout`'s
// INVOICE arm, gated on `templates.edit` and the invoice's own record area, `invoicing.view`
// (`RECORD_AREA.INVOICE`). Each case is green on arrival and names the mutation that reds it.
// ---------------------------------------------------------------------------------------------

let invTemplateSeq = 0;
/** An INVOICE template whose v1 draft holds `config` (and the logo, when given): the `certDraft` shape. */
async function invoiceTemplateDraft(config: TemplateConfig, logo?: Buffer) {
  invTemplateSeq += 1;
  const t = await asSystem(() => createTemplate("INVOICE", `Seed Invoice ${invTemplateSeq}`));
  await asSystem(() => editDraft(t.id, { config, updatedAt: t.draft.updatedAt }));
  if (logo) await asSystem(() => uploadLogo(t.id, logo, "image/png"));
  return t;
}

describe("the route: an invoice or credit draft's canvas, seeded through POST /api/templates/[id]/draft/canvas", () => {
  const ask = (templateId: string, cookie: string, body: unknown) => seedRoute(new Request(`http://t/api/templates/${templateId}/draft/canvas`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: templateId }) });
  const draftOf = (templateId: string) =>
    prisma.documentTemplateVersion.findFirstOrThrow({ where: { templateId, status: "DRAFT" } });

  // Red under `RECORD_AREA.INVOICE` set to "orders": the invoice's record area is its own, not the order's.
  it("a user holding templates.edit and orders.view is 403", async () => {
    const { invoice } = await invoiceDraft();
    const t = await invoiceTemplateDraft(invCfg());
    const ordersToo = await signInWith(["templates.edit", "orders.view"], "inv-seed-orders");
    expect((await ask(t.id, ordersToo, { recordId: invoice.id, config: invCfg() })).status).toBe(403);
  }, 60_000);

  // The 200 is red under `seedCanvasLayout`'s INVOICE arm deleted (the default's plain Error, which
  // `handle` rethrows) and under `RECORD_AREA.INVOICE` set to "orders"; the edit-only 403 is red under
  // the route's second `mustCan` deleted. The 401 and the nothing-written half are pins: no mutation
  // of this task reds them (the route has no write to delete).
  it("the route: no session is 401, templates.edit alone is 403 without invoicing.view, both is 200 and nothing is written", async () => {
    const { invoice } = await invoiceDraft();
    const t = await invoiceTemplateDraft(invCfg());
    const editOnly = await signInWith(["templates.edit"], "inv-seed-edit");
    const both = await signInWith(["templates.edit", "invoicing.view"], "inv-seed-both");
    const body = { recordId: invoice.id, config: invCfg() };

    const before = await draftOf(t.id);
    const documents = await prisma.storedDocument.count();
    const audits = await prisma.auditLog.count();
    const invoiceBefore = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });

    expect((await ask(t.id, "", body)).status).toBe(401);
    expect((await ask(t.id, editOnly, body)).status).toBe(403);
    const res = await ask(t.id, both, body);
    expect(res.status).toBe(200);
    const layout = canvasLayoutSchema.parse(await res.json());
    expect(tablesByY(layout).map((table) => table.key)).toEqual(INV_BLOCKS);
    const direct = await seedInvoiceLayout(invoice.id, invCfg(), undefined);
    expect(invItems(layout)).toEqual(invItems(direct));

    const after = await draftOf(t.id);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.config).toEqual(before.config);
    expect(await prisma.storedDocument.count()).toBe(documents);
    expect(await prisma.auditLog.count()).toBe(audits);
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).toEqual(invoiceBefore);
  }, 60_000);

  // Red under `seedCanvasLayout`'s INVOICE arm deleted and under `RECORD_AREA.INVOICE` set to "orders".
  it("the route seeds a credit memo: the same six blocks, its title a field item printing the data", async () => {
    const { credit } = await creditDraft();
    const t = await invoiceTemplateDraft(invCfg());
    const both = await signInWith(["templates.edit", "invoicing.view"], "inv-seed-credit");
    const res = await ask(t.id, both, { recordId: credit.id, config: invCfg() });
    expect(res.status).toBe(200);
    const layout = canvasLayoutSchema.parse(await res.json());
    expect(tablesByY(layout).map((table) => table.key)).toEqual(INV_BLOCKS);
    // The title is the data's ("Credit" on this record, `invData(credit.id).title`), never a typed word.
    // The null label and the no-"Invoice"-text line are pins: the seed emits no text item, and no
    // mutation of this task reaches the label; the status and blocks above carry the red.
    const title = fieldItem(layout, "title");
    expect(title).toBeDefined();
    expect(title!.label).toBeNull();
    expect(layout.items.filter((i) => i.kind === "text" && /Invoice/.test(i.text))).toEqual([]);
    expect(invItems(layout)).toEqual(invItems(await seedInvoiceLayout(credit.id, invCfg(), undefined)));
  }, 60_000);

  // Red under `seedCanvasLayout`'s INVOICE arm deleted (both reject: the 400's refusal and the 404's
  // read are the arm's) and under `RECORD_AREA.INVOICE` set to "orders" (each answers 403).
  it("the route answers the seed's own refusals as 400 in their sentences, and a record naming no invoice as 404", async () => {
    const { invoice } = await invoiceDraft();
    const t = await invoiceTemplateDraft(invCfg());
    const both = await signInWith(["templates.edit", "invoicing.view"], "inv-seed-refused");
    const before = await draftOf(t.id);

    const hidden = invCfg();
    invSection(hidden, "column_header").visible = false;
    fieldOf(hidden, "column_header", "col_info").width = 200;
    expect(gridDiffers(hidden)).toBe(true);
    const refused = await ask(t.id, both, { recordId: invoice.id, config: hidden });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: INV_GRID_SENTENCE });

    const missing = await ask(t.id, both, { recordId: "no-such-invoice", config: invCfg() });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Invoice not found" });

    const after = await draftOf(t.id);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.config).toEqual(before.config);
  }, 60_000);

  // Red first: before `seededPreviewWarnings` had an INVOICE arm it judged the invoice against the
  // multi-order ticket's contract. Red under `seedCanvasLayout`'s INVOICE arm deleted. The direct
  // variant ("composed: …renderInvoiceCanvasPreview…") stays beside it.
  it("the route's composition: the seeded Standard, composed through seedCanvasLayout and renderPreview, reports the accepted warning set", async () => {
    const { invoice } = await invoiceDraft();
    const t = await invoiceTemplateDraft(invCfg());
    const { measure, measured } = await seededPreviewWarnings(t.id, invoice.id, invCfg());
    expect(measure.tables.map((table) => table.key)).toEqual(INV_BLOCKS);
    expect(measured).toEqual(INVOICE_ACCEPTED_WARNINGS);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// The statement's seed through its route (design 2026-11-11 §5.3, §7; since statement canvas PR 2):
// with STATEMENT in CANVAS_PRINTS, `POST /api/templates/[id]/draft/canvas` reaches `seedCanvasLayout`'s
// STATEMENT arm (`seedStatementLayout`, src/server/statement-canvas-seed.ts, whose own suite is
// tests/statement-canvas-seed.test.ts), gated on `templates.edit` and the statement's own record area,
// `receivables.view` (`RECORD_AREA.STATEMENT`). The picked record is a customer.
// ---------------------------------------------------------------------------------------------

let stmtTemplateSeq = 0;
/** A STATEMENT template whose v1 draft holds `config`: the `invoiceTemplateDraft` shape. */
async function statementTemplateDraft(config: TemplateConfig) {
  stmtTemplateSeq += 1;
  const t = await asSystem(() => createTemplate("STATEMENT", `Seed Statement ${stmtTemplateSeq}`));
  await asSystem(() => editDraft(t.id, { config, updatedAt: t.draft.updatedAt }));
  return t;
}

describe("the route: a statement draft's canvas, seeded through POST /api/templates/[id]/draft/canvas", () => {
  const stmtCfg = (): TemplateConfig => structuredClone(STATEMENT_DEFAULT_CONFIG);
  const ask = (templateId: string, cookie: string, body: unknown) => seedRoute(new Request(`http://t/api/templates/${templateId}/draft/canvas`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: templateId }) });
  const draftOf = (templateId: string) =>
    prisma.documentTemplateVersion.findFirstOrThrow({ where: { templateId, status: "DRAFT" } });
  const customerFor = () => prisma.customer.create({ data: { code: `STSEED${(stmtTemplateSeq += 1)}`, name: "Statement Seed Customer" } });

  /** A draft, a customer, and the counts and the draft row before the request: `unchanged` then holds
   *  that the request stored no document, wrote no audit row and left the draft as it was. */
  async function routeCase() {
    const customer = await customerFor();
    const t = await statementTemplateDraft(stmtCfg());
    const body = { recordId: customer.id, config: stmtCfg() };
    const before = await draftOf(t.id);
    const documents = await prisma.storedDocument.count();
    const audits = await prisma.auditLog.count();
    const unchanged = async () => {
      const after = await draftOf(t.id);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(after.config).toEqual(before.config);
      expect(await prisma.storedDocument.count()).toBe(documents);
      expect(await prisma.auditLog.count()).toBe(audits);
    };
    return { t, body, unchanged };
  }

  // Red under `seedCanvasLayout`'s STATEMENT arm deleted (the default's plain Error, which `handle`
  // rethrows, so the call rejects), under "STATEMENT" out of CANVAS_PRINTS (the seed's 400 in the
  // later-release sentence) and under `RECORD_AREA.STATEMENT` set to "invoicing" (a 403). The
  // nothing-written half is a pin: the route has no write to delete.
  it("the route answers a statement draft 200 with a layout validateConfig accepts, storing and auditing nothing", async () => {
    const { t, body, unchanged } = await routeCase();
    const both = await signInWith(["templates.edit", "receivables.view"], "stmt-seed-both");
    const res = await ask(t.id, both, body);
    expect(res.status).toBe(200);
    const layout = canvasLayoutSchema.parse(await res.json());
    expect(validateConfig("STATEMENT", { ...stmtCfg(), layout }).layout).toEqual(layout);
    expect(tablesByY(layout).map((table) => table.key)).toEqual(["bill_to", "open_items", "aging", "finance_charge", "total"]);
    await unchanged();
  }, 60_000);

  // (pin) Green on arrival: the route's `requireUser()` refuses before any permission check or record read,
  // and no change to the statement's arms reaches it.
  it("the route answers a statement draft with no session 401 (pin)", async () => {
    const { t, body } = await routeCase();
    expect((await ask(t.id, "", body)).status).toBe(401);
  }, 60_000);

  // Green on arrival; red under the route's second `mustCan` deleted (run). The nothing-written half
  // is a pin.
  it("the route answers templates.edit alone 403 on a statement draft, storing and auditing nothing", async () => {
    const { t, body, unchanged } = await routeCase();
    const editOnly = await signInWith(["templates.edit"], "stmt-seed-edit");
    expect((await ask(t.id, editOnly, body)).status).toBe(403);
    await unchanged();
  }, 60_000);

  // Green on arrival; red under `RECORD_AREA.STATEMENT` set to "invoicing" and under the route's
  // second `mustCan` deleted (both run). The nothing-written half is a pin.
  it("the route answers templates.edit with invoicing.view and no receivables.view 403 on a statement draft, storing and auditing nothing", async () => {
    const { t, body, unchanged } = await routeCase();
    const editAndInvoicing = await signInWith(["templates.edit", "invoicing.view"], "stmt-seed-invoicing");
    expect((await ask(t.id, editAndInvoicing, body)).status).toBe(403);
    await unchanged();
  }, 60_000);

  // Red under `seedCanvasLayout`'s STATEMENT arm deleted (the plain Error rejects the call; the 404 is
  // the arm's own read) and under `RECORD_AREA.STATEMENT` set to "invoicing" (it answers 403).
  it("the route answers a deleted customer's statement 404 Customer not found, the draft untouched", async () => {
    const customer = await customerFor();
    await prisma.customer.update({ where: { id: customer.id }, data: { deletedAt: new Date() } });
    const t = await statementTemplateDraft(stmtCfg());
    const both = await signInWith(["templates.edit", "receivables.view"], "stmt-seed-deleted");
    const before = await draftOf(t.id);
    const res = await ask(t.id, both, { recordId: customer.id, config: stmtCfg() });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Customer not found" });
    const after = await draftOf(t.id);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.config).toEqual(before.config);
  }, 60_000);
});

let quoteTemplateSeq = 0;
async function quoteTemplateDraft(config: TemplateConfig) {
  quoteTemplateSeq += 1;
  const t = await asSystem(() => createTemplate("QUOTE", `Seed Quotation ${quoteTemplateSeq}`));
  await asSystem(() => editDraft(t.id, { config, updatedAt: t.draft.updatedAt }));
  return t;
}

describe("the route: a quotation draft's canvas, seeded through POST /api/templates/[id]/draft/canvas (since quote canvas PR 2)", () => {
  const quoteCfg = (): TemplateConfig => structuredClone(QUOTE_DEFAULT_CONFIG);
  const ask = (templateId: string, cookie: string, body: unknown) => seedRoute(new Request(`http://t/api/templates/${templateId}/draft/canvas`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: templateId }) });
  const draftOf = (templateId: string) =>
    prisma.documentTemplateVersion.findFirstOrThrow({ where: { templateId, status: "DRAFT" } });

  /** A draft, a picked quote, and the counts and the draft row before the request: `unchanged` then
   *  holds that the request stored no document, wrote no audit row and left the draft as it was. */
  async function routeCase(recordId?: string) {
    const customer = await makeQuoteCustomer();
    await makeBillTo(customer.id);
    const quote = await quoteFor(customer);
    const t = await quoteTemplateDraft(quoteCfg());
    const body = { recordId: recordId ?? quote.id, config: quoteCfg() };
    const before = await draftOf(t.id);
    const documents = await prisma.storedDocument.count();
    const audits = await prisma.auditLog.count();
    const unchanged = async () => {
      const after = await draftOf(t.id);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(after.config).toEqual(before.config);
      expect(await prisma.storedDocument.count()).toBe(documents);
      expect(await prisma.auditLog.count()).toBe(audits);
    };
    return { t, body, unchanged };
  }

  // Red under `seedCanvasLayout`'s QUOTE arm deleted (cast to compile: the default's plain Error, which
  // `handle` rethrows, so the call rejects) and under "QUOTE" out of CANVAS_PRINTS (the seed's 400 in
  // the later-release sentence). The nothing-written half is a pin: the route has no write to delete.
  it("the route answers a quotation draft and a picked quote 200 with a layout validateConfig accepts, storing and auditing nothing", async () => {
    const { t, body, unchanged } = await routeCase();
    const both = await signInWith(["templates.edit", "quotes.view"], "quote-seed-both");
    const res = await ask(t.id, both, body);
    expect(res.status).toBe(200);
    const layout = canvasLayoutSchema.parse(await res.json());
    expect(validateConfig("QUOTE", { ...quoteCfg(), layout }).layout).toEqual(layout);
    expect(tablesByY(layout).map((table) => table.key)).toEqual(["parties", "intro", "column_header", "lines", "closing", "liability"]);
    await unchanged();
  }, 60_000);

  // Green on arrival (quote canvas PR 1's Departure 7: the route's second `mustCan` reads
  // `RECORD_AREA.QUOTE`); red under that `mustCan` deleted (run). The nothing-written half is a pin.
  it("the route answers templates.edit without quotes.view 403 on a quotation draft, storing and auditing nothing", async () => {
    const { t, body, unchanged } = await routeCase();
    const editOnly = await signInWith(["templates.edit"], "quote-seed-edit");
    expect((await ask(t.id, editOnly, body)).status).toBe(403);
    await unchanged();
  }, 60_000);

  // (pin) Green on arrival: the route's `requireUser()` refuses before any permission check or quote
  // code runs, and no change to the quote's arms reaches it.
  it("the route answers a quotation draft with no session 401 (pin)", async () => {
    const { t, body } = await routeCase();
    expect((await ask(t.id, "", body)).status).toBe(401);
  }, 60_000);

  // Red under `seedCanvasLayout`'s QUOTE arm deleted (the plain Error rejects the call; the 404 is the
  // arm's own read, `readQuotePdfData`'s) and under "QUOTE" out of CANVAS_PRINTS (a 400 first).
  it("the route answers an unknown quote 404 Quote not found on a quotation draft, the draft untouched", async () => {
    const { t, body, unchanged } = await routeCase("no-such-quote");
    const both = await signInWith(["templates.edit", "quotes.view"], "quote-seed-unknown");
    const res = await ask(t.id, both, body);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Quote not found" });
    await unchanged();
  }, 60_000);
});

describe("the container tag's seed (the container tag design of 2026-11-13, PR 3: the canvas prints)", () => {
  beforeEach(truncateAll);

  it("the route reaches the CONTAINER_TAG arm, which refuses an unknown order 404 in the print route's sentence", async () => {
    // Since PR 3 Task 5 the tag is in CANVAS_PRINTS, so `assertCanvasPrints` passes and the arm reads the
    // order (`seedContainerTagLayout`; its cases are tests/container-tag-canvas-seed.test.ts's). Red
    // under the arm's old plain Error (no status) and under "CONTAINER_TAG" out of CANVAS_PRINTS (a 400).
    const both = await signInWith(["templates.edit", "orders.view"], "tag-seed-both");
    const id = templateId("CONTAINER_TAG");
    const res = await seedRoute(new Request(`http://t/api/templates/${id}/draft/canvas`, {
      method: "POST", headers: { cookie: both, "content-type": "application/json" },
      body: JSON.stringify({ recordId: "no-such-order", config: defaultConfigFor("CONTAINER_TAG") }),
    }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "Order not found" });
    await expect(seedCanvasLayout({ docType: "CONTAINER_TAG", logoImage: null, logoMimeType: null }, { recordId: "no-such-order", config: defaultConfigFor("CONTAINER_TAG") }, "nobody"))
      .rejects.toMatchObject({ status: 404, message: "Order not found" });
  });
});

// ---------------------------------------------------------------------------------------------
// The raised least widths (#971 design §6, "Where the raised floors are met")
// ---------------------------------------------------------------------------------------------

describe("the seeds meet the raised least widths (#971)", () => {
  /** Every table the layout places drawn at or above its least width, at the config's base size and
   *  over the layout (a grid block's floor reads its grid), and the layout accepted by the rules. */
  function expectAtFloors(layout: CanvasLayout, contract: TemplateContract, config: TemplateConfig) {
    const tables = layout.items.filter((i) => i.kind === "table");
    expect(tables.length).toBeGreaterThan(0);
    for (const item of tables) {
      const least = leastWidth(contract, item, { fonts: config.fonts, layout });
      expect(item.box.w, `${contract.docType} ${item.kind === "table" ? item.key : item.id}`).toBeGreaterThanOrEqual(least);
    }
    expect(canvasSaveBlock(contract, { ...config, layout })).toBeNull();
  }
  /** `config` with the field `key` of section `section` typed `width` wide. */
  function typed(config: TemplateConfig, section: string, key: string, width: number): TemplateConfig {
    const field = config.sections.find((s) => s.key === section)!.fields.find((f) => f.key === key)!;
    field.width = width;
    return config;
  }

  it("each seed from its standard config draws every table at or above its floor", async () => {
    const { order } = await seededOrder();
    expectAtFloors(await seed(order.id, cfg()), TRAVELER_CONTRACT, cfg());
    for (const docType of ["SHIPPER", "MOS_SHIPPER"] as const) {
      const { shipper } = await ticketShipment();
      const contract = docType === "SHIPPER" ? SHIPPER_CONTRACT : MOS_SHIPPER_CONTRACT;
      expectAtFloors(await ticketSeed(shipper.id, ticketCfg(docType), docType), contract, ticketCfg(docType));
    }
    const { shipper: bol } = await bolShipment();
    expectAtFloors(await bolSeed(bol.id, bolCfg()), BOL_CONTRACT, bolCfg());
    const { cert } = await certOrder();
    const signer = await certSigner();
    expectAtFloors(await certSeed(cert.id, certCfg(), signer.id), CERT_CONTRACT, certCfg());
    const { invoice } = await invoiceDraft();
    expectAtFloors(await seedInvoiceLayout(invoice.id, invCfg(), undefined), INVOICE_CONTRACT, invCfg());
  }, 60_000);

  it("the invoice's seed under a widened grid draws its part rows and prices at or above the raised floor", async () => {
    const { invoice } = await invoiceDraft();
    const wide = typed(invCfg(), "column_header", "col_each_weight", 86);
    const layout = await seedInvoiceLayout(invoice.id, wide, undefined);
    for (const key of ["parts", "price"]) {
      const item = layout.items.find((i) => i.kind === "table" && i.key === key)!;
      expect(leastWidth(INVOICE_CONTRACT, item, { layout })).toBe(250.5);
      expect(item.box.w).toBeGreaterThanOrEqual(250.5);
    }
    expectAtFloors(layout, INVOICE_CONTRACT, wide);
  }, 60_000);

  // The order strip's floor reads its indent past the column headers' Quantity column (`gridIndent`,
  // design §6.1): Quantity typed 100 (from 52) gives 100 + 6 + 60 + 4.5.
  it("the invoice's seed under a widened Quantity column draws its order strip at or above the raised floor", async () => {
    const { invoice } = await invoiceDraft();
    const wide = typed(invCfg(), "column_header", "col_qty", 100);
    const layout = await seedInvoiceLayout(invoice.id, wide, undefined);
    const strip = layout.items.find((i) => i.kind === "table" && i.key === "order_strip")!;
    expect(leastWidth(INVOICE_CONTRACT, strip, { layout })).toBe(170.5);
    expect(strip.box.w).toBeGreaterThanOrEqual(170.5);
    expectAtFloors(layout, INVOICE_CONTRACT, wide);
  }, 60_000);

  // The totals' floor follows the column headers' Amount column (`gridEdgeColumn`, #971): Amount
  // typed 200 (from 84) gives 200 + 200 + 2 × 6 + 4.5.
  it("the invoice's seed under a widened Amount column draws its totals at or above the raised floor", async () => {
    const { invoice } = await invoiceDraft();
    const wide = typed(invCfg(), "column_header", "col_amount", 200);
    const layout = await seedInvoiceLayout(invoice.id, wide, undefined);
    const totals = layout.items.find((i) => i.kind === "table" && i.key === "totals")!;
    expect(leastWidth(INVOICE_CONTRACT, totals, { layout })).toBe(416.5);
    expect(totals.box.w).toBeGreaterThanOrEqual(416.5);
    expectAtFloors(layout, INVOICE_CONTRACT, wide);
  }, 60_000);

  // A flow template whose column widths fit its budget but, with their padding and rules and one grid
  // step, pass the content width: the seed's full-width table is under its least width.
  // Owner ruling R-B (2026-11-17, #991): a flow config whose table's fixed columns, padding and rules, and one grid
  // step where a "*" column is shown, pass its budget is refused before any seed, in the budget's own sentence. These
  // were the inputs of the rule 9 cases below before it (the templates-admin E2E flow's Container typed 154 among them);
  // a seed is reached only from a config the contracts accept.
  it("refuses, before any seed, a flow config whose fixed columns and padding pass the page (R-B)", () => {
    const sentence = (docType: Parameters<typeof validateConfig>[0], config: TemplateConfig) => {
      try {
        validateConfig(docType, config);
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(sentence("TRAVELER", typed(cfg(), "quantities", "order_qty", 180))).toBe(
      // 512 + 48 = 560 fits the page: what fails is the flexible Container's 4.5 pt (#991 review F2).
      'The "quantities" table needs 564.5pt on paper (512pt of column widths, 48pt of cell padding, and 4.5pt ' +
      "for its flexible column), more than its 564pt budget: its fixed columns and their cell padding leave its flexible " +
      "column less than 4.5pt. Narrow or hide a column.");
    expect(sentence("TRAVELER", typed(cfg(), "quantities", "container", 154))).toBe(
      'The "quantities" table needs 612pt on paper (564pt of column widths, 48pt of cell padding), more than its ' +
      "564pt budget: its fixed columns alone would print past the page. Narrow or hide a column.");
    expect(sentence("SHIPPER", typed(ticketCfg("SHIPPER"), "containers", "container_type", 188))).toBe(
      'The "containers" table needs 286.5pt on paper (250pt of column widths each half, 32pt of cell padding, ' +
      // Containers and Tare both flexible: the band sentence names them in the plural (#991 review).
      "and 4.5pt for its flexible columns), more than the 282pt each half has: its fixed columns and their cell padding " +
      "leave its flexible columns less than 4.5pt. Narrow or hide a column.");
    expect(sentence("BOL", typed(bolCfg(), "freight", "freight_description", 198))).toBe(
      'The "freight" table needs 430.8pt on paper (386pt of column widths, 44.8pt of cell padding and rules), more than ' +
      "the 386pt it has beside the sidebar: its fixed columns alone would print past the page. Narrow or hide a column.");
    expect(sentence("CERT", typed(certCfg(), "parts", "part_qty", 446))).toBe(
      'The "parts" table needs 564.5pt on paper (536pt of column widths, 24pt of cell padding, and 4.5pt for its ' +
      "flexible column), more than its 564pt budget: its fixed columns and their cell padding leave its flexible column " +
      "less than 4.5pt. Narrow or hide a column.");
  });

  // With no "*" column shown the budget adds no grid step, where the canvas's least width does: a flow table whose
  // fixed columns and padding fill the page exactly is accepted, and its canvas's Save is closed by rule 9.
  it("the traveler, ticket and bill of lading seeds return a layout whose Save is closed by rule 9's sentence", async () => {
    const { order } = await seededOrder();
    const traveler = typed(cfg(), "quantities", "container", 106);
    const travelerLayout = await seed(order.id, traveler);
    expect(canvasSaveBlock(TRAVELER_CONTRACT, { ...traveler, layout: travelerLayout })).toBe(
      "The Quantities and containers table needs 568.5 pt: its visible columns' 516 pt, their 48 pt of padding and rules and one " +
      "grid step, more than its 564 pt.",
    );
    for (const docType of ["SHIPPER", "MOS_SHIPPER"] as const) {
      const { shipper } = await ticketShipment();
      const ticket = typed(typed(ticketCfg(docType), "containers", "container_count", 54), "containers", "container_tare", 54);
      const layout = await ticketSeed(shipper.id, ticket, docType);
      expect(canvasSaveBlock(docType === "SHIPPER" ? SHIPPER_CONTRACT : MOS_SHIPPER_CONTRACT, { ...ticket, layout })).toBe(
        "The Containers table needs 568.5 pt: its visible columns' 250 pt and their 32 pt of padding and rules, printed twice, " +
        "and one grid step, more than its 564 pt.",
      );
    }
    const { shipper: bolShipper } = await bolShipment();
    const bol = typed(bolCfg(), "freight", "freight_description", 152);
    const bolLayout = await bolSeed(bolShipper.id, bol);
    expect(canvasSaveBlock(BOL_CONTRACT, { ...bol, layout: bolLayout })).toBe(
      "The Freight table needs 567.3 pt: its visible columns' 340 pt, their 44.8 pt of padding and rules, the 178 pt it keeps " +
      "beside them and one grid step, more than its 564 pt.",
    );
  }, 60_000);

  // The flow as it stands since #971: the Container emptied before the save, the draft holding the
  // stale edits re-applied over the competing write (Part lines hidden, the Order number relabelled,
  // thousands flipped, the logo at header-left, the page line flipped). Its seeded canvas saves.
  it("the traveler seeded from the templates-admin flow's saved draft, its Container emptied, opens Save", async () => {
    const { order } = await seededOrder();
    const config = cfg();
    config.sections.find((s) => s.key === "lines")!.visible = false;
    config.sections.find((s) => s.key === "header")!.fields.find((f) => f.key === "order_number")!.label = "Work Order #";
    config.formats.thousandsSeparator = !config.formats.thousandsSeparator;
    config.logo = { placement: "header-left", width: DEFAULT_LOGO_WIDTH };
    config.pageFooter = !config.pageFooter;
    expect(config.sections.find((s) => s.key === "quantities")!.fields.find((f) => f.key === "container")!.width).toBeNull();
    const layout = await seed(order.id, config, alphaPng(160, 48));
    expect(canvasSaveBlock(TRAVELER_CONTRACT, { ...config, layout })).toBeNull();
    expectAtFloors(layout, TRAVELER_CONTRACT, config);
  }, 60_000);

  // #991 review I2: the certification's seed checks its blocks' width floors before the stand-in. Called directly with
  // the original input (the route refuses it first, by R-B), it answers rule 9's sentence; without that check the
  // stand-in, its identity column squeezed to 4 pt by the column clamp, pages and the one-page sentence came first.
  it("the certification's seed, called directly, answers rule 9's sentence ahead of the one-page check (I2)", async () => {
    const { cert } = await certOrder();
    const signer = await certSigner();
    const refusal = await seedCertLayout(cert.id, typed(certCfg(), "parts", "part_qty", 446), undefined, signer.id).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(HttpError);
    expect((refusal as HttpError).status).toBe(400);
    expect((refusal as HttpError).message).toBe(
      "The Part lines table needs 564.5 pt: its visible columns' 536 pt, their 24 pt of padding and rules and one grid step, " +
      "more than its 564 pt.");
  }, 60_000);

  it("the certification and invoice seeds refuse it as a 400 in rule 9's sentence; the invoice's grid past the page in rule 4's", async () => {
    const refused = async (seeding: Promise<unknown>, sentence: string) => {
      const refusal = await seeding.catch((e: unknown) => e);
      expect(refusal, String(refusal)).toBeInstanceOf(HttpError);
      expect((refusal as HttpError).status).toBe(400);
      expect((refusal as HttpError).message).toBe(sentence);
    };
    const { cert } = await certOrder();
    const signer = await certSigner();
    // Through the seed route a config is validated first (its part_qty 446 is R-B's, above), so the part lines' identity
    // is typed (no "*" column, no grid step on the budget): 70 + 380 + 90 and their 24 pt of padding fill the page.
    await refused(certSeed(cert.id, typed(certCfg(), "parts", "part_identity", 380), signer.id),
      "The Part lines table needs 568.5 pt: its visible columns' 540 pt, their 24 pt of padding and rules and one grid step, " +
      "more than its 564 pt.");
    const { invoice } = await invoiceDraft();
    await refused(seedInvoiceLayout(invoice.id, typed(invCfg(), "column_header", "col_each_weight", 388), undefined),
      "The Column headers table needs 564.5 pt: its visible columns' 524 pt, their 36 pt of padding and rules and one grid " +
      "step, more than its 564 pt.");
    // Wider still, the part rows' grid floor (rule 4, judged before rule 9) passes the page first.
    await refused(seedInvoiceLayout(invoice.id, typed(invCfg(), "column_header", "col_each_weight", 404), undefined),
      "The Part rows table is 564 pt wide, less than the 568.5 pt the column headers' columns, their gaps and one grid step need.");
  }, 60_000);
});
