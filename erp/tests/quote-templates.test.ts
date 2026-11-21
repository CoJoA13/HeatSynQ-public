import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, templateVersionId } from "./helpers/db";
import { drawnText, drawnPages, pageCount, paintedImageCounts } from "./helpers/pdf";
import { runWithContext } from "@/server/context";
import { setSetting } from "@/server/settings";
import {
  createQuote, printQuote, readQuotePdfData, alignOperationAmounts, alignOperations,
} from "@/server/quotes";
import { buildQuoteDefinition, type QuotePdfData } from "@/server/pdf/quote";
import { renderPdf, barcodePng } from "@/server/pdf/render";
import { createTemplate, editDraft, publishDraft, uploadLogo } from "@/server/templates";
import { assignTemplate } from "@/server/template-assignments";
import { createSurcharge } from "@/server/surcharges";
import { QUOTE_DEFAULT_CONFIG, normalizeStoredConfig, validateConfig, type TemplateConfig } from "@/lib/template-contracts/index";
import { cellTexts, tableHeaded } from "./helpers/definition-text";
import { seedLiteral, storedBefore } from "./helpers/stored-configs";
import type { Customer, User } from "../prisma/generated/prisma/client";

/**
 * Phase 7 Task 14 — the quote conversion (the LAST of the eight). `buildQuoteDefinition` becomes a
 * config-consumer over LIVE quote data (spec §5.4/§5.6), the footer callback retires to
 * `pageFooterSpec { kind: "pageNofM", label: "Page:" }`, and the two standing texts bind at the
 * data seam from the resolved config. The golden `quote-pdf.test.ts` reproduces today's paper with
 * the default config and stays green; every Task-14 config assertion lives here.
 *
 * THE HEADLINE is the two-money-precisions trap: the quote prints `money()` 2dp on
 * setup/minimum/indicative amounts and `money4()` 4dp on unit/break prices — ONE `priceDecimals`
 * knob maps to the money4 calls ONLY.
 */

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

// ------------------------------------------------------------------------------------------------
// Pure builder fixtures — copied in shape from tests/quote-pdf.test.ts (copying across test files is
// this repo's convention), kept value-distinctive.
// ------------------------------------------------------------------------------------------------

function sampleData(overrides: Partial<QuotePdfData> = {}): QuotePdfData {
  return {
    company: { name: "Example Supplier Inc.", address: "600 Example Street\nCrystal Lake IL 60014", phone: "312.555.0100" },
    quoteNumber: 1006,
    effectiveDate: "2018-06-30",
    expiryDate: "2018-07-10",
    termsName: "Net 30",
    rfqNumber: "12345",
    attn: "Casey Example",
    customerPhone: "312.555.0102",
    billTo: ["Demo Tractor Parts", "700 Demo Drive", "Chicago, IL 12345"],
    introText: "We are pleased to provide you with the following quotation:",
    lines: [{
      quotedQty: 100, quotedUnlimited: false,
      partNumber: "Customer Part ID", partName: "Customer part name",
      partDescription: "Description of Part",
      eachWeight: 10, totalLbs: 1000, surcharges: [], material: "Customer Material",
      prices: [{
        stepName: "Bake", notes: "Quote Notes", setupCharge: 2, unitPrice: 0.15,
        minimumCharge: 100, pricePerLabel: "Each", pricedPerLb: false, breaks: [], amount: 102,
      }],
    }],
    endingStatementText: "Ending Statement from Quote Control",
    notes: "Our terms are net 30",
    liabilityText: "You can add a limited Liability Statement here.",
    signer: { name: "Mr. Johnathen Smith", title: "V.P. Sales" },
    ...overrides,
  };
}

const cfg = (): TemplateConfig => structuredClone(QUOTE_DEFAULT_CONFIG);
/** Round-trips a tweaked config through the REAL validator — every config a test feeds the builder
 *  (the raw omission-belt shapes excepted, deliberately) is one a template could store. */
const checked = (c: TemplateConfig): TemplateConfig => validateConfig("QUOTE", c);
const sectionOf = (c: TemplateConfig, key: string) => c.sections.find((s) => s.key === key)!;
const fieldOf = (c: TemplateConfig, section: string, key: string) =>
  sectionOf(c, section).fields.find((f) => f.key === key)!;

/** Every `text` string/number in a definition, flattened (skips `image` so a data-URI never
 *  pollutes a text assertion). */
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

