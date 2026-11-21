import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DraftSaveStatus, EntryOptionalSection, EntryWorkspace, StandingOrderNotes } from "../src/app/orders/new/EntryWorkspace";
import { OrderSummary, formatEntryWeightCents } from "../src/app/orders/new/OrderSummary";
import { ProcessLoadsPanel, entryPrintProblem, parseEntryAdjustment } from "../src/app/orders/new/ProcessLoadsPanel";
import type { EntryTab } from "../src/app/orders/new/entry-state";
import type { EntryPlanPreview } from "../src/lib/order-entry-plan";
import type { TravelerSelection } from "../src/lib/traveler-selection";
import { blankLoadAdjustment, type LoadAdjustmentDraft } from "../src/app/orders/new/order-draft";
import { OrderLineCard } from "../src/app/orders/new/OrderLineCard";
import { headingRowsOf, labelOf } from "./helpers/markup";

// These initial SSR contracts deliberately do not mock the page's draft controller or effects.
// Browser acceptance separately proves keyboard focus and preservation of typed range text.
const tabs = [
  ["details", "Order details"],
  ["parts", "Parts &amp; containers"],
  ["process", "Process &amp; loads"],
] as const;

function workspace(activeTab: EntryTab) {
  return renderToStaticMarkup(
    <EntryWorkspace activeTab={activeTab} onTabChange={() => {}}
      headerActions={<><button type="button">Save &amp; Print 4 travelers</button><button type="button">Save only</button><details><summary>More actions</summary></details></>}
      summary={<p>Summary content</p>}
      detailsPanel={<input aria-label="PO number" defaultValue="FICTIONAL-PO" />}
      partsPanel={<input aria-label="Line 1 add serial" defaultValue="DEMO001-DEMO010" />}
      processPanel={<p>Read-only process content</p>} />,
  );
}

describe("compact order-entry workspace", () => {
  it.each(tabs)("keeps every panel mounted with accessible tab linkage when %s is selected", activeTab => {
    const html = workspace(activeTab);
    expect(html).toContain('role="tablist"');
    for (const [id, label] of tabs) {
      const tab = (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [])
        .find(tag => tag.includes(`id="entry-tab-${id}"`));
      expect(tab).toBeDefined();
      expect(tab).toContain('role="tab"');
      expect(tab).toContain(`aria-controls="entry-panel-${id}"`);
      expect(tab).toContain(`aria-selected="${id === activeTab}"`);
      expect(tab).toContain(`tabindex="${id === activeTab ? 0 : -1}"`);
      expect(tab).toContain(label);
      const panel = (html.match(/<section\b[^>]*>/g) ?? [])
        .find(tag => tag.includes(`id="entry-panel-${id}"`));
      expect(panel).toContain('role="tabpanel"');
      expect(panel).toContain(`aria-labelledby="entry-tab-${id}"`);
      if (id === activeTab) expect(panel).not.toContain('hidden=""');
      else expect(panel).toContain('hidden=""');
    }
    expect(html).toContain('value="FICTIONAL-PO"');
    expect(html).toContain('value="DEMO001-DEMO010"');
    expect(html).toContain("Read-only process content");
  });

  it.each(tabs)("keeps both save actions and summary outside the panels on %s", activeTab => {
    const html = workspace(activeTab);
    const outsidePanels = html.replace(/<section\b[^>]*role="tabpanel"[^>]*>[\s\S]*?<\/section>/g, "");
    expect(outsidePanels).toContain(">Save only</button>");
    expect(outsidePanels).toContain(">Save &amp; Print 4 travelers</button>");
    expect(outsidePanels).toContain("Summary content");
  });

  // PR 2 (spec §4.3): the sticky header's title row is PageHeader, the actions after the title in
  // the order the owner ruled (Save & Print first, Save only, then the More actions menu).
  it("draws the title row as PageHeader with the actions after it, in order", () => {
    const html = workspace("details");
    const header = /<header\b[\s\S]*?<\/header>/.exec(html)?.[0] ?? "";
    expect(header).toContain('class="text-[28px] font-semibold leading-[39px] text-ink-800">New order</h1>');
    const title = header.indexOf("New order</h1>");
    const print = header.indexOf("Save &amp; Print 4 travelers");
    const save = header.indexOf(">Save only<");
    const menu = header.indexOf("More actions");
    expect(title).toBeGreaterThan(-1);
    expect(print).toBeGreaterThan(title);
    expect(save).toBeGreaterThan(print);
    expect(menu).toBeGreaterThan(save);
  });

  // PR 2, the owner's rename rulings of 2026-10-31 (#817): the field labels on New order and the
  // hub, and the certification Yes/No field in place of the checkbox (its reset link kept).
  it("page.tsx and the hub spell the ruled field labels", () => {
    const entry = readFileSync(new URL("../src/app/orders/new/page.tsx", import.meta.url), "utf8");
    for (const label of [">VS reference<", ">Customer job<", ">Certification scope<"]) expect(entry).toContain(label.replace(/[<>]/g, ""));
    expect(entry).toMatch(/\n\s*VS reference\n/);
    expect(entry).toMatch(/\n\s*Customer job\n/);
    expect(entry).toMatch(/\n\s*Certification scope\n/);
    expect(entry).toMatch(/<select[^>]*id="entry-cert-required"/);
    expect(entry).not.toMatch(/type="checkbox" id="entry-cert-required"/);
    for (const old of ["VS order #", "Customer job #", "\n                      Scope\n"]) expect(entry).not.toContain(old);
    expect(entry).toContain("overridden — reset to resolved");
    const hub = readFileSync(new URL("../src/app/orders/[id]/page.tsx", import.meta.url), "utf8");
    expect(hub).toContain('aria-label="VS reference"');
    expect(hub).toContain('aria-label="Customer job"');
    expect(hub).not.toContain("VS order #");
    expect(hub).not.toContain("Customer job #");
  });

  it("page.tsx composes the actions the owner ruled and the menu's one item", () => {
    const src = readFileSync(new URL("../src/app/orders/new/page.tsx", import.meta.url), "utf8");
    const actions = src.slice(src.indexOf("headerActions={"), src.indexOf("summary={<OrderSummary"));
    expect(actions.indexOf("Save &amp; Print")).toBeLessThan(actions.indexOf('"Save only"'));
    expect(actions).toContain("<ActionMenu");
    expect(actions).toContain('label: "Back to orders"');
    expect(src).not.toContain("Back to board");
  });
});

