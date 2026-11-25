import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BOL_CONTRACT, CONTRACTS, INVOICE_CONTRACT, MOS_SHIPPER_CONTRACT, QUOTE_CONTRACT, STATEMENT_CONTRACT, assertCanvasPrints, canvasPrints, MOS_SHIPPER_DEFAULT_CONFIG, SHIPPER_CONTRACT, SHIPPER_DEFAULT_CONFIG, TEMPLATE_DOC_TYPES, TRAVELER_DEFAULT_CONFIG,
  TemplateConfigError, contractFor, defaultConfigFor, normalizeStoredConfig, validateConfig, type FontsConfig,
  type TemplateContract,
} from "@/lib/template-contracts/index";
import { round2, sharedWidthWords, tableOverhead } from "@/lib/printed-width-core";
import { textWidthOf } from "@/lib/tag-font-metrics";
import { TRAVELER_CONTRACT, TRAVELER_HANDWRITING_LOCK, travelerStepsPrintedWidth } from "@/lib/template-contracts/traveler";
import { DOCS, reboxed } from "./helpers/keep-in-box-cases";
import type { PaperDoc } from "./helpers/canvas-paper-dump";
import { TICKET_FIRST_TABLE_ROOM, TICKET_ROW_FLOOR } from "@/lib/template-contracts/shipper";
import { clearedLayout, isRequired } from "@/lib/canvas-designer";
import { withArticle } from "@/lib/template-editor";
import { BOL_FIRST_TABLE_ROOM, BOL_LEAST_WIDTHS, BOL_ROW_FLOOR } from "@/lib/template-contracts/bol";
import { FOOTER_BOTTOM_MARGIN } from "@/server/traveler";
import { TEST_DOC_TYPE, testContract, withTestContract } from "./helpers/test-contract";
import { INVOICE_WIDTHS } from "@/server/pdf/invoice";
import { CANVAS_GRID, CANVAS_PAGE, type CanvasAnchor, type CanvasBox, type CanvasColumn, type CanvasItem, type CanvasLayout } from "@/lib/template-contracts/canvas";
import {
  PAGE_LINE_ROOM, bandHeight, bandTop, pageFoot, canvasFieldKeys, canvasRefusal, canvasTablePrintedWidth, canvasWarnings, floorRefusal,
  STATIC_NAMES, continuedBox,
  defaultTableColumns, gridOf, drawnBox, firstTableRoom, inferAnchor, inkBoxes, leastWidth, regionHeights, tableHeadingKey, tableName, tableSpec, tablesByY,
  topMargin, usableHeight, validateCanvasLayout, visibleColumnsWidth, headingWholeWidth, type CanvasMeasure,
} from "@/lib/template-canvas";
import { barcode, field, layoutOf, logo, standardLayout, table } from "./helpers/canvas-fixtures";
import { standardTicketLayout, textBlock, ticketTable } from "./helpers/ticket-canvas-fixtures";
import { bolField, bolTable, bolTextBlock, standardBolLayout } from "./helpers/bol-canvas-fixtures";
import { certField, certTable, standardCertLayout } from "./helpers/cert-canvas-fixtures";
import { invoiceField, invoiceTable, standardInvoiceLayout, type InvoiceTable } from "./helpers/invoice-canvas-fixtures";
import { standardStatementLayout, statementField, statementTable, type StatementTable } from "./helpers/statement-canvas-fixtures";
import { quoteField, quoteTable, standardQuoteLayout, type QuoteTable } from "./helpers/quote-canvas-fixtures";
import { QUOTE_CANVAS, QUOTE_FIRST_TABLE_ROOM, QUOTE_LEAST_WIDTHS, QUOTE_ROW_FLOOR } from "@/lib/template-contracts/quote";
import { STATEMENT_CANVAS, STATEMENT_FIRST_TABLE_ROOM, STATEMENT_LEAST_WIDTHS, STATEMENT_ROW_FLOOR } from "@/lib/template-contracts/statement";
import { INVOICE_FIRST_TABLE_ROOM, INVOICE_LEAST_WIDTHS, INVOICE_ROW_FLOOR } from "@/lib/template-contracts/invoice";
import { CERT_CONTRACT, CERT_FIRST_TABLE_ROOM, CERT_LEAST_WIDTHS, CERT_ROW_FLOOR } from "@/lib/template-contracts/cert";

/** The standard layout with one item changed (by id). */
function changed(id: string, over: Partial<CanvasItem>): CanvasLayout {
  const layout = standardLayout();
  expect(layout.items.some((i) => i.id === id)).toBe(true);
  return layoutOf(layout.items.map((i) => (i.id === id ? ({ ...i, ...over } as CanvasItem) : i)));
}

/** The standard layout with items added. */
function plus(...items: CanvasItem[]): CanvasLayout {
  return layoutOf([...standardLayout().items, ...items]);
}

/** The standard layout less the items with these ids. */
function less(...ids: string[]): CanvasLayout {
  return layoutOf(standardLayout().items.filter((i) => !ids.includes(i.id)));
}

function text(id: string, box: CanvasBox, anchor: CanvasAnchor = { kind: "page-bottom" }, repeat = false): CanvasItem {
  return { id, kind: "text", text: "Signed", box, anchor, repeat, style: { size: 8, bold: false, align: "left" } };
}

function check(layout: CanvasLayout): () => void {
  return () => validateCanvasLayout(layout, TRAVELER_CONTRACT);
}

const BELOW_STEPS: CanvasAnchor = { kind: "below-table", table: "steps" };

/** Warning (d)'s one-copy sentence (#971 design §7.2): `stars` (their contract names) get `share`
 *  each, under the `head` pt its widest heading word needs; its headings print whole from `whole`. */
function headingsBreak(table: string, stars: string[], share: number, head: number, whole: number): string {
  return `The ${table} table: ${sharedWidthWords(stars, share)}, under the ${round2(head)} pt its widest heading word needs, ` +
    `so its heading words break; its headings print whole from ${round2(whole)} pt wide.`;
}

describe("validateConfig and the canvas", () => {
  it("passes a traveler layout through validateConfig and normalizeStoredConfig unchanged", () => {
    const layout = standardLayout();
    const config = { ...TRAVELER_DEFAULT_CONFIG, layout };
    expect(validateConfig("TRAVELER", config).layout).toEqual(layout);
    expect(normalizeStoredConfig("TRAVELER", config).layout).toEqual(layout);
  });
  it("refuses a layout by name on every document type with no canvas profile", () => {
    const noProfile = TEMPLATE_DOC_TYPES.filter((d) => contractFor(d).canvas === undefined);
    // Every docType has a profile since the container tag's (the container tag design of 2026-11-13,
    // PR 3), so no real docType reaches the no-profile sentence, and the stub below carries it: named,
    // so the case cannot pass vacuously.
    expect(noProfile).toEqual([]);
    // The stub (tests/helpers/test-contract.ts): a docType the registry knows only for this call, whose
    // contract has no profile, refused in the profile's sentence.
    withTestContract(() => {
      expect(() => validateConfig(TEST_DOC_TYPE, { ...defaultConfigFor(TEST_DOC_TYPE), layout: standardLayout() }))
        .toThrow("The Test template offers no canvas; it keeps its sections.");
    });
  });
  it("accepts a certification's layout and runs the rules (design 2026-11-10 §7)", () => {
    const layout = standardCertLayout();
    expect(validateConfig("CERT", { ...defaultConfigFor("CERT"), layout }).layout).toEqual(layout);
    expect(validateConfig("CERT", { ...defaultConfigFor("CERT"), layout: layoutOf([]) }).layout).toEqual(layoutOf([]));
    expect(() => validateConfig("CERT", { ...defaultConfigFor("CERT"), layout: layoutOf([...standardCertLayout().items, barcode()]) }))
      .toThrow("The canvas has a barcode; a certification prints none.");
    expect(canvasPrints("CERT")).toBe(true);
    expect(canvasPrints("BOL")).toBe(true);
  });
  it("accepts a bill of lading's layout and runs the rules", () => {
    const layout = standardBolLayout();
    expect(validateConfig("BOL", { ...defaultConfigFor("BOL"), layout }).layout).toEqual(layout);
    expect(validateConfig("BOL", { ...defaultConfigFor("BOL"), layout: layoutOf([]) }).layout).toEqual(layoutOf([]));
    expect(() => validateConfig("BOL", { ...defaultConfigFor("BOL"), layout: layoutOf([...standardBolLayout().items, barcode()]) }))
      .toThrow("The canvas has a barcode; a bill of lading prints none.");
    expect(canvasPrints("BOL")).toBe(true);
    expect(canvasPrints("SHIPPER")).toBe(true);
    expect(canvasPrints("QUOTE")).toBe(true);
  });
  it("runs the canvas rules: a traveler layout with no barcode is refused through validateConfig", () => {
    const layout = layoutOf(standardLayout().items.filter((i) => i.kind !== "barcode"));
    expect(() => validateConfig("TRAVELER", { ...TRAVELER_DEFAULT_CONFIG, layout })).toThrow(TemplateConfigError);
  });
});

describe("the canvas rules: placement", () => {
  it("names the field keys a canvas may place: every non-column field but the barcode, the two headings and the step values", () => {
    const keys = canvasFieldKeys(TRAVELER_CONTRACT);
    expect(keys.has("customer_name")).toBe(true);
    expect(keys.has("results")).toBe(true);
    expect(keys.has("barcode")).toBe(false);
    expect(keys.has("steps_title")).toBe(false);
    expect(keys.has("inspections_title")).toBe(false);
    expect(keys.has("line_qty")).toBe(false);
    // The locked rendering of a step's parameters inside the steps table (spec §15 Step-fields).
    expect(keys.has("step_values")).toBe(false);
  });
  it("names each table's heading key, and orders the tables by y", () => {
    expect(tableHeadingKey(TRAVELER_CONTRACT, "inspections")).toBe("inspections_title");
    expect(tableHeadingKey(TRAVELER_CONTRACT, "steps")).toBe("steps_title");
    expect(tableHeadingKey(TRAVELER_CONTRACT, "lines")).toBeNull();
    expect(tableHeadingKey(TRAVELER_CONTRACT, "quantities")).toBeNull();
    const shuffled = layoutOf([table("steps", { box: { x: 24, y: 339, w: 564, h: 120 } }), table("lines"), barcode()]);
    expect(tablesByY(shuffled).map((t) => t.key)).toEqual(["lines", "steps"]);
    expect(tablesByY(standardLayout()).map((t) => t.key)).toEqual(["lines", "quantities", "inspections", "steps"]);
  });
  it("drawnBox: a below-table item's y is an offset from the table's drawn bottom", () => {
    const layout = standardLayout();
    const steps = layout.items.find((i) => i.id === "table-steps")!;
    const results = field("results", { anchor: BELOW_STEPS, box: { x: 24, y: 8, w: 180, h: 12 } });
    expect(drawnBox(results, layout)).toEqual({ x: 24, y: steps.box.y + steps.box.h + 8, w: 180, h: 12 });
    expect(drawnBox(results, layout).y).toBe(467);
    // A table's box is its drawn box, whatever its stored anchor; so is a page-top item's.
    expect(drawnBox(steps, layout)).toEqual(steps.box);
    expect(drawnBox(barcode(), layout)).toEqual(barcode().box);
    // A below-table item whose table the layout does not hold keeps its stored box (mid-edit).
    expect(drawnBox(results, layoutOf([barcode()]))).toEqual(results.box);
  });
  it("inferAnchor: below the nearest table above the box, page-top when none", () => {
    const layout = standardLayout(); // inspections drawn 261..331, steps 339..459
    expect(inferAnchor(layout, { x: 24, y: 460, w: 100, h: 12 })).toEqual({ kind: "below-table", table: "steps" });
    expect(inferAnchor(layout, { x: 24, y: 459, w: 100, h: 12 })).toEqual({ kind: "below-table", table: "steps" });
    expect(inferAnchor(layout, { x: 24, y: 100, w: 100, h: 12 })).toEqual({ kind: "page-top" });
    expect(inferAnchor(layout, { x: 24, y: 340, w: 100, h: 12 })).toEqual({ kind: "below-table", table: "inspections" });
    expect(inferAnchor(layout, { x: 24, y: 760, w: 100, h: 8 })).toEqual({ kind: "below-table", table: "steps" });
  });
  it("bandTop is the usable bottom with no page-bottom item, and the highest page-bottom item's top with some", () => {
    expect(bandTop(standardLayout())).toBe(768);
    expect(bandTop(plus(text("a", { x: 24, y: 720, w: 100, h: 12 }), text("b", { x: 24, y: 700, w: 100, h: 12 })))).toBe(700);
    // A table's anchor is derived: a stored page-bottom anchor on one does not open a band.
    expect(bandTop(changed("table-steps", { anchor: { kind: "page-bottom" } }))).toBe(768);
  });
  it("topMargin is the margin with no repeat item, and the lowest repeat item's bottom plus one grid step with one", () => {
    expect(topMargin(changed("barcode", { repeat: false }))).toBe(24);
    expect(topMargin(standardLayout())).toBe(96.5);
    // The repeat band is the page-top band (design §4.5): a repeated page-bottom item is not in it.
    expect(topMargin(plus(text("sig", { x: 24, y: 740, w: 100, h: 12 }, { kind: "page-bottom" }, true)))).toBe(96.5);
    expect(topMargin(changed("table-lines", { repeat: true }))).toBe(96.5);
  });
  it("continuedBox: the repeat band's bottom-left, its bottom level with the lowest repeated item's, else null (Ruling 16)", () => {
    // The standard layout repeats the barcode (bottom 92): the box sits at the left margin, 60 wide
    // and 10 tall, ending one grid step above the top margin (96.5 − 4.5 − 10 = 82).
    expect(continuedBox(standardLayout())).toEqual({ x: 24, y: 82, w: 60, h: 10 });
    expect(topMargin(standardLayout())).toBe(96.5);
    // Both numbers repeated over the barcode: the barcode is still the lowest, so nothing moves.
    const both = layoutOf(standardLayout().items.map((i) =>
      i.kind === "field" && i.key === "load_number" ? { ...i, repeat: true, box: { x: 400, y: 24, w: 60, h: 12 } }
        : i.kind === "field" && i.key === "order_number" ? { ...i, repeat: true, box: { x: 300, y: 24, w: 90, h: 12 } } : i));
    expect(continuedBox(both)).toEqual({ x: 24, y: 82, w: 60, h: 10 });
    expect(topMargin(both)).toBe(96.5);
    // A repeated load number drawn lower than the barcode: the box's bottom follows it (100), and
    // the margin is its bottom plus one grid step, with no room added for the line.
    const low = changed("field-load_number", { repeat: true, box: { x: 260, y: 88, w: 130, h: 12 } });
    expect(continuedBox(low)).toEqual({ x: 24, y: 90, w: 60, h: 10 });
    expect(topMargin(low)).toBe(104.5);
    // Nothing repeated at the page's top: no box. A repeated page-bottom item and a table flagged to
    // repeat (which the validator refuses) do not count.
    const none = changed("barcode", { repeat: false });
    expect(continuedBox(none)).toBeNull();
    expect(continuedBox(layoutOf([...none.items, text("sig", { x: 24, y: 740, w: 100, h: 12 }, { kind: "page-bottom" }, true)]))).toBeNull();
    expect(continuedBox(layoutOf(none.items.map((i) => (i.id === "table-lines" ? { ...i, repeat: true } : i))))).toBeNull();
    // Any repeated page-top item opens it, a text item as well as a field.
    expect(continuedBox(layoutOf([...none.items, text("note", { x: 300, y: 24, w: 60, h: 12 }, { kind: "page-top" }, true)])))
      .toEqual({ x: 24, y: 26, w: 60, h: 10 });
  });
  it("refuses an unknown field key, a table column that is not the table's, a table missing one of its columns, and a column named twice", () => {
    expect(check(plus(field("nonsense")))).toThrow('The field with the key "nonsense" (field field-nonsense) is not one the Traveler contract places on a canvas.');
    expect(check(plus(field("line_qty", { id: "q" })))).toThrow("The Part quantity field is not one the Traveler contract places on a canvas.");
    const lines = standardLayout().items.find((i) => i.id === "table-lines") as Extract<CanvasItem, { kind: "table" }>;
    expect(check(changed("table-lines", { columns: [...lines.columns, { key: "order_qty", visible: true, label: null, width: null }] })))
      .toThrow('The Part lines table names a column "order_qty" that is not one of its columns.');
    expect(check(changed("table-lines", { columns: lines.columns.filter((c) => c.key !== "line_qty") })))
      .toThrow("The Part lines table is missing its Part quantity column.");
    expect(check(changed("table-lines", { columns: [...lines.columns, { key: "line_qty", visible: false, label: null, width: null }] })))
      .toThrow('The Part lines table names the column "line_qty" twice.');
  });
  it("refuses no barcode, two barcodes, no steps table, and a table, the logo or the barcode placed twice", () => {
    expect(check(less("barcode"))).toThrow("The canvas has no barcode; every traveler prints one (spec §8).");
    expect(check(plus(barcode({ id: "barcode-2" }))))
      .toThrow("The canvas has more than one barcode; a traveler prints exactly one (spec §8).");
    expect(check(less("table-steps"))).toThrow("The canvas has no Process steps table");
    expect(check(plus(table("lines", { id: "lines-2" })))).toThrow("The Part lines table is placed twice");
    expect(check(plus(logo({ id: "logo-2" })))).toThrow("The Logo (logo logo-2) is placed twice");
  });
  it("refuses two items sharing an id, naming the id and both kinds", () => {
    const twin = text("field-results", { x: 24, y: 740, w: 100, h: 12 });
    expect(check(plus(twin))).toThrow('Two items share the id "field-results": a field and a text; every item has an id of its own.');
    expect(check(plus(text("results-note", { x: 24, y: 740, w: 100, h: 12 })))).not.toThrow();
  });
  it("refuses a heading on a table that prints none, and keeps one on a table that does", () => {
    expect(check(changed("table-lines", { heading: "Parts" })))
      .toThrow('The Part lines table has the heading "Parts", but it prints no heading; only a table with a heading field takes one.');
    expect(check(changed("table-quantities", { heading: "" })))
      .toThrow('The Quantities and containers table has the heading "", but it prints no heading');
    expect(check(changed("table-inspections", { heading: "Checks" }))).not.toThrow();
    expect(check(changed("table-steps", { heading: "Route" }))).not.toThrow();
  });
  it("refuses a below-table item that names an absent table, one that repeats, a page-top repeat item below the first table's top, and a repeating table", () => {
    expect(check(layoutOf([...less("table-lines").items, field("results", { id: "r2", anchor: { kind: "below-table", table: "lines" }, box: { x: 24, y: 0, w: 100, h: 12 } })])))
      .toThrow("The Results box field is anchored below the Part lines table, which the canvas does not place.");
    expect(check(changed("field-results", { repeat: true })))
      .toThrow("The Results box field repeats on every page but is anchored below the Process steps table");
    expect(check(changed("field-order_number", { repeat: true, box: { x: 120, y: 130, w: 130, h: 12 } })))
      .toThrow("The Order number field repeats on every page but ends at 142 pt, less than one grid step (4.5 pt) above the first table's top at 140; a repeated item sits above the tables (design §4.5).");
    expect(check(changed("table-steps", { repeat: true })))
      .toThrow("The Process steps table is set to repeat on every page; a table prints once, where it is drawn.");
    // The clause takes the repeated item's bottom plus one grid step: one ending one grid step above
    // the first table (135.5 + 4.5 = 140) is accepted, and one ending at its top is not.
    expect(topMargin(changed("field-order_number", { repeat: true, box: { x: 120, y: 123.5, w: 130, h: 12 } }))).toBe(140);
    expect(check(changed("field-order_number", { repeat: true, box: { x: 120, y: 123.5, w: 130, h: 12 } }))).not.toThrow();
    expect(check(changed("field-order_number", { repeat: true, box: { x: 120, y: 128, w: 130, h: 12 } })))
      .toThrow("The Order number field repeats on every page but ends at 140 pt, less than one grid step (4.5 pt) above the first table's top at 140");
  });
  it("refuses a repeat band whose bottom passes the first table's top by any amount, and accepts it level with it (Ruling 9)", () => {
    // The order number repeated, its bottom at 136 over the lines table at 140: the band (the top
    // margin) ends at 140.5, past the table's top; at 135.5 it ends at 140, level with it.
    const repeated = (y: number, dy = 0) => layoutOf(changed("field-order_number", { repeat: true, box: { x: 120, y, w: 130, h: 12 } })
      .items.map((i) => (i.kind === "table" ? { ...i, box: { ...i.box, y: i.box.y + dy } } : i)));
    expect(topMargin(repeated(124))).toBe(140.5);
    expect(check(repeated(124))).toThrow(
      "The Order number field repeats on every page but ends at 136 pt, less than one grid step (4.5 pt) above the " +
      "first table's top at 140; a repeated item sits above the tables (design §4.5).");
    expect(topMargin(repeated(123.5))).toBe(140);
    expect(check(repeated(123.5))).not.toThrow();
    // The refused band is accepted again with every table moved down by 0.5 (the first to 140.5).
    expect(check(repeated(124, 0.5))).not.toThrow();
    // "(continued)" takes no room of its own: the box ends at the band's lowest item (136).
    expect(continuedBox(repeated(124, 0.5))).toEqual({ x: 24, y: 126, w: 60, h: 10 });
  });
  it("refuses a box outside the usable area in each direction, and a page-bottom item above the band", () => {
    expect(check(changed("logo", { box: { x: 10, y: 24, w: 80, h: 40 } })))
      .toThrow("The Logo (logo logo) lies outside the page: its left edge is at 10 pt, before 24.");
    expect(check(changed("logo", { box: { x: 520, y: 24, w: 80, h: 40 } })))
      .toThrow("The Logo (logo logo) lies outside the page: its right edge is at 600 pt, past 588.");
    expect(check(changed("logo", { box: { x: 24, y: 10, w: 80, h: 40 } })))
      .toThrow("The Logo (logo logo) lies outside the page: its top edge is at 10 pt, above 24.");
    expect(check(changed("field-customer_name", { box: { x: 120, y: 760, w: 130, h: 12 } })))
      .toThrow("The Customer name field lies outside the page: its bottom edge is at 772 pt, past 768.");
    // A page-bottom item above the band raises the band's top past the tables drawn over it.
    const band = text("band", { x: 24, y: 700, w: 200, h: 40 });
    expect(check(plus(band))).not.toThrow();
    expect(check(plus(band, text("high", { x: 24, y: 400, w: 200, h: 12 }))))
      .toThrow("The Process steps table lies outside the page: its bottom edge is at 459 pt, past 400, the top of the page-bottom band.");
    expect(check(plus(text("low", { x: 24, y: 760, w: 200, h: 12 }))))
      .toThrow("The Text (text low) lies outside the page: its bottom edge is at 772 pt, past 768.");
    expect(check(plus(text("left", { x: 10, y: 740, w: 200, h: 12 }))))
      .toThrow("The Text (text left) lies outside the page: its left edge is at 10 pt, before 24.");
    expect(check(changed("field-results", { box: { x: 24, y: -1, w: 180, h: 12 } })))
      .toThrow("The Results box field lies outside the page: its offset below the Process steps table is -1 pt, under 0.");
    expect(check(changed("field-results", { box: { x: 500, y: 8, w: 180, h: 12 } })))
      .toThrow("The Results box field lies outside the page: its right edge is at 680 pt, past 588.");
    expect(check(changed("field-customer_name", { box: { x: 120, y: 24, w: -5, h: 12 } })))
      .toThrow("The Customer name field has a negative width (-5 pt).");
    expect(check(changed("field-customer_name", { box: { x: 120, y: 24, w: 130, h: -5 } })))
      .toThrow("The Customer name field has a negative height (-5 pt).");
  });
  it("refuses a table drawn shorter than one row", () => {
    const steps = (h: number) => changed("table-steps", { box: { x: 24, y: 339, w: 564, h } });
    expect(check(steps(0))).toThrow("The Process steps table is drawn 0 pt tall; a table's box is at least 24 pt, one row.");
    expect(check(steps(20))).toThrow("The Process steps table is drawn 20 pt tall; a table's box is at least 24 pt, one row.");
    expect(check(steps(24))).not.toThrow();
    // A negative height keeps its own sentence.
    expect(check(steps(-5))).toThrow("The Process steps table has a negative height (-5 pt).");
  });
  it("prints a sum in a refusal as the figure it is, not its binary noise", () => {
    // 760.1 + 8.2 is 768.3000000000001 in binary; the sentence says 768.3.
    expect(760.1 + 8.2).not.toBe(768.3);
    const low = plus(text("note", { x: 24, y: 760.1, w: 100, h: 8.2 }, { kind: "page-top" }));
    expect(check(low)).toThrow("The Text (text note) lies outside the page: its bottom edge is at 768.3 pt, past 768.");
    expect(check(low)).not.toThrow(String(760.1 + 8.2));
    // 500.1 + 88.2 is 588.3000000000001.
    expect(500.1 + 88.2).not.toBe(588.3);
    const wide = plus(text("note", { x: 500.1, y: 100, w: 88.2, h: 12 }, { kind: "page-top" }));
    expect(check(wide)).toThrow("The Text (text note) lies outside the page: its right edge is at 588.3 pt, past 588.");
    // A repeated item at 120.1 + 16.2 ends at 136.29999999999998.
    expect(120.1 + 16.2).not.toBe(136.3);
    expect(check(changed("field-order_number", { repeat: true, box: { x: 120, y: 120.1, w: 130, h: 16.2 } })))
      .toThrow("The Order number field repeats on every page but ends at 136.3 pt, less than one grid step (4.5 pt) above the first table's top at 140;");
    // Lines at 140.2 + 40.1 ends at 180.29999999999998, past Quantities' top at 180.
    expect(140.2 + 40.1).not.toBe(180.3);
    const stacked = layoutOf(changed("table-lines", { box: { x: 24, y: 140.2, w: 564, h: 40.1 } }).items
      .map((i) => (i.id === "table-quantities" ? { ...i, box: { ...i.box, y: 180 } } : i)));
    expect(check(stacked)).toThrow("the Quantities and containers table starts at 180 pt, above the Part lines table's bottom at 180.3.");
    // Visible column widths 0.1 + 0.2 + 78 + 100.1 make 178.39999999999998.
    expect(0.1 + 0.2 + 78 + 100.1).not.toBe(178.4);
    const lines = standardLayout().items.find((i) => i.id === "table-lines") as Extract<CanvasItem, { kind: "table" }>;
    const widths: Record<string, number> = { line_qty: 0.1, line_part: 0.2, line_weight: 100.1 };
    const columns = lines.columns.map((c) => (c.key in widths ? { ...c, width: widths[c.key] } : c));
    expect(check(changed("table-lines", { box: { x: 24, y: 140, w: 150, h: 40 }, columns })))
      .toThrow("The Part lines table needs 214.9 pt: its visible columns' 178.4 pt, their 32 pt of padding and rules and one grid step, more than its 150 pt.");
  });
  it("accepts a layout that leaves an optional field unplaced (a new contract field is 'not on page')", () => {
    expect(() => validateCanvasLayout(layoutOf(standardLayout().items.filter((i) => !(i.kind === "field" && i.key === "customer_phone"))), TRAVELER_CONTRACT)).not.toThrow();
  });
  it("the standard layout passes every rule, and no two of its drawn boxes overlap", () => {
    const layout = standardLayout();
    expect(check(layout)).not.toThrow();
    const boxes = layout.items.map((item) => ({ id: item.id, box: drawnBox(item, layout) }));
    const overlaps: string[] = [];
    boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => {
      const w = Math.min(a.box.x + a.box.w, b.box.x + b.box.w) - Math.max(a.box.x, b.box.x);
      const h = Math.min(a.box.y + a.box.h, b.box.y + b.box.h) - Math.max(a.box.y, b.box.y);
      if (w > 0 && h > 0) overlaps.push(`${a.id} × ${b.id}`);
    }));
    expect(overlaps).toEqual([]);
  });
});

