import { describe, it, expect } from "vitest";
import { parseObjects, pagesInOrder, type PdfObj } from "./helpers/pdf";
import { CANVAS_DOCS, printOf } from "./helpers/canvas-prints";
import { TEMPLATE_DOC_TYPES, canvasPrints } from "@/lib/template-contracts/index";

/**
 * The canvas's invisible nodes paint nothing (src/server/pdf/canvas-nodes.ts). A mark is a 0 × 0
 * canvas rect and a spacer a 0 × h one, each FILLED, since pdfmake strokes a vector with no colour.
 * Poppler paints a zero-area fill as nothing, but Chrome's PDF viewer (PDFium), which
 * shows every print in its browser tab, paints a zero-width fill as a one-device-pixel hairline and
 * a 0 × 0 one as a dot: the invoice canvas PR 3 whole-branch review saw both at the canvas sheet's
 * left margin. So each node fills at a fill opacity (`/ca`) of 0, and this reader, walking every
 * page's content streams operator by operator, refuses:
 *
 * - a zero-area `re` painted by a fill (`f`, `F`, `f*`, `B`, `B*`, `b`, `b*`) while the fill
 *   opacity in force is above 0;
 * - anything else painted while a fill opacity of 0 is in force: a fill of any other path, a text
 *   show, an XObject or a shading. pdfkit writes an opacity as `/GsN gs` with no `q`/`Q` around it,
 *   so a fill opacity of 0 stays in force until the next opacity is set; text, images and filled
 *   vectors each set their own today, and this is the half that would see one that stopped.
 *
 * It fails closed: a `gs` name it cannot resolve through the page's `/Resources /ExtGState` throws,
 * and every canvas print must carry at least one hidden fill, so a reader that stopped matching
 * reads as a failure, never a pass. Each document's FLOW print is read beside its canvas as a
 * control: it draws no mark or spacer, so it fills no zero-area rect at all.
 */

type Ink = { visible: string[]; hidden: number; leaks: string[] };

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)$/;
const TOKEN = /\((?:\\[\s\S]|[^\\()])*\)|<<|>>|<[0-9A-Fa-f\s]*>|\/[^\s/[\]()<>{}%]*|[[\]{}]|[^\s/[\]()<>{}%]+/g;
const FILLS = new Set(["f", "F", "f*", "B", "B*", "b", "b*"]);
const STROKES = new Set(["S", "s", "n"]);
const SHOWS = new Set(["Tj", "TJ", "'", "\"", "Do", "sh"]);

/** The body of a dictionary value: an inline `<< … >>` or the object an `N 0 R` names. */
function dictAt(objs: Map<number, PdfObj>, body: string, key: string): string | null {
  const ref = new RegExp(`/${key}\\s+(\\d+)\\s+0\\s+R`).exec(body);
  if (ref) return objs.get(Number(ref[1]))?.body ?? null;
  const at = new RegExp(`/${key}\\s*<<`).exec(body);
  if (!at) return null;
  let depth = 0;
  for (let i = at.index + at[0].length - 2; i < body.length - 1; i++) {
    if (body.startsWith("<<", i)) { depth++; i++; continue; }
    if (body.startsWith(">>", i)) { depth--; if (depth === 0) return body.slice(at.index + at[0].length, i); i++; }
  }
  return null;
}

/** Each named graphics state's fill opacity, or null where the state sets none. */
function fillOpacities(objs: Map<number, PdfObj>, page: PdfObj): Map<string, number | null> {
  const resources = dictAt(objs, page.body, "Resources") ?? "";
  const states = dictAt(objs, resources, "ExtGState") ?? "";
  const out = new Map<string, number | null>();
  for (const [, name, num] of states.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+0\s+R/g)) {
    const body = objs.get(Number(num))?.body;
    if (body === undefined) throw new Error(`ExtGState /${name} names object ${num}, which the file does not hold`);
    const ca = /\/ca\s+([-+]?[\d.]+)/.exec(body);
    out.set(name, ca ? Number(ca[1]) : null);
  }
  return out;
}

