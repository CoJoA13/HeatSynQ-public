import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, templateVersionId, seedOrderGatePrereqs } from "./helpers/db";
import { drawnPages, drawnText, pageCount, paintedImageCounts, strokedLines } from "./helpers/pdf";
import { measured } from "./helpers/measured";
import { runWithContext } from "@/server/context";
import { createOrder, type OrderDetail } from "@/server/orders";
import { createShipper, printBol, type ShipperDetail } from "@/server/shippers";
import { createTemplate, editDraft, publishDraft, uploadLogo } from "@/server/templates";
import { assignTemplate } from "@/server/template-assignments";
import { barcodePng, renderPdf } from "@/server/pdf/render";
import { buildBolDefinition } from "@/server/pdf/bol";
import { sampleBol } from "./helpers/bol-canvas-fixtures";
import { BOL_DEFAULT_CONFIG, normalizeStoredConfig, validateConfig, type TemplateConfig } from "@/lib/template-contracts/index";
import { BOL_FIRST_TABLE_ROOM, BOL_ROW_FLOOR } from "@/lib/template-contracts/bol";
import { cellTexts, tableHeaded } from "./helpers/definition-text";
import { storedBefore } from "./helpers/stored-configs";
import type { Customer } from "../prisma/generated/prisma/client";

/**
 * Phase 7 Task 10 — the BOL conversion: `buildBolDefinition` becomes a config-consumer (spec
 * §5.4) with the ELEVEN UDSBL legal constants rendering from the config's TEXT BLOCKS (the
 * contract's defaults are today's transcriptions, so the default paper is unchanged — the golden
 * gate lives in tests/bol.test.ts, untouched), the §5.6 belt in both halves (nothing on the BOL
 * contract is locked, so the flag half is pinned in the NEGATIVE direction; `completeSections`
 * plus a text-block fallback carry the omission half), and the print path resolving docType
 * `BOL` REGARDLESS of the shipment's order count (spec §5.2's other half: the registry has no
 * MOS_BOL — count-independence pinned explicitly below) with the resolved version id stamped on
 * the stored row.
 *
 * THE DATE KNOB HAS NO TRAP HERE (the ticket's two-date-styles rule, generalized): the builder
 * was grepped for every date call before mapping — `bolDate` had exactly ONE call site, the
 * ship-from line — so the contract's single knob maps to the paper's single style directly.
 */

// ------------------------------------------------------------------------------------------------
// Pure fixtures — the golden suite's sampleBol (tests/helpers/bol-canvas-fixtures.ts), kept
// value-distinctive.
// ------------------------------------------------------------------------------------------------

const cfg = (): TemplateConfig => structuredClone(BOL_DEFAULT_CONFIG);
/** Round-trips a tweaked config through the REAL validator — every config a test feeds the
 *  builder (the raw omission-belt shapes excepted, deliberately) is one a template could store. */
const checked = (c: TemplateConfig): TemplateConfig => validateConfig("BOL", c);
const sectionOf = (c: TemplateConfig, key: string) => c.sections.find((s) => s.key === key)!;
const fieldOf = (c: TemplateConfig, section: string, key: string) =>
  sectionOf(c, section).fields.find((f) => f.key === key)!;

/** Every `text` string/number in a definition, flattened — the golden suite's walker. */
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

/** The texts of the freight table's cell under `heading`, top line first. `heading` is the weight
 *  column's built-in label unless a template typed another. */
function weightTexts(def: unknown, heading = "*Weight (Subject to Correction)"): string[] {
  const { body } = tableHeaded(def, heading);
  return cellTexts(body[1][body[0].findIndex((cell) => cellTexts(cell).includes(heading))]);
}

// ------------------------------------------------------------------------------------------------
// Config-driven sections, fields, labels, widths.
// ------------------------------------------------------------------------------------------------

