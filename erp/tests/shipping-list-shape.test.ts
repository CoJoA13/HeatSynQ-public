import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jsxTags, jsxTexts } from "./helpers/jsx-source";

// How the shipping list is shaped since PR 4 of the UX redesign (spec §4.5; owner rulings of
// 2026-10-31 on #819): a PageHeader with New Shipment as the one primary, the Shipments / Shipment
// history presets over the ONE table (the Include voided box stays, a preset is its state), the
// filter bar and the table in cards, "Qty" headed "Pieces". Read as source: vitest has no DOM.

const PAGE = "src/app/shipping/ShippingList.tsx";
const src = readFileSync(fileURLToPath(new URL(`../${PAGE}`, import.meta.url)), "utf8");
const tags = jsxTags(PAGE);
const named = (name: string) => tags.filter((t) => t.name === name);

describe("the shipping list's shape (PR 4)", () => {
  it("mounts a PageHeader whose one action is the primary New Shipment", () => {
    expect(named("PageHeader").length).toBe(1);
    expect(named("PageHeader")[0].attr("title")).toBe("Shipping");
    const create = named("button").find((t) => (t.attr("onClick") ?? "").includes('"/shipping/new"'));
    expect(create?.attr("className")).toBe("BUTTON_PRIMARY");
    expect(named("h1").length).toBe(0);
  });

  it("mounts the two presets, derived from the filters, with the Include voided box kept", () => {
    expect(named("ListTabs").length).toBe(1);
    expect(named("ListTabs")[0].attr("tabs")).toBe("SHIPPING_PRESETS");
    expect(named("ListTabs")[0].attr("active")).toBe("presetFor(filters)");
    const box = named("input").find((t) => t.attr("type") === "checkbox" && (t.attr("checked") ?? "") === "filters.includeVoided");
    expect(box).toBeDefined();
    expect(src).toContain("Include voided");
  });

  it("heads the pieces column Pieces and keeps every other column", () => {
    expect(jsxTexts(PAGE, "th")).toEqual([
      "Packing List No", "Customer", "Ship Date", "Orders", "Carrier", "Pieces", "{NET_WEIGHT_LB}", "Freight", "BOL No", "Status",
    ]);
  });
});
