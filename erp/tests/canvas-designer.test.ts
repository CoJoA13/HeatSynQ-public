// The canvas designer's pure leaf (PR C of #926, task 3): the geometry the Design tab draws and
// drags with, the palette, the placement of a new item and the words. No DOM: the stage and the
// inspector are thin wrappers proven by their shape tests and the templates-admin flow.
import { describe, expect, it } from "vitest";
import {
  CANVAS_RECORD_WORDS, designOnCanvasGate, drawsBorder, ruleOf,
  DESIGNER_WORDS, INCH, NUDGE_COARSE, isRequired, NUDGE_FINE, clearedLayout, dragStart, dropBox, fitScale, fromInches, itemTitle, moveBox,
  moveClampHeight, movedItem, paletteEntries, placeNew, printsNothing, readSize, removeItem, sameItemPlace, replaceItem, resizeBox, resizeStart, resizedBox, resizedItem, setAnchor, snap, stageBox, toInches, zeroSide,
  type PaletteEntry,
} from "@/lib/canvas-designer";
import {
  bandTop, besideOf, canvasFieldKeys, canvasWarnings, defaultTableColumns, drawnBox, inkBoxes, isListBlock, leastWidth, meets, regionHeights,
  validateCanvasLayout, visibleColumnsWidth, type CanvasMeasure,
} from "@/lib/template-canvas";
import { round2, tableOverhead } from "@/lib/printed-width-core";
import { canvasSaveBlock } from "@/lib/template-editor";
import { TRAVELER_DEFAULT_CONFIG } from "@/lib/template-contracts/index";
import { CANVAS_GRID, canvasLayoutSchema, type CanvasBox, type CanvasItem, type CanvasLayout } from "@/lib/template-contracts/canvas";
import { BOL_CONTRACT, BOL_FIRST_TABLE_ROOM, BOL_LEAST_WIDTHS, BOL_ROW_FLOOR } from "@/lib/template-contracts/bol";
import { CERT_CONTRACT, CERT_FIRST_TABLE_ROOM, CERT_LEAST_WIDTHS, CERT_ROW_FLOOR } from "@/lib/template-contracts/cert";
import {
  INVOICE_CONTRACT, INVOICE_FIRST_TABLE_ROOM, INVOICE_LEAST_WIDTHS, INVOICE_ROW_FLOOR,
} from "@/lib/template-contracts/invoice";
import { testContract } from "./helpers/test-contract";
import {
  STATEMENT_CONTRACT, STATEMENT_LEAST_WIDTHS, STATEMENT_ROW_FLOOR,
} from "@/lib/template-contracts/statement";
import { QUOTE_CONTRACT, QUOTE_LEAST_WIDTHS, QUOTE_ROW_FLOOR } from "@/lib/template-contracts/quote";
import { CONTENT_WIDTH } from "@/lib/template-contracts/types";
import { MOS_SHIPPER_CONTRACT } from "@/lib/template-contracts/mos-shipper";
import { SHIPPER_CONTRACT, TICKET_ROW_FLOOR } from "@/lib/template-contracts/shipper";
import { TRAVELER_CANVAS, TRAVELER_CONTRACT } from "@/lib/template-contracts/traveler";
import { barcode, field, layoutOf, standardLayout, table } from "./helpers/canvas-fixtures";
import { standardTicketLayout, ticketField, ticketTable } from "./helpers/ticket-canvas-fixtures";
import { bolField, bolTable, standardBolLayout } from "./helpers/bol-canvas-fixtures";
import { certTable, standardCertLayout } from "./helpers/cert-canvas-fixtures";
import { invoiceField, invoiceTable, standardInvoiceLayout } from "./helpers/invoice-canvas-fixtures";
import { flowLeastWidths } from "./helpers/invoice-flow-widths";
import { statementFlowLeastWidths } from "./helpers/statement-flow-widths";
import { standardStatementLayout, statementField, statementTable, type StatementTable } from "./helpers/statement-canvas-fixtures";
import { quoteField, quoteTable, standardQuoteLayout, type QuoteTable } from "./helpers/quote-canvas-fixtures";

const itemOf = (layout: CanvasLayout, id: string): CanvasItem => {
  const item = layout.items.find((i) => i.id === id);
  if (item === undefined) return expect.fail(`no item ${id}`);
  return item;
};
const text = (id: string, box: CanvasBox, anchor: CanvasItem["anchor"] = { kind: "page-top" }): CanvasItem =>
  ({ id, kind: "text", text: "Signed", box, anchor, repeat: false, style: { size: 8, bold: false, align: "left" } });
const line = (id: string, box: CanvasBox): CanvasItem => ({ id, kind: "line", weight: 1, box, anchor: { kind: "page-top" }, repeat: false });
const valid = (layout: CanvasLayout) => () => validateCanvasLayout(layout, TRAVELER_CONTRACT);
/** Whether `item`'s ink, where it is drawn, meets any other item's. */
function overlapsAny(layout: CanvasLayout, item: CanvasItem): boolean {
  const ink = inkBoxes({ ...item, box: drawnBox(item, layout) } as CanvasItem);
  return layout.items.some((other) => other.id !== item.id &&
    inkBoxes({ ...other, box: drawnBox(other, layout) } as CanvasItem).some((a) => ink.some((b) => meets(a, b))));
}

/** A measure of `layout` as the preview would report it, every table and region `dy` lower. */
function measureOf(layout: CanvasLayout, dy: number): CanvasMeasure {
  const tables = layout.items.filter((i): i is Extract<CanvasItem, { kind: "table" }> => i.kind === "table");
  const byKey = new Map(tables.map((t) => [t.key, t] as const));
  return {
    pages: 1,
    tables: tables.map((t) => ({ key: t.key, page: 1, top: t.box.y + dy, height: t.box.h })),
    regions: regionHeights(layout).map((r) => {
      const t = byKey.get(r.after)!;
      return { after: r.after, page: 1, top: t.box.y + t.box.h + dy, height: r.height };
    }),
    items: layout.items.filter((i) => i.kind !== "table" && i.anchor.kind === "page-top")
      .map((i) => ({ id: i.id, page: 1, left: i.box.x, top: i.box.y, height: i.box.h })),
  };
}

/** `measureOf` with the items `taller` names measured at the given height on the given page (an
 *  entry added for an item the helper leaves out: a below-table or a page-bottom one), so a measure
 *  can report an item taller than its box, as the preview does for a party box or wrapped wording. */
function tallerMeasure(layout: CanvasLayout, taller: Record<string, { height: number; page?: number }>, pages = 1): CanvasMeasure {
  const measure = { ...measureOf(layout, 0), pages };
  const items = measure.items.filter((m) => !(m.id in taller));
  for (const [id, { height, page }] of Object.entries(taller)) {
    const item = itemOf(layout, id);
    items.push({ id, page: page ?? 1, left: item.box.x, top: drawnBox(item, layout).y, height });
  }
  return { ...measure, items };
}

describe("scale, grid and inches", () => {
  it("fitScale fits the 612 pt page to the column, clamped to 0.5..1.25 px per pt", () => {
    expect(fitScale(612)).toBe(1);
    expect(fitScale(459)).toBe(0.75);
    expect(fitScale(306)).toBe(0.5);
    expect(fitScale(200)).toBe(0.5);
    expect(fitScale(765)).toBe(1.25);
    expect(fitScale(2000)).toBe(1.25);
    expect(fitScale(0)).toBe(0.5);
  });
  it("snap rounds to the 4.5 pt grid, and the nudges are 1/16 in and 1/4 in", () => {
    expect(snap(7)).toBe(9);
    expect(snap(2)).toBe(0);
    expect(snap(6.75)).toBe(9);
    expect(snap(140)).toBe(139.5);
    expect(Object.is(snap(-1), 0)).toBe(true);
    expect(INCH).toBe(72);
    expect(NUDGE_FINE).toBe(CANVAS_GRID);
    expect(NUDGE_FINE * 16).toBe(INCH);
    expect(NUDGE_COARSE * 4).toBe(INCH);
  });
  it("toInches prints two decimals; fromInches reads a decimal spelling as points and nothing else", () => {
    expect(toInches(36)).toBe("0.50");
    expect(toInches(90)).toBe("1.25");
    expect(toInches(24)).toBe("0.33");
    expect(fromInches("0.50")).toBe(36);
    expect(fromInches(" 1.25 ")).toBe(90);
    expect(fromInches(".5")).toBe(36);
    expect(fromInches("2.")).toBe(144);
    for (const bad of ["1e2", "$1", "1,000", "+1", "0x10", "", "abc", "."]) expect(fromInches(bad)).toBeNull();
  });
});

describe("the inspector's size boxes (ruling C31)", () => {
  it("readSize snaps a typed figure, and refuses a width or a height under one grid step on every kind", () => {
    expect(readSize("w")("1.1")).toEqual({ value: 81 });
    expect(readSize("h")(".25")).toEqual({ value: 18 });
    for (const typed of ["0", "-1", "0.01"]) {
      expect(readSize("w")(typed)).toEqual({ refusal: DESIGNER_WORDS.widthTooSmall });
      expect(readSize("h")(typed)).toEqual({ refusal: DESIGNER_WORDS.heightTooSmall });
    }
    // A vertical line's height is its length, an open side: floored like any height (its zero side,
    // a horizontal line's height, is a closed box, so no line is exempt).
    expect(readSize("h")("0")).toEqual({ refusal: DESIGNER_WORDS.heightTooSmall });
    expect(readSize("h")("0.5")).toEqual({ value: 36 });
    // X and Y take any figure; the rules judge the place.
    expect(readSize("x")("0")).toEqual({ value: 0 });
    expect(readSize("y")("-1")).toEqual({ value: -72 });
    for (const side of ["x", "y", "w", "h"] as const) expect(readSize(side)("1e2")).toEqual({ refusal: DESIGNER_WORDS.notAFigure });
    expect(DESIGNER_WORDS.widthTooSmall).toBe(`Width must be at least ${toInches(CANVAS_GRID)} in, one grid step.`);
    expect(DESIGNER_WORDS.heightTooSmall).toBe(`Height must be at least ${toInches(CANVAS_GRID)} in, one grid step.`);
  });
  it("zeroSide names a line's undrawn side, and no other item's", () => {
    expect(zeroSide(line("h", { x: 24, y: 700, w: 200, h: 0 }))).toBe("h");
    expect(zeroSide(line("v", { x: 24, y: 600, w: 0, h: 100 }))).toBe("w");
    expect(zeroSide(field("company_name"))).toBeNull();
    expect(zeroSide({ ...barcode(), box: { x: 402, y: 48, w: 0, h: 44 } })).toBeNull();
  });
});

describe("moving and resizing", () => {
  it("moveBox moves by whole grid steps and keeps the box inside the page's margins", () => {
    expect(moveBox({ x: 24, y: 24, w: 80, h: 40 }, NUDGE_FINE, NUDGE_COARSE)).toEqual({ x: 28.5, y: 42, w: 80, h: 40 });
    // A 3 pt drag is one grid step: the item keeps its place relative to the items beside it.
    expect(moveBox({ x: 24, y: 24, w: 80, h: 40 }, 3, 0)).toEqual({ x: 28.5, y: 24, w: 80, h: 40 });
    expect(moveBox({ x: 30, y: 30, w: 80, h: 40 }, -100, -100)).toEqual({ x: 24, y: 24, w: 80, h: 40 });
    expect(moveBox({ x: 500, y: 700, w: 80, h: 40 }, 100, 100)).toEqual({ x: 508, y: 728, w: 80, h: 40 });
  });
  it("resizeBox keeps the barcode's 186:44 proportions and its floor, and the validator accepts the result", () => {
    const code = barcode({ box: { x: 300, y: 48, w: 186, h: 44 } });
    // East by 90 (twenty grid steps) makes it 276 wide and as tall as the proportions keep.
    const bigger = resizeBox(code, "se", 90, 0, TRAVELER_CONTRACT);
    expect(bigger).toEqual({ x: 300, y: 48, w: 276, h: 276 * 44 / 186 });
    // A side handle drives the other side: south by 22.5 makes it 66.5 tall and as wide as that keeps.
    expect(resizeBox(code, "s", 0, 22.5, TRAVELER_CONTRACT)).toEqual({ x: 300, y: 48, w: 66.5 * 186 / 44, h: 66.5 });
    // A drag off the diagonal still keeps the proportions exactly.
    const off = resizeBox(code, "se", 93, 7, TRAVELER_CONTRACT);
    expect(off.w / off.h).toBeCloseTo(186 / 44, 12);
    expect(off.w).toBe(280.5);
    // Smaller than the floor is the floor; the west handle keeps the right edge where it was.
    expect(resizeBox(code, "se", -50, -50, TRAVELER_CONTRACT)).toEqual({ x: 300, y: 48, w: 186, h: 44 });
    expect(resizeBox(code, "nw", 50, 50, TRAVELER_CONTRACT)).toEqual({ x: 300, y: 48, w: 186, h: 44 });
    expect(resizeBox({ ...code, box: bigger }, "w", 45, 0, TRAVELER_CONTRACT)).toEqual({ x: 345, y: 48, w: 231, h: 231 * 44 / 186 });
    // The rules accept each result (the header fields it would now cover left out).
    for (const box of [bigger, off]) {
      const layout = layoutOf(standardLayout().items.map((i) => (i.kind === "barcode" ? { ...i, box } : i)));
      expect(valid(layoutOf(layout.items.filter((i) => i.kind !== "field" || i.anchor.kind !== "page-top")))).not.toThrow();
    }
  });
  it("resizeBox keeps a table one row tall and as wide as its least width", () => {
    // The lines' least width (#971): 244 of visible columns, their 32 pt of padding and rules and one grid step.
    const lines = table("lines");
    expect(resizeBox(lines, "s", 0, -100, TRAVELER_CONTRACT)).toEqual({ x: 24, y: 140, w: 564, h: 24 });
    expect(resizeBox(lines, "e", -500, 0, TRAVELER_CONTRACT)).toEqual({ x: 24, y: 140, w: 280.5, h: 40 });
    expect(resizeBox(lines, "w", 500, 0, TRAVELER_CONTRACT)).toEqual({ x: 588 - 280.5, y: 140, w: 280.5, h: 40 });
    expect(resizeBox(lines, "n", 0, 100, TRAVELER_CONTRACT)).toEqual({ x: 24, y: 156, w: 564, h: 24 });
  });
  it("resizeBox keeps a line's zero side and every other item at least one grid step", () => {
    expect(resizeBox(line("h", { x: 24, y: 100, w: 180, h: 0 }), "se", 9, 9, TRAVELER_CONTRACT)).toEqual({ x: 24, y: 100, w: 189, h: 0 });
    expect(resizeBox(line("v", { x: 100, y: 100, w: 0, h: 90 }), "se", 9, 9, TRAVELER_CONTRACT)).toEqual({ x: 100, y: 100, w: 0, h: 99 });
    const f = field("po_number", { box: { x: 120, y: 90, w: 130, h: 12 } });
    expect(resizeBox(f, "e", -500, 0, TRAVELER_CONTRACT)).toEqual({ x: 120, y: 90, w: CANVAS_GRID, h: 12 });
    expect(resizeBox(f, "n", 0, 100, TRAVELER_CONTRACT)).toEqual({ x: 120, y: 97.5, w: 130, h: CANVAS_GRID });
    // Never past the page's side margins.
    expect(resizeBox(f, "e", 500, 0, TRAVELER_CONTRACT)).toEqual({ x: 120, y: 90, w: 468, h: 12 });
  });
});

describe("a move's one commit (ruling C33)", () => {
  it("sameItemPlace: the same box, anchor and repeat, whatever else differs", () => {
    const logo = itemOf(standardLayout(), "logo");
    expect(sameItemPlace(logo, { ...logo, box: { ...logo.box } })).toBe(true);
    expect(sameItemPlace(logo, { ...logo, box: { ...logo.box, x: logo.box.x + CANVAS_GRID } })).toBe(false);
    expect(sameItemPlace(logo, { ...logo, box: { ...logo.box, h: logo.box.h + CANVAS_GRID } })).toBe(false);
    expect(sameItemPlace(logo, { ...logo, repeat: !logo.repeat })).toBe(false);
    expect(sameItemPlace(logo, { ...logo, anchor: { kind: "page-bottom" } })).toBe(false);
    const process = itemOf(standardLayout(), "field-process");
    expect(sameItemPlace(process, { ...process, anchor: { kind: "below-table", table: "lines" } })).toBe(false);
    expect(sameItemPlace(process, { ...process, anchor: { kind: "below-table", table: "quantities" } })).toBe(true);
  });
  it("movedItem commits a nudge or drag that moves the item, and nothing for one that leaves its place as it was", () => {
    const layout = standardLayout();
    const logo = itemOf(layout, "logo");
    // A nudge right moves the logo one grid step.
    expect(movedItem(layout, logo, NUDGE_FINE, 0)).toEqual({ ...logo, box: { ...logo.box, x: logo.box.x + NUDGE_FINE } });
    // A nudge left against the margin (the logo sits at 24) is clamped where it was: no commit.
    expect(logo.box.x).toBe(24);
    expect(movedItem(layout, logo, -NUDGE_FINE, 0)).toBeNull();
    expect(movedItem(layout, logo, -NUDGE_COARSE, 0)).toBeNull();
    // A click that moves less than half a grid step commits nothing, even on an item a drop would
    // re-anchor (a page-top note drawn under Quantities' bottom would hang below it).
    expect(movedItem(layout, logo, 1, 1)).toBeNull();
    const withNote = layoutOf([...layout.items, text("note", { x: 300, y: 250, w: 100, h: 12 })]);
    expect(movedItem(withNote, itemOf(withNote, "note"), 1, 1)).toBeNull();
    expect(movedItem(withNote, itemOf(withNote, "note"), NUDGE_FINE, 0)?.anchor).toEqual({ kind: "below-table", table: "quantities" });
    // The commit is the drop's (`dropBox` from the stage box), measure and band included.
    const process = itemOf(layout, "field-process");
    const measure = measureOf(layout, 30);
    expect(movedItem(layout, process, 0, NUDGE_FINE, { measure }))
      .toEqual({ ...process, ...dropBox(layout, process, moveBox(stageBox(process, layout, measure).box, 0, NUDGE_FINE), { measure }) });
  });
});

