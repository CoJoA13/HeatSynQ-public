import { afterAll, describe, expect, it } from "vitest";
import { KEEP_IN_BOX_TOLERANCE, renderSheetGroupsWithPositions } from "@/server/pdf/render";
import { CANVAS_TABLE_ID_PREFIX } from "@/server/pdf/canvas-nodes";
import type { StatementOpenItem } from "@/server/pdf/statement";
import { canvasRefusal, headingWholeWidth, leastWidth } from "@/lib/template-canvas";
import { contractFor } from "@/lib/template-contracts/index";
import type { CanvasLayout } from "@/lib/template-contracts/canvas";
import { layoutOf } from "./helpers/canvas-fixtures";
import { QUOTE_WIDTHS } from "@/server/pdf/quote";
import { INVOICE_WIDTHS } from "@/server/pdf/invoice";
import { textWidthOf } from "@/lib/tag-font-metrics";
import { definitionsOf, dumpCanvasPaper, type PaperCase, type PaperDump } from "./helpers/canvas-paper-dump";
import { isStepsMeasure, logColumnWidths, type ColumnEvent } from "./helpers/column-log";
import {
  DOCS, FITTING_CASES, FULL_W, LEFT, RIGHT, STROKE_TOLERANCE, TEXT_TOLERANCE, blockCase, outOfBox, reboxed, travelerRecord,
} from "./helpers/keep-in-box-cases";
import { richStatement } from "./helpers/statement-canvas-fixtures";

/**
 * Every canvas block prints inside its drawn box (#971; design
 * docs/superpowers/specs/2026-11-14-971-keep-in-box-design.md §8.1, §5.6).
 *
 * Each block of design §5.3 (`FITTING_CASES`, Task 1's), on its document's standard layout and
 * one-page record (tests/helpers/keep-in-box-cases.ts), drawn against the right margin (x = 588 − w)
 * at three widths: its first fitting width on `main` less 0.5, the midpoint from there to its least
 * width, and its least width (the ticket totals at their least width, 264.5, alone: their fitting
 * width less 0.5 is under it), page line off and on. At each, the canvas rules accept the layout, and:
 * - every stroke on the paper ends at or before x + w + 0.5 (the block ends at the margin, so the
 *   whole paper is read: nothing else on a standard layout passes 588);
 * - every call pdfmake's column calculator makes inside a canvas block (`marked`) lays its columns out
 *   no wider than it was handed, to `KEEP_IN_BOX_TOLERANCE`;
 * - no text run ends past x + w + 0.3 wherever every star share of those calls is at least one bold
 *   "W" of the document's base font; where one is narrower (design §5.6: a glyph wider than its share
 *   may overhang its cell), the runs past x + w are collected (`RESIDUALS`), printed after the suite
 *   and recorded in the ledger per table, never asserted;
 * - the bill of lading's freight table ends left of its 8 pt gap and the sidebar starts right of it.
 *
 * Every check of a block's cases is collected before one assertion, so a failure names each width
 * and page line that failed.
 *
 * Red before the clamp (design §8.1, Step 3 of the plan's Task 5): with `keepInBox` answering false
 * (the clamp switched off, mutation (a)), every block's cases red but the ticket totals', which no
 * width at or above their least width overflowed on `main` (the ledger records each block).
 *
 * The last describe is Task 1's calculator probe, committed (controller's ruling, Task 1 review):
 * at every fitting width Task 1 recorded, no printed row enters pdfmake's case 1 at all.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;
const PAGE_LINE = [false, true] as const;

/** Each block's least width at its standard columns (design §6's table; Task 2's `leastWidth`). */
const LEAST: Record<string, number> = {
  "TRAVELER lines": 280.5, "TRAVELER quantities": 462.5, "TRAVELER inspections": 277.1, "TRAVELER steps": 218.1,
  "SHIPPER field_strip": 314.3, "SHIPPER lines": 188.5, "SHIPPER containers": 352.5, "SHIPPER totals": 264.5,
  "MOS_SHIPPER field_strip": 314.3, "MOS_SHIPPER lines": 188.5, "MOS_SHIPPER containers": 352.5, "MOS_SHIPPER totals": 264.5,
  "BOL freight": 415.3, "CERT parts": 188.5,
  "INVOICE column_header": 242.5, "INVOICE parties": 101, "INVOICE parts": 230.5, "INVOICE price": 230.5,
  "QUOTE column_header": 242.5, "QUOTE lines": 230.5, "QUOTE closing": 246.5,
  "STATEMENT aging": 66.9, "STATEMENT open_items": 49.5,
};

