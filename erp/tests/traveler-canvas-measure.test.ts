import { describe, it, expect } from "vitest";
import { canvasMeasure, mergeAloneMeasure } from "@/server/canvas-measure";
import { CANVAS_IDS, completeCanvas } from "@/server/traveler-canvas";
import type { LaidOutNode } from "@/server/pdf/render";
import { bandTop, topMargin, usableHeight, type CanvasMeasure } from "@/lib/template-canvas";
import type { CanvasItem, CanvasTableKey } from "@/lib/template-contracts/canvas";
import { layoutOf, standardLayout } from "./helpers/canvas-fixtures";

/**
 * The preview's measure report (PR B of #926, task 6; design §5.3): `canvasMeasure` maps the marks
 * the canvas builder emits, as `renderSheetGroupsWithPositions` reports them, to a `CanvasMeasure`.
 * Pure: every `positions` array here is hand-built in the order the builder emits its nodes (the
 * page-top wrappers and their end marks, then per table its block, `end` and `regionEnd`), and every
 * expected figure is worked by hand from the standard layout's geometry, which the first case pins:
 * its top margin is the repeated barcode's drawn bottom (48 + 44) plus one 4.5 pt grid step, 96.5;
 * with no page-bottom item the band's top is the page's foot, 768 (748 with the page line); the
 * usable height is the difference. Page coordinates throughout: points from the top-left, y down.
 */

const node = (id: string, page: number, top: number, left = 24): LaidOutNode => ({ id, page, left, top });

/** One table's three nodes, its block omitted when `block` is null (every column hidden). */
function tableNodes(
  key: CanvasTableKey, block: { page: number; top: number } | null,
  end: { page: number; top: number }, regionEnd: { page: number; top: number },
): LaidOutNode[] {
  return [
    ...(block === null ? [] : [node(CANVAS_IDS.table(key), block.page, block.top)]),
    node(CANVAS_IDS.end(key), end.page, end.top),
    node(CANVAS_IDS.regionEnd(key), regionEnd.page, regionEnd.top),
  ];
}

/** The standard layout printed on one page: each table's block 2.8 pt under its flow point (its top
 *  rule and cell padding), its end mark where its rows end, its region-end mark the region's height
 *  (8, 21, 8 and 68) further down. */
function onePage(): LaidOutNode[] {
  return [
    node(CANVAS_IDS.item("field-customer_name"), 1, 24, 120),
    node(CANVAS_IDS.itemEnd("field-customer_name"), 1, 33.5, 120),
    node(CANVAS_IDS.item("barcode"), 1, 48, 402),
    node(CANVAS_IDS.itemEnd("barcode"), 1, 92, 402),
    ...tableNodes("lines", { page: 1, top: 142.8 }, { page: 1, top: 190 }, { page: 1, top: 198 }),
    ...tableNodes("quantities", { page: 1, top: 200.8 }, { page: 1, top: 250 }, { page: 1, top: 271 }),
    ...tableNodes("inspections", { page: 1, top: 273.8 }, { page: 1, top: 341 }, { page: 1, top: 349 }),
    ...tableNodes("steps", { page: 1, top: 351.8 }, { page: 1, top: 470 }, { page: 1, top: 538 }),
  ];
}

/** `onePage` with every node of these tables replaced. */
function replacing(keys: CanvasTableKey[], nodes: LaidOutNode[]): LaidOutNode[] {
  const ids = new Set(keys.flatMap((key) => [CANVAS_IDS.table(key), CANVAS_IDS.end(key), CANVAS_IDS.regionEnd(key)]));
  return [...onePage().filter((n) => !ids.has(n.id)), ...nodes];
}

