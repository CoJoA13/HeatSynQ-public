import { describe, it, expect, beforeEach } from "vitest";
import type { Content } from "pdfmake/interfaces";
import { prisma, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import {
  QUOTE_FLOW, QUOTE_PAGE, QUOTE_SEED_IDS, QUOTE_WIDTHS, buildQuoteDefinition, quoteSeedStyle, type QuotePdfData,
} from "@/server/pdf/quote";
import { layOutSheetGroups, pngDataUri, renderPdf, renderSheetGroupsWithPositions, type LaidOutNode } from "@/server/pdf/render";
import { CANVAS_IDS } from "@/server/pdf/canvas-sheet";
import { mark } from "@/server/pdf/canvas-nodes";
import {
  FIT_CLEARANCE, QUOTE_STAND_IN, gridDiffers, quoteStandIn, seedQuoteItems, seedQuoteLayout, withRepeat,
} from "@/server/quote-canvas-seed";
import { deleteQuote, quotePrintSettings, readQuotePdfData } from "@/server/quotes";
import { setSetting } from "@/server/settings";
import { renderQuoteCanvasPreview } from "@/server/template-preview";
import { HttpError } from "@/server/errors";
import {
  bandTop, canvasProfile, canvasWarnings, continuedBox, drawnBox, leastWidth, pageFoot, regionHeights, tablesByY, topMargin,
  validateCanvasLayout,
  type CanvasMeasure,
} from "@/lib/template-canvas";
import { DESIGNER_WORDS, dragStart, printsNothing, stageBox } from "@/lib/canvas-designer";
import { QUOTE_CONTRACT, QUOTE_ROW_FLOOR } from "@/lib/template-contracts/quote";
import { FONT_FAMILIES, QUOTE_DEFAULT_CONFIG, validateConfig, type TemplateConfig } from "@/lib/template-contracts/index";
import { completeSections } from "@/lib/template-contracts/types";
import { CANVAS_GRID, CANVAS_PAGE, type CanvasItem, type CanvasLayout } from "@/lib/template-contracts/canvas";
import { alphaPng, pageCount, paintedImages, strokedLines, textRunsWithY, tinyAlphaPng } from "./helpers/pdf";
import { namedWarnings } from "./helpers/named-warnings";
import { expectSameQuote } from "./helpers/quote-canvas-compare";
import { runsPerPage } from "./helpers/canvas-paper-dump";
import { quoteField, quoteLines, quoteTable, richQuote, sampleQuote } from "./helpers/quote-canvas-fixtures";
import { makeBillTo, makeCustomer, quoteFor } from "./helpers/quote-print-fixtures";

/**
 * The quotation's canvas SEED (design 2026-11-12 §5.3; since quote canvas PR 2): `seedQuoteLayout`
 * lays the submitted flow config out once for a stand-in quote and answers a `CanvasLayout`. Its
 * acceptance is the golden case, which prints one quote under the flow config and under that config
 * carrying the seeded layout and compares the two papers (`expectSameQuote`). These cases were written
 * while QUOTE stood outside CANVAS_PRINTS (the same PR later put it in; the route's own cases are
 * tests/template-canvas-seed.test.ts's), so they call `seedQuoteLayout` directly, judge its answer
 * with `validateCanvasLayout`, and print both papers in memory through `renderPdf`, the canvas's config
 * built as `{ ...config, layout }`, never through `validateConfig`. The picked record is a real quote
 * (the seed reads its number and dates); the paper compared carries the settings' company block
 * (`quotePrintSettings`) and the config's own wordings, so the seed and the print read one company and
 * one intro and liability.
 */

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const PAGE_HEIGHT = CANVAS_PAGE.height;
const MARGIN = CANVAS_PAGE.margin;
const COMPANY = "Example Supplier Inc.";
const ONE_LINE = "600 Example Street";
const TWO_LINES = "600 Example Street\nCrystal Lake IL 60014";
const BLOCKS = ["parties", "intro", "column_header", "lines", "closing", "liability"];
const SECTIONS = ["header", ...BLOCKS];
const HEADER_FIELDS = ["title", "company_name", "company_address", "quote_number"];
/** The template's typed liability wording, the one golden 2 and the reorders type. */
const LIABILITY = "Our liability is limited to the value of the services performed on the parts.";
/** The header's centre column on the Standard (208): the content less its two side columns and gaps. */
const CENTRE_W = QUOTE_WIDTHS.content - 2 * QUOTE_WIDTHS.headerSide - 2 * QUOTE_WIDTHS.headerGap;
/** The header's centre column's left on the Standard (202): the margin, the left column and its gap. */
const CENTRE_X = MARGIN + QUOTE_WIDTHS.headerSide + QUOTE_WIDTHS.headerGap;
/** The page's right margin (588). */
const RIGHT_EDGE = CANVAS_PAGE.width - MARGIN;
/** The header's right column's left on the Standard (418): the right margin less that column. */
const NUMBER_X = RIGHT_EDGE - QUOTE_WIDTHS.headerSide;
const LOGO = pngDataUri(tinyAlphaPng());

async function setCompany(address: string) {
  await setSetting("company_name", COMPANY);
  await setSetting("company_address", address);
  await setSetting("company_phone", "312.555.0100");
}

/** The Standard, its sections complete. */
const cfg = (): TemplateConfig => {
  const c = structuredClone(QUOTE_DEFAULT_CONFIG);
  c.sections = completeSections(QUOTE_CONTRACT, c.sections);
  return c;
};
/** The Standard with the liability wording typed. */
const typed = (): TemplateConfig => {
  const c = cfg();
  c.textBlocks.quote_liability_text = LIABILITY;
  return c;
};
const section = (c: TemplateConfig, key: string) => c.sections.find((s) => s.key === key)!;
const fieldOf = (c: TemplateConfig, sectionKey: string, key: string) => section(c, sectionKey).fields.find((f) => f.key === key)!;
/** Moves section `key` to just after section `after` (to the front when `after` is null). */
function moveSectionAfter(c: TemplateConfig, key: string, after: string | null): void {
  const [moved] = c.sections.splice(c.sections.findIndex((s) => s.key === key), 1);
  c.sections.splice(after === null ? 0 : c.sections.findIndex((s) => s.key === after) + 1, 0, moved);
}
/** Orders a section's fields `order` (every key the section holds). */
function fieldOrder(c: TemplateConfig, sectionKey: string, order: string[]): void {
  const s = section(c, sectionKey);
  const byKey = new Map(s.fields.map((f) => [f.key, f]));
  expect([...order].sort()).toEqual([...byKey.keys()].sort());
  s.fields = order.map((k) => byKey.get(k)!);
}

let quoteId = "";
beforeEach(async () => {
  await truncateAll();
  await setCompany(TWO_LINES);
  const customer = await makeCustomer();
  await makeBillTo(customer.id);
  quoteId = (await quoteFor(customer)).id;
});

/** The seed for the picked quote, its answer judged by the canvas rules first. */
async function seed(config: TemplateConfig, logo?: string, id = quoteId): Promise<CanvasLayout> {
  const layout = await seedQuoteLayout(id, config, logo);
  validateCanvasLayout(layout, QUOTE_CONTRACT, { pageFooter: config.pageFooter });
  return layout;
}

/** The stand-in the seed lays out for the picked quote under `config`. */
async function standIn(config: TemplateConfig): Promise<QuotePdfData> {
  const settings = await quotePrintSettings();
  return quoteStandIn(settings, await readQuotePdfData(prisma, quoteId, settings), config);
}

/** `richQuote` with the settings' company and `config`'s two wordings, as `printQuote` binds them. */
async function rich(config: TemplateConfig, over: Partial<QuotePdfData> = {}): Promise<QuotePdfData> {
  const s = await quotePrintSettings();
  return richQuote({
    company: s.company, introText: config.textBlocks.quote_intro_text,
    liabilityText: config.textBlocks.quote_liability_text, ...over,
  });
}

/** The flow's and the canvas's papers for `data` under `config`, in memory. */
async function papers(data: QuotePdfData, config: TemplateConfig, layout: CanvasLayout, logo?: string) {
  validateCanvasLayout(layout, QUOTE_CONTRACT, { pageFooter: config.pageFooter });
  const flow = await renderPdf(buildQuoteDefinition(data, config, logo));
  const canvas = await renderPdf(buildQuoteDefinition(data, { ...config, layout }, logo));
  return { flow, canvas };
}

/** `papers`, the flow's paper on ONE page first (a paging canvas prints page 1 16 pt higher than its
 *  flow, design §4.4), then compared. */
async function golden(data: QuotePdfData, config: TemplateConfig, layout: CanvasLayout, logo?: string) {
  const p = await papers(data, config, layout, logo);
  expectSameQuote(p.flow, p.canvas, { pages: 1 });
  return p;
}

/** The seed's own layout pass of the stand-in (`quoteStandIn` for the picked quote): the seed ids'
 *  positions. */
async function laid(config: TemplateConfig, logo?: string) {
  const { groups } = await renderSheetGroupsWithPositions([
    buildQuoteDefinition(await standIn(config), config, logo, { seedIds: true }),
  ]);
  const at = (id: string): LaidOutNode => {
    const node = groups[0].positions.find((n) => n.id === id);
    if (node === undefined) throw new Error(`no laid-out node "${id}"`);
    return node;
  };
  return { pages: groups[0].pages, positions: groups[0].positions, at, top: (id: string) => at(id).top };
}

type FieldItem = Extract<CanvasItem, { kind: "field" }>;
type TableItem = Extract<CanvasItem, { kind: "table" }>;
const fields = (layout: CanvasLayout) => layout.items.filter((i): i is FieldItem => i.kind === "field");
const fieldItem = (layout: CanvasLayout, key: string) => fields(layout).find((i) => i.key === key);
const block = (layout: CanvasLayout, key: string): TableItem => {
  const found = layout.items.find((i): i is TableItem => i.kind === "table" && i.key === key);
  if (found === undefined) throw new Error(`no ${key} block`);
  return found;
};
const hasBlock = (layout: CanvasLayout, key: string) => layout.items.some((i) => i.kind === "table" && i.key === key);
/** The layout's items with their ids blanked, for comparing two seeds by content. */
const byContent = (layout: CanvasLayout) => layout.items.map((item) => ({ ...item, id: "" }));

type RawRun = { text: string; x: number; y: number };
/** A page's printed lines top to bottom: runs grouped by RAW baseline (within 0.3 pt of the line's
 *  first run), each with its topmost run's raw baseline from the page's top and its leftmost x. The
 *  grouping reads the text alone; every position compared is a run's own raw figure. */
function rawLines(pdf: Buffer, page: number): { text: string; top: number; x: number; runs: RawRun[] }[] {
  const lines: RawRun[][] = [];
  for (const run of [...textRunsWithY(pdf)[page]].filter((r) => r.text.trim() !== "").sort((a, b) => b.y - a.y || a.x - b.x)) {
    const line = lines[lines.length - 1];
    if (line !== undefined && Math.abs(line[0].y - run.y) <= 0.3) line.push(run);
    else lines.push([run]);
  }
  return lines.map((line) => {
    const runs = line.sort((a, b) => a.x - b.x);
    return {
      text: runs.map((r) => r.text).join(" ").replace(/\s+/g, " ").trim(),
      top: PAGE_HEIGHT - Math.max(...runs.map((r) => r.y)), x: runs[0].x, runs,
    };
  });
}
const lineTop = (pdf: Buffer, page: number, starts: string) => {
  const line = rawLines(pdf, page).find((l) => l.text.startsWith(starts));
  if (line === undefined) throw new Error(`no line starting "${starts}" on page ${page + 1}`);
  return line.top;
};

/** `nodes` laid out alone, every margin kept, in a column `w` wide: their height. */
async function aloneHeight(nodes: Content[], w: number, config: TemplateConfig = cfg()): Promise<number> {
  const [laidOut] = await layOutSheetGroups([{
    pageSize: "LETTER", pageMargins: [MARGIN, MARGIN, CANVAS_PAGE.width - MARGIN - w, MARGIN],
    defaultStyle: { font: config.fonts.family, fontSize: config.fonts.baseSize },
    content: [{ stack: [mark("alone:a"), ...(JSON.parse(JSON.stringify(nodes)) as Content[]), mark("alone:b")] }],
  }]);
  const top = (id: string) => laidOut.find((n) => n.id === id)!.top;
  return top("alone:b") - top("alone:a");
}

const ctxFor = (config: TemplateConfig) => QUOTE_FLOW.ctxOf(config, completeSections(QUOTE_CONTRACT, config.sections), null);

describe("seedQuoteLayout (design 2026-11-12 §5.3)", () => {
  it("answers a layout validateCanvasLayout accepts: the six blocks stacked, the header page-top, nothing in the band, the number repeating", async () => {
    // Red with the row-floor clamp dropped (the blank liability, laid out 0 tall, is refused by rule
    // 4), and with `withRepeat` never flagging.
    const layout = await seedQuoteLayout(quoteId, cfg(), undefined);
    expect(() => validateCanvasLayout(layout, QUOTE_CONTRACT, { pageFooter: true })).not.toThrow();
    expect(tablesByY(layout).map((t) => t.key)).toEqual(BLOCKS);
    expect(fields(layout).map((f) => [f.key, f.anchor.kind])).toEqual(HEADER_FIELDS.map((k) => [k, "page-top"]));
    expect(layout.items.filter((i) => i.kind !== "table" && i.anchor.kind === "page-bottom")).toEqual([]);
    expect(layout.items.filter((i) => i.repeat).map((i) => (i.kind === "field" ? i.key : i.kind))).toEqual(["quote_number"]);
    // The header's widths: the centre pieces the centre column's, the number its side column's.
    for (const key of ["title", "company_name", "company_address"]) expect(fieldItem(layout, key)!.box).toMatchObject({ x: CENTRE_X, w: CENTRE_W });
    expect(fieldItem(layout, "quote_number")!.box).toMatchObject({ x: NUMBER_X, w: QUOTE_WIDTHS.headerSide });
    for (const t of tablesByY(layout)) expect(t.box).toMatchObject({ x: MARGIN, w: QUOTE_WIDTHS.content });
  }, 60_000);

  it("golden 1, the stand-in's shape: the Standard's seed prints the stand-in where the flow prints it, on one page", async () => {
    // The Standard, no logo, the page line on, a two-line company address; the data is the stand-in
    // itself (the picked quote's number and dates, every other piece a placeholder). Red with the
    // lines marked through `seedSection` (its throw on several nodes), and with `quoteSeedStyle`
    // answering the number bold (the per-run font check).
    const config = cfg();
    expect(config.pageFooter).toBe(true);
    const layout = await seed(config);
    await golden(await standIn(config), config, layout);
  }, 60_000);

  it("golden 1's boxes are the flow's marks: each header item's box and each block's top within 0.5 pt (pin)", async () => {
    // Circular: the seed reads these very marks, so this pins the reading, not the paper
    // (`expectSameQuote` is the check).
    const config = cfg();
    const layout = await seed(config);
    const marks = await laid(config);
    for (const key of HEADER_FIELDS) {
      const item = fieldItem(layout, key)!;
      const piece = marks.at(QUOTE_SEED_IDS.piece(key));
      expect(Math.abs(item.box.x - piece.left), `${key} x`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(item.box.y - piece.top), `${key} y`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(item.box.y + item.box.h - marks.top(QUOTE_SEED_IDS.end(key))), `${key} bottom`).toBeLessThanOrEqual(0.5);
    }
    for (const key of BLOCKS) {
      expect(Math.abs(block(layout, key).box.y - marks.top(QUOTE_SEED_IDS.start(key))), `${key} top`).toBeLessThanOrEqual(0.5);
    }
  }, 60_000);

  it("golden 2, a real quote: the seed prints richQuote, its liability typed, where the flow prints it, on one page", async () => {
    // Red when `blockChildren` zeroes the liability's kept 10 pt (the liability's line prints 10 pt
    // higher), and when the liability is marked through `seedSection` (its start mark 10 pt low).
    const config = typed();
    const layout = await seed(config);
    const data = await rich(config);
    expect(data.liabilityText).toBe(LIABILITY);
    const { flow } = await golden(data, config, layout);
    expect(rawLines(flow, 0).some((l) => l.text.startsWith("Our liability"))).toBe(true);
  }, 60_000);

  it("golden 3, the blank liability (the Standard's): nothing prints after the closing, on the flow's one page", async () => {
    // Red when `blockChildren`'s liability arm answers a kept-margin empty node on blank wording
    // ([{ text: "", margin: [0, 10, 0, 0] }]): the liability block then prints a line's height.
    const config = cfg();
    expect(config.textBlocks.quote_liability_text).toBe("");
    const layout = await seed(config);
    const data = await rich(config);
    const { flow, canvas } = await golden(data, config, layout);
    expect(pageCount(canvas)).toBe(pageCount(flow));
    const { groups } = await renderSheetGroupsWithPositions([buildQuoteDefinition(data, { ...config, layout })]);
    const top = (id: string) => groups[0].positions.find((n) => n.id === id)!.top;
    expect(Math.abs(top(CANVAS_IDS.end("liability")) - top(CANVAS_IDS.regionEnd("closing")))).toBeLessThanOrEqual(0.01);
    const body = rawLines(canvas, 0).filter((l) => !l.text.startsWith("Page:"));
    expect(body[body.length - 1].text).toBe(data.signer.title);
  }, 60_000);

  describe("no blank last page (design call 4, §4.5)", () => {
    it.each(FONT_FAMILIES)("%s: the seeded liability is drawn exactly at the closing's drawn bottom, and no region follows either", async (family) => {
      // Red with the liability seeded a grid step below the closing.
      const config = cfg();
      config.fonts.family = family;
      const layout = await seed(config);
      const closing = block(layout, "closing");
      expect(block(layout, "liability").box.y).toBe(closing.box.y + closing.box.h);
      const regions = new Map(regionHeights(layout).map((r) => [r.after, r.height]));
      expect(regions.get("closing")).toBe(0);
      expect(regions.get("liability")).toBe(0);
    }, 60_000);

    it("a quote whose closing ends within a grid step of the canvas's foot prints the flow's page count, its last page holding a body run", async () => {
      // The seeded Standard (blank liability, page line on). A sweep over the line count and the
      // notes' length finds the print, asserted first, never assumed. Red with the liability seeded a
      // grid step below the closing: its 9 pt region does not fit under the closing and starts a page.
      const config = cfg();
      const layout = await seed(config);
      const foot = pageFoot(true);
      let found: { data: QuotePdfData; gap: number; n: number; k: number } | null = null;
      for (let n = 1; n <= 8 && found === null; n++) {
        for (let k = 0; k <= 10 && found === null; k++) {
          const data = await rich(config, {
            lines: quoteLines(n), notes: Array.from({ length: k }, (_, i) => `Note line ${i + 1}`).join("\n"),
          });
          const { groups } = await renderSheetGroupsWithPositions([buildQuoteDefinition(data, { ...config, layout })]);
          const end = groups[0].positions.find((p) => p.id === CANVAS_IDS.end("closing"))!;
          if (end.page !== 1) break;
          const gap = foot - end.top;
          if (gap >= 0 && gap < CANVAS_GRID) found = { data, gap, n, k };
        }
      }
      expect(found, "a print whose closing ends within a grid step of the foot").not.toBeNull();
      console.log("near the foot", JSON.stringify({ lines: found!.n, notes: found!.k, gap: found!.gap }));
      const { flow, canvas } = await papers(found!.data, config, layout);
      expect(pageCount(flow)).toBe(1);
      expect(pageCount(canvas)).toBe(pageCount(flow));
      const last = rawLines(canvas, pageCount(canvas) - 1).filter((l) => !l.text.startsWith("Page:"));
      expect(last.length).toBeGreaterThan(0);
    }, 120_000);
  });

  describe("the seeded Standard pages (Review Focus 3)", () => {
    // The seed of the 1-line picked quote, the liability typed so it prints, then a long quote printed
    // under it. Red with `withRepeat` answering its items unflagged (no number on a continuation
    // page), and with PAGE_LINE_ROOM dropped from the sheet's bottom margin (page line on: the page
    // line moves down with the body, which then runs past the foot the bound below checks).
    it.each([[40, false], [40, true], [200, false], [200, true]] as const)("%i lines, page line %s: every continuation page names the quote where it is drawn, and the body clears the page line", async (n, pageFooter) => {
      const config = typed();
      config.pageFooter = pageFooter;
      const layout = await seed(config);
      const data = await rich(config, { lines: quoteLines(n) });
      const canvas = await renderPdf(buildQuoteDefinition(data, { ...config, layout }));
      const pages = pageCount(canvas);
      expect(pages).toBeGreaterThanOrEqual(2);
      const number = fieldItem(layout, "quote_number")!;
      expect(number.repeat).toBe(true);
      // The number's label run (the title "Quotation" prints in the centre column, left of 300); on a
      // continuation page "(continued)" prints on the number's baseline, so the two are read as runs.
      const numberRun = (page: number) => textRunsWithY(canvas)[page].find((r) => r.text.startsWith("Quotation") && r.x > 300);
      const first = numberRun(0)!;
      expect(Math.abs(first.x - number.box.x)).toBeLessThanOrEqual(0.5);
      const continued = continuedBox(layout)!;
      expect(continued.x + continued.w).toBeLessThanOrEqual(number.box.x);
      expect(rawLines(canvas, 0).some((l) => l.text.includes("Net weight / Price")), "the strip on page 1").toBe(true);
      for (let page = 1; page < pages; page++) {
        const where = `page ${page + 1}`;
        const run = numberRun(page);
        expect(run, where).toBeDefined();
        expect(Math.abs(run!.x - number.box.x), where).toBeLessThanOrEqual(0.5);
        expect(Math.abs(run!.y - first.y), where).toBeLessThanOrEqual(0.5);
        const cont = textRunsWithY(canvas)[page].find((r) => r.text === "(continued)");
        expect(cont, where).toBeDefined();
        expect(Math.abs(cont!.x - continued.x), where).toBeLessThanOrEqual(0.5);
        expect(rawLines(canvas, page).some((l) => l.text.includes("Net weight / Price")), where).toBe(false);
      }
      if (pageFooter) {
        for (let page = 0; page < pages; page++) {
          const where = `page ${page + 1}`;
          const lines = rawLines(canvas, page);
          const pageLine = lines.find((l) => l.text === `Page: ${page + 1} of ${pages}`);
          expect(pageLine, where).toBeDefined();
          // The page line prints at 8.5 pt (render.ts), so its top is at most its size above its
          // baseline; a body run's bottom is its baseline and its descender, under 0.3 of its size.
          // The page line moves down with the body when the sheet leaves it no room, so the foot
          // (`pageFoot(true)`) is what sees that.
          const pageLineTop = pageLine!.top - 8.5;
          for (const line of lines.filter((l) => l !== pageLine)) {
            const bottom = line.top + 0.3 * config.fonts.baseSize;
            expect(bottom, `${where}: ${line.text}`).toBeLessThan(pageLineTop);
            expect(bottom, `${where}: ${line.text}`).toBeLessThanOrEqual(pageFoot(true));
          }
        }
      }
      // The closing's and the liability's runs follow the last line's last run.
      const reading = Array.from({ length: pages }, (_, p) => rawLines(canvas, p).map((l) => l.text)).flat();
      const lastMinimum = reading.map((t) => t.startsWith("Minimum charge")).lastIndexOf(true);
      const ending = reading.findIndex((t) => t.startsWith(data.endingStatementText));
      const liability = reading.findIndex((t) => t.startsWith("Our liability"));
      expect(lastMinimum).toBeGreaterThan(-1);
      expect(ending).toBeGreaterThan(lastMinimum);
      expect(liability).toBeGreaterThan(ending);
    }, 120_000);
  });

  it.each(["header-left", "header-center", "header-right"] as const)("the logo at %s: the seeded Logo item prints where the flow paints it", async (placement) => {
    // Red with the logo never seeded, and with its top moved 5 pt.
    const config = cfg();
    config.logo = { placement, width: 80 };
    const layout = await seed(config, LOGO);
    const logo = layout.items.find((i) => i.kind === "logo")!;
    expect(logo.box.w).toBe(80);
    const { flow, canvas } = await golden(await standIn(config), config, layout, LOGO);
    expect(paintedImages(flow)[0]).toHaveLength(1);
    expect(paintedImages(canvas)[0]).toHaveLength(1);
    if (placement === "header-right") {
      const number = fieldItem(layout, "quote_number")!;
      expect(number.box.x).toBe(logo.box.x);
      expect(number.box.y).toBeGreaterThanOrEqual(logo.box.y + logo.box.h - 0.001);
      expect(number.repeat).toBe(true);
    }
  }, 60_000);

  it("the stand-in's rows: the seeded lines block holds one of every kind of row, the flow's lines laid out alone", async () => {
    // Red with the stand-in's estimate row dropped.
    const config = cfg();
    const d = await standIn(config);
    const nodes = QUOTE_FLOW.linesBlock(ctxFor(config), d);
    // A grid row, the Material line, the PRICE heading, the price row, its one detail line (the
    // setup charge, no trailer) and the estimate row.
    expect(nodes).toHaveLength(6);
    expect(JSON.stringify(nodes)).toContain("Setup charge:  $0.00\"");
    expect(JSON.stringify(nodes)).toContain("Surcharge 0% (estimate):");
    const layout = await seed(config);
    const lines = block(layout, "lines");
    expect(Math.abs(lines.box.h - await aloneHeight(nodes, QUOTE_WIDTHS.content))).toBeLessThanOrEqual(0.001);
    expect(lines.box.h).toBeGreaterThan(await aloneHeight(nodes.slice(0, 1), QUOTE_WIDTHS.content));
  }, 60_000);

  describe("what survives the seed", () => {
    it("typed labels: the title's and the number's items, a parties row, a lines row", async () => {
      // Red with every row's label seeded null, and with every header item's (the resolved-label
      // mutation is the untyped-labels case's).
      const config = typed();
      fieldOf(config, "header", "title").label = "Quote";
      fieldOf(config, "header", "quote_number").label = "Quote No.:";
      fieldOf(config, "parties", "attn").label = "Attention:";
      fieldOf(config, "lines", "setup_charge").label = "Setup:";
      const layout = await seed(config);
      expect(fieldItem(layout, "title")!.label).toBe("Quote");
      expect(fieldItem(layout, "quote_number")!.label).toBe("Quote No.:");
      expect(block(layout, "parties").columns.find((c) => c.key === "attn")!.label).toBe("Attention:");
      expect(block(layout, "lines").columns.find((c) => c.key === "setup_charge")!.label).toBe("Setup:");
      await golden(await rich(config), config, layout);
      await golden(await standIn(config), config, layout);
    }, 60_000);

    it("a hidden Material is stored as its row, not shown", async () => {
      // Red with the lines' rows seeded shown whatever the config holds.
      const config = typed();
      fieldOf(config, "lines", "material").visible = false;
      const layout = await seed(config);
      expect(block(layout, "lines").columns.find((c) => c.key === "material")!.visible).toBe(false);
      await golden(await rich(config), config, layout);
    }, 60_000);

    it("a hidden surcharge estimate is seeded hidden, and a quote with surcharges prints no estimate row under it (Review Focus 2)", async () => {
      // Red with the lines' rows seeded shown whatever the config holds.
      const config = typed();
      fieldOf(config, "lines", "surcharge_estimate").visible = false;
      const layout = await seed(config);
      expect(block(layout, "lines").columns.find((c) => c.key === "surcharge_estimate")!.visible).toBe(false);
      const data = await rich(config);
      expect(data.lines[0].surcharges.length).toBeGreaterThan(0);
      const { canvas } = await golden(data, config, layout);
      expect(rawLines(canvas, 0).some((l) => l.text.includes("EnergySur"))).toBe(false);
    }, 60_000);

    it("the parties' and the closing's rows reordered are seeded in that order and print in it", async () => {
      // Red with the parties' rows seeded in the contract's order.
      const config = typed();
      fieldOrder(config, "parties", ["bill_to", "attn", "company_phone", "effective", "expires", "terms", "rfq_number", "customer_phone"]);
      fieldOrder(config, "closing", ["quote_notes", "ending_statement", "signer_name", "signer_title"]);
      const layout = await seed(config);
      expect(block(layout, "parties").columns.map((c) => c.key).slice(0, 2)).toEqual(["bill_to", "attn"]);
      expect(block(layout, "closing").columns.map((c) => c.key).slice(0, 2)).toEqual(["quote_notes", "ending_statement"]);
      const data = await rich(config);
      const { canvas } = await golden(data, config, layout);
      expect(lineTop(canvas, 0, data.notes)).toBeLessThan(lineTop(canvas, 0, data.endingStatementText));
      expect(lineTop(canvas, 0, data.billTo[0])).toBeLessThan(lineTop(canvas, 0, "Attn:"));
    }, 60_000);

    it("typed column-header widths are stored on the seeded column headers' columns", async () => {
      // Red with the column headers' columns seeded with no width.
      const config = typed();
      fieldOf(config, "column_header", "col_amount").width = 100;
      fieldOf(config, "column_header", "col_qty").width = 60;
      const layout = await seed(config);
      const columns = block(layout, "column_header").columns;
      expect(columns.map((c) => [c.key, c.width])).toEqual([["col_qty", 60], ["col_info", null], ["col_each_weight", null], ["col_amount", 100]]);
      await golden(await rich(config), config, layout);
    }, 60_000);
  });

  describe("reorders (Review Focus 4)", () => {
    it.each([["parties", 8], ["intro", 4], ["column_header", 4], ["lines", 0]] as const)("the liability after the %s: seeded %i pt under it, and printing at the flow's place", async (after, gap) => {
      // Red with the liability marked through `seedSection` (its start mark 10 pt low).
      const config = typed();
      moveSectionAfter(config, "liability", after);
      const layout = await seed(config);
      const above = block(layout, after);
      const liability = block(layout, "liability");
      expect(Math.abs(liability.box.y - (above.box.y + above.box.h) - gap)).toBeLessThanOrEqual(0.0025);
      if (gap === 0) expect(liability.box.y).toBe(above.box.y + above.box.h);
      await golden(await rich(config), config, layout);
    }, 60_000);

    it("the header after the parties: its items ride the parties, and nothing repeats", async () => {
      // Red with the walk's base left at the page's top after a block (each item then takes its
      // laid-out top as its offset below the parties).
      const config = typed();
      moveSectionAfter(config, "header", "parties");
      const layout = await seed(config);
      expect(tablesByY(layout)[0].key).toBe("parties");
      for (const key of HEADER_FIELDS) expect(fieldItem(layout, key)!.anchor).toEqual({ kind: "below-table", table: "parties" });
      expect(layout.items.filter((i) => i.repeat)).toEqual([]);
      await golden(await rich(config), config, layout);
    }, 60_000);

    it("the closing first", async () => {
      // Red with the walk's base left at the page's top after a block.
      const config = typed();
      moveSectionAfter(config, "closing", null);
      const layout = await seed(config);
      expect(tablesByY(layout)[0].key).toBe("closing");
      await golden(await rich(config), config, layout);
    }, 60_000);
  });

  it("untyped labels stay null: every parties, lines and closing row, every column-header column and the header items", async () => {
    // Red with an untyped row's label, or an untyped header item's, seeded as the contract's resolved
    // label.
    const layout = await seed(cfg());
    for (const key of ["parties", "lines", "closing", "column_header"]) {
      const columns = block(layout, key).columns;
      expect(columns.length, key).toBeGreaterThan(0);
      for (const c of columns) expect(c.label, `${key}.${c.key}`).toBeNull();
    }
    for (const key of HEADER_FIELDS) expect(fieldItem(layout, key)!.label, key).toBeNull();
    expect(block(layout, "intro").columns).toEqual([]);
    expect(block(layout, "liability").columns).toEqual([]);
  }, 60_000);

  it("the same layout for every quote: a picked quote of 40 lines seeds the boxes of one of 1", async () => {
    // Red with the stand-in taking the picked quote's own lines.
    const customer = await makeCustomer();
    await makeBillTo(customer.id);
    const long = await quoteFor(customer, { lines: 40, prices: 2 });
    expect(byContent(await seed(cfg(), undefined, long.id))).toEqual(byContent(await seed(cfg())));
  }, 60_000);

  // No seed mutation reaches these: a hidden section prints nothing and so is never marked, and the
  // walk seeds only what is marked.
  it.each(SECTIONS)("a hidden %s section gives no item for it, and prints the flow's paper (pin)", async (key) => {
    const config = typed();
    section(config, key).visible = false;
    const layout = await seed(config);
    if (key === "header") expect(fields(layout)).toEqual([]);
    else expect(hasBlock(layout, key)).toBe(false);
    await golden(await rich(config), config, layout);
  }, 60_000);

  describe("the clamp and lift", () => {
    it.each(FONT_FAMILIES)("%s: every block at least the floor, the layout accepted, and golden 2 held", async (family) => {
      // Red with no seal at all (in Liberation Serif the snapped liability then overlaps the closing
      // and rule 5 refuses it), and through golden 2 with the liability's kept margin zeroed, with
      // it marked through `seedSection`, and with the number seeded bold.
      const config = typed();
      config.fonts.family = family;
      const layout = await seed(config);
      for (const t of tablesByY(layout)) expect(t.box.h, t.key).toBeGreaterThanOrEqual(QUOTE_ROW_FLOOR);
      await golden(await rich(config), config, layout);
    }, 60_000);

    it("the blank liability is seeded at the floor, and ordered above the closing it lifts the closing to the flow's place", async () => {
      // Red with `lift` dropped: the closing is then drawn the floor's height too high.
      const standard = await seed(cfg());
      expect(block(standard, "liability").box.h).toBe(QUOTE_ROW_FLOOR);
      const config = cfg();
      moveSectionAfter(config, "liability", "lines");
      const layout = await seed(config);
      const liability = block(layout, "liability");
      expect(liability.box.h).toBe(QUOTE_ROW_FLOOR);
      expect(block(layout, "closing").box.y).toBeGreaterThanOrEqual(liability.box.y + liability.box.h);
      await golden(await rich(config), config, layout);
    }, 60_000);
  });

  describe("the repeat (call 2, ruled (a))", () => {
    it("the number repeats on the Standard's order", async () => {
      // Red with `withRepeat` never flagging.
      expect(fieldItem(await seed(cfg()), "quote_number")!.repeat).toBe(true);
    }, 60_000);

    it("withRepeat by hand: a number anchored below a block is not flagged though its box clears the first block by a grid step", () => {
      // Red with withRepeat's page-top test deleted.
      const number = quoteField("quote_number", { box: { x: 418, y: 24, w: 170, h: 12 } });
      const parties = quoteTable("parties", { box: { x: 24, y: 64, w: 564, h: 40 } });
      expect(withRepeat([number, parties]).find((i) => i.kind === "field")!.repeat, "page-top: the premise").toBe(true);
      const below = [{ ...number, anchor: { kind: "below-table" as const, table: "parties" } }, parties];
      expect(withRepeat(below)).toEqual(below);
    });

    it("withRepeat by hand: a number whose bottom plus a grid step is exactly the first block's top is flagged, and one 0.01 pt lower is not", () => {
      // Red with the comparison made strict (`>=`), and with it loosened (a slack added).
      const parties = quoteTable("parties", { box: { x: 24, y: 24 + 12 + CANVAS_GRID, w: 564, h: 40 } });
      const at = (y: number) => withRepeat([quoteField("quote_number", { box: { x: 418, y, w: 170, h: 12 } }), parties])
        .find((i) => i.kind === "field")!.repeat;
      expect(at(24)).toBe(true);
      expect(at(24.01)).toBe(false);
    });

    it("nothing repeats with the number hidden, with the Header section hidden, or with the header ordered after the parties (pin)", async () => {
      // The hidden case, answered yes (call 2): the continuation pages then print unnamed. No mutation
      // of `withRepeat` reaches it: there is no number to flag, or one below the parties, which its
      // comparison already refuses (the by-hand cases hold the page-top test).
      const hidden = cfg();
      fieldOf(hidden, "header", "quote_number").visible = false;
      const noHeader = cfg();
      section(noHeader, "header").visible = false;
      const after = cfg();
      moveSectionAfter(after, "header", "parties");
      for (const config of [hidden, noHeader, after]) {
        const layout = await seed(config);
        expect(layout.items.filter((i) => i.repeat)).toEqual([]);
      }
    }, 60_000);
  });

  it("only seed: ids are read: a non-seed id among the positions changes nothing", async () => {
    // Red with the `seed:` filter removed.
    const config = cfg();
    const positions = (await laid(config)).positions;
    const mid = Math.floor(positions.length / 2);
    const foreign = [{ id: "canvas:item:x", page: 1, left: 30, top: 300 }, { id: "foreign-node", page: 1, left: 40, top: 310 }] as LaidOutNode[];
    const withForeign = [...positions.slice(0, mid), ...foreign, ...positions.slice(mid)];
    expect(byContent({ version: 1, items: seedQuoteItems(config, withForeign, false) }))
      .toEqual(byContent({ version: 1, items: seedQuoteItems(config, positions, false) }));
  }, 60_000);

  it("writes nothing: no stored document, audit row, template or template version (pin)", async () => {
    const counts = async () => [
      await prisma.storedDocument.count(), await prisma.auditLog.count(),
      await prisma.documentTemplate.count(), await prisma.documentTemplateVersion.count(),
    ];
    const before = await counts();
    await seedQuoteLayout(quoteId, cfg(), undefined);
    expect(await counts()).toEqual(before);
  }, 60_000);

  it("an unknown id is refused in the preview's 404; a deleted quote seeds, its lines block the stand-in's", async () => {
    // Red with the stand-in taking the picked quote's own lines (the deleted quote's are none).
    const refusal = await seedQuoteLayout("no-such-quote", cfg(), undefined).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(HttpError);
    expect((refusal as HttpError).status).toBe(404);
    expect((refusal as HttpError).message).toBe("Quote not found");
    const live = await seed(cfg());
    await asSystem(() => deleteQuote(quoteId, "test"));
    expect((await readQuotePdfData(prisma, quoteId)).lines, "the deleted quote's preview has no line").toEqual([]);
    const deleted = await seed(cfg());
    expect(block(deleted, "lines").box).toEqual(block(live, "lines").box);
    expect(byContent(deleted)).toEqual(byContent(live));
  }, 60_000);

  it("the stand-in: the settings' company, the picked quote's number and dates and the config's wordings kept, every other piece a placeholder", async () => {
    const settings = await quotePrintSettings();
    const config = typed();
    config.textBlocks.quote_intro_text = "Intro wording";
    const d = quoteStandIn(settings, { quoteNumber: 1234, effectiveDate: "2026-11-12", expiryDate: "2026-12-12" }, config);
    expect(d).toEqual({
      company: settings.company, quoteNumber: 1234, effectiveDate: "2026-11-12", expiryDate: "2026-12-12",
      termsName: "Terms", rfqNumber: "RFQ", attn: "Contact", customerPhone: "", billTo: ["Customer"],
      introText: "Intro wording",
      lines: [{
        quotedQty: 1, quotedUnlimited: false, partNumber: "Part", partName: "", partDescription: "",
        eachWeight: 1, totalLbs: 1, material: "Material",
        prices: [{
          stepName: "Operation", notes: "", setupCharge: 0, unitPrice: null, minimumCharge: null,
          pricePerLabel: "Each", pricedPerLb: false, breaks: [], amount: 0,
        }],
        surcharges: [{ name: "Surcharge", rateText: "0%", amount: 0 }],
      }],
      endingStatementText: "Ending statement", notes: "", liabilityText: LIABILITY,
      signer: { name: "Signer", title: "Title" },
    });
    expect(QUOTE_STAND_IN.billTo).toEqual(["Customer"]);
    // The seeded styles are the flow's (quoteSeedStyle), the number's regular.
    const layout = await seed(cfg());
    for (const key of HEADER_FIELDS) expect(fieldItem(layout, key)!.style, key).toEqual(quoteSeedStyle(key, cfg().fonts));
  }, 60_000);

  it("the residuals, measured and pinned (design §4.4, §4.5, §15)", async () => {
    // Read from raw baselines and positions off seeded and flow prints, never from `bandTop`,
    // `QUOTE_PAGE` arithmetic or a hand-built document. Red with the sheet's bottom margin raised by
    // 2 pt (canvas-sheet.ts): the room figures move.
    const figures: Record<string, number> = {};
    const config = cfg();
    const layout = await seed(config);

    // The header's height and the parties' top, under a one-line and a two-line company address.
    const headerBottom = (l: CanvasLayout) => Math.max(...fields(l).map((f) => f.box.y + f.box.h));
    figures.headerBottomTwoLines = headerBottom(layout);
    figures.partiesTopTwoLines = block(layout, "parties").box.y;
    await setCompany(ONE_LINE);
    const oneLine = await seed(config);
    figures.headerBottomOneLine = headerBottom(oneLine);
    figures.partiesTopOneLine = block(oneLine, "parties").box.y;
    await setCompany(TWO_LINES);

    // The number's top and bottom, and the repeat band (every page's top margin).
    const number = fieldItem(layout, "quote_number")!;
    figures.numberTop = number.box.y;
    figures.numberBottom = number.box.y + number.box.h;
    // "(continued)"'s box against the number's: clear.
    const continued = continuedBox(layout)!;
    figures.continuedRight = continued.x + continued.w;
    figures.numberLeft = number.box.x;
    expect(figures.continuedRight).toBeLessThanOrEqual(figures.numberLeft);

    // The page line's place, page line on: the canvas's against the flow's.
    const on = await papers(await rich(config), config, layout);
    figures.pageLineRiseOn = lineTop(on.flow, 0, "Page: 1 of 1") - lineTop(on.canvas, 0, "Page: 1 of 1");

    // Page 1's first line on a 40-line quote, against its flow print.
    const forty = await papers(await rich(config, { lines: quoteLines(40) }), config, layout);
    const firstTop = (pdf: Buffer) => rawLines(pdf, 0)[0].top;
    figures.pagedRise = firstTop(forty.flow) - firstTop(forty.canvas);

    // A continuation page's room against the flow's, page line on and off (`continuationPage`).
    const off = cfg();
    off.pageFooter = false;
    const offLayout = await seed(off);
    const canvasOn = await continuationPage(config, layout);
    const canvasOff = await continuationPage(off, offLayout);
    const flowOn = await continuationPage(config, null);
    const flowOff = await continuationPage(off, null);
    // The repeat band read off the paper agrees with the leaf's figure, and the flow's page 2 starts
    // at its own overflow top margin.
    figures.repeatBand = canvasOn.top;
    expect(Math.abs(canvasOn.top - topMargin(layout))).toBeLessThanOrEqual(0.01);
    expect(Math.abs(canvasOff.top - topMargin(offLayout))).toBeLessThanOrEqual(0.01);
    for (const page of [canvasOn, canvasOff, flowOn, flowOff]) {
      // The paper proves the limit: page 2 holds exactly the rows that fit under it at their pitch.
      expect(page.rows, `page 2's rows, ${page.limit} limit`).toBe(Math.floor((page.limit - page.top + page.rowGap) / page.pitch));
    }
    expect(canvasOn.limit).toBe(bandTop(layout, true));
    expect(canvasOff.limit).toBe(bandTop(offLayout, false));
    figures.continuationRoomLessOn = (flowOn.limit - flowOn.top) - (canvasOn.limit - canvasOn.top);
    figures.continuationRoomMoreOff = (canvasOff.limit - canvasOff.top) - (flowOff.limit - flowOff.top);
    figures.flowContinuationTop = flowOn.top;

    // The band's height with a header-right logo 60 pt tall (the square fixture image at 60 wide).
    const right = cfg();
    right.logo = { placement: "header-right", width: 60 };
    const rightLayout = await seed(right, LOGO);
    const logo = rightLayout.items.find((i) => i.kind === "logo")!;
    figures.rightLogoHeight = logo.box.h;
    figures.rightLogoBand = (await continuationPage(right, rightLayout, LOGO)).top;
    expect(Math.abs(figures.rightLogoBand - topMargin(rightLayout))).toBeLessThanOrEqual(0.01);

    // The title's x under a header-center logo of 230 pt (a clamped seed: its centre column is 208,
    // the flow's widened to the logo), recorded, not compared.
    const centre = cfg();
    centre.logo = { placement: "header-center", width: 230 };
    const centreLayout = await seed(centre, LOGO);
    const centred = await papers(await standIn(centre), centre, centreLayout, LOGO);
    const titleX = (pdf: Buffer) => rawLines(pdf, 0).find((l) => l.text === "Quotation")!.x;
    const titleOffset = titleX(centred.canvas) - titleX(centred.flow);

    for (const [key, value] of Object.entries(QUOTE_SEED_RESIDUALS)) {
      expect(Math.abs(figures[key] - value), `${key}: measured ${figures[key]}`).toBeLessThanOrEqual(0.01);
    }

    // The page counts at 40 and 200 lines, flow against canvas, page line on and off: logged and pinned.
    const counts: Record<string, [number, number]> = {};
    for (const n of [40, 200]) {
      for (const [name, c, l] of [["on", config, layout], ["off", off, offLayout]] as const) {
        const p = await papers(await rich(c, { lines: quoteLines(n) }), c, l);
        counts[`${n} ${name}`] = [pageCount(p.flow), pageCount(p.canvas)];
      }
    }
    console.log("quote seed residuals", JSON.stringify(figures), "title offset", titleOffset, "pages (flow, canvas)", JSON.stringify(counts));
    expect(counts).toEqual(QUOTE_PAGE_COUNTS);
  }, 240_000);
});

/**
 * The residuals measured on the seeded Standard (the 2026-11-12 run, Roboto; design §15), each within
 * 0.5 pt of the design's prediction: the header ends at 88.11 under a two-line company address and
 * 76.391 under one, the parties' top at 98.109 and 86.391 (predicted about 98 and 86); the number
 * 24 to 36.891 (about 24 and 36.9); the repeat band 41.391 (about 41.4: the number's bottom and a
 * grid step); "(continued)" ends at 84, left of the number's 418 (clear); the page line, on, prints
 * where the flow's does (0 pt apart); a paging canvas's page 1 prints 16 pt higher than its flow
 * print (16); a continuation page holds 1.391 pt less than the flow's with the page line on and
 * 18.609 pt more with it off (about 1.4 and 18.6), the flow's page 2 starting at its 40 pt; and a
 * header-right logo 60 pt tall makes a 101.391 pt band (about 101).
 */
const QUOTE_SEED_RESIDUALS: Record<string, number> = {
  headerBottomTwoLines: 88.11, partiesTopTwoLines: 98.109, headerBottomOneLine: 76.391, partiesTopOneLine: 86.391,
  numberTop: 24, numberBottom: 36.891, repeatBand: 41.391, continuedRight: 84, numberLeft: 418,
  pageLineRiseOn: 0, pagedRise: 16, continuationRoomLessOn: 1.391, continuationRoomMoreOff: 18.609,
  flowContinuationTop: 40, rightLogoHeight: 60, rightLogoBand: 101.391,
};
/** The page counts, flow and canvas, at 40 and 200 lines, page line on and off (the 2026-11-12 run):
 *  equal but at 200 lines with the page line off, where the canvas's 20 pt more on every page saves
 *  one (design §4.4's "a page more or fewer"). */
const QUOTE_PAGE_COUNTS: Record<string, [number, number]> = {
  "40 on": [8, 8], "40 off": [8, 8], "200 on": [38, 38], "200 off": [38, 37],
};

/**
 * Page 2 of a quote of 300 one-row lines (with `logo` when given) (each a grid row alone: a one-line part identity, no
 * Material, no price row), the canvas's when `layout` is set and the flow's when null, read off the
 * paper: `top` is page 2's top, its first grid row's raw baseline less that row's offset under the
 * lines block's rendered top on page 1 (the canvas's `regionEnd` mark of the column headers; the
 * flow's `seed:start:lines` mark, its layout unchanged by the marks: both stand above the first
 * row's 2 pt top margin, which a row at a page's top does not print); `rows` counts page 2's grid
 * rows; `pitch` is their baseline pitch, `rowGap` the 2 pt top margin a row carries and the first
 * row on the page does not (so k rows take k pitches less that margin); `limit` is the page's bottom
 * limit from the definition's bottom margin.
 */
async function continuationPage(config: TemplateConfig, layout: CanvasLayout | null, logo?: string) {
  const s = await quotePrintSettings();
  const data = sampleQuote({
    company: s.company, introText: config.textBlocks.quote_intro_text, liabilityText: config.textBlocks.quote_liability_text,
    lines: quoteLines(300, { partName: "", partDescription: "", material: "", prices: [] }),
  });
  const printed = { ...config, layout };
  const marked = layout === null ? buildQuoteDefinition(data, printed, logo, { seedIds: true }) : buildQuoteDefinition(data, printed, logo);
  const { groups } = await renderSheetGroupsWithPositions([marked]);
  const blockTopId = layout === null ? QUOTE_SEED_IDS.start("lines") : CANVAS_IDS.regionEnd("column_header");
  const blockTop = groups[0].positions.find((n) => n.id === blockTopId && n.page === 1)!.top;
  const pdf = await renderPdf(buildQuoteDefinition(data, printed, logo));
  const isRow = (text: string) => /^100 P-\d{4}/.test(text);
  const offset = rawLines(pdf, 0).find((l) => isRow(l.text))!.top - blockTop;
  const rows = rawLines(pdf, 1).filter((l) => isRow(l.text));
  const definition = buildQuoteDefinition(data, printed, logo);
  return {
    // A row's 2 pt top margin is not printed at a page's top (measured: pdfmake drops it there), so
    // page 2's first row stands that much higher under the page's top than page 1's under its block's.
    top: rows[0].top - (offset - 2),
    rows: rows.length,
    pitch: (rows[rows.length - 1].top - rows[0].top) / (rows.length - 1),
    rowGap: 2,
    limit: PAGE_HEIGHT - (definition.pageMargins as number[])[3],
  };
}

// ---------------------------------------------------------------------------------------------
// The seed's refusals (design 2026-11-12 §5.3, §15; since quote canvas PR 2): the invoice's four in
// its order, with "quote" for "invoice", and with the company address, the company name and the
// template's intro and liability wording named where they were measured reaching a sentence (the
// controller's ruling of 2026-11-12): the hidden Column headers over a grid set apart from the
// Standard's, before any read; the page count after the render; the header's width; and the drawn
// stack's fit. Each sentence is pinned whole, and for each setting a sentence names, one case shows
// that setting reaching the cause, from a baseline whose own verdict is asserted in the same case,
// that setting alone changed (the statement's whole-branch finding 3). A case's premises (the
// stand-in's flow page count, the laid-out left past the margin, the drawn bottom past the band) are
// asserted first on the seed's own layout pass, built from its exported pieces with no refusal run
// (`unjudged`). Each refusal stores and audits nothing.
// ---------------------------------------------------------------------------------------------

const GRID_SENTENCE =
  "The canvas starts from today's paper, and this template hides its Column headers while setting their columns apart from the Standard's (their order, widths or which are shown); a canvas with no Column headers block prints the lines under the Standard's columns. Show the Column headers, or set their columns back to the Standard's, before designing on a canvas.";
const PAGES_SENTENCE = (pages: number) =>
  `The canvas starts from a one-page quote; laid out at its least, this template's quote prints ${pages} pages. Change this template's settings (its font, sizes, logo or title's label), its intro or liability wording, or the company address so it fits one page.`;
const HEADER_SENTENCE =
  "The canvas starts from a quote whose header fits the page; laid out at its least, this template's header runs past the page's right margin. Change this template's settings (its logo's width, font, heading size or title's label) or the company name or address so the header fits the page's width.";
const FIT_SENTENCE =
  "The canvas starts from a one-page quote; laid out at its least on the canvas, this template's quote runs past one page. Change this template's settings (its font, sizes, logo, page line or title's label), its intro or liability wording, or the company address so it fits one page.";

/** What a seed writes, were it to write: stored documents, audit rows, templates, their versions, drafts. */
async function writes() {
  return [
    await prisma.storedDocument.count(), await prisma.auditLog.count(), await prisma.documentTemplate.count(),
    await prisma.documentTemplateVersion.count(), await prisma.orderDraft.count(),
  ];
}

/** The seed's refusal for the picked quote (or `id`): its class, its status and its whole sentence,
 *  with nothing stored or audited. */
async function expectRefusal(config: TemplateConfig, logo: string | undefined, sentence: string, id = quoteId) {
  const before = await writes();
  let refusal: unknown = null;
  try { await seedQuoteLayout(id, config, logo); } catch (err) { refusal = err; }
  expect(refusal, String(refusal)).toBeInstanceOf(HttpError);
  expect((refusal as HttpError).status).toBe(400);
  expect((refusal as HttpError).message).toBe(sentence);
  expect(await writes(), "a refusal stores and audits nothing").toEqual(before);
}

/** The stand-in's flow print's page count under `config` (a fresh definition: pdfmake uses up the
 *  nodes it lays out). */
async function flowPagesOf(config: TemplateConfig, logo?: string): Promise<number> {
  return pageCount(await renderPdf(buildQuoteDefinition(await standIn(config), config, logo)));
}

/** The seed's own pieces for `config` with none of its refusals run, from a ONE-page layout pass
 *  (asserted: a paged pass's positions say nothing of one page): the pass, the stand-in's flow page
 *  count, the seeded layout, its band's top and its drawn stack's bottom. */
async function unjudged(config: TemplateConfig, logo?: string) {
  const pass = await laid(config, logo);
  expect(pass.pages, "the seed's layout pass is one page").toBe(1);
  const layout: CanvasLayout = { version: 1, items: withRepeat(seedQuoteItems(config, pass.positions, logo !== undefined)) };
  const bottom = (item: CanvasItem) => { const box = drawnBox(item, layout); return box.y + box.h; };
  return {
    pass, layout, bottom,
    flowPages: await flowPagesOf(config, logo),
    band: bandTop(layout, config.pageFooter),
    stackBottom: Math.max(...layout.items.map(bottom)),
  };
}

/** A tall, narrow logo (1:4): placed `w` wide it prints 4w tall, so a header-centre one under the
 *  centre column's 208 pt grows the header without widening the column. */
const TALL_LOGO = pngDataUri(alphaPng(10, 40));
/** A wide, short logo (64:1), so a header logo hundreds of points wide stays one short row. */
const WIDE_LOGO = pngDataUri(alphaPng(64, 1));
/** A square logo: its printed height is its placed width. */
const SQUARE_LOGO = pngDataUri(alphaPng(10, 10));
/** The flow's content runs to its bottom margin's top (748). */
const FLOW_FOOT = PAGE_HEIGHT - QUOTE_PAGE.bottomMargin;

/** The stand-in's closing end on the seed's layout pass under `config`, with no logo. */
async function closingEnd(config: TemplateConfig): Promise<number> {
  return (await laid(config)).top(QUOTE_SEED_IDS.sectionEnd("closing"));
}
/** `config` with a header-centre `TALL_LOGO` that ends the Standard's closing at `target`, its width
 *  worked from the Standard's closing end with no logo (a tall logo adds its height whole: the centre
 *  stack is the header row's tallest). */
async function closingAt(target: number, config: TemplateConfig = cfg()): Promise<TemplateConfig> {
  const width = (target - (await closingEnd(cfg()))) / 4;
  config.logo = { placement: "header-center", width };
  return config;
}
/** The title's typed label. */
function titleLabel(config: TemplateConfig, label: string): TemplateConfig {
  fieldOf(config, "header", "title").label = label;
  return config;
}
/** The Standard in `family` at heading size `headingSize`. */
function headed(headingSize: number, family: TemplateConfig["fonts"]["family"] = "Roboto"): TemplateConfig {
  const config = cfg();
  config.fonts = { ...config.fonts, family, headingSize };
  return config;
}
/** The Standard with its Column headers hidden, `edit` applied to their fields. */
function hiddenGrid(edit: (c: TemplateConfig) => void = () => {}): TemplateConfig {
  const config = cfg();
  section(config, "column_header").visible = false;
  edit(config);
  return config;
}
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

describe("seedQuoteLayout's refusals: four sentences in the invoice's order", () => {
  describe("sentence 1: the hidden Column headers over a grid set apart from the Standard's", () => {
    const apart: [string, (c: TemplateConfig) => void][] = [
      ["a width (the amount column typed 100)", (c) => { fieldOf(c, "column_header", "col_amount").width = 100; }],
      ["the order (the each-weight and amount columns swapped)", (c) => fieldOrder(c, "column_header", ["col_qty", "col_info", "col_amount", "col_each_weight"])],
      ["which are shown (the each-weight column hidden)", (c) => { fieldOf(c, "column_header", "col_each_weight").visible = false; }],
    ];
    it.each(apart)("%s under hidden Column headers is refused in the grid sentence, before an unknown id's 404", async (_why, edit) => {
      const config = hiddenGrid(edit);
      expect(gridDiffers(config)).toBe(true);
      await expectRefusal(config, undefined, GRID_SENTENCE, UNKNOWN_ID);
      // The same setting under SHOWN Column headers is no refusal: the section seeds its block,
      // columns and all. Red when the clause ignores the section's visibility.
      const shown = cfg();
      edit(shown);
      expect(gridDiffers(shown)).toBe(false);
      expect(hasBlock(await seed(shown), "column_header")).toBe(true);
    }, 60_000);

    it("the refused seed would print the lines under the Standard's columns: its unrefused layout's paper is not the flow's", async () => {
      const config = hiddenGrid((c) => { fieldOf(c, "column_header", "col_amount").width = 100; });
      // The premise, on the seed's own pieces with no refusal run: no Column headers block, and the
      // canvas's paper (the lines under the contract's grid, `gridOf`) is not the flow's (the lines
      // under the hidden section's columns). Red with the clause deleted: the seed then answers it.
      const u = await unjudged(config);
      expect(hasBlock(u.layout, "column_header")).toBe(false);
      const data = await rich(config);
      const flow = await renderPdf(buildQuoteDefinition(data, config));
      const canvas = await renderPdf(buildQuoteDefinition(data, { ...config, layout: u.layout }));
      // The difference, as measured: the same runs in the same order at the same baselines, and only
      // the each-weight figures and their "lb" moved, each right by the typed amount width less the
      // contract's (the right-aligned each-weight column ends that much further right on the
      // contract's grid).
      const amount = QUOTE_CONTRACT.sections.find((s) => s.key === "column_header")!.fields.find((f) => f.key === "col_amount")!;
      const delta = 100 - (amount.column!.defaultWidth as number);
      const printed = (pdf: Buffer) => runsPerPage(pdf)[0].filter((r) => r.text.trim() !== "");
      const flowRuns = printed(flow);
      const canvasRuns = printed(canvas);
      expect(canvasRuns.map((r) => r.text)).toEqual(flowRuns.map((r) => r.text));
      const moved = flowRuns.flatMap((r, i) => {
        const c = canvasRuns[i];
        expect(Math.abs(c.y - r.y), `"${r.text}"'s baseline`).toBeLessThanOrEqual(0.5);
        return Math.abs(c.x - r.x) > 0.5 ? [{ text: r.text.trim(), dx: Math.round((c.x - r.x) * 1000) / 1000 }] : [];
      });
      expect(moved).toEqual(["12.50", "lb", "3.25", "lb", "0.40", "lb"].map((text) => ({ text, dx: delta })));
      await expectRefusal(config, undefined, GRID_SENTENCE);
    }, 60_000);

    it("hidden Column headers at the Standard's grid (a width typed at the contract's own 52) seed, with no Column headers block", async () => {
      // Red when the clause refuses every hidden section, and when it compares the typed widths raw
      // (52 against the contract's null) rather than as the flow resolves them.
      const config = hiddenGrid((c) => { fieldOf(c, "column_header", "col_qty").width = 52; });
      expect(gridDiffers(config)).toBe(false);
      const layout = await seed(config);
      expect(hasBlock(layout, "column_header")).toBe(false);
      await golden(await rich(config), config, layout);
    }, 60_000);

    it("hidden Column headers with their labels typed alone seed: no column header prints under a hidden section", async () => {
      // Red when the clause compares the labels too.
      const config = hiddenGrid((c) => { fieldOf(c, "column_header", "col_info").label = "Part / pricing"; });
      expect(gridDiffers(config)).toBe(false);
      expect(hasBlock(await seed(config), "column_header")).toBe(false);
    }, 60_000);

    it("a hidden column reordered under hidden Column headers is refused in the grid sentence though it prints the same paper (the invoice's over-refusal, recorded)", async () => {
      // The each-weight column hidden in place, and hidden and moved first: the flow prints the same
      // paper for both (a hidden column reserves nothing), yet the copied comparison keeps the hidden
      // column in the order it compares (the invoice's over-refusal, found in its PR 2 seed review and
      // kept as its shape). Red with the clause deleted.
      const inPlace = hiddenGrid((c) => { fieldOf(c, "column_header", "col_each_weight").visible = false; });
      const moved = hiddenGrid((c) => {
        fieldOf(c, "column_header", "col_each_weight").visible = false;
        fieldOrder(c, "column_header", ["col_each_weight", "col_qty", "col_info", "col_amount"]);
      });
      const data = await rich(cfg());
      expectSameQuote(await renderPdf(buildQuoteDefinition(data, inPlace)), await renderPdf(buildQuoteDefinition(data, moved)));
      await expectRefusal(moved, undefined, GRID_SENTENCE);
    }, 60_000);
  });

  describe("sentence 2: the stand-in prints past one page", () => {
    it("a header-centre square logo 400 pt wide and tall pages the stand-in and is refused naming 2 pages, ahead of the header it also pushes past the margin", async () => {
      const config = cfg();
      config.logo = { placement: "header-center", width: 400 };
      const pass = await laid(config, SQUARE_LOGO);
      expect(pass.pages, "the seed's layout pass").toBe(2);
      expect(await flowPagesOf(config, SQUARE_LOGO), "the stand-in's flow print").toBe(2);
      // The header's page-1 positions: the number laid out past the right margin, so the header
      // sentence would refuse it too. Red when the page check follows the header check.
      expect(pass.at(QUOTE_SEED_IDS.piece("quote_number")).left).toBeGreaterThan(CANVAS_PAGE.width - MARGIN);
      await expectRefusal(config, SQUARE_LOGO, PAGES_SENTENCE(2));
    }, 60_000);

    it("a company address of 60 lines pages the stand-in and is refused naming 2 pages", async () => {
      // Red with the page clause deleted.
      await setCompany(Array.from({ length: 60 }, (_, i) => `Line ${i + 1}`).join("\n"));
      expect((await laid(cfg())).pages).toBe(2);
      expect(await flowPagesOf(cfg())).toBe(2);
      await expectRefusal(cfg(), undefined, PAGES_SENTENCE(2));
    }, 60_000);

    it("an intro of 40 lines, typed alone over the Standard that seeds, pages the stand-in and is refused naming 2 pages", async () => {
      // The stand-in keeps the template's intro wording, so a long one pages it (measured: 20 lines
      // seed, 40 page). Red with the page clause deleted, and with the wording dropped from the sentence.
      await seed(cfg());
      const config = cfg();
      config.textBlocks.quote_intro_text = Array.from({ length: 40 }, (_, i) => `Intro line ${i + 1}`).join("\n");
      expect(validateConfig("QUOTE", config).textBlocks.quote_intro_text, "a draft can hold it").toBe(config.textBlocks.quote_intro_text);
      expect((await laid(config)).pages, "the seed's layout pass").toBe(2);
      expect(await flowPagesOf(config), "the stand-in's flow print").toBe(2);
      await expectRefusal(config, undefined, PAGES_SENTENCE(2));
    }, 60_000);

    it("a title's label of 40 words, typed alone over the Standard that seeds, pages the stand-in and is refused naming 2 pages; 30 words seed", async () => {
      // The stand-in keeps the template's title label, and a long one wraps under the header's centre
      // column, growing the header (measured: 10, 20 and 30 words of "Quotation" seed, 40 page). Red
      // with the page clause deleted, and with the title's label dropped from the sentence.
      await seed(cfg());
      const words = (n: number) => Array.from({ length: n }, () => "Quotation").join(" ");
      const seeds = titleLabel(cfg(), words(30));
      expect((await laid(seeds)).pages, "30 words: the seed's layout pass").toBe(1);
      await seed(seeds);
      const config = titleLabel(cfg(), words(40));
      expect((await laid(config)).pages, "the seed's layout pass").toBe(2);
      expect(await flowPagesOf(config), "the stand-in's flow print").toBe(2);
      await expectRefusal(config, undefined, PAGES_SENTENCE(2));
    }, 60_000);

    // Each setting the sentence names, from a baseline that seeds: a header-centre tall logo ending
    // the Standard's closing at 720 (its drawn stack, the blank liability's floor below it, at 730,
    // inside the band's 748). No size alone pages the stand-in (measured: a base size of 72 ends its
    // closing at 524.69, a heading size of 72 at 417.71; a small size moves nothing, measured at 24 to
    // 72 on the blank wording and at 4 to 72 with the liability typed), so each is shown
    // from that baseline; so are the intro and liability wording (measured from it: two intro lines
    // more end the closing at 742.27 and reach the canvas sentence, three page; the liability typed
    // as one or two lines seeds, three page). Red with the page clause deleted: each then falls to
    // another refusal or seeds; the wording's two rows red too with the wording dropped from the
    // sentence.
    const reaching: [string, (c: TemplateConfig) => Promise<void> | void][] = [
      ["the font (Roboto Mono)", (c) => { c.fonts = { ...c.fonts, family: "Roboto Mono" }; }],
      ["the base size (72)", (c) => { c.fonts = { ...c.fonts, baseSize: 72 }; }],
      ["the heading size (72)", (c) => { c.fonts = { ...c.fonts, headingSize: 72 }; }],
      ["the logo (40 pt taller)", (c) => { c.logo = { ...c.logo!, width: c.logo!.width + 10 }; }],
      ["the company address (three lines more)", async () => { await setCompany(`${TWO_LINES}\nLine 3\nLine 4\nLine 5`); }],
      ["the intro wording (three lines more)", (c) => { c.textBlocks.quote_intro_text += "\nMore\nMore\nMore"; }],
      ["the liability wording (three lines typed)", (c) => { c.textBlocks.quote_liability_text = [LIABILITY, LIABILITY, LIABILITY].join("\n"); }],
    ];
    it.each(reaching)("%s, changed alone from a baseline that seeds, pages the stand-in and is refused naming 2 pages", async (_why, change) => {
      const baseline = await closingAt(720);
      const u = await unjudged(baseline, TALL_LOGO);
      expect(u.flowPages).toBe(1);
      expect(u.stackBottom).toBeLessThan(u.band);
      await seed(baseline, TALL_LOGO);

      const config = structuredClone(baseline);
      await change(config);
      expect((await laid(config, TALL_LOGO)).pages, "the seed's layout pass").toBe(2);
      expect(await flowPagesOf(config, TALL_LOGO), "the stand-in's flow print").toBe(2);
      await expectRefusal(config, TALL_LOGO, PAGES_SENTENCE(2));
    }, 60_000);
  });

  describe("sentence 3: the header past the page's right margin", () => {
    it("a header-centre logo 378 pt wide leaves the number no width and is refused in the header sentence; 377 pt seeds, the number clamped to 1 pt", async () => {
      const refused = cfg();
      refused.logo = { placement: "header-center", width: 378 };
      const u = await unjudged(refused, WIDE_LOGO);
      expect(u.flowPages).toBe(1);
      expect(u.pass.at(QUOTE_SEED_IDS.piece("quote_number")).left).toBeGreaterThanOrEqual(CANVAS_PAGE.width - MARGIN);
      expect(fieldItem(u.layout, "quote_number")!.box.w).toBe(0);
      expect(u.stackBottom, "nothing else refuses it").toBeLessThan(u.band);
      await expectRefusal(refused, WIDE_LOGO, HEADER_SENTENCE);

      // Red when the clause refuses any push (a width under 170).
      const seeds = cfg();
      seeds.logo = { placement: "header-center", width: 377 };
      const layout = await seed(seeds, WIDE_LOGO);
      expect(fieldItem(layout, "quote_number")!.box).toMatchObject({ x: CANVAS_PAGE.width - MARGIN - 1, w: 1 });
    }, 60_000);

    it("the title's label: a typed one-word title at heading size 36 is refused in the header sentence; at 30 it seeds, the number clamped", async () => {
      // Red with the header clause deleted; its seeding half red when the clause refuses any push.
      const word = "QUOTATIONQUOTATION";
      const refused = titleLabel(headed(36), word);
      const u = await unjudged(refused);
      expect(u.flowPages).toBe(1);
      expect(fieldItem(u.layout, "quote_number")!.box.w).toBeLessThanOrEqual(0);
      await expectRefusal(refused, undefined, HEADER_SENTENCE);
      // The Standard's own title at that size seeds: the label is the cause.
      await seed(headed(36));
      // The heading size: the same word at 30 is pushed only part of the way.
      const layout = await seed(titleLabel(headed(30), word));
      const number = fieldItem(layout, "quote_number")!;
      expect(number.box.x).toBeGreaterThan(NUMBER_X);
      expect(number.box.x + number.box.w).toBe(RIGHT_EDGE);
    }, 60_000);

    it("the font: \"Quotation\" at heading size 72 seeds in Roboto, the number clamped, and is refused in Roboto Mono", async () => {
      // Red with the header clause deleted; its seeding half red when the clause refuses any push.
      const roboto = await seed(headed(72));
      const number = fieldItem(roboto, "quote_number")!;
      expect(number.box.w).toBeGreaterThan(0);
      expect(number.box.x + number.box.w).toBe(CANVAS_PAGE.width - MARGIN);
      const mono = headed(72, "Roboto Mono");
      const u = await unjudged(mono);
      expect(u.flowPages).toBe(1);
      expect(fieldItem(u.layout, "quote_number")!.box.w).toBeLessThanOrEqual(0);
      await expectRefusal(mono, undefined, HEADER_SENTENCE);
    }, 60_000);

    it("the heading size: \"Quotation\" in Roboto Mono seeds at 60, the number clamped, and is refused at 72", async () => {
      // Red with the header clause deleted; its seeding half red when the clause refuses any push.
      const layout = await seed(headed(60, "Roboto Mono"));
      expect(fieldItem(layout, "quote_number")!.box.w).toBeGreaterThan(0);
      await expectRefusal(headed(72, "Roboto Mono"), undefined, HEADER_SENTENCE);
    }, 60_000);

    it("a heading size of 50 under \"Quotation\" seeds, the number pushed right and clamped at the margin", async () => {
      // Red when the clause refuses any push, and when `tidy` stops clamping a box at the right margin
      // (the rules then refuse the number past it, unmapped).
      const layout = await seed(headed(50));
      const number = fieldItem(layout, "quote_number")!;
      expect(number.box.x).toBeGreaterThan(NUMBER_X);
      expect(number.box.x + number.box.w).toBe(RIGHT_EDGE);
    }, 60_000);

    it("a header-centre logo 230 pt wide seeds, the number pushed 22 pt and clamped", async () => {
      // Red when the clause refuses any push.
      const config = cfg();
      config.logo = { placement: "header-center", width: 230 };
      const layout = await seed(config, WIDE_LOGO);
      const push = 230 - CENTRE_W;
      expect(fieldItem(layout, "quote_number")!.box).toMatchObject({ x: NUMBER_X + push, w: QUOTE_WIDTHS.headerSide - push });
    }, 60_000);

    it("a header-right logo 200 pt wide seeds, the logo clamped at the right margin to 170 pt (pin)", async () => {
      // No clause deletion reds it; red when `tidy` stops clamping (the rules refuse the logo past the
      // margin, unmapped).
      const config = cfg();
      config.logo = { placement: "header-right", width: 200 };
      const layout = await seed(config, WIDE_LOGO);
      expect(layout.items.find((i) => i.kind === "logo")!.box).toMatchObject({ x: NUMBER_X, w: QUOTE_WIDTHS.headerSide });
    }, 60_000);

    it("a header-left logo 200 pt wide seeds with its width kept, and its drawn boxes warn (a) against the title (pin)", async () => {
      // The flow prints the 200 pt image over the centre column's left (202 to 224), while the title's
      // ink starts at 262; the drawn-box warnings (no measure: the preview's is a later task's) name
      // the logo against the title's 208 pt box alone, the wide logo being one short row (a square one
      // overlaps the company name's and address's boxes too). No clause deletion reds it; red when a
      // side logo is clamped to its 170 pt column (24 to 194, clear of the title's 202).
      const config = cfg();
      config.logo = { placement: "header-left", width: 200 };
      const layout = await seed(config, WIDE_LOGO);
      expect(layout.items.find((i) => i.kind === "logo")!.box).toMatchObject({ x: MARGIN, w: 200 });
      const warnings = namedWarnings(layout, canvasWarnings(layout, QUOTE_CONTRACT, undefined, { pageFooter: config.pageFooter, fonts: config.fonts }));
      expect(warnings).toEqual([
        { items: ["logo", "title"], sentence: "The Logo (logo) and the Document title field overlap; one prints over the other." },
      ]);
    }, 60_000);

    it("the header before the fit: a header-centre square logo 386 pt wide, which also draws the stack past the band, is refused in the header sentence", async () => {
      // Red when the fit check precedes the header check.
      const config = cfg();
      config.logo = { placement: "header-center", width: 386 };
      const u = await unjudged(config, SQUARE_LOGO);
      expect(u.flowPages).toBe(1);
      expect(fieldItem(u.layout, "quote_number")!.box.w).toBeLessThanOrEqual(0);
      expect(u.stackBottom).toBeGreaterThan(u.band);
      await expectRefusal(config, SQUARE_LOGO, HEADER_SENTENCE);
    }, 60_000);
  });

  describe("sentence 3: a company name or address holding one unbroken word wide enough", () => {
    // The company name and address are Settings, not the template's, and the stand-in keeps them; one
    // unbroken word in either widens the flow's "*" centre column as a wide logo does, so it reaches
    // the header sentence, which names them beside the template's settings (the controller's ruling of
    // 2026-11-12). Measured on the Standard: 33 "W"s in the name seed (the number w 0.321), 34 are
    // refused; 42 in an address line seed (w 5.373), 43 are refused (w -3.499).
    const cases: [string, "company_name" | "company_address", number, number][] = [
      ["the company name", "company_name", 33, 34],
      ["the company address", "company_address", 42, 43],
    ];
    it.each(cases)("%s holding one unbroken word wide enough is refused in the header sentence, which names it; one W fewer seeds, the number clamped", async (_why, setting, seeds, refused) => {
      // Red with the header clause deleted (the refused half: the rules then refuse the number with no
      // width, unmapped), and with the company name or address dropped from the sentence; the seeding
      // half red when the clause refuses any push.
      const config = cfg();
      await seed(config);
      await setSetting(setting, "W".repeat(seeds));
      const number = fieldItem(await seed(config), "quote_number")!;
      expect(number.box.w).toBeGreaterThan(0);
      expect(number.box.x + number.box.w).toBe(RIGHT_EDGE);

      await setSetting(setting, "W".repeat(refused));
      const u = await unjudged(config);
      expect(u.flowPages).toBe(1);
      expect(fieldItem(u.layout, "quote_number")!.box.w).toBeLessThanOrEqual(0);
      expect(u.stackBottom, "nothing else refuses it").toBeLessThan(u.band);
      await expectRefusal(config, undefined, HEADER_SENTENCE);
    }, 60_000);
  });

  describe("sentence 4: one flow page that is not one canvas page", () => {
    // The window: with the page line on, the canvas's band ends at 748, where the flow's content does
    // (its 44 pt bottom margin), so only the seed's row-floor clamp (the Standard's blank liability
    // drawn 10 pt tall under the closing) draws a stack the flow fits past the band. A closing ending
    // at 742 draws the stack to 752.
    it("a header-centre tall logo ending the closing at 742, page line on, is refused in the canvas sentence", async () => {
      // Red with the fit clause deleted (the rules then refuse the liability past the band, unmapped).
      const config = await closingAt(742);
      const u = await unjudged(config, TALL_LOGO);
      expect(u.flowPages).toBe(1);
      expect(u.pass.top(QUOTE_SEED_IDS.sectionEnd("closing"))).toBeLessThanOrEqual(FLOW_FOOT);
      expect(u.stackBottom).toBeGreaterThan(u.band);
      for (const item of u.layout.items) expect(item.box.w, item.kind).toBeGreaterThan(0);
      await expectRefusal(config, TALL_LOGO, FIT_SENTENCE);
    }, 60_000);

    // Each setting the sentence names, changed alone from that refused baseline, cures it (the window
    // is 10 pt, so a cause from below could overshoot into the page count); the base size, which moves
    // nothing below the Standard's 9, is shown as a cause in the case after. The baseline is red with
    // the fit clause deleted; each cure is red when the clause asks for 15 pt of clearance rather than
    // two thousandths (every cure but the page line's) or reads the band with the page line on
    // whatever the config (the page line's).
    const curing: [string, (c: TemplateConfig) => Promise<void> | void][] = [
      ["the page line (off)", (c) => { c.pageFooter = false; }],
      ["the logo (10 pt shorter)", (c) => { c.logo = { ...c.logo!, width: c.logo!.width - 2.5 }; }],
      ["the font (Liberation Sans)", (c) => { c.fonts = { ...c.fonts, family: "Liberation Sans" }; }],
      ["the heading size (8)", (c) => { c.fonts = { ...c.fonts, headingSize: 8 }; }],
      ["the company address (one line)", async () => { await setCompany(ONE_LINE); }],
    ];
    it.each(curing)("%s, changed alone from the refused baseline, seeds", async (_why, change) => {
      const baseline = await closingAt(742);
      await expectRefusal(baseline, TALL_LOGO, FIT_SENTENCE);
      const config = structuredClone(baseline);
      await change(config);
      const layout = await seed(config, TALL_LOGO);
      const bottom = Math.max(...layout.items.map((i) => { const b = drawnBox(i, layout); return b.y + b.h; }));
      expect(Math.round(bottom * 1000)).toBeLessThanOrEqual(Math.round(bandTop(layout, config.pageFooter) * 1000) - FIT_CLEARANCE);
    }, 60_000);

    it("the title's label, a wrapping one typed alone over a baseline that seeds (the closing ending at 720), is refused in the canvas sentence", async () => {
      // A title label that wraps under the header's centre column grows the header by a line
      // (measured: "Quotation for heat treating services" ends the closing at 743.44, inside the flow's
      // foot, and draws the stack to 753.44, past the band; the Standard's title seeds, and so does the
      // same label at a heading size of 16, asserted below, and at 12, 10 and 8, measured). Red with the
      // fit clause deleted (the rules then refuse the liability past the band, unmapped), and with the
      // title's label dropped from the sentence.
      const baseline = await closingAt(720);
      const seeded = await unjudged(baseline, TALL_LOGO);
      expect(seeded.stackBottom).toBeLessThan(seeded.band);
      await seed(baseline, TALL_LOGO);
      const config = titleLabel(structuredClone(baseline), "Quotation for heat treating services");
      const u = await unjudged(config, TALL_LOGO);
      expect(u.flowPages).toBe(1);
      expect(u.pass.top(QUOTE_SEED_IDS.sectionEnd("closing"))).toBeLessThanOrEqual(FLOW_FOOT);
      expect(u.stackBottom).toBeGreaterThan(u.band);
      for (const item of u.layout.items) expect(item.box.w, item.kind).toBeGreaterThan(0);
      await expectRefusal(config, TALL_LOGO, FIT_SENTENCE);
      // The heading size cures it: the label is the cause at the Standard's heading size.
      await seed({ ...config, fonts: { ...config.fonts, headingSize: 16 } }, TALL_LOGO);
    }, 60_000);

    it("an empty parties block alone under a tall header-centre logo, starting under its first-table room above the band though drawn clear of it, is refused in the canvas sentence; starting at 720 it seeds", async () => {
      // Every block but the parties hidden, and every parties field: the parties block is empty, drawn
      // the row floor tall, so its drawn bottom clears the band while its top leaves less than the
      // profile's `firstTableRoom` (25 pt) above it, and only the fit check's first-block-room arm
      // refuses it (measured: starting at 726, 730 and 735 pt, the drawn stack ending at 736, 740 and
      // 745, under the band's 748). Red with that arm deleted: the rules then refuse the first table
      // too low for its heading and a row, a TemplateConfigError the route answers 500.
      const lone = (): TemplateConfig => {
        const c = cfg();
        for (const key of ["intro", "column_header", "lines", "closing", "liability"]) section(c, key).visible = false;
        for (const field of section(c, "parties").fields) field.visible = false;
        return c;
      };
      const start = block((await unjudged(lone())).layout, "parties").box.y;
      const at = (target: number): TemplateConfig => {
        const c = lone();
        c.logo = { placement: "header-center", width: (target - start) / 4 };
        return c;
      };
      const room = canvasProfile(QUOTE_CONTRACT).firstTableRoom;
      for (const target of [726, 730, 735]) {
        const config = at(target);
        const u = await unjudged(config, TALL_LOGO);
        expect(u.flowPages).toBe(1);
        const parties = block(u.layout, "parties");
        expect(tablesByY(u.layout).map((t) => t.key), "the parties block alone").toEqual(["parties"]);
        expect(Math.abs(parties.box.y - target), `the block's top at ${target}`).toBeLessThanOrEqual(0.5);
        expect(u.stackBottom, `${target}: drawn clear of the band`).toBeLessThan(u.band);
        expect(parties.box.y + room, `${target}: under its first-table room`).toBeGreaterThan(u.band);
        await expectRefusal(config, TALL_LOGO, FIT_SENTENCE);
      }
      // The arm does not over-refuse: 720 + 25 is under the band's 748.
      const control = at(720);
      const layout = await seed(control, TALL_LOGO);
      expect(block(layout, "parties").box.y + room).toBeLessThanOrEqual(bandTop(layout, control.pageFooter));
    }, 60_000);

    it("the base size, raised alone from 9 to 10 over a baseline that seeds (the closing ending at 736), is refused in the canvas sentence", async () => {
      // The base size moves nothing below the Standard's 9 (measured: the stand-in's closing ends at
      // 356.77 at every base size from 4 to 9, the rows' own sizes setting their heights), so it is
      // shown in the cause direction, by 2.34 pt, inside the 10 pt window. Red with the fit clause
      // deleted (the rules then refuse the liability past the band, unmapped).
      const baseline = await closingAt(736);
      const seeded = await unjudged(baseline, TALL_LOGO);
      expect(seeded.stackBottom).toBeLessThan(seeded.band);
      await seed(baseline, TALL_LOGO);
      const config = structuredClone(baseline);
      config.fonts = { ...config.fonts, baseSize: 10 };
      const u = await unjudged(config, TALL_LOGO);
      expect(u.flowPages).toBe(1);
      expect(u.stackBottom).toBeGreaterThan(u.band);
      await expectRefusal(config, TALL_LOGO, FIT_SENTENCE);
    }, 60_000);

    it("the intro wording, one line more over a baseline that seeds (the closing ending at 736), is refused in the canvas sentence", async () => {
      // The stand-in keeps the template's intro wording: one line more ends the closing at 747.13,
      // inside the flow's foot, and draws the stack past the band. Red with the fit clause deleted
      // (the rules then refuse the liability past the band, unmapped), and with the wording dropped
      // from the sentence.
      const baseline = await closingAt(736);
      const seeded = await unjudged(baseline, TALL_LOGO);
      expect(seeded.stackBottom).toBeLessThan(seeded.band);
      await seed(baseline, TALL_LOGO);
      const config = structuredClone(baseline);
      config.textBlocks.quote_intro_text += "\nMore";
      const u = await unjudged(config, TALL_LOGO);
      expect(u.flowPages).toBe(1);
      expect(u.pass.top(QUOTE_SEED_IDS.sectionEnd("closing"))).toBeLessThanOrEqual(FLOW_FOOT);
      expect(u.stackBottom).toBeGreaterThan(u.band);
      await expectRefusal(config, TALL_LOGO, FIT_SENTENCE);
    }, 60_000);

    it("the liability wording, typed alone over a blank one that seeds, is refused in the canvas sentence where it ends one thousandth above the band's top; four thousandths above it seeds", async () => {
      // Typed, the liability prints its own height under the closing (17.62 pt for one character:
      // its 10 pt margin and a line), past the row floor, so no lift draws it and the drawn stack is
      // the flow's; in the window the Standard's blank liability opens (the closing ending 738 to 748)
      // a typed one pages the stand-in (measured: one character over the 742 baseline prints 2 pages).
      // It reaches the canvas sentence at the clearance: typed over a closing that ends its bottom one
      // thousandth above the band, the flow prints one page and the rules accept it. Red with
      // `FIT_CLEARANCE` at 0, and with the wording dropped from the sentence.
      const band = pageFoot(true);
      const probe = await closingAt(700);
      probe.textBlocks.quote_liability_text = "L";
      const pass = await laid(probe, TALL_LOGO);
      const height = pass.top(QUOTE_SEED_IDS.end("liability")) - pass.top(QUOTE_SEED_IDS.sectionEnd("closing"));
      expect(height).toBeGreaterThan(QUOTE_ROW_FLOOR);

      const baseline = await closingAt(band - 0.001 - height);
      const blank = await unjudged(baseline, TALL_LOGO);
      expect(blank.stackBottom).toBeLessThan(blank.band);
      await seed(baseline, TALL_LOGO);
      const tight = structuredClone(baseline);
      tight.textBlocks.quote_liability_text = "L";
      const u = await unjudged(tight, TALL_LOGO);
      expect(u.flowPages).toBe(1);
      expect(Math.round(u.stackBottom * 1000)).toBe(Math.round(u.band * 1000) - 1);
      expect(() => validateCanvasLayout(u.layout, QUOTE_CONTRACT, { pageFooter: true }), "the rules accept it").not.toThrow();
      await expectRefusal(tight, TALL_LOGO, FIT_SENTENCE);

      const clear = await closingAt(band - 0.004 - height);
      clear.textBlocks.quote_liability_text = "L";
      const layout = await seed(clear, TALL_LOGO);
      const box = drawnBox(block(layout, "liability"), layout);
      expect(Math.round((box.y + box.h) * 1000)).toBe(Math.round(band * 1000) - 4);
    }, 60_000);

    it("a drawn bottom one thousandth above the band's top is refused in the canvas sentence (the clearance); four thousandths above it seeds", async () => {
      // A logo width that draws the liability's bottom (the closing's end and the floor's 10 pt) one
      // thousandth above the band, which the rules accept: only the clearance refuses it. Red with
      // `FIT_CLEARANCE` at 0.
      const band = pageFoot(true);
      const tight = await closingAt(band - QUOTE_ROW_FLOOR - 0.001);
      const u = await unjudged(tight, TALL_LOGO);
      expect(u.flowPages).toBe(1);
      expect(Math.round(u.stackBottom * 1000)).toBe(Math.round(u.band * 1000) - 1);
      expect(() => validateCanvasLayout(u.layout, QUOTE_CONTRACT, { pageFooter: true }), "the rules accept it").not.toThrow();
      await expectRefusal(tight, TALL_LOGO, FIT_SENTENCE);

      const clear = await closingAt(band - QUOTE_ROW_FLOOR - 0.004);
      const layout = await seed(clear, TALL_LOGO);
      const box = drawnBox(block(layout, "liability"), layout);
      expect(Math.round((box.y + box.h) * 1000)).toBe(Math.round(band * 1000) - 4);
      expect(Math.round((box.y + box.h) * 1000)).toBeLessThanOrEqual(Math.round(band * 1000) - FIT_CLEARANCE);
    }, 60_000);
  });
});

// ---------------------------------------------------------------------------------------------
// The preview's canvas half (design 2026-11-12 §4.5, §6, §9; since quote canvas PR 2):
// `renderQuoteCanvasPreview` renders a canvas quote once through `measuredPreview` and answers the
// Design tab's measure, a flow quote through `renderPdf` with none. These cases were written while QUOTE
// stood outside CANVAS_PRINTS (the same PR later put it in, and the route's cases are
// tests/template-preview.test.ts's), so they call the function directly with a config built as
// `{ ...config, layout }` (the layout judged by `validateCanvasLayout`, never through `validateConfig`
// or `renderPreview`), and the data is `readQuotePdfData`'s for a real quote under the settings'
// company and the config's two wordings, as the preview's QUOTE arm builds it. On a canvas a block's
// rows and columns and a field's label live on the layout's items (`canvasCtx`, `labelOf`), so a case
// that hides a row or types a label edits the seeded item, never the config's sections.
// ---------------------------------------------------------------------------------------------

/** The preview's data for `id` under `config`: the settings' company and the config's intro and
 *  liability wording, bound at the data seam as the QUOTE arm binds them. */
async function previewData(id: string, config: TemplateConfig): Promise<QuotePdfData> {
  const settings = await quotePrintSettings();
  return readQuotePdfData(prisma, id, {
    ...settings, introText: config.textBlocks.quote_intro_text, liabilityText: config.textBlocks.quote_liability_text,
  });
}

/** `config` carrying `layout` (judged by the canvas rules first), previewed for `data`: the paper,
 *  the measure and the warnings by name, `canvasWarnings` over the preview's real measure. */
async function previewWarnings(data: QuotePdfData, config: TemplateConfig, layout: CanvasLayout) {
  validateCanvasLayout(layout, QUOTE_CONTRACT, { pageFooter: config.pageFooter });
  const { pdf, measure } = await renderQuoteCanvasPreview(data, { ...config, layout }, undefined);
  expect(measure, "a canvas config answers a measure").not.toBeNull();
  const m: CanvasMeasure = measure!;
  const options = { pageFooter: config.pageFooter, fonts: config.fonts };
  return { pdf, measure: m, named: namedWarnings(layout, canvasWarnings(layout, QUOTE_CONTRACT, m, options)) };
}

/** `layout` with its `key` block's rows or columns shown only where `shown` says so. */
function rowsShown(layout: CanvasLayout, key: string, shown: (rowKey: string) => boolean): CanvasLayout {
  return {
    ...layout,
    items: layout.items.map((item) => (item.kind === "table" && item.key === key
      ? { ...item, columns: item.columns.map((column) => ({ ...column, visible: shown(column.key) })) }
      : item)),
  };
}
/** `layout` with its title item's label typed. */
function titled(layout: CanvasLayout, label: string): CanvasLayout {
  return { ...layout, items: layout.items.map((item) => (item.kind === "field" && item.key === "title" ? { ...item, label } : item)) };
}
/** A Text item `y` below the liability block, 200 wide and one line drawn, of `text`. */
const belowLiability = (text: string, y = 2 * CANVAS_GRID): CanvasItem => ({
  id: "below-liability", kind: "text", text, box: { x: MARGIN, y, w: 200, h: 12 },
  anchor: { kind: "below-table", table: "liability" }, repeat: false, style: { size: 9, bold: false, align: "left" },
});
/** `belowLiability`'s drawn height, one line. */
const DRAWN_TEXT_H = belowLiability("").box.h;
const withItem = (layout: CanvasLayout, item: CanvasItem): CanvasLayout => ({ ...layout, items: [...layout.items, item] });
/** A measured table's entry by key. */
const measured = (m: CanvasMeasure, key: string) => {
  const entry = m.tables.find((t) => t.key === key);
  if (entry === undefined) throw new Error(`no measured ${key}`);
  return entry;
};
/** One company address line more than `TWO_LINES`, the address the seed draws for. */
const THREE_LINES = `${TWO_LINES}\nUnited States`;

type Named = { items: string[]; sentence: string };
/** The seeded Standard's warnings, previewed for the quote it was seeded for: predicted none (design
 *  §6), measured none, for the controller to accept or rule on (the composed case below). */
const QUOTE_ACCEPTED_WARNINGS: Named[] = [];
/** The taller company address's warnings, measured: the address printed one line taller than drawn
 *  (b) also runs into the parties block drawn about 10 pt under it (a); (a) is listed first, as
 *  `canvasWarnings` lists its families. Predicted so by the plan. */
const TALLER_ADDRESS_WARNINGS = (taller: Named): Named[] => [
  {
    items: ["company_address", "parties"],
    sentence: "The Company address field and the Attention / quote fields table overlap; one prints over the other.",
  },
  taller, ...QUOTE_ACCEPTED_WARNINGS,
];
/** The wrapped title's warnings, measured: the title printed a heading line taller than drawn (b)
 *  runs into the company name drawn under it AND, past that 15 pt name, into the company address
 *  (a, twice). The plan predicted (a) against the company name alone; the address pair is the same
 *  growth's, a heading line (23.44 pt) being taller than the name it crosses. */
const WRAPPED_TITLE_WARNINGS = (taller: Named): Named[] => [
  { items: ["title", "company_name"], sentence: "The Document title field and the Company name field overlap; one prints over the other." },
  { items: ["title", "company_address"], sentence: "The Document title field and the Company address field overlap; one prints over the other." },
  taller, ...QUOTE_ACCEPTED_WARNINGS,
];
/** Warning (b)'s sentence for `name` (its item named `item`), printed `by` pt taller than drawn. */
const tallerThanDrawn = (item: string, name: string, by: number): Named => ({
  items: [item], sentence: `${name} is taller than its box by ${Math.round(by * 100) / 100} pt and prints over what is drawn under it.`,
});

describe("renderQuoteCanvasPreview", () => {
  it("a canvas config's measure holds the six blocks, one region a block, the blank liability at 0 pt, and every item with a height", async () => {
    const config = cfg();
    expect(config.textBlocks.quote_liability_text, "the Standard's liability wording is blank").toBe("");
    const layout = await seed(config);
    const data = await previewData(quoteId, config);
    const { pdf, measure } = await renderQuoteCanvasPreview(data, { ...config, layout }, undefined);
    expect(measure).not.toBeNull();
    const m = measure!;
    expect(pageCount(pdf)).toBe(1);
    expect(m.pages).toBe(1);
    expect(m.tables.map((t) => t.key)).toEqual(BLOCKS);
    // One region a block, exactly: a spare region reds here (the invoice PR 3 lesson).
    expect(m.regions).toHaveLength(tablesByY(layout).length);
    for (const t of m.tables) {
      expect(typeof t.height, t.key).toBe("number");
      if (t.key !== "liability") expect(t.height, t.key).toBeGreaterThan(0);
    }
    expect(Math.abs(measured(m, "liability").height), "the blank liability prints nothing").toBeLessThanOrEqual(0.005);
    expect(printsNothing(block(layout, "liability"), m)).toBe(true);
    for (const t of tablesByY(layout).filter((t) => t.key !== "liability")) expect(printsNothing(t, m), t.key).toBe(false);
    for (const item of layout.items.filter((i) => i.kind !== "table")) {
      const entry = m.items.find((candidate) => candidate.id === item.id);
      expect(entry, item.id).toBeDefined();
      expect(entry!.height, item.id).toBeGreaterThan(0);
      expect(entry, item.id).toMatchObject({ page: 1, left: item.box.x, top: item.box.y });
    }
  }, 60_000);

  it("the liability measures above 0 with its wording typed, and the intro above 0 with its wording blank: #958's hatch never reaches the intro", async () => {
    const layout = await seed(cfg());
    const withWording = typed();
    const wording = (await previewWarnings(await previewData(quoteId, withWording), withWording, layout)).measure;
    expect(measured(wording, "liability").height).toBeGreaterThan(0);
    expect(printsNothing(block(layout, "liability"), wording)).toBe(false);

    const blankIntro = cfg();
    blankIntro.textBlocks.quote_intro_text = "";
    const data = await previewData(quoteId, blankIntro);
    expect(data.introText, "the premise: the intro's wording is blank").toBe("");
    const m = (await previewWarnings(data, blankIntro, layout)).measure;
    // PR 1 measured a blank intro at one full line (11.13 pt in Roboto): the flow's text node prints
    // an empty line, so the intro never measures 0 and is never hatched.
    expect(measured(m, "intro").height).toBeGreaterThan(0);
    expect(printsNothing(block(layout, "intro"), m)).toBe(false);
  }, 60_000);

  it("a deleted quote's preview measures its lines block at 0 pt (design §4.5)", async () => {
    const layout = await seed(cfg());
    await asSystem(() => deleteQuote(quoteId, "test"));
    const data = await previewData(quoteId, cfg());
    expect(data.lines, "the premise: the deleted quote's preview has no line").toEqual([]);
    const { measure } = await previewWarnings(data, cfg(), layout);
    expect(Math.abs(measured(measure, "lines").height)).toBeLessThanOrEqual(0.005);
    expect(printsNothing(block(layout, "lines"), measure)).toBe(true);
  }, 60_000);

  it("the column headers measure 0 pt with every column hidden, and the parties with every row hidden", async () => {
    const layout = await seed(cfg());
    const data = await previewData(quoteId, cfg());
    const noColumns = rowsShown(layout, "column_header", () => false);
    const a = (await previewWarnings(data, cfg(), noColumns)).measure;
    expect(Math.abs(measured(a, "column_header").height)).toBeLessThanOrEqual(0.005);
    expect(printsNothing(block(noColumns, "column_header"), a)).toBe(true);
    expect(printsNothing(block(noColumns, "parties"), a)).toBe(false);

    const noRows = rowsShown(layout, "parties", () => false);
    const b = (await previewWarnings(data, cfg(), noRows)).measure;
    expect(Math.abs(measured(b, "parties").height)).toBeLessThanOrEqual(0.005);
    expect(printsNothing(block(noRows, "parties"), b)).toBe(true);
    expect(printsNothing(block(noRows, "column_header"), b)).toBe(false);
  }, 60_000);

  it("the parties measure 0 pt under a template showing only the Attn line and the two phones, on a quote with no contact and blank phones (#958's data case)", async () => {
    await setSetting("company_phone", "");
    const layout = await seed(cfg());
    const data = await previewData(quoteId, cfg());
    // The premises: no contact (so no Attn line), no customer phone and no company phone.
    expect(data.attn).toBe("");
    expect(data.customerPhone).toBe("");
    expect(data.company.phone).toBe("");
    const shown = new Set(["attn", "company_phone", "customer_phone"]);
    const blankable = rowsShown(layout, "parties", (key) => shown.has(key));
    const { measure } = await previewWarnings(data, cfg(), blankable);
    expect(Math.abs(measured(measure, "parties").height)).toBeLessThanOrEqual(0.005);
    expect(printsNothing(block(blankable, "parties"), measure)).toBe(true);
    // The neighbour: one more row shown (the terms, which keeps its label) prints the block.
    const withTerms = rowsShown(layout, "parties", (key) => shown.has(key) || key === "terms");
    const printed = (await previewWarnings(data, cfg(), withTerms)).measure;
    expect(measured(printed, "parties").height).toBeGreaterThan(0);
  }, 60_000);

  it("a placed closing with every row hidden measures above 0, its 230 pt rule printing, so it is never hatched", async () => {
    const layout = rowsShown(await seed(cfg()), "closing", () => false);
    const { pdf, measure } = await previewWarnings(await previewData(quoteId, cfg()), cfg(), layout);
    expect(measured(measure, "closing").height).toBeGreaterThan(0);
    expect(printsNothing(block(layout, "closing"), measure)).toBe(false);
    const rule = strokedLines(pdf)[0].filter((l) => Math.abs(l.y1 - l.y2) < 0.01 && Math.abs(Math.abs(l.x2 - l.x1) - QUOTE_WIDTHS.signature) < 0.01);
    expect(rule, "the signature rule prints").toHaveLength(1);
  }, 60_000);

  // (pin) The task's mutation (a canvas config rendered bare) leaves a flow config as it is; it reds
  // when the null-layout branch is dropped (the flow config then reaches `quoteCanvasItemContent`,
  // which throws).
  it("a flow config's preview answers no measure, and its text is today's flow render (pin)", async () => {
    const data = await previewData(quoteId, cfg());
    const { pdf, measure } = await renderQuoteCanvasPreview(data, cfg(), undefined);
    expect(measure).toBeNull();
    expect(textRunsWithY(pdf)).toEqual(textRunsWithY(await renderPdf(buildQuoteDefinition(data, cfg()))));
  }, 60_000);

  it("composed: the seeded Standard, previewed for the quote it was seeded for, warns of the accepted set", async () => {
    const layout = await seed(cfg());
    const { measure, named } = await previewWarnings(await previewData(quoteId, cfg()), cfg(), layout);
    expect(named).toEqual(QUOTE_ACCEPTED_WARNINGS);
    const ids = new Set(measure.items.map((item) => item.id));
    expect(layout.items.filter((item) => item.kind !== "table" && !ids.has(item.id))).toEqual([]);
  }, 60_000);

  it("warning (b) on the company address: previewed under one more address line than the seed drew, it is warned taller than drawn", async () => {
    const layout = await seed(cfg());
    const address = fieldItem(layout, "company_address")!;
    // The neighbour first: under the seed's own two-line address the set is the accepted one.
    const before = await previewData(quoteId, cfg());
    expect((await previewWarnings(before, cfg(), layout)).named).toEqual(QUOTE_ACCEPTED_WARNINGS);

    await setCompany(THREE_LINES);
    const data = await previewData(quoteId, cfg());
    // The premise: the address prints one line more than the seed drew it for.
    expect(QUOTE_FLOW.addressLines(data)).toHaveLength(QUOTE_FLOW.addressLines(before).length + 1);
    const { measure, named } = await previewWarnings(data, cfg(), layout);
    const printed = measure.items.find((entry) => entry.id === address.id)!.height;
    expect(printed).toBeGreaterThan(address.box.h);
    const taller = tallerThanDrawn("company_address", "The Company address field", printed - address.box.h);
    expect(named).toContainEqual(taller);
    expect(named).toEqual(TALLER_ADDRESS_WARNINGS(taller));
  }, 60_000);

  it("warning (b) on a typed title that wraps to a second line in its box", async () => {
    const layout = await seed(cfg());
    const data = await previewData(quoteId, cfg());
    const title = fieldItem(layout, "title")!;
    // The neighbour first: the seeded one-word title fits its line, and the set is the accepted one.
    expect((await previewWarnings(data, cfg(), layout)).named).toEqual(QUOTE_ACCEPTED_WARNINGS);
    // A one-word title grows no taller (it overflows to the side), so (b), which compares heights,
    // needs words that wrap.
    const long = titled(layout, "Quotation for heat treating services");
    const { measure, named } = await previewWarnings(data, cfg(), long);
    const printed = measure.items.find((entry) => entry.id === title.id)!.height;
    // The premise: the title wraps, two lines where the seed drew one.
    expect(printed).toBeGreaterThan(1.5 * title.box.h);
    const taller = tallerThanDrawn("title", "The Document title field", printed - title.box.h);
    expect(named).toContainEqual(taller);
    expect(named).toEqual(WRAPPED_TITLE_WARNINGS(taller));
  }, 60_000);

  it("the measured warning (c): a Text item below the liability whose measured bottom runs past the page's foot would be cut off", async () => {
    const config = cfg();
    const seeded = await seed(config);
    const data = await previewData(quoteId, config);
    const foot = bandTop(seeded, config.pageFooter);
    // The neighbour first: a text that grows past its drawn line but ends above the foot is warned
    // taller than drawn and nothing else.
    const shorter = withItem(seeded, belowLiability("Thank you for your business. ".repeat(12).trim()));
    const grows = await previewWarnings(data, config, shorter);
    const grown = grows.measure.items.find((entry) => entry.id === "below-liability")!;
    expect(grown.top + grown.height).toBeLessThan(foot);
    expect(grows.named).toEqual([tallerThanDrawn("text", "The Text (text)", grown.height - DRAWN_TEXT_H), ...QUOTE_ACCEPTED_WARNINGS]);

    const layout = withItem(seeded, belowLiability("Thank you for your business. ".repeat(110).trim()));
    const { measure, named } = await previewWarnings(data, config, layout);
    const entry = measure.items.find((candidate) => candidate.id === "below-liability")!;
    const region = measure.regions.find((r) => r.after === "liability")!;
    expect(entry.page).toBe(region.page);
    const bottom = Math.round((entry.top + entry.height) * 100) / 100;
    expect(bottom).toBeGreaterThan(foot);
    // (c) arrives only beside (b): rule 8 bounds a region by its drawn heights, so only the item's
    // own growth carries it past the foot. With the page line on (the quote's default), the foot is
    // the page line's room's top, which the sentence names.
    const cut = {
      items: ["text"],
      sentence: `The Text (text) ends at ${bottom} pt, past ${foot}, where the page line's room begins, and would be cut off.`,
    };
    expect(named).toContainEqual(cut);
    expect(named).toEqual([tallerThanDrawn("text", "The Text (text)", entry.height - DRAWN_TEXT_H), cut, ...QUOTE_ACCEPTED_WARNINGS]);
  }, 60_000);

  it("a page-2 item: the seeded Standard with a Text item below the liability, previewed for a 40-line quote, is measured and staged on the page it laid out on, and warns of the accepted set", async () => {
    const customer = await makeCustomer();
    await makeBillTo(customer.id);
    const big = await quoteFor(customer, { lines: 40 });
    const seeded = await seed(cfg());
    expect(seeded.items.some((i) => i.kind !== "table" && i.anchor.kind === "below-table")).toBe(false);
    const added = belowLiability("Thank you for your business");
    const layout = withItem(seeded, added);
    const { pdf, measure, named } = await previewWarnings(await previewData(big.id, cfg()), cfg(), layout);
    expect(measure.pages).toBeGreaterThanOrEqual(2);
    expect(pageCount(pdf)).toBe(measure.pages);
    const entry = measure.items.find((item) => item.id === added.id)!;
    const region = measure.regions.find((r) => r.after === "liability")!;
    expect(entry.page).toBe(region.page);
    expect(entry.page).toBeGreaterThan(1);
    const staged = stageBox(added, layout, measure);
    expect(staged.page).toBe(entry.page);
    expect(staged.measured).toBe(true);
    // Its staged box is its drawn box below the liability's region, as tall as drawn or as measured
    // (red when stageBox's below-table arm drops the region's top).
    expect(staged.box).toEqual({ ...added.box, y: region.top + added.box.y, h: Math.max(added.box.h, entry.height) });
    // The stage titles it by its page and the record, and a drag starts from its drawn box.
    expect(DESIGNER_WORDS.printsOnPage(staged.page, "QUOTE")).toBe(`Prints on page ${entry.page} for this quote`);
    expect(dragStart(added, layout, measure)).toEqual(drawnBox(added, layout));
    expect(stageBox(fieldItem(layout, "quote_number")!, layout, measure).page).toBe(1);
    // The accepted set: no (c) for a region that moved whole and fits.
    expect(named).toEqual(QUOTE_ACCEPTED_WARNINGS);
  }, 120_000);
});

describe("the seed meets the raised least widths (#971)", () => {
  const each = (width: number): TemplateConfig => {
    const c = cfg();
    section(c, "column_header").fields.find((f) => f.key === "col_each_weight")!.width = width;
    return c;
  };
  const atFloors = (layout: CanvasLayout, config: TemplateConfig) => {
    const tables = layout.items.filter((i) => i.kind === "table");
    expect(tables.length).toBeGreaterThan(0);
    for (const item of tables) {
      expect(item.box.w, item.id).toBeGreaterThanOrEqual(leastWidth(QUOTE_CONTRACT, item, { fonts: config.fonts, layout }));
    }
  };
  it("draws every table at or above its floor from the standard config, and the lines above the floor a widened grid raises", async () => {
    atFloors(await seedQuoteLayout(quoteId, cfg(), undefined), cfg());
    // The column headers' Each weight column typed 86 (from 66): the lines' floor is 250.5.
    const wide = each(86);
    const layout = await seedQuoteLayout(quoteId, wide, undefined);
    const lines = layout.items.find((i) => i.kind === "table" && i.key === "lines")!;
    expect(leastWidth(QUOTE_CONTRACT, lines, { layout })).toBe(250.5);
    atFloors(layout, wide);
  });
  it("refuses, as a 400, column headers past the page in rule 9's sentence, and a grid past it first in rule 4's", async () => {
    await expectRefusal(each(388), undefined,
      "The Column headers table needs 564.5 pt: its visible columns' 524 pt, their 36 pt of padding and rules and one grid " +
      "step, more than its 564 pt.");
    await expectRefusal(each(404), undefined,
      "The Quote lines and prices table is 564 pt wide, less than the 568.5 pt the column headers' columns, their gaps and " +
      "one grid step need.");
  });
});
