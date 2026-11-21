import ts from "typescript";
import { posix } from "node:path";

export type CensusRow = { file: string; component: string; kind: "bulk" | "save"; site: string; problems: string[] };
const nodes = <T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] => {
  const out: T[] = []; const walk = (n: ts.Node) => { if (predicate(n)) out.push(n); ts.forEachChild(n, walk); }; walk(root); return out;
};
const named = (n: ts.Node) => n.getText();
type FunctionNode = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

/** Test-only, source-derived proposal. The project map also permits in-memory mutation tests. */
export function recoveryCensus(project: ReadonlyMap<string, string>, exemptions: ReadonlyMap<string, string> = new Map()): CensusRow[] {
  const parsed = new Map([...project].map(([path, source]) => [path, ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)]));
  const resolve = (file: string, spec: string) => {
    const stem = spec.startsWith("@/") ? spec.slice(2) : spec.startsWith(".") ? posix.normalize(posix.join(posix.dirname(file), spec)) : spec;
    return [stem, stem + ".ts", stem + ".tsx", stem + "/index.ts", stem + "/index.tsx"].find(path => parsed.has(path));
  };
  const imports = (file: string) => new Map(nodes(parsed.get(file)!, ts.isImportDeclaration).flatMap(i => {
    if (!ts.isStringLiteral(i.moduleSpecifier)) return [];
    const path = resolve(file, i.moduleSpecifier.text); const clause = i.importClause?.namedBindings;
    return clause && ts.isNamedImports(clause) ? clause.elements.map(e => [e.name.text, { path, symbol: e.propertyName?.text ?? e.name.text }] as const) : [];
  }));
  const result: CensusRow[] = [];
  for (const [file, sf] of parsed) {
    if (!file.endsWith(".tsx") || file.startsWith("app/api/")) continue;
    const imported = imports(file);
    const isCall = (n: ts.CallExpression, symbol: string, module: string) => ts.isIdentifier(n.expression) && imported.get(n.expression.text)?.symbol === symbol && imported.get(n.expression.text)?.path === module;
    const components: { name: string; node: FunctionNode }[] = nodes(sf, ts.isFunctionDeclaration).filter(n => n.name && /^[A-Z]/.test(n.name.text) && n.body).map(n => ({ name: n.name!.text, node: n }));
    for (const declaration of nodes(sf, ts.isVariableDeclaration)) if (ts.isIdentifier(declaration.name) && /^[A-Z]/.test(declaration.name.text) && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) components.push({ name: declaration.name.text, node: declaration.initializer });
    for (const component of components) {
      const calls = nodes(component.node, ts.isCallExpression);
      const declarations = nodes(component.node, ts.isVariableDeclaration);
      const lookup = new Map<string, ts.Node>();
      for (const d of declarations) if (ts.isIdentifier(d.name) && d.initializer) lookup.set(d.name.text, d.initializer);
      for (const f of nodes(component.node, ts.isFunctionDeclaration)) if (f.name && f !== component.node) lookup.set(f.name.text, f);
      const roots = new Set<string>();
      const stores = new Set(declarations.flatMap(d => d.initializer && ts.isCallExpression(d.initializer) && (isCall(d.initializer, "useBrowserDraftStore", "lib/use-recoverable-draft.ts") || isCall(d.initializer, "useDraftIdentity", "lib/use-recoverable-draft.ts")) && ts.isObjectBindingPattern(d.name)
        ? d.name.elements.filter(e => (e.propertyName?.getText() ?? e.name.getText()) === "store").map(e => e.name.getText()) : []));
      // A binding may be held directly in state, or at a specific property of an
      // object held in state (TemplateEditor's slot.binding). Follow that exact
      // property path; another store.bind elsewhere in the object is insufficient.
      const setters = new Map(declarations.flatMap(d => ts.isArrayBindingPattern(d.name) && d.name.elements[0] && d.name.elements[1]
        ? [[d.name.elements[0].getText(), d.name.elements[1].getText()] as const] : []));
      type StatePath = { state: string; properties: string[] };
      const statePaths = (node: ts.Node, seen = new Set<string>()): StatePath[] => {
        if (ts.isIdentifier(node)) {
          if (setters.has(node.text)) return [{ state: node.text, properties: [] }];
          if (seen.has(node.text)) return [];
          const next = lookup.get(node.text);
          return next ? statePaths(next, new Set([...seen, node.text])) : [];
        }
        if (ts.isPropertyAccessExpression(node)) return statePaths(node.expression, seen).map(path => ({ ...path, properties: [...path.properties, node.name.text] }));
        if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return statePaths(node.expression, seen);
        if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind))
          return [...statePaths(node.left, seen), ...statePaths(node.right, seen)];
        if (ts.isConditionalExpression(node)) return [...statePaths(node.whenTrue, seen), ...statePaths(node.whenFalse, seen)];
        return [];
      };
      const assignedBinding = (node: ts.Expression, properties: readonly string[]): boolean => {
        let value: ts.Expression = node;
        for (const property of properties) {
          if (!ts.isObjectLiteralExpression(value)) return false;
          const field = value.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText() === property);
          if (!field || !ts.isPropertyAssignment(field)) return false;
          value = field.initializer;
        }
        return ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression)
          && value.expression.name.text === "bind" && stores.has(value.expression.expression.getText()) && value.arguments.length === 3;
      };
      for (const view of declarations) {
        if (!view.initializer || !ts.isCallExpression(view.initializer) || !isCall(view.initializer, "useRecoverableDraft", "lib/use-recoverable-draft.ts")) continue;
        const arg = view.initializer.arguments[0]; if (!arg || !ts.isIdentifier(arg)) continue;
        const wired = statePaths(arg).some(path => calls.some(c => ts.isIdentifier(c.expression) && c.expression.text === setters.get(path.state)
          && c.arguments.some(a => assignedBinding(a, path.properties))));
        if (wired) { roots.add(arg.text); roots.add(view.name.getText()); }
      }
      const elements = nodes(component.node, (n): n is ts.JsxOpeningElement | ts.JsxSelfClosingElement => ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n));
      const attr = (e: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string) => {
        const a = e.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText() === name);
        return a && ts.isJsxAttribute(a) && a.initializer && ts.isJsxExpression(a.initializer) ? a.initializer.expression : undefined;
      };
      const trace = (node: ts.Node | undefined, seen = new Set<string>()): boolean => {
        if (!node) return false;
        if (ts.isIdentifier(node)) {
          if (roots.has(node.text)) return true;
          if (seen.has(node.text)) return false;
          const next = lookup.get(node.text); return next ? trace(next, new Set([...seen, node.text])) : false;
        }
        return nodes(node, ts.isIdentifier).some(id => trace(id, seen));
      };
      for (const grid of declarations) {
        if (!grid.initializer || !ts.isCallExpression(grid.initializer) || !isCall(grid.initializer, "useBulkGrid", "lib/bulk-grid.ts")) continue;
        const gridName = grid.name.getText(); const problems: string[] = []; const option = grid.initializer.arguments[2];
        let optionsWired = false;
        if (option && ts.isCallExpression(option) && ts.isIdentifier(option.expression)) {
          const target = imported.get(option.expression.text); const sourceModule = target?.path ? parsed.get(target.path) : undefined;
          const factory = sourceModule ? nodes(sourceModule, ts.isFunctionDeclaration).find(f => f.name?.text === target?.symbol && f.body) : undefined;
          optionsWired = !!factory && nodes(factory, ts.isReturnStatement).some(r => r.expression && ts.isObjectLiteralExpression(r.expression)
            && ["record", "kind", "schema", "read", "register"].every(key => r.expression && ts.isObjectLiteralExpression(r.expression) && r.expression.properties.some(p => p.name?.getText() === key)));
        }
        if (!optionsWired) problems.push("missing resolved recovery options");
        else roots.add(gridName);
        const reset = elements.some(e => ["SaveButton", "DiscardButton"].includes(e.tagName.getText()) && (() => {
          const callback = attr(e, "onDiscard"); const body = callback && ts.isIdentifier(callback) ? lookup.get(callback.text) : callback;
          return !!body && nodes(body, ts.isCallExpression).some(c => ts.isPropertyAccessExpression(c.expression) && c.expression.expression.getText() === gridName && c.expression.name.text === "discard");
        })());
        if (!reset) problems.push("missing own grid Discard");
        result.push({ file, component: component.name, kind: "bulk", site: gridName, problems });
      }
      for (const [index, e] of elements.entries()) {
        const tag = e.tagName.getText(); const button = tag === "button" || tag === "SaveButton";
        if (!button) continue;
        const label = e.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText() === "label");
        const children = ts.isJsxOpeningElement(e) && ts.isJsxElement(e.parent) ? e.parent.children.map(named).join(" ") : "";
        const dirtyGate = attr(e, "dirty") ?? attr(e, "disabled");
        const dirtyNames = dirtyGate ? nodes(dirtyGate, ts.isIdentifier).filter(id => /dirty/i.test(id.text) && !(ts.isPropertyAccessExpression(id.parent) && id.parent.name === id)) : [];
        const saveLabel = tag === "SaveButton" || /\bSave\b/.test(children) || (label && /\bSave\b/.test(label.getText()));
        if (!saveLabel && !dirtyNames.length) continue;
        if (exemptions.has(file)) continue;
        const handler = attr(e, "onSave") ?? attr(e, "onClick");
        const problems: string[] = [];
        if (!trace(handler)) problems.push("Save handler is not connected to a recovery binding");
        for (const dirty of dirtyNames) if (!trace(dirty)) problems.push("dirty gate is outside recovery: " + dirty.text);
        result.push({ file, component: component.name, kind: "save", site: String(index), problems });
      }
    }
  }
  return result;
}