describe("buildBolDefinition — config-driven", () => {
  it("a flow config's definition (a null layout) carries no canvas id: the branch leaves today's paper alone", () => {
    const config = structuredClone(BOL_DEFAULT_CONFIG);
    expect(config.layout).toBeNull();
    expect(JSON.stringify(buildBolDefinition(sampleBol(), config))).not.toContain('"canvas:');
  });

  it("a label override prints in place of the contract default", () => {
    const c = cfg();
    fieldOf(c, "header", "pro_number").label = "Pro Number:";
    const text = textOf(buildBolDefinition(sampleBol(), checked(c)));
    expect(text).toContain("Pro Number:");
    expect(text).not.toContain("Carrier's Pro No.");
  });

  it("a width override lands in the freight table's widths array", () => {
    const c = cfg();
    fieldOf(c, "freight", "freight_weight").width = 80;
    const def = buildBolDefinition(sampleBol(), checked(c));
    expect(allWidths(def)).toContainEqual([40, "*", 80, 44, 42]);
  });

  it("a hidden section is omitted from the stack — its glue rides with it", () => {
    const c = cfg();
    sectionOf(c, "received").visible = false;
    const text = textOf(buildBolDefinition(sampleBol(), checked(c)));
    expect(text).not.toContain("RECEIVED, subject to");
    expect(text).not.toContain("Jul - 06 - 2026");   // the ship-from line is the section's
    // …and the default config still prints both.
    const dflt = textOf(buildBolDefinition(sampleBol()));
    expect(dflt).toContain("RECEIVED, subject to");
    expect(dflt).toContain("Jul - 06 - 2026");
  });

  it("a hidden field drops its freight column — header cell and width both", () => {
    const c = cfg();
    fieldOf(c, "freight", "package_count").visible = false;
    const def = buildBolDefinition(sampleBol(), checked(c));
    expect(textOf(def)).not.toContain("No. Packages");
    expect(allWidths(def)).toContainEqual(["*", 62, 44, 42]);
  });

  it("hiding the collect checkbox drops the box AND its explanatory caption", () => {
    const c = cfg();
    fieldOf(c, "freight", "collect_checkbox").visible = false;
    const text = textOf(buildBolDefinition(sampleBol({ freightTerms: "COLLECT" }), checked(c)));
    expect(text).not.toContain("CHECK BOX IF COLLECT");
    expect(text).not.toContain("Freight charges are PREPAID unless marked collect.");
    expect(allText(buildBolDefinition(sampleBol({ freightTerms: "COLLECT" }), checked(c)))).not.toContain("X");
  });

  it("stack order follows the config's section order", () => {
    const c = cfg();
    const i = c.sections.findIndex((s) => s.key === "consigned");
    const j = c.sections.findIndex((s) => s.key === "trv");
    [c.sections[i], c.sections[j]] = [c.sections[j], c.sections[i]];
    const text = textOf(buildBolDefinition(sampleBol(), checked(c)));
    expect(text.indexOf("TRV NO.")).toBeLessThan(text.indexOf("Consigned to"));
    // …the default order is the other way around.
    const dflt = textOf(buildBolDefinition(sampleBol()));
    expect(dflt.indexOf("Consigned to")).toBeLessThan(dflt.indexOf("TRV NO."));
  });

  it("field order follows the config WITHIN the header's form-rule slot", () => {
    const c = cfg();
    const header = sectionOf(c, "header");
    const scac = header.fields.find((f) => f.key === "scac_code")!;
    header.fields = [scac, ...header.fields.filter((f) => f.key !== "scac_code")];
    const text = textOf(buildBolDefinition(sampleBol(), checked(c)));
    expect(text.indexOf("Carrier's Code (SCAC)")).toBeLessThan(text.indexOf("Carrier's Pro No."));
    // The left slot is untouched — fields never migrate between the hand-laid slots.
    expect(text.indexOf("Original - Not Negotiable")).toBeLessThan(text.indexOf("Carrier's Code (SCAC)"));
  });

  it("hiding a signature half leaves its slot holding position; hiding the PO-address line drops it", () => {
    const c = cfg();
    fieldOf(c, "bottom", "shipper_per").visible = false;
    fieldOf(c, "bottom", "po_address").visible = false;
    const text = textOf(buildBolDefinition(sampleBol(), checked(c)));
    expect(text).not.toContain("Shipper, Per");
    expect(text).toContain("Agent, Per");
    expect(text).not.toContain("Permanent Post-office address of shipper");
  });
});

