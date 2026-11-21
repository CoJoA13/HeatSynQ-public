import { setTimeout as delay } from "node:timers/promises";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Prisma } from "../prisma/generated/prisma/client";
import { prisma, truncateAll, templateVersionId, seedOrderGatePrereqs } from "./helpers/db";
import {
  TINY_JPEG, danglingSMaskRefs, drawnPages, drawnText, imageObjectCount, pageCount, paintedImageCounts,
  parseObjects, tinyAlphaPng,
} from "./helpers/pdf";
import { runWithContext } from "@/server/context";
import { HttpError } from "@/server/errors";
import { createOrder } from "@/server/orders";
import { storeDocument } from "@/server/documents";
import * as documents from "@/server/documents";
import { createTemplate, editDraft, openDraft, publishDraft, uploadLogo } from "@/server/templates";
import { assignTemplate } from "@/server/template-assignments";
import { barcodePng, pngDataUri, renderPdf } from "@/server/pdf/render";
import * as pdfRenderer from "@/server/pdf/render";
import {
  buildTravelerDefinition, buildTravelerDefinitions, collectTravelerData, printTraveler,
  type TravelerData,
} from "@/server/traveler";
import {
  TRAVELER_DEFAULT_CONFIG, normalizeStoredConfig, validateConfig, type TemplateConfig,
} from "@/lib/template-contracts/index";
import { tableHeaded } from "./helpers/definition-text";
import { publishStored, seedLiteral, storedBefore } from "./helpers/stored-configs";
import { CEILING_LB, ORDER_1031 } from "./helpers/weights-examples";
import { RULE } from "./helpers/traveler-header";
import { standardLayout } from "./helpers/canvas-fixtures";

/**
 * Phase 7 Task 7 — the traveler conversion and the stamp plumbing: `storeDocument`'s optional
 * `templateVersionId` (the plumbing Tasks 8–14 reuse), `buildTravelerDefinition(data, config)`
 * consuming the backfilled TemplateConfig, and `printTraveler` resolving its template on its own
 * claimed transaction. The GOLDEN-COMPAT gate lives in tests/traveler.test.ts, which this task
 * leaves untouched — everything here is the config-driven half.
 */

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

/** A minimal single-load order (loadQty ≥ qty → exactly one load, one traveler sheet).
 *  A smaller `loadQty` splits it — `loadQty: 5` against the qty of 10 gives two loads. */
async function miniOrder(partExtra: { processName?: string; loadQty?: number } = {}) {
  const customer = await prisma.customer.create({ data: { code: "TPL", name: "Template Test Co" } });
  const code = await prisma.processStepCode.create({ data: { code: "AUS", name: "Austemper" } });
  const part = await prisma.part.create({
    data: {
      customerId: customer.id, partNumber: "TPL-1", name: "Template Part",
      eachWeight: "1.0000", loadQty: 100, ...partExtra,
    },
  });
  const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Pre-heat, then quench." },
  });
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, lines: [{ partId: part.id, qty: 10, weight: "10.00" }],
  }));
  return { customer, part, order };
}

// ------------------------------------------------------------------------------------------------
// The stamp plumbing (brief item 1): storeDocument's optional templateVersionId
// ------------------------------------------------------------------------------------------------

describe("storeDocument — the templateVersionId stamp", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("a stored row carries the template version id it was given", async () => {
    const { order } = await miniOrder();
    const pdf = await renderPdf({ content: [{ text: "stamped" }] });
    const meta = await asSystem(() => prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "TRAVELER", orderId: order.id, loadNumber: null }, pdf,
        templateVersionId("TRAVELER"))));

    const row = await prisma.storedDocument.findUnique({
      where: { id: meta.id }, select: { templateVersionId: true },
    });
    expect(row!.templateVersionId).toBe("standard-traveler-v1");
  });

  it("omitting the stamp stores null — the pre-Phase-7 call shape is untouched", async () => {
    const { order } = await miniOrder();
    const pdf = await renderPdf({ content: [{ text: "unstamped" }] });
    const meta = await asSystem(() => prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "TRAVELER", orderId: order.id, loadNumber: null }, pdf)));

    const row = await prisma.storedDocument.findUnique({
      where: { id: meta.id }, select: { templateVersionId: true },
    });
    expect(row!.templateVersionId).toBeNull();
  });

  it("the stamp rides in the audit payload as metadata — never the bytes", async () => {
    const { order } = await miniOrder();
    const pdf = await renderPdf({ content: [{ text: "audited" }] });
    const meta = await asSystem(() => prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "TRAVELER", orderId: order.id, loadNumber: null }, pdf,
        templateVersionId("TRAVELER"))));

    const entry = await prisma.auditLog.findFirst({
      where: { entity: "storedDocument", entityId: meta.id, action: "create" },
    });
    expect(entry).not.toBeNull();
    const after = entry!.after as Record<string, unknown>;
    expect(after.templateVersionId).toBe("standard-traveler-v1");
    expect(JSON.stringify(after)).not.toContain("%PDF");
  });
});

// ------------------------------------------------------------------------------------------------
// buildTravelerDefinition(data, config) — pure config consumption (brief item 2)
// ------------------------------------------------------------------------------------------------

// Real barcodes (pdfkit parses image data, so even definition-only fixtures carry genuine PNGs);
// the LOGO uri is distinct from the barcode's so placement assertions can tell them apart.
const BARCODE = pngDataUri(await barcodePng("91246"));
const LOGO_URI = pngDataUri(await barcodePng("LOGO"));

/** A hand-built, DB-free TravelerData — `buildTravelerDefinition` is pure, so the config tests
 *  need no database at all. Shapes mirror tests/traveler.test.ts's mockup fixture. */
function travelerData(overrides: Partial<TravelerData> = {}): TravelerData {
  return {
    orderNumber: 91246,
    poNumber: "",
    customerName: "Demo Castings Group",
    receivedFrom: ["200 Demo Drive", "Anniston, AL 36206"],
    customerPhone: "",
    company: { name: "Example Heat Treating", address: "1 Furnace Rd", phone: "256-555-0101" },
    lines: [{
      qty: 4500, partNumber: "DEMO-PL-2001", partName: "U Bolt Rear Spr Plate",
      description: "Machined", eachWeight: 13.5, lineWeight: 60750,
    }],
    orderQty: 4500,
    // The mockup's 8 drop pans as a row now reads: 320 pieces in all (the 40 a pan this fixture
    // used to state), and 367 lb each empty. 8 × 367 is the mockup's 2,936 lb of tare.
    containers: [{ typeName: "Drop Pan", count: 8, pieces: 320, tareEach: 367 }],
    materialName: "Ductile Iron",
    processId: "DEMO-PL-2001",
    inspections: [{ code: "Hardness", scale: "HBW", min: 269, max: 341, sampleQty: "8", location: "flange OD" }],
    revisionNumber: 1,
    steps: [{
      position: 1, codeName: "Austemper", instruction: "Pre-heat to 1100F.",
      values: [{ label: "Furnace Temp", value: "1650", unit: "°F" }],
    }],
    sheets: [{ loadNumber: 1, loadQty: 336, loadWeight: 4536, barcodeDataUri: BARCODE }],
    processName: "",
    ...overrides,
  };
}

const cfg = (): TemplateConfig => structuredClone(TRAVELER_DEFAULT_CONFIG);
/** Round-trips a tweaked config through the REAL validator — every config a test feeds the
 *  builder (belt tests excepted, deliberately) is one a template could actually store. */
const checked = (c: TemplateConfig): TemplateConfig => validateConfig("TRAVELER", c);
const sectionOf = (c: TemplateConfig, key: string) => c.sections.find((s) => s.key === key)!;
const fieldOf = (c: TemplateConfig, section: string, key: string) =>
  sectionOf(c, section).fields.find((f) => f.key === key)!;

/** Every `text` string/number in a definition, flattened — the traveler.test.ts walker. */
function allText(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined) return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) allText(n, out); return out; }
  if (typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "image") continue;
      allText(value, out);
    }
  }
  return out;
}
const textOf = (def: unknown): string => allText(def).join("\n");

/** Every node in a definition matching `pred` — structural assertions (font sizes, widths). */
function findNodes(node: unknown, pred: (n: Record<string, unknown>) => boolean,
  out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) { for (const n of node) findNodes(n, pred, out); return out; }
  const obj = node as Record<string, unknown>;
  if (pred(obj)) out.push(obj);
  for (const value of Object.values(obj)) findNodes(value, pred, out);
  return out;
}

