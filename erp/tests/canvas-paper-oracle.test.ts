import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TravelerData } from "@/server/traveler";
import type { TicketData } from "@/server/pdf/shipping-ticket";
import type { CertPdfData } from "@/server/pdf/cert";
import type { InvoicePdfData } from "@/server/pdf/invoice";
import type { StatementOpenItem } from "@/server/pdf/statement";
import type { QuotePdfData } from "@/server/pdf/quote";
import { CANVAS_IDS } from "@/server/pdf/canvas-sheet";
import { barcodePng, pngDataUri, type RenderableDefinition } from "@/server/pdf/render";
import { PAGE_LINE_ROOM, canvasRefusal, leastWidth } from "@/lib/template-canvas";
import { contractFor, defaultConfigFor, validateConfig, type TemplateConfig } from "@/lib/template-contracts/index";
import type { CanvasItem, CanvasLayout } from "@/lib/template-contracts/canvas";
import { layoutOf, logo, standardLayout } from "./helpers/canvas-fixtures";
import { standardTicketLayout, ticketTable } from "./helpers/ticket-canvas-fixtures";
import { sampleBol, standardBolLayout } from "./helpers/bol-canvas-fixtures";
import { sampleCert, standardCertLayout } from "./helpers/cert-canvas-fixtures";
import { sampleInvoice, standardInvoiceLayout } from "./helpers/invoice-canvas-fixtures";
import { richStatement, sampleStatement, standardStatementLayout } from "./helpers/statement-canvas-fixtures";
import { quoteLines, sampleQuote, standardQuoteLayout } from "./helpers/quote-canvas-fixtures";
import { TINY_JPEG, type StrokedLine } from "./helpers/pdf";
import {
  canonical, columnToggled, definitionsOf, digest, dumpCanvasPaper, dumpDefinitions, starShaped,
  type PaperCase, type PaperDoc, type PaperDump, type Premise,
} from "./helpers/canvas-paper-dump";

/**
 * The canvas paper oracle (#969, Task 1). Every canvas layout that prints correctly today, frozen as
 * it prints: per page, the text runs (text, x, y, font, size), the stroked lines, the painted
 * rectangles (their paint and fill opacity) and the painted images; the page count; the first sheet
 * group's laid-out positions; and the preview's measure (tests/helpers/canvas-paper-dump.ts, whose
 * measure mirrors `measuredPreview` in src/server/template-preview.ts and must follow it). The
 * fixture holds each case's `digest`: the page count, one sha-256 per page over that page's four
 * lists, each SORTED by its elements' canonical JSON (a draw-order change alone moves nothing that
 * prints), and one over the positions (sorted) and one over the measure. Text, stroke, rect and image
 * numbers are as parsed from the content stream (pdfkit writes them to 1e-6); positions and measure
 * numbers are rounded to 0.001 pt. PDF bytes are never compared.
 *
 * The classes (`Premise`): class 1 (`full`), the standard fixture layouts and the full-width controls;
 * class 2a (`flat`), each table drawn narrower that does not page (but for the quote's lines at the
 * narrowest accepted width, since #971), with "*" discriminators whose "*" copy prints the same since
 * #971's column clamp (owner, 2026-11-14); and class 2b (`breaks`), a narrowed block that pages and prints correctly today. Every case runs with
 * the page line off and on, and its premises are asserted when the fixture is written and every time
 * it is read: the test refuses to write the fixture when one fails. The four narrowed-paging
 * combinations #969 fixes (a cert or invoice block holding a table or column group, the ticket's
 * totals, a traveler steps table with an oversized row) are excluded by design: Tasks 3 to 6 own them.
 *
 * The fixture is written ONCE, in one commit, at the base the fix is measured from
 * (`CANVAS_PAPER_ORACLE_WRITE=1`, which writes only after every case ran and passed its premises).
 * A later change that moves canvas paper by an owner ruling re-writes it with that flag in a commit
 * of its own that names the ruling; no other change edits it. `CANVAS_PAPER_ORACLE_DUMP=<dir>` also
 * writes the full dump of each case (of each failing case when not writing), unsorted, for diffing.
 *
 * Since quote canvas PR 2, a second edit is sanctioned beside that re-write: a new document's cases,
 * added by the owner's ruling of 2026-11-12 on the quotation canvas design's call 14. The quote's
 * cases (the `// QUOTE` block, placed before the statement's so every earlier case keeps its place in
 * the fixture) land in one commit run in read mode, and the fixture is re-written in a second commit
 * of its own, checked by parsing that no earlier case's digest moved. No premise, reader or earlier
 * case changes with them.
 */

const ORACLE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "canvas-paper-oracle.json");
const WRITE = process.env.CANVAS_PAPER_ORACLE_WRITE === "1";
const DUMP_DIR = process.env.CANVAS_PAPER_ORACLE_DUMP;

const LEFT = 24;
const FULL_W = 564;
const RIGHT = 588;
const PAGE_HEIGHT = 792;
const LOGO_URI = `data:image/jpeg;base64,${TINY_JPEG.toString("base64")}`;
const BARCODE = pngDataUri(await barcodePng("91246"));
const BARCODE_2 = pngDataUri(await barcodePng("91246-2"));
/** The cert probe's dataset B words. */
const WORDS = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu";
/** One 60-character word no line can break, wider than the cert's statement drawn 40 pt in (484 pt):
 *  sixty X's set about 360 pt wide, so the word is a W's. */
const UNBREAKABLE = "W".repeat(60);

// ---------------------------------------------------------------------------------------------
// Data.

const W5 = "Ramp the furnace to soak temperature, hold until the whole load equalizes, verify with " +
  "the pyrometer log, then transfer to the quench within the allowed window and record the " +
  "elapsed transfer time on this line before the next step begins.";
