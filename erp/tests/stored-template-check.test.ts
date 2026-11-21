import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import {
  TRAVELER_DEFAULT_CONFIG, contractFor, validateConfig,
  type SectionConfig, type TemplateConfig, type TemplateDocTypeString,
} from "@/lib/template-contracts/index";
import { MIN_SHARED_WIDTH_PT, sharedContainerWidth } from "@/lib/template-printed-width";
import { validateContractConfig } from "@/lib/template-contracts/types";
import {
  LISTING_HEADINGS, OLD_BUILT_IN_LABELS, checkStoredVersion, listing, stopsTheMerge,
  type ExportedVersion,
} from "../scripts/lib/stored-template-check";
import { FIRST_SEED_TYPES, builtInLabelsBefore, seedLiteral, storedBefore } from "./helpers/stored-configs";
import { barcode, standardLayout } from "./helpers/canvas-fixtures";
import { standardTicketLayout } from "./helpers/ticket-canvas-fixtures";
import { standardBolLayout } from "./helpers/bol-canvas-fixtures";
import { standardCertLayout } from "./helpers/cert-canvas-fixtures";
import { standardInvoiceLayout } from "./helpers/invoice-canvas-fixtures";
import { standardStatementLayout } from "./helpers/statement-canvas-fixtures";
import { standardQuoteLayout } from "./helpers/quote-canvas-fixtures";
import { canvasRefusal } from "@/lib/template-canvas";
import { SHIPPER_CONTRACT } from "@/lib/template-contracts/shipper";
import { BOL_CONTRACT } from "@/lib/template-contracts/bol";
import { CERT_CONTRACT } from "@/lib/template-contracts/cert";
import { INVOICE_CONTRACT } from "@/lib/template-contracts/invoice";
import { STATEMENT_CONTRACT } from "@/lib/template-contracts/statement";
import { QUOTE_CONTRACT } from "@/lib/template-contracts/quote";

// The checker of the listing (weights design §13.2 and §13.3, L1 to L7), on exports written out by
// hand. A stored config is the seed migration's literal or a frozen config in the shape an install
// holds, read through ./helpers/stored-configs. Where a case says "saved by this program", it is
// that literal as this program's editor would save it. No case opens the database. One form is not
// §13.3's: the Widths cell of a ticket table the 39-point line was not measured for, worded in the
// ledger's ruling of 2026-10-12 (docs/execution/2026-10-11-weights-paper/progress.md).
// The ticket's shared-width rule is src/lib/template-printed-width.ts's, which the checker imports
// (#519): the 39-point line and sharedContainerWidth are asked of that leaf here, and one case reads
// the checker's source and holds it to declaring none of the names the rule had there.

const TICKETS = ["SHIPPER", "MOS_SHIPPER"] as const;
/** Owner ruling R-B (2026-11-17, #991): a ticket whose container columns and padding pass the half's 282 pt is
 *  REFUSED by the contracts, in the printed-width budget's sentence. */
