import { describe, it, expect } from "vitest";
import type { Content } from "pdfmake/interfaces";
import { buildQuoteDefinition, type QuotePdfData } from "@/server/pdf/quote";
import { LAYOUT, layOutSheetGroups, type RenderableDefinition } from "@/server/pdf/render";
import { mark } from "@/server/pdf/canvas-nodes";
import {
  FONT_FAMILIES, QUOTE_DEFAULT_CONFIG, validateConfig, type FontFamily, type TemplateConfig,
} from "@/lib/template-contracts/index";
import {
  QUOTE_CONTRACT, QUOTE_FIRST_TABLE_ROOM, QUOTE_ROW_FLOOR,
} from "@/lib/template-contracts/quote";
import { findNodes } from "./helpers/definition-text";
import { measured } from "./helpers/measured";
import { sampleQuote } from "./helpers/quote-canvas-fixtures";

// The quote canvas's floors (design 2026-11-12 §4.1, §5.2, §15), measured on the flow's own nodes
// (`buildQuoteDefinition`), the statement's method (tests/statement-canvas-floors.test.ts).
// Importing render.ts warms `practiceMode`'s cache (one `SELECT current_database()` at module load,
// practice-mode.ts), so that read runs whichever case runs. The case here is a pure layout
// (`layOutSheetGroups`) and needs no database of its own beyond that read.

/** Every label read from the contract, never retyped (the default config stores `label: null`). */
const label = (section: string, key: string): string =>
  QUOTE_CONTRACT.sections.find((s) => s.key === section)!.fields.find((f) => f.key === key)!.defaultLabel;

const inFamily = (family: FontFamily): TemplateConfig => {
  const c = structuredClone(QUOTE_DEFAULT_CONFIG);
  c.fonts.family = family;
  return validateConfig("QUOTE", c);
};

/** The flow's definition, built and cloned afresh (pdfmake uses up the nodes it lays out, so no
 *  node is ever placed twice: each measurement takes its own build). */
const build = (data: QuotePdfData, config: TemplateConfig): RenderableDefinition =>
  structuredClone(buildQuoteDefinition(data, config));

/** Lays out the probe's top-level list on the definition's page size, margins and default style,
 *  nothing else (no footer or continuation spec). Answers the top of an id'd mark, every mark a
 *  top-level node. */
async function probe(def: RenderableDefinition, content: Content[]): Promise<(id: string) => number> {
  const probeDef: RenderableDefinition = {
    pageSize: def.pageSize, pageMargins: def.pageMargins, defaultStyle: def.defaultStyle, content,
  };
  const [laid] = await layOutSheetGroups([probeDef]);
  return (id) => {
    const node = laid.find((n) => n.id === id);
    if (node === undefined) throw new Error(`the probe laid out no mark "${id}"`);
    expect(node.page).toBe(1);
    return node.top;
  };
}
const span = (top: (id: string) => number, key: string) => top(`${key}:b`) - top(`${key}:a`);

const one = (def: unknown, pred: (n: Record<string, unknown>) => boolean): Record<string, unknown> => {
  const found = findNodes(def, pred);
  expect(found).toHaveLength(1);
  return found[0];
};
const topLevel = (def: RenderableDefinition): Record<string, unknown>[] => def.content as unknown as Record<string, unknown>[];
/** A node picked by its shape, asserted to be one of the definition's top-level nodes. */
const topNode = (def: RenderableDefinition, pred: (n: Record<string, unknown>) => boolean): Record<string, unknown> => {
  const node = one(def, pred);
  expect(topLevel(def).includes(node)).toBe(true);
  return node;
};
const asIs = (n: Record<string, unknown>): Content => n as unknown as Content;
/** A one-node block's own margins zeroed (the wrapper rule, design §5.2). */
const flat = (n: Record<string, unknown>): Content => ({ ...n, margin: [0, 0, 0, 0] }) as Content;
/** Margins compared by value. */
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Table = { widths: unknown[]; body: { text?: unknown }[][] };
const tableOf = (n: Record<string, unknown>): Table => n.table as Table;
const columnsOf = (n: Record<string, unknown>): Record<string, unknown>[] =>
  (Array.isArray(n.columns) ? n.columns : []) as Record<string, unknown>[];
const stackOf = (n: Record<string, unknown> | undefined): Record<string, unknown>[] =>
  (n !== undefined && Array.isArray(n.stack) ? n.stack : []) as Record<string, unknown>[];
/** A column (or stack node) with its stack cut to its first `lines` entries, its own margin kept. */
const cutStack = (n: Record<string, unknown>, lines: number): Record<string, unknown> =>
  ({ ...n, stack: stackOf(n).slice(0, lines) });
/** The first piece of a text array's text, the bold label of a `labelled` or Attn line. */
const leadText = (n: Record<string, unknown>): unknown =>
  Array.isArray(n.text) ? (n.text[0] as { text?: unknown } | undefined)?.text : undefined;

