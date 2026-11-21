import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildStatementDefinition, type StatementData, type StatementOpenItem } from "@/server/pdf/statement";
import { STATEMENT_DEFAULT_CONFIG, validateConfig, type TemplateConfig } from "@/lib/template-contracts/index";
import type { DateFormat, FontFamily, LogoPlacement, NegativeStyle } from "@/lib/template-contracts/types";
import { sampleStatement } from "./helpers/statement-canvas-fixtures";

/**
 * The statement flow's frozen node trees (statement canvas PR 2, plan Task 1). The goldens of
 * tests/statement-pdf.test.ts assert text, never widths, so a refactor of `pdf/statement.ts` that moved
 * a width, a gap or a margin would pass them (the cert ledger's Task 1 lesson). This file freezes
 * `buildStatementDefinition`'s JSON for a matrix of data and configs, written once at the base
 * (`STATEMENT_ORACLE_WRITE=1`, against 33f4c164's pdf/statement.ts, which 6c8a877d holds unchanged), and
 * deep-equals every later build against it: a statement template whose `layout` is null builds exactly
 * the definition it built before the canvas lane.
 *
 * THIS FILE AND ITS FIXTURE ARE NEVER EDITED after the commit that wrote them (the plan's `ORACLE_SHA`
 * check: `git diff --quiet "$ORACLE_SHA" HEAD -- <both>`). A case a review wants goes in a SECOND oracle
 * file, frozen from `git show 33f4c164:erp/src/server/pdf/statement.ts` (copied into the tree for the
 * one write, then removed), never into this one. The writer stays in the file; that diff, not the
 * writer's absence, is what catches a rewrite.
 *
 * The enum axes are hand-listed, typed against their unions, never iterated off the exported
 * constants: a member added to `FONT_FAMILIES` (say) must not change this matrix's keys.
 */

const ORACLE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "statement-flow-oracle.json");
/** A stand-in logo: the builder places the string it is handed and reads nothing of it. */
const LOGO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
/** `validateConfig`'s font-size bounds (types.ts's private FONT_SIZE_MIN and FONT_SIZE_MAX); the
 *  "(pin)" case below holds these literals to the validator. */
const FONT_MIN = 4;
const FONT_MAX = 72;

const NEGATIVE: NegativeStyle[] = ["SIGN_AFTER_SYMBOL", "LEADING_MINUS", "PARENTHESES"];
const DATES: DateFormat[] = ["M/D/YYYY", "MM/DD/YYYY", "YYYY-MM-DD", "MMMM D, YYYY", "MMM - DD - YYYY"];
const FAMILIES: FontFamily[] = ["Roboto", "Liberation Sans", "Liberation Serif", "Roboto Mono"];
const PLACEMENTS: LogoPlacement[] = ["header-left", "header-center", "header-right"];
const SECTIONS = ["header", "identity", "open_items", "aging", "finance_charge", "total"];
const LEFT = ["customer", "statement_date", "bill_to"];
const AGING = ["aging_current", "aging_1_30", "aging_31_60", "aging_61_90", "aging_90_plus", "aging_unapplied", "aging_net"];

/** The default config edited by `edit`, then validated and backfilled as a template stores it. */
function configWith(edit: (c: TemplateConfig) => void): TemplateConfig {
  const c = structuredClone(STATEMENT_DEFAULT_CONFIG);
  edit(c);
  return validateConfig("STATEMENT", c);
}
const section = (c: TemplateConfig, key: string) => c.sections.find((s) => s.key === key)!;
const field = (c: TemplateConfig, sectionKey: string, key: string) => section(c, sectionKey).fields.find((f) => f.key === key)!;
/** Moves section `key` to index `to` of the config's order. */
function moveSection(c: TemplateConfig, key: string, to: number): void {
  const [moved] = c.sections.splice(c.sections.findIndex((s) => s.key === key), 1);
  c.sections.splice(to, 0, moved);
}
/** Section `key` placed directly after section `after`. */
function moveAfter(c: TemplateConfig, key: string, after: string): void {
  const [moved] = c.sections.splice(c.sections.findIndex((s) => s.key === key), 1);
  c.sections.splice(c.sections.findIndex((s) => s.key === after) + 1, 0, moved);
}
/** A section's fields reordered to `keys` (the keys it names, in that order, then the rest as they stood). */
function orderFields(c: TemplateConfig, sectionKey: string, keys: string[]): void {
  const s = section(c, sectionKey);
  const named = keys.map((k) => s.fields.find((f) => f.key === k)!);
  s.fields = [...named, ...s.fields.filter((f) => !keys.includes(f.key))];
}
const withLogo = (placement: LogoPlacement, edit: (c: TemplateConfig) => void = () => {}) =>
  configWith((c) => { c.logo = { placement, width: 80 }; edit(c); });

