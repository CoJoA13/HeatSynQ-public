import { describe, it, expect, beforeEach } from "vitest";
import {
  buildInvoiceDefinition, INVOICE_BOXED_FIELDS, INVOICE_FLOW, INVOICE_PAGE, INVOICE_SEED_IDS, INVOICE_WIDTHS, invoiceSeedStyle,
  seedSection,
  type InvoiceCtx, type InvoicePdfData,
} from "@/server/pdf/invoice";
import {
  LAYOUT, MEASURED_ROW_FLOOR, renderPdf, renderSheetGroupsWithPositions, TABLE_LAYOUTS, type LaidOutNode, type RenderableDefinition,
} from "@/server/pdf/render";
import { assembleCanvasSheet, CANVAS_IDS, defaultLabelOf, logoContent, strokeContent, textContent } from "@/server/pdf/canvas-sheet";
import { buildCanvasInvoiceDefinition, invoiceItemContent } from "@/server/invoice-canvas";
import { bandTop, canvasProfile, canvasRefusal, leastWidth, pageFoot, tablesByY, topMargin, validateCanvasLayout } from "@/lib/template-canvas";
import { INVOICE_CANVAS, INVOICE_CONTRACT, INVOICE_LEAST_WIDTHS, INVOICE_PRICE_INDENT, INVOICE_STRIP_INDENT, INVOICE_TOTALS_EDGE } from "@/lib/template-contracts/invoice";
import { textWidthOf } from "@/lib/tag-font-metrics";
import { TEXT_TOLERANCE, fontOf } from "./helpers/keep-in-box-cases";
import { INVOICE_DEFAULT_CONFIG, completeSections } from "@/lib/template-contracts/index";
import { CANVAS_GRID, CANVAS_PAGE, type CanvasItem, type CanvasLayout } from "@/lib/template-contracts/canvas";
import type { TemplateConfig } from "@/lib/template-contracts/types";
import type { Content } from "pdfmake/interfaces";
import { pageCount, paintedImageCounts, paintedImages, runFonts, strokedLines, textLinesWithY, textRunsWithY, TINY_JPEG } from "./helpers/pdf";
import { barcode, layoutOf, logo } from "./helpers/canvas-fixtures";
import { blockItems } from "./helpers/canvas-blocks";
import { flowLeastWidths } from "./helpers/invoice-flow-widths";
import { baselines, fieldsOf, onOneLine, RULE_WIDTH, ruledRules, type Run } from "./helpers/invoice-paper";
import {
  invoiceField, sampleInvoice, standardInvoiceLayout, type InvoiceTable,
} from "./helpers/invoice-canvas-fixtures";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createOrder } from "@/server/orders";
import { createShipper } from "@/server/shippers";
import { addPartPrice } from "@/server/part-prices";
import { createSurcharge } from "@/server/surcharges";
import { createInvoice, invoicePrintSettings, printInvoice, readInvoicePdfData } from "@/server/invoices";
import { seedInvoiceLayout } from "@/server/invoice-canvas-seed";
import { renderInvoiceCanvasPreview } from "@/server/template-preview";
import { createTemplate, editDraft, publishDraft, uploadLogo } from "@/server/templates";
import { assignTemplate } from "@/server/template-assignments";
import { barcodePng } from "@/server/pdf/render";
import { bandClipLayout, expectBandClip } from "./helpers/band-clip";

/**
 * The invoice's canvas (design 2026-11-10, PR 2). Task 1: the flow exports its widths
 * (`INVOICE_WIDTHS`), its page constants (`INVOICE_PAGE`), its boxed fields (`INVOICE_BOXED_FIELDS`)
 * and its builders (`INVOICE_FLOW`) with no change to its paper (tests/invoice-flow-oracle.test.ts);
 * the profile's least widths and boxed fields (PR 1 literals) are held to those exports here.
 */

describe("the flow's widths hold the profile (design 2026-11-10 §4.1, §12)", () => {
  const derived = flowLeastWidths();

  it("names a least width for exactly the five rows blocks (pin)", () => {
    expect(Object.keys(INVOICE_LEAST_WIDTHS).sort()).toEqual(["order_strip", "parties", "parts", "price", "totals"]);
    expect(Object.keys(derived).sort()).toEqual(Object.keys(INVOICE_LEAST_WIDTHS).sort());
  });

  it.each(Object.keys(INVOICE_LEAST_WIDTHS))("%s's least width is its derivation from the flow's widths", (key) => {
    expect(INVOICE_LEAST_WIDTHS[key]).toBe(derived[key]);
  });

  it("the profile's boxed fields are the flow's, and INVOICE_FLOW hands them on", () => {
    expect([...INVOICE_BOXED_FIELDS]).toEqual(canvasProfile(INVOICE_CONTRACT)!.boxedFields);
    expect(INVOICE_FLOW.boxedFields).toBe(INVOICE_BOXED_FIELDS);
  });

  it("the contract's column defaults are the flow's widths, the information column \"*\"", () => {
    const columns = INVOICE_CONTRACT.sections.find((s) => s.key === "column_header")!.fields;
    const width = (key: string) => columns.find((f) => f.key === key)!.column!.defaultWidth;
    expect([width("col_qty"), width("col_info"), width("col_each_weight"), width("col_amount")])
      .toEqual([INVOICE_WIDTHS.qty, "*", INVOICE_WIDTHS.each, INVOICE_WIDTHS.amt]);
  });

  it("the part rows' and the price block's grid gap is the flow's", () => {
    const gap = (key: string) => INVOICE_CANVAS.tables.find((t) => t.key === key)!.gridGap;
    expect([gap("parts"), gap("price")]).toEqual([INVOICE_WIDTHS.gridGap, INVOICE_WIDTHS.gridGap]);
  });

  it("the order strip's grid indent is the flow's indent past the Quantity column and the measured row's floor (#971)", () => {
    const strip = INVOICE_CANVAS.tables.find((t) => t.key === "order_strip")!;
    expect(strip.gridIndent).toBe(INVOICE_STRIP_INDENT);
    expect(INVOICE_STRIP_INDENT).toEqual({ column: "col_qty", gap: INVOICE_WIDTHS.stripIndentGap, floor: MEASURED_ROW_FLOOR });
    // At the contract's columns the indent's figure is the profile's entry, the flow's derivation.
    const item = standardInvoiceLayout().items.find((i) => i.kind === "table" && i.key === "order_strip")!;
    expect(leastWidth(INVOICE_CONTRACT, item, { layout: standardInvoiceLayout() })).toBe(INVOICE_LEAST_WIDTHS.order_strip);
    expect(leastWidth(INVOICE_CONTRACT, item)).toBe(INVOICE_LEAST_WIDTHS.order_strip);
    // It follows the Quantity column: typed wider, hidden.
    const typed = columnSet(standardInvoiceLayout(), "column_header", "col_qty", { width: 300 });
    expect(leastWidth(INVOICE_CONTRACT, item, { layout: typed })).toBe(300 + INVOICE_WIDTHS.stripIndentGap + MEASURED_ROW_FLOOR + CANVAS_GRID);
    const hidden = columnSet(standardInvoiceLayout(), "column_header", "col_qty", { visible: false });
    expect(leastWidth(INVOICE_CONTRACT, item, { layout: hidden })).toBe(INVOICE_WIDTHS.stripIndentGap + MEASURED_ROW_FLOOR + CANVAS_GRID);
  });

  it("the price block's grid indent is the flow's PRICE heading indent past the Quantity column, and its floor holds the heading (#971, Codex review)", () => {
    const price = INVOICE_CANVAS.tables.find((t) => t.key === "price")!;
    expect(price.gridIndent).toBe(INVOICE_PRICE_INDENT);
    // The builder's `priceBlock` indents its PRICE heading by `ctx.slotW.qty + W.stripIndentGap`.
    expect(INVOICE_PRICE_INDENT).toEqual({ column: "col_qty", gap: INVOICE_WIDTHS.stripIndentGap, floor: 0 });
    // The part rows print no line outside their grid's columns (the PARTS heading is the order
    // strip's), so they take none.
    expect(INVOICE_CANVAS.tables.find((t) => t.key === "parts")!.gridIndent).toBeUndefined();
    const item = (key: string) => standardInvoiceLayout().items.find((i) => i.kind === "table" && i.key === key)!;
    // At the contract's columns the grid's columns bind, as before.
    expect(leastWidth(INVOICE_CONTRACT, item("price"), { layout: standardInvoiceLayout() })).toBe(230.5);
    // With the Quantity column alone shown, its width, the heading's indent and one grid step bind:
    // 52 + 6 + 4.5, where the grid's columns alone ask 52 + 4.5 (the part rows' figure).
    const qtyOnly = ["col_info", "col_each_weight", "col_amount"].reduce(
      (l, c) => columnSet(l, "column_header", c, { visible: false }), standardInvoiceLayout(),
    );
    expect(leastWidth(INVOICE_CONTRACT, item("price"), { layout: qtyOnly })).toBe(INVOICE_WIDTHS.qty + INVOICE_WIDTHS.stripIndentGap + CANVAS_GRID);
    expect(leastWidth(INVOICE_CONTRACT, item("price"), { layout: qtyOnly })).toBe(62.5);
    expect(leastWidth(INVOICE_CONTRACT, item("parts"), { layout: qtyOnly })).toBe(56.5);
    // Typed wider, the floor follows by exactly the difference; untyped, the builder's 52 default.
    const typed = columnSet(qtyOnly, "column_header", "col_qty", { width: 300 });
    expect(leastWidth(INVOICE_CONTRACT, item("price"), { layout: typed })).toBe(300 + INVOICE_WIDTHS.stripIndentGap + CANVAS_GRID);
    const untyped = columnSet(qtyOnly, "column_header", "col_qty", { width: null });
    expect(leastWidth(INVOICE_CONTRACT, item("price"), { layout: untyped })).toBe(62.5);
    // Every column hidden: the heading still starts 6 pt in.
    const none = columnSet(qtyOnly, "column_header", "col_qty", { visible: false });
    expect(leastWidth(INVOICE_CONTRACT, item("price"), { layout: none })).toBe(INVOICE_WIDTHS.stripIndentGap + CANVAS_GRID);
    // Rule 4 refuses the price block under the figure, naming what it is for, and accepts it there.
    const at = (w: number) => reboxed(qtyOnly, "price", { x: 588 - w, w });
    expect(canvasRefusal(at(62), INVOICE_CONTRACT, { pageFooter: false })).toEqual({
      itemIds: ["table-price"],
      sentence: "The Price block table is 62 pt wide, less than the 62.5 pt the text it prints past the column headers' quantity column " +
        "and one grid step need.",
    });
    expect(canvasRefusal(at(62.5), INVOICE_CONTRACT, { pageFooter: false })).toBeNull();
  });

  it("the totals' edge column is the flow's amount column beside its label and gaps, and their floor follows a typed Amount (#971)", () => {
    const totals = INVOICE_CANVAS.tables.find((t) => t.key === "totals")!;
    expect(totals.gridEdgeColumn).toBe(INVOICE_TOTALS_EDGE);
    // The builder's `totalLine`: a "*" spacer, the label at `W.totalsLabel` and the amount at
    // `ctx.slotW.amt || W.amt`, `W.totalsGap` between each two.
    expect(INVOICE_TOTALS_EDGE).toEqual({ column: "col_amount", fixed: INVOICE_WIDTHS.totalsLabel + 2 * INVOICE_WIDTHS.totalsGap });
    const amount = INVOICE_CONTRACT.sections.flatMap((x) => x.fields).find((f) => f.key === "col_amount")!.column!.defaultWidth;
    expect(amount).toBe(INVOICE_WIDTHS.amt);
    const item = standardInvoiceLayout().items.find((i) => i.kind === "table" && i.key === "totals")!;
    // At the contract's columns, and with no layout handed, the profile's entry.
    expect(leastWidth(INVOICE_CONTRACT, item, { layout: standardInvoiceLayout() })).toBe(INVOICE_LEAST_WIDTHS.totals);
    expect(leastWidth(INVOICE_CONTRACT, item)).toBe(INVOICE_LEAST_WIDTHS.totals);
    // Typed wider, the floor rises by exactly the difference; hidden, the builder falls back to 84.
    const typed = columnSet(standardInvoiceLayout(), "column_header", "col_amount", { width: 120 });
    expect(leastWidth(INVOICE_CONTRACT, item, { layout: typed })).toBe(INVOICE_LEAST_WIDTHS.totals + 120 - INVOICE_WIDTHS.amt);
    const hidden = columnSet(standardInvoiceLayout(), "column_header", "col_amount", { visible: false, width: 120 });
    expect(leastWidth(INVOICE_CONTRACT, item, { layout: hidden })).toBe(INVOICE_LEAST_WIDTHS.totals);
    // Rule 4 refuses the totals under the figure, naming what it is for, and accepts them there.
    const at = (w: number) => reboxed(typed, "totals", { x: 588 - w, w });
    expect(canvasRefusal(at(336), INVOICE_CONTRACT, { pageFooter: false })).toEqual({
      itemIds: ["table-totals"],
      sentence: "The Totals table is 336 pt wide, less than the 336.5 pt the column headers' amount column at its edge, " +
        "its fixed parts beside it and one grid step need.",
    });
    expect(canvasRefusal(at(336.5), INVOICE_CONTRACT, { pageFooter: false })).toBeNull();
  });

  it("the part rows' and the price block's grid margin is the flow's information cell margin (#971 design §6.1)", () => {
    const margin = (key: string) => INVOICE_CANVAS.tables.find((t) => t.key === key)!.gridMargin;
    expect([margin("parts"), margin("price")]).toEqual([INVOICE_WIDTHS.infoMargin, INVOICE_WIDTHS.infoMargin]);
  });

  it("INVOICE_FLOW hands on INVOICE_WIDTHS itself", () => {
    expect(INVOICE_FLOW.widths).toBe(INVOICE_WIDTHS);
  });
});

/** One `columns` node of a definition: its column widths, its gap, its own left margin and each
 *  column's left margin (null where none is set). */
type ColumnsShape = { widths: unknown[]; gap: unknown; indent: unknown; margins: unknown[] };

const leftOf = (margin: unknown): unknown => (Array.isArray(margin) ? margin[0] : null);

/** Every `columns` node of `node`, in pre-order. */
function columnsShapes(node: unknown, out: ColumnsShape[] = []): ColumnsShape[] {
  if (Array.isArray(node)) {
    for (const child of node) columnsShapes(child, out);
    return out;
  }
  if (node === null || typeof node !== "object") return out;
  const o = node as Record<string, unknown>;
  if (Array.isArray(o.columns)) {
    const cols = o.columns as Record<string, unknown>[];
    out.push({
      widths: cols.map((c) => c.width), gap: o.columnGap ?? null, indent: leftOf(o.margin), margins: cols.map((c) => leftOf(c.margin)),
    });
  }
  for (const value of Object.values(o)) columnsShapes(value, out);
  return out;
}

describe("the flow prints at the widths it exports", () => {
  // A literal left in a flow block reds this as soon as its constant changes (a literal of another
  // value reds it now), where a changed constant read on both sides moves them together.
  const W = INVOICE_WIDTHS;

  it("every columns row of the Standard's content takes its widths, gaps and indents from INVOICE_WIDTHS", () => {
    // Exact and in order: the identity row (the identity lines indented, the Remit To column), the
    // addresses (the first indented), the order strip (indented past the Quantity column), the part
    // row and the operation row on the grid (the information cell's own margin), and the three
    // totals lines (Sub Total, the surcharge, Total Amount Due).
    const part = { widths: [W.qty, "*", W.each, W.amt], gap: W.gridGap, indent: 0, margins: [null, W.infoMargin, null, null] };
    const total = { widths: ["*", W.totalsLabel, W.amt], gap: W.totalsGap, indent: 0, margins: [null, null, null] };
    expect(columnsShapes(buildInvoiceDefinition(sampleInvoice()).content)).toEqual([
      { widths: ["*", W.remitTo], gap: W.identityGap, indent: 0, margins: [W.identityIndent, null] },
      { widths: ["*", "*"], gap: W.partiesGap, indent: 0, margins: [W.partiesIndent, null] },
      { widths: ["auto", "auto", "auto", "auto"], gap: W.stripGap, indent: W.qty + W.stripIndentGap, margins: [null, null, null, null] },
      part,
      part,
      total,
      total,
      total,
    ]);
  });

  it("the footer strip takes its contact and phone columns' widths from INVOICE_WIDTHS", () => {
    expect(columnsShapes(buildInvoiceDefinition(sampleInvoice()).footer)).toEqual([
      { widths: ["*", W.footerContact, W.footerPhone], gap: null, indent: 24, margins: [null, null, null] },
    ]);
  });
});

