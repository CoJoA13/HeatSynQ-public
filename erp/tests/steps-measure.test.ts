/**
 * #992: the steps measure (`oversizedRows`, render.ts) lays a steps table out at the width it prints.
 *
 * The measure lays a JSON copy of the steps table out alone on an auto-height page with one sentinel
 * row after the last step, whose start ends the last step's row. Until #992 that row held
 * `{ text: "measure" }` in every column, which entered every column's minimum at 31.027 pt, so a
 * flow steps table whose fixed columns and overhead left the instruction under that was measured at
 * a wider instruction than it printed, and a row taller than a page only at the printed width was
 * called fine, kept whole under `dontBreakRows`, and printed on no page. The sentinel is now one
 * empty text in every column: it enters no column's minimum or maximum (owner ruling 2026-11-15).
 *
 * The measure's calls are read through `logColumnWidths` and told apart by shape (`isStepsMeasure`,
 * tests/helpers/column-log.ts), never by the sentinel's words, so each case finds the measure on the
 * base as after the fix and is red there for its widths alone. Every case pins that it found exactly
 * one measure, or each comparison would pass over nothing.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/practice-mode", () => ({ practiceMode: vi.fn().mockResolvedValue(false) }));

import { TRAVELER_DEFAULT_CONFIG, validateConfig, type TemplateConfig } from "@/lib/template-contracts/index";
import type { CanvasLayout } from "@/lib/template-contracts/canvas";
import { buildTravelerDefinitions, type TravelerData, type TravelerStep } from "@/server/traveler";
import { LAYOUT, barcodePng, pngDataUri, renderSheetGroups } from "@/server/pdf/render";
import { layoutOf, standardLayout } from "./helpers/canvas-fixtures";
import { STEPS_LAYOUT, isStepsMeasure, logColumnWidths, type ColumnEvent } from "./helpers/column-log";
import { drawnText, pageCount } from "./helpers/pdf";

const BARCODE = pngDataUri(await barcodePng("99201"));

/** "measure" at the traveler's 8 pt base size, the minimum the old sentinel entered (#971 design §5.5). */
const OLD_SENTINEL_MIN = 31.027;

function travelerData(steps: TravelerStep[]): TravelerData {
  return {
    orderNumber: 99201, poNumber: "", customerName: "Demo Castings Group",
    receivedFrom: ["200 Demo Drive", "Anniston, AL 36206"], customerPhone: "",
    company: { name: "Example Heat Treating", address: "1 Furnace Rd", phone: "256-555-0101" },
    lines: [{ qty: 10, partNumber: "DEMO-10", partName: "Demo Part", description: "Fixture", eachWeight: 2, lineWeight: 20 }],
    orderQty: 10, containers: [], materialName: "Ductile Iron", processId: "DEMO-10",
    inspections: [], revisionNumber: 1, steps,
    sheets: [{ loadNumber: 1, loadQty: 10, loadWeight: 20, barcodeDataUri: BARCODE }],
    processName: "Austemper",
  };
}

/** Three ordinary steps of different heights: one line, typed values above two lines, a blank line. */
const ORDINARY: TravelerStep[] = [
  { position: 1, codeName: "Preheat", instruction: "Warm the furnace to the setpoint.", values: [] },
  { position: 2, codeName: "Austemper", instruction: "Hold at temperature, then quench in the marked tank before handling.",
    values: [{ label: "Furnace Temp", value: "1650", unit: "°F" }, { label: "Soak", value: "45", unit: "min" }] },
  { position: 3, codeName: "Cool", instruction: "Cool to room temperature.\n\nRecord the time.", values: [] },
];

/** The default flow config with the step code column `code` pt wide (the instruction takes the
 *  rest), through the real validator: a template could store it. */
function flowConfig(code: number): TemplateConfig {
  const config = structuredClone(TRAVELER_DEFAULT_CONFIG);
  const steps = config.sections.find((section) => section.key === "steps")!;
  steps.fields = steps.fields.map((f) => (f.key === "step_code" ? { ...f, width: code } : f));
  return validateConfig("TRAVELER", config);
}

/** The default config with the standard canvas layout, its steps table drawn `w` wide from x 24,
 *  through the real validator. */
function canvasConfig(w: number): TemplateConfig {
  const layout: CanvasLayout = layoutOf(standardLayout().items.map((item) =>
    item.kind === "table" && item.key === "steps" ? { ...item, box: { ...item.box, w } } : item));
  return validateConfig("TRAVELER", { ...structuredClone(TRAVELER_DEFAULT_CONFIG), layout });
}

type Cell = { text?: unknown; positions?: { top: number }[]; stack?: Cell[] } & Record<string, unknown>;
type StepsTable = { layout?: unknown; table: { body: Cell[][] } };

const stepsTableOf = (e: ColumnEvent): StepsTable | null => {
  const t = e.table as StepsTable | undefined;
  return t?.layout === LAYOUT.steps ? t : null;
};

/** The steps measure's call and the steps table's printed calls of one render. */
async function laidOut(data: TravelerData, config: TemplateConfig) {
  const { result: pdf, events } = await logColumnWidths(() => renderSheetGroups(buildTravelerDefinitions(data, config)));
  const measures = events.filter(isStepsMeasure);
  const prints = events.filter((e) => stepsTableOf(e) !== null && !isStepsMeasure(e));
  return { pdf, measures, prints };
}

