/**
 * The printed width of every template table (#457): the declared column widths the budget checks,
 * plus the cell padding and rules its layout adds on paper. Pure: no render and no database.
 * tests/template-printed-width-render.test.ts holds these figures to render.ts's layouts and to
 * the rendered strokes.
 *
 * Also the shipping ticket's shared-width rule (#519): what each column that shares the container
 * table's spare width gets, on the seed migration's literal and the configs frozen before the
 * weights pull request (./helpers/stored-configs), as tests/stored-template-check.test.ts judges
 * them in the listing.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONTRACTS,
  TEMPLATE_DOC_TYPES,
  contractFor,
  travelerStepsPrintedWidth,
  validateConfig,
  BOL_DEFAULT_CONFIG,
  CERT_DEFAULT_CONFIG,
  INVOICE_DEFAULT_CONFIG,
  MOS_SHIPPER_DEFAULT_CONFIG,
  QUOTE_DEFAULT_CONFIG,
  CONTAINER_TAG_DEFAULT_CONFIG,
  SHIPPER_DEFAULT_CONFIG,
  STATEMENT_DEFAULT_CONFIG,
  TRAVELER_DEFAULT_CONFIG,
  type TemplateConfig,
  type TemplateDocTypeString,
} from "@/lib/template-contracts";
import {
  COLUMN_TABLE_LAYOUTS, MIN_SHARED_WIDTH_PT, pt, sharedContainerWidth, sharedWidthWords,
  tablePrintedWidth,
} from "@/lib/template-printed-width";
import { seedLiteral, storedBefore, storedNames } from "./helpers/stored-configs";
import { validateContractConfig } from "@/lib/template-contracts/types";

const DEFAULTS: Record<TemplateDocTypeString, TemplateConfig> = {
  TRAVELER: TRAVELER_DEFAULT_CONFIG, SHIPPER: SHIPPER_DEFAULT_CONFIG, MOS_SHIPPER: MOS_SHIPPER_DEFAULT_CONFIG,
  BOL: BOL_DEFAULT_CONFIG, CERT: CERT_DEFAULT_CONFIG, INVOICE: INVOICE_DEFAULT_CONFIG,
  STATEMENT: STATEMENT_DEFAULT_CONFIG, QUOTE: QUOTE_DEFAULT_CONFIG, CONTAINER_TAG: CONTAINER_TAG_DEFAULT_CONFIG,
};

/** A field edit: a typed width (null empties the box), and optionally a hidden column. */
type Edit = { width?: number | null; hidden?: true };

/** The built-in config of `docType` with `edits` applied to `section`'s fields, validated. */
function configured(
  docType: TemplateDocTypeString, section: string, edits: Record<string, Edit>,
): TemplateConfig {
  const c = structuredClone(DEFAULTS[docType]);
  const s = c.sections.find((candidate) => candidate.key === section)!;
  for (const [key, edit] of Object.entries(edits)) {
    const field = s.fields.find((candidate) => candidate.key === key);
    if (field === undefined) throw new Error(`${docType} ${section} has no field ${key}`);
    if (edit.width !== undefined) field.width = edit.width;
    if (edit.hidden) field.visible = false;
  }
  // The contract's own battery, not the registry's: the figures here are the arithmetic's, and many of these configs
  // pass the printed-width budget the registry refuses (owner ruling R-B, 2026-11-17, #991), as an unsaved edit can.
  return validateContractConfig(contractFor(docType), c);
}

const widthOf = (docType: TemplateDocTypeString, config: TemplateConfig, table: string) =>
  tablePrintedWidth(contractFor(docType), config, table);

