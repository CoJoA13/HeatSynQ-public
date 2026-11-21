import { describe, it, expect, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { storedTareEach, keptAndLinkedRows } from "./helpers/shipment-rows";
import { cellTexts, findNodes, tableHeaded } from "./helpers/definition-text";
import { measured } from "./helpers/measured";
import { pageCount, runFonts, strokedLines, textRunsWithY } from "./helpers/pdf";
import { trvLines, trvListRuns, wrappedRuns } from "./helpers/trv-list";
import { CEILING_LB, ORDER_1031, ORDER_1032 } from "./helpers/weights-examples";
import { runWithContext } from "@/server/context";
import { createOrder, type OrderDetail } from "@/server/orders";
import {
  createShipper, voidShipper, printShippingTickets, printBol, readBolData, bolSettings,
  addOrderToShipper, replaceShipperContainers, readShipperDetail,
  type ShipperDetail,
} from "@/server/shippers";
import { BOL_WIDTHS, buildBolDefinition, type BolData, type BolOrderWeights } from "@/server/pdf/bol";
import { textWidthOf } from "@/lib/tag-font-metrics";
import { renderPdf } from "@/server/pdf/render";
import { NO_REPORTS, savedShipmentTotalsInput, shipmentTotals } from "@/lib/shipment-totals";
import { BOL_DEFAULT_CONFIG, validateConfig, type TemplateConfig } from "@/lib/template-contracts/index";
import {
  getDocument, listDocumentsForOrder, listDocumentsForShipper, VOIDED_PRINT,
} from "@/server/documents";
import type { Customer } from "../prisma/generated/prisma/client";

import { POST as printRoute } from "@/app/api/shippers/[id]/print/route";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
const postReq = (url: string, cookie?: string) =>
  new Request(url, { method: "POST", headers: cookie ? { cookie } : {} });

/** Every `text` string anywhere in a document definition, flattened — the traveler.test.ts /
 *  shipping-ticket.test.ts precedent: the definition is plain JSON (spec §10), so assertions
 *  check WHAT the BOL says. (Rendered bytes cannot be greped for content — pdfkit writes
 *  TTF-subset glyph ids, not character bytes — so content pins live on the definition and the
 *  rendered PDF is pinned structurally, the house `renderPdf` rule.) */
function allText(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined) return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) allText(n, out); return out; }
  if (typeof node === "object") {
    for (const value of Object.values(node as Record<string, unknown>)) allText(value, out);
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// Fixtures — the shipping-ticket.test.ts shapes.
// -------------------------------------------------------------------------------------------

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({
    data: { code: `BOL${customerSeq}`, name: `Lading Customer ${customerSeq}` },
  });
}

let partSeq = 0;
async function makePart(customerId: string) {
  partSeq += 1;
  return prisma.part.create({
    data: {
      customerId, partNumber: `BP-${partSeq}`, name: `Casting ${partSeq}`,
      description: "I/S", eachWeight: "21.5000",
    },
  });
}

async function giveSteps(partId: string): Promise<void> {
  const code = await prisma.processStepCode.create({ data: { code: `BL-${partId}`, name: "Normalize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Normalize at 1600F." },
  });
}

async function makeShipTo(customerId: string) {
  return prisma.customerAddress.create({
    data: {
      customerId, kind: "SHIP_TO", name: "Example Coating", street: "400 Demo Drive",
      city: "Birmingham", state: "AL", zip: "35217", isDefault: true,
    },
  });
}

async function orderFor(customer: Customer, opts: { poNumber?: string; qty?: number; weight?: string } = {}): Promise<OrderDetail> {
  const part = await makePart(customer.id);
  await giveSteps(part.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id,
    poNumber: opts.poNumber ?? "DEMO-PO-24115",
    lines: [{ partId: part.id, qty: opts.qty ?? 192, weight: opts.weight ?? "4128.00" }],
  }));
  return order;
}

function shipOrderInput(order: OrderDetail) {
  return {
    orderId: order.id,
    lines: [{
      orderLineId: order.lines[0].id, qty: order.lines[0].qty, weight: order.lines[0].weight,
      lineComplete: true,
    }],
    containers: [], serials: [],
  };
}

async function oneOrderShipment(): Promise<{ shipper: ShipperDetail; order: OrderDetail; customer: Customer }> {
  const customer = await makeCustomer();
  const shipTo = await makeShipTo(customer.id);
  const order = await orderFor(customer);
  const { shipper } = await asSystem(() => createShipper({
    customerId: customer.id, shipDate: "2026-07-06", shipToAddressId: shipTo.id,
    freightDescription: "Manufactured Castings I/S", freightClass: "70", packageCount: 15,
    proNumber: "PRO-4471", scacCode: "GFMC",
    orders: [shipOrderInput(order)],
  }, { canOverrideCreditHold: false }));
  return { shipper, order, customer };
}

async function twoOrderShipment(): Promise<{
  shipper: ShipperDetail; orderA: OrderDetail; orderB: OrderDetail; customer: Customer;
}> {
  const customer = await makeCustomer();
  const shipTo = await makeShipTo(customer.id);
  const orderA = await orderFor(customer, { poNumber: "PO-A" });
  const orderB = await orderFor(customer, { poNumber: "PO-B", qty: 8, weight: "96.00" });
  const { shipper } = await asSystem(() => createShipper({
    customerId: customer.id, shipDate: "2026-07-06", shipToAddressId: shipTo.id,
    orders: [shipOrderInput(orderA), shipOrderInput(orderB)],
  }, { canOverrideCreditHold: false }));
  return { shipper, orderA, orderB, customer };
}

/** A hand-built BolData for the pure-builder assertions — every field distinctive, the
 *  sampleTicket precedent. */
