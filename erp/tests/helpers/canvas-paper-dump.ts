/**
 * The canvas paper dump (#969, Task 1): a canvas definition's printed paper read back off its
 * bytes, page by page, with the first sheet group's laid-out positions and the preview's measure,
 * so tests/canvas-paper-oracle.test.ts can freeze it and a later change that moves nothing can show
 * it moved nothing. PDF bytes are never compared (CLAUDE.md: `renderPdf` is not byte-deterministic);
 * what is read is what prints:
 *
 * - text runs: text, x, y (device space, from the page's bottom), font and size, the per-page form
 *   of `runFonts` (tests/helpers/pdf.ts reads page 1 alone);
 * - stroked line segments (`strokedLines`);
 * - rectangles: every `re` with the paint operator that ends its path (`S`, `f`, `B`, …, or `W n`
 *   for a clip) and the fill opacity (`/ca` of the ExtGState in force, `q`/`Q` tracked), which
 *   `strokedLines` does not see (box items, a checkbox, the zero-size marks' fills);
 * - painted images (`paintedImages`);
 * - the page count.
 *
 * Text, stroke, rect and image numbers are taken as parsed from the content stream (pdfkit writes
 * them to 1e-6). Positions and measure numbers are rounded to 0.001 pt.
 *
 * The measure MIRRORS `measuredPreview` (src/server/template-preview.ts), which is not exported:
 * `canvasMeasure` over the first sheet group's positions through the document's belt, then the
 * float regions and band laid out alone (`aloneLayouts`, `layOutSheetGroups`) and merged in
 * (`mergeAloneMeasure`), from the document's own item node. A change to `measuredPreview` must be
 * followed here.
 *
 * Since quote canvas PR 2, a second edit is sanctioned beside the ruled re-write the oracle's header
 * names: a new document's cases, added by the owner's ruling of 2026-11-12 on the quotation canvas
 * design's call 14. This file gains the quote's `PaperDoc` member and its two arms, and nothing else
 * here changes.
 */
import { createHash } from "node:crypto";
import { buildTravelerDefinitions, travelerCanvasItemContent, type TravelerData } from "@/server/traveler";
import { buildShippingTicketDefinitions, ticketCanvasItemContent, type TicketData } from "@/server/pdf/shipping-ticket";
import { buildBolDefinition, bolCanvasItemContent, type BolData } from "@/server/pdf/bol";
import { buildCertDefinition, certCanvasItemContent, type CertPdfData } from "@/server/pdf/cert";
import { buildInvoiceDefinition, invoiceCanvasItemContent, type InvoicePdfData } from "@/server/pdf/invoice";
import { buildStatementDefinition, statementCanvasItemContent, type StatementData } from "@/server/pdf/statement";
import { buildQuoteDefinition, quoteCanvasItemContent, type QuotePdfData } from "@/server/pdf/quote";
import {
  layOutSheetGroups, renderSheetGroupsWithPositions, type LaidOutNode, type RenderableDefinition,
} from "@/server/pdf/render";
import { aloneLayouts, type ItemContent } from "@/server/pdf/canvas-sheet";
import { canvasMeasure, mergeAloneMeasure } from "@/server/canvas-measure";
import { completeCanvas } from "@/server/traveler-canvas";
import { completeTicketCanvas } from "@/server/shipping-ticket-canvas";
import { completeBolCanvas } from "@/server/bol-canvas";
import { completeCertCanvas } from "@/server/cert-canvas";
import { completeInvoiceCanvas } from "@/server/invoice-canvas";
import { completeStatementCanvas } from "@/server/statement-canvas";
import { completeQuoteCanvas } from "@/server/quote-canvas";
import type { CanvasMeasure } from "@/lib/template-canvas";
import type { CanvasLayout } from "@/lib/template-contracts/canvas";
import type { TemplateConfig } from "@/lib/template-contracts/types";
import { pageCount, pageStreams, pagesInOrder, paintedImages, parseObjects, strokedLines, textRunsWithY, type StrokedLine } from "./pdf";

export type PaperDoc = "TRAVELER" | "SHIPPER" | "MOS_SHIPPER" | "BOL" | "CERT" | "INVOICE" | "STATEMENT" | "QUOTE";

/** Class 1 (`full`), class 2a (`flat`), class 2b (`breaks`: `block` breaks across a page, and
 *  `control` names the class 1 case on the same data with that block at x 24, w 564). */
