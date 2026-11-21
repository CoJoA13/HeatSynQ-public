// The redesign's class codemod (PR 1b, spec 2026-10-30-ux-redesign-design.md §4.3, §4.6). Run once
// over every `.tsx` under `src/` (`node scripts/codemods/redesign-classes.mjs`), it rewrites each
// `className` in two passes: composites by the element's tag (a dark button becomes
// `BUTTON_PRIMARY_COMPACT`, a bordered input `INPUT_COMPACT`, a red box `NOTICE.refusal`, …), the
// tokens the composite did not consume kept in order after the identifier; then the scaffold
// palette token by token, under any variant prefix (`disabled:bg-slate-100` →
// `disabled:bg-surface-50`). Red stays. `--check` exits 1 when any file would still change, so a
// later run proves the tree is settled; `tests/legacy-classes-sweep.test.ts` refuses what the map
// does not reach. Parsed with `typescript`, never a regex over the file: a token in a comment, a
// string handed to another prop or a const the file builds is not a class (#188).
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const UI_CLASSES = "@/lib/ui-classes";

/** Pass 2: a scaffold token to its redesign token, the variant prefix kept by `mapToken`. */
export const TOKEN_MAP = {
  "bg-slate-50": "bg-surface-50", "bg-slate-100": "bg-surface-50",
  "bg-slate-200": "bg-line",
  "bg-slate-700": "bg-ink-700",
  "bg-slate-800": "bg-ink-900", "bg-slate-900": "bg-ink-900",
  "text-slate-300": "text-ink-300",
  "text-slate-400": "text-ink-500", "text-slate-500": "text-ink-500", "text-slate-600": "text-ink-500",
  "text-slate-700": "text-ink-800", "text-slate-800": "text-ink-800", "text-slate-900": "text-ink-800", "text-slate-950": "text-ink-800",
  "border-slate-200": "border-line", "border-slate-300": "border-line",
  "border-slate-500": "border-ink-500",
  "border-slate-800": "border-ink-900",
  "text-blue-700": "text-link-700", "text-blue-800": "text-link-700", "text-blue-900": "text-link-700",
  "bg-blue-50": "bg-link-50", "bg-blue-100": "bg-link-50",
  "text-green-600": "text-success-700", "text-green-700": "text-success-700", "text-green-800": "text-success-700", "text-green-900": "text-success-700",
  "bg-green-50": "bg-success-50", "bg-green-100": "bg-success-50",
  "border-green-300": "border-success-700",
  "text-amber-700": "text-accent-600", "text-amber-800": "text-accent-600", "text-amber-900": "text-accent-600",
  "bg-amber-50": "bg-accent-50", "bg-amber-100": "bg-accent-50",
  "border-amber-200": "border-accent-400", "border-amber-300": "border-accent-600", "border-amber-400": "border-accent-400",
  "border-amber-600": "border-accent-600",
  "bg-amber-500": "bg-accent-400", "text-amber-950": "text-ink-900",
  "border-blue-300": "border-line", "border-blue-600": "border-link-700",
  "bg-blue-600": "bg-accent-600",
  "outline-blue-600": "outline-accent-600", "outline-blue-700": "outline-accent-600",
  "ring-slate-500": "ring-ink-500",
  "bg-white": "bg-surface-0",
};

/** `hover:bg-slate-50/50` → `hover:bg-surface-50/50`: the variant prefix and an opacity suffix ride along. */
export function mapToken(token) {
  const at = token.lastIndexOf(":");
  const prefix = token.slice(0, at + 1);
  const slash = token.indexOf("/", at + 1);
  const base = slash < 0 ? token.slice(at + 1) : token.slice(at + 1, slash);
  const suffix = slash < 0 ? "" : token.slice(slash);
  return Object.hasOwn(TOKEN_MAP, base) ? prefix + TOKEN_MAP[base] + suffix : token;
}

const isPad = (t) => /^p[xy]-/.test(t);
const oneOf = (...names) => (t) => names.includes(t);
const either = (...fns) => (t) => fns.some((f) => f(t));
const CONTROL = ["button", "summary"];
const FIELD = ["input", "select", "textarea"];
/** A token that sets a property the identifier also sets: a font size, a radius, an all-sides
 *  padding, a fill, a border colour, a text colour or a height. Left over, it would fight the
 *  identifier in Tailwind's own order rather than the site's, so the composite is refused and the
 *  site keeps its tokens, colours mapped. */
