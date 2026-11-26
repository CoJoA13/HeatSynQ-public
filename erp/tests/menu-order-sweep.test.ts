import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { declared, identifiers, jsxTags } from "./helpers/jsx-source";

// THE MENU ORDER CENSUS (#1056, owner rulings 2026-11-25). The rulings decide, menu by menu, which
// lists a picker sorts and which keep an order on purpose; nothing about a rendered page shows which
// rule a list followed, so the sites are pinned from the source. Parsed (tests/helpers/jsx-source.ts),
// never pattern-matched, and each census is compared against a literal, so a reader that finds
// nothing fails rather than passes.
//
//   1. Every Combobox picker's options come from a menu builder (src/lib/menu-options.ts), which
//      sorts by src/lib/menu-order.ts, or the picker is an entry below: a list ordered on purpose.
//   2. Every native select that stays native over a sorted list (the pick lists, Quoted by, the saved
//      views) maps its rows through `inMenuOrder`.
//   3. The picker asks its leaf (src/lib/combobox.ts) where its highlight starts, what a pick does,
//      what typing keeps and where its list sits.
//
// WHAT THIS DOES NOT SEE: a list sorted somewhere else before it reaches the builder (the builder
// sorts it again, so that costs nothing), and a native select over a list no entry in (2) names,
// which is a ruling to make, not a site to find.

const ERP = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ERP, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ERP, rel)).isDirectory()) tsxFiles(rel, out);
    else if (name.endsWith(".tsx")) out.push(rel);
  }
  return out.sort();
}

const BUILDERS = ["customerOptions", "partOptions", "glAccountOptions", "labelledOptions", "withBlank"];

/** Lists a picker shows in the order they arrive, by ruling 3, keyed `file#ariaLabel`. */
const ORDERED_ON_PURPOSE: Record<string, string> = {
  "src/app/shipping/new/NewShipment.tsx#Add order": "newest order first, as the server lists them",
  "src/app/shipping/[id]/ShipmentDetail.tsx#Add order": "newest order first, as the server lists them",
  "src/app/customers/[id]/ReceivablesSection.tsx#Invoice to apply the credit to": "oldest open invoice first",
  "src/app/admin/templates/[id]/edit/PreviewPane.tsx#Preview record": "newest record first (customers by code), as each list reads them",
};

/** A picker's options expression, read through one local binding when it names one. */
function optionsSource(file: string, expression: string): string {
  if (/^\w+$/.test(expression)) {
    const found = declared(file, expression);
    expect(found, `${file}: the options binding ${expression}`).toHaveLength(1);
    return found[0];
  }
  return expression;
}

describe("menu order census (#1056)", () => {
  const pickers = tsxFiles("src").filter((f) => f !== "src/components/Combobox.tsx")
    .flatMap((file) => jsxTags(file).filter((t) => t.name === "Combobox").map((tag) => ({ file, tag })));

  it("every Combobox picker's options come from a menu builder, or its list is ordered on purpose", () => {
    const verdicts = pickers.map(({ file, tag }) => {
      const key = `${file}#${tag.attr("ariaLabel")}`;
      const sorted = identifiers(optionsSource(file, tag.attr("options") ?? "")).some((name) => BUILDERS.includes(name));
      return sorted ? "sorted" : Object.hasOwn(ORDERED_ON_PURPOSE, key) ? `on purpose: ${key}` : `UNSORTED: ${key}`;
    });
    expect(verdicts.filter((v) => v.startsWith("UNSORTED"))).toEqual([]);
    // Every entry is in use, once: a list that stops being ordered on purpose leaves the table.
    expect(verdicts.filter((v) => v.startsWith("on purpose")).sort()).toEqual(
      Object.keys(ORDERED_ON_PURPOSE).map((k) => `on purpose: ${k}`).sort());
    // A floor, so a reader that finds no picker cannot pass.
    expect(verdicts.filter((v) => v === "sorted").length).toBeGreaterThanOrEqual(40);
  });

  // [file, the rows the native select maps]: each must be handed to `inMenuOrder` (rulings 3 and 6).
  const SORTED_NATIVE: [string, string][] = [
    ["src/app/receivables/batches/[id]/BatchDetail.tsx", "paymentTypes"],
    ["src/app/orders/[id]/ContainersSection.tsx", "containerTypes"],
    ["src/app/orders/new/EntryContainerRow.tsx", "containerTypes"],
    ["src/app/parts/[id]/InspectionsSection.tsx", "codes"],
    ["src/app/parts/[id]/InspectionsSection.tsx", "scales"],
    ["src/app/parts/[id]/SpecsSection.tsx", "options"],
    ["src/app/parts/[id]/IdentitySection.tsx", "materials"],
    ["src/app/shipping/new/NewShipment.tsx", "carriers"],
    ["src/app/shipping/[id]/ShipmentDetail.tsx", "carriers"],
    ["src/app/customers/[id]/page.tsx", "terms"],
    ["src/app/quotes/[id]/QuoteDetail.tsx", "statements"],
    ["src/app/quotes/[id]/QuoteDetail.tsx", "users"],
    ["src/app/board-parts/SavedViewsBar.tsx", "savedViews"],
    ["src/components/ReferenceTable.tsx", "refOptions[f.key] ?? []"],
    ["src/app/quotes/quote-form.ts", "materials ?? []"],
  ];

  function inMenuOrderArguments(file: string): string[] {
    const path = join(ERP, file);
    const sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const out: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "inMenuOrder" && node.arguments[0]) {
        out.push(node.arguments[0].getText(sf));
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
  }

  it.each(SORTED_NATIVE)("%s hands %s to inMenuOrder", (file, rows) => {
    expect(inMenuOrderArguments(file)).toContain(rows);
  });
});

describe("the picker's options stay out of the tab order (#1056, Codex on #1062)", () => {
  it("every option is a button the arrows reach and Tab skips", () => {
    const options = jsxTags("src/components/Combobox.tsx").filter((t) => t.attr("role") === "option");
    expect(options.map((t) => [t.name, t.attr("tabIndex")])).toEqual([["button", "-1"]]);
  });
});

describe("the picker asks its leaf (#1056)", () => {
  const source = readFileSync(join(ERP, "src/components/Combobox.tsx"), "utf8");
  const sf = ts.createSourceFile("Combobox.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  /** The names called inside the function declared as `name`. */
  function callsIn(name: string): string[] {
    let fn: ts.FunctionDeclaration | undefined;
    const find = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) fn = node;
      ts.forEachChild(node, find);
    };
    find(sf);
    expect(fn, name).toBeDefined();
    const out: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) out.push(node.expression.text);
      ts.forEachChild(node, visit);
    };
    visit(fn!);
    return out;
  }

  it("a pick goes through pickAction, and opening starts the highlight at openHighlight", () => {
    expect(callsIn("commit")).toContain("pickAction");
    expect(callsIn("openFresh")).toContain("openHighlight");
  });

  it("typing filters through filterOptions, the arrows step through stepHighlight, Enter picks through enterPick, and the list is placed by listPlacement", () => {
    const called = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) called.add(node.expression.text);
      ts.forEachChild(node, visit);
    };
    visit(sf);
    for (const name of ["filterOptions", "stepHighlight", "listPlacement", "openHighlight", "enterPick"]) expect([...called]).toContain(name);
  });
});
