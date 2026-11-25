import { beforeEach, describe, it, expect } from "vitest";
import type { Content } from "pdfmake/interfaces";
import {
  BOL_FLOW, BOL_HEADER_GAP, BOL_WIDTHS, bolCanvasItemContent, buildBolDefinition, type BolData, type Ctx,
} from "@/server/pdf/bol";
import { BOL_COLLECT_BOX, renderPdf, renderSheetGroupsWithPositions, type LaidOutNode } from "@/server/pdf/render";
import { CANVAS_IDS, assembleCanvasSheet, labelOf } from "@/server/pdf/canvas-sheet";
import { FORM_RULE_FIELDS, RULED_FIELDS, WRITE_IN_FIELDS, bolItemContent, buildCanvasBolDefinition } from "@/server/bol-canvas";
import { BOL_CANVAS, BOL_CONTRACT, BOL_LEAST_WIDTHS, DEFAULT_CONFIG as BOL_DEFAULT_CONFIG } from "@/lib/template-contracts/bol";
import { CANVAS_GRID, type CanvasItem, type CanvasLayout } from "@/lib/template-contracts/canvas";
import { completeSections, type TemplateConfig } from "@/lib/template-contracts/types";
import { continuedBox, pageFoot, topMargin } from "@/lib/template-canvas";
import { NET_WEIGHT } from "@/lib/weight-terms";
import {
  drawnText, pageCount, paintedImageCounts, runFonts, strokedLines, textLinesWithY, textRunsWithY, tinyAlphaPng,
} from "./helpers/pdf";
import { barcode, layoutOf, logo } from "./helpers/canvas-fixtures";
import { prisma, seedOrderGatePrereqs, truncateAll } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { createOrder, type OrderDetail } from "@/server/orders";
import { createShipper, printBol } from "@/server/shippers";
import { createTemplate, editDraft, publishDraft, uploadLogo } from "@/server/templates";
import { assignTemplate } from "@/server/template-assignments";
import { seedBolLayout } from "@/server/bol-canvas-seed";
import { validateConfig } from "@/lib/template-contracts/index";
import { canvasRefusal } from "@/lib/template-canvas";
import type { Customer } from "../prisma/generated/prisma/client";
import { bolField, bolTable, bolTextBlock, sampleBol, standardBolLayout } from "./helpers/bol-canvas-fixtures";
import { bandClipLayout, expectBandClip } from "./helpers/band-clip";
import { trvLines, trvListRuns, wrappedRuns } from "./helpers/trv-list";
import { textWidthOf } from "@/lib/tag-font-metrics";

/**
 * The bill of lading's canvas (design 2026-11-09). Its families print what the flow prints through
 * the flow's own builders (`BOL_FLOW`, src/server/pdf/bol.ts), at the widths the flow prints with
 * (`BOL_WIDTHS`), so the profile's figures are held to those widths here, never retyped.
 */

describe("the flow's widths hold the profile (design 2026-11-09 §4.1 addition 5)", () => {
  const W = BOL_WIDTHS;
  /** Each family's fixed columns and gaps plus one grid step for the part that takes the rest. */
  const derived: Record<string, number> = {
    pro_number: W.formLabel + W.formGap + CANVAS_GRID,
    bol_number: W.formLabel + W.formGap + CANVAS_GRID,
    scac_code: W.formLabel + W.formGap + CANVAS_GRID,
    consignee_ref: W.formLabel + W.formGap + CANVAS_GRID,
    destination: W.destinationLabel + W.rowGap + CANVAS_GRID,
    destination_state: W.stateLabel + W.rowGap + CANVAS_GRID,
    destination_zip: W.zipLabel + W.rowGap + CANVAS_GRID,
    delivering_carrier: W.deliveringLabel + W.rowGap + CANVAS_GRID,
    vehicle_initials: W.initialsLabel + W.rowGap + CANVAS_GRID,
    vehicle_no: W.vehicleNoLabel + W.rowGap + CANVAS_GRID,
    shipper_per: W.signLabel + W.signGap + CANVAS_GRID,
    agent_per: W.signLabel + W.signGap + CANVAS_GRID,
    po_address: W.poAddressLabel + W.rowGap + CANVAS_GRID,
    consigned_to: W.consignedLabel + W.rowGap + W.consignedRule + W.rowGap + CANVAS_GRID,
    carrier_name: W.carrierLabel + W.rowGap + CANVAS_GRID,
    trv: W.trvLabel + CANVAS_GRID,
  };

  it("names the same families the profile's least widths name", () => {
    expect(Object.keys(BOL_LEAST_WIDTHS).sort()).toEqual(Object.keys(derived).sort());
  });

  it.each(Object.keys(derived))("%s's least width is its derivation from the flow's widths", (key) => {
    expect(BOL_LEAST_WIDTHS[key]).toBe(derived[key]);
  });

  it("the freight block keeps the sidebar and its gap beside its table", () => {
    const freight = BOL_CANVAS.tables.find((t) => t.key === "freight")!;
    const printed = freight.printed;
    expect(printed !== null && "beside" in printed ? printed.beside : null).toBe(W.sidebar + W.sidebarGap);
  });
});

/** One `columns` node of a definition: its column widths, its gap, and for each column the length of
 *  a rule sitting directly in its stack (null where none does). */
type ColumnsShape = { widths: unknown[]; gap: unknown; rules: (number | null)[] };

/** Every `columns` node of `node`, in pre-order. */
function columnsShapes(node: unknown, out: ColumnsShape[] = []): ColumnsShape[] {
  if (Array.isArray(node)) {
    for (const child of node) columnsShapes(child, out);
    return out;
  }
  if (node === null || typeof node !== "object") return out;
  const o = node as Record<string, unknown>;
  if (Array.isArray(o.columns)) {
    const cols = o.columns as Record<string, unknown>[];
    out.push({
      widths: cols.map((c) => c.width),
      gap: o.columnGap ?? null,
      rules: cols.map((c) => {
        const stack = Array.isArray(c.stack) ? (c.stack as Record<string, unknown>[]) : [];
        const rule = stack.find((s) => Array.isArray(s.canvas));
        return rule === undefined ? null : ((rule.canvas as Record<string, unknown>[])[0].x2 as number);
      }),
    });
  }
  for (const value of Object.values(o)) columnsShapes(value, out);
  return out;
}

describe("the flow prints at the widths it exports (design 2026-11-09 §4.1 addition 5)", () => {
  it("every columns row of the standard paper takes its widths, gaps and rules from BOL_WIDTHS", () => {
    const W = BOL_WIDTHS;
    const formRule: ColumnsShape = { widths: [W.formLabel, W.formRule], gap: W.formGap, rules: [null, W.formRule] };
    const consigneeRow: ColumnsShape = {
      widths: [W.consignedLabel, W.consignedRule, "*"], gap: W.rowGap, rules: [null, W.consignedRule, null],
    };
    // Exact and in order, so a literal in one of several like rows (the four form rules, the two
    // consignee rows) cannot hide behind the others. The header's gap is the exported
    // `BOL_HEADER_GAP` (12 pt, the paper's); the declared-value "Per" row keeps the flow's own
    // literals (200 / 30 / 160).
    expect(BOL_HEADER_GAP).toBe(12);
    // A sidebar label beside its rule (owner ruling R1, 2026-11-24): the words as wide as they print,
    // rounded up, a 4 pt gap and the rule taking the rest of the 160 pt row.
    const sidebarRow = (words: string, size: number, face: "normal" | "bold"): ColumnsShape => {
      const width = Math.ceil(textWidthOf(words, "Roboto", face, size));
      return { widths: [width, 160 - width - 4], gap: 4, rules: [null, 160 - width - 4] };
    };
    expect(columnsShapes(buildBolDefinition(sampleBol()).content)).toEqual([
      { widths: ["*", W.headerRight], gap: BOL_HEADER_GAP, rules: [null, null] },
      formRule, formRule, formRule, formRule,
      { widths: [W.carrierLabel, W.carrierRule], gap: W.rowGap, rules: [null, W.carrierRule] },
      consigneeRow, consigneeRow,
      {
        widths: [W.destinationLabel, W.destinationRule, W.stateLabel, W.stateRule, W.zipLabel, W.zipRule, "*"],
        gap: W.rowGap, rules: [null, W.destinationRule, null, W.stateRule, null, W.zipRule, null],
      },
      { widths: [W.trvLabel, "*"], gap: null, rules: [null, null] },
      {
        widths: [W.deliveringLabel, W.deliveringRule, W.initialsLabel, W.initialsRule, W.vehicleNoLabel, "*"],
        gap: W.rowGap, rules: [null, W.deliveringRule, null, W.initialsRule, null, W.vehicleNoRule],
      },
      { widths: ["*", W.sidebar], gap: W.sidebarGap, rules: [null, null] },
      sidebarRow("Signature of consignor", 5.5, "normal"),
      { widths: ["*", BOL_COLLECT_BOX.column], gap: null, rules: [null, null] },
      sidebarRow("RECEIVED $", 6.5, "bold"),
      sidebarRow("Agent or Cashier", 5.5, "normal"),
      sidebarRow("Per", 6.5, "normal"),
      sidebarRow("$", 6.5, "normal"),
      { widths: [200, 30, 160, "*"], gap: null, rules: [null, null, 160, null] },
      {
        widths: [W.signLabel, W.shipperRule, W.signLabel, "*"], gap: W.signGap,
        rules: [null, W.shipperRule, null, W.agentRule],
      },
      { widths: [W.poAddressLabel, "*"], gap: W.rowGap, rules: [null, W.poAddressRule] },
    ]);
  });
});

