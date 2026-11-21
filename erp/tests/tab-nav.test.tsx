import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { TAB_ACTIVE, TAB_IDLE, TabNav } from "@/components/TabNav";
import { PILL_ACTIVE, PILL_IDLE } from "@/lib/ui-classes";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ReceivablesNav } from "@/app/receivables/ReceivablesNav";
import { ReportsNav } from "@/app/reports/ReportsNav";
import { REPORTS } from "@/lib/report-registry";

// The bar reads the current route from `usePathname`, which has no App Router to read in this
// environment. The fixture IS the subject of half these cases (the active-tab rule), so it is a
// settable value rather than a constant. (`new-shipment-recovery.test.tsx` mocks the same module.)
const fixture = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => fixture.pathname }));

function render(component: ReactElement, pathname: string): string {
  fixture.pathname = pathname;
  return renderToStaticMarkup(component);
}

/** Every `<a>` the bar rendered, in document order: its href, label, and aria-current (or null). */
function tabs(html: string): { href: string; label: string; current: string | null }[] {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    href: /href="([^"]*)"/.exec(m[1])?.[1] ?? "",
    label: m[2].replace(/<[^>]+>/g, "").trim(),
    current: /aria-current="([^"]*)"/.exec(m[1])?.[1] ?? null,
  }));
}

const FIXTURE_TABS = [
  { label: "Root", href: "/section" },
  { label: "Child", href: "/section/child" },
  { label: "Other", href: "/section/other" },
];

describe("TabNav", () => {
  it("names the bar with the label it is given", () => {
    const html = render(<TabNav label="Section" tabs={FIXTURE_TABS} />, "/section");
    expect(html).toContain('<nav aria-label="Section"');
  });

  // The whole point of the first-tab-is-the-root rule. A section root's href is a PREFIX of every
  // sibling tab's href, so a prefix match would light the root up on every page in the section —
  // which is what "you are here" must never say. Mutation check: make the root match by prefix and
  // the second expectation below reds.
  it("matches the first tab exactly and every other tab by prefix", () => {
    const onRoot = tabs(render(<TabNav label="Section" tabs={FIXTURE_TABS} />, "/section"));
    expect(onRoot.map((t) => t.current)).toEqual(["page", null, null]);

    const onChild = tabs(render(<TabNav label="Section" tabs={FIXTURE_TABS} />, "/section/child"));
    expect(onChild.map((t) => t.current)).toEqual([null, "page", null]);

    // A route BELOW a child tab keeps that child marked; the root still is not.
    const onGrandchild = tabs(render(<TabNav label="Section" tabs={FIXTURE_TABS} />, "/section/child/abc123"));
    expect(onGrandchild.map((t) => t.current)).toEqual([null, "page", null]);

    // A route inside the section that no tab owns marks nothing at all — never the root by default.
    const onUnlisted = tabs(render(<TabNav label="Section" tabs={FIXTURE_TABS} />, "/section/unlisted"));
    expect(onUnlisted.map((t) => t.current)).toEqual([null, null, null]);
  });

  it("carries today's classes, and hands every tab to Next Link with no document marker", () => {
    const html = render(<TabNav label="Section" tabs={FIXTURE_TABS} />, "/section");
    expect(html).toContain('class="mb-4 flex flex-wrap gap-2"');
    expect(html).toContain(`class="${PILL_ACTIVE}"`);
    expect(html).toContain(`class="${PILL_IDLE}"`);
    // #275: the marker belongs only on plain anchors that intentionally load a document. A Link
    // carrying it would bypass the unsaved-edit guard; the source sweep in
    // tests/document-navigation.test.tsx enforces the same rule statically.
    expect(html).not.toContain("data-navigation");
    expect(tabs(html).map((t) => t.href)).toEqual(FIXTURE_TABS.map((t) => t.href));
  });
});

describe("ReceivablesNav", () => {
  // The four tabs #303 must not have changed. docs/manual/07-receivables.md:8 states these labels
  // and this order to the reader.
  it("still offers exactly Batches, Aging, Statements and Close", () => {
    const html = render(<ReceivablesNav />, "/receivables");
    expect(html).toContain('<nav aria-label="Receivables"');
    expect(tabs(html)).toEqual([
      { href: "/receivables", label: "Batches", current: "page" },
      { href: "/receivables/aging", label: "Aging", current: null },
      { href: "/receivables/statements", label: "Statements", current: null },
      { href: "/receivables/close", label: "Close", current: null },
    ]);
  });

  it("does not mark the Batches root on a sibling receivables screen", () => {
    const current = tabs(render(<ReceivablesNav />, "/receivables/aging"))
      .filter((t) => t.current !== null);
    expect(current).toEqual([{ href: "/receivables/aging", label: "Aging", current: "page" }]);
  });
});

