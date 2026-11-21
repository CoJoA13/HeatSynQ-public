// #588: a finalized print's copy in the customer's folder runs after the print has committed, never
// inside its claim. The copy can wait up to 10 seconds on the share; inside the print's transaction
// that wait would hold the order's row lock, and a stuck share would hold it until the CIFS client
// gave up. No behavioural test sees where the call sits (a copy made inside the claim files the same
// bytes), so this file pins it on the parsed source, failing closed:
//
//  1. every `.ts`/`.tsx` file under `src/` is walked, never hand-listed, and only the module that
//     defines `fileCustomerCopy` (src/server/customer-folders.ts) and the invoice print route may
//     name it (`linesNaming`: an identifier or an exact string literal, on any receiver, called or
//     not), so a call moved into `printInvoiceInTx`, or into `printInvoice`'s `$transaction`
//     callback, reds here;
//  2. in the route, the name appears exactly twice: its import specifier, unaliased, from
//     `@/server/customer-folders`, and the callee of one call;
//  3. that call's nearest enclosing function is the `handle(...)` callback itself, so a call wrapped
//     in a `$transaction` callback (or any other function) reds;
//  4. its statement comes after the one statement awaiting the print, `const printed = await
//     (selected ? printSelectedInvoice(<id>) : printInvoice(<id>))` (#591's Print selected beside
//     the single print), in that same body, so the print has committed when it runs, and it is
//     handed that statement's `printed.filing`, so one call files both kinds of print;
//  5. the download name is read (`resolveDocumentFilename`) in a statement before it, so a read that
//     fails the request files nothing.
//
// The census is by name: a wrapper exported from customer-folders.ts under another name, and called
// from inside the claim, is outside what it reads.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { linesNaming } from "./helpers/ts-parse";
import { all } from "./helpers/source-lift";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const NAME = "fileCustomerCopy";
const DEFINING = "src/server/customer-folders.ts";
const ROUTE = "src/app/api/invoices/[id]/print/route.ts";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
const everyFile = walk(SRC).map((full) => relative(ROOT, full).split(sep).join("/"));
const code = everyFile.filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"));
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

describe("only the defining module and the invoice print route name fileCustomerCopy (#588)", () => {
  it("covers a real tree: every .ts/.tsx under src/, both extensions, and no other script type", () => {
    // Non-vacuous floors: a walk that found nothing would pass the census below trivially.
    expect(code.length).toBeGreaterThan(300);
    expect(code.some((file) => file.endsWith(".tsx"))).toBe(true);
    expect(code.some((file) => file.endsWith(".ts"))).toBe(true);
    expect(everyFile.filter((file) => /\.(?:[cm]?jsx?|mts|cts)$/.test(file))).toEqual([]);
    expect(code).toContain(DEFINING);
    expect(code).toContain(ROUTE);
  });

  it("finds the name in those two files and in no other", () => {
    const naming = code.filter((file) => linesNaming(read(file), NAME, file).length > 0);
    expect(naming.sort()).toEqual([ROUTE, DEFINING].sort());
  });
});