describe("the flow's ship-from line keeps its type (one sentence since owner ruling R2, 2026-11-24)", () => {
  it("prints the date bold and the address, \"From\" and the name with no bold key, in one text node", () => {
    const sentences = textNodesOpening(buildBolDefinition(sampleBol()).content, "at ");
    expect(sentences).toHaveLength(1);
    const [address, date, name] = sentences[0];
    expect(date.bold).toBe(true);
    for (const run of [address, name]) expect("bold" in run).toBe(false);
    expect(name.text).toMatch(/^ {4}From /);
  });
});

/** The runs of every text node of `node` whose text is a list of runs, the first opening with
 *  `opening`, in pre-order. */
function textNodesOpening(node: unknown, opening: string, out: Record<string, unknown>[][] = []): Record<string, unknown>[][] {
  if (Array.isArray(node)) {
    for (const child of node) textNodesOpening(child, opening, out);
    return out;
  }
  if (node === null || typeof node !== "object") return out;
  const o = node as Record<string, unknown>;
  if (Array.isArray(o.text)) {
    const runs = o.text as Record<string, unknown>[];
    if (typeof runs[0]?.text === "string" && (runs[0].text as string).startsWith(opening)) out.push(runs);
  }
  for (const value of Object.values(o)) textNodesOpening(value, opening, out);
  return out;
}

// ---------------------------------------------------------------------------------------------
// The field families (Task 2). COORDINATES: `strokedLines` and the layout's boxes are top-down page
// coordinates; `textLinesWithY` and `textRunsWithY` report a baseline from the page's BOTTOM edge.
// ---------------------------------------------------------------------------------------------

const PAGE_HEIGHT = 792;

const cfg = (over: Partial<TemplateConfig> = {}): TemplateConfig => ({ ...structuredClone(BOL_DEFAULT_CONFIG), ...over });

/** The ctx the flow builds from `config` (`buildBolDefinition`'s own), so the date knob, the number
 *  format and the sections are the config's. */
function ctxFor(config: TemplateConfig): Ctx {
  return {
    fonts: config.fonts,
    num: BOL_FLOW.makeNum(config.formats),
    bolDate: BOL_FLOW.makeBolDate(config.formats),
    text: BOL_FLOW.textOf(config.textBlocks),
    sections: new Map(completeSections(BOL_CONTRACT, config.sections).map((sc) => [sc.key, BOL_FLOW.sectionView(sc)] as const)),
    logo: null,
  };
}

/** A sheet of these items alone (no block), rendered. */
async function renderItems(items: CanvasItem[], config: TemplateConfig = cfg(), d: BolData = sampleBol()): Promise<Buffer> {
  return renderPdf(assembleCanvasSheet({
    layout: layoutOf(items), pageFooter: false, fonts: config.fonts,
    itemContent: bolItemContent(ctxFor(config), d, BOL_FLOW), tableBlock: () => null,
  }));
}

/** Page 1's printed lines, blank ones (a write-in's lone space) left out. */
const linesOf = (pdf: Buffer) => textLinesWithY(pdf)[0].filter((l) => l.text !== "");

const isBold = (font: string): boolean => font.endsWith("-Medium") || font.endsWith("-Bold");

/** Page 1's horizontal strokes (top-down), each as its start x, length and y. */
const horizontals = (pdf: Buffer) => strokedLines(pdf)[0]
  .filter((s) => Math.abs(s.y1 - s.y2) < 0.01 && Math.abs(s.x2 - s.x1) > 0.01)
  .map((s) => ({ x: Math.min(s.x1, s.x2), length: Math.abs(s.x2 - s.x1), y: s.y1 }));

