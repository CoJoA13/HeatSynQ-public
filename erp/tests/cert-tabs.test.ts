// The certification page's tabs and the requirement block's two headings (spec
// 2026-10-30-ux-redesign-design.md §4.4; PR 5, owner 2026-10-31 on #820): three tabs over the
// mounted sections, the readings' registry label badging Inspection results alone (review focus
// 1), and the frozen range folded into one "Required …" line beside a Value heading carrying the
// scale's name, each sensible with a half-open range or no scale (review focus 5).
import { describe, expect, it } from "vitest";
import { tabForLocation, tabsWithUnsaved } from "@/lib/record-tabs";
import { CERT_TAB_LABEL, certTabs, requiredText, valueHeading } from "@/lib/cert-tabs";

describe("the certification page's tabs", () => {
  it("names the three tabs in order, Inspection results first", () => {
    expect(certTabs().map((t) => [t.key, t.label])).toEqual([
      ["results", "Inspection results"], ["wording", "Wording & signature"], ["documents", "Documents & history"],
    ]);
    expect(CERT_TAB_LABEL).toBe("Certification sections");
    expect(tabForLocation(certTabs(), "", "")).toBe("results");
    expect(tabForLocation(certTabs(), "", "#history")).toBe("documents");
    expect(tabForLocation(certTabs(), "", "#documents")).toBe("documents");
    expect(tabForLocation(certTabs(), "", "#notes")).toBe("wording");
    expect(tabForLocation(certTabs(), "?tab=wording", "")).toBe("wording");
  });

  it("badges the readings' unsaved work on Inspection results alone (review focus 1)", () => {
    expect([...tabsWithUnsaved(certTabs(), ["Cert results"])]).toEqual(["results"]);
    expect(tabsWithUnsaved(certTabs(), []).size).toBe(0);
  });
});

describe("the requirement block's headings (review focus 5)", () => {
  it("folds the frozen range into one line, with the scale's name as its unit", () => {
    expect(requiredText({ min: 38, max: 42, scaleName: "HRC" })).toBe("Required 38–42 HRC");
    expect(requiredText({ min: 38, max: null, scaleName: "HRC" })).toBe("Required at least 38 HRC");
    expect(requiredText({ min: null, max: 42, scaleName: null })).toBe("Required at most 42");
    expect(requiredText({ min: null, max: null, scaleName: "HRC" })).toBe("No required range");
    expect(requiredText({ min: 0.02, max: 0.03, scaleName: "in" })).toBe("Required 0.02–0.03 in");
  });

  it("names the Value heading by the scale, bare without one", () => {
    expect(valueHeading("HRC")).toBe("Value (HRC)");
    expect(valueHeading(null)).toBe("Value");
  });
});