const isStar = (spec: unknown) => spec === undefined || spec === null || spec === "*" || spec === "star";
const sum = (values: number[]) => values.reduce((s, v) => s + v, 0);

/** The calls inside a canvas block that lay their columns out wider than they were handed. */
function overflowing(events: ColumnEvent[]): string[] {
  return events.filter((e) => e.marked && sum(e.widths) > e.available + KEEP_IN_BOX_TOLERANCE)
    .map((e) => `calculator: ${JSON.stringify(e.specs)} laid out ${r2(sum(e.widths) * 1000) / 1000} in ${r2(e.available * 1000) / 1000}`);
}

/** The narrowest star share of the calls inside a canvas block (Infinity where none has a star). */
function narrowestStar(events: ColumnEvent[]): number {
  return Math.min(Infinity, ...events.filter((e) => e.marked).flatMap((e) => e.widths.filter((_, i) => isStar(e.specs[i]))));
}

/** Runs past the drawn edge where a star share is under one glyph (design §5.6), per case. */
const RESIDUALS: string[] = [];

/** The case's paper and its calculator log. */
async function laidOut(c: PaperCase): Promise<{ dump: PaperDump; events: ColumnEvent[] }> {
  const { result: dump, events } = await logColumnWidths(() => dumpCanvasPaper(c));
  return { dump, events };
}

/** What of the paper prints past the drawn right edge (to the design's reading tolerances), split
 *  into its strokes and its text runs. */
function pastEdge(dump: PaperDump, x: number, w: number): { strokes: string[]; runs: string[]; inked: number } {
  const { past, inked } = outOfBox(dump, x, w, undefined, { stroke: STROKE_TOLERANCE, text: TEXT_TOLERANCE });
  return { strokes: past.filter((p) => p.includes(": stroke ")), runs: past.filter((p) => p.includes(": run ")), inked };
}

/** The bill of lading's freight block at x and w: what crosses its 8 pt gap (the sidebar is 170 wide
 *  at the block's right, the gap 8 before it), and whether both its sides were read. On the standard
 *  layout no other item draws across those x, so the whole paper is read. */
function gapCrossings(dump: PaperDump, x: number, w: number): string[] {
  const left = x + w - 178;
  const right = x + w - 170;
  const out: string[] = [];
  let table = 0;
  let sidebar = 0;
  dump.perPage.forEach((page, p) => {
    for (const s of page.strokes) {
      const lo = Math.min(s.x1, s.x2);
      const hi = Math.max(s.x1, s.x2);
      if (hi > left - 1 && hi <= left + STROKE_TOLERANCE) table += 1;
      // A sidebar row is 160 pt from the gap's right edge, its rule beside its label (owner ruling R1,
      // 2026-11-24), so the row's rule ENDS 160 pt past that edge.
      if (lo > right - STROKE_TOLERANCE && Math.abs(hi - (right + 160)) <= STROKE_TOLERANCE) sidebar += 1;
      if (hi > left + STROKE_TOLERANCE && lo < right - STROKE_TOLERANCE) out.push(`page ${p + 1}: stroke ${s.x1}..${s.x2}@${s.y1} crosses the gap ${left}..${right}`);
    }
  });
  if (table === 0) out.push(`no stroke of the freight table ends at the gap's left edge ${left}`);
  if (sidebar === 0) out.push(`no stroke of the sidebar ends 160 pt past the gap's right edge ${right}`);
  return out;
}

/** The blocks that, on `main`, did not overflow by `KEEP_IN_BOX_TOLERANCE` or more at their fitting
 *  width less 0.5 (Task 1's readings: five not at all, three by at most 0.005; the ledger's list). The
 *  ticket totals overflowed only under 260, below their least width. Every other block at every width
 *  of its cases overflowed on `main`, so the clamp must have acted there (`squeezed`). */
