import { describe, it, expect } from "vitest";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { jpegDataUri, renderPdf, renderSheetGroups } from "@/server/pdf/render";
import type { RenderableDefinition } from "@/server/pdf/render";
import type { Content } from "pdfmake/interfaces";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CANVAS_IDS } from "@/server/pdf/canvas-sheet";
import { CANVAS_TABLE_ID_PREFIX, blockAt } from "@/server/pdf/canvas-nodes";
import { TINY_JPEG, drawnPages, drawnText, pageCount, parseObjects, strokedLines, textRunsWithY } from "./helpers/pdf";

/**
 * Phase 7 Task 6 — the render runtime's declarative primitives (spec §6.1–§6.3): the page-footer
 * spec, the continuation-header spec, per-sheet-group rendering + merge, the four-family font
 * map, and the JPEG data-uri helper. No database — everything here is pure render plumbing.
 *
 * CONTENT-ASSERTION TECHNIQUE. The footer and continuation header exist only as renderer-side
 * callbacks (the named-table-layouts indirection), so `allText` over the definition — the house
 * technique for builder output — cannot see them, and CLAUDE.md forbids `Buffer.compare` between
 * fresh renders. `drawnText` below therefore decodes what the RENDERED bytes actually draw:
 * pdfkit embeds each font as a subset whose text operators carry subset glyph ids (never ASCII),
 * but every embedded font also carries a ToUnicode CMap mapping those ids back to Unicode — the
 * same table a PDF viewer's copy-paste uses. Inflate every FlateDecode stream, parse the CMaps,
 * decode every text run through them, and the assertions read the words the paper really shows.
 * The `/Type /Pages /Count N` marker stays the page-count assertion (traveler.test.ts's rule).
 * The decoder itself (`drawnPages`/`drawnText`/`pageCount`, and the TINY_JPEG fixture) lives in
 * tests/helpers/pdf.ts — lifted there by Task 7, the moment a second suite needed it.
 */

const count = (hay: string, needle: string): number => hay.split(needle).length - 1;
/** A pdfmake margin in each of the forms it takes. */
type Margin = number | [number, number] | [number, number, number, number];

// ------------------------------------------------------------------------------------------------
// Fixtures — body text carries NO digits (see drawnText's contract)
// ------------------------------------------------------------------------------------------------

/** A two-page definition: one text node per page, split by an explicit pageBreak. */
function twoPageDef(extra: Partial<RenderableDefinition> = {}): RenderableDefinition {
  return {
    content: [
      { text: "alpha body", pageBreak: "after" },
      { text: "beta body" },
    ],
    ...extra,
  };
}

// ------------------------------------------------------------------------------------------------
// The decoder itself — every assertion below is only as true as this (Task 8)
// ------------------------------------------------------------------------------------------------

describe("the ToUnicode decoder — LIGATURES (tests/helpers/pdf.ts)", () => {
  // Task 8 found this through the traveler: a fixture customer named "Overflow Co" decoded as a
  // consistent substitution cipher ("the" → "lfe"). pdfkit maps a ligature glyph to MULTIPLE code
  // points (`fl` → `<0066 006c>`), and inside a bfrange array they are space-separated — a hex
  // pattern that stopped at the space matched no item for that entry, so every LATER glyph id in
  // the array shifted down one. Nothing about it is traveler-specific: any fixture text with
  // fi/fl/ff would have silently corrupted every content assertion in the document.
  it("decodes text whose glyphs are ligatures, and everything after them", async () => {
    const line = "Overflow office affix — the quick brown fox jumps over the lazy dog";
    const pdf = await renderPdf({ content: [{ text: line }] });
    expect(drawnText(pdf)).toContain(line);
  });
});

