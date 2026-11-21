import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { prisma, truncateAll, templateVersionId, seedOrderGatePrereqs } from "./helpers/db";
import {
  danglingSMaskRefs, drawnPages, drawnText, imageObjectCount, pageCount, paintedImageCounts, strokedLines,
  textLinesWithY, textRunsWithY, tinyAlphaPng,
} from "./helpers/pdf";
import { runWithContext } from "@/server/context";
import { createOrder, type OrderDetail } from "@/server/orders";
import { createShipper, printShippingTickets, type ShipperDetail } from "@/server/shippers";
import { createTemplate, editDraft, publishDraft, uploadLogo } from "@/server/templates";
import { assignTemplate } from "@/server/template-assignments";
import { LAYOUT, barcodePng, renderPdf, renderSheetGroups } from "@/server/pdf/render";
import {
  buildShippingTicketDefinition, buildShippingTicketDefinitions,
  type TicketContainer, type TicketData, type TicketDocType,
} from "@/server/pdf/shipping-ticket";
import {
  SHIPPER_DEFAULT_CONFIG, MOS_SHIPPER_DEFAULT_CONFIG, contractFor, normalizeStoredConfig, validateConfig, type TemplateConfig,
} from "@/lib/template-contracts/index";
import { TICKET_FIRST_TABLE_ROOM, TICKET_ROW_FLOOR } from "@/lib/template-contracts/shipper";
import { cellTexts, tableHeaded } from "./helpers/definition-text";
import { seedLiteral, storedBefore } from "./helpers/stored-configs";
import { BINS_14, CEILING_LB, ORDER_1031, ORDER_1032 } from "./helpers/weights-examples";
import { bin, linesOf, stripBlock, stripRows, stripTable, totalsBlock, totalsRows, totalsTable } from "./helpers/ticket-totals";
import { measured } from "./helpers/measured";
import type { Customer } from "../prisma/generated/prisma/client";

/**
 * Phase 7 Task 9 — the shipping-ticket conversion: ONE builder serving BOTH the `SHIPPER` and
 * `MOS_SHIPPER` contracts (spec §5.4, §5.2 — the configs are structurally identical today, each
 * fed with the docType it was validated against), the §5.6 belt (both halves — the ticket
 * contracts lock NOTHING, so the belt's observable duty here is to NOT force what may hide, plus
 * the omission half via `completeSections`), and THE TWO-DATE-STYLES TRAP (Task 1 review carry,
 * BINDING): the contract's ONE date knob maps to the header `shortDate` slot ONLY — the tear-off
 * keeps its zero-padded `paddedDate` style unconditionally, both assertions in one test.
 *
 * The GOLDEN-COMPAT gate lives in tests/shipping-ticket.test.ts, untouched — this file is the
 * config-driven half (the traveler-templates.test.ts shape).
 */

// ------------------------------------------------------------------------------------------------
// Pure fixtures — the golden suite's sampleTicket, kept value-distinctive.
// ------------------------------------------------------------------------------------------------

function sampleTicket(overrides: Partial<TicketData> = {}): TicketData {
  return {
    company: {
      name: "Example Heat Treating - Alabama,", address: "1201 Front St", phone: "(256) 555-0100",
      liabilityText: "FIRST LIABILITY PARAGRAPH.\n\nSECOND LIABILITY PARAGRAPH.",
    },
    soldTo: { code: "9054", attn: "", name: "Demo Components Corporation", street: "300 Example Way", city: "Anniston", state: "AL", zip: "36201" },
    shipTo: { code: "", attn: "", name: "Example Coating", street: "88 Dock Rd.", city: "Oxford", state: "AL", zip: "36203" },
    orderLabel: "92036-3", orderNumber: 92036, shipDate: "2026-07-29",
    poNumber: "DEMO-PO-24115", packingListNo: 92826, customerJobNo: "JOB-9", route: "South", carrierName: "Customer",
    lines: [{ qty: 192, partNumber: "DEMO01-HT", partName: "Track Shoe, Vehicular", partDescription: "D-001", pounds: 4128 }],
    containers: [{ typeName: "Bin", count: 3, customerContainerId: "DEMO-COMP-77", tareEach: 42.5 }],
    serials: [{ serial: "SN-0001", description: "Heat A1" }],
    shippedComplete: true, totalQty: 192,
    ...overrides,
  };
}

const DEFAULTS: Record<TicketDocType, TemplateConfig> = {
  SHIPPER: SHIPPER_DEFAULT_CONFIG,
  MOS_SHIPPER: MOS_SHIPPER_DEFAULT_CONFIG,
};
const cfg = (docType: TicketDocType = "SHIPPER"): TemplateConfig => structuredClone(DEFAULTS[docType]);
/** Round-trips a tweaked config through the REAL validator — every config a test feeds the
 *  builder (the raw omission-belt shapes excepted, deliberately) is one a template could store. */
const checked = (c: TemplateConfig, docType: TicketDocType = "SHIPPER"): TemplateConfig =>
  validateConfig(docType, c);
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

const BOTH = ["SHIPPER", "MOS_SHIPPER"] as const;
/** Order 1031 as one ticket: 200 pieces at 1,280 lb and 100 at 320 lb, in 3 Steel Baskets at 42.5. */
const ticket1031 = (overrides: Partial<TicketData> = {}): TicketData => sampleTicket({
  orderLabel: "1031-1", orderNumber: 1031,
  lines: ORDER_1031.lines.map((l, i) => ({
    qty: l.qty, partNumber: `PART${i + 1}`, partName: "Part", partDescription: "", pounds: l.weight,
  })),
  containers: ORDER_1031.containers.map((c) => ({
    typeName: c.typeName, count: c.count, customerContainerId: "CC-1", tareEach: c.tareEach,
  })),
  totalQty: 300,
  ...overrides,
});
/** That type's default config with the thousands knob off, through the validator. */
const ungrouped = (docType: TicketDocType): TemplateConfig => {
  const c = cfg(docType);
  c.formats.thousandsSeparator = false;
  return checked(c, docType);
};

// ------------------------------------------------------------------------------------------------
// Config-driven sections, fields, labels, widths — through BOTH docTypes where the knob is
// docType-fed (label/width); the single-docType tests run SHIPPER (the contracts are pinned
// structurally identical in tests/template-contracts.test.ts, and the builder resolves each
// config against ITS OWN contract either way).
// ------------------------------------------------------------------------------------------------

describe("buildShippingTicketDefinition — config-driven, both docTypes", () => {
  it.each(["SHIPPER", "MOS_SHIPPER"] as const)(
    "a label override prints in place of the contract default (%s)", (docType) => {
      const c = cfg(docType);
      fieldOf(c, "field_strip", "po_number").label = "Client PO";
      const text = textOf(buildShippingTicketDefinition([sampleTicket()], docType, checked(c, docType)));
      expect(text).toContain("Client PO");
      expect(text).not.toContain("Purchase Order Number");
    });

  it.each(["SHIPPER", "MOS_SHIPPER"] as const)(
    "a width override lands in the table's widths array (%s)", (docType) => {
      const c = cfg(docType);
      fieldOf(c, "field_strip", "customer_job_no").width = 90;
      const def = buildShippingTicketDefinition([sampleTicket()], docType, checked(c, docType));
      expect(allWidths(def)).toContainEqual(["*", "*", 90, 70, 85]);
    });

  it("a hidden section is omitted from the stack", () => {
    const c = cfg();
    sectionOf(c, "liability").visible = false;
    const text = textOf(buildShippingTicketDefinition([sampleTicket()], "SHIPPER", checked(c)));
    expect(text).not.toContain("FIRST LIABILITY PARAGRAPH.");
    // …and the default config still prints it.
    const dflt = textOf(buildShippingTicketDefinition([sampleTicket()]));
    expect(dflt).toContain("FIRST LIABILITY PARAGRAPH.");
  });

  it("a hidden field drops its column — header cell and width both", () => {
    const c = cfg();
    fieldOf(c, "lines", "line_pounds").visible = false;
    const def = buildShippingTicketDefinition([sampleTicket()], "SHIPPER", checked(c));
    // The heading row whole: two cells, and neither is the hidden column's.
    expect(tableHeaded(def, "Quantity").body[0].map(cellTexts))
      .toEqual([["Quantity"], ["Part No.  /  Part Name  /  Part Description"]]);
    expect(allWidths(def)).toContainEqual([70, "*"]);
  });

  it("a hidden container column drops from BOTH folded groups", () => {
    const c = cfg();
    fieldOf(c, "containers", "cust_cont_id").visible = false;
    const def = buildShippingTicketDefinition([sampleTicket()], "SHIPPER", checked(c));
    expect(textOf(def)).not.toContain("Cust Cont Id");
    expect(allWidths(def)).toContainEqual([80, "*", "*", 80, "*", "*"]);
  });

  it("stack order follows the config's section order", () => {
    const c = cfg();
    const i = c.sections.findIndex((s) => s.key === "lines");
    const j = c.sections.findIndex((s) => s.key === "containers");
    [c.sections[i], c.sections[j]] = [c.sections[j], c.sections[i]];
    const text = textOf(buildShippingTicketDefinition([sampleTicket()], "SHIPPER", checked(c)));
    expect(text.indexOf("Container Type")).toBeLessThan(text.indexOf("Quantity"));
    // …the default order is the other way around.
    const dflt = textOf(buildShippingTicketDefinition([sampleTicket()]));
    expect(dflt.indexOf("Quantity")).toBeLessThan(dflt.indexOf("Container Type"));
  });

  it("field order follows the config within its section", () => {
    const c = cfg();
    const strip = sectionOf(c, "field_strip");
    const carrier = strip.fields.find((f) => f.key === "carrier")!;
    strip.fields = [carrier, ...strip.fields.filter((f) => f.key !== "carrier")];
    const def = buildShippingTicketDefinition([sampleTicket()], "SHIPPER", checked(c));
    const text = textOf(def);
    expect(text.indexOf("Carrier")).toBeLessThan(text.indexOf("Purchase Order Number"));
    expect(allWidths(def)).toContainEqual([85, "*", "*", 110, 70]);
  });

  it("the two party boxes follow config order and a hidden box leaves its slot holding position", () => {
    const swapped = cfg();
    const parties = sectionOf(swapped, "parties");
    parties.fields = [parties.fields[1], parties.fields[0]];
    const text = textOf(buildShippingTicketDefinition([sampleTicket()], "SHIPPER", checked(swapped)));
    expect(text.indexOf("Ship To:")).toBeLessThan(text.indexOf("Sold To:"));

    const hidden = cfg();
    fieldOf(hidden, "parties", "sold_to").visible = false;
    const def = buildShippingTicketDefinition([sampleTicket()], "SHIPPER", checked(hidden));
    const t = textOf(def);
    expect(t).not.toContain("Sold To:\n3054");
    expect(t).toContain("Ship To:");
    expect(t).toContain("Example Coating");
  });
});

describe("buildShippingTicketDefinition — fonts and number formats", () => {
  it("family, base size and role sizes map into the definition", () => {
    const c = cfg();
    c.fonts = { family: "Liberation Sans", baseSize: 9, headingSize: 20, smallSize: 4 };
    const def = buildShippingTicketDefinition([sampleTicket()], "SHIPPER", checked(c));
    expect(def.defaultStyle).toEqual({ font: "Liberation Sans", fontSize: 9 });
    // headingSize drives the document title; smallSize the liability fine print.
    const title = findNodes(def, (n) => n.text === "Shipping Ticket");
    expect(title[0].fontSize).toBe(20);
    const fine = findNodes(def, (n) => n.text === "FIRST LIABILITY PARAGRAPH.");
    expect(fine[0].fontSize).toBe(4);
    // …the default keeps today's literals.
    const dflt = buildShippingTicketDefinition([sampleTicket()]);
    expect(dflt.defaultStyle).toEqual({ font: "Roboto", fontSize: 8 });
    expect(findNodes(dflt, (n) => n.text === "Shipping Ticket")[0].fontSize).toBe(16);
  });

  it("thousandsSeparator: false ungroups every number style the ticket prints", () => {
    const big = sampleTicket({ totalQty: 4128,
      lines: [{ qty: 4128, partNumber: "P", partName: "N", partDescription: "D", pounds: 4128 }] });
    const c = cfg();
    c.formats.thousandsSeparator = false;
    const off = buildShippingTicketDefinition([big], "SHIPPER", checked(c));
    const text = textOf(off);
    expect(text).toContain("4128");          // num()
    expect(totalsRows(off)).toContainEqual(["Net weight:", "4128.00 lb"]);
    expect(stripRows(off)).toEqual([["Quantity Shipped:", "4128.00"], ["Net weight:", "4128.00 lb"]]);
    expect(text).not.toContain("4,128");
    const on = buildShippingTicketDefinition([big]);
    const dflt = textOf(on);
    expect(dflt).toContain("4,128");
    expect(totalsRows(on)).toContainEqual(["Net weight:", "4,128.00 lb"]);
  });
});

