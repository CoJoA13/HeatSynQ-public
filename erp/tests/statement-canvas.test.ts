import { describe, it, expect } from "vitest";
import {
  buildStatementDefinition, statementCanvasItemContent, statementSeedStyle, STATEMENT_BOXED_FIELDS, STATEMENT_FLOW,
  STATEMENT_SEED_IDS, STATEMENT_WIDTHS, type StatementCtx, type StatementData,
} from "@/server/pdf/statement";
import {
  layOutSheetGroups, LAYOUT, renderPdf, renderSheetGroupsWithPositions, TABLE_LAYOUTS, type LaidOutNode,
} from "@/server/pdf/render";
import {
  assembleCanvasSheet, CANVAS_IDS, defaultLabelOf, logoContent, strokeContent, textContent,
} from "@/server/pdf/canvas-sheet";
import { canvasBlockOf, mark } from "@/server/pdf/canvas-nodes";
import { statementItemContent } from "@/server/statement-canvas";
import { canvasProfile, pageFoot, tablesByY, topMargin, validateCanvasLayout } from "@/lib/template-canvas";
import {
  STATEMENT_CANVAS, STATEMENT_CONTRACT, STATEMENT_LEAST_WIDTHS, STATEMENT_ROW_FLOOR,
} from "@/lib/template-contracts/statement";
import {
  FONT_FAMILIES, NEGATIVE_STYLES, STATEMENT_DEFAULT_CONFIG, completeSections, validateConfig, type FontFamily,
  type TemplateConfig,
} from "@/lib/template-contracts/index";
import {
  CANVAS_PAGE, type CanvasColumn, type CanvasItem, type CanvasLayout, type CanvasTextStyle,
} from "@/lib/template-contracts/canvas";
import { AGING_BUCKET_LABELS } from "@/lib/ar-constants";
import type { Content } from "pdfmake/interfaces";
import { pageCount, paintedImages, runFonts, strokedLines, textLinesWithY, textRunsWithY, TINY_JPEG } from "./helpers/pdf";
import { barcode, layoutOf, logo } from "./helpers/canvas-fixtures";
import { measured } from "./helpers/measured";
import { statementFlowLeastWidths } from "./helpers/statement-flow-widths";
import {
  richStatement, sampleStatement, standardStatementLayout, statementField, statementTable, type StatementTable,
} from "./helpers/statement-canvas-fixtures";
import { bandClipLayout, expectBandClip } from "./helpers/band-clip";

/**
 * The statement's canvas (design 2026-11-11; since statement canvas PR 2). The flow exports its widths
 * (`STATEMENT_WIDTHS`), its page constants (`STATEMENT_PAGE`), its boxed fields
 * (`STATEMENT_BOXED_FIELDS`) and its builders (`STATEMENT_FLOW`) with no change to its paper
 * (tests/statement-flow-oracle.test.ts); the profile's least widths and boxed fields (PR 1 literals)
 * are held to those exports here. The field families (`statementItemContent`,
 * src/server/statement-canvas.ts), each held to the flow's print of the same key. A canvas
 * statement (`buildStatementDefinition` branching on `config.layout`), its five blocks, the held
 * Bill To, the finance block's kept 2 pt, the lens and the branch. The statement's ruled
 * paper (#162's finance line, ruling 8's Unapplied column, R14's stacked bill-to, the open items'
 * blank due dates and negative money, the date knob) printed on a canvas as the flow prints it.
 * A canvas statement that grows and pages (each block riding the one above it, a 300-item
 * statement's continuation pages, its last page, its page line, and a wrapped customer line repeated).
 *
 * A BLOCK'S RENDERED TOP is read as the measure reads it (`canvasMeasure`, src/server/canvas-measure.ts):
 * the first block's drawn top (the spacer to the first table ends there), every later block's where
 * the region above it ends (its `CANVAS_IDS.regionEnd` mark). A block's rendered height is its
 * `CANVAS_IDS.end` mark less that top. Its own id (`CANVAS_IDS.table`) is not its top: pdfmake reports
 * a stack where its first laid-out line starts, UNDER that line's own top margin (the Bill To's label
 * 6 pt down, as tests/cert-canvas.test.ts and tests/invoice-canvas.test.ts record), so no top or
 * height here is read from a block's id.
 */

/** A stand-in logo: the builder places the string it is handed and reads nothing of it. */
const LOGO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("the flow's widths hold the profile (design 2026-11-11 §4.1, §12)", () => {
  const derived = statementFlowLeastWidths();

  it("names a least width for exactly the open items and the two totals blocks (pin)", () => {
    expect(Object.keys(STATEMENT_LEAST_WIDTHS)).toEqual(["open_items", "finance_charge", "total"]);
    expect(Object.keys(derived)).toEqual(Object.keys(STATEMENT_LEAST_WIDTHS));
  });

  it("the least widths are their derivation from the flow's widths", () => {
    expect(STATEMENT_LEAST_WIDTHS).toEqual(derived);
    // The design's figure (§4.1), so the derivation itself cannot drift with the flow unnoticed.
    expect(derived).toEqual({ open_items: 49.5, finance_charge: 316.5, total: 316.5 });
  });

  it("the profile's boxed fields are the flow's", () => {
    expect([...STATEMENT_BOXED_FIELDS]).toEqual(canvasProfile(STATEMENT_CONTRACT).boxedFields);
  });

  it("STATEMENT_FLOW hands on STATEMENT_BOXED_FIELDS and STATEMENT_WIDTHS themselves (pin)", () => {
    expect(STATEMENT_FLOW.boxedFields).toBe(STATEMENT_BOXED_FIELDS);
    expect(STATEMENT_FLOW.widths).toBe(STATEMENT_WIDTHS);
  });
});

/** One `columns` node of a definition: its column widths, its gap, its own margin and each column's
 *  margin (null where none is set). */
type ColumnsShape = { widths: unknown[]; gap: unknown; margin: unknown; margins: unknown[] };

/** Every `columns` node of `node`, in pre-order (the invoice's walker, tests/invoice-canvas.test.ts,
 *  reading whole margins). */
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