type Step = { instruction: string; nparams?: number };
function travelerData(steps: Step[], over: Partial<TravelerData> = {}): TravelerData {
  return {
    orderNumber: 91246, poNumber: "", customerName: "Demo Castings Group",
    receivedFrom: ["200 Demo Drive", "Anniston, AL 36206"], customerPhone: "",
    company: { name: "Example Heat Treating", address: "1 Furnace Rd", phone: "256-555-0101" },
    lines: [{ qty: 4500, partNumber: "DEMO-PL-2001", partName: "U Bolt Rear Spr Plate", description: "Machined", eachWeight: 13.5, lineWeight: 60750 }],
    orderQty: 4500,
    containers: [{ typeName: "Drop Pan", count: 8, pieces: 320, tareEach: 367 }],
    materialName: "Ductile Iron", processId: "DEMO-PL-2001",
    inspections: [{ code: "Hardness", scale: "HBW", min: 269, max: 341, sampleQty: "8", location: "flange OD" }],
    revisionNumber: 1,
    steps: steps.map((s, i) => ({
      position: i + 1, codeName: "Austemper", instruction: s.instruction,
      values: Array.from({ length: s.nparams ?? 1 }, (_, k) => ({ label: k === 0 ? "Furnace Temp" : `Param ${k}`, value: "1650", unit: "°F" })),
    })),
    sheets: [{ loadNumber: 1, loadQty: 336, loadWeight: 4536, barcodeDataUri: BARCODE }],
    processName: "Austemper",
    ...over,
  };
}
const ordinary = (n: number): Step[] => Array.from({ length: n }, () => ({ instruction: "Pre-heat to 1100F." }));
const TALL = ["FIRSTWORD", ...Array<string>(50).fill(W5), "LASTWORD"].join(" ");
const withTall = (n: number): Step[] => [...ordinary(3), { instruction: TALL }, ...ordinary(n)];
/** The saveable oversized row: one step of 80 parameters (an instruction is capped at 4000 characters). */
const params80 = (): Step[] => [...ordinary(3), { instruction: "FIRSTWORD heavy LASTWORD", nparams: 80 }, ...ordinary(5)];

function ticket(nLines: number, nContainers: number, order: number): TicketData {
  return {
    company: { name: "Example Heat Treating", address: "1201 Front St", phone: "(256) 555-0100", liabilityText: "LIABILITY ONE.\n\nLIABILITY TWO." },
    soldTo: { code: "9054", attn: "", name: "Demo Components Corporation", street: "300 Example Way", city: "Anniston", state: "AL", zip: "36201" },
    shipTo: { code: "", attn: "", name: "Example Coating", street: "88 Dock Rd.", city: "Oxford", state: "AL", zip: "36203" },
    orderLabel: `${order}-1`, orderNumber: order, shipDate: "2026-07-29",
    poNumber: "PO-1", packingListNo: 1, customerJobNo: "JOB-9", route: "South", carrierName: "Customer",
    lines: Array.from({ length: nLines }, (_, i) => ({
      qty: 1000 + i, partNumber: `PART-${i}`, partName: "Track Shoe, Vehicular", partDescription: `DESC-${i}`, pounds: 4128 + i,
    })),
    containers: Array.from({ length: nContainers }, (_, i) => ({ typeName: `Bin${i}`, count: 3, customerContainerId: `CC-${i}`, tareEach: 42.5 })),
    serials: [{ serial: "SN-0001", description: "Heat A1" }],
    shippedComplete: true, totalQty: 1,
  };
}
function withSerials(t: TicketData, n: number): TicketData {
  return { ...t, serials: Array.from({ length: n }, (_, i) => ({ serial: `SN-${String(i).padStart(4, "0")}`, description: `Heat lot description number ${i} for the long serial list` })) };
}
function longWordTicket(): TicketData {
  const t = ticket(3, 2, 92036);
  return {
    ...t,
    company: { ...t.company, liabilityText: `${WORDS} ${WORDS}` },
    lines: t.lines.map((l) => ({ ...l, partName: WORDS, partDescription: WORDS })),
    serials: [{ serial: "SN-1", description: WORDS }],
  };
}

/** The cert probe's dataset A: 80 part lines, 60 readings, 20 serials and a freeform line. */
function certA(): CertPdfData {
  const d = sampleCert({
    parts: Array.from({ length: 80 }, (_, i) => ({ qty: i + 1, partNumber: `P-${1000 + i}`, partName: "Track Shoe, Vehicular", partDescription: "D-001", pounds: 10 })),
    serialBlocks: [{ partNumber: "P-1000", serials: Array.from({ length: 20 }, (_, i) => ({ serial: `SN-${1000 + i}`, description: "Heat A1" })) }],
    freeform: "Shipped with the customer's own packing list, a freeform line long enough to wrap across the full content width of the page and then some more words.",
  });
  d.requirements[0] = { ...d.requirements[0], readings: Array.from({ length: 60 }, (_, i) => 28 + (i % 9) / 10) };
  return d;
}
/** The cert probe's dataset B: dataset A with long wording in four places. */
function certB(): CertPdfData {
  const d = certA();
  d.statement = `STATEMENTSTART ${WORDS} ${WORDS} STATEMENTEND`;
  d.requirements[0] = { ...d.requirements[0], specification: `SPECSTART ${WORDS} SPECEND` };
  d.serialBlocks = [{ partNumber: "P-1000", serials: [{ serial: "SN-1", description: `SERIALSTART ${WORDS} SERIALEND` }] }];
  d.freeform = `FREEFORMSTART ${WORDS} ${WORDS} FREEFORMEND`;
  return d;
}
/** The cert probe's `longReqs`: one part and 300 readings. */
function certLongReqs(): CertPdfData {
  const d = certA();
  d.parts = d.parts.slice(0, 1);
  d.requirements[0] = { ...d.requirements[0], readings: Array.from({ length: 300 }, (_, i) => 28 + (i % 9) / 10) };
  return d;
}