export type Premise = { kind: "full" } | { kind: "flat" } | { kind: "breaks"; block: string; control: string };

/** One case: a document, its validated config (its `layout` a canvas) and its print data (a ticket
 *  case's `TicketData[]`; an invoice case's may be a credit memo). */
export type PaperCase = {
  name: string; doc: PaperDoc; config: TemplateConfig; data: unknown; logoDataUri?: string; premise: Premise;
};

export type Run = { text: string; x: number; y: number; font: string; size: number };
export type Rect = { x: number; y: number; w: number; h: number; paint: string; opacity: number };
export type Img = { x: number; y: number; w: number; h: number };

export type PaperDump = {
  pages: number;
  perPage: { runs: Run[]; strokes: StrokedLine[]; rects: Rect[]; images: Img[] }[];
  positions: { id: string; page: number; left: number; top: number }[];
  measure: CanvasMeasure;
};

/** The case's definitions, as its print builds them. */
export function definitionsOf(c: PaperCase): RenderableDefinition[] {
  switch (c.doc) {
    case "TRAVELER": return buildTravelerDefinitions(c.data as TravelerData, c.config, c.logoDataUri);
    case "SHIPPER":
    case "MOS_SHIPPER": return buildShippingTicketDefinitions(c.data as TicketData[], c.doc, c.config, c.logoDataUri);
    case "BOL": return [buildBolDefinition(c.data as BolData, c.config, c.logoDataUri)];
    case "CERT": return [buildCertDefinition(c.data as CertPdfData, c.config, c.logoDataUri)];
    case "INVOICE": return [buildInvoiceDefinition(c.data as InvoicePdfData, c.config, c.logoDataUri)];
    case "STATEMENT": return [buildStatementDefinition(c.data as StatementData, c.config, c.logoDataUri)];
    case "QUOTE": return [buildQuoteDefinition(c.data as QuotePdfData, c.config, c.logoDataUri)];
  }
}

/** The document's item node and belt, as `renderPreview` hands them to `measuredPreview`. */
function measureParts(c: PaperCase): { itemContent: ItemContent; complete: (layout: CanvasLayout) => CanvasLayout } {
  switch (c.doc) {
    case "TRAVELER":
      return { itemContent: travelerCanvasItemContent(c.data as TravelerData, c.config, c.logoDataUri), complete: completeCanvas };
    case "SHIPPER":
    case "MOS_SHIPPER":
      return { itemContent: ticketCanvasItemContent(c.data as TicketData[], c.doc, c.config, c.logoDataUri), complete: completeTicketCanvas };
    case "BOL":
      return { itemContent: bolCanvasItemContent(c.data as BolData, c.config, c.logoDataUri), complete: completeBolCanvas };
    case "CERT":
      return { itemContent: certCanvasItemContent(c.data as CertPdfData, c.config, c.logoDataUri), complete: completeCertCanvas };
    case "INVOICE":
      return { itemContent: invoiceCanvasItemContent(c.data as InvoicePdfData, c.config, c.logoDataUri), complete: completeInvoiceCanvas };
    case "STATEMENT":
      return { itemContent: statementCanvasItemContent(c.data as StatementData, c.config, c.logoDataUri), complete: completeStatementCanvas };
    case "QUOTE":
      return { itemContent: quoteCanvasItemContent(c.data as QuotePdfData, c.config, c.logoDataUri), complete: completeQuoteCanvas };
  }
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Every number in a JSON value rounded to 0.001. */
function rounded<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (_k, v: unknown) => (typeof v === "number" ? r3(v) : v)) as T;
}

/** Each page's text runs with the font (its BaseFont, the subset tag dropped) and size in force,
 *  read with `textRunsWithY`'s own operator walk so the two line up run for run. */
