import { beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  TEMPLATE_DOC_TYPES, normalizeStoredConfig, type TemplateDocTypeString,
} from "@/lib/template-contracts/index";
import { netWeightCents, weightTotals } from "@/lib/net-weight";
import { prisma, truncateAll, templateId } from "./helpers/db";
import {
  ADDED_BY_WEIGHTS_PAPER, FIRST_SEED_TYPES, STAND_IN_TEXT, builtInLabelsBefore, publishStored, seedLiteral, storedBefore,
  storedNames, withStandInText,
} from "./helpers/stored-configs";
import { cellTexts, tableHeaded, textOf } from "./helpers/definition-text";
import { BINS_14, CEILING_LB, ORDER_1031, ORDER_1032 } from "./helpers/weights-examples";

/**
 * What an install holds in stored templates, frozen before the weights-on-paper pull request
 * changed a contract (the weights design §13.4 and §13.5), and the shared readers in
 * tests/helpers/ written with it.
 *
 * The first block is the one a contract change is held by: every stored config must stay valid
 * under the contracts as they stand. The frozen files do not follow the contracts. The labels
 * file was written once, on 2026-10-11. The configs file was written that day and once more on
 * 2026-10-12, when its text blocks became the stand-in. Neither has been written since. So
 * nothing here compares a frozen config with a contract's defaults: each expected config is
 * built from the seed migration's own literal, with the stand-in in place of the words of each
 * text block. The seed's standing text is the shop's own wording, and no frozen config repeats it.
 */

type Field = { key: string; visible: boolean; label: string | null; width: number | null };
type Section = { key: string; visible: boolean; fields: Field[] };
type Cfg = { sections: Section[] };
type Edit = (c: Cfg) => void;

function sec(c: Cfg, key: string): Section {
  const found = c.sections.find((s) => s.key === key);
  if (found === undefined) throw new Error(`no section "${key}"`);
  return found;
}
function fld(c: Cfg, key: string): Field {
  for (const s of c.sections) {
    const found = s.fields.find((f) => f.key === key);
    if (found !== undefined) return found;
  }
  throw new Error(`no field "${key}"`);
}
/** Puts a section's fields in the order given. The keys must be the section's own, each once. */
function reorder(c: Cfg, section: string, keys: string[]): void {
  const s = sec(c, section);
  if ([...keys].sort().join() !== s.fields.map((f) => f.key).sort().join()) {
    throw new Error(`"${section}" holds ${s.fields.map((f) => f.key).join(", ")}`);
  }
  s.fields = keys.map((key) => s.fields.find((f) => f.key === key)!);
}

const TICKET: Record<string, Edit> = {
  "typed-labels": (c) => { fld(c, "line_pounds").label = "Lbs Shipped"; fld(c, "total_weight").label = "Pounds Shipped:"; },
  "totals-hidden": (c) => { sec(c, "totals").visible = false; },
  "net-row-hidden": (c) => { fld(c, "total_weight").visible = false; },
  "containers-hidden": (c) => { sec(c, "containers").visible = false; },
  "count-hidden": (c) => { fld(c, "container_count").visible = false; },
  "container-columns-moved": (c) => reorder(c, "containers", ["cust_cont_id", "container_type", "container_count"]),
  "totals-rows-moved": (c) => reorder(c, "totals", ["total_weight", "total_qty", "shipped_complete"]),
  "widths-full": (c) => { fld(c, "container_type").width = 110; fld(c, "container_count").width = 110; fld(c, "cust_cont_id").width = 62; },
  "type-width-220": (c) => { fld(c, "container_type").width = 220; },
  "type-width-130": (c) => { fld(c, "container_type").width = 130; },
  "type-width-110": (c) => { fld(c, "container_type").width = 110; },
  "sections-moved": (c) => { c.sections.reverse(); },
};

/** Every frozen config by document type and name, in the file's order: what was done to the
 *  seed literal, as the program completed it, to make it. A typed label here is a pretend
 *  operator's. */