describe("the price rule's offset (design 2026-11-10 §5.2)", () => {
  // A canvas price block's wrapper is indented to its drawn x, so its rules are drawn from a
  // negative x back to the margin, across the content width (tests/render-primitives.test.ts proves
  // pdfmake strokes such a line where it is drawn). The flow's ctx carries no offset.
  const W = INVOICE_WIDTHS;
  const lineOf = (node: unknown) => (node as { canvas: Record<string, unknown>[] }).canvas[0];
  const ctx = (priceRule?: { x1: number; length: number }) => {
    const c = INVOICE_FLOW.ctxOf(INVOICE_DEFAULT_CONFIG, completeSections(INVOICE_CONTRACT, INVOICE_DEFAULT_CONFIG.sections), null);
    return priceRule === undefined ? c : { ...c, priceRule };
  };
  /** Two parts, each with one price, and one price that lost its part: three groups, three rules. */
  const threeGroups = () => sampleInvoice({
    parts: [
      { qty: 144, partNumber: "DEMO-9001-000", partName: "EQUALIZER-RR SUSP", partDescription: "", eachWeight: 21, totalWeight: 3024 },
      { qty: 50, partNumber: "DEMO-9002-000", partName: "SPRING SEAT", partDescription: "", eachWeight: 3.2, totalWeight: 160 },
    ],
    priceRows: [
      { description: "Austemper", pricePerLabel: "Each", unitPrice: 6.51, minimumCharge: null, setupCharge: null, amount: 937.44, partIndex: 0 },
      { description: "Temper", pricePerLabel: "Each", unitPrice: 2, minimumCharge: null, setupCharge: null, amount: 100, partIndex: 1 },
      { description: "Straighten", pricePerLabel: "Each", unitPrice: 1, minimumCharge: null, setupCharge: null, amount: 10, partIndex: null },
    ],
  });

  it("priceRule(below, x1, length) draws its line from x1 to x1 + length, its margin the owner's above and the space below", () => {
    const rule = INVOICE_FLOW.priceRule(1, -76, W.content);
    expect(lineOf(rule)).toMatchObject({ type: "line", x1: -76, y1: 0, x2: -76 + W.content, y2: 0, lineWidth: 0.5 });
    expect(lineOf(rule).x2).toBe(488);
    expect((rule as { margin: unknown }).margin).toEqual([0, 4, 0, 1]);
  });

  it("isPriceRule answers true for a rule priceRule made, and false for a hand-built node of the same shape", () => {
    const rule = INVOICE_FLOW.priceRule(1, -76, W.content);
    expect(INVOICE_FLOW.isPriceRule(rule)).toBe(true);
    expect(INVOICE_FLOW.isPriceRule(JSON.parse(JSON.stringify(rule)))).toBe(false);
    expect(INVOICE_FLOW.isPriceRule(null)).toBe(false);
    expect(INVOICE_FLOW.isPriceRule("text")).toBe(false);
  });

  it("priceBlock over a ctx carrying priceRule puts that line after each group", () => {
    const out = INVOICE_FLOW.priceBlock(ctx({ x1: -76, length: W.content }), threeGroups());
    const rules = out.map((node, i) => [i, node] as const).filter(([, node]) => INVOICE_FLOW.isPriceRule(node));
    expect(rules).toHaveLength(3);
    for (const [, rule] of rules) {
      expect(lineOf(rule)).toMatchObject({ x1: -76, x2: -76 + W.content });
      expect((rule as { margin: unknown }).margin).toEqual([0, 4, 0, 1]);
    }
    // After each group: the last node, and never two rules together nor a rule first.
    expect(rules.at(-1)![0]).toBe(out.length - 1);
    expect(rules[0][0]).toBeGreaterThan(0);
    for (let k = 1; k < rules.length; k++) expect(rules[k][0] - rules[k - 1][0]).toBeGreaterThan(1);
  });

  // Red under priceBlock's `ctx.priceRule?.x1 ?? 0` changed to `?? 1` (a flow rule moved off the
  // margin); none of Task 2's four mutations reaches it.
  it("the flow's ctx (no offset) draws each rule from the margin across the content width", () => {
    const out = INVOICE_FLOW.priceBlock(ctx(), threeGroups());
    const rules = out.filter((node) => INVOICE_FLOW.isPriceRule(node));
    expect(rules).toHaveLength(3);
    for (const rule of rules) expect(lineOf(rule)).toMatchObject({ x1: 0, x2: W.content });
  });
});

// ---------------------------------------------------------------------------------------------
// The field families (Task 4). `textLinesWithY` and `textRunsWithY` report a baseline from the
// page's BOTTOM edge; a run's x is its start, and `textLinesWithY` collapses a line's spacing.
// ---------------------------------------------------------------------------------------------

const cfg = (over: Partial<TemplateConfig> = {}): TemplateConfig => ({ ...structuredClone(INVOICE_DEFAULT_CONFIG), ...over });

/** The ctx the flow builds from `config` (its own `ctxOf`), so the date knob and the sections are the
 *  config's. */
const ctxFor = (config: TemplateConfig): InvoiceCtx =>
  INVOICE_FLOW.ctxOf(config, completeSections(INVOICE_CONTRACT, config.sections), null);

/** A sheet of these items alone (no block), rendered. */
async function renderItems(
  items: CanvasItem[], config: TemplateConfig = cfg(), d: InvoicePdfData = sampleInvoice(), flow = INVOICE_FLOW,
): Promise<Buffer> {
  return renderPdf(assembleCanvasSheet({
    layout: layoutOf(items), pageFooter: false, fonts: config.fonts,
    itemContent: invoiceItemContent(ctxFor(config), d, flow), tableBlock: () => null,
  }));
}

/** Page 1's printed lines. */
const linesOf = async (pdf: Promise<Buffer>) => textLinesWithY(await pdf)[0].map((l) => l.text).filter((t) => t !== "");

const isBold = (font: string): boolean => font.endsWith("-Medium") || font.endsWith("-Bold");

/** The flow's config with these fields of a section hidden. */
function hiding(section: string, ...fields: string[]): TemplateConfig {
  const config = cfg();
  config.sections = completeSections(INVOICE_CONTRACT, config.sections).map((sc) => sc.key !== section ? sc : {
    ...sc, fields: sc.fields.map((f) => fields.includes(f.key) ? { ...f, visible: false } : f),
  });
  return config;
}

