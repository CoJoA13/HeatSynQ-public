import { describe, it, expect, vi } from "vitest";
import type { Content } from "pdfmake/interfaces";
import LayoutBuilderModule from "pdfmake/js/LayoutBuilder.js";
import { PAGE_LINE_ROOM } from "@/lib/template-canvas";
import { createRequire } from "node:module";
import ColumnCalculatorModule from "pdfmake/js/columnCalculator.js";
import {
  KEEP_IN_BOX_TOLERANCE, PDFMAKE_INTERNALS_VERSION, installBandFrame, installColumnClamp, layOutSheetGroups, renderPdf,
  renderSheetGroups, renderSheetGroupsWithPositions,
} from "@/server/pdf/render";
import type { LaidOutNode, RenderableDefinition } from "@/server/pdf/render";
import { CANVAS_TABLE_ID_PREFIX, blockAt } from "@/server/pdf/canvas-nodes";
import { drawnPages, drawnText, pageCount, pageStreams, strokedLines, textLinesWithY, textRunsWithY } from "./helpers/pdf";
import { logColumnWidths, type ColumnEvent } from "./helpers/column-log";

/**
 * The traveler canvas's two render primitives (PR B of #926, task 1): the page-bottom band spec,
 * which render.ts turns into pdfmake's footer callback, and `renderSheetGroupsWithPositions`, which
 * answers where each id'd node was laid out. Pure: no database, the house content readers on the
 * rendered bytes (renders are not byte-deterministic, so nothing here compares two renders' bytes).
 *
 * COORDINATES. `textLinesWithY` reports a line's BASELINE in PDF device space, y measured from the
 * page's BOTTOM edge (larger is higher on the paper). The band's items are written in PAGE
 * coordinates, y from the TOP. So the band is not asserted through font arithmetic: a control
 * render places the same `absolutePosition` node in the BODY of a one-page definition with the same
 * margins, and the band's line must decode to the control's baseline. That proves the footer-frame
 * translation exactly: an untranslated item would sit 708 pt further down, outside the frame.
 */

/** Every definition here names LETTER: pdfmake's own default page is A4. */
const PAGE_HEIGHT = 792;
const BAND = 60;
/** 24 on three sides, and the bottom margin is 24 plus the band, so the band's top is 792 − 84 = 708. */
const MARGINS: [number, number, number, number] = [24, 24, 24, 24 + BAND];
const BAND_TOP = PAGE_HEIGHT - MARGINS[3];
const SIGN: Content = { text: "SIGN HERE", absolutePosition: { x: 24, y: BAND_TOP } };

/** A body that runs past one page under MARGINS: one text node of short lines. */
const longBody = (): Content => ({ text: Array.from({ length: 60 }, () => "body line").join("\n") });

/** The band holding SIGN HERE: in `repeated` (every page) when `repeat`, else in `content` (the last
 *  page only). */
const bandDef = (repeat: boolean, extra: Partial<RenderableDefinition> = {}): RenderableDefinition => ({
  pageSize: "LETTER",
  pageMargins: MARGINS,
  content: [longBody()],
  pageBottomBandSpec: { height: BAND, content: repeat ? [] : [SIGN], repeated: repeat ? [SIGN] : [] },
  ...extra,
});

const linesOf = (pdf: Buffer, page: number, text: string) =>
  textLinesWithY(pdf)[page].filter((line) => line.text === text);

/** The baseline, device y from the bottom, of a `SIGN HERE` placed at the band's top in the body.
 *  The control's bottom margin is 24, not the band's 84: a body node at page y 708 under an 84 pt
 *  bottom margin has no room left and pdfmake would not draw it. A baseline does not depend on it. */
async function controlBaseline(): Promise<number> {
  const pdf = await renderPdf({ pageSize: "LETTER", pageMargins: 24, content: [{ text: "control" }, SIGN] });
  const [line] = linesOf(pdf, 0, "SIGN HERE");
  return line.y;
}

