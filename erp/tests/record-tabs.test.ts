import { describe, expect, it } from "vitest";
import { nextTabKey, openDecision, tabForLocation, tabsWithUnsaved, withTab, type RecordTab } from "@/lib/record-tabs";

/**
 * The record-page tabs' decisions (spec 2026-10-30 §4.4, ruling 7): which tab a location opens,
 * how the tab rides in the URL, which tabs carry unsaved work, and where the arrow keys go.
 */
const TABS: RecordTab[] = [
  { key: "overview", label: "Overview", sections: ["Overview", "Notes"] },
  { key: "parts", label: "Parts & containers", sections: ["Lines", "Containers", "Serials"] },
  { key: "loads", label: "Loads & travelers", sections: ["Loads"], ids: ["load-1", "load-2", "loads"] },
];

describe("tabForLocation", () => {
  it("the hash picks its tab; a query naming a tab picks it; neither falls to the first", () => {
    expect(tabForLocation(TABS, "?load=2", "#load-2")).toBe("loads");
    expect(tabForLocation(TABS, "?tab=parts", "")).toBe("parts");
    expect(tabForLocation(TABS, "", "#nowhere")).toBe("overview");
    expect(tabForLocation(TABS, "?tab=unknown", "")).toBe("overview");
    expect(tabForLocation(TABS, "", "")).toBe("overview");
  });
  it("a hash wins over a query that names another tab (the scan's deep link lands)", () => {
    expect(tabForLocation(TABS, "?tab=overview&load=1", "#load-1")).toBe("loads");
  });
});

describe("withTab", () => {
  it("sets, replaces and removes the parameter, keeping the others", () => {
    expect(withTab("?load=2", "loads", "overview")).toBe("?load=2&tab=loads");
    expect(withTab("?load=2&tab=loads", "parts", "overview")).toBe("?load=2&tab=parts");
    expect(withTab("?load=2&tab=loads", "overview", "overview")).toBe("?load=2");
    expect(withTab("?tab=loads", "overview", "overview")).toBe("");
    expect(withTab("", "parts", "overview")).toBe("?tab=parts");
  });
});

describe("tabsWithUnsaved and nextTabKey", () => {
  it("marks the tabs whose sections hold unsaved work", () => {
    expect([...tabsWithUnsaved(TABS, ["Loads", "Lines"])]).toEqual(["parts", "loads"]);
    expect([...tabsWithUnsaved(TABS, [])]).toEqual([]);
  });
  it("arrows wrap, Home and End jump", () => {
    expect(nextTabKey(TABS, "overview", "ArrowRight")).toBe("parts");
    expect(nextTabKey(TABS, "loads", "ArrowRight")).toBe("overview");
    expect(nextTabKey(TABS, "overview", "ArrowLeft")).toBe("loads");
    expect(nextTabKey(TABS, "parts", "Home")).toBe("overview");
    expect(nextTabKey(TABS, "parts", "End")).toBe("loads");
  });
});

// PR 2: a page's `open` request ({ id, key }), honoured once per key as soon as a tab holds the id.
describe("openDecision", () => {
  const tabs: RecordTab[] = [
    { key: "overview", label: "Overview", sections: [], ids: ["overview"] },
    { key: "loads", label: "Loads", sections: ["Loads"], ids: ["loads"] },
  ];
  const withLoad = tabs.map((t) => (t.key === "loads" ? { ...t, ids: [...(t.ids ?? []), "load-2"] } : t));

  it("selects the tab holding the id on a new key, and records the key", () => {
    expect(openDecision(null, { id: "load-2", key: "2:a" }, withLoad)).toEqual({ honoured: "2:a", select: "loads" });
  });
  it("does nothing for no request, or for a key already honoured (the operator's later choice stands)", () => {
    expect(openDecision("2:a", null, withLoad)).toEqual({ honoured: "2:a", select: null });
    expect(openDecision("2:a", { id: "load-2", key: "2:a" }, withLoad)).toEqual({ honoured: "2:a", select: null });
  });
  it("waits while no tab holds the id, keeping the key unhonoured, then opens once it arrives", () => {
    expect(openDecision(null, { id: "load-2", key: "2:a" }, tabs)).toEqual({ honoured: null, select: null });
    expect(openDecision(null, { id: "load-2", key: "2:a" }, withLoad)).toEqual({ honoured: "2:a", select: "loads" });
  });
  it("opens again for a new key of the same id (a second scan of the same load)", () => {
    expect(openDecision("2:a", { id: "load-2", key: "2:b" }, withLoad)).toEqual({ honoured: "2:b", select: "loads" });
  });
});
