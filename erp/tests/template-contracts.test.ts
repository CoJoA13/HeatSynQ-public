import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { barcode, layoutOf, table } from "./helpers/canvas-fixtures";
import { testContract } from "./helpers/test-contract";
import {
  CONTENT_WIDTH,
  NEGATIVE_STYLES,
  TemplateConfigError,
  completeSections,
  configSchema,
  defaultConfig,
  defaultFieldConfig,
  defaultSectionConfig,
  lockedElements,
  validateContractConfig,
  type TemplateConfig,
  type TemplateContract,
  type TemplateDocTypeString,
  TEMPLATE_DOC_TYPES,
} from "@/lib/template-contracts/types";
import {
  BOL_CONTRACT,
  BOL_DEFAULT_CONFIG,
  CERT_CONTRACT,
  CERT_DEFAULT_CONFIG,
  CONTRACTS,
  INVOICE_CONTRACT,
  INVOICE_DEFAULT_CONFIG,
  MOS_SHIPPER_CONTRACT,
  QUOTE_CONTRACT,
  QUOTE_DEFAULT_CONFIG,
  SHIPPER_CONTRACT,
  SHIPPER_DEFAULT_CONFIG,
  STATEMENT_CONTRACT,
  STATEMENT_DEFAULT_CONFIG,
  TRAVELER_CONTRACT,
  TRAVELER_DEFAULT_CONFIG,
  contractFor,
  defaultConfigFor,
  travelerStepsPrintedWidth,
  validateConfig,
} from "@/lib/template-contracts";
import { TRAVELER_CANVAS, TRAVELER_STEP_LAYOUT } from "@/lib/template-contracts/traveler";
import { BOL_CANVAS, BOL_FIRST_TABLE_ROOM, BOL_LEAST_WIDTHS, BOL_ROW_FLOOR } from "@/lib/template-contracts/bol";
import { CANVAS_GRID } from "@/lib/template-contracts/canvas";
import { CERT_CANVAS, CERT_FIRST_TABLE_ROOM, CERT_LEAST_WIDTHS, CERT_ROW_FLOOR } from "@/lib/template-contracts/cert";
import {
  INVOICE_CANVAS, INVOICE_FIRST_TABLE_ROOM, INVOICE_LEAST_WIDTHS, INVOICE_ROW_FLOOR,
} from "@/lib/template-contracts/invoice";
import {
  STATEMENT_CANVAS, STATEMENT_FIRST_TABLE_ROOM, STATEMENT_LEAST_WIDTHS, STATEMENT_ROW_FLOOR,
} from "@/lib/template-contracts/statement";
import {
  QUOTE_CANVAS, QUOTE_FIRST_TABLE_ROOM, QUOTE_LEAST_WIDTHS, QUOTE_ROW_FLOOR,
} from "@/lib/template-contracts/quote";
import {
  canvasFieldKeys, canvasProfile, canvasTablePrintedWidth, defaultTableColumns, leastWidth, profileProblems,
  visibleColumnsWidth,
} from "@/lib/template-canvas";
import { round2, tableOverhead } from "@/lib/printed-width-core";
import { COLUMN_TABLE_LAYOUTS } from "@/lib/template-printed-width";
import { AGING_BUCKET_LABELS } from "@/lib/ar-constants";
import { ORDER_TOTALS_CAPTION } from "@/lib/order-totals";
import { PRICE_SOURCE_LABELS } from "@/lib/invoice-constants";
// Type-only, erased at runtime — the frozen-columns walk pins the invoice contract's field keys
// against the builder's own input type without loading any server module into this pure test.
import type { InvoicePdfData } from "@/server/pdf/invoice";
// The statement's least widths are read from the flow's exported widths (`STATEMENT_WIDTHS`), which
// loads pdf/statement.ts and render.ts with it, and render.ts loads practice-mode.ts, whose
// module-load warm-up fires one read and catches its failure (`.catch`), so this file asks nothing of a
// database itself; under vitest that read reaches erp_test.
import { statementFlowLeastWidths } from "./helpers/statement-flow-widths";

// Pure module, no DB: the Phase 7 template-contract machinery (spec §5.3) — contract-driven zod
// config schemas, the default backfill, locked-element refusal (§5.6), and the 564pt column-width
// guardrail (ruling 3). The FIXTURE contract below exercises the machinery in isolation; the four
// real order-side contracts are tested further down against the builders' own hardcoded values.

const ALPHA_LOCK = "spec §5.6 fixture: alpha prints in a fixed place and cannot be quietly omitted";
const FIELD_LOCK = "spec §5.6 fixture: the locked field is automatic";

const FIXTURE: TemplateContract = {
  docType: "TRAVELER",
  name: "Fixture",
  sections: [
    {
      key: "alpha", name: "Alpha", hideable: false, reorderable: false, lockReason: ALPHA_LOCK,
      fields: [
        {
          key: "a_locked", name: "Locked field", defaultLabel: "Locked", removable: false,
          lockReason: FIELD_LOCK, column: { table: "t", defaultWidth: 100 },
        },
        {
          key: "a_free", name: "Free field", defaultLabel: "Free", removable: true,
          column: { table: "t", defaultWidth: "*" },
        },
      ],
    },
    {
      key: "beta", name: "Beta", hideable: true, reorderable: true,
      fields: [
        {
          key: "b_one", name: "One", defaultLabel: "One", removable: true,
          column: { table: "t", defaultWidth: 200 },
        },
        { key: "b_plain", name: "Plain", defaultLabel: "Plain", removable: true },
      ],
    },
  ],
  textBlocks: [{ key: "fixture_text", name: "Fixture text", defaultText: "The default text." }],
  formats: { thousandsSeparator: true, dateFormat: "YYYY-MM-DD" },
  fonts: { family: "Roboto", baseSize: 8, headingSize: 12, smallSize: 6 },
};

/** A deep JSON copy — "an old stored config" for the backfill tests, and the purity idiom. */
function roundTrip(config: TemplateConfig): TemplateConfig {
  return JSON.parse(JSON.stringify(config)) as TemplateConfig;
}

describe("defaultConfig", () => {
  it("defaults layout to null and backfills it onto a config stored before the key existed", () => {
    expect(defaultConfig(FIXTURE).layout).toBeNull();
    const stored = roundTrip(defaultConfig(FIXTURE)) as Partial<TemplateConfig>;
    delete stored.layout;
    expect(validateContractConfig(FIXTURE, stored)).toEqual(defaultConfig(FIXTURE));
  });
  it("produces a complete config that validates against its own contract, unchanged", () => {
    const config = defaultConfig(FIXTURE);
    expect(validateContractConfig(FIXTURE, config)).toEqual(config);
  });

  it("is plain data — survives JSON round-tripping deep-equal", () => {
    const config = defaultConfig(FIXTURE);
    expect(roundTrip(config)).toEqual(config);
  });

  it("carries every section and field in contract order, visible, with null overrides", () => {
    const config = defaultConfig(FIXTURE);
    expect(config.sections.map((s) => s.key)).toEqual(["alpha", "beta"]);
    expect(config.sections[0].fields).toEqual([
      { key: "a_locked", visible: true, label: null, width: null },
      { key: "a_free", visible: true, label: null, width: null },
    ]);
    expect(config.formats).toEqual({ thousandsSeparator: true, dateFormat: "YYYY-MM-DD" });
    expect(config.fonts).toEqual({ family: "Roboto", baseSize: 8, headingSize: 12, smallSize: 6 });
    expect(config.textBlocks).toEqual({ fixture_text: "The default text." });
    expect(config.logo).toBeNull();
    expect(config.pageFooter).toBe(false);
  });
});

describe("the §5.3 default backfill", () => {
  it("fills a stripped format knob back in from the contract default", () => {
    const old = roundTrip(defaultConfig(FIXTURE));
    delete (old.formats as Record<string, unknown>).thousandsSeparator;
    expect(validateContractConfig(FIXTURE, old).formats.thousandsSeparator).toBe(true);
  });

  it("fills whole absent top-level keys (formats, fonts, textBlocks, logo, pageFooter)", () => {
    const parsed = validateContractConfig(FIXTURE, { sections: defaultConfig(FIXTURE).sections });
    expect(parsed).toEqual(defaultConfig(FIXTURE));
  });

  it("parses {} to the complete default config", () => {
    expect(validateContractConfig(FIXTURE, {})).toEqual(defaultConfig(FIXTURE));
  });

  it("re-inserts a missing section at its contract position with default visibility", () => {
    const old = roundTrip(defaultConfig(FIXTURE));
    old.sections = old.sections.filter((s) => s.key !== "beta");
    const parsed = validateContractConfig(FIXTURE, old);
    expect(parsed.sections.map((s) => s.key)).toEqual(["alpha", "beta"]);
    expect(parsed.sections[1].visible).toBe(true);
    expect(parsed.sections[1].fields.map((f) => f.key)).toEqual(["b_one", "b_plain"]);
  });

  it("re-inserts a missing field at its contract position with defaults", () => {
    const old = roundTrip(defaultConfig(FIXTURE));
    old.sections[1].fields = old.sections[1].fields.filter((f) => f.key !== "b_one");
    const parsed = validateContractConfig(FIXTURE, old);
    expect(parsed.sections[1].fields).toEqual([
      { key: "b_one", visible: true, label: null, width: null },
      { key: "b_plain", visible: true, label: null, width: null },
    ]);
  });

  it("a config stored before a synthetic knob existed picks up the new knob's default", () => {
    // The spec §5.3 evolution case: the contract GROWS a knob after configs were stored. The old
    // config must keep parsing, and the parse must return the new knob's default.
    const old = roundTrip(defaultConfig(FIXTURE));
    const extended: TemplateContract = {
      ...FIXTURE,
      formats: { ...FIXTURE.formats, negativeStyle: "PARENTHESES", priceDecimals: 3 },
    };
    const parsed = validateContractConfig(extended, old);
    expect(parsed.formats.negativeStyle).toBe("PARENTHESES");
    expect(parsed.formats.priceDecimals).toBe(3);
    expect(parsed.formats.thousandsSeparator).toBe(true);
  });

  it("a config stored before a synthetic field existed picks the field up with defaults", () => {
    const old = roundTrip(defaultConfig(FIXTURE));
    const extended: TemplateContract = {
      ...FIXTURE,
      sections: [
        FIXTURE.sections[0],
        {
          ...FIXTURE.sections[1],
          fields: [
            ...FIXTURE.sections[1].fields,
            { key: "b_new", name: "New", defaultLabel: "New", removable: true },
          ],
        },
      ],
    };
    const parsed = validateContractConfig(extended, old);
    expect(parsed.sections[1].fields.map((f) => f.key)).toEqual(["b_one", "b_plain", "b_new"]);
  });

  it("is idempotent: validating a validated config changes nothing", () => {
    const once = validateContractConfig(FIXTURE, {});
    expect(validateContractConfig(FIXTURE, roundTrip(once))).toEqual(once);
  });
});

// The §5.6 belt's OMISSION half (Task 8 pre-step, carried from the Task 7 review): the flag-based
// builder belt can only force entries that are PRESENT — a validator-bypassing config that simply
// omits a locked section/field entry would drop the locked element without tripping any flag.
// `completeSections` is the builder-facing merge every builder resolves its views over: the
// config's entries lead untouched (in config order), and every contract entry missing from the
// config appends after them in contract order with contract defaults. Tasks 9–14 adopt the same
// helper.
describe("completeSections — the §5.6 belt's omission half", () => {
  it("is the identity on a complete config's sections", () => {
    const sections = defaultConfig(FIXTURE).sections;
    expect(completeSections(FIXTURE, sections)).toEqual(sections);
  });

  it("appends an omitted LOCKED section after the config's own entries, with contract defaults", () => {
    // Omitting "alpha" (non-hideable) is the exact shape the flag belt cannot see.
    const sections = defaultConfig(FIXTURE).sections.filter((s) => s.key !== "alpha");
    const merged = completeSections(FIXTURE, sections);
    expect(merged.map((s) => s.key)).toEqual(["beta", "alpha"]);
    expect(merged[1]).toEqual(defaultSectionConfig(FIXTURE.sections[0]));
  });

  it("appends omitted fields inside a present section, preserving the config's leading run", () => {
    const sections = roundTrip(defaultConfig(FIXTURE)).sections;
    // Drop the LOCKED field and reorder what remains — the belt must restore presence without
    // touching the config's own order or overrides.
    sections[0].fields = [{ key: "a_free", visible: true, label: "Renamed", width: 40 }];
    const merged = completeSections(FIXTURE, sections);
    expect(merged[0].fields).toEqual([
      { key: "a_free", visible: true, label: "Renamed", width: 40 },
      defaultFieldConfig(FIXTURE.sections[0].fields[0]),
    ]);
  });

  it("multiple omissions append in CONTRACT order; config entries are never reordered or rewritten", () => {
    const sections = roundTrip(defaultConfig(FIXTURE)).sections;
    // Config carries only beta, hidden — the belt appends alpha but must not flip beta visible.
    const betaOnly = [{ ...sections[1], visible: false }];
    const merged = completeSections(FIXTURE, betaOnly);
    expect(merged.map((s) => s.key)).toEqual(["beta", "alpha"]);
    expect(merged[0].visible).toBe(false);
    // Everything omitted: the whole contract appends in contract order.
    expect(completeSections(FIXTURE, []).map((s) => s.key)).toEqual(["alpha", "beta"]);
  });

  it("passes unknown section keys through untouched — they stay the validator's refusal", () => {
    const stray = { key: "stray", visible: true, fields: [] };
    const merged = completeSections(FIXTURE, [stray, ...defaultConfig(FIXTURE).sections]);
    expect(merged[0]).toEqual(stray);
    expect(merged.map((s) => s.key)).toEqual(["stray", "alpha", "beta"]);
  });
});

describe("locked elements (§5.6)", () => {
  it("refuses hiding a locked section, naming the lock's reason", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    config.sections[0].visible = false;
    expect(() => validateContractConfig(FIXTURE, config)).toThrow(ALPHA_LOCK);
    expect(() => validateContractConfig(FIXTURE, config)).toThrow(TemplateConfigError);
  });

  it("refuses hiding a locked field, naming the lock's reason", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    config.sections[0].fields[0].visible = false;
    expect(() => validateContractConfig(FIXTURE, config)).toThrow(FIELD_LOCK);
  });

  it("refuses reordering a non-reorderable section away from its contract position", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    config.sections.reverse();
    expect(() => validateContractConfig(FIXTURE, config)).toThrow(ALPHA_LOCK);
  });

  it("allows hiding an unlocked section and an unlocked field", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    config.sections[1].visible = false;
    config.sections[0].fields[1].visible = false;
    expect(validateContractConfig(FIXTURE, config).sections[1].visible).toBe(false);
  });

  it("lockedElements lists exactly the locked keys, NAMESPACED by scope, with their reasons", () => {
    // The namespace tightening (Task 1 review carry → Task 17): a section key equal to a field
    // key would otherwise render ambiguous padlocks in the editor. `scope` disambiguates so the
    // editor can key its lookups by (scope, key) — a section-scoped lock never matches a
    // field-scoped one and vice versa.
    expect(lockedElements(FIXTURE)).toEqual([
      { scope: "section", key: "alpha", reason: ALPHA_LOCK },
      { scope: "field", key: "a_locked", reason: FIELD_LOCK },
    ]);
  });
});

