import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jsxTags, jsxTexts, mentions } from "./helpers/jsx-source";

// How the two Customers screens are shaped since PR 8 of the UX redesign (spec §4.3–§4.5; the
// owner's rulings of 2026-11-01 on #823). Read as source: vitest has no DOM, and each page's
// behaviour is its lifted suites' (money-single-boxes, rate-single-boxes, part-boxes-screens,
// enter-commit-false, customer-invoice-folder, unreadable-answer, …).

const read = (page: string) => readFileSync(fileURLToPath(new URL(`../${page}`, import.meta.url)), "utf8");
const named = (page: string, name: string) => jsxTags(page).filter((t) => t.name === name);
const squash = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ");

describe("the customers list's shape (PR 8)", () => {
  const PAGE = "src/app/customers/page.tsx";
  const src = read(PAGE);

  it("mounts one PageHeader titled Customers with Add customer, Paste from spreadsheet and the menu, the two views over the box", () => {
    const header = named(PAGE, "PageHeader");
    expect(header.length).toBe(1);
    expect(header[0].attr("title")).toBe("Customers");
    expect(named(PAGE, "h1").length).toBe(0);
    const tabs = named(PAGE, "ListTabs");
    expect(tabs.length).toBe(1);
    expect(tabs[0].attr("label")).toBe("CUSTOMER_VIEWS_LABEL");
    expect(tabs[0].attr("tabs")).toBe("CUSTOMER_PRESETS");
    expect(squash(tabs[0].attr("active"))).toBe("presetFor({ showInactive })");
    // The Show inactive box is gone: the two views are its states.
    expect(jsxTags(PAGE).some((t) => t.attr("type") === "checkbox")).toBe(false);
    const menu = named(PAGE, "ActionMenu");
    expect(menu.length).toBe(1);
    expect(squash(menu[0].attr("items"))).toContain('label: "Export to Excel", href: exportHref');
    expect(src).toContain("const exportHref = `/api/customers/export${query ? `?${query}` : \"\"}`;");
    const buttons = jsxTexts(PAGE, "button");
    expect(buttons).toContain("Add customer");
    expect(buttons).toContain("Add");
    expect(mentions(PAGE, "focusNewCustomer")).toBe(2); // the function and the header button's onClick
    expect(src).toContain("ref={codeRef}"); // the ref on the Code box, not only its declaration (review minor 4)
  });

  it("carries the renames: a Credit hold column with Yes / No, Active as Yes / No, no pill", () => {
    expect(jsxTexts(PAGE, "th")).toEqual(["Code", "Name", "Parent", "Credit hold", "Active"]);
    expect(mentions(PAGE, "yesNo")).toBe(3); // the import and the two cells
    expect(mentions(PAGE, "BADGE_DANGER")).toBe(0);
    expect(src).not.toContain('"yes"');
  });
});