describe("dropping and anchoring", () => {
  it("a field dragged under the lines table hangs below it by an offset, and dragged above it is page-top again (Review Focus 1)", () => {
    const layout = standardLayout();
    const po = itemOf(layout, "field-po_number");
    const below = dropBox(layout, po, { x: 300, y: 184.5, w: 130, h: 12 });
    expect(below).toEqual({ anchor: { kind: "below-table", table: "lines" }, box: { x: 300, y: 4.5, w: 130, h: 12 }, repeat: false });
    const moved = replaceItem(layout, { ...po, ...below });
    expect(drawnBox(itemOf(moved, "field-po_number"), moved)).toEqual({ x: 300, y: 184.5, w: 130, h: 12 });
    const above = dropBox(moved, itemOf(moved, "field-po_number"), { x: 300, y: 126, w: 130, h: 12 });
    expect(above).toEqual({ anchor: { kind: "page-top" }, box: { x: 300, y: 126, w: 130, h: 12 }, repeat: false });
    // A below-table item dragged above its own table: page-top, in page coordinates.
    const process = itemOf(layout, "field-process");
    expect(dropBox(layout, process, { x: 24, y: 126, w: 180, h: 12 }))
      .toEqual({ anchor: { kind: "page-top" }, box: { x: 24, y: 126, w: 180, h: 12 }, repeat: false });
  });
  it("a table keeps its anchor and its page coordinates", () => {
    const layout = standardLayout();
    const steps = itemOf(layout, "table-steps");
    expect(dropBox(layout, steps, { x: 24, y: 348, w: 564, h: 120 }))
      .toEqual({ anchor: { kind: "below-table", table: "inspections" }, box: { x: 24, y: 348, w: 564, h: 120 }, repeat: false });
  });
  it("a table the measure pushed down moves by the drag alone (ruling C8 a)", () => {
    const layout = standardLayout();
    const steps = itemOf(layout, "table-steps");
    const measure = measureOf(layout, 0);
    measure.tables = measure.tables.map((t) => (t.key === "steps" ? { ...t, top: t.top + 100 } : t));
    const staged = stageBox(steps, layout, measure).box;
    expect(staged).toEqual({ x: 24, y: 439, w: 564, h: 120 });
    // Dragged 20 down and 9 right on the stage: the model box moves by 20 and 9, not to the stage's 459.
    expect(dropBox(layout, steps, { ...staged, x: 33, y: 459 }, { measure }))
      .toEqual({ anchor: { kind: "below-table", table: "inspections" }, box: { x: 33, y: 359, w: 564, h: 120 }, repeat: false });
  });
  it("answers repeat: false under a table and the item's own repeat elsewhere (ruling C5)", () => {
    const layout = standardLayout();
    const order = { ...itemOf(layout, "field-order_number"), repeat: true } as CanvasItem;
    const repeated = replaceItem(layout, order);
    const under = dropBox(repeated, order, { x: 300, y: 184.5, w: 130, h: 12 });
    expect(under).toMatchObject({ anchor: { kind: "below-table", table: "lines" }, repeat: false });
    expect(valid(replaceItem(repeated, { ...order, ...under } as CanvasItem))).not.toThrow();
    expect(dropBox(repeated, order, { x: 260, y: 99, w: 130, h: 12 }))
      .toEqual({ anchor: { kind: "page-top" }, box: { x: 260, y: 99, w: 130, h: 12 }, repeat: true });
  });
  it("a table that runs onto page 2 holds its place on a sideways nudge (ruling C10)", () => {
    for (const w of [564, 540]) {
      const layout = layoutOf(standardLayout().items.map((i) => (i.id === "table-steps" ? { ...i, box: { ...i.box, w } } : i)));
      const steps = itemOf(layout, "table-steps");
      const measure = measureOf(layout, 0);
      measure.tables = measure.tables.map((t) => (t.key === "steps" ? { ...t, top: 339, height: 600 } : t));
      measure.regions = measure.regions.map((r) => (r.after === "steps" ? { ...r, page: 2, top: 171 } : r));
      // The stage is page 1: the table is drawn down to the page's usable bottom, 768 − 339 = 429.
      const staged = stageBox(steps, layout, measure).box;
      expect(staged).toEqual({ x: 24, y: 339, w, h: 429 });
      const drop = dropBox(layout, steps, moveBox(staged, NUDGE_FINE, 0), { measure });
      // Full width it cannot move sideways and stays put; narrower it moves one grid step.
      expect(drop.box).toEqual({ x: w === 564 ? 24 : 28.5, y: 339, w, h: 120 });
      expect(valid(replaceItem(layout, { ...steps, ...drop } as CanvasItem))).not.toThrow();
    }
  });
  it("a drag on an item that prints on another page moves the model by the delta and keeps its anchor (ruling C13)", () => {
    // (a) The steps table measured wholly on page 2: drawn dashed at its drawn box, nudged from there.
    for (const w of [540, 564]) {
      const layout = layoutOf(standardLayout().items.map((i) => (i.id === "table-steps" ? { ...i, box: { ...i.box, w } } : i)));
      const steps = itemOf(layout, "table-steps");
      const measure = measureOf(layout, 0);
      measure.tables = measure.tables.map((t) => (t.key === "steps" ? { ...t, page: 2, top: 60, height: 200 } : t));
      expect(stageBox(steps, layout, measure).page).toBe(2);
      const drop = dropBox(layout, steps, moveBox(drawnBox(steps, layout), NUDGE_FINE, 0), { measure });
      // Narrower it moves one grid step; full width the margin holds it and the model box is unchanged.
      expect(drop).toEqual({ anchor: steps.anchor, box: { x: w === 540 ? 28.5 : 24, y: 339, w, h: 120 }, repeat: false });
    }
    // (b) The Results box hangs below steps, whose region is on page 2: it keeps its anchor and offset.
    const layout = standardLayout();
    const measure = measureOf(layout, 0);
    measure.regions = measure.regions.map((r) => (r.after === "steps" ? { ...r, page: 2, top: 171 } : r));
    const results = itemOf(layout, "field-results");
    expect(stageBox(results, layout, measure).page).toBe(2);
    expect(dropBox(layout, results, moveBox(drawnBox(results, layout), NUDGE_FINE, 0), { measure }))
      .toEqual({ anchor: { kind: "below-table", table: "steps" }, box: { x: 28.5, y: 8, w: 180, h: 12 }, repeat: false });
    // A page-bottom item that prints on the last page only (page 2) moves by the delta, unclamped.
    const signed = layoutOf([...layout.items, text("sign", { x: 24, y: 740, w: 200, h: 12 }, { kind: "page-bottom" })]);
    const sign = itemOf(signed, "sign");
    const twoPages = { ...measureOf(signed, 0), pages: 2 };
    expect(stageBox(sign, signed, twoPages).page).toBe(2);
    expect(dropBox(signed, sign, moveBox(drawnBox(sign, signed), NUDGE_FINE, -NUDGE_COARSE), { measure: twoPages }))
      .toEqual({ anchor: { kind: "page-bottom" }, box: { x: 28.5, y: 722, w: 200, h: 12 }, repeat: false });
  });
  it("infers a drop's anchor against page 1's bottoms only (ruling C11)", () => {
    const layout = standardLayout();
    const measure = measureOf(layout, 0);
    measure.regions = measure.regions.map((r) => (r.after === "steps" ? { ...r, page: 2, top: 100 } : r));
    const name = itemOf(layout, "field-customer_name");
    // 110 is above the lines table's bottom (180) on page 1; the steps region's top of 100 is page 2's.
    expect(dropBox(layout, name, { x: 120, y: 110, w: 130, h: 12 }, { measure }))
      .toEqual({ anchor: { kind: "page-top" }, box: { x: 120, y: 110, w: 130, h: 12 }, repeat: false });
    // Under the lines table on page 1 it still hangs below lines.
    expect(dropBox(layout, name, { x: 300, y: 184.5, w: 130, h: 12 }, { measure }).anchor)
      .toEqual({ kind: "below-table", table: "lines" });
  });
  it("infers the anchor against the table bottoms the stage shows, and the answer draws where it was dropped (ruling C8 c)", () => {
    const layout = standardLayout();
    // The lines table measures 50 taller than drawn (bottom 230, not 180); everything under it 50 lower.
    const measure = measureOf(layout, 50);
    measure.tables = measure.tables.map((t) => (t.key === "lines" ? { ...t, top: 140, height: 90 } : t));
    const po = itemOf(layout, "field-po_number");
    const dropped = { x: 300, y: 239, w: 130, h: 12 };
    const answer = dropBox(layout, po, dropped, { measure });
    expect(answer).toEqual({ anchor: { kind: "below-table", table: "lines" }, box: { x: 300, y: 9, w: 130, h: 12 }, repeat: false });
    const placed = replaceItem(layout, { ...po, ...answer } as CanvasItem);
    expect(stageBox(itemOf(placed, "field-po_number"), placed, measure).box).toEqual(dropped);
    // Dropped 9 pt above the measured bottom (inside the table as the stage shows it): page-top, as dropped.
    expect(dropBox(layout, po, { ...dropped, y: 221 }, { measure }))
      .toEqual({ anchor: { kind: "page-top" }, box: { ...dropped, y: 221 }, repeat: false });
    // A hung item is moved in stage coordinates too: the footer's Results box, staged 50 lower.
    const results = itemOf(layout, "field-results");
    const staged = stageBox(results, layout, measure).box;
    expect(staged.y).toBe(drawnBox(results, layout).y + 50);
    expect(dropBox(layout, results, { ...staged, y: staged.y + 9 }, { measure }))
      .toMatchObject({ anchor: { kind: "below-table", table: "steps" }, box: { y: results.box.y + 9 } });
  });
  it("a page-bottom item dropped above the band stays page-bottom, clamped into the band as it stood", () => {
    const bottom = { kind: "page-bottom" } as const;
    const layout = layoutOf([...standardLayout().items, text("top", { x: 24, y: 700, w: 200, h: 12 }, bottom),
      text("low", { x: 24, y: 730, w: 200, h: 12 }, bottom)]);
    expect(dropBox(layout, itemOf(layout, "low"), { x: 24, y: 400, w: 200, h: 12 }))
      .toEqual({ anchor: bottom, box: { x: 24, y: 700, w: 200, h: 12 }, repeat: false });
    expect(dropBox(layout, itemOf(layout, "low"), { x: 24, y: 760, w: 200, h: 12 }))
      .toEqual({ anchor: bottom, box: { x: 24, y: 756, w: 200, h: 12 }, repeat: false });
    // With the page line on, the band ends at 748.
    expect(dropBox(layout, itemOf(layout, "low"), { x: 24, y: 760, w: 200, h: 12 }, { pageFooter: true }).box.y).toBe(736);
  });
  it("setAnchor converts the box between page and offset coordinates and clears repeat below a table", () => {
    const layout = layoutOf([...standardLayout().items, text("note", { x: 300, y: 200, w: 100, h: 12 })]);
    const note = { ...itemOf(layout, "note"), repeat: true } as CanvasItem;
    const hung = setAnchor(layout, note, { kind: "below-table", table: "lines" });
    expect(hung.anchor).toEqual({ kind: "below-table", table: "lines" });
    expect(hung.box).toEqual({ x: 300, y: 20, w: 100, h: 12 });
    expect(hung.repeat).toBe(false);
    const withHung = replaceItem(layout, hung);
    expect(setAnchor(withHung, hung, { kind: "page-top" }).box.y).toBe(200);
    expect(setAnchor(withHung, hung, { kind: "page-bottom" })).toMatchObject({ anchor: { kind: "page-bottom" }, box: { y: 200 } });
    // A repeated page-top item set to page-bottom keeps its repeat.
    expect(setAnchor(layout, note, { kind: "page-bottom" }).repeat).toBe(true);
    // A table's anchor is derived, never set.
    const steps = itemOf(layout, "table-steps");
    expect(setAnchor(layout, steps, { kind: "page-top" })).toEqual(steps);
  });
});

describe("placing and the palette", () => {
  const entry = (kind: CanvasItem["kind"], key?: string): PaletteEntry => ({ kind, key, label: "", group: "", state: "available" });

  it("places a new item at the first free grid row under the lowest page-top item, overlapping nothing", () => {
    const layout = standardLayout();
    const first = placeNew(layout, TRAVELER_CONTRACT, entry("field", "process_id"));
    // The header's lowest row ends at 124: the next grid row is 126, clear of the lines table at 140.
    expect(first).toMatchObject({ kind: "field", key: "process_id", label: null, anchor: { kind: "page-top" }, repeat: false,
      box: { x: 24, y: 126, w: 180, h: 12 }, style: { size: 8, bold: false, align: "left" } });
    expect(overlapsAny(replaceItem(layout, first), first)).toBe(false);
    const withFirst = layoutOf([...layout.items, first]);
    expect(overlapsAny(withFirst, first)).toBe(false);
    // The next row down is taken by the tables and the items hung below them: the first free row is
    // under the footer's lowest (527), at 531, which hangs below the steps table (bottom 459).
    const second = placeNew(withFirst, TRAVELER_CONTRACT, entry("text"));
    expect(second).toMatchObject({ kind: "text", anchor: { kind: "below-table", table: "steps" }, box: { x: 24, y: 72, w: 180, h: 12 } });
    const withBoth = layoutOf([...withFirst.items, second]);
    expect(overlapsAny(withBoth, second)).toBe(false);
    expect(valid(withBoth)).not.toThrow();
    expect(first.id).not.toBe(second.id);
    expect(first.id).not.toBe("");
  });
  it("never places a new item in the page-bottom band: with no free row above it, the item takes the first row, overlapping, for the user to drag", () => {
    const steps = table("steps", { box: { x: 24, y: 100, w: 564, h: 600 } });
    const sign = (y: number) => text("sign", { x: 24, y, w: 564, h: 12 }, { kind: "page-bottom" });
    const roomy = layoutOf([barcode(), steps, sign(720)]);
    const tight = layoutOf([barcode(), steps, sign(705)]);
    expect(valid(roomy)).not.toThrow();
    expect(valid(tight)).not.toThrow();
    // Steps ends at 700 and the band starts at 720: the row at 702 is free and above it.
    expect(placeNew(roomy, TRAVELER_CONTRACT, entry("text")))
      .toMatchObject({ anchor: { kind: "below-table", table: "steps" }, box: { x: 24, y: 2, w: 180, h: 12 } });
    // With the band at 705 no 12 pt row fits between 700 and it; the free row at 717 is in the band.
    // The item takes the first row under the barcode (94.5), over the steps table.
    const crowded = placeNew(tight, TRAVELER_CONTRACT, entry("text"));
    expect(crowded).toMatchObject({ anchor: { kind: "page-top" }, box: { x: 24, y: 94.5, w: 180, h: 12 } });
    expect(overlapsAny(layoutOf([...tight.items, crowded]), crowded)).toBe(true);
  });
  it("keeps a new item out of the page line's room when the template prints the page line", () => {
    const layout = layoutOf([barcode(), table("steps", { box: { x: 24, y: 100, w: 564, h: 645 } })]);
    expect(() => validateCanvasLayout(layout, TRAVELER_CONTRACT, { pageFooter: true })).not.toThrow();
    // Steps ends at 745: the row at 747 ends at 759, under the 768 foot but past the page line's 748.
    expect(placeNew(layout, TRAVELER_CONTRACT, entry("text")))
      .toMatchObject({ anchor: { kind: "below-table", table: "steps" }, box: { y: 2 } });
    expect(placeNew(layout, TRAVELER_CONTRACT, entry("text"), { pageFooter: true }))
      .toMatchObject({ anchor: { kind: "page-top" }, box: { y: 94.5 } });
  });
  it("sizes each kind: a line 180 × 0, a box 90 × 45, the logo 80 × 40", () => {
    const empty = layoutOf([barcode(), table("steps")]);
    expect(placeNew(empty, TRAVELER_CONTRACT, entry("line")).box).toMatchObject({ w: 180, h: 0 });
    expect(placeNew(empty, TRAVELER_CONTRACT, entry("box")).box).toMatchObject({ w: 90, h: 45 });
    expect(placeNew(empty, TRAVELER_CONTRACT, entry("logo")).box).toMatchObject({ w: 80, h: 40 });
    expect(placeNew(empty, TRAVELER_CONTRACT, entry("text")).box).toMatchObject({ w: 180, h: 12 });
  });
  it("places a table the content width wide, one row tall, below the lowest table and what hangs under it, with the contract's columns", () => {
    const layout = layoutOf(standardLayout().items.filter((i) => i.id !== "table-lines"));
    const lines = placeNew(layout, TRAVELER_CONTRACT, entry("table", "lines"));
    // The steps table ends at 459 and the footer hung under it at 527: one grid step lower.
    expect(lines).toMatchObject({ kind: "table", key: "lines", heading: null, repeat: false,
      anchor: { kind: "below-table", table: "steps" }, box: { x: 24, y: 531.5, w: 564, h: 24 } });
    expect(lines.kind === "table" && lines.columns).toEqual(defaultTableColumns(TRAVELER_CONTRACT, "lines"));
    expect(placeNew(layoutOf([barcode()]), TRAVELER_CONTRACT, entry("table", "steps")))
      .toMatchObject({ anchor: { kind: "page-top" }, box: { x: 24, y: 140, w: 564, h: 24 } });
  });
  it("lists the contract's fields by section, then the tables and the page items, marking what is placed and required", () => {
    const entries = paletteEntries(standardLayout(), TRAVELER_CONTRACT);
    expect([...new Set(entries.map((e) => e.group))]).toEqual(["Header", "Process row", "Results and sign-off", "Tables", "Page items"]);
    const find = (kind: CanvasItem["kind"], key?: string) => entries.find((e) => e.kind === kind && e.key === key);
    expect(find("barcode")).toMatchObject({ label: "Barcode", state: "required" });
    expect(find("table", "lines")).toMatchObject({ label: "Part lines table", state: "placed" });
    expect(find("table", "steps")).toMatchObject({ label: "Process steps table", state: "required" });
    expect(find("field", "company_name")).toMatchObject({ label: "Company name", group: "Header", state: "placed" });
    expect(find("logo")).toMatchObject({ label: "Logo", state: "placed" });
    for (const kind of ["text", "line", "box"] as const) expect(find(kind)).toMatchObject({ state: "available" });
    expect(entries.map((e) => e.kind).slice(-9)).toEqual(["table", "table", "table", "table", "barcode", "logo", "text", "line", "box"]);
    // The barcode, the headings and the typed step values are not fields a canvas places.
    expect(entries.filter((e) => e.kind === "field").map((e) => e.key)).not.toContain("barcode");
    expect(entries.filter((e) => e.kind === "field").map((e) => e.key)).not.toContain("steps_title");
    const cleared = paletteEntries(clearedLayout(TRAVELER_CONTRACT), TRAVELER_CONTRACT);
    expect(cleared.find((e) => e.kind === "table" && e.key === "lines")?.state).toBe("available");
    expect(cleared.find((e) => e.kind === "logo")?.state).toBe("available");
    expect(cleared.filter((e) => e.kind === "field").every((e) => e.state === "available")).toBe(true);
  });
  it("clearedLayout holds the belt's barcode and steps table, fresh ids each time, and passes the rules", () => {
    const cleared = clearedLayout(TRAVELER_CONTRACT);
    expect(cleared.items).toHaveLength(2);
    expect(cleared.items[0]).toMatchObject({ kind: "barcode", box: { x: 402, y: 48, w: 186, h: 44 }, anchor: { kind: "page-top" }, repeat: true });
    expect(cleared.items[1]).toMatchObject({ kind: "table", key: "steps", heading: null, repeat: false,
      box: { x: 24, y: 140, w: 564, h: 24 }, anchor: { kind: "page-top" }, columns: defaultTableColumns(TRAVELER_CONTRACT, "steps") });
    expect(valid(cleared)).not.toThrow();
    expect(clearedLayout(TRAVELER_CONTRACT).items[0].id).not.toBe(cleared.items[0].id);
  });
  it("clearedLayout stacks the required tables, each one grid step under the one before and anchored below it", () => {
    const twoTables = {
      ...TRAVELER_CONTRACT,
      canvas: { ...TRAVELER_CANVAS, required: [{ kind: "table" as const, key: "steps", reason: "" }, { kind: "table" as const, key: "lines", reason: "" }] },
    };
    const cleared = clearedLayout(twoTables);
    // The rules accept it (two tables at 140 would be refused by the stacking rule, rule 5).
    expect(() => validateCanvasLayout(cleared, twoTables)).not.toThrow();
    expect(cleared.items).toHaveLength(2);
    expect(cleared.items[0]).toMatchObject({ kind: "table", key: "steps", anchor: { kind: "page-top" }, box: { x: 24, y: 140, w: 564, h: 24 } });
    expect(cleared.items[1]).toMatchObject({
      kind: "table", key: "lines", anchor: { kind: "below-table", table: "steps" }, box: { x: 24, y: 140 + 24 + 4.5, w: 564, h: 24 },
    });
  });
  it("itemTitle names an item as the palette does", () => {
    const layout = standardLayout();
    expect(itemTitle(itemOf(layout, "field-company_name"), TRAVELER_CONTRACT)).toBe("Company name");
    expect(itemTitle(itemOf(layout, "table-lines"), TRAVELER_CONTRACT)).toBe("Part lines table");
    expect(itemTitle(itemOf(layout, "logo"), TRAVELER_CONTRACT)).toBe("Logo");
    expect(itemTitle(itemOf(layout, "barcode"), TRAVELER_CONTRACT)).toBe("Barcode");
    expect(itemTitle(field("nonsense"), TRAVELER_CONTRACT)).toBe('Field "nonsense"');
  });
  it("replaceItem and removeItem are pure copies", () => {
    const layout = standardLayout();
    const before = structuredClone(layout);
    const logo = itemOf(layout, "logo");
    const moved = replaceItem(layout, { ...logo, box: { ...logo.box, x: 48 } });
    expect(itemOf(moved, "logo").box.x).toBe(48);
    expect(moved.items.map((i) => i.id)).toEqual(layout.items.map((i) => i.id));
    const less = removeItem(layout, "barcode");
    expect(less.items.some((i) => i.id === "barcode")).toBe(false);
    expect(less.items).toHaveLength(layout.items.length - 1);
    expect(layout).toEqual(before);
  });
  it("removeItem re-homes what hung below a removed table at its drawn place (ruling C30)", () => {
    const layout = standardLayout();
    const dependents = layout.items.filter((i) => i.anchor.kind === "below-table" && i.anchor.table === "quantities");
    // The three process fields and the Inspections table hang below Quantities.
    expect(dependents.map((i) => i.id).sort()).toEqual(["field-material", "field-process", "field-process_id", "table-inspections"]);
    const less = removeItem(layout, "table-quantities");
    expect(less.items.some((i) => i.id === "table-quantities")).toBe(false);
    expect(less.items).toHaveLength(layout.items.length - 1);
    for (const dependent of dependents) {
      const after = itemOf(less, dependent.id);
      expect(drawnBox(after, less)).toEqual(drawnBox(dependent, layout));
      expect(after.anchor).not.toEqual({ kind: "below-table", table: "quantities" });
    }
    // The process row is drawn at 244.5, under Part lines' bottom at 180: it now hangs below Part
    // lines at an offset of 64.5, and the Inspections table's derived anchor is Part lines too.
    expect(itemOf(less, "field-process").anchor).toEqual({ kind: "below-table", table: "lines" });
    expect(itemOf(less, "field-process").box).toEqual({ x: 24, y: 64.5, w: 180, h: 12 });
    expect(itemOf(less, "table-inspections").anchor).toEqual({ kind: "below-table", table: "lines" });
    expect(itemOf(less, "table-inspections").box).toEqual(itemOf(layout, "table-inspections").box);
    // Everything else is untouched, and the layout the rules accepted is still accepted.
    for (const item of less.items) {
      if (!dependents.some((d) => d.id === item.id)) expect(item).toEqual(itemOf(layout, item.id));
    }
    expect(valid(less)).not.toThrow();
    // An item that hung below the removed table and lies above every other table goes page-top.
    const high = layoutOf([...standardLayout().items, text("note", { x: 300, y: 0, w: 100, h: 12 }, { kind: "below-table", table: "lines" })]);
    const rehomed = itemOf(removeItem(high, "table-lines"), "note");
    expect(rehomed.anchor).toEqual({ kind: "page-top" });
    expect(rehomed.box).toEqual({ x: 300, y: 180, w: 100, h: 12 });
  });
});