describe("the canvas rules: tables, covering, regions, the barcode, widths", () => {
  it("refuses a table key the contract's profile lacks, naming the table, before its columns", () => {
    const layout = layoutOf([...standardLayout().items, table("steps", { id: "t2", key: "process_steps" })]);
    let error: unknown;
    try { validateCanvasLayout(layout, TRAVELER_CONTRACT); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(TemplateConfigError);
    expect((error as TemplateConfigError).message).toBe('The table "process_steps" is not one the Traveler contract places on a canvas.');
    expect((error as TemplateConfigError).itemIds).toEqual(["t2"]);
  });
  it("the barcode refusals choose their article from the paper word (design 2026-11-10 §4.6)", () => {
    const invoiceBol: TemplateContract = { ...BOL_CONTRACT, canvas: { ...BOL_CONTRACT.canvas!, paper: "invoice" } };
    expect(() => validateCanvasLayout(layoutOf([barcode()]), invoiceBol))
      .toThrow(new TemplateConfigError("The canvas has a barcode; an invoice prints none.", ["barcode"]));
    const invoiceTraveler: TemplateContract = { ...TRAVELER_CONTRACT, canvas: { ...TRAVELER_CONTRACT.canvas!, paper: "invoice" } };
    const twoBarcodes = layoutOf([...standardLayout().items, barcode({ id: "barcode-2", box: { x: 402, y: 600, w: 186, h: 44 } })]);
    let error: unknown;
    try { validateCanvasLayout(twoBarcodes, invoiceTraveler); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(TemplateConfigError);
    expect((error as TemplateConfigError).message)
      .toBe("The canvas has more than one barcode; an invoice prints exactly one (spec §8).");
    expect((error as TemplateConfigError).itemIds).toEqual(["barcode", "barcode-2"]);
    // Every profile that places no barcode, called on the leaf directly (the registry answers a
    // paper whose canvas does not print yet in the later-release sentence first), held to the
    // editor's own article rule.
    const noBarcode = TEMPLATE_DOC_TYPES.map((docType) => contractFor(docType))
      .filter((contract) => contract.canvas !== undefined && !contract.canvas.barcode);
    expect(noBarcode.length).toBeGreaterThan(0);
    for (const contract of noBarcode) {
      let refused: unknown;
      try { validateCanvasLayout(layoutOf([barcode()]), contract); } catch (e) { refused = e; }
      expect(refused).toBeInstanceOf(TemplateConfigError);
      expect((refused as TemplateConfigError).message)
        .toBe(`The canvas has a barcode; ${withArticle(contract.canvas!.paper)} prints none.`);
    }
  });
  /** The columns of one of the standard layout's tables. */
  function columnsOf(id: string): Extract<CanvasItem, { kind: "table" }>["columns"] {
    const item = standardLayout().items.find((i) => i.id === id);
    if (item?.kind !== "table") throw new Error(`no table ${id}`);
    return item.columns;
  }

  it("regionHeights: the gaps between stacked tables and the tail after the last", () => {
    // standardLayout: lines 140..180, quantities 188..240, inspections 261..331, steps 339..459, and
    // the footer fields hang below Steps to a lowest drawn bottom of 459 + 68 = 527.
    expect(regionHeights(standardLayout())).toEqual([
      { after: "lines", height: 8 },
      { after: "quantities", height: 21 },
      { after: "inspections", height: 8 },
      { after: "steps", height: 68 },
    ]);
    // With nothing below the last table, its tail is 0.
    expect(regionHeights(layoutOf([barcode(), table("steps", { box: { x: 24, y: 339, w: 564, h: 120 } })])))
      .toEqual([{ after: "steps", height: 0 }]);
    // The tail holds the items anchored below the last table alone: an item hanging from an earlier
    // table is that table's region's, however far down it is drawn.
    const hanging = field("results", { id: "hanging", anchor: { kind: "below-table", table: "lines" }, box: { x: 24, y: 400, w: 180, h: 12 } });
    expect(regionHeights(plus(hanging)).at(-1)).toEqual({ after: "steps", height: 68 });
    // The usable height is the band's top less the top margin: 768 − 96.5.
    expect(usableHeight(standardLayout())).toBe(671.5);
    expect(firstTableRoom(TRAVELER_CONTRACT)).toBe(54);
  });

  it("refuses two tables overlapping in y, naming both", () => {
    expect(check(changed("table-quantities", { box: { x: 24, y: 150, w: 564, h: 52 } })))
      .toThrow("The Part lines table and the Quantities and containers table overlap: the Quantities and containers table starts at 150 pt, above the Part lines table's bottom at 180.");
    // Stacked edge to edge is not overlapping.
    expect(check(changed("table-quantities", { box: { x: 24, y: 180, w: 564, h: 52 } }))).not.toThrow();
  });

  it("refuses an item covering the barcode and one covering the steps table, and accepts a stroke that stops at an edge", () => {
    expect(check(plus(text("over", { x: 402, y: 48, w: 100, h: 12 }, { kind: "page-top" }))))
      .toThrow("The Text (text over) is drawn over the Barcode (barcode barcode); nothing may cover a required element.");
    expect(check(changed("field-customer_phone", { box: { x: 24, y: 350, w: 130, h: 12 } })))
      .toThrow("The Customer phone field is drawn over the Process steps table; nothing may cover a required element.");
    // A 1 pt rule under the steps table (drawn 339..459): at y 459.5 its ink is 459..460 and stops
    // at the table's bottom edge; at y 459 its ink is 458.5..459.5 and runs into the table.
    const rule = (y: number): CanvasItem => ({ id: "rule", kind: "line", weight: 1, box: { x: 24, y, w: 564, h: 0 }, anchor: { kind: "page-top" }, repeat: false });
    expect(check(plus(rule(459.5)))).not.toThrow();
    expect(check(plus(rule(459))))
      .toThrow("The Line (line rule) is drawn over the Process steps table; nothing may cover a required element.");
    // Touching the barcode's left edge is not covering it either.
    expect(check(plus(text("beside", { x: 392, y: 100, w: 10, h: 12 }, { kind: "page-top" })))).not.toThrow();
    expect(check(plus(text("beside", { x: 392, y: 60, w: 10, h: 12 }, { kind: "page-top" })))).not.toThrow();
  });

  /** A static line or box outline at the page's top, or at its foot. */
  function stroke(kind: "line" | "box", id: string, box: CanvasBox, weight: number, anchor: CanvasAnchor = { kind: "page-top" }): CanvasItem {
    return { id, kind, weight, box, anchor, repeat: false };
  }

  it("inkBoxes: a filled item's box, a line's stroke about its axis, and a box outline's four edges", () => {
    const filled = text("t", { x: 24, y: 100, w: 50, h: 12 }, { kind: "page-top" });
    expect(inkBoxes(filled)).toEqual([{ x: 24, y: 100, w: 50, h: 12 }]);
    expect(inkBoxes(stroke("line", "h", { x: 24, y: 400, w: 564, h: 0 }, 4))).toEqual([{ x: 24, y: 398, w: 564, h: 4 }]);
    expect(inkBoxes(stroke("line", "v", { x: 452, y: 24, w: 0, h: 100 }, 4))).toEqual([{ x: 450, y: 24, w: 4, h: 100 }]);
    expect(inkBoxes(stroke("box", "f", { x: 100, y: 200, w: 50, h: 20 }, 2))).toEqual([
      { x: 99, y: 199, w: 52, h: 2 },
      { x: 99, y: 219, w: 52, h: 2 },
      { x: 99, y: 199, w: 2, h: 22 },
      { x: 149, y: 199, w: 2, h: 22 },
    ]);
  });

  it("judges covering by ink: a line's stroke and a box's outline cover what they cross, and a frame drawn clear does not", () => {
    expect(check(plus(stroke("line", "across-steps", { x: 24, y: 400, w: 564, h: 0 }, 4))))
      .toThrow("The Line (line across-steps) is drawn over the Process steps table; nothing may cover a required element.");
    expect(check(plus(stroke("line", "through-barcode", { x: 452, y: 24, w: 0, h: 100 }, 4))))
      .toThrow("The Line (line through-barcode) is drawn over the Barcode (barcode barcode); nothing may cover a required element.");
    expect(check(plus(stroke("line", "across-barcode", { x: 24, y: 68, w: 564, h: 0 }, 4))))
      .toThrow("The Line (line across-barcode) is drawn over the Barcode (barcode barcode); nothing may cover a required element.");
    // A 4 pt stroke at x 400 inks 398..402 and stops at the barcode's left edge.
    expect(check(plus(stroke("line", "short", { x: 400, y: 24, w: 0, h: 100 }, 4)))).not.toThrow();
    // The barcode at the foot of the page, 200..386 × 700..744, framed with 4 pt clearance: the frame's
    // ink is its edges alone.
    const foot: CanvasAnchor = { kind: "page-bottom" };
    const framed = (frame: CanvasBox) => layoutOf([
      ...changed("barcode", { anchor: foot, box: { x: 200, y: 700, w: 186, h: 44 } }).items,
      stroke("box", "frame", frame, 1, foot),
    ]);
    expect(check(framed({ x: 196, y: 696, w: 194, h: 52 }))).not.toThrow();
    // The same frame moved down: its top edge at 720 runs through the barcode.
    expect(check(framed({ x: 196, y: 720, w: 194, h: 40 })))
      .toThrow("The Box (box frame) is drawn over the Barcode (barcode barcode); nothing may cover a required element.");
  });

  it("refuses a barcode under 186 × 44 and one off the 186:44 proportions", () => {
    expect(check(changed("barcode", { box: { x: 402, y: 48, w: 180, h: 44 } })))
      .toThrow("The Barcode (barcode barcode) is 180 pt wide; a barcode is at least 186 pt wide so a scanner can read it.");
    expect(check(changed("barcode", { box: { x: 402, y: 48, w: 186, h: 40 } })))
      .toThrow("The Barcode (barcode barcode) is 40 pt tall; a barcode is at least 44 pt tall so a scanner can read it.");
    const low: CanvasAnchor = { kind: "page-bottom" };
    expect(check(changed("barcode", { anchor: low, box: { x: 24, y: 600, w: 372, h: 100 } })))
      .toThrow("The Barcode (barcode barcode) is 372 × 100 pt; a barcode keeps the 186 × 44 proportions.");
    // Twice the floor in both directions keeps the proportions, and a hair off them is within tolerance.
    expect(check(changed("barcode", { anchor: low, box: { x: 24, y: 600, w: 372, h: 88 } }))).not.toThrow();
    expect(check(changed("barcode", { box: { x: 400, y: 48, w: 186.8, h: 44 } }))).not.toThrow();
  });

  it("refuses a region taller than the usable height, a band taller than it, and a first table too low for a heading and a row", () => {
    // The footer's Results box hangs 700 pt below Steps: the tail is 700 + 12 = 712 > 671.5.
    expect(check(changed("field-results", { box: { x: 24, y: 700, w: 180, h: 12 } })))
      .toThrow("The region after the Process steps table is 712 pt tall, more than the 671.5 pt a page holds under its top margin.");
    // A page-bottom item at y 100: the band is 768 − 100 = 668 tall, and with no page-top repeat item
    // the top margin is 24, so a page holds 100 − 24 = 76.
    const steps = table("steps", { box: { x: 24, y: 24, w: 564, h: 40 } });
    const lowBarcode = barcode({ anchor: { kind: "page-bottom" }, box: { x: 402, y: 700, w: 186, h: 44 } });
    expect(check(layoutOf([steps, lowBarcode, text("band", { x: 24, y: 100, w: 200, h: 12 })])))
      .toThrow("The page-bottom band is 668 pt tall, more than the 76 pt a page holds under its top margin.");
    expect(check(layoutOf([steps, lowBarcode, text("band", { x: 24, y: 400, w: 200, h: 12 })]))).not.toThrow();
    // Steps at y 720, 40 tall, ends inside the page, but 720 + 54 passes the band's top at 768.
    expect(check(layoutOf([barcode(), table("steps", { box: { x: 24, y: 720, w: 564, h: 40 } })])))
      .toThrow("The Process steps table starts at 720 pt, too low for its heading and one row (54 pt) above 768.");
    expect(check(layoutOf([barcode(), table("steps", { box: { x: 24, y: 714, w: 564, h: 40 } })]))).not.toThrow();
  });

  it("counts the page line's room against the usable height when the template prints a page line", () => {
    expect(PAGE_LINE_ROOM).toBe(20);
    // The room is the traveler's bottom margin with the page line on, less the plain page margin.
    expect(PAGE_LINE_ROOM).toBe(FOOTER_BOTTOM_MARGIN - CANVAS_PAGE.margin);
    expect(usableHeight(standardLayout(), true)).toBe(651.5);
    // The Results box 648 pt below Steps makes a 660 pt tail: inside 671.5, past 671.5 − 20.
    const tall = changed("field-results", { box: { x: 24, y: 648, w: 180, h: 12 } });
    expect(() => validateCanvasLayout(tall, TRAVELER_CONTRACT, { pageFooter: false })).not.toThrow();
    expect(check(tall)).not.toThrow();
    const sentence = "The region after the Process steps table is 660 pt tall, more than the 651.5 pt a page holds under its top margin and the page line.";
    expect(() => validateCanvasLayout(tall, TRAVELER_CONTRACT, { pageFooter: true })).toThrow(sentence);
    // validateConfig hands the config's own pageFooter to the rules.
    expect(validateConfig("TRAVELER", { ...TRAVELER_DEFAULT_CONFIG, pageFooter: false, layout: tall }).layout).toEqual(tall);
    expect(() => validateConfig("TRAVELER", { ...TRAVELER_DEFAULT_CONFIG, pageFooter: true, layout: tall })).toThrow(sentence);
    const band = layoutOf([
      table("steps", { box: { x: 24, y: 24, w: 564, h: 40 } }),
      barcode({ anchor: { kind: "page-bottom" }, box: { x: 402, y: 700, w: 186, h: 44 } }),
      text("band", { x: 24, y: 100, w: 200, h: 12 }),
    ]);
    // One page-foot model: the band runs from 100 to the foot at 748 (648 tall), and a page holds
    // 100 − 24 = 76 above it.
    expect(() => validateCanvasLayout(band, TRAVELER_CONTRACT, { pageFooter: true }))
      .toThrow("The page-bottom band is 648 pt tall, more than the 76 pt a page holds under its top margin and the page line.");
  });

  it("pageFoot: the usable bottom, less the page line's room when the line prints; the band's top defaults to it", () => {
    expect(pageFoot()).toBe(768);
    expect(pageFoot(false)).toBe(768);
    expect(pageFoot(true)).toBe(748);
    expect(bandTop(standardLayout(), true)).toBe(748);
    expect(bandHeight(standardLayout(), true)).toBe(0);
    // A page-top item ends by the page line's room when the line prints and there is no band.
    const ending = (y: number) => plus(text("note", { x: 24, y, w: 200, h: 12 }, { kind: "page-top" }));
    expect(() => validateCanvasLayout(ending(748), TRAVELER_CONTRACT, { pageFooter: true }))
      .toThrow("The Text (text note) lies outside the page: its bottom edge is at 760 pt, past 748, where the page line's room begins.");
    expect(() => validateCanvasLayout(ending(736), TRAVELER_CONTRACT, { pageFooter: true })).not.toThrow();
    expect(() => validateCanvasLayout(ending(748), TRAVELER_CONTRACT, { pageFooter: false })).not.toThrow();
  });

  it("measures a band at 700..748 as 48 with the page line on, and judges the regions against 700 less the top margin", () => {
    const banded = (offset: number) => layoutOf([
      ...changed("field-results", { box: { x: 24, y: offset, w: 180, h: 12 } }).items,
      text("signed", { x: 24, y: 700, w: 200, h: 48 }),
    ]);
    expect(bandTop(banded(8), true)).toBe(700);
    expect(bandHeight(banded(8), true)).toBe(48);
    expect(usableHeight(banded(8), true)).toBe(603.5);
    // The Results box at offset 588 makes a 600 pt tail, inside 603.5; at offset 598, 610 is not.
    expect(() => validateCanvasLayout(banded(588), TRAVELER_CONTRACT, { pageFooter: true })).not.toThrow();
    expect(() => validateCanvasLayout(banded(598), TRAVELER_CONTRACT, { pageFooter: true }))
      .toThrow("The region after the Process steps table is 610 pt tall, more than the 603.5 pt a page holds under its top margin and the page line.");
  });

  it("keeps the page line's room under the band: a page-bottom item may end at 748 with the page line on", () => {
    const signed = plus(text("signed", { x: 24, y: 756, w: 200, h: 12 }));
    expect(() => validateCanvasLayout(signed, TRAVELER_CONTRACT, { pageFooter: false })).not.toThrow();
    expect(() => validateCanvasLayout(signed, TRAVELER_CONTRACT, { pageFooter: true }))
      .toThrow("The Text (text signed) lies outside the page: its bottom edge is at 768 pt, past 748, where the page line's room begins.");
    expect(() => validateCanvasLayout(plus(text("signed", { x: 24, y: 736, w: 200, h: 12 })), TRAVELER_CONTRACT, { pageFooter: true }))
      .not.toThrow();
  });

  it("refuses a table hiding any locked column with that column's own lock sentence, and keeps a removable one free", () => {
    const fields = TRAVELER_CONTRACT.sections.flatMap((section) => section.fields);
    const lockOf = (key: string) => fields.find((f) => f.key === key)!.lockReason!;
    expect(lockOf("step_code")).toContain("Spec §15 Step-fields ruling");
    for (const [key, name] of [["step_position", "Step position"], ["step_code", "Step code"], ["step_instruction", "Step instruction"]]) {
      const columns = columnsOf("table-steps").map((c) => (c.key === key ? { ...c, visible: false } : c));
      expect(check(changed("table-steps", { columns }))).toThrow(`The Process steps table hides its ${name} column. ${lockOf(key)}`);
    }
    const lines = columnsOf("table-lines").map((c) => (c.key === "line_each_weight" ? { ...c, visible: false } : c));
    expect(check(changed("table-lines", { columns: lines }))).not.toThrow();
  });

  it("refuses a steps table hiding a handwriting column with the lock's own sentence, and a table whose column widths pass its drawn width", () => {
    for (const [key, name] of [["step_eq", "EQ# box"], ["step_op", "OP box"], ["step_date", "Date box"]]) {
      const columns = columnsOf("table-steps").map((c) => (c.key === key ? { ...c, visible: false } : c));
      expect(check(changed("table-steps", { columns }))).toThrow(TRAVELER_HANDWRITING_LOCK);
      expect(check(changed("table-steps", { columns }))).toThrow(`The Process steps table hides its ${name} column.`);
    }
    // Lines at 300 wide: 78 + 78 + 88 and "*" as 0 make 244, with their 32 pt of padding and rules
    // and one grid step 280.5 (#971), which fits.
    const narrow = { x: 24, y: 140, w: 300, h: 40 };
    expect(check(changed("table-lines", { box: narrow }))).not.toThrow();
    const wide = columnsOf("table-lines").map((c) => (c.key === "line_part" ? { ...c, width: 100 } : c));
    expect(check(changed("table-lines", { box: narrow, columns: wide })))
      .toThrow("The Part lines table needs 380.5 pt: its visible columns' 344 pt, their 32 pt of padding and rules and one grid step, more than its 300 pt.");
    // A hidden column takes no width.
    const hidden = wide.map((c) => (c.key === "line_part" ? { ...c, visible: false } : c));
    expect(check(changed("table-lines", { box: narrow, columns: hidden }))).not.toThrow();
  });
});

describe("canvasWarnings", () => {
  const TOP: CanvasAnchor = { kind: "page-top" };

  /** A measure holding these items (by id) and nothing else. */
  function measured(...items: CanvasMeasure["items"]): CanvasMeasure {
    return { pages: 1, tables: [], regions: [], items };
  }

  function warnings(layout: CanvasLayout, measure?: CanvasMeasure, pageFooter?: boolean) {
    return canvasWarnings(layout, TRAVELER_CONTRACT, measure, pageFooter === undefined ? undefined : { pageFooter });
  }

  it("warns on two overlapping drawn boxes, naming both, and not on touching edges", () => {
    // Free page-top room left of the header fields and under the logo: x 24..120, y 64..140.
    const a = text("a", { x: 24, y: 100, w: 60, h: 12 }, TOP);
    expect(warnings(plus(a, text("b", { x: 50, y: 106, w: 60, h: 12 }, TOP)))).toEqual([
      { itemIds: ["a", "b"], sentence: "The Text (text a) and the Text (text b) overlap; one prints over the other." },
    ]);
    // Edge to edge, across and down, is not an overlap.
    expect(warnings(plus(a, text("b", { x: 84, y: 100, w: 20, h: 12 }, TOP)))).toEqual([]);
    expect(warnings(plus(a, text("b", { x: 24, y: 112, w: 60, h: 12 }, TOP)))).toEqual([]);
    // Judged by ink: a frame drawn clear around a field does not overlap it, one through it does.
    const frame = (box: CanvasBox): CanvasItem => ({ id: "frame", kind: "box", weight: 1, box, anchor: TOP, repeat: false });
    const inner = text("inner", { x: 40, y: 100, w: 40, h: 12 }, TOP);
    expect(warnings(plus(inner, frame({ x: 30, y: 96, w: 60, h: 20 })))).toEqual([]);
    expect(warnings(plus(inner, frame({ x: 30, y: 106, w: 60, h: 20 })))).toEqual([
      { itemIds: ["inner", "frame"], sentence: "The Text (text inner) and the Box (box frame) overlap; one prints over the other." },
    ]);
    // An item over a table the covering rule does not guard is warned (a table grows only downward).
    expect(warnings(plus(text("t", { x: 24, y: 150, w: 100, h: 12 }, TOP)))).toEqual([
      { itemIds: ["table-lines", "t"], sentence: "The Part lines table and the Text (text t) overlap; one prints over the other." },
    ]);
  });

  it("does not repeat a refusal: an item drawn over the barcode or the steps table, and two tables overlapping, warn of nothing", () => {
    const overBarcode = plus(text("over", { x: 402, y: 48, w: 100, h: 12 }, TOP));
    expect(check(overBarcode)).toThrow("is drawn over the Barcode");
    expect(warnings(overBarcode)).toEqual([]);
    const overSteps = changed("field-customer_phone", { box: { x: 24, y: 350, w: 130, h: 12 } });
    expect(check(overSteps)).toThrow("is drawn over the Process steps table");
    expect(warnings(overSteps)).toEqual([]);
    const stackedOver = changed("table-quantities", { box: { x: 24, y: 150, w: 564, h: 52 } });
    expect(check(stackedOver)).toThrow("overlap");
    expect(warnings(stackedOver)).toEqual([]);
  });

  it("with a measure, judges overlap on the measured boxes and warns on a text item taller than its box", () => {
    const a = text("a", { x: 24, y: 100, w: 60, h: 12 }, TOP);
    const b = text("b", { x: 24, y: 124, w: 60, h: 12 }, TOP);
    // Drawn apart, a measures 30 tall and runs into b.
    expect(warnings(plus(a, b))).toEqual([]);
    const grown = measured({ id: "a", page: 1, left: 24, top: 100, height: 30 }, { id: "b", page: 1, left: 24, top: 124, height: 12 });
    expect(warnings(plus(a, b), grown)).toEqual([
      { itemIds: ["a", "b"], sentence: "The Text (text a) and the Text (text b) overlap; one prints over the other." },
      { itemIds: ["a"], sentence: "The Text (text a) is taller than its box by 18 pt and prints over what is drawn under it." },
    ]);
    // Drawn over each other, measured on two pages: no overlap.
    const c = text("c", { x: 24, y: 100, w: 60, h: 12 }, TOP);
    const d = text("d", { x: 50, y: 106, w: 60, h: 12 }, TOP);
    const apart = measured({ id: "c", page: 1, left: 24, top: 100, height: 12 }, { id: "d", page: 2, left: 50, top: 106, height: 12 });
    expect(warnings(plus(c, d), apart)).toEqual([]);
    // A repeated band item is measured on page 1 and prints on every page, so it is judged against a
    // last-page band item measured on page 3 too (Codex on PR 2a): drawn over each other, they warn.
    const every = text("every", { x: 24, y: 740, w: 100, h: 12 }, { kind: "page-bottom" }, true);
    const last = text("last", { x: 50, y: 746, w: 100, h: 12 }, { kind: "page-bottom" });
    const threePages = { ...measured({ id: "every", page: 1, left: 24, top: 740, height: 12 }, { id: "last", page: 3, left: 50, top: 746, height: 12 }), pages: 3 };
    expect(warnings(plus(every, last), threePages).map((w) => w.itemIds)).toEqual([["every", "last"]]);
    // A measure holding one of the two: both are judged where they are drawn.
    expect(warnings(plus(c, d), measured({ id: "c", page: 2, left: 24, top: 100, height: 12 }))).toHaveLength(1);
    // A text item that grows down over the barcode is not refused on its drawn box, so it warns.
    const growing = text("grow", { x: 402, y: 24, w: 186, h: 12 }, TOP);
    expect(check(plus(growing))).not.toThrow();
    const overCode = measured({ id: "grow", page: 1, left: 402, top: 24, height: 30 }, { id: "barcode", page: 1, left: 402, top: 48, height: 44 });
    expect(warnings(plus(growing), overCode)).toEqual([
      { itemIds: ["barcode", "grow"], sentence: "The Barcode (barcode barcode) and the Text (text grow) overlap; one prints over the other." },
      { itemIds: ["grow"], sentence: "The Text (text grow) is taller than its box by 18 pt and prints over what is drawn under it." },
    ]);
  });

  describe("against a table the picked record leaves empty (#958)", () => {
    // A page-top text drawn over the Inspections table's drawn box (261..331), clear of every other
    // item; under the owner's answer to question 2, warnings (a) and (b) judge what prints.
    const note = text("note", { x: 300, y: 280, w: 100, h: 12 }, TOP);
    const noteAt = { id: "note", page: 1, left: 300, top: 280, height: 12 };
    const overInspections = [
      { itemIds: ["table-inspections", "note"], sentence: "The Key characteristic inspections table and the Text (text note) overlap; one prints over the other." },
    ];
    const inspectionsAt = (height: number): CanvasMeasure["tables"] => [{ key: "inspections", page: 1, top: 261, height }];

    it("warns of the item drawn over the table's box with no measure, and of the pair alone", () => {
      // Red when (a) judges nothing on drawn boxes (its `else` branch made `continue`).
      expect(warnings(plus(note))).toEqual(overInspections);
    });

    it("warns of nothing when the measure holds the table at 0 pt and the item over its box: nothing prints under it", () => {
      // Red when `measuredOf` gives a table its drawn box in place of `{ …, y: m.top, h: m.height }`.
      expect(warnings(plus(note), { ...measured(noteAt), tables: inspectionsAt(0) })).toEqual([]);
    });

    it("warns when the measure holds the same table printing over the item: the pair is judged at all", () => {
      // Red when (a) skips a pair the measure holds both of (`if (ma !== null && mb !== null) continue;`).
      expect(warnings(plus(note), { ...measured(noteAt), tables: inspectionsAt(70) })).toEqual(overInspections);
    });

    it("warns when the measure holds the empty table and not the item: both are judged on their drawn boxes", () => {
      // Held as before #958 (no source change reaches it). Red when (a)'s drawn-box branch judges
      // nothing (its `else` replaced by `continue`).
      expect(warnings(plus(note), { ...measured(), tables: inspectionsAt(0) })).toEqual(overInspections);
    });

    it("warns of a column table drawn narrower than its columns whatever the measure holds: warning (d) is the config's (pin)", () => {
      // Since #971 (d) says where the headings break (design §7.2): the Part lines table at its 244 pt
      // of fixed columns leaves its Part identity column nothing, under its "Description" heading word.
      const lines = standardLayout().items.find((i) => i.id === "table-lines") as Extract<CanvasItem, { kind: "table" }>;
      const declared = visibleColumnsWidth(TRAVELER_CONTRACT, lines);
      const narrow = changed("table-lines", { box: { ...lines.box, w: declared } });
      const empty: CanvasMeasure = { ...measured(), tables: [{ key: "lines", page: 1, top: 140, height: 0 }] };
      expect(warnings(narrow, empty)).toEqual([
        { itemIds: ["table-lines"], sentence: "The Part lines table: Part identity gets 0 pt, under the 40.86 pt its widest heading word needs, so its heading words break; its headings print whole from 316.86 pt wide." },
      ]);
    });
  });

  it("with a measure, judges a flowing body item against a page-bottom item only down to the band's top, and nothing wider", () => {
    // A repeated strip at the band's top (740); the tables, measured as paging blocks, are one box
    // each, their top on page 1 and their height the flow extent over three pages, past the page.
    const BOTTOM: CanvasAnchor = { kind: "page-bottom" };
    const strip = text("strip", { x: 24, y: 740, w: 300, h: 12 }, BOTTOM, true);
    const stripAt = { id: "strip", page: 1, left: 24, top: 740, height: 12 };
    const paging = (...items: CanvasMeasure["items"]): CanvasMeasure => ({
      pages: 3, regions: [], items: [stripAt, ...items],
      tables: [{ key: "inspections", page: 1, top: 261, height: 1400 }, { key: "steps", page: 1, top: 339, height: 1500 }],
    });
    expect(check(plus(strip))).not.toThrow();
    expect(warnings(plus(strip), paging())).toEqual([]);
    // A page-top item that pages is a flow extent too: it meets the tables its extent runs over, and
    // (b) and (c) still say it pages, but not the strip.
    const long = text("long", { x: 24, y: 100, w: 60, h: 12 }, TOP);
    expect(warnings(plus(strip, long), paging({ id: "long", page: 1, left: 24, top: 100, height: 1000 })).map((w) => w.itemIds))
      .toEqual([["table-inspections", "long"], ["table-steps", "long"], ["long"], ["long"]]);
    // Judged whole when its measured bottom does not pass the band: a frame whose bottom edge sits at
    // the band's top strokes half its weight into the strip (the tables measured where they are drawn).
    const frame: CanvasItem = { id: "frame", kind: "box", weight: 2, box: { x: 24, y: 700, w: 200, h: 40 }, anchor: TOP, repeat: false };
    const onePage: CanvasMeasure = {
      pages: 1, regions: [], items: [stripAt, { id: "frame", page: 1, left: 24, top: 700, height: 40 }],
      tables: [{ key: "inspections", page: 1, top: 261, height: 70 }, { key: "steps", page: 1, top: 339, height: 120 }],
    };
    expect(warnings(plus(strip, frame), onePage)).toEqual([
      { itemIds: ["strip", "frame"], sentence: "The Text (text strip) and the Box (box frame) overlap; one prints over the other." },
    ]);
    // A below-table item rides its unbreakable region on one page and is not cut: one that measures
    // taller than drawn, past the band, prints its lines through the band on paper (rendered with the
    // sheet), so it is warned with the strip, and (b) and (c) say it outgrows its box.
    const under = text("under", { x: 24, y: 266, w: 60, h: 12 }, BELOW_STEPS);
    expect(warnings(plus(strip, under), paging({ id: "under", page: 3, left: 24, top: 725, height: 30 })).map((w) => w.itemIds))
      .toEqual([["strip", "under"], ["under"], ["under"]]);
    // Two page-bottom items are not cut: measured over each other, they warn.
    const beside = text("beside", { x: 100, y: 744, w: 100, h: 12 }, BOTTOM);
    expect(warnings(plus(strip, beside), paging({ id: "beside", page: 3, left: 100, top: 744, height: 12 })).map((w) => w.itemIds))
      .toEqual([["strip", "beside"]]);
    // Without a measure the drawn boxes are judged whole: a page-top item drawn over the strip (a
    // layout rule 4 refuses, its bottom past the band's top) is warned.
    const over = text("over", { x: 24, y: 734, w: 60, h: 12 }, TOP);
    expect(canvasRefusal(plus(strip, over), TRAVELER_CONTRACT)).toEqual({
      itemIds: ["over"],
      sentence: "The Text (text over) lies outside the page: its bottom edge is at 746 pt, past 740, the top of the page-bottom band.",
    });
    expect(warnings(plus(strip, over)).map((w) => w.itemIds)).toContainEqual(["strip", "over"]);
  });

  it("with a measure, warns of an overlap only when its depth prints as more than 0 pt (Ruling 21)", () => {
    const a = text("a", { x: 24, y: 100, w: 60, h: 12 }, TOP);
    const b = text("b", { x: 24, y: 112, w: 60, h: 12 }, TOP);
    // Drawn touching; a measured 0.0002 pt past b's top: no warning.
    expect(warnings(plus(a, b), measured(
      { id: "a", page: 1, left: 24, top: 100, height: 12.0002 }, { id: "b", page: 1, left: 24, top: 112, height: 12 },
    ))).toEqual([]);
    expect(warnings(plus(a, b), measured(
      { id: "a", page: 1, left: 24, top: 100, height: 12.01 }, { id: "b", page: 1, left: 24, top: 112, height: 12 },
    ))).toEqual([
      { itemIds: ["a", "b"], sentence: "The Text (text a) and the Text (text b) overlap; one prints over the other." },
      { itemIds: ["a"], sentence: "The Text (text a) is taller than its box by 0.01 pt and prints over what is drawn under it." },
    ]);
  });

  it("with a measure, warns that an item is taller than its box only when the difference prints as more than 0 pt", () => {
    const a = text("a", { x: 24, y: 100, w: 60, h: 12 }, TOP);
    // 0.004 pt over prints as 0 pt: no warning.
    expect(warnings(plus(a), measured({ id: "a", page: 1, left: 24, top: 100, height: 12.004 }))).toEqual([]);
    expect(warnings(plus(a), measured({ id: "a", page: 1, left: 24, top: 100, height: 12.01 }))).toEqual([
      { itemIds: ["a"], sentence: "The Text (text a) is taller than its box by 0.01 pt and prints over what is drawn under it." },
    ]);
  });

  it("with a measure, says 'would add a page' for a page-top item past its limit and 'would be cut off' for a below-table or page-bottom item past its", () => {
    // Drawn, with no measure: the Results box 400 pt below Steps (drawn 459) ends at 871. The
    // validator accepts it (its 412 pt tail fits a page); its region would be cut off.
    const low = changed("field-results", { box: { x: 24, y: 400, w: 180, h: 12 } });
    expect(check(low)).not.toThrow();
    expect(warnings(low)).toEqual([
      { itemIds: ["field-results"], sentence: "The Results box field ends at 871 pt, past 768, and would be cut off." },
    ]);
    // The page line's room counts: 290 below Steps ends at 761, inside 768 and past 748.
    const near = changed("field-results", { box: { x: 24, y: 290, w: 180, h: 12 } });
    expect(warnings(near, undefined, false)).toEqual([]);
    expect(warnings(near, undefined, true)).toEqual([
      { itemIds: ["field-results"], sentence: "The Results box field ends at 761 pt, past 748, where the page line's room begins, and would be cut off." },
    ]);
    // Drawn past the foot, a page-top item would add a page; a page-bottom item, printed in the
    // footer frame that drops its overflow, would be cut off.
    expect(warnings(plus(text("note", { x: 24, y: 760, w: 100, h: 12 }, TOP)))).toEqual([
      { itemIds: ["note"], sentence: "The Text (text note) ends at 772 pt, past 768, and would add a page." },
    ]);
    expect(warnings(plus(text("sig", { x: 24, y: 760, w: 100, h: 12 })))).toEqual([
      { itemIds: ["sig"], sentence: "The Text (text sig) ends at 772 pt, past 768, and would be cut off." },
    ]);
    // A page-top item past the band's top would add a page.
    const banded = plus(text("signed", { x: 24, y: 700, w: 200, h: 48 }), text("note", { x: 300, y: 690, w: 100, h: 12 }, TOP));
    expect(warnings(banded)).toEqual([
      { itemIds: ["note"], sentence: "The Text (text note) ends at 702 pt, past 700, the top of the page-bottom band, and would add a page." },
    ]);
    // Measured: a page-top text item drawn inside the page that renders 80 tall would add a page.
    const note = plus(text("note", { x: 24, y: 700, w: 200, h: 12 }, TOP));
    expect(warnings(note)).toEqual([]);
    expect(warnings(note, measured({ id: "note", page: 1, left: 24, top: 700, height: 80 }))).toEqual([
      { itemIds: ["note"], sentence: "The Text (text note) is taller than its box by 68 pt and prints over what is drawn under it." },
      { itemIds: ["note"], sentence: "The Text (text note) ends at 780 pt, past 768, and would add a page." },
    ]);
    // Measured: the Results box, drawn high under Steps, renders low on its page and would be cut off.
    expect(warnings(standardLayout(), measured({ id: "field-results", page: 1, left: 24, top: 760, height: 12 }))).toEqual([
      { itemIds: ["field-results"], sentence: "The Results box field ends at 772 pt, past 768, and would be cut off." },
    ]);
    // The measure wins over the drawn box: drawn past the foot, measured inside a page.
    expect(warnings(low, measured({ id: "field-results", page: 2, left: 24, top: 100, height: 12 }))).toEqual([]);
  });

  it("with a measure holding a below-table item (the preview's alone render), warns that it is taller than its box and, past the band's top, that it would be cut off", () => {
    // The standard layout's Steps table is drawn 339..459, so its region's top is 459 and the
    // Results box, 8 pt under it, is drawn 467..479. Measured 52 tall there: 40 over its 12 pt box,
    // its bottom at 519, inside the band's top (768).
    const layout = standardLayout();
    const region = { after: "steps" as const, page: 1, top: 459, height: 68 };
    const at = (top: number): CanvasMeasure => ({
      pages: 1, tables: [], regions: [region],
      items: [{ id: "field-results", page: 1, left: 24, top, height: 52 }],
    });
    expect(warnings(layout, at(region.top + 8))).toEqual([
      { itemIds: ["field-results"], sentence: "The Results box field is taller than its box by 40 pt and prints over what is drawn under it." },
    ]);
    // The region rode the steps table down to 732: the box, measured at 740, ends at 792.
    expect(warnings(layout, at(740))).toEqual([
      { itemIds: ["field-results"], sentence: "The Results box field is taller than its box by 40 pt and prints over what is drawn under it." },
      { itemIds: ["field-results"], sentence: "The Results box field ends at 792 pt, past 768, and would be cut off." },
    ]);
  });

  it("warns when the steps table's printed width passes its drawn width, through travelerStepsPrintedWidth", () => {
    // The contract's default columns flex: on paper they take at least 188 declared + 25.6 of
    // padding and rules = 213.6 pt, so a 200 pt box is warned. Since #971 rule 9 refuses that box
    // (its least width counts the padding and rules and one grid step, 218.1), so warning (d) is
    // reached here only on a layout the validator refuses, which the designer still warns on.
    const box = (w: number) => ({ x: 24, y: 339, w, h: 120 });
    expect(check(changed("table-steps", { box: box(200) }))).toThrow(
      "The Process steps table needs 218.1 pt: its visible columns' 188 pt, their 25.6 pt of padding and rules and one grid step, more than its 200 pt.",
    );
    // Since #971 (d) judges the headings (design §7.2), and the steps' title spans the position, code
    // and instruction columns, so no heading word prints over the instruction alone: rule 9's
    // refusal is the one sentence, and (d) says nothing.
    expect(warnings(changed("table-steps", { box: box(200) }))).toEqual([]);
    expect(warnings(changed("table-steps", { box: box(400) }))).toEqual([]);
    expect(warnings(changed("table-steps", { box: box(564) }))).toEqual([]);
    // A fixed instruction width of 350.4 makes 538.4 declared + 25.6 = 564 printed: a 550 pt box is
    // warned, a 564 pt box is not. Rule 9 refuses both since #971 (568.5 with its grid step).
    const steps = standardLayout().items.find((i) => i.id === "table-steps") as Extract<CanvasItem, { kind: "table" }>;
    const columns = steps.columns.map((c) => (c.key === "step_instruction" ? { ...c, width: 350.4 } : c));
    expect(check(changed("table-steps", { columns, box: box(550) }))).toThrow(
      "The Process steps table needs 568.5 pt: its visible columns' 538.4 pt, their 25.6 pt of padding and rules and one grid step, more than its 550 pt.",
    );
    // No "*" column: no share for a heading to break in, so (d) says nothing; rule 9 refuses.
    expect(warnings(changed("table-steps", { columns, box: box(550) }))).toEqual([]);
    expect(warnings(changed("table-steps", { columns, box: box(564) }))).toEqual([]);
  });

  it("warns when a column table's printed width passes its drawn width: its shown columns and its layout's padding", () => {
    // The Part lines table's default columns, one of them flexible: the declared widths and the
    // ruled layout's padding over the shown columns. One narrower than the printed width is warned,
    // its figure the least width. Since #971 rule 9 refuses a box narrower than the printed width and
    // one grid step, so here the warning is reached only on a layout the validator refuses.
    const lines = standardLayout().items.find((i) => i.id === "table-lines") as Extract<CanvasItem, { kind: "table" }>;
    const declared = visibleColumnsWidth(TRAVELER_CONTRACT, lines);
    const printed = round2(declared + tableOverhead("ruled", lines.columns.length));
    const at = (w: number) => changed("table-lines", { box: { ...lines.box, w } });
    expect(check(at(declared))).toThrow(
      "The Part lines table needs 280.5 pt: its visible columns' 244 pt, their 32 pt of padding and rules and one grid step, more than its 244 pt.",
    );
    // Since #971 (d) states the headings (design §7.2): under the 316.86 pt its Part identity
    // column's "Description" heading word needs, it says so, here at a share of 0.
    expect(warnings(at(declared))).toEqual([{ itemIds: ["table-lines"], sentence: "The Part lines table: Part identity gets 0 pt, under the 40.86 pt its widest heading word needs, so its heading words break; its headings print whole from 316.86 pt wide." }]);
    // The literal: the traveler's Part lines table at its 244 pt declared width prints at least 276.
    expect(printed).toBe(276);
    expect(canvasTablePrintedWidth(TRAVELER_CONTRACT, lines, 8)).toEqual({ printed, flexible: true, copies: 1 });
    expect(warnings(at(316.86))).toEqual([]);
    // A hidden column takes no width and no padding.
    const hidden = lines.columns.map((c, i) => (i === lines.columns.length - 1 ? { ...c, visible: false } : c));
    const fewer = canvasTablePrintedWidth(TRAVELER_CONTRACT, { ...lines, columns: hidden }, 8)!;
    expect(fewer.printed).toBe(round2(visibleColumnsWidth(TRAVELER_CONTRACT, { ...lines, columns: hidden }) + tableOverhead("ruled", lines.columns.length - 1)));
    // The quantities at 495 print their headings whole (from 492.8), so (d) is silent.
    const quantities = standardLayout().items.find((i) => i.id === "table-quantities") as Extract<CanvasItem, { kind: "table" }>;
    const q495 = changed("table-quantities", { box: { ...quantities.box, w: 495 } });
    expect(canvasWarnings(q495, TRAVELER_CONTRACT, undefined, { fonts: TRAVELER_DEFAULT_CONFIG.fonts })
      .filter((w) => w.itemIds.includes("table-quantities"))).toEqual([]);
  });

  it("warns of a repeated page-top item whose ink meets the \"(continued)\" box, and of no other item (Ruling 16)", () => {
    // The box is at 24, 82, 60, 10 (the barcode, bottom 92, is the lowest repeated item); the free
    // page-top room left of the header fields and under the logo is x 24..120, y 64..140.
    expect(continuedBox(standardLayout())).toEqual({ x: 24, y: 82, w: 60, h: 10 });
    const over = text("rep", { x: 24, y: 75, w: 60, h: 12 }, TOP, true);
    expect(warnings(plus(over))).toEqual([{
      itemIds: ["rep"],
      sentence: 'The Text (text rep) repeats where "(continued)" prints on continuation pages, at the repeat band\'s ' +
        "bottom-left; the two print over each other.",
    }]);
    // Moved away (ending at 78, above 82), or touching the box's top edge (ending at 82): no warning.
    expect(warnings(plus(text("rep", { x: 24, y: 66, w: 60, h: 12 }, TOP, true)))).toEqual([]);
    expect(warnings(plus(text("rep", { x: 24, y: 70, w: 60, h: 12 }, TOP, true)))).toEqual([]);
    // Right of the box (from 84): no warning.
    expect(warnings(plus(text("rep", { x: 84, y: 75, w: 30, h: 12 }, TOP, true)))).toEqual([]);
    // The same item not repeated prints on page 1 alone, where "(continued)" does not: no warning.
    expect(warnings(plus(text("rep", { x: 24, y: 75, w: 60, h: 12 }, TOP, false)))).toEqual([]);
    // Judged by ink: a repeated frame whose edges stay clear of the box does not meet it (its left
    // edge at x 90 is right of 84), and one whose bottom edge runs through it (at 88) does.
    const frame = (box: CanvasBox): CanvasItem => ({ id: "frame", kind: "box", weight: 1, box, anchor: TOP, repeat: true });
    expect(warnings(plus(frame({ x: 90, y: 70, w: 20, h: 20 })))).toEqual([]);
    expect(warnings(plus(frame({ x: 30, y: 70, w: 70, h: 18 }))).map((w) => w.itemIds)).toEqual([["frame"]]);
  });

  it("the standard layout warns of nothing", () => {
    expect(canvasWarnings(standardLayout(), TRAVELER_CONTRACT)).toEqual([]);
    expect(canvasWarnings(standardLayout(), TRAVELER_CONTRACT, undefined, { pageFooter: true })).toEqual([]);
    expect(canvasWarnings(standardLayout(), TRAVELER_CONTRACT, undefined, { fonts: TRAVELER_DEFAULT_CONFIG.fonts })).toEqual([]);
  });
});

describe("the canvas rules on a shipping ticket (design 2026-11-08)", () => {
  /** The standard ticket layout with one item changed (by id), or with items added. */
  function ticketChanged(id: string, over: Partial<CanvasItem>): CanvasLayout {
    const layout = standardTicketLayout();
    expect(layout.items.some((i) => i.id === id)).toBe(true);
    return layoutOf(layout.items.map((i) => (i.id === id ? ({ ...i, ...over } as CanvasItem) : i)));
  }
  function ticketPlus(...items: CanvasItem[]): CanvasLayout {
    return layoutOf([...standardTicketLayout().items, ...items]);
  }
  /** The refusal of `layout` on `contract`: its sentence and ids, the layout refused with a TemplateConfigError. */
  function refusal(layout: CanvasLayout, contract: TemplateContract): { sentence: string; ids: string[] } {
    try {
      validateCanvasLayout(layout, contract);
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateConfigError);
      return { sentence: (error as Error).message, ids: (error as TemplateConfigError).itemIds };
    }
    return expect.fail("the layout was not refused");
  }
  const totalsRows = () => defaultTableColumns(SHIPPER_CONTRACT, "totals");

  for (const contract of [SHIPPER_CONTRACT, MOS_SHIPPER_CONTRACT]) {
    describe(contract.name, () => {
      it("the standard ticket layout passes every rule and no two drawn boxes overlap", () => {
        expect(() => validateCanvasLayout(standardTicketLayout(), contract)).not.toThrow();
        expect(canvasWarnings(standardTicketLayout(), contract)).toEqual([]);
      });
      it("an empty layout passes: the ticket requires nothing and places no table", () => {
        expect(() => validateCanvasLayout(layoutOf([]), contract)).not.toThrow();
        expect(canvasWarnings(layoutOf([]), contract)).toEqual([]);
        // A repeated item on a canvas with no table is judged against no first table.
        const alone = layoutOf([standardTicketLayout().items.find((i) => i.id === "field-order_no")!]);
        expect(() => validateCanvasLayout(alone, contract)).not.toThrow();
      });
      it("a barcode is refused: a shipping ticket prints none", () => {
        const code = barcode({ box: { x: 402, y: 300, w: 186, h: 44 }, repeat: false });
        expect(refusal(ticketPlus(code), contract)).toEqual({
          sentence: "The canvas has a barcode; a shipping ticket prints none.", ids: ["barcode"],
        });
      });
      it("a text block the contract lacks is refused by name, and the liability wording placed twice names both", () => {
        const cert = textBlock("cert_statement", { id: "tb-cert", box: { x: 24, y: 10, w: 200, h: 20 }, anchor: { kind: "below-table", table: "totals" } });
        expect(refusal(ticketPlus(cert), contract)).toEqual({
          sentence: `The wording with the key "cert_statement" (textBlock tb-cert) is not one the ${contract.name} contract has.`,
          ids: ["tb-cert"],
        });
        const again = textBlock("shipper_liability_text", { id: "tb-again", box: { x: 24, y: 700, w: 200, h: 20 }, anchor: { kind: "page-top" } });
        expect(refusal(ticketPlus(again), contract)).toEqual({
          sentence: "The Liability text wording is placed twice; a text block prints once.",
          ids: ["text-block-shipper_liability_text", "tb-again"],
        });
      });
      it("a text block over the schema's size is refused by its name, not as an anonymous item", () => {
        const big = textBlock("shipper_liability_text", { style: { size: 100, bold: false, align: "left" } });
        const layout = layoutOf([...standardTicketLayout().items.filter((i) => i.id !== big.id), big]);
        const refused = canvasRefusal(layout, SHIPPER_CONTRACT);
        expect(refused?.itemIds).toEqual([big.id]);
        expect(refused?.sentence.startsWith("The Liability text wording is not drawn as the canvas allows:")).toBe(true);
      });
      it("the totals block names a row twice: the rows wording of the twice sentence", () => {
        const twice = [...totalsRows(), { key: "total_qty", visible: true, label: null, width: null }];
        expect(refusal(ticketChanged("table-totals", { columns: twice }), SHIPPER_CONTRACT)).toEqual({
          sentence: 'The Totals table names the row "total_qty" twice.', ids: ["table-totals"],
        });
      });
      it("the totals block's rows: a row with a width and a missing row are refused", () => {
        const widened = totalsRows().map((r) => (r.key === "total_tare" ? { ...r, width: 80 } : r));
        expect(refusal(ticketChanged("table-totals", { columns: widened }), contract)).toEqual({
          sentence: "The Totals table's Tare row carries a width (80 pt); a row has no width.", ids: ["table-totals"],
        });
        const short = totalsRows().filter((r) => r.key !== "total_gross");
        expect(refusal(ticketChanged("table-totals", { columns: short }), contract)).toEqual({
          sentence: "The Totals table is missing its Gross weight row.", ids: ["table-totals"],
        });
        const extra = [...totalsRows(), { key: "line_qty", visible: true, label: null, width: null }];
        expect(refusal(ticketChanged("table-totals", { columns: extra }), contract).sentence)
          .toBe('The Totals table names a row "line_qty" that is not one of its rows.');
        const hidden = totalsRows().map((r) => (r.key === "total_tare" ? { ...r, visible: false } : r));
        expect(() => validateCanvasLayout(ticketChanged("table-totals", { columns: hidden }), contract)).not.toThrow();
      });
      it("the containers table prints twice: its visible columns twice over must fit its box", () => {
        const at = (w: number) => ticketChanged("table-containers", { box: { x: 24, y: 208, w, h: 30 } });
        expect(refusal(at(352), contract)).toEqual({
          sentence: "The Containers table needs 352.5 pt: its visible columns' 142 pt and their 32 pt of padding and rules, " +
            "printed twice, and one grid step, more than its 352 pt.",
          ids: ["table-containers"],
        });
        expect(() => validateCanvasLayout(at(352.5), contract)).not.toThrow();
        expect(() => validateCanvasLayout(at(564), contract)).not.toThrow();
        // A table printed once keeps its one-copy sentence.
        expect(refusal(ticketChanged("table-lines", { box: { x: 24, y: 172, w: 150, h: 30 } }), contract).sentence)
          .toBe("The Part lines table needs 188.5 pt: its visible columns' 160 pt, their 24 pt of padding and rules and one grid step, more than its 150 pt.");
      });
      it("the containers table's printed width is judged per copy, and its shared columns by their headings alone (R-C)", () => {
        const fonts = defaultConfigFor(contract.docType).fonts;
        const containers = ticketTable("containers");
        const at = (w: number, columns = containers.columns) =>
          ticketChanged("table-containers", { columns, box: { ...containers.box, w } });
        // The Standard's fonts unless others are named; `null` judges with no fonts at all.
        const warned = (layout: CanvasLayout, f: FontsConfig | null = fonts) =>
          canvasWarnings(layout, contract, undefined, f === null ? undefined : { fonts: f });
        // One copy: the two fixed columns and the ruled padding of the four shown columns.
        const perCopy = 80 + 62 + tableOverhead("ruled", 4);
        expect(canvasTablePrintedWidth(contract, containers, fonts.baseSize)).toEqual({ printed: perCopy, flexible: true, copies: 2 });
        // Since #971 (d) states the headings (design §7.2): below 503.66, the width at which each copy's
        // Containers and Tare columns hold the 38.91 pt "Containers" heading word, the two-copies
        // sentence, and no shared-width line beside it (a warning never repeats). 300 wide, which rule
        // 9 refuses (352.5), leaves them nothing; 400, 13 pt each.
        expect(() => validateCanvasLayout(at(300), contract)).toThrow("needs 352.5 pt");
        const headings = (w: number) => ({
          itemIds: ["table-containers"],
          sentence: `The Containers table prints its columns twice: ${sharedWidthWords(["Containers", "Tare"], Math.max(0, (w / 2 - perCopy) / 2))} ` +
            "per copy, under the 38.91 pt its widest heading word needs, so its heading words break; its headings print whole from " +
            "251.83 pt each copy, 503.66 pt in all.",
        });
        expect(headings(300).sentence).toContain("Containers and Tare get 0 pt each per copy");
        expect(warned(at(300))).toEqual([headings(300)]);
        expect(warned(at(300), null)).toEqual([headings(300)]);
        expect(headings(400).sentence).toContain("Containers and Tare get 13 pt each per copy");
        expect(warned(at(400))).toEqual([headings(400)]);
        // 503.75 prints the headings whole: each shared column gets 38.94 pt per copy, over the 38.91 "Containers" needs.
        expect(headings(503.75).sentence).toContain("Containers and Tare get 38.94 pt each per copy");
        expect(warned(at(503.75))).toEqual([]);
        const fixedLabel = containers.columns.map((c) => (c.key === "container_type" ? { ...c, label: "Type" } : c));
        expect(warned(at(503.75, fixedLabel))).toEqual([]);
        // Tare hidden: one shared column, its headings whole from 2 × (142 + 24 + 38.91) = 409.83, and nothing said at 409.9.
        const tareHidden = containers.columns.map((c) => (c.key === "container_tare" ? { ...c, visible: false, label: "Tare (lb)" } : c));
        expect(warned(at(409.9, tareHidden))).toEqual([]);
        // Full width: 54 pt each.
        expect(warned(at(564))).toEqual([]);
        // A list and a rows block print no columns: no width, no share.
        expect(canvasTablePrintedWidth(contract, ticketTable("totals"), 8)).toBeNull();
        expect(canvasTablePrintedWidth(contract, ticketTable("serials"), 8)).toBeNull();
        // Since #971 the Part lines' "Description" heading word (40.86) passes the line, so (d) speaks
        // wherever their share is under it; the field strip's widest, "Purchase" (33.72), does not:
        // 36 pt each prints its headings whole.
        const strip = ticketTable("field_strip");
        const stripPrinted = canvasTablePrintedWidth(contract, strip, fonts.baseSize)!.printed;
        const narrow = ticketChanged("table-field_strip", { box: { ...strip.box, w: stripPrinted + 72 } });
        expect(warned(narrow).filter((w) => w.itemIds.includes("table-field_strip"))).toEqual([]);
      });
      it("the standard ticket layout warns of nothing with the Standard's fonts", () => {
        expect(canvasWarnings(standardTicketLayout(), contract, undefined, { fonts: defaultConfigFor(contract.docType).fonts })).toEqual([]);
      });
      it("a table the profile lacks is refused", () => {
        expect(refusal(ticketPlus(ticketTable("totals", { id: "q", key: "quantities", box: { x: 24, y: 600, w: 564, h: 30 }, columns: [] })), contract)).toEqual({
          sentence: `The table "quantities" is not one the ${contract.name} contract places on a canvas.`, ids: ["q"],
        });
      });
      it("the floors are the measured ones: the first table's room, and a table shorter than a row is refused", () => {
        expect(firstTableRoom(contract)).toBe(TICKET_FIRST_TABLE_ROOM);
        expect(contract.canvas?.rowFloor).toBe(TICKET_ROW_FLOOR);
        const thin = TICKET_ROW_FLOOR - 1;
        expect(refusal(ticketChanged("table-serials", { box: { x: 24, y: 244, w: 564, h: thin } }), contract)).toEqual({
          sentence: `The Serial numbers table is drawn ${thin} pt tall; a table's box is at least ${TICKET_ROW_FLOOR} pt, one row.`,
          ids: ["table-serials"],
        });
        // The first table too low for its heading and one row above the page's foot.
        const low = layoutOf([ticketTable("field_strip", { box: { x: 24, y: 768 - TICKET_FIRST_TABLE_ROOM + 1, w: 564, h: TICKET_ROW_FLOOR } })]);
        expect(refusal(low, contract).sentence).toContain(`too low for its heading and one row (${TICKET_FIRST_TABLE_ROOM} pt) above 768`);
      });
      it("canvasFieldKeys: the header, party and strip fields, never the serial list's heading, the totals' rows or a column", () => {
        const keys = canvasFieldKeys(contract);
        for (const key of ["company_name", "sold_to", "tear_sold_to"]) expect(keys.has(key)).toBe(true);
        for (const key of ["serials", "total_qty", "line_qty"]) expect(keys.has(key)).toBe(false);
      });
    });
  }

  it("an empty layout on the traveler is refused by its missing barcode, not a TypeError", () => {
    expect(() => validateCanvasLayout(layoutOf([]), TRAVELER_CONTRACT)).toThrow(TemplateConfigError);
    expect(() => validateCanvasLayout(layoutOf([]), TRAVELER_CONTRACT)).toThrow("The canvas has no barcode");
  });
  it("defaultTableColumns: a rows block's rows in contract order, the serial list none, the strip its five columns", () => {
    const row = (key: string) => ({ key, visible: true, label: null, width: null });
    expect(defaultTableColumns(SHIPPER_CONTRACT, "totals"))
      .toEqual(["shipped_complete", "total_qty", "total_weight", "total_tare", "total_gross"].map(row));
    expect(defaultTableColumns(SHIPPER_CONTRACT, "serials")).toEqual([]);
    expect(defaultTableColumns(SHIPPER_CONTRACT, "field_strip"))
      .toEqual(["po_number", "packing_list_no", "customer_job_no", "route", "carrier"].map(row));
    expect(visibleColumnsWidth(SHIPPER_CONTRACT, ticketTable("totals"))).toBe(0);
  });
  it("tableSpec answers the profile's entry; a contract with no profile requires nothing and places no field", () => {
    expect(tableSpec(SHIPPER_CONTRACT, "totals")).toEqual({ key: "totals", keyed: "section", heading: null, rows: true, printed: null });
    expect(tableSpec(SHIPPER_CONTRACT, "serials")).toEqual({ key: "serials", keyed: "section", heading: "serials", rows: false, printed: null });
    expect(isRequired({ kind: "barcode" }, testContract())).toBe(false);
    expect(isRequired({ kind: "barcode" }, SHIPPER_CONTRACT)).toBe(false);
    expect(canvasFieldKeys(testContract()).size).toBe(0);
    expect(canvasWarnings(standardTicketLayout(), testContract())).toEqual([]);
  });
  it("the registry: a ticket layout prints (both ticket types), and so does a quotation's (since quote canvas PR 2)", () => {
    expect(validateConfig("SHIPPER", { ...SHIPPER_DEFAULT_CONFIG, layout: standardTicketLayout() }).layout)
      .toEqual(standardTicketLayout());
    expect(validateConfig("MOS_SHIPPER", { ...MOS_SHIPPER_DEFAULT_CONFIG, layout: standardTicketLayout() }).layout)
      .toEqual(standardTicketLayout());
    // Reds when "QUOTE" leaves CANVAS_PRINTS: the registry then refuses it in the later-release sentence.
    expect(validateConfig("QUOTE", { ...defaultConfigFor("QUOTE"), layout: standardQuoteLayout() }).layout)
      .toEqual(standardQuoteLayout());
  });
});

describe("the registry's later-release gate", () => {
  it("accepts an invoice's layout and runs the rules (design 2026-11-10 §7)", () => {
    // Reds when "INVOICE" leaves CANVAS_PRINTS (Task 1 Step 5): the registry then refuses the layout
    // in the later-release sentence.
    const layout = standardInvoiceLayout();
    expect(INVOICE_CONTRACT.canvas).toBeDefined();
    expect(validateConfig("INVOICE", { ...defaultConfigFor("INVOICE"), layout }).layout).toEqual(layout);
    expect(validateConfig("INVOICE", { ...defaultConfigFor("INVOICE"), layout: layoutOf([]) }).layout).toEqual(layoutOf([]));
    expect(() => validateConfig("INVOICE", { ...defaultConfigFor("INVOICE"), layout: layoutOf([...standardInvoiceLayout().items, barcode()]) }))
      .toThrow("The canvas has a barcode; an invoice prints none.");
    expect(canvasPrints("INVOICE")).toBe(true);
    expect(assertCanvasPrints("INVOICE")).toBe(INVOICE_CONTRACT.canvas);
    expect(normalizeStoredConfig("INVOICE", { ...defaultConfigFor("INVOICE"), layout }).layout).toEqual(layout);
    // A null layout is the flow paper, which the gate never judges.
    expect(validateConfig("INVOICE", { ...defaultConfigFor("INVOICE"), layout: null }).layout).toBeNull();
  });
  it("accepts a statement's layout and runs the rules (design 2026-11-11 §7)", () => {
    // Reds when "STATEMENT" leaves CANVAS_PRINTS: the registry then refuses the layout
    // in the later-release sentence.
    const layout = standardStatementLayout();
    expect(STATEMENT_CONTRACT.canvas).toBeDefined();
    expect(validateConfig("STATEMENT", { ...defaultConfigFor("STATEMENT"), layout }).layout).toEqual(layout);
    expect(validateConfig("STATEMENT", { ...defaultConfigFor("STATEMENT"), layout: layoutOf([]) }).layout).toEqual(layoutOf([]));
    expect(() => validateConfig("STATEMENT", { ...defaultConfigFor("STATEMENT"), layout: layoutOf([...standardStatementLayout().items, barcode()]) }))
      .toThrow("The canvas has a barcode; a statement prints none.");
    expect(canvasPrints("STATEMENT")).toBe(true);
    expect(assertCanvasPrints("STATEMENT")).toBe(STATEMENT_CONTRACT.canvas);
    expect(normalizeStoredConfig("STATEMENT", { ...defaultConfigFor("STATEMENT"), layout }).layout).toEqual(layout);
    // A null layout is the flow paper, which the gate never judges.
    expect(validateConfig("STATEMENT", { ...defaultConfigFor("STATEMENT"), layout: null }).layout).toBeNull();
  });
  it("accepts a quotation's layout and runs the rules (design 2026-11-12 §7; since quote canvas PR 2)", () => {
    // Reds when "QUOTE" leaves CANVAS_PRINTS: the registry then refuses the layout in the
    // later-release sentence.
    const layout = standardQuoteLayout();
    expect(QUOTE_CONTRACT.canvas).toBeDefined();
    expect(validateConfig("QUOTE", { ...defaultConfigFor("QUOTE"), layout }).layout).toEqual(layout);
    expect(validateConfig("QUOTE", { ...defaultConfigFor("QUOTE"), layout: layoutOf([]) }).layout).toEqual(layoutOf([]));
    expect(() => validateConfig("QUOTE", { ...defaultConfigFor("QUOTE"), layout: layoutOf([...standardQuoteLayout().items, barcode()]) }))
      .toThrow("The canvas has a barcode; a quote prints none.");
    expect(canvasPrints("QUOTE")).toBe(true);
    expect(assertCanvasPrints("QUOTE")).toBe(QUOTE_CONTRACT.canvas);
    expect(normalizeStoredConfig("QUOTE", { ...defaultConfigFor("QUOTE"), layout }).layout).toEqual(layout);
    // A null layout is the flow paper, which the gate never judges.
    expect(validateConfig("QUOTE", { ...defaultConfigFor("QUOTE"), layout: null }).layout).toBeNull();
  });
  it("the gate's two refusals are reached only through the stubbed docType, every real one printing, the quotation's included", () => {
    // Every docType has a profile and is in CANVAS_PRINTS since quote canvas PR 2, so the later-release
    // sentence is reached only through the stub given a profile (the certification's), and the
    // no-profile sentence through the stub without one (tests/helpers/test-contract.ts). Red when
    // `assertCanvasPrints`' set check is deleted (the stub given a profile is then accepted) and when
    // `withTestContract` ignores its `canvas` option (the stub then answers the no-profile sentence).
    withTestContract(() => {
      expect(canvasPrints(TEST_DOC_TYPE)).toBe(false);
      expect(() => assertCanvasPrints(TEST_DOC_TYPE))
        .toThrow("The Test template's canvas prints in a later release; it keeps its sections until then.");
      expect(() => validateConfig(TEST_DOC_TYPE, { ...defaultConfigFor(TEST_DOC_TYPE), layout: layoutOf([]) }))
        .toThrow("The Test template's canvas prints in a later release; it keeps its sections until then.");
    }, { canvas: CERT_CONTRACT.canvas });
    // Without a profile the gate refuses in the profile's own sentence, before the set is asked.
    withTestContract(() => expect(() => assertCanvasPrints(TEST_DOC_TYPE)).toThrow("The Test template offers no canvas; it keeps its sections."));
    // Every real docType, named: the loop's list is the registry's whole list, the container tag's
    // included since container tag PR 3 put it in CANVAS_PRINTS, and each answers its profile.
    const printing = ["TRAVELER", "SHIPPER", "MOS_SHIPPER", "BOL", "CERT", "INVOICE", "STATEMENT", "QUOTE", "CONTAINER_TAG"] as const;
    expect(TEMPLATE_DOC_TYPES).toEqual([...printing]);
    for (const docType of printing) {
      expect(assertCanvasPrints(docType), docType).toBe(contractFor(docType).canvas);
      expect(canvasPrints(docType), docType).toBe(true);
    }
  });
  it("the stubbed docType leaves the registry as it found it, a case that throws included", async () => {
    // Each row is checked on its own line, so each of the helper's three deletes reds its own row.
    const present = () => Object.hasOwn(CONTRACTS, "TEST");
    expect(present()).toBe(false);
    // A synchronous throw.
    expect(() => withTestContract(() => { throw new Error("boom"); })).toThrow("boom");
    expect(present()).toBe(false);
    // A plain return.
    expect(withTestContract(() => 1)).toBe(1);
    expect(present()).toBe(false);
    // An async run, registered while it runs and deleted once it settles.
    await withTestContract(async () => {
      await Promise.resolve();
      expect(present()).toBe(true);
    });
    expect(present()).toBe(false);
    // An async run that rejects.
    await expect(withTestContract(async () => { throw new Error("late"); })).rejects.toThrow("late");
    expect(present()).toBe(false);
    // A call made while the key is present throws, before it registers, and leaves the outer's key in place.
    expect(withTestContract(() => {
      expect(() => withTestContract(() => 2)).toThrow("CONTRACTS.TEST is already registered");
      return present();
    })).toBe(true);
    expect(present()).toBe(false);
  });
  it("the standard invoice fixture passes every rule and warns of nothing (design 2026-11-10 §6)", () => {
    // Called on the contract directly, as every lane's fixture case is (the registry's half is the
    // case above).
    const layout = standardInvoiceLayout();
    expect(() => validateCanvasLayout(layout, INVOICE_CONTRACT)).not.toThrow();
    expect(canvasRefusal(layout, INVOICE_CONTRACT, { pageFooter: false })).toBeNull();
    expect(canvasWarnings(layout, INVOICE_CONTRACT)).toEqual([]);
  });
  it("the standard statement fixture passes every rule and warns of nothing (design 2026-11-11 §6)", () => {
    // Called on the contract directly, as every lane's fixture case is (the registry's half is the
    // statement's acceptance case above).
    const layout = standardStatementLayout();
    expect(() => validateCanvasLayout(layout, STATEMENT_CONTRACT)).not.toThrow();
    expect(canvasRefusal(layout, STATEMENT_CONTRACT, { pageFooter: false })).toBeNull();
    expect(canvasWarnings(layout, STATEMENT_CONTRACT)).toEqual([]);
  });
  it("the standard quote fixture passes every rule and warns of nothing (design 2026-11-12 §6)", () => {
    // Called on the contract directly, as every lane's fixture case is (the registry's half is the
    // quotation's acceptance case above). The quote's Standard has the page line on, so both are judged.
    const layout = standardQuoteLayout();
    expect(() => validateCanvasLayout(layout, QUOTE_CONTRACT)).not.toThrow();
    expect(() => validateCanvasLayout(layout, QUOTE_CONTRACT, { pageFooter: true })).not.toThrow();
    expect(canvasRefusal(layout, QUOTE_CONTRACT, { pageFooter: false })).toBeNull();
    expect(canvasRefusal(layout, QUOTE_CONTRACT, { pageFooter: true })).toBeNull();
    expect(canvasWarnings(layout, QUOTE_CONTRACT)).toEqual([]);
    expect(canvasWarnings(layout, QUOTE_CONTRACT, undefined, { pageFooter: true })).toEqual([]);
  });
});

describe("the canvas rules on a bill of lading (design 2026-11-09 §6)", () => {
  function refusal(layout: CanvasLayout): { sentence: string; ids: string[] } {
    try {
      validateCanvasLayout(layout, BOL_CONTRACT);
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateConfigError);
      return { sentence: (error as Error).message, ids: (error as TemplateConfigError).itemIds };
    }
    return expect.fail("the layout was not refused");
  }
  /** The standard layout with one item changed (by id). */
  function bolChanged(id: string, over: Partial<CanvasItem>): CanvasLayout {
    const layout = standardBolLayout();
    expect(layout.items.some((i) => i.id === id)).toBe(true);
    return layoutOf(layout.items.map((i) => (i.id === id ? ({ ...i, ...over } as CanvasItem) : i)));
  }
  const name = (key: string) => BOL_CONTRACT.sections.flatMap((s) => s.fields).find((f) => f.key === key)!.name;

  it("the standard layout passes every rule and warns of nothing; an empty layout passes (nothing is required, §4.3)", () => {
    expect(() => validateCanvasLayout(standardBolLayout(), BOL_CONTRACT)).not.toThrow();
    expect(canvasWarnings(standardBolLayout(), BOL_CONTRACT)).toEqual([]);
    expect(() => validateCanvasLayout(layoutOf([]), BOL_CONTRACT)).not.toThrow();
  });
  it("a barcode is refused by name: a bill of lading prints none", () => {
    expect(refusal(layoutOf([...standardBolLayout().items, barcode()]))).toEqual({
      sentence: "The canvas has a barcode; a bill of lading prints none.", ids: ["barcode"],
    });
  });
  it("canvasFieldKeys: the seventeen fields, never a block's key, its heading or its toggle", () => {
    expect([...canvasFieldKeys(BOL_CONTRACT)].sort()).toEqual([
      "original_label", "title", "pro_number", "bol_number", "scac_code", "carrier_name", "ship_from", "consigned_to",
      "destination", "destination_state", "destination_zip", "delivering_carrier", "vehicle_initials", "vehicle_no",
      "shipper_per", "agent_per", "po_address",
    ].sort());
    for (const key of ["consignee_ref", "trv_no", "collect_checkbox"]) {
      const item = bolField(key, { box: { x: 24, y: 300, w: 200, h: 12 } });
      expect(refusal(layoutOf([...standardBolLayout().items, item]))).toEqual({
        sentence: `The ${name(key)} field is not one the Bill of lading contract places on a canvas.`, ids: [item.id],
      });
    }
  });
  it("the TRV and consignee's ref/PO blocks have no columns, nothing is required, and a cleared page is empty", () => {
    expect(defaultTableColumns(BOL_CONTRACT, "trv")).toEqual([]);
    expect(defaultTableColumns(BOL_CONTRACT, "consignee_ref")).toEqual([]);
    expect(clearedLayout(BOL_CONTRACT)).toEqual({ version: 1, items: [] });
    for (const key of ["consignee_ref", "trv", "freight"]) expect(isRequired({ kind: "table", key }, BOL_CONTRACT)).toBe(false);
  });
  it("rule 8: the first block too low for its heading and one row above the page's foot is refused by name", () => {
    expect(firstTableRoom(BOL_CONTRACT)).toBe(BOL_FIRST_TABLE_ROOM);
    const low = bolTable("consignee_ref", { box: { x: 338, y: 768 - BOL_FIRST_TABLE_ROOM + 1, w: 244, h: BOL_ROW_FLOOR } });
    const refused = refusal(layoutOf([low]));
    expect(refused.ids).toEqual([low.id]);
    expect(refused.sentence).toBe(
      `The Consignee's ref/PO table starts at ${low.box.y} pt, too low for its heading and one row ` +
      `(${BOL_FIRST_TABLE_ROOM} pt) above 768.`,
    );
  });
  it("rule 8: the first block at exactly its heading and one row above the page's foot is accepted", () => {
    const edge = bolTable("consignee_ref", { box: { x: 338, y: 768 - BOL_FIRST_TABLE_ROOM, w: 244, h: BOL_ROW_FLOOR } });
    expect(() => validateCanvasLayout(layoutOf([edge]), BOL_CONTRACT)).not.toThrow();
  });
  it("rule 3: the BOL number repeats only ending at least one grid step above the first block's top (§4.4)", () => {
    const top = standardBolLayout().items.find((i) => i.id === "table-consignee_ref")!.box.y;
    const at = (bottom: number) => bolChanged("field-bol_number", { box: { x: 338, y: bottom - 12, w: 244, h: 12 } });
    const refused = refusal(at(top - 3));
    expect(refused.sentence).toContain(`less than one grid step (${CANVAS_GRID} pt) above the first table's top`);
    expect(refused.ids).toEqual(["field-bol_number", "table-consignee_ref"]);
    expect(() => validateCanvasLayout(at(top - CANVAS_GRID), BOL_CONTRACT)).not.toThrow();
  });

  // A field-keyed block is named by its field in every sentence (design 2026-11-09 §11): only the
  // consignee's ref/PO block tells `tableName` from the section-name lookup it replaced, since the
  // TRV and freight blocks are keyed by sections of their own names.
  const BELOW_REF: CanvasAnchor = { kind: "below-table", table: "consignee_ref" };
  it("tableName: a field-keyed block by its field's name", () => {
    expect(tableName(BOL_CONTRACT, "consignee_ref")).toBe("Consignee's ref/PO");
  });
  it("tableName: a section-keyed table by its section's name, the key when the contract has neither", () => {
    expect(tableName(BOL_CONTRACT, "trv")).toBe("TRV numbers");
    expect(tableName(BOL_CONTRACT, "freight")).toBe("Freight");
    expect(tableName(TRAVELER_CONTRACT, "steps")).toBe(TRAVELER_CONTRACT.sections.find((s) => s.key === "steps")!.name);
    expect(tableName(TRAVELER_CONTRACT, "nonsense")).toBe("nonsense");
  });
  it("an item anchored below the unplaced consignee's ref/PO block names the block by its field", () => {
    const scac = bolField("scac_code", { anchor: BELOW_REF });
    expect(refusal(layoutOf([bolTable("trv"), scac]))).toEqual({
      sentence: "The Carrier's SCAC code field is anchored below the Consignee's ref/PO table, which the canvas does not place.",
      ids: [scac.id],
    });
  });
  it("the consignee's ref/PO block placed twice is refused by its field's name, naming both", () => {
    const again = bolTable("consignee_ref", { id: "t2" });
    expect(refusal(layoutOf([bolTable("consignee_ref"), again]))).toEqual({
      sentence: "The Consignee's ref/PO table is placed twice; a table prints once.", ids: ["table-consignee_ref", again.id],
    });
  });
  it("the consignee's ref/PO block drawn under one row is refused by its field's name", () => {
    const thin = bolTable("consignee_ref", { box: { x: 338, y: 57, w: 244, h: 4 } });
    expect(refusal(layoutOf([thin]))).toEqual({
      sentence: `The Consignee's ref/PO table is drawn 4 pt tall; a table's box is at least ${BOL_ROW_FLOOR} pt, one row.`,
      ids: [thin.id],
    });
  });
  const refBottom = bolTable("consignee_ref").box.y + BOL_ROW_FLOOR;
  it.each<{ rule: string; judge: () => { sentence: string; ids: string[] }; clause: string; ids: string[] }>([
    {
      rule: "rule 3: the block set to repeat",
      judge: () => refusal(layoutOf([bolTable("consignee_ref", { repeat: true })])),
      clause: "The Consignee's ref/PO table is set to repeat on every page; a table prints once, where it is drawn.",
      ids: ["table-consignee_ref"],
    },
    {
      rule: "rule 3: an item below the block that repeats",
      judge: () => refusal(layoutOf([
        bolTable("consignee_ref"),
        bolField("scac_code", { anchor: BELOW_REF, box: { x: 338, y: 4, w: 244, h: 12 }, repeat: true }),
      ])),
      clause: "repeats on every page but is anchored below the Consignee's ref/PO table; only an item at the page's top repeats.",
      ids: ["field-scac_code"],
    },
    {
      rule: "rule 4: an offset below the block under 0",
      judge: () => refusal(layoutOf([
        bolTable("consignee_ref"), bolField("scac_code", { anchor: BELOW_REF, box: { x: 338, y: -4.5, w: 244, h: 12 } }),
      ])),
      clause: "its offset below the Consignee's ref/PO table is -4.5 pt, under 0",
      ids: ["field-scac_code"],
    },
    {
      rule: "rule 5: the block and the TRV block overlap",
      // The TRV block starts inside the consignee's ref/PO block (its top .. refBottom), so the block is
      // the one above and the sentence opens with it.
      judge: () => {
        expect(60).toBeLessThan(refBottom);
        return refusal(layoutOf([bolTable("consignee_ref"), bolTable("trv", { box: { x: 24, y: 60, w: 564, h: BOL_ROW_FLOOR } })]));
      },
      clause: "The Consignee's ref/PO table and the TRV numbers table overlap",
      ids: ["table-consignee_ref", "table-trv"],
    },
    {
      rule: "rule 8: the region after the block taller than a page holds",
      judge: () => refusal(layoutOf([
        bolTable("consignee_ref"), bolField("scac_code", { anchor: BELOW_REF, box: { x: 338, y: 0, w: 244, h: 760 } }),
      ])),
      clause: "The region after the Consignee's ref/PO table is",
      // The region's ids are the block's, not the tall item's.
      ids: ["table-consignee_ref"],
    },
    {
      rule: "warning (a): a page-top field drawn across the block",
      judge: () => {
        const layout = layoutOf([bolTable("consignee_ref"), bolField("scac_code", { box: { x: 338, y: 57, w: 244, h: 12 } })]);
        const found = canvasWarnings(layout, BOL_CONTRACT)
          .filter((w) => w.itemIds.includes("table-consignee_ref") && w.itemIds.includes("field-scac_code"));
        expect(found).toHaveLength(1);
        return { sentence: found[0].sentence, ids: found[0].itemIds };
      },
      clause: "The Consignee's ref/PO table and the Carrier's SCAC code field overlap",
      ids: ["table-consignee_ref", "field-scac_code"],
    },
  ])("$rule names the consignee's ref/PO block by its field", ({ judge, clause, ids }) => {
    const { sentence, ids: named } = judge();
    expect(sentence).toContain(clause);
    expect(named).toEqual(ids);
  });

  // A block's toggles ride its columns (design 2026-11-09 §4.1 addition 3): the freight block's
  // Collect checkbox is an entry of its columns, shown, hidden or relabelled, never given a width.
  // Each layout below names the toggle literally (`freightWith`), never through `bolTable`'s
  // `defaultTableColumns`, so a case cannot pass because the toggle is simply not there.
  const COLLECT: CanvasColumn = { key: "collect_checkbox", visible: true, label: null, width: null };
  /** The freight block's five contract columns, read from the contract, never from `tableFields`. */
  const freightColumns = (): CanvasColumn[] => BOL_CONTRACT.sections.flatMap((s) => s.fields)
    .filter((f) => f.column?.table === "freight")
    .map((f) => ({ key: f.key, visible: true, label: null, width: null }));
  /** The standard layout with the freight block's columns set to its five and then `extra`. */
  const freightWith = (...extra: CanvasColumn[]) => bolChanged("table-freight", { columns: [...freightColumns(), ...extra] });

  it("defaultTableColumns: the freight block's five columns in contract order, then its shown toggle", () => {
    expect(freightColumns().map((c) => c.key)).toEqual([
      "package_count", "freight_description", "freight_weight", "freight_class", "check_column",
    ]);
    expect(defaultTableColumns(BOL_CONTRACT, "freight")).toEqual([...freightColumns(), COLLECT]);
  });
  it("the freight block with its toggle hidden passes every rule (rule 9 finds the hidden toggle among the block's own entries)", () => {
    expect(() => validateCanvasLayout(freightWith({ ...COLLECT, visible: false }), BOL_CONTRACT)).not.toThrow();
  });
  it("rule 9: a toggle that cannot be hidden, hidden, is refused as a toggle", () => {
    // A copy of the contract whose Collect checkbox is locked: the real one is removable.
    const locked = structuredClone(BOL_CONTRACT);
    for (const section of locked.sections) {
      for (const f of section.fields) if (f.key === "collect_checkbox") f.removable = false;
    }
    expect(() => validateCanvasLayout(freightWith(COLLECT), locked)).not.toThrow();
    expect(() => validateCanvasLayout(freightWith({ ...COLLECT, visible: false }), locked))
      .toThrow("The Freight table hides its Collect checkbox toggle. It cannot be hidden.");
  });
  it("the freight block with its toggle relabelled passes every rule", () => {
    expect(() => validateCanvasLayout(freightWith({ ...COLLECT, label: "COLLECT?" }), BOL_CONTRACT)).not.toThrow();
  });
  it("rule 1: the freight block missing its toggle is refused by the toggle's name", () => {
    expect(refusal(freightWith())).toEqual({
      sentence: "The Freight table is missing its Collect checkbox toggle.", ids: ["table-freight"],
    });
  });
  it("rule 1: the freight block naming its toggle twice is refused as a toggle", () => {
    expect(refusal(freightWith(COLLECT, COLLECT))).toEqual({
      sentence: 'The Freight table names the toggle "collect_checkbox" twice.', ids: ["table-freight"],
    });
  });
  it("rule 1: the freight block's toggle given a width is refused; a toggle has no width", () => {
    expect(refusal(freightWith({ ...COLLECT, width: 40 }))).toEqual({
      sentence: "The Freight table's Collect checkbox toggle carries a width (40 pt); a toggle has no width.",
      ids: ["table-freight"],
    });
  });
  it("rule 1: a key that is not one of the block's entries keeps the column sentence", () => {
    expect(refusal(freightWith(COLLECT, { key: "scac_code", visible: true, label: null, width: null }))).toEqual({
      sentence: 'The Freight table names a column "scac_code" that is not one of its columns.', ids: ["table-freight"],
    });
  });
  it("visibleColumnsWidth: the toggle counts 0", () => {
    expect(visibleColumnsWidth(BOL_CONTRACT, bolTable("freight"))).toBe(40 + 62 + 44 + 42);
    expect(visibleColumnsWidth(BOL_CONTRACT, { ...bolTable("freight"), columns: [...freightColumns(), COLLECT] }))
      .toBe(40 + 62 + 44 + 42);
  });

  // The wordings the freight block prints itself (its spec's `textBlocks`, design 2026-11-09 §4.1
  // addition 4) are edited on the Wording tab and never placed as items: rule 2 refuses one by name,
  // whether or not the freight block is placed.
  it.each([
    ["bol_section_7_text", "Section 7 clause"],
    ["bol_no_delivery_text", "No-delivery clause"],
    ["bol_imprint_text", "Imprint note"],
  ])("rule 2: the %s wording the freight block prints is refused as an item", (key, blockName) => {
    expect(BOL_CONTRACT.textBlocks.find((b) => b.key === key)?.name).toBe(blockName);
    const sentence =
      `The ${blockName} wording prints inside the Freight table; it is edited on the Wording tab, never placed on its own.`;
    const hung = bolTextBlock(key, { box: { x: 24, y: 64, w: 564, h: 24 } });
    expect(refusal(layoutOf([...standardBolLayout().items, hung]))).toEqual({ sentence, ids: [hung.id] });
    const alone = bolTextBlock(key, { anchor: { kind: "page-top" }, box: { x: 24, y: 300, w: 564, h: 24 } });
    expect(refusal(layoutOf([alone]))).toEqual({ sentence, ids: [alone.id] });
  });
  it("rule 2: the Section 7 clause placed twice is refused as printing inside the Freight table, naming the first", () => {
    const first = bolTextBlock("bol_section_7_text", { box: { x: 24, y: 64, w: 564, h: 24 } });
    const again = bolTextBlock("bol_section_7_text", { id: "again", box: { x: 24, y: 100, w: 564, h: 24 } });
    expect(first.id).not.toBe(again.id);
    expect(refusal(layoutOf([...standardBolLayout().items, first, again]))).toEqual({
      sentence: "The Section 7 clause wording prints inside the Freight table; it is edited on the Wording tab, never placed on its own.",
      ids: [first.id],
    });
  });

  // Every item keeps its least width (design 2026-11-09 §4.1 additions 2 and 5): a field, a list or
  // a rows block its `leastWidths` entry (rule 4), a column table its visible columns times its copies
  // and the points it keeps beside them (rule 9). An item with no entry keeps no floor here.
  /** The freight block's columns with the description drawn at `width` and the toggle shown. */
  const freightDescribedAt = (width: number): CanvasColumn[] => [
    ...freightColumns().map((c) => (c.key === "freight_description" ? { ...c, width } : c)), COLLECT,
  ];
  const freightBox = (w: number) => ({ x: 24, y: 206, w, h: BOL_ROW_FLOOR });

  it("rule 4: a field narrower than its least width is refused by name; at its least width it passes", () => {
    expect(BOL_LEAST_WIDTHS.pro_number).toBe(118.5);
    expect(refusal(bolChanged("field-pro_number", { box: { x: 338, y: 24, w: 113.5, h: 12 } }))).toEqual({
      sentence: "The Carrier's pro number field is 113.5 pt wide, less than the 118.5 pt its fixed parts and one grid step need.",
      ids: ["field-pro_number"],
    });
    // Pin (no guard of this task removes it): the least width itself is enough.
    expect(() => validateCanvasLayout(bolChanged("field-pro_number", { box: { x: 338, y: 24, w: 118.5, h: 12 } }), BOL_CONTRACT))
      .not.toThrow();
  });
  it("rule 4: the TRV and consignee's ref/PO blocks narrower than their least widths are refused by name", () => {
    expect(refusal(bolChanged("table-trv", { box: { x: 24, y: 176, w: 55, h: BOL_ROW_FLOOR } }))).toEqual({
      sentence: `The TRV numbers table is 55 pt wide, less than the ${BOL_LEAST_WIDTHS.trv} pt its fixed parts and one grid step need.`,
      ids: ["table-trv"],
    });
    expect(BOL_LEAST_WIDTHS.trv).toBe(59.5);
    expect(refusal(bolChanged("table-consignee_ref", { box: { x: 338, y: 57, w: 118, h: BOL_ROW_FLOOR } }))).toEqual({
      sentence: "The Consignee's ref/PO table is 118 pt wide, less than the 118.5 pt its fixed parts and one grid step need.",
      ids: ["table-consignee_ref"],
    });
  });
  it("rule 4: the carrier's box keeps its label column, gap and a grid step (owner ruling R1, 2026-11-24)", () => {
    expect(BOL_LEAST_WIDTHS.carrier_name).toBe(78.5);
    expect(() => validateCanvasLayout(
      bolChanged("field-carrier_name", { box: { x: 24, y: 4, w: CANVAS_GRID * 2, h: 12 } }), BOL_CONTRACT,
    )).toThrow(/Carrier name.*78\.5 pt/);
    expect(() => validateCanvasLayout(
      bolChanged("field-carrier_name", { box: { x: 24, y: 4, w: 78.5, h: 12 } }), BOL_CONTRACT,
    )).not.toThrow();
  });
  it("rule 4: an item with no least-width entry keeps only the grid floor (pins: a wording, a traveler field)", () => {
    expect(() => validateCanvasLayout(
      bolChanged("text-block-bol_water_note", { box: { x: 24, y: 4, w: CANVAS_GRID * 2, h: 24 } }), BOL_CONTRACT,
    )).not.toThrow();
    const travelerField = standardLayout().items.find((i) => i.kind === "field")!;
    expect(() => validateCanvasLayout(
      changed(travelerField.id, { box: { ...travelerField.box, w: CANVAS_GRID * 2 } }), TRAVELER_CONTRACT,
    )).not.toThrow();
  });
  it("leastWidth: a column table's printed columns times its copies plus what it keeps beside them and one grid step; a field's entry", () => {
    // #971 design §6: the shown fixed widths and their padding and rules, per copy, the sidebar and one grid step.
    expect(leastWidth(BOL_CONTRACT, bolTable("freight"))).toBe(round2(40 + 62 + 44 + 42 + tableOverhead("boxed", 5) + 178 + CANVAS_GRID));
    expect(leastWidth(BOL_CONTRACT, bolTable("freight", { columns: freightDescribedAt(198) })))
      .toBe(round2(386 + tableOverhead("boxed", 5) + 178 + CANVAS_GRID));
    const containers = ticketTable("containers");
    expect(leastWidth(SHIPPER_CONTRACT, containers))
      .toBe(round2(2 * (visibleColumnsWidth(SHIPPER_CONTRACT, containers) + tableOverhead("ruled", 4)) + CANVAS_GRID));
    expect(leastWidth(TRAVELER_CONTRACT, table("lines")))
      .toBe(visibleColumnsWidth(TRAVELER_CONTRACT, table("lines")) + tableOverhead("ruled", 4) + CANVAS_GRID);
    expect(leastWidth(BOL_CONTRACT, bolTable("trv"))).toBe(BOL_LEAST_WIDTHS.trv);
    // The ship-from sentence has no fixed part (owner ruling R2, 2026-11-24).
    expect(BOL_LEAST_WIDTHS.ship_from).toBeUndefined();
    expect(leastWidth(BOL_CONTRACT, bolField("ship_from"))).toBe(0);
    expect(leastWidth(BOL_CONTRACT, bolField("carrier_name"))).toBe(BOL_LEAST_WIDTHS.carrier_name);
    expect(leastWidth(BOL_CONTRACT, bolTextBlock("bol_water_note"))).toBe(0);
  });
  it("rule 9: the freight block keeps its sidebar beside its columns: the Standard's accepted at 415.3, refused under it by name", () => {
    const at = (w: number, columns?: CanvasColumn[]) =>
      bolChanged("table-freight", { ...(columns === undefined ? {} : { columns }), box: freightBox(w) });
    expect(() => validateCanvasLayout(at(415.3), BOL_CONTRACT)).not.toThrow();
    expect(refusal(at(414.8))).toEqual({
      sentence: "The Freight table needs 415.3 pt: its visible columns' 188 pt, their 44.8 pt of padding and rules, the 178 pt " +
        "it keeps beside them and one grid step, more than its 414.8 pt.",
      ids: ["table-freight"],
    });
    // With its description at 198 (386 fixed), no width on the page holds it (#971).
    expect(refusal(at(564, freightDescribedAt(198)))).toEqual({
      sentence: "The Freight table needs 613.3 pt: its visible columns' 386 pt, their 44.8 pt of padding and rules, the 178 pt " +
        "it keeps beside them and one grid step, more than its 564 pt.",
      ids: ["table-freight"],
    });
  });
  it("warning (d): the freight block with its description at 198 shows no \"*\" column, so no heading breaks in a share", () => {
    // Since #971 (d) judges the headings over the "*" columns (design §7.2): with every column fixed,
    // rule 9's refusal (above) is the one sentence.
    const wide = bolChanged("table-freight", { columns: freightDescribedAt(198), box: freightBox(564) });
    expect(canvasWarnings(wide, BOL_CONTRACT)).toEqual([]);
  });
  it("warning (d): the Standard's freight block at 400 judged in the 222 pt beside its sidebar; at 564 it warns of nothing", () => {
    // The Standard's freight block at 400: its least printed width passes the 222 pt the sidebar
    // leaves, though not the 400 of the whole box. Rule 9 refuses it since #971 (415.3), so the
    // warning is reached here only on a layout the validator refuses.
    const q = round2(188 + tableOverhead("boxed", 5));
    expect(q).toBeGreaterThan(400 - 178);
    expect(q).toBeLessThan(400);
    const narrow = bolChanged("table-freight", { box: freightBox(400) });
    expect(() => validateCanvasLayout(narrow, BOL_CONTRACT)).toThrow("needs 415.3 pt");
    // Since #971 (d) states the headings: the 222 pt beside the sidebar leaves the description nothing
    // past the fixed columns, under its 33.2 pt "Description" heading word.
    expect(canvasWarnings(narrow, BOL_CONTRACT)).toEqual([{ itemIds: ["table-freight"], sentence: "The Freight table: Freight description gets 0 pt, under the 33.2 pt its widest heading word needs, so its heading words break; its headings print whole from a 444 pt box (266 pt beside the 178 pt it keeps)." }]);
    // Pin: the Standard's block at 564 is under both 386 and 564, so `beside` does not decide it.
    expect(q).toBeLessThan(564 - 178);
    expect(canvasWarnings(bolChanged("table-freight", { box: freightBox(564) }), BOL_CONTRACT)).toEqual([]);
    expect(canvasWarnings(standardBolLayout(), BOL_CONTRACT)).toEqual([]);
  });
  it("warning (d): a freight block no wider than its sidebar, which rule 9 refuses, is judged in its whole box", () => {
    // The designer asks for warnings on a layout the validator has not passed, so the room beside the
    // sidebar can be none: the share is then 0, never negative.
    const q = round2(188 + tableOverhead("boxed", 5));
    const thin = bolChanged("table-freight", { box: freightBox(175.5) });
    expect(() => validateCanvasLayout(thin, BOL_CONTRACT)).toThrow("more than its 175.5 pt");
    expect(q).toBeGreaterThan(175.5);
    expect(canvasWarnings(thin, BOL_CONTRACT).filter((w) => w.itemIds.includes("table-freight")))
      .toEqual([{ itemIds: ["table-freight"], sentence: "The Freight table: Freight description gets 0 pt, under the 33.2 pt its widest heading word needs, so its heading words break; its headings print whole from a 444 pt box (266 pt beside the 178 pt it keeps)." }]);
  });
});

