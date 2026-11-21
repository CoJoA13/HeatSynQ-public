import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jsxTags, jsxTexts, mentions } from "./helpers/jsx-source";

// How the Invoicing list is shaped since PR 6 of the UX redesign (spec §4.5; the owner's rulings of
// 2026-10-31 on #821): a PageHeader titled "Invoicing", Create invoices its action on the Ready
// view; four ListTabs from `src/lib/invoicing-list.ts`, Ready to invoice drawing the candidates
// table alone and the other three the register, headed "Invoices & credits", with its filter bar
// (now with a Printed select) and the ticks and Print selected kept on every preset; Print selected
// asking through the modal. Read as source: vitest has no DOM, and the page's behaviour is its
// lifted suites' (invoicing-list-print-selected, invoicing-list-create-keys) and the markup pins of
// invoicing-screens.test.ts.

const PAGE = "src/app/invoicing/InvoicingList.tsx";
const src = readFileSync(fileURLToPath(new URL(`../${PAGE}`, import.meta.url)), "utf8");
const tags = jsxTags(PAGE);
const named = (name: string) => tags.filter((t) => t.name === name);
const squash = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ");

describe("the Invoicing list's shape (PR 6)", () => {
  it("mounts one PageHeader titled Invoicing, Create invoices its action on the Ready view", () => {
    expect(named("PageHeader").length).toBe(1);
    expect(named("PageHeader")[0].attr("title")).toBe("Invoicing");
    expect(named("h1").length).toBe(0);
    const actions = squash(named("PageHeader")[0].attr("actions"));
    expect(actions).toContain('filters.view === "ready"');
    expect(actions).toContain("createInvoices");
    expect(src).toContain('{creating ? "Creating…" : "Create invoices"}');
  });

  it("mounts the four views as ListTabs over the leaf's presets, derived from the filters", () => {
    const tabs = named("ListTabs");
    expect(tabs.length).toBe(1);
    expect(tabs[0].attr("tabs")).toBe("INVOICING_PRESETS");
    expect(tabs[0].attr("active")).toBe("presetFor(filters)");
    expect(squash(tabs[0].attr("onSelect"))).toContain("applyPreset(prev, key as InvoicingPresetKey)");
    expect(src).toContain('const DEFAULT_FILTERS: Filters = { view: "ready",');
  });

  it("heads the candidates Ready to invoice and the register Invoices & credits, one view at a time", () => {
    const heads = jsxTexts(PAGE, "h2");
    expect(heads).toContain("Ready to invoice");
    expect(heads).toContain("Invoices & credits");
    expect(heads).not.toContain("Invoices");
    // Each view's branch, so the hidden one is not in the DOM (nothing stateful lives in the markup).
    expect(src).toContain('{filters.view === "ready" ? (');
  });

  it("keeps every register control: the filters, a labelled Printed select, both exports, the ticks and Print selected", () => {
    const printed = named("select").find((t) => t.attr("id") === "invoicing-printed");
    expect(printed).toBeDefined();
    expect(printed?.attr("value")).toBe("filters.printed");
    expect(named("label").some((t) => t.attr("htmlFor") === "invoicing-printed")).toBe(true);
    expect(src).toContain('if (filters.printed) params.set("printed", filters.printed);');
    expect(src).toContain('<option value="">Printed or not</option>');
    expect(named("ExportLink").length).toBe(2);
    expect(src).toContain('{printing ? "Printing…" : "Print selected"}');
    expect(src).toContain('aria-label="Select all finalized invoices not yet printed"');
  });

  it("asks Print selected through the modal, with the ruled sentence split into title and body", () => {
    expect(src).not.toMatch(/\bconfirm\(/);
    expect(mentions(PAGE, "askConfirm")).toBe(2); // the import and the ask
    expect(src).toContain('await askConfirm({ ...confirmParts(ids.length), confirm: "Print selected" })');
  });
});