const FIT_LESS_HALF_FITS = new Set([
  "TRAVELER lines", "TRAVELER inspections", "SHIPPER field_strip", "SHIPPER lines", "MOS_SHIPPER field_strip",
  "MOS_SHIPPER lines", "CERT parts", "INVOICE column_header", "QUOTE column_header", "STATEMENT aging",
]);

/** Whether the clamp must have corrected the block at w (it overflowed there on `main`). */
function squeezedOnMain(doc: string, block: string, fit: number, w: number): boolean {
  if (block === "totals") return false;
  return !(w === r2(fit - 0.5) && FIT_LESS_HALF_FITS.has(`${doc} ${block}`));
}

/** The widths a block is drawn at (design §8.1). */
function widthsOf(block: string, fit: number, least: number): number[] {
  if (block === "totals") return [least];
  return [r2(fit - 0.5), r2((fit - 0.5 + least) / 2), least];
}

describe("a canvas block keeps its columns inside its drawn box (#971)", () => {
  for (const { doc, block, w: fit } of FITTING_CASES) {
    it(`${doc} ${block}`, async () => {
      const contract = contractFor(doc);
      const layout = DOCS[doc].layout();
      const item = layout.items.find((i) => i.kind === "table" && i.key === block)!;
      const least = leastWidth(contract, item, { layout });
      expect(least, "the least width at the standard columns").toBe(LEAST[`${doc} ${block}`]);
      const problems: string[] = [];
      for (const w of widthsOf(block, fit, least)) {
        for (const pageFooter of PAGE_LINE) {
          const x = r2(RIGHT - w);
          const c = blockCase(doc, block, { x, w }, pageFooter);
          const at = `w ${w} [page line ${pageFooter ? "on" : "off"}]`;
          const refusal = canvasRefusal(c.config.layout!, contract, { pageFooter });
          if (refusal !== null) problems.push(`${at}: refused: ${refusal.sentence}`);
          const { dump, events } = await laidOut(c);
          if (!events.some((e) => e.marked)) problems.push(`${at}: no call of the calculator inside a block`);
          const { strokes, runs, inked } = pastEdge(dump, x, w);
          if (inked === 0) problems.push(`${at}: no ink read`);
          problems.push(...strokes.map((s) => `${at}: ${s}`));
          problems.push(...overflowing(events).map((s) => `${at}: ${s}`));
          const { family, baseSize } = c.config.fonts;
          const glyph = textWidthOf("W", family, "bold", baseSize);
          if (narrowestStar(events) >= glyph) problems.push(...runs.map((s) => `${at}: ${s}`));
          else RESIDUALS.push(...runs.map((s) => `${doc} ${block} ${at} (star share ${r2(narrowestStar(events))} < W ${r2(glyph)}): ${s}`));
          // A premise, so no case passes without the clamp having been reached: the block is flagged
          // squeezed exactly where it overflowed on `main`.
          const squeezed = dump.measure.tables.find((t) => t.key === block)?.squeezed === true;
          if (squeezed !== squeezedOnMain(doc, block, fit, w)) problems.push(`${at}: squeezed ${squeezed}, expected ${!squeezed}`);
          if (doc === "BOL") problems.push(...gapCrossings(dump, x, w).map((s) => `${at}: ${s}`));
        }
      }
      expect(problems, `${doc} ${block}: printed past its drawn box`).toEqual([]);
    }, 120_000);
  }

  it("keeps the quantities in the box over a 30-character container type", async () => {
    // On `main` the quantities' rules reached 630.695 (report 1's probe c; the flow's pin, Task 1).
    const c = blockCase("TRAVELER", "quantities", { x: LEFT, w: FULL_W }, false, { record: travelerRecord("WIREMESHBASKETEXTRAHEAVYDUTY30") });
    const { dump, events } = await laidOut(c);
    const strokes = dump.perPage.flatMap((p) => p.strokes);
    expect(strokes.length).toBeGreaterThan(0);
    expect(Math.max(...strokes.map((s) => Math.max(s.x1, s.x2)))).toBeLessThanOrEqual(RIGHT + STROKE_TOLERANCE);
    expect(overflowing(events)).toEqual([]);
  }, 60_000);

  it("renders to completion at a zero share", async () => {
    const cases: { name: string; c: PaperCase; x: number; w: number; starAt: number }[] = [];
    // The statement's aging at its least width: seven stars share 4.5 pt (0.64 each).
    cases.push({ name: "aging at 66.9", c: blockCase("STATEMENT", "aging", { x: r2(RIGHT - 66.9), w: 66.9 }, false), x: r2(RIGHT - 66.9), w: 66.9, starAt: 0.65 });
    // The open items at the owner's 49.5 with 120 items: the autos scale, the stars get 0.
    cases.push({
      name: "open items at 49.5, 120 items",
      c: blockCase("STATEMENT", "open_items", { x: RIGHT - 49.5, w: 49.5 }, false, { record: richStatement({ openItems: openItems(120) }) }),
      x: RIGHT - 49.5, w: 49.5, starAt: 0,
    });
    // The quantities drawn under their floor past the validator (the render path validates nothing):
    // at 458 their fixed columns and overhead fill the box, so their star share is exactly 0.
    const accepted = blockCase("TRAVELER", "quantities", { x: r2(RIGHT - 462.5), w: 462.5 }, false);
    const under = { ...accepted, config: { ...accepted.config, layout: reboxed(accepted.config.layout!, "quantities", { x: RIGHT - 458, w: 458 }) } };
    expect(canvasRefusal(under.config.layout!, contractFor("TRAVELER"), { pageFooter: false }), "drawn under its floor").not.toBeNull();
    cases.push({ name: "quantities at 458, under their floor", c: under, x: RIGHT - 458, w: 458, starAt: 1e-9 });
    for (const { name, c, x, w, starAt } of cases) {
      const { dump, events } = await laidOut(c);
      expect(dump.pages, name).toBeGreaterThan(0);
      const { strokes, inked } = pastEdge(dump, x, w);
      expect(inked, name).toBeGreaterThan(0);
      expect(strokes, `${name}: strokes past ${x + w}`).toEqual([]);
      expect(overflowing(events), name).toEqual([]);
      // The share the case is named for, read after the box checks so a failure there names them.
      expect(narrowestStar(events), `${name}: its narrowest star share`).toBeLessThanOrEqual(starAt);
    }
  }, 120_000);

  it("prints the open items' numbers and dates whole while their autos fit", async () => {
    // At 180 the open items' autos (document number, date, due date) fit what the boxed layout's
    // offsets leave and their two stars do not (premise, from the calculator's own minima), so the
    // autos keep their minima, the stars share the rest, and no word of a number or date is broken.
    const w = 180;
    const record = richStatement();
    const c = blockCase("STATEMENT", "open_items", { x: RIGHT - w, w }, false, { record });
    const { dump, events } = await laidOut(c);
    const rows = events.filter((e) => e.marked && JSON.stringify(e.specs) === JSON.stringify(["auto", "auto", "auto", "*", "*"]));
    expect(rows.length, "the open items' table").toBeGreaterThan(0);
    for (const e of rows) {
      const autos = e.specs.flatMap((s, i) => (s === "auto" ? [i] : []));
      const stars = e.specs.flatMap((s, i) => (isStar(s) ? [i] : []));
      const autoMin = sum(autos.map((i) => e.minWidths[i]));
      const starMin = Math.max(...stars.map((i) => e.minWidths[i]));
      expect(autoMin, "the autos fit").toBeLessThanOrEqual(e.available);
      expect(autoMin + stars.length * starMin, "the stars do not").toBeGreaterThan(e.available);
      for (const i of autos) expect(e.widths[i], `auto ${i} at its minimum`).toBeCloseTo(e.minWidths[i], 9);
      for (const i of stars) expect(e.widths[i], `star ${i} shares the rest`).toBeCloseTo((e.available - autoMin) / stars.length, 9);
    }
    // On paper each word of each document number, date and due date is one run: a row's cells print
    // in order, so after the document number (its words on one line) come the date's words and the
    // due date's, each whole (pdfmake writes a word as its own run, so "7 - 92026" is three runs).
    const runs = dump.perPage.flatMap((p) => p.runs).map((r) => ({ ...r, text: r.text.trim() })).filter((r) => r.text !== "");
    const dateOf = (iso: string) => {
      const [y, m, d] = iso.split("-");
      return `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][Number(m) - 1]} ${Number(d)}, ${y}`;
    };
    for (const item of record.openItems) {
      const words = item.documentNumber.split(" ");
      const start = runs.findIndex((r, i) => words.every((word, k) => runs[i + k]?.text === word && runs[i + k].y === r.y));
      expect(start, `${item.documentNumber}: whole, on one line`).toBeGreaterThanOrEqual(0);
      const dates = [item.date, item.dueDate].filter((d): d is string => d !== null).flatMap((d) => dateOf(d).split(" "));
      expect(runs.slice(start + words.length, start + words.length + dates.length).map((r) => r.text), `${item.documentNumber}: its dates' words, each whole`)
        .toEqual(dates);
    }
  }, 60_000);

  afterAll(() => {
    // Design §5.6's residual, for the ledger: text past the drawn edge where a star share is under one glyph.
    console.log(`#971 keep-in-box residual text runs (${RESIDUALS.length}):\n${RESIDUALS.join("\n")}`);
  });
});