function invoiceBig(n: number, sign = 1): InvoicePdfData {
  const parts = Array.from({ length: n }, (_, i) => ({
    qty: 100 + i, partNumber: `DEMO-${9000 + i}-000`, partName: `PART NAME ${i}`, partDescription: "", eachWeight: 21, totalWeight: 21 * (100 + i),
  }));
  const priceRows = Array.from({ length: n }, (_, i) => ({
    description: `Austemper op ${i}`, pricePerLabel: "Each", unitPrice: 6.51, minimumCharge: 600, setupCharge: null, amount: sign * 9999.99, partIndex: i,
  }));
  return sampleInvoice({
    parts, priceRows, subtotal: sign * 9999.99 * n, total: sign * (9999.99 * n + 37.5),
    ...(sign < 0 ? { title: "Credit", documentNumber: "1001", surchargeRows: [{ description: "EnergySur", amount: -37.5 }] } : {}),
  });
}
function invoiceCredit(): InvoicePdfData {
  return sampleInvoice({
    title: "Credit", documentNumber: "1001",
    priceRows: [{ description: "Austemper", pricePerLabel: "Each", unitPrice: 6.51, minimumCharge: 600, setupCharge: null, amount: -937.44, partIndex: 0 }],
    subtotal: -937.44, surchargeRows: [{ description: "EnergySur", amount: -37.5 }], total: -974.94,
  });
}
function invoiceLongWord(credit = false): InvoicePdfData {
  const base = credit ? invoiceCredit() : sampleInvoice();
  return {
    ...base,
    parts: base.parts.map((p) => ({ ...p, partName: WORDS, partDescription: WORDS })),
    priceRows: base.priceRows.map((r) => ({ ...r, description: `${WORDS} ${WORDS}` })),
  };
}
/** tests/invoice-canvas.test.ts's grouped price record (its §4.2 case): one quoted operation with
 *  its source, price per, minimum and setup lines. */
function invoiceGrouped(): InvoicePdfData {
  return sampleInvoice({
    priceRows: [{
      description: "Austemper", pricePerLabel: "Each", unitPrice: 6.51, minimumCharge: 600, setupCharge: 45,
      sourceQuoteNumber: 1006, amount: 937.44, partIndex: 0,
    }],
  });
}

function openItems(n: number): StatementOpenItem[] {
  return Array.from({ length: n }, (_, i) => ({
    documentNumber: `7 - ${93000 + i}`, date: "2026-07-10", dueDate: "2026-08-09", kind: "INVOICE" as const, original: 1000 + i, open: 500 + i,
  }));
}

// ---------------------------------------------------------------------------------------------
// Layouts.

type TableItem = Extract<CanvasItem, { kind: "table" }>;
const tableOf = (layout: CanvasLayout, key: string) =>
  layout.items.find((i): i is TableItem => i.kind === "table" && i.key === key);
const tableKeys = (layout: CanvasLayout) =>
  layout.items.filter((i): i is TableItem => i.kind === "table").sort((a, b) => a.box.y - b.box.y).map((t) => t.key);
const reboxed = (layout: CanvasLayout, key: string, box: { x: number; w: number }): CanvasLayout =>
  layoutOf(layout.items.map((i) => (i.kind === "table" && i.key === key ? { ...i, box: { ...i.box, ...box } } : i)));
const fullWidth = (layout: CanvasLayout, key: string) => reboxed(layout, key, { x: LEFT, w: FULL_W });
const withLogo = (layout: CanvasLayout) =>
  layout.items.some((i) => i.kind === "logo") ? layout : layoutOf([...layout.items, logo()]);

/** The block `key` drawn `n` pt in on each side, or less where its least width stops it (`leastWidth`,
 *  the floor `canvasRefusal` judges; null when no inset is left). */
function insetBy(doc: PaperDoc, layout: CanvasLayout, key: string, n: number): { layout: CanvasLayout; inset: number } | null {
  const item = tableOf(layout, key)!;
  const least = leastWidth(contractFor(doc), item);
  const inset = Math.min(n, (item.box.w - least) / 2);
  if (!(inset > 0)) return null;
  return { layout: reboxed(layout, key, { x: item.box.x + inset, w: item.box.w - 2 * inset }), inset };
}

/** The ticket probe's reordered stack: containers and totals above lines and serials. */
function reorderedTicket(): CanvasLayout {
  const std = standardTicketLayout();
  const below = (t: string) => ({ kind: "below-table" as const, table: t as never });
  const repl: Record<string, CanvasItem> = {
    containers: ticketTable("containers", { box: { x: 24, y: 172, w: 564, h: 30 }, anchor: below("field_strip") }),
    totals: ticketTable("totals", { box: { x: 24, y: 208, w: 564, h: 80 }, anchor: below("containers") }),
    lines: ticketTable("lines", { box: { x: 24, y: 376, w: 564, h: 30 }, anchor: below("totals") }),
    serials: ticketTable("serials", { box: { x: 24, y: 412, w: 564, h: tableOf(std, "serials")!.box.h }, anchor: below("lines") }),
  };
  return layoutOf(std.items.map((it) => (it.kind === "table" && repl[it.key] ? repl[it.key] : it)));
}

const mapItems = (layout: CanvasLayout, f: (i: CanvasItem) => CanvasItem) => layoutOf(layout.items.map(f));
/** The traveler probe's steps above inspections, the footer fields under inspections. */
function stepsThenInspections(): CanvasLayout {
  return mapItems(standardLayout(), (i) => {
    if (i.kind === "table" && i.key === "steps") return { ...i, box: { ...i.box, y: 261, h: 70 }, anchor: { kind: "below-table", table: "quantities" } };
    if (i.kind === "table" && i.key === "inspections") return { ...i, box: { ...i.box, y: 339, h: 120 }, anchor: { kind: "below-table", table: "steps" } };
    if (i.kind !== "table" && i.anchor.kind === "below-table" && i.anchor.table === "steps") return { ...i, anchor: { kind: "below-table", table: "inspections" } };
    return i;
  });
}

/** The bill of lading probe's freight-first stack: freight under the consignee's ref, the TRV block
 *  and its delivering carrier after it. */
function freightFirstBol(): CanvasLayout {
  const std = standardBolLayout();
  const trvY = 176 + 9 + 64;
  return layoutOf(std.items.map((item) => {
    if (item.id === "table-freight") return { ...item, box: { ...item.box, y: 176 }, anchor: { kind: "below-table", table: "consignee_ref" } } as CanvasItem;
    if (item.id === "table-trv") return { ...item, box: { ...item.box, y: trvY }, anchor: { kind: "below-table", table: "freight" } } as CanvasItem;
    return item;
  }));
}

// ---------------------------------------------------------------------------------------------
// The cases.

