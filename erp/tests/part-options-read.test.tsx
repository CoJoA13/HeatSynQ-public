// #684: a pick-list select on the part page says it is loading while its options read is out, and
// says the read failed only once it has. Specifications says "None." only once its links have
// landed. The decision is src/lib/options-read.ts's; the loading words are the owner's, in
// src/lib/waiting-titles.ts (ruling 2026-11-02).
//
// What the select says while its read is out is rendered here (the first render is that state);
// what it says once the read failed cannot be rendered without effects, so the leaf answers it and
// the census below holds every select and every options read on the page to the leaf.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { InspectionsSection } from "../src/app/parts/[id]/InspectionsSection";
import { SpecsSection } from "../src/app/parts/[id]/SpecsSection";
import { OPTIONS_FAILED, optionsSelectTitle } from "../src/lib/options-read";
import type { Gate } from "../src/lib/permission-ui";
import { LOADING_OPTIONS } from "../src/lib/waiting-titles";
import { jsxTags } from "./helpers/jsx-source";
import { literalTexts } from "./helpers/ts-parse";

const OPEN: Gate = { allowed: true, disabled: false, title: undefined };
const DENIED: Gate = { allowed: false, disabled: true, title: "Requires parts.edit" };

describe("the words", () => {
  it("the loading title is the owner's (2026-11-02), and the failure sentence is the one the selects always carried", () => {
    expect(LOADING_OPTIONS).toBe("Loading options…");
    expect(OPTIONS_FAILED).toBe("Options failed to load — reload the page");
  });
});

describe("optionsSelectTitle", () => {
  it("a read that is out says it is loading, under an open gate", () => {
    expect(optionsSelectTitle(OPEN, "loading")).toBe(LOADING_OPTIONS);
  });

  it("a read that is out keeps a closed gate's own title", () => {
    expect(optionsSelectTitle(DENIED, "loading")).toBe("Requires parts.edit");
  });

  it("a read that failed says so, ahead of the gate, as before", () => {
    expect(optionsSelectTitle(OPEN, "failed")).toBe(OPTIONS_FAILED);
    expect(optionsSelectTitle(DENIED, "failed")).toBe(OPTIONS_FAILED);
  });

  it("a read that is ready gives the gate's title", () => {
    expect(optionsSelectTitle(OPEN, "ready")).toBeUndefined();
    expect(optionsSelectTitle(DENIED, "ready")).toBe("Requires parts.edit");
  });
});

/** Every `<select ... title=...>` in `html`, by its title. */
function selectTitles(html: string): string[] {
  return [...html.matchAll(/<select[^>]*>/g)].map((m) => /title="([^"]*)"/.exec(m[0])?.[1] ?? "");
}

describe("while the options read is out (the first render)", () => {
  it("Specifications' picker says it is loading, and no \"None.\" shows before the links land", () => {
    const html = renderToStaticMarkup(
      <SpecsSection partId="part-1" perms={["parts.view", "parts.edit"]} onOptionsError={() => {}} />,
    );
    expect(selectTitles(html)).toEqual([LOADING_OPTIONS]);
    expect(html).not.toContain("None.");
    expect(html).not.toContain(OPTIONS_FAILED);
  });

  it("Specifications' picker keeps the permission title for a viewer without parts.edit", () => {
    const html = renderToStaticMarkup(
      <SpecsSection partId="part-1" perms={["parts.view"]} onOptionsError={() => {}} />,
    );
    expect(selectTitles(html)).toEqual(["Requires parts.edit"]);
  });

  it("Inspections' entry row says both its reads are loading", () => {
    const html = renderToStaticMarkup(
      <InspectionsSection partId="part-1" perms={["parts.view", "parts.edit"]} onOptionsError={() => {}} />,
    );
    expect(selectTitles(html)).toEqual([LOADING_OPTIONS, LOADING_OPTIONS]);
    expect(html).not.toContain(OPTIONS_FAILED);
  });
});

// ---- the census: every options select and every options read on the part page ----

const ERP = fileURLToPath(new URL("../", import.meta.url));
const SECTIONS = [
  ["src/app/parts/[id]/IdentitySection.tsx", 1],
  ["src/app/parts/[id]/SpecsSection.tsx", 1],
  ["src/app/parts/[id]/InspectionsSection.tsx", 4],
  ["src/app/parts/[id]/PricingSection.tsx", 2],
] as const;

/** The `.catch(...)` calls on a pick-list read in `file`, each by its handler's source. Parsed: a
 *  call whose receiver's source names `/api/picklists/`. */
function picklistCatches(file: string): string[] {
  const path = join(ERP, file);
  const src = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "catch" && node.expression.expression.getText(src).includes("/api/picklists/")) {
      found.push(node.arguments[0]?.getText(src) ?? "");
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return found;
}

describe("the part page's options selects read the leaf (#684)", () => {
  it.each(SECTIONS)("%s: each select titled from the leaf is disabled until its own read is ready", (file, count) => {
    const selects = jsxTags(file).filter((t) => t.name === "select" && /^optionsSelectTitle\(/.test(t.attr("title") ?? ""));
    expect(selects).toHaveLength(count);
    for (const s of selects) {
      const read = /^optionsSelectTitle\([^,]+,\s*(\w+)\)$/.exec((s.attr("title") ?? "").replace(/\s+/g, " "))?.[1];
      expect(read).toBeDefined();
      expect((s.attr("disabled") ?? "").replace(/\s+/g, " ")).toContain(`${read} !== "ready"`);
    }
  });

  it.each(SECTIONS)("%s: no select keeps the old boolean title, which said the read failed while it was out", (file) => {
    const selects = jsxTags(file).filter((t) => t.name === "select");
    for (const s of selects) expect(s.attr("title") ?? "").not.toMatch(/Ready\b/);
  });

  it.each(SECTIONS)("%s: every pick-list read marks itself failed when it fails", (file) => {
    const catches = picklistCatches(file);
    expect(catches.length).toBeGreaterThan(0);
    for (const handler of catches) expect(handler).toMatch(/\(\s*"failed"\s*\)/);
  });

  it.each(SECTIONS)("%s types neither sentence: both are the leaves'", (file) => {
    const texts = literalTexts(readFileSync(join(ERP, file), "utf8"), file).map((h) => h.text);
    expect(texts.filter((t) => t.includes(OPTIONS_FAILED) || t.includes(LOADING_OPTIONS))).toEqual([]);
  });
});
