import { QUOTE_CONTRACT, QUOTE_ROW_FLOOR } from "@/lib/template-contracts/quote";
import { defaultTableColumns } from "@/lib/template-canvas";
import { CANVAS_GRID, type CanvasAnchor, type CanvasBox, type CanvasItem, type CanvasLayout } from "@/lib/template-contracts/canvas";
import { layoutOf } from "./canvas-fixtures";
import type { QuotePdfData } from "@/server/pdf/quote";

type Over<K extends CanvasItem["kind"]> = Partial<Extract<CanvasItem, { kind: K }>>;

/** A quote field item, page-top at the left margin, 200 × 12, unless `over` says otherwise. */
export function quoteField(key: string, over: Over<"field"> = {}): Extract<CanvasItem, { kind: "field" }> {
  return {
    id: `field-${key}`, kind: "field", key, label: null,
    box: { x: 24, y: 24, w: 200, h: 12 }, anchor: { kind: "page-top" }, repeat: false,
    style: { size: 10, bold: false, align: "left" }, ...over,
  };
}

export type QuoteTable = "parties" | "intro" | "column_header" | "lines" | "closing" | "liability";
const STACK: QuoteTable[] = ["parties", "intro", "column_header", "lines", "closing", "liability"];

/** The header (`standardQuoteLayout`): the centre column at x 202, 208 wide (the title 24..48, the
 *  company name 50..66, the company address 68..92, two 10 pt lines); the quotation number at x 418,
 *  170 wide, 24..38, clear of the centre column (which ends at 410) and of the "(continued)" box (x 24
 *  to 84). The header ends at 92. */
const CENTRE = { x: 202, w: 208 };
const TITLE: CanvasBox = { ...CENTRE, y: 24, h: 24 };
const COMPANY_NAME: CanvasBox = { ...CENTRE, y: 50, h: 16 };
const COMPANY_ADDRESS: CanvasBox = { ...CENTRE, y: 68, h: 24 };
const QUOTE_NUMBER: CanvasBox = { x: 418, y: 24, w: 170, h: 14 };
const HEADER_BOTTOM = Math.max(...[TITLE, COMPANY_NAME, COMPANY_ADDRESS, QUOTE_NUMBER].map((b) => b.y + b.h)); // 92

/** The standard stack's drawn boxes, every block x 24, 564 wide and `QUOTE_ROW_FLOOR` (F) tall. The
 *  parties' top two grid steps under the header's bottom (92 + 9 = 101), page-top; each later block's
 *  top two grid steps under the bottom of the block before it (its top + F + 9). With F = 10 the tops
 *  are 101, 120, 139, 158, 177 and 196, and the liability ends at 206. */
function stackBoxes(): Record<QuoteTable, CanvasBox> {
  const boxes = {} as Record<QuoteTable, CanvasBox>;
  let top = HEADER_BOTTOM + 2 * CANVAS_GRID;
  for (const key of STACK) {
    boxes[key] = { x: 24, y: top, w: 564, h: QUOTE_ROW_FLOOR };
    top += QUOTE_ROW_FLOOR + 2 * CANVAS_GRID;
  }
  return boxes;
}

/** A quote block at its slot in the standard stack (`stackBoxes`), anchored below the block before it
 *  (the parties page-top), its columns the contract's (`defaultTableColumns`, never a literal: the
 *  rows blocks' rows, the column headers' four grid fields through `columnTable`, none for the intro
 *  and the liability). */
export function quoteTable(key: QuoteTable, over: Over<"table"> = {}): Extract<CanvasItem, { kind: "table" }> {
  const i = STACK.indexOf(key);
  const anchor: CanvasAnchor = i === 0 ? { kind: "page-top" } : { kind: "below-table", table: STACK[i - 1] };
  return {
    id: `table-${key}`, kind: "table", key, heading: null, columns: defaultTableColumns(QUOTE_CONTRACT, key),
    box: { ...stackBoxes()[key] }, anchor, repeat: false, ...over,
  };
}

/**
 * The quotation's standard arrangement, all inside the usable area (24..588 across, 24..748 down
 * with the page line on, 768 with it off), passing every canvas rule and warning of nothing with no
 * measure and the page line on or off, every rows block at least its `QUOTE_LEAST_WIDTHS` entry
 * wide, the lines block in line with the column headers (same x and width), and no two drawn boxes
 * overlapping. Page-top, in the centre column (x 202, 208 wide): the title (24..48, the heading size,
 * bold, centred), the company name (50..66, 13, bold, centred) and the company address (68..92, 10,
 * centred, two lines tall). The quotation number (24..38, 11) at x 418, 170 wide, repeated on every
 * page, so it ends 63 pt above the parties' top (101), more than one grid step, and lies clear of
 * "(continued)" at the repeat band's bottom-left (x 24..84, 28..38). The six blocks below
 * (`stackBoxes`). No band, and no text block (the intro's and the liability's wordings print inside
 * their blocks).
 *
 * The no-overlap proof runs through `canvasWarnings`, which skips block pairs; rule 5 (the stacking
 * rule) refuses any two blocks overlapping in y, so the blocks are judged by stacking.
 */
export function standardQuoteLayout(): CanvasLayout {
  const header: CanvasItem[] = [
    quoteField("title", {
      box: { ...TITLE }, style: { size: QUOTE_CONTRACT.fonts.headingSize, bold: true, align: "center" },
    }),
    quoteField("company_name", { box: { ...COMPANY_NAME }, style: { size: 13, bold: true, align: "center" } }),
    quoteField("company_address", { box: { ...COMPANY_ADDRESS }, style: { size: 10, bold: false, align: "center" } }),
    quoteField("quote_number", { box: { ...QUOTE_NUMBER }, repeat: true, style: { size: 11, bold: false, align: "left" } }),
  ];
  return layoutOf([...header, ...STACK.map((key) => quoteTable(key))]);
}