type Extra = { logoDataUri?: string; fonts?: boolean; oversized?: boolean; discriminator?: string; mayPage?: string; mutate?: (c: TemplateConfig) => void };
const PF = [false, true] as const;
const tag = (pageFooter: boolean) => ` [page line ${pageFooter ? "on" : "off"}]`;
export const PAPER_CASES: PaperCase[] = [];
/** The cases holding a traveler steps row taller than a page (an affected shape when narrowed). */
const OVERSIZED = new Set<string>();
/** The class 2a "*" discriminators: case name → the block re-shaped into a "*" column. Until #971 the copy
 *  printed differently (a "*" column took its widest child's minimum and widened past the box); since the
 *  column clamp keeps a canvas block's columns inside its drawn box, the copy prints the same (owner,
 *  2026-11-14, #971). */
const DISCRIMINATORS = new Map<string, string>();
/** The class 2a cases whose narrowed block may page: case name → that block. The quote's lines at the
 *  narrowest accepted width alone, whose part identity prints a letter to a line under #971's column clamp
 *  and runs onto a second page; every other check on the case stands (owner, 2026-11-14, #971). */
const MAY_PAGE = new Map<string, string>();
/** The insets the least widths cut short or left out, for the ledger. */
export const INSETS: string[] = [];

function add(doc: PaperDoc, base: string, layout: CanvasLayout, data: unknown, premise: (pf: boolean) => Premise, extra: Extra = {}) {
  for (const pageFooter of PF) {
    const name = `${doc} ${base}${tag(pageFooter)}`;
    const raw: TemplateConfig = { ...structuredClone(defaultConfigFor(doc)), layout: pageFooter ? lifted(layout) : layout, pageFooter };
    if (extra.fonts) raw.fonts = { ...raw.fonts, family: "Liberation Serif", baseSize: 10 };
    extra.mutate?.(raw);
    const config = validateConfig(doc, raw);
    PAPER_CASES.push({ name, doc, config, data, ...(extra.logoDataUri ? { logoDataUri: extra.logoDataUri } : {}), premise: premise(pageFooter) });
    if (extra.oversized) OVERSIZED.add(name);
    if (extra.discriminator) DISCRIMINATORS.set(name, extra.discriminator);
    if (extra.mayPage) MAY_PAGE.set(name, extra.mayPage);
  }
}
/** The layout with every page-bottom item that would end in the page line's room lifted by that room
 *  (the page line prints under the band), as tests/invoice-canvas.test.ts lifts one. */
function lifted(layout: CanvasLayout): CanvasLayout {
  const foot = 792 - 24 - PAGE_LINE_ROOM;
  const reaches = layout.items.some((i) => i.kind !== "table" && i.anchor.kind === "page-bottom" && i.box.y + i.box.h > foot);
  if (!reaches) return layout;
  return mapItems(layout, (i) => (i.kind !== "table" && i.anchor.kind === "page-bottom" ? { ...i, box: { ...i.box, y: i.box.y - PAGE_LINE_ROOM } } as CanvasItem : i));
}
const full = () => ({ kind: "full" } as const);
const flat = () => ({ kind: "flat" } as const);
const breaks = (doc: PaperDoc, block: string, control: string) => (pf: boolean) =>
  ({ kind: "breaks", block, control: `${doc} ${control}${tag(pf)}` } as const);

/** Class 1 for one document: the standard layout at a one-page, a paging and (but for the
 *  statement) a long-word record, and at Liberation Serif base 10 with a logo item and bytes. */
function classOne(doc: PaperDoc, label: string, layout: CanvasLayout, records: [string, unknown][], fontsRecord: unknown) {
  const lead = label === "" ? "" : `${label} `;
  for (const [what, data] of records) add(doc, `${lead}standard, ${what}`, layout, data, full);
  add(doc, `${lead}standard, Liberation Serif base 10 with a logo`, withLogo(layout), fontsRecord, full, { fonts: true, logoDataUri: LOGO_URI });
}

/** Class 2a for one document: each table of the layout 40 pt in on each side, on the one-page record. */
function classTwoA(doc: PaperDoc, label: string, layout: CanvasLayout, data: unknown) {
  for (const key of tableKeys(layout)) {
    const narrowed = insetBy(doc, layout, key, 40);
    if (narrowed === null) {
      INSETS.push(`${doc} ${key}: no inset (w ${tableOf(layout, key)!.box.w}, least ${leastWidth(contractFor(doc), tableOf(layout, key)!)})`);
      continue;
    }
    if (narrowed.inset !== 40) {
      INSETS.push(`${doc} ${key}: ${narrowed.inset} pt in (w ${tableOf(layout, key)!.box.w}, least ${leastWidth(contractFor(doc), tableOf(layout, key)!)})`);
    }
    add(doc, `${label} ${key} ${narrowed.inset} pt in, one-page record`, narrowed.layout, data, flat);
  }
}

