import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// All nine live hook instances now require concrete recovery options.
const legacy = new Set<string>();
function inspect(file: string, text: string) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hooks = new Set<string>(); const options = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings
      || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      const original = element.propertyName?.text ?? element.name.text;
      if (original === "useBulkGrid") hooks.add(element.name.text);
      if (["orderBulkOptions", "shipmentBulkOptions", "invoiceBulkOptions", "paymentBulkOptions"].includes(original)) options.set(element.name.text, original);
    }
  }
  const rows: { owner: string; recovered: boolean; valid: boolean }[] = [];
  function walk(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression) && hooks.has(node.initializer.expression.text)) {
      let owner: ts.Node = node;
      while (owner.parent && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
      const ownerName = ts.isFunctionDeclaration(owner) ? owner.name?.text ?? "anonymous" : "missing";
      const arg = node.initializer.arguments[2];
      const recovered = !!arg;
      let valid = false;
      if (arg && ts.isCallExpression(arg) && ts.isIdentifier(arg.expression)) {
        const factory = options.get(arg.expression.text);
        const args = arg.arguments;
        if (factory === "orderBulkOptions") valid = args.length >= 5 && ts.isStringLiteral(args[2])
          && args[2].text.startsWith("order-") && ts.isStringLiteral(args[3]) && !!args[3].text;
        if (factory === "shipmentBulkOptions") valid = args.length === 4 && ts.isStringLiteral(args[3])
          && ["lines", "containers", "serials"].includes(args[3].text);
        if (factory === "invoiceBulkOptions") valid = args.length === 2;
        if (factory === "paymentBulkOptions") valid = args.length === 3;
      }
      rows.push({ owner: `${file}#${ownerName}`, recovered, valid });
    }
    ts.forEachChild(node, walk);
  }
  walk(source); return rows;
}
describe("per-instance bulk recovery migration census", () => {
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
  it("requires concrete options for every one of the nine hooks", () => {
    const rows = walk(root).filter(file => file.endsWith(".tsx")).flatMap(file => inspect(relative(root, file), readFileSync(file, "utf8")));
    expect(rows).toHaveLength(9);
    expect(rows.filter(row => !row.recovered).map(row => row.owner).sort()).toEqual([...legacy].sort());
    expect(rows.filter(row => row.recovered && !row.valid)).toEqual([]);
    expect(rows.filter(row => row.recovered)).toHaveLength(9);
  });
  it("follows renamed imports and rejects missing options even when imports remain", () => {
    const recovered = 'import { useBulkGrid as useGrid } from "@/lib/bulk-grid"; import { orderBulkOptions as options } from "@/lib/order-bulk-recovery"; function Editor() { const own = useGrid(rows, fields, options(source, id, "order-charges", "Charges", project)); }';
    expect(inspect("future.tsx", recovered)).toEqual([{ owner: "future.tsx#Editor", recovered: true, valid: true }]);
    expect(inspect("future.tsx", recovered.replace(', options(source, id, "order-charges", "Charges", project)', '')))
      .toEqual([{ owner: "future.tsx#Editor", recovered: false, valid: false }]);
    expect(inspect("future.tsx", recovered.replace('options(source, id, "order-charges", "Charges", project)', '{}')))
      .toEqual([{ owner: "future.tsx#Editor", recovered: true, valid: false }]);
  });
  it("detects any single missing shipment adapter even when its siblings and imports remain", () => {
    const source = 'import { useBulkGrid as useGrid } from "@/lib/bulk-grid"; import { shipmentBulkOptions as options } from "@/lib/shipment-bulk-recovery"; '
      + ['lines', 'containers', 'serials'].map(kind => `function ${kind}() { const grid = useGrid(rows, fields, options(source, id, child, "${kind}")); }`).join(" ");
    expect(inspect("ship.tsx", source).every(row => row.valid)).toBe(true);
    for (const kind of ["lines", "containers", "serials"]) {
      const missing = inspect("ship.tsx", source.replace(`, options(source, id, child, "${kind}")`, ""));
      expect(missing.filter(row => !row.recovered).map(row => row.owner)).toEqual([`ship.tsx#${kind}`]);
      expect(missing.filter(row => row.valid)).toHaveLength(2);
    }
  });

});
