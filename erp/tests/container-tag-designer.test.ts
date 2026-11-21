/**
 * The designer keeps a container tag's text one line tall (container tag PR 3, Task 2; R12). On a
 * `oneLabel` profile a new field or text item, a cleared page's required field and any resize all
 * honour `oneLineHeight` (the item's line at its size and face, rounded UP to 0.001 so a box of
 * exactly that height passes rule 10's raw comparison), measured in the template's fonts. The Letter
 * documents answer exactly as before. The components' wiring is pinned by parsing their sources.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  clearedLayout, oneLineHeight, placeNew, resizeBox, resizedBox, resizedItem, type PaletteEntry,
} from "@/lib/canvas-designer";
import { canvasPageFor, type CanvasItem, type CanvasLayout } from "@/lib/template-contracts/canvas";
import { CONTAINER_TAG_CONTRACT, DEFAULT_CONFIG } from "@/lib/template-contracts/container-tag";
import { QUOTE_CONTRACT } from "@/lib/template-contracts/quote";
import type { FontsConfig } from "@/lib/template-contracts/types";
import { validateCanvasLayout } from "@/lib/template-canvas";
import { lineHeightOf } from "@/lib/tag-font-metrics";

const TAG = canvasPageFor("CONTAINER_TAG", "4x3-landscape");
const mono: FontsConfig = { ...DEFAULT_CONTAINER_FONTS(), family: "Roboto Mono" };
function DEFAULT_CONTAINER_FONTS(): FontsConfig { return DEFAULT_CONFIG.fonts; }
const empty: CanvasLayout = { version: 1, items: [] };
type FieldItem = Extract<CanvasItem, { kind: "field" }>;

const fieldEntry = (key: string): PaletteEntry => ({ kind: "field", key, label: key, group: "g", state: "available" });
const textEntry: PaletteEntry = { kind: "text", label: "Text", group: "g", state: "available" };

describe("oneLineHeight", () => {
  it("is the line at the item's size and face, rounded up to 0.001", () => {
    const item = { kind: "field", style: { size: 10, bold: false, align: "left" } } as FieldItem;
    expect(oneLineHeight(item, mono)).toBe(13.189);
    expect(oneLineHeight(item, mono)).toBeGreaterThanOrEqual(lineHeightOf("Roboto Mono", "normal", 10));
    const bold = { ...item, style: { ...item.style, bold: true } } as FieldItem;
    expect(oneLineHeight(bold, mono)).toBeGreaterThanOrEqual(lineHeightOf("Roboto Mono", "bold", 10));
  });
});

describe("a container tag in Roboto Mono", () => {
  it("places a new field and a new text one line tall, and both pass the rules", () => {
    for (const entry of [fieldEntry("customer"), textEntry]) {
      const item = placeNew(empty, CONTAINER_TAG_CONTRACT, entry, { page: TAG, fonts: mono });
      expect(item.box.h).toBe(13.189);
      const order = clearedLayout(CONTAINER_TAG_CONTRACT, TAG, mono).items[0];
      const layout: CanvasLayout = { version: 1, items: [order, { ...item, box: { ...item.box, y: 60 } }] };
      expect(() => validateCanvasLayout(layout, CONTAINER_TAG_CONTRACT, { page: TAG, fonts: mono })).not.toThrow();
    }
  });

  it("clears to the required field, one line tall at its size", () => {
    const cleared = clearedLayout(CONTAINER_TAG_CONTRACT, TAG, mono);
    expect(cleared.items).toHaveLength(1);
    const field = cleared.items[0] as FieldItem;
    expect(field.box.h).toBe(oneLineHeight(field, mono));
    expect(() => validateCanvasLayout(cleared, CONTAINER_TAG_CONTRACT, { page: TAG, fonts: mono })).not.toThrow();
  });

  it("stops a bottom-edge drag up at one line", () => {
    const item = { ...clearedLayout(CONTAINER_TAG_CONTRACT, TAG, mono).items[0], box: { x: 14, y: 14, w: 200, h: 40 } } as FieldItem;
    const box = resizeBox(item, "s", 0, -200, CONTAINER_TAG_CONTRACT, TAG, mono);
    expect(box.h).toBe(oneLineHeight(item, mono));
    // Through the stage's two entries too.
    const layout: CanvasLayout = { version: 1, items: [item] };
    expect(resizedBox(item, layout, null, "s", 0, -200, CONTAINER_TAG_CONTRACT, TAG, mono).h).toBe(oneLineHeight(item, mono));
    expect(resizedItem(item, layout, null, "s", 0, -200, CONTAINER_TAG_CONTRACT, TAG, mono)?.box.h).toBe(oneLineHeight(item, mono));
    // A north drag keeps the bottom and floors the top.
    const north = resizeBox(item, "n", 0, 200, CONTAINER_TAG_CONTRACT, TAG, mono);
    expect(north.h).toBe(oneLineHeight(item, mono));
    expect(north.y + north.h).toBe(54);
  });
});

describe("the Letter documents do not move", () => {
  it("places a new field 180 x 12 and floors a resize at one grid step", () => {
    const item = placeNew(empty, QUOTE_CONTRACT, fieldEntry("quote_number"), {});
    expect(item.box.h).toBe(12);
    const resized = resizeBox({ ...item, box: { x: 36, y: 100, w: 180, h: 40 } }, "s", 0, -200, QUOTE_CONTRACT);
    expect(resized.h).toBe(4.5);
  });
});

// Source pins.
const DIR = join(process.cwd(), "src/app/admin/templates/[id]/edit");
function parse(file: string) {
  return ts.createSourceFile(file, readFileSync(join(DIR, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function walk(node: ts.Node, visit: (n: ts.Node) => void) { visit(node); ts.forEachChild(node, (c) => walk(c, visit)); }
function calls(sf: ts.SourceFile, name: string) {
  const found: ts.CallExpression[] = [];
  walk(sf, (n) => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) found.push(n); });
  return found;
}
/** Whether an expression reads `fonts` (the identifier, or `config.fonts`). */
const readsFonts = (n: ts.Node): boolean => {
  let hit = false;
  walk(n, (x) => {
    if (ts.isIdentifier(x) && x.text === "fonts") hit = true;
  });
  return hit;
};
const objectHasFonts = (n: ts.Node | undefined) =>
  n !== undefined && ts.isObjectLiteralExpression(n) && n.properties.some((p) =>
    (ts.isShorthandPropertyAssignment(p) && p.name.text === "fonts") ||
    (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "fonts" && readsFonts(p.initializer)));