// TRAVELER
{
  const std = standardLayout();
  const sti = stepsThenInspections();
  const one = travelerData(ordinary(1));
  const longWord = travelerData(Array.from({ length: 5 }, () => ({ instruction: `${WORDS} ${WORDS} ${WORDS}` })), {
    customerName: WORDS.slice(0, 60), materialName: WORDS.slice(0, 50),
  });
  classOne("TRAVELER", "", std, [["one-page record", one], ["40 steps", travelerData(ordinary(40))], ["long-word record", longWord]], one);
  add("TRAVELER", "standard, two loads", std, travelerData(ordinary(3), {
    sheets: [
      { loadNumber: 1, loadQty: 336, loadWeight: 4536, barcodeDataUri: BARCODE },
      { loadNumber: 2, loadQty: 336, loadWeight: 4536, barcodeDataUri: BARCODE_2 },
    ],
  }), full);
  // The oversized rows at full width, and the controls of Task 5's regression cases.
  for (const [lname, layout] of [["standard", std], ["steps then inspections", sti]] as const) {
    for (const [what, steps] of [["3 + tall + 5", withTall(5)], ["3 + tall + 40", withTall(40)], ["80 parameters", params80()]] as const) {
      add("TRAVELER", `${lname}, oversized row ${what}`, layout, travelerData(steps), full, { oversized: true });
    }
  }
  // Class 2b: ordinary steps narrowed, paging, and their controls.
  for (const n of [40, 80]) {
    if (n !== 40) add("TRAVELER", "standard, 80 steps", std, travelerData(ordinary(n)), full);
    add("TRAVELER", `steps then inspections, ${n} steps`, sti, travelerData(ordinary(n)), full);
    add("TRAVELER", `standard, steps 40 pt in, ${n} steps`, insetBy("TRAVELER", std, "steps", 40)!.layout, travelerData(ordinary(n)),
      breaks("TRAVELER", "steps", `standard, ${n} steps`));
    add("TRAVELER", `steps then inspections, steps 40 pt in, ${n} steps`, insetBy("TRAVELER", sti, "steps", 40)!.layout, travelerData(ordinary(n)),
      breaks("TRAVELER", "steps", `steps then inspections, ${n} steps`));
  }
  // Class 2b: lines, quantities and inspections narrowed, paging.
  const manyLines = travelerData(ordinary(1), {
    lines: Array.from({ length: 60 }, (_, i) => ({ qty: 100 + i, partNumber: `DEMO-PL-${2001 + i}`, partName: "U Bolt Rear Spr Plate", description: "Machined", eachWeight: 13.5, lineWeight: 1350 + i })),
  });
  const manyContainers = travelerData(ordinary(1), {
    containers: Array.from({ length: 70 }, (_, i) => ({ typeName: `Drop Pan ${i}`, count: 1, pieces: 10 + i, tareEach: 367 })),
  });
  const manyInspections = travelerData(ordinary(1), {
    inspections: Array.from({ length: 70 }, (_, i) => ({ code: `Hardness ${i}`, scale: "HBW", min: 269, max: 341, sampleQty: "8", location: "flange OD" })),
  });
  for (const [key, what, d] of [["lines", "60 lines", manyLines], ["quantities", "70 containers", manyContainers], ["inspections", "70 inspections", manyInspections]] as const) {
    add("TRAVELER", `standard, ${what}`, std, d, full);
    add("TRAVELER", `standard, ${key} 40 pt in, ${what}`, insetBy("TRAVELER", std, key, 40)!.layout, d, breaks("TRAVELER", key, `standard, ${what}`));
  }
  classTwoA("TRAVELER", "standard,", std, one);
}

// SHIPPER and MOS_SHIPPER
for (const doc of ["SHIPPER", "MOS_SHIPPER"] as const) {
  const std = standardTicketLayout();
  if (canvasRefusal(std, contractFor(doc), { pageFooter: false }) !== null) {
    INSETS.push(`${doc}: refuses standardTicketLayout(), so it holds no case`);
    continue;
  }
  const one = [ticket(2, 2, 92036)];
  const caseA = [ticket(60, 2, 92036), ticket(2, 2, 92037)];
  const caseC = [ticket(2, 120, 92036), ticket(2, 2, 92037)];
  const serials = [withSerials(ticket(2, 2, 92036), 80), ticket(2, 2, 92037)];
  classOne(doc, "", std, [["one-page record", one], ["60 lines", caseA], ["long-word record", [longWordTicket()]]], one);
  add(doc, "standard, 120 containers", std, caseC, full);
  add(doc, "standard, 80 serials", std, serials, full);
  add(doc, "reordered, full width, 110 containers and 6 serials", reorderedTicket(), [withSerials(ticket(3, 110, 92036), 6), ticket(2, 2, 92037)], full);
  add(doc, "standard, lines 40 pt in, 60 lines", insetBy(doc, std, "lines", 40)!.layout, caseA, breaks(doc, "lines", "standard, 60 lines"));
  add(doc, "standard, containers 40 pt in, 120 containers", insetBy(doc, std, "containers", 40)!.layout, caseC, breaks(doc, "containers", "standard, 120 containers"));
  add(doc, "standard, serials 40 pt in, 80 serials", insetBy(doc, std, "serials", 40)!.layout, serials, breaks(doc, "serials", "standard, 80 serials"));
  classTwoA(doc, "standard,", std, one);
}

// BOL
{
  const std = standardBolLayout();
  const pos = sampleBol({ poNumbers: Array.from({ length: 1500 }, (_, i) => `PO${10000 + i}`), orderNumbers: [91955] });
  const longWord = sampleBol({ freightDescription: `${WORDS} ${WORDS} ${WORDS}` });
  classOne("BOL", "", std, [
    ["one-page record", sampleBol()],
    ["1000-word freight", sampleBol({ freightDescription: "Castings ".repeat(1000).trim() })],
    ["long-word record", longWord],
  ], sampleBol());
  add("BOL", "consignee ref full width, 1500 POs", fullWidth(std, "consignee_ref"), pos, full);
  add("BOL", "standard (consignee ref 338/244), 1500 POs", std, pos, breaks("BOL", "consignee_ref", "consignee ref full width, 1500 POs"));
  add("BOL", "consignee ref 64/484, 1500 POs", reboxed(std, "consignee_ref", { x: 64, w: 484 }), pos,
    breaks("BOL", "consignee_ref", "consignee ref full width, 1500 POs"));
  const words400 = sampleBol({ freightDescription: "Castings ".repeat(400).trim() });
  add("BOL", "freight first, 400-word freight", freightFirstBol(), words400, full);
  add("BOL", "freight first, freight 40 pt in, 400-word freight", insetBy("BOL", freightFirstBol(), "freight", 40)!.layout, words400,
    breaks("BOL", "freight", "freight first, 400-word freight"));
  classTwoA("BOL", "standard,", std, sampleBol());
}

// CERT
{
  const std = standardCertLayout();
  classOne("CERT", "", std, [["one-page record", sampleCert()], ["dataset A", certA()], ["dataset B long-word record", certB()]], sampleCert());
  add("CERT", "standard, 300 readings", std, certLongReqs(), full);
  add("CERT", "standard, requirements 40 pt in, 300 readings", insetBy("CERT", std, "requirements", 40)!.layout, certLongReqs(),
    breaks("CERT", "requirements", "standard, 300 readings"));
  classTwoA("CERT", "standard,", std, sampleCert());
  add("CERT", "standard, parts right-only x 24 w 400, one-page record", reboxed(std, "parts", { x: 24, w: 400 }), sampleCert(), flat);
  // The "*" discriminators and the To's columnGap pin.
  const statementWords = `${UNBREAKABLE} ${WORDS} ${WORDS} ${WORDS}`;
  add("CERT", "standard, statement 40 pt in, one 60-character word long-word record", insetBy("CERT", std, "statement", 40)!.layout,
    sampleCert({ statement: statementWords }), flat, { discriminator: "statement" });
  add("CERT", "standard, To at x 288 w 300, a long city", reboxed(std, "to", { x: 288, w: 300 }),
    sampleCert({ to: { ...sampleCert().to, city: "Anniston Heights Industrial Park North Extension" } }), flat);
}