// ------------------------------------------------------------------------------------------------
// Fonts and number formats.
// ------------------------------------------------------------------------------------------------

describe("buildBolDefinition — fonts and number formats", () => {
  it("family, base size and role sizes map into the definition", () => {
    const c = cfg();
    c.fonts = { family: "Liberation Serif", baseSize: 8, headingSize: 22, smallSize: 4 };
    c.textBlocks.bol_received_text = "SMALL-SIZE-PROBE";
    const def = buildBolDefinition(sampleBol(), checked(c));
    expect(def.defaultStyle).toEqual({ font: "Liberation Serif", fontSize: 8 });
    // headingSize drives the document title; smallSize the 5.5pt fine-print clauses (the knob
    // maps to exactly the slots the contract's default reproduces — the 6pt clauses keep their
    // own literal, the ticket's two-date-styles rule generalized to sizes).
    expect(findNodes(def, (n) => n.text === "STRAIGHT BILL OF LADING")[0].fontSize).toBe(22);
    expect(findNodes(def, (n) => n.text === "SMALL-SIZE-PROBE")[0].fontSize).toBe(4);
    // …the default keeps today's literals.
    const dflt = buildBolDefinition(sampleBol());
    expect(dflt.defaultStyle).toEqual({ font: "Roboto", fontSize: 7 });
    expect(findNodes(dflt, (n) => n.text === "STRAIGHT BILL OF LADING")[0].fontSize).toBe(15);
  });

  it("thousandsSeparator: false ungroups the weight and package count", () => {
    const c = cfg();
    c.formats.thousandsSeparator = false;
    const big = sampleBol({ packageCount: 1500 });
    const def = buildBolDefinition(big, checked(c));
    expect(weightTexts(def)).toEqual(["11415 lb", "Net weight"]);
    expect(textOf(def)).toContain("1500");
    const dflt = buildBolDefinition(big);
    expect(weightTexts(dflt)).toEqual(["11,415 lb", "Net weight"]);
    expect(textOf(dflt)).toContain("1,500");
  });
});

// ------------------------------------------------------------------------------------------------
// The date knob — ONE printed style on this paper (bolDate's single call site, the ship-from
// line; grep-verified before mapping), so the knob maps to it directly. No second style exists
// to trap.
// ------------------------------------------------------------------------------------------------

describe("buildBolDefinition — the date knob maps to the paper's single date slot", () => {
  it.each([
    ["M/D/YYYY", "7/6/2026"],
    ["MM/DD/YYYY", "07/06/2026"],
    ["YYYY-MM-DD", "2026-07-06"],
    ["MMMM D, YYYY", "July 6, 2026"],
    ["MMM - DD - YYYY", "Jul - 06 - 2026"],
  ])("renders the ship-from date as %s", (format, expected) => {
    const c = cfg();
    c.formats.dateFormat = format as TemplateConfig["formats"]["dateFormat"];
    expect(allText(buildBolDefinition(sampleBol(), checked(c)))).toContain(expected);
  });

  it("defaults to the sample's own style", () => {
    expect(allText(buildBolDefinition(sampleBol()))).toContain("Jul - 06 - 2026");
  });
});

// ------------------------------------------------------------------------------------------------
// The UDSBL legal text renders from the config's TEXT BLOCKS (spec §8: the template designer is
// the legal form text's editing path). The contract's defaults are today's transcriptions, so
// the default paper is byte-for-byte the golden suite's.
// ------------------------------------------------------------------------------------------------