// ================================================================================================
// #97 — indicativeAmounts maps engine OPERATION amounts back to price rows BY INDEX; the guard
// asserts the counts match first (whole-branch review F4). Tested both directions on the pure core.
// ================================================================================================

describe("alignOperationAmounts (#97 — the one-operation-per-row guard)", () => {
  it("aligns amounts to price rows by index when the counts match", () => {
    expect(alignOperationAmounts(
      [{ pricePer: "EACH" }, { pricePer: "LB" }], [{ amount: 10 }, { amount: 20 }], 5,
    )).toEqual([10, 20]);
    // An LB row with no each-weight is omitted (null), never $0 — the basis is unknown.
    expect(alignOperationAmounts([{ pricePer: "LB" }], [{ amount: 55 }], null)).toEqual([null]);
    // …but an LB row WITH an each-weight keeps its amount.
    expect(alignOperationAmounts([{ pricePer: "LB" }], [{ amount: 55 }], 10)).toEqual([55]);
  });

  it("throws, naming the mismatch, when the engine returns too FEW operation lines", () => {
    expect(() => alignOperationAmounts(
      [{ pricePer: "EACH" }, { pricePer: "EACH" }], [{ amount: 10 }], 5,
    )).toThrow(/1 operation line\(s\) for a quote line with 2 price row\(s\)/);
  });

  it("throws when the engine returns too MANY operation lines", () => {
    expect(() => alignOperationAmounts(
      [{ pricePer: "EACH" }], [{ amount: 10 }, { amount: 20 }], 5,
    )).toThrow(/one-operation-per-row contract broke/);
  });
});

describe("alignOperations (#948 — needsPrice rides beside the amount)", () => {
  it("alignOperations hands back each operation's needsPrice beside its amount", () => {
    expect(alignOperations(
      [{ pricePer: "EACH" }, { pricePer: "LB" }],
      [{ amount: 0, needsPrice: true }, { amount: 20, needsPrice: false }], 5,
    )).toEqual([{ amount: 0, needsPrice: true }, { amount: 20, needsPrice: false }]);
  });

  it("alignOperations keeps the count guard", () => {
    expect(() => alignOperations(
      [{ pricePer: "EACH" }, { pricePer: "EACH" }], [{ amount: 10, needsPrice: false }], 5,
    )).toThrow(/one-operation-per-row contract broke/);
  });
});

// ================================================================================================
// The config-consumer builder over the sample data.
// ================================================================================================

describe("buildQuoteDefinition — config-driven over the quote data", () => {
  it("a label override prints in place of the contract default", () => {
    const c = cfg();
    fieldOf(c, "header", "quote_number").label = "Quote No.:";
    fieldOf(c, "parties", "effective").label = "Good From:";
    fieldOf(c, "lines", "material").label = "Alloy:";
    const text = textOf(buildQuoteDefinition(sampleData(), checked(c)));
    expect(text).toContain("Quote No.: ");
    expect(text).not.toContain("Quotation Number:");
    expect(text).toContain("Good From: ");
    expect(text).not.toContain("Effective:");
    expect(text).toContain("Alloy: ");
    expect(text).not.toContain("Material:");
    // The values are untouched by the relabel — the config maps over the data.
    expect(text).toContain("1006");
    expect(text).toContain("06/30/2018");
    expect(text).toContain("Customer Material");
  });

  it("a column width override lands in the column-header widths array", () => {
    const c = cfg();
    fieldOf(c, "column_header", "col_qty").width = 40;
    const def = buildQuoteDefinition(sampleData(), checked(c));
    expect(allWidths(def)).toContainEqual([40, "*", 66, 84]);
    // …the default keeps [52, "*", 66, 84].
    expect(allWidths(buildQuoteDefinition(sampleData()))).toContainEqual([52, "*", 66, 84]);
  });

  it("a hidden section is omitted from the stack; the default still prints it", () => {
    const c = cfg();
    sectionOf(c, "liability").visible = false;
    const text = textOf(buildQuoteDefinition(sampleData(), checked(c)));
    expect(text).not.toContain("You can add a limited Liability Statement here.");
    expect(textOf(buildQuoteDefinition(sampleData()))).toContain("You can add a limited Liability Statement here.");
  });

  it("a hidden column field drops its whole column and shrinks the widths", () => {
    const c = cfg();
    fieldOf(c, "column_header", "col_each_weight").visible = false;
    const def = buildQuoteDefinition(sampleData(), checked(c));
    expect(textOf(def)).not.toContain("Each weight");
    expect(allWidths(def)).toContainEqual([52, "*", 84]); // the each-weight column is gone
  });

  it("stack order follows the config's section order", () => {
    const c = cfg();
    const i = c.sections.findIndex((s) => s.key === "intro");
    const j = c.sections.findIndex((s) => s.key === "header");
    [c.sections[i], c.sections[j]] = [c.sections[j], c.sections[i]];
    const text = textOf(buildQuoteDefinition(sampleData(), checked(c)));
    expect(text.indexOf("We are pleased")).toBeLessThan(text.indexOf("Quotation Number:"));
    // …the default order is the header first.
    const dflt = textOf(buildQuoteDefinition(sampleData()));
    expect(dflt.indexOf("Quotation Number:")).toBeLessThan(dflt.indexOf("We are pleased"));
  });
});

