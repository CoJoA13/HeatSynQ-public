import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import {
  STATEMENT_PAGE, STATEMENT_SEED_IDS, STATEMENT_WIDTHS, buildStatementDefinition, statementSeedStyle, type StatementData, type StatementOpenItem,
} from "@/server/pdf/statement";
import { renderPdf, renderSheetGroupsWithPositions, type LaidOutNode } from "@/server/pdf/render";
import { CANVAS_IDS, defaultLabelOf } from "@/server/pdf/canvas-sheet";
import { pngDataUri } from "@/server/pdf/render";
import {
  FIT_CLEARANCE, STATEMENT_STAND_IN, seedStatementItems, seedStatementLayout, statementStandIn, withRepeat,
} from "@/server/statement-canvas-seed";
import { invoicePrintSettings, type InvoicePrintSettings } from "@/server/invoices";
import { setSetting } from "@/server/settings";
import { HttpError } from "@/server/errors";
import {
  bandTop, canvasWarnings, drawnBox, leastWidth, pageFoot, regionHeights, tablesByY, topMargin, validateCanvasLayout, type CanvasMeasure,
} from "@/lib/template-canvas";
import { dragStart, stageBox } from "@/lib/canvas-designer";
import { buildStatement } from "@/server/statements";
import { renderStatementCanvasPreview } from "@/server/template-preview";
import { STATEMENT_CONTRACT, STATEMENT_ROW_FLOOR } from "@/lib/template-contracts/statement";
import { FONT_FAMILIES, STATEMENT_DEFAULT_CONFIG, type TemplateConfig } from "@/lib/template-contracts/index";
import {
  CANVAS_GRID, CANVAS_PAGE, CONTINUED_FONT_SIZE, type CanvasItem, type CanvasLayout,
} from "@/lib/template-contracts/canvas";
import { DEFAULT_LOGO_WIDTH } from "@/lib/template-editor";
import { formatDateOnly, todayDateOnly } from "@/lib/business-days";
import { alphaPng, pageCount, paintedImages, runFonts, strokedLines, textRunsWithY, tinyAlphaPng, type StrokedLine } from "./helpers/pdf";
import { richStatement } from "./helpers/statement-canvas-fixtures";
import { namedWarnings } from "./helpers/named-warnings";
import { bulkOpenItems, daysBack, finalizedInvoice, makeCustomer } from "./helpers/statement-print-fixtures";

/**
 * The statement's canvas SEED (design 2026-11-11 §5.3; since statement canvas PR 2):
 * `seedStatementLayout` lays the submitted flow config out once for a stand-in statement and answers
 * a `CanvasLayout`. Its acceptance is the golden case, which prints one statement under the flow
 * config and under that config carrying the seeded layout and compares the two papers
 * (`expectSameStatement`). The cases were written while STATEMENT stood outside CANVAS_PRINTS (the same PR
 * later put it in; the route's own cases are tests/template-canvas-seed.test.ts's), so they call
 * `seedStatementLayout` directly, judge its answer with `validateCanvasLayout`, and print both papers
 * in memory through `renderPdf`, the canvas's config built as `{ ...config, layout }` rather than
 * through `validateConfig`. The picked record is a real customer (the seed reads it
 * only to refuse a missing one); the paper compared is `richStatement`'s, its company and Remit To
 * the settings' (`invoicePrintSettings`), so the seed and the print read one Remit To box.
 */

beforeEach(async () => {
  await truncateAll();
  await setCompany(TWO_LINES);
});

const PAGE_HEIGHT = CANVAS_PAGE.height;
const SW = STATEMENT_WIDTHS;
const MARGIN = CANVAS_PAGE.margin;
const COMPANY = "Example Heat Treating - Alabama, LLC";
const TWO_LINES = "100 Example Way\nAnniston AL 36207";
const THREE_LINES = "Building 4\n100 Example Way\nAnniston AL 36207";
const BLOCKS = ["bill_to", "open_items", "aging", "finance_charge", "total"];
/** The identity's left column's width beside the Remit To box (262), and with it hidden (524). */
const LINE_WIDTH = SW.content - SW.identityIndent - SW.remitTo - SW.identityGap;
const LINE_WIDTH_ALONE = SW.content - SW.identityIndent;

async function setCompany(address: string) {
  await setSetting("company_name", COMPANY);
  await setSetting("company_address", address);
  await setSetting("company_phone", "256-555-0100");
}

const cfg = (): TemplateConfig => structuredClone(STATEMENT_DEFAULT_CONFIG);
const section = (c: TemplateConfig, key: string) => c.sections.find((s) => s.key === key)!;
const fieldOf = (c: TemplateConfig, sectionKey: string, key: string) => section(c, sectionKey).fields.find((f) => f.key === key)!;
/** Moves section `key` to just before section `before`. */
function moveSectionBefore(c: TemplateConfig, key: string, before: string): void {
  const [moved] = c.sections.splice(c.sections.findIndex((s) => s.key === key), 1);
  c.sections.splice(c.sections.findIndex((s) => s.key === before), 0, moved);
}
/** Orders the identity's left column `order`, the Remit To after it. */
function leftOrder(c: TemplateConfig, order: string[]): void {
  const identity = section(c, "identity");
  const byKey = new Map(identity.fields.map((f) => [f.key, f]));
  identity.fields = [...order.map((k) => byKey.get(k)!), byKey.get("remit_to")!];
}

let customerId = "";
beforeEach(async () => {
  customerId = (await makeCustomer()).id;
});

/** The seed for the picked customer, its answer judged by the canvas rules first. */
async function seed(config: TemplateConfig, logo?: string): Promise<CanvasLayout> {
  const layout = await seedStatementLayout(customerId, config, logo);
  validateCanvasLayout(layout, STATEMENT_CONTRACT, { pageFooter: config.pageFooter });
  return layout;
}

/** `richStatement` with the settings' company and Remit To (`overrides` replace whole keys after). */
async function rich(overrides: Partial<StatementData> = {}): Promise<StatementData> {
  const s = await invoicePrintSettings();
  return richStatement({ company: s.company, remitTo: s.remitTo, ...overrides });
}

/** The flow's and the canvas's papers for `data` under `config`, in memory. */
async function papers(data: StatementData, config: TemplateConfig, layout: CanvasLayout, logo?: string) {
  validateCanvasLayout(layout, STATEMENT_CONTRACT, { pageFooter: config.pageFooter });
  const flow = await renderPdf(buildStatementDefinition(data, config, logo));
  const canvas = await renderPdf(buildStatementDefinition(data, { ...config, layout }, logo));
  return { flow, canvas };
}

type Run = { text: string; x: number; y: number; font: string; size: number };
/** Each page's text runs, with the font and size of page 1's (`runFonts` reads page 1 alone). */
function styledRuns(pdf: Buffer): Run[][] {
  const fonts = runFonts(pdf);
  return textRunsWithY(pdf).map((runs, page) =>
    runs.map((r, i) => ({ ...r, font: page === 0 ? fonts[i].font : "", size: page === 0 ? fonts[i].size : 0 })));
}
/** A page's runs grouped into printed lines top to bottom: a run joins the line above it where its
 *  RAW baseline is within 0.3 pt of that line's first run's (pdfkit writes each word of a line at
 *  one baseline), each line's runs left to right, white space alone set aside. The grouping reads the
 *  text alone; every position compared is a run's own raw figure. */
function linesOf(runs: Run[]): { text: string; runs: Run[] }[] {
  const lines: Run[][] = [];
  for (const run of [...runs].filter((r) => r.text.trim() !== "").sort((a, b) => b.y - a.y || a.x - b.x)) {
    const line = lines[lines.length - 1];
    if (line !== undefined && Math.abs(line[0].y - run.y) <= 0.3) line.push(run);
    else lines.push([run]);
  }
  return lines.map((line) => {
    const sorted = line.sort((a, b) => a.x - b.x);
    return { text: sorted.map((r) => r.text).join(" ").replace(/\s+/g, " ").trim(), runs: sorted };
  });
}

/** Distinct strokes, merged: pdfmake draws a rule as one segment per cell or per row, an item as
 *  one; touching collinear segments of one width read as one (tests/template-canvas-seed.test.ts's
 *  `inkOf`). */
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

/**
 * The flow's and the canvas's statements compared (design §5.3's acceptance, at the Global
 * Constraints' 0.5 pt, since a 2 pt tolerance cannot see the finance line's 2 pt):
 *  - the same pages, and on each the same printed lines (runs grouped by baseline into lines, top to
 *    bottom; `linesOf`), the same text in the same order;
 *  - each run's RAW baseline (`textRunsWithY`, never a grouping key) within 0.5 pt of the flow's, and
 *    its start x within 0.5 pt;
 *  - on page 1, each run's font and size equal (`runFonts`), so a seeded item prints the flow's type;
 *  - the same painted images on each page, each box within 1 pt (`paintedImages`);
 *  - the same merged strokes on each page, each end within 0.5 pt (the Remit To box, the open items'
 *    and the aging's rules).
 */
function expectSameStatement(flow: Buffer, canvas: Buffer) {
  expect(pageCount(canvas), "the canvas's pages").toBe(pageCount(flow));
  const flowRuns = styledRuns(flow);
  const canvasRuns = styledRuns(canvas);
  flowRuns.forEach((runs, page) => {
    const lines = linesOf(runs);
    const canvasLines = linesOf(canvasRuns[page]);
    expect(canvasLines.map((l) => l.text), `page ${page + 1}'s lines`).toEqual(lines.map((l) => l.text));
    lines.forEach((line, i) => {
      const other = canvasLines[i];
      expect(other.runs.length, `page ${page + 1}, "${line.text}"'s runs`).toBe(line.runs.length);
      line.runs.forEach((run, j) => {
        const c = other.runs[j];
        const where = `page ${page + 1}, "${line.text}", run "${run.text}"`;
        expect(Math.abs(c.y - run.y), `${where}'s baseline ${run.y} (canvas ${c.y})`).toBeLessThanOrEqual(0.5);
        expect(Math.abs(c.x - run.x), `${where}'s x ${run.x} (canvas ${c.x})`).toBeLessThanOrEqual(0.5);
        expect(`${c.font} ${c.size}`, `${where}'s font and size`).toBe(`${run.font} ${run.size}`);
      });
    });
  });
  const flowImages = paintedImages(flow);
  const canvasImages = paintedImages(canvas);
  flowImages.forEach((images, page) => {
    expect(canvasImages[page].length, `page ${page + 1}'s images`).toBe(images.length);
    images.forEach((image, i) => {
      for (const k of ["x", "y", "w", "h"] as const) {
        expect(Math.abs(canvasImages[page][i][k] - image[k]), `page ${page + 1}, image ${i + 1}'s ${k}`).toBeLessThanOrEqual(1);
      }
    });
  });
  const flowInk = strokedLines(flow).map(inkOf);
  const canvasInk = strokedLines(canvas).map(inkOf);
  flowInk.forEach((strokes, page) => {
    const left = [...canvasInk[page]];
    const missing: Ink[] = [];
    for (const s of strokes) {
      const i = left.findIndex((c) => c.axis === s.axis && Math.abs(c.width - s.width) < 0.01
        && Math.abs(c.at - s.at) <= 0.5 && Math.abs(c.from - s.from) <= 0.5 && Math.abs(c.to - s.to) <= 0.5);
      if (i === -1) missing.push(s);
      else left.splice(i, 1);
    }
    expect({ page: page + 1, missing, extra: left }).toEqual({ page: page + 1, missing: [], extra: [] });
  });
}

/** `papers`, the flow's paper on ONE page first (a paging canvas prints page 1 16 pt higher than its
 *  flow, design §4.4), then compared. */
async function golden(data: StatementData, config: TemplateConfig, layout: CanvasLayout, logo?: string) {
  const p = await papers(data, config, layout, logo);
  expect(pageCount(p.flow), "the flow prints one page").toBe(1);
  expectSameStatement(p.flow, p.canvas);
  return p;
}

/** The seed's own layout pass of the stand-in (`statementStandIn` at today's date, the settings'
 *  company): the seed ids' positions. */
async function laid(config: TemplateConfig, logo?: string, standIn?: (d: StatementData) => StatementData) {
  const base = statementStandIn(await invoicePrintSettings(), customerId, formatDateOnly(todayDateOnly()));
  const { groups } = await renderSheetGroupsWithPositions([
    buildStatementDefinition(standIn ? standIn(base) : base, config, logo, { seedIds: true }),
  ]);
  const at = (id: string): LaidOutNode => {
    const node = groups[0].positions.find((n) => n.id === id);
    if (node === undefined) throw new Error(`no laid-out node "${id}"`);
    return node;
  };
  return {
    pages: groups[0].pages,
    positions: groups[0].positions,
    at,
    top: (id: string) => at(id).top,
    has: (id: string) => groups[0].positions.some((n) => n.id === id),
  };
}