/** A run that assessed a finance charge: the finance line prints (#162: Total Due excludes it). */
const assessed = (): StatementData => sampleStatement({ financeCharge: 12.34 });

/** A credit and an on-account payment beside an invoice, a net-negative aging row and a negative
 *  Total Due: negative money in the open items' Original and Open, the aging's buckets and the total. */
const negatives = (): StatementData => sampleStatement({
  openItems: [
    { documentNumber: "7 - 92026", date: "2026-06-29", dueDate: "2026-06-29", kind: "INVOICE", original: 1000, open: 100 },
    { documentNumber: "1000", date: "2026-07-19", dueDate: null, kind: "CREDIT", original: -200, open: -200 },
    { documentNumber: "CHK 4471", date: "2026-07-25", dueDate: null, kind: "PAYMENT", original: -1234.5, open: -1234.5 },
  ],
  aging: {
    customerId: "cust-1", customerCode: "C100", customerName: "Demo Foundry - Columbus LLC",
    current: -50, d1_30: 0, d31_60: 100, d61_90: 0, d90_plus: 0, unapplied: 1434.5, net: -1384.5,
  },
  financeCharge: null,
  totalDue: -1384.5,
});

/** 300 open items, built deterministically (no clock): an invoice with a due date, every tenth a
 *  credit with none, dates cycling through July. */
const manyItems = (): StatementData => {
  const openItems: StatementOpenItem[] = Array.from({ length: 300 }, (_, i) => {
    const day = `2026-07-${String(1 + (i % 28)).padStart(2, "0")}`;
    return i % 10 === 9
      ? { documentNumber: `C${2000 + i}`, date: day, dueDate: null, kind: "CREDIT", original: -(10 + i), open: -(10 + i) }
      : { documentNumber: `${7000 + i} - 9${i}`, date: day, dueDate: day, kind: "INVOICE", original: 100 + i * 3.25, open: 50 + i };
  });
  return sampleStatement({ openItems, totalDue: 98765.43 });
};

/** A typed label on every field of the contract. */
const TYPED_LABELS: [string, string, string][] = [
  ["header", "title", "Account Statement"], ["header", "company_name", "Company"],
  ["identity", "customer", "Account:"], ["identity", "statement_date", "As of:"],
  ["identity", "bill_to", "Mail To"], ["identity", "remit_to", "Pay To"],
  ["open_items", "document_no", "Doc"], ["open_items", "date", "Dated"], ["open_items", "due_date", "Due"],
  ["open_items", "original", "Amount"], ["open_items", "open", "Balance"],
  ["aging", "aging_current", "Now"], ["aging", "aging_1_30", "1-30"], ["aging", "aging_31_60", "31-60"],
  ["aging", "aging_61_90", "61-90"], ["aging", "aging_90_plus", "90+"], ["aging", "aging_unapplied", "Credits"],
  ["aging", "aging_net", "Balance"],
  ["finance_charge", "finance_charge", "Interest (info only):"], ["total", "total_due", "Please Pay:"],
];
const LONG_UNBROKEN = "ACCOUNTNUMBERREFERENCELABELWITHNOSPACESATALLTOBREAKONXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

