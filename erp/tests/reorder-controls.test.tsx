import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { ColumnPicker } from "@/app/board-parts/ColumnPicker";
import { defaultColumnState } from "@/lib/board-columns";
import { moveGate } from "@/lib/reorder";

/**
 * #395, §5.16: the ↑/↓ of the lists that use `moveGate` say why they are disabled at an end of the
 * list ("Already first" / "Already last", #363's words), and the gate's own reason still wins. `moveGate` gives the answer
 * (`tests/reorder.test.ts`); what is proven here is each SITE: that its two buttons take their
 * `disabled` and `title` from it, with that list's own gate, row index and length, and the right
 * direction its aria-label names. The sections fetch before they render a row, so static markup never reaches these
 * buttons; each button's spread is found by its aria-label and EXECUTED against the real
 * `moveGate` (the #363 technique). The step-code suggestions' pair is in `admin-screens.test.tsx`.
 */
const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), "utf8");

type Reason = { disabled: boolean; title: string | undefined };
const rows = (count: number) => Array.from({ length: count }, (_, n) => ({ id: `r${n}` }));

const SITES: { name: string; file: string; up: string; down: string; env: (gate: Reason, index: number, count: number) => Record<string, unknown> }[] = [
  { name: "part inspections", file: "app/parts/[id]/InspectionsSection.tsx", up: "Move up", down: "Move down",
    env: (gate, index, count) => ({ canEdit: gate, idx: index, rows: rows(count) }) },
  // Pricing folds its two gates into a `disabled` and a `title` of its own.
  { name: "part pricing", file: "app/parts/[id]/PricingSection.tsx", up: "Move up", down: "Move down",
    env: (gate, index, count) => ({ disabled: gate.disabled, title: gate.title, idx: index, rows: rows(count) }) },
  { name: "quote lines", file: "app/quotes/[id]/QuoteDetail.tsx", up: "Move line up", down: "Move line down",
    env: (gate, index, count) => ({ editGate: gate, index, lines: rows(count) }) },
  { name: "quote operations", file: "app/quotes/[id]/QuoteDetail.tsx", up: "Move operation up", down: "Move operation down",
    env: (gate, index, count) => ({ editGate: gate, pIdx: index, line: { prices: rows(count) } }) },
];