describe("the invoice's field families (design 2026-11-10 §4.2)", () => {
  const d = sampleInvoice();

  /**
   * Each field key, the lines its item prints alone, and the flow print they are held to. The flow
   * prints the identity lines beside the Remit To box and the footer's three cells on one row, so a
   * key whose flow line could share a baseline with a sibling's is held to the flow with that sibling
   * hidden, where it prints alone on its baseline. So each line is one of the oracle's lines WHOLE: a
   * short or partial text cannot pass by containment.
   */
  const KEYS: { key: string; oracle: () => TemplateConfig; lines: string[]; w?: number }[] = [
    { key: "title", oracle: cfg, lines: ["Invoice"] },
    { key: "company_name", oracle: cfg, lines: [d.company.name] },
    { key: "invoice_no", oracle: () => hiding("identity", "remit_to"), lines: [`Invoice No.: ${d.documentNumber}`] },
    { key: "invoice_date", oracle: () => hiding("identity", "remit_to"), lines: ["Invoice Date: July 29, 2026"] },
    { key: "terms", oracle: () => hiding("identity", "remit_to"), lines: [`Terms: ${d.termsName}`] },
    {
      key: "remit_to", oracle: () => hiding("identity", "invoice_no", "invoice_date", "terms"), w: 250,
      lines: ["Remit To", d.remitTo.name, ...d.remitTo.lines],
    },
    { key: "footer_address", oracle: () => hiding("footer", "footer_contact", "footer_phone"), lines: ["100 Example Way", "Anniston AL 36207"] },
    { key: "footer_contact", oracle: () => hiding("footer", "footer_address", "footer_phone"), lines: ["Contact: Accounts Receivable"] },
    { key: "footer_phone", oracle: () => hiding("footer", "footer_address", "footer_contact"), lines: [`Phone: ${d.company.phone}`] },
  ];

  it("the nine keys are the contract's field keys less the profile's notFields and the grid's columns (pin)", () => {
    const columns = INVOICE_CONTRACT.sections.find((s) => s.key === "column_header")!.fields.map((f) => f.key);
    const placeable = INVOICE_CONTRACT.sections.flatMap((s) => s.fields.map((f) => f.key))
      .filter((key) => !INVOICE_CANVAS.notFields.includes(key) && !columns.includes(key));
    expect(KEYS.map((k) => k.key).sort()).toEqual([...placeable].sort());
  });

  it.each(KEYS)("$key prints the flow's text for its key, line by line, whole", async ({ key, oracle, lines, w }) => {
    const flow = await linesOf(renderPdf(buildInvoiceDefinition(d, oracle())));
    const printed = await linesOf(renderItems([invoiceField(key, { box: { x: 24, y: 100, w: w ?? 400, h: 12 } })]));
    expect(printed).toEqual(lines);
    for (const line of lines) expect(flow, line).toContain(line);
  });

  it("the title prints the document's kind, \"Credit\" on a credit, and nothing of a typed label", async () => {
    const item = invoiceField("title", { label: "Typed title", box: { x: 24, y: 100, w: 400, h: 24 } });
    const credit = sampleInvoice({ title: "Credit", documentNumber: "C-1001" });
    expect(await linesOf(renderItems([item], cfg(), credit))).toEqual(["Credit"]);
    expect(await linesOf(renderItems([item]))).toEqual(["Invoice"]);
    // Its contract label is "", so only a typed label could print a word that is not the kind.
    expect(defaultLabelOf(INVOICE_CONTRACT, "title")).toBe("");
  });

  it.each(["YYYY-MM-DD", "MMM - DD - YYYY"] as const)("every invoice date placed prints the date knob's date under %s", async (dateFormat) => {
    // The plan's YYYY-MM-DD prints the stored ISO date itself; "MMM - DD - YYYY" is neither the raw
    // date nor the default long style, so a slot reading the date raw cannot print it either.
    const config = cfg({ formats: { ...INVOICE_DEFAULT_CONFIG.formats, dateFormat } });
    const date = INVOICE_FLOW.makeLongDate(config.formats)(d.invoiceDate);
    expect(date).toBe(dateFormat === "YYYY-MM-DD" ? "2026-07-29" : "Jul - 29 - 2026");
    const items = [
      invoiceField("invoice_date", { id: "date-1", box: { x: 24, y: 100, w: 300, h: 12 } }),
      invoiceField("invoice_date", { id: "date-2", box: { x: 24, y: 300, w: 300, h: 12 } }),
    ];
    expect(await linesOf(renderItems(items, config))).toEqual([`Invoice Date: ${date}`, `Invoice Date: ${date}`]);
  });

  it("an identity line's label is bold and its value takes the item's weight, at the item's size", async () => {
    for (const bold of [false, true]) {
      const runs = runFonts(await renderItems([invoiceField("invoice_no", {
        box: { x: 24, y: 100, w: 300, h: 12 }, style: { size: 10, bold, align: "left" },
      })]));
      expect(runs.map((r) => r.text).join(" ").replace(/\s+/g, " ")).toBe(`Invoice No.: ${d.documentNumber}`);
      // A run is the label's while the runs so far, joined, are still a prefix of "Invoice No.:" (by
      // position, never by substring: a value run's text could sit inside the label's).
      const LABEL = "Invoice No.:";
      let sofar = "";
      let valueRuns = 0;
      for (const r of runs) {
        expect(r.size).toBe(10);
        sofar = `${sofar} ${r.text}`.replace(/\s+/g, " ").trim();
        const inLabel = LABEL.startsWith(sofar);
        if (!inLabel) valueRuns++;
        expect(isBold(r.font), `${r.text} bold`).toBe(inLabel ? true : bold);
      }
      expect(valueRuns).toBeGreaterThan(0);
    }
  });

  it("the Remit To box at 300 wide prints its border 300 wide, its label at the item's 13 bold, its lines at 10", async () => {
    const item = invoiceField("remit_to", { box: { x: 100, y: 100, w: 300, h: 40 }, style: { size: 13, bold: true, align: "left" } });
    const pdf = await renderItems([item]);
    const across = strokedLines(pdf)[0].filter((s) => s.y1 === s.y2);
    expect(across).toHaveLength(2);
    for (const s of across) {
      expect(Math.abs(Math.min(s.x1, s.x2) - 100)).toBeLessThan(1);
      expect(Math.abs(Math.abs(s.x2 - s.x1) - 300)).toBeLessThan(1);
    }
    expect(strokedLines(pdf)[0].filter((s) => s.x1 === s.x2)).toHaveLength(2);
    const runs = runFonts(pdf);
    const linesAt = (size: number, bold: boolean) => runs.filter((r) => r.size === size && isBold(r.font) === bold).map((r) => r.text);
    expect(linesAt(13, true).join(" ")).toBe("Remit To");
    expect(linesAt(10, true).join(" ")).toBe(d.remitTo.name);
    expect(linesAt(10, false).join(" ")).toBe(d.remitTo.lines.join(" "));
    expect(runs).toHaveLength(linesAt(13, true).length + linesAt(10, true).length + linesAt(10, false).length);
    // Another style reaches the label alone: at 11 regular the label is 11 regular, the lines the flow's.
    const restyled = runFonts(await renderItems([{ ...item, style: { size: 11, bold: false, align: "left" } }]));
    expect(restyled.filter((r) => r.size === 11 && !isBold(r.font)).map((r) => r.text).join(" ")).toBe("Remit To");
    expect(restyled.filter((r) => r.size === 10).map((r) => r.text).join(" ")).toBe([d.remitTo.name, ...d.remitTo.lines].join(" "));
  });

  it("the Remit To item, handed a flow whose boxedFields is empty, prints no border and no Remit To text", async () => {
    // The boxed branch reads `flow.boxedFields`, never the key: a branch keyed on "remit_to" itself
    // still borders the item here.
    const item = invoiceField("remit_to", { box: { x: 100, y: 100, w: 300, h: 40 }, style: { size: 13, bold: true, align: "left" } });
    const pdf = await renderItems([item], cfg(), d, { ...INVOICE_FLOW, boxedFields: [] });
    expect(strokedLines(pdf)[0]).toEqual([]);
    expect(await linesOf(Promise.resolve(pdf))).toEqual([]);
    // And the flow's own list borders it, so the empty list is what removed it.
    expect(strokedLines(await renderItems([item]))[0].length).toBeGreaterThan(0);
  });

  it("the phone, right-aligned in a box at the flow's place, starts its run where the flow's starts", async () => {
    // The flow's phone column: 140 pt wide at the right of the 564 pt strip, 24 pt in (x 448), at the
    // small size, right-aligned.
    const W = INVOICE_WIDTHS;
    const x = 24 + W.content - W.footerPhone;
    expect(x).toBe(448);
    const small = INVOICE_DEFAULT_CONFIG.fonts.smallSize;
    const item = invoiceField("footer_phone", { box: { x, y: 700, w: W.footerPhone, h: 9 }, style: { size: small, bold: false, align: "right" } });
    const start = (runs: { text: string; x: number }[]) => runs.find((r) => r.text.trim() === "Phone:")!.x;
    const flow = start(textRunsWithY(await renderPdf(buildInvoiceDefinition(d)))[0]);
    const canvas = start(textRunsWithY(await renderItems([item]))[0]);
    expect(Math.abs(canvas - flow)).toBeLessThan(0.5);
  });

  it("a block's field, a grid column, a text block and a barcode print nothing", async () => {
    const content = invoiceItemContent(ctxFor(cfg()), d, INVOICE_FLOW);
    const columns = INVOICE_CONTRACT.sections.find((s) => s.key === "column_header")!.fields.map((f) => f.key);
    expect(INVOICE_CANVAS.notFields).toContain("price_heading");
    const nothing: CanvasItem[] = [
      { id: "wording", kind: "textBlock", key: "wording", box: { x: 24, y: 100, w: 400, h: 40 },
        anchor: { kind: "page-top" }, repeat: false, style: { size: 9.5, bold: false, align: "left" } },
      ...[...INVOICE_CANVAS.notFields, ...columns].map((key) => invoiceField(key, { id: `f-${key}`, box: { x: 24, y: 200, w: 400, h: 12 } })),
      barcode({ box: { x: 24, y: 300, w: 200, h: 40 } }),
    ];
    for (const item of nothing) expect(content(item), item.kind === "field" ? item.key : item.kind).toBeNull();
    expect(await linesOf(renderItems(nothing))).toEqual([]);
  });

  it("a text, a logo, a line and a box route to the shared helpers", () => {
    const uri = `data:image/jpeg;base64,${TINY_JPEG.toString("base64")}`;
    const content = invoiceItemContent(ctxFor(cfg()), d, INVOICE_FLOW, uri);
    const text: CanvasItem = {
      id: "t", kind: "text", text: "Thank you", box: { x: 24, y: 100, w: 200, h: 12 },
      anchor: { kind: "page-top" }, repeat: false, style: { size: 9, bold: false, align: "left" },
    };
    const pic = logo({ box: { x: 24, y: 120, w: 100, h: 40 } });
    const line: CanvasItem = { id: "l", kind: "line", box: { x: 24, y: 200, w: 300, h: 0 }, anchor: { kind: "page-top" }, repeat: false, weight: 1 };
    const box: CanvasItem = { id: "b", kind: "box", box: { x: 24, y: 220, w: 300, h: 40 }, anchor: { kind: "page-top" }, repeat: false, weight: 1 };
    expect(content(text)).toEqual(textContent(text as Parameters<typeof textContent>[0]));
    expect(content(pic)).toEqual(logoContent(pic, uri));
    expect(content(pic)).not.toBeNull();
    expect(invoiceItemContent(ctxFor(cfg()), d, INVOICE_FLOW)(pic)).toBeNull();
    expect(content(line)).toEqual(strokeContent(line as Parameters<typeof strokeContent>[0]));
    expect(content(box)).toEqual(strokeContent(box as Parameters<typeof strokeContent>[0]));
  });

  it("the glue and the footer cells' text are the flow's own, read from the flow handed in", async () => {
    // A stub flow whose glue and footer text differ from INVOICE_FLOW's: a retyped copy here would
    // print INVOICE_FLOW's paper, which looks the same on the real flow.
    const stub = {
      ...INVOICE_FLOW,
      identityGlue: { invoice_no: " ~ ", invoice_date: " ~ ", terms: " ~ " },
      footerText: (key: string, label: string) => `stub ${key} ${label}`.trim(),
    };
    const items = [
      invoiceField("invoice_no", { box: { x: 24, y: 100, w: 300, h: 12 } }),
      invoiceField("footer_phone", { box: { x: 24, y: 200, w: 300, h: 12 } }),
      invoiceField("footer_contact", { box: { x: 24, y: 300, w: 300, h: 12 } }),
    ];
    expect(await linesOf(renderItems(items, cfg(), d, stub))).toEqual([
      `Invoice No.: ~ ${d.documentNumber}`, "stub footer_phone Phone:", "stub footer_contact Contact: Accounts Receivable",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Task 5: the six blocks, the lens and the branch (design 2026-11-10 §4.4, §5.2). Every case drives
// `buildInvoiceDefinition` with a config carrying a layout, so before the branch each prints the
// flow. A config's layout passes `validateCanvasLayout` first (written while the registry refused an
// invoice layout, before PR 3). `textRunsWithY` gives a run's START and its baseline from the
// page's bottom edge; the readers below turn the baseline top-down. A block's own id reports where
// its first line starts, UNDER that line's own top margin, which a several-node block keeps, so a
// block's rendered top is read from the mark before it (the block above's `regionEnd`).
// ---------------------------------------------------------------------------------------------

const PAGE_HEIGHT = CANVAS_PAGE.height;
const BLOCKS: InvoiceTable[] = ["parties", "column_header", "order_strip", "parts", "price", "totals"];
/** The one-node blocks (design §5.2): each prints its node with its own vertical margins zeroed. */
const ONE_NODE: ReadonlySet<string> = new Set(["parties", "column_header"]);
type TableItem = Extract<CanvasItem, { kind: "table" }>;

/** The Standard's config carrying `layout`, the layout validated first under the config's page line. */
function invCfg(layout: CanvasLayout, over: Partial<TemplateConfig> = {}): TemplateConfig {
  const config: TemplateConfig = { ...structuredClone(INVOICE_DEFAULT_CONFIG), ...over, layout };
  validateCanvasLayout(layout, INVOICE_CONTRACT, { pageFooter: config.pageFooter });
  return config;
}

async function renderInvoice(d: InvoicePdfData, config: TemplateConfig) {
  const def = buildInvoiceDefinition(d, config);
  const { pdf, groups } = await renderSheetGroupsWithPositions([def]);
  return { pdf, def, group: groups[0] };
}

type Group = { positions: LaidOutNode[] };

/** The laid-out node under an id, which the case requires. */
function at(group: Group, id: string): LaidOutNode {
  const found = group.positions.find((node) => node.id === id);
  if (found === undefined) throw new Error(`no laid-out node "${id}"`);
  return found;
}

const tableOf = (layout: CanvasLayout, key: InvoiceTable): TableItem =>
  layout.items.find((item): item is TableItem => item.kind === "table" && item.key === key)!;
const blockBox = (layout: CanvasLayout, key: InvoiceTable) => tableOf(layout, key).box;

/** A layout's block, replaced. */
function withTable(layout: CanvasLayout, key: InvoiceTable, change: (item: TableItem) => TableItem): CanvasLayout {
  return layoutOf(layout.items.map((item) => (item.kind === "table" && item.key === key ? change(item) : item)));
}
/** A block moved or resized. */
const reboxed = (layout: CanvasLayout, key: InvoiceTable, box: Partial<CanvasItem["box"]>): CanvasLayout =>
  withTable(layout, key, (item) => ({ ...item, box: { ...item.box, ...box } }));
/** A block's column (a rows block's row) changed. */
const columnSet = (
  layout: CanvasLayout, key: InvoiceTable, column: string, change: Partial<TableItem["columns"][number]>,
): CanvasLayout => withTable(layout, key, (item) => ({
  ...item, columns: item.columns.map((c) => (c.key === column ? { ...c, ...change } : c)),
}));

/** The block before `key` in the layout's drawn order (null for the first). */
function above(layout: CanvasLayout, key: InvoiceTable): InvoiceTable | null {
  const tables = tablesByY(layout);
  const i = tables.findIndex((t) => t.key === key);
  return i <= 0 ? null : (tables[i - 1].key as InvoiceTable);
}

/** A block's rendered top (see the section's comment). */
function blockTop(group: Group, layout: CanvasLayout, key: InvoiceTable): { page: number; top: number } {
  const prev = above(layout, key);
  if (prev === null) return { page: 1, top: blockBox(layout, key).y };
  const end = at(group, CANVAS_IDS.regionEnd(prev));
  return { page: end.page, top: end.top };
}

/** The drawn distance between a block and the block above it. */
function drawnGap(layout: CanvasLayout, key: InvoiceTable): number {
  const a = blockBox(layout, above(layout, key)!);
  return blockBox(layout, key).y - a.y - a.h;
}

/** Page `page`'s text runs starting with `needle`, each with its x and its top-down baseline. */
const runsOf = (pdf: Buffer, needle: string, page = 1) =>
  textRunsWithY(pdf)[page - 1].filter((r) => r.text.trim().startsWith(needle)).map((r) => ({ x: r.x, top: PAGE_HEIGHT - r.y }));
/** The x of each run starting with `needle`, left to right then top to bottom, which the case requires. */
function xsOf(pdf: Buffer, needle: string, page = 1): number[] {
  const found = runsOf(pdf, needle, page);
  expect(found.length, `a run starting "${needle}"`).toBeGreaterThan(0);
  return found.map((r) => r.x).sort((a, b) => a - b);
}
/** The top-down baseline of page `page`'s first run starting with `needle`, which the case requires. */
function runTop(pdf: Buffer, needle: string, page = 1): number {
  const found = runsOf(pdf, needle, page);
  expect(found.length, `a run starting "${needle}"`).toBeGreaterThan(0);
  return found[0].top;
}

/** The printed lines of a page, each with its baseline top-down. */
const linesOn = (pdf: Buffer, page = 1) =>
  textLinesWithY(pdf)[page - 1].map((line) => ({ text: line.text, top: PAGE_HEIGHT - line.y }));

/** Every node of a definition, depth first. */
function nodesOf(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) { for (const n of node) nodesOf(n, out); return out; }
  out.push(node as Record<string, unknown>);
  for (const value of Object.values(node as Record<string, unknown>)) nodesOf(value, out);
  return out;
}

/** Where a node rendered alone at the page's top margin reports its first line, under that margin:
 *  a boxed table's first line sits inside its top rule and cell padding (pdfmake reports a node at
 *  its first line). */
async function insetOf(node: Content): Promise<number> {
  const { groups } = await renderSheetGroupsWithPositions([{
    pageSize: "LETTER", pageMargins: [24, 24, 24, 24],
    defaultStyle: { font: INVOICE_DEFAULT_CONFIG.fonts.family, fontSize: INVOICE_DEFAULT_CONFIG.fonts.baseSize },
    content: [{ id: "inset", stack: [node] } as Content],
  }]);
  return at(groups[0], "inset").top - 24;
}

/** How far under its rendered top a block's own id reports it: for a one-node block its node's own
 *  first-line inset with its vertical margins zeroed (0 for the addresses; the column headers' top
 *  rule and padding, measured on the flow's node alone, `insetOf`), and for a several-node block its
 *  first child's own top margin, kept inside the wrapper (read from the definition, never retyped). */
async function ownOffset(def: RenderableDefinition, key: string): Promise<number> {
  const first = blockItems(def, key)[0] as { margin?: number | number[] };
  if (ONE_NODE.has(key)) return insetOf({ ...(first as object), margin: 0 } as Content);
  const margin = first.margin;
  return margin === undefined ? 0 : typeof margin === "number" ? margin : margin[1];
}

/** The boxed strip's rule width (`LAYOUT.boxed`'s own): a rule's stroke is centred on its line. */
const BOXED_RULE = TABLE_LAYOUTS[LAYOUT.boxed].hLineWidth();

/** The boxed column strip's strokes (0.8 pt, `LAYOUT.boxed`, drawn cell by cell) on page `page`: its
 *  top (the topmost horizontal starting at `left`, so never the Remit To box's) and its verticals' x. */
function stripRules(pdf: Buffer, left = 24, page = 1) {
  const boxed = strokedLines(pdf)[page - 1].filter((s) => Math.abs(s.width - BOXED_RULE) < 0.01);
  const tops = boxed.filter((s) => Math.abs(s.y1 - s.y2) < 0.01 && Math.abs(Math.min(s.x1, s.x2) - left) < 0.5).map((s) => s.y1);
  expect(tops.length, "the strip's horizontals").toBeGreaterThan(0);
  const top = Math.min(...tops);
  const verticals = boxed.filter((s) => Math.abs(s.x1 - s.x2) < 0.01 && Math.abs(Math.min(s.y1, s.y2) - top) < 0.5)
    .map((s) => s.x1);
  return { top, verticals: [...new Set(verticals.map((x) => Math.round(x * 100) / 100))].sort((a, b) => a - b) };
}

/** Where a text starts on a node rendered ALONE at the page's top margin (24), measured from that
 *  margin: a flow node's own place for its text, its own margins included. */
async function aloneOffset(node: Content, needle: string): Promise<number> {
  const pdf = await renderPdf({
    pageSize: "LETTER", pageMargins: [24, 24, 24, 24],
    defaultStyle: { font: INVOICE_DEFAULT_CONFIG.fonts.family, fontSize: INVOICE_DEFAULT_CONFIG.fonts.baseSize },
    content: [node],
  });
  return runTop(pdf, needle) - 24;
}

/** The flow's ctx over the Standard's config. */
const standardCtx = () => INVOICE_FLOW.ctxOf(INVOICE_DEFAULT_CONFIG, completeSections(INVOICE_CONTRACT, INVOICE_DEFAULT_CONFIG.sections), null);

/** An R14 bill-to (#671): the bill-to row's name stacked above the customer's. */
const r14 = (d: InvoicePdfData = sampleInvoice()): InvoicePdfData => ({ ...d, billTo: ["Accounts Payable", ...d.billTo] });
/** The R14 line's one word printed nowhere else on the sample. */
const R14_WORD = "Payable";

/** A long invoice: 30 parts, each with one priced operation, and every totals line. */
function longInvoice(): InvoicePdfData {
  const parts = Array.from({ length: 30 }, (_, i) => ({
    qty: 10 + i, partNumber: `DEMO-${9100 + i}`, partName: `PART ${i + 1}`, partDescription: "", eachWeight: 2, totalWeight: 2 * (10 + i),
  }));
  return r14(sampleInvoice({
    parts,
    priceRows: parts.map((p, i) => ({
      description: `Operation ${i + 1}`, pricePerLabel: "Each", unitPrice: 1, minimumCharge: null, setupCharge: null, amount: p.qty!, partIndex: i,
    })),
    surchargeRows: [{ description: "EnergySur", amount: 10 }, { description: "FuelSur", amount: 5 }],
    chargeRows: [{ description: "Expedite", amount: 25 }, { description: "Handling", amount: 15 }],
    certRow: { description: "Certification", amount: 20 },
    freightRow: { description: "Freight", amount: 40 },
    taxRow: { description: "Sales tax", amount: 12 },
  }));
}

/** A credit of the sample: its kind, its bare number, every amount negative. */
function sampleCredit(): InvoicePdfData {
  return sampleInvoice({
    title: "Credit", documentNumber: "1001",
    priceRows: [{ description: "Austemper", pricePerLabel: "Each", unitPrice: 6.51, minimumCharge: 600, setupCharge: null, amount: -937.44, partIndex: 0 }],
    subtotal: -937.44, surchargeRows: [{ description: "EnergySur", amount: -37.5 }], total: -974.94,
  });
}

/** Page 1's printed lines holding an amount, sorted. */
const moneyLines = (pdf: Buffer) => linesOn(pdf).map((l) => l.text).filter((t) => t.includes("$")).sort();

describe("a canvas invoice (design 2026-11-10 §4.4, §5.2)", () => {
  const W = INVOICE_WIDTHS;
  const layout = standardInvoiceLayout();

  it("prints each page-top item at its drawn top and the blocks in y order, each riding the block above it; pure JSON, no overflow margin, no id on a text node", async () => {
    const def = buildInvoiceDefinition(sampleInvoice(), invCfg(layout));
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
    expect(def.continuationHeaderSpec).not.toHaveProperty("overflowTopMargin");
    // The ids are where the measure reads them, never on a text node.
    const nodes = nodesOf(def);
    expect(nodes.filter((n) => "text" in n && "id" in n)).toEqual([]);
    for (const key of BLOCKS) expect(nodes.filter((n) => n.id === CANVAS_IDS.table(key)), key).toHaveLength(1);

    const { pdf, group } = await renderInvoice(sampleInvoice(), invCfg(layout));
    expect(pageCount(pdf)).toBe(1);
    expect(Math.abs(at(group, CANVAS_IDS.table("parties")).top - blockBox(layout, "parties").y)).toBeLessThan(2);
    let previous = -Infinity;
    for (const key of BLOCKS) {
      const own = at(group, CANVAS_IDS.table(key));
      expect(own.page, key).toBe(1);
      expect(own.top, key).toBeGreaterThan(previous);
      previous = own.top;
      const prev = above(layout, key);
      if (prev === null) continue;
      const top = blockTop(group, layout, key);
      expect(top.top - at(group, CANVAS_IDS.end(prev)).top, key).toBeCloseTo(drawnGap(layout, key), 2);
      expect(Math.abs(own.top - top.top - await ownOffset(def, key)), key).toBeLessThan(0.01);
    }
    expect(await ownOffset(def, "parties")).toBe(0);
    expect(await ownOffset(def, "parts")).toBeGreaterThan(0);
    expect(await ownOffset(def, "price")).toBeGreaterThan(0);
    for (const item of layout.items) {
      if (item.kind !== "field" || item.anchor.kind !== "page-top") continue;
      const laid = at(group, CANVAS_IDS.item(item.id));
      expect(laid.page, item.id).toBe(1);
      // A boxed field reports its first line, inside its box's rule and padding: its box's top rule
      // starts at the item's x and is drawn at its top, the stroke centred half its width under it.
      if ((INVOICE_BOXED_FIELDS as readonly string[]).includes(item.key)) {
        expect(stripRules(pdf, item.box.x).top - item.box.y, item.id).toBeCloseTo(BOXED_RULE / 2, 2);
      } else {
        expect(laid.left, item.id).toBeCloseTo(item.box.x, 2);
        expect(Math.abs(laid.top - item.box.y), item.id).toBeLessThan(2);
      }
    }
  });

  it("a several-node block keeps every margin inside its wrapper: the PARTS heading and the PRICE heading sit under the line above them as on the flow", async () => {
    const flow = await renderPdf(buildInvoiceDefinition(sampleInvoice()));
    const { pdf } = await renderInvoice(sampleInvoice(), invCfg(layout));
    // The PARTS heading's own 4 pt top margin under the strip's line, inside the order strip block.
    expect(runTop(pdf, "PARTS") - runTop(pdf, "Our")).toBeCloseTo(runTop(flow, "PARTS") - runTop(flow, "Our"), 1);
    // The PRICE heading keeps its own margins, its 8 pt top included, as the flow's node carries them.
    const flowHeading = INVOICE_FLOW.priceBlock(standardCtx(), sampleInvoice())[0] as { margin: number[] };
    expect(flowHeading.margin[1]).toBeGreaterThan(0);
    const heading = blockItems(buildInvoiceDefinition(sampleInvoice(), invCfg(layout)), "price") as { margin?: number[] }[];
    expect(heading[0].margin).toEqual(flowHeading.margin);
  });

  it("a page-bottom Text item whose words run past the band's foot is cut at the band's bottom edge, whole lines, with the page line off and on (#978)", async () => {
    // Red when the band's footer frame is not ended at the band's bottom edge (render.ts's
    // `installBandFrame` wrapper): the item's overflow then prints below the edge, in the page's
    // bottom margin, and with the page line on over and under it.
    for (const pageFooter of [false, true]) {
      const banded = bandClipLayout(standardInvoiceLayout(), pageFooter);
      expect(canvasRefusal(banded, INVOICE_CONTRACT, { pageFooter }), `page line ${pageFooter}`).toBeNull();
      const { pdf } = await renderInvoice(sampleInvoice(), invCfg(banded, { pageFooter }));
      expect(pageCount(pdf), `page line ${pageFooter}`).toBe(1);
      expectBandClip(pdf, pageFooter);
    }
  });

  describe("the addresses", () => {
    const d = sampleInvoice();

    it("drawn at x 24, 564 print both columns as the flow prints them, the labels at the block's drawn top", async () => {
      const flow = await renderPdf(buildInvoiceDefinition(d));
      const { pdf } = await renderInvoice(d, invCfg(layout));
      for (const needle of ["Billto:", "Shipto:", "Demo", "PO", "500", "Columbus"]) {
        const canvas = xsOf(pdf, needle);
        const printed = xsOf(flow, needle);
        expect(canvas.length, needle).toBe(printed.length);
        canvas.forEach((x, i) => expect(Math.abs(x - printed[i]), needle).toBeLessThan(0.5));
      }
      // The absolute check: the block is the first, so its top is its drawn top, and the labels print
      // where the flow's node puts them under its own top, less that node's own top margin (zeroed:
      // a one-node block).
      const node = INVOICE_FLOW.partiesBlock(standardCtx(), d)[0] as { margin: number[] };
      expect(node.margin[1]).toBeGreaterThan(0);
      const offset = await aloneOffset(node as Content, "Billto:");
      expect(runTop(pdf, "Billto:") - blockBox(layout, "parties").y).toBeCloseTo(offset - node.margin[1], 1);
    });

    it("an R14 bill-to prints one line more, and every block below moves down by that line", async () => {
      const short = await renderInvoice(d, invCfg(layout));
      const tall = await renderInvoice(r14(d), invCfg(layout));
      const line = runTop(short.pdf, "500") - runTop(short.pdf, "PO");
      expect(line).toBeGreaterThan(8);
      expect(runsOf(tall.pdf, R14_WORD)).toHaveLength(1);
      expect(runsOf(short.pdf, R14_WORD)).toEqual([]);
      expect(Math.abs(stripRules(tall.pdf).top - stripRules(short.pdf).top - line)).toBeLessThan(0.5);
      expect(Math.abs(runTop(tall.pdf, "Quantity") - runTop(short.pdf, "Quantity") - line)).toBeLessThan(0.5);
      for (const key of BLOCKS.slice(1)) {
        const moved = at(tall.group, CANVAS_IDS.table(key)).top - at(short.group, CANVAS_IDS.table(key)).top;
        expect(Math.abs(moved - line), key).toBeLessThan(0.5);
      }
    });

    it("the rows' stored order swaps the two columns, and one row hidden leaves the other 40 pt in", async () => {
      const flow = await renderPdf(buildInvoiceDefinition(d));
      const swapped = withTable(layout, "parties", (item) => ({ ...item, columns: [...item.columns].reverse() }));
      const { pdf } = await renderInvoice(d, invCfg(swapped));
      expect(xsOf(pdf, "Shipto:")[0]).toBeCloseTo(xsOf(flow, "Billto:")[0], 1);
      expect(xsOf(pdf, "Billto:")[0]).toBeCloseTo(xsOf(flow, "Shipto:")[0], 1);
      const box = blockBox(layout, "parties");
      for (const [hidden, shown] of [["ship_to", "Billto:"], ["bill_to", "Shipto:"]] as const) {
        const one = (await renderInvoice(d, invCfg(columnSet(layout, "parties", hidden, { visible: false })))).pdf;
        expect(runsOf(one, hidden === "ship_to" ? "Shipto:" : "Billto:"), hidden).toEqual([]);
        expect(xsOf(one, shown)[0], hidden).toBeCloseTo(box.x + W.partiesIndent, 1);
      }
    });
  });

  describe("the column headers", () => {
    it("drawn at x 24, 564 print the boxed strip with the flow's verticals and W14's heading", async () => {
      const flow = await renderPdf(buildInvoiceDefinition(sampleInvoice()));
      const { pdf, group } = await renderInvoice(sampleInvoice(), invCfg(layout));
      // The strip's top rule at the block's rendered top (its node's own margins zeroed, one-node),
      // its stroke centred half its width under it.
      expect(stripRules(pdf).top - blockTop(group, layout, "column_header").top).toBeCloseTo(BOXED_RULE / 2, 2);
      const canvas = stripRules(pdf).verticals;
      const printed = stripRules(flow).verticals;
      expect(canvas.length).toBe(5);
      expect(canvas.length).toBe(printed.length);
      canvas.forEach((x, i) => expect(Math.abs(x - printed[i])).toBeLessThan(0.5));
      expect(defaultLabelOf(INVOICE_CONTRACT, "col_amount")).toBe("Net weight / Price");
      expect(linesOn(pdf).some((l) => l.text.includes("Net weight / Price"))).toBe(true);
    });

    it("a column given a width moves the strip's verticals", async () => {
      const standard = stripRules((await renderInvoice(sampleInvoice(), invCfg(layout))).pdf).verticals;
      const wide = stripRules((await renderInvoice(sampleInvoice(), invCfg(columnSet(layout, "column_header", "col_qty", { width: 80 })))).pdf).verticals;
      expect(wide.length).toBe(standard.length);
      // The left and right edges stay; the Quantity column's right edge moves by the 28 pt it gained.
      expect(wide[0]).toBeCloseTo(standard[0], 1);
      expect(wide.at(-1)!).toBeCloseTo(standard.at(-1)!, 1);
      expect(wide[1] - standard[1]).toBeCloseTo(80 - W.qty, 1);
    });
  });

  describe("the grid", () => {
    const d = sampleInvoice();
    /** The parts' and prices' texts, one per grid column, and the totals' label and amount. */
    const NEEDLES = ["144", "DEMO-9001-000", "21.00", "3,024.00", "Austemper", "$937.44", "Sub", "$974.94"];

    it("the parts and price blocks drawn at the column headers' x and width print every column at the strip's x", async () => {
      const flow = await renderPdf(buildInvoiceDefinition(d));
      const { pdf, group } = await renderInvoice(d, invCfg(layout));
      // Each text inside its own block: the part's number under the parts block's rendered top, the
      // operation's amount under the price block's, the total under the totals'.
      for (const [needle, key] of [["DEMO-9001-000", "parts"], ["Austemper", "price"], ["$974.94", "totals"]] as const) {
        const top = at(group, CANVAS_IDS.table(key)).top;
        expect(runsOf(pdf, needle).some((r) => r.top > top && r.top < at(group, CANVAS_IDS.end(key)).top), needle).toBe(true);
      }
      for (const needle of NEEDLES) {
        const canvas = xsOf(pdf, needle);
        const printed = xsOf(flow, needle);
        expect(canvas.length, needle).toBe(printed.length);
        canvas.forEach((x, i) => expect(Math.abs(x - printed[i]), needle).toBeLessThan(0.5));
      }
    });

    it("the amount column widened to 120 in the column headers block moves every block's columns under it", async () => {
      const standard = (await renderInvoice(d, invCfg(layout))).pdf;
      const wide = (await renderInvoice(d, invCfg(columnSet(layout, "column_header", "col_amount", { width: 120 })))).pdf;
      const gained = 120 - W.amt;
      // The strip's last inner vertical, the parts' each weight and the totals' label move left by the
      // 36 pt the amount column gained; the amounts, right-aligned at the blocks' right edge, stay.
      expect(stripRules(wide).verticals.at(-2)! - stripRules(standard).verticals.at(-2)!).toBeCloseTo(-gained, 1);
      expect(xsOf(wide, "21.00")[0] - xsOf(standard, "21.00")[0]).toBeCloseTo(-gained, 1);
      expect(xsOf(wide, "Sub")[0] - xsOf(standard, "Sub")[0]).toBeCloseTo(-gained, 1);
      for (const needle of ["3,024.00", "$937.44", "$974.94"]) {
        expect(xsOf(wide, needle)[0], needle).toBeCloseTo(xsOf(standard, needle)[0], 1);
        expect(xsOf(wide, needle)[0], needle).toBeGreaterThan(CANVAS_PAGE.width - CANVAS_PAGE.margin - 120);
      }
    });

    it("a parts block drawn at x 100, 400 wide prints its own columns from 100, \"*\" resolving against 400", async () => {
      const standard = (await renderInvoice(d, invCfg(layout))).pdf;
      const moved = (await renderInvoice(d, invCfg(reboxed(layout, "parts", { x: 100, w: 400 })))).pdf;
      // The Quantity and Information columns start 76 pt right of the Standard's (100 − 24); the
      // weights end 88 pt left of it (588 − 500), the "*" column 164 pt narrower (564 − 400).
      const right = CANVAS_PAGE.width - CANVAS_PAGE.margin;
      const startsRight = 100 - CANVAS_PAGE.margin;
      const endsLeft = 100 + 400 - right;
      expect(xsOf(moved, "144")[0] - xsOf(standard, "144")[0]).toBeCloseTo(startsRight, 1);
      expect(xsOf(moved, "DEMO-9001-000")[0] - xsOf(standard, "DEMO-9001-000")[0]).toBeCloseTo(startsRight, 1);
      expect(xsOf(moved, "21.00")[0] - xsOf(standard, "21.00")[0]).toBeCloseTo(endsLeft, 1);
      expect(xsOf(moved, "3,024.00")[0] - xsOf(standard, "3,024.00")[0]).toBeCloseTo(endsLeft, 1);
      // The price block, at the Standard's place, does not move.
      expect(xsOf(moved, "$937.44")[0]).toBeCloseTo(xsOf(standard, "$937.44")[0], 1);
    });

    it("a layout with no column headers block prints the body under the contract's grid, at the Standard's x", async () => {
      const without = layoutOf(layout.items
        .filter((item) => !(item.kind === "table" && item.key === "column_header"))
        .map((item) => (item.kind === "table" && item.key === "order_strip"
          ? { ...item, anchor: { kind: "below-table" as const, table: "parties" } } : item)));
      const standard = (await renderInvoice(d, invCfg(layout))).pdf;
      const { pdf } = await renderInvoice(d, invCfg(without));
      expect(runsOf(pdf, "Quantity")).toEqual([]);
      for (const needle of NEEDLES) expect(xsOf(pdf, needle)[0], needle).toBeCloseTo(xsOf(standard, needle)[0], 1);
    });

    it("the totals' amounts end at the block's right edge, the amount column 84 wide with col_amount hidden", async () => {
      const standard = (await renderInvoice(d, invCfg(layout))).pdf;
      const hidden = (await renderInvoice(d, invCfg(columnSet(layout, "column_header", "col_amount", { visible: false })))).pdf;
      // The column is hidden in the strip the grid prints: no heading, one vertical fewer (red with the
      // lens reading every grid column as shown). The each weight still prints, its column kept.
      expect(linesOn(hidden).some((l) => l.text.includes("Net weight / Price"))).toBe(false);
      expect(linesOn(standard).some((l) => l.text.includes("Net weight / Price"))).toBe(true);
      expect(stripRules(hidden).verticals).toHaveLength(stripRules(standard).verticals.length - 1);
      // A hidden amount column reserves no width in the grid (slotW 0), and the totals fall back to
      // the flow's 84, so the label and the amount print where the Standard's do.
      expect(xsOf(hidden, "Sub")[0]).toBeCloseTo(xsOf(standard, "Sub")[0], 1);
      expect(xsOf(hidden, "$974.94")[0]).toBeCloseTo(xsOf(standard, "$974.94")[0], 1);
      // A totals block drawn narrower prints its amounts from its own right edge.
      const narrow = (await renderInvoice(d, invCfg(reboxed(layout, "totals", { x: 200, w: 340 })))).pdf;
      expect(xsOf(narrow, "$974.94")[0] - xsOf(standard, "$974.94")[0]).toBeCloseTo(-48, 1);
    });
  });

  it("W15 and R9 (pin): each weight prints \"lb\", a blank weight none; no totals line prints a rate or \"%\"", async () => {
    const d = sampleInvoice({ parts: [{ ...sampleInvoice().parts[0], eachWeight: null }] });
    const { pdf } = await renderInvoice(d, invCfg(layout));
    const lines = linesOn(pdf).map((l) => l.text);
    expect(lines.some((t) => t.includes("3,024.00 lb"))).toBe(true);
    expect(textRunsWithY(pdf)[0].filter((r) => r.text.trim() === "lb")).toHaveLength(1);
    const full = (await renderInvoice(sampleInvoice(), invCfg(layout))).pdf;
    expect(linesOn(full).some((l) => l.text.includes("21.00 lb"))).toBe(true);
    expect(linesOn(full).filter((l) => l.text.includes("%"))).toEqual([]);
    // The surcharge line: its frozen description and amount alone (the two cells join with no space).
    expect(linesOn(full).map((l) => l.text)).toContain("EnergySur$37.50");
  });

  it("§4.2's two paper claims (pin): a price block drawn at x 120, 300 wide centres its detail lines on its drawn width; a typed label on a value-only row never prints", async () => {
    const d = sampleInvoice({
      priceRows: [{
        description: "Austemper", pricePerLabel: "Each", unitPrice: 6.51, minimumCharge: 600, setupCharge: 45,
        sourceQuoteNumber: 1006, amount: 937.44, partIndex: 0,
      }],
    });
    const flow = await renderPdf(buildInvoiceDefinition(d));
    const { pdf } = await renderInvoice(d, invCfg(reboxed(layout, "price", { x: 120, w: 300 })));
    const flowCentre = 24 + W.content / 2;
    /** Where the printed line holding the first run starting with `needle` starts. */
    const lineStart = (paper: Buffer, needle: string) => {
      const top = runTop(paper, needle);
      return Math.min(...textRunsWithY(paper)[0].filter((r) => Math.abs(PAGE_HEIGHT - r.y - top) < 0.3).map((r) => r.x));
    };
    // The quote source, Price per, Minimum Charge and Setup Charge lines.
    for (const needle of ["Quote", "Each:", "Minimum", "Setup"]) {
      const width = 2 * (flowCentre - lineStart(flow, needle));
      expect(width, needle).toBeGreaterThan(20);
      expect(Math.abs(lineStart(pdf, needle) + width / 2 - 270), needle).toBeLessThan(1);
    }
    const labelled = columnSet(columnSet(columnSet(layout, "parts", "part_qty", { label: "QTYLABEL" }),
      "price", "price_amount", { label: "AMTLABEL" }), "totals", "surcharge_rows", { label: "SURLABEL" });
    const typed = (await renderInvoice(sampleInvoice(), invCfg(labelled))).pdf;
    for (const label of ["QTYLABEL", "AMTLABEL", "SURLABEL"]) expect(runsOf(typed, label), label).toEqual([]);
    expect(runsOf(typed, "144")).toHaveLength(1);
  });

  describe("growth (§11)", () => {
    it("one layout over a one-page invoice and a 30-part invoice: each block at the one above plus its drawn distance", async () => {
      for (const [d, long] of [[sampleInvoice(), false], [longInvoice(), true]] as const) {
        const { pdf, group } = await renderInvoice(d, invCfg(layout));
        // The long invoice reaches a second page, so its blocks are held across a page break too.
        if (long) expect(pageCount(pdf), "the 30-part invoice's pages").toBeGreaterThanOrEqual(2);
        for (const key of BLOCKS.slice(1)) {
          const prev = above(layout, key)!;
          const end = at(group, CANVAS_IDS.end(prev));
          const top = blockTop(group, layout, key);
          expect(top.page, key).toBe(end.page);
          expect(top.top - end.top, key).toBeCloseTo(drawnGap(layout, key), 2);
        }
      }
    });

    it("a 30-part invoice pages: the strip on every page, the invoice number and (continued) on every page after the first", async () => {
      const d = longInvoice();
      const { pdf } = await renderInvoice(d, invCfg(layout));
      const invoiceNoBox = layout.items.find((item) => item.id === "field-invoice_no")!.box;
      const pages = pageCount(pdf);
      expect(pages).toBeGreaterThanOrEqual(2);
      for (let page = 1; page <= pages; page++) {
        const lines = linesOn(pdf, page).map((l) => l.text);
        expect(lines.some((t) => t.includes(`Phone: ${d.company.phone}`)), `page ${page}`).toBe(true);
        expect(lines.some((t) => t.includes("100 Example Way")), `page ${page}`).toBe(true);
        expect(lines.some((t) => t.includes("Contact: Accounts Receivable")), `page ${page}`).toBe(true);
        if (page === 1) continue;
        expect(lines.some((t) => t.includes("Invoice No.:") && t.includes(d.documentNumber)), `page ${page}`).toBe(true);
        // At the item's drawn place, where the flow's band prints it at the left margin.
        expect(runsOf(pdf, "Invoice", page).map((r) => r.x), `page ${page}`).toEqual([invoiceNoBox.x]);
        expect(lines.some((t) => t.includes("(continued)")), `page ${page}`).toBe(true);
      }
    });

    it("with Page N of M on, page 2 prints its page line and no body line below the band", async () => {
      const foot = pageFoot(true);
      const lifted = layoutOf(layout.items.map((item) => item.kind !== "table" && item.anchor.kind === "page-bottom"
        ? { ...item, box: { ...item.box, y: foot - item.box.h } } : item));
      const { pdf } = await renderInvoice(longInvoice(), invCfg(lifted, { pageFooter: true }));
      const pages = pageCount(pdf);
      expect(pages).toBeGreaterThanOrEqual(2);
      const lines = linesOn(pdf, 2);
      const pageLine = lines.find((l) => l.text === `Page 2 of ${pages}`);
      expect(pageLine).toBeDefined();
      const band = bandTop(lifted, true);
      const strip = (t: string) => t.includes("Phone:") || t.includes("100 Example Way") || t.includes("Anniston") || t.includes("Contact:");
      const body = lines.filter((l) => l !== pageLine && !strip(l.text));
      expect(body.length).toBeGreaterThan(0);
      for (const l of body) expect(l.top, l.text).toBeLessThan(band);
      for (const l of lines.filter((l) => strip(l.text))) expect(l.top).toBeLessThan(pageLine!.top);
      // The canvas's page 2: the invoice number at its drawn x, where the flow prints it at the margin.
      expect(runsOf(pdf, "Invoice", 2).map((r) => r.x)).toEqual([layout.items.find((item) => item.id === "field-invoice_no")!.box.x]);
    });

    describe("a block drawn narrower than the content that breaks across pages (#969)", () => {
      // The probe's record (#969 plan, Task 4): 70 parts, each with one priced operation of
      // $9,999.99, so the part rows break onto page 2 and the price block runs from page 3 to 8.
      const bigData = (n: number): InvoicePdfData => {
        const parts = Array.from({ length: n }, (_, i) => ({
          qty: 100 + i, partNumber: `DEMO-${String(9000 + i)}-000`, partName: `PART NAME ${i}`, partDescription: "",
          eachWeight: 21, totalWeight: 21 * (100 + i),
        }));
        const priceRows = Array.from({ length: n }, (_, i) => ({
          description: `Austemper op ${i}`, pricePerLabel: "Each", unitPrice: 6.51, minimumCharge: 600, setupCharge: null,
          amount: 9999.99, partIndex: i,
        }));
        return sampleInvoice({ parts, priceRows, subtotal: 9999.99 * n, total: 9999.99 * n + 37.5 });
      };
      /** The standard layout, its page-bottom items lifted to the foot the page line leaves when it is on. */
      const standardFor = (pageFooter: boolean): CanvasLayout => !pageFooter ? layout : layoutOf(layout.items.map((item) =>
        item.kind !== "table" && item.anchor.kind === "page-bottom" ? { ...item, box: { ...item.box, y: pageFoot(true) - item.box.h } } : item));
      /** `base` with each block of `keys` drawn `inset` pt in on each side. */
      const narrowed = (base: CanvasLayout, keys: InvoiceTable[], inset: number): CanvasLayout => keys.reduce(
        (l, key) => reboxed(l, key, { x: 24 + inset, w: 564 - 2 * inset }), base);
      /** Every page's non-blank runs whose trimmed text starts with `needle`, as [page, x]. */
      const startsOf = (pdf: Buffer, needle: string) => textRunsWithY(pdf).flatMap((runs, p) =>
        runs.filter((r) => r.text.trim() !== "" && r.text.trim().startsWith(needle)).map((r) => [p + 1, r.x] as const));
      /** As many runs in both prints, each at one of the control's x plus `shift`, and, where
       *  `samePages`, on the control's pages. */
      const shifted = (control: Buffer, inset: Buffer, needle: string, shift: number, samePages: boolean) => {
        const full = startsOf(control, needle);
        expect(full.length, `${needle} in the control`).toBeGreaterThan(0);
        const xs = [...new Set(full.map(([, x]) => Math.round(x * 100) / 100))];
        const runs = startsOf(inset, needle);
        expect(runs.length, `${needle}'s runs`).toBe(full.length);
        if (samePages) expect(runs.map(([p]) => p), `${needle}'s pages`).toEqual(full.map(([p]) => p));
        for (const [p, x] of runs) {
          expect(Math.min(...xs.map((c) => Math.abs(x - (c + shift)))), `${needle} on page ${p} at ${x.toFixed(2)}`).toBeLessThan(0.5);
        }
      };

      it.each([
        { name: "the price block 40 pt in", keys: ["price"], inset: 40, pageFooter: false },
        { name: "the price block 40 pt in", keys: ["price"], inset: 40, pageFooter: true },
        { name: "the price block 20 pt in", keys: ["price"], inset: 20, pageFooter: false },
        { name: "the price block 20 pt in", keys: ["price"], inset: 20, pageFooter: true },
        { name: "the parts block alone 40 pt in", keys: ["parts"], inset: 40, pageFooter: false },
        { name: "the parts block alone 40 pt in", keys: ["parts"], inset: 40, pageFooter: true },
        { name: "all six blocks in line 40 pt in", keys: BLOCKS, inset: 40, pageFooter: false },
        { name: "all six blocks in line 40 pt in", keys: BLOCKS, inset: 40, pageFooter: true },
      ] as { name: string; keys: InvoiceTable[]; inset: number; pageFooter: boolean }[])(
        "$name prints every amount at its drawn place and leaves the later blocks theirs, page line $pageFooter",
        async ({ keys, inset, pageFooter }) => {
          const d = bigData(70);
          const control = standardFor(pageFooter);
          const drawn = narrowed(control, keys, inset);
          for (const l of [control, drawn]) expect(canvasRefusal(l, INVOICE_CONTRACT, { pageFooter })).toBeNull();
          const full = await renderInvoice(d, invCfg(control, { pageFooter }));
          const narrow = await renderInvoice(d, invCfg(drawn, { pageFooter }));
          // Premises: the same page count, and the narrowed block breaking across a page in both.
          expect(pageCount(narrow.pdf)).toBe(pageCount(full.pdf));
          const breaking = keys.includes("price") ? "price" : "parts";
          for (const r of [full, narrow]) {
            expect(at(r.group, CANVAS_IDS.end(breaking)).page, breaking).toBeGreaterThan(at(r.group, CANVAS_IDS.table(breaking)).page);
          }
          // Nothing prints past the right margin.
          const pastRuns = textRunsWithY(narrow.pdf).flatMap((runs, p) =>
            runs.filter((r) => r.text.trim() !== "" && r.x > RIGHT_MARGIN).map((r) => `${p + 1}:${r.text.trim()}@${r.x.toFixed(1)}`));
          expect(pastRuns).toEqual([]);
          const pastStrokes = strokedLines(narrow.pdf).flatMap((lines, p) =>
            lines.filter((s) => Math.max(s.x1, s.x2) > RIGHT_MARGIN + 0.5)
              .map((s) => `${p + 1}:${Math.min(s.x1, s.x2).toFixed(1)}..${Math.max(s.x1, s.x2).toFixed(1)}`));
          expect(pastStrokes).toEqual([]);
          // Every amount at its block's drawn place: the control's x less the inset where its block
          // is narrowed, the control's own x where it is not. With one block narrowed the rows land
          // on the control's pages; with all six, the column headers block drawn 484 wide ends lower
          // on page 1, above any break, so one part row prints a page later and only the places are
          // compared.
          const samePages = keys.length === 1;
          const shiftOf = (key: InvoiceTable) => (keys.includes(key) ? -inset : 0);
          shifted(full.pdf, narrow.pdf, "$9,999.99", shiftOf("price"), samePages);
          // The part rows' weights.
          shifted(full.pdf, narrow.pdf, "lb", shiftOf("parts"), samePages);
          // The totals, laid out after the price block's break.
          shifted(full.pdf, narrow.pdf, "$37.50", shiftOf("totals"), samePages);
          shifted(full.pdf, narrow.pdf, "Sub", shiftOf("totals"), samePages);
          // The band's contact cell at the control's x on every page.
          const contact = startsOf(full.pdf, "Contact:");
          expect(contact.map(([p]) => p)).toEqual(Array.from({ length: pageCount(full.pdf) }, (_, i) => i + 1));
          shifted(full.pdf, narrow.pdf, "Contact:", 0, true);
        },
      );
    });
  });

  it.each(["SIGN_AFTER_SYMBOL", "LEADING_MINUS", "PARENTHESES"] as const)("the credit (pin) under %s: \"Credit\", the bare number and every amount as the flow prints it", async (negativeStyle) => {
    const d = sampleCredit();
    const formats = { ...INVOICE_DEFAULT_CONFIG.formats, negativeStyle };
    const flow = await renderPdf(buildInvoiceDefinition(d, { ...structuredClone(INVOICE_DEFAULT_CONFIG), formats }));
    const { pdf } = await renderInvoice(d, invCfg(layout, { formats }));
    const money = moneyLines(pdf);
    expect(money.length).toBeGreaterThan(3);
    expect(money).toEqual(moneyLines(flow));
    expect(money.some((t) => t.includes(INVOICE_FLOW.makeMoney(formats)(-974.94)))).toBe(true);
    const lines = linesOn(pdf).map((l) => l.text);
    expect(lines).toContain("Credit");
    expect(lines.some((t) => t.includes("Invoice No.:") && t.includes("1001"))).toBe(true);
  });

  describe("frozen paper (pin, §11: the canvas adds no read)", () => {
    beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });
    const asSystem = <T>(fn: () => Promise<T>) => runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

    it("a part renamed, a bill-to address changed and a surcharge rate changed after create print the frozen snapshot under the canvas, as under the flow", async () => {
      const customer = await prisma.customer.create({ data: { code: "ICV1", name: "Invoice Canvas Customer" } });
      const address = await prisma.customerAddress.create({
        data: {
          customerId: customer.id, kind: "BILL_TO", name: "Demo Foundry - Columbus LLC", street: "500 Example Street",
          city: "Columbus", state: "GA", zip: "31902-0096", isDefault: true,
        },
      });
      const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P-CANVAS-1", name: "EQUALIZER-RR SUSP", eachWeight: "21.0000" } });
      const stepCode = await prisma.processStepCode.create({ data: { code: `HT-${part.id}`, name: "Austemper" } });
      const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
      await prisma.partProcessStep.create({ data: { revisionId: rev.id, position: 1, codeId: stepCode.id, instruction: "Austemper at 1650F." } });
      const { order } = await asSystem(() => createOrder({
        customerId: customer.id, poNumber: "89499", lines: [{ partId: part.id, qty: 10, weight: "210.00" }],
      }));
      await createShipper({
        customerId: customer.id, shipDate: "2026-07-29",
        orders: [{
          orderId: order.id,
          lines: order.lines.map((l) => ({ orderLineId: l.id, qty: l.qty, weight: l.weight, lineComplete: true })),
          containers: [], serials: [],
        }],
      }, { canOverrideCreditHold: false });
      const gl = await prisma.glAccount.create({ data: { name: "4010", description: "Sales" } });
      const code = await prisma.processStepCode.create({ data: { code: "AUST", name: "Austemper", glAccountId: gl.id } });
      await asSystem(() => addPartPrice(part.id, {
        processStepCodeId: code.id, position: 1, unitPrice: "1.0000", minimumCharge: null, pricePer: "EACH",
      }));
      await asSystem(() => createSurcharge({ name: "Energy", kind: "PERCENT", rate: "0.050000", position: 1, scope: "ALL" }));
      const { invoice } = await asSystem(() => createInvoice({ orderId: order.id }));
      const surcharge = invoice.lines.find((l) => l.kind === "SURCHARGE");
      expect(surcharge?.amount).toBe(0.5);

      await prisma.part.update({ where: { id: part.id }, data: { partNumber: "RENAMED-77", name: "Renamed Part" } });
      await prisma.customerAddress.update({ where: { id: address.id }, data: { street: "999 Moved Avenue" } });
      await prisma.surcharge.updateMany({ data: { rate: "0.200000", name: "Renamed Surcharge" } });

      const d = await readInvoicePdfData(prisma, invoice.id);
      const flow = await renderPdf(buildInvoiceDefinition(d));
      const { pdf } = await renderInvoice(d, invCfg(layout));
      for (const paper of [flow, pdf]) {
        const lines = linesOn(paper).map((l) => l.text);
        const text = lines.join("\n");
        expect(text).toContain("P-CANVAS-1");
        expect(text).toContain("EQUALIZER-RR SUSP");
        expect(text).toContain("500 Example Street");
        expect(lines).toContain("Energy$0.50");
        for (const live of ["RENAMED-77", "Renamed Part", "999 Moved Avenue", "Renamed Surcharge", "$2.00"]) expect(text, live).not.toContain(live);
      }
      expect(moneyLines(pdf)).toEqual(moneyLines(flow));
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The owner-ruled paper on a canvas (Task 6): #590's measured strip inside its block, #589's rules
// from margin to margin, and the end-of-block belt (design §5.2). Flow and canvas print the same
// data. A rule is read from `strokedLines` (top-down y), a run from `textRunsWithY` (a baseline
// from the page's bottom, so its top-down y is the page height less it).
// ---------------------------------------------------------------------------------------------

/** The price rule's own margins, read from a rule the flow makes: the space above it and below it. */
const RULE_MARGIN = (INVOICE_FLOW.priceRule() as { margin: number[] }).margin;
const RULE_ABOVE = RULE_MARGIN[1];
const RULE_BELOW = RULE_MARGIN[3];
const LEFT_MARGIN = CANVAS_PAGE.margin;
const RIGHT_MARGIN = CANVAS_PAGE.width - CANVAS_PAGE.margin;

/** Every price rule of a print, page by page (1-based), top to bottom. */
const rulesOf = (pdf: Buffer) =>
  strokedLines(pdf).flatMap((_, i) => ruledRules(pdf, i).map((s) => ({ ...s, page: i + 1 })));

/** Each rule runs from the left margin to the right one. */
function marginToMargin(rules: { x1: number; x2: number }[]): void {
  expect(rules.length).toBeGreaterThan(0);
  for (const rule of rules) {
    expect(Math.abs(Math.min(rule.x1, rule.x2) - LEFT_MARGIN)).toBeLessThan(0.01);
    expect(Math.abs(Math.max(rule.x1, rule.x2) - RIGHT_MARGIN)).toBeLessThan(0.01);
  }
}

/** Page 1's rules below the PRICE heading, each with the line of runs drawn nearest above and below
 *  it (the runs on that baseline, joined in the order drawn): the flow golden's reader. */
function ruledBetween(pdf: Buffer): string[][] {
  const [runs] = textRunsWithY(pdf);
  const top = (run: Run) => PAGE_HEIGHT - run.y;
  const heading = runs.find((r) => r.text.trim() === "PRICE")!;
  const lineNear = (y: number, side: "above" | "below") => {
    const ys = runs.map(top).filter((t) => (side === "above" ? t < y : t > y));
    const near = side === "above" ? Math.max(...ys) : Math.min(...ys);
    return runs.filter((r) => top(r) === near).map((r) => r.text).join("");
  };
  return ruledRules(pdf, 0).filter((s) => s.y1 > top(heading)).map((rule) => [lineNear(rule.y1, "above"), lineNear(rule.y1, "below")]);
}

/** The definition's price block's last node: the sheet lays out a JSON copy of the block, so it is
 *  read by its margin, never by `isPriceRule`. */
function lastPriceNode(def: RenderableDefinition): { margin?: number[]; canvas?: unknown } {
  return (blockItems(def, "price") as { margin?: number[]; canvas?: unknown }[]).at(-1)!;
}

/** Where the last rule of `pdf` sits and where its group ends (the rule's own space above it less). */
function lastRule(pdf: Buffer) {
  const rule = rulesOf(pdf).at(-1);
  expect(rule, "a price rule").toBeDefined();
  return { ...rule!, groupEnd: rule!.y1 - RULE_ABOVE };
}

/** `layout` with the price block, and every block drawn below it, moved down by one distance, so the
 *  last group of `d`'s prices ends `room` pt above the band's top on page 1, read from one print of
 *  `layout` (the price block's drawn y tuned from its measured rendered height). The blocks' drawn
 *  distances are kept, so a block drawn flush under the price block stays flush. */
async function tuned(
  layout: CanvasLayout, d: InvoicePdfData, room: number, over: Partial<TemplateConfig> = {},
): Promise<CanvasLayout> {
  const { pdf } = await renderInvoice(d, invCfg(layout, over));
  const rule = lastRule(pdf);
  expect(rule.page, "the last rule on page 1 before tuning").toBe(1);
  const delta = bandTop(layout, over.pageFooter ?? false) - room - rule.groupEnd;
  const priceY = blockBox(layout, "price").y;
  const moved = (y: number) => Math.round((y + delta) * 1000) / 1000;
  return layoutOf(layout.items.map((item) => (item.kind === "table" && item.box.y >= priceY
    ? { ...item, box: { ...item.box, y: moved(item.box.y) } } : item)));
}

/** A text item anchored below a block. */
const textBelow = (table: InvoiceTable): CanvasItem => ({
  id: `text-below-${table}`, kind: "text", text: "PROBE", box: { x: 24, y: CANVAS_GRID, w: 100, h: 12 },
  anchor: { kind: "below-table", table }, repeat: false, style: { size: 10, bold: false, align: "left" },
});

describe("the owner-ruled paper on a canvas (#590, #589)", () => {
  const W = INVOICE_WIDTHS;
  const layout = standardInvoiceLayout();

  // Green on arrival after Task 3: the strip is measured inside its block there, an item of the
  // block's inner stack in the one canvas block shape since #969. The mutation that reds every case
  // is that block's acceptance reverted (`canvasBlockOf` read as null in render.ts's
  // `fitMeasuredRows`): the render then refuses the strip by name.
  describe("#590: the order strip in its block", () => {
    const LONG_PO = "PO 24115 RELEASE ".repeat(12).slice(0, 200);
    /** Page 1 of `d` printed by the flow and under `canvas`, each read by `fieldsOf`. */
    const both = async (d: InvoicePdfData, canvas: CanvasLayout = layout) => ({
      flow: fieldsOf(textRunsWithY(await renderPdf(buildInvoiceDefinition(d)))[0]),
      canvas: fieldsOf(textRunsWithY((await renderInvoice(d, invCfg(canvas))).pdf)[0]),
    });
    const sameXs = (canvas: Run[], flow: Run[], what: string) => {
      expect(canvas.length, what).toBe(flow.length);
      canvas.forEach((r, i) => expect(Math.abs(r.x - flow[i].x), `${what} ${r.text}`).toBeLessThan(0.5));
    };

    it("on the standard layout prints the four labels on one line at the flow's x, each field's share the flow's", async () => {
      const { flow, canvas } = await both(sampleInvoice());
      onOneLine(canvas.labels);
      sameXs(canvas.labels, flow.labels, "the labels");
      canvas.fields.forEach((field, i) => sameXs(field, flow.fields[i], `field ${i}`));
    });

    it("holds a 200-character PO to its share: it wraps inside it, the others stay on the first line, nothing starts past the margin", async () => {
      const { flow, canvas } = await both(sampleInvoice({ poNumber: LONG_PO }));
      onOneLine(canvas.labels);
      for (const field of [canvas.fields[0], canvas.fields[2], canvas.fields[3]]) {
        expect(field.map((r) => r.y)).toEqual(field.map(() => canvas.labels[0].y));
      }
      expect(baselines(canvas.fields[1])).toBeGreaterThanOrEqual(2);
      sameXs(canvas.fields[1], flow.fields[1], "the PO");
      expect(canvas.page.filter((r) => r.x >= RIGHT_MARGIN)).toEqual([]);
    });

    it("prints a blank PO's label alone, in its place on the line", async () => {
      const { canvas } = await both(sampleInvoice({ poNumber: "" }));
      const [order, po, material] = canvas.labels;
      expect(po.y).toBe(material.y);
      expect(po.x).toBeGreaterThan(order.x);
      expect(po.x).toBeLessThan(material.x);
      expect(canvas.fields[1].map((r) => r.text).join("").trim()).toBe("Your PO #:");
    });

    it("prints a line break in a value as one space, on its label's line", async () => {
      const { canvas } = await both(sampleInvoice({ poNumber: "89499\nREL2" }));
      onOneLine(canvas.labels);
      expect(canvas.fields[1].map((r) => r.text).join("")).toBe("Your PO #: 89499 REL2");
      expect(canvas.fields[1].map((r) => r.y)).toEqual(canvas.fields[1].map(() => canvas.labels[0].y));
      expect(canvas.page.filter((r) => /[\n\r]/.test(r.text))).toEqual([]);
    });

    it("an order strip block drawn 200 wide stacks one field to a line from the block's left plus the Quantity column and its gap", async () => {
      const narrow = reboxed(layout, "order_strip", { x: 60, w: 200 });
      const { canvas } = await both(sampleInvoice(), narrow);
      expect(canvas.labels.map((r) => r.x)).toEqual(canvas.labels.map(() => 60 + W.qty + W.stripIndentGap));
      expect(canvas.labels.every((r, i) => i === 0 || r.y < canvas.labels[i - 1].y), "each label below the one before").toBe(true);
    });

    it("with the Quantity column widened to 300, an order strip block 300 wide is refused under its least width (#971)", () => {
      // The strip starts past the Quantity column and its gap (306 pt into its block), so a block 300
      // wide would start it past its own right edge: its least width follows the Quantity column.
      const wide = reboxed(columnSet(layout, "column_header", "col_qty", { width: 300 }), "order_strip", { w: 300 });
      const least = 300 + W.stripIndentGap + MEASURED_ROW_FLOOR + CANVAS_GRID;
      expect(least).toBe(370.5);
      expect(canvasRefusal(wide, INVOICE_CONTRACT)).toEqual({
        itemIds: [tableOf(wide, "order_strip").id],
        sentence: "The Order strip table is 300 pt wide, less than the 370.5 pt its indent past the column headers' quantity column, " +
          "its fields and one grid step need.",
      });
    });

    it("with the Quantity column widened to 300, an order strip block at its least width prints inside its box (#971)", async () => {
      // Drawn against the right margin, so the whole page's ink is read: nothing passes 588.
      const wide = reboxed(columnSet(layout, "column_header", "col_qty", { width: 300 }), "order_strip", { x: 588 - 370.5, w: 370.5 });
      const box = blockBox(wide, "order_strip");
      expect(canvasRefusal(wide, INVOICE_CONTRACT)).toBeNull();
      const { pdf } = await renderInvoice(sampleInvoice(), invCfg(wide));
      const { labels } = fieldsOf(textRunsWithY(pdf)[0]);
      // Too narrow to share, the strip stacks one field to a line from its indent, inside the box.
      expect(labels.map((r) => r.x)).toEqual(labels.map(() => box.x + 300 + W.stripIndentGap));
      expect(labels.every((r, i) => i === 0 || r.y < labels[i - 1].y), "each label below the one before").toBe(true);
      const past = runFonts(pdf).filter((r) => r.text.trim() !== "").filter((r) => {
        const [family, face] = fontOf(r.font);
        return r.x + textWidthOf(r.text.trimEnd(), family, face, r.size) > box.x + box.w + TEXT_TOLERANCE;
      });
      expect(past.map((r) => `${r.text}@${r.x}`)).toEqual([]);
    });

    it("with the Quantity column widened to 300 and both weights hidden, stacks the strip inside its block exactly as the flow stacks it", async () => {
      // Each field's share of the 258 pt row past the Quantity column and its gap, less the gaps between
      // the fields, falls under the 60 pt floor, so
      // render.ts prints the four one to a line on both. Every run of the strip is compared by its x and
      // its baseline from the first label's (the two pages place the block at different heights).
      const flowConfig = cfg();
      flowConfig.sections = completeSections(INVOICE_CONTRACT, flowConfig.sections).map((sc) => sc.key !== "column_header" ? sc
        : {
          ...sc, fields: sc.fields.map((f) => f.key === "col_qty" ? { ...f, width: 300 }
            : f.key === "col_each_weight" || f.key === "col_amount" ? { ...f, visible: false } : f),
        });
      const grid = columnSet(columnSet(columnSet(layout, "column_header", "col_qty", { width: 300 }),
        "column_header", "col_each_weight", { visible: false }), "column_header", "col_amount", { visible: false });
      const flow = fieldsOf(textRunsWithY(await renderPdf(buildInvoiceDefinition(sampleInvoice(), flowConfig)))[0]);
      const canvas = fieldsOf(textRunsWithY((await renderInvoice(sampleInvoice(), invCfg(grid))).pdf)[0]);
      // Asserted first: the case it was built as, the strip stacked on the flow.
      expect(flow.labels.every((r, i) => i === 0 || r.y < flow.labels[i - 1].y), "each flow label below the one before").toBe(true);
      const relative = (f: ReturnType<typeof fieldsOf>) =>
        f.fields.map((field) => field.map((r) => ({ text: r.text, x: Math.round(r.x * 100) / 100, dy: Math.round((r.y - f.labels[0].y) * 100) / 100 })));
      expect(relative(canvas)).toEqual(relative(flow));
    });
  });

  describe("#589: a rule after each part's prices, from margin to margin", () => {
    const PART_B = { qty: 50, partNumber: "DEMO-9002-000", partName: "SPRING SEAT", partDescription: "", eachWeight: 3.2, totalWeight: 160 };
    const PART_C = { qty: 20, partNumber: "DEMO-9003-000", partName: "BRACKET", partDescription: "", eachWeight: 1.5, totalWeight: 30 };
    const op = (description: string, partIndex: number | null, unitPrice: number | null) => ({
      description, pricePerLabel: "Each", unitPrice, minimumCharge: null, setupCharge: null, amount: (unitPrice ?? 0) * 10, partIndex,
    });
    /** Three parts (the third with no price, so no group) and a price that lost its part, the rows
     *  given as [part 1, part 0, lost, part 1]: the page prints Carburize, then Temper and Anneal,
     *  then Normalize. */
    const grouped = () => sampleInvoice({
      parts: [sampleInvoice().parts[0], PART_B, PART_C],
      priceRows: [op("Temper", 1, 2), op("Carburize", 0, 1), op("Normalize", null, 4), op("Anneal", 1, 3)],
      subtotal: 100, surchargeRows: [], total: 100,
    });

    // Held by the flow's own `priceBlock` (no Task 6 mutation reds it): the canvas adds no grouping.
    it("prints the groups in the PARTS list's order, the lost-part group last, a rule after each, as the flow does (pin)", async () => {
      const flow = await renderPdf(buildInvoiceDefinition(grouped()));
      const { pdf } = await renderInvoice(grouped(), invCfg(layout));
      expect(pageCount(pdf)).toBe(1);
      const between = ruledBetween(pdf);
      expect(between.map(([up]) => up)).toEqual(["Price per Each:  $1.00", "Price per Each:  $3.00", "Price per Each:  $4.00"]);
      expect(between.map(([, down]) => down.split("$")[0])).toEqual(["Temper", "Normalize", "Sub Total Amount:"]);
      expect(between).toEqual(ruledBetween(flow));
      marginToMargin(ruledRules(pdf, 0));
    });

    // Held by the flow's own `priceBlock` (no Task 6 mutation reds it).
    it("a group that printed nothing draws no rule: every grid column hidden, a needs-price row prints nothing (pin)", async () => {
      // Under a column headers block with every column hidden no operation row prints, and a row with
      // no price, minimum, setup or quote prints nothing more: part 1's group prints nothing.
      const hidden = withTable(layout, "column_header", (item) => ({ ...item, columns: item.columns.map((c) => ({ ...c, visible: false })) }));
      const d = sampleInvoice({
        parts: [sampleInvoice().parts[0], PART_B],
        priceRows: [op("Carburize", 0, 1), op("Temper", 1, null), op("Normalize", null, 4)],
        subtotal: 50, surchargeRows: [], total: 50,
      });
      const flowConfig = cfg();
      flowConfig.sections = completeSections(INVOICE_CONTRACT, flowConfig.sections).map((sc) => sc.key !== "column_header" ? sc
        : { ...sc, fields: sc.fields.map((f) => ({ ...f, visible: false })) });
      const flow = await renderPdf(buildInvoiceDefinition(d, flowConfig));
      const { pdf } = await renderInvoice(d, invCfg(hidden));
      expect(ruledRules(pdf, 0)).toHaveLength(2);
      expect(ruledRules(flow, 0)).toHaveLength(2);
      marginToMargin(ruledRules(pdf, 0));
    });

    it("a price block drawn at x 120, 300 wide strokes every rule from the left margin to the right one", async () => {
      const moved = reboxed(layout, "price", { x: 120, w: 300 });
      const { pdf } = await renderInvoice(grouped(), invCfg(moved));
      expect(ruledRules(pdf, 0)).toHaveLength(3);
      marginToMargin(ruledRules(pdf, 0));
      // The block itself prints at its drawn x: the operation's amount ends inside it.
      expect(Math.max(...xsOf(pdf, "$10.00"))).toBeLessThan(120 + 300);
    });

    it("the last group's rule prints alone at the top of page 2, above Sub Total, from margin to margin", async () => {
      // The price block drawn at x 120, 300 wide, its drawn y tuned so the last group ends 2 pt above
      // the band's top: the rule's own space above it does not fit, so it opens page 2. Red with the
      // rule's offset not passed (the page-2 rule starts at 120).
      const room = RULE_ABOVE / 2;
      const placed = await tuned(reboxed(layout, "price", { x: 120, w: 300 }), grouped(), room);
      const { pdf } = await renderInvoice(grouped(), invCfg(placed));
      const rules = rulesOf(pdf);
      // Asserted first: the case it was built as, the last group's rule on page 2, first on its page.
      expect(rules.map((r) => r.page)).toEqual([1, 1, 2]);
      const [rule] = rules.filter((r) => r.page === 2);
      const page2 = textRunsWithY(pdf)[1];
      const topOf = (r: Run) => PAGE_HEIGHT - r.y;
      const margin = topMargin(placed);
      expect(page2.filter((r) => topOf(r) > margin && topOf(r) < rule.y1), "no body run above the rule on page 2").toEqual([]);
      // At the body's top: the rule strokes at the page's top margin (observed exactly there).
      expect(Math.abs(rule.y1 - margin)).toBeLessThan(0.01);
      // Two pages: the rule and the totals under it are page 2's body.
      expect(pageCount(pdf)).toBe(2);
      marginToMargin(rules);
      const below = page2.filter((r) => topOf(r) > rule.y1 && topOf(r) < bandTop(placed));
      const first = Math.min(...below.map(topOf));
      expect(below.filter((r) => topOf(r) === first).map((r) => r.text).join("")).toMatch(/^Sub Total Amount:\$/);
    });
  });

  describe("the end-of-block belt (design §5.2)", () => {
    /** The last group ends 4.5 pt above the band's top: the rule's 4 pt above it fit, its 1 pt below
     *  does not, which on the flow printed a blank last page (tests/invoice-pdf.test.ts). */
    const ROOM = RULE_ABOVE + 0.5;
    const without = (base: CanvasLayout, key: InvoiceTable) =>
      layoutOf(base.items.filter((item) => !(item.kind === "table" && item.key === key)));
    /** The totals block drawn flush under the price block (drawn distance 0). */
    const flush = (base: CanvasLayout) => {
      const price = blockBox(base, "price");
      return reboxed(base, "totals", { y: price.y + price.h });
    };
    const rowsHidden = (base: CanvasLayout, keys?: string[]) => withTable(base, "totals", (item) => ({
      ...item, columns: item.columns.map((c) => (keys === undefined || keys.includes(c.key) ? { ...c, visible: false } : c)),
    }));
    /** The price block and the totals block swapped: the totals drawn above the price block. */
    const totalsAbove = (base: CanvasLayout) => {
      const price = blockBox(base, "price");
      const totals = blockBox(base, "totals");
      return reboxed(reboxed(base, "totals", { y: price.y }), "price", { y: totals.y });
    };

    const NOTHING_FOLLOWS: [string, () => CanvasLayout, () => InvoicePdfData][] = [
      ["no totals block", () => without(layout, "totals"), () => sampleInvoice()],
      ["a totals block whose every row is hidden", () => rowsHidden(flush(layout)), () => sampleInvoice()],
      ["the totals block drawn above the price block", () => totalsAbove(layout), () => sampleInvoice()],
      ["a totals block that has nothing to print", () => rowsHidden(flush(layout), ["subtotal", "total"]), () => sampleInvoice({ surchargeRows: [] })],
    ];

    it.each(NOTHING_FOLLOWS)("with %s, the last rule has no space under it and no blank last page prints", async (_what, base, data) => {
      const d = data();
      const placed = await tuned(base(), d, ROOM);
      const config = invCfg(placed);
      const { pdf } = await renderInvoice(d, config);
      const rule = lastRule(pdf);
      // Asserted first: the case it was built as, the last group ending 4 to 5 pt above the band.
      expect(rule.page).toBe(1);
      const room = bandTop(placed) - rule.groupEnd;
      expect(room).toBeGreaterThanOrEqual(4);
      expect(room).toBeLessThanOrEqual(5);
      expect(pageCount(pdf), "no blank last page").toBe(rule.page);
      expect(lastPriceNode(buildInvoiceDefinition(d, config)).margin).toEqual([0, RULE_ABOVE, 0, 0]);
    });

    // Red with the belt's region check dropped (`regions.has(item.anchor.table)`): the Text below an
    // EARLIER block then stops the belt, and the rule's 1 pt below opens a blank last page.
    it.each<[string, InvoiceTable]>([
      ["the parts block", "parts"],
      ["the column headers block", "column_header"],
    ])("a Text item anchored below %s, no totals block: the last rule has no space under it and no blank last page prints", async (_what, table) => {
      const d = sampleInvoice();
      const placed = await tuned(layoutOf([...without(layout, "totals").items, textBelow(table)]), d, ROOM);
      const config = invCfg(placed);
      const { pdf } = await renderInvoice(d, config);
      const rule = lastRule(pdf);
      // Asserted first: the case it was built as, the last group ending 4 to 5 pt above the band and
      // the Text printing.
      expect(rule.page).toBe(1);
      const room = bandTop(placed) - rule.groupEnd;
      expect(room).toBeGreaterThanOrEqual(4);
      expect(room).toBeLessThanOrEqual(5);
      expect(xsOf(pdf, "PROBE").length).toBeGreaterThan(0);
      expect(pageCount(pdf), "no blank last page").toBe(1);
      expect(lastPriceNode(buildInvoiceDefinition(d, config)).margin).toEqual([0, RULE_ABOVE, 0, 0]);
    });

    // Red with the belt's new rule made with no offset (`flow.priceRule(0)`): the last rule then
    // starts at the block's drawn x, 120.
    it("a price block drawn at x 120, 300 wide, no totals block: the belt's last rule has no space under it and runs from margin to margin", async () => {
      const d = sampleInvoice();
      const placed = await tuned(reboxed(without(layout, "totals"), "price", { x: 120, w: 300 }), d, ROOM);
      const config = invCfg(placed);
      const { pdf } = await renderInvoice(d, config);
      const rule = lastRule(pdf);
      expect(rule.page).toBe(1);
      const room = bandTop(placed) - rule.groupEnd;
      expect(room).toBeGreaterThanOrEqual(4);
      expect(room).toBeLessThanOrEqual(5);
      expect(pageCount(pdf), "no blank last page").toBe(1);
      expect(lastPriceNode(buildInvoiceDefinition(d, config)).margin).toEqual([0, RULE_ABOVE, 0, 0]);
      marginToMargin(rulesOf(pdf));
    });

    // Each is red under one belt mutation: the printing totals block with the "later block answers no
    // children" condition dropped; the Text below the price block with the price block's own region
    // left out of `regions`, or the items clause dropped whole; the Text below the later totals block
    // with `regions` holding the price block's region alone, or the items clause dropped whole.
    it.each<[string, () => CanvasLayout]>([
      ["under a printing totals block", () => flush(layout)],
      ["with a Text item anchored below the price block", () => layoutOf([...without(layout, "totals").items, textBelow("price")])],
      ["with a Text item anchored below a later totals block that prints nothing", () => layoutOf([...rowsHidden(flush(layout)).items, textBelow("totals")])],
    ])("the last rule keeps its space under it %s", async (_what, base) => {
      const d = sampleInvoice();
      const placed = await tuned(base(), d, ROOM);
      const { pdf } = await renderInvoice(d, invCfg(placed));
      const room = bandTop(placed) - lastRule(pdf).groupEnd;
      expect(room).toBeGreaterThanOrEqual(4);
      expect(room).toBeLessThanOrEqual(5);
      expect(lastPriceNode(buildInvoiceDefinition(d, invCfg(placed))).margin).toEqual([0, RULE_ABOVE, 0, RULE_BELOW]);
    });

    // Red before #997 on the page count: the region, a spacer alone since the logo prints nothing,
    // moved whole to a new page. Red with the sheet's drop removed (`assembleCanvasSheet` emitting
    // every region). The logo-bytes half is red with the drop judged without the region's own items.
    it("a Logo item below the price block with no logo bytes prints nothing, so the last rule has no space under it and no blank last page prints (#997)", async () => {
      // Its drawn box still makes a region (`regionHeights`), which paged under the 4 to 5 pt
      // condition whatever the rule did until #997: the sheet now drops a trailing region that holds
      // no item that prints.
      const base = layoutOf([...without(layout, "totals").items, logo({ anchor: { kind: "below-table", table: "price" }, box: { x: 24, y: CANVAS_GRID, w: 80, h: 40 } })]);
      const d = sampleInvoice();
      const placed = await tuned(base, d, ROOM);
      const { pdf } = await renderInvoice(d, invCfg(placed));
      const room = bandTop(placed) - lastRule(pdf).groupEnd;
      expect(room).toBeGreaterThanOrEqual(4);
      expect(room).toBeLessThanOrEqual(5);
      expect(pageCount(pdf), "no blank last page").toBe(1);
      expect(lastPriceNode(buildInvoiceDefinition(d, invCfg(placed))).margin).toEqual([0, RULE_ABOVE, 0, 0]);
      // With logo bytes the same item prints, so the rule keeps its space and the region is kept: it
      // moves whole to page 2, the logo painted there.
      const withLogo = buildCanvasInvoiceDefinition(d, invCfg(placed), placed, INVOICE_FLOW, `data:image/jpeg;base64,${TINY_JPEG.toString("base64")}`);
      expect(lastPriceNode(withLogo).margin).toEqual([0, RULE_ABOVE, 0, RULE_BELOW]);
      const { pdf: painted } = await renderSheetGroupsWithPositions([withLogo]);
      expect(paintedImageCounts(painted)).toEqual([0, 1]);
    });

    it("a hand-built canvas line closing the price block is not a price rule, and keeps its space", async () => {
      const base = without(layout, "totals");
      const d = sampleInvoice();
      // The flow's price block with its last rule replaced by a JSON copy: the same shape, never made
      // by `priceRule`.
      const flow = {
        ...INVOICE_FLOW,
        priceBlock: (ctx: InvoiceCtx, data: InvoicePdfData) => {
          const nodes = INVOICE_FLOW.priceBlock(ctx, data);
          expect(INVOICE_FLOW.isPriceRule(nodes.at(-1))).toBe(true);
          return [...nodes.slice(0, -1), JSON.parse(JSON.stringify(nodes.at(-1))) as Content];
        },
      };
      const def = buildCanvasInvoiceDefinition(d, invCfg(base), base, flow);
      expect(lastPriceNode(def).margin).toEqual([0, RULE_ABOVE, 0, RULE_BELOW]);
      // The same layout through the flow's own builders: its rule is the belt's.
      expect(lastPriceNode(buildCanvasInvoiceDefinition(d, invCfg(base), base, INVOICE_FLOW)).margin).toEqual([0, RULE_ABOVE, 0, 0]);
    });

    // #997 (owner ruling 2026-11-15): the sheet drops a trailing float region that holds no item that
    // prints when nothing that prints follows it, on every canvas document (`assembleCanvasSheet`,
    // `nothingPrintsAfter`). The fixture draws 9 pt between blocks, so a totals block that prints
    // nothing, drawn there, leaves a 9 pt gap under the price block: a spacer alone.
    describe("a drawn gap with nothing after it (#997)", () => {
      /** The marks around the price block's region: where the block ends, and where its region ends. */
      const priceMarks = (group: Group) => ({
        end: at(group, CANVAS_IDS.end("price")), regionEnd: at(group, CANVAS_IDS.regionEnd("price")),
      });

      // Red before #997: the 9 pt region moved whole to page 2, a blank last page. Red with the
      // sheet's drop removed.
      it("a totals block whose every row is hidden, drawn 9 pt under the price block: no blank last page, the gap dropped", async () => {
        const d = sampleInvoice();
        const base = rowsHidden(layout);
        expect(drawnGap(base, "totals"), "the fixture's gap").toBe(9);
        const placed = await tuned(base, d, ROOM);
        const { pdf, group } = await renderInvoice(d, invCfg(placed));
        const rule = lastRule(pdf);
        expect(rule.page).toBe(1);
        const room = bandTop(placed) - rule.groupEnd;
        expect(room).toBeGreaterThanOrEqual(4);
        expect(room).toBeLessThanOrEqual(5);
        expect(room, "the gap does not fit under the last rule").toBeLessThan(drawnGap(placed, "totals"));
        expect(pageCount(pdf), "no blank last page").toBe(1);
        // The region printed nothing: its end mark sits where the block ends.
        const { end, regionEnd } = priceMarks(group);
        expect([regionEnd.page, regionEnd.top]).toEqual([end.page, end.top]);
      });

      // Red before #997 on the page count and the region's page; red with the measure's dropped-region
      // reading removed (`canvasMeasure` then reports the region one gap above the block's end).
      it("the preview's measure reports the dropped region at the price block's rendered bottom, on the one page", async () => {
        const d = sampleInvoice();
        const placed = await tuned(rowsHidden(layout), d, ROOM);
        const config = invCfg(placed);
        const { pdf, measure } = await renderInvoiceCanvasPreview(d, config, undefined);
        expect(pageCount(pdf)).toBe(1);
        expect(measure!.pages).toBe(1);
        const { group } = await renderInvoice(d, config);
        const { end } = priceMarks(group);
        expect(measure!.regions.find((r) => r.after === "price")).toEqual({ after: "price", page: 1, top: end.top, height: 9 });
        // The totals block prints nothing, so it measures 0 tall at the price block's rendered bottom.
        expect(measure!.tables.find((t) => t.key === "totals")).toMatchObject({ page: 1, top: end.top, height: 0 });
      });

      // Red with the drop judged without the later regions' items: the Text below the totals block
      // then no longer keeps the gap, and prints 9 pt higher.
      it("a gap followed by an item that prints is kept: the Text below the empty totals block prints 9 pt under the flush case's", async () => {
        const d = sampleInvoice();
        const gapped = layoutOf([...rowsHidden(layout).items, textBelow("totals")]);
        const flushed = layoutOf([...rowsHidden(flush(layout)).items, textBelow("totals")]);
        const a = await renderInvoice(d, invCfg(gapped));
        const b = await renderInvoice(d, invCfg(flushed));
        expect(pageCount(a.pdf)).toBe(1);
        const { end, regionEnd } = priceMarks(a.group);
        expect(regionEnd.top - end.top).toBeCloseTo(9, 6);
        expect(runTop(a.pdf, "PROBE") - runTop(b.pdf, "PROBE")).toBeCloseTo(9, 6);
      });

      // Red with the drop judged without the later blocks (every spacer-only region dropped): the
      // printing totals block then rides the price block flush, 9 pt higher.
      it("a gap that is not last is kept: a printing totals block drawn 9 pt under the price block prints 9 pt under the flush case's", async () => {
        const d = sampleInvoice();
        const a = await renderInvoice(d, invCfg(layout));
        const b = await renderInvoice(d, invCfg(flush(layout)));
        const { end, regionEnd } = priceMarks(a.group);
        expect(regionEnd.top - end.top).toBeCloseTo(9, 6);
        expect(runTop(a.pdf, "Amount:") - runTop(b.pdf, "Amount:"), "Sub Total Amount:").toBeCloseTo(9, 6);
      });
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Task 7: the flow's seed ids (design 2026-11-10 §5.3). Under `seedIds` the flow marks its pieces
// (a wrapper stack carrying the id, its end mark inside it) and its six blocks (two marks each: a
// one-node block's inside its node's own vertical margins, a several-node block's as top-level
// siblings of its nodes, never a wrapper), and lays out exactly as it does without them.
// ---------------------------------------------------------------------------------------------

describe("the flow's seed ids (design 2026-11-10 §5.3)", () => {
  const PIECES = ["title", "company_name", "logo", "invoice_no", "invoice_date", "terms", "remit_to"];
  const LOGO_URI = `data:image/jpeg;base64,${TINY_JPEG.toString("base64")}`;

  /** The Standard, edited. */
  const edited = (edit: (c: TemplateConfig) => void): TemplateConfig => {
    const c = cfg();
    c.sections = completeSections(INVOICE_CONTRACT, c.sections);
    edit(c);
    return c;
  };
  const sectionOf = (c: TemplateConfig, key: string) => c.sections.find((s) => s.key === key)!;
  /** Moves section `key` to just after section `after`. */
  const moveAfter = (c: TemplateConfig, key: string, after: string): void => {
    const [moved] = c.sections.splice(c.sections.findIndex((s) => s.key === key), 1);
    c.sections.splice(c.sections.findIndex((s) => s.key === after) + 1, 0, moved);
  };
  const withLogo = (placement: "header-left" | "header-center" | "header-right") =>
    edited((c) => { c.logo = { placement, width: 60 }; });

  const seedDef = (d: InvoicePdfData, config: TemplateConfig, logoUri?: string) =>
    buildInvoiceDefinition(d, config, logoUri, { seedIds: true });

  it("a one-node section handed more than one node under the seed is refused by name; with no seed its nodes pass unchanged", () => {
    const a: Content = { text: "A" };
    const b: Content = { text: "B" };
    const ctx = standardCtx();
    expect(() => seedSection({ ...ctx, seed: true }, "parties", [a, b]))
      .toThrow("An invoice one-node section answers one node; parties answered 2.");
    expect(seedSection(ctx, "parties", [a, b])).toEqual([a, b]);
    expect(seedSection({ ...ctx, seed: true }, "parties", [a])).toHaveLength(1);
  });
  async function laidOut(def: RenderableDefinition) {
    const { pdf, groups } = await renderSheetGroupsWithPositions([def]);
    return { pdf, group: groups[0] };
  }
  /** Every laid-out node under `id`. */
  const every = (group: Group, id: string) => group.positions.filter((n) => n.id === id);
  const top = (group: Group, id: string) => at(group, id).top;
  /** A block's laid-out height: its end mark's top less its start mark's. */
  const blockH = (group: Group, key: string) => top(group, INVOICE_SEED_IDS.sectionEnd(key)) - top(group, INVOICE_SEED_IDS.start(key));

  /** Two parts, each with a priced operation (a unit price, so its detail line prints with every
   *  column hidden): two groups, two rules. */
  const twoGroups = (): InvoicePdfData => sampleInvoice({
    parts: [
      sampleInvoice().parts[0],
      { qty: 50, partNumber: "DEMO-9002-000", partName: "SPRING SEAT", partDescription: "", eachWeight: 3.2, totalWeight: 160 },
    ],
    priceRows: [
      { description: "Austemper", pricePerLabel: "Each", unitPrice: 6.51, minimumCharge: null, setupCharge: null, amount: 937.44, partIndex: 0 },
      { description: "Temper", pricePerLabel: "Each", unitPrice: 2, minimumCharge: null, setupCharge: null, amount: 100, partIndex: 1 },
    ],
  });
  /** The definition's top-level price rules, by their shape (the test cannot reach `priceRules`). */
  const rulesOf = (def: RenderableDefinition) => (def.content as Content[]).filter((n) => {
    const c = (n as { canvas?: { type: string; lineWidth?: number }[] }).canvas;
    return Array.isArray(c) && c.length === 1 && c[0].type === "line" && c[0].lineWidth === RULE_WIDTH;
  }) as { margin: number[] }[];

  it.each(["header-left", "header-center", "header-right"] as const)(
    "with a %s logo the seed's definition holds every piece's, section's and end mark's id, each laid out once",
    async (placement) => {
      const { group } = await laidOut(seedDef(sampleInvoice(), withLogo(placement), LOGO_URI));
      const ids = [
        ...PIECES.flatMap((p) => [INVOICE_SEED_IDS.piece(p), INVOICE_SEED_IDS.end(p)]),
        ...BLOCKS.flatMap((b) => [INVOICE_SEED_IDS.start(b), INVOICE_SEED_IDS.sectionEnd(b)]),
      ];
      for (const id of ids) expect(every(group, id).length, id).toBe(1);
      // Nothing else in the seed's namespace.
      expect(group.positions.filter((n) => n.id.startsWith("seed:")).length).toBe(ids.length);
    },
  );

  it("the order strip's measured row is still an item of the top-level content array, and the seed's render measures it", async () => {
    const def = seedDef(sampleInvoice(), cfg());
    // The Standard shows the strip's four fields, so `fitMeasuredRows` measures the row: the render
    // does not throw (a row inside a plain stack is refused by name), and the strip prints on one
    // line, its block's start mark at the row's own top.
    const { pdf, group } = await laidOut(def);
    const content = def.content as { id?: string }[];
    expect(content.some((n) => n.id === "invoice-order-strip")).toBe(true);
    onOneLine(fieldsOf(textRunsWithY(pdf)[0]).labels);
    expect(top(group, INVOICE_SEED_IDS.start("order_strip"))).toBe(top(group, "invoice-order-strip"));
  });

  // Green on arrival (with no seed ids the two builds were one); it reds when a seed wrapper moves
  // what it wraps: a piece's margin kept on the piece as well as its wrapper, a one-node block's
  // node keeping its margins inside the marks' stack, or the Remit To wrapper's width dropped.
  it("the seed lays out exactly as the flow: the same runs at the same places, the same strokes and the same pictures", async () => {
    for (const [config, uri] of [[cfg(), undefined], [withLogo("header-left"), LOGO_URI], [withLogo("header-center"), LOGO_URI]] as const) {
      const flow = await renderPdf(buildInvoiceDefinition(twoGroups(), config, uri));
      const { pdf } = await laidOut(seedDef(twoGroups(), config, uri));
      expect(textRunsWithY(pdf)).toEqual(textRunsWithY(flow));
      expect(strokedLines(pdf)).toEqual(strokedLines(flow));
      // The logo at the flow's place (red with the seeded logo moved by a margin): one picture where a
      // logo is placed, so the comparison is never of two empty pages.
      expect(paintedImages(flow).flat(), "the flow's pictures").toHaveLength(uri === undefined ? 0 : 1);
      expect(paintedImages(pdf)).toEqual(paintedImages(flow));
    }
  });

  it("the Remit To piece's wrapper is the column's 250 wide, and it reports the box's own corner, where the flow strokes it", async () => {
    const def = seedDef(sampleInvoice(), cfg());
    const wrapper = nodesOf(def).find((n) => n.id === INVOICE_SEED_IDS.piece("remit_to"))!;
    expect(wrapper.width).toBe(INVOICE_WIDTHS.remitTo);
    const { group } = await laidOut(def);
    const flow = await renderPdf(buildInvoiceDefinition(sampleInvoice(), cfg()));
    // The box's horizontals are the boxed rules above the addresses (the column strip's are below
    // them): its top and bottom; its left is where they start.
    const parties = top(group, INVOICE_SEED_IDS.start("parties"));
    const box = strokedLines(flow)[0].filter((s) => Math.abs(s.width - BOXED_RULE) < 0.01 && Math.abs(s.y1 - s.y2) < 0.01
      && s.y1 < parties);
    expect(box.length, "the Remit To box's horizontals").toBe(2);
    const boxLeft = Math.min(...box.map((s) => Math.min(s.x1, s.x2)));
    const boxTop = Math.min(...box.map((s) => s.y1));
    const piece = at(group, INVOICE_SEED_IDS.piece("remit_to"));
    expect(piece.left).toBeCloseTo(CANVAS_PAGE.margin + INVOICE_WIDTHS.content - INVOICE_WIDTHS.remitTo, 2);
    expect(Math.abs(piece.left - boxLeft)).toBeLessThan(0.01);
    // A rule is stroked centred on its line: the box's top edge is half a rule above the stroke's y.
    expect(Math.abs(piece.top - (boxTop - BOXED_RULE / 2))).toBeLessThan(0.01);
  });

  it("every block's marks sit at its nodes' own top and bottom: a one-node block's margins outside them, a several-node block's inside", async () => {
    const { group } = await laidOut(seedDef(sampleInvoice(), cfg()));
    const end = (key: string) => top(group, INVOICE_SEED_IDS.sectionEnd(key));
    const start = (key: string) => top(group, INVOICE_SEED_IDS.start(key));
    // The identity's 8 pt bottom margin and the addresses' 4 pt top margin lie between the Remit To
    // box's end (the taller of the identity's columns) and the addresses' start mark; the addresses'
    // 6 pt bottom margin and the column headers' 4 pt bottom margin lie outside theirs.
    // Each margin is read from the node the flow builds (never retyped): [left, top, right, bottom].
    const marginOf = (node: Content | undefined) => (node as { margin: number[] }).margin;
    const sd = sampleInvoice();
    const sc = standardCtx();
    const identityRow = (buildInvoiceDefinition(sd, cfg()).content as Content[]).find((n) =>
      ((n as { columns?: { width?: unknown }[] }).columns ?? []).some((c) => c.width === INVOICE_WIDTHS.remitTo));
    const [, partiesAbove, , partiesBelow] = marginOf(INVOICE_FLOW.partiesBlock(sc, sd)[0]);
    const headerBelow = marginOf(INVOICE_FLOW.columnHeaderStrip(sc)[0])[3];
    const [, partsHeadAbove, , partsHeadBelow] = marginOf(INVOICE_FLOW.orderStrip(sc, sd).at(-1));
    const [, priceHeadAbove, , priceHeadBelow] = marginOf(INVOICE_FLOW.priceBlock(sc, sd)[0]);
    const remitEnd = top(group, INVOICE_SEED_IDS.end("remit_to"));
    expect(remitEnd).toBeGreaterThan(top(group, INVOICE_SEED_IDS.end("terms")));
    expect(start("parties") - remitEnd).toBeCloseTo(marginOf(identityRow)[3] + partiesAbove, 2);
    expect(start("column_header") - end("parties")).toBeCloseTo(partiesBelow, 2);
    expect(start("order_strip") - end("column_header")).toBeCloseTo(headerBelow, 2);
    // The several-node blocks stand back to back, every margin inside their marks.
    expect(start("parts")).toBe(end("order_strip"));
    expect(start("price")).toBe(end("parts"));
    expect(start("totals")).toBe(end("price"));
    // The PARTS heading's 4 pt above and 2 pt below are inside the order strip's marks: with the
    // heading hidden the block is the strip's one 9 pt line, and with it shown that line, the
    // heading's 9 pt line and its 6 pt of margins.
    const { group: bare } = await laidOut(seedDef(sampleInvoice(), hiding("order_strip", "parts_heading")));
    const line = blockH(bare, "order_strip");
    expect(line).toBeGreaterThan(0);
    expect(blockH(group, "order_strip")).toBeCloseTo(2 * line + partsHeadAbove + partsHeadBelow, 2);
    // The PRICE heading's 8 pt above and 2 pt below are inside the price block's marks.
    const { group: noHeading } = await laidOut(seedDef(sampleInvoice(), hiding("price", "price_heading")));
    expect(blockH(group, "price") - blockH(noHeading, "price")).toBeCloseTo(line + priceHeadAbove + priceHeadBelow, 2);
  });

  it("a Column headers section shown with every column hidden still emits its marks, together, and so do the parts it empties", async () => {
    const config = edited((c) => { for (const f of sectionOf(c, "column_header").fields) f.visible = false; });
    const { group } = await laidOut(seedDef(sampleInvoice(), config));
    for (const key of ["column_header", "parts"]) {
      expect(every(group, INVOICE_SEED_IDS.start(key)).length, key).toBe(1);
      expect(blockH(group, key), key).toBe(0);
    }
  });

  describe("the end-of-content belt passes over the seed's marks (#589)", () => {
    const CASES: [string, TemplateConfig][] = [
      ["Totals hidden", edited((c) => { sectionOf(c, "totals").visible = false; })],
      ["Totals hidden, Parties shown with both rows hidden and ordered after PRICE", edited((c) => {
        sectionOf(c, "totals").visible = false;
        for (const f of sectionOf(c, "parties").fields) f.visible = false;
        moveAfter(c, "parties", "price");
      })],
      ["Totals hidden, Column headers shown with every column hidden and ordered after PRICE", edited((c) => {
        sectionOf(c, "totals").visible = false;
        for (const f of sectionOf(c, "column_header").fields) f.visible = false;
        moveAfter(c, "column_header", "price");
      })],
    ];
    it.each(CASES)("%s: the last price rule has no space under it, as the flow's has none", (_name, config) => {
      // The flow itself zeroes it (its sections answering nothing after PRICE), so the seed must too.
      const flowRules = rulesOf(buildInvoiceDefinition(twoGroups(), config));
      expect(flowRules.length).toBe(2);
      expect(flowRules.at(-1)!.margin).toEqual([0, 4, 0, 0]);
      const def = seedDef(twoGroups(), config);
      const rules = rulesOf(def);
      expect(rules.map((r) => r.margin)).toEqual([[0, 4, 0, 1], [0, 4, 0, 0]]);
      // And the seed's marks do follow the rule: the belt reached it past them.
      const content = def.content as Content[];
      expect(content.indexOf(rules[1] as Content)).toBeLessThan(content.length - 1);
    });
  });

  it("a flow or canvas print's definition carries no seed id, and seedIds off is the plain definition", () => {
    const json = (def: unknown) => JSON.stringify(def);
    const ids = (def: unknown) => json(def).match(/"seed:[^"]*"/g) ?? [];
    for (const [config, uri] of [[cfg(), undefined], [withLogo("header-left"), LOGO_URI], [withLogo("header-center"), LOGO_URI]] as const) {
      const plain = buildInvoiceDefinition(twoGroups(), config, uri);
      expect(ids(plain)).toEqual([]);
      expect(json(buildInvoiceDefinition(twoGroups(), config, uri, { seedIds: false }))).toBe(json(plain));
      expect(ids(seedDef(twoGroups(), config, uri)).length).toBeGreaterThan(0);
    }
    const layout = standardInvoiceLayout();
    const canvas = invCfg(layout);
    expect(ids(buildInvoiceDefinition(twoGroups(), canvas))).toEqual([]);
    // The canvas branch ignores the option.
    expect(ids(buildInvoiceDefinition(twoGroups(), canvas, undefined, { seedIds: true }))).toEqual([]);
  });

  it("invoiceSeedStyle states the flow's own size, weight and alignment for each key it seeds, and null for any other", () => {
    const fonts = { ...INVOICE_DEFAULT_CONFIG.fonts, headingSize: 22, smallSize: 7 };
    expect(invoiceSeedStyle("title", fonts)).toEqual({ size: 22, bold: true, align: "center" });
    expect(invoiceSeedStyle("company_name", fonts)).toEqual({ size: 15, bold: true, align: "center" });
    for (const key of ["invoice_no", "invoice_date", "terms"]) expect(invoiceSeedStyle(key, fonts)).toEqual({ size: 10, bold: false, align: "left" });
    expect(invoiceSeedStyle("remit_to", fonts)).toEqual({ size: 13, bold: true, align: "left" });
    expect(invoiceSeedStyle("footer_address", fonts)).toEqual({ size: 7, bold: false, align: "left" });
    expect(invoiceSeedStyle("footer_contact", fonts)).toEqual({ size: 7, bold: false, align: "center" });
    expect(invoiceSeedStyle("footer_phone", fonts)).toEqual({ size: 7, bold: false, align: "right" });
    expect(invoiceSeedStyle("logo", fonts)).toBeNull();
    expect(invoiceSeedStyle("bill_to", fonts)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The print's logo line (Task 10; open question 10, a departure from design §12's deferral of every
// print through `printInvoice` to PR 3): `printInvoiceInTx` turns the version's logo bytes into a
// data URI where `templatePlacesLogo` says the config places one. On a flow config that equals
// `config.logo !== null`, so no mutation of the line reds this case, whose configs are all flow
// configs: it pins the flow's half across the change. The line's proof is
// tests/invoice-canvas-print.test.ts's (PR 3, Task 4): a canvas Logo item printed through
// `printInvoice` reds when the line's test goes back to `config.logo !== null`.
// ---------------------------------------------------------------------------------------------

describe("the invoice print's logo line, the flow's half (pin)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });
  const asSystem = <T>(fn: () => Promise<T>) => runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);
  let seq = 0;

  /** A draft invoice for its own customer: one part priced by one EACH operation, shipped. */
  async function draftInvoice() {
    seq += 1;
    const customer = await prisma.customer.create({ data: { code: `ILG${seq}`, name: `Invoice Logo Customer ${seq}` } });
    const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: `P-LOGO-${seq}`, name: "EQUALIZER-RR SUSP", eachWeight: "21.0000" } });
    const gl = await prisma.glAccount.create({ data: { name: `41${seq}`, description: "Sales" } });
    const code = await prisma.processStepCode.create({ data: { code: `ILG${seq}`, name: "Austemper", glAccountId: gl.id } });
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    await prisma.partProcessStep.create({ data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austemper." } });
    await asSystem(() => addPartPrice(part.id, {
      processStepCodeId: code.id, position: 1, unitPrice: "1.0000", minimumCharge: null, pricePer: "EACH",
    }));
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: "89499", lines: [{ partId: part.id, qty: 10, weight: "210.00" }],
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
    return { customer, invoice };
  }

  /** A published INVOICE flow template with a logo uploaded, its config's logo `placed` or null,
   *  assigned to `customerId`. */
  async function logoTemplate(customerId: string, placed: boolean) {
    seq += 1;
    const t = await asSystem(() => createTemplate("INVOICE", `Logo Invoice ${seq}`));
    const config: TemplateConfig = {
      ...structuredClone(INVOICE_DEFAULT_CONFIG), logo: placed ? { placement: "header-left", width: 90 } : null,
    };
    await asSystem(() => editDraft(t.id, { config, updatedAt: t.draft.updatedAt }));
    await asSystem(async () => uploadLogo(t.id, await barcodePng("INVLOGO"), "image/png"));
    await asSystem(() => publishDraft(t.id));
    await asSystem(() => assignTemplate(customerId, "INVOICE", t.id));
  }

  it("a flow template whose logo is placed prints it through printInvoice, and an unplaced upload paints none (pin)", async () => {
    const placed = await draftInvoice();
    await logoTemplate(placed.customer.id, true);
    expect(paintedImageCounts((await asSystem(() => printInvoice(placed.invoice.id))).pdf)).toEqual([1]);

    const unplaced = await draftInvoice();
    await logoTemplate(unplaced.customer.id, false);
    expect(paintedImageCounts((await asSystem(() => printInvoice(unplaced.invoice.id))).pdf)).toEqual([0]);
  });
});

// The canvas render's and the seed's budget (design 2026-11-10 §5.4; invoice canvas PR 2, Task 11).
// Run on purpose, on mains at the Performance profile with both runner slots paused:
// CANVAS_TIMING=1 npx vitest run tests/invoice-canvas.test.ts -t "CANVAS timing" --reporter=verbose --silent=false
// No time is asserted: every figure is logged as it lands, for the controller to read against 2.5 s
// at §5.4's size (100 parts; the seed on 100 part lines). The doubled size is recorded, never judged.
describe("the invoice canvas's budget (design 2026-11-10 §5.4)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });
  const asSystem = <T>(fn: () => Promise<T>) => runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);
  let seq = 0;

  /** A draft invoice of `parts` part lines, each priced by three EACH operations (a unit price, a
   *  minimum and a setup on each), shipped whole. */
  async function timingDraft(parts: number) {
    seq += 1;
    const customer = await prisma.customer.create({ data: { code: `ITM${seq}`, name: `Invoice Timing Customer ${seq}` } });
    const gl = await prisma.glAccount.create({ data: { name: `42${seq}`, description: "Sales" } });
    const codes = await Promise.all(["Austemper", "Temper", "Straighten"].map((name, i) =>
      prisma.processStepCode.create({ data: { code: `ITM${seq}-${i + 1}`, name, glAccountId: gl.id } })));
    const made: { id: string }[] = [];
    for (let p = 0; p < parts; p++) {
      const part = await prisma.part.create({
        data: { customerId: customer.id, partNumber: `TIMING-${seq}-${p + 1}`, name: `EQUALIZER ${p + 1}`, eachWeight: "21.0000" },
      });
      const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
      for (const [i, code] of codes.entries()) {
        await prisma.partProcessStep.create({ data: { revisionId: rev.id, position: i + 1, codeId: code.id, instruction: `${code.name}.` } });
        await asSystem(() => addPartPrice(part.id, {
          processStepCodeId: code.id, position: i + 1, unitPrice: "1.2500", minimumCharge: "50.00", setupCharge: "15.00", pricePer: "EACH",
        }));
      }
      made.push(part);
    }
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: "89499", lines: made.map((p) => ({ partId: p.id, qty: 10, weight: "210.00" })),
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
    return invoice;
  }

  /** §5.4's invoice in memory: `parts` parts, three operations each with a quote source, a unit price,
   *  a minimum and a setup, 20 surcharge and 20 charge lines, the cert, freight and tax lines. */
  function bigInvoice(size: { parts: number }): InvoicePdfData {
    const parts = Array.from({ length: size.parts }, (_, i) => ({
      qty: 10 + i, partNumber: `DEMO-${10000 + i}`, partName: `EQUALIZER-RR SUSP ${i + 1}`, partDescription: `Drawing D-${i + 1}`,
      eachWeight: 21, totalWeight: 21 * (10 + i),
    }));
    const priceRows = parts.flatMap((p, i) => ["Austemper", "Temper", "Straighten"].map((description, k) => ({
      description, pricePerLabel: "Each", unitPrice: 1.25 + k, minimumCharge: 50, setupCharge: 15,
      // The billed amount never falls below the printed 50.00 minimum, so the sample paper adds up.
      sourceQuoteNumber: 5000 + i, amount: Math.max(50, (1.25 + k) * p.qty + 15), partIndex: i,
    })));
    const subtotal = priceRows.reduce((sum, r) => sum + r.amount, 0);
    const surchargeRows = Array.from({ length: 20 }, (_, i) => ({ description: `Surcharge ${i + 1}`, amount: 5 + i }));
    const chargeRows = Array.from({ length: 20 }, (_, i) => ({ description: `Charge ${i + 1}`, amount: 10 + i }));
    const extras = [...surchargeRows, ...chargeRows].reduce((sum, r) => sum + r.amount, 0);
    return sampleInvoice({
      parts, priceRows, subtotal, surchargeRows, chargeRows,
      certRow: { description: "Certification", amount: 20 },
      freightRow: { description: "Freight", amount: 40 },
      taxRow: { description: "Sales tax", amount: 12 },
      total: subtotal + extras + 72,
    });
  }

  /** Times `run` (a build plus its render, or a seed), logging the figure as it lands; a throw logs
   *  its time first. */
  async function timed<T>(label: string, run: () => Promise<T>, pages: (result: T) => string): Promise<T> {
    const started = performance.now();
    try {
      const result = await run();
      console.log(`CANVAS timing: ${label}; ${pages(result)} in ${Math.round(performance.now() - started)} ms`);
      return result;
    } catch (error) {
      console.log(`CANVAS timing: ${label} threw after ${Math.round(performance.now() - started)} ms`);
      throw error;
    }
  }

  it.skipIf(process.env.CANVAS_TIMING !== "1")("CANVAS timing: an invoice canvas render and seed", async () => {
    // The layout, seeded once from a small draft invoice.
    const small = await timingDraft(1);
    const config = invCfg(await seedInvoiceLayout(small.id, structuredClone(INVOICE_DEFAULT_CONFIG), undefined));
    const flowConfig = structuredClone(INVOICE_DEFAULT_CONFIG);

    for (const size of [{ parts: 100 }, { parts: 200 }]) {
      const data = bigInvoice(size);
      const name = `${size.parts} parts, ${data.priceRows.length} operations, 20 surcharges, 20 charges`;
      // The canvas config takes the canvas branch (one pass, no continuation band), the flow's the flow's.
      expect(buildInvoiceDefinition(data, config).continuationHeaderSpec?.overflowTopMargin).toBeUndefined();
      expect(buildInvoiceDefinition(data, flowConfig).continuationHeaderSpec?.overflowTopMargin).toBe(INVOICE_PAGE.overflowTopMargin);
      for (const [kind, c] of [["flow", flowConfig], ["canvas", config]] as const) {
        for (const run of [1, 2]) {
          // Built inside each timed run: pdfmake uses up the nodes it lays out.
          await timed(`${name}; ${kind} build and render ${run}`, () => renderPdf(buildInvoiceDefinition(data, c)),
            (pdf) => `${pageCount(pdf)} page(s)`);
        }
      }
    }

    // The seed on a draft invoice of 100 part lines, three priced operations each.
    const big = await timingDraft(100);
    const read = await readInvoicePdfData(prisma, big.id, await invoicePrintSettings());
    expect(read.parts).toHaveLength(100);
    expect(read.priceRows).toHaveLength(300);
    for (const run of [1, 2]) {
      await timed(`seed on 100 part lines, 300 operations; run ${run}`,
        () => seedInvoiceLayout(big.id, structuredClone(INVOICE_DEFAULT_CONFIG), undefined),
        (layout) => `${layout.items.length} item(s)`);
    }
  }, 600_000);
});
