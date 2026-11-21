// The Design panel and the stage draw, and judge, the template's page (container tag PR 2, task 3).
// Source pins, parsed with the TypeScript parser (never a regex over call arguments): the page is
// derived once in DesignPanel by `canvasPageFor`, handed explicitly to the stage and the five
// functions that read it, and the stage reads its own `page` prop everywhere it used the Letter
// constant. CanvasStage keeps `CANVAS_PAGE` only as that prop's default, so a caller that passes no
// page (the shape tests) still draws Letter. What the leaves do with a page is pinned in
// `canvas-page.test.ts` and `canvas-designer-page.test.ts`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const DIR = join(process.cwd(), "src/app/admin/templates/[id]/edit");
function parse(file: string) {
  const text = readFileSync(join(DIR, file), "utf8");
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function walk(node: ts.Node, visit: (n: ts.Node) => void) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}
const calls = (sf: ts.SourceFile, name: string) => {
  const found: ts.CallExpression[] = [];
  walk(sf, (n) => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) found.push(n); });
  return found;
};
const isPage = (n: ts.Node | undefined) => n !== undefined && ts.isIdentifier(n) && n.text === "page";
/** Is `page` (shorthand or `page: page`) a property of this object literal? */
const hasPageKey = (n: ts.Node | undefined) =>
  n !== undefined && ts.isObjectLiteralExpression(n) && n.properties.some((p) =>
    (ts.isShorthandPropertyAssignment(p) && p.name.text === "page")
    || (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "page" && isPage(p.initializer)));
const usesPage = (n: ts.Node | undefined) => isPage(n) || hasPageKey(n);
const identifiers = (sf: ts.SourceFile, text: string) => {
  const found: ts.Identifier[] = [];
  walk(sf, (n) => { if (ts.isIdentifier(n) && n.text === text) found.push(n); });
  return found;
};
/** The `page.<member>` property accesses in a file. */
const pageMembers = (sf: ts.SourceFile) => {
  const found: string[] = [];
  walk(sf, (n) => { if (ts.isPropertyAccessExpression(n) && isPage(n.expression)) found.push(n.name.text); });
  return found;
};

describe("DesignPanel", () => {
  const sf = parse("DesignPanel.tsx");
  it("derives the page by canvasPageFor(contract.docType, config.formats.labelSize)", () => {
    const [call, ...rest] = calls(sf, "canvasPageFor");
    expect(rest).toHaveLength(0);
    expect(call).toBeDefined();
    const [a, b] = call.arguments;
    expect(a.getText()).toBe("contract.docType");
    expect(b.getText()).toBe("config.formats.labelSize");
    expect(ts.isVariableDeclaration(call.parent) && call.parent.name.getText()).toBe("page");
  });
  it("hands the page to fitScale, canvasRefusal, canvasWarnings and placeNew", () => {
    const [fit] = calls(sf, "fitScale");
    expect(isPage(fit.arguments[1])).toBe(true);
    const [refusal] = calls(sf, "canvasRefusal");
    expect(hasPageKey(refusal.arguments[2])).toBe(true);
    const [warnings] = calls(sf, "canvasWarnings");
    expect(hasPageKey(warnings.arguments[3])).toBe(true);
    const [place] = calls(sf, "placeNew");
    expect(hasPageKey(place.arguments[3])).toBe(true);
  });
  it("hands the page to CanvasStage explicitly", () => {
    let stage: ts.JsxSelfClosingElement | undefined;
    walk(sf, (n) => { if (ts.isJsxSelfClosingElement(n) && n.tagName.getText() === "CanvasStage") stage = n; });
    const attr = stage!.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === "page") as ts.JsxAttribute | undefined;
    expect(attr).toBeDefined();
    expect(attr!.initializer && ts.isJsxExpression(attr!.initializer) && isPage(attr!.initializer.expression)).toBe(true);
  });
});

describe("CanvasStage", () => {
  const sf = parse("CanvasStage.tsx");
  it("takes an optional page prop that defaults to CANVAS_PAGE, and reads CANVAS_PAGE nowhere else", () => {
    const uses = identifiers(sf, "CANVAS_PAGE").filter((n) => !ts.isImportSpecifier(n.parent));
    expect(uses).toHaveLength(1);
    expect(ts.isBindingElement(uses[0].parent) && uses[0].parent.name.getText()).toBe("page");
    let typed: ts.PropertySignature | undefined;
    walk(sf, (n) => { if (ts.isPropertySignature(n) && n.name.getText() === "page") typed = n; });
    expect(typed?.questionToken).toBeDefined();
    expect(typed?.type?.getText()).toBe("CanvasPage");
  });
  it("draws the page box from page.width and page.height and the margin frame from page.margin", () => {
    const members = pageMembers(sf);
    expect(members.filter((m) => m === "width").length).toBeGreaterThanOrEqual(2);
    expect(members).toContain("height");
    expect(members.filter((m) => m === "margin").length).toBeGreaterThanOrEqual(3);
  });
  it("passes the page to every designer and rules call that reads it", () => {
    const at = (name: string, index: number) => {
      const found = calls(sf, name);
      expect(found.length, name).toBeGreaterThan(0);
      for (const call of found) expect(usesPage(call.arguments[index]), `${name}: ${call.getText()}`).toBe(true);
    };
    at("dragStart", 3);
    at("stageBox", 3);
    at("moveBox", 4);
    at("resizedBox", 7);
    at("resizedItem", 7);
    at("bandTop", 2);
    at("bandHeight", 2);
    at("topMargin", 1);
    at("continuedBox", 1);
    // movedItem takes the page in the options object it is handed.
    const [moved] = calls(sf, "movedItem");
    const options = moved.arguments[4] as ts.Identifier;
    let declared: ts.Expression | undefined;
    walk(sf, (n) => { if (ts.isVariableDeclaration(n) && n.name.getText() === options.text) declared = n.initializer; });
    expect(hasPageKey(declared)).toBe(true);
  });
});

describe("TemplateEditor", () => {
  it("passes the template's page to clearedLayout", () => {
    const [clear] = calls(parse("TemplateEditor.tsx"), "clearedLayout");
    const page = clear.arguments[1];
    expect(page).toBeDefined();
    expect(ts.isCallExpression(page) && page.expression.getText()).toBe("canvasPageFor");
    expect((page as ts.CallExpression).arguments.map((a) => a.getText())).toEqual(["detail.docType", "c.formats.labelSize"]);
  });
});