describe("section-hide counts as hiding its fields (the Task 1 review carry)", () => {
  // The latent bypass: FIXTURE's alpha section is non-hideable, so hiding it is refused for the
  // SECTION's own sake — but nothing refused hiding a *hideable* section sheltering a
  // non-removable field, which hides the locked field just as thoroughly. Task 1's contracts
  // compensated by pinning such sections non-hideable; the machinery must enforce the pairing.
  const SHELTER_LOCK = "spec §5.6 fixture: the sheltered field is automatic and cannot be hidden";
  const sheltering: TemplateContract = {
    docType: "TRAVELER",
    name: "Sheltering fixture",
    sections: [
      {
        key: "gamma", name: "Gamma", hideable: true, reorderable: true,
        fields: [
          {
            key: "g_locked", name: "Sheltered locked field", defaultLabel: "", removable: false,
            lockReason: SHELTER_LOCK,
          },
          { key: "g_free", name: "Free field", defaultLabel: "Free", removable: true },
        ],
      },
    ],
    textBlocks: [],
    formats: {},
    fonts: { family: "Roboto", baseSize: 8, headingSize: 12, smallSize: 6 },
  };

  it("refuses hiding a hideable section that shelters a non-removable field, quoting the FIELD's lock", () => {
    const config = roundTrip(defaultConfig(sheltering));
    config.sections[0].visible = false;
    expect(() => validateContractConfig(sheltering, config)).toThrow(TemplateConfigError);
    expect(() => validateContractConfig(sheltering, config)).toThrow(SHELTER_LOCK);
    expect(() => validateContractConfig(sheltering, config)).toThrow(/Sheltered locked field/);
  });

  it("the same section hides fine once the contract no longer carries the locked field", () => {
    const unlocked: TemplateContract = {
      ...sheltering,
      sections: [{
        ...sheltering.sections[0],
        fields: sheltering.sections[0].fields.filter((f) => f.key !== "g_locked"),
      }],
    };
    const config = roundTrip(defaultConfig(unlocked));
    config.sections[0].visible = false;
    expect(validateContractConfig(unlocked, config).sections[0].visible).toBe(false);
  });

  it("a hidden hideable section with only removable fields still hides fine (no over-refusal)", () => {
    // FIXTURE's beta section: hideable, both fields removable — the fix must not refuse it.
    const config = roundTrip(defaultConfig(FIXTURE));
    config.sections[1].visible = false;
    expect(validateContractConfig(FIXTURE, config).sections[1].visible).toBe(false);
  });
});

describe("column widths (ruling 3's guardrail)", () => {
  it("refuses visible column widths totalling past the 564pt content width", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    config.sections[0].fields[1].width = 465; // 100 (a_locked default) + 465 + 200 (b_one) = 765
    expect(() => validateContractConfig(FIXTURE, config)).toThrow(`${CONTENT_WIDTH}pt`);
  });

  it("hidden columns do not count against the budget", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    config.sections[1].fields[0].visible = false; // b_one's 200pt leaves the table
    config.sections[0].fields[1].width = 460; // 100 + 460 = 560 <= 564
    expect(validateContractConfig(FIXTURE, config).sections[0].fields[1].width).toBe(460);
  });

  it("a hidden section's columns do not count against the budget", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    config.sections[1].visible = false;
    config.sections[0].fields[1].width = 460;
    expect(validateContractConfig(FIXTURE, config).sections[1].visible).toBe(false);
  });

  it("honors a contract's per-table width budget override", () => {
    const budgeted: TemplateContract = { ...FIXTURE, tableBudgets: { t: 300 } };
    expect(validateContractConfig(budgeted, defaultConfig(budgeted))).toBeTruthy(); // 100 + 200 = 300
    const config = roundTrip(defaultConfig(budgeted));
    config.sections[1].fields[0].width = 201; // 100 + 201 = 301 > 300
    expect(() => validateContractConfig(budgeted, config)).toThrow("300pt");
  });

  it("refuses a width override on a field that is not a table column", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    config.sections[1].fields[1].width = 100; // b_plain has no column membership
    expect(() => validateContractConfig(FIXTURE, config)).toThrow();
  });

  it("refuses a single width past the content width outright", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    config.sections[1].fields[0].width = CONTENT_WIDTH + 1;
    expect(() => validateContractConfig(FIXTURE, config)).toThrow();
  });
});

describe("strictness (§5.3's .strict() at every level)", () => {
  it("refuses an unknown top-level key", () => {
    expect(() => validateContractConfig(FIXTURE, { ...defaultConfig(FIXTURE), zzz: 1 })).toThrow();
  });

  it("refuses an unknown key inside a section entry", () => {
    const config = roundTrip(defaultConfig(FIXTURE)) as unknown as {
      sections: Record<string, unknown>[];
    };
    config.sections[1].zzz = 1;
    expect(() => validateContractConfig(FIXTURE, config)).toThrow(/zzz/);
  });

  it("refuses an unknown section key and an unknown field key", () => {
    const base = defaultConfig(FIXTURE);
    expect(() => validateContractConfig(FIXTURE, {
      ...base, sections: [...base.sections, { key: "gamma", visible: true, fields: [] }],
    })).toThrow(/gamma/);
    const config = roundTrip(base);
    config.sections[1].fields.push({ key: "nope", visible: true, label: null, width: null });
    expect(() => validateContractConfig(FIXTURE, config)).toThrow(/nope/);
  });

  it("refuses a duplicate section entry and a duplicate field entry", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    config.sections.push(roundTrip(defaultConfig(FIXTURE)).sections[1]);
    expect(() => validateContractConfig(FIXTURE, config)).toThrow(/duplicate/i);
    const config2 = roundTrip(defaultConfig(FIXTURE));
    config2.sections[1].fields.push({ key: "b_one", visible: true, label: null, width: null });
    expect(() => validateContractConfig(FIXTURE, config2)).toThrow(/duplicate/i);
  });

  it("refuses an unknown font family (never falls through to a default)", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    (config.fonts as Record<string, unknown>).family = "Comic Sans";
    expect(() => validateContractConfig(FIXTURE, config)).toThrow();
  });

  it("refuses a date format outside the fixed set", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    (config.formats as Record<string, unknown>).dateFormat = "DD.MM.YYYY";
    expect(() => validateContractConfig(FIXTURE, config)).toThrow();
  });

  it("refuses a format knob the contract does not declare", () => {
    // The knob SURFACE is per-contract (spec §5.3): FIXTURE declares no price knob, so a config
    // carrying one is an unknown key, not a silently-accepted no-op.
    const config = roundTrip(defaultConfig(FIXTURE));
    (config.formats as Record<string, unknown>).priceDecimals = 2;
    expect(() => validateContractConfig(FIXTURE, config)).toThrow(/priceDecimals/);
  });

  it("refuses an unknown text-block key", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    (config.textBlocks as Record<string, unknown>).rogue_text = "x";
    expect(() => validateContractConfig(FIXTURE, config)).toThrow(/rogue_text/);
  });

  it("refuses an unknown logo placement and an oversized logo width", () => {
    const base = defaultConfig(FIXTURE);
    expect(() => validateContractConfig(FIXTURE, {
      ...base, logo: { placement: "footer-left", width: 100 },
    })).toThrow();
    expect(() => validateContractConfig(FIXTURE, {
      ...base, logo: { placement: "header-left", width: CONTENT_WIDTH + 1 },
    })).toThrow();
  });

  it("configSchema alone refuses unknown keys too (the editor-side schema)", () => {
    expect(configSchema(FIXTURE).safeParse({ zzz: 1 }).success).toBe(false);
  });
});

describe("override round-trips", () => {
  it("refuses an unknown key inside a layout and keeps a well-formed one through validate → serialize → validate", () => {
    const layout = layoutOf([barcode(), table("steps")]);
    expect(() => validateContractConfig(FIXTURE, { ...defaultConfig(FIXTURE), layout: { ...layout, extra: 1 } })).toThrow(ZodError);
    const once = validateContractConfig(FIXTURE, { ...defaultConfig(FIXTURE), layout });
    expect(validateContractConfig(FIXTURE, roundTrip(once)).layout).toEqual(layout);
  });
  it("label, width, format, font, text, logo and pageFooter overrides survive validate → serialize → validate", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    config.sections[0].fields[0].label = "Renamed";
    config.sections[1].fields[0].width = 150;
    config.formats.thousandsSeparator = false;
    config.formats.dateFormat = "MM/DD/YYYY";
    config.fonts = { family: "Liberation Serif", baseSize: 9, headingSize: 14, smallSize: 5 };
    config.textBlocks.fixture_text = "Overridden text.";
    config.logo = { placement: "header-right", width: 120 };
    config.pageFooter = true;

    const once = validateContractConfig(FIXTURE, config);
    const twice = validateContractConfig(FIXTURE, roundTrip(once));
    expect(twice).toEqual(once);
    expect(twice.sections[0].fields[0].label).toBe("Renamed");
    expect(twice.sections[1].fields[0].width).toBe(150);
    expect(twice.fonts.family).toBe("Liberation Serif");
    expect(twice.logo).toEqual({ placement: "header-right", width: 120 });
    expect(twice.pageFooter).toBe(true);
  });

  it("reordering reorderable sections is preserved", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    // Only beta is reorderable, and alpha is pinned to index 0 — so swap beta's FIELDS instead
    // and keep the section order; both orders must come back exactly as sent.
    config.sections[1].fields.reverse();
    const parsed = validateContractConfig(FIXTURE, config);
    expect(parsed.sections[1].fields.map((f) => f.key)).toEqual(["b_plain", "b_one"]);
  });
});

// ---------------------------------------------------------------------------------------------
// The eight real contracts — the order side (Task 1, from the Phase 3/4 builders) and the
// billing side (Task 2, from the Phase 4–6 builders). Every pinned value below is today's
// hardcoded builder value — a mismatch means the contract drifted from the paper it claims to
// describe.
// ---------------------------------------------------------------------------------------------

const REGISTERED = [
  "TRAVELER", "SHIPPER", "MOS_SHIPPER", "BOL", "CERT", "INVOICE", "STATEMENT", "QUOTE", "CONTAINER_TAG",
] as const;

/** Every field of a contract, flattened, keyed for the sweep assertions. */
function allFields(contract: TemplateContract) {
  return contract.sections.flatMap((s) => s.fields);
}

function columnWidths(contract: TemplateContract, sectionKey: string, table: string) {
  const section = contract.sections.find((s) => s.key === sectionKey);
  return (section?.fields ?? [])
    .filter((f) => f.column?.table === table)
    .map((f) => ({ key: f.key, label: f.defaultLabel, width: f.column?.defaultWidth }));
}

describe("the contract registry", () => {
  it("registers exactly the nine contracts, under their own docTypes", () => {
    expect(Object.keys(CONTRACTS).sort()).toEqual([...REGISTERED].sort());
    for (const docType of REGISTERED) expect(CONTRACTS[docType]?.docType).toBe(docType);
  });

  it("throws a clear error for an unregistered docType — never returns undefined", () => {
    // All eight of §8's types are registered now, so the error path needs a value outside the
    // union — the posting register, spec §2's explicit ninth-document refusal, is the honest cast.
    const notADocType = "POSTING_REGISTER" as TemplateDocTypeString;
    expect(() => contractFor(notADocType)).toThrow(/POSTING_REGISTER/);
    expect(() => validateConfig(notADocType, {})).toThrow(TemplateConfigError);
    expect(() => validateConfig(notADocType, {})).toThrow(/POSTING_REGISTER/);
  });

  it("every registered contract has unique section keys, unique field keys, unique text-block keys", () => {
    for (const docType of REGISTERED) {
      const contract = contractFor(docType);
      const sectionKeys = contract.sections.map((s) => s.key);
      expect(new Set(sectionKeys).size).toBe(sectionKeys.length);
      const fieldKeys = allFields(contract).map((f) => f.key);
      expect(new Set(fieldKeys).size).toBe(fieldKeys.length);
      const textKeys = contract.textBlocks.map((t) => t.key);
      expect(new Set(textKeys).size).toBe(textKeys.length);
    }
  });

  it("every non-hideable section and non-removable field carries a lock reason", () => {
    for (const docType of REGISTERED) {
      const contract = contractFor(docType);
      for (const s of contract.sections) {
        if (!s.hideable || !s.reorderable) expect(s.lockReason, `${docType} ${s.key}`).toBeTruthy();
        for (const f of s.fields) {
          if (!f.removable) expect(f.lockReason, `${docType} ${f.key}`).toBeTruthy();
        }
      }
    }
  });

  it("each DEFAULT_CONFIG validates against its own contract, unchanged, and is plain data", () => {
    for (const docType of REGISTERED) {
      const config = defaultConfigFor(docType);
      expect(validateConfig(docType, config), docType).toEqual(config);
      expect(roundTrip(config), docType).toEqual(config);
      // The quote's builder already prints "Page: N of M" (its footer callback) — golden
      // compatibility means its default reproduces THAT; no other Phase 3–6 paper prints one.
      expect(config.pageFooter, docType).toBe(docType === "QUOTE");
      expect(config.logo, docType).toBeNull();        // no builder prints a logo today
    }
  });
});

