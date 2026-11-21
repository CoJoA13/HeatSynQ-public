// #640 (P7 step 3): one amber "Unsaved changes" pill for every explicit-save editor. SaveButton
// draws it, and the editors that register with the unsaved guard themselves draw the same piece.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { UnsavedBadge } from "@/components/UnsavedBadge";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), "utf8");

/** The `dirty` expression of every `<UnsavedBadge>` the file renders. */
function badges(relative: string): string[] {
  const sf = ts.createSourceFile(relative, read(relative), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(sf) === "UnsavedBadge") {
      const dirty = node.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === "dirty");
      out.push(dirty && ts.isJsxAttribute(dirty) && dirty.initializer ? dirty.initializer.getText(sf) : "");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("UnsavedBadge (#640)", () => {
  it("draws the amber pill while dirty and nothing while clean", () => {
    expect(renderToStaticMarkup(<UnsavedBadge dirty />))
      .toBe('<span class="rounded-[5px] bg-accent-50 px-1.5 py-0.5 text-xs font-medium text-accent-600">Unsaved changes</span>');
    expect(renderToStaticMarkup(<UnsavedBadge dirty={false} />)).toBe("");
  });

  it.each([
    ["components/SaveButton.tsx", "{dirty}"],
    ["app/quotes/[id]/QuoteDetail.tsx", "{dirty}"],
    ["app/admin/templates/[id]/edit/TemplateEditor.tsx", "{dirty}"],
    ["app/parts/[id]/CustomFieldsSection.tsx", "{dirty.length > 0}"],
    ["app/certs/[id]/RequirementBlock.tsx", "{dirty}"],
    ["app/receivables/batches/[id]/BatchDetail.tsx", "{grid.dirty}"],
  ])("%s draws it on its own dirty flag", (file, dirty) => {
    expect(badges(file)).toEqual([dirty]);
  });

  it("no other file draws an Unsaved changes pill by hand", () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
    const SRC = fileURLToPath(new URL("../src", import.meta.url));
    const hand = walk(SRC).filter((f) => f.endsWith(".tsx") && !f.endsWith("UnsavedBadge.tsx"))
      .filter((f) => />\s*Unsaved changes\s*</.test(readFileSync(f, "utf8")));
    expect(hand).toEqual([]);
  });
});