// INVOICE (and once more as a credit memo)
{
  const std = standardInvoiceLayout();
  classOne("INVOICE", "invoice", std, [["one-page record", sampleInvoice()], ["70 parts", invoiceBig(70)], ["long-word record", invoiceLongWord()]], sampleInvoice());
  classOne("INVOICE", "credit", std, [["one-page record", invoiceCredit()], ["70 parts", invoiceBig(70, -1)], ["long-word record", invoiceLongWord(true)]], invoiceCredit());
  classTwoA("INVOICE", "invoice standard,", std, sampleInvoice());
  add("INVOICE", "invoice standard, price x 120 w 300, grouped record", reboxed(std, "price", { x: 120, w: 300 }), invoiceGrouped(), flat, { discriminator: "price" });
  // The parts block at the narrowest width canvasRefusal accepts.
  const parts = tableOf(std, "parts")!;
  let w = parts.box.w;
  while (w > 1 && canvasRefusal(reboxed(std, "parts", { x: LEFT, w: w - 0.5 }), contractFor("INVOICE"), { pageFooter: false }) === null) w -= 0.5;
  INSETS.push(`INVOICE parts: narrowest accepted width ${w} (least ${leastWidth(contractFor("INVOICE"), parts)})`);
  // Two parts whose information cells' least widths differ: the sample's (its part number, one
  // unbreakable word, wider than the cell) and a short one's, which a "*" column would widen to the
  // first's. With the sample's one part alone the row lays out at its own least width either way.
  const twoParts = sampleInvoice({
    parts: [sampleInvoice().parts[0], { qty: 5, partNumber: "P1", partName: "A B", partDescription: "", eachWeight: 2, totalWeight: 10 }],
  });
  add("INVOICE", `invoice standard, parts x 24 w ${w} (the narrowest accepted), two parts`, reboxed(std, "parts", { x: LEFT, w }), twoParts, flat,
    { discriminator: "parts" });
}

// QUOTE
{
  const std = standardQuoteLayout();
  const forty = sampleQuote({ lines: quoteLines(40) });
  /** Long wording in breakable words alone, in every place the quote prints wording. */
  const longWord = (): QuotePdfData => sampleQuote({
    introText: `${WORDS} ${WORDS}`,
    lines: sampleQuote().lines.map((l) => ({
      ...l, partName: WORDS, partDescription: WORDS, material: WORDS,
      prices: l.prices.map((p) => ({ ...p, stepName: WORDS, notes: `${WORDS} ${WORDS}` })),
    })),
    endingStatementText: `${WORDS} ${WORDS}`, notes: `${WORDS} ${WORDS}`, liabilityText: `${WORDS} ${WORDS} ${WORDS}`,
  });
  classOne("QUOTE", "", std, [["one-page record", sampleQuote()], ["40 lines", forty], ["long-word record", longWord()]], sampleQuote());
  classTwoA("QUOTE", "standard,", std, sampleQuote());
  // The lines block at the narrowest width canvasRefusal accepts.
  const lines = tableOf(std, "lines")!;
  let w = lines.box.w;
  while (w > 1 && canvasRefusal(reboxed(std, "lines", { x: LEFT, w: w - 0.5 }), contractFor("QUOTE"), { pageFooter: false }) === null) w -= 0.5;
  INSETS.push(`QUOTE lines: narrowest accepted width ${w} (least ${leastWidth(contractFor("QUOTE"), lines)})`);
  // Two lines whose information cells' least widths differ: the sample's (its part identity's words
  // wider than the cell) and a short one's, which a "*" column would widen to the first's.
  const twoLines = sampleQuote({ lines: [sampleQuote().lines[0], { ...quoteLines(1)[0], partNumber: "P1", partName: "A B", partDescription: "" }] });
  add("QUOTE", `standard, lines x 24 w ${w} (the narrowest accepted), two lines`, reboxed(std, "lines", { x: LEFT, w }), twoLines, flat,
    { discriminator: "lines", mayPage: "lines" });
  // Class 2b: the lines block 40 pt in, paging, its control the class 1 40-line case.
  add("QUOTE", "standard, lines 40 pt in, 40 lines", insetBy("QUOTE", std, "lines", 40)!.layout, forty, breaks("QUOTE", "lines", "standard, 40 lines"));
}

// STATEMENT
{
  const std = standardStatementLayout();
  classOne("STATEMENT", "", std, [["one-page record", richStatement()], ["120 open items", richStatement({ openItems: openItems(120) })]], sampleStatement());
  for (const n of [40, 60, 80]) add("STATEMENT", `standard, ${n} open items`, std, richStatement({ openItems: openItems(n) }), full);
  for (const n of [40, 60, 80, 120]) {
    const control = n === 120 ? "standard, 120 open items" : `standard, ${n} open items`;
    add("STATEMENT", `standard, open items 40 pt in, ${n} open items`, insetBy("STATEMENT", std, "open_items", 40)!.layout,
      richStatement({ openItems: openItems(n) }), breaks("STATEMENT", "open_items", control));
  }
  classTwoA("STATEMENT", "standard,", std, richStatement());
}

// ---------------------------------------------------------------------------------------------
// The premises.

const AFFECTED: Partial<Record<PaperDoc, Set<string>>> = {
  CERT: new Set(["parts", "to"]),
  SHIPPER: new Set(["totals"]),
  MOS_SHIPPER: new Set(["totals"]),
};
const isAffected = (c: PaperCase, key: string) =>
  c.doc === "INVOICE" || (AFFECTED[c.doc]?.has(key) ?? false) || (c.doc === "TRAVELER" && key === "steps" && OVERSIZED.has(c.name));
const isNarrowed = (t: TableItem) => t.box.x !== LEFT || t.box.w !== FULL_W;