describe("buildQuoteDefinition — fonts and number formats", () => {
  it("family, base size and heading size map into the definition", () => {
    const c = cfg();
    c.fonts = { family: "Liberation Serif", baseSize: 8, headingSize: 26, smallSize: 5 };
    const def = buildQuoteDefinition(sampleData(), checked(c));
    expect(def.defaultStyle).toEqual({ font: "Liberation Serif", fontSize: 8 });
    // headingSize drives the "Quotation" title.
    expect(findNodes(def, (n) => n.text === "Quotation")[0].fontSize).toBe(26);
    // …the default keeps today's literals.
    const dflt = buildQuoteDefinition(sampleData());
    expect(dflt.defaultStyle).toEqual({ font: "Roboto", fontSize: 9 });
    expect(findNodes(dflt, (n) => n.text === "Quotation")[0].fontSize).toBe(20);
  });

  it("thousandsSeparator: false ungroups money", () => {
    const c = cfg();
    c.formats.thousandsSeparator = false;
    const big = sampleData();
    big.lines[0].prices = [{
      stepName: "Bake", notes: "", setupCharge: 0, unitPrice: 1234.5, minimumCharge: null,
      pricePerLabel: "Lot (flat)", pricedPerLb: false, breaks: [], amount: 9374.4,
    }];
    const text = textOf(buildQuoteDefinition(big, checked(c)));
    expect(text).toContain("$9374.40");   // the 2dp amount, ungrouped
    expect(text).toContain("$1234.50");   // the money4 unit price, ungrouped
    expect(text).not.toContain("$9,374.40");
    expect(text).not.toContain("$1,234.50");
  });
});

