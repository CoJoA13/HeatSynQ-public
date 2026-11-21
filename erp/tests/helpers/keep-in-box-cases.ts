/**
 * The #971 keep-in-box cases (Task 1): every block in the fix's scope (design §5.3), its document's
 * standard fixture layout and one-page record, the width each block first fits at on `main`
 * (`FITTING_CASES`), and the in-the-box check both tests/canvas-keep-in-box-fitting.test.ts and the
 * later in-box suite read. A helper, so no test file imports another.
 *
 * The records are the canvas paper oracle's one-page records (tests/canvas-paper-oracle.test.ts):
 * the traveler and the ticket restated here, since the oracle is a test file and frozen; the rest the
 * fixtures' own (`sampleBol`, `sampleCert`, `sampleInvoice`, `richStatement`, `sampleQuote`).
 *
 * `FITTING_CASES` holds, per block, the first fitting width design §8.2 gives (report 1's threshold
 * plus 0.5 for the column tables it names no figure for; the ticket totals at 264.5), each checked on
 * `main` before #971's hook: drawn at x = 588 − w with the page line off, nothing of the block passes
 * its right edge (`outOfBox`), and, read by a throwaway wrapper on pdfmake's column calculator, no
 * printed row lays out wider than it was handed (the steps' one reading at 221 is `oversizedRows`'
 * measure, which prints nothing: design §5.5). The ledger
 * (docs/execution/2026-11-14-971-keep-in-box/progress.md, Task 1) records each width and its readings.
 * `outOfBox` reads to 0.001 pt by default (floating-point noise), so it refuses an overrun as small
 * as the quantities' 0.297 at 492.5.
 */
import type { TravelerData } from "@/server/traveler";
import type { TicketData } from "@/server/pdf/shipping-ticket";
import { barcodePng, pngDataUri } from "@/server/pdf/render";
import { PAGE_LINE_ROOM } from "@/lib/template-canvas";
import { defaultConfigFor, validateConfig, type TemplateConfig } from "@/lib/template-contracts/index";
import type { CanvasItem, CanvasLayout } from "@/lib/template-contracts/canvas";
import type { FontFamily } from "@/lib/template-contracts/types";
import { textWidthOf, type Face } from "@/lib/tag-font-metrics";
import { layoutOf, standardLayout } from "./canvas-fixtures";
import { standardTicketLayout } from "./ticket-canvas-fixtures";
import { sampleBol, standardBolLayout } from "./bol-canvas-fixtures";
import { sampleCert, standardCertLayout } from "./cert-canvas-fixtures";
import { sampleInvoice, standardInvoiceLayout } from "./invoice-canvas-fixtures";
import { richStatement, standardStatementLayout } from "./statement-canvas-fixtures";
import { sampleQuote, standardQuoteLayout } from "./quote-canvas-fixtures";
import type { PaperCase, PaperDoc, PaperDump } from "./canvas-paper-dump";

export const LEFT = 24;
export const FULL_W = 564;
export const RIGHT = 588;
const PAGE_HEIGHT = 792;
/** Strokes are read to 0.5 pt (a rule's half width and pdfkit's rounding). */
export const STROKE_TOLERANCE = 0.5;
/** A run's end is `x + textWidthOf`, which was up to about 0.3 pt under the paper before #986 counted
 *  the ASCII pairs pdfkit kerns wider (investigation report 2); it stays the design's reading tolerance. */
export const TEXT_TOLERANCE = 0.3;

export type Tolerance = { stroke: number; text: number };
/** The fit check's tolerance where the whole paper is read (the block ends at the right margin):
 *  floating-point noise alone. On `main` the fitting cases' worst excess there is 0 (strokes) and
 *  0.000018 (text) (Task 1, fix round 1), so an overrun of 0.297 (the quantities at 492.5) is refused. */
export const WHOLE_PAPER_TOLERANCE: Tolerance = { stroke: 0.001, text: 0.001 };
/** The fit check's tolerance where the block's ink is read against a shifted copy (a block at x 24
 *  drawn short of the right margin): the least that passes every recorded case, at the same noise
 *  floor. On `main` their worst excess is 0 (strokes) and 0.000016 (text) (Task 1, fix round 1).
 *  `STROKE_TOLERANCE` and `TEXT_TOLERANCE` stay the design's reading tolerances for later suites. */