describe("the invoice print route copies after printInvoice, in handle's own callback (#588)", () => {
  const source = ts.createSourceFile(ROUTE, read(ROUTE), ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);

  /** The nearest enclosing function of `node`, or null at the file's top level. */
  function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | null {
    for (let at = node.parent; at !== undefined; at = at.parent) {
      if (ts.isFunctionLike(at)) return at;
    }
    return null;
  }

  /** The statement of `body` that holds `node`. */
  function statementIn(body: ts.Block, node: ts.Node): ts.Statement | undefined {
    for (let at: ts.Node = node; at.parent !== undefined; at = at.parent) {
      if (at.parent === body) return at as ts.Statement;
    }
    return undefined;
  }

  // Every node spelling the name: identifiers, and exact string literals, which would be an
  // element access or a dynamic lookup.
  const named = all(source, (node): node is ts.Node =>
    (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    && node.text === NAME);
  const specifier = named.find((node) => ts.isImportSpecifier(node.parent));
  const call = named.map((node) => node.parent).find(
    (parent): parent is ts.CallExpression => ts.isCallExpression(parent) && named.includes(parent.expression));

  it("names it twice: the unaliased import from @/server/customer-folders and the callee of one call", () => {
    expect(named).toHaveLength(2);
    expect(named.every((node) => ts.isIdentifier(node))).toBe(true);
    expect(specifier).toBeDefined();
    const importSpecifier = specifier!.parent as ts.ImportSpecifier;
    expect(importSpecifier.name).toBe(specifier);
    expect(importSpecifier.propertyName).toBeUndefined();
    expect(importSpecifier.isTypeOnly).toBe(false);
    const declaration = importSpecifier.parent.parent.parent;
    expect(ts.isImportDeclaration(declaration)).toBe(true);
    expect(((declaration as ts.ImportDeclaration).moduleSpecifier as ts.StringLiteral).text).toBe("@/server/customer-folders");
    expect(call).toBeDefined();
    expect(named).toContain(call!.expression);
  });

  it("calls it in the handle(...) callback itself, on the filing of the statement awaiting either print", () => {
    expect(call).toBeDefined();
    const callback = enclosingFunction(call!);
    expect(callback).not.toBeNull();
    // The callback is handle's first argument, and handle(...) is the exported POST.
    const handleCall = callback!.parent;
    expect(ts.isCallExpression(handleCall)).toBe(true);
    const handleExpression = (handleCall as ts.CallExpression).expression;
    expect(ts.isIdentifier(handleExpression) && handleExpression.text === "handle").toBe(true);
    expect((handleCall as ts.CallExpression).arguments[0]).toBe(callback);
    const post = handleCall.parent;
    expect(ts.isVariableDeclaration(post) && ts.isIdentifier(post.name) && post.name.text === "POST").toBe(true);
    // The body the two statements are compared in.
    expect(ts.isArrowFunction(callback!) || ts.isFunctionExpression(callback!)).toBe(true);
    const body = (callback as ts.ArrowFunction | ts.FunctionExpression).body;
    expect(ts.isBlock(body)).toBe(true);
    const block = body as ts.Block;

    // The route's two print calls, one each of `printInvoice` and `printSelectedInvoice` (#591), each
    // with one argument, both in one statement of the same body that awaits whichever ran and names
    // its answer.
    const prints = ["printInvoice", "printSelectedInvoice"].map((name) => {
      const found = all(source, ts.isCallExpression).filter(
        (node) => ts.isIdentifier(node.expression) && node.expression.text === name);
      expect(found, name).toHaveLength(1);
      expect(found[0].arguments, name).toHaveLength(1);
      expect(enclosingFunction(found[0]), name).toBe(callback);
      return found[0];
    });
    const printStatement = statementIn(block, prints[0]);
    expect(printStatement).toBeDefined();
    expect(statementIn(block, prints[1])).toBe(printStatement);
    expect(ts.isVariableStatement(printStatement!)).toBe(true);
    const [declaration] = (printStatement as ts.VariableStatement).declarationList.declarations;
    expect(ts.isIdentifier(declaration.name)).toBe(true);
    expect(declaration.initializer && ts.isAwaitExpression(declaration.initializer)).toBe(true);
    const printed = (declaration.name as ts.Identifier).text;
    // The copy is handed that answer's filing, whichever print made it.
    const filing = call!.arguments[0];
    expect(filing && ts.isPropertyAccessExpression(filing)
      && ts.isIdentifier(filing.expression) && filing.expression.text === printed
      && filing.name.text === "filing").toBe(true);

    const copyStatement = statementIn(block, call!);
    expect(copyStatement).toBeDefined();
    expect(block.statements.indexOf(copyStatement!)).toBeGreaterThan(block.statements.indexOf(printStatement!));
  });

  // The download name is read off the stored row after the print commits; a read that fails fails
  // the request, so it runs before the copy and such a failure files nothing.
  it("reads the download name before the copy, in the same body", () => {
    expect(call).toBeDefined();
    const callback = enclosingFunction(call!) as ts.ArrowFunction;
    const block = callback.body as ts.Block;
    const names = all(source, ts.isCallExpression).filter(
      (node) => ts.isIdentifier(node.expression) && node.expression.text === "resolveDocumentFilename");
    expect(names).toHaveLength(1);
    expect(enclosingFunction(names[0])).toBe(callback);
    const nameStatement = statementIn(block, names[0]);
    expect(nameStatement).toBeDefined();
    expect(block.statements.indexOf(nameStatement!)).toBeLessThan(block.statements.indexOf(statementIn(block, call!)!));
  });
});
