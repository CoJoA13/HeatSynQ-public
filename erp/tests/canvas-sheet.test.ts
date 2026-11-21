import { describe, it, expect } from "vitest";
import type { Content } from "pdfmake/interfaces";
import {
  CANVAS_IDS, aloneLayouts, assembleCanvasSheet, drawnBlock, mark, spacer, textBlockContent, type TableItem, type TextBlockItem,
} from "@/server/pdf/canvas-sheet";
import { canvasBlockOf } from "@/server/pdf/canvas-nodes";
import { canvasMeasure } from "@/server/canvas-measure";
import type { LaidOutNode } from "@/server/pdf/render";
import { blockItems } from "./helpers/canvas-blocks";
import { bandTop } from "@/lib/template-canvas";
import type { CanvasItem } from "@/lib/template-contracts/canvas";
import type { FontsConfig } from "@/lib/template-contracts/types";
import { layoutOf, standardLayout } from "./helpers/canvas-fixtures";

/**
 * The shared canvas sheet module (`src/server/pdf/canvas-sheet.ts`, shipping ticket canvas PR 2a,
 * task 1). What it lifted out of the traveler is proved by the traveler's own suites, unchanged;
 * this file pins the two pieces it adds for the ticket: a text block's paragraphs, wrapped at the
 * box, and the alone layouts the preview measures the regions' and the band's items on (task 2).
 */

const block: TextBlockItem = {
  kind: "textBlock", id: "block-liability", key: "shipper_liability_text",
  box: { x: 60, y: 300, w: 240, h: 40 },
  anchor: { kind: "page-top" }, repeat: false,
  style: { size: 7, bold: true, align: "center" },
};

describe("textBlockContent", () => {
  it("prints each paragraph in the item's style, wrapped at the box's width", () => {
    expect(textBlockContent(block, "First paragraph,\nstill the first.\n\n  \nSecond paragraph.")).toEqual({
      columns: [{
        width: 240,
        stack: [{
          stack: [
            { text: "First paragraph,\nstill the first.", fontSize: 7, bold: true, alignment: "center", margin: [0, 0, 0, 4] },
            { text: "Second paragraph.", fontSize: 7, bold: true, alignment: "center", margin: [0, 0, 0, 4] },
          ],
        }],
      }],
      columnGap: 0,
    });
  });
});

describe("aloneLayouts", () => {
  const fonts: FontsConfig = { family: "Roboto", baseSize: 9, headingSize: 12, smallSize: 7 };
  /** Every item prints one text node naming it; the Pass box prints nothing. */
  const itemContent = (item: CanvasItem): Content | null => (item.id === "field-pass" ? null : { text: item.id });
  const wrapper = (item: CanvasItem, y: number) => ({
    id: CANVAS_IDS.item(item.id), absolutePosition: { x: item.box.x, y },
    stack: [{ text: item.id }, mark(CANVAS_IDS.itemEnd(item.id))],
  });
  const page = (content: unknown[]) => ({
    pageSize: { width: 612, height: "auto" },
    pageMargins: [24, 0, 24, 0],
    defaultStyle: { font: "Roboto", fontSize: 9 },
    content: [...content, spacer(1)],
  });
  const below = (layout: ReturnType<typeof standardLayout>, table: string) =>
    layout.items.filter((item) => item.kind !== "table" && item.anchor.kind === "below-table" && item.anchor.table === table);

  it("the standard layout: one auto-height page per region holding an item (Quantities' and Steps', by the tables' order), each item at its offset under its id with its end mark, an item printing nothing left out, and no band", () => {
    const layout = standardLayout();
    const layouts = aloneLayouts({ layout, pageFooter: false, fonts, itemContent });
    expect(layouts.map((a) => a.after)).toEqual(["quantities", "steps"]);
    expect(layouts[0].def).toEqual(page(below(layout, "quantities").map((item) => wrapper(item, item.box.y))));
    const steps = below(layout, "steps");
    expect(steps.some((item) => item.id === "field-pass")).toBe(true);
    expect(layouts[1].def).toEqual(page(steps.filter((item) => item.id !== "field-pass").map((item) => wrapper(item, item.box.y))));
    // The Results box's offset is its stored y, 8 pt under the region's top.
    expect((layouts[1].def.content as { absolutePosition: { y: number } }[])[0].absolutePosition.y).toBe(8);
  });

  it("a page-bottom item adds a band page last, the item at its y less the band's top", () => {
    const sig: CanvasItem = {
      id: "sig", kind: "text", text: "Signed", box: { x: 300, y: 700, w: 200, h: 12 },
      anchor: { kind: "page-bottom" }, repeat: false, style: { size: 8, bold: false, align: "left" },
    };
    const low: CanvasItem = { ...sig, id: "low", box: { x: 24, y: 730, w: 200, h: 12 }, repeat: true };
    const layout = layoutOf([...standardLayout().items, sig, low]);
    expect(bandTop(layout, true)).toBe(700);
    const layouts = aloneLayouts({ layout, pageFooter: true, fonts, itemContent });
    expect(layouts.map((a) => a.after)).toEqual(["quantities", "steps", "band"]);
    expect(layouts[2].def).toEqual(page([wrapper(sig, 0), wrapper(low, 30)]));
  });

  it("a region whose every item prints nothing, and a band that prints nothing, give no page", () => {
    const layout = layoutOf([...standardLayout().items, {
      id: "sig", kind: "text", text: "Signed", box: { x: 300, y: 700, w: 200, h: 12 },
      anchor: { kind: "page-bottom" }, repeat: false, style: { size: 8, bold: false, align: "left" },
    }]);
    const none = (item: CanvasItem) => (item.anchor.kind === "page-top" || (item.kind !== "table" && item.anchor.kind === "below-table" && item.anchor.table === "steps") ? { text: item.id } : null);
    expect(aloneLayouts({ layout, pageFooter: false, fonts, itemContent: none }).map((a) => a.after)).toEqual(["steps"]);
  });
});