describe("tablePrintedWidth (#457)", () => {
  it("adds 8pt of cell padding a column to a ruled table: the cert's parts at 404", () => {
    expect(widthOf("CERT", configured("CERT", "parts", { part_identity: { width: 404 } }), "parts")).toEqual({
      declared: 564, overhead: 24, printed: 588, flexible: false, budget: 564, copies: 1,
    });
  });

  it("adds the padding and every vertical rule to a boxed table: the invoice's and the quote's columns", () => {
    for (const docType of ["INVOICE", "QUOTE"] as const) {
      expect(widthOf(docType, configured(docType, "column_header", { col_info: { width: 362 } }), "columns"),
        docType).toEqual({ declared: 564, overhead: 36, printed: 600, flexible: false, budget: 564, copies: 1 });
    }
  });

  it("counts only the shown columns: the invoice with Each weight hidden", () => {
    const c = configured("INVOICE", "column_header", { col_info: { width: 400 }, col_each_weight: { hidden: true } });
    expect(widthOf("INVOICE", c, "columns")).toEqual({
      declared: 536, overhead: 27.2, printed: 563.2, flexible: false, budget: 564, copies: 1,
    });
  });

  it("measures the statement's aging strip, with and without two hidden buckets", () => {
    const sixAt80 = Object.fromEntries(
      ["aging_current", "aging_1_30", "aging_31_60", "aging_61_90", "aging_90_plus", "aging_unapplied"]
        .map((key) => [key, { width: 80 }]));
    expect(widthOf("STATEMENT", configured("STATEMENT", "aging", { ...sixAt80, aging_net: { width: 84 } }), "aging"))
      .toEqual({ declared: 564, overhead: 62.4, printed: 626.4, flexible: false, budget: 564, copies: 1 });
    const fiveShown = configured("STATEMENT", "aging", {
      aging_current: { width: 100 }, aging_1_30: { width: 100 }, aging_31_60: { width: 100 }, aging_61_90: { width: 100 },
      aging_90_plus: { hidden: true }, aging_unapplied: { hidden: true }, aging_net: { width: 100 },
    });
    expect(widthOf("STATEMENT", fiveShown, "aging"))
      .toEqual({ declared: 500, overhead: 44.8, printed: 544.8, flexible: false, budget: 564, copies: 1 });
  });

  it("measures the ticket's field strip with every column typed", () => {
    for (const docType of ["SHIPPER", "MOS_SHIPPER"] as const) {
      const c = configured(docType, "field_strip", { po_number: { width: 140 }, packing_list_no: { width: 138 } });
      expect(widthOf(docType, c, "field_strip"), docType)
        .toEqual({ declared: 543, overhead: 44.8, printed: 587.8, flexible: false, budget: 564, copies: 1 });
    }
  });

  it("measures the bill of lading's freight table against the 386pt it has beside the sidebar", () => {
    const c = configured("BOL", "freight", { freight_description: { width: 198 } });
    expect(widthOf("BOL", c, "freight")).toEqual({
      declared: 386, overhead: 44.8, printed: 430.8, flexible: false, budget: 386, copies: 1,
    });
  });

  it("measures one half of the ticket's container table, which prints twice", () => {
    for (const docType of ["SHIPPER", "MOS_SHIPPER"] as const) {
      const typed = configured(docType, "containers", { container_count: { width: 60 }, container_tare: { width: 60 } });
      expect(widthOf(docType, typed, "containers"), docType).toEqual({
        declared: 262, overhead: 32, printed: 294, flexible: false, budget: 282, copies: 2,
      });
      const idHidden = configured(docType, "containers", {
        container_count: { width: 100 }, container_tare: { width: 100 }, cust_cont_id: { hidden: true },
      });
      expect(widthOf(docType, idHidden, "containers"), docType).toEqual({
        declared: 280, overhead: 24, printed: 304, flexible: false, budget: 282, copies: 2,
      });
    }
  });

  it("measures the traveler's inspections: a borderless table inside one boxed cell", () => {
    const all = configured("TRAVELER", "inspections", {
      inspection_code: { width: 170 }, inspection_location: { width: 171 },
    });
    expect(widthOf("TRAVELER", all, "inspections")).toEqual({
      declared: 564, overhead: 49.6, printed: 613.6, flexible: false, budget: 564, copies: 1,
    });
    const scaleHidden = configured("TRAVELER", "inspections", {
      inspection_code: { width: 190 }, inspection_location: { width: 190 }, inspection_scale: { hidden: true },
    });
    expect(widthOf("TRAVELER", scaleHidden, "inspections")).toEqual({
      declared: 548, overhead: 41.6, printed: 589.6, flexible: false, budget: 564, copies: 1,
    });
  });

  it("measures the traveler's part lines and quantities, ruled", () => {
    expect(widthOf("TRAVELER", configured("TRAVELER", "lines", { line_part: { width: 288 } }), "lines"))
      .toEqual({ declared: 532, overhead: 32, printed: 564, flexible: false, budget: 564, copies: 1 });
    expect(widthOf("TRAVELER", configured("TRAVELER", "quantities", { container: { width: 106 } }), "quantities"))
      .toEqual({ declared: 516, overhead: 48, printed: 564, flexible: false, budget: 564, copies: 1 });
  });

  it("gives the traveler's steps table travelerStepsPrintedWidth's own figures", () => {
    for (const width of [null, 300, 351]) {
      const c = configured("TRAVELER", "steps", { step_instruction: { width } });
      expect(widthOf("TRAVELER", c, "steps"), String(width)).toEqual({
        ...travelerStepsPrintedWidth(c.sections, c.fonts.baseSize), budget: 564, copies: 1,
      });
    }
  });

  it("is flexible at the built-in widths, where every table shows a flex column", () => {
    const tables: [TemplateDocTypeString, string][] = [
      ["TRAVELER", "lines"], ["TRAVELER", "quantities"], ["TRAVELER", "inspections"], ["TRAVELER", "steps"],
      ["SHIPPER", "field_strip"], ["SHIPPER", "lines"], ["SHIPPER", "containers"],
      ["MOS_SHIPPER", "field_strip"], ["MOS_SHIPPER", "lines"], ["MOS_SHIPPER", "containers"],
      ["BOL", "freight"], ["CERT", "parts"], ["INVOICE", "columns"], ["STATEMENT", "aging"], ["QUOTE", "columns"],
    ];
    for (const [docType, table] of tables) {
      expect(widthOf(docType, DEFAULTS[docType], table)?.flexible, `${docType} ${table}`).toBe(true);
    }
    // The built-in cert parts: 70 + 90 declared, Part identity flex.
    expect(widthOf("CERT", CERT_DEFAULT_CONFIG, "parts")).toEqual({
      declared: 160, overhead: 24, printed: 184, flexible: true, budget: 564, copies: 1,
    });
  });

  it("is null for a hidden section, a table with no column shown, and a table the contract lacks", () => {
    const hidden = structuredClone(CERT_DEFAULT_CONFIG);
    hidden.sections.find((s) => s.key === "parts")!.visible = false;
    expect(widthOf("CERT", validateConfig("CERT", hidden), "parts")).toBeNull();
    const noColumn = configured("CERT", "parts", {
      part_qty: { hidden: true }, part_identity: { hidden: true }, part_pounds: { hidden: true },
    });
    expect(widthOf("CERT", noColumn, "parts")).toBeNull();
    expect(widthOf("CERT", CERT_DEFAULT_CONFIG, "steps")).toBeNull();
    // The editor asks about "steps" with whatever contract the page holds: an invoice has none.
    expect(widthOf("INVOICE", TRAVELER_DEFAULT_CONFIG, "steps")).toBeNull();
  });

  it("names a layout for every column table of every contract, and nothing a contract lacks", () => {
    for (const docType of TEMPLATE_DOC_TYPES) {
      const contract = CONTRACTS[docType]!;
      const tables = new Set(contract.sections.flatMap((s) => s.fields.flatMap((f) => (f.column ? [f.column.table] : []))));
      expect(Object.keys(COLUMN_TABLE_LAYOUTS[docType]).sort(), docType).toEqual([...tables].sort());
    }
    expect(Object.keys(COLUMN_TABLE_LAYOUTS).sort()).toEqual([...TEMPLATE_DOC_TYPES].sort());
  });
});