type Case = { data: StatementData; config?: TemplateConfig; logo?: string };
const CASES: Record<string, () => Case> = {
  "the Standard": () => ({ data: sampleStatement() }),

  // Each section hidden, one at a time (finance's over an assessed run, or it hides nothing).
  ...Object.fromEntries(SECTIONS.map((key) => [`the ${key} section hidden`, (): Case => ({
    data: assessed(), config: configWith((c) => { section(c, key).visible = false; }),
  })])),

  // Reorders. Section order is a plain concatenation, so these cover every order's seams. Each is over
  // an assessed run, so the finance section prints wherever it lands.
  "finance below total": () => ({ data: assessed(), config: configWith((c) => { moveAfter(c, "finance_charge", "total"); }) }),
  "open items above identity": () => ({ data: assessed(), config: configWith((c) => { moveSection(c, "open_items", 0); }) }),
  "aging above open items": () => ({ data: assessed(), config: configWith((c) => { moveAfter(c, "open_items", "aging"); }) }),
  "header last": () => ({ data: assessed(), config: configWith((c) => { moveSection(c, "header", SECTIONS.length - 1); }) }),
  ...Object.fromEntries(SECTIONS.map((_, i) => [`the order rotated to put ${SECTIONS[i]} first`, (): Case => ({
    data: assessed(),
    config: configWith((c) => { c.sections = [...c.sections.slice(i), ...c.sections.slice(0, i)]; }),
  })])),

  // The header.
  "title hidden": () => ({ data: sampleStatement(), config: configWith((c) => { field(c, "header", "title").visible = false; }) }),
  "company_name hidden": () => ({
    data: sampleStatement(), config: configWith((c) => { field(c, "header", "company_name").visible = false; }),
  }),
  "title and company_name hidden, no logo (the early return)": () => ({
    data: sampleStatement(),
    config: configWith((c) => { for (const key of ["title", "company_name"]) field(c, "header", key).visible = false; }),
  }),
  "title and company_name hidden under a header-left logo (a side column over an empty stack)": () => ({
    data: sampleStatement(),
    config: withLogo("header-left", (c) => { for (const key of ["title", "company_name"]) field(c, "header", key).visible = false; }),
    logo: LOGO,
  }),
  "company_name before title under a header-center logo": () => ({
    data: sampleStatement(), config: withLogo("header-center", (c) => { orderFields(c, "header", ["company_name", "title"]); }), logo: LOGO,
  }),
  "config.logo set with no logoDataUri (the null logo)": () => ({ data: sampleStatement(), config: withLogo("header-left") }),

  // The identity's left column: each order of its three fields (the Remit To after them), each field
  // hidden, the three left fields hidden together.
  ...Object.fromEntries([
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ].map((p) => p.map((i) => LEFT[i])).map((keys) => [`identity left column ordered ${keys.join(", ")}`, (): Case => ({
    data: sampleStatement(), config: configWith((c) => { orderFields(c, "identity", keys); }),
  })])),
  ...Object.fromEntries([...LEFT, "remit_to"].map((key) => [`identity ${key} hidden`, (): Case => ({
    data: sampleStatement(), config: configWith((c) => { field(c, "identity", key).visible = false; }),
  })])),
  "the three left identity fields hidden (the Remit To alone)": () => ({
    data: sampleStatement(), config: configWith((c) => { for (const key of LEFT) field(c, "identity", key).visible = false; }),
  }),

  // Typed labels.
  "every field's label typed": () => ({
    data: assessed(), config: configWith((c) => { for (const [s, k, label] of TYPED_LABELS) field(c, s, k).label = label; }),
  }),
  "long unbroken typed labels on customer and bill_to": () => ({
    data: sampleStatement(),
    config: configWith((c) => { for (const key of ["customer", "bill_to"]) field(c, "identity", key).label = LONG_UNBROKEN; }),
  }),

  // Field hides.
  "every open-items field hidden": () => ({
    data: sampleStatement(), config: configWith((c) => { for (const f of section(c, "open_items").fields) f.visible = false; }),
  }),
  "every aging field hidden": () => ({
    data: sampleStatement(), config: configWith((c) => { for (const f of section(c, "aging").fields) f.visible = false; }),
  }),
  "the finance_charge field hidden with a finance charge present": () => ({
    data: assessed(), config: configWith((c) => { field(c, "finance_charge", "finance_charge").visible = false; }),
  }),
  "the total_due field hidden": () => ({
    data: assessed(), config: configWith((c) => { field(c, "total", "total_due").visible = false; }),
  }),

  // The open-items and aging fields.
  "due_date hidden": () => ({ data: sampleStatement(), config: configWith((c) => { field(c, "open_items", "due_date").visible = false; }) }),
  "the open-items fields reordered": () => ({
    data: sampleStatement(), config: configWith((c) => { orderFields(c, "open_items", ["open", "original", "document_no", "due_date", "date"]); }),
  }),
  ...Object.fromEntries(AGING.map((key) => [`aging ${key} hidden`, (): Case => ({
    data: sampleStatement(), config: configWith((c) => { field(c, "aging", key).visible = false; }),
  })])),
  "typed aging widths (aging_net 120, aging_current 40)": () => ({
    data: sampleStatement(),
    config: configWith((c) => { field(c, "aging", "aging_net").width = 120; field(c, "aging", "aging_current").width = 40; }),
  }),

  // Formats.
  ...Object.fromEntries(NEGATIVE.map((style) => [`negativeStyle ${style}`, (): Case => ({
    data: sampleStatement(), config: configWith((c) => { c.formats.negativeStyle = style; }),
  })])),
  "priceDecimals 4": () => ({ data: assessed(), config: configWith((c) => { c.formats.priceDecimals = 4; }) }),
  "thousandsSeparator off": () => ({ data: sampleStatement(), config: configWith((c) => { c.formats.thousandsSeparator = false; }) }),
  ...Object.fromEntries(DATES.map((format) => [`dateFormat ${format}`, (): Case => ({
    data: sampleStatement(), config: configWith((c) => { c.formats.dateFormat = format; }),
  })])),

  // Fonts.
  ...Object.fromEntries(FAMILIES.map((family) => [`font family ${family}`, (): Case => ({
    data: sampleStatement(), config: configWith((c) => { c.fonts.family = family; }),
  })])),
  ...Object.fromEntries((["baseSize", "headingSize", "smallSize"] as const).flatMap((knob) => [FONT_MIN, FONT_MAX].map((size) =>
    [`${knob} ${size}`, (): Case => ({ data: sampleStatement(), config: configWith((c) => { c.fonts[knob] = size; }) })]))),

  // The logo at each placement, and the page line on.
  ...Object.fromEntries(PLACEMENTS.map((placement) => [`a ${placement} logo`, (): Case => ({
    data: sampleStatement(), config: withLogo(placement), logo: LOGO,
  })])),
  "pageFooter on": () => ({ data: sampleStatement(), config: configWith((c) => { c.pageFooter = true; }) }),

  // Data.
  "a finance charge present": () => ({ data: assessed() }),
  "a finance charge absent (null)": () => ({ data: sampleStatement({ financeCharge: null }) }),
  "no open items": () => ({ data: sampleStatement({ openItems: [] }) }),
  "300 open items": () => ({ data: manyItems() }),
  "an R14 bill-to": () => ({
    data: sampleStatement({ customer: { ...sampleStatement().customer, billTo: ["Accounts Payable", ...sampleStatement().customer.billTo] } }),
  }),
  "a one-line bill-to": () => ({ data: sampleStatement({ customer: { ...sampleStatement().customer, billTo: ["Demo Foundry - Columbus LLC"] } }) }),
  "a four-line company address": () => ({
    data: sampleStatement({
      company: { ...sampleStatement().company, address: "Building 4\n100 Example Way\nSuite 200\nAnniston AL 36207" },
      remitTo: { ...sampleStatement().remitTo, lines: ["Building 4", "100 Example Way", "Suite 200", "Anniston AL 36207"] },
    }),
  }),
  ...Object.fromEntries(NEGATIVE.map((style) => [`a credit and an on-account payment under ${style}`, (): Case => ({
    data: negatives(), config: configWith((c) => { c.formats.negativeStyle = style; }),
  })])),
  "a customer name long enough to wrap": () => ({
    data: sampleStatement({
      customer: {
        ...sampleStatement().customer,
        name: "Demo Foundry and Precision Forging Holdings of Columbus Georgia - Eastern Division Receiving Dock LLC",
      },
    }),
  }),
};

