// The quote page's tabs (spec 2026-10-30-ux-redesign-design.md §4.4; PR 3, 2026-10-31): three
// RecordTabs over the mounted sections, Parts & pricing first and so the default, each badging
// its own half of the single-save form through the two registry labels the page registers.
import { describe, expect, it } from "vitest";
import { tabForLocation, tabsWithUnsaved } from "@/lib/record-tabs";
import { QUOTE_DETAILS_SECTION, QUOTE_LINES_SECTION, QUOTE_TAB_LABEL, quoteTabs } from "@/lib/quote-tabs";

describe("quote tabs", () => {
  it("names the three tabs in order, Parts & pricing first", () => {
    expect(quoteTabs().map((t) => [t.key, t.label])).toEqual([
      ["parts", "Parts & pricing"], ["details", "Details & wording"], ["documents", "Documents & history"],
    ]);
    expect(QUOTE_TAB_LABEL).toBe("Quote sections");
  });

  it("opens the tab a hash or query names", () => {
    expect(tabForLocation(quoteTabs(), "", "")).toBe("parts");
    expect(tabForLocation(quoteTabs(), "", "#history")).toBe("documents");
    expect(tabForLocation(quoteTabs(), "", "#header")).toBe("details");
    expect(tabForLocation(quoteTabs(), "?tab=details", "")).toBe("details");
  });

  it("badges each half of the form on its own tab (review focus 1)", () => {
    expect(QUOTE_LINES_SECTION).not.toBe(QUOTE_DETAILS_SECTION);
    expect([...tabsWithUnsaved(quoteTabs(), [QUOTE_LINES_SECTION])]).toEqual(["parts"]);
    expect([...tabsWithUnsaved(quoteTabs(), [QUOTE_DETAILS_SECTION])]).toEqual(["details"]);
    expect([...tabsWithUnsaved(quoteTabs(), [QUOTE_LINES_SECTION, QUOTE_DETAILS_SECTION])].sort()).toEqual(["details", "parts"]);
    expect(tabsWithUnsaved(quoteTabs(), []).size).toBe(0);
  });
});
