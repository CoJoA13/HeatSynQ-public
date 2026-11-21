import { describe, it, expect } from "vitest";
import type { Content } from "pdfmake/interfaces";
import {
  buildTravelerDefinition, buildTravelerDefinitions, type TravelerData,
} from "@/server/traveler";
import { CANVAS_IDS } from "@/server/traveler-canvas";
import { canvasBlockOf } from "@/server/pdf/canvas-nodes";
import {
  LAYOUT, barcodePng, pngDataUri, renderPdf, renderSheetGroups, renderSheetGroupsWithPositions,
  type LaidOutNode, type RenderableDefinition,
} from "@/server/pdf/render";
import { TRAVELER_DEFAULT_CONFIG, validateConfig, type TemplateConfig } from "@/lib/template-contracts/index";
import { bandHeight, continuedBox, regionHeights, topMargin } from "@/lib/template-canvas";
import type { CanvasItem, CanvasLayout, CanvasTableKey } from "@/lib/template-contracts/canvas";
import { barcode, layoutOf, standardLayout, table } from "./helpers/canvas-fixtures";
import { bandClipLayout, expectBandClip } from "./helpers/band-clip";
import {
  drawnPages, drawnText, pageCount, pageStreams, paintedImageCounts, paintedImages, parseObjects, strokedLines, textLinesWithY, textRunsWithY, tinyAlphaPng,
} from "./helpers/pdf";

/**
 * The traveler canvas's builder, part 1 (PR B of #926, task 3): positioned field and text items,
 * the tables flowing at their drawn places and widths, and the float regions riding each table's
 * rendered bottom (design 2026-11-07 §5.2). Pure: no database; every case renders through
 * `renderSheetGroupsWithPositions` and reads the bytes with the house readers.
 *
 * COORDINATES. The positions `renderSheetGroupsWithPositions` answers, and the layout's boxes, are
 * PAGE coordinates: points from the page's top-left corner, y growing down. `strokedLines` is in
 * the same top-down frame. `textLinesWithY` reports a line's BASELINE in PDF device space, y from
 * the page's BOTTOM edge; each case that reads it converts with `PAGE_HEIGHT − y` and says so.
 *
 * Part 2 (task 4) adds the repeat band, the page-bottom band, the logo, the barcode and the static
 * line and box items: the last describe block below.
 */

const PAGE_HEIGHT = 792;
const BARCODE = pngDataUri(await barcodePng("91246"));

/** A hand-built, DB-free TravelerData (tests/traveler-templates.test.ts's shape) with `steps` steps. */
function travelerData(steps = 1, overrides: Partial<TravelerData> = {}): TravelerData {
  return {
    orderNumber: 91246,
    poNumber: "",
    customerName: "Demo Castings Group",
    receivedFrom: ["200 Demo Drive", "Anniston, AL 36206"],
    customerPhone: "",
    company: { name: "Example Heat Treating", address: "1 Furnace Rd", phone: "256-555-0101" },
    lines: [{
      qty: 4500, partNumber: "DEMO-PL-2001", partName: "U Bolt Rear Spr Plate",
      description: "Machined", eachWeight: 13.5, lineWeight: 60750,
    }],
    orderQty: 4500,
    containers: [{ typeName: "Drop Pan", count: 8, pieces: 320, tareEach: 367 }],
    materialName: "Ductile Iron",
    processId: "DEMO-PL-2001",
    inspections: [{ code: "Hardness", scale: "HBW", min: 269, max: 341, sampleQty: "8", location: "flange OD" }],
    revisionNumber: 1,
    steps: Array.from({ length: steps }, (_, i) => ({
      position: i + 1, codeName: "Austemper", instruction: "Pre-heat to 1100F.",
      values: [{ label: "Furnace Temp", value: "1650", unit: "°F" }],
    })),
    sheets: [{ loadNumber: 1, loadQty: 336, loadWeight: 4536, barcodeDataUri: BARCODE }],
    processName: "Austemper",
    ...overrides,
  };
}

/** The default config with `layout` set, through the real validator: every layout a case renders is
 *  one a template could store. */
const cfg = (layout: CanvasLayout): TemplateConfig =>
  validateConfig("TRAVELER", { ...structuredClone(TRAVELER_DEFAULT_CONFIG), layout });

async function render(data: TravelerData, layout: CanvasLayout, options: { pageFooter?: boolean; logoDataUri?: string } = {}) {
  const config = { ...cfg(layout), ...(options.pageFooter ? { pageFooter: true } : {}) };
  const defs = buildTravelerDefinitions(data, config, options.logoDataUri);
  const { pdf, groups } = await renderSheetGroupsWithPositions(defs);
  return { pdf, defs, group: groups[0] };
}

/** The laid-out node under an id, which the case requires. */
function at(group: { positions: LaidOutNode[] }, id: string): LaidOutNode {
  const found = group.positions.find((node) => node.id === id);
  if (found === undefined) throw new Error(`no laid-out node "${id}"`);
  return found;
}

/** A layout's item with this id, replaced. */
function withItem(layout: CanvasLayout, id: string, change: (item: CanvasItem) => CanvasItem): CanvasLayout {
  return layoutOf(layout.items.map((item) => (item.id === id ? change(item) : item)));
}

