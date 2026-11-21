/**
 * The container tag's canvas profile and the one-label rules (container tag PR 3, Task 1; the
 * container tag design of 2026-11-13, §1 and §7.2). A tag is one label: every item is placed from
 * the label's top and nothing repeats (call 10); a text box is never shorter than one line at its
 * size (R12); and the order number, its label joined to seven of the face's widest digit, fits the
 * label's content width at the item's own size and face (R10, call 18). The profile's `oneLabel`
 * turns the rules on; a Letter profile (the quote's) is untouched by them. These cases call the rules
 * directly; since Task 5 put the tag in CANVAS_PRINTS the registry runs them too, on the tag's page
 * with the config's fonts (tests/container-tag-canvas-seed.test.ts proves that threading).
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  CONTAINER_TAG_CANVAS, CONTAINER_TAG_CONTRACT, DEFAULT_CONFIG,
} from "@/lib/template-contracts/container-tag";
import { QUOTE_CONTRACT } from "@/lib/template-contracts/quote";
import { validateConfig } from "@/lib/template-contracts/index";
import { canvasPageFor, type CanvasAnchor, type CanvasItem, type CanvasLayout } from "@/lib/template-contracts/canvas";
import type { FontsConfig, TemplateContract } from "@/lib/template-contracts/types";
import { canvasRefusal, profileProblems, validateCanvasLayout } from "@/lib/template-canvas";
import { canvasSaveBlock } from "@/lib/template-editor";
import { readSize } from "@/lib/canvas-designer";
import { lineHeightOf, textWidthOf } from "@/lib/tag-font-metrics";
import { quoteField, standardQuoteLayout } from "./helpers/quote-canvas-fixtures";

const TAG = canvasPageFor("CONTAINER_TAG", "4x3-landscape");
const fonts: FontsConfig = DEFAULT_CONFIG.fonts;
const mono: FontsConfig = { ...fonts, family: "Roboto Mono" };
const TOP: CanvasAnchor = { kind: "page-top" };

type FieldItem = Extract<CanvasItem, { kind: "field" }>;
function tagField(key: string, over: Partial<FieldItem> = {}): FieldItem {
  return {
    id: `field-${key}`, kind: "field", key, label: null, box: { x: 14, y: 14, w: 200, h: 12 },
    anchor: TOP, repeat: false, style: { size: 10, bold: false, align: "left" }, ...over,
  };
}
/** The order number as the Standard prints it, 20 pt bold, its box tall enough for one line at that
 *  size in either family (Roboto 23.44 pt, Roboto Mono 26.38). */
function orderNumber(over: Partial<FieldItem> = {}): FieldItem {
  return tagField("order_number", { box: { x: 14, y: 14, w: 200, h: 30 }, style: { size: 20, bold: true, align: "left" }, ...over });
}
const layoutOf = (...items: CanvasItem[]): CanvasLayout => ({ version: 1, items });
/** The order number with the other items below it. */
const withOrder = (...items: CanvasItem[]) => layoutOf(orderNumber(), ...items);