function sampleBol(overrides: Partial<BolData> = {}): BolData {
  return {
    company: { name: "Example Heat Treating - Alabama, LLC", address: "100 Example Way  Anniston  AL  36207" },
    bolNumber: 92795,
    proNumber: "PRO-4471",
    scacCode: "GFMC",
    carrierName: "Demo Foundry Truck",
    shipDate: "2026-07-06",
    consignee: { name: "Example Coating", street: "400 Demo Drive", city: "Birmingham", state: "AL", zip: "35217" },
    orderNumbers: [91955, 91957, 91959, 91960, 91961],
    poNumbers: ["DEMO-PO-24115", "PT24116"],
    packageCount: 15,
    freightDescription: "Manufactured Castings I/S",
    orders: [{ lineWeights: [11415], containers: [] }],
    freightClass: "70",
    freightTerms: "PREPAID",
    ...overrides,
  };
}

// ---- the weight cell (the weights design §13.2; §13.3, BL1 to BL3) ----

const WEIGHT_HEADING = "*Weight (Subject to Correction)";
/** The freight table's cell under the weight heading, as the builder built it. */
function weightCell(def: unknown, heading = WEIGHT_HEADING): unknown {
  const { body } = tableHeaded(def, heading);
  return body[1][body[0].findIndex((cell) => cellTexts(cell).includes(heading))];
}
/** One of the shared examples as the rows the builder is handed. */
const weightsOf = (order: {
  lines: readonly { weight: number }[]; containers: readonly { count: number; tareEach: number | null }[];
}): BolOrderWeights => ({
  lineWeights: order.lines.map((line) => line.weight),
  containers: order.containers.map((row) => ({ count: row.count, tareEach: row.tareEach })),
});
/** The printed weight cell, read off the first page: the run before the page's one "lb", that
 *  run, and the two after it, each with the place its text starts. No "lb", no runs. It knows the
 *  cell by that one run, so it throws on a page where a second run reads "lb" alone. */
function printedWeight(pdf: Buffer): { text: string; x: number; y: number }[] {
  const runs = textRunsWithY(pdf)[0];
  const units = runs.flatMap((run, at) => (run.text.trim() === "lb" ? [at] : []));
  if (units.length > 1) throw new Error(`${units.length} runs of the first page read "lb" alone: the weight cell cannot be told from the other`);
  return units.length === 0 ? [] : runs.slice(units[0] - 1, units[0] + 3);
}
/** The same cell as one text, its runs joined by a space. */
const printedWeightText = (pdf: Buffer) => printedWeight(pdf).map((run) => run.text.trim()).join(" ");

// -------------------------------------------------------------------------------------------
// The builder — pure, plain-JSON, and it says what the sample says.
// -------------------------------------------------------------------------------------------

describe("buildBolDefinition", () => {
  it("returns a plain-JSON definition (the template-as-data contract, spec §10)", () => {
    const def = buildBolDefinition(sampleBol());
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
  });

  it("prints every block the sample carries", () => {
    const text = allText(buildBolDefinition(sampleBol())).join("\n");
    expect(text).toContain("Original - Not Negotiable");
    expect(text).toContain("STRAIGHT BILL OF LADING");
    expect(text).toContain("Carrier's Pro No.");
    expect(text).toContain("PRO-4471");
    expect(text).toContain("Shipper's Bill of Lading No.");
    expect(text).toContain("92795");
    expect(text).toContain("Consignee's Ref/PO No.");
    expect(text).toContain("DEMO-PO-24115, PT24116");
    expect(text).toContain("Carrier's Code (SCAC)");
    expect(text).toContain("GFMC");
    expect(text).toContain("Demo Foundry Truck");
    expect(text).toContain("(Name of Carrier)");
    expect(text).toContain("RECEIVED, subject to");                 // the UDSBL boilerplate opens
    expect(text).toContain("100 Example Way");              // ship-from = company settings
    expect(text).toContain("Jul - 06 - 2026");                      // the sample's own date style
    expect(text).toContain("Example Heat Treating - Alabama, LLC");
    expect(text).toContain("Uniform Domestic Straight Bill of Lading");
    expect(text).toContain("Shipper hereby certifies");
    expect(text).toContain("Consigned to");
    expect(text).toContain("Example Coating");
    expect(text).toContain("400 Demo Drive");
    expect(text).toContain("Destination");
    expect(text).toContain("Birmingham");
    expect(text).toContain("35217");
    expect(text).toContain("TRV NO.");
    // Every order number, the §3.20 point: comma-joined with a zero-width break after each comma
    // (#943, owner ruling (b) of 2026-11-13), which the definition carries and the paper prints as nothing.
    expect(text).toContain("91955,\u200B91957,\u200B91959,\u200B91960,\u200B91961");
    expect(text).toContain("Delivering Carrier");
    expect(text).toContain("Car or Vehicle Initials");
    expect(text).toContain("Kind Of Package, Description of Articles");
    expect(text).toContain("Manufactured Castings I/S");
    expect(cellTexts(weightCell(buildBolDefinition(sampleBol())))).toEqual(["11,415 lb", "Net weight"]);
    expect(text).toContain("Class or Rate");
    expect(text).toContain("Check Column");
    expect(text).toContain("Subject to Section 7");
    expect(text).toContain("(Signature of consignor)");
    expect(text).toContain("Freight charges are PREPAID unless marked collect");
    expect(text).toContain("CHECK BOX IF COLLECT");
    expect(text).toContain("RECEIVED $");
    expect(text).toContain("Agent or Cashier");
    expect(text).toContain("Charges Advanced:");
    expect(text).toContain("49 U.S.C.");                            // the liability-limitation note
    expect(text).toContain("Shipper, Per");
    expect(text).toContain("Agent, Per");
    expect(text).toContain("Permanent Post-office address of shipper");
    // Exact cell values, matched on the flattened array so "70"/"15" can't pass by substring.
    const texts = allText(buildBolDefinition(sampleBol()));
    expect(texts).toContain("70");
    expect(texts).toContain("15");
  });

  it("marks the collect box only for COLLECT terms (spec §10.2's prepaid/collect block)", () => {
    expect(allText(buildBolDefinition(sampleBol({ freightTerms: "COLLECT" })))).toContain("X");
    expect(allText(buildBolDefinition(sampleBol({ freightTerms: "PREPAID" })))).not.toContain("X");
  });
});