// Task 4 of the certification canvas's PR 1 (design 2026-11-10 §6): the shared rules, run on the
// certification's profile. Every case is green on arrival (the plan's Departure 3). A case goes red
// when the certification's profile entry it reads is edited (a `notFields` key, a `leastWidths`
// entry, `required`, `barcode`, `paper`, `rowFloor`, `firstTableRoom`, the statement block's
// `textBlocks`, the To block's `keyed`, a block's `heading`, `rows` or `printed`) or when the rule 1
// clause it names is deleted. A title says "(pin)" only where no edit of a profile entry was shown to
// red the case: it is held by a shared guard the earlier lanes proved.
describe("the canvas rules on a certification (design 2026-11-10 §6)", () => {
  function refusal(layout: CanvasLayout, options: { pageFooter?: boolean } = {}): { sentence: string; ids: string[] } {
    try {
      validateCanvasLayout(layout, CERT_CONTRACT, options);
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateConfigError);
      return { sentence: (error as Error).message, ids: (error as TemplateConfigError).itemIds };
    }
    return expect.fail("the layout was not refused");
  }
  /** The standard layout with one item changed (by id). */
  function certChanged(id: string, over: Partial<CanvasItem>): CanvasLayout {
    const layout = standardCertLayout();
    expect(layout.items.some((i) => i.id === id)).toBe(true);
    return layoutOf(layout.items.map((i) => (i.id === id ? ({ ...i, ...over } as CanvasItem) : i)));
  }
  /** The standard layout with several items changed (by id). */
  function certChangedAll(changes: Record<string, Partial<CanvasItem>>): CanvasLayout {
    const layout = standardCertLayout();
    for (const id of Object.keys(changes)) expect(layout.items.some((i) => i.id === id)).toBe(true);
    return layoutOf(layout.items.map((i) => (i.id in changes ? ({ ...i, ...changes[i.id] } as CanvasItem) : i)));
  }
  const name = (key: string) => CERT_CONTRACT.sections.flatMap((s) => s.fields).find((f) => f.key === key)!.name;
  const standardItem = (id: string) => standardCertLayout().items.find((i) => i.id === id)!;
  const rowsOf = (key: string): CanvasColumn[] => CERT_CONTRACT.sections.find((s) => s.key === key)!.fields
    .map((f) => ({ key: f.key, visible: true, label: null, width: null }));

  // The standard and the empty canvas (§4.3: nothing is required).
  it("the standard layout passes every rule and warns of nothing; an empty layout passes; a cleared page is empty", () => {
    expect(() => validateCanvasLayout(standardCertLayout(), CERT_CONTRACT)).not.toThrow();
    expect(canvasWarnings(standardCertLayout(), CERT_CONTRACT)).toEqual([]);
    expect(() => validateCanvasLayout(layoutOf([]), CERT_CONTRACT)).not.toThrow();
    expect(clearedLayout(CERT_CONTRACT)).toEqual({ version: 1, items: [] });
  });
  it("a barcode is refused by name: a certification prints none", () => {
    expect(refusal(layoutOf([...standardCertLayout().items, barcode()]))).toEqual({
      sentence: "The canvas has a barcode; a certification prints none.", ids: ["barcode"],
    });
  });

  // Field items: a block's key and every row or list field are never field items (`notFields`). The
  // keys are listed here, never read from the profile, so a key dropped from `notFields` reds its row
  // rather than taking the row away.
  it.each([
    ["to", "To box"], ["part_heading", "Multi-part line heading"], ["spec_line", "Specification line"],
    ["readings", "Readings grid"], ["serials", "Serial numbers"], ["freeform", "Freeform text"],
    ["signature_mark", "Signature mark"], ["signer_name", "Signer name"], ["signer_title", "Signer title"],
    ["signer_company", "Signer company"],
  ])("the %s field (%s) is refused as a field item", (key, fieldName) => {
    expect(name(key)).toBe(fieldName);
    const item = certField(key, { box: { x: 24, y: 300, w: 200, h: 12 } });
    expect(refusal(layoutOf([...standardCertLayout().items, item]))).toEqual({
      sentence: `The ${fieldName} field is not one the Certification contract places on a canvas.`, ids: [item.id],
    });
  });
  it.each(["part_qty", "part_identity", "part_pounds"])("the part lines' %s column is refused as a field item (pin)", (key) => {
    const item = certField(key, { box: { x: 24, y: 300, w: 200, h: 12 } });
    expect(refusal(layoutOf([...standardCertLayout().items, item]))).toEqual({
      sentence: `The ${name(key)} field is not one the Certification contract places on a canvas.`, ids: [item.id],
    });
  });

  // The rows blocks: the requirements' three rows and the signature's four, each shown, hidden or
  // relabelled, never dropped, doubled or given a width (Review Focus 3).
  it("defaultTableColumns: the rows blocks' rows in contract order, each shown with no label or width", () => {
    expect(defaultTableColumns(CERT_CONTRACT, "requirements")).toEqual([
      { key: "part_heading", visible: true, label: null, width: null },
      { key: "spec_line", visible: true, label: null, width: null },
      { key: "readings", visible: true, label: null, width: null },
    ]);
    expect(defaultTableColumns(CERT_CONTRACT, "signature")).toEqual([
      { key: "signature_mark", visible: true, label: null, width: null },
      { key: "signer_name", visible: true, label: null, width: null },
      { key: "signer_title", visible: true, label: null, width: null },
      { key: "signer_company", visible: true, label: null, width: null },
    ]);
  });
  it("a hidden row keeps the layout valid: the specification line and the signer's title hidden", () => {
    const hide = (key: string) => (c: CanvasColumn) => (c.key === key ? { ...c, visible: false } : c);
    expect(() => validateCanvasLayout(certChangedAll({
      "table-requirements": { columns: rowsOf("requirements").map(hide("spec_line")) },
      "table-signature": { columns: rowsOf("signature").map(hide("signer_title")) },
    }), CERT_CONTRACT)).not.toThrow();
  });
  it("rule 1: a row given a width is refused; a row has no width", () => {
    const columns = rowsOf("requirements").map((c) => (c.key === "spec_line" ? { ...c, width: 40 } : c));
    expect(refusal(certChanged("table-requirements", { columns }))).toEqual({
      sentence: "The Requirements and readings table's Specification line row carries a width (40 pt); a row has no width.",
      ids: ["table-requirements"],
    });
  });
  it("rule 1: the signature block missing a row or naming one twice is refused by name", () => {
    expect(refusal(certChanged("table-signature", {
      columns: rowsOf("signature").filter((c) => c.key !== "signer_title"),
    }))).toEqual({ sentence: "The Signature block table is missing its Signer title row.", ids: ["table-signature"] });
    const signerName = rowsOf("signature").find((c) => c.key === "signer_name")!;
    expect(refusal(certChanged("table-signature", { columns: [...rowsOf("signature"), signerName] }))).toEqual({
      sentence: 'The Signature block table names the row "signer_name" twice.', ids: ["table-signature"],
    });
  });

  // The list blocks (design §15): no heading field and no columns, but for the serials' heading and
  // the To box's label.
  it("defaultTableColumns: the statement, freeform and To blocks have no columns (pin)", () => {
    expect(defaultTableColumns(CERT_CONTRACT, "statement")).toEqual([]);
    expect(defaultTableColumns(CERT_CONTRACT, "freeform")).toEqual([]);
    expect(defaultTableColumns(CERT_CONTRACT, "to")).toEqual([]);
    // The standard layout draws the statement and freeform blocks with no heading and no columns.
    expect(standardItem("table-statement")).toMatchObject({ heading: null, columns: [] });
    expect(standardItem("table-freeform")).toMatchObject({ heading: null, columns: [] });
  });
  it.each([
    ["statement", "Certification statement"],
    ["freeform", "Freeform text"],
  ])("rule 1: the %s block given a heading is refused; it prints none", (key, blockName) => {
    expect(tableName(CERT_CONTRACT, key)).toBe(blockName);
    expect(refusal(certChanged(`table-${key}`, { heading: "Words" }))).toEqual({
      sentence: `The ${blockName} table has the heading "Words", but it prints no heading; only a table with a heading field takes one.`,
      ids: [`table-${key}`],
    });
  });
  it("the serials block and the To block take a typed heading", () => {
    expect(() => validateCanvasLayout(certChangedAll({
      "table-serials": { heading: "Serial No." }, "table-to": { heading: "Ship to:" },
    }), CERT_CONTRACT)).not.toThrow();
  });

  // The statement block prints the cert_statement wording itself (its spec's `textBlocks`).
  it("rule 2: the statement's wording placed as an item is refused, the statement block placed or not", () => {
    const sentence =
      "The Certification statement wording prints inside the Certification statement table; it is edited on the Wording tab, never placed on its own.";
    const hung = textBlock("cert_statement", { anchor: { kind: "below-table", table: "parts" }, box: { x: 24, y: 4, w: 564, h: 24 } });
    expect(refusal(layoutOf([...standardCertLayout().items, hung]))).toEqual({ sentence, ids: [hung.id] });
    const without = standardCertLayout().items.filter((i) => i.id !== "table-statement");
    expect(without.some((i) => i.kind === "table" && i.key === "statement")).toBe(false);
    expect(refusal(layoutOf([...without, hung]))).toEqual({ sentence, ids: [hung.id] });
  });

  // The To block is keyed by its field (design 2026-11-10 §4.1): every sentence that names it names
  // it by the field, "To box".
  const BELOW_TO: CanvasAnchor = { kind: "below-table", table: "to" };
  const toBox = certTable("to").box;
  it("tableName: the To block by its field, the requirements block by its section", () => {
    expect(tableName(CERT_CONTRACT, "to")).toBe("To box");
    // Pin: a section-keyed block's name is unchanged by the To block's keying.
    expect(tableName(CERT_CONTRACT, "requirements")).toBe("Requirements and readings");
  });
  it("an item anchored below the unplaced To block names the block by its field", () => {
    const po = certField("po_number", { anchor: BELOW_TO, box: { x: 348, y: 4.5, w: 240, h: 12 } });
    expect(refusal(layoutOf([certTable("parts"), po]))).toEqual({
      sentence: "The Purchase order field is anchored below the To box table, which the canvas does not place.",
      ids: [po.id],
    });
  });
  it("the To block placed twice is refused by its field's name, naming both", () => {
    const again = certTable("to", { id: "t2" });
    expect(refusal(layoutOf([certTable("to"), again]))).toEqual({
      sentence: "The To box table is placed twice; a table prints once.", ids: ["table-to", again.id],
    });
  });
  it("the To block drawn under one row is refused by its field's name", () => {
    expect(4).toBeLessThan(CERT_ROW_FLOOR);
    const thin = certTable("to", { box: { ...toBox, h: 4 } });
    expect(refusal(layoutOf([thin]))).toEqual({
      sentence: `The To box table is drawn 4 pt tall; a table's box is at least ${CERT_ROW_FLOOR} pt, one row.`,
      ids: [thin.id],
    });
  });
  const toBottom = toBox.y + toBox.h;
  it.each<{ rule: string; judge: () => { sentence: string; ids: string[] }; clause: string; ids: string[] }>([
    {
      rule: "rule 3: the block set to repeat",
      judge: () => refusal(layoutOf([certTable("to", { repeat: true })])),
      clause: "The To box table is set to repeat on every page; a table prints once, where it is drawn.",
      ids: ["table-to"],
    },
    {
      rule: "rule 3: an item below the block that repeats",
      judge: () => refusal(layoutOf([
        certTable("to"), certField("po_number", { anchor: BELOW_TO, box: { x: 348, y: 4.5, w: 240, h: 12 }, repeat: true }),
      ])),
      clause: "repeats on every page but is anchored below the To box table; only an item at the page's top repeats.",
      ids: ["field-po_number"],
    },
    {
      rule: "rule 4: an offset below the block under 0",
      judge: () => refusal(layoutOf([
        certTable("to"), certField("po_number", { anchor: BELOW_TO, box: { x: 348, y: -4.5, w: 240, h: 12 } }),
      ])),
      clause: "its offset below the To box table is -4.5 pt, under 0",
      ids: ["field-po_number"],
    },
    {
      rule: "rule 5: the block and the part lines overlap",
      // The part lines start inside the To block (its top .. toBottom), so the To block is the one
      // above and the sentence opens with it.
      judge: () => {
        const y = toBottom - CANVAS_GRID;
        expect(y).toBeGreaterThan(toBox.y);
        return refusal(layoutOf([certTable("to"), certTable("parts", { box: { x: 24, y, w: 564, h: CERT_ROW_FLOOR } })]));
      },
      clause: "The To box table and the Part lines table overlap: the Part lines table starts at",
      ids: ["table-to", "table-parts"],
    },
    {
      rule: "rule 8: the region after the block taller than a page holds",
      judge: () => {
        const tall = 760;
        expect(tall).toBeGreaterThan(pageFoot(false) - CANVAS_PAGE.margin);
        return refusal(layoutOf([
          certTable("to"), certField("po_number", { anchor: BELOW_TO, box: { x: 348, y: 0, w: 240, h: tall } }),
        ]));
      },
      clause: "The region after the To box table is",
      // The region's ids are the block's, not the tall item's.
      ids: ["table-to"],
    },
    {
      rule: "warning (a): a page-top field drawn across the block, no measure",
      judge: () => {
        const layout = layoutOf([certTable("to"), certField("po_number", { box: { x: 24, y: toBox.y, w: 240, h: 12 } })]);
        const found = canvasWarnings(layout, CERT_CONTRACT)
          .filter((w) => w.itemIds.includes("table-to") && w.itemIds.includes("field-po_number"));
        expect(found).toHaveLength(1);
        return { sentence: found[0].sentence, ids: found[0].itemIds };
      },
      clause: "The To box table and the Purchase order field overlap",
      ids: ["table-to", "field-po_number"],
    },
  ])("$rule names the To block by its field", ({ judge, clause, ids }) => {
    const { sentence, ids: named } = judge();
    expect(sentence).toContain(clause);
    expect(named).toEqual(ids);
  });

  // Rule 4's least widths (call 12): the To box and the signature block keep their fixed parts and
  // one grid step; a list or rows block with no entry keeps only the grid floor.
  it("rule 4: the To block narrower than its least width is refused by name", () => {
    const least = CERT_LEAST_WIDTHS.to;
    expect(least).toBe(244.5);
    expect(refusal(certChanged("table-to", { box: { ...toBox, w: least - 1 } }))).toEqual({
      sentence: `The To box table is ${least - 1} pt wide, less than the ${least} pt its fixed parts and one grid step need.`,
      ids: ["table-to"],
    });
  });
  it("rule 4: the To block at its least width passes (pin)", () => {
    expect(() => validateCanvasLayout(certChanged("table-to", { box: { ...toBox, w: CERT_LEAST_WIDTHS.to } }), CERT_CONTRACT))
      .not.toThrow();
  });
  it("rule 4: the signature block narrower than its least width is refused by name; at its least width it passes", () => {
    const least = CERT_LEAST_WIDTHS.signature;
    expect(least).toBe(224.5);
    const box = standardItem("table-signature").box;
    expect(box.x).toBe(338);
    expect(refusal(certChanged("table-signature", { box: { ...box, w: least - 1 } }))).toEqual({
      sentence: `The Signature block table is ${least - 1} pt wide, less than the ${least} pt its fixed parts and one grid step need.`,
      ids: ["table-signature"],
    });
    expect(() => validateCanvasLayout(certChanged("table-signature", { box: { ...box, w: least } }), CERT_CONTRACT))
      .not.toThrow();
  });
  it("rule 4: the statement, freeform, serials and requirements blocks keep no least width but the grid's", () => {
    for (const key of ["statement", "freeform", "serials", "requirements"]) {
      expect(CERT_LEAST_WIDTHS[key]).toBeUndefined();
      const box = standardItem(`table-${key}`).box;
      expect(() => validateCanvasLayout(certChanged(`table-${key}`, { box: { ...box, w: CANVAS_GRID } }), CERT_CONTRACT))
        .not.toThrow();
    }
  });
  it("leastWidth and rule 9: the part lines' visible columns, the shared column counting 0", () => {
    const parts = certTable("parts");
    expect(visibleColumnsWidth(CERT_CONTRACT, parts)).toBe(70 + 90);
    // #971: their 24 pt of padding and rules and one grid step on top.
    expect(leastWidth(CERT_CONTRACT, parts)).toBe(visibleColumnsWidth(CERT_CONTRACT, parts) + tableOverhead("ruled", 3) + CANVAS_GRID);
    const narrow = leastWidth(CERT_CONTRACT, parts) - 1;
    expect(refusal(certChanged("table-parts", { box: { ...standardItem("table-parts").box, w: narrow } }))).toEqual({
      sentence: `The Part lines table needs 188.5 pt: its visible columns' ${70 + 90} pt, their 24 pt of padding and rules and one ` +
        `grid step, more than its ${narrow} pt.`,
      ids: ["table-parts"],
    });
  });

  // Rule 8's first-block room (call 13): one room serves the To block and the part lines (§4.1).
  it("rule 8: the To block too low for its heading and one row is refused by its field's name; at the room it passes", () => {
    expect(firstTableRoom(CERT_CONTRACT)).toBe(CERT_FIRST_TABLE_ROOM);
    const edge = pageFoot(false) - CERT_FIRST_TABLE_ROOM;
    const low = certTable("to", { box: { ...toBox, y: edge + 1 } });
    expect(refusal(layoutOf([low]))).toEqual({
      sentence: `The To box table starts at ${edge + 1} pt, too low for its heading and one row (${CERT_FIRST_TABLE_ROOM} pt) above 768.`,
      ids: [low.id],
    });
    // Pin: at exactly the room.
    expect(() => validateCanvasLayout(layoutOf([certTable("to", { box: { ...toBox, y: edge } })]), CERT_CONTRACT)).not.toThrow();
  });
  it("rule 8: the part lines too low for their heading and one row are refused; at the room they pass", () => {
    const edge = pageFoot(false) - CERT_FIRST_TABLE_ROOM;
    const parts = (y: number) => certTable("parts", { box: { x: 24, y, w: 564, h: CERT_ROW_FLOOR } });
    expect(refusal(layoutOf([parts(edge + 1)]))).toEqual({
      sentence: `The Part lines table starts at ${edge + 1} pt, too low for its heading and one row (${CERT_FIRST_TABLE_ROOM} pt) above 768.`,
      ids: ["table-parts"],
    });
    expect(() => validateCanvasLayout(layoutOf([parts(edge)]), CERT_CONTRACT)).not.toThrow();
  });

  // Rule 3's repeat set (§4.4): the order number repeats and ends at least one grid step above the
  // first block, the To box.
  it("rule 3: the order number repeats only ending at least one grid step above the To block's top (pin)", () => {
    const orderNo = standardItem("field-order_no");
    expect(orderNo.repeat).toBe(true);
    const at = (bottom: number) => certChanged("field-order_no", { box: { ...orderNo.box, y: bottom - orderNo.box.h } });
    expect(() => validateCanvasLayout(at(toBox.y - CANVAS_GRID), CERT_CONTRACT)).not.toThrow();
    const refused = refusal(at(toBox.y - 3));
    expect(refused.sentence).toContain(`less than one grid step (${CANVAS_GRID} pt) above the first table's top`);
    expect(refused.ids).toEqual(["field-order_no", "table-to"]);
  });

  // The company strip and the page line (call 6, Review Focus 5): with Page N of M on, the band ends
  // at the page line's room.
  it("the company strip drawn at the flow's 754 is refused with the page line on; drawn to end at its room it passes (pin)", () => {
    const strip = standardItem("field-footer_address").box;
    // Precondition: the standard draws the strip ending at 763 pt, past the page line's 748.
    expect(strip.y + strip.h).toBe(763);
    expect(strip.y + strip.h).toBeGreaterThan(pageFoot(true));
    expect(strip.y + strip.h).toBeLessThanOrEqual(pageFoot(false));
    const refused = refusal(standardCertLayout(), { pageFooter: true });
    expect(refused.ids).toEqual(["field-footer_address"]);
    expect(refused.sentence).toContain(`its bottom edge is at ${strip.y + strip.h} pt, past ${pageFoot(true)}, where the page line's room begins`);
    const y = pageFoot(true) - strip.h;
    expect(y).toBe(748 - 9);
    const raised = certChangedAll({
      "field-footer_address": { box: { ...strip, y } },
      "field-footer_phone": { box: { ...standardItem("field-footer_phone").box, y } },
    });
    expect(() => validateCanvasLayout(raised, CERT_CONTRACT, { pageFooter: true })).not.toThrow();
  });

  // Warnings (d) and (e) with no measure. (b) and the measured (c) judge a measured box past a drawn
  // one, which only PR 2's preview supplies on a cert; (f) judges only a table printed twice, which no
  // cert block is.
  it("warning (d): the part lines say where their headings break: refused at their fixed widths, warned at their least width", () => {
    // Since #971 rule 9 refuses a box under the fixed widths, their padding and rules and one grid
    // step, and (d) states the headings (design §7.2): the Part identity column's "Description"
    // heading word needs 45.97 pt at the certification's 9 pt, so the headings print whole from
    // 184 + 45.97 = 229.97, and (d) speaks below that, the refused box included (a share of 0).
    const parts = certTable("parts");
    const w = visibleColumnsWidth(CERT_CONTRACT, parts);
    const at = (width: number) => certChanged("table-parts", { box: { ...standardItem("table-parts").box, w: width } });
    const said = (share: number) => [{
      itemIds: ["table-parts"],
      sentence: `The Part lines table: Part identity gets ${share} pt, under the 45.97 pt its widest heading word needs, so its ` +
        "heading words break; its headings print whole from 229.97 pt wide.",
    }];
    expect(() => validateCanvasLayout(at(w), CERT_CONTRACT)).toThrow("needs 188.5 pt");
    expect(canvasWarnings(at(w), CERT_CONTRACT)).toEqual(said(0));
    const least = leastWidth(CERT_CONTRACT, parts);
    expect(() => validateCanvasLayout(at(least), CERT_CONTRACT)).not.toThrow();
    expect(canvasWarnings(at(least), CERT_CONTRACT)).toEqual(said(4.5));
    expect(canvasWarnings(at(230), CERT_CONTRACT)).toEqual([]);
  });
  it("warning (e): the order number moved to the left margin repeats where \"(continued)\" prints", () => {
    const orderNo = standardItem("field-order_no");
    const moved = certChanged("field-order_no", { box: { ...orderNo.box, x: CANVAS_PAGE.margin } });
    expect(() => validateCanvasLayout(moved, CERT_CONTRACT)).not.toThrow();
    // It crosses the company name too, so warning (a) fires beside it; nothing else warns.
    expect(canvasWarnings(moved, CERT_CONTRACT)).toEqual([
      {
        itemIds: ["field-company_name", "field-order_no"],
        sentence: "The Company name field and the Order number field overlap; one prints over the other.",
      },
      {
        itemIds: ["field-order_no"],
        sentence: 'The Order number field repeats where "(continued)" prints on continuation pages, at the repeat band\'s ' +
          "bottom-left; the two print over each other.",
      },
    ]);
  });
});