describe("the traveler contract", () => {
  it("states the steps table's width on paper: the declared widths, the padding and the rules (#450)", () => {
    expect(travelerStepsPrintedWidth(TRAVELER_DEFAULT_CONFIG.sections))
      .toEqual({ declared: 188, overhead: 25.6, printed: 213.6, flexible: true });
    // Three padded columns and two rule slots, from the figures the PDF layout uses.
    expect(travelerStepsPrintedWidth(TRAVELER_DEFAULT_CONFIG.sections).overhead)
      .toBeCloseTo(3 * 2 * TRAVELER_STEP_LAYOUT.padding + 2 * TRAVELER_STEP_LAYOUT.ruleWidth, 10);
  });

  it("counts a step column a stored config marks hidden, because it prints regardless (#450)", () => {
    const legacy = structuredClone(TRAVELER_DEFAULT_CONFIG);
    const fields = legacy.sections.find((s) => s.key === "steps")!.fields;
    for (const key of ["step_eq", "step_op", "step_date", "step_position"]) {
      fields.find((f) => f.key === key)!.visible = false;
    }
    expect(travelerStepsPrintedWidth(legacy.sections))
      .toEqual({ declared: 188, overhead: 25.6, printed: 213.6, flexible: true });
  });

  it("declares the builder's seven blocks in stack order", () => {
    expect(TRAVELER_CONTRACT.sections.map((s) => s.key)).toEqual([
      "header", "lines", "quantities", "process", "inspections", "steps", "footer",
    ]);
  });

  it("locks the steps section and its typed-field rendering with the §15 Step-fields ruling", () => {
    const steps = TRAVELER_CONTRACT.sections.find((s) => s.key === "steps");
    expect(steps?.hideable).toBe(false);
    expect(steps?.reorderable).toBe(false);
    expect(steps?.lockReason).toMatch(/cannot be quietly omitted/);
    for (const key of ["step_position", "step_code", "step_instruction", "step_values"]) {
      const field = steps?.fields.find((f) => f.key === key);
      expect(field?.removable, key).toBe(false);
      expect(field?.lockReason, key).toMatch(/cannot be quietly omitted/);
    }
  });

  it("locks the barcode (and the header that carries it)", () => {
    const header = TRAVELER_CONTRACT.sections.find((s) => s.key === "header");
    expect(header?.hideable).toBe(false);
    const barcode = header?.fields.find((f) => f.key === "barcode");
    expect(barcode?.removable).toBe(false);
    expect(barcode?.lockReason).toMatch(/barcode/i);
  });

  it("refuses a config that hides the steps, hides the barcode, or moves the steps", () => {
    const hideSteps = roundTrip(TRAVELER_DEFAULT_CONFIG);
    hideSteps.sections[5].visible = false;
    expect(() => validateConfig("TRAVELER", hideSteps)).toThrow(/cannot be quietly omitted/);

    const hideBarcode = roundTrip(TRAVELER_DEFAULT_CONFIG);
    const barcode = hideBarcode.sections[0].fields.find((f) => f.key === "barcode");
    if (barcode) barcode.visible = false;
    expect(() => validateConfig("TRAVELER", hideBarcode)).toThrow(TemplateConfigError);

    const moveSteps = roundTrip(TRAVELER_DEFAULT_CONFIG);
    [moveSteps.sections[5], moveSteps.sections[6]] = [moveSteps.sections[6], moveSteps.sections[5]];
    expect(() => validateConfig("TRAVELER", moveSteps)).toThrow(/reordered/);
  });

  it("reproduces the lines table exactly: labels and [78, *, 78, 88]", () => {
    expect(columnWidths(TRAVELER_CONTRACT, "lines", "lines")).toEqual([
      { key: "line_qty", label: "Part Quantity", width: 78 },
      { key: "line_part", label: "Part Number / Part Name / Description", width: "*" },
      { key: "line_each_weight", label: "Each weight", width: 78 },
      { key: "line_weight", label: "Net weight", width: 88 },
    ]);
  });

  it("reproduces the quantity table exactly: labels and [78, 78, *, 88, 78, 88]", () => {
    expect(columnWidths(TRAVELER_CONTRACT, "quantities", "quantities")).toEqual([
      { key: "order_qty", label: "Order Quantity", width: 78 },
      { key: "load_qty", label: "Load Quantity", width: 78 },
      { key: "container", label: "Container", width: "*" },
      { key: "container_qty", label: "Containers", width: 88 },
      { key: "tare_weight", label: "Tare", width: 78 },
      { key: "gross_weight", label: "Order totals", width: 88 },
    ]);
  });

  it("keeps the gross_weight field's key, flags, table and width, last in its section, and names and heads it Order totals (weights design §13, answer 4)", () => {
    expect(TRAVELER_CONTRACT.sections.find((s) => s.key === "quantities")!.fields.at(-1)).toEqual({
      key: "gross_weight", name: "Order totals", defaultLabel: "Order totals", removable: true,
      column: { table: "quantities", defaultWidth: 88 },
    });
  });

  it("heads that column with the screen table's caption", () => {
    const field = TRAVELER_CONTRACT.sections.flatMap((s) => s.fields).find((f) => f.key === "gross_weight")!;
    expect(field.defaultLabel).toBe(ORDER_TOTALS_CAPTION);
  });

  it("reproduces the inspections table [*, 55, 48, 48, 72, *] and the steps table [16, 62, *, 34, 30, 46]", () => {
    expect(columnWidths(TRAVELER_CONTRACT, "inspections", "inspections").map((c) => c.width))
      .toEqual(["*", 55, 48, 48, 72, "*"]);
    expect(columnWidths(TRAVELER_CONTRACT, "steps", "steps").map((c) => c.width))
      .toEqual([16, 62, "*", 34, 30, 46]);
  });

  it("declares the Process: slot (ruling 4 binds part.processName in a later task)", () => {
    const process = TRAVELER_CONTRACT.sections.find((s) => s.key === "process");
    const slot = process?.fields.find((f) => f.key === "process");
    expect(slot?.defaultLabel).toBe("Process:");
    expect(slot?.removable).toBe(true);
  });

  it("declares today's formats and fonts: grouped thousands, Roboto 8/12/6.5, no date knob", () => {
    expect(TRAVELER_CONTRACT.formats).toEqual({ thousandsSeparator: true });
    expect(TRAVELER_CONTRACT.fonts).toEqual({
      family: "Roboto", baseSize: 8, headingSize: 12, smallSize: 6.5,
    });
    expect(TRAVELER_CONTRACT.textBlocks).toEqual([]);
    // The traveler prints no dates, so a dateFormat knob in its config is an unknown key.
    const config = roundTrip(TRAVELER_DEFAULT_CONFIG);
    (config.formats as Record<string, unknown>).dateFormat = "M/D/YYYY";
    expect(() => validateConfig("TRAVELER", config)).toThrow(/dateFormat/);
  });

  it("refuses a lines-table width total past 564pt through the registry entry point", () => {
    const config = roundTrip(TRAVELER_DEFAULT_CONFIG);
    const linePart = config.sections[1].fields.find((f) => f.key === "line_part");
    if (linePart) linePart.width = 400; // 78 + 400 + 78 + 88 = 644 > 564
    expect(() => validateConfig("TRAVELER", config)).toThrow(/564pt/);
  });

  it("round-trips label and width overrides through validateConfig", () => {
    const config = roundTrip(TRAVELER_DEFAULT_CONFIG);
    const orderNumber = config.sections[0].fields.find((f) => f.key === "order_number");
    if (orderNumber) orderNumber.label = "Order #";
    const lineQty = config.sections[1].fields.find((f) => f.key === "line_qty");
    if (lineQty) lineQty.width = 90;
    const once = validateConfig("TRAVELER", config);
    expect(validateConfig("TRAVELER", roundTrip(once))).toEqual(once);
    expect(once.sections[0].fields.find((f) => f.key === "order_number")?.label).toBe("Order #");
    expect(once.sections[1].fields.find((f) => f.key === "line_qty")?.width).toBe(90);
  });

  it("offers a removable customer phone after the received-from address (spec §7)", () => {
    const header = TRAVELER_CONTRACT.sections.find((s) => s.key === "header")!;
    const keys = header.fields.map((f) => f.key);
    expect(keys.indexOf("customer_phone")).toBe(keys.indexOf("received_from") + 1);
    expect(header.fields.find((f) => f.key === "customer_phone")).toMatchObject({
      name: "Customer phone", defaultLabel: "Ph:", removable: true,
    });
  });

  it("offers a removable purchase order after the customer phone (#518)", () => {
    const header = TRAVELER_CONTRACT.sections.find((s) => s.key === "header")!;
    const keys = header.fields.map((f) => f.key);
    expect(keys.indexOf("po_number")).toBe(keys.indexOf("customer_phone") + 1);
    // The whole field: no column and no lock reason.
    const field = header.fields.find((f) => f.key === "po_number");
    expect(field).toEqual({ key: "po_number", name: "Purchase order", defaultLabel: "PO:", removable: true });
    // The tickets and the cert spell the editor name each in its own contract; only this case
    // holds the four equal.
    const nameIn = (contract: TemplateContract) =>
      contract.sections.flatMap((s) => s.fields).find((f) => f.key === "po_number")?.name;
    expect([SHIPPER_CONTRACT, MOS_SHIPPER_CONTRACT, CERT_CONTRACT].map(nameIn))
      .toEqual([field?.name, field?.name, field?.name]);
  });

  it("names the tempered_results box Notes / comments in the editor only: key and printed default stay (#384)", () => {
    // `name` is what the editor calls the field and never reaches the builder. The key is what
    // stored configs reference, and the default label is live at every print of a version that
    // never relabelled the box (the types.ts header, #103), so neither may change.
    const footer = TRAVELER_CONTRACT.sections.find((s) => s.key === "footer")!;
    expect(footer.fields.find((f) => f.key === "tempered_results")).toMatchObject({
      name: "Notes / comments box", defaultLabel: "TEMPERED RESULTS:",
    });
  });
});

describe("the shipping-ticket contracts", () => {
  it("declares the builder's blocks in stack order", () => {
    expect(SHIPPER_CONTRACT.sections.map((s) => s.key)).toEqual([
      "header", "parties", "field_strip", "lines", "containers", "serials", "liability",
      "totals", "tear_off",
    ]);
  });

  it("MOS shipper starts structurally identical to the shipper — distinct docTypes free to diverge (spec §4.1)", () => {
    expect(MOS_SHIPPER_CONTRACT.docType).toBe("MOS_SHIPPER");
    expect(MOS_SHIPPER_CONTRACT.sections).toEqual(SHIPPER_CONTRACT.sections);
    expect(MOS_SHIPPER_CONTRACT.textBlocks).toEqual(SHIPPER_CONTRACT.textBlocks);
    expect(MOS_SHIPPER_CONTRACT.formats).toEqual(SHIPPER_CONTRACT.formats);
    expect(MOS_SHIPPER_CONTRACT.fonts).toEqual(SHIPPER_CONTRACT.fonts);
    expect(MOS_SHIPPER_CONTRACT.tableBudgets).toEqual(SHIPPER_CONTRACT.tableBudgets);
    expect(MOS_SHIPPER_CONTRACT.canvas).toEqual(SHIPPER_CONTRACT.canvas);
  });

  it("reproduces the field strip [*, *, 110, 70, 85] and lines [70, *, 90] exactly", () => {
    expect(columnWidths(SHIPPER_CONTRACT, "field_strip", "field_strip")).toEqual([
      { key: "po_number", label: "Purchase Order Number", width: "*" },
      { key: "packing_list_no", label: "Packing List No", width: "*" },
      { key: "customer_job_no", label: "Customer Job No", width: 110 },
      { key: "route", label: "Route", width: 70 },
      { key: "carrier", label: "Carrier", width: 85 },
    ]);
    expect(columnWidths(SHIPPER_CONTRACT, "lines", "lines")).toEqual([
      { key: "line_qty", label: "Quantity", width: 70 },
      // Double-spaced exactly as the builder prints it.
      { key: "line_part", label: "Part No.  /  Part Name  /  Part Description", width: "*" },
      { key: "line_pounds", label: "Net weight", width: 90 },
    ]);
  });

  it("gives the folded container table a half-width budget of 282pt", () => {
    expect(columnWidths(SHIPPER_CONTRACT, "containers", "containers")).toEqual([
      { key: "container_type", label: "Container Type", width: 80 },
      { key: "container_count", label: "Containers", width: "*" },
      { key: "container_tare", label: "Tare", width: "*" },
      { key: "cust_cont_id", label: "Cust Cont Id", width: 62 },
    ]);
    expect(SHIPPER_CONTRACT.tableBudgets).toEqual({ containers: 282 });
    const config = roundTrip(SHIPPER_DEFAULT_CONFIG);
    const type = config.sections[4].fields.find((f) => f.key === "container_type");
    if (type) type.width = 221; // 221 + 62 = 283 > 282: the two shared columns count 0
    expect(() => validateConfig("SHIPPER", config)).toThrow(/282pt/);
  });

  it.each([["SHIPPER", SHIPPER_CONTRACT], ["MOS_SHIPPER", MOS_SHIPPER_CONTRACT]] as const)(
    "puts a Tare column that shares width third among the container columns (%s; owner ruling W16)",
    (_docType, contract) => {
      const fields = contract.sections.find((s) => s.key === "containers")!.fields;
      expect(fields.map((f) => f.key))
        .toEqual(["container_type", "container_count", "container_tare", "cust_cont_id"]);
      expect(fields[2]).toEqual({
        key: "container_tare", name: "Tare", defaultLabel: "Tare", removable: true,
        column: { table: "containers", defaultWidth: "*" },
      });
    });

  it("starts shipper_liability_text blank for the shop to configure", () => {
    expect(SHIPPER_CONTRACT.textBlocks.map((t) => t.key)).toEqual(["shipper_liability_text"]);
    expect(SHIPPER_DEFAULT_CONFIG.textBlocks.shipper_liability_text).toBe("");
  });

  it("declares today's formats and fonts: grouped thousands, M/D/YYYY, Roboto 8/16/5.5", () => {
    expect(SHIPPER_CONTRACT.formats).toEqual({ thousandsSeparator: true, dateFormat: "M/D/YYYY" });
    expect(SHIPPER_CONTRACT.fonts).toEqual({
      family: "Roboto", baseSize: 8, headingSize: 16, smallSize: 5.5,
    });
  });

  it("titles the document 'Shipping Ticket' and locks nothing (spec §5.6 locks are traveler-only)", () => {
    const header = SHIPPER_CONTRACT.sections.find((s) => s.key === "header");
    expect(header?.fields.find((f) => f.key === "title")?.defaultLabel).toBe("Shipping Ticket");
    expect(lockedElements(SHIPPER_CONTRACT)).toEqual([]);
    expect(lockedElements(MOS_SHIPPER_CONTRACT)).toEqual([]);
  });

  it.each([["SHIPPER", SHIPPER_CONTRACT], ["MOS_SHIPPER", MOS_SHIPPER_CONTRACT]] as const)(
    "ends Totals with a Tare row and a Gross weight row, directly after the net row: removable, and no column (%s)",
    (_docType, contract) => {
      const fields = contract.sections.find((s) => s.key === "totals")!.fields;
      expect(fields.slice(fields.findIndex((f) => f.key === "total_weight") + 1)).toEqual([
        { key: "total_tare", name: "Tare", defaultLabel: "Tare:", removable: true },
        { key: "total_gross", name: "Gross weight", defaultLabel: "Gross weight:", removable: true },
      ]);
    });
});