describe("canvasMeasure", () => {
  it("the standard layout's geometry, which every hand-worked figure below rests on", () => {
    const layout = standardLayout();
    expect(topMargin(layout)).toBe(96.5);
    expect(bandTop(layout, false)).toBe(768);
    expect(bandTop(layout, true)).toBe(748);
    expect(usableHeight(layout, false)).toBe(671.5);
    expect(usableHeight(layout, true)).toBe(651.5);
  });

  it("one page: tables start at their flow points and end at their end marks, regions end at their region-end marks, page-top items carry their end-mark heights, and an item that printed nothing is left out", () => {
    const measure = canvasMeasure(standardLayout(), false, { positions: onePage(), pages: 1 }, completeCanvas);
    expect(measure.pages).toBe(1);
    // The first table at its drawn top (the head spacer's end), each later one at the region-end
    // mark of the table above: never at its own node's top, which is under its first rule.
    expect(measure.tables).toEqual([
      { key: "lines", page: 1, top: 140, height: 50 },
      { key: "quantities", page: 1, top: 198, height: 52 },
      { key: "inspections", page: 1, top: 271, height: 70 },
      { key: "steps", page: 1, top: 349, height: 121 },
    ]);
    // Each region is its drawn height, ending at its region-end mark.
    expect(measure.regions).toEqual([
      { after: "lines", page: 1, top: 190, height: 8 },
      { after: "quantities", page: 1, top: 250, height: 21 },
      { after: "inspections", page: 1, top: 341, height: 8 },
      { after: "steps", page: 1, top: 470, height: 68 },
    ]);
    // Under the item's own id, in the layout's order. The logo and every other header field have
    // no node (here: none was laid out), so they are not in the report; nor is any below-table item.
    expect(measure.items).toEqual([
      { id: "field-customer_name", page: 1, left: 120, top: 24, height: 9.5 },
      { id: "barcode", page: 1, left: 402, top: 48, height: 44 },
    ]);
  });

  it("a table whose own node reports a later page than its flow point starts at the top margin of that page", () => {
    // The inspections region ends at 740 on page 1; the steps table's first row did not fit the 28 pt
    // left above the band (768), so pdfmake set it on page 2 under the 96.5 pt top margin.
    const positions = replacing(["inspections", "steps"], [
      ...tableNodes("inspections", { page: 1, top: 273.8 }, { page: 1, top: 732 }, { page: 1, top: 740 }),
      ...tableNodes("steps", { page: 2, top: 99.3 }, { page: 2, top: 300 }, { page: 2, top: 368 }),
    ]);
    const measure = canvasMeasure(standardLayout(), false, { positions, pages: 2 }, completeCanvas);
    expect(measure.pages).toBe(2);
    expect(measure.tables.find((t) => t.key === "steps")).toEqual({ key: "steps", page: 2, top: 96.5, height: 203.5 });
    expect(measure.regions.find((r) => r.after === "steps")).toEqual({ after: "steps", page: 2, top: 300, height: 68 });
  });

  it("a table that ends two pages after it starts spans the rest of its first page, a whole usable middle page and the top of its last (with the page line)", () => {
    // Steps from (1, 349) to an end mark at (3, 200): (748 − 349) + 1 × 651.5 + (200 − 96.5) = 1154.
    const positions = replacing(["steps"], tableNodes("steps", { page: 1, top: 351.8 }, { page: 3, top: 200 }, { page: 3, top: 268 }));
    const measure = canvasMeasure(standardLayout(), true, { positions, pages: 3 }, completeCanvas);
    expect(measure.pages).toBe(3);
    expect(measure.tables.find((t) => t.key === "steps")).toEqual({ key: "steps", page: 1, top: 349, height: 1154 });
    expect(measure.regions.find((r) => r.after === "steps")).toEqual({ after: "steps", page: 3, top: 200, height: 68 });
  });

  it("a region that moved whole to the next page reports that page, and the table above ends where its end mark is", () => {
    // Inspections ends at 760 on page 1, too low for its 8 pt region (the band's top is 768), which
    // moved whole to page 2 and ends 8 pt under the top margin; steps starts there.
    const positions = replacing(["inspections", "steps"], [
      ...tableNodes("inspections", { page: 1, top: 273.8 }, { page: 1, top: 760 }, { page: 2, top: 104.5 }),
      ...tableNodes("steps", { page: 2, top: 107.3 }, { page: 2, top: 230 }, { page: 2, top: 298 }),
    ]);
    const measure = canvasMeasure(standardLayout(), false, { positions, pages: 2 }, completeCanvas);
    expect(measure.tables.find((t) => t.key === "inspections")).toEqual({ key: "inspections", page: 1, top: 271, height: 489 });
    expect(measure.regions.find((r) => r.after === "inspections")).toEqual({ after: "inspections", page: 2, top: 96.5, height: 8 });
    expect(measure.tables.find((t) => t.key === "steps")).toEqual({ key: "steps", page: 2, top: 104.5, height: 125.5 });
  });

  it("a table whose block was omitted (every column hidden) measures 0 tall at its flow point, and its region still follows", () => {
    const positions = replacing(["lines", "quantities"], [
      ...tableNodes("lines", null, { page: 1, top: 140 }, { page: 1, top: 148 }),
      ...tableNodes("quantities", { page: 1, top: 150.8 }, { page: 1, top: 200 }, { page: 1, top: 221 }),
    ]);
    const measure = canvasMeasure(standardLayout(), false, { positions, pages: 1 }, completeCanvas);
    expect(measure.tables.slice(0, 2)).toEqual([
      { key: "lines", page: 1, top: 140, height: 0 },
      { key: "quantities", page: 1, top: 148, height: 52 },
    ]);
    expect(measure.regions[0]).toEqual({ after: "lines", page: 1, top: 140, height: 8 });
  });

  it("a table the belt added (a key the stored layout lacks) is not reported, and the stored tables' regions keep the printed geometry", () => {
    // A stored layout without its steps table (only past the validator): the builder prints the
    // belt's steps table 8 pt under the inspections table's drawn bottom, so the inspections region
    // it printed is 8 pt tall, not the stored layout's 0.
    const stored = layoutOf(standardLayout().items.filter((item) => !(item.kind === "table" && item.key === "steps")));
    const measure = canvasMeasure(stored, false, { positions: onePage(), pages: 1 }, completeCanvas);
    expect(measure.tables.map((t) => t.key)).toEqual(["lines", "quantities", "inspections"]);
    expect(measure.regions.map((r) => r.after)).toEqual(["lines", "quantities", "inspections"]);
    expect(measure.regions[2]).toEqual({ after: "inspections", page: 1, top: 341, height: 8 });
  });
});