describe("where the stage draws an item", () => {
  it("draws at the drawn box without a measure", () => {
    const layout = standardLayout();
    for (const item of layout.items) {
      expect(stageBox(item, layout, null)).toEqual({ box: drawnBox(item, layout), page: 1, measured: false });
    }
  });
  it("follows a measured region: a below-table item at the region's top plus its offset, a table at its measured top and height", () => {
    const layout = standardLayout();
    const measure = measureOf(layout, 0);
    measure.tables = measure.tables.map((t) => (t.key === "steps" ? { ...t, height: 300 } : t));
    measure.regions = measure.regions.map((r) => (r.after === "steps" ? { ...r, top: 339 + 300, page: 2 } : r));
    expect(stageBox(itemOf(layout, "table-steps"), layout, measure)).toEqual({ box: { x: 24, y: 339, w: 564, h: 300 }, page: 1, measured: true });
    expect(stageBox(itemOf(layout, "field-results"), layout, measure)).toEqual({ box: { x: 24, y: 647, w: 180, h: 12 }, page: 2, measured: true });
    expect(stageBox(itemOf(layout, "field-customer_name"), layout, measure))
      .toEqual({ box: itemOf(layout, "field-customer_name").box, page: 1, measured: true });
  });
  it("a page-bottom item prints in the band on the last page, or on the first when it repeats", () => {
    const layout = layoutOf([...standardLayout().items, text("sign", { x: 24, y: 740, w: 200, h: 12 }, { kind: "page-bottom" })]);
    const measure = { ...measureOf(layout, 0), pages: 3 };
    expect(stageBox(itemOf(layout, "sign"), layout, measure)).toEqual({ box: { x: 24, y: 740, w: 200, h: 12 }, page: 3, measured: false });
    expect(stageBox({ ...itemOf(layout, "sign"), repeat: true } as CanvasItem, layout, measure).page).toBe(1);
  });
  it("a header 40 pt taller moves every process and footer item down by 40, with no warning (Review Focus 2)", () => {
    const layout = standardLayout();
    const measure = measureOf(layout, 40);
    const hung = layout.items.filter((i) => i.kind !== "table" && i.anchor.kind === "below-table");
    expect(hung.map((i) => i.id)).toEqual([
      "field-process", "field-material", "field-process_id",
      "field-results", "field-tempered_results", "field-final_inspection", "field-pass", "field-fail",
      "field-tested_by", "field-tested_date", "field-ok_to_ship", "field-ship_date",
    ]);
    for (const item of hung) {
      const staged = stageBox(item, layout, measure);
      expect(staged.measured).toBe(true);
      expect(staged.box.y).toBe(drawnBox(item, layout).y + 40);
    }
    expect(canvasWarnings(layout, TRAVELER_CONTRACT, measure)).toEqual([]);
  });
});

describe("a table the picked record leaves empty (#958)", () => {
  // The ticket's standard stack: serials stored at { x: 24, y: 244, w: 564, h: 15 } (the 15 pt
  // floor), measured at 250 with a region 51 tall (its drawn gap to totals at 310).
  const layout = standardTicketLayout();
  const serials = itemOf(layout, "table-serials");
  const emptyAt = (height: number, at: { page: number; top: number } = { page: 1, top: 250 }): CanvasMeasure => ({
    pages: at.page, tables: [{ key: "serials", page: at.page, top: at.top, height }],
    regions: [{ after: "serials", page: at.page, top: at.top, height: 51 }], items: [],
  });

  // Red when `printsNothing` reads the raw height (`entry.height === 0`) in place of `round2`'s,
  // for every figure but 0 itself.
  it.each([0, 1e-14, -1e-14, 0.004])("a table measured %s tall prints nothing", (height) => {
    expect(printsNothing(serials, emptyAt(height))).toBe(true);
  });
  // Red when the rounding is loosened (`round2(entry.height) <= 0.01`).
  it("a table measured 0.01 tall prints", () => {
    expect(printsNothing(serials, emptyAt(0.01))).toBe(false);
  });
  // Red when a table the measure does not hold is taken as empty (`entry === undefined || …`).
  it("a table with no measure, or one the measure does not hold, is not judged empty", () => {
    expect(printsNothing(serials, null)).toBe(false);
    expect(printsNothing(serials, { pages: 1, tables: [{ key: "containers", page: 1, top: 208, height: 0 }], regions: [], items: [] }))
      .toBe(false);
  });
  it("a non-table item sharing the measured table's key is never judged empty", () => {
    // Red when the `kind === "table"` guard is removed.
    expect(printsNothing({ ...ticketField("order_no"), key: "serials" }, emptyAt(0))).toBe(false);
  });
  it("draws an empty table at its drawn box on page 1", () => {
    expect(stageBox(serials, layout, emptyAt(0))).toEqual({ box: { x: 24, y: 244, w: 564, h: 15 }, page: 1, measured: true });
    expect(stageBox(serials, layout, emptyAt(0)).box).toEqual(drawnBox(serials, layout));
  });
  it("draws an empty table measured on a later page at its drawn box on page 1, since it prints on no page", () => {
    expect(stageBox(serials, layout, emptyAt(0, { page: 2, top: 40 })))
      .toEqual({ box: { x: 24, y: 244, w: 564, h: 15 }, page: 1, measured: true });
  });
  // Today's branch. Red when the rounding is loosened (`round2(entry.height) <= 0.01`).
  it("draws a table measured 0.01 tall at its measured top and height", () => {
    expect(stageBox(serials, layout, emptyAt(0.01))).toEqual({ box: { x: 24, y: 250, w: 564, h: 0.01 }, page: 1, measured: true });
  });
  // Red when the words change.
  it("names it in the ruling's words", () => {
    expect(DESIGNER_WORDS.printsNothing).toBe("Prints nothing for this record");
  });

  // Task 2: drag, nudge, clamp, resize and drop follow the drawn box the stage draws.
  // Red when Task 1's `printsNothing` branch is removed from `stageBox` (the drag then starts at the
  // measured top, 250, 0 tall).
  it("starts a drag of an empty table from its drawn box", () => {
    expect(dragStart(serials, layout, emptyAt(0))).toEqual({ x: 24, y: 244, w: 564, h: 15 });
  });
  // Red when Task 1's `printsNothing` branch is removed from `stageBox` (the clamp height is then 0).
  it("clamps a move of an empty table by its stored height", () => {
    expect(moveClampHeight(serials, dragStart(serials, layout, emptyAt(0)))).toBe(15);
  });
  it("moves an empty table's stored box by the drag's delta (pin)", () => {
    expect(movedItem(layout, serials, 0, 9, { measure: emptyAt(0) })!.box).toEqual({ x: 24, y: 253, w: 564, h: 15 });
  });
  // Red when Task 1's `printsNothing` branch is removed from `stageBox`: the 0-tall stage box is then
  // clamped with its top at the foot (768) and the table is stored at 762, its drawn bottom past it.
  it("stops an empty table dragged toward the foot with its stored bottom at the foot", () => {
    expect(movedItem(layout, serials, 0, 1000, { measure: emptyAt(0) })!.box.y).toBe(768 - 15);
  });
  // Red when Task 1's `printsNothing` branch is removed from `stageBox`: the box drawn during the drag
  // is then { x: 24, y: 250, w: 564, h: 9 }, not the box the release commits.
  it("draws an empty table's bottom-handle drag at the box the release commits", () => {
    const drawn = resizedBox(serials, layout, emptyAt(0), "s", 0, 9, SHIPPER_CONTRACT);
    expect(drawn).toEqual(resizedItem(serials, layout, emptyAt(0), "s", 0, 9, SHIPPER_CONTRACT)!.box);
    expect(drawn).toEqual({ x: 24, y: 244, w: 564, h: 24 });
  });
  // Red when `stageBottoms` reads the drawn bottom (`table.box.y + table.box.h`, 259) for a table
  // `printsNothing` holds: the drop at 254 then anchors below the containers (238) instead.
  it("anchors an item dropped inside an empty table's hatch below it, at its offset from the region's top", () => {
    const note = text("note", { x: 300, y: 100, w: 100, h: 12 });
    const measure = emptyAt(0);
    const answer = dropBox(layout, note, { x: 300, y: 254, w: 100, h: 12 }, { measure });
    expect(answer.anchor).toEqual({ kind: "below-table", table: "serials" });
    expect(answer.box).toEqual({ x: 300, y: 254 - 250, w: 100, h: 12 });
    expect(answer.repeat).toBe(false);
    expect(stageBox({ ...note, ...answer } as CanvasItem, layout, measure).box.y).toBe(254);
  });
  // The statement's finance-charge block, empty on every preview (statement design :265), with no PR 2
  // needed. Red when Task 1's `printsNothing` branch is removed from `stageBox` (the stageBox half: the
  // block is then drawn at its measured top, 199, 0 tall); the move stores 9 lower either way.
  it("draws the statement's empty finance-charge block at its drawn box and moves it by the delta", () => {
    const statement = standardStatementLayout();
    const finance = itemOf(statement, "table-finance_charge");
    const measure: CanvasMeasure = {
      pages: 1, tables: [{ key: "finance_charge", page: 1, top: 199, height: 0 }],
      regions: [{ after: "finance_charge", page: 1, top: 199, height: 9 }], items: [],
    };
    expect(stageBox(finance, statement, measure)).toEqual({ box: drawnBox(finance, statement), page: 1, measured: true });
    expect(movedItem(statement, finance, 0, 9, { measure })!.box.y).toBe(finance.box.y + 9);
  });
});

describe("a measured item's height (ticket canvas PR 2b)", () => {
  // A page-top field 180 × 12 at (400, 99): above every table, so a drag 9 down stays page-top.
  const withParty = () => layoutOf([...standardLayout().items, field("party", { box: { x: 400, y: 99, w: 180, h: 12 } })]);
  // A page-bottom item 180 × 12 alone in the band, whose top it is.
  const withBand = (repeat = false) =>
    layoutOf([...standardLayout().items, { ...text("sign", { x: 24, y: 700, w: 180, h: 12 }, { kind: "page-bottom" }), repeat } as CanvasItem]);

  it("stageBox draws a measured item at its drawn height or its measured height, whichever is taller", () => {
    const layout = withParty();
    const party = itemOf(layout, "field-party");
    expect(stageBox(party, layout, tallerMeasure(layout, { "field-party": { height: 30 } })))
      .toEqual({ box: { x: 400, y: 99, w: 180, h: 30 }, page: 1, measured: true });
    expect(stageBox(party, layout, tallerMeasure(layout, { "field-party": { height: 9 } })))
      .toEqual({ box: { x: 400, y: 99, w: 180, h: 12 }, page: 1, measured: true });
    // A below-table item: at its region's top plus its offset, on the region's page, the taller height.
    const process = itemOf(layout, "field-process");
    expect(stageBox(process, layout, tallerMeasure(layout, { "field-process": { height: 20 } })))
      .toEqual({ box: { x: 24, y: 240 + 4.5, w: 180, h: 20 }, page: 1, measured: true });
    const pushed = tallerMeasure(layout, { "field-process": { height: 20 } });
    pushed.regions = pushed.regions.map((r) => (r.after === "quantities" ? { ...r, page: 2, top: 100 } : r));
    expect(stageBox(process, layout, pushed)).toEqual({ box: { x: 24, y: 104.5, w: 180, h: 20 }, page: 2, measured: true });
  });
  it("stageBox puts a page-bottom item on the page its entry names, at the taller height, and without one on today's page", () => {
    const layout = withBand();
    const sign = itemOf(layout, "sign");
    expect(stageBox(sign, layout, tallerMeasure(layout, { sign: { height: 30, page: 3 } }, 3)))
      .toEqual({ box: { x: 24, y: 700, w: 180, h: 30 }, page: 3, measured: true });
    expect(stageBox(sign, layout, tallerMeasure(layout, { sign: { height: 9, page: 3 } }, 3)).box.h).toBe(12);
    expect(stageBox(sign, layout, tallerMeasure(layout, {}, 3)))
      .toEqual({ box: { x: 24, y: 700, w: 180, h: 12 }, page: 3, measured: false });
    const repeated = withBand(true);
    expect(stageBox(itemOf(repeated, "sign"), repeated, tallerMeasure(repeated, {}, 3)).page).toBe(1);
    expect(stageBox(itemOf(repeated, "sign"), repeated, tallerMeasure(repeated, { sign: { height: 30, page: 1 } }, 3)))
      .toEqual({ box: { x: 24, y: 700, w: 180, h: 30 }, page: 1, measured: true });
  });
  it("a drag never stores a measured height: page-top, below-table and page-bottom keep the model's size", () => {
    const layout = withParty();
    const party = itemOf(layout, "field-party");
    const measure = tallerMeasure(layout, { "field-party": { height: 30 } });
    const staged = stageBox(party, layout, measure).box;
    expect(dropBox(layout, party, moveBox(staged, 0, 9), { measure }))
      .toEqual({ anchor: { kind: "page-top" }, box: { x: 400, y: 108, w: 180, h: 12 }, repeat: false });
    expect(movedItem(layout, party, 0, 9, { measure })).toEqual({ ...party, box: { x: 400, y: 108, w: 180, h: 12 } });
    expect(movedItem(layout, party, NUDGE_FINE, 0, { measure })).toEqual({ ...party, box: { x: 404.5, y: 99, w: 180, h: 12 } });
    // A below-table item measured 20 tall in its 12 pt box.
    const process = itemOf(layout, "field-process");
    const hung = tallerMeasure(layout, { "field-process": { height: 20 } });
    expect(dropBox(layout, process, moveBox(stageBox(process, layout, hung).box, 0, 9), { measure: hung }))
      .toEqual({ anchor: { kind: "below-table", table: "quantities" }, box: { x: 24, y: 13.5, w: 180, h: 12 }, repeat: false });
    expect(movedItem(layout, process, 0, 9, { measure: hung })).toEqual({ ...process, box: { x: 24, y: 13.5, w: 180, h: 12 } });
    // A page-bottom item measured 30 tall on page 1: moved within the band, clamped by its model height.
    const band = withBand();
    const sign = itemOf(band, "sign");
    const low = tallerMeasure(band, { sign: { height: 30, page: 1 } });
    expect(dropBox(band, sign, moveBox(stageBox(sign, band, low).box, 0, 9), { measure: low }))
      .toEqual({ anchor: { kind: "page-bottom" }, box: { x: 24, y: 709, w: 180, h: 12 }, repeat: false });
    expect(dropBox(band, sign, { x: 24, y: 760, w: 180, h: 30 }, { measure: low }))
      .toEqual({ anchor: { kind: "page-bottom" }, box: { x: 24, y: 756, w: 180, h: 12 }, repeat: false });
    expect(movedItem(band, sign, 0, 9, { measure: low })).toEqual({ ...sign, box: { x: 24, y: 709, w: 180, h: 12 } });
  });
});