/**
 * #997 (owner ruling 2026-11-15): the sheet leaves out a TRAILING float region from which nothing
 * prints (`nothingPrintsAfter`), on every canvas document; here on the traveler's standard fixture
 * layout with stub callbacks. Its tables by y: lines (region 8 pt), quantities (21 pt, three items),
 * inspections (8 pt), steps (68 pt, nine items). The stubs print every block but the steps table and
 * every item but those below the steps table, so the 8 pt gap under the inspections block and the
 * steps region are a trailing run from which nothing prints.
 */
describe("assembleCanvasSheet: a trailing region from which nothing prints (#997)", () => {
  const fonts: FontsConfig = { family: "Roboto", baseSize: 9, headingSize: 12, smallSize: 7 };
  const tableBlock = (item: TableItem): Content | null => (item.key === "steps" ? null : { text: item.key });
  /** The node the sheet put between a table's `end` mark and its `regionEnd` mark: its region, or null. */
  const regionAfter = (content: Content[], key: string): unknown => {
    const i = content.findIndex((node) => (node as { id?: string }).id === CANVAS_IDS.end(key as never));
    expect(i, `the end mark of ${key}`).toBeGreaterThanOrEqual(0);
    const next = content[i + 1] as { id?: string };
    return next.id === CANVAS_IDS.regionEnd(key as never) ? null : next;
  };
  const sheet = (prints: (item: CanvasItem) => boolean) => assembleCanvasSheet({
    layout: standardLayout(), pageFooter: false, fonts, tableBlock,
    itemContent: (item) => (prints(item) ? { text: item.id } : null),
  }).content as Content[];
  const notBelowSteps = (item: CanvasItem) => !(item.anchor.kind === "below-table" && item.anchor.table === "steps");

  // Red with the sheet's drop removed (every region emitted): the inspections gap and the steps
  // region are then printed spacers.
  it("drops the trailing gap and region when no later block or item prints, and keeps the regions above them", () => {
    const content = sheet(notBelowSteps);
    expect(regionAfter(content, "lines"), "a gap with a printing block after it").toMatchObject({ unbreakable: true });
    expect(regionAfter(content, "quantities"), "a region holding printing items").toMatchObject({ unbreakable: true });
    expect(regionAfter(content, "inspections"), "the trailing 8 pt gap").toBeNull();
    expect(regionAfter(content, "steps"), "the trailing region, its items printing nothing").toBeNull();
  });

  // Red with the drop judged without the later regions' items: the inspections gap is then dropped
  // although the Pass box prints after it.
  it("keeps a gap and a region when an item that prints follows them", () => {
    const content = sheet((item) => notBelowSteps(item) || item.id === "field-pass");
    const gap = regionAfter(content, "inspections") as { unbreakable: boolean; stack: unknown[] };
    expect(gap).toEqual({ unbreakable: true, stack: [spacer(8)] });
    const steps = regionAfter(content, "steps") as { unbreakable: boolean; stack: unknown[] };
    expect(steps.stack).toHaveLength(2);
    expect(steps.stack[1]).toEqual(spacer(68));
  });
});

/**
 * The one canvas block shape (#969): the block's id on a wrapper at [0, 0, 0, 0], and inside it ONE
 * zero-gap `columns` node carrying the lateral margin, its one column holding the document's node.
 * pdfmake rebuilds a broken level-1 column group's width from that group's own margin
 * (`DocumentContext.initializePage`), so the margin sits on the group, never on the wrapper.
 */