/** The oracle's long-statement open items (tests/canvas-paper-oracle.test.ts `openItems`). */
function openItems(n: number): StatementOpenItem[] {
  return Array.from({ length: n }, (_, i) => ({
    documentNumber: `7 - ${93000 + i}`, date: "2026-07-10", dueDate: "2026-08-09", kind: "INVOICE" as const, original: 1000 + i, open: 500 + i,
  }));
}

/** Whether pdfmake's own calculator enters case 1 on the call (`columnCalculator.js:71`): its
 *  flexible columns' least (the autos' minima and every star at the widest star's) at or past what the
 *  fixed columns leave. Read from the call's specs and minima, which the clamp does not touch, so it
 *  is pdfmake's verdict with or without the clamp installed. */
function entersCaseOne(e: ColumnEvent): boolean {
  let fixed = 0;
  let autoMin = 0;
  let starMax = 0;
  let stars = 0;
  e.specs.forEach((spec, i) => {
    if (spec === "auto") autoMin += e.minWidths[i];
    else if (isStar(spec)) {
      starMax = Math.max(starMax, e.minWidths[i]);
      stars += 1;
    } else fixed += e.widths[i];
  });
  const flexible = e.specs.some((spec) => spec === "auto" || isStar(spec));
  return flexible && autoMin + starMax * stars >= e.available - fixed;
}

