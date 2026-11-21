import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { Content } from "pdfmake/interfaces";
import {
  buildQuoteDefinition, quoteCanvasItemContent, quoteSeedStyle, QUOTE_FLOW, QUOTE_PAGE, QUOTE_SEED_IDS, QUOTE_WIDTHS,
  type QuotePdfData,
} from "@/server/pdf/quote";
import { QUOTE_CANVAS, QUOTE_CONTRACT, QUOTE_LEAST_WIDTHS, QUOTE_LINES_INDENT } from "@/lib/template-contracts/quote";
import { QUOTE_DEFAULT_CONFIG, type TemplateConfig } from "@/lib/template-contracts/index";
import { CANVAS_GRID, CANVAS_PAGE, CONTINUED_FONT_SIZE, type CanvasItem, type CanvasLayout } from "@/lib/template-contracts/canvas";
import { completeSections } from "@/lib/template-contracts/types";
import { layOutSheetGroups, renderPdf, renderSheetGroupsWithPositions, type LaidOutNode } from "@/server/pdf/render";
import { assembleCanvasSheet, CANVAS_IDS, defaultLabelOf, logoContent, strokeContent, textContent } from "@/server/pdf/canvas-sheet";
import { canvasBlockOf, mark } from "@/server/pdf/canvas-nodes";
import { quoteItemContent } from "@/server/quote-canvas";
import { bandTop, canvasRefusal, continuedBox, leastWidth, pageFoot, tablesByY, topMargin, validateCanvasLayout } from "@/lib/template-canvas";
import { pageCount, paintedImages, runFonts, strokedLines, textLinesWithY, textRunsWithY, TINY_JPEG } from "./helpers/pdf";
import { barcode, layoutOf, logo } from "./helpers/canvas-fixtures";
import { bandClipLayout, expectBandClip } from "./helpers/band-clip";
import { quoteFlowLeastWidths } from "./helpers/quote-flow-widths";
import { resolveLocalModule } from "./helpers/ts-parse";
import { quoteField, quoteLines, richQuote, sampleQuote, standardQuoteLayout, type QuoteTable } from "./helpers/quote-canvas-fixtures";

/**
 * The quotation's canvas (design 2026-11-12; since quote canvas PR 2). The flow exports its widths
 * (`QUOTE_WIDTHS`), its page constants (`QUOTE_PAGE`) and its builders (`QUOTE_FLOW`) with no change to
 * its paper (tests/quote-flow-oracle.test.ts); the profile's least widths (PR 1 literals, whose figures
 * tests/template-contracts.test.ts and tests/canvas-designer.test.ts still assert) are held to those
 * exports here.
 *
 * A BLOCK'S RENDERED TOP is read as the measure reads it (`canvasMeasure`, src/server/canvas-measure.ts):
 * the first block's drawn top (the spacer to the first table ends there), every later block's where
 * the region above it ends (its `CANVAS_IDS.regionEnd` mark). A block's rendered height is its
 * `CANVAS_IDS.end` mark less that top. Its own id (`CANVAS_IDS.table`) is not its top: pdfmake reports
 * a stack where its first laid-out line starts, UNDER that line's own top margin, so no top or height
 * here is read from a block's id.
 */

/** A stand-in logo: the builder places the string it is handed and reads nothing of it. */
const LOGO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("the flow's widths hold the profile (design 2026-11-12 §4.1, §12)", () => {
  const derived = quoteFlowLeastWidths();

  it("names a least width for exactly the three rows blocks (pin)", () => {
    expect(Object.keys(QUOTE_LEAST_WIDTHS)).toEqual(["parties", "lines", "closing"]);
    expect(Object.keys(derived)).toEqual(Object.keys(QUOTE_LEAST_WIDTHS));
  });

  it("the least widths are their derivation from the flow's widths", () => {
    // Red when a width the profile's floor counts moves in QUOTE_WIDTHS (the signature column, say)
    // while the profile's literal stays.
    expect(QUOTE_LEAST_WIDTHS).toEqual(derived);
  });

  it("the lines' grid gap and margin are the flow's: its gap and the information cell's margin (#971 design §6.1)", () => {
    const lines = QUOTE_CANVAS.tables.find((t) => t.key === "lines")!;
    expect([lines.gridGap, lines.gridMargin]).toEqual([QUOTE_WIDTHS.gridGap, QUOTE_WIDTHS.infoIndent]);
  });

  it("the lines' grid indent is the flow's Material and PRICE heading indent past the Quantity column, and its floor holds them (#971, Codex review)", () => {
    const lines = QUOTE_CANVAS.tables.find((t) => t.key === "lines")!;
    expect(lines.gridIndent).toBe(QUOTE_LINES_INDENT);
    // The builder's `lineBlock` indents its Material line and PRICE heading by `ctx.qtyW + W.infoIndent`.
    expect(QUOTE_LINES_INDENT).toEqual({ column: "col_qty", gap: QUOTE_WIDTHS.infoIndent, floor: 0 });
    const headersSet = (layout: CanvasLayout, column: string, change: Partial<Extract<CanvasItem, { kind: "table" }>["columns"][number]>) =>
      layoutOf(layout.items.map((i) => (i.kind === "table" && i.key === "column_header"
        ? { ...i, columns: i.columns.map((c) => (c.key === column ? { ...c, ...change } : c)) } : i)));
    const item = standardQuoteLayout().items.find((i) => i.kind === "table" && i.key === "lines")!;
    // At the contract's columns the grid's columns bind, as before.
    expect(leastWidth(QUOTE_CONTRACT, item, { layout: standardQuoteLayout() })).toBe(QUOTE_LEAST_WIDTHS.lines);
    // With the Quantity column alone shown: its width, the indent and one grid step (52 + 6 + 4.5),
    // where the grid's columns alone ask 52 + 4.5.
    const qtyOnly = ["col_info", "col_each_weight", "col_amount"].reduce((l, c) => headersSet(l, c, { visible: false }), standardQuoteLayout());
    expect(leastWidth(QUOTE_CONTRACT, item, { layout: qtyOnly })).toBe(gridDefault("col_qty") + QUOTE_WIDTHS.infoIndent + CANVAS_GRID);
    expect(leastWidth(QUOTE_CONTRACT, item, { layout: qtyOnly })).toBe(62.5);
    // Typed wider, the floor follows by exactly the difference; every column hidden, 6 + 4.5.
    expect(leastWidth(QUOTE_CONTRACT, item, { layout: headersSet(qtyOnly, "col_qty", { width: 300 }) }))
      .toBe(300 + QUOTE_WIDTHS.infoIndent + CANVAS_GRID);
    expect(leastWidth(QUOTE_CONTRACT, item, { layout: headersSet(qtyOnly, "col_qty", { visible: false }) }))
      .toBe(QUOTE_WIDTHS.infoIndent + CANVAS_GRID);
    // Rule 4 refuses the lines under the figure, naming what it is for, and accepts them there.
    const at = (w: number) => layoutOf(qtyOnly.items.map((i) => (i.kind === "table" && i.key === "lines" ? { ...i, box: { ...i.box, x: 588 - w, w } } : i)));
    expect(canvasRefusal(at(62), QUOTE_CONTRACT, { pageFooter: false })).toEqual({
      itemIds: ["table-lines"],
      sentence: "The Quote lines and prices table is 62 pt wide, less than the 62.5 pt the text it prints past the column headers' quantity column " +
        "and one grid step need.",
    });
    expect(canvasRefusal(at(62.5), QUOTE_CONTRACT, { pageFooter: false })).toBeNull();
  });

  it("QUOTE_FLOW hands on QUOTE_WIDTHS itself (pin)", () => {
    expect(QUOTE_FLOW.widths).toBe(QUOTE_WIDTHS);
  });
});

/** One `columns` node of a definition: its column widths, its gap, its own margin and each column's
 *  margin (null where none is set). */
type ColumnsShape = { widths: unknown[]; gap: unknown; margin: unknown; margins: unknown[] };

/** Every `columns` node of `node`, in pre-order (the statement's walker, tests/statement-canvas.test.ts). */
function columnsShapes(node: unknown, out: ColumnsShape[] = []): ColumnsShape[] {
  if (Array.isArray(node)) {
    for (const child of node) columnsShapes(child, out);
    return out;
  }
  if (node === null || typeof node !== "object") return out;
  const o = node as Record<string, unknown>;
  if (Array.isArray(o.columns)) {
    const cols = o.columns as Record<string, unknown>[];
    out.push({ widths: cols.map((c) => c.width), gap: o.columnGap ?? null, margin: o.margin ?? null, margins: cols.map((c) => c.margin ?? null) });
  }
  for (const value of Object.values(o)) columnsShapes(value, out);
  return out;
}

/** Every canvas line's `x2` under `node` (the signature rule is the quote's only one). */
function lineEnds(node: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const child of node) lineEnds(child, out);
    return out;
  }
  if (node === null || typeof node !== "object") return out;
  const o = node as Record<string, unknown>;
  if (o.type === "line") out.push(o.x2);
  for (const value of Object.values(o)) lineEnds(value, out);
  return out;
}

describe("the flow prints at the widths it exports", () => {
  // A literal left in a flow block reds this as soon as its constant changes (a literal of another
  // value reds it now), where a changed constant read on both sides moves them together. Its blind
  // spot, and the oracle's: a literal of the SAME value as its constant (220 for `quoteFields`) stays
  // green in both; only a different literal reds it (the invoice PR 2 final wave's standing finding 5).
  const W = QUOTE_WIDTHS;
  /** The grid's column widths, the contract's defaults in its order (the Standard stores none). */
  const grid = QUOTE_CONTRACT.sections.find((s) => s.key === "column_header")!.fields
    .map((f) => f.column!.defaultWidth);
  const header = { widths: [W.headerSide, "*", W.headerSide], gap: W.headerGap, margin: [0, 0, 0, 10], margins: [null, null, null] };
  const parties = {
    widths: ["*", W.quoteFields], gap: W.partiesGap, margin: [0, 0, 0, 8], margins: [[W.partiesIndent, 10, 0, 0], null],
  };
  const gridRow = (top: number) => ({
    widths: grid, gap: W.gridGap, margin: [0, top, 0, 0], margins: [null, [W.infoIndent, 0, 0, 0], null, null],
  });
  const closing = { widths: ["*", W.signature], gap: W.closingGap, margin: [0, 18, 0, 0], margins: [null, null] };

  const withLogo = (placement: "header-left" | "header-right"): TemplateConfig => {
    const c = structuredClone(QUOTE_DEFAULT_CONFIG);
    c.logo = { placement, width: 80 };
    return c;
  };
  const withEstimate = (): QuotePdfData => {
    const d = sampleQuote();
    d.lines[0].surcharges = [{ name: "Heat treat surcharge", rateText: "5%", amount: 5.1 }];
    return d;
  };

  it("every columns row of the Standard's content takes its widths, gaps and indents from QUOTE_WIDTHS", () => {
    // Exact and in order: the header, the parties, the line's grid row, its price row, the closing.
    expect(columnsShapes(buildQuoteDefinition(sampleQuote()).content)).toEqual([
      header, parties, gridRow(2), gridRow(4), closing,
    ]);
  });

  it("a header-right logo's header row keeps the header's widths and gap", () => {
    expect(columnsShapes(buildQuoteDefinition(sampleQuote(), withLogo("header-right"), LOGO).content)).toEqual([
      header, parties, gridRow(2), gridRow(4), closing,
    ]);
  });

  it("a quote with one estimate row prints it on the grid's widths, gap and information indent", () => {
    expect(columnsShapes(buildQuoteDefinition(withEstimate()).content)).toEqual([
      header, parties, gridRow(2), gridRow(4), gridRow(4), closing,
    ]);
  });

  it("the signature rule runs the signature column's width", () => {
    expect(lineEnds(buildQuoteDefinition(sampleQuote()).content)).toEqual([W.signature]);
  });

  it("QUOTE_WIDTHS.content is the letter page's width less the flow's own side margins", () => {
    // Red when `content` is retyped (560, say) or when a side margin of the flow's `pageMargins`
    // (pdf/quote.ts) moves while `content` stays: the seed's 208 pt centre column derives from it.
    const def = buildQuoteDefinition(sampleQuote());
    expect(def.pageSize).toBe("LETTER");
    const [left, , right] = def.pageMargins as [number, number, number, number];
    expect(W.content).toBe(CANVAS_PAGE.width - left - right);
  });

  it("the flow's bottom margin and continuation top margin are QUOTE_PAGE's (pin)", () => {
    const def = buildQuoteDefinition(sampleQuote());
    expect((def.pageMargins as number[])[3]).toBe(QUOTE_PAGE.bottomMargin);
    expect(def.continuationHeaderSpec?.overflowTopMargin).toBe(QUOTE_PAGE.overflowTopMargin);
  });
});