const FIGHTS = /^(text-(xs|sm|base|lg|xl|\dxl)|rounded-.+|p-[\d.]+|bg-.+|border-[a-z]+(-\d+)?|text-[a-z]+-\d+|text-white|h-.+)$/;

/**
 * Pass 1, in order; the first whose `needs` the literal's token set covers wins, unless a token it
 * does not consume matches `FIGHTS`. `tags` restricts a composite to those lowercase elements; the
 * rest apply to any element, a component included. `consumes` says which tokens the identifier
 * replaces.
 */
export const COMPOSITES = [
  { expr: "BUTTON_PRIMARY_COMPACT", tags: CONTROL, needs: ["rounded", "bg-slate-800", "text-white"],
    consumes: either(oneOf("rounded", "bg-slate-800", "text-white", "text-sm", "font-medium", "hover:bg-slate-700"), isPad) },
  { expr: "BUTTON_NEUTRAL_COMPACT", tags: CONTROL, needs: ["rounded", "border"],
    consumes: either(oneOf("rounded", "border", "bg-white", "text-sm"), isPad) },
  { expr: "INPUT_COMPACT", tags: FIELD, needs: ["rounded", "border"],
    consumes: either(oneOf("rounded", "border", "bg-white", "text-sm", "p-2"), isPad) },
  { expr: "CARD", needs: ["rounded", "border", "bg-white", "p-4"], consumes: oneOf("rounded", "border", "bg-white", "p-4") },
  ...[["refusal", "bg-red-50", "text-red-700"], ["warning", "bg-amber-50", "text-amber-800"],
      ["info", "bg-blue-50", "text-blue-800"], ["success", "bg-green-50", "text-green-800"]].map(([kind, bg, text]) => ({
    expr: `NOTICE.${kind}`, importName: "NOTICE", needs: ["rounded", bg, "p-2", "text-sm", text],
    consumes: oneOf("rounded", bg, "p-2", "text-sm", text),
  })),
  { expr: "BADGE_WARNING", needs: ["rounded", "bg-amber-100", "text-xs", "text-amber-800"],
    consumes: either(oneOf("rounded", "bg-amber-100", "text-xs", "text-amber-800", "font-medium"), isPad) },
  { expr: "BADGE_DANGER", needs: ["rounded", "bg-red-100", "text-xs"],
    consumes: either(oneOf("rounded", "bg-red-100", "text-xs", "text-red-700", "text-red-800", "font-medium"), isPad) },
  ...["bg-slate-100", "bg-slate-200"].map((bg) => ({
    expr: "CHIP", needs: ["rounded", bg, "text-xs"], consumes: either(oneOf("rounded", bg, "text-xs", "font-medium"), isPad),
  })),
  { expr: "LINK", needs: ["text-blue-700", "underline"], consumes: oneOf("text-blue-700", "underline"), fights: /^$/ },
].map((c) => ({ importName: c.expr.split(".")[0], fights: FIGHTS, ...c }));

/** The composite for a literal's text on an element `tag`, or null; `skip` names identifiers the file declares itself. */
function composite(text, tag, skip) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const set = new Set(tokens);
  for (const c of COMPOSITES) {
    if (skip.has(c.importName)) continue;
    if (c.tags && !c.tags.includes(tag)) continue;
    if (!c.needs.every((n) => set.has(n))) continue;
    const leftovers = tokens.filter((t) => !c.consumes(t));
    if (leftovers.some((t) => c.fights.test(t))) continue;
    return { expr: c.expr, importName: c.importName, leftovers: leftovers.map(mapToken) };
  }
  return null;
}

const mapText = (text) => text.replace(/\S+/g, mapToken);
const edges = (text) => { const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text); return [m[1], m[3]]; };

/**
 * Rewrites one file's source. `text` is the file after both passes, `changed` whether anything
 * moved, `imports` the ui-classes identifiers the rewrite uses (added to, or merged into, the
 * file's `@/lib/ui-classes` import).
 */
