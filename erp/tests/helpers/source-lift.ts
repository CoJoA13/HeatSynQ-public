// Two primitives for a test that reads a component's own source and runs a piece of it.
//
// vitest runs in node with no DOM. A static render runs no effect and no handler, so a page that
// reads its data in effects never renders past its first state, and what a control does on a click
// or a keystroke is never run at all. A test then parses the component's file, finds the function
// or the attribute it is about, and runs that source text over a hand-built environment, the way
// tests/lines-section-wiring.test.ts runs LinesSection's handlers. That test
// and the ones before it keep their own copies inline. order-entry-containers.test.tsx was the
// first to import these two, and they are a helper so that a later test imports them and does not
// copy them again.
//
// The caller parses its own file with `ts.createSourceFile`, so it chooses the script kind and
// whether parent nodes are set. tests/helpers/jsx-source.ts is the reader for a test that only
// asks what an attribute holds.
//
// Not named `*.test.ts`, so it is type-checked and linted but vitest never runs it as a suite.
import ts from "typescript";

/** Every node under `root` that `is` accepts, in source order. `root` itself is among them when
 *  `is` accepts it. */
export function all<T extends ts.Node>(root: ts.Node, is: (node: ts.Node) => node is T): T[] {
  const out: T[] = [];
  const walk = (node: ts.Node): void => { if (is(node)) out.push(node); ts.forEachChild(node, walk); };
  walk(root);
  return out;
}

/** Production source text, run with `environment` as its only scope besides the runtime's globals
 *  (`Number`, `BigInt`, `JSON` and the like): nothing of the module it came from is in reach.
 *  `code` is one expression: a function declaration's text, an arrow function's, or any other. Its
 *  types are dropped. A name it reads that is neither given nor a global is a ReferenceError when
 *  the code reaches that read, not before. */
export function run<T>(code: string, environment: Record<string, unknown>): T {
  const body = ts.transpileModule(`return (${code});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(environment), body)(...Object.values(environment)) as T;
}
