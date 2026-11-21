import { describe, it, expect, beforeEach } from "vitest";
import { buildCertDefinition, CERT_FLOW, CERT_PAGE, CERT_WIDTHS, type CertCtx, type CertPdfData } from "@/server/pdf/cert";
import { renderPdf, renderSheetGroupsWithPositions, type LaidOutNode } from "@/server/pdf/render";
import { assembleCanvasSheet, CANVAS_IDS, defaultLabelOf } from "@/server/pdf/canvas-sheet";
import { certItemContent } from "@/server/cert-canvas";
import { CERT_CANVAS, CERT_CONTRACT, CERT_LEAST_WIDTHS, DEFAULT_CONFIG as CERT_DEFAULT_CONFIG } from "@/lib/template-contracts/cert";
import { CANVAS_GRID, CANVAS_PAGE, type CanvasItem, type CanvasLayout } from "@/lib/template-contracts/canvas";
import { bandTop, pageFoot, tablesByY } from "@/lib/template-canvas";
import { completeSections, type TemplateConfig } from "@/lib/template-contracts/types";
import {
  alphaPng, drawnText, pageCount, pageStreams, paintedImageCounts, paintedImages, runFonts, strokedLines, textLinesWithY, textRunsWithY,
  tinyAlphaPng,
} from "./helpers/pdf";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { runWithContext } from "@/server/context";
import { createOrder } from "@/server/orders";
import { createCert, printCert, updateCert } from "@/server/certs";
import { replaceReadings } from "@/server/cert-results";
import { seedCertLayout } from "@/server/cert-canvas-seed";
import { validateConfig } from "@/lib/template-contracts/index";
import { createShipper } from "@/server/shippers";
import { createTemplate, editDraft, publishDraft, uploadLogo } from "@/server/templates";
import { assignTemplate } from "@/server/template-assignments";
import { canvasRefusal } from "@/lib/template-canvas";
import { POST as shipperPrintRoute } from "@/app/api/shippers/[id]/print/route";
import type { Customer } from "../prisma/generated/prisma/client";
import { barcode, layoutOf, logo } from "./helpers/canvas-fixtures";
import { blockItems } from "./helpers/canvas-blocks";
import { certField, certTable, sampleCert, standardCertLayout } from "./helpers/cert-canvas-fixtures";
import { bandClipLayout, expectBandClip } from "./helpers/band-clip";

/**
 * The certification's canvas (design 2026-11-10, PR 2). Task 1: the flow exports its widths
 * (`CERT_WIDTHS`) and its builders (`CERT_FLOW`) with no change to its paper; the profile's least
 * widths (`CERT_LEAST_WIDTHS`, a PR 1 literal) are held to those widths here.
 */

describe("the flow's widths hold the profile (design 2026-11-10 §4.1, §12)", () => {
  const W = CERT_WIDTHS;
  const derived: Record<string, number> = {
    to: W.toCity + W.toState + W.toZip + 2 * W.partiesGap + CANVAS_GRID,
    signature: W.signatureFit + CANVAS_GRID,
  };

  it("pin: names a least width for exactly the To and signature blocks", () => {
    expect(Object.keys(CERT_LEAST_WIDTHS).sort()).toEqual(["signature", "to"]);
  });

  it.each(Object.keys(derived))("%s's least width is its derivation from the flow's widths", (key) => {
    expect(CERT_LEAST_WIDTHS[key]).toBe(derived[key]);
  });
});

/** One `columns` node of a definition: its column widths, its gap, and for each column the length of
 *  a rule sitting directly in its stack (null where none does). */
type ColumnsShape = { widths: unknown[]; gap: unknown; rules: (number | null)[] };

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
      widths: cols.map((c) => c.width),
      gap: o.columnGap ?? null,
      rules: cols.map((c) => {
        const stack = Array.isArray(c.stack) ? (c.stack as Record<string, unknown>[]) : [];
        const rule = stack.find((s) => Array.isArray(s.canvas));
        return rule === undefined ? null : ((rule.canvas as Record<string, unknown>[])[0].x2 as number);
      }),
    });
  }
  for (const value of Object.values(o)) columnsShapes(value, out);
  return out;
}

describe("the flow prints at the widths it exports", () => {
  // The proof is that the FLOW reads the constant: a literal put back in a flow block reds this,
  // where a changed constant would move both sides together.
  const W = CERT_WIDTHS;

  it("every columns row of the standard paper takes its widths and gaps from CERT_WIDTHS", () => {
    // Exact and in order: the header, the parties (the To column and the right column), the To
    // block's city line inside it, and the signature row with its rule.
    expect(columnsShapes(buildCertDefinition(sampleCert()).content)).toEqual([
      { widths: [W.headerLeft, "*", W.headerRight], gap: W.headerGap, rules: [null, null, null] },
      { widths: ["*", W.partiesRight], gap: W.partiesGap, rules: [null, null] },
      { widths: [W.toCity, W.toState, W.toZip], gap: null, rules: [null, null, null] },
      { widths: ["*", W.signature], gap: null, rules: [null, W.signature] },
    ]);
  });

  it("the footer strip takes its phone column's width from CERT_WIDTHS", () => {
    expect(columnsShapes(buildCertDefinition(sampleCert()).footer)).toEqual([
      { widths: ["*", W.footerPhone], gap: null, rules: [null, null] },
    ]);
  });

  it("the signature rule is CERT_WIDTHS.signature long", () => {
    const shapes = columnsShapes(buildCertDefinition(sampleCert()).content);
    expect(shapes.at(-1)!.rules[1]).toBe(W.signature);
  });
});

describe("the flow prints at the vertical constants it exports", () => {
  // As above: a literal put back in the flow reds this, where a changed constant would not.
  it("the page's bottom margin, the strip's top inset and the header's bottom margin read CERT_PAGE", () => {
    const def = buildCertDefinition(sampleCert());
    expect((def.pageMargins as number[])[3]).toBe(CERT_PAGE.bottomMargin);
    expect((def.footer as { margin: number[] }).margin).toEqual([24, CERT_PAGE.stripInset, 24, 0]);
    const header = (def.content as unknown as Record<string, unknown>[])[0];
    expect((header.columns as unknown[]).length).toBe(3);
    expect(header.margin).toEqual([0, 0, 0, CERT_PAGE.headerBottom]);
  });
});

// ---------------------------------------------------------------------------------------------
// The field families (Task 2). `textLinesWithY` and `textRunsWithY` report a baseline from the
// page's BOTTOM edge; a run's x is its start.
// ---------------------------------------------------------------------------------------------

const cfg = (over: Partial<TemplateConfig> = {}): TemplateConfig => ({ ...structuredClone(CERT_DEFAULT_CONFIG), ...over });

/** The ctx the flow builds from `config` (`buildCertDefinition`'s own), so the date knob, the number
 *  format and the sections are the config's. */
function ctxFor(config: TemplateConfig): CertCtx {
  return {
    fonts: config.fonts,
    num: CERT_FLOW.makeNum(config.formats),
    date: CERT_FLOW.makeCertDate(config.formats),
    sections: new Map(completeSections(CERT_CONTRACT, config.sections).map((sc) => [sc.key, CERT_FLOW.sectionView(sc)] as const)),
    logo: null,
  };
}

/** A sheet of these items alone (no block), rendered. */
async function renderItems(items: CanvasItem[], config: TemplateConfig = cfg(), d: CertPdfData = sampleCert()): Promise<Buffer> {
  return renderPdf(assembleCanvasSheet({
    layout: layoutOf(items), pageFooter: false, fonts: config.fonts,
    itemContent: certItemContent(ctxFor(config), d, CERT_FLOW), tableBlock: () => null,
  }));
}

/** Page 1's printed lines. */
const linesOf = async (pdf: Promise<Buffer>) => textLinesWithY(await pdf)[0].map((l) => l.text).filter((t) => t !== "");

const isBold = (font: string): boolean => font.endsWith("-Medium") || font.endsWith("-Bold");

/** The flow's config with one field of a section hidden. */
function hiding(section: string, field: string): TemplateConfig {
  const config = cfg();
  config.sections = completeSections(CERT_CONTRACT, config.sections).map((sc) => sc.key !== section ? sc : {
    ...sc, fields: sc.fields.map((f) => f.key === field ? { ...f, visible: false } : f),
  });
  return config;
}