describe("the bill of lading's field families (design 2026-11-09 §4.2)", () => {
  const W = BOL_WIDTHS;
  const d = sampleBol();

  /** Each family's key, a box wide enough for it, and the words of the flow's paper it prints. */
  const FAMILIES: { key: string; w: number; size: number; bold: boolean; words: string[] }[] = [
    { key: "original_label", w: 300, size: 9, bold: true, words: ["Original - Not Negotiable"] },
    { key: "title", w: 300, size: 15, bold: true, words: ["STRAIGHT BILL OF LADING"] },
    { key: "pro_number", w: 244, size: 7.5, bold: true, words: ["Carrier's Pro No.", d.proNumber] },
    { key: "bol_number", w: 244, size: 7.5, bold: true, words: ["Shipper's Bill of Lading No.", String(d.bolNumber)] },
    { key: "scac_code", w: 244, size: 7.5, bold: true, words: ["Carrier's Code (SCAC)", d.scacCode] },
    { key: "destination", w: 224, size: 9, bold: true, words: ["Destination", d.consignee.city] },
    { key: "destination_state", w: 60, size: 7.5, bold: true, words: ["St", d.consignee.state] },
    { key: "destination_zip", w: 82, size: 7.5, bold: true, words: ["Zip", d.consignee.zip] },
    { key: "delivering_carrier", w: 234, size: 8, bold: true, words: ["Delivering Carrier"] },
    { key: "vehicle_initials", w: 199, size: 8, bold: true, words: ["Car or Vehicle Initials"] },
    { key: "vehicle_no", w: 81, size: 8, bold: true, words: ["No."] },
    { key: "shipper_per", w: 226, size: 7.5, bold: true, words: ["Shipper, Per"] },
    { key: "agent_per", w: 266, size: 7.5, bold: true, words: ["Agent, Per"] },
    { key: "po_address", w: 469, size: 7.5, bold: true, words: ["Permanent Post-office address of shipper"] },
    { key: "carrier_name", w: 334, size: 10, bold: true, words: ["Name of Carrier", d.carrierName] },
    { key: "ship_from", w: 564, size: 8.5, bold: false, words: [`at ${d.company.address}`, "Jul - 06 - 2026", "From", d.company.name] },
    { key: "consigned_to", w: 564, size: 9, bold: true, words: ["Consigned to", d.consignee.name, d.consignee.street, "(Mail or street address of consign - For purposes of notification only.)"] },
  ];

  const ALONE = new Set(["original_label", "title", "carrier_name", "ship_from"]);

  it.each(FAMILIES)("$key prints the flow's text for its key", async ({ key, w, size, bold, words }) => {
    const flow = textLinesWithY(await renderPdf(buildBolDefinition(d)))[0].map((l) => l.text);
    const lines = linesOf(await renderItems([bolField(key, { box: { x: 24, y: 100, w, h: 12 }, style: { size, bold, align: "left" } })]));
    expect(lines.length).toBeGreaterThan(0);
    // The oracle: every line the item prints is the flow's own line, or a part of one where the flow
    // prints a neighbour on the same baseline (the destination row, the delivering-carrier row).
    for (const line of lines) expect(flow.some((f) => f.includes(line.text)), `${key}: "${line.text}"`).toBe(true);
    // The keys the flow prints alone on their baselines: each line is one of the flow's lines whole, so
    // a short or partial text cannot pass by containment.
    if (ALONE.has(key)) for (const line of lines) expect(flow, `${key}: "${line.text}"`).toContain(line.text);
    const printed = lines.map((l) => l.text).join(" ").replace(/\s+/g, "");
    for (const word of words) expect(printed).toContain(word.replace(/\s+/g, ""));
  });

  /** The ruled families: the label column and the gap before the rule, which takes the rest. */
  const RULED: [string, number, number][] = [
    ["pro_number", W.formLabel, W.formGap], ["bol_number", W.formLabel, W.formGap], ["scac_code", W.formLabel, W.formGap],
    ["destination", W.destinationLabel, W.rowGap], ["destination_state", W.stateLabel, W.rowGap],
    ["destination_zip", W.zipLabel, W.rowGap],
    ["delivering_carrier", W.deliveringLabel, W.rowGap], ["vehicle_initials", W.initialsLabel, W.rowGap],
    ["vehicle_no", W.vehicleNoLabel, W.rowGap], ["shipper_per", W.signLabel, W.signGap], ["agent_per", W.signLabel, W.signGap],
    ["po_address", W.poAddressLabel, W.rowGap],
  ];

  it.each(RULED)("%s strokes one rule from its label column and gap to the box's right edge", async (key, label, gap) => {
    const x = 60;
    for (const w of [label + gap + 50, label + gap + 250]) {
      const rules = horizontals(await renderItems([bolField(key, { box: { x, y: 100, w, h: 12 } })]));
      expect(rules).toHaveLength(1);
      expect(rules[0].x).toBeCloseTo(x + label + gap, 2);
      expect(rules[0].length).toBeCloseTo(w - label - gap, 2);
    }
  });

  it("a widened pro number box lengthens its rule, the label at the item's style and the value at 8 pt", async () => {
    const x = 24;
    const box = (w: number) => ({ x, y: 100, w, h: 12 });
    const narrow = W.formLabel + W.formGap + W.formRule;
    const at = horizontals(await renderItems([bolField("pro_number", { box: box(narrow) })]));
    const wide = horizontals(await renderItems([bolField("pro_number", { box: box(narrow + 200) })]));
    expect(at[0].x).toBeCloseTo(x + W.formLabel + W.formGap, 2);
    expect(at[0].length).toBeCloseTo(W.formRule, 2);
    expect(wide[0].x).toBeCloseTo(x + W.formLabel + W.formGap, 2);
    expect(wide[0].length).toBeCloseTo(W.formRule + 200, 2);

    for (const bold of [false, true]) {
      const runs = runFonts(await renderItems([bolField("pro_number", { box: box(narrow), style: { size: 9, bold, align: "left" } })]));
      const label = runs.filter((r) => ["Carrier's", "Pro", "No."].includes(r.text));
      expect(label).toHaveLength(3);
      for (const r of label) {
        expect(r.size).toBe(9);
        expect(isBold(r.font)).toBe(bold);
      }
      const value = runs.find((r) => r.text === d.proNumber)!;
      expect(value.size).toBe(8);
      expect(isBold(value.font)).toBe(false);
    }
  });

  it("every ship-from item prints the date knob's date, bold whatever the item's bold, the rest at the item's", async () => {
    const config = cfg({ formats: { ...BOL_DEFAULT_CONFIG.formats, dateFormat: "YYYY-MM-DD" } });
    const data = sampleBol({ shipDate: "2026-07-29" });
    const items = (bold: boolean) => [
      bolField("ship_from", { id: "ship-from-1", box: { x: 24, y: 100, w: 564, h: 12 }, style: { size: 8.5, bold, align: "left" } }),
      bolField("ship_from", { id: "ship-from-2", box: { x: 24, y: 300, w: 564, h: 12 }, style: { size: 8.5, bold, align: "left" } }),
    ];
    for (const bold of [false, true]) {
      const runs = runFonts(await renderItems(items(bold), config, data));
      const dates = runs.filter((r) => r.text === "2026-07-29");
      expect(dates).toHaveLength(2);
      for (const r of dates) {
        expect(isBold(r.font)).toBe(true);
        expect(r.size).toBe(8.5);
      }
      const rest = runs.filter((r) => ["at", "From", "Example"].includes(r.text));
      expect(rest.length).toBeGreaterThanOrEqual(6);
      for (const r of rest) expect(isBold(r.font)).toBe(bold);
    }
  });

  it("the form rules and the ship-from line drop the flow's margins: the box carries the drawn distances", async () => {
    const config = cfg();
    const content = bolItemContent(ctxFor(config), d, BOL_FLOW);
    /** Every `margin` in a node's tree. */
    const margins = (node: unknown, out: unknown[] = []): unknown[] => {
      if (Array.isArray(node)) { for (const child of node) margins(child, out); return out; }
      if (node === null || typeof node !== "object") return out;
      const o = node as Record<string, unknown>;
      if ("margin" in o) out.push(o.margin);
      for (const value of Object.values(o)) margins(value, out);
      return out;
    };
    for (const key of ["pro_number", "bol_number", "scac_code", "ship_from"]) {
      const found = margins(content(bolField(key, { box: { x: 24, y: 100, w: 564, h: 12 } })));
      expect(found.length, key).toBeGreaterThan(0);
      for (const margin of found) expect(margin, key).toEqual([0, 0, 0, 0]);
    }
    // On paper: a ship-from line's baseline is a plain text item's at the same top and size (the
    // flow's 2 pt top margin would set it 2 pt lower).
    const style = { size: 8.5, bold: false, align: "left" as const };
    const pdf = await renderItems([
      bolField("ship_from", { box: { x: 24, y: 100, w: 564, h: 12 }, style }),
      { id: "text-probe", kind: "text", text: "PROBE", box: { x: 24, y: 300, w: 100, h: 12 }, anchor: { kind: "page-top" }, repeat: false, style },
    ]);
    const runs = textRunsWithY(pdf)[0];
    const at = runs.find((r) => r.text.trim() === "at")!;
    const probe = runs.find((r) => r.text.trim() === "PROBE")!;
    expect((PAGE_HEIGHT - at.y) - 100).toBeCloseTo((PAGE_HEIGHT - probe.y) - 300, 2);
  });

  it("a text block prints its wording as one node, as the flow does: a blank line kept, no paragraph gap", async () => {
    const wording = `${BOL_CONTRACT.textBlocks.find((t) => t.key === "bol_received_text")!.defaultText}\n\nA SECOND PARAGRAPH AFTER A BLANK LINE.`;
    const config = cfg({ textBlocks: { ...BOL_DEFAULT_CONFIG.textBlocks, bol_received_text: wording } });
    const size = config.fonts.smallSize;
    // The oracle: the flow's node for this wording (`receivedBlock`'s, without its bottom margin)
    // rendered alone at the flow's 564 pt.
    const oracle = linesOf(await renderPdf({
      pageSize: "LETTER", pageMargins: [24, 24, 24, 24], defaultStyle: { font: config.fonts.family, fontSize: config.fonts.baseSize },
      content: [{ text: wording, fontSize: size } as Content],
    }));
    const lines = linesOf(await renderItems(
      [bolTextBlock("bol_received_text", { anchor: { kind: "page-top" }, box: { x: 24, y: 100, w: 564, h: 40 }, style: { size, bold: false, align: "left" } })],
      config,
    ));
    expect(oracle.length).toBeGreaterThanOrEqual(3);
    expect(lines.map((l) => l.text)).toEqual(oracle.map((l) => l.text));
    const steps = (ls: { y: number }[]) => ls.map((l) => l.y - ls[0].y);
    steps(lines).forEach((step, i) => expect(step).toBeCloseTo(steps(oracle)[i], 1));
  });

  it("consigned_to prints the caption beside the first line and the street on the second, each on a flow-long rule", async () => {
    const x = 24;
    const pdf = await renderItems([bolField("consigned_to", { box: { x, y: 100, w: 564, h: 24 }, style: { size: 9, bold: true, align: "left" } })]);
    const rules = horizontals(pdf).sort((a, b) => a.y - b.y);
    expect(rules).toHaveLength(2);
    for (const rule of rules) {
      expect(rule.x).toBeCloseTo(x + W.consignedLabel + W.rowGap, 2);
      expect(rule.length).toBeCloseTo(W.consignedRule, 2);
    }
    const lines = linesOf(pdf);
    const name = lines.find((l) => l.text.endsWith(d.consignee.name))!;
    const caption = lines.find((l) => l.text.startsWith("(Mail or street"))!;
    const street = lines.find((l) => l.text === d.consignee.street)!;
    expect(Math.abs(caption.y - name.y)).toBeLessThan(3);
    expect(street.y).toBeLessThan(name.y - 6);
    const captionRun = textRunsWithY(pdf)[0].find((r) => r.text.startsWith("(Mail"))!;
    expect(captionRun.x).toBeGreaterThanOrEqual(x + W.consignedLabel + W.rowGap + W.consignedRule + W.rowGap);
  });

  it("carrier_name prints its label in the label column beside a rule taking the rest of the box, the name centred on it at the item's style", async () => {
    // The seeded box (24, 334 wide) and a box stored before owner ruling R1 (84, 260 wide, the old seed's).
    for (const box of [{ x: 24, y: 100, w: 334, h: 20 }, { x: 84, y: 100, w: 260, h: 20 }]) {
      const pdf = await renderItems([bolField("carrier_name", { box, style: { size: 10, bold: true, align: "center" } })]);
      const rules = horizontals(pdf);
      expect(rules).toHaveLength(1);
      expect(rules[0].x).toBeCloseTo(box.x + W.carrierLabel + W.rowGap, 2);
      expect(rules[0].length).toBeCloseTo(box.w - W.carrierLabel - W.rowGap, 2);
      const runs = runFonts(pdf);
      const label = runs.find((r) => r.text === "Name")!; // runFonts trims each run
      expect(label.x).toBeCloseTo(box.x, 1);
      expect(label.size).toBe(9);
      expect(isBold(label.font)).toBe(true);
      const name = runs.find((r) => r.text === "Demo")!;
      expect(name.size).toBe(10);
      expect(Math.abs(name.y - label.y)).toBeLessThan(1.5);
      expect(name.x).toBeGreaterThan(rules[0].x);
    }
  });

  it("carrier_name with no carrier prints its label beside a blank rule", async () => {
    const box = { x: 24, y: 100, w: 334, h: 20 };
    const pdf = await renderItems([bolField("carrier_name", { box })], cfg(), sampleBol({ carrierName: "" }));
    const rules = horizontals(pdf);
    expect(rules).toHaveLength(1);
    expect(rules[0].x).toBeCloseTo(box.x + W.carrierLabel + W.rowGap, 2);
    expect(linesOf(pdf).map((l) => l.text)).toEqual(["Name of Carrier"]);
  });

  it("a wording the freight block prints itself, a barcode and a block's own field print nothing", () => {
    const config = cfg();
    const content = bolItemContent(ctxFor(config), d, BOL_FLOW);
    const ownWordings = BOL_CANVAS.tables.flatMap((t) => t.textBlocks ?? []);
    expect(ownWordings.length).toBeGreaterThan(0);
    for (const key of ownWordings) expect(content(bolTextBlock(key))).toBeNull();
    expect(content(barcode())).toBeNull();
    for (const key of BOL_CANVAS.notFields) expect(content(bolField(key))).toBeNull();
    // A placeable wording does print (the neighbouring case, so the nulls above are the rule's).
    expect(content(bolTextBlock("bol_water_note"))).not.toBeNull();
  });

  it("RULED_FIELDS is design §4.1's ruledFields list", () => {
    expect([...RULED_FIELDS].sort()).toEqual([
      "agent_per", "bol_number", "carrier_name", "consigned_to", "delivering_carrier", "destination",
      "destination_state", "destination_zip", "po_address", "pro_number", "scac_code", "shipper_per",
      "vehicle_initials", "vehicle_no",
    ]);
  });
  it("the profile's ruledFields are the server's ruled families, each drawn as its family prints", () => {
    expect(BOL_CANVAS.ruledFields.map((r) => r.key).sort()).toEqual([...RULED_FIELDS].sort());
    const drawOf = (key: string) => BOL_CANVAS.ruledFields.find((r) => r.key === key);
    for (const key of [...FORM_RULE_FIELDS, ...WRITE_IN_FIELDS]) expect(drawOf(key)).toEqual({ key, draw: "beside" });
    // The carrier's label beside its line (owner ruling R1, 2026-11-24, over ruling (a)'s "under").
    expect(drawOf("carrier_name")).toEqual({ key: "carrier_name", draw: "beside" });
    // The consignee's two rules are the flow's own column (owner ruling (a), 2026-11-10).
    expect(drawOf("consigned_to")).toEqual({ key: "consigned_to", draw: "lines", column: BOL_WIDTHS.consignedRule });
  });
});

