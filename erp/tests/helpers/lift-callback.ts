// Runs a handler a component declares inside itself, over an environment the test builds: the
// production text, not a copy of it. `callback` finds a function declaration named `name` nested in
// the top-level function declaration `owner` of `src/<path>` and returns it, its types dropped, with
// `environment` as its only scope besides the runtime's globals. A ref the handler reads is an
// object the test hands it (`{ current: false }`) and reads back after.
//
// Not named `*.test.ts`, so vitest never runs it as a suite.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { run } from "./source-lift";

export function source(path: string) {
  const file = fileURLToPath(new URL(`../../src/${path}`, import.meta.url));
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, path.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
export function runNode<T>(node: ts.Node, file: ts.SourceFile, environment: Record<string, unknown>): T {
  return run<T>(node.getText(file), environment);
}
export function callback<T>(path: string, owner: string, name: string, environment: Record<string, unknown>): T {
  const file = source(path); let component: ts.FunctionDeclaration | undefined;
  for (const statement of file.statements) if (ts.isFunctionDeclaration(statement) && statement.name?.text === owner) component = statement;
  if (!component) throw new Error(`Missing production component ${owner}`);
  let fn: ts.FunctionDeclaration | undefined;
  function walk(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) fn = node; ts.forEachChild(node, walk); }
  walk(component); if (!fn) throw new Error(`Missing production callback ${owner}.${name}`);
  return runNode(fn, file, environment);
}