describe("ReportsNav", () => {
  // Derived from report-registry.ts, never a second hand-written list: the tab set is "All reports"
  // plus every `area: "reports"` entry in registry order. The two HOMED cross-area entries
  // (Invoice register → /invoicing, A/R aging → /receivables/aging) are deliberately absent — they
  // live on other sections' pages and carry those areas' view grants — while staying on the index.
  it("is All reports plus the six native reports in registry order", () => {
    const html = render(<ReportsNav />, "/reports");
    expect(html).toContain('<nav aria-label="Reports"');
    expect(tabs(html).map((t) => [t.label, t.href])).toEqual([
      ["All reports", "/reports"],
      ...REPORTS.filter((r) => r.area === "reports").map((r) => [r.label, r.href]),
    ]);
    const homed = REPORTS.filter((r) => r.area !== "reports");
    expect(homed.map((r) => r.href)).toEqual(["/invoicing", "/receivables/aging"]);
    for (const entry of homed) expect(tabs(html).map((t) => t.href)).not.toContain(entry.href);
  });

  // e2e/flows/reports.mjs reaches the index by this exact accessible name.
  it("keeps the section root labelled exactly \"All reports\" and matches it exactly", () => {
    expect(tabs(render(<ReportsNav />, "/reports"))[0])
      .toEqual({ href: "/reports", label: "All reports", current: "page" });
    const onSales = tabs(render(<ReportsNav />, "/reports/sales"));
    expect(onSales[0].current).toBeNull();
    expect(onSales.filter((t) => t.current !== null))
      .toEqual([{ href: "/reports/sales", label: "Sales", current: "page" }]);
  });
});

// #644 (P7 step 4): one selected look for every underline strip. The order hub's section jumps and
// New order's tabs each drew their own blue; both now read TabNav's pair. Since the redesign's
// ruling 1 (2026-10-30) the pair is the pill pair of src/lib/ui-classes.ts and no underline strip
// remains: every `className` under `src/` that names TAB_ACTIVE or TAB_IDLE is found by parsing,
// must name both and spell no colour of its own, and no `className` anywhere carries `border-b-2`,
// so neither a fourth dialect nor the old underline can arrive unnoticed.
describe("every tab strip reads TabNav's pill pair, and no underline strip remains (#644, re-ruled 2026-10-30)", () => {
  it("keeps the pair at the pill strings", () => {
    expect(TAB_ACTIVE).toBe(PILL_ACTIVE);
    expect(TAB_IDLE).toBe(PILL_IDLE);
  });

  const SRC = fileURLToPath(new URL("../src", import.meta.url));
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
  const COLOUR = /\b(?:hover:)?(?:border|text|bg)-(?:slate|gray|blue|sky|indigo|transparent|black|white|ink|accent|link|surface|success|danger|line)\b/;
  const strips = walk(SRC).filter((f) => f.endsWith(".tsx")).flatMap((file) => {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const found: { where: string; names: string[]; literal: string }[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && node.name.getText(sf) === "className" && node.initializer
          && /\b(?:TAB|PILL)_(?:ACTIVE|IDLE)\b/.test(node.initializer.getText(sf))) {
        const names: string[] = []; const texts: string[] = [];
        const collect = (n: ts.Node): void => {
          if (ts.isIdentifier(n)) names.push(n.text);
          else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) texts.push(n.text);
          else if (ts.isTemplateExpression(n)) { texts.push(n.head.text, ...n.templateSpans.map((x) => x.literal.text)); }
          ts.forEachChild(n, collect);
        };
        collect(node.initializer);
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        found.push({ where: `${relative(SRC, file).split(sep).join("/")}:${line}`, names, literal: texts.join(" ") });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  });

  it("no className under src/ carries border-b-2", () => {
    const underlined = walk(SRC).filter((f) => f.endsWith(".tsx")).filter((file) => {
      const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      let hit = false;
      const visit = (node: ts.Node): void => {
        if (ts.isJsxAttribute(node) && node.name.getText(sf) === "className" && node.initializer
            && node.initializer.getText(sf).includes("border-b-2")) hit = true;
        ts.forEachChild(node, visit);
      };
      visit(sf);
      return hit;
    });
    expect(underlined.map((f) => relative(SRC, f).split(sep).join("/"))).toEqual([]);
  });

  // PR 2 retired the hub's own strip (its section jumps are RecordTabs now), so four remain.
  const STRIPS = [
    "app/orders/new/EntryWorkspace.tsx", "components/ListTabs.tsx",
    "components/RecordTabs.tsx", "components/TabNav.tsx",
  ];
  it("finds the four strips", () => {
    expect([...new Set(strips.map((s) => s.where.replace(/:\d+$/, "")))].sort()).toEqual(STRIPS);
  });

  it.each(STRIPS)(
    "%s chooses between the pair and spells no colour of its own", (file) => {
      for (const strip of strips.filter((s) => s.where.startsWith(`${file}:`))) {
        const pair = strip.names.includes("TAB_ACTIVE") ? ["TAB_ACTIVE", "TAB_IDLE"] : ["PILL_ACTIVE", "PILL_IDLE"];
        expect(strip.names).toEqual(expect.arrayContaining(pair));
        expect(strip.literal, strip.where).not.toMatch(COLOUR);
      }
    });
});
