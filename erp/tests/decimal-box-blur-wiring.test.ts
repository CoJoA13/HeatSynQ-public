import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The rate and money boxes of the customer, Accounting and Surcharges screens (decimal entry design,
// #517): which commit function each box's blur hands off to. The lifted suites (admin-rate-boxes,
// rate-single-boxes, money-single-boxes) prove what each `commit*` function decides; they cannot see
// whether the box's `onBlur` calls it. A box whose blur went back to an inline save would keep every
// one of those green and send an unchecked figure.
//
// Each box is found by its `value` attribute (which names the field), and its `onBlur` attribute must
// reference the commit function, or call it with the field it was written for. Fail closed: a marker
// that matches no element or more than one, a box with no `onBlur`, and a missing function all fail.
// vitest has no DOM, so this reads the pages as syntax trees, the lines-section-wiring.test.ts way.

type Src = { file: string; source: ts.SourceFile };
function load(relative: string): Src {
  const file = fileURLToPath(new URL(relative, import.meta.url));
  return { file, source: ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX) };
}
function all<T extends ts.Node>(root: ts.Node, is: (node: ts.Node) => node is T): T[] {
  const out: T[] = [];
  const walk = (node: ts.Node): void => { if (is(node)) out.push(node); ts.forEachChild(node, walk); };
  walk(root);
  return out;
}
function attribute(el: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return el.attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name,
  );
}
/** The `onBlur` attribute of the one element whose `value` attribute spells `marker`. */
function blurOf(src: Src, marker: string): ts.JsxAttribute {
  const elements = [...all(src.source, ts.isJsxSelfClosingElement), ...all(src.source, ts.isJsxOpeningElement)]
    .filter((el) => attribute(el, "value")?.getText(src.source).includes(marker));
  expect(elements, `elements whose value spells ${marker}`).toHaveLength(1);
  const blur = attribute(elements[0], "onBlur");
  if (!blur) throw new Error(`The box whose value spells ${marker} has no onBlur`);
  return blur;
}
function declared(src: Src, name: string): void {
  const found = all(src.source, ts.isFunctionDeclaration).filter((f) => f.name?.text === name);
  expect(found, `function ${name}`).toHaveLength(1);
}
const references = (root: ts.Node, name: string) =>
  all(root, ts.isIdentifier).filter((id) => id.text === name);
const callsTo = (root: ts.Node, name: string) =>
  all(root, ts.isCallExpression).filter((c) => ts.isIdentifier(c.expression) && c.expression.text === name);

describe("the customer page's rate and money boxes hand their blur to their commit function", () => {
  const src = load("../src/app/customers/[id]/page.tsx");
  for (const [marker, commit] of [
    ["c.creditLimit", "commitCreditLimit"],
    ["c.financeChargeRate", "commitFinanceCharge"],
    ["c.salesTaxRate", "commitSalesTaxRate"],
    // Ruling 19 (G5-4): the whole-number box, through the whole-number rule.
    ["c.requestDaysOverride", "commitRequestDaysOverride"],
  ] as const) {
    it(`${marker} -> ${commit}`, () => {
      declared(src, commit);
      const blur = blurOf(src, marker);
      expect(callsTo(blur, "onBlurSave")).toHaveLength(1);
      expect(references(blur, commit)).toHaveLength(1);
    });
  }
});

describe("the customer's surcharge override boxes hand their blur to their commit function", () => {
  const src = load("../src/app/customers/[id]/SurchargeOverridesSection.tsx");
  for (const [marker, commit] of [
    ["draftValue(rateKey", "commitRateOverride"],
    ["draftValue(amountKey", "commitAmountOverride"],
  ] as const) {
    it(`${marker} -> ${commit}`, () => {
      declared(src, commit);
      const calls = callsTo(blurOf(src, marker), commit);
      expect(calls).toHaveLength(1);
      expect(calls[0].arguments[0].getText(src.source)).toBe("row");
    });
  }
});

describe("Accounting's boxes hand their blur to commitBillingDecimal", () => {
  const src = load("../src/app/admin/billing/page.tsx");
  it("blurDecimal commits through commitBillingDecimal with the box's key", () => {
    declared(src, "blurDecimal");
    declared(src, "commitBillingDecimal");
    const blurDecimal = all(src.source, ts.isFunctionDeclaration).find((f) => f.name?.text === "blurDecimal")!;
    const calls = callsTo(blurDecimal, "commitBillingDecimal");
    expect(calls).toHaveLength(1);
    expect(calls[0].arguments[0].getText(src.source)).toBe("key");
    expect(callsTo(blurDecimal, "save")).toHaveLength(0);
  });
  for (const key of ["salesTaxRate", "certChargeDefault", "financeChargeRate"]) {
    it(`cfg.${key} blurs through blurDecimal("${key}")`, () => {
      const calls = callsTo(blurOf(src, `cfg.${key}`), "blurDecimal");
      expect(calls).toHaveLength(1);
      expect(calls[0].arguments.map((a) => a.getText(src.source))).toEqual([`"${key}"`]);
    });
  }
});