describe("buildBolDefinition — the eleven text blocks", () => {
  it("an edited text block reaches the paper; the default no longer does", () => {
    const c = cfg();
    c.textBlocks.bol_property_text = "EDITED-PROPERTY-MARKER";
    const text = textOf(buildBolDefinition(sampleBol(), checked(c)));
    expect(text).toContain("EDITED-PROPERTY-MARKER");
    expect(text).not.toContain("Uniform Domestic Straight Bill of Lading");
  });

  it("every one of the eleven blocks is config-fed — editing each moves the paper", () => {
    const keys = [
      "bol_received_text", "bol_property_text", "bol_certifies_text", "bol_section_7_text",
      "bol_no_delivery_text", "bol_imprint_text", "bol_water_note", "bol_value_note",
      "bol_declared_value_text", "bol_liability_note", "bol_fibre_note",
    ];
    const c = cfg();
    for (const key of keys) c.textBlocks[key] = `MARKER-${key}`;
    const text = textOf(buildBolDefinition(sampleBol(), checked(c)));
    for (const key of keys) expect(text).toContain(`MARKER-${key}`);
  });

  it("a raw config omitting a text-block key still renders the contract default (the omission belt's text half)", () => {
    const c = cfg();
    delete c.textBlocks.bol_fibre_note;
    const text = textOf(buildBolDefinition(sampleBol(), c));
    expect(text).toContain("fibre boxes");
    expect(text).not.toContain("undefined");
  });
});

// ------------------------------------------------------------------------------------------------
// The §5.6 belt, both halves. The BOL contract locks NOTHING, so the flag half's observable duty
// is the NEGATIVE direction — the belt must not force visible what the contract allows hiding —
// and the omission half (completeSections) must re-materialize entries a raw config drops.
// ------------------------------------------------------------------------------------------------

describe("buildBolDefinition — the §5.6 belt", () => {
  it("nothing on this contract is locked: a validated config may hide ANY section and the builder honors it", () => {
    const c = cfg();
    sectionOf(c, "header").visible = false;
    sectionOf(c, "bottom").visible = false;
    const validated = checked(c); // accepted — contrast with the traveler's locked refusals
    const text = textOf(buildBolDefinition(sampleBol(), validated));
    expect(text).not.toContain("STRAIGHT BILL OF LADING");
    expect(text).not.toContain("Shipper, Per");
  });

  it("a raw config OMITTING the freight section entry still renders it (the omission half)", () => {
    const c = cfg();
    c.sections = c.sections.filter((s) => s.key !== "freight");
    const text = textOf(buildBolDefinition(sampleBol(), c));
    expect(text).toContain("Kind Of Package, Description of Articles");
    expect(text).toContain("Manufactured Castings I/S");
  });

  it("a raw config OMITTING a field entry inside a present section still renders it", () => {
    const c = cfg();
    const trv = sectionOf(c, "trv");
    trv.fields = trv.fields.filter((f) => f.key !== "trv_no");
    const text = textOf(buildBolDefinition(sampleBol(), c));
    expect(text).toContain("TRV NO.");
    expect(text).toContain("91955,\u200B91957,\u200B91959,\u200B91960,\u200B91961");   // #943's zero-width break after each comma
  });
});

// ------------------------------------------------------------------------------------------------
// Stored configs in today's shape (the weights design §13.5), read as a print reads one.
// ------------------------------------------------------------------------------------------------