const EDITS: Partial<Record<TemplateDocTypeString, Record<string, Edit>>> = {
  TRAVELER: {
    "typed-labels": (c) => { fld(c, "line_weight").label = "Line Wt"; fld(c, "gross_weight").label = "Gross Wt"; },
    "old-wording-typed": (c) => { fld(c, "gross_weight").label = "Gross Weight"; fld(c, "line_each_weight").label = "Part Weight"; },
    "gross-hidden": (c) => { fld(c, "gross_weight").visible = false; },
    "quantities-hidden": (c) => { sec(c, "quantities").visible = false; },
    "gross-width-50": (c) => { fld(c, "gross_weight").width = 50; },
    "gross-moved-first": (c) => reorder(c, "quantities",
      ["gross_weight", "order_qty", "load_qty", "container", "container_qty", "tare_weight"]),
  },
  SHIPPER: TICKET,
  MOS_SHIPPER: TICKET,
  CERT: {
    "typed-label": (c) => { fld(c, "part_pounds").label = "Lbs"; },
    "weight-hidden": (c) => { fld(c, "part_pounds").visible = false; },
  },
  INVOICE: { "typed-label": (c) => { fld(c, "col_amount").label = "Wt / Price"; } },
  QUOTE: { "typed-label": (c) => { fld(c, "col_amount").label = "Lbs / Price"; } },
  BOL: {
    "typed-label": (c) => { fld(c, "freight_weight").label = "Gross Weight"; },
    "weight-hidden": (c) => { fld(c, "freight_weight").visible = false; },
  },
};

/** The seed literal as the program completed it when the files were frozen. Only the traveler's
 *  differed from its literal: `customer_phone` postdates the seed (`ADDED_AFTER_SEED` in
 *  tests/template-seed.test.ts), and the backfill put it third in the header, shown. Written out
 *  here and not read from a contract, so it stays what it was. */
function completedBefore(docType: TemplateDocTypeString): Cfg {
  const config = seedLiteral(docType) as Cfg;
  if (docType === "TRAVELER") {
    sec(config, "header").fields.splice(2, 0, { key: "customer_phone", visible: true, label: null, width: null });
  }
  return config;
}

const fieldKeys = (config: unknown): string[] =>
  (config as Cfg).sections.flatMap((s) => s.fields.map((f) => f.key));

/** The built-in wording of each label the weights design's §13.2 renames, as its table gives it
 *  under "was". */
const WAS: [TemplateDocTypeString, string, string][] = [
  ["TRAVELER", "line_each_weight", "Part Weight"],
  ["TRAVELER", "line_weight", "Line Weight"],
  ["TRAVELER", "container_qty", "Container Quantity"],
  ["TRAVELER", "tare_weight", "Tare Weight"],
  ["TRAVELER", "gross_weight", "Gross Weight"],
  ...(["SHIPPER", "MOS_SHIPPER"] as const).flatMap((ticket): [TemplateDocTypeString, string, string][] => [
    [ticket, "line_pounds", "Pounds"],
    [ticket, "container_count", "# Of Containers"],
    [ticket, "total_weight", "Pounds Shipped:"],
    [ticket, "tear_total_weight", "Pounds Shipped:"],
  ]),
  ["CERT", "part_pounds", "Pounds"],
  ["INVOICE", "col_amount", "Total Wt / Price"],
  ["QUOTE", "col_amount", "Total Lbs / Price"],
];