describe("the refusals name their items (PR C of #926)", () => {
  /** The ids the refusal of `layout` carries: it must be refused, with a TemplateConfigError whose
   *  sentence holds `fragment`, so a case cannot pass on an earlier rule naming the same ids. */
  function refusedIds(layout: CanvasLayout, fragment: string): string[] {
    try {
      validateCanvasLayout(layout, TRAVELER_CONTRACT);
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateConfigError);
      expect((error as Error).message).toContain(fragment);
      return (error as TemplateConfigError).itemIds;
    }
    return expect.fail("the layout was not refused");
  }
  const tableOf = (id: string) => standardLayout().items.find((i) => i.id === id) as Extract<CanvasItem, { kind: "table" }>;

  it("a TemplateConfigError names no item unless it is handed some", () => {
    expect(new TemplateConfigError("x").itemIds).toEqual([]);
    expect(new TemplateConfigError("x", ["a", "b"]).itemIds).toEqual(["a", "b"]);
    expect(new TemplateConfigError("x", ["a"]).message).toBe("x");
  });
  it("rule 2: a shared id, the barcodes, the steps table, a table or the logo placed twice", () => {
    expect(refusedIds(plus(text("field-results", { x: 24, y: 740, w: 100, h: 12 })), 'Two items share the id "field-results"')).toEqual(["field-results"]);
    expect(refusedIds(less("barcode"), "has no barcode")).toEqual([]);
    expect(refusedIds(plus(barcode({ id: "barcode-2", box: { x: 402, y: 600, w: 186, h: 44 } })), "more than one barcode")).toEqual(["barcode", "barcode-2"]);
    expect(refusedIds(less("table-steps"), "has no Process steps table")).toEqual([]);
    expect(refusedIds(plus(table("lines", { id: "lines-2" })), "Part lines table is placed twice")).toEqual(["table-lines", "lines-2"]);
    expect(refusedIds(plus(logo({ id: "logo-2" })), "is placed twice; the logo prints once")).toEqual(["logo", "logo-2"]);
  });
  it("rule 1: a field the contract does not place, a heading nothing prints, and each column rule name the item or its table", () => {
    expect(refusedIds(plus(field("nonsense")), "is not one the Traveler contract places")).toEqual(["field-nonsense"]);
    expect(refusedIds(changed("table-lines", { heading: "Parts" }), "but it prints no heading")).toEqual(["table-lines"]);
    const lines = tableOf("table-lines").columns;
    expect(refusedIds(changed("table-lines", { columns: [...lines, { key: "line_qty", visible: true, label: null, width: null }] }), 'names the column "line_qty" twice')).toEqual(["table-lines"]);
    expect(refusedIds(changed("table-lines", { columns: [...lines, { key: "order_qty", visible: true, label: null, width: null }] }), 'names a column "order_qty" that is not one of its columns')).toEqual(["table-lines"]);
    expect(refusedIds(changed("table-lines", { columns: lines.filter((c) => c.key !== "line_qty") }), "is missing its Part quantity column")).toEqual(["table-lines"]);
  });
  it("rule 3: a repeating table, a below-table item whose table is absent or that repeats, and a repeat band past the first table", () => {
    expect(refusedIds(changed("table-steps", { repeat: true }), "is set to repeat on every page; a table prints once")).toEqual(["table-steps"]);
    const orphan = field("results", { id: "r2", anchor: { kind: "below-table", table: "lines" }, box: { x: 24, y: 0, w: 100, h: 12 } });
    expect(refusedIds(layoutOf([...less("table-lines").items, orphan]), "which the canvas does not place")).toEqual(["r2"]);
    expect(refusedIds(changed("field-results", { repeat: true }), "repeats on every page but is anchored below")).toEqual(["field-results"]);
    // The sentence names the repeated item and the first table's top.
    expect(refusedIds(changed("field-order_number", { repeat: true, box: { x: 120, y: 130, w: 130, h: 12 } }), "less than one grid step (4.5 pt) above the first table's top"))
      .toEqual(["field-order_number", "table-lines"]);
  });
  it("rule 4: a negative side, a table shorter than a row, and a box outside the page each name the item", () => {
    expect(refusedIds(changed("field-customer_name", { box: { x: 120, y: 24, w: -5, h: 12 } }), "has a negative width")).toEqual(["field-customer_name"]);
    expect(refusedIds(changed("field-customer_name", { box: { x: 120, y: 24, w: 130, h: -5 } }), "has a negative height")).toEqual(["field-customer_name"]);
    expect(refusedIds(changed("table-steps", { box: { x: 24, y: 339, w: 564, h: 20 } }), "a table's box is at least 24 pt, one row")).toEqual(["table-steps"]);
    expect(refusedIds(changed("logo", { box: { x: 10, y: 24, w: 80, h: 40 } }), "its left edge is at 10 pt")).toEqual(["logo"]);
    expect(refusedIds(changed("field-results", { box: { x: 24, y: -1, w: 180, h: 12 } }), "its offset below the Process steps table is -1 pt")).toEqual(["field-results"]);
    expect(refusedIds(plus(text("low", { x: 24, y: 760, w: 200, h: 12 })), "its bottom edge is at 772 pt")).toEqual(["low"]);
  });
  it("rule 5: two tables overlapping name both", () => {
    expect(refusedIds(changed("table-quantities", { box: { x: 24, y: 170, w: 564, h: 52 } }), "overlap: the Quantities and containers table starts at 170 pt")).toEqual(["table-lines", "table-quantities"]);
  });
  it("rule 6: an item over a required element names the coverer and the covered", () => {
    expect(refusedIds(plus(text("over", { x: 410, y: 60, w: 20, h: 10 }, { kind: "page-top" })), "is drawn over the Barcode")).toEqual(["over", "barcode"]);
    expect(refusedIds(plus(text("over", { x: 40, y: 400, w: 20, h: 10 }, { kind: "page-top" })), "is drawn over the Process steps table")).toEqual(["over", "table-steps"]);
  });
  it("rule 7: the barcode's floor and proportions name the barcode", () => {
    expect(refusedIds(changed("barcode", { box: { x: 402, y: 48, w: 180, h: 44 } }), "is 180 pt wide; a barcode is at least 186 pt wide")).toEqual(["barcode"]);
    expect(refusedIds(changed("barcode", { box: { x: 402, y: 48, w: 186, h: 40 } }), "is 40 pt tall; a barcode is at least 44 pt tall")).toEqual(["barcode"]);
    expect(refusedIds(changed("barcode", { box: { x: 402, y: 48, w: 186, h: 50 } }), "keeps the 186 × 44 proportions")).toEqual(["barcode"]);
  });
  it("rule 8: a region too tall names its table, a band too tall its items, a first table too low itself", () => {
    expect(refusedIds(changed("field-results", { box: { x: 24, y: 700, w: 180, h: 12 } }), "The region after the Process steps table is 712 pt tall")).toEqual(["table-steps"]);
    const steps = table("steps", { box: { x: 24, y: 24, w: 564, h: 40 } });
    const lowBarcode = barcode({ anchor: { kind: "page-bottom" }, box: { x: 402, y: 700, w: 186, h: 44 } });
    expect(refusedIds(layoutOf([steps, lowBarcode, text("band", { x: 24, y: 100, w: 200, h: 12 })]), "The page-bottom band is 668 pt tall")).toEqual(["barcode", "band"]);
    expect(refusedIds(layoutOf([barcode(), table("steps", { box: { x: 24, y: 720, w: 564, h: 40 } })]), "too low for its heading and one row")).toEqual(["table-steps"]);
  });
  it("rule 9: a hidden locked column and columns wider than the table name the table", () => {
    const columns = tableOf("table-steps").columns.map((c) => (c.key === "step_code" ? { ...c, visible: false } : c));
    expect(refusedIds(changed("table-steps", { columns }), "hides its Step code column")).toEqual(["table-steps"]);
    expect(refusedIds(changed("table-lines", { box: { x: 24, y: 140, w: 100, h: 40 } }), "needs 280.5 pt: its visible columns' 244 pt")).toEqual(["table-lines"]);
  });

  it("canvasRefusal: the first refusal's ids and sentence, null for a layout the rules accept", () => {
    expect(canvasRefusal(standardLayout(), TRAVELER_CONTRACT)).toBeNull();
    expect(canvasRefusal(plus(text("over", { x: 410, y: 60, w: 20, h: 10 }, { kind: "page-top" })), TRAVELER_CONTRACT)).toEqual({
      itemIds: ["over", "barcode"],
      sentence: "The Text (text over) is drawn over the Barcode (barcode barcode); nothing may cover a required element.",
    });
    // The page line's room is the option's: a page-top item ending at 760 passes without it.
    const note = plus(text("note", { x: 24, y: 748, w: 200, h: 12 }, { kind: "page-top" }));
    expect(canvasRefusal(note, TRAVELER_CONTRACT)).toBeNull();
    expect(canvasRefusal(note, TRAVELER_CONTRACT, { pageFooter: true })?.itemIds).toEqual(["note"]);
  });
  it("canvasRefusal refuses a layout the schema cannot read, naming no item, and throws nothing (ruling C31)", () => {
    const unread = canvasRefusal({ version: 1, items: null } as unknown as CanvasLayout, TRAVELER_CONTRACT);
    expect(unread?.itemIds).toEqual([]);
    expect(unread?.sentence).toMatch(/^The canvas is not one the editor can read: .+[^.]\.$/);
  });
  it("canvasRefusal refuses what the server's parse refuses, ahead of the rules, naming the item (ruling C31)", () => {
    // A horizontal line given a height has both sides drawn: refused with the schema's own words,
    // the line named and outlined.
    const rule = { id: "rule", kind: "line", weight: 1, box: { x: 24, y: 700, w: 200, h: 6 }, anchor: { kind: "page-top" }, repeat: false } as const;
    expect(canvasRefusal(plus(rule), TRAVELER_CONTRACT)).toEqual({
      itemIds: ["rule"],
      sentence: "The Line (line rule) is not drawn as the canvas allows: a line is horizontal (h 0) or vertical (w 0).",
    });
    expect(canvasRefusal(plus({ ...rule, box: { ...rule.box, h: 0 } }), TRAVELER_CONTRACT)).toBeNull();
    // An item the schema cannot read (no anchor) is refused by its id, before rule 3 reads its anchor.
    const anchorless: Partial<CanvasItem> = text("loose", { x: 24, y: 700, w: 100, h: 12 }, { kind: "page-top" });
    delete anchorless.anchor;
    expect(canvasRefusal(plus(anchorless as CanvasItem), TRAVELER_CONTRACT)?.itemIds).toEqual(["loose"]);
  });

  it("defaultTableColumns: each of the table's contract columns, shown at its own label and width", () => {
    expect(defaultTableColumns(TRAVELER_CONTRACT, "lines")).toEqual([
      { key: "line_qty", visible: true, label: null, width: null },
      { key: "line_part", visible: true, label: null, width: null },
      { key: "line_each_weight", visible: true, label: null, width: null },
      { key: "line_weight", visible: true, label: null, width: null },
    ]);
    for (const key of ["lines", "quantities", "inspections", "steps"] as const) {
      expect(defaultTableColumns(TRAVELER_CONTRACT, key)).toEqual(tableOf(`table-${key}`).columns);
    }
  });
  it("visibleColumnsWidth: the visible columns' widths, a flexible one as 0, the rule 9 sum", () => {
    expect(visibleColumnsWidth(TRAVELER_CONTRACT, tableOf("table-lines"))).toBe(244);
    const wide = tableOf("table-lines").columns.map((c) => (c.key === "line_part" ? { ...c, width: 100 } : c));
    expect(visibleColumnsWidth(TRAVELER_CONTRACT, { ...tableOf("table-lines"), columns: wide })).toBe(344);
    const hidden = tableOf("table-lines").columns.map((c) => (c.key === "line_qty" ? { ...c, visible: false } : c));
    expect(visibleColumnsWidth(TRAVELER_CONTRACT, { ...tableOf("table-lines"), columns: hidden })).toBe(166);
  });
});

