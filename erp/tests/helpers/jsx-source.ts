// A source reader for the wiring tests of a page no vitest test renders whole (#472).
//
// vitest runs in node with no DOM, and the saved shipment page cannot be rendered to static markup
// in one piece: it fetches in effects and returns "Loading…" until its first read lands and its
// permission read has answered (#483). So which gate each of its controls reads is pinned from the
// source instead, the way tests/lines-section-wiring.test.ts pins the order hub's Lines section.
// That test keeps its own reader inline. This one is a helper, so the wiring tests written since
// (#472) share one copy.
//
// PARSED, never pattern-matched (#188): the TypeScript parser answers what an attribute holds, so
// a comment or a string that spells an attribute is not one.
//
// A test built on this must compare against a literal (`toEqual([...])`, `toHaveLength(1)`), never
// only loop over what it finds: a reader that finds nothing then fails the test, not passes it.
//
// Not named `*.test.ts`, so it is type-checked and linted but vitest never runs it as a suite.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** `erp/`, the directory every `file` argument below is relative to. */
const ERP_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function parse(file: string): ts.SourceFile {
  const path = join(ERP_ROOT, file);
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, /* setParentNodes */ false,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/**
 * One JSX opening or self-closing element.
 *
 * `name` is the tag as written (`input`, `ShipmentOrderPanel`). `text` is the source of the opening
 * tag itself, from `<` to its `>`, attributes included and children excluded. `attr(name)` is what
 * one attribute holds: an expression's source without its braces, a string literal's text, `""` for
 * a bare attribute, `undefined` when the tag has no such attribute. An expression's source is
 * returned as written, line breaks included, so a test that pins a wrapped expression collapses the
 * whitespace itself.
 */
export type JsxTag = { name: string; text: string; attr(name: string): string | undefined };

/** Every JSX opening or self-closing element of `file` (a path under `erp/`), in source order. */
export function jsxTags(file: string): JsxTag[] {
  const source = parse(file);
  const out: JsxTag[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const properties = node.attributes.properties;
      out.push({
        name: node.tagName.getText(source),
        text: node.getText(source),
        attr(name) {
          const found = properties.find((p): p is ts.JsxAttribute =>
            ts.isJsxAttribute(p) && p.name.getText(source) === name);
          if (found === undefined) return undefined;
          const value = found.initializer;
          if (value === undefined) return "";
          if (ts.isStringLiteral(value)) return value.text;
          if (ts.isJsxExpression(value)) return value.expression?.getText(source) ?? "";
          return value.getText(source);
        },
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/**
 * What each `name` element is rendered from, in source order: the element's own source together
 * with every binary operator, conditional and parenthesis written directly around it. An element
 * shown on a condition answers `shown && <Name … />`. One with none of those around it answers its
 * own source, children included.
 *
 * It reads no further out than that one expression: a condition on an enclosing element is not in
 * the answer.
 */
export function renderedFrom(file: string, name: string): string[] {
  const source = parse(file);
  const out: string[] = [];
  const tagOf = (node: ts.Node): string | undefined =>
    ts.isJsxSelfClosingElement(node) ? node.tagName.getText(source)
      : ts.isJsxElement(node) ? node.openingElement.tagName.getText(source) : undefined;
  // `around` is the outermost operator, conditional or parenthesis that `node` sits directly in.
  const visit = (node: ts.Node, around: ts.Node | undefined): void => {
    if (tagOf(node) === name) out.push((around ?? node).getText(source));
    const wraps = ts.isBinaryExpression(node) || ts.isConditionalExpression(node) || ts.isParenthesizedExpression(node);
    ts.forEachChild(node, (child) => visit(child, wraps ? around ?? node : undefined));
  };
  visit(source, undefined);
  return out;
}

/** Does this declaration's name bind `name`: as a plain identifier, or anywhere in a destructuring
 *  pattern (`const [a, setA] = …`, `const { a, b } = …`)? */
function binds(pattern: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(pattern)) return pattern.text === name;
  return pattern.elements.some((element) => ts.isBindingElement(element) && binds(element.name, name));
}

/**
 * The initializer source of every variable declaration in `file` that binds `name`, in source
 * order. For a destructuring declaration it is the whole right-hand side. A parameter, a function
 * declaration and an import are not variable declarations and are never returned.
 */
export function declared(file: string, name: string): string[] {
  const source = parse(file);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined && binds(node.name, name)) {
      out.push(node.initializer.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** How many times the identifier `name` is written in `file`: where it is declared and every use,
 *  a call or not, as a value, a property name or a JSX attribute's value. Parsed, so a comment or
 *  a string that spells the name is not counted. */
export function mentions(file: string, name: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(parse(file));
  return count;
}

/** A piece of source (an expression or statements, as `declared` returns one) parsed on its own.
 *  Throws when it does not parse: a reader that misreads its subject must fail the test that
 *  asked, never answer from half a tree. */
function parseSnippet(text: string): ts.SourceFile {
  const problems = ts.transpileModule(text, {
    fileName: "snippet.tsx", reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.Preserve },
  }).diagnostics ?? [];
  if (problems.length > 0) {
    throw new Error(`Snippet does not parse: ${ts.flattenDiagnosticMessageText(problems[0].messageText, " ")}\n${text}`);
  }
  return ts.createSourceFile("snippet.tsx", text, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TSX);
}

/**
 * A piece of source as its tokens run together: no layout, no comment inside it (a JSDoc block
 * that leads the snippet's first statement is kept), and every string, template
 * and regular expression whole. A pin written through this survives a reformat, and a comment that
 * names a function is not read as a call to it.
 *
 * The parser's tokens, never a pattern over the text (#188). A pattern that strips line comments
 * also cuts a line at a `//` inside a string, and takes the code after that string with it.
 */
export function code(text: string): string {
  const source = parseSnippet(text);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    const children = node.getChildren(source);
    if (children.length === 0) out.push(node.getText(source));
    else children.forEach(visit);
  };
  visit(source);
  return out.join("");
}

/** Every identifier written in a piece of source, in order: a name called, a name handed on
 *  uncalled, a property name, a parameter. Parsed, like `code`. */
export function identifiers(text: string): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) out.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(parseSnippet(text));
  return out;
}

/**
 * The statements written directly in the first `try` block of a piece of source, in order, each as
 * `code` gives it. "First" is in source order, so for a function it is the outermost. A statement
 * of its `catch` or `finally`, or one nested in an `if` inside the block, is not in the answer.
 * Empty when there is no `try`.
 */
export function firstTryBlock(text: string): string[] {
  const source = parseSnippet(text);
  let found: ts.TryStatement | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isTryStatement(node)) { found = node; return; }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found === undefined ? [] : found.tryBlock.statements.map((statement) => code(statement.getText(source)));
}

/**
 * What every `tag` element of `file` (a path under `erp/`) holds as written, in source order, an
 * outer element before one inside it: JSX text as it is, an expression as `{its source}`, a child
 * element as `<its name>`, joined, with white space collapsed and trimmed. A self-closing element
 * answers `""`. A JSX comment answers nothing.
 *
 * For a heading or a label of a component no test renders: a heading that reads a constant answers
 * `{ITS_NAME}`, and a label that reads one before its box answers `{ITS_NAME} <input>`. JSX text
 * is the parser's `text` for it, as `literalTexts` answers it (tests/helpers/ts-parse.ts), and a
 * case of tests/weight-words-sweep.test.ts holds of that reader that `&nbsp;` stays `&nbsp;`.
 */
export function jsxTexts(file: string, tag: string): string[] {
  const source = parse(file);
  const nameOf = (node: ts.Node): string | undefined =>
    ts.isJsxElement(node) ? node.openingElement.tagName.getText(source)
      : ts.isJsxSelfClosingElement(node) ? node.tagName.getText(source) : undefined;
  const piece = (child: ts.JsxChild): string =>
    ts.isJsxText(child) ? child.text
      : ts.isJsxExpression(child) ? (child.expression === undefined ? "" : `{${child.expression.getText(source)}}`)
      : `<${nameOf(child) ?? ""}>`;
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (nameOf(node) === tag) {
      out.push(ts.isJsxElement(node) ? node.children.map(piece).join("").replace(/\s+/g, " ").trim() : "");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}