// ---------------------------------------------------------------------------------------------
// A canvas bill of lading (Task 3): the three blocks, the items riding them and the branch.
// COORDINATES: `renderSheetGroupsWithPositions`' positions, `strokedLines` and the layout's boxes are
// top-down page coordinates; `textLinesWithY` reports a baseline from the page's BOTTOM edge, which
// `linesOn` turns into a top-down `top`.
// ---------------------------------------------------------------------------------------------

const BLOCKS = ["consignee_ref", "trv", "freight"] as const;

const bolCfg = (layout: CanvasLayout | null, over: Partial<TemplateConfig> = {}): TemplateConfig =>
  ({ ...structuredClone(BOL_DEFAULT_CONFIG), layout, ...over });

async function renderBol(d: BolData, config: TemplateConfig) {
  const def = buildBolDefinition(d, config);
  const { pdf, groups } = await renderSheetGroupsWithPositions([def]);
  return { pdf, def, group: groups[0] };
}

/** The laid-out node under an id, which the case requires. */
function at(group: { positions: LaidOutNode[] }, id: string): LaidOutNode {
  const found = group.positions.find((node) => node.id === id);
  if (found === undefined) throw new Error(`no laid-out node "${id}"`);
  return found;
}

/** A layout's item with this id, replaced. */
function withItem(layout: CanvasLayout, id: string, change: (item: CanvasItem) => CanvasItem): CanvasLayout {
  return layoutOf(layout.items.map((item) => (item.id === id ? change(item) : item)));
}

/** The printed lines of a page, each with its baseline top-down. */
const linesOn = (pdf: Buffer, page = 1) =>
  textLinesWithY(pdf)[page - 1].map((line) => ({ text: line.text, top: PAGE_HEIGHT - line.y }));

/** The one printed line holding `needle` on page 1, which the case requires. */
function lineWith(pdf: Buffer, needle: string) {
  const found = linesOn(pdf).filter((l) => l.text.includes(needle));
  expect(found, `one line holding "${needle}"`).toHaveLength(1);
  return found[0];
}

/** The top-down baseline of page 1's one text run starting with `needle`, unrounded (`textLinesWithY`
 *  rounds a baseline to half a point, too coarse for an offset held to two decimals). */
function runTop(pdf: Buffer, needle: string): number {
  const found = textRunsWithY(pdf)[0].filter((r) => r.text.trim().startsWith(needle));
  expect(found.length, `a run starting "${needle}"`).toBeGreaterThan(0);
  return PAGE_HEIGHT - found[0].y;
}

/** A shipment of `n` orders, each with a seven-character PO. */
function bolOrders(n: number, over: Partial<BolData> = {}): BolData {
  return sampleBol({
    orderNumbers: Array.from({ length: n }, (_, i) => 92000 + i),
    poNumbers: Array.from({ length: n }, (_, i) => `PO${10000 + i}`),
    orders: Array.from({ length: n }, () => ({ lineWeights: [100], containers: [] })),
    ...over,
  });
}

/** Every node of a definition, depth first. */
function nodesOf(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) { for (const n of node) nodesOf(n, out); return out; }
  out.push(node as Record<string, unknown>);
  for (const value of Object.values(node as Record<string, unknown>)) nodesOf(value, out);
  return out;
}

/** Page `page`'s vertical strokes (top-down), each as its x and its span. */
const verticals = (pdf: Buffer, page = 1) => strokedLines(pdf)[page - 1]
  .filter((s) => Math.abs(s.x1 - s.x2) < 0.01 && Math.abs(s.y2 - s.y1) > 0.01)
  .map((s) => ({ x: s.x1, from: Math.min(s.y1, s.y2), to: Math.max(s.y1, s.y2) }));