it("the canvas rules are registry-free: they import neither the contract registry nor the printed-width module", () => {
  const rules = readFileSync(new URL("../src/lib/template-canvas.ts", import.meta.url), "utf8");
  const imports = [...rules.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((m) => m[1]);
  expect(imports).not.toContain("./template-contracts/index");
  expect(imports).not.toContain("./template-contracts");
  expect(imports).not.toContain("./template-printed-width");
  expect(imports.filter((i) => /^\.\/template-contracts\/(?!types$|canvas$)/.test(i)))
    .toEqual(["./template-contracts/traveler", "./template-contracts/container-tag"]);
});

describe("warning (g): a grid block out of line with its grid (design 2026-11-10 §6)", () => {
  /** The standard invoice layout with the named blocks' boxes changed (by table key). */
  function moved(boxes: Partial<Record<InvoiceTable, Partial<CanvasBox>>>, layout = standardInvoiceLayout()): CanvasLayout {
    for (const key of Object.keys(boxes)) expect(layout.items.some((i) => i.id === `table-${key}`)).toBe(true);
    return layoutOf(layout.items.map((i) => {
      const box = i.kind === "table" ? boxes[i.key as InvoiceTable] : undefined;
      return box === undefined ? i : ({ ...i, box: { ...i.box, ...box } } as CanvasItem);
    }));
  }
  /** The standard invoice layout with no column headers placed: the order strip, anchored below
   *  the column headers in the standard, anchored below the parties instead. */
  function noColumnHeaders(): CanvasLayout {
    return layoutOf(standardInvoiceLayout().items
      .filter((i) => i.id !== "table-column_header")
      .map((i) => (i.id === "table-order_strip" ? ({ ...i, anchor: { kind: "below-table", table: "parties" } } as CanvasItem) : i)));
  }
  /** The warnings, the layout first held to pass every rule (no layout here is one a rule refuses). */
  function warnings(layout: CanvasLayout) {
    expect(canvasRefusal(layout, INVOICE_CONTRACT, { pageFooter: false })).toBeNull();
    return canvasWarnings(layout, INVOICE_CONTRACT);
  }
  const inset = 24 + CANVAS_GRID; // 28.5: one grid step in from the left margin
  const narrowed = 564 - CANVAS_GRID; // 559.5: the content less one grid step
  const columnHeaders = () => standardInvoiceLayout().items.find((i) => i.id === "table-column_header")!;

  it("gridOf: null for a block that names no grid; else the grid's key, its placed item and the columns it prints", () => {
    const layout = standardInvoiceLayout();
    expect(gridOf(layout, INVOICE_CONTRACT, "parties")).toBeNull();
    expect(gridOf(layout, INVOICE_CONTRACT, "column_header")).toBeNull();
    expect(gridOf(layout, INVOICE_CONTRACT, "nonesuch")).toBeNull();
    const headers = columnHeaders() as Extract<CanvasItem, { kind: "table" }>;
    for (const key of ["order_strip", "parts", "price", "totals"]) {
      expect(gridOf(layout, INVOICE_CONTRACT, key)).toEqual({ key: "column_header", item: headers, columns: headers.columns });
    }
    expect(headers.columns).toEqual(defaultTableColumns(INVOICE_CONTRACT, "column_header"));
  });
  it("gridOf: with no column headers placed, no item and the contract's columns", () => {
    expect(gridOf(noColumnHeaders(), INVOICE_CONTRACT, "parts")).toEqual({
      key: "column_header", item: null, columns: defaultTableColumns(INVOICE_CONTRACT, "column_header"),
    });
  });
  it("gridOf: a column hidden on the placed column headers is read as stored", () => {
    const headers = columnHeaders() as Extract<CanvasItem, { kind: "table" }>;
    const stored: CanvasColumn[] = headers.columns.map((c, i) => (i === 1 ? { ...c, visible: false, label: "Wt" } : c));
    expect(stored).not.toEqual(defaultTableColumns(INVOICE_CONTRACT, "column_header"));
    const layout = layoutOf(standardInvoiceLayout().items.map((i) => (i.id === headers.id ? { ...headers, columns: stored } : i)));
    expect(gridOf(layout, INVOICE_CONTRACT, "parts")?.columns).toEqual(stored);
  });

  // Warned: each grid block judged by what it reads of its grid.
  it("warns of the order strip drawn at another left edge (it reads its grid's left edge)", () => {
    expect(warnings(moved({ order_strip: { x: inset, w: narrowed } }))).toEqual([{
      itemIds: ["table-order_strip"],
      sentence: "The Order strip table prints from the Column headers table's left edge, but is drawn at another left " +
        "edge, so it does not line up under its columns.",
    }]);
  });
  it("warns of the totals drawn at another right edge (it reads its grid's right edge)", () => {
    expect(warnings(moved({ totals: { x: 24, w: 520 } }))).toEqual([{
      itemIds: ["table-totals"],
      sentence: "The Totals table prints to the Column headers table's right edge, but is drawn at another right edge, " +
        "so it does not line up under its columns.",
    }]);
  });
  it("warns of the part rows drawn at another left edge and width, and of the price block at another width alone", () => {
    expect(warnings(moved({ parts: { x: inset, w: narrowed } }))).toEqual([{
      itemIds: ["table-parts"],
      sentence: "The Part rows table prints under the Column headers table's columns, but is drawn at another left edge " +
        "or width, so its columns do not line up under them.",
    }]);
    expect(warnings(moved({ price: { x: 24, w: 520 } }))).toEqual([{
      itemIds: ["table-price"],
      sentence: "The Price block table prints under the Column headers table's columns, but is drawn at another left " +
        "edge or width, so its columns do not line up under them.",
    }]);
  });
  it("warns of a block that prints every column drawn at its grid's width but another left edge", () => {
    // The column headers narrowed to 559.5 at x 24 and every other grid block narrowed with them, so
    // each stays in line (the order strip by its left edge, the price by its left edge and width, the
    // totals by its right edge, 583.5); the part rows alone at x 28.5, the same width.
    const layout = moved({
      column_header: { x: 24, w: narrowed }, order_strip: { x: 24, w: narrowed }, price: { x: 24, w: narrowed },
      totals: { x: 24, w: narrowed }, parts: { x: inset, w: narrowed },
    });
    expect(warnings(layout)).toEqual([{
      itemIds: ["table-parts"],
      sentence: "The Part rows table prints under the Column headers table's columns, but is drawn at another left edge " +
        "or width, so its columns do not line up under them.",
    }]);
  });

  // Silent: each the twin of a warned case above, differing only in what (g) judges.
  it("warns of nothing on the standard invoice layout", () => {
    expect(warnings(standardInvoiceLayout())).toEqual([]);
  });
  it("warns of nothing for the order strip narrowed with its left edge kept", () => {
    expect(warnings(moved({ order_strip: { x: 24, w: 300 } }))).toEqual([]);
  });
  it("warns of nothing for the totals narrowed with their right edge kept", () => {
    expect(warnings(moved({ totals: { x: 588 - 520, w: 520 } }))).toEqual([]);
  });
  it("warns of nothing for a grid block out of line when no column headers block is placed", () => {
    expect(warnings(moved({ parts: { x: inset, w: narrowed } }, noColumnHeaders()))).toEqual([]);
  });
  it("compares at two decimals: the part rows a hair off the column headers' edges are in line", () => {
    expect(warnings(moved({ parts: { x: 24.004, w: 563.996 } }))).toEqual([]);
  });

  // A block with no grid edge has its width judged only while the column headers show a flexible
  // column: the "*" column resolves against the block's own drawn width, and with none every shown
  // column prints at its own width from the block's left edge, whatever the block's width. Such a
  // block is warned instead when drawn narrower than those widths summed (its rows print past its
  // right edge), in a sentence of its own.
  /** The standard invoice layout with the column headers' Information column ("*") changed. */
  function infoColumn(change: Partial<CanvasColumn>): CanvasLayout {
    const layout = standardInvoiceLayout();
    const headers = layout.items.find((i) => i.id === "table-column_header") as Extract<CanvasItem, { kind: "table" }>;
    expect(headers.columns.filter((c) => c.key === "col_info")).toEqual([{ key: "col_info", visible: true, label: null, width: null }]);
    const columns = headers.columns.map((c) => (c.key === "col_info" ? { ...c, ...change } : c));
    return layoutOf(layout.items.map((i) => (i.id === headers.id ? { ...headers, columns } : i)));
  }
  const partsSentence = "The Part rows table prints under the Column headers table's columns, but is drawn at another " +
    "left edge or width, so its columns do not line up under them.";
  it("warns of the part rows at the column headers' left edge and another width while the Information column is shown \"*\"", () => {
    expect(warnings(moved({ parts: { x: 24, w: narrowed } }))).toEqual([{ itemIds: ["table-parts"], sentence: partsSentence }]);
  });
  it("warns of nothing for the part rows at the column headers' left edge and another width, the Information column hidden", () => {
    expect(warnings(moved({ parts: { x: 24, w: narrowed } }, infoColumn({ visible: false })))).toEqual([]);
  });
  it("warns of nothing for the part rows at the column headers' left edge and another width, the Information column given a width", () => {
    expect(warnings(moved({ parts: { x: 24, w: narrowed } }, infoColumn({ width: 200 })))).toEqual([]);
  });
  it("still warns of the part rows at another left edge, the Information column hidden", () => {
    expect(warnings(moved({ parts: { x: inset, w: narrowed } }, infoColumn({ visible: false }))))
      .toEqual([{ itemIds: ["table-parts"], sentence: partsSentence }]);
  });

  // The Information column given 200 pt: the shown columns sum to 52 + 200 + 66 + 84 = 402, and the
  // three 6 pt grid gaps the block prints between its four columns make 420.
  const info200 = () => infoColumn({ width: 200 });
  /** The warnings on a layout rule 4 refuses by the grid's columns. Since #971 (design §6.1) a grid
   *  block's least width is its grid's columns, the gaps between them, the information cell's margin
   *  while that column is "*", and one grid step, so a block drawn narrower than its columns and
   *  their gaps is refused by rule 4, which names the figure. (g)'s former clause for such a block
   *  ("prints the … columns at least N pt wide from its left edge … so its rows print past its right
   *  edge") is retired (#971 Task 6): it fired only on a layout rule 4 refuses and said what rule 4
   *  says, and a warning never repeats a refusal. */
  function refusedWarnings(layout: CanvasLayout) {
    expect(canvasRefusal(layout, INVOICE_CONTRACT, { pageFooter: false })?.sentence)
      .toMatch(/ pt the column headers' columns, their gaps and one grid step need\.$/);
    return canvasWarnings(layout, INVOICE_CONTRACT);
  }
  it("rule 4 alone speaks for the part rows and the price block drawn narrower than the columns they print, no column \"*\"", () => {
    expect(refusedWarnings(moved({ parts: { x: 24, w: 300 } }, info200()))).toEqual([]);
    expect(refusedWarnings(moved({ price: { x: 24, w: 240 } }, info200()))).toEqual([]);
  });
  it("a block both out of line and too narrow is warned out of line alone; rule 4 refuses its width", () => {
    expect(refusedWarnings(moved({ parts: { x: inset, w: 300 } }, info200()))).toEqual([
      { itemIds: ["table-parts"], sentence: partsSentence },
    ]);
  });
  it("warns of nothing for the part rows drawn as wide as the columns they print, or within a hundredth under", () => {
    expect(refusedWarnings(moved({ parts: { x: 24, w: 420 } }, info200()))).toEqual([]);
    expect(refusedWarnings(moved({ parts: { x: 24, w: 419.996 } }, info200()))).toEqual([]);
  });
  it("rule 4 counts the grid gaps: the part rows drawn 410 wide, past the columns' widths but not their gaps", () => {
    expect(refusedWarnings(moved({ parts: { x: 24, w: 410 } }, info200()))).toEqual([]);
    expect(refusedWarnings(moved({ price: { x: 24, w: 410 } }, info200()))).toEqual([]);
  });
  it("rule 4 counts one grid gap with two columns shown: Quantity and Amount hidden", () => {
    // 200 + 66, and the one gap between them.
    const two = () => {
      const layout = infoColumn({ width: 200 });
      const headers = layout.items.find((i) => i.id === "table-column_header") as Extract<CanvasItem, { kind: "table" }>;
      const columns = headers.columns.map((c) => (c.key === "col_qty" || c.key === "col_amount" ? { ...c, visible: false } : c));
      return layoutOf(layout.items.map((i) => (i.id === headers.id ? { ...headers, columns } : i)));
    };
    const least = 200 + INVOICE_WIDTHS.each + INVOICE_WIDTHS.gridGap;
    expect(refusedWarnings(moved({ parts: { x: 24, w: least - 1 } }, two()))).toEqual([]);
    expect(refusedWarnings(moved({ parts: { x: 24, w: least } }, two()))).toEqual([]);
  });
  it("the retired clause stays contained: every block drawn narrower than its grid's columns and gaps is refused by rule 4 by name, and no warning says its rows print past its edge (#971 Task 6)", () => {
    // Over the invoice's part rows and price block and the quote's lines, no grid column "*" (the
    // Information column given 200, 300 or 120 pt), with every column shown or some hidden, drawn from
    // well under the columns and gaps to one grid step over them: wherever the retired clause would
    // have fired, rule 4 refuses the block itself, in its grid sentence, and no warning repeats it.
    const docs = [
      { contract: INVOICE_CONTRACT, layout: standardInvoiceLayout, blocks: ["parts", "price"] },
      { contract: QUOTE_CONTRACT, layout: standardQuoteLayout, blocks: ["lines"] },
    ];
    const variants: ((c: CanvasColumn) => CanvasColumn)[] = [
      (c) => (c.key === "col_info" ? { ...c, width: 200 } : c),
      (c) => (c.key === "col_info" ? { ...c, width: 300 } : c),
      (c) => (c.key === "col_info" ? { ...c, width: 120 } : c.key === "col_each_weight" ? { ...c, visible: false } : c),
      (c) => (c.key === "col_info" ? { ...c, width: 200 } : c.key === "col_qty" || c.key === "col_amount" ? { ...c, visible: false } : c),
    ];
    let reached = 0;
    for (const { contract, layout: standard, blocks } of docs) {
      for (const variant of variants) {
        const base = standard();
        const headers = base.items.find((i) => i.id === "table-column_header") as Extract<CanvasItem, { kind: "table" }>;
        const gridded = layoutOf(base.items.map((i) => (i.id === headers.id ? { ...headers, columns: headers.columns.map(variant) } : i)));
        for (const block of blocks) {
          const spec = tableSpec(contract, block)!;
          const shown = headers.columns.map(variant).filter((c) => c.visible);
          const fields = contract.sections.flatMap((x) => x.fields);
          const widths = shown.map((c) => (c.width ?? fields.find((f) => f.key === c.key)!.column!.defaultWidth) as number);
          const columnsAndGaps = widths.reduce((a, b) => a + b, 0) + spec.gridGap! * (shown.length - 1);
          for (let w = round2(columnsAndGaps - 20); w <= columnsAndGaps + CANVAS_GRID; w = round2(w + 0.25)) {
            const layout = layoutOf(gridded.items.map((i) => (i.kind === "table" && i.key === block ? { ...i, box: { ...i.box, x: 24, w } } : i)));
            const said = canvasWarnings(layout, contract).filter((x) => /past its right edge/.test(x.sentence));
            expect(said, `${contract.docType} ${block} at ${w}`).toEqual([]);
            if (w < columnsAndGaps) {
              reached += 1;
              const refused = canvasRefusal(layout, contract, { pageFooter: false });
              expect(refused?.itemIds, `${contract.docType} ${block} at ${w}`).toEqual([`table-${block}`]);
              expect(refused?.sentence).toMatch(/ pt the column headers' columns, their gaps and one grid step need\.$/);
            }
          }
        }
      }
    }
    expect(reached).toBe(3 * 4 * 80);
  });
  it("does not judge the columns' sum while a \"*\" column is shown: the Quantity column given 300 pt", () => {
    // 300 + 66 + 84 = 450 fixed, past the 300 pt part rows, but the "*" column is the width's to judge.
    const layout = standardInvoiceLayout();
    const headers = layout.items.find((i) => i.id === "table-column_header") as Extract<CanvasItem, { kind: "table" }>;
    const columns = headers.columns.map((c) => (c.key === "col_qty" ? { ...c, width: 300 } : c));
    const wide = layoutOf(layout.items.map((i) => (i.id === headers.id ? { ...headers, columns } : i)));
    expect(refusedWarnings(moved({ parts: { x: 24, w: 300 } }, wide))).toEqual([{ itemIds: ["table-parts"], sentence: partsSentence }]);
  });
  it("does not judge the columns' sum of a block with a grid edge: the order strip and the totals", () => {
    expect(warnings(moved({ order_strip: { x: 24, w: 300 }, totals: { x: 588 - 320, w: 320 } }, info200()))).toEqual([]);
  });

  // Each edge judged by its difference, at `figure`'s two decimals, as warnings (a) and (b) judge
  // depth: two edges a few thousandths apart are in line though they round to either side of a
  // cent. The column headers at x 24.004 and 563.992 wide (right edge 587.996: 24, 563.99 and 588
  // to the cent), the part rows and the price block at x 24 and that width; each case moves one
  // block across a cent boundary from its grid's edge, less than a hundredth from it.
  const offCent = () => moved({
    column_header: { x: 24.004, w: 563.992 }, parts: { x: 24, w: 563.992 }, price: { x: 24, w: 563.992 },
  });
  it("warns of nothing for the column headers off the cent with every grid block in line", () => {
    expect(warnings(offCent())).toEqual([]);
  });
  it("judges a left edge by its difference: the order strip at 24.006 under a grid edge at 24.004 is in line", () => {
    expect(warnings(moved({ order_strip: { x: 24.006, w: 300 } }, offCent()))).toEqual([]);
  });
  it("judges a right edge by its difference: the totals ending at 587.994 under a grid edge at 587.996 are in line", () => {
    expect(warnings(moved({ totals: { x: 67.994, w: 520 } }, offCent()))).toEqual([]);
  });
  it("judges a block's left edge by its difference: the part rows at 24.006 under columns at 24.004 are in line", () => {
    expect(warnings(moved({ parts: { x: 24.006, w: 563.99 } }, offCent()))).toEqual([]);
  });
  it("judges a block's width by its difference: the price block 563.996 wide under columns 563.992 wide is in line", () => {
    expect(warnings(moved({ price: { x: 24, w: 563.996 } }, offCent()))).toEqual([]);
  });
});

describe("the canvas rules on an invoice (design 2026-11-10 §6)", () => {
  /*
   * The shared rules and warnings judged on the invoice's profile (`INVOICE_CANVAS`). No production
   * change comes with them: they run green on arrival, and their guards are proven by editing the
   * invoice's profile entries and by sampled shared-guard mutations (plan Departure 6). Warning (b)
   * judges a measured box past a drawn one, which only PR 2's preview supplies on an invoice; (c)
   * also judges a drawn box with no measure, and that case is here; (f) judges only a table printed
   * twice, which no invoice block is (design §6). Every exact-array
   * warning case runs on a layout whose grid blocks stay in line with the column headers, or that
   * places none, so warning (g) never fires beside the warning asserted.
   */
  function refusal(layout: CanvasLayout, options: { pageFooter?: boolean } = {}): { sentence: string; ids: string[] } {
    try {
      validateCanvasLayout(layout, INVOICE_CONTRACT, options);
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateConfigError);
      return { sentence: (error as Error).message, ids: (error as TemplateConfigError).itemIds };
    }
    return expect.fail("the layout was not refused");
  }
  /** The standard invoice layout with items changed (by id). */
  function invChangedAll(changes: Record<string, Partial<CanvasItem>>, layout = standardInvoiceLayout()): CanvasLayout {
    for (const id of Object.keys(changes)) expect(layout.items.some((i) => i.id === id)).toBe(true);
    return layoutOf(layout.items.map((i) => (i.id in changes ? ({ ...i, ...changes[i.id] } as CanvasItem) : i)));
  }
  function invChanged(id: string, over: Partial<CanvasItem>): CanvasLayout {
    return invChangedAll({ [id]: over });
  }
  /** The warnings, the layout first held to pass every rule. */
  function warnings(layout: CanvasLayout) {
    expect(canvasRefusal(layout, INVOICE_CONTRACT, { pageFooter: false })).toBeNull();
    return canvasWarnings(layout, INVOICE_CONTRACT);
  }
  const name = (key: string) => INVOICE_CONTRACT.sections.flatMap((s) => s.fields).find((f) => f.key === key)!.name;
  const standardItem = (id: string) => standardInvoiceLayout().items.find((i) => i.id === id)!;
  /** A section's fields as a block's entries, read from the contract (never from `defaultTableColumns`). */
  const sectionEntries = (key: string): CanvasColumn[] => INVOICE_CONTRACT.sections.find((s) => s.key === key)!.fields
    .map((f) => ({ key: f.key, visible: true, label: null, width: null }));
  const BLOCKS: [InvoiceTable, string][] = [
    ["parties", "Bill to / ship to"], ["column_header", "Column headers"], ["order_strip", "Order strip"],
    ["parts", "Part rows"], ["price", "Price block"], ["totals", "Totals"],
  ];
  const ROWS_BLOCKS = BLOCKS.filter(([key]) => key !== "column_header");
  const clear = { x: 24, y: 300, w: 200, h: 12 }; // under the totals' bottom (220), above the band (754)

  // The empty canvas (§4.3: nothing is required).
  it("an empty layout passes; a cleared page is empty", () => {
    expect(() => validateCanvasLayout(layoutOf([]), INVOICE_CONTRACT)).not.toThrow();
    expect(clearedLayout(INVOICE_CONTRACT)).toEqual({ version: 1, items: [] });
  });
  it("a barcode is refused by name: an invoice prints none", () => {
    expect(refusal(layoutOf([...standardInvoiceLayout().items, barcode()]))).toEqual({
      sentence: "The canvas has a barcode; an invoice prints none.", ids: ["barcode"],
    });
  });

  // Field items: every row of a block is never a field item (`notFields`), nor is a column header
  // (a column of the table "columns"). The keys are listed here, never read from the profile, so a
  // key dropped from `notFields` reds its row rather than taking the row away.
  it.each([
    "bill_to", "ship_to",
    "our_order_no", "your_po", "material", "process", "parts_heading",
    "part_qty", "part_identity", "part_each_weight", "part_total_weight",
    "price_heading", "price_description", "price_amount", "quote_source", "price_per", "minimum_charge", "setup_charge",
    "subtotal", "surcharge_rows", "charge_rows", "cert_row", "freight_row", "tax_row", "total",
  ])("the %s field, a block's row, is refused as a field item", (key) => {
    const item = invoiceField(key, { box: { ...clear } });
    expect(refusal(layoutOf([...standardInvoiceLayout().items, item]))).toEqual({
      sentence: `The ${name(key)} field is not one the Invoice / credit contract places on a canvas.`, ids: [item.id],
    });
  });
  it.each(["col_qty", "col_info", "col_each_weight", "col_amount"])("the %s column header is refused as a field item", (key) => {
    const item = invoiceField(key, { box: { ...clear } });
    expect(refusal(layoutOf([...standardInvoiceLayout().items, item]))).toEqual({
      sentence: `The ${name(key)} field is not one the Invoice / credit contract places on a canvas.`, ids: [item.id],
    });
  });

  // The blocks' entries: a rows block's rows are its section's fields; the column headers' columns
  // are the four fields of the table "columns" (`columnTable`).
  it("defaultTableColumns: each rows block's rows in contract order, the column headers' four grid fields", () => {
    for (const [key] of ROWS_BLOCKS) expect(defaultTableColumns(INVOICE_CONTRACT, key)).toEqual(sectionEntries(key));
    expect(defaultTableColumns(INVOICE_CONTRACT, "column_header").map((c) => c.key))
      .toEqual(["col_qty", "col_info", "col_each_weight", "col_amount"]);
    expect(defaultTableColumns(INVOICE_CONTRACT, "column_header")).toEqual(sectionEntries("column_header"));
  });
  it("rule 1: a row given a width is refused; a row has no width", () => {
    const columns = sectionEntries("order_strip").map((c) => (c.key === "your_po" ? { ...c, width: 40 } : c));
    expect(refusal(invChanged("table-order_strip", { columns }))).toEqual({
      sentence: "The Order strip table's Customer PO row carries a width (40 pt); a row has no width.",
      ids: ["table-order_strip"],
    });
  });
  it("rule 1: a rows block missing a row or naming one twice is refused by name", () => {
    expect(refusal(invChanged("table-parties", {
      columns: sectionEntries("parties").filter((c) => c.key !== "ship_to"),
    }))).toEqual({ sentence: "The Bill to / ship to table is missing its Ship-to address row.", ids: ["table-parties"] });
    expect(refusal(invChanged("table-order_strip", {
      columns: sectionEntries("order_strip").filter((c) => c.key !== "material"),
    }))).toEqual({ sentence: "The Order strip table is missing its Material row.", ids: ["table-order_strip"] });
    const billTo = sectionEntries("parties").find((c) => c.key === "bill_to")!;
    expect(refusal(invChanged("table-parties", { columns: [...sectionEntries("parties"), billTo] }))).toEqual({
      sentence: 'The Bill to / ship to table names the row "bill_to" twice.', ids: ["table-parties"],
    });
  });
  it("rule 1: the column headers missing a column, or naming a part row, are refused by name", () => {
    // The shared sentence as the leaf writes it: the field's name ends in "column" (plan open question 4).
    expect(refusal(invChanged("table-column_header", {
      columns: sectionEntries("column_header").filter((c) => c.key !== "col_qty"),
    }))).toEqual({ sentence: "The Column headers table is missing its Quantity column column.", ids: ["table-column_header"] });
    const partQty: CanvasColumn = { key: "part_qty", visible: true, label: null, width: null };
    expect(refusal(invChanged("table-column_header", { columns: [...sectionEntries("column_header"), partQty] }))).toEqual({
      sentence: 'The Column headers table names a column "part_qty" that is not one of its columns.', ids: ["table-column_header"],
    });
  });
  it.each(BLOCKS)("rule 1: the %s block (%s) given a heading is refused; it prints none", (key, blockName) => {
    expect(tableName(INVOICE_CONTRACT, key)).toBe(blockName);
    expect(refusal(invChanged(`table-${key}`, { heading: "Words" }))).toEqual({
      sentence: `The ${blockName} table has the heading "Words", but it prints no heading; only a table with a heading field takes one.`,
      ids: [`table-${key}`],
    });
  });

  // Rule 4's least widths (call 11, the figures the controller's answer 2 moved) and the row floor.
  it.each(ROWS_BLOCKS)("rule 4: the %s block (%s) at its least width passes; 0.1 pt narrower it is refused by name", (key, blockName) => {
    const least = INVOICE_LEAST_WIDTHS[key];
    expect(least).toBeGreaterThan(CANVAS_GRID);
    const box = standardItem(`table-${key}`).box;
    expect(() => validateCanvasLayout(invChanged(`table-${key}`, { box: { ...box, w: least } }), INVOICE_CONTRACT)).not.toThrow();
    const narrow = round2(least - 0.1);
    // The part rows and the price block read their floor from the column headers' columns (#971
    // design §6.1), and their sentence names them; the order strip its indent past the Quantity column
    // (#971, `gridIndent`); the totals the column headers' Amount at their edge (#971,
    // `gridEdgeColumn`); at the Standard's columns each is its entry.
    const needs = key === "parts" || key === "price"
      ? "the column headers' columns, their gaps and one grid step need."
      : key === "order_strip"
        ? "its indent past the column headers' quantity column, its fields and one grid step need."
        : key === "totals"
          ? "the column headers' amount column at its edge, its fixed parts beside it and one grid step need."
          : "its fixed parts and one grid step need.";
    expect(refusal(invChanged(`table-${key}`, { box: { ...box, w: narrow } }))).toEqual({
      sentence: `The ${blockName} table is ${narrow} pt wide, less than the ${least} pt ${needs}`,
      ids: [`table-${key}`],
    });
  });
  it.each(BLOCKS)("rule 4: the %s block (%s) drawn under one row is refused by name", (key, blockName) => {
    const box = standardItem(`table-${key}`).box;
    expect(box.h).toBe(INVOICE_ROW_FLOOR);
    expect(refusal(invChanged(`table-${key}`, { box: { ...box, h: INVOICE_ROW_FLOOR - 1 } }))).toEqual({
      sentence: `The ${blockName} table is drawn ${INVOICE_ROW_FLOOR - 1} pt tall; a table's box is at least ${INVOICE_ROW_FLOOR} pt, one row.`,
      ids: [`table-${key}`],
    });
  });

  // Rule 9 and warning (d) on the column headers (§14 answer 1): rule 9 refuses the visible fixed
  // columns past the box, (d) states the boxed strip's least printed width past it. The column
  // headers are placed alone, so no grid block can be warned by (g) beside (d).
  it("rule 9 and warning (d): the column headers' two floors are told apart; hiding Each weight lowers both", () => {
    const fields = INVOICE_CONTRACT.sections.find((s) => s.key === "column_header")!.fields;
    const fixed = (hidden: string[]) => fields.filter((f) => !hidden.includes(f.key))
      .reduce((sum, f) => sum + (f.column!.defaultWidth === "*" ? 0 : f.column!.defaultWidth), 0);
    const y = standardItem("table-column_header").box.y;
    const alone = (w: number, columns = sectionEntries("column_header")) => layoutOf([invoiceTable("column_header", {
      anchor: { kind: "page-top" }, box: { x: 24, y, w, h: INVOICE_ROW_FLOOR }, columns,
    })]);
    // Since #971 rule 9's floor is the printed width and one grid step, and (d) says where the headings
    // break, from the floor up to the width their widest word needs.
    const all = fixed([]);
    expect(all).toBe(202);
    const printed = round2(all + tableOverhead("boxed", 4));
    const floor = round2(printed + CANVAS_GRID);
    expect(refusal(alone(floor - 0.5))).toEqual({
      sentence: `The Column headers table needs ${floor} pt: its visible columns' ${all} pt, their ${round2(printed - all)} pt of ` +
        `padding and rules and one grid step, more than its ${floor - 0.5} pt.`,
      ids: ["table-column_header"],
    });
    expect(refusal(alone(all)).sentence).toContain(`needs ${floor} pt`);
    // Since #971 (d) states the headings (design §7.2): the Information column's widest heading
    // word, "Information /" (no break before a "/"), at 9 pt.
    const head = textWidthOf("Information /", "Roboto", "bold", 9);
    const said = (share: number, fixedPrinted: number) =>
      [{ itemIds: ["table-column_header"], sentence: headingsBreak("Column headers", ["Information column"], share, head, fixedPrinted + head) }];
    expect(canvasWarnings(alone(all), INVOICE_CONTRACT)).toEqual(said(0, printed));
    expect(warnings(alone(floor))).toEqual(said(4.5, printed));
    expect(warnings(alone(Math.ceil((printed + head) * 2) / 2))).toEqual([]);

    const hidden = sectionEntries("column_header").map((c) => (c.key === "col_each_weight" ? { ...c, visible: false } : c));
    const less = fixed(["col_each_weight"]);
    expect(less).toBe(136);
    const printedLess = round2(less + tableOverhead("boxed", 3));
    const floorLess = round2(printedLess + CANVAS_GRID);
    expect(refusal(alone(floorLess - 0.5, hidden))).toEqual({
      sentence: `The Column headers table needs ${floorLess} pt: its visible columns' ${less} pt, their ${round2(printedLess - less)} pt ` +
        `of padding and rules and one grid step, more than its ${floorLess - 0.5} pt.`,
      ids: ["table-column_header"],
    });
    expect(canvasWarnings(alone(less, hidden), INVOICE_CONTRACT)).toEqual(said(0, printedLess));
    expect(warnings(alone(floorLess, hidden))).toEqual(said(4.5, printedLess));
    expect(warnings(alone(Math.ceil((printedLess + head) * 2) / 2, hidden))).toEqual([]);
  });

  // Rule 8's first-block room (call 12), no band item.
  it.each<[InvoiceTable, string]>([
    ["parties", "Bill to / ship to"], ["price", "Price block"],
  ])("rule 8: the %s block (%s) placed alone too low for its heading and one row is refused; at the room it passes", (key, blockName) => {
    expect(firstTableRoom(INVOICE_CONTRACT)).toBe(INVOICE_FIRST_TABLE_ROOM);
    const edge = pageFoot(false) - INVOICE_FIRST_TABLE_ROOM;
    const alone = (y: number) => layoutOf([invoiceTable(key, { anchor: { kind: "page-top" }, box: { x: 24, y, w: 564, h: INVOICE_ROW_FLOOR } })]);
    expect(refusal(alone(edge + 1))).toEqual({
      sentence: `The ${blockName} table starts at ${edge + 1} pt, too low for its heading and one row (${INVOICE_FIRST_TABLE_ROOM} pt) above 768.`,
      ids: [`table-${key}`],
    });
    expect(() => validateCanvasLayout(alone(edge), INVOICE_CONTRACT)).not.toThrow();
  });

  // Rule 2 (§6): each block and the logo placed once, and no text block: the invoice has no wording.
  // The first two are pins: the one profile edit that reds them (a barcode required) refuses every
  // invoice layout before rule 2 is reached; rule 2's shared guard, proven by the earlier lanes, holds them.
  it("rule 2: the order strip placed twice is refused, naming both (pin)", () => {
    const again = invoiceTable("order_strip", { id: "table-order_strip-2", box: { x: 24, y: 300, w: 564, h: INVOICE_ROW_FLOOR } });
    expect(refusal(layoutOf([...standardInvoiceLayout().items, again]))).toEqual({
      sentence: "The Order strip table is placed twice; a table prints once.", ids: ["table-order_strip", again.id],
    });
  });
  it("rule 2: a second logo is refused, naming both (pin)", () => {
    const first = logo({ box: { x: 24, y: 300, w: 80, h: 40 } });
    const second = logo({ id: "logo-2", box: { x: 120, y: 300, w: 80, h: 40 } });
    expect(refusal(layoutOf([...standardInvoiceLayout().items, first, second]))).toEqual({
      sentence: `The ${STATIC_NAMES.logo} (logo logo-2) is placed twice; the logo prints once.`, ids: ["logo", "logo-2"],
    });
  });
  it("rule 2: a text-block item is refused: the invoice's contract has no wording", () => {
    expect(INVOICE_CONTRACT.textBlocks).toEqual([]);
    const wording: CanvasItem = {
      id: "text-w", kind: "textBlock", key: "w", box: { ...clear }, anchor: { kind: "page-top" }, repeat: false,
      style: { size: 9, bold: false, align: "left" },
    };
    expect(refusal(layoutOf([...standardInvoiceLayout().items, wording]))).toEqual({
      sentence: 'The wording with the key "w" (textBlock text-w) is not one the Invoice / credit contract has.', ids: ["text-w"],
    });
  });

  // Rule 3's anchors and repeats (§6).
  it("rule 3: a field anchored below the unplaced part rows is refused by name", () => {
    const layout = invChangedAll(
      { "field-invoice_date": { anchor: { kind: "below-table", table: "parts" }, box: { x: 96, y: CANVAS_GRID, w: 230, h: 12 } } },
      layoutOf(standardInvoiceLayout().items.filter((i) => i.id !== "table-parts")),
    );
    expect(refusal(layout)).toEqual({
      sentence: `The ${name("invoice_date")} field is anchored below the Part rows table, which the canvas does not place.`,
      ids: ["field-invoice_date"],
    });
  });
  it("rule 3: the price block set to repeat is refused; a table prints once", () => {
    expect(refusal(invChanged("table-price", { repeat: true }))).toEqual({
      sentence: "The Price block table is set to repeat on every page; a table prints once, where it is drawn.",
      ids: ["table-price"],
    });
  });
  it("rule 3: a field anchored below the addresses that repeats is refused by name", () => {
    expect(refusal(invChanged("field-terms", {
      anchor: { kind: "below-table", table: "parties" }, box: { x: 96, y: 0, w: 230, h: 12 }, repeat: true,
    }))).toEqual({
      sentence: `The ${name("terms")} field repeats on every page but is anchored below the Bill to / ship to table; ` +
        "only an item at the page's top repeats.",
      ids: ["field-terms"],
    });
  });

  // Rule 3's repeat set (§4.4): the invoice number repeats and ends at least one grid step above the
  // first block, the addresses.
  it("rule 3: the invoice number repeats only ending at least one grid step above the addresses' top", () => {
    const invoiceNo = standardItem("field-invoice_no");
    expect(invoiceNo.repeat).toBe(true);
    const partiesTop = standardItem("table-parties").box.y;
    const at = (bottom: number) => invChanged("field-invoice_no", { box: { ...invoiceNo.box, y: bottom - invoiceNo.box.h } });
    expect(() => validateCanvasLayout(at(partiesTop - CANVAS_GRID), INVOICE_CONTRACT)).not.toThrow();
    // The leaf names the repeated item and the first table (plan open question 5's "none" is not what it throws).
    expect(refusal(at(partiesTop - 3))).toEqual({
      sentence: `The ${name("invoice_no")} field repeats on every page but ends at ${partiesTop - 3} pt, less than one grid ` +
        `step (${CANVAS_GRID} pt) above the first table's top at ${partiesTop}; a repeated item sits above the tables (design §4.5).`,
      ids: ["field-invoice_no", "table-parties"],
    });
  });

  // Rule 4, a box outside the page; rule 5, the blocks stack.
  it("rule 4: the part rows drawn one grid step in at the content's width lie outside the page", () => {
    const box = standardItem("table-parts").box;
    const right = CANVAS_PAGE.width - CANVAS_PAGE.margin;
    const x = CANVAS_PAGE.margin + CANVAS_GRID;
    expect(refusal(invChanged("table-parts", { box: { ...box, x, w: right - CANVAS_PAGE.margin } }))).toEqual({
      sentence: `The Part rows table lies outside the page: its right edge is at ${round2(x + right - CANVAS_PAGE.margin)} pt, past ${right}.`,
      ids: ["table-parts"],
    });
  });
  it("rule 5: the part rows starting one point above the order strip's bottom overlap it", () => {
    const strip = standardItem("table-order_strip").box;
    const bottom = strip.y + strip.h;
    const parts = standardItem("table-parts").box;
    expect(refusal(invChanged("table-parts", { box: { ...parts, y: bottom - 1 } }))).toEqual({
      sentence: `The Order strip table and the Part rows table overlap: the Part rows table starts at ${bottom - 1} pt, ` +
        `above the Order strip table's bottom at ${bottom}.`,
      ids: ["table-order_strip", "table-parts"],
    });
  });

  // Rule 8, a region and the band taller than a page holds (built as the traveler's cases are).
  it("rule 8: the region after the totals, an item hung far under them, is taller than a page holds", () => {
    const hung = text("hung", { x: 24, y: 700, w: 200, h: 12 }, { kind: "below-table", table: "totals" });
    const layout = layoutOf([...standardInvoiceLayout().items, hung]);
    const height = hung.box.y + hung.box.h;
    const usable = usableHeight(layout);
    expect(height).toBeGreaterThan(usable);
    expect(refusal(layout)).toEqual({
      sentence: `The region after the Totals table is ${round2(height)} pt tall, more than the ${round2(usable)} pt a page holds under its top margin.`,
      ids: ["table-totals"],
    });
  });
  it("rule 8: a page-bottom band taller than a page holds is refused, naming its items", () => {
    const layout = layoutOf([
      invoiceTable("parties", { box: { x: 24, y: 24, w: 564, h: 40 } }),
      invoiceField("footer_address", {
        anchor: { kind: "page-bottom" }, box: { x: 24, y: 100, w: 244, h: 9 },
        style: { size: INVOICE_CONTRACT.fonts.smallSize, bold: false, align: "left" },
      }),
    ]);
    const band = bandHeight(layout);
    const usable = usableHeight(layout);
    expect(band).toBeGreaterThan(usable);
    expect(refusal(layout)).toEqual({
      sentence: `The page-bottom band is ${round2(band)} pt tall, more than the ${round2(usable)} pt a page holds under its top margin.`,
      ids: ["field-footer_address"],
    });
  });

  // Warning (a) on the invoice: a field drawn across the Remit To box.
  it("warning (a): the invoice date drawn across the Remit To box overlaps it", () => {
    const date = standardItem("field-invoice_date").box;
    const remit = standardItem("field-remit_to").box;
    // Half the date's width across the box's left edge.
    const x = remit.x - date.w / 2;
    expect(x + date.w).toBeGreaterThan(remit.x);
    expect(warnings(invChanged("field-invoice_date", { box: { ...date, x } }))).toEqual([{
      itemIds: ["field-invoice_date", "field-remit_to"],
      sentence: `The ${name("invoice_date")} field and the ${name("remit_to")} field overlap; one prints over the other.`,
    }]);
  });

  // The strip and the page line (call 8): with Page N of M on, the band ends at the page line's room.
  it("the footer strip drawn to the page's foot is refused with the page line on; all three raised to its room pass", () => {
    // The company address holds its two lines, 750 to 768 (owner ruling 2026-11-14, #978); the contact
    // and phone are drawn at the flow's 754, ending at 763.
    const strip = standardItem("field-footer_address").box;
    expect(strip.y + strip.h).toBe(768);
    expect(strip.y + strip.h).toBeGreaterThan(pageFoot(true));
    expect(strip.y + strip.h).toBeLessThanOrEqual(pageFoot(false));
    expect(refusal(standardInvoiceLayout(), { pageFooter: true })).toEqual({
      sentence: `The ${name("footer_address")} field lies outside the page: its bottom edge is at ${strip.y + strip.h} pt, ` +
        `past ${pageFoot(true)}, where the page line's room begins.`,
      ids: ["field-footer_address"],
    });
    const y = pageFoot(true) - strip.h;
    expect(y).toBe(748 - 18);
    const raise = (id: string) => ({ box: { ...standardItem(id).box, y } });
    // One raised alone leaves the next refused at 763.
    const contact = standardItem("field-footer_contact").box;
    expect(contact.y + contact.h).toBe(763);
    expect(refusal(invChanged("field-footer_address", raise("field-footer_address")), { pageFooter: true })).toEqual({
      sentence: `The ${name("footer_contact")} field lies outside the page: its bottom edge is at ${contact.y + contact.h} pt, ` +
        `past ${pageFoot(true)}, where the page line's room begins.`,
      ids: ["field-footer_contact"],
    });
    const raised = invChangedAll({
      "field-footer_address": raise("field-footer_address"),
      "field-footer_contact": raise("field-footer_contact"),
      "field-footer_phone": raise("field-footer_phone"),
    });
    expect(() => validateCanvasLayout(raised, INVOICE_CONTRACT, { pageFooter: true })).not.toThrow();
  });

  // Warning (c) on drawn boxes, no measure: the invoice date hung under the totals past the foot. The
  // band is taken off so the date crosses nothing; the region under the totals fits a page (rule 8).
  it("warning (c): the invoice date hung under the totals, drawn past the foot, would be cut off", () => {
    const totals = standardItem("table-totals").box;
    const date = standardItem("field-invoice_date").box;
    const end = pageFoot(false) + 4;
    const offset = end - (totals.y + totals.h) - date.h;
    const noBand = layoutOf(standardInvoiceLayout().items.filter((i) => !i.id.startsWith("field-footer_")));
    const hung = invChangedAll({
      "field-invoice_date": { anchor: { kind: "below-table", table: "totals" }, box: { ...date, y: offset } },
    }, noBand);
    expect(warnings(hung)).toEqual([{
      itemIds: ["field-invoice_date"],
      sentence: `The ${name("invoice_date")} field ends at ${end} pt, past ${pageFoot(false)}, and would be cut off.`,
    }]);
    // Drawn to end at the foot it is silent.
    const atFoot = invChangedAll({
      "field-invoice_date": { anchor: { kind: "below-table", table: "totals" }, box: { ...date, y: offset - 4 } },
    }, noBand);
    expect(warnings(atFoot)).toEqual([]);
  });

  // Warning (e) at the seed's place (call 2, owner ruling 2026-11-10).
  it("warning (e): the invoice number moved to x 64, still repeated, prints where \"(continued)\" prints", () => {
    const invoiceNo = standardItem("field-invoice_no");
    expect(invoiceNo.repeat).toBe(true);
    expect(warnings(invChanged("field-invoice_no", { box: { ...invoiceNo.box, x: 64 } }))).toEqual([{
      itemIds: ["field-invoice_no"],
      sentence: `The ${name("invoice_no")} field repeats where "(continued)" prints on continuation pages, at the repeat ` +
        "band's bottom-left; the two print over each other.",
    }]);
  });
});

// Task 4 of the statement canvas's PR 1 (design 2026-11-11 §6): the shared rules, run on the
// statement's profile (`STATEMENT_CANVAS`). Every case is green on arrival (the plan's Departure 4).
// A case goes red when the statement's profile entry it reads is edited (a `notFields` key, a
// `leastWidths` entry, `required`, `barcode`, `paper`, `rowFloor`, `firstTableRoom`, a block's
// `keyed`, `heading`, `rows` or `printed`) or when the shared clause it names is deleted. Raising
// `rowFloor` reds every case that draws a fixture block at the floor, and a `required` entry added
// reds every case asked past rule 2's required items, so a title says "(pin)" only where no edit of a
// profile entry reds the case: the shared id, asked before the profile is read.
describe("the canvas rules on a statement (design 2026-11-11 §6)", () => {
  /*
   * Not exercised here: warning (b) and the measured half of (c) judge a measured box past a drawn
   * one, which only PR 2's preview supplies on a statement (one drawn-box (c) case runs below);
   * (f) judges a table printed twice and (g) a grid block, and no statement block is either (none
   * prints twice; the profile names no grid). Every exact-array warning runs on a layout where no
   * other warning fires.
   */
  type Judged = { sentence: string; ids: string[] } | null;
  /** The rules' answer: null when the layout passes, else the refusal and the items it names. */
  function judge(layout: CanvasLayout, contract: TemplateContract = STATEMENT_CONTRACT, options: { pageFooter?: boolean } = {}): Judged {
    try {
      validateCanvasLayout(layout, contract, options);
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateConfigError);
      return { sentence: (error as Error).message, ids: (error as TemplateConfigError).itemIds };
    }
    return null;
  }
  function refusal(layout: CanvasLayout, options: { pageFooter?: boolean } = {}): { sentence: string; ids: string[] } {
    return judge(layout, STATEMENT_CONTRACT, options) ?? expect.fail("the layout was not refused");
  }
  const passes = (layout: CanvasLayout, options: { pageFooter?: boolean } = {}) =>
    expect(() => validateCanvasLayout(layout, STATEMENT_CONTRACT, options)).not.toThrow();
  /** The standard statement layout with items changed (by id). */
  function stmtChangedAll(changes: Record<string, Partial<CanvasItem>>, layout = standardStatementLayout()): CanvasLayout {
    for (const id of Object.keys(changes)) expect(layout.items.some((i) => i.id === id)).toBe(true);
    return layoutOf(layout.items.map((i) => (i.id in changes ? ({ ...i, ...changes[i.id] } as CanvasItem) : i)));
  }
  function stmtChanged(id: string, over: Partial<CanvasItem>): CanvasLayout {
    return stmtChangedAll({ [id]: over });
  }
  /** The warnings, the layout first held to pass every rule. */
  function warnings(layout: CanvasLayout) {
    expect(canvasRefusal(layout, STATEMENT_CONTRACT, { pageFooter: false })).toBeNull();
    return canvasWarnings(layout, STATEMENT_CONTRACT);
  }
  const name = (key: string) => STATEMENT_CONTRACT.sections.flatMap((s) => s.fields).find((f) => f.key === key)!.name;
  const standardItem = (id: string) => standardStatementLayout().items.find((i) => i.id === id)!;
  /** A section's fields as a block's entries, read from the contract (never from `defaultTableColumns`). */
  const sectionEntries = (key: string): CanvasColumn[] => STATEMENT_CONTRACT.sections.find((s) => s.key === key)!.fields
    .map((f) => ({ key: f.key, visible: true, label: null, width: null }));
  const BLOCKS: [StatementTable, string][] = [
    ["bill_to", "Bill-to address"], ["open_items", "Open items"], ["aging", "Aging strip"],
    ["finance_charge", "Finance charge"], ["total", "Total due"],
  ];
  const SECTION_BLOCKS = BLOCKS.filter(([key]) => key !== "bill_to");
  const F = STATEMENT_ROW_FLOOR;
  const clear = { x: 24, y: 300, w: 200, h: 12 }; // under the total's bottom (227.5)
  /** One block placed alone, page-top (a lone block anchored below another trips rule 3). */
  const alone = (key: StatementTable, box: CanvasBox, over: Partial<Extract<CanvasItem, { kind: "table" }>> = {}) =>
    layoutOf([statementTable(key, { anchor: { kind: "page-top" }, box, ...over })]);

  // The empty canvas (§4.3: nothing is required).
  it("an empty layout passes; a cleared page is empty", () => {
    passes(layoutOf([]));
    expect(clearedLayout(STATEMENT_CONTRACT)).toEqual({ version: 1, items: [] });
  });
  it("a barcode is refused by name: a statement prints none", () => {
    expect(refusal(layoutOf([...standardStatementLayout().items, barcode()]))).toEqual({
      sentence: "The canvas has a barcode; a statement prints none.", ids: ["barcode"],
    });
  });

  // Field items: the Bill To and every row of a block are never field items (`notFields`), nor is an
  // aging column (a column of the table "aging"). The keys are listed here, never read from the
  // profile, so a key dropped from `notFields` reds its row rather than taking the row away.
  it.each([
    ["bill_to", "Bill-to address"], ["document_no", "Document number"], ["date", "Document date"],
    ["due_date", "Due date"], ["original", "Original amount"], ["open", "Open amount"],
    ["finance_charge", "Finance charge"], ["total_due", "Total due"],
  ])("the %s field (%s), a block or a block's row, is refused as a field item", (key, fieldName) => {
    expect(name(key)).toBe(fieldName);
    const item = statementField(key, { box: { ...clear } });
    expect(refusal(layoutOf([...standardStatementLayout().items, item]))).toEqual({
      sentence: `The ${fieldName} field is not one the Statement contract places on a canvas.`, ids: [item.id],
    });
  });
  it.each([
    ["aging_current", "Current bucket"], ["aging_1_30", "1–30 bucket"], ["aging_31_60", "31–60 bucket"],
    ["aging_61_90", "61–90 bucket"], ["aging_90_plus", "90+ bucket"], ["aging_unapplied", "Unapplied"], ["aging_net", "Net"],
  ])("the %s aging column (%s) is refused as a field item", (key, fieldName) => {
    expect(name(key)).toBe(fieldName);
    const item = statementField(key, { box: { ...clear } });
    expect(refusal(layoutOf([...standardStatementLayout().items, item]))).toEqual({
      sentence: `The ${fieldName} field is not one the Statement contract places on a canvas.`, ids: [item.id],
    });
  });

  // The blocks' entries: a rows block's rows are its section's fields; the aging's columns its seven;
  // the Bill To, keyed by its field, has none.
  it("defaultTableColumns: each rows block's rows in contract order, the aging's seven columns, none for the Bill To", () => {
    for (const key of ["open_items", "finance_charge", "total"]) {
      expect(defaultTableColumns(STATEMENT_CONTRACT, key)).toEqual(sectionEntries(key));
    }
    expect(defaultTableColumns(STATEMENT_CONTRACT, "aging").map((c) => c.key)).toEqual([
      "aging_current", "aging_1_30", "aging_31_60", "aging_61_90", "aging_90_plus", "aging_unapplied", "aging_net",
    ]);
    expect(defaultTableColumns(STATEMENT_CONTRACT, "aging")).toEqual(sectionEntries("aging"));
    expect(defaultTableColumns(STATEMENT_CONTRACT, "bill_to")).toEqual([]);
  });
  it("rule 1: an open items row given a width is refused; a row has no width", () => {
    const columns = sectionEntries("open_items").map((c) => (c.key === "document_no" ? { ...c, width: 40 } : c));
    expect(refusal(stmtChanged("table-open_items", { columns }))).toEqual({
      sentence: "The Open items table's Document number row carries a width (40 pt); a row has no width.",
      ids: ["table-open_items"],
    });
  });
  it("rule 1: a rows block missing a row or naming one twice is refused by name", () => {
    expect(refusal(stmtChanged("table-open_items", {
      columns: sectionEntries("open_items").filter((c) => c.key !== "due_date"),
    }))).toEqual({ sentence: "The Open items table is missing its Due date row.", ids: ["table-open_items"] });
    expect(refusal(stmtChanged("table-total", { columns: [] }))).toEqual({
      sentence: "The Total due table is missing its Total due row.", ids: ["table-total"],
    });
    const documentNo = sectionEntries("open_items").find((c) => c.key === "document_no")!;
    expect(refusal(stmtChanged("table-open_items", { columns: [...sectionEntries("open_items"), documentNo] }))).toEqual({
      sentence: 'The Open items table names the row "document_no" twice.', ids: ["table-open_items"],
    });
  });
  it("rule 1: the aging missing its Net column is refused by name", () => {
    expect(refusal(stmtChanged("table-aging", {
      columns: sectionEntries("aging").filter((c) => c.key !== "aging_net"),
    }))).toEqual({ sentence: "The Aging strip table is missing its Net column.", ids: ["table-aging"] });
  });
  it.each(SECTION_BLOCKS)("rule 1: the %s block (%s) given a heading is refused; it prints none", (key, blockName) => {
    expect(tableName(STATEMENT_CONTRACT, key)).toBe(blockName);
    expect(refusal(stmtChanged(`table-${key}`, { heading: "Words" }))).toEqual({
      sentence: `The ${blockName} table has the heading "Words", but it prints no heading; only a table with a heading field takes one.`,
      ids: [`table-${key}`],
    });
  });
  it("the Bill To block, keyed by its field, takes a typed heading; the open items given the same are refused", () => {
    expect(tableName(STATEMENT_CONTRACT, "bill_to")).toBe("Bill-to address");
    expect(tableHeadingKey(STATEMENT_CONTRACT, "bill_to")).toBe("bill_to");
    passes(stmtChanged("table-bill_to", { heading: "Mail to" }));
    expect(refusal(stmtChanged("table-open_items", { heading: "Mail to" })).sentence).toBe(
      'The Open items table has the heading "Mail to", but it prints no heading; only a table with a heading field takes one.',
    );
  });

  // Rule 4's least widths (call 12) and the row floor.
  it.each<[StatementTable, string]>([
    ["finance_charge", "Finance charge"], ["total", "Total due"],
  ])("rule 4: the %s block (%s) at its least width passes; 0.1 pt and one point narrower it is refused by name", (key, blockName) => {
    const least = STATEMENT_LEAST_WIDTHS[key];
    // The design's figure (§4.1: the 200 pt label, the 100 pt amount, the two 6 pt gaps and a step).
    expect(least).toBe(316.5);
    const box = standardItem(`table-${key}`).box;
    passes(stmtChanged(`table-${key}`, { box: { ...box, w: least } }));
    for (const narrow of [round2(least - 0.1), least - 1]) {
      expect(refusal(stmtChanged(`table-${key}`, { box: { ...box, w: narrow } }))).toEqual({
        sentence: `The ${blockName} table is ${narrow} pt wide, less than the ${least} pt its fixed parts and one grid step need.`,
        ids: [`table-${key}`],
      });
    }
  });
  it("rule 4: the Bill To, with no least width, passes one grid step wide; the open items at 49.5 (#971); the finance block so drawn is refused", () => {
    expect(Object.hasOwn(STATEMENT_LEAST_WIDTHS, "bill_to")).toBe(false);
    expect(leastWidth(STATEMENT_CONTRACT, statementTable("bill_to"))).toBe(0);
    passes(stmtChanged("table-bill_to", { box: { ...standardItem("table-bill_to").box, w: CANVAS_GRID } }));
    // The open items: the owner's 49.5 (ruling 4, 2026-11-14), their padding and rules on the grid and one step.
    expect(STATEMENT_LEAST_WIDTHS.open_items).toBe(49.5);
    expect(leastWidth(STATEMENT_CONTRACT, statementTable("open_items"))).toBe(49.5);
    const open = standardItem("table-open_items").box;
    passes(stmtChanged("table-open_items", { box: { ...open, w: 49.5 } }));
    expect(refusal(stmtChanged("table-open_items", { box: { ...open, w: 49 } }))).toEqual({
      sentence: "The Open items table is 49 pt wide, less than the 49.5 pt its fixed parts and one grid step need.",
      ids: ["table-open_items"],
    });
    const finance = standardItem("table-finance_charge").box;
    expect(refusal(stmtChanged("table-finance_charge", { box: { ...finance, w: CANVAS_GRID } }))).toEqual({
      sentence: `The Finance charge table is ${CANVAS_GRID} pt wide, less than the ${STATEMENT_LEAST_WIDTHS.finance_charge} pt ` +
        "its fixed parts and one grid step need.",
      ids: ["table-finance_charge"],
    });
  });
  it.each(BLOCKS)("rule 4: the %s block (%s) drawn one row tall passes; under one row it is refused by name", (key, blockName) => {
    const box = standardItem(`table-${key}`).box;
    passes(stmtChanged(`table-${key}`, { box: { ...box, h: F } }));
    expect(refusal(stmtChanged(`table-${key}`, { box: { ...box, h: F - 1 } }))).toEqual({
      sentence: `The ${blockName} table is drawn ${F - 1} pt tall; a table's box is at least ${F} pt, one row.`,
      ids: [`table-${key}`],
    });
  });

  // The held Bill To (`holdsHeight`, design §4.1) prints at least its drawn height; at print that is
  // PR 2's `tableBlock`. No canvas rule reads the entry: the rules judge the profile with it deleted
  // the same, a block drawn taller than its content included. Not a pin: raising the profile's
  // `rowFloor` above STATEMENT_ROW_FLOOR reds it (the fixture's floor-tall blocks are refused).
  it("the held Bill To takes no rule of its own: drawn 200 pt tall it passes, and the rules judge the same with holdsHeight deleted", () => {
    const unheld = structuredClone(STATEMENT_CONTRACT);
    const billSpec = unheld.canvas!.tables.find((t) => t.key === "bill_to")!;
    delete billSpec.holdsHeight;
    expect(Object.hasOwn(STATEMENT_CANVAS.tables.find((t) => t.key === "bill_to")!, "holdsHeight")).toBe(true);
    expect(Object.hasOwn(billSpec, "holdsHeight")).toBe(false);

    const bill = standardItem("table-bill_to").box;
    const grow = 200 - bill.h;
    const below = (id: string) => ({ box: { ...standardItem(id).box, y: standardItem(id).box.y + grow } });
    const tall = stmtChangedAll({
      "table-bill_to": { box: { ...bill, h: 200 } },
      "table-open_items": below("table-open_items"), "table-aging": below("table-aging"),
      "table-finance_charge": below("table-finance_charge"), "table-total": below("table-total"),
    });
    expect(warnings(tall)).toEqual([]);

    const finance = standardItem("table-finance_charge").box;
    const least = STATEMENT_LEAST_WIDTHS.finance_charge;
    const cases: [CanvasLayout, Judged][] = [
      [standardStatementLayout(), null],
      [tall, null],
      [stmtChanged("table-bill_to", { box: { ...bill, h: F } }), null],
      [stmtChanged("table-bill_to", { box: { ...bill, w: CANVAS_GRID } }), null],
      [stmtChanged("table-finance_charge", { box: { ...finance, w: least } }), null],
      [stmtChanged("table-bill_to", { box: { ...bill, h: F - 1 } }), {
        sentence: `The Bill-to address table is drawn ${F - 1} pt tall; a table's box is at least ${F} pt, one row.`,
        ids: ["table-bill_to"],
      }],
      [stmtChanged("table-finance_charge", { box: { ...finance, w: least - 1 } }), {
        sentence: `The Finance charge table is ${least - 1} pt wide, less than the ${least} pt its fixed parts and one grid step need.`,
        ids: ["table-finance_charge"],
      }],
    ];
    for (const [layout, expected] of cases) {
      expect(judge(layout)).toEqual(expected);
      expect(judge(layout, unheld)).toEqual(expected);
      expect(canvasWarnings(layout, unheld)).toEqual(canvasWarnings(layout, STATEMENT_CONTRACT));
    }
  });

  // Rule 9 and warning (d) on the aging (call 12): rule 9 refuses the visible fixed columns past the
  // box, (d) states the boxed strip's least printed width past it. The aging is placed alone.
  it("rule 9 and warning (d): the aging's two floors are told apart, at the Standard's seven \"*\" columns and at six fixed", () => {
    const y = standardItem("table-aging").box.y;
    const agingAlone = (w: number, columns = sectionEntries("aging")) =>
      alone("aging", { x: 24, y, w, h: F }, { columns });
    const fields = STATEMENT_CONTRACT.sections.find((s) => s.key === "aging")!.fields;
    expect(fields.map((f) => f.column!.defaultWidth)).toEqual(Array(7).fill("*"));
    // Since #971 rule 9's floor is the printed width (its padding and rules) and one grid step, and
    // (d) says where the headings break, from the floor up to the width their widest word needs.
    const printed = round2(tableOverhead("boxed", 7));
    expect(printed).toBeGreaterThan(62);
    expect(leastWidth(STATEMENT_CONTRACT, agingAlone(62).items[0])).toBe(round2(printed + CANVAS_GRID));
    expect(refusal(agingAlone(62)).sentence).toContain(`needs ${round2(printed + CANVAS_GRID)} pt`);
    // Since #971 (d) states the headings (design §7.2): seven shares under the 40.35 pt "Unapplied".
    const names = fields.map((f) => f.name);
    const unapplied = textWidthOf("Unapplied", "Roboto", "bold", 9);
    expect(canvasWarnings(agingAlone(62), STATEMENT_CONTRACT)).toEqual([
      { itemIds: ["table-aging"], sentence: headingsBreak("Aging strip", names, 0, unapplied, printed + 7 * unapplied) },
    ]);
    expect(warnings(agingAlone(round2(printed + CANVAS_GRID)))).toEqual([
      { itemIds: ["table-aging"], sentence: headingsBreak("Aging strip", names, CANVAS_GRID / 7, unapplied, printed + 7 * unapplied) },
    ]);
    expect(warnings(agingAlone(345))).toEqual([]);

    const fixed = sectionEntries("aging").map((c) => (c.key === "aging_net" ? c : { ...c, width: 72 }));
    const sum = fixed.reduce((total, c) => total + (c.width ?? 0), 0);
    expect(sum).toBe(6 * 72);
    const printedFixed = round2(sum + tableOverhead("boxed", 7));
    const floor = round2(printedFixed + CANVAS_GRID);
    expect(refusal(agingAlone(floor - 0.5, fixed))).toEqual({
      sentence: `The Aging strip table needs ${floor} pt: its visible columns' ${sum} pt, their ${round2(printedFixed - sum)} pt of ` +
        `padding and rules and one grid step, more than its ${floor - 0.5} pt.`,
      ids: ["table-aging"],
    });
    // Six fixed: the Net column alone shares, under its "Net" heading word.
    const net = textWidthOf("Net", "Roboto", "bold", 9);
    expect(canvasWarnings(agingAlone(sum, fixed), STATEMENT_CONTRACT)).toEqual([
      { itemIds: ["table-aging"], sentence: headingsBreak("Aging strip", ["Net"], 0, net, printedFixed + net) },
    ]);
    expect(warnings(agingAlone(floor, fixed))).toEqual([
      { itemIds: ["table-aging"], sentence: headingsBreak("Aging strip", ["Net"], CANVAS_GRID, net, printedFixed + net) },
    ]);
    expect(warnings(agingAlone(Math.ceil((printedFixed + net) * 2) / 2, fixed))).toEqual([]);
  });

  // Rule 8's first-block room (call 12), no band item. The box is drawn one row tall, so rule 4's
  // bottom-edge check is silent (the room exceeds the floor).
  it.each<[StatementTable, string]>([
    ["bill_to", "Bill-to address"], ["open_items", "Open items"],
  ])("rule 8: the %s block (%s) placed alone too low for its heading and one row is refused; at the room it passes", (key, blockName) => {
    // Across where the standard arrangement draws it (the Bill To at x 64, 262 wide; the open items
    // across the content).
    const { x, w } = standardItem(`table-${key}`).box;
    expect(firstTableRoom(STATEMENT_CONTRACT)).toBe(STATEMENT_FIRST_TABLE_ROOM);
    expect(STATEMENT_FIRST_TABLE_ROOM).toBeGreaterThan(F);
    const edge = pageFoot(false) - STATEMENT_FIRST_TABLE_ROOM;
    const at = (y: number) => alone(key, { x, y, w, h: F });
    expect(refusal(at(edge + 1))).toEqual({
      sentence: `The ${blockName} table starts at ${edge + 1} pt, too low for its heading and one row ` +
        `(${STATEMENT_FIRST_TABLE_ROOM} pt) above ${pageFoot(false)}.`,
      ids: [`table-${key}`],
    });
    passes(at(edge));
  });

  // Rule 2 (§6): every id its own, each block and the logo placed once, and no text block: the
  // statement has no wording.
  it("rule 2: the customer given the Remit To box's id is refused; every item has an id of its own (pin)", () => {
    const id = standardItem("field-remit_to").id;
    expect(refusal(stmtChanged("field-customer", { id }))).toEqual({
      sentence: `Two items share the id "${id}": a field and a field; every item has an id of its own.`, ids: [id],
    });
  });
  it("rule 2: the aging placed twice is refused, naming both", () => {
    const again = statementTable("aging", { id: "table-aging-2", box: { x: 24, y: 300, w: 564, h: F } });
    expect(refusal(layoutOf([...standardStatementLayout().items, again]))).toEqual({
      sentence: "The Aging strip table is placed twice; a table prints once.", ids: ["table-aging", again.id],
    });
  });
  it("rule 2: a second logo is refused, naming both", () => {
    const first = logo({ box: { x: 24, y: 300, w: 80, h: 40 } });
    const second = logo({ id: "logo-2", box: { x: 120, y: 300, w: 80, h: 40 } });
    expect(refusal(layoutOf([...standardStatementLayout().items, first, second]))).toEqual({
      sentence: `The ${STATIC_NAMES.logo} (logo logo-2) is placed twice; the logo prints once.`, ids: ["logo", "logo-2"],
    });
  });
  it("rule 2: a text-block item is refused: the statement's contract has no wording", () => {
    expect(STATEMENT_CONTRACT.textBlocks).toEqual([]);
    const wording: CanvasItem = {
      id: "text-w", kind: "textBlock", key: "w", box: { ...clear }, anchor: { kind: "page-top" }, repeat: false,
      style: { size: 9, bold: false, align: "left" },
    };
    expect(refusal(layoutOf([...standardStatementLayout().items, wording]))).toEqual({
      sentence: 'The wording with the key "w" (textBlock text-w) is not one the Statement contract has.', ids: ["text-w"],
    });
  });

  // Rule 3's anchors and repeats (§6).
  it("rule 3: the statement date anchored below the unplaced aging is refused by name", () => {
    // The aging removed, the layout passes: a table's anchor is derived and rule 3 reads only the
    // other items' anchors, so the finance block's stored anchor below the aging breaks nothing (it is
    // re-anchored below the open items only to keep it the stack's). The statement date anchored
    // below the aging is then the one item that breaks the rule.
    const withoutAging = stmtChangedAll(
      { "table-finance_charge": { anchor: { kind: "below-table", table: "open_items" } } },
      layoutOf(standardStatementLayout().items.filter((i) => i.id !== "table-aging")),
    );
    passes(withoutAging);
    const layout = stmtChangedAll(
      { "field-statement_date": { anchor: { kind: "below-table", table: "aging" }, box: { x: 64, y: CANVAS_GRID, w: 262, h: 12 } } },
      withoutAging,
    );
    expect(refusal(layout)).toEqual({
      sentence: `The ${name("statement_date")} field is anchored below the Aging strip table, which the canvas does not place.`,
      ids: ["field-statement_date"],
    });
  });
  it("rule 3: the total set to repeat is refused; a table prints once", () => {
    expect(refusal(stmtChanged("table-total", { repeat: true }))).toEqual({
      sentence: "The Total due table is set to repeat on every page; a table prints once, where it is drawn.",
      ids: ["table-total"],
    });
  });
  it("rule 3: the Remit To box anchored below the Bill To that repeats is refused by name", () => {
    const remit = standardItem("field-remit_to").box;
    expect(refusal(stmtChanged("field-remit_to", {
      anchor: { kind: "below-table", table: "bill_to" }, box: { ...remit, y: 0 }, repeat: true,
    }))).toEqual({
      sentence: `The ${name("remit_to")} field repeats on every page but is anchored below the Bill-to address table; ` +
        "only an item at the page's top repeats.",
      ids: ["field-remit_to"],
    });
  });

  // Rule 3's repeat set (§4.4): the customer repeats and ends at least one grid step above the first
  // block, the Bill To. Moved down to end one step above it, the customer crosses the statement date,
  // so that layout is judged by the rules alone (warning (a) would fire on it).
  it("rule 3: the customer repeats only ending at least one grid step above the Bill To's top", () => {
    const customer = standardItem("field-customer");
    expect(customer.repeat).toBe(true);
    const billTop = standardItem("table-bill_to").box.y;
    const at = (bottom: number) => stmtChanged("field-customer", { box: { ...customer.box, y: bottom - customer.box.h } });
    passes(at(billTop - CANVAS_GRID));
    expect(refusal(at(billTop - 3))).toEqual({
      sentence: `The ${name("customer")} field repeats on every page but ends at ${billTop - 3} pt, less than one grid ` +
        `step (${CANVAS_GRID} pt) above the first table's top at ${billTop}; a repeated item sits above the tables (design §4.5).`,
      ids: ["field-customer", "table-bill_to"],
    });
  });

  // Rule 4, a box outside the page; rule 5, the blocks stack.
  it("rule 4: the open items drawn one grid step in at the content's width lie outside the page", () => {
    const box = standardItem("table-open_items").box;
    const right = CANVAS_PAGE.width - CANVAS_PAGE.margin;
    const x = CANVAS_PAGE.margin + CANVAS_GRID;
    expect(box.w).toBe(right - CANVAS_PAGE.margin);
    expect(refusal(stmtChanged("table-open_items", { box: { ...box, x } }))).toEqual({
      sentence: `The Open items table lies outside the page: its right edge is at ${round2(x + box.w)} pt, past ${right}.`,
      ids: ["table-open_items"],
    });
  });
  it("rule 5: the open items starting one point above the Bill To's bottom overlap it", () => {
    const bill = standardItem("table-bill_to").box;
    const bottom = bill.y + bill.h;
    const items = standardItem("table-open_items").box;
    expect(refusal(stmtChanged("table-open_items", { box: { ...items, y: bottom - 1 } }))).toEqual({
      sentence: `The Bill-to address table and the Open items table overlap: the Open items table starts at ${bottom - 1} pt, ` +
        `above the Bill-to address table's bottom at ${bottom}.`,
      ids: ["table-bill_to", "table-open_items"],
    });
  });

  // Rule 8, a region and the band taller than a page holds (built as the invoice's cases are).
  it("rule 8: the region after the total, an item hung far under it, is taller than a page holds", () => {
    const hung = text("hung", { x: 24, y: 700, w: 200, h: 12 }, { kind: "below-table", table: "total" });
    const layout = layoutOf([...standardStatementLayout().items, hung]);
    const height = hung.box.y + hung.box.h;
    const usable = usableHeight(layout);
    expect(height).toBeGreaterThan(usable);
    expect(refusal(layout)).toEqual({
      sentence: `The region after the Total due table is ${round2(height)} pt tall, more than the ${round2(usable)} pt a page holds under its top margin.`,
      ids: ["table-total"],
    });
  });
  it("rule 8: a page-bottom band taller than a page holds is refused, naming its items", () => {
    const layout = layoutOf([
      statementTable("bill_to", { box: { x: 64, y: 24, w: 262, h: 40 } }),
      statementField("company_name", { anchor: { kind: "page-bottom" }, box: { x: 24, y: 100, w: 244, h: 9 } }),
    ]);
    const band = bandHeight(layout);
    const usable = usableHeight(layout);
    expect(band).toBeGreaterThan(usable);
    expect(refusal(layout)).toEqual({
      sentence: `The page-bottom band is ${round2(band)} pt tall, more than the ${round2(usable)} pt a page holds under its top margin.`,
      ids: ["field-company_name"],
    });
  });

  // Warning (a) on the statement: a field drawn across the Remit To box.
  it("warning (a): the statement date drawn across the Remit To box overlaps it", () => {
    const date = standardItem("field-statement_date").box;
    const remit = standardItem("field-remit_to").box;
    // Half the date's width across the box's left edge.
    const x = remit.x - date.w / 2;
    expect(x + date.w).toBeGreaterThan(remit.x);
    expect(warnings(stmtChanged("field-statement_date", { box: { ...date, x } }))).toEqual([{
      itemIds: ["field-statement_date", "field-remit_to"],
      sentence: `The ${name("statement_date")} field and the ${name("remit_to")} field overlap; one prints over the other.`,
    }]);
  });

  // Warning (c) on drawn boxes, no measure: the statement date hung under the total past the foot.
  // The statement places no band, and the region under the total fits a page (rule 8).
  it("warning (c): the statement date hung under the total, drawn past the foot, would be cut off", () => {
    const total = standardItem("table-total").box;
    const date = standardItem("field-statement_date").box;
    const end = pageFoot(false) + 4;
    const offset = end - (total.y + total.h) - date.h;
    const hung = (y: number) => stmtChanged("field-statement_date", { anchor: { kind: "below-table", table: "total" }, box: { ...date, y } });
    expect(warnings(hung(offset))).toEqual([{
      itemIds: ["field-statement_date"],
      sentence: `The ${name("statement_date")} field ends at ${end} pt, past ${pageFoot(false)}, and would be cut off.`,
    }]);
    // Drawn to end at the foot it is silent.
    expect(warnings(hung(offset - 4))).toEqual([]);
  });

  // Warning (e) at the seed's place (call 2, owner ruling 2026-11-11, option (a)).
  it("warning (e): the customer moved to x 64, still repeated, prints where \"(continued)\" prints", () => {
    const customer = standardItem("field-customer");
    expect(customer.repeat).toBe(true);
    expect(warnings(stmtChanged("field-customer", { box: { ...customer.box, x: 64 } }))).toEqual([{
      itemIds: ["field-customer"],
      sentence: `The ${name("customer")} field repeats where "(continued)" prints on continuation pages, at the repeat ` +
        "band's bottom-left; the two print over each other.",
    }]);
    expect(warnings(standardStatementLayout())).toEqual([]);
  });

  // The page line: with Page N of M on, a page-top item or a table ends by the page line's room.
  it("the total drawn to end at 760 is refused with the page line on; with it off it passes", () => {
    const total = standardItem("table-total").box;
    const end = 760;
    expect(end).toBeGreaterThan(pageFoot(true));
    expect(end).toBeLessThanOrEqual(pageFoot(false));
    const low = stmtChanged("table-total", { box: { ...total, y: end - total.h } });
    expect(refusal(low, { pageFooter: true })).toEqual({
      sentence: `The Total due table lies outside the page: its bottom edge is at ${end} pt, past ${pageFoot(true)}, ` +
        "where the page line's room begins.",
      ids: ["table-total"],
    });
    passes(low, { pageFooter: false });
    passes(standardStatementLayout(), { pageFooter: true });
  });
});

// Task 4 of the quotation canvas's PR 1 (design 2026-11-12 §6): the shared rules, run on the
// quote's profile (`QUOTE_CANVAS`). Every case is green on arrival (the plan's Departure 4), and
// each goes red when the quote's profile entry it reads is edited or when the shared clause it
// names is deleted (the task report names the edit per case). No case is a pin.
describe("the canvas rules on a quote (design 2026-11-12 §6)", () => {
  /*
   * Not exercised here: warning (b) and the measured half of (c) judge a measured box past a drawn
   * one, which the preview's measure supplies on a quote since quote canvas PR 2 (its cases are
   * tests/quote-canvas-seed.test.ts's; one drawn-box (c) case runs below); (f)
   * judges a table printed twice, and no quote block is one. Every exact-array warning runs on a
   * layout where no other warning fires, and every layout a warning case judges passes the rules.
   */
  type Judged = { sentence: string; ids: string[] } | null;
  /** The rules' answer: null when the layout passes, else the refusal and the items it names. */
  function judge(layout: CanvasLayout, options: { pageFooter?: boolean } = {}): Judged {
    try {
      validateCanvasLayout(layout, QUOTE_CONTRACT, options);
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateConfigError);
      return { sentence: (error as Error).message, ids: (error as TemplateConfigError).itemIds };
    }
    return null;
  }
  function refusal(layout: CanvasLayout, options: { pageFooter?: boolean } = {}): { sentence: string; ids: string[] } {
    return judge(layout, options) ?? expect.fail("the layout was not refused");
  }
  const passes = (layout: CanvasLayout, options: { pageFooter?: boolean } = {}) =>
    expect(() => validateCanvasLayout(layout, QUOTE_CONTRACT, options)).not.toThrow();
  /** The standard quote layout with items changed (by id). */
  function quoteChangedAll(changes: Record<string, Partial<CanvasItem>>, layout = standardQuoteLayout()): CanvasLayout {
    for (const id of Object.keys(changes)) expect(layout.items.some((i) => i.id === id)).toBe(true);
    return layoutOf(layout.items.map((i) => (i.id in changes ? ({ ...i, ...changes[i.id] } as CanvasItem) : i)));
  }
  function quoteChanged(id: string, over: Partial<CanvasItem>): CanvasLayout {
    return quoteChangedAll({ [id]: over });
  }
  /** The warnings, the layout first held to pass every rule. */
  function warnings(layout: CanvasLayout) {
    passes(layout);
    expect(canvasRefusal(layout, QUOTE_CONTRACT, { pageFooter: false })).toBeNull();
    return canvasWarnings(layout, QUOTE_CONTRACT);
  }
  const name = (key: string) => QUOTE_CONTRACT.sections.flatMap((s) => s.fields).find((f) => f.key === key)!.name;
  const standardItem = (id: string) => standardQuoteLayout().items.find((i) => i.id === id)!;
  /** A section's fields as a block's entries, read from the contract (never from `defaultTableColumns`). */
  const sectionEntries = (key: string): CanvasColumn[] => QUOTE_CONTRACT.sections.find((s) => s.key === key)!.fields
    .map((f) => ({ key: f.key, visible: true, label: null, width: null }));
  const BLOCKS: [QuoteTable, string][] = [
    ["parties", "Attention / quote fields"], ["intro", "Intro line"], ["column_header", "Column headers"],
    ["lines", "Quote lines and prices"], ["closing", "Closing and signature"], ["liability", "Liability text"],
  ];
  /** The rows blocks with the design's least widths (§4.1, call 9), asserted as the design's figures. */
  const ROWS_BLOCKS: [QuoteTable, string, number][] = [
    ["parties", "Attention / quote fields", 252.5], ["lines", "Quote lines and prices", 230.5],
    ["closing", "Closing and signature", 246.5],
  ];
  const F = QUOTE_ROW_FLOOR;
  const clear = { x: 24, y: 300, w: 200, h: 12 }; // under the liability's bottom (206)
  /** One block placed alone, page-top (a lone block anchored below another trips rule 3). */
  const alone = (key: QuoteTable, box: CanvasBox, over: Partial<Extract<CanvasItem, { kind: "table" }>> = {}) =>
    layoutOf([quoteTable(key, { anchor: { kind: "page-top" }, box, ...over })]);
  /** A text-block item placing a wording, under the liability. */
  const wording = (key: string): CanvasItem => ({
    id: `text-${key}`, kind: "textBlock", key, box: { ...clear }, anchor: { kind: "page-top" }, repeat: false,
    style: { size: 9, bold: false, align: "left" },
  });

  // The empty canvas (§4.3: nothing is required).
  it("an empty layout passes; a cleared page is empty", () => {
    passes(layoutOf([]));
    expect(clearedLayout(QUOTE_CONTRACT)).toEqual({ version: 1, items: [] });
  });
  it("a barcode is refused by name: a quote prints none", () => {
    expect(refusal(layoutOf([...standardQuoteLayout().items, barcode()]))).toEqual({
      sentence: "The canvas has a barcode; a quote prints none.", ids: ["barcode"],
    });
  });

  // Field items: every row of a rows block is never a field item (`notFields`), nor is a column
  // header (a column of the table "columns"). The keys are listed here, never read from the profile,
  // so a key dropped from `notFields` reds its row rather than taking the row away.
  it.each([
    "attn", "bill_to", "company_phone", "effective", "expires", "terms", "rfq_number", "customer_phone",
    "line_qty", "line_part", "line_each_weight", "line_total_lbs", "material", "price_heading", "step_name",
    "step_notes", "price_amount", "setup_charge", "price_per", "minimum_charge", "breaks", "surcharge_estimate",
    "ending_statement", "quote_notes", "signer_name", "signer_title",
  ])("the %s field, a block's row, is refused as a field item", (key) => {
    const item = quoteField(key, { box: { ...clear } });
    expect(refusal(layoutOf([...standardQuoteLayout().items, item]))).toEqual({
      sentence: `The ${name(key)} field is not one the Quotation contract places on a canvas.`, ids: [item.id],
    });
  });
  it.each(["col_qty", "col_info", "col_each_weight", "col_amount"])("the %s column header is refused as a field item", (key) => {
    const item = quoteField(key, { box: { ...clear } });
    expect(refusal(layoutOf([...standardQuoteLayout().items, item]))).toEqual({
      sentence: `The ${name(key)} field is not one the Quotation contract places on a canvas.`, ids: [item.id],
    });
  });

  // The blocks' entries: a rows block's rows are its section's fields; the column headers' columns
  // are the four fields of the table "columns" (`columnTable`); the intro and the liability have none.
  it("defaultTableColumns: each rows block's rows in contract order, the column headers' four grid fields, none for the two wordings", () => {
    for (const [key] of ROWS_BLOCKS) expect(defaultTableColumns(QUOTE_CONTRACT, key)).toEqual(sectionEntries(key));
    expect(defaultTableColumns(QUOTE_CONTRACT, "column_header").map((c) => c.key))
      .toEqual(["col_qty", "col_info", "col_each_weight", "col_amount"]);
    expect(defaultTableColumns(QUOTE_CONTRACT, "column_header")).toEqual(sectionEntries("column_header"));
    expect(defaultTableColumns(QUOTE_CONTRACT, "intro")).toEqual([]);
    expect(defaultTableColumns(QUOTE_CONTRACT, "liability")).toEqual([]);
  });
  it("rule 1: a quote lines row given a width is refused; a row has no width", () => {
    const columns = sectionEntries("lines").map((c) => (c.key === "line_qty" ? { ...c, width: 40 } : c));
    expect(refusal(quoteChanged("table-lines", { columns }))).toEqual({
      sentence: "The Quote lines and prices table's Quoted quantity row carries a width (40 pt); a row has no width.",
      ids: ["table-lines"],
    });
  });
  it("rule 1: a rows block missing a row or naming one twice is refused by name", () => {
    expect(refusal(quoteChanged("table-lines", {
      columns: sectionEntries("lines").filter((c) => c.key !== "surcharge_estimate"),
    }))).toEqual({ sentence: "The Quote lines and prices table is missing its Surcharge estimate row.", ids: ["table-lines"] });
    expect(refusal(quoteChanged("table-closing", { columns: [] }))).toEqual({
      sentence: "The Closing and signature table is missing its Ending statement row.", ids: ["table-closing"],
    });
    const attn = sectionEntries("parties").find((c) => c.key === "attn")!;
    expect(refusal(quoteChanged("table-parties", { columns: [...sectionEntries("parties"), attn] }))).toEqual({
      sentence: 'The Attention / quote fields table names the row "attn" twice.', ids: ["table-parties"],
    });
  });
  it("rule 1: the column headers missing their Amount column are refused by name", () => {
    // The shared sentence as the leaf writes it: the field's name ends in "column".
    expect(refusal(quoteChanged("table-column_header", {
      columns: sectionEntries("column_header").filter((c) => c.key !== "col_amount"),
    }))).toEqual({ sentence: "The Column headers table is missing its Amount column column.", ids: ["table-column_header"] });
  });
  it.each(BLOCKS)("rule 1: the %s block (%s) given a heading is refused; it prints none", (key, blockName) => {
    expect(tableName(QUOTE_CONTRACT, key)).toBe(blockName);
    expect(QUOTE_CONTRACT.sections.find((s) => s.key === key)!.name).toBe(blockName);
    expect(refusal(quoteChanged(`table-${key}`, { heading: "Words" }))).toEqual({
      sentence: `The ${blockName} table has the heading "Words", but it prints no heading; only a table with a heading field takes one.`,
      ids: [`table-${key}`],
    });
  });

  // Rule 4's least widths (call 9) and the row floor.
  it.each(ROWS_BLOCKS)("rule 4: the %s block (%s) at its least width passes; 0.1 pt narrower it is refused by name", (key, blockName, design) => {
    const least = QUOTE_LEAST_WIDTHS[key];
    expect(least).toBe(design);
    const box = standardItem(`table-${key}`).box;
    passes(quoteChanged(`table-${key}`, { box: { ...box, w: least } }));
    const narrow = round2(least - 0.1);
    // The lines read their floor from the column headers' columns (#971 design §6.1), and their
    // sentence names them; at the Standard's columns it is their entry.
    const needs = key === "lines"
      ? "the column headers' columns, their gaps and one grid step need." : "its fixed parts and one grid step need.";
    expect(refusal(quoteChanged(`table-${key}`, { box: { ...box, w: narrow } }))).toEqual({
      sentence: `The ${blockName} table is ${narrow} pt wide, less than the ${least} pt ${needs}`,
      ids: [`table-${key}`],
    });
  });
  it("rule 4: the intro and the liability, with no least width, pass one grid step wide; the parties so drawn are refused", () => {
    for (const key of ["intro", "liability"] as const) {
      expect(Object.hasOwn(QUOTE_LEAST_WIDTHS, key)).toBe(false);
      expect(leastWidth(QUOTE_CONTRACT, quoteTable(key))).toBe(0);
      const box = standardItem(`table-${key}`).box;
      passes(quoteChanged(`table-${key}`, { box: { ...box, w: CANVAS_GRID } }));
    }
    const parties = standardItem("table-parties").box;
    expect(refusal(quoteChanged("table-parties", { box: { ...parties, w: CANVAS_GRID } }))).toEqual({
      sentence: `The Attention / quote fields table is ${CANVAS_GRID} pt wide, less than the ${QUOTE_LEAST_WIDTHS.parties} pt ` +
        "its fixed parts and one grid step need.",
      ids: ["table-parties"],
    });
  });
  it.each(BLOCKS)("rule 4: the %s block (%s) drawn one row tall passes; under one row it is refused by name", (key, blockName) => {
    const box = standardItem(`table-${key}`).box;
    expect(box.h).toBe(F);
    passes(quoteChanged(`table-${key}`, { box: { ...box, h: F } }));
    expect(refusal(quoteChanged(`table-${key}`, { box: { ...box, h: F - 1 } }))).toEqual({
      sentence: `The ${blockName} table is drawn ${F - 1} pt tall; a table's box is at least ${F} pt, one row.`,
      ids: [`table-${key}`],
    });
  });

  // Rule 9 and warning (d) on the column headers: rule 9 refuses the visible fixed columns past the
  // box, (d) states the boxed strip's least printed width past it. The column headers are placed
  // alone, so no grid block can be warned by (g) beside (d).
  it("rule 9 and warning (d): the column headers' two floors are told apart; hiding Each weight lowers both", () => {
    const fields = QUOTE_CONTRACT.sections.find((s) => s.key === "column_header")!.fields;
    const fixed = (hidden: string[]) => fields.filter((f) => !hidden.includes(f.key))
      .reduce((sum, f) => sum + (f.column!.defaultWidth === "*" ? 0 : f.column!.defaultWidth), 0);
    const y = standardItem("table-column_header").box.y;
    const headersAlone = (w: number, columns = sectionEntries("column_header")) =>
      alone("column_header", { x: 24, y, w, h: F }, { columns });
    // Since #971 rule 9's floor is the printed width and one grid step, and (d) says where the headings
    // break, from the floor up to the width their widest word needs.
    const all = fixed([]);
    expect(all).toBe(202);
    const printed = round2(all + tableOverhead("boxed", 4));
    const floor = round2(printed + CANVAS_GRID);
    expect(refusal(headersAlone(floor - 0.5))).toEqual({
      sentence: `The Column headers table needs ${floor} pt: its visible columns' ${all} pt, their ${round2(printed - all)} pt of ` +
        `padding and rules and one grid step, more than its ${floor - 0.5} pt.`,
      ids: ["table-column_header"],
    });
    // Since #971 (d) states the headings (design §7.2): the Information column's widest heading
    // word, "Description /" (no break before a "/"), at 9 pt.
    const head = textWidthOf("Description /", "Roboto", "bold", 9);
    const said = (share: number, fixedPrinted: number) =>
      [{ itemIds: ["table-column_header"], sentence: headingsBreak("Column headers", ["Information column"], share, head, fixedPrinted + head) }];
    expect(canvasWarnings(headersAlone(all), QUOTE_CONTRACT)).toEqual(said(0, printed));
    expect(warnings(headersAlone(floor))).toEqual(said(4.5, printed));
    expect(warnings(headersAlone(Math.ceil((printed + head) * 2) / 2))).toEqual([]);

    const hidden = sectionEntries("column_header").map((c) => (c.key === "col_each_weight" ? { ...c, visible: false } : c));
    const less = fixed(["col_each_weight"]);
    const eachWeight = fields.find((f) => f.key === "col_each_weight")!.column!.defaultWidth;
    expect(less).toBe(all - (eachWeight as number));
    const printedLess = round2(less + tableOverhead("boxed", 3));
    const floorLess = round2(printedLess + CANVAS_GRID);
    expect(refusal(headersAlone(floorLess - 0.5, hidden))).toEqual({
      sentence: `The Column headers table needs ${floorLess} pt: its visible columns' ${less} pt, their ${round2(printedLess - less)} pt ` +
        `of padding and rules and one grid step, more than its ${floorLess - 0.5} pt.`,
      ids: ["table-column_header"],
    });
    expect(canvasWarnings(headersAlone(less, hidden), QUOTE_CONTRACT)).toEqual(said(0, printedLess));
    expect(warnings(headersAlone(floorLess, hidden))).toEqual(said(4.5, printedLess));
    expect(warnings(headersAlone(Math.ceil((printedLess + head) * 2) / 2, hidden))).toEqual([]);
  });

  // Rule 2 (§6): each block and the logo placed once, and no wording placed on its own: the quote's
  // two wordings print inside the intro and the liability (`textBlocks`).
  it("rule 2: the quote lines placed twice are refused, naming both", () => {
    const again = quoteTable("lines", { id: "table-lines-2", box: { x: 24, y: 300, w: 564, h: F } });
    expect(refusal(layoutOf([...standardQuoteLayout().items, again]))).toEqual({
      sentence: "The Quote lines and prices table is placed twice; a table prints once.", ids: ["table-lines", again.id],
    });
  });
  it("rule 2: a second logo is refused, naming both", () => {
    const first = logo({ box: { x: 24, y: 300, w: 80, h: 40 } });
    const second = logo({ id: "logo-2", box: { x: 120, y: 300, w: 80, h: 40 } });
    expect(refusal(layoutOf([...standardQuoteLayout().items, first, second]))).toEqual({
      sentence: `The ${STATIC_NAMES.logo} (logo logo-2) is placed twice; the logo prints once.`, ids: ["logo", "logo-2"],
    });
  });
  it.each([
    ["quote_intro_text", "Intro line"], ["quote_liability_text", "Liability text"],
  ])("rule 2: the %s wording placed on its own is refused: it prints inside the %s table", (key, blockName) => {
    const item = wording(key);
    expect(refusal(layoutOf([...standardQuoteLayout().items, item]))).toEqual({
      sentence: `The ${blockName} wording prints inside the ${blockName} table; it is edited on the Wording tab, never placed on its own.`,
      ids: [item.id],
    });
  });
  it("rule 2: a text-block item naming a wording the quote has not is refused", () => {
    expect(refusal(layoutOf([...standardQuoteLayout().items, wording("w")]))).toEqual({
      sentence: 'The wording with the key "w" (textBlock text-w) is not one the Quotation contract has.', ids: ["text-w"],
    });
  });

  // Rule 3's anchors and repeats (§6).
  it("rule 3: the company address anchored below the unplaced closing is refused by name", () => {
    // The closing removed, the layout passes: a table's anchor is derived and rule 3 reads only the
    // other items' anchors (the liability re-anchored below the lines only to keep it the stack's).
    const withoutClosing = quoteChangedAll(
      { "table-liability": { anchor: { kind: "below-table", table: "lines" } } },
      layoutOf(standardQuoteLayout().items.filter((i) => i.id !== "table-closing")),
    );
    passes(withoutClosing);
    const address = standardItem("field-company_address").box;
    const layout = quoteChangedAll(
      { "field-company_address": { anchor: { kind: "below-table", table: "closing" }, box: { ...address, y: CANVAS_GRID } } },
      withoutClosing,
    );
    expect(refusal(layout)).toEqual({
      sentence: `The ${name("company_address")} field is anchored below the Closing and signature table, which the canvas does not place.`,
      ids: ["field-company_address"],
    });
  });
  it("rule 3: the liability set to repeat is refused; a table prints once", () => {
    expect(refusal(quoteChanged("table-liability", { repeat: true }))).toEqual({
      sentence: "The Liability text table is set to repeat on every page; a table prints once, where it is drawn.",
      ids: ["table-liability"],
    });
  });
  it("rule 3: the company name anchored below the parties that repeats is refused by name", () => {
    const company = standardItem("field-company_name").box;
    expect(refusal(quoteChanged("field-company_name", {
      anchor: { kind: "below-table", table: "parties" }, box: { ...company, y: 0 }, repeat: true,
    }))).toEqual({
      sentence: `The ${name("company_name")} field repeats on every page but is anchored below the Attention / quote fields table; ` +
        "only an item at the page's top repeats.",
      ids: ["field-company_name"],
    });
  });

  // Rule 3's repeat set (§4.4): the quotation number repeats and ends at least one grid step above
  // the first block, the parties.
  it("rule 3: the quotation number repeats only ending at least one grid step above the parties' top", () => {
    const quoteNo = standardItem("field-quote_number");
    expect(quoteNo.repeat).toBe(true);
    const partiesTop = standardItem("table-parties").box.y;
    const at = (bottom: number) => quoteChanged("field-quote_number", { box: { ...quoteNo.box, y: bottom - quoteNo.box.h } });
    passes(at(partiesTop - CANVAS_GRID));
    expect(refusal(at(partiesTop - 3))).toEqual({
      sentence: `The ${name("quote_number")} field repeats on every page but ends at ${partiesTop - 3} pt, less than one grid ` +
        `step (${CANVAS_GRID} pt) above the first table's top at ${partiesTop}; a repeated item sits above the tables (design §4.5).`,
      ids: ["field-quote_number", "table-parties"],
    });
  });

  // Rule 4, a box outside the page; rule 5, the blocks stack.
  it("rule 4: the quote lines drawn one grid step in at the content's width lie outside the page", () => {
    const box = standardItem("table-lines").box;
    const right = CANVAS_PAGE.width - CANVAS_PAGE.margin;
    const x = CANVAS_PAGE.margin + CANVAS_GRID;
    expect(box.w).toBe(right - CANVAS_PAGE.margin);
    expect(round2(x + box.w)).toBe(592.5);
    expect(refusal(quoteChanged("table-lines", { box: { ...box, x } }))).toEqual({
      sentence: `The Quote lines and prices table lies outside the page: its right edge is at ${round2(x + box.w)} pt, past ${right}.`,
      ids: ["table-lines"],
    });
  });
  it("rule 5: the intro starting one point above the parties' bottom overlaps them", () => {
    const parties = standardItem("table-parties").box;
    const bottom = parties.y + parties.h;
    const intro = standardItem("table-intro").box;
    expect(refusal(quoteChanged("table-intro", { box: { ...intro, y: bottom - 1 } }))).toEqual({
      sentence: `The Attention / quote fields table and the Intro line table overlap: the Intro line table starts at ${bottom - 1} pt, ` +
        `above the Attention / quote fields table's bottom at ${bottom}.`,
      ids: ["table-parties", "table-intro"],
    });
  });

  // Rule 8's first-block room (design 2026-11-12 §4.1; the owner's 2026-11-12 ruling, the statement design's
  // call 12, keeping Roboto's room), no band item, with the page line off (foot 768) and on (748).
  // The box is drawn one row tall, so rule 4's bottom-edge check is silent (the room exceeds the floor).
  it.each([false, true])("rule 8: the parties placed alone too low for their heading and one row are refused; at the room they pass (page line %s)", (pageFooter) => {
    expect(firstTableRoom(QUOTE_CONTRACT)).toBe(QUOTE_FIRST_TABLE_ROOM);
    expect(QUOTE_FIRST_TABLE_ROOM).toBeGreaterThan(F);
    const foot = pageFoot(pageFooter);
    expect(foot).toBe(pageFooter ? 748 : 768);
    const edge = foot - QUOTE_FIRST_TABLE_ROOM;
    const at = (y: number) => alone("parties", { x: 24, y, w: 564, h: F });
    expect(refusal(at(edge + 1), { pageFooter })).toEqual({
      sentence: `The Attention / quote fields table starts at ${edge + 1} pt, too low for its heading and one row ` +
        `(${QUOTE_FIRST_TABLE_ROOM} pt) above ${foot}.`,
      ids: ["table-parties"],
    });
    passes(at(edge), { pageFooter });
  });

  // Rule 8, a region and the band taller than a page holds (built as the statement's cases are).
  it("rule 8: the region after the liability, an item hung far under it, is taller than a page holds", () => {
    // Hung as far under the liability as the page holds under the quote's top margin (its repeated
    // quotation number), so the region passes it by its own 12 pt.
    const y = Math.ceil(usableHeight(standardQuoteLayout()));
    const hung = text("hung", { x: 24, y, w: 200, h: 12 }, { kind: "below-table", table: "liability" });
    const layout = layoutOf([...standardQuoteLayout().items, hung]);
    const height = hung.box.y + hung.box.h;
    const usable = usableHeight(layout);
    expect(height).toBeGreaterThan(usable);
    expect(refusal(layout)).toEqual({
      sentence: `The region after the Liability text table is ${round2(height)} pt tall, more than the ${round2(usable)} pt a page holds under its top margin.`,
      ids: ["table-liability"],
    });
  });
  it("rule 8: a page-bottom band taller than a page holds is refused, naming its items", () => {
    const layout = layoutOf([
      quoteTable("parties", { box: { x: 24, y: 24, w: 564, h: 40 } }),
      quoteField("company_name", { anchor: { kind: "page-bottom" }, box: { x: 24, y: 100, w: 244, h: 9 } }),
    ]);
    const band = bandHeight(layout);
    const usable = usableHeight(layout);
    expect(band).toBeGreaterThan(usable);
    expect(refusal(layout)).toEqual({
      sentence: `The page-bottom band is ${round2(band)} pt tall, more than the ${round2(usable)} pt a page holds under its top margin.`,
      ids: ["field-company_name"],
    });
  });

  // Warning (a) on the quote: the company name drawn onto the quotation number's box, clear of the
  // title (x 202 to 410).
  it("warning (a): the company name drawn onto the quotation number's box overlaps it", () => {
    const quoteNo = standardItem("field-quote_number").box;
    const company = standardItem("field-company_name").box;
    const title = standardItem("field-title").box;
    expect(quoteNo.x).toBeGreaterThan(title.x + title.w);
    expect(warnings(quoteChanged("field-company_name", { box: { ...company, x: quoteNo.x, y: quoteNo.y, w: quoteNo.w } }))).toEqual([{
      itemIds: ["field-company_name", "field-quote_number"],
      sentence: `The ${name("company_name")} field and the ${name("quote_number")} field overlap; one prints over the other.`,
    }]);
  });

  // Warning (c) on drawn boxes, no measure: the company address hung under the liability past the
  // foot. The quote places no band, and the region under the liability fits a page (rule 8).
  it("warning (c): the company address hung under the liability, drawn past the foot, would be cut off", () => {
    const liability = standardItem("table-liability").box;
    const address = standardItem("field-company_address").box;
    const end = pageFoot(false) + 4;
    const offset = end - (liability.y + liability.h) - address.h;
    const hung = (y: number) => quoteChanged("field-company_address", {
      anchor: { kind: "below-table", table: "liability" }, box: { ...address, y },
    });
    expect(warnings(hung(offset))).toEqual([{
      itemIds: ["field-company_address"],
      sentence: `The ${name("company_address")} field ends at ${end} pt, past ${pageFoot(false)}, and would be cut off.`,
    }]);
    // Drawn to end at the foot it is silent.
    expect(warnings(hung(offset - 4))).toEqual([]);
  });

  // Warning (e) at the seed's place (call 2, owner ruling 2026-11-12, option (a)).
  it("warning (e): the quotation number moved to x 24, still repeated, prints where \"(continued)\" prints; clear of it, nothing", () => {
    const quoteNo = standardItem("field-quote_number");
    expect(quoteNo.repeat).toBe(true);
    expect(warnings(quoteChanged("field-quote_number", { box: { ...quoteNo.box, x: 24 } }))).toEqual([{
      itemIds: ["field-quote_number"],
      sentence: `The ${name("quote_number")} field repeats where "(continued)" prints on continuation pages, at the repeat ` +
        "band's bottom-left; the two print over each other.",
    }]);
    // Clear of "(continued)" (x 24 to 84) and ending before the title's 202, at its 170 width it would
    // cross the title and warn (a).
    const title = standardItem("field-title").box;
    const continued = continuedBox(standardQuoteLayout())!;
    const x = 85.5;
    expect(x).toBeGreaterThan(continued.x + continued.w);
    expect(x + 112.5).toBeLessThan(title.x);
    expect(warnings(quoteChanged("field-quote_number", { box: { ...quoteNo.box, x, w: 112.5 } }))).toEqual([]);
    expect(warnings(standardQuoteLayout())).toEqual([]);
  });

  // Warning (g) (call 1): the quote lines print under the column headers' columns (`grid`), reading
  // no edge, so their left edge and, while a "*" column shows, their width are judged; with none
  // shown, a lines block drawn narrower than the columns and gaps it prints is warned instead.
  const linesSentence = "The Quote lines and prices table prints under the Column headers table's columns, but is drawn " +
    "at another left edge or width, so its columns do not line up under them.";
  /** The standard quote layout with the column headers' Information column ("*") changed. */
  function infoColumn(change: Partial<CanvasColumn>): CanvasLayout {
    const layout = standardQuoteLayout();
    const headers = layout.items.find((i) => i.id === "table-column_header") as Extract<CanvasItem, { kind: "table" }>;
    expect(headers.columns.filter((c) => c.key === "col_info")).toEqual([{ key: "col_info", visible: true, label: null, width: null }]);
    const columns = headers.columns.map((c) => (c.key === "col_info" ? { ...c, ...change } : c));
    return layoutOf(layout.items.map((i) => (i.id === headers.id ? { ...headers, columns } : i)));
  }
  it("warning (g): the quote lines drawn 6 pt right of the column headers, as wide as them, are out of line", () => {
    // Both blocks 558 wide, the headers at x 24 and the lines at x 30, so (g)'s width half cannot fire:
    // the case is the left-edge half alone.
    const headers = standardItem("table-column_header").box;
    const lines = standardItem("table-lines").box;
    expect(warnings(quoteChangedAll({
      "table-column_header": { box: { ...headers, x: 24, w: 558 } },
      "table-lines": { box: { ...lines, x: 30, w: 558 } },
    }))).toEqual([{ itemIds: ["table-lines"], sentence: linesSentence }]);
  });
  it("warning (g): the quote lines at the column headers' left edge and another width, the Information column \"*\", are out of line", () => {
    const lines = standardItem("table-lines").box;
    expect(warnings(quoteChanged("table-lines", { box: { ...lines, x: 24, w: 564 - CANVAS_GRID } })))
      .toEqual([{ itemIds: ["table-lines"], sentence: linesSentence }]);
  });
  it("warning (g): with no \"*\" column, the quote lines drawn narrower than the columns and gaps they print are rule 4's to refuse; as wide, nothing", () => {
    const layout = infoColumn({ width: 300 });
    const headers = layout.items.find((i) => i.id === "table-column_header") as Extract<CanvasItem, { kind: "table" }>;
    const fields = QUOTE_CONTRACT.sections.find((s) => s.key === "column_header")!.fields;
    const shown = headers.columns.filter((c) => c.visible);
    const widths = shown.map((c) => c.width ?? (fields.find((f) => f.key === c.key)!.column!.defaultWidth as number));
    const gap = QUOTE_CANVAS.tables.find((t) => t.key === "lines")!.gridGap!;
    const least = widths.reduce((sum, w) => sum + w, 0) + gap * (shown.length - 1);
    expect(least).toBe(520);
    const lines = standardItem("table-lines").box;
    const drawn = (w: number) => quoteChangedAll({ "table-lines": { box: { ...lines, x: 24, w } } }, layout);
    // Since #971 rule 4 refuses a grid block under its grid's columns, gaps and one grid step (design
    // §6.1), and (g)'s clause for a block narrower than its columns, reached only there, is retired
    // (#971 Task 6): rule 4's sentence is the one the designer shows.
    expect(refusal(drawn(504))).toEqual({
      sentence: `The Quote lines and prices table is 504 pt wide, less than the ${least + CANVAS_GRID} pt the column headers' ` +
        "columns, their gaps and one grid step need.",
      ids: ["table-lines"],
    });
    expect(canvasWarnings(drawn(504), QUOTE_CONTRACT)).toEqual([]);
    // The width alone is not judged with no "*" column shown.
    expect(warnings(drawn(least + CANVAS_GRID))).toEqual([]);
  });

  // The page line: with Page N of M on, a table ends by the page line's room.
  it("the liability drawn to end at 760 is refused with the page line on; with it off it passes", () => {
    const liability = standardItem("table-liability").box;
    const end = 760;
    expect(end).toBeGreaterThan(pageFoot(true));
    expect(end).toBeLessThanOrEqual(pageFoot(false));
    const low = quoteChanged("table-liability", { box: { ...liability, y: end - liability.h } });
    expect(refusal(low, { pageFooter: true })).toEqual({
      sentence: `The Liability text table lies outside the page: its bottom edge is at ${end} pt, past ${pageFoot(true)}, ` +
        "where the page line's room begins.",
      ids: ["table-liability"],
    });
    passes(low, { pageFooter: false });
    passes(standardQuoteLayout(), { pageFooter: true });
  });
});