export function runsPerPage(pdf: Buffer): Run[][] {
  const objs = parseObjects(pdf);
  const pages = pagesInOrder(objs);
  const all = textRunsWithY(pdf);
  return pages.map((page, p) => {
    const resRef = /\/Resources\s+(\d+)\s+0\s+R/.exec(page.body);
    const resources = resRef ? (objs.get(Number(resRef[1]))?.body ?? "") : page.body;
    const fontDict = /\/Font\s*<<([\s\S]*?)>>/.exec(resources)?.[1] ?? "";
    const names = new Map<string, string>();
    for (const [, name, num] of fontDict.matchAll(/\/([\w-]+)\s+(\d+)\s+0\s+R/g)) {
      const base = /\/BaseFont\s*\/([\w+-]+)/.exec(objs.get(Number(num))?.body ?? "")?.[1] ?? "";
      names.set(name, base.replace(/^[A-Z]{6}\+/, ""));
    }
    const contents = /\/Contents\s+(\[[\s\S]*?\]|\d+\s+0\s+R)/.exec(page.body);
    const refs = contents ? [...contents[1].matchAll(/(\d+)\s+0\s+R/g)].map((r) => Number(r[1])) : [];
    const shown: { font: string; size: number }[] = [];
    for (const ref of refs) {
      const content = objs.get(ref)?.stream?.toString("latin1") ?? "";
      const opRe = /\/([\w-]+)\s+([\d.]+)\s+Tf|(?:[-\d.]+\s+){4}([-\d.]+)\s+([-\d.]+)\s+Tm|\[((?:<[0-9a-fA-F]+>|[-\d.\s])+)\]\s*TJ|<([0-9a-fA-F]+)>\s*Tj/g;
      let font = "";
      let size = 0;
      let m: RegExpExecArray | null;
      while ((m = opRe.exec(content)) !== null) {
        if (m[1] !== undefined) { font = names.get(m[1]) ?? ""; size = Number(m[2]); continue; }
        if (m[3] !== undefined) continue;
        shown.push({ font, size });
      }
    }
    const runs = all[p];
    if (runs.length !== shown.length) throw new Error(`runsPerPage: page ${p + 1}: ${runs.length} runs, ${shown.length} shows`);
    return runs.map((r, i) => ({ text: r.text, x: r.x, y: r.y, ...shown[i] }));
  });
}

/** Each page's ExtGState names mapped to their fill opacity (`/ca`, 1 when the state sets none). */
function fillOpacities(pdf: Buffer): Map<string, number>[] {
  const objs = parseObjects(pdf);
  return pagesInOrder(objs).map((page) => {
    const resRef = /\/Resources\s+(\d+)\s+0\s+R/.exec(page.body);
    const resources = resRef ? (objs.get(Number(resRef[1]))?.body ?? "") : page.body;
    const gsRef = /\/ExtGState\s+(\d+)\s+0\s+R/.exec(resources);
    const gsDict = gsRef
      ? (objs.get(Number(gsRef[1]))?.body ?? "")
      : (/\/ExtGState\s*<<([\s\S]*?)>>/.exec(resources)?.[1] ?? "");
    const out = new Map<string, number>();
    for (const [, name, num] of gsDict.matchAll(/\/([\w-]+)\s+(\d+)\s+0\s+R/g)) {
      const ca = /\/ca\s+([-\d.]+)/.exec(objs.get(Number(num))?.body ?? "");
      out.set(name, ca ? Number(ca[1]) : 1);
    }
    return out;
  });
}

const PAINT_OPS = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"]);

/** Every rectangle (`x y w h re`) painted on each page, in draw order, in the content stream's own
 *  (top-down) coordinates: the paint operator that ends its path (`W n` when the path is a clip)
 *  and the fill opacity in force (`/ca` of the last `gs`, saved and restored by `q`/`Q`). */
