// The parsed-source readers the panel-message wiring tests share (P6 step 5): a component's
// props, its `useState` slots, the `PanelMessage`s it draws and its `useMessageClearedAtRest`
// calls. vitest has no renderer for these sections, so the wiring is read from the source.
//
// Not named `*.test.ts`, so vitest never runs it as a suite.
import ts from "typescript";
import { source } from "./lift-callback";

export function component(path: string, name: string) {
  const file = source(path);
  let fn: ts.FunctionDeclaration | undefined;
  for (const s of file.statements) if (ts.isFunctionDeclaration(s) && s.name?.text === name) fn = s;
  if (!fn) throw new Error(`Missing component ${name} in ${path}`);
  return { file, fn };
}

/** The names the component takes from its props. */
export function propNames(fn: ts.FunctionDeclaration): string[] {
  const p = fn.parameters[0];
  if (!p || !ts.isObjectBindingPattern(p.name)) return [];
  return p.name.elements.map((e) => e.name.getText());
}

/** `const [<value>, <setter>] = useState…(…)` pairs declared in the component's body. */
export function stateSlots(fn: ts.FunctionDeclaration, file: ts.SourceFile): [string, string][] {
  const out: [string, string][] = [];
  const walk = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isArrayBindingPattern(n.name) && n.initializer && ts.isCallExpression(n.initializer)
      && n.initializer.expression.getText(file) === "useState") {
      const [a, b] = n.name.elements.map((e) => (ts.isBindingElement(e) ? e.name.getText(file) : ""));
      out.push([a, b]);
    }
    ts.forEachChild(n, walk);
  };
  walk(fn.body!);
  return out;
}

/** Each `<PanelMessage message={…} />` the component draws, by the expression it is handed. */
export function panelMessages(fn: ts.FunctionDeclaration, file: ts.SourceFile): string[] {
  const out: string[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isJsxSelfClosingElement(n) && n.tagName.getText(file) === "PanelMessage") {
      for (const a of n.attributes.properties) {
        if (ts.isJsxAttribute(a) && a.name.getText(file) === "message" && a.initializer && ts.isJsxExpression(a.initializer)) {
          out.push(a.initializer.expression!.getText(file));
        }
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(fn.body!);
  return out;
}

/** Each `useMessageClearedAtRest(<atRest>, <clear>)` call, as its two argument texts. */
export function clearedAtRest(fn: ts.FunctionDeclaration, file: ts.SourceFile): string[][] {
  const out: string[][] = [];
  const walk = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.getText(file) === "useMessageClearedAtRest") {
      out.push(n.arguments.map((a) => a.getText(file)));
    }
    ts.forEachChild(n, walk);
  };
  walk(fn.body!);
  return out;
}

/** The text of the function declaration `name` nested in the component `fn`. */
export function nestedFunction(fn: ts.FunctionDeclaration, file: ts.SourceFile, name: string): string {
  let text = "";
  const walk = (n: ts.Node) => { if (ts.isFunctionDeclaration(n) && n.name?.text === name) text = n.getText(file); ts.forEachChild(n, walk); };
  walk(fn);
  if (!text) throw new Error(`Missing function ${name}`);
  return text;
}
