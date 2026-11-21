import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { QuoteRecoveryCatalogs } from "../src/lib/quote-recovery";

// #614 (2026-10-22 review, landing unit 22): the two pages that keep one customer's parts ask the
// server for that customer's parts, instead of the whole catalog filtered in the browser. Quote
// detail's `readCatalogs` is lifted whole (the `quote-save-read-overlap` precedent) and asked what
// URL it reads; the order hub's effect is read from its source, since its fetch is an inline
// effect no helper can lift. Both pins go red when a page reads the catalog again.

function quoteCallback<T>(name: string, environment: Record<string, unknown>): T {
  const path = new URL("../src/app/quotes/[id]/QuoteDetail.tsx", import.meta.url);
  const source = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer
      && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === "useCallback") found = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(source); if (!found) throw new Error(`Missing quote callback ${name}`);
  const code = ts.transpileModule(`return (${found.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(environment), code)(...Object.values(environment)) as T;
}

describe("the pages read one customer's parts (#614)", () => {
  it("quote detail's readCatalogs asks for the quote's customer's parts, inactive included", async () => {
    const urls: string[] = [];
    const api = async (url: string) => { urls.push(url); return []; };
    const readCatalogs = quoteCallback<(customerId: string, permissions: readonly string[]) => Promise<QuoteRecoveryCatalogs>>("readCatalogs", { api });
    await readCatalogs("customer-a", ["quotes.view", "parts.view", "customers.view"]);
    const parts = urls.filter((u) => u.startsWith("/api/parts"));
    expect(parts).toEqual(["/api/parts?includeInactive=1&customerId=customer-a"]);
  });

  it("the order hub asks for the order's customer's active parts, not the catalog", () => {
    const source = readFileSync(new URL("../src/app/orders/[id]/page.tsx", import.meta.url), "utf8");
    expect(source).toContain("api<PartOption[]>(`/api/parts?customerId=${customerId}`)");
    expect(source).not.toContain('"/api/parts?includeInactive=1"');
  });
});