describe("pageBottomBandSpec", () => {
  it("prints the band's items on the last page only, translated into the footer frame, and reserves the band on every page", async () => {
    const expected = await controlBaseline();
    // The control anchors the comparison to the band's top: its baseline is an ascent (under 14 pt
    // at the default 12 pt) below page y 708.
    expect(PAGE_HEIGHT - expected).toBeGreaterThan(BAND_TOP);
    expect(PAGE_HEIGHT - expected).toBeLessThan(BAND_TOP + 14);
    const pdf = await renderPdf(bandDef(false));
    expect(pageCount(pdf)).toBe(2);
    const lines = textLinesWithY(pdf);
    // Page 2 holds the band's item at the control's baseline: within 2 pt of the band's top, y 708.
    const [sign] = linesOf(pdf, 1, "SIGN HERE");
    expect(sign).toBeDefined();
    expect(Math.abs(sign.y - expected)).toBeLessThan(2);
    expect(linesOf(pdf, 1, "SIGN HERE")).toHaveLength(1);
    // Page 1 does not.
    expect(linesOf(pdf, 0, "SIGN HERE")).toHaveLength(0);
    // Page 1's body ends above the band: its lowest baseline is above the band's top (device y 84).
    const body = lines[0].filter((line) => line.text === "body line");
    expect(body.length).toBeGreaterThan(0);
    expect(Math.min(...body.map((line) => line.y))).toBeGreaterThan(PAGE_HEIGHT - BAND_TOP);
  });

  it("an item in `repeated` prints on every page while an item in `content` prints on the last page only", async () => {
    const expected = await controlBaseline();
    // Both in one band, so the case tells the two lists apart: SIGN HERE repeated, LAST ONLY not.
    // LAST ONLY 20 pt under SIGN HERE, on a baseline of its own (one baseline is one decoded line).
    const last: Content = { text: "LAST ONLY", absolutePosition: { x: 24, y: BAND_TOP + 20 } };
    const pdf = await renderPdf({
      ...bandDef(true),
      pageBottomBandSpec: { height: BAND, content: [last], repeated: [SIGN] },
    });
    expect(pageCount(pdf)).toBe(2);
    for (const page of [0, 1]) {
      // Device y from the bottom: both at the control's baseline, in the band.
      const signs = linesOf(pdf, page, "SIGN HERE");
      expect(signs).toHaveLength(1);
      expect(Math.abs(signs[0].y - expected)).toBeLessThan(2);
    }
    expect(linesOf(pdf, 0, "LAST ONLY")).toHaveLength(0);
    const [lastLine] = linesOf(pdf, 1, "LAST ONLY");
    expect(lastLine).toBeDefined();
    expect(Math.abs(lastLine.y - (expected - 20))).toBeLessThan(2);
  });

  it("composes with the page line: the items above and 'Page 1 of 2' under the band on each page", async () => {
    const pdf = await renderPdf(bandDef(true, { pageFooterSpec: { kind: "pageNofM" } }));
    expect(pageCount(pdf)).toBe(2);
    for (const page of [0, 1]) {
      const [sign] = linesOf(pdf, page, "SIGN HERE");
      const [pageLine] = linesOf(pdf, page, `Page ${page + 1} of 2`);
      expect(sign).toBeDefined();
      expect(pageLine).toBeDefined();
      // Under the band: below the item, and below the band's bottom edge (page y 768, device y 24).
      // Without the band's height in its margin the line would sit at page y 716, device y ≈ 68.
      expect(pageLine.y).toBeLessThan(sign.y);
      expect(pageLine.y).toBeLessThan(PAGE_HEIGHT - (BAND_TOP + BAND));
      expect(pageLine.y).toBeGreaterThan(0);
    }
  });

  it("prints the page line alone where the band's items are not shown (a last-page band on page 1)", async () => {
    const pdf = await renderPdf(bandDef(false, { pageFooterSpec: { kind: "pageNofM" } }));
    const pages = drawnPages(pdf);
    expect(pages[0]).toContain("Page 1 of 2");
    expect(pages[0]).not.toContain("SIGN HERE");
    expect(pages[1]).toContain("Page 2 of 2");
    expect(pages[1]).toContain("SIGN HERE");
  });

  it("puts a pageFooterSpec's above strip under the band with the page line, on each page", async () => {
    // No ruling covers a band beside `above` (no builder passes both yet): the renderer's choice is
    // that everything that flows in the footer sits under the band.
    const pdf = await renderPdf(bandDef(true, {
      pageMargins: [24, 24, 24, 24 + BAND + 12],
      pageFooterSpec: { kind: "pageNofM", above: { text: "STRIP" } },
    }));
    for (const page of [0, 1]) {
      const [sign] = linesOf(pdf, page, "SIGN HERE");
      const [strip] = linesOf(pdf, page, "STRIP");
      const [pageLine] = linesOf(pdf, page, `Page ${page + 1} of 2`);
      expect(sign.y).toBeGreaterThan(strip.y);
      expect(strip.y).toBeGreaterThan(pageLine.y);
      // The strip starts under the band: the band's top sits at page y 696 here, its bottom at 756.
      expect(strip.y).toBeLessThan(PAGE_HEIGHT - 756);
    }
  });

  it("refuses a raw footer beside a band spec", async () => {
    await expect(renderPdf(bandDef(false, { footer: { text: "hand-written" } })))
      .rejects.toThrow(/footer/);
    await expect(renderPdf(bandDef(false, { footer: { text: "hand-written" } })))
      .rejects.toThrow(/pageBottomBandSpec/);
  });

  it("leaves the spec's own nodes untranslated, so a second render prints the band in the same place", async () => {
    const def = bandDef(false);
    const first = linesOf(await renderPdf(def), 1, "SIGN HERE")[0].y;
    const second = linesOf(await renderPdf(def), 1, "SIGN HERE")[0].y;
    expect(second).toBeCloseTo(first, 1);
    expect(def.pageBottomBandSpec?.content).toEqual([SIGN]);
    const repeated = bandDef(true);
    const once = linesOf(await renderPdf(repeated), 0, "SIGN HERE")[0].y;
    const again = linesOf(await renderPdf(repeated), 0, "SIGN HERE")[0].y;
    expect(again).toBeCloseTo(once, 1);
    expect(repeated.pageBottomBandSpec?.repeated).toEqual([SIGN]);
  });
});

