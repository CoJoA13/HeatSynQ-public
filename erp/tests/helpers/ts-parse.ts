// The parser primitives the source sweeps share. The first two were lifted out of
// `tests/audit-children.test.ts` when `tests/archival-gate-sweep.test.ts` (#277) became their second
// consumer; `linesNaming` was added for `tests/client-random-uuid-sweep.test.ts` (#348), so that
// sweep asks the parser rather than a regex (#188).
//
// WHY A MODULE RATHER THAN A THIRD HAND COPY. The first two carry a decision record that took a
// review round each to write — #188's "match the CALL, not the text that spells one" for
// `callsBareIdentifier`, and the three silently-dropped specifier shapes for `resolveLocalModule` —
// and a copied docstring is a docstring that drifts (the `dev-db-guard.ts` lesson: four hand copies
// that had already diverged). The 21 regression assertions `audit-children.test.ts` already holds
// over `callsInvalidate` now protect this implementation, since that function is a one-line wrapper
// over `callsBareIdentifier`. Nothing else moved: the tree walk, the allowlist rule and the
// non-vacuous floors stay duplicated per sweep, because each one is four lines and each sweep wants
// a different subject.
//
// This file is deliberately NOT named `*.test.ts`: `vitest.config.ts` collects
// `tests/**/*.test.{ts,tsx}`, so a helper here is type-checked and linted but never executed as a
// suite — the `tests/helpers/db.ts` and `tests/bulk-grid.type-pin.ts` precedent.
import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

/**
 * Does this source really CALL `name` — as code, not as text that spells one?
 *
 * **PARSED, NOT PATTERN-MATCHED (#188).** Every hand-rolled comment stripper this repo tried was
 * wrong in a way only running it revealed: stripping block comments first let a `/*` inside a `//`
 * comment open a block that swallowed 23,140 characters of one real file; stripping only `//` let a
 * docblock *mentioning* the call read as the call; and the shipped strip-both version still counted
 * `const hint = "invalidateHistory()"` as a call while eating a genuine call that sat after a `//`
 * inside a string literal — failing in both directions at once. `ts.createSourceFile` answers the
 * question exactly: comments, strings, template text, JSX text and regex literals are all the
 * parser's problem rather than a fifth regex's.
 *
 * WHAT COUNTS: a `CallExpression` whose callee is the bare IDENTIFIER `name`, anywhere in the tree.
 * Deliberately NOT a property access (`x.f()`) and not an uncalled reference (`onSaved={f}`) — both
 * exclusions fail CLOSED, which is the direction every sweep here is built in. The reasoning, and
 * the shapes that must and must not match, are pinned in `audit-children.test.ts`'s self-tests.
 *
 * Parsed as TSX by default because every file asked about so far is a `.tsx` client component; pass
 * a `fileName` when the subject is a `.ts` module, since `const id = <T>(x: T) => x;` is a generic
 * arrow in TS and an unclosed JSX element in TSX.
 *
 * **The backstop for an unparseable file is not this function; it is the rest of the gate set.** A
 * source under `src/` that does not parse reds `npx tsc --noEmit` and `npx eslint`, loudly and by
 * name, and both run beside these suites on every change.
 */
export function callsBareIdentifier(src: string, name: string, fileName = "candidate.tsx"): boolean {
  const parsed = ts.createSourceFile(
    fileName, src, ts.ScriptTarget.Latest, /* setParentNodes */ false,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parsed, visit);
  return found;
}

/** A specifier a local resolver is willing to be asked about: the `@/` alias, or a relative path. */
export const isLocalSpecifier = (spec: string): boolean => spec.startsWith("@/") || spec.startsWith(".");