describe("no fitting width Task 1 recorded enters pdfmake's case 1 (#971)", () => {
  // Task 1's fitting cases (tests/canvas-keep-in-box-fitting.test.ts): each block at 564 from x 24 and
  // at its first fitting width from x 24 and against the right margin, page line off and on. This
  // replaces Task 1's throwaway calculator probe: "fits" there was read to the strokes' and runs'
  // tolerances; here no printed row of that paper reaches case 1 even at equality, so the clamp's
  // guard is never what keeps it unchanged. The steps measure's call is read too: until #992 its
  // sentinel row raised the instruction's minimum and it entered case 1 at the steps' 221 (four calls,
  // left out here); its sentinel now enters no column's minimum, so it lays out as the steps print
  // and no call is left out. Every traveler render takes the measure once, so it is counted to pin
  // that the detector found it.
  for (const { doc, block, w } of FITTING_CASES) {
    it(`${doc} ${block}`, async () => {
      const found: string[] = [];
      let read = 0;
      let measures = 0;
      for (const pageFooter of PAGE_LINE) {
        for (const at of [{ x: LEFT, w: FULL_W }, { x: LEFT, w }, { x: r2(RIGHT - w), w }]) {
          const { events } = await laidOut(blockCase(doc, block, at, pageFooter));
          read += events.length;
          for (const e of events) {
            const measure = isStepsMeasure(e);
            if (measure) measures += 1;
            if (!entersCaseOne(e)) continue;
            found.push(`${measure ? "the steps measure, " : ""}x ${at.x} w ${at.w} [page line ${pageFooter ? "on" : "off"}]: ${JSON.stringify(e.specs)} minima ${JSON.stringify(e.minWidths.map(r2))} in ${r2(e.available)}`);
          }
        }
      }
      expect(read, "calls read").toBeGreaterThan(0);
      expect(found, `${doc} ${block}: a row enters case 1`).toEqual([]);
      // One steps measure per traveler render: three placements, page line off and on.
      expect(measures, "steps measure calls read").toBe(doc === "TRAVELER" ? 6 : 0);
    }, 120_000);
  }
});