export const SHIFTED_TOLERANCE: Tolerance = { stroke: 0.001, text: 0.001 };

const BARCODE = pngDataUri(await barcodePng("91246"));

/** The oracle's one-page traveler record (`travelerData(ordinary(1))`), with an optional container
 *  type for the flow's data-word overrun. */
export function travelerRecord(containerType = "Drop Pan"): TravelerData {
  return {
    orderNumber: 91246, poNumber: "", customerName: "Demo Castings Group",
    receivedFrom: ["200 Demo Drive", "Anniston, AL 36206"], customerPhone: "",
    company: { name: "Example Heat Treating", address: "1 Furnace Rd", phone: "256-555-0101" },
    lines: [{ qty: 4500, partNumber: "DEMO-PL-2001", partName: "U Bolt Rear Spr Plate", description: "Machined", eachWeight: 13.5, lineWeight: 60750 }],
    orderQty: 4500,
    containers: [{ typeName: containerType, count: 8, pieces: 320, tareEach: 367 }],
    materialName: "Ductile Iron", processId: "DEMO-PL-2001",
    inspections: [{ code: "Hardness", scale: "HBW", min: 269, max: 341, sampleQty: "8", location: "flange OD" }],
    revisionNumber: 1,
    steps: [{
      position: 1, codeName: "Austemper", instruction: "Pre-heat to 1100F.",
      values: [{ label: "Furnace Temp", value: "1650", unit: "°F" }],
    }],
    sheets: [{ loadNumber: 1, loadQty: 336, loadWeight: 4536, barcodeDataUri: BARCODE }],
    processName: "Austemper",
  };
}

/** The oracle's one-page ticket record (`[ticket(2, 2, 92036)]`). */
export function ticketRecord(): TicketData[] {
  return [{
    company: { name: "Example Heat Treating", address: "1201 Front St", phone: "(256) 555-0100", liabilityText: "LIABILITY ONE.\n\nLIABILITY TWO." },
    soldTo: { code: "9054", attn: "", name: "Demo Components Corporation", street: "300 Example Way", city: "Anniston", state: "AL", zip: "36201" },
    shipTo: { code: "", attn: "", name: "Example Coating", street: "88 Dock Rd.", city: "Oxford", state: "AL", zip: "36203" },
    orderLabel: "92036-1", orderNumber: 92036, shipDate: "2026-07-29",
    poNumber: "PO-1", packingListNo: 1, customerJobNo: "JOB-9", route: "South", carrierName: "Customer",
    lines: Array.from({ length: 2 }, (_, i) => ({
      qty: 1000 + i, partNumber: `PART-${i}`, partName: "Track Shoe, Vehicular", partDescription: `DESC-${i}`, pounds: 4128 + i,
    })),
    containers: Array.from({ length: 2 }, (_, i) => ({ typeName: `Bin${i}`, count: 3, customerContainerId: `CC-${i}`, tareEach: 42.5 })),
    serials: [{ serial: "SN-0001", description: "Heat A1" }],
    shippedComplete: true, totalQty: 1,
  }];
}

/** Each document's standard fixture layout and one-page record. */
export const DOCS: Record<PaperDoc, { layout: () => CanvasLayout; record: () => unknown }> = {
  TRAVELER: { layout: standardLayout, record: () => travelerRecord() },
  SHIPPER: { layout: standardTicketLayout, record: ticketRecord },
  MOS_SHIPPER: { layout: standardTicketLayout, record: ticketRecord },
  BOL: { layout: standardBolLayout, record: () => sampleBol() },
  CERT: { layout: standardCertLayout, record: () => sampleCert() },
  INVOICE: { layout: standardInvoiceLayout, record: () => sampleInvoice() },
  STATEMENT: { layout: standardStatementLayout, record: () => richStatement() },
  QUOTE: { layout: standardQuoteLayout, record: () => sampleQuote() },
};

export type FittingCase = { doc: PaperDoc; block: string; w: number };