describe("the certification's field families (design 2026-11-10 §4.2)", () => {
  const d = sampleCert();

  /**
   * Each field key and the flow print it is held to. The flow prints the footer's address and phone
   * on ONE baseline (two columns of one row, at one size), so each of those two is held to the flow
   * with its sibling hidden, where it prints alone on its baseline; every other key prints alone on
   * its baseline in the default flow. So each item's line is one of its oracle's lines WHOLE: a short
   * or partial text cannot pass by containment.
   */
  const KEYS: { key: string; oracle: () => TemplateConfig; line: string }[] = [
    { key: "company_name", oracle: cfg, line: d.company.name },
    { key: "title", oracle: cfg, line: "Certification" },
    { key: "order_no", oracle: cfg, line: `Order No.: ${d.orderLabel}` },
    { key: "print_date", oracle: cfg, line: "Date: 08/03/2026" },
    { key: "entry_date", oracle: cfg, line: "Entry Date: 07/29/2026" },
    { key: "po_number", oracle: cfg, line: `Purchase Order No.: ${d.poNumber}` },
    { key: "packing_list_no", oracle: cfg, line: "Packing List No.: 092826" },
    { key: "material", oracle: cfg, line: `Material: ${d.material}` },
    { key: "footer_address", oracle: () => hiding("footer", "footer_phone"), line: "100 Example Way Anniston AL 36207" },
    { key: "footer_phone", oracle: () => hiding("footer", "footer_address"), line: `Phone: ${d.company.phone}` },
  ];

  it("pin: the ten keys are the profile's field keys less its notFields and the part lines' columns", () => {
    const columns = CERT_CONTRACT.sections.find((s) => s.key === "parts")!.fields.map((f) => f.key);
    const placeable = CERT_CONTRACT.sections.flatMap((s) => s.fields.map((f) => f.key))
      .filter((key) => !CERT_CANVAS.notFields.includes(key) && !columns.includes(key));
    expect(KEYS.map((k) => k.key).sort()).toEqual([...placeable].sort());
  });

  it.each(KEYS)("$key prints the flow's line for its key, whole", async ({ key, oracle, line }) => {
    const flow = await linesOf(renderPdf(buildCertDefinition(d, oracle())));
    const lines = await linesOf(renderItems([certField(key, { box: { x: 24, y: 100, w: 400, h: 12 } })]));
    expect(lines).toEqual([line]);
    expect(flow).toContain(line);
  });

  it("every print date placed prints the date knob's date, and never the raw date", async () => {
    // A format that is neither the raw ISO date nor the default, so a slot reading the date raw, or
    // through any other format, cannot print it.
    const config = cfg({ formats: { ...CERT_DEFAULT_CONFIG.formats, dateFormat: "MMMM D, YYYY" } });
    const items = [
      certField("print_date", { id: "print-date-1", box: { x: 24, y: 100, w: 300, h: 12 } }),
      certField("print_date", { id: "print-date-2", box: { x: 24, y: 300, w: 300, h: 12 } }),
      certField("entry_date", { box: { x: 24, y: 500, w: 300, h: 12 } }),
    ];
    const lines = await linesOf(renderItems(items, config));
    expect(lines).toEqual(["Date: August 3, 2026", "Date: August 3, 2026", "Entry Date: July 29, 2026"]);
    expect(lines.join(" ")).not.toContain(d.printDate);
    expect(lines.join(" ")).not.toContain(d.entryDate);
  });

  it("the packing list number prints zero-padded to six digits, and the label alone with no shipment", async () => {
    const item = [certField("packing_list_no", { box: { x: 24, y: 100, w: 300, h: 12 } })];
    expect(await linesOf(renderItems(item, cfg(), sampleCert({ packingListNo: 4321 })))).toEqual(["Packing List No.: 004321"]);
    expect(await linesOf(renderItems(item, cfg(), sampleCert({ packingListNo: null })))).toEqual(["Packing List No.:"]);
  });

  it("the item's style reaches the paper: its size, its weight both ways, and its alignment", async () => {
    // The order number at 14 pt, regular and bold: every run at 14 pt in the face the item names.
    for (const bold of [false, true]) {
      const runs = runFonts(await renderItems([certField("order_no", {
        box: { x: 24, y: 100, w: 300, h: 20 }, style: { size: 14, bold, align: "left" },
      })]));
      expect(runs.map((r) => r.text).join("").replace(/\s+/g, "")).toBe(`OrderNo.:${d.orderLabel}`);
      for (const r of runs) {
        expect(r.size).toBe(14);
        expect(isBold(r.font)).toBe(bold);
      }
    }
    // The phone right-aligned and bold at the small size: it ends at its box's right edge. Its
    // natural width is measured alone, the auto column before an END marker (render-primitives'
    // `naturalAlone`), in the same face and size.
    const box = { x: 300, y: 100, w: 200, h: 12 };
    const runs = runFonts(await renderItems([certField("footer_phone", { box, style: { size: 7.5, bold: true, align: "right" } })]));
    for (const r of runs) expect(isBold(r.font)).toBe(true);
    const natural = textRunsWithY(await renderPdf({
      pageSize: "LETTER", pageMargins: [24, 24, 24, 24], defaultStyle: { font: CERT_DEFAULT_CONFIG.fonts.family, fontSize: 10 },
      content: [{ columns: [{ width: "auto", text: `Phone: ${d.company.phone}`, fontSize: 7.5, bold: true }, { width: "auto", text: "END" }], columnGap: 0 }],
    }))[0];
    const width = natural.find((r) => r.text === "END")!.x - natural[0].x;
    const start = Math.min(...runs.map((r) => r.x));
    expect(Math.abs(start + width - (box.x + box.w))).toBeLessThan(1);
  });

  it("a text block, a block's field, a part line's column and a barcode print nothing", async () => {
    const content = certItemContent(ctxFor(cfg()), d, CERT_FLOW);
    const columns = CERT_CONTRACT.sections.find((s) => s.key === "parts")!.fields.map((f) => f.key);
    const nothing: CanvasItem[] = [
      { id: "wording", kind: "textBlock", key: "cert_statement", box: { x: 24, y: 100, w: 400, h: 40 },
        anchor: { kind: "page-top" }, repeat: false, style: { size: 9.5, bold: false, align: "left" } },
      ...[...CERT_CANVAS.notFields, ...columns].map((key) => certField(key, { box: { x: 24, y: 200, w: 400, h: 12 } })),
      barcode({ box: { x: 24, y: 300, w: 200, h: 40 } }),
    ];
    for (const item of nothing) expect(content(item), item.kind === "field" ? item.key : item.kind).toBeNull();
    expect(await linesOf(renderItems(nothing))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// A canvas certification (Task 3): the seven blocks, the items riding them, the lens and the branch.
// COORDINATES: `renderSheetGroupsWithPositions`' positions, `strokedLines`, `paintedImages` (after
// `PAGE_HEIGHT − y`, below) and the layout's boxes are top-down page coordinates; `textRunsWithY`
// reports a baseline from the page's BOTTOM edge, which `runsOf` turns into a top-down `top`.
//
// A BLOCK'S RENDERED TOP is read as the measure reads it (`canvasMeasure`, src/server/canvas-measure.ts):
// the first block's drawn top (the spacer ends there), every later block's where the region above it
// ends (its `regionEnd` mark). Its own id is not that: pdfmake reports a stack where its first laid-out
// line starts, UNDER that line's own top margin, which a several-node block keeps (the requirement's
// 4 pt, probed: a stack whose first child carries a 4 pt top margin reports 4 pt under the mark
// before it). So "N pt under the block's top" is measured from `blockTop`, never from the block's id.
// ---------------------------------------------------------------------------------------------

const PAGE_HEIGHT = 792;
const BLOCKS = ["to", "parts", "statement", "requirements", "serials", "freeform", "signature"] as const;
type Block = (typeof BLOCKS)[number];

const certCfg = (layout: CanvasLayout | null, over: Partial<TemplateConfig> = {}): TemplateConfig =>
  ({ ...structuredClone(CERT_DEFAULT_CONFIG), layout, ...over });

/** The definition, rendered, and its positions. pdfmake lays out the nodes it is handed and writes
 *  its own keys onto them (`positions`, `_margin`, …), so the builder's own definition is rendered,
 *  as a print renders it, and `def` is a JSON copy taken before the render (a definition is pure
 *  JSON): what the builder answered, for the reads of a block's children (`blockItems`) and its own
 *  offset (`ownOffset`). */
async function renderCert(d: CertPdfData, config: TemplateConfig, logoDataUri?: string) {
  const built = buildCertDefinition(d, config, logoDataUri);
  const def = JSON.parse(JSON.stringify(built)) as typeof built;
  const { pdf, groups } = await renderSheetGroupsWithPositions([built]);
  return { pdf, def, group: groups[0] };
}

type Group = { positions: LaidOutNode[] };

/** The laid-out node under an id, which the case requires. */
function at(group: Group, id: string): LaidOutNode {
  const found = group.positions.find((node) => node.id === id);
  if (found === undefined) throw new Error(`no laid-out node "${id}"`);
  return found;
}
const has = (group: Group, id: string): boolean => group.positions.some((node) => node.id === id);

/** A layout's item with this id, replaced. */
function withItem(layout: CanvasLayout, id: string, change: (item: CanvasItem) => CanvasItem): CanvasLayout {
  return layoutOf(layout.items.map((item) => (item.id === id ? change(item) : item)));
}
/** A block's drawn box in the layout, moved or resized. */
const reboxed = (layout: CanvasLayout, key: Block, box: Partial<CanvasItem["box"]>): CanvasLayout =>
  withItem(layout, `table-${key}`, (item) => ({ ...item, box: { ...item.box, ...box } }));
/** A rows block's row hidden. */
const rowHidden = (layout: CanvasLayout, key: Block, row: string): CanvasLayout =>
  withItem(layout, `table-${key}`, (item) => item.kind !== "table" ? item : {
    ...item, columns: item.columns.map((c) => (c.key === row ? { ...c, visible: false } : c)),
  });

const blockBox = (layout: CanvasLayout, key: Block) =>
  layout.items.find((item) => item.kind === "table" && item.key === key)!.box;

/** The block before `key` in the layout's drawn order (null for the first). */
function above(layout: CanvasLayout, key: Block): Block | null {
  const tables = tablesByY(layout);
  const i = tables.findIndex((t) => t.key === key);
  return i <= 0 ? null : (tables[i - 1].key as Block);
}

/** A block's rendered top (see the section's comment). */
function blockTop(group: Group, layout: CanvasLayout, key: Block): { page: number; top: number } {
  const prev = above(layout, key);
  if (prev === null) return { page: 1, top: blockBox(layout, key).y };
  const end = at(group, CANVAS_IDS.regionEnd(prev));
  return { page: end.page, top: end.top };
}

/** The drawn distance between a block and the block above it. */
function drawnGap(layout: CanvasLayout, key: Block): number {
  const prev = above(layout, key)!;
  const a = blockBox(layout, prev);
  return blockBox(layout, key).y - a.y - a.h;
}

/** Page `page`'s text runs starting with `needle`, each with its x and its top-down baseline. */
const runsOf = (pdf: Buffer, needle: string, page = 1) =>
  textRunsWithY(pdf)[page - 1].filter((r) => r.text.trim().startsWith(needle)).map((r) => ({ x: r.x, top: PAGE_HEIGHT - r.y }));

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

/** Page `page`'s horizontal strokes of this weight (null: any), each as its x, its length and its y. */
const horizontals = (pdf: Buffer, weight: number | null, page = 1) => strokedLines(pdf)[page - 1]
  .filter((s) => Math.abs(s.y1 - s.y2) < 0.01 && Math.abs(s.x2 - s.x1) > 0.01 && (weight === null || Math.abs(s.width - weight) < 0.01))
  .map((s) => ({ x: Math.min(s.x1, s.x2), length: Math.abs(s.x2 - s.x1), y: s.y1 }));

/** A text's natural width at a size and weight in the Standard's face, measured alone: the auto
 *  column before an END marker (render-primitives' `naturalAlone`). */
async function naturalWidth(text: string, fontSize: number, bold = false): Promise<number> {
  const runs = textRunsWithY(await renderPdf({
    pageSize: "LETTER", pageMargins: [24, 24, 24, 24], defaultStyle: { font: CERT_DEFAULT_CONFIG.fonts.family, fontSize: 10 },
    content: [{ columns: [{ width: "auto", text, fontSize, bold }, { width: "auto", text: "END" }], columnGap: 0 }],
  }))[0];
  return runs.find((r) => r.text === "END")!.x - runs[0].x;
}

/** A part line and the requirement that inspects it, for a multi-part cert. */
function secondPart(readings: number[] = [31, 32, 33]): Pick<CertPdfData, "parts" | "requirements"> {
  const d = sampleCert();
  return {
    parts: [...d.parts, { qty: 40, partNumber: "DEMO02-HT", partName: "Bracket, Mounting", partDescription: "", pounds: 300 }],
    requirements: [...d.requirements, {
      lineIdentity: "line-2", linePosition: 2, partNumber: "DEMO02-HT", partName: "Bracket, Mounting",
      specification: "Were heat treated as per P.O. 7781", scale: "HRB", readings,
    }],
  };
}

/** The one-node blocks (design §5.2): each prints its node with its own vertical margins zeroed. */
const ONE_NODE: ReadonlySet<string> = new Set(["to", "parts", "statement", "freeform", "signature"]);

/** How far under its rendered top a block's own id reports it: 0 for a one-node block (its node's
 *  own top margin zeroed), and for a several-node block its first child's own top margin, kept
 *  inside the wrapper (read from the definition, never retyped). */
function ownOffset(def: unknown, key: string): number {
  if (ONE_NODE.has(key)) return 0;
  const margin = (blockItems(def, key) as { margin?: number | number[] }[])[0].margin;
  return margin === undefined ? 0 : typeof margin === "number" ? margin : margin[1];
}

/** The left edge of page `page`'s printed line whose baseline is `top` (top-down). */
const lineLeft = (pdf: Buffer, top: number, page = 1) =>
  Math.min(...textRunsWithY(pdf)[page - 1].filter((r) => Math.abs(PAGE_HEIGHT - r.y - top) < 0.3).map((r) => r.x));

/** The parties' rule item of the standard layout and its offset below the To block. */
const RULE = () => standardCertLayout().items.find((item) => item.id === "parties-rule")!;

describe("a canvas certification (design 2026-11-10 §4.4, §5.2)", () => {
  const W = CERT_WIDTHS;
  const layout = standardCertLayout();

  it("prints each page-top item at its drawn place and the blocks in y order, each riding the block above it; pure JSON, no overflow margin, no id on a text node", async () => {
    const def = buildCertDefinition(sampleCert(), certCfg(layout));
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
    expect(def.continuationHeaderSpec).not.toHaveProperty("overflowTopMargin");
    // The ids are where the measure reads them, never on a text node.
    const nodes = nodesOf(def);
    expect(nodes.filter((n) => "text" in n && "id" in n)).toEqual([]);
    for (const key of BLOCKS) expect(nodes.filter((n) => n.id === CANVAS_IDS.table(key)), key).toHaveLength(1);

    const { pdf, group } = await renderCert(sampleCert(), certCfg(layout));
    expect(pageCount(pdf)).toBe(1);
    // The first block at its drawn top.
    expect(Math.abs(at(group, CANVAS_IDS.table("to")).top - blockBox(layout, "to").y)).toBeLessThan(2);
    let previous = -Infinity;
    for (const key of BLOCKS) {
      const own = at(group, CANVAS_IDS.table(key));
      expect(own.page, key).toBe(1);
      expect(own.top, key).toBeGreaterThan(previous);
      previous = own.top;
      const prev = above(layout, key);
      if (prev === null) continue;
      // Each later block at the rendered bottom of the block above it plus their drawn distance.
      const top = blockTop(group, layout, key);
      expect(top.top - at(group, CANVAS_IDS.end(prev)).top, key).toBeCloseTo(drawnGap(layout, key), 2);
      // Its own id at that top for a one-node block, and a several-node block's first child's own top
      // margin under it (the requirement's 4, the serial list's 2).
      expect(Math.abs(own.top - top.top - ownOffset(def, key)), key).toBeLessThan(0.01);
    }
    expect(ownOffset(def, "requirements")).toBeGreaterThan(0);
    expect(ownOffset(def, "serials")).toBeGreaterThan(0);
    // Every page-top field: its wrapper exactly at its box's top-left, its first baseline in its box.
    for (const item of layout.items) {
      if (item.kind !== "field" || item.anchor.kind !== "page-top") continue;
      expect(at(group, CANVAS_IDS.item(item.id)), item.id).toMatchObject({ page: 1, left: item.box.x, top: item.box.y });
    }
    for (const [id, needle] of [["field-company_name", "Example"], ["field-title", "Certification"], ["field-order_no", "Order"], ["field-po_number", "Purchase"]] as const) {
      const box = layout.items.find((item) => item.id === id)!.box;
      const top = runsOf(pdf, needle).find((r) => r.x >= box.x - 0.01 && r.x <= box.x + box.w)!.top;
      expect(top - box.y, id).toBeGreaterThan(0);
      expect(top - box.y, id).toBeLessThan(box.h + 2);
    }
  });

  it("routes a text item, the logo, the parties' rule and a box through the shared helpers", async () => {
    const extra: CanvasItem[] = [
      { id: "note", kind: "text", text: "QA COPY", box: { x: 24, y: 24, w: 100, h: 12 }, anchor: { kind: "page-top" },
        repeat: false, style: { size: 10, bold: false, align: "left" } },
      logo({ id: "logo", box: { x: 24, y: 40, w: 60, h: 28 } }),
      { id: "frame", kind: "box", weight: 2.25, box: { x: 200, y: 30, w: 80, h: 30 }, anchor: { kind: "page-top" }, repeat: false },
    ];
    const withExtras = layoutOf([...layout.items, ...extra]);
    const uri = `data:image/png;base64,${tinyAlphaPng().toString("base64")}`;
    const { pdf, group } = await renderCert(sampleCert(), certCfg(withExtras), uri);
    // On the company name's baseline, so read by its runs: at the text item's x.
    const exact = (text: string) => textRunsWithY(pdf)[0].filter((r) => r.text.trim() === text).map((r) => r.x);
    expect(exact("QA")).toEqual([24]);
    expect(exact("COPY")).toHaveLength(1);
    // The logo and the signer's image.
    expect(paintedImageCounts(pdf)).toEqual([2]);
    // The rule: 1.5 pt, its drawn width, at its offset below the To block's rendered bottom.
    const rule = RULE();
    const strokes = horizontals(pdf, 1.5).filter((h) => Math.abs(h.length - rule.box.w) < 0.01);
    expect(strokes).toHaveLength(1);
    expect(strokes[0].x).toBeCloseTo(rule.box.x, 2);
    expect(strokes[0].y - at(group, CANVAS_IDS.end("to")).top).toBeCloseTo(rule.box.y, 1);
    // The box: one rectangle of its size stroked at its weight (a canvas `rect` is an `re` path, which
    // `strokedLines` does not read).
    expect([...pageStreams(pdf)[0].matchAll(/2\.25 w\n(?:(?!re\n)[\s\S])*?-?[\d.]+ -?[\d.]+ 80 30 re\n/g)]).toHaveLength(1);
  });

  it("the lens: a layout holding the field-keyed To block renders, the To block never handed to the section view", async () => {
    const { pdf } = await renderCert(sampleCert(), certCfg(layoutOf([certTable("to")])));
    expect(linesOn(pdf).map((l) => l.text)).toContain("To:");
  });

  it("a page-bottom Text item whose words run past the band's foot is cut at the band's bottom edge, whole lines, with the page line off and on (#978)", async () => {
    // Red when the band's footer frame is not ended at the band's bottom edge (render.ts's
    // `installBandFrame` wrapper): the item's overflow then prints below the edge, in the page's
    // bottom margin, and with the page line on over and under it.
    for (const pageFooter of [false, true]) {
      const layout = bandClipLayout(standardCertLayout(), pageFooter);
      expect(canvasRefusal(layout, CERT_CONTRACT, { pageFooter }), `page line ${pageFooter}`).toBeNull();
      const { pdf } = await renderCert(sampleCert(), certCfg(layout, { pageFooter }));
      expect(pageCount(pdf), `page line ${pageFooter}`).toBe(1);
      expectBandClip(pdf, pageFooter);
    }
  });

  describe("the To block", () => {
    it("prints its label underlined at 11 pt bold, a typed heading in its place, and the address at the flow's columns from the block's x", async () => {
      const moved = withItem(reboxed(layout, "to", { x: 40, w: 298 }), "table-to", (item) => ({ ...item, heading: "Ship To:" } as CanvasItem));
      const { pdf } = await renderCert(sampleCert(), certCfg(moved));
      const label = runFonts(pdf).filter((r) => r.text === "Ship" || r.text === "To:");
      expect(label.map((r) => r.text)).toEqual(["Ship", "To:"]);
      for (const r of label) {
        expect(r.size).toBe(11);
        expect(isBold(r.font)).toBe(true);
      }
      expect(label[0].x).toBeCloseTo(40, 2);
      // Underlined: pdfmake paints a decoration as a filled rect, which no stroke reader sees, so the
      // node is read: the block's one child is the To stack, whose first child is the flow's label node.
      const [toStack] = blockItems(buildCertDefinition(sampleCert(), certCfg(moved)), "to") as Record<string, unknown>[];
      expect((toStack.stack as Record<string, unknown>[])[0]).toMatchObject({ text: "Ship To:", decoration: "underline", bold: true, fontSize: 11 });
      // The city, state and zip at the flow's offsets from the block's x: the flow lays them out inside
      // the parties' columns node, whose gap (`partiesGap`) pdfmake hands down to them.
      const d = sampleCert();
      const flow = await renderPdf(buildCertDefinition(d, certCfg(null)));
      const offset = (pdf: Buffer, text: string, x: number) => runsOf(pdf, text)[0].x - x;
      expect(offset(flow, d.to.state, 24)).toBeCloseTo(W.toCity + W.partiesGap, 2);
      expect(offset(flow, d.to.zip, 24)).toBeCloseTo(W.toCity + W.toState + 2 * W.partiesGap, 2);
      for (const text of [d.to.city, d.to.state, d.to.zip]) {
        expect(offset(pdf, text, 40), text).toBeCloseTo(offset(flow, text, 24), 2);
      }
      expect(linesOn(pdf).map((l) => l.text)).toEqual(expect.arrayContaining([d.to.name, d.to.street]));
    });

    it("an attn line moves the parties' rule and the part lines down by that line", async () => {
      const without = await renderCert(sampleCert(), certCfg(layout));
      const attn = sampleCert({ to: { ...sampleCert().to, attn: "Accounts Payable" } });
      const withAttn = await renderCert(attn, certCfg(layout));
      expect(linesOn(withAttn.pdf).map((l) => l.text)).toContain("Accounts Payable");
      const shift = at(withAttn.group, CANVAS_IDS.end("to")).top - at(without.group, CANVAS_IDS.end("to")).top;
      // One 10 pt line: the name's baseline to the street's, the next 10 pt line with no margin between.
      const street = sampleCert().to.street.split(" ")[0];
      const line = runTop(without.pdf, street) - runTop(without.pdf, sampleCert().to.name.split(" ")[0]);
      expect(line).toBeGreaterThan(10);
      expect(Math.abs(shift - line)).toBeLessThan(0.01);
      const ruleY = (pdf: Buffer) => horizontals(pdf, 1.5).find((h) => Math.abs(h.length - RULE().box.w) < 0.01)!.y;
      expect(Math.abs(ruleY(withAttn.pdf) - ruleY(without.pdf) - shift)).toBeLessThan(0.5);
      expect(Math.abs(runTop(withAttn.pdf, "Quantity") - runTop(without.pdf, "Quantity") - shift)).toBeLessThan(0.5);
      expect(Math.abs(runTop(withAttn.pdf, street) - runTop(without.pdf, street) - shift)).toBeLessThan(0.5);
    });
  });

  describe("the part lines", () => {
    const narrow = reboxed(layout, "parts", { x: 24, w: 400 });
    const width = (key: string) => CERT_CONTRACT.sections.find((s) => s.key === "parts")!.fields.find((f) => f.key === key)!.column!.defaultWidth as number;

    it("drawn at x 24, 400 wide: the identity column takes the drawn width less the fixed columns; each weight prints lb", async () => {
      const { pdf } = await renderCert(sampleCert(), certCfg(narrow));
      // The ruled layout draws no vertical rules, so the columns are read from the headings, each
      // centred in its column: its first run's x plus half its width, measured alone.
      const label = (key: string) => defaultLabelOf(CERT_CONTRACT, key);
      const centre = async (on: Buffer, key: string) => runsOf(on, label(key).split(" ")[0])[0].x + (await naturalWidth(label(key), 9, true)) / 2;
      // A column's cell padding, read from the flow (564 wide from 24): its weight heading's centre
      // sits that padding and half the column in from the content's right edge.
      const flow = await renderPdf(buildCertDefinition(sampleCert()));
      const pad = 588 - width("part_pounds") / 2 - (await centre(flow, "part_pounds"));
      expect(pad).toBeGreaterThan(0);
      // The identity column takes what the fixed columns leave of the drawn 400, its heading centred
      // in it (the paddings either side of it cancel); the weight column ends that padding in from 424.
      expect(await centre(pdf, "part_identity")).toBeCloseTo(24 + width("part_qty") + (400 - width("part_qty") - width("part_pounds")) / 2, 0);
      expect(await centre(pdf, "part_pounds")).toBeCloseTo(424 - pad - width("part_pounds") / 2, 0);
      // The table's rules (one segment a cell) run its drawn width, 24 to 424.
      const rules = horizontals(pdf, 0.8);
      expect(Math.min(...rules.map((h) => h.x))).toBeCloseTo(24, 2);
      expect(Math.max(...rules.map((h) => h.x + h.length))).toBeCloseTo(424, 2);
      expect(linesOn(pdf).some((l) => l.text.endsWith("4,128 lb"))).toBe(true);
    });

    it("its heading row repeats on a split, the table at its drawn width on every page", async () => {
      const many = sampleCert({
        parts: Array.from({ length: 80 }, (_, i) => ({ qty: i + 1, partNumber: `P-${1000 + i}`, partName: "Track Shoe", partDescription: "D-001", pounds: 10 })),
      });
      const { pdf } = await renderCert(many, certCfg(narrow));
      expect(pageCount(pdf)).toBeGreaterThanOrEqual(2);
      expect(runsOf(pdf, "Quantity", 2)).toHaveLength(1);
      // Page 2's rules run the drawn 24 to 424, where the flow's run the content's 24 to 588.
      const rules = horizontals(pdf, 0.8, 2);
      expect(rules.length).toBeGreaterThan(0);
      expect(Math.max(...rules.map((h) => h.x + h.length))).toBeCloseTo(424, 2);
    });

    describe("a parts table drawn 40 pt in on each side that breaks across pages (#969)", () => {
      // The probe's datasets (#969 plan, Task 3): A, 80 part lines, 60 readings, 20 serials and a
      // freeform line that wraps at the content's width; B, A with every later block's text long
      // enough to wrap, the statement ending in a marker its wrapped last line starts with.
      const WORDS = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu";
      const datasetA = (): CertPdfData => {
        const d = sampleCert({
          parts: Array.from({ length: 80 }, (_, i) => ({ qty: i + 1, partNumber: `P-${1000 + i}`, partName: "Track Shoe, Vehicular", partDescription: "D-001", pounds: 10 })),
          serialBlocks: [{ partNumber: "P-1000", serials: Array.from({ length: 20 }, (_, i) => ({ serial: `SN-${1000 + i}`, description: "Heat A1" })) }],
          freeform: "Shipped with the customer's own packing list, a freeform line long enough to wrap across the full content width of the page and then some more words.",
        });
        d.requirements[0] = { ...d.requirements[0], readings: Array.from({ length: 60 }, (_, i) => 28 + (i % 9) / 10) };
        return d;
      };
      const datasetB = (): CertPdfData => {
        const d = datasetA();
        d.statement = `STATEMENTSTART ${WORDS} ${WORDS} STATEMENTEND`;
        d.requirements[0] = { ...d.requirements[0], specification: `SPECSTART ${WORDS} SPECEND` };
        d.serialBlocks = [{ partNumber: "P-1000", serials: [{ serial: "SN-1", description: `SERIALSTART ${WORDS} SERIALEND` }] }];
        d.freeform = `FREEFORMSTART ${WORDS} ${WORDS} FREEFORMEND`;
        return d;
      };
      /** The standard layout, its page-bottom items lifted to the foot the page line leaves when it is on. */
      const standardFor = (pageFooter: boolean): CanvasLayout => !pageFooter ? layout : layoutOf(layout.items.map((item) =>
        item.kind !== "table" && item.anchor.kind === "page-bottom" ? { ...item, box: { ...item.box, y: pageFoot(true) - item.box.h } } : item));
      /** Every page's non-blank runs starting with `needle`, as [page, x]. */
      const startsOf = (pdf: Buffer, needle: string) => textRunsWithY(pdf).flatMap((runs, p) =>
        runs.filter((r) => r.text.trim().startsWith(needle)).map((r) => [p + 1, r.x] as const));

      it.each([
        { data: "A", pageFooter: false }, { data: "A", pageFooter: true },
        { data: "B", pageFooter: false }, { data: "B", pageFooter: true },
      ])("hands nothing after it a wider page: dataset $data, page line $pageFooter", async ({ data, pageFooter }) => {
        const d = data === "A" ? datasetA() : datasetB();
        const control = standardFor(pageFooter);
        const narrowed = reboxed(control, "parts", { x: 64, w: 484 });
        for (const l of [control, narrowed]) expect(canvasRefusal(l, CERT_CONTRACT, { pageFooter })).toBeNull();
        const full = await renderCert(d, certCfg(control, { pageFooter }));
        const inset = await renderCert(d, certCfg(narrowed, { pageFooter }));
        // Premise: the part lines break across a page in both.
        for (const r of [full, inset]) {
          expect(at(r.group, CANVAS_IDS.end("parts")).page).toBeGreaterThan(at(r.group, CANVAS_IDS.table("parts")).page);
        }
        // Nothing prints past the right margin.
        const pastRuns = textRunsWithY(inset.pdf).flatMap((runs, p) =>
          runs.filter((r) => r.text.trim() !== "" && r.x > 588).map((r) => `${p + 1}:${r.text.trim()}@${r.x.toFixed(1)}`));
        expect(pastRuns).toEqual([]);
        const pastStrokes = strokedLines(inset.pdf).flatMap((lines, p) =>
          lines.filter((s) => Math.max(s.x1, s.x2) > 588.5).map((s) => `${p + 1}:${Math.min(s.x1, s.x2).toFixed(1)}..${Math.max(s.x1, s.x2).toFixed(1)}`));
        expect(pastStrokes).toEqual([]);
        // The parts heading at the control's x + 40 on every page it prints.
        const quantity = startsOf(full.pdf, "Quantity");
        expect(quantity.length).toBeGreaterThan(1);
        const quantityIn = startsOf(inset.pdf, "Quantity");
        expect(quantityIn.map(([p]) => p)).toEqual(quantity.map(([p]) => p));
        quantityIn.forEach(([p, x], i) => expect(Math.abs(x - (quantity[i][1] + 40)), `page ${p}`).toBeLessThan(0.5));
        // Dataset B: the statement's wrapped last line starts where the full-width control's does (a
        // left-aligned first line does not move under the defect, so it proves nothing).
        if (data === "B") {
          const end = startsOf(full.pdf, "STATEMENTEND");
          expect(end).toHaveLength(1);
          const endIn = startsOf(inset.pdf, "STATEMENTEND");
          expect(endIn).toHaveLength(1);
          expect(endIn[0][0]).toBe(end[0][0]);
          expect(Math.abs(endIn[0][1] - end[0][1])).toBeLessThan(0.5);
        }
        // The freeform block ends where the control's does.
        const freeformEnd = at(full.group, CANVAS_IDS.end("freeform"));
        const freeformEndIn = at(inset.group, CANVAS_IDS.end("freeform"));
        expect(freeformEndIn.page).toBe(freeformEnd.page);
        expect(Math.abs(freeformEndIn.top - freeformEnd.top)).toBeLessThan(0.5);
        // The band's phone at the control's x on every page.
        const phone = startsOf(full.pdf, "Phone:");
        expect(phone.map(([p]) => p)).toEqual(Array.from({ length: pageCount(full.pdf) }, (_, i) => i + 1));
        const phoneIn = startsOf(inset.pdf, "Phone:");
        expect(phoneIn.map(([p]) => p)).toEqual(phone.map(([p]) => p));
        phoneIn.forEach(([p, x], i) => expect(Math.abs(x - phone[i][1]), `page ${p}`).toBeLessThan(0.5));
      });
    });
  });

  describe("the statement", () => {
    const wording = (statement: string) => sampleCert({ statement });

    it("prints the wording as one text node at 9.5 pt with its line breaks, no paragraph gap beyond the blank line, wrapped at the drawn width", async () => {
      const blank = await renderCert(wording("First line.\n\nThird line."), certCfg(layout));
      const full = await renderCert(wording("First line.\nSecond line.\nThird line."), certCfg(layout));
      const line = runTop(full.pdf, "Second") - runTop(full.pdf, "First");
      expect(line).toBeGreaterThan(9.5);
      expect(Math.abs(runTop(blank.pdf, "Third") - runTop(blank.pdf, "First") - 2 * line)).toBeLessThan(0.01);
      expect(runFonts(blank.pdf).filter((r) => r.text === "First" || r.text === "Third").map((r) => r.size)).toEqual([9.5, 9.5]);
      // One text node inside the block's wrapper.
      expect((blockItems(blank.def, "statement") as Record<string, unknown>[]).map((n) => n.text)).toEqual(["First line.\n\nThird line."]);
      // Wrapped at the drawn width: the long wording takes more lines 200 wide than 564.
      const linesIn = async (w: number) => {
        const r = await renderCert(sampleCert(), certCfg(reboxed(layout, "statement", { w })));
        const from = blockTop(r.group, layout, "statement").top;
        const to = at(r.group, CANVAS_IDS.end("statement")).top;
        return linesOn(r.pdf).filter((l) => l.top > from && l.top < to + 1);
      };
      const wide = await linesIn(564);
      const narrow = await linesIn(200);
      expect(narrow.length).toBeGreaterThan(wide.length);
    });

    it("its first line prints at the block's rendered top (the one-node rule), where a requirement's prints 4 pt under its own (the several-node rule)", async () => {
      const { pdf, group } = await renderCert(wording("First line."), certCfg(layout));
      const statement = runTop(pdf, "First") - blockTop(group, layout, "statement").top;
      const spec = runTop(pdf, "Were") - blockTop(group, layout, "requirements").top;
      // Both lines 9.5 pt, so their baselines sit equally under their tops: the difference is the
      // requirement's own 4 pt top margin, kept, and none of the statement's 2.
      expect(spec - statement).toBeCloseTo(4, 1);
    });

    it("typed after seeding, two more lines of wording move the requirements down by those lines", async () => {
      const one = await renderCert(wording("First line."), certCfg(layout));
      const three = await renderCert(wording("First line.\n\nThird line."), certCfg(layout));
      const full = await renderCert(wording("First line.\nSecond line.\nThird line."), certCfg(layout));
      const line = runTop(full.pdf, "Second") - runTop(full.pdf, "First");
      const shift = blockTop(three.group, layout, "requirements").top - blockTop(one.group, layout, "requirements").top;
      expect(Math.abs(shift - 2 * line)).toBeLessThan(0.5);
      expect(Math.abs(runTop(three.pdf, "Were") - runTop(one.pdf, "Were") - 2 * line)).toBeLessThan(0.5);
    });

    it("an empty statement lays out at the flow's empty statement node's height", async () => {
      // The flow is the oracle: the distance from the part lines' last rule to the specification line,
      // with the statement empty against one line, is what the empty node gives up.
      const lastRule = (pdf: Buffer) => {
        const spec = runTop(pdf, "Were");
        return Math.max(...strokedLines(pdf)[0].filter((s) => Math.abs(s.y1 - s.y2) < 0.01 && s.y1 < spec).map((s) => s.y1));
      };
      const flowGap = async (statement: string) => {
        const pdf = await renderPdf(buildCertDefinition(wording(statement)));
        return runTop(pdf, "Were") - lastRule(pdf);
      };
      const given = (await flowGap("One line.")) - (await flowGap(""));
      const height = async (statement: string) => {
        const r = await renderCert(wording(statement), certCfg(layout));
        return at(r.group, CANVAS_IDS.end("statement")).top - blockTop(r.group, layout, "statement").top;
      };
      const one = await height("One line.");
      expect(one).toBeGreaterThan(9.5);
      expect(Math.abs((await height("")) - (one - given))).toBeLessThan(0.01);
    });
  });

  describe("the requirements", () => {
    it("prints the specification line and the readings three to a line, as the flow prints them, from the block's drawn x", async () => {
      // Drawn 36 pt in from the flow's left (24), so every line of the block moves with it.
      const moved = reboxed(layout, "requirements", { x: 60, w: 528 });
      const { pdf } = await renderCert(sampleCert(), certCfg(moved));
      const readings = (lines: { text: string; top: number }[]) => lines.filter((l) => /^\d+\.\d+ \| /.test(l.text));
      const flowPdf = await renderPdf(buildCertDefinition(sampleCert()));
      const flow = readings(linesOn(flowPdf));
      const canvas = readings(linesOn(pdf));
      expect(canvas.map((l) => l.text)).toEqual(flow.map((l) => l.text));
      expect(canvas).toHaveLength(3);
      canvas.forEach((l, i) => expect(lineLeft(pdf, l.top), l.text).toBeCloseTo(lineLeft(flowPdf, flow[i].top) + 36, 2));
      expect(linesOn(pdf).map((l) => l.text)).toContain("Were heat treated as per P.O. NONE to HRC:");
      expect(runsOf(pdf, "Were")[0].x).toBeCloseTo(runsOf(flowPdf, "Were")[0].x + 36, 2);
    });

    it("on a two-part cert prints the bold part heading before each line group, 6 pt under the block's rendered top", async () => {
      const { pdf, group, def } = await renderCert(sampleCert({ ...secondPart() }), certCfg(layout));
      const lines = linesOn(pdf).map((l) => l.text);
      expect(lines).toEqual(expect.arrayContaining(["DEMO01-HT — Track Shoe, Vehicular", "DEMO02-HT — Bracket, Mounting"]));
      // pdfkit breaks a run at a hyphen, so the heading's first run is "DEMO02-".
      const headingRuns = runFonts(pdf).filter((r) => r.text === "DEMO02-" && r.size === 9.5);
      expect(headingRuns.length).toBeGreaterThan(0);
      for (const r of headingRuns) expect(isBold(r.font), "the heading's first run").toBe(true);
      // Against the statement's first line, also 9.5 pt at its block's top.
      const top = blockTop(group, layout, "requirements").top;
      // The part number also prints in the part lines above, so the heading's run is the one under the
      // block's top.
      const statement = runTop(pdf, "We") - blockTop(group, layout, "statement").top;
      const heading = runsOf(pdf, "DEMO01-").find((r) => r.top > top)!.top - top;
      expect(heading - statement).toBeCloseTo(6, 1);
      // The block's own id reports under its first child's own top margin: the heading's, never a
      // later child's (the requirement stacks after it keep their 4).
      expect(Math.abs(at(group, CANVAS_IDS.table("requirements")).top - top - ownOffset(def, "requirements"))).toBeLessThan(0.01);
    });

    it("a hidden specification-line row drops that line and keeps the readings", async () => {
      const { pdf } = await renderCert(sampleCert(), certCfg(rowHidden(layout, "requirements", "spec_line")));
      const lines = linesOn(pdf).map((l) => l.text);
      expect(lines.some((t) => t.startsWith("Were heat treated"))).toBe(false);
      expect(lines.filter((t) => /^\d+\.\d+ \| /.test(t))).toHaveLength(3);
    });
  });

  describe("the serials", () => {
    it("prints each part's list under the block's typed heading as the label root", async () => {
      const typed = withItem(layout, "table-serials", (item) => ({ ...item, heading: "Heat lots" } as CanvasItem));
      const { pdf } = await renderCert(sampleCert(), certCfg(typed));
      expect(linesOn(pdf).map((l) => l.text)).toEqual(expect.arrayContaining(["Heat lots — DEMO01-HT:", "SN-0001 — Heat A1"]));
    });

    it("with no serials prints nothing, and the block below sits at its drawn distance from the empty block", async () => {
      const { pdf, group } = await renderCert(sampleCert({ serialBlocks: [] }), certCfg(layout));
      expect(linesOn(pdf).some((l) => l.text.includes("Serial Numbers"))).toBe(false);
      expect(has(group, CANVAS_IDS.table("serials"))).toBe(false);
      // The empty block takes no height: its end where its region above ended.
      expect(at(group, CANVAS_IDS.end("serials")).top).toBeCloseTo(blockTop(group, layout, "serials").top, 2);
      expect(at(group, CANVAS_IDS.table("freeform")).top - at(group, CANVAS_IDS.end("serials")).top)
        .toBeCloseTo(drawnGap(layout, "freeform"), 2);
    });
  });

  describe("the freeform text", () => {
    it("prints one text node; empty, nothing", async () => {
      const { pdf, def } = await renderCert(sampleCert(), certCfg(layout));
      expect((blockItems(def, "freeform") as Record<string, unknown>[]).map((n) => n.text)).toEqual([sampleCert().freeform]);
      expect(linesOn(pdf).map((l) => l.text)).toContain(sampleCert().freeform);
      const empty = await renderCert(sampleCert({ freeform: "" }), certCfg(layout));
      expect(linesOn(empty.pdf).some((l) => l.text.includes("FREEFORM"))).toBe(false);
      expect(has(empty.group, CANVAS_IDS.table("freeform"))).toBe(false);
    });
  });

  describe("the signature", () => {
    /** The 10 pt lines under the typed 13 pt name (nothing else prints there at 10 pt), each as its
     *  first run, top to bottom. */
    const signerLines = (fonts: ReturnType<typeof runFonts>) => {
      const typed = Math.min(...fonts.filter((r) => r.size === 13).map((r) => r.y));
      const below = fonts.filter((r) => r.size === 10 && r.y < typed);
      return [...new Set(below.map((r) => r.y))].sort((a, b) => b - a)
        .map((y) => below.filter((r) => r.y === y).sort((a, b) => a.x - b.x)[0]);
    };
    const drawn = reboxed(layout, "signature", { x: 288, w: 300 });

    it("drawn at x 288, 300 wide: the signer's image at the flow's fit, centred over a rule the drawn width long", async () => {
      const { pdf } = await renderCert(sampleCert(), certCfg(drawn));
      const images = paintedImages(pdf)[0];
      expect(images).toHaveLength(1);
      // The 1x1 image fitted to 220 x 45 is 45 square.
      expect(images[0].h).toBeCloseTo(W.signatureFitHeight, 1);
      expect(images[0].x + images[0].w / 2).toBeCloseTo(288 + 150, 1);
      const rules = horizontals(pdf, 1).filter((h) => Math.abs(h.x - 288) < 0.5);
      expect(rules.map((r) => Math.round(r.length * 100) / 100)).toEqual([300]);
      // The rule rides the mark: under the image's bottom by the flow's distance.
      const flow = await renderPdf(buildCertDefinition(sampleCert()));
      const flowRule = horizontals(flow, 1).find((h) => Math.abs(h.length - W.signature) < 0.01)!;
      const flowImage = paintedImages(flow)[0][0];
      const flowGap = flowRule.y - (flowImage.y + flowImage.h);
      expect(flowGap).toBeGreaterThan(0);
      expect(rules[0].y - (images[0].y + images[0].h)).toBeCloseTo(flowGap, 2);
    });

    it("for a signer with no image prints the name at 13 pt centred; the name, title and company at 10 pt in from the block's x as the flow's are", async () => {
      const d = sampleCert({ signer: { ...sampleCert().signer, signatureDataUri: null, title: "QA Manager" } });
      const { pdf } = await renderCert(d, certCfg(drawn));
      expect(paintedImages(pdf)[0]).toHaveLength(0);
      const fonts = runFonts(pdf);
      const typed = fonts.filter((r) => r.size === 13);
      expect(typed.map((r) => r.text)).toEqual(["Alex", "Example"]);
      const width = await naturalWidth(d.signer.name, 13);
      expect(Math.abs(typed[0].x + width / 2 - (288 + 150))).toBeLessThan(1);
      // The rule rides the typed name: under its baseline by the flow's distance.
      const ruleUnder = (on: Buffer, x: number, w: number) =>
        horizontals(on, 1).find((h) => Math.abs(h.x - x) < 0.5 && Math.abs(h.length - w) < 0.01)!.y
        - (PAGE_HEIGHT - runFonts(on).find((r) => r.size === 13)!.y);
      const flowPdf = await renderPdf(buildCertDefinition(d));
      const flowUnder = ruleUnder(flowPdf, CANVAS_PAGE.width - CANVAS_PAGE.margin - W.signature, W.signature);
      expect(flowUnder).toBeGreaterThan(0);
      expect(ruleUnder(pdf, 288, 300)).toBeCloseTo(flowUnder, 2);
      // The flow's inset: its name line's x less its signature column's left.
      const flowFonts = runFonts(flowPdf);
      const inset = flowFonts.find((r) => r.text === "QA" && r.size === 10)!.x - (CANVAS_PAGE.width - CANVAS_PAGE.margin - W.signature);
      expect(inset).toBeGreaterThan(0);
      const lines = signerLines(fonts);
      expect(lines.map((r) => r.text)).toEqual(["Alex", "QA", "Example"]);
      for (const r of lines) expect(r.x).toBeCloseTo(288 + inset, 2);
      // No title, no title line.
      const untitled = runFonts((await renderCert(sampleCert({ signer: { ...d.signer, title: "" } }), certCfg(drawn))).pdf);
      expect(signerLines(untitled).map((r) => r.text)).toEqual(["Alex", "Example"]);
    });

    it("the signature mark hidden prints no image and no rule", async () => {
      const { pdf } = await renderCert(sampleCert(), certCfg(rowHidden(drawn, "signature", "signature_mark")));
      expect(paintedImages(pdf)[0]).toHaveLength(0);
      expect(horizontals(pdf, 1).filter((h) => Math.abs(h.x - 288) < 0.5)).toEqual([]);
      expect(linesOn(pdf).map((l) => l.text)).toContain(sampleCert().signer.name);
    });
  });

  describe("growth (design 2026-11-10 §11)", () => {
    const long = sampleCert({
      to: { ...sampleCert().to, attn: "Accounts Payable" },
      ...secondPart(Array.from({ length: 150 }, (_, i) => 30 + (i % 7) / 10)),
      serialBlocks: [{ partNumber: "DEMO01-HT", serials: Array.from({ length: 20 }, (_, i) => ({ serial: `SN-${1000 + i}`, description: "" })) }],
      freeform: "Shipped with the customer's own packing list.",
    });
    long.requirements[0] = { ...long.requirements[0], readings: Array.from({ length: 150 }, (_, i) => 28 + (i % 9) / 10) };

    /** The signature rule's y on its page (its drawn x and width), and that page. */
    function signatureRule(pdf: Buffer, page: number): number {
      const box = blockBox(layout, "signature");
      const found = horizontals(pdf, 1, page).filter((h) => Math.abs(h.x - box.x) < 0.5 && Math.abs(h.length - box.w) < 0.5);
      expect(found).toHaveLength(1);
      return found[0].y;
    }

    it("one layout over a one-page cert and a long one: everything rides the block above it", async () => {
      // The short cert: one part, no attn line, no serials, no freeform text (two empty blocks).
      const short = await renderCert(sampleCert({ serialBlocks: [], freeform: "" }), certCfg(layout));
      expect(has(short.group, CANVAS_IDS.table("serials"))).toBe(false);
      expect(has(short.group, CANVAS_IDS.table("freeform"))).toBe(false);
      const grown = await renderCert(long, certCfg(layout));
      expect(pageCount(grown.pdf)).toBeGreaterThanOrEqual(2);
      const ruleOffset = RULE().box.y;
      for (const r of [short, grown]) {
        const toEnd = at(r.group, CANVAS_IDS.end("to")).top;
        const rule = horizontals(r.pdf, 1.5).find((h) => Math.abs(h.length - RULE().box.w) < 0.01)!;
        expect(rule.y - toEnd).toBeCloseTo(ruleOffset, 1);
        expect(blockTop(r.group, layout, "parts").top - toEnd).toBeCloseTo(drawnGap(layout, "parts"), 2);
        for (const key of BLOCKS.slice(1)) {
          const prev = above(layout, key)!;
          const end = at(r.group, CANVAS_IDS.end(prev));
          const top = blockTop(r.group, layout, key);
          if (top.page !== end.page) continue;
          expect(top.top - end.top, key).toBeCloseTo(drawnGap(layout, key), 2);
          // The block's own id at that top (a several-node block's first child's margin under it),
          // where the block prints anything on that page.
          if (!has(r.group, CANVAS_IDS.table(key))) continue;
          const own = at(r.group, CANVAS_IDS.table(key));
          if (own.page !== top.page) continue;
          expect(Math.abs(own.top - top.top - ownOffset(r.def, key)), key).toBeLessThan(0.01);
        }
      }
      // The part lines' heading row and the signature's rule keep their places in their blocks.
      expect(runTop(grown.pdf, "Quantity") - blockTop(grown.group, layout, "parts").top)
        .toBeCloseTo(runTop(short.pdf, "Quantity") - blockTop(short.group, layout, "parts").top, 1);
      const freeformEnd = (r: typeof short) => at(r.group, CANVAS_IDS.end("freeform"));
      const sigTop = blockTop(grown.group, layout, "signature");
      expect(sigTop.page).toBe(freeformEnd(grown).page);
      // The signature follows the content to the last page (Review Focus 3).
      expect(sigTop.page).toBe(pageCount(grown.pdf));
      expect(signatureRule(grown.pdf, sigTop.page) - freeformEnd(grown).top)
        .toBeCloseTo(signatureRule(short.pdf, 1) - freeformEnd(short).top, 1);
      expect(signatureRule(short.pdf, 1) - freeformEnd(short).top).toBeGreaterThan(drawnGap(layout, "signature"));
    });

    it("§4.5's empty-block residual: no freeform text prints the signature its 6 pt top margin lower against the flow's, no serials nothing", async () => {
      // The signature rule's place on the canvas less its place on the flow print of the same cert:
      // the fixture's drawn distances are not the flow's margins, so the residual is that difference
      // against the full cert's.
      const flowX = CANVAS_PAGE.width - CANVAS_PAGE.margin - W.signature;
      const box = blockBox(layout, "signature");
      const ruleAt = (pdf: Buffer, x: number, w: number) =>
        horizontals(pdf, 1).find((h) => Math.abs(h.x - x) < 0.5 && Math.abs(h.length - w) < 0.01)!.y;
      const lower = async (d: CertPdfData) => {
        const canvas = (await renderCert(d, certCfg(layout))).pdf;
        return ruleAt(canvas, box.x, box.w) - ruleAt(await renderPdf(buildCertDefinition(d)), flowX, W.signature);
      };
      const full = await lower(sampleCert());
      // The freeform text's own top margin, read from the flow's node.
      const freeformTop = (nodesOf(buildCertDefinition(sampleCert())).find((n) => n.text === sampleCert().freeform)!.margin as number[])[1];
      expect(freeformTop).toBeGreaterThan(0);
      expect((await lower(sampleCert({ freeform: "" }))) - full).toBeCloseTo(freeformTop, 2);
      expect((await lower(sampleCert({ serialBlocks: [] }))) - full).toBeCloseTo(0, 2);
      expect((await lower(sampleCert({ serialBlocks: [], freeform: "" }))) - full).toBeCloseTo(freeformTop, 2);
    });

    it("a long cert pages: the strip on every page, the order number at its drawn place and (continued) on every page after the first", async () => {
      const { pdf } = await renderCert(long, certCfg(layout));
      const orderBox = layout.items.find((item) => item.id === "field-order_no")!.box;
      const pages = pageCount(pdf);
      expect(pages).toBeGreaterThanOrEqual(2);
      const d = sampleCert();
      for (let page = 1; page <= pages; page++) {
        const lines = linesOn(pdf, page).map((l) => l.text);
        expect(lines.some((t) => t.includes(`Phone: ${d.company.phone}`)), `page ${page}`).toBe(true);
        expect(lines.some((t) => t.includes("100 Example Way")), `page ${page}`).toBe(true);
        if (page === 1) continue;
        expect(lines.some((t) => t.includes(`Order No.: ${d.orderLabel}`)), `page ${page}`).toBe(true);
        // At the item's drawn place, where the flow's band prints it at the left margin.
        const order = runsOf(pdf, "Order", page);
        expect(order, `page ${page}`).toHaveLength(1);
        expect(order[0].x, `page ${page}`).toBeCloseTo(orderBox.x, 2);
        expect(order[0].top - orderBox.y, `page ${page}`).toBeGreaterThan(0);
        expect(order[0].top - orderBox.y, `page ${page}`).toBeLessThan(orderBox.h + 2);
        // "(continued)" shares the order number's baseline here, so it is read inside a line.
        expect(lines.some((t) => t.includes("(continued)")), `page ${page}`).toBe(true);
      }
    });

    it("with Page N of M on, page 2 prints its page line and no body line below the band", async () => {
      // The strip seeded with the page line on: its bottom at the foot the line leaves.
      const foot = pageFoot(true);
      const lifted = layoutOf(layout.items.map((item) => item.kind !== "table" && item.anchor.kind === "page-bottom"
        ? { ...item, box: { ...item.box, y: foot - item.box.h } } : item));
      const config = certCfg(lifted, { pageFooter: true });
      const { pdf } = await renderCert(long, config);
      const pages = pageCount(pdf);
      expect(pages).toBeGreaterThanOrEqual(2);
      const lines = linesOn(pdf, 2);
      const pageLine = lines.find((l) => l.text === `Page 2 of ${pages}`);
      expect(pageLine).toBeDefined();
      const band = bandTop(lifted, true);
      const strip = (t: string) => t.includes("Phone:") || t.includes("100 Example Way");
      const body = lines.filter((l) => l !== pageLine && !strip(l.text));
      expect(body.length).toBeGreaterThan(0);
      for (const l of body) expect(l.top, l.text).toBeLessThan(band);
      for (const l of lines.filter((l) => strip(l.text))) expect(l.top).toBeLessThan(pageLine!.top);
    });
  });
});

// #997 (owner ruling 2026-11-15): on every canvas document the sheet drops a trailing float region that
// holds no item that prints when nothing that prints follows it (`assembleCanvasSheet`). On the
// certification: a Logo item anchored below the signature block, the last block, drawn so its region
// does not fit under the block's rendered bottom. With no logo bytes it prints nothing, and the region,
// a spacer alone, moved whole to a blank page 2; with bytes it prints, and the region still moves whole.
describe("a drawn gap with nothing after it on a certification (#997)", () => {
  const d = sampleCert();
  const LOGO = `data:image/png;base64,${tinyAlphaPng().toString("base64")}`;

  /** The standard layout with a 40 pt Logo item below the signature block, its offset the grid step
   *  at or above the room left under the block's rendered bottom less 20, so the region (offset plus
   *  40) runs at least 20 pt past the band's top. */
  async function placed(): Promise<CanvasLayout> {
    const layout = standardCertLayout();
    const base = await renderCert(d, certCfg(layout));
    const end = base.group.positions.find((node) => node.id === CANVAS_IDS.end("signature"))!;
    expect(end.page, "the base ends on page 1").toBe(1);
    const room = bandTop(layout, false) - end.top;
    const y = Math.ceil((room - 20) / CANVAS_GRID) * CANVAS_GRID;
    const next = layoutOf([...layout.items, logo({ anchor: { kind: "below-table", table: "signature" }, box: { x: 24, y, w: 80, h: 40 } })]);
    expect(y + 40, "the region does not fit under the block").toBeGreaterThan(room);
    // A layout the owner can save.
    expect(canvasRefusal(next, CERT_CONTRACT, { pageFooter: false })).toBeNull();
    return next;
  }

  // Red before #997 (two pages) and with the sheet's drop removed.
  it("a Logo item with no logo bytes below the last block prints no blank last page", async () => {
    const layout = await placed();
    const { pdf, group } = await renderCert(d, certCfg(layout));
    expect(pageCount(pdf), "no blank last page").toBe(1);
    const end = group.positions.find((node) => node.id === CANVAS_IDS.end("signature"))!;
    const regionEnd = group.positions.find((node) => node.id === CANVAS_IDS.regionEnd("signature"))!;
    expect([regionEnd.page, regionEnd.top]).toEqual([end.page, end.top]);
  });

  // Red with the drop judged without the region's own items: the printing logo's region is then dropped.
  it("the same Logo item with logo bytes prints, so its region is kept and moves whole to page 2", async () => {
    const layout = await placed();
    const { pdf } = await renderCert(d, certCfg(layout), LOGO);
    expect(pageCount(pdf)).toBe(2);
    expect(paintedImageCounts(pdf)[1], "the logo painted on page 2").toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------
// Task 4: the print path (design 2026-11-10 §5.1, §7, §11). `printCert` prints a canvas template's
// layout through the same `readCertPdfData`, its one change the logo line (`templatePlacesLogo`), and
// the ticket bundle's certs print through `printCert` with no change of their own.
// ------------------------------------------------------------------------------------------------

describe("printCert with a canvas template", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  const asSystem = <T>(fn: () => Promise<T>) =>
    runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

  let seq = 0;
  async function makeCustomer(): Promise<Customer> {
    seq += 1;
    const customer = await prisma.customer.create({ data: { code: `CCV${seq}`, name: `Cert Canvas Customer ${seq}` } });
    await prisma.customerAddress.create({
      data: {
        customerId: customer.id, kind: "BILL_TO", name: "Accounts payable", street: "300 Example Way",
        city: "Anniston", state: "AL", zip: "36201", isDefault: true,
      },
    });
    return customer;
  }

  /** A part with a material and one inspection requirement, the cert suites' shape. */
  async function makeInspectedPart(customerId: string, scope?: "SHIPMENT") {
    seq += 1;
    const material = await prisma.material.create({ data: { name: `steel ${seq}` } });
    const scale = await prisma.inspectionScale.create({ data: { name: `HRC${seq}` } });
    const code = await prisma.inspectionCode.create({
      data: { name: `Were heat treated as per P.O. NONE (${seq})`, defaultScaleId: scale.id },
    });
    const part = await prisma.part.create({
      data: {
        customerId, partNumber: `CANVAS-HT-${seq}`, name: `Track Shoe ${seq}`, description: "D-001",
        eachWeight: "21.5000", materialId: material.id,
        ...(scope !== undefined ? { certRequired: true, certScope: scope } : {}),
      },
    });
    await prisma.partInspection.create({
      data: {
        partId: part.id, inspectionCodeId: code.id, scaleId: scale.id,
        min: "28.0000", max: "32.0000", sampleQty: "9", location: "flange OD", sort: 1,
      },
    });
    const stepCode = await prisma.processStepCode.create({ data: { code: `CCV-${seq}`, name: "Austenitize" } });
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    await prisma.partProcessStep.create({
      data: { revisionId: rev.id, position: 1, codeId: stepCode.id, instruction: "Austenitize at 1650F." },
    });
    return part;
  }

  /** A signer with no signature image, so the one image a print paints is the logo. */
  async function makeSigner() {
    seq += 1;
    return prisma.user.create({ data: { username: `canvas-quality${seq}`, displayName: "Quality Signer", passwordHash: "x" } });
  }

  /** The standard layout plus a Logo item page-top at the left margin, clear of the centred company
   *  name and title (x 132) and above the To block (y 72); published with `config.logo` null (so the
   *  flow's logo slot places nothing), its version carrying a logo, and assigned to the customer. */
  async function publishCanvas(customer: Customer) {
    const layout = layoutOf([...standardCertLayout().items, logo({ box: { x: 24, y: 24, w: 44, h: 44 } })]);
    expect(canvasRefusal(layout, CERT_CONTRACT, { pageFooter: CERT_DEFAULT_CONFIG.pageFooter })).toBeNull();
    const t = await asSystem(() => createTemplate("CERT", `Canvas cert ${seq}`));
    const config: TemplateConfig = { ...structuredClone(CERT_DEFAULT_CONFIG), logo: null, layout };
    await asSystem(() => editDraft(t.id, { config, updatedAt: t.draft.updatedAt }));
    await asSystem(() => uploadLogo(t.id, tinyAlphaPng(), "image/png"));
    const { versionId } = await asSystem(() => publishDraft(t.id));
    await asSystem(() => assignTemplate(customer.id, "CERT", t.id));
    return versionId;
  }

  const stored = (id: string) => prisma.storedDocument.findUniqueOrThrow({ where: { id } });
  /** The CERT Standard's published version: what a cert of a customer with nothing assigned prints. */
  const standardCertVersionId = async () => (await prisma.documentTemplate.findFirstOrThrow({
    where: { docType: "CERT", isDefault: true, deletedAt: null },
  })).publishedVersionId;

  /**
   * A long certification (design 2026-11-10 §5.4): line 1 a part carrying ten inspection requirements,
   * the other `size.lines - 1` lines one plain part, `size.serials` serials spread across the lines in
   * turn, an ORDER-scope cert with `size.readings` readings on each of its ten requirements, and
   * freeform text. Readings are written one requirement a call, before any print.
   */
  async function bigCert(customer: Customer, size: { lines: number; readings: number; serials: number }) {
    seq += 1;
    const material = await prisma.material.create({ data: { name: `timing steel ${seq}` } });
    const step = async (partId: string) => {
      const stepCode = await prisma.processStepCode.create({ data: { code: `CCT-${partId}`, name: "Austenitize" } });
      const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
      await prisma.partProcessStep.create({
        data: { revisionId: rev.id, position: 1, codeId: stepCode.id, instruction: "Austenitize at 1650F." },
      });
    };
    const inspected = await prisma.part.create({
      data: {
        customerId: customer.id, partNumber: `TIMING-HT-${seq}`, name: `Track Shoe ${seq}`, description: "D-001",
        eachWeight: "21.5000", materialId: material.id,
      },
    });
    for (let i = 1; i <= 10; i++) {
      const scale = await prisma.inspectionScale.create({ data: { name: `HRC${seq}-${i}` } });
      const code = await prisma.inspectionCode.create({
        data: { name: `Were heat treated as per P.O. NONE (${seq}-${i})`, defaultScaleId: scale.id },
      });
      await prisma.partInspection.create({
        data: {
          partId: inspected.id, inspectionCodeId: code.id, scaleId: scale.id,
          min: "28.0000", max: "32.0000", sampleQty: "9", location: "flange OD", sort: i,
        },
      });
    }
    await step(inspected.id);
    const plain = await prisma.part.create({
      data: {
        customerId: customer.id, partNumber: `TIMING-PL-${seq}`, name: `Plain Pin ${seq}`, description: "D-002",
        eachWeight: "1.2500", materialId: material.id,
      },
    });
    await step(plain.id);
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: `TIMING-PO-${seq}`,
      lines: Array.from({ length: size.lines }, (_, i) => (i === 0
        ? { partId: inspected.id, qty: 192, weight: "4128.00" }
        : { partId: plain.id, qty: 40, weight: "50.00" })),
    }));
    expect(order.lines).toHaveLength(size.lines);
    // Serials dealt across the lines in turn; a serial's position counts within its line.
    const perLine = new Map<string, number>();
    await prisma.orderSerial.createMany({
      data: Array.from({ length: size.serials }, (_, i) => {
        const lineId = order.lines[i % size.lines].id;
        const position = (perLine.get(lineId) ?? 0) + 1;
        perLine.set(lineId, position);
        return { orderId: order.id, lineId, position, serial: `T${seq}-SN-${i + 1}`, description: `Heat ${i + 1}` };
      }),
    });
    const cert = await asSystem(() => createCert({ orderId: order.id, scope: "ORDER" }));
    expect(cert.requirements).toHaveLength(10);
    for (const requirement of cert.requirements) {
      await asSystem(() => replaceReadings(cert.id, {
        requirements: [{
          id: requirement.id,
          readings: Array.from({ length: size.readings }, (_, i) => ({ value: (28 + (i % 40) / 10).toFixed(1) })),
        }],
      }, { afterPrint: false }));
    }
    await asSystem(() => updateCert(cert.id, { freeform: "Freeform words run on. ".repeat(130).slice(0, 3000) }));
    return cert;
  }

  // The print's budget (design 2026-11-10 §5.4; cert canvas PR 2, Task 7). Run on purpose, on mains at
  // the Performance profile with both runner slots paused:
  // CANVAS_TIMING=1 npx vitest run tests/cert-canvas.test.ts -t "CANVAS timing" --reporter=verbose --silent=false
  // No time is asserted: every figure is logged, as it lands, for the controller to read against 2.5 s.
  it.skipIf(process.env.CANVAS_TIMING !== "1")("CANVAS timing: a certification canvas print through printCert", async () => {
    const signer = await prisma.user.create({
      data: {
        username: "canvas-timing-signer", displayName: "Quality Signer", title: "Quality Manager", passwordHash: "x",
        signatureImage: new Uint8Array(alphaPng(120, 40)), signatureMimeType: "image/png",
      },
    });
    const sizes = [{ lines: 50, readings: 100, serials: 200 }, { lines: 100, readings: 200, serials: 400 }];
    for (const size of sizes) {
      const name = `${size.lines} lines, 10 x ${size.readings} readings, ${size.serials} serials`;
      // A customer per size, so cert A prints under the flow Standard (nothing assigned to it yet).
      const customer = await makeCustomer();
      const certA = await bigCert(customer, size);
      const certB = await bigCert(customer, size);

      /** One `printCert`, timed around the whole call and logged as it lands; a throw logs its time. */
      const timed = async (label: string, certId: string) => {
        const started = performance.now();
        try {
          const result = await asSystem(() => printCert(certId, signer.id));
          const ms = Math.round(performance.now() - started);
          console.log(`CANVAS timing: ${name}; ${label} ${pageCount(result.pdf)} page(s) in ${ms} ms`);
          return result;
        } catch (error) {
          console.log(`CANVAS timing: ${name}; ${label} threw after ${Math.round(performance.now() - started)} ms`);
          throw error;
        }
      };

      const flow = await timed("flow first print", certA.id);
      const flowReprint = await timed("flow reprint", certA.id);

      const layout = await asSystem(() => seedCertLayout(certA.id, structuredClone(CERT_DEFAULT_CONFIG), undefined, signer.id));
      const t = await asSystem(() => createTemplate("CERT", `Canvas timing cert ${size.lines}`));
      const config = validateConfig("CERT", { ...structuredClone(CERT_DEFAULT_CONFIG), layout });
      await asSystem(() => editDraft(t.id, { config, updatedAt: t.draft.updatedAt }));
      const { versionId } = await asSystem(() => publishDraft(t.id));
      await asSystem(() => assignTemplate(customer.id, "CERT", t.id));

      const first = await timed("canvas first print", certB.id);
      const reprint = await timed("canvas reprint", certB.id);

      // The canvas template printed cert B both times, the flow Standard cert A both times.
      const standard = await standardCertVersionId();
      expect(standard).not.toBe(versionId);
      for (const { documentId } of [first, reprint]) expect((await stored(documentId)).templateVersionId).toBe(versionId);
      for (const { documentId } of [flow, flowReprint]) expect((await stored(documentId)).templateVersionId).toBe(standard);
    }
  }, 600_000);

  it("prints the canvas with its Logo item painted (config.logo null), stamps the version, and stamps printedAt on the first print only", async () => {
    const customer = await makeCustomer();
    const versionId = await publishCanvas(customer);
    const part = await makeInspectedPart(customer.id);
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: "DEMO-PO-24115", lines: [{ partId: part.id, qty: 192, weight: "4128.00" }],
    }));
    const cert = await asSystem(() => createCert({ orderId: order.id, scope: "ORDER" }));
    const signer = await makeSigner();

    expect((await prisma.cert.findUniqueOrThrow({ where: { id: cert.id } })).printedAt).toBeNull();
    const first = await asSystem(() => printCert(cert.id, signer.id));
    const stamped = (await prisma.cert.findUniqueOrThrow({ where: { id: cert.id } })).printedAt;
    expect(stamped).not.toBeNull();
    const reprint = await asSystem(() => printCert(cert.id, signer.id));
    expect((await prisma.cert.findUniqueOrThrow({ where: { id: cert.id } })).printedAt!.getTime()).toBe(stamped!.getTime());
    expect(reprint.documentId).not.toBe(first.documentId);

    for (const { documentId } of [first, reprint]) {
      const doc = await stored(documentId);
      expect(doc.templateVersionId).toBe(versionId);
      const bytes = Buffer.from(doc.fileData);
      expect(pageCount(bytes)).toBe(1);
      // One image: the canvas's Logo item (the flow, with `config.logo` null, paints none).
      expect(paintedImageCounts(bytes)).toEqual([1]);
      expect(drawnText(bytes)).toContain(String(order.orderNumber));
    }
  });

  it("pin: frozen paper: a part renamed after the cert was raised prints its frozen heading under the canvas, as under the flow", async () => {
    const customer = await makeCustomer();
    const lead = await makeInspectedPart(customer.id);
    const rider = await makeInspectedPart(customer.id);
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: "DEMO-PO-24115",
      lines: [{ partId: lead.id, qty: 10, weight: "215.00" }, { partId: rider.id, qty: 5, weight: "107.50" }],
    }));
    const cert = await asSystem(() => createCert({ orderId: order.id, scope: "ORDER" }));
    await prisma.part.update({ where: { id: lead.id }, data: { partNumber: "RENAMED-77", name: "Renamed Part" } });
    const signer = await makeSigner();
    const heading = `${lead.partNumber} — ${lead.name}`;

    // The flow first (nothing assigned: the seeded Standard), then the canvas on the same cert.
    const flow = await asSystem(() => printCert(cert.id, signer.id));
    const versionId = await publishCanvas(customer);
    const canvas = await asSystem(() => printCert(cert.id, signer.id));
    expect((await stored(canvas.documentId)).templateVersionId).toBe(versionId);
    expect((await stored(flow.documentId)).templateVersionId).toBe(await standardCertVersionId());

    for (const { documentId } of [flow, canvas]) {
      const text = drawnText(Buffer.from((await stored(documentId)).fileData));
      expect(text).toContain(heading);
      expect(text).toContain(`${rider.partNumber} — ${rider.name}`);
      expect(text).not.toContain("RENAMED-77");
      expect(text).not.toContain("Renamed Part");
    }
  });

  it("the ticket bundle (cert=1) prints a shipment cert under the customer's canvas template, painting its logo", async () => {
    const customer = await makeCustomer();
    const versionId = await publishCanvas(customer);
    const shipTo = await prisma.customerAddress.create({
      data: {
        customerId: customer.id, kind: "SHIP_TO", name: "Demo Components Corporation", street: "300 Example Way",
        city: "Anniston", state: "AL", zip: "36201", isDefault: true,
      },
    });
    const part = await makeInspectedPart(customer.id, "SHIPMENT");
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: "DEMO-PO-24115", lines: [{ partId: part.id, qty: 192, weight: "4128.00" }],
    }));
    const { shipper } = await asSystem(() => createShipper({
      customerId: customer.id, shipDate: "2026-07-29", shipToAddressId: shipTo.id,
      orders: [{
        orderId: order.id,
        lines: [{ orderLineId: order.lines[0].id, qty: 192, weight: "4128.00", lineComplete: true }],
        containers: [], serials: [],
      }],
    }, { canOverrideCreditHold: false }));
    // The session's user (the signer here) has no signature image, so the cert's one image is the logo.
    const cookie = await signInWith(["shipping.view", "certs.view"]);
    const res = await shipperPrintRoute(
      new Request(`http://t/api/shippers/${shipper.id}/print?doc=ticket&cert=1`, { method: "POST", headers: { cookie } }),
      { params: Promise.resolve({ id: shipper.id }) });
    expect(res.status).toBe(200);
    // A cert print that failed still answers 200 with a warning: the header names the stored cert.
    const ids = res.headers.get("x-cert-document-ids");
    expect(ids).not.toBeNull();
    expect(ids!.split(",")).toHaveLength(1);
    const cert = await prisma.cert.findFirstOrThrow({ where: { orderId: order.id, scope: "SHIPMENT", deletedAt: null } });
    const doc = await stored(ids!);
    expect(doc.certId).toBe(cert.id);
    expect(doc.templateVersionId).toBe(versionId);
    expect(paintedImageCounts(Buffer.from(doc.fileData))).toEqual([1]);
  });
});