/** The Standard's content is thirteen top-level nodes on `sampleQuote`: the header, the parties,
 *  the intro, the column headers' strip, the line's grid row, its Material line, its PRICE heading,
 *  its price row and that row's three detail lines, the closing and the liability. Each block is
 *  picked by its shape and label, never by index alone. */
function nodes(def: RenderableDefinition, data: QuotePdfData) {
  const top = topLevel(def);
  expect(top).toHaveLength(13);
  const parties = topNode(def, (n) => columnsOf(n).length === 2 && same(n.margin, [0, 0, 0, 8])
    && stackOf(columnsOf(n)[0]).some((c) => leadText(c) === `${label("parties", "attn")} `));
  expect(columnsOf(parties)[0].margin).toEqual([16, 10, 0, 0]);
  expect(stackOf(columnsOf(parties)[1])[0].margin).toEqual([0, 1, 0, 0]);
  // The header's left column (`{ width: 170, text: "" }`) carries no fontSize, so a blank intro is
  // the only node this predicate finds.
  const intro = topNode(def, (n) => n.text === data.introText && n.fontSize === 9.5 && same(n.margin, [0, 2, 0, 4]));
  const strip = topNode(def, (n) => n.layout === LAYOUT.boxed && typeof n.table === "object" && n.table !== null
    && tableOf(n).body[0]?.[0]?.text === label("column_header", "col_qty"));
  expect(tableOf(strip).body).toHaveLength(1);
  const gridRow = top.slice(top.indexOf(strip) + 1)
    .find((n) => Array.isArray(n.columns) && n.columnGap === 6 && same(n.margin, [0, 2, 0, 0]));
  expect(gridRow).toBeDefined();
  expect(top.indexOf(gridRow!)).toBe(top.indexOf(strip) + 1);
  const material = topNode(def, (n) => leadText(n) === `${label("lines", "material")} `);
  const priceHeading = topNode(def, (n) => n.text === label("lines", "price_heading") && n.decoration === "underline");
  const priceRow = top[top.indexOf(priceHeading) + 1];
  expect(Array.isArray(priceRow.columns)).toBe(true);
  expect(priceRow.margin).toEqual([0, 4, 0, 0]);
  expect(top.slice(top.indexOf(gridRow!), top.indexOf(priceRow) + 1)).toEqual([gridRow, material, priceHeading, priceRow]);
  const closing = topNode(def, (n) => same(n.margin, [0, 18, 0, 0]) && columnsOf(n)[1]?.width === 230);
  const liability = topNode(def, (n) => n.text === data.liabilityText && same(n.margin, [0, 10, 0, 0]));
  return { parties, intro, strip, gridRow: gridRow!, material, priceHeading, priceRow, closing, liability };
}

/** The parties' first line: the node's own margin zeroed, each column's stack cut to its first line
 *  (the left column keeps its [16, 10, 0, 0], the right stack's first line its 1 pt). */
const partiesLine = (n: Record<string, unknown>): Content =>
  ({ ...n, margin: [0, 0, 0, 0], columns: columnsOf(n).map((c) => cutStack(c, 1)) }) as unknown as Content;
/** The lines block's first line of print: the first grid row, its 2 pt kept, its stacked identity
 *  (part number, name, description) cut to its first line. */
const gridRowLine = (n: Record<string, unknown>): Content =>
  ({ ...n, columns: columnsOf(n).map((c) => (Array.isArray(c.stack) ? cutStack(c, 1) : c)) }) as unknown as Content;
/** The closing's first line: the node's own margin zeroed, the left stack cut to its first line (the
 *  ending statement), the signature's stack cut to the rule and the signer's name (the signature's
 *  own [0, 10, 0, 0] kept). */
const closingLine = (n: Record<string, unknown>): Content => {
  const [left, right] = columnsOf(n);
  const signature = stackOf(right)[0];
  expect(signature.margin).toEqual([0, 10, 0, 0]);
  return {
    ...n, margin: [0, 0, 0, 0],
    columns: [cutStack(left, 1), { ...right, stack: [cutStack(signature, 2)] }],
  } as unknown as Content;
};

const BLOCKS = ["parties", "intro", "column_header", "lines", "closing", "liability"] as const;
type Blocks = Record<(typeof BLOCKS)[number], number>;
/** The block whose figure `pick` answers; on a tie the first in BLOCKS' order wins. */
const keyOf = (b: Blocks, pick: (xs: number[]) => number): string =>
  BLOCKS.find((k) => b[k] === pick(BLOCKS.map((x) => b[x])))!;

