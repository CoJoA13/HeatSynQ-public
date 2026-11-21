import { expect } from "vitest";
import { pageCount, paintedImages, strokedLines, type StrokedLine } from "./pdf";
import { rectsPerPage, runsPerPage, type Run } from "./canvas-paper-dump";

/**
 * The quote's flow and canvas papers compared (design 2026-11-12 §5.3's acceptance, at the Global
 * Constraints' 0.5 pt; since quote canvas PR 2). `expectSameQuote(flow, canvas)` holds when:
 *
 *  - the two print the same pages (`opts.pages`, when given, is asserted of the flow first);
 *  - on each page the printed lines (each page's runs grouped by their RAW baseline into lines, top
 *    to bottom, white space alone set aside; `linesOf`) carry the same text in the same order;
 *  - each run's RAW baseline (`textRunsWithY`'s own figure, never a grouping key) is within 0.5 pt
 *    of the flow's same run, and its start x within 0.5 pt;
 *  - each run's font and size are equal on EVERY page (read through tests/helpers/canvas-paper-dump.ts'
 *    `runsPerPage`, since `runFonts` reads page 1 alone);
 *  - the same painted images on each page, each box within 1 pt (`paintedImages`);
 *  - the same stroked lines on each page, merged where pdfmake draws one rule as several touching
 *    collinear segments (`inkOf`), each end within 0.5 pt: the column headers' box and the signature's
 *    rule;
 *  - the same FILLED rects painted above fill opacity 0 on each page, each within 0.5 pt, through
 *    `rectsPerPage`, whose `Rect` carries the opacity in force: the PRICE heading's underline, which
 *    pdfmake's `TextDecorator` fills as a rect and `strokedLines` does not read. The canvas's marks
 *    and spacers fill at opacity 0, a clip paints nothing, and the flow has neither, so those are
 *    left out.
 */
export function expectSameQuote(flow: Buffer, canvas: Buffer, opts: { pages?: number } = {}): void {
  if (opts.pages !== undefined) expect(pageCount(flow), "the flow's pages").toBe(opts.pages);
  expect(pageCount(canvas), "the canvas's pages").toBe(pageCount(flow));
  const flowRuns = runsPerPage(flow);
  const canvasRuns = runsPerPage(canvas);
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
    expect({ page: page + 1, missing, extra: left }, "the stroked lines").toEqual({ page: page + 1, missing: [], extra: [] });
  });

  const flowRects = rectsPerPage(flow).map(filled);
  const canvasRects = rectsPerPage(canvas).map(filled);
  flowRects.forEach((rects, page) => {
    const left = [...canvasRects[page]];
    const missing: Fill[] = [];
    for (const r of rects) {
      const i = left.findIndex((c) => c.paint === r.paint
        && (["x", "y", "w", "h"] as const).every((k) => Math.abs(c[k] - r[k]) <= 0.5));
      if (i === -1) missing.push(r);
      else left.splice(i, 1);
    }
    expect({ page: page + 1, missing, extra: left }, "the filled rects").toEqual({ page: page + 1, missing: [], extra: [] });
  });
}

/** A page's runs grouped into printed lines top to bottom: a run joins the line above it where its
 *  RAW baseline is within 0.3 pt of that line's first run's (pdfkit writes each word of a line at one
 *  baseline), each line's runs left to right, white space alone set aside. The grouping reads the text
 *  alone; every position compared is a run's own raw figure. */
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

/** Distinct strokes, merged: pdfmake draws a rule as one segment per cell or per row; touching
 *  collinear segments of one width read as one (the statement seed suite's `inkOf`). */
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

/** The fill paints `rectsPerPage` reports (a clip's paint is spelled with its `W`; `S` and `s`
 *  stroke and `n` paints nothing). */
const FILLS = new Set(["f", "F", "f*", "B", "B*", "b", "b*"]);
type Fill = { x: number; y: number; w: number; h: number; paint: string };
/** A page's filled rects painted above fill opacity 0. */
function filled(rects: ReturnType<typeof rectsPerPage>[number]): Fill[] {
  return rects.filter((r) => FILLS.has(r.paint) && r.opacity > 0).map(({ x, y, w, h, paint }) => ({ x, y, w, h, paint }));
}
