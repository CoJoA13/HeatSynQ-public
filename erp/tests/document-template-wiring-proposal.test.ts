import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
it("TemplateEditor.save invokes the same tested runDocumentTemplateSave import", () => {
  const path = new URL("../src/app/admin/templates/[id]/edit/TemplateEditor.tsx", import.meta.url);
  const source = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = source.statements.filter(ts.isImportDeclaration).filter(node => ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.endsWith("/document-template-recovery"));
  const names = imports.flatMap(node => { const b = node.importClause?.namedBindings;
    return b && ts.isNamedImports(b) ? b.elements.filter(e => (e.propertyName?.text ?? e.name.text) === "runDocumentTemplateSave").map(e => e.name.text) : []; });
  expect(names).toHaveLength(1);
  const bodies: ts.Block[] = [];
  function find(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "save" && node.body) bodies.push(node.body);
    ts.forEachChild(node, find);
  }
  find(source); expect(bodies).toHaveLength(1);
  const calls: ts.CallExpression[] = [];
  function inspect(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === names[0]) calls.push(node);
    ts.forEachChild(node, inspect);
  }
  if (bodies[0]) inspect(bodies[0]);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.arguments.length).toBe(1);
});
it("TemplateEditor.refreshDraftMeta invokes the same tested readDocumentTemplateMetadata import", () => {
  const path = new URL("../src/app/admin/templates/[id]/edit/TemplateEditor.tsx", import.meta.url);
  const source = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = source.statements.filter(ts.isImportDeclaration)
    .filter(node => ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.endsWith("/document-template-recovery"))
    .flatMap(node => { const b = node.importClause?.namedBindings;
      return b && ts.isNamedImports(b) ? b.elements.filter(e => (e.propertyName?.text ?? e.name.text) === "readDocumentTemplateMetadata").map(e => e.name.text) : []; });
  expect(names).toHaveLength(1);
  const callbacks: ts.Node[] = [];
  function find(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "refreshDraftMeta" && node.initializer) callbacks.push(node.initializer);
    ts.forEachChild(node, find);
  }
  find(source); expect(callbacks).toHaveLength(1);
  const calls: ts.CallExpression[] = [];
  function inspect(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === names[0]) calls.push(node);
    ts.forEachChild(node, inspect);
  }
  if (callbacks[0]) inspect(callbacks[0]); expect(calls).toHaveLength(1); expect(calls[0]?.arguments.length).toBe(1);
});