const PAST_THE_HALF = /^REFUSED: The "containers" table needs [\d.]+pt on paper \(/;

/** One exported version: in use on a live default template, unless a case says otherwise. */
const version = (docType: string, config: unknown, over: Partial<ExportedVersion> = {}): ExportedVersion => ({
  docType, templateId: "t-1", templateName: "Standard", isDefault: true, templateDeleted: false,
  versionId: "v-1", versionNumber: 1, status: "PUBLISHED", published: true, customers: [], config, ...over,
});
const row = (docType: string, config: unknown, over?: Partial<ExportedVersion>) =>
  checkStoredVersion(version(docType, config, over));
const section = (config: unknown, key: string): SectionConfig =>
  (config as TemplateConfig).sections.find((s) => s.key === key)!;
const field = (config: unknown, sectionKey: string, key: string) =>
  section(config, sectionKey).fields.find((f) => f.key === key)!;
/** The frozen config that typed Container Type at 110, with that one width changed. */
function typeWidth(docType: TemplateDocTypeString, width: number): unknown {
  const config = storedBefore(docType, "type-width-110");
  field(config, "containers", "container_type").width = width;
  return config;
}
/** The seed literal as this program's editor would save it: complete, the three new fields in. */
const savedNow = (docType: TemplateDocTypeString): TemplateConfig => validateConfig(docType, seedLiteral(docType));
/** `config` with these font knobs changed and nothing else. */
function withFonts<T>(config: T, fonts: Partial<TemplateConfig["fonts"]>): T {
  Object.assign((config as TemplateConfig).fonts, fonts);
  return config;
}
/** `config` with this label typed over one container column's heading and nothing else. */
function withContainerLabel<T>(config: T, key: string, label: string): T {
  field(config, "containers", key).label = label;
  return config;
}

describe("the listing's words", () => {
  it("L1: the headings, in order", () => {
    expect(LISTING_HEADINGS).toEqual([
      "Document", "Template", "Version", "Status", "Customers", "Verdict",
      "Typed labels", "Hidden", "Moved", "Widths", "What to do",
    ]);
  });

  it.each<[TemplateDocTypeString, string, string]>([
    ["TRAVELER", "Traveler", "none"],
    ["SHIPPER", "Shipping ticket", "Containers and Tare get 54 pt each"],
    ["MOS_SHIPPER", "Multi-order shipping ticket", "Containers and Tare get 54 pt each"],
    ["BOL", "Bill of lading", "none"],
    ["CERT", "Certification", "none"],
    ["INVOICE", "Invoice / credit", "none"],
    ["STATEMENT", "Statement", "none"],
    ["QUOTE", "Quotation", "none"],
  ])("%s: the seed literal is one whole row", (docType, document, widths) => {
    expect(row(docType, seedLiteral(docType))).toEqual({
      document, template: "Standard (default)", version: "1", status: "in use", customers: "none",
      verdict: "stays valid", typedLabels: "none", hidden: "none", moved: "none", widths, whatToDo: "listed only",
    });
  });

  it.each<[string, Partial<ExportedVersion>]>([
    ["in use", { published: true, status: "PUBLISHED" }],
    ["earlier", { published: false, status: "PUBLISHED" }],
    ["draft", { published: false, status: "DRAFT" }],
    ["discarded", { published: false, status: "DISCARDED" }],
  ])("L2: a version reads %s", (status, over) => {
    expect(row("CERT", seedLiteral("CERT"), over).status).toBe(status);
  });

  it.each<[string, Partial<ExportedVersion>, string]>([
    ["a default template", { isDefault: true, templateDeleted: false }, "Acme cert (default)"],
    ["a deleted template", { isDefault: false, templateDeleted: true }, "Acme cert (deleted)"],
    ["a template that is neither", { isDefault: false, templateDeleted: false }, "Acme cert"],
  ])("L2: the name of %s", (_name, over, template) => {
    expect(row("CERT", seedLiteral("CERT"), { templateName: "Acme cert", ...over }).template).toBe(template);
  });

  it("the version's number and the assigned customers' codes", () => {
    const customers = [{ code: "ACME", name: "Acme Forge" }, { code: "ZED", name: "Zed Gear" }];
    expect(row("CERT", seedLiteral("CERT"), { versionNumber: 7, customers })).toMatchObject({ version: "7", customers: "ACME, ZED" });
  });

  it("L3: a contract rule's refusal is the rule's own sentence, and the version's other cells stay empty", () => {
    expect(row("SHIPPER", typeWidth("SHIPPER", 230))).toEqual({
      document: "Shipping ticket", template: "Standard (default)", version: "1", status: "in use", customers: "none",
      verdict: 'REFUSED: The "containers" table\'s visible column widths total 292pt, past its 282pt budget (LETTER content width is 564pt)',
      typedLabels: "", hidden: "", moved: "", widths: "", whatToDo: "STOPS THE MERGE",
    });
  });

  it("L3: a shape refusal is each issue's path and message, joined, never the error's block of JSON", () => {
    const config = seedLiteral("SHIPPER");
    section(config, "containers").fields.push(
      { key: "pallet_count", visible: true, label: null, width: null },
      { key: "skid_count", visible: true, label: null, width: null },
    );
    expect(row("SHIPPER", config).verdict).toBe(
      'REFUSED: sections.4.fields.3: Unknown field key "pallet_count"; sections.4.fields.4: Unknown field key "skid_count"');
  });

  it.each<[TemplateDocTypeString, string, string]>([
    ["TRAVELER", "typed-labels", 'Line Weight typed as "Line Wt"; Gross Weight typed as "Gross Wt" (it stays, over the order\'s three figures)'],
    ["TRAVELER", "old-wording-typed", 'Part Weight typed as "Part Weight" (the old built-in wording); Gross Weight typed as "Gross Weight" (it stays, over the order\'s three figures)'],
    ["SHIPPER", "typed-labels", 'Pounds typed as "Lbs Shipped"; Pounds Shipped: typed as "Pounds Shipped:" (the old built-in wording)'],
    ["MOS_SHIPPER", "typed-labels", 'Pounds typed as "Lbs Shipped"; Pounds Shipped: typed as "Pounds Shipped:" (the old built-in wording)'],
    ["CERT", "typed-label", 'Pounds typed as "Lbs"'],
    ["INVOICE", "typed-label", 'Total Wt / Price typed as "Wt / Price"'],
    ["QUOTE", "typed-label", 'Total Lbs / Price typed as "Lbs / Price"'],
    ["BOL", "typed-label", "none"],
  ])("L4: %s %s", (docType, name, typedLabels) => {
    expect(row(docType, storedBefore(docType, name)).typedLabels).toBe(typedLabels);
  });

  it.each<[TemplateDocTypeString, string, string]>([
    ["SHIPPER", "totals-hidden", "Totals"],
    ["MOS_SHIPPER", "totals-hidden", "Totals"],
    ["SHIPPER", "net-row-hidden", "Net weight row"],
    ["MOS_SHIPPER", "net-row-hidden", "Net weight row"],
    ["TRAVELER", "gross-hidden", "Gross Weight column"],
    ["TRAVELER", "quantities-hidden", "Quantities and containers"],
    ["SHIPPER", "containers-hidden", "none"],
    ["SHIPPER", "count-hidden", "none"],
    ["CERT", "weight-hidden", "none"],
    ["BOL", "weight-hidden", "none"],
  ])("L5: %s %s reads %s", (docType, name, hidden) => {
    expect(row(docType, storedBefore(docType, name)).hidden).toBe(hidden);
  });

  it("L5: a ticket that hid its totals and its net row reads both", () => {
    const config = storedBefore("SHIPPER", "totals-hidden");
    field(config, "totals", "total_weight").visible = false;
    expect(row("SHIPPER", config).hidden).toBe("Totals; Net weight row");
  });

  it.each<[TemplateDocTypeString, string, string]>([
    ["SHIPPER", "container-columns-moved", "container columns moved"],
    ["MOS_SHIPPER", "container-columns-moved", "container columns moved"],
    ["SHIPPER", "totals-rows-moved", "totals rows moved"],
    ["MOS_SHIPPER", "totals-rows-moved", "totals rows moved"],
    ["SHIPPER", "sections-moved", "none"],
    ["TRAVELER", "gross-moved-first", "none"],
  ])("L5b: %s %s reads %s", (docType, name, moved) => {
    expect(row(docType, storedBefore(docType, name)).moved).toBe(moved);
  });

  it.each(TICKETS)("L5b: %s saved by this program with only its new fields moved reads none", (docType) => {
    const config = savedNow(docType);
    const lead = (sectionKey: string, first: string[]) => {
      const s = section(config, sectionKey);
      s.fields = [...first.map((key) => field(config, sectionKey, key)), ...s.fields.filter((f) => !first.includes(f.key))];
    };
    lead("containers", ["container_tare"]);
    lead("totals", ["total_gross", "total_tare"]);
    expect(row(docType, config)).toMatchObject({ verdict: "stays valid", moved: "none" });
  });

  it("a ticket at another base size reads its share, and stops nothing (the not-measured form is retired, R-A)", () => {
    expect(row("SHIPPER", withFonts(seedLiteral("SHIPPER"), { baseSize: 12 }))).toEqual({
      document: "Shipping ticket", template: "Standard (default)", version: "1", status: "in use", customers: "none",
      verdict: "stays valid", typedLabels: "none", hidden: "none", moved: "none",
      widths: "Containers and Tare get 54 pt each", whatToDo: "listed only",
    });
  });

  it("L6b: a width typed on the traveler's Gross Weight column, beside the built-in width", () => {
    expect(row("TRAVELER", storedBefore("TRAVELER", "gross-width-50")).widths)
      .toBe("Gross Weight column typed at 50 pt (built-in 88 pt)");
  });
});

it("writes a share with two decimals under 39 points, the figure the retired line kept (R-A, R-C)", () => {
  expect(MIN_SHARED_WIDTH_PT).toBe(39);
});

it("the checker declares none of the names the share rule had there, and imports the rule from src/lib/template-printed-width.ts", () => {
  const file = "scripts/lib/stored-template-check.ts";
  const parsed = ts.createSourceFile(
    file, readFileSync(join(process.cwd(), file), "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  // Every name the checker declares, at any depth. A comment that mentions a name declares nothing.
  const declared: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name)) {
      declared.push(node.name.text);
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name !== undefined) {
      declared.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  expect(declared.filter((name) =>
    ["MIN_SHARED_WIDTH_PT", "PADDING_PER_COLUMN", "containerTable", "sharedContainerWidth"].includes(name))).toEqual([]);
  // The checker's relative style: the command runs it under tsx from scripts/.
  const fromLeaf = parsed.statements.filter((s): s is ts.ImportDeclaration =>
    ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)
    && s.moduleSpecifier.text === "../../src/lib/template-printed-width");
  expect(fromLeaf).toHaveLength(1);
  const bindings = fromLeaf[0].importClause?.namedBindings;
  const imported = bindings !== undefined && ts.isNamedImports(bindings) ? bindings.elements.map((e) => e.name.text) : [];
  expect(imported).toEqual(expect.arrayContaining(
    ["sharedContainerWidth", "sharedWidthWords", "pt"]));
});

// Owner rulings R-A and R-B (2026-11-17, #991): the Widths cell's "no room … prints past the page" and "not measured"
// forms and the STOPS THE MERGE they carried are retired; a ticket whose container columns and padding pass the half's
// 282 pt is REFUSED by the contracts instead, and stops the merge as any refused version in use does.
describe.each(TICKETS)("%s: the container table's widths, and what stops the merge", (docType) => {
  it.each<[string, () => unknown, string]>([
    ["type-width-110, a share of 39", () => storedBefore(docType, "type-width-110"), "Containers and Tare get 39 pt each"],
    ["Container Type at 111, a share of 38.5", () => typeWidth(docType, 111), "Containers and Tare get 38.5 pt each"],
    ["type-width-130, a share of 29, which fits the page", () => storedBefore(docType, "type-width-130"), "Containers and Tare get 29 pt each"],
    ["count-hidden, where only Tare shares", () => storedBefore(docType, "count-hidden"), "Tare gets 116 pt"],
    ["Container Type at 81, a share of 53.5", () => typeWidth(docType, 81), "Containers and Tare get 53.5 pt each"],
    // The share is computed from the typed widths as stored, not from a rounded total: 38.998 reads 38.99.
    ["Container Type at 110.004, a share of 38.998", () => typeWidth(docType, 110.004), "Containers and Tare get 38.99 pt each"],
    ["Container Type at 100.4 and Cust Cont Id at 61.7, a share the listing writes as 43.9", () => {
      const config = typeWidth(docType, 100.4);
      field(config, "containers", "cust_cont_id").width = 61.7;
      return config;
    }, "Containers and Tare get 43.9 pt each"],
    ["containers-hidden", () => storedBefore(docType, "containers-hidden"), "section hidden"],
    ["container-columns-moved, named in the built-in order", () => storedBefore(docType, "container-columns-moved"), "Containers and Tare get 54 pt each"],
    ["a base size of 12, with the built-in widths", () => withFonts(seedLiteral(docType), { baseSize: 12 }), "Containers and Tare get 54 pt each"],
    ["another family the contract allows", () => withFonts(seedLiteral(docType), { family: "Roboto Mono" }), "Containers and Tare get 54 pt each"],
    ["a label typed on the Containers column", () => withContainerLabel(seedLiteral(docType), "container_count", "Qty"), "Containers and Tare get 54 pt each"],
    ["a label typed on a Containers column that has a typed width, so does not share", () => {
      const config = withContainerLabel(seedLiteral(docType), "container_count", "Qty");
      field(config, "containers", "container_count").width = 50;
      return config;
    }, "Tare gets 58 pt"],
  ])("L6: %s", (_name, config, widths) => {
    expect(row(docType, config())).toMatchObject({ verdict: "stays valid", widths, whatToDo: "listed only" });
  });

  it.each<[string, () => unknown]>([
    ["type-width-220", () => storedBefore(docType, "type-width-220")],
    ["widths-full, where only Tare shares", () => storedBefore(docType, "widths-full")],
    ["saved by this program with both shared columns typed at 60", () => {
      const config = savedNow(docType);
      field(config, "containers", "container_count").width = 60;
      field(config, "containers", "container_tare").width = 60;
      return config;
    }],
  ])("L3 under R-B: %s is REFUSED and stops the merge in use", (_name, config) => {
    const refused = row(docType, config());
    expect(refused.verdict).toMatch(PAST_THE_HALF);
    expect(refused.whatToDo).toBe("STOPS THE MERGE");
  });

  it("L6: saved by this program with every column typed, 80, 60, 60 and 50.004: each half 282.004 pt, within the budget's two decimals", () => {
    // The printed-width budget judges at two decimals, as the editor's figures and the clamp's 0.005 pt tolerance do.
    const config = savedNow(docType);
    const typed = [["container_type", 80], ["container_count", 60], ["container_tare", 60], ["cust_cont_id", 50.004]] as const;
    for (const [key, width] of typed) field(config, "containers", key).width = width;
    expect(row(docType, config)).toMatchObject({ verdict: "stays valid", widths: "none", whatToDo: "listed only" });
  });

  it("L6: saved by this program with both shared columns typed at 50 shares nothing and fits", () => {
    const config = savedNow(docType);
    field(config, "containers", "container_count").width = 50;
    field(config, "containers", "container_tare").width = 50;
    expect(row(docType, config)).toMatchObject({ verdict: "stays valid", widths: "none", whatToDo: "listed only" });
  });

  it("L6: saved by this program with its Tare column hidden, where only Containers shares", () => {
    const config = savedNow(docType);
    field(config, "containers", "container_tare").visible = false;
    expect(row(docType, config)).toMatchObject({ verdict: "stays valid", widths: "Containers gets 116 pt", whatToDo: "listed only" });
  });

  it.each<[string, () => unknown, string]>([
    ["containers-hidden", () => storedBefore(docType, "containers-hidden"), "section hidden"],
    ["saved by this program with both shared columns hidden", () => {
      const config = savedNow(docType);
      field(config, "containers", "container_count").visible = false;
      field(config, "containers", "container_tare").visible = false;
      return config;
    }, "none"],
  ])("a base size of 12 changes nothing where no shown column shares: %s", (_name, config, widths) => {
    expect(row(docType, withFonts(config(), { baseSize: 12 }))).toMatchObject({ verdict: "stays valid", widths, whatToDo: "listed only" });
  });

  it.each<[string, () => unknown, ReturnType<typeof sharedContainerWidth>]>([
    ["the seed literal", () => seedLiteral(docType), { shared: ["Containers", "Tare"], each: 54, fixedAndPadding: 348 }],
    ["count-hidden", () => storedBefore(docType, "count-hidden"), { shared: ["Tare"], each: 116, fixedAndPadding: 332 }],
    ["widths-full", () => storedBefore(docType, "widths-full"), { shared: ["Tare"], each: -32, fixedAndPadding: 628 }],
    ["containers-hidden", () => storedBefore(docType, "containers-hidden"), null],
  ])("sharedContainerWidth: %s", (_name, config, answer) => {
    // The contract's own battery: widths-full is refused by the registry since R-B, and its share is still the arithmetic's.
    expect(sharedContainerWidth(docType, validateContractConfig(contractFor(docType), config()))).toEqual(answer);
  });

  describe.each<[string, () => unknown, boolean]>([
    ["a table with a tight share", () => storedBefore(docType, "type-width-130"), false],
    ["a table at another base size", () => withFonts(seedLiteral(docType), { baseSize: 12 }), false],
    ["a refused version", () => null, true],
  ])("L7: %s", (_name, config, refused) => {
    it.each<[string, Partial<ExportedVersion>, string]>([
      ["in use on a live template", {}, "STOPS THE MERGE"],
      ["in use on a deleted template", { templateDeleted: true }, "listed only"],
      ["an earlier version", { published: false }, "listed only"],
      ["a draft", { published: false, status: "DRAFT" }, "listed only"],
      ["a discarded draft", { published: false, status: "DISCARDED" }, "listed only"],
    ])("%s: %s", (_state, over, whatToDo) => {
      expect(row(docType, config(), over).whatToDo).toBe(refused ? whatToDo : "listed only");
    });
  });
});

describe("a traveler version with a canvas layout", () => {
  it("judges a traveler version with a canvas layout: a valid one stays valid, one without a barcode is REFUSED and stops the merge when in use", () => {
    const withLayout = (layout: ReturnType<typeof standardLayout>) => ({ ...structuredClone(TRAVELER_DEFAULT_CONFIG), layout });
    expect(row("TRAVELER", withLayout(standardLayout())).verdict).toBe("stays valid");
    const bare = standardLayout();
    bare.items = bare.items.filter((item) => item.kind !== "barcode");
    const refused = row("TRAVELER", withLayout(bare));
    expect(refused.verdict).toMatch(/^REFUSED: The canvas has no barcode/);
    expect(refused.whatToDo).toBe("STOPS THE MERGE");
  });
});

describe("the other canvas types' versions with a canvas layout", () => {
  it("judges a shipping ticket version with a canvas layout: a valid one stays valid, one holding a barcode is REFUSED", () => {
    const config = { ...savedNow("SHIPPER"), layout: standardTicketLayout() };
    expect(row("SHIPPER", config).verdict).toBe("stays valid");
    const barcoded = standardTicketLayout();
    barcoded.items = [...barcoded.items, barcode({ box: { x: 402, y: 700, w: 186, h: 44 } })];
    const sentence = canvasRefusal(barcoded, SHIPPER_CONTRACT)!.sentence;
    expect(sentence).toMatch(/^The canvas has a barcode/);
    expect(row("SHIPPER", { ...config, layout: barcoded }).verdict).toBe(`REFUSED: ${sentence}`);
  });
  it("judges a bill of lading version with a canvas layout: a valid one stays valid, one holding a barcode is REFUSED", () => {
    const config = { ...savedNow("BOL"), layout: standardBolLayout() };
    expect(row("BOL", config).verdict).toBe("stays valid");
    const barcoded = standardBolLayout();
    barcoded.items = [...barcoded.items, barcode()];
    const sentence = canvasRefusal(barcoded, BOL_CONTRACT)!.sentence;
    expect(sentence).toBe("The canvas has a barcode; a bill of lading prints none.");
    expect(row("BOL", { ...config, layout: barcoded }).verdict).toBe(`REFUSED: ${sentence}`);
  });
  it("judges a certification version with a canvas layout: a valid one stays valid, one holding a barcode is REFUSED", () => {
    const config = { ...savedNow("CERT"), layout: standardCertLayout() };
    expect(row("CERT", config).verdict).toBe("stays valid");
    const barcoded = standardCertLayout();
    barcoded.items = [...barcoded.items, barcode()];
    const sentence = canvasRefusal(barcoded, CERT_CONTRACT)!.sentence;
    expect(sentence).toBe("The canvas has a barcode; a certification prints none.");
    expect(row("CERT", { ...config, layout: barcoded }).verdict).toBe(`REFUSED: ${sentence}`);
  });
  it("judges an invoice version with a canvas layout: a valid one stays valid, one holding a barcode is REFUSED", () => {
    // Reds when "INVOICE" leaves CANVAS_PRINTS (Task 1 Step 5): the valid layout is then REFUSED in
    // the later-release sentence.
    const config = { ...savedNow("INVOICE"), layout: standardInvoiceLayout() };
    expect(row("INVOICE", config).verdict).toBe("stays valid");
    const barcoded = standardInvoiceLayout();
    barcoded.items = [...barcoded.items, barcode()];
    const sentence = canvasRefusal(barcoded, INVOICE_CONTRACT)!.sentence;
    expect(sentence).toBe("The canvas has a barcode; an invoice prints none.");
    expect(row("INVOICE", { ...config, layout: barcoded }).verdict).toBe(`REFUSED: ${sentence}`);
  });
  it("judges a statement version with a canvas layout: a valid one stays valid, one holding a barcode is REFUSED", () => {
    // Reds when "STATEMENT" leaves CANVAS_PRINTS: the valid layout is then REFUSED in
    // the later-release sentence.
    const config = { ...savedNow("STATEMENT"), layout: standardStatementLayout() };
    expect(row("STATEMENT", config).verdict).toBe("stays valid");
    const barcoded = standardStatementLayout();
    barcoded.items = [...barcoded.items, barcode()];
    const sentence = canvasRefusal(barcoded, STATEMENT_CONTRACT)!.sentence;
    expect(sentence).toBe("The canvas has a barcode; a statement prints none.");
    expect(row("STATEMENT", { ...config, layout: barcoded }).verdict).toBe(`REFUSED: ${sentence}`);
  });
  it("judges a quotation version with a canvas layout: a valid one stays valid, one holding a barcode is REFUSED", () => {
    // Since quote canvas PR 2 (design 2026-11-12 §7). Reds when "QUOTE" leaves CANVAS_PRINTS: the
    // valid layout is then REFUSED in the later-release sentence.
    const config = { ...savedNow("QUOTE"), layout: standardQuoteLayout() };
    expect(row("QUOTE", config).verdict).toBe("stays valid");
    const barcoded = standardQuoteLayout();
    barcoded.items = [...barcoded.items, barcode()];
    const sentence = canvasRefusal(barcoded, QUOTE_CONTRACT)!.sentence;
    expect(sentence).toBe("The canvas has a barcode; a quote prints none.");
    expect(row("QUOTE", { ...config, layout: barcoded }).verdict).toBe(`REFUSED: ${sentence}`);
  });
});

describe("the listing as text", () => {
  const noRoom = version("SHIPPER", storedBefore("SHIPPER", "type-width-220"));
  const tight = version("SHIPPER", storedBefore("SHIPPER", "type-width-130"));

  it("is one Markdown table under the database's name, with a bar escaped and a line break made a space", () => {
    const config = storedBefore("CERT", "typed-label");
    field(config, "parts", "part_pounds").label = "Lbs\n| net";
    const cert = version("CERT", config, { templateName: "Acme cert", isDefault: false, versionNumber: 3, customers: [{ code: "ACME", name: "Acme Forge" }] });
    expect(listing("erp", [cert, tight])).toBe([
      "## erp",
      "",
      "| Document | Template | Version | Status | Customers | Verdict | Typed labels | Hidden | Moved | Widths | What to do |",
      "|---|---|---|---|---|---|---|---|---|---|---|",
      '| Certification | Acme cert | 3 | in use | ACME | stays valid | Pounds typed as "Lbs \\| net" | none | none | none | listed only |',
      "| Shipping ticket | Standard (default) | 1 | in use | none | stays valid | none | none | none | Containers and Tare get 29 pt each | listed only |",
    ].join("\n"));
  });

  it("stopsTheMerge is true when a row reads STOPS THE MERGE, and false when none does", () => {
    const clean = version("SHIPPER", seedLiteral("SHIPPER"));
    expect(stopsTheMerge([clean, noRoom])).toBe(true);
    expect(stopsTheMerge([clean, { ...noRoom, templateDeleted: true }])).toBe(false);
  });

  it("a status or a document type the checker does not know is refused by name, not listed", () => {
    expect(() => row("CERT", seedLiteral("CERT"), { published: false, status: "ARCHIVED" }))
      .toThrow("Version v-1 has a status this checker does not know: ARCHIVED");
    expect(() => row("PACKING_SLIP", seedLiteral("CERT")))
      .toThrow("Version v-1 has a document type this checker does not know: PACKING_SLIP");
  });
});

it("a status the checker does not know is refused on a version the pointer names too", () => {
  expect(() => row("CERT", seedLiteral("CERT"), { published: true, status: "ARCHIVED" }))
    .toThrow("Version v-1 has a status this checker does not know: ARCHIVED");
});

describe("OLD_BUILT_IN_LABELS", () => {
  it("holds every built-in label that differs from its frozen wording, with that wording, and no other field", () => {
    const changed: Record<string, Record<string, string>> = {};
    // The frozen labels are the eight first-seed types' (the container tag came after them).
    for (const docType of FIRST_SEED_TYPES) {
      const before = builtInLabelsBefore(docType);
      for (const f of contractFor(docType).sections.flatMap((s) => s.fields)) {
        if (Object.hasOwn(before, f.key) && before[f.key] !== f.defaultLabel) (changed[docType] ??= {})[f.key] = before[f.key];
      }
    }
    expect(OLD_BUILT_IN_LABELS).toEqual(changed);
  });
});

describe("scripts/check-stored-templates.ts, the command", () => {
  const dir = mkdtempSync(join(tmpdir(), "stored-templates-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const clean = version("CERT", seedLiteral("CERT"));
  // Past the half's 282 pt: REFUSED by the contracts since owner ruling R-B (#991), so it stops the merge in use.
  const noRoom = version("SHIPPER", storedBefore("SHIPPER", "type-width-220"));
  /** Runs the command on a file of these lines. An array is one database's export for each entry. */
  async function check(lines: unknown[] | string): Promise<{ code: number; stdout: string; stderr: string }> {
    const file = join(dir, "export.jsonl");
    writeFileSync(file, typeof lines === "string" ? lines : `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    const args = [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "scripts/check-stored-templates.ts", file];
    // The command's own environment holds none of the three names that say where the temporary
    // folder is: tsx opens a socket under that folder, and a long path there is refused, whatever
    // the command does. The cases at the end of this block hold each name.
    const env = { ...process.env };
    delete env.TMPDIR;
    delete env.TMP;
    delete env.TEMP;
    return promisify(execFile)(process.execPath, args, { cwd: process.cwd(), env }).then(
      (ran) => ({ code: 0, stdout: ran.stdout, stderr: ran.stderr }),
      (failed: { code: number; stdout: string; stderr: string }) => ({ code: failed.code, stdout: failed.stdout, stderr: failed.stderr }));
  }

  it("prints each database's listing and exits 0 when no row stops the merge", async () => {
    const ran = await check([{ database: "erp", versions: [clean] }, { database: "erp_practice", versions: [clean] }]);
    expect({ code: ran.code, stdout: ran.stdout })
      .toEqual({ code: 0, stdout: `${listing("erp", [clean])}\n\n${listing("erp_practice", [clean])}\n` });
  }, 30_000);

  it("exits 1 when a row stops the merge, and still prints the listing", async () => {
    const ran = await check([{ database: "erp", versions: [clean, noRoom] }]);
    expect({ code: ran.code, stdout: ran.stdout }).toEqual({ code: 1, stdout: `${listing("erp", [clean, noRoom])}\n` });
  }, 30_000);

  it.each<[string, unknown[] | string, RegExp]>([
    ["a flag that is null on a version with no room", [{ database: "erp", versions: [{ ...noRoom, published: null }] }],
      /^Line 1 of .+ is not one database's export: versions\.0\.published: /],
    ["a line that is not JSON", '{"database":"erp","versions":}\n', /^Line 1 of .+ is not one database's export: /],
    // The shape, and none of the validator's own words: after the command's words, one colon and
    // a space, then a reason that begins with neither a colon nor a space, on the one line.
    ["a line that is JSON and not an object, with one colon before its reason", "[1]\n",
      /^Line 1 of .+ is not one database's export: [^:\s].*\n$/],
    ["no line at all", "\n", /holds no line/],
    ["a status it does not know, in the second database", [
      { database: "erp", versions: [clean] },
      { database: "erp_practice", versions: [{ ...clean, published: false, status: "ARCHIVED" }] },
    ], /^Version v-1 has a status this checker does not know: ARCHIVED/],
  ])("exits 2 and prints no listing for %s", async (_name, lines, stderr) => {
    const ran = await check(lines);
    expect({ code: ran.code, stdout: ran.stdout }).toEqual({ code: 2, stdout: "" });
    expect(ran.stderr).toMatch(stderr);
  }, 30_000);

  // Each of the three names alone, set long in the suite's own environment.
  it.each(["TMPDIR", "TMP", "TEMP"])("runs under a long %s of the suite's own, which its spawn does not hand on", async (name) => {
    // Long enough that a socket path under it passes what the system allows.
    const long = join(dir, "t".repeat(120));
    mkdirSync(long, { recursive: true });
    const before = process.env[name];
    process.env[name] = long;
    try {
      const ran = await check([{ database: "erp", versions: [clean] }]);
      expect({ code: ran.code, stdout: ran.stdout }).toEqual({ code: 0, stdout: `${listing("erp", [clean])}\n` });
    } finally {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    }
  }, 30_000);
});
