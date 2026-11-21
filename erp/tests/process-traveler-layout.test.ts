import { describe, expect, it, vi } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

vi.mock("@/server/practice-mode", () => ({ practiceMode: vi.fn().mockResolvedValue(false) }));

import {
  TRAVELER_CONTRACT,
  TRAVELER_DEFAULT_CONFIG,
  normalizeStoredConfig,
  travelerStepsPrintedWidth,
  validateConfig,
  type TemplateConfig,
} from "@/lib/template-contracts";
import { printedBudgetRefusals } from "@/lib/template-editor";
import { validateContractConfig } from "@/lib/template-contracts/types";
import {
  buildTravelerDefinition,
  buildTravelerDefinitions,
  type TravelerData,
} from "@/server/traveler";
import {
  TRAVELER_STEP_LAYOUT, TRAVELER_STEP_ROW_CONTENT_MIN, TRAVELER_STEP_BOX_CONTENT,
} from "@/lib/template-contracts/traveler";
import {
  DRAFT_PROCESS_PREVIEW_LABEL,
  renderDraftTraveler,
  renderSheetGroups,
  TRAVELER_STEPS_LAYOUT,
} from "@/server/pdf/render";
import { barcodePng, pngDataUri } from "@/server/pdf/render";
import {
  drawnPages, paintedImageCounts, pageCount, parseObjects, strokedLines, textRunsWithY,
} from "./helpers/pdf";
import { measured } from "./helpers/measured";
import { seedLiteral, storedBefore } from "./helpers/stored-configs";
import { ORDER_1031 } from "./helpers/weights-examples";
import { LEFT_COLUMN_RIGHT, RULE, leftColumn } from "./helpers/traveler-header";
import { printedPages } from "../e2e/lib/printed-page.mjs";
import PdfPrinterModule from "pdfmake/js/Printer.js";

const BARCODE = pngDataUri(await barcodePng("70001"));
const LOGO = pngDataUri(await barcodePng("LOGO"));
const REQUIRED = ["step_eq", "step_op", "step_date"];

function config(): TemplateConfig {
  return structuredClone(TRAVELER_DEFAULT_CONFIG);
}

function steps(c: TemplateConfig) {
  return c.sections.find((section) => section.key === "steps")!;
}

function data(instruction = "Heat to the specified temperature."): TravelerData {
  return {
    orderNumber: 70001,
    poNumber: "",
    customerName: "Fictional Foundry",
    receivedFrom: ["100 Example Avenue", "Sample City, AL 35000"],
    customerPhone: "",
    company: { name: "Example Heat Treating", address: "1 Furnace Road", phone: "555-0100" },
    lines: [{ qty: 10, partNumber: "DEMO-10", partName: "Demo Part", description: "Fixture", eachWeight: 2, lineWeight: 20 }],
    orderQty: 10,
    containers: [],
    materialName: "Ductile Iron",
    processId: "DEMO-PROCESS",
    processName: "Austemper",
    inspections: [],
    revisionNumber: 1,
    steps: [{
      position: 1,
      codeName: "Preheat",
      instruction,
      values: [{ label: "Furnace Temp", value: "1100", unit: "F" }],
    }],
    sheets: [{ loadNumber: 1, loadQty: 10, loadWeight: 20, barcodeDataUri: BARCODE }],
  };
}

function tableWithWidths(node: unknown, expected: unknown[]): {
  widths: unknown[]; body: unknown[][]; heights?: unknown; dontBreakRows?: boolean;
} {
  if (node && typeof node === "object") {
    const candidate = node as { table?: { widths?: unknown[]; body?: unknown[][]; heights?: unknown } };
    if (candidate.table?.widths && candidate.table.body &&
        expected.every((width) => candidate.table!.widths!.includes(width))) {
      return candidate.table as {
        widths: unknown[]; body: unknown[][]; heights?: unknown; dontBreakRows?: boolean;
      };
    }
    for (const value of Object.values(node)) {
      try { return tableWithWidths(value, expected); } catch { /* continue */ }
    }
  }
  throw new Error(`No table contains widths ${expected.join(", ")}`);
}

function stepsTableNode(node: unknown): { handwritingColumns?: number[] } {
  if (node && typeof node === "object") {
    if ((node as { layout?: unknown }).layout === "traveler-steps") return node as { handwritingColumns?: number[] };
    for (const value of Object.values(node)) {
      try { return stepsTableNode(value); } catch { /* continue */ }
    }
  }
  throw new Error("No traveler-steps table");
}