describe("buildQuoteDefinition: a line's weights and a per-lb price break carry the unit (weights design §13; owner ruling W15)", () => {
  type Line = QuotePdfData["lines"][number];
  /** 200 pieces at 6.4 lb, under the sample's one price row. */
  const line = (over: Partial<Line> = {}): Line =>
    ({ ...sampleData().lines[0], quotedQty: 200, partNumber: "BRACKET-A", eachWeight: 6.4, totalLbs: 1280, ...over });
  /** The line's grid row, the one `columns` node that holds its part number: its first, third and fourth cells, each whole. */
  const weights = (over: Partial<Line> = {}, config?: TemplateConfig) => {
    const def = buildQuoteDefinition(sampleData({ lines: [line(over)] }), config);
    const [row] = findNodes(def, (n) => Array.isArray(n.columns)
      && (n.columns as unknown[]).some((cell) => cellTexts(cell).includes("BRACKET-A")));
    const [qty, , each, net] = row.columns as unknown[];
    return { qty: cellTexts(qty), each: cellTexts(each), net: cellTexts(net) };
  };

  // The quantity is a count, or the word Unlimited: its cell is held whole in every row, so a unit on it is refused.
  it.each<[state: string, over: Partial<Line>, qty: string[], each: string[], net: string[]]>([
    ["200 pieces at 6.4 lb", {}, ["200"], ["6.40 lb"], ["1,280.00 lb"]],
    ["an Unlimited line: no net weight, and no unit", { quotedQty: null, quotedUnlimited: true, totalLbs: null }, ["Unlimited"], ["6.40 lb"], [""]],
    ["a line with no each weight: both blank, and no unit", { eachWeight: null, totalLbs: null }, ["200"], [""], [""]],
  ])("%s", (_state, over, qty, each, net) => {
    expect(weights(over)).toEqual({ qty, each, net });
  });

  it("prints the unit under a heading a stored template typed (the frozen typed-label config)", () => {
    const config = normalizeStoredConfig("QUOTE", storedBefore("QUOTE", "typed-label"));
    expect(weights({}, config)).toEqual({ qty: ["200"], each: ["6.40 lb"], net: ["1,280.00 lb"] });
  });

  it.each<[field: string, each: string[], net: string[]]>([
    ["line_each_weight", [""], ["1,280.00 lb"]],
    ["line_total_lbs", ["6.40 lb"], [""]],
  ])("a template that hid %s prints that cell empty, with no unit, and the other weight as it was", (field, each, net) => {
    const c = cfg();
    fieldOf(c, "lines", field).visible = false;
    expect(weights({}, checked(c))).toEqual({ qty: ["200"], each, net });
  });

  /** One price row with one break. The label is the basis word its price line ends with. The flag
   *  says its break thresholds are weights. */
  const price = (pricePerLabel: string, pricedPerLb: boolean, threshold: number, breakPrice: number): Line["prices"][number] => ({
    stepName: "Bake", notes: "", setupCharge: null, unitPrice: 0.15, minimumCharge: null,
    pricePerLabel, pricedPerLb, breaks: [{ threshold, price: breakPrice }], amount: null,
  });
  /** Every break line of a one-line quote with these price rows, in print order. */
  const breakLines = (prices: Line["prices"]) =>
    findNodes(buildQuoteDefinition(sampleData({ lines: [line({ prices })] })),
      (n) => typeof n.text === "string" && (n.text as string).includes("or more:")).map((n) => n.text);

  it("a price break says lb on an operation priced per lb, and stays bare on one priced in pieces", () => {
    expect(breakLines([price("Per lb", true, 1000, 0.05), price("Each", false, 100, 0.12)]))
      .toEqual(["1,000 lb or more:  $0.05", "100 or more:  $0.12"]);
  });

  it("the flag puts lb on a price break, and the basis word does not", () => {
    // Two rows whose word and flag disagree. No saved quote holds one: `readQuotePdfData` works both
    // out from the price's one basis. Here a builder that read the word would print the unit on the
    // second break and leave it off the first.
    expect(breakLines([price("Each", true, 1000, 0.05), price("Per lb", false, 100, 0.12)]))
      .toEqual(["1,000 lb or more:  $0.05", "100 or more:  $0.12"]);
  });
});

// THE HEADLINE — the two-money-precisions trap. ONE priceDecimals knob maps to the money4
// (unit/break price) calls ONLY; the money() 2dp calls (setup/minimum/indicative amount) never move.
describe("buildQuoteDefinition — priceDecimals maps to unit/break prices ONLY (the two-money trap)", () => {
  const twoMoneyData = () => {
    const d = sampleData();
    d.lines[0].prices = [{
      stepName: "Bake", notes: "", setupCharge: 2, unitPrice: 0.0525, minimumCharge: 100,
      pricePerLabel: "Each", pricedPerLb: false, breaks: [{ threshold: 500, price: 0.0625 }], amount: 102,
    }];
    return d;
  };

  it("default (priceDecimals 4): the unit/break prices print to 4dp; setup/minimum/amount are 2dp", () => {
    const text = textOf(buildQuoteDefinition(twoMoneyData()));
    expect(text).toContain("$0.0525"); // unit price — money4
    expect(text).toContain("$0.0625"); // break price — money4
    expect(text).toContain("$2.00");   // setup — money() 2dp
    expect(text).toContain("$100.00"); // minimum — money() 2dp
    expect(text).toContain("$102.00"); // indicative amount — money() 2dp
  });

  it("priceDecimals 2: the unit/break prices round to cents; setup/minimum/amount are UNCHANGED", () => {
    const c = cfg();
    c.formats.priceDecimals = 2;
    const text = textOf(buildQuoteDefinition(twoMoneyData(), checked(c)));
    expect(text).toContain("$0.05");   // 0.0525 → 2dp
    expect(text).toContain("$0.06");   // 0.0625 → 2dp
    expect(text).not.toContain("$0.0525");
    expect(text).not.toContain("$0.0625");
    // The load-bearing half: the 2dp money() calls DID NOT MOVE.
    expect(text).toContain("$2.00");
    expect(text).toContain("$100.00");
    expect(text).toContain("$102.00");
  });

  it("priceDecimals 3: the unit price prints to 3dp; the 2dp money() calls still do not move", () => {
    const c = cfg();
    c.formats.priceDecimals = 3;
    const d = sampleData();
    d.lines[0].prices = [{
      stepName: "Bake", notes: "", setupCharge: 2, unitPrice: 0.055, minimumCharge: 100,
      pricePerLabel: "Per lb", pricedPerLb: true, breaks: [], amount: 102,
    }];
    const text = textOf(buildQuoteDefinition(d, checked(c)));
    expect(text).toContain("$0.055"); // money4 keeps 3 decimals
    expect(text).toContain("$2.00");
    expect(text).toContain("$100.00");
    expect(text).toContain("$102.00");
  });
});