describe("stored configs frozen before the weights on paper", () => {
  it("holds exactly the named configs, in the file's order", () => {
    for (const docType of TEMPLATE_DOC_TYPES) {
      expect(storedNames(docType), docType).toEqual(Object.keys(EDITS[docType] ?? {}));
    }
  });

  it("each frozen config is the completed seed literal with stand-in text blocks and its one named edit", () => {
    for (const docType of TEMPLATE_DOC_TYPES) {
      for (const [name, edit] of Object.entries(EDITS[docType] ?? {})) {
        const expected = withStandInText(completedBefore(docType));
        edit(expected);
        expect(storedBefore(docType, name), `${docType}/${name}`).toEqual(expected);
      }
    }
  });

  it("every text block of every frozen config is the stand-in, or empty", () => {
    const otherWords = TEMPLATE_DOC_TYPES.flatMap((docType) => storedNames(docType).flatMap((name) =>
      Object.entries((storedBefore(docType, name) as { textBlocks: Record<string, string> }).textBlocks)
        .filter(([, text]) => text !== STAND_IN_TEXT && text !== "")
        .map(([key]) => `${docType}/${name}: ${key}`)));
    expect(otherWords).toEqual([]);
  });

  it("every seed literal and every frozen config is taken by the contracts as they stand", () => {
    const refused: string[] = [];
    for (const docType of TEMPLATE_DOC_TYPES) {
      const stored: [string, unknown][] = [
        ["the seed literal", seedLiteral(docType)],
        ...storedNames(docType).map((name): [string, unknown] => [name, storedBefore(docType, name)]),
      ];
      for (const [name, config] of stored) {
        try {
          normalizeStoredConfig(docType, config);
        } catch (err) {
          const why = err instanceof ZodError ? err.issues.map((i) => i.message).join("; ") : (err as Error).message;
          refused.push(`${docType}/${name}: ${why}`);
        }
      }
    }
    // Owner ruling R-B (2026-11-17, #991): the two frozen ticket configs whose container columns fill or pass the
    // half's 282 pt before their padding are refused by the printed-width budget; nothing else is. They are this
    // file's fixtures, not stored versions: no install's export held one when R-B landed (the #991 ledger).
    // widths-full shows one flexible column (Tare), type-width-220 two (Containers and Tare): the sentence counts them.
    const halfPast = (columns: string) => 'The "containers" table needs 318.5pt on paper (282pt of column widths each ' +
      `half, 32pt of cell padding, and 4.5pt for its flexible ${columns}), more than the 282pt each half has: its fixed ` +
      "columns alone would print past the page. Narrow or hide a column.";
    expect(refused).toEqual(["SHIPPER", "MOS_SHIPPER"].flatMap((docType) => [
      `${docType}/widths-full: ${halfPast("column")}`, `${docType}/type-width-220: ${halfPast("columns")}`,
    ]));
  });

  it("no frozen config holds a field this pull request adds", () => {
    const held = TEMPLATE_DOC_TYPES.flatMap((docType) => storedNames(docType).flatMap((name) =>
      fieldKeys(storedBefore(docType, name))
        .filter((key) => ADDED_BY_WEIGHTS_PAPER.includes(key))
        .map((key) => `${docType}/${name}: ${key}`)));
    expect(held).toEqual([]);
  });

  it("the added fields are the three of the design", () => {
    // Without this, an emptied list would let the case above pass for nothing.
    expect(ADDED_BY_WEIGHTS_PAPER).toEqual(["container_tare", "total_tare", "total_gross"]);
  });

  it("the frozen labels hold every field the seed literals hold", () => {
    // The frozen labels are the eight first-seed types' (the container tag came after them).
    const missing = FIRST_SEED_TYPES.flatMap((docType) => fieldKeys(seedLiteral(docType))
      .filter((key) => typeof builtInLabelsBefore(docType)[key] !== "string")
      .map((key) => `${docType}: ${key}`));
    expect(missing).toEqual([]);
  });

  it("the frozen labels hold the old wording of every label the design renames", () => {
    expect(WAS.map(([docType, key]) => [docType, key, builtInLabelsBefore(docType)[key]])).toEqual(WAS);
  });

  it("storedBefore throws on a name the file does not hold", () => {
    expect(() => storedBefore("TRAVELER", "no-such-config")).toThrow(/no frozen TRAVELER config is named "no-such-config"/);
  });

  it("storedBefore and seedLiteral hand back a fresh copy each call", () => {
    (storedBefore("CERT", "typed-label") as Cfg).sections.length = 0;
    (seedLiteral("CERT") as Cfg).sections.length = 0;
    expect([
      (storedBefore("CERT", "typed-label") as Cfg).sections.length > 0,
      (seedLiteral("CERT") as Cfg).sections.length > 0,
    ]).toEqual([true, true]);
  });
});

// The two header shapes the in-use travelers store, as the 2026-10-15 exports showed: the seed
// literal's, which devtest's v1 stores, and a frozen traveler's, with customer_phone third, which
// .182's v3 stores.
describe("a stored traveler saved before po_number existed shows it fourth in its header (#518)", () => {
  const HEADER = [
    "customer_name", "received_from", "customer_phone", "po_number", "company_name", "company_address",
    "company_phone", "order_number", "load_number", "barcode",
  ];
  const header = (config: unknown) => sec(normalizeStoredConfig("TRAVELER", config) as Cfg, "header");

  it("the seed literal, which stores no customer_phone either", () => {
    const fields = header(seedLiteral("TRAVELER")).fields;
    expect(fields.map((f) => f.key)).toEqual(HEADER);
    expect(fields[3]).toEqual({ key: "po_number", visible: true, label: null, width: null });
  });

  it("every frozen traveler, each storing customer_phone third", () => {
    expect(storedNames("TRAVELER").length).toBeGreaterThan(0);
    for (const name of storedNames("TRAVELER")) {
      const stored = storedBefore("TRAVELER", name);
      expect(sec(stored as Cfg, "header").fields[2].key, name).toBe("customer_phone");
      const fields = header(stored).fields;
      expect(fields.map((f) => f.key), name).toEqual(HEADER);
      expect(fields[3], name).toEqual({ key: "po_number", visible: true, label: null, width: null });
    }
  });
});

