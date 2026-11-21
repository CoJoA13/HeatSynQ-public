// The order hub's tabs (spec 2026-10-30-ux-redesign-design.md §4.4; PR 2): seven tabs over the
// hub's mounted sections, the ids a hash may target (so the traveler scan's `?load=N#load-N`
// opens Loads & travelers), the unsaved labels each tab badges, and the id → tab map the E2E
// helpers read under plain node. The leaf stays erasable: a type-only import and no enum.
import { describe, expect, it } from "vitest";
import { HUB_SECTION_TAB, HUB_TAB_LABEL, hubTabForId, orderHubTabs, scanOpen } from "../src/lib/order-hub-tabs";
import { openDecision, tabForLocation, tabsWithUnsaved } from "../src/lib/record-tabs";

describe("the order hub's tabs", () => {
  const tabs = orderHubTabs([1, 2, 3]);

  it("names the seven tabs in the file's order", () => {
    expect(HUB_TAB_LABEL).toBe("Order sections");
    expect(tabs.map((t) => [t.key, t.label])).toEqual([
      ["overview", "Overview"], ["parts", "Parts & containers"], ["process", "Process"], ["loads", "Loads & travelers"],
      ["shipping", "Shipping & certs"], ["billing", "Billing"], ["files", "Files & history"],
    ]);
  });

  it("opens Loads & travelers for a traveler scan, Parts & containers for a strip link, and the tab query otherwise", () => {
    expect(tabForLocation(tabs, "?load=2&scan=x", "#load-2")).toBe("loads");
    expect(tabForLocation(tabs, "", "#containers")).toBe("parts");
    expect(tabForLocation(tabs, "", "#documents")).toBe("loads");
    expect(tabForLocation(tabs, "", "#link-order")).toBe("overview");
    expect(tabForLocation(tabs, "?tab=billing", "")).toBe("billing");
    expect(tabForLocation(tabs, "", "")).toBe("overview");
  });

  it("asks Loads & travelers open for a scan whether or not the order still holds the load (Codex, #833)", () => {
    // The scanned row may be gone (removed between the search and the hub's read, or an old link):
    // its "no longer present" warning sits in the Loads section, so the request targets the section's
    // own id, never the row's; the row's scroll is LoadsSection's.
    expect(scanOpen(null, null)).toBeNull();
    expect(scanOpen("2", "2:tok")).toEqual({ id: "loads", key: "2:tok" });
    expect(scanOpen("9", null)).toEqual({ id: "loads", key: "" });
    expect(openDecision(null, scanOpen("9", "9:tok"), tabs).select).toBe("loads");
    expect(openDecision(null, scanOpen("2", "2:tok"), orderHubTabs([])).select).toBe("loads");
  });

  it("badges the tab whose sections hold unsaved work", () => {
    expect(tabsWithUnsaved(tabs, ["Lines"])).toEqual(new Set(["parts"]));
    expect(tabsWithUnsaved(tabs, ["Loads", "Serials"])).toEqual(new Set(["parts", "loads"]));
    expect(tabsWithUnsaved(tabs, ["New order"])).toEqual(new Set());
  });

  it("maps every id of every tab to that tab, and holds no load id without loads", () => {
    for (const t of tabs) for (const id of t.ids ?? []) expect(hubTabForId(id)).toBe(t.key);
    expect(Object.keys(HUB_SECTION_TAB).length).toBeGreaterThan(10);
    expect(hubTabForId("load-12")).toBe("loads");
    expect(hubTabForId("nowhere")).toBeUndefined();
    expect(orderHubTabs([]).flatMap((t) => t.ids ?? []).some((id) => id.startsWith("load-"))).toBe(false);
  });
});