describe("the header fields' text QUOTE_FLOW hands on", () => {
  it("the address lines are the company address's non-blank lines, trimmed", () => {
    const d = sampleQuote({ company: { name: "N", address: "  600 Example Street  \n\n \t\nCrystal Lake IL 60014", phone: "" } });
    expect(QUOTE_FLOW.addressLines(d)).toEqual(["600 Example Street", "Crystal Lake IL 60014"]);
  });

  it("the number line is the label, bold with its space, then the number (pin)", () => {
    expect(QUOTE_FLOW.numberText("Quotation Number:", sampleQuote())).toEqual([
      { text: "Quotation Number: ", bold: true }, "1006",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// The field families. `textLinesWithY` and `textRunsWithY` report a baseline from the page's BOTTOM
// edge; a run's x is its start, and `textLinesWithY` collapses a line's spacing.
// ---------------------------------------------------------------------------------------------

const cfg = (over: Partial<TemplateConfig> = {}): TemplateConfig => ({ ...structuredClone(QUOTE_DEFAULT_CONFIG), ...over });

/** The ctx the flow builds from `config` (its own `ctxOf`), so the sections are the config's. */
const ctxFor = (config: TemplateConfig) =>
  QUOTE_FLOW.ctxOf(config, completeSections(QUOTE_CONTRACT, config.sections), null);

/** A sheet of these items alone (no block), rendered. */
async function renderItems(
  items: CanvasItem[], d: QuotePdfData = sampleQuote(), config: TemplateConfig = cfg(), logoDataUri?: string,
): Promise<Buffer> {
  return renderPdf(assembleCanvasSheet({
    layout: layoutOf(items), pageFooter: false, fonts: config.fonts,
    itemContent: quoteItemContent(ctxFor(config), d, QUOTE_FLOW, logoDataUri), tableBlock: () => null,
  }));
}

/** Page 1's printed lines. */
const linesOf = async (pdf: Promise<Buffer>) => textLinesWithY(await pdf)[0].map((l) => l.text).filter((t) => t !== "");

const isBold = (font: string): boolean => font.endsWith("-Medium") || font.endsWith("-Bold");

/** The flow's config with these header fields hidden. */
function hidingHeader(...fields: string[]): TemplateConfig {
  const config = cfg();
  config.sections = completeSections(QUOTE_CONTRACT, config.sections).map((sc) => sc.key !== "header" ? sc : {
    ...sc, fields: sc.fields.map((f) => fields.includes(f.key) ? { ...f, visible: false } : f),
  });
  return config;
}

/** A field item's box: wide enough that no line the cases print wraps. */
const LINE_BOX = { x: 24, y: 100, w: 400, h: 12 };

describe("the quote's field families (design 2026-11-12 §4.2)", () => {
  const d = sampleQuote();

  /**
   * Each header key, the lines its item prints alone, and the flow print they are held to. The flow
   * prints the title, the company block and the number in one columns row, so each line is held WHOLE
   * against the flow's lines with the other header fields hidden, where it prints alone on its
   * baseline: a short or partial text cannot pass by containment.
   */
  const KEYS: { key: string; oracle: () => TemplateConfig; lines: string[] }[] = [
    { key: "title", oracle: () => hidingHeader("company_name", "company_address", "quote_number"), lines: ["Quotation"] },
    { key: "company_name", oracle: () => hidingHeader("title", "company_address", "quote_number"), lines: [d.company.name] },
    {
      key: "company_address", oracle: () => hidingHeader("title", "company_name", "quote_number"),
      lines: ["600 Example Street", "Crystal Lake IL 60014"],
    },
    { key: "quote_number", oracle: () => hidingHeader("title", "company_name", "company_address"), lines: ["Quotation Number: 1006"] },
  ];

  it("the four keys are the contract's field keys less the profile's notFields and the column headers' columns (pin)", () => {
    const columns = QUOTE_CONTRACT.sections.find((s) => s.key === "column_header")!.fields.map((f) => f.key);
    const placeable = QUOTE_CONTRACT.sections.flatMap((s) => s.fields.map((f) => f.key))
      .filter((key) => !QUOTE_CANVAS.notFields.includes(key) && !columns.includes(key));
    expect(KEYS.map((k) => k.key).sort()).toEqual([...placeable].sort());
  });

  it.each(KEYS)("$key prints the flow's text for its key, line by line, whole", async ({ key, oracle, lines }) => {
    // Red when a key's arm answers nothing or another key's text (the default arm printing, say).
    const flow = await linesOf(renderPdf(buildQuoteDefinition(d, oracle())));
    const printed = await linesOf(renderItems([quoteField(key, { box: { ...LINE_BOX, h: 30 } })]));
    expect(printed).toEqual(lines);
    // The flow's header lines come first, in order, before the parties.
    expect(flow.slice(0, lines.length)).toEqual(lines);
  });

  it("a typed title prints in place of \"Quotation\", and a typed number label prints with its one-space glue", async () => {
    // Red when the item's typed label is ignored (the contract's default printed instead).
    const items = [
      quoteField("title", { label: "Price Quotation", box: { ...LINE_BOX, h: 24 } }),
      quoteField("quote_number", { label: "Quote No.", box: { ...LINE_BOX, y: 200 } }),
    ];
    expect(await linesOf(renderItems(items))).toEqual(["Price Quotation", "Quote No. 1006"]);
  });

  it("the number's label is bold whatever the item's bold, the number takes the item's, both at the item's size", async () => {
    // Red when the label run follows the item's bold (the 12 pt regular item) or the number ignores it
    // (the 12 pt bold item), or when the item's size is dropped.
    for (const bold of [true, false]) {
      const runs = runFonts(await renderItems([quoteField("quote_number", {
        box: { ...LINE_BOX }, style: { size: 12, bold, align: "left" },
      })]));
      expect(runs.map((r) => r.text).join(" ").replace(/\s+/g, " ").trim()).toBe("Quotation Number: 1006");
      // A run is the label's while the runs so far, joined, are still a prefix of the label (by
      // position, never by substring).
      const LABEL = "Quotation Number:";
      let sofar = "";
      let labelRuns = 0;
      let valueRuns = 0;
      for (const r of runs) {
        expect(r.size).toBe(12);
        sofar = `${sofar} ${r.text}`.replace(/\s+/g, " ").trim();
        const inLabel = LABEL.startsWith(sofar);
        if (inLabel) labelRuns++;
        else valueRuns++;
        expect(isBold(r.font), `${r.text} bold`).toBe(inLabel ? true : bold);
      }
      expect(labelRuns).toBeGreaterThan(0);
      expect(valueRuns).toBeGreaterThan(0);
    }
  });

  it("the company name prints at the item's size and weight, aligned left, centred and right in one box", async () => {
    // Red when the item's alignment is dropped (every run at the box's left: the right one no longer
    // lies right of the left) or its size or weight is. No reader gives a run's width, so the right
    // edge is read by symmetry: right − centre = centre − left for one text in one box.
    const box = { x: 24, y: 100, w: 500, h: 18 };
    const at = (id: string, y: number, align: "left" | "center" | "right") =>
      quoteField("company_name", { id, box: { ...box, y }, style: { size: 15, bold: true, align } });
    const runs = runFonts(await renderItems([at("left", 100, "left"), at("centre", 140, "center"), at("right", 180, "right")]));
    for (const r of runs) {
      expect(r.size).toBe(15);
      expect(isBold(r.font)).toBe(true);
    }
    // The three lines, top to bottom (a baseline from the page's bottom: the highest y is the top).
    const ys = [...new Set(runs.map((r) => Math.round(r.y * 2) / 2))].sort((a, b) => b - a);
    expect(ys).toHaveLength(3);
    const startOf = (y: number) => Math.min(...runs.filter((r) => Math.round(r.y * 2) / 2 === y).map((r) => r.x));
    const [left, centre, right] = ys.map(startOf);
    expect(Math.abs(left - box.x)).toBeLessThanOrEqual(0.5);
    expect(right - left).toBeGreaterThan(100);
    expect(Math.abs((right - centre) - (centre - left))).toBeLessThanOrEqual(0.5);
  });

  it("the company address prints its non-blank lines trimmed, one line each, at the item's size", async () => {
    // Red when the address prints `d.company.address` raw: its blank lines open gaps between the two
    // lines and its padding moves them off the box's left. Literals, never the flow's own helper,
    // which the canvas shares.
    const padded = sampleQuote({ company: { ...d.company, address: "  600 Example Street \n\n   \nCrystal Lake IL 60014" } });
    const clean = sampleQuote({ company: { ...d.company, address: "600 Example Street\nCrystal Lake IL 60014" } });
    const item = quoteField("company_address", { box: { ...LINE_BOX, h: 30 }, style: { size: 10, bold: false, align: "left" } });
    expect(await linesOf(renderItems([item], padded))).toEqual(["600 Example Street", "Crystal Lake IL 60014"]);
    const runsOf = async (data: QuotePdfData) => textRunsWithY(await renderItems([item], data))[0];
    const [p, c] = [await runsOf(padded), await runsOf(clean)];
    const ys = (runs: { y: number }[]) => [...new Set(runs.map((r) => r.y))].sort((a, b) => b - a);
    expect(ys(p)).toHaveLength(2);
    expect(ys(p)).toEqual(ys(c));
    // Each line starts at the box's left (a line's first run; a run is a word or a span).
    for (const y of ys(p)) {
      expect(Math.abs(Math.min(...p.filter((r) => r.y === y).map((r) => r.x)) - LINE_BOX.x)).toBeLessThanOrEqual(0.5);
    }
    for (const r of runFonts(await renderItems([item], padded))) expect(r.size).toBe(10);
  });

  it("a bill_to, a surcharge_estimate and a col_qty field item and a barcode print nothing beside a title that prints", async () => {
    // Red when the default arm prints (the item's label, say). The title is the control: the sheet
    // prints, and only the title.
    const nothing: CanvasItem[] = [
      quoteField("bill_to", { box: { ...LINE_BOX, y: 140 } }),
      quoteField("surcharge_estimate", { box: { ...LINE_BOX, y: 180 } }),
      quoteField("col_qty", { box: { ...LINE_BOX, y: 220 } }),
      barcode({ box: { x: 24, y: 260, w: 186, h: 44 } }),
    ];
    const content = quoteItemContent(ctxFor(cfg()), d, QUOTE_FLOW);
    for (const item of nothing) expect(content(item), item.kind === "field" ? item.key : item.kind).toBeNull();
    expect(await linesOf(renderItems([quoteField("title", { box: { ...LINE_BOX, h: 24 } }), ...nothing]))).toEqual(["Quotation"]);
  });

  it("a text, a logo, a line and a box route to the shared helpers", () => {
    // Red when an arm routes to nothing (the text arm answering null, say).
    const uri = `data:image/jpeg;base64,${TINY_JPEG.toString("base64")}`;
    const content = quoteItemContent(ctxFor(cfg()), d, QUOTE_FLOW, uri);
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
    expect(quoteItemContent(ctxFor(cfg()), d, QUOTE_FLOW)(pic)).toBeNull();
    expect(content(line)).toEqual(strokeContent(line as Parameters<typeof strokeContent>[0]));
    expect(content(box)).toEqual(strokeContent(box as Parameters<typeof strokeContent>[0]));
  });
});

// ---------------------------------------------------------------------------------------------
// A canvas quote (design 2026-11-12 §4.4, §5.2): `buildQuoteDefinition` branching on
// `config.layout`, its six blocks in the one canvas block shape, the liability keeping its 10 pt top
// margin, the lens (the column headers' section is the grid the lines print under) and the page line's
// "Page:" label. Configs are built as `{ ...QUOTE_DEFAULT_CONFIG, layout }` and layouts judged by
// `validateCanvasLayout` (no quote layout went through `validateConfig` while the quote stood outside
// CANVAS_PRINTS; the same PR later put it in, and the registry's cases are tests/template-canvas.test.ts's).
// The quote's contract defaults `pageFooter` TRUE, so every case sets it.
// ---------------------------------------------------------------------------------------------

const PAGE_HEIGHT = CANVAS_PAGE.height;
const BLOCKS: QuoteTable[] = ["parties", "intro", "column_header", "lines", "closing", "liability"];
type TableItem = Extract<CanvasItem, { kind: "table" }>;
type Group = { positions: LaidOutNode[] };
/** Mark-to-mark positions (the Global Constraints). */
const MARK_TOL = 0.01;
/** Flow against canvas, and a run against a drawn edge (the Global Constraints). */
const RUN_TOL = 0.5;

/** The Standard's config carrying `layout`, its page line OFF unless `over` turns it on. */
const quoteCfg = (layout: CanvasLayout | null, over: Partial<TemplateConfig> = {}): TemplateConfig =>
  ({ ...structuredClone(QUOTE_DEFAULT_CONFIG), pageFooter: false, ...over, layout });

async function renderQuote(d: QuotePdfData, config: TemplateConfig, logoDataUri?: string) {
  const def = buildQuoteDefinition(d, config, logoDataUri);
  const { pdf, groups } = await renderSheetGroupsWithPositions([def]);
  return { pdf, def, group: groups[0] };
}

/** The laid-out node under an id, which the case requires. */
function at(group: Group, id: string): LaidOutNode {
  const found = group.positions.find((node) => node.id === id);
  if (found === undefined) throw new Error(`no laid-out node "${id}"`);
  return found;
}

const tableOf = (layout: CanvasLayout, key: QuoteTable): TableItem =>
  layout.items.find((item): item is TableItem => item.kind === "table" && item.key === key)!;
const blockBox = (layout: CanvasLayout, key: QuoteTable) => tableOf(layout, key).box;

/** A layout's block, replaced. */
function withTable(layout: CanvasLayout, key: QuoteTable, change: (item: TableItem) => TableItem): CanvasLayout {
  return layoutOf(layout.items.map((item) => (item.kind === "table" && item.key === key ? change(item) : item)));
}

/** A layout's block drawn `inset` pt in on each side. */
const inset = (layout: CanvasLayout, key: QuoteTable, by: number): CanvasLayout =>
  withTable(layout, key, (item) => ({ ...item, box: { ...item.box, x: item.box.x + by, w: item.box.w - 2 * by } }));

/** The block before `key` in the layout's drawn order (null for the first). */
function above(layout: CanvasLayout, key: QuoteTable): QuoteTable | null {
  const tables = tablesByY(layout);
  const i = tables.findIndex((t) => t.key === key);
  return i <= 0 ? null : (tables[i - 1].key as QuoteTable);
}

/** A block's rendered top (the header's rule). */
function blockTop(group: Group, layout: CanvasLayout, key: QuoteTable): number {
  const prev = above(layout, key);
  return prev === null ? blockBox(layout, key).y : at(group, CANVAS_IDS.regionEnd(prev)).top;
}
/** A block's rendered height: its end mark less its rendered top. */
const blockHeight = (group: Group, layout: CanvasLayout, key: QuoteTable): number =>
  at(group, CANVAS_IDS.end(key)).top - blockTop(group, layout, key);

/** The drawn distance between a block and the block above it. */
function drawnGap(layout: CanvasLayout, key: QuoteTable): number {
  const a = blockBox(layout, above(layout, key)!);
  return blockBox(layout, key).y - a.y - a.h;
}

/** Every node of a definition, depth first. */
function nodesOf(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) { for (const n of node) nodesOf(n, out); return out; }
  out.push(node as Record<string, unknown>);
  for (const value of Object.values(node as Record<string, unknown>)) nodesOf(value, out);
  return out;
}

/** The height `nodes` lay out at ALONE, in a column `w` wide, between two marks, `{ stack: [mark(a),
 *  ...nodes, mark(b)] }` (a JSON copy: pdfmake uses up a node it lays out), in the Standard's face. */
async function aloneHeight(nodes: Content[], w: number): Promise<number> {
  const config = QUOTE_DEFAULT_CONFIG;
  const [laid] = await layOutSheetGroups([{
    pageSize: "LETTER", pageMargins: [CANVAS_PAGE.margin, CANVAS_PAGE.margin, CANVAS_PAGE.width - CANVAS_PAGE.margin - w, CANVAS_PAGE.margin],
    defaultStyle: { font: config.fonts.family, fontSize: config.fonts.baseSize },
    content: [{ stack: [mark("alone:a"), ...(JSON.parse(JSON.stringify(nodes)) as Content[]), mark("alone:b")] }],
  }]);
  const top = (id: string) => {
    const node = laid.find((n) => n.id === id);
    if (node === undefined) throw new Error(`no mark "${id}"`);
    expect(node.page).toBe(1);
    return node.top;
  };
  return top("alone:b") - top("alone:a");
}

/** A flow node's margin as [left, top, right, bottom]; the node with its vertical margins zeroed (the
 *  one-node arm), or only its bottom (the liability's arm). */
const marginOf = (node: Content): number[] => {
  const m = (node as { margin?: number | number[] }).margin;
  return m === undefined ? [0, 0, 0, 0] : typeof m === "number" ? [m, m, m, m] : m.length === 2 ? [m[0], m[1], m[0], m[1]] : m;
};
const verticalsZeroed = (node: Content): Content => {
  const [l, , r] = marginOf(node);
  return { ...(node as object), margin: [l, 0, r, 0] } as Content;
};
const bottomZeroed = (node: Content): Content => {
  const [l, t, r] = marginOf(node);
  return { ...(node as object), margin: [l, t, r, 0] } as Content;
};

/** A text run with its baseline read top-down. */
type Run = { text: string; x: number; top: number };
const rawRuns = (pdf: Buffer, page = 1): Run[] =>
  textRunsWithY(pdf)[page - 1].map((r) => ({ text: r.text, x: r.x, top: PAGE_HEIGHT - r.y }));

/** Page 1's runs whose baseline lies inside a block: under its rendered top, above its end mark. */
function runsInBlock(pdf: Buffer, group: Group, layout: CanvasLayout, key: QuoteTable): Run[] {
  const top = blockTop(group, layout, key);
  const end = at(group, CANVAS_IDS.end(key)).top;
  return rawRuns(pdf).filter((r) => r.text.trim() !== "" && r.top > top && r.top < end);
}

/** The x of page 1's runs starting with `needle`, top to bottom. */
const xsOf = (pdf: Buffer, needle: string): number[] =>
  rawRuns(pdf).filter((r) => r.text.trim().startsWith(needle)).sort((a, b) => a.top - b.top).map((r) => r.x);

/** Page `page`'s printed lines' text (`textLinesWithY` groups a line's word runs for its text alone). */
const lineTexts = (pdf: Buffer, page = 1): string[] => textLinesWithY(pdf)[page - 1].map((line) => line.text);

/** The flow's ctx over the Standard's config. */
const standardCtx = () => ctxFor(QUOTE_DEFAULT_CONFIG);
/** The contract's default width of a grid column (a number for the three fixed ones). */
const gridDefault = (key: string): number => {
  const width = QUOTE_CONTRACT.sections.find((s) => s.key === "column_header")!.fields.find((f) => f.key === key)!.column!.defaultWidth;
  if (typeof width !== "number") throw new Error(`${key} has no fixed default width`);
  return width;
};
const withEstimate = (): QuotePdfData => {
  const d = sampleQuote();
  d.lines[0].surcharges = [{ name: "Heat treat surcharge", rateText: "5%", amount: 5.1 }];
  return d;
};

describe("a canvas quote (design 2026-11-12 §4.4, §5.2)", () => {
  const layout = standardQuoteLayout();

  it("the standard layout passes the canvas rules, the page line off and on (pin)", () => {
    for (const pageFooter of [false, true]) {
      expect(() => validateCanvasLayout(layout, QUOTE_CONTRACT, { pageFooter }), String(pageFooter)).not.toThrow();
    }
    expect(tablesByY(layout).map((t) => t.key)).toEqual(BLOCKS);
  });

  it("prints its six blocks once each on page 1, the first at its drawn top and each later one riding the block above it by the drawn distance", async () => {
    // Red with no branch (a layout prints the flow: no canvas id at all), and when a one-node block
    // keeps its vertical margins (the parties' height). A block left unwrapped by its drawn place prints
    // the same full-width paper, so this case stays green under that mutant; the shape pin below reds.
    // The first block's top is witnessed by its height: its end mark less its drawn top is its flow
    // node laid out alone (never its own id's top, which the parties' columns report under a child's
    // margin).
    const d = sampleQuote();
    const { def, group } = await renderQuote(d, quoteCfg(layout));
    const nodes = nodesOf(def);
    for (const key of BLOCKS) {
      expect(nodes.filter((n) => n.id === CANVAS_IDS.table(key)), key).toHaveLength(1);
      expect(at(group, CANVAS_IDS.table(key)).page, key).toBe(1);
      expect(at(group, CANVAS_IDS.end(key)).page, key).toBe(1);
    }
    const parties = await aloneHeight([verticalsZeroed(QUOTE_FLOW.partiesBlock(standardCtx(), d)[0])], blockBox(layout, "parties").w);
    expect(Math.abs(at(group, CANVAS_IDS.end("parties")).top - parties - blockBox(layout, "parties").y)).toBeLessThanOrEqual(MARK_TOL);
    for (const key of BLOCKS.slice(1)) {
      const prev = above(layout, key)!;
      expect(Math.abs(blockTop(group, layout, key) - (at(group, CANVAS_IDS.end(prev)).top + drawnGap(layout, key))), key)
        .toBeLessThanOrEqual(MARK_TOL);
    }
  });

  it("the canvas definition is pure JSON, carries no overflow margin and no id on a text node; a null layout's carries no canvas id", () => {
    // Red when a block puts an id on a flow text node (the intro's, mutated), and with no branch (no
    // canvas id at all, and the flow's overflow margin).
    const def = buildQuoteDefinition(sampleQuote(), quoteCfg(layout));
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
    expect(def.continuationHeaderSpec).not.toHaveProperty("overflowTopMargin");
    expect(nodesOf(def).filter((n) => "text" in n && "id" in n)).toEqual([]);
    const flow = buildQuoteDefinition(sampleQuote(), quoteCfg(null));
    expect(JSON.stringify(flow)).not.toContain('"canvas:');
    expect(JSON.stringify(def)).toContain('"canvas:');
  });

  it("every block is the one canvas block shape: a fixed column at the drawn width, its wrapper's margin zero", () => {
    // #969's finding 6: a margin's place shows on no full-width paper. Red when `tableBlock` answers a
    // bare stack carrying the id (no `drawnBlock`). At full width the lateral margin is 0, so this pin
    // stays green when that margin sits on the wrapper (`blockAt`'s margin moved to its outer stack):
    // the narrowed turns below, which repeat it at 40 pt in, alone witness the margin's place.
    const def = buildQuoteDefinition(sampleQuote(), quoteCfg(layout));
    const CONTENT = CANVAS_PAGE.width - 2 * CANVAS_PAGE.margin;
    for (const key of BLOCKS) {
      const node = nodesOf(def).find((n) => n.id === CANVAS_IDS.table(key))!;
      const box = blockBox(layout, key);
      const left = box.x - CANVAS_PAGE.margin;
      const right = CANVAS_PAGE.width - CANVAS_PAGE.margin - box.x - box.w;
      const shape = canvasBlockOf(node);
      expect(shape, key).not.toBeNull();
      expect(typeof shape!.width, key).toBe("number");
      expect(shape!.width, key).toBe(CONTENT - (left + right));
      expect(node.margin, key).toEqual([0, 0, 0, 0]);
      expect(shape!.items, key).not.toBeNull();
    }
  });

  it("quote-canvas.ts imports nothing from ./db and only types from pdf/quote.ts", () => {
    // Open question 7's structural proof that the canvas adds no read: the canvas module reaches no
    // database module, and the flow's values arrive through QUOTE_FLOW alone (no import cycle).
    const FILE = "src/server/quote-canvas.ts";
    const sf = ts.createSourceFile(FILE, readFileSync(FILE, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const all: string[] = [];
    const values: string[] = [];
    const bringsValue = (clause: ts.ImportClause | undefined): boolean => {
      if (!clause) return true;
      if (clause.isTypeOnly) return false;
      if (clause.name) return true;
      const bindings = clause.namedBindings;
      if (!bindings) return true;
      if (ts.isNamespaceImport(bindings)) return true;
      return bindings.elements.some((el) => !el.isTypeOnly);
    };
    sf.forEachChild((node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        all.push(node.moduleSpecifier.text);
        if (bringsValue(node.importClause)) values.push(node.moduleSpecifier.text);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        all.push(node.moduleSpecifier.text);
        if (!node.isTypeOnly) values.push(node.moduleSpecifier.text);
      }
    });
    const resolved = (specs: string[]) => specs.map((spec) => resolveLocalModule(process.cwd(), FILE, spec));
    // Not vacuous: the file does import pdf/quote.ts (its types).
    expect(resolved(all)).toContain("src/server/pdf/quote.ts");
    expect(resolved(all)).not.toContain("src/server/db.ts");
    expect(resolved(values)).not.toContain("src/server/pdf/quote.ts");
    expect(readFileSync(FILE, "utf8")).not.toMatch(/\bimport\s*\(/);
  });

  describe("a narrowed block", () => {
    const d = sampleQuote();
    const CONTENT = CANVAS_PAGE.width - 2 * CANVAS_PAGE.margin;

    it.each(BLOCKS)("the %s block drawn 40 pt in on each side prints inside its drawn edges, 40 pt in from the full-width print", async (key) => {
      // Red when `tableBlock` answers no `drawnBlock` (the block prints from x 24 at the page's width:
      // its leftmost run no longer moves 40 pt), and, through the shape assertions, when the lateral
      // margin sits on the wrapper. The liability's turn prints typed wording (sampleQuote's).
      const narrowed = inset(layout, key, 40);
      for (const pageFooter of [false, true]) {
        expect(() => validateCanvasLayout(narrowed, QUOTE_CONTRACT, { pageFooter }), String(pageFooter)).not.toThrow();
      }
      const box = blockBox(narrowed, key);
      const full = await renderQuote(d, quoteCfg(layout));
      const narrow = await renderQuote(d, quoteCfg(narrowed));
      const fullRuns = runsInBlock(full.pdf, full.group, layout, key);
      const runs = runsInBlock(narrow.pdf, narrow.group, narrowed, key);
      expect(runs.length, "the block prints").toBeGreaterThan(0);
      for (const r of runs) {
        expect(r.x, r.text).toBeGreaterThanOrEqual(box.x - RUN_TOL);
        expect(r.x, r.text).toBeLessThanOrEqual(box.x + box.w + RUN_TOL);
      }
      const leftmost = (rs: Run[]) => Math.min(...rs.map((r) => r.x));
      expect(Math.abs(leftmost(runs) - (leftmost(fullRuns) + 40))).toBeLessThanOrEqual(RUN_TOL);
      // The shape at 40 pt in: the lateral margin on the columns node, the wrapper's zero. Read off a
      // fresh definition: a render lays out the definition it is handed.
      const node = nodesOf(buildQuoteDefinition(d, quoteCfg(narrowed))).find((n) => n.id === CANVAS_IDS.table(key))!;
      const shape = canvasBlockOf(node);
      expect(shape).not.toBeNull();
      expect(node.margin).toEqual([0, 0, 0, 0]);
      expect(shape!.left).toBe(40);
      expect(shape!.right).toBe(40);
      expect(shape!.width).toBe(CONTENT - 80);
    }, 60_000);

    it("the narrowed lines block prints its amounts 40 pt left of the full-width print's, and its Material line and PRICE heading at x + qtyW + infoIndent", async () => {
      // Red when the block prints at the page's width (no `drawnBlock`): the amounts stay where they
      // were. The amounts are right-aligned in the grid's last fixed column, so the block's right edge
      // moving 40 pt in moves them 40 pt.
      const narrowed = inset(layout, "lines", 40);
      const box = blockBox(narrowed, "lines");
      const full = (await renderQuote(d, quoteCfg(layout))).pdf;
      const narrow = (await renderQuote(d, quoteCfg(narrowed))).pdf;
      const amount = QUOTE_FLOW.ctxOf(QUOTE_DEFAULT_CONFIG, completeSections(QUOTE_CONTRACT, QUOTE_DEFAULT_CONFIG.sections), null)
        .money(d.lines[0].prices[0].amount!);
      expect(xsOf(full, amount)).toHaveLength(1);
      expect(Math.abs(xsOf(narrow, amount)[0] - (xsOf(full, amount)[0] - 40))).toBeLessThanOrEqual(RUN_TOL);
      const indent = box.x + gridDefault("col_qty") + QUOTE_WIDTHS.infoIndent;
      for (const needle of ["Material:", "PRICE"]) {
        expect(xsOf(narrow, needle), needle).toHaveLength(1);
        expect(Math.abs(xsOf(narrow, needle)[0] - indent), needle).toBeLessThanOrEqual(RUN_TOL);
      }
    }, 60_000);

    it("the narrowed column headers' box strokes run from the block's x to its right edge", async () => {
      // Red when the strip prints at the page's width (no `drawnBlock`). The boxed layout strokes each
      // cell's top and bottom apart and each column edge as a vertical rule 0.8 wide, so the strip's
      // outer edges are the leftmost and rightmost inked x: a rule's ends, a vertical's centre less
      // and plus half its width.
      const narrowed = inset(layout, "column_header", 40);
      const box = blockBox(narrowed, "column_header");
      const { pdf, group } = await renderQuote(d, quoteCfg(narrowed));
      const top = blockTop(group, narrowed, "column_header");
      const end = at(group, CANVAS_IDS.end("column_header")).top;
      const strip = strokedLines(pdf)[0].filter((s) => Math.min(s.y1, s.y2) >= top - 1 && Math.max(s.y1, s.y2) <= end + 1);
      expect(strip.filter((s) => s.y1 === s.y2).length).toBeGreaterThanOrEqual(2);
      expect(strip.filter((s) => s.x1 === s.x2).length).toBeGreaterThanOrEqual(2);
      const edges = strip.map((s) => (s.y1 === s.y2
        ? [Math.min(s.x1, s.x2), Math.max(s.x1, s.x2)] : [s.x1 - s.width / 2, s.x1 + s.width / 2]));
      expect(Math.abs(Math.min(...edges.map((e) => e[0])) - box.x)).toBeLessThanOrEqual(RUN_TOL);
      expect(Math.abs(Math.max(...edges.map((e) => e[1])) - (box.x + box.w))).toBeLessThanOrEqual(RUN_TOL);
    }, 60_000);
  });

  it.each(["parties", "intro", "column_header", "closing"] as const)(
    "the %s block prints its flow node with its vertical margins zeroed", async (key) => {
      // Red when a one-node block keeps its margins (the parties' 8 pt below, the intro's 2 and 4, the
      // strip's 4 below, the closing's 18 above).
      const d = sampleQuote();
      const ctx = standardCtx();
      const node = key === "parties" ? QUOTE_FLOW.partiesBlock(ctx, d)[0]
        : key === "intro" ? QUOTE_FLOW.introBlock(d)[0]
          : key === "column_header" ? QUOTE_FLOW.columnHeaderStrip(ctx)[0] : QUOTE_FLOW.closingBlock(ctx, d)[0];
      const [, top, , bottom] = marginOf(node);
      expect(top + bottom).toBeGreaterThan(0);
      const expected = await aloneHeight([verticalsZeroed(node)], blockBox(layout, key).w);
      const { group } = await renderQuote(d, quoteCfg(layout));
      expect(Math.abs(blockHeight(group, layout, key) - expected)).toBeLessThanOrEqual(MARK_TOL);
    }, 60_000);

  it.each([["sampleQuote", sampleQuote], ["a quote with an estimate row", withEstimate]] as const)(
    "the lines block prints every flow node with every margin kept (%s)", async (_name, data) => {
      // Red when the lines block's nodes pass through `withoutVerticalMargins` (its first grid row's 2
      // pt, the Material line's 6, the PRICE heading's 8 and 2, each price and estimate row's 4 lost).
      const d = data();
      const nodes = QUOTE_FLOW.linesBlock(standardCtx(), d);
      expect(nodes.length).toBeGreaterThan(1);
      const expected = await aloneHeight(nodes, blockBox(layout, "lines").w);
      const zeroed = await aloneHeight(nodes.map(verticalsZeroed), blockBox(layout, "lines").w);
      expect(expected - zeroed).toBeGreaterThan(10);
      const { group } = await renderQuote(d, quoteCfg(layout));
      expect(Math.abs(blockHeight(group, layout, "lines") - expected)).toBeLessThanOrEqual(MARK_TOL);
    }, 60_000);

  describe("the liability", () => {
    it("with typed wording it prints the flow's node with its 10 pt top margin kept, exactly 10 pt taller than the node with it zeroed", async () => {
      // Red when `blockChildren` zeroes the liability's top margin, and when the liability is folded
      // into the one-node arm.
      const d = sampleQuote();
      expect(d.liabilityText).not.toBe("");
      const node = QUOTE_FLOW.liabilityBlock(d)[0];
      expect(marginOf(node)[1]).toBe(10);
      const w = blockBox(layout, "liability").w;
      const kept = await aloneHeight([bottomZeroed(node)], w);
      const zeroed = await aloneHeight([verticalsZeroed(node)], w);
      expect(Math.abs(kept - zeroed - 10)).toBeLessThanOrEqual(MARK_TOL);
      const { group } = await renderQuote(d, quoteCfg(layout));
      expect(Math.abs(blockHeight(group, layout, "liability") - kept)).toBeLessThanOrEqual(MARK_TOL);
    }, 60_000);

    it("drawn touching the closing, its line's node starts 10 pt under the closing's end", async () => {
      // Red when the liability's top margin is zeroed (its node then starts at the closing's end).
      // Drawn touching is legal: rule 5 refuses only a block drawn above the bottom of the one before.
      // No text node carries an id, so the node's top is the block's end mark less the node laid out
      // alone with its margins zeroed (the statement's finance-block technique).
      const d = sampleQuote();
      const closing = blockBox(layout, "closing");
      const touching = withTable(layout, "liability", (item) => ({ ...item, box: { ...item.box, y: closing.y + closing.h } }));
      for (const pageFooter of [false, true]) {
        expect(() => validateCanvasLayout(touching, QUOTE_CONTRACT, { pageFooter }), String(pageFooter)).not.toThrow();
      }
      expect(drawnGap(touching, "liability")).toBe(0);
      const zeroed = await aloneHeight([verticalsZeroed(QUOTE_FLOW.liabilityBlock(d)[0])], blockBox(touching, "liability").w);
      const { group } = await renderQuote(d, quoteCfg(touching));
      const nodeTop = at(group, CANVAS_IDS.end("liability")).top - zeroed;
      expect(Math.abs(nodeTop - at(group, CANVAS_IDS.end("closing")).top - 10)).toBeLessThanOrEqual(MARK_TOL);
    }, 60_000);

    it("with blank wording it prints nothing: its height 0, no block node, and no run after the closing", async () => {
      // Red when the liability arm answers a kept-margin empty node on blank wording
      // (`[{ text: "", margin: [0, 10, 0, 0] }]`): the block then takes 10 pt and more.
      const d = sampleQuote({ liabilityText: "" });
      const { pdf, def, group } = await renderQuote(d, quoteCfg(layout));
      expect(nodesOf(def).filter((n) => n.id === CANVAS_IDS.table("liability"))).toEqual([]);
      expect(Math.abs(blockHeight(group, layout, "liability"))).toBeLessThanOrEqual(MARK_TOL);
      const closingEnd = at(group, CANVAS_IDS.end("closing")).top;
      expect(rawRuns(pdf).filter((r) => r.text.trim() !== "" && r.top > closingEnd)).toEqual([]);
      // Not vacuous: the closing prints above its end.
      expect(rawRuns(pdf).some((r) => r.text.includes("Ending") && r.top < closingEnd)).toBe(true);
    }, 60_000);
  });

  describe("the page line", () => {
    it("with the page line on, the last page prints \"Page: 1 of 1\"; off, no line starting \"Page\" prints", async () => {
      // Red when `buildCanvasQuoteDefinition` answers the sheet without the "Page:" label (it then
      // prints "Page 1 of 1").
      const on = (await renderQuote(sampleQuote(), quoteCfg(layout, { pageFooter: true }))).pdf;
      expect(lineTexts(on).filter((t) => t === "Page: 1 of 1")).toHaveLength(1);
      expect(lineTexts(on).filter((t) => /^Page/.test(t))).toEqual(["Page: 1 of 1"]);
      const off = (await renderQuote(sampleQuote(), quoteCfg(layout, { pageFooter: false }))).pdf;
      expect(lineTexts(off).filter((t) => /^Page/.test(t))).toEqual([]);
    }, 60_000);
  });

  describe("the lens: the lines print under the grid the column headers block draws", () => {
    const d = sampleQuote();

    it("a column headers item whose col_qty is 80 wide moves the Material line right by its width less the contract's", async () => {
      // Red when `canvasCtx` builds the grid from the contract's columns instead of `gridOf` (the
      // item's own columns).
      const wide = withTable(layout, "column_header", (item) => ({
        ...item, columns: item.columns.map((c) => (c.key === "col_qty" ? { ...c, width: 80 } : c)),
      }));
      for (const pageFooter of [false, true]) {
        expect(() => validateCanvasLayout(wide, QUOTE_CONTRACT, { pageFooter }), String(pageFooter)).not.toThrow();
      }
      const standard = (await renderQuote(d, quoteCfg(layout))).pdf;
      const moved = (await renderQuote(d, quoteCfg(wide))).pdf;
      expect(xsOf(moved, "Material:")).toHaveLength(1);
      expect(Math.abs(xsOf(moved, "Material:")[0] - xsOf(standard, "Material:")[0] - (80 - gridDefault("col_qty"))))
        .toBeLessThanOrEqual(RUN_TOL);
    }, 60_000);

    it("with no column headers item placed, the lines print under the contract's grid (pin)", async () => {
      // A pin of the fallback (`gridOf` answering the contract's columns when no item is placed): the
      // lines re-anchored below the intro. No mutation of the canvas module reds it: the flow prints its
      // Material line at the same x, and the grid read from the contract is the same grid here.
      const without = layoutOf(layout.items
        .filter((item) => !(item.kind === "table" && item.key === "column_header"))
        .map((item) => (item.kind === "table" && item.key === "lines" ? { ...item, anchor: { kind: "below-table" as const, table: "intro" } } : item)));
      for (const pageFooter of [false, true]) {
        expect(() => validateCanvasLayout(without, QUOTE_CONTRACT, { pageFooter }), String(pageFooter)).not.toThrow();
      }
      const pdf = (await renderQuote(d, quoteCfg(without))).pdf;
      expect(xsOf(pdf, "Material:")).toHaveLength(1);
      expect(Math.abs(xsOf(pdf, "Material:")[0] - (blockBox(without, "lines").x + gridDefault("col_qty") + QUOTE_WIDTHS.infoIndent)))
        .toBeLessThanOrEqual(RUN_TOL);
    }, 60_000);

    it("a placed column headers item whose col_qty is hidden prints no Quantity cell and the Material line at the flow's x", async () => {
      // Red when `canvasCtx` drops the grid columns' `visible` (every column shown: the quantity
      // prints and the Material line indents past a 52 pt column).
      const hidden = withTable(layout, "column_header", (item) => ({
        ...item, columns: item.columns.map((c) => (c.key === "col_qty" ? { ...c, visible: false } : c)),
      }));
      for (const pageFooter of [false, true]) {
        expect(() => validateCanvasLayout(hidden, QUOTE_CONTRACT, { pageFooter }), String(pageFooter)).not.toThrow();
      }
      const flowConfig = quoteCfg(null);
      flowConfig.sections = completeSections(QUOTE_CONTRACT, flowConfig.sections).map((sc) => sc.key !== "column_header" ? sc : {
        ...sc, fields: sc.fields.map((f) => (f.key === "col_qty" ? { ...f, visible: false } : f)),
      });
      const flow = (await renderQuote(d, flowConfig)).pdf;
      const canvas = (await renderQuote(d, quoteCfg(hidden))).pdf;
      const standard = (await renderQuote(d, quoteCfg(layout))).pdf;
      const QTY = String(d.lines[0].quotedQty);
      // Not vacuous: the standard canvas prints the quantity.
      expect(rawRuns(standard).filter((r) => r.text.trim() === QTY)).toHaveLength(1);
      expect(rawRuns(canvas).filter((r) => r.text.trim() === QTY)).toEqual([]);
      expect(xsOf(canvas, "Material:")).toHaveLength(1);
      expect(Math.abs(xsOf(canvas, "Material:")[0] - xsOf(flow, "Material:")[0])).toBeLessThanOrEqual(RUN_TOL);
    }, 60_000);
  });

  it("quoteCanvasItemContent is the canvas sheet's item node, and refuses a flow config (pin)", () => {
    // A pin: no mutation of the canvas module reds it.
    const content = quoteCanvasItemContent(sampleQuote(), quoteCfg(layout));
    const title = layout.items.find((item) => item.kind === "field" && item.key === "title")!;
    expect(content(title)).toEqual(quoteItemContent(standardCtx(), sampleQuote(), QUOTE_FLOW)(title));
    expect(content(title)).not.toBeNull();
    expect(() => quoteCanvasItemContent(sampleQuote(), quoteCfg(null))).toThrow(/needs a canvas config/);
  });
});

// ---------------------------------------------------------------------------------------------
// The quote's ruled paper on a canvas (design 2026-11-12 §11). Green on arrival after the blocks
// landed: each case names, in a comment, the mutation that reds it (or says "(pin)" in its title).
// Flow and canvas print from the same `QuotePdfData` (`richQuote`), under `standardQuoteLayout()`:
// full-width blocks at x 24, so a run's x matches the flow's. The fixture's blocks are not drawn at the
// flow's distances, so a block's runs are compared RELATIVE to that block, in each print: x absolute,
// y less the block's first baseline. The flow's side is the flow printed with that block's section
// alone shown (`flowOnly`), so its page holds that block's runs alone.
//
// Relative positions cannot see a block's first top margin, and a mark error paired with the opposite
// margin error cancels on them; the 0.01 pt cases of "a canvas quote" above (and the seed ids' cases)
// see those. Both paths call the same builders, so a flow comparison alone cannot see a break the two
// share: each case pins its paper's words as literals beside it.
// ---------------------------------------------------------------------------------------------

/** Runs grouped into lines by their exact baseline (0.01 pt), top to bottom, each line's runs left to
 *  right and its text joined with its spacing collapsed (the statement's, on raw baselines). */
function linesOfRuns(runs: Run[]): { top: number; text: string; runs: Run[] }[] {
  const byLine = new Map<number, Run[]>();
  for (const run of runs) {
    const key = Math.round(run.top * 100) / 100;
    byLine.set(key, [...(byLine.get(key) ?? []), run]);
  }
  return [...byLine.entries()].sort((a, b) => a[0] - b[0]).map(([top, line]) => {
    const sorted = [...line].sort((a, b) => a.x - b.x);
    return { top, runs: sorted, text: sorted.map((r) => r.text).join("").replace(/\s+/g, " ").trim() };
  });
}

/** The flow's config with only `keys`' sections shown, so its page holds those blocks' runs alone. */
function flowOnly(keys: QuoteTable[], over: Partial<TemplateConfig> = {}): TemplateConfig {
  const config = quoteCfg(null, over);
  config.sections = completeSections(QUOTE_CONTRACT, config.sections)
    .map((sc) => ({ ...sc, visible: (keys as string[]).includes(sc.key) }));
  return config;
}

/** A flow config with `section`'s field `field` hidden. */
function flowHiding(config: TemplateConfig, section: string, field: string): TemplateConfig {
  return {
    ...config,
    sections: config.sections.map((sc) => (sc.key !== section ? sc : {
      ...sc, fields: sc.fields.map((f) => (f.key === field ? { ...f, visible: false } : f)),
    })),
  };
}

/** A layout with the block `table`'s row `key` hidden (the row the canvas reads, `sectionConfigOf`). */
const hidingRow = (layout: CanvasLayout, table: QuoteTable, key: string): CanvasLayout =>
  withTable(layout, table, (item) => {
    expect(item.columns.some((c) => c.key === key), `${table} has a ${key} row`).toBe(true);
    return { ...item, columns: item.columns.map((c) => (c.key === key ? { ...c, visible: false } : c)) };
  });

/** A block's lines on the canvas, each line's top made relative to the block's first baseline. */
function canvasBlockLines(pdf: Buffer, group: Group, layout: CanvasLayout, key: QuoteTable) {
  expect(at(group, CANVAS_IDS.end(key)).page, key).toBe(1);
  return relative(linesOfRuns(runsInBlock(pdf, group, layout, key)));
}

/** The flow-only print's lines (one page), each line's top made relative to its first baseline. */
async function flowBlockLines(d: QuotePdfData, config: TemplateConfig) {
  const pdf = await renderPdf(buildQuoteDefinition(d, config));
  expect(textRunsWithY(pdf)).toHaveLength(1);
  return relative(linesOfRuns(rawRuns(pdf).filter((r) => r.text.trim() !== "")));
}

/** Lines with each top made relative to the first line's baseline (a block's own frame). */
function relative(lines: { top: number; text: string; runs: Run[] }[]) {
  expect(lines.length).toBeGreaterThan(0);
  const first = lines[0].top;
  return lines.map((l) => ({ ...l, top: l.top - first }));
}

/** The canvas block's lines are the flow's: the same text, line by line; each line at the flow's
 *  relative y and each run at the flow's x (0.5 pt). */
function expectSameBlock(canvas: ReturnType<typeof relative>, flow: ReturnType<typeof relative>): void {
  expect(canvas.map((l) => l.text)).toEqual(flow.map((l) => l.text));
  canvas.forEach((line, i) => {
    expect(Math.abs(line.top - flow[i].top), line.text).toBeLessThanOrEqual(RUN_TOL);
    expect(line.runs.length, line.text).toBe(flow[i].runs.length);
    line.runs.forEach((r, j) => expect(Math.abs(r.x - flow[i].runs[j].x), r.text).toBeLessThanOrEqual(RUN_TOL));
  });
}

/** The index of the first line at or after `from` whose text includes `needle` (-1 when none). */
const lineIndex = (lines: { text: string }[], needle: string, from = 0): number =>
  lines.findIndex((l, i) => i >= from && l.text.includes(needle));

/** Each needle on a later line than the one before it, in the order given. */
function expectInOrder(lines: { text: string }[], needles: string[]): void {
  let from = 0;
  for (const needle of needles) {
    const i = lineIndex(lines, needle, from);
    expect(i, `"${needle}" after line ${from}`).toBeGreaterThanOrEqual(from);
    from = i + 1;
  }
}

describe("the quote's ruled paper on a canvas (design 2026-11-12 §11)", () => {
  const layout = standardQuoteLayout();

  it("the layouts these cases print pass the canvas rules (pin)", () => {
    for (const l of [layout, hidingRow(layout, "lines", "surcharge_estimate"), hidingRow(layout, "lines", "price_amount"),
      hidingRow(layout, "closing", "ending_statement"), hidingRow(layout, "closing", "signer_title")]) {
      for (const pageFooter of [false, true]) {
        expect(() => validateCanvasLayout(l, QUOTE_CONTRACT, { pageFooter }), String(pageFooter)).not.toThrow();
      }
    }
  });

  it.each(BLOCKS)("the %s block prints the flow's lines at the flow's x and relative y", async (key) => {
    // Red, on its lines turn, when `blockChildren`'s lines arm prints through a ctx whose `qtyW` is 0
    // (the Material line and the PRICE headings move 52 pt left); on its closing turn when the closing
    // arm drops its right column (no signer's name); on its intro turn when the intro arm prints
    // `flow.liabilityBlock`; on its parties, column headers and liability turns when that arm prints
    // `flow.introBlock` instead of its own node. (A one-node arm's zeroed margins are invisible to
    // relative y; the 0.01 pt cases above see them.)
    const d = richQuote();
    const { pdf, group } = await renderQuote(d, quoteCfg(layout));
    expectSameBlock(canvasBlockLines(pdf, group, layout, key), await flowBlockLines(d, flowOnly([key])));
  }, 60_000);

  it("call 1, the interleave: per line its grid row, Material line, PRICE heading, price rows with their detail and break lines, then its estimate rows", async () => {
    // Red when `blockChildren`'s lines arm calls `flow.linesBlock` with a ctx whose `qtyW` is 0: the
    // Material line and the PRICE heading print at the information indent alone, not past the quantity
    // column.
    const d = richQuote();
    const { pdf, group } = await renderQuote(d, quoteCfg(layout));
    const lines = canvasBlockLines(pdf, group, layout, "lines");
    expectSameBlock(lines, await flowBlockLines(d, flowOnly(["lines"])));
    expectInOrder(lines, [
      "P-1001", "Gear housing", "Cast iron, machined", "Material: 4140 steel", "PRICE",
      "Harden", "Rockwell C 40-45", "Setup charge: $25.00 Plus", "Price per Each: $0.15 Or", "Minimum charge: $100.00",
      "Temper", "Price per Per lb: $0.08", "1,000 lb or more: $0.07", "5,000 lb or more: $0.06",
      "EnergySur 4% (estimate):", "Fuel surcharge 2.5% (estimate)",
      "P-1002", "Pin",
      "P-1003", "Bushing", "Sintered", "Material: 1018 steel", "PRICE",
      "Carburize", "Case depth .020", "Price per Each: $0.055 Or", "Minimum charge: $75.00", "5,000 or more: $0.05",
    ]);
    // The Material line and the PRICE heading sit past the quantity column, at the information indent.
    const indent = blockBox(layout, "lines").x + gridDefault("col_qty") + QUOTE_WIDTHS.infoIndent;
    for (const needle of ["Material:", "PRICE"]) {
      const xs = xsOf(pdf, needle);
      expect(xs, needle).toHaveLength(2);
      for (const x of xs) expect(Math.abs(x - indent), needle).toBeLessThanOrEqual(RUN_TOL);
    }
  }, 60_000);

  describe("#948: the estimate rows", () => {
    it("print only under a line that has price rows, after its last price row's detail and break lines", async () => {
      // Red when the flow's `lineBlock` prints a line's estimate rows outside its `prices.length > 0`
      // guard (pdf/quote.ts): line 2, which has none, then prints its own.
      const d = richQuote();
      d.lines[1].surcharges = [{ name: "Unpriced line surcharge", rateText: "3%", amount: 1.5 }];
      const { pdf, group } = await renderQuote(d, quoteCfg(layout));
      const lines = canvasBlockLines(pdf, group, layout, "lines");
      expectSameBlock(lines, await flowBlockLines(d, flowOnly(["lines"])));
      expect(lines.filter((l) => l.text.includes("Unpriced line surcharge"))).toEqual([]);
      const lastBreak = lineIndex(lines, "5,000 lb or more:");
      const first = lineIndex(lines, "EnergySur");
      const second = lineIndex(lines, "Fuel surcharge");
      expect(first).toBe(lastBreak + 1);
      expect(second).toBe(first + 1);
      expect(lineIndex(lines, "P-1002")).toBe(second + 1);
    }, 60_000);

    it("the figure's row prints its label with a colon and its figure; the rate-only row no colon and no figure", async () => {
      // Red when the flow's `surchargeRow` (pdf/quote.ts) puts the colon on every row.
      const d = richQuote();
      const { pdf, group } = await renderQuote(d, quoteCfg(layout));
      const lines = canvasBlockLines(pdf, group, layout, "lines");
      const amount = standardCtx().money(8.2);
      expect(amount).toBe("$8.20");
      const energy = lines[lineIndex(lines, "EnergySur")];
      // The label and the figure share a baseline: the figure is its own run, right of the label's.
      const figure = energy.runs.filter((r) => r.text.trim() === amount);
      expect(figure).toHaveLength(1);
      const label = energy.runs.filter((r) => r.text.trim() !== amount);
      expect(label.map((r) => r.text).join("").replace(/\s+/g, " ").trim()).toBe("EnergySur 4% (estimate):");
      expect(Math.max(...label.map((r) => r.x))).toBeLessThan(figure[0].x);
      const fuel = lines[lineIndex(lines, "Fuel surcharge")];
      expect(fuel.text).toBe("Fuel surcharge 2.5% (estimate)");
      expect(fuel.runs.filter((r) => r.text.trim().startsWith("$"))).toEqual([]);
    }, 60_000);

    it("surcharge_estimate hidden on the block's row prints no estimate row and leaves no gap", async () => {
      // Red when `canvasCtx` builds the lines section from the contract's defaults instead of the
      // item's rows (the rows print).
      const d = richQuote();
      const hidden = hidingRow(layout, "lines", "surcharge_estimate");
      const { pdf, group } = await renderQuote(d, quoteCfg(hidden));
      const lines = canvasBlockLines(pdf, group, hidden, "lines");
      expect(lines.filter((l) => l.text.includes("(estimate)"))).toEqual([]);
      // No gap: the block is the flow's under the same config, the next line's grid row at its
      // relative y, directly under the last break line.
      expectSameBlock(lines, await flowBlockLines(d, flowHiding(flowOnly(["lines"]), "lines", "surcharge_estimate")));
      expect(lineIndex(lines, "P-1002")).toBe(lineIndex(lines, "5,000 lb or more:") + 1);
      // Not vacuous: the hide moved line 2 up against the unhidden print.
      const { pdf: shownPdf, group: shownGroup } = await renderQuote(d, quoteCfg(layout));
      const shown = canvasBlockLines(shownPdf, shownGroup, layout, "lines");
      expect(shown[lineIndex(shown, "P-1002")].top - lines[lineIndex(lines, "P-1002")].top).toBeGreaterThan(10);
    }, 60_000);

    it("price_amount hidden blanks every indicative figure and drops the estimate's colon", async () => {
      // Red when `canvasCtx` builds the lines section from the contract's defaults instead of the
      // item's rows (the figures print).
      const d = richQuote();
      const hidden = hidingRow(layout, "lines", "price_amount");
      const { pdf, group } = await renderQuote(d, quoteCfg(hidden));
      const lines = canvasBlockLines(pdf, group, hidden, "lines");
      expectSameBlock(lines, await flowBlockLines(d, flowHiding(flowOnly(["lines"]), "lines", "price_amount")));
      const money = standardCtx().money;
      const texts = lines.flatMap((l) => l.runs.map((r) => r.text.trim()));
      for (const figure of [money(102.5), money(80), money(110), money(8.2)]) expect(texts, figure).not.toContain(figure);
      expect(lines[lineIndex(lines, "EnergySur")].text).toBe("EnergySur 4% (estimate)");
      // Not vacuous: the unhidden print prints them.
      const shown = (await renderQuote(d, quoteCfg(layout))).pdf;
      const shownTexts = rawRuns(shown).map((r) => r.text.trim());
      for (const figure of [money(102.5), money(80), money(110), money(8.2)]) expect(shownTexts, figure).toContain(figure);
    }, 60_000);
  });

  it("owner ruling 8: the line with a blank Material prints no Material line", async () => {
    // Red when the flow's `lineBlock` (pdf/quote.ts) prints the Material label whatever its value.
    const d = richQuote();
    expect(d.lines[1].material).toBe("");
    const { pdf, group } = await renderQuote(d, quoteCfg(layout));
    const lines = canvasBlockLines(pdf, group, layout, "lines");
    const two = lineIndex(lines, "P-1002");
    const three = lineIndex(lines, "P-1003");
    expect(lines.slice(two, three).filter((l) => l.text.includes("Material"))).toEqual([]);
    expect(lines.filter((l) => l.text.startsWith("Material:")).map((l) => l.text)).toEqual(["Material: 4140 steel", "Material: 1018 steel"]);
  }, 60_000);

  it("ruling 9: an Unlimited line prints Unlimited in the Quantity cell", async () => {
    // Red when the flow's `qtyCell` (pdf/quote.ts) loses its Unlimited arm (the cell prints blank).
    const d = richQuote();
    const { pdf, group } = await renderQuote(d, quoteCfg(layout));
    const lines = canvasBlockLines(pdf, group, layout, "lines");
    const row = lines[lineIndex(lines, "P-1001")];
    const cell = row.runs.filter((r) => r.text.trim() === "Unlimited");
    expect(cell).toHaveLength(1);
    const x = blockBox(layout, "lines").x;
    expect(cell[0].x).toBeGreaterThanOrEqual(x - RUN_TOL);
    expect(cell[0].x).toBeLessThan(x + gridDefault("col_qty"));
  }, 60_000);

  it("W14 and W15: the fourth heading reads Net weight / Price; every printed weight takes \" lb\", an LB break threshold too, a piece break bare", async () => {
    // Red when the flow's `lineGridRow` (pdf/quote.ts) prints the each weight without `lb`.
    const d = richQuote();
    const { pdf, group } = await renderQuote(d, quoteCfg(layout));
    const strip = canvasBlockLines(pdf, group, layout, "column_header");
    expect(strip).toHaveLength(1);
    expect(strip[0].text.endsWith("Net weight / Price")).toBe(true);
    const lines = canvasBlockLines(pdf, group, layout, "lines");
    const runTexts = (needle: string) => lines[lineIndex(lines, needle)].runs.map((r) => r.text.trim()).join(" ");
    expect(runTexts("P-1001")).toContain("12.50 lb");
    expect(runTexts("P-1002")).toContain("3.25 lb");
    expect(runTexts("P-1002")).toContain("130.00 lb");
    expect(runTexts("P-1003")).toContain("0.40 lb");
    expect(runTexts("P-1003")).toContain("800.00 lb");
    expect(lines.filter((l) => / lb or more:/.test(l.text)).map((l) => l.text)).toEqual([
      "1,000 lb or more: $0.07", "5,000 lb or more: $0.06",
    ]);
    expect(lines.filter((l) => l.text.startsWith("5,000 or more:")).map((l) => l.text)).toEqual(["5,000 or more: $0.05"]);
    expect(lines.filter((l) => /\blbs\b/.test(l.text))).toEqual([]);
  }, 60_000);

  describe("Q7: the two money precisions", () => {
    it("the unit price prints at up to four decimals; the setup, the minimums and every indicative amount at two", async () => {
      // Red when the flow's `makeMoney4` (pdf/quote.ts) rounds to two decimals ($0.055 prints $0.06).
      const d = richQuote();
      expect(d.lines[2].prices[0].unitPrice).toBe(0.055);
      const { pdf, group } = await renderQuote(d, quoteCfg(layout));
      const lines = canvasBlockLines(pdf, group, layout, "lines");
      const texts = lines.map((l) => l.text);
      expect(texts).toContain("Price per Each: $0.055 Or");
      expect(texts).toContain("Setup charge: $25.00 Plus");
      expect(texts).toContain("Minimum charge: $100.00");
      expect(texts).toContain("Minimum charge: $75.00");
      const runTexts = lines.flatMap((l) => l.runs.map((r) => r.text.trim()));
      for (const amount of ["$102.50", "$80.00", "$110.00", "$8.20"]) expect(runTexts, amount).toContain(amount);
    }, 60_000);

    it("priceDecimals 2 moves the unit price and nothing else, as the flow prints it", async () => {
      // Red when `canvasCtx` builds its ctx over the Standard's formats instead of the config's (the
      // canvas then keeps $0.055 where the flow prints two decimals).
      const d = richQuote();
      const formats = { ...QUOTE_DEFAULT_CONFIG.formats, priceDecimals: 2 as const };
      const base = await renderQuote(d, quoteCfg(layout));
      const moved = await renderQuote(d, quoteCfg(layout, { formats }));
      const before = canvasBlockLines(base.pdf, base.group, layout, "lines");
      const after = canvasBlockLines(moved.pdf, moved.group, layout, "lines");
      expectSameBlock(after, await flowBlockLines(d, flowOnly(["lines"], { formats })));
      expect(after).toHaveLength(before.length);
      const differs = after.map((l, i) => i).filter((i) => after[i].text !== before[i].text);
      expect(differs).toHaveLength(1);
      expect(before[differs[0]].text).toBe("Price per Each: $0.055 Or");
      expect(after[differs[0]].text).toMatch(/^Price per Each: \$0\.0\d Or$/);
      // The rest of the page too: every other block prints the same lines.
      for (const key of BLOCKS.filter((k) => k !== "lines")) {
        expect(canvasBlockLines(moved.pdf, moved.group, layout, key).map((l) => l.text), key)
          .toEqual(canvasBlockLines(base.pdf, base.group, layout, key).map((l) => l.text));
      }
    }, 60_000);
  });

  it("R14: the stacked bill-to name prints above the customer's name, under the Attn line, in the parties' left column", async () => {
    // Red when `blockChildren`'s parties arm prints `flow.introBlock` instead of the parties' node. The
    // stacking itself is the data's (`billToLines`, party-address.ts): the builder prints the bill-to
    // lines in their order, and the flow prints the Attn line first (its row comes first).
    const d = richQuote();
    const { pdf, group } = await renderQuote(d, quoteCfg(layout));
    const box = blockBox(layout, "parties");
    const leftEdge = box.x + box.w - QUOTE_WIDTHS.quoteFields;
    const left = linesOfRuns(runsInBlock(pdf, group, layout, "parties").filter((r) => r.x < leftEdge));
    expect(left.map((l) => l.text)).toEqual([
      "Attn: Casey Example", "Accounts Payable", "Demo Tractor Parts", "700 Demo Drive", "Chicago, IL 12345",
    ]);
    for (const line of left) expect(Math.abs(line.runs[0].x - (box.x + QUOTE_WIDTHS.partiesIndent)), line.text).toBeLessThanOrEqual(RUN_TOL);
    expectSameBlock(canvasBlockLines(pdf, group, layout, "parties"), await flowBlockLines(d, flowOnly(["parties"])));
  }, 60_000);

  describe("rulings 13 and 14: the closing", () => {
    it("a blank ending statement prints nothing in the closing's left column: it prints as the row hidden", async () => {
      // Red when the flow's `closingBlock` (pdf/quote.ts) pushes the ending statement whatever its text
      // (an empty line then holds the notes down).
      const d = richQuote({ endingStatementText: "" });
      const blank = await renderQuote(d, quoteCfg(layout));
      const hiddenLayout = hidingRow(layout, "closing", "ending_statement");
      const hidden = await renderQuote(d, quoteCfg(hiddenLayout));
      const lines = canvasBlockLines(blank.pdf, blank.group, layout, "closing");
      expectSameBlock(lines, canvasBlockLines(hidden.pdf, hidden.group, hiddenLayout, "closing"));
      expect(Math.abs(blockHeight(blank.group, layout, "closing") - blockHeight(hidden.group, hiddenLayout, "closing")))
        .toBeLessThanOrEqual(MARK_TOL);
      expect(lines.filter((l) => l.text.includes("Ending"))).toEqual([]);
      expect(lines.some((l) => l.text.includes(d.notes))).toBe(true);
      expectSameBlock(lines, await flowBlockLines(d, flowOnly(["closing"])));
    }, 60_000);

    it("a blank signer title prints nothing under the name: it prints as the row hidden", async () => {
      // Red when the flow's `closingBlock` (pdf/quote.ts) prints the title line whatever its text.
      const d = richQuote({ signer: { name: "Mr. Johnathen Smith", title: "" } });
      const blank = await renderQuote(d, quoteCfg(layout));
      const hiddenLayout = hidingRow(layout, "closing", "signer_title");
      const hidden = await renderQuote(d, quoteCfg(hiddenLayout));
      expect(Math.abs(blockHeight(blank.group, layout, "closing") - blockHeight(hidden.group, hiddenLayout, "closing")))
        .toBeLessThanOrEqual(MARK_TOL);
      // The signature column's lines alone (the left column's notes share no baseline with them).
      const signatureX = blockBox(layout, "closing").x + blockBox(layout, "closing").w - QUOTE_WIDTHS.signature;
      const signature = (pdf: Buffer, group: Group) =>
        linesOfRuns(runsInBlock(pdf, group, layout, "closing").filter((r) => r.x >= signatureX - RUN_TOL)).map((l) => l.text);
      expect(signature(blank.pdf, blank.group)).toEqual([d.signer.name]);
      // Not vacuous: with a title, a line prints under the name.
      const titled = await renderQuote(richQuote(), quoteCfg(layout));
      expect(signature(titled.pdf, titled.group)).toEqual([d.signer.name, "V.P. Sales"]);
    }, 60_000);

    it("the signature's rule is 230 pt, ending at the block's right edge", async () => {
      // Red when `blockChildren`'s closing arm drops the closing's right column (no rule prints).
      const { pdf, group } = await renderQuote(richQuote(), quoteCfg(layout));
      const top = blockTop(group, layout, "closing");
      const end = at(group, CANVAS_IDS.end("closing")).top;
      const rules = strokedLines(pdf)[0].filter((s) => s.y1 === s.y2 && s.y1 >= top - RUN_TOL && s.y1 <= end + RUN_TOL);
      expect(rules).toHaveLength(1);
      const box = blockBox(layout, "closing");
      const [x1, x2] = [Math.min(rules[0].x1, rules[0].x2), Math.max(rules[0].x1, rules[0].x2)];
      expect(QUOTE_WIDTHS.signature).toBe(230);
      expect(Math.abs(x2 - x1 - QUOTE_WIDTHS.signature)).toBeLessThanOrEqual(RUN_TOL);
      expect(Math.abs(x2 - (box.x + box.w))).toBeLessThanOrEqual(RUN_TOL);
    }, 60_000);
  });

  it("the data seam: the intro and the liability print the quote's own two texts", async () => {
    // Red when `blockChildren`'s intro arm prints `flow.liabilityBlock` (the intro then prints the
    // liability's wording).
    const d = richQuote({ introText: "Typed intro marker for the seam", liabilityText: "Typed liability marker for the seam" });
    const { pdf, group } = await renderQuote(d, quoteCfg(layout));
    expect(canvasBlockLines(pdf, group, layout, "intro").map((l) => l.text)).toEqual([d.introText]);
    expect(canvasBlockLines(pdf, group, layout, "liability").map((l) => l.text)).toEqual([d.liabilityText]);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// A canvas quote that grows and pages (design 2026-11-12 §4.4, §4.5, §11; since quote canvas PR 2).
// One layout (`standardQuoteLayout()`) is printed for `sampleQuote()`, `richQuote()` and a 40-line
// quote (eight pages, the lines block running from page 1 to page 8). Every block rides the block
// above it by the drawn distance whatever the data; the long quote's continuation pages print the
// repeated quotation number where it is drawn and "(continued)" at the repeat band's bottom-left,
// clear of it, and never the column headers' strip; the closing and the liability follow the last
// line on the last page. Every case here is green on arrival, and each names in a comment the
// mutation that reds it.
//
// THE PAGE-BREAK SWEEP (Review Focus 1; the statement's finding 1, generalised; #969's shape): every
// quote block is one column group (`drawnBlock`). A narrowed one that breaks across a page must
// leave every later block its own drawn x and width: under a lateral margin on the wrapper with a
// `"*"` column, pdfmake rebuilt the page's width after the break wider by the block's insets, and
// what followed printed past the right margin (`canvas-nodes.ts`' header). The sweep draws the lines
// block 40 pt in, the closing at x 78 and 456 wide (over long notes, under which it breaks across a
// page at most of the sweep's counts, by where it falls), and both, at every line count from 14 to 22, the page line off and on.
// ---------------------------------------------------------------------------------------------

/** A printed run with its page, its baseline read top-down. */
type PagedRun = Run & { page: number };
const pagedRuns = (pdf: Buffer): PagedRun[] => textRunsWithY(pdf).flatMap((runs, i) => runs
  .filter((r) => r.text.trim() !== "")
  .map((r) => ({ text: r.text, x: r.x, top: PAGE_HEIGHT - r.y, page: i + 1 })));

/** The page and top a block starts at: its drawn y on page 1 for the first block, else the end mark
 *  of the region above it (the header's rule). */
function blockStart(group: Group, layout: CanvasLayout, key: QuoteTable): { page: number; top: number } {
  const prev = above(layout, key);
  return prev === null ? { page: 1, top: blockBox(layout, key).y } : at(group, CANVAS_IDS.regionEnd(prev));
}

/** A block's printed lines on every page it prints on, page by page, top to bottom (`linesOfRuns` on
 *  each page): the runs under its rendered top and above its end mark, below the repeat band (the
 *  sheet's top margin, `topMargin`) and above the page's foot (`pageFoot`), so neither the repeated
 *  number, "(continued)" nor the page line is counted. */
function blockLinesAcross(pdf: Buffer, group: Group, layout: CanvasLayout, key: QuoteTable, pageFooter: boolean) {
  const start = blockStart(group, layout, key);
  const end = at(group, CANVAS_IDS.end(key));
  const body = topMargin(layout);
  const foot = pageFoot(pageFooter);
  const runs = pagedRuns(pdf).filter((r) => r.top > body && r.top <= foot
    && (r.page > start.page || (r.page === start.page && r.top > start.top))
    && (r.page < end.page || (r.page === end.page && r.top < end.top)));
  const pages = [...new Set(runs.map((r) => r.page))].sort((a, b) => a - b);
  return pages.flatMap((page) => linesOfRuns(runs.filter((r) => r.page === page)).map((line) => ({ ...line, page })));
}

/** Whether a printed block breaks across a page: its id (where its first line starts) on an earlier
 *  page than its end mark. */
const breaksAcross = (group: Group, key: QuoteTable): boolean => {
  const id = group.positions.find((node) => node.id === CANVAS_IDS.table(key));
  return id !== undefined && id.page < at(group, CANVAS_IDS.end(key)).page;
};

/** "(continued)"'s rendered right edge, printed from `x` in `family` at the sheet's 8 pt italic: a
 *  trailing run's x (the statement seed's technique; no reader gives a run's width). */
async function continuedRight(family: string, x: number): Promise<number> {
  const pdf = await renderPdf({
    pageSize: "LETTER", pageMargins: [x, CANVAS_PAGE.margin, CANVAS_PAGE.margin, CANVAS_PAGE.margin], defaultStyle: { font: family },
    content: [{ text: [{ text: "(continued)", italics: true, fontSize: CONTINUED_FONT_SIZE }, { text: "X", fontSize: CONTINUED_FONT_SIZE }] }],
  });
  return textRunsWithY(pdf)[0].find((r) => r.text === "X")!.x;
}

describe("a canvas quote that grows and pages (design 2026-11-12 §4.4, §4.5)", () => {
  const layout = standardQuoteLayout();
  const long = sampleQuote({ lines: quoteLines(40) });
  const numberBox = layout.items.find((item) => item.kind === "field" && item.key === "quote_number")!.box;
  const NUMBER_LABEL = defaultLabelOf(QUOTE_CONTRACT, "quote_number");
  const STRIP = "Net weight / Price";
  /** Page `page`'s line holding the quotation number. */
  const numberLine = (pdf: Buffer, page: number) =>
    linesOfRuns(rawRuns(pdf, page).filter((r) => r.text.trim() !== "")).filter((l) => l.text.startsWith(NUMBER_LABEL));

  it("the precondition: the layout repeats its quotation number, and passes the canvas rules with the page line off and on", () => {
    // Reads back the fixture's own flag, so it is red when the number item's `repeat` is cleared in the
    // layout (the continuation case's mutation); the paging cases below hold the paper.
    expect(layout.items.find((item) => item.kind === "field" && item.key === "quote_number")!.repeat).toBe(true);
    for (const pageFooter of [false, true]) {
      expect(() => validateCanvasLayout(layout, QUOTE_CONTRACT, { pageFooter }), String(pageFooter)).not.toThrow();
    }
  });

  it.each([
    ["sampleQuote()", sampleQuote],
    ["richQuote()", richQuote],
    ["a 40-line quote", () => long],
  ] as const)("%s: each block rides the end mark of the block above by the drawn distance, and is laid out at its rendered top", async (name, data) => {
    // The ride (the first loop) is the sheet's region spacer between a block's end mark and its
    // region's end: red when that region is handed a wrong height (`assembleCanvasSheet`'s
    // `heights.get(…) ?? 0` plus 5). The second loop is red when `tableBlock` answers the bare stack
    // with no id (no `drawnBlock` and no id: `at` finds no block), and when a block's first line lands
    // anywhere but its rendered top's page at the one-line quote's offset under it (the lines' first
    // grid row's 2 pt, the liability's kept 10, the strip's rule and padding).
    const d = data();
    const ref = (await renderQuote(sampleQuote(), quoteCfg(layout))).group;
    const { pdf, group } = await renderQuote(d, quoteCfg(layout));
    if (name === "a 40-line quote") expect(pageCount(pdf)).toBeGreaterThanOrEqual(2);
    for (const key of BLOCKS.slice(1)) {
      const prev = above(layout, key)!;
      const end = at(group, CANVAS_IDS.end(prev));
      const top = at(group, CANVAS_IDS.regionEnd(prev));
      expect(top.page, key).toBe(end.page);
      expect(Math.abs(top.top - (end.top + drawnGap(layout, key))), key).toBeLessThanOrEqual(MARK_TOL);
    }
    const offset = (g: Group, key: QuoteTable) => at(g, CANVAS_IDS.table(key)).top - blockStart(g, layout, key).top;
    // The reference's offsets where the flow's own margins give them.
    expect(Math.abs(offset(ref, "lines") - marginOf(QUOTE_FLOW.linesBlock(standardCtx(), sampleQuote())[0])[1])).toBeLessThanOrEqual(MARK_TOL);
    expect(Math.abs(offset(ref, "liability") - marginOf(QUOTE_FLOW.liabilityBlock(sampleQuote())[0])[1])).toBeLessThanOrEqual(MARK_TOL);
    for (const key of BLOCKS) {
      expect(at(group, CANVAS_IDS.table(key)).page, key).toBe(blockStart(group, layout, key).page);
      expect(Math.abs(offset(group, key) - offset(ref, key)), key).toBeLessThanOrEqual(MARK_TOL);
    }
  }, 60_000);

  describe("the 40-line quote", () => {
    let rendered: Promise<Awaited<ReturnType<typeof renderQuote>>> | null = null;
    const once = () => (rendered ??= renderQuote(long, quoteCfg(layout)));

    it("pages, and every page after the first prints the quotation number where it is drawn, (continued) at the left margin clear of it, and no column headers strip", async () => {
      // Red when the number item's `repeat` is cleared in the layout: no number and no "(continued)"
      // on a continuation page (a layout with nothing repeated has no continued box).
      const { pdf } = await once();
      const pages = pageCount(pdf);
      expect(pages).toBeGreaterThanOrEqual(2);
      const first = numberLine(pdf, 1);
      expect(first.map((l) => l.text)).toEqual([`${NUMBER_LABEL} ${long.quoteNumber}`]);
      expect(Math.abs(first[0].runs[0].x - numberBox.x)).toBeLessThanOrEqual(RUN_TOL);
      // The strip prints once, on page 1, so its absence below is not vacuous.
      expect(lineTexts(pdf, 1).filter((t) => t.includes(STRIP))).toHaveLength(1);
      expect(lineTexts(pdf, 1).some((t) => t.includes("(continued)"))).toBe(false);
      const continued = continuedBox(layout)!;
      expect(continued).not.toBeNull();
      for (let page = 2; page <= pages; page++) {
        const line = numberLine(pdf, page);
        expect(line.map((l) => l.text), `page ${page}`).toEqual([first[0].text]);
        expect(Math.abs(line[0].runs[0].x - numberBox.x), `page ${page}`).toBeLessThanOrEqual(RUN_TOL);
        expect(Math.abs(line[0].top - first[0].top), `page ${page}`).toBeLessThanOrEqual(RUN_TOL);
        const word = rawRuns(pdf, page).filter((r) => r.text.trim() === "(continued)");
        expect(word, `page ${page}`).toHaveLength(1);
        expect(Math.abs(word[0].x - continued.x), `page ${page}`).toBeLessThanOrEqual(RUN_TOL);
        const right = await continuedRight(QUOTE_DEFAULT_CONFIG.fonts.family, word[0].x);
        expect(right, `page ${page}`).toBeLessThanOrEqual(continued.x + continued.w);
        // Its line does not meet the number's: it ends left of where the number's first run starts.
        expect(right, `page ${page}`).toBeLessThan(line[0].runs[0].x);
        expect(lineTexts(pdf, page).some((t) => t.includes(STRIP)), `page ${page}`).toBe(false);
      }
    }, 60_000);

    it("the closing's ending statement and the liability's wording print on the last page, after the last line's last run", async () => {
      // Red when the sheet lays its blocks out out of their drawn order (`assembleCanvasSheet` walking
      // `tablesByY(layout).reverse()`): the closing and the liability then print on page 1, ahead of
      // the lines.
      const { pdf, group } = await once();
      const pages = pageCount(pdf);
      expect(at(group, CANVAS_IDS.end("lines")).page).toBe(pages);
      const lastLine = blockLinesAcross(pdf, group, layout, "lines", false).filter((l) => l.page === pages);
      expect(lastLine.length, "the lines block prints on the last page").toBeGreaterThan(0);
      expect(lastLine.some((l) => l.text.includes(long.lines[39].partNumber))).toBe(true);
      const lastRun = Math.max(...lastLine.map((l) => l.top));
      const last = linesOfRuns(rawRuns(pdf, pages).filter((r) => r.text.trim() !== ""));
      for (const text of [long.endingStatementText, long.liabilityText]) {
        const found = last.filter((l) => l.text.includes(text));
        expect(found, text).toHaveLength(1);
        expect(found[0].top, text).toBeGreaterThan(lastRun);
      }
      for (let page = 1; page < pages; page++) {
        const text = lineTexts(pdf, page);
        expect(text.some((t) => t.includes(long.endingStatementText) || t.includes(long.liabilityText)), `page ${page}`).toBe(false);
      }
    }, 60_000);

    it("with the page line on, Page: 2 of N prints on page 2, every page prints its line, and no body run's bottom lies below the page line's top", async () => {
      // Red when the sheet leaves the page line no room (`assembleCanvasSheet`'s bottom margin without
      // PAGE_LINE_ROOM): the rows then run to the plain margin, past the foot the page line leaves.
      const { pdf } = await renderQuote(long, quoteCfg(layout, { pageFooter: true }));
      const pages = pageCount(pdf);
      expect(pages).toBeGreaterThanOrEqual(2);
      expect(lineTexts(pdf, 2)).toContain(`Page: 2 of ${pages}`);
      for (let page = 1; page <= pages; page++) {
        const runs = rawRuns(pdf, page).filter((r) => r.text.trim() !== "");
        const pageLine = linesOfRuns(runs).find((l) => l.text === `Page: ${page} of ${pages}`);
        expect(pageLine, `page ${page}`).toBeDefined();
        // The page line prints at 8.5 pt (render.ts), so its top is at most its size above its
        // baseline; a body run's bottom is its baseline and its descender, under 0.3 of its size.
        const lineTop = pageLine!.top - 8.5;
        const body = runs.filter((r) => !pageLine!.runs.includes(r));
        expect(body.length, `page ${page}`).toBeGreaterThan(0);
        for (const run of body) {
          const bottom = run.top + 0.3 * QUOTE_DEFAULT_CONFIG.fonts.baseSize;
          expect(bottom, `page ${page}: ${run.text}`).toBeLessThan(lineTop);
          expect(bottom, `page ${page}: ${run.text}`).toBeLessThanOrEqual(pageFoot(true));
        }
      }
    }, 60_000);
  });

  it("the band clip: a Text item in the page-bottom band whose text runs past the band's foot is cut, never paged, and prints in the band", async () => {
    // Red when the sheet drops its page-bottom band (`assembleCanvasSheet`'s `bandSpec` always null):
    // no line of the item prints. Red too when the band's footer frame is not ended at the band's
    // bottom edge (render.ts's `installBandFrame` wrapper, #978): the item's overflow then prints
    // below the edge, in the page's bottom margin (baselines at 777.00 and 788.71 with the page line
    // off, 768 being the edge), and with the page line on over and under the page line. Owner ruling
    // 2026-11-14: a cut drops whole lines at the band's bottom edge, so the last line to print has
    // its baseline at or above the edge and within one line of it (`expectBandClip`).
    const box = { x: CANVAS_PAGE.margin, y: pageFoot(false) - 12, w: 200, h: 12 };
    const text: CanvasItem = {
      id: "band-text", kind: "text", text: "Band clip words ".repeat(60).trim(), box,
      anchor: { kind: "page-bottom" }, repeat: false, style: { size: 10, bold: false, align: "left" },
    };
    const banded = layoutOf([...layout.items, text]);
    expect(() => validateCanvasLayout(banded, QUOTE_CONTRACT, { pageFooter: false })).not.toThrow();
    expect(bandTop(banded, false)).toBe(box.y);
    const { pdf } = await renderQuote(sampleQuote(), quoteCfg(banded));
    expect(pageCount(pdf)).toBe(1);
    const lines = linesOfRuns(rawRuns(pdf).filter((r) => r.text.trim() !== "" && r.top > box.y && r.x < box.x + box.w));
    expect(lines.length, "the item prints in the band").toBeGreaterThan(0);
    for (const line of lines) expect(line.text.replace(/ /g, "")).toMatch(/^(Band|clip|words)+$/);
    // Cut: fewer lines than the text lays out alone at the box's width.
    const alone = await renderPdf({
      pageSize: "LETTER", pageMargins: [box.x, CANVAS_PAGE.margin, CANVAS_PAGE.width - box.x - box.w, CANVAS_PAGE.margin],
      defaultStyle: { font: QUOTE_DEFAULT_CONFIG.fonts.family }, content: [textContent(text as Extract<CanvasItem, { kind: "text" }>)],
    });
    expect(pageCount(alone)).toBe(1);
    expect(lines.length).toBeLessThan(linesOfRuns(rawRuns(alone).filter((r) => r.text.trim() !== "")).length);
    // The edge, with the page line off and on (#978).
    expectBandClip(pdf, false);
    const withPageLine = bandClipLayout(layout, true);
    expect(() => validateCanvasLayout(withPageLine, QUOTE_CONTRACT, { pageFooter: true })).not.toThrow();
    const on = await renderQuote(sampleQuote(), quoteCfg(withPageLine, { pageFooter: true }));
    expect(pageCount(on.pdf)).toBe(1);
    expectBandClip(on.pdf, true);
  }, 60_000);

  describe("the page-break sweep (Review Focus 1)", () => {
    const RIGHT = CANVAS_PAGE.width - CANVAS_PAGE.margin;
    /** Notes of about 3,000 characters of breakable words (under the 4,000 cap). The closing then
     *  stays under a page tall but breaks across a page at most of the sweep's counts, by where it
     *  falls (as recorded: at every count but 15 with the page line off, at every count with it on);
     *  the premise case after the sweep asserts it at 16 lines. */
    const LONG_NOTES = (() => {
      const words = "Prices hold for the quoted quantity and the stated material only; ";
      return words.repeat(Math.ceil(3000 / words.length)).slice(0, 3000).trim();
    })();
    /** Liability wording that wraps at the block's width, so a width handed on wider than drawn moves
     *  where its lines break (left-aligned, its x alone would not move). */
    const WRAPPING = "Our liability is limited to the value of the services performed on the parts. ".repeat(6).trim();
    const closingAt = (base: CanvasLayout) =>
      withTable(base, "closing", (item) => ({ ...item, box: { ...item.box, x: CANVAS_PAGE.margin + 54, w: 456 } }));
    type Turn = { name: string; narrowed: QuoteTable[]; layout: CanvasLayout; notes: boolean };
    const TURNS: Turn[] = [
      { name: "the lines block 40 pt in", narrowed: ["lines"], layout: inset(layout, "lines", 40), notes: false },
      { name: "the closing at x 78, 456 wide", narrowed: ["closing"], layout: closingAt(layout), notes: true },
      { name: "both", narrowed: ["lines", "closing"], layout: closingAt(inset(layout, "lines", 40)), notes: true },
    ];

    it("the sweep's layouts pass the canvas rules, the page line off and on, and draw what they name (pin)", () => {
      // Reads the sweep's own layouts back, so no mutation of the code reds it: red only when a turn's
      // layout is not drawn as named (the closing at x 78 and 456 wide, the lines 40 pt in).
      for (const turn of TURNS) {
        for (const pageFooter of [false, true]) {
          expect(() => validateCanvasLayout(turn.layout, QUOTE_CONTRACT, { pageFooter }), `${turn.name} ${pageFooter}`).not.toThrow();
        }
      }
      expect(blockBox(TURNS[1].layout, "closing")).toEqual({ ...blockBox(layout, "closing"), x: 78, w: 456 });
      expect(blockBox(TURNS[2].layout, "lines")).toEqual({ ...blockBox(layout, "lines"), x: 64, w: 484 });
    });

    it.each(Array.from({ length: 9 }, (_, i) => 14 + i))(
      "%i lines: nothing prints past the right margin, and the block after a narrowed one prints at its own drawn place, as with none narrowed",
      async (n) => {
        // Red when `blockAt` (canvas-nodes.ts) gives the block a `"*"` column and puts its lateral
        // margin on the wrapper (#969's shape): after the narrowed block breaks across a page the blocks
        // laid out after it are handed the page's width plus the insets, so the liability's wrapping
        // wording prints past the right margin and the signature rule strokes past it (at every count,
        // in each of the three layouts alone). Red too when `tableBlock` prints the stack with its id
        // and no `drawnBlock`: the narrowed closing ("both") then prints from x 24, left of its drawn
        // x 78 (the lines and closing layouts' next block is full width, so neither sees that one).
        for (const pageFooter of [false, true]) {
          // The closing-only turn's render, the control for the narrowed closing in "both" (the same
          // notes, wording and closing box; TURNS renders it first).
          let closingOnly: Awaited<ReturnType<typeof renderQuote>> | null = null;
          for (const turn of TURNS) {
            const d = sampleQuote({ lines: quoteLines(n), liabilityText: WRAPPING, ...(turn.notes ? { notes: LONG_NOTES } : {}) });
            const control = await renderQuote(d, quoteCfg(layout, { pageFooter }));
            const drawn = await renderQuote(d, quoteCfg(turn.layout, { pageFooter }));
            const where = `${turn.name}, page line ${pageFooter}`;
            // The premise: the lines block breaks across a page at every count (14 lines of about 130 pt
            // each run past page 1); the closing does at some, never assumed (the case after the sweep).
            if (turn.narrowed.includes("lines")) expect(breaksAcross(drawn.group, "lines"), `lines breaks: ${where}`).toBe(true);
            if (turn.narrowed.length === 1 && turn.narrowed[0] === "closing") closingOnly = drawn;
            // Nothing past the right margin, no run and no stroke, on any page. A run is read by its
            // start x alone here and in the drawn-edge loop below; a run that starts inside and ends
            // past the margin is left to the control's line texts (the texts move with the width a
            // block is handed: with these two checks removed, `blockAt`'s `"*"` column under a
            // margined wrapper still reds every count through the control comparison).
            const pastRuns = pagedRuns(drawn.pdf).filter((r) => r.x > RIGHT).map((r) => `p${r.page}:${r.text.trim()}@${r.x.toFixed(1)}`);
            expect(pastRuns, where).toEqual([]);
            const pastStrokes = strokedLines(drawn.pdf).flatMap((lines, p) => lines
              .filter((s) => Math.max(s.x1, s.x2) > RIGHT + RUN_TOL)
              .map((s) => `p${p + 1}:${Math.min(s.x1, s.x2).toFixed(1)}..${Math.max(s.x1, s.x2).toFixed(1)}`));
            expect(pastStrokes, where).toEqual([]);
            for (const key of turn.narrowed) {
              const next = BLOCKS[BLOCKS.indexOf(key) + 1];
              const box = blockBox(turn.layout, next);
              const lines = blockLinesAcross(drawn.pdf, drawn.group, turn.layout, next, pageFooter);
              expect(lines.length, `${next} prints: ${where}`).toBeGreaterThan(0);
              for (const line of lines) {
                for (const r of line.runs) {
                  expect(r.x, `${next} ${r.text}: ${where}`).toBeGreaterThanOrEqual(box.x - RUN_TOL);
                  expect(r.x, `${next} ${r.text}: ${where}`).toBeLessThanOrEqual(box.x + box.w + RUN_TOL);
                }
              }
              // Against the control: the block after the narrowed one where it is drawn as in the
              // control; the narrowed closing in "both" against the closing-only turn's render, where
              // the lines above it are not narrowed. That comparison alone (every other check here
              // removed) reds every count when `blockAt` takes a `"*"` column under a margined wrapper;
              // it does not see `tableBlock` without `drawnBlock`, which moves both renders alike.
              const ref = !turn.narrowed.includes(next) ? { r: control, l: layout }
                : closingOnly !== null && next === "closing" ? { r: closingOnly, l: TURNS[1].layout } : null;
              expect(ref, `${next} has a control: ${where}`).not.toBeNull();
              const want = blockLinesAcross(ref!.r.pdf, ref!.r.group, ref!.l, next, pageFooter);
              expect(lines.map((l) => l.text), `${next}: ${where}`).toEqual(want.map((l) => l.text));
              lines.forEach((line, i) => {
                expect(line.runs.length, `${next} ${line.text}: ${where}`).toBe(want[i].runs.length);
                line.runs.forEach((r, j) => expect(Math.abs(r.x - want[i].runs[j].x), `${next} ${r.text}: ${where}`).toBeLessThanOrEqual(RUN_TOL));
              });
            }
          }
        }
      },
      60_000,
    );

    it("the closing breaks across a page at a count of the sweep, in both closing layouts, the page line off and on", async () => {
      // The sweep's premise, asserted rather than assumed, at 16 lines, a count where it holds in all
      // four (the sweep's record, as run: with the long notes the closing breaks at every count but 15
      // with the page line off, where it starts a page and fits it; it is under a page tall). Red when
      // `tableBlock` prints the stack with its id and no `drawnBlock`, and when `blockAt` takes a `"*"`
      // column under a margined wrapper: in each the closing no longer breaks at 16 lines. Red too
      // when the notes are cut to 300 characters.
      for (const turn of TURNS.filter((t) => t.narrowed.includes("closing"))) {
        for (const pageFooter of [false, true]) {
          const d = sampleQuote({ lines: quoteLines(16), liabilityText: WRAPPING, notes: LONG_NOTES });
          const { group } = await renderQuote(d, quoteCfg(turn.layout, { pageFooter }));
          expect(breaksAcross(group, "closing"), `${turn.name}, page line ${pageFooter}`).toBe(true);
        }
      }
    }, 60_000);
  });
});

// ---------------------------------------------------------------------------------------------
// The flow's seed ids (design 2026-11-12 §5.3; since quote canvas PR 2). Under `seedIds` the flow
// marks its header pieces (a wrapper stack carrying the id, its end mark inside it, before its bottom
// margin; the logo's id on its image, its end mark after it), its one-node blocks (their marks inside
// the node's own vertical margins), its lines (top-level sibling marks, ABOVE the first grid row's
// 2 pt) and its liability (top-level sibling marks, ABOVE its kept 10 pt), and lays out exactly as it
// does without them.
// ---------------------------------------------------------------------------------------------

describe("the flow's seed ids (design 2026-11-12 §5.3)", () => {
  const PIECES = ["title", "company_name", "company_address", "quote_number"];
  const SECTIONS = ["parties", "intro", "column_header", "lines", "closing", "liability"];
  const LOGO_URI = `data:image/jpeg;base64,${TINY_JPEG.toString("base64")}`;
  const PLACEMENTS = ["header-left", "header-center", "header-right"] as const;
  /** The centre column's width on the Standard: the content less the two side columns and their gaps. */
  const CENTRE_W = QUOTE_WIDTHS.content - 2 * QUOTE_WIDTHS.headerSide - 2 * QUOTE_WIDTHS.headerGap;

  const seedDef = (d: QuotePdfData, config: TemplateConfig, logoUri?: string) =>
    buildQuoteDefinition(d, config, logoUri, { seedIds: true });
  async function laidOut(def: ReturnType<typeof buildQuoteDefinition>) {
    const { pdf, groups } = await renderSheetGroupsWithPositions([def]);
    return { pdf, group: groups[0] };
  }
  const every = (group: Group, id: string) => group.positions.filter((n) => n.id === id);
  /** A laid-out mark's top, which the case requires on page 1. */
  const top = (group: Group, id: string): number => {
    const node = at(group, id);
    expect(node.page, id).toBe(1);
    return node.top;
  };
  const withLogo = (placement: (typeof PLACEMENTS)[number]) => cfg({ logo: { placement, width: 80 } });
  /** The Standard with its sections complete, edited. */
  const edited = (edit: (c: TemplateConfig) => void): TemplateConfig => {
    const c = cfg();
    c.sections = completeSections(QUOTE_CONTRACT, c.sections);
    edit(c);
    return c;
  };
  const sectionOf = (c: TemplateConfig, key: string) => c.sections.find((s) => s.key === key)!;

  // Green on arrival (with no option the four-argument call is the three-argument one); it reds when a
  // seed wrapper moves what it wraps: a piece's or a one-node section's vertical margin kept on the
  // node as well as on its wrapper (checked by mutation).
  it("the seed lays out exactly as the flow: every run at the same place, the same strokes and the same pictures", async () => {
    for (const [config, uri] of [[cfg(), undefined], ...PLACEMENTS.map((p) => [withLogo(p), LOGO_URI] as const)] as const) {
      const flow = await renderPdf(buildQuoteDefinition(richQuote(), config, uri));
      const { pdf } = await laidOut(seedDef(richQuote(), config, uri));
      const a = textRunsWithY(flow);
      const b = textRunsWithY(pdf);
      expect(b.map((page) => page.map((r) => r.text))).toEqual(a.map((page) => page.map((r) => r.text)));
      a.forEach((page, p) => page.forEach((run, i) => {
        expect(Math.abs(b[p][i].x - run.x), `${run.text} x`).toBeLessThanOrEqual(MARK_TOL);
        expect(Math.abs(b[p][i].y - run.y), `${run.text} y`).toBeLessThanOrEqual(MARK_TOL);
      }));
      expect(strokedLines(pdf)).toEqual(strokedLines(flow));
      expect(paintedImages(flow).flat(), "the flow's pictures").toHaveLength(uri === undefined ? 0 : 1);
      expect(paintedImages(pdf)).toEqual(paintedImages(flow));
    }
  }, 60_000);

  // Green on arrival (pin): red when the flow branch reads the option's absence as anything but off.
  it("an empty options object, and seedIds false, are the plain definition, and no flow or canvas print carries a seed id (pin)", () => {
    const ids = (def: unknown) => JSON.stringify(def).match(/"seed:[^"]*"/g) ?? [];
    for (const [config, uri] of [[cfg(), undefined], ...PLACEMENTS.map((p) => [withLogo(p), LOGO_URI] as const)] as const) {
      const plain = buildQuoteDefinition(richQuote(), config, uri);
      expect(buildQuoteDefinition(richQuote(), config, uri, {})).toEqual(plain);
      expect(buildQuoteDefinition(richQuote(), config, uri, { seedIds: false })).toEqual(plain);
      expect(ids(plain)).toEqual([]);
    }
    // The canvas branch ignores the option.
    expect(ids(buildQuoteDefinition(richQuote(), quoteCfg(standardQuoteLayout()), undefined, { seedIds: true }))).toEqual([]);
  });

  it.each([["no logo", undefined], ...PLACEMENTS.map((p) => [p, p] as const)] as const)(
    "with %s the seed's definition holds every piece's, section's and end mark's id, each laid out once, and no text node carries one",
    async (_name, placement) => {
      const def = placement === undefined ? seedDef(richQuote(), cfg()) : seedDef(richQuote(), withLogo(placement), LOGO_URI);
      const { group } = await laidOut(def);
      const pieces = placement === undefined ? PIECES : [...PIECES, "logo"];
      const ids = [
        ...pieces.flatMap((p) => [QUOTE_SEED_IDS.piece(p), QUOTE_SEED_IDS.end(p)]),
        ...SECTIONS.flatMap((s) => [QUOTE_SEED_IDS.start(s), QUOTE_SEED_IDS.sectionEnd(s)]),
      ];
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(every(group, id).length, id).toBe(1);
      // Nothing else in the seed's namespace.
      expect(group.positions.filter((n) => n.id.startsWith("seed:")).length).toBe(ids.length);
      expect(nodesOf(def).filter((n) => "text" in n && "id" in n)).toEqual([]);
    },
    60_000,
  );

  it("the lines' start mark lies above the first grid row's 2 pt: their end less the lines laid out alone, and the column headers' 4 pt below the strip's end", async () => {
    // Red with the lines marked through `seedSection` (its own throw on several nodes), and with the
    // start mark placed after the first grid row's top margin.
    const d = richQuote();
    const nodes = QUOTE_FLOW.linesBlock(standardCtx(), d);
    expect(marginOf(nodes[0])[1]).toBe(2);
    const { group } = await laidOut(seedDef(d, cfg()));
    const start = top(group, QUOTE_SEED_IDS.start("lines"));
    const end = top(group, QUOTE_SEED_IDS.sectionEnd("lines"));
    // No grid row carries an id: the block's height is its nodes laid out alone, every margin kept.
    const alone = await aloneHeight(nodes, QUOTE_WIDTHS.content);
    expect(Math.abs(end - alone - start)).toBeLessThanOrEqual(MARK_TOL);
    // The strip's bottom margin lies between the column headers' end and the lines' start.
    const below = marginOf(QUOTE_FLOW.columnHeaderStrip(standardCtx())[0])[3];
    expect(below).toBe(4);
    expect(Math.abs(start - top(group, QUOTE_SEED_IDS.sectionEnd("column_header")) - below)).toBeLessThanOrEqual(MARK_TOL);
  }, 60_000);

  // Each one-node section's marks stand at its node's own top and bottom (`seedSection`), and between
  // two sections lie exactly the margins the seed keeps outside their marks: the previous block's
  // bottom (a one-node section's; the lines keep theirs inside their own marks) and this node's top.
  // Red with seedSection's top margin left on the node and the wrapper at [0,0,0,b] (the intro's start
  // 2 pt and the closing's 18 pt high of their nodes), and with any of the four marked through
  // `seedSiblings` (their margins inside the marks: 8, 6, 4 and 18 pt) (each checked by mutation).
  const ONE_NODE: Record<string, (d: QuotePdfData) => Content> = {
    parties: (d) => QUOTE_FLOW.partiesBlock(standardCtx(), d)[0],
    intro: (d) => QUOTE_FLOW.introBlock(d)[0],
    column_header: () => QUOTE_FLOW.columnHeaderStrip(standardCtx())[0],
    closing: (d) => QUOTE_FLOW.closingBlock(standardCtx(), d)[0],
  };
  /** The section before each, and the bottom margin it keeps outside its own marks. */
  const BEFORE: Record<string, { key: string; bottom: (d: QuotePdfData) => number } | null> = {
    parties: null,
    intro: { key: "parties", bottom: (d) => marginOf(ONE_NODE.parties(d))[3] },
    column_header: { key: "intro", bottom: (d) => marginOf(ONE_NODE.intro(d))[3] },
    closing: { key: "lines", bottom: () => 0 },
  };
  it.each(Object.keys(ONE_NODE))("the %s section's marks stand at its node's own top and bottom, its top margin above its start", async (key) => {
    const d = richQuote();
    const node = ONE_NODE[key](d);
    // Every one of the four keeps a vertical margin the seed moves, so neither check is vacuous.
    expect(marginOf(node)[1] + marginOf(node)[3]).toBeGreaterThan(0);
    const { group } = await laidOut(seedDef(d, cfg()));
    const start = top(group, QUOTE_SEED_IDS.start(key));
    const end = top(group, QUOTE_SEED_IDS.sectionEnd(key));
    const alone = await aloneHeight([verticalsZeroed(node)], QUOTE_WIDTHS.content);
    expect(Math.abs(end - start - alone)).toBeLessThanOrEqual(MARK_TOL);
    const before = BEFORE[key];
    if (before === null) return;
    const gap = before.bottom(d) + marginOf(node)[1];
    expect(Math.abs(start - top(group, QUOTE_SEED_IDS.sectionEnd(before.key)) - gap)).toBeLessThanOrEqual(MARK_TOL);
  }, 60_000);

  describe("the liability", () => {
    it("with typed wording its start mark is exactly the kept 10 pt above its line's node", async () => {
      // Red with the liability marked through `seedSection` (its start mark 10 pt lower).
      const d = richQuote();
      const node = QUOTE_FLOW.liabilityBlock(d)[0];
      expect(marginOf(node)[1]).toBe(10);
      const { group } = await laidOut(seedDef(d, cfg()));
      const start = top(group, QUOTE_SEED_IDS.start("liability"));
      const end = top(group, QUOTE_SEED_IDS.sectionEnd("liability"));
      // The node has no id: its top is the end less its own height with its margins zeroed.
      const line = await aloneHeight([verticalsZeroed(node)], QUOTE_WIDTHS.content);
      expect(Math.abs((end - line) - start - marginOf(node)[1])).toBeLessThanOrEqual(MARK_TOL);
    }, 60_000);

    it("with blank wording both marks are reported, together, at the closing's end", async () => {
      // Red with the liability's marks dropped when its block is empty.
      const d = richQuote({ liabilityText: "" });
      expect(QUOTE_FLOW.liabilityBlock(d)).toEqual([]);
      const { group } = await laidOut(seedDef(d, cfg()));
      expect(every(group, QUOTE_SEED_IDS.start("liability"))).toHaveLength(1);
      expect(every(group, QUOTE_SEED_IDS.sectionEnd("liability"))).toHaveLength(1);
      const start = top(group, QUOTE_SEED_IDS.start("liability"));
      expect(top(group, QUOTE_SEED_IDS.sectionEnd("liability"))).toBe(start);
      // The closing keeps no bottom margin, so nothing lies between its end and the liability.
      expect(marginOf(QUOTE_FLOW.closingBlock(standardCtx(), d)[0])[3]).toBe(0);
      expect(Math.abs(start - top(group, QUOTE_SEED_IDS.sectionEnd("closing")))).toBeLessThanOrEqual(MARK_TOL);
    }, 60_000);
  });

  describe("the number's piece", () => {
    /** The right column's left: the content's right edge less the column. */
    const RIGHT = CANVAS_PAGE.margin + QUOTE_WIDTHS.content - QUOTE_WIDTHS.headerSide;

    it("with no logo reports the right column's left and the page's top", async () => {
      expect(RIGHT).toBe(418);
      const { group } = await laidOut(seedDef(richQuote(), cfg()));
      const piece = at(group, QUOTE_SEED_IDS.piece("quote_number"));
      expect(piece.page).toBe(1);
      expect(Math.abs(piece.left - RIGHT)).toBeLessThanOrEqual(MARK_TOL);
      // The flow's top margin is the canvas page's (pageMargins' 24).
      expect(Math.abs(piece.top - CANVAS_PAGE.margin)).toBeLessThanOrEqual(MARK_TOL);
      // Its box is its line alone: its end less its top is the number laid out alone in its column.
      const line = await aloneHeight([{ text: QUOTE_FLOW.numberText("Quotation Number:", richQuote()), fontSize: 11 }], QUOTE_WIDTHS.headerSide);
      expect(Math.abs(top(group, QUOTE_SEED_IDS.end("quote_number")) - piece.top - line)).toBeLessThanOrEqual(MARK_TOL);
    }, 60_000);

    it("with a header-right logo lies below the logo's end mark, in the same column", async () => {
      const { group } = await laidOut(seedDef(richQuote(), withLogo("header-right"), LOGO_URI));
      const piece = at(group, QUOTE_SEED_IDS.piece("quote_number"));
      const logoPiece = at(group, QUOTE_SEED_IDS.piece("logo"));
      const logoEnd = top(group, QUOTE_SEED_IDS.end("logo"));
      expect(Math.abs(logoPiece.top - CANVAS_PAGE.margin)).toBeLessThanOrEqual(MARK_TOL);
      expect(logoEnd).toBeGreaterThan(logoPiece.top);
      expect(Math.abs(piece.top - logoEnd)).toBeLessThanOrEqual(MARK_TOL);
      expect(Math.abs(piece.left - RIGHT)).toBeLessThanOrEqual(MARK_TOL);
      expect(Math.abs(logoPiece.left - RIGHT)).toBeLessThanOrEqual(MARK_TOL);
    }, 60_000);
  });

  it("company_name's piece top excludes its 2 pt top margin: the title's end plus that margin, and its box the name's line alone", async () => {
    const d = richQuote();
    const node = nodesOf(buildQuoteDefinition(d, cfg()).content).find((n) => n.text === d.company.name && n.fontSize === 13) as unknown as Content;
    expect(marginOf(node)[1]).toBe(2);
    const { group } = await laidOut(seedDef(d, cfg()));
    const piece = top(group, QUOTE_SEED_IDS.piece("company_name"));
    expect(Math.abs(piece - top(group, QUOTE_SEED_IDS.end("title")) - marginOf(node)[1])).toBeLessThanOrEqual(MARK_TOL);
    const line = await aloneHeight([verticalsZeroed(node)], CENTRE_W);
    expect(Math.abs(top(group, QUOTE_SEED_IDS.end("company_name")) - piece - line)).toBeLessThanOrEqual(MARK_TOL);
  }, 60_000);

  // A shape pin. pdfmake reports a stack's id at its first child's first line, below that child's top
  // margin, so a piece's margins left on the piece and not moved onto its wrapper lay out and report
  // the same: this case alone reds that. A piece's end mark placed after its bottom margin builds this
  // very definition for every quote piece, none of which has a bottom margin (an equivalent mutant,
  // recorded), so nothing here or on paper can red it.
  it("a piece's wrapper holds its vertical margins and ends with its end mark (pin)", () => {
    const d = richQuote();
    const wrapper = nodesOf(seedDef(d, cfg()).content).find((n) => n.id === QUOTE_SEED_IDS.piece("company_name"))!;
    expect(wrapper.margin).toEqual([0, 2, 0, 0]);
    const stack = wrapper.stack as Record<string, unknown>[];
    expect(stack).toHaveLength(2);
    expect(stack[0].text).toBe(d.company.name);
    expect(stack[0].margin).toEqual([0, 0, 0, 0]);
    expect(stack[1].id).toBe(QUOTE_SEED_IDS.end("company_name"));
  });

  it("company_address's one piece spans every address line", async () => {
    const d = richQuote();
    expect(QUOTE_FLOW.addressLines(d)).toHaveLength(2);
    const { group } = await laidOut(seedDef(d, cfg()));
    const piece = top(group, QUOTE_SEED_IDS.piece("company_address"));
    expect(Math.abs(piece - top(group, QUOTE_SEED_IDS.end("company_name")))).toBeLessThanOrEqual(MARK_TOL);
    const lines = QUOTE_FLOW.addressLines(d).map((text): Content => ({ text, fontSize: 10, alignment: "center" }));
    const alone = await aloneHeight(lines, CENTRE_W);
    expect(Math.abs(top(group, QUOTE_SEED_IDS.end("company_address")) - piece - alone)).toBeLessThanOrEqual(MARK_TOL);
  }, 60_000);

  it("with every column header hidden, the column headers' two marks are both reported, together", async () => {
    // Red with an empty section's marks dropped.
    const config = edited((c) => {
      const s = sectionOf(c, "column_header");
      s.fields = s.fields.map((f) => ({ ...f, visible: false }));
    });
    expect(QUOTE_FLOW.columnHeaderStrip(ctxFor(config))).toEqual([]);
    const { group } = await laidOut(seedDef(richQuote(), config));
    expect(every(group, QUOTE_SEED_IDS.start("column_header"))).toHaveLength(1);
    expect(every(group, QUOTE_SEED_IDS.sectionEnd("column_header"))).toHaveLength(1);
    expect(top(group, QUOTE_SEED_IDS.sectionEnd("column_header"))).toBe(top(group, QUOTE_SEED_IDS.start("column_header")));
  }, 60_000);

  it("quoteSeedStyle answers the flow's own size, weight and alignment for the four header fields, and null for a block's rows", () => {
    // Red with quote_number answered bold.
    const config = cfg({ fonts: { ...QUOTE_DEFAULT_CONFIG.fonts, headingSize: 22 } });
    expect(QUOTE_DEFAULT_CONFIG.fonts.headingSize).not.toBe(22);
    const d = sampleQuote();
    const nodes = nodesOf(buildQuoteDefinition(d, config).content);
    const flowStyle = (n: Record<string, unknown>) =>
      ({ size: n.fontSize, bold: n.bold === true, align: (n.alignment as string | undefined) ?? "left" });
    const byKey: Record<string, Record<string, unknown>> = {
      title: nodes.find((n) => n.text === "Quotation")!,
      company_name: nodes.find((n) => n.text === d.company.name)!,
      company_address: nodes.find((n) => n.text === QUOTE_FLOW.addressLines(d)[0])!,
      // The number's column: its text an array whose first run is the bold label (the label aside).
      quote_number: nodes.find((n) => Array.isArray(n.text) && (n.text[0] as { text?: string }).text === "Quotation Number: ")!,
    };
    for (const [key, node] of Object.entries(byKey)) {
      expect(node, key).toBeDefined();
      expect(quoteSeedStyle(key, config.fonts), key).toEqual(flowStyle(node));
    }
    expect(quoteSeedStyle("title", config.fonts)!.size).toBe(22);
    expect(quoteSeedStyle("bill_to", config.fonts)).toBeNull();
    expect(quoteSeedStyle("col_qty", config.fonts)).toBeNull();
  });
});
