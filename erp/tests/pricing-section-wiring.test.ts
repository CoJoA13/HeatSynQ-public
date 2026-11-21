import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { breakBoxRefusal, rowBoxRefusal } from "@/lib/pricing-refusals";
import { breakTextKey, withoutBreakText } from "@/lib/price-break-texts";
import { normalizePriceText } from "@/lib/price-display";
import { BREAK_PRICE, BREAK_THRESHOLD } from "@/lib/price-boxes";
import { all, run } from "./helpers/source-lift";
import { jsxTags } from "./helpers/jsx-source";
import { sameSentValue } from "../src/lib/line-field-saves";
import { isEnterCommit } from "../src/lib/enter-commit";

// #652: the part page's Pricing section used to land every reload with a bare `setRows(data)`,
// so a reload (every add, remove, move and every failed save's rollback) put the stored figure
// back under the cursor of a sibling box, and the blur then found it equal to its at-focus text
// and sent nothing. The section now takes the page's edit guard: its three money boxes register
// as keyed cells of the "prices" collection and `load` lands through `applyRows`, so the cell
// under the cursor keeps its typed text while every other row refreshes (the guard's own suite
// proves the merge; this file proves the section asks it). A break's cells are nested, and
// `applyRows` is flat, so their typed text lives in an id-keyed draft map composed at render,
// `breakTexts`, which no reload touches (`src/lib/price-break-texts.ts`; the admin surcharges
// page's `textDrafts` shape).
//
// vitest has no DOM. The first half reads PricingSection.tsx as a syntax tree; the second lifts
// `commitRow` and `blurSaveBreak` out of it and runs them over a hand-built environment, the
// lines-section-wiring.test.ts shape.

const FILE = "src/app/parts/[id]/PricingSection.tsx";
const file = fileURLToPath(new URL(`../${FILE}`, import.meta.url));
const text = readFileSync(file, "utf8");
const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function declared(name: string): ts.FunctionDeclaration {
  const found = all(source, ts.isFunctionDeclaration).filter((f) => f.name?.text === name);
  if (found.length !== 1) throw new Error(`Expected one function ${name} in PricingSection.tsx, found ${found.length}`);
  return found[0];
}

const MONEY_FIELDS = ["setupCharge", "unitPrice", "minimumCharge"] as const;

describe("PricingSection is wired to the page's edit guard (#652)", () => {
  it("lands the list through applyRows on the prices collection, and nowhere else", () => {
    const setRowsCalls = all(source, ts.isCallExpression)
      .filter((c) => ts.isIdentifier(c.expression) && c.expression.text === "setRows");
    const landings = setRowsCalls.filter((c) => {
      const arg = c.arguments[0];
      return arg !== undefined && ts.isCallExpression(arg) && ts.isPropertyAccessExpression(arg.expression)
        && arg.expression.name.text === "applyRows"
        && arg.arguments[0] !== undefined && ts.isStringLiteral(arg.arguments[0]) && arg.arguments[0].text === "prices";
    });
    expect(landings.map((c) => c.getText(source))).toEqual(['setRows(editGuard.applyRows("prices", data))']);
    // Every other setRows is a functional updater over its parameter (the sweep holds that rule).
    expect(setRowsCalls.length - landings.length).toBeGreaterThan(0);
  });

  it.each(MONEY_FIELDS)("the %s box registers as a keyed cell and blurs through onBlurSave into commitRow", (field) => {
    const focus = `editGuard.onFocusCell("prices", row.id, "${field}")`;
    const boxes = jsxTags(FILE).filter((tag) => tag.name === "input" && tag.attr("onFocus") === focus);
    expect(boxes.map((b) => b.text)).toHaveLength(1);
    const onBlur = boxes[0].attr("onBlur") ?? "";
    expect(onBlur).toContain("editGuard.onBlurSave(e, (value, atFocus) => commitRow(row.id, \"" + field + "\", value, atFocus))");
  });

  it.each(["threshold", "price"] as const)("the break %s box composes its text from breakTexts and registers no focus session", (field) => {
    const boxes = jsxTags(FILE).filter((tag) => tag.name === "input" && tag.attr("value") === `breakText(b, "${field}")`);
    expect(boxes.map((b) => b.text)).toHaveLength(1);
    expect(boxes[0].attr("onFocus")).toBeUndefined();
    expect(boxes[0].attr("onChange")).toBe(`(e) => setBreakText(b.id, "${field}", e.target.value)`);
    expect(boxes[0].attr("onBlur")).toBe(`() => blurSaveBreak(row.id, b.id, "${field}")`);
    // R7: Enter commits the cell through the same blurSaveBreak.
    expect(boxes[0].attr("onKeyDown")).toBe(`(e) => enterSaveBreak(e, row.id, b.id, "${field}")`);
  });

  it("a landed payload prunes breakTexts to the breaks it lists", () => {
    expect(text).toContain("setBreakTexts((cur) => retainBreakTexts(cur, data.flatMap((r) => r.breaks.map((b) => b.id))))");
  });
});