describe("a canvas bill of lading (design 2026-11-09 §4.4, §5.2)", () => {
  const W = BOL_WIDTHS;

  it("prints each page-top item at its drawn top and the three blocks at their drawn tops, in y order; the definition is pure JSON with no overflow margin", async () => {
    // A block is as tall as its lines need, so first fit each block's drawn height to what it printed
    // and restack the blocks under it at their drawn gaps (the items below a block keep their offsets).
    const standard = standardBolLayout();
    const first = await renderBol(sampleBol(), bolCfg(standard));
    const drawnOf = (layout: CanvasLayout, key: string) =>
      layout.items.find((item) => item.kind === "table" && item.key === key)!.box;
    let fitted = standard;
    let top = drawnOf(standard, "consignee_ref").y;
    for (const [i, key] of BLOCKS.entries()) {
      const start = i === 0 ? top : at(first.group, CANVAS_IDS.regionEnd(BLOCKS[i - 1])).top;
      const h = at(first.group, CANVAS_IDS.end(key)).top - start;
      if (i > 0) {
        const above = drawnOf(standard, BLOCKS[i - 1]);
        top += drawnOf(fitted, BLOCKS[i - 1]).h + (drawnOf(standard, key).y - above.y - above.h);
      }
      const y = top;
      fitted = withItem(fitted, `table-${key}`, (item) => ({ ...item, box: { ...item.box, y, h } }));
    }
    // Pure JSON, checked on a fresh build: a render lays the page-top nodes out in place.
    const def = buildBolDefinition(sampleBol(), bolCfg(fitted));
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
    expect(def.continuationHeaderSpec).not.toHaveProperty("overflowTopMargin");
    const { pdf, group } = await renderBol(sampleBol(), bolCfg(fitted));
    expect(pageCount(pdf)).toBe(1);
    let previous = -Infinity;
    for (const [i, key] of BLOCKS.entries()) {
      const drawn = drawnOf(fitted, key);
      // A block after the first starts where the region above it ends (the first starts at the
      // spacer's end, which its own mark below reads).
      if (i > 0) expect(Math.abs(at(group, CANVAS_IDS.regionEnd(BLOCKS[i - 1])).top - drawn.y), key).toBeLessThan(2);
      const own = at(group, CANVAS_IDS.table(key));
      expect(own.page).toBe(1);
      expect(Math.abs(own.top - drawn.y), key).toBeLessThan(2);
      expect(own.top).toBeGreaterThan(previous);
      previous = own.top;
    }
    // Every page-top item: its wrapper exactly at its box's top-left, its first line's baseline
    // within its box (a baseline sits under its line's top by less than the line's size).
    for (const item of fitted.items) {
      if (item.kind !== "field" || item.anchor.kind !== "page-top") continue;
      expect(at(group, CANVAS_IDS.item(item.id))).toMatchObject({ page: 1, left: item.box.x, top: item.box.y });
    }
    for (const [id, needle] of [
      ["field-original_label", "Original - Not Negotiable"], ["field-title", "STRAIGHT BILL OF LADING"],
      ["field-pro_number", "Carrier's Pro No."], ["field-bol_number", "Shipper's Bill of Lading No."],
    ] as const) {
      const box = fitted.items.find((item) => item.id === id)!.box;
      const line = lineWith(pdf, needle);
      expect(line.top - box.y, id).toBeGreaterThan(0);
      expect(line.top - box.y, id).toBeLessThan(box.h + 2);
    }
  });

  describe("the Consignee's ref/PO block", () => {
    const layout = standardBolLayout();
    const block = layout.items.find((item) => item.id === "table-consignee_ref")!.box;

    it("prints its label at 7.5 bold and its POs at 8 on a rule the drawn width less the label column and gap", async () => {
      const { pdf } = await renderBol(sampleBol(), bolCfg(layout));
      const runs = runFonts(pdf);
      const inBlock = (r: { y: number }) => PAGE_HEIGHT - r.y > block.y && PAGE_HEIGHT - r.y < block.y + 12;
      const label = runs.filter((r) => ["Consignee's", "Ref/", "PO", "No."].includes(r.text) && inBlock(r));
      expect(label).toHaveLength(4);
      for (const r of label) { expect(r.size).toBe(7.5); expect(isBold(r.font)).toBe(true); }
      const po = runs.find((r) => r.text.startsWith("DEMO-") && inBlock(r))!;
      expect(po.size).toBe(8);
      const rules = horizontals(pdf).filter((h) => h.y > block.y && h.y < block.y + 14);
      expect(rules).toHaveLength(1);
      expect(rules[0].x).toBeCloseTo(block.x + W.formLabel + W.formGap, 2);
      expect(rules[0].length).toBeCloseTo(block.w - W.formLabel - W.formGap, 2);
      // The value on its own baseline (8 pt beside the 7.5 pt label): the flow's join, on one line.
      expect(lineWith(pdf, "DEMO-PO-24115").text).toBe("DEMO-PO-24115, PT24116");
      // The standard box leaves the flow's own 130 pt rule; a block drawn wider (from x 276 to the right
      // margin) lengthens the rule by as much.
      expect(block.w - W.formLabel - W.formGap).toBe(W.formRule);
      const wide = { x: 276, w: 312 };
      const widened = await renderBol(sampleBol(), bolCfg(withItem(layout, "table-consignee_ref", (item) => ({ ...item, box: { ...item.box, ...wide } }))));
      const wideRules = horizontals(widened.pdf).filter((h) => h.y > block.y && h.y < block.y + 14);
      expect(wideRules).toHaveLength(1);
      expect(wideRules[0].x).toBeCloseTo(wide.x + W.formLabel + W.formGap, 2);
      expect(wideRules[0].length).toBeCloseTo(W.formRule + (wide.w - block.w), 2);
    });

    it("a typed heading prints in place of the label", async () => {
      const typed = withItem(layout, "table-consignee_ref", (item) => (item.kind === "table" ? { ...item, heading: "Your PO:" } : item));
      const { pdf } = await renderBol(sampleBol(), bolCfg(typed));
      expect(Math.abs(runTop(pdf, "Your") - runTop(pdf, "DEMO-"))).toBeLessThan(1);
      expect(linesOn(pdf).some((l) => l.text.includes("Consignee's Ref/PO No."))).toBe(false);
    });

    it("every PO blank prints one line; blank POs among typed ones leave no empty entry", async () => {
      const typed = await renderBol(sampleBol({ poNumbers: ["PT1"] }), bolCfg(layout));
      const blank = await renderBol(sampleBol({ poNumbers: ["", ""] }), bolCfg(layout));
      const height = (r: typeof typed) => at(r.group, CANVAS_IDS.end("consignee_ref")).top - block.y;
      expect(height(blank)).toBeCloseTo(height(typed), 6);
      expect(horizontals(blank.pdf).filter((h) => h.y > block.y && h.y < block.y + 14)).toHaveLength(1);
      const mixed = await renderBol(sampleBol({ poNumbers: ["PT1", "", "PT3"] }), bolCfg(layout));
      expect(lineWith(mixed.pdf, "PT1").text).toBe("PT1, PT3");
      expect(Math.abs(runTop(mixed.pdf, "Consignee's") - runTop(mixed.pdf, "PT1"))).toBeLessThan(1);
    });
  });

  it("the items below each block ride its rendered bottom: a longer PO list moves them down by its extra lines", async () => {
    const layout = standardBolLayout();
    const runs = await Promise.all([1, 5, 40].map((n) => renderBol(bolOrders(n), bolCfg(layout))));
    const ends = runs.map((r) => at(r.group, CANVAS_IDS.end("consignee_ref")).top);
    // Five seven-character POs wrap past one line on the 130 pt rule; forty wrap further.
    expect(ends[1] - ends[0]).toBeGreaterThan(5);
    expect(ends[2] - ends[1]).toBeGreaterThan(5);
    const scac = layout.items.find((item) => item.id === "field-scac_code")!.box;
    const delivering = layout.items.find((item) => item.id === "field-delivering_carrier")!.box;
    for (const r of runs) {
      // The SCAC code's line, drawn 4 below the PO block, inside its box at that block's bottom.
      const scacLine = runTop(r.pdf, "GFMC") - at(r.group, CANVAS_IDS.end("consignee_ref")).top;
      expect(scacLine).toBeGreaterThan(scac.y);
      expect(scacLine).toBeLessThan(scac.y + scac.h + 2);
      expect(scacLine).toBeCloseTo(runTop(runs[0].pdf, "GFMC") - ends[0], 2);
      // The delivering carrier rides the TRV block's bottom.
      const deliveringLine = runTop(r.pdf, "Delivering") - at(r.group, CANVAS_IDS.end("trv")).top;
      expect(deliveringLine).toBeGreaterThan(delivering.y);
      expect(deliveringLine).toBeLessThan(delivering.y + delivering.h + 2);
      expect(deliveringLine).toBeCloseTo(runTop(runs[0].pdf, "Delivering") - at(runs[0].group, CANVAS_IDS.end("trv")).top, 2);
    }
    // The TRV block prints no rule under its list (on a canvas that rule is a static).
    for (const r of runs) {
      const from = at(r.group, CANVAS_IDS.regionEnd("consignee_ref")).top;
      const to = at(r.group, CANVAS_IDS.end("trv")).top;
      // A stroke starting at the block's left edge (the consigned-to item's street rule, which outgrows
      // its 12 pt box in the fixture and runs into this span, starts past its label column).
      expect(horizontals(r.pdf).filter((h) => h.y > from - 0.5 && h.y < to + 0.5 && Math.abs(h.x - 24) < 0.5)).toEqual([]);
    }
  });

  it("the notes ride the freight block's bottom, the taller of its table and its sidebar", async () => {
    const layout = standardBolLayout();
    // The water-carrier note's first line, read by a word no other wording on the sheet prints.
    const water = "ports";
    expect(BOL_CONTRACT.textBlocks.filter((t) => t.defaultText.includes(` ${water} `)).map((t) => t.key)).toEqual(["bol_water_note"]);
    const variants = await Promise.all([
      sampleBol(),
      sampleBol({ freightDescription: "Manufactured Castings I/S, heat treated and tempered" }),
      sampleBol({ freightDescription: "Castings ".repeat(90).trim() }),
    ].map((d) => renderBol(d, bolCfg(layout))));
    const heights = variants.map((r) => at(r.group, CANVAS_IDS.end("freight")).top - at(r.group, CANVAS_IDS.regionEnd("trv")).top);
    // A short description leaves the sidebar deciding; one long enough to pass it moves the bottom.
    expect(heights[1]).toBeCloseTo(heights[0], 6);
    expect(heights[2] - heights[0]).toBeGreaterThan(20);
    const offsets = variants.map((r) => runTop(r.pdf, water) - at(r.group, CANVAS_IDS.end("freight")).top);
    for (const offset of offsets) expect(offset).toBeCloseTo(offsets[0], 2);
  });

  describe("the freight block", () => {
    /** The standard layout with the freight block drawn at x 24 and `w` wide, its fixed columns set
     *  narrow enough for a 400 pt block to hold them (the contract's 188 pt of fixed columns and their
     *  padding pass the 222 pt a 400 pt block leaves its table, and pdfmake then widens the `"*"`
     *  column past the table's width). */
    const freightAt = (w: number, change: (item: Extract<CanvasItem, { kind: "table" }>) => Partial<Extract<CanvasItem, { kind: "table" }>> = () => ({})) =>
      withItem(standardBolLayout(), "table-freight", (item) => item.kind !== "table" ? item : {
        ...item,
        box: { ...item.box, x: 24, w },
        columns: item.columns.map((column) => (column.key === "freight_description" || column.key === "collect_checkbox"
          ? column : { ...column, width: 20 })),
        ...change(item),
      });
    /** The table's vertical rules left of the sidebar, between the block's top and its bottom. */
    const tableUprights = async (w: number) => {
      const r = await renderBol(sampleBol(), bolCfg(freightAt(w)));
      const top = at(r.group, CANVAS_IDS.table("freight")).top - 2;
      const end = at(r.group, CANVAS_IDS.end("freight")).top;
      const xs = [...new Set(verticals(r.pdf).filter((v) => v.from >= top && v.to <= end && v.x < 24 + w - W.sidebar)
        .map((v) => Math.round(v.x * 100) / 100))].sort((a, b) => a - b);
      return { r, xs };
    };

    it("drawn 400 wide, the table takes the drawn width less 178 and its description resolves against it; the sidebar sits at the block's right less 170", async () => {
      const narrow = await tableUprights(400);
      const full = await tableUprights(564);
      // Five columns: six uprights, the outer ones at the block's left and the table's right
      // (the block's x plus its width less the sidebar and its gap), each a half rule inside.
      expect(narrow.xs).toHaveLength(6);
      expect(narrow.xs[0]).toBeCloseTo(24 + 0.4, 1);
      expect(narrow.xs[5]).toBeCloseTo(24 + 400 - W.sidebar - W.sidebarGap - 0.4, 1);
      expect(full.xs[5]).toBeCloseTo(24 + 564 - W.sidebar - W.sidebarGap - 0.4, 1);
      // The description (the second column) alone takes the 164 pt the two widths differ by.
      const columnWidths = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i]);
      const [a, b] = [columnWidths(narrow.xs), columnWidths(full.xs)];
      expect(b[1] - a[1]).toBeCloseTo(164, 1);
      for (const i of [0, 2, 3, 4]) expect(b[i]).toBeCloseTo(a[i], 2);
      // The sidebar's rows start at the block's right less 170 and end 160 pt on (each rule beside its
      // label since owner ruling R1, 2026-11-24): every rule that ends there starts inside the row.
      const rowEnd = 24 + 400 - W.sidebar + 160;
      const sideRules = horizontals(narrow.r.pdf).filter((h) => Math.abs(h.x + h.length - rowEnd) < 0.01);
      expect(sideRules).toHaveLength(5);
      for (const rule of sideRules) expect(rule.x).toBeGreaterThan(24 + 400 - W.sidebar);
    });

    it("a COLLECT shipment's box sits in its 14 pt column at the block's right: 574.4 and 587.6 at 564 (#557)", async () => {
      const uprights = async (w: number) => {
        const r = await renderBol(sampleBol({ freightTerms: "COLLECT" }), bolCfg(freightAt(w)));
        const right = 24 + w;
        return verticals(r.pdf).filter((v) => v.x > right - BOL_COLLECT_BOX.column - 1 && v.x < right + 1)
          .map((v) => Math.round(v.x * 100) / 100).sort((p, q) => p - q);
      };
      const half = BOL_COLLECT_BOX.ruleWidth / 2;
      for (const w of [400, 564]) {
        const right = 24 + w;
        expect(await uprights(w)).toEqual([
          Math.round((right - BOL_COLLECT_BOX.column + half) * 100) / 100, Math.round((right - half) * 100) / 100,
        ]);
      }
      expect(await uprights(564)).toEqual([574.4, 587.6]);
    });

    it("the toggle hidden drops the box and its caption; every column hidden still prints the sidebar; the weight cell prints lb and its word in #444444", async () => {
      const hidden = await renderBol(sampleBol({ freightTerms: "COLLECT" }), bolCfg(freightAt(564, (item) => ({
        columns: item.columns.map((column) => (column.key === "collect_checkbox" ? { ...column, visible: false } : column)),
      }))));
      const text = linesOn(hidden.pdf).map((l) => l.text).join("\n");
      expect(text).not.toContain("Freight charges are PREPAID unless marked collect.");
      expect(text).not.toContain("CHECK BOX IF COLLECT");
      expect(verticals(hidden.pdf).filter((v) => v.x > 588 - BOL_COLLECT_BOX.column - 1)).toEqual([]);
      const shown = await renderBol(sampleBol(), bolCfg(freightAt(564)));
      expect(linesOn(shown.pdf).map((l) => l.text).join("\n")).toContain("Freight charges are PREPAID unless marked collect.");

      const none = await renderBol(sampleBol(), bolCfg(freightAt(564, (item) => ({
        columns: item.columns.map((column) => ({ ...column, visible: false })),
      }))));
      const noneText = linesOn(none.pdf).map((l) => l.text).join("\n");
      expect(noneText).toContain("RECEIVED $");
      expect(noneText).not.toContain("No. Packages");
      expect(verticals(none.pdf).filter((v) => v.x < 588 - W.sidebar)).toEqual([]);

      // At the contract's own column widths, the weight cell prints the figure with its unit and the
      // net word in grey (the shipment has no container, so no gross).
      const standard = await renderBol(sampleBol(), bolCfg(standardBolLayout()));
      expect(lineWith(standard.pdf, "11,415").text).toContain("11,415 lb");
      expect(lineWith(standard.pdf, NET_WEIGHT).text.startsWith(NET_WEIGHT)).toBe(true);
      const def = buildBolDefinition(sampleBol(), bolCfg(standardBolLayout()));
      expect(nodesOf(def).filter((n) => n.text === NET_WEIGHT && n.color === "#444444")).toHaveLength(1);
      // With every order's containers carrying a tare each, the shipment has a gross: the cell prints
      // it and the gross word in grey, and no net word.
      const grossBol = sampleBol({ orders: [{ lineWeights: [11415], containers: [{ count: 3, tareEach: 42.5 }] }] });
      const gross = await renderBol(grossBol, bolCfg(standardBolLayout()));
      expect(lineWith(gross.pdf, "11,542.5").text).toContain("11,542.5 lb");
      expect(lineWith(gross.pdf, "Gross weight").text.startsWith("Gross weight")).toBe(true);
      const grossDef = buildBolDefinition(grossBol, bolCfg(standardBolLayout()));
      expect(nodesOf(grossDef).filter((n) => n.text === "Gross weight" && n.color === "#444444")).toHaveLength(1);
      expect(nodesOf(grossDef).filter((n) => n.text === NET_WEIGHT)).toEqual([]);
    });
  });

  describe("the TRV block's list wraps (#943, owner ruling (b) of 2026-11-13)", () => {
    const orders = (n: number) => Array.from({ length: n }, (_, i) => 92000 + i);
    /** The TRV block drawn `w` wide at x 24 (the standard layout's place), every other item as it stands. */
    const trvAt = (w: number) => withItem(standardBolLayout(), "table-trv", (item) => (item.kind === "table" ? { ...item, box: { ...item.box, w } } : item));

    // Red on a bare-comma join: the issue measured the block one line tall at 1, 30 and 80 orders
    // (11.133 pt each time), the list running past the right margin; since #971's column clamp the
    // block's column is held to its width and pdfmake breaks the one token between characters, so the
    // list wrapped mid-number ("…92016,92" then "017,92018…") and the whole-number assertion reds.
    it("a long list grows the block by its extra lines at 30 and 80 orders, inside the right margin, every number whole and in order; the delivering carrier rides it", async () => {
      const layout = standardBolLayout();
      const listX = 24 + BOL_WIDTHS.trvLabel;
      const rs = await Promise.all([1, 30, 80].map((n) => renderBol(sampleBol({ orderNumbers: orders(n) }), bolCfg(layout))));
      const ends = rs.map((r) => at(r.group, CANVAS_IDS.end("trv")).top);
      for (const [i, n] of [[1, 30], [2, 80]] as const) {
        const runs = trvListRuns(rs[i].pdf, listX);
        expect(runs.map((r) => r.text)).toEqual(wrappedRuns(orders(n)));
        for (const r of runs) expect(r.end, `"${r.text}" ends at ${r.end}`).toBeLessThanOrEqual(588 + 0.01);
        const lines = trvLines(runs);
        expect(lines.length).toBeGreaterThan(1);
        expect(ends[i] - ends[0]).toBeCloseTo((lines.length - 1) * (lines[0] - lines[1]), 1);
        expect(runTop(rs[i].pdf, "Delivering") - ends[i]).toBeCloseTo(runTop(rs[0].pdf, "Delivering") - ends[0], 2);
      }
    });

    it("drawn 300 wide, a long list wraps inside the block's box", async () => {
      const layout = trvAt(300);
      expect(canvasRefusal(layout, BOL_CONTRACT, { pageFooter: BOL_DEFAULT_CONFIG.pageFooter })).toBeNull();
      const { pdf } = await renderBol(sampleBol({ orderNumbers: orders(30) }), bolCfg(layout));
      const runs = trvListRuns(pdf, 24 + BOL_WIDTHS.trvLabel);
      expect(runs.map((r) => r.text)).toEqual(wrappedRuns(orders(30)));
      for (const r of runs) expect(r.end, `"${r.text}" ends at ${r.end}`).toBeLessThanOrEqual(24 + 300 + 0.01);
      expect(trvLines(runs).length).toBeGreaterThan(3);
    });

    // Green on both joins (it pins "unchanged"); a join with ", " reds it.
    it("a short list prints on one line at today's place and width", async () => {
      const { pdf } = await renderBol(sampleBol({ orderNumbers: orders(3) }), bolCfg(standardBolLayout()));
      const listX = 24 + BOL_WIDTHS.trvLabel;
      const runs = trvListRuns(pdf, listX);
      expect(trvLines(runs)).toHaveLength(1);
      expect(runs[0].x).toBeCloseTo(listX, 3);
      expect(runs.map((r) => r.text).join("")).toBe("92000,92001,92002");
      expect(runs.at(-1)!.end).toBeCloseTo(listX + textWidthOf("92000,92001,92002", "Roboto", "bold", 9.5), 2);
    });
  });

  it("160 orders page: page 2 repeats the BOL number with (continued); with the page line on, Page 2 of N under every body line", async () => {
    const layout = standardBolLayout();
    const label = labelOf(BOL_CONTRACT, layout.items.find((item) => item.id === "field-bol_number") as Extract<CanvasItem, { kind: "field" }>);
    for (const pageFooter of [false, true]) {
      const { pdf } = await renderBol(bolOrders(160), bolCfg(layout, { pageFooter }));
      const pages = pageCount(pdf);
      expect(pages).toBeGreaterThanOrEqual(2);
      const band = linesOn(pdf, 2).filter((l) => l.top < topMargin(layout));
      // The repeated item prints its label beside its number on its rule (two baselines a fraction
      // apart, joined here with no space): the flow's band reads `${label} 92795`.
      expect(band.map((l) => l.text).join("").replace(/\s+/g, "")).toContain(`${label}92795`.replace(/\s+/g, ""));
      const continued = band.filter((l) => l.text.includes("(continued)"));
      expect(continued).toHaveLength(1);
      const box = continuedBox(layout)!;
      expect(continued[0].top).toBeGreaterThan(box.y);
      expect(continued[0].top).toBeLessThan(box.y + box.h);
      expect(linesOn(pdf, 1).some((l) => l.text.includes("(continued)"))).toBe(false);
      const pageLines = linesOn(pdf, 2).filter((l) => l.text.startsWith("Page "));
      if (!pageFooter) { expect(pageLines).toEqual([]); continue; }
      expect(pageLines.map((l) => l.text)).toEqual([`Page 2 of ${pages}`]);
      expect(pageLines[0].top).toBeGreaterThan(pageFoot(true));
      for (const line of linesOn(pdf, 2)) if (line !== pageLines[0] && !line.text.startsWith("Page ")) expect(line.top).toBeLessThan(pageLines[0].top);
      for (const stroke of strokedLines(pdf)[1]) expect(Math.max(stroke.y1, stroke.y2)).toBeLessThanOrEqual(pageFoot(true) + 0.5);
    }
  });

  it("a page-bottom Text item whose words run past the band's foot is cut at the band's bottom edge, whole lines, with the page line off and on (#978)", async () => {
    // Red when the band's footer frame is not ended at the band's bottom edge (render.ts's
    // `installBandFrame` wrapper): the item's overflow then prints below the edge, in the page's
    // bottom margin, and with the page line on over and under it.
    for (const pageFooter of [false, true]) {
      const layout = bandClipLayout(standardBolLayout(), pageFooter);
      expect(canvasRefusal(layout, BOL_CONTRACT, { pageFooter }), `page line ${pageFooter}`).toBeNull();
      const { pdf } = await renderBol(sampleBol(), bolCfg(layout, { pageFooter }));
      expect(pageCount(pdf), `page line ${pageFooter}`).toBe(1);
      expectBandClip(pdf, pageFooter);
    }
  });

  describe("a narrowed block that pages (#969)", () => {
    /** The standard layout with one block redrawn at `box`. */
    const drawnAt = (key: (typeof BLOCKS)[number], box: { x: number; w: number }) =>
      withItem(standardBolLayout(), `table-${key}`, (item) => ({ ...item, box: { ...item.box, ...box } }) as CanvasItem);
    /** Every page's non-blank runs starting past the content's right edge, and strokes ending past it. */
    const pastTheMargin = (pdf: Buffer) => ({
      runs: textRunsWithY(pdf).flatMap((runs, p) => runs.filter((r) => r.text.trim() !== "" && r.x > 588)
        .map((r) => `${p + 1}:${r.text.trim()}@${r.x.toFixed(2)}`)),
      strokes: strokedLines(pdf).flatMap((strokes, p) => strokes.filter((s) => Math.max(s.x1, s.x2) > 588.5)
        .map((s) => `${p + 1}:${Math.min(s.x1, s.x2).toFixed(1)}..${Math.max(s.x1, s.x2).toFixed(1)}`)),
    });
    /** The freight sidebar's "RECEIVED $" runs (the bill's own "RECEIVED, subject to …" run is another),
     *  each with its page. */
    const sidebarReceived = (pdf: Buffer) => textRunsWithY(pdf)
      .flatMap((runs, p) => runs.filter((r) => r.text.trim() === "RECEIVED").map((r) => ({ page: p + 1, x: r.x })));

    it("a narrowed consignee ref or freight block that pages prints nothing past the margin, and the blocks after it at their full-width place", async () => {
      const pos1500 = sampleBol({ poNumbers: Array.from({ length: 1500 }, (_, i) => `PO${10000 + i}`), orderNumbers: [91955] });
      const words400 = sampleBol({ freightDescription: "Castings ".repeat(400).trim() });
      for (const pageFooter of [false, true]) {
        // The consignee ref drawn 40 pt in on each side, and at the standard layout's own 338/244: each
        // breaks across a page, and the freight block after it keeps its sidebar at the full-width
        // block's right less 170 (418), as before the break.
        for (const box of [{ x: 64, w: 484 }, { x: 338, w: 244 }]) {
          const { pdf, group } = await renderBol(pos1500, bolCfg(drawnAt("consignee_ref", box), { pageFooter }));
          const end = at(group, CANVAS_IDS.end("consignee_ref")).page;
          expect(end, `${box.x}/${box.w}: the block breaks`).toBeGreaterThan(at(group, CANVAS_IDS.table("consignee_ref")).page);
          expect(pastTheMargin(pdf), `${box.x}/${box.w}`).toEqual({ runs: [], strokes: [] });
          const received = sidebarReceived(pdf);
          expect(received.filter((r) => r.page >= end), `${box.x}/${box.w}: the sidebar after the break`).not.toEqual([]);
          for (const r of received) expect(Math.abs(r.x - (588 - W.sidebar)), `${box.x}/${box.w} p${r.page}`).toBeLessThan(0.5);
        }
        // The freight block drawn 40 pt in, paging. It is the last block and nothing width-dependent
        // follows it, so this is a no-past-margin check only (no shape mutation can red it).
        const { pdf, group } = await renderBol(words400, bolCfg(drawnAt("freight", { x: 64, w: 484 }), { pageFooter }));
        expect(at(group, CANVAS_IDS.end("freight")).page, "the freight block breaks").toBeGreaterThan(at(group, CANVAS_IDS.table("freight")).page);
        expect(pastTheMargin(pdf)).toEqual({ runs: [], strokes: [] });
      }
    }, 120_000);
  });

  it("a raw config omitting a sidebar wording prints the contract's text, as the flow's belt does", async () => {
    const config = bolCfg(standardBolLayout());
    const textBlocks = { ...config.textBlocks };
    delete textBlocks.bol_imprint_text;
    const flow = textLinesWithY(await renderPdf(buildBolDefinition(sampleBol(), { ...structuredClone(BOL_DEFAULT_CONFIG), textBlocks })))[0];
    const { pdf, group } = await renderBol(sampleBol(), { ...config, textBlocks });
    // The canvas printed it: the freight block's own end mark is laid out.
    expect(at(group, CANVAS_IDS.end("freight")).page).toBe(1);
    const imprint = BOL_CONTRACT.textBlocks.find((t) => t.key === "bol_imprint_text")!.defaultText;
    const first = imprint.split(" ").slice(0, 3).join(" ");
    expect(flow.some((l) => l.text.startsWith(first))).toBe(true);
    expect(linesOn(pdf).some((l) => l.text.startsWith(first))).toBe(true);
    expect(linesOn(pdf).some((l) => l.text.includes("undefined"))).toBe(false);
  });

  it("a raw config omitting a placeable wording prints the contract's text in its item, as the flow does", () => {
    const config = bolCfg(layoutOf([bolTable("freight", { anchor: { kind: "page-top" } }), bolTextBlock("bol_water_note")]));
    const textBlocks = { ...config.textBlocks };
    delete textBlocks.bol_water_note;
    const def = buildBolDefinition(sampleBol(), { ...config, textBlocks });
    const water = BOL_CONTRACT.textBlocks.find((t) => t.key === "bol_water_note")!.defaultText;
    expect(water.length).toBeGreaterThan(0);
    expect(nodesOf(def).filter((n) => n.text === water)).toHaveLength(1);
  });

  it("the lens: a layout holding the field-keyed PO block prints, the block never handed to sectionView", async () => {
    const layout = layoutOf([bolTable("consignee_ref")]);
    const block = layout.items[0].box;
    const { pdf, group } = await renderBol(sampleBol(), bolCfg(layout));
    // The block alone, at its drawn place: its label's first run at its x.
    expect(Math.abs(at(group, CANVAS_IDS.table("consignee_ref")).top - block.y)).toBeLessThan(2);
    expect(textRunsWithY(pdf)[0].find((r) => r.text.startsWith("Consignee's"))!.x).toBeCloseTo(block.x, 2);
    expect(lineWith(pdf, "Consignee's Ref/PO No.").text).toBe("Consignee's Ref/PO No.");
    expect(lineWith(pdf, "DEMO-PO-24115").text).toBe("DEMO-PO-24115, PT24116");
  });

  it("the lens: the TRV block's typed heading reaches the list it prints, in place of the contract's", async () => {
    // The block is section-keyed, so its heading reaches `trvLine` only through the lens's section
    // view (`canvasCtx`); a lens that dropped the block would print the contract's "TRV NO.".
    const layout = withItem(standardBolLayout(), "table-trv", (item) => (item.kind === "table" ? { ...item, heading: "ORDERS:" } : item));
    const { pdf } = await renderBol(sampleBol(), bolCfg(layout));
    expect(lineWith(pdf, "ORDERS:").text.startsWith("ORDERS:")).toBe(true);
    expect(linesOn(pdf).some((l) => l.text.includes("TRV NO."))).toBe(false);
  });

  it("bolCanvasItemContent answers the sheet's item node for a canvas config and refuses a flow config", () => {
    const config = bolCfg(standardBolLayout());
    const content = bolCanvasItemContent(sampleBol(), config);
    expect(content(bolField("pro_number", { box: { x: 24, y: 24, w: 244, h: 12 } }))).not.toBeNull();
    expect(() => bolCanvasItemContent(sampleBol(), bolCfg(null))).toThrow("bolCanvasItemContent needs a canvas config.");
  });

  it("a flow builder answering more than one node for a block is refused by name", () => {
    const a: Content = { text: "A" };
    const b: Content = { text: "B" };
    const layout = layoutOf([bolTable("freight", { anchor: { kind: "page-top" } })]);
    expect(() => buildCanvasBolDefinition(sampleBol(), bolCfg(layout), layout, { ...BOL_FLOW, freightBlock: () => [a, b] }))
      .toThrow("A bill of lading block answers one node; freight answered 2.");
    // One node prints (the neighbouring case, so the refusal above is the count's).
    expect(() => buildCanvasBolDefinition(sampleBol(), bolCfg(layout), layout, { ...BOL_FLOW, freightBlock: () => [a] })).not.toThrow();
  });
});