/** Every table's `widths` array in the definition. */
function allWidths(def: unknown): (number | string)[][] {
  return findNodes(def, (n) => typeof n.table === "object" && n.table !== null)
    .map((n) => (n.table as { widths?: (number | string)[] }).widths)
    .filter((w): w is (number | string)[] => Array.isArray(w));
}

/** The quantities table's data rows: the one table whose header row holds "Order Quantity". */
function quantityRows(def: unknown): unknown[][] {
  const [node] = findNodes(def, (n) => {
    const body = (n.table as { body?: unknown[][] } | undefined)?.body;
    return Array.isArray(body) && Array.isArray(body[0])
      && body[0].some((c) => (c as { text?: unknown } | null)?.text === "Order Quantity");
  });
  return (node.table as { body: unknown[][] }).body.slice(1);
}

/** A cell's own `text` strings, top line first. The empty cell under a spanned one gives none. */
const cellTexts = (cell: unknown): string[] =>
  findNodes(cell, (n) => typeof n.text === "string").map((n) => n.text as string);

/** The owner's example order as a sheet's data (the weights design §13.2): two lines of 1,280 and
 *  320 lb, 300 pieces, in 3 Steel Baskets of 252 pieces at 42.5 lb each, on one load. */
function exampleSheet(overrides: Partial<TravelerData> = {}): TravelerData {
  return travelerData({
    orderNumber: ORDER_1031.number,
    lines: ORDER_1031.lines.map((l, i) => ({
      qty: l.qty, partNumber: `DEMO-${i + 1}`, partName: "Ring gear", description: "Machined",
      eachWeight: l.eachWeight, lineWeight: l.weight,
    })),
    orderQty: 300,
    containers: ORDER_1031.containers.map((row) => ({ ...row })),
    sheets: [{ loadNumber: 1, loadQty: 300, loadWeight: 1600, barcodeDataUri: BARCODE }],
    ...overrides,
  });
}
const THREE_LINES = ["Net 1,600 lb", "Tare 127.5 lb", "Gross 1,727.5 lb"];
/** A table's heading row, as the text of each cell. */
const headingsOf = (table: { body: unknown[][] }) => table.body[0].map((c) => cellTexts(c)[0]);

describe("buildTravelerDefinition — config-driven sections, fields, labels, widths", () => {
  it("a hidden section is omitted from the stack", () => {
    const c = cfg();
    sectionOf(c, "footer").visible = false;
    const text = textOf(buildTravelerDefinition(travelerData(), checked(c)));
    expect(text).not.toContain("RESULTS:");
    expect(text).not.toContain("Tested By:");
    // …and the default config still prints the whole sign-off block.
    const dflt = textOf(buildTravelerDefinition(travelerData(), cfg()));
    expect(dflt).toContain("TEMPERED RESULTS:");
    expect(dflt).toContain("Tested By:");
  });

  it("stack order follows the config's section order", () => {
    const c = cfg();
    const i = c.sections.findIndex((s) => s.key === "process");
    const j = c.sections.findIndex((s) => s.key === "inspections");
    [c.sections[i], c.sections[j]] = [c.sections[j], c.sections[i]];
    const text = textOf(buildTravelerDefinition(travelerData(), checked(c)));
    expect(text.indexOf("Key Characteristic Inspection(s):"))
      .toBeLessThan(text.indexOf("Process ID:"));
    // …the default order is the other way around.
    const dflt = textOf(buildTravelerDefinition(travelerData(), cfg()));
    expect(dflt.indexOf("Process ID:"))
      .toBeLessThan(dflt.indexOf("Key Characteristic Inspection(s):"));
  });

  it("a hidden field drops its column — header cell and width both", () => {
    const c = cfg();
    fieldOf(c, "lines", "line_each_weight").visible = false;
    const def = buildTravelerDefinition(travelerData(), checked(c));
    // The heading row whole: three cells, and none is the hidden column's.
    expect(tableHeaded(def, "Part Quantity").body[0].map(cellTexts))
      .toEqual([["Part Quantity"], ["Part Number / Part Name / Description"], ["Net weight"]]);
    expect(allWidths(def)).toContainEqual([78, "*", 88]);
  });

  it("field order follows the config within its section", () => {
    const c = cfg();
    const lines = sectionOf(c, "lines");
    const weight = lines.fields.find((f) => f.key === "line_weight")!;
    lines.fields = [weight, ...lines.fields.filter((f) => f.key !== "line_weight")];
    const def = buildTravelerDefinition(travelerData(), checked(c));
    expect(tableHeaded(def, "Part Quantity").body[0].map(cellTexts))
      .toEqual([["Net weight"], ["Part Quantity"], ["Part Number / Part Name / Description"], ["Each weight"]]);
  });

  it("a label override prints in place of the contract default", () => {
    const c = cfg();
    fieldOf(c, "lines", "line_qty").label = "Pieces";
    const text = textOf(buildTravelerDefinition(travelerData(), checked(c)));
    expect(text).toContain("Pieces");
    expect(text).not.toContain("Part Quantity");
  });

  it("a width override lands in the table's widths array", () => {
    const c = cfg();
    fieldOf(c, "lines", "line_qty").width = 100;
    const def = buildTravelerDefinition(travelerData(), checked(c));
    expect(allWidths(def)).toContainEqual([100, "*", 78, 88]);
  });

  it("thousandsSeparator: false ungroups every number the sheet prints", () => {
    const c = cfg();
    c.formats.thousandsSeparator = false;
    const plain = buildTravelerDefinition(travelerData(), checked(c));
    expect(textOf(plain)).toContain("4500");
    expect(textOf(plain)).not.toContain("4,500");
    const dflt = buildTravelerDefinition(travelerData(), cfg());
    expect(textOf(dflt)).toContain("4,500");
    // Every weight takes the same knob, each read as a whole cell: the line's net weight, the
    // row's tare total and the order's three lines. No cell has a number format of its own.
    const weights = (def: unknown) => {
      const [row] = quantityRows(def); // its fifth and sixth cells: tare_weight, gross_weight
      return [cellTexts(tableHeaded(def, "Part Quantity").body[1][3]), cellTexts(row[4]), cellTexts(row[5])];
    };
    expect(weights(plain)).toEqual([["60750 lb"], ["2936 lb", "367 lb each"], ["Net 60750 lb", "Tare 2936 lb", "Gross 63686 lb"]]);
    expect(weights(dflt)).toEqual([["60,750 lb"], ["2,936 lb", "367 lb each"], ["Net 60,750 lb", "Tare 2,936 lb", "Gross 63,686 lb"]]);
  });
});

describe("buildTravelerDefinition — fonts from config", () => {
  const fontConfig = () => {
    const c = cfg();
    c.fonts = { family: "Liberation Sans", baseSize: 10, headingSize: 14, smallSize: 5 };
    return checked(c);
  };

  it("family and role sizes map into the definition", () => {
    const data = travelerData();
    const def = buildTravelerDefinition(data, fontConfig());
    expect(def.defaultStyle).toEqual({ font: "Liberation Sans", fontSize: 10 });
    // headingSize drives the company-name line; smallSize the sub-annotations.
    const company = findNodes(def, (n) => n.text === data.company.name);
    expect(company[0].fontSize).toBe(14);
    const pieces = findNodes(def, (n) => typeof n.text === "string" && n.text.endsWith(" pcs"));
    expect(pieces[0].fontSize).toBe(5);
    const tareEach = findNodes(def, (n) => typeof n.text === "string" && n.text.endsWith(" lb each"));
    expect(tareEach[0].fontSize).toBe(5);
  });

  it("the switch is visible in the rendered bytes — embedded family + Tf size", async () => {
    const pdf = await renderPdf(buildTravelerDefinition(travelerData(), fontConfig()));
    expect(pdf.toString("latin1")).toContain("LiberationSans");
    const streams = [...parseObjects(pdf).values()]
      .map((o) => o.stream?.toString("latin1") ?? "").join("\n");
    expect(streams).toMatch(/\s10 Tf/);
    expect(drawnText(pdf)).toContain("Demo Castings Group");

    // …and the default still renders Roboto at 8pt.
    const dflt = await renderPdf(buildTravelerDefinition(travelerData(), cfg()));
    expect(dflt.toString("latin1")).toContain("Roboto");
    const dfltStreams = [...parseObjects(dflt).values()]
      .map((o) => o.stream?.toString("latin1") ?? "").join("\n");
    expect(dfltStreams).toMatch(/\s8 Tf/);
  });
});

