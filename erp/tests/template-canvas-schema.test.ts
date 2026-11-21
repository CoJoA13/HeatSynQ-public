import { describe, it, expect } from "vitest";
import { ZodError } from "zod";
import { canvasLayoutSchema, CANVAS_PAGE, CANVAS_GRID, BARCODE_MIN, CANVAS_TABLES } from "@/lib/template-contracts/canvas";
import { field, table, barcode, logo, layoutOf } from "./helpers/canvas-fixtures";

describe("canvasLayoutSchema", () => {
  it("accepts a minimal layout and returns it unchanged", () => {
    const layout = layoutOf([barcode(), table("steps")]);
    expect(canvasLayoutSchema.parse(layout)).toEqual(layout);
  });
  it("accepts every item kind", () => {
    const layout = layoutOf([
      barcode(), logo(), field("results"), table("lines"),
      { id: "t1", kind: "text", text: "Hi", box: { x: 24, y: 24, w: 50, h: 12 }, anchor: { kind: "page-bottom" }, repeat: false, style: { size: 8, bold: true, align: "center" } },
      { id: "l1", kind: "line", weight: 1, box: { x: 24, y: 100, w: 100, h: 0 }, anchor: { kind: "page-top" }, repeat: false },
      { id: "b1", kind: "box", weight: 0.25, box: { x: 24, y: 100, w: 100, h: 40 }, anchor: { kind: "page-top" }, repeat: false },
    ]);
    expect(canvasLayoutSchema.parse(layout)).toEqual(layout);
  });
  it("refuses an unknown key at the top, on an item and inside a box", () => {
    expect(() => canvasLayoutSchema.parse({ ...layoutOf([barcode()]), extra: 1 })).toThrow(ZodError);
    expect(() => canvasLayoutSchema.parse(layoutOf([{ ...barcode(), extra: 1 } as never]))).toThrow(ZodError);
    expect(() => canvasLayoutSchema.parse(layoutOf([{ ...barcode(), box: { ...barcode().box, extra: 1 } } as never]))).toThrow(ZodError);
  });
  it("refuses a version other than 1, an unknown kind, and an unknown anchor kind", () => {
    expect(() => canvasLayoutSchema.parse({ ...layoutOf([barcode()]), version: 2 })).toThrow(ZodError);
    expect(() => canvasLayoutSchema.parse(layoutOf([{ ...barcode(), kind: "circle" } as never]))).toThrow(ZodError);
    expect(() => canvasLayoutSchema.parse(layoutOf([{ ...barcode(), anchor: { kind: "page-middle" } } as never]))).toThrow(ZodError);
  });
  it("accepts an unknown table key: which keys a document places is the rules' question", () => {
    expect(canvasLayoutSchema.safeParse(layoutOf([{ ...table("steps"), key: "totals" } as never])).success).toBe(true);
  });
  it("accepts a textBlock item and refuses one with an unknown key inside its style", () => {
    const block = { id: "lt", kind: "textBlock", key: "shipper_liability_text", box: { x: 24, y: 300, w: 564, h: 20 }, anchor: { kind: "page-top" }, repeat: false, style: { size: 5.5, bold: false, align: "left" } };
    expect(canvasLayoutSchema.parse({ version: 1, items: [block] }).items[0]).toEqual(block);
    expect(() => canvasLayoutSchema.parse({ version: 1, items: [{ ...block, style: { ...block.style, font: "x" } }] })).toThrow(ZodError);
  });
  it("reads any non-empty table key and below-table anchor: which keys a document places is the rules' question (rule 1)", () => {
    const ticket = { ...table("lines"), key: "containers", anchor: { kind: "below-table", table: "field_strip" } };
    expect(canvasLayoutSchema.safeParse({ version: 1, items: [ticket] }).success).toBe(true);
    expect(canvasLayoutSchema.safeParse({ version: 1, items: [{ ...ticket, key: "" }] }).success).toBe(false);
  });
  it("bounds a text size to 4–72, a weight to 0.25–4, and refuses a non-finite coordinate", () => {
    const style = (size: number) => ({ size, bold: false, align: "left" as const });
    expect(() => canvasLayoutSchema.parse(layoutOf([field("results", { style: style(3) })]))).toThrow(ZodError);
    expect(() => canvasLayoutSchema.parse(layoutOf([field("results", { style: style(73) })]))).toThrow(ZodError);
    expect(() => canvasLayoutSchema.parse(layoutOf([field("results", { style: style(4) })]))).not.toThrow();
    expect(() => canvasLayoutSchema.parse(layoutOf([field("results", { style: style(72) })]))).not.toThrow();
    const line = (weight: number) => ({ id: "l1", kind: "line" as const, weight, box: { x: 24, y: 100, w: 100, h: 0 }, anchor: { kind: "page-top" as const }, repeat: false });
    expect(() => canvasLayoutSchema.parse(layoutOf([line(0)]))).toThrow(ZodError);
    expect(() => canvasLayoutSchema.parse(layoutOf([line(5)]))).toThrow(ZodError);
    expect(() => canvasLayoutSchema.parse(layoutOf([line(4)]))).not.toThrow();
    expect(() => canvasLayoutSchema.parse(layoutOf([barcode({ box: { ...barcode().box, x: NaN } })]))).toThrow(ZodError);
    expect(() => canvasLayoutSchema.parse(layoutOf([barcode({ box: { ...barcode().box, y: Infinity } })]))).toThrow(ZodError);
  });
  it("refuses an unknown key inside a style, inside an anchor and inside a column", () => {
    const style = { size: 8, bold: false, align: "left" as const, extra: 1 };
    expect(() => canvasLayoutSchema.parse(layoutOf([field("results", { style } as never)]))).toThrow(ZodError);
    expect(() => canvasLayoutSchema.parse(layoutOf([barcode({ anchor: { kind: "page-top", extra: 1 } as never })]))).toThrow(ZodError);
    const steps = table("steps");
    const columns = steps.columns.map((c, i) => (i === 0 ? { ...c, extra: 1 } : c));
    expect(() => canvasLayoutSchema.parse(layoutOf([table("steps", { columns } as never)]))).toThrow(ZodError);
  });
  it("refuses a column width of zero or below, and accepts a positive one or none", () => {
    const lines = table("lines");
    const widths = (part: number | null, qty: number | null) => table("lines", {
      box: { x: 24, y: 140, w: 300, h: 40 },
      columns: lines.columns.map((c) => (c.key === "line_part" ? { ...c, width: part } : c.key === "line_qty" ? { ...c, width: qty } : c)),
    });
    // A negative width would lower rule 9's total: 100 and −100 would fit any box.
    expect(() => canvasLayoutSchema.parse(layoutOf([widths(100, -100)]))).toThrow(ZodError);
    expect(() => canvasLayoutSchema.parse(layoutOf([widths(100, 0)]))).toThrow(ZodError);
    expect(() => canvasLayoutSchema.parse(layoutOf([widths(100, 0.5)]))).not.toThrow();
    expect(() => canvasLayoutSchema.parse(layoutOf([widths(null, null)]))).not.toThrow();
  });
  it("refuses a line that is neither horizontal nor vertical: both sides drawn, or neither", () => {
    const line = (w: number, h: number) => ({ id: "l1", kind: "line" as const, weight: 1, box: { x: 24, y: 100, w, h }, anchor: { kind: "page-top" as const }, repeat: false });
    expect(() => canvasLayoutSchema.parse(layoutOf([line(100, 1)]))).toThrow("a line is horizontal (h 0) or vertical (w 0)");
    expect(() => canvasLayoutSchema.parse(layoutOf([line(0, 0)]))).toThrow("a line is horizontal (h 0) or vertical (w 0)");
    expect(() => canvasLayoutSchema.parse(layoutOf([line(100, 0)]))).not.toThrow();
    expect(() => canvasLayoutSchema.parse(layoutOf([line(0, 100)]))).not.toThrow();
    // A box item keeps both sides.
    expect(() => canvasLayoutSchema.parse(layoutOf([{ ...line(100, 40), kind: "box" as const }]))).not.toThrow();
  });
  it("refuses an empty id", () => {
    expect(() => canvasLayoutSchema.parse(layoutOf([barcode({ id: "" })]))).toThrow(ZodError);
  });
  it("accepts a repeat flag on a below-table item: that rule is the validator's (Task 4), not the schema's", () => {
    expect(() => canvasLayoutSchema.parse(layoutOf([barcode(), table("steps"), field("results", { anchor: { kind: "below-table", table: "steps" }, repeat: true })]))).not.toThrow();
  });
  it("states the page, the grid, the barcode floor and the traveler's four tables", () => {
    expect(CANVAS_PAGE).toEqual({ width: 612, height: 792, margin: 24 });
    expect(CANVAS_GRID).toBe(4.5);
    expect(BARCODE_MIN).toEqual({ width: 186, height: 44 });
    expect(CANVAS_TABLES).toEqual(["lines", "quantities", "inspections", "steps"]);
  });
});
