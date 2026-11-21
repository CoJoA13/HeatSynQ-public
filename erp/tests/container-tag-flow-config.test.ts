import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildContainerTags, moreParts, type ContainerTagData } from "@/server/pdf/container-tags";
import { DEFAULT_CONFIG, TAG_JOIN } from "@/lib/template-contracts/container-tag";
import type { TemplateConfig } from "@/lib/template-contracts/types";
import { TAG_LABEL_SIZES } from "@/lib/template-contracts/canvas";
import { renderPdf } from "@/server/pdf/render";
import { pageCount } from "./helpers/pdf";
import { assertRun, printedPages } from "../e2e/lib/printed-page.mjs";
import { ORACLE_CASES } from "./container-tag-flow-oracle.test";

// Container tag PR 1, Task 4: the flow builder reads its template config. The frozen oracle
// (container-tag-flow-oracle.test.ts, never edited) holds the Standard to today's definition; these
// cases hold what a typed config changes.

const ORACLE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "container-tag-flow-oracle.json");
const tag = (over: Partial<ContainerTagData> = {}): ContainerTagData => ({
  orderNumber: "1234", customer: "Acme Steel", poNumber: "PO-1", parts: ["A × 1", "B × 2"],
  containersTotal: "3", received: "10/23/2026, 9:02 AM", ...over,
});
const withField = (key: string, patch: Record<string, unknown>, base: TemplateConfig = DEFAULT_CONFIG): TemplateConfig => {
  const c = structuredClone(base);
  const f = c.sections[0].fields.find((x) => x.key === key)!;
  Object.assign(f, patch);
  return c;
};
const stackOf = (def: ReturnType<typeof buildContainerTags>): Record<string, unknown>[] =>
  (def.content as unknown as { stack: Record<string, unknown>[] }[])[0].stack;
const texts = (config: TemplateConfig, t = tag()): string[] => {
  return stackOf(buildContainerTags([t], config)).map((l) => l.text as string);
};

describe("the Standard config reproduces the frozen definitions", () => {
  const oracle = JSON.parse(readFileSync(ORACLE, "utf8")) as Record<string, unknown>;
  it.each(ORACLE_CASES.map((c) => c.name))("%s, through the explicit Standard config", (name) => {
    const c = ORACLE_CASES.find((x) => x.name === name)!;
    expect(JSON.parse(JSON.stringify(buildContainerTags(c.tags, DEFAULT_CONFIG)))).toEqual(oracle[name]);
  });
});

describe("a typed config", () => {
  it("prints a renamed label through TAG_JOIN, and a blank label alone", () => {
    expect(TAG_JOIN("WO", "1234")).toBe("WO 1234");
    expect(texts(withField("order_number", { label: "WO" }))[0]).toBe("WO 1234");
    expect(texts(withField("order_number", { label: "" }))[0]).toBe("1234");
    expect(texts(withField("po_number", { label: "Cust PO" }))[2]).toBe("Cust PO PO-1");
  });

  it("prints nothing for a hidden field, and its margin goes with it", () => {
    const out = texts(withField("customer", { visible: false }));
    expect(out).toEqual(["Order #1234", "PO PO-1", "Containers: 3", "Received 10/23/2026, 9:02 AM", "A × 1", "B × 2"]);
    const def = JSON.stringify(buildContainerTags([tag()], withField("customer", { visible: false })));
    expect(def).not.toContain('"margin":[0,2,0,0]');
  });

  it("leaves Order # alone when every removable field is hidden, one page per tag", async () => {
    let c = DEFAULT_CONFIG;
    for (const k of ["customer", "po_number", "containers_total", "received", "parts"]) c = withField(k, { visible: false }, c);
    expect(texts(c)).toEqual(["Order #1234"]);
    const pdf = await renderPdf(buildContainerTags([tag(), tag()], c));
    expect(pageCount(pdf)).toBe(2);
    const pages = printedPages(pdf, { pages: 2, what: "the container tags" });
    for (const p of pages) assertRun(p, ["Order #1234"], "a bare tag");
  });

  it("prints fields in config order, each with its own style and margin", () => {
    const c = structuredClone(DEFAULT_CONFIG);
    const f = c.sections[0].fields;
    c.sections[0].fields = [f[2], f[1], f[0], f[5], f[4], f[3]]; // po, customer, order, parts, received, containers
    const def = buildContainerTags([tag()], c);
    const stack = stackOf(def);
    expect(stack.map((l) => l.text)).toEqual(["PO PO-1", "Acme Steel", "Order #1234", "A × 1", "B × 2", "Received 10/23/2026, 9:02 AM", "Containers: 3"]);
    expect(stack[0].margin).toEqual([0, 4, 0, 0]);
    expect(stack[1]).toMatchObject({ bold: true, fontSize: 12, margin: [0, 2, 0, 0] });
    expect(stack[2]).toMatchObject({ bold: true, fontSize: 20 });
    expect(stack[2].margin).toBeUndefined();
    expect(stack[3].margin).toEqual([0, 6, 0, 0]);
  });

  it("prints a typed parts label as a heading above the parts, one of the six", () => {
    const parts = Array.from({ length: 7 }, (_, i) => `P${i + 1}`);
    const c = withField("parts", { label: "Parts" });
    expect(texts(c, tag({ parts }))).toEqual([
      "Order #1234", "Acme Steel", "PO PO-1", "Containers: 3", "Received 10/23/2026, 9:02 AM",
      "Parts", "P1", "P2", "P3", "P4", "P5", moreParts(2),
    ]);
    const def = stackOf(buildContainerTags([tag({ parts })], c));
    expect(def[5].margin).toEqual([0, 6, 0, 0]);
    expect(def[6].margin).toBeUndefined();
  });

  it("prints no part line and no more line for zero lines, a typed label included", () => {
    expect(texts(DEFAULT_CONFIG, tag({ parts: [] }))).toHaveLength(5);
    expect(texts(withField("parts", { label: "Parts" }), tag({ parts: [] }))).toHaveLength(5);
  });

  it("carries the family and sizes into the definition", () => {
    const c = structuredClone(DEFAULT_CONFIG);
    c.fonts = { ...c.fonts, family: "Roboto", baseSize: 9, headingSize: 18 };
    const def = buildContainerTags([tag()], c);
    expect(def.defaultStyle).toEqual({ font: "Roboto", fontSize: 9 });
    const stack = stackOf(def);
    expect(stack[0]).toMatchObject({ fontSize: 18 });
    expect(stack[1]).toMatchObject({ fontSize: 11 });
  });

  it("takes the page and its margin from the label size's table entry (R3)", () => {
    const entry = TAG_LABEL_SIZES["4x3-landscape"];
    const saved = { ...entry };
    try {
      for (const [width, height, margin] of [[288, 216, 14], [360, 240, 9]]) {
        Object.assign(entry, { width, height, margin });
        const def = buildContainerTags([tag()], DEFAULT_CONFIG);
        expect(def.pageSize).toEqual({ width, height });
        expect(def.pageMargins).toBe(margin);
      }
    } finally {
      Object.assign(entry, saved);
    }
  });
});