const TICKETS = ["SHIPPER", "MOS_SHIPPER"] as const;
type Ticket = (typeof TICKETS)[number];

/** A stored config as the contract's own battery reads it: the frozen configs that pass the printed-width budget
 *  (widths-full, type-width-220) are refused by the registry since owner ruling R-B, and their shares are still the
 *  arithmetic's. */
const read = (docType: Ticket, stored: unknown): TemplateConfig => validateContractConfig(contractFor(docType), stored);
/** The seed literal as this program's editor would save it: complete, the fields added since in. */
const savedNow = (docType: Ticket): TemplateConfig => validateConfig(docType, seedLiteral(docType));
/** One container column of `config`, to change in place. */
const containerField = (config: unknown, key: string) =>
  (config as TemplateConfig).sections.find((s) => s.key === "containers")!.fields.find((f) => f.key === key)!;

it("the line under which a shared column of the ticket's container table has no room is 39 points", () => {
  expect(MIN_SHARED_WIDTH_PT).toBe(39);
});

it("writes a width or a share in points with one decimal, a closing zero dropped", () => {
  expect([pt(54), pt(53.5), pt(53.25), pt(116.04), pt(-32)]).toEqual(["54", "53.5", "53.3", "116", "-32"]);
});

describe.each(TICKETS)("%s: the container table's shared width (#519)", (docType) => {
  it.each<[string, () => TemplateConfig, ReturnType<typeof sharedContainerWidth>]>([
    ["the seed literal", () => read(docType, seedLiteral(docType)), { shared: ["Containers", "Tare"], each: 54, fixedAndPadding: 348 }],
    ["count-hidden", () => read(docType, storedBefore(docType, "count-hidden")), { shared: ["Tare"], each: 116, fixedAndPadding: 332 }],
    ["widths-full", () => read(docType, storedBefore(docType, "widths-full")), { shared: ["Tare"], each: -32, fixedAndPadding: 628 }],
    ["containers-hidden", () => read(docType, storedBefore(docType, "containers-hidden")), null],
    ["saved by this program with Tare stored first, named in the contract's order", () => {
      const config = savedNow(docType);
      const containers = config.sections.find((s) => s.key === "containers")!;
      containers.fields = [
        ...containers.fields.filter((f) => f.key === "container_tare"),
        ...containers.fields.filter((f) => f.key !== "container_tare"),
      ];
      return validateConfig(docType, config);
    }, { shared: ["Containers", "Tare"], each: 54, fixedAndPadding: 348 }],
    ["saved by this program with every column hidden, its section shown", () => {
      const config = savedNow(docType);
      for (const key of ["container_type", "container_count", "container_tare", "cust_cont_id"]) {
        containerField(config, key).visible = false;
      }
      return validateConfig(docType, config);
    }, { shared: [], each: null, fixedAndPadding: 0 }],
  ])("sharedContainerWidth: %s", (_name, config, answer) => {
    expect(sharedContainerWidth(docType, config())).toEqual(answer);
  });

  it("computes each share from the typed widths as stored, while the printed width the editor compares is rounded", () => {
    // 282 − (110.004 + 62 + 32) = 77.996, split two ways: 38.998, under the 39 pt line.
    const stored = storedBefore(docType, "type-width-110");
    containerField(stored, "container_type").width = 110.004;
    const config = read(docType, stored);
    const answer = sharedContainerWidth(docType, config)!;
    expect(answer.each).toBeCloseTo(38.998, 9);
    expect(answer.each!).toBeLessThan(MIN_SHARED_WIDTH_PT);
    expect(answer.fixedAndPadding).toBeCloseTo(408.008, 9);
    expect(tablePrintedWidth(contractFor(docType), config, "containers"))
      .toMatchObject({ declared: 172, overhead: 32, printed: 204, budget: 282, copies: 2 });
    // Every column typed: 80 + 60 + 60 + 50.004 + 32 is 282.004 a half.
    const typed = savedNow(docType);
    for (const [key, width] of [["container_type", 80], ["container_count", 60], ["container_tare", 60], ["cust_cont_id", 50.004]] as const) {
      containerField(typed, key).width = width;
    }
    const all = sharedContainerWidth(docType, validateConfig(docType, typed))!;
    expect(all.each).toBeNull();
    expect(all.fixedAndPadding).toBeCloseTo(564.008, 9);
    expect(all.fixedAndPadding).toBeGreaterThan(564);
  });

  it("computes each share from the table's printed width, on every frozen config", () => {
    const configs: [string, TemplateConfig][] = [
      ["the seed literal", read(docType, seedLiteral(docType))],
      ...storedNames(docType).map((name): [string, TemplateConfig] => [name, read(docType, storedBefore(docType, name))]),
    ];
    let shares = 0;
    for (const [name, config] of configs) {
      const answer = sharedContainerWidth(docType, config);
      const table = tablePrintedWidth(contractFor(docType), config, "containers");
      if (answer === null) {
        expect(table, name).toBeNull();
        continue;
      }
      expect(table, name).not.toBeNull();
      // Close, not equal: the share is computed before the printed width is rounded to two decimals.
      expect(answer.fixedAndPadding, name).toBeCloseTo(table!.copies * table!.printed);
      if (answer.shared.length === 0) {
        expect(answer.each, name).toBeNull();
        continue;
      }
      expect(answer.each, name).toBeCloseTo((table!.budget - table!.printed) / answer.shared.length);
      shares++;
    }
    // Every frozen config but containers-hidden shows a column that shares.
    expect(shares).toBe(configs.length - 1);
  });

  // `sharedWidthMeasured`, the 39 pt line's measured-conditions test, is retired with the flow's 39 pt warning (owner
  // ruling R-A, 2026-11-17, #991).

  it.each<[string, () => TemplateConfig, string]>([
    ["the seed literal", () => read(docType, seedLiteral(docType)), "Containers and Tare get 54 pt each"],
    ["count-hidden, where only Tare shares", () => read(docType, storedBefore(docType, "count-hidden")), "Tare gets 116 pt"],
    ["saved by this program with its Tare column hidden", () => {
      const config = savedNow(docType);
      containerField(config, "container_tare").visible = false;
      return config;
    }, "Containers gets 116 pt"],
    ["Container Type at 81", () => {
      const stored = storedBefore(docType, "type-width-110");
      containerField(stored, "container_type").width = 81;
      return read(docType, stored);
    }, "Containers and Tare get 53.5 pt each"],
  ])("sharedWidthWords: %s", (_name, config, words) => {
    const answer = sharedContainerWidth(docType, config())!;
    expect(sharedWidthWords(answer.shared, answer.each!)).toBe(words);
  });

  it("sharedWidthWords: two decimals under the 39 pt line, never rounded up to it, and one at it and over", () => {
    expect([39, 39.04, 38.95, 38.5, 38.994, 38.998, 0, -0.002].map((each) => sharedWidthWords(["Tare"], each))).toEqual([
      "Tare gets 39 pt", "Tare gets 39 pt", "Tare gets 38.95 pt", "Tare gets 38.5 pt",
      "Tare gets 38.99 pt", "Tare gets 38.99 pt", "Tare gets 0 pt", "Tare gets 0 pt",
    ]);
    expect(sharedWidthWords(["Containers", "Tare"], 38.95)).toBe("Containers and Tare get 38.95 pt each");
  });
});

it("the width arithmetic is a registry-free leaf (the canvas rules read it without a cycle)", () => {
  const core = readFileSync(new URL("../src/lib/printed-width-core.ts", import.meta.url), "utf8");
  const imports = [...core.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((m) => m[1]);
  expect(imports).toEqual(["./template-contracts/types"]);
  expect(core).toContain("export function tableOverhead(");
  expect(core).toContain("export const MIN_SHARED_WIDTH_PT = 39");
});
