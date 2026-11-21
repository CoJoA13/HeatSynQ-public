import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shipmentTabs } from "@/lib/shipment-tabs";
import { jsxTags, jsxTexts, mentions } from "./helpers/jsx-source";

// How the saved shipment is shaped since PR 4 of the UX redesign (spec §4.4; the owner's rulings of
// 2026-10-31 on #819): a PageHeader titled "Packing list #N" (the BOL number and the customer link
// in its subtitle), its actions the whole-shipment print ("Print shipping ticket"), the Also print
// certifications box, Print BOL, then Reverse and Void in the title row (ruling 8); four RecordTabs
// over the mounted sections from `src/lib/shipment-tabs.ts`; the At a glance card from the totals
// the page already computes, holding the print messages; Void, Reverse and Remove order asking
// through the modal; Documents headed Type / Scope / Created with an "Open PDF" link; "Terms" and
// "Pro number". Read as source: vitest has no DOM, and the page's behaviour is its lifted suites'
// (shipment-detail-wiring, shipment-reads, navigation-callers, unreadable-answer, …).

const PAGE = "src/app/shipping/[id]/ShipmentDetail.tsx";
const src = readFileSync(fileURLToPath(new URL(`../${PAGE}`, import.meta.url)), "utf8");
const tags = jsxTags(PAGE);
const named = (name: string) => tags.filter((t) => t.name === name);
const squash = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ");

describe("the saved shipment's shape (PR 4)", () => {
  it("mounts one PageHeader titled Packing list #N, the print controls and the two title-row actions", () => {
    expect(named("PageHeader").length).toBe(1);
    expect(squash(named("PageHeader")[0].attr("title"))).toBe("`Packing list #${shipper.shipperNumber}`");
    expect(named("h1").length).toBe(0);
    const subtitle = squash(named("PageHeader")[0].attr("subtitle"));
    expect(subtitle).toContain("shipper.bolNumber");
    expect(subtitle).toContain("/customers/${shipper.customerId}");
    const actions = squash(named("PageHeader")[0].attr("actions"));
    expect(actions).toContain("Print shipping ticket");
    expect(actions).toContain("Also print certifications");
    expect(actions).toContain("Print BOL");
    expect(actions).toContain("<ReverseShipmentButton");
    expect(actions).toContain("<DangerButton");
    expect(src).not.toContain("Print all tickets");
    const danger = named("DangerButton");
    expect(danger.length).toBe(1);
    expect(danger[0].attr("disabled")).toBe("voidGate.disabled");
    expect(jsxTexts(PAGE, "DangerButton")).toEqual(["Void shipment"]);
  });

  it("mounts the four tabs over every section, once each, with the card beside them", () => {
    const tabs = named("RecordTabs");
    expect(tabs.length).toBe(1);
    expect(tabs[0].attr("label")).toBe("SHIPMENT_TAB_LABEL");
    expect(tabs[0].attr("tabs")).toBe("shipmentTabs()");
    const panels = tabs[0].attr("panels") ?? "";
    for (const key of shipmentTabs().map((t) => t.key)) expect(panels).toMatch(new RegExp(`(^|[{,\\s])${key}:`));
    for (const component of ["HistoryPanel", "ShipmentDocumentsList", "ShipmentOrderPanel", "AtAGlance"]) {
      expect(`${component}: ${named(component).length}`).toBe(`${component}: 1`);
    }
    for (const id of ["add-order", "orders", "header", "documents", "history"]) {
      expect(tags.some((t) => t.attr("id") === id), id).toBe(true);
    }
    const card = squash(named("AtAGlance")[0].attr("rows"));
    expect(card).toContain("totals.shipment");
  });

  it("asks Void, Reverse and Remove order through the modal", () => {
    expect(src).not.toMatch(/\bprompt\(/);
    expect(src).not.toMatch(/\bconfirm\(/);
    expect(src).not.toMatch(/\bconfirmDiscard\(/);
    expect(mentions(PAGE, "askReason")).toBe(3); // the import, Void, Reverse
    expect(mentions(PAGE, "askDiscard")).toBe(2); // the import and Reverse's discard question
    expect(mentions(PAGE, "askConfirm")).toBe(2); // the import and Remove order
    expect(mentions(PAGE, "reasonPromptText")).toBe(0);
  });

  it("carries the renames and the Documents columns", () => {
    const labels = jsxTexts(PAGE, "label");
    expect(labels.some((t) => t.startsWith("Terms"))).toBe(true);
    expect(labels.some((t) => t.startsWith("Pro number"))).toBe(true);
    expect(labels.some((t) => t.startsWith("Freight terms"))).toBe(false);
    expect(labels.some((t) => t.startsWith("Pro no"))).toBe(false);
    const heads = jsxTexts(PAGE, "th");
    expect(heads).toEqual(expect.arrayContaining(["Type", "Scope", "Created"]));
    expect(heads).not.toContain("Document");
    expect(heads).not.toContain("Printed");
    expect(jsxTexts(PAGE, "a")).toContain("Open PDF");
  });
});
