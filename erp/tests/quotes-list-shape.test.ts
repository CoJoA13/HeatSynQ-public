import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { jsxTags, jsxTexts, mentions } from "./helpers/jsx-source";

// How the quotes list is shaped since PR 3 of the UX redesign (spec §4.5; owner rulings of
// 2026-10-31 on #818): a PageHeader, the New quote card, three ListTabs presets over ONE register
// (the worklist request, its counts and the rows' Close… are gone; `followUpDue=1` and `expired=1`
// are the worklist predicates verbatim), the Follow-up column an in-place date input on every row
// that PATCHes and reads the list again, the first column headed "Quote". Read as source, the way
// order-hub-shape.test.ts reads the hub: vitest has no DOM.

const PAGE = "src/app/quotes/Quotes.tsx";
const path = fileURLToPath(new URL(`../${PAGE}`, import.meta.url));
const src = readFileSync(path, "utf8");
const tags = jsxTags(PAGE);
const named = (name: string) => tags.filter((t) => t.name === name);

/** The bare identifiers called inside the top-level-of-component function `name`. */
function callsInside(name: string): string[] {
  const source = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const calls: string[] = [];
  const visit = (node: ts.Node, inside: boolean) => {
    const here = inside || (ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (here && ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.push(node.expression.text);
    ts.forEachChild(node, (child) => visit(child, here));
  };
  visit(source, false);
  return calls;
}

describe("the quotes list's shape (PR 3)", () => {
  it("mounts a PageHeader and the three presets, derived from the filters", () => {
    expect(named("PageHeader").length).toBe(1);
    expect(named("PageHeader")[0].attr("title")).toBe("Quotes");
    expect(named("ListTabs").length).toBe(1);
    expect(named("ListTabs")[0].attr("tabs")).toBe("QUOTE_PRESETS");
    expect(named("ListTabs")[0].attr("active")).toBe("preset");
    expect(src).toContain("const preset = presetFor(filters);");
    expect(src).toContain("const shown = sortForPreset(rows, preset);");
    expect(src).toContain("{shown.map((r) => (");
  });

  it("reads one register: no worklist request, no count headings, no row Close…", () => {
    expect(src).not.toContain("worklist=1");
    expect(src).not.toContain("Close…");
    expect(src).not.toContain("prompt(");
    expect(src).not.toContain("reasonPromptText");
    expect(jsxTexts(PAGE, "h2")).toEqual(["New quote"]);
    expect(named("section").some((t) => t.attr("aria-label") === "Quotes list")).toBe(true);
  });

  it("edits the follow-up date in place on every row and reads the list again after the PATCH", () => {
    const dates = named("input").filter((t) => t.attr("type") === "date" && (t.attr("aria-label") ?? "").includes("follow-up date"));
    expect(dates.length).toBe(1);
    expect(dates[0].attr("onChange")).toContain("bumpFollowUp");
    // A closed quote's follow-up cannot be changed (`updateQuote` refuses a non-OPEN quote), and
    // the register shows closed rows where the worklists never did (Codex on #835): the box is
    // disabled on such a row, with the quote page's own reopen-first sentence.
    expect(dates[0].attr("disabled")).toContain('r.status !== "OPEN"');
    expect(dates[0].attr("title")).toContain("reopen it before editing");
    const calls = callsInside("bumpFollowUp");
    expect(calls).toContain("api");
    // Through the ref to the newest `loadList`, never the render's closure (review finding 6).
    expect(calls.filter((c) => c === "loadList").length).toBe(0);
    expect(src.match(/await loadListRef\.current\(\);/g)?.length).toBe(2);
    expect(src).toContain("useEffect(() => { loadListRef.current = loadList; }, [loadList]);");
    expect(mentions(PAGE, "reloadAll")).toBe(0);
  });

  it("heads its first column Quote and keeps the New quote card as the one primary action", () => {
    const heads = jsxTexts(PAGE, "th");
    expect(heads[0]).toBe("Quote");
    expect(heads).not.toContain("Quote #");
    const create = named("button").find((t) => t.attr("onClick") === "() => void createQuote()");
    expect(create?.attr("className")).toBe("BUTTON_PRIMARY");
  });
});