describe("canvasMeasure: a page-top item's placed box", () => {
  it("reports the box its wrapper was placed at, its stored x and y, and the extent from that y to its end mark, never the wrapper's own position (a boxed cell's first line, inside its rule and padding)", () => {
    const positions = onePage().map((n) => (n.id === CANVAS_IDS.item("field-customer_name") ? node(n.id, 1, 26.8, 124.8) : n));
    const measure = canvasMeasure(standardLayout(), false, { positions, pages: 1 }, completeCanvas);
    expect(measure.items.find((item) => item.id === "field-customer_name")).toEqual(
      { id: "field-customer_name", page: 1, left: 120, top: 24, height: 9.5 },
    );
  });

  it("places a page-top item on page 1 at its stored y even when pdfmake pushed its first line to a later page: the entry says page 1 and its height spans the pages to the end mark (Ruling 14)", () => {
    const layout = standardLayout();
    const box = layout.items.find((item) => item.id === "field-customer_name")!.box;
    const T = 40;
    const positions = onePage().map((n) => {
      if (n.id === CANVAS_IDS.item("field-customer_name")) return node(n.id, 2, 30, 120);
      if (n.id === CANVAS_IDS.itemEnd("field-customer_name")) return node(n.id, 2, T, 120);
      return n;
    });
    const measure = canvasMeasure(layout, false, { positions, pages: 2 }, completeCanvas);
    const margin = topMargin(layout);
    const band = bandTop(layout, false);
    expect(measure.items.find((item) => item.id === "field-customer_name")).toEqual(
      { id: "field-customer_name", page: 1, left: box.x, top: box.y, height: (band - box.y) + (T - margin) },
    );
  });
});