/** Every node under `node`, at any depth, whose `layout` is `layout`. */
function withLayout(node: unknown, layout: unknown): Record<string, unknown>[] {
  if (node === null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((child) => withLayout(child, layout));
  const own = node as Record<string, unknown>;
  return [...(own.layout === layout ? [own] : []), ...Object.values(own).flatMap((child) => withLayout(child, layout))];
}

const heightOf = (layout: CanvasLayout, key: CanvasTableKey) =>
  regionHeights(layout).find((region) => region.after === key)!.height;

const ORDER: CanvasTableKey[] = ["lines", "quantities", "inspections", "steps"];

/** How many rectangles the document STROKES: each `re` whose path is painted by a stroking
 *  operator (`S`, `s`, `B`, `B*`, `b`, `b*`) rather than a fill alone. `strokedLines` reads `m`/`l`
 *  segments only, and a canvas `rect` is an `re`, so this is the reader that sees a mark or spacer
 *  drawn without its fill colour: pdfmake strokes a vector that names no colour. */
function strokedRects(pdf: Buffer): number {
  const PAINT = new Set(["S", "s", "B", "B*", "b", "b*", "f", "F", "f*", "n"]);
  const STROKE = new Set(["S", "s", "B", "B*", "b", "b*"]);
  let count = 0;
  for (const obj of parseObjects(pdf).values()) {
    // Content streams only: a font's or an image's binary could hold a stray `re` and `S` by chance.
    if (obj.stream === null || /\/(Length1|Subtype|FontFile|Type\s*\/XObject)/.test(obj.body)) continue;
    let open = false;
    for (const token of obj.stream.toString("latin1").split(/\s+/)) {
      if (token === "re") open = true;
      else if (open && PAINT.has(token)) {
        if (STROKE.has(token)) count++;
        open = false;
      }
    }
  }
  return count;
}

/** Where each table starts in the flow: the spacer's end for the first (its drawn top on page 1),
 *  the region-end mark of the table above for the rest. */
function starts(group: { positions: LaidOutNode[] }, layout: CanvasLayout): Map<CanvasTableKey, LaidOutNode> {
  const out = new Map<CanvasTableKey, LaidOutNode>();
  ORDER.forEach((key, i) => {
    const drawn = layout.items.find((item) => item.kind === "table" && item.key === key)!.box;
    out.set(key, i === 0
      ? { id: "start", page: 1, left: drawn.x, top: drawn.y }
      : at(group, CANVAS_IDS.regionEnd(ORDER[i - 1])));
  });
  return out;
}

describe("buildCanvasTravelerDefinitions: items, tables, regions", () => {
  it("prints every page-top field at its drawn position on page 1 and every table at its drawn top, in y order", async () => {
    // A table is as tall as its rows need (§4.3), so a table drawn taller than it prints pulls the
    // tables under it up. First the float rule on the standard layout: each table starts at the
    // table above's rendered bottom plus the drawn gap between the two (page coordinates).
    const standard = standardLayout();
    const first = await render(travelerData(1), standard);
    const begin = starts(first.group, standard);
    const rendered = new Map<CanvasTableKey, number>();
    for (const [i, key] of ORDER.entries()) {
      const end = at(first.group, CANVAS_IDS.end(key));
      expect(end.page).toBe(1);
      rendered.set(key, end.top - begin.get(key)!.top);
      if (i > 0) {
        const above = ORDER[i - 1];
        expect(begin.get(key)!.top - at(first.group, CANVAS_IDS.end(above)).top).toBeCloseTo(heightOf(standard, above), 6);
      }
    }

    // Then the same layout with each table drawn exactly as tall as it printed (steps, the last,
    // moves nothing): every table starts at its drawn top, 140, 188, 261 and 339.
    let fitted = standard;
    for (const key of ["lines", "quantities", "inspections"] as const) {
      fitted = withItem(fitted, `table-${key}`, (item) => ({ ...item, box: { ...item.box, h: rendered.get(key)! } }));
    }
    const { pdf, group } = await render(travelerData(1), fitted);
    expect(pageCount(pdf)).toBe(1);
    const drawnTops: Record<CanvasTableKey, number> = { lines: 140, quantities: 188, inspections: 261, steps: 339 };
    const begun = starts(group, fitted);
    let previous = -Infinity;
    for (const key of ORDER) {
      expect(Math.abs(begun.get(key)!.top - drawnTops[key])).toBeLessThan(2);
      // The table's own node reports its first laid-out line, under its top rule (0.8) and its cell
      // padding (2): within 2.8 pt below the drawn top, page coordinates, on page 1.
      const own = at(group, CANVAS_IDS.table(key));
      expect(own.page).toBe(1);
      expect(own.top - drawnTops[key]).toBeGreaterThan(-0.01);
      expect(own.top - drawnTops[key]).toBeLessThan(2.81);
      expect(own.top).toBeGreaterThan(previous);
      previous = own.top;
    }

    // Every page-top field that prints: its wrapper at its box's top-left on page 1, exactly.
    for (const item of fitted.items) {
      if (item.kind !== "field" || item.anchor.kind !== "page-top") continue;
      if (item.key === "customer_phone") continue; // an empty phone prints nothing, as the flow's
      const node = at(group, CANVAS_IDS.item(item.id));
      expect(node).toMatchObject({ page: 1, left: item.box.x, top: item.box.y });
    }
    // The customer name's printed line: its baseline (device y from the bottom, so PAGE_HEIGHT − y
    // in page coordinates) lies within its item, under the box's top and above the item's end mark.
    const name = fitted.items.find((item) => item.id === "field-customer_name")!;
    const end = at(group, CANVAS_IDS.itemEnd(name.id));
    const line = textLinesWithY(pdf)[0].find((l) => l.text.startsWith("Demo Castings Group"))!;
    expect(line).toBeDefined();
    expect(PAGE_HEIGHT - line.y).toBeGreaterThan(name.box.y);
    expect(PAGE_HEIGHT - line.y).toBeLessThan(end.top);
    expect(end.top - name.box.y).toBeLessThan(name.box.h); // one 8 pt line inside a 12 pt box
  });

  it("floats: with 3, 10 and 30 steps the results item prints at its offset below the steps table's rendered bottom, on the page where the table ends", async () => {
    const layout = standardLayout();
    const results = layout.items.find((item) => item.id === "field-results")!;
    const regionHeight = heightOf(layout, "steps");

    // The control: the same RESULTS box drawn page-top at y 600 gives the label's baseline offset
    // under its box's top (the boxed rule, the cell padding and the font's ascent), so the region's
    // label is asserted against its box's top without font arithmetic.
    const CONTROL_Y = 600;
    const control = withItem(layout, results.id, (item) => ({ ...item, anchor: { kind: "page-top" }, box: { ...item.box, y: CONTROL_Y } }));
    const controlPdf = (await render(travelerData(1), control)).pdf;
    const controlLine = textLinesWithY(controlPdf)[0].find((l) => l.text.startsWith("RESULTS:"))!;
    const labelOffset = PAGE_HEIGHT - controlLine.y - CONTROL_Y;
    expect(labelOffset).toBeGreaterThan(0);
    expect(labelOffset).toBeLessThan(14);

    for (const [steps, page] of [[3, 1], [10, 1], [30, 2]] as const) {
      const { pdf, group } = await render(travelerData(steps), layout);
      const end = at(group, CANVAS_IDS.end("steps"));
      const regionEnd = at(group, CANVAS_IDS.regionEnd("steps"));
      expect(end.page).toBe(page);
      expect(regionEnd.page).toBe(page);
      const regionTop = regionEnd.top - regionHeight;
      expect(regionTop).toBeCloseTo(end.top, 6);
      // The label's baseline, device y converted to page coordinates, at the region's top plus the
      // item's stored offset plus the control's label offset.
      const lines = textLinesWithY(pdf)[page - 1].filter((l) => l.text.startsWith("RESULTS:"));
      expect(lines).toHaveLength(1);
      expect(Math.abs(PAGE_HEIGHT - lines[0].y - (regionTop + results.box.y + labelOffset))).toBeLessThan(2);
      // And no other page carries it.
      expect(textLinesWithY(pdf).flat().filter((l) => l.text.startsWith("RESULTS:"))).toHaveLength(1);
    }
  });

  it("a region moves whole: a tail region taller than the page's remainder starts at the next page's top margin", async () => {
    const base = standardLayout();
    const steps = 12;
    // Where the steps table ends on page 1 with the standard footer (page coordinates).
    const probe = await render(travelerData(steps), base);
    const end = at(probe.group, CANVAS_IDS.end("steps"));
    expect(end.page).toBe(1);
    const remainder = PAGE_HEIGHT - 24 - end.top;
    // A tail text item whose bottom lies 20 pt past the page's remainder: the region is taller than
    // what is left of page 1, and far under a page.
    const tailOffset = remainder + 20 - 12;
    const layout = layoutOf([
      ...base.items,
      {
        id: "tail", kind: "text", text: "TAIL NOTE", style: { size: 8, bold: false, align: "left" },
        box: { x: 24, y: tailOffset, w: 200, h: 12 }, anchor: { kind: "below-table", table: "steps" }, repeat: false,
      },
    ]);
    const regionHeight = heightOf(layout, "steps");
    expect(regionHeight).toBeGreaterThan(remainder);

    const { pdf, group } = await render(travelerData(steps), layout);
    expect(at(group, CANVAS_IDS.end("steps"))).toMatchObject({ page: 1, top: end.top });
    const regionEnd = at(group, CANVAS_IDS.regionEnd("steps"));
    expect(regionEnd.page).toBe(2);
    expect(regionEnd.top).toBeCloseTo(topMargin(layout) + regionHeight, 6);
    // The region's items moved with it: the footer's RESULTS and the tail note print on page 2 only.
    const pages = textLinesWithY(pdf);
    expect(pages).toHaveLength(2);
    for (const text of ["RESULTS:", "TAIL NOTE"]) {
      expect(pages[0].some((l) => l.text.startsWith(text))).toBe(false);
      expect(pages[1].some((l) => l.text.startsWith(text))).toBe(true);
    }
  });

  it("a table narrower than the page fills exactly its drawn width: the lines table drawn at x 100, w 300 has its outer rules at 100 and 400 (strokedLines) on every page it takes", async () => {
    // The three fixed columns at 50 pt each, so the "*" column (the part identity) has room for its
    // widest word: the default 78 + 78 + 88 and their padding leave it under one word in 300 pt,
    // and pdfmake widens a "*" column to its widest word, past the table's width.
    const layout = withItem(standardLayout(), "table-lines", (item) => item.kind !== "table" ? item : {
      ...item, box: { ...item.box, x: 100, w: 300 },
      columns: item.columns.map((column) => (column.key === "line_part" ? column : { ...column, width: 50 })),
    });
    const many = Array.from({ length: 70 }, (_, i) => ({
      qty: 10 + i, partNumber: `DEMO-${i}`, partName: "Ring gear", description: "Machined", eachWeight: 1, lineWeight: 10 + i,
    }));
    const { pdf, group } = await render(travelerData(1, { lines: many }), layout);
    const start = at(group, CANVAS_IDS.table("lines"));
    const end = at(group, CANVAS_IDS.end("lines"));
    expect(end.page).toBeGreaterThan(start.page); // the table takes two pages
    const strokes = strokedLines(pdf);
    for (let page = start.page; page <= end.page; page++) {
      // The ruled layout draws horizontal rules only, one segment a cell. In the stroke stream's
      // own top-down coordinates, the table's segments on this page (those between its top, or the
      // page's top, and its end, or the page's bottom) span x 100 to x 400 and no further.
      const from = page === start.page ? start.top - 3 : 0;
      const to = page === end.page ? end.top + 0.5 : PAGE_HEIGHT;
      const rules = strokes[page - 1].filter((s) => s.y1 === s.y2 && s.y1 >= from && s.y1 <= to);
      expect(rules.length).toBeGreaterThan(8);
      expect(Math.min(...rules.map((s) => s.x1))).toBeCloseTo(100, 1);
      expect(Math.max(...rules.map((s) => s.x2))).toBeCloseTo(400, 1);
    }
  });

  it("mark() and spacer() ink nothing: a canvas with no line or box items strokes exactly the tables' own lines and rectangles, and paints the barcode alone (paintedImageCounts [1] against the tables' [0])", async () => {
    // Tables and plain text fields only: no hand-written box, checkbox, line or box item draws a
    // stroke. The barcode is the one image the control lacks.
    const layout = layoutOf(standardLayout().items.filter((item) =>
      item.kind === "table" || (item.kind === "field" && item.anchor.kind === "page-top")
      || item.kind === "barcode"));
    const { pdf, defs, group } = await render(travelerData(3), layout);
    expect(pageCount(pdf)).toBe(1);
    // The steps table's region is empty (height 0, no item), so it is omitted, and its region-end
    // mark is still there, at the table's end: its region's top is regionEnd.top − 0.
    expect(heightOf(layout, "steps")).toBe(0);
    const stepsEnd = at(group, CANVAS_IDS.end("steps"));
    expect(at(group, CANVAS_IDS.regionEnd("steps"))).toMatchObject({ page: stepsEnd.page, top: stepsEnd.top });
    // The control: the same definition holding the four table blocks alone, at the same margins.
    const tablesOnly: RenderableDefinition = {
      ...defs[0],
      content: (defs[0].content as Content[]).filter((node) =>
        typeof (node as { id?: unknown }).id === "string" && (node as { id: string }).id.startsWith("canvas:table:")),
    };
    expect((tablesOnly.content as Content[])).toHaveLength(4);
    const controlPdf = await renderSheetGroups([JSON.parse(JSON.stringify(tablesOnly)) as RenderableDefinition]);
    // Each stroke by its x extent, its length down the page and its weight: the canvas sets the
    // tables lower than the control does, so y alone may differ.
    const shape = (p: Buffer) => strokedLines(p).map((page) =>
      page.map((s) => `${s.x1}|${s.x2}|${(s.y2 - s.y1).toFixed(3)}|${s.width}`).sort());
    expect(shape(pdf)).toEqual(shape(controlPdf));
    expect(strokedRects(pdf)).toBe(strokedRects(controlPdf));
    expect(paintedImageCounts(controlPdf)).toEqual([0]);
    expect(paintedImageCounts(pdf)).toEqual([1]);
  });

  it("a table with every column hidden prints no block and keeps its marks: the table under it starts at the drawn gap from its drawn bottom", async () => {
    // The validator accepts it (only a locked column may not be hidden; every lines column is
    // removable), so the builder must print it: the flow's linesTable answers null, as the flow path
    // omits such a section, and the canvas prints no block in its place.
    const layout = withItem(standardLayout(), "table-lines", (item) => item.kind !== "table" ? item : {
      ...item, columns: item.columns.map((column) => ({ ...column, visible: false })),
    });
    const { pdf, group } = await render(travelerData(1), layout);
    const text = drawnText(pdf);
    expect(text).not.toContain("Part Quantity");
    expect(text).not.toContain("U Bolt Rear Spr Plate");
    expect(group.positions.some((node) => node.id === CANVAS_IDS.table("lines"))).toBe(false);
    // Page coordinates: the missing table takes no height, so its end mark is where it would have
    // started (its drawn top, the spacer's end), and its region is the drawn gap to the next table.
    const end = at(group, CANVAS_IDS.end("lines"));
    const regionEnd = at(group, CANVAS_IDS.regionEnd("lines"));
    expect(end).toMatchObject({ page: 1, top: 140 });
    expect(regionEnd.page).toBe(1);
    expect(regionEnd.top - end.top).toBeCloseTo(heightOf(layout, "lines"), 6);
    // The quantities table starts at that region's end: its own node's first line within its top rule
    // and cell padding (0.8 + 2) below it.
    const quantities = at(group, CANVAS_IDS.table("quantities"));
    expect(quantities.page).toBe(1);
    expect(quantities.top - regionEnd.top).toBeGreaterThan(-0.01);
    expect(quantities.top - regionEnd.top).toBeLessThan(2.81);
  });

  it("a template with layout null renders exactly the flow path (drawnText equal to buildTravelerDefinition's)", async () => {
    const config = validateConfig("TRAVELER", structuredClone(TRAVELER_DEFAULT_CONFIG));
    expect(config.layout).toBeNull();
    const data = travelerData(3);
    const defs = buildTravelerDefinitions(data, config);
    expect(JSON.stringify(defs)).not.toContain("canvas:");
    const flow = await renderSheetGroups(defs);
    const single = await renderPdf(buildTravelerDefinition(data, config));
    expect(drawnText(flow)).toBe(drawnText(single));
  });

  it("the definitions are pure JSON (no functions), one per sheet, each steps table carrying canvasWidth", async () => {
    const layout = withItem(standardLayout(), "table-steps", (item) => ({ ...item, box: { ...item.box, x: 60, w: 500 } }));
    const sheets = [1, 2, 3].map((n) => ({ loadNumber: n, loadQty: 112, loadWeight: 1512, barcodeDataUri: BARCODE }));
    const defs = buildTravelerDefinitions(travelerData(3, { sheets }), cfg(layout));
    expect(defs).toHaveLength(3);
    expect(JSON.parse(JSON.stringify(defs))).toEqual(defs);
    for (const def of defs) {
      // The steps block in the one canvas block shape (#969): the id on the wrapper, the lateral
      // margin on its columns node, and the steps table inside, carrying the drawn width and no id.
      const wrappers = (def.content as Content[]).filter((node) => (node as { id?: unknown }).id === CANVAS_IDS.table("steps"));
      expect(wrappers).toHaveLength(1);
      const block = canvasBlockOf(wrappers[0]);
      expect(block).not.toBeNull();
      expect([block!.left, block!.right]).toEqual([36, 28]);
      const steps = withLayout(def.content, LAYOUT.steps);
      expect(steps).toHaveLength(1);
      expect(steps[0]).toBe(block!.inner);
      expect(steps[0]).toMatchObject({ layout: LAYOUT.steps, canvasWidth: 500, margin: [0, 0, 0, 0] });
      expect(steps[0]).not.toHaveProperty("id");
    }
    // Each sheet its own nodes: pdfmake decorates what it lays out, so no two definitions share one.
    expect(defs[0].content).not.toBe(defs[1].content);
    expect((defs[0].content as Content[])[0]).not.toBe((defs[1].content as Content[])[0]);
    // The three sheets render as three groups, each its own load.
    const { groups } = await renderSheetGroupsWithPositions(defs);
    expect(groups).toHaveLength(3);
  });
});

/** Every STROKED rectangle per page: `x y w h re`, then pdfkit's colour and graphics-state
 *  operators, then the paint operator on its own line, kept when that is a stroke (`S`), with the
 *  `w` line width set before it, in the stream's top-down page coordinates. A canvas `rect` with
 *  no colour prints this way; `strokedLines` reads `m`/`l` segments only. */
function strokedRectBoxes(pdf: Buffer): { x: number; y: number; w: number; h: number; width: number }[][] {
  return pageStreams(pdf).map((stream) => {
    const out: { x: number; y: number; w: number; h: number; width: number }[] = [];
    const op = /([\d.]+) w\n|(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re\n(?:(?!re\n)[\s\S])*?\n(S|s|f\*?|F|B\*?|b\*?|n)\n/g;
    let width: number | null = null;
    for (const m of stream.matchAll(op)) {
      if (m[1] !== undefined) width = Number(m[1]);
      else if (m[6] === "S" && width !== null) {
        out.push({ x: Number(m[2]), y: Number(m[3]), w: Number(m[4]), h: Number(m[5]), width });
      }
    }
    return out;
  });
}

/** The standard layout with the order and load numbers repeated, drawn side by side over the
 *  barcode, so the barcode stays the lowest repeated item and "(continued)" prints at the band's
 *  bottom-left, level with the barcode's bottom (`continuedBox`: 24, 82, 60, 10; Ruling 16). */
function repeatedNumbers(): CanvasLayout {
  return layoutOf(standardLayout().items.map((item) =>
    item.kind === "field" && item.key === "order_number" ? { ...item, repeat: true, box: { x: 402, y: 24, w: 90, h: 12 } }
      : item.kind === "field" && item.key === "load_number" ? { ...item, repeat: true, box: { x: 498, y: 24, w: 90, h: 12 } }
        : item));
}

/** The standard layout with its footer fields moved into a page-bottom band: three rows at `top`,
 *  `top + 24` and `top + 48`, each 12 tall (the band is `foot − top`). */
function banded(top: number, repeat = false): CanvasLayout {
  return layoutOf(standardLayout().items.map((item) => {
    if (item.kind !== "field" || item.anchor.kind !== "below-table" || item.anchor.table !== "steps") return item;
    return { ...item, anchor: { kind: "page-bottom" }, repeat: repeat && item.key === "results", box: { ...item.box, y: top + (item.box.y - 8) } };
  }));
}

/** The printed lines holding `text`, each baseline in TOP-DOWN page coordinates (`textLinesWithY`
 *  reports device y from the bottom; PAGE_HEIGHT − y converts). A line is every run on one
 *  baseline joined with no separator, so items side by side share one line ("912461" is the order
 *  number beside the load number). */
function linesWith(pdf: Buffer, text: string): { page: number; top: number; text: string }[] {
  return textLinesWithY(pdf).flatMap((lines, i) => lines
    .filter((line) => line.text.includes(text))
    .map((line) => ({ page: i + 1, top: PAGE_HEIGHT - line.y, text: line.text })));
}

describe("buildCanvasTravelerDefinitions: bands, logo, barcode, statics", () => {
  it("a 30-step sheet repeats the order number, load number and barcode on page 2 at their drawn positions, prints '(continued)' at the band's bottom-left on page 2 only, and nothing else of page 1's header", async () => {
    const layout = repeatedNumbers();
    expect(topMargin(layout)).toBe(96.5);
    const continued = continuedBox(layout)!;
    expect(continued).toEqual({ x: 24, y: 82, w: 60, h: 10 });
    const { pdf, defs } = await render(travelerData(30), layout);
    expect(pageCount(pdf)).toBe(2);
    // The repeat band is single-pass: no overflowTopMargin, the definition's own top margin.
    expect(defs[0].continuationHeaderSpec).toBeDefined();
    expect(defs[0].continuationHeaderSpec!.overflowTopMargin).toBeUndefined();
    expect((defs[0].pageMargins as number[])[1]).toBe(96.5);

    // The two numbers print on both pages on the same baselines (top-down page coordinates).
    const numbers = linesWith(pdf, "91246");
    // Page 1's line also holds the received-from address on the same baseline, left of the numbers.
    expect(numbers.map((line) => line.page)).toEqual([1, 2]);
    for (const line of numbers) expect(line.text.endsWith("912461")).toBe(true);
    expect(numbers[1].top).toBeCloseTo(numbers[0].top, 1);
    const labels = linesWith(pdf, "Order NumberLoad");
    expect(labels.map((line) => line.page)).toEqual([1, 2]);
    expect(labels[1].top).toBeCloseTo(labels[0].top, 1);
    // The barcode: one image a page, drawn at its box on both (top-down page coordinates).
    expect(paintedImageCounts(pdf)).toEqual([1, 1]);
    for (const images of paintedImages(pdf)) {
      expect(images).toHaveLength(1);
      expect(images[0].x).toBeCloseTo(402, 1);
      expect(images[0].y).toBeCloseTo(48, 1);
      expect(images[0].w).toBeCloseTo(186, 1);
      expect(images[0].h).toBeCloseTo(44, 1);
    }
    // "(continued)": page 2 only, its baseline inside its box, at the left margin, the box's bottom
    // level with the barcode's (92), and left of every repeated item (the leftmost starts at 402).
    const word = linesWith(pdf, "(continued)");
    expect(word).toHaveLength(1);
    expect(word[0].page).toBe(2);
    expect(word[0].top).toBeGreaterThan(continued.y);
    expect(word[0].top).toBeLessThanOrEqual(continued.y + continued.h);
    expect(continued.y + continued.h).toBe(48 + 44);
    const run = textRunsWithY(pdf)[1].find((r) => r.text.includes("(continued)"))!;
    expect(run.x).toBeCloseTo(24, 1);
    for (const item of layout.items) {
      if (item.kind === "table" || !item.repeat || item.anchor.kind !== "page-top") continue;
      expect(item.box.x, item.id).toBeGreaterThanOrEqual(continued.x + continued.w);
    }
    // Nothing else of page 1's header: not the customer, the company, the PO or the process row.
    const [page1, page2] = textLinesWithY(pdf).map((lines) => lines.map((line) => line.text).join("\n"));
    for (const absent of ["Demo Castings Group", "Example Heat Treating", "PO:", "Anniston", "Ductile Iron"]) {
      expect(page1).toContain(absent);
      expect(page2).not.toContain(absent);
    }
    // And the body of page 2 starts under the band: every line but the band's below the top margin.
    const band = new Set(["Order NumberLoad", "912461", "(continued)"]);
    for (const line of textLinesWithY(pdf)[1]) {
      if (!band.has(line.text)) expect(PAGE_HEIGHT - line.y).toBeGreaterThan(96.5);
    }
  });

  it("the page-bottom items print on the last page only, in the band, and page 1's body stops above the band", async () => {
    const layout = banded(700);
    expect(bandHeight(layout)).toBe(68);
    const { pdf, defs } = await render(travelerData(30), layout);
    expect(pageCount(pdf)).toBe(2);
    expect((defs[0].pageMargins as number[])[3]).toBe(24 + 68);
    expect(defs[0].pageBottomBandSpec).toMatchObject({ height: 68, repeated: [] });
    expect(defs[0].pageBottomBandSpec!.content).toHaveLength(9);
    expect(defs[0].pageFooterSpec).toBeUndefined();
    // RESULTS (the first row) on page 2 only, its label inside its box (top-down page coordinates).
    const results = linesWith(pdf, "RESULTS:");
    expect(results).toHaveLength(1);
    expect(results[0].page).toBe(2);
    expect(results[0].top).toBeGreaterThan(700);
    expect(results[0].top).toBeLessThan(712);
    expect(linesWith(pdf, "OK to Ship:")).toEqual([expect.objectContaining({ page: 2 })]);
    // Page 1's body stops above the band's top (700): every line and every stroke on it.
    for (const line of textLinesWithY(pdf)[0]) expect(PAGE_HEIGHT - line.y).toBeLessThan(700);
    for (const stroke of strokedLines(pdf)[0]) expect(Math.max(stroke.y1, stroke.y2)).toBeLessThanOrEqual(700);
    // The steps continue on page 2 under the top margin, above the band.
    for (const stroke of strokedLines(pdf)[1]) {
      if (Math.max(stroke.y1, stroke.y2) < 700) expect(Math.min(stroke.y1, stroke.y2)).toBeGreaterThanOrEqual(topMargin(layout) - 0.5);
    }
  });

  it("with pageFooter on, 'Page 1 of 2' prints under the band and the bottom margin is 24 + band + 20", async () => {
    const layout = banded(680);
    expect(bandHeight(layout, true)).toBe(68);
    const { pdf, defs } = await render(travelerData(30), layout, { pageFooter: true });
    expect(pageCount(pdf)).toBe(2);
    expect((defs[0].pageMargins as number[])[3]).toBe(24 + 68 + 20);
    expect(defs[0].pageFooterSpec).toEqual({ kind: "pageNofM" });
    const pageLines = linesWith(pdf, "Page ");
    expect(pageLines.map((line) => [line.page, line.text])).toEqual([[1, "Page 1 of 2"], [2, "Page 2 of 2"]]);
    // Under the band: past the page's foot (748, the band's bottom) on both pages, top-down.
    for (const line of pageLines) expect(line.top).toBeGreaterThan(748);
    // The band's lowest row (OK to Ship, 728..740) above the page line on page 2.
    const ship = linesWith(pdf, "OK to Ship:");
    expect(ship).toHaveLength(1);
    expect(ship[0].page).toBe(2);
    expect(ship[0].top).toBeLessThan(740);
    expect(ship[0].top).toBeLessThan(pageLines[1].top);
  });

  it("a page-bottom Text item whose words run past the band's foot is cut at the band's bottom edge, whole lines, with the page line off and on (#978)", async () => {
    // Red when the band's footer frame is not ended at the band's bottom edge (render.ts's
    // `installBandFrame` wrapper): the item's overflow then prints below the edge, in the page's
    // bottom margin, and with the page line on over and under it.
    for (const pageFooter of [false, true]) {
      const layout = bandClipLayout(standardLayout(), pageFooter);
      expect(() => validateConfig("TRAVELER", { ...structuredClone(TRAVELER_DEFAULT_CONFIG), layout, pageFooter })).not.toThrow();
      const { pdf } = await render(travelerData(), layout, { pageFooter });
      expect(pageCount(pdf), `page line ${pageFooter}`).toBe(1);
      expectBandClip(pdf, pageFooter);
    }
  });

  it("a page-bottom item with repeat prints on every page", async () => {
    // The band holds RESULTS, repeated, beside items that do not repeat: each item repeats on its
    // own flag, not the band's (design §4.5, Ruling 11).
    const layout = banded(700, true);
    const { pdf, defs } = await render(travelerData(30), layout);
    expect(pageCount(pdf)).toBe(2);
    expect(defs[0].pageBottomBandSpec!.repeated).toHaveLength(1);
    expect(defs[0].pageBottomBandSpec!.content).toHaveLength(8);
    // RESULTS on both pages at the same place (top-down page coordinates), inside the band.
    const results = linesWith(pdf, "RESULTS:");
    expect(results.map((line) => line.page)).toEqual([1, 2]);
    expect(results[1].top).toBeCloseTo(results[0].top, 1);
    expect(results[0].top).toBeGreaterThan(700);
    // The unrepeated ones on the last page only: page 1's RESULTS line holds RESULTS alone.
    expect(results[0].text).toBe("RESULTS:");
    expect(results[1].text).toContain("TEMPERED RESULTS:");
    expect(linesWith(pdf, "OK to Ship:").map((line) => line.page)).toEqual([2]);
  });

  it("the barcode is stretched to its box (paintedImageCounts [1]; the image's drawn width and height equal box.w and box.h within 1 pt for a 372 × 88 box)", async () => {
    const layout = layoutOf([
      barcode({ box: { x: 24, y: 24, w: 372, h: 88 }, repeat: false }),
      table("steps", { anchor: { kind: "page-top" }, box: { x: 24, y: 130, w: 564, h: 120 } }),
    ]);
    // The order number's PNG is not 372:88 itself: only a stretch fills the box both ways.
    const { pdf } = await render(travelerData(1), layout);
    expect(paintedImageCounts(pdf)).toEqual([1]);
    const [image] = paintedImages(pdf)[0];
    expect(Math.abs(image.w - 372)).toBeLessThan(1);
    expect(Math.abs(image.h - 88)).toBeLessThan(1);
    expect(image.x).toBeCloseTo(24, 1);
    expect(image.y).toBeCloseTo(24, 1);
  });

  it("a logo item prints the version's bytes fitted to its box with config.logo null (paintedImageCounts [2])", async () => {
    const layout = standardLayout(); // the logo item at 24, 24, 80 × 40
    expect(cfg(layout).logo).toBeNull();
    const { pdf } = await render(travelerData(1), layout, { logoDataUri: pngDataUri(tinyAlphaPng()) });
    expect(paintedImageCounts(pdf)).toEqual([2]);
    // The 2 × 2 logo fitted into 80 × 40: a 40 pt square at the box's top-left (top-down).
    const logoImage = paintedImages(pdf)[0].find((image) => image.x < 100)!;
    expect(logoImage).toBeDefined();
    expect(logoImage.w).toBeCloseTo(40, 1);
    expect(logoImage.h).toBeCloseTo(40, 1);
    expect(logoImage.y).toBeCloseTo(24, 1);
    // No bytes on the version: the logo item prints nothing, the barcode alone paints.
    expect(paintedImageCounts((await render(travelerData(1), layout)).pdf)).toEqual([1]);
  });

  it("a line and a box print as strokes of their weight at their drawn positions (strokedLines)", async () => {
    const statics: CanvasItem[] = [
      { id: "rule", kind: "line", weight: 1.5, box: { x: 24, y: 132, w: 300, h: 0 }, anchor: { kind: "page-top" }, repeat: false },
      { id: "frame", kind: "box", weight: 2, box: { x: 420, y: 96, w: 160, h: 30 }, anchor: { kind: "page-top" }, repeat: false },
      { id: "under", kind: "line", weight: 0.75, box: { x: 24, y: 80, w: 564, h: 0 }, anchor: { kind: "below-table", table: "steps" }, repeat: false },
      { id: "foot", kind: "line", weight: 1, box: { x: 300, y: 740, w: 0, h: 20 }, anchor: { kind: "page-bottom" }, repeat: false },
    ];
    const layout = layoutOf([...standardLayout().items, ...statics]);
    const { pdf, group } = await render(travelerData(3), layout);
    expect(pageCount(pdf)).toBe(1);
    // strokedLines is in top-down page coordinates.
    const lines = strokedLines(pdf)[0];
    const has = (x1: number, y1: number, x2: number, y2: number, width: number) =>
      lines.some((s) => Math.abs(s.x1 - x1) < 0.01 && Math.abs(s.y1 - y1) < 0.01
        && Math.abs(s.x2 - x2) < 0.01 && Math.abs(s.y2 - y2) < 0.01 && s.width === width);
    expect(has(24, 132, 324, 132, 1.5)).toBe(true);
    // The below-table line rides the steps table's rendered bottom: its region's top plus 80.
    const regionTop = at(group, CANVAS_IDS.regionEnd("steps")).top - heightOf(layout, "steps");
    expect(has(24, regionTop + 80, 588, regionTop + 80, 0.75)).toBe(true);
    // The page-bottom line, vertical, in the band at its page coordinates.
    expect(has(300, 740, 300, 760, 1)).toBe(true);
    // The box: a stroked rectangle (re S), which strokedLines does not read.
    expect(strokedRectBoxes(pdf)[0]).toContainEqual({ x: 420, y: 96, w: 160, h: 30, width: 2 });
  });

  it("a sample sheet prints SAMPLE for the order and load and the placeholder in the barcode's box; an order with no loads prints its bare order-number barcode and no '(continued)'", async () => {
    const layout = repeatedNumbers();
    const sample = travelerData(1, {
      sample: true, orderNumber: 0,
      sheets: [{ loadNumber: null, loadQty: null, loadWeight: null, barcodeDataUri: "" }],
    });
    const { pdf } = await render(sample, layout);
    expect(pageCount(pdf)).toBe(1);
    expect(paintedImageCounts(pdf)).toEqual([0]);
    expect(linesWith(pdf, "SAMPLESAMPLE")).toHaveLength(1); // the order and load values, side by side
    // The placeholder's SAMPLE inside the barcode's box (402..588 × 48..92, top-down page coordinates).
    const placeholder = textLinesWithY(pdf)[0].filter((line) => line.text === "SAMPLE");
    expect(placeholder).toHaveLength(1);
    expect(PAGE_HEIGHT - placeholder[0].y).toBeGreaterThan(48);
    expect(PAGE_HEIGHT - placeholder[0].y).toBeLessThan(92);
    // Its boxed rules span the box: 176.4 + 9.6 = 186 across, 38 + 6 = 44 down, from 402, 48.
    const rules = strokedLines(pdf)[0].filter((s) => s.x1 >= 401 && s.y1 >= 47 && s.y2 <= 93 && s.y1 <= 93);
    expect(Math.min(...rules.map((s) => s.x1))).toBeCloseTo(402.4, 0);
    expect(Math.max(...rules.map((s) => Math.max(s.x1, s.x2)))).toBeCloseTo(587.6, 0);
    expect(Math.min(...rules.map((s) => s.y1))).toBeCloseTo(48, 0);
    expect(Math.max(...rules.map((s) => Math.max(s.y1, s.y2)))).toBeCloseTo(92, 0);

    // An order with no loads (readTravelerData's shape): one sheet with no load number and the bare
    // order number's barcode. The load prints "—", the barcode paints, and a one-page sheet has no
    // continuation page, so no "(continued)" anywhere.
    const noLoads = travelerData(1, { sheets: [{ loadNumber: null, loadQty: null, loadWeight: null, barcodeDataUri: BARCODE }] });
    const plain = await render(noLoads, layout);
    expect(pageCount(plain.pdf)).toBe(1);
    const numbers = linesWith(plain.pdf, "91246");
    expect(numbers).toHaveLength(1);
    expect(numbers[0].text.endsWith("91246—")).toBe(true);
    expect(paintedImageCounts(plain.pdf)).toEqual([1]);
    expect(drawnText(plain.pdf)).not.toContain("(continued)");
  });
});

/** The W5 case's wrapping instruction (tests/traveler-templates.test.ts), 239 characters. */
const W5_INSTRUCTION =
  "Ramp the furnace to soak temperature, hold until the whole load equalizes, verify with " +
  "the pyrometer log, then transfer to the quench within the allowed window and record the " +
  "elapsed transfer time on this line before the next step begins.";
/** One step's instruction: the W5 instruction ten times between two markers, 2,408 characters. On
 *  the standard layout with `travelerData(1)`'s tables above it, its row fits a page in a steps
 *  table 564 pt wide and does not in one 300 pt wide: measured at 300 pt under the body-width
 *  measure, the row vanished from seven repeats (1,691 characters) through at least twenty-eight
 *  (6,710), and printed at six, so ten sits well inside that window. */
const TALL_INSTRUCTION = ["FIRSTWORD", ...Array<string>(10).fill(W5_INSTRUCTION), "LASTWORD"].join(" ");

/** The standard layout with its steps table drawn `w` wide from x 24. */
const stepsWide = (w: number): CanvasLayout =>
  withItem(standardLayout(), "table-steps", (item) => ({ ...item, box: { ...item.box, w } }));

/** The pages (1-based) whose drawn text holds `text`. */
const pagesWith = (pdf: Buffer, text: string): number[] =>
  drawnPages(pdf).flatMap((page, i) => (page.includes(text) ? [i + 1] : []));

describe("buildCanvasTravelerDefinitions: the belt, the steps measure at the drawn width", () => {
  it("the belt: a layout handed to the builder without a barcode or a steps table still prints both at their flow places (bypass the validator)", async () => {
    const stripped = layoutOf(standardLayout().items.filter((item) =>
      item.kind !== "barcode" && !(item.kind === "table" && item.key === "steps")));
    // Past the validator: the config is the validated default with the stripped layout set on it,
    // so the print path's own branch (`buildTravelerDefinitions`) hands the layout to the builder.
    const config = { ...cfg(standardLayout()), layout: stripped } as TemplateConfig;
    const defs = buildTravelerDefinitions(travelerData(1), config);
    const { pdf, groups } = await renderSheetGroupsWithPositions(defs);
    expect(pageCount(pdf)).toBe(1);
    // The barcode in the header's right slot: the sheet's one painted image.
    expect(paintedImageCounts(pdf)).toEqual([1]);
    const text = drawnText(pdf);
    expect(text).toContain("PROCESS STEPS:");
    expect(text).toContain("Pre-heat to 1100F.");
    // The belt's steps table starts below the lowest remaining table, after its region.
    const steps = at(groups[0], CANVAS_IDS.table("steps"));
    const above = at(groups[0], CANVAS_IDS.regionEnd("inspections"));
    expect(steps.page).toBe(1);
    expect(steps.top).toBeGreaterThanOrEqual(above.top - 0.01);
  });

  it("the oversized-row split measures the steps table at its drawn width: a 300 pt-wide steps table whose one row is taller than that page is split as breakable, where the body-width measure keeps it whole", async () => {
    const data = travelerData(1, {
      steps: [{ position: 1, codeName: "Austemper", instruction: TALL_INSTRUCTION, values: [] }],
    });
    // At the body's width the row fits a page: it prints whole, both markers on one page.
    const wide = await render(data, stepsWide(564));
    const wideFirst = pagesWith(wide.pdf, "FIRSTWORD");
    expect(wideFirst).toHaveLength(1);
    expect(pagesWith(wide.pdf, "LASTWORD")).toEqual(wideFirst);
    // At 300 pt the same row is taller than a page. Measured at the body's width it would be kept
    // whole under dontBreakRows, which prints it on no page at all; measured at 300 it is split as
    // breakable and runs across pages, every word of it printed.
    const narrow = await render(data, stepsWide(300));
    const first = pagesWith(narrow.pdf, "FIRSTWORD");
    const last = pagesWith(narrow.pdf, "LASTWORD");
    expect(first).toHaveLength(1);
    expect(last).toHaveLength(1);
    expect(last[0]).toBeGreaterThan(first[0]);
    expect(pageCount(narrow.pdf)).toBeGreaterThan(pageCount(wide.pdf));
  });

  it("a canvas steps table split by an oversized row reports canvas:table:steps once, at the split stack's start; no group carries the id", async () => {
    // Two steps, one ordinary and one oversized at 300 pt, split into two groups.
    const data = travelerData(1, {
      steps: [
        { position: 1, codeName: "Austemper", instruction: "Pre-heat to 1100F.", values: [] },
        { position: 2, codeName: "Austemper", instruction: TALL_INSTRUCTION, values: [] },
      ],
    });
    const { pdf, group } = await render(data, stepsWide(300));
    expect(drawnText(pdf)).toContain("LASTWORD");
    const found = group.positions.filter((node) => node.id === CANVAS_IDS.table("steps"));
    expect(found).toHaveLength(1);
    // At the stack's start: where the table above's region ends, less than its first rule and
    // cell padding (0.8 + 2) below it, as an unsplit table reports.
    const regionEnd = at(group, CANVAS_IDS.regionEnd("inspections"));
    expect(found[0].page).toBe(regionEnd.page);
    expect(found[0].top - regionEnd.top).toBeGreaterThan(-0.01);
    expect(found[0].top - regionEnd.top).toBeLessThan(2.81);
  });

  it("judges an oversized step at the width it prints (#971)", async () => {
    // Drawn at its least width, 218.1, the steps table prints its instruction in a 4.5 pt share, so
    // a "W" and 170 "|" with no space (break-all) is a row taller than a page. The W is wider than
    // the share, so pdfmake's case 1 takes the row and the column clamp prints it at 4.5. The
    // oversized-row measure must lay it out at that same share (design §5.5): unscoped, case 1 lays
    // the instruction out at the W's width, which holds more "|" to a line, the row looks shorter
    // than a page, is kept whole under dontBreakRows, and pdfmake prints it on no page. (Until #992
    // the measure's sentinel row did the same at "measure"'s 31.027 pt, and a 120-W instruction
    // proved it; with that sentinel gone a W-only instruction measures one W to a line either way,
    // so the "|" carry the difference: 140 to 200 of them print on no page without the scope.)
    const LENGTH = 170;
    const count = (pdf: Buffer): number => (drawnText(pdf).match(/\|/g) ?? []).length;
    const step = (instruction: string) => travelerData(1, {
      steps: [{ position: 1, codeName: "Austemper", instruction, values: [] }],
    });
    const control = await render(step("Pre-heat to 1100F."), stepsWide(218.1));
    const tall = await render(step(`W${"|".repeat(LENGTH)}`), stepsWide(218.1));
    // Every character of the instruction printed: the verdict was true and the row was split.
    expect(count(tall.pdf) - count(control.pdf)).toBe(LENGTH);
    expect(pageCount(tall.pdf)).toBeGreaterThan(1);
  });

  describe("an oversized-row steps table drawn narrower than the content that breaks across pages (#969)", () => {
    // The probe's records (#969 plan, Task 5): three ordinary steps, then one step whose row is
    // taller than a page at the narrowed width, then 5 or 40 ordinary steps, so the steps table goes
    // through render.ts's oversized-row split and breaks across pages. The 12,000-character
    // instruction is past the 4000-character save cap (process-document.ts) and stands as a
    // builder-level record; the step with 80 parameters (the schema has no cap on their count) is the
    // saveable one.
    const ORDINARY = { codeName: "Austemper", instruction: "Pre-heat to 1100F.", values: [{ label: "Furnace Temp", value: "1650", unit: "°F" }] };
    const TWELVE_THOUSAND = ["FIRSTWORD", ...Array<string>(50).fill(W5_INSTRUCTION), "LASTWORD"].join(" ");
    const EIGHTY_PARAMETERS = {
      codeName: "Austemper", instruction: "FIRSTWORD heavy LASTWORD",
      values: Array.from({ length: 80 }, (_, k) => ({ label: k === 0 ? "Furnace Temp" : `Param ${k}`, value: "1650", unit: "°F" })),
    };
    const RECORDS = {
      "a 12,000-character instruction, 5 steps after": { tall: { ...ORDINARY, instruction: TWELVE_THOUSAND }, after: 5 },
      "a 12,000-character instruction, 40 steps after": { tall: { ...ORDINARY, instruction: TWELVE_THOUSAND }, after: 40 },
      "a step with 80 parameters, 5 steps after": { tall: EIGHTY_PARAMETERS, after: 5 },
    };
    type RecordName = keyof typeof RECORDS;
    const recordData = (name: RecordName): TravelerData => {
      const { tall, after } = RECORDS[name];
      const steps = [...Array<typeof ORDINARY>(3).fill(ORDINARY), tall, ...Array<typeof ORDINARY>(after).fill(ORDINARY)];
      return travelerData(1, { steps: steps.map((step, i) => ({ position: i + 1, ...structuredClone(step) })) });
    };
    const CASES = (Object.keys(RECORDS) as RecordName[]).flatMap((record) => [false, true].map((pageFooter) => ({ record, pageFooter })));
    /** `base` with its steps table drawn 40 pt in on each side. */
    const narrowSteps = (base: CanvasLayout): CanvasLayout => layoutOf(base.items.map((item) =>
      item.kind === "table" && item.key === "steps" ? { ...item, box: { ...item.box, x: item.box.x + 40, w: item.box.w - 80 } } : item));
    /** The standard layout with the steps table drawn where inspections stands (y 261), the inspections
     *  table below it and the footer fields under the inspections table. */
    const stepsThenInspections = (): CanvasLayout => layoutOf(standardLayout().items.map((item): CanvasItem => {
      if (item.kind === "table" && item.key === "steps") {
        return { ...item, box: { ...item.box, y: 261, h: 70 }, anchor: { kind: "below-table", table: "quantities" } };
      }
      if (item.kind === "table" && item.key === "inspections") {
        return { ...item, box: { ...item.box, y: 339, h: 120 }, anchor: { kind: "below-table", table: "steps" } };
      }
      if (item.kind !== "table" && item.anchor.kind === "below-table" && item.anchor.table === "steps") {
        return { ...item, anchor: { kind: "below-table", table: "inspections" } };
      }
      return item;
    }));
    const RIGHT_MARGIN = 588;
    /** Every page's runs whose trimmed text is exactly `text`, as [page, x]. */
    const runsOf = (pdf: Buffer, text: string) => textRunsWithY(pdf).flatMap((runs, p) =>
      runs.filter((r) => r.text.trim() === text).map((r) => [p + 1, r.x] as const));
    /** The one x the control prints `text` at, which the case requires. */
    const onlyX = (pdf: Buffer, text: string): number => {
      const xs = [...new Set(runsOf(pdf, text).map(([, x]) => Math.round(x * 10) / 10))];
      expect(xs, `${text} in the control`).toHaveLength(1);
      return xs[0];
    };
    /** No non-blank run starts past the right margin, and no stroke ends past it by more than 0.5. */
    const insideTheMargin = (pdf: Buffer) => {
      const pastRuns = textRunsWithY(pdf).flatMap((runs, p) =>
        runs.filter((r) => r.text.trim() !== "" && r.x > RIGHT_MARGIN).map((r) => `${p + 1}:${r.text.trim()}@${r.x.toFixed(1)}`));
      expect(pastRuns).toEqual([]);
      const pastStrokes = strokedLines(pdf).flatMap((lines, p) =>
        lines.filter((s) => Math.max(s.x1, s.x2) > RIGHT_MARGIN + 0.5)
          .map((s) => `${p + 1}:${Math.min(s.x1, s.x2).toFixed(1)}..${Math.max(s.x1, s.x2).toFixed(1)}`));
      expect(pastStrokes).toEqual([]);
    };
    /** The premises every case shares: the steps table breaks across pages, every word of the tall
     *  row prints, the steps' "Date" header prints at the control's x less 40 on every page the
     *  table takes, and the page line, when on, prints on every page. */
    const stepsAtTheirDrawnWidth = (control: Buffer, narrow: Awaited<ReturnType<typeof render>>, pageFooter: boolean) => {
      const from = at(narrow.group, CANVAS_IDS.table("steps")).page;
      const to = at(narrow.group, CANVAS_IDS.end("steps")).page;
      expect(to, "the steps table breaks across pages").toBeGreaterThan(from);
      expect(pagesWith(narrow.pdf, "FIRSTWORD")).toHaveLength(1);
      expect(pagesWith(narrow.pdf, "LASTWORD")).toHaveLength(1);
      const dateX = onlyX(control, "Date");
      const dates = runsOf(narrow.pdf, "Date");
      for (let page = from; page <= to; page++) expect(dates.some(([p]) => p === page), `a Date header on page ${page}`).toBe(true);
      for (const [p, x] of dates) expect(Math.abs(x - (dateX - 40)), `Date on page ${p} at ${x.toFixed(2)}`).toBeLessThan(0.5);
      if (pageFooter) {
        expect(pagesWith(narrow.pdf, "Page ")).toEqual(Array.from({ length: pageCount(narrow.pdf) }, (_, i) => i + 1));
      }
    };

    it.each(CASES)("an oversized-row steps table drawn 40 pt in keeps every group at its drawn width ($record, page line $pageFooter)", async ({ record, pageFooter }) => {
      const data = recordData(record);
      const full = await render(data, standardLayout(), { pageFooter });
      const narrow = await render(data, narrowSteps(standardLayout()), { pageFooter });
      insideTheMargin(full.pdf);
      insideTheMargin(narrow.pdf);
      stepsAtTheirDrawnWidth(full.pdf, narrow, pageFooter);
    }, 60_000);

    it.each(CASES)("the inspections table after a narrowed oversized steps table prints as at full width ($record, page line $pageFooter)", async ({ record, pageFooter }) => {
      const data = recordData(record);
      const full = await render(data, stepsThenInspections(), { pageFooter });
      const narrow = await render(data, narrowSteps(stepsThenInspections()), { pageFooter });
      insideTheMargin(full.pdf);
      insideTheMargin(narrow.pdf);
      stepsAtTheirDrawnWidth(full.pdf, narrow, pageFooter);
      // The inspections table is laid out after the steps table's break, in both prints.
      for (const r of [full, narrow]) {
        expect(at(r.group, CANVAS_IDS.table("inspections")).page).toBeGreaterThanOrEqual(at(r.group, CANVAS_IDS.end("steps")).page);
        expect(at(r.group, CANVAS_IDS.end("steps")).page).toBeGreaterThan(at(r.group, CANVAS_IDS.table("steps")).page);
      }
      // Its cells at the control's x: the scale (HBW) and the location (flange OD).
      for (const text of ["Hardness", "HBW", "flange"]) {
        const x = onlyX(full.pdf, text);
        const runs = runsOf(narrow.pdf, text);
        expect(runs, text).toHaveLength(runsOf(full.pdf, text).length);
        for (const [p, got] of runs) expect(Math.abs(got - x), `${text} on page ${p} at ${got.toFixed(2)}`).toBeLessThan(0.5);
      }
    }, 60_000);
  });
});