// ---- the TRV order list (#943; owner ruling (b) of 2026-11-13) ----

describe("buildBolDefinition: the TRV order list wraps (#943, owner ruling (b) of 2026-11-13)", () => {
  /** The list's column: the left margin plus the TRV label's 55 pt. */
  const LIST_X = 24 + BOL_WIDTHS.trvLabel;
  const RIGHT_MARGIN = 588;
  const orders = (n: number) => Array.from({ length: n }, (_, i) => 92000 + i);
  const render = (n: number) => renderPdf(buildBolDefinition(sampleBol({ orderNumbers: orders(n) })));
  const deliveringY = (pdf: Buffer) => runFonts(pdf).find((r) => r.text.startsWith("Delivering"))!.y;

  // Red on a bare-comma join: the list printed as one token, one run on one line, running past the
  // right margin from about 17 orders on (the issue's 1, 30 and 80 orders measured one height).
  it.each([30, 80])("%i orders wrap inside the right margin, every number whole and in order, and push the delivering carrier down by the extra lines", async (n) => {
    const pdf = await render(n);
    const runs = trvListRuns(pdf, LIST_X);
    // Soft, so a bare-comma join shows all three facts red, not the first alone.
    expect.soft(runs.map((r) => r.text)).toEqual(wrappedRuns(orders(n)));
    for (const r of runs) expect.soft(r.end, `"${r.text}" ends at ${r.end}`).toBeLessThanOrEqual(RIGHT_MARGIN + 0.01);
    const lines = trvLines(runs);
    expect.soft(lines.length).toBeGreaterThan(1);
    expect(runs[0].x).toBeCloseTo(LIST_X, 3);
    if (lines.length < 2) return;
    const step = lines[0] - lines[1];
    expect(step).toBeGreaterThan(9.5);
    expect(deliveringY(await render(1)) - deliveringY(pdf)).toBeCloseTo((lines.length - 1) * step, 1);
  });

  // Green on both joins (it pins "unchanged"); a join with ", " reds it, the list printing wider.
  it.each([3, 5])("%i orders print on one line at today's place and width: the label's baseline, the list's column, ending where the comma-joined string ends", async (n) => {
    const pdf = await render(n);
    const runs = trvListRuns(pdf, LIST_X);
    const label = runFonts(pdf).find((r) => r.text.startsWith("TRV"))!;
    expect(trvLines(runs)).toHaveLength(1);
    expect(runs[0].y).toBeCloseTo(label.y, 3);
    expect(runs[0].x).toBeCloseTo(LIST_X, 3);
    expect(runs.map((r) => r.text).join("")).toBe(orders(n).join(","));
    expect(runs.at(-1)!.end).toBeCloseTo(LIST_X + textWidthOf(orders(n).join(","), "Roboto", "bold", 9.5), 2);
  });
});

/** Order 1031 as the builder is handed it: 1,280 and 320 lb, in 3 baskets at 42.5 lb each. */
const O1031 = weightsOf(ORDER_1031);
const BASKETS = O1031.containers[0];

