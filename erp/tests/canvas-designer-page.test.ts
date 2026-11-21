/**
 * The designer leaf reads the template's page (container tag PR 2, Task 2): `edges(page)` replaces the
 * module constants, and every mover, resizer and placer takes the page as a last optional argument or
 * option key, defaulting to Letter.
 */
import { describe, expect, it } from "vitest";
import type { CanvasItem, CanvasLayout } from "@/lib/template-contracts/canvas";
import type { CanvasProfile, TemplateContract } from "@/lib/template-contracts/types";
import {
  clearedLayout, dragStart, dropBox, edges, fitScale, moveBox, movedItem, placeNew, resizeBox, resizedItem, stageBox,
} from "@/lib/canvas-designer";
import type { CanvasMeasure } from "@/lib/template-canvas";
import { testContract } from "./helpers/test-contract";

const TAG = { width: 288, height: 216, margin: 14 };
const empty: CanvasLayout = { version: 1, items: [] };
const profile: CanvasProfile = {
  paper: "tag", tables: [], required: [], barcode: false, notFields: [], boxedFields: [], ruledFields: [],
  leastWidths: {}, rowFloor: 12, firstTableRoom: 24,
};
const contract = (): TemplateContract => testContract(profile);
const style = { size: 10, bold: false, align: "left" as const };
const fieldItem = (x: number, y: number, w: number, h: number): CanvasItem => ({
  id: "f1", kind: "field", key: "quote_number", label: null, box: { x, y, w, h },
  anchor: { kind: "page-top" }, repeat: false, style,
});
const tableItem = (): CanvasItem => ({
  id: "t1", kind: "table", key: "lines", heading: null, columns: [], repeat: false,
  anchor: { kind: "page-top" }, box: { x: 14, y: 20, w: 200, h: 12 },
});

describe("edges", () => {
  it("answers the page's four edges, Letter's by default", () => {
    expect(edges(TAG)).toEqual({ left: 14, right: 274, top: 14, bottom: 202 });
    expect(edges()).toEqual({ left: 24, right: 588, top: 24, bottom: 768 });
  });
});

describe("the designer on the tag page", () => {
  it("fitScale divides by the page's width", () => {
    expect(fitScale(400, TAG)).toBe(1.25);
    expect(fitScale(300, TAG)).toBe(300 / 288);
    expect(fitScale(300)).toBe(0.5);
    expect(fitScale(612)).toBe(1);
  });

  it("moveBox clamps inside the page's edges", () => {
    const box = { x: 100, y: 100, w: 50, h: 20 };
    expect(moveBox(box, 2000, 2000, box.h, TAG)).toEqual({ x: 224, y: 182, w: 50, h: 20 });
    expect(moveBox(box, -2000, -2000, box.h, TAG)).toEqual({ x: 14, y: 14, w: 50, h: 20 });
    expect(moveBox(box, 2000, 2000)).toEqual({ x: 538, y: 748, w: 50, h: 20 });
  });

  it("resizeBox caps the width at the right edge", () => {
    const item = fieldItem(14, 14, 100, 12);
    expect(resizeBox(item, "e", 400, 0, contract(), TAG).w).toBe(274 - 14);
    expect(resizeBox(fieldItem(24, 14, 100, 12), "e", 600, 0, contract()).w).toBe(588 - 24);
  });

  it("resizedItem passes the page down", () => {
    const item = fieldItem(14, 14, 100, 12);
    expect(resizedItem(item, empty, null, "e", 400, 0, contract(), TAG)?.box.w).toBe(260);
  });

  it("placeNew sizes and places a text block inside the page", () => {
    const placed = placeNew(empty, contract(), { kind: "textBlock", key: "x" } as never, { page: TAG });
    expect(placed.box.w).toBe(274 - 14);
    expect(placed.box.x).toBe(14);
    expect(placed.box.y).toBeGreaterThanOrEqual(14);
    expect(placeNew(empty, contract(), { kind: "textBlock", key: "x" } as never).box.w).toBe(564);
  });

  it("stageBox caps a table's drawn height at the page's foot", () => {
    const measure: CanvasMeasure = {
      pages: 1, tables: [{ key: "lines", page: 1, top: 20, height: 900 }], items: [], regions: [],
    } as never;
    expect(stageBox(tableItem(), empty, measure, TAG).box.h).toBe(202 - 20);
    expect(stageBox(tableItem(), empty, measure).box.h).toBe(768 - 20);
  });

  it("dragStart passes the page to stageBox", () => {
    const measure: CanvasMeasure = {
      pages: 1, tables: [{ key: "lines", page: 1, top: 20, height: 900 }], items: [], regions: [],
    } as never;
    expect(dragStart(tableItem(), empty, measure, TAG).h).toBe(182);
  });

  it("movedItem keeps a dragged item inside the page", () => {
    const item = fieldItem(14, 14, 100, 12);
    const layout: CanvasLayout = { version: 1, items: [item] };
    const moved = movedItem(layout, item, 900, 900, { page: TAG });
    expect(moved?.box).toEqual({ x: 174, y: 190, w: 100, h: 12 });
  });

  it("dropBox clamps a page-bottom item inside the tag page's band", () => {
    const item: CanvasItem = { ...fieldItem(14, 150, 100, 12), anchor: { kind: "page-bottom" } };
    const layout: CanvasLayout = { version: 1, items: [item] };
    const dropped = dropBox(layout, item, { x: 14, y: 900, w: 100, h: 12 }, { page: TAG });
    expect(dropped.box.y).toBe(202 - 12);
    expect(dropBox(layout, item, { x: 14, y: 900, w: 100, h: 12 }).box.y).toBe(768 - 12);
  });

  it("clearedLayout takes the page and stays Letter by default", () => {
    expect(clearedLayout(contract(), TAG)).toEqual({ version: 1, items: [] });
    expect(clearedLayout(contract())).toEqual({ version: 1, items: [] });
  });
});