function exactLabelDraws(pdf: Buffer): number {
  const hex = Buffer.from(DRAFT_PROCESS_PREVIEW_LABEL, "latin1").toString("hex");
  return [...parseObjects(pdf).values()].reduce((count, obj) =>
    count + ((obj.stream?.toString("latin1").match(new RegExp(hex, "gi")) ?? []).length), 0);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function textValues(node: unknown, out: string[] = []): string[] {
  if (node && typeof node === "object") {
    if ("text" in node && typeof (node as { text?: unknown }).text === "string") {
      out.push((node as { text: string }).text);
    }
    for (const value of Object.values(node)) textValues(value, out);
  } else if (Array.isArray(node)) {
    for (const value of node) textValues(value, out);
  }
  return out;
}

async function verifyRestoredWidthPrint(fixture: TemplateConfig, filename: string): Promise<void> {
  const marked = await renderDraftTraveler(buildTravelerDefinitions(data(), fixture));
  const pages = drawnPages(marked.pdf);
  expect(marked.pageCount).toBe(1);
  expect(pages[0]).toContain("Heat to the specified temperature.");
  const runs = textRunsWithY(marked.pdf)[0];
  for (const label of ["EQ#", "OP", "Date"]) {
    const header = runs.find((run) => run.text === label);
    expect(header, label).toBeDefined();
    expect(header!.x, label).toBeGreaterThanOrEqual(24);
    expect(header!.x, label).toBeLessThan(564);
  }
  const artifactDir = process.env.PROCESS_TRAVELER_LAYOUT_ARTIFACT_DIR;
  if (artifactDir) {
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(path.join(artifactDir, filename), marked.pdf);
  }
}

/**
 * Locates one step's printed row/box geometry on a rendered traveler page, anchored on a text
 * landmark unique to that step (a code name or an instruction/value fragment, matched by
 * substring) instead of a hardcoded page number or pixel position — robust to which page/
 * sheet-group a step's row lands on, and to the exact column widths pdfmake resolves (padding
 * turns out NOT to net out of a pdfmake-declared column width the way a naive
 * `left margin + widths` sum would predict — reason enough to measure the render rather than
 * compute an expected x from the contract's numbers).
 *
 * `strokedLines`' y is the content stream's own top-down coordinate (pdfkit's one page-level
 * flip); `textRunsWithY`'s y is bottom-up device space (an INNER flip composes back for text runs
 * specifically — see that helper's own docstring) — `792 - y` converts a LETTER page's text-run y
 * into the same top-down frame the stroked lines are already in.
 *
 * A landmark need not be globally unique on the page (a step's own process name can echo the
 * "Process:" row above the table) — every matching run is tried, in order, and the first one that
 * resolves to a row carrying at least one handwriting box wins, which a non-step occurrence of the
 * same text never does.
 */
function stepRowGeometry(pdf: Buffer, pageIndex: number, landmark: string): {
  rowGap: number; boxGaps: number[]; boxTopOffsets: number[]; boxLeftOffset: number;
  dividerPresent: boolean;
} {
  const page = strokedLines(pdf)[pageIndex];
  const runs = textRunsWithY(pdf)[pageIndex];
  const horizontals = page.filter((s) => s.y1 === s.y2);
  const verticals = page.filter((s) => s.x1 === s.x2);
  const tableLeftX = Math.min(...horizontals.map((s) => s.x1));
  // The content columns' own row rules: whatever pdfmake resolves the leftmost column (position)
  // to, ITS rule always starts exactly at the table's own left edge — one segment per row
  // boundary, letting header/step boundaries be told apart from every other table's rules (which
  // share the same left edge higher up the page) purely by bracketing on the text landmark below.
  const rowRuleYs = [...new Set(horizontals.filter((s) => s.x1 === tableLeftX).map((s) => s.y1))]
    .sort((a, b) => a - b);

  const candidates = runs.filter((r) => r.text.includes(landmark));
  if (!candidates.length) throw new Error(`"${landmark}" not found on page ${pageIndex + 1}`);
  for (const hit of candidates) {
    const topDownY = 792 - hit.y;
    const top = rowRuleYs.filter((y) => y <= topDownY).at(-1);
    const bottom = rowRuleYs.find((y) => y > topDownY);
    if (top === undefined || bottom === undefined) continue;

    // Each handwriting box's own top/bottom border pair sits well to the right of the content
    // columns (EQ#/OP/Date are the traveler's narrowest, rightmost columns) — clustered by x into
    // (up to) three boxes, each contributing exactly one top/bottom pair within this row's bounds.
    // `rowRuleYs` is gathered from the WHOLE page, so a landmark occurrence outside the steps
    // table (this run's "Austemper" also names the Process: row above it) can bracket some
    // unrelated pair of rules and pick up a stray, incomplete rule from whatever sits between
    // them — that candidate is rejected below, same as an empty bracket, rather than mistaken for
    // a step row with a malformed box.
    const boxLines = horizontals.filter((s) =>
      s.x1 > tableLeftX + 100 && s.y1 > top - 1 && s.y1 < bottom + 1);
    const boxXs = [...new Set(boxLines.map((s) => Math.round(s.x1 * 10) / 10))].sort((a, b) => a - b);
    if (boxXs.length === 0) continue; // not a step row (or the header sits on a different page)
    const boxYPairs = boxXs.map((x) =>
      boxLines.filter((s) => Math.abs(s.x1 - x) < 0.3).map((s) => s.y1).sort((a, b) => a - b));
    if (boxYPairs.some((ys) => ys.length !== 2)) continue; // not a genuine box pair — try the next match

    const boxTops = boxYPairs.map((ys) => ys[0]);
    const boxGaps = boxYPairs.map((ys) => ys[1] - ys[0]);

    // The steps table's content columns (position/code/instruction) each draw their OWN row rule
    // (not merged into one span the way the header's colSpan title cell is) — the rightmost one's
    // own endpoint is exactly "the instruction column's right edge" the first box is claimed to
    // start at.
    const contentRightX = Math.max(
      ...horizontals.filter((s) => s.y1 === top && s.x1 < boxXs[0]).map((s) => s.x2));

    // The one content/handwriting divider (render.ts's TRAVELER_STEPS_LAYOUT.vLineWidth) is a
    // SEPARATE vertical rule from the box's own left border, both landing within about a rule
    // width of the content/box boundary — a real render (measured on both the ordinary and the
    // page-tall-step paths) always draws the divider exactly one rule width (0.8pt) to the LEFT
    // of the box's own left border, never coincident with or right of it, so "a vertical rule
    // strictly left of the box's own detected left edge, within 2pt" is the divider and not a
    // re-detection of the border itself.
    const dividerPresent = verticals.some((s) =>
      s.x1 < boxXs[0] - 0.2 && s.x1 > boxXs[0] - 2 && Math.max(s.y1, top) < Math.min(s.y2, bottom));

    return {
      rowGap: bottom - top, boxGaps, dividerPresent,
      boxTopOffsets: boxTops.map((boxTop) => boxTop - top),
      boxLeftOffset: boxXs[0] - contentRightX,
    };
  }
  throw new Error(`"${landmark}" matched no row with a handwriting box on page ${pageIndex + 1}`);
}

function overflowData(token: string): TravelerData {
  const fixture = data(`First line\n\nOverlong token: ${token}`);
  fixture.steps = Array.from({ length: 28 }, (_, index) => ({
    position: index + 1,
    codeName: index === 0 ? "Preheat" : `Step ${index + 1}`,
    instruction: index === 0
      ? fixture.steps[0].instruction
      : `Fictional operator instruction ${index + 1}.\nRecord the result before proceeding.`,
    values: index === 0 ? fixture.steps[0].values : [],
  }));
  return fixture;
}

/** A fictional traveler sized like the owner's marked-up form (spec §6 fit evidence):
 *  7 steps, 2 lines, 2 containers, 2 inspections. */
function formSized(): TravelerData {
  const base = data();
  return {
    ...base,
    lines: [
      { qty: 2500, partNumber: "DEMO-100", partName: "Ring gear", description: "Machined", eachWeight: 13.5, lineWeight: 33750 },
      { qty: 2000, partNumber: "DEMO-101", partName: "Ring gear, rear", description: "Machined", eachWeight: 13.5, lineWeight: 27000 },
    ],
    orderQty: 4500,
    // The mockup's own figures: 8 drop pans at 367 lb are 2,936, 12 bins at 319 lb are 3,828, and
    // with the 60,750 lb of parts on the two lines the gross is 67,514.
    containers: [
      { typeName: "Drop pan", count: 8, pieces: null, tareEach: 367 },
      { typeName: "Bin", count: 12, pieces: null, tareEach: 319 },
    ],
    inspections: [
      { code: "Hardness", scale: "HBW", min: 269, max: 341, sampleQty: "8", location: "" },
      { code: "Mag particle", scale: null, min: null, max: null, sampleQty: "100%", location: "" },
    ],
    steps: [
      { position: 1, codeName: "Receiving inspection", instruction: "Receiving inspection completed when the shop order is issued.", values: [] },
      { position: 2, codeName: "Racking", instruction: "Load parts lying flat\nX rows of X pieces\nXX layers per basket, XXX pieces per load\n\nJig tag: ________   Quantity: ________", values: [] },
      { position: 3, codeName: "Pre-heat", instruction: "Pre-heat for 1 hour minimum.", values: [{ label: "Temperature", value: "1100", unit: "°F" }] },
      {
        position: 4, codeName: "Austemper",
        instruction: "Water flow: 35 mL / 10 s\n\nTime in: ________   Quench in: ________   Quench out: ________",
        values: [
          { label: "Furnace temp", value: "1650", unit: "°F" }, { label: "Furnace time", value: "120", unit: "min" },
          { label: "Carbon potential", value: "0.85", unit: "%" }, { label: "Quench temp", value: "690", unit: "°F" },
          { label: "Quench time", value: "120", unit: "min" },
        ],
      },
      { position: 5, codeName: "Hot wash", instruction: "Wash parts to remove residual salt.", values: [] },
      { position: 6, codeName: "Final inspection", instruction: "Inspect parts per customer requirements.", values: [] },
      { position: 7, codeName: "Pack", instruction: "Return parts to the containers they were received in.", values: [] },
    ],
  };
}

describe("mandatory traveler handwriting columns", () => {
  it("refuses a newly saved config that hides EQ#, OP, or Date", () => {
    for (const key of REQUIRED) {
      const c = config();
      steps(c).fields.find((field) => field.key === key)!.visible = false;
      expect(() => validateConfig("TRAVELER", c), key).toThrow(/cannot be hidden.*handwriting/i);
    }
  });

  it("normalizes old hidden and omitted fields on read without mutating the stored object", () => {
    const old = config();
    steps(old).fields.find((field) => field.key === "step_eq")!.visible = false;
    steps(old).fields = steps(old).fields.filter((field) => field.key !== "step_op");
    const before = JSON.stringify(old);

    const normalized = normalizeStoredConfig("TRAVELER", old);

    expect(JSON.stringify(old)).toBe(before);
    expect(REQUIRED.map((key) => steps(normalized).fields.find((field) => field.key === key))).toEqual([
      expect.objectContaining({ visible: true, width: null }),
      expect.objectContaining({ visible: true, width: null }),
      expect.objectContaining({ visible: true, width: null }),
    ]);
  });

  it("restores legacy handwriting columns when instruction width used their former budget", async () => {
    const old = config();
    for (const field of steps(old).fields) {
      if (REQUIRED.includes(field.key)) field.visible = false;
      if (field.key === "step_instruction") field.width = 450;
    }
    const before = JSON.stringify(old);
    const restored = normalizeStoredConfig("TRAVELER", old);
    expect(steps(restored).fields.find((field) => field.key === "step_instruction")!.width).toBeNull();
    expect(tableWithWidths(buildTravelerDefinition(data(), old), [16, 62, "*", 34, 30, 46]).widths)
      .toEqual([16, 62, "*", 34, 30, 46]);
    expect(JSON.stringify(old)).toBe(before);
    await verifyRestoredWidthPrint(restored, "traveler-legacy-instruction-draft.pdf");

    // 350 also fits the old numeric-only contract budget AND the restored physical table: 538 pt
    // of column widths + 24 pt padding for the three content columns (position/code/instruction —
    // the EQ#/OP/Date columns carry none) + 1.6 pt for the two rules the DEFAULT order reserves
    // (the divider, plus the outer right edge, which is reserved but not drawn because the Date
    // cells turn their borders off — render.ts's TRAVELER_STEPS_LAYOUT) is 563.6 of the 564 pt
    // available. The case still normalizes to null because the compatibility budget deliberately
    // over-reserves: padding for every column, not just the three content ones, and one rule for
    // every boundary from the first ruled column to the right edge (four), not only the one or
    // two an actual order draws (a reordered template can draw a second rule, e.g. between Date
    // and position; see TRAVELER_STEP_LAYOUT's own docstring for the safe-direction rationale).
    steps(old).fields.find((field) => field.key === "step_instruction")!.width = 350;
    expect(steps(normalizeStoredConfig("TRAVELER", old)).fields
      .find((field) => field.key === "step_instruction")!.width).toBeNull();

    steps(old).fields.find((field) => field.key === "step_instruction")!.width = 300;
    const fitting = normalizeStoredConfig("TRAVELER", old);
    expect(steps(fitting).fields.find((field) => field.key === "step_instruction")!.width).toBe(300);
  });

  it.each([500, 385])("uses step-table defaults when legacy fixed widths leave no usable room (%dpt code)", async (codeWidth) => {
    const old = config();
    for (const field of steps(old).fields) {
      if (REQUIRED.includes(field.key)) field.visible = false;
      if (field.key === "step_code") field.width = codeWidth;
    }
    const before = JSON.stringify(old);
    const restored = normalizeStoredConfig("TRAVELER", old);
    const columns = ["step_position", "step_code", "step_instruction", ...REQUIRED];
    expect(steps(restored).fields.filter((field) => columns.includes(field.key))
      .every((field) => field.width === null)).toBe(true);
    expect(tableWithWidths(buildTravelerDefinition(data(), old), [16, 62, "*", 34, 30, 46]).widths)
      .toEqual([16, 62, "*", 34, 30, 46]);
    expect(JSON.stringify(old)).toBe(before);
    await verifyRestoredWidthPrint(restored, `traveler-legacy-fixed-${codeWidth}-draft.pdf`);
  });

  it("keeps EQ#, OP, and Date in normal order for a direct builder call that bypasses validation", () => {
    const raw = config();
    steps(raw).fields.find((field) => field.key === "step_eq")!.visible = false;
    steps(raw).fields = steps(raw).fields.filter((field) => field.key !== "step_op");

    const table = tableWithWidths(buildTravelerDefinition(data(), raw), [16, 62, "*", 34, 30, 46]);

    expect(table.widths).toEqual([16, 62, "*", 34, 30, 46]);
    expect(JSON.stringify(table.body)).toContain("Heat to the specified temperature.");
    expect(JSON.stringify(table.body)).toContain("Furnace Temp: 1100 F");
  });
});

describe("draft traveler marking", () => {
  it("marks every final page and reports the final page count without changing production rendering", async () => {
    // pdfmake decorates render nodes (including continuation-header images), so each render gets
    // a fresh, independently built definition from the identical input fixture.
    const fixture = overflowData("THERMALPROCESSCONTROL".repeat(14));
    const production = await renderSheetGroups(buildTravelerDefinitions(fixture));
    const archivedHash = sha256(production);
    const marked = await renderDraftTraveler(buildTravelerDefinitions(fixture));

    expect(DRAFT_PROCESS_PREVIEW_LABEL).toBe("DRAFT PROCESS PREVIEW - NOT FOR PRODUCTION");
    const productionPages = drawnPages(production);
    const markedPages = drawnPages(marked.pdf);
    expect(marked.pageCount).toBeGreaterThan(1);
    expect(marked.pageCount).toBe(pageCount(production));
    expect(pageCount(marked.pdf)).toBe(marked.pageCount);
    expect(exactLabelDraws(marked.pdf)).toBe(marked.pageCount);
    for (const page of markedPages) expect(page).toContain(DRAFT_PROCESS_PREVIEW_LABEL);
    const removePreviewLabel = (text: string): string =>
      text.replaceAll(DRAFT_PROCESS_PREVIEW_LABEL, "").replace(/\s+/g, " ").trim();
    expect(markedPages.map(removePreviewLabel)).toEqual(productionPages.map(removePreviewLabel));
    expect(exactLabelDraws(production)).toBe(0);
    expect(sha256(production)).toBe(archivedHash);

    const artifactDir = process.env.PROCESS_TRAVELER_LAYOUT_ARTIFACT_DIR;
    if (artifactDir) {
      mkdirSync(artifactDir, { recursive: true });
      const short = await renderDraftTraveler(buildTravelerDefinitions(data("Short fictional instruction.")));
      const long = await renderDraftTraveler(buildTravelerDefinitions(
        overflowData("THERMALPROCESSCONTROL".repeat(14))));
      writeFileSync(path.join(artifactDir, "traveler-short-draft.pdf"), short.pdf);
      writeFileSync(path.join(artifactDir, "traveler-long-multiline-draft.pdf"), long.pdf);
      const oversized = data("Z".repeat(4000));
      oversized.steps[0].values = [{ label: "Recorded Value", value: "9".repeat(500), unit: "units" }];
      const oversizedPdf = await renderDraftTraveler(buildTravelerDefinitions(oversized));
      writeFileSync(path.join(artifactDir, "traveler-oversized-step-draft.pdf"), oversizedPdf.pdf);
    }
  });

  it("wraps an overlong token without losing text and repeats sign-off headers on overflow pages", async () => {
    const token = "THERMALPROCESSCONTROL".repeat(14);
    const marked = await renderDraftTraveler(buildTravelerDefinitions(overflowData(token)));
    const pages = drawnPages(marked.pdf);

    expect(marked.pageCount).toBeGreaterThan(1);
    expect(pages.join("")).toContain(token);
    for (const page of pages) {
      expect(page).toContain("EQ#");
      expect(page).toContain("OP");
      expect(page).toContain("Date");
    }
    expect(exactLabelDraws(marked.pdf)).toBe(marked.pageCount);
  });

  it("preserves every numbered line of a maximum-length newline-heavy step", async () => {
    const lines = Array.from({ length: 667 }, (_, i) => `L${String(i).padStart(3, "0")}`);
    const fixture = data(lines.join("\n\n"));
    expect(fixture.steps[0].instruction).toHaveLength(4000);
    const valueLines = Array.from({ length: 100 }, (_, i) => `V${String(i).padStart(3, "0")}`);
    fixture.steps[0].values = [{ label: "Recorded", value: valueLines.join("\n"), unit: "units" }];
    const marked = await renderDraftTraveler(buildTravelerDefinitions(fixture));
    const pages = drawnPages(marked.pdf);
    for (const line of [...lines, ...valueLines]) expect(pages.join(""), line).toContain(line);
    // break-all can draw one logical line as multiple glyph runs. Join only instruction-column
    // runs on the same baseline before checking numbered lines and intentional blank spacing.
    const runs = textRunsWithY(marked.pdf).map((page) => {
      const byBaseline = new Map<number, { text: string; x: number; y: number }[]>();
      for (const run of page.filter((item) => item.x >= 120 && item.x < 450)) {
        const baseline = Math.round(run.y * 100) / 100;
        byBaseline.set(baseline, [...(byBaseline.get(baseline) ?? []), run]);
      }
      return [...byBaseline.values()].map((line) => ({
        text: line.sort((a, b) => a.x - b.x).map((run) => run.text).join(""),
        y: line[0].y,
      }));
    });
    for (const [index, page] of runs.entries()) {
      const instructions = page.filter((run) => /^L\d{3}$|^V\d{3}$/.test(run.text));
      if (!instructions.length) continue;
      expect(pages[index]).toContain("Preheat");
      for (const run of instructions) {
        expect(run.y).toBeGreaterThan(24);
        expect(run.y).toBeLessThan(720);
      }
    }
    const firstPage = runs.find((page) => page.some((run) => run.text === "L000"))!;
    const y0 = firstPage.find((run) => run.text === "L000")!.y;
    const y1 = firstPage.find((run) => run.text === "L001")!.y;
    // Two line advances: the deliberate empty line must remain visible space.
    expect(y0 - y1).toBeGreaterThan(16);
    const artifactDir = process.env.PROCESS_TRAVELER_LAYOUT_ARTIFACT_DIR;
    if (artifactDir) writeFileSync(path.join(artifactDir, "traveler-newline-heavy-draft.pdf"), marked.pdf);
  });

  it("paginates a maximum-length unbroken instruction at a narrow valid column width", async () => {
    const narrow = config();
    steps(narrow).fields.find((field) => field.key === "step_instruction")!.width = 32;
    const validated = validateConfig("TRAVELER", narrow);
    const fixture = data("Z".repeat(4000));
    const marked = await renderDraftTraveler(buildTravelerDefinitions(fixture, validated));
    const pages = drawnPages(marked.pdf);
    expect(pages.join("").match(/Z/g)).toHaveLength(4000);
    for (const page of pages.filter((text) => text.includes("ZZ"))) {
      expect(page).toContain("Preheat");
      expect(page).toContain("EQ#");
    }
    for (const page of textRunsWithY(marked.pdf)) {
      for (const run of page.filter((item) => /^Z+$/.test(item.text))) {
        expect(run.y).toBeGreaterThan(24);
        expect(run.y).toBeLessThan(720);
      }
    }
    const artifactDir = process.env.PROCESS_TRAVELER_LAYOUT_ARTIFACT_DIR;
    if (artifactDir) writeFileSync(path.join(artifactDir, "traveler-narrow-draft.pdf"), marked.pdf);
  });

  it("preserves an unusually tall custom results label without forcing it into one page", async () => {
    const custom = config();
    const lines = Array.from({ length: 180 }, (_, i) => `R${String(i).padStart(3, "0")}`);
    custom.sections.find((section) => section.key === "footer")!.fields
      .find((field) => field.key === "results")!.label = lines.join("\n");
    const marked = await renderDraftTraveler(buildTravelerDefinitions(data(), validateConfig("TRAVELER", custom)));
    const text = drawnPages(marked.pdf).join("");
    for (const line of lines) expect(text).toContain(line);
    const artifactDir = process.env.PROCESS_TRAVELER_LAYOUT_ARTIFACT_DIR;
    if (artifactDir) writeFileSync(path.join(artifactDir, "traveler-tall-results-draft.pdf"), marked.pdf);
  });

  it("paginates one maximum-length step without truncating its instruction or typed value", async () => {
    const instruction = "Z".repeat(4000);
    const value = "9".repeat(500);
    const fixture = data(instruction);
    fixture.steps[0].values = [{ label: "Recorded Value", value, unit: "units" }];

    const marked = await renderDraftTraveler(buildTravelerDefinitions(fixture));
    const text = drawnPages(marked.pdf).join("");

    expect(marked.pageCount).toBeGreaterThan(1);
    expect(text.match(/Z/g)).toHaveLength(4000);
    expect(text).toContain(`Recorded Value: ${value} units`);
    const pages = drawnPages(marked.pdf);
    const resultsPage = pages.findIndex((page) => page.includes("RESULTS:"));
    expect(resultsPage).toBeGreaterThanOrEqual(0);
    expect(pages[resultsPage]).toContain("FINAL INSPECTION:");
    expect(pages[resultsPage]).toContain("OK to Ship:");
    expect(exactLabelDraws(marked.pdf)).toBe(marked.pageCount);
  });
});

describe("compact traveler proportions (spec §6)", () => {
  it("fits a form-sized fictional traveler on one page", async () => {
    const pdf = await renderSheetGroups(buildTravelerDefinitions(formSized()));
    expect(pageCount(pdf)).toBe(1);
  });

  it("carries the mockup's own tare totals and the order's net, tare and gross on the form-sized traveler", () => {
    // What the one-page case above measures: both container rows print a tare total over a tare
    // each, so each is a two-line row.
    const texts = textValues(buildTravelerDefinition(formSized()));
    for (const figure of ["2,936 lb", "367 lb each", "3,828 lb", "319 lb each", "Net 60,750 lb", "Tare 6,764 lb", "Gross 67,514 lb"]) {
      expect(texts, figure).toContain(figure);
    }
  });

  it("prints one-line step rows and sign-off boxes at their stated printed sizes (owner ruling B)", async () => {
    const pdf = await renderSheetGroups(buildTravelerDefinitions(formSized()));
    // formSized()'s one-line steps: a single short instruction sentence, at most one short typed
    // value. Racking and Austemper are deliberately multi-line/multi-value and are checked
    // separately below, since spec §6 only promises the MINIMUM for a one-line step — taller
    // content is expected to grow the row past it.
    // "Pre-" rather than "Pre-heat": the text still prints on one line, but pdfmake's text breaker
    // treats the hyphen as a break opportunity, the same as a space, and writes each fragment as
    // its own text run, so the code-name cell draws "Pre-" and "heat" as two runs.
    const oneLineLandmarks = ["Receiving", "Pre-", "Hot", "Final", "Pack"];
    for (const landmark of oneLineLandmarks) {
      const { rowGap, boxGaps, boxTopOffsets, boxLeftOffset, dividerPresent } =
        stepRowGeometry(pdf, 0, landmark);
      expect(rowGap, `${landmark} row`).toBeCloseTo(TRAVELER_STEP_LAYOUT.rowHeight, 1);
      expect(boxGaps, `${landmark} boxes`).toHaveLength(3); // EQ#, OP, Date — three per step
      for (const gap of boxGaps) {
        expect(gap, `${landmark} box height`).toBeCloseTo(TRAVELER_STEP_LAYOUT.boxHeight, 1);
      }
      // Each box's top line sits cellPaddingY + ruleWidth (2.8) or less below its row's own top
      // rule — the zero-margin box construction (owner ruling B).
      const maxOffset = TRAVELER_STEP_LAYOUT.cellPaddingY + TRAVELER_STEP_LAYOUT.ruleWidth;
      for (const offset of boxTopOffsets) {
        expect(offset, `${landmark} box top offset`).toBeGreaterThan(0);
        expect(offset, `${landmark} box top offset`).toBeLessThanOrEqual(maxOffset + 0.1);
      }
      // The first box starts at the instruction column's right edge: measured, its own left
      // border sits exactly one rule width (0.8) to the right of the content columns' own right
      // edge — that gap IS the content/handwriting divider (render.ts's
      // TRAVELER_STEPS_LAYOUT.vLineWidth), asserted directly below via `dividerPresent`, not an
      // artifact of padding or stroke centring. A loose "close to zero" tolerance here would
      // pass whether or not the divider is drawn at all (removing it shifts the content column's
      // own resolved width to close the same gap from the other side) — see `dividerPresent`'s
      // own mutation proof (task-8-report.md) for why this needs the tight bound.
      expect(boxLeftOffset, `${landmark} box left edge`).toBeCloseTo(TRAVELER_STEP_LAYOUT.ruleWidth, 1);
      expect(dividerPresent, `${landmark} divider`).toBe(true);
    }
    // Racking and Austemper are multiline/multi-value and grow past the one-line minimum instead
    // of being clipped to it. "Austemper" also names the process (the "Process:" row above the
    // table) — stepRowGeometry's own fallback-to-the-next-match handles that, since only the
    // steps-table occurrence resolves to a row carrying handwriting boxes.
    for (const landmark of ["Racking", "Austemper"]) {
      const { rowGap } = stepRowGeometry(pdf, 0, landmark);
      expect(rowGap, `${landmark} row`).toBeGreaterThan(TRAVELER_STEP_LAYOUT.rowHeight + 1);
    }
  });

  it("prints ordinary rows and boxes at their stated sizes around a page-tall step", async () => {
    // A few one-line steps either side of one step whose instruction is taller than a page (90
    // lines) — the page-tall-step path (render.ts's `prepareTravelerLayout` groups), not the
    // ordinary stepsTable() path the test above covers.
    const fixture = data();
    fixture.steps = [
      { position: 1, codeName: "Preheat", instruction: "Warm the furnace to the setpoint.", values: [] },
      {
        position: 2, codeName: "Long Soak",
        instruction: Array.from({ length: 90 }, (_, i) => `Soak line ${i + 1} of the extended hold.`).join("\n"),
        values: [],
      },
      { position: 3, codeName: "Quench", instruction: "Quench in the marked tank.", values: [] },
      { position: 4, codeName: "Cool", instruction: "Cool to room temperature before handling.", values: [] },
    ];
    const pdf = await renderSheetGroups(buildTravelerDefinitions(fixture));
    expect(pageCount(pdf)).toBeGreaterThan(1); // the 90-line step must have forced pagination

    for (const [landmark, pageIndex] of [["Preheat", 0], ["Quench", 1], ["Cool", 1]] as const) {
      const { rowGap, boxGaps, dividerPresent } = stepRowGeometry(pdf, pageIndex, landmark);
      expect(rowGap, `${landmark} row`).toBeCloseTo(TRAVELER_STEP_LAYOUT.rowHeight, 1);
      expect(boxGaps, `${landmark} boxes`).toHaveLength(3);
      for (const gap of boxGaps) {
        expect(gap, `${landmark} box height`).toBeCloseTo(TRAVELER_STEP_LAYOUT.boxHeight, 1);
      }
      expect(dividerPresent, `${landmark} divider`).toBe(true);
    }
  });

  it("draws EQ#, OP and Date as small boxes at the top of each step row", () => {
    const def = buildTravelerDefinition(data());
    expect(stepsTableNode(def).handwritingColumns).toEqual([3, 4, 5]);
    const table = tableWithWidths(def, [16, 62, "*", 34, 30, 46]);
    const [header, row] = table.body as Record<string, unknown>[][];
    for (const i of [3, 4, 5]) {
      // The header (label) variant: no fixed height, the pre-refresh margin, and its own layout,
      // which has no side padding (#358).
      expect(header[i], `header ${i}`).toMatchObject({
        border: [false, false, false, false], layout: "traveler-signoff-label",
        table: { widths: ["*"] }, margin: [0, 2, 0, 2],
      });
      expect(header[i], `header ${i} has no fixed height`).not.toHaveProperty("table.heights");
      // The step (empty) variant: pdfmake's CONTENT height (owner ruling B derives it from
      // boxHeight so the PRINTED box is 18pt — see this file's own printed-geometry tests above,
      // which measure the render through tests/helpers/pdf.ts's strokedLines helper) and zero
      // margin.
      expect(row[i], `row ${i}`).toMatchObject({
        border: [false, false, false, false], layout: "traveler-signoff-box",
        table: { widths: ["*"], heights: [TRAVELER_STEP_BOX_CONTENT] }, margin: [0, 0, 0, 0],
      });
    }
    expect(textValues(header.slice(3))).toEqual(["EQ#", "OP", "Date"]);
    // The content columns keep their normal cells, so their rules still draw.
    expect(row[0]).not.toHaveProperty("border");
  });

  // #358. The header box's side padding sat inside the configured column width, so a column
  // narrower than its label plus that padding printed a header box wider than its column: it
  // overhung the next box and ran past the table's right edge, out of line with the step boxes
  // below. The header box now carries no side padding; the step boxes keep theirs.
  describe("the sign-off header boxes (#358)", () => {
    /** The x of each vertical box border around a text landmark's row, left to right. */
    function boxBorders(pdf: Buffer, landmark: string): number[] {
      const run = textRunsWithY(pdf)[0].find((r) => r.text === landmark);
      if (!run) assert.fail(`"${landmark}" is not printed`);
      const y = 792 - run.y;
      const around = strokedLines(pdf)[0].filter((s) => s.x1 === s.x2 && s.x1 > 450 && s.y1 < y && s.y2 > y);
      // The six box borders share one top and bottom; the content divider beside them is taller.
      const spans = new Map<string, number[]>();
      for (const s of around) {
        const key = `${s.y1.toFixed(1)}:${s.y2.toFixed(1)}`;
        spans.set(key, [...(spans.get(key) ?? []), Math.round(s.x1 * 100) / 100]);
      }
      const boxes = [...spans.values()].sort((a, b) => b.length - a.length)[0] ?? [];
      return boxes.sort((a, b) => a - b);
    }
    const labelRuns = (pdf: Buffer, labels: string[]) =>
      labels.map((label) => textRunsWithY(pdf)[0].find((r) => r.text === label) ?? assert.fail(`"${label}" is not printed`));
    const render = (change: (c: TemplateConfig) => void = () => {}) => {
      const c = config();
      change(c);
      return renderSheetGroups(buildTravelerDefinitions(data(), validateConfig("TRAVELER", c)));
    };
    const field = (c: TemplateConfig, key: string) => steps(c).fields.find((f) => f.key === key)!;

    it("prints the default header at its measured place: each x as before the weights on paper, each y 11.13 points lower", async () => {
      const pdf = await render();
      // Each x was measured on the commit before the change, through this builder. Each y is
      // 11.13 points under the 546.61 measured then: the quantities row above is that much taller
      // with the order's net, tare and gross as three lines in its last cell (weights design §13).
      expect(labelRuns(pdf, ["EQ#", "OP", "Date"]).map((r) => [Number(r.x.toFixed(2)), Number(r.y.toFixed(2))]))
        .toEqual([[486.77, 535.48], [520.89, 535.48], [555.96, 535.48]]);
      expect(boxBorders(pdf, "EQ#")).toEqual([477.6, 510.8, 511.6, 540.8, 541.6, 586.8]);
      expect(boxBorders(pdf, "Preheat")).toEqual(boxBorders(pdf, "EQ#"));
    });

    it("keeps a narrowed column's header box on its column, in line with the step boxes below", async () => {
      const pdf = await render((c) => {
        field(c, "step_eq").width = 20; field(c, "step_op").width = 16; field(c, "step_date").width = 22;
      });
      const header = boxBorders(pdf, "EQ#");
      expect(header).toHaveLength(6);
      expect(header).toEqual(boxBorders(pdf, "Preheat"));
      // Each label sits between its own box's borders.
      labelRuns(pdf, ["EQ#", "OP", "Date"]).forEach((run, index) => {
        expect(run.x, run.text).toBeGreaterThan(header[index * 2]);
        expect(run.x, run.text).toBeLessThan(header[index * 2 + 1]);
      });
      // Nothing is drawn past the right edge of the table (the page's content width ends at 588).
      const strokes = strokedLines(pdf)[0];
      expect(Math.max(...strokes.map((s) => Math.max(s.x1, s.x2)))).toBeLessThanOrEqual(588);
    });

    it("prints a two-word label on one line where the column has room for it", async () => {
      const plain = await render();
      const pdf = await render((c) => {
        field(c, "step_eq").label = "EQ No"; field(c, "step_op").label = "Op By"; field(c, "step_date").label = "Date Done";
      });
      // pdfmake writes each word as its own run. With the side padding the last two wrapped, and
      // the header row and every row under it grew by a line.
      const words = labelRuns(pdf, ["EQ ", "No", "Op ", "By", "Date ", "Done"]);
      expect(new Set(words.map((r) => r.y.toFixed(2)))).toEqual(new Set(["535.48"])); // the default header's y, as the case above holds it
      expect(labelRuns(pdf, ["Preheat"])[0].y).toBeCloseTo(labelRuns(plain, ["Preheat"])[0].y, 2);
      expect(boxBorders(pdf, "Preheat")).toEqual(boxBorders(plain, "Preheat"));
    });
  });

  // #442 (owner ruling 2026-10-05: accepted). The sign-off columns have had no side padding and no
  // rules between them since #359, so the table's own width is the padded step columns, one
  // divider and the three bare boxes. A flexible instruction column takes up the difference; a
  // fixed one does not, so at a width below the flexible one (300 here) the table ends short of
  // the right edge. A fixed width above 350.4 passes validation, which sums declared widths only,
  // and prints past the margin; the editor warns about it (#450, the describe below).
  it("pins the steps table's strokes for a fixed instruction width of 300 beside the Standard table's (#442)", async () => {
    /** The vertical strokes through the first step's row, left to right: the divider between the
     *  instruction and the sign-off boxes, then the boxes' own side borders. */
    const verticals = async (instructionWidth: number | null) => {
      const c = config();
      steps(c).fields.find((f) => f.key === "step_instruction")!.width = instructionWidth;
      const valid = validateConfig("TRAVELER", c);
      expect(tableWithWidths(buildTravelerDefinition(data(), valid), [16, 62, 34, 30, 46]).widths)
        .toEqual([16, 62, instructionWidth ?? "*", 34, 30, 46]);
      const pdf = await renderSheetGroups(buildTravelerDefinitions(data(), valid));
      const run = textRunsWithY(pdf)[0].find((r) => r.text === "Preheat");
      if (!run) assert.fail('"Preheat" is not printed');
      const y = 792 - run.y;
      return strokedLines(pdf)[0].filter((s) => s.x1 === s.x2 && s.y1 < y && s.y2 > y)
        .map((s) => Math.round(s.x1 * 100) / 100).sort((a, b) => a - b);
    };
    // Measured from the render. Fixed at 300: 24 (page margin) + 24 + 70 + 308 (each step column
    // with its 4 pt padding either side) puts the 0.8 pt divider's centre at 426.4, and the 110 pt
    // of boxes end with the Date box's right border at 536.4: 50.4 pt short of the Standard
    // table's 586.8. 25.6 pt of that is the padding and rules the sign-off columns lost in #359;
    // the other 24.8 pt a fixed 300 was already short.
    expect(await verticals(300)).toEqual([426.4, 427.2, 460.4, 461.2, 490.4, 491.2, 536.4]);
    // Standard (no fixed width): the same seven strokes, the last on the table's right edge.
    expect(await verticals(null)).toEqual([476.8, 477.6, 510.8, 511.6, 540.8, 541.6, 586.8]);
  });

  // #450 (owner ruling 2026-10-05: warn in the editor, do not refuse). The editor's warning rests
  // on `travelerStepsPrintedWidth`, which restates this layout's padding and rule predicate in
  // client-safe code. These hold it to the server's layout object and to the rendered strokes.
  describe("the steps table's width on paper against the editor's figure (#450)", () => {
    const STANDARD = ["steps_title", "step_position", "step_code", "step_instruction", "step_values", "step_eq", "step_op", "step_date"];
    const INSTRUCTION_FIRST = ["steps_title", "step_instruction", "step_values", "step_eq", "step_op", "step_date", "step_position", "step_code"];
    // Not an order the editor can save: EQ#/OP/Date apart and before the instruction. The builder
    // prints it as STANDARD.
    const INTERLEAVED = ["steps_title", "step_eq", "step_position", "step_op", "step_code", "step_instruction", "step_values", "step_date"];
    const WIDTHS = [300, 350, 351, 376];
    const LEFT = 24, RIGHT = 588; // LETTER, 24 pt margins: the content width is 564.

    function configured(order: string[], instructionWidth: number): TemplateConfig {
      const c = config();
      const section = steps(c);
      section.fields = order.map((key) => section.fields.find((f) => f.key === key)!);
      section.fields.find((f) => f.key === "step_instruction")!.width = instructionWidth;
      return c;
    }
    const printed = (c: TemplateConfig) => travelerStepsPrintedWidth(c.sections, c.fonts.baseSize).printed;
    // Since #991 (owner ruling R-B, 2026-11-17) the editor refuses what #450 warned of: `printedBudgetRefusals`.
    const warns = (c: TemplateConfig) => printedBudgetRefusals(TRAVELER_CONTRACT, c).some((p) => p.table === "steps");

    it("equals the declared widths plus the padding and rule slots of the real layout", () => {
      const { paddingLeft, paddingRight, vLineWidth } = TRAVELER_STEPS_LAYOUT;
      for (const order of [STANDARD, INSTRUCTION_FIRST, INTERLEAVED]) {
        for (const width of WIDTHS) {
          const c = configured(order, width);
          const node = stepsTableNode(buildTravelerDefinition(data(), c)) as {
            handwritingColumns?: number[]; table: { widths: unknown[] };
          };
          const widths = node.table.widths;
          expect(widths.every((w) => typeof w === "number"), `${order[1]} ${width}`).toBe(true);
          let laidOut = 0;
          widths.forEach((w, i) => { laidOut += (w as number) + paddingLeft(i, node) + paddingRight(i, node); });
          for (let i = 0; i <= widths.length; i++) laidOut += vLineWidth(i, node);
          expect(printed(c), `${order[1]} ${width}`).toBeCloseTo(laidOut, 6);
        }
      }
    });

    const renderWith = async (c: TemplateConfig) => {
      // The contract's own battery: the widths past the page are refused by the registry since R-B, and printed here
      // as a config that reaches the renderer unvalidated would print.
      const pdf = await renderSheetGroups(buildTravelerDefinitions(data(), validateContractConfig(TRAVELER_CONTRACT, c)));
      const run = textRunsWithY(pdf)[0].find((r) => r.text === "Preheat");
      if (!run) assert.fail('"Preheat" is not printed');
      return { strokes: strokedLines(pdf)[0], y: 792 - run.y };
    };

    it("puts the Date box's right border where the figure says, in the Standard column order", async () => {
      for (const width of WIDTHS) {
        const c = configured(STANDARD, width);
        const { strokes, y } = await renderWith(c);
        const last = Math.max(...strokes.filter((s) => s.x1 === s.x2 && s.y1 < y && s.y2 > y).map((s) => s.x1));
        // The table ends in a rule slot that is laid out but not drawn (the sign-off cells turn
        // the table's rules off), and the box's own border is centred half a rule inside that.
        expect(last, String(width)).toBeCloseTo(LEFT + printed(c) - 1.5 * TRAVELER_STEP_LAYOUT.ruleWidth, 2);
      }
      // Measured: 536.4, 586.4, 587.4, 612.4. The page is 612 wide.
      expect(LEFT + printed(configured(STANDARD, 376)) - 1.5 * TRAVELER_STEP_LAYOUT.ruleWidth).toBeCloseTo(612.4, 6);
    });

    it("ends the row rules where the figure says when the step text columns come last", async () => {
      const ends: number[] = [];
      for (const width of WIDTHS) {
        const c = configured(INSTRUCTION_FIRST, width);
        const { strokes, y } = await renderWith(c);
        // The step row's own top and bottom rules: the nearest horizontal strokes either side of
        // the step's text that start at the left margin, with every segment at those heights.
        const horizontal = strokes.filter((s) => s.y1 === s.y2);
        const fromLeft = horizontal.filter((s) => Math.min(s.x1, s.x2) === LEFT).map((s) => s.y1);
        const below = Math.max(...fromLeft.filter((at) => at < y));
        const above = Math.min(...fromLeft.filter((at) => at > y));
        const rules = horizontal.filter((s) => s.y1 === below || s.y1 === above);
        expect(above - below, String(width)).toBeCloseTo(TRAVELER_STEP_LAYOUT.rowHeight, 2);
        const end = Math.max(...rules.map((s) => Math.max(s.x1, s.x2)));
        expect(end, String(width)).toBeCloseTo(LEFT + printed(c), 2);
        ends.push(end);
      }
      // The ink crosses the right margin between 350 and 351.
      expect(ends[1]).toBeLessThanOrEqual(RIGHT);
      expect(ends[2]).toBeGreaterThan(RIGHT);
    });

    it("refuses exactly the widths whose table is laid out past the right margin", () => {
      for (const order of [STANDARD, INSTRUCTION_FIRST]) {
        for (const width of WIDTHS) {
          const c = configured(order, width);
          expect(warns(c), `${order[1]} ${width}`).toBe(LEFT + printed(c) > RIGHT);
        }
        expect(WIDTHS.map((width) => warns(configured(order, width)))).toEqual([false, false, true, true]);
      }
    });
  });

  it("keeps step rows together as one physical unit, even when short", () => {
    // dontBreakRows: true keeps a step and its three handwriting boxes from splitting across a
    // page boundary — a structural guarantee distinct from the printed-geometry tests above.
    const table = tableWithWidths(buildTravelerDefinition(data()), [16, 62, "*", 34, 30, 46]);
    expect(table.dontBreakRows).toBe(true);
    // The row's own pdfmake CONTENT-height minimum, not the printed size (see the geometry tests
    // above for what that minimum actually prints as once cell padding and the rule width land
    // back on top of it).
    expect(table.heights).toEqual(["auto", TRAVELER_STEP_ROW_CONTENT_MIN]);
  });

  it("pads and rules the small boxes by field identity when a stored template reorders the step columns", () => {
    const moved = config();
    const section = steps(moved);
    const order = ["steps_title", "step_instruction", "step_values", "step_position", "step_code", "step_eq", "step_op", "step_date"];
    section.fields = order.map((key) => section.fields.find((field) => field.key === key)!);
    // Normalization re-anchors EQ#/OP/Date after the instruction, so the columns become
    // [instruction, EQ#, OP, Date, position, code]: the boxes sit at 1–3, not 3–5.
    const node = stepsTableNode(buildTravelerDefinition(data(), moved));
    expect(node.handwritingColumns).toEqual([1, 2, 3]);
    const { paddingLeft, vLineWidth } = TRAVELER_STEPS_LAYOUT;
    expect(paddingLeft(1, node)).toBe(0);
    expect(paddingLeft(3, node)).toBe(0);
    expect(paddingLeft(4, node)).toBe(TRAVELER_STEP_LAYOUT.padding);
    expect(paddingLeft(0, node)).toBe(TRAVELER_STEP_LAYOUT.padding);
    expect(vLineWidth(1, node)).toBe(TRAVELER_STEP_LAYOUT.ruleWidth);
    expect(vLineWidth(2, node)).toBe(0);
    expect(vLineWidth(4, node)).toBe(TRAVELER_STEP_LAYOUT.ruleWidth);
    expect(vLineWidth(5, node)).toBe(0);
  });

  it("prints every sign-off label on the boxed form-sized traveler", async () => {
    // Page count is covered by "fits a form-sized fictional traveler on one page" above; asserting
    // it again here would be a duplicate, not a second proof.
    const pdf = await renderSheetGroups(buildTravelerDefinitions(formSized()));
    const runs = textRunsWithY(pdf)[0];
    // Exact-run match, not `drawnPages(...).toContain(...)`: the footer prints its own "Date:"
    // labels (Tested/OK-to-ship), so a bare substring check on "Date" is satisfied by those even
    // if the steps table's own handwriting box lost its label entirely.
    for (const label of ["EQ#", "OP", "Date"]) {
      expect(runs.some((run) => run.text === label), label).toBe(true);
    }
  });

  it("prints parameter lines above the instruction text", () => {
    const table = tableWithWidths(buildTravelerDefinition(data("Hold until uniform.")), [16, 62, "*", 34, 30, 46]);
    const texts = textValues(table.body[1]);
    expect(texts.indexOf("Furnace Temp: 1100 F")).toBeGreaterThanOrEqual(0);
    expect(texts.indexOf("Furnace Temp: 1100 F")).toBeLessThan(texts.indexOf("Hold until uniform."));
  });

  it("prints an empty parameter as a handwriting blank (spec 2026-09-26 §6, slice 2)", () => {
    const def = buildTravelerDefinition({
      ...data(),
      steps: [{
        position: 1, codeName: "Preheat", instruction: "Hold.",
        values: [{ label: "Temperature", value: "", unit: "°F" }, { label: "Load", value: "", unit: null }],
      }],
    });
    const texts = textValues(stepsTableNode(def));
    expect(texts).toContain("Temperature: ________ °F");
    expect(texts).toContain("Load: ________");
  });
});

describe("SAMPLE preview header (design spec 2026-09-26 §5)", () => {
  it("prints SAMPLE on a continuation page, with no image on any page, for an overflowing sample", async () => {
    const fixture = overflowData("SAMPLEOVERFLOWTOKEN");
    const sample: TravelerData = {
      ...fixture,
      sample: true,
      orderNumber: 0,
      sheets: [{ loadNumber: null, loadQty: null, loadWeight: null, barcodeDataUri: "" }],
    };
    const pdf = await renderSheetGroups(buildTravelerDefinitions(sample));
    expect(pageCount(pdf)).toBeGreaterThan(1);
    const pages = drawnPages(pdf);
    expect(pages[1]).toContain("(continued)");
    // Three exact "SAMPLE" runs on the continuation page too: the order-number line, the load
    // line, and the barcode placeholder's own text — not merely "the word SAMPLE appears
    // somewhere", which the placeholder alone would already satisfy even if the order/load lines
    // had regressed back to printing the real (meaningless) orderNumber/loadNumber.
    const continuationRuns = textRunsWithY(pdf)[1];
    expect(continuationRuns.filter((r) => r.text === "SAMPLE")).toHaveLength(3);
    // No page paints an image: the SAMPLE preview has no barcode (no order to encode), and the
    // only other image would be a template logo, which the default template carries none of — a
    // configured logo is company identity and rightly stays on a SAMPLE. Page 1's own header must
    // swap its barcode too, not only page 2's.
    expect(paintedImageCounts(pdf).every((count) => count === 0)).toBe(true);
  });
});

/** The header's left stack as the definition holds it: each node's text, the PO line's read from
 *  inside the one fixed-width column that holds it (#518). */
const leftStack = (def: ReturnType<typeof buildTravelerDefinition>): (string | undefined)[] => {
  const sheet = (def.content as { stack: unknown[] }[])[0];
  const header = sheet.stack[0] as { columns: { stack: { text?: string; columns?: { text: string }[] }[] }[] };
  return header.columns[0].stack.map((node) => node.text ?? node.columns?.[0].text);
};

describe("customer phone in the header (spec §7)", () => {
  // data() holds no PO, so each stack ends in the PO label and its write-in rule (#518).
  it("prints the phone under the received-from address", () => {
    const def = buildTravelerDefinition({ ...data(), customerPhone: "555-0142" });
    expect(leftStack(def)).toEqual(
      ["Fictional Foundry", "100 Example Avenue", "Sample City, AL 35000", "Ph: 555-0142", `PO: ${RULE}`]);
  });

  it("prints nothing for a blank phone", () => {
    expect(leftStack(buildTravelerDefinition(data()))).toEqual(
      ["Fictional Foundry", "100 Example Avenue", "Sample City, AL 35000", `PO: ${RULE}`]);
  });

  it("follows the template: hidden prints nothing, a relabel prints the new label", () => {
    const hidden = config();
    hidden.sections[0].fields.find((f) => f.key === "customer_phone")!.visible = false;
    expect(leftStack(buildTravelerDefinition({ ...data(), customerPhone: "555-0142" }, validateConfig("TRAVELER", hidden))))
      .not.toContain("Ph: 555-0142");
    const relabelled = config();
    relabelled.sections[0].fields.find((f) => f.key === "customer_phone")!.label = "Tel:";
    expect(leftStack(buildTravelerDefinition({ ...data(), customerPhone: "555-0142" }, validateConfig("TRAVELER", relabelled))))
      .toContain("Tel: 555-0142");
  });

  it("prints the phone under the address even when a legacy template reordered its header", () => {
    const old = config();
    const header = old.sections[0];
    // Saved before customer_phone existed, with the customer block moved after the company block:
    // the backfill re-inserts customer_phone at its contract index (2), ahead of the name.
    const order = ["company_name", "company_address", "company_phone", "customer_name", "received_from", "order_number", "load_number", "barcode"];
    header.fields = order.map((key) => header.fields.find((f) => f.key === key)!);
    const def = buildTravelerDefinition({ ...data(), customerPhone: "555-0142" }, validateConfig("TRAVELER", old));
    expect(leftStack(def)).toEqual(
      ["Fictional Foundry", "100 Example Avenue", "Sample City, AL 35000", "Ph: 555-0142", `PO: ${RULE}`]);
  });

  it("prints on a stored template saved before the field existed", () => {
    const old = config();
    old.sections[0].fields = old.sections[0].fields.filter((f) => f.key !== "customer_phone");
    const def = buildTravelerDefinition({ ...data(), customerPhone: "555-0142" }, validateConfig("TRAVELER", old));
    expect(leftStack(def)).toContain("Ph: 555-0142");
  });
});

// #518 (owner rulings 2026-10-15 and 2026-10-17, and the owner's answers on it of 2026-10-17):
// the order's PO prints as the last line of the header's left stack, under the phone, or the label
// and a write-in rule when the order has none. Each case but the two at definition level reads a
// rendered page.
describe("the customer PO in the header (#518)", () => {
  const PO = "ADSE-3335";
  /** 200 characters, the most Order.poNumber holds, of capitals and digits with no space. */
  const TOKEN = Array.from({ length: 200 }, (_, i) => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[i % 34]).join("");
  const render = (d: TravelerData, c?: TemplateConfig) => renderSheetGroups(buildTravelerDefinitions(d, c));
  const withPhone = (over: Partial<TravelerData> = {}): TravelerData => ({ ...data(), customerPhone: "555-0142", ...over });
  /** The default config with its base size and the po_number field changed, through the validator. */
  const variant = ({ baseSize, visible = true, label = null }: { baseSize?: number; visible?: boolean; label?: string | null } = {}) => {
    const c = config();
    if (baseSize !== undefined) c.fonts.baseSize = baseSize;
    const field = c.sections[0].fields.find((f) => f.key === "po_number")!;
    field.visible = visible;
    field.label = label;
    return validateConfig("TRAVELER", c);
  };
  const beginsPo = (runs: Run[]) => runs.some((run) => run.text.startsWith("PO:"));
  const at2 = (y: number) => Number(y.toFixed(2));
  const eqY = async (d: TravelerData, c?: TemplateConfig) => yOf(textRunsWithY(await render(d, c))[0], "EQ#");

  it("prints the PO as the left column's last line, under the phone", async () => {
    expect(leftColumn(await render(withPhone({ poNumber: PO })))).toEqual(
      ["Fictional Foundry", "100 Example Avenue", "Sample City, AL 35000", "Ph: 555-0142", "PO: ADSE-3335"]);
  });

  it("prints the label and a write-in rule of 23 underscores on one line for an order with no PO", async () => {
    expect(leftColumn(await render(data()))).toEqual(
      ["Fictional Foundry", "100 Example Avenue", "Sample City, AL 35000", `PO: ${RULE}`]);
  });

  it("prints no PO line when the template hides the field", async () => {
    const pdf = await render({ ...data(), poNumber: PO }, variant({ visible: false }));
    expect(leftColumn(pdf)).toEqual(["Fictional Foundry", "100 Example Avenue", "Sample City, AL 35000"]);
    expect(beginsPo(textRunsWithY(pdf)[0])).toBe(false);
  });

  it("prints a relabelled field's own label, before the PO and before the rule", async () => {
    const relabelled = variant({ label: "Customer PO:" });
    expect(leftColumn(await render({ ...data(), poNumber: PO }, relabelled)).at(-1)).toBe("Customer PO: ADSE-3335");
    expect(leftColumn(await render(data(), relabelled)).at(-1)).toBe(`Customer PO: ${RULE}`);
  });

  it("prints the PO last whatever place the template's header gives the field", async () => {
    const first = config();
    const header = first.sections[0];
    header.fields = [header.fields.find((f) => f.key === "po_number")!, ...header.fields.filter((f) => f.key !== "po_number")];
    expect(leftColumn(await render(withPhone({ poNumber: PO }), validateConfig("TRAVELER", first))).slice(-2))
      .toEqual(["Ph: 555-0142", "PO: ADSE-3335"]);

    // Saved before customer_phone and po_number existed, with the customer block moved after the
    // company block: the backfill puts both at their contract places, ahead of the customer name.
    const legacy = config();
    const order = ["company_name", "company_address", "company_phone", "customer_name", "received_from", "order_number", "load_number", "barcode"];
    legacy.sections[0].fields = order.map((key) => legacy.sections[0].fields.find((f) => f.key === key)!);
    const backfilled = validateConfig("TRAVELER", legacy);
    expect(backfilled.sections[0].fields.map((f) => f.key).slice(0, 5))
      .toEqual(["company_name", "company_address", "customer_phone", "po_number", "company_phone"]);
    expect(leftColumn(await render(withPhone({ poNumber: PO }), backfilled)).slice(-2))
      .toEqual(["Ph: 555-0142", "PO: ADSE-3335"]);
  });

  it.each<[what: string, stored: () => unknown]>([
    ["the seed migration's literal", () => seedLiteral("TRAVELER")],
    ["a frozen config that stores customer_phone", () => storedBefore("TRAVELER", "typed-labels")],
  ])("prints the PO last on %s, stored before the field existed", async (_what, stored) => {
    const c = normalizeStoredConfig("TRAVELER", stored());
    expect(leftColumn(await render(withPhone({ poNumber: PO }), c)).slice(-2)).toEqual(["Ph: 555-0142", "PO: ADSE-3335"]);
  });

  it("prints the label and the rule last on a SAMPLE, beside its three SAMPLE runs", async () => {
    const sample: TravelerData = {
      ...data(), sample: true, orderNumber: 0,
      sheets: [{ loadNumber: null, loadQty: null, loadWeight: null, barcodeDataUri: "" }],
    };
    const pdf = await render(sample);
    expect(leftColumn(pdf).at(-1)).toBe(`PO: ${RULE}`);
    expect(textRunsWithY(pdf)[0].filter((run) => run.text === "SAMPLE")).toHaveLength(3);
  });

  it("prints the PO on a sheet's first page and not on the continuation band", async () => {
    const pdf = await render({ ...overflowData("TOKEN"), poNumber: PO });
    expect(pageCount(pdf)).toBeGreaterThan(1);
    expect(leftColumn(pdf).at(-1)).toBe("PO: ADSE-3335");
    const pages = textRunsWithY(pdf);
    for (const [index, runs] of pages.slice(1).entries()) {
      expect(drawnPages(pdf)[index + 1], `page ${index + 2}`).toContain("(continued)");
      expect(beginsPo(runs), `page ${index + 2}`).toBe(false);
      expect(drawnPages(pdf)[index + 1], `page ${index + 2}`).not.toContain(PO);
    }
  });

  it("adds no height to the Standard sheet: Process: and EQ# print where they print with the field hidden", async () => {
    const ys = async (c?: TemplateConfig) => {
      const runs = textRunsWithY(await render(withPhone(), c))[0];
      return { process: at2(yOf(runs, "Process:")), eq: at2(yOf(runs, "EQ#")) };
    };
    const shown = await ys();
    measured("the Standard sheet's Process: and EQ# with the PO line", shown);
    expect(shown).toEqual({ process: 605.98, eq: 535.48 });
    expect(await ys(variant({ visible: false }))).toEqual(shown);
  });

  it("prints the label and the rule on one line at a base size of 14.5, and on two from 14.6", async () => {
    expect(leftColumn(await render(data(), variant({ baseSize: 14.5 }))).at(-1)).toBe(`PO: ${RULE}`);
    expect(leftColumn(await render(data(), variant({ baseSize: 14.6 }))).slice(-2)).toEqual(["PO:", RULE]);
    // The growth is read at EQ#: from 14 points the Process: label breaks inside its cell.
    const growth: Record<string, number> = {};
    for (const baseSize of [14.6, 15]) {
      growth[baseSize] = at2(await eqY(withPhone(), variant({ baseSize, visible: false })) - await eqY(withPhone(), variant({ baseSize })));
    }
    measured("points the PO line adds at a base size of 14.6 and of 15, with a phone", growth);
    expect(growth).toEqual({ "14.6": 14.46, "15": 15.87 });
  });

  it("prints the PO alone, or the rule alone, under a label stored empty", () => {
    // Only a raw config can store an empty label: the editor turns a cleared box back into null.
    const blank = variant({ label: "" });
    expect(leftStack(buildTravelerDefinition({ ...data(), poNumber: PO }, blank)).at(-1)).toBe(PO);
    expect(leftStack(buildTravelerDefinition(data(), blank)).at(-1)).toBe(RULE);
  });

  it("keeps a header-left logo on top of the left stack and the PO at its foot", () => {
    const c = config();
    c.logo = { placement: "header-left", width: 120 };
    const def = buildTravelerDefinition({ ...data(), poNumber: PO }, validateConfig("TRAVELER", c), LOGO);
    const sheet = (def.content as { stack: unknown[] }[])[0];
    const left = (sheet.stack[0] as { columns: { stack: unknown[] }[] }).columns[0].stack;
    expect(left[0]).toEqual({ image: LOGO, width: 120 });
    expect(leftStack(def).at(-1)).toBe("PO: ADSE-3335");
  });

  it("adds 2.39 points at the Standard size when the customer name and the street each wrap, and none when the name alone does", async () => {
    const name = "Consolidated Precision Castings and Forgings of North Alabama";
    const street = "Building 7, Dock 4, 12345 Industrial Parkway Southwest Extension";
    const added = async (d: TravelerData) => at2(await eqY(d, variant({ visible: false })) - await eqY(d));
    const both = await added(withPhone({ customerName: name, receivedFrom: [street, "Sample City, AL 35000"] }));
    const nameOnly = await added(withPhone({ customerName: name }));
    measured("points the PO line adds with a wrapping name and street, and with a wrapping name", { both, nameOnly });
    expect({ both, nameOnly }).toEqual({ both: 2.39, nameOnly: 0 });
  });

  // The owner's answer of 2026-10-17: a PO token wider than the left slot breaks inside the slot,
  // mid-token, so the right slot never moves.
  describe("a long PO with no spaces", () => {
    /** The header's center and right slots as drawn: for each word they print, its highest run on
     *  page 1, where the header heads the page, by its x and, when asked, its y. "none" where no
     *  run reads the word exactly. */
    const SLOT_WORDS = ["Order ", "Number", "Load", "70001", "1", "Heat ", "Treating", "Road", "555-0100"];
    const slots = (runs: Run[], withY = false) => SLOT_WORDS.map((word) => {
      const hits = runs.filter((run) => run.text === word);
      if (hits.length === 0) return `${word.trim()}: none`;
      const top = hits.reduce((a, b) => (b.y > a.y ? b : a));
      return `${word.trim()} ${top.x.toFixed(2)}${withY ? `,${top.y.toFixed(2)}` : ""}`;
    });

    // By x alone: where the long PO tips the sheet onto a second page (at 14.6 and 18 here), page 1
    // prints 40 points lower, under the top margin every overflowing sheet takes for its
    // continuation band.
    it.each([4, 8, 14.6, 18, 24, 72])("prints the center and right slots at the same x at a base size of %s, whatever the PO", async (baseSize) => {
      const at = async (poNumber: string) => slots(textRunsWithY(await render({ ...data(), poNumber }, variant({ baseSize })))[0]);
      const short = await at(PO);
      expect(await at(TOKEN)).toEqual(short);
      expect(await at("")).toEqual(short);
    });

    it("prints the right slot where it printed before the PO line, at the Standard size", async () => {
      const runs = textRunsWithY(await render(withPhone({ poNumber: TOKEN })))[0];
      // Each place as measured on the builder before #518, which printed no PO line.
      expect(slots(runs, true).slice(0, 5)).toEqual(
        ["Order 440.71,760.58", "Number 462.59,760.58", "Load 557.16,760.58", "70001 454.76,751.20", "1 563.75,751.20"]);
    });

    it("breaks the PO inside the left slot, every character printed once and in order", async () => {
      const pdf = await render(withPhone({ poNumber: TOKEN }));
      const lines = leftColumn(pdf);
      expect(lines.slice(0, 5)).toEqual(["Fictional Foundry", "100 Example Avenue", "Sample City, AL 35000", "Ph: 555-0142", "PO:"]);
      const pieces = lines.slice(5);
      measured("a 200-character PO's lines, by length", pieces.map((piece) => piece.length));
      expect(pieces.map((piece) => piece.length)).toEqual([35, 35, 35, 35, 35, 25]);
      expect(pieces.join("")).toBe(TOKEN);
      // Each line starts at the slot's left edge.
      const starts = textRunsWithY(pdf)[0].filter((run) => pieces.includes(run.text)).map((run) => run.x);
      expect(starts).toEqual(pieces.map(() => 24));
      expect(starts.every((x) => x < LEFT_COLUMN_RIGHT)).toBe(true);
      // The printed-page reader reads the label and the first piece as one line (the label's run
      // ends in a space) and each later piece as a line of its own: no character is added.
      const read = printedPages(pdf, { pages: 1, what: "a 200-character PO" })[0];
      const from = read.indexOf(`PO: ${pieces[0]}`);
      expect(from).toBeGreaterThanOrEqual(0);
      expect(read.slice(from, from + pieces.length)).toEqual([`PO: ${pieces[0]}`, ...pieces.slice(1)]);
    });

    it("wraps a PO with spaces at its spaces", async () => {
      expect(leftColumn(await render(withPhone({ poNumber: "ORDER 12345 RELEASE 7 BLANKET 2026 LINE 4" }))).slice(-2))
        .toEqual(["PO: ORDER 12345 RELEASE 7 BLANKET 2026", "LINE 4"]);
    });

    it("breaks the write-in rule inside the slot at a base size of 18, where it is wider than the slot", async () => {
      expect(leftColumn(await render(data(), variant({ baseSize: 18 }))).slice(-3)).toEqual(["PO:", "_".repeat(21), "__"]);
    });
  });
});

// The weights on a printed traveler (the weights design §13.5): what only a rendered page shows.
type Run = { text: string; x: number; y: number };
/** The y of the one run on a page whose text, trimmed, is exactly `word`. */
function yOf(runs: Run[], word: string): number {
  const hits = runs.filter((run) => run.text.trim() === word);
  if (hits.length !== 1) throw new Error(`"${word}" is on the page ${hits.length} times`);
  return hits[0].y;
}
/** One column's printed lines, top line first: the runs whose x is inside the column, under the
 *  heading row that holds the word `under` and over the row that holds the word `over`, joined
 *  along each baseline. A cell that wraps gives one entry for each line it prints. */
function printedLines(runs: Run[], column: { left: number; right: number }, under: string, over: string): string[] {
  const top = yOf(runs, under), bottom = yOf(runs, over);
  const byLine = new Map<number, Run[]>();
  for (const run of runs) {
    if (run.x < column.left - 0.5 || run.x > column.right || run.y >= top - 0.5 || run.y <= bottom + 0.5) continue;
    const y = Math.round(run.y * 10) / 10;
    byLine.set(y, [...(byLine.get(y) ?? []), run]);
  }
  return [...byLine.entries()].sort((a, b) => b[0] - a[0])
    .map(([, line]) => line.sort((a, b) => a.x - b.x).map((run) => run.text).join("").trim());
}
// On the built-in widths the lines table and the quantities table both end in a 78-point column
// and then one of 88 points, whose text ends 4 points inside the right margin at 588.
const LAST = (width = 88) => ({ left: 584 - width, right: 584 });
const SECOND_LAST = { left: 410, right: 488 };
/** The owner's example order (the weights design §13.2) on this file's sheet. */
function example(overrides: Partial<TravelerData> = {}): TravelerData {
  const lines = ORDER_1031.lines.map((l, i) => ({
    qty: l.qty, partNumber: `DEMO-${200 + i}`, partName: "Ring gear", description: "Machined", eachWeight: l.eachWeight, lineWeight: l.weight,
  }));
  return {
    ...data(), orderNumber: ORDER_1031.number, lines, orderQty: 300, containers: ORDER_1031.containers.map((row) => ({ ...row })),
    sheets: [{ loadNumber: 1, loadQty: 300, loadWeight: 1600, barcodeDataUri: BARCODE }], ...overrides,
  };
}

describe("the weights on a printed traveler (weights design §13.5)", () => {
  const firstPage = async (d: TravelerData, c?: TemplateConfig) => {
    const pdf = await renderSheetGroups(buildTravelerDefinitions(d, c));
    return { pages: pageCount(pdf), runs: textRunsWithY(pdf)[0] };
  };
  /** The example with one line that weighs `net`: its gross is 127.5 lb more. */
  const weighing = (net: number) => example({ lines: [{ ...example().lines[0], lineWeight: net }] });
  const bare = (count: number) => ({ typeName: "Steel Basket", count, pieces: null, tareEach: null });
  const noLoad = [{ loadNumber: null, loadQty: null, loadWeight: null, barcodeDataUri: BARCODE }];

  it("prints each weight with its unit on one line in its column", async () => {
    const { pages, runs } = await firstPage(example());
    const columns = {
      eachWeight: printedLines(runs, SECOND_LAST, "Description", "totals"),
      netWeight: printedLines(runs, LAST(), "Description", "totals"),
      tare: printedLines(runs, SECOND_LAST, "totals", "Process:"),
      orderTotals: printedLines(runs, LAST(), "totals", "Process:"),
    };
    measured("the example's weight columns", { pages, ...columns });
    expect(columns).toEqual({
      eachWeight: ["6.4 lb", "3.2 lb"], netWeight: ["1,280 lb", "320 lb"],
      tare: ["127.5 lb", "42.5 lb each"], orderTotals: ["Net 1,600 lb", "Tare 127.5 lb", "Gross 1,727.5 lb"],
    });
    expect(pages).toBe(1);
  });

  it.each<[what: string, d: () => TravelerData, c: () => TemplateConfig, width: number, printed: number, gross: string]>([
    ["a gross of nine whole digits with cents, each line on one line", () => weighing(999_999_872.49), config, 88, 3, "Gross 999,999,999.99 lb"],
    ["a gross of ten whole digits with cents, the Gross line on two", () => weighing(9_999_999_872.49), config, 88, 4, "Gross 9,999,999,999.99 lb"],
    ["a width of 50 typed on the column, the Gross line on two", () => example(),
      () => normalizeStoredConfig("TRAVELER", storedBefore("TRAVELER", "gross-width-50")), 50, 4, "Gross 1,727.5 lb"],
  ])("prints the three lines on one page for %s", async (what, d, c, width, printed, gross) => {
    const { pages, runs } = await firstPage(d(), c());
    const lines = printedLines(runs, LAST(width), "totals", "Process:");
    measured(what, { pages, lines });
    expect(lines).toHaveLength(printed);
    expect(lines.slice(2).join(" ")).toBe(gross);
    expect(pages).toBe(1);
  });

  /** How far the three lines push the rest of the sheet down: the Process row's y on the same
   *  definition with the bare-gross cell of before put back by hand, less its y as built. */
  async function addedHeight(d: TravelerData): Promise<number> {
    const built = buildTravelerDefinitions(d);
    const before = structuredClone(built);
    const blocks = (before[0].content as unknown as { stack: { table?: { body: unknown[][] } }[] }[])[0].stack;
    const body = blocks.find((b) => (b.table?.body[0] as { text?: string }[] | undefined)?.some((c) => c.text === "Order Quantity"))!.table!.body;
    const cell = body[1][5] as { rowSpan: number; stack: { text: string }[] };
    const gross = cell.stack[2].text;
    body[1][5] = { text: gross === "Gross" ? "" : gross.slice("Gross ".length, -" lb".length), alignment: "center", rowSpan: cell.rowSpan };
    const processY = async (defs: typeof built) => yOf(textRunsWithY(await renderSheetGroups(defs))[0], "Process:");
    return (await processY(before)) - (await processY(built));
  }

  it.each<[sheet: string, d: () => TravelerData, told: number]>([
    ["one container row", () => example(), 11.1],
    ["no container rows", () => example({ containers: [] }), 11.1],
    ["two container rows of one line each", () => example({ containers: [bare(2), bare(1)] }), 4.6],
    ["two container rows of two lines each", () => example({ containers: [{ ...bare(2), tareEach: 42.5 }, { ...bare(1), tareEach: 42.5 }] }), 0],
    ["a row that is one line tall today", () => example({ containers: [], sheets: noLoad }), 18.8],
  ])("makes a sheet with %s taller by what the owner was told", async (sheet, d, told) => {
    const added = await addedHeight(d());
    measured(`points added to a sheet with ${sheet}`, { added: Math.round(added * 100) / 100, told });
    // The owner was told each figure to one decimal: 0.06 takes in a figure that rounds to it.
    expect(Math.abs(added - told)).toBeLessThan(0.06);
  });

  it.each<[sheet: string, containers: TravelerData["containers"]]>([
    ["one container row", [{ typeName: "Drop pan", count: 8, pieces: null, tareEach: 367 }]],
    ["two container rows of one line each", [{ typeName: "Drop pan", count: 8, pieces: null, tareEach: null }, { typeName: "Bin", count: 12, pieces: null, tareEach: null }]],
  ])("fits the form-sized traveler with %s on one page", async (_sheet, containers) => {
    expect(pageCount(await renderSheetGroups(buildTravelerDefinitions({ ...formSized(), containers })))).toBe(1);
  });

  it("repeats the heading row and prints the three lines once where container rows run past a page", async () => {
    const containers = Array.from({ length: 80 }, () => ({ typeName: "Steel Basket", count: 1, pieces: 84, tareEach: 42.5 }));
    const pages = textRunsWithY(await renderSheetGroups(buildTravelerDefinitions(example({ containers }))));
    // "totals" is the heading's second word, "Gross" the third line's first.
    const perPage = (word: string) => pages.map((runs) => runs.filter((run) => run.text.trim() === word).length);
    measured("80 container rows", { pages: pages.length, headings: perPage("totals"), gross: perPage("Gross"), rows: perPage("Basket") });
    // As measured: four pages, with the heading row once on each of the first three and none on the last.
    expect(perPage("totals")).toEqual([1, 1, 1, 0]);
    expect(perPage("Gross")).toEqual([1, ...pages.slice(1).map(() => 0)]);
  });
});

// #611: every load of one traveler print carries the same steps table and results block, and each
// was measured again, two complete renders a load. A measurement render is the one on an
// auto-height page, so it is counted at pdfmake's own entry point by its page height (a sheet's
// page is "LETTER" or a numeric size).
describe("one print measures its steps table and results block once (#611)", () => {
  const PdfPrinter = (PdfPrinterModule as unknown as { default?: typeof PdfPrinterModule }).default ?? PdfPrinterModule;
  async function measurements(run: () => Promise<unknown>): Promise<number> {
    const spy = vi.spyOn(PdfPrinter.prototype, "createPdfKitDocument");
    try {
      await run();
      // pdfmake rewrites an "auto" height to Infinity on the definition it is handed.
      return spy.mock.calls.filter(([def]) => {
        const size = (def as { pageSize?: unknown }).pageSize;
        return typeof size === "object" && size !== null && !Number.isFinite((size as { height?: unknown }).height);
      }).length;
    } finally {
      spy.mockRestore();
    }
  }
  const loads = (n: number) => {
    const fixture = data();
    fixture.sheets = Array.from({ length: n }, (_, i) =>
      ({ loadNumber: i + 1, loadQty: 2, loadWeight: 4, barcodeDataUri: BARCODE }));
    return fixture;
  };

  it("five loads take the two measurements of one load", async () => {
    expect(await measurements(() => renderSheetGroups(buildTravelerDefinitions(loads(1))))).toBe(2);
    expect(await measurements(() => renderSheetGroups(buildTravelerDefinitions(loads(5))))).toBe(2);
  });

  it("each print measures afresh: nothing is kept from one call to the next", async () => {
    await renderSheetGroups(buildTravelerDefinitions(loads(2)));
    expect(await measurements(() => renderSheetGroups(buildTravelerDefinitions(loads(2))))).toBe(2);
  });

  it("a page-tall step is still split on every load, from the one measurement", async () => {
    const fixture = loads(3);
    fixture.steps = [
      { position: 1, codeName: "Preheat", instruction: "Warm the furnace to the setpoint.", values: [] },
      {
        position: 2, codeName: "Long Soak",
        instruction: Array.from({ length: 90 }, (_, i) => `Soak line ${i + 1} of the extended hold.`).join("\n"),
        values: [],
      },
    ];
    let pdf: Buffer = Buffer.alloc(0);
    expect(await measurements(async () => { pdf = await renderSheetGroups(buildTravelerDefinitions(fixture)); })).toBe(2);
    const one = pageCount(await renderSheetGroups(buildTravelerDefinitions({ ...fixture, sheets: fixture.sheets.slice(0, 1) })));
    expect(one).toBeGreaterThan(1);
    expect(pageCount(pdf)).toBe(3 * one);
  });
});
