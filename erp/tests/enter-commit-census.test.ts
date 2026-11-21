// Owner ruling R7 (2026-10-22): Enter commits every single-line blur-save box, the cursor kept in
// it, and each shows the one Saved mark (owner answer 2026-10-29). This census holds the guard's
// boxes to it, PARSED (#188): every `<input>` whose onBlur blur-saves through the edit guard
// (`editGuard.onBlurSave`, a page's `onBlurSave` wrapper, or Accounting's `blurDecimal` factory)
// must carry an onKeyDown that commits through the guard's Enter (`editGuard.onEnterCommit`, the
// page's `onEnterSave`, or `enterDecimal`) with the SAME commit, text for text, and a `SavedMark`
// in the element that holds it. A `<textarea>`, where Enter is a newline, must carry no Enter
// commit. The boxes outside the guard keep their own record of the text at focus
// (src/lib/focus-record.ts, or the box's own draft) and are held by the second census below.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const full = join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : [full];
});

const BLUR = /^\(e\) => (?:editGuard\.onBlurSave|onBlurSave)\(e, ([\s\S]+)\)$|^blurDecimal\(("\w+")\)$/;
const ENTER = /^\(e\) => (?:editGuard\.onEnterCommit|onEnterSave)\(e, ([\s\S]+)\)$|^enterDecimal\(("\w+")\)$/;

type Box = { where: string; tag: string; blur: string; enter: string | null; marked: boolean; named: boolean };

// Every other `<input>` whose onBlur calls something is a blur-save box outside the guard, unless
// it is listed here with the reason it is not one. Fails closed: a new box with an onBlur must be
// wired or listed.
const NOT_BLUR_SAVES: Record<string, string> = {
  "app/admin/templates/[id]/edit/CanvasInspector.tsx": "the onBlur drops the typed text so the box shows the stored, snapped figure; the commit is onChange and nothing is saved on blur",
  "app/invoicing/[id]/StepWordsBox.tsx": "the onBlur closes the step-words picker; nothing is saved",
  "app/orders/[id]/LinesSection.tsx": "Qty and Net weight keep their own leaf, whose Enter commits already (\"Saved order, Lines\")",
  "app/orders/[id]/SerialsSection.tsx": "the range box adds rows to an explicit-save grid on blur; nothing is saved",
  "app/orders/new/Combobox.tsx": "the onBlur closes the list",
  "app/orders/new/OrderLineCard.tsx": "the range box adds rows to the whole-form draft; nothing is saved",
  "app/parts/[id]/ProcessCodeSearch.tsx": "the onBlur closes the list",
  "components/InlineDecimalBox.tsx": "the pick lists' box keeps its own Enter commit and pending dedupe (P8 CORR 4)",
  "components/InlineTextBox.tsx": "InlineDecimalBox's shape (#680); its one input commits on Enter, and its textarea takes none",
  "components/InlinePairBox.tsx": "Terms' discount boxes commit through their table, Enter included (#680)",
  "components/Shell.tsx": "the onBlur closes the global search list",
};
// A blur handler and its Enter twin: the Enter handler's callee for each blur callee. The two
// calls must pass the same arguments once the event (`e`, its target's value) is set aside.
const ENTER_TWIN: Record<string, string> = {
  leaveSave: "enterSave", leaveBox: "enterBox", blurSave: "enterSave", blurSaveBreak: "enterSaveBreak",
};
const EVENT_ARGS = new Set(["e", "e.target.value", "e.currentTarget.value"]);

type OwnBox = { where: string; file: string; blur: string; enter: string | null; paired: boolean; marked: boolean; named: boolean };