/** The node under `node` whose id is `id`, else null. */
function nodeWithId(node: unknown, id: string): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = nodeWithId(n, id);
      if (found !== null) return found;
    }
    return null;
  }
  if (node === null || typeof node !== "object") return null;
  const o = node as Record<string, unknown>;
  if (o.id === id) return o;
  for (const v of Object.values(o)) {
    const found = nodeWithId(v, id);
    if (found !== null) return found;
  }
  return null;
}

const HEADER_ONLY = "_headerOnly";

/** Every table under `node` cut to its header rows (`headerRows`, else its first row) and marked. */
function cutToHeaders(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(cutToHeaders);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  if (o.table !== null && typeof o.table === "object") {
    const table = o.table as { body: unknown[]; headerRows?: number };
    table.body = table.body.slice(0, table.headerRows ?? 1);
    o[HEADER_ONLY] = true;
  }
  Object.values(o).forEach(cutToHeaders);
}

/** The greatest star minimum pdfmake's calculator logs for `block`'s table laid out with its header
 *  rows alone: the call on a cut table whose specs are the block's shown columns, once per copy (the
 *  inspections' outer one-column frame and the steps' measure copy are other calls). */
async function headerStarMinimum(c: PaperCase, block: string, specs: unknown[]): Promise<number> {
  const defs = JSON.parse(JSON.stringify(definitionsOf(c))) as unknown;
  const node = nodeWithId(defs, `${CANVAS_TABLE_ID_PREFIX}${block}`);
  if (node === null) throw new Error(`${c.name}: no block ${block}`);
  cutToHeaders(node);
  const { events } = await logColumnWidths(() => renderSheetGroupsWithPositions(defs as Parameters<typeof renderSheetGroupsWithPositions>[0]));
  const calls = events.filter((e) => e.marked && (e.table as Record<string, unknown> | undefined)?.[HEADER_ONLY] === true
    && !isStepsMeasure(e) && JSON.stringify(e.specs) === JSON.stringify(specs));
  if (calls.length === 0) throw new Error(`${c.name}: no header-only call with specs ${JSON.stringify(specs)}`);
  return Math.max(...calls.flatMap((e) => e.minWidths.filter((_, i) => isStar(e.specs[i]))));
}