describe("a resize's start (Ruling 2 of Task 2's review; Ruling 7)", () => {
  // The page-top field of the measured-height cases: 180 × 12 at (400, 99), above every table.
  const withParty = () => layoutOf([...standardLayout().items, field("party", { box: { x: 400, y: 99, w: 180, h: 12 } })]);
  const HANDLES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;

  it("starts from the height the stage draws: the measured one where taller, the stored one otherwise", () => {
    const layout = withParty();
    const party = itemOf(layout, "field-party");
    expect(resizeStart(party, layout, tallerMeasure(layout, { "field-party": { height: 30 } }), "s"))
      .toEqual({ ...party, box: { x: 400, y: 99, w: 180, h: 30 } });
    expect(resizeStart(party, layout, tallerMeasure(layout, { "field-party": { height: 9 } }), "s")).toEqual(party);
    expect(resizeStart(party, layout, null, "s")).toEqual(party);
  });
  it("takes the stage height only for a handle with a north or south side: east and west keep the stored height (Ruling 7)", () => {
    const layout = withParty();
    const party = itemOf(layout, "field-party");
    const measure = tallerMeasure(layout, { "field-party": { height: 30 } });
    for (const handle of ["n", "s", "ne", "nw", "se", "sw"] as const) {
      expect(resizeStart(party, layout, measure, handle).box.h).toBe(30);
    }
    expect(resizeStart(party, layout, measure, "e")).toEqual(party);
    expect(resizeStart(party, layout, measure, "w")).toEqual(party);
    expect(resizeStart(party, layout, measure, "e").box.h).toBe(12);
    expect(resizeStart(party, layout, measure, "ne").box.h).toBe(30);
  });
  it("keeps a below-table item's stored offset y, and leaves a table and a line as they are stored for every handle", () => {
    const layout = withParty();
    const process = itemOf(layout, "field-process");
    expect(resizeStart(process, layout, tallerMeasure(layout, { "field-process": { height: 20 } }), "s"))
      .toEqual({ ...process, box: { ...process.box, h: 20 } });
    expect(process.box.y).toBe(4.5);
    const steps = itemOf(layout, "table-steps");
    const measure = measureOf(layout, 0);
    measure.tables = measure.tables.map((t) => (t.key === "steps" ? { ...t, height: 300 } : t));
    expect(stageBox(steps, layout, measure).box.h).toBe(300);
    // A line measured with a height keeps its zero side, which a resize must never draw.
    const lined = layoutOf([...layout.items, line("rule", { x: 24, y: 100, w: 200, h: 0 })]);
    const rule = itemOf(lined, "rule");
    expect(stageBox(rule, lined, tallerMeasure(lined, { rule: { height: 1.5 } })).box.h).toBe(1.5);
    for (const handle of HANDLES) {
      expect(resizeStart(steps, layout, measure, handle)).toEqual(steps);
      expect(resizeStart(rule, lined, tallerMeasure(lined, { rule: { height: 1.5 } }), handle)).toEqual(rule);
    }
  });
  it("a bottom handle dragged 9 down on an item measured 30 tall in a 12 pt box commits 39, as the stage commits it", () => {
    const layout = withParty();
    const party = itemOf(layout, "field-party");
    const measure = tallerMeasure(layout, { "field-party": { height: 30 } });
    expect(resizeBox(resizeStart(party, layout, measure, "s"), "s", 0, 9, TRAVELER_CONTRACT))
      .toEqual({ x: 400, y: 99, w: 180, h: 39 });
  });
});

describe("a resize's one commit and its drawn box (Ruling 9)", () => {
  const withParty = () => layoutOf([...standardLayout().items, field("party", { box: { x: 400, y: 99, w: 180, h: 12 } })]);

  it("resizedItem commits the stage's start resized: 39 from a bottom handle, the stored 12 from a side one", () => {
    const layout = withParty();
    const party = itemOf(layout, "field-party");
    const measure = tallerMeasure(layout, { "field-party": { height: 30 } });
    expect(resizedItem(party, layout, measure, "s", 0, 9, TRAVELER_CONTRACT))
      .toEqual({ ...party, box: { x: 400, y: 99, w: 180, h: 39 } });
    // A width-only resize keeps the stored height (Ruling 7): never the measured 30. The east edge
    // stands at 580, so 9 right stops at the page's right margin (588); the west handle grows it by 9.
    expect(resizedItem(party, layout, measure, "e", 9, 0, TRAVELER_CONTRACT))
      .toEqual({ ...party, box: { x: 400, y: 99, w: 188, h: 12 } });
    expect(resizedItem(party, layout, measure, "w", -9, 0, TRAVELER_CONTRACT))
      .toEqual({ ...party, box: { x: 391, y: 99, w: 189, h: 12 } });
  });
  it("resizedItem commits nothing for a handle clicked without moving", () => {
    const layout = withParty();
    const party = itemOf(layout, "field-party");
    const measure = tallerMeasure(layout, { "field-party": { height: 30 } });
    expect(resizedItem(party, layout, measure, "s", 0, 0, TRAVELER_CONTRACT)).toBeNull();
    expect(resizedItem(party, layout, measure, "e", 1, 0, TRAVELER_CONTRACT)).toBeNull();
    expect(resizedItem(party, layout, null, "se", 0, 0, TRAVELER_CONTRACT)).toBeNull();
  });
  it("resizedBox is the box the stage draws during the drag: the drag start with the handle's edges moved", () => {
    const layout = withParty();
    const party = itemOf(layout, "field-party");
    const measure = tallerMeasure(layout, { "field-party": { height: 30 } });
    expect(resizedBox(party, layout, measure, "s", 0, 9, TRAVELER_CONTRACT)).toEqual({ x: 400, y: 99, w: 180, h: 39 });
    // A side handle widens the drawn box and keeps the measured height the stage draws.
    expect(resizedBox(party, layout, measure, "w", -9, 0, TRAVELER_CONTRACT)).toEqual({ x: 391, y: 99, w: 189, h: 30 });
    // A below-table item is drawn at its region's top plus its offset, the resize moving its edges there.
    const process = itemOf(layout, "field-process");
    const hung = tallerMeasure(layout, { "field-process": { height: 20 } });
    expect(resizedBox(process, layout, hung, "s", 0, 9, TRAVELER_CONTRACT))
      .toEqual({ ...stageBox(process, layout, hung).box, h: 29 });
    expect(resizedItem(process, layout, hung, "s", 0, 9, TRAVELER_CONTRACT)).toEqual({ ...process, box: { ...process.box, h: 29 } });
  });
  it("a table's resize keeps its row floor", () => {
    const lines = table("lines");
    const layout = layoutOf(standardLayout().items.map((i) => (i.id === lines.id ? lines : i)));
    expect(resizedItem(lines, layout, null, "s", 0, -100, TRAVELER_CONTRACT))
      .toEqual({ ...lines, box: { x: 24, y: 140, w: 564, h: TRAVELER_CANVAS.rowFloor } });
    const ticketLines = ticketTable("lines");
    const ticket = standardTicketLayout();
    expect(resizedItem(ticketLines, ticket, null, "s", 0, -100, SHIPPER_CONTRACT)?.box.h).toBe(TICKET_ROW_FLOOR);
  });
});

describe("a move's clamp by the stored height (Ruling 8)", () => {
  it("moveBox clamps the vertical move by the height it is handed, the box's own by default", () => {
    expect(moveBox({ x: 24, y: 750, w: 80, h: 30 }, 4.5, 0)).toEqual({ x: 28.5, y: 738, w: 80, h: 30 });
    expect(moveBox({ x: 24, y: 750, w: 80, h: 30 }, 4.5, 0, 12)).toEqual({ x: 28.5, y: 750, w: 80, h: 30 });
  });
  it("a table still clamps by the height the stage draws it at, which stageBox caps at the page's foot", () => {
    const lines = table("lines");
    const layout = layoutOf(standardLayout().items.map((i) => (i.id === lines.id ? lines : i)));
    const measure = measureOf(layout, 0);
    measure.tables = measure.tables.map((t) => (t.key === "lines" ? { ...t, height: 300 } : t));
    expect(stageBox(lines, layout, measure).box).toMatchObject({ y: 140, h: 300 });
    // Dragged far down, the drawn 300 stops at the foot (768 − 300): the stored 40 would let it reach 728.
    expect(movedItem(layout, lines, 0, 1000, { measure })?.box).toEqual({ x: 24, y: 468, w: 564, h: 40 });
  });
  it("a sideways nudge of an item whose measured extent passes the page's foot moves sideways only", () => {
    // Alone on the page, so the drop keeps it page-top (no table bottom above it to hang below).
    const layout = layoutOf([text("foot", { x: 300, y: 750, w: 100, h: 12 })]);
    const foot = itemOf(layout, "foot");
    const measure = tallerMeasure(layout, { foot: { height: 30 } });
    expect(stageBox(foot, layout, measure).box).toEqual({ x: 300, y: 750, w: 100, h: 30 });
    expect(movedItem(layout, foot, 4.5, 0, { measure })).toEqual({ ...foot, box: { x: 304.5, y: 750, w: 100, h: 12 } });
  });
});

describe("the boxed fields", () => {
  it("drawsBorder: the tickets' Sold To and Ship To fields, and nothing else", () => {
    for (const contract of [SHIPPER_CONTRACT, MOS_SHIPPER_CONTRACT]) {
      expect(drawsBorder(field("sold_to"), contract)).toBe(true);
      expect(drawsBorder(field("ship_to"), contract)).toBe(true);
      expect(drawsBorder(field("company_name"), contract)).toBe(false);
      expect(drawsBorder(ticketTable("lines"), contract)).toBe(false);
      const wording: CanvasItem = { id: "w", kind: "textBlock", key: "shipper_liability_text", box: { x: 24, y: 700, w: 564, h: 24 },
        anchor: { kind: "page-top" }, repeat: false, style: { size: 5.5, bold: false, align: "left" } };
      expect(drawsBorder(wording, contract)).toBe(false);
    }
    for (const f of TRAVELER_CONTRACT.sections.flatMap((section) => section.fields)) {
      expect(drawsBorder(field(f.key), TRAVELER_CONTRACT)).toBe(false);
    }
    expect(drawsBorder(table("lines"), TRAVELER_CONTRACT)).toBe(false);
    // A contract with no profile draws no border.
    expect(drawsBorder(field("sold_to"), testContract())).toBe(false);
    // A table item keyed like a boxed field is no field: only a field draws the border.
    expect(drawsBorder({ ...ticketTable("lines"), key: "sold_to" } as CanvasItem, SHIPPER_CONTRACT)).toBe(false);
  });
});

describe("the ruled fields, the list blocks and what a block keeps beside its strip (design 2026-11-09 §4.1)", () => {
  it("ruleOf: a field the profile draws on a rule, as its paper prints it, and nothing else", () => {
    expect(ruleOf(bolField("pro_number"), BOL_CONTRACT)).toEqual({ key: "pro_number", draw: "beside" });
    expect(ruleOf(bolField("carrier_name"), BOL_CONTRACT)).toEqual({ key: "carrier_name", draw: "beside" });
    expect(ruleOf(bolField("consigned_to"), BOL_CONTRACT)?.draw).toBe("lines");
    // A field the profile does not name prints bare.
    expect(ruleOf(bolField("title"), BOL_CONTRACT)).toBeNull();
    expect(ruleOf(bolField("ship_from"), BOL_CONTRACT)).toBeNull();
    expect(ruleOf(bolTable("consignee_ref"), BOL_CONTRACT)).toBeNull();
    // A table item keyed like a ruled field is no field: only a field draws on a rule.
    expect(ruleOf({ ...bolTable("trv"), key: "pro_number" } as CanvasItem, BOL_CONTRACT)).toBeNull();
    for (const f of TRAVELER_CONTRACT.sections.flatMap((section) => section.fields)) {
      expect(ruleOf(field(f.key), TRAVELER_CONTRACT)).toBeNull();
    }
    for (const contract of [SHIPPER_CONTRACT, MOS_SHIPPER_CONTRACT]) {
      for (const f of contract.sections.flatMap((section) => section.fields)) expect(ruleOf(field(f.key), contract)).toBeNull();
    }
    // A contract with no profile draws no rule.
    expect(ruleOf(field("pro_number"), testContract())).toBeNull();
  });
  it("besideOf: the points a column table's block keeps beside its columns, else 0", () => {
    expect(besideOf(BOL_CONTRACT, "freight")).toBe(178);
    expect(besideOf(BOL_CONTRACT, "freight")).toBe(CONTENT_WIDTH - BOL_CONTRACT.tableBudgets!.freight);
    expect(besideOf(SHIPPER_CONTRACT, "containers")).toBe(0);
    expect(besideOf(TRAVELER_CONTRACT, "steps")).toBe(0);
    expect(besideOf(BOL_CONTRACT, "trv")).toBe(0);
    expect(besideOf(BOL_CONTRACT, "nope")).toBe(0);
    expect(besideOf(testContract(), "freight")).toBe(0);
  });
  it("isListBlock: a block with no rows and no columns, on a profile that places it", () => {
    expect(isListBlock(BOL_CONTRACT, "consignee_ref")).toBe(true);
    expect(isListBlock(BOL_CONTRACT, "trv")).toBe(true);
    expect(isListBlock(SHIPPER_CONTRACT, "serials")).toBe(true);
    expect(isListBlock(MOS_SHIPPER_CONTRACT, "serials")).toBe(true);
    expect(isListBlock(BOL_CONTRACT, "freight")).toBe(false);
    expect(isListBlock(SHIPPER_CONTRACT, "totals")).toBe(false);
    for (const spec of TRAVELER_CANVAS.tables) expect(isListBlock(TRAVELER_CONTRACT, spec.key)).toBe(false);
    // A table no profile places is no list block.
    expect(isListBlock(BOL_CONTRACT, "nope")).toBe(false);
    expect(isListBlock(testContract(), "serials")).toBe(false);
  });
});

