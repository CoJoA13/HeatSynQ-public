import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jsxTags, jsxTexts } from "./helpers/jsx-source";

// How the certifications list is shaped since PR 5 of the UX redesign (spec §4.5; the owner's
// rulings of 2026-10-31 on #820): a PageHeader whose one action is Export to Excel, the Not printed
// / All certifications presets over the ONE table (the Printed select and the Show voided box stay;
// a preset is a state of the select), the filter bar and the table in cards, the Scope cell holding
// the subject, the customer as its name, Printed as Yes / No. Read as source: vitest has no DOM.

const PAGE = "src/app/certs/CertList.tsx";
const src = readFileSync(fileURLToPath(new URL(`../${PAGE}`, import.meta.url)), "utf8");
const tags = jsxTags(PAGE);
const named = (name: string) => tags.filter((t) => t.name === name);

describe("the certifications list's shape (PR 5)", () => {
  it("mounts a PageHeader whose one action is the Excel export", () => {
    expect(named("PageHeader").length).toBe(1);
    expect(named("PageHeader")[0].attr("title")).toBe("Certifications");
    expect(named("PageHeader")[0].attr("actions")).toContain("/api/certs/export");
    expect(named("h1").length).toBe(0);
  });

  it("mounts the two presets, derived from the filters, with the Printed select and Show voided kept", () => {
    expect(named("ListTabs").length).toBe(1);
    expect(named("ListTabs")[0].attr("tabs")).toBe("CERT_PRESETS");
    expect(named("ListTabs")[0].attr("active")).toBe("presetFor(filters)");
    const printed = named("select").find((t) => (t.attr("value") ?? "") === "filters.printed");
    expect(printed).toBeDefined();
    const voided = named("input").find((t) => t.attr("type") === "checkbox" && (t.attr("checked") ?? "") === "filters.includeVoided");
    expect(voided).toBeDefined();
    expect(src).toContain("Show voided");
  });

  // #643 (the owner's answer of 2026-11-06): the search box and the three selects are named by a
  // label above each, in the board's words, in the shipping list's form; the placeholder options stay.
  it("names the search box and each select by its own label (#643)", () => {
    const texts = jsxTexts(PAGE, "label");
    const byFor = new Map(named("label").map((l, i) => [l.attr("htmlFor"), texts[i]]));
    const boxes: [string, string, string][] = [
      ["input", "filters.search", "Search"], ["select", "filters.customerId", "Customer"],
      ["select", "filters.scope", "Scope"], ["select", "filters.printed", "Printed"],
    ];
    for (const [tag, value, word] of boxes) {
      const id = tags.find((t) => t.name === tag && t.attr("value") === value)?.attr("id");
      expect(`${value}: ${id ? byFor.get(id) : "no id"}`).toBe(`${value}: ${word}`);
    }
    for (const option of ["All customers", "All scopes", "Printed or not"]) expect(src).toContain(option);
  });

  it("heads five columns, the Scope cell holding the subject, the customer its name, Printed Yes / No", () => {
    expect(jsxTexts(PAGE, "th")).toEqual(["Order", "Customer", "Scope", "Printed", "Results"]);
    expect(src).toContain("scopeCell(row)");
    expect(src).not.toContain("loadOrShipment");
    expect(src).not.toMatch(/customerCode\} ·/);
    expect(src).toMatch(/\? "Yes" : "No"/);
    expect(src).toContain("colSpan={5}");
  });
});
