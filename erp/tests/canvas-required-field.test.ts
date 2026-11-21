/**
 * A canvas profile can require a FIELD (container tag PR 2, Task 4): rule 2 refuses a layout without
 * it, rule 6 does not judge it (a box may be drawn around it), and the designer treats it as required.
 */
import { describe, expect, it } from "vitest";
import type { CanvasItem, CanvasLayout } from "@/lib/template-contracts/canvas";
import type { CanvasProfile, TemplateContract } from "@/lib/template-contracts/types";
import { canvasWarnings, validateCanvasLayout } from "@/lib/template-canvas";
import {
  DESIGNER_WORDS, clearedLayout, edges, isRequired, paletteEntries,
} from "@/lib/canvas-designer";
import { testContract } from "./helpers/test-contract";

const TAG = { width: 288, height: 216, margin: 14 };
const profile: CanvasProfile = {
  paper: "tag", tables: [], barcode: false, notFields: [], boxedFields: [], ruledFields: [],
  required: [{ kind: "field", key: "quote_number", reason: "a test reason" }],
  leastWidths: {}, rowFloor: 12, firstTableRoom: 24,
};
const contract: TemplateContract = testContract(profile);
const fieldName = contract.sections.flatMap((s) => s.fields).find((f) => f.key === "quote_number")!.name;
const style = { size: 10, bold: false, align: "left" as const };
const field = (key: string, id = "f1"): CanvasItem => ({
  id, kind: "field", key, label: null, box: { x: 30, y: 30, w: 120, h: 12 },
  anchor: { kind: "page-top" }, repeat: false, style,
});
const layoutOf = (...items: CanvasItem[]): CanvasLayout => ({ version: 1, items });
const refusal = `The canvas has no ${fieldName}; a test reason.`;

describe("rule 2 for a required field", () => {
  it("refuses a layout with no field item of the key", () => {
    expect(() => validateCanvasLayout(layoutOf(), contract)).toThrow(refusal);
  });
  it("accepts the layout holding the field", () => {
    expect(() => validateCanvasLayout(layoutOf(field("quote_number")), contract)).not.toThrow();
  });
  it("still refuses a field of another key and a text item reading its name", () => {
    expect(() => validateCanvasLayout(layoutOf(field("customer_name")), contract)).toThrow(refusal);
    const text: CanvasItem = {
      id: "t1", kind: "text", text: fieldName, box: { x: 30, y: 30, w: 120, h: 12 },
      anchor: { kind: "page-top" }, repeat: false, style,
    };
    expect(() => validateCanvasLayout(layoutOf(text), contract)).toThrow(refusal);
  });
});

describe("rule 6 does not judge a required field", () => {
  const box: CanvasItem = {
    id: "b1", kind: "box", weight: 1, box: { x: 30, y: 30, w: 120, h: 12 },
    anchor: { kind: "page-top" }, repeat: false,
  };
  const layout = layoutOf(field("quote_number"), box);
  it("accepts a box drawn around it", () => {
    expect(() => validateCanvasLayout(layout, contract)).not.toThrow();
  });
  it("warning (a) still reports the overlap", () => {
    const warnings = canvasWarnings(layout, contract);
    expect(warnings.some((w) => /overlap/.test(w.sentence))).toBe(true);
  });
});

describe("the designer on a required field", () => {
  it("isRequired is true for the field and false for another key", () => {
    expect(isRequired({ kind: "field", key: "quote_number" }, contract)).toBe(true);
    expect(isRequired({ kind: "field", key: "customer_name" }, contract)).toBe(false);
    expect(isRequired({ kind: "table", key: "quote_number" }, contract)).toBe(false);
  });
  it("clearedLayout holds exactly the field at the page's top-left corner", () => {
    const cleared = clearedLayout(contract, TAG);
    const { left, top, right, bottom } = edges(TAG);
    expect(cleared.items).toHaveLength(1);
    const [item] = cleared.items;
    expect(item.kind).toBe("field");
    expect(item).toMatchObject({ key: "quote_number", box: { x: 14, y: 14, w: 180, h: 12 } });
    expect(item.box.x + item.box.w).toBeLessThanOrEqual(right);
    expect(item.box.y + item.box.h).toBeLessThanOrEqual(bottom);
    expect([item.box.x, item.box.y]).toEqual([left, top]);
    expect([left, top, right, bottom]).toEqual([14, 14, 274, 202]);
    expect(cleared.items.some((i) => i.kind === "table")).toBe(false);
  });
  it("names the field, not a table, in the refusal and the clear-page confirm", () => {
    expect(DESIGNER_WORDS.cannotRemove(contract)).toBe(
      `The ${fieldName} is on every tag; it can be moved, not removed.`,
    );
    expect(DESIGNER_WORDS.clearPageConfirm(contract)).toContain(`but the ${fieldName} is removed`);
    expect(DESIGNER_WORDS.cannotRemove(contract)).not.toMatch(/table/);
  });
  it("marks the field's palette entry available until it is placed, then required", () => {
    const state = (layout: CanvasLayout) =>
      paletteEntries(layout, contract).find((e) => e.kind === "field" && e.key === "quote_number")?.state;
    expect(state(layoutOf())).toBe("available");
    expect(state(layoutOf(field("quote_number")))).toBe("required");
    const others = paletteEntries(layoutOf(), contract).filter((e) => e.kind === "field" && e.key !== "quote_number");
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((e) => e.state === "available")).toBe(true);
  });
});
