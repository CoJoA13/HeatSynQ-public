import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { InspectionsSection } from "@/app/parts/[id]/InspectionsSection";
import { WidthsPanel } from "@/app/admin/templates/[id]/edit/panels";
import { TRAVELER_CONTRACT, TRAVELER_DEFAULT_CONFIG } from "@/lib/template-contracts";
import { setFieldWidth } from "@/lib/template-editor";

/**
 * #239 — the row-level controls on the parts, certifications and template-editor grids. Four rules
 * that nothing else can see: `tsc` and `eslint` do not read class strings or accessible names, and
 * each defect renders as a perfectly valid page.
 *
 * Two are proved by RENDER and two by a source pin, and the split is forced rather than chosen.
 * `InspectionsSection`'s entry row and the widths panel are props-in/markup-out, so `vitest`'s
 * `environment: "node"` renders them with `renderToStaticMarkup` (the `certifications-section`
 * precedent — initial render only, no events and no landed fetch). `RequirementBlock`'s reading
 * rows come from the browser draft store through effects, which SSR never runs, so it renders zero
 * rows and its remove control cannot be reached that way at all; the reorder arrows sit on rows
 * that likewise arrive from a fetch. Both are therefore pinned at the source, the `rail-fit`
 * precedent, and both are mutation-checked the same way a rendered assertion is.
 */
const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), "utf8");

// ------------------------------------------------------------------------------------------------
// C4a — the cert reading row's remove control
// ------------------------------------------------------------------------------------------------

describe("the cert reading row's remove control (C4a)", () => {
  const src = read("app/certs/[id]/RequirementBlock.tsx");

  it("carries a real accessible name, not the multiplication sign it draws", () => {
    // The button's CONTENT is "×", which wins the accessible-name computation outright — a title
    // attribute never gets a look in, so the screen-reader name was literally "times". An
    // aria-label is what displaces it.
    expect(src).toContain('aria-label={`Remove reading ${i + 1}`}');
  });

  it("is legible at rest rather than only on hover", () => {
    // The old treatment (scaffold `text-slate-400`, ~2.8:1 on white, below the 3:1 floor for a
    // glyph this small) reached its only readable colour on :hover, which no touch user and no
    // keyboard user ever produces; the control reads in the body's muted ink at rest.
    // The negative pin on that old treatment was deleted: commit 1d5e9be9 folded `text-slate-400`
    // and `text-slate-500` into one token, `text-ink-500`, so it has no subject left to refuse.
    expect(src).toContain("text-sm text-ink-500 hover:text-red-600");
  });
});

// ------------------------------------------------------------------------------------------------
// C4b — one reorder-arrow treatment across the part sections that have arrows
// ------------------------------------------------------------------------------------------------

/** The one treatment. Asserted as a literal because the point of the item is that the files
 *  agree; a shared constant would make them agree by construction and prove nothing about the
 *  markup that actually ships. The Process Steps section left this census with the 2026-09-26
 *  table (spec §4): its moves live on the drag handle (Alt + ↑/↓) and the row's ⋮ menu, and its
 *  removal is a menu item with Undo, so it has neither arrows nor a red link to compare —
 *  `tests/process-step-table.test.tsx` pins that structure instead. */
const ARROW = "text-sm text-ink-500 hover:text-ink-800";

describe("the reorder arrows beside a red delete link (C4b)", () => {
  const sections = {
    "InspectionsSection.tsx": read("app/parts/[id]/InspectionsSection.tsx"),
    "PricingSection.tsx": read("app/parts/[id]/PricingSection.tsx"),
  };

  it("uses one legible treatment, twice per section — up and down", () => {
    for (const [name, src] of Object.entries(sections)) {
      expect(`${name}: ${src.split(ARROW).length - 1}`).toBe(`${name}: 2`);
    }
  });

  it("keeps named movement controls", () => {
    for (const [name, src] of Object.entries(sections)) {
      expect(`${name}: ${src.includes('aria-label="Move up"')}`).toBe(`${name}: true`);
      expect(`${name}: ${src.includes('aria-label="Move down"')}`).toBe(`${name}: true`);
    }
  });

  // #645 (P7 step 6): the quote's line and operation arrows, step codes' suggestion arrows and the
  // board's column picker drew bare `text-xs`; each now draws the one treatment.
  it.each([
    ["app/quotes/[id]/QuoteDetail.tsx", 4],
    ["app/admin/step-codes/page.tsx", 2],
    ["app/board-parts/ColumnPicker.tsx", 2],
  ])("%s draws its arrows the same way", (file, count) => {
    const src = read(file);
    expect(src.split(ARROW).length - 1).toBe(count);
    expect(src).not.toMatch(/className="text-xs(?: text-ink-500)?">\s*[↑↓]/);
  });

  it("leaves the red destructive link beside them alone", () => {
    expect(sections["InspectionsSection.tsx"]).toContain('className="text-xs text-red-600"');
    expect(sections["PricingSection.tsx"]).toContain('className="text-xs text-red-600"');
  });
});