describe("current-draft summary", () => {
  it.each(["incomplete", "loading", "error"] as const)("does not invent totals or a completed plan when %s", availability => {
    const html = renderToStaticMarkup(
      <OrderSummary customerName={null} poNumber="" customerJobNo="" leadPartName={null}
        totalQty={null} totalWeight={null} eachWeight={null} containerCount={0}
        preview={null} availability={availability} travelerCount={null} />,
    );
    expect(html).toContain("Order &amp; traveler plan");
    expect(html).toMatch(/<dt\b[^>]*>Quantity<\/dt>\s*<dd\b[^>]*>—<\/dd>/);
    expect(html).toMatch(/<dt\b[^>]*>Net weight<\/dt>\s*<dd\b[^>]*>—<\/dd>/);
    expect(html).not.toContain("Total weight");
    expect(html).toMatch(/<dt\b[^>]*>Planned loads<\/dt>\s*<dd\b[^>]*>—<\/dd>/);
    expect(html).toMatch(/<dt\b[^>]*>Travelers<\/dt>\s*<dd\b[^>]*>—<\/dd>/);
    expect(html).not.toContain("Ready to save and print");
    // The Containers row (owner ruling P4 of 2026-10-09 keeps it): the count it is handed, and
    // Incomplete when it is handed none.
    expect(html).toMatch(/<dt\b[^>]*>Containers<\/dt>\s*<dd\b[^>]*>0<\/dd>/);
    const uncounted = renderToStaticMarkup(
      <OrderSummary customerName={null} poNumber="" customerJobNo="" leadPartName={null}
        totalQty={null} totalWeight={null} eachWeight={null} containerCount={null}
        preview={null} availability={availability} travelerCount={null} />,
    );
    expect(uncounted).toMatch(/<dt\b[^>]*>Containers<\/dt>\s*<dd\b[^>]*>Incomplete<\/dd>/);
  });
});

