// PR 1b of the UX redesign (spec 2026-10-30-ux-redesign-design.md §4.3, §4.6): every page's
// classes read the `@theme` tokens of PR 1a (`ink-*`, `surface-*`, `line`, `accent-*`, `link-*`,
// `success-*`), never Tailwind's scaffold palette. A scaffold colour token left in a `className` is
// a screen that still draws the old chrome beside the new, and the next author copies it.
//
// SCOPE: every `.tsx` under `src/`, walked. A token counts when it sits in a `className` JSX
// attribute or a `className` property of an object literal (spread onto an element or read through
// a map later), written as a string, as template text, inside a conditional, or as a const string
// the same file declares, at the top level or inside a function (the `dead-disabled-sweep` parser
// shape, #642, followed one scope further). Not seen: a class built in
// another file (the `ui-classes` leaf is pinned by `tests/ui-classes.test.ts`), one built by a
// function call, or one handed under another prop name. `LEGACY` names the colour families the
// redesign retired, under any state prefix, and `bg-red-100` (the old refusal fill; the refusal's
// `bg-red-50`/`text-red-700` stay, ruling 2). A file that must keep one is an `ALLOWED` entry with
// a reason, never a silent absence; the map is pinned empty.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");

export const LEGACY =
  /\b(?:(?:hover|focus|focus-visible|read-only|disabled|group-hover|placeholder):)?(?:bg|text|border|outline|ring|divide|from|to)-(?:slate|gray|zinc|neutral|stone|blue|sky|indigo|amber|yellow|green|emerald)-\d{2,3}\b|\bbg-red-100\b/;

/** `{ "<file>": "<reason>" }`, repo-relative; a scaffold token a file must keep, and why. */
export const ALLOWED: Record<string, string> = {};

export function legacyTokens(source: string, fileName = "candidate.tsx"): { line: number; token: string }[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // Every variable declaration in the tree, not only the top-level ones (where `dead-disabled-sweep`
  // stops): `ring-amber-400` hid in a const inside a render callback. Same-named consts in two
  // scopes are joined, which over-matches and fails closed.
  const inits = new Map<string, ts.Node[]>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      inits.set(node.name.text, [...(inits.get(node.name.text) ?? []), node.initializer]);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  const consts = new Map<string, string>();
  const resolving = new Set<string>();
  const constText = (name: string): string => {
    if (consts.has(name)) return consts.get(name)!;
    if (resolving.has(name) || !inits.has(name)) return "";
    resolving.add(name);
    const text = inits.get(name)!.flatMap((init) => textsOf(init)).join(" ");
    consts.set(name, text);
    return text;
  };
  function textsOf(node: ts.Node, seen = new Set<string>()): string[] {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    if (ts.isTemplateExpression(node)) {
      return [node.head.text, ...node.templateSpans.flatMap((s) => [...textsOf(s.expression, seen), s.literal.text])];
    }
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) return [];
      seen.add(node.text);
      return [constText(node.text)];
    }
    const out: string[] = [];
    ts.forEachChild(node, (child) => { out.push(...textsOf(child, seen)); });
    return out;
  }
  const found: { line: number; token: string }[] = [];
  const visit = (node: ts.Node): void => {
    // A `className` JSX attribute, or a `className` property of an object literal (spread onto an
    // element, or read through a map callback later): both reach the DOM.
    const init = ts.isJsxAttribute(node) && node.name.getText(sf) === "className" ? node.initializer
      : ts.isPropertyAssignment(node) && node.name.getText(sf) === "className" ? node.initializer : undefined;
    if (init) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      for (const token of textsOf(init).join(" ").split(/\s+/)) if (LEGACY.test(token)) found.push({ line, token });
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

describe("no scaffold colour token in a className (UX redesign PR 1b)", () => {
  const files = walk(SRC).filter((f) => f.endsWith(".tsx"));
  const rel = (f: string) => relative(ROOT, f).split(sep).join("/");

  it("reads every client file", () => {
    const names = files.map(rel);
    expect(names).toContain("src/app/page.tsx");
    expect(names).toContain("src/components/Shell.tsx");
    expect(files.length).toBeGreaterThan(100);
  });

  it("sees each shape it claims, and leaves what it does not refuse", () => {
    const src = [
      `const S = "mt-1 border-slate-200";`,
      `const A = () => <div className="rounded bg-slate-800 px-3" />;`,
      `const B = () => <p className={x ? "text-ink-500" : "text-slate-500"} />;`,
      `const C = () => <span className={\`px-2 \${S} hover:bg-slate-50\`} />;`,
    ].join("\n");
    expect(legacyTokens(src)).toEqual([
      { line: 2, token: "bg-slate-800" },
      { line: 3, token: "text-slate-500" },
      { line: 4, token: "border-slate-200" },
      { line: 4, token: "hover:bg-slate-50" },
    ]);
    const hits = (s: string) => legacyTokens(s).map((h) => h.token);
    expect(hits(`<p className="bg-red-100 text-red-700" />`)).toEqual(["bg-red-100"]);
    // Not refused: the redesign's tokens, the kept refusal reds, a token under another prop.
    expect(hits(`<p className="bg-surface-50 text-ink-800 border-line bg-red-50 text-red-700 bg-accent-50" />`)).toEqual([]);
    expect(hits(`<p data-x="bg-slate-50" />`)).toEqual([]);
    // A `className` property of an object literal, spread onto an element later or read through a
    // map, is a className too (the Shell's search results and the cert list's count segments).
    expect(hits(`const o = { className: x ? "bg-slate-200 text-ink-800" : "hover:bg-slate-100" }; const G = () => <b {...o} />;`))
      .toEqual(["bg-slate-200", "hover:bg-slate-100"]);
    // A const declared inside a function body is followed too: `ring-amber-400` hid in one.
    expect(hits(`const F = () => { const e = x ? "ring-1 ring-amber-400" : ""; return <i className={e} />; };`)).toEqual(["ring-amber-400"]);
  });

  it("finds no scaffold colour token under src/ outside ALLOWED", () => {
    const hits = files
      .filter((f) => !Object.hasOwn(ALLOWED, rel(f)))
      .flatMap((f) => legacyTokens(readFileSync(f, "utf8"), f).map((h) => `${rel(f)}:${h.line} ${h.token}`))
      .sort();
    expect(hits).toEqual([]);
  });

  it("ALLOWED is empty", () => {
    expect(ALLOWED).toEqual({});
  });
});