describe("buildBolDefinition: stored configs written before the weights on paper", () => {
  const stored = (name: string): TemplateConfig => normalizeStoredConfig("BOL", storedBefore("BOL", name));

  it("a heading someone typed still sits over the figure, its unit and the word that says which", () => {
    // The template typed "Gross Weight" over this column. The sample has no containers, so the
    // word under the figure is the program's "Net weight", which no label retypes.
    const def = buildBolDefinition(sampleBol(), stored("typed-label"));
    expect(weightTexts(def, "Gross Weight")).toEqual(["11,415 lb", "Net weight"]);
  });

  it("a template that hid the weight column prints no weight, no unit and no word for it", () => {
    const def = buildBolDefinition(
      sampleBol({ orders: [{ lineWeights: [1280, 320], containers: [{ count: 3, tareEach: 42.5 }] }] }), stored("weight-hidden"));
    const { widths, body } = tableHeaded(def, "No. Packages");
    expect({
      widths, headings: body[0].map((cell) => cellTexts(cell)[0]), cells: body[1].length,
      weightWords: allText(def).filter((text) => text === "Gross weight" || text === "Net weight" || / lb$/.test(text)),
    }).toEqual({
      widths: [40, "*", 44, 42],
      headings: ["No. Packages", "Kind Of Package, Description of Articles", "Class or Rate", "Check Column"],
      cells: 4, weightWords: [],
    });
  });
});

// ------------------------------------------------------------------------------------------------
// Logo placement (spec §6.3). The BOL header is hand-laid with TWO structural slots (title left,
// form rules right); a header-center logo materializes a middle column between them.
// ------------------------------------------------------------------------------------------------

const LOGO_URI = "data:image/png;base64,BOLLOGOFIXTURE";

describe("buildBolDefinition — logo placement", () => {
  const placedConfig = (placement: "header-left" | "header-center" | "header-right") => {
    const c = cfg();
    c.logo = { placement, width: 110 };
    return checked(c);
  };
  const headerColumns = (def: unknown): { stack: { image?: string; width?: number }[] }[] =>
    (def as { content: { columns: { stack: never[] }[] }[] }).content[0].columns;

  it("a placed logo joins the header-left slot at its configured width", () => {
    const cols = headerColumns(buildBolDefinition(sampleBol(), placedConfig("header-left"), LOGO_URI));
    expect(cols[0].stack[0]).toEqual({ image: LOGO_URI, width: 110 });
  });

  it("a placed logo joins the header-right slot at its configured width", () => {
    const cols = headerColumns(buildBolDefinition(sampleBol(), placedConfig("header-right"), LOGO_URI));
    expect(cols[cols.length - 1].stack[0]).toEqual({ image: LOGO_URI, width: 110 });
  });

  it("a header-center logo materializes a middle column between the two structural slots", () => {
    const cols = headerColumns(buildBolDefinition(sampleBol(), placedConfig("header-center"), LOGO_URI));
    expect(cols).toHaveLength(3);
    expect(cols[1].stack[0]).toEqual({ image: LOGO_URI, width: 110 });
  });

  it("config placement without bytes, and bytes without placement, both fall back to the text-only header", () => {
    const placed = buildBolDefinition(sampleBol(), placedConfig("header-center"));
    expect(JSON.stringify(placed)).not.toContain(LOGO_URI);
    const unplaced = buildBolDefinition(sampleBol(), cfg(), LOGO_URI);
    expect(JSON.stringify(unplaced)).not.toContain(LOGO_URI);
  });
});

// ------------------------------------------------------------------------------------------------
// Page footer knob + the continuation band. The knob defaults OFF (golden — margins untouched);
// the band exists because the BOL genuinely overflows: the TRV/PO lists grow with the shipment's
// order count, which the live path does NOT bound (createShipper's orders array is min(1) with
// no max) — ~80 orders pushes the paper to a second page (probed before building).
// ------------------------------------------------------------------------------------------------