const plan: EntryPlanPreview = {
  fingerprint: "a".repeat(64), leadPartId: "fictional-part", revisionNumber: 16, source: "part",
  defaults: { loadQty: 15, loadWeight: 2000 }, effective: { loadQty: 15, loadWeight: 2000 },
  totalQty: 30, totalWeightCents: "381000",
  loads: [{ loadNumber: 1, qty: 15, weight: 1905 }, { loadNumber: 2, qty: 15, weight: 1905 }],
  process: { recipeNumber: "DEMO-24001", steps: [{ position: 10, code: "HEAT", codeName: "Heat",
    instruction: "Fictional controlled instruction", fields: [
      { label: "Temperature", type: "NUMBER", unit: "°F", value: "1500" },
      { label: "Verified", type: "BOOLEAN", unit: null, value: false },
      { label: "Operator note", type: "TEXT", unit: null, value: null },
    ] }] },
};

describe("current-draft summary with a ready plan", () => {
  // The weights design §11.3, O4: the row is named Net weight. A row's label carries no unit, so
  // its value keeps one, as the each weight row above it does (a kept row, K11).
  it("names the order's net weight, and keeps the unit in the value of both weight rows", () => {
    const html = renderToStaticMarkup(
      <OrderSummary customerName="Fictional Co" poNumber="" customerJobNo="" leadPartName="DEMO-008 — Tow bracket"
        totalQty={30} totalWeight="3,810.00" eachWeight={127} containerCount={2}
        preview={plan} availability="ready" travelerCount={2} />,
    );
    expect(html).toMatch(/<dt\b[^>]*>Each weight \(lead\)<\/dt>\s*<dd\b[^>]*>127\.0000 lb<\/dd>/);
    expect(html).toMatch(/<dt\b[^>]*>Net weight<\/dt>\s*<dd\b[^>]*>3,810\.00 lb<\/dd>/);
  });
});