describe("buildQuoteDefinition — the date knob (both slots, one style)", () => {
  it.each([
    ["M/D/YYYY", "6/30/2018", "7/10/2018"],
    ["MM/DD/YYYY", "06/30/2018", "07/10/2018"],
    ["YYYY-MM-DD", "2018-06-30", "2018-07-10"],
    ["MMMM D, YYYY", "June 30, 2018", "July 10, 2018"],
    ["MMM - DD - YYYY", "Jun - 30 - 2018", "Jul - 10 - 2018"],
  ])("renders both the Effective and Expires dates as %s", (format, eff, exp) => {
    const c = cfg();
    c.formats.dateFormat = format as TemplateConfig["formats"]["dateFormat"];
    const text = textOf(buildQuoteDefinition(sampleData(), checked(c)));
    expect(text).toContain(eff);
    expect(text).toContain(exp);
  });

  it("defaults to the sample's MM/DD/YYYY padded style", () => {
    const text = textOf(buildQuoteDefinition(sampleData()));
    expect(text).toContain("06/30/2018");
    expect(text).toContain("07/10/2018");
  });
});

describe("buildQuoteDefinition — the §5.6 belt, both halves", () => {
  it("nothing on this contract is locked: a validated config may hide ANY section and the builder honors it", () => {
    const c = cfg();
    sectionOf(c, "closing").visible = false;
    const text = textOf(buildQuoteDefinition(sampleData(), checked(c)));
    expect(text).not.toContain("Mr. Johnathen Smith");
  });

  it("a raw config OMITTING the intro section entry still renders it (the omission half)", () => {
    const c = cfg();
    c.sections = c.sections.filter((s) => s.key !== "intro");
    const text = textOf(buildQuoteDefinition(sampleData(), c));
    expect(text).toContain("We are pleased to provide you with the following quotation:");
  });

  it("a raw config OMITTING a field entry inside a present section still renders it", () => {
    const c = cfg();
    const parties = sectionOf(c, "parties");
    parties.fields = parties.fields.filter((f) => f.key !== "terms");
    const text = textOf(buildQuoteDefinition(sampleData(), c));
    expect(text).toContain("Terms:");
  });
});

const LOGO_URI = "data:image/png;base64,QUOTELOGOFIXTURE";

describe("buildQuoteDefinition — logo placement (spec §6.3)", () => {
  const placedConfig = (placement: "header-left" | "header-center" | "header-right") => {
    const c = cfg();
    c.logo = { placement, width: 90 };
    return checked(c);
  };
  const header = (def: unknown) => (def as { content: Record<string, unknown>[] }).content[0];

  it("a header-center logo unshifts into the centered header stack", () => {
    const h = header(buildQuoteDefinition(sampleData(), placedConfig("header-center"), LOGO_URI));
    const center = (h.columns as { width?: unknown; stack?: { image?: string }[] }[]).find((col) => col.width === "*")!;
    expect(center.stack![0]).toEqual({ image: LOGO_URI, width: 90 });
  });

  it("a header-left logo rides the left column at its configured width", () => {
    const h = header(buildQuoteDefinition(sampleData(), placedConfig("header-left"), LOGO_URI));
    const cols = h.columns as { width?: number; stack?: { image?: string }[] }[];
    expect(cols[0].stack![0]).toEqual({ image: LOGO_URI, width: 90 });
  });

  it("a header-right logo rides the right column", () => {
    const h = header(buildQuoteDefinition(sampleData(), placedConfig("header-right"), LOGO_URI));
    const cols = h.columns as { width?: number; stack?: { image?: string }[] }[];
    expect(cols[cols.length - 1].stack![0]).toEqual({ image: LOGO_URI, width: 90 });
  });

  it("config placement without bytes, and bytes without placement, both fall back to the text-only header", () => {
    expect(JSON.stringify(buildQuoteDefinition(sampleData(), placedConfig("header-center")))).not.toContain(LOGO_URI);
    expect(JSON.stringify(buildQuoteDefinition(sampleData(), cfg(), LOGO_URI))).not.toContain(LOGO_URI);
  });
});