describe("buildTravelerDefinition: the container cells of the quantities row (weights design §9.4 and §13)", () => {
  // The default column order: order_qty, load_qty, container, container_qty, tare_weight, gross_weight.
  const LOAD = 1, CONTAINER = 2, COUNT = 3, TARE = 4, GROSS = 5;
  const TWO_ROWS = [2, 1].map((count) => ({ typeName: "Steel Basket", count, pieces: 84 * count, tareEach: 42.5 })); // the same 3 baskets as two rows

  it("prints the row's pieces, its tare total over its tare each, and the order's net, tare and gross", () => {
    // The owner's example (the weights design §13.2): two lines of 1,280 and 320 lb in 3 baskets at 42.5 lb.
    const rows = quantityRows(buildTravelerDefinition(exampleSheet()));
    expect(rows).toHaveLength(1);
    expect(cellTexts(rows[0][CONTAINER])).toEqual(["Steel Basket", "252 pcs"]);
    expect(cellTexts(rows[0][COUNT])).toEqual(["3"]);
    expect(cellTexts(rows[0][TARE])).toEqual(["127.5 lb", "42.5 lb each"]);
    expect(cellTexts(rows[0][GROSS])).toEqual(THREE_LINES);
  });

  it("prints the row's two small lines in the sheet's number format: grouped by the thousands knob, plain without it", () => {
    // Pieces and the tare each are both 1,000 or more, so each of the four figures shows the knob.
    // 2 bins at 1,250.5 lb are 2,501 lb, and 60,750 + 2,501 is 63,251.
    const data = travelerData({ containers: [{ typeName: "Bin", count: 2, pieces: 4500, tareEach: 1250.5 }] });
    const grouped = quantityRows(buildTravelerDefinition(data, cfg()));
    expect(cellTexts(grouped[0][CONTAINER])).toEqual(["Bin", "4,500 pcs"]);
    expect(cellTexts(grouped[0][TARE])).toEqual(["2,501 lb", "1,250.5 lb each"]);
    expect(cellTexts(grouped[0][GROSS])).toEqual(["Net 60,750 lb", "Tare 2,501 lb", "Gross 63,251 lb"]);
    const ungrouped = cfg();
    ungrouped.formats.thousandsSeparator = false;
    const plain = quantityRows(buildTravelerDefinition(data, checked(ungrouped)));
    expect(cellTexts(plain[0][CONTAINER])).toEqual(["Bin", "4500 pcs"]);
    expect(cellTexts(plain[0][TARE])).toEqual(["2501 lb", "1250.5 lb each"]);
    expect(cellTexts(plain[0][GROSS])).toEqual(["Net 60750 lb", "Tare 2501 lb", "Gross 63251 lb"]);
  });

  it("prints the type and the count alone for a row with no pieces and no tare each, and no order tare or gross", () => {
    const rows = quantityRows(buildTravelerDefinition(travelerData({
      containers: [{ typeName: "Skid", count: 3, pieces: null, tareEach: null }],
    })));
    expect(cellTexts(rows[0][CONTAINER])).toEqual(["Skid"]);
    expect(cellTexts(rows[0][COUNT])).toEqual(["3"]);
    expect(cellTexts(rows[0][TARE])).toEqual([""]);
    expect(cellTexts(rows[0][GROSS])).toEqual(["Net 60,750 lb", "Tare", "Gross"]);
  });

  it("prints a tare total on the row that has a tare each, and no order tare or gross while another row has none", () => {
    // 14 bins at 310 lb are 4,340 lb. The basket has no tare each, so the order has no gross:
    // 60,750 + 4,340 would be a partial sum.
    const rows = quantityRows(buildTravelerDefinition(travelerData({
      containers: [
        { typeName: "Bin", count: 14, pieces: null, tareEach: 310 },
        { typeName: "Wire Basket", count: 1, pieces: 15, tareEach: null },
      ],
    })));
    expect(rows).toHaveLength(2);
    expect(cellTexts(rows[0][TARE])).toEqual(["4,340 lb", "310 lb each"]);
    expect(cellTexts(rows[0][GROSS])).toEqual(["Net 60,750 lb", "Tare", "Gross"]);
    expect(cellTexts(rows[1][CONTAINER])).toEqual(["Wire Basket", "15 pcs"]);
    expect(cellTexts(rows[1][TARE])).toEqual([""]);
    // The gross cell spans the rows from the first, so the second row's own cell is empty.
    expect(rows[1][GROSS]).toEqual({});
  });

  it("prints one blank row, and the order's net alone, for an order with no container rows", () => {
    const rows = quantityRows(buildTravelerDefinition(travelerData({ containers: [] })));
    expect(rows).toHaveLength(1);
    for (const column of [CONTAINER, COUNT, TARE]) {
      expect(cellTexts(rows[0][column]), `column ${column}`).toEqual([""]);
    }
    expect(cellTexts(rows[0][GROSS])).toEqual(["Net 60,750 lb", "Tare", "Gross"]);
  });

  it("counts a tare each of 0 as a tare each: 0 lb over 0 lb each, and a gross equal to net", () => {
    const rows = quantityRows(buildTravelerDefinition(travelerData({
      containers: [{ typeName: "Rack", count: 2, pieces: null, tareEach: 0 }],
    })));
    expect(cellTexts(rows[0][TARE])).toEqual(["0 lb", "0 lb each"]);
    expect(cellTexts(rows[0][GROSS])).toEqual(["Net 60,750 lb", "Tare 0 lb", "Gross 60,750 lb"]);
  });

  it("prints an empty first line over the tare each, and no order tare or gross, when the row's tare total is past the ceiling", () => {
    // 2 × 9,999,999,999.99 lb is past the largest weight the calculation returns.
    const rows = quantityRows(buildTravelerDefinition(travelerData({
      containers: [{ typeName: "Drop Pan", count: 2, pieces: null, tareEach: 9_999_999_999.99 }],
    })));
    expect(cellTexts(rows[0][TARE])).toEqual(["", "9,999,999,999.99 lb each"]);
    expect(cellTexts(rows[0][GROSS])).toEqual(["Net 60,750 lb", "Tare", "Gross"]);
  });

  it("builds the Order totals cell whole: centred, in the sheet's ordinary type, spanned over the container rows, with an empty cell under it", () => {
    const stack = THREE_LINES.map((text) => ({ text }));
    const [only] = quantityRows(buildTravelerDefinition(exampleSheet()));
    expect(only[GROSS]).toEqual({ alignment: "center", rowSpan: 1, stack });
    const two = quantityRows(buildTravelerDefinition(exampleSheet({ containers: TWO_ROWS })));
    expect(two[0][GROSS]).toEqual({ alignment: "center", rowSpan: 2, stack });
    expect(two[1][GROSS]).toEqual({});
  });

  it("prints each row's own tare total beside two container rows, and the order's tare once", () => {
    const rows = quantityRows(buildTravelerDefinition(exampleSheet({ containers: TWO_ROWS })));
    expect(rows.map((row) => cellTexts(row[TARE]))).toEqual([["85 lb", "42.5 lb each"], ["42.5 lb", "42.5 lb each"]]);
    expect(cellTexts(rows[0][GROSS])).toEqual(THREE_LINES);
  });

  it.each<[state: string, weights: number[], lines: string[]]>([
    ["the word alone for a net past the ceiling", [CEILING_LB, 0.01], ["Net", "Tare 127.5 lb", "Gross"]],
    ["the net and the tare beside a bare Gross when the two together pass the ceiling", [CEILING_LB],
      ["Net 9,999,999,999.99 lb", "Tare 127.5 lb", "Gross"]],
  ])("prints %s", (_state, weights, lines) => {
    const line = exampleSheet().lines[0];
    const rows = quantityRows(buildTravelerDefinition(exampleSheet({ lines: weights.map((lineWeight) => ({ ...line, lineWeight })) })));
    expect(cellTexts(rows[0][GROSS])).toEqual(lines);
  });

  it("prints the order's three lines on every load's sheet, beside that load's own quantity and weight", () => {
    // Two loads of 150 pieces and 800 lb, and a sheet with no load, as an order with no loads prints.
    const defs = buildTravelerDefinitions(exampleSheet({ sheets: [
      { loadNumber: 1, loadQty: 150, loadWeight: 800, barcodeDataUri: BARCODE },
      { loadNumber: 2, loadQty: 150, loadWeight: 800, barcodeDataUri: BARCODE },
      { loadNumber: null, loadQty: null, loadWeight: null, barcodeDataUri: BARCODE },
    ] }));
    const rows = defs.map((def) => quantityRows(def.content)[0]);
    expect(rows.map((row) => cellTexts(row[LOAD]))).toEqual([["150", "800 lb"], ["150", "800 lb"], [""]]);
    expect(rows.map((row) => cellTexts(row[GROSS]))).toEqual([THREE_LINES, THREE_LINES, THREE_LINES]);
  });
});