describe("workspace details and status", () => {
  it.each([
    ["idle", "No draft changes"], ["dirty", "Unsaved changes"], ["saving", "Saving draft…"],
    ["saved", "Draft saved"], ["error", "Draft autosave failed"],
  ] as const)("truthfully labels the %s autosave state", (status, label) => {
    const html = renderToStaticMarkup(<DraftSaveStatus state={{ status, acknowledgedGeneration: 3 }} />);
    expect(html).toContain('role="status"');
    expect(html).toContain(label);
    if (status !== "saved") expect(html).not.toContain("Draft saved");
  });

  it("renders standing customer instructions as read-only text", () => {
    const html = renderToStaticMarkup(<StandingOrderNotes notes="Fictional standing instruction" />);
    expect(html).toContain('aria-label="Standing order notes"');
    expect(html).toContain("Fictional standing instruction");
    expect(html).not.toMatch(/<input|<textarea|contenteditable/i);
  });

  it.each(["Additional charges", "Container weights & IDs", "Serial numbers"])("exposes populated or invalid %s detail", title => {
    const expanded = renderToStaticMarkup(<EntryOptionalSection title={title} forceOpen><input defaultValue="retained value" /></EntryOptionalSection>);
    const empty = renderToStaticMarkup(<EntryOptionalSection title={title}><input defaultValue="" /></EntryOptionalSection>);
    expect(expanded.match(/<details\b[^>]*>/)?.[0]).toContain('open=""');
    expect(expanded).toContain('value="retained value"');
    expect(empty.match(/<details\b[^>]*>/)?.[0]).not.toContain('open=""');
  });

  it("formats an aggregate above floating integer precision without losing a cent", () => {
    expect(formatEntryWeightCents("9007199254740993")).toBe("90,071,992,547,409.93");
  });

  it("shows each weight to four decimals under its heading, an editable net weight under its label, and expanded required serial detail", () => {
    const allowed = { allowed: true, disabled: false, title: undefined };
    const html = renderToStaticMarkup(<OrderLineCard index={0} isLead coordinatedProcess customerChosen
      customerId="fictional-customer" receivedDate={undefined} ordersViewAllowed partsGate={allowed}
      processesGate={allowed} quotePickGate={allowed} onChange={() => {}}
      line={{ id: "fictional-line", partId: "fictional-part", qty: "30", weightOverride: "4000.00", serials: [] }}
      parts={[{ id: "fictional-part", customerId: "fictional-customer", partNumber: "DEMO-008", name: "Tow bracket",
        eachWeight: 127, serializationRequired: true, hasProcessSteps: true, certRequired: null, certScope: null,
        inheritedCertRequired: false, inheritedCertScope: "ORDER" }]} />);
    // The weights design §11.3, O1 to O3: a heading carries the unit and the figure under it is
    // bare. Heading and cell are compared together, tags and all: "127.0000" is inside "127.0000 lb".
    expect(html).toMatch(/<span>Each weight \(lb\)<\/span><p\b[^>]*>127\.0000<\/p>/);
    expect(labelOf(html, "Line 1 weight")).toBe("Net weight (lb)");
    expect(labelOf(html, "Line 1 quantity")).toBe("Qty");
    expect(html).toContain('aria-label="Line 1 weight"');
    expect(html).toContain('value="4000.00"');
    expect(html).toContain("Reset to computed");
    expect(html.match(/<details\b[^>]*>/)?.[0]).toContain('open=""');
    expect(html).toContain('aria-label="Line 1 add serial"');
  });

  it("keeps the dash under Each weight (lb) while no part is picked", () => {
    const allowed = { allowed: true, disabled: false, title: undefined };
    const html = renderToStaticMarkup(<OrderLineCard index={0} isLead coordinatedProcess customerChosen
      customerId="fictional-customer" receivedDate={undefined} ordersViewAllowed partsGate={allowed}
      processesGate={allowed} quotePickGate={allowed} onChange={() => {}}
      line={{ id: "fictional-line", partId: null, qty: "", weightOverride: null, serials: [] }} parts={[]} />);
    expect(html).toMatch(/<span>Each weight \(lb\)<\/span><p\b[^>]*>—<\/p>/);
  });

  it("gives existing serial and description inputs distinct stable focus targets after rows move", () => {
    const allowed = { allowed: true, disabled: false, title: undefined };
    const serials = [
      { id: "serial-a", serial: "DEMO001", description: "First fixture row" },
      { id: "serial-b", serial: "DEMO001", description: "Repeated fixture serial" },
    ];
    for (const rows of [serials, [...serials].reverse()]) {
      const html = renderToStaticMarkup(<OrderLineCard index={1} isLead={false} coordinatedProcess customerChosen
        customerId="fictional-customer" receivedDate={undefined} ordersViewAllowed partsGate={allowed}
        processesGate={allowed} quotePickGate={allowed} onChange={() => {}}
        line={{ id: "fictional-line", partId: null, qty: "30", weightOverride: null, serials: rows }} parts={[]} />);
      const inputs = html.match(/<input\b[^>]*>/g) ?? [];
      for (const [index, row] of rows.entries()) {
        const serialInput = inputs.find(input => input.includes(`aria-label="Line 2 serial ${index + 1}"`));
        const descriptionInput = inputs.find(input => input.includes(`aria-label="Line 2 serial ${index + 1} description"`));
        expect(serialInput).toContain(`id="entry-line-fictional-line-serial-${row.id}"`);
        expect(serialInput).toContain('value="DEMO001"');
        expect(descriptionInput).toContain(`id="entry-line-fictional-line-serial-${row.id}-description"`);
        expect(descriptionInput).toContain(`value="${row.description}"`);
      }
      const addInput = inputs.find(input => input.includes('aria-label="Line 2 add serial"'));
      expect(addInput).toContain('id="entry-line-fictional-line-serials"');
      const ids = inputs.flatMap(input => input.match(/\bid="([^"]+)"/)?.[1] ?? []);
      expect(new Set(ids).size).toBe(ids.length);
      expect(html.match(/<details\b[^>]*>/)?.[0]).toContain('open=""');
    }
  });
});