describe("buildQuoteDefinition — pageFooter (ON by default — the quote alone) and the continuation band", () => {
  it("the default declares the pageNofM footer with label 'Page:' and NO hand-written callback", () => {
    const def = buildQuoteDefinition(sampleData());
    expect(def.footer).toBeUndefined();
    expect(def.pageFooterSpec).toEqual({ kind: "pageNofM", label: "Page:" });
  });

  it("the knob OFF drops the footer entirely", () => {
    const c = cfg();
    c.pageFooter = false;
    const def = buildQuoteDefinition(sampleData(), checked(c));
    expect(def.pageFooterSpec).toBeUndefined();
    expect(def.footer).toBeUndefined();
  });

  it("the definition carries the quote number band for continuation pages", () => {
    const def = buildQuoteDefinition(sampleData());
    const band = allText(def.continuationHeaderSpec!.content).join("\n");
    expect(band).toContain("Quotation Number: 1006");
    expect(band).toContain("(continued)");
    expect(def.continuationHeaderSpec!.overflowTopMargin).toBeGreaterThanOrEqual(36);
  });

  it("a many-line quote overflows LETTER and prints 'Page: N of M' on every page (byte-identical footer)", async () => {
    const lines = Array.from({ length: 16 }, (_, i) => ({
      quotedQty: 100, quotedUnlimited: false,
      partNumber: `PART-${i}`, partName: `Name ${i}`, partDescription: `Description ${i}`,
      eachWeight: 10, totalLbs: 1000, surcharges: [], material: "Steel",
      prices: [{
        stepName: "Bake", notes: "Notes", setupCharge: 2, unitPrice: 0.15, minimumCharge: 100,
        pricePerLabel: "Each", pricedPerLb: false, breaks: [], amount: 102,
      }],
    }));
    const pdf = await renderPdf(buildQuoteDefinition(sampleData({ lines })));
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(2);
    const total = pageCount(pdf);
    const pages = drawnPages(pdf);
    // The retired footer callback and the pageNofM primitive produce the SAME "Page: N of M" line.
    expect(drawnText(pdf)).toContain(`Page: 1 of ${total}`);
    expect(pages[pages.length - 1]).toContain(`Page: ${total} of ${total}`);
    // The continuation band repeats the quote number on page 2+.
    expect(pages[0]).not.toContain("(continued)");
    expect(pages[pages.length - 1]).toContain("(continued)");
  });
});

describe("buildQuoteDefinition — purity, config included (the footer callback is retired)", () => {
  it("a config-driven definition survives the JSON round trip and is deterministic", () => {
    const c = cfg();
    c.logo = { placement: "header-right", width: 80 };
    fieldOf(c, "header", "quote_number").label = "Quote No.:";
    c.formats.dateFormat = "YYYY-MM-DD";
    c.formats.priceDecimals = 2;
    const config = checked(c);
    const def = buildQuoteDefinition(sampleData(), config, LOGO_URI);
    expect(JSON.parse(JSON.stringify(def))).toEqual(def);
    expect(buildQuoteDefinition(sampleData(), config, LOGO_URI)).toEqual(def);
  });
});

// ================================================================================================
// The print path (spec §5.2): resolve docType QUOTE on the quote's customer, render the resolved
// config, stamp `templateVersionId`. `printQuote` claims the Quote row; resolution runs on that
// claimed Serializable tx. The two standing texts bind at the data seam from the resolved config —
// the retired Setting no longer reaches paper.
// ================================================================================================

let seq = 0;
async function makeCustomer(): Promise<Customer> {
  seq += 1;
  const terms = await prisma.terms.create({ data: { name: `Net ${seq}`, netDays: 30 } });
  return prisma.customer.create({ data: { code: `QT${seq}`, name: `Quote Template Customer ${seq}`, termsId: terms.id } });
}

async function makeBillTo(customerId: string) {
  return prisma.customerAddress.create({
    data: {
      customerId, kind: "BILL_TO", name: "", street: "700 Demo Drive",
      city: "Chicago", state: "IL", zip: "12345", isDefault: true,
    },
  });
}