describe("the designer's words", () => {
  it("states every sentence the panel shows", () => {
    expect(DESIGNER_WORDS.designOnCanvas).toBe("Design on a canvas");
    expect(DESIGNER_WORDS.backToSections).toBe("Back to sections");
    expect(DESIGNER_WORDS.clearPage).toBe("Clear the page");
    // The traveler's sentences, byte for byte as they read before the words took the document.
    expect(DESIGNER_WORDS.pickRecordFirst("TRAVELER")).toBe("Pick an order in Preview first");
    expect(DESIGNER_WORDS.cannotRemove(TRAVELER_CONTRACT))
      .toBe("The barcode and the Process steps table are on every traveler; they can be moved, not removed.");
    expect(DESIGNER_WORDS.notAFigure).toBe("Enter inches as a number, such as 1.25.");
    expect(DESIGNER_WORDS.printsOnPage(2, "TRAVELER")).toBe("Prints on page 2 for this order");
    expect(DESIGNER_WORDS.designConfirm("TRAVELER", 1004)).toBe(
      "The sections layout stops printing for this template. The canvas starts from today's paper for order #1004 " +
      "and its first load; Save keeps it, Discard undoes it.");
    expect(DESIGNER_WORDS.backToSectionsConfirm).toContain("sections layout prints again");
    expect(DESIGNER_WORDS.clearPageConfirm(TRAVELER_CONTRACT)).toBe(
      "Every item but the barcode and the Process steps table is removed from the canvas; Save keeps it, Discard undoes it.");
    expect(DESIGNER_WORDS.anchorBelow("Part lines")).toBe("Below Part lines");
    expect(DESIGNER_WORDS.notPoints).toContain("greater than zero");
  });
  it("names the shipping ticket's record, and says nothing is required on it", () => {
    expect(DESIGNER_WORDS.pickRecordFirst("SHIPPER")).toBe("Pick a single-order shipment in Preview first");
    expect(DESIGNER_WORDS.pickRecordFirst("MOS_SHIPPER")).toBe("Pick a multi-order shipment in Preview first");
    expect(DESIGNER_WORDS.pickRecordFirst("QUOTE")).toBe("Pick a quote in Preview first");
    expect(DESIGNER_WORDS.designConfirm("MOS_SHIPPER", 12)).toBe(
      "The sections layout stops printing for this template. The canvas starts from today's paper for shipment #12's " +
      "first ticket; Save keeps it, Discard undoes it.");
    expect(DESIGNER_WORDS.designConfirm("SHIPPER", 12)).toContain("for shipment #12's first ticket;");
    expect(DESIGNER_WORDS.cannotRemove(SHIPPER_CONTRACT)).toBeNull();
    expect(DESIGNER_WORDS.cannotRemove(MOS_SHIPPER_CONTRACT)).toBeNull();
    expect(DESIGNER_WORDS.clearPageConfirm(SHIPPER_CONTRACT))
      .toBe("Every item is removed from the canvas; Save keeps it, Discard undoes it.");
    expect(DESIGNER_WORDS.printsOnPage(2, "SHIPPER")).toBe("Prints on page 2 for this shipment");
    expect(DESIGNER_WORDS.printsOnPage(3, "MOS_SHIPPER")).toBe("Prints on page 3 for this shipment");
    expect(Object.keys(CANVAS_RECORD_WORDS)).toEqual(["TRAVELER", "SHIPPER", "MOS_SHIPPER", "BOL", "CERT", "INVOICE", "STATEMENT", "QUOTE", "CONTAINER_TAG"]);
  });
  it("names the bill of lading's record, and says nothing is required on it", () => {
    expect(DESIGNER_WORDS.pickRecordFirst("BOL")).toBe("Pick a shipment in Preview first");
    expect(DESIGNER_WORDS.designConfirm("BOL", 1031)).toBe(
      "The sections layout stops printing for this template. The canvas starts from today's paper for shipment #1031's " +
      "bill of lading; Save keeps it, Discard undoes it.");
    expect(DESIGNER_WORDS.printsOnPage(2, "BOL")).toBe("Prints on page 2 for this shipment");
    expect(DESIGNER_WORDS.cannotRemove(BOL_CONTRACT)).toBeNull();
    expect(DESIGNER_WORDS.clearPageConfirm(BOL_CONTRACT))
      .toBe("Every item is removed from the canvas; Save keeps it, Discard undoes it.");
  });
  it("names the certification by its printed label, and says nothing is required on it", () => {
    expect(DESIGNER_WORDS.pickRecordFirst("CERT")).toBe("Pick a certification in Preview first");
    expect(DESIGNER_WORDS.designConfirm("CERT", "92036-3")).toBe(
      "The sections layout stops printing for this template. The canvas starts from today's paper for certification " +
      "92036-3; Save keeps it, Discard undoes it.");
    expect(DESIGNER_WORDS.designConfirm("CERT", "92036, load 2"))
      .toMatch(/for certification 92036, load 2; Save keeps it, Discard undoes it\.$/);
    expect(DESIGNER_WORDS.printsOnPage(2, "CERT")).toBe("Prints on page 2 for this certification");
    expect(DESIGNER_WORDS.cannotRemove(CERT_CONTRACT)).toBeNull();
    expect(DESIGNER_WORDS.clearPageConfirm(CERT_CONTRACT))
      .toBe("Every item is removed from the canvas; Save keeps it, Discard undoes it.");
  });
  it("names the invoice or credit by its kind and number, and says nothing is required on it", () => {
    expect(DESIGNER_WORDS.pickRecordFirst("INVOICE")).toBe("Pick an invoice or credit in Preview first");
    expect(DESIGNER_WORDS.designConfirm("INVOICE", "invoice 7 - 92026")).toBe(
      "The sections layout stops printing for this template. The canvas starts from today's paper for invoice " +
      "7 - 92026; Save keeps it, Discard undoes it.");
    expect(DESIGNER_WORDS.designConfirm("INVOICE", "credit 512"))
      .toMatch(/for credit 512; Save keeps it, Discard undoes it\.$/);
    expect(DESIGNER_WORDS.printsOnPage(2, "INVOICE")).toBe("Prints on page 2 for this invoice or credit");
    expect(DESIGNER_WORDS.cannotRemove(INVOICE_CONTRACT)).toBeNull();
    expect(DESIGNER_WORDS.clearPageConfirm(INVOICE_CONTRACT))
      .toBe("Every item is removed from the canvas; Save keeps it, Discard undoes it.");
  });
  it("names the statement's customer by its code, and says nothing is required on it", () => {
    expect(DESIGNER_WORDS.pickRecordFirst("STATEMENT")).toBe("Pick a customer in Preview first");
    expect(DESIGNER_WORDS.designConfirm("STATEMENT", "ACME")).toBe(
      "The sections layout stops printing for this template. The canvas starts from today's paper for customer ACME; " +
      "Save keeps it, Discard undoes it.");
    expect(DESIGNER_WORDS.printsOnPage(2, "STATEMENT")).toBe("Prints on page 2 for this customer");
    expect(DESIGNER_WORDS.cannotRemove(STATEMENT_CONTRACT)).toBeNull();
  });
  it("names the quote's record by its number, and says nothing is required on it", () => {
    expect(DESIGNER_WORDS.designConfirm("QUOTE", 1042)).toBe(
      "The sections layout stops printing for this template. The canvas starts from today's paper for quote #1042; " +
      "Save keeps it, Discard undoes it.");
    expect(DESIGNER_WORDS.printsOnPage(2, "QUOTE")).toBe("Prints on page 2 for this quote");
    expect(DESIGNER_WORDS.cannotRemove(QUOTE_CONTRACT)).toBeNull();
  });
  it("names one required item in the singular", () => {
    const oneRequired = { ...TRAVELER_CONTRACT, canvas: { ...TRAVELER_CONTRACT.canvas!, required: [{ kind: "barcode" as const, reason: "" }] } };
    expect(DESIGNER_WORDS.cannotRemove(oneRequired)).toBe("The barcode is on every traveler; it can be moved, not removed.");
    expect(DESIGNER_WORDS.clearPageConfirm(oneRequired))
      .toBe("Every item but the barcode is removed from the canvas; Save keeps it, Discard undoes it.");
  });
});

describe("the shipping ticket's palette and placing", () => {
  const entry = (kind: CanvasItem["kind"], key?: string): PaletteEntry => ({ kind, key, label: "", group: "", state: "available" });

  it("groups the ticket's fields by section, then its tables, its wording and the page items, with no barcode", () => {
    const entries = paletteEntries(standardTicketLayout(), SHIPPER_CONTRACT);
    expect([...new Set(entries.map((e) => e.group))])
      .toEqual(["Header", "Sold to / Ship to", "Tear-off strip", "Tables", "Wording", "Page items"]);
    const tables = entries.filter((e) => e.kind === "table");
    expect(tables.map((e) => e.key)).toEqual(["field_strip", "lines", "containers", "serials", "totals"]);
    expect(tables.every((e) => e.state !== "required")).toBe(true);
    expect(entries.filter((e) => e.kind === "textBlock")).toEqual([
      { kind: "textBlock", key: "shipper_liability_text", label: "Liability text wording", group: "Wording", state: "placed" },
    ]);
    expect(entries.some((e) => e.kind === "barcode")).toBe(false);
    expect(entries.find((e) => e.kind === "logo")).toMatchObject({ state: "available" });
    expect(entries.map((e) => e.kind).slice(-5)).toEqual(["textBlock", "logo", "text", "line", "box"]);
    const cleared = paletteEntries(clearedLayout(SHIPPER_CONTRACT), SHIPPER_CONTRACT);
    expect(cleared.find((e) => e.kind === "textBlock")?.state).toBe("available");
    expect(cleared.filter((e) => e.kind === "table").every((e) => e.state === "available")).toBe(true);
  });
  it("places the liability text the content width wide, 24 pt tall, at the template's small size", () => {
    const empty: CanvasLayout = { version: 1, items: [] };
    const placed = placeNew(empty, SHIPPER_CONTRACT, entry("textBlock", "shipper_liability_text"));
    // The field's free-row search: the first grid row at or below the 24 pt top margin is 27
    // (ceil(24 / 4.5) × 4.5; 24 is not on the grid), as a field on an empty page takes.
    expect(placed).toMatchObject({ kind: "textBlock", key: "shipper_liability_text", repeat: false, anchor: { kind: "page-top" },
      box: { x: 24, y: 27, w: 564, h: 24 }, style: { size: 5.5, bold: false, align: "left" } });
    // The strict schema refuses a stray key on the placed item.
    expect(() => canvasLayoutSchema.parse(layoutOf([placed]))).not.toThrow();
    expect(placeNew(empty, SHIPPER_CONTRACT, entry("field", "company_name")).box).toMatchObject({ x: 24, y: 27 });
    expect(itemTitle(placed, SHIPPER_CONTRACT)).toBe("Liability text wording");
    expect(itemTitle({ ...placed, key: "nonsense" } as CanvasItem, SHIPPER_CONTRACT)).toBe('Wording "nonsense"');
  });
  it("clears to an empty canvas the rules accept, and requires no table", () => {
    const cleared = clearedLayout(SHIPPER_CONTRACT);
    expect(cleared).toEqual({ version: 1, items: [] });
    expect(() => validateCanvasLayout(cleared, SHIPPER_CONTRACT)).not.toThrow();
    for (const key of ["field_strip", "lines", "containers", "serials", "totals"]) {
      expect(isRequired({ kind: "table", key }, SHIPPER_CONTRACT)).toBe(false);
    }
    expect(isRequired({ kind: "barcode" }, SHIPPER_CONTRACT)).toBe(false);
  });
  it("keeps a ticket table one ticket row tall", () => {
    const lines = ticketTable("lines");
    expect(resizeBox(lines, "s", 0, -100, SHIPPER_CONTRACT)).toMatchObject({ y: 172, h: TICKET_ROW_FLOOR });
    expect(resizeBox(lines, "n", 0, 100, SHIPPER_CONTRACT)).toMatchObject({ y: 172 + 30 - TICKET_ROW_FLOOR, h: TICKET_ROW_FLOOR });
  });
});

describe("the bill of lading's palette", () => {
  it("names the consignee's ref/PO block by its field, the TRV and freight blocks by their sections", () => {
    const tables = paletteEntries(standardBolLayout(), BOL_CONTRACT).filter((e) => e.kind === "table");
    expect(tables).toMatchObject([
      { key: "consignee_ref", label: "Consignee's ref/PO table" },
      { key: "trv", label: "TRV numbers table" },
      { key: "freight", label: "Freight table" },
    ]);
    expect(tables.every((e) => e.state === "placed")).toBe(true);
  });
  it("groups the fields by the sections that place one, then the tables, the wording and the page items, with no barcode", () => {
    const entries = paletteEntries(standardBolLayout(), BOL_CONTRACT);
    const placeable = canvasFieldKeys(BOL_CONTRACT);
    const fieldGroups = BOL_CONTRACT.sections.filter((s) => s.fields.some((f) => placeable.has(f.key))).map((s) => s.name);
    const groups = [...new Set(entries.map((e) => e.group))];
    expect(groups).toEqual([...fieldGroups, "Tables", "Wording", "Page items"]);
    expect(groups).not.toContain("TRV numbers");
    expect(groups).not.toContain("Freight");
    expect(entries.some((e) => e.kind === "barcode")).toBe(false);
  });
  it("offers in Wording only the wordings no block prints itself, in contract order, the placed ones marked", () => {
    const placed = new Set(standardBolLayout().items.flatMap((i) => (i.kind === "textBlock" ? [i.key] : [])));
    expect([...placed].sort()).toEqual(["bol_property_text", "bol_received_text", "bol_water_note"]);
    const wording = paletteEntries(standardBolLayout(), BOL_CONTRACT).filter((e) => e.group === "Wording");
    expect(wording.map((e) => e.key)).toEqual([
      "bol_received_text", "bol_property_text", "bol_certifies_text", "bol_water_note", "bol_value_note",
      "bol_declared_value_text", "bol_liability_note", "bol_fibre_note",
    ]);
    expect(wording.every((e) => e.kind === "textBlock")).toBe(true);
    for (const entry of wording) expect(entry.state).toBe(placed.has(entry.key!) ? "placed" : "available");
  });
  it("offers an anchor below the consignee's ref/PO block by its field's name", () => {
    expect(DESIGNER_WORDS.anchorBelow(itemTitle(bolTable("consignee_ref"), BOL_CONTRACT))).toBe("Below Consignee's ref/PO table");
  });
  it("places a new freight block with its five columns and then its shown toggle, and the block passes every rule", () => {
    const freightEntry = paletteEntries(layoutOf([]), BOL_CONTRACT).find((e) => e.kind === "table" && e.key === "freight")!;
    const placed = placeNew(layoutOf([]), BOL_CONTRACT, freightEntry);
    if (placed.kind !== "table") return expect.fail("a table entry placed a table");
    expect(placed.columns.at(-1)).toEqual({ key: "collect_checkbox", visible: true, label: null, width: null });
    expect(placed.columns.map((c) => c.key)).toEqual([
      "package_count", "freight_description", "freight_weight", "freight_class", "check_column", "collect_checkbox",
    ]);
    expect(() => validateCanvasLayout(layoutOf([placed]), BOL_CONTRACT)).not.toThrow();
  });
});

describe("an item's least width in the designer (design 2026-11-09 §4.1 additions 2 and 5)", () => {
  const entry = (kind: CanvasItem["kind"], key?: string): PaletteEntry => ({ kind, key, label: "", group: "", state: "available" });
  const freightDescribedAt = (width: number) => defaultTableColumns(BOL_CONTRACT, "freight")
    .map((c) => (c.key === "freight_description" ? { ...c, width } : c));
  /** `layout` with the item of this id given `box`. */
  const withBox = (layout: CanvasLayout, id: string, box: CanvasBox): CanvasLayout =>
    layoutOf(layout.items.map((i) => (i.id === id ? ({ ...i, box } as CanvasItem) : i)));

  it("a field stops at its least width, an item with no entry at one grid step", () => {
    expect(resizeBox(bolField("pro_number", { box: { x: 338, y: 24, w: 244, h: 10 } }), "e", -500, 0, BOL_CONTRACT).w).toBe(118.5);
    expect(BOL_LEAST_WIDTHS.pro_number).toBe(118.5);
    // The carrier's label column and gap and one grid step (owner ruling R1, 2026-11-24).
    expect(resizeBox(bolField("carrier_name", { box: { x: 24, y: 4, w: 300, h: 12 } }), "e", -500, 0, BOL_CONTRACT).w)
      .toBe(78.5);
  });
  it("a field narrower than its floor, floored by a resize, stays inside the side margins", () => {
    expect(BOL_LEAST_WIDTHS.consigned_to).toBe(262.5);
    // East: the floored right side would pass the right margin (588), so the left side moves instead.
    expect(resizeBox(bolField("consigned_to", { box: { x: 408, y: 40, w: 180, h: 12 } }), "e", 9, 0, BOL_CONTRACT))
      .toEqual({ x: 588 - 262.5, y: 40, w: 262.5, h: 12 });
    // West: the floored left side would pass the left margin (24), so the right side moves instead.
    expect(resizeBox(bolField("consigned_to", { box: { x: 24, y: 40, w: 180, h: 12 } }), "w", -9, 0, BOL_CONTRACT))
      .toEqual({ x: 24, y: 40, w: 262.5, h: 12 });
  });
  it("the freight block stops at its columns and its sidebar, the width rule 9 accepts", () => {
    const freight = bolTable("freight");
    const { x, y } = freight.box;
    // The sidebar and its gap, read from the flow's budget (not from the profile), and the columns
    // with their padding and rules and one grid step (#971): the least width rule 9 judges, 415.3 on
    // the fixture's columns.
    const sidebar = CONTENT_WIDTH - BOL_CONTRACT.tableBudgets!.freight;
    const columns = visibleColumnsWidth(BOL_CONTRACT, freight);
    const floor = resizeBox(freight, "e", -500, 0, BOL_CONTRACT);
    expect(floor).toEqual({ x, y, w: round2(columns + tableOverhead("boxed", 5) + sidebar + CANVAS_GRID), h: BOL_ROW_FLOOR });
    expect(floor.w).toBe(415.3);
    expect(() => validateCanvasLayout(withBox(standardBolLayout(), freight.id, floor), BOL_CONTRACT)).not.toThrow();
    expect(() => validateCanvasLayout(withBox(standardBolLayout(), freight.id, { ...floor, w: floor.w - CANVAS_GRID }), BOL_CONTRACT))
      .toThrow(`the ${sidebar} pt it keeps beside them and one grid step, more than its ${round2(floor.w - CANVAS_GRID)} pt`);
    // With the description drawn 148.7 wide, the block's least width is the whole content width.
    const wide = bolTable("freight", { columns: freightDescribedAt(148.7) });
    expect(resizeBox(wide, "e", -500, 0, BOL_CONTRACT)).toEqual({ x, y, w: CONTENT_WIDTH, h: BOL_ROW_FLOOR });
  });
  it("the ticket's folded containers table stops at both copies' columns (§13 call 6)", () => {
    const containers = ticketTable("containers");
    // Both copies' columns and their padding and rules, and one grid step (#971).
    const both = round2(2 * (visibleColumnsWidth(SHIPPER_CONTRACT, containers) + tableOverhead("ruled", 4)) + CANVAS_GRID);
    expect(both).toBe(352.5);
    expect(both).toBeLessThan(containers.box.w);
    const floor = resizeBox(containers, "e", -500, 0, SHIPPER_CONTRACT);
    expect(floor.w).toBe(both);
    expect(() => validateCanvasLayout(withBox(standardTicketLayout(), containers.id, floor), SHIPPER_CONTRACT)).not.toThrow();
    expect(() => validateCanvasLayout(withBox(standardTicketLayout(), containers.id, { ...floor, w: floor.w - CANVAS_GRID }), SHIPPER_CONTRACT))
      .toThrow("printed twice, and one grid step");
  });
  it.each(["consignee_ref", "trv", "freight"])("a new %s block from the palette on an empty page passes every rule", (key) => {
    const tableEntry = paletteEntries(layoutOf([]), BOL_CONTRACT).find((e) => e.kind === "table" && e.key === key)!;
    const placed = placeNew(layoutOf([]), BOL_CONTRACT, tableEntry);
    expect(placed.box).toEqual({ x: 24, y: 140, w: 564, h: BOL_ROW_FLOOR });
    expect(placed.box.w).toBeGreaterThanOrEqual(leastWidth(BOL_CONTRACT, placed));
    // The new block leaves its heading and one row above the band (rule 8's room), so the rules below pass.
    expect(placed.box.y + BOL_FIRST_TABLE_ROOM).toBeLessThan(bandTop(layoutOf([placed])));
    expect(() => validateCanvasLayout(layoutOf([placed]), BOL_CONTRACT)).not.toThrow();
  });
  it.each([...canvasFieldKeys(BOL_CONTRACT)])("a new %s field takes the larger of 180 and its least width", (key) => {
    const fieldEntry = paletteEntries(layoutOf([]), BOL_CONTRACT).find((e) => e.kind === "field" && e.key === key)!;
    const placed = placeNew(layoutOf([]), BOL_CONTRACT, fieldEntry);
    expect(placed.box.w).toBe(Math.max(180, BOL_LEAST_WIDTHS[key] ?? 0));
    expect(() => validateCanvasLayout(layoutOf([placed]), BOL_CONTRACT)).not.toThrow();
  });
  it("a new ship-from, consigned-to and pro number field: 180 (the sentence has no fixed part, R2), 262.5 and 180", () => {
    const width = (key: string) => placeNew(layoutOf([]), BOL_CONTRACT, entry("field", key)).box.w;
    expect([width("ship_from"), width("consigned_to"), width("pro_number")]).toEqual([180, 262.5, 180]);
  });
});