describe("the customer page's shape (PR 8)", () => {
  const PAGE = "src/app/customers/[id]/page.tsx";
  const src = read(PAGE);

  it("mounts one PageHeader titled by code and name with the leaf's subtitle, Delete customer the danger action", () => {
    const header = named(PAGE, "PageHeader");
    expect(header.length).toBe(1);
    expect(squash(header[0].attr("title"))).toBe("`${c.code} — ${c.name}`");
    expect(header[0].attr("subtitle")).toBe("customerSubtitle(c)");
    expect(named(PAGE, "h1").length).toBe(0);
    const danger = named(PAGE, "DangerButton");
    expect(danger.length).toBe(1);
    expect(danger[0].attr("disabled")).toBe("canDelete.disabled");
    expect(jsxTexts(PAGE, "DangerButton")).toEqual(["Delete customer"]);
  });

  it("mounts the six tabs over every section, once each, with the card beside them", () => {
    const tabs = named(PAGE, "RecordTabs");
    expect(tabs.length).toBe(1);
    expect(tabs[0].attr("label")).toBe("CUSTOMER_TAB_LABEL");
    expect(tabs[0].attr("tabs")).toBe("customerTabs()");
    const panels = tabs[0].attr("panels") ?? "";
    for (const key of ["overview", "addresses", "terms", "defaults", "receivables", "history"]) {
      expect(panels).toMatch(new RegExp(`(^|[{,\\s])${key}:`));
    }
    for (const id of ["identity", "standing-notes", "addresses", "contacts", "commercial", "surcharge-overrides",
      "order-defaults", "document-templates", "receivables", "history"]) {
      expect(jsxTags(PAGE).some((t) => t.attr("id") === id), id).toBe(true);
    }
    for (const component of ["HistoryPanel", "ReceivablesSection", "SurchargeOverridesSection", "TemplateAssignmentsSection", "BlockerPanel"]) {
      expect(`${component}: ${named(PAGE, component).length}`).toBe(`${component}: 1`);
    }
    expect(named(PAGE, "ReceivablesSection")[0].attr("onBalance")).toBe("setOpenBalance");
    const card = squash(named(PAGE, "AtAGlance")[0].attr("rows"));
    for (const label of ['"Terms"', '"Credit hold"', '"Open balance"']) expect(card).toContain(label);
    expect(card).toContain("receivablesViewGate.allowed ?");
    expect(card).toContain("openBalanceText(openBalance)");
    expect(card).toContain("yesNo(c.creditHold)");
  });

  it("asks Delete through the modal", () => {
    expect(src).not.toMatch(/\bprompt\(/);
    expect(mentions(PAGE, "askReason")).toBe(2); // the import and Delete
    expect(mentions(PAGE, "reasonPromptText")).toBe(0);
    expect(src).toContain('blankRefusal: "A reason is required to delete a customer."');
    expect(src).toContain('if (reason === null) return; // cancelled');
  });

  it("carries the renames and the order defaults card: Commercial settings, Order defaults, Use / Default, the three labels", () => {
    const heads = jsxTexts(PAGE, "h2");
    for (const h of ["Identity", "Commercial settings", "Order defaults", "Standing notes", "Addresses", "Contacts"]) expect(heads).toContain(h);
    expect(heads).not.toContain("Commercial");
    const labels = jsxTexts(PAGE, "label");
    expect(labels).toEqual(expect.arrayContaining(["Certification required <select>", "Certification scope <select>", "<input> Suppress cert charge"]));
    expect(labels.some((l) => l.startsWith("Request days override"))).toBe(true);
    for (const old of ["Certification required default", "Certification scope default", "Suppress certification charge"]) expect(src).not.toContain(old);
    const addressHeads = jsxTexts(PAGE, "th");
    expect(addressHeads.slice(0, 2)).toEqual(["Use", "Name"]);
    expect(addressHeads).toContain("Default");
    expect(src).not.toContain(">default</span>");
    expect(src).toContain("{a.isDefault && \"Yes\"}");
    // The order defaults sit in their own card on Defaults & documents, not in Commercial.
    const commercial = src.slice(src.indexOf('<section id="commercial"'), src.indexOf('<div id="surcharge-overrides"'));
    expect(commercial).not.toContain("requestDaysOverride");
    expect(commercial).not.toContain("certChargeSuppressed");
    const defaults = src.slice(src.indexOf('<section id="order-defaults"'), src.indexOf('<div id="document-templates"'));
    for (const field of ["requestDaysOverride", "certRequiredDefault", "certScopeDefault", "certChargeSuppressed"]) expect(defaults).toContain(field);
  });
});

describe("the Receivables section hands its Net up (PR 8)", () => {
  const SECTION = "src/app/customers/[id]/ReceivablesSection.tsx";
  const src = read(SECTION);

  it("takes an optional onBalance, calls it on a landed read with the Net and on a failed one with null, inside the ticket guard", () => {
    expect(src).toContain("onBalance?: (net: number | null) => void;");
    const load = src.slice(src.indexOf("const load = useCallback("), src.indexOf("useEffect(() => { void load(); }, [load]);"));
    // Inside the ticket guard (the F7 rule): the Net is handed up only after the current-ticket
    // return, and the null on the line that asks the ticket, so a superseded answer never
    // overwrites the card. Presence alone would stay green with either moved out.
    const guard = load.indexOf("if (!latest.isCurrent(t)) return;");
    const net = load.indexOf("onBalance?.(data.aging.net)");
    expect(guard).toBeGreaterThan(-1);
    expect(net).toBeGreaterThan(guard);
    const nullLine = load.split("\n").find((line) => line.includes("onBalance?.(null)")) ?? "";
    expect(nullLine).toContain("if (latest.isCurrent(t))");
    expect(load).toMatch(/\}, \[customerId, allowed, latest, onBalance\]\);/);
  });
});