const fields = (layout: CanvasLayout) => layout.items.filter((i): i is Extract<CanvasItem, { kind: "field" }> => i.kind === "field");
const fieldItem = (layout: CanvasLayout, key: string) => fields(layout).find((i) => i.key === key);
const block = (layout: CanvasLayout, key: string) => {
  const found = layout.items.find((i): i is Extract<CanvasItem, { kind: "table" }> => i.kind === "table" && i.key === key);
  if (found === undefined) throw new Error(`no ${key} block`);
  return found;
};
const hasBlock = (layout: CanvasLayout, key: string) => layout.items.some((i) => i.kind === "table" && i.key === key);
/** The layout's items with their ids blanked, for comparing two seeds by content. */
const byContent = (layout: CanvasLayout) => layout.items.map((item) => ({ ...item, id: "" }));
/** A page's printed lines (`linesOf`), each with its topmost run's RAW baseline from the page's top. */
function rawLines(pdf: Buffer, page: number): { text: string; top: number }[] {
  return linesOf(textRunsWithY(pdf)[page].map((r) => ({ ...r, font: "", size: 0 })))
    .map((l) => ({ text: l.text, top: PAGE_HEIGHT - Math.max(...l.runs.map((r) => r.y)) }));
}
const lineTop = (pdf: Buffer, page: number, starts: string) => {
  const line = rawLines(pdf, page).find((l) => l.text.startsWith(starts));
  if (line === undefined) throw new Error(`no line starting "${starts}" on page ${page + 1}`);
  return line.top;
};
/** The open items' heading row, as the Standard labels it. */
const HEADING_ROW = "Document #";

/** `n` open items, every amount and number its own. */
function manyItems(n: number): StatementOpenItem[] {
  return Array.from({ length: n }, (_, i) => ({
    documentNumber: `7 - ${93000 + i}`, date: "2026-07-10", dueDate: "2026-08-09", kind: "INVOICE" as const,
    original: 1000 + i, open: 500 + i,
  }));
}

/**
 * Page 2 of a 300-item statement, the canvas's when `layout` is set and the flow's when null, read off
 * the paper: `top` is page 2's top, its first body line's (the open items' repeated heading row) raw
 * baseline less that row's baseline under the open items' rendered top on page 1 (the canvas's
 * `regionEnd` mark of the Bill To; the flow's `seed:start:open_items` mark, its layout unchanged by
 * the marks); `lines` counts page 2's body lines from that row, the page line left out; `pitch` is
 * their baseline pitch; `limit` is the page's bottom limit from the definition's bottom margin, and
 * `overflowTop` the flow definition's continuation top margin. Each render builds its own
 * definition: pdfmake uses up a laid-out node, so a definition rendered twice prints otherwise.
 */
async function continuationPage(config: TemplateConfig, layout: CanvasLayout | null) {
  const data = await rich({ openItems: manyItems(300) });
  const printed = { ...config, layout };
  const def = () => buildStatementDefinition(data, printed);
  const marked = layout === null ? buildStatementDefinition(data, printed, undefined, { seedIds: true }) : def();
  const { groups } = await renderSheetGroupsWithPositions([marked]);
  const blockTopId = layout === null ? STATEMENT_SEED_IDS.start("open_items") : CANVAS_IDS.regionEnd("bill_to");
  const blockTop = groups[0].positions.find((n) => n.id === blockTopId && n.page === 1)!.top;
  const pdf = await renderPdf(def());
  const headingOffset = lineTop(pdf, 0, HEADING_ROW) - blockTop;
  const page2 = rawLines(pdf, 1);
  const body = page2.slice(page2.findIndex((l) => l.text.startsWith(HEADING_ROW))).filter((l) => !l.text.startsWith("Page "));
  const definition = def();
  return {
    top: body[0].top - headingOffset,
    lines: body.length,
    pitch: (body[body.length - 1].top - body[0].top) / (body.length - 1),
    limit: PAGE_HEIGHT - (definition.pageMargins as number[])[3],
    overflowTop: definition.continuationHeaderSpec?.overflowTopMargin,
  };
}

const LOGO = pngDataUri(tinyAlphaPng());

