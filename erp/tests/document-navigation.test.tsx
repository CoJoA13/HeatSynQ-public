import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { BlockerPanel } from "@/components/BlockerPanel";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function documentMarkers(text: string, file: string) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const markers: { tag: string; value: string | null; href: string | null; customBehavior: boolean }[] = [];
  function visit(node: ts.Node): void {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const marker = node.attributes.properties.find((attr) =>
        ts.isJsxAttribute(attr) && attr.name.getText(source) === "data-navigation");
      const href = node.attributes.properties.find((attr) =>
        ts.isJsxAttribute(attr) && attr.name.getText(source) === "href");
      const hrefValue = href && ts.isJsxAttribute(href) ? href.initializer : undefined;
      if (marker && ts.isJsxAttribute(marker)) markers.push({
        tag: node.tagName.getText(source),
        value: marker.initializer && ts.isStringLiteral(marker.initializer)
          ? marker.initializer.text : null,
        href: hrefValue && ts.isStringLiteral(hrefValue) ? hrefValue.text
          : hrefValue && ts.isJsxExpression(hrefValue) ? hrefValue.expression?.getText(source) ?? null : null,
        customBehavior: node.attributes.properties.some((attr) => ts.isJsxSpreadAttribute(attr)
          || ["onClick", "onClickCapture"].includes(attr.name.getText(source))),
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return markers;
}

describe("native document navigation", () => {
  it("marks the rendered blocker page link and preserves its separate export", () => {
    const html = renderToStaticMarkup(<BlockerPanel label="material" rowName="Steel"
      list={[{ entityLabel: "Part", name: "Fixture part", id: "part-1", href: "/parts/part-1" }]}
      exportHref="/api/admin/reference/material/steel/blockers/export" onDismiss={() => {}} />);
    const anchors = html.match(/<a\b[^>]*>[^<]*<\/a>/g) ?? [];
    expect(anchors).toHaveLength(2);
    expect(anchors[0]).toContain('href="/parts/part-1"');
    expect(anchors[0]).toContain('data-navigation="document"');
    expect(anchors[0]).toContain("Fixture part</a>");
    expect(anchors[1]).toContain('href="/api/admin/reference/material/steel/blockers/export"');
    expect(anchors[1]).not.toContain("data-navigation");
    expect(anchors[1]).toContain("Export list to Excel</a>");
  });

  // A document marker on Next Link would skip the only guard that sees its client navigation.
  // Keep this opt-out on literal anchors without direct custom click behavior. This source check
  // cannot inspect arbitrary ancestor handlers. A forgotten marker merely retains the double
  // prompt; an incorrectly added marker can silently lose edits.
  it("reserves the opt-out for plain anchors without click handlers or spread props", () => {
    for (const file of walk(SRC).filter((path) => /\.[jt]sx?$/.test(path))) {
      for (const marker of documentMarkers(readFileSync(file, "utf8"), file)) {
        expect(marker, file).toMatchObject({ tag: "a", value: "document", customBehavior: false });
      }
    }
  });

  it("recognizes the unsafe marker forms the source sweep rejects", () => {
    expect(documentMarkers('<Link data-navigation="document" href="/parts" />', "fixture.tsx"))
      .toEqual([{ tag: "Link", value: "document", href: "/parts", customBehavior: false }]);
    expect(documentMarkers('<a data-navigation={mode} {...props} />', "fixture.tsx"))
      .toEqual([{ tag: "a", value: null, href: null, customBehavior: true }]);
    expect(documentMarkers('<a data-navigation="document" onClick={navigate} />', "fixture.tsx"))
      .toEqual([{ tag: "a", value: "document", href: null, customBehavior: true }]);
  });

  // Bounded census of the page anchors behind #275; downloads and document viewers retain their
  // existing exclusions. The browser regression exercises the Shell behavior separately.
  it.each([
    ["components/BlockerPanel.tsx", 1, "b.href"],
    ["app/receivables/close/Close.tsx", 1, "g.href"],
    // ReportsIndex keeps its row: the CATALOG entries are still native anchors (#303 replaced the
    // back-link pattern, not the catalog list).
    ["app/reports/ReportsIndex.tsx", 1, "r.href"],
  ] as const)("%s marks its existing native page links", (file, count, href) => {
    const markers = documentMarkers(readFileSync(join(SRC, file), "utf8"), file);
    expect(markers.map((marker) => marker.href)).toEqual(Array(count).fill(href));
  });

  // The other half of the same census. Each of these six carried TWO `← All reports` anchors — one
  // in the gate/loading branch, one in the main render — until #303 replaced both with the shared
  // `ReportsNav`, whose tabs are Next `Link`s. The marker must not follow them there (it would skip
  // the only guard that sees a client navigation), so the honest pin is that these files now carry
  // NO marker at all, not that they have been dropped from the list.
  it.each([
    "app/reports/backlog/BacklogReport.tsx",
    "app/reports/payments/PaymentsReport.tsx",
    "app/reports/sales/SalesReport.tsx",
    "app/reports/scoreboard/Scoreboard.tsx",
    "app/reports/shipped/ShippedReport.tsx",
    "app/reports/turnaround/TurnaroundReport.tsx",
    "components/TabNav.tsx",
  ] as const)("%s navigates through Link and marks nothing", (file) => {
    expect(documentMarkers(readFileSync(join(SRC, file), "utf8"), file)).toEqual([]);
  });
});