function refusal(layout: CanvasLayout, options: { fonts?: FontsConfig } = {}): string | null {
  try {
    validateCanvasLayout(layout, CONTAINER_TAG_CONTRACT, { page: TAG, ...options });
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

const ANCHOR = "A container tag prints on one label; place every item from the label's top.";
const REPEAT = "A container tag prints on one label; nothing repeats.";
const R10 = (name: string) =>
  `${name} does not fit an order number of 7 digits within the label's width at this size and label; ` +
  "lower its size or shorten its label.";

describe("the container tag's canvas profile", () => {
  it("is the design's profile, set on the contract, and sound", () => {
    expect(CONTAINER_TAG_CANVAS).toEqual({
      paper: "container tag", tables: [],
      required: [{ kind: "field", key: "order_number", reason: "a tag exists to say which work order a container belongs to" }],
      barcode: false, notFields: [], boxedFields: [], ruledFields: [], leastWidths: {}, rowFloor: 0, firstTableRoom: 0,
      oneLabel: { wholeField: { key: "order_number", digits: 7 } },
    });
    expect(CONTAINER_TAG_CONTRACT.canvas).toBe(CONTAINER_TAG_CANVAS);
    expect(profileProblems(CONTAINER_TAG_CONTRACT)).toEqual([]);
  });
  it("names a whole field that is no field of the contract", () => {
    const contract: TemplateContract = {
      ...CONTAINER_TAG_CONTRACT,
      canvas: { ...CONTAINER_TAG_CANVAS, oneLabel: { wholeField: { key: "no_such_field", digits: 7 } } },
    };
    expect(profileProblems(contract)).toEqual([
      'The oneLabel whole field "no_such_field" is not a field of the contract.',
    ]);
  });
  it("refuses a layout without the order number in PR 2's field sentence", () => {
    expect(refusal(layoutOf(tagField("customer"))))
      .toBe("The canvas has no Order number; a tag exists to say which work order a container belongs to.");
  });
  it("is accepted by the registry: the tag's canvas prints (Task 5)", () => {
    expect(validateConfig("CONTAINER_TAG", { ...DEFAULT_CONFIG, layout: withOrder() }).layout).toEqual(withOrder());
  });
  it("accepts the order number alone, at the Standard's 20 pt bold", () => {
    expect(refusal(withOrder())).toBeNull();
  });
});

describe("one label: page-top only, and nothing repeats (call 10)", () => {
  it("refuses an item anchored below a table, in the anchor sentence", () => {
    expect(refusal(withOrder(tagField("customer", { box: { x: 14, y: 4, w: 200, h: 12 }, anchor: { kind: "below-table", table: "lines" } }))))
      .toBe(ANCHOR);
  });
  it("refuses an item anchored at the page's bottom, in the anchor sentence", () => {
    expect(refusal(withOrder(tagField("customer", { box: { x: 14, y: 180, w: 200, h: 12 }, anchor: { kind: "page-bottom" } }))))
      .toBe(ANCHOR);
  });
  it("refuses a page-top item set to repeat, in the repeat sentence", () => {
    expect(refusal(withOrder(tagField("customer", { box: { x: 14, y: 60, w: 200, h: 12 }, repeat: true })))).toBe(REPEAT);
    expect(refusal(layoutOf(orderNumber({ repeat: true })))).toBe(REPEAT);
  });
  it("leaves a Letter profile alone: the quote's Standard, with its repeated page-top item, is accepted", () => {
    const layout = standardQuoteLayout();
    expect(layout.items.some((item) => item.repeat && item.anchor.kind === "page-top")).toBe(true);
    expect(() => validateCanvasLayout(layout, QUOTE_CONTRACT)).not.toThrow();
  });
});

describe("R12: a text box is at least one line of its text", () => {
  const roboto = lineHeightOf("Roboto", "normal", 10);
  const robotoMono = lineHeightOf("Roboto Mono", "normal", 10);
  it("reads the line heights the box is judged against", () => {
    expect(roboto).toBeLessThan(12);
    expect(robotoMono).toBeGreaterThan(12);
  });
  const customer = tagField("customer", { box: { x: 14, y: 60, w: 200, h: 12 } });
  it("accepts a 12 pt box at 10 pt in Roboto, the template's fonts given or the contract's read", () => {
    expect(refusal(withOrder(customer), { fonts })).toBeNull();
    expect(refusal(withOrder(customer))).toBeNull();
  });
  it("refuses the same box in Roboto Mono, naming the least height in inches, rounded up", () => {
    expect(refusal(withOrder(customer), { fonts: mono }))
      .toBe("The Customer field is shorter than one line of its text; draw it at least 0.19 in tall.");
  });
  // The final review's I1: the sentence's height, typed into the inspector and snapped to the grid as
  // `readSize` snaps it, must clear the refusal it came from. It names the least grid height at or
  // above one line, in inches rounded up, never the raw line height (which can snap back below it).
  const typedFrom = (sentence: string): number => {
    const inches = /draw it at least (\d+\.\d\d) in tall\.$/.exec(sentence)?.[1];
    expect(inches, sentence).toBeDefined();
    const read = readSize("h")(inches!);
    if (!("value" in read)) throw new Error(read.refusal);
    return read.value;
  };
  it("names a height that, typed and snapped, clears it: Order # at 20 bold", () => {
    const short = orderNumber({ box: { x: 14, y: 14, w: 200, h: 18 } });
    const sentence = refusal(layoutOf(short));
    expect(sentence).toBe("The Order number field is shorter than one line of its text; draw it at least 0.38 in tall.");
    const h = typedFrom(sentence!);
    expect(h).toBe(27);
    expect(refusal(layoutOf(orderNumber({ box: { ...short.box, h } })))).toBeNull();
  });
  it("names a height that, typed and snapped, clears it: Customer at 12 bold", () => {
    const bold12 = { size: 12, bold: true, align: "left" as const };
    const short = tagField("customer", { box: { x: 14, y: 60, w: 200, h: 9 }, style: bold12 });
    const sentence = refusal(withOrder(short));
    expect(sentence).toBe("The Customer field is shorter than one line of its text; draw it at least 0.25 in tall.");
    const h = typedFrom(sentence!);
    expect(h).toBe(18);
    expect(refusal(withOrder(tagField("customer", { box: { ...short.box, h }, style: bold12 })))).toBeNull();
  });
  it("holds a text item to the same floor", () => {
    const text: CanvasItem = {
      id: "t1", kind: "text", text: "Heat treated", box: { x: 14, y: 60, w: 200, h: 12 },
      anchor: TOP, repeat: false, style: { size: 10, bold: false, align: "left" },
    };
    expect(refusal(withOrder(text), { fonts })).toBeNull();
    expect(refusal(withOrder(text), { fonts: mono }))
      .toBe("The Text (text t1) is shorter than one line of its text; draw it at least 0.19 in tall.");
  });
  it("exempts a line, a box and a logo", () => {
    const common = { anchor: TOP, repeat: false } as const;
    const items: CanvasItem[] = [
      { ...common, id: "l1", kind: "line", weight: 1, box: { x: 14, y: 60, w: 200, h: 0 } },
      { ...common, id: "b1", kind: "box", weight: 1, box: { x: 14, y: 70, w: 200, h: 4 } },
      { ...common, id: "g1", kind: "logo", box: { x: 14, y: 80, w: 40, h: 4 } },
    ];
    expect(refusal(withOrder(...items), { fonts: mono })).toBeNull();
  });
  it("is not a Letter rule: the quote's title in a 12 pt box at 20 pt is accepted", () => {
    const title = quoteField("title", { box: { x: 202, y: 24, w: 208, h: 12 }, style: { size: 20, bold: true, align: "center" } });
    const layout = { ...standardQuoteLayout() };
    layout.items = layout.items.map((item) => (item.id === title.id ? title : item));
    expect(() => validateCanvasLayout(layout, QUOTE_CONTRACT, { fonts: mono })).not.toThrow();
  });
  it("reaches the editor's Save check through the config's fonts", () => {
    const layout = withOrder(customer);
    expect(canvasSaveBlock(CONTAINER_TAG_CONTRACT, { ...DEFAULT_CONFIG, layout })).toBeNull();
    expect(canvasSaveBlock(CONTAINER_TAG_CONTRACT, { ...DEFAULT_CONFIG, fonts: mono, layout }))
      .toBe("The Customer field is shorter than one line of its text; draw it at least 0.19 in tall.");
    expect(canvasRefusal(layout, CONTAINER_TAG_CONTRACT, { page: TAG, fonts: mono })?.sentence)
      .toBe("The Customer field is shorter than one line of its text; draw it at least 0.19 in tall.");
  });
});

describe("R10: the order number fits the label's width at its item's size and face (call 18)", () => {
  const name = "The Order number field";
  const tall = { x: 14, y: 14, w: 200, h: 60 };
  it("measures the join of the item's label and seven widest digits against the content width", () => {
    expect(TAG.width - 2 * TAG.margin).toBe(260);
    expect(textWidthOf("Work order number 0000000", "Roboto", "bold", 20)).toBeLessThanOrEqual(260);
    expect(textWidthOf("Work order number: 0000000", "Roboto", "bold", 20)).toBeGreaterThan(260);
    expect(textWidthOf("Work order number: 0000000", "Roboto", "normal", 20)).toBeLessThanOrEqual(260);
  });
  it("accepts Order # at 20 bold and refuses it at 48 bold", () => {
    expect(refusal(layoutOf(orderNumber()))).toBeNull();
    expect(refusal(layoutOf(orderNumber({ box: tall, style: { size: 48, bold: true, align: "left" } })))).toBe(R10(name));
  });
  it("reads the item's own label: Work order number fits at 20 bold, Work order number: does not", () => {
    expect(refusal(layoutOf(orderNumber({ label: "Work order number" })))).toBeNull();
    expect(refusal(layoutOf(orderNumber({ label: "Work order number:" })))).toBe(R10(name));
  });
  it("reads the face from the item's bold: the same label fits at 20 not bold", () => {
    expect(refusal(layoutOf(orderNumber({ label: "Work order number:", style: { size: 20, bold: false, align: "left" } }))))
      .toBeNull();
  });
  it("measures a blank label as the value alone", () => {
    expect(refusal(layoutOf(orderNumber({ label: "", box: tall, style: { size: 48, bold: true, align: "left" } })))).toBeNull();
  });
  it("judges the label's width, never the box's", () => {
    expect(refusal(layoutOf(orderNumber({ box: { x: 14, y: 14, w: 40, h: 30 } })))).toBeNull();
  });
  it("reads the family: Work order number at 20 bold does not fit in Roboto Mono", () => {
    expect(refusal(layoutOf(orderNumber({ label: "Work order number" })), { fonts: mono })).toBe(R10(name));
  });
});

describe("the registry hands the rules the config's fonts (proven by behaviour in Task 5)", () => {
  it("withCanvasRules passes fonts: config.fonts to validateCanvasLayout", () => {
    const src = readFileSync("src/lib/template-contracts/index.ts", "utf8");
    const file = ts.createSourceFile("index.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let fn: ts.FunctionDeclaration | undefined;
    file.forEachChild((node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "withCanvasRules") fn = node;
    });
    expect(fn).toBeDefined();
    const passed: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "validateCanvasLayout") {
        const options = node.arguments[2];
        if (options !== undefined && ts.isObjectLiteralExpression(options)) {
          for (const prop of options.properties) {
            if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "fonts") {
              passed.push(prop.initializer.getText(file));
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(fn!);
    expect(passed).toEqual(["config.fonts"]);
  });
});
