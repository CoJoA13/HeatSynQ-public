import { describe, it, expect } from "vitest";
import {
  buildContainerTags, TAG_PAGE, TAG_PARTS_SHOWN, moreParts, type ContainerTagData,
} from "@/server/pdf/container-tags";
import { LAYOUT, renderPdf } from "@/server/pdf/render";
import { pageCount } from "./helpers/pdf";
import { assertRun, printedPages } from "../e2e/lib/printed-page.mjs";

// #743: the container tag, the order hub's Print tags. The builder is PURE (the Invoice register's
// precedent, pdf/invoice-register.ts): every value arrives as the text it prints, so these cases hand
// it strings and read the rendered pages back as whole printed lines (`printedPages`,
// e2e/lib/printed-page.mjs). One tag per 4 in × 3 in page, so a label printer takes the file page by
// page (owner ruling 3, 2026-10-23), which is why a tag's height must never depend on its text.

function tag(overrides: Partial<ContainerTagData> = {}): ContainerTagData {
  return {
    orderNumber: "1031", customer: "Acme Steel Inc", poNumber: "4500123",
    parts: ["WIDGET-100 × 100", "BRACKET-7 × 20"], containersTotal: "5",
    received: "10/23/2026, 9:02 AM", ...overrides,
  };
}

/** The lines the first tag draws, in drawing order. */
const TAG_LINES = [
  "Order #1031", "Acme Steel Inc", "PO 4500123", "Containers: 5", "Received 10/23/2026, 9:02 AM",
  "WIDGET-100 × 100", "BRACKET-7 × 20",
];

/** Every page's whole printed lines, the page count read off the document itself. */
async function drawnPages(tags: ContainerTagData[]): Promise<string[][]> {
  const pdf = await renderPdf(buildContainerTags(tags));
  return printedPages(pdf, { pages: pageCount(pdf), what: "the container tags" });
}

describe("buildContainerTags", () => {
  it("is a pure builder: the definition survives a JSON round trip", () => {
    const def = buildContainerTags([tag()]);
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
  });

  it("is a 4 in × 3 in label, landscape, in points", async () => {
    expect(TAG_PAGE).toEqual({ width: 288, height: 216 });
    const def = buildContainerTags([tag()]);
    expect(def.pageSize).toEqual(TAG_PAGE);
    const pdf = await renderPdf(def);
    expect(pdf.toString("latin1")).toContain("/MediaBox [0 0 288 216]");
  });

  it("draws the order, the customer, the PO, the order's container total, the received line and each part on one page", async () => {
    const drawn = await drawnPages([tag()]);
    expect(drawn).toHaveLength(1);
    assertRun(drawn[0], TAG_LINES, "the container tag");
  });

  it("prints one tag per page, each tag whole on its own page", async () => {
    const drawn = await drawnPages([tag(), tag({ orderNumber: "1032" }), tag({ orderNumber: "1033" })]);
    expect(drawn).toHaveLength(3);
    assertRun(drawn[0], TAG_LINES, "tag 1");
    assertRun(drawn[1], ["Order #1032", ...TAG_LINES.slice(1)], "tag 2");
    assertRun(drawn[2], ["Order #1033", ...TAG_LINES.slice(1)], "tag 3");
  });

  it("lists at most TAG_PARTS_SHOWN parts and says how many more there are, so a long order's tag is still one page", async () => {
    expect(TAG_PARTS_SHOWN).toBe(6);
    const parts = Array.from({ length: 12 }, (_, i) => `PART-${i + 1} × ${i + 1}`);
    const drawn = await drawnPages([tag({ parts })]);
    expect(drawn).toHaveLength(1);
    assertRun(drawn[0], [...parts.slice(0, 6), moreParts(6)], "the long tag");
    expect(drawn[0]).not.toContain("PART-7 × 7");
    expect(moreParts(1)).toBe("and 1 more part");
    expect(moreParts(6)).toBe("and 6 more parts");
  });

  it("never wraps a line, so text longer than the label is cut at its edge and the tag stays one page", async () => {
    const long = "X".repeat(400);
    const drawn = await drawnPages([tag({ customer: long, poNumber: long, parts: Array.from({ length: 6 }, () => `${long} × 1`) })]);
    expect(drawn).toHaveLength(1);
    // The definition says so of every line it draws: a wrapped 400-character name is several lines
    // tall, and six of them would push a tag past its page.
    const def = buildContainerTags([tag()]);
    const texts: { noWrap?: boolean }[] = [];
    JSON.stringify(def, (_key, value: unknown) => {
      if (value !== null && typeof value === "object" && "text" in (value as object)) texts.push(value as { noWrap?: boolean });
      return value;
    });
    expect(texts.length).toBeGreaterThanOrEqual(TAG_LINES.length);
    expect(texts.every((node) => node.noWrap === true)).toBe(true);
  });

  it("prints a line break inside a value as one space, so a multiline name, PO or part number adds no line and the tag stays one page (Codex P2 on #744)", async () => {
    // `noWrap` stops wrapping by width and nothing else: pdfmake still breaks a line at an embedded
    // newline, and the customer, PO and part number schemas accept one. Six such parts under a
    // multiline name and PO are more lines than a label holds.
    const broken = Array.from({ length: 6 }, (_, i) => `PART-${i + 1}\nLINE TWO\r\nLINE THREE × ${i + 1}`);
    const drawn = await drawnPages([tag({ customer: "Acme\nSteel\u2028Inc", poNumber: "4500\r\n123", parts: broken })]);
    expect(drawn).toHaveLength(1);
    assertRun(drawn[0], ["Order #1031", "Acme Steel Inc", "PO 4500 123", "Containers: 5", "Received 10/23/2026, 9:02 AM",
      "PART-1 LINE TWO LINE THREE × 1"], "the multiline tag");
  });

  it("takes nothing of the renderer's measurement paths and has no footer", () => {
    const def = buildContainerTags([tag()]);
    // A steps table or a keep-together id sends a definition through `prepareTravelerLayout`,
    // which measures a named page size as portrait letter, and a measured-row id through
    // `fitMeasuredRows`, which refuses a landscape page (render.ts): no `"id":` covers both. An
    // `unbreakable` block taller than a page prints on no page at all.
    const text = JSON.stringify(def);
    expect(text).not.toContain(LAYOUT.steps);
    expect(text).not.toMatch(/"id":/);
    expect(text).not.toContain("unbreakable");
    expect(def.pageFooterSpec).toBeUndefined();
    expect(def.footer).toBeUndefined();
  });

  it("refuses an empty set: a label file with no tag has no page", () => {
    expect(() => buildContainerTags([])).toThrow(/at least one tag/);
  });
});