export function rewriteSource(source, fileName) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const local = new Set();
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) local.add(d.name.text);
    if (ts.isFunctionDeclaration(st) && st.name) local.add(st.name.text);
  }
  const edits = [];
  const used = new Set();

  /** A string literal (or no-substitution template): a composite, else the token pass. */
  function literal(node, tag, direct) {
    const text = node.text;
    const c = composite(text, tag, local);
    if (c) {
      used.add(c.importName);
      const [lead, trail] = edges(text);
      const body = c.leftovers.length ? `\`${lead}\${${c.expr}} ${c.leftovers.join(" ")}${trail}\`` : lead || trail ? `\`${lead}\${${c.expr}}${trail}\`` : c.expr;
      edits.push({ start: node.getStart(sf), end: node.end, text: direct ? `{${body}}` : body });
      return;
    }
    const mapped = mapText(text);
    if (mapped === text) return;
    const quote = ts.isStringLiteral(node) ? source[node.getStart(sf)] : "`";
    edits.push({ start: node.getStart(sf), end: node.end, text: `${quote}${mapped}${quote}` });
  }

  /** A template with spans: the head may take a composite; every quasi takes the token pass. */
  function template(node, tag) {
    const headRaw = node.head.getText(sf); // `...${
    const headText = headRaw.slice(1, -2);
    const c = composite(headText, tag, local);
    if (c) {
      used.add(c.importName);
      const [lead, trail] = edges(headText);
      const body = c.leftovers.length ? `\${${c.expr}} ${c.leftovers.join(" ")}` : `\${${c.expr}}`;
      edits.push({ start: node.head.getStart(sf) + 1, end: node.head.end - 2, text: `${lead}${body}${trail || " "}` });
    } else {
      const mapped = mapText(headText);
      if (mapped !== headText) edits.push({ start: node.head.getStart(sf) + 1, end: node.head.end - 2, text: mapped });
    }
    for (const span of node.templateSpans) {
      walkExpr(span.expression, tag);
      const raw = span.literal.getText(sf);
      const tailLen = ts.isTemplateTail(span.literal) ? 1 : 2;
      const inner = raw.slice(1, -tailLen);
      const mapped = mapText(inner);
      if (mapped !== inner) edits.push({ start: span.literal.getStart(sf) + 1, end: span.literal.end - tailLen, text: mapped });
    }
  }

  function walkExpr(node, tag) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return literal(node, tag, false);
    if (ts.isTemplateExpression(node)) return template(node, tag);
    ts.forEachChild(node, (child) => walkExpr(child, tag));
  }

  const visit = (node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(sf) === "className" && node.initializer) {
      const element = node.parent.parent;
      const tag = element.tagName.getText(sf);
      const init = node.initializer;
      if (ts.isStringLiteral(init)) literal(init, tag, true);
      else if (ts.isJsxExpression(init) && init.expression) walkExpr(init.expression, tag);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (edits.length === 0) return { text: source, changed: false, imports: [] };
  const imports = [...used].sort();
  if (imports.length) {
    const existing = sf.statements.find((st) => ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)
      && st.moduleSpecifier.text === UI_CLASSES && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings));
    if (existing) {
      const named = existing.importClause.namedBindings;
      const have = named.elements.map((e) => e.name.text);
      const add = imports.filter((n) => !have.includes(n));
      if (add.length) edits.push({ start: named.getStart(sf), end: named.end, text: `{ ${[...have, ...add].join(", ")} }` });
    } else {
      const line = `import { ${imports.join(", ")} } from "${UI_CLASSES}";`;
      const lastImport = [...sf.statements].reverse().find(ts.isImportDeclaration);
      const first = sf.statements[0];
      const directive = first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) ? first : null;
      if (lastImport) edits.push({ start: lastImport.end, end: lastImport.end, text: `\n${line}` });
      else if (directive) edits.push({ start: directive.end, end: directive.end, text: `\n${line}` });
      else edits.push({ start: 0, end: 0, text: `${line}\n` });
    }
  }
  let text = source;
  for (const e of edits.sort((a, b) => b.start - a.start || b.end - a.end)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
  return { text, changed: true, imports };
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".tsx") ? [full] : [];
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
  const check = process.argv.includes("--check");
  const changed = [];
  for (const file of walk(root)) {
    const out = rewriteSource(readFileSync(file, "utf8"), file);
    if (!out.changed) continue;
    changed.push(path.relative(process.cwd(), file));
    if (!check) writeFileSync(file, out.text);
  }
  if (check && changed.length) { console.error(changed.join("\n")); process.exit(1); }
  if (!check) console.log(`${changed.length} file(s) rewritten`);
}