describe("drawnBlock", () => {
  const tableItem = (x: number, w: number): TableItem => ({
    kind: "table", id: "table-parts", key: "parts", box: { x, y: 200, w, h: 90 },
    anchor: { kind: "page-top" }, repeat: false, heading: null, columns: [],
  } as unknown as TableItem);
  type Shaped = {
    id: string; margin: number[]; stack: {
      columns: { width: number; stack: Record<string, unknown>[] }[]; columnGap: number; margin: number[];
    }[];
  };

  it("puts the lateral margin on its one zero-gap columns node and none on the wrapper", () => {
    const node: Record<string, unknown> = { table: { widths: ["*"], body: [["A"]] }, id: "x", margin: [0, 0, 0, 6] };
    const block = drawnBlock(node, tableItem(64, 484)) as unknown as Shaped;
    expect(Object.keys(block).sort()).toEqual(["id", "margin", "stack"]);
    expect(block.id).toBe("canvas:table:parts");
    expect(block.margin).toEqual([0, 0, 0, 0]);
    expect(block.stack).toHaveLength(1);
    const [group] = block.stack;
    expect(group.margin).toEqual([40, 0, 40, 0]);
    expect(group.columnGap).toBe(0);
    expect(group.columns).toHaveLength(1);
    expect(Object.is(group.columns[0].width, 564 - (40 + 40))).toBe(true);
    expect(group.columns[0].stack).toEqual([node]);
    expect(group.columns[0].stack[0]).toBe(node);
    expect("id" in node).toBe(false);
    expect(node.margin).toEqual([0, 0, 0, 0]);
  });

  it("a held block takes a 0-wide spacer column of its drawn height", () => {
    const block = drawnBlock({ stack: [{ text: "Bill To" }] }, tableItem(64, 484), 90) as unknown as Shaped;
    const { columns } = block.stack[0];
    expect(columns).toHaveLength(2);
    expect(columns[1].width).toBe(0);
    expect(columns[1].stack).toEqual([spacer(90)]);
    expect(canvasBlockOf(block)?.held).toBe(90);
  });

  it("the column's width is pdfmake's own subtraction, never the drawn width", () => {
    // pdfmake's `addMargin` takes `left + right` from the 564-point content width; the drawn width
    // differs from that in the last place here. (x 24.3, w 517.1 does not discriminate: the two agree.)
    expect(!Object.is(564 - ((24.3 - 24) + (588 - 24.3 - 300.1)), 300.1)).toBe(true);
    const block = drawnBlock({ stack: [] }, tableItem(24.3, 300.1)) as unknown as Shaped;
    expect(Object.is(block.stack[0].columns[0].width, 564 - ((24.3 - 24) + (588 - 24.3 - 300.1)))).toBe(true);
  });

  describe("canvasBlockOf reads only that shape", () => {
    const fresh = (held?: number) => drawnBlock({ stack: [{ text: "row" }] }, tableItem(64, 484), held) as unknown as Shaped;

    it("answers the plain form, its laterals, width and inner, and its items", () => {
      const block = fresh();
      expect(canvasBlockOf(block)).toEqual({
        id: "canvas:table:parts", left: 40, right: 40, width: 484, held: null,
        inner: { stack: [{ text: "row" }], margin: [0, 0, 0, 0] }, items: [{ text: "row" }],
      });
      expect(canvasBlockOf(block)?.items).toBe((block.stack[0].columns[0].stack[0] as { stack: unknown[] }).stack);
    });

    it("answers the held form", () => {
      expect(canvasBlockOf(fresh(90))).toMatchObject({ held: 90, left: 40, right: 40, width: 484 });
    });

    it("answers items null for an inner that is not a plain { stack, margin }", () => {
      const block = fresh();
      (block.stack[0].columns[0].stack[0] as Record<string, unknown>).fontSize = 9;
      expect(canvasBlockOf(block)).toMatchObject({ items: null });
      const columnsInner = drawnBlock({ columns: [{ text: "a" }] }, tableItem(64, 484));
      expect(canvasBlockOf(columnsInner)).toMatchObject({ items: null });
    });

    it.each<[what: string, edit: (block: Shaped) => void]>([
      ["the old margined stack", () => undefined],
      ["an extra key on the wrapper", (b) => { (b as unknown as Record<string, unknown>).fontSize = 9; }],
      ["an extra key on the columns node", (b) => { (b.stack[0] as unknown as Record<string, unknown>).fontSize = 9; }],
      ["an extra key on the column", (b) => { (b.stack[0].columns[0] as unknown as Record<string, unknown>).fontSize = 9; }],
      ["a columnGap of 12", (b) => { b.stack[0].columnGap = 12; }],
      ["a third column", (b) => {
        for (const h of [10, 20]) b.stack[0].columns.push({ width: 0, stack: [spacer(h) as unknown as Record<string, unknown>] });
        expect(b.stack[0].columns).toHaveLength(3);
      }],
      ["a wrapper margin that is not [0, 0, 0, 0]", (b) => { b.margin = [0, 0, 0, 6]; }],
      ["a columns node with a vertical margin", (b) => { b.stack[0].margin = [40, 6, 40, 0]; }],
      ["a wrapper stack of two entries", (b) => { b.stack.push(b.stack[0]); }],
      ["a column of two nodes", (b) => { b.stack[0].columns[0].stack.push({ text: "more" }); }],
      ["a second column that is not 0 wide", (b) => { b.stack[0].columns.push({ width: 4, stack: [spacer(10) as unknown as Record<string, unknown>] }); }],
      ["a second column that holds no spacer", (b) => { b.stack[0].columns.push({ width: 0, stack: [{ text: "x" }] }); }],
      // A canvas node with a height that is not `spacer(h)`: a visible rect, which only the spacer
      // column's exact comparison refuses (a text node already fails the height read before it).
      ["a second column holding a canvas that is not spacer(h)", (b) => {
        b.stack[0].columns.push({ width: 0, stack: [{ canvas: [{ type: "rect", x: 0, y: 0, w: 50, h: 10, color: "#ff0000" }] }] });
      }],
      // A `"*"` column takes its width from the context: no block's column, whose width is fixed.
      ["a \"*\" column width", (b) => { (b.stack[0].columns[0] as { width: unknown }).width = "*"; }],
      // render.ts reads a block's id with `startsWith`, which a number would throw on.
      ["a non-string id", (b) => { (b as unknown as { id: unknown }).id = 7; }],
    ])("answers null for %s", (what, edit) => {
      if (what === "the old margined stack") {
        // The shape #969 retired: the table's id and its lateral margin on one plain stack.
        expect(canvasBlockOf({ id: "canvas:table:parts", stack: [{ text: "row" }], margin: [40, 0, 40, 0] })).toBeNull();
        return;
      }
      const block = fresh();
      edit(block);
      expect(canvasBlockOf(block)).toBeNull();
    });
  });

  it("blockItems reads a block's document children in the one block shape, and refuses the old margined stack", () => {
    const item = tableItem(64, 484);
    const def = (block: unknown) => ({ content: [{ text: "before" }, block, mark("canvas:end:parts")] });
    expect(blockItems(def(drawnBlock({ stack: [{ text: "a" }, { text: "b" }] }, item)), "parts")).toEqual([{ text: "a" }, { text: "b" }]);
    expect(blockItems(def(drawnBlock({ table: { body: [["A"]] } }, item)), "parts")).toEqual([{ table: { body: [["A"]] }, margin: [0, 0, 0, 0] }]);
    expect(() => blockItems(def({ id: "canvas:table:parts", stack: [{ text: "a" }], margin: [40, 0, 40, 0] }), "parts"))
      .toThrow(/canvas:table:parts: not the canvas block shape/);
    expect(() => blockItems(def({ text: "none" }), "parts")).toThrow(/canvas:table:parts/);
  });
});