describe("the components hand the template's fonts on", () => {
  it("DesignPanel passes fonts to placeNew, canvasRefusal and canvasWarnings, and to the stage", () => {
    const sf = parse("DesignPanel.tsx");
    for (const name of ["placeNew", "canvasRefusal", "canvasWarnings"]) {
      const found = calls(sf, name);
      expect(found.length, name).toBeGreaterThan(0);
      for (const call of found) expect(objectHasFonts(call.arguments.at(-1)), name).toBe(true);
    }
    let stage = false;
    walk(sf, (n) => {
      if (ts.isJsxSelfClosingElement(n) && n.tagName.getText() === "CanvasStage") {
        stage = n.attributes.properties.some((p) => ts.isJsxAttribute(p) && p.name.getText() === "fonts");
      }
    });
    expect(stage).toBe(true);
  });

  it("CanvasStage passes fonts to resizedBox and resizedItem, defaulting to the contract's", () => {
    const sf = parse("CanvasStage.tsx");
    for (const name of ["resizedBox", "resizedItem"]) {
      const found = calls(sf, name);
      expect(found.length, name).toBe(1);
      expect(found[0].arguments.at(-1)?.getText(), name).toBe("fonts");
    }
    expect(readFileSync(join(DIR, "CanvasStage.tsx"), "utf8")).toMatch(/fonts = contract\.fonts/);
  });

  it("TemplateEditor passes the config's fonts to clearedLayout", () => {
    const found = calls(parse("TemplateEditor.tsx"), "clearedLayout");
    expect(found).toHaveLength(1);
    expect(found[0].arguments).toHaveLength(3);
    expect(found[0].arguments[2].getText()).toBe("c.fonts");
  });

  it("CanvasInspector reads the profile's oneLabel to hide Repeat and the other anchors", () => {
    const text = readFileSync(join(DIR, "CanvasInspector.tsx"), "utf8");
    expect(text).toMatch(/canvasProfile\(contract\)\.oneLabel/);
    const sf = parse("CanvasInspector.tsx");
    let gated = 0;
    walk(sf, (n) => {
      if (ts.isConditionalExpression(n) || ts.isBinaryExpression(n)) {
        if (n.getText().includes("oneLabel") || n.getText().includes("oneLabelPaper")) gated++;
      }
    });
    expect(gated).toBeGreaterThanOrEqual(3);
  });
});