const rows = () => [
  { id: "p1", position: 0, setupCharge: null, unitPrice: 2.25, minimumCharge: null,
    breaks: [{ id: "b1", threshold: 100, price: 2 }] },
  { id: "p2", position: 1, setupCharge: null, unitPrice: 1, minimumCharge: null, breaks: [] },
];

describe("commitRow", () => {
  function lift() {
    const setRowField = vi.fn();
    const onError = vi.fn();
    const saveRow = vi.fn(async () => true);
    const setRows = vi.fn();
    const commitRow = run<(id: string, field: string, value: string, atFocus: string) => void>(
      declared("commitRow").getText(source),
      { rows: rows(), rowBoxRefusal, setRowField, onError, saveRow, setRows, normalizePriceText, sameSentValue, savedMarks: { mark: () => {}, shows: () => false } },
    );
    return { commitRow, setRowField, onError, saveRow };
  }

  it("a refused figure goes back to the guard's at-focus value (the stored figure) and sends nothing", () => {
    const { commitRow, setRowField, onError, saveRow } = lift();
    commitRow("p1", "unitPrice", "abc", "2.25");
    expect(setRowField).toHaveBeenCalledWith("p1", "unitPrice", "2.25");
    expect(onError).toHaveBeenCalledWith(rowBoxRefusal(rows(), "p1", "unitPrice", "abc"));
    expect(saveRow).not.toHaveBeenCalled();
  });

  it("a typed figure is saved as typed, and a blank clears", async () => {
    const { commitRow, setRowField, saveRow } = lift();
    commitRow("p1", "unitPrice", "3.10", "2.25");
    expect(saveRow).toHaveBeenCalledWith("p1", { unitPrice: "3.10" });
    commitRow("p1", "setupCharge", "  ", "");
    expect(saveRow).toHaveBeenCalledWith("p1", { setupCharge: null });
    expect(setRowField).not.toHaveBeenCalled();
  });
});