// ------------------------------------------------------------------------------------------------
// L2a — the inspections entry row is a row OF the table
// ------------------------------------------------------------------------------------------------

/** The section renders its entry row unconditionally — the draft is local `useState` — so SSR
 *  reaches it even though the saved rows above it never land without a fetch. */
function inspections(): string {
  return renderToStaticMarkup(
    <InspectionsSection partId="part-1" perms={["parts.view", "parts.edit"]}
                        onOptionsError={() => {}} />,
  );
}

describe("the inspections entry row (L2a)", () => {
  it("renders inside the table, not as a flex strip beneath it", () => {
    const html = inspections();
    const table = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
    expect(table).toContain(">Add inspection requirement</button>");
  });

  it("is a real <tr>, so its controls sit in the column grid above them", () => {
    const html = inspections();
    // The Add button's own enclosing cell — read backwards from the button, so this is about the
    // entry row's markup rather than about any <td> anywhere in the section.
    const at = html.indexOf(">Add inspection requirement</button>");
    expect(at).toBeGreaterThan(-1);
    const before = html.slice(0, at);
    expect(before.lastIndexOf("<td")).toBeGreaterThan(before.lastIndexOf("</td>"));
    expect(before.lastIndexOf("<tr")).toBeGreaterThan(before.lastIndexOf("</tr>"));
  });

  it("keeps every field it had, addressable by the placeholder the operator reads", () => {
    const html = inspections();
    for (const placeholder of ["Min", "Max", "Sample qty", "Location"]) {
      expect(html).toContain(`placeholder="${placeholder}"`);
    }
    expect(html).toContain(">Code…</option>");
    expect(html).toContain(">Scale…</option>");
  });
});

// ------------------------------------------------------------------------------------------------
// C6 — an unset column width reads as a default, a stored one as a value
// ------------------------------------------------------------------------------------------------

/** The widths row for one column of the traveler's part-lines table, whose contract default is a
 *  plain number (78pt) — the case where a stored width and an unset default were indistinguishable,
 *  both printing "78" in the same box. */
function widthRow(config = TRAVELER_DEFAULT_CONFIG): string {
  const html = renderToStaticMarkup(
    <WidthsPanel contract={TRAVELER_CONTRACT} config={config} apply={() => {}}
                 disabled={false} editTitle={undefined} locks={new Map()} />,
  );
  const at = html.indexOf('aria-label="Width for Part quantity"');
  expect(at).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<li", at), html.indexOf("</li>", at));
}

describe("the template editor's column widths (C6)", () => {
  it("marks an unset width as the default rather than printing it as a value", () => {
    const row = widthRow();
    expect(row).toContain('value=""');
    expect(row).toContain('placeholder="78"');
    expect(row).toContain("pt (default)");
  });

  it("renders an unset box in italic, so the placeholder number cannot read as typed text", () => {
    expect(widthRow()).toMatch(/<input[^>]*aria-label="Width for Part quantity"/);
    expect(widthRow()).toContain("italic");
  });

  it("prints a stored width as a plain value, with neither cue", () => {
    const row = widthRow(setFieldWidth(TRAVELER_DEFAULT_CONFIG, "lines", "line_qty", 78));
    expect(row).toContain('value="78"');
    expect(row).not.toContain("(default)");
    expect(row).not.toContain("italic");
  });
});

// ------------------------------------------------------------------------------------------------
// #645 — a red row link carries no underline
// ------------------------------------------------------------------------------------------------

describe("a red row link is plain red text, never underlined (#645)", () => {
  it("finds no button whose class sets both", () => {
    const SRC = fileURLToPath(new URL("../src", import.meta.url));
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
    const hits: string[] = [];
    for (const file of walk(SRC).filter((f) => f.endsWith(".tsx"))) {
      const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node): void => {
        if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(sf) === "button") {
          const cls = node.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === "className");
          const text = cls && ts.isJsxAttribute(cls) && cls.initializer ? cls.initializer.getText(sf) : "";
          const tokens = text.split(/[\s"'`{}]+/);
          if (tokens.includes("text-red-600") && tokens.includes("underline")) {
            hits.push(`${file.slice(SRC.length + 1)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(hits).toEqual([]);
  });
});