describe("buildBolDefinition — pageFooter knob and continuation band", () => {
  it("the pageFooter knob turns on the footer spec and widens the bottom margin; default stays off", () => {
    const on = cfg();
    on.pageFooter = true;
    const withFooter = buildBolDefinition(sampleBol(), checked(on));
    expect(withFooter.pageFooterSpec).toEqual({ kind: "pageNofM" });
    expect(withFooter.pageMargins).toEqual([24, 24, 24, 44]);

    const dflt = buildBolDefinition(sampleBol());
    expect(dflt.pageFooterSpec).toBeUndefined();
    expect(dflt.pageMargins).toEqual([24, 24, 24, 24]); // golden — today's margins exactly
  });

  it("the definition carries the BOL's identity band for continuation pages", () => {
    const def = buildBolDefinition(sampleBol());
    const band = allText(def.continuationHeaderSpec!.content).join("\n");
    expect(band).toContain("Shipper's Bill of Lading No. 92795");
    expect(band).toContain("(continued)");
    // The band draws in the top margin; the reserve must clear its own height.
    expect(def.continuationHeaderSpec!.overflowTopMargin).toBeGreaterThanOrEqual(36);
  });

  it("the band carries a label override but ignores the visibility flags — identity on paper is locked", () => {
    const c = cfg();
    fieldOf(c, "header", "bol_number").label = "B/L No.";
    fieldOf(c, "header", "bol_number").visible = false;
    const def = buildBolDefinition(sampleBol(), checked(c));
    const band = allText(def.continuationHeaderSpec!.content).join("\n");
    expect(band).toContain("B/L No. 92795");
    // …while the sheet body itself honours the hide.
    expect(textOf(def.content)).not.toContain("B/L No.");
  });

  it("a many-order shipment's BOL overflows LETTER and repeats its identity on page 2 (the live overflow path)", async () => {
    const wide = sampleBol({
      orderNumbers: Array.from({ length: 80 }, (_, i) => 91955 + i),
      poNumbers: Array.from({ length: 80 }, (_, i) => `PT${24115 + i}`),
    });
    const pdf = await renderPdf(buildBolDefinition(wide));
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(2);
    const pages = drawnPages(pdf);
    expect(pages[0]).not.toContain("(continued)");
    expect(pages[1]).toContain("Shipper's Bill of Lading No. 92795");
    expect(pages[1]).toContain("(continued)");
  });
});

// ------------------------------------------------------------------------------------------------
// Purity, config included.
// ------------------------------------------------------------------------------------------------

describe("buildBolDefinition — purity, config included", () => {
  it("a config-driven definition survives the JSON round trip and is deterministic", () => {
    const c = cfg();
    c.logo = { placement: "header-right", width: 90 };
    fieldOf(c, "trv", "trv_no").label = "ORDERS:";
    c.formats.dateFormat = "MMMM D, YYYY";
    const config = checked(c);
    const def = buildBolDefinition(sampleBol(), config, LOGO_URI);
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
    expect(buildBolDefinition(sampleBol(), config, LOGO_URI)).toEqual(def);
  });
});

// ------------------------------------------------------------------------------------------------
// The print path (spec §5.2): docType `BOL` REGARDLESS of the shipment's order count — the
// registry has no MOS_BOL, unlike the ticket's SHIPPER/MOS_SHIPPER split — the resolved config
// renders, and the version id stamps the stored row. The lazy §3.19 number allocation is
// untouched: first print allocates, every reprint reuses.
// ------------------------------------------------------------------------------------------------

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({
    data: { code: `BLT${customerSeq}`, name: `BOL Template Customer ${customerSeq}` },
  });
}

let partSeq = 0;
async function makePart(customerId: string) {
  partSeq += 1;
  const part = await prisma.part.create({
    data: {
      customerId, partNumber: `BLTP-${partSeq}`, name: `Lading Part ${partSeq}`,
      description: "I/S", eachWeight: "21.5000",
    },
  });
  const code = await prisma.processStepCode.create({ data: { code: `BLT-${part.id}`, name: "Normalize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Normalize at 1600F." },
  });
  return part;
}

async function makeShipTo(customerId: string) {
  return prisma.customerAddress.create({
    data: {
      customerId, kind: "SHIP_TO", name: "Example Coating", street: "400 Demo Drive",
      city: "Birmingham", state: "AL", zip: "35217", isDefault: true,
    },
  });
}