describe("the certification's palette, placing and resize floors (design 2026-11-10 §8)", () => {
  const CERT_TABLES = ["to", "parts", "statement", "requirements", "serials", "freeform", "signature"] as const;
  const CERT_FIELDS = [
    "company_name", "title", "order_no", "print_date", "entry_date",
    "po_number", "packing_list_no", "material", "footer_address", "footer_phone",
  ];

  it("pin: the fields are the ten placeable ones, grouped by section in contract order, then the seven blocks, all placed, no barcode", () => {
    const entries = paletteEntries(standardCertLayout(), CERT_CONTRACT);
    const placeable = canvasFieldKeys(CERT_CONTRACT);
    expect([...placeable].sort()).toEqual([...CERT_FIELDS].sort());
    const fieldEntries = entries.filter((e) => e.kind === "field");
    expect(fieldEntries.map((e) => e.key)).toEqual(CERT_FIELDS);
    // Each field's group is its own section's name, read from the contract.
    const sectionOf = (key: string) => CERT_CONTRACT.sections.find((s) => s.fields.some((f) => f.key === key))!.name;
    for (const e of fieldEntries) expect(e.group).toBe(sectionOf(e.key!));
    expect([...new Set(fieldEntries.map((e) => e.group))]).toEqual(["Header", "To / order fields", "Page footer strip"]);
    expect(fieldEntries.every((e) => e.state === "placed")).toBe(true);
    const tables = entries.filter((e) => e.kind === "table");
    expect(tables).toMatchObject([
      { key: "to", label: "To box table" },
      { key: "parts", label: "Part lines table" },
      { key: "statement", label: "Certification statement table" },
      { key: "requirements", label: "Requirements and readings table" },
      { key: "serials", label: "Serial numbers table" },
      { key: "freeform", label: "Freeform text table" },
      { key: "signature", label: "Signature block table" },
    ]);
    expect(tables.every((e) => e.state === "placed")).toBe(true);
    expect(entries.some((e) => e.kind === "barcode")).toBe(false);
    expect(entries.find((e) => e.kind === "logo")).toMatchObject({ state: "available", group: "Page items" });
    expect(entries.map((e) => e.kind).slice(-4)).toEqual(["logo", "text", "line", "box"]);
  });
  it("offers no Wording: the certification's one wording is its statement block's", () => {
    expect(CERT_CONTRACT.textBlocks.map((b) => b.key)).toEqual(["cert_statement"]);
    const entries = paletteEntries(standardCertLayout(), CERT_CONTRACT);
    expect(entries.some((e) => e.group === "Wording")).toBe(false);
    expect(entries.some((e) => e.kind === "textBlock")).toBe(false);
    // Pin: an empty canvas offers none either.
    expect(paletteEntries(layoutOf([]), CERT_CONTRACT).some((e) => e.kind === "textBlock")).toBe(false);
  });
  it("pin: offers an anchor below the To block by its field's name", () => {
    expect(DESIGNER_WORDS.anchorBelow(itemTitle(certTable("to"), CERT_CONTRACT))).toBe("Below To box table");
  });
  it("the signature block stops at its least width (call 12)", () => {
    const signature = certTable("signature");
    expect(signature.box.w - 500).toBeLessThan(224.5);
    expect(resizeBox(signature, "e", -500, 0, CERT_CONTRACT).w).toBe(224.5);
  });
  it("pin: the To block stops at its least width, the freeform block at one grid step, the part lines at their columns", () => {
    // The two least widths, as constants: dropping the signature's reds this line too, beside the
    // guard case above, which reads it through resizeBox alone.
    expect(CERT_LEAST_WIDTHS.signature).toBe(224.5);
    expect(CERT_LEAST_WIDTHS.to).toBe(244.5);
    expect(resizeBox(certTable("to"), "e", -500, 0, CERT_CONTRACT).w).toBe(244.5);
    // The freeform block is drawn the content width wide: a drag past its whole width reaches the floor.
    const freeform = certTable("freeform");
    expect(CERT_LEAST_WIDTHS.freeform).toBeUndefined();
    expect(resizeBox(freeform, "e", -freeform.box.w, 0, CERT_CONTRACT).w).toBe(CANVAS_GRID);
    const parts = certTable("parts");
    expect(parts.box.w - 500).toBeLessThan(leastWidth(CERT_CONTRACT, parts));
    expect(resizeBox(parts, "e", -500, 0, CERT_CONTRACT).w).toBe(leastWidth(CERT_CONTRACT, parts));
    // Its columns, their padding and rules and one grid step (#971).
    expect(leastWidth(CERT_CONTRACT, parts)).toBe(visibleColumnsWidth(CERT_CONTRACT, parts) + tableOverhead("ruled", 3) + CANVAS_GRID);
  });
  it.each(CERT_TABLES)("pin: a new %s block from the palette on an empty page passes every rule", (key) => {
    const tableEntry = paletteEntries(layoutOf([]), CERT_CONTRACT).find((e) => e.kind === "table" && e.key === key)!;
    expect(tableEntry).toMatchObject({ state: "available" });
    const placed = placeNew(layoutOf([]), CERT_CONTRACT, tableEntry);
    if (placed.kind !== "table") return expect.fail("a table entry placed a table");
    expect(placed.box).toEqual({ x: 24, y: 140, w: CONTENT_WIDTH, h: CERT_ROW_FLOOR });
    expect(placed.box.w).toBeGreaterThanOrEqual(leastWidth(CERT_CONTRACT, placed));
    expect(placed.columns).toEqual(defaultTableColumns(CERT_CONTRACT, key));
    // The new block leaves its heading and one row above the band (rule 8's room).
    expect(placed.box.y + CERT_FIRST_TABLE_ROOM).toBeLessThan(bandTop(layoutOf([placed])));
    expect(() => validateCanvasLayout(layoutOf([placed]), CERT_CONTRACT)).not.toThrow();
  });
  it.each(CERT_FIELDS)("pin: a new %s field is placed 180 wide and passes every rule", (key) => {
    // No certification field has a least width, so 180 is the rule.
    expect(CERT_LEAST_WIDTHS[key]).toBeUndefined();
    const fieldEntry = paletteEntries(layoutOf([]), CERT_CONTRACT).find((e) => e.kind === "field" && e.key === key)!;
    expect(fieldEntry).toMatchObject({ state: "available" });
    const placed = placeNew(layoutOf([]), CERT_CONTRACT, fieldEntry);
    expect(placed.box.w).toBe(180);
    expect(() => validateCanvasLayout(layoutOf([placed]), CERT_CONTRACT)).not.toThrow();
  });
  it("pin: requires nothing, so nothing is named unremovable and Clear the page empties it", () => {
    expect(DESIGNER_WORDS.cannotRemove(CERT_CONTRACT)).toBeNull();
    expect(DESIGNER_WORDS.clearPageConfirm(CERT_CONTRACT))
      .toBe("Every item is removed from the canvas; Save keeps it, Discard undoes it.");
  });
});

describe("the invoice's palette, placing and resize floors (design 2026-11-10 §8)", () => {
  /*
   * The designer leaf on the invoice's profile (`INVOICE_CANVAS`). No production change comes with
   * these cases: they run green on arrival, and their guards are proven by editing the invoice's
   * profile entries (plan Departure 6).
   */
  const INV_TABLES = ["parties", "column_header", "order_strip", "parts", "price", "totals"] as const;
  const INV_ROWS_BLOCKS = ["parties", "order_strip", "parts", "price", "totals"] as const;
  const INV_FIELDS = [
    "title", "company_name", "invoice_no", "invoice_date", "terms", "remit_to",
    "footer_address", "footer_contact", "footer_phone",
  ];
  const entryFor = (kind: PaletteEntry["kind"], key: string): PaletteEntry => {
    const entry = paletteEntries(layoutOf([]), INVOICE_CONTRACT).find((e) => e.kind === kind && e.key === key);
    if (entry === undefined) return expect.fail(`no ${kind} entry ${key}`);
    return entry;
  };
  /** The column headers' fixed columns at the contract's default widths (202), read from the contract. */
  const headersWidth = () => INVOICE_CONTRACT.sections.find((s) => s.key === "column_header")!.fields
    .reduce((sum, f) => sum + (f.column!.defaultWidth === "*" ? 0 : f.column!.defaultWidth), 0);

  it("the fields are the nine placeable ones, grouped by section in contract order, then the six blocks, all placed, no barcode", () => {
    const entries = paletteEntries(standardInvoiceLayout(), INVOICE_CONTRACT);
    const placeable = canvasFieldKeys(INVOICE_CONTRACT);
    expect([...placeable].sort()).toEqual([...INV_FIELDS].sort());
    const fieldEntries = entries.filter((e) => e.kind === "field");
    expect(fieldEntries.map((e) => e.key)).toEqual(INV_FIELDS);
    // Each field's group is its own section's name, read from the contract.
    const sectionOf = (key: string) => INVOICE_CONTRACT.sections.find((s) => s.fields.some((f) => f.key === key))!.name;
    for (const e of fieldEntries) expect(e.group).toBe(sectionOf(e.key!));
    expect([...new Set(fieldEntries.map((e) => e.group))]).toEqual(["Header", "Invoice identity", "Page footer strip"]);
    expect(fieldEntries.every((e) => e.state === "placed")).toBe(true);
    const tables = entries.filter((e) => e.kind === "table");
    expect(tables).toMatchObject([
      { key: "parties", label: "Bill to / ship to table" },
      { key: "column_header", label: "Column headers table" },
      { key: "order_strip", label: "Order strip table" },
      { key: "parts", label: "Part rows table" },
      { key: "price", label: "Price block table" },
      { key: "totals", label: "Totals table" },
    ]);
    expect(tables.every((e) => e.state === "placed" && e.group === "Tables")).toBe(true);
    expect(entries.some((e) => e.kind === "barcode")).toBe(false);
    expect(entries.some((e) => e.kind === "textBlock" || e.group === "Wording")).toBe(false);
    expect(entries.find((e) => e.kind === "logo")).toMatchObject({ state: "available", group: "Page items" });
    expect(entries.map((e) => e.kind).slice(-4)).toEqual(["logo", "text", "line", "box"]);
    expect(entries.slice(-3).every((e) => e.state === "available" && e.group === "Page items")).toBe(true);
  });
  it("offers an anchor below the addresses by the block's name (pin)", () => {
    // No edit of the invoice's profile reds this: the name is the section's, read through tableName.
    expect(DESIGNER_WORDS.anchorBelow(itemTitle(invoiceTable("parties"), INVOICE_CONTRACT))).toBe("Below Bill to / ship to table");
  });

  // Resize floors (call 11, its figures the owner's and the controller's): a drag past a block's
  // whole width stops at its least width, the left edge kept. The figure is the derivation from the
  // flow's own widths (`INVOICE_WIDTHS`, the hold of tests/invoice-canvas.test.ts), never the
  // profile's literal read back (invoice canvas PR 2, Task 1).
  it.each(INV_ROWS_BLOCKS)("the %s block stops at its least width", (key) => {
    const block = invoiceTable(key);
    const least = flowLeastWidths()[key];
    expect(least).toBeGreaterThan(CANVAS_GRID);
    // The block starts wider than its floor, so a drag past its whole width reaches the floor.
    expect(block.box.w).toBeGreaterThan(least);
    expect(resizeBox(block, "e", -block.box.w, 0, INVOICE_CONTRACT)).toMatchObject({ x: block.box.x, w: least });
  });
  it("the column headers stop at their visible fixed columns, their padding and rules and one grid step: 242.5 at the default grid", () => {
    const headers = invoiceTable("column_header");
    expect(INVOICE_LEAST_WIDTHS.column_header).toBeUndefined();
    expect(headersWidth()).toBe(202);
    expect(visibleColumnsWidth(INVOICE_CONTRACT, headers)).toBe(headersWidth());
    // #971: the boxed strip's 36 pt of padding and rules and one grid step on top.
    const least = headersWidth() + tableOverhead("boxed", 4) + CANVAS_GRID;
    expect(least).toBe(242.5);
    expect(leastWidth(INVOICE_CONTRACT, headers)).toBe(least);
    expect(resizeBox(headers, "e", -headers.box.w, 0, INVOICE_CONTRACT)).toMatchObject({ x: headers.box.x, w: least });
  });

  it.each(INV_TABLES)("a new %s block from the palette on an empty page passes every rule", (key) => {
    const tableEntry = entryFor("table", key);
    expect(tableEntry).toMatchObject({ state: "available" });
    const placed = placeNew(layoutOf([]), INVOICE_CONTRACT, tableEntry);
    if (placed.kind !== "table") return expect.fail("a table entry placed a table");
    expect(placed.box).toEqual({ x: 24, y: 140, w: CONTENT_WIDTH, h: INVOICE_ROW_FLOOR });
    expect(placed.box.w).toBeGreaterThanOrEqual(leastWidth(INVOICE_CONTRACT, placed));
    expect(placed.columns).toEqual(defaultTableColumns(INVOICE_CONTRACT, key));
    // The new block leaves its heading and one row above the band (rule 8's room).
    expect(placed.box.y + INVOICE_FIRST_TABLE_ROOM).toBeLessThan(bandTop(layoutOf([placed])));
    expect(() => validateCanvasLayout(layoutOf([placed]), INVOICE_CONTRACT)).not.toThrow();
  });
  it("a new part rows block placed under new column headers lines up under them, so warning (g) is silent; moved, it warns", () => {
    const headers = placeNew(layoutOf([]), INVOICE_CONTRACT, entryFor("table", "column_header"));
    const parts = placeNew(layoutOf([headers]), INVOICE_CONTRACT, entryFor("table", "parts"));
    expect(parts.anchor).toEqual({ kind: "below-table", table: "column_header" });
    expect(parts.box).toMatchObject({ x: headers.box.x, w: headers.box.w });
    const placed = layoutOf([headers, parts]);
    expect(() => validateCanvasLayout(placed, INVOICE_CONTRACT)).not.toThrow();
    expect(canvasWarnings(placed, INVOICE_CONTRACT)).toEqual([]);
    // The same block drawn one grid step in and narrower is warned by (g) alone, so the silence above
    // is the blocks lining up, not (g) passing them by.
    const off = layoutOf([headers, { ...parts, box: { ...parts.box, x: 24 + CANVAS_GRID, w: CONTENT_WIDTH - CANVAS_GRID } } as CanvasItem]);
    expect(() => validateCanvasLayout(off, INVOICE_CONTRACT)).not.toThrow();
    expect(canvasWarnings(off, INVOICE_CONTRACT)).toEqual([{
      itemIds: [parts.id],
      sentence: "The Part rows table prints under the Column headers table's columns, but is drawn at another left edge " +
        "or width, so its columns do not line up under them.",
    }]);
  });
  it.each(INV_FIELDS)("a new %s field is placed 180 wide and passes every rule", (key) => {
    // No invoice field has a least width, so 180 is the rule.
    expect(INVOICE_LEAST_WIDTHS[key]).toBeUndefined();
    const fieldEntry = entryFor("field", key);
    expect(fieldEntry).toMatchObject({ state: "available" });
    const placed = placeNew(layoutOf([]), INVOICE_CONTRACT, fieldEntry);
    expect(placed.box.w).toBe(180);
    expect(() => validateCanvasLayout(layoutOf([placed]), INVOICE_CONTRACT)).not.toThrow();
  });

  it("draws the Remit To box in a border, the invoice number bare, and no field on a rule", () => {
    expect(drawsBorder(invoiceField("remit_to"), INVOICE_CONTRACT)).toBe(true);
    expect(drawsBorder(invoiceField("invoice_no"), INVOICE_CONTRACT)).toBe(false);
    expect(ruleOf(invoiceField("remit_to"), INVOICE_CONTRACT)).toBeNull();
    expect(ruleOf(invoiceField("invoice_no"), INVOICE_CONTRACT)).toBeNull();
  });
  it("requires nothing, so nothing is named unremovable and Clear the page empties it", () => {
    expect(DESIGNER_WORDS.cannotRemove(INVOICE_CONTRACT)).toBeNull();
    expect(DESIGNER_WORDS.clearPageConfirm(INVOICE_CONTRACT))
      .toBe("Every item is removed from the canvas; Save keeps it, Discard undoes it.");
  });
  it("Clear the page leaves an empty canvas the rules accept, and the palette then offers every invoice entry", () => {
    // Red when INVOICE_CANVAS requires a block (`required: [{ kind: "table", key: "totals" }]`): the cleared
    // page then holds it and the palette marks it required.
    const cleared = clearedLayout(INVOICE_CONTRACT);
    expect(cleared).toEqual({ version: 1, items: [] });
    expect(() => validateCanvasLayout(cleared, INVOICE_CONTRACT)).not.toThrow();
    const entries = paletteEntries(cleared, INVOICE_CONTRACT);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.filter((e) => e.kind === "table").map((e) => e.key)).toEqual([...INV_TABLES]);
    expect(entries.filter((e) => e.kind === "field").map((e) => e.key)).toEqual(INV_FIELDS);
    expect(entries.every((e) => e.state === "available")).toBe(true);
  });
});