/** A quote's builder data: a copy of tests/quote-templates.test.ts's `sampleData` (copying across
 *  test files is this repo's convention; that file keeps its own). One line of one EACH price row,
 *  its liability typed, so every block of the Standard prints. */
export function sampleQuote(overrides: Partial<QuotePdfData> = {}): QuotePdfData {
  return {
    company: { name: "Example Supplier Inc.", address: "600 Example Street\nCrystal Lake IL 60014", phone: "312.555.0100" },
    quoteNumber: 1006,
    effectiveDate: "2018-06-30",
    expiryDate: "2018-07-10",
    termsName: "Net 30",
    rfqNumber: "12345",
    attn: "Casey Example",
    customerPhone: "312.555.0102",
    billTo: ["Demo Tractor Parts", "700 Demo Drive", "Chicago, IL 12345"],
    introText: "We are pleased to provide you with the following quotation:",
    lines: [{
      quotedQty: 100, quotedUnlimited: false,
      partNumber: "Customer Part ID", partName: "Customer part name",
      partDescription: "Description of Part",
      eachWeight: 10, totalLbs: 1000, surcharges: [], material: "Customer Material",
      prices: [{
        stepName: "Bake", notes: "Quote Notes", setupCharge: 2, unitPrice: 0.15,
        minimumCharge: 100, pricePerLabel: "Each", pricedPerLb: false, breaks: [], amount: 102,
      }],
    }],
    endingStatementText: "Ending Statement from Quote Control",
    notes: "Our terms are net 30",
    liabilityText: "You can add a limited Liability Statement here.",
    signer: { name: "Mr. Johnathen Smith", title: "V.P. Sales" },
    ...overrides,
  };
}

/** A quote line (`QuotePdfLine`, read off `QuotePdfData` so the import above stays as it was). */
type QuotePdfLine = QuotePdfData["lines"][number];

/** `n` copies of `sampleQuote()`'s one line, each its own part number (`P-0001` …), with `over`
 *  spread on each: a quote long enough to page. */
export function quoteLines(n: number, over: Partial<QuotePdfLine> = {}): QuotePdfLine[] {
  const base = sampleQuote().lines[0];
  return Array.from({ length: n }, (_, i) => ({
    ...structuredClone(base), partNumber: `P-${String(i + 1).padStart(4, "0")}`, ...structuredClone(over),
  }));
}

/**
 * A quote that prints every arm of the ruled paper (design 2026-11-12 §11), on `sampleQuote()`'s
 * header and parties:
 *
 *  - R14: the default bill-to row's name ("Accounts Payable") stacked over the three-line bill-to
 *    (the customer's name and its two address lines);
 *  - line 1: Unlimited (ruling 9), with two price rows (an EACH row carrying a setup charge, a unit
 *    price and a minimum; an LB row with two pound breaks, W15's "1,000 lb or more:") and two #948
 *    estimate rows (one with its figure, one rate-only, its amount null);
 *  - line 2: a blank Material (owner ruling 8) and no price rows;
 *  - line 3: a 4-decimal unit price ($0.0550, Q7: printed "$0.055") with one piece break (bare);
 *  - typed liability wording and notes.
 *
 * The builder reads its data raw (the indicative amounts are the engine's, outside the builder), so
 * an Unlimited line's rows carry amounts here to print the two-decimal figures.
 */
export function richQuote(over: Partial<QuotePdfData> = {}): QuotePdfData {
  const lines: QuotePdfLine[] = [
    {
      quotedQty: null, quotedUnlimited: true,
      partNumber: "P-1001", partName: "Gear housing", partDescription: "Cast iron, machined",
      eachWeight: 12.5, totalLbs: null, material: "4140 steel",
      prices: [
        {
          stepName: "Harden", notes: "Rockwell C 40-45", setupCharge: 25, unitPrice: 0.15,
          minimumCharge: 100, pricePerLabel: "Each", pricedPerLb: false, breaks: [], amount: 102.5,
        },
        {
          stepName: "Temper", notes: "", setupCharge: null, unitPrice: 0.08, minimumCharge: null,
          pricePerLabel: "Per lb", pricedPerLb: true,
          breaks: [{ threshold: 1000, price: 0.07 }, { threshold: 5000, price: 0.06 }], amount: 80,
        },
      ],
      surcharges: [
        { name: "EnergySur", rateText: "4%", amount: 8.2 },
        { name: "Fuel surcharge", rateText: "2.5%", amount: null },
      ],
    },
    {
      quotedQty: 40, quotedUnlimited: false,
      partNumber: "P-1002", partName: "Pin", partDescription: "",
      eachWeight: 3.25, totalLbs: 130, material: "", prices: [], surcharges: [],
    },
    {
      quotedQty: 2000, quotedUnlimited: false,
      partNumber: "P-1003", partName: "Bushing", partDescription: "Sintered",
      eachWeight: 0.4, totalLbs: 800, material: "1018 steel",
      prices: [{
        stepName: "Carburize", notes: "Case depth .020", setupCharge: null, unitPrice: 0.055,
        minimumCharge: 75, pricePerLabel: "Each", pricedPerLb: false,
        breaks: [{ threshold: 5000, price: 0.05 }], amount: 110,
      }],
      surcharges: [],
    },
  ];
  return sampleQuote({
    billTo: ["Accounts Payable", "Demo Tractor Parts", "700 Demo Drive", "Chicago, IL 12345"],
    lines,
    notes: "Prices are firm for 30 days from the effective date.",
    liabilityText: "Our liability is limited to the value of the services performed on the parts.",
    ...over,
  });
}