async function orderFor(customer: Customer, poNumber = "DEMO-PO-24115"): Promise<OrderDetail> {
  const part = await makePart(customer.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, poNumber,
    lines: [{ partId: part.id, qty: 192, weight: "4128.00" }],
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

async function shipmentOf(customer: Customer, orderCount: 1 | 2): Promise<ShipperDetail> {
  const shipTo = await makeShipTo(customer.id);
  const orders: OrderDetail[] = [];
  for (let i = 0; i < orderCount; i++) orders.push(await orderFor(customer, `PO-${i + 1}`));
  const { shipper } = await asSystem(() => createShipper({
    customerId: customer.id, shipDate: "2026-07-06", shipToAddressId: shipTo.id,
    freightDescription: "Manufactured Castings I/S", freightClass: "70",
    orders: orders.map(shipOrderInput),
  }, { canOverrideCreditHold: false }));
  return shipper;
}

/** Create → tweak the v1 draft → (optionally logo) → publish, for the BOL docType. */
async function publishCustom(tweak: (c: TemplateConfig) => void, logo?: { data: Buffer; mime: string }) {
  const t = await asSystem(() => createTemplate("BOL", "Custom BOL"));
  const c = cfg();
  tweak(c);
  await asSystem(() => editDraft(t.id, { config: c, updatedAt: t.draft.updatedAt }));
  if (logo) await asSystem(() => uploadLogo(t.id, logo.data, logo.mime));
  const { versionId } = await asSystem(() => publishDraft(t.id));
  return { templateId: t.id, versionId };
}

async function stampOf(documentId: string): Promise<string | null> {
  const row = await prisma.storedDocument.findUnique({
    where: { id: documentId }, select: { templateVersionId: true },
  });
  return row!.templateVersionId;
}

describe("printBol — resolution is count-independent and stamps the version", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("no assignment: resolves the seeded Standard BOL and stamps ITS version id", async () => {
    const shipper = await shipmentOf(await makeCustomer(), 1);
    const { documentId, pdf } = await asSystem(() => printBol(shipper.id));
    expect(drawnText(pdf)).toContain("STRAIGHT BILL OF LADING");
    expect(await stampOf(documentId)).toBe(templateVersionId("BOL"));
  });

  it("docType is count-independent: single- AND multi-order shipments both resolve the assigned BOL template", async () => {
    const customer = await makeCustomer();
    const tpl = await publishCustom((c) => {
      fieldOf(c, "header", "title").label = "BOL-STYLE-MARKER";
    });
    await asSystem(() => assignTemplate(customer.id, "BOL", tpl.templateId));

    const single = await shipmentOf(customer, 1);
    const p1 = await asSystem(() => printBol(single.id));
    expect(drawnText(p1.pdf)).toContain("BOL-STYLE-MARKER");
    expect(await stampOf(p1.documentId)).toBe(tpl.versionId);

    // TWO orders on the truck — the ticket's docType would flip to MOS_SHIPPER here; the BOL's
    // must NOT (spec §5.2: one BOL per shipment, no MOS_BOL in the registry).
    const multi = await shipmentOf(customer, 2);
    const p2 = await asSystem(() => printBol(multi.id));
    expect(drawnText(p2.pdf)).toContain("BOL-STYLE-MARKER");
    expect(await stampOf(p2.documentId)).toBe(tpl.versionId);
  });

  it("an assigned template's edited legal text prints through the real path; the default no longer does", async () => {
    const customer = await makeCustomer();
    const tpl = await publishCustom((c) => {
      c.textBlocks.bol_received_text = "CONFIG-RECEIVED-MARKER";
    });
    await asSystem(() => assignTemplate(customer.id, "BOL", tpl.templateId));
    const shipper = await shipmentOf(customer, 1);
    const { pdf } = await asSystem(() => printBol(shipper.id));
    const text = drawnText(pdf);
    expect(text).toContain("CONFIG-RECEIVED-MARKER");
    expect(text).not.toContain("individually determined rates");
  });

  it("the pageFooter knob prints per-page numbers; the default prints none", async () => {
    const customer = await makeCustomer();
    const tpl = await publishCustom((c) => { c.pageFooter = true; });
    await asSystem(() => assignTemplate(customer.id, "BOL", tpl.templateId));
    const shipper = await shipmentOf(customer, 1);
    const { pdf } = await asSystem(() => printBol(shipper.id));
    expect(drawnText(pdf)).toContain("Page 1 of 1");

    const bare = await shipmentOf(await makeCustomer(), 1);
    const bareprint = await asSystem(() => printBol(bare.id));
    expect(drawnText(bareprint.pdf)).not.toMatch(/Page \d+ of \d+/);
  });

  it("a placed logo prints through the real path; the bare BOL paints no image", async () => {
    const bare = await shipmentOf(await makeCustomer(), 1);
    const bareprint = await asSystem(() => printBol(bare.id));
    expect(paintedImageCounts(bareprint.pdf)).toEqual([0]);

    const customer = await makeCustomer();
    const tpl = await publishCustom(
      (c) => { c.logo = { placement: "header-right", width: 90 }; },
      { data: await barcodePng("BOLLOGO"), mime: "image/png" });
    await asSystem(() => assignTemplate(customer.id, "BOL", tpl.templateId));
    const shipper = await shipmentOf(customer, 1);
    const { pdf } = await asSystem(() => printBol(shipper.id));
    expect(paintedImageCounts(pdf)).toEqual([1]);
  });

  it("the lazy §3.19 allocation is untouched: first print allocates, the reprint reuses, both stamp", async () => {
    const shipper = await shipmentOf(await makeCustomer(), 1);
    expect((await prisma.shipper.findUniqueOrThrow({ where: { id: shipper.id } })).bolNumber).toBeNull();
    const a = await asSystem(() => printBol(shipper.id));
    const b = await asSystem(() => printBol(shipper.id));
    expect(b.bolNumber).toBe(a.bolNumber);
    expect(await stampOf(a.documentId)).toBe(templateVersionId("BOL"));
    expect(await stampOf(b.documentId)).toBe(templateVersionId("BOL"));
  });
});

describe("the bill of lading's canvas floors (design 2026-11-09 §4.1)", () => {
  it("BOL_ROW_FLOOR is one form-rule line of the header's right slot and BOL_FIRST_TABLE_ROOM that line and its 3 pt, measured on the Standard", async () => {
    // One PO, so the PO rule's value prints one line: the sample's two POs may wrap in 130 pt.
    const pdf = await renderPdf(buildBolDefinition(sampleBol({ poNumbers: ["PT24116"] }), checked(cfg())));
    // strokedLines' y is top-down (pdfkit's page flip), so ascending y is down the page. The
    // header's right slot draws four 130 pt rules, one under each labeled rule's value.
    const rules = strokedLines(pdf)[0]
      .filter((l) => l.y1 === l.y2 && Math.abs(Math.abs(l.x2 - l.x1) - 130) < 0.5)
      .sort((a, b) => a.y1 - b.y1);
    const ys = rules.map((l) => l.y1);
    const spacings = ys.slice(1).map((y, i) => y - ys[i]);
    measured("the bill of lading's canvas floors", { ys, spacings, x1s: rules.map((l) => Math.min(l.x1, l.x2)), all130: rules.length });
    // The page draws exactly these four 130 pt rules, one column's: they share their left edge.
    expect(rules).toHaveLength(4);
    expect(new Set(rules.map((l) => Math.min(l.x1, l.x2))).size).toBe(1);
    const spacing = spacings[0];
    expect(BOL_ROW_FLOOR).toBe(Math.floor(spacing - 3));
    expect(BOL_FIRST_TABLE_ROOM).toBe(Math.ceil(spacing));
    expect(BOL_ROW_FLOOR).toBeGreaterThanOrEqual(8);
    expect(BOL_ROW_FLOOR).toBeLessThanOrEqual(16);
    // The first pair is every pair: the three spacings agree.
    for (const s of spacings) expect(Math.abs(s - spacing)).toBeLessThan(0.01);
  });
});
