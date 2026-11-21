import { describe, it, expect } from "vitest";
import type { Content } from "pdfmake/interfaces";
import { buildStatementDefinition, type StatementData } from "@/server/pdf/statement";
import { renderPdf, layOutSheetGroups, type RenderableDefinition } from "@/server/pdf/render";
import { mark, spacer } from "@/server/pdf/canvas-nodes";
import {
  FONT_FAMILIES, STATEMENT_DEFAULT_CONFIG, validateConfig, type FontFamily, type TemplateConfig,
} from "@/lib/template-contracts/index";
import {
  STATEMENT_CONTRACT, STATEMENT_FIRST_TABLE_ROOM, STATEMENT_ROW_FLOOR,
} from "@/lib/template-contracts/statement";
import { findNodes } from "./helpers/definition-text";
import { measured } from "./helpers/measured";
import { pageCount, strokedLines, textLinesWithY, textRunsWithY } from "./helpers/pdf";
import { sampleStatement } from "./helpers/statement-canvas-fixtures";

// The statement canvas's floors and two premises its profile rests on (design 2026-11-11 §4.1,
// §5.2, §15), measured on the flow's own nodes (`buildStatementDefinition`), the invoice's method
// (tests/invoice-templates.test.ts, "the invoice's canvas floors"). Importing render.ts warms
// `practiceMode`'s cache (one `SELECT current_database()` at module load, practice-mode.ts), so
// that read runs whichever case runs. Cases one and two are pure layouts (`layOutSheetGroups`) and
// need no database; case three renders through `renderPdf`, whose `stampPractice` reads that cache,
// or retries the read if the warm-up failed (its failure is swallowed), so it alone needs the
// database.

/** Every label read from the contract, never retyped (the default config stores `label: null`). */
const label = (section: string, key: string): string =>
  STATEMENT_CONTRACT.sections.find((s) => s.key === section)!.fields.find((f) => f.key === key)!.defaultLabel;

const inFamily = (family: FontFamily): TemplateConfig => {
  const c = structuredClone(STATEMENT_DEFAULT_CONFIG);
  c.fonts.family = family;
  return validateConfig("STATEMENT", c);
};

/** The flow's definition, built and cloned afresh (pdfmake uses up the nodes it lays out, so no
 *  node is ever placed twice: each measurement takes its own build). */
const build = (data: StatementData, config: TemplateConfig): RenderableDefinition =>
  structuredClone(buildStatementDefinition(data, config));

const WITH_FINANCE = (): StatementData => sampleStatement({ financeCharge: 12.34 });

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
type Table = { headerRows?: number; widths: unknown[]; body: { text?: unknown }[][] };
const tableOf = (n: Record<string, unknown>): Table => n.table as Table;
/** A table node with its body cut to its first `rows` rows. */
const cut = (n: Record<string, unknown>, rows: number): Record<string, unknown> => {
  const t = tableOf(n);
  return { ...n, table: { ...t, body: t.body.slice(0, rows) } };
};
const columnsOf = (n: Record<string, unknown>): Record<string, unknown>[] =>
  (Array.isArray(n.columns) ? n.columns : []) as Record<string, unknown>[];

/** The Standard's content is six top-level nodes with a finance charge: header, identity, open
 *  items, aging, finance, total. Each is picked by shape and label, never by index alone. */
function nodes(def: RenderableDefinition, data: StatementData) {
  expect(topLevel(def)).toHaveLength(6);
  const isTable = (n: Record<string, unknown>) => typeof n.table === "object" && n.table !== null;
  const firstHead = (n: Record<string, unknown>) => tableOf(n).body[0]?.[0]?.text;
  // The identity's left column stack: its Bill To label, then the first bill-to line.
  const identity = one(def, (n) => Array.isArray(n.stack)
    && (n.stack as Record<string, unknown>[]).some((c) => c?.decoration === "underline"));
  const stack = identity.stack as Record<string, unknown>[];
  const at = stack.findIndex((c) => c.decoration === "underline");
  const billToLabel = stack[at];
  const billToLine = stack[at + 1];
  expect(billToLabel.text).toBe(label("identity", "bill_to"));
  expect(billToLine.text).toBe(data.customer.billTo[0]);
  const openItems = topNode(def, (n) => isTable(n) && tableOf(n).headerRows === 1
    && firstHead(n) === label("open_items", "document_no"));
  expect(tableOf(openItems).body).toHaveLength(1 + data.openItems.length);
  const aging = topNode(def, (n) => isTable(n) && tableOf(n).headerRows === 1
    && firstHead(n) === label("aging", "aging_current"));
  expect(tableOf(aging).body).toHaveLength(2);
  const finance = topNode(def, (n) => columnsOf(n)[1]?.text === label("finance_charge", "finance_charge"));
  expect(finance.margin).toEqual([0, 2, 0, 0]);
  const total = topNode(def, (n) => columnsOf(n)[1]?.text === label("total", "total_due"));
  return { billToLabel, billToLine, openItems, aging, finance, total };
}