describe("buildTravelerDefinition: the part lines' weights carry their unit (weights design §13, W15)", () => {
  // The default column order: line_qty, line_part, line_each_weight, line_weight.
  const weightCells = (data: TravelerData) => tableHeaded(buildTravelerDefinition(data), "Part Quantity").body.slice(1)
    .map((row) => [cellTexts(row[2]), cellTexts(row[3])]);

  it("prints each line's each weight and net weight with the unit", () => {
    expect(weightCells(exampleSheet())).toEqual([[["6.4 lb"], ["1,280 lb"]], [["3.2 lb"], ["320 lb"]]]);
  });

  it("prints a light part's each weight in the sheet's two decimals, and a missing figure as a blank with no unit", () => {
    const line = exampleSheet().lines[0];
    expect(weightCells(exampleSheet({ lines: [
      { ...line, eachWeight: 0.0049, lineWeight: 0.49 }, { ...line, eachWeight: null, lineWeight: null },
    ] }))).toEqual([[["0 lb"], ["0.49 lb"]], [[""], [""]]]);
  });
});

describe("buildTravelerDefinition: stored templates in today's shape and the Order totals column (W14; answer 4 of 2026-10-11)", () => {
  const stored = (name: string) => normalizeStoredConfig("TRAVELER", storedBefore("TRAVELER", name));
  const quantities = (config: TemplateConfig) => tableHeaded(buildTravelerDefinition(exampleSheet(), config), "Order Quantity");
  const FIVE = ["Order Quantity", "Load Quantity", "Container", "Containers", "Tare"];

  it("heads the column Order totals where the stored label is empty", () => {
    const table = quantities(normalizeStoredConfig("TRAVELER", seedLiteral("TRAVELER")));
    expect(headingsOf(table)).toEqual([...FIVE, "Order totals"]);
    expect(cellTexts(table.body[1][5])).toEqual(THREE_LINES);
  });

  it.each<[name: string, heading: string, column: number, lineHeading: string, lineCell: string]>([
    ["typed-labels", "Gross Wt", 3, "Line Wt", "1,280 lb"],
    ["old-wording-typed", "Gross Weight", 2, "Part Weight", "6.4 lb"],
  ])("keeps the label typed in %s over the three lines, and prints the unit under a typed label", (name, heading, column, lineHeading, lineCell) => {
    const def = buildTravelerDefinition(exampleSheet(), stored(name));
    const table = tableHeaded(def, "Order Quantity");
    expect(headingsOf(table)).toEqual([...FIVE, heading]);
    expect(cellTexts(table.body[1][5])).toEqual(THREE_LINES);
    const lines = tableHeaded(def, "Part Quantity");
    expect([cellTexts(lines.body[0][column]), cellTexts(lines.body[1][column])]).toEqual([[lineHeading], [lineCell]]);
  });

  it("prints no order totals where the stored template hid the column", () => {
    const table = quantities(stored("gross-hidden"));
    expect(headingsOf(table)).toEqual(FIVE);
    expect(table.body[1].flatMap((c) => cellTexts(c)))
      .toEqual(["300", "300", "1,600 lb", "Steel Basket", "252 pcs", "3", "127.5 lb", "42.5 lb each"]);
  });

  it("prints no quantities table, and so no order totals, where the stored template hid the section", () => {
    const def = buildTravelerDefinition(exampleSheet(), stored("quantities-hidden"));
    expect(() => tableHeaded(def, "Order Quantity")).toThrow();
    expect(allText(def).filter((text) => THREE_LINES.includes(text))).toEqual([]);
  });

  it("follows a stored width and a stored column order", () => {
    const narrow = quantities(stored("gross-width-50"));
    expect(narrow.widths).toEqual([78, 78, "*", 88, 78, 50]);
    expect(cellTexts(narrow.body[1][5])).toEqual(THREE_LINES);
    const first = quantities(stored("gross-moved-first"));
    expect(headingsOf(first)).toEqual(["Order totals", ...FIVE]);
    expect(cellTexts(first.body[1][0])).toEqual(THREE_LINES);
  });
});

describe("buildTravelerDefinition — the §5.6 builder-side belt (locked elements render regardless)", () => {
  it("a config hiding the steps section is refused by the validator AND still renders through the builder", () => {
    const c = cfg();
    sectionOf(c, "steps").visible = false;
    expect(() => validateConfig("TRAVELER", c)).toThrow(/cannot be hidden/);
    // Fed RAW past the validator — the belt, not the validator, is what this pins.
    const text = textOf(buildTravelerDefinition(travelerData(), c));
    expect(text).toContain("PROCESS STEPS:");
    expect(text).toContain("Austemper");
    expect(text).toContain("Furnace Temp: 1650 °F");
  });

  it("a config hiding the barcode still renders it", () => {
    const c = cfg();
    fieldOf(c, "header", "barcode").visible = false;
    expect(() => validateConfig("TRAVELER", c)).toThrow(/cannot be hidden/);
    const def = buildTravelerDefinition(travelerData(), c);
    expect(JSON.stringify(def)).toContain(BARCODE);
  });

  it("a config hiding the header section still renders it (the barcode lives there)", () => {
    const c = cfg();
    sectionOf(c, "header").visible = false;
    expect(() => validateConfig("TRAVELER", c)).toThrow(/cannot be hidden/);
    const def = buildTravelerDefinition(travelerData(), c);
    expect(JSON.stringify(def)).toContain(BARCODE);
    expect(textOf(def)).toContain("Order Number");
  });

  // The belt's OMISSION half (Task 8 pre-step, carried from the Task 7 review): the flag belt
  // above only forces entries that are PRESENT — a validator-bypassing config that simply OMITS
  // the entry used to drop the locked element. The builder now resolves its views over
  // `completeSections(TRAVELER_CONTRACT, config.sections)`, so omission cannot drop anything.
  // (The validator's §5.3 backfill re-inserts missing entries in every STORED config — like the
  // flag cases above, these feed the builder RAW, deliberately.)
  it("a raw config OMITTING the steps section entry still renders the steps", () => {
    const c = cfg();
    c.sections = c.sections.filter((s) => s.key !== "steps");
    const text = textOf(buildTravelerDefinition(travelerData(), c));
    expect(text).toContain("PROCESS STEPS:");
    expect(text).toContain("Austemper");
    expect(text).toContain("Pre-heat to 1100F.");
    expect(text).toContain("Furnace Temp: 1650 °F");
  });

  it("a raw config OMITTING a locked field entry still renders it", () => {
    const c = cfg();
    const steps = sectionOf(c, "steps");
    steps.fields = steps.fields.filter((f) => f.key !== "step_instruction");
    const def = buildTravelerDefinition(travelerData(), c);
    const text = textOf(def);
    // The instruction column (and the locked typed-value rendering inside it) is back on paper —
    // appended after the config's own run, so presence is the assertion, not position.
    expect(text).toContain("Pre-heat to 1100F.");
    expect(text).toContain("Furnace Temp: 1650 °F");
    const stepsWidths = allWidths(def).find((w) => w.includes(16) && w.includes(62))!;
    expect(stepsWidths).toContain("*");
  });

  it("a raw config OMITTING the header section still renders the barcode and order number", () => {
    const c = cfg();
    c.sections = c.sections.filter((s) => s.key !== "header");
    const def = buildTravelerDefinition(travelerData(), c);
    expect(JSON.stringify(def)).toContain(BARCODE);
    expect(textOf(def)).toContain("Order Number");
  });
});

describe("buildTravelerDefinition — the Process: slot (ruling 4, spec §5.7)", () => {
  // The walker flattens each cell as [text, alignment], so the slot's VALUE sits two entries
  // after its label: ["Process:", "center", <value>, "center", "Material:", …].
  it("prints data.processName in the slot when set", () => {
    const arr = allText(buildTravelerDefinition(travelerData({ processName: "Marquench + Temper" })));
    expect(arr[arr.indexOf("Process:") + 2]).toBe("Marquench + Temper");
  });

  it("blank renders exactly today's empty slot", () => {
    const arr = allText(buildTravelerDefinition(travelerData()));
    expect(arr[arr.indexOf("Process:") + 2]).toBe("");
  });
});