describe("the statement's palette, placing and resize floors (design 2026-11-11 §8)", () => {
  /*
   * The designer leaf on the statement's profile (`STATEMENT_CANVAS`). No production change comes with
   * these cases: they run green on arrival, and their guards are proven by editing the statement's
   * profile entries (plan Departure 4). The statement's canvas prints since PR 2 of its lane; the leaf
   * serves its profile, which is what these cases hold. Its least widths and `boxedFields` are held to the
   * flow's own widths and boxed list (`STATEMENT_WIDTHS`, `STATEMENT_BOXED_FIELDS`) by
   * tests/statement-canvas.test.ts, and the floors below read that derivation.
   */
  const ST_TABLES = ["bill_to", "open_items", "aging", "finance_charge", "total"] as const;
  const ST_FIELDS = ["title", "company_name", "customer", "statement_date", "remit_to"];
  const entryFor = (kind: PaletteEntry["kind"], key: string): PaletteEntry => {
    const entry = paletteEntries(layoutOf([]), STATEMENT_CONTRACT).find((e) => e.kind === kind && e.key === key);
    if (entry === undefined) return expect.fail(`no ${kind} entry ${key}`);
    return entry;
  };

  it("the fields are the five placeable ones, grouped by section in contract order, then the five blocks, all placed, no barcode", () => {
    const entries = paletteEntries(standardStatementLayout(), STATEMENT_CONTRACT);
    const placeable = canvasFieldKeys(STATEMENT_CONTRACT);
    expect([...placeable]).toEqual(ST_FIELDS);
    const fieldEntries = entries.filter((e) => e.kind === "field");
    expect(fieldEntries.map((e) => e.key)).toEqual(ST_FIELDS);
    // Each field's group is its own section's name, read from the contract.
    const sectionOf = (key: string) => STATEMENT_CONTRACT.sections.find((s) => s.fields.some((f) => f.key === key))!.name;
    for (const e of fieldEntries) expect(e.group).toBe(sectionOf(e.key!));
    expect([...new Set(fieldEntries.map((e) => e.group))]).toEqual(["Header", "Statement identity"]);
    expect(fieldEntries.every((e) => e.state === "placed")).toBe(true);
    const tables = entries.filter((e) => e.kind === "table");
    expect(tables).toMatchObject([
      { key: "bill_to", label: "Bill-to address table" },
      { key: "open_items", label: "Open items table" },
      { key: "aging", label: "Aging strip table" },
      { key: "finance_charge", label: "Finance charge table" },
      { key: "total", label: "Total due table" },
    ]);
    expect(tables).toHaveLength(ST_TABLES.length);
    expect(tables.every((e) => e.state === "placed" && e.group === "Tables")).toBe(true);
    expect(entries.some((e) => e.kind === "barcode")).toBe(false);
    expect(entries.find((e) => e.kind === "logo")).toMatchObject({ state: "available", group: "Page items" });
    expect(entries.map((e) => e.kind).slice(-4)).toEqual(["logo", "text", "line", "box"]);
    expect(entries.slice(-3).every((e) => e.state === "available" && e.group === "Page items")).toBe(true);
  });
  it("offers no Wording: the statement carries no standing text, on the standard page or an empty one (pin)", () => {
    // No edit of the statement's profile reds this: the palette's Wording group reads the contract's textBlocks.
    expect(STATEMENT_CONTRACT.textBlocks).toEqual([]);
    for (const layout of [standardStatementLayout(), layoutOf([])]) {
      const entries = paletteEntries(layout, STATEMENT_CONTRACT);
      expect(entries.some((e) => e.kind === "textBlock" || e.group === "Wording")).toBe(false);
    }
  });
  // The Bill To is keyed by its field, so tableName reads the field's contract name; keyed by a
  // section it would read the bare key, as no section is named bill_to. The four section-keyed blocks
  // read their sections' names (pins: no profile entry decides them).
  it.each<[StatementTable, string]>([
    ["bill_to", "Below Bill-to address table"], ["open_items", "Below Open items table"],
    ["aging", "Below Aging strip table"], ["finance_charge", "Below Finance charge table"], ["total", "Below Total due table"],
  ])("offers an anchor below the %s block by its name", (key, sentence) => {
    expect(DESIGNER_WORDS.anchorBelow(itemTitle(statementTable(key), STATEMENT_CONTRACT))).toBe(sentence);
  });

  // Resize floors (call 12): a drag past a block's whole width stops at its least width, the left edge
  // kept. The two totals' figure is totalLine's label, its amount and the two gaps, plus one grid
  // step, derived from the flow's own widths (`STATEMENT_WIDTHS`, the hold of
  // tests/statement-canvas.test.ts), never the profile's literal read back (since
  // statement canvas PR 2); the design's figure is 316.5.
  it.each(["finance_charge", "total"] as const)("the %s block stops at its least width", (key) => {
    const block = statementTable(key);
    const least = statementFlowLeastWidths()[key];
    expect(STATEMENT_LEAST_WIDTHS[key]).toBe(least);
    expect(leastWidth(STATEMENT_CONTRACT, block)).toBe(least);
    expect(least).toBeGreaterThan(CANVAS_GRID);
    // The block starts wider than its floor, so a drag past its whole width reaches the floor.
    expect(block.box.w).toBeGreaterThan(least);
    expect(resizeBox(block, "e", -block.box.w, 0, STATEMENT_CONTRACT)).toMatchObject({ x: block.box.x, w: least });
  });
  it("the bill_to block has no least width and stops at one grid step", () => {
    const block = statementTable("bill_to");
    // The reason, not only the result: no entry, no printed columns and nothing kept beside them.
    expect(STATEMENT_LEAST_WIDTHS.bill_to).toBeUndefined();
    expect(visibleColumnsWidth(STATEMENT_CONTRACT, block)).toBe(0);
    expect(besideOf(STATEMENT_CONTRACT, "bill_to")).toBe(0);
    expect(leastWidth(STATEMENT_CONTRACT, block)).toBe(0);
    expect(resizeBox(block, "e", -block.box.w, 0, STATEMENT_CONTRACT)).toMatchObject({ x: block.box.x, w: CANVAS_GRID });
  });
  it("the open_items block stops at the owner's 49.5 (#971, ruling 4)", () => {
    const block = statementTable("open_items");
    expect(STATEMENT_LEAST_WIDTHS.open_items).toBe(49.5);
    expect(resizeBox(block, "e", -block.box.w, 0, STATEMENT_CONTRACT)).toMatchObject({ x: block.box.x, w: 49.5 });
  });
  it("the aging block, every Standard column \"*\", stops at its padding and rules and one grid step (#971)", () => {
    const block = statementTable("aging");
    // The reason, not only the result: no entry, no fixed column and nothing kept beside them, so its
    // floor is the boxed strip's padding and rules over its seven columns and one grid step.
    expect(STATEMENT_LEAST_WIDTHS.aging).toBeUndefined();
    expect(visibleColumnsWidth(STATEMENT_CONTRACT, block)).toBe(0);
    expect(besideOf(STATEMENT_CONTRACT, "aging")).toBe(0);
    const least = round2(tableOverhead("boxed", 7) + CANVAS_GRID);
    expect(least).toBe(66.9);
    expect(leastWidth(STATEMENT_CONTRACT, block)).toBe(least);
    expect(resizeBox(block, "e", -block.box.w, 0, STATEMENT_CONTRACT)).toMatchObject({ x: block.box.x, w: least });
  });
  it.each(ST_TABLES)("the %s block stops at the row floor under a north drag past its bottom", (key) => {
    const block = statementTable(key);
    const bottom = block.box.y + block.box.h;
    const resized = resizeBox(block, "n", 0, block.box.h + 10 * CANVAS_GRID, STATEMENT_CONTRACT);
    expect(resized).toMatchObject({ y: bottom - STATEMENT_ROW_FLOOR, h: STATEMENT_ROW_FLOOR });
    // The floor is the profile's, not one grid step.
    expect(STATEMENT_ROW_FLOOR).toBeGreaterThan(CANVAS_GRID);
  });

  it.each(ST_TABLES)("a new %s block from the palette on an empty page passes every rule", (key) => {
    const tableEntry = entryFor("table", key);
    expect(tableEntry).toMatchObject({ state: "available" });
    const placed = placeNew(layoutOf([]), STATEMENT_CONTRACT, tableEntry);
    if (placed.kind !== "table") return expect.fail("a table entry placed a table");
    // FIRST_TABLE_TOP (140, the designer leaf's): the standard arrangement's Bill To stands at 98 and
    // its Remit To box ends at 139.5, so a first block placed alone lands under where the box would be.
    expect(placed.box).toEqual({ x: 24, y: 140, w: CONTENT_WIDTH, h: STATEMENT_ROW_FLOOR });
    expect(placed.anchor).toEqual({ kind: "page-top" });
    expect(placed.box.w).toBeGreaterThanOrEqual(leastWidth(STATEMENT_CONTRACT, placed));
    expect(placed.columns).toEqual(defaultTableColumns(STATEMENT_CONTRACT, key));
    // Every rule passes, rule 8's room (the profile's firstTableRoom above the band) among them; the
    // room's own edge is held by template-canvas.test.ts's rule 8 cases.
    expect(() => validateCanvasLayout(layoutOf([placed]), STATEMENT_CONTRACT)).not.toThrow();
  });
  it.each(ST_FIELDS)("a new %s field is placed 180 wide and passes every rule", (key) => {
    // No statement field has a least width, so 180 is the rule.
    expect(STATEMENT_LEAST_WIDTHS[key]).toBeUndefined();
    const fieldEntry = entryFor("field", key);
    expect(fieldEntry).toMatchObject({ state: "available" });
    const placed = placeNew(layoutOf([]), STATEMENT_CONTRACT, fieldEntry);
    // At the left margin, on the first grid row at or under the top margin (24), 180 × 12.
    expect(placed.box).toEqual({ x: 24, y: Math.ceil(24 / CANVAS_GRID) * CANVAS_GRID, w: 180, h: 12 });
    expect(() => validateCanvasLayout(layoutOf([placed]), STATEMENT_CONTRACT)).not.toThrow();
  });

  it("draws the Remit To box in a border, the customer bare, and no field on a rule", () => {
    // boxedFields is held to the paper's STATEMENT_BOXED_FIELDS by tests/statement-canvas.test.ts.
    expect(drawsBorder(statementField("remit_to"), STATEMENT_CONTRACT)).toBe(true);
    expect(drawsBorder(statementField("customer"), STATEMENT_CONTRACT)).toBe(false);
    expect(ruleOf(statementField("remit_to"), STATEMENT_CONTRACT)).toBeNull();
    expect(ruleOf(statementField("customer"), STATEMENT_CONTRACT)).toBeNull();
  });
  it("requires nothing, so nothing is named unremovable and Clear the page empties it", () => {
    expect(DESIGNER_WORDS.cannotRemove(STATEMENT_CONTRACT)).toBeNull();
    expect(DESIGNER_WORDS.clearPageConfirm(STATEMENT_CONTRACT))
      .toBe("Every item is removed from the canvas; Save keeps it, Discard undoes it.");
    expect(clearedLayout(STATEMENT_CONTRACT)).toEqual({ version: 1, items: [] });
  });
  it("Clear the page leaves an empty canvas the rules accept, the palette then offers every statement entry, and a Bill To placed there lands at 140", () => {
    // Red when STATEMENT_CANVAS requires a block (`required: [{ kind: "table", key: "total" }]`): the
    // cleared page then holds it and the palette marks it required. The placing half restates, on the
    // cleared page, what "a new bill_to block from the palette on an empty page passes every rule"
    // above holds on `layoutOf([])` (open question 8: `placeNew` unchanged).
    const cleared = clearedLayout(STATEMENT_CONTRACT);
    expect(cleared).toEqual({ version: 1, items: [] });
    expect(() => validateCanvasLayout(cleared, STATEMENT_CONTRACT)).not.toThrow();
    const entries = paletteEntries(cleared, STATEMENT_CONTRACT);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.filter((e) => e.kind === "table").map((e) => e.key)).toEqual([...ST_TABLES]);
    expect(entries.filter((e) => e.kind === "field").map((e) => e.key)).toEqual(ST_FIELDS);
    expect(entries.every((e) => e.state === "available")).toBe(true);
    const bill = entries.find((e) => e.kind === "table" && e.key === "bill_to")!;
    const placed = placeNew(cleared, STATEMENT_CONTRACT, bill);
    expect(placed.box).toEqual({ x: 24, y: 140, w: CONTENT_WIDTH, h: STATEMENT_ROW_FLOOR });
    expect(CONTENT_WIDTH).toBe(564);
    expect(() => validateCanvasLayout(layoutOf([placed]), STATEMENT_CONTRACT)).not.toThrow();
  });
});