describe("canvasMeasure and the column clamp (#971)", () => {
  it("canvasMeasure carries squeezed from the block's node", () => {
    const layout = standardLayout();
    const keys = layout.items.flatMap((item) => (item.kind === "table" ? [item] : []))
      .sort((a, b) => a.box.y - b.box.y).map((item) => item.key);
    // Each table's block node, its end mark and its region's end mark, one after another; the
    // quantities' block alone carries the clamp's flag, as `laidOutNodes` reports it.
    let top = 100;
    const positions: LaidOutNode[] = keys.flatMap((key) => {
      const own: LaidOutNode = { id: CANVAS_IDS.table(key), page: 1, left: 24, top, ...(key === "quantities" ? { squeezed: true as const } : {}) };
      const end: LaidOutNode = { id: CANVAS_IDS.end(key), page: 1, left: 24, top: top + 40 };
      const regionEnd: LaidOutNode = { id: CANVAS_IDS.regionEnd(key), page: 1, left: 24, top: top + 50 };
      top += 60;
      return [own, end, regionEnd];
    });
    const measure = canvasMeasure(layout, false, { positions, pages: 1 }, (l) => l);
    expect(measure.tables.map((table) => table.key)).toEqual(keys);
    for (const table of measure.tables) {
      if (table.key === "quantities") expect(table).toMatchObject({ squeezed: true });
      else expect(table).not.toHaveProperty("squeezed");
    }
  });
});