/**
 * Each block of design §5.3 at the first width it fits at on `main` (Task 1 Step 1). The design's
 * figures (§8.2): the quantities 493, the containers 504, the parts 291.5, the price 270, the quote
 * lines 272, the parties 198.7, the closing 286, the open items 219.1, the steps 221; every other
 * column table its report 1 threshold + 0.5 (the traveler's lines 316.86, inspections 347.58, the
 * ticket's field strip 377.09 and lines 224.86, the bill of lading's freight ≈466.9, the
 * certification's parts 229.97, the invoice's and quote's column headers 290.87 and 289.71, the
 * statement's aging 344.82); the ticket totals 264.5 (its new least width; it overflows below 260).
 */
export const FITTING_CASES: FittingCase[] = [
  { doc: "TRAVELER", block: "lines", w: 317.36 },
  { doc: "TRAVELER", block: "quantities", w: 493 },
  { doc: "TRAVELER", block: "inspections", w: 348.08 },
  { doc: "TRAVELER", block: "steps", w: 221 },
  ...(["SHIPPER", "MOS_SHIPPER"] as const).flatMap((doc): FittingCase[] => [
    { doc, block: "field_strip", w: 377.59 },
    { doc, block: "lines", w: 225.36 },
    { doc, block: "containers", w: 504 },
    { doc, block: "totals", w: 264.5 },
  ]),
  { doc: "BOL", block: "freight", w: 467.4 },
  { doc: "CERT", block: "parts", w: 230.47 },
  { doc: "INVOICE", block: "column_header", w: 291.37 },
  { doc: "INVOICE", block: "parties", w: 198.7 },
  { doc: "INVOICE", block: "parts", w: 291.5 },
  { doc: "INVOICE", block: "price", w: 270 },
  { doc: "QUOTE", block: "column_header", w: 290.21 },
  { doc: "QUOTE", block: "lines", w: 272 },
  { doc: "QUOTE", block: "closing", w: 286 },
  { doc: "STATEMENT", block: "aging", w: 345.32 },
  { doc: "STATEMENT", block: "open_items", w: 219.1 },
];

/** The layout with the table `block` drawn at `box`'s x and width (its top and height kept). */
export function reboxed(layout: CanvasLayout, block: string, box: { x: number; w: number }): CanvasLayout {
  let found = 0;
  const items = layout.items.map((i) => {
    if (i.kind !== "table" || i.key !== block) return i;
    found += 1;
    return { ...i, box: { ...i.box, ...box } };
  });
  if (found !== 1) throw new Error(`reboxed: ${found} table items under ${block}`);
  return layoutOf(items);
}

/** The layout with every page-bottom item that would end in the page line's room lifted by that room
 *  (the oracle's `lifted`). */
export function lifted(layout: CanvasLayout): CanvasLayout {
  const foot = PAGE_HEIGHT - 24 - PAGE_LINE_ROOM;
  const reaches = layout.items.some((i) => i.kind !== "table" && i.anchor.kind === "page-bottom" && i.box.y + i.box.h > foot);
  if (!reaches) return layout;
  return layoutOf(layout.items.map((i) => (i.kind !== "table" && i.anchor.kind === "page-bottom"
    ? { ...i, box: { ...i.box, y: i.box.y - PAGE_LINE_ROOM } } as CanvasItem : i)));
}

/** One case: `doc`'s standard layout with `block` drawn at x and w, page line `pageFooter`, on the
 *  document's one-page record. `mutate` edits the raw config before it is validated. */
export function blockCase(
  doc: PaperDoc, block: string, at: { x: number; w: number }, pageFooter: boolean,
  options: { record?: unknown; mutate?: (c: TemplateConfig) => void } = {},
): PaperCase {
  const layout = reboxed(DOCS[doc].layout(), block, at);
  const raw: TemplateConfig = { ...structuredClone(defaultConfigFor(doc)), layout: pageFooter ? lifted(layout) : layout, pageFooter };
  options.mutate?.(raw);
  return {
    name: `${doc} ${block} x ${at.x} w ${at.w} [page line ${pageFooter ? "on" : "off"}]`,
    doc, config: validateConfig(doc, raw), data: options.record ?? DOCS[doc].record(), premise: { kind: "full" },
  };
}