describe("seedStatementLayout (design 2026-11-11 §5.3)", () => {
  it("answers a layout validateCanvasLayout accepts: the five blocks stacked, the header and identity page-top, nothing in the band, the customer repeating", async () => {
    const layout = await seedStatementLayout(customerId, cfg(), undefined);
    expect(() => validateCanvasLayout(layout, STATEMENT_CONTRACT, { pageFooter: false })).not.toThrow();
    expect(tablesByY(layout).map((t) => t.key)).toEqual(BLOCKS);
    expect(fields(layout).map((f) => [f.key, f.anchor.kind])).toEqual([
      ["title", "page-top"], ["company_name", "page-top"], ["customer", "page-top"], ["statement_date", "page-top"],
      ["remit_to", "page-top"],
    ]);
    expect(layout.items.filter((i) => i.kind !== "table" && i.anchor.kind === "page-bottom")).toEqual([]);
    expect(layout.items.filter((i) => i.repeat).map((i) => (i.kind === "field" ? i.key : i.kind))).toEqual(["customer"]);
  }, 60_000);

  it("golden: the Standard's seed prints the fixture's statement where the flow prints it, on one page, the finance line and Total Due among its lines", async () => {
    const layout = await seed(cfg());
    const data = await rich();
    expect(data.financeCharge).toBe(12.34);
    const { flow } = await golden(data, cfg(), layout);
    const texts = rawLines(flow, 0).map((l) => l.text);
    expect(texts.some((t) => t.startsWith("Finance Charge"))).toBe(true);
    expect(texts.some((t) => t.startsWith("Total Due"))).toBe(true);
  }, 60_000);

  it("no finance charge: the same seed prints Total Due within 0.5 pt of the flow's", async () => {
    const layout = await seed(cfg());
    const { flow, canvas } = await golden(await rich({ financeCharge: null }), cfg(), layout);
    expect(Math.abs(lineTop(canvas, 0, "Total Due") - lineTop(flow, 0, "Total Due"))).toBeLessThanOrEqual(0.5);
  }, 60_000);

  it.each(["header-left", "header-center", "header-right"] as const)("the logo at %s: the seeded Logo item prints where the flow paints it", async (placement) => {
    const config = cfg();
    config.logo = { placement, width: DEFAULT_LOGO_WIDTH };
    const layout = await seed(config, LOGO);
    const logo = layout.items.find((i) => i.kind === "logo");
    expect(logo?.box.w).toBe(DEFAULT_LOGO_WIDTH);
    const { flow, canvas } = await golden(await rich(), config, layout, LOGO);
    expect(paintedImages(flow)[0]).toHaveLength(1);
    expect(paintedImages(canvas)[0]).toHaveLength(1);
  }, 60_000);

  it("the identity's widths: the customer, the statement date and the Bill To block beside the Remit To box, and across the column with it hidden", async () => {
    const layout = await seed(cfg());
    expect(LINE_WIDTH).toBe(262);
    for (const key of ["customer", "statement_date"]) expect(fieldItem(layout, key)!.box.w).toBe(LINE_WIDTH);
    expect(block(layout, "bill_to").box).toMatchObject({ x: MARGIN + SW.identityIndent, w: LINE_WIDTH });
    const hidden = cfg();
    fieldOf(hidden, "identity", "remit_to").visible = false;
    const alone = await seed(hidden);
    expect(LINE_WIDTH_ALONE).toBe(524);
    for (const key of ["customer", "statement_date"]) expect(fieldItem(alone, key)!.box.w).toBe(LINE_WIDTH_ALONE);
    expect(block(alone, "bill_to").box).toMatchObject({ x: MARGIN + SW.identityIndent, w: LINE_WIDTH_ALONE });
  }, 60_000);

  it.each(["open_items", "aging"])("a block above the identity (%s): it prints where the flow does, the Remit To anchored below it and the identity's lines measured from its end", async (key) => {
    const config = cfg();
    moveSectionBefore(config, key, "identity");
    const layout = await seed(config);
    const positions = await laid(config);
    const remit = fieldItem(layout, "remit_to")!;
    expect(remit.anchor).toEqual({ kind: "below-table", table: key });
    const end = positions.top(STATEMENT_SEED_IDS.sectionEnd(key));
    for (const line of ["customer", "statement_date"]) {
      const item = fieldItem(layout, line)!;
      expect(item.anchor).toEqual({ kind: "below-table", table: key });
      expect(Math.abs(item.box.y - (positions.top(STATEMENT_SEED_IDS.piece(line)) - end))).toBeLessThanOrEqual(0.001);
    }
    // The customer's offset is the identity row's distance under the block (the table's 10 pt), not
    // its place on the page.
    expect(fieldItem(layout, "customer")!.box.y).toBeLessThan(20);
    expect(Math.abs(remit.box.y - (positions.top(STATEMENT_SEED_IDS.piece("remit_to")) - end))).toBeLessThanOrEqual(0.001);
    await golden(await rich(), config, layout);
  }, 60_000);

  it("the open items above the identity, 37 to 41 of them: the held Bill To breaking across a page keeps every later block inside the right margin", async () => {
    // Red when the held block's lateral margin sits on its wrapper stack AND its column is `"*"`
    // (#970's whole-branch review, finding 1): a columns node that breaks across a page under a
    // margined stack leaves the nodes after it a width wider than the page's by the block's left
    // plus right inset (`canvas-nodes.ts`'s header), and a `"*"` column takes that width, so the
    // aging, the finance line and Total Due print about 300 pt past the right edge. Green on either
    // alone (#969's fix wave, 2026-11-12, by mutation): with the fixed column every later block and
    // item takes a fixed width, so no node reads the widened one. The margin's place is held by
    // structure, tests/statement-canvas.test.ts's "the held block's lateral margin is on its columns
    // node, its wrapper's zeroed", and by the canvas paper oracle's STATEMENT "open items 40 pt in"
    // cases, whose column-toggle premise reds on a margined wrapper.
    const items = (n: number): StatementOpenItem[] => Array.from({ length: n }, (_, i) => ({
      documentNumber: `7 - ${93000 + i}`, date: "2026-07-10", dueDate: "2026-08-09", kind: "INVOICE" as const, original: 1000 + i, open: 500 + i,
    }));
    const right = CANVAS_PAGE.width - MARGIN;
    let straddles = 0;
    for (const pageFooter of [false, true]) {
      const config: TemplateConfig = { ...cfg(), pageFooter };
      moveSectionBefore(config, "open_items", "identity");
      const layout = await seed(config);
      for (let n = 37; n <= 41; n++) {
        for (const oneLine of [false, true]) {
          const four = await rich({ openItems: items(n) });
          expect(four.customer.billTo).toHaveLength(4);
          const data: StatementData = oneLine ? { ...four, customer: { ...four.customer, billTo: ["Demo Foundry"] } } : four;
          const { flow, canvas } = await papers(data, config, layout);
          const where = `pageFooter=${pageFooter} n=${n} billTo=${data.customer.billTo.length}`;
          for (const [name, pdf] of [["flow", flow], ["canvas", canvas]] as const) {
            const past = textRunsWithY(pdf).flatMap((runs, page) =>
              runs.filter((r) => r.text.trim() !== "" && r.x > right).map((r) => `p${page + 1}:${r.text.trim()}@${r.x.toFixed(1)}`));
            expect(past, `${name} ${where}`).toEqual([]);
          }
          // Not vacuous: the canvas pages, and where the Bill To's label is on page 1 and its last
          // line on page 2, the held block broke across the page.
          expect(pageCount(canvas), where).toBeGreaterThan(1);
          const lines = linesOf(styledRuns(canvas)[0]).map((l) => l.text);
          const last = data.customer.billTo[data.customer.billTo.length - 1];
          if (lines.includes("Bill To") && !lines.includes(last)) straddles += 1;
        }
      }
    }
    expect(straddles).toBeGreaterThan(0);
  }, 300_000);

  it("the open items drawn 40 pt in on each side, 40 to 120 of them: the block pages and every later block prints where the full-width one's does", async () => {
    // Red when a block that is not held carries its lateral margin on its wrapper stack AND its
    // column is `"*"`: on a page break inside a top-level column group (a table's row, a columns
    // node) pdfmake rebuilds the available width from that group's own margin, never a parent
    // stack's, so under a margined wrapper the nodes after a narrowed block that pages are left a
    // width wider than the page's by the block's left plus right inset, a `"*"` column takes it,
    // and the aging's Net and Total Due's amount print past the right edge. Green on either alone,
    // as the case above is (the same mutations), since no fixed-width node reads the widened width;
    // the margin's place is held by the same structural pin and oracle premise named there.
    const items = (n: number): StatementOpenItem[] => Array.from({ length: n }, (_, i) => ({
      documentNumber: `7 - ${93000 + i}`, date: "2026-07-10", dueDate: "2026-08-09", kind: "INVOICE" as const, original: 1000 + i, open: 500 + i,
    }));
    const right = CANVAS_PAGE.width - MARGIN;
    const config = cfg();
    const wide = await seed(config);
    const narrow = structuredClone(wide);
    const block = narrow.items.find((i) => i.kind === "table" && i.key === "open_items")!;
    expect(block.box.w).toBe(right - MARGIN);
    block.box = { ...block.box, x: block.box.x + 40, w: block.box.w - 80 };
    expect(() => validateCanvasLayout(narrow, STATEMENT_CONTRACT, { pageFooter: config.pageFooter })).not.toThrow();
    /** Every page's printed lines, top to bottom, page by page. */
    const allLines = (pdf: Buffer) => textRunsWithY(pdf).flatMap((runs) => linesOf(runs.map((r) => ({ ...r, font: "", size: 0 }))));
    /** The x of each run of the first line `pick` finds. */
    const xs = (pdf: Buffer, pick: (l: { text: string; runs: Run[] }) => boolean, what: string) => {
      const line = allLines(pdf).find(pick);
      expect(line, what).toBeDefined();
      return line!.runs.map((r) => r.x);
    };
    const heading = (l: { text: string; runs: Run[] }) => l.text.startsWith("Document #");
    const aging = (l: { text: string; runs: Run[] }) => l.runs.some((r) => r.text.trim() === "Net");
    const total = (l: { text: string; runs: Run[] }) => l.text.startsWith("Total Due");
    for (const n of [40, 60, 80, 120]) {
      const data = await rich({ openItems: items(n) });
      const full = await renderPdf(buildStatementDefinition(data, { ...config, layout: wide }));
      const pdf = await renderPdf(buildStatementDefinition(data, { ...config, layout: narrow }));
      const where = `n=${n}`;
      const past = textRunsWithY(pdf).flatMap((runs, page) =>
        runs.filter((r) => r.text.trim() !== "" && r.x > right).map((r) => `p${page + 1}:${r.text.trim()}@${r.x.toFixed(1)}`));
      expect(past, where).toEqual([]);
      // Not vacuous: the narrowed block pages, and its heading prints 40 pt in from the full-width one's.
      expect(pageCount(pdf), where).toBeGreaterThan(1);
      expect(Math.abs(xs(pdf, heading, where)[0] - xs(full, heading, where)[0] - 40), where).toBeLessThanOrEqual(0.5);
      for (const [name, pick] of [["aging", aging], ["Total Due", total]] as const) {
        const got = xs(pdf, pick, `${name} ${where}`);
        const want = xs(full, pick, `${name} ${where}`);
        expect(got.length, `${name} ${where}`).toBe(want.length);
        got.forEach((x, i) => expect(Math.abs(x - want[i]), `${name} run ${i} ${where}`).toBeLessThanOrEqual(0.5));
      }
    }
  }, 300_000);

  it.each([["three-line", THREE_LINES], ["two-line", TWO_LINES]])("the held floor: a one-line bill-to prints the open items' heading row where the flow does, under a %s company address (the held block lifts nothing)", async (_name, address) => {
    await setCompany(address);
    const layout = await seed(cfg());
    const data = await rich({ customer: { code: "C100", name: "Demo Foundry", billTo: ["Demo Foundry"] } });
    // The heading row first, so a lift shows as its own figure before the whole comparison.
    const { flow, canvas } = await papers(data, cfg(), layout);
    expect(Math.abs(lineTop(canvas, 0, HEADING_ROW) - lineTop(flow, 0, HEADING_ROW))).toBeLessThanOrEqual(0.5);
    await golden(data, cfg(), layout);
  }, 60_000);

  describe("what survives the seed", () => {
    it("typed labels: the Bill To as its block's heading, the customer as its item's label, an open-items row's", async () => {
      const config = cfg();
      fieldOf(config, "identity", "bill_to").label = "Invoice To";
      fieldOf(config, "identity", "customer").label = "Account:";
      fieldOf(config, "open_items", "document_no").label = "Ref";
      const layout = await seed(config);
      expect(block(layout, "bill_to").heading).toBe("Invoice To");
      expect(fieldItem(layout, "customer")!.label).toBe("Account:");
      expect(block(layout, "open_items").columns.find((c) => c.key === "document_no")!.label).toBe("Ref");
      await golden(await rich(), config, layout);
    }, 60_000);

    it("a hidden due date is stored as its row, not shown", async () => {
      const config = cfg();
      fieldOf(config, "open_items", "due_date").visible = false;
      const layout = await seed(config);
      expect(block(layout, "open_items").columns.find((c) => c.key === "due_date")!.visible).toBe(false);
      await golden(await rich(), config, layout);
    }, 60_000);

    it("a hidden Remit To: no box, the Bill To at its content", async () => {
      const config = cfg();
      fieldOf(config, "identity", "remit_to").visible = false;
      const layout = await seed(config);
      const positions = await laid(config);
      expect(fieldItem(layout, "remit_to")).toBeUndefined();
      const bill = block(layout, "bill_to");
      expect(Math.abs(bill.box.h - (positions.top(STATEMENT_SEED_IDS.sectionEnd("bill_to")) - positions.top(STATEMENT_SEED_IDS.start("bill_to"))))).toBeLessThanOrEqual(0.001);
      await golden(await rich(), config, layout);
    }, 60_000);

    it("the finance section ordered below Total Due", async () => {
      const config = cfg();
      const [finance] = config.sections.splice(config.sections.findIndex((s) => s.key === "finance_charge"), 1);
      config.sections.push(finance);
      const layout = await seed(config);
      expect(tablesByY(layout).map((t) => t.key)).toEqual(["bill_to", "open_items", "aging", "total", "finance_charge"]);
      await golden(await rich(), config, layout);
      await golden(await rich({ financeCharge: null }), config, layout);
    }, 60_000);

    it("the aging ordered before the open items", async () => {
      const config = cfg();
      moveSectionBefore(config, "aging", "open_items");
      const layout = await seed(config);
      expect(tablesByY(layout).map((t) => t.key)).toEqual(["bill_to", "aging", "open_items", "finance_charge", "total"]);
      await golden(await rich(), config, layout);
    }, 60_000);

    it("a typed aging width is stored on its column", async () => {
      const config = cfg();
      fieldOf(config, "aging", "aging_net").width = 120;
      const layout = await seed(config);
      const aging = block(layout, "aging");
      expect(aging.columns.find((c) => c.key === "aging_net")!.width).toBe(120);
      expect(aging.columns.filter((c) => c.key !== "aging_net").map((c) => c.width)).toEqual(Array(6).fill(null));
      await golden(await rich(), config, layout);
    }, 60_000);
  });

  describe("the held Bill To's seeding, by golden (the whole-branch review's finding 4)", () => {
    it("the header ordered after the identity prints where the flow prints it: what follows the held block measures from its drawn bottom", async () => {
      // Red when the held block's walk base is its laid-out end (`base = node.top` for
      // `start.top + h`): the header's pieces, anchored below the Bill To, then take their offsets from
      // the stand-in Bill To's laid-out end, above the Remit To box's bottom the block is drawn down
      // to, and print that much lower than the flow's ("Statement" 10.29 pt lower, measured).
      const config = cfg();
      moveSectionBefore(config, "header", "open_items");
      const layout = await seed(config);
      expect(fieldItem(layout, "title")!.anchor).toEqual({ kind: "below-table", table: "bill_to" });
      await golden(await rich(), config, layout);
    }, 60_000);

    it.each([["aging", "every aging column"], ["open_items", "every open-items row"]] as const)("the %s above the identity with %s hidden, clamped to the row floor: the held Bill To is drawn lower by that clamp", async (key, hidden) => {
      // Red when the held block is drawn at its laid-out top (`y: start.top` for `start.top + lift`):
      // the block above it seeds at the row floor, taller than it lays out, so every later block is
      // drawn lower by the clamp; drawn at its laid-out top, the Bill To stands that much nearer the
      // block above it, and page 1's lines no longer print as the flow's (measured: their order).
      const config = cfg();
      moveSectionBefore(config, key, "identity");
      for (const f of section(config, key).fields) f.visible = false;
      const layout = await seed(config);
      expect(block(layout, key).box.h, `${hidden} hidden: the block seeds at the row floor`).toBe(STATEMENT_ROW_FLOOR);
      await golden(await rich(), config, layout);
    }, 60_000);

    it("the Bill To between the customer and a hidden statement date ends the shown left column: drawn down to the Remit To box, a two-line bill-to under the two-line company address", async () => {
      // Red when `billToLast` counts a hidden field (its `(f.visible ?? true)` test dropped): the
      // hidden statement date then ends the left column, the block is not drawn down to the Remit To
      // box's bottom, and the open items start higher than the flow's under the taller Remit To box.
      const config = cfg();
      leftOrder(config, ["customer", "bill_to", "statement_date"]);
      fieldOf(config, "identity", "statement_date").visible = false;
      const layout = await seed(config);
      const base = await rich();
      const data = await rich({ customer: { ...base.customer, billTo: ["Demo Foundry", "1 Example Street"] } });
      await golden(data, config, layout);
    }, 60_000);
  });

  it("the seal carries its move down: Total Due, the finance line, the open items and the aging back to back, the aging keeps the flow's distance under the open items to a thousandth", async () => {
    // Ordered so: Total Due's end mark, the finance block's marks and the open items' start mark meet
    // with no margin between them, so `tidy`'s thousandths draw the open items a rounding step above
    // the finance block's drawn bottom (its snapped top plus its snapped height), and `sealed` moves
    // them down a thousandth. The move is carried to every block below, so the aging stays the flow's
    // 10 pt under the open items to the thousandth; the certification's each-on-its-own seal (#960)
    // leaves the aging unmoved, a thousandth short. No printed position sees a thousandth, so the
    // drawn figures are the proof.
    const config = cfg();
    const keyed = (k: string) => config.sections.find((sc) => sc.key === k)!;
    config.sections = [keyed("header"), keyed("identity"), keyed("total"), keyed("finance_charge"), keyed("open_items"), keyed("aging")];
    const layout = await seed(config);
    const positions = await laid(config);
    const snap = (n: number) => Math.round(n * 1000) / 1000;
    const finance = block(layout, "finance_charge");
    const open = block(layout, "open_items");
    const aging = block(layout, "aging");
    const openStart = snap(positions.top(STATEMENT_SEED_IDS.start("open_items")));
    // The premise: the seal moved the open items down to the finance block's drawn bottom.
    expect(open.box.y).toBeGreaterThan(openStart);
    expect(open.box.y).toBeGreaterThanOrEqual(finance.box.y + finance.box.h);
    const flowGap = snap(positions.top(STATEMENT_SEED_IDS.start("aging"))) - openStart;
    expect(Math.round((aging.box.y - open.box.y) * 1000)).toBe(Math.round(flowGap * 1000));
    await golden(await rich(), config, layout);
  }, 60_000);

  it("untyped labels stay null: the finance line's (#162's wording re-resolves at print) and all seven aging columns' (ruling 8's headings)", async () => {
    const layout = await seed(cfg());
    expect(block(layout, "finance_charge").columns).toEqual([{ key: "finance_charge", visible: true, label: null, width: null }]);
    const aging = block(layout, "aging").columns;
    expect(aging).toHaveLength(7);
    expect(aging.map((c) => c.label)).toEqual(Array(7).fill(null));
    expect(block(layout, "bill_to").heading).toBeNull();
    expect(fieldItem(layout, "customer")!.label).toBeNull();
  }, 60_000);

  it("the same layout for every customer: 1,000 open items or none, a 120-character name or one letter", async () => {
    const plain = await seed(cfg());
    const busy = await makeCustomer();
    await bulkOpenItems(busy.id, 1000);
    expect(byContent(await seedStatementLayout(busy.id, cfg(), undefined))).toEqual(byContent(plain));
    const long = await prisma.customer.create({ data: { code: "LONGNAME", name: "N".repeat(60) + " " + "M".repeat(59) } });
    const short = await prisma.customer.create({ data: { code: "A", name: "A" } });
    const longLayout = await seedStatementLayout(long.id, cfg(), undefined);
    expect(byContent(longLayout)).toEqual(byContent(await seedStatementLayout(short.id, cfg(), undefined)));
    expect(byContent(longLayout)).toEqual(byContent(plain));
    // One line tall: the stand-in's code and name, never the picked customer's.
    const positions = await laid(cfg());
    expect(Math.abs(fieldItem(longLayout, "customer")!.box.h
      - (positions.top(STATEMENT_SEED_IDS.end("customer")) - positions.top(STATEMENT_SEED_IDS.piece("customer"))))).toBeLessThanOrEqual(0.001);
    expect(fieldItem(longLayout, "customer")!.box.h).toBeLessThan(13);
  }, 120_000);

  const ORDERS: string[][] = [
    ["customer", "statement_date", "bill_to"], ["statement_date", "customer", "bill_to"],
    ["customer", "bill_to", "statement_date"], ["statement_date", "bill_to", "customer"],
    ["bill_to", "customer", "statement_date"], ["bill_to", "statement_date", "customer"],
  ];
  it.each(ORDERS)("the left column ordered %s, %s, %s: the Bill To's height and anchor, and the anchors of the lines after it", async (...order) => {
    const config = cfg();
    leftOrder(config, order);
    const layout = await seed(config);
    const positions = await laid(config);
    const bill = block(layout, "bill_to");
    const start = positions.top(STATEMENT_SEED_IDS.start("bill_to"));
    const own = positions.top(STATEMENT_SEED_IDS.sectionEnd("bill_to"));
    const remitEnd = positions.top(STATEMENT_SEED_IDS.end("remit_to"));
    const last = order[order.length - 1] === "bill_to";
    // Drawn down to the Remit To box's bottom only where it ends the left column.
    expect(Math.abs(bill.box.h - ((last ? Math.max(own, remitEnd) : own) - start))).toBeLessThanOrEqual(0.001);
    expect(bill.anchor).toEqual({ kind: "page-top" });
    const after = order.slice(order.indexOf("bill_to") + 1);
    const before = order.slice(0, order.indexOf("bill_to"));
    for (const key of after) {
      const item = fieldItem(layout, key)!;
      expect(item.anchor, key).toEqual({ kind: "below-table", table: "bill_to" });
      expect(Math.abs(item.box.y - (positions.top(STATEMENT_SEED_IDS.piece(key)) - own)), key).toBeLessThanOrEqual(0.001);
    }
    for (const key of before) expect(fieldItem(layout, key)!.anchor, key).toEqual({ kind: "page-top" });
    expect(fieldItem(layout, "remit_to")!.anchor).toEqual({ kind: "page-top" });
    if (last) await golden(await rich(), config, layout);
  }, 60_000);

  it.each(["bill_to", "open_items", "aging", "finance_charge", "total"])("every field of %s hidden: the block prints nothing, as the flow does", async (key) => {
    const config = cfg();
    const sectionKey = key === "bill_to" ? "identity" : key;
    for (const f of section(config, sectionKey).fields) if (key !== "bill_to" || f.key === "bill_to") f.visible = false;
    const layout = await seed(config);
    if (key === "bill_to") {
      expect(hasBlock(layout, "bill_to")).toBe(false);
    } else {
      const b = block(layout, key);
      expect(b.columns.length).toBeGreaterThan(0);
      expect(b.columns.every((c) => !c.visible)).toBe(true);
      expect(b.box.h).toBe(STATEMENT_ROW_FLOOR);
    }
    await golden(await rich(), config, layout);
  }, 60_000);

  it.each(["open_items", "aging", "finance_charge", "total", "header"])("a hidden %s section gives no item for it", async (key) => {
    const config = cfg();
    section(config, key).visible = false;
    const layout = await seed(config);
    if (key === "header") {
      expect(fieldItem(layout, "title")).toBeUndefined();
      expect(fieldItem(layout, "company_name")).toBeUndefined();
    } else {
      expect(hasBlock(layout, key)).toBe(false);
    }
    await golden(await rich(), config, layout);
  }, 60_000);

  it("the clamp and lift: every open-items row hidden seeds the block at the floor, and the aging, the finance line and Total Due print where the flow does", async () => {
    const config = cfg();
    for (const f of section(config, "open_items").fields) f.visible = false;
    const layout = await seed(config);
    const open = block(layout, "open_items");
    expect(open.box.h).toBe(STATEMENT_ROW_FLOOR);
    expect(open.columns.map((c) => c.visible)).toEqual(Array(5).fill(false));
    const { flow, canvas } = await golden(await rich(), config, layout);
    for (const line of ["Current", "Finance Charge", "Total Due"]) {
      expect(Math.abs(lineTop(canvas, 0, line) - lineTop(flow, 0, line)), line).toBeLessThanOrEqual(0.5);
    }
  }, 60_000);

  it.each(FONT_FAMILIES)("every family, %s: every block at least the floor, the golden held, the Remit To measured in the face, and a clamped open items block lifting what is below it", async (family) => {
    const config = cfg();
    config.fonts.family = family;
    const layout = await seed(config);
    for (const t of tablesByY(layout)) expect(t.box.h, t.key).toBeGreaterThanOrEqual(STATEMENT_ROW_FLOOR);
    // In Roboto Mono the fixture's customer line ("Customer: C100 — Demo Foundry - Columbus LLC")
    // wraps in the seeded 262 pt, design §4.5's long-name residual: the flow pushes the date and the
    // Bill To down a line where the canvas prints the second line over the date. That face's golden
    // prints a customer whose line fits; the wrap itself is pinned here.
    const data = family === "Roboto Mono" ? await rich({ customer: { ...richStatement().customer, name: "Demo Foundry" } }) : await rich();
    if (family === "Roboto Mono") {
      const wrapped = await papers(await rich(), config, layout);
      expect(rawLines(wrapped.flow, 0).map((l) => l.text)).toContain("LLC");
      // The miss, measured: the flow prints the date, the Bill To and the open items one Mono line
      // lower than the canvas does (MONO_LONG_NAME_MISS).
      for (const line of ["Statement Date", "Bill To", HEADING_ROW]) {
        const miss = lineTop(wrapped.flow, 0, line) - lineTop(wrapped.canvas, 0, line);
        expect(Math.abs(miss - MONO_LONG_NAME_MISS), `${line}: measured ${miss}`).toBeLessThanOrEqual(0.01);
      }
    }
    const { flow } = await golden(data, config, layout);
    // The Remit To box as the flow strokes it in this face: its left rule, from the box's top to its
    // bottom (the box's corner and its end mark, tests/statement-canvas.test.ts).
    const remit = fieldItem(layout, "remit_to")!;
    const upright = strokedLines(flow)[0].filter((s) => Math.abs(s.x1 - s.x2) < 0.01 && s.x1 >= remit.box.x && s.x1 <= remit.box.x + 1);
    expect(upright).toHaveLength(1);
    expect(Math.abs(remit.box.h - Math.abs(upright[0].y2 - upright[0].y1))).toBeLessThanOrEqual(0.01);
    if (family === "Roboto Mono") {
      // The face the finance label wraps in (two lines), and Total Due then the least block.
      expect(Math.abs(remit.box.h - 70.31)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(block(layout, "finance_charge").box.h - 28.38)).toBeLessThanOrEqual(0.01);
      const heights = tablesByY(layout).map((t) => t.box.h);
      expect(block(layout, "total").box.h).toBe(Math.min(...heights));
    }
    const clamped = cfg();
    clamped.fonts.family = family;
    for (const f of section(clamped, "open_items").fields) f.visible = false;
    const clampedLayout = await seed(clamped);
    expect(block(clampedLayout, "open_items").box.h).toBe(STATEMENT_ROW_FLOOR);
    const c = await golden(data, clamped, clampedLayout);
    for (const line of ["Current", "Finance Charge", "Total Due"]) {
      expect(Math.abs(lineTop(c.canvas, 0, line) - lineTop(c.flow, 0, line)), line).toBeLessThanOrEqual(0.5);
    }
  }, 120_000);

  describe("the repeat", () => {
    it("the customer repeats on the Standard's order", async () => {
      expect(fieldItem(await seed(cfg()), "customer")!.repeat).toBe(true);
    }, 60_000);

    it("nothing repeats with the customer hidden", async () => {
      const config = cfg();
      fieldOf(config, "identity", "customer").visible = false;
      const layout = await seed(config);
      expect(fieldItem(layout, "customer")).toBeUndefined();
      expect(layout.items.filter((i) => i.repeat)).toEqual([]);
    }, 60_000);

    it("nothing repeats with the open items ordered above the identity", async () => {
      const config = cfg();
      moveSectionBefore(config, "open_items", "identity");
      expect((await seed(config)).items.filter((i) => i.repeat)).toEqual([]);
    }, 60_000);

    it("nothing repeats with the customer ordered after the Bill To", async () => {
      const config = cfg();
      leftOrder(config, ["statement_date", "bill_to", "customer"]);
      expect((await seed(config)).items.filter((i) => i.repeat)).toEqual([]);
    }, 60_000);

    it("withRepeat flags no customer anchored below a table, though its box clears the first block by a grid step", async () => {
      // Direct, so the guard is proved by this assertion and not by the seed's closing
      // validateCanvasLayout (which refuses a below-table repeat as a TemplateConfigError): the two
      // "nothing repeats" cases above red under the guard's deletion only through that backstop. The
      // seeded Standard's items, nothing repeating, with the customer's anchor alone changed; its box
      // is the Standard's, which clears the Bill To by the grid step (the premise, asserted), so the
      // anchor is all that keeps it from repeating. Red when withRepeat's `anchor.kind === "page-top"`
      // test is deleted (it then flags the customer).
      const items = (await seed(cfg())).items.map((i) => ({ ...i, repeat: false }));
      const customer = items.find((i) => i.kind === "field" && i.key === "customer")!;
      const first = tablesByY({ version: 1, items })[0];
      expect(customer.box.y + customer.box.h + CANVAS_GRID).toBeLessThanOrEqual(first.box.y);
      expect(withRepeat(items).find((i) => i.kind === "field" && i.key === "customer")!.repeat, "page-top: the premise").toBe(true);
      const below = items.map((i) => (i === customer ? { ...i, anchor: { kind: "below-table" as const, table: "open_items" } } : i));
      expect(withRepeat(below)).toEqual(below);
    }, 60_000);

    it("ordered statement date, customer, Bill To: the comparison against the Bill To's top, not the anchor, settles it", async () => {
      const config = cfg();
      leftOrder(config, ["statement_date", "customer", "bill_to"]);
      const layout = await seed(config);
      const customer = fieldItem(layout, "customer")!;
      const first = tablesByY(layout)[0];
      expect(customer.anchor).toEqual({ kind: "page-top" });
      expect(first.key).toBe("bill_to");
      // The customer ends where the Bill To starts, so it is not a grid step above it: no repeat.
      const clears = customer.box.y + customer.box.h + CANVAS_GRID <= first.box.y;
      expect(clears).toBe(false);
      expect(customer.repeat).toBe(clears);
      expect(withRepeat(layout.items.map((i) => ({ ...i, repeat: false })))
        .find((i) => i.kind === "field" && i.key === "customer")!.repeat).toBe(false);
    }, 60_000);
  });

  describe("the identity's other orders", () => {
    it("the three left fields hidden: the Remit To at the left margin, and no Bill To block", async () => {
      const config = cfg();
      for (const key of ["customer", "statement_date", "bill_to"]) fieldOf(config, "identity", key).visible = false;
      const layout = await seed(config);
      expect(fieldItem(layout, "remit_to")!.box.x).toBe(MARGIN);
      expect(hasBlock(layout, "bill_to")).toBe(false);
      await golden(await rich(), config, layout);
    }, 60_000);

    it("the Bill To hidden: no Bill To block, the open items the first block", async () => {
      const config = cfg();
      fieldOf(config, "identity", "bill_to").visible = false;
      const layout = await seed(config);
      expect(hasBlock(layout, "bill_to")).toBe(false);
      expect(tablesByY(layout)[0].key).toBe("open_items");
      await golden(await rich(), config, layout);
    }, 60_000);

    it("the Identity section hidden: no identity items and no Bill To block", async () => {
      const config = cfg();
      section(config, "identity").visible = false;
      const layout = await seed(config);
      for (const key of ["customer", "statement_date", "remit_to"]) expect(fieldItem(layout, key)).toBeUndefined();
      expect(hasBlock(layout, "bill_to")).toBe(false);
      await golden(await rich(), config, layout);
    }, 60_000);
  });

  it("the left-slot residual, measured and pinned: the customer after the Bill To, a four-line bill-to prints its open items lower than the flow's, by at most the Remit To's excess over the stand-in's Bill To", async () => {
    const config = cfg();
    leftOrder(config, ["statement_date", "bill_to", "customer"]);
    const layout = await seed(config);
    const positions = await laid(config);
    const data = await rich();
    expect(data.customer.billTo).toHaveLength(4);
    const { flow, canvas } = await papers(data, config, layout);
    const lower = lineTop(canvas, 0, HEADING_ROW) - lineTop(flow, 0, HEADING_ROW);
    const excess = positions.top(STATEMENT_SEED_IDS.end("remit_to")) - positions.top(STATEMENT_SEED_IDS.leftColumnEnd);
    expect(lower).toBeGreaterThan(0.5);
    expect(lower).toBeLessThanOrEqual(excess + 0.01);
    expect(Math.abs(lower - LEFT_SLOT_RESIDUAL), `measured ${lower}, the box's excess ${excess}`).toBeLessThanOrEqual(0.01);
  }, 60_000);

  it("only seed: ids are read: a non-seed id among the positions changes nothing", async () => {
    const config = cfg();
    const positions = (await laid(config)).positions;
    const mid = Math.floor(positions.length / 2);
    const foreign = [{ id: "canvas:item:x", page: 1, left: 30, top: 300 }, { id: "foreign-node", page: 1, left: 40, top: 310 }] as LaidOutNode[];
    const withForeign = [...positions.slice(0, mid), ...foreign, ...positions.slice(mid)];
    expect(byContent({ version: 1, items: seedStatementItems(config, withForeign, false) }))
      .toEqual(byContent({ version: 1, items: seedStatementItems(config, positions, false) }));
  }, 60_000);

  it("writes nothing: no stored document, audit row, template version or draft (pin)", async () => {
    const before = [await prisma.storedDocument.count(), await prisma.auditLog.count(), await prisma.documentTemplateVersion.count(), await prisma.orderDraft.count()];
    await seedStatementLayout(customerId, cfg(), undefined);
    expect([await prisma.storedDocument.count(), await prisma.auditLog.count(), await prisma.documentTemplateVersion.count(), await prisma.orderDraft.count()]).toEqual(before);
  }, 60_000);

  it("a deleted customer and an unknown id are each refused in the preview's 404", async () => {
    const deleted = await makeCustomer();
    await prisma.customer.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });
    for (const id of [deleted.id, "no-such-customer"]) {
      const refusal = await seedStatementLayout(id, cfg(), undefined).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(HttpError);
      expect((refusal as HttpError).status).toBe(404);
      expect((refusal as HttpError).message).toBe("Customer not found");
    }
  }, 60_000);

  it("the stand-in: the settings' company and Remit To and today's date kept, every customer-dependent piece a placeholder", async () => {
    const settings: InvoicePrintSettings = await invoicePrintSettings();
    const d = statementStandIn(settings, "cust-1", "2026-11-12");
    expect(d).toEqual({
      asOf: "2026-11-12", company: settings.company, remitTo: settings.remitTo,
      customer: { code: "CODE", name: "Customer", billTo: ["Customer"] },
      openItems: [{ documentNumber: "Document", kind: "INVOICE", original: 0, open: 0, date: "2026-11-12", dueDate: "2026-11-12" }],
      aging: {
        customerId: "cust-1", customerCode: "CODE", customerName: "Customer",
        current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, unapplied: 0, net: 0,
      },
      financeCharge: 0, totalDue: 0,
    });
    expect(STATEMENT_STAND_IN.customer).toEqual({ code: "CODE", name: "Customer" });
    // The seeded styles are the flow's (statementSeedStyle), the customer's regular.
    const layout = await seed(cfg());
    expect(fieldItem(layout, "customer")!.style).toEqual(statementSeedStyle("customer", cfg().fonts));
  }, 60_000);

  it("the residuals, measured and pinned (design §4.4, §4.5, §15)", async () => {
    const config = cfg();
    const layout = await seed(config);
    const positions = await laid(config);
    const figures: Record<string, number> = {};
    const company = fieldItem(layout, "company_name")!;
    figures.headerHeight = company.box.y + company.box.h;
    const customer = fieldItem(layout, "customer")!;
    figures.customerTop = customer.box.y;
    figures.customerBottom = customer.box.y + customer.box.h;
    figures.remitToHeight = fieldItem(layout, "remit_to")!.box.h;
    figures.standInLeftColumn = positions.top(STATEMENT_SEED_IDS.leftColumnEnd) - positions.top(STATEMENT_SEED_IDS.identityStart);
    const twoItems = await laid(config, undefined, (d) => ({ ...d, openItems: [...d.openItems, ...d.openItems] }));
    const openHeight = (p: Awaited<ReturnType<typeof laid>>) =>
      p.top(STATEMENT_SEED_IDS.sectionEnd("open_items")) - p.top(STATEMENT_SEED_IDS.start("open_items"));
    figures.openItemRow = openHeight(twoItems) - openHeight(positions);
    // A 300-item statement: page 1 against its flow print.
    const paging = await papers(await rich({ openItems: manyItems(300) }), config, layout);
    const firstTop = (pdf: Buffer, page: number) => rawLines(pdf, page).sort((a, b) => a.top - b.top)[0].top;
    figures.pagedRise = firstTop(paging.flow, 0) - firstTop(paging.canvas, 0);

    // The continuation pages, read from page 2 of the 300-item prints (the flow's, the canvas's with
    // the page line off, and with it on): its top, the repeat band, and its room.
    const lineOn = cfg();
    lineOn.pageFooter = true;
    const onLayout = await seed(lineOn);
    const off = await continuationPage(config, layout);
    const onPage = await continuationPage(lineOn, onLayout);
    const flowPage = await continuationPage(config, null);
    // The repeat band: page 2's top, read from its first body line (the open items' repeated heading
    // row) less that row's offset under the block's rendered top on page 1. The leaf's figure agrees.
    figures.repeatBand = off.top;
    expect(Math.abs(off.top - topMargin(layout))).toBeLessThanOrEqual(0.01);
    expect(Math.abs(onPage.top - topMargin(onLayout))).toBeLessThanOrEqual(0.01);
    // The flow's page 2 starts at its own definition's overflow top margin.
    expect(Math.abs(flowPage.top - flowPage.overflowTop!)).toBeLessThanOrEqual(0.01);
    // The room: from page 2's top read off the paper to the page's bottom limit, the definition's
    // bottom margin (the canvas's, the band's top, as the leaf says). The paper proves the limit: page
    // 2 holds exactly the lines that fit under it at the rows' pitch, so a limit a row higher or lower
    // prints a line fewer or more.
    for (const page of [off, onPage, flowPage]) {
      expect(page.lines, `page 2's body lines, ${page.limit} limit`).toBe(Math.floor((page.limit - page.top) / page.pitch));
      expect(Math.abs(page.pitch - STATEMENT_SEED_RESIDUALS.openItemRow)).toBeLessThanOrEqual(0.01);
    }
    expect([off.lines, onPage.lines, flowPage.lines]).toEqual(CONTINUATION_LINES);
    expect(off.limit).toBe(bandTop(layout, false));
    expect(onPage.limit).toBe(bandTop(onLayout, true));
    figures.continuationRoomOff = off.limit - off.top;
    const flowContinuationRoom = flowPage.limit - flowPage.top;
    figures.continuationRoomLessOff = flowContinuationRoom - figures.continuationRoomOff;
    figures.continuationRoomLessOn = flowContinuationRoom - (onPage.limit - onPage.top);
    // The page line, with it on: the canvas's against the flow's.
    const on = await papers(await rich(), lineOn, onLayout);
    figures.pageLineRiseOn = lineTop(on.flow, 0, "Page 1 of 1") - lineTop(on.canvas, 0, "Page 1 of 1");
    for (const [key, value] of Object.entries(STATEMENT_SEED_RESIDUALS)) {
      expect(Math.abs(figures[key] - value), `${key}: measured ${figures[key]}`).toBeLessThanOrEqual(0.01);
    }

    // "(continued)"'s right edge in each face, against the customer label's x (64).
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
    expect(customer.box.x).toBe(MARGIN + SW.identityIndent);

    // The page counts at 100, 300 and 1,000 items, flow against canvas: logged and recorded.
    const counts: Record<number, [number, number]> = {};
    for (const n of [100, 300, 1000]) {
      const p = await papers(await rich({ openItems: manyItems(n) }), config, layout);
      counts[n] = [pageCount(p.flow), pageCount(p.canvas)];
    }
    console.log("statement seed residuals", JSON.stringify(figures), "continued", JSON.stringify(continuedRight), "pages (flow, canvas)", JSON.stringify(counts));
    expect(counts).toEqual(PAGE_COUNTS);
  }, 240_000);
});

