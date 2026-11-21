// The template editor's page PR (spec 2026-10-30-ux-redesign-design.md §4.3–§4.6; the UX redesign
// PR 13, owner 2026-11-02 on #828): the tabs a contract earns, the Section actions menu, the BOL's
// clause list and the renames. Panels are props-in, markup-out, so they are rendered; the pages are
// read as text, because vitest renders neither.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { FontsPanel, FormatsPanel, SectionsPanel, TextBlocksPanel, WidthsPanel } from "@/app/admin/templates/[id]/edit/panels";
import { PreviewPane, optionsFor } from "@/app/admin/templates/[id]/edit/PreviewPane";
import { DesignPanel } from "@/app/admin/templates/[id]/edit/DesignPanel";
import { LogoPanel } from "@/app/admin/templates/[id]/edit/LogoPanel";
import { DESIGNER_WORDS, designOnCanvasGate } from "@/lib/canvas-designer";
import { canvasRefusal } from "@/lib/template-canvas";
import { barcode, layoutOf, standardLayout } from "./helpers/canvas-fixtures";
import { editorTabs } from "@/lib/admin-tabs";
import { tabForLocation } from "@/lib/record-tabs";
import {
  BOL_CONTRACT, BOL_DEFAULT_CONFIG, CERT_CONTRACT, CERT_DEFAULT_CONFIG, INVOICE_CONTRACT, INVOICE_DEFAULT_CONFIG, QUOTE_CONTRACT, QUOTE_DEFAULT_CONFIG,
  MOS_SHIPPER_CONTRACT, MOS_SHIPPER_DEFAULT_CONFIG, SHIPPER_CONTRACT, SHIPPER_DEFAULT_CONFIG, STATEMENT_CONTRACT, STATEMENT_DEFAULT_CONFIG,
  TRAVELER_CONTRACT, TRAVELER_DEFAULT_CONFIG, defaultConfigFor, type TemplateConfig, type TemplateContract,
} from "@/lib/template-contracts";
import { TEST_DOC_TYPE, testContract, withTestContract } from "./helpers/test-contract";
import { lockIndex, toggleSectionVisible } from "@/lib/template-editor";
import { jsxTags } from "./helpers/jsx-source";
import { all } from "./helpers/source-lift";
import { callsBareIdentifier } from "./helpers/ts-parse";

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), "utf8");
const props = (contract: TemplateContract, config: TemplateConfig, over: object = {}) => ({
  contract, config, apply: () => {}, disabled: false, editTitle: undefined, locks: lockIndex(contract), ...over,
});
/** The menu items of one section's row, as [label, disabled, title]. */
function items(html: string, section: string) {
  const chunk = html.slice(html.indexOf(`aria-label="${section}"`));
  return [...chunk.slice(0, chunk.indexOf("</details>")).matchAll(/<button\b([^>]*)role="menuitem"([^>]*)>([^<]*)</g)]
    .map((m) => [m[3], `${m[1]}${m[2]}`.includes('disabled=""'), (m[1] + m[2]).match(/title="([^"]*)"/)?.[1]]);
}

describe("the tabs a contract earns", () => {
  it("names all six in order", () => {
    expect(editorTabs({ wording: true, widths: true, canvas: false }).map((t) => [t.key, t.label])).toEqual([
      ["sections", "Sections"], ["widths", "Fields & widths"], ["appearance", "Appearance"],
      ["wording", "Wording"], ["preview", "Preview"], ["versions", "Versions"],
    ]);
  });
  it("leaves out a tab with nothing on it", () => {
    expect(editorTabs({ wording: false, widths: true, canvas: false }).map((t) => t.key)).not.toContain("wording");
    expect(editorTabs({ wording: true, widths: false, canvas: false }).map((t) => t.key)).not.toContain("widths");
  });
  it("reaches Fields & widths by its id, for the menu's request", () => {
    expect(tabForLocation(editorTabs({ wording: true, widths: true, canvas: false }), "", "#column-widths")).toBe("widths");
  });
  it("closes Save on a refused canvas layout as on the width budget (the page is read, not rendered; ruling C12)", () => {
    const page = read("app/admin/templates/[id]/edit/TemplateEditor.tsx");
    expect(page).toContain("widthBudgetError(contract, config) ?? canvasSaveBlock(contract, config)");
    expect(page).toContain('import { canvasSaveBlock, lockIndex, seedFailureMessage, seedRequest, setLayout, widthBudgetError } from "@/lib/template-editor";');
  });
  it("names Design in place of Sections and Fields & widths on a canvas template, the rest unchanged and in order", () => {
    const tabs = editorTabs({ wording: true, widths: true, canvas: true });
    expect(tabs.map((t) => [t.key, t.label])).toEqual([
      ["design", "Design"], ["appearance", "Appearance"], ["wording", "Wording"], ["preview", "Preview"], ["versions", "Versions"],
    ]);
    expect(tabs[0]).toEqual({ key: "design", label: "Design", sections: [], ids: ["canvas-design"] });
    expect(editorTabs({ wording: false, widths: false, canvas: true }).map((t) => t.key))
      .toEqual(["design", "appearance", "preview", "versions"]);
    expect(tabForLocation(tabs, "", "#canvas-design")).toBe("design");
  });
});

describe("Section actions", () => {
  const onEditWidths = () => {};
  it("is the section's one way to move and hide, its show box gone", () => {
    const html = renderToStaticMarkup(<SectionsPanel {...props(SHIPPER_CONTRACT, SHIPPER_DEFAULT_CONFIG)} onEditWidths={onEditWidths} />);
    expect(html).not.toContain('aria-label="Show section');
    expect(html).toContain("Section actions");
    expect(items(html, "Part lines").map((i) => i[0])).toEqual(["Move up", "Move down", "Hide section", "Edit fields and widths"]);
    expect(items(html, "Header")[0]).toEqual(["Move up", true, "Already first"]);
  });
  it("keeps a field's own arrows and show box on its row", () => {
    const html = renderToStaticMarkup(<SectionsPanel {...props(SHIPPER_CONTRACT, SHIPPER_DEFAULT_CONFIG)} />);
    expect(html).toContain('aria-label="Show field');
    expect(html).toContain('aria-label="Move up"');
  });
  it("closes a locked section's Hide and moves with its lock's reason", () => {
    const html = renderToStaticMarkup(<SectionsPanel {...props(TRAVELER_CONTRACT, TRAVELER_DEFAULT_CONFIG)} />);
    const reason = lockIndex(TRAVELER_CONTRACT).get("section:steps")!.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
    const name = TRAVELER_CONTRACT.sections.find((s) => s.key === "steps")!.name;
    expect(items(html, name).find((i) => i[0] === "Hide section")).toEqual(["Hide section", true, reason]);
    expect(items(html, name).find((i) => i[0] === "Move up")).toEqual(["Move up", true, reason]);
  });
  it("reads Show section, with a Hidden tag, on a hidden one", () => {
    const hidden = toggleSectionVisible(SHIPPER_DEFAULT_CONFIG, "lines");
    const html = renderToStaticMarkup(<SectionsPanel {...props(SHIPPER_CONTRACT, hidden)} />);
    expect(items(html, "Part lines").map((i) => i[0])).toContain("Show section");
    expect(html).toContain(">Hidden<");
  });
  it("closes every write for a view-only user, with the edit reason; Edit fields and widths only navigates", () => {
    const html = renderToStaticMarkup(<SectionsPanel {...props(SHIPPER_CONTRACT, SHIPPER_DEFAULT_CONFIG, { disabled: true, editTitle: "Requires templates.edit" })} onEditWidths={onEditWidths} />);
    const found = items(html, "Part lines");
    expect(found.map((i) => i[0])).toEqual(["Move up", "Move down", "Hide section", "Edit fields and widths"]);
    for (const [label, disabled, title] of found.slice(0, 3)) {
      expect(`${label}: ${disabled}`).toBe(`${label}: true`);
      expect(title).toBe("Requires templates.edit");
    }
    expect(found[3][1]).toBe(false);
  });
  it("offers Edit fields and widths only where that tab exists", () => {
    const html = renderToStaticMarkup(<SectionsPanel {...props(SHIPPER_CONTRACT, SHIPPER_DEFAULT_CONFIG)} />);
    expect(html).not.toContain("Edit fields and widths");
  });
});

describe("Wording", () => {
  it("lists the BOL's clauses with one box, Property clause first picked", () => {
    const html = renderToStaticMarkup(<TextBlocksPanel {...props(BOL_CONTRACT, BOL_DEFAULT_CONFIG)} />);
    expect(html).toContain(">Wording<");
    expect(html).toContain(">Standing clauses<");
    expect(html.match(/<textarea/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Property clause"');
    for (const t of BOL_CONTRACT.textBlocks) expect(html).toContain(`>${t.name}<`);
    expect(html.match(/aria-current="true"[^>]*>([^<]*)</)?.[1]).toBe("Property clause");
  });
  it("keeps plain boxes on a document with one or two blocks", () => {
    const html = renderToStaticMarkup(<TextBlocksPanel {...props(QUOTE_CONTRACT, QUOTE_DEFAULT_CONFIG)} />);
    expect(html).not.toContain("Standing clauses");
    expect(html.match(/<textarea/g)).toHaveLength(QUOTE_CONTRACT.textBlocks.length);
  });
  it("shows nothing on a document with no standing text", () => {
    expect(renderToStaticMarkup(<TextBlocksPanel {...props(INVOICE_CONTRACT, INVOICE_DEFAULT_CONFIG)} />)).toBe("");
  });
  it("still lets a view-only user browse the clauses, the box closed", () => {
    const html = renderToStaticMarkup(<TextBlocksPanel {...props(BOL_CONTRACT, BOL_DEFAULT_CONFIG, { disabled: true })} />);
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(html).not.toMatch(/<button[^>]*disabled=""/);
  });
});

describe("the renames", () => {
  it("Typography and its four labels", () => {
    const html = renderToStaticMarkup(<FontsPanel {...props(SHIPPER_CONTRACT, SHIPPER_DEFAULT_CONFIG)} />);
    for (const word of [">Typography<", ">Font family<", ">Body (pt)<", ">Heading (pt)<", ">Small text (pt)<"]) expect(html).toContain(word);
  });
  it("Formats", () => {
    expect(renderToStaticMarkup(<FormatsPanel {...props(SHIPPER_CONTRACT, SHIPPER_DEFAULT_CONFIG)} />)).toContain(">Formats<");
  });
  it("a flexible box's grey text", () => {
    const html = renderToStaticMarkup(<WidthsPanel {...props(SHIPPER_CONTRACT, SHIPPER_DEFAULT_CONFIG)} />);
    expect(html).toContain('placeholder="Flexible"');
    expect(html).not.toContain('placeholder="flex"');
  });
  it("Preview record and one Generate preview", () => {
    const src = read("app/admin/templates/[id]/edit/PreviewPane.tsx");
    expect(src).toContain(">Preview record</h2>");
    expect(src).toContain("Preview against:");
    expect(src).toContain('rendering ? "Rendering…" : "Generate preview"');
    expect(src).not.toContain("Refresh preview");
    expect(src).not.toContain("Run preview");
  });
  it("the list's three names", () => {
    const src = read("app/admin/templates/page.tsx");
    for (const word of ["Publish saved draft", "Discard local edits", "View version history"]) expect(src).toContain(word);
    expect(src).not.toContain("Discard draft");
    expect(src).not.toMatch(/>\s*Publish\s*</);
  });
  it("the view-only strip and the no-access sentence", () => {
    const editor = read("app/admin/templates/[id]/edit/TemplateEditor.tsx");
    expect(editor).toContain("You can view this draft. Editing needs template-edit permission.");
    expect(editor).not.toContain("Template access unavailable.");
    expect(read("lib/document-template-recovery.ts")).not.toContain("Template access unavailable.");
    expect(editor).toContain("Access unavailable.");
    expect(editor).toContain("Back to templates");
  });
  it("Template status: its rows and note", () => {
    const editor = read("app/admin/templates/[id]/edit/TemplateEditor.tsx");
    expect(editor).toContain('title="Template status"');
    for (const row of ['label: "Document"', 'label: "Published"', 'label: "Editing"', 'label: "Changes", value: dirty ? "Unsaved" : "Saved"']) expect(editor).toContain(row);
    expect(editor).toContain("Preview uses this draft. Existing documents and print status stay unchanged.");
    expect(editor).toContain("<UnsavedBadge dirty={dirty} />");
  });
});

describe("the canvas actions (PR C of #926, Task 5)", () => {
  /** The opening tag of the one button whose text is `label`, or null. */
  const button = (html: string, label: string) =>
    [...html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].find((m) => m[2] === label)?.[1] ?? null;
  const gate = (over: Partial<Parameters<typeof designOnCanvasGate>[0]> = {}) =>
    designOnCanvasGate({ blocked: false, editTitle: undefined, picked: true, busy: false, ...over }, "TRAVELER");
  const sections = (contract: TemplateContract, config: TemplateConfig, design: { disabled: boolean; title: string | undefined; message: string | null }) =>
    renderToStaticMarkup(<SectionsPanel {...props(contract, config)} onDesign={() => {}} design={design} />);

  it("Sections offers Design on a canvas on a traveler, closed with Pick an order in Preview first until one is picked", () => {
    const closed = button(sections(TRAVELER_CONTRACT, TRAVELER_DEFAULT_CONFIG, { ...gate({ picked: false }), message: null }), DESIGNER_WORDS.designOnCanvas);
    expect(closed).not.toBeNull();
    expect(closed).toContain('disabled=""');
    expect(closed).toContain(`title="${DESIGNER_WORDS.pickRecordFirst("TRAVELER")}"`);
    const open = button(sections(TRAVELER_CONTRACT, TRAVELER_DEFAULT_CONFIG, { ...gate(), message: null }), DESIGNER_WORDS.designOnCanvas);
    expect(open).not.toBeNull();
    expect(open).not.toContain("disabled");
    expect(open).not.toContain("title=");
  });
  it("shows the seed's refusal in the Sections panel's own message", () => {
    const html = sections(TRAVELER_CONTRACT, TRAVELER_DEFAULT_CONFIG, { ...gate(), message: "Order not found" });
    expect(html).toContain('<p role="alert" class="mt-1 whitespace-pre-line text-sm text-red-700">Order not found</p>');
  });
  /** The Sections panel on the stubbed docType given the certification's profile (tests/helpers/test-contract.ts),
   *  registered so the panel's `canvasPrints(docType)` reads it, the contract handed as the prop carrying the
   *  profile too; its gate is built with a real docType, since no docType-keyed table has a TEST row. */
  const profiledStub = (picked: boolean) => withTestContract(() => sections(
    testContract(CERT_CONTRACT.canvas), defaultConfigFor(TEST_DOC_TYPE),
    { ...designOnCanvasGate({ blocked: false, editTitle: undefined, picked, busy: false }, "CERT"), message: null },
  ), { canvas: CERT_CONTRACT.canvas });
  it("offers no canvas on a contract with no profile, an action handed to it or not", () => {
    // The stub (tests/helpers/test-contract.ts), registered, since the panel reads canvasPrints(docType);
    // gate() stays the traveler's, so no docType-keyed table is asked of "TEST".
    expect(withTestContract(() => sections(testContract(), defaultConfigFor(TEST_DOC_TYPE), { ...gate(), message: null })))
      .not.toContain(DESIGNER_WORDS.designOnCanvas);
    expect(renderToStaticMarkup(<SectionsPanel {...props(TRAVELER_CONTRACT, TRAVELER_DEFAULT_CONFIG)} />)).not.toContain(DESIGNER_WORDS.designOnCanvas);
  });
  it("offers Design on a canvas on a bill of lading, closed with Pick a shipment in Preview first until one is picked", () => {
    const g = (picked: boolean) => ({ ...designOnCanvasGate({ blocked: false, editTitle: undefined, picked, busy: false }, "BOL"), message: null });
    const closed = button(sections(BOL_CONTRACT, BOL_DEFAULT_CONFIG, g(false)), DESIGNER_WORDS.designOnCanvas);
    expect(closed).not.toBeNull();
    expect(closed).toContain('disabled=""');
    expect(closed).toContain('title="Pick a shipment in Preview first"');
    const open = button(sections(BOL_CONTRACT, BOL_DEFAULT_CONFIG, g(true)), DESIGNER_WORDS.designOnCanvas);
    expect(open).not.toBeNull();
    expect(open).not.toContain("disabled");
    expect(open).not.toContain("title=");
    // The stubbed docType given a profile keeps offering none.
    expect(profiledStub(true)).not.toContain(DESIGNER_WORDS.designOnCanvas);
  });
  it("offers Design on a canvas on a certification, closed with Pick a certification in Preview first until one is picked", () => {
    const g = (picked: boolean) => ({ ...designOnCanvasGate({ blocked: false, editTitle: undefined, picked, busy: false }, "CERT"), message: null });
    const closed = button(sections(CERT_CONTRACT, CERT_DEFAULT_CONFIG, g(false)), DESIGNER_WORDS.designOnCanvas);
    expect(closed).not.toBeNull();
    expect(closed).toContain('disabled=""');
    expect(closed).toContain('title="Pick a certification in Preview first"');
    const open = button(sections(CERT_CONTRACT, CERT_DEFAULT_CONFIG, g(true)), DESIGNER_WORDS.designOnCanvas);
    expect(open).not.toBeNull();
    expect(open).not.toContain("disabled");
    expect(open).not.toContain("title=");
  });
  it("offers Design on a canvas on an invoice, closed with Pick an invoice or credit in Preview first until one is picked", () => {
    // Reds when "INVOICE" leaves CANVAS_PRINTS (Task 1 Step 5): `canvasPrints` then offers none.
    const g = (picked: boolean) => ({ ...designOnCanvasGate({ blocked: false, editTitle: undefined, picked, busy: false }, "INVOICE"), message: null });
    const closed = button(sections(INVOICE_CONTRACT, INVOICE_DEFAULT_CONFIG, g(false)), DESIGNER_WORDS.designOnCanvas);
    expect(closed).not.toBeNull();
    expect(closed).toContain('disabled=""');
    expect(closed).toContain('title="Pick an invoice or credit in Preview first"');
    const open = button(sections(INVOICE_CONTRACT, INVOICE_DEFAULT_CONFIG, g(true)), DESIGNER_WORDS.designOnCanvas);
    expect(open).not.toBeNull();
    expect(open).not.toContain("disabled");
    expect(open).not.toContain("title=");
    // The stubbed docType given a profile keeps offering none.
    expect(profiledStub(true)).not.toContain(DESIGNER_WORDS.designOnCanvas);
  });
  it("offers Design on a canvas on a statement, closed with Pick a customer in Preview first until one is picked", () => {
    // Reds when "STATEMENT" leaves CANVAS_PRINTS: `canvasPrints` then offers none.
    const g = (picked: boolean) => ({ ...designOnCanvasGate({ blocked: false, editTitle: undefined, picked, busy: false }, "STATEMENT"), message: null });
    const closed = button(sections(STATEMENT_CONTRACT, STATEMENT_DEFAULT_CONFIG, g(false)), DESIGNER_WORDS.designOnCanvas);
    expect(closed).not.toBeNull();
    expect(closed).toContain('disabled=""');
    expect(closed).toContain('title="Pick a customer in Preview first"');
    const open = button(sections(STATEMENT_CONTRACT, STATEMENT_DEFAULT_CONFIG, g(true)), DESIGNER_WORDS.designOnCanvas);
    expect(open).not.toBeNull();
    expect(open).not.toContain("disabled");
    expect(open).not.toContain("title=");
    // The stubbed docType given a profile keeps offering none.
    expect(profiledStub(true)).not.toContain(DESIGNER_WORDS.designOnCanvas);
  });
  it("offers Design on a canvas on a quotation, closed with Pick a quote in Preview first until one is picked", () => {
    // Since quote canvas PR 2. Reds when "QUOTE" leaves CANVAS_PRINTS: `canvasPrints` then offers none.
    const g = (picked: boolean) => ({ ...designOnCanvasGate({ blocked: false, editTitle: undefined, picked, busy: false }, "QUOTE"), message: null });
    const closed = button(sections(QUOTE_CONTRACT, QUOTE_DEFAULT_CONFIG, g(false)), DESIGNER_WORDS.designOnCanvas);
    expect(closed).not.toBeNull();
    expect(closed).toContain('disabled=""');
    expect(closed).toContain('title="Pick a quote in Preview first"');
    const open = button(sections(QUOTE_CONTRACT, QUOTE_DEFAULT_CONFIG, g(true)), DESIGNER_WORDS.designOnCanvas);
    expect(open).not.toBeNull();
    expect(open).not.toContain("disabled");
    expect(open).not.toContain("title=");
  });
  it("offers no Design on a profiled contract whose canvas does not print (the stubbed docType given a profile), picked or not", () => {
    // The panel's own gate is `canvasPrints(contract.docType)`, never the profile alone: every real
    // docType prints since quote canvas PR 2, so the stub given the certification's profile stands
    // outside CANVAS_PRINTS. Red when panels.tsx's gate reads the profile alone
    // (`contract.canvas !== undefined && design !== undefined`): the stub is then offered Design.
    expect(testContract(CERT_CONTRACT.canvas).canvas).toBeDefined();
    for (const picked of [false, true]) {
      const html = profiledStub(picked);
      expect(html, `picked ${picked}`).toContain("Sections and fields");
      expect(html, `picked ${picked}`).not.toContain(DESIGNER_WORDS.designOnCanvas);
    }
  });
  it("optionsFor labels a bill of lading's shipment, any order count, by its own number (the ticket 2b ledger's deferred minor)", () => {
    const rows = [
      { id: "a", shipperNumber: 12, customerCode: "ACME", orderCount: 2 },
      { id: "b", shipperNumber: 13, customerCode: "ACME", orderCount: 1 },
      { id: "c", shipperNumber: 14, customerCode: "ACME", orderCount: 1, deletedAt: "2026-01-01" },
      { id: "d", customerCode: "ACME", orderCount: 1 },
    ];
    expect(optionsFor("shipment", rows)).toEqual([
      { id: "a", label: "Shipment #12 — ACME (2 orders)", recordNumber: "12" },
      { id: "b", label: "Shipment #13 — ACME (1 order)", recordNumber: "13" },
      { id: "d", label: "Shipment # — ACME (1 order)", recordNumber: "" },
    ]);
  });
  it("offers Design on a canvas on both shipping tickets, closed with the pick sentence until a shipment is picked", () => {
    for (const [contract, config, docType] of [
      [SHIPPER_CONTRACT, SHIPPER_DEFAULT_CONFIG, "SHIPPER"], [MOS_SHIPPER_CONTRACT, MOS_SHIPPER_DEFAULT_CONFIG, "MOS_SHIPPER"],
    ] as const) {
      const g = (picked: boolean) => ({ ...designOnCanvasGate({ blocked: false, editTitle: undefined, picked, busy: false }, docType), message: null });
      const closed = button(sections(contract, config, g(false)), DESIGNER_WORDS.designOnCanvas);
      expect(closed).toContain('disabled=""');
      expect(closed).toContain(`title="${docType === "SHIPPER" ? "Pick a single-order shipment in Preview first" : "Pick a multi-order shipment in Preview first"}"`);
      const open = button(sections(contract, config, g(true)), DESIGNER_WORDS.designOnCanvas);
      expect(open).not.toBeNull();
      expect(open).not.toContain("disabled");
    }
  });
  it("optionsFor carries the picked record's own number: an order's, a shipment's and a certification's printed label, an invoice's kind and number, a customer's code and a quote's number", () => {
    const rows = [
      { id: "a", shipperNumber: 12, customerCode: "ACME", orderCount: 1 },
      { id: "b", shipperNumber: 13, customerCode: "ACME", orderCount: 2 },
      { id: "c", shipperNumber: 14, customerCode: "ACME", orderCount: 1, deletedAt: "2026-01-01" },
    ];
    expect(optionsFor("shipment-single", rows)).toEqual([{ id: "a", label: "Shipment #12 — ACME (1 order)", recordNumber: "12" }]);
    expect(optionsFor("order", [{ id: "o", orderNumber: 7, customerCode: "ACME", leadPartNumber: "P1" }])[0].recordNumber).toBe("7");
    // An invoice or a credit by its kind and the number its paper prints (readInvoicePdfData's title
    // and documentNumber; tests/invoice-pdf.test.ts holds the two together); the option keeps its label.
    const invoices = optionsFor("invoice", [
      { id: "i1", kind: "INVOICE", documentNumber: "7 - 92026", customerCode: "ACME" },
      { id: "i2", kind: "INVOICE", documentNumber: "92026", customerCode: "ACME" },
      { id: "i3", kind: "CREDIT", documentNumber: "512", customerCode: "ACME" },
      { id: "i4", kind: "INVOICE", documentNumber: "7 - 92027", customerCode: "ACME", deletedAt: "2026-01-01" },
    ]);
    expect(invoices.map((o) => o.recordNumber)).toEqual(["invoice 7 - 92026", "invoice 92026", "credit 512"]);
    expect(invoices.map((o) => o.label)).toEqual(["Invoice 7 - 92026 — ACME", "Invoice 92026 — ACME", "Credit 512 — ACME"]);
    // A customer by the code its statement's Customer line prints (buildStatement's customer.code;
    // tests/statements.test.ts holds the two together); the option keeps its label.
    const customers = optionsFor("customer", [
      { id: "u1", code: "ACME", name: "Acme" },
      { id: "u2", code: "BETA", name: "Beta" },
      { id: "u3", code: "GONE", name: "Gone", deletedAt: "2026-01-01" },
    ]);
    expect(customers.map((o) => o.recordNumber)).toEqual(["ACME", "BETA"]);
    expect(customers.map((o) => o.label)).toEqual(["ACME — Acme", "BETA — Beta"]);
    // A quote by the number its paper prints (readQuotePdfData's quoteNumber; tests/quote-pdf.test.ts
    // holds the two together); the option keeps its label, and a deleted quote offers nothing.
    const quotes = optionsFor("quote", [
      { id: "q1", quoteNumber: 3, customerCode: "ACME", status: "OPEN" },
      { id: "q2", quoteNumber: 4, customerCode: "ACME", status: "CLOSED" },
      { id: "q3", quoteNumber: 5, customerCode: "ACME", status: "OPEN", deletedAt: "2026-01-01" },
    ]);
    expect(quotes.map((o) => o.recordNumber)).toEqual(["3", "4"]);
    expect(quotes.map((o) => o.label)).toEqual(["Quote #3 — ACME (OPEN)", "Quote #4 — ACME (CLOSED)"]);
    // A certification by the Order No. its paper prints (readCertPdfData's orderLabel), a load's
    // number after it, so two load certificates of one order are named apart.
    const cert = (id: string, over: object) =>
      ({ id, orderNumber: 92036, customerCode: "ACME", sequence: null, scope: "ORDER", loadNumber: null, ...over });
    const certs = optionsFor("cert", [
      cert("c1", {}),
      cert("c2", { sequence: 3, scope: "SHIPMENT" }),
      cert("c3", { scope: "LOAD", loadNumber: 2 }),
      cert("c4", { sequence: null, scope: "SHIPMENT" }),
      cert("c5", { deletedAt: "2026-01-01" }),
    ]);
    expect(certs.map((o) => o.recordNumber)).toEqual(["92036", "92036-3", "92036, load 2", "92036"]);
    expect(certs.map((o) => o.label)).toEqual([
      "Cert — order #92036 — ACME (ORDER)", "Cert — order #92036 — ACME (SHIPMENT)",
      "Cert — order #92036 — ACME (LOAD)", "Cert — order #92036 — ACME (SHIPMENT)",
    ]);
  });

  const canvas = (layout = standardLayout()): TemplateConfig => ({ ...TRAVELER_DEFAULT_CONFIG, layout });
  const design = (config: TemplateConfig, over: object = {}) => renderToStaticMarkup(
    <DesignPanel templateId="t1" contract={TRAVELER_CONTRACT} config={config} apply={() => {}} disabled={false}
                 editTitle={undefined} measure={null} logoSrc={null}
                 onBackToSections={() => {}} onClearPage={() => {}} preview={null} {...over} />,
  );
  it("puts Back to sections and Clear the page in the Design panel's header, closed with the edit reason", () => {
    const html = design(canvas());
    for (const label of [DESIGNER_WORDS.backToSections, DESIGNER_WORDS.clearPage]) {
      const tag = button(html, label);
      expect(tag).not.toBeNull();
      expect(tag).not.toContain("disabled");
      expect(html.indexOf(label)).toBeLessThan(html.indexOf('aria-label="Canvas items"'));
    }
    const closed = design(canvas(), { disabled: true, editTitle: "Requires templates.edit" });
    for (const label of [DESIGNER_WORDS.backToSections, DESIGNER_WORDS.clearPage]) {
      expect(button(closed, label)).toContain('disabled=""');
      expect(button(closed, label)).toContain('title="Requires templates.edit"');
    }
  });
  it("shows the canvas's refusal in the Design panel's message, the sentence that closes Save", () => {
    const twoBarcodes = layoutOf([...standardLayout().items, barcode({ id: "barcode-2", box: { x: 402, y: 600, w: 186, h: 44 } })]);
    const refusal = canvasRefusal(twoBarcodes, TRAVELER_CONTRACT, { pageFooter: TRAVELER_DEFAULT_CONFIG.pageFooter });
    expect(refusal).not.toBeNull();
    expect(design(canvas(twoBarcodes))).toContain(`<p role="alert" class="mt-1 whitespace-pre-line text-sm text-red-700">${refusal!.sentence}</p>`);
    expect(design(canvas())).not.toContain('role="alert"');
  });

  const logo = (config: TemplateConfig) => renderToStaticMarkup(
    <LogoPanel templateId="t1" logoMimeType="image/png" config={config} apply={() => {}} disabled={false}
               editTitle={undefined} onLogoChanged={() => {}} />,
  );
  it("a canvas template's logo panel names the Logo item in place of placement and width; Upload and Remove stay", () => {
    const html = logo(canvas());
    expect(html).toContain(`<p class="text-sm text-ink-500">${DESIGNER_WORDS.logoPlaced}</p>`);
    expect(html).toContain(DESIGNER_WORDS.logoPrintsCanvas);
    expect(html).not.toContain("a header placement is chosen");
    expect(html).not.toContain('aria-label="Logo placement"');
    expect(html).not.toContain('aria-label="Logo width"');
    expect(html).toContain('aria-label="Upload logo image"');
    expect(html).toContain("Remove image");
    const flow = logo(TRAVELER_DEFAULT_CONFIG);
    expect(flow).toContain('aria-label="Logo placement"');
    expect(flow).toContain('aria-label="Logo width"');
    expect(flow).not.toContain(DESIGNER_WORDS.logoPlaced);
    expect(flow).toContain("a header placement is chosen");
    expect(flow).not.toContain(DESIGNER_WORDS.logoPrintsCanvas);
  });
});

describe("the canvas actions' guards in the editor (the page is read, not rendered)", () => {
  const page = read("app/admin/templates/[id]/edit/TemplateEditor.tsx");
  it("resets the seed's busy flag and message with the binding's lifetime, beside Save's", () => {
    const reset = page.split("\n").find((line) => line.includes("setLifetime(token)"));
    expect(reset).toBeDefined();
    for (const call of ["setSaving(false)", "setSeeding(false)", "setSeedMessage(null)"]) expect(reset).toContain(call);
  });
  it("checks the editor is still current after each of its three asks, and before the seed's answer is applied", () => {
    const asks = page.split("await askConfirm(").slice(1);
    expect(asks).toHaveLength(3);
    for (const after of asks) {
      const check = after.slice(after.indexOf("if ("), after.indexOf(")", after.indexOf("if (")) + 1);
      expect(check).toContain("!isLive()");
      expect(after.indexOf("if (")).toBeLessThan(after.indexOf("apply("));
    }
    const seeded = page.slice(page.indexOf("await api<CanvasLayout>("), page.indexOf("apply((c) => setLayout(c, layout))"));
    expect(seeded).toContain("if (!isLive()) return;");
    expect(page).toContain("setSeedMessage(seedFailureMessage(e))");
  });
  it("builds the action's gate from the picked record, and clears the seed's message when the record changes", () => {
    expect(page).toContain("picked: previewRecord !== null");
    const pick = page.slice(page.indexOf("function pickPreviewRecord"), page.indexOf("\n  }\n", page.indexOf("function pickPreviewRecord")));
    expect(pick).toContain("setSeedMessage(null)");
    expect(page).toContain("DESIGNER_WORDS.designConfirm(detail.docType, record.recordNumber)");
  });
});

// Since statement canvas PR 2, the Preview's as-of date and Combine family are the editor's,
// handed to both panes as allLoads is (the Preview tab's and the Design panel's live page), so the
// Design tab measures the statement the Preview tab shows. The pane's boxes are rendered; the wiring
// is read from the source, parsed (#188), every count a literal so a reader that finds nothing fails.
describe("the Preview's as-of date and Combine family, held by the editor", () => {
  const PANE = "src/app/admin/templates/[id]/edit/PreviewPane.tsx";
  const PAGE = "src/app/admin/templates/[id]/edit/TemplateEditor.tsx";
  const parsed = (file: string) => ts.createSourceFile(file, read(file.replace(/^src\//, "")), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  /** Every `const [a, b] = useState(...)` of `file`, as [a, b]. */
  const statePairs = (file: string) => all(parsed(file), ts.isVariableDeclaration)
    .filter((d) => d.initializer !== undefined && ts.isCallExpression(d.initializer)
      && ts.isIdentifier(d.initializer.expression) && d.initializer.expression.text === "useState"
      && ts.isArrayBindingPattern(d.name))
    .map((d) => (d.name as ts.ArrayBindingPattern).elements.map((e) => (ts.isBindingElement(e) ? e.name.getText() : "")));
  /** `runPreview`'s `useCallback(fn, deps)` call. */
  const runPreview = () => {
    const found = all(parsed(PANE), ts.isVariableDeclaration).filter((d) => d.name.getText() === "runPreview");
    expect(found).toHaveLength(1);
    const call = found[0].initializer;
    expect(call !== undefined && ts.isCallExpression(call) && call.expression.getText() === "useCallback", "runPreview is a useCallback").toBe(true);
    return call as ts.CallExpression;
  };
  const statementPane = (asOf: string, combineFamily: boolean) => renderToStaticMarkup(
    <PreviewPane templateId="t-1" docType="STATEMENT" config={STATEMENT_DEFAULT_CONFIG} perms={["templates.view", "customers.view"]}
                 recordId="" onRecordId={() => {}} allLoads={false} onAllLoads={() => {}}
                 asOf={asOf} onAsOf={() => {}} combineFamily={combineFamily} onCombineFamily={() => {}} />,
  );
  const inputTag = (html: string, label: string) => {
    const tags = html.match(new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`, "g")) ?? [];
    expect(tags).toHaveLength(1);
    return tags[0];
  };

  it("shows the as-of date and Combine family it is handed", () => {
    const html = statementPane("2026-10-31", true);
    expect(inputTag(html, "Statement as-of date")).toContain('value="2026-10-31"');
    expect(inputTag(html, "Combine family")).toContain('checked=""');
    const cleared = statementPane("", false);
    expect(inputTag(cleared, "Statement as-of date")).toContain('value=""');
    expect(inputTag(cleared, "Combine family")).not.toContain("checked");
  });

  it("the pane holds neither as state of its own", () => {
    const pairs = statePairs(PANE);
    // Non-vacuous: the pane's own state is read (its options, preview URL, rendering, errors).
    expect(pairs.map((p) => p[0])).toContain("options");
    for (const [value] of pairs) expect(["asOf", "combineFamily"]).not.toContain(value);
    const src = read(PANE.replace(/^src\//, ""));
    expect(src).not.toContain("setAsOf");
    expect(src).not.toContain("setCombineFamily");
  });

  it("the editor holds both and hands them, with their setters, to both panes", () => {
    const pairs = statePairs(PAGE);
    expect(pairs).toContainEqual(["asOf", "setAsOf"]);
    expect(pairs).toContainEqual(["combineFamily", "setCombineFamily"]);
    const panes = jsxTags(PAGE).filter((t) => t.name === "PreviewPane");
    expect(panes).toHaveLength(2);
    for (const pane of panes) {
      expect(pane.attr("asOf")).toBe("asOf");
      expect(pane.attr("onAsOf")).toBe("setAsOf");
      expect(pane.attr("combineFamily")).toBe("combineFamily");
      expect(pane.attr("onCombineFamily")).toBe("setCombineFamily");
    }
  });

  it("the pane's boxes read the props and report through their setters", () => {
    const inputs = (label: string) => jsxTags(PANE).filter((t) => t.name === "input" && t.attr("aria-label") === label);
    const asOf = inputs("Statement as-of date");
    expect(asOf).toHaveLength(1);
    expect(asOf[0].attr("value")).toBe("asOf");
    expect(callsBareIdentifier(asOf[0].attr("onChange") ?? "", "onAsOf")).toBe(true);
    const combine = inputs("Combine family");
    expect(combine).toHaveLength(1);
    expect(combine[0].attr("checked")).toBe("combineFamily");
    expect(callsBareIdentifier(combine[0].attr("onChange") ?? "", "onCombineFamily")).toBe(true);
  });

  it("runPreview's customer branch sends both, and its dependencies hold both", () => {
    // Green at the base too (the pane's own state was already sent and depended on); reds when
    // `body.asOf = asOf` is deleted or `combineFamily` leaves the dependency array.
    const call = runPreview();
    const [fn, deps] = call.arguments;
    const branches = all(fn, ts.isIfStatement).filter((s) => s.expression.getText() === 'spec.kind === "customer"');
    expect(branches).toHaveLength(1);
    const assigned = all(branches[0].thenStatement, ts.isBinaryExpression)
      .filter((b) => b.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      .map((b) => [b.left.getText(), b.right.getText()]);
    expect(assigned).toContainEqual(["body.asOf", "asOf"]);
    expect(assigned).toContainEqual(["body.combineFamily", "combineFamily"]);
    expect(deps !== undefined && ts.isArrayLiteralExpression(deps), "runPreview has a dependency array").toBe(true);
    const names = (deps as ts.ArrayLiteralExpression).elements.map((e) => e.getText());
    expect(names).toContain("asOf");
    expect(names).toContain("combineFamily");
  });
});