export function rectsPerPage(pdf: Buffer): Rect[][] {
  const opacities = fillOpacities(pdf);
  const token = /<<|>>|<[0-9a-fA-F\s]*>|\/[^\s/[\]()<>{}%]+|[-+]?(?:\d+\.?\d*|\.\d+)|[A-Za-z*'"]+|\[|\]/g;
  return pageStreams(pdf).map((stream, p) => {
    const rects: Rect[] = [];
    const stack: number[] = [];
    let opacity = 1;
    let operands: string[] = [];
    let pending: { x: number; y: number; w: number; h: number }[] = [];
    let clip = false;
    for (const [tok] of stream.matchAll(token)) {
      if (/^[-+]?(?:\d|\.\d)/.test(tok) || tok.startsWith("/") || tok.startsWith("<") || tok === "[" || tok === "]" || tok === ">>") {
        operands.push(tok);
        continue;
      }
      const op = tok;
      if (op === "q") stack.push(opacity);
      else if (op === "Q") opacity = stack.pop() ?? 1;
      else if (op === "gs") {
        const name = operands[operands.length - 1]?.slice(1) ?? "";
        opacity = opacities[p].get(name) ?? opacity;
      } else if (op === "re") {
        const [x, y, w, h] = operands.slice(-4).map(Number);
        pending.push({ x, y, w, h });
      } else if (op === "W" || op === "W*") clip = true;
      else if (PAINT_OPS.has(op)) {
        const paint = clip ? `${op === "n" ? "W n" : `W ${op}`}` : op;
        for (const r of pending) rects.push({ ...r, paint, opacity });
        pending = [];
        clip = false;
      }
      operands = [];
    }
    return rects;
  });
}

/** The case's paper: its definitions rendered once, read page by page, its first sheet group's
 *  positions and its measure. */
export async function dumpCanvasPaper(c: PaperCase): Promise<PaperDump> {
  return dumpDefinitions(c, definitionsOf(c));
}

/** `dumpCanvasPaper` over definitions the caller supplies (a JSON copy re-shaped by a test). */
export async function dumpDefinitions(c: PaperCase, defs: RenderableDefinition[]): Promise<PaperDump> {
  if (c.config.layout === null) throw new Error(`${c.name}: not a canvas config`);
  const layout = c.config.layout;
  const { pdf, groups } = await renderSheetGroupsWithPositions(defs);
  const runs = runsPerPage(pdf);
  const strokes = strokedLines(pdf);
  const rects = rectsPerPage(pdf);
  const images = paintedImages(pdf);
  const pages = pageCount(pdf);
  if (runs.length !== pages || strokes.length !== pages || rects.length !== pages || images.length !== pages) {
    throw new Error(`${c.name}: a reader saw ${runs.length}/${strokes.length}/${rects.length}/${images.length} pages of ${pages}`);
  }
  // measuredPreview's measure (src/server/template-preview.ts), restated.
  const { itemContent, complete } = measureParts(c);
  let measure = canvasMeasure(layout, c.config.pageFooter, groups[0], complete);
  const alone = aloneLayouts({ layout, pageFooter: c.config.pageFooter, fonts: c.config.fonts, itemContent });
  const laid = await layOutSheetGroups(alone.map((a) => a.def));
  measure = mergeAloneMeasure(measure, layout, c.config.pageFooter, alone.map((a, i) => ({ after: a.after, positions: laid[i] })));
  return {
    pages,
    perPage: runs.map((pageRuns, p) => ({ runs: pageRuns, strokes: strokes[p], rects: rects[p], images: images[p] })),
    positions: rounded(groups[0].positions.map((n: LaidOutNode) => ({ id: n.id, page: n.page, left: n.left, top: n.top }))),
    measure: rounded(measure),
  };
}

/** JSON with every object's keys in sorted order, so equal values always hash equal. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Sorted by each element's canonical JSON: a draw-order change alone (which re-nesting a node may
 *  make) moves nothing that prints. */
const sorted = <T>(xs: T[]): string[] => xs.map(canonical).sort();

/**
 * The dump's digest: the page count; per page, the sha-256 hex of the canonical JSON of its runs,
 * strokes, rects and images, each list SORTED (so draw order alone is not frozen); the positions'
 * hash, the list sorted by id, page, top and left (pdfmake reports them in document order, which
 * re-nesting a block does not change, sorted here so it cannot matter); and the measure's hash.
 */
export function digest(dump: PaperDump): { pages: number; perPage: string[]; positions: string; measure: string } {
  return {
    pages: dump.pages,
    perPage: dump.perPage.map((page) => sha(canonical({
      runs: sorted(page.runs), strokes: sorted(page.strokes), rects: sorted(page.rects), images: sorted(page.images),
    }))),
    positions: sha(canonical(sorted(dump.positions))),
    measure: sha(canonical(dump.measure)),
  };
}

/** The content's width: a block's lateral margin and its column's width add up to it. */
const CONTENT_WIDTH = 564;
const TABLE_ID_PREFIX = "canvas:table:";

/** The lateral margin of a node, [left, right], 0 where it carries none. */
function laterals(node: Record<string, unknown>): [number, number] {
  const m = node.margin;
  return Array.isArray(m) && m.length === 4 ? [Number(m[0]), Number(m[2])] : [0, 0];
}

/** A block's inner column group, in the shape that sets its lateral margin on a zero-gap `columns`
 *  node under a wrapper at [0, 0, 0, 0] (the statement's today; every document's after #969): the
 *  wrapper's first child when it is a zero-gap `columns` node carrying a margin. */
function innerGroup(o: Record<string, unknown>): { columns: { width: unknown }[]; margin: number[] } | null {
  const [l, r] = laterals(o);
  if (l !== 0 || r !== 0 || !Array.isArray(o.stack)) return null;
  const inner = o.stack[0] as { columns?: { width: unknown }[]; columnGap?: unknown; margin?: number[] } | undefined;
  if (!Array.isArray(inner?.columns) || inner.columns.length === 0 || inner.columnGap !== 0 || !Array.isArray(inner.margin)) return null;
  return inner as { columns: { width: unknown }[]; margin: number[] };
}

/** Calls `visit` on every object in the definitions' content (a JSON copy's), depth first. */
function eachNode(defs: RenderableDefinition[], visit: (o: Record<string, unknown>) => boolean): void {
  const walk = (node: unknown) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const o = node as Record<string, unknown>;
    if (visit(o)) return;
    Object.values(o).forEach(walk);
  };
  defs.forEach((d) => walk(d.content));
}