describe("the raised least widths (#971)", () => {
  type Row = { doc: PaperDoc; key: string; fixed: number; overhead: number; beside: number; copies: 1 | 2; least: number };
  // Design §6's second table, at each table's standard columns (Task 2 Step 1 held it to the code).
  const ROWS: Row[] = [
    { doc: "TRAVELER", key: "lines", fixed: 244, overhead: 32, beside: 0, copies: 1, least: 280.5 },
    { doc: "TRAVELER", key: "quantities", fixed: 410, overhead: 48, beside: 0, copies: 1, least: 462.5 },
    { doc: "TRAVELER", key: "inspections", fixed: 223, overhead: 49.6, beside: 0, copies: 1, least: 277.1 },
    { doc: "TRAVELER", key: "steps", fixed: 188, overhead: 25.6, beside: 0, copies: 1, least: 218.1 },
    ...(["SHIPPER", "MOS_SHIPPER"] as const).flatMap((doc): Row[] => [
      { doc, key: "field_strip", fixed: 265, overhead: 44.8, beside: 0, copies: 1, least: 314.3 },
      { doc, key: "lines", fixed: 160, overhead: 24, beside: 0, copies: 1, least: 188.5 },
      { doc, key: "containers", fixed: 142, overhead: 32, beside: 0, copies: 2, least: 352.5 },
    ]),
    { doc: "BOL", key: "freight", fixed: 188, overhead: 44.8, beside: 178, copies: 1, least: 415.3 },
    { doc: "CERT", key: "parts", fixed: 160, overhead: 24, beside: 0, copies: 1, least: 188.5 },
    { doc: "INVOICE", key: "column_header", fixed: 202, overhead: 36, beside: 0, copies: 1, least: 242.5 },
    { doc: "QUOTE", key: "column_header", fixed: 202, overhead: 36, beside: 0, copies: 1, least: 242.5 },
    { doc: "STATEMENT", key: "aging", fixed: 0, overhead: 62.4, beside: 0, copies: 1, least: 66.9 },
  ];
  /** Design §7.1's three forms, each figure as `figure` prints it. */
  const ruleNine = (name: string, row: Omit<Row, "doc" | "key">, w: number): string => {
    const head = `${name} needs ${row.least} pt: its visible columns' ${row.fixed} pt`;
    if (row.copies === 2) {
      return `${head} and their ${row.overhead} pt of padding and rules, printed twice, and one grid step, more than its ${w} pt.`;
    }
    if (row.beside > 0) {
      return `${head}, their ${row.overhead} pt of padding and rules, the ${row.beside} pt it keeps beside them and one grid ` +
        `step, more than its ${w} pt.`;
    }
    return `${head}, their ${row.overhead} pt of padding and rules and one grid step, more than its ${w} pt.`;
  };
  const tableIn = (layout: CanvasLayout, key: string) =>
    layout.items.find((i): i is Extract<CanvasItem, { kind: "table" }> => i.kind === "table" && i.key === key)!;
  /** `doc`'s standard layout with `key` drawn `w` wide against the right margin. */
  const drawnAt = (doc: PaperDoc, key: string, w: number, layout = DOCS[doc].layout()) =>
    reboxed(layout, key, { x: 588 - w, w });

  it.each(ROWS.map((row) => [`${row.doc} ${row.key}`, row] as const))(
    "refuses each column table under its new least width and accepts it there: %s",
    (_, row) => {
      const contract = contractFor(row.doc);
      const item = tableIn(DOCS[row.doc].layout(), row.key);
      expect(leastWidth(contract, item)).toBe(row.least);
      const under = row.least - 0.5;
      expect(canvasRefusal(drawnAt(row.doc, row.key, under), contract, { pageFooter: false })).toEqual({
        itemIds: [item.id], sentence: ruleNine(`The ${tableName(contract, row.key)} table`, row, under),
      });
      expect(canvasRefusal(drawnAt(row.doc, row.key, row.least), contract, { pageFooter: false })).toBeNull();
    },
  );

  it("follows a typed column width", () => {
    const layout = standardLayout();
    const typed = layoutOf(layout.items.map((i) => (i.kind === "table" && i.key === "quantities"
      ? { ...i, columns: i.columns.map((c) => (c.key === "order_qty" ? { ...c, width: 100 } : c)) } : i)));
    const item = tableIn(typed, "quantities");
    expect(leastWidth(TRAVELER_CONTRACT, item)).toBe(484.5);
    expect(canvasRefusal(drawnAt("TRAVELER", "quantities", 484, typed), TRAVELER_CONTRACT, { pageFooter: false })).toEqual({
      itemIds: [item.id],
      sentence: ruleNine(`The ${tableName(TRAVELER_CONTRACT, "quantities")} table`, { fixed: 432, overhead: 48, beside: 0, copies: 1, least: 484.5 }, 484),
    });
    expect(canvasRefusal(drawnAt("TRAVELER", "quantities", 484.5, typed), TRAVELER_CONTRACT, { pageFooter: false })).toBeNull();
  });

  it.each([
    ["SHIPPER", "totals", 264.5], ["MOS_SHIPPER", "totals", 264.5], ["STATEMENT", "open_items", 49.5],
  ] as const)("floors the ticket totals at 264.5 and the open items at 49.5: %s %s", (doc, key, least) => {
    const contract = contractFor(doc);
    const item = tableIn(DOCS[doc].layout(), key);
    expect(leastWidth(contract, item)).toBe(least);
    const under = least - 0.5;
    expect(canvasRefusal(drawnAt(doc, key, under), contract, { pageFooter: false })).toEqual({
      itemIds: [item.id],
      sentence: `The ${tableName(contract, key)} table is ${under} pt wide, less than the ${least} pt its fixed parts and one ` +
        "grid step need.",
    });
    expect(canvasRefusal(drawnAt(doc, key, least), contract, { pageFooter: false })).toBeNull();
  });

  describe("floors a grid block by its grid's columns (design §6.1)", () => {
    const widened = (doc: "INVOICE" | "QUOTE", each: number) => {
      const layout = DOCS[doc].layout();
      return layoutOf(layout.items.map((i) => (i.kind === "table" && i.key === "column_header"
        ? { ...i, columns: i.columns.map((c) => (c.key === "col_each_weight" ? { ...c, width: each } : c)) } : i)));
    };
    it.each([["INVOICE", "parts"], ["INVOICE", "price"], ["QUOTE", "lines"]] as const)("%s %s", (doc, key) => {
      const contract = contractFor(doc);
      const standard = DOCS[doc].layout();
      const item = tableIn(standard, key);
      const sentence = (w: number, least: number) =>
        `The ${tableName(contract, key)} table is ${w} pt wide, less than the ${least} pt the column headers' columns, ` +
        "their gaps and one grid step need.";
      // The standard columns: 52 + 66 + 84, three 6 pt gaps, the information cell's 6 pt margin and one grid step.
      expect(leastWidth(contract, item, { layout: standard })).toBe(230.5);
      expect(canvasRefusal(reboxed(standard, key, { x: 24, w: 230 }), contract, { pageFooter: false }))
        .toEqual({ itemIds: [item.id], sentence: sentence(230, 230.5) });
      expect(canvasRefusal(reboxed(standard, key, { x: 24, w: 230.5 }), contract, { pageFooter: false })).toBeNull();
      // The Each weight column typed 86 (from 66): the floor rises by exactly the difference.
      const wide = widened(doc, 86);
      expect(leastWidth(contract, tableIn(wide, key), { layout: wide })).toBe(250.5);
      expect(canvasRefusal(reboxed(wide, key, { x: 24, w: 250 }), contract, { pageFooter: false }))
        .toEqual({ itemIds: [item.id], sentence: sentence(250, 250.5) });
      expect(canvasRefusal(reboxed(wide, key, { x: 24, w: 250.5 }), contract, { pageFooter: false })).toBeNull();
      // With no layout handed, the profile's entry: the standard columns' figure.
      expect(leastWidth(contract, tableIn(wide, key))).toBe(230.5);
    });
    it("counts a hidden grid column at nothing, and the margin only while the information column is \"*\"", () => {
      const contract = contractFor("INVOICE");
      const layout = DOCS.INVOICE.layout();
      const withHeader = (f: (c: CanvasColumn) => CanvasColumn) => layoutOf(layout.items.map((i) => (
        i.kind === "table" && i.key === "column_header" ? { ...i, columns: i.columns.map(f) } : i)));
      // Quantity hidden: 66 + 84, two gaps, the margin, one step.
      const noQty = withHeader((c) => (c.key === "col_qty" ? { ...c, visible: false } : c));
      expect(leastWidth(contract, tableIn(noQty, "parts"), { layout: noQty })).toBe(66 + 84 + 2 * 6 + 6 + 4.5);
      // The information column typed 100: its margin sits inside its own width.
      const fixedInfo = withHeader((c) => (c.key === "col_info" ? { ...c, width: 100 } : c));
      expect(leastWidth(contract, tableIn(fixedInfo, "parts"), { layout: fixedInfo })).toBe(52 + 100 + 66 + 84 + 3 * 6 + 4.5);
      // The order strip and the totals read one edge of the grid: their entries, as before.
      expect(leastWidth(contract, tableIn(layout, "order_strip"), { layout })).toBe(INVOICE_LEAST_WIDTHS.order_strip);
      expect(leastWidth(contract, tableIn(layout, "totals"), { layout })).toBe(INVOICE_LEAST_WIDTHS.totals);
    });
  });

  it("the steps floor reads the template's base size", () => {
    const steps = tableIn(standardLayout(), "steps");
    expect(leastWidth(TRAVELER_CONTRACT, steps)).toBe(218.1);
    // Only a restored handwriting column moves the figure with the base size (a canvas never hides one:
    // rule 9 refuses it first, so this is pinned on `leastWidth` itself). The step code typed so wide
    // that the instruction's budget is 10 pt: under one em at 12, so the restore falls back to the
    // contract's widths there; over one em at 8, so the typed width stands.
    const columns = steps.columns.map((c) => (c.key === "step_eq" ? { ...c, visible: false }
      : c.key === "step_code" ? { ...c, width: 376.8 } : c));
    const restored = { ...steps, columns };
    const section = { key: "steps", visible: true, fields: columns.map((c) => ({ key: c.key, visible: c.visible, label: c.label, width: c.width })) };
    const at = (baseSize: number) => round2(travelerStepsPrintedWidth([section], baseSize).printed + CANVAS_GRID);
    expect(at(8)).not.toBe(at(12));
    expect(leastWidth(TRAVELER_CONTRACT, restored)).toBe(at(8));
    expect(leastWidth(TRAVELER_CONTRACT, restored, { fonts: { ...TRAVELER_CONTRACT.fonts, baseSize: 12 } })).toBe(at(12));
  });

  it("floorRefusal answers only a refusal of an item under its least width", () => {
    const contract = TRAVELER_CONTRACT;
    expect(floorRefusal(standardLayout(), contract, { pageFooter: false })).toBeNull();
    // Refused for something else (no barcode): null, though the canvas is refused.
    const noBarcode = layoutOf(standardLayout().items.filter((i) => i.kind !== "barcode"));
    expect(canvasRefusal(noBarcode, contract, { pageFooter: false })).not.toBeNull();
    expect(floorRefusal(noBarcode, contract, { pageFooter: false })).toBeNull();
    // Both: the first refusal names the barcode, not the narrowed table, so null.
    const both = layoutOf(drawnAt("TRAVELER", "quantities", 462).items.filter((i) => i.kind !== "barcode"));
    expect(floorRefusal(both, contract, { pageFooter: false })).toBeNull();
    // Under its floor alone: the rule's own answer.
    const under = drawnAt("TRAVELER", "quantities", 462);
    expect(floorRefusal(under, contract, { pageFooter: false })).toEqual(canvasRefusal(under, contract, { pageFooter: false }));
    expect(floorRefusal(under, contract, { pageFooter: false })?.sentence).toContain("needs 462.5 pt");
  });

  it("refuses a stored layout under a raised floor on read (owner ruling 6, 2026-11-14)", () => {
    // A traveler version stored with its quantities at 458 (today's floor, 410, passed it): read
    // through the stored-version normalizer every reader runs, it is refused in rule 9's sentence.
    const layout = drawnAt("TRAVELER", "quantities", 458);
    const stored = { ...structuredClone(TRAVELER_DEFAULT_CONFIG), layout };
    expect(() => normalizeStoredConfig("TRAVELER", stored)).toThrow(
      ruleNine(`The ${tableName(TRAVELER_CONTRACT, "quantities")} table`, { fixed: 410, overhead: 48, beside: 0, copies: 1, least: 462.5 }, 458),
    );
  });
});

