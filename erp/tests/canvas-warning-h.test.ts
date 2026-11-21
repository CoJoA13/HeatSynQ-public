/**
 * Warning (h) of `canvasWarnings` (container tag PR 3, Task 3): what the measure says about a tag's
 * value. A measure item may carry `cut` (the value was cut at its box's edge), `past` (it ran past
 * its box) or `parts` (the part lines showed k of n parts); each is reported for the item that
 * carries it, parts only when k < n, and nothing for an item the measure does not hold. A measure
 * without the fields gives exactly the warnings it gave before.
 */
import { describe, expect, it } from "vitest";
import { CONTAINER_TAG_CONTRACT, DEFAULT_CONFIG } from "@/lib/template-contracts/container-tag";
import { QUOTE_CONTRACT } from "@/lib/template-contracts/quote";
import { TRAVELER_CONTRACT } from "@/lib/template-contracts/traveler";
import { canvasPageFor, type CanvasItem, type CanvasLayout } from "@/lib/template-contracts/canvas";
import { canvasWarnings, type CanvasMeasure } from "@/lib/template-canvas";
import { parseMeasure } from "@/lib/template-editor";
import { standardQuoteLayout } from "./helpers/quote-canvas-fixtures";

const TAG = canvasPageFor("CONTAINER_TAG", "4x3-landscape");
type FieldItem = Extract<CanvasItem, { kind: "field" }>;
const tagField = (key: string, y: number): FieldItem => ({
  id: `field-${key}`, kind: "field", key, label: null, box: { x: 14, y, w: 200, h: 14 },
  anchor: { kind: "page-top" }, repeat: false, style: { size: 10, bold: false, align: "left" },
});
const customer = tagField("customer", 14);
const layout: CanvasLayout = { version: 1, items: [customer, tagField("order_number", 40)] };
const measureOf = (...items: Partial<CanvasMeasure["items"][number]>[]): CanvasMeasure => ({
  pages: 1, tables: [], regions: [],
  items: items.map((i) => ({ id: customer.id, page: 1, left: 14, top: 14, height: 14, ...i })),
});
const run = (measure?: CanvasMeasure) =>
  canvasWarnings(layout, CONTAINER_TAG_CONTRACT, measure, { page: TAG, fonts: DEFAULT_CONFIG.fonts })
    .filter((w) => w.itemIds.includes(customer.id) && /for this record/.test(w.sentence));

describe("canvasWarnings (h)", () => {
  it("names a value cut at its box's edge", () => {
    const out = run(measureOf({ cut: true }));
    expect(out).toHaveLength(1);
    expect(out[0].itemIds).toEqual([customer.id]);
    expect(out[0].sentence).toMatch(/is cut at its box's edge for this record\.$/);
  });

  it("names a value that runs past its box", () => {
    const out = run(measureOf({ past: true }));
    expect(out).toHaveLength(1);
    expect(out[0].sentence).toMatch(/runs past its box for this record\.$/);
  });

  it("names parts that show fewer than the record holds, and only then", () => {
    const out = run(measureOf({ parts: { shown: 5, total: 8 } }));
    expect(out).toHaveLength(1);
    expect(out[0].sentence).toMatch(/shows 5 of 8 parts for this record\.$/);
    expect(run(measureOf({ parts: { shown: 3, total: 3 } }))).toEqual([]);
  });

  it("opens each sentence with the item's name", () => {
    const out = run(measureOf({ cut: true, past: true, parts: { shown: 1, total: 2 } }));
    expect(out).toHaveLength(3);
    for (const w of out) expect(w.sentence.startsWith("The ")).toBe(true);
  });

  it("reports nothing for an item the measure does not hold, or no measure", () => {
    expect(run(measureOf({ id: "field-other", cut: true }))).toEqual([]);
    expect(run(undefined)).toEqual([]);
    expect(run(measureOf({}))).toEqual([]);
  });

  it("changes no existing warning when the fields are absent", () => {
    // A traveler overlap, as today.
    const text = (id: string, box: { x: number; y: number; w: number; h: number }): CanvasItem => ({
      id, kind: "text", text: id, box, anchor: { kind: "page-top" }, repeat: false,
      style: { size: 10, bold: false, align: "left" },
    }) as CanvasItem;
    const a = text("a", { x: 24, y: 100, w: 60, h: 12 });
    const b = text("b", { x: 50, y: 106, w: 60, h: 12 });
    const m: CanvasMeasure = { pages: 1, tables: [], regions: [], items: [] };
    const plain = canvasWarnings({ version: 1, items: [a, b] } as CanvasLayout, TRAVELER_CONTRACT, m);
    expect(plain.some((w) => w.sentence.includes("overlap"))).toBe(true);
    expect(plain.some((w) => /for this record/.test(w.sentence))).toBe(false);
    // The quote's standard layout against an empty measure.
    const q = standardQuoteLayout();
    expect(canvasWarnings(q, QUOTE_CONTRACT, { pages: 1, tables: [], regions: [], items: [] })
      .some((w) => /for this record/.test(w.sentence))).toBe(false);
  });

  it("parseMeasure passes the three fields through unchanged", () => {
    const measure = measureOf({ cut: true, past: true, parts: { shown: 2, total: 5 } });
    expect(parseMeasure(encodeURIComponent(JSON.stringify(measure)))).toEqual(measure);
  });
});