/**
 * The band's bottom edge (#978): a band item's lines that pass it are dropped whole, with the page
 * line off or on, and everything that fits prints where it printed before the fix. Every figure
 * below is a baseline, device y from `textRunsWithY` (unrounded), recorded on the base `1d3d2147`
 * before the fix (the ledger, docs/execution/2026-11-14-978-band-clip/progress.md, Task 1 Step 1).
 */
describe("pageBottomBandSpec — the band's bottom edge (#978)", () => {
  /** pdfmake's own layout engine, unwrapped as render.ts unwraps it. */
  const LayoutBuilder =
    (LayoutBuilderModule as unknown as { default?: typeof LayoutBuilderModule }).default ?? LayoutBuilderModule;
  /** A canvas Text item's shape (`inBoxWidth`): 60 repeats of "Band clip words " at 10 pt in a 200 pt
   *  box at page y `top`. Alone it lays out seven lines 11.71875 pt apart, past a 60 pt band. */
  const overflowing = (top: number): Content => ({
    absolutePosition: { x: 24, y: top },
    stack: [{ columns: [{ width: 200, stack: [{ text: "Band clip words ".repeat(60).trim(), fontSize: 10 }] }], columnGap: 0 }],
  });
  /** The distinct baselines the overflowing item prints at on a page, top first. */
  const clipBaselines = (pdf: Buffer, page: number): number[] =>
    [...new Set(textRunsWithY(pdf)[page].filter((run) => /^(Band|clip|words)\s*$/.test(run.text)).map((run) => run.y))]
      .sort((a, b) => b - a);
  /** The baseline of the page line's first run ("Page "), unrounded. */
  const pageLineY = (pdf: Buffer, page: number): number => {
    const runs = textRunsWithY(pdf)[page].filter((run) => run.text.startsWith("Page"));
    expect(runs).toHaveLength(1);
    return runs[0].y;
  };
  const expectBaselines = (actual: number[], expected: number[]) => {
    expect(actual).toHaveLength(expected.length);
    expected.forEach((y, index) => expect(actual[index]).toBeCloseTo(y, 2));
  };
  /** The 10 pt line pitch: the spacing of the overflowing item's baselines. */
  const LINE = 11.71875;
  /** The base's seven baselines with the page line off (band 708 to 768), page y 717.28 to 787.59:
   *  the first five end above 768 and print, the last two (775.87, 787.59) are dropped. */
  const CUT_OFF = [74.722656, 63.003906, 51.285156, 39.566406, 27.847656];
  /** The base's eight with the page line on (band 688 to 748, bottom margin 104), the last three
   *  printing over and under the page line before the fix; the first five print. */
  const CUT_ON = [94.722656, 83.003906, 71.285156, 59.566406, 47.847656];
  /** The page line's baseline under a band, bottom margin 24 + 60 + 20 (page y 763.89). */
  const PAGE_LINE_Y = 28.114258;
  /** `bandDef`'s SIGN HERE (page y 708) under that raised margin. */
  const SIGN_Y = 72.867188;
  const ON_MARGINS: [number, number, number, number] = [24, 24, 24, 24 + BAND + PAGE_LINE_ROOM];
  const ON_TOP = PAGE_HEIGHT - ON_MARGINS[3];
  const short: Content = { text: "short body" };

  it("drops a band item's lines that pass the band's bottom edge, with the page line off", async () => {
    const pdf = await renderPdf({
      pageSize: "LETTER", pageMargins: MARGINS, content: [short],
      pageBottomBandSpec: { height: BAND, content: [overflowing(BAND_TOP)], repeated: [] },
    });
    expect(pageCount(pdf)).toBe(1);
    const baselines = clipBaselines(pdf, 0);
    expectBaselines(baselines, CUT_OFF);
    for (const y of baselines) expect(PAGE_HEIGHT - y).toBeLessThanOrEqual(PAGE_HEIGHT - 24);
  });

  it("drops a band item's lines that pass the band's bottom edge, with the page line on", async () => {
    const pdf = await renderPdf({
      pageSize: "LETTER", pageMargins: ON_MARGINS, content: [short],
      pageBottomBandSpec: { height: BAND, content: [overflowing(ON_TOP)], repeated: [] },
      pageFooterSpec: { kind: "pageNofM" },
    });
    expect(pageCount(pdf)).toBe(1);
    const baselines = clipBaselines(pdf, 0);
    expectBaselines(baselines, CUT_ON);
    for (const y of baselines) expect(PAGE_HEIGHT - y).toBeLessThanOrEqual(PAGE_HEIGHT - 24 - PAGE_LINE_ROOM);
    expect(textLinesWithY(pdf)[0].map((line) => line.text)).toContain("Page 1 of 1");
    expect(pageLineY(pdf, 0)).toBeCloseTo(PAGE_LINE_Y, 2);
  });

  it("drops them on every page for a repeated item, and a last-page item after it still prints", async () => {
    const last: Content = { text: "LAST ONLY", absolutePosition: { x: 300, y: BAND_TOP + 12 } };
    const pdf = await renderPdf({
      pageSize: "LETTER", pageMargins: MARGINS, content: [longBody()],
      pageBottomBandSpec: { height: BAND, content: [last], repeated: [overflowing(BAND_TOP)] },
    });
    expect(pageCount(pdf)).toBe(2);
    for (const page of [0, 1]) expectBaselines(clipBaselines(pdf, page), CUT_OFF);
    expect(linesOf(pdf, 0, "LAST ONLY")).toHaveLength(0);
    const runs = textRunsWithY(pdf)[1].filter((run) => run.text.startsWith("LAST"));
    expect(runs).toHaveLength(1);
    expect(runs[0].y).toBeCloseTo(60.867188, 2);
  });

  it("prints a band item that fits where it printed before", async () => {
    const pdf = await renderPdf(bandDef(true, { pageMargins: ON_MARGINS, pageFooterSpec: { kind: "pageNofM" } }));
    expect(pageCount(pdf)).toBe(2);
    for (const page of [0, 1]) {
      const signs = textRunsWithY(pdf)[page].filter((run) => run.text.startsWith("SIGN"));
      expect(signs).toHaveLength(1);
      expect(signs[0].y).toBeCloseTo(SIGN_Y, 2);
      expect(pageLineY(pdf, page)).toBeCloseTo(PAGE_LINE_Y, 2);
    }
    // Two lines whose second ends 0.25 pt above the band's bottom edge (page y 767.75): both print.
    const edge: Content = {
      absolutePosition: { x: 24, y: PAGE_HEIGHT - 24 - 2 * LINE - 0.25 },
      stack: [{ columns: [{ width: 200, stack: [{ text: "EDGE ONE\nEDGE TWO", fontSize: 10 }] }], columnGap: 0 }],
    };
    const atEdge = await renderPdf({
      pageSize: "LETTER", pageMargins: MARGINS, content: [short],
      pageBottomBandSpec: { height: BAND, content: [edge], repeated: [] },
    });
    const [one] = linesOf(atEdge, 0, "EDGE ONE");
    const [two] = linesOf(atEdge, 0, "EDGE TWO");
    expect(one).toBeDefined();
    expect(two).toBeDefined();
    expect(one.y - two.y).toBeCloseTo(LINE, 0);
  });

  it("prints a line ending 0.004 pt past the band's bottom edge and drops one ending 0.006 pt past (the warnings' two decimals)", async () => {
    // One 10 pt line (LINE tall) whose bottom lands `past` points below the edge at page y 768.
    const oneLine = async (past: number, text: string) => textLinesWithY(await renderPdf({
      pageSize: "LETTER", pageMargins: MARGINS, content: [short],
      pageBottomBandSpec: {
        height: BAND, repeated: [],
        content: [{
          absolutePosition: { x: 24, y: PAGE_HEIGHT - 24 - LINE + past },
          stack: [{ columns: [{ width: 200, stack: [{ text, fontSize: 10 }] }], columnGap: 0 }],
        }],
      },
    }))[0].filter((line) => line.text === text);
    expect(await oneLine(0.004, "UNDER TOLERANCE")).toHaveLength(1);
    expect(await oneLine(0.006, "PAST TOLERANCE")).toHaveLength(0);
  });

  it("keeps the page line where it was on a two-pass render, and above beside a band", async () => {
    // Bottom margin 24 + 60 + 20 + 16; a body that pages, so the second pass raises the top to 48.
    const bottom = 24 + BAND + PAGE_LINE_ROOM + 16;
    const pdf = await renderPdf({
      pageSize: "LETTER", pageMargins: [24, 24, 24, bottom], content: [longBody()],
      continuationHeaderSpec: { content: { text: "CONT", margin: [24, 24, 24, 0] }, overflowTopMargin: 48 },
      pageBottomBandSpec: {
        height: BAND, content: [], repeated: [{ text: "SIGN HERE", absolutePosition: { x: 24, y: PAGE_HEIGHT - bottom } }],
      },
      pageFooterSpec: { kind: "pageNofM", above: { text: "STRIP", margin: [24, 0, 0, 0] } },
    });
    expect(pageCount(pdf)).toBe(2);
    expect(linesOf(pdf, 1, "CONT")).toHaveLength(1);
    for (const page of [0, 1]) {
      const runs = textRunsWithY(pdf)[page];
      expect(runs.find((run) => run.text.startsWith("SIGN"))?.y).toBeCloseTo(108.867188, 2);
      expect(runs.find((run) => run.text === "STRIP")?.y).toBeCloseTo(48.867188, 2);
      expect(pageLineY(pdf, page)).toBeCloseTo(30.051758, 2);
    }
  });

  it("installs the band frame once", () => {
    const before = LayoutBuilder.prototype.addHeadersAndFooters;
    installBandFrame();
    expect(LayoutBuilder.prototype.addHeadersAndFooters).toBe(before);
  });

  it("refuses at install a pdfmake whose LayoutBuilder lacks a method the wrapper needs", () => {
    const proto = LayoutBuilder.prototype as unknown as Record<string, unknown>;
    for (const name of ["addHeadersAndFooters", "addDynamicRepeatable"]) {
      const saved = proto[name];
      proto[name] = undefined;
      try {
        expect(() => installBandFrame()).toThrow(new RegExp(`LayoutBuilder.prototype.${name} is not a function`));
      } finally {
        proto[name] = saved;
      }
    }
    expect(() => installBandFrame()).not.toThrow();
  });

  it("prints a canvas Line and a canvas Box that end at the band's bottom edge; a vector node 1 pt past it is not cut", async () => {
    // FINDING, not the text rule: pdfmake cuts a TEXT line that does not fit the frame, but an
    // absolutePosition canvas node (a Line, a Box) is drawn by `addVector` with no fit check, so one
    // drawn past the band's edge still prints. The band frame therefore cuts text only (#978); the
    // 1 pt case below pins what pdfmake does today, so a change in it shows up here.
    const edge = PAGE_HEIGHT - 24;
    const line = (top: number): Content => ({
      absolutePosition: { x: 24, y: top },
      canvas: [{ type: "line", x1: 0, y1: 0, x2: 100, y2: 7, lineWidth: 7 }],
    });
    const box = (top: number): Content => ({
      absolutePosition: { x: 200, y: top },
      canvas: [{ type: "rect", x: 0, y: 0, w: 50, h: 10, color: "#336699" }],
    });
    const render = (items: Content[]) => renderPdf({
      pageSize: "LETTER", pageMargins: MARGINS, content: [short],
      pageBottomBandSpec: { height: BAND, content: items, repeated: [] },
    });
    const FILL = /0\.2 0\.4 0\.6 scn/;
    const kept = await render([line(edge - 7), box(edge - 10)]);
    expect(strokedLines(kept)[0].filter((s) => s.width === 7)).toHaveLength(1);
    expect(pageStreams(kept)[0]).toMatch(FILL);
    const past = await render([line(edge - 6), box(edge - 9)]);
    expect(strokedLines(past)[0].filter((s) => s.width === 7)).toHaveLength(1);
    expect(pageStreams(past)[0]).toMatch(FILL);
  });

  it("a second load of render.ts wraps nothing more, and its band is still cut", async () => {
    // vitest loads render.ts afresh per test file (a dev server on reload), while pdfmake, a
    // node_modules package, is loaded once: two instances share one prototype. The tags and the
    // install flag are `Symbol.for` keys, so the second instance sees the first's flag and the
    // first's wrapper reads the second's footers.
    const before = LayoutBuilder.prototype.addHeadersAndFooters;
    vi.resetModules();
    const fresh = await import("@/server/pdf/render");
    expect(fresh.renderPdf).not.toBe(renderPdf);
    expect(LayoutBuilder.prototype.addHeadersAndFooters).toBe(before);
    const pdf = await fresh.renderPdf({
      pageSize: "LETTER", pageMargins: MARGINS, content: [short],
      pageBottomBandSpec: { height: BAND, content: [overflowing(BAND_TOP)], repeated: [] },
    });
    expectBaselines(clipBaselines(pdf, 0), CUT_OFF);
  });
});