describe("buildShippingTicketDefinition: a line's net weight carries its unit (owner ruling W15)", () => {
  const WEIGHT = 2; // the built-in order of the lines table: line_qty, line_part, line_pounds
  const lineCells = (def: unknown, heading = "Net weight"): unknown[] =>
    tableHeaded(def, heading).body.slice(1).map((row) => row[WEIGHT]);

  it.each(BOTH)("prints each line's net weight whole, with lb (%s)", (docType) => {
    expect(lineCells(buildShippingTicketDefinition([ticket1031()], docType))).toEqual([
      { text: "1,280 lb", alignment: "right" },
      { text: "320 lb", alignment: "right" },
    ]);
  });

  type Variant = [name: string, pounds: number, config: (d: TicketDocType) => TemplateConfig, heading: string, text: string];
  const variants: Variant[] = [
    ["a reversal's line", -1280, (d) => DEFAULTS[d], "Net weight", "-1,280 lb"],
    ["the thousands knob off", 1280, ungrouped, "Net weight", "1280 lb"],
    // A stored config in today's shape whose heading was typed: the unit is the program's.
    ["a heading someone typed", 1280, (d) => normalizeStoredConfig(d, storedBefore(d, "typed-labels")), "Lbs Shipped", "1,280 lb"],
  ];
  it.each(variants)("prints the unit for %s, on both types", (_name, pounds, config, heading, text) => {
    for (const docType of BOTH) {
      const ticket = ticket1031({ lines: [{ qty: 1, partNumber: "PART1", partName: "Part", partDescription: "", pounds }] });
      const def = buildShippingTicketDefinition([ticket], docType, config(docType));
      expect(lineCells(def, heading).map(cellTexts), docType).toEqual([[text]]);
    }
  });
});

