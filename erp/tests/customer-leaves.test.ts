// The Customers pages' leaves (spec 2026-10-30-ux-redesign-design.md §4.3–§4.5; the UX redesign
// PR 8, owner 2026-11-01 on #823): the list's two presets over its Show inactive box, and the
// customer page's six tabs, subtitle and the card's words.
import { describe, expect, it } from "vitest";
import { tabForLocation, tabsWithUnsaved } from "@/lib/record-tabs";
import { CUSTOMER_PRESETS, CUSTOMER_VIEWS_LABEL, applyPreset, presetFor } from "@/lib/customer-list";
import { CUSTOMER_TAB_LABEL, customerSubtitle, customerTabs, openBalanceText } from "@/lib/customer-tabs";
import { yesNo } from "@/lib/format";

describe("the customers list's presets", () => {
  it("names the two in order and the group", () => {
    expect(CUSTOMER_PRESETS.map((p) => [p.key, p.label])).toEqual([["active", "Active customers"], ["inactive", "Include inactive"]]);
    expect(CUSTOMER_VIEWS_LABEL).toBe("Customer views");
  });

  it("applies each as the box's state and derives it back: one is always lit", () => {
    expect(applyPreset({ showInactive: false, search: "x" }, "inactive")).toEqual({ showInactive: true, search: "x" });
    expect(applyPreset({ showInactive: true }, "active")).toEqual({ showInactive: false });
    expect(presetFor({ showInactive: false })).toBe("active");
    expect(presetFor({ showInactive: true })).toBe("inactive");
  });
});

describe("the customer page's leaf", () => {
  it("names the six tabs in order, each reached by its sections' ids, none registering unsaved work", () => {
    expect(customerTabs().map((t) => [t.key, t.label])).toEqual([
      ["overview", "Overview & notes"], ["addresses", "Addresses & contacts"], ["terms", "Terms & billing"],
      ["defaults", "Defaults & documents"], ["receivables", "Receivables"], ["history", "History"],
    ]);
    expect(CUSTOMER_TAB_LABEL).toBe("Customer sections");
    expect(tabForLocation(customerTabs(), "", "")).toBe("overview");
    expect(tabForLocation(customerTabs(), "", "#history")).toBe("history");
    expect(tabForLocation(customerTabs(), "", "#receivables")).toBe("receivables");
    expect(tabForLocation(customerTabs(), "", "#commercial")).toBe("terms");
    expect(tabForLocation(customerTabs(), "", "#surcharge-overrides")).toBe("terms");
    expect(tabForLocation(customerTabs(), "", "#order-defaults")).toBe("defaults");
    expect(tabForLocation(customerTabs(), "", "#document-templates")).toBe("defaults");
    expect(tabForLocation(customerTabs(), "", "#contacts")).toBe("addresses");
    expect(tabForLocation(customerTabs(), "", "#standing-notes")).toBe("overview");
    expect(tabForLocation(customerTabs(), "?tab=terms", "")).toBe("terms");
    expect(customerTabs().every((t) => t.sections.length === 0)).toBe(true);
    expect(tabsWithUnsaved(customerTabs(), ["Lines"]).size).toBe(0);
  });

  it("writes the subtitle from the code, the active flag and a parent", () => {
    expect(customerSubtitle({ code: "NORTH", active: true, parentCode: null })).toBe("NORTH · Active");
    expect(customerSubtitle({ code: "OLDCO", active: false, parentCode: null })).toBe("OLDCO · Inactive");
    expect(customerSubtitle({ code: "NST-E", active: true, parentCode: "NST" })).toBe("NST-E · Active · Division of NST");
  });

  it("names the card's figures", () => {
    expect(openBalanceText(null)).toBe("—");
    expect(openBalanceText(860)).toBe("$860.00");
    expect(openBalanceText(-50)).toBe("-$50.00");
    expect(yesNo(true)).toBe("Yes");
    expect(yesNo(false)).toBe("No");
  });
});