/**
 * The real file a LOCAL module specifier names, relative to `root`, or `null` if nothing is there.
 *
 * `@/` is the repo's alias for `src/` (`tsconfig.json` `paths`); each caller asserts separately that
 * it is still the ONLY alias, which is what makes `isLocalSpecifier` exhaustive. Extensions are
 * tried in the bundler's order, then the specifier as written, so an extension-carrying `"./X.tsx"`
 * and a non-code asset both land somewhere real rather than reading as unresolvable.
 *
 * `root` is explicit rather than `process.cwd()` so a caller that resolves its paths from
 * `import.meta.url` and one that resolves them from the working directory cannot end up asking the
 * same question of two different trees. `fromFile` is root-relative and so is the answer.
 *
 * WHAT THIS DROPS SILENTLY, enumerated rather than summarised, because each takes an edge out of a
 * caller's graph with NO failure of its own:
 *
 *  1. a SECOND tsconfig path alias — only `@/` is understood, and any other non-relative specifier
 *     answers `null` as though it were a package;
 *  2. a `.js` spelling of a `.ts`/`.tsx` file, which `moduleResolution: "bundler"` accepts;
 *  3. `require()`, and any dynamic `import()` — neither is an import or export DECLARATION, and the
 *     callers only ask about those, so no specifier ever reaches here at all.
 *
 * Callers that depend on the graph being complete assert 1 and 2 away against their own file set.
 */