describe("buildBolDefinition: the weight cell (weights design §13.2)", () => {
  const cellOf = (orders: BolOrderWeights[]) => weightCell(buildBolDefinition(sampleBol({ orders })));

  it.each<[state: string, orders: BolOrderWeights[], cell: string[]]>([
    ["every order has a gross", [O1031], ["1,727.5 lb", "Gross weight"]],
    ["no container rows", [{ ...O1031, containers: [] }], ["1,600 lb", "Net weight"]],
    ["a container row with no tare each", [{ ...O1031, containers: [{ count: 3, tareEach: null }] }], ["1,600 lb", "Net weight"]],
    ["a tare each of 0", [{ ...O1031, containers: [{ count: 3, tareEach: 0 }] }], ["1,600 lb", "Gross weight"]],
    ["orders 1031 and 1032 on one shipment", [O1031, weightsOf(ORDER_1032)], ["2,050 lb", "Net weight"]],
    ["a reversal", [{ lineWeights: [-1280, -320], containers: [] }], ["-1,600 lb", "Net weight"]],
    ["a tare past the ceiling", [{ ...O1031, containers: [{ count: 2_000_000_000, tareEach: 42.5 }] }], ["1,600 lb", "Net weight"]],
    ["net and tare together past the ceiling", [{ lineWeights: [CEILING_LB], containers: [BASKETS] }], ["9,999,999,999.99 lb", "Net weight"]],
    ["its only order has no line", [{ lineWeights: [], containers: [] }], ["0 lb", "Net weight"]],
    ["an order with 2 baskets and no line beside order 1031", [O1031, { lineWeights: [], containers: [{ count: 2, tareEach: 42.5 }] }], ["1,812.5 lb", "Gross weight"]],
    ["a second partial shipment that kept the order's 3 baskets (answer 1)", [{ lineWeights: [800], containers: [BASKETS] }], ["927.5 lb", "Gross weight"]],
    ["an order's baskets added twice (answer 1, issue #493)", [{ ...O1031, containers: [BASKETS, BASKETS] }], ["1,855 lb", "Gross weight"]],
  ])("%s", (_state, orders, cell) => {
    expect(cellTexts(cellOf(orders))).toEqual(cell);
  });

  it("is a right-aligned stack: the figure at 9 points over the word at 6.5 points in grey", () => {
    expect(cellOf([O1031])).toEqual({
      alignment: "right",
      stack: [{ text: "1,727.5 lb", fontSize: 9 }, { text: "Gross weight", fontSize: 6.5, color: "#444444" }],
    });
  });

  it("is an empty cell when the net cannot be worked out, though the tare can", () => {
    // Lines that add up to 10,000,000,000.00 lb, in order 1031's baskets.
    expect(cellOf([{ lineWeights: [CEILING_LB, 0.01], containers: [BASKETS] }])).toEqual({ text: "" });
  });

  it("prints the figure with its unit on one line and the word on one line under it, on one page", async () => {
    const pdf = await renderPdf(buildBolDefinition(sampleBol({ orders: [O1031] })));
    const cell = printedWeight(pdf);
    // For a report: where each run starts, and the upright rules that cross the figure's line. A
    // rule's y is counted from the top of the 792-point page and a run's from its bottom.
    const hundredth = (n: number) => Math.round(n * 100) / 100;
    const figureLine = cell.length === 0 ? null : 792 - cell[0].y;
    measured("the bill of lading's weight cell", {
      runs: cell.map((run) => ({ text: run.text, x: hundredth(run.x), y: hundredth(run.y) })),
      uprightRulesAt: figureLine === null ? [] : [...new Set(strokedLines(pdf)[0]
        .filter((l) => l.x1 === l.x2 && Math.min(l.y1, l.y2) <= figureLine && figureLine <= Math.max(l.y1, l.y2))
        .map((l) => hundredth(l.x1)))].sort((a, b) => a - b),
      pages: pageCount(pdf),
    });
    expect(cell.map((run) => run.text)).toEqual(["1,727.5 ", "lb", "Gross ", "weight"]);
    // One y a line. A figure or a word too wide for its 62 points puts its last run on a lower line.
    expect(cell.map((run) => run.y)).toEqual([cell[0].y, cell[0].y, cell[2].y, cell[2].y]);
    expect(pageCount(pdf)).toBe(1);
  });

  it("is read off a page by the page's one lb, and the reader refuses a page with a second", async () => {
    // A freight description that is the word alone: its run comes before the weight cell's.
    const pdf = await renderPdf(buildBolDefinition(sampleBol({ orders: [O1031], freightDescription: "lb" })));
    expect(() => printedWeight(pdf)).toThrow('2 runs of the first page read "lb" alone');
  });
});

// -------------------------------------------------------------------------------------------
// The collect checkbox (#557, owner ruling 2026-10-18): the box inks its 14 pt column, x 574 to
// 588, with the X centred in it, and no stroked line on any page passes the right margin.
//
// Two frames: `textRunsWithY` gives a run's baseline counted from the BOTTOM of the 792 pt page,
// and `strokedLines` gives a stroke counted from the TOP, so 792 − run.y puts a run in the
// strokes' frame. Each literal below was measured, from a render of this sample, or, for the X's
// advance, from pdfkit.
// -------------------------------------------------------------------------------------------