function ownBoxes(): OwnBox[] {
  return walk(SRC).filter((f) => f.endsWith(".tsx")).flatMap((file) => {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const rel = relative(SRC, file).split(sep).join("/");
    const out: OwnBox[] = [];
    const attr = (el: ts.JsxOpeningLikeElement, name: string) => {
      const a = el.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === name);
      return a && ts.isJsxAttribute(a) && a.initializer && ts.isJsxExpression(a.initializer) ? a.initializer.expression ?? null : null;
    };
    // The one call an arrow handler makes: `(e) => f(a, b)`.
    const callOf = (expr: ts.Expression | null) => {
      if (!expr || !ts.isArrowFunction(expr) || !ts.isCallExpression(expr.body) || !ts.isIdentifier(expr.body.expression)) return null;
      return {
        callee: expr.body.expression.text,
        args: expr.body.arguments.map((a) => a.getText(sf).replace(/\s+/g, " ")).filter((a) => !EVENT_ARGS.has(a)),
      };
    };
    // A `{name}` child drawn from a const in the same file (Settings' `labelText`) is searched too.
    const consts = new Map<string, ts.Node>();
    const collect = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) consts.set(n.name.text, n.initializer);
      ts.forEachChild(n, collect);
    };
    collect(sf);
    const hasMark = (node: ts.Node): boolean => {
      let found = false;
      const look = (n: ts.Node): void => {
        if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && n.tagName.getText(sf) === "SavedMark") found = true;
        if (ts.isJsxExpression(n) && n.expression && ts.isIdentifier(n.expression) && consts.has(n.expression.text)) {
          look(consts.get(n.expression.text)!);
        }
        ts.forEachChild(n, look);
      };
      look(node);
      return found;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(sf) === "input") {
        const blurExpr = attr(node, "onBlur");
        const blurText = blurExpr?.getText(sf).replace(/\s+/g, " ") ?? "";
        if (blurExpr && !BLUR.test(blurText) && !Object.hasOwn(NOT_BLUR_SAVES, rel)) {
          const enterExpr = attr(node, "onKeyDown");
          const blur = callOf(blurExpr); const enter = callOf(enterExpr);
          let holder: ts.Node = node.parent;
          while (holder && !ts.isJsxElement(holder) && !ts.isJsxFragment(holder)) holder = holder.parent;
          const inLabel = holder && ts.isJsxElement(holder) && holder.openingElement.tagName.getText(sf) === "label";
          out.push({
            where: `${rel}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`,
            file: rel,
            blur: blurText,
            enter: enterExpr ? enterExpr.getText(sf).replace(/\s+/g, " ") : null,
            paired: !!blur && !!enter && ENTER_TWIN[blur.callee] === enter.callee
              && JSON.stringify(blur.args) === JSON.stringify(enter.args),
            marked: holder ? hasMark(holder) : false,
            named: !inLabel || node.attributes.properties.some((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === "aria-label"),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
  });
}

function boxes(): Box[] {
  return walk(SRC).filter((f) => f.endsWith(".tsx")).flatMap((file) => {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const out: Box[] = [];
    const attr = (el: ts.JsxOpeningLikeElement, name: string) => {
      const a = el.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === name);
      return a && ts.isJsxAttribute(a) && a.initializer && ts.isJsxExpression(a.initializer) && a.initializer.expression
        ? a.initializer.expression.getText(sf).replace(/\s+/g, " ") : null;
    };
    const hasMark = (node: ts.Node): boolean => {
      let found = false;
      const look = (n: ts.Node): void => {
        if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && n.tagName.getText(sf) === "SavedMark") found = true;
        // Accounting draws its marks through its own `savedMark(key, label)`, which returns the tag.
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "savedMark") found = true;
        ts.forEachChild(n, look);
      };
      look(node);
      return found;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isJsxSelfClosingElement(node) && ["input", "textarea"].includes(node.tagName.getText(sf))) {
        const blur = attr(node, "onBlur");
        const m = blur ? BLUR.exec(blur) : null;
        if (blur && m) {
          const enterText = attr(node, "onKeyDown");
          const e = enterText ? ENTER.exec(enterText) : null;
          // The element holding the box: its label, cell or row.
          let holder: ts.Node = node.parent;
          while (holder && !ts.isJsxElement(holder)) holder = holder.parent;
          // A box inside a <label> that also holds its Saved mark takes the mark's words into its
          // own accessible name ("Freight amount Freight amount saved") unless it names itself.
          const inLabel = holder && ts.isJsxElement(holder) && holder.openingElement.tagName.getText(sf) === "label";
          out.push({
            where: `${relative(SRC, file).split(sep).join("/")}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`,
            tag: node.tagName.getText(sf),
            blur: (m[1] ?? m[2]).trim(),
            enter: e ? (e[1] ?? e[2]).trim() : enterText,
            marked: holder ? hasMark(holder) : false,
            named: !inLabel || node.attributes.properties.some((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === "aria-label"),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
  });
}

describe("every guard blur-save box takes Enter and shows Saved (R7)", () => {
  const all = boxes();
  const inputs = all.filter((b) => b.tag === "input");

  it("finds the guard's boxes", () => {
    expect(inputs.length).toBeGreaterThanOrEqual(42);
  });

  it("each single-line box commits on Enter with its blur's own commit", () => {
    expect(inputs.filter((b) => b.enter !== b.blur).map((b) => `${b.where} blur ${b.blur} / enter ${b.enter}`)).toEqual([]);
  });

  it("each single-line box shows the Saved mark beside it", () => {
    expect(inputs.filter((b) => !b.marked).map((b) => b.where)).toEqual([]);
  });

  it("a box whose label also holds its mark names itself, so the mark stays out of its name", () => {
    expect(inputs.filter((b) => !b.named).map((b) => b.where)).toEqual([]);
  });

  it("no textarea commits on Enter", () => {
    expect(all.filter((b) => b.tag === "textarea" && b.enter !== null).map((b) => b.where)).toEqual([]);
  });
});

describe("every blur-save box outside the guard takes Enter and shows Saved (R7, P8 step 5)", () => {
  const all = ownBoxes();

  it("finds the boxes outside the guard on each page that has them", () => {
    expect([...new Set(all.map((b) => b.file))].sort()).toEqual([
      "app/admin/part-fields/page.tsx",
      "app/admin/settings/page.tsx",
      "app/admin/step-codes/page.tsx",
      "app/admin/surcharges/page.tsx",
      "app/admin/users/page.tsx",
      "app/customers/[id]/SurchargeOverridesSection.tsx",
      "app/parts/[id]/InspectionsSection.tsx",
      "app/parts/[id]/PricingSection.tsx",
    ]);
    expect(all.length).toBeGreaterThanOrEqual(18);
  });

  it("each commits on Enter through its blur's twin, with the same box and commit", () => {
    expect(all.filter((b) => !b.paired).map((b) => `${b.where} blur ${b.blur} / enter ${b.enter}`)).toEqual([]);
  });

  it("each shows the Saved mark beside it", () => {
    expect(all.filter((b) => !b.marked).map((b) => b.where)).toEqual([]);
  });

  it("a box whose label also holds its mark names itself", () => {
    expect(all.filter((b) => !b.named).map((b) => b.where)).toEqual([]);
  });

  it("each listed exemption still names a file", () => {
    for (const rel of Object.keys(NOT_BLUR_SAVES)) {
      expect(walk(SRC).some((f) => relative(SRC, f).split(sep).join("/") === rel), rel).toBe(true);
    }
  });
});