/** pdfmake's types give `id` to a text node alone; pdfmake writes `positions` onto any node, so a
 *  table or a stack takes one here through this cast. */
const withId = (id: string, node: Content): Content => ({ ...(node as object), id }) as Content;

/** Three id'd top-level nodes: a text, a table and a text. */
const threeNodes = (): Content[] => [
  { id: "a", text: "alpha" },
  withId("b", { table: { body: [["cell one", "cell two"], ["cell three", "cell four"]] } }),
  { id: "c", text: "gamma" },
];

const byId = (positions: LaidOutNode[], id: string): LaidOutNode => {
  const found = positions.filter((node) => node.id === id);
  expect(found).toHaveLength(1);
  return found[0];
};

describe("renderSheetGroupsWithPositions — laid-out positions by id", () => {
  it("answers each id'd node's page, left and top per group, the group's page count, and the same bytes shape as renderSheetGroups", async () => {
    const defs = (): RenderableDefinition[] => [
      { pageSize: "LETTER", pageMargins: 24, content: threeNodes() },
      { pageSize: "LETTER", pageMargins: 24, content: threeNodes() },
    ];
    const { pdf, groups } = await renderSheetGroupsWithPositions(defs());
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(group.pages).toBe(1);
      expect(group.positions.map((node) => node.id).sort()).toEqual(["a", "b", "c"]);
      const [a, b, c] = ["a", "b", "c"].map((id) => byId(group.positions, id));
      expect([a.page, b.page, c.page]).toEqual([1, 1, 1]);
      expect(a.left).toBe(24);
      expect(a.top).toBe(24);
      expect(b.top).toBeGreaterThan(a.top);
      expect(c.top).toBeGreaterThan(b.top);
    }
    expect(pageCount(pdf)).toBe(2);
    expect(drawnPages(pdf)[1]).toContain("alpha");
    const plain = await renderSheetGroups(defs());
    expect(pageCount(plain)).toBe(pageCount(pdf));
    expect(drawnPages(plain)).toEqual(drawnPages(pdf));
  });

  it("a node pushed to page 2 by a long body reports page 2 and the top margin", async () => {
    // A canvas is exactly as tall as its rectangle: under the one-line "early" (about 14 pt) it takes
    // 720 of the page's 744 usable points, leaving about 10, too little for a 20 pt line, which
    // therefore starts page 2.
    const { groups } = await renderSheetGroupsWithPositions([{
      pageSize: "LETTER", pageMargins: 24,
      content: [
        { id: "early", text: "early" },
        { canvas: [{ type: "rect", x: 0, y: 0, w: 10, h: 720 }] },
        { id: "late", text: "late", fontSize: 20 },
      ],
    }]);
    expect(groups[0].pages).toBe(2);
    expect(byId(groups[0].positions, "early")).toMatchObject({ page: 1, top: 24 });
    expect(byId(groups[0].positions, "late")).toMatchObject({ page: 2, left: 24, top: 24 });
  });

  it("a node with no positions (an empty stack) is left out", async () => {
    const { groups } = await renderSheetGroupsWithPositions([{
      pageSize: "LETTER", pageMargins: 24,
      content: [withId("empty", { stack: [] }), { stack: [{ id: "nested", text: "nested" }] }],
    }]);
    expect(groups[0].positions.map((node) => node.id)).toEqual(["nested"]);
  });

  it("a one-page definition carrying continuationHeaderSpec.overflowTopMargin (the probe branch) still yields positions, and a two-page one yields pass two's", async () => {
    const header = { content: { text: "continued" }, overflowTopMargin: 60 };
    const { groups } = await renderSheetGroupsWithPositions([
      { pageSize: "LETTER", pageMargins: 24, continuationHeaderSpec: header, content: [{ id: "a", text: "alpha" }] },
      {
        pageSize: "LETTER", pageMargins: 24, continuationHeaderSpec: header,
        content: [{ id: "a", text: "alpha" }, { id: "z", text: "zed", pageBreak: "before" }],
      },
    ]);
    // One page: the probe's bytes are the result, with the original 24 pt top margin.
    expect(groups[0].pages).toBe(1);
    expect(groups[0].positions).toEqual([{ id: "a", page: 1, left: 24, top: 24 }]);
    // Two pages: pass two raised the top margin to the 60 pt reserve, so its nodes start at 60.
    expect(groups[1].pages).toBe(2);
    expect(byId(groups[1].positions, "a")).toMatchObject({ page: 1, top: 60 });
    expect(byId(groups[1].positions, "z")).toMatchObject({ page: 2, top: 60 });
  });

  it("refuses an empty list, as renderSheetGroups does", async () => {
    await expect(renderSheetGroupsWithPositions([])).rejects.toThrow(/at least one/);
    expect(drawnText(await renderSheetGroups([{ content: [{ text: "one" }] }]))).toContain("one");
  });
});

