import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { clampedFlowTables, renderSheetGroups, type RenderableDefinition } from "@/server/pdf/render";
import { FLOW_TABLE_MARK, flowTableMarkOf, markFlowTable } from "@/server/pdf/canvas-nodes";
import { flowTableSections } from "@/server/pdf/flow-tables";
import { defaultConfigFor, validateConfig, type TemplateConfig } from "@/lib/template-contracts/index";
import { DOCS, TEXT_TOLERANCE, outOfBox, ticketRecord, travelerRecord } from "./helpers/keep-in-box-cases";
import { canonical, definitionsOf, rectsPerPage, runsPerPage, type PaperDoc, type PaperDump } from "./helpers/canvas-paper-dump";
import { drawnText, pageCount, paintedImages, strokedLines } from "./helpers/pdf";
import { sampleBol } from "./helpers/bol-canvas-fixtures";
import { sampleCert } from "./helpers/cert-canvas-fixtures";
import { sampleInvoice } from "./helpers/invoice-canvas-fixtures";
import { richStatement } from "./helpers/statement-canvas-fixtures";
import { sampleQuote } from "./helpers/quote-canvas-fixtures";

/**
 * #991 (owner ruling 2026-11-15; design docs/superpowers/specs/2026-11-17-991-flow-tables-in-box-design.md): a flow
 * document's table sections take #971's column clamp, so a table that printed past the page's right margin prints
 * inside it, and paper that fits prints the same ink.
 *
 * The comparator throughout: a flow definition as built carries the builder's marks (non-enumerable, design §4.1), and
 * its JSON copy carries none, so the copy prints exactly what the flow printed before #991. "Unmarked" below is that
 * copy: the red-before reading, taken in the same test.
 */

const DOC_TYPES: PaperDoc[] = ["TRAVELER", "SHIPPER", "MOS_SHIPPER", "BOL", "CERT", "INVOICE", "STATEMENT", "QUOTE"];

/** `doc`'s Standard config, edited and validated as a template stores it: a flow config. */
function flowConfig(doc: PaperDoc, edit: (c: TemplateConfig) => void = () => {}): TemplateConfig {
  const raw = structuredClone(defaultConfigFor(doc));
  edit(raw);
  const config = validateConfig(doc, raw);
  expect(config.layout, "a flow config").toBeNull();
  return config;
}
const field = (c: TemplateConfig, section: string, key: string) =>
  c.sections.find((s) => s.key === section)!.fields.find((f) => f.key === key)!;

const flowDefs = (doc: PaperDoc, config: TemplateConfig, data: unknown): RenderableDefinition[] =>
  definitionsOf({ name: "flow", doc, config, data, premise: { kind: "full" } });
const unmarked = (defs: RenderableDefinition[]) => JSON.parse(JSON.stringify(defs)) as RenderableDefinition[];
/** The definitions themselves with every mark deleted in place: the very objects the flow handed pdfmake
 *  before #991, uncopied (a JSON copy would print twice a node object a builder placed twice). */
function stripped(defs: RenderableDefinition[]): RenderableDefinition[] {
  const walk = (node: unknown) => {
    if (node === null || typeof node !== "object") return;
    delete (node as { [FLOW_TABLE_MARK]?: unknown })[FLOW_TABLE_MARK];
    Object.values(node).forEach(walk);
  };
  defs.forEach((d) => walk(d.content));
  return defs;
}