type Pos = { id: string; page: number; left: number; top: number };
const posOf = (dump: PaperDump, id: string) => dump.positions.find((p) => p.id === id);
function breaksAcross(dump: PaperDump, key: string): boolean {
  const start = posOf(dump, CANVAS_IDS.table(key));
  const end = posOf(dump, CANVAS_IDS.end(key));
  return start !== undefined && end !== undefined && start.page !== end.page;
}

/** The runs printed after `after` (on its page, below it; on every later page of the first sheet
 *  group), in page order and each page's draw order. Left out: the repeat band (the top margin) and
 *  the page line ("Page N of M", whose figures differ with the page count). The page-bottom band is
 *  kept, since body text a block's region lets hang past its box prints there too; it repeats on
 *  every page, and the in-order match below skips the copies the control does not print. */
function runsAfter(dump: PaperDump, def: RenderableDefinition, after: Pos) {
  const top = (def.pageMargins as [number, number, number, number])[1];
  // The first sheet group's pages alone (its positions are the only ones read): a later group, a
  // ticket's next order, is its own sheet with its own narrowed block.
  const last = Math.max(...dump.positions.map((n) => n.page));
  const out: { text: string; x: number; page: number }[] = [];
  dump.perPage.forEach((page, i) => {
    const p = i + 1;
    if (p < after.page || p > last) return;
    const lines = new Map<number, string>();
    for (const r of page.runs) {
      const key = Math.round(r.y * 2) / 2;
      lines.set(key, `${lines.get(key) ?? ""}${r.text}`);
    }
    for (const r of page.runs) {
      const baseline = PAGE_HEIGHT - r.y;
      if (baseline < top) continue;
      if (p === after.page && baseline <= after.top) continue;
      if (r.text.trim() === "") continue;
      if (/^Page \d+ of \d+$/.test((lines.get(Math.round(r.y * 2) / 2) ?? "").replace(/\s+/g, " ").trim())) continue;
      out.push({ text: r.text, x: r.x, page: p });
    }
  });
  return out;
}

const inkOf = (dump: PaperDump) => canonical(dump.perPage.map((p) => ({ runs: p.runs, strokes: p.strokes })));

const dumps = new Map<string, Promise<PaperDump>>();
const caseByName = new Map(PAPER_CASES.map((c) => [c.name, c] as const));
function dumpOf(name: string): Promise<PaperDump> {
  let d = dumps.get(name);
  if (d === undefined) {
    const c = caseByName.get(name);
    if (c === undefined) throw new Error(`no case ${name}`);
    d = dumpCanvasPaper(c);
    dumps.set(name, d);
  }
  return d;
}

/** Every premise of the case; throws naming the first that fails. */
async function assertPremises(c: PaperCase, dump: PaperDump): Promise<void> {
  const layout = c.config.layout!;
  expect(canvasRefusal(layout, contractFor(c.doc), { pageFooter: c.config.pageFooter }), `${c.name}: refused`).toBeNull();
  // Nothing past the margin.
  dump.perPage.forEach((page, i) => {
    const past = page.runs.filter((r) => r.text.trim() !== "" && r.x > RIGHT).map((r) => `${r.text.trim()}@${r.x}`);
    expect(past, `${c.name}: runs past ${RIGHT} on page ${i + 1}`).toEqual([]);
    const strokes = page.strokes.filter((s) => Math.max(s.x1, s.x2) > RIGHT + 0.5).map((s) => `${s.x1}..${s.x2}@${s.y1}`);
    expect(strokes, `${c.name}: strokes past ${RIGHT + 0.5} on page ${i + 1}`).toEqual([]);
  });
  // Not vacuous: every reader saw something.
  dump.perPage.forEach((page, i) => expect(page.runs.length, `${c.name}: page ${i + 1} runs`).toBeGreaterThan(0));
  expect(dump.perPage.some((p) => p.strokes.length > 0 || p.rects.length > 0), `${c.name}: no stroke or rect`).toBe(true);
  if (c.logoDataUri !== undefined) expect(dump.perPage[0].images.length, `${c.name}: the logo`).toBeGreaterThan(0);
  const tables = layout.items.filter((i): i is TableItem => i.kind === "table");
  // Every table block inside its drawn box (#971, design §8.3): on each page of the block's laid-out
  // span (its `CANVAS_IDS.table` position to its `CANVAS_IDS.end`), no stroke that starts within the
  // block's drawn x-range ends past its drawn right edge, to the strokes' 0.5 pt reading tolerance.
  // Not the block's: a stroke in the repeat band (above the top margin on a page after the block's
  // first), and a stroke lying wholly inside another item's drawn x-range and measured height on its
  // page (an item the layout draws over the block, such as the invoice's Remit To box).
  const topMargin = (definitionsOf(c)[0].pageMargins as [number, number, number, number])[1];
  const nonTables = layout.items.filter((i) => i.kind !== "table");
  const itemInk = (p: number, s: StrokedLine) => dump.measure.items.some((m) => {
    const box = nonTables.find((i) => i.id === m.id)?.box;
    return box !== undefined && m.page === p && Math.min(s.x1, s.x2) >= box.x - 0.5 && Math.max(s.x1, s.x2) <= box.x + box.w + 0.5
      && Math.min(s.y1, s.y2) >= m.top - 0.5 && Math.max(s.y1, s.y2) <= m.top + m.height + 0.5;
  });
  for (const t of tables) {
    const start = posOf(dump, CANVAS_IDS.table(t.key));
    const end = posOf(dump, CANVAS_IDS.end(t.key));
    if (start === undefined || end === undefined) continue;
    const right = t.box.x + t.box.w;
    for (let p = start.page; p <= end.page; p += 1) {
      const past = dump.perPage[p - 1].strokes.filter((s) => {
        const y = Math.min(s.y1, s.y2);
        const x = Math.min(s.x1, s.x2);
        return (p > start.page ? y >= topMargin : y >= start.top - 0.5) && (p < end.page || y <= end.top + 0.5)
          && x >= t.box.x - 0.5 && x <= right && Math.max(s.x1, s.x2) > right + 0.5 && !itemInk(p, s);
      }).map((s) => `${s.x1}..${s.x2}@${s.y1}`);
      expect(past, `${c.name}: ${t.key} strokes past its drawn right edge ${right} on page ${p}`).toEqual([]);
    }
  }
  if (c.premise.kind === "full") {
    for (const t of tables) {
      if (isNarrowed(t) && isAffected(c, t.key)) expect(breaksAcross(dump, t.key), `${c.name}: affected narrowed ${t.key} breaks`).toBe(false);
    }
  }
  if (c.premise.kind === "flat") {
    for (const t of tables) {
      if (isNarrowed(t) && MAY_PAGE.get(c.name) !== t.key) expect(breaksAcross(dump, t.key), `${c.name}: narrowed ${t.key} breaks`).toBe(false);
    }
    const block = DISCRIMINATORS.get(c.name);
    if (block !== undefined) {
      const star = await dumpDefinitions(c, starShaped(definitionsOf(c), block));
      expect(inkOf(star) === inkOf(dump), `${c.name}: the "*" copy of ${block} prints different runs or strokes`).toBe(true);
    }
  }
  if (c.premise.kind === "breaks") {
    const { block, control } = c.premise;
    expect(isNarrowed(tableOf(layout, block)!), `${c.name}: ${block} is not narrowed`).toBe(true);
    expect(isAffected(c, block), `${c.name}: ${block} is an affected shape`).toBe(false);
    expect(breaksAcross(dump, block), `${c.name}: ${block} does not break`).toBe(true);
    const ctlCase = caseByName.get(control);
    expect(ctlCase, `${c.name}: no control ${control}`).toBeDefined();
    expect(ctlCase!.premise.kind, `${c.name}: control class`).toBe("full");
    const ctlTable = tableOf(ctlCase!.config.layout!, block)!;
    expect([ctlTable.box.x, ctlTable.box.w], `${c.name}: control's ${block}`).toEqual([LEFT, FULL_W]);
    const ctl = await dumpOf(control);
    const mine = runsAfter(dump, definitionsOf(c)[0], posOf(dump, CANVAS_IDS.end(block))!);
    const theirs = runsAfter(ctl, definitionsOf(ctlCase!)[0], posOf(ctl, CANVAS_IDS.end(block))!);
    expect(theirs.length, `${c.name}: nothing printed after ${block} in the control`).toBeGreaterThan(0);
    let at = 0;
    for (const want of theirs) {
      while (at < mine.length && mine[at].text !== want.text) at += 1;
      expect(at < mine.length, `${c.name}: "${want.text}" after ${block} (control page ${want.page}) not found in order`).toBe(true);
      expect(Math.abs(mine[at].x - want.x), `${c.name}: "${want.text}" on page ${mine[at].page} at ${mine[at].x}, control ${want.x}`).toBeLessThanOrEqual(0.01);
      at += 1;
    }
  }
  if (c.doc === "STATEMENT") {
    const toggled = columnToggled(definitionsOf(c));
    expect(toggled.count, `${c.name}: no block column found`).toBeGreaterThan(0);
    const other = await dumpDefinitions(c, toggled.defs);
    expect(canonical(digest(other)), `${c.name}: the copy with each block's column toggled ("*" and fixed) prints differently`).toBe(canonical(digest(dump)));
  }
}