/**
 * A JSON copy of the definitions with the block `key` printed in ONE "*" column at its drawn place,
 * the oracle's "*" discriminator (tests/canvas-paper-oracle.test.ts, class 2a). It reads either
 * block shape, so the frozen oracle's premise survives the move between them:
 * - the node under the block's id carries the lateral margin (`atDrawnPlace`'s shape): the node is
 *   wrapped in `{ id, columns: [{ width: "*", stack: [node] }], columnGap: 0, margin: [l, 0, r, 0] }`,
 *   its own id dropped and its margin zeroed;
 * - the node under the id is a wrapper at [0, 0, 0, 0] whose first child is a `columns` node carrying
 *   the margin (the shared block shape #969 moves every document to): that group's first column is
 *   made "*".
 * Throws when the id names no node, or a node in neither shape.
 */
export function starShaped(defs: RenderableDefinition[], key: string): RenderableDefinition[] {
  const copy = JSON.parse(JSON.stringify(defs)) as RenderableDefinition[];
  let found = 0;
  eachNode(copy, (o) => {
    if (o.id !== `${TABLE_ID_PREFIX}${key}`) return false;
    found += 1;
    const inner = innerGroup(o);
    if (inner !== null) {
      inner.columns[0].width = "*";
      return true;
    }
    const [l, r] = laterals(o);
    if (l === 0 && r === 0) throw new Error(`${TABLE_ID_PREFIX}${key}: neither block shape`);
    const { id, ...rest } = o;
    for (const k of Object.keys(o)) delete o[k];
    Object.assign(o, { id, columns: [{ width: "*", stack: [{ ...rest, margin: [0, 0, 0, 0] }] }], columnGap: 0, margin: [l, 0, r, 0] });
    return true;
  });
  if (found === 0) throw new Error(`no node under ${TABLE_ID_PREFIX}${key}`);
  return copy;
}

/**
 * A JSON copy of the definitions with every block's column toggled: in a block of the shared shape
 * (`innerGroup`), a "*" first column takes its fixed width (564 less the group's lateral margin) and
 * a fixed one becomes "*". The count of columns toggled. The oracle's statement premise: no statement
 * case holds a child wider than its block, so the copy prints exactly as the case does, whichever
 * shape the statement's column has (a "*" one today, a fixed one after #969's Task 8).
 */
export function columnToggled(defs: RenderableDefinition[]): { defs: RenderableDefinition[]; count: number } {
  const copy = JSON.parse(JSON.stringify(defs)) as RenderableDefinition[];
  let count = 0;
  eachNode(copy, (o) => {
    if (typeof o.id !== "string" || !o.id.startsWith(TABLE_ID_PREFIX)) return false;
    const inner = innerGroup(o);
    if (inner === null) return false;
    const fixed = CONTENT_WIDTH - (inner.margin[0] + inner.margin[2]);
    inner.columns[0].width = inner.columns[0].width === "*" ? fixed : "*";
    count += 1;
    return true;
  });
  return { defs: copy, count };
}
