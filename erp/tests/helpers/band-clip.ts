import { expect } from "vitest";
import { CANVAS_PAGE, type CanvasItem, type CanvasLayout } from "@/lib/template-contracts/canvas";
import { pageFoot } from "@/lib/template-canvas";
import { textRunsWithY } from "./pdf";

/**
 * #978's case, shared by the seven canvas documents' tests: a Text item in the page-bottom band whose
 * words lay out to far more lines than its box holds is cut at the band's bottom edge (`pageFoot`),
 * whole lines, never paged and never printed below the edge. Each file builds its own layout around
 * `bandClipItem`, renders its own fixture, and hands the bytes to `expectBandClip`.
 */

const PAGE_HEIGHT = 792;
const WIDTH = 200;
const BOX_HEIGHT = 12;

/** The item: 10 pt words, 60 repeats, in a box whose bottom is the band's bottom edge. */
export function bandClipItem(pageFooter: boolean): Extract<CanvasItem, { kind: "text" }> {
  return {
    id: "band-clip-text", kind: "text", text: "Band clip words ".repeat(60).trim(),
    box: { x: CANVAS_PAGE.margin, y: pageFoot(pageFooter) - BOX_HEIGHT, w: WIDTH, h: BOX_HEIGHT },
    anchor: { kind: "page-bottom" }, repeat: false, style: { size: 10, bold: false, align: "left" },
  };
}

/** `base` with its non-table page-bottom items lifted to end at the foot the page line leaves when it is on
 *  (a fixture's footer sits at the page-line-off foot, which the rules refuse with the page line on), and
 *  the clip item added. */
export function bandClipLayout(base: CanvasLayout, pageFooter: boolean): CanvasLayout {
  const foot = pageFoot(pageFooter);
  const items = base.items.map((item) => item.kind !== "table" && item.anchor.kind === "page-bottom"
    ? { ...item, box: { ...item.box, y: foot - item.box.h } } : item);
  return { ...base, items: [...items, bandClipItem(pageFooter)] };
}

type Run = { text: string; x: number; top: number };

/** Page 1's non-blank runs, each with its baseline top-down (`textRunsWithY` reports from the bottom). */
const runsOf = (pdf: Buffer): Run[] =>
  textRunsWithY(pdf)[0].filter((r) => r.text.trim() !== "").map((r) => ({ text: r.text, x: r.x, top: PAGE_HEIGHT - r.y }));

/** The cut: the item's lines all sit at or above the band's bottom edge, the last of them within a line of
 *  it (the text is cut there, not earlier), and with the page line on its line prints, on a baseline of its
 *  own. The case's other half, that the paper is cut by the edge and not by the page, is the edge itself:
 *  with no frame ending there the item's overflow prints below it (baselines at and past the edge + 11.7). */
export function expectBandClip(pdf: Buffer, pageFooter: boolean): void {
  const foot = pageFoot(pageFooter);
  const runs = runsOf(pdf);
  const mine = runs.filter((r) => r.x >= CANVAS_PAGE.margin - 0.5 && r.x < CANVAS_PAGE.margin + WIDTH && /^(Band|clip|words)+$/.test(r.text.replace(/\s/g, "")));
  expect(mine.length, "the item prints").toBeGreaterThan(0);
  const tops = mine.map((r) => r.top);
  for (const top of tops) expect(top, `a line of the item at ${top}`).toBeLessThanOrEqual(foot);
  expect(Math.max(...tops), "the last line prints at the edge").toBeGreaterThan(foot - 12);
  if (!pageFooter) return;
  const byLine = new Map<number, Run[]>();
  for (const run of runs) byLine.set(Math.round(run.top * 100) / 100, [...(byLine.get(Math.round(run.top * 100) / 100) ?? []), run]);
  const pageLine = [...byLine.entries()].find(([, line]) =>
    /^Page:? \d+ of \d+$/.test([...line].sort((a, b) => a.x - b.x).map((r) => r.text).join("").replace(/\s+/g, " ").trim()));
  expect(pageLine, "the page line prints").toBeDefined();
  expect(pageLine![0], "under the band").toBeGreaterThan(foot);
  for (const top of tops) expect(Math.abs(top - pageLine![0]), "no item line shares the page line's baseline").toBeGreaterThan(0.5);
}