// ---------------------------------------------------------------------------------------------
// The test.

const frozen: Record<string, ReturnType<typeof digest>> = WRITE || !existsSync(ORACLE)
  ? {} : JSON.parse(readFileSync(ORACLE, "utf8")) as Record<string, ReturnType<typeof digest>>;
const written: Record<string, ReturnType<typeof digest>> = {};
const safe = (name: string) => name.replace(/[^\w.-]+/g, "_");
function writeDump(name: string, dump: PaperDump) {
  if (DUMP_DIR === undefined) return;
  mkdirSync(DUMP_DIR, { recursive: true });
  writeFileSync(path.join(DUMP_DIR, `${safe(name)}.json`), JSON.stringify(dump));
}
const HEAVY = /1500 POs|300 readings|120 containers|110 containers|80 steps|80 parameters|70 parts|120 open items|1000-word|400-word|tall \+ 40|70 containers|70 inspections|60 lines|80 serials/;

describe("the canvas paper oracle (#969)", () => {
  it("holds a case of every class on every document, every name once", () => {
    expect(new Set(PAPER_CASES.map((c) => c.name)).size).toBe(PAPER_CASES.length);
    for (const kind of ["full", "flat", "breaks"] as const) expect(PAPER_CASES.some((c) => c.premise.kind === kind), kind).toBe(true);
    if (!WRITE) expect(Object.keys(frozen).sort(), "the fixture's cases").toEqual(PAPER_CASES.map((c) => c.name).sort());
  });

  for (const c of PAPER_CASES) {
    it(c.name, async () => {
      const dump = await dumpOf(c.name);
      try {
        await assertPremises(c, dump);
      } catch (error) {
        writeDump(c.name, dump);
        throw error;
      }
      const got = digest(dump);
      if (WRITE) {
        writeDump(c.name, dump);
        written[c.name] = got;
        return;
      }
      const want = frozen[c.name];
      expect(want, `${c.name}: not in the fixture`).toBeDefined();
      const where = got.pages !== want.pages ? "pages"
        : got.perPage.findIndex((h, i) => h !== want.perPage[i]) >= 0 ? `page ${got.perPage.findIndex((h, i) => h !== want.perPage[i]) + 1}`
          : got.positions !== want.positions ? "positions" : got.measure !== want.measure ? "measure" : null;
      if (where !== null) writeDump(c.name, dump);
      expect(where, `${c.name}: moved at ${where}`).toBeNull();
    }, HEAVY.test(c.name) ? 300_000 : 60_000);
  }

  afterAll(() => {
    if (!WRITE) return;
    const missing = PAPER_CASES.filter((c) => !(c.name in written)).map((c) => c.name);
    if (missing.length > 0) throw new Error(`not written: ${missing.length} case(s) did not run or failed, first ${missing[0]}`);
    const ordered = Object.fromEntries(PAPER_CASES.map((c) => [c.name, written[c.name]]));
    writeFileSync(ORACLE, `${JSON.stringify(ordered, null, 1)}\n`);
  });
});