describe("the quote's canvas floors (design 2026-11-12 §4.1)", () => {
  it("QUOTE_ROW_FLOOR is the least block's one line across the families, counting the liability's kept 10 pt, and QUOTE_FIRST_TABLE_ROOM the largest block's first line of print", async () => {
    const line: Record<string, number> = {};
    const lineBlocks: Record<string, Blocks> = {};
    const roomsByFamily: Record<string, Blocks> = {};
    const liabilityFlat: Record<string, number> = {};
    const linesOther: Record<string, number> = {};
    const gridRowWhole: Record<string, number> = {};
    const introBlank: Record<string, number> = {};
    const least: Record<string, string> = {};
    const largest: Record<string, string> = {};
    for (const family of FONT_FAMILIES) {
      const config = inFamily(family);
      // Each block's one-line height, between its own two marks, by the wrapper rule (design §5.2):
      // a one-node block's own margins zeroed; the lines' first grid row keeps its 2 pt and the
      // liability its 10 pt, each start mark above its margin.
      const lineDef = build(sampleQuote(), config);
      const l = nodes(lineDef, sampleQuote());
      const lineTop = await probe(lineDef, [
        mark("parties:a"), partiesLine(l.parties), mark("parties:b"),
        mark("intro:a"), flat(l.intro), mark("intro:b"),
        mark("column_header:a"), flat(l.strip), mark("column_header:b"),
        mark("lines:a"), gridRowLine(l.gridRow), mark("lines:b"),
        mark("closing:a"), closingLine(l.closing), mark("closing:b"),
        mark("liability:a"), asIs(l.liability), mark("liability:b"),
      ]);
      lineBlocks[family] = {
        parties: span(lineTop, "parties"), intro: span(lineTop, "intro"),
        column_header: span(lineTop, "column_header"), lines: span(lineTop, "lines"),
        closing: span(lineTop, "closing"), liability: span(lineTop, "liability"),
      };
      line[family] = Math.min(...Object.values(lineBlocks[family]));

      // The same liability line with its margin zeroed, on a build of its own.
      const flatDef = build(sampleQuote(), config);
      const f = nodes(flatDef, sampleQuote());
      const flatTop = await probe(flatDef, [mark("liability_flat:a"), flat(f.liability), mark("liability_flat:b")]);
      liabilityFlat[family] = span(flatTop, "liability_flat");

      // Each block's room is its first line of print (open question 1's default reading), so the
      // rooms are the one-line heights.
      roomsByFamily[family] = lineBlocks[family];
      least[family] = keyOf(lineBlocks[family], (xs) => Math.min(...xs));
      largest[family] = keyOf(roomsByFamily[family], (xs) => Math.max(...xs));

      // Recorded, never asserted (Departure 1): the other reading of the lines block's room, its grid
      // row, Material line, PRICE heading and first price row, each as it is; and inside it the grid
      // row whole, its identity's three lines uncut.
      const otherDef = build(sampleQuote(), config);
      const o = nodes(otherDef, sampleQuote());
      const otherTop = await probe(otherDef, [
        mark("other:a"), asIs(o.gridRow), mark("row:b"), asIs(o.material), asIs(o.priceHeading), asIs(o.priceRow),
        mark("other:b"),
      ]);
      linesOther[family] = span(otherTop, "other");
      gridRowWhole[family] = otherTop("row:b") - otherTop("other:a");

      // Recorded, never asserted: a blank intro, which still prints its node, its margin zeroed.
      const blank = sampleQuote({ introText: "" });
      const blankDef = build(blank, config);
      const b = nodes(blankDef, blank);
      const blankTop = await probe(blankDef, [mark("intro_blank:a"), flat(b.intro), mark("intro_blank:b")]);
      introBlank[family] = span(blankTop, "intro_blank");
    }
    measured("the quote's canvas floors", {
      line, lineBlocks, linesOther, gridRowWhole, introBlank, liabilityFlat, least, largest,
    });

    // Bounds, so a misread mark (one read at its group's start answers 0) cannot pass. Soft, as every
    // check below is, so a mutation shows every check it breaks in one run.
    for (const family of FONT_FAMILIES) {
      expect.soft(line[family], family).toBeGreaterThanOrEqual(8);
      expect.soft(line[family], family).toBeLessThanOrEqual(20);
      for (const room of Object.values(roomsByFamily[family])) {
        expect.soft(room, family).toBeGreaterThanOrEqual(8);
        expect.soft(room, family).toBeLessThanOrEqual(50);
      }
    }

    // The literals, each held to its measurement.
    expect.soft(QUOTE_ROW_FLOOR).toBe(Math.floor(Math.min(...Object.values(line))));
    expect.soft(QUOTE_FIRST_TABLE_ROOM).toBe(Math.ceil(Math.max(...Object.values(roomsByFamily.Roboto))));
    expect.soft(QUOTE_FIRST_TABLE_ROOM).toBeGreaterThan(QUOTE_ROW_FLOOR);
    // Every block's one line is a least height the floor meets, in every face.
    for (const family of FONT_FAMILIES) {
      for (const height of Object.values(lineBlocks[family])) expect.soft(height, family).toBeGreaterThanOrEqual(QUOTE_ROW_FLOOR);
      // The liability's kept 10 pt, pinned whichever block is least.
      expect.soft(lineBlocks[family].liability - liabilityFlat[family], family).toBeCloseTo(10, 2);
    }
  }, 60_000);
});