function inkOf(pdf: Buffer): Ink {
  const objs = parseObjects(pdf);
  const ink: Ink = { visible: [], hidden: 0, leaks: [] };
  pagesInOrder(objs).forEach((page, index) => {
    const states = fillOpacities(objs, page);
    const contents = /\/Contents\s+(\[[\s\S]*?\]|\d+\s+0\s+R)/.exec(page.body);
    const refs = contents ? [...contents[1].matchAll(/(\d+)\s+0\s+R/g)].map((r) => Number(r[1])) : [];
    const stream = refs.map((ref) => objs.get(ref)?.stream?.toString("latin1") ?? "").join("\n");
    let ca = 1;
    const saved: number[] = [];
    let operands: string[] = [];
    let path: { zero: string[]; other: boolean } = { zero: [], other: false };
    for (const token of stream.match(TOKEN) ?? []) {
      const operator = /^[A-Za-z'"][A-Za-z*]*$/.test(token) && !["true", "false", "null"].includes(token);
      if (!operator) { operands.push(token); continue; }
      const args = operands;
      operands = [];
      const where = `page ${index + 1}`;
      if (token === "q") saved.push(ca);
      else if (token === "Q") ca = saved.pop() ?? 1;
      else if (token === "gs") {
        const name = args.at(-1)?.slice(1) ?? "";
        if (!states.has(name)) throw new Error(`${where}: gs /${name} is not in the page's /ExtGState`);
        ca = states.get(name) ?? ca;
      } else if (token === "re") {
        const [x, y, w, h] = args.slice(-4).map(Number);
        if (args.length < 4 || !args.slice(-4).every((a) => NUMBER.test(a))) throw new Error(`${where}: re with operands ${args.join(" ")}`);
        if (w === 0 || h === 0) path.zero.push(`${x} ${y} ${w} ${h} re`);
        else path.other = true;
      } else if (["m", "l", "c", "v", "y", "h"].includes(token)) path.other = true;
      else if (FILLS.has(token)) {
        for (const rect of path.zero) {
          if (ca > 0) ink.visible.push(`${where}: ${rect} ${token} at fill opacity ${ca}`);
          else ink.hidden++;
        }
        if (path.other && ca === 0) ink.leaks.push(`${where}: a ${token} fill of a path with area at fill opacity 0`);
        path = { zero: [], other: false };
      } else if (STROKES.has(token)) path = { zero: [], other: false };
      else if (SHOWS.has(token) && ca === 0) ink.leaks.push(`${where}: ${token} at fill opacity 0`);
    }
  });
  return ink;
}

describe("the canvas's marks and spacers fill at opacity 0", () => {
  // The reader covers every document whose canvas prints, and no other (the quotation's included, since
  // quote canvas PR 2): a type joining CANVAS_PRINTS without a `printOf` arm, or one left in CANVAS_DOCS
  // after leaving the set, reds here. Reds when "STATEMENT" or "QUOTE" leaves CANVAS_PRINTS.
  it("the statement and every other type whose canvas prints are read by the hidden-mark check", () => {
    expect(new Set(CANVAS_DOCS)).toEqual(new Set(TEMPLATE_DOC_TYPES.filter(canvasPrints)));
  });

  it.each(CANVAS_DOCS)("%s: the canvas print fills no zero-area rect above fill opacity 0, and paints nothing else at 0", async (doc) => {
    const ink = inkOf(await printOf(doc, true));
    expect(ink.visible).toEqual([]);
    expect(ink.leaks).toEqual([]);
    // Not vacuous: the canvas print draws its marks and spacers, and the reader sees them (at least one; the counts per document are in the ledger).
    expect(ink.hidden).toBeGreaterThan(0);
  });

  it.each(CANVAS_DOCS)("%s: the flow print, the control, fills no zero-area rect at all", async (doc) => {
    const ink = inkOf(await printOf(doc, false));
    expect(ink).toEqual({ visible: [], hidden: 0, leaks: [] });
  });
});