describe("the quote's palette, placing and resize floors (design 2026-11-12 §8)", () => {
  /*
   * The designer leaf on the quotation's profile (`QUOTE_CANVAS`). No production change comes with
   * these cases: they run green on arrival, and their guards are proven by editing the quote's
   * profile entries (plan Departure 4). The quote's canvas prints since quote canvas PR 2 (it is in
   * CANVAS_PRINTS, and a draft offers Design on a canvas); the leaf serves its profile, which is what
   * these cases hold. Its least widths are the design's figures, literals in PR 1, held since quote
   * canvas PR 2 to src/server/pdf/quote.ts's QUOTE_WIDTHS by tests/quote-canvas.test.ts.
   */
  const QT_TABLES = ["parties", "intro", "column_header", "lines", "closing", "liability"] as const;
  const QT_FIELDS = ["title", "company_name", "company_address", "quote_number"];
  const entryFor = (kind: PaletteEntry["kind"], key: string): PaletteEntry => {
    const entry = paletteEntries(layoutOf([]), QUOTE_CONTRACT).find((e) => e.kind === kind && e.key === key);
    if (entry === undefined) return expect.fail(`no ${kind} entry ${key}`);
    return entry;
  };
  /** The column headers' fixed columns at the contract's default widths (202), read from the contract. */
  const headersWidth = () => QUOTE_CONTRACT.sections.find((s) => s.key === "column_header")!.fields
    .reduce((sum, f) => sum + (f.column!.defaultWidth === "*" ? 0 : f.column!.defaultWidth), 0);

  it("the fields are the four placeable ones, under the Header, then the six blocks, all placed, no barcode", () => {
    const entries = paletteEntries(standardQuoteLayout(), QUOTE_CONTRACT);
    expect([...canvasFieldKeys(QUOTE_CONTRACT)]).toEqual(QT_FIELDS);
    const fieldEntries = entries.filter((e) => e.kind === "field");
    expect(fieldEntries.map((e) => e.key)).toEqual(QT_FIELDS);
    // Each field's group is its own section's name, read from the contract.
    const sectionOf = (key: string) => QUOTE_CONTRACT.sections.find((s) => s.fields.some((f) => f.key === key))!.name;
    for (const e of fieldEntries) expect(e.group).toBe(sectionOf(e.key!));
    expect([...new Set(fieldEntries.map((e) => e.group))]).toEqual(["Header"]);
    expect(fieldEntries.every((e) => e.state === "placed")).toBe(true);
    const tables = entries.filter((e) => e.kind === "table");
    expect(tables).toMatchObject([
      { key: "parties", label: "Attention / quote fields table" },
      { key: "intro", label: "Intro line table" },
      { key: "column_header", label: "Column headers table" },
      { key: "lines", label: "Quote lines and prices table" },
      { key: "closing", label: "Closing and signature table" },
      { key: "liability", label: "Liability text table" },
    ]);
    expect(tables).toHaveLength(QT_TABLES.length);
    expect(tables.every((e) => e.state === "placed" && e.group === "Tables")).toBe(true);
    expect(entries.some((e) => e.kind === "barcode")).toBe(false);
    expect(entries.find((e) => e.kind === "logo")).toMatchObject({ state: "available", group: "Page items" });
    expect(entries.map((e) => e.kind).slice(-4)).toEqual(["logo", "text", "line", "box"]);
    expect(entries.slice(-3).every((e) => e.state === "available" && e.group === "Page items")).toBe(true);
  });
  it("offers no Wording: both of the quote's wordings print inside their blocks, on the standard page or an empty one", () => {
    // The contract holds two wordings, so the empty Wording group is the blocks printing them
    // (`textBlocks`, the palette's printedByBlock), not a contract with none.
    expect(QUOTE_CONTRACT.textBlocks.map((b) => b.key)).toEqual(["quote_intro_text", "quote_liability_text"]);
    for (const layout of [standardQuoteLayout(), layoutOf([])]) {
      const entries = paletteEntries(layout, QUOTE_CONTRACT);
      expect(entries.some((e) => e.kind === "textBlock" || e.group === "Wording")).toBe(false);
    }
  });
  // Every quote block is keyed by its section, so tableName reads the section's name. Pins: no edit of
  // the quote's profile reds them (keyed "field" finds no field of a block's key and falls back to the
  // section's name, and a block dropped from the profile is named by its section all the same).
  it.each<[QuoteTable, string]>([
    ["parties", "Below Attention / quote fields table"], ["intro", "Below Intro line table"],
    ["column_header", "Below Column headers table"], ["lines", "Below Quote lines and prices table"],
    ["closing", "Below Closing and signature table"], ["liability", "Below Liability text table"],
  ])("offers an anchor below the %s block by its name (pin)", (key, sentence) => {
    expect(DESIGNER_WORDS.anchorBelow(itemTitle(quoteTable(key), QUOTE_CONTRACT))).toBe(sentence);
  });
  it.each<[QuoteTable, boolean]>([
    ["parties", false], ["intro", true], ["column_header", false], ["lines", false], ["closing", false], ["liability", true],
  ])("the %s block is a list block: %s", (key, list) => {
    expect(isListBlock(QUOTE_CONTRACT, key)).toBe(list);
  });
  it("the column headers keep nothing beside their strip", () => {
    expect(besideOf(QUOTE_CONTRACT, "column_header")).toBe(0);
  });

  // Resize floors (call 9): a drag past a block's whole width stops at its least width, the left edge
  // kept. The figures are the design's (Global Constraints: never the profile's expression read back).
  it.each<[QuoteTable, number]>([["parties", 252.5], ["lines", 230.5], ["closing", 246.5]])(
    "the %s block stops at its least width, %s",
    (key, least) => {
      const block = quoteTable(key);
      expect(leastWidth(QUOTE_CONTRACT, block)).toBe(least);
      // The block starts wider than its floor, so a drag past its whole width reaches the floor.
      expect(block.box.w).toBeGreaterThan(least);
      expect(resizeBox(block, "e", -block.box.w, 0, QUOTE_CONTRACT)).toMatchObject({ x: block.box.x, w: least });
    },
  );
  it("the column headers stop at their visible fixed columns, their padding and rules and one grid step: 242.5 at the default grid", () => {
    const headers = quoteTable("column_header");
    expect(QUOTE_LEAST_WIDTHS.column_header).toBeUndefined();
    expect(headersWidth()).toBe(202);
    expect(visibleColumnsWidth(QUOTE_CONTRACT, headers)).toBe(headersWidth());
    // #971: the boxed strip's 36 pt of padding and rules and one grid step on top.
    const least = headersWidth() + tableOverhead("boxed", 4) + CANVAS_GRID;
    expect(least).toBe(242.5);
    expect(leastWidth(QUOTE_CONTRACT, headers)).toBe(least);
    expect(resizeBox(headers, "e", -headers.box.w, 0, QUOTE_CONTRACT)).toMatchObject({ x: headers.box.x, w: least });
  });
  it.each(["intro", "liability"] as const)("the %s block has no least width and stops at one grid step", (key) => {
    const block = quoteTable(key);
    // The reason, not only the result: no entry, no printed columns and nothing kept beside them.
    expect(QUOTE_LEAST_WIDTHS[key]).toBeUndefined();
    expect(visibleColumnsWidth(QUOTE_CONTRACT, block)).toBe(0);
    expect(besideOf(QUOTE_CONTRACT, key)).toBe(0);
    expect(leastWidth(QUOTE_CONTRACT, block)).toBe(0);
    expect(resizeBox(block, "e", -block.box.w, 0, QUOTE_CONTRACT)).toMatchObject({ x: block.box.x, w: CANVAS_GRID });
  });
  it.each(QT_TABLES)("the %s block stops at the row floor under a north drag past its bottom", (key) => {
    // Drawn taller than the floor, so the stop is the floor's and not the box's own height.
    const standard = quoteTable(key);
    const block = quoteTable(key, { box: { ...standard.box, h: QUOTE_ROW_FLOOR + 4 * CANVAS_GRID } });
    const bottom = block.box.y + block.box.h;
    const resized = resizeBox(block, "n", 0, block.box.h + 10 * CANVAS_GRID, QUOTE_CONTRACT);
    expect(resized).toMatchObject({ y: bottom - QUOTE_ROW_FLOOR, h: QUOTE_ROW_FLOOR });
    // The floor is the profile's, not one grid step.
    expect(QUOTE_ROW_FLOOR).toBeGreaterThan(CANVAS_GRID);
  });

  it.each(QT_TABLES)("a new %s block from the palette on an empty page passes every rule", (key) => {
    const tableEntry = entryFor("table", key);
    expect(tableEntry).toMatchObject({ state: "available" });
    const placed = placeNew(layoutOf([]), QUOTE_CONTRACT, tableEntry);
    if (placed.kind !== "table") return expect.fail("a table entry placed a table");
    // FIRST_TABLE_TOP (140, the designer leaf's), the profile's floor tall, the content width wide.
    expect(placed.box).toEqual({ x: 24, y: 140, w: CONTENT_WIDTH, h: QUOTE_ROW_FLOOR });
    expect(placed.anchor).toEqual({ kind: "page-top" });
    expect(placed.box.w).toBeGreaterThanOrEqual(leastWidth(QUOTE_CONTRACT, placed));
    expect(placed.columns).toEqual(defaultTableColumns(QUOTE_CONTRACT, key));
    // Every rule passes, rule 8's room among them, with the page line on (the quote's Standard) or off.
    for (const pageFooter of [true, false]) {
      expect(() => validateCanvasLayout(layoutOf([placed]), QUOTE_CONTRACT, { pageFooter })).not.toThrow();
    }
  });
  it("a first quote block placed under the standard header lands at 140, clear of the header, and passes every rule", () => {
    // Design §15's FIRST_TABLE_TOP question, on the leaf: with no block placed, a new one stands at
    // 140 whatever the header holds. The standard header ends at 92, so 140 is clear of it; the seed's
    // parties is predicted at about 86 to 98 (design §4.4), so a block placed alone stands some 42 to
    // 54 pt lower than the seed would put it, which the user drags up. No change to placeNew.
    const header = standardQuoteLayout().items.filter((i) => i.kind === "field");
    expect(header).toHaveLength(QT_FIELDS.length);
    const headerBottom = Math.max(...header.map((i) => i.box.y + i.box.h));
    expect(headerBottom).toBe(92);
    const placed = placeNew(layoutOf(header), QUOTE_CONTRACT, entryFor("table", "parties"));
    expect(placed.box).toEqual({ x: 24, y: 140, w: CONTENT_WIDTH, h: QUOTE_ROW_FLOOR });
    expect(placed.box.y).toBeGreaterThan(headerBottom);
    expect(() => validateCanvasLayout(layoutOf([...header, placed]), QUOTE_CONTRACT, { pageFooter: true })).not.toThrow();
  });
  it("a new lines block placed under new column headers lines up under them, so warning (g) is silent; moved, it warns", () => {
    const headers = placeNew(layoutOf([]), QUOTE_CONTRACT, entryFor("table", "column_header"));
    const lines = placeNew(layoutOf([headers]), QUOTE_CONTRACT, entryFor("table", "lines"));
    expect(lines.anchor).toEqual({ kind: "below-table", table: "column_header" });
    expect(lines.box).toMatchObject({ x: headers.box.x, w: headers.box.w });
    const placed = layoutOf([headers, lines]);
    expect(() => validateCanvasLayout(placed, QUOTE_CONTRACT)).not.toThrow();
    expect(canvasWarnings(placed, QUOTE_CONTRACT)).toEqual([]);
    // The headers drawn 558 wide at x 24 and the block 558 wide at x 30 is warned by (g)'s left-edge
    // half alone (the widths agree), so the silence above is the blocks lining up, not (g) passing
    // them by.
    expect(headers.box).toMatchObject({ x: 24, w: CONTENT_WIDTH });
    const off = layoutOf([
      { ...headers, box: { ...headers.box, x: 24, w: 558 } } as CanvasItem,
      { ...lines, box: { ...lines.box, x: 30, w: 558 } } as CanvasItem,
    ]);
    expect(() => validateCanvasLayout(off, QUOTE_CONTRACT)).not.toThrow();
    expect(canvasWarnings(off, QUOTE_CONTRACT)).toEqual([{
      itemIds: [lines.id],
      sentence: "The Quote lines and prices table prints under the Column headers table's columns, but is drawn at another left edge " +
        "or width, so its columns do not line up under them.",
    }]);
  });
  it.each(QT_FIELDS)("a new %s field is placed 180 wide and passes every rule", (key) => {
    // No quote field has a least width, so 180 is the rule.
    expect(QUOTE_LEAST_WIDTHS[key]).toBeUndefined();
    const fieldEntry = entryFor("field", key);
    expect(fieldEntry).toMatchObject({ state: "available" });
    const placed = placeNew(layoutOf([]), QUOTE_CONTRACT, fieldEntry);
    // At the left margin, on the first grid row at or under the top margin (24), 180 × 12.
    expect(placed.box).toEqual({ x: 24, y: Math.ceil(24 / CANVAS_GRID) * CANVAS_GRID, w: 180, h: 12 });
    for (const pageFooter of [true, false]) {
      expect(() => validateCanvasLayout(layoutOf([placed]), QUOTE_CONTRACT, { pageFooter })).not.toThrow();
    }
  });

  it.each(QT_FIELDS)("draws the %s field bare: no border and no rule", (key) => {
    expect(drawsBorder(quoteField(key), QUOTE_CONTRACT)).toBe(false);
    expect(ruleOf(quoteField(key), QUOTE_CONTRACT)).toBeNull();
  });
  it("requires nothing, so nothing is named unremovable and Clear the page empties it", () => {
    expect(DESIGNER_WORDS.cannotRemove(QUOTE_CONTRACT)).toBeNull();
    expect(DESIGNER_WORDS.clearPageConfirm(QUOTE_CONTRACT))
      .toBe("Every item is removed from the canvas; Save keeps it, Discard undoes it.");
    expect(clearedLayout(QUOTE_CONTRACT)).toEqual({ version: 1, items: [] });
  });
  it("Clear the page leaves an empty canvas the rules accept, and the palette then offers every quote entry", () => {
    // Red when QUOTE_CANVAS requires a block (`required: [{ kind: "table", key: "lines" }]`): the
    // cleared page then holds it and the palette marks it required. Placing on the cleared page is
    // held above on `layoutOf([])`, which equals it ("a new %s block from the palette on an empty page
    // passes every rule", "a new %s field is placed 180 wide and passes every rule"), and is not
    // restated here.
    const cleared = clearedLayout(QUOTE_CONTRACT);
    expect(cleared).toEqual({ version: 1, items: [] });
    expect(cleared).toEqual(layoutOf([]));
    for (const pageFooter of [true, false]) {
      expect(() => validateCanvasLayout(cleared, QUOTE_CONTRACT, { pageFooter })).not.toThrow();
    }
    const entries = paletteEntries(cleared, QUOTE_CONTRACT);
    expect(entries.filter((e) => e.kind === "table").map((e) => e.key)).toEqual([...QT_TABLES]);
    expect(entries.filter((e) => e.kind === "field").map((e) => e.key)).toEqual(QT_FIELDS);
    expect(entries.map((e) => e.kind).slice(-4)).toEqual(["logo", "text", "line", "box"]);
    expect(entries).toHaveLength(QT_FIELDS.length + QT_TABLES.length + 4);
    expect(entries.every((e) => e.state === "available")).toBe(true);
  });
});

describe("the two required items", () => {
  it("are the barcode and the Process steps table, and nothing else", () => {
    expect(isRequired({ kind: "barcode" }, TRAVELER_CONTRACT)).toBe(true);
    expect(isRequired({ kind: "table", key: "steps" }, TRAVELER_CONTRACT)).toBe(true);
    for (const key of ["lines", "quantities", "inspections"]) expect(isRequired({ kind: "table", key }, TRAVELER_CONTRACT)).toBe(false);
    for (const kind of ["field", "logo", "text", "line", "box"] as const) expect(isRequired({ kind, key: "steps" }, TRAVELER_CONTRACT)).toBe(false);
  });
});

describe("Design on a canvas's gate", () => {
  it("closes on the edit gate first, then on no picked order, then while its request is out, and opens otherwise", () => {
    const open = { blocked: false, editTitle: undefined, picked: true, busy: false };
    expect(designOnCanvasGate(open, "TRAVELER")).toEqual({ disabled: false, title: undefined });
    expect(designOnCanvasGate({ ...open, picked: false }, "TRAVELER"))
      .toEqual({ disabled: true, title: "Pick an order in Preview first" });
    expect(designOnCanvasGate({ ...open, picked: false }, "SHIPPER"))
      .toEqual({ disabled: true, title: "Pick a single-order shipment in Preview first" });
    expect(designOnCanvasGate({ ...open, busy: true }, "TRAVELER")).toEqual({ disabled: true, title: undefined });
    expect(designOnCanvasGate({ ...open, blocked: true, editTitle: "Requires templates.edit", picked: false }, "SHIPPER"))
      .toEqual({ disabled: true, title: "Requires templates.edit" });
  });
});

describe("a resize stops at the raised floor (#971)", () => {
  it.each([
    ["the traveler's quantities", TRAVELER_CONTRACT, table("quantities"), 462.5],
    ["the shipping ticket's totals", SHIPPER_CONTRACT, ticketTable("totals"), 264.5],
    ["the MOS ticket's totals", MOS_SHIPPER_CONTRACT, ticketTable("totals"), 264.5],
    ["the statement's open items", STATEMENT_CONTRACT, statementTable("open_items"), 49.5],
  ] as const)("%s", (_, contract, block, least) => {
    expect(block.box.w).toBeGreaterThan(least);
    expect(resizeBox(block, "e", -block.box.w, 0, contract)).toMatchObject({ x: block.box.x, w: least });
  });
  it.each([["INVOICE", "parts"], ["INVOICE", "price"], ["QUOTE", "lines"]] as const)(
    "a grid block with its grid widened, the layout handed: %s %s at 250.5",
    (doc, key) => {
      const contract = doc === "INVOICE" ? INVOICE_CONTRACT : QUOTE_CONTRACT;
      const standard = doc === "INVOICE" ? standardInvoiceLayout() : standardQuoteLayout();
      // The column headers' Each weight column typed 86 (from 66).
      const layout = layoutOf(standard.items.map((i) => (i.kind === "table" && i.key === "column_header"
        ? { ...i, columns: i.columns.map((c) => (c.key === "col_each_weight" ? { ...c, width: 86 } : c)) } : i)));
      const block = layout.items.find((i) => i.kind === "table" && i.key === key)!;
      expect(resizeBox(block, "e", -block.box.w, 0, contract, undefined, undefined, layout)).toMatchObject({ x: block.box.x, w: 250.5 });
      // With no layout handed, the standard columns' figure.
      expect(resizeBox(block, "e", -block.box.w, 0, contract)).toMatchObject({ x: block.box.x, w: 230.5 });
      // The stage's two readers hand the layout they hold.
      expect(resizedBox(block, layout, null, "e", -block.box.w, 0, contract).w).toBe(250.5);
      expect(resizedItem(block, layout, null, "e", -block.box.w, 0, contract)!.box.w).toBe(250.5);
    },
  );
  // The order strip's floor reads its indent past the column headers' Quantity column (`gridIndent`,
  // design §6.1): Quantity typed 100 (from 52) gives 100 + 6 + 60 + 4.5.
  it("the invoice's order strip with the column headers' Quantity widened, the layout handed: at 170.5", () => {
    const layout = layoutOf(standardInvoiceLayout().items.map((i) => (i.kind === "table" && i.key === "column_header"
      ? { ...i, columns: i.columns.map((c) => (c.key === "col_qty" ? { ...c, width: 100 } : c)) } : i)));
    const block = layout.items.find((i) => i.kind === "table" && i.key === "order_strip")!;
    expect(block.box.w).toBeGreaterThan(170.5);
    expect(leastWidth(INVOICE_CONTRACT, block, { layout })).toBe(170.5);
    expect(resizeBox(block, "e", -block.box.w, 0, INVOICE_CONTRACT, undefined, undefined, layout)).toMatchObject({ x: block.box.x, w: 170.5 });
    // With no layout handed, the standard columns' figure.
    expect(resizeBox(block, "e", -block.box.w, 0, INVOICE_CONTRACT)).toMatchObject({ x: block.box.x, w: INVOICE_LEAST_WIDTHS.order_strip });
    // The stage's two readers hand the layout they hold.
    expect(resizedBox(block, layout, null, "e", -block.box.w, 0, INVOICE_CONTRACT).w).toBe(170.5);
    expect(resizedItem(block, layout, null, "e", -block.box.w, 0, INVOICE_CONTRACT)!.box.w).toBe(170.5);
  });
  // The price block prints its PRICE heading past the Quantity column, outside the grid's columns
  // (`gridIndent`, Codex review): with the Quantity column alone shown, 52 + 6 + 4.5, not the
  // grid's 52 + 4.5.
  it("the invoice's price block with the column headers' Quantity column alone shown, the layout handed: at 62.5", () => {
    const layout = layoutOf(standardInvoiceLayout().items.map((i) => (i.kind === "table" && i.key === "column_header"
      ? { ...i, columns: i.columns.map((c) => (c.key === "col_qty" ? c : { ...c, visible: false })) } : i)));
    const block = layout.items.find((i) => i.kind === "table" && i.key === "price")!;
    expect(resizeBox(block, "e", -block.box.w, 0, INVOICE_CONTRACT, undefined, undefined, layout)).toMatchObject({ x: block.box.x, w: 62.5 });
    expect(resizedBox(block, layout, null, "e", -block.box.w, 0, INVOICE_CONTRACT).w).toBe(62.5);
  });
});

describe("a resize under a floor wider than the content width stays on the page (#971 fix round 1)", () => {
  // The quantities with their Container typed 154: fixed 564, so their least width is 616.5.
  const wide = () => {
    const layout = standardLayout();
    return layoutOf(layout.items.map((i) => (i.kind === "table" && i.key === "quantities"
      ? { ...i, columns: i.columns.map((c) => (c.key === "container" ? { ...c, width: 154 } : c)) } : i)));
  };
  const quantitiesOf = (layout: CanvasLayout) =>
    layout.items.find((i): i is Extract<CanvasItem, { kind: "table" }> => i.kind === "table" && i.key === "quantities")!;
  const ruleNine = "The Quantities and containers table needs 616.5 pt: its visible columns' 564 pt, their 48 pt of padding " +
    "and rules and one grid step, more than its 564 pt.";
  it.each([["s", 0, 9], ["e", -36, 0], ["w", 36, 0]] as const)("the %s handle keeps the box inside the page, Save closed by rule 9", (handle, dx, dy) => {
    const layout = wide();
    const item = quantitiesOf(layout);
    expect(leastWidth(TRAVELER_CONTRACT, item)).toBe(616.5);
    const box = resizeBox(item, handle, dx, dy, TRAVELER_CONTRACT, undefined, undefined, layout);
    expect(box.x).toBeGreaterThanOrEqual(24);
    expect(box.x + box.w).toBeLessThanOrEqual(588);
    expect(box).toMatchObject({ x: 24, w: 564 });
    const resized = layoutOf(layout.items.map((i) => (i.id === item.id ? { ...i, box } as CanvasItem : i)));
    expect(canvasSaveBlock(TRAVELER_CONTRACT, { ...TRAVELER_DEFAULT_CONFIG, layout: resized })).toBe(ruleNine);
  });
  it("a box drawn narrower inside the page widens to the content width, never past a margin", () => {
    const layout = wide();
    const item = { ...quantitiesOf(layout), box: { ...quantitiesOf(layout).box, x: 100, w: 400 } };
    expect(resizeBox(item, "e", -9, 0, TRAVELER_CONTRACT)).toMatchObject({ x: 24, w: 564 });
    expect(resizeBox(item, "w", 9, 0, TRAVELER_CONTRACT)).toMatchObject({ x: 24, w: 564 });
  });
});