describe("buildTravelerDefinition — logo placement (spec §6.3)", () => {
  const placedConfig = (placement: "header-left" | "header-center" | "header-right") => {
    const c = cfg();
    c.logo = { placement, width: 120 };
    return checked(c);
  };
  /** The header's three column stacks, structurally. */
  const headerStacks = (def: unknown): { image?: string; width?: number }[][] => {
    const sheet = (def as { content: { stack: { columns: { stack: never[] }[] }[] }[] }).content[0];
    return sheet.stack[0].columns.map((col) => col.stack);
  };

  it.each([["header-left", 0], ["header-center", 1], ["header-right", 2]] as const)(
    "a placed logo joins the %s slot at its configured width", (placement, colIdx) => {
      const def = buildTravelerDefinition(travelerData(), placedConfig(placement), LOGO_URI);
      const stacks = headerStacks(def);
      expect(stacks[colIdx][0]).toEqual({ image: LOGO_URI, width: 120 });
      // The barcode is untouched by the logo.
      expect(JSON.stringify(def)).toContain(BARCODE);
    });

  it("config placement without bytes, and bytes without placement, both fall back to the text-only header", () => {
    // Placed in config, but the resolved version carries no bytes → no logo node.
    const placed = buildTravelerDefinition(travelerData(), placedConfig("header-center"));
    expect(JSON.stringify(placed)).not.toContain(LOGO_URI);
    // Bytes supplied, but the config places no logo → no logo node.
    const unplaced = buildTravelerDefinition(travelerData(), cfg(), LOGO_URI);
    expect(JSON.stringify(unplaced)).not.toContain(LOGO_URI);
  });
});

describe("buildTravelerDefinition — purity, config included", () => {
  it("a config-driven definition survives the JSON round trip and is deterministic", () => {
    const c = cfg();
    c.logo = { placement: "header-center", width: 120 };
    fieldOf(c, "lines", "line_qty").label = "Pieces";
    const config = checked(c);
    const def = buildTravelerDefinition(travelerData(), config, LOGO_URI);
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
    expect(buildTravelerDefinition(travelerData(), config, LOGO_URI)).toEqual(def);
  });
});

// ------------------------------------------------------------------------------------------------
// readTravelerData — processName binds LIVE from the lead part (ruling 4, spec §5.7)
// ------------------------------------------------------------------------------------------------

describe("readTravelerData — processName", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("reads the lead part's processName and prints it", async () => {
    const { order } = await miniOrder({ processName: "Marquench + Temper" });
    const data = await asSystem(() => collectTravelerData(order.id));
    expect(data.processName).toBe("Marquench + Temper");
    expect(textOf(buildTravelerDefinition(data))).toContain("Marquench + Temper");
  });

  it("a part without one keeps today's blank slot", async () => {
    const { order } = await miniOrder();
    const data = await asSystem(() => collectTravelerData(order.id));
    expect(data.processName).toBe("");
  });

  it("binds LIVE at render — a later part edit changes the NEXT print's slot", async () => {
    const { order, part } = await miniOrder();
    await prisma.part.update({ where: { id: part.id }, data: { processName: "Austemper" } });
    const data = await asSystem(() => collectTravelerData(order.id));
    expect(data.processName).toBe("Austemper");
  });
});

// ------------------------------------------------------------------------------------------------
// printTraveler — resolution on the claimed tx + the stamp (brief item 3)
// ------------------------------------------------------------------------------------------------

/** Image XObjects in the stored bytes — dict headers are plain text even when the pixel data is
 *  compressed, so a logo shows up as a second image beside the per-sheet barcode. A PNG with an
 *  alpha channel embeds as TWO objects (the image + its /SMask), so SMask children are excluded:
 *  this counts PICTURES on the paper, not XObjects in the file. */
const countImages = (pdf: Buffer): number => {
  const objs = parseObjects(pdf);
  const smasks = new Set<number>();
  for (const o of objs.values()) {
    for (const m of o.body.matchAll(/\/SMask\s+(\d+)\s+0\s+R/g)) smasks.add(Number(m[1]));
  }
  return [...objs.entries()]
    .filter(([num, o]) => /\/Subtype\s*\/Image/.test(o.body) && !smasks.has(num)).length;
};

async function stampOf(documentId: string): Promise<string | null> {
  const row = await prisma.storedDocument.findUnique({
    where: { id: documentId }, select: { templateVersionId: true },
  });
  return row!.templateVersionId;
}

describe("printTraveler — template resolution and the version stamp", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  /** Create → tweak the v1 draft → (optionally logo) → publish. Returns the published version. */
  async function publishCustom(
    tweak: (c: TemplateConfig) => void, logo?: { data: Buffer; mime: string },
  ) {
    const t = await asSystem(() => createTemplate("TRAVELER", "Custom"));
    const c = cfg();
    tweak(c);
    await asSystem(() => editDraft(t.id, { config: c, updatedAt: t.draft.updatedAt }));
    if (logo) await asSystem(() => uploadLogo(t.id, logo.data, logo.mime));
    const { versionId } = await asSystem(() => publishDraft(t.id));
    return { templateId: t.id, versionId };
  }

  it("no assignment resolves the seeded Standard default and stamps ITS version id", async () => {
    const { order } = await miniOrder();
    const { documentId, pdf } = await asSystem(() => printTraveler(order.id));
    expect(pageCount(pdf)).toBe(1); // the single-load fixture
    expect(drawnText(pdf)).toContain("Order Number");
    expect(await stampOf(documentId)).toBe(templateVersionId("TRAVELER"));
  });

  it("a customer-assigned template's PUBLISHED config prints — not the default — and its version id lands on the row", async () => {
    const { customer, order } = await miniOrder();
    const { templateId, versionId } = await publishCustom((c) => {
      fieldOf(c, "header", "order_number").label = "WO#";
    });
    await asSystem(() => assignTemplate(customer.id, "TRAVELER", templateId));

    const { documentId, pdf } = await asSystem(() => printTraveler(order.id));
    const text = drawnText(pdf);
    expect(text).toContain("WO#");
    expect(text).not.toContain("Order Number");
    expect(await stampOf(documentId)).toBe(versionId);
  });

  it("a draft on the assigned template does NOT affect the print — §5.1 immutability through the real path", async () => {
    const { customer, order } = await miniOrder();
    const { templateId, versionId } = await publishCustom((c) => {
      fieldOf(c, "header", "order_number").label = "WO#";
    });
    await asSystem(() => assignTemplate(customer.id, "TRAVELER", templateId));

    // Open the next draft and change it — unpublished work must never reach paper.
    const draft = await asSystem(() => openDraft(templateId));
    const c = cfg();
    fieldOf(c, "header", "order_number").label = "DRAFT-ONLY-MARKER";
    await asSystem(() => editDraft(templateId, { config: c, updatedAt: draft.updatedAt }));

    const { documentId, pdf } = await asSystem(() => printTraveler(order.id));
    const text = drawnText(pdf);
    expect(text).toContain("WO#");
    expect(text).not.toContain("DRAFT-ONLY-MARKER");
    expect(await stampOf(documentId)).toBe(versionId);
  });

  it("a placed PNG logo prints; the no-logo print carries the barcode alone", async () => {
    const { customer, order } = await miniOrder();
    const bare = await asSystem(() => printTraveler(order.id));
    expect(countImages(bare.pdf)).toBe(1); // the barcode

    const { templateId } = await publishCustom(
      (c) => { c.logo = { placement: "header-center", width: 120 }; },
      { data: await barcodePng("LOGO"), mime: "image/png" });
    await asSystem(() => assignTemplate(customer.id, "TRAVELER", templateId));
    const withLogo = await asSystem(() => printTraveler(order.id));
    expect(countImages(withLogo.pdf)).toBe(2);
  });

  it("a placed JPEG logo prints through the JPEG data-uri path", async () => {
    const { customer, order } = await miniOrder();
    const { templateId } = await publishCustom(
      (c) => { c.logo = { placement: "header-right", width: 40 }; },
      { data: TINY_JPEG, mime: "image/jpeg" });
    await asSystem(() => assignTemplate(customer.id, "TRAVELER", templateId));
    const { pdf } = await asSystem(() => printTraveler(order.id));
    expect(countImages(pdf)).toBe(2);
    expect(pdf.toString("latin1")).toContain("DCTDecode"); // a JPEG embeds as DCT, never Flate
  });

  it("uploaded logo bytes with no config placement stay off the paper", async () => {
    const { customer, order } = await miniOrder();
    const { templateId } = await publishCustom(() => undefined,
      { data: await barcodePng("LOGO"), mime: "image/png" });
    await asSystem(() => assignTemplate(customer.id, "TRAVELER", templateId));
    const { pdf } = await asSystem(() => printTraveler(order.id));
    expect(countImages(pdf)).toBe(1);
  });

  // #670: each load is its own pdfkit document, so before the merge-time dedupe the stored file
  // held one copy of the logo per load (a 100-load traveler with a 512 KB logo stored 54 MB,
  // measured 2026-11-07). The barcodes differ per load and stay three.
  it.each([
    ["an alpha PNG", () => tinyAlphaPng(), "image/png"],
    ["a JPEG", () => TINY_JPEG, "image/jpeg"],
  ])("a merged print stores a placed logo once, not once per load — %s (#670)", async (_what, bytes, mime) => {
    const { customer, order } = await miniOrder({ loadQty: 4 }); // 10 pieces → 4 / 4 / 2
    expect(order.loads).toHaveLength(3);
    const { templateId } = await publishCustom(
      (c) => { c.logo = { placement: "header-center", width: 120 }; },
      { data: bytes(), mime });
    await asSystem(() => assignTemplate(customer.id, "TRAVELER", templateId));
    const { pdf } = await asSystem(() => printTraveler(order.id));
    expect(pageCount(pdf)).toBe(3);
    expect(paintedImageCounts(pdf)).toEqual([2, 2, 2]); // every sheet still paints its barcode and the logo
    expect(imageObjectCount(pdf)).toBe(4); // three barcodes, one payload each, and ONE logo
    expect(danglingSMaskRefs(pdf)).toBe(0); // the kept alpha logo keeps its mask
  });
});