describe("the flow prints at the widths it exports", () => {
  // A literal left in a flow block reds this as soon as its constant changes (a literal of another
  // value reds it now), where a changed constant read on both sides moves them together. Its blind
  // spot, and the oracle's: a literal of the SAME value as its constant (250 for `remitTo`) stays
  // green in both; only a different literal reds it (the invoice PR 2 final wave's standing finding 5).
  const W = STATEMENT_WIDTHS;
  const identity = {
    widths: ["*", W.remitTo], gap: W.identityGap, margin: [0, 0, 0, 10], margins: [[W.identityIndent, 0, 0, 0], null],
  };
  const total = (top: number) => ({
    widths: ["*", W.totalsLabel, W.totalsAmount], gap: W.totalsGap, margin: [0, top, 0, 0], margins: [null, null, null],
  });

  it("every columns row of the Standard's content, a finance charge assessed, takes its widths, gaps and indent from STATEMENT_WIDTHS", () => {
    // Exact and in order: the identity row (its left stack indented, the Remit To column), then the
    // finance line and the Total Due line.
    expect(columnsShapes(buildStatementDefinition(sampleStatement({ financeCharge: 12.5 })).content)).toEqual([
      identity, total(2), total(6),
    ]);
  });

  it("STATEMENT_WIDTHS.content is the letter page's width less the flow's own side margins", () => {
    // Red when `content` is retyped (560, say) or when a side margin of the flow's `pageMargins`
    // (pdf/statement.ts) moves while `content` stays: the figures derived from `content` would then
    // stand for a column the flow no longer prints.
    const def = buildStatementDefinition(sampleStatement());
    expect(def.pageSize).toBe("LETTER");
    const [left, , right] = def.pageMargins as [number, number, number, number];
    expect(W.content).toBe(CANVAS_PAGE.width - left - right);
  });

  it("a side logo's header row takes its gap from STATEMENT_WIDTHS", () => {
    const config: TemplateConfig = (() => {
      const c = structuredClone(STATEMENT_DEFAULT_CONFIG);
      c.logo = { placement: "header-left", width: 90 };
      return validateConfig("STATEMENT", c);
    })();
    expect(columnsShapes(buildStatementDefinition(sampleStatement(), config, LOGO).content)).toEqual([
      { widths: [90, "*"], gap: W.headerLogoGap, margin: null, margins: [null, null] },
      identity,
      total(6),
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// The field families. `textLinesWithY` and `textRunsWithY` report a baseline from the
// page's BOTTOM edge; a run's x is its start, and `textLinesWithY` collapses a line's spacing.
// ---------------------------------------------------------------------------------------------

const cfg = (over: Partial<TemplateConfig> = {}): TemplateConfig => ({ ...structuredClone(STATEMENT_DEFAULT_CONFIG), ...over });

/** The ctx the flow builds from `config` (its own `ctxOf`), so the date knob and the sections are the
 *  config's. */
const ctxFor = (config: TemplateConfig): StatementCtx =>
  STATEMENT_FLOW.ctxOf(config, completeSections(STATEMENT_CONTRACT, config.sections), null);

/** A sheet of these items alone (no block), rendered. */
async function renderItems(
  items: CanvasItem[], config: TemplateConfig = cfg(), d: StatementData = sampleStatement(), flow = STATEMENT_FLOW,
): Promise<Buffer> {
  return renderPdf(assembleCanvasSheet({
    layout: layoutOf(items), pageFooter: false, fonts: config.fonts,
    itemContent: statementItemContent(ctxFor(config), d, flow), tableBlock: () => null,
  }));
}

/** Page 1's printed lines. */
const linesOf = async (pdf: Promise<Buffer>) => textLinesWithY(await pdf)[0].map((l) => l.text).filter((t) => t !== "");

const isBold = (font: string): boolean => font.endsWith("-Medium") || font.endsWith("-Bold");

/** The flow's config with these fields of a section hidden. */
function hiding(section: string, ...fields: string[]): TemplateConfig {
  const config = cfg();
  config.sections = completeSections(STATEMENT_CONTRACT, config.sections).map((sc) => sc.key !== section ? sc : {
    ...sc, fields: sc.fields.map((f) => fields.includes(f.key) ? { ...f, visible: false } : f),
  });
  return config;
}

/** A line item's box: wide enough that no line the cases print wraps. */
const LINE_BOX = { x: 24, y: 100, w: 400, h: 12 };

describe("the statement's field families (design 2026-11-11 §4.2)", () => {
  const d = sampleStatement();
  const customerLine = `Customer: ${d.customer.code} — ${d.customer.name}`;

  /**
   * Each field key, the lines its item prints alone, and the flow print they are held to. The flow
   * prints the identity's left lines beside the Remit To box, so a key whose flow line could share
   * a baseline with the other column's is held to the flow with that column hidden, where it prints
   * alone on its baseline. So each line is one of the oracle's lines WHOLE: a short or partial text
   * cannot pass by containment. The company's name prints twice in the flow (the header and the
   * Remit To box), so the canvas's own lines are compared in order (`toEqual`), never by position in
   * the flow's.
   */
  const KEYS: { key: string; oracle: () => TemplateConfig; lines: string[]; w?: number }[] = [
    { key: "title", oracle: cfg, lines: ["Statement"] },
    { key: "company_name", oracle: cfg, lines: [d.company.name] },
    { key: "customer", oracle: () => hiding("identity", "remit_to"), lines: [customerLine] },
    { key: "statement_date", oracle: () => hiding("identity", "remit_to"), lines: ["Statement Date: August 8, 2026"] },
    {
      key: "remit_to", oracle: () => hiding("identity", "customer", "statement_date", "bill_to"), w: STATEMENT_WIDTHS.remitTo,
      lines: ["Remit To", d.remitTo.name, ...d.remitTo.lines],
    },
  ];

  it("the five keys are the contract's field keys less the profile's notFields and the aging strip's columns (pin)", () => {
    const aging = STATEMENT_CONTRACT.sections.find((s) => s.key === "aging")!.fields.map((f) => f.key);
    const placeable = STATEMENT_CONTRACT.sections.flatMap((s) => s.fields.map((f) => f.key))
      .filter((key) => !STATEMENT_CANVAS.notFields.includes(key) && !aging.includes(key));
    expect(KEYS.map((k) => k.key).sort()).toEqual([...placeable].sort());
  });

  it.each(KEYS)("$key prints the flow's text for its key, line by line, whole", async ({ key, oracle, lines, w }) => {
    const flow = await linesOf(renderPdf(buildStatementDefinition(d, oracle())));
    const printed = await linesOf(renderItems([statementField(key, { box: { ...LINE_BOX, w: w ?? LINE_BOX.w } })]));
    expect(printed).toEqual(lines);
    for (const line of lines) expect(flow, line).toContain(line);
  });

  it("a typed title prints in place of \"Statement\", and a typed customer label prints with the glue", async () => {
    // Red when the item's typed label is ignored (the contract's default printed instead).
    const items = [
      statementField("title", { label: "Account Statement", box: { ...LINE_BOX, h: 24 } }),
      statementField("customer", { label: "Account:", box: { ...LINE_BOX, y: 200 } }),
    ];
    expect(await linesOf(renderItems(items))).toEqual([
      "Account Statement", `Account: ${d.customer.code} — ${d.customer.name}`,
    ]);
  });

  it("every statement date placed prints the date knob's date", async () => {
    // "MMM - DD - YYYY" is neither the stored ISO date nor the default long style, so a slot reading
    // `d.asOf` raw cannot print it (never "YYYY-MM-DD", under which the knob answers the ISO date).
    const config = cfg({ formats: { ...STATEMENT_DEFAULT_CONFIG.formats, dateFormat: "MMM - DD - YYYY" } });
    const date = STATEMENT_FLOW.makeLongDate(config.formats)(d.asOf);
    expect(date).toBe("Aug - 08 - 2026");
    const items = [
      statementField("statement_date", { id: "date-1", box: { ...LINE_BOX } }),
      statementField("statement_date", { id: "date-2", box: { ...LINE_BOX, y: 300 } }),
    ];
    expect(await linesOf(renderItems(items, config))).toEqual([`Statement Date: ${date}`, `Statement Date: ${date}`]);
  });

  it("an identity line's label is bold and its value takes the item's weight, at the item's size", async () => {
    for (const bold of [true, false]) {
      const runs = runFonts(await renderItems([statementField("customer", {
        box: { ...LINE_BOX }, style: { size: 12, bold, align: "left" },
      })]));
      expect(runs.map((r) => r.text).join(" ").replace(/\s+/g, " ")).toBe(customerLine);
      // A run is the label's while the runs so far, joined, are still a prefix of "Customer:" (by
      // position, never by substring: a value run's text could sit inside the label's).
      const LABEL = "Customer:";
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

  it("the company name, right-aligned, ends within 0.5 pt of its box's right", async () => {
    // Red when the item's alignment is dropped. Its natural width is measured alone, the auto column
    // before an END marker (the certification's case), in the same face, size and weight.
    const box = { x: 24, y: 100, w: 400, h: 18 };
    const runs = runFonts(await renderItems([statementField("company_name", { box, style: { size: 15, bold: true, align: "right" } })]));
    for (const r of runs) {
      expect(r.size).toBe(15);
      expect(isBold(r.font)).toBe(true);
    }
    const natural = textRunsWithY(await renderPdf({
      pageSize: "LETTER", pageMargins: [24, 24, 24, 24], defaultStyle: { font: STATEMENT_DEFAULT_CONFIG.fonts.family, fontSize: 10 },
      content: [{ columns: [{ width: "auto", text: d.company.name, fontSize: 15, bold: true }, { width: "auto", text: "END" }], columnGap: 0 }],
    }))[0];
    const width = natural.find((r) => r.text === "END")!.x - natural[0].x;
    const start = Math.min(...runs.map((r) => r.x));
    expect(Math.abs(start + width - (box.x + box.w))).toBeLessThanOrEqual(0.5);
  });

  it("the Remit To box drawn 300 wide at x 24 prints its border at the item's edges, its label at the item's 15 bold, its lines at 10", async () => {
    // 300, not the flow's 250 (`STATEMENT_WIDTHS.remitTo`), so a box placed at the flow's width reds.
    const box = { x: 24, y: 100, w: 300, h: 60 };
    const pdf = await renderItems([statementField("remit_to", { box, style: { size: 15, bold: true, align: "left" } })]);
    const strokes = strokedLines(pdf)[0];
    const down = strokes.filter((s) => s.x1 === s.x2).map((s) => s.x1).sort((a, b) => a - b);
    expect(down).toHaveLength(2);
    expect(Math.abs(down[0] - box.x)).toBeLessThan(1);
    expect(Math.abs(down[1] - (box.x + box.w))).toBeLessThan(1);
    const across = strokes.filter((s) => s.y1 === s.y2);
    expect(across).toHaveLength(2);
    for (const s of across) expect(Math.abs(Math.abs(s.x2 - s.x1) - box.w)).toBeLessThan(1);
    const runs = runFonts(pdf);
    const linesAt = (size: number, bold: boolean) => runs.filter((r) => r.size === size && isBold(r.font) === bold).map((r) => r.text);
    expect(linesAt(15, true).join(" ")).toBe("Remit To");
    expect(linesAt(10, true).join(" ")).toBe(d.remitTo.name);
    expect(linesAt(10, false).join(" ")).toBe(d.remitTo.lines.join(" "));
    expect(runs).toHaveLength(linesAt(15, true).length + linesAt(10, true).length + linesAt(10, false).length);
  });

  it("the Remit To item, handed a flow whose boxedFields is empty, prints no border and no Remit To text", async () => {
    // The boxed branch reads `flow.boxedFields`, never the key: a branch keyed on "remit_to" itself
    // still borders the item here.
    const item = statementField("remit_to", { box: { x: 24, y: 100, w: 300, h: 60 }, style: { size: 13, bold: true, align: "left" } });
    const pdf = await renderItems([item], cfg(), d, { ...STATEMENT_FLOW, boxedFields: [] });
    expect(strokedLines(pdf)[0]).toEqual([]);
    expect(await linesOf(Promise.resolve(pdf))).toEqual([]);
    // And the flow's own list borders it, so the empty list is what removed it.
    expect(strokedLines(await renderItems([item]))[0].length).toBeGreaterThan(0);
  });

  it("the identity lines' glue and values are the flow's own, read from the flow handed in", async () => {
    // A stub flow whose glue and values differ from STATEMENT_FLOW's: a retyped copy here would print
    // STATEMENT_FLOW's paper, which looks the same on the real flow.
    const stub = {
      ...STATEMENT_FLOW,
      identityGlue: { customer: " ~ ", statement_date: " ~ " },
      identityValue: (key: "customer" | "statement_date") => `stub ${key}`,
    };
    const items = [
      statementField("customer", { box: { ...LINE_BOX } }),
      statementField("statement_date", { box: { ...LINE_BOX, y: 200 } }),
    ];
    expect(await linesOf(renderItems(items, cfg(), d, stub))).toEqual([
      "Customer: ~ stub customer", "Statement Date: ~ stub statement_date",
    ]);
  });

  it("the Bill To, a block's field, an aging column, a text block and a barcode print nothing", async () => {
    // Red when the families' default arm prints anything.
    const content = statementItemContent(ctxFor(cfg()), d, STATEMENT_FLOW);
    const aging = STATEMENT_CONTRACT.sections.find((s) => s.key === "aging")!.fields.map((f) => f.key);
    for (const key of ["bill_to", "total_due"]) expect(STATEMENT_CANVAS.notFields).toContain(key);
    expect(aging).toContain("aging_net");
    const nothing: CanvasItem[] = [
      { id: "wording", kind: "textBlock", key: "wording", box: { x: 24, y: 100, w: 400, h: 40 },
        anchor: { kind: "page-top" }, repeat: false, style: { size: 9.5, bold: false, align: "left" } },
      ...[...STATEMENT_CANVAS.notFields, ...aging].map((key) => statementField(key, { id: `f-${key}`, box: { x: 24, y: 200, w: 400, h: 12 } })),
      barcode({ box: { x: 24, y: 300, w: 200, h: 40 } }),
    ];
    for (const item of nothing) expect(content(item), item.kind === "field" ? item.key : item.kind).toBeNull();
    expect(await linesOf(renderItems(nothing))).toEqual([]);
  });

  it("a text, a logo, a line and a box route to the shared helpers", () => {
    // Red when an arm routes to nothing (the text arm answering null, say).
    const uri = `data:image/jpeg;base64,${TINY_JPEG.toString("base64")}`;
    const content = statementItemContent(ctxFor(cfg()), d, STATEMENT_FLOW, uri);
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
    expect(statementItemContent(ctxFor(cfg()), d, STATEMENT_FLOW)(pic)).toBeNull();
    expect(content(line)).toEqual(strokeContent(line as Parameters<typeof strokeContent>[0]));
    expect(content(box)).toEqual(strokeContent(box as Parameters<typeof strokeContent>[0]));
  });
});

// ---------------------------------------------------------------------------------------------
// A canvas statement: the five blocks, the held Bill To, the finance block's kept margin,
// the lens and the branch. COORDINATES: `renderSheetGroupsWithPositions`' and `layOutSheetGroups`'
// positions and the layout's boxes are top-down page coordinates; `textRunsWithY` reports a baseline
// from the page's BOTTOM edge, which `runsOf` turns into a top-down `top`. Tops and heights follow
// the rule in this file's header. Configs carry the layout unvalidated by `validateConfig` (written
// while the statement stood outside CANVAS_PRINTS, which the same PR later changed); a layout is judged by
// `validateCanvasLayout`.
// ---------------------------------------------------------------------------------------------

const PAGE_HEIGHT = CANVAS_PAGE.height;
const BLOCKS: StatementTable[] = ["bill_to", "open_items", "aging", "finance_charge", "total"];
type TableItem = Extract<CanvasItem, { kind: "table" }>;
type Group = { positions: LaidOutNode[] };
/** Mark-to-mark positions (the Global Constraints). */
const MARK_TOL = 0.01;

/** The Standard's config carrying `layout`. */
const stmtCfg = (layout: CanvasLayout | null, over: Partial<TemplateConfig> = {}): TemplateConfig =>
  ({ ...structuredClone(STATEMENT_DEFAULT_CONFIG), ...over, layout });

async function renderStatement(d: StatementData, config: TemplateConfig, logoDataUri?: string) {
  const def = buildStatementDefinition(d, config, logoDataUri);
  const { pdf, groups } = await renderSheetGroupsWithPositions([def]);
  return { pdf, def, group: groups[0] };
}

/** The laid-out node under an id, which the case requires. */
function at(group: Group, id: string): LaidOutNode {
  const found = group.positions.find((node) => node.id === id);
  if (found === undefined) throw new Error(`no laid-out node "${id}"`);
  return found;
}

const tableOf = (layout: CanvasLayout, key: StatementTable): TableItem =>
  layout.items.find((item): item is TableItem => item.kind === "table" && item.key === key)!;
const blockBox = (layout: CanvasLayout, key: StatementTable) => tableOf(layout, key).box;

/** A layout's block, replaced. */
function withTable(layout: CanvasLayout, key: StatementTable, change: (item: TableItem) => TableItem): CanvasLayout {
  return layoutOf(layout.items.map((item) => (item.kind === "table" && item.key === key ? change(item) : item)));
}

/** The block before `key` in the layout's drawn order (null for the first). */
function above(layout: CanvasLayout, key: StatementTable): StatementTable | null {
  const tables = tablesByY(layout);
  const i = tables.findIndex((t) => t.key === key);
  return i <= 0 ? null : (tables[i - 1].key as StatementTable);
}

/** A block's rendered top (the header's rule). */
function blockTop(group: Group, layout: CanvasLayout, key: StatementTable): number {
  const prev = above(layout, key);
  return prev === null ? blockBox(layout, key).y : at(group, CANVAS_IDS.regionEnd(prev)).top;
}
/** A block's rendered height: its end mark less its rendered top. */
const blockHeight = (group: Group, layout: CanvasLayout, key: StatementTable): number =>
  at(group, CANVAS_IDS.end(key)).top - blockTop(group, layout, key);

/** The drawn distance between a block and the block above it. */
function drawnGap(layout: CanvasLayout, key: StatementTable): number {
  const a = blockBox(layout, above(layout, key)!);
  return blockBox(layout, key).y - a.y - a.h;
}

/** Page `page`'s text runs starting with `needle`, each with its x and its top-down baseline. */
const runsOf = (pdf: Buffer, needle: string, page = 1) =>
  textRunsWithY(pdf)[page - 1].filter((r) => r.text.trim().startsWith(needle)).map((r) => ({ x: r.x, top: PAGE_HEIGHT - r.y }));
/** The x of "Document" and of "Open" on page 1's open-items heading line: the one baseline holding a
 *  run starting with each, so a run elsewhere on the page starting with either word cannot stand in. */
function headingXs(pdf: Buffer): { document: number; open: number } {
  const opens = runsOf(pdf, "Open");
  const lines = runsOf(pdf, "Document").flatMap((d) =>
    opens.filter((o) => Math.abs(o.top - d.top) <= 0.01).map((o) => ({ document: d.x, open: o.x })));
  expect(lines, "one heading line holding a Document and an Open run").toHaveLength(1);
  return lines[0];
}

/** Page `page`'s printed lines' text (`textLinesWithY` groups a line's word runs for its text alone). */
const lineTexts = (pdf: Buffer, page = 1): string[] => textLinesWithY(pdf)[page - 1].map((line) => line.text);

/** Every node of a definition, depth first. */
function nodesOf(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) { for (const n of node) nodesOf(n, out); return out; }
  out.push(node as Record<string, unknown>);
  for (const value of Object.values(node as Record<string, unknown>)) nodesOf(value, out);
  return out;
}

/** The height `nodes` lay out at ALONE, in a column `w` wide, between two marks, `{ stack: [mark(a),
 *  ...nodes, mark(b)] }` (a JSON copy: pdfmake uses up a node it lays out), in the config's face. */
async function aloneHeight(nodes: Content[], w: number, config: TemplateConfig = STATEMENT_DEFAULT_CONFIG): Promise<number> {
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

/** A flow node with its vertical margins zeroed (the wrapper rule's one-node arm), or only its bottom. */
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

/** The flow's ctx over the Standard's config. */
const standardCtx = () => ctxFor(STATEMENT_DEFAULT_CONFIG);
const BILL_TO_LABEL = defaultLabelOf(STATEMENT_CONTRACT, "bill_to");
const withFinance = (over: Partial<StatementData> = {}) => sampleStatement({ financeCharge: 12.34, ...over });
const r14 = (d: StatementData): StatementData => ({ ...d, customer: { ...d.customer, billTo: ["Accounts Payable", ...d.customer.billTo] } });
const oneLineBillTo = (d: StatementData): StatementData => ({ ...d, customer: { ...d.customer, billTo: ["Customer"] } });

describe("a canvas statement (design 2026-11-11 §4.4, §5.2)", () => {
  const layout = standardStatementLayout();

  it("the standard layout passes the canvas rules (pin)", () => {
    expect(() => validateCanvasLayout(layout, STATEMENT_CONTRACT, { pageFooter: false })).not.toThrow();
  });

  it("prints its five blocks in y order on page 1, the first at its drawn top and each later one riding the block above it by the drawn distance", async () => {
    // Red with no branch (a layout prints the flow: no canvas id at all), and when a block is left
    // unwrapped by its drawn place.
    const d = withFinance();
    const { def, group } = await renderStatement(d, stmtCfg(layout));
    const nodes = nodesOf(def);
    for (const key of BLOCKS) {
      expect(nodes.filter((n) => n.id === CANVAS_IDS.table(key)), key).toHaveLength(1);
      expect(at(group, CANVAS_IDS.table(key)).page, key).toBe(1);
      expect(at(group, CANVAS_IDS.end(key)).page, key).toBe(1);
    }
    // The first block's id reports its first laid-out line, the label UNDER its own 6 pt top margin:
    // so the block itself starts at its drawn top.
    const labelTop = marginOf(STATEMENT_FLOW.billToStack(BILL_TO_LABEL, d)[0])[1];
    expect(labelTop).toBeGreaterThan(0);
    expect(Math.abs(at(group, CANVAS_IDS.table("bill_to")).top - (blockBox(layout, "bill_to").y + labelTop))).toBeLessThanOrEqual(MARK_TOL);
    for (const key of BLOCKS.slice(1)) {
      const prev = above(layout, key)!;
      expect(Math.abs(blockTop(group, layout, key) - (at(group, CANVAS_IDS.end(prev)).top + drawnGap(layout, key))), key)
        .toBeLessThanOrEqual(MARK_TOL);
    }
  });

  it("the canvas definition is pure JSON, carries no overflow margin and no id on a text node; a null layout's carries no canvas id", () => {
    // Red when `tableBlock` puts an id on a flow text node: a mutant giving the Bill To's label one
    // reds the third assertion. The other assertions were not mutated.
    const def = buildStatementDefinition(withFinance(), stmtCfg(layout));
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
    expect(def.continuationHeaderSpec).not.toHaveProperty("overflowTopMargin");
    expect(nodesOf(def).filter((n) => "text" in n && "id" in n)).toEqual([]);
    const flow = buildStatementDefinition(withFinance(), stmtCfg(null));
    expect(JSON.stringify(flow)).not.toContain('"canvas:');
    expect(JSON.stringify(def)).toContain('"canvas:');
  });

  it("a page-bottom Text item whose words run past the band's foot is cut at the band's bottom edge, whole lines, with the page line off and on (#978)", async () => {
    // Red when the band's footer frame is not ended at the band's bottom edge (render.ts's
    // `installBandFrame` wrapper): the item's overflow then prints below the edge, in the page's
    // bottom margin, and with the page line on over and under it.
    for (const pageFooter of [false, true]) {
      const banded = bandClipLayout(standardStatementLayout(), pageFooter);
      expect(() => validateCanvasLayout(banded, STATEMENT_CONTRACT, { pageFooter }), `page line ${pageFooter}`).not.toThrow();
      const { pdf } = await renderStatement(sampleStatement(), stmtCfg(banded, { pageFooter }));
      expect(pageCount(pdf), `page line ${pageFooter}`).toBe(1);
      expectBandClip(pdf, pageFooter);
    }
  });

  describe("the held Bill To", () => {
    it("a one-line bill-to holds the block at its drawn height, and the open items start under it by the drawn distance", async () => {
      // Red when the spacer column is removed, and when `holdsHeight` is deleted from the profile.
      const d = oneLineBillTo(sampleStatement());
      expect(d.remitTo.lines.length + 1).toBe(3);
      const bill = blockBox(layout, "bill_to");
      expect(bill.h).toBe(41.5);
      // Not vacuous: the content alone is shorter than the drawn box.
      expect(await aloneHeight(STATEMENT_FLOW.billToStack(BILL_TO_LABEL, d), bill.w)).toBeLessThan(bill.h);
      const { group } = await renderStatement(d, stmtCfg(layout));
      expect(Math.abs(blockHeight(group, layout, "bill_to") - bill.h)).toBeLessThanOrEqual(MARK_TOL);
      expect(Math.abs(blockTop(group, layout, "open_items") - (at(group, CANVAS_IDS.end("bill_to")).top + drawnGap(layout, "open_items"))))
        .toBeLessThanOrEqual(MARK_TOL);
    });

    it("an R14 bill-to over three lines prints the block at its content's height, taller than drawn, and the open items ride it", async () => {
      // Red when the held node lays out at its spacer alone (the content column emptied).
      const d = r14(sampleStatement());
      const bill = blockBox(layout, "bill_to");
      const content = await aloneHeight(STATEMENT_FLOW.billToStack(BILL_TO_LABEL, d), bill.w);
      expect(content).toBeGreaterThan(bill.h);
      const { group } = await renderStatement(d, stmtCfg(layout));
      expect(Math.abs(blockHeight(group, layout, "bill_to") - content)).toBeLessThanOrEqual(MARK_TOL);
      expect(Math.abs(blockTop(group, layout, "open_items") - (bill.y + content + drawnGap(layout, "open_items"))))
        .toBeLessThanOrEqual(MARK_TOL);
    });

    it("the held node is a zero-gap columns node whose second column is 0 wide, holding a spacer with no id", () => {
      // Red when the spacer column is removed. The first column is the shared block shape's fixed
      // width (`drawnBlock`, pdf/canvas-sheet.ts: the content width less the lateral margin), never
      // `"*"`, which widens to a child wider than the block (the before/after case below).
      const def = buildStatementDefinition(sampleStatement(), stmtCfg(layout));
      const block = nodesOf(def).find((n) => n.id === CANVAS_IDS.table("bill_to"))!;
      const held = (block.stack as Record<string, unknown>[])[0];
      expect(held.columnGap).toBe(0);
      const columns = held.columns as Record<string, unknown>[];
      const bill = blockBox(layout, "bill_to");
      const l = bill.x - CANVAS_PAGE.margin;
      const r = CANVAS_PAGE.width - CANVAS_PAGE.margin - bill.x - bill.w;
      const CONTENT = CANVAS_PAGE.width - 2 * CANVAS_PAGE.margin;
      expect(columns.map((c) => c.width)).toEqual([CONTENT - (l + r), 0]);
      const shape = canvasBlockOf(block);
      expect(shape).not.toBeNull();
      expect(shape!.held).toBe(bill.h);
      const [spacerNode] = columns[1].stack as Record<string, unknown>[];
      expect(spacerNode).not.toHaveProperty("id");
      expect((spacerNode.canvas as { h: number }[])[0].h).toBe(blockBox(layout, "bill_to").h);
      expect(nodesOf(columns[1]).filter((n) => "id" in n)).toEqual([]);
    });

    it("the held block's lateral margin is on its columns node, its wrapper's zeroed", () => {
      // Red when the margin is left on the wrapper stack (the columns node carrying none): a held
      // block that breaks across a page then leaves every node after it a width wider than the
      // page's by its left plus right inset. No statement paper case reds on that alone: every
      // later node takes a fixed width, and tests/statement-canvas-seed.test.ts's page-break cases
      // red only with a `"*"` column beside it (#969's fix wave, 2026-11-12, by mutation). So this
      // pin, and the canvas paper oracle's column-toggle premise, hold the margin's place.
      const def = buildStatementDefinition(sampleStatement(), stmtCfg(layout));
      const block = nodesOf(def).find((n) => n.id === CANVAS_IDS.table("bill_to"))!;
      const bill = blockBox(layout, "bill_to");
      expect(block.margin).toEqual([0, 0, 0, 0]);
      const held = (block.stack as Record<string, unknown>[])[0];
      expect(held.margin).toEqual([bill.x - CANVAS_PAGE.margin, 0, CANVAS_PAGE.width - CANVAS_PAGE.margin - bill.x - bill.w, 0]);
      // Not vacuous: the Bill To is drawn narrower than the page, so the margin it moves is not zero.
      expect((held.margin as number[])[2]).toBeGreaterThan(0);
    });

    it("a narrowed Bill To holding a word wider than its block wraps its other lines at its drawn width", async () => {
      // Red when the statement's column is `"*"` (the base, #970's shape): a `"*"` column takes its
      // widest child's minimum width when that minimum reaches the available width
      // (pdfmake's columnCalculator, case 1), so one unbreakable word wider than the block widens the
      // column, and the address line beside it wraps at the word's width, not the block's. The
      // control is the same record with the word replaced by a short one, where `"*"` and the fixed
      // width agree. Counted in baselines: the readers give a run's start, never its end.
      const narrowed = withTable(layout, "bill_to", (item) => ({ ...item, box: { ...item.box, x: item.box.x + 40, w: item.box.w - 80 } }));
      for (const pageFooter of [false, true]) {
        expect(() => validateCanvasLayout(narrowed, STATEMENT_CONTRACT, { pageFooter }), String(pageFooter)).not.toThrow();
      }
      const WORD = "0123456789".repeat(6);
      expect(WORD).toHaveLength(60);
      const WRAPS = "Quayside Zephyr Annex Bayfront Wharf Gatehouse Marlinspike";
      const wrapWords = new Set(WRAPS.split(" "));
      const withLines = (second: string): StatementData => {
        const d = sampleStatement();
        return { ...d, customer: { ...d.customer, billTo: ["Demo Foundry", second, WRAPS] } };
      };
      /** The distinct baselines of page 1's runs printing a word of the wrapping line, and only those. */
      const baselines = (pdf: Buffer): number[] => [...new Set(rawRuns(pdf)
        .filter((r) => r.text.trim() !== "" && r.text.trim().split(/\s+/).every((w) => wrapWords.has(w)))
        .map((r) => Math.round(r.top * 100) / 100))].sort((a, b) => a - b);
      const config = stmtCfg(narrowed);
      const control = baselines((await renderStatement(withLines("Short"), config)).pdf);
      const wide = (await renderStatement(withLines(WORD), config)).pdf;
      const got = baselines(wide);
      // The word's runs at the block's left edge, top to bottom: one run where the column widens to
      // it, a run per line where pdfmake breaks it at the drawn width.
      const left = blockBox(narrowed, "bill_to").x;
      const pieces = rawRuns(wide).filter((r) => /^[0-9]+$/.test(r.text.trim()) && Math.abs(r.x - left) <= 0.5)
        .sort((a, b) => a.top - b.top).map((r) => r.text.trim());
      measured("a narrowed Bill To beside a 60-character word", { control: control.length, withWord: got.length, wordLines: pieces.length });
      // The premise: the address line wraps at the drawn width, and the word prints whole.
      expect(control.length).toBeGreaterThanOrEqual(2);
      expect(pieces.join("")).toBe(WORD);
      expect(got.length).toBe(control.length);
    });

    it("a typed heading prints in place of \"Bill To\", and a null heading prints the contract's default", async () => {
      // Red when the item's heading is ignored (the contract's default printed instead).
      const typed = withTable(layout, "bill_to", (item) => ({ ...item, heading: "Mail To" }));
      const typedPdf = (await renderStatement(sampleStatement(), stmtCfg(typed))).pdf;
      expect(lineTexts(typedPdf).filter((t) => t === "Mail To")).toHaveLength(1);
      expect(lineTexts(typedPdf)).not.toContain(BILL_TO_LABEL);
      const standard = (await renderStatement(sampleStatement(), stmtCfg(layout))).pdf;
      expect(BILL_TO_LABEL).toBe("Bill To");
      expect(lineTexts(standard).filter((t) => t === BILL_TO_LABEL)).toHaveLength(1);
    });
  });

  describe("the finance block", () => {
    it("with a finance charge it prints the flow's node with its 2 pt top margin kept, exactly 2 pt taller than the node with it zeroed", async () => {
      // Red when `blockChildren` zeroes the finance node's top margin.
      const d = withFinance();
      const node = STATEMENT_FLOW.financeChargeBlock(standardCtx(), d)[0];
      expect(marginOf(node)[1]).toBe(2);
      const w = blockBox(layout, "finance_charge").w;
      const kept = await aloneHeight([bottomZeroed(node)], w);
      const zeroed = await aloneHeight([verticalsZeroed(node)], w);
      expect(Math.abs(kept - zeroed - 2)).toBeLessThanOrEqual(MARK_TOL);
      const { group } = await renderStatement(d, stmtCfg(layout));
      expect(Math.abs(blockHeight(group, layout, "finance_charge") - kept)).toBeLessThanOrEqual(MARK_TOL);
    });

    it("with no finance charge it prints nothing, its height 0, and Total Due starts the drawn distance under its end", async () => {
      // Red when an empty finance block takes any flow (a blank line answered for it, say).
      const d = sampleStatement();
      expect(d.financeCharge).toBeNull();
      const { def, group } = await renderStatement(d, stmtCfg(layout));
      expect(nodesOf(def).filter((n) => n.id === CANVAS_IDS.table("finance_charge"))).toEqual([]);
      expect(Math.abs(blockHeight(group, layout, "finance_charge"))).toBeLessThanOrEqual(MARK_TOL);
      expect(Math.abs(blockTop(group, layout, "total") - (at(group, CANVAS_IDS.end("finance_charge")).top + drawnGap(layout, "total"))))
        .toBeLessThanOrEqual(MARK_TOL);
    });
  });

  it.each(["open_items", "aging", "total"] as const)("the %s block prints its flow node with its vertical margins zeroed", async (key) => {
    // Red when the one-node block keeps its margins (the open items' and the aging's 10 pt bottom,
    // Total Due's 6 pt top).
    const d = withFinance();
    const ctx = standardCtx();
    const node = key === "open_items" ? STATEMENT_FLOW.openItemsTable(ctx, d)[0]
      : key === "aging" ? STATEMENT_FLOW.agingStrip(ctx, d)[0] : STATEMENT_FLOW.totalDueBlock(ctx, d)[0];
    const [, top, , bottom] = marginOf(node);
    expect(top + bottom).toBeGreaterThan(0);
    const expected = await aloneHeight([verticalsZeroed(node)], blockBox(layout, key).w);
    const { group } = await renderStatement(d, stmtCfg(layout));
    expect(Math.abs(blockHeight(group, layout, key) - expected)).toBeLessThanOrEqual(MARK_TOL);
  });

  it("the open items print their columns in the item's stored row order, and a hidden row drops its column", async () => {
    // Red when the block's columns are read from the contract instead of the item.
    const reordered = withTable(layout, "open_items", (item) => {
      const rest = item.columns.filter((c) => c.key !== "open" && c.key !== "document_no");
      const pick = (key: string) => item.columns.find((c) => c.key === key)!;
      return {
        ...item,
        columns: [pick("open"), pick("document_no"), ...rest.map((c) => (c.key === "due_date" ? { ...c, visible: false } : c))],
      };
    });
    // The heading row's words are runs of their own ("Document ", "#", "Open").
    const standard = (await renderStatement(sampleStatement(), stmtCfg(layout))).pdf;
    const standardHead = headingXs(standard);
    expect(standardHead.document).toBeLessThan(standardHead.open);
    expect(lineTexts(standard).some((t) => t.includes("Due Date"))).toBe(true);
    const pdf = (await renderStatement(sampleStatement(), stmtCfg(reordered))).pdf;
    const reorderedHead = headingXs(pdf);
    expect(reorderedHead.open).toBeLessThan(reorderedHead.document);
    expect(lineTexts(pdf).some((t) => t.includes("Due Date"))).toBe(false);
  });

  it("the lens: a layout holding the field-keyed Bill To renders, its block never handed to sectionView", async () => {
    // Red (a throw: sectionView knows no "bill_to" section) when the lens's filter is dropped.
    expect(() => STATEMENT_FLOW.sectionView({ key: "bill_to", visible: true, fields: [] })).toThrow(/Unknown STATEMENT template section/);
    expect(tableOf(layout, "bill_to")).toBeDefined();
    const { pdf } = await renderStatement(sampleStatement(), stmtCfg(layout));
    expect(lineTexts(pdf).filter((t) => t === BILL_TO_LABEL)).toHaveLength(1);
  });

  it("the fixture's Remit To box (67.5 pt) holds the flow's box in Roboto; each family's figure is measured (pin)", async () => {
    // The figures (W5_MEASURES=1) are in the lane's task-4-report.md; Roboto Mono's runs past 67.5, so a case
    // that prints a canvas in it draws the Remit To item at least that tall first.
    const d = sampleStatement();
    const remit = layout.items.find((item) => item.kind === "field" && item.key === "remit_to")!;
    const figures = {} as Record<FontFamily, number>;
    for (const family of FONT_FAMILIES) {
      const config = stmtCfg(null);
      config.fonts.family = family;
      const box = STATEMENT_FLOW.remitToBox(defaultLabelOf(STATEMENT_CONTRACT, "remit_to"), { fontSize: 13, bold: true }, d);
      figures[family] = await aloneHeight([box], STATEMENT_WIDTHS.remitTo, config);
    }
    measured("the statement's Remit To box, laid out alone", figures);
    expect(figures.Roboto).toBeLessThanOrEqual(remit.box.h);
    for (const family of FONT_FAMILIES) expect(figures[family], family).toBeGreaterThan(0);
  });

  it("statementCanvasItemContent is the canvas sheet's item node, and refuses a flow config (pin)", () => {
    // A pin: no mutation of the canvas module reds its assertions (the lens's filter dropped throws before them).
    const content = statementCanvasItemContent(sampleStatement(), stmtCfg(layout));
    const title = layout.items.find((item) => item.kind === "field" && item.key === "title")!;
    expect(content(title)).toEqual(statementItemContent(standardCtx(), sampleStatement(), STATEMENT_FLOW)(title));
    expect(() => statementCanvasItemContent(sampleStatement(), stmtCfg(null))).toThrow(/needs a canvas config/);
  });
});

// ---------------------------------------------------------------------------------------------
// The statement's ruled paper on a canvas (design 2026-11-11 §11). Green on arrival after the
// blocks landed: each case names, in a comment, the mutation of src/server/statement-canvas.ts that reds it
// (or says "(pin)" in its title). Flow and canvas print from the same `StatementData`
// (`richStatement`). The standard layout is not the flow's arrangement, so a case compares the
// canvas with the flow by text and x, and judges y within the canvas, by its marks.
// ---------------------------------------------------------------------------------------------

/** A text run with its baseline read top-down. */
type Run = { text: string; x: number; top: number };

/** Page `page`'s raw runs (`textRunsWithY`, never the half-point grouping), baselines top-down. */
const rawRuns = (pdf: Buffer, page = 1): Run[] =>
  textRunsWithY(pdf)[page - 1].map((r) => ({ text: r.text, x: r.x, top: PAGE_HEIGHT - r.y }));

/** A block's rendered span on page 1: its rendered top (the header's rule) and its end mark. */
function spanOf(group: Group, layout: CanvasLayout, key: StatementTable): { top: number; end: number } {
  const end = at(group, CANVAS_IDS.end(key));
  expect(end.page, key).toBe(1);
  return { top: blockTop(group, layout, key), end: end.top };
}

/** Page 1's runs whose baseline lies inside a block's rendered span. */
function runsInBlock(pdf: Buffer, group: Group, layout: CanvasLayout, key: StatementTable): Run[] {
  const { top, end } = spanOf(group, layout, key);
  return rawRuns(pdf).filter((r) => r.top > top && r.top < end);
}

/** Runs grouped into lines by their exact baseline (0.01 pt), top to bottom, each line's runs left to
 *  right and its text joined with its spacing collapsed (`textLinesWithY`'s join, on raw baselines). */
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

/** A line's text with the run that prints `amount` taken out (a totals line's label alone). */
function labelBeside(line: { runs: Run[] }, amount: string): string {
  const runs = line.runs.filter((r) => r.text.trim() !== amount);
  expect(runs.length, `the run printing ${amount}`).toBe(line.runs.length - 1);
  return runs.map((r) => r.text).join("").replace(/\s+/g, " ").trim();
}

/** The x of every vertical rule of page 1 crossing the span `top`..`end`, distinct, sorted
 *  (`strokedLines` reads a rule in pdfkit's flipped space, so its y is already top-down). */
function verticalsIn(pdf: Buffer, top: number, end: number): number[] {
  const xs = strokedLines(pdf)[0]
    .filter((s) => Math.abs(s.x1 - s.x2) < 0.01)
    .filter((s) => Math.max(s.y1, s.y2) > top && Math.min(s.y1, s.y2) < end)
    .map((s) => Math.round(s.x1 * 100) / 100);
  return [...new Set(xs)].sort((a, b) => a - b);
}

/** A boxed table line's cells: its runs between each pair of the table's verticals, each cell's
 *  runs joined (pdfkit writes a word per run, and breaks a word after a dash: "1–" "30"). */
const cellsOf = (line: { runs: Run[] }, verticals: number[]): string[] =>
  verticals.slice(0, -1).map((v, i) => line.runs.filter((r) => r.x > v && r.x < verticals[i + 1])
    .map((r) => r.text).join("").replace(/\s+/g, " ").trim());

/** The flow's config with only `keys`' sections shown, so its page holds those blocks' runs alone. */
function flowOnly(keys: string[], over: Partial<TemplateConfig> = {}): TemplateConfig {
  const config = stmtCfg(null, over);
  config.sections = completeSections(STATEMENT_CONTRACT, config.sections).map((sc) => ({ ...sc, visible: keys.includes(sc.key) }));
  return config;
}

/** A block's stored row of `key`, changed. */
function withColumn(layout: CanvasLayout, table: StatementTable, key: string, change: Partial<CanvasColumn>): CanvasLayout {
  return withTable(layout, table, (item) => ({
    ...item, columns: item.columns.map((c) => (c.key === key ? { ...c, ...change } : c)),
  }));
}

describe("the statement's ruled paper on a canvas (design 2026-11-11 §11)", () => {
  const layout = standardStatementLayout();
  const FINANCE_LABEL = defaultLabelOf(STATEMENT_CONTRACT, "finance_charge");
  const TOTAL_LABEL = defaultLabelOf(STATEMENT_CONTRACT, "total_due");
  const money = STATEMENT_FLOW.makeMoney(STATEMENT_DEFAULT_CONFIG.formats);

  it("the layouts these cases print pass the canvas rules (pin)", () => {
    expect(() => validateCanvasLayout(layout, STATEMENT_CONTRACT, { pageFooter: false })).not.toThrow();
    expect(() => validateCanvasLayout(financeBelowTotal(), STATEMENT_CONTRACT, { pageFooter: false })).not.toThrow();
    for (const w of [STATEMENT_WIDTHS.content, STATEMENT_LEAST_WIDTHS.finance_charge]) {
      expect(() => validateCanvasLayout(financeAlone(w), STATEMENT_CONTRACT, { pageFooter: false }), String(w)).not.toThrow();
    }
  });

  /** The standard stack with Total Due drawn where the finance block is and the finance block below
   *  it, each anchored below the block it now follows. */
  function financeBelowTotal(): CanvasLayout {
    const finance = blockBox(layout, "finance_charge");
    const total = blockBox(layout, "total");
    const swapped = withTable(withTable(layout, "total", (item) => ({
      ...item, box: { ...item.box, y: finance.y }, anchor: { kind: "below-table", table: "aging" },
    })), "finance_charge", (item) => ({
      ...item, box: { ...item.box, y: total.y }, anchor: { kind: "below-table", table: "total" },
    }));
    expect(tablesByY(swapped).map((t) => t.key)).toEqual(["bill_to", "open_items", "aging", "total", "finance_charge"]);
    return swapped;
  }

  /** The finance block alone, page-top at the left margin, `w` wide and the row floor tall: no Remit
   *  To item, so a case printing it in another family needs no taller Remit To box (the Global
   *  Constraints' rule binds a layout that holds one). */
  const financeAlone = (w: number): CanvasLayout => layoutOf([statementTable("finance_charge", {
    anchor: { kind: "page-top" }, box: { x: CANVAS_PAGE.margin, y: CANVAS_PAGE.margin, w, h: STATEMENT_ROW_FLOOR },
  })]);

  describe("#162: the informational finance line", () => {
    it("prints only with a finance charge: the contract's label with the row's label null, the figure beside it", async () => {
      // Red when `blockChildren`'s finance arm calls `totalDueBlock` (its block then holds a Total Due line).
      expect(tableOf(layout, "finance_charge").columns.map((c) => c.label)).toEqual([null]);
      const d = richStatement();
      const { pdf, group } = await renderStatement(d, stmtCfg(layout));
      const lines = linesOfRuns(runsInBlock(pdf, group, layout, "finance_charge"));
      expect(lines).toHaveLength(1);
      expect(labelBeside(lines[0], money(12.34))).toBe(FINANCE_LABEL);
      expect(FINANCE_LABEL).toBe("Finance Charge (not billed, not in total):");

      const none = richStatement({ financeCharge: null });
      const unassessed = await renderStatement(none, stmtCfg(layout));
      expect(lineTexts(unassessed.pdf).filter((t) => t.includes("Finance"))).toEqual([]);
      expect(Math.abs(blockHeight(unassessed.group, layout, "finance_charge"))).toBeLessThanOrEqual(MARK_TOL);
    });

    it("a label typed on the block's row prints as typed", async () => {
      // Red when `canvasCtx` builds the finance section from the contract's defaults instead of the
      // item's rows.
      const typed = withColumn(layout, "finance_charge", "finance_charge", { label: "Memo, not billed:" });
      const { pdf, group } = await renderStatement(richStatement(), stmtCfg(typed));
      const lines = linesOfRuns(runsInBlock(pdf, group, typed, "finance_charge"));
      expect(lines).toHaveLength(1);
      expect(labelBeside(lines[0], money(12.34))).toBe("Memo, not billed:");
      expect(lineTexts(pdf).filter((t) => t.includes(FINANCE_LABEL))).toEqual([]);
    });

    it("Total Due prints Net, on the one Total Due line, and no total includes the finance figure", async () => {
      // Red when `blockChildren`'s finance arm calls `totalDueBlock`: the finance block then prints a
      // second Total Due line and no finance label.
      const d = richStatement();
      const a = d.aging;
      expect(a.net).toBe(a.current + a.d1_30 + a.d31_60 + a.d61_90 + a.d90_plus - a.unapplied);
      expect(d.totalDue).toBe(a.net);
      const { pdf, group } = await renderStatement(d, stmtCfg(layout));
      const total = linesOfRuns(runsInBlock(pdf, group, layout, "total"));
      expect(total).toHaveLength(1);
      expect(labelBeside(total[0], money(a.net))).toBe(TOTAL_LABEL);
      const finance = linesOfRuns(runsInBlock(pdf, group, layout, "finance_charge"));
      expect(finance.map((l) => l.text)).toEqual([`${FINANCE_LABEL}${money(12.34)}`]);
      expect(lineTexts(pdf).filter((t) => t.startsWith(TOTAL_LABEL))).toHaveLength(1);
      expect(rawRuns(pdf).filter((r) => r.text.includes(money(a.net + 12.34)))).toEqual([]);
    });

    it("with the finance block drawn below Total Due, each prints inside its own block where drawn", async () => {
      // Red when `blockChildren`'s finance arm calls `totalDueBlock` (the lower block then prints a
      // second Total Due line and no finance label).
      const below = financeBelowTotal();
      const d = richStatement();
      const { pdf, group } = await renderStatement(d, stmtCfg(below));
      const total = linesOfRuns(runsInBlock(pdf, group, below, "total"));
      const finance = linesOfRuns(runsInBlock(pdf, group, below, "finance_charge"));
      expect(total.map((l) => labelBeside(l, money(d.totalDue)))).toEqual([TOTAL_LABEL]);
      expect(finance.map((l) => labelBeside(l, money(12.34)))).toEqual([FINANCE_LABEL]);
      expect(finance[0].top).toBeGreaterThan(total[0].top);
      expect(Math.abs(blockTop(group, below, "total") - (at(group, CANVAS_IDS.end("aging")).top + drawnGap(below, "total"))))
        .toBeLessThanOrEqual(MARK_TOL);
      expect(Math.abs(blockTop(group, below, "finance_charge") - (at(group, CANVAS_IDS.end("total")).top + drawnGap(below, "finance_charge"))))
        .toBeLessThanOrEqual(MARK_TOL);
    });

    describe.each(FONT_FAMILIES.map((family) => [family]))("its label in %s", (family) => {
      it.each([STATEMENT_WIDTHS.content, STATEMENT_LEAST_WIDTHS.finance_charge])("drawn %s wide prints on the flow's lines (one baseline but in Roboto Mono)", async (w) => {
        // Red when `blockChildren`'s finance arm calls `totalDueBlock` (the canvas then prints Total
        // Due's line, not the flow's finance line). The label's column is the flow's fixed
        // `totalsLabel`, so the block's width does not move where it wraps.
        const fonts = { ...STATEMENT_DEFAULT_CONFIG.fonts, family };
        const alone = financeAlone(w);
        const d = richStatement();
        const { pdf, group } = await renderStatement(d, stmtCfg(alone, { fonts }));
        const canvas = linesOfRuns(runsInBlock(pdf, group, alone, "finance_charge"));
        const flow = linesOfRuns(rawRuns(await renderPdf(buildStatementDefinition(d, flowOnly(["finance_charge"], { fonts })))));
        measured(`#162's finance line in ${family}, drawn ${w} wide: its lines on the canvas and on the flow`, {
          canvas: canvas.length, flow: flow.length,
        });
        expect(canvas.map((l) => l.text)).toEqual(flow.map((l) => l.text));
        expect(canvas.map((l) => l.text).join(" ")).toContain(money(12.34));
        if (family === "Roboto Mono") {
          // The flow wraps it in Roboto Mono, and the canvas wraps it at the same words.
          expect(flow.length).toBeGreaterThan(1);
        } else {
          expect(canvas).toHaveLength(1);
        }
        if (w === STATEMENT_WIDTHS.content) {
          // At the flow's width the block is at the flow's x: every run of every line at its x.
          canvas.forEach((line, i) => {
            expect(line.runs.length).toBe(flow[i].runs.length);
            line.runs.forEach((r, j) => expect(Math.abs(r.x - flow[i].runs[j].x), r.text).toBeLessThanOrEqual(0.5));
          });
        }
      });
    });
  });

  describe("ruling 8: the aging strip", () => {
    const BUCKETS = [
      AGING_BUCKET_LABELS.CURRENT, AGING_BUCKET_LABELS.D1_30, AGING_BUCKET_LABELS.D31_60,
      AGING_BUCKET_LABELS.D61_90, AGING_BUCKET_LABELS.D90_PLUS,
    ];

    it("prints Unapplied in its own column over its own figure, every run at the flow's x", async () => {
      // Red when `blockChildren`'s aging arm prints another flow node (`flow.totalDueBlock`, say).
      const d = richStatement();
      const { pdf, group } = await renderStatement(d, stmtCfg(layout));
      const { top, end } = spanOf(group, layout, "aging");
      const lines = linesOfRuns(runsInBlock(pdf, group, layout, "aging"));
      expect(lines).toHaveLength(2);
      const [head, values] = lines;
      const verticals = verticalsIn(pdf, top, end);
      expect(verticals).toHaveLength(8); // seven columns
      const heads = cellsOf(head, verticals);
      const figures = cellsOf(values, verticals);
      const column = heads.indexOf(defaultLabelOf(STATEMENT_CONTRACT, "aging_unapplied"));
      expect(column).toBe(5);
      expect(figures[column]).toBe(money(d.aging.unapplied));
      expect(figures).toEqual([
        d.aging.current, d.aging.d1_30, d.aging.d31_60, d.aging.d61_90, d.aging.d90_plus, d.aging.unapplied, d.aging.net,
      ].map(money));
      const flowPdf = await renderPdf(buildStatementDefinition(d, flowOnly(["aging"])));
      const flow = linesOfRuns(rawRuns(flowPdf));
      expect(flow.map((l) => l.text)).toEqual(lines.map((l) => l.text));
      lines.forEach((line, i) => line.runs.forEach((r, j) =>
        expect(Math.abs(r.x - flow[i].runs[j].x), r.text).toBeLessThanOrEqual(0.5)));
      expect(verticalsIn(flowPdf, 0, PAGE_HEIGHT)).toEqual(verticals);
    });

    it("with every column's label null, prints AGING_BUCKET_LABELS' five words, Unapplied and Net, read from the contract", async () => {
      // Red when `blockChildren`'s aging arm prints another flow node (`flow.totalDueBlock`, say), and,
      // outside the statement's own files, when `sectionConfigOf` (canvas-sheet.ts) labels a null column by its key.
      const aging = tableOf(layout, "aging");
      expect(aging.columns.map((c) => c.label)).toEqual(aging.columns.map(() => null));
      const contractLabels = aging.columns.map((c) => defaultLabelOf(STATEMENT_CONTRACT, c.key));
      expect(contractLabels).toEqual([...BUCKETS, "Unapplied", "Net"]);
      const { pdf, group } = await renderStatement(richStatement(), stmtCfg(layout));
      const { top, end } = spanOf(group, layout, "aging");
      const [head] = linesOfRuns(runsInBlock(pdf, group, layout, "aging"));
      expect(cellsOf(head, verticalsIn(pdf, top, end))).toEqual(contractLabels);
    });

    it("a width typed on an aging row prints at that width, as the flow prints it", async () => {
      // Red when the aging section is built from the contract's columns instead of the item's.
      const typed = withColumn(layout, "aging", "aging_current", { width: 120 });
      const d = richStatement();
      const { pdf, group } = await renderStatement(d, stmtCfg(typed));
      const { top, end } = spanOf(group, typed, "aging");
      const verticals = verticalsIn(pdf, top, end);
      const flowConfig = flowOnly(["aging"]);
      flowConfig.sections = flowConfig.sections.map((sc) => sc.key !== "aging" ? sc : {
        ...sc, fields: sc.fields.map((f) => (f.key === "aging_current" ? { ...f, width: 120 } : f)),
      });
      const flowPdf = await renderPdf(buildStatementDefinition(d, flowConfig));
      expect(verticals).toEqual(verticalsIn(flowPdf, 0, PAGE_HEIGHT));
      expect(verticals[1] - verticals[0]).toBeGreaterThanOrEqual(120);
      // Not vacuous: the untyped strip's first column is narrower.
      const plain = await renderStatement(d, stmtCfg(layout));
      const span = spanOf(plain.group, layout, "aging");
      const untyped = verticalsIn(plain.pdf, span.top, span.end);
      expect(untyped[1] - untyped[0]).toBeLessThan(120);
    });
  });

  it("R14: the stacked name prints first in the Bill To block, and the customer's name on the Customer line too, twice, as the flow prints it", async () => {
    // Red when the Bill To arm prints its label alone (`flow.billToStack(…).slice(0, 1)`).
    const d = richStatement();
    expect(d.customer.billTo[0]).toBe("Accounts Payable");
    expect(d.customer.billTo[1]).toBe(d.customer.name);
    const { pdf, group } = await renderStatement(d, stmtCfg(layout));
    // The Remit To box prints beside the block, inside its span: the block's runs are those across its box.
    const box = blockBox(layout, "bill_to");
    const bill = linesOfRuns(runsInBlock(pdf, group, layout, "bill_to").filter((r) => r.x >= box.x && r.x < box.x + box.w));
    expect(bill.map((l) => l.text)).toEqual([BILL_TO_LABEL, ...d.customer.billTo]);
    const named = (p: Buffer) => lineTexts(p).filter((t) => t.includes(d.customer.name)).length;
    const flowPdf = await renderPdf(buildStatementDefinition(d, stmtCfg(null)));
    expect(named(pdf)).toBe(2);
    expect(named(pdf)).toBe(named(flowPdf));
    expect(lineTexts(pdf)).toContain(`${defaultLabelOf(STATEMENT_CONTRACT, "customer")} ${d.customer.code} — ${d.customer.name}`);
  });

  describe("the open items", () => {
    const HEADINGS = ["document_no", "date", "due_date", "original", "open"].map((k) => defaultLabelOf(STATEMENT_CONTRACT, k));

    /** The open items' heading cells and each row's cells, a row found by its document number. */
    function openItemsCells(pdf: Buffer, group: Group, drawn: CanvasLayout, d: StatementData) {
      const { top, end } = spanOf(group, drawn, "open_items");
      const verticals = verticalsIn(pdf, top, end);
      const lines = linesOfRuns(runsInBlock(pdf, group, drawn, "open_items"));
      const rows = d.openItems.map((item) => {
        const row = lines.filter((l) => l.text.startsWith(item.documentNumber));
        expect(row, item.documentNumber).toHaveLength(1);
        return cellsOf(row[0], verticals);
      });
      return { lines, head: cellsOf(lines[0], verticals), rows };
    }

    it("prints a credit's and an on-account payment's Due Date blank, an invoice's under its heading", async () => {
      // Red when `blockChildren`'s open items arm prints another flow node (`flow.agingStrip`, say). The
      // blank cell is the flow's (`openItemValue`), which the canvas prints unchanged.
      const d = richStatement();
      const date = STATEMENT_FLOW.makeLongDate(STATEMENT_DEFAULT_CONFIG.formats);
      const { pdf, group } = await renderStatement(d, stmtCfg(layout));
      const { head, rows } = openItemsCells(pdf, group, layout, d);
      expect(head).toEqual(HEADINGS);
      const due = head.indexOf(defaultLabelOf(STATEMENT_CONTRACT, "due_date"));
      expect(d.openItems.map((item) => item.kind)).toEqual(["INVOICE", "INVOICE", "CREDIT", "PAYMENT"]);
      expect(rows.map((cells) => cells[due])).toEqual(d.openItems.map((item) => (item.dueDate === null ? "" : date(item.dueDate))));
      expect(rows.map((cells) => cells[due] === "")).toEqual([false, false, true, true]);
    });

    it.each(NEGATIVE_STYLES.map((style) => [style]))("under %s prints the flow's strings for the negative amounts", async (style) => {
      // Red, for the two styles other than the contract's own, when `canvasCtx` builds the ctx over
      // the contract's formats instead of the config's (`flow.ctxOf({ ...config, formats:
      // STATEMENT_CONTRACT.formats }, …)`); the default style's row is green under that by
      // construction, and all three are red when the open items arm prints another flow node
      // (`flow.agingStrip`, say).
      const literal = { SIGN_AFTER_SYMBOL: "$-125.50", LEADING_MINUS: "-$125.50", PARENTHESES: "($125.50)" }[style];
      const formats = { ...STATEMENT_DEFAULT_CONFIG.formats, negativeStyle: style };
      const d = richStatement();
      const { pdf, group } = await renderStatement(d, stmtCfg(layout, { formats }));
      const { head, rows } = openItemsCells(pdf, group, layout, d);
      const flowPdf = await renderPdf(buildStatementDefinition(d, flowOnly(["open_items"], { formats })));
      const flowLines = linesOfRuns(rawRuns(flowPdf));
      const flowVerticals = verticalsIn(flowPdf, 0, PAGE_HEIGHT);
      const flowRows = d.openItems.map((item) => cellsOf(flowLines.find((l) => l.text.startsWith(item.documentNumber))!, flowVerticals));
      expect(rows).toEqual(flowRows);
      const original = head.indexOf(defaultLabelOf(STATEMENT_CONTRACT, "original"));
      const open = head.indexOf(defaultLabelOf(STATEMENT_CONTRACT, "open"));
      expect(rows[2][open]).toBe(literal);
      const pick = STATEMENT_FLOW.makeMoney(formats);
      const negatives = d.openItems.flatMap((item, i) => [[rows[i][original], item.original], [rows[i][open], item.open]] as const)
        .filter(([, v]) => v < 0);
      expect(negatives).toHaveLength(4);
      for (const [cell, v] of negatives) expect(cell, String(v)).toBe(pick(v));
    });

    it("a statement with no open items prints the heading row alone", async () => {
      // Red when the open items' arm answers nothing for a statement with no rows
      // (`d.openItems.length === 0 ? null : oneNode(…)`).
      const d = richStatement({ openItems: [] });
      const { pdf, group } = await renderStatement(d, stmtCfg(layout));
      const { lines, head } = openItemsCells(pdf, group, layout, d);
      expect(lines).toHaveLength(1);
      expect(head).toEqual(HEADINGS);
      const node = STATEMENT_FLOW.openItemsTable(standardCtx(), d)[0];
      const expected = await aloneHeight([verticalsZeroed(node)], blockBox(layout, "open_items").w);
      expect(expected).toBeGreaterThan(0);
      expect(Math.abs(blockHeight(group, layout, "open_items") - expected)).toBeLessThanOrEqual(MARK_TOL);
    });

    it("with every row hidden prints nothing, the block 0 tall", async () => {
      // Red when an empty flow answer still prints a node (`oneNode` answering `[{ text: " " }]` for it).
      const hidden = withTable(layout, "open_items", (item) => ({
        ...item, columns: item.columns.map((c) => ({ ...c, visible: false })),
      }));
      const { pdf, def, group } = await renderStatement(richStatement(), stmtCfg(hidden));
      expect(nodesOf(def).filter((n) => n.id === CANVAS_IDS.table("open_items"))).toEqual([]);
      expect(runsInBlock(pdf, group, hidden, "open_items")).toEqual([]);
      expect(lineTexts(pdf).filter((t) => t.includes("Document"))).toEqual([]);
      expect(Math.abs(blockHeight(group, hidden, "open_items"))).toBeLessThanOrEqual(MARK_TOL);
    });

    it("the date knob prints every item date in its format", async () => {
      // Red when `canvasCtx` builds the ctx over the contract's own formats instead of the config's.
      // Never "YYYY-MM-DD", under which the knob answers the ISO string itself.
      const formats = { ...STATEMENT_DEFAULT_CONFIG.formats, dateFormat: "MMM - DD - YYYY" as const };
      const d = richStatement();
      const date = STATEMENT_FLOW.makeLongDate(formats);
      const { pdf, group } = await renderStatement(d, stmtCfg(layout, { formats }));
      const { head, rows } = openItemsCells(pdf, group, layout, d);
      const [dated, due] = ["date", "due_date"].map((k) => head.indexOf(defaultLabelOf(STATEMENT_CONTRACT, k)));
      expect([rows[0][dated], rows[0][due]]).toEqual(["Mar - 02 - 2026", "Apr - 01 - 2026"]);
      expect(rows.map((cells) => cells[dated])).toEqual(d.openItems.map((item) => date(item.date)));
      expect(rows.map((cells) => cells[due])).toEqual(d.openItems.map((item) => (item.dueDate === null ? "" : date(item.dueDate))));
    });
  });

  it("the date knob prints the statement date in its format, and no date in the Standard's format or as the ISO string", async () => {
    // Red when `canvasCtx` builds the ctx over the contract's own formats instead of the config's
    // (the open items' dates; the statement date's item reads the same ctx). Never "YYYY-MM-DD",
    // under which the knob answers the ISO string itself. Each item date's own printed figure is the
    // open-items case's above ("the date knob prints every item date in its format").
    const formats = { ...STATEMENT_DEFAULT_CONFIG.formats, dateFormat: "MMM - DD - YYYY" as const };
    const d = richStatement();
    const { pdf } = await renderStatement(d, stmtCfg(layout, { formats }));
    expect(lineTexts(pdf)).toContain(`${defaultLabelOf(STATEMENT_CONTRACT, "statement_date")} Aug - 08 - 2026`);
    const flow = STATEMENT_FLOW.makeLongDate(STATEMENT_DEFAULT_CONFIG.formats);
    const iso = [d.asOf, ...d.openItems.flatMap((item) => [item.date, ...(item.dueDate === null ? [] : [item.dueDate])])];
    // Not one date prints in the Standard's format or as the ISO string.
    const page = lineTexts(pdf).join("\n");
    for (const day of iso) {
      expect(page, day).not.toContain(day);
      expect(page, day).not.toContain(flow(day));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// A canvas statement that grows and pages (design 2026-11-11 §4.4, §4.5). Green on arrival after
// the blocks landed: each case names, in a comment, the mutation that reds it. One layout
// (`standardStatementLayout()`, its customer line repeated) prints a short statement
// (`sampleStatement()`) and a long one (`richStatement` with 300 open items, which pages).
// ---------------------------------------------------------------------------------------------

/** `richStatement`'s four open items repeated to `n`, each document number made its own. */
function manyOpenItems(n: number): StatementData["openItems"] {
  const base = richStatement().openItems;
  return Array.from({ length: n }, (_, i) => ({ ...base[i % base.length], documentNumber: `${base[i % base.length].documentNumber}-${i + 1}` }));
}

describe("a canvas statement that grows and pages (design 2026-11-11 §4.4, §4.5)", () => {
  const layout = standardStatementLayout();
  const long = richStatement({ openItems: manyOpenItems(300) });
  const customerBox = layout.items.find((item) => item.kind === "field" && item.key === "customer")!.box;
  const dateBox = layout.items.find((item) => item.kind === "field" && item.key === "statement_date")!.box;
  // Everything below the repeat band is the page's body (`topMargin`, the sheet's own top margin).
  const bodyTop = topMargin(layout);
  const CUSTOMER_LABEL = defaultLabelOf(STATEMENT_CONTRACT, "customer");
  const FINANCE_LABEL = defaultLabelOf(STATEMENT_CONTRACT, "finance_charge");
  const TOTAL_LABEL = defaultLabelOf(STATEMENT_CONTRACT, "total_due");

  /** Where pdfmake reports a printed block's id, under its rendered top: its first laid-out line's
   *  own top margin (the Bill To's label's, the finance line's kept 2 pt; the one-node blocks' are
   *  zeroed). */
  const idOffset = (key: StatementTable, d: StatementData): number =>
    key === "bill_to" ? marginOf(STATEMENT_FLOW.billToStack(BILL_TO_LABEL, d)[0])[1]
      : key === "finance_charge" ? marginOf(STATEMENT_FLOW.financeChargeBlock(standardCtx(), d)[0])[1] : 0;

  it("the precondition: the layout repeats its customer line, and passes the canvas rules with the page line on and off", () => {
    // Reads back the fixture's own flag, so it is red only when the customer item's `repeat` is cleared
    // in this layout (the continuation cases' mutation); the paging cases below hold the paper.
    expect(layout.items.find((item) => item.kind === "field" && item.key === "customer")!.repeat).toBe(true);
    for (const pageFooter of [false, true]) {
      expect(() => validateCanvasLayout(layout, STATEMENT_CONTRACT, { pageFooter }), String(pageFooter)).not.toThrow();
    }
  });

  it.each([
    ["the short statement", sampleStatement()],
    ["the 300-item statement", long],
  ] as const)("%s: each block rides the one above it by the drawn distance, and each printed block is laid out at its rendered top", async (_name, d) => {
    // Red when `drawnBlock` is skipped for the open items (`tableBlock` answers the bare stack):
    // the block prints unwrapped, so it carries no id to be laid out at its rendered top (the second
    // loop; at x 24 and 564 wide its lateral margin is 0, so nothing else of it is seen). The ride
    // (the first loop) is the sheet's region spacer between a block's end mark and its region's end:
    // red when that region is handed a wrong height (`assembleCanvasSheet`'s `heights.get(…) ?? 0`
    // plus 5). The second loop also reds when the sheet emits its blocks in reverse drawn order.
    const { def, group } = await renderStatement(d, stmtCfg(layout));
    const printed = new Set(nodesOf(def).map((n) => n.id).filter((id) => typeof id === "string"));
    for (const key of BLOCKS.slice(1)) {
      const prev = above(layout, key)!;
      const end = at(group, CANVAS_IDS.end(prev));
      const top = at(group, CANVAS_IDS.regionEnd(prev));
      expect(top.page, key).toBe(end.page);
      expect(Math.abs(top.top - (end.top + drawnGap(layout, key))), key).toBeLessThanOrEqual(MARK_TOL);
    }
    // The open items and the aging print on every statement here; the finance block with a charge.
    expect(printed.has(CANVAS_IDS.table("open_items"))).toBe(true);
    expect(printed.has(CANVAS_IDS.table("finance_charge"))).toBe(d.financeCharge !== null);
    for (const key of BLOCKS) {
      if (!printed.has(CANVAS_IDS.table(key))) continue;
      const prev = above(layout, key);
      const topPage = prev === null ? 1 : at(group, CANVAS_IDS.regionEnd(prev)).page;
      const id = at(group, CANVAS_IDS.table(key));
      expect(id.page, key).toBe(topPage);
      expect(Math.abs(id.top - (blockTop(group, layout, key) + idOffset(key, d))), key).toBeLessThanOrEqual(MARK_TOL);
    }
  });

  describe("the 300-item statement", () => {
    let rendered: Promise<Awaited<ReturnType<typeof renderStatement>>> | null = null;
    const once = () => (rendered ??= renderStatement(long, stmtCfg(layout)));

    it("pages, and every page after the first prints the customer line at its drawn box, (continued) and the open items' heading row first in its body", async () => {
      // Red when the customer item's `repeat` is cleared in this layout: no customer line and no
      // "(continued)" on a continuation page (a layout with nothing repeated has no continued box).
      const { pdf } = await once();
      const pages = pageCount(pdf);
      expect(pages).toBeGreaterThanOrEqual(2);
      const heading = defaultLabelOf(STATEMENT_CONTRACT, "document_no");
      for (let page = 2; page <= pages; page++) {
        const runs = rawRuns(pdf, page);
        const customer = runs.filter((r) => r.text.trim().startsWith(CUSTOMER_LABEL.split(" ")[0]));
        expect(customer, `page ${page}`).toHaveLength(1);
        expect(Math.abs(customer[0].x - customerBox.x), `page ${page}`).toBeLessThanOrEqual(0.5);
        expect(customer[0].top, `page ${page}`).toBeGreaterThan(customerBox.y);
        expect(customer[0].top, `page ${page}`).toBeLessThanOrEqual(customerBox.y + customerBox.h);
        const pageOne = rawRuns(pdf, 1).find((r) => r.text.trim().startsWith(CUSTOMER_LABEL.split(" ")[0]))!;
        expect(Math.abs(customer[0].top - pageOne.top), `page ${page}`).toBeLessThanOrEqual(0.5);
        const customerLine = linesOfRuns(runs.filter((r) => Math.abs(r.top - customer[0].top) < 0.01 && r.x >= customerBox.x - 0.5));
        expect(customerLine.map((l) => l.text), `page ${page}`)
          .toEqual([`${CUSTOMER_LABEL}${STATEMENT_FLOW.identityGlue.customer}${STATEMENT_FLOW.identityValue("customer", standardCtx(), long)}`.replace(/\s+/g, " ").trim()]);
        expect(runs.some((r) => r.text.includes("(continued)")), `page ${page}`).toBe(true);
        const body = linesOfRuns(runs.filter((r) => r.top > bodyTop));
        expect(body[0].text, `page ${page}`).toContain(heading);
        expect(body[0].text, `page ${page}`).toBe(linesOfRuns(rawRuns(pdf, 1)).find((l) => l.text.startsWith(heading))!.text);
      }
    });

    it("the aging, the finance line and Total Due print on the last page", async () => {
      // Red when the sheet lays its blocks out out of their drawn order (`assembleCanvasSheet`
      // walking `tablesByY(layout).reverse()`): the aging, the finance line and Total Due then print
      // on page 1, ahead of the open items.
      const { pdf, group } = await once();
      const pages = pageCount(pdf);
      expect(pages).toBeGreaterThanOrEqual(2);
      for (const key of ["aging", "finance_charge", "total"] as const) {
        expect(at(group, CANVAS_IDS.end(key)).page, key).toBe(pages);
        expect(at(group, CANVAS_IDS.table(key)).page, key).toBe(pages);
      }
      const last = lineTexts(pdf, pages);
      expect(last.some((t) => t.startsWith(defaultLabelOf(STATEMENT_CONTRACT, "aging_current")))).toBe(true);
      expect(last.some((t) => t.startsWith(FINANCE_LABEL))).toBe(true);
      expect(last.some((t) => t.startsWith(TOTAL_LABEL))).toBe(true);
      for (let page = 1; page < pages; page++) {
        const text = lineTexts(pdf, page);
        expect(text.some((t) => t.startsWith(FINANCE_LABEL) || t.startsWith(TOTAL_LABEL)), `page ${page}`).toBe(false);
      }
    });

    it("with Page N of M on, every page prints its page line and no body run's bottom lies below the page line's top", async () => {
      // Red when the sheet leaves the page line no room (`assembleCanvasSheet`'s bottom margin
      // without PAGE_LINE_ROOM): the rows then run to the plain margin, past the page's foot. The
      // line's own place follows the definition's bottom margin (render.ts), so under that mutation
      // the line moves down with the body and the page-line comparison alone stays green; the foot
      // (`pageFoot(true)`) is what sees it. Red too when the sheet emits no `pageFooterSpec`.
      const { pdf } = await renderStatement(long, stmtCfg(layout, { pageFooter: true }));
      const pages = pageCount(pdf);
      expect(pages).toBeGreaterThanOrEqual(2);
      for (let page = 1; page <= pages; page++) {
        const runs = rawRuns(pdf, page);
        const pageLine = linesOfRuns(runs).find((l) => l.text === `Page ${page} of ${pages}`);
        expect(pageLine, `page ${page}`).toBeDefined();
        // The page line prints at 8.5 pt (render.ts), so its top is at most its size above its
        // baseline; a body run's bottom is its baseline and its descender, under 0.3 of the 10 pt base.
        const lineTop = pageLine!.top - 8.5;
        const body = runs.filter((r) => !pageLine!.runs.includes(r));
        expect(body.length, `page ${page}`).toBeGreaterThan(0);
        for (const run of body) {
          const bottom = run.top + 0.3 * STATEMENT_DEFAULT_CONFIG.fonts.baseSize;
          expect(bottom, `page ${page}: ${run.text}`).toBeLessThan(lineTop);
          expect(bottom, `page ${page}: ${run.text}`).toBeLessThanOrEqual(pageFoot(true));
        }
      }
    });
  });

  it("a customer name that wraps the one-line customer item prints two lines on page 1 and its first line alone on every continuation page", async () => {
    // Open question 10 (design §4.5, call 2): the repeat band is laid out in a frame exactly the top
    // margin tall, and pdfmake drops a line that passes it (`assembleCanvasSheet`'s comment), so the
    // second line, which ends below the top margin, does NOT print on page 2. Pinned as it renders.
    // Red when the customer item's `repeat` is cleared (page 2 prints no customer line).
    // A 60-character name, not the plan's 90: at 90 (and at 70) the 240.5 pt item wraps to THREE
    // lines on page 1, the third below the statement date's box, where 60 wraps to the two the case
    // is about.
    const name = "Wrapping Customer Name ".repeat(3).slice(0, 60);
    const d = richStatement({ openItems: manyOpenItems(300), customer: { ...long.customer, name } });
    const { pdf } = await renderStatement(d, stmtCfg(layout));
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(2);
    // The customer item's lines: from its top down to the statement date item's bottom, the lines
    // of runs inside its box across whose first run starts at its left edge (the statement date's
    // line starts at its own x, left of the box, and the Remit To box lies right of it).
    const customerLines = (page: number) => linesOfRuns(rawRuns(pdf, page).filter((r) =>
      r.top > customerBox.y && r.top <= dateBox.y + dateBox.h && r.x >= customerBox.x - 0.5 && r.x < customerBox.x + customerBox.w))
      .filter((line) => Math.abs(line.runs[0].x - customerBox.x) <= 0.5);
    const first = customerLines(1);
    expect(first).toHaveLength(2);
    expect(first[0].text.startsWith(CUSTOMER_LABEL)).toBe(true);
    expect(`${first[0].text} ${first[1].text}`).toContain(name.trim());
    // The second line prints inside the statement date item's box.
    expect(first[1].top).toBeGreaterThan(dateBox.y);
    expect(first[1].top).toBeLessThanOrEqual(dateBox.y + dateBox.h);
    for (let page = 2; page <= pageCount(pdf); page++) {
      const lines = customerLines(page);
      expect(lines.map((l) => l.text), `page ${page}`).toEqual([first[0].text]);
      expect(Math.abs(lines[0].top - first[0].top), `page ${page}`).toBeLessThanOrEqual(0.5);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The flow's seed ids (design 2026-11-11 §5.3). Under `seedIds` the flow marks its pieces
// (a wrapper stack carrying the id, its end mark inside it, before its bottom margin), the Bill To
// inside the identity's left stack, the left stack's bottom, the identity's opening, its one-node
// blocks (their marks inside the node's own vertical margins) and the finance block (its marks
// top-level siblings, ABOVE its kept 2 pt), and lays out exactly as it does without them.
// ---------------------------------------------------------------------------------------------

describe("the flow's seed ids (design 2026-11-11 §5.3)", () => {
  const PIECES = ["title", "company_name", "customer", "statement_date", "remit_to"];
  const SECTIONS = ["bill_to", "open_items", "aging", "finance_charge", "total"];
  const LOGO_URI = `data:image/jpeg;base64,${TINY_JPEG.toString("base64")}`;
  const PLACEMENTS = ["header-left", "header-center", "header-right"] as const;

  const seedDef = (d: StatementData, config: TemplateConfig, logoUri?: string) =>
    buildStatementDefinition(d, config, logoUri, { seedIds: true });
  async function laidOut(def: ReturnType<typeof buildStatementDefinition>) {
    const { pdf, groups } = await renderSheetGroupsWithPositions([def]);
    return { pdf, group: groups[0] };
  }
  const every = (group: Group, id: string) => group.positions.filter((n) => n.id === id);
  const top = (group: Group, id: string) => at(group, id).top;
  const withLogo = (placement: (typeof PLACEMENTS)[number]) => cfg({ logo: { placement, width: 60 } });
  /** The Standard with its sections complete, edited. */
  const edited = (edit: (c: TemplateConfig) => void): TemplateConfig => {
    const c = cfg();
    c.sections = completeSections(STATEMENT_CONTRACT, c.sections);
    edit(c);
    return c;
  };
  const sectionOf = (c: TemplateConfig, key: string) => c.sections.find((s) => s.key === key)!;
  /** The identity's fields in this order (the rest after them, as they stood). */
  const identityOrder = (...keys: string[]) => edited((c) => {
    const s = sectionOf(c, "identity");
    s.fields = [...keys.map((k) => s.fields.find((f) => f.key === k)!), ...s.fields.filter((f) => !keys.includes(f.key))];
  });
  /** Section `key` moved to just before section `before`. */
  const moveBefore = (key: string, before: string) => edited((c) => {
    const [moved] = c.sections.splice(c.sections.findIndex((s) => s.key === key), 1);
    c.sections.splice(c.sections.findIndex((s) => s.key === before), 0, moved);
  });
  /** The flow's identity `columns` node of a definition. */
  const identityRow = (def: ReturnType<typeof buildStatementDefinition>) => (def.content as Content[]).find((n) =>
    ((n as { columns?: { width?: unknown }[] }).columns ?? []).some((c) => c.width === STATEMENT_WIDTHS.remitTo)) as
    { columns: { stack?: Content[] }[]; margin: number[] };

  // Green on arrival (with no option the four-argument call was the three-argument one); it reds
  // when a seed wrapper moves what it wraps: a piece's margin kept on the piece as well as its
  // wrapper, a one-node block's node keeping its margins inside the marks' stack, or the Remit To
  // wrapper's width dropped (each checked by mutation). The finance block marked through
  // `seedSection` lays out the same and does not red it; the finance case below does.
  it("the seed lays out exactly as the flow: every run at the same place, the same strokes and the same pictures", async () => {
    for (const [config, uri] of [[cfg(), undefined], ...PLACEMENTS.map((p) => [withLogo(p), LOGO_URI] as const)] as const) {
      const flow = await renderPdf(buildStatementDefinition(richStatement(), config, uri));
      const { pdf } = await laidOut(seedDef(richStatement(), config, uri));
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
  });

  // Green on arrival (pin): red when the flow branch reads the option's absence as anything but off.
  it("an empty options object, and seedIds false, are the plain definition, and no flow or canvas print carries a seed id (pin)", () => {
    const ids = (def: unknown) => JSON.stringify(def).match(/"seed:[^"]*"/g) ?? [];
    for (const [config, uri] of [[cfg(), undefined], ...PLACEMENTS.map((p) => [withLogo(p), LOGO_URI] as const)] as const) {
      const plain = buildStatementDefinition(richStatement(), config, uri);
      expect(buildStatementDefinition(richStatement(), config, uri, {})).toEqual(plain);
      expect(buildStatementDefinition(richStatement(), config, uri, { seedIds: false })).toEqual(plain);
      expect(ids(plain)).toEqual([]);
    }
    // The canvas branch ignores the option.
    expect(ids(buildStatementDefinition(richStatement(), stmtCfg(standardStatementLayout()), undefined, { seedIds: true }))).toEqual([]);
  });

  it.each([["no logo", undefined], ...PLACEMENTS.map((p) => [p, p] as const)] as const)(
    "with %s the seed's definition holds every piece's, section's and end mark's id, each laid out once, and no text node carries one",
    async (_name, placement) => {
      const def = placement === undefined ? seedDef(richStatement(), cfg()) : seedDef(richStatement(), withLogo(placement), LOGO_URI);
      const { group } = await laidOut(def);
      const pieces = placement === undefined ? PIECES : [...PIECES, "logo"];
      const ids = [
        ...pieces.flatMap((p) => [STATEMENT_SEED_IDS.piece(p), STATEMENT_SEED_IDS.end(p)]),
        ...SECTIONS.flatMap((s) => [STATEMENT_SEED_IDS.start(s), STATEMENT_SEED_IDS.sectionEnd(s)]),
        STATEMENT_SEED_IDS.leftColumnEnd, STATEMENT_SEED_IDS.identityStart,
      ];
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(every(group, id).length, id).toBe(1);
      // Nothing else in the seed's namespace.
      expect(group.positions.filter((n) => n.id.startsWith("seed:")).length).toBe(ids.length);
      expect(nodesOf(def).filter((n) => "text" in n && "id" in n)).toEqual([]);
    },
  );

  describe("identityStart", () => {
    it("on the Standard stands at the identity's columns node top: the customer line's top less its own margin", async () => {
      const flowRow = identityRow(buildStatementDefinition(richStatement(), cfg()));
      const customerNode = flowRow.columns[0].stack![0];
      const { group } = await laidOut(seedDef(richStatement(), cfg()));
      const start = top(group, STATEMENT_SEED_IDS.identityStart);
      expect(Math.abs(start - (top(group, STATEMENT_SEED_IDS.piece("customer")) - marginOf(customerNode)[1]))).toBeLessThanOrEqual(MARK_TOL);
      // And it is the Remit To box's top: the two columns start together.
      expect(Math.abs(start - top(group, STATEMENT_SEED_IDS.piece("remit_to")))).toBeLessThanOrEqual(MARK_TOL);
    });

    it("with the open items ordered above the identity, it stands at or below the open items' end, by the table's own bottom margin", async () => {
      const config = moveBefore("open_items", "identity");
      const { group } = await laidOut(seedDef(richStatement(), config));
      const end = top(group, STATEMENT_SEED_IDS.sectionEnd("open_items"));
      const start = top(group, STATEMENT_SEED_IDS.identityStart);
      expect(start).toBeGreaterThanOrEqual(end);
      const below = marginOf(STATEMENT_FLOW.openItemsTable(ctxFor(config), richStatement())[0])[3];
      expect(Math.abs(start - (end + below))).toBeLessThanOrEqual(MARK_TOL);
    });

    it("with the identity shown and every field hidden, it is laid out once and the identity prints no columns node", async () => {
      // Red when the opening mark is emitted only beside a columns node (`identityBlock` answering
      // nothing when `cols` is empty).
      const config = edited((c) => {
        const s = sectionOf(c, "identity");
        s.fields = s.fields.map((f) => ({ ...f, visible: false }));
      });
      expect(sectionOf(config, "identity").visible ?? true).toBe(true);
      const def = seedDef(richStatement(), config);
      expect(identityRow(def)).toBeUndefined();
      const { group } = await laidOut(def);
      expect(every(group, STATEMENT_SEED_IDS.identityStart)).toHaveLength(1);
    });
  });

  it("the finance block's start mark is exactly the kept 2 pt above its line's node, the aging's bottom margin under the aging, and its height the kept-margin height", async () => {
    const d = richStatement();
    const node = STATEMENT_FLOW.financeChargeBlock(standardCtx(), d)[0];
    expect(marginOf(node)[1]).toBe(2);
    const { group } = await laidOut(seedDef(d, cfg()));
    const start = top(group, STATEMENT_SEED_IDS.start("finance_charge"));
    const end = top(group, STATEMENT_SEED_IDS.sectionEnd("finance_charge"));
    // The node has no id: its top is the end less its own height with its margins zeroed.
    const line = await aloneHeight([verticalsZeroed(node)], STATEMENT_WIDTHS.content);
    expect(Math.abs((end - line) - start - marginOf(node)[1])).toBeLessThanOrEqual(MARK_TOL);
    // The canvas block's kept-margin height: the node with its bottom margin zeroed alone.
    const kept = await aloneHeight([bottomZeroed(node)], STATEMENT_WIDTHS.content);
    expect(Math.abs(end - start - kept)).toBeLessThanOrEqual(MARK_TOL);
    // The drawn distance from the aging is the aging's own bottom margin, never that plus 2.
    const agingBelow = marginOf(STATEMENT_FLOW.agingStrip(standardCtx(), d)[0])[3];
    expect(Math.abs(start - top(group, STATEMENT_SEED_IDS.sectionEnd("aging")) - agingBelow)).toBeLessThanOrEqual(MARK_TOL);
  });

  it("with no finance charge the finance block's two marks stand together, the aging's bottom margin under the aging", async () => {
    const d = richStatement({ financeCharge: null });
    const { group } = await laidOut(seedDef(d, cfg()));
    const start = top(group, STATEMENT_SEED_IDS.start("finance_charge"));
    expect(top(group, STATEMENT_SEED_IDS.sectionEnd("finance_charge"))).toBe(start);
    const agingBelow = marginOf(STATEMENT_FLOW.agingStrip(standardCtx(), d)[0])[3];
    expect(Math.abs(start - top(group, STATEMENT_SEED_IDS.sectionEnd("aging")) - agingBelow)).toBeLessThanOrEqual(MARK_TOL);
  });

  it("the Remit To piece reports the box's top-left corner: 338 across, at the identity row's top, where the flow strokes it", async () => {
    const def = seedDef(richStatement(), cfg());
    expect(nodesOf(def).find((n) => n.id === STATEMENT_SEED_IDS.piece("remit_to"))!.width).toBe(STATEMENT_WIDTHS.remitTo);
    const { group } = await laidOut(def);
    const piece = at(group, STATEMENT_SEED_IDS.piece("remit_to"));
    const left = CANVAS_PAGE.margin + STATEMENT_WIDTHS.content - STATEMENT_WIDTHS.remitTo;
    expect(left).toBe(338);
    expect(Math.abs(piece.left - left)).toBeLessThanOrEqual(MARK_TOL);
    expect(Math.abs(piece.top - top(group, STATEMENT_SEED_IDS.identityStart))).toBeLessThanOrEqual(MARK_TOL);
    // Where the flow strokes the box: its top rule starts at that x, and a rule is stroked centred on
    // its line, so the box's top edge is half a rule above the stroke's y (`strokedLines` reads
    // top-down). The box's horizontals are the boxed rules starting at its x above the open items.
    const flow = await renderPdf(buildStatementDefinition(richStatement(), cfg()));
    const rule = TABLE_LAYOUTS[LAYOUT.boxed].hLineWidth();
    const box = strokedLines(flow)[0].filter((s) => Math.abs(s.width - rule) < 0.01 && Math.abs(s.y1 - s.y2) < 0.01
      && Math.abs(s.x1 - left) < 0.01 && s.y1 < top(group, STATEMENT_SEED_IDS.start("open_items")));
    expect(box.length, "the Remit To box's horizontals").toBe(2);
    expect(Math.abs(piece.top - (Math.min(...box.map((s) => s.y1)) - rule / 2))).toBeLessThanOrEqual(MARK_TOL);
    // Its bottom rule is the box's end, half a rule below its line.
    expect(Math.abs(top(group, STATEMENT_SEED_IDS.end("remit_to")) - (Math.max(...box.map((s) => s.y1)) + rule / 2))).toBeLessThanOrEqual(MARK_TOL);
  });

  describe("the Bill To marks", () => {
    it("on the Standard its start mark is at the statement date's bottom (its label's 6 pt below it), and leftColumnEnd is its end", async () => {
      const { group } = await laidOut(seedDef(richStatement(), cfg()));
      expect(Math.abs(top(group, STATEMENT_SEED_IDS.start("bill_to")) - top(group, STATEMENT_SEED_IDS.end("statement_date")))).toBeLessThanOrEqual(MARK_TOL);
      expect(Math.abs(top(group, STATEMENT_SEED_IDS.leftColumnEnd) - top(group, STATEMENT_SEED_IDS.sectionEnd("bill_to")))).toBeLessThanOrEqual(MARK_TOL);
    });

    it("with the customer after the Bill To, leftColumnEnd is below the Bill To's end, at the customer's end", async () => {
      const { group } = await laidOut(seedDef(richStatement(), identityOrder("statement_date", "bill_to", "customer")));
      const billEnd = top(group, STATEMENT_SEED_IDS.sectionEnd("bill_to"));
      const leftEnd = top(group, STATEMENT_SEED_IDS.leftColumnEnd);
      expect(leftEnd).toBeGreaterThan(billEnd + 1);
      expect(Math.abs(leftEnd - top(group, STATEMENT_SEED_IDS.end("customer")))).toBeLessThanOrEqual(MARK_TOL);
    });
  });

  it.each([["the rich bill-to", richStatement()], ["a one-line bill-to", oneLineBillTo(richStatement())]] as const)(
    "with %s the open items' start mark is the identity's 10 pt below the lower of leftColumnEnd and the Remit To's end",
    async (_name, d) => {
      const { group } = await laidOut(seedDef(d, cfg()));
      const below = identityRow(buildStatementDefinition(d, cfg())).margin[3];
      expect(below).toBe(10);
      const lower = Math.max(top(group, STATEMENT_SEED_IDS.leftColumnEnd), top(group, STATEMENT_SEED_IDS.end("remit_to")));
      expect(Math.abs(top(group, STATEMENT_SEED_IDS.start("open_items")) - (lower + below))).toBeLessThanOrEqual(MARK_TOL);
    },
  );

  it("company_name's piece is its line alone: its 6 pt bottom margin lies between its end and the identity", async () => {
    const d = richStatement();
    const { group } = await laidOut(seedDef(d, cfg()));
    const flowHeader = (buildStatementDefinition(d, cfg()).content as Content[])[0] as { stack: Content[] };
    const nameNode = flowHeader.stack[1];
    expect(marginOf(nameNode)[3]).toBe(6);
    const line = await aloneHeight([verticalsZeroed(nameNode)], STATEMENT_WIDTHS.content);
    const piece = top(group, STATEMENT_SEED_IDS.piece("company_name"));
    const end = top(group, STATEMENT_SEED_IDS.end("company_name"));
    expect(Math.abs(end - piece - line)).toBeLessThanOrEqual(MARK_TOL);
    expect(Math.abs(top(group, STATEMENT_SEED_IDS.identityStart) - end - marginOf(nameNode)[3])).toBeLessThanOrEqual(MARK_TOL);
  });

  it("an open-items section shown with every row hidden still reports both its marks, together", async () => {
    const config = hiding("open_items", "document_no", "date", "due_date", "original", "open");
    expect(STATEMENT_FLOW.openItemsTable(ctxFor(config), richStatement())).toEqual([]);
    const { group } = await laidOut(seedDef(richStatement(), config));
    expect(every(group, STATEMENT_SEED_IDS.start("open_items"))).toHaveLength(1);
    expect(every(group, STATEMENT_SEED_IDS.sectionEnd("open_items"))).toHaveLength(1);
    expect(top(group, STATEMENT_SEED_IDS.sectionEnd("open_items"))).toBe(top(group, STATEMENT_SEED_IDS.start("open_items")));
  });

  describe("statementSeedStyle", () => {
    const fonts = { ...STATEMENT_DEFAULT_CONFIG.fonts, headingSize: 23 };

    it("answers the flow's five styles, the title's size read from fonts.headingSize, and null for any other key", () => {
      expect(statementSeedStyle("title", fonts)).toEqual({ size: 23, bold: true, align: "center" });
      expect(statementSeedStyle("company_name", fonts)).toEqual({ size: 15, bold: true, align: "center" });
      for (const key of ["customer", "statement_date"]) expect(statementSeedStyle(key, fonts)).toEqual({ size: 10, bold: false, align: "left" });
      expect(statementSeedStyle("remit_to", fonts)).toEqual({ size: 13, bold: true, align: "left" });
      for (const key of ["bill_to", "aging_net", "aging_current", "logo"]) expect(statementSeedStyle(key, fonts), key).toBeNull();
    });

    it("each answer is the flow definition's own node for that key: its size, its alignment and the weight of the text the item prints", () => {
      const def = seedDef(richStatement(), cfg({ fonts }));
      const wrapped = (key: string) => (nodesOf(def).find((n) => n.id === STATEMENT_SEED_IDS.piece(key)) as { stack: Record<string, unknown>[] }).stack;
      /** The flow node's style as an item's: its size, its alignment (pdfmake's default left), and the
       *  weight of the text the item prints (an identity line's value: its label is bold by the
       *  family's rule, never the item's). */
      const styleOf = (node: Record<string, unknown>): CanvasTextStyle => {
        const text = node.text;
        const printed = Array.isArray(text) ? (text.at(-1) as unknown) : node;
        const bold = typeof printed === "object" && printed !== null ? (printed as { bold?: boolean }).bold ?? node.bold ?? false : node.bold ?? false;
        return { size: node.fontSize as number, bold: bold as boolean, align: (node.alignment as CanvasTextStyle["align"]) ?? "left" };
      };
      for (const key of ["title", "company_name", "customer", "statement_date"]) {
        expect(statementSeedStyle(key, fonts), key).toEqual(styleOf(wrapped(key)[0]));
      }
      // The Remit To's item style is its box's label's.
      const box = wrapped("remit_to")[1] as { table: { body: { stack: Record<string, unknown>[] }[][] } };
      expect(statementSeedStyle("remit_to", fonts)).toEqual(styleOf(box.table.body[0][0].stack[0]));
    });
  });
});