/** The flow's ink, in the paper dump's shape (no positions or measure: a flow has none). */
async function dumpOf(defs: RenderableDefinition[]): Promise<PaperDump> {
  const pdf = await renderSheetGroups(defs);
  const runs = runsPerPage(pdf), strokes = strokedLines(pdf), rects = rectsPerPage(pdf), images = paintedImages(pdf);
  return {
    pages: pageCount(pdf),
    perPage: runs.map((pageRuns, p) => ({ runs: pageRuns, strokes: strokes[p], rects: rects[p], images: images[p] })),
    positions: [],
    measure: {} as PaperDump["measure"],
  };
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** Each page's runs, strokes, rects and images, sorted, as the canvas oracle digests them. */
const inkOf = (dump: PaperDump) => ({
  pages: dump.pages,
  perPage: dump.perPage.map((page) => sha(canonical({
    runs: page.runs.map(canonical).sort(), strokes: page.strokes.map(canonical).sort(),
    rects: page.rects.map(canonical).sort(), images: page.images.map(canonical).sort(),
  }))),
});
/** What prints past the page's right margin, 588: a stroke by more than floating-point noise, a run by more
 *  than `TEXT_TOLERANCE` (its end is read with `textWidthOf`, which carries no ASCII kerning allowance: a
 *  sidebar word that ends at the margin reads 0.05 past it). */
const pastMargin = (dump: PaperDump) => outOfBox(dump, 24, 564, undefined, { stroke: 0.001, text: TEXT_TOLERANCE }).past;

const LONG = "W".repeat(60);

/** One flow table per document that can overrun, with the section the clamp must name. */
const OVERRUNS: { name: string; doc: PaperDoc; section: string; config: () => TemplateConfig; data: () => unknown }[] = [
  {
    name: "the traveler's quantities, Order Qty typed 168 wide", doc: "TRAVELER", section: "quantities",
    config: () => flowConfig("TRAVELER", (c) => { field(c, "quantities", "order_qty").width = 168; }),
    data: () => travelerRecord(),
  },
  {
    name: "the traveler's quantities, a 30-character unbroken container type", doc: "TRAVELER", section: "quantities",
    config: () => flowConfig("TRAVELER"), data: () => travelerRecord("WIREMESHBASKETEXTRAHEAVYDUTY30"),
  },
  {
    name: "the shipping ticket's folded containers at a 12 pt base", doc: "SHIPPER", section: "containers",
    config: () => flowConfig("SHIPPER", (c) => { c.fonts.baseSize = 12; }), data: ticketRecord,
  },
  {
    name: "the MOS ticket's folded containers at a 12 pt base", doc: "MOS_SHIPPER", section: "containers",
    config: () => flowConfig("MOS_SHIPPER", (c) => { c.fonts.baseSize = 12; }), data: ticketRecord,
  },
  {
    name: "the bill of lading's freight, an unbroken description", doc: "BOL", section: "freight",
    config: () => flowConfig("BOL"), data: () => sampleBol({ freightDescription: "X".repeat(70) }),
  },
  {
    name: "the certification's parts, an unbroken part number", doc: "CERT", section: "parts",
    config: () => flowConfig("CERT"),
    data: () => sampleCert({ parts: [{ ...sampleCert().parts[0], partNumber: LONG, partName: LONG }] }),
  },
  {
    name: "the invoice's part rows, an unbroken part number", doc: "INVOICE", section: "parts",
    config: () => flowConfig("INVOICE"),
    data: () => sampleInvoice({ parts: [{ ...sampleInvoice().parts[0], partNumber: "W".repeat(60) }] }),
  },
  {
    name: "the quote's lines, an unbroken part number", doc: "QUOTE", section: "lines",
    config: () => flowConfig("QUOTE"),
    data: () => sampleQuote({ lines: [{ ...sampleQuote().lines[0], partNumber: "W".repeat(60) }] }),
  },
  {
    name: "the statement's open items, an unbroken document number", doc: "STATEMENT", section: "open_items",
    config: () => flowConfig("STATEMENT"),
    data: () => richStatement({ openItems: [{ ...richStatement().openItems[0], documentNumber: "9".repeat(120) }] }),
  },
];

describe("a flow table that printed past the right margin prints inside it (#991)", () => {
  for (const c of OVERRUNS) {
    it(c.name, async () => {
      const defs = flowDefs(c.doc, c.config(), c.data());
      // Red before: the builder's own nodes with the marks deleted print as the flow printed before #991, past the margin.
      expect(pastMargin(await dumpOf(stripped(flowDefs(c.doc, c.config(), c.data())))), "unmarked").not.toEqual([]);
      const dump = await dumpOf(defs);
      expect(pastMargin(dump), "the flow as built").toEqual([]);
      expect((await clampedFlowTables(defs)).moved).toContain(c.section);
    }, 60_000);
  }
});

describe("flow paper that fits prints the same ink (#991)", () => {
  for (const doc of DOC_TYPES) {
    for (const baseSize of [8, 9, 10, 11]) {
      it(`${doc} at its Standard config, base ${baseSize}, on the one-page record`, async () => {
        const build = () => flowDefs(doc, flowConfig(doc, (c) => { c.fonts.baseSize = baseSize; }), DOCS[doc].record());
        const defs = build();
        const ink = inkOf(await dumpOf(defs));
        expect(ink, "against the unmarked JSON copy").toEqual(inkOf(await dumpOf(unmarked(defs))));
        // Against the builder's own objects with the marks deleted in place: exactly what was rendered before #991.
        expect(ink, "against the builder's own nodes, unmarked").toEqual(inkOf(await dumpOf(stripped(build()))));
        expect(await clampedFlowTables(defs)).toEqual({ moved: [], overran: [] });
      }, 60_000);
    }
  }
});

/**
 * The floor rule (design §4.3): a row whose fixed parts alone pass its width prints as pdfmake lays it. Since owner
 * ruling R-B (2026-11-17) the contracts refuse every such flow config, so the rule is the renderer's belt for a config
 * that reaches it unvalidated: each case is the Standard config, validated, with its widths typed AFTER validation, and
 * first proves the contracts refuse the same widths.
 */
const PAST_BY_FIXED: { name: string; doc: PaperDoc; section: string; edit: (c: TemplateConfig) => void; data: () => unknown }[] = [
  {
    // 40 + 190 + 62 + 44 + 42 = 378 of the 386 beside the sidebar, and 44.8 of padding and rules on it.
    name: "the bill of lading's freight typed past the 386 pt beside its sidebar pushes the sidebar as before, never under it",
    doc: "BOL", section: "freight", edit: (c) => { field(c, "freight", "freight_description").width = 190; },
    data: () => sampleBol(),
  },
  {
    // The description flexible, the other columns typed to 360: the table's fixed parts are 404.8.
    name: "the bill of lading's freight with its fixed columns past 386 and its description flexible",
    doc: "BOL", section: "freight",
    edit: (c) => {
      for (const [key, width] of [["package_count", 100], ["freight_weight", 100], ["freight_class", 80], ["check_column", 80]] as const) {
        field(c, "freight", key).width = width;
      }
    },
    data: () => sampleBol({ freightDescription: "X".repeat(70) }),
  },
  {
    // 190 + 55 + 48 + 48 + 72 + 140 = 553, and 49.6 of padding and rules: past the box at 564.
    name: "the traveler's inspections typed past their box print as before, never out of it",
    doc: "TRAVELER", section: "inspections",
    edit: (c) => {
      field(c, "inspections", "inspection_code").width = 190;
      field(c, "inspections", "inspection_location").width = 140;
    },
    data: () => travelerRecord(),
  },
  {
    // 190 + 62 = 252 of the half's 282, and 32 of padding: 284, past the half with Containers and Tare
    // still flexible, where #971's arithmetic alone would set them to a glyph a line.
    name: "the ticket's containers typed past their half print as before",
    doc: "SHIPPER", section: "containers",
    edit: (c) => { field(c, "containers", "container_type").width = 190; },
    data: ticketRecord,
  },
];

describe("a flow table whose fixed parts pass its width is refused, and printed as before if it reaches the renderer (#991)", () => {
  for (const c of PAST_BY_FIXED) {
    it(c.name, async () => {
      // R-B: the contracts refuse it.
      expect(() => flowConfig(c.doc, c.edit)).toThrow(/needs .*pt on paper .* its fixed columns alone would print past the page/);
      // Past the validator (the belt): the Standard config, validated, typed afterwards.
      const config = () => {
        const valid = flowConfig(c.doc);
        c.edit(valid);
        return valid;
      };
      const defs = flowDefs(c.doc, config(), c.data());
      const before = await dumpOf(stripped(flowDefs(c.doc, config(), c.data())));
      // The premise: it printed past the margin before #991.
      expect(pastMargin(before)).not.toEqual([]);
      expect(inkOf(await dumpOf(defs))).toEqual(inkOf(before));
      expect(await clampedFlowTables(defs)).toEqual({ moved: [], overran: [c.section] });
    }, 60_000);
  }
});

describe("a measure takes the print's scope (#991, design §4.4)", () => {
  it("a ticket totals block whose typed label wraps taller than a page under the clamp flows over the pages, every letter printed", async () => {
    const label = "W".repeat(1400);
    const config = flowConfig("SHIPPER", (c) => { field(c, "totals", "total_weight").label = label; });
    const defs = flowDefs("SHIPPER", config, ticketRecord());
    expect((await clampedFlowTables(defs)).moved).toContain("totals");
    const pdf = await renderSheetGroups(defs);
    // Measured unclamped, the block is one line and keeps its mark; printed clamped it is taller than a
    // page, which pdfmake prints on no page: the label would be missing.
    expect((drawnText(pdf).match(/W/g) ?? []).length).toBeGreaterThanOrEqual(label.length);
    expect(pageCount(pdf)).toBeGreaterThan(1);
  }, 60_000);

  it("a kept-together block under a section's wrapper is measured in that section's scope (the measure's ancestor wrapper)", async () => {
    // The ticket's totals as a seed wraps a margined block: the section's mark on a stack, the kept block inside
    // it, which carries no key of its own, so only the walk's ancestor (`inScope`) puts its measure in scope.
    const label = "W".repeat(1400);
    const kept = {
      id: "ticket-totals", unbreakable: true,
      stack: [{ columns: [{ width: "*", text: "" }, { width: 260, table: { widths: ["*", 80], body: [[{ text: label, bold: true }, "1"]] }, layout: "noBorders" }] }],
    };
    /** A fresh definition: pdfmake decorates the nodes it lays out, so each render takes its own. */
    const def = (): RenderableDefinition => {
      const wrapper = { stack: [structuredClone(kept)], margin: [0, 0, 0, 6] };
      markFlowTable(wrapper, "totals");
      return { pageSize: "LETTER", pageMargins: [24, 24, 24, 24], content: [wrapper] } as unknown as RenderableDefinition;
    };
    expect((await clampedFlowTables([def()])).moved).toEqual(["totals"]);
    const pdf = await renderSheetGroups([def()]);
    // Measured unscoped, the block is one line and keeps its mark; printed clamped it is taller than a page, which
    // pdfmake prints on no page.
    expect((drawnText(pdf).match(/W/g) ?? []).length).toBeGreaterThanOrEqual(label.length);
  }, 60_000);

  // The flow steps measure (`oversizedRows`) takes its section's scope too, but no flow case shows it:
  // the instruction cell is `wordBreak: "break-all"`, so its least width is one glyph, and a share the
  // clamp gives under a glyph prints a glyph a line, as pdfmake's own does (ledger, 2026-11-17).
});

describe("the flow scope is the canvas profile's section-keyed tables (#991, design §4.1)", () => {
  it("names each type's sections from its canvas profile", () => {
    expect([...flowTableSections("TRAVELER")]).toEqual(["lines", "quantities", "inspections", "steps"]);
    expect([...flowTableSections("SHIPPER")]).toEqual(["field_strip", "lines", "containers", "serials", "totals"]);
    expect([...flowTableSections("MOS_SHIPPER")]).toEqual(["field_strip", "lines", "containers", "serials", "totals"]);
    expect([...flowTableSections("BOL")]).toEqual(["trv", "freight"]);
    expect([...flowTableSections("CERT")]).toEqual(["parts", "statement", "requirements", "serials", "freeform", "signature"]);
    expect([...flowTableSections("INVOICE")]).toEqual(["parties", "column_header", "order_strip", "parts", "price", "totals"]);
    expect([...flowTableSections("STATEMENT")]).toEqual(["open_items", "aging", "finance_charge", "total"]);
    expect([...flowTableSections("QUOTE")]).toEqual(["parties", "intro", "column_header", "lines", "closing", "liability"]);
    expect([...flowTableSections("CONTAINER_TAG")]).toEqual([]);
  });

  /** Every mark in the definitions' content, by section key, and whether any is below another. */
  function marksOf(defs: RenderableDefinition[]): string[] {
    const found: string[] = [];
    const walk = (node: unknown) => {
      if (node === null || typeof node !== "object") return;
      const key = flowTableMarkOf(node);
      if (key !== undefined) found.push(key);
      Object.values(node).forEach(walk);
    };
    defs.forEach((d) => walk(d.content));
    return found;
  }

  for (const doc of DOC_TYPES) {
    it(`${doc}: the flow marks exactly its table sections, and its canvas marks nothing`, () => {
      const flow = marksOf(flowDefs(doc, flowConfig(doc), DOCS[doc].record()));
      // Every table section the Standard flow prints on this record is marked, and nothing else: the record prints
      // each one (none is left empty).
      expect([...new Set(flow)].sort()).toEqual([...flowTableSections(doc)].sort());
      const canvas = definitionsOf({
        name: "canvas", doc, config: validateConfig(doc, { ...structuredClone(defaultConfigFor(doc)), layout: DOCS[doc].layout() }),
        data: DOCS[doc].record(), premise: { kind: "full" },
      });
      expect(marksOf(canvas)).toEqual([]);
    });
  }
});