describe("mergeAloneMeasure", () => {
  /** A text item, page-bottom unless told otherwise. */
  const text = (id: string, y: number, repeat = false): CanvasItem => ({
    id, kind: "text", text: "Signed", box: { x: 300, y, w: 200, h: 12 },
    anchor: { kind: "page-bottom" }, repeat, style: { size: 8, bold: false, align: "left" },
  });
  /** The standard layout with two band items: `sig` on the last page, `every` repeated. */
  const layout = layoutOf([...standardLayout().items, text("sig", 700), text("every", 720, true)]);
  /** A sheet's measure holding one page-top item, the Quantities region on page 1 and the Steps
   *  region moved to page 2. */
  const sheet = (): CanvasMeasure => ({
    pages: 3,
    tables: [],
    regions: [
      { after: "quantities", page: 1, top: 250, height: 21 },
      { after: "steps", page: 2, top: 100, height: 68 },
    ],
    items: [{ id: "barcode", page: 1, left: 402, top: 48, height: 44 }],
  });
  /** The alone renders, each item's wrapper 2.8 pt under its placed offset (a boxed cell's first
   *  line), as an auto-height page reports them: everything on page 1. */
  const alone = [
    { after: "quantities", positions: [
      node(CANVAS_IDS.item("field-process"), 1, 7.3, 28.8),
      node(CANVAS_IDS.itemEnd("field-process"), 1, 16.3, 28.8),
      // The material field's end mark is missing: it is left out.
      node(CANVAS_IDS.item("field-material"), 1, 7.3, 218.8),
    ] },
    { after: "steps", positions: [
      node(CANVAS_IDS.item("field-results"), 1, 10.8, 28.8),
      node(CANVAS_IDS.itemEnd("field-results"), 1, 60.8, 28.8),
    ] },
    { after: "band", positions: [
      node(CANVAS_IDS.item("sig"), 1, 0, 300),
      node(CANVAS_IDS.itemEnd("sig"), 1, 30, 300),
      node(CANVAS_IDS.item("every"), 1, 20, 300),
      node(CANVAS_IDS.itemEnd("every"), 1, 32, 300),
    ] },
  ];

  it("places a below-table item at its region's top plus its offset, on the region's page, a band item at its own y on the last page (page 1 when it repeats), each as tall as its end mark lies below its placed offset", () => {
    const measure = sheet();
    const before = structuredClone(measure);
    const merged = mergeAloneMeasure(measure, layout, false, alone);
    expect(merged.items).toEqual([
      { id: "barcode", page: 1, left: 402, top: 48, height: 44 },
      // The process field's offset is one grid step (4.5) under Quantities' region top (250).
      // Each height runs from the offset the wrapper was placed at, not from the wrapper's own top
      // (its first line, 2.8 pt lower): the process field 16.3 − 4.5, the Results box 60.8 − 8.
      { id: "field-process", page: 1, left: 24, top: 254.5, height: 11.8 },
      // The Results box 8 pt under the Steps region, which moved to page 2.
      // The band's top is 700 (the higher band item's y): `sig` placed at 0, `every` at 20.
      { id: "field-results", page: 2, left: 24, top: 108, height: 52.8 },
      { id: "sig", page: 3, left: 300, top: 700, height: 30 },
      { id: "every", page: 1, left: 300, top: 720, height: 12 },
    ]);
    expect(merged.tables).toEqual(measure.tables);
    expect(merged.regions).toEqual(measure.regions);
    expect(merged.pages).toBe(3);
    // A new measure: the one passed in is untouched.
    expect(merged).not.toBe(measure);
    expect(measure).toEqual(before);
  });

  it("leaves out the items of a region the measure does not hold", () => {
    const measure = { ...sheet(), regions: sheet().regions.filter((r) => r.after !== "quantities") };
    const ids = mergeAloneMeasure(measure, layout, false, alone).items.map((item) => item.id);
    expect(ids).toEqual(["barcode", "field-results", "sig", "every"]);
  });
});