describe("warning (d)'s heading figure is pdfmake's (#971 design §8.6)", () => {
  // Each column table at its standard columns and built-in labels: `headingWholeWidth`'s per-star
  // `head` within 0.5 of the star minimum pdfmake logs with the table's body cut to its header rows
  // (`textWidthOf` leaves out the pairs that kern narrower: "Purchase" reads 33.72 against pdfmake's 33.645).
  const COLUMN_TABLES = (Object.keys(DOCS) as (keyof typeof DOCS)[]).flatMap((doc) =>
    (contractFor(doc).canvas?.tables ?? []).filter((t) => t.printed !== null && t.printed.kind !== "steps").map((t) => ({ doc, block: t.key })));
  it("holds a case for every column table", () => {
    expect(COLUMN_TABLES.map((t) => `${t.doc} ${t.block}`)).toEqual([
      "TRAVELER lines", "TRAVELER quantities", "TRAVELER inspections",
      "SHIPPER field_strip", "SHIPPER lines", "SHIPPER containers",
      "MOS_SHIPPER field_strip", "MOS_SHIPPER lines", "MOS_SHIPPER containers",
      "BOL freight", "CERT parts", "INVOICE column_header", "STATEMENT aging", "QUOTE column_header",
    ]);
  });
  for (const { doc, block } of COLUMN_TABLES) {
    it(`${doc} ${block}`, async () => {
      const contract = contractFor(doc);
      const c = blockCase(doc, block, { x: LEFT, w: FULL_W }, false);
      const item = c.config.layout!.items.find((i) => i.kind === "table" && i.key === block);
      if (item?.kind !== "table") throw new Error(`no ${block}`);
      const fields = contract.sections.flatMap((s) => s.fields);
      const shown = item.columns.filter((col) => col.visible && fields.find((f) => f.key === col.key)?.column !== undefined)
        .map((col) => col.width ?? fields.find((f) => f.key === col.key)!.column!.defaultWidth);
      const printed = contract.canvas!.tables.find((t) => t.key === block)!.printed as { copies: number };
      const specs = Array.from({ length: printed.copies }, () => shown).flat();
      const figure = headingWholeWidth(contract, item, c.config.fonts)!;
      expect(figure.head, "a heading word over a star column").toBeGreaterThan(0);
      const pdfmake = await headerStarMinimum(c, block, specs);
      expect(Math.abs(figure.head - pdfmake), `${doc} ${block}: head ${figure.head} against pdfmake's ${pdfmake}`).toBeLessThanOrEqual(0.5);
    }, 60_000);
  }

  it("TRAVELER steps: no word over the instruction alone, and the spanning title prints whole at the least width", async () => {
    const contract = contractFor("TRAVELER");
    const item = DOCS.TRAVELER.layout().items.find((i) => i.kind === "table" && i.key === "steps");
    if (item?.kind !== "table") throw new Error("no steps");
    expect(headingWholeWidth(contract, item, contract.fonts)!.head).toBe(0);
    // With the title blank, pdfmake's instruction minimum is 0 too.
    const blank = blockCase("TRAVELER", "steps", { x: LEFT, w: FULL_W }, false, {
      mutate: (raw) => {
        raw.layout = { ...raw.layout!, items: raw.layout!.items.map((i) => (i.kind === "table" && i.key === "steps" ? { ...i, heading: "" } : i)) };
      },
    });
    expect(await headerStarMinimum(blank, "steps", [16, 62, "*", 34, 30, 46])).toBeLessThanOrEqual(0.5);
    // With the title shown, pdfmake spreads its widest word over the three columns it spans (the
    // header-only minimum the ledger records); the span holds 78 pt of fixed columns besides the
    // instruction's share, so on paper the title prints whole on one line at the least width.
    const w = LEAST["TRAVELER steps"];
    const dump = await dumpCanvasPaper(blockCase("TRAVELER", "steps", { x: r2(RIGHT - w), w }, false));
    const title = dump.perPage[0].runs.filter((r) => r.text.trim() === "PROCESS" || r.text.trim() === "STEPS:");
    expect(title.map((r) => r.text.trim())).toEqual(["PROCESS", "STEPS:"]);
    expect(title[0].y).toBe(title[1].y);
  }, 60_000);
});

/** The layout with the column headers showing their Quantity column alone. */
function quantityAlone(layout: CanvasLayout): CanvasLayout {
  return layoutOf(layout.items.map((i) => (i.kind === "table" && i.key === "column_header"
    ? { ...i, columns: i.columns.map((c) => (c.key === "col_qty" ? c : { ...c, visible: false })) } : i)));
}

