/**
 * The canvas rules read the template's page (container tag PR 2, Task 1): `canvasPageFor` answers it,
 * every page reader takes it as a last optional argument defaulting to Letter, and the registry's
 * `withCanvasRules` and the editor's `canvasSaveBlock` hand it on.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { canvasPageFor, CANVAS_PAGE, type CanvasLayout } from "@/lib/template-contracts/canvas";
import { TEMPLATE_DOC_TYPES, type CanvasProfile, type TemplateConfig } from "@/lib/template-contracts/types";
import {
  bandHeight, bandTop, canvasRefusal, continuedBox, pageFoot, topMargin, usableHeight, validateCanvasLayout,
} from "@/lib/template-canvas";
import { canvasSaveBlock } from "@/lib/template-editor";
import { testContract } from "./helpers/test-contract";
import type { TemplateContract } from "@/lib/template-contracts/types";

const TAG = { width: 288, height: 216, margin: 14 };
const empty: CanvasLayout = { version: 1, items: [] };
const profile: CanvasProfile = {
  paper: "tag", tables: [], required: [], barcode: false, notFields: [], boxedFields: [], ruledFields: [],
  leastWidths: {}, rowFloor: 12, firstTableRoom: 24,
};
const field = (x: number, y: number, w: number, h: number): CanvasLayout => ({
  version: 1,
  items: [{
    id: "f1", kind: "field", key: "quote_number", label: null, box: { x, y, w, h },
    anchor: { kind: "page-top" }, repeat: false, style: { size: 10, bold: false, align: "left" },
  }],
});
const contract = (docType = "TEST"): TemplateContract =>
  ({ ...testContract(profile), docType: docType as TemplateContract["docType"] });

describe("canvasPageFor", () => {
  it("gives Letter to the eight and the label size to the tag", () => {
    for (const type of TEMPLATE_DOC_TYPES) {
      if (type === "CONTAINER_TAG") continue;
      expect(canvasPageFor(type)).toBe(CANVAS_PAGE);
      expect(canvasPageFor(type, "4x3-landscape")).toBe(CANVAS_PAGE);
    }
    expect(canvasPageFor("CONTAINER_TAG", "4x3-landscape")).toEqual(TAG);
    expect(canvasPageFor("CONTAINER_TAG")).toEqual(TAG);
  });
  it("hands back one object per label size, not a new one per call", () => {
    expect(canvasPageFor("CONTAINER_TAG", "4x3-landscape")).toBe(canvasPageFor("CONTAINER_TAG", "4x3-landscape"));
    expect(canvasPageFor("CONTAINER_TAG")).toBe(canvasPageFor("CONTAINER_TAG", "4x3-landscape"));
    expect(canvasPageFor("QUOTE")).toBe(CANVAS_PAGE);
  });
});

describe("the page functions", () => {
  it("read the page they are handed", () => {
    expect(pageFoot(false, TAG)).toBe(202);
    expect(pageFoot(true, TAG)).toBe(182);
    expect(topMargin(empty, TAG)).toBe(14);
    expect(bandTop(empty, false, TAG)).toBe(202);
    expect(bandHeight(empty, false, TAG)).toBe(0);
    expect(usableHeight(empty, false, TAG)).toBe(202 - 14);
    const repeating: CanvasLayout = { version: 1, items: [{ ...field(14, 14, 100, 12).items[0], repeat: true }] };
    expect(continuedBox(repeating, TAG)?.x).toBe(14);
  });
  it("default to Letter", () => {
    expect(pageFoot()).toBe(768);
    expect(pageFoot(true)).toBe(748);
    expect(topMargin(empty)).toBe(24);
    expect(bandTop(empty)).toBe(768);
    expect(usableHeight(empty)).toBe(768 - 24);
    const repeating: CanvasLayout = { version: 1, items: [{ ...field(24, 24, 100, 12).items[0], repeat: true }] };
    expect(continuedBox(repeating)).toEqual(continuedBox(repeating, CANVAS_PAGE));
    expect(continuedBox(repeating)?.x).toBe(24);
  });
});

describe("rule 4 on the tag page", () => {
  it("judges the page it is handed", () => {
    const c = contract();
    expect(() => validateCanvasLayout(field(14, 14, 200, 12), c, { page: TAG })).not.toThrow();
    expect(canvasRefusal(field(100, 30, 200, 12), c, { page: TAG })?.sentence)
      .toMatch(/lies outside the page: its right edge is at 300 pt, past 274/);
    expect(canvasRefusal(field(30, 195, 200, 12), c, { page: TAG })?.sentence)
      .toMatch(/lies outside the page: its bottom edge is at 207 pt, past 202/);
    expect(validateCanvasLayout(field(100, 30, 200, 12), c)).toBeUndefined();
    expect(validateCanvasLayout(field(30, 195, 200, 12), c)).toBeUndefined();
  });
});

describe("the editor's save check", () => {
  const config = (layout: CanvasLayout) => ({
    layout, pageFooter: false, formats: { labelSize: "4x3-landscape" },
  }) as unknown as TemplateConfig;
  it("judges the template's page", () => {
    const layout = field(100, 30, 200, 12);
    expect(canvasSaveBlock(contract("CONTAINER_TAG"), config(layout))).toMatch(/past 274/);
    expect(canvasSaveBlock(contract("TEST"), config(layout))).toBeNull();
  });
});

describe("the registry", () => {
  it("passes the template's page", () => {
    const src = readFileSync(join(__dirname, "../src/lib/template-contracts/index.ts"), "utf8");
    const sf = ts.createSourceFile("index.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let withCanvasRules: ts.FunctionDeclaration | undefined;
    sf.forEachChild((n) => { if (ts.isFunctionDeclaration(n) && n.name?.text === "withCanvasRules") withCanvasRules = n; });
    expect(withCanvasRules).toBeDefined();
    const hits: boolean[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "validateCanvasLayout") {
        const opts = n.arguments[2];
        const prop = opts && ts.isObjectLiteralExpression(opts)
          ? opts.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "page")
          : undefined;
        const init = prop?.initializer;
        hits.push(init !== undefined && ts.isCallExpression(init) && ts.isIdentifier(init.expression)
          && init.expression.text === "canvasPageFor" && init.arguments.length === 2
          && init.arguments[0].getText() === "docType"
          && init.arguments[1].getText().replace(/\s/g, "") === "config.formats.labelSize");
      }
      ts.forEachChild(n, visit);
    };
    visit(withCanvasRules!);
    expect(hits).toEqual([true]);
  });
});