// ------------------------------------------------------------------------------------------------
// The print path: a published canvas template with a Logo item and `config.logo` null (Task 4).
// ------------------------------------------------------------------------------------------------

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

let seq = 0;
async function makeCustomer(): Promise<Customer> {
  seq += 1;
  return prisma.customer.create({ data: { code: `BC${seq}`, name: `BOL Canvas Customer ${seq}` } });
}

/** A one-order shipment for `customer`: one part, one order, its line shipped whole. */
async function oneOrderShipment(customer: Customer) {
  seq += 1;
  const part = await prisma.part.create({
    data: { customerId: customer.id, partNumber: `BCP-${seq}`, name: `Canvas Part ${seq}`, description: "I/S", eachWeight: "21.5000" },
  });
  const code = await prisma.processStepCode.create({ data: { code: `BC-${part.id}`, name: "Normalize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({ data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Normalize at 1600F." } });
  const address = await prisma.customerAddress.create({
    data: {
      customerId: customer.id, kind: "SHIP_TO", name: "Example Coating", street: "400 Demo Drive",
      city: "Birmingham", state: "AL", zip: "35217", isDefault: true,
    },
  });
  const { order }: { order: OrderDetail } = await asSystem(() => createOrder({
    customerId: customer.id, poNumber: "CANVAS-PO-1", lines: [{ partId: part.id, qty: 192, weight: "4128.00" }],
  }));
  const { shipper } = await asSystem(() => createShipper({
    customerId: customer.id, shipDate: "2026-07-06", shipToAddressId: address.id,
    freightDescription: "Manufactured Castings I/S", freightClass: "70",
    orders: [{
      orderId: order.id,
      lines: [{ orderLineId: order.lines[0].id, qty: order.lines[0].qty, weight: order.lines[0].weight, lineComplete: true }],
      containers: [], serials: [],
    }],
  }, { canOverrideCreditHold: false }));
  return shipper;
}

