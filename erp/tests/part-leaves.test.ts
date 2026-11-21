// The Parts & processes pages' leaves (spec 2026-10-30-ux-redesign-design.md §4.3–§4.5; the UX
// redesign PR 9, owner 2026-11-01 on #824): the list's two presets, the part page's six tabs, title,
// subtitle and card words, the step-code page's three tabs and the one basis question.
import { describe, expect, it } from "vitest";
import { tabForLocation, tabsWithUnsaved } from "@/lib/record-tabs";
import { PART_PRESETS, PART_VIEWS_LABEL, applyPreset, presetFor } from "@/lib/part-list";
import {
  PART_TAB_LABEL, eachWeightText, loadQuantityText, partDraftHref, partSubtitle, partTabs, partTitle,
  recipeRevisionText, removePriceQuestion,
} from "@/lib/part-tabs";
import { ADD_SUGGESTION_NO_CODE, STEP_CODE_TAB_LABEL, addSuggestionGate, glAccountText, stepCodeTabs } from "@/lib/step-code-tabs";
import { priceBasisAsks, priceBasisQuestion } from "@/lib/price-basis-question";
import { yesNo } from "@/lib/format";

describe("the parts list's presets", () => {
  it("names the two in order and the group", () => {
    expect(PART_PRESETS.map((p) => [p.key, p.label])).toEqual([["active", "Active parts"], ["inactive", "Include inactive"]]);
    expect(PART_VIEWS_LABEL).toBe("Part views");
  });

  it("applies each as the box's state and derives it back: one is always lit", () => {
    expect(applyPreset({ showInactive: false, search: "x" }, "inactive")).toEqual({ showInactive: true, search: "x" });
    expect(applyPreset({ showInactive: true }, "active")).toEqual({ showInactive: false });
    expect(presetFor({ showInactive: false })).toBe("active");
    expect(presetFor({ showInactive: true })).toBe("inactive");
  });
});

describe("the part page's tabs", () => {
  it("names the six in order, each reached by its sections' ids", () => {
    expect(partTabs().map((t) => [t.key, t.label])).toEqual([
      ["identity", "Identity & defaults"], ["process", "Process recipe"], ["specs", "Specifications & inspections"],
      ["pricing", "Pricing & quotes"], ["files", "Fields & files"], ["history", "History"],
    ]);
    expect(PART_TAB_LABEL).toBe("Part sections");
    expect(tabForLocation(partTabs(), "", "")).toBe("identity");
    expect(tabForLocation(partTabs(), "?tab=process", "")).toBe("process");
    expect(tabForLocation(partTabs(), "", "#pricing")).toBe("pricing");
    expect(tabForLocation(partTabs(), "", "#custom-fields")).toBe("files");
  });

  it("badges a tab by the two sections that register unsaved work, and only those", () => {
    expect(tabsWithUnsaved(partTabs(), ["Process steps"])).toEqual(new Set(["process"]));
    expect(tabsWithUnsaved(partTabs(), ["Custom fields"])).toEqual(new Set(["files"]));
    expect(partTabs().filter((t) => t.sections.length > 0).map((t) => t.key)).toEqual(["process", "files"]);
  });

  it("sends a retained draft to the tab that holds its notice", () => {
    expect(partDraftHref("p1", "process")).toBe("/parts/p1?tab=process");
    expect(partDraftHref("p1", "files")).toBe("/parts/p1?tab=files");
    expect(tabForLocation(partTabs(), new URL(partDraftHref("p1", "files"), "http://x").search, "")).toBe("files");
  });
});