// ------------------------------------------------------------------------------------------------
// #36 — per-load sheet groups (Task 8): buildTravelerDefinitions + the identity band
// ------------------------------------------------------------------------------------------------

describe("buildTravelerDefinitions — one definition per load (pure)", () => {
  const twoSheetData = () => travelerData({
    sheets: [
      { loadNumber: 1, loadQty: 336, loadWeight: 4536, barcodeDataUri: BARCODE },
      { loadNumber: 2, loadQty: 164, loadWeight: 2214, barcodeDataUri: BARCODE },
    ],
  });

  it("returns one definition per sheet, each content-identical to the singular's per-sheet stack", () => {
    const defs = buildTravelerDefinitions(twoSheetData());
    expect(defs).toHaveLength(2);
    const singular = buildTravelerDefinition(twoSheetData());
    const singularStacks = (singular.content as { stack: unknown }[]).map((c) => c.stack);
    const groupStacks = defs.map((d) => (d.content as { stack: unknown }[])[0].stack);
    expect(groupStacks).toEqual(singularStacks);
  });

  it("each definition carries ITS load's identity band — order number, that load, the barcode — with the margin reserve", () => {
    const defs = buildTravelerDefinitions(twoSheetData());
    for (const [i, def] of defs.entries()) {
      const spec = def.continuationHeaderSpec!;
      expect(spec.overflowTopMargin).toBeGreaterThanOrEqual(54); // the 44pt barcode + its offset must fit
      const bandText = allText(spec.content).join("\n");
      expect(bandText).toContain("Order Number 91246");
      expect(bandText).toContain(`Load ${i + 1}`);
      expect(bandText).toContain("(continued)");
      expect(JSON.stringify(spec.content)).toContain(BARCODE);
    }
    // Never a following load's number on the wrong band.
    expect(allText(defs[0].continuationHeaderSpec!.content).join("\n")).not.toContain("Load 2");
  });

  it("a null-load sheet's band omits the load line and label overrides carry through", () => {
    const c = cfg();
    fieldOf(c, "header", "order_number").label = "WO#";
    const defs = buildTravelerDefinitions(
      travelerData({ sheets: [{ loadNumber: null, loadQty: null, loadWeight: null, barcodeDataUri: BARCODE }] }), checked(c));
    const bandText = allText(defs[0].continuationHeaderSpec!.content).join("\n");
    expect(bandText).toContain("WO# 91246");
    expect(bandText).not.toContain("Load");
  });

  it("the identity band ignores the visibility flags — a page torn loose still names its work", () => {
    // `order_number`/`load_number` are removable ON THE SHEET (the contract marks them so), but
    // the continuation band is the barcode treatment: identity on shop paper is locked, not
    // configurable. Hiding them must empty the sheet's header block, never the band.
    const c = cfg();
    fieldOf(c, "header", "order_number").visible = false;
    fieldOf(c, "header", "load_number").visible = false;
    const defs = buildTravelerDefinitions(twoSheetData(), checked(c));
    const bandText = allText(defs[1].continuationHeaderSpec!.content).join("\n");
    expect(bandText).toContain("Order Number 91246");
    expect(bandText).toContain("Load 2");
    expect(JSON.stringify(defs[1].continuationHeaderSpec!.content)).toContain(BARCODE);
    // …and the sheet body itself did honour the flags.
    expect(textOf(defs[1].content)).not.toContain("Order Number");
  });

  it("the pageFooter knob turns on the per-group footer spec and widens the bottom margin; default stays off", () => {
    const on = cfg();
    on.pageFooter = true;
    const withFooter = buildTravelerDefinitions(travelerData(), checked(on));
    expect(withFooter[0].pageFooterSpec).toEqual({ kind: "pageNofM" });
    expect(withFooter[0].pageMargins).toEqual([24, 24, 24, 44]);

    const dflt = buildTravelerDefinitions(travelerData());
    expect(dflt[0].pageFooterSpec).toBeUndefined();
    expect(dflt[0].pageMargins).toEqual([24, 24, 24, 24]); // golden — today's margins exactly
  });

  it("is pure: plain JSON, deterministic, spec keys included", () => {
    const defs = buildTravelerDefinitions(twoSheetData());
    expect(JSON.parse(JSON.stringify(defs))).toEqual(defs);
    expect(buildTravelerDefinitions(twoSheetData())).toEqual(defs);
  });
});

describe("printTraveler — sheet groups through the real path (#36)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  /** A single-load order whose recipe overflows LETTER: 25 steps with wrapping instructions. */
  async function overflowOrder() {
    const customer = await prisma.customer.create({ data: { code: "OVF", name: "Overflow Co" } });
    const code = await prisma.processStepCode.create({ data: { code: "AUS", name: "Austemper" } });
    const part = await prisma.part.create({
      data: {
        customerId: customer.id, partNumber: "OVF-1", name: "Overflow Part",
        eachWeight: "1.0000", loadQty: 100,
      },
    });
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    const instruction =
      "Ramp the furnace to soak temperature, hold until the whole load equalizes, verify with " +
      "the pyrometer log, then transfer to the quench within the allowed window and record the " +
      "elapsed transfer time on this line before the next step begins.";
    await prisma.partProcessStep.createMany({
      data: Array.from({ length: 25 }, (_, i) => ({
        revisionId: rev.id, position: i + 1, codeId: code.id, instruction,
      })),
    });
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: part.id, qty: 10, weight: "10.00" }],
    }));
    return { order };
  }

  it("a 20+-step recipe overflows one load's sheet and the continuation page carries order number, load number and barcode", async () => {
    const { order } = await overflowOrder();
    const { pdf } = await asSystem(() => printTraveler(order.id, 1));
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(2);

    const pages = drawnPages(pdf);
    expect(pages[0]).not.toContain("(continued)");
    expect(pages[1]).toContain(`Order Number ${order.orderNumber}`);
    expect(pages[1]).toContain("Load 1");
    expect(pages[1]).toContain("(continued)");
    // The band's barcode is painted on the continuation page (page one's is the sheet's own).
    expect(paintedImageCounts(pdf)[1]).toBeGreaterThanOrEqual(1);
  });

  it("the pageFooter knob restarts numbering per load group through the traveler path", async () => {
    const { customer, order } = await miniOrder({ loadQty: 5 }); // two loads
    const t = await asSystem(() => createTemplate("TRAVELER", "Footered"));
    const c = cfg();
    c.pageFooter = true;
    await asSystem(() => editDraft(t.id, { config: c, updatedAt: t.draft.updatedAt }));
    await asSystem(() => publishDraft(t.id));
    await asSystem(() => assignTemplate(customer.id, "TRAVELER", t.id));

    const { pdf } = await asSystem(() => printTraveler(order.id));
    expect(pageCount(pdf)).toBe(2);
    const pages = drawnPages(pdf);
    // Each one-page load group numbers ITSELF: "Page 1 of 1" twice, never "of 2".
    expect(pages[0]).toContain("Page 1 of 1");
    expect(pages[1]).toContain("Page 1 of 1");
    expect(drawnText(pdf)).not.toContain("of 2");
  });

  it("the default multi-load print is a merge with today's content — no footer, no band, one barcode per page", async () => {
    const { order } = await miniOrder({ loadQty: 5 }); // two loads
    const { pdf } = await asSystem(() => printTraveler(order.id));
    expect(pageCount(pdf)).toBe(2);
    const text = drawnText(pdf);
    expect(text).not.toContain("(continued)");
    expect(text).not.toMatch(/Page \d+ of \d+/);
    expect(paintedImageCounts(pdf)).toEqual([1, 1]);
    // Each page still carries its own load's sheet (the header prints label and value as
    // separate nodes, so they are asserted separately).
    const pages = drawnPages(pdf);
    for (const page of pages) {
      expect(page).toContain("Order Number");
      expect(page).toContain(String(order.orderNumber));
    }
  });

  it("a non-overflowing single-load print stays content-identical to the pre-Task-8 render", async () => {
    const { order } = await miniOrder();
    const data = await asSystem(() => collectTravelerData(order.id, 1));
    const legacy = await renderPdf(buildTravelerDefinition(data));
    const { pdf } = await asSystem(() => printTraveler(order.id, 1));
    expect(pageCount(pdf)).toBe(1);
    expect(drawnText(pdf)).toBe(drawnText(legacy));
  });
});