describe("enterSaveBreak (R7)", () => {
  function lift() {
    const blurSaveBreak = vi.fn();
    const enterSaveBreak = run<(e: unknown, priceId: string, breakId: string, field: string) => void>(
      declared("enterSaveBreak").getText(source), { isEnterCommit, blurSaveBreak });
    return { enterSaveBreak, blurSaveBreak };
  }
  it("Enter commits the cell as its blur does", () => {
    const { enterSaveBreak, blurSaveBreak } = lift();
    const e = { key: "Enter", nativeEvent: { isComposing: false }, preventDefault: vi.fn() };
    enterSaveBreak(e, "p1", "b1", "price");
    expect(blurSaveBreak.mock.calls).toEqual([["p1", "b1", "price"]]);
    expect(e.preventDefault).toHaveBeenCalled();
  });
  it("another key, or an Enter that ends a composition, does nothing", () => {
    const { enterSaveBreak, blurSaveBreak } = lift();
    enterSaveBreak({ key: "a", preventDefault: vi.fn() }, "p1", "b1", "price");
    enterSaveBreak({ key: "Enter", nativeEvent: { isComposing: true }, preventDefault: vi.fn() }, "p1", "b1", "price");
    expect(blurSaveBreak).not.toHaveBeenCalled();
  });
});
describe("blurSaveBreak", () => {
  function lift(breakTexts: Record<string, string>) {
    let texts: Record<string, string> = breakTexts;
    const setBreakTexts = vi.fn((updater: (cur: Record<string, string>) => Record<string, string>) => { texts = updater(texts); });
    const onError = vi.fn();
    const saveBreak = vi.fn(async () => true);
    const setRows = vi.fn();
    const savedMarks = { mark: vi.fn(), shows: () => false };
    const blurSaveBreak = run<(priceId: string, breakId: string, field: string) => void>(
      declared("blurSaveBreak").getText(source),
      { rows: rows(), breakTexts, breakTextKey, withoutBreakText, setBreakTexts, breakBoxRefusal, saveBreak,
        onError, setRows, normalizePriceText, BREAK_THRESHOLD, BREAK_PRICE, savedMarks },
    );
    return { blurSaveBreak, onError, saveBreak, savedMarks, texts: () => texts };
  }
  const key = breakTextKey("b1", "price");

  it("nothing typed since the last blur: nothing is sent and nothing is dropped", () => {
    const { blurSaveBreak, saveBreak, onError } = lift({});
    blurSaveBreak("p1", "b1", "price");
    expect(saveBreak).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("typed text equal to what the row holds: dropped, nothing sent", () => {
    const { blurSaveBreak, saveBreak, texts } = lift({ [key]: "2" });
    blurSaveBreak("p1", "b1", "price");
    expect(texts()).toEqual({});
    expect(saveBreak).not.toHaveBeenCalled();
  });

  it("a blank: dropped, so the box shows the stored figure, and the blank sentence names the box", () => {
    const { blurSaveBreak, saveBreak, onError, texts } = lift({ [key]: " " });
    blurSaveBreak("p1", "b1", "price");
    expect(texts()).toEqual({});
    expect(onError).toHaveBeenCalledWith(`${BREAK_PRICE.label} cannot be blank — delete the break instead.`);
    expect(saveBreak).not.toHaveBeenCalled();
  });

  it("a refused figure: dropped, the refusal names the box by its place, nothing sent", () => {
    const { blurSaveBreak, saveBreak, onError, texts } = lift({ [key]: "x" });
    blurSaveBreak("p1", "b1", "price");
    expect(texts()).toEqual({});
    expect(onError).toHaveBeenCalledWith(breakBoxRefusal(rows(), "p1", "b1", "price", "x"));
    expect(saveBreak).not.toHaveBeenCalled();
  });

  it("a typed figure: dropped and saved as typed", () => {
    const { blurSaveBreak, saveBreak, texts } = lift({ [key]: "2.5" });
    blurSaveBreak("p1", "b1", "price");
    expect(texts()).toEqual({});
    expect(saveBreak).toHaveBeenCalledWith("p1", "b1", { price: "2.5" });
  });

  it("a save that lands marks the cell Saved with the sent figure; one that does not marks nothing", async () => {
    const landed = lift({ [key]: "2.5" });
    landed.blurSaveBreak("p1", "b1", "price");
    await new Promise((res) => setTimeout(res, 0));
    expect(landed.savedMarks.mark.mock.calls).toEqual([["break:b1:price", "2.5", { decimal: true }]]);
    const lost = lift({ [key]: "2.5" });
    lost.saveBreak.mockImplementationOnce(async () => false);
    lost.blurSaveBreak("p1", "b1", "price");
    await new Promise((res) => setTimeout(res, 0));
    expect(lost.savedMarks.mark).not.toHaveBeenCalled();
  });

  it("a break the rows no longer hold: dropped, nothing sent", () => {
    const { blurSaveBreak, saveBreak, onError, texts } = lift({ [breakTextKey("gone", "price")]: "2.5" });
    blurSaveBreak("p1", "gone", "price");
    expect(texts()).toEqual({});
    expect(saveBreak).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