describe("Surcharges' open-row boxes hand their blur to commitSurchargeBox", () => {
  const src = load("../src/app/admin/surcharges/page.tsx");
  for (const field of ["rate", "amount", "minimumAmount"]) {
    it(`${field} -> commitSurchargeBox(current.id, "${field}", value)`, () => {
      declared(src, "commitSurchargeBox");
      const calls = callsTo(blurOf(src, "`${current.id}." + field + "`"), "commitSurchargeBox");
      expect(calls).toHaveLength(1);
      expect(calls[0].arguments.map((a) => a.getText(src.source))).toEqual(["current.id", `"${field}"`, "value"]);
    });
  }
});

describe("the part page's Each weight, Load weight, Load quantity and Request days override hand their blur to their commit function", () => {
  const src = load("../src/app/parts/[id]/IdentitySection.tsx");
  for (const [marker, commit] of [
    ["part.eachWeight", "commitEachWeight"],
    ["part.loadWeight", "commitLoadWeight"],
    // Ruling 19 (G5-4): the two whole-number boxes, through the whole-number rule.
    ["part.loadQty", "commitLoadQty"],
    ["part.requestDaysOverride", "commitRequestDaysOverride"],
  ] as const) {
    it(`${marker} -> ${commit}`, () => {
      declared(src, commit);
      const blur = blurOf(src, marker);
      expect(callsTo(blur, "onBlurSave")).toHaveLength(1);
      expect(references(blur, commit)).toHaveLength(1);
    });
  }
});

describe("a part's Inspections Min and Max hand their blur to blurSave, and blurSave to commitInspectionLimit through commitBox", () => {
  const src = load("../src/app/parts/[id]/InspectionsSection.tsx");
  for (const [marker, field] of [["r.min", "min"], ["r.max", "max"]] as const) {
    it(`${marker} -> blurSave(e, r.id, "${field}")`, () => {
      declared(src, "blurSave");
      const calls = callsTo(blurOf(src, marker), "blurSave");
      expect(calls).toHaveLength(1);
      expect(calls[0].arguments.map((a) => a.getText(src.source))).toEqual(["e", "r.id", `"${field}"`]);
    });
  }
  it("blurSave leaves the box through the at-focus record with commitBox, which reaches commitInspectionLimit for min and max", () => {
    declared(src, "commitInspectionLimit");
    declared(src, "commitBox");
    const blurSave = all(src.source, ts.isFunctionDeclaration).find((f) => f.name?.text === "blurSave")!;
    const leave = callsTo(blurSave, "leaveBox");
    expect(leave).toHaveLength(1);
    expect(leave[0].arguments.map((a) => a.getText(src.source))).toEqual(["focus.current", "boxKey(id, field)", "e.target.value", "commitBox(id, field)"]);
    const commitBox = all(src.source, ts.isFunctionDeclaration).find((f) => f.name?.text === "commitBox")!;
    const calls = callsTo(commitBox, "commitInspectionLimit");
    expect(calls).toHaveLength(1);
    expect(calls[0].arguments.map((a) => a.getText(src.source))).toEqual(["id", "field", "value", "atFocus"]);
    expect(commitBox.getText(src.source)).toMatch(/field === "min" \|\| field === "max"/);
  });
  it("commitInspectionLimit restores the box to its text at focus and answers false before saveBox", () => {
    const fn = all(src.source, ts.isFunctionDeclaration).find((f) => f.name?.text === "commitInspectionLimit")!;
    const restore = callsTo(fn, "setRowField");
    expect(restore).toHaveLength(1);
    expect(restore[0].arguments.map((a) => a.getText(src.source))).toEqual(["id", "field", "atFocus"]);
    expect(callsTo(fn, "decimalRefusal")).toHaveLength(1);
    expect(callsTo(fn, "saveBox")).toHaveLength(1);
    const text = fn.getText(src.source);
    const at = text.indexOf("setRowField"); const ret = text.indexOf("return false", at);
    expect(at).toBeGreaterThan(-1);
    expect(ret).toBeGreaterThan(at);
    expect(ret).toBeLessThan(text.indexOf("saveBox"));
  });
  it("add() checks Min and Max through decimalRefusal after its two guards", () => {
    const add = all(src.source, ts.isFunctionDeclaration).find((f) => f.name?.text === "add")!;
    expect(callsTo(add, "decimalRefusal")).toHaveLength(2);
    const text = add.getText(src.source);
    expect(text.indexOf("rowsReady")).toBeLessThan(text.indexOf("decimalRefusal"));
    expect(text.indexOf("decimalRefusal")).toBeLessThan(text.indexOf("api("));
  });
});