// ---------------------------------------------------------------------------------------------
// Review Focus 3 on the SEEDED Standard (the whole-branch review's finding 2): a 300-item statement,
// the page line off and on, printed under the layout the seed answers for the Standard (its customer
// line at x 64 against "(continued)", where tests/statement-canvas.test.ts's paging cases print the
// hand-drawn fixture's at 85.5). Each page's runs are read RAW (`textRunsWithY`): a run's top is its
// baseline from the page's top.
// ---------------------------------------------------------------------------------------------

describe("the seeded Standard pages a 300-item statement (Review Focus 3)", () => {
  type PageRun = { text: string; x: number; top: number };
  const runsOf = (pdf: Buffer): PageRun[][] =>
    textRunsWithY(pdf).map((runs) => runs.filter((r) => r.text.trim() !== "").map((r) => ({ text: r.text, x: r.x, top: PAGE_HEIGHT - r.y })));
  /** Runs grouped by baseline (within 0.3 pt), each line's runs left to right. */
  const linesOfRuns = (runs: PageRun[]) => {
    const lines: PageRun[][] = [];
    for (const run of [...runs].sort((a, b) => a.top - b.top || a.x - b.x)) {
      const line = lines[lines.length - 1];
      if (line !== undefined && Math.abs(line[0].top - run.top) <= 0.3) line.push(run);
      else lines.push([run]);
    }
    return lines.map((line) => {
      const sorted = line.sort((a, b) => a.x - b.x);
      return { text: sorted.map((r) => r.text).join(" ").replace(/\s+/g, " ").trim(), top: sorted[0].top, runs: sorted };
    });
  };
  const CUSTOMER_WORD = defaultLabelOf(STATEMENT_CONTRACT, "customer").split(" ")[0];
  const FINANCE_LABEL = defaultLabelOf(STATEMENT_CONTRACT, "finance_charge");
  const TOTAL_LABEL = defaultLabelOf(STATEMENT_CONTRACT, "total_due");
  const AGING_CURRENT = defaultLabelOf(STATEMENT_CONTRACT, "aging_current");

  /** The seeded Standard with the page line `pageFooter`, and the 300-item statement printed under it:
   *  its bytes and its laid-out positions (each from a fresh definition: pdfmake uses up the nodes it
   *  lays out). */
  async function seededPaging(pageFooter: boolean) {
    const config: TemplateConfig = { ...cfg(), pageFooter };
    const layout = await seed(config);
    const data = await rich({ openItems: manyItems(300) });
    const printed = { ...config, layout };
    const pdf = await renderPdf(buildStatementDefinition(data, printed));
    const { groups } = await renderSheetGroupsWithPositions([buildStatementDefinition(data, printed)]);
    const at = (id: string): LaidOutNode => {
      const node = groups[0].positions.find((n) => n.id === id);
      if (node === undefined) throw new Error(`no laid-out node "${id}"`);
      return node;
    };
    return { layout, pdf, pages: pageCount(pdf), runs: runsOf(pdf), at };
  }

  it.each([false, true])("page line %s: every page after the first prints the customer line where it is drawn, (continued) and the open items' heading row first in its body", async (pageFooter) => {
    // Red when withRepeat flags nothing (the seed then repeats no item): on the premise first, and,
    // with the premise's line deleted, on the paper itself: a continuation page prints no customer
    // line ("page 2's customer runs: expected [] to have a length of 1", measured) and, with nothing
    // repeated, no "(continued)".
    const { layout, pages, runs } = await seededPaging(pageFooter);
    const customer = fieldItem(layout, "customer")!;
    expect(customer.repeat).toBe(true);
    expect(customer.box.x).toBe(MARGIN + SW.identityIndent);
    expect(pages).toBeGreaterThanOrEqual(2);
    const customerLine = (page: number) => {
      const starts = runs[page].filter((r) => r.text.trim().startsWith(CUSTOMER_WORD));
      expect(starts, `page ${page + 1}'s customer runs`).toHaveLength(1);
      const line = linesOfRuns(runs[page].filter((r) => Math.abs(r.top - starts[0].top) <= 0.3 && r.x >= customer.box.x - 0.5));
      return { x: starts[0].x, top: starts[0].top, text: line.map((l) => l.text).join(" ") };
    };
    const first = customerLine(0);
    const headingRow = linesOfRuns(runs[0]).find((l) => l.text.startsWith(HEADING_ROW))!.text;
    const bodyTop = topMargin(layout);
    for (let page = 1; page < pages; page++) {
      const where = `page ${page + 1}`;
      const line = customerLine(page);
      expect(Math.abs(line.x - customer.box.x), where).toBeLessThanOrEqual(0.5);
      expect(line.top, where).toBeGreaterThan(customer.box.y);
      expect(line.top, where).toBeLessThanOrEqual(customer.box.y + customer.box.h);
      expect(Math.abs(line.top - first.top), where).toBeLessThanOrEqual(0.5);
      expect(line.text, where).toBe(first.text);
      expect(runs[page].some((r) => r.text.includes("(continued)")), where).toBe(true);
      const body = linesOfRuns(runs[page].filter((r) => r.top > bodyTop));
      expect(body[0].text, where).toBe(headingRow);
    }
  }, 120_000);

  it.each([false, true])("page line %s: the aging, the finance line and Total Due print on the last page alone", async (pageFooter) => {
    // Red when the sheet lays its blocks out against their drawn order (`assembleCanvasSheet`
    // walking `tablesByY(layout).reverse()`): the aging, the finance line and Total Due then print on
    // page 1, ahead of the open items.
    const { pages, runs, at } = await seededPaging(pageFooter);
    expect(pages).toBeGreaterThanOrEqual(2);
    for (const key of ["aging", "finance_charge", "total"] as const) {
      expect(at(CANVAS_IDS.end(key)).page, key).toBe(pages);
      expect(at(CANVAS_IDS.table(key)).page, key).toBe(pages);
    }
    const texts = (page: number) => linesOfRuns(runs[page]).map((l) => l.text);
    const last = texts(pages - 1);
    for (const label of [AGING_CURRENT, FINANCE_LABEL, TOTAL_LABEL]) expect(last.some((t) => t.startsWith(label)), label).toBe(true);
    for (let page = 0; page < pages - 1; page++) {
      expect(texts(page).some((t) => t.startsWith(FINANCE_LABEL) || t.startsWith(TOTAL_LABEL)), `page ${page + 1}`).toBe(false);
    }
  }, 120_000);

  it("page line on: every page prints Page N of M, and no body run's bottom lies below the page line's top or the page's foot", async () => {
    // Red when the sheet leaves the page line no room (`assembleCanvasSheet`'s bottom margin without
    // PAGE_LINE_ROOM): the rows then run to the plain margin, past `pageFoot(true)` (the page line
    // moves down with the body under that mutation, so the foot is what sees it). The page line
    // prints at 8.5 pt (render.ts), so its top is at most its size above its baseline; a body run's
    // bottom is its baseline and its descender, under 0.3 of the base size.
    const { pages, runs } = await seededPaging(true);
    expect(pages).toBeGreaterThanOrEqual(2);
    for (let page = 0; page < pages; page++) {
      const where = `page ${page + 1}`;
      const pageLine = linesOfRuns(runs[page]).find((l) => l.text === `Page ${page + 1} of ${pages}`);
      expect(pageLine, where).toBeDefined();
      const lineTop = pageLine!.top - 8.5;
      const body = runs[page].filter((r) => !pageLine!.runs.includes(r));
      expect(body.length, where).toBeGreaterThan(0);
      for (const run of body) {
        const bottom = run.top + 0.3 * STATEMENT_DEFAULT_CONFIG.fonts.baseSize;
        expect(bottom, `${where}: ${run.text}`).toBeLessThan(lineTop);
        expect(bottom, `${where}: ${run.text}`).toBeLessThanOrEqual(pageFoot(true));
      }
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------
// The seed's refusals (design 2026-11-11 §5.3, §15; since statement canvas PR 2): the invoice's
// four in its order, with "statement" for "invoice" and the company address named where design §5.3
// names it a cause (open question 5's sentences), but that the identity's names the font and the
// labels alone, never the sizes, which the identity's lines do not read (the controller's
// correction, 2026-11-12): the page count after the render, the header's width, the identity's
// width, and the drawn stack's fit, each pinned whole. A case's premises (the
// stand-in's flow page count, the laid-out left that runs past the margin, the drawn bottom past the
// band) are asserted first on the seed's own layout, built from its exported pieces with no refusal
// run (`unjudged`). Each refusal stores and audits nothing.
// ---------------------------------------------------------------------------------------------

const PAGES_SENTENCE = (pages: number) =>
  `The canvas starts from a one-page statement; laid out at its least, this template's statement prints ${pages} pages. Change this template's settings (its font, sizes or logo) or the company address so it fits one page.`;
const HEADER_SENTENCE =
  "The canvas starts from a statement whose header fits the page; laid out at its least, this template's header runs past the page's right margin. Change this template's settings (its logo's width, font or heading size) so the header fits the page's width.";
const IDENTITY_SENTENCE =
  "The canvas starts from a statement whose identity lines and Remit To box fit the page; laid out at its least, this template's Remit To box runs past the page's right margin. Change this template's settings (its font or labels) so they fit the page's width.";
const FIT_SENTENCE =
  "The canvas starts from a one-page statement; laid out at its least on the canvas, this template's statement runs past one page. Change this template's settings (its font, sizes, logo or page line) or the company address so it fits one page.";

/** What a seed writes, were it to write: stored documents, audit rows, template versions, drafts. */
async function writes() {
  return [await prisma.storedDocument.count(), await prisma.auditLog.count(), await prisma.documentTemplateVersion.count(), await prisma.orderDraft.count()];
}

/** The seed's refusal for the picked customer: its class, its status and its whole sentence, with
 *  nothing stored or audited. */
async function expectRefusal(config: TemplateConfig, logo: string | undefined, sentence: string) {
  const before = await writes();
  let refusal: unknown = null;
  try { await seedStatementLayout(customerId, config, logo); } catch (err) { refusal = err; }
  expect(refusal, String(refusal)).toBeInstanceOf(HttpError);
  expect((refusal as HttpError).status).toBe(400);
  expect((refusal as HttpError).message).toBe(sentence);
  expect(await writes(), "a refusal stores and audits nothing").toEqual(before);
}

/** The seed's own pieces for `config`, with none of its refusals run: the stand-in's laid-out pass
 *  and its flow print's page count (each render from a fresh definition: pdfmake uses up the nodes it
 *  lays out), and, for a one-page pass, the seeded layout with its band's top and each item's drawn
 *  bottom. */
async function unjudged(config: TemplateConfig, logo?: string) {
  const pass = await laid(config, logo);
  const standIn = statementStandIn(await invoicePrintSettings(), customerId, formatDateOnly(todayDateOnly()));
  const flowPages = pageCount(await renderPdf(buildStatementDefinition(standIn, config, logo)));
  const layout: CanvasLayout = { version: 1, items: withRepeat(seedStatementItems(config, pass.positions, logo !== undefined)) };
  return {
    pass,
    flowPages,
    layout,
    band: bandTop(layout, config.pageFooter),
    bottom: (item: CanvasItem) => { const box = drawnBox(item, layout); return box.y + box.h; },
  };
}

/** A square logo: its printed height is its placed width (10 × 10 pixels). */
const SQUARE_LOGO = pngDataUri(alphaPng(10, 10));
/** A wide, short logo (64:1), so a header logo the content's width stays one short row. */
const WIDE_LOGO = pngDataUri(alphaPng(64, 1));
/** The flow's content runs to its bottom margin's top (752); the canvas's band starts 4 pt higher
 *  with the page line on (748, `pageFoot`). */
const FLOW_FOOT = PAGE_HEIGHT - STATEMENT_PAGE.bottomMargin;

/** The Standard stand-in's Total Due end with no logo: a header-centre square logo adds its height. */
async function totalEndWithoutLogo(pageFooter: boolean): Promise<number> {
  const config = cfg();
  config.pageFooter = pageFooter;
  return (await laid(config)).top(STATEMENT_SEED_IDS.end("total"));
}
/** The Standard with the page line on and a header-centre square logo `width` wide. */
function centreLogo(width: number, pageFooter = true): TemplateConfig {
  const config = cfg();
  config.pageFooter = pageFooter;
  config.logo = { placement: "header-center", width };
  return config;
}

describe("seedStatementLayout refuses only what the template's settings cause", () => {
  describe("sentence 1: the page count", () => {
    // Each trigger's premise: the stand-in's own flow print and the seed's laid-out pass are both two
    // pages. The first and the second fall, with the clause deleted, to the canvas sentence; the third
    // is accepted by the rules, so only the clause refuses it.
    const triggers: [string, () => Promise<[TemplateConfig, string | undefined]>][] = [
      ["a header-centre square logo the content's width (its height its 564 pt width)", async () => [centreLogo(SW.content, false), SQUARE_LOGO]],
      ["a company address of 45 lines", async () => {
        await setCompany(Array.from({ length: 45 }, (_, i) => `Line ${i + 1}`).join("\n"));
        return [cfg(), undefined];
      }],
      ["a header-centre square logo one point taller than leaves Total Due on page 1 (the page line on)", async () => {
        const width = FLOW_FOOT - (await totalEndWithoutLogo(true)) + 1;
        return [centreLogo(width), SQUARE_LOGO];
      }],
    ];
    it.each(triggers)("refused under %s, naming 2 pages", async (_why, make) => {
      const [config, logo] = await make();
      const pass = await laid(config, logo);
      expect(pass.pages, "the seed's laid-out pass").toBe(2);
      const standIn = statementStandIn(await invoicePrintSettings(), customerId, formatDateOnly(todayDateOnly()));
      expect(pageCount(await renderPdf(buildStatementDefinition(standIn, config, logo))), "the stand-in's flow print").toBe(2);
      await expectRefusal(config, logo, PAGES_SENTENCE(2));
    }, 60_000);
  });

  describe("sentence 2: the header past the page's right margin", () => {
    it.each(["header-left", "header-right"] as const)("a %s logo 564 pt wide, the schema's most, is refused in the header sentence", async (placement) => {
      const config = cfg();
      config.logo = { placement, width: SW.content };
      const u = await unjudged(config, WIDE_LOGO);
      expect(u.flowPages, "the stand-in prints one flow page").toBe(1);
      if (placement === "header-left") {
        // The title's and the company name's laid-out left: the margin, the logo and the gap, past 588.
        for (const key of ["title", "company_name"]) {
          const left = u.pass.at(STATEMENT_SEED_IDS.piece(key)).left;
          expect(Math.abs(left - (MARGIN + SW.content + SW.headerLogoGap)), key).toBeLessThanOrEqual(0.01);
          expect(left, key).toBeGreaterThan(CANVAS_PAGE.width - MARGIN);
        }
      }
      for (const key of ["title", "company_name"]) expect(fieldItem(u.layout, key)!.box.w, key).toBeLessThanOrEqual(0);
      for (const key of ["customer", "statement_date", "remit_to"]) expect(fieldItem(u.layout, key)!.box.w, key).toBeGreaterThan(0);
      await expectRefusal(config, WIDE_LOGO, HEADER_SENTENCE);
    }, 60_000);

    it("the width before the fit: a 564 pt header-left logo tall enough to draw Total Due past the band the page line leaves is refused in the header sentence, not the canvas one", async () => {
      const config = cfg();
      config.pageFooter = true;
      config.logo = { placement: "header-left", width: SW.content };
      // A 564 × h pixel logo placed 564 wide prints h tall, and the header's row, taller than its
      // centre column, is the logo's height: a 460 pt one is laid out first, and h is the whole height
      // that puts Total Due's drawn end 2 pt below the band's top, inside the flow's foot.
      const short = await unjudged(config, pngDataUri(alphaPng(SW.content, 460)));
      const height = Math.round(pageFootTop() + 2 - (short.bottom(block(short.layout, "total")) - 460));
      const logo = pngDataUri(alphaPng(SW.content, height));
      const u = await unjudged(config, logo);
      expect(u.bottom(block(u.layout, "total"))).toBeLessThanOrEqual(FLOW_FOOT);
      expect(u.flowPages, "the stand-in prints one flow page").toBe(1);
      expect(fieldItem(u.layout, "title")!.box.w).toBeLessThanOrEqual(0);
      expect(u.bottom(block(u.layout, "total")), "the drawn stack does not fit the canvas either").toBeGreaterThan(u.band);
      await expectRefusal(config, logo, HEADER_SENTENCE);
    }, 60_000);

    // (pin) A title pushed only part of the way seeds, clamped to the margin, as the invoice's and the
    // certification's do (the invoice's open question 11). No mutation of the seed's refusals reds it.
    it("a header-left logo 500 pt wide seeds, the title and company name clamped to the 56 pt left them (pin)", async () => {
      const config = cfg();
      config.logo = { placement: "header-left", width: 500 };
      const layout = await seed(config, WIDE_LOGO);
      for (const key of ["title", "company_name"]) {
        expect(fieldItem(layout, key)!.box, key).toMatchObject({ x: MARGIN + 500 + SW.headerLogoGap, w: CANVAS_PAGE.width - MARGIN - (MARGIN + 500 + SW.headerLogoGap) });
        expect(fieldItem(layout, key)!.box.w, key).toBe(56);
      }
    }, 60_000);
  });

  describe("sentence 3: the Remit To box past the page's right margin", () => {
    it("a Customer label of 100 unbroken W's pushes the Remit To box past the page's right margin, refused in the identity sentence", async () => {
      const config = cfg();
      fieldOf(config, "identity", "customer").label = "W".repeat(100);
      const u = await unjudged(config);
      expect(u.flowPages, "the stand-in prints one flow page").toBe(1);
      expect(u.pass.at(STATEMENT_SEED_IDS.piece("remit_to")).left, "the flow lays its Remit To box out past the right margin")
        .toBeGreaterThan(CANVAS_PAGE.width - MARGIN);
      expect(fieldItem(u.layout, "remit_to")!.box.w).toBeLessThanOrEqual(0);
      for (const key of ["title", "company_name", "customer", "statement_date"]) expect(fieldItem(u.layout, key)!.box.w, key).toBeGreaterThan(0);
      await expectRefusal(config, undefined, IDENTITY_SENTENCE);
    }, 60_000);

    it("the template's sizes neither cause nor cure it: the same Customer label is refused in the identity sentence at sizes 4 and 72, its Remit To box laid out at one left", async () => {
      // The identity row's nodes set their own sizes (pdf/statement.ts: the customer and statement
      // date lines 10 pt, the Bill To's 9 and 10, the Remit To's label 13), so the base, heading and
      // small sizes move neither the left column's "*" width nor the box; the sentence names the font
      // and the labels alone. Red when the customer line drops its own `fontSize: 10` (it then takes
      // the base size, and at 4 pt the label no longer pushes the box past the margin).
      const lefts: number[] = [];
      for (const size of [4, 72]) {
        const config = cfg();
        fieldOf(config, "identity", "customer").label = "W".repeat(100);
        config.fonts = { ...config.fonts, baseSize: size, headingSize: size, smallSize: size };
        const u = await unjudged(config);
        lefts.push(u.pass.at(STATEMENT_SEED_IDS.piece("remit_to")).left);
        expect(fieldItem(u.layout, "remit_to")!.box.w, `size ${size}`).toBeLessThanOrEqual(0);
        await expectRefusal(config, undefined, IDENTITY_SENTENCE);
      }
      expect(lefts[1]).toBe(lefts[0]);
      expect(lefts[0]).toBeGreaterThan(CANVAS_PAGE.width - MARGIN);
    }, 60_000);

    // (pin) No mutation of the seed's refusals reds it; it is red when the stand-in keeps the
    // picked customer's code and name.
    it("a picked customer whose name is one unbroken 200-character word seeds: the stand-in replaces it (pin)", async () => {
      const long = await prisma.customer.create({ data: { code: "LONG", name: "W".repeat(200) } });
      const layout = await seedStatementLayout(long.id, cfg(), undefined);
      expect(byContent(layout)).toEqual(byContent(await seed(cfg())));
    }, 60_000);
  });

  describe("sentence 4: one flow page that is not one canvas page", () => {
    it("a header-centre square logo drawing Total Due past the band the page line leaves is refused in the canvas sentence; with the page line off it seeds", async () => {
      // Its width puts Total Due's end 2 pt below the band's top (748), inside the flow's 752.
      const config = centreLogo(pageFootTop() + 2 - (await totalEndWithoutLogo(true)));
      const u = await unjudged(config, SQUARE_LOGO);
      expect(u.flowPages, "the stand-in prints one flow page").toBe(1);
      const total = block(u.layout, "total");
      expect(u.bottom(total)).toBeGreaterThan(u.band);
      expect(u.bottom(total)).toBeLessThanOrEqual(FLOW_FOOT);
      for (const item of u.layout.items) expect(item.box.w, item.kind).toBeGreaterThan(0);
      await expectRefusal(config, SQUARE_LOGO, FIT_SENTENCE);

      config.pageFooter = false;
      const layout = await seed(config, SQUARE_LOGO);
      const off = drawnBox(block(layout, "total"), layout);
      expect(off.y + off.h).toBeLessThan(bandTop(layout, false));
    }, 60_000);

    it("a drawn bottom one thousandth above the band's top is refused in the canvas sentence (the clearance); four thousandths above it seeds", async () => {
      const end = await totalEndWithoutLogo(true);
      // A logo width that draws Total Due's bottom at 747.999, which the rules accept: only the
      // clearance's two thousandths refuse it.
      const tight = centreLogo(pageFootTop() - 0.001 - end);
      const u = await unjudged(tight, SQUARE_LOGO);
      expect(u.flowPages).toBe(1);
      expect(Math.round(u.bottom(block(u.layout, "total")) * 1000)).toBe(Math.round(u.band * 1000) - 1);
      expect(() => validateCanvasLayout(u.layout, STATEMENT_CONTRACT, { pageFooter: true }), "the rules accept it").not.toThrow();
      await expectRefusal(tight, SQUARE_LOGO, FIT_SENTENCE);

      const clear = centreLogo(pageFootTop() - 0.004 - end);
      const layout = await seed(clear, SQUARE_LOGO);
      const box = drawnBox(block(layout, "total"), layout);
      expect(Math.round((box.y + box.h) * 1000)).toBeLessThanOrEqual(Math.round(bandTop(layout, true) * 1000) - FIT_CLEARANCE);
    }, 60_000);
  });

});

/** The band's top with the page line on and nothing in the band: the page's foot less the page
 *  line's room (748). */
function pageFootTop(): number {
  return bandTop({ version: 1, items: [] }, true);
}

/** The seed's residuals on the Standard in Roboto (design §4.4, §4.5, §15), measured when the seed
 *  was built and pinned to a hundredth (the predictions in brackets; the lane's task-8-report.md
 *  lists them): the header's
 *  height, the company name's piece bottom [not predicted]; the seeded customer box's top and bottom
 *  [73.016, 84.735]; the Remit To box's height and the stand-in's left column [64, 53.7], from the
 *  seed's layout pass; one open-item row [15.35], from that pass's marks; the repeat band, page 2's
 *  top read off a 300-item canvas print's first body line [89.235]; that print's page 1 higher than
 *  its flow print [16], from raw baselines; a continuation page's room with the page line off
 *  [678.765 against the flow's 712, 33.235 less] and on [about 53.2 less], each page 2's top read off
 *  the paper to its definition's bottom margin, the paper holding exactly the lines that fit under
 *  that margin (`CONTINUATION_LINES`), so the bottom is proven to a row, not to a hundredth; with the
 *  page line on, its line higher than the flow's [4: 756 against 760], from raw baselines. */
const STATEMENT_SEED_RESIDUALS: Record<string, number> = {
  headerHeight: 67.016, customerTop: 73.016, customerBottom: 84.735, repeatBand: 89.235, remitToHeight: 63.991,
  standInLeftColumn: 53.703, openItemRow: 15.347, pagedRise: 16, continuationRoomOff: 678.765,
  continuationRoomLessOff: 33.235, continuationRoomLessOn: 53.235, pageLineRiseOn: 4,
};
/** Page 2's body lines (the open items' heading row and rows, the page line left out) on a 300-item
 *  print, [canvas with the page line off, canvas with it on, flow]: measured. */
const CONTINUATION_LINES = [44, 42, 46];
/** "(continued)"'s rendered right edge in each face, at the canvas's 8 pt italic from the left margin
 *  (the invoice lane's measures, design §4.4, against the customer label at 64). */
const CONTINUED_RIGHT_EDGES: Record<string, number> = {
  Roboto: 63.609, "Liberation Sans": 64.023, "Liberation Serif": 60.875, "Roboto Mono": 75.648,
};
/** Roboto Mono's long-name miss (design §4.5) on richStatement's customer line, which wraps in the
 *  seeded 262 pt: the flow's statement date, Bill To and open items print this much lower than the
 *  canvas's, whose date prints under the wrapped line's "LLC" (2 pt apart): measured. */
const MONO_LONG_NAME_MISS = 13.188;
/** The customer-after-Bill-To residual (design §4.5), richStatement's four-line bill-to: measured. */
const LEFT_SLOT_RESIDUAL = 10.287;
/** The page counts at 100, 300 and 1,000 open items, [flow, canvas]: measured. */
const PAGE_COUNTS: Record<number, [number, number]> = { 100: [3, 3], 300: [8, 8], 1000: [23, 24] };

// ---------------------------------------------------------------------------------------------
// The preview's canvas half (design 2026-11-11 §5.2, §9; since statement canvas PR 2):
// `renderStatementCanvasPreview` renders a canvas statement once through `measuredPreview` and
// answers the Design tab's measure, a flow statement through `renderPdf` with none. These cases were
// written while STATEMENT stood outside CANVAS_PRINTS (the same PR later put it in, and the route's cases are
// tests/template-preview.test.ts's), so they call the function directly with a config built as
// `{ ...config, layout }` (the layout judged by `validateCanvasLayout`, not through `validateConfig`
// or `renderPreview`), and the data is `buildStatement`'s for a real customer, as
// the preview's STATEMENT arm builds it (no finance-charge assessment, the customer alone).
// ---------------------------------------------------------------------------------------------

/** The preview's data for `id`, as the STATEMENT arm builds it (today, the customer alone, no
 *  assessment). */
const previewData = (id: string) => buildStatement(id, { combineFamily: false, assessFinanceCharges: false });

/** The previewed canvas's warnings, by name: `canvasWarnings` over the preview's real measure. */
async function previewWarnings(data: StatementData, config: TemplateConfig, layout: CanvasLayout) {
  validateCanvasLayout(layout, STATEMENT_CONTRACT, { pageFooter: config.pageFooter });
  const { pdf, measure } = await renderStatementCanvasPreview(data, { ...config, layout }, undefined);
  expect(measure, "a canvas config answers a measure").not.toBeNull();
  const m: CanvasMeasure = measure!;
  const options = { pageFooter: config.pageFooter, fonts: config.fonts };
  return { pdf, measure: m, named: namedWarnings(layout, canvasWarnings(layout, STATEMENT_CONTRACT, m, options)) };
}

/** A Text item `y` below Total Due, 200 wide and one line drawn, of `text`. */
const belowTotal = (text: string, y = 2 * CANVAS_GRID): CanvasItem => ({
  id: "below-total", kind: "text", text, box: { x: MARGIN, y, w: 200, h: 12 },
  anchor: { kind: "below-table", table: "total" }, repeat: false, style: { size: 9, bold: false, align: "left" },
});
const withItem = (layout: CanvasLayout, item: CanvasItem): CanvasLayout => ({ ...layout, items: [...layout.items, item] });

/** The (e) warning the seeded Standard draws on the repeated customer line (owner ruling, call 2):
 *  "(continued)" prints at the repeat band's bottom-left, where the customer line repeats. */
const CUSTOMER_CONTINUED = {
  items: ["customer"],
  sentence: 'The Customer field repeats where "(continued)" prints on continuation pages, at the repeat band\'s ' +
    "bottom-left; the two print over each other.",
};
/** The seeded Standard's warnings, previewed for the customer it was seeded for: measured, for the
 *  controller to accept or rule on (the composed case below). */
const STATEMENT_ACCEPTED_WARNINGS = [CUSTOMER_CONTINUED];
type Named = { items: string[]; sentence: string };
/** The wrapped customer line's warnings, measured: the line printed taller than drawn (b) also runs
 *  into the statement date drawn under it (a), beside the accepted set; (a) is listed first, as
 *  `canvasWarnings` lists its families. */
const WRAPPED_CUSTOMER_WARNINGS = (taller: Named): Named[] => [
  { items: ["customer", "statement_date"], sentence: "The Customer field and the Statement date field overlap; one prints over the other." },
  taller, ...STATEMENT_ACCEPTED_WARNINGS,
];
/** The taller Remit To box's warnings, measured: the box printed taller than drawn (b) also runs into
 *  the open items, which start under its drawn bottom (the Bill To holds the drawn height) (a). */
const TALLER_REMIT_TO_WARNINGS = (taller: Named): Named[] => [
  { items: ["remit_to", "open_items"], sentence: "The Remit-to box field and the Open items table overlap; one prints over the other." },
  taller, ...STATEMENT_ACCEPTED_WARNINGS,
];

describe("renderStatementCanvasPreview", () => {
  beforeEach(async () => {
    await finalizedInvoice(customerId, { total: 250, dueDate: daysBack(40) });
  });

  it("a canvas config's measure holds the five blocks, the empty finance block at 0 pt, one region a block, the Bill To at its drawn height over shorter content, and every item with a height", async () => {
    const layout = await seed(cfg());
    const data = await previewData(customerId);
    // The premises: no finance line (the preview never assesses), and a one-line bill-to, shorter
    // than the Remit To box the Bill To block is drawn beside.
    expect(data.financeCharge).toBeNull();
    expect(data.customer.billTo).toHaveLength(1);
    const { pdf, measure } = await renderStatementCanvasPreview(data, { ...cfg(), layout }, undefined);
    expect(measure).not.toBeNull();
    const m = measure!;
    expect(pageCount(pdf)).toBe(1);
    expect(m.pages).toBe(1);
    expect(m.tables.map((t) => t.key)).toEqual(BLOCKS);
    // One region a block, exactly: a spare region reds here (the invoice PR 3 lesson).
    const drawn = regionHeights(layout);
    expect(m.regions).toHaveLength(tablesByY(layout).length);
    for (const [i, table] of m.tables.entries()) {
      expect(table.page, table.key).toBe(1);
      expect(m.regions[i]).toMatchObject({ after: table.key, page: 1, height: drawn[i].height });
    }
    const finance = m.tables.find((t) => t.key === "finance_charge")!;
    expect(Math.abs(finance.height), "the finance block prints nothing").toBeLessThanOrEqual(0.01);
    // The Bill To holds its drawn height (`holdsHeight`): its one line is shorter than the box.
    const billTo = block(layout, "bill_to");
    const measuredBillTo = m.tables.find((t) => t.key === "bill_to")!;
    expect(Math.abs(measuredBillTo.top - billTo.box.y)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(measuredBillTo.height - billTo.box.h)).toBeLessThanOrEqual(0.01);
    for (const t of m.tables.filter((t) => t.key !== "finance_charge")) expect(t.height, t.key).toBeGreaterThan(0);
    for (const item of layout.items.filter((i) => i.kind !== "table")) {
      const entry = m.items.find((candidate) => candidate.id === item.id);
      expect(entry, item.id).toBeDefined();
      expect(entry!.height, item.id).toBeGreaterThan(0);
      expect(entry, item.id).toMatchObject({ page: 1, left: item.box.x, top: item.box.y });
    }
  }, 60_000);

  // (pin) The task's mutation (a canvas config rendered bare) leaves a flow config as it is; it reds
  // when the null-layout branch is dropped (the flow config then reaches `statementCanvasItemContent`,
  // which throws).
  it("a flow config's preview answers no measure, and its text is today's flow render (pin)", async () => {
    const data = await previewData(customerId);
    const { pdf, measure } = await renderStatementCanvasPreview(data, cfg(), undefined);
    expect(measure).toBeNull();
    expect(textRunsWithY(pdf)).toEqual(textRunsWithY(await renderPdf(buildStatementDefinition(data, cfg()))));
  }, 60_000);

  it("composed: the seeded Standard, previewed for the customer it was seeded for, warns of the accepted set, warning (e) on the customer among it", async () => {
    const layout = await seed(cfg());
    const { measure, named } = await previewWarnings(await previewData(customerId), cfg(), layout);
    expect(named).toContainEqual(CUSTOMER_CONTINUED);
    expect(named).toEqual(STATEMENT_ACCEPTED_WARNINGS);
    const ids = new Set(measure.items.map((item) => item.id));
    expect(layout.items.filter((item) => item.kind !== "table" && !ids.has(item.id))).toEqual([]);
  }, 60_000);

  it("warning (b) on the customer: a picked customer whose name wraps in the seeded line width is warned taller than drawn", async () => {
    const layout = await seed(cfg());
    const customer = fieldItem(layout, "customer")!;
    expect(customer.box.w).toBe(LINE_WIDTH);
    // The neighbour first: the seeded customer's own name fits its line, and the set is the accepted one.
    const short = await previewWarnings(await previewData(customerId), cfg(), layout);
    expect(short.named).toEqual(STATEMENT_ACCEPTED_WARNINGS);

    const long = await makeCustomer({ name: "Statement Print Customer With A Long Registered Trading Name, LLC" });
    await finalizedInvoice(long.id, { total: 250, dueDate: daysBack(40) });
    const { measure, named } = await previewWarnings(await previewData(long.id), cfg(), layout);
    const printed = measure.items.find((entry) => entry.id === customer.id)!.height;
    // The premise: the line wraps, two lines where the seed drew one.
    expect(printed).toBeGreaterThan(1.5 * customer.box.h);
    const taller = {
      items: ["customer"],
      sentence: `The Customer field is taller than its box by ${Math.round((printed - customer.box.h) * 100) / 100} pt and prints over what is drawn under it.`,
    };
    expect(named).toContainEqual(taller);
    expect(named).toEqual(WRAPPED_CUSTOMER_WARNINGS(taller));
  }, 60_000);

  it("warning (b) on the Remit To box: previewed under one more company address line than the seed drew, it is warned taller than drawn", async () => {
    const layout = await seed(cfg());
    const remitTo = fieldItem(layout, "remit_to")!;
    // The neighbour first: under the seed's own two-line address the set is the accepted one.
    const before = await previewData(customerId);
    const same = await previewWarnings(before, cfg(), layout);
    expect(same.named).toEqual(STATEMENT_ACCEPTED_WARNINGS);

    await setCompany(THREE_LINES);
    const data = await previewData(customerId);
    // The premise: the Remit To box prints one line more than the seed drew it for.
    expect(data.remitTo.lines).toHaveLength(before.remitTo.lines.length + 1);
    const { measure, named } = await previewWarnings(data, cfg(), layout);
    const printed = measure.items.find((entry) => entry.id === remitTo.id)!.height;
    expect(printed).toBeGreaterThan(remitTo.box.h);
    const taller = {
      items: ["remit_to"],
      sentence: `The Remit-to box field is taller than its box by ${Math.round((printed - remitTo.box.h) * 100) / 100} pt and prints over what is drawn under it.`,
    };
    expect(named).toContainEqual(taller);
    expect(named).toEqual(TALLER_REMIT_TO_WARNINGS(taller));
  }, 60_000);

  it("the measured warning (c): a Text item below Total Due whose measured bottom runs past the page's foot would be cut off", async () => {
    const seeded = await seed(cfg());
    const data = await previewData(customerId);
    const foot = bandTop(seeded, false);
    // The neighbour first: a text that grows past its drawn line but ends above the foot is warned
    // taller than drawn and nothing else.
    const shorter = withItem(seeded, belowTotal("Thank you for your business. ".repeat(12).trim()));
    const grows = await previewWarnings(data, cfg(), shorter);
    const grown = grows.measure.items.find((entry) => entry.id === "below-total")!;
    expect(grown.top + grown.height).toBeLessThan(foot);
    expect(grows.named.map((w) => w.items)).toEqual([["text"], ...STATEMENT_ACCEPTED_WARNINGS.map((w) => w.items)]);
    expect(grows.named[0].sentence).toContain("is taller than its box");

    const layout = withItem(seeded, belowTotal("Thank you for your business. ".repeat(110).trim()));
    const { measure, named } = await previewWarnings(data, cfg(), layout);
    const entry = measure.items.find((candidate) => candidate.id === "below-total")!;
    const region = measure.regions.find((r) => r.after === "total")!;
    expect(entry.page).toBe(region.page);
    const bottom = Math.round((entry.top + entry.height) * 100) / 100;
    expect(bottom).toBeGreaterThan(foot);
    const cut = { items: ["text"], sentence: `The Text (text) ends at ${bottom} pt, past ${foot}, and would be cut off.` };
    expect(named).toContainEqual(cut);
    expect(named.map((w) => w.items)).toEqual([["text"], ["text"], ...STATEMENT_ACCEPTED_WARNINGS.map((w) => w.items)]);
    expect(named[0].sentence).toContain("is taller than its box");
  }, 60_000);

  it("a page-2 item: the seeded Standard with a Text item below Total Due, previewed for a 300-item customer, is measured and staged on the page it laid out on, and warns of the accepted set", async () => {
    const big = await makeCustomer();
    await bulkOpenItems(big.id, 300);
    const seeded = await seed(cfg());
    expect(seeded.items.some((i) => i.kind !== "table" && i.anchor.kind === "below-table")).toBe(false);
    const added = belowTotal("Thank you for your business");
    const layout = withItem(seeded, added);
    const { pdf, measure, named } = await previewWarnings(await previewData(big.id), cfg(), layout);
    expect(measure.pages).toBeGreaterThanOrEqual(2);
    expect(pageCount(pdf)).toBe(measure.pages);
    const total = measure.tables.find((t) => t.key === "total")!;
    expect(total.page).toBeGreaterThan(1);
    const entry = measure.items.find((item) => item.id === added.id)!;
    expect(entry.page).toBe(measure.regions.find((r) => r.after === "total")!.page);
    expect(entry.page).toBeGreaterThan(1);
    const staged = stageBox(added, layout, measure);
    expect(staged.page).toBe(entry.page);
    expect(staged.measured).toBe(true);
    // Its staged box is its drawn box below Total Due's region, as tall as drawn or as measured
    // (red when stageBox's below-table arm drops the region's top).
    const totalRegion = measure.regions.find((r) => r.after === "total")!;
    expect(staged.box).toEqual({ ...added.box, y: totalRegion.top + added.box.y, h: Math.max(added.box.h, entry.height) });
    // The stage draws an item on another page dashed at its drawn box, and a drag starts there.
    expect(dragStart(added, layout, measure)).toEqual(drawnBox(added, layout));
    expect(stageBox(fieldItem(layout, "remit_to")!, layout, measure).page).toBe(1);
    // The accepted set: no (c) for a region that moved whole and fits.
    expect(named).toEqual(STATEMENT_ACCEPTED_WARNINGS);
  }, 120_000);
});

describe("the seed meets the raised least widths (#971)", () => {
  it("draws every table at or above its floor from the standard config", async () => {
    const layout = await seedStatementLayout(customerId, cfg(), undefined);
    const tables = layout.items.filter((i) => i.kind === "table");
    expect(tables.map((t) => (t.kind === "table" ? t.key : "")).sort()).toEqual(["aging", "bill_to", "finance_charge", "open_items", "total"]);
    for (const item of tables) {
      expect(item.box.w, item.id).toBeGreaterThanOrEqual(leastWidth(STATEMENT_CONTRACT, item, { fonts: cfg().fonts, layout }));
    }
  });
  it("refuses, as a 400 in rule 9's sentence, an aging strip whose typed columns and their padding and rules pass the page", async () => {
    // Six of the seven columns typed 83 (498, inside the flow's budget): with the strip's 62.4 pt of
    // padding and rules and one grid step, 564.9.
    const wide = cfg();
    for (const field of section(wide, "aging").fields.slice(0, 6)) field.width = 83;
    await expectRefusal(wide, undefined,
      "The Aging strip table needs 564.9 pt: its visible columns' 498 pt, their 62.4 pt of padding and rules and one grid " +
      "step, more than its 564 pt.");
  });
});