async function makeQuotedBy(): Promise<User> {
  seq += 1;
  return prisma.user.create({
    data: { username: `qtsales${seq}`, displayName: "Mr. Johnathen Smith", passwordHash: "x", title: "V.P. Sales" },
  });
}

async function quoteFor(customer: Customer, unitPrice = "0.1500") {
  const quotedBy = await makeQuotedBy();
  const step = await prisma.processStepCode.create({ data: { code: `QTS${seq++}`, name: "Bake" } });
  return asSystem(() => createQuote({
    customerId: customer.id, quotedById: quotedBy.id, rfqNumber: "12345", notes: "Our terms are net 30",
    lines: [{
      partNumberText: "Customer Part ID", partNameText: "Customer part name",
      materialText: "Customer Material", eachWeight: "10", quotedQty: 100,
      prices: [{ processStepCodeId: step.id, setupCharge: "2.00", unitPrice, minimumCharge: "100.00", pricePer: "EACH" }],
    }],
  }));
}

let tplSeq = 0;
async function publishCustom(tweak: (c: TemplateConfig) => void, logo?: { data: Buffer; mime: string }) {
  tplSeq += 1;
  const t = await asSystem(() => createTemplate("QUOTE", `Custom Quote ${tplSeq}`));
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

describe("printQuote — resolution stamps the QUOTE version", () => {
  beforeEach(async () => {
    await truncateAll();
    await asSystem(() => setSetting("company_name", "Example Supplier Inc."));
    await asSystem(() => setSetting("company_address", "600 Example Street\nCrystal Lake IL 60014"));
    await asSystem(() => setSetting("company_phone", "312.555.0100"));
  });

  it("no assignment: resolves the seeded Standard quote and stamps ITS version id", async () => {
    const customer = await makeCustomer();
    await makeBillTo(customer.id);
    const quote = await quoteFor(customer);
    const { documentId, pdf } = await asSystem(() => printQuote(quote.id));
    expect(drawnText(pdf)).toContain("Quotation");
    expect(await stampOf(documentId)).toBe(templateVersionId("QUOTE"));
  });

  it("an active percent surcharge prints its estimate row through the real print path (#948)", async () => {
    await asSystem(() => createSurcharge({ name: "EnergySur", kind: "PERCENT", rate: "0.050000", position: 1, scope: "ALL" }));
    const customer = await makeCustomer();
    await makeBillTo(customer.id);
    const quote = await quoteFor(customer); // setup 2.00 + the 100.00 minimum: indicative $102.00
    const { pdf } = await asSystem(() => printQuote(quote.id));
    const text = drawnText(pdf);
    expect(text).toContain("EnergySur 5% (estimate):");
    expect(text).toContain("$5.10");
  });

  it("a label override prints through the real path and stamps the assigned version", async () => {
    const customer = await makeCustomer();
    await makeBillTo(customer.id);
    const quote = await quoteFor(customer);
    const tpl = await publishCustom((c) => { fieldOf(c, "header", "title").label = "QUOTE-STYLE-MARKER"; });
    await asSystem(() => assignTemplate(customer.id, "QUOTE", tpl.templateId));
    const { documentId, pdf } = await asSystem(() => printQuote(quote.id));
    expect(drawnText(pdf)).toContain("QUOTE-STYLE-MARKER");
    expect(await stampOf(documentId)).toBe(tpl.versionId);
  });

  it("the two standing texts come from the resolved config's text blocks (the data seam)", async () => {
    const customer = await makeCustomer();
    await makeBillTo(customer.id);
    const quote = await quoteFor(customer);
    const tpl = await publishCustom((c) => {
      c.textBlocks.quote_intro_text = "CONFIG-INTRO-MARKER";
      c.textBlocks.quote_liability_text = "CONFIG-LIABILITY-MARKER";
    });
    await asSystem(() => assignTemplate(customer.id, "QUOTE", tpl.templateId));
    const { pdf } = await asSystem(() => printQuote(quote.id));
    const text = drawnText(pdf);
    expect(text).toContain("CONFIG-INTRO-MARKER");
    expect(text).toContain("CONFIG-LIABILITY-MARKER");
    // The retired Setting no longer reaches paper: the seeded default intro is gone from this print.
    expect(text).not.toContain("We are pleased to provide you with the following quotation:");
  });

  it("priceDecimals from the assigned template moves the unit price on paper (the two-money trap through the real path)", async () => {
    const customer = await makeCustomer();
    await makeBillTo(customer.id);
    const quote = await quoteFor(customer, "0.0525");
    const tpl = await publishCustom((c) => { c.formats.priceDecimals = 2; });
    await asSystem(() => assignTemplate(customer.id, "QUOTE", tpl.templateId));
    const { pdf } = await asSystem(() => printQuote(quote.id));
    const text = drawnText(pdf);
    expect(text).toContain("$0.05");     // the unit price rounded to cents
    expect(text).not.toContain("$0.0525");
    expect(text).toContain("$2.00");     // setup stays 2dp — never moved by the knob
  });

  it("the pageFooter knob OFF drops the per-page numbers; the default (ON) prints them", async () => {
    const a = await makeCustomer();
    await makeBillTo(a.id);
    const quoteA = await quoteFor(a);
    const withFooter = await asSystem(() => printQuote(quoteA.id));
    expect(drawnText(withFooter.pdf)).toContain("Page: 1 of 1");

    const b = await makeCustomer();
    await makeBillTo(b.id);
    const quoteB = await quoteFor(b);
    const tpl = await publishCustom((c) => { c.pageFooter = false; });
    await asSystem(() => assignTemplate(b.id, "QUOTE", tpl.templateId));
    const bare = await asSystem(() => printQuote(quoteB.id));
    expect(drawnText(bare.pdf)).not.toMatch(/Page: \d+ of \d+/);
  });

  it("a placed logo prints through the real path; the bare quote paints none", async () => {
    const a = await makeCustomer();
    await makeBillTo(a.id);
    const quoteA = await quoteFor(a);
    const tpl = await publishCustom(
      (c) => { c.logo = { placement: "header-left", width: 90 }; },
      { data: await barcodePng("QUOTELOGO"), mime: "image/png" });
    await asSystem(() => assignTemplate(a.id, "QUOTE", tpl.templateId));
    const placed = await asSystem(() => printQuote(quoteA.id));
    expect(paintedImageCounts(placed.pdf)).toEqual([1]);

    const b = await makeCustomer();
    await makeBillTo(b.id);
    const quoteB = await quoteFor(b);
    const bare = await asSystem(() => printQuote(quoteB.id));
    expect(paintedImageCounts(bare.pdf)).toEqual([0]);
  });
});

describe("readQuotePdfData — the standing texts default to the QUOTE contract's text blocks", () => {
  beforeEach(async () => {
    await truncateAll();
    await asSystem(() => setSetting("company_name", "Example Supplier Inc."));
  });

  it("a config-less read carries the contract-default intro (no Setting is consulted)", async () => {
    const customer = await makeCustomer();
    await makeBillTo(customer.id);
    const quote = await quoteFor(customer);
    const data = await readQuotePdfData(prisma, quote.id);
    expect(data.introText).toBe("We are pleased to provide you with the following quotation:");
    expect(data.liabilityText).toBe("");
  });
});

describe("the quote's built-in heading on stored configs (owner ruling W14)", () => {
  const page = (stored: unknown) => buildQuoteDefinition(sampleData(), normalizeStoredConfig("QUOTE", stored));
  const heads = (def: unknown) => tableHeaded(def, "Quantity").body[0].map(cellTexts);
  const KEPT = [["Quantity"], ["Part No. / Description / Pricing Information"], ["Each weight"]];

  it("a stored config with no typed label prints the new heading", () => {
    expect(heads(page(seedLiteral("QUOTE")))).toEqual([...KEPT, ["Net weight / Price"]]);
  });

  it("a stored config with no typed label prints the old wording in no cell", () => {
    expect(allText(page(seedLiteral("QUOTE"))).filter((text) => text === "Total Lbs / Price")).toEqual([]);
  });

  it("a typed label prints as typed", () => {
    expect(heads(page(storedBefore("QUOTE", "typed-label")))).toEqual([...KEPT, ["Lbs / Price"]]);
  });

  it("a label typed to equal the old wording prints the old wording", () => {
    const stored = storedBefore("QUOTE", "typed-label") as TemplateConfig;
    fieldOf(stored, "column_header", "col_amount").label = "Total Lbs / Price";
    expect(heads(page(stored))).toEqual([...KEPT, ["Total Lbs / Price"]]);
  });
});