describe("the collect checkbox fits its 14 pt column, #557", () => {
  const LABEL = "CHECK BOX IF COLLECT";
  const hundredth = (n: number) => Math.round(n * 100) / 100;
  // The two upright rules' centres as measured, which the rules case pins; the X is centred on
  // the point midway between them.
  const LEFT_RULE = 574.4, RIGHT_RULE = 587.6;
  const BOX_MIDDLE = (LEFT_RULE + RIGHT_RULE) / 2;

  const serif = (): TemplateConfig => {
    const c = structuredClone(BOL_DEFAULT_CONFIG);
    c.fonts = { ...c.fonts, family: "Liberation Serif" };
    return validateConfig("BOL", c);
  };
  /** Per family, as measured. `advance` is the bold X's width at 7 pt from pdfkit's
   *  `widthOfString` (Roboto-Medium and LiberationSerif-Bold), so the literal also pins the X's
   *  size, and in Roboto its weight (Liberation Serif's regular and bold X share an advance).
   *  `box` is the upright rules' top and bottom ends and `rules` the horizontal rules' y, both
   *  counted from the top of the page. `receivedY` is the "RECEIVED $" run's
   *  baseline counted from the BOTTOM of the page (`textRunsWithY`'s frame). */
  const FAMILIES = [
    { family: "Roboto", config: () => undefined, advance: 4.4194,
      box: [363.65, 377.45], rules: [364.05, 377.05], receivedY: 393.52 },
    { family: "Liberation Serif", config: serif, advance: 5.0552,
      box: [343.82, 357.18], rules: [344.22, 356.78], receivedY: 414.03 },
  ];
  const CASES = FAMILIES.flatMap((f) => (["PREPAID", "COLLECT"] as const).map((freightTerms) => ({ ...f, freightTerms })));

  describe.each(CASES)("$family, $freightTerms", ({ config, freightTerms, advance, box, rules, receivedY }) => {
    const definition = () => buildBolDefinition(sampleBol({ freightTerms }), config());
    let pdf: Promise<Buffer> | undefined;
    const rendered = () => (pdf ??= renderPdf(definition()));
    /** The label's line, in the strokes' frame: its COLLECT word, the one run of the page that
     *  reads it, whose line reads the whole label. */
    const labelLine = async (): Promise<number> => {
      const runs = textRunsWithY(await rendered())[0];
      const words = runs.filter((run) => run.text === "COLLECT");
      if (words.length !== 1) assert.fail(`${words.length} runs read "COLLECT"`);
      const line = runs.filter((run) => run.y === words[0].y && run.x > 400 && run.x < 566).map((run) => run.text).join("");
      assert.equal(line, LABEL);
      return 792 - words[0].y;
    };

    it("builds the box as a 14 pt column holding a 10 pt cell on the collect box layout", () => {
      const rows = findNodes(definition(), (n) =>
        Array.isArray(n.columns) && (n.columns[0] as { text?: unknown } | undefined)?.text === LABEL);
      if (rows.length !== 1) assert.fail(`${rows.length} column rows open with "${LABEL}"`);
      // Literals, never the constant: a test that read the constant would follow a wrong one.
      expect((rows[0].columns as unknown[])[1]).toMatchObject({
        width: 14, table: { widths: [10] }, layout: "bol-collect-box",
      });
    });

    it("draws the box's upright rules at 574.4 and 587.6 and its top and bottom from 574 to 587.2", async () => {
      const y = await labelLine();
      const strokes = strokedLines(await rendered())[0];
      // The upright rules right of the 148 pt label column (it ends at 566) that cross the label's line.
      const uprights = strokes
        .filter((s) => s.x1 === s.x2 && s.x1 > 566 && Math.min(s.y1, s.y2) <= y && y <= Math.max(s.y1, s.y2))
        .map((s) => ({ x: hundredth(s.x1), from: hundredth(Math.min(s.y1, s.y2)), to: hundredth(Math.max(s.y1, s.y2)) }))
        .sort((a, b) => a.x - b.x);
      expect(uprights).toEqual([
        { x: LEFT_RULE, from: box[0], to: box[1] },
        { x: RIGHT_RULE, from: box[0], to: box[1] },
      ]);
      // The box's top and bottom: the horizontal strokes that start at the column's left edge.
      const horizontals = strokes
        .filter((s) => s.y1 === s.y2 && Math.min(s.x1, s.x2) === 574)
        .map((s) => ({ y: hundredth(s.y1), from: hundredth(Math.min(s.x1, s.x2)), to: hundredth(Math.max(s.x1, s.x2)) }))
        .sort((a, b) => a.y - b.y);
      expect(horizontals).toEqual([
        { y: rules[0], from: 574, to: 587.2 },
        { y: rules[1], from: 574, to: 587.2 },
      ]);
    });

    it("no stroked line passes 588", async () => {
      // Where each stroke's ink ends on the right, a stroke that is not upright read as horizontal
      // (the bill of lading draws no diagonal). pdfmake draws butt caps (Renderer.js,
      // `lineCap || 'butt'`), so an upright rule's ink ends half its width right of its centre and
      // a horizontal one's at its own end. Rounded to the hundredth so that float noise in a sum
      // meant to be exactly 588 (the box's right rule ends there) cannot red it; the rounding can
      // hide only an overrun under 0.005 pt. `strokedLines` reads `m`/`l` lines only, never an `re`
      // rectangle or text.
      const pages = strokedLines(await rendered());
      expect(pages[0].length).toBeGreaterThan(0); // a page read as no strokes would pass the next line
      const over = pages.flatMap((page, i) => page
        .map((s) => ({ page: i + 1, ...s, inkEnd: hundredth(s.x1 === s.x2 ? s.x1 + s.width / 2 : Math.max(s.x1, s.x2)) }))
        .filter((s) => s.inkEnd > 588));
      expect(over).toEqual([]);
    });

    it(freightTerms === "COLLECT" ? "centres the X between the box's upright rules" : "draws no X in the box", async () => {
      const marks = textRunsWithY(await rendered())[0].filter((run) => run.text === "X" && run.x > 566);
      if (freightTerms === "PREPAID") {
        expect(marks).toEqual([]);
        return;
      }
      if (marks.length !== 1) assert.fail(`${marks.length} X runs right of 566`);
      // `toBeCloseTo(…, 2)` holds the difference under 0.005.
      expect(marks[0].x + advance / 2).toBeCloseTo(BOX_MIDDLE, 2);
    });

    it("leaves the sidebar below the box where it was, on one page", async () => {
      // Absolute pins, meant as the reflow guard: a box that grew taller or a row that wrapped would move
      // every run below it. They will also go red on any edit above the sidebar that moves it.
      const pages = textRunsWithY(await rendered());
      const received = pages[0].filter((run) => run.text.startsWith("RECEIVED") && run.x > 400);
      if (received.length !== 1) assert.fail(`${received.length} "RECEIVED" runs in the sidebar`);
      expect(hundredth(received[0].y)).toBe(receivedY);
      expect(pageCount(await rendered())).toBe(1);
    });
  });
});

// -------------------------------------------------------------------------------------------
// printBol — lazy allocation (§3.19), stable across reprints, never freed by a void.
// -------------------------------------------------------------------------------------------