/** Where each row of a laid-out table starts: its cells' first laid-out line (render.ts `start`). */
function rowStarts(t: StepsTable): number[] {
  return t.table.body.map((row) => {
    const tops: number[] = [];
    const visit = (cell: Cell): void => {
      for (const p of cell.positions ?? []) tops.push(p.top);
      for (const child of cell.stack ?? []) visit(child);
    };
    row.forEach(visit);
    return Math.min(...tops);
  });
}

const INSTRUCTION = 2;
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** The one measure call and every printed call of the steps table, which the case requires. */
async function readings(data: TravelerData, config: TemplateConfig) {
  const { pdf, measures, prints } = await laidOut(data, config);
  expect(measures, "steps measure calls").toHaveLength(1);
  expect(prints.length, "printed steps calls").toBeGreaterThan(0);
  return { pdf, measure: measures[0], prints };
}

it("restates the steps layout's name as render.ts names it", () => {
  expect(STEPS_LAYOUT).toBe(LAYOUT.steps);
});

describe("the steps measure lays a flow steps table out at the width it prints (#992)", () => {
  // The default flow table's fixed columns are 16 + 62 + 34 + 30 + 46 pt and its overhead 25.6, so a
  // 382 pt code column leaves the instruction 30.4 pt (just under "measure"'s 31.027) and a 402 pt
  // one 10.4. Both are configs the validator accepts. On the base the measure laid the instruction
  // out at 31.027 in both: its sentinel row raised the minimum and pdfmake's case 1 took it.
  for (const [code, share] of [[382, 30.4], [402, 10.4]] as const) {
    it(`a ${code} pt code column: the measure's columns are the printed ones, the instruction ${share} pt`, async () => {
      const { measure, prints } = await readings(travelerData(ORDINARY), flowConfig(code));
      expect(r3(prints[0].widths[INSTRUCTION]), "the printed instruction").toBe(share);
      expect(share).toBeLessThan(OLD_SENTINEL_MIN);
      for (const print of prints) expect(measure.widths).toEqual(print.widths);
    });
  }

  it("a row taller than a page only at the printed width is split, every character printed", async () => {
    // At 10.4 pt the instruction prints one W to a line (break-all), so 120 W's are a row taller than
    // a page; at the old sentinel's 31.027 they were four to a line, a row a page holds, so it was
    // kept whole under dontBreakRows and pdfmake printed it on no page: not one W of it drawn.
    const LENGTH = 120;
    const count = (pdf: Buffer): number => (drawnText(pdf).match(/W/g) ?? []).length;
    const step = (instruction: string): TravelerData =>
      travelerData([{ position: 1, codeName: "Preheat", instruction, values: [] }]);
    const config = flowConfig(402);
    const control = await readings(step("Heat the furnace."), config);
    const tall = await readings(step("W".repeat(LENGTH)), config);
    expect(count(tall.pdf) - count(control.pdf)).toBe(LENGTH);
    expect(pageCount(tall.pdf)).toBeGreaterThan(1);
  });
});

describe("the steps measure lays out every steps table whose instruction is over 31.027 pt as it did before #992", () => {
  // The base's readings (74064fa1, the sentinel `{ text: "measure" }`), three ordinary steps: the
  // measure's column widths and each row's start (the header, three steps, the sentinel). A share
  // over 31.027 entered no case 1 the sentinel made, so its widths were the printed ones and its row
  // starts follow from them; the canvas at 218.1 is under the clamp (#971), equal both ways. 381 is
  // the flow's last whole point over the line (31.4 pt); 382 (30.4) is the first under it.
  const BASE: { kind: "flow" | "canvas"; w: number; widths: number[]; starts: number[] }[] = [
    { kind: "flow", w: 62, widths: [16, 62, 350.4, 34, 30, 46], starts: [0, 26.575, 50.575, 83.5, 116.425] },
    { kind: "flow", w: 300, widths: [16, 300, 112.4, 34, 30, 46], starts: [0, 26.575, 50.575, 102.25, 135.175] },
    { kind: "flow", w: 370, widths: [16, 370, 42.4, 34, 30, 46], starts: [0, 26.575, 59.5, 167.425, 228.475] },
    { kind: "flow", w: 381, widths: [16, 381, 31.4, 34, 30, 46], starts: [0, 26.575, 68.875, 204.925, 275.35] },
    { kind: "canvas", w: 564, widths: [16, 62, 350.4, 34, 30, 46], starts: [0, 26.575, 50.575, 83.5, 116.425] },
    { kind: "canvas", w: 300, widths: [16, 62, 86.4, 34, 30, 46], starts: [0, 26.575, 50.575, 102.25, 144.55] },
    { kind: "canvas", w: 250, widths: [16, 62, 36.4, 34, 30, 46], starts: [0, 26.575, 68.875, 195.55, 256.6] },
    { kind: "canvas", w: 218.1, widths: [16, 62, 4.5, 34, 30, 46], starts: [0, 26.575, 293.875, 1095.55, 1447.225] },
  ];
  for (const { kind, w, widths, starts } of BASE) {
    it(`${kind} ${kind === "flow" ? `code column ${w}` : `steps drawn ${w}`} pt wide`, async () => {
      const { measure, prints } = await readings(travelerData(ORDINARY), kind === "flow" ? flowConfig(w) : canvasConfig(w));
      expect(measure.widths.map(r3)).toEqual(widths);
      for (const print of prints) expect(print.widths.map(r3)).toEqual(widths);
      expect(rowStarts(measure.table as StepsTable).map(r3)).toEqual(starts);
    });
  }
});