describe("parseObjects — a stream is bounded by its declared /Length, not an endstream scan", () => {
  // The production failure this pins (quote-templates.test.ts, the title-override print): a
  // FlateDecode stream's final byte is arbitrary, so ~1 render in 128 ends in a CR/LF byte. The old
  // boundary heuristic scanned for the `endstream` keyword and greedily stripped EVERY trailing
  // CR/LF — eating that real data byte along with the spec's single separator EOL. The stream was
  // truncated by a byte, `inflateSync` threw, the whole page fell back to raw-compressed garbage,
  // and every text assertion decoded to "". Honoring the object's own `/Length` is byte-exact.
  const obj7 = (head: string, data: Buffer): Buffer =>
    Buffer.concat([Buffer.from(head, "latin1"), data, Buffer.from("\nendstream\nendobj\n", "latin1")]);

  // (a) The boundary defect itself, deterministic: an UNCOMPRESSED stream whose OWN bytes end in the
  // spec's separator characters. parseObjects can't inflate it, so it keeps the raw bytes — the same
  // byte range the FlateDecode path feeds to inflateSync. The single EOL before `endstream` is the
  // separator, never part of the data; the old greedy trim ate the data's matching final byte too.
  it.each([["LF", "\n"], ["CR", "\r"]])(
    "keeps a raw stream's final %s byte that the greedy endstream-trim consumed",
    (_name, eol) => {
      const data = Buffer.from(`payload whose last byte is a separator char${eol}`, "latin1");
      const pdf = obj7(`%PDF-1.7\n7 0 obj\n<< /Length ${data.length} >>\nstream\n`, data);
      expect(parseObjects(pdf).get(7)?.stream?.equals(data)).toBe(true);
    });

  // (b) The production symptom, faithful: a real FlateDecode stream whose COMPRESSED bytes end in a
  // LF. The old trim truncated it by a byte and inflateSync threw; /Length inflates the exact bytes.
  // sha256(i) gives deterministic high-entropy payloads, so a LF-terminated deflate is found in a
  // few hundred tries — reproducible, never flaky.
  it("inflates a FlateDecode stream whose compressed bytes end in a LF byte", () => {
    let raw: Buffer | null = null;
    let deflated: Buffer | null = null;
    for (let i = 0; i < 100_000; i++) {
      const candidate = createHash("sha256").update(String(i)).digest();
      const d = zlib.deflateSync(candidate);
      if (d[d.length - 1] === 0x0a) { raw = candidate; deflated = d; break; }
    }
    if (raw === null || deflated === null) throw new Error("no LF-terminated deflate found");
    const pdf = obj7(
      `%PDF-1.7\n7 0 obj\n<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n`, deflated);
    expect(parseObjects(pdf).get(7)?.stream?.equals(raw)).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------
// The page-footer spec
// ------------------------------------------------------------------------------------------------

describe("pageFooterSpec — the declarative pageNofM footer (spec §6.1)", () => {
  it("a 2-page definition renders 'Page N of M' on its own page, and /Count 2", async () => {
    const pdf = await renderPdf(twoPageDef({ pageFooterSpec: { kind: "pageNofM" } }));
    expect(pageCount(pdf)).toBe(2);
    const pages = drawnPages(pdf);
    expect(pages).toHaveLength(2);
    expect(count(pages[0], "Page 1 of 2")).toBe(1);
    expect(pages[0]).not.toContain("Page 2 of 2");
    expect(count(pages[1], "Page 2 of 2")).toBe(1);
    expect(pages[1]).not.toContain("Page 1 of 2");
  });

  it("label overrides the 'Page' prefix — 'Page:' reproduces the quote's exact footer text", async () => {
    const pdf = await renderPdf(
      twoPageDef({ pageFooterSpec: { kind: "pageNofM", label: "Page:" } }));
    const text = drawnText(pdf);
    expect(text).toContain("Page: 1 of 2");
    expect(text).toContain("Page: 2 of 2");
  });

  it("a spec-less definition renders exactly today's behavior — no footer text anywhere", async () => {
    const pdf = await renderPdf(twoPageDef());
    expect(pageCount(pdf)).toBe(2);
    expect(drawnText(pdf)).not.toMatch(/Page \d+ of \d+/);
  });

  it("a definition carrying BOTH a pdfmake footer and the spec is refused loudly", async () => {
    await expect(renderPdf(twoPageDef({
      footer: { text: "hand-written" }, pageFooterSpec: { kind: "pageNofM" },
    }))).rejects.toThrow(/pageFooterSpec/);
  });

  it("an unknown footer kind is refused loudly, never rendered as nothing", async () => {
    await expect(renderPdf(twoPageDef({
      pageFooterSpec: { kind: "pageXofY" } as never,
    }))).rejects.toThrow(/pageXofY/);
  });

  // Task 11's addition: the cert (and Task 12's invoice) carry a STATIC per-page company strip in
  // pdfmake's `footer` today. Turning the pageFooter knob on must not cost that strip, and the
  // both-keys refusal above stays — so the spec itself gains `above`: static JSON content stacked
  // over the page line, both rendered by the ONE renderer-side callback.
  it("static `above` content stacks over the page line on EVERY page — the cert's company strip shape", async () => {
    const pdf = await renderPdf(twoPageDef({
      pageFooterSpec: {
        kind: "pageNofM",
        above: { text: "COMPANY-STRIP-MARKER", fontSize: 7.5 },
      },
    }));
    const pages = drawnPages(pdf);
    expect(count(pages[0], "COMPANY-STRIP-MARKER")).toBe(1);
    expect(count(pages[1], "COMPANY-STRIP-MARKER")).toBe(1);
    expect(count(pages[0], "Page 1 of 2")).toBe(1);
    expect(count(pages[1], "Page 2 of 2")).toBe(1);
  });

  it("`above` is handed to pdfmake as pristine nodes per page — repeated layout never corrupts it", async () => {
    // pdfmake decorates laid-out nodes (the two-pass probe's own lesson); if the callback handed
    // the SAME node object to every page, page two would lay out a decorated node. A 3-page render
    // exercises the repetition; the strip must draw exactly once per page.
    const pdf = await renderPdf({
      content: [
        { text: "alpha body", pageBreak: "after" },
        { text: "beta body", pageBreak: "after" },
        { text: "gamma body" },
      ],
      pageFooterSpec: { kind: "pageNofM", above: { columns: [{ width: "*", text: "LEFT-STRIP" }, { width: 100, text: "RIGHT-STRIP", alignment: "right" }] } },
    });
    for (const page of drawnPages(pdf)) {
      expect(count(page, "LEFT-STRIP")).toBe(1);
      expect(count(page, "RIGHT-STRIP")).toBe(1);
    }
  });
});

// ------------------------------------------------------------------------------------------------
// The continuation-header spec
// ------------------------------------------------------------------------------------------------

describe("continuationHeaderSpec — static content on every page after the first (spec §6.1)", () => {
  const SPEC = { content: { text: "CONTINUED-MARKER-ALPHA", fontSize: 8 } };

  it("page one lacks it, page two carries it", async () => {
    const pdf = await renderPdf(twoPageDef({ continuationHeaderSpec: SPEC }));
    expect(pageCount(pdf)).toBe(2);
    const pages = drawnPages(pdf);
    expect(pages).toHaveLength(2);
    expect(pages[0]).not.toContain("CONTINUED-MARKER-ALPHA");
    expect(pages[1]).toContain("CONTINUED-MARKER-ALPHA");
  });

  it("a single-page definition never shows it at all", async () => {
    const pdf = await renderPdf({
      content: [{ text: "lonely body" }], continuationHeaderSpec: SPEC,
    });
    expect(pageCount(pdf)).toBe(1);
    expect(drawnText(pdf)).not.toContain("CONTINUED-MARKER-ALPHA");
  });

  it("a definition carrying BOTH a pdfmake header and the spec is refused loudly", async () => {
    await expect(renderPdf(twoPageDef({
      header: { text: "hand-written" }, continuationHeaderSpec: SPEC,
    }))).rejects.toThrow(/continuationHeaderSpec/);
  });
});

// ------------------------------------------------------------------------------------------------
// overflowTopMargin — header room reserved only when the sheet overflows (Task 8, #36's margin)
// ------------------------------------------------------------------------------------------------

describe("continuationHeaderSpec.overflowTopMargin — the two-pass render", () => {
  // A traveler-sized identity band (text + a 44pt barcode) cannot fit a 24pt top margin, but
  // pdfmake margins are per-document: reserving header room on pages 2+ means reserving it on
  // EVERY page, and doing that unconditionally would move page one of every print — the
  // golden-compat killer. The contract under test: a definition that fits one page renders with
  // its ORIGINAL margins, content exactly as if the spec were absent; an overflowing one
  // re-renders with the top margin raised to the reserve so the header has its room.

  // A factory, not a shared const: pdfmake decorates content nodes it renders (a `resetXY`
  // function lands on them), so a spec shared across tests would leak one render's mutations
  // into the next test's fixture.
  const spec = (overflowTopMargin = 64) =>
    ({ content: { text: "CONTINUED-MARKER-ALPHA", fontSize: 8 }, overflowTopMargin });

  /** First drawn text's flipped-space Tm y on the FIRST page — pdfkit writes page one's content
   *  stream first, and a top-margin increase of Δ lowers this value by exactly Δ. */
  const firstTextY = (pdf: Buffer): number => {
    const streams = [...parseObjects(pdf).entries()].sort(([a], [b]) => a - b)
      .map(([, o]) => o.stream?.toString("latin1") ?? "");
    const content = streams.find((s) => s.includes("Tm"));
    const m = content && /1 0 0 1 [\d.]+ ([\d.]+) Tm/.exec(content);
    if (!m) throw new Error("No Tm operator found in any content stream");
    return Number(m[1]);
  };

  it("a one-page definition keeps its original margins and shows no header", async () => {
    // A factory for the same reason `spec` is one — the two renders must not share content nodes.
    const body = (): RenderableDefinition =>
      ({ pageMargins: [24, 24, 24, 24], content: [{ text: "lonely body" }] });
    const bare = await renderPdf(body());
    const pdf = await renderPdf({ ...body(), continuationHeaderSpec: spec() });
    expect(pageCount(pdf)).toBe(1);
    expect(drawnText(pdf)).toBe(drawnText(bare));
    expect(firstTextY(pdf)).toBe(firstTextY(bare)); // the original 24pt top margin, untouched
  });

  it("an overflowing definition re-renders with the reserved top margin and the header on pages 2+", async () => {
    const margins = [24, 24, 24, 24] as [number, number, number, number];
    const bare = await renderPdf(twoPageDef({ pageMargins: margins }));
    const pdf = await renderPdf(twoPageDef({ pageMargins: margins, continuationHeaderSpec: spec() }));
    expect(pageCount(pdf)).toBe(2);
    const pages = drawnPages(pdf);
    expect(pages[0]).not.toContain("CONTINUED-MARKER-ALPHA");
    expect(pages[1]).toContain("CONTINUED-MARKER-ALPHA");
    // The top margin was raised 24 → 64: page one's first text sits exactly 40pt lower.
    expect(firstTextY(bare) - firstTextY(pdf)).toBeCloseTo(40, 5);
  });

  it("a reserve at or below the definition's own top margin changes nothing", async () => {
    const margins = [24, 60, 24, 24] as [number, number, number, number];
    const bare = await renderPdf(twoPageDef({ pageMargins: margins }));
    const pdf = await renderPdf(twoPageDef({
      pageMargins: margins,
      continuationHeaderSpec: spec(44),
    }));
    expect(firstTextY(pdf)).toBe(firstTextY(bare)); // Math.max keeps the larger own margin
    expect(drawnPages(pdf)[1]).toContain("CONTINUED-MARKER-ALPHA");
  });

  it("refuses a function-carrying definition loudly — the probe clone would silently drop it", async () => {
    await expect(renderPdf(twoPageDef({
      footer: () => ({ text: "hand-written" }),
      continuationHeaderSpec: spec(),
    }))).rejects.toThrow(/plain-JSON/);
  });

  it("the spec key stays plain data — overflowTopMargin survives the JSON round trip", async () => {
    const def = twoPageDef({ continuationHeaderSpec: spec() });
    const roundTripped = JSON.parse(JSON.stringify(def)) as RenderableDefinition;
    expect(roundTripped).toEqual(def);
    expect(drawnText(await renderPdf(roundTripped))).toBe(drawnText(await renderPdf(def)));
  });

  // ONE node object at two places of the content, as a builder writes when it spreads one list of
  // cells into a row twice. pdfmake uses a text node's measured words up as it lays the node out,
  // so a pass that lays out such an object itself draws it at its first place only. In a JSON
  // copy the two places are two nodes.
  const twicePlaced = (laterPages: number): RenderableDefinition => {
    const shared = { text: "TWICEPLACED" };
    return {
      pageSize: "LETTER", pageMargins: [24, 24, 24, 24],
      content: [
        { table: { widths: ["*", "*"], body: [[shared, shared]] } },
        ...Array.from({ length: laterPages }, () => ({ text: "later body", pageBreak: "before" as const })),
      ],
      continuationHeaderSpec: spec(),
    };
  };
  // The first row holds the first pass alone: a one-page document is that pass's bytes, laid out
  // from a copy. It is green with or without the second pass's copy.
  it.each([
    ["fits one page", 0, [false]],
    ["passes a page", 1, [false, true]],
  ] as const)("a node placed twice prints at both places when the definition %s", async (_name, laterPages, headerOnPage) => {
    const pdf = await renderPdf(twicePlaced(laterPages));
    // One page with no header is the first pass's bytes. A header on page two is the second pass's.
    expect(drawnPages(pdf).map((page) => page.includes("CONTINUED-MARKER-ALPHA"))).toEqual(headerOnPage);
    // Page one is 612 points wide, and the two columns share it: one run in each half.
    const runs = textRunsWithY(pdf)[0].filter((r) => r.text.trim() === "TWICEPLACED");
    expect(runs.map((r) => (r.x < 306 ? "left half" : "right half")).sort()).toEqual(["left half", "right half"]);
  });
});

// ------------------------------------------------------------------------------------------------
// A shipping ticket's totals block: found by its id and its unbreakable mark, measured, and
// changed only when it is taller than a page
// ------------------------------------------------------------------------------------------------

describe("a one-pass definition that holds a block under the id `ticket-totals`", () => {
  // One pass lays out what the renderer's measuring step handed back. That is the caller's own
  // nodes when nothing was changed, and there ONE node object at two places is drawn at its first
  // place only. It is a JSON copy when a block lost its mark, and there the two places are two
  // nodes. So where TWICEPLACED is drawn tells which of the two was laid out.
  //
  // A LETTER page with 24-point margins has 744 points for the body, and a line of the default
  // 12-point text is 14.0625 points: three lines fit a page and 53 lines do not.
  const withBlock = (lines: number, mark: { unbreakable?: true }): RenderableDefinition => {
    const shared = { text: "TWICEPLACED" };
    const block = { id: "ticket-totals", ...mark, stack: Array.from({ length: lines }, () => ({ text: "BLOCKLINE" })) };
    return {
      pageSize: "LETTER", pageMargins: [24, 24, 24, 24],
      content: [{ table: { widths: ["*", "*"], body: [[shared, shared]] } }, block],
    };
  };

  it.each<[laidOut: string, block: string, lines: number, mark: { unbreakable?: true }, halves: string[]]>([
    ["the caller's own nodes", "fits a page", 3, { unbreakable: true }, ["left half"]],
    ["a copy", "is taller than a page", 53, { unbreakable: true }, ["left half", "right half"]],
    ["the caller's own nodes", "is taller than a page and carries no mark", 53, {}, ["left half"]],
  ])("is laid out from %s when the block %s", async (_laidOut, _block, lines, mark, halves) => {
    const pdf = await renderPdf(withBlock(lines, mark));
    const runs = textRunsWithY(pdf)[0].filter((r) => r.text.trim() === "TWICEPLACED");
    // Page one is 612 points wide, and the two columns share it.
    expect(runs.map((r) => (r.x < 306 ? "left half" : "right half")).sort()).toEqual(halves);
  });
});

// ------------------------------------------------------------------------------------------------
// A shipping ticket's tear-off strip: found by its id and its unbreakable mark, measured, and
// changed only when it is taller than a page
// ------------------------------------------------------------------------------------------------

describe("a one-pass definition that holds a block under the id `ticket-tear-off`", () => {
  // Where TWICEPLACED is drawn tells the caller's own nodes from a copy, as in the describe above.
  // That alone cannot show that the block printed, so each row also counts its lines on each page.
  // The block carries the strip's 16-point top margin unless a row gives it another.
  const withStrip = (
    lines: number, mark: { unbreakable?: true }, id?: string, margin: Margin = [0, 16, 0, 0], line = "STRIPLINE",
  ): RenderableDefinition => {
    const shared = { text: "TWICEPLACED" };
    const block = {
      ...(id === undefined ? {} : { id }), ...mark, margin,
      stack: Array.from({ length: lines }, () => ({ text: line })),
    };
    return {
      pageSize: "LETTER", pageMargins: [24, 24, 24, 24],
      content: [{ table: { widths: ["*", "*"], body: [[shared, shared]] } }, block],
    };
  };
  /** Which halves of page one draw TWICEPLACED, and how many of the block's lines each page draws.
   *  Page one is 612 points wide, and the two columns share it. */
  const drawnOf = (pdf: Buffer) => {
    const byPage = textRunsWithY(pdf);
    return {
      halves: byPage[0].filter((r) => r.text.trim() === "TWICEPLACED").map((r) => (r.x < 306 ? "left half" : "right half")).sort(),
      perPage: byPage.map((page) => page.filter((r) => r.text.trim() === "STRIPLINE").length),
    };
  };

  it.each<[laidOut: string, block: string, lines: number, mark: { unbreakable?: true }, halves: string[], perPage: number[]]>([
    ["the caller's own nodes", "fits a page", 3, { unbreakable: true }, ["left half"], [3]],
    ["a copy", "is taller than a page", 60, { unbreakable: true }, ["left half", "right half"], [50, 10]],
    ["the caller's own nodes", "is taller than a page and carries no mark", 60, {}, ["left half"], [50, 10]],
  ])("is laid out from %s when the block %s, and each of its lines is drawn", async (_laidOut, _block, lines, mark, halves, perPage) => {
    expect(drawnOf(await renderPdf(withStrip(lines, mark, "ticket-tear-off")))).toEqual({ halves, perPage });
  });

  // pdfmake moves a block down by its top margin before it starts the block, and fits only the
  // block's own lines to a page; on the page the block moves to, the top margin is not applied
  // again. 52 lines are 731.25 points of the 744 a page holds, 747.25 with the margin, and pdfmake
  // draws them whole on page 2. 53 lines are 745.3125 points, and pdfmake draws none of them. With
  // no id the renderer leaves the block alone, so these two rows are pdfmake's own fit test: run
  // them before a pdfmake update.
  it.each<[lines: number, perPage: number[]]>([[52, [0, 52]], [53, [0, 0]]])(
    "with no id, pdfmake tests a marked block of %i lines against a page without its 16-point top margin: the pages draw %j of its lines",
    async (lines, perPage) => {
      expect(drawnOf(await renderPdf(withStrip(lines, { unbreakable: true })))).toEqual({ halves: ["left half"], perPage });
    });

  // So the renderer measures the block without its top and bottom margins. At 52 lines it keeps the
  // mark, as pdfmake fits it; at 53 it takes the mark off, and the block flows.
  it.each<[lines: number, laidOut: string, halves: string[], perPage: number[]]>([
    [52, "the caller's own nodes", ["left half"], [0, 52]],
    [53, "a copy", ["left half", "right half"], [50, 3]],
  ])("a marked block of %i lines with a 16-point top margin is laid out from %s, and each of its lines is drawn", async (lines, _laidOut, halves, perPage) => {
    expect(drawnOf(await renderPdf(withStrip(lines, { unbreakable: true }, "ticket-tear-off")))).toEqual({ halves, perPage });
  });

  // A margin written as one number, as [sides, top and bottom] or as four numbers can hold a bottom
  // margin as well as a top one, and the renderer leaves both out. 52 lines are 731.25 points, 747.25
  // with either 16-point margin and 763.25 with both, so a measure that kept either would take the
  // mark off. pdfmake applies the bottom margin after the block, where the 12.75 points left on
  // page 2 cannot hold it, and so starts a page 3 that draws nothing.
  it.each<[form: string, margin: Margin]>([["one number", 16], ["two numbers", [0, 16]], ["four numbers with a bottom margin", [0, 16, 0, 16]]])(
    "a marked block of 52 lines whose margin is written as %s keeps its mark: the caller's own nodes, drawn whole on page 2",
    async (_form, margin) => {
      expect(drawnOf(await renderPdf(withStrip(52, { unbreakable: true }, "ticket-tear-off", margin))))
        .toEqual({ halves: ["left half"], perPage: [0, 52, 0] });
    });

  // The side margins stay in the measure: they set the width the block's text wraps at. Each item
  // of five words is one line across the page and two between 150-point side margins, so 30 items
  // are 30 lines across the page and 60 between those margins. A margin written as one number or as
  // [sides, top and bottom] sets the sides too; written as one number, it also moves the block 150
  // points down page 1.
  it.each<[form: string, margin: Margin, perPage: number[]]>([
    ["four numbers", [150, 16, 150, 0], [125, 25]],
    ["one number", 150, [100, 50]],
    ["two numbers", [150, 16], [125, 25]],
  ])("a marked block whose side margins, written as %s, wrap it taller than a page is a copy, and every word of it is drawn", async (_form, margin, perPage) => {
    const def = withStrip(30, { unbreakable: true }, "ticket-tear-off", margin, "STRIPLINE ".repeat(5).trim());
    expect(drawnOf(await renderPdf(def))).toEqual({ halves: ["left half", "right half"], perPage });
  });

  // The renderer finds a ticket's kept-together block by its id, `ticket-totals` or
  // `ticket-tear-off`, and by no other. The same marked block, taller than a page, under another id
  // is the caller's own nodes, and pdfmake draws none of its lines.
  it("leaves a block under another id as it is: marked and taller than a page, none of its lines is drawn", async () => {
    expect(drawnOf(await renderPdf(withStrip(60, { unbreakable: true }, "some-other-block"))))
      .toEqual({ halves: ["left half"], perPage: [0, 0] });
  });

  // Nor by its shape. A shipping ticket's strip carries the id only where the builder gives it one
  // (pdf/shipping-ticket.ts `tearOff`), and a strip without it is left as it is: the same marked
  // block, its stack opening with a rule as the strip's does, taller than a page and with no id, is
  // the caller's own nodes, and pdfmake draws none of its lines.
  it("leaves a block with no id as it is although it has the strip's mark and a stack that opens with a rule: taller than a page, none of its lines is drawn", async () => {
    const shared = { text: "TWICEPLACED" };
    const def: RenderableDefinition = {
      pageSize: "LETTER", pageMargins: [24, 24, 24, 24],
      content: [
        { table: { widths: ["*", "*"], body: [[shared, shared]] } },
        {
          unbreakable: true, margin: [0, 16, 0, 0],
          stack: [
            { canvas: [{ type: "line", x1: 0, y1: 0, x2: 564, y2: 0, lineWidth: 1.5 }], margin: [0, 0, 0, 6] },
            ...Array.from({ length: 60 }, () => ({ text: "STRIPLINE" })),
          ],
        },
      ],
    };
    expect(drawnOf(await renderPdf(def))).toEqual({ halves: ["left half"], perPage: [0, 0] });
  });
});

// ------------------------------------------------------------------------------------------------
// The invoice's order strip: a row found by its id, each of its columns measured, and the row fitted
// to one line by an equal share (#590)
// ------------------------------------------------------------------------------------------------

describe("a one-pass definition that holds a row under the id `invoice-order-strip`", () => {
  // Each row has the shape of the invoice's order strip: four label-and-value pairs at 9 points,
  // 12 points apart, in a row indented 58 points on a LETTER page with 24-point side margins. Here
  // the last of them is a star column, which render.ts supports and the invoice no longer uses (its
  // Process is an auto column, #590's plan amendment 3). The line runs from x = 82 to x = 588, and
  // the three gaps leave 470 points for the four columns.
  //
  // `textRunsWithY` gives where each word STARTS, and nothing of where it ends, so every assertion
  // here is made of starts. A column starts at its label's first word. Its width is where the next
  // column starts less the 12-point gap, and the star column's, the last, is 588 less its start. It
  // takes as many baselines as its words have different y values. And nothing printed past the
  // margin is every word starting before 588. A row too narrow to share prints as a stack (case 11):
  // each field then starts at the row's indent, on a lower baseline than the one before.
  const ID = "invoice-order-strip";
  const GAP = 12;
  const LABELS = ["Our Order #:", "Your PO #:", "Material:", "Process:"];
  const SHORT = ["1031", "PO 24115", "Ductile Iron", "Austemper"];
  /** Eight operations, about 406 points with its label on one line: wider than the 231 or so the three
   *  short fields leave the star column. */
  const PROCESS = "Austemper, Stress Relieve, Neutral Harden, Temper, Gas Nitride, Carburize, Anneal, Normalize";
  /** 200 characters with spaces in them, wider than the line (about 996 points). */
  const LONG_PO = "PO 24115 RELEASE ".repeat(12).slice(0, 200);
  type Width = "auto" | "*" | number;
  type Run = { text: string; x: number; y: number };
  const NINE = { fontSize: 9 };

  const pair = (label: string, value: string, width: Width, style: object = NINE) =>
    ({ width, text: [{ text: `${label} `, bold: true }, value], ...style });
  /** The strip's row: a pair per value, under the id unless `id` is false, the last pair the star. */
  const row = (values: string[], opts: { id?: false; margin?: Margin; widths?: Width[]; style?: object } = {}) => ({
    ...(opts.id === false ? {} : { id: ID }),
    columns: values.map((value, i) =>
      pair(LABELS[i], value, (opts.widths ?? ["auto", "auto", "auto", "*"])[i], opts.style)),
    columnGap: GAP,
    margin: opts.margin ?? [58, 0, 0, 0],
  });
  const onPage = (content: unknown[], extra: Partial<RenderableDefinition> = {}): RenderableDefinition =>
    ({ pageSize: "LETTER", pageMargins: [24, 24, 24, 44], content, ...extra }) as RenderableDefinition;

  /** Page one's runs, column by column. pdfkit draws a word as a run, and a column's text under
   *  `noWrap` as one run of each style, so a column starts at its label's run, or the run of its
   *  label's first word. pdfkit draws a row column by column, so a column holds every run drawn from
   *  there to the next label's; the last holds the runs drawn after its label that start at or right
   *  of it. */
  const columnsOf = (pdf: Buffer): Run[][] => {
    const page = textRunsWithY(pdf)[0];
    const at = LABELS.map((label) => page.findIndex((r) => [label, label.split(" ")[0]].includes(r.text.trim())));
    expect(at.every((i) => i >= 0), `every label is drawn on page one: ${JSON.stringify(at)}`).toBe(true);
    // A column is cut from one label's run to the next one's, so the labels must be drawn in their order.
    expect(at.every((i, k) => k === 0 || i > at[k - 1]), `the labels are drawn in their order: ${JSON.stringify(at)}`).toBe(true);
    return at.map((start, i) => {
      if (i + 1 < at.length) return page.slice(start, at[i + 1]);
      const rest = page.slice(start);
      const end = rest.findIndex((r) => r.x < rest[0].x);
      return end < 0 ? rest : rest.slice(0, end);
    });
  };
  const baselines = (column: Run[]): number => new Set(column.map((r) => r.y)).size;
  /** Each column's width: where the next starts less the gap; the last's, the line's end less its start. */
  const widthsOf = (columns: Run[][], end = 588): number[] => columns.map((column, i) =>
    (i + 1 < columns.length ? columns[i + 1][0].x : end + GAP) - column[0].x - GAP);
  /** A pair's width on one line, measured alone, independently of the renderer's measuring: a row of
   *  the pair and one word after it, with no id, on the strip's line. */
  const naturalAlone = async (i: number, value: string, extra: Partial<RenderableDefinition> = {}, style: object = NINE) => {
    const page = textRunsWithY(await renderPdf(onPage([{
      columns: [pair(LABELS[i], value, "auto", style), { width: "auto", text: "END" }], columnGap: GAP, margin: [58, 0, 0, 0],
    }], extra)))[0];
    return page.find((r) => r.text === "END")!.x - page[0].x - GAP;
  };
  /** Columns 1, 3 and 4 of a row of `values`, each measured alone. */
  const othersAlone = async (values: string[], extra: Partial<RenderableDefinition> = {}, style: object = NINE) =>
    [await naturalAlone(0, values[0], extra, style), await naturalAlone(2, values[2], extra, style),
      await naturalAlone(3, values[3], extra, style)];
  /** Columns 1, 3 and 4 each at its width measured alone, and column 2 at what they leave of `line`. */
  const capsAt = (widths: number[], naturals: number[], line: number): void => {
    [0, 2, 3].forEach((i, k) => expect(widths[i], `column ${i + 1}`).toBeCloseTo(naturals[k], 1));
    expect(widths[1]).toBeCloseTo(line - naturals[0] - naturals[1] - naturals[2], 1);
  };
  /** Columns 1, 3 and 4 each on one baseline, the first line's; column 2 on two or more. */
  const capsTheSecond = (columns: Run[][]): void => {
    const first = columns[0][0].y;
    for (const i of [0, 2, 3]) expect(columns[i].map((r) => r.y), `column ${i + 1}`).toEqual(columns[i].map(() => first));
    expect(columns[1][0].y).toBe(first);
    expect(baselines(columns[1])).toBeGreaterThanOrEqual(2);
  };

  // 1. pdfmake sizes a row's columns by itself, and counts the star column's whole text in the row's
  // widest: when the four do not fit one line, every auto column gives up width in proportion to how
  // far it can shrink, its whole text on one line less its widest word, and "Our Order #:" prints
  // above "1031". The id is what keeps the short fields whole.
  it("keeps the three short fields on the first line while the star column wraps; without the id the first field is squeezed onto two", async () => {
    const values = [...SHORT.slice(0, 3), PROCESS];
    const fitted = columnsOf(await renderPdf(onPage([row(values)])));
    expect(fitted.map((column) => column[0].y)).toEqual(fitted.map(() => fitted[0][0].y));
    expect(fitted.slice(0, 3).map(baselines)).toEqual([1, 1, 1]);
    expect(baselines(fitted[3])).toBeGreaterThanOrEqual(2);

    const squeezed = columnsOf(await renderPdf(onPage([row(values, { id: false })])));
    expect(baselines(squeezed[0])).toBe(2);
  });

  // 2. A field wider than the line is held to its share, here what the other three leave, and wraps
  // inside it; nothing runs past the margin. Its width is checked against the other three measured
  // alone, never against the renderer's own arithmetic.
  it("holds a 200-character field to what the others leave: it wraps inside that, and nothing starts past the margin", async () => {
    const values = [SHORT[0], LONG_PO, SHORT[2], SHORT[3]];
    const columns = columnsOf(await renderPdf(onPage([row(values)])));
    expect(columns.flat().filter((r) => r.x >= 588)).toEqual([]);
    capsTheSecond(columns);
    capsAt(widthsOf(columns), await othersAlone(values), 470);
  });

  // 3. Two fields wider than their share, one of them the star column, share what the short two
  // leave equally. A plain quarter of the line each would leave the star column the rest.
  it("shares what the short fields leave equally between two long ones, the star column one of them", async () => {
    const columns = columnsOf(await renderPdf(onPage([row([SHORT[0], LONG_PO, SHORT[2], PROCESS])])));
    expect([baselines(columns[0]), baselines(columns[2])]).toEqual([1, 1]);
    expect(baselines(columns[1])).toBeGreaterThanOrEqual(2);
    expect(baselines(columns[3])).toBeGreaterThanOrEqual(2);
    expect(columns.flat().filter((r) => r.x >= 588)).toEqual([]);
    const widths = widthsOf(columns);
    expect(widths[1]).toBeCloseTo(widths[3], 1);
  });

  // 4. Fields that fit keep their own widths, as pdfmake gives them by itself.
  it("leaves fields that fit at their own widths on one baseline", async () => {
    const columns = columnsOf(await renderPdf(onPage([row(SHORT)])));
    expect(columns.map(baselines)).toEqual([1, 1, 1, 1]);
    expect(columns.map((column) => column[0].y)).toEqual(columns.map(() => columns[0][0].y));
    const starts = columns.map((column) => column[0].x);
    expect(starts.every((x, i) => i === 0 || x > starts[i - 1])).toBe(true);
    const widths = widthsOf(columns);
    for (const i of [0, 1, 2]) expect(widths[i]).toBeCloseTo(await naturalAlone(i, SHORT[i]), 1);
  });

  // 5. The measure is taken in the definition's own style. Case 2's row under Roboto Mono 11 is
  // wider in every field: "Material: Ductile Iron" no longer fits its share, so it and the PO share
  // what "Our Order #: 1031" and "Process: Austemper" leave, and those two keep their own widths in
  // that style. Measured in pdfmake's default (Roboto 12), all three short fields would seem to fit,
  // and the star column would be left too little for "Process: Austemper".
  it("measures in the definition's default style", async () => {
    const mono = { defaultStyle: { font: "Roboto Mono", fontSize: 11 } };
    const values = [SHORT[0], LONG_PO, SHORT[2], SHORT[3]];
    const columns = columnsOf(await renderPdf(onPage([row(values, { style: {} })], mono)));
    expect(columns.map((column) => column[0].y)).toEqual(columns.map(() => columns[0][0].y));
    expect([baselines(columns[0]), baselines(columns[3])]).toEqual([1, 1]);
    expect(baselines(columns[1])).toBeGreaterThanOrEqual(2);
    expect(baselines(columns[2])).toBeGreaterThanOrEqual(2);
    expect(columns.flat().filter((r) => r.x >= 588)).toEqual([]);
    const widths = widthsOf(columns);
    expect(widths[0]).toBeGreaterThan(await naturalAlone(0, SHORT[0]));
    const [order, process] = [await naturalAlone(0, values[0], mono, {}), await naturalAlone(3, values[3], mono, {})];
    expect(widths[0]).toBeCloseTo(order, 1);
    expect(widths[3]).toBeCloseTo(process, 1);
    expect(widths[1]).toBeCloseTo((470 - order - process) / 2, 1);
    expect(widths[2]).toBeCloseTo((470 - order - process) / 2, 1);
  });

  // 6. What the renderer cannot measure it refuses, naming the row: a builder bug, never a print.
  it.each<[what: string, def: () => RenderableDefinition, refusal: RegExp]>([
    ["nested in a stack", () => onPage([{ stack: [row(SHORT)] }]),
      /Invoice order strip must be an item of the definition's top-level content array/],
    ["with a column of numeric width", () => onPage([row(SHORT, { widths: ["auto", 120, "auto", "*"] })]),
      /Invoice order strip's column 2 has the width 120: a measured row's columns are "auto" or "\*"/],
    ["with two star columns", () => onPage([row(SHORT, { widths: ["auto", "*", "auto", "*"] })]),
      /Invoice order strip has 2 "\*" columns: a measured row takes one at most/],
    ["on a page size other than LETTER", () => onPage([row(SHORT)], { pageSize: "A4" }),
      /Invoice order strip is measured on a "LETTER" page or a page of numeric width, and this one is "A4"/],
    ["on a landscape page", () => onPage([row(SHORT)], { pageOrientation: "landscape" }),
      /Invoice order strip is measured on a portrait page, and this one is landscape/],
    // pdfmake swaps the two, so the page is 612 wide where the page size says 792.
    ["on a page size wider than tall under a portrait orientation",
      () => onPage([row(SHORT)], { pageSize: { width: 792, height: 612 }, pageOrientation: "portrait" }),
      /Invoice order strip is measured on a page as wide as its page size says, and pdfmake swaps this one's width and height: it is wider than tall, under a portrait orientation/],
    ["on no page size at all", () => onPage([row(SHORT)], { pageSize: undefined }),
      /Invoice order strip is measured on a "LETTER" page or a page of numeric width, and this one is pdfmake's default, A4/],
    ["given as the whole content, not an item of an array",
      () => ({ ...onPage([]), content: row(SHORT) }) as RenderableDefinition,
      /Invoice order strip must be an item of the definition's top-level content array/],
    ["with no columns", () => onPage([{ id: ID, text: "Our Order #: 1031" }]),
      /Invoice order strip is not a row of columns, and only a row of columns is measured/],
    ["under a definition key other than content",
      () => onPage([], { continuationHeaderSpec: { content: row(SHORT), overflowTopMargin: 64 } }),
      /Invoice order strip must be an item of the definition's top-level content array/],
    ["inside a column of a measured row",
      () => onPage([{ ...row(SHORT), columns: [{ width: "auto", stack: [row(SHORT)] }, ...row(SHORT).columns.slice(1)] }]),
      /Invoice order strip must be an item of the definition's top-level content array/],
  ])("refuses a row %s, naming it", async (_what, def, refusal) => {
    await expect(renderPdf(def())).rejects.toThrow(refusal);
  });

  // 7. A width override the template validator accepts can indent the strip past the page's line,
  // leaving no width even for one field. The row is then handed back as the builder wrote it, and
  // prints as it would with no id.
  it("prints a row that has no width left even for one field as it would print with no id", async () => {
    const indented = (id?: false) => onPage([row(SHORT, { id, margin: [580, 0, 0, 0] })]);
    const pdf = await renderPdf(indented());
    expect(textRunsWithY(pdf)).toEqual(textRunsWithY(await renderPdf(indented(false))));
  });

  // 8. A margin of two numbers is [sides, top and bottom]: 58 points each side, a line of 412 that
  // ends at 530. Read as a left margin alone, the line would be 470 and the star column would be
  // left too little for "Process: Austemper".
  it("reads a row margin written as two numbers as both sides", async () => {
    const values = [SHORT[0], LONG_PO, SHORT[2], SHORT[3]];
    const columns = columnsOf(await renderPdf(onPage([row(values, { margin: [58, 0] })])));
    expect(columns.flat().filter((r) => r.x >= 530)).toEqual([]);
    capsTheSecond(columns);
    capsAt(widthsOf(columns, 530), await othersAlone(values), 412);
  });

  // 9. The caller's definition is never changed, and a definition holding a measured row is laid out
  // from a JSON copy: ONE node object at two places of it is drawn at both (the rows above, under
  // `continuationHeaderSpec.overflowTopMargin` and `ticket-totals`, hold a definition that holds no
  // such row, which is laid out as it came).
  it("leaves the caller's definition as it was, and lays out a JSON copy of it", async () => {
    const shared = { text: "TWICEPLACED" };
    const def = onPage([{ table: { widths: ["*", "*"], body: [[shared, shared]] } }, row([SHORT[0], LONG_PO, SHORT[2], PROCESS])]);
    const before = JSON.parse(JSON.stringify(def)) as RenderableDefinition;
    const pdf = await renderPdf(def);
    expect(def).toEqual(before);
    const runs = textRunsWithY(pdf)[0].filter((r) => r.text.trim() === "TWICEPLACED");
    // Page one is 612 points wide, and the two columns share it.
    expect(runs.map((r) => (r.x < 306 ? "left half" : "right half")).sort()).toEqual(["left half", "right half"]);
  });

  // 10. The two-pass render lays out the fitted row in both its passes.
  it("fits the row on the two-pass path too", async () => {
    const def = onPage([row([...SHORT.slice(0, 3), PROCESS]), { text: "later body", pageBreak: "before" }], {
      continuationHeaderSpec: { content: { text: "CONTINUED-MARKER-ALPHA", fontSize: 8 }, overflowTopMargin: 64 },
    });
    const pdf = await renderPdf(def);
    // A header on page two is the second pass's.
    expect(drawnPages(pdf).map((page) => page.includes("CONTINUED-MARKER-ALPHA"))).toEqual([false, true]);
    const fitted = columnsOf(pdf);
    expect(fitted.map((column) => column[0].y)).toEqual(fitted.map(() => fitted[0][0].y));
    expect(fitted.slice(0, 3).map(baselines)).toEqual([1, 1, 1]);
    expect(baselines(fitted[3])).toBeGreaterThanOrEqual(2);
  });

  // 11. The owner's amendment of 2026-10-21: where a field's share would be under 60 points, the row
  // prints as a stack, one field to a line under the row's own indent, each as wide as the line and
  // wrapping by word, in the row's order. The four short fields are each wider than 61 points, so
  // their share is a quarter of the line: 59 points on a line of 236 (a row margin of 292). A row with
  // no width left between its gaps stacks too: at 5 points, under a row margin of 530, the stack is 34
  // points wide and the three gaps take 36. The stack starts each field at the row's indent, each on
  // a lower baseline than the one before, and prints as a stack of the fields written by hand.
  it.each<[what: string, left: number, style: object]>([
    ["a share of 59 points", 292, NINE],
    ["no width left between its gaps, at 5 points", 530, { fontSize: 5 }],
  ])("prints a row with %s as a stack: each field on its own line under the row's indent, in order", async (_what, left, style) => {
    const measured = row(SHORT, { margin: [left, 0, 0, 0], style });
    const pdf = await renderPdf(onPage([measured]));
    const labels = columnsOf(pdf).map((column) => column[0]);
    expect(labels.map((r) => r.x)).toEqual(labels.map(() => 24 + left));
    expect(labels.every((r, i) => i === 0 || r.y < labels[i - 1].y), "each label below the one before").toBe(true);
    expect(textRunsWithY(pdf)[0].filter((r) => r.x >= 588)).toEqual([]);
    const byHand = { stack: measured.columns.map((column) => {
      const field: Record<string, unknown> = { ...column };
      delete field.width;
      return field;
    }), margin: measured.margin };
    expect(textRunsWithY(pdf)).toEqual(textRunsWithY(await renderPdf(onPage([byHand]))));
  });

  // A share of 60 points or more keeps the row on one line, each field held to its share and wrapping
  // inside it: a quarter of a line of 240 (a row margin of 288) and of 244 (284).
  it.each([[60, 288], [61, 284]])("keeps a row with a share of %s points on one line", async (share, left) => {
    const columns = columnsOf(await renderPdf(onPage([row(SHORT, { margin: [left, 0, 0, 0] })])));
    expect(columns.map((column) => column[0].y)).toEqual(columns.map(() => columns[0][0].y));
    const widths = widthsOf(columns);
    for (const i of [0, 1, 2]) expect(widths[i], `column ${i + 1}`).toBeCloseTo(share, 1);
    expect(columns.flat().filter((r) => r.x >= 588)).toEqual([]);
  });

  // 12. A right-aligned star column keeps its "*": it takes what the others leave, so its text ends at
  // the line's end (588) and starts its own width before it, measured alone.
  it("leaves a star column to take what is left: a right-aligned one ends at the line's end", async () => {
    const measured = row(SHORT);
    measured.columns[3] = { ...measured.columns[3], alignment: "right" } as typeof measured.columns[3];
    const columns = columnsOf(await renderPdf(onPage([measured])));
    expect(columns[3][0].x).toBeCloseTo(588 - await naturalAlone(3, SHORT[3]), 1);
  });

  // 13. Each measured row is fitted by its own measures. A first row of three fields under other labels,
  // then case 2's row of four: the second is fitted as case 2 is.
  it("fits two measured rows each by its own columns, the first with fewer", async () => {
    const values = [SHORT[0], LONG_PO, SHORT[2], SHORT[3]];
    const first = { id: ID, columnGap: GAP, margin: [58, 0, 0, 0],
      columns: ["Alpha:", "Beta:", "Gamma:"].map((label) => ({ width: "auto", text: [{ text: `${label} `, bold: true }, "one"], ...NINE })) };
    const columns = columnsOf(await renderPdf(onPage([first, row(values)])));
    expect(columns.flat().filter((r) => r.x >= 588)).toEqual([]);
    capsTheSecond(columns);
    capsAt(widthsOf(columns), await othersAlone(values), 470);
  });

  // 14. Case 2 again, each column under a named style: the measure is taken in the definition's styles
  // as case 5's is in its default style. Measured without them (pdfmake's Roboto 12), all three short
  // fields would seem to fit.
  it("measures in the definition's named styles", async () => {
    const strip = { styles: { strip: { font: "Roboto Mono", fontSize: 11 } } };
    const values = [SHORT[0], LONG_PO, SHORT[2], SHORT[3]];
    const columns = columnsOf(await renderPdf(onPage([row(values, { style: { style: "strip" } })], strip)));
    expect([baselines(columns[0]), baselines(columns[3])]).toEqual([1, 1]);
    expect(columns.flat().filter((r) => r.x >= 588)).toEqual([]);
    const widths = widthsOf(columns);
    const [order, process] = [await naturalAlone(0, values[0], strip, { style: "strip" }),
      await naturalAlone(3, values[3], strip, { style: "strip" })];
    expect(widths[0]).toBeCloseTo(order, 1);
    expect(widths[3]).toBeCloseTo(process, 1);
    expect(widths[1]).toBeCloseTo((470 - order - process) / 2, 1);
    expect(widths[2]).toBeCloseTo((470 - order - process) / 2, 1);
  });

  // 15. Case 2 again on a page size given as an object of LETTER's own width and height.
  it("reads a page size given as an object by its width", async () => {
    const values = [SHORT[0], LONG_PO, SHORT[2], SHORT[3]];
    const columns = columnsOf(await renderPdf(onPage([row(values)], { pageSize: { width: 612, height: 792 } })));
    expect(columns.flat().filter((r) => r.x >= 588)).toEqual([]);
    capsTheSecond(columns);
    capsAt(widthsOf(columns), await othersAlone(values), 470);
  });

  // 16. A row with no gap of its own takes the definition's default style's, as pdfmake does: case 2's
  // row without its `columnGap`, under a default style of a 12-point gap, prints as case 2 does.
  it("reads the default style's gap for a row with none of its own", async () => {
    const values = [SHORT[0], LONG_PO, SHORT[2], SHORT[3]];
    const gapless: Partial<ReturnType<typeof row>> = row(values);
    delete gapless.columnGap;
    const pdf = await renderPdf(onPage([gapless], { defaultStyle: { columnGap: GAP } }));
    expect(textRunsWithY(pdf)).toEqual(textRunsWithY(await renderPdf(onPage([row(values)]))));
  });

  // 17. Only the ids MEASURED_ROWS names are measured, not a name every object answers to: a row under
  // the id "toString" prints as it would with no id.
  it("leaves a row under the id \"toString\" as pdfmake prints it", async () => {
    const values = [...SHORT.slice(0, 3), PROCESS];
    const pdf = await renderPdf(onPage([{ ...row(values, { id: false }), id: "toString" }]));
    expect(textRunsWithY(pdf)).toEqual(textRunsWithY(await renderPdf(onPage([row(values, { id: false })]))));
  });

  // 18. A canvas prints the strip inside its block (the invoice canvas design of 2026-11-10, §4.6
  // and §5.2), in the one canvas block shape (#969): the block's id on a wrapper at [0, 0, 0, 0], one
  // zero-gap `columns` node inside it carrying the lateral margin, its one column holding the
  // document's node. The strip is an item of that node's stack, a plain `{ stack, margin }`, and is
  // measured on the line the block leaves: the page's width less its side margins, the columns
  // node's and the row's own. The old margined wrapper (the id and the lateral margin on one stack)
  // went with #969, and a row in one is refused.
  describe("inside a canvas block's inner stack", () => {
    type Parts = { id?: string; wrapper?: object; group?: object; column?: object; inner?: object; innerNode?: object };
    /** The block built by hand (`blockAt`'s shape, pinned below), its strip in the inner stack, with
     *  `parts` added at each level. */
    const block = (items: unknown[], left: number, right: number, parts: Parts = {}) => ({
      id: parts.id ?? CANVAS_IDS.table("order_strip"), margin: [0, 0, 0, 0], ...parts.wrapper,
      stack: [{
        columns: [{
          width: 564 - (left + right),
          stack: [parts.innerNode ?? { stack: items, margin: [0, 0, 0, 0], ...parts.inner }],
          ...parts.column,
        }],
        columnGap: 0, margin: [left, 0, right, 0], ...parts.group,
      }],
    });
    /** The block at drawn x and width w on the LETTER page's 24-point margins, as `drawnBlock` places it. */
    const drawn = (items: unknown[], x: number, w: number, parts: Parts = {}) => block(items, x - 24, 588 - x - w, parts);
    /** Every run of every page, each x and y within 0.01 of the other's. */
    const sameRuns = (a: Buffer, b: Buffer): void => {
      const [ra, rb] = [textRunsWithY(a), textRunsWithY(b)];
      expect(ra.map((page) => page.map((r) => r.text))).toEqual(rb.map((page) => page.map((r) => r.text)));
      ra.forEach((page, p) => page.forEach((r, i) => {
        expect(Math.abs(r.x - rb[p][i].x), `page ${p + 1} run ${i} x`).toBeLessThan(0.01);
        expect(Math.abs(r.y - rb[p][i].y), `page ${p + 1} run ${i} y`).toBeLessThan(0.01);
      }));
    };
    const REFUSAL = /Invoice order strip must be an item of the definition's top-level content array, or an item of a canvas block's inner stack/;

    it("is blockAt's shape", () => {
      expect(block([row(SHORT)], 0, 264)).toEqual(
        blockAt(CANVAS_IDS.table("order_strip"), { stack: [row(SHORT)], margin: [0, 0, 0, 0] }, 0, 264, 300));
    });

    it.each<[what: string, values: string[]]>([
      ["four short fields", SHORT],
      ["a 200-character PO that shares what the others leave", [SHORT[0], LONG_PO, SHORT[2], SHORT[3]]],
    ])("at x 24, w 564 measures, shares and fits a row of %s exactly as the same row top-level", async (_what, values) => {
      const pdf = await renderPdf(onPage([drawn([row(values)], 24, 564)]));
      const columns = columnsOf(pdf);
      expect(columns.map((column) => column[0].y)).toEqual(columns.map(() => columns[0][0].y));
      sameRuns(pdf, await renderPdf(onPage([row(values)])));
    });

    // At 564 the line is 564 − 58 − 3 × 12 = 470, and the four short fields share it on one line. At the
    // block's 300 (x 24, right 264) it is 300 − 58 − 36 = 206, a share of 51.5, under MEASURED_ROW_FLOOR:
    // the row stacks, each field at the row's indent, each below the one before.
    it("a measured row inside a canvas block's inner stack fits at its block's drawn width", async () => {
      const full = columnsOf(await renderPdf(onPage([block([row(SHORT)], 0, 0)])));
      expect(full.map((column) => column[0].y), "the premise: one line at 564").toEqual(full.map(() => full[0][0].y));
      const measured = row(SHORT);
      const pdf = await renderPdf(onPage([block([measured], 0, 264)]));
      const labels = columnsOf(pdf).map((column) => column[0]);
      expect(labels.map((r) => r.x)).toEqual(labels.map(() => 24 + 58));
      expect(labels.every((r, i) => i === 0 || r.y < labels[i - 1].y), "each label below the one before").toBe(true);
      const byHand = { stack: measured.columns.map((column) => {
        const field: Record<string, unknown> = { ...column };
        delete field.width;
        return field;
      }), margin: measured.margin };
      expect(textRunsWithY(pdf)).toEqual(textRunsWithY(await renderPdf(onPage([block([byHand], 0, 264)]))));
    });

    // A line of 450 − 58 − 3 × 12 = 356: the three short fields (about 239 points) keep their own
    // widths, and Process wraps within the 117 or so they leave, every run before the block's right
    // edge, 550. Every column is auto, as the invoice's strip is (#590's plan amendment 3): a star
    // Process would take what is left whatever share the line gave it. Drawn in from both sides, so
    // the block's left is read as well as its right.
    it("at x 100, w 450 shares the narrower line: the short fields at their own widths on one line, Process wrapped within what is left", async () => {
      const values = [...SHORT.slice(0, 3), PROCESS];
      const pdf = await renderPdf(onPage([drawn([row(values, { widths: ["auto", "auto", "auto", "auto"] })], 100, 450)]));
      const columns = columnsOf(pdf);
      const first = columns[0][0].y;
      for (const i of [0, 1, 2]) expect(columns[i].map((r) => r.y), `column ${i + 1} on one line`).toEqual(columns[i].map(() => first));
      expect(columns[0][0].x).toBeCloseTo(100 + 58, 2);
      expect(columns[3][0].y).toBe(first);
      expect(baselines(columns[3])).toBeGreaterThanOrEqual(2);
      const widths = widthsOf(columns, 550);
      for (const i of [0, 1, 2]) expect(widths[i], `column ${i + 1}`).toBeCloseTo(await naturalAlone(i, SHORT[i]), 1);
      expect(textRunsWithY(pdf)[0].filter((r) => r.x >= 550)).toEqual([]);
    });

    // A line of 200 − 58 − 36 = 106 under a Quantity column of 52 (the row's indent, 52 + 6): a share
    // of 26.5, under MEASURED_ROW_FLOOR, so the row stacks, each field at the row's indent from the
    // block's left (100 + 58), each below the one before, as the fields stacked by hand print.
    it("at w 200 under a Quantity of 52 (a share under 60) stacks one field to a line under the row's indent from the block's left", async () => {
      const measured = row(SHORT, { margin: [52 + 6, 0, 0, 0] });
      const pdf = await renderPdf(onPage([drawn([measured], 100, 200)]));
      const labels = columnsOf(pdf).map((column) => column[0]);
      expect(labels.map((r) => r.x)).toEqual(labels.map(() => 100 + 58));
      expect(labels.every((r, i) => i === 0 || r.y < labels[i - 1].y), "each label below the one before").toBe(true);
      const byHand = { stack: measured.columns.map((column) => {
        const field: Record<string, unknown> = { ...column };
        delete field.width;
        return field;
      }), margin: measured.margin };
      expect(textRunsWithY(pdf)).toEqual(textRunsWithY(await renderPdf(onPage([drawn([byHand], 100, 200)]))));
    });

    it("hands back a row with no width left inside the block as written: it renders as it would with no id", async () => {
      const values = [...SHORT.slice(0, 3), PROCESS];
      const pdf = await renderPdf(onPage([drawn([row(values)], 100, 50)]));
      expect(textRunsWithY(pdf)).toEqual(textRunsWithY(await renderPdf(onPage([drawn([row(values, { id: false })], 100, 50)]))));
    });

    // The `ticket-totals` TWICEPLACED cases' shape: a definition holding no measured row is laid out
    // from the caller's own nodes, where pdfmake translates a canvas node's vectors in place as it lays
    // it out, so ONE canvas-line object at two places strokes unlike its JSON copy's two. Canvas
    // blocks holding no measured row are no reason to copy. Green on arrival; red under M3, the scan
    // that copies every definition with a block in it.
    it("lays out a canvas definition whose blocks hold no measured row from its own nodes: a line placed twice strokes as it does with the ids taken off", async () => {
      const def = (ids: boolean) => {
        const line = { canvas: [{ type: "line", x1: 0, y1: 0, x2: 100, y2: 0, lineWidth: 0.5 }] };
        const blocks: Record<string, unknown>[] = [
          drawn([line, { text: "PARTS" }, line], 100, 450, { id: CANVAS_IDS.table("parts") }),
          drawn([{ text: "PRICES" }], 24, 564, { id: CANVAS_IDS.table("prices") }),
        ];
        if (!ids) for (const b of blocks) delete b.id;
        return onPage(blocks);
      };
      const pdf = await renderPdf(def(true));
      expect(strokedLines(pdf)).toEqual(strokedLines(await renderPdf(def(false))));
      expect(strokedLines(pdf)).not.toEqual(strokedLines(await renderPdf(JSON.parse(JSON.stringify(def(true))) as RenderableDefinition)));
    });

    // Each slot case places a block that top-level content accepts (the cases above), so it is
    // refused for where it stands, never for its shape.
    const accepted = () => block([row(SHORT)], 0, 0) as unknown as Content;
    const extras: [string, object][] = [["a fontSize", { fontSize: 9 }], ["a style", { style: "strip" }], ["an unbreakable mark", { unbreakable: true }]];
    it.each<[what: string, def: () => RenderableDefinition]>([
      ["one level deeper in the inner stack", () => onPage([block([{ stack: [row(SHORT)] }], 0, 0)])],
      ["inside an unbreakable region", () => onPage([{ unbreakable: true, stack: [row(SHORT)] }])],
      ["inside an unbreakable region in the inner stack", () => onPage([block([{ unbreakable: true, stack: [row(SHORT)] }], 0, 0)])],
      ["in a block in a header", () => onPage([], { header: accepted() })],
      ["in a block in a footer's above slot", () => onPage([], { pageFooterSpec: { kind: "pageNofM", above: accepted() } })],
      ["in a block in the continuation header",
        () => onPage([], { continuationHeaderSpec: { content: accepted(), overflowTopMargin: 64 } })],
      ["in a block in the page-bottom band", () => onPage([], { pageBottomBandSpec: { height: 40, content: [accepted()], repeated: [] } })],
      ["in a block in the band's repeated items", () => onPage([], { pageBottomBandSpec: { height: 40, content: [], repeated: [accepted()] } })],
      ["in a block whose inner node is a columns node",
        () => onPage([block([], 0, 0, { innerNode: { columns: [{ width: "*", stack: [row(SHORT)] }] } })])],
      ...(["wrapper", "group", "column", "inner"] as const).flatMap((level) => extras.map(([what, extra]):
        [string, () => RenderableDefinition] => [`in a block whose ${level} carries ${what}`,
        () => onPage([block([row(SHORT)], 0, 0, { [level]: extra })], { styles: { strip: { fontSize: 9 } } })])),
      ["in a block whose wrapper carries a columnGap of 12", () => onPage([block([row(SHORT)], 0, 0, { wrapper: { columnGap: 12 } })])],
      ["in a block whose columns node carries a columnGap of 12", () => onPage([block([row(SHORT)], 0, 0, { group: { columnGap: 12 } })])],
      ["in a block whose wrapper has no margin key", () => {
        const bare: Record<string, unknown> = block([row(SHORT)], 0, 0);
        delete bare.margin;
        return onPage([bare]);
      }],
      ["in a block under a canvas item's id", () => onPage([block([row(SHORT)], 0, 0, { id: CANVAS_IDS.item("strip") })])],
      ["in a block under a canvas end mark's id", () => onPage([block([row(SHORT)], 0, 0, { id: CANVAS_IDS.end("order_strip") })])],
      ["in a block under the table key alone", () => onPage([block([row(SHORT)], 0, 0, { id: "order_strip" })])],
      // The shape #969 retired: the table's id and its lateral margin on one plain stack.
      ["in the old margined wrapper", () => onPage([{ id: CANVAS_IDS.table("order_strip"), stack: [row(SHORT)], margin: [76, 0, 38, 0] }])],
    ])("refuses a row %s, naming it", async (_what, def) => {
      await expect(renderPdf(def())).rejects.toThrow(REFUSAL);
    });

    it("builds CANVAS_IDS.table from the one prefix canvas-nodes.ts exports, which render.ts reads too", () => {
      expect(CANVAS_IDS.table("parts").startsWith(CANVAS_TABLE_ID_PREFIX)).toBe(true);
      expect(CANVAS_IDS.table("parts")).toBe(`${CANVAS_TABLE_ID_PREFIX}parts`);
      const source = (file: string) => readFileSync(path.join(__dirname, "../src/server/pdf", file), "utf8");
      for (const file of ["canvas-sheet.ts", "render.ts"]) {
        expect(source(file), file).toMatch(/import \{[^}]*\bCANVAS_TABLE_ID_PREFIX\b[^}]*\} from "\.\/canvas-nodes";/);
        expect(source(file), file).not.toContain("canvas:table:");
      }
    });
  });
});

// ------------------------------------------------------------------------------------------------
// Per-sheet-group rendering + merge (spec §6.1 — the pdf-lib seam, #36's mechanism)
// ------------------------------------------------------------------------------------------------

describe("renderSheetGroups — each group renders alone, the PDFs merge into one document", () => {
  /** A three-page sibling of twoPageDef — digit-free body text, one node per page. */
  const threePageDef = (extra: Partial<RenderableDefinition> = {}): RenderableDefinition => ({
    content: [
      { text: "gamma body", pageBreak: "after" },
      { text: "delta body", pageBreak: "after" },
      { text: "epsilon body" },
    ],
    ...extra,
  });

  it("2-page + 3-page groups merge to /Count 5, and each group's footer restarts at ITS OWN 'Page 1 of N'", async () => {
    const merged = await renderSheetGroups([
      twoPageDef({ pageFooterSpec: { kind: "pageNofM" } }),
      threePageDef({ pageFooterSpec: { kind: "pageNofM" } }),
    ]);
    expect(merged.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pageCount(merged)).toBe(5); // the uncompressed marker survives useObjectStreams: false

    const pages = drawnPages(merged);
    expect(pages).toHaveLength(5);
    // Group one numbers its own two pages…
    expect(pages[0]).toContain("Page 1 of 2");
    expect(pages[1]).toContain("Page 2 of 2");
    // …group two restarts at 1 and counts to ITS three…
    expect(pages[2]).toContain("Page 1 of 3");
    expect(pages[3]).toContain("Page 2 of 3");
    expect(pages[4]).toContain("Page 3 of 3");
    // …and nothing ever numbers against the merged document's five (per-group, not per-document).
    expect(drawnText(merged)).not.toContain("of 5");
  });

  it("each group's continuation header stays scoped to its own pages", async () => {
    const merged = await renderSheetGroups([
      twoPageDef({ continuationHeaderSpec: { content: { text: "CONTINUED-MARKER-ALPHA" } } }),
      threePageDef({ continuationHeaderSpec: { content: { text: "CONTINUED-MARKER-BETA" } } }),
    ]);
    const pages = drawnPages(merged);
    expect(pages).toHaveLength(5);
    // Each group's FIRST page is bare — page three of the merged document is a first page again.
    expect(pages[0]).not.toContain("CONTINUED-MARKER");
    expect(pages[1]).toContain("CONTINUED-MARKER-ALPHA");
    expect(pages[2]).not.toContain("CONTINUED-MARKER");
    expect(pages[3]).toContain("CONTINUED-MARKER-BETA");
    expect(pages[4]).toContain("CONTINUED-MARKER-BETA");
  });

  it("a single group still comes out whole (its own count, its own numbering)", async () => {
    const merged = await renderSheetGroups([twoPageDef({ pageFooterSpec: { kind: "pageNofM" } })]);
    expect(pageCount(merged)).toBe(2);
    expect(drawnText(merged)).toContain("Page 2 of 2");
  });

  it("an empty group list is refused loudly — a zero-page PDF is never produced", async () => {
    await expect(renderSheetGroups([])).rejects.toThrow(/at least one/);
  });
});

// ------------------------------------------------------------------------------------------------
// Purity — the new keys are data (the template-as-data contract, spec §10)
// ------------------------------------------------------------------------------------------------

describe("purity — definitions carrying the spec keys stay plain JSON", () => {
  it("both keys survive JSON.parse(JSON.stringify(...)) and render identically after the round trip", async () => {
    const def = twoPageDef({
      pageFooterSpec: { kind: "pageNofM", label: "Sheet" },
      continuationHeaderSpec: { content: { text: "CONTINUED-MARKER-ALPHA", fontSize: 8 } },
    });
    const roundTripped = JSON.parse(JSON.stringify(def)) as RenderableDefinition;
    expect(roundTripped).toEqual(def); // nothing was a function; nothing was lost

    const a = await renderPdf(def);
    const b = await renderPdf(roundTripped);
    // Identical CONTENT, never Buffer.compare between fresh renders (CLAUDE.md).
    expect(pageCount(a)).toBe(pageCount(b));
    expect(drawnText(a)).toBe(drawnText(b));
    expect(drawnText(a)).toContain("Sheet 1 of 2");
  });
});

// ------------------------------------------------------------------------------------------------
// The unregistered-font belt (spec §6.2 — the contracts refuse at validation; this is render-side)
// ------------------------------------------------------------------------------------------------

// ------------------------------------------------------------------------------------------------
// JPEG embedding (spec §6.3 — the logo path's second mime type)
// ------------------------------------------------------------------------------------------------


describe("jpegDataUri — the pngDataUri sibling", () => {
  it("produces a data URI pdfmake accepts — the render succeeds", async () => {
    const uri = jpegDataUri(TINY_JPEG);
    expect(uri.startsWith("data:image/jpeg;base64,")).toBe(true);
    const pdf = await renderPdf({ content: [{ image: uri, width: 20 }] });
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pageCount(pdf)).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------
// The four-family font map (spec §6.2, owner ruling 5)
// ------------------------------------------------------------------------------------------------

describe("the contract-enumerated font families all render", () => {
  it.each(["Roboto", "Liberation Sans", "Liberation Serif", "Roboto Mono"])(
    "'%s' renders in all four styles and the drawn text reads back", async (family) => {
      const pdf = await renderPdf({
        defaultStyle: { font: family },
        content: [
          { text: `body set in ${family}` },
          { text: "bold run", bold: true },
          { text: "italic run", italics: true },
          { text: "bold italic run", bold: true, italics: true },
        ],
      });
      expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      const text = drawnText(pdf);
      expect(text).toContain(`body set in ${family}`);
      expect(text).toContain("bold run");
      expect(text).toContain("italic run");
      expect(text).toContain("bold italic run");
    });
});

describe("unregistered font families fail the render loudly", () => {
  it("defaultStyle naming an unregistered family throws naming it and the registered set", async () => {
    await expect(renderPdf({
      defaultStyle: { font: "Comic Sans" }, content: [{ text: "x" }],
    })).rejects.toThrow(/Font family "Comic Sans" is not registered/);
  });

  it("an inline node's font is caught too — never a silent fallback", async () => {
    await expect(renderPdf({
      content: [{ text: "x", font: "Papyrus" }],
    })).rejects.toThrow(/Font family "Papyrus" is not registered/);
  });
});

describe("a canvas line drawn from a negative x (design 2026-11-10 §5.2)", () => {
  /** The one stroke a definition's single page draws: its two ends' x, in points. The invoice's
   *  canvas price block draws its rule from a negative x inside its indented wrapper, back to the
   *  page's margin, so the rule must stroke there, neither clipped to the wrapper nor moved to 0. */
  const strokeOf = async (node: Content) => {
    const pdf = await renderPdf({ pageSize: "LETTER", pageMargins: [24, 24, 24, 24], content: [node] });
    const pages = strokedLines(pdf);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toHaveLength(1);
    const [s] = pages[0];
    return [Math.min(s.x1, s.x2), Math.max(s.x1, s.x2)];
  };

  // (pin) Both cases hold pdfmake's own behaviour, which the canvas price rule leans on; no mutation
  // of this repo's code reds them, only a pdfmake that clips or moves such a line.
  it("a line from -100 inside a wrapper indented 100 strokes from the page's margin (24) to 588 (pin)", async () => {
    const [left, right] = await strokeOf({
      stack: [{ canvas: [{ type: "line", x1: -100, y1: 0, x2: 464, y2: 0, lineWidth: 0.5 }] }],
      margin: [100, 0, 0, 0],
    });
    expect(left).toBeCloseTo(24, 2);
    expect(right).toBeCloseTo(588, 2);
  });

  it("a line past both edges of its wrapper (-96 to 468 in 300 pt) strokes from 24 to 588 (pin)", async () => {
    const [left, right] = await strokeOf({
      stack: [{ canvas: [{ type: "line", x1: -96, y1: 0, x2: 468, y2: 0, lineWidth: 0.5 }] }],
      margin: [96, 0, 168, 0],
    });
    expect(left).toBeCloseTo(24, 2);
    expect(right).toBeCloseTo(588, 2);
  });
});