/**
 * A shipment of `n` orders for `customer` on the shape the timing cases use (the ticket's
 * `bigShipment`, tests/shipping-ticket-canvas.test.ts): one part, one order a PO, each order's one
 * line shipped whole; freight COLLECT with a carrier, a pro number and a SCAC code, so every item of
 * the paper prints.
 */
async function bigShipment(customer: Customer, n: number) {
  seq += 1;
  const part = await prisma.part.create({
    data: { customerId: customer.id, partNumber: `BIG-${seq}`, name: `Timing Part ${seq}`, description: "I/S", eachWeight: "21.5000" },
  });
  const code = await prisma.processStepCode.create({ data: { code: `BIG-${part.id}`, name: "Normalize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({ data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Normalize at 1600F." } });
  const address = await prisma.customerAddress.create({
    data: {
      customerId: customer.id, kind: "SHIP_TO", name: "Example Coating", street: "400 Demo Drive",
      city: "Birmingham", state: "AL", zip: "35217", isDefault: true,
    },
  });
  const carrier = await prisma.carrier.create({ data: { name: `Demo Foundry Truck ${seq}` } });
  const shipped: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const { order }: { order: OrderDetail } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: `BIG-PO-${seq}-${i + 1}`, lines: [{ partId: part.id, qty: 192, weight: "4128.00" }],
    }));
    shipped.push({
      orderId: order.id,
      lines: [{ orderLineId: order.lines[0].id, qty: order.lines[0].qty, weight: order.lines[0].weight, lineComplete: true }],
      containers: [], serials: [],
    });
  }
  const { shipper } = await asSystem(() => createShipper({
    customerId: customer.id, shipDate: "2026-07-06", shipToAddressId: address.id, carrierId: carrier.id,
    freightTerms: "COLLECT", proNumber: "PRO-4471", scacCode: "GFMC",
    freightDescription: "Manufactured Castings I/S", freightClass: "70", orders: shipped,
  }, { canOverrideCreditHold: false }));
  return shipper;
}