type Blocks = { bill_to: number; open_items: number; aging: number; finance_charge: number; total: number };

describe("the statement's canvas floors (design 2026-11-11 §4.1)", () => {
  it("STATEMENT_ROW_FLOOR is the least block's one line across the families, counting the finance block's kept 2 pt, and STATEMENT_FIRST_TABLE_ROOM the largest block's room", async () => {
    const line: Record<string, number> = {};
    const lineBlocks: Record<string, Blocks> = {};
    const roomsByFamily: Record<string, Blocks> = {};
    const financeFlat: Record<string, number> = {};
    for (const family of FONT_FAMILIES) {
      const config = inFamily(family);
      // Each block's one-line height, between its own two marks. The Bill To keeps its label's 6 pt
      // top margin (the wrapper rule keeps a several-node block's children's margins, design §5.2);
      // the finance line keeps its [0, 2, 0, 0] with its start mark above it (design §4.1, §5.2).
      const lineDef = build(WITH_FINANCE(), config);
      const l = nodes(lineDef, WITH_FINANCE());
      const lineTop = await probe(lineDef, [
        mark("bill_to:a"), asIs(l.billToLabel), asIs(l.billToLine), mark("bill_to:b"),
        mark("open_items:a"), flat(cut(l.openItems, 1)), mark("open_items:b"),
        mark("aging:a"), flat(cut(l.aging, 1)), mark("aging:b"),
        mark("finance_charge:a"), asIs(l.finance), mark("finance_charge:b"),
        mark("total:a"), flat(l.total), mark("total:b"),
      ]);
      lineBlocks[family] = {
        bill_to: span(lineTop, "bill_to"), open_items: span(lineTop, "open_items"), aging: span(lineTop, "aging"),
        finance_charge: span(lineTop, "finance_charge"), total: span(lineTop, "total"),
      };
      line[family] = Math.min(...Object.values(lineBlocks[family]));

      // The same finance line with its margin zeroed, on a build of its own.
      const flatDef = build(WITH_FINANCE(), config);
      const f = nodes(flatDef, WITH_FINANCE());
      const flatTop = await probe(flatDef, [mark("finance_flat:a"), flat(f.finance), mark("finance_flat:b")]);
      financeFlat[family] = span(flatTop, "finance_flat");

      // Each block's room: the open items' header and first item row, the aging's both rows, their
      // own margins zeroed; the Bill To and the finance line as their one-line heights, the total
      // line zeroed (each a one-line block).
      const roomDef = build(WITH_FINANCE(), config);
      const r = nodes(roomDef, WITH_FINANCE());
      const roomTop = await probe(roomDef, [
        mark("open_items:a"), flat(cut(r.openItems, 2)), mark("open_items:b"),
        mark("aging:a"), flat(r.aging), mark("aging:b"),
      ]);
      roomsByFamily[family] = {
        bill_to: lineBlocks[family].bill_to, open_items: span(roomTop, "open_items"), aging: span(roomTop, "aging"),
        finance_charge: lineBlocks[family].finance_charge, total: lineBlocks[family].total,
      };
    }
    measured("the statement's canvas floors", { line, lineBlocks, roomsByFamily, financeFlat });

    // Bounds, so a misread mark (one read at its group's start answers 0) cannot pass.
    for (const family of FONT_FAMILIES) {
      expect(line[family]).toBeGreaterThanOrEqual(8);
      expect(line[family]).toBeLessThanOrEqual(20);
      for (const room of Object.values(roomsByFamily[family])) {
        expect(room).toBeGreaterThanOrEqual(8);
        expect(room).toBeLessThanOrEqual(50);
      }
    }

    // The literals, each held to its measurement (soft, so a wrong literal shows every check it breaks).
    expect.soft(STATEMENT_ROW_FLOOR).toBe(Math.floor(Math.min(...Object.values(line))));
    expect.soft(STATEMENT_FIRST_TABLE_ROOM).toBe(Math.ceil(Math.max(...Object.values(roomsByFamily.Roboto))));
    expect.soft(STATEMENT_FIRST_TABLE_ROOM).toBeGreaterThan(STATEMENT_ROW_FLOOR);
    // Every block's one line is a least height the floor meets, in every face.
    for (const family of FONT_FAMILIES) {
      for (const height of Object.values(lineBlocks[family])) expect.soft(height).toBeGreaterThanOrEqual(STATEMENT_ROW_FLOOR);
      // The finance block's kept 2 pt, pinned whichever block is least.
      expect.soft(lineBlocks[family].finance_charge - financeFlat[family]).toBeCloseTo(2, 2);
    }
  }, 60_000);

  it("a held block lays out at the larger of its content and its spacer (design 2026-11-11 §4.1, §15)", async () => {
    const figures: Record<string, { content: number; tall: number; tallSpan: number; short: number; shortSpan: number }> = {};
    for (const family of FONT_FAMILIES) {
      const config = inFamily(family);
      // The Bill To's label and first line alone, its content's own span.
      const contentDef = build(WITH_FINANCE(), config);
      const c = nodes(contentDef, WITH_FINANCE());
      const contentTop = await probe(contentDef, [mark("c:a"), asIs(c.billToLabel), asIs(c.billToLine), mark("c:b")]);
      const content = span(contentTop, "c");
      const held = async (h: number): Promise<number> => {
        const def = build(WITH_FINANCE(), config);
        const n = nodes(def, WITH_FINANCE());
        const top = await probe(def, [
          mark("h:a"),
          { columns: [{ width: "*", stack: [asIs(n.billToLabel), asIs(n.billToLine)] }, { width: 0, stack: [spacer(h)] }], columnGap: 0 } as Content,
          mark("h:b"),
        ]);
        return span(top, "h");
      };
      const tall = content + 30;
      const short = 1;
      figures[family] = { content, tall, tallSpan: await held(tall), short, shortSpan: await held(short) };
    }
    measured("the statement's held block", figures);
    for (const family of FONT_FAMILIES) {
      const f = figures[family];
      expect(f.content).toBeGreaterThanOrEqual(8);
      expect.soft(f.tallSpan).toBeCloseTo(Math.max(f.content, f.tall), 2);
      expect.soft(f.shortSpan).toBeCloseTo(Math.max(f.content, f.short), 2);
    }
  }, 60_000);

  it("the open items drawn at 300, 180 and 100 pt render and print what they print, for two data sets (design 2026-11-11 §4.1, call 12)", async () => {
    // Two data sets, each laid out in every family at each width. Neither is a worst case: a
    // payment's document number is its free-text reference (statements.ts, up to 200 characters,
    // receipts.ts) and an amount can carry more figures, so these figures hold for this data only.
    // "typical": three invoices, each the long document number, a long-month date ("September 30,
    // 2026") and a seven-figure original and open, under the default formats.
    const item = {
      documentNumber: "7 - 92026", date: "2026-09-30", dueDate: "2026-09-30", kind: "INVOICE" as const,
      original: 1234567.89, open: 1234567.89,
    };
    const invoices = () => [item, { ...item }, { ...item }];
    // "upper": the same three and a payment whose reference is 40 characters with no space and whose
    // original and open are an eight-figure negative, printed under negativeStyle PARENTHESES. (A
    // real on-account payment's original is its positive amount, statements.ts; the negative
    // original is the stress case.)
    const REFERENCE = "CHK-000123456789-ACH-REMITTANCE-20260930";
    const payment = {
      documentNumber: REFERENCE, date: "2026-09-30", dueDate: null, kind: "PAYMENT" as const,
      original: -12345678.9, open: -12345678.9,
    };
    const sets = {
      typical: { data: sampleStatement({ openItems: invoices(), financeCharge: 12.34 }), negativeStyle: null },
      upper: {
        data: sampleStatement({ openItems: [...invoices(), payment], financeCharge: 12.34 }),
        negativeStyle: "PARENTHESES" as const,
      },
    };
    type SetName = keyof typeof sets;
    const SETS = Object.keys(sets) as SetName[];
    const configFor = (family: FontFamily, set: SetName): TemplateConfig => {
      const c = structuredClone(STATEMENT_DEFAULT_CONFIG);
      c.fonts.family = family;
      const style = sets[set].negativeStyle;
      if (style !== null) c.formats.negativeStyle = style;
      return validateConfig("STATEMENT", c);
    };
    const headWords = ["document_no", "date", "due_date", "original", "open"]
      .flatMap((k) => label("open_items", k).split(/\s+/)).sort();
    type Figure = {
      pages: number; drawnRight: number; rightmostStroke: number; runsPastRight: { text: string; x: number }[];
      headerWordMoved: boolean; headerLine: string[]; lines: string[];
    };
    const WIDTHS = [300, 180, 100] as const;
    const figures = {} as Record<SetName, Record<string, Record<number, Figure>>>;
    for (const set of SETS) {
      figures[set] = {};
      for (const family of FONT_FAMILIES) {
        figures[set][family] = {};
        for (const w of WIDTHS) {
          const data = sets[set].data;
          const def = build(data, configFor(family, set));
          const { openItems } = nodes(def, data);
          // Drawn at x 24 and w wide: a right margin of 564 less w, the lateral margin `drawnBlock`
          // (canvas-sheet.ts) gives a table block, here on the node itself, a top-level group.
          const drawn = { ...openItems, margin: [0, 0, 588 - 24 - w, 0] } as Content;
          const pdf = await renderPdf({
            pageSize: def.pageSize, pageMargins: def.pageMargins, defaultStyle: def.defaultStyle, content: [drawn],
          });
          const right = 24 + w;
          const strokes = strokedLines(pdf).flat();
          const runs = textRunsWithY(pdf);
          const topY = Math.max(...runs[0].map((r) => r.y));
          const topWords = runs[0].filter((r) => Math.abs(r.y - topY) < 0.5)
            .flatMap((r) => r.text.trim().split(/\s+/)).filter((t) => t !== "").sort();
          figures[set][family][w] = {
            pages: pageCount(pdf),
            drawnRight: right,
            rightmostStroke: Math.max(...strokes.map((s) => Math.max(s.x1, s.x2))),
            runsPastRight: runs.flat().filter((r) => r.x > right).map((r) => ({ text: r.text, x: r.x })),
            headerWordMoved: JSON.stringify(topWords) !== JSON.stringify(headWords),
            headerLine: topWords,
            lines: textLinesWithY(pdf)[0].map((l) => l.text),
          };
        }
      }
    }
    measured("the statement's open items drawn narrow", figures);

    // Every render resolves on one page: both sets, every family, every width.
    for (const set of SETS) {
      for (const family of FONT_FAMILIES) {
        for (const w of WIDTHS) expect.soft(figures[set][family][w].pages, `${set}, ${family}, ${w} pt`).toBe(1);
      }
    }
    // The upper set printed its payment row: the reference's start and the parenthesised amount.
    for (const family of FONT_FAMILIES) {
      const text = figures.upper[family][300].lines.join("\n");
      expect.soft(text, family).toContain(REFERENCE.slice(0, 16));
      expect.soft(text, family).toContain("($12,345,678.90)");
    }
    // At 300 pt the typical set fits inside the drawn right edge (its right-most stroke at most 0.5 pt
    // past it) in the three proportional families.
    const PROPORTIONAL = FONT_FAMILIES.filter((f) => f !== "Roboto Mono");
    const FIT_WIDTH = 300;
    for (const family of PROPORTIONAL) {
      const g = figures.typical[family][FIT_WIDTH];
      expect.soft(g.rightmostStroke, `typical, ${family}, ${FIT_WIDTH} pt`).toBeLessThanOrEqual(g.drawnRight + 0.5);
    }
    // Recorded measurements, not wanted outcomes (PR 2 must see them): at 300 pt the table runs past
    // the drawn right edge (by more than 0.5 pt) in the upper set in every family, and in the typical
    // set in Roboto Mono. Inference, not measured: the table shrinks no further than its columns'
    // least widths, each "auto" column at its longest unbreakable piece.
    for (const family of FONT_FAMILIES) {
      const g = figures.upper[family][300];
      expect.soft(g.rightmostStroke, `recorded overrun: upper, ${family}, 300 pt`).toBeGreaterThan(g.drawnRight + 0.5);
    }
    const mono = figures.typical["Roboto Mono"][300];
    expect.soft(mono.rightmostStroke, "recorded overrun: typical, Roboto Mono, 300 pt").toBeGreaterThan(mono.drawnRight + 0.5);
  }, 120_000);
});