describe("buildShippingTicketDefinition: the container table's Tare column (owner ruling W16)", () => {
  const HALF = ["Container Type", "Containers", "Tare", "Cust Cont Id"];
  const TARE = 2; // its place in one half, in the built-in order
  const containerTable = (def: unknown) => tableHeaded(def, "Container Type");
  // A customer id on every row: before the column exists the third cell is that id, never blank.
  const row = (count: number, tareEach: number | null) => ({ typeName: "Bin", count, customerContainerId: "CC-9", tareEach });
  const bins = { typeName: BINS_14.typeName, count: BINS_14.count, customerContainerId: "CC-9", tareEach: BINS_14.tareEach };
  const firstRowTare = (containers: TicketData["containers"], docType: TicketDocType, config = DEFAULTS[docType]) =>
    containerTable(buildShippingTicketDefinition([ticket1031({ containers })], docType, config)).body[1][TARE];

  it.each(BOTH)("prints Tare third in both halves, sharing the spare width, on the Standard and on the stored seed config (%s)", (docType) => {
    for (const config of [DEFAULTS[docType], normalizeStoredConfig(docType, seedLiteral(docType))]) {
      const table = containerTable(buildShippingTicketDefinition([ticket1031()], docType, config));
      expect(table.body[0].map(cellTexts)).toEqual([...HALF, ...HALF].map((h) => [h]));
      expect(table.widths).toEqual([80, "*", "*", 62, 80, "*", "*", 62]);
    }
  });

  it.each(BOTH)("a row's Tare cell is its tare total over its tare each in small grey type, centred (%s)", (docType) => {
    const [, first] = containerTable(buildShippingTicketDefinition([ticket1031()], docType)).body;
    expect(first[TARE]).toEqual({
      alignment: "center",
      stack: [{ text: "127.5 lb" }, { text: "42.5 lb each", fontSize: 6.5, color: "#444444" }],
    });
    // One row fills the left half only. The right half's Tare cell is empty, with no unit.
    expect(first[TARE + HALF.length]).toEqual({ text: "" });
  });

  const forms: [name: string, container: TicketData["containers"][number], texts: string[]][] = [
    ["fourteen bins at 310", bins, ["4,340 lb", "310 lb each"]],
    ["a tare each of 0", row(2, 0), ["0 lb", "0 lb each"]],
    ["a row with no tare each", row(3, null), [""]],
    // 2 × 9,999,999,999.99 lb is past the largest weight the calculation returns.
    ["a row whose total cannot be worked out", row(2, CEILING_LB), ["", "9,999,999,999.99 lb each"]],
  ];
  it.each(forms)("the Tare cell of %s, on both types", (_name, container, texts) => {
    for (const docType of BOTH) expect(cellTexts(firstRowTare([container], docType)), docType).toEqual(texts);
  });

  it("prints both lines of the cell in the ticket's number format: grouped by the thousands knob, plain without it", () => {
    // 2 bins at 1,250.5 lb are 2,501 lb, so each line shows the knob.
    expect(cellTexts(firstRowTare([row(2, 1250.5)], "SHIPPER"))).toEqual(["2,501 lb", "1,250.5 lb each"]);
    expect(cellTexts(firstRowTare([row(2, 1250.5)], "SHIPPER", ungrouped("SHIPPER")))).toEqual(["2501 lb", "1250.5 lb each"]);
  });

  it.each(BOTH)("prints the headings over one empty row for an order with no containers (%s)", (docType) => {
    const table = containerTable(buildShippingTicketDefinition([ticket1031({ containers: [] })], docType));
    expect(table.body[0].map(cellTexts)).toEqual([...HALF, ...HALF].map((h) => [h]));
    expect(table.body.slice(1).map((r) => r.map(cellTexts))).toEqual([Array.from({ length: 8 }, () => [""])]);
  });

  it.each(BOTH)("a hidden Tare column drops from both halves: heading, cell and width (%s)", (docType) => {
    // A config saved under the new contract: only such a one can hide the new column.
    const c = cfg(docType);
    fieldOf(c, "containers", "container_tare").visible = false;
    const table = containerTable(buildShippingTicketDefinition([ticket1031()], docType, checked(c, docType)));
    const three = ["Container Type", "Containers", "Cust Cont Id"];
    expect(table.body.map((r) => r.map(cellTexts))).toEqual([
      [...three, ...three].map((h) => [h]),
      [["Steel Basket"], ["3"], ["CC-1"], [""], [""], [""]],
    ]);
    expect(table.widths).toEqual([80, "*", 62, 80, "*", 62]);
  });

  const reordered: [name: string, half: string[], widths: (number | string)[]][] = [
    ["container-columns-moved", ["Cust Cont Id", "Container Type", "Tare", "Containers"], [62, 80, "*", "*"]],
    ["count-hidden", ["Container Type", "Tare", "Cust Cont Id"], [80, "*", 62]],
  ];
  it.each(reordered)("a stored config in today's shape gains Tare where its own order puts it: %s", (name, half, widths) => {
    for (const docType of BOTH) {
      const config = normalizeStoredConfig(docType, storedBefore(docType, name));
      const table = containerTable(buildShippingTicketDefinition([ticket1031()], docType, config));
      expect(table.body[0].map(cellTexts), docType).toEqual([...half, ...half].map((h) => [h]));
      expect(table.widths, docType).toEqual([...widths, ...widths]);
      expect(cellTexts(table.body[1][half.indexOf("Tare")]), docType).toEqual(["127.5 lb", "42.5 lb each"]);
    }
  });

  it.each(BOTH)("a stored config that hid Containers prints no Tare column (%s)", (docType) => {
    const config = normalizeStoredConfig(docType, storedBefore(docType, "containers-hidden"));
    const texts = allText(buildShippingTicketDefinition([ticket1031()], docType, config));
    expect(texts.filter((t) => t === "Tare" || t === "Container Type" || t.endsWith(" lb each"))).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------
// THE TWO-DATE-STYLES TRAP (Task 1 review carry, BINDING): one date knob, two printed styles.
// The knob maps to the header's `shortDate` slot ONLY; the tear-off's zero-padded "Shipped ON"
// keeps `paddedDate` UNCONDITIONALLY — both assertions in one test, per the Task 9 brief.
// ------------------------------------------------------------------------------------------------

describe("buildShippingTicketDefinition — the date knob maps to the header ONLY", () => {
  it("moves the header date and provably NOT the tear-off date", () => {
    const c = cfg();
    c.formats.dateFormat = "YYYY-MM-DD";
    const text = textOf(buildShippingTicketDefinition([sampleTicket()], "SHIPPER", checked(c)));
    expect(text).toContain("Ship Date: 2026-07-29");          // the knob moved the header…
    expect(text).toContain("Shipped ON: 07/29/2026");         // …and the tear-off DID NOT move.
    expect(text).not.toContain("Ship Date: 7/29/2026");
  });

  it("every fixed date style renders in the header; the tear-off never follows", () => {
    const styles: [string, string][] = [
      ["M/D/YYYY", "Ship Date: 7/29/2026"],
      ["MM/DD/YYYY", "Ship Date: 07/29/2026"],
      ["YYYY-MM-DD", "Ship Date: 2026-07-29"],
      ["MMMM D, YYYY", "Ship Date: July 29, 2026"],
      ["MMM - DD - YYYY", "Ship Date: Jul - 29 - 2026"],
    ];
    for (const [format, expected] of styles) {
      const c = cfg();
      c.formats.dateFormat = format as TemplateConfig["formats"]["dateFormat"];
      const text = textOf(buildShippingTicketDefinition([sampleTicket()], "SHIPPER", checked(c)));
      expect(text).toContain(expected);
      expect(text).toContain("Shipped ON: 07/29/2026");
    }
  });
});

// ------------------------------------------------------------------------------------------------
// The §5.6 belt, both halves. The ticket contracts lock NOTHING (shipper.ts's own header:
// "spec §5.6's locks are traveler-only"), so the flag half's observable duty is the NEGATIVE
// direction — the belt must not force visible what the contract allows hiding — and the omission
// half (completeSections) must still re-materialize entries a raw config drops.
// ------------------------------------------------------------------------------------------------

describe("buildShippingTicketDefinition — the §5.6 belt", () => {
  it("nothing on this contract is locked: a validated config may hide ANY section and the builder honors it", () => {
    const c = cfg();
    sectionOf(c, "header").visible = false;
    sectionOf(c, "tear_off").visible = false;
    const validated = checked(c); // accepted — contrast with the traveler's locked refusals
    const text = textOf(buildShippingTicketDefinition([sampleTicket()], "SHIPPER", validated));
    expect(text).not.toContain("Shipping Ticket");
    expect(text).not.toContain("Received By:");
  });

  it("a raw config OMITTING the totals section entry still renders it (the omission half)", () => {
    const c = cfg();
    c.sections = c.sections.filter((s) => s.key !== "totals");
    const def = buildShippingTicketDefinition([sampleTicket()], "SHIPPER", c);
    expect(textOf(def)).toContain("Quantity Shipped:");
    // Whole cells, old wording or new. Two: the totals row's label and the strip's. The strip
    // alone prints one.
    expect(allText(def).filter((t) => t === "Net weight:" || t === "Pounds Shipped:")).toEqual(["Net weight:", "Net weight:"]);
  });

  it("a raw config OMITTING a field entry inside a present section still renders it", () => {
    const c = cfg();
    const strip = sectionOf(c, "field_strip");
    strip.fields = strip.fields.filter((f) => f.key !== "route");
    const text = textOf(buildShippingTicketDefinition([sampleTicket()], "SHIPPER", c));
    expect(text).toContain("Route");
    expect(text).toContain("South");
  });
});

// ------------------------------------------------------------------------------------------------
// Logo placement (spec §6.3) — the traveler's slot mechanics on the ticket's header.
// ------------------------------------------------------------------------------------------------

const LOGO_URI = "data:image/png;base64,TICKETLOGOFIXTURE";

describe("buildShippingTicketDefinition — logo placement", () => {
  const placedConfig = (placement: "header-left" | "header-center" | "header-right") => {
    const c = cfg();
    c.logo = { placement, width: 110 };
    return checked(c);
  };
  /** The header's three column stacks, structurally. */
  const headerStacks = (def: unknown): { image?: string; width?: number }[][] => {
    const sheet = (def as { content: { stack: { columns: { stack: never[] }[] }[] }[] }).content[0];
    return sheet.stack[0].columns.map((col) => col.stack);
  };

  it.each([["header-left", 0], ["header-center", 1], ["header-right", 2]] as const)(
    "a placed logo joins the %s slot at its configured width", (placement, colIdx) => {
      const def = buildShippingTicketDefinition([sampleTicket()], "SHIPPER", placedConfig(placement), LOGO_URI);
      const stacks = headerStacks(def);
      expect(stacks[colIdx][0]).toEqual({ image: LOGO_URI, width: 110 });
    });

  it("config placement without bytes, and bytes without placement, both fall back to the text-only header", () => {
    const placed = buildShippingTicketDefinition([sampleTicket()], "SHIPPER", placedConfig("header-center"));
    expect(JSON.stringify(placed)).not.toContain(LOGO_URI);
    const unplaced = buildShippingTicketDefinition([sampleTicket()], "SHIPPER", cfg(), LOGO_URI);
    expect(JSON.stringify(unplaced)).not.toContain(LOGO_URI);
  });
});

// ------------------------------------------------------------------------------------------------
// The tear-off reflow (P7 spec §5.6 ruling-3 guardrail; HANDOFF §7 item 5.3). The strip used to
// be stamped at `absolutePosition {x:24, y:648}`, so past ~8 extra multi-line part rows the
// flowed table ran UNDER it. Flow-based, the strip follows the content — the reading-order
// assertions below decode RENDERED bytes with their positions (textRunsWithY): on any page the
// strip shares with part rows, every row must sit ABOVE the strip's topmost text.
// ------------------------------------------------------------------------------------------------

/** `count` stacked three-line part rows with distinctive, greppable part numbers. */
function manyRowTicket(count: number): TicketData {
  return sampleTicket({
    lines: Array.from({ length: count }, (_, i) => ({
      qty: 10 + i, partNumber: `RFL-${String(i + 1).padStart(2, "0")}`,
      partName: "Reflow Regression Part", partDescription: "Stacked third line",
      pounds: 100 + i,
    })),
  });
}

/** The strip's textual TOP on a page: the bare tear-off order number ("92036" — the header
 *  prints "92036-3", so the bare run is unique to the strip). */
const tearTopY = (runs: { text: string; y: number }[]): number | null => {
  const run = runs.find((r) => r.text.trim() === "92036");
  return run === undefined ? null : run.y;
};
const partYs = (runs: { text: string; y: number }[]): number[] =>
  runs.filter((r) => r.text.trim().startsWith("RFL-")).map((r) => r.y);

/** A validated config keeping only the blocks ABOVE the part table plus the strip itself — the
 *  layout a long pick list legitimately produces, and the exact regime the HANDOFF §7 item 5.3
 *  ping describes: enough part rows and the table reaches the strip's old fixed slot (y=648,
 *  device y≈128). Nothing on this contract is locked, so the validator accepts the hiding. */
const longTableConfig = (): TemplateConfig => {
  const c = cfg();
  for (const key of ["containers", "serials", "liability", "totals"]) {
    sectionOf(c, key).visible = false;
  }
  return checked(c);
};

describe("the tear-off strip is flow-based (the >8-row overlap regression)", () => {
  it("the definition carries no absolutePosition anywhere", () => {
    const def = buildShippingTicketDefinition([sampleTicket()]);
    expect(JSON.stringify(def)).not.toContain("absolutePosition");
  });

  it("a part table reaching the strip's old fixed slot reflows instead of running under it", async () => {
    // 16 three-line rows end below device y≈128 — inside the absolutely-positioned strip's box.
    const pdf = await renderPdf(
      buildShippingTicketDefinition([manyRowTicket(16)], "SHIPPER", longTableConfig()));
    const pages = textRunsWithY(pdf);

    // Every row printed, and the strip printed once.
    const flat = pages.flat().map((r) => r.text).join("");
    for (let i = 1; i <= 16; i++) expect(flat).toContain(`RFL-${String(i).padStart(2, "0")}`);
    expect(flat).toContain("Received By:");

    const tearPage = pages.findIndex((runs) => tearTopY(runs) !== null);
    expect(tearPage).toBeGreaterThanOrEqual(0);
    const lastPartPage = pages.reduce((last, runs, i) => (partYs(runs).length > 0 ? i : last), -1);
    // Reading order: the strip never precedes part rows…
    expect(tearPage).toBeGreaterThanOrEqual(lastPartPage);
    // …and on the page they share (if any), every row sits ABOVE the strip's top (device y is
    // bottom-up: higher on paper = larger y). Pre-reflow this is the exact violation: rows past
    // y≈648-from-top drew UNDER the absolutely-positioned strip.
    const sharedPartYs = partYs(pages[tearPage]);
    const top = tearTopY(pages[tearPage])!;
    for (const y of sharedPartYs) expect(y).toBeGreaterThan(top);
  });

  it("a longer table shares its last page with the strip, rows strictly above it (the flow pin)", async () => {
    const pdf = await renderPdf(
      buildShippingTicketDefinition([manyRowTicket(24)], "SHIPPER", longTableConfig()));
    const pages = textRunsWithY(pdf);
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(2);

    const tearPage = pages.findIndex((runs) => tearTopY(runs) !== null);
    const shared = partYs(pages[tearPage]);
    expect(shared.length).toBeGreaterThan(0); // the strip and the table tail DO share this page
    const top = tearTopY(pages[tearPage])!;
    for (const y of shared) expect(y).toBeGreaterThan(top);
  });
});

/** One ticket rendered the way a print renders it: the builder of one definition a ticket,
 *  through `renderSheetGroups`. */
const printed = async (ticket: TicketData, config: TemplateConfig) => {
  const pdf = await renderSheetGroups(buildShippingTicketDefinitions([ticket], "SHIPPER", config));
  return { pdf, runs: textRunsWithY(pdf)[0], pages: pageCount(pdf) };
};
const tenth = (n: number) => Math.round(n * 10) / 10;

describe("the Sold To box stacks the bill-to row's name above the customer's (R14, #671)", () => {
  it("prints the row's name above the customer's in the box, and the tear-off's Sold To line stays the customer's name alone", async () => {
    const { pdf } = await printed(sampleTicket({ soldTo: { ...sampleTicket().soldTo, attn: "Accounts Payable" } }), cfg());
    // The Sold To box is the left column, so its lines lead the printed line they share with the
    // Ship To box's.
    const lines = textLinesWithY(pdf)[0];
    const attn = lines.find((l) => l.text.startsWith("Accounts Payable"));
    const name = lines.find((l) => l.text.startsWith("Demo Components Corporation"));
    expect(attn).toBeDefined();
    expect(name).toBeDefined();
    expect(attn!.y).toBeGreaterThan(name!.y);
    // The strip's one-line Sold To is the customer's name with its label, never the stack.
    const strip = lines.filter((l) => l.text.includes("Demo Components Corporation") && !l.text.startsWith("Demo Components Corporation"));
    expect(strip).toHaveLength(1);
    expect(strip[0].text).toContain("Sold To");
    expect(strip[0].text).not.toContain("Accounts Payable");
    expect(lines.filter((l) => l.text.includes("Accounts Payable"))).toHaveLength(1);
  });

  it("with no row name the box prints the customer's name alone, as before", async () => {
    const { pdf } = await printed(sampleTicket(), cfg());
    const lines = textLinesWithY(pdf)[0];
    expect(lines.filter((l) => l.text.startsWith("Demo Components Corporation"))).toHaveLength(1);
    expect(lines.some((l) => l.text.includes("Accounts Payable"))).toBe(false);
  });
});

describe("the ticket's container table on a rendered page (weights design §13.5)", () => {
  /** How far right the rules of the first page reach. The configs this block renders type widths
   *  on the container table alone, and under them no other rule passes the right margin, 588, so
   *  a figure past it is the container table's. */
  const ruleEnd = (pdf: Buffer) => Math.max(...strokedLines(pdf)[0].map((l) => Math.max(l.x1, l.x2)));
  /** The words on the same printed line as the one run that reads `first`, left to right. */
  const lineOf = (runs: { text: string; x: number; y: number }[], first: string): string => {
    const hits = runs.filter((r) => r.text.trim() === first);
    expect(hits, `one run reads ${first}`).toHaveLength(1);
    return runs.filter((r) => Math.abs(r.y - hits[0].y) < 0.5).sort((a, b) => a.x - b.x)
      .map((r) => r.text.trim()).join(" ");
  };
  const twoRows = (rightEach: number) => ticket1031({ containers: [
    { typeName: "LEFTTYPE", count: 3, customerContainerId: "LEFTID", tareEach: 42.5 },
    { typeName: "RIGHTTYPE", count: 3, customerContainerId: "RIGHTID", tareEach: rightEach },
  ] });

  it("prints each half of the Standard table as 80, 54, 54 and 62 points", async () => {
    // One letter typed on all four headings. Each is centred, so its left edge is its column's
    // centre less the same half width, and the gaps between them give the columns. A column
    // takes its width and 8 points of padding. A left-aligned cell starts 4 points in.
    const c = cfg();
    for (const key of ["container_type", "container_count", "container_tare", "cust_cont_id"]) {
      fieldOf(c, "containers", key).label = "X";
    }
    const { pdf, runs, pages } = await printed(twoRows(42.5), checked(c));
    const x = (text: string) => runs.find((r) => r.text.trim() === text)!.x;
    const heads = runs.filter((r) => r.text.trim() === "X").map((r) => r.x).sort((a, b) => a - b);
    expect(heads).toHaveLength(8);
    const firstThree = x("LEFTID") - x("LEFTTYPE");
    const tare = firstThree - 2 * (heads[1] - heads[0]);
    const type = firstThree - 2 * (heads[2] - heads[1]);
    const count = firstThree - type - tare;
    const custId = 2 * (heads[3] - heads[2]) - tare;
    const widths = [type, count, tare, custId].map((padded) => tenth(padded - 8));
    measured("the Standard half's columns", { widths, tableStartsAt: tenth(x("LEFTTYPE") - 4), ruleEndsAt: tenth(ruleEnd(pdf)), pages });
    expect(widths).toEqual([80, 54, 54, 62]);
  });

  it("prints Containers, 127.5 lb, 99,999.99 lb and a line's 1,280 lb each on one line, on one page", async () => {
    // 3 at 33,333.33 are 99,999.99. The built-in labels, at the Standard widths.
    const { runs, pages } = await printed(twoRows(33333.33), DEFAULTS.SHIPPER);
    const headWords = ["Container", "Type", "Containers", "Tare", "Cust", "Cont", "Id"];
    const headYs = runs.filter((r) => headWords.includes(r.text.trim())).map((r) => r.y.toFixed(1));
    measured("the heading row", { words: headYs.length, lines: new Set(headYs).size, pages });
    expect([headYs.length, new Set(headYs).size]).toEqual([14, 1]);
    expect(lineOf(runs, "127.5")).toBe("LEFTTYPE 3 127.5 lb LEFTID RIGHTTYPE 3 99,999.99 lb RIGHTID");
    expect(lineOf(runs, "42.5")).toBe("42.5 lb each 33,333.33 lb each");
    expect(lineOf(runs, "1,280")).toBe("200 PART1 1,280 lb");
    expect(pages).toBe(1);
  });

  it("prints the heading row over both halves of the table on a ticket that passes a page", async () => {
    // Thirty part lines of three printed lines each make a ticket of more than one page, which
    // the renderer draws in its second pass. A one-page ticket is its first pass's bytes.
    const ticket = { ...twoRows(42.5), lines: manyRowTicket(30).lines };
    const pdf = await renderSheetGroups(buildShippingTicketDefinitions([ticket], "SHIPPER", DEFAULTS.SHIPPER));
    const pages = pageCount(pdf);
    expect(pages).toBeGreaterThan(1);
    const tablePage = textRunsWithY(pdf).find((runs) => runs.some((r) => r.text.trim() === "LEFTTYPE")) ?? [];
    const headWords = ["Container", "Type", "Containers", "Tare", "Cust", "Cont", "Id"];
    const heads = tablePage.filter((r) => headWords.includes(r.text.trim())).sort((a, b) => a.x - b.x)
      .map((r): [word: string, x: number] => [r.text.trim(), Math.round(r.x)]);
    measured("the heading row of a ticket past one page", { pages, heads });
    // Where each word of the left half starts. The fold is one half's 282 points from the left
    // margin, so each word of the right half starts 282 points right of its twin.
    const left: [word: string, x: number][] = [
      ["Container", 41], ["Type", 78], ["Containers", 124], ["Tare", 197], ["Cust", 249], ["Cont", 267], ["Id", 286],
    ];
    expect(heads).toEqual([...left, ...left.map(([word, x]) => [word, x + 282])]);
  });

  // `typed`, where it is not null, is a width put on Container Type in this case alone.
  // Owner ruling R-B (2026-11-17, #991): a config whose container columns and padding pass the half is refused by the
  // contracts, so a stored one no longer prints.
  it.each(["widths-full", "type-width-220"])("a stored config whose columns pass the half is refused since R-B: %s", (name) => {
    expect(() => normalizeStoredConfig("SHIPPER", storedBefore("SHIPPER", name))).toThrow(/^The "containers" table needs /);
  });
  const noRoom: [label: string, name: string, typed: number | null, fits: boolean][] = [
    // Since #991 a table whose fixed columns and padding fit its half keeps inside the page under the
    // column clamp, its heading words breaking in their shares: these two printed past the margin before.
    ["type-width-130", "type-width-130", null, true],
    ["type-width-110, a share of 39", "type-width-110", null, true],
    ["type-width-110 typed to 111, a share of 38.5", "type-width-110", 111, true],
  ];
  it.each(noRoom)("a stored config with little or no room still prints one page: %s", async (label, name, typed, fits) => {
    const stored = storedBefore("SHIPPER", name) as TemplateConfig;
    if (typed !== null) fieldOf(stored, "containers", "container_type").width = typed;
    const { pdf, pages } = await printed(ticket1031(), normalizeStoredConfig("SHIPPER", stored));
    const end = ruleEnd(pdf);
    measured(label, { pages, ruleEndsAt: tenth(end), pastTheMargin: tenth(end - 588) });
    expect(pages).toBe(1);
    if (fits) expect(end).toBeCloseTo(588, 1);
    else expect(end).toBeGreaterThan(588.05);
  });
});

// ------------------------------------------------------------------------------------------------
// Per-ticket sheet groups (P7 spec §6.1): one RenderableDefinition per order's ticket, merged by
// renderSheetGroups in the print path — the traveler's Task 8 shape. Each definition carries ITS
// order's continuation band and (behind the pageFooter knob, default OFF) its own per-group
// page-number footer.
// ------------------------------------------------------------------------------------------------

describe("buildShippingTicketDefinitions — one definition per ticket (pure)", () => {
  const twoTickets = (): TicketData[] => [
    sampleTicket(),
    sampleTicket({ orderLabel: "72037-1", orderNumber: 72037, poNumber: "PO-B" }),
  ];

  it("returns one definition per ticket, each content-identical to the singular's per-sheet stack", () => {
    const defs = buildShippingTicketDefinitions(twoTickets());
    expect(defs).toHaveLength(2);
    const singular = buildShippingTicketDefinition(twoTickets());
    const singularStacks = (singular.content as { stack: unknown }[]).map((c) => c.stack);
    const groupStacks = defs.map((d) => (d.content as { stack: unknown }[])[0].stack);
    expect(groupStacks).toEqual(singularStacks);
  });

  it("each definition carries ITS order's continuation band — never a sibling ticket's", () => {
    const defs = buildShippingTicketDefinitions(twoTickets());
    const bands = defs.map((d) => allText(d.continuationHeaderSpec!.content).join("\n"));
    expect(bands[0]).toContain("Order No.: 92036-3");
    expect(bands[0]).toContain("(continued)");
    expect(bands[0]).not.toContain("72037");
    expect(bands[1]).toContain("Order No.: 72037-1");
    expect(bands[1]).not.toContain("92036");
    // The band draws in the top margin; the reserve must clear its own height.
    expect(defs[0].continuationHeaderSpec!.overflowTopMargin).toBeGreaterThanOrEqual(36);
  });

  it("the band carries a label override but ignores the visibility flags — identity on paper is locked", () => {
    const c = cfg();
    fieldOf(c, "header", "order_no").label = "Work Order:";
    fieldOf(c, "header", "order_no").visible = false;
    const defs = buildShippingTicketDefinitions([sampleTicket()], "SHIPPER", checked(c));
    const band = allText(defs[0].continuationHeaderSpec!.content).join("\n");
    expect(band).toContain("Work Order: 92036-3");
    // …while the sheet body itself honours the hide.
    expect(textOf(defs[0].content)).not.toContain("Work Order:");
  });

  it("the pageFooter knob turns on the per-group footer spec and widens the bottom margin; default stays off", () => {
    const on = cfg();
    on.pageFooter = true;
    const withFooter = buildShippingTicketDefinitions(twoTickets(), "SHIPPER", checked(on));
    expect(withFooter[0].pageFooterSpec).toEqual({ kind: "pageNofM" });
    expect(withFooter[0].pageMargins).toEqual([24, 24, 24, 44]);

    const dflt = buildShippingTicketDefinitions(twoTickets());
    expect(dflt[0].pageFooterSpec).toBeUndefined();
    expect(dflt[0].pageMargins).toEqual([24, 24, 24, 24]); // golden — today's margins exactly
  });

  it("is pure: plain JSON, deterministic, spec keys included", () => {
    const defs = buildShippingTicketDefinitions(twoTickets(), "MOS_SHIPPER");
    expect(JSON.parse(JSON.stringify(defs))).toEqual(defs);
    expect(buildShippingTicketDefinitions(twoTickets(), "MOS_SHIPPER")).toEqual(defs);
  });
});

// ------------------------------------------------------------------------------------------------
// Purity, config included.
// ------------------------------------------------------------------------------------------------

describe("buildShippingTicketDefinition — purity, config included", () => {
  it("a config-driven definition survives the JSON round trip and is deterministic", () => {
    const c = cfg("MOS_SHIPPER");
    c.logo = { placement: "header-right", width: 90 };
    fieldOf(c, "lines", "line_qty").label = "Pieces";
    c.formats.dateFormat = "MMMM D, YYYY";
    const config = checked(c, "MOS_SHIPPER");
    const def = buildShippingTicketDefinition([sampleTicket()], "MOS_SHIPPER", config, LOGO_URI);
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
    expect(buildShippingTicketDefinition([sampleTicket()], "MOS_SHIPPER", config, LOGO_URI)).toEqual(def);
  });
});

// ------------------------------------------------------------------------------------------------
// The totals and the tear-off strip (weights design §13.2; §13.3, TK7 to TK11). Net, tare and
// gross are the sheet's own order's, worked out by the builder from the rows it is handed.
// ------------------------------------------------------------------------------------------------

const NET_1031 = ORDER_1031.lines.map((l) => l.weight);                        // 1,280 and 320
const ROWS_1031 = ORDER_1031.containers.map((c) => bin(c.count, c.tareEach));  // 3 at 42.5
const ticketOf = (pounds: number[], containers: TicketContainer[]): TicketData =>
  sampleTicket({ lines: linesOf(pounds), containers, totalQty: 300 });
const QTY = ["Quantity Shipped:", "300"];
const NET = ["Net weight:", "1,600.00 lb"];
const TARE = ["Tare:", "127.50 lb"];
const GROSS = ["Gross weight:", "1,727.50 lb"];
const STRIP_QTY = ["Quantity Shipped:", "300.00"];

describe.each(["SHIPPER", "MOS_SHIPPER"] as const)("the ticket's totals and strip (%s)", (docType) => {
  it.each<[state: string, pounds: number[], containers: TicketContainer[], weightRows: string[][]]>([
    ["with a gross", NET_1031, ROWS_1031, [NET, TARE, GROSS]],
    ["with no container rows", NET_1031, [], [NET]],
    ["with a container row that has no tare each", NET_1031, [...ROWS_1031, bin(2, null)], [NET]],
    ["with a tare each of 0", NET_1031, [bin(3, 0)], [NET, ["Tare:", "0.00 lb"], ["Gross weight:", "1,600.00 lb"]]],
    ["with fourteen bins at 310 on 4,128.00 lb of parts", [4128], [bin(BINS_14.count, BINS_14.tareEach)],
      [["Net weight:", "4,128.00 lb"], ["Tare:", "4,340.00 lb"], ["Gross weight:", "8,468.00 lb"]]],
    ["with line weights too large to add up", [CEILING_LB, 0.01], ROWS_1031, [["Net weight:", ""]]],
    ["with a tare too large to work out", NET_1031, [bin(2, CEILING_LB)], [NET]],
    ["with a net and a tare too large together", [CEILING_LB], ROWS_1031, [["Net weight:", "9,999,999,999.99 lb"]]],
    ["for a reversal", [-1280, -320], [], [["Net weight:", "-1,600.00 lb"]]],
    ["for order 1032, which lists no containers", ORDER_1032.lines.map((l) => l.weight), [], [["Net weight:", "450.00 lb"]]],
    ["for an order with no line on the shipment", [], [], [["Net weight:", "0.00 lb"]]],
    ["for an order with containers and no line on the shipment", [], ROWS_1031,
      [["Net weight:", "0.00 lb"], TARE, ["Gross weight:", "127.50 lb"]]],
  ])("state by state: %s", (_state, pounds, containers, weightRows) => {
    const def = buildShippingTicketDefinition([ticketOf(pounds, containers)], docType);
    expect(totalsRows(def)).toEqual([QTY, ...weightRows]);
    // The strip states the totals' own net text, and nothing of tare or gross (owner ruling W16).
    expect(stripRows(def)).toEqual([STRIP_QTY, weightRows[0]]);
  });

  // Stored configs in the shape an install holds today: the two rows arrive shown, where the
  // backfill puts them, and a typed label keeps its words over the figure and its unit.
  it.each<[stored: string, config: () => unknown, rows: string[][]]>([
    ["the seed migration's literal", () => seedLiteral(docType), [QTY, NET, TARE, GROSS]],
    ["typed-labels", () => storedBefore(docType, "typed-labels"), [QTY, ["Pounds Shipped:", "1,600.00 lb"], TARE, GROSS]],
    ["net-row-hidden", () => storedBefore(docType, "net-row-hidden"), [QTY, TARE, GROSS]],
    ["totals-rows-moved", () => storedBefore(docType, "totals-rows-moved"), [NET, QTY, TARE, GROSS]],
    ["totals-hidden", () => storedBefore(docType, "totals-hidden"), []],
  ])("a config stored before the two rows existed: %s", (_stored, config, rows) => {
    const def = buildShippingTicketDefinition(
      [ticketOf(NET_1031, ROWS_1031)], docType, normalizeStoredConfig(docType, config()));
    expect(totalsRows(def)).toEqual(rows);
    expect(stripRows(def)).toEqual([STRIP_QTY, NET]);
  });
});

describe("the ticket's totals block (the Standard config)", () => {
  const gross = () => ticketOf(NET_1031, ROWS_1031);

  it("is one right-hand table: a bold 12-point label and an 11-point figure on each row, both right-aligned", () => {
    const label = (text: string) => ({ text, bold: true, fontSize: 12, alignment: "right" });
    const figure = (text: string) => ({ text, fontSize: 11, alignment: "right" });
    const blocks = findNodes(buildShippingTicketDefinition([gross()]), (n) =>
      Array.isArray(n.columns) && (n.columns as { layout?: unknown }[]).some((col) => col.layout === "noBorders"));
    expect(blocks).toEqual([{ columns: [
      { width: "*", text: "" },
      { width: 260, layout: "noBorders", table: { widths: ["*", 80], body: [
        [label("Quantity Shipped:"), figure("300")],
        [label("Net weight:"), figure("1,600.00 lb")],
        [label("Tare:"), figure("127.50 lb")],
        [label("Gross weight:"), figure("1,727.50 lb")],
      ] } },
    ] }]);
  });

  it.each<[hidden: string, labels: string[]]>([
    ["total_tare", ["Quantity Shipped:", "Net weight:", "Gross weight:"]],
    ["total_gross", ["Quantity Shipped:", "Net weight:", "Tare:"]],
    ["total_weight", ["Quantity Shipped:", "Tare:", "Gross weight:"]],
    ["total_qty", ["Net weight:", "Tare:", "Gross weight:"]],
  ])("a hidden %s leaves its own row out and no other", (hidden, labels) => {
    const c = cfg();
    fieldOf(c, "totals", hidden).visible = false;
    const def = buildShippingTicketDefinition([gross()], "SHIPPER", checked(c));
    expect(totalsRows(def).map(([label]) => label)).toEqual(labels);
  });

  it("with every row hidden it draws no table", () => {
    const c = cfg();
    for (const key of ["total_qty", "total_weight", "total_tare", "total_gross"]) fieldOf(c, "totals", key).visible = false;
    expect(totalsTable(buildShippingTicketDefinition([gross()], "SHIPPER", checked(c)))).toBeUndefined();
  });
});

describe.each(BOTH)("the ticket's totals are one block that a page break does not part where it fits a page (%s)", (docType) => {
  const ROW_KEYS = ["total_qty", "total_weight", "total_tare", "total_gross"];
  const BANNER = { text: "Shipped Complete", bold: true, fontSize: 12, alignment: "center", margin: [0, 2, 0, 6] };
  /** One sheet of order 1031 under this type's default config with these totals fields hidden. */
  const sheetWith = (hidden: string[], shippedComplete = true) => {
    const c = cfg(docType);
    for (const key of hidden) fieldOf(c, "totals", key).visible = false;
    return buildShippingTicketDefinition([{ ...ticketOf(NET_1031, ROWS_1031), shippedComplete }], docType, checked(c, docType));
  };

  // The block whole: an unbreakable stack of the banner and the rows' columns, and no other key, so
  // no margin of its own. Under the built-in labels it carries no id, so nothing measures it (#673,
  // the case table below). The rows' columns are the node the case above holds whole.
  it.each<[state: string, hidden: string[], complete: boolean, parts: ("banner" | "rows")[]]>([
    ["the banner over the rows", [], true, ["banner", "rows"]],
    ["the rows alone when the banner's field is hidden", ["shipped_complete"], true, ["rows"]],
    ["the rows alone on a sheet that is not complete", [], false, ["rows"]],
    ["the banner over the rows that are left when the Tare row is hidden", ["total_tare"], true, ["banner", "rows"]],
    ["the banner alone when every row is hidden", ROW_KEYS, true, ["banner"]],
  ])("is one unbreakable stack: %s", (_state, hidden, complete, parts) => {
    const def = sheetWith(hidden, complete);
    const rows = { columns: [{ width: "*", text: "" }, totalsTable(def)] };
    expect(totalsBlock(def)).toEqual({
      unbreakable: true, stack: parts.map((part) => (part === "banner" ? BANNER : rows)),
    });
  });

  it("is not drawn when the banner's field and every row are hidden", () => {
    expect(totalsBlock(sheetWith(["shipped_complete", ...ROW_KEYS]))).toBeUndefined();
  });

  it("is not drawn when the Totals section is hidden", () => {
    const c = cfg(docType);
    sectionOf(c, "totals").visible = false;
    const def = buildShippingTicketDefinition([ticketOf(NET_1031, ROWS_1031)], docType, checked(c, docType));
    expect(totalsBlock(def)).toBeUndefined();
  });
});

// Which totals blocks the renderer measures (#673, owner ruling R16): the block carries the id
// `ticket-totals`, which the renderer finds it by, only where the template holds a typed label for
// one of the Totals section's fields, the tear-off strip's input-bounded rule. Under the built-in
// labels its size is bounded (a 12-point banner over four 12- and 11-point rows of figures and
// "lb"), and each measurement was one more render a ticket.
describe.each(BOTH)("the totals block carries the id the renderer measures it by only where a totals label is typed (%s)", (docType) => {
  const blockOf = (edit: (c: TemplateConfig) => void = () => {}) => {
    const c = cfg(docType);
    edit(c);
    return totalsBlock(buildShippingTicketDefinition(
      [{ ...ticketOf(NET_1031, ROWS_1031), shippedComplete: true }], docType, checked(c, docType)));
  };
  const typed = (section: string, key: string, label = "Typed label:") => (c: TemplateConfig) => {
    fieldOf(c, section, key).label = label;
  };
  const MEASURED = { id: "ticket-totals", unbreakable: true };
  /** Every field key of this type's Totals section, banner included, read from its contract. */
  const totalsKeys = contractFor(docType).sections.find((s) => s.key === "totals")!.fields.map((f) => f.key);

  it("carries no id under the built-in labels: it keeps its mark", () => {
    const block = blockOf();
    expect(Object.keys(block!).sort()).toEqual(["stack", "unbreakable"]);
  });

  it("carries no id under the seed migration's literal", () => {
    const def = buildShippingTicketDefinition(
      [{ ...ticketOf(NET_1031, ROWS_1031), shippedComplete: true }], docType, normalizeStoredConfig(docType, seedLiteral(docType)));
    expect(totalsBlock(def)).not.toHaveProperty("id");
  });

  it("names the banner among its fields", () => {
    expect(totalsKeys).toContain("shipped_complete");
  });

  it.each(totalsKeys)("carries the id where the label of %s is typed", (key) => {
    expect(blockOf(typed("totals", key))).toMatchObject(MEASURED);
  });

  it("carries the id where the typed label is on a hidden field and the others are shown", () => {
    expect(blockOf((c) => {
      typed("totals", "total_tare")(c);
      fieldOf(c, "totals", "total_tare").visible = false;
    })).toMatchObject(MEASURED);
  });

  it("carries the id where the stored label is empty, or typed in the built-in wording", () => {
    expect(blockOf(typed("totals", "total_qty", ""))).toMatchObject(MEASURED);
    const builtIn = contractFor(docType).sections.find((s) => s.key === "totals")!
      .fields.find((f) => f.key === "total_qty")!.defaultLabel;
    expect(blockOf(typed("totals", "total_qty", builtIn))).toMatchObject(MEASURED);
  });

  it.each([["tear_off", "received_by"], ["header", "order_no"]])(
    "carries no id where only the label of %s.%s is typed", (section, key) => {
      expect(blockOf(typed(section, key))).not.toHaveProperty("id");
    });
});

describe("the ticket's tear-off strip (the Standard config)", () => {
  const gross = () => ticketOf(NET_1031, ROWS_1031);

  it("boxes the quantity and the net weight as one 200-point table: a bold 10.5-point label beside a right-aligned figure in a 62-point column", () => {
    const label = (text: string) => ({ text, bold: true, fontSize: 10.5 });
    const figure = (text: string) => ({ text, alignment: "right" });
    expect(stripTable(buildShippingTicketDefinition([gross()]))).toEqual({
      width: 200, layout: LAYOUT.boxed,
      table: { widths: ["*", 62], body: [
        [label("Quantity Shipped:"), figure("300.00")],
        [label("Net weight:"), figure("1,600.00 lb")],
      ] },
    });
  });
});

// ------------------------------------------------------------------------------------------------
// Which strips the renderer measures (#522: owner ruling 2026-10-15, amended twice 2026-10-16). The
// strip carries the id `ticket-tear-off`, which the renderer finds it by, only where the template
// holds a typed label for one of its fields, the Sold To name holds a line-break character, or the
// template's base font size is above the Standard's.
// ------------------------------------------------------------------------------------------------

/** The line-break characters the owner's amendment lists, each by name. */
const LINE_BREAKS: [name: string, char: string][] = [
  ["a line feed", "\n"], ["a carriage return", "\r"], ["the line separator U+2028", "\u2028"],
  ["the paragraph separator U+2029", "\u2029"], ["a form feed", "\u000C"], ["a vertical tab", "\u000B"],
  ["a next-line U+0085", "\u0085"],
];

describe.each(BOTH)("the tear-off strip carries the id the renderer measures it by only where a label is typed, the Sold To name breaks a line or the base font size is above the Standard's (%s)", (docType) => {
  /** The strip of order 1031's sheet under this type's default config after `edit`, sold to `name`. */
  const stripOf = (edit: (c: TemplateConfig) => void = () => {}, name = "Demo Components Corporation") => {
    const c = cfg(docType);
    edit(c);
    const ticket = ticketOf(NET_1031, ROWS_1031);
    return stripBlock(buildShippingTicketDefinition(
      [{ ...ticket, soldTo: { ...ticket.soldTo, name } }], docType, checked(c, docType)));
  };
  const typed = (section: string, key: string, label = "Typed label:") => (c: TemplateConfig) => {
    fieldOf(c, section, key).label = label;
  };
  const MEASURED = { id: "ticket-tear-off", unbreakable: true, margin: [0, 16, 0, 0] };
  /** Every field key of this type's Tear-off strip section, read from its contract, so a strip field
   *  the contract gains is a row below with no edit here. */
  const tearOffKeys = contractFor(docType).sections.find((s) => s.key === "tear_off")!.fields.map((f) => f.key);

  it("carries no id under the built-in labels and the Standard's base font size with a Sold To name that holds no line break: it keeps its mark and its 16-point top margin", () => {
    const strip = stripOf();
    expect(Object.keys(strip).sort()).toEqual(["margin", "stack", "unbreakable"]);
    expect(strip).toMatchObject({ unbreakable: true, margin: [0, 16, 0, 0] });
  });

  it("carries no id under the seed migration's literal", () => {
    const def = buildShippingTicketDefinition(
      [ticketOf(NET_1031, ROWS_1031)], docType, normalizeStoredConfig(docType, seedLiteral(docType)));
    expect(stripBlock(def)).not.toHaveProperty("id");
  });

  it.each(tearOffKeys)("carries the id where the label of %s is typed", (key) => {
    expect(stripOf(typed("tear_off", key))).toMatchObject(MEASURED);
  });

  it("carries the id where the typed label is on a hidden strip field and the others are shown", () => {
    expect(stripOf((c) => {
      typed("tear_off", "received_by")(c);
      fieldOf(c, "tear_off", "received_by").visible = false;
    })).toMatchObject(MEASURED);
  });

  it("carries the id where the stored label is empty", () => {
    expect(stripOf(typed("tear_off", "received_by", ""))).toMatchObject(MEASURED);
  });

  it("carries the id where the label is typed in the built-in wording", () => {
    const builtIn = contractFor(docType).sections.find((s) => s.key === "tear_off")!
      .fields.find((f) => f.key === "received_by")!.defaultLabel;
    expect(builtIn).toBe("Received By:");
    expect(stripOf(typed("tear_off", "received_by", builtIn))).toMatchObject(MEASURED);
  });

  it.each([["totals", "total_weight"], ["header", "order_no"]])(
    "carries no id where only the label of %s.%s is typed", (section, key) => {
      expect(stripOf(typed(section, key))).not.toHaveProperty("id");
    });

  it("is not drawn, and nothing carries the id, where the Tear-off strip section is hidden and a strip label is typed", () => {
    const c = cfg(docType);
    sectionOf(c, "tear_off").visible = false;
    typed("tear_off", "received_by")(c);
    const def = buildShippingTicketDefinition([ticketOf(NET_1031, ROWS_1031)], docType, checked(c, docType));
    expect(() => stripBlock(def)).toThrow("no tear-off strip on the sheet");
    expect(findNodes(def, (n) => n.id === "ticket-tear-off")).toEqual([]);
  });

  it.each(LINE_BREAKS)("carries the id under the built-in labels where the Sold To name holds %s", (_name, char) => {
    expect(stripOf(undefined, `Demo Components${char}Corporation`)).toMatchObject(MEASURED);
  });

  it("carries no id under the built-in labels where the Sold To name holds a tab", () => {
    expect(stripOf(undefined, "Demo Components\tCorporation")).not.toHaveProperty("id");
  });

  // The Standard's base font size is 8 points on both ticket types, and only a size above it gives
  // the strip its id.
  it.each([7, 8])("carries no id under the built-in labels at a base font size of %s, not above the Standard's 8", (size) => {
    expect(DEFAULTS[docType].fonts.baseSize).toBe(8);
    expect(stripOf((c) => { c.fonts.baseSize = size; })).not.toHaveProperty("id");
  });

  it.each([8.5, 56, 72])("carries the id under the built-in labels at a base font size of %s, above the Standard's", (size) => {
    expect(stripOf((c) => { c.fonts.baseSize = size; })).toMatchObject(MEASURED);
  });
});

// Both ticket types' Standard base font size is 8 points, so no built or rendered row can tell the
// builder's read of `DEFAULT_CONFIG` from a typed 8: this case reads the builder's source. PARSED,
// not pattern-matched (#188): it takes every binary expression inside `tearOff` that has a
// `.baseSize` property on either side, and accepts exactly one, written
// `ctx.fonts.baseSize > DEFAULT_CONFIGS[docType].fonts.baseSize` on one line.
describe("the tear-off strip's base-size condition, in the builder's source (#522)", () => {
  it("compares the template's base font size with its type's DEFAULT_CONFIG, never with a typed number", () => {
    const path = fileURLToPath(new URL("../src/server/pdf/shipping-ticket.ts", import.meta.url));
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const tearOff = source.statements.find(
      (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "tearOff");
    expect(tearOff).toBeDefined();
    const isBaseSize = (side: ts.Expression) => ts.isPropertyAccessExpression(side) && side.name.text === "baseSize";
    const comparisons: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && (isBaseSize(node.left) || isBaseSize(node.right))) comparisons.push(node.getText(source));
      ts.forEachChild(node, visit);
    };
    visit(tearOff!);
    expect(comparisons).toEqual(["ctx.fonts.baseSize > DEFAULT_CONFIGS[docType].fonts.baseSize"]);
  });
});

describe("the readers of a ticket's totals and strip (tests/helpers/ticket-totals.ts)", () => {
  const gross = () => ticketOf(NET_1031, ROWS_1031);

  it("stripRows answers no rows for a strip whose two boxed rows are hidden", () => {
    const c = cfg();
    for (const key of ["tear_total_qty", "tear_total_weight"]) fieldOf(c, "tear_off", key).visible = false;
    expect(stripRows(buildShippingTicketDefinition([gross()], "SHIPPER", checked(c)))).toEqual([]);
  });

  it("stripRows throws for a sheet with no strip, where the strip's section is hidden", () => {
    const c = cfg();
    sectionOf(c, "tear_off").visible = false;
    expect(() => stripRows(buildShippingTicketDefinition([gross()], "SHIPPER", checked(c)))).toThrow("no tear-off strip on the sheet");
  });

  it("stripBlock answers the strip's own node: the unbreakable stack that opens with its rule and holds its boxed table", () => {
    const def = buildShippingTicketDefinition([gross()]);
    const strip = stripBlock(def);
    const table = stripTable(def);
    expect(strip.unbreakable).toBe(true);
    expect((strip.stack as Record<string, unknown>[])[0]).toHaveProperty("canvas");
    expect(table).toBeDefined();
    expect(findNodes(strip, (n) => n === table)).toHaveLength(1);
  });

  it("each reader refuses a definition that holds two sheets", () => {
    const two = buildShippingTicketDefinition([gross(), gross()]);
    expect(() => totalsBlock(two)).toThrow("2 totals blocks on one sheet");
    expect(() => totalsRows(two)).toThrow("2 totals tables on one sheet");
    expect(() => stripRows(two)).toThrow("2 tear-off strips on one sheet");
    expect(() => stripBlock(two)).toThrow("2 tear-off strips on one sheet");
  });
});

describe("the ticket's totals on a rendered page (measured: weights design §13.5)", () => {
  /** The tests' sample text with nine three-line part rows and two container rows. */
  const nineLines = (tareEach: number | null): TicketData => sampleTicket({
    lines: Array.from({ length: 9 }, (_, i) => ({
      qty: 192, partNumber: `NINE-${i + 1}`, partName: "Track Shoe, Vehicular", partDescription: "D-001", pounds: 4128 })),
    containers: [bin(3, tareEach), bin(3, tareEach)], totalQty: 1728,
  });

  it("each weight of the totals and of the strip prints on one line with its unit", async () => {
    const { runs, pages } = await printed(ticketOf(NET_1031, ROWS_1031), DEFAULTS.SHIPPER);
    // A run is one word. For each place a figure is drawn: is "lb" the next word, on its line?
    const unitBeside = (figure: string) => runs.flatMap((run, i) => (run.text.trim() !== figure ? []
      : [runs[i + 1]?.text.trim() === "lb" && Math.abs(runs[i + 1].y - run.y) < 0.5]));
    // The net is drawn twice: in the totals' 80-point column, then in the strip's 62-point one.
    const beside = { net: unitBeside("1,600.00"), tare: unitBeside("127.50"), gross: unitBeside("1,727.50") };
    measured("lb on the line of each total, for each place the figure is drawn", { ...beside, pages });
    expect(beside).toEqual({ net: [true, true], tare: [true], gross: [true] });
  });

  it("a ticket of nine part lines keeps one page with no gross, and with a gross its strip moves to a second", async () => {
    const measure = async (tareEach: number | null) => {
      const ticket = nineLines(tareEach);
      const { pdf, pages } = await printed(ticket, DEFAULTS.SHIPPER);
      const runsByPage = textRunsWithY(pdf);
      const pageOf = (word: string) => runsByPage.findIndex((runs) => runs.some((r) => r.text.trim() === word)) + 1;
      // "92036" alone is the strip's order number. "Gross" is drawn by the totals only. 0: not drawn.
      const figures = { pages, strip: pageOf("92036"), gross: pageOf("Gross") };
      measured(`${ticket.lines.length} part lines, the serial line, two container rows, tare each ${tareEach}`, figures);
      return figures;
    };
    const [noGross, withGross] = [await measure(null), await measure(42.5)];
    expect(noGross).toEqual({ pages: 1, strip: 1, gross: 0 });
    expect(withGross).toEqual({ pages: 2, strip: 2, gross: 1 });
  });

  /** The nine-line ticket with a gross, cut or grown to `count` part rows. */
  const partRows = (count: number): TicketData => {
    const nine = nineLines(42.5);
    return {
      ...nine, totalQty: 192 * count,
      lines: Array.from({ length: count }, (_, i) => ({ ...nine.lines[0], partNumber: `ROW-${i + 1}` })),
    };
  };
  /** Every place a word is drawn, top of the first page first. A run is one word. */
  const drawn = (pdf: Buffer, word: string) => textRunsWithY(pdf)
    .flatMap((runs, i) => runs.filter((r) => r.text.trim() === word).map((r) => ({ page: i + 1, x: r.x, y: r.y })))
    .sort((a, b) => a.page - b.page || b.y - a.y);
  /** Where each line of the totals block is drawn, and the strip's order number. The totals are
   *  above the strip, so the first "Complete" is the banner's, the first "Shipped:" ends the
   *  totals' "Quantity Shipped:" and the first "weight:" ends their "Net weight:". "Tare:" and
   *  "Gross" are drawn by the totals only, and "92036" alone by the strip. */
  const totalsPlaces = (pdf: Buffer) => ({
    banner: drawn(pdf, "Complete")[0], quantity: drawn(pdf, "Shipped:")[0], net: drawn(pdf, "weight:")[0],
    tare: drawn(pdf, "Tare:")[0], gross: drawn(pdf, "Gross")[0], strip: drawn(pdf, "92036")[0],
  });

  it.each([11, 12, 13])("a ticket of %i part lines, whose totals do not all fit under them, starts the whole block on the next page", async (count) => {
    const { pdf, pages } = await printed(partRows(count), DEFAULTS.SHIPPER);
    const onPage = Object.fromEntries(Object.entries(totalsPlaces(pdf)).map(([line, place]) => [line, place.page]));
    measured(`${count} part lines, the serial line, two container rows at 42.5: the page of each line of the totals`, { pages, ...onPage });
    expect({ pages, ...onPage }).toEqual({ pages: 2, banner: 2, quantity: 2, net: 2, tare: 2, gross: 2, strip: 2 });
  });

  it("a ticket of two part lines, whose totals fit under them, prints one page with each line of the totals and the strip at its place", async () => {
    const { pdf, pages } = await printed(partRows(2), DEFAULTS.SHIPPER);
    const at = Object.fromEntries(Object.entries(totalsPlaces(pdf)).map(([line, place]) => [line, [place.page, tenth(place.x), tenth(place.y)]]));
    measured("2 part lines, the serial line, two container rows at 42.5: page, x and y of each line of the totals", { pages, ...at });
    // Each figure is the page, the x and the y a line is drawn at, to a tenth of a point.
    expect({ pages, ...at }).toEqual({
      pages: 1, banner: [1, 303.5, 412.1], quantity: [1, 453.2, 390.1], net: [1, 461, 372], tare: [1, 473.3, 353.9],
      gross: [1, 426.6, 335.9], strip: [1, 76.8, 298.7],
    });
  });

  /** The two-line ticket printed under the Standard config with a Net weight label typed `words`
   *  words long, and one more word that only the label's end holds. */
  const longNetLabel = (words: number) => {
    const c = cfg();
    fieldOf(c, "totals", "total_weight").label = `${"LONGLABEL ".repeat(words)}ENDMARK:`;
    return printed(partRows(2), checked(c));
  };
  /** How many times each page draws each word of that ticket's totals, and the strip's order
   *  number. A run is one word. The strip draws "Shipped Complete", "Quantity Shipped:" and the net
   *  figure too, once each, so a page's count of those three is the totals' and the strip's. */
  const totalsWordsByPage = (pdf: Buffer) => {
    const byPage = textRunsWithY(pdf);
    const count = (word: string) => byPage.map((runs) => runs.filter((r) => r.text.trim() === word).length);
    return {
      label: count("LONGLABEL"), labelEnd: count("ENDMARK:"), complete: count("Complete"), quantity: count("Shipped:"),
      net: count("8,256.00"), tare: count("Tare:"), gross: count("Gross"), order: count("92036"),
    };
  };

  // A label has no length bound, and pdfmake draws an unbreakable block whole on one page or leaves
  // it out. The renderer takes the mark off a block taller than a page (render.ts
  // `prepareTravelerLayout`), so these totals flow: page 1 ends with the banner, the Quantity
  // Shipped row, the net figure and the label's first 48 words, and page 2 holds the rest of the
  // block and the strip. At 92 words the totals no longer fit the page an overflowing ticket
  // prints on, under the continuation band's 40-point top margin, though a page under the sheet's
  // own 24 points would hold them: the row a renderer that measured against the smaller margin
  // fails.
  it.each<[words: number, onPageTwo: number]>([[100, 52], [96, 48], [92, 44]])(
    "a Net weight label of %i words makes the totals taller than a page: they flow over the page break and every line of them prints",
    async (words, onPageTwo) => {
      const { pdf, pages } = await longNetLabel(words);
      const seen = totalsWordsByPage(pdf);
      measured(`a Net weight label of ${words} words on the two-line ticket: how often each page draws each word`, { pages, ...seen });
      expect({ pages, ...seen }).toEqual({
        pages: 2, label: [48, onPageTwo], labelEnd: [0, 1], complete: [1, 1], quantity: [1, 1], net: [1, 1],
        tare: [0, 1], gross: [0, 1], order: [0, 1],
      });
    });

  // These totals fit a page and not what the part lines leave of the first, so the block keeps its
  // mark and moves whole. 91 words is the longest label it keeps the mark under: at 92, the last
  // row of the case above, it flows.
  it.each([80, 91])(
    "a Net weight label of %i words leaves the totals shorter than a page: the whole block starts the next page, and the strip the one after",
    async (words) => {
      const { pdf, pages } = await longNetLabel(words);
      const seen = totalsWordsByPage(pdf);
      measured(`a Net weight label of ${words} words on the two-line ticket: how often each page draws each word`, { pages, ...seen });
      expect({ pages, ...seen }).toEqual({
        pages: 3, label: [0, words, 0], labelEnd: [0, 1, 0], complete: [0, 1, 1], quantity: [0, 1, 1], net: [0, 1, 1],
        tare: [0, 1, 0], gross: [0, 1, 0], order: [0, 0, 1],
      });
    });

  it("the two reflow tickets through the print path, with the totals shown and a gross: part rows and totals stay above the strip, and the banner prints over the Quantity Shipped row on its page", async () => {
    const c = cfg();
    for (const key of ["containers", "serials", "liability"]) sectionOf(c, key).visible = false;
    for (const count of [16, 24]) {
      const { pdf } = await printed({ ...manyRowTicket(count), containers: [bin(3, 42.5)] }, checked(c));
      const pages = textRunsWithY(pdf);
      const tearPage = pages.findIndex((runs) => tearTopY(runs) !== null);
      const top = tearTopY(pages[tearPage])!;
      // One answer for each word drawn: is it on an earlier page than the strip, or above its top?
      const above = (is: (word: string) => boolean) => pages.flatMap((runs, page) =>
        runs.filter((r) => is(r.text.trim())).map((r) => page < tearPage || (page === tearPage && r.y > top)));
      const { banner, quantity } = totalsPlaces(pdf);
      const held = {
        rows: above((w) => w.startsWith("RFL-")), totals: above((w) => w === "Tare:" || w === "Gross"),
        // Is the banner on the page of the Quantity Shipped row, and above that row?
        banner: banner.page === quantity.page && banner.y > quantity.y,
      };
      measured(`${count} part rows with the totals shown`, {
        pages: pages.length, stripOnPage: tearPage + 1, rowsAbove: held.rows.filter(Boolean).length, totalsAbove: held.totals,
        bannerOnPage: banner.page, quantityOnPage: quantity.page });
      expect(held, `${count} rows`).toEqual({ rows: Array<boolean>(count).fill(true), totals: [true, true], banner: true });
    }
  });
});

describe("the ticket's canvas floors (design 2026-11-08 §4.1)", () => {
  /** Page 1's full-width horizontal rules, top to bottom: each y whose stroked segments join into
   *  one run more than 500 pt long. A ruled or boxed table draws each rule as one segment a cell, so
   *  the segments are joined; the two party boxes draw rules at the same y with a gap between them,
   *  so they never join into one run and are left out. */
  const fullWidthRules = (pdf: Buffer): number[] => {
    const byY = new Map<number, { x1: number; x2: number }[]>();
    for (const l of strokedLines(pdf)[0]) {
      if (l.y1 !== l.y2) continue;
      byY.set(l.y1, [...(byY.get(l.y1) ?? []), { x1: Math.min(l.x1, l.x2), x2: Math.max(l.x1, l.x2) }]);
    }
    const ys: number[] = [];
    for (const [y, segments] of byY) {
      segments.sort((a, b) => a.x1 - b.x1);
      let run = { ...segments[0] };
      let longest = 0;
      for (const s of segments.slice(1)) {
        if (s.x1 <= run.x2 + 0.5) run.x2 = Math.max(run.x2, s.x2);
        else { longest = Math.max(longest, run.x2 - run.x1); run = { ...s }; }
      }
      if (Math.max(longest, run.x2 - run.x1) > 500) ys.push(y);
    }
    return ys.sort((a, b) => a - b);
  };

  it("TICKET_ROW_FLOOR is one ruled body row and TICKET_FIRST_TABLE_ROOM the Order fields strip, measured on the Standard", async () => {
    // One part line whose part cell prints one line (no name, no description): the floor is a
    // one-line row (the design's §4.1); the sample's three-line part cell would measure 33 pt.
    const ticket = sampleTicket({ lines: [{ ...sampleTicket().lines[0], partName: "", partDescription: "" }] });
    const pdf = await renderSheetGroups(buildShippingTicketDefinitions([ticket], "SHIPPER"));
    const rules = fullWidthRules(pdf);
    // The strip (boxed) draws three: its top, under its heading row, its bottom. The lines table
    // (ruled) draws one above its heading, one under it and one under its row.
    const strip = rules.slice(0, 3);
    const lines = rules.slice(3, 6);
    measured("the ticket's canvas floors", { strip, lines });
    expect(TICKET_FIRST_TABLE_ROOM).toBe(Math.ceil(strip[2] - strip[0]));
    expect(TICKET_ROW_FLOOR).toBe(Math.ceil(lines[2] - lines[1]));
    expect(TICKET_ROW_FLOOR).toBeGreaterThan(8);
    expect(TICKET_ROW_FLOOR).toBeLessThan(24);
  });
});

describe("the ticket's tear-off strip on a rendered page (#522)", () => {
  /** Order 1031's ticket printed under the Standard config with the label of one strip field typed
   *  `words` words long, and one more word that only the label's end holds. */
  const longStripLabel = (key: string, words: number) => {
    const c = cfg();
    fieldOf(c, "tear_off", key).label = `${"LONGLABEL ".repeat(words)}ENDMARK:`;
    return printed(ticketOf(NET_1031, ROWS_1031), checked(c));
  };
  /** How many times each page draws the label's words, the strip's order number and the end of its
   *  "Shipped ON:". A run is one word. "92036" alone and "ON:" are drawn by the strip only: the
   *  header prints "92036-3" as one run. */
  const stripWordsByPage = (pdf: Buffer) => {
    const byPage = textRunsWithY(pdf);
    const count = (word: string) => byPage.map((runs) => runs.filter((r) => r.text.trim() === word).length);
    return { label: count("LONGLABEL"), labelEnd: count("ENDMARK:"), order: count("92036"), shippedOn: count("ON:") };
  };
  const sum = (counts: number[]) => counts.reduce((a, b) => a + b, 0);

  // A label has no length bound, and pdfmake draws an unbreakable block whole on one page or leaves
  // it out. Received By prints in the strip's 220-point column, and the Net weight label in a cell
  // of its boxed table. The figures on each page are the renderer's, measured.
  it.each<[key: string, onPages: Record<"pages" | "label" | "labelEnd" | "order" | "shippedOn", unknown>]>([
    ["received_by", { pages: 3, label: [84, 260, 56], labelEnd: [0, 0, 1], order: [1, 0, 0], shippedOn: [0, 0, 1] }],
    ["tear_total_weight", {
      pages: 5, label: [42, 116, 116, 116, 10], labelEnd: [0, 0, 0, 0, 1], order: [1, 0, 0, 0, 0], shippedOn: [0, 0, 0, 0, 1],
    }],
  ])(
    "a %s label of 400 words makes the strip taller than a page: it flows from under the totals over the page breaks and every word of it prints",
    async (key, onPages) => {
      const { pdf, pages } = await longStripLabel(key, 400);
      const seen = stripWordsByPage(pdf);
      measured(`a ${key} label of 400 words on order 1031's ticket: how often each page draws each word`, { pages, ...seen });
      expect({ label: sum(seen.label), labelEnd: sum(seen.labelEnd), order: sum(seen.order), shippedOn: sum(seen.shippedOn) })
        .toEqual({ label: 400, labelEnd: 1, order: 1, shippedOn: 1 });
      // The strip starts on page 1, under the totals: it flows, and does not move whole.
      expect(seen.label[0]).toBeGreaterThan(0);
      expect({ pages, ...seen }).toEqual(onPages);
    });

  // pdfmake tests an unbreakable block's content against a page and leaves its top margin out, so
  // the renderer measures the strip without its 16-point margin. The page an overflowing ticket
  // prints on holds 728 points, under the continuation band's 40-point top margin. At 229 words the
  // strip's content is 719.85 points tall, 735.85 with the margin: it keeps its mark and starts
  // page 2 whole. At 230 it is 730.98 points tall, and it flows from under the totals. The figures
  // on each page are the renderer's, measured.
  it.each<[words: number, strip: string, onPages: Record<"pages" | "label" | "labelEnd" | "order" | "shippedOn", unknown>]>([
    [229, "leaves the strip shorter than a page without its top margin: the whole strip starts page 2",
      { pages: 2, label: [0, 229], labelEnd: [0, 1], order: [0, 1], shippedOn: [0, 1] }],
    [230, "makes the strip taller than a page: it flows from under the totals",
      { pages: 2, label: [84, 146], labelEnd: [0, 1], order: [1, 0], shippedOn: [0, 1] }],
  ])("a received_by label of %i words %s, and every word of it prints", async (words, _strip, onPages) => {
    const { pdf, pages } = await longStripLabel("received_by", words);
    const seen = stripWordsByPage(pdf);
    measured(`a received_by label of ${words} words on order 1031's ticket: how often each page draws each word`, { pages, ...seen });
    expect({ pages, ...seen }).toEqual(onPages);
  });

  // A strip that fits a page prints as it did before it carried an id. With the id taken off, the
  // renderer does not find the strip, so each row renders the same definitions without the id and
  // compares what each page draws: two renders of one definition need not be the same bytes.
  it.each([40, 229])(
    "a received_by label of %i words leaves the strip shorter than a page: every word and every rule is drawn where it is drawn with the strip's id taken off",
    async (words) => {
      const c = cfg();
      fieldOf(c, "tear_off", "received_by").label = `${"LONGLABEL ".repeat(words)}ENDMARK:`;
      const { pdf } = await printed(ticketOf(NET_1031, ROWS_1031), checked(c));
      const bare = buildShippingTicketDefinitions([ticketOf(NET_1031, ROWS_1031)], "SHIPPER", checked(c));
      const ids = findNodes(bare, (n) => n.id === "ticket-tear-off");
      expect(ids).toHaveLength(1);
      for (const node of ids) delete node.id;
      const without = await renderSheetGroups(bare);
      expect(textRunsWithY(pdf)).toEqual(textRunsWithY(without));
      expect(strokedLines(pdf)).toEqual(strokedLines(without));
    });

  it("a received_by label of 40 words leaves the strip shorter than a page: every word of it prints on page 1, and the order number once", async () => {
    const { pdf, pages } = await longStripLabel("received_by", 40);
    const seen = stripWordsByPage(pdf);
    measured("a received_by label of 40 words on order 1031's ticket: how often each page draws each word", { pages, ...seen });
    expect({ pages, ...seen }).toEqual({ pages: 1, label: [40], labelEnd: [1], order: [1], shippedOn: [1] });
  });

  /** Order 1031's ticket printed under the Standard config, sold to a name of `breaks` + 1 lines
   *  joined by `char`: SOLDLINE on each line but the last, which is SOLDEND. */
  const brokenName = (char: string, breaks: number) => {
    const ticket = ticketOf(NET_1031, ROWS_1031);
    const name = [...Array<string>(breaks).fill("SOLDLINE"), "SOLDEND"].join(char);
    return printed({ ...ticket, soldTo: { ...ticket.soldTo, name } }, cfg());
  };
  /** How many times each page draws the strip's order number, the end of its "Shipped ON:" and the
   *  name's last line, which the Sold To box at the top of the sheet draws too. */
  const nameWordsByPage = (pdf: Buffer) => {
    const byPage = textRunsWithY(pdf);
    const count = (word: string) => byPage.map((runs) => runs.filter((r) => r.text.trim() === word).length);
    return { order: count("92036"), shippedOn: count("ON:"), nameEnd: count("SOLDEND") };
  };

  // Under the built-in labels a Sold To name of 58 line breaks makes the strip taller than a page
  // (owner's amendment of 2026-10-16). Without the id pdfmake draws none of the strip. The strip
  // carries the id for each line-break character the amendment lists, so it starts on page 2 and
  // flows to page 3, and its order number, its "Shipped ON:" and the name's last line print. The
  // figures on each page are the renderer's, measured.
  it.each(LINE_BREAKS)(
    "a Sold To name of 58 line breaks, each %s, makes the strip under the built-in labels taller than a page: it flows over the page break and prints",
    async (name, char) => {
      const { pdf, pages } = await brokenName(char, 58);
      const seen = nameWordsByPage(pdf);
      measured(`a Sold To name of 58 line breaks, each ${name}, on order 1031's ticket: how often each page draws each word`, { pages, ...seen });
      expect({ pages, ...seen }).toEqual({ pages: 3, order: [0, 1, 0], shippedOn: [0, 1, 0], nameEnd: [1, 0, 1] });
    });

  // At 57 line feeds the strip is shorter than a page without its top margin. It keeps its mark, and
  // the whole strip starts page 3, after the totals on page 2.
  it("a Sold To name of 57 line feeds leaves the strip under the built-in labels shorter than a page: the whole strip starts page 3", async () => {
    const { pdf, pages } = await brokenName("\n", 57);
    const seen = nameWordsByPage(pdf);
    measured("a Sold To name of 57 line feeds on order 1031's ticket: how often each page draws each word", { pages, ...seen });
    expect({ pages, ...seen }).toEqual({ pages: 3, order: [0, 0, 1], shippedOn: [0, 0, 1], nameEnd: [1, 0, 1] });
  });

  // A base font size above the Standard's 8 points also gives the strip its id (owner, 2026-10-16).
  // The quantity and net weight figures in the strip's boxed table set no font size of their own, so
  // they take the base size, and at 56 points the strip under the built-in labels is taller than a
  // page. Without the id pdfmake draws none of the strip on any of the ticket's seven pages. With it
  // the strip flows over the page break, so its order number and its "Shipped ON:" each print once,
  // the order number on the earlier page: it starts on page 6 and flows to page 7. The figures on
  // each page are the renderer's, measured.
  it("a base font size of 56 makes the strip under the built-in labels taller than a page: it flows over the page break and prints", async () => {
    const c = cfg();
    c.fonts.baseSize = 56;
    const { pdf, pages } = await printed(ticketOf(NET_1031, ROWS_1031), checked(c));
    const { order, shippedOn } = stripWordsByPage(pdf);
    measured("a base font size of 56 on order 1031's ticket: how often each page draws each word", { pages, order, shippedOn });
    expect({ order: sum(order), shippedOn: sum(shippedOn) }).toEqual({ order: 1, shippedOn: 1 });
    expect(order.indexOf(1)).toBeLessThan(shippedOn.indexOf(1));
    expect({ pages, order, shippedOn }).toEqual({ pages: 7, order: [0, 0, 0, 0, 0, 1, 0], shippedOn: [0, 0, 0, 0, 0, 0, 1] });
  });

  // The legacy whole-document definition holds every ticket, so where a strip label is typed each of
  // its strips carries the id.
  // pdfmake 0.3.11 registers an id, and refuses a repeated one, only on a text node
  // (DocPreprocessor's preprocessText). The strip's id is on its stack, so the repeat is not
  // refused. One pass at 24-point top margins, each ticket from a new page; the figures are the
  // renderer's, measured.
  it("the legacy whole-document definition of two tickets, each with a received_by label of 400 words, renders and prints every word of both strips", async () => {
    const c = cfg();
    fieldOf(c, "tear_off", "received_by").label = `${"LONGLABEL ".repeat(400)}ENDMARK:`;
    const ticket = ticketOf(NET_1031, ROWS_1031);
    const pdf = await renderPdf(buildShippingTicketDefinition([ticket, ticket], "SHIPPER", checked(c)));
    const seen = { pages: pageCount(pdf), ...stripWordsByPage(pdf) };
    measured("two tickets in one definition, each with a received_by label of 400 words: how often each page draws each word", seen);
    expect({ label: sum(seen.label), labelEnd: sum(seen.labelEnd), order: sum(seen.order), shippedOn: sum(seen.shippedOn) })
      .toEqual({ label: 800, labelEnd: 2, order: 2, shippedOn: 2 });
    expect(seen).toEqual({
      pages: 6, label: [92, 264, 44, 92, 264, 44], labelEnd: [0, 0, 1, 0, 0, 1], order: [1, 0, 0, 1, 0, 0], shippedOn: [0, 0, 1, 0, 0, 1],
    });
  });
});

// ------------------------------------------------------------------------------------------------
// The print path (spec §5.2): docType by the SHIPMENT'S order count — a multi-order shipment's
// per-order ticket ALSO resolves MOS_SHIPPER (all paper from one shipment styles alike) — the
// resolved version's config renders, its id stamps the stored row, and the liability text comes
// from the CONFIG's text block, not the Setting (spec §8; settings.ts untouched until Task 14).
// ------------------------------------------------------------------------------------------------

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

let customerSeq = 0;
async function makeCustomer(): Promise<Customer> {
  customerSeq += 1;
  return prisma.customer.create({
    data: { code: `TT${customerSeq}`, name: `Ticket Template Customer ${customerSeq}` },
  });
}

let partSeq = 0;
async function makePart(customerId: string) {
  partSeq += 1;
  const part = await prisma.part.create({
    data: {
      customerId, partNumber: `TTP-${partSeq}`, name: `Template Part ${partSeq}`,
      description: "D-001", eachWeight: "21.5000",
    },
  });
  const code = await prisma.processStepCode.create({ data: { code: `TT-${part.id}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
  return part;
}

async function makeAddresses(customerId: string) {
  await prisma.customerAddress.create({
    data: {
      customerId, kind: "BILL_TO", name: "Accounts payable", street: "300 Example Way",
      city: "Anniston", state: "AL", zip: "36201", isDefault: true,
    },
  });
  return prisma.customerAddress.create({
    data: {
      customerId, kind: "SHIP_TO", name: "Demo Components Corporation", street: "300 Example Way",
      city: "Anniston", state: "AL", zip: "36201", isDefault: true,
    },
  });
}

async function orderFor(customer: Customer, poNumber = "DEMO-PO-24115"): Promise<OrderDetail> {
  const part = await makePart(customer.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, poNumber, customerJobNo: "JOB-9",
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
    containers: [] as { orderContainerId: string; count: number }[],
    serials: [] as { orderSerialId: string; printOnShipper?: boolean }[],
  };
}

async function oneOrderShipment(customer?: Customer): Promise<{ shipper: ShipperDetail; order: OrderDetail; customer: Customer }> {
  const c = customer ?? await makeCustomer();
  const shipTo = await makeAddresses(c.id);
  const order = await orderFor(c);
  const { shipper } = await asSystem(() => createShipper({
    customerId: c.id, shipDate: "2026-07-29", shipToAddressId: shipTo.id, route: "South",
    orders: [shipOrderInput(order)],
  }, { canOverrideCreditHold: false }));
  return { shipper, order, customer: c };
}

async function twoOrderShipment(customer?: Customer): Promise<{
  shipper: ShipperDetail; orderA: OrderDetail; orderB: OrderDetail; customer: Customer;
}> {
  const c = customer ?? await makeCustomer();
  const shipTo = await makeAddresses(c.id);
  const orderA = await orderFor(c, "PO-A");
  const orderB = await orderFor(c, "PO-B");
  const { shipper } = await asSystem(() => createShipper({
    customerId: c.id, shipDate: "2026-07-29", shipToAddressId: shipTo.id,
    orders: [shipOrderInput(orderA), shipOrderInput(orderB)],
  }, { canOverrideCreditHold: false }));
  return { shipper, orderA, orderB, customer: c };
}

/** Create → tweak the v1 draft → (optionally logo) → publish, for either ticket docType. */
async function publishCustom(
  docType: TicketDocType, tweak: (c: TemplateConfig) => void, logo?: { data: Buffer; mime: string },
) {
  const t = await asSystem(() => createTemplate(docType, `Custom ${docType}`));
  const c = cfg(docType);
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

describe("printShippingTickets — resolution by the SHIPMENT'S order count + the stamp", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("no assignment: a single-order shipment resolves the seeded Standard SHIPPER and stamps ITS version id", async () => {
    const { shipper } = await oneOrderShipment();
    const { documentId, pdf } = await asSystem(() => printShippingTickets(shipper.id));
    expect(drawnText(pdf)).toContain("Shipping Ticket");
    expect(await stampOf(documentId)).toBe(templateVersionId("SHIPPER"));
  });

  it("no assignment: a multi-order shipment stamps the seeded MOS_SHIPPER id — whole set AND per-order", async () => {
    const { shipper, orderA } = await twoOrderShipment();
    const whole = await asSystem(() => printShippingTickets(shipper.id));
    expect(pageCount(whole.pdf)).toBe(2);
    expect(await stampOf(whole.documentId)).toBe(templateVersionId("MOS_SHIPPER"));

    // The per-order ticket of a MULTI-order shipment resolves MOS_SHIPPER too (spec §5.2: the
    // SHIPMENT'S order count decides, not the tickets being printed).
    const single = await asSystem(() => printShippingTickets(shipper.id, orderA.id));
    expect(pageCount(single.pdf)).toBe(1);
    expect(await stampOf(single.documentId)).toBe(templateVersionId("MOS_SHIPPER"));
  });

  it("customer-assigned templates: the three resolution cases through the real path, styled apart", async () => {
    const customer = await makeCustomer();
    const shipperTpl = await publishCustom("SHIPPER", (c) => {
      fieldOf(c, "header", "title").label = "SINGLE-STYLE-MARKER";
    });
    const mosTpl = await publishCustom("MOS_SHIPPER", (c) => {
      fieldOf(c, "header", "title").label = "MULTI-STYLE-MARKER";
    });
    await asSystem(() => assignTemplate(customer.id, "SHIPPER", shipperTpl.templateId));
    await asSystem(() => assignTemplate(customer.id, "MOS_SHIPPER", mosTpl.templateId));

    // 1. single-order shipment → SHIPPER.
    const single = await oneOrderShipment(customer);
    const p1 = await asSystem(() => printShippingTickets(single.shipper.id));
    expect(drawnText(p1.pdf)).toContain("SINGLE-STYLE-MARKER");
    expect(drawnText(p1.pdf)).not.toContain("MULTI-STYLE-MARKER");
    expect(await stampOf(p1.documentId)).toBe(shipperTpl.versionId);

    // 2. multi-order whole set → MOS_SHIPPER, on every sheet.
    const multi = await twoOrderShipment(customer);
    const p2 = await asSystem(() => printShippingTickets(multi.shipper.id));
    const pages = drawnPages(p2.pdf);
    expect(pages).toHaveLength(2);
    for (const page of pages) expect(page).toContain("MULTI-STYLE-MARKER");
    expect(drawnText(p2.pdf)).not.toContain("SINGLE-STYLE-MARKER");
    expect(await stampOf(p2.documentId)).toBe(mosTpl.versionId);

    // 3. the multi-order shipment's PER-ORDER ticket → still MOS_SHIPPER (explicit, spec §5.2).
    const p3 = await asSystem(() => printShippingTickets(multi.shipper.id, multi.orderA.id));
    expect(drawnText(p3.pdf)).toContain("MULTI-STYLE-MARKER");
    expect(await stampOf(p3.documentId)).toBe(mosTpl.versionId);
  });
});

describe("printShippingTickets — the liability text comes from the CONFIG, not the Setting", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("the factory Standard prints without inherited liability wording", async () => {
    const versionId = templateVersionId("SHIPPER");
    const version = await prisma.documentTemplateVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect((version.config as unknown as TemplateConfig).textBlocks.shipper_liability_text).toBe("");
    const { shipper } = await oneOrderShipment();
    const { pdf, documentId } = await asSystem(() => printShippingTickets(shipper.id));
    expect(await stampOf(documentId)).toBe(versionId);
    expect(drawnText(pdf)).toContain("Shipping Ticket");
    expect(drawnText(pdf)).not.toContain("INSTITUTE");
  });

  it("an assigned template's edited text block prints (not the contract default)", async () => {
    const customer = await makeCustomer();
    const tpl = await publishCustom("SHIPPER", (c) => {
      c.textBlocks.shipper_liability_text = "CONFIG-LIABILITY-MARKER";
    });
    await asSystem(() => assignTemplate(customer.id, "SHIPPER", tpl.templateId));
    const { shipper } = await oneOrderShipment(customer);
    const { pdf } = await asSystem(() => printShippingTickets(shipper.id));
    const text = drawnText(pdf);
    expect(text).toContain("CONFIG-LIABILITY-MARKER");
    expect(text).not.toContain("INSTITUTE");
  });
});

describe("printShippingTickets — per-ticket sheet groups through the real path", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("the pageFooter knob restarts numbering per ticket group; the default prints none", async () => {
    const customer = await makeCustomer();
    const tpl = await publishCustom("MOS_SHIPPER", (c) => { c.pageFooter = true; });
    await asSystem(() => assignTemplate(customer.id, "MOS_SHIPPER", tpl.templateId));

    const { shipper } = await twoOrderShipment(customer);
    const { pdf } = await asSystem(() => printShippingTickets(shipper.id));
    expect(pageCount(pdf)).toBe(2);
    const pages = drawnPages(pdf);
    // Each one-page ticket numbers ITSELF: "Page 1 of 1" twice, never "of 2".
    expect(pages[0]).toContain("Page 1 of 1");
    expect(pages[1]).toContain("Page 1 of 1");
    expect(drawnText(pdf)).not.toContain("of 2");

    // Default OFF — golden: the unassigned print carries no page numbers at all.
    const bare = await twoOrderShipment();
    const bareprint = await asSystem(() => printShippingTickets(bare.shipper.id));
    expect(drawnText(bareprint.pdf)).not.toMatch(/Page \d+ of \d+/);
  });

  it("a ticket overflowing LETTER repeats its order identity on the continuation page", async () => {
    const { shipper, order } = await oneOrderShipment();
    // 80 printable serials overflow one sheet; the shipment's serial picks are re-saved below.
    await prisma.orderSerial.createMany({
      data: Array.from({ length: 80 }, (_, i) => ({
        orderId: order.id, lineId: order.lines[0].id, position: i + 1,
        serial: `SER-${String(i + 1).padStart(3, "0")}`, description: "",
      })),
    });
    const serialIds = await prisma.orderSerial.findMany({
      where: { orderId: order.id }, select: { id: true, serial: true, lineId: true },
    });
    await prisma.shipperSerial.createMany({
      data: serialIds.map((s) => ({
        shipperOrderId: shipper.orders[0].id, orderSerialId: s.id,
        printOnShipper: true, serial: s.serial, description: "",
        orderLineIdAtSave: s.lineId ?? "",
      })),
    });

    const { pdf } = await asSystem(() => printShippingTickets(shipper.id));
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(2);
    const pages = drawnPages(pdf);
    expect(pages[0]).not.toContain("(continued)");
    expect(pages[1]).toContain("(continued)");
    expect(pages[1]).toContain(`Order No.: ${order.orderNumber}-1`);
  });

  it("a placed logo prints through the real path; the bare ticket paints no image", async () => {
    const bare = await oneOrderShipment();
    const bareprint = await asSystem(() => printShippingTickets(bare.shipper.id));
    expect(paintedImageCounts(bareprint.pdf)).toEqual([0]);

    const customer = await makeCustomer();
    const tpl = await publishCustom("SHIPPER",
      (c) => { c.logo = { placement: "header-right", width: 90 }; },
      { data: await barcodePng("TICKETLOGO"), mime: "image/png" });
    await asSystem(() => assignTemplate(customer.id, "SHIPPER", tpl.templateId));
    const { shipper } = await oneOrderShipment(customer);
    const { pdf } = await asSystem(() => printShippingTickets(shipper.id));
    expect(paintedImageCounts(pdf)).toEqual([1]);
  });

  // #670: each order's ticket is its own pdfkit document, so before the merge-time dedupe a
  // 20-order set with a 512 KB logo stored 10.8 MB against 0.43 MB without (measured 2026-11-07).
  it("a multi-order set stores a placed logo once, not once per order (#670)", async () => {
    const customer = await makeCustomer();
    const tpl = await publishCustom("MOS_SHIPPER",
      (c) => { c.logo = { placement: "header-right", width: 90 }; },
      { data: tinyAlphaPng(), mime: "image/png" });
    await asSystem(() => assignTemplate(customer.id, "MOS_SHIPPER", tpl.templateId));
    const { shipper } = await twoOrderShipment(customer);
    const { pdf } = await asSystem(() => printShippingTickets(shipper.id));
    expect(paintedImageCounts(pdf)).toEqual([1, 1]); // both tickets still paint it
    expect(imageObjectCount(pdf)).toBe(1);
    expect(danglingSMaskRefs(pdf)).toBe(0);
  });
});

describe("the ticket's built-in labels on stored configs (owner ruling W14)", () => {
  const page = (docType: TicketDocType, stored: unknown) =>
    buildShippingTicketDefinition([sampleTicket()], docType, normalizeStoredConfig(docType, stored));
  /** The four cells whose built-in label changed: the heading over the line weights, the heading
   *  over the container counts of the table's left half, and the label of the weight row in the
   *  totals and on the strip. The totals and the strip are the two tables whose first cell reads
   *  "Quantity Shipped:", in that order on the page. */
  function renamed(def: unknown) {
    const [totals, strip] = findNodes(def, (n) => {
      const body = (n.table as { body?: unknown[][] } | undefined)?.body;
      return cellTexts(body?.[0]?.[0])[0] === "Quantity Shipped:";
    }).map((n) => (n.table as { body: unknown[][] }).body);
    return {
      lines: cellTexts(tableHeaded(def, "Quantity").body[0][2]),
      containers: cellTexts(tableHeaded(def, "Container Type").body[0][1]),
      totals: cellTexts(totals[1][0]),
      strip: cellTexts(strip[1][0]),
    };
  }

  it.each(["SHIPPER", "MOS_SHIPPER"] as const)(
    "a stored config with no typed label prints the new words (%s)", (docType) => {
      expect(renamed(page(docType, seedLiteral(docType))))
        .toEqual({ lines: ["Net weight"], containers: ["Containers"], totals: ["Net weight:"], strip: ["Net weight:"] });
    });

  it.each(["SHIPPER", "MOS_SHIPPER"] as const)(
    "a stored config with no typed label prints the old wording in no cell (%s)", (docType) => {
      const old = ["Pounds", "# Of Containers", "Pounds Shipped:"];
      expect(allText(page(docType, seedLiteral(docType))).filter((text) => old.includes(text))).toEqual([]);
    });

  it.each(["SHIPPER", "MOS_SHIPPER"] as const)(
    "a typed label prints as typed, and one typed to equal the old wording prints the old wording (%s)", (docType) => {
      // The frozen config types "Lbs Shipped" over the line weights and, on the totals' weight
      // row, "Pounds Shipped:", which is the old built-in wording. The strip's label is empty.
      expect(renamed(page(docType, storedBefore(docType, "typed-labels"))))
        .toEqual({ lines: ["Lbs Shipped"], containers: ["Containers"], totals: ["Pounds Shipped:"], strip: ["Net weight:"] });
    });
});