export function resolveLocalModule(root: string, fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(root, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(root, dirname(fromFile), spec);
  else return null;
  for (const candidate of [
    `${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts"), base,
  ]) {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
    return relative(root, candidate).split(sep).join("/");
  }
  return null;
}

/**
 * Every 1-based line on which the parsed code NAMES `name`, in ascending order, each line once.
 *
 * Written for #348's `randomUUID` sweep, which fails closed. The question is "does this source
 * reach for that property by any spelling", not "does it call it on `crypto`". So the RECEIVER is
 * never examined (`crypto`, `globalThis.crypto`, `window.crypto`, `self.crypto` and an alias all
 * count alike), and neither is whether the reference is called. Two node kinds count:
 *
 *  1. an IDENTIFIER whose text is `name`, anywhere in the tree. That covers dot and optional
 *     access (`c.name`, `c?.name`), a destructured binding (`{ name }`, `{ name: alias }`), an
 *     import or export specifier, an object-literal key, and a plain variable of that name;
 *  2. a STRING or no-substitution TEMPLATE literal whose text is exactly `name`. That covers element
 *     access (`c["name"]`, ``c[`name`]``), `"name" in c` and `Reflect.get(c, "name")`.
 *
 * WHAT DOES NOT COUNT, by construction rather than by stripping: comments (the parser attaches
 * them to no node), JSX text, regex literals, and any string that merely CONTAINS the name among
 * other text. A key assembled at run time (`c["random" + "UUID"]`, `c[key]`) is invisible to any
 * static reading. It is a stated residual, not a detected shape.
 *
 * Parsed as TSX by default; pass a `.ts` `fileName` for a `.ts` module (see `callsBareIdentifier`).
 */
export function linesNaming(src: string, name: string, fileName = "candidate.tsx"): number[] {
  const parsed = ts.createSourceFile(
    fileName, src, ts.ScriptTarget.Latest, /* setParentNodes */ false,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lines = new Set<number>();
  const visit = (node: ts.Node): void => {
    const names = (ts.isIdentifier(node) && node.text === name)
      || ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === name);
    if (names) lines.add(parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parsed, visit);
  return [...lines].sort((a, b) => a - b);
}

/** The kinds of node whose text `literalTexts` answers. */
const TEXT_NODES = [
  ts.isStringLiteral, ts.isNoSubstitutionTemplateLiteral, ts.isTemplateHead, ts.isTemplateMiddle, ts.isTemplateTail,
  ts.isJsxText,
];

/**
 * The text a parsed source holds, in source order: every string literal, every template with no
 * substitution, every head, middle and tail of a template with substitutions, and every piece of
 * JSX text. Written for tests/weight-words-sweep.test.ts, which asks what words a file can put on
 * a screen or in a message.
 *
 * `text` is the parser's `node.text`. For a string in code or a template's piece that is its value,
 * escapes read. For JSX text it is the text as written: an HTML entity is not decoded, and line
 * breaks and indentation are kept. A JSX attribute's string is as written too: it keeps an HTML
 * entity and a backslash escape. `line` is
 * the 1-based line the node starts on, which for JSX text is the line of its first character that
 * is not white space. A piece of JSX text that is all white space takes the line of what follows
 * it.
 *
 * NEVER in the answer, by construction and not by stripping: a comment, an identifier, a property
 * name written without quotes, and a regular expression. IN it, because the parser reads each as a
 * string literal: a property name written with quotes, a string written as a type, an import's
 * path and a `"use client"` line. A caller that compares whole texts decides what those cost it.
 *
 * Parsed as TSX unless `fileName` ends in `.ts` (see `callsBareIdentifier` for what a TSX parse
 * does to a `.ts` module).
 */
export function literalTexts(src: string, fileName = "candidate.tsx"): { line: number; text: string }[] {
  const parsed = ts.createSourceFile(
    fileName, src, ts.ScriptTarget.Latest, /* setParentNodes */ false,
    fileName.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.TSX,
  );
  const out: { line: number; text: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (TEXT_NODES.some((is) => is(node))) {
      out.push({
        line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
        text: (node as ts.LiteralLikeNode).text,
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parsed, visit);
  return out;
}

/**
 * Every pattern a module writes: the source of each regular expression literal, and the text of
 * each string literal or template piece passed as the first argument of `RegExp(…)` or
 * `new RegExp(…)` (a template's pieces are returned one by one, with the substitutions left out).
 * Parsed, never pattern-matched (#188).
 */
export function regexTexts(src: string, fileName = "candidate.tsx"): { line: number; text: string }[] {
  const parsed = ts.createSourceFile(
    fileName, src, ts.ScriptTarget.Latest, /* setParentNodes */ false,
    fileName.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.TSX,
  );
  const out: { line: number; text: string }[] = [];
  const at = (node: ts.Node) => parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
  const pieces = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push({ line: at(node), text: node.text });
    else if (ts.isTemplateExpression(node)) {
      out.push({ line: at(node), text: node.head.text });
      for (const span of node.templateSpans) out.push({ line: at(span), text: span.literal.text });
    }
  };
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const literal = (node as ts.LiteralLikeNode).text;
      out.push({ line: at(node), text: literal.slice(1, literal.lastIndexOf("/")) });
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node))
      && ts.isIdentifier(node.expression) && node.expression.text === "RegExp" && node.arguments?.[0]) {
      pieces(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parsed, visit);
  return out;
}

// The request readers below were lifted out of `tests/archival-gate-sweep.test.ts` (#277) when
// `tests/pending-action-sweep.test.ts` (#720) became their second consumer: both sweeps ask which
// calls in a client file are requests, to which URL, with which method.

/**
 * The URL argument as a PATTERN, or `null` when it cannot be read.
 *
 * Every template interpolation becomes `*` — a hole of unknown text WITHIN one path segment, not a
 * whole segment. `` `/api/orders/${id}/traveler${query}` `` ends with an interpolation that is
 * either empty or a query string, and reading that last segment as "traveler plus something" is what
 * lets it still match the `/traveler` route; reading it as an extra segment silently unmatched the
 * traveler print, measured, on the first draft of this file.
 *
 * A bare IDENTIFIER is folded against the file's own `const` initializers, and `a + b` is folded
 * left-first with an unreadable tail becoming a hole. Both exist because hoisting the URL out of the
 * call — `const path = ...; fetch(path, { method: "POST" })` — is an ordinary edit, and without
 * folding it moves the file out of the archival sweep's routed census and into its opaque exemption,
 * which is a permanent amnesty rather than a check. Folding is what keeps `LogoPanel`, `AttachmentsSection` and
 * `UserSignatureControl` inside the routed half.
 */
export function foldUrl(node: ts.Expression | undefined, consts: Map<string, string>): string | null {
  if (node === undefined) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((s) => `*${s.literal.text}`).join("");
  }
  if (ts.isIdentifier(node)) return consts.get(node.text) ?? null;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = foldUrl(node.left, consts);
    if (left === null) return null;
    const right = foldUrl(node.right, consts);
    return left + (right ?? "*");
  }
  return null;
}

/**
 * The HTTP method of a request, read from the init object.
 *
 * `"UNKNOWN"` is returned for every shape that cannot be read — a spread, a shorthand `{ method }`,
 * a computed key, a ternary, an init arriving as a variable — and every caller treats UNKNOWN as
 * mutating. That is the fail-CLOSED direction; guessing GET would drop the site out of the census
 * with no failure of its own.
 */
export function methodOf(node: ts.Expression | undefined): string {
  if (node === undefined) return "GET";                       // `fetch(url)` — a plain read
  if (!ts.isObjectLiteralExpression(node)) return "UNKNOWN";
  for (const prop of node.properties) {
    if (ts.isSpreadAssignment(prop)) return "UNKNOWN";         // `{ ...init }` may carry any method
    const name = prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
      ? prop.name.text : null;
    if (name !== "method") continue;
    if (ts.isPropertyAssignment(prop) && ts.isStringLiteralLike(prop.initializer)) return prop.initializer.text;
    return "UNKNOWN";                                          // shorthand, computed, or an expression
  }
  return "GET";
}

/** An init object that names a `method` at all — the signal that a call IS a request even when its
 *  callee is neither `fetch` nor `api`. Deliberately NOT satisfied by a bare spread: `{ ...a, ...b }`
 *  is an object-merge idiom this codebase uses everywhere, and counting it reported three `Map.set`
 *  and `setState` calls as unroutable requests. */
export const namesAMethod = (node: ts.Expression | undefined): boolean =>
  node !== undefined && ts.isObjectLiteralExpression(node)
  && node.properties.some((p) => !!p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
    && p.name.text === "method");

/**
 * The file's URL constants, by name, for `foldUrl` to fold a hoisted URL against.
 *
 * Constants are collected by NAME across the whole file, with no scope analysis — so a name
 * declared twice with DIFFERENT values would otherwise fold to whichever came last, and a request
 * could be attributed to a route it never calls or, worse, away from one it does. An ambiguous
 * name therefore folds to nothing, which drops its call sites into a caller's opaque bucket and
 * makes them an exemption somebody has to write. Nine names collide on this tree today (all of
 * them `key`, none a URL), so this is closing the shape rather than fixing a live misfold.
 */
export function urlConstants(sf: ts.SourceFile): Map<string, string> {
  const consts = new Map<string, string>();
  const ambiguous = new Set<string>();
  const collectConsts = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const value = foldUrl(n.initializer, new Map());
      const name = n.name.text;
      if (value !== null) {
        const prior = consts.get(name);
        if (prior !== undefined && prior !== value) ambiguous.add(name);
        consts.set(name, value);
      }
    }
    ts.forEachChild(n, collectConsts);
  };
  ts.forEachChild(sf, collectConsts);
  for (const name of ambiguous) consts.delete(name);
  return consts;
}

/** `src/app/api/orders/[id]/traveler/route.ts` -> `/api/orders/{}/traveler`. Every dynamic segment
 *  collapses to one placeholder, because a client URL can never say which id it holds. Shared by the
 *  archival-gate sweep and the answer-body sweep (#569), so the two join client to route alike. */
export const DYNAMIC = "{}";
export const routePattern = (file: string): string =>
  "/" + file.slice("src/app/".length, -"/route.ts".length)
    .split("/").map((seg) => (seg.startsWith("[") ? DYNAMIC : seg)).join("/");

export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * Could this client URL denote this route?
 *
 * Segment-wise, on equal segment counts. A route's dynamic segment matches anything; otherwise the
 * client segment — regex-escaped, with each `*` hole widened to `[^/]*` — must match the route's
 * literal segment exactly. A client segment that is only a hole therefore matches any route literal,
 * which over-matches in the safe direction: it claims MORE routes for a call site, so a dangerous
 * one cannot slip out of the census by being written with an interpolated path segment. A hole never
 * spans a separator, or `/api/*` would claim every route in the app.
 */
export function urlMatchesRoute(url: string, pattern: string): boolean {
  const client = url.split(/[?#]/)[0].split("/");
  const route = pattern.split("/");
  if (client.length !== route.length) return false;
  return client.every((seg, i) => {
    if (route[i] === DYNAMIC) return true;
    const re = new RegExp(`^${seg.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
    return re.test(route[i]);
  });
}