describe("the part page's title, subtitle and card words", () => {
  it("titles the part by number and name, the number alone while the name is blank", () => {
    expect(partTitle({ partNumber: "HT-208", name: "Drive pin" })).toBe("HT-208 · Drive pin");
    expect(partTitle({ partNumber: "HT-208", name: "" })).toBe("HT-208");
    expect(partTitle({ partNumber: "HT-208", name: "   " })).toBe("HT-208");
  });

  it("states the customer, the recipe and the revision, dropping what is not known", () => {
    expect(partSubtitle("Northstar Tool", null)).toBe("Northstar Tool");
    expect(partSubtitle("Northstar Tool", { recipeNumber: "HT-0208", revision: 3 })).toBe("Northstar Tool · Recipe HT-0208 · Revision 3");
    expect(partSubtitle("Northstar Tool", { recipeNumber: null, revision: 3 })).toBe("Northstar Tool · Recipe unassigned · Revision 3");
    expect(partSubtitle("Northstar Tool", { recipeNumber: null, revision: null })).toBe("Northstar Tool · Recipe unassigned");
  });

  it("reads the card's three figures, a dash for what is not there", () => {
    expect(recipeRevisionText(null)).toBe("—");
    expect(recipeRevisionText({ recipeNumber: null, revision: null })).toBe("—");
    expect(recipeRevisionText({ recipeNumber: "R", revision: 4 })).toBe("4");
    expect(eachWeightText("1.25")).toBe("1.25 lb");
    expect(eachWeightText(2)).toBe("2 lb");
    expect(eachWeightText("  ")).toBe("—");
    expect(loadQuantityText(300)).toBe("300");
    expect(loadQuantityText(null)).toBe("—");
    expect(loadQuantityText("")).toBe("—");
  });

  it("asks before an operation's price goes, in the operation's name", () => {
    expect(removePriceQuestion("Harden")).toEqual({
      title: "Remove Harden pricing?",
      body: "This removes the part's operation price and its price breaks. The process step stays.",
      confirm: "Remove operation price",
      danger: true,
    });
  });
});

describe("the step-code page's leaf", () => {
  it("names the three tabs, none registering unsaved work", () => {
    expect(stepCodeTabs().map((t) => [t.key, t.label])).toEqual([["codes", "Codes"], ["selected", "Selected code"], ["history", "History"]]);
    expect(STEP_CODE_TAB_LABEL).toBe("Step code sections");
    expect(stepCodeTabs().every((t) => t.sections.length === 0)).toBe(true);
    expect(tabForLocation(stepCodeTabs(), "", "#new-step-code")).toBe("codes");
    expect(tabForLocation(stepCodeTabs(), "", "#add-suggestion")).toBe("selected");
    expect(tabForLocation(stepCodeTabs(), "", "#step-code-history")).toBe("history");
  });

  it("closes the header's Add parameter suggestion until a code is picked, the permission's reason winning", () => {
    const open = { disabled: false, title: undefined };
    const denied = { disabled: true, title: "Requires admin.edit" };
    expect(ADD_SUGGESTION_NO_CODE).toBe("Select a process step code first.");
    expect(addSuggestionGate(open, false)).toEqual({ disabled: true, title: ADD_SUGGESTION_NO_CODE });
    expect(addSuggestionGate(denied, false)).toEqual(denied);
    expect(addSuggestionGate(denied, true)).toEqual(denied);
    expect(addSuggestionGate(open, true)).toEqual(open);
  });

  it("reads a GL account as the select's option does", () => {
    const gls = [{ id: "g1", name: "4100", description: "Heat treating revenue" }, { id: "g2", name: "4200" }];
    expect(glAccountText("g1", gls)).toBe("4100 Heat treating revenue");
    expect(glAccountText("g2", gls)).toBe("4200");
    expect(glAccountText("gone", gls)).toBe("");
    expect(glAccountText(null, gls)).toBe("");
  });
});

describe("the one basis question (the Quotes page's words, read by both screens)", () => {
  it("asks only for a row with breaks whose move touches no Lot", () => {
    expect(priceBasisAsks("EACH", "LB", 2)).toBe(true);
    expect(priceBasisAsks("EACH", "LB", 0)).toBe(false);
    expect(priceBasisAsks("EACH", "LOT", 2)).toBe(false);
    expect(priceBasisAsks("LOT", "LB", 2)).toBe(false);
  });

  it("keeps the sentence the Quotes page shipped", () => {
    expect(priceBasisQuestion("EACH", "LB", 2)).toEqual({
      title: "Read this operation's prices as Per lb?",
      body: "This operation has 2 price break(s). Its Unit price, and every break's own threshold and price, are all read today as Each amounts. "
        + "Switching to Per lb does not change any of those stored numbers — every one of them will be read as a Per lb amount from now on.",
      confirm: "Change to Per lb",
    });
  });
});

describe("yesNo", () => {
  it("reads a flag as the lists and cards show it", () => {
    expect(yesNo(true)).toBe("Yes");
    expect(yesNo(false)).toBe("No");
  });
});
