// #642 (P7 step 2): `src/app/globals.css` declares `button:disabled:not([role="option"])` outside any
// cascade layer and sets its color, background, border color, text decoration, cursor and opacity
// (#230, owner-approved muting). Tailwind 4 emits every utility inside `@layer utilities`, and an
// unlayered declaration beats a layered one whatever its specificity, so a `disabled:` utility for
// one of those six properties on a `<button>` never applies (`tests/process-step-table.test.tsx`
// records the same, owner ruling 2026-09-27). Such a token claims a treatment that does not happen,
// and the next author copies it or reaches for the `!` form, which would break the ruled muting.
//
// SCOPE: every `.tsx` under `src/`, walked. A token counts when it sits in the `className` of a
// lowercase `<button>` that is not `role="option"`, written as a string, as template text, or as a
// const string the same file declares (`HEADER_BUTTON`, `CHIP_STYLE`), with or without `!`. Not seen:
// a class handed to a component that renders the button (`<SaveButton className=…>`), a class built
// in another file or by a function call. A `disabled:` utility for any other property (width, size,
// spacing) is not dead and is not refused.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");

const COLORS = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black|transparent|current|inherit";
/** The properties `button:disabled` sets: opacity, cursor, background, decoration, text and border color. */
const DEAD = new RegExp(
  `^!?disabled:!?(opacity-|cursor-|bg-|decoration-|underline!?$|no-underline!?$|line-through!?$|text-(${COLORS})\\b|border-(${COLORS})\\b)`,
);

export function deadTokens(source: string, fileName = "candidate.tsx"): { line: number; token: string }[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const consts = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer) consts.set(d.name.text, textsOf(d.initializer).join(" "));
    }
  }
  function textsOf(node: ts.Node, seen = new Set<string>()): string[] {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    if (ts.isTemplateExpression(node)) {
      return [node.head.text, ...node.templateSpans.flatMap((s) => [...textsOf(s.expression, seen), s.literal.text])];
    }
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text) || !consts.has(node.text)) return [];
      seen.add(node.text);
      return [consts.get(node.text)!];
    }
    const out: string[] = [];
    ts.forEachChild(node, (child) => { out.push(...textsOf(child, seen)); });
    return out;
  }
  const found: { line: number; token: string }[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(sf) === "button") {
      const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
      const attr = (name: string) => attrs.find((a) => a.name.getText(sf) === name);
      const role = attr("role")?.initializer;
      const isOption = role !== undefined && ts.isStringLiteral(role) && role.text === "option";
      const cls = attr("className")?.initializer;
      if (!isOption && cls) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        for (const token of textsOf(cls).join(" ").split(/\s+/)) if (DEAD.test(token)) found.push({ line, token });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe("no dead disabled: utility on a button (#642)", () => {
  const files = walk(SRC).filter((f) => f.endsWith(".tsx"));

  it("reads every client file", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("finds none in src/", () => {
    const hits = files.flatMap((f) => deadTokens(readFileSync(f, "utf8"), f)
      .map((h) => `${relative(ROOT, f).split(sep).join("/")}:${h.line} ${h.token}`));
    expect(hits).toEqual([]);
  });

  it("sees each shape it claims, and leaves what it does not refuse", () => {
    const hits = (src: string) => deadTokens(src).map((h) => h.token);
    expect(hits(`<button className="px-2 disabled:opacity-50">a</button>`)).toEqual(["disabled:opacity-50"]);
    expect(hits(`<button className={\`px-2 \${x ? "a" : "disabled:text-slate-400"}\`}>a</button>`)).toEqual(["disabled:text-slate-400"]);
    expect(hits(`const S = "disabled:cursor-default"; const B = () => <button className={S} />;`)).toEqual(["disabled:cursor-default"]);
    expect(hits(`<button className="disabled:opacity-50! disabled:bg-white disabled:border-slate-200 disabled:no-underline" />`))
      .toEqual(["disabled:opacity-50!", "disabled:bg-white", "disabled:border-slate-200", "disabled:no-underline"]);
    // Not refused: an option button (the rule excludes it), another element, another property.
    expect(hits(`<button role="option" className="disabled:opacity-50" />`)).toEqual([]);
    expect(hits(`<input className="disabled:bg-slate-100" />`)).toEqual([]);
    expect(hits(`<button className="disabled:border disabled:text-xs" />`)).toEqual([]);
  });
});