describe("printBol", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("allocates the BOL number on first print and reuses it on reprint", async () => {
    const { shipper } = await twoOrderShipment();
    const a = await asSystem(() => printBol(shipper.id));
    const b = await asSystem(() => printBol(shipper.id));
    expect(b.bolNumber).toBe(a.bolNumber);
    expect((await prisma.shipper.findUniqueOrThrow({ where: { id: shipper.id } })).bolNumber).toBe(a.bolNumber);
  });

  it("does not allocate a BOL number for a shipment that never prints one", async () => {
    const { shipper } = await oneOrderShipment();
    await asSystem(() => printShippingTickets(shipper.id));
    expect((await prisma.shipper.findUniqueOrThrow({ where: { id: shipper.id } })).bolNumber).toBeNull();
  });

  it("lists every order number on the shipment", async () => {
    const { shipper, orderA, orderB } = await twoOrderShipment();
    const { bolNumber, pdf } = await asSystem(() => printBol(shipper.id));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.toString("latin1")).toContain("/Count 1");       // one sheet — pinned marker, P3's rule

    // Content is asserted on the definition the print rendered from (see allText's own comment).
    const settings = await bolSettings();
    const data = await readBolData(prisma, shipper.id, bolNumber, settings);
    expect(data.orderNumbers).toEqual([orderA.orderNumber, orderB.orderNumber]);
    const text = allText(buildBolDefinition(data)).join("\n");
    expect(text).toContain(`${orderA.orderNumber},\u200B${orderB.orderNumber}`);   // #943's zero-width break
    expect(text).toContain(String(orderA.orderNumber));
    expect(text).toContain(String(orderB.orderNumber));
  });

  it("defaults packageCount to the shipment's container-count sum when none was entered", async () => {
    const customer = await makeCustomer();
    const shipTo = await makeShipTo(customer.id);
    const order = await orderFor(customer);
    const containerType = await prisma.containerType.create({ data: { name: "Basket" } });
    const bin = await prisma.orderContainer.create({
      data: { orderId: order.id, position: 1, typeId: containerType.id, count: 3 },
    });
    const pallet = await prisma.orderContainer.create({
      data: { orderId: order.id, position: 2, typeId: containerType.id, count: 4 },
    });
    const input = {
      orderId: order.id,
      lines: [{
        orderLineId: order.lines[0].id, qty: order.lines[0].qty, weight: order.lines[0].weight,
        lineComplete: true,
      }],
      containers: [{ orderContainerId: bin.id, count: 3 }, { orderContainerId: pallet.id, count: 4 }],
      serials: [],
    };
    // No packageCount — the forms promise "Blank uses the current container count".
    const { shipper } = await asSystem(() => createShipper({
      customerId: customer.id, shipDate: "2026-07-06", shipToAddressId: shipTo.id, orders: [input],
    }, { canOverrideCreditHold: false }));

    const { bolNumber } = await asSystem(() => printBol(shipper.id));
    const data = await readBolData(prisma, shipper.id, bolNumber, await bolSettings());
    expect(data.packageCount).toBe(7);
  });

  // Weights design §13.2: the bill of lading is built from each shipment container row's own tare
  // each, a kept row's included. Pull request 4 held the opposite here, before paper read one.
  it("a Containers save that changes only tare each figures changes the weight the bill of lading prints", async () => {
    const { shipper, order } = await oneOrderShipment(); // 4,128.00 lb, and no container row yet
    const so = shipper.orders[0];
    const basket = await prisma.containerType.create({ data: { name: "Basket" } });
    const { keptId, orderRowId } = await keptAndLinkedRows({
      shipperId: shipper.id, shipperOrderId: so.id, orderId: order.id, typeId: basket.id });
    const settings = await bolSettings();
    const paper = async () => {
      const data = await readBolData(prisma, shipper.id, 92795, settings);
      return { rows: data.orders[0].containers, cell: cellTexts(weightCell(buildBolDefinition(data))) };
    };
    expect(await paper()).toEqual({
      rows: [{ count: 3, tareEach: 42.5 }, { count: 2, tareEach: 55 }], cell: ["4,365.5 lb", "Gross weight"] });

    await replaceShipperContainers(shipper.id, so.id, {
      containers: [{ orderContainerId: orderRowId, count: 2, tareEach: "7.75" }],
      kept: [{ id: keptId, tareEach: "3.05" }],
    });
    expect(await storedTareEach(so.id)).toEqual(["3.05", "7.75"]); // they were 42.50 and 55.00
    // The kept row has no order row, so its 3.05 can only be the shipment's.
    expect(await paper()).toEqual({
      rows: [{ count: 3, tareEach: 3.05 }, { count: 2, tareEach: 7.75 }], cell: ["4,152.65 lb", "Gross weight"] });
  });

  it("assembles the consignee from the ship-to address, and the orders' POs and weights", async () => {
    const { shipper, orderA, orderB } = await twoOrderShipment();
    const { bolNumber } = await asSystem(() => printBol(shipper.id));
    const data = await readBolData(prisma, shipper.id, bolNumber, await bolSettings());
    expect(data.consignee.name).toBe("Example Coating");
    expect(data.consignee.zip).toBe("35217");
    expect(data.poNumbers).toEqual(["PO-A", "PO-B"]);
    // One entry for each order, in ticket print order. The builder adds them up: 4,128 + 96.
    expect(data.orders).toEqual([{ lineWeights: [4128], containers: [] }, { lineWeights: [96], containers: [] }]);
    expect(cellTexts(weightCell(buildBolDefinition(data)))).toEqual(["4,224 lb", "Net weight"]);
    expect(data.bolNumber).toBe(bolNumber);
    void orderA; void orderB;
  });

  it("allocates sequentially across shipments, and a voided shipment never frees its number", async () => {
    const first = await oneOrderShipment();
    const a = await asSystem(() => printBol(first.shipper.id));
    await asSystem(() => voidShipper(first.shipper.id, "wrong truck"));

    const second = await oneOrderShipment();
    const b = await asSystem(() => printBol(second.shipper.id));
    expect(b.bolNumber).toBe(a.bolNumber + 1);   // never the freed one
    expect((await prisma.shipper.findUniqueOrThrow({ where: { id: first.shipper.id } })).bolNumber).toBe(a.bolNumber);
  });

  it("archives kind BOL owned by the shipment alone, audited as metadata without the bytes", async () => {
    const { shipper } = await oneOrderShipment();
    const { documentId, pdf } = await asSystem(() => printBol(shipper.id));

    const doc = await getDocument(documentId);
    expect(doc.kind).toBe("BOL");
    expect(doc.shipperId).toBe(shipper.id);
    expect(doc.orderId).toBeNull();
    expect(Buffer.compare(doc.fileData, pdf)).toBe(0);          // STORED vs original: exact

    const entry = await prisma.auditLog.findFirst({ where: { entity: "storedDocument", entityId: documentId } });
    expect(entry).not.toBeNull();
    const payload = JSON.stringify(entry!.after);
    expect(payload).toContain("BOL");
    expect(payload).not.toContain("fileData");

    // The lazy allocation is itself an audited shipper update carrying the number (spec §5).
    const shipperEntries = await prisma.auditLog.findMany({ where: { entity: "shipper", entityId: shipper.id } });
    const bolEntry = shipperEntries.find((e) => JSON.stringify(e.after ?? {}).includes('"bolNumber"'));
    expect(bolEntry).toBeDefined();
  });

  it("refuses to print a voided shipment but keeps the stored BOL readable", async () => {
    const { shipper } = await oneOrderShipment();
    const printed = await asSystem(() => printBol(shipper.id));
    await asSystem(() => voidShipper(shipper.id, "wrong truck"));
    await expect(asSystem(() => printBol(shipper.id))).rejects.toThrow(VOIDED_PRINT);
    expect((await getDocument(printed.documentId)).fileData.length).toBeGreaterThan(0);
  });

  it("404s a shipment that does not exist", async () => {
    await expect(asSystem(() => printBol("nope"))).rejects.toThrow(/not found/i);
  });
});