const FONTS: Record<string, [FontFamily, Face]> = {};
for (const [family, stem] of [["Roboto", "Roboto"], ["Liberation Sans", "LiberationSans"], ["Liberation Serif", "LiberationSerif"], ["Roboto Mono", "RobotoMono"]] as const) {
  const bold = family === "Roboto" ? "Medium" : "Bold";
  FONTS[`${stem}-Regular`] = [family, "normal"];
  FONTS[`${stem}-${bold}`] = [family, "bold"];
  FONTS[`${stem}-Italic`] = [family, "italics"];
  FONTS[`${stem}-${bold}Italic`] = [family, "bolditalics"];
}

/** The family and face a run's BaseFont names; throws on one it does not know (fails closed). */
export function fontOf(baseFont: string): [FontFamily, Face] {
  const f = FONTS[baseFont];
  if (f === undefined) throw new Error(`fontOf: unknown font ${baseFont}`);
  return f;
}

const key = (v: unknown) => JSON.stringify(v);

/** The elements of `a` not matched one for one in `b` (a multiset difference by JSON). */
function unmatched<T>(a: T[], b: T[]): T[] {
  const left = new Map<string, number>();
  for (const e of b) left.set(key(e), (left.get(key(e)) ?? 0) + 1);
  return a.filter((e) => {
    const n = left.get(key(e)) ?? 0;
    if (n === 0) return true;
    left.set(key(e), n - 1);
    return false;
  });
}

/**
 * What of a block drawn at x and w prints past its right edge `x + w`: every stroke reaching past
 * `x + w` and every text run whose end (x + `textWidthOf` of its text, trailing spaces off, in its
 * run's own family, face and size) passes `x + w`, each by more than `tolerance` (by default
 * `WHOLE_PAPER_TOLERANCE` or `SHIFTED_TOLERANCE`, by how the ink is read), on every page. `most`
 * holds the largest excess seen of each.
 *
 * Which ink is the block's: with `shifted`, the dump of the same case with the block alone moved
 * sideways, the block's ink is what `dump` prints and `shifted` does not (a block's width, not its x,
 * sets how its columns lay out, and the items around it do not follow its x). Ink a block anchors to
 * the margins rather than its x is left out: the invoice price block's #589 rule, which prints from
 * margin to margin whatever the block's x and width by design, and is no column overflow. Without it, the
 * block must end at the right margin (`x + w` = 588), and the whole paper is read: nothing on a
 * standard layout passes 588. `inked` counts the strokes and runs read, so a reading that saw
 * nothing is seen.
 */
export function outOfBox(
  dump: PaperDump, x: number, w: number, shifted?: PaperDump, tolerance?: Tolerance,
): { past: string[]; inked: number; most: Tolerance } {
  const edge = x + w;
  if (shifted === undefined && Math.abs(edge - RIGHT) > 1e-9) throw new Error(`outOfBox: the block ends at ${edge}, not ${RIGHT}, and no shifted dump was given`);
  if (shifted !== undefined && shifted.pages !== dump.pages) throw new Error(`outOfBox: the shifted dump prints ${shifted.pages} pages, not ${dump.pages}`);
  const tol = tolerance ?? (shifted === undefined ? WHOLE_PAPER_TOLERANCE : SHIFTED_TOLERANCE);
  const past: string[] = [];
  const most: Tolerance = { stroke: -Infinity, text: -Infinity };
  let inked = 0;
  dump.perPage.forEach((page, p) => {
    const strokes = shifted === undefined ? page.strokes : unmatched(page.strokes, shifted.perPage[p].strokes);
    const runs = (shifted === undefined ? page.runs : unmatched(page.runs, shifted.perPage[p].runs)).filter((r) => r.text.trim() !== "");
    for (const s of strokes) {
      inked += 1;
      const reach = Math.max(s.x1, s.x2);
      most.stroke = Math.max(most.stroke, reach - edge);
      if (reach > edge + tol.stroke) past.push(`page ${p + 1}: stroke ${s.x1}..${s.x2}@${s.y1} reaches ${reach}`);
    }
    for (const r of runs) {
      inked += 1;
      const [family, face] = fontOf(r.font);
      const end = r.x + textWidthOf(r.text.trimEnd(), family, face, r.size);
      most.text = Math.max(most.text, end - edge);
      if (end > edge + tol.text) past.push(`page ${p + 1}: run "${r.text.trim()}" ${r.x}..${Math.round(end * 1000) / 1000}`);
    }
  });
  return { past, inked, most };
}