function built(name: string): unknown {
  const { data, config, logo } = CASES[name]();
  return JSON.parse(JSON.stringify(buildStatementDefinition(data, config, logo)));
}

describe("the statement flow's frozen definitions (statement canvas PR 2, Task 1)", () => {
  it.skipIf(process.env.STATEMENT_ORACLE_WRITE !== "1")("writes the oracle (STATEMENT_ORACLE_WRITE=1, at the base commit only)", () => {
    const out = Object.fromEntries(Object.keys(CASES).map((name) => [name, built(name)]));
    writeFileSync(ORACLE, `${JSON.stringify(out, null, 1)}\n`);
  });

  const oracle = (): Record<string, unknown> => JSON.parse(readFileSync(ORACLE, "utf8")) as Record<string, unknown>;

  it("holds exactly the matrix's cases (pin)", () => {
    expect(Object.keys(oracle())).toEqual(Object.keys(CASES));
  });

  it("the font-size bounds the matrix prints at are the validator's (pin)", () => {
    for (const knob of ["baseSize", "headingSize", "smallSize"] as const) {
      expect(() => configWith((c) => { c.fonts[knob] = FONT_MIN - 0.1; })).toThrow();
      expect(() => configWith((c) => { c.fonts[knob] = FONT_MAX + 0.1; })).toThrow();
    }
  });

  it.each(Object.keys(CASES))("%s builds the definition it built at the base commit", (name) => {
    expect(built(name)).toEqual(oracle()[name]);
  });
});