function processPanel(allowed: boolean, availability: "ready" | "loading" | "error" = "ready",
  over: { selection?: TravelerSelection; adjustment?: LoadAdjustmentDraft } = {}) {
  return renderToStaticMarkup(<ProcessLoadsPanel leadPartName="DEMO-008 — Tow bracket"
    processesGate={{ allowed, disabled: !allowed, title: allowed ? undefined : "Requires processes.view" }}
    preview={plan} availability={availability} error={availability === "error" ? "Preview failed" : null}
    adjustment={over.adjustment ?? blankLoadAdjustment()} onAdjustmentChange={() => {}}
    selection={over.selection ?? { mode: "all" }} onSelectionChange={() => {}} onRefresh={() => {}} />);
}

describe("coherent read-only process and load display", () => {
  it("shows the captured revision, recipe, typed values, both caps and formatted loads", () => {
    const html = processPanel(true);
    expect(html).toContain("Revision 16");
    expect(html).toContain("DEMO-24001");
    expect(html).toContain("Fictional controlled instruction");
    expect(html).toContain("1500");
    expect(html).toContain("°F");
    expect(html).toMatch(/Verified: <\/dt><dd[^>]*>No/);
    expect(html).toMatch(/Operator note: <\/dt><dd[^>]*>—/);
    expect(html).toContain("15 pieces and 2,000.00 lb / load");
    // The weights design §11.3, O5 and O6: the load plan's heading carries the unit and each load's
    // figure is bare. Each cell is compared whole: "1,905.00" is inside "1,905.00 lb".
    expect(headingRowsOf(html)).toEqual([["Step", "Operation", "Instruction"], ["Load", "Pieces", "Net weight (lb)"]]);
    expect(html.match(/<td\b[^>]*>1,905\.00[^<]*<\/td>/g))
      .toEqual(['<td class="p-2">1,905.00</td>', '<td class="p-2">1,905.00</td>']);
    expect(html).toContain("3,810.00 / 3,810.00 lb");
    expect(html).not.toContain("<textarea");
  });

  it("heads the load plan the same way while loads are picked, with Print after", () => {
    // No process permission here, so the load plan is the panel's only table.
    const html = processPanel(false, "ready", { selection: { mode: "loads", loadNumbers: [1] } });
    expect(headingRowsOf(html)).toEqual([["Load", "Pieces", "Net weight (lb)", "Print"]]);
  });

  it("keeps the load limit's own name with its unit, and its refusal", () => {
    // The weights design §11.1, answer 2: the part's load limit keeps its two names. In order
    // entry it reads "Weight per load (lb)".
    const html = processPanel(true, "ready",
      { adjustment: { enabled: true, leadPartId: "fictional-part", loadQty: "15", loadWeight: "1e3" } });
    expect(html).toMatch(/<label\b[^>]*>Weight per load \(lb\)<input\b[^>]*\bid="entry-load-weight"/);
    expect([...html.matchAll(/<p role="alert"[^>]*>([^<]*)<\/p>/g)].map(match => match[1])).toEqual([
      "Weight per load (lb): enter a number without $ or commas, such as 0.36.",
    ]);
  });

  it("never renders process content without permission even if a caller supplies it", () => {
    const html = processPanel(false);
    expect(html).toContain("requires processes.view");
    expect(html).not.toContain("Fictional controlled instruction");
    expect(html).not.toContain("DEMO-24001");
    expect(html).not.toContain("1500");
    expect(html).toContain("Load 1");
    expect(html).toContain("Adjust for this order");
  });

  it.each(["loading", "error"] as const)("hides all old process and load content during %s", availability => {
    const html = processPanel(true, availability);
    expect(html).not.toContain("Fictional controlled instruction");
    expect(html).not.toContain("DEMO-24001");
    expect(html).not.toContain("Load 1");
    expect(html).not.toContain("Fully allocated");
  });

  it("keeps both valid explicit caps and returns field-specific decimal/quantity failures", () => {
    expect(parseEntryAdjustment({ enabled: true, leadPartId: "fictional-part", loadQty: "15", loadWeight: "2000.00" })).toEqual({
      adjustment: { source: "order", loadQty: 15, loadWeight: 2000 }, errors: [],
    });
    const invalid = parseEntryAdjustment({ enabled: true, leadPartId: "fictional-part", loadQty: "1.5", loadWeight: "1e3" });
    expect(invalid.adjustment).toBeNull();
    expect(invalid.errors.map(error => error.fieldId)).toEqual(["entry-load-quantity", "entry-load-weight"]);
    expect(parseEntryAdjustment({ enabled: true, leadPartId: "fictional-part", loadQty: "", loadWeight: "" }).adjustment)
      .toEqual({ source: "order", loadQty: null, loadWeight: null });
  });

  it("names a refused weight per load by its label, with the same words at Save and under the box", () => {
    const weight = (loadWeight: string) => parseEntryAdjustment({ enabled: true, leadPartId: "fictional-part", loadQty: "", loadWeight });
    expect(weight("1e3").errors).toEqual([
      { fieldId: "entry-load-weight", message: "Weight per load (lb): enter a number without $ or commas, such as 0.36." }]);
    expect(weight("0").errors).toEqual([
      { fieldId: "entry-load-weight", message: "Weight per load (lb): must be greater than zero." }]);
    expect(weight("100000000.00").errors).toEqual([
      { fieldId: "entry-load-weight", message: "Weight per load (lb): must be less than 100,000,000." }]);
    expect(weight("1.005").errors).toEqual([
      { fieldId: "entry-load-weight", message: "Weight per load (lb): use at most 2 digits after the point." }]);
    expect(weight("99999999.99")).toEqual({ adjustment: { source: "order", loadQty: null, loadWeight: 99999999.99 }, errors: [] });
    expect(weight(" .36 ")).toEqual({ adjustment: { source: "order", loadQty: null, loadWeight: 0.36 }, errors: [] });
    expect(weight("2000.5")).toEqual({ adjustment: { source: "order", loadQty: null, loadWeight: 2000.5 }, errors: [] });
  });

  it("reads a weight per load ending at its point as Save takes it, with no refusal under the box", () => {
    // `2000.` passes through on the way to `2000.5`. It is 2000, as Save sends it, never a blank
    // box (no cap), and no refusal flashes under the box.
    const typing = parseEntryAdjustment({ enabled: true, leadPartId: "fictional-part", loadQty: "15", loadWeight: "2000." });
    expect(typing).toEqual({ adjustment: { source: "order", loadQty: 15, loadWeight: 2000 }, errors: [] });
    const html = processPanel(true, "ready",
      { adjustment: { enabled: true, leadPartId: "fictional-part", loadQty: "15", loadWeight: "2000." } });
    expect(html).not.toMatch(/<p role="alert"/);
  });

  it.each(["1e3", "0x10", "0b10", "+1", "1.0"])("rejects non-decimal quantity syntax %s", loadQty => {
    const parsed = parseEntryAdjustment({
      enabled: true, leadPartId: "fictional-part", loadQty, loadWeight: "",
    });
    expect(parsed.adjustment).toBeNull();
    expect(parsed.errors.map(error => error.fieldId)).toEqual(["entry-load-quantity"]);
  });

  it.each([
    ["15", 15],
    [" 15 ", 15],
    ["", null],
    ["   ", null],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ] as const)("accepts plain decimal quantity %j as %j", (loadQty, expected) => {
    expect(parseEntryAdjustment({
      enabled: true, leadPartId: "fictional-part", loadQty, loadWeight: "",
    })).toEqual({ adjustment: { source: "order", loadQty: expected, loadWeight: null }, errors: [] });
  });

  it("rejects a decimal quantity beyond the safe-integer boundary", () => {
    const parsed = parseEntryAdjustment({
      enabled: true, leadPartId: "fictional-part", loadQty: "9007199254740992", loadWeight: "",
    });
    expect(parsed.adjustment).toBeNull();
    expect(parsed.errors.map(error => error.fieldId)).toEqual(["entry-load-quantity"]);
  });

  it("allows a bounded subset of a large plan while refusing its all-load print", () => {
    const large = { ...plan, loads: Array.from({ length: 101 }, (_, index) => ({ loadNumber: index + 1, qty: 1, weight: 1 })) };
    expect(entryPrintProblem(large, { mode: "all" })).toContain("Save is still available");
    expect(entryPrintProblem(large, { mode: "loads", loadNumbers: [1, 101] })).toBeNull();
    expect(entryPrintProblem(plan, { mode: "loads", loadNumbers: [3] })).toContain("Review");
    expect(entryPrintProblem(plan, { mode: "loads", loadNumbers: [] })).toContain("Select");
  });
});