describe("warning (d) (#971)", () => {
  /*
   * Design §7.2: (d) counts each shown "*" column at its widest heading word (`headingWholeWidth`),
   * so it warns while the clamped table's share leaves a heading word too narrow to print whole, and
   * says from what width the headings print whole. The figures at the standard columns and built-in
   * labels (held to pdfmake by tests/canvas-keep-in-box.test.ts): the traveler's quantities 458 + the
   * Container heading's 34.8 = 492.8; the ticket's containers (142 + 32) + 2 × the Containers
   * heading's 38.91 = 251.83 a copy, 503.66 in all; the aging 62.4 + 7 × the Unapplied heading's
   * 40.35 = 344.82; the bill of lading's freight 188 + 44.8 + the Description word's 33.2 = 266,
   * beside its 178.
   */
  type Doc = "TRAVELER" | "SHIPPER" | "STATEMENT" | "BOL";
  const TABLE: Record<Doc, string> = { TRAVELER: "quantities", SHIPPER: "containers", STATEMENT: "aging", BOL: "freight" };
  /** The doc's standard layout with its table drawn against the right margin at w. */
  const drawn = (doc: Doc, w: number, columns?: (c: CanvasColumn) => CanvasColumn): CanvasLayout => {
    const layout = reboxed(DOCS[doc].layout(), TABLE[doc], { x: round2(588 - w), w });
    if (columns === undefined) return layout;
    return layoutOf(layout.items.map((i) => (i.kind === "table" && i.key === TABLE[doc] ? { ...i, columns: i.columns.map(columns) } : i)));
  };
  /** (d)'s and (f)'s sentences on the doc's table. */
  const dSaid = (doc: Doc, layout: CanvasLayout): string[] => {
    const contract = contractFor(doc);
    return canvasWarnings(layout, contract, undefined, { fonts: contract.fonts })
      .filter((w) => w.itemIds.includes(`table-${TABLE[doc]}`) && /heading words break/.test(w.sentence))
      .map((w) => w.sentence);
  };
  /** The names of the doc's table's shown "*" columns, in the contract's order. */
  const starNames = (doc: Doc): string[] => {
    const contract = contractFor(doc);
    const item = DOCS[doc].layout().items.find((i) => i.kind === "table" && i.key === TABLE[doc]) as Extract<CanvasItem, { kind: "table" }>;
    return item.columns.flatMap((c) => {
      const f = contract.sections.flatMap((s) => s.fields).find((x) => x.key === c.key)!;
      return c.visible && (c.width ?? f.column?.defaultWidth) === "*" ? [f.name] : [];
    });
  };
  const nameOf = (doc: Doc) => `The ${tableName(contractFor(doc), TABLE[doc])} table`;
  const quantities = (w: number) => `${nameOf("TRAVELER")}: ${sharedWidthWords(starNames("TRAVELER"), w - 458)}, under the 34.8 pt ` +
    "its widest heading word needs, so its heading words break; its headings print whole from 492.8 pt wide.";
  const containers = (w: number) => `${nameOf("SHIPPER")} prints its columns twice: ` +
    `${sharedWidthWords(starNames("SHIPPER"), (w / 2 - 174) / 2)} per copy, under the 38.91 pt its widest heading word needs, ` +
    "so its heading words break; its headings print whole from 251.83 pt each copy, 503.66 pt in all.";
  const aging = (w: number) => `${nameOf("STATEMENT")}: ${sharedWidthWords(starNames("STATEMENT"), (w - 62.4) / 7)}, under the ` +
    "40.35 pt its widest heading word needs, so its heading words break; its headings print whole from 344.82 pt wide.";

  it("warns while a heading word breaks", () => {
    expect(starNames("TRAVELER")).toEqual(["Container"]);
    expect(starNames("SHIPPER")).toEqual(["Containers", "Tare"]);
    expect(starNames("STATEMENT")).toHaveLength(7);
    for (const [doc, sentence, warned, whole] of [
      ["TRAVELER", quantities, [462.5, 492.5], 493],
      ["SHIPPER", containers, [352.5, 503.5], 504],
      ["STATEMENT", aging, [66.9, 344], 345.5],
    ] as const) {
      const contract = contractFor(doc);
      for (const w of warned) {
        // A layout the rules accept: from the least width up.
        expect(canvasRefusal(drawn(doc, w), contract, { fonts: contract.fonts })).toBeNull();
        expect(dSaid(doc, drawn(doc, w)), `${doc} at ${w}`).toEqual([sentence(w)]);
      }
      expect(dSaid(doc, drawn(doc, whole)), `${doc} at ${whole}`).toEqual([]);
    }
    expect(leastWidth(TRAVELER_CONTRACT, drawn("TRAVELER", 462.5).items.find((i) => i.id === "table-quantities")!)).toBe(462.5);
  });

  it("says the beside form for the freight", () => {
    const item = DOCS.BOL.layout().items.find((i) => i.kind === "table" && i.key === "freight") as Extract<CanvasItem, { kind: "table" }>;
    const figure = headingWholeWidth(BOL_CONTRACT, item, BOL_CONTRACT.fonts)!;
    // Step 1's measure: the description's widest heading word, "Description" at 6.5 pt bold, 33.2.
    expect(round2(figure.head)).toBe(33.2);
    expect(round2(figure.perCopy)).toBe(266);
    const whole = Math.ceil((figure.perCopy + 178) * 2) / 2;
    expect(whole).toBe(444);
    const least = 415.3;
    expect(canvasRefusal(drawn("BOL", least), BOL_CONTRACT, { fonts: BOL_CONTRACT.fonts })).toBeNull();
    expect(dSaid("BOL", drawn("BOL", least))).toEqual([
      `${nameOf("BOL")}: ${sharedWidthWords(starNames("BOL"), least - 178 - 232.8)}, under the 33.2 pt its widest heading word ` +
        "needs, so its heading words break; its headings print whole from a 444 pt box (266 pt beside the 178 pt it keeps).",
    ]);
    expect(dSaid("BOL", drawn("BOL", whole))).toEqual([]);
  });

  it("says nothing between the headings' figure and 504, where (f) once spoke (retired, R-C)", () => {
    // 503.75: each shared column gets 38.94 per copy, at least the 38.91 its heading needs.
    expect(dSaid("SHIPPER", drawn("SHIPPER", 503.75))).toEqual([]);
  });

  it("counts a typed label's widest word", () => {
    const item = (layout: CanvasLayout) => layout.items.find((i) => i.id === "table-quantities") as Extract<CanvasItem, { kind: "table" }>;
    const typed = (c: CanvasColumn) => (c.key === "container" ? { ...c, label: "Containerization" } : c);
    const built = headingWholeWidth(TRAVELER_CONTRACT, item(drawn("TRAVELER", 500)), TRAVELER_CONTRACT.fonts)!;
    const raised = headingWholeWidth(TRAVELER_CONTRACT, item(drawn("TRAVELER", 500, typed)), TRAVELER_CONTRACT.fonts)!;
    const by = textWidthOf("Containerization", "Roboto", "bold", 8) - textWidthOf("Container", "Roboto", "bold", 8);
    expect(raised.perCopy - built.perCopy).toBeCloseTo(by, 6);
    expect(raised.head).toBeCloseTo(textWidthOf("Containerization", "Roboto", "bold", 8), 6);
    // Built in, 500 prints the headings whole; typed, the word breaks there.
    expect(dSaid("TRAVELER", drawn("TRAVELER", 500))).toEqual([]);
    expect(dSaid("TRAVELER", drawn("TRAVELER", 500, typed))).toHaveLength(1);
  });

  it("a blank label adds nothing", () => {
    const blank = (c: CanvasColumn) => (c.key === "container" ? { ...c, label: "" } : c);
    const item = drawn("TRAVELER", 462.5, blank).items.find((i) => i.id === "table-quantities") as Extract<CanvasItem, { kind: "table" }>;
    expect(headingWholeWidth(TRAVELER_CONTRACT, item, TRAVELER_CONTRACT.fonts)).toEqual({ perCopy: 458, head: 0 });
    expect(dSaid("TRAVELER", drawn("TRAVELER", 462.5, blank))).toEqual([]);
  });

  it("measures at the template's fonts: a larger base size raises the figure", () => {
    const item = DOCS.TRAVELER.layout().items.find((i) => i.id === "table-quantities") as Extract<CanvasItem, { kind: "table" }>;
    const at10 = headingWholeWidth(TRAVELER_CONTRACT, item, { ...TRAVELER_CONTRACT.fonts, baseSize: 10 })!;
    expect(at10.head).toBeCloseTo(textWidthOf("Container", "Roboto", "bold", 10), 6);
    const serif = headingWholeWidth(TRAVELER_CONTRACT, item, { ...TRAVELER_CONTRACT.fonts, family: "Liberation Serif" })!;
    expect(serif.head).toBeCloseTo(textWidthOf("Container", "Liberation Serif", "bold", 8), 6);
    // A fixed heading size is its own: the aging's 9 pt whatever the base size.
    const agingItem = DOCS.STATEMENT.layout().items.find((i) => i.id === "table-aging") as Extract<CanvasItem, { kind: "table" }>;
    expect(headingWholeWidth(STATEMENT_CONTRACT, agingItem, { ...STATEMENT_CONTRACT.fonts, baseSize: 12 })!.head)
      .toBeCloseTo(textWidthOf("Unapplied", "Roboto", "bold", 9), 6);
  });

  it("joins a word to the punctuation pdfmake keeps on its line: no break before \"/\" or after \"(\"", () => {
    // The invoice's Information column: "Order Information / Part No. / Description / Pricing
    // Information" breaks at no space before a "/", so "Information /" is one word.
    const item = DOCS.INVOICE.layout().items.find((i) => i.id === "table-column_header") as Extract<CanvasItem, { kind: "table" }>;
    expect(headingWholeWidth(INVOICE_CONTRACT, item, INVOICE_CONTRACT.fonts)!.head)
      .toBeCloseTo(textWidthOf("Information /", "Roboto", "bold", 9), 6);
    // Nor after an opening mark (UAX #14 LB14): "( Containerization" is one word.
    const quantities = (label: string) => drawn("TRAVELER", 500, (c) => (c.key === "container" ? { ...c, label } : c))
      .items.find((i) => i.id === "table-quantities") as Extract<CanvasItem, { kind: "table" }>;
    expect(headingWholeWidth(TRAVELER_CONTRACT, quantities("Bin ( Containerization"), TRAVELER_CONTRACT.fonts)!.head)
      .toBeCloseTo(textWidthOf("( Containerization", "Roboto", "bold", 8), 6);
    expect(headingWholeWidth(TRAVELER_CONTRACT, quantities("Bin  [  Containerization  ]"), TRAVELER_CONTRACT.fonts)!.head)
      .toBeCloseTo(textWidthOf("[  Containerization  ]", "Roboto", "bold", 8), 6);
  });

  it("keeps a word whole across a non-breaking space: U+00A0, U+2007 and U+202F are no break to pdfmake", () => {
    const quantities = (label: string) => drawn("TRAVELER", 500, (c) => (c.key === "container" ? { ...c, label } : c))
      .items.find((i) => i.id === "table-quantities") as Extract<CanvasItem, { kind: "table" }>;
    for (const space of ["\u00A0", "\u2007", "\u202F"]) {
      const label = `Bin${space}Containerization`;
      expect(headingWholeWidth(TRAVELER_CONTRACT, quantities(label), TRAVELER_CONTRACT.fonts)!.head, JSON.stringify(space))
        .toBeCloseTo(textWidthOf(label, "Roboto", "bold", 8), 6);
    }
    // An ordinary space beside one still breaks.
    expect(headingWholeWidth(TRAVELER_CONTRACT, quantities("Bin\u00A0 Containerization"), TRAVELER_CONTRACT.fonts)!.head)
      .toBeCloseTo(textWidthOf("Containerization", "Roboto", "bold", 8), 6);
  });

  it("warns of no heading where none prints over a \"*\" column: the steps' spanning title, a table with no \"*\" column", () => {
    // The steps' title spans the position, code and instruction columns (locked in that order), so no
    // word prints over the instruction alone: the figure is the printed width, and below it rule 9
    // refuses; (d) says nothing.
    const steps = standardLayout().items.find((i) => i.id === "table-steps") as Extract<CanvasItem, { kind: "table" }>;
    expect(headingWholeWidth(TRAVELER_CONTRACT, steps, TRAVELER_CONTRACT.fonts))
      .toEqual({ perCopy: travelerStepsPrintedWidth([{ key: "steps", visible: true, fields: steps.columns.map((c) => ({ ...c })) }], 8).printed, head: 0 });
    const narrow = layoutOf(standardLayout().items.map((i) => (i.id === "table-steps" ? { ...i, box: { ...i.box, w: 200 } } : i)));
    expect(canvasWarnings(narrow, TRAVELER_CONTRACT, undefined, { fonts: TRAVELER_CONTRACT.fonts })
      .filter((w) => w.itemIds.includes("table-steps"))).toEqual([]);
    // The aging at six fixed columns and one hidden: no share to name, so nothing, refused or not.
    const fixed = drawn("STATEMENT", 62, (c) => (c.key === "aging_net" ? { ...c, visible: false } : { ...c, width: 50 }));
    expect(canvasRefusal(fixed, STATEMENT_CONTRACT, { fonts: STATEMENT_CONTRACT.fonts })).not.toBeNull();
    expect(dSaid("STATEMENT", fixed)).toEqual([]);
  });

  it("names a share of 0 for a box below its fixed parts, which rule 9 refuses", () => {
    const layout = drawn("TRAVELER", 400);
    expect(canvasRefusal(layout, TRAVELER_CONTRACT, { fonts: TRAVELER_CONTRACT.fonts })).not.toBeNull();
    expect(dSaid("TRAVELER", layout)).toEqual([quantities(458)]);
  });
});
