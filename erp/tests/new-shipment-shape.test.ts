import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { newShipmentTabs } from "@/lib/shipment-tabs";
import { jsxTags, jsxTexts, mentions } from "./helpers/jsx-source";

// How New shipment is shaped since PR 4 of the UX redesign (spec §4.4; the owner's rulings of
// 2026-10-31 on #819): a PageHeader with Save shipment as the one primary and Back to shipping in
// More actions; three RecordTabs over the sections from `src/lib/shipment-tabs.ts`, a refused Save
// opening the first refused box's tab through `open` before the cursor lands (R13); the At a glance
// card from the page's own totals; the remove-order and customer-change questions through the
// modal; "Terms" and "Pro number". The `fieldset disabled` still wraps the whole form. Read as
// source: vitest has no DOM, and the page's behaviour is its lifted suites' (new-shipment-*).

const PAGE = "src/app/shipping/new/NewShipment.tsx";
const GRIDS = "src/app/shipping/ShipmentGrids.tsx";
const src = readFileSync(fileURLToPath(new URL(`../${PAGE}`, import.meta.url)), "utf8");
const tags = jsxTags(PAGE);
const named = (name: string) => tags.filter((t) => t.name === name);
const squash = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ");

describe("New shipment's shape (PR 4)", () => {
  it("mounts one PageHeader: Save shipment primary, Back to shipping in More actions", () => {
    expect(named("PageHeader").length).toBe(1);
    expect(named("PageHeader")[0].attr("title")).toBe("New shipment");
    expect(named("h1").length).toBe(0);
    const actions = squash(named("PageHeader")[0].attr("actions"));
    expect(actions).toContain("Save shipment");
    expect(actions).toContain("<ActionMenu");
    expect(actions).toContain('label: "Back to shipping"');
    const save = named("button").find((t) => t.attr("onClick") === "() => void handleSave()");
    expect(save?.attr("className")).toBe("BUTTON_PRIMARY");
    expect(save?.attr("disabled")).toBe("saving || createGate.disabled || noCustomer || holdBlocked");
    expect(src).not.toContain("← Back to shipping");
  });

  it("mounts the three tabs inside the disabled fieldset, with the refused box's tab asked open", () => {
    const tabs = named("RecordTabs");
    expect(tabs.length).toBe(1);
    expect(tabs[0].attr("label")).toBe("NEW_SHIPMENT_TAB_LABEL");
    expect(tabs[0].attr("tabs")).toBe("newShipmentTabs()");
    expect(tabs[0].attr("open")).toBe("refusedOpen");
    const panels = tabs[0].attr("panels") ?? "";
    for (const key of newShipmentTabs().map((t) => t.key)) expect(panels).toMatch(new RegExp(`(^|[{,\\s])${key}:`));
    const fieldset = named("fieldset");
    expect(fieldset.length).toBe(1);
    expect(src.indexOf("<fieldset")).toBeLessThan(src.indexOf("<RecordTabs"));
    expect(named("AtAGlance").length).toBe(1);
    // The refused box is opened through the leaf and focused once its panel shows.
    expect(src).toContain("newShipmentTabForBox(");
    expect(src).toContain("focusWhenShown(() => refusedBox(document, refused.ids[0])");
  });

  it("asks the two questions through the modal", () => {
    expect(src).not.toMatch(/\bconfirm\(/);
    expect(src).not.toMatch(/\bconfirmDiscard\(/);
    expect(mentions(PAGE, "askConfirm")).toBe(2); // the import and Remove order
    expect(mentions(PAGE, "askDiscard")).toBe(3); // the import, the customer change, Back to shipping
  });

  it("carries the renames", () => {
    const labels = jsxTexts(PAGE, "label");
    expect(labels.some((t) => t.startsWith("Terms "))).toBe(true);
    expect(labels.some((t) => t.startsWith("Pro number "))).toBe(true);
    expect(labels.some((t) => t.startsWith("Freight terms"))).toBe(false);
    expect(labels.some((t) => t.startsWith("Pro no "))).toBe(false);
    expect(jsxTexts(GRIDS, "th")).toContain("Close line short");
    expect(jsxTexts(GRIDS, "th")).not.toContain("Close short");
    expect(jsxTexts(GRIDS, "h4")).toEqual(["Lines", "Containers", "Shipment serials"]);
  });
});
