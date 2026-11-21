import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tabForLocation } from "@/lib/record-tabs";
import {
  ACCOUNTING_TAB_LABEL, EDITOR_TAB_LABEL, HIDDEN_SETTING_KEYS, PART_FIELD_TAB_LABEL, SETTINGS_TAB_LABEL, SURCHARGE_TAB_LABEL,
  accountingTabs, editorTabs, partFieldTabs, settingsTabs, surchargeTabs,
} from "@/lib/admin-tabs";
import { CERT_CHARGE_DEFAULT, FINANCE_CHARGE, PLANT_FINANCE_CHARGE, PLANT_SALES_TAX_RATE, SALES_TAX_RATE } from "@/lib/rate-boxes";
import { PICK_LIST_ORDER, REFERENCE_KINDS } from "@/lib/reference-constants";
import { jsxTags, jsxTexts, mentions } from "./helpers/jsx-source";

// How the Configuration screens are shaped since PR 11 of the UX redesign (spec §4.3–§4.5; the
// owner's rulings of 2026-11-01 on #826). Read as source: vitest has no DOM, and each page's
// behaviour is its lifted suites' (admin-rate-boxes, enter-non-guard-commits, admin-panel-messages,
// reference-table-inline-edit, the document-template suites, …).
const read = (page: string) => readFileSync(fileURLToPath(new URL(`../${page}`, import.meta.url)), "utf8");
const named = (page: string, name: string) => jsxTags(page).filter((t) => t.name === name);
const squash = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ");

describe("the tab leaf", () => {
  it("states each screen's tabs in order", () => {
    expect(settingsTabs(["Company", "Numbering"]).map((t) => [t.key, t.label])).toEqual([["company", "Company"], ["numbering", "Numbering"]]);
    expect(accountingTabs().map((t) => t.label)).toEqual(["GL mappings", "Tax & certification", "Statement finance charge"]);
    expect(surchargeTabs().map((t) => t.label)).toEqual(["Surcharge list", "Selected surcharge", "History"]);
    expect(partFieldTabs().map((t) => t.label)).toEqual(["Field definitions", "History"]);
    for (const label of [SETTINGS_TAB_LABEL, ACCOUNTING_TAB_LABEL, SURCHARGE_TAB_LABEL, PART_FIELD_TAB_LABEL, EDITOR_TAB_LABEL]) expect(label).not.toBe("");
    for (const tabs of [accountingTabs(), surchargeTabs(), partFieldTabs(), editorTabs({ wording: true, widths: true, canvas: false }), editorTabs({ wording: true, widths: true, canvas: true })]) expect(tabs.every((t) => t.sections.length === 0)).toBe(true);
  });

  it("reaches a surcharge's panels by id", () => {
    expect(tabForLocation(surchargeTabs(), "", "#selected-surcharge")).toBe("selected");
    expect(tabForLocation(surchargeTabs(), "", "#new-surcharge")).toBe("list");
  });

  it("takes the two unused number settings off the form, and nothing else", () => {
    expect([...HIDDEN_SETTING_KEYS].sort()).toEqual(["cert_number_next", "invoice_number_next"]);
  });
});

describe("the labels", () => {
  it("renames the plant's boxes and leaves the customer page's", () => {
    expect(PLANT_SALES_TAX_RATE.label).toBe("Plant sales tax rate (%)");
    expect(PLANT_SALES_TAX_RATE.box).toBe(SALES_TAX_RATE.box);
    expect(SALES_TAX_RATE.label).toBe("Sales tax rate (%)");
    expect(PLANT_FINANCE_CHARGE.label).toBe("Monthly rate (%)");
    expect(PLANT_FINANCE_CHARGE.box).toBe(FINANCE_CHARGE.box);
    expect(FINANCE_CHARGE.label).toBe("Finance charge (monthly %)");
    expect(CERT_CHARGE_DEFAULT.label).toBe("Certification charge ($)");
  });

  it("orders the pick lists as the file does, every kind once", () => {
    expect(PICK_LIST_ORDER[0]).toBe("containerType");
    expect([...PICK_LIST_ORDER].sort()).toEqual([...REFERENCE_KINDS].sort());
  });

  it("words the settings as the owner adopted", () => {
    const src = read("src/server/settings.ts");
    for (const label of ["Next order", "Next packing list", "Next credit", "Next quote", "Next BOL", "Next receipt batch", "Next GL export batch",
      "Required by default", "Default scope", "Backup stale after (hours)"]) expect(src).toContain(`label: "${label}"`);
  });
});

