// #641 (P7 step 5): a record's Delete, Void or Discard in its page's title row is one DangerButton.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { DangerButton } from "@/components/DangerButton";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const full = join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : [full];
});
const files = walk(SRC).filter((f) => f.endsWith(".tsx"));

type Tag = { file: string; name: string; attrs: Map<string, string>; text: string };
function tagsOf(file: string): Tag[] {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Tag[] = [];
  const visit = (node: ts.Node): void => {
    const open = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
    if (open) {
      const attrs = new Map<string, string>();
      for (const p of open.attributes.properties) {
        if (!ts.isJsxAttribute(p) || !p.initializer) continue;
        const init = p.initializer;
        attrs.set(p.name.getText(sf), ts.isStringLiteral(init) ? init.text : init.getText(sf).replace(/^\{|\}$/g, ""));
      }
      // A literal child's text, or an expression child's source in braces (`{labels.discard}`, PR 6).
      const text = ts.isJsxElement(node)
        ? node.children.map((c) => (ts.isJsxText(c) ? c.text : ts.isJsxExpression(c) && c.expression ? `{${c.expression.getText(sf)}}` : "")).join("").trim()
        : "";
      out.push({ file: relative(SRC, file).split(sep).join("/"), name: open.tagName.getText(sf), attrs, text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
const tags = files.flatMap(tagsOf);

describe("DangerButton (#641)", () => {
  it("draws the red bordered title-row button, passing the gate through", () => {
    expect(renderToStaticMarkup(<DangerButton onClick={() => {}} disabled title="Requires quotes.delete">Delete…</DangerButton>))
      .toBe('<button type="button" disabled="" title="Requires quotes.delete" class="rounded-md border border-danger-600 px-3 py-1.5 text-sm text-danger-600">Delete…</button>');
    expect(renderToStaticMarkup(<DangerButton onClick={() => {}} className="ml-auto">Delete part</DangerButton>))
      .toContain('class="rounded-md border border-danger-600 px-3 py-1.5 text-sm text-danger-600 ml-auto"');
  });

  it("is every record-level destroy action, each keeping its own gate in a disabled attribute", () => {
    const sites = tags.filter((t) => t.name === "DangerButton")
      .map((t) => [t.file, t.text, t.attrs.get("disabled")]);
    expect(sites.sort()).toEqual([
      ["app/admin/roles/page.tsx", "Delete unused role", "removeGate.disabled"],
      ["app/admin/step-codes/page.tsx", "Delete step code", "canDelete.disabled"],
      ["app/admin/surcharges/page.tsx", "Delete surcharge", "canDelete.disabled"],
      ["app/admin/templates/page.tsx", "Delete template", "canDelete.disabled"],
      ["app/certs/[id]/CertDetail.tsx", "Void certification", "voidGate.disabled"],
      ["app/customers/[id]/page.tsx", "Delete customer", "canDelete.disabled"],
      ["app/invoicing/[id]/InvoiceDetail.tsx", "{labels.discard}", "!discardGate.allowed"],
      ["app/orders/[id]/page.tsx", "Void order", "voidGate.disabled"],
      ["app/parts/[id]/page.tsx", "Delete part", "canDelete.disabled"],
      ["app/quotes/[id]/QuoteDetail.tsx", "Delete quote", "deleteGate.disabled"],
      ["app/receivables/batches/[id]/BatchDetail.tsx", "Void batch", "!voidBatchGate.allowed"],
      ["app/shipping/[id]/ShipmentDetail.tsx", "Void shipment", "voidGate.disabled"],
    ]);
  });

  it("places a className only, never a colour", () => {
    for (const t of tags.filter((x) => x.name === "DangerButton" && x.attrs.has("className"))) {
      expect(t.attrs.get("className"), t.file).toBe("ml-auto");
    }
  });

  it("leaves no red bordered button drawn by hand", () => {
    const hand = tags.filter((t) => t.file !== "components/DangerButton.tsx" && t.name === "button" && /\bborder-(?:red|danger)-600\b/.test(t.attrs.get("className") ?? ""))
      .map((t) => t.file);
    expect(hand).toEqual([]);
  });

  it("puts Delete part in the part page's title row, beside the heading", () => {
    const src = readFileSync(join(SRC, "app/parts/[id]/page.tsx"), "utf8");
    const h1 = src.indexOf("<PageHeader"); const del = src.indexOf("<DangerButton"); const first = src.indexOf("<IdentitySection");
    expect(h1).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(h1);
    expect(first).toBeGreaterThan(del);
  });
});