describe("layOutSheetGroups — the positions alone", () => {
  it("answers what renderSheetGroupsWithPositions reports per group, the two-page one included, and [] for none", async () => {
    const header = { content: { text: "continued" }, overflowTopMargin: 60 };
    const defs = (): RenderableDefinition[] => [
      { pageSize: "LETTER", pageMargins: 24, content: threeNodes() },
      { pageSize: "LETTER", pageMargins: 24, continuationHeaderSpec: header, content: [{ id: "a", text: "alpha" }] },
      {
        pageSize: "LETTER", pageMargins: 24, continuationHeaderSpec: header,
        content: [{ id: "a", text: "alpha" }, { id: "z", text: "zed", pageBreak: "before" }],
      },
    ];
    const laid = await layOutSheetGroups(defs());
    expect(laid).toEqual((await renderSheetGroupsWithPositions(defs())).groups.map((g) => g.positions));
    expect(laid[2].some((n) => n.page === 2)).toBe(true);
    expect(await layOutSheetGroups([])).toEqual([]);
  });
});

describe("the column clamp (#971)", () => {
  /** pdfmake's own layout engine and column calculator, unwrapped as render.ts unwraps them. */
  const LayoutBuilder =
    (LayoutBuilderModule as unknown as { default?: typeof LayoutBuilderModule }).default ?? LayoutBuilderModule;
  const calculator =
    (ColumnCalculatorModule as unknown as { default?: typeof ColumnCalculatorModule }).default ?? ColumnCalculatorModule;

  const BLOCK_ID = `${CANVAS_TABLE_ID_PREFIX}t`;
  /** The block's drawn box: x 100, 150 wide, so its right edge (250) is well inside the page. */
  const X = 100;
  const W = 150;
  const EDGE = X + W;
  /** A canvas table block (`blockAt`, the one block shape) drawn at x `X`, `w` wide, holding `node`. */
  const block = (node: Content, w = W): Content => blockAt(BLOCK_ID, node, X - 24, 564 - (X - 24) - w, w);
  /** The same block with no id: the twin pdfmake lays out unscoped. */
  const twin = (node: Content, w = W): Content => {
    const copy = block(node, w) as Content & { id?: string };
    delete copy.id;
    return copy;
  };
  const def = (...content: Content[]): RenderableDefinition => ({ pageSize: "LETTER", pageMargins: 24, content });
  /** One unbroken 60-character word. */
  const WORD = "W".repeat(60);
  const sum = (widths: number[]) => widths.reduce((a, b) => a + b, 0);
  /** The one event whose specs are `specs`. */
  const eventOf = (events: ColumnEvent[], specs: unknown[]): ColumnEvent => {
    const found = events.filter((event) => JSON.stringify(event.specs) === JSON.stringify(specs));
    expect(found, `one event for ${JSON.stringify(specs)}`).toHaveLength(1);
    return found[0];
  };
  /** The right end of the page's rightmost stroke. */
  const rightmost = (pdf: Buffer): number =>
    Math.max(...strokedLines(pdf)[0].map((line) => Math.max(line.x1, line.x2)));
  const table = (widths: unknown[], row: Content[]): Content =>
    ({ table: { widths, body: [row] } }) as Content;

  it("keeps a table's stars inside the width it is handed", async () => {
    const node = () => table([100, "*"], ["fixed", WORD]);
    const scoped = await logColumnWidths(() => renderPdf(def(block(node()))));
    // The logger saw the calculator pdfmake calls: a vacuous log would pass every clamp assertion.
    expect(scoped.events.length).toBeGreaterThan(0);
    const marked = scoped.events.filter((event) => event.marked);
    expect(marked.length).toBeGreaterThan(0);
    for (const event of marked) expect(sum(event.widths)).toBeLessThanOrEqual(event.available + KEEP_IN_BOX_TOLERANCE);
    expect(rightmost(scoped.result)).toBeLessThanOrEqual(EDGE + 0.5);
    const inner = eventOf(marked, [100, "*"]);
    expect(inner.widths[0]).toBe(100);
    expect(inner.widths[1]).toBeCloseTo(inner.available - 100, 9);
    // The twin: pdfmake's case 1, unscoped, gives the star its word and passes its width.
    const plain = await logColumnWidths(() => renderPdf(def(twin(node()))));
    expect(plain.events.every((event) => !event.marked)).toBe(true);
    const wide = eventOf(plain.events, [100, "*"]);
    expect(sum(wide.widths)).toBeGreaterThan(wide.available + 100);
    expect(rightmost(plain.result)).toBeGreaterThan(EDGE + 100);
  });

  it("gives the stars what the autos leave, keeping the autos' minima", async () => {
    const node = table(["auto", "auto", "*", "*"], ["12345", "678", "A".repeat(40), "B".repeat(40)]);
    const { events } = await logColumnWidths(() => renderPdf(def(block(node))));
    const event = eventOf(events.filter((e) => e.marked), ["auto", "auto", "*", "*"]);
    const autoMin = event.minWidths[0] + event.minWidths[1];
    // The autos fit what the (absent) fixed columns leave; the stars' words do not.
    expect(autoMin).toBeLessThan(event.available);
    expect(autoMin + 2 * Math.max(event.minWidths[2], event.minWidths[3])).toBeGreaterThan(event.available);
    expect(event.widths[0]).toBe(event.minWidths[0]);
    expect(event.widths[1]).toBe(event.minWidths[1]);
    const share = (event.available - autoMin) / 2;
    expect(event.widths[2]).toBeCloseTo(share, 9);
    expect(event.widths[3]).toBeCloseTo(share, 9);
  });

  it("scales the autos in proportion when they alone overflow", async () => {
    const node = table(["auto", "auto", "*"], ["C".repeat(30), "D".repeat(20), "star"]);
    const { events } = await logColumnWidths(() => renderPdf(def(block(node))));
    const event = eventOf(events.filter((e) => e.marked), ["auto", "auto", "*"]);
    const autoMin = event.minWidths[0] + event.minWidths[1];
    expect(autoMin).toBeGreaterThan(event.available);
    expect(event.widths[0]).toBeCloseTo(event.minWidths[0] * event.available / autoMin, 9);
    expect(event.widths[1]).toBeCloseTo(event.minWidths[1] * event.available / autoMin, 9);
    expect(event.widths[2]).toBe(0);
  });

  it("never changes a fixed column, and leaves a row whose fixed columns pass its width as pdfmake laid it (#991's floor rule)", async () => {
    const node = table([200, "*"], ["fixed", "star"]);
    const { events } = await logColumnWidths(() => renderPdf(def(block(node))));
    const event = eventOf(events.filter((e) => e.marked), [200, "*"]);
    // Before #991 the star was set to 0 here, one glyph a line, the row still past its box: no width the
    // clamp could give keeps it in, so the star keeps case 1's minimum.
    expect(event.widths).toEqual([200, event.minWidths[1]]);
    expect(event.widths[1]).toBeGreaterThan(0);
  });

  it("leaves a row within 0.005 pt of its width as pdfmake laid it", async () => {
    // A row of columns (no padding, no gap): a fixed 60 and a star holding one word. Its width is
    // set to pass the star word's minimum by 0.004 pt, so pdfmake's case 1 lays it out 0.004 pt
    // past what it is handed, under the tolerance.
    const row = (): Content => ({ columns: [{ width: 60, text: "fixed" }, { width: "*", text: "Unbroken" }], columnGap: 0 });
    const probe = await logColumnWidths(() => renderPdf(def(block(row()))));
    const star = eventOf(probe.events, [60, "*"]).minWidths[1];
    const w = 60 + star - 0.004;
    const scoped = await logColumnWidths(() => renderPdf(def(block(row(), w))));
    const plain = await logColumnWidths(() => renderPdf(def(twin(row(), w))));
    const inner = eventOf(scoped.events, [60, "*"]);
    expect(inner.marked).toBe(true);
    expect(sum(inner.widths) - inner.available).toBeGreaterThan(0.003);
    expect(sum(inner.widths) - inner.available).toBeLessThan(KEEP_IN_BOX_TOLERANCE);
    // Every call, the block's own fixed column at exact equality included, as the twin laid it.
    expect(scoped.events.some((event) => event.marked && event.specs.length === 1)).toBe(true);
    expect(scoped.events.map((event) => event.widths)).toEqual(plain.events.map((event) => event.widths));
  });

  it("clamps a table nested in a stack and a cell", async () => {
    const node: Content = {
      stack: [{ table: { widths: ["*"], body: [[{ stack: [table([100, "*"], ["fixed", WORD])] }]] } }],
    } as Content;
    const { result, events } = await logColumnWidths(() => renderPdf(def(block(node))));
    const inner = eventOf(events, [100, "*"]);
    expect(inner.marked).toBe(true);
    expect(sum(inner.widths)).toBeLessThanOrEqual(inner.available + KEEP_IN_BOX_TOLERANCE);
    const outer = eventOf(events, ["*"]);
    expect(outer.marked).toBe(true);
    expect(sum(outer.widths)).toBeLessThanOrEqual(outer.available + KEEP_IN_BOX_TOLERANCE);
    expect(rightmost(result)).toBeLessThanOrEqual(EDGE + 0.5);
  });

  it("scopes the clamp to its own document under concurrent renders", async () => {
    const node = () => table([100, "*"], ["fixed", WORD]);
    const alone = rightmost(await renderPdf(def(twin(node()))));
    // The flow row overflows: pdfmake's case 1, unclamped.
    expect(alone).toBeGreaterThan(EDGE + 100);
    const [canvas, flow] = await Promise.all([renderPdf(def(block(node()))), renderPdf(def(twin(node())))]);
    expect(rightmost(flow)).toBe(alone);
    expect(rightmost(canvas)).toBeLessThanOrEqual(EDGE + 0.5);
  });

  it("flags the block it squeezed", async () => {
    const { groups } = await renderSheetGroupsWithPositions([
      def(block(table([100, "*"], ["fixed", WORD]))),
      def(block(table([100, "*"], ["fixed", "fits"]))),
    ]);
    const squeezed = groups[0].positions.find((node) => node.id === BLOCK_ID);
    expect(squeezed).toMatchObject({ id: BLOCK_ID, squeezed: true });
    const fitting = groups[1].positions.find((node) => node.id === BLOCK_ID);
    expect(fitting).toBeDefined();
    expect(fitting).not.toHaveProperty("squeezed");
  });

  it("installs the column clamp once", () => {
    const calc = calculator.buildColumnWidths;
    const process = LayoutBuilder.prototype.processNode;
    installColumnClamp();
    expect(calculator.buildColumnWidths).toBe(calc);
    expect(LayoutBuilder.prototype.processNode).toBe(process);
  });

  it("refuses at install a pdfmake that lacks a member the clamp needs", () => {
    const proto = LayoutBuilder.prototype as unknown as Record<string, unknown>;
    const calc = calculator as unknown as Record<string, unknown>;
    const members: [Record<string, unknown>, string, RegExp][] = [
      [proto, "processNode", /LayoutBuilder\.prototype\.processNode is not a function/],
      [calc, "buildColumnWidths", /columnCalculator's buildColumnWidths is not a function/],
      [calc, "isStarColumn", /columnCalculator's isStarColumn is not a function/],
      [calc, "isAutoColumn", /columnCalculator's isAutoColumn is not a function/],
    ];
    for (const [owner, name, message] of members) {
      const saved = owner[name];
      owner[name] = undefined;
      try {
        expect(() => installColumnClamp()).toThrow(message);
      } finally {
        owner[name] = saved;
      }
    }
    expect(() => installColumnClamp()).not.toThrow();
  });

  it("is tied to pdfmake 0.3.13", () => {
    const { version } = createRequire(import.meta.url)("pdfmake/package.json") as { version: string };
    expect(
      version,
      "pdfmake moved: render.ts' two hooks on its internals, #978's band frame (LayoutBuilder.addHeadersAndFooters) and " +
      "#971's column clamp (LayoutBuilder.processNode and columnCalculator.buildColumnWidths), were read at " +
      `${PDFMAKE_INTERNALS_VERSION}. Re-check js/columnCalculator.js, js/LayoutBuilder.js and js/TableProcessor.js, then ` +
      "move PDFMAKE_INTERNALS_VERSION.",
    ).toBe(PDFMAKE_INTERNALS_VERSION);
    expect(PDFMAKE_INTERNALS_VERSION).toBe("0.3.13");
  });
});