describe("Settings", () => {
  const PAGE = "src/app/admin/settings/page.tsx";
  const src = read(PAGE);
  it("takes the header and the tabs, and leaves the two unused settings off the form", () => {
    expect(named(PAGE, "PageHeader")[0].attr("title")).toBe("Settings");
    expect(named(PAGE, "h1").length).toBe(0);
    const tabs = named(PAGE, "RecordTabs");
    expect(tabs.length).toBe(1);
    expect(tabs[0].attr("tabs")).toBe("settingsTabs(groups)");
    expect(src).toContain("rows.filter((r) => !HIDDEN_SETTING_KEYS.has(r.key))");
    // The tabs read the first tab at mount, so they wait for the groups.
    expect(squash(src)).toContain("{groups.length > 0 && (");
  });
});

describe("Accounting", () => {
  const PAGE = "src/app/admin/billing/page.tsx";
  const src = read(PAGE);
  it("takes the header and the three tabs, each box under its card", () => {
    const header = named(PAGE, "PageHeader")[0];
    expect(header.attr("title")).toBe("Accounting");
    expect(header.attr("subtitle")).toBe("Mappings and defaults used by invoices and period export.");
    expect(named(PAGE, "RecordTabs")[0].attr("tabs")).toBe("accountingTabs()");
    expect(jsxTexts(PAGE, "h2")).toEqual(["Accounts", "Defaults", "Statement finance charge"]);
    const order = ["A/R", "Sales tax", "Freight", "Other charges", "Discounts", "Write-offs", "Plant sales tax rate (%)", "Bill for certification",
      "Certification charge step code", "Certification charge ($)", "Monthly rate (%)"].map((l) => src.indexOf(`<span>${l}{savedMark(`));
    expect(order.every((at) => at > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(src).not.toContain("GL account{savedMark");
  });
  it("reads a refused box by the plant's own label", () => {
    expect(src).toContain('key === "salesTaxRate" ? PLANT_SALES_TAX_RATE');
    expect(src).toContain("PLANT_FINANCE_CHARGE");
  });
});

describe("Surcharges", () => {
  const PAGE = "src/app/admin/surcharges/page.tsx";
  const src = read(PAGE);
  it("takes the header with Add surcharge and the three tabs, a row opening Selected surcharge", () => {
    expect(named(PAGE, "PageHeader")[0].attr("title")).toBe("Surcharges");
    expect(named(PAGE, "h1").length).toBe(0);
    expect(jsxTexts(PAGE, "button")).toContain("Add surcharge");
    const tabs = named(PAGE, "RecordTabs");
    expect(tabs[0].attr("tabs")).toBe("surchargeTabs()");
    expect(tabs[0].attr("open")).toBe("openTab");
    const panels = squash(tabs[0].attr("panels"));
    for (const id of ["surcharge-list", "new-surcharge", "selected-surcharge", "surcharge-history"]) expect(panels).toContain(`id="${id}"`);
    expect(src).toContain("openRequests.current += 1;");
    expect(src).toContain("focusWhenShown(() => nameRef.current)");
  });
  it("draws the table, its one selector stretched over the row", () => {
    expect(jsxTexts(PAGE, "th").slice(0, 5)).toEqual(["Name", "Kind", "Value", "GL account", "Active"]);
    const selector = jsxTags(PAGE).filter((t) => t.name === "button" && t.attr("aria-current") !== undefined);
    expect(selector.length).toBe(1);
    expect(selector[0].attr("onClick")).toBe("() => openRow(r.id)");
    expect(selector[0].attr("className")).toContain("after:absolute after:inset-0");
    expect(src).toContain("<tr key={r.id} className={`relative border-t ");
    expect(src).toContain("yesNo(r.active)");
    expect(src).toContain("glAccountText(r.glAccountId, gls)");
    expect(src).toContain(">needs GL</span>");
  });
  it("cards the selected surcharge, and asks both destroyers through the modal", () => {
    expect(jsxTexts(PAGE, "h3")).toEqual(expect.arrayContaining(["Value &amp; accounting", "Operation scope"]));
    expect(jsxTexts(PAGE, "DangerButton")).toEqual(["Delete surcharge"]);
    expect(src).not.toMatch(/\bconfirm\(/);
    expect(mentions(PAGE, "askConfirm")).toBe(3); // the import and the two asks
    expect(mentions(PAGE, "HistoryPanel")).toBe(2); // the import and the one mount
  });
});

describe("Pick lists", () => {
  const TABLE = "src/components/ReferenceTable.tsx";
  const PAGE = "src/app/admin/reference/page.tsx";
  const src = read(TABLE);
  it("draws the header around the selector, which stays on the page", () => {
    const header = named(TABLE, "PageHeader");
    expect(header.length).toBe(1);
    expect(header[0].attr("title")).toBe("Pick lists");
    expect(header[0].attr("subtitle")).toBe("Select a list, edit a row, keep the rest out of the way.");
    expect(named(PAGE, "ReferenceTable")[0].attr("selector")).toBeDefined();
    expect(read(PAGE)).toContain("PICK_LIST_ORDER.map((k)");
    expect(read(PAGE)).toContain('useState<ReferenceKind>(linked ?? "containerType")');
    // Choosing a list remounts the table, so it asks first: a held discount is unsaved work. It
    // leaves no page, so it names its own loss (owner answer 2026-11-04).
    expect(read(PAGE)).toContain('if (!(await askDiscard({ action: "Choose another list and discard them?" }))) return;');
    // The chosen button remounts with the table, so the cursor goes back to it (review, finding 1;
    // `admin-selector-keyboard` proves it in a browser).
    expect(squash(read(PAGE))).toContain("chosen.current = true; setKind(next);");
    expect(read(PAGE)).toContain("ref={listRef}");
  });
  it("holds Add row, Paste and the export in the header, the rows' own controls in the rows", () => {
    expect(jsxTexts(TABLE, "button")).toContain("Add row");
    expect(squash(named(TABLE, "ActionMenu")[0].attr("items"))).toContain('label: "Export to Excel", href: exportHref');
    expect(mentions(TABLE, "focusNewRow")).toBe(2);
    expect(src).toContain("ref={addFirstRef}");
    expect(src).toContain("Show inactive");
    expect(src).not.toMatch(/\bconfirm\(/);
  });
});

describe("Part fields", () => {
  const PAGE = "src/app/admin/part-fields/page.tsx";
  const src = read(PAGE);
  it("takes the header and the two tabs, with History reading the field picked", () => {
    const header = named(PAGE, "PageHeader")[0];
    expect(header.attr("title")).toBe("Part fields");
    expect(header.attr("subtitle")).toBe("Only extra information the shop actually needs.");
    expect(jsxTexts(PAGE, "button")).toContain("Add field");
    expect(named(PAGE, "RecordTabs")[0].attr("tabs")).toBe("partFieldTabs()");
    expect(named(PAGE, "HistoryPanel")[0].attr("entity")).toBe("partFieldDef");
    expect(src).toContain('aria-label="Part field"');
    expect(src).toContain("Select a part field to view its history.");
    expect(mentions(PAGE, "invalidateHistory")).toBe(4); // the import and the three writes
    expect(src).not.toMatch(/\bconfirm\(/);
  });
});

describe("the templates list", () => {
  const PAGE = "src/app/admin/templates/page.tsx";
  const src = read(PAGE);
  it("takes the header with New template, and asks the delete through the modal", () => {
    expect(named(PAGE, "PageHeader")[0].attr("title")).toBe("Document templates");
    expect(named(PAGE, "h1").length).toBe(0);
    expect(jsxTexts(PAGE, "button")).toContain("New template");
    expect(mentions(PAGE, "focusNewTemplate")).toBe(2);
    expect(src).toContain("ref={newNameRef}");
    expect(jsxTexts(PAGE, "DangerButton")).toEqual(["Delete template"]);
    expect(src).not.toContain("prompt(");
    expect(src).toContain('blankRefusal: "A reason is required to delete a template"');
  });
  it("reads the versions table from the one component, with the Open draft action its own", () => {
    expect(named(PAGE, "TemplateVersions").length).toBe(1);
    expect(src).toContain("Open draft from this version");
    expect(src).not.toContain("<table");
  });
});

describe("the template editor", () => {
  const PAGE = "src/app/admin/templates/[id]/edit/TemplateEditor.tsx";
  const src = read(PAGE);
  it("takes the header with Save draft and the tabs beside the card", () => {
    const header = named(PAGE, "PageHeader");
    expect(header.length).toBe(1);
    expect(header[0].attr("title")).toBe("detail.name");
    expect(src).toContain("Save draft");
    const tabs = named(PAGE, "RecordTabs");
    expect(tabs.length).toBe(1);
    expect(tabs[0].attr("tabs")).toBe("tabs");
    const panels = squash(tabs[0].attr("panels"));
    for (const key of ["design:", "sections:", "widths:", "appearance:", "wording:", "preview:", "versions:"]) expect(panels).toContain(key);
    expect(panels).toContain("<DesignPanel");
    expect(panels.slice(panels.indexOf("<DesignPanel"), panels.indexOf("/>", panels.indexOf("<DesignPanel")))).toContain("measure={measure}");
    expect(src).toContain("canvas: config.layout !== null");
    expect(src).toContain("useState<CanvasMeasure | null>(null)");
    for (const panel of ["WidthsPanel", "FormatsPanel", "FontsPanel", "TextBlocksPanel", "FooterAndLogoPanel", "LogoPanel"]) expect(panels).toContain(`<${panel}`);
    expect(panels.indexOf("<SectionsPanel")).toBeLessThan(panels.indexOf("<WidthsPanel"));
    expect(panels).toContain("<PreviewPane");
  });
  it("holds the preview record and All loads, the pane controlled (ruling C2), so Design on a canvas can read them", () => {
    // Two panes, one record (ruling C16): the Preview tab's and the Design panel's live page.
    const panes = named(PAGE, "PreviewPane");
    expect(panes.length).toBe(2);
    for (const pane of panes) {
      expect(pane.attr("recordId")).toBe('previewRecord?.id ?? ""');
      expect(pane.attr("onRecordId")).toBe("pickPreviewRecord");
      expect(pane.attr("allLoads")).toBe("allLoads");
      expect(pane.attr("onAllLoads")).toBe("setAllLoads");
    }
    expect(src).toContain("useState<{ id: string; label: string; recordNumber: string } | null>(null)");
    // The pane reports the record's number (an order's or a shipment's) from the row it holds (never
    // read back out of the label).
    expect(read("src/app/admin/templates/[id]/edit/PreviewPane.tsx")).toContain("recordNumber: str(r.orderNumber)");
    expect(read("src/app/admin/templates/[id]/edit/PreviewPane.tsx")).toContain("recordNumber: str(r.shipperNumber)");
    const pane = read("src/app/admin/templates/[id]/edit/PreviewPane.tsx");
    expect(pane).not.toContain("setRecordId");
    expect(pane).not.toContain("setAllLoads");
  });
  it("clears the measure when the record is cleared (ruling C19), so no other order's measure stays beside the stage", () => {
    const pick = src.slice(src.indexOf("function pickPreviewRecord"), src.indexOf("function openDesign"));
    expect(pick).toContain('if (id === "") setMeasure(null);');
  });
  it("hands Sections the seed and Design its two actions, and Back to sections drops the measure (ruling C1)", () => {
    const sections = named(PAGE, "SectionsPanel");
    expect(sections.length).toBe(1);
    expect(sections[0].attr("onDesign")).toBe("designOnCanvas");
    expect(sections[0].attr("design")).toBe("canvasPrints(contract.docType) ? designState : undefined");
    const design = named(PAGE, "DesignPanel");
    expect(design.length).toBe(1);
    expect(design[0].attr("onBackToSections")).toBe("backToSections");
    expect(design[0].attr("onClearPage")).toBe("clearPage");
    const back = src.slice(src.indexOf("async function backToSections"), src.indexOf("async function clearPage"));
    expect(back).toContain("setLayout(c, null)");
    expect(back).toContain("setMeasure(null)");
    expect(src.slice(src.indexOf("async function clearPage"))).toContain("setLayout(c, clearedLayout(contractFor(detail.docType), canvasPageFor(detail.docType, c.formats.labelSize), c.fonts)))");
    expect(src).toContain('setOpenTab({ id: "canvas-design"');
  });
  it("hands the Design panel its own live page, which runs itself and reports the measure (Task 6, ruling C16)", () => {
    const panes = named(PAGE, "PreviewPane");
    const live = panes.filter((pane) => pane.attr("autoRun") !== undefined);
    expect(live.length).toBe(1);
    expect(live[0].attr("autoRun")).toBe("");
    expect(live[0].attr("onMeasure")).toBe("setMeasure");
    // The Preview tab's pane keeps its click and reports no measure.
    const tab = panes.filter((pane) => pane.attr("autoRun") === undefined);
    expect(tab.length).toBe(1);
    expect(tab[0].attr("onMeasure")).toBeUndefined();
    const design = named(PAGE, "DesignPanel");
    expect(design.length).toBe(1);
    expect(squash(design[0].attr("preview") ?? "")).toContain("<PreviewPane");
    expect(squash(design[0].attr("preview") ?? "")).toContain("onMeasure={setMeasure}");
    // The pane reports to the editor directly (ruling C16): the panel takes no onMeasure of its own.
    expect(design[0].attr("onMeasure")).toBeUndefined();
  });
  it("keeps the banners above the tabs, so nothing lands on a hidden panel", () => {
    const at = src.indexOf("<RecordTabs");
    for (const banner of ["{notice}", "{conflict && (", "{error && ("]) {
      const seen = src.indexOf(banner, src.indexOf("<PageHeader"));
      expect(seen).toBeGreaterThan(-1);
      expect(seen).toBeLessThan(at);
    }
  });
});