describe("the bill-of-lading contract", () => {
  it("declares the builder's blocks in stack order", () => {
    expect(BOL_CONTRACT.sections.map((s) => s.key)).toEqual([
      "header", "carrier", "received", "consigned", "trv", "delivering_carrier", "freight",
      "bottom",
    ]);
  });

  it("carries the eleven UDSBL legal constants as text blocks, transcription quirks intact", () => {
    expect(BOL_CONTRACT.textBlocks.map((t) => t.key)).toEqual([
      "bol_received_text", "bol_property_text", "bol_certifies_text", "bol_section_7_text",
      "bol_no_delivery_text", "bol_imprint_text", "bol_water_note", "bol_value_note",
      "bol_declared_value_text", "bol_liability_note", "bol_fibre_note",
    ]);
    const texts = BOL_DEFAULT_CONFIG.textBlocks;
    expect(texts.bol_received_text.startsWith("RECEIVED, subject to individually determined")).toBe(true);
    expect(texts.bol_property_text).toContain("here under");   // the sample's own spacing, preserved
    expect(texts.bol_property_text).toContain("(I) in Official, Southern, Western");
    expect(texts.bol_imprint_text).toContain("Comerce");        // the sample's own typo, preserved
    expect(texts.bol_liability_note).toContain("49 U.S.C.");
    expect(texts.bol_fibre_note.startsWith("†The fibre boxes")).toBe(true);
    expect(texts.bol_water_note).toContain("carrier's or shipper's weight");
    expect(texts.bol_declared_value_text.endsWith("not exceeding")).toBe(true);
  });

  it("reproduces the freight table [40, *, 62, 44, 42] with its 386pt beside-the-sidebar budget", () => {
    expect(columnWidths(BOL_CONTRACT, "freight", "freight")).toEqual([
      { key: "package_count", label: "No. Packages", width: 40 },
      { key: "freight_description", label: "Kind Of Package, Description of Articles", width: "*" },
      { key: "freight_weight", label: "*Weight (Subject to Correction)", width: 62 },
      { key: "freight_class", label: "Class or Rate", width: 44 },
      { key: "check_column", label: "Check Column", width: 42 },
    ]);
    expect(BOL_CONTRACT.tableBudgets).toEqual({ freight: 386 });
    const config = roundTrip(BOL_DEFAULT_CONFIG);
    const weight = config.sections[6].fields.find((f) => f.key === "freight_weight");
    if (weight) weight.width = 261; // 40 + 261 + 44 + 42 = 387 > 386
    expect(() => validateConfig("BOL", config)).toThrow(/386pt/);
  });

  it("reproduces the form labels exactly — including the spec's own 'Car or Vehicle Initials' spelling", () => {
    const labels = Object.fromEntries(allFields(BOL_CONTRACT).map((f) => [f.key, f.defaultLabel]));
    expect(labels.original_label).toBe("Original - Not Negotiable");
    expect(labels.title).toBe("STRAIGHT BILL OF LADING");
    expect(labels.pro_number).toBe("Carrier's Pro No.");
    expect(labels.bol_number).toBe("Shipper's Bill of Lading No.");
    expect(labels.consignee_ref).toBe("Consignee's Ref/PO No.");
    expect(labels.scac_code).toBe("Carrier's Code (SCAC)");
    expect(labels.carrier_name).toBe("Name of Carrier"); // owner ruling R1, 2026-11-24
    expect(labels.trv_no).toBe("TRV NO.");
    expect(labels.vehicle_initials).toBe("Car or Vehicle Initials");
    expect(labels.collect_checkbox).toBe("CHECK BOX IF COLLECT");
  });

  it("declares today's formats and fonts: grouped thousands, MMM - DD - YYYY, Roboto 7/15/5.5", () => {
    expect(BOL_CONTRACT.formats).toEqual({
      thousandsSeparator: true, dateFormat: "MMM - DD - YYYY",
    });
    expect(BOL_CONTRACT.fonts).toEqual({
      family: "Roboto", baseSize: 7, headingSize: 15, smallSize: 5.5,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The billing-side contracts (Task 2), derived from the Phase 4/5A/5B/6 builders.
// ---------------------------------------------------------------------------------------------

describe("the cert contract", () => {
  it("declares the builder's blocks in stack order", () => {
    expect(CERT_CONTRACT.sections.map((s) => s.key)).toEqual([
      "header", "parties", "parts", "statement", "requirements", "serials", "freeform",
      "signature", "footer",
    ]);
  });

  it("internal no-print notes NEVER appear — no field, no section, no text block offers them", () => {
    // Spec §5.6: "not in the contract at all (nothing to lock — the field list never offers
    // them)". §3.21's other exclusions (min/max/pass/fail/override) are enforced by the
    // builder's INPUT TYPE (CertPdfData carries none of them); the contract must not offer a
    // slot the data layer deliberately never collects.
    const keys = [
      ...CERT_CONTRACT.sections.map((s) => s.key),
      ...allFields(CERT_CONTRACT).map((f) => f.key),
      ...CERT_CONTRACT.textBlocks.map((t) => t.key),
    ];
    const names = [
      ...CERT_CONTRACT.sections.map((s) => s.name),
      ...allFields(CERT_CONTRACT).map((f) => f.name),
    ];
    expect(keys).not.toContain("internal_notes");
    expect(keys).not.toContain("internalNotes");
    for (const text of [...keys, ...names]) {
      expect(text, text).not.toMatch(/internal/i);
    }
  });

  it("starts cert_statement blank for the shop to configure", () => {
    expect(CERT_CONTRACT.textBlocks.map((t) => t.key)).toEqual(["cert_statement"]);
    expect(CERT_DEFAULT_CONFIG.textBlocks.cert_statement).toBe("");
    // The statement renders as its own zero-field section (the shipper liability precedent).
    const statement = CERT_CONTRACT.sections.find((s) => s.key === "statement");
    expect(statement?.fields).toEqual([]);
    expect(statement?.hideable).toBe(true);
  });

  it("reproduces the parts table exactly: labels and [70, *, 90]", () => {
    expect(columnWidths(CERT_CONTRACT, "parts", "parts")).toEqual([
      { key: "part_qty", label: "Quantity", width: 70 },
      // Double-spaced exactly as the builder prints it.
      { key: "part_identity", label: "Part Number  /  Part Name  /  Part Description", width: "*" },
      { key: "part_pounds", label: "Net weight", width: 90 },
    ]);
  });

  it("reproduces the header and parties labels exactly", () => {
    const labels = Object.fromEntries(allFields(CERT_CONTRACT).map((f) => [f.key, f.defaultLabel]));
    expect(labels.title).toBe("Certification");
    expect(labels.order_no).toBe("Order No.:");
    expect(labels.print_date).toBe("Date:");
    expect(labels.entry_date).toBe("Entry Date:");
    expect(labels.to).toBe("To:");
    expect(labels.po_number).toBe("Purchase Order No.:");
    expect(labels.packing_list_no).toBe("Packing List No.:");
    expect(labels.material).toBe("Material:");
    expect(labels.footer_phone).toBe("Phone:");
  });

  it("declares the signature block as a section with its printed pieces (Task 11 consumes)", () => {
    const signature = CERT_CONTRACT.sections.find((s) => s.key === "signature");
    expect(signature?.fields.map((f) => f.key)).toEqual([
      "signature_mark", "signer_name", "signer_title", "signer_company",
    ]);
  });

  it("declares today's formats and fonts: grouped thousands, MM/DD/YYYY, Roboto 9/19/7.5 — and no price knobs", () => {
    expect(CERT_CONTRACT.formats).toEqual({ thousandsSeparator: true, dateFormat: "MM/DD/YYYY" });
    expect(CERT_CONTRACT.fonts).toEqual({
      family: "Roboto", baseSize: 9, headingSize: 19, smallSize: 7.5,
    });
    // No money ever prints on a cert, so the price knobs are off its surface entirely.
    const config = roundTrip(CERT_DEFAULT_CONFIG);
    (config.formats as Record<string, unknown>).priceDecimals = 2;
    expect(() => validateConfig("CERT", config)).toThrow(/priceDecimals/);
  });

  it("locks nothing — the cert's §5.6 protection is omission, not a lock", () => {
    expect(lockedElements(CERT_CONTRACT)).toEqual([]);
  });
});

describe("the invoice contract", () => {
  it("declares the builder's blocks in stack order", () => {
    expect(INVOICE_CONTRACT.sections.map((s) => s.key)).toEqual([
      "header", "identity", "parties", "column_header", "order_strip", "parts", "price",
      "totals", "footer",
    ]);
  });

  // The frozen-columns walk (spec §5.3): every field key maps onto `InvoicePdfData`, the
  // builder's own input — which is built exclusively from the invoice row's FROZEN snapshot
  // columns plus the two sanctioned live identity reads (company / remitTo, spec §4.2: identity,
  // not layout). The map's VALUES are compile-time checked against the type (`satisfies`), so a
  // field claiming a source the data layer does not collect fails `tsc`; the runtime walk fails
  // on any contract key with no entry here — a new field cannot land without naming its source.
  // "(label-only)" marks the fields that print nothing but their own overridable label.
  const INVOICE_FIELD_SOURCE = {
    title: "title",
    company_name: "company",
    invoice_no: "documentNumber",
    invoice_date: "invoiceDate",
    terms: "termsName",
    remit_to: "remitTo",
    bill_to: "billTo",
    ship_to: "shipTo",
    col_qty: "(label-only)",
    col_info: "(label-only)",
    col_each_weight: "(label-only)",
    col_amount: "(label-only)",
    our_order_no: "orderNumber",
    your_po: "poNumber",
    material: "materialName",
    process: "processNames",
    parts_heading: "(label-only)",
    part_qty: "parts",
    part_identity: "parts",
    part_each_weight: "parts",
    part_total_weight: "parts",
    price_heading: "(label-only)",
    price_description: "priceRows",
    price_amount: "priceRows",
    quote_source: "priceRows",
    price_per: "priceRows",
    minimum_charge: "priceRows",
    setup_charge: "priceRows",
    subtotal: "subtotal",
    surcharge_rows: "surchargeRows",
    charge_rows: "chargeRows",
    cert_row: "certRow",
    freight_row: "freightRow",
    tax_row: "taxRow",
    total: "total",
    footer_address: "company",
    footer_contact: "(label-only)",
    footer_phone: "company",
  } as const satisfies Record<string, keyof InvoicePdfData | "(label-only)">;

  it("every field maps to a frozen InvoicePdfData source — and only to one", () => {
    const contractKeys = allFields(INVOICE_CONTRACT).map((f) => f.key).sort();
    expect(contractKeys).toEqual(Object.keys(INVOICE_FIELD_SOURCE).sort());
  });

  it("reproduces the column-header strip exactly: labels and [52, *, 66, 84]", () => {
    expect(columnWidths(INVOICE_CONTRACT, "column_header", "columns")).toEqual([
      { key: "col_qty", label: "Quantity", width: 52 },
      {
        key: "col_info",
        label: "Order Information / Part No. / Description / Pricing Information", width: "*",
      },
      { key: "col_each_weight", label: "Each weight", width: 66 },
      { key: "col_amount", label: "Net weight / Price", width: 84 },
    ]);
  });

  it("reproduces the form labels exactly", () => {
    const labels = Object.fromEntries(allFields(INVOICE_CONTRACT).map((f) => [f.key, f.defaultLabel]));
    expect(labels.invoice_no).toBe("Invoice No.:");
    expect(labels.invoice_date).toBe("Invoice Date:");
    expect(labels.terms).toBe("Terms:");
    expect(labels.remit_to).toBe("Remit To");
    expect(labels.bill_to).toBe("Billto:");   // the sample's own spelling
    expect(labels.ship_to).toBe("Shipto:");   // the sample's own spelling
    expect(labels.our_order_no).toBe("Our Order #:");
    expect(labels.your_po).toBe("Your PO #:");
    expect(labels.material).toBe("Material:");
    expect(labels.process).toBe("Process:");
    expect(labels.parts_heading).toBe("PARTS");
    expect(labels.price_heading).toBe("PRICE");
    // Referenced from PRICE_SOURCE_LABELS.QUOTE (invoice-constants.ts), never a duplicated
    // string — the statement's AGING_BUCKET_LABELS anti-drift rule (Task 2 review carry).
    expect(labels.quote_source).toBe(PRICE_SOURCE_LABELS.QUOTE);
    expect(labels.quote_source).toBe("Quote");
    expect(labels.price_per).toBe("Price per");
    expect(labels.minimum_charge).toBe("Minimum Charge:");
    expect(labels.setup_charge).toBe("Setup Charge:");
    expect(labels.subtotal).toBe("Sub Total Amount:");
    expect(labels.total).toBe("Total Amount Due:");
    expect(labels.footer_contact).toBe("Contact: Accounts Receivable");
    expect(labels.title).toBe("");            // "Invoice" / "Credit" is DATA (the row's own kind)
  });

  it("declares ruling 3's negative style — today's $-937.44 (sign after symbol) as the default of a three-option picker", () => {
    // 5A's ruling: the sign sits between the "$" and the digits. Credits are covered by this
    // contract (spec §4.1) — a credit's negative amounts are what this knob formats.
    expect(NEGATIVE_STYLES).toEqual(["SIGN_AFTER_SYMBOL", "LEADING_MINUS", "PARENTHESES"]);
    expect(INVOICE_CONTRACT.formats).toEqual({
      negativeStyle: "SIGN_AFTER_SYMBOL", priceDecimals: 2, thousandsSeparator: true,
      dateFormat: "MMMM D, YYYY",
    });
  });

  it("the negative-style knob is editable and an unknown style is refused", () => {
    const config = roundTrip(INVOICE_DEFAULT_CONFIG);
    config.formats.negativeStyle = "PARENTHESES";
    const once = validateConfig("INVOICE", config);
    expect(once.formats.negativeStyle).toBe("PARENTHESES");
    expect(validateConfig("INVOICE", roundTrip(once))).toEqual(once);
    (config.formats as Record<string, unknown>).negativeStyle = "RED_INK";
    expect(() => validateConfig("INVOICE", config)).toThrow();
  });

  it("declares today's fonts (Roboto 9/20/7.5), no text blocks, and no locks", () => {
    expect(INVOICE_CONTRACT.fonts).toEqual({
      family: "Roboto", baseSize: 9, headingSize: 20, smallSize: 7.5,
    });
    expect(INVOICE_CONTRACT.textBlocks).toEqual([]);
    expect(lockedElements(INVOICE_CONTRACT)).toEqual([]);
  });
});

describe("the statement contract", () => {
  it("declares the builder's blocks in stack order — the finance-charge line and aging strip are sections", () => {
    expect(STATEMENT_CONTRACT.sections.map((s) => s.key)).toEqual([
      "header", "identity", "open_items", "aging", "finance_charge", "total",
    ]);
    const financeCharge = STATEMENT_CONTRACT.sections.find((s) => s.key === "finance_charge");
    expect(financeCharge?.hideable).toBe(true);
    expect(financeCharge?.fields.map((f) => f.key)).toEqual(["finance_charge"]);
    expect(STATEMENT_CONTRACT.sections.find((s) => s.key === "aging")?.hideable).toBe(true);
  });

  it("takes the aging labels from ar-constants — the lib constant, never a duplicated string", () => {
    const labels = Object.fromEntries(allFields(STATEMENT_CONTRACT).map((f) => [f.key, f.defaultLabel]));
    expect(labels.aging_current).toBe(AGING_BUCKET_LABELS.CURRENT);
    expect(labels.aging_1_30).toBe(AGING_BUCKET_LABELS.D1_30);
    expect(labels.aging_31_60).toBe(AGING_BUCKET_LABELS.D31_60);
    expect(labels.aging_61_90).toBe(AGING_BUCKET_LABELS.D61_90);
    expect(labels.aging_90_plus).toBe(AGING_BUCKET_LABELS.D90_PLUS);
    expect(labels.aging_unapplied).toBe("Unapplied");
    expect(labels.aging_net).toBe("Net");
    // The en-dash labels ("1–30") come from the constant — pin one so a duplicated ASCII "1-30"
    // can never sneak in.
    expect(labels.aging_1_30).toBe("1–30");
  });

  it("the aging strip's seven columns are all flex-width, exactly today's Array(7).fill('*')", () => {
    const widths = columnWidths(STATEMENT_CONTRACT, "aging", "aging").map((c) => c.width);
    expect(widths).toEqual(["*", "*", "*", "*", "*", "*", "*"]);
  });

  it("the open-items columns carry no width knob — the builder's auto widths are its own (the process-row precedent)", () => {
    const openItems = STATEMENT_CONTRACT.sections.find((s) => s.key === "open_items");
    expect(openItems?.fields.map((f) => f.key)).toEqual([
      "document_no", "date", "due_date", "original", "open",
    ]);
    for (const f of openItems?.fields ?? []) expect(f.column, f.key).toBeUndefined();
  });

  it("reproduces the form labels exactly", () => {
    const labels = Object.fromEntries(allFields(STATEMENT_CONTRACT).map((f) => [f.key, f.defaultLabel]));
    expect(labels.title).toBe("Statement");
    expect(labels.customer).toBe("Customer:");
    expect(labels.statement_date).toBe("Statement Date:");
    expect(labels.bill_to).toBe("Bill To");
    expect(labels.remit_to).toBe("Remit To");
    expect(labels.document_no).toBe("Document #");
    expect(labels.date).toBe("Date");
    expect(labels.due_date).toBe("Due Date");
    expect(labels.original).toBe("Original");
    expect(labels.open).toBe("Open");
    // #162 — informational by owner ruling: the figure is shown, never levied, and Total Due
    // (printed directly beneath it) excludes it. The default label says both, because that is what
    // every stored config re-resolves to at print time.
    expect(labels.finance_charge).toBe("Finance Charge (not billed, not in total):");
    expect(labels.total_due).toBe("Total Due:");
  });

  it("declares today's formats and fonts — negative money prints on credit/payment rows, so the style knob is on", () => {
    expect(STATEMENT_CONTRACT.formats).toEqual({
      negativeStyle: "SIGN_AFTER_SYMBOL", priceDecimals: 2, thousandsSeparator: true,
      dateFormat: "MMMM D, YYYY",
    });
    expect(STATEMENT_DEFAULT_CONFIG.formats).toEqual(STATEMENT_CONTRACT.formats);
    expect(STATEMENT_CONTRACT.fonts).toEqual({
      family: "Roboto", baseSize: 9, headingSize: 20, smallSize: 9,
    });
    expect(STATEMENT_CONTRACT.textBlocks).toEqual([]);
    expect(lockedElements(STATEMENT_CONTRACT)).toEqual([]);
  });
});

describe("the quote contract", () => {
  it("declares the builder's blocks in stack order", () => {
    expect(QUOTE_CONTRACT.sections.map((s) => s.key)).toEqual([
      "header", "parties", "intro", "column_header", "lines", "closing", "liability",
    ]);
  });

  it("pageFooter defaults TRUE for the quote alone — its builder already prints 'Page: N of M'", () => {
    expect(QUOTE_DEFAULT_CONFIG.pageFooter).toBe(true);
    // The §5.3 backfill must agree with DEFAULT_CONFIG by construction: an empty stored config
    // parses to pageFooter true here, false everywhere else.
    expect(validateConfig("QUOTE", {}).pageFooter).toBe(true);
    expect(validateConfig("INVOICE", {}).pageFooter).toBe(false);
    // And it stays a knob — a template may turn it off.
    const config = roundTrip(QUOTE_DEFAULT_CONFIG);
    config.pageFooter = false;
    expect(validateConfig("QUOTE", config).pageFooter).toBe(false);
  });

  it("prices default to 4 decimals (money4 — ruling Q7's accepted deviation as the default, now editable)", () => {
    expect(QUOTE_CONTRACT.formats.priceDecimals).toBe(4);
    expect(QUOTE_DEFAULT_CONFIG.formats.priceDecimals).toBe(4);
    const config = roundTrip(QUOTE_DEFAULT_CONFIG);
    config.formats.priceDecimals = 2;
    expect(validateConfig("QUOTE", config).formats.priceDecimals).toBe(2);
  });

  it("carries quote_intro_text and quote_liability_text as text blocks with the settings code defaults copied", () => {
    expect(QUOTE_CONTRACT.textBlocks.map((t) => t.key)).toEqual([
      "quote_intro_text", "quote_liability_text",
    ]);
    expect(QUOTE_DEFAULT_CONFIG.textBlocks.quote_intro_text).toBe(
      "We are pleased to provide you with the following quotation:",
    );
    // The liability block SHIPS EMPTY (the owner keys the shop's wording) — an empty default is
    // today's paper: the builder omits the strip entirely when the text is "".
    expect(QUOTE_DEFAULT_CONFIG.textBlocks.quote_liability_text).toBe("");
    // Both render through zero-field sections (the shipper liability precedent).
    expect(QUOTE_CONTRACT.sections.find((s) => s.key === "intro")?.fields).toEqual([]);
    expect(QUOTE_CONTRACT.sections.find((s) => s.key === "liability")?.fields).toEqual([]);
  });

  it("reproduces the column-header strip exactly: labels and [52, *, 66, 84]", () => {
    expect(columnWidths(QUOTE_CONTRACT, "column_header", "columns")).toEqual([
      { key: "col_qty", label: "Quantity", width: 52 },
      { key: "col_info", label: "Part No. / Description / Pricing Information", width: "*" },
      { key: "col_each_weight", label: "Each weight", width: 66 },
      { key: "col_amount", label: "Net weight / Price", width: 84 },
    ]);
  });

  it("reproduces the form labels exactly — including the quote's own lowercase charge labels", () => {
    const labels = Object.fromEntries(allFields(QUOTE_CONTRACT).map((f) => [f.key, f.defaultLabel]));
    expect(labels.title).toBe("Quotation");
    expect(labels.quote_number).toBe("Quotation Number:");
    expect(labels.attn).toBe("Attn:");
    expect(labels.company_phone).toBe("Phone:");
    expect(labels.effective).toBe("Effective:");
    expect(labels.expires).toBe("Expires On:");
    expect(labels.terms).toBe("Terms:");
    expect(labels.rfq_number).toBe("Your R.F.Q. Number:");
    expect(labels.customer_phone).toBe("Your Phone No.:");
    expect(labels.material).toBe("Material:");
    expect(labels.price_heading).toBe("PRICE");
    // The invoice prints "Setup Charge:" / "Minimum Charge:"; the quote's builder prints these
    // lowercase — preserved exactly, per document.
    expect(labels.setup_charge).toBe("Setup charge:");
    expect(labels.minimum_charge).toBe("Minimum charge:");
    expect(labels.price_per).toBe("Price per");
    expect(labels.breaks).toBe("or more:");
  });

  it("declares today's formats and fonts — no negative money ever prints, so no negativeStyle knob", () => {
    expect(QUOTE_CONTRACT.formats).toEqual({
      priceDecimals: 4, thousandsSeparator: true, dateFormat: "MM/DD/YYYY",
    });
    const config = roundTrip(QUOTE_DEFAULT_CONFIG);
    (config.formats as Record<string, unknown>).negativeStyle = "PARENTHESES";
    expect(() => validateConfig("QUOTE", config)).toThrow(/negativeStyle/);
    expect(QUOTE_CONTRACT.fonts).toEqual({
      family: "Roboto", baseSize: 9, headingSize: 20, smallSize: 6.5,
    });
    expect(lockedElements(QUOTE_CONTRACT)).toEqual([]);
  });
});

describe("the weight words of the contracts (the weights design §13.2: owner ruling W14, and answer 11 of 2026-10-11)", () => {
  // [document type, field key, the editor's name, the built-in label]. A row holds both, the
  // half this change left as it was included.
  const WORDS: [docType: TemplateDocTypeString, key: string, name: string, defaultLabel: string][] = [
    ["TRAVELER", "line_each_weight", "Each weight", "Each weight"],
    ["TRAVELER", "line_weight", "Net weight", "Net weight"],
    ["TRAVELER", "container_qty", "Containers", "Containers"],
    ["TRAVELER", "tare_weight", "Tare", "Tare"],
    ...(["SHIPPER", "MOS_SHIPPER"] as const).flatMap((docType): [TemplateDocTypeString, string, string, string][] => [
      [docType, "line_pounds", "Net weight", "Net weight"],
      [docType, "container_count", "Containers", "Containers"],
      [docType, "total_weight", "Net weight", "Net weight:"],
      [docType, "tear_total_weight", "Net weight", "Net weight:"],
    ]),
    ["CERT", "part_pounds", "Net weight", "Net weight"],
    ["INVOICE", "col_each_weight", "Each weight column", "Each weight"],
    ["INVOICE", "col_amount", "Amount column", "Net weight / Price"],
    ["INVOICE", "part_total_weight", "Net weight", ""],
    ["QUOTE", "col_each_weight", "Each weight column", "Each weight"],
    ["QUOTE", "col_amount", "Amount column", "Net weight / Price"],
    ["QUOTE", "line_total_lbs", "Net weight", ""],
    ["BOL", "freight_weight", "Gross or net weight", "*Weight (Subject to Correction)"],
  ];

  it.each(WORDS)("[%s] %s: the editor names it %j and its built-in label is %j", (docType, key, name, defaultLabel) => {
    const field = allFields(contractFor(docType)).find((f) => f.key === key);
    expect({ name: field?.name, defaultLabel: field?.defaultLabel }).toEqual({ name, defaultLabel });
  });
});

describe("the canvas profile (design 2026-11-08 §4.1)", () => {
  it("the traveler declares its four tables, its two required items, a barcode and the step layout's floors", () => {
    expect(TRAVELER_CONTRACT.canvas).toEqual(TRAVELER_CANVAS);
    expect(TRAVELER_CANVAS.tables.map((t) => t.key)).toEqual(["lines", "quantities", "inspections", "steps"]);
    expect(TRAVELER_CANVAS.required).toEqual([
      { kind: "barcode", reason: "every traveler prints one (spec §8)" },
      { kind: "table", key: "steps", reason: "every traveler prints its steps (spec §5.6)" },
    ]);
    expect(TRAVELER_CANVAS.rowFloor).toBe(24);
    expect(TRAVELER_CANVAS.firstTableRoom).toBe(54);
    expect(TRAVELER_CANVAS.boxedFields).toEqual([]);
    expect(TRAVELER_CANVAS.leastWidths).toEqual({});
    expect(TRAVELER_CANVAS.tables.map((t) => t.keyed)).toEqual(["section", "section", "section", "section"]);
  });
  it("both shipping tickets box their Sold To and Ship To fields", () => {
    expect(SHIPPER_CONTRACT.canvas?.boxedFields).toEqual(["sold_to", "ship_to"]);
    expect(MOS_SHIPPER_CONTRACT.canvas?.boxedFields).toEqual(["sold_to", "ship_to"]);
    // The totals' one fixed 260 pt column and one grid step (#971, owner ruling 6 and the controller's call C1).
    expect(SHIPPER_CONTRACT.canvas?.leastWidths).toEqual({ totals: 264.5 });
    expect(MOS_SHIPPER_CONTRACT.canvas?.leastWidths).toEqual({ totals: 264.5 });
  });
  it("the traveler and both tickets draw no field on a rule (design 2026-11-09 §4.1)", () => {
    expect(TRAVELER_CANVAS.ruledFields).toEqual([]);
    expect(SHIPPER_CONTRACT.canvas?.ruledFields).toEqual([]);
    expect(MOS_SHIPPER_CONTRACT.canvas?.ruledFields).toEqual([]);
  });
  it("the traveler and the tickets carry no beside, toggles or text blocks (design 2026-11-09 §11)", () => {
    for (const contract of [TRAVELER_CONTRACT, SHIPPER_CONTRACT, MOS_SHIPPER_CONTRACT]) {
      for (const spec of contract.canvas!.tables) {
        expect(Object.hasOwn(spec, "toggles")).toBe(false);
        expect(Object.hasOwn(spec, "textBlocks")).toBe(false);
        if (spec.printed !== null) expect(Object.hasOwn(spec.printed, "beside")).toBe(false);
      }
    }
  });
  it("every profile names contract sections as its tables, contract fields as headings and notFields, and a rows block's section has no column", () => {
    for (const docType of TEMPLATE_DOC_TYPES) {
      const contract = contractFor(docType);
      const profile = contract.canvas;
      if (profile === undefined) continue;
      // What a profile must hold, per its tables' `keyed` (design 2026-11-09 §4.1 addition 1).
      expect(profileProblems(contract)).toEqual([]);
      const fields = contract.sections.flatMap((s) => s.fields);
      for (const t of profile.tables) {
        if (t.heading !== null) expect(fields.some((f) => f.key === t.heading)).toBe(true);
        if (t.rows) expect(contract.sections.find((s) => s.key === t.key)!.fields.every((f) => f.column === undefined)).toBe(true);
        if (t.printed !== null && t.printed.kind !== "steps") expect(COLUMN_TABLE_LAYOUTS[docType][t.columnTable ?? t.key]).toEqual({ kind: t.printed.kind, copies: t.printed.copies });
      }
      for (const key of profile.notFields) expect(fields.some((f) => f.key === key)).toBe(true);
      // A boxed field is a contract field the canvas places as a field item: no table column.
      for (const key of profile.boxedFields) {
        const f = fields.find((field) => field.key === key);
        expect(f).toBeDefined();
        expect(f?.column).toBeUndefined();
        expect(profile.notFields).not.toContain(key);
      }
    }
  });
  it("a document with no profile offers no canvas", () => {
    // The stub (tests/helpers/test-contract.ts): a contract with no profile, and no `canvas` key at all.
    expect(testContract().canvas).toBeUndefined();
    expect(Object.hasOwn(testContract(), "canvas")).toBe(false);
    expect(() => canvasProfile(testContract())).toThrow("The Test template offers no canvas; it keeps its sections.");
  });
  it("the bill of lading's profile (design 2026-11-09 §4.1)", () => {
    expect(BOL_CONTRACT.canvas).toEqual(BOL_CANVAS);
    expect(BOL_CANVAS.tables.map((t) => t.key)).toEqual(["consignee_ref", "trv", "freight"]);
    expect(BOL_CANVAS.tables.map((t) => t.keyed)).toEqual(["field", "section", "section"]);
    expect(BOL_CANVAS.required).toEqual([]);
    expect(BOL_CANVAS.barcode).toBe(false);
    expect(BOL_CANVAS.notFields).toEqual(["consignee_ref", "trv_no", "collect_checkbox"]);
    expect(BOL_CANVAS.rowFloor).toBe(BOL_ROW_FLOOR);
    expect(BOL_CANVAS.firstTableRoom).toBe(BOL_FIRST_TABLE_ROOM);
    // Each family's fixed columns and gaps in bol.ts, plus one grid step for the part that takes the rest.
    expect(BOL_LEAST_WIDTHS).toEqual({
      pro_number: 110 + 4 + CANVAS_GRID, bol_number: 110 + 4 + CANVAS_GRID,
      scac_code: 110 + 4 + CANVAS_GRID, consignee_ref: 110 + 4 + CANVAS_GRID,
      destination: 70 + 4 + CANVAS_GRID, destination_state: 16 + 4 + CANVAS_GRID, destination_zip: 18 + 4 + CANVAS_GRID,
      delivering_carrier: 80 + 4 + CANVAS_GRID, vehicle_initials: 105 + 4 + CANVAS_GRID, vehicle_no: 22 + 4 + CANVAS_GRID,
      shipper_per: 60 + 6 + CANVAS_GRID, agent_per: 60 + 6 + CANVAS_GRID, po_address: 165 + 4 + CANVAS_GRID,
      carrier_name: 70 + 4 + CANVAS_GRID,
      consigned_to: 70 + 4 + 180 + 4 + CANVAS_GRID,
      trv: 55 + CANVAS_GRID,
    });
    expect(BOL_CANVAS.leastWidths).toBe(BOL_LEAST_WIDTHS);
    // The freight block keeps its sidebar and gap beside its columns: what the flow's budget leaves.
    const freight = BOL_CANVAS.tables.find((t) => t.key === "freight")!;
    expect(freight.printed).toEqual({
      kind: "boxed", copies: 1, beside: CONTENT_WIDTH - BOL_CONTRACT.tableBudgets!.freight,
      // Its headings at 6.5 pt, the description's second line the builder's own (#971 design §7.2).
      head: { size: 6.5, words: { freight_description: "Special Marks, and Exceptions" } },
    });
    expect(CONTENT_WIDTH - BOL_CONTRACT.tableBudgets!.freight).toBe(178);
    expect(freight.toggles).toEqual(["collect_checkbox"]);
    expect(freight.textBlocks).toEqual(["bol_section_7_text", "bol_no_delivery_text", "bol_imprint_text"]);
    // The fourteen fields the stage draws on a rule (owner ruling (a), 2026-11-10): the form and
    // write-in rules beside their label, the carrier's name over its rule, the consignee on two lines.
    expect(BOL_CANVAS.ruledFields.map((r) => r.key).sort()).toEqual([
      "agent_per", "bol_number", "carrier_name", "consigned_to", "delivering_carrier", "destination",
      "destination_state", "destination_zip", "po_address", "pro_number", "scac_code", "shipper_per",
      "vehicle_initials", "vehicle_no",
    ]);
    expect(profileProblems(BOL_CONTRACT)).toEqual([]);
  });
  it("the certification's profile (design 2026-11-10 §4.1)", () => {
    expect(CERT_CONTRACT.canvas).toEqual(CERT_CANVAS);
    expect(CERT_CANVAS.tables.map((t) => t.key)).toEqual(["to", "parts", "statement", "requirements", "serials", "freeform", "signature"]);
    expect(CERT_CANVAS.tables.map((t) => t.keyed)).toEqual(["field", "section", "section", "section", "section", "section", "section"]);
    expect(CERT_CANVAS.tables.map((t) => t.rows)).toEqual([false, false, false, true, false, false, true]);
    // The To block is headed by its own field and the serials by their label; no other block takes a heading.
    expect(CERT_CANVAS.tables.map((t) => t.heading)).toEqual(["to", null, null, null, "serials", null, null]);
    // Only the part lines print columns, ruled, once.
    expect(CERT_CANVAS.tables.map((t) => t.printed)).toEqual([null, { kind: "ruled", copies: 1, head: { size: "base" } }, null, null, null, null, null]);
    expect(CERT_CANVAS.required).toEqual([]);
    expect(CERT_CANVAS.barcode).toBe(false);
    expect(CERT_CANVAS.boxedFields).toEqual([]);
    expect(CERT_CANVAS.ruledFields).toEqual([]);
    expect(CERT_CANVAS.notFields).toEqual([
      "to", "part_heading", "spec_line", "readings", "serials", "freeform",
      "signature_mark", "signer_name", "signer_title", "signer_company",
    ]);
    // The To box's city, state and zip columns with their two 10 pt gaps, and the signature's image
    // fit, each plus one grid step.
    expect(CERT_LEAST_WIDTHS).toEqual({ to: 120 + 40 + 60 + 2 * 10 + CANVAS_GRID, signature: 220 + CANVAS_GRID });
    expect(CERT_CANVAS.leastWidths).toBe(CERT_LEAST_WIDTHS);
    expect(CERT_CANVAS.rowFloor).toBe(CERT_ROW_FLOOR);
    expect(CERT_CANVAS.firstTableRoom).toBe(CERT_FIRST_TABLE_ROOM);
    expect(CERT_CANVAS.tables.find((t) => t.key === "statement")!.textBlocks).toEqual(["cert_statement"]);
    expect([...canvasFieldKeys(CERT_CONTRACT)]).toEqual([
      "company_name", "title", "order_no", "print_date", "entry_date", "po_number", "packing_list_no", "material",
      "footer_address", "footer_phone",
    ]);
    expect(profileProblems(CERT_CONTRACT)).toEqual([]);
  });
  it("the invoice's profile (design 2026-11-10 §4.1)", () => {
    expect(INVOICE_CONTRACT.canvas).toEqual(INVOICE_CANVAS);
    const tables = INVOICE_CANVAS.tables;
    expect(tables.map((t) => t.key)).toEqual(["parties", "column_header", "order_strip", "parts", "price", "totals"]);
    expect(tables.map((t) => t.keyed)).toEqual(["section", "section", "section", "section", "section", "section"]);
    expect(tables.map((t) => t.rows)).toEqual([true, false, true, true, true, true]);
    expect(tables.map((t) => t.heading)).toEqual([null, null, null, null, null, null]);
    // Only the column headers print columns, boxed, once.
    expect(tables.map((t) => t.printed)).toEqual([null, { kind: "boxed", copies: 1, head: { size: "base" } }, null, null, null, null]);
    // The column headers' four fields name the contract table "columns" (addition 1); the four blocks
    // below print under them (addition 2), the order strip reading its left edge, the totals its right.
    expect(tables.map((t) => t.columnTable)).toEqual([undefined, "columns", undefined, undefined, undefined, undefined]);
    expect(tables.map((t) => t.grid)).toEqual([undefined, undefined, "column_header", "column_header", "column_header", "column_header"]);
    expect(tables.map((t) => t.gridEdge)).toEqual([undefined, undefined, "left", undefined, undefined, "right"]);
    // The part rows and the price block print their columns with the builder's grid gap between them.
    expect(tables.map((t) => t.gridGap)).toEqual([undefined, undefined, undefined, 6, 6, undefined]);
    expect(INVOICE_CANVAS.required).toEqual([]);
    expect(INVOICE_CANVAS.barcode).toBe(false);
    expect(INVOICE_CANVAS.notFields).toEqual([
      "bill_to", "ship_to",
      "our_order_no", "your_po", "material", "process", "parts_heading",
      "part_qty", "part_identity", "part_each_weight", "part_total_weight",
      "price_heading", "price_description", "price_amount", "quote_source", "price_per", "minimum_charge", "setup_charge",
      "subtotal", "surcharge_rows", "charge_rows", "cert_row", "freight_row", "tax_row", "total",
    ]);
    // The 25 are every field of the six blocks' sections but the four column fields, in contract order.
    const blockFields = tables.flatMap((t) => INVOICE_CONTRACT.sections.find((s) => s.key === t.key)!.fields);
    expect(blockFields.filter((f) => f.column === undefined).map((f) => f.key)).toEqual(INVOICE_CANVAS.notFields);
    expect(blockFields.filter((f) => f.column !== undefined).map((f) => f.key)).toEqual(["col_qty", "col_info", "col_each_weight", "col_amount"]);
    // The Remit To box prints in a border (PR 2 holds this to the builder's own list).
    expect(INVOICE_CANVAS.boxedFields).toEqual(["remit_to"]);
    expect(INVOICE_CANVAS.ruledFields).toEqual([]);
    // Each block's fixed parts at the contract's default grid, plus one grid step (call 11, the
    // controller's answer 2 of 2026-11-10). W is the grid's default widths, read from the contract.
    const columns = INVOICE_CONTRACT.sections.find((s) => s.key === "column_header")!.fields;
    const W = Object.fromEntries(columns.map((f) => [f.key, f.column!.defaultWidth])) as Record<string, number | "*">;
    const w = (key: string) => W[key] as number;
    expect(W.col_info).toBe("*");
    // #590's MEASURED_ROW_FLOOR (src/server/pdf/render.ts), the strip's 60 pt floor, counted as its
    // fixed part; PR 2 holds it to render.ts.
    const STRIP_FLOOR = 60;
    expect(INVOICE_LEAST_WIDTHS).toEqual({
      // Both address columns keep the first one's 40 pt indent and one grid step (the two "*" columns
      // share the width equally), and the 12 pt gap between them: the owner's ruling, 2026-11-10.
      parties: 2 * (40 + CANVAS_GRID) + 12,
      // The Quantity column and its 6 pt gap, the strip's indent, then the floor.
      order_strip: w("col_qty") + 6 + STRIP_FLOOR + CANVAS_GRID,
      // The three fixed columns, the three 6 pt gaps between the four, and the information cell's own
      // 6 pt left margin (inside its "*" column, src/server/pdf/invoice.ts), then a step for its rest.
      parts: w("col_qty") + w("col_each_weight") + w("col_amount") + 3 * 6 + 6 + CANVAS_GRID,
      price: w("col_qty") + w("col_each_weight") + w("col_amount") + 3 * 6 + 6 + CANVAS_GRID,
      // The 200 pt label, the amount column and two 6 pt gaps, then a step for the "*" spacer.
      totals: 200 + w("col_amount") + 2 * 6 + CANVAS_GRID,
    });
    expect(INVOICE_CANVAS.leastWidths).toBe(INVOICE_LEAST_WIDTHS);
    expect(INVOICE_CANVAS.rowFloor).toBe(INVOICE_ROW_FLOOR);
    expect(INVOICE_CANVAS.firstTableRoom).toBe(INVOICE_FIRST_TABLE_ROOM);
    expect([...canvasFieldKeys(INVOICE_CONTRACT)]).toEqual([
      "title", "company_name", "invoice_no", "invoice_date", "terms", "remit_to",
      "footer_address", "footer_contact", "footer_phone",
    ]);
    // The column headers' columns are found through columnTable: the four grid fields.
    expect(defaultTableColumns(INVOICE_CONTRACT, "column_header").map((c) => c.key))
      .toEqual(["col_qty", "col_info", "col_each_weight", "col_amount"]);
    expect(profileProblems(INVOICE_CONTRACT)).toEqual([]);
  });
  it("the invoice's profile with the column headers' columnTable deleted is refused by profileProblems (design 2026-11-10 §11)", () => {
    const canvas = structuredClone(INVOICE_CANVAS);
    delete canvas.tables.find((t) => t.key === "column_header")!.columnTable;
    expect(profileProblems({ ...INVOICE_CONTRACT, canvas })).toEqual([
      'The column table "column_header" finds no column: no field of the contract is a column of "column_header".',
    ]);
  });
  it("the statement's profile (design 2026-11-11 §4.1)", () => {
    expect(STATEMENT_CONTRACT.canvas).toEqual(STATEMENT_CANVAS);
    const tables = STATEMENT_CANVAS.tables;
    expect(tables.map((t) => t.key)).toEqual(["bill_to", "open_items", "aging", "finance_charge", "total"]);
    expect(tables.map((t) => t.keyed)).toEqual(["field", "section", "section", "section", "section"]);
    expect(tables.map((t) => t.rows)).toEqual([false, true, false, true, true]);
    expect(tables.map((t) => t.heading)).toEqual(["bill_to", null, null, null, null]);
    // Only the aging strip prints columns, boxed, once.
    expect(tables.map((t) => t.printed)).toEqual([null, null, { kind: "boxed", copies: 1, head: { size: 9 } }, null, null]);
    // The Bill To alone holds its drawn height (beside the Remit To box); no other spec carries the entry.
    expect(tables.find((t) => t.key === "bill_to")!.holdsHeight).toBe(true);
    for (const t of tables.filter((t) => t.key !== "bill_to")) expect(Object.hasOwn(t, "holdsHeight"), t.key).toBe(false);
    expect(STATEMENT_CANVAS.required).toEqual([]);
    expect(STATEMENT_CANVAS.barcode).toBe(false);
    expect(STATEMENT_CANVAS.notFields).toEqual([
      "bill_to", "document_no", "date", "due_date", "original", "open", "finance_charge", "total_due",
    ]);
    // The eight are the Bill To's key and every field of the three rows blocks' sections, in contract order.
    const rowsFields = tables.filter((t) => t.rows).flatMap((t) => STATEMENT_CONTRACT.sections.find((s) => s.key === t.key)!.fields);
    expect(STATEMENT_CANVAS.notFields).toEqual(["bill_to", ...rowsFields.map((f) => f.key)]);
    // The Remit To box prints in a border; tests/statement-canvas.test.ts holds this to the builder's
    // own STATEMENT_BOXED_FIELDS.
    expect(STATEMENT_CANVAS.boxedFields).toEqual(["remit_to"]);
    expect(STATEMENT_CANVAS.ruledFields).toEqual([]);
    // The totals' label, amount and two gaps, then a step (call 12), read from the flow's own widths
    // (`STATEMENT_WIDTHS`, through statementFlowLeastWidths); the open items' the owner's 49.5 (#971);
    // the Bill To has no fixed part and no entry. The design's figure is 316.5.
    expect(STATEMENT_LEAST_WIDTHS).toEqual(statementFlowLeastWidths());
    expect(STATEMENT_LEAST_WIDTHS.total).toBe(316.5);
    expect(STATEMENT_CANVAS.leastWidths).toBe(STATEMENT_LEAST_WIDTHS);
    expect(STATEMENT_CANVAS.rowFloor).toBe(STATEMENT_ROW_FLOOR);
    expect(STATEMENT_CANVAS.firstTableRoom).toBe(STATEMENT_FIRST_TABLE_ROOM);
    expect(profileProblems(STATEMENT_CONTRACT)).toEqual([]);
  });
  it("the statement's canvas fields are the five left by its notFields and the aging's columns (design 2026-11-11 §4.1)", () => {
    expect([...canvasFieldKeys(STATEMENT_CONTRACT)]).toEqual(["title", "company_name", "customer", "statement_date", "remit_to"]);
  });
  it("the statement's profile with holdsHeight moved from the Bill To onto the open items is refused by profileProblems (design 2026-11-11 §11)", () => {
    const contract = structuredClone(STATEMENT_CONTRACT);
    const tables = contract.canvas!.tables;
    delete tables.find((t) => t.key === "bill_to")!.holdsHeight;
    tables.find((t) => t.key === "open_items")!.holdsHeight = true;
    expect(profileProblems(contract)).toEqual([
      'The table "open_items" holds its drawn height, but only a block keyed by a field holds one.',
    ]);
  });
  it("the quote's profile (design 2026-11-12 §4.1)", () => {
    expect(QUOTE_CONTRACT.canvas).toEqual(QUOTE_CANVAS);
    const tables = QUOTE_CANVAS.tables;
    expect(tables.map((t) => t.key)).toEqual(["parties", "intro", "column_header", "lines", "closing", "liability"]);
    expect(tables.map((t) => t.keyed)).toEqual(["section", "section", "section", "section", "section", "section"]);
    expect(tables.map((t) => t.rows)).toEqual([true, false, false, true, true, false]);
    expect(tables.map((t) => t.heading)).toEqual([null, null, null, null, null, null]);
    // Only the column headers' strip prints columns, boxed, once.
    expect(tables.map((t) => t.printed)).toEqual([null, null, { kind: "boxed", copies: 1, head: { size: 9 } }, null, null, null]);
    // The column headers name the contract table "columns"; the lines block prints under them, 6 pt
    // between its columns (the builder's), from their left edge (no gridEdge).
    for (const t of tables) {
      expect(t.columnTable, t.key).toBe(t.key === "column_header" ? "columns" : undefined);
      expect(Object.hasOwn(t, "columnTable"), t.key).toBe(t.key === "column_header");
      expect(t.grid, t.key).toBe(t.key === "lines" ? "column_header" : undefined);
      expect(Object.hasOwn(t, "grid"), t.key).toBe(t.key === "lines");
      expect(t.gridGap, t.key).toBe(t.key === "lines" ? 6 : undefined);
      expect(Object.hasOwn(t, "gridGap"), t.key).toBe(t.key === "lines");
      expect(Object.hasOwn(t, "gridEdge"), t.key).toBe(false);
    }
    // The intro and the liability print their wordings inside their blocks; no other block prints one.
    expect(Object.fromEntries(tables.filter((t) => Object.hasOwn(t, "textBlocks")).map((t) => [t.key, t.textBlocks])))
      .toEqual({ intro: ["quote_intro_text"], liability: ["quote_liability_text"] });
    expect(QUOTE_CANVAS.required).toEqual([]);
    expect(QUOTE_CANVAS.barcode).toBe(false);
    expect(QUOTE_CANVAS.boxedFields).toEqual([]);
    expect(QUOTE_CANVAS.ruledFields).toEqual([]);
    expect(QUOTE_CANVAS.notFields).toEqual([
      "attn", "bill_to", "company_phone", "effective", "expires", "terms", "rfq_number", "customer_phone",
      "line_qty", "line_part", "line_each_weight", "line_total_lbs", "material", "price_heading", "step_name",
      "step_notes", "price_amount", "setup_charge", "price_per", "minimum_charge", "breaks", "surcharge_estimate",
      "ending_statement", "quote_notes", "signer_name", "signer_title",
    ]);
    // The twenty-six are every field of the three rows blocks' sections, in contract order.
    const rowsFields = tables.filter((t) => t.rows).flatMap((t) => QUOTE_CONTRACT.sections.find((s) => s.key === t.key)!.fields);
    expect(QUOTE_CANVAS.notFields).toEqual(rowsFields.map((f) => f.key));
    expect(QUOTE_CANVAS.notFields).toHaveLength(26);
    // The design's figures (call 9), never the expression the constant is written with.
    expect(QUOTE_LEAST_WIDTHS).toEqual({ parties: 252.5, lines: 230.5, closing: 246.5 });
    expect(QUOTE_CANVAS.leastWidths).toBe(QUOTE_LEAST_WIDTHS);
    expect(QUOTE_CANVAS.rowFloor).toBe(QUOTE_ROW_FLOOR);
    expect(QUOTE_CANVAS.firstTableRoom).toBe(QUOTE_FIRST_TABLE_ROOM);
    expect(profileProblems(QUOTE_CONTRACT)).toEqual([]);
  });
  it("the quote's canvas fields are the four of its header (design 2026-11-12 §4.2)", () => {
    expect([...canvasFieldKeys(QUOTE_CONTRACT)]).toEqual(["title", "company_name", "company_address", "quote_number"]);
  });
});
describe("profileProblems (design 2026-11-09 §4.1)", () => {
  // A fixture in the traveler contract's shape: `head` (two plain fields and `t`), `list` (a list
  // block), `cols` (one column and one toggle), `rws` (two rows), `hdr` (two columns of the table
  // "grid_cols"), one text block, and a sound profile holding a section-keyed list, a field-keyed
  // block `b` holding its drawn height (design 2026-11-11 §4.1), a section-keyed column block with
  // a toggle, a text block of its own and a sidebar beside its columns, a section-keyed rows block
  // printing under the grid `hdr` (its `grid`;
  // design 2026-11-10 §4.1 addition 2), and a section-keyed column block `hdr` whose columns are
  // those of "grid_cols" (its `columnTable`; design 2026-11-10 §4.1), LAST so `tables[0]` stays
  // the list.
  const plain = (key: string) => ({ key, name: key, defaultLabel: key, removable: true });
  function sound(): TemplateContract {
    return {
      docType: "TRAVELER",
      name: "Profile fixture",
      sections: [
        { key: "head", name: "Head", hideable: true, reorderable: true, fields: [plain("a"), plain("b"), plain("t")] },
        { key: "list", name: "List", hideable: true, reorderable: true, fields: [plain("l")] },
        {
          key: "cols", name: "Cols", hideable: true, reorderable: true,
          fields: [{ ...plain("c1"), column: { table: "cols", defaultWidth: 40 } }, plain("tog")],
        },
        { key: "rws", name: "Rows", hideable: true, reorderable: true, fields: [plain("r1"), plain("r2")] },
        {
          key: "hdr", name: "Header", hideable: true, reorderable: true,
          fields: [
            { ...plain("h1"), column: { table: "grid_cols", defaultWidth: 50 } },
            { ...plain("h2"), column: { table: "grid_cols", defaultWidth: "*" } },
          ],
        },
      ],
      textBlocks: [{ key: "w", name: "W", defaultText: "Words." }],
      formats: {},
      fonts: { family: "Roboto", baseSize: 8, headingSize: 12, smallSize: 6 },
      canvas: {
        paper: "fixture",
        tables: [
          { key: "list", keyed: "section", heading: null, rows: false, printed: null },
          { key: "b", keyed: "field", heading: "b", rows: false, printed: null, holdsHeight: true },
          {
            key: "cols", keyed: "section", heading: null, rows: false,
            printed: { kind: "boxed", copies: 1, beside: 20, head: { size: "base" } }, toggles: ["tog"], textBlocks: ["w"],
          },
          { key: "rws", keyed: "section", heading: null, rows: true, printed: null, grid: "hdr" },
          {
            key: "hdr", keyed: "section", heading: null, rows: false,
            printed: { kind: "boxed", copies: 1, head: { size: "base" } }, columnTable: "grid_cols",
          },
        ],
        required: [],
        barcode: false,
        notFields: ["b", "tog", "l", "r1", "r2"],
        boxedFields: [],
        ruledFields: [],
        rowFloor: 10,
        firstTableRoom: 20,
        leastWidths: { a: 30, b: 30, list: 10 },
      },
    };
  }
  /** A one-change copy of the sound fixture. */
  function changed(change: (c: TemplateContract & { canvas: NonNullable<TemplateContract["canvas"]> }) => void): TemplateContract {
    const c = structuredClone(sound()) as TemplateContract & { canvas: NonNullable<TemplateContract["canvas"]> };
    change(c);
    return c;
  }
  const spec = (c: TemplateContract, key: string) => c.canvas!.tables.find((t) => t.key === key)!;

  it("a sound profile answers nothing, and so does a contract with no profile", () => {
    // Also the pins that the rows/list clause (design 2026-11-10 §4.6) judges neither the section
    // holding a field-keyed block's field (`head` holds `a` and `t`, neither in notFields, beside the
    // field-keyed `b`) nor a column table's section (`cols` holds the column `c1`, not in notFields).
    // A field-keyed block's same-named section is the "a section too" case's, which proves it.
    expect(profileProblems(sound())).toEqual([]);
    expect(profileProblems(testContract())).toEqual([]);
  });
  it("a section-keyed table whose key is no section", () => {
    const c = changed((x) => x.canvas.tables.push({ key: "a", keyed: "section", heading: null, rows: false, printed: null }));
    expect(profileProblems(c)).toEqual(['The table "a" is keyed by section, but the contract has no section "a".']);
  });
  it("a field-keyed table whose key is no field", () => {
    const c = changed((x) => x.canvas.tables.push({ key: "nope", keyed: "field", heading: "nope", rows: false, printed: null }));
    expect(profileProblems(c)).toEqual(['The table "nope" is keyed by field, but the contract has no field "nope".']);
  });
  it("a field-keyed table whose key is a section too", () => {
    // notFields drops the list section's "l": a field-keyed table's same-named section is not judged
    // by the rows/list clause (design 2026-11-10 §4.6), so the one sentence is the section's.
    const c = changed((x) => {
      x.sections[0].fields.push(plain("list"));
      x.canvas.tables[0] = { key: "list", keyed: "field", heading: "list", rows: false, printed: null };
      x.canvas.notFields = ["b", "tog", "r1", "r2"];
    });
    expect(profileProblems(c)).toEqual(['The table "list" is keyed by field, but the contract has a section "list" too.']);
  });
  it("a field-keyed table's heading is its own key", () => {
    const c = changed((x) => { spec(x, "b").heading = null; });
    expect(profileProblems(c)).toEqual(['The table "b" is keyed by field, so its heading is "b", not none.']);
  });
  const noRows = 'The table "b" is keyed by field, so it has no rows and prints no columns.';
  it("a field-keyed table has no rows", () => {
    expect(profileProblems(changed((x) => { spec(x, "b").rows = true; }))).toEqual([noRows]);
  });
  it("a field-keyed table prints no columns", () => {
    expect(profileProblems(changed((x) => { spec(x, "b").printed = { kind: "ruled", copies: 1, head: { size: "base" } }; }))).toEqual([noRows]);
  });
  const notPlain = (toggle: string) => `The toggle "${toggle}" of the table "cols" is not a field of its section without a column.`;
  it("a toggle is no column", () => {
    expect(profileProblems(changed((x) => { spec(x, "cols").toggles = ["c1"]; }))).toEqual([notPlain("c1")]);
  });
  it("a toggle is a field of its own section", () => {
    expect(profileProblems(changed((x) => { spec(x, "cols").toggles = ["a"]; }))).toEqual([notPlain("a")]);
  });
  it("a toggle naming no field at all", () => {
    expect(profileProblems(changed((x) => { spec(x, "cols").toggles = ["nope"]; }))).toEqual([notPlain("nope")]);
  });
  it("a field-keyed table has no toggles: one naming a plain field is refused", () => {
    expect(profileProblems(changed((x) => { spec(x, "b").toggles = ["a"]; })))
      .toEqual(['The toggle "a" of the table "b" is not a field of its section without a column.']);
  });
  it("a field-keyed table's key is in notFields", () => {
    const c = changed((x) => { x.canvas.notFields = ["tog", "l", "r1", "r2"]; });
    expect(profileProblems(c)).toEqual(['The table "b" is keyed by field, but notFields does not hold "b".']);
  });
  it("a toggle is in notFields", () => {
    const c = changed((x) => { x.canvas.notFields = ["b", "l", "r1", "r2"]; });
    expect(profileProblems(c)).toEqual(['The toggle "tog" of the table "cols" is not in notFields.']);
  });
  it("a table's own text blocks are text blocks the contract has", () => {
    const c = changed((x) => { spec(x, "cols").textBlocks = ["nope"]; });
    expect(profileProblems(c)).toEqual(['The text block "nope" of the table "cols" is not one the contract has.']);
  });
  it("a notFields key is a field of the contract", () => {
    expect(profileProblems(changed((x) => { x.canvas.notFields = ["b", "tog", "l", "r1", "r2", "nope"]; })))
      .toEqual(['The notFields key "nope" is not a field of the contract.']);
  });
  it("a boxedFields key is a field of the contract", () => {
    expect(profileProblems(changed((x) => { x.canvas.boxedFields = ["nope"]; })))
      .toEqual(['The boxedFields key "nope" is not a field of the contract.']);
  });
  it("a ruledFields key is a field of the contract", () => {
    expect(profileProblems(changed((x) => { x.canvas.ruledFields = [{ key: "nope", draw: "beside" }]; })))
      .toEqual(['The ruledFields key "nope" is not a field of the contract.']);
  });
  it("a ruledFields entry drawn on two lines names its column", () => {
    expect(profileProblems(changed((x) => { x.canvas.ruledFields = [{ key: "a", draw: "lines" }]; })))
      .toEqual(['The ruledFields key "a" draws two lines but names no column.']);
    // The neighbouring entry, with its column, is sound: the sentence is the missing column's.
    expect(profileProblems(changed((x) => { x.canvas.ruledFields = [{ key: "a", draw: "lines", column: 40 }]; }))).toEqual([]);
  });
  it("a leastWidths key is a field or a table of the profile", () => {
    const c = changed((x) => { x.canvas.leastWidths = { ...x.canvas.leastWidths, nope: 1 }; });
    expect(profileProblems(c)).toEqual(['The leastWidths key "nope" is neither a field nor a table of the profile.']);
  });
  it("a rows block's row is in notFields (design 2026-11-10 §4.6)", () => {
    const c = changed((x) => { x.canvas.notFields = ["b", "tog", "l", "r1"]; });
    expect(profileProblems(c)).toEqual(['The row "r2" of the rows block "rws" is not in notFields.']);
  });
  it("a list block's field is in notFields (design 2026-11-10 §4.6)", () => {
    const c = changed((x) => { x.canvas.notFields = ["b", "tog", "r1", "r2"]; });
    expect(profileProblems(c)).toEqual(['The field "l" of the list block "list" is not in notFields.']);
  });
  it("a column table finds its columns through columnTable (design 2026-11-10 §4.1)", () => {
    const c = sound();
    const columns = defaultTableColumns(c, "hdr");
    expect(columns).toEqual([
      { key: "h1", visible: true, label: null, width: null },
      { key: "h2", visible: true, label: null, width: null },
    ]);
    const item = {
      id: "table-hdr", kind: "table" as const, key: "hdr", heading: null, columns,
      box: { x: 24, y: 24, w: 300, h: 40 }, anchor: { kind: "page-top" as const }, repeat: false,
    };
    // h1's 50 is the one fixed width; h2 is "*", so the figure is a least width. The least width
    // adds the boxed padding and rules over the two columns and one grid step (#971).
    expect(leastWidth(c, item)).toBe(round2(50 + tableOverhead("boxed", 2) + CANVAS_GRID));
    expect(visibleColumnsWidth(c, item)).toBe(50);
    expect(canvasTablePrintedWidth(c, item, 8)).toEqual({
      printed: round2(50 + tableOverhead("boxed", 2)), flexible: true, copies: 1,
    });
  });
  const onlyColumnTables = (key: string) =>
    `The table "${key}" names the column table "grid_cols", but only a section-keyed column table names one.`;
  it("columnTable stands only on a section-keyed column table: not a rows block, not a list", () => {
    expect(profileProblems(changed((x) => { spec(x, "rws").columnTable = "grid_cols"; }))).toEqual([onlyColumnTables("rws")]);
    expect(profileProblems(changed((x) => { spec(x, "list").columnTable = "grid_cols"; }))).toEqual([onlyColumnTables("list")]);
  });
  // A steps-layout table, added by the cases that need it (Task 2 reuses it).
  const addSteps = (x: TemplateContract & { canvas: NonNullable<TemplateContract["canvas"]> }, columnOf = "stp") => {
    x.sections.push({
      key: "stp", name: "Steps", hideable: true, reorderable: true,
      fields: [{ ...plain("s1"), column: { table: columnOf, defaultWidth: 40 } }],
    });
    x.canvas.tables.push({ key: "stp", keyed: "section", heading: null, rows: false, printed: { kind: "steps", head: { size: "base" } } });
  };
  it("columnTable stands only on a section-keyed column table: not one printed in the steps layout", () => {
    // The steps table, sound without one, answers nothing.
    expect(profileProblems(changed((x) => addSteps(x)))).toEqual([]);
    const c = changed((x) => { addSteps(x); spec(x, "stp").columnTable = "grid_cols"; });
    expect(profileProblems(c)).toEqual([onlyColumnTables("stp")]);
  });
  it("columnTable stands only on a section-keyed column table: not a field-keyed block", () => {
    // A sound field-keyed spec prints nothing, so `b` is given columns to print: the field-keyed
    // sentence answers that, and the columnTable sentence answers its own half.
    const c = changed((x) => {
      spec(x, "b").printed = { kind: "boxed", copies: 1, head: { size: "base" } };
      spec(x, "b").columnTable = "grid_cols";
    });
    expect(profileProblems(c)).toEqual([noRows, onlyColumnTables("b")]);
  });
  it("columnTable names a table its section's fields are columns of", () => {
    // "cols" is a column table of the contract, but no field of `hdr` is a column of it; the spec
    // still names a columnTable, so the finds-a-column clause does not ask it.
    const c = changed((x) => { spec(x, "hdr").columnTable = "cols"; });
    expect(profileProblems(c)).toEqual(['The table "hdr" names the column table "cols", but no field of its section is a column of it.']);
  });
  it("a section-keyed column table finds a column", () => {
    const c = changed((x) => { delete spec(x, "hdr").columnTable; });
    expect(profileProblems(c)).toEqual(['The column table "hdr" finds no column: no field of the contract is a column of "hdr".']);
  });
  it("a section-keyed column table finds a column: the steps layout included", () => {
    const c = changed((x) => addSteps(x, "elsewhere"));
    expect(profileProblems(c)).toEqual(['The column table "stp" finds no column: no field of the contract is a column of "stp".']);
  });
  it("a section-keyed column table finds a column: asked only of a key that is a section", () => {
    const c = changed((x) => {
      x.canvas.tables.push({ key: "ghost", keyed: "section", heading: null, rows: false, printed: { kind: "boxed", copies: 1, head: { size: "base" } } });
    });
    expect(profileProblems(c)).toEqual(['The table "ghost" is keyed by section, but the contract has no section "ghost".']);
  });
  it("columnTable names a table its section's fields are columns of: asked only of a key that is a section", () => {
    const c = changed((x) => {
      x.canvas.tables.push({
        key: "ghost", keyed: "section", heading: null, rows: false, printed: { kind: "boxed", copies: 1, head: { size: "base" } }, columnTable: "grid_cols",
      });
    });
    expect(profileProblems(c)).toEqual(['The table "ghost" is keyed by section, but the contract has no section "ghost".']);
  });
  const onlyRowsBlocks = (key: string, grid = "hdr") =>
    `The table "${key}" names the grid "${grid}", but only a section-keyed rows block prints under one.`;
  const notAGrid = (grid: string) =>
    `The grid "${grid}" of the table "rws" is not a section-keyed column table of the profile.`;
  it("grid stands only on a section-keyed rows block: not a list (design 2026-11-10 §4.1)", () => {
    expect(profileProblems(changed((x) => { spec(x, "list").grid = "hdr"; }))).toEqual([onlyRowsBlocks("list")]);
  });
  it("grid stands only on a section-keyed rows block: not a field-keyed block", () => {
    // A sound field-keyed spec has no rows, so `b` is given rows: the field-keyed sentence answers
    // that, and the grid sentence answers its own half.
    const c = changed((x) => {
      spec(x, "b").rows = true;
      spec(x, "b").grid = "hdr";
    });
    expect(profileProblems(c)).toEqual([noRows, onlyRowsBlocks("b")]);
  });
  it("grid stands only on a section-keyed rows block: a list naming a grid that is none answers that sentence alone", () => {
    expect(profileProblems(changed((x) => { spec(x, "list").grid = "nope"; }))).toEqual([onlyRowsBlocks("list", "nope")]);
  });
  it("a grid is a section-keyed column table of the profile: not a field-keyed block", () => {
    // `b` given columns to print (one copy, nothing beside them): the field-keyed sentence answers
    // that, and the grid's key alone keeps it from being a grid.
    const c = changed((x) => {
      spec(x, "b").printed = { kind: "boxed", copies: 1, head: { size: "base" } };
      spec(x, "rws").grid = "b";
    });
    expect(profileProblems(c)).toEqual([noRows, notAGrid("b")]);
  });
  it("a grid is a section-keyed column table of the profile: not a list, not a key it lacks", () => {
    expect(profileProblems(changed((x) => { spec(x, "rws").grid = "list"; }))).toEqual([notAGrid("list")]);
    expect(profileProblems(changed((x) => { spec(x, "rws").grid = "nope"; }))).toEqual([notAGrid("nope")]);
  });
  it("a grid is a section-keyed column table of the profile: not one printed in the steps layout", () => {
    const c = changed((x) => { addSteps(x); spec(x, "rws").grid = "stp"; });
    expect(profileProblems(c)).toEqual([notAGrid("stp")]);
  });
  const rowsPrintNone = (key: string) => `The table "${key}" is a rows block, so it prints no columns.`;
  it("a section-keyed rows block prints no columns, and is not asked to find one", () => {
    // `tableFields` reads a rows block's section as its rows whatever `printed` says, so a rows block
    // with columns answers this sentence alone: the column-table clauses do not ask it.
    expect(profileProblems(changed((x) => { spec(x, "rws").printed = { kind: "boxed", copies: 1, head: { size: "base" } }; })))
      .toEqual([rowsPrintNone("rws")]);
  });
  it("a grid is a column table that is no rows block", () => {
    // `hdr` made a rows block printing columns: its columnTable dropped (a rows block names none) and
    // its fields put in notFields (a rows block's rows), so the two sentences are the grid's and the
    // rows block's.
    const c = changed((x) => {
      spec(x, "hdr").rows = true;
      delete spec(x, "hdr").columnTable;
      x.canvas.notFields.push("h1", "h2");
    });
    expect(profileProblems(c)).toEqual([notAGrid("hdr"), rowsPrintNone("hdr")]);
  });
  it("a grid is a column table printing one copy", () => {
    expect(profileProblems(changed((x) => { spec(x, "hdr").printed = { kind: "boxed", copies: 2, head: { size: "base" } }; })))
      .toEqual([notAGrid("hdr")]);
  });
  it("a grid is a column table keeping nothing beside its columns", () => {
    // `cols` is a sound section-keyed boxed column table printing one copy, with 20 points beside it.
    expect(spec(sound(), "cols").printed).toEqual({ kind: "boxed", copies: 1, beside: 20, head: { size: "base" } });
    expect(profileProblems(changed((x) => { spec(x, "rws").grid = "cols"; }))).toEqual([notAGrid("cols")]);
  });
  it("a grid edge stands only beside a grid", () => {
    const c = changed((x) => { delete spec(x, "rws").grid; spec(x, "rws").gridEdge = "left"; });
    expect(profileProblems(c)).toEqual(['The table "rws" names a grid edge but no grid.']);
    // Beside its grid, the edge is sound.
    expect(profileProblems(changed((x) => { spec(x, "rws").gridEdge = "right"; }))).toEqual([]);
  });
  it("a grid gap stands only beside a grid", () => {
    const c = changed((x) => { delete spec(x, "rws").grid; spec(x, "rws").gridGap = 6; });
    expect(profileProblems(c)).toEqual(['The table "rws" names a grid gap but no grid.']);
    // Beside its grid, the gap is sound.
    expect(profileProblems(changed((x) => { spec(x, "rws").gridGap = 6; }))).toEqual([]);
  });
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("a grid gap of %s is refused: a gap is a finite number of points, none below 0", (gap) => {
    const c = changed((x) => { spec(x, "rws").gridGap = gap; });
    expect(profileProblems(c)).toEqual([`The table "rws" names a grid gap of ${gap}, but a grid gap is a finite number of points, none below 0.`]);
    // A gap of 0 is sound.
    expect(profileProblems(changed((x) => { spec(x, "rws").gridGap = 0; }))).toEqual([]);
  });
  it("a grid margin stands only beside a grid (#971 design §6.1)", () => {
    const c = changed((x) => { delete spec(x, "rws").grid; spec(x, "rws").gridMargin = 6; });
    expect(profileProblems(c)).toEqual(['The table "rws" names a grid margin but no grid.']);
    // Beside its grid, the margin is sound.
    expect(profileProblems(changed((x) => { spec(x, "rws").gridMargin = 6; }))).toEqual([]);
  });
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("a grid margin of %s is refused: a margin is a finite number of points, none below 0", (margin) => {
    const c = changed((x) => { spec(x, "rws").gridMargin = margin; });
    expect(profileProblems(c)).toEqual([
      `The table "rws" names a grid margin of ${margin}, but a grid margin is a finite number of points, none below 0.`,
    ]);
    // A margin of 0 is sound.
    expect(profileProblems(changed((x) => { spec(x, "rws").gridMargin = 0; }))).toEqual([]);
  });
  it("a grid indent stands only on a block reading its grid's left edge or every column of it, past a column of its grid (#971)", () => {
    const indent = { column: "h1", gap: 6, floor: 60 };
    expect(profileProblems(changed((x) => { spec(x, "rws").gridEdge = "left"; spec(x, "rws").gridIndent = indent; }))).toEqual([]);
    // A block printing every column of its grid takes one for the lines it prints past a column
    // (Codex review: the quote's Material line and PRICE heading, the invoice's PRICE heading).
    expect(profileProblems(changed((x) => { spec(x, "rws").gridIndent = { ...indent, floor: 0 }; }))).toEqual([]);
    const leftOnly = 'The table "rws" names a grid indent, but only a block reading its grid\'s left edge or every column of it takes one.';
    expect(profileProblems(changed((x) => { spec(x, "rws").gridEdge = "right"; spec(x, "rws").gridIndent = indent; }))).toEqual([leftOnly]);
    expect(profileProblems(changed((x) => { delete spec(x, "rws").grid; spec(x, "rws").gridIndent = indent; })))
      .toContain(leftOnly);
    expect(profileProblems(changed((x) => {
      spec(x, "rws").gridEdge = "left"; spec(x, "rws").gridIndent = { ...indent, column: "r1" };
    }))).toEqual(['The table "rws" is indented past "r1", which is no column of its grid "hdr".']);
  });
  it("a grid edge column stands only on a block reading its grid's right edge, a column of its grid (#971)", () => {
    const edge = { column: "h1", fixed: 212 };
    expect(profileProblems(changed((x) => { spec(x, "rws").gridEdge = "right"; spec(x, "rws").gridEdgeColumn = edge; }))).toEqual([]);
    const rightOnly = 'The table "rws" names a grid edge column, but only a block reading its grid\'s right edge takes one.';
    expect(profileProblems(changed((x) => { spec(x, "rws").gridEdgeColumn = edge; }))).toEqual([rightOnly]);
    expect(profileProblems(changed((x) => { spec(x, "rws").gridEdge = "left"; spec(x, "rws").gridEdgeColumn = edge; }))).toEqual([rightOnly]);
    expect(profileProblems(changed((x) => {
      spec(x, "rws").gridEdge = "right"; spec(x, "rws").gridEdgeColumn = { ...edge, column: "r1" };
    }))).toEqual(['The table "rws" prints "r1" at its edge, which is no column of its grid "hdr".']);
  });
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("a grid edge column's fixed parts of %s are refused (#971)", (value) => {
    const c = changed((x) => { spec(x, "rws").gridEdge = "right"; spec(x, "rws").gridEdgeColumn = { column: "h1", fixed: value }; });
    expect(profileProblems(c)).toEqual([
      `The table "rws" names grid edge fixed parts of ${value}, but they are a finite number of points, none below 0.`,
    ]);
  });
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("a grid indent's gap or floor of %s is refused (#971)", (value) => {
    for (const what of ["gap", "floor"] as const) {
      const c = changed((x) => { spec(x, "rws").gridEdge = "left"; spec(x, "rws").gridIndent = { column: "h1", gap: 6, floor: 60, [what]: value }; });
      expect(profileProblems(c)).toEqual([
        `The table "rws" names a grid indent ${what} of ${value}, but it is a finite number of points, none below 0.`,
      ]);
    }
  });
  it("no built profile but the invoice's and the quote's carries columnTable, grid, gridEdge, gridGap or gridMargin (design 2026-11-10 §4.1)", () => {
    // Derived from every doc type, so a later profile joins it; the invoice and the quote are left out
    // by name, as each gains the entries with its profile (the quote's held by its own profile case).
    let profiled = 0;
    for (const docType of TEMPLATE_DOC_TYPES) {
      if (docType === "INVOICE" || docType === "QUOTE") continue;
      const profile = contractFor(docType).canvas;
      if (profile === undefined) continue;
      profiled++;
      for (const t of profile.tables) {
        for (const entry of ["columnTable", "grid", "gridEdge", "gridGap", "gridMargin", "gridIndent"]) expect(Object.hasOwn(t, entry), `${docType} ${t.key} ${entry}`).toBe(false);
      }
    }
    expect(profiled).toBeGreaterThanOrEqual(5);
  });
  // The sound fixture's field-keyed `b` holds its height and answers nothing (the sound case); each
  // section-keyed block made to hold answers the one sentence for its key, one case a key so each
  // reds alone.
  it.each(["rws", "list", "cols"])("a held height stands only on a block keyed by a field: the section-keyed %s is refused (design 2026-11-11 §4.6)", (key) => {
    expect(profileProblems(changed((x) => { spec(x, key).holdsHeight = true; }))).toEqual([
      `The table "${key}" holds its drawn height, but only a block keyed by a field holds one.`,
    ]);
  });
  it("no built profile but the statement's carries holdsHeight (design 2026-11-11 §4.6)", () => {
    // Derived from every doc type, so a later profile joins it; the statement is left out by name,
    // as it gains the entry with its profile.
    let profiled = 0;
    for (const docType of TEMPLATE_DOC_TYPES) {
      if (docType === "STATEMENT") continue;
      const profile = contractFor(docType).canvas;
      if (profile === undefined) continue;
      profiled++;
      for (const t of profile.tables) expect(Object.hasOwn(t, "holdsHeight"), `${docType} ${t.key}`).toBe(false);
    }
    expect(profiled).toBeGreaterThanOrEqual(6);
  });
});