describe("a grid block's floor holds the text it prints past the Quantity column (#971, Codex review)", () => {
  // The quote's lines print their Material line and PRICE heading, and the invoice's price block its
  // PRICE heading, as lines of their own at the Quantity column's width plus an indent
  // (`ctx.qtyW + QUOTE_WIDTHS.infoIndent`, `ctx.slotW.qty + INVOICE_WIDTHS.stripIndentGap`), outside
  // the grid's columns, where the column clamp cannot reach them. With the Quantity column shown
  // alone the grid's columns ask 56.5 pt, and drawn that wide against the right margin those lines
  // started at 589.5, past the 588 edge. Each block, drawn at its least width against the right
  // margin, is accepted, prints those lines from inside its box, and no run on the paper starts at or
  // past its right edge. (One grid step past the indent leaves 4.5 pt, so a heading wraps glyph by
  // glyph there: C1's convention holds a block's fixed parts and leaves its words to wrap.)
  const cases = [
    { doc: "QUOTE" as const, block: "lines", indent: QUOTE_WIDTHS.infoIndent },
    { doc: "INVOICE" as const, block: "price", indent: INVOICE_WIDTHS.stripIndentGap },
  ];
  for (const { doc, block, indent } of cases) {
    it(`${doc} ${block}: its least width with the Quantity column alone holds where its indented lines start`, async () => {
      const contract = contractFor(doc);
      const layout = quantityAlone(DOCS[doc].layout());
      const item = layout.items.find((i) => i.kind === "table" && i.key === block)!;
      const w = leastWidth(contract, item, { layout });
      const x = r2(RIGHT - w);
      const c = blockCase(doc, block, { x, w }, false, { mutate: (raw) => { raw.layout = quantityAlone(raw.layout!); } });
      expect(canvasRefusal(c.config.layout!, contract, { pageFooter: false }), `${doc} ${block} at ${w}`).toBeNull();
      const dump = await dumpCanvasPaper(c);
      const runs = dump.perPage.flatMap((page, p) => page.runs.filter((r) => r.text.trim() !== "").map((r) => ({ ...r, p })));
      // The indented lines are read where the builder starts them: the Quantity column's 52 and the indent.
      const qty = contract.sections.flatMap((s) => s.fields).find((f) => f.key === "col_qty")!.column!.defaultWidth as number;
      expect(runs.some((r) => Math.abs(r.x - (x + qty + indent)) < 1e-3), `${doc} ${block}: a run at ${x + qty + indent}`).toBe(true);
      expect(runs.filter((r) => r.x >= x + w).map((r) => `page ${r.p + 1}: "${r.text.trim()}" at ${r.x}`), `${doc} ${block} at ${w}`)
        .toEqual([]);
    }, 60_000);
  }
});

describe("the invoice totals' floor follows a typed Amount column (#971)", () => {
  // The totals print the column headers' Amount column at their right edge (`totalsBlock`:
  // `ctx.slotW.amt || W.amt`) beside their 200 pt label and two 6 pt gaps. Their floor was a fixed
  // 300.5 (Amount at its 84), so with Amount typed wider the totals drawn at that floor printed their
  // figures past their box (Amount 120: to 619.5, against the 588 margin). Drawn at their least width
  // against the right margin, they are accepted and nothing prints past their edge.
  const amountTyped = (width: number) => (layout: CanvasLayout): CanvasLayout => layoutOf(layout.items.map((i) => (
    i.kind === "table" && i.key === "column_header"
      ? { ...i, columns: i.columns.map((c) => (c.key === "col_amount" ? { ...c, width } : c)) } : i)));
  for (const amount of [120, 200]) {
    it(`the totals with Amount typed ${amount}, at their least width, print inside their box`, async () => {
      const contract = contractFor("INVOICE");
      const layout = amountTyped(amount)(DOCS.INVOICE.layout());
      const item = layout.items.find((i) => i.kind === "table" && i.key === "totals")!;
      const w = leastWidth(contract, item, { layout });
      const x = r2(RIGHT - w);
      const c = blockCase("INVOICE", "totals", { x, w }, false, { mutate: (raw) => { raw.layout = amountTyped(amount)(raw.layout!); } });
      expect(canvasRefusal(c.config.layout!, contract, { pageFooter: false }), `totals at ${w}`).toBeNull();
      const { strokes, runs, inked } = pastEdge(await dumpCanvasPaper(c), x, w);
      expect(inked).toBeGreaterThan(0);
      expect([...strokes, ...runs], `totals at ${w}`).toEqual([]);
      // The figure, read after the paper so a failure names what printed past the edge.
      expect(w).toBe(r2(INVOICE_WIDTHS.totalsLabel + 2 * INVOICE_WIDTHS.totalsGap + amount + 4.5));
    }, 60_000);
  }
});