// ------------------------------------------------------------------------------------------------
// #43 — the all-loads bound (owner ruling: REFUSE above 100 loads, print per load instead)
// ------------------------------------------------------------------------------------------------

describe("the all-loads traveler's load bound (#43)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  /** An order auto-split into exactly `loads` loads: one piece per load, no recipe. The row COUNT
   *  is the whole point — qty/weight are trivial and the part carries no steps or inspections, so
   *  each sheet renders in milliseconds and a 100-load print stays a sane test. */
  async function orderWithLoads(loads: number) {
    const customer = await prisma.customer.create({ data: { code: "BND", name: "Bound Co" } });
    const code = await prisma.processStepCode.create({ data: { code: "BND", name: "Bake" } });
    const part = await prisma.part.create({
      data: {
        customerId: customer.id, partNumber: "BND-1", name: "Bound Part",
        eachWeight: "1.0000", loadQty: 1,
      },
    });
    // One step, because `createOrder` locks a revision and refuses a part without one.
    const rev = await prisma.partProcessRevision.create({
      data: { partId: part.id, revisionNumber: 1 },
    });
    await prisma.partProcessStep.create({
      data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Bake." },
    });
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id,
      lines: [{ partId: part.id, qty: loads, weight: String(loads) + ".00" }],
    }));
    expect(order.loads).toHaveLength(loads);
    return { order };
  }

  it("prints AT the bound — 100 loads, one page per load, in one merged document", async () => {
    const { order } = await orderWithLoads(100);
    const { pdf } = await asSystem(() => printTraveler(order.id));
    expect(pageCount(pdf)).toBe(100);
  }, 120_000);

  it("archives a render taking over five seconds while retaining the order claim (#305)", async () => {
    const { order } = await orderWithLoads(2);
    const realRender = pdfRenderer.renderSheetGroups;
    let unlockedDuringRender: { id: string }[] | undefined;
    // Keep the real renderer and database. Delaying only the render makes the original 5s
    // expiry deterministic even on a fast machine; a fake PDF would miss the archive boundary.
    const render = vi.spyOn(pdfRenderer, "renderSheetGroups").mockImplementationOnce(async (...args) => {
      await delay(6_000);
      // A separate connection can see this row, but SKIP LOCKED must omit it while the print
      // owns its claim. This also catches moving the render outside the claimed transaction.
      unlockedDuringRender = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE SKIP LOCKED`;
      return realRender(...args);
    });
    try {
      const { documentId, pdf } = await asSystem(() => printTraveler(order.id));
      expect(pageCount(pdf)).toBe(2);
      expect(unlockedDuringRender).toEqual([]);
      const stored = await prisma.storedDocument.findUniqueOrThrow({ where: { id: documentId } });
      expect(Buffer.from(stored.fileData)).toEqual(pdf);
      expect(stored.templateVersionId).toBe(templateVersionId("TRAVELER"));
      // Prove the probe can see the row once the successful archive releases its claim.
      expect(await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE SKIP LOCKED`).toEqual([{ id: order.id }]);
    } finally {
      render.mockRestore();
    }
  }, 30_000);

  // #521 (owner ruling 2026-10-17): a print whose claim expires, its 15-second budget spent before
  // its last statement or its commit, is refused with the owner's sentence and stores and audits
  // nothing. It writes one server log line, which holds the order number, the loads in the print
  // and the seconds taken, and nothing else. The two expiries run on the real clock, one after the
  // other, and each times its own print.
  const refusalLine = (orderNumber: number, loads: number) => new RegExp(
    `^\\[traveler\\] print refused, took too long: order ${orderNumber}, loads ${loads}, (\\d+\\.\\d) s$`);
  const loggedSeconds = (line: unknown, pattern: RegExp) => Number(String(line).match(pattern)?.[1]);

  it("refuses a print whose claim expires during the render, releasing the order and storing nothing (#521)", async () => {
    const { order } = await orderWithLoads(2);
    const auditRows = await prisma.auditLog.count();
    const realRender = pdfRenderer.renderSheetGroups;
    let releasedDuringRender: { id: string }[] | undefined;
    const render = vi.spyOn(pdfRenderer, "renderSheetGroups").mockImplementationOnce(async (...args) => {
      await delay(16_000); // past the 15 s budget, on the real clock
      // An autocommit statement outside Prisma's transaction manager: it adds nothing to the
      // manager's list of closed transactions, so it cannot push the expired one out of it
      // (tests/db-errors.test.ts, case (h)).
      releasedDuringRender = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE SKIP LOCKED`;
      return realRender(...args);
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const begun = performance.now();
      const refused = asSystem(() => printTraveler(order.id));
      await expect(refused).rejects.toBeInstanceOf(HttpError);
      const elapsed = (performance.now() - begun) / 1000; // the print, timed here, once it refused
      await expect(refused).rejects.toMatchObject({
        status: 400,
        message: "This traveler took too long to print, so nothing was stored. Print the loads one at a time.",
      });
      expect(render).toHaveBeenCalledTimes(1);
      // Prisma's timer rolled the transaction back, and released the claim, while the render ran.
      expect(releasedDuringRender).toEqual([{ id: order.id }]);
      expect(await prisma.storedDocument.count({ where: { orderId: order.id } })).toBe(0);
      expect(await prisma.auditLog.count()).toBe(auditRows);
      // One call with one argument: the line alone, never the error or the PDF beside it.
      const line = refusalLine(order.orderNumber, 2);
      expect(log.mock.calls).toEqual([[expect.stringMatching(line)]]);
      // Seconds, not milliseconds: within 2 s of what the test timed. A 16 s delay keeps a constant
      // 16 inside that window, so this does not prove the figure is measured.
      const seconds = loggedSeconds(log.mock.calls[0][0], line);
      expect(seconds).toBeGreaterThanOrEqual(16);
      expect(Math.abs(seconds - elapsed)).toBeLessThanOrEqual(2);
    } finally {
      log.mockRestore();
      render.mockRestore();
    }
  }, 40_000);

  it("lets a P2028 that is not an expiry (Transaction not found) through unchanged, and logs nothing (#521)", async () => {
    const { order } = await orderWithLoads(2);
    const notFound = new Prisma.PrismaClientKnownRequestError(
      "Transaction API error: Transaction not found. Transaction ID is invalid, refers to an old closed " +
        "transaction Prisma doesn't have information about anymore, or was obtained before disconnecting.",
      { code: "P2028", clientVersion: "test", meta: {} });
    const render = vi.spyOn(pdfRenderer, "renderSheetGroups").mockRejectedValueOnce(notFound);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(asSystem(() => printTraveler(order.id))).rejects.toBe(notFound);
      expect(await prisma.storedDocument.count({ where: { orderId: order.id } })).toBe(0);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      render.mockRestore();
    }
  });

  it("refuses a print whose claim expires at the commit, storing nothing (#521)", async () => {
    const { order } = await orderWithLoads(2);
    const auditRows = await prisma.auditLog.count();
    const realStore = documents.storeDocument;
    const store = vi.spyOn(documents, "storeDocument").mockImplementationOnce(async (...args) => {
      const doc = await realStore(...args); // the row and its audit entry, inside the claim
      await delay(16_000); // the budget passes after the last query, so the commit finds it expired
      return doc;
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // A one-load print of the two-load order: the line's count is the selection's, which case 1,
      // an all-loads print, cannot tell from the order's own count.
      const begun = performance.now();
      const refused = asSystem(() => printTraveler(order.id, 1));
      await expect(refused).rejects.toBeInstanceOf(HttpError);
      const elapsed = (performance.now() - begun) / 1000; // the print, timed here, once it refused
      await expect(refused).rejects.toMatchObject({
        status: 400,
        message: "This traveler took too long to print, so nothing was stored. Print the loads one at a time.",
      });
      expect(store).toHaveBeenCalledTimes(1);
      expect(await prisma.storedDocument.count({ where: { orderId: order.id } })).toBe(0);
      expect(await prisma.auditLog.count()).toBe(auditRows);
      const line = refusalLine(order.orderNumber, 1);
      expect(log.mock.calls).toEqual([[expect.stringMatching(line)]]);
      const seconds = loggedSeconds(log.mock.calls[0][0], line);
      expect(seconds).toBeGreaterThanOrEqual(16);
      expect(Math.abs(seconds - elapsed)).toBeLessThanOrEqual(2);
    } finally {
      log.mockRestore();
      store.mockRestore();
    }
  }, 40_000);

  it("a print that finishes inside its budget writes no log line (#521)", async () => {
    const { order } = await orderWithLoads(2);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { documentId } = await asSystem(() => printTraveler(order.id));
      expect(await prisma.storedDocument.count({ where: { id: documentId } })).toBe(1);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("refuses ABOVE it with a 400 naming the bound and the per-load remedy", async () => {
    const { order } = await orderWithLoads(101);
    await expect(asSystem(() => printTraveler(order.id))).rejects.toMatchObject({
      status: 400,
      message: "This order has 101 loads — more than the 100 an all-loads traveler prints at " +
        "once. Print the loads one at a time.",
    });
    // Nothing was rendered or archived — the refusal precedes both.
    expect(await prisma.storedDocument.count({ where: { orderId: order.id } })).toBe(0);
  }, 120_000);

  it("the remedy works: a single-load print of the same over-bound order succeeds", async () => {
    const { order } = await orderWithLoads(101);
    const { pdf } = await asSystem(() => printTraveler(order.id, 101));
    expect(pageCount(pdf)).toBe(1);
    expect(drawnPages(pdf)[0]).toContain("101");
  }, 120_000);

  it("the standalone read refuses identically — the preview path cannot bypass the bound", async () => {
    const { order } = await orderWithLoads(101);
    await expect(collectTravelerData(order.id)).rejects.toMatchObject({ status: 400 });
    // …while one load of it reads fine.
    expect((await collectTravelerData(order.id, 7)).sheets).toHaveLength(1);
  }, 120_000);
});

describe("the traveler's built-in labels on stored configs (owner ruling W14)", () => {
  /** The sheet a stored config prints, read as a print reads it. */
  const page = (stored: unknown) =>
    buildTravelerDefinition(travelerData(), normalizeStoredConfig("TRAVELER", stored));
  const lineHeads = (def: unknown) => tableHeaded(def, "Part Quantity").body[0].map(cellTexts);
  const KEPT = [["Part Quantity"], ["Part Number / Part Name / Description"]];

  it("a stored config with no typed label prints the new headings over the part lines", () => {
    expect(lineHeads(page(seedLiteral("TRAVELER")))).toEqual([...KEPT, ["Each weight"], ["Net weight"]]);
  });

  it("a stored config with no typed label prints the new headings over the container rows", () => {
    // The first five headings. The sixth, the `gross_weight` column's, is not held here.
    expect(tableHeaded(page(seedLiteral("TRAVELER")), "Order Quantity").body[0].slice(0, 5).map(cellTexts))
      .toEqual([["Order Quantity"], ["Load Quantity"], ["Container"], ["Containers"], ["Tare"]]);
  });

  it("a stored config with no typed label prints the old wording in no cell", () => {
    const old = ["Part Weight", "Line Weight", "Container Quantity", "Tare Weight"];
    expect(allText(page(seedLiteral("TRAVELER"))).filter((text) => old.includes(text))).toEqual([]);
  });

  it("a typed label prints as typed, beside a heading that was left empty", () => {
    expect(lineHeads(page(storedBefore("TRAVELER", "typed-labels")))).toEqual([...KEPT, ["Each weight"], ["Line Wt"]]);
  });

  it("a label typed to equal the old wording prints the old wording", () => {
    expect(lineHeads(page(storedBefore("TRAVELER", "old-wording-typed")))).toEqual([...KEPT, ["Part Weight"], ["Net weight"]]);
  });
});

describe("printTraveler: a version stored before the built-in wording changed (owner ruling W14)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("prints the new headings on its next print, and its typed label as typed", async () => {
    const { order } = await miniOrder();
    await publishStored("TRAVELER", storedBefore("TRAVELER", "typed-labels"));
    const { pdf } = await asSystem(() => printTraveler(order.id));
    // The part lines' heading row as drawn: cell after cell, with nothing between them.
    expect(drawnText(pdf)).toContain("Part QuantityPart Number / Part Name / DescriptionEach weightLine Wt");
  });
});

describe("printTraveler: a version stored before po_number existed (#518)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  // The seed migration's literal stores no customer_phone, and neither does devtest's in-use
  // version; the frozen config stores it, and so does .182's in-use version, as the 2026-10-15
  // exports showed.
  it.each<[what: string, stored: () => unknown]>([
    ["the seed migration's literal", () => seedLiteral("TRAVELER")],
    ["a frozen config that stores customer_phone", () => storedBefore("TRAVELER", "typed-labels")],
  ])("prints the PO on its next print, published as %s", async (_what, stored) => {
    const { order } = await miniOrder();
    await publishStored("TRAVELER", stored());
    expect(drawnText((await asSystem(() => printTraveler(order.id))).pdf)).toContain(`PO: ${RULE}`);
    await prisma.order.update({ where: { id: order.id }, data: { poNumber: "ADSE-3335" } });
    expect(drawnText((await asSystem(() => printTraveler(order.id))).pdf)).toContain("PO: ADSE-3335");
  });
});

describe("W5 timing: a 100-load traveler whose every sheet takes two pages (weights design §13.5)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  /** A 100-load order whose part's recipe is overflowOrder()'s above: 25 steps whose instruction
   *  wraps, which overflows a sheet. */
  async function hundredLoadOrder() {
    const customer = await prisma.customer.create({ data: { code: "W5T", name: "Timing Co" } });
    const code = await prisma.processStepCode.create({ data: { code: "W5T", name: "Austemper" } });
    const part = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "W5T-1", name: "Timing Part", eachWeight: "1.0000", loadQty: 1 },
    });
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    const instruction =
      "Ramp the furnace to soak temperature, hold until the whole load equalizes, verify with " +
      "the pyrometer log, then transfer to the quench within the allowed window and record the " +
      "elapsed transfer time on this line before the next step begins.";
    await prisma.partProcessStep.createMany({
      data: Array.from({ length: 25 }, (_, i) => ({ revisionId: rev.id, position: i + 1, codeId: code.id, instruction })),
    });
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: part.id, qty: 100, weight: "100.00" }],
    }));
    expect(order.loads).toHaveLength(100);
    return order;
  }

  // Runs only when asked: W5_TRAVELER_TIMING=1 npx vitest run tests/traveler-templates.test.ts -t "W5 timing"
  it.skipIf(process.env.W5_TRAVELER_TIMING !== "1")("prints through printTraveler, and writes out the time and the page count", async () => {
    const order = await hundredLoadOrder();

    const started = performance.now();
    const outcome = await asSystem(() => printTraveler(order.id)).then(
      ({ pdf }) => `${pageCount(pdf)} pages`,
      (err: unknown) => `the print FAILED: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`W5 timing: 100 loads, ${outcome}, ${Math.round(performance.now() - started)} ms, against a limit of 15000 ms`);
    expect(outcome).toMatch(/^\d+ pages$/);
    expect(Number.parseInt(outcome, 10)).toBeGreaterThanOrEqual(200);
  }, 300_000);

  // The canvas path's budget (traveler canvas design §5.6): the same order printed under a published
  // template whose config carries the standard canvas layout. Runs only when asked:
  // CANVAS_TIMING=1 npx vitest run tests/traveler-templates.test.ts -t "CANVAS timing" --reporter=verbose --silent=false
  it.skipIf(process.env.CANVAS_TIMING !== "1")("CANVAS timing: a 100-load canvas traveler whose sheets take two pages prints inside the 15 s budget", async () => {
    const order = await hundredLoadOrder();
    // Published onto the seeded default, so the print resolves it with no assignment.
    const { versionId } = await publishStored("TRAVELER",
      validateConfig("TRAVELER", { ...cfg(), layout: standardLayout() }));

    const started = performance.now();
    let printed: string | null = null;
    const outcome = await asSystem(() => printTraveler(order.id)).then(
      ({ pdf, documentId }) => { printed = documentId; return `${pageCount(pdf)} pages`; },
      (err: unknown) => `the print FAILED: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`CANVAS timing: 100 loads, ${outcome}, ${Math.round(performance.now() - started)} ms, against a limit of 15000 ms`);
    expect(outcome).toMatch(/^\d+ pages$/);
    expect(Number.parseInt(outcome, 10)).toBeGreaterThanOrEqual(200);
    // The canvas template printed it, not the flow path's Standard.
    expect(await stampOf(printed!)).toBe(versionId);
  }, 300_000);
});