/** The one button named `label` in `file`, as a function from a row to its `{ disabled, title }`. */
function control(site: (typeof SITES)[number], label: string) {
  const source = read(site.file);
  const file = ts.createSourceFile(site.file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: ts.JsxAttributes[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttributes(node) && node.properties.some((p) => ts.isJsxAttribute(p)
      && p.name.getText(file) === "aria-label" && p.initializer?.getText(file) === `"${label}"`)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(found, `${site.name}: ${label}`).toHaveLength(1);
  // A `disabled` or `title` written beside the spread would override it, or be overridden by it.
  const named = found[0].properties.filter(ts.isJsxAttribute).map((p) => p.name.getText(file));
  expect(named, `${site.name}: ${label}`).not.toContain("disabled");
  expect(named, `${site.name}: ${label}`).not.toContain("title");
  const spreads = found[0].properties.filter(ts.isJsxSpreadAttribute);
  expect(spreads, `${site.name}: ${label}`).toHaveLength(1);
  const code = ts.transpileModule(`return (${spreads[0].expression.getText(file)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return (gate: Reason, index: number, count: number) => {
    const env = { moveGate, ...site.env(gate, index, count) };
    return new Function(...Object.keys(env), code)(...Object.values(env)) as Reason;
  };
}

const editor: Reason = { disabled: false, title: undefined };
const refused: Reason = { disabled: true, title: "Requires the permission" };

describe.each(SITES)("the ↑/↓ controls say why they are disabled: $name (#395)", (site) => {
  // Built inside each test, so a renamed button fails its own site's tests by name and the rest run.
  const up = (gate: Reason, index: number, count: number) => control(site, site.up)(gate, index, count);
  const down = (gate: Reason, index: number, count: number) => control(site, site.down)(gate, index, count);

  it("the first row's ↑ reads \"Already first\" and the last row's ↓ \"Already last\"", () => {
    expect(up(editor, 0, 3)).toEqual({ disabled: true, title: "Already first" });
    expect(down(editor, 2, 3)).toEqual({ disabled: true, title: "Already last" });
    // A lone row is at both ends.
    expect(up(editor, 0, 1)).toEqual({ disabled: true, title: "Already first" });
    expect(down(editor, 0, 1)).toEqual({ disabled: true, title: "Already last" });
  });

  it("an enabled ↑ or ↓ carries no title", () => {
    for (const [move, index] of [[down, 0], [up, 1], [down, 1], [up, 2]] as const) {
      expect(move(editor, index, 3)).toEqual({ disabled: false, title: undefined });
    }
  });

  it("the gate's reason wins on every row, the end rows included", () => {
    for (let index = 0; index < 3; index++) {
      expect(up(refused, index, 3)).toEqual(refused);
      expect(down(refused, index, 3)).toEqual(refused);
    }
  });
});

// The column picker is presentational and nothing gates it, so it is rendered.
describe("the order board's column picker ↑/↓ say why they are disabled (#395)", () => {
  const columns = defaultColumnState().slice(0, 3);
  const html = renderToStaticMarkup(<ColumnPicker columns={columns} onToggleVisible={() => {}} onMove={() => {}} />);
  const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
  const state = (tag: string) => ({ disabled: tag.includes('disabled=""'), title: tag.match(/title="([^"]*)"/)?.[1] });

  it("renders an ↑ and a ↓ for each of the three columns", () => {
    expect(buttons).toHaveLength(6);
    expect(buttons.map((tag) => / up"/.test(tag) ? "up" : / down"/.test(tag) ? "down" : "?")).toEqual(["up", "down", "up", "down", "up", "down"]);
  });

  it("the first column's ↑ reads \"Already first\" and the last column's ↓ \"Already last\"", () => {
    expect(state(buttons[0])).toEqual({ disabled: true, title: "Already first" });
    expect(state(buttons[5])).toEqual({ disabled: true, title: "Already last" });
  });

  it("every other ↑ and ↓ is enabled, with no title", () => {
    for (const index of [1, 2, 3, 4]) expect(state(buttons[index]), `button ${index}`).toEqual({ disabled: false, title: undefined });
  });
});

/**
 * The census. Every `<button>` in `src/` whose whole text is ↑ or ↓ spreads `moveGate`, so a new
 * ↑/↓ button cannot arrive without the helper. Walked from the tree, never hand-listed; a button
 * that cannot use the helper is an entry here with its reason. The match is on the button's source
 * text, so an arrow drawn some other way (in a `<span>`, as an expression, as an entity, or another
 * glyph) is outside it.
 */
describe("every ↑/↓ button in src spreads moveGate (#395)", () => {
  const SRC = fileURLToPath(new URL("../src", import.meta.url));
  // The template editor's one pair serves its sections and its fields. A section's move can also be
  // stopped by a pin, which is not an end of the list, so the pair takes each button's state from
  // `sectionMoveGate` / `fieldMoveGate` instead (#408; `tests/template-reorder-panel.test.tsx`).
  const EXEMPT: Record<string, number> = { "app/admin/templates/[id]/edit/panels.tsx": 2 };

  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name.endsWith(".tsx")) files.push(join(dir, entry.name));
    }
  };
  walk(SRC);

  const arrows = files.flatMap((path) => {
    const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const found: { file: string; arrow: string; spreadsMoveGate: boolean; spreads: number; named: string[]; label: string; direction: string; helperIsTheImport: boolean }[] = [];
    // The name must be the lib helper: imported un-aliased from the leaf, and declared nowhere else in the file.
    const imported = file.statements.some((s) => ts.isImportDeclaration(s)
      && ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === "@/lib/reorder"
      && !!s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings)
      && s.importClause.namedBindings.elements.some((e) => e.name.text === "moveGate" && !e.propertyName));
    let redeclared = 0;
    const scan = (node: ts.Node): void => {
      if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node))
        && node.name && ts.isIdentifier(node.name) && node.name.text === "moveGate") redeclared++;
      ts.forEachChild(node, scan);
    };
    scan(file);
    const helperIsTheImport = imported && redeclared === 0;
    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(file) === "button") {
        const text = node.children.map((c) => c.getText(file)).join("").trim();
        if (text === "↑" || text === "↓") {
          const spreadsMoveGate = node.openingElement.attributes.properties.some((p) => ts.isJsxSpreadAttribute(p)
            && ts.isCallExpression(p.expression) && p.expression.expression.getText(file) === "moveGate");
          const props = node.openingElement.attributes.properties;
          const spread = props.find((p) => ts.isJsxSpreadAttribute(p) && ts.isCallExpression(p.expression));
          const call = spread && ts.isJsxSpreadAttribute(spread) && ts.isCallExpression(spread.expression) ? spread.expression : undefined;
          const aria = props.find((p) => ts.isJsxAttribute(p) && p.name.getText(file) === "aria-label");
          found.push({ file: relative(SRC, path), arrow: text, spreadsMoveGate, helperIsTheImport,
            spreads: props.filter(ts.isJsxSpreadAttribute).length,
            named: props.filter(ts.isJsxAttribute).map((p) => p.name.getText(file)),
            label: aria && ts.isJsxAttribute(aria) ? aria.initializer?.getText(file) ?? "" : "",
            direction: call?.arguments[3]?.getText(file) ?? "" });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return found;
  });

  it("finds the six lists' pairs and the exempt pair, so the walk is not vacuous", () => {
    expect(arrows.filter((a) => a.spreadsMoveGate)).toHaveLength(12);
    expect(arrows).toHaveLength(14);
  });

  // Presence of the spread is not enough: a `title` beside it, a second spread, a local function of
  // the same name or the other direction would each leave a button that does not say its end.
  it("a button that spreads moveGate takes its disabled and title from the helper alone, in its own direction", () => {
    for (const a of arrows.filter((x) => x.spreadsMoveGate)) {
      const at = `${a.file} ${a.label}`;
      expect(a.helperIsTheImport, at).toBe(true);
      expect(a.spreads, at).toBe(1);
      expect(a.named, at).not.toContain("disabled");
      expect(a.named, at).not.toContain("title");
      expect(a.direction, at).toBe(a.arrow === "↑" ? "-1" : "1");
    }
  });

  // Keyed by BUTTON, not by file: QuoteDetail.tsx already holds two lists.
  it("every moveGate arrow is a button an executed test names", () => {
    const executed = [
      ...SITES.flatMap((s) => [`${s.file} "${s.up}"`, `${s.file} "${s.down}"`]),
      "app/board-parts/ColumnPicker.tsx {`Move ${def.label} up`}", "app/board-parts/ColumnPicker.tsx {`Move ${def.label} down`}", // rendered above
      'app/admin/step-codes/page.tsx "Move suggestion up"', 'app/admin/step-codes/page.tsx "Move suggestion down"', // admin-screens.test.tsx
    ].sort();
    expect(arrows.filter((x) => x.spreadsMoveGate).map((a) => `${a.file} ${a.label}`).sort()).toEqual(executed);
  });

  it("only an exempt file holds an ↑/↓ button without the spread, and only as many as recorded", () => {
    const bare: Record<string, number> = {};
    for (const a of arrows) if (!a.spreadsMoveGate) bare[a.file] = (bare[a.file] ?? 0) + 1;
    expect(bare).toEqual(EXEMPT);
  });
});