// -------------------------------------------------------------------------------------------
// #52 — a whole-shipment document covers what it PRINTED, not the shipment's current membership.
// Membership stays editable after a print (owner ruling 2026-08-17): the printed paper is not
// falsified by a later addition — the newcomer's coverage comes from printing a fresh BOL.
// -------------------------------------------------------------------------------------------

describe("printBol — print-time coverage (#52)", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("an order added after a BOL print does not list that BOL; at-print members still do", async () => {
    const { shipper, orderA, orderB, customer } = await twoOrderShipment();
    const { documentId } = await asSystem(() => printBol(shipper.id));

    const orderC = await orderFor(customer, { poNumber: "PO-C", qty: 4, weight: "48.00" });
    await asSystem(() => addOrderToShipper(shipper.id, orderC.id));

    expect((await listDocumentsForOrder(orderA.id)).map((d) => d.id)).toContain(documentId);
    expect((await listDocumentsForOrder(orderB.id)).map((d) => d.id)).toContain(documentId);
    // The defect (#52): deriving coverage from CURRENT membership listed this pre-add BOL —
    // paper that does not mention order C — on order C's hub.
    expect((await listDocumentsForOrder(orderC.id)).map((d) => d.id)).not.toContain(documentId);
  });

  it("a fresh BOL print after the add covers the newcomer", async () => {
    const { shipper, orderA, customer } = await twoOrderShipment();
    await asSystem(() => printBol(shipper.id));
    const orderC = await orderFor(customer, { poNumber: "PO-C", qty: 4, weight: "48.00" });
    await asSystem(() => addOrderToShipper(shipper.id, orderC.id));

    const second = await asSystem(() => printBol(shipper.id));
    expect((await listDocumentsForOrder(orderC.id)).map((d) => d.id)).toContain(second.documentId);
    expect((await listDocumentsForOrder(orderA.id)).map((d) => d.id)).toContain(second.documentId);
  });

  it("stores exactly the member order ids at print, and never rewrites already-stored paper", async () => {
    const coverage = async (id: string) => (await prisma.storedDocument.findUniqueOrThrow({
      where: { id }, select: { coveredOrderIds: true } })).coveredOrderIds;

    const { shipper, orderA, orderB, customer } = await twoOrderShipment();
    const first = await asSystem(() => printBol(shipper.id));
    expect((await coverage(first.documentId)).slice().sort()).toEqual([orderA.id, orderB.id].sort());

    const orderC = await orderFor(customer, { poNumber: "PO-C", qty: 4, weight: "48.00" });
    await asSystem(() => addOrderToShipper(shipper.id, orderC.id));
    const second = await asSystem(() => printBol(shipper.id));
    expect((await coverage(second.documentId)).slice().sort())
      .toEqual([orderA.id, orderB.id, orderC.id].sort());
    // The first print is frozen paper — the membership edit rewrote nothing already stored.
    expect((await coverage(first.documentId)).slice().sort()).toEqual([orderA.id, orderB.id].sort());
  });
});

// -------------------------------------------------------------------------------------------
// The weight from a saved shipment: paper against the shipment page (owner answer 1 of
// 2026-10-11), and what a second Print BOL does.
// -------------------------------------------------------------------------------------------

/** Orders A (4,128.00 lb) and B (96.00 lb) on one saved shipment. A travels in 3 baskets at
 *  42.50 lb each. B travels in 1 basket at 18.00 lb when `both`, and has no container row
 *  otherwise. `rowA` is the id of A's container row on the order. */