/** `print` timed around the whole call, with the stored document's page count. */
async function timed(print: () => Promise<{ documentId: string; bolNumber: number; pdf: Buffer }>) {
  const started = performance.now();
  const result = await asSystem(print);
  return { ...result, ms: Math.round(performance.now() - started), pages: pageCount(result.pdf) };
}

describe("printBol with a canvas template", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("prints the canvas with its Logo item painted (config.logo null), stamps the version, allocates once and keeps the number on a reprint", async () => {
    const customer = await makeCustomer();
    // A Logo item below the freight block, clear of the shipper's signature and the post-office
    // address (both 24..224 across), so the rules refuse nothing and the refusal is not the gate's.
    const layout = layoutOf([
      ...standardBolLayout().items,
      logo({ anchor: { kind: "below-table", table: "freight" }, box: { x: 400, y: 32, w: 44, h: 44 } }),
    ]);
    expect(canvasRefusal(layout, BOL_CONTRACT, { pageFooter: BOL_DEFAULT_CONFIG.pageFooter })).toBeNull();
    const t = await asSystem(() => createTemplate("BOL", "Canvas BOL"));
    const config: TemplateConfig = { ...structuredClone(BOL_DEFAULT_CONFIG), logo: null, layout };
    await asSystem(() => editDraft(t.id, { config, updatedAt: t.draft.updatedAt }));
    await asSystem(() => uploadLogo(t.id, tinyAlphaPng(), "image/png"));
    const { versionId } = await asSystem(() => publishDraft(t.id));
    await asSystem(() => assignTemplate(customer.id, "BOL", t.id));

    const shipper = await oneOrderShipment(customer);
    expect((await prisma.shipper.findUniqueOrThrow({ where: { id: shipper.id } })).bolNumber).toBeNull();
    const first = await asSystem(() => printBol(shipper.id));
    const allocated = (await prisma.shipper.findUniqueOrThrow({ where: { id: shipper.id } })).bolNumber;
    expect(allocated).not.toBeNull();
    expect(first.bolNumber).toBe(allocated);
    const reprint = await asSystem(() => printBol(shipper.id));
    expect(reprint.bolNumber).toBe(first.bolNumber);
    expect(reprint.documentId).not.toBe(first.documentId);

    for (const { documentId } of [first, reprint]) {
      const stored = await prisma.storedDocument.findUniqueOrThrow({ where: { id: documentId } });
      expect(stored.templateVersionId).toBe(versionId);
      const bytes = Buffer.from(stored.fileData);
      expect(pageCount(bytes)).toBe(1);
      // One image: the canvas's Logo item (the flow, with `config.logo` null, paints none).
      expect(paintedImageCounts(bytes)).toEqual([1]);
      expect(drawnText(bytes)).toContain(String(first.bolNumber));
    }
  });

  // The print's budget (design 2026-11-09 §5.4; BOL canvas PR 2, Task 7). Run on purpose, on mains at
  // the Performance profile with both runner slots paused:
  // CANVAS_TIMING=1 npx vitest run tests/bol-canvas.test.ts -t "CANVAS timing" --reporter=verbose --silent=false
  // No time is asserted: every figure is logged for the controller to read against the plan's 2.5 s.
  it.skipIf(process.env.CANVAS_TIMING !== "1")("CANVAS timing: a 40- and an 80-order canvas bill of lading print through printBol", async () => {
    // The flow Standard prints for a customer with nothing assigned; the canvas for one whose BOL is
    // the seeded Standard, so each canvas shipment's first print is the one that allocates.
    const flowCustomer = await makeCustomer();
    const canvasCustomer = await makeCustomer();
    // The seed's shipment has the timed shipments' shape (COLLECT, a carrier, a pro and a SCAC code).
    const small = await bigShipment(canvasCustomer, 1);
    const layout = await asSystem(() => seedBolLayout(small.id, structuredClone(BOL_DEFAULT_CONFIG), undefined));
    const t = await asSystem(() => createTemplate("BOL", "Canvas timing BOL"));
    const config = validateConfig("BOL", { ...structuredClone(BOL_DEFAULT_CONFIG), layout });
    await asSystem(() => editDraft(t.id, { config, updatedAt: t.draft.updatedAt }));
    const { versionId } = await asSystem(() => publishDraft(t.id));
    await asSystem(() => assignTemplate(canvasCustomer.id, "BOL", t.id));

    for (const n of [40, 80]) {
      const flowShipment = await bigShipment(flowCustomer, n);
      const canvasShipment = await bigShipment(canvasCustomer, n);

      const flow = await timed(() => printBol(flowShipment.id));
      const flowReprint = await timed(() => printBol(flowShipment.id));
      expect((await prisma.shipper.findUniqueOrThrow({ where: { id: canvasShipment.id } })).bolNumber).toBeNull();
      const first = await timed(() => printBol(canvasShipment.id));
      const reprint = await timed(() => printBol(canvasShipment.id));

      console.log(
        `CANVAS timing: ${n} orders; flow first print ${flow.pages} page(s) in ${flow.ms} ms, flow reprint ${flowReprint.pages} page(s) in ${flowReprint.ms} ms; `
        + `canvas first print ${first.pages} page(s) in ${first.ms} ms, canvas reprint ${reprint.pages} page(s) in ${reprint.ms} ms`,
      );
      expect(reprint.bolNumber).toBe(first.bolNumber);
      // The canvas template printed both, the flow Standard neither.
      for (const { documentId } of [first, reprint]) {
        const stamped = await prisma.storedDocument.findUniqueOrThrow({ where: { id: documentId }, select: { templateVersionId: true } });
        expect(stamped.templateVersionId).toBe(versionId);
      }
      for (const { documentId } of [flow, flowReprint]) {
        const stamped = await prisma.storedDocument.findUniqueOrThrow({ where: { id: documentId }, select: { templateVersionId: true } });
        expect(stamped.templateVersionId).not.toBe(versionId);
      }
    }
  }, 600_000);
});