describe("publishStored", () => {
  beforeEach(truncateAll);

  it("stores the config as it is, published, and moves the Standard template's pointer onto it", async () => {
    // The traveler's seed literal has no customer_phone. A save through the editor would add it.
    const literal = seedLiteral("TRAVELER");
    const published = await publishStored("TRAVELER", literal);
    const template = await prisma.documentTemplate.findUniqueOrThrow({
      where: { id: templateId("TRAVELER") }, include: { publishedVersion: true },
    });
    expect(published).toEqual({ templateId: template.id, versionId: template.publishedVersionId });
    expect(template.publishedVersion?.status).toBe("PUBLISHED");
    expect(template.publishedVersion?.config).toEqual(literal);
  });
});

describe("the shared readers of a definition", () => {
  // A hand-made sheet in the builders' shapes: a table with a heading row, and a one-row strip
  // whose heading holds the table's inside a longer one.
  const table = {
    table: {
      widths: [70, "*"],
      body: [
        [{ text: "Quantity", bold: true }, { text: "Weight", bold: true }],
        [{ text: "200" }, { text: "1,280", alignment: "right" }],
      ],
    },
    layout: "ruled",
  };
  const strip = { table: { widths: ["*", 84], body: [[{ text: "Information" }, { text: "Weight / Price", bold: true }]] } };
  const sheet = { stack: [strip, table, { text: "Weight" }] };

  it("cellTexts gives a cell's own lines, top line first", () => {
    const cells: unknown[] = [
      { text: "1,280", alignment: "right" },
      {},
      { alignment: "center", rowSpan: 2, stack: [{ text: "top" }, { text: "" }, { text: "small", fontSize: 6.5, color: "#444444" }] },
      { text: [{ text: "one ", bold: true }, "line"] },
      "1,280 lb",
      1280,
    ];
    expect(cells.map(cellTexts)).toEqual([["1,280"], [], ["top", "", "small"], ["one line"], ["1,280 lb"], ["1280"]]);
  });

  it("tableHeaded finds the one table by a whole heading in its first row", () => {
    expect(tableHeaded(sheet, "Weight")).toEqual({ widths: [70, "*"], body: table.table.body });
  });

  it("tableHeaded throws when two tables hold the heading", () => {
    expect(() => tableHeaded({ stack: [table, table] }, "Quantity")).toThrow(/2 tables are headed "Quantity"/);
  });

  it("tableHeaded throws when no table holds the heading", () => {
    // "1,280" is a cell of the table's second row, never of a first row.
    expect(() => tableHeaded(sheet, "1,280")).toThrow(/0 tables are headed "1,280"/);
  });

  it("textOf joins every text and number, and skips an image", () => {
    expect(textOf({ stack: [{ text: "a" }, { image: "data:image/png;base64,AAAA", width: 186 }, { text: 3 }] }))
      .toBe("a\n186\n3");
  });
});

describe("the example figures", () => {
  it("are frozen with every object and array they hold", () => {
    const held = (value: unknown): object[] =>
      (typeof value === "object" && value !== null ? [value, ...Object.values(value).flatMap(held)] : []);
    const notFrozen = (example: unknown) => held(example).filter((part) => !Object.isFrozen(part)).length;
    expect({
      // What each example holds, itself included: the order, its two lists, and each line and row.
      objects: [held(ORDER_1031).length, held(ORDER_1032).length, held(BINS_14).length],
      notFrozen: [notFrozen(ORDER_1031), notFrozen(ORDER_1032), notFrozen(BINS_14)],
    }).toEqual({ objects: [6, 5, 1], notFrozen: [0, 0, 0] });
  });

  it("are the owner's, by the calculation's own sums", () => {
    const cents = (order: { lines: { weight: number }[]; containers: { count: number; tareEach: number | null }[] }) => {
      const totals = weightTotals({ lineWeights: order.lines.map((l) => l.weight), containers: order.containers });
      return [totals.netCents, totals.tareCents, totals.grossCents];
    };
    expect({
      order1031: cents(ORDER_1031),
      order1032: cents(ORDER_1032),
      bins: cents({ lines: [{ weight: 4128 }], containers: [BINS_14] }),
      linesAreQuantityTimesEach: [...ORDER_1031.lines, ...ORDER_1032.lines]
        .map((l) => netWeightCents(l.qty, l.eachWeight) === Math.round(l.weight * 100)),
      ceiling: cents({ lines: [{ weight: CEILING_LB }], containers: [] })[0],
      pastTheCeiling: cents({ lines: [{ weight: CEILING_LB }, { weight: 0.01 }], containers: [] })[0],
    }).toEqual({
      order1031: [160_000, 12_750, 172_750],
      order1032: [45_000, null, null],
      bins: [412_800, 434_000, 846_800],
      linesAreQuantityTimesEach: [true, true, true, true],
      ceiling: 999_999_999_999,
      pastTheCeiling: null,
    });
  });
});