async function shipmentInBaskets(both: boolean): Promise<{ shipper: ShipperDetail; rowA: string }> {
  const customer = await makeCustomer();
  const shipTo = await makeShipTo(customer.id);
  const orderA = await orderFor(customer, { poNumber: "PO-A" });
  const orderB = await orderFor(customer, { poNumber: "PO-B", qty: 8, weight: "96.00" });
  const basket = await prisma.containerType.create({ data: { name: "Basket" } });
  const rowA = await prisma.orderContainer.create({
    data: { orderId: orderA.id, position: 1, typeId: basket.id, count: 3, tareEach: "42.50" } });
  const rowB = !both ? null : await prisma.orderContainer.create({
    data: { orderId: orderB.id, position: 1, typeId: basket.id, count: 1, tareEach: "18.00" } });
  const { shipper } = await asSystem(() => createShipper({
    customerId: customer.id, shipDate: "2026-07-06", shipToAddressId: shipTo.id,
    orders: [
      { ...shipOrderInput(orderA), containers: [{ orderContainerId: rowA.id, count: 3 }] },
      { ...shipOrderInput(orderB), containers: rowB === null ? [] : [{ orderContainerId: rowB.id, count: 1 }] },
    ],
  }, { canOverrideCreditHold: false }));
  return { shipper, rowA: rowA.id };
}

/** A cell of the shipment page's totals as the bill of lading forms that amount. The page shows
 *  two decimals and paper drops closing zeros (owner answer 8), so "4,369.50" is "4,369.5 lb". */
const asPrinted = (pageCell: string) =>
  `${Number(pageCell.replace(/,/g, "")).toLocaleString("en-US", { maximumFractionDigits: 2 })} lb`;

describe("the bill of lading's weight, from a saved shipment", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  /** The shipment's own table on the shipment page, worked out as the page does with no grid report. */
  const pageTotals = async (shipperId: string) =>
    shipmentTotals(savedShipmentTotalsInput((await readShipperDetail(prisma, shipperId)).orders, NO_REPORTS)).shipment!;
  /** The weight cell of the bill of lading that shipment prints, top line first. */
  const paperWeight = async (shipperId: string) =>
    cellTexts(weightCell(buildBolDefinition(await readBolData(prisma, shipperId, 92795, await bolSettings()))));

  it("prints the Gross the shipment page shows, by amount, when every order has one", async () => {
    const { shipper } = await shipmentInBaskets(true);
    const page = await pageTotals(shipper.id);
    expect({ page: page.gross, paper: await paperWeight(shipper.id) })
      .toEqual({ page: "4,369.50", paper: [asPrinted(page.gross), "Gross weight"] });
  });

  it("prints the Net the page shows, and says net, when the page's Gross reads no figure", async () => {
    const { shipper } = await shipmentInBaskets(false);
    const page = await pageTotals(shipper.id);
    expect({ page: [page.net, page.gross], paper: await paperWeight(shipper.id) })
      .toEqual({ page: ["4,224.00", "Not available"], paper: [asPrinted(page.net), "Net weight"] });
  });

  it("a second Print BOL keeps the number and stores a new page, made from the shipment as it stands then", async () => {
    const { shipper, rowA } = await shipmentInBaskets(true);
    const first = await asSystem(() => printBol(shipper.id));
    // Between the two prints, order A's baskets go from 42.50 to 50.00 lb each on the shipment.
    await replaceShipperContainers(shipper.id, shipper.orders[0].id, [{ orderContainerId: rowA, count: 3, tareEach: "50.00" }]);
    const second = await asSystem(() => printBol(shipper.id));

    const stored = (await listDocumentsForShipper(shipper.id)).filter((doc) => doc.kind === "BOL").map((doc) => doc.id);
    expect({
      sameNumber: second.bolNumber === first.bolNumber,
      storedPages: stored.sort(),
      firstPage: printedWeightText(first.pdf),
      secondPage: printedWeightText(second.pdf),
      firstPageStillStored: Buffer.compare((await getDocument(first.documentId)).fileData, first.pdf) === 0,
    }).toEqual({
      sameNumber: true,
      storedPages: [first.documentId, second.documentId].sort(),
      firstPage: "4,369.5 lb Gross weight",
      secondPage: "4,392 lb Gross weight",
      firstPageStillStored: true,
    });
  });
});

// -------------------------------------------------------------------------------------------
// The route — POST /api/shippers/[id]/print?doc=bol (spec §9).
// -------------------------------------------------------------------------------------------

describe("POST /api/shippers/[id]/print?doc=bol", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("401s without a session", async () => {
    const { shipper } = await oneOrderShipment();
    const res = await printRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print?doc=bol`), withParams({ id: shipper.id }));
    expect(res.status).toBe(401);
  });

  it("requires shipping.view", async () => {
    const { shipper } = await oneOrderShipment();
    const cookie = await signInWith(["orders.view"]);
    const res = await printRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print?doc=bol`, cookie), withParams({ id: shipper.id }));
    expect(res.status).toBe(403);
  });

  it("streams the BOL with a friendly filename, the stored document id and the allocated number", async () => {
    const { shipper } = await oneOrderShipment();
    const cookie = await signInWith(["shipping.view"]);
    const res = await printRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print?doc=bol`, cookie), withParams({ id: shipper.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition"))
      .toBe(`inline; filename="bol-${shipper.shipperNumber}.pdf"`);
    const documentId = res.headers.get("x-document-id")!;
    const stored = await getDocument(documentId);
    expect(stored.kind).toBe("BOL");
    expect(Buffer.compare(stored.fileData, Buffer.from(await res.arrayBuffer()))).toBe(0);
    expect((await prisma.shipper.findUniqueOrThrow({ where: { id: shipper.id } })).bolNumber).not.toBeNull();
  });

  it("refuses cert=1 on a BOL print — certifications ride with the tickets (§3.14)", async () => {
    const { shipper } = await oneOrderShipment();
    const cookie = await signInWith(["shipping.view", "certs.view"]);
    const res = await printRoute(
      postReq(`http://t/api/shippers/${shipper.id}/print?doc=bol&cert=1`, cookie), withParams({ id: shipper.id }));
    expect(res.status).toBe(400);
    expect(await listDocumentsForShipper(shipper.id)).toEqual([]);
  });
});
