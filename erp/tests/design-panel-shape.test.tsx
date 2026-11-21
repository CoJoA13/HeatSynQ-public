// The traveler canvas designer's Design tab (PR C of #926, Task 4): the palette, the stage and the
// inspector, rendered as markup. The pointer and keyboard handlers are proven by the E2E flow
// (Task 7) and the arithmetic by the leaf (`tests/canvas-designer.test.ts`); here the markup is
// held to the leaf: each item drawn at `stageBox × scale`, the bands at the leaf's heights, the
// refusal and the warnings outlined and titled, the palette's states, the inspector's anchors.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CanvasInspector } from "@/app/admin/templates/[id]/edit/CanvasInspector";
import { CanvasPalette } from "@/app/admin/templates/[id]/edit/CanvasPalette";
import { CanvasStage } from "@/app/admin/templates/[id]/edit/CanvasStage";
import { DesignPanel } from "@/app/admin/templates/[id]/edit/DesignPanel";
import { DESIGNER_WORDS, drawsBorder, itemTitle, paletteEntries, printsNothing, ruleOf, stageBox, toInches } from "@/lib/canvas-designer";
import { CANVAS_GRID, CONTINUED_FONT_SIZE } from "@/lib/template-contracts/canvas";
import { BOL_CONTRACT } from "@/lib/template-contracts/bol";
import { CERT_CONTRACT } from "@/lib/template-contracts/cert";
import { INVOICE_CONTRACT } from "@/lib/template-contracts/invoice";
import { MOS_SHIPPER_CONTRACT } from "@/lib/template-contracts/mos-shipper";
import { QUOTE_CONTRACT } from "@/lib/template-contracts/quote";
import { STATEMENT_CONTRACT } from "@/lib/template-contracts/statement";
import {
  bandHeight, bandTop, besideOf, canvasWarnings, continuedBox, drawnBox, isListBlock, leastWidth, tableHeadingKey, tableSpec, tablesByY, topMargin,
  type CanvasMeasure, type CanvasWarning,
} from "@/lib/template-canvas";
import { fontFaceCss } from "@/lib/template-fonts";
import { designGrid } from "@/lib/preview-frame";
import {
  SHIPPER_CONTRACT, SHIPPER_DEFAULT_CONFIG, TRAVELER_CONTRACT, TRAVELER_DEFAULT_CONFIG, type TemplateConfig, type TemplateContract,
} from "@/lib/template-contracts";
import type { CanvasItem, CanvasLayout } from "@/lib/template-contracts/canvas";
import { bolField, bolTable, standardBolLayout } from "./helpers/bol-canvas-fixtures";
import { standardCertLayout } from "./helpers/cert-canvas-fixtures";
import { standardInvoiceLayout } from "./helpers/invoice-canvas-fixtures";
import { standardQuoteLayout } from "./helpers/quote-canvas-fixtures";
import { barcode, field, layoutOf, standardLayout, table } from "./helpers/canvas-fixtures";
import { standardStatementLayout } from "./helpers/statement-canvas-fixtures";
import { standardTicketLayout, ticketTable } from "./helpers/ticket-canvas-fixtures";

const SCALE = 0.5;
const decode = (s: string) => s.replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const attr = (attrs: string, name: string) => {
  const m = attrs.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decode(m[1]) : null;
};
/** Every `role="listitem"` opening tag, in document order, with the attributes the tests read. */
function listitems(html: string) {
  return [...html.matchAll(/<div([^>]*)\srole="listitem"([^>]*)>/g)].map((m) => {
    const a = `${m[1]} ${m[2]}`;
    return { label: attr(a, "aria-label"), style: attr(a, "style") ?? "", cls: attr(a, "class") ?? "", title: attr(a, "title") };
  });
}
const px = (box: { x: number; y: number; w: number; h: number }, s: number) =>
  `left:${box.x * s}px;top:${box.y * s}px;width:${box.w * s}px;height:${box.h * s}px`;
/** The element carrying `data-<name>="<value>"`, its attributes and its text up to the next tag. */
function marked(html: string, name: string, value: string) {
  const m = html.match(new RegExp(`<div([^>]*)\\sdata-${name}="${value}"([^>]*)>([^<]*)`));
  return m ? { style: attr(`${m[1]} ${m[2]}`, "style") ?? "", cls: attr(`${m[1]} ${m[2]}`, "class") ?? "", text: decode(m[3]) } : null;
}
/** One listitem's own markup: from its opening tag up to the next listitem's (or the end). */
function itemMarkup(html: string, label: string) {
  const start = html.lastIndexOf("<div", html.indexOf(`aria-label="${label}"`));
  const next = html.indexOf('role="listitem"', html.indexOf(`aria-label="${label}"`) + 1);
  return html.slice(start, next === -1 ? undefined : html.lastIndexOf("<div", next));
}

function stage(layout: CanvasLayout, over: Partial<Parameters<typeof CanvasStage>[0]> = {}) {
  return renderToStaticMarkup(
    <CanvasStage layout={layout} contract={TRAVELER_CONTRACT} scale={SCALE} measure={null} selectedId={null}
                 onSelect={() => {}} onCommit={() => {}} onRemove={() => {}} refusal={null} warnings={[]}
                 fontCss={fontFaceCss("Roboto")} family="Roboto" logoSrc={null} pageFooter={false} disabled={false}
                 textBlocks={{}} {...over} />,
  );
}
function inspector(item: CanvasItem, layout: CanvasLayout, contract: TemplateContract = TRAVELER_CONTRACT) {
  return renderToStaticMarkup(
    <CanvasInspector item={item} layout={layout} contract={contract} onChange={() => {}} onAnchor={() => {}}
                     onRemove={() => {}} onMessage={() => {}} disabled={false} editTitle={undefined} />,
  );
}
const byId = (layout: CanvasLayout, id: string) => layout.items.find((item) => item.id === id)!;

describe("the stage", () => {
  it("draws one listitem per item, named by its title, at its stage box times the scale", () => {
    const layout = standardLayout();
    const html = stage(layout);
    expect(html).toContain('role="list"');
    expect(html).toContain('aria-label="Canvas items"');
    const items = listitems(html);
    expect(items).toHaveLength(layout.items.length);
    layout.items.forEach((item, i) => {
      expect(items[i].label).toBe(itemTitle(item, TRAVELER_CONTRACT));
      expect(items[i].style).toContain(px(stageBox(item, layout, null).box, SCALE));
    });
    expect(html).toContain('tabindex="0"');
  });

  it("draws the page at 612 × 792 pt times the scale", () => {
    const html = stage(standardLayout());
    const m = html.match(/<div([^>]*)\srole="list"([^>]*)>/);
    expect(attr(`${m![1]} ${m![2]}`, "style")).toContain(`width:${612 * SCALE}px;height:${792 * SCALE}px`);
  });

  it("follows the measure: a measured item at its measured place", () => {
    const layout = standardLayout();
    const measure: CanvasMeasure = {
      pages: 1,
      tables: [{ key: "steps", page: 1, top: 400, height: 200 }],
      regions: [{ after: "steps", page: 1, top: 600, height: 80 }],
      items: [],
    };
    const items = listitems(stage(layout, { measure }));
    layout.items.forEach((item, i) => expect(items[i].style).toContain(px(stageBox(item, layout, measure).box, SCALE)));
    const steps = byId(layout, "table-steps");
    expect(stageBox(steps, layout, measure).box.y).toBe(400);
  });

  it("draws an item printing on another page dashed at its drawn box, titled with its page", () => {
    const layout = standardLayout();
    const measure: CanvasMeasure = {
      pages: 2,
      tables: [{ key: "steps", page: 2, top: 40, height: 120 }],
      regions: [{ after: "steps", page: 2, top: 160, height: 80 }],
      items: [],
    };
    const html = stage(layout, { measure });
    const items = listitems(html);
    const i = layout.items.findIndex((item) => item.id === "table-steps");
    expect(stageBox(layout.items[i], layout, measure).page).toBe(2);
    expect(items[i].style).toContain(px(drawnBox(layout.items[i], layout), SCALE));
    expect(items[i].title).toContain(DESIGNER_WORDS.printsOnPage(2, "TRAVELER"));
    expect(items[i].cls).toContain("opacity-60");
    const footer = layout.items.findIndex((item) => item.id === "field-results");
    expect(items[footer].title).toBe(DESIGNER_WORDS.printsOnPage(2, "TRAVELER"));
    const steps = itemMarkup(html, "Process steps table");
    expect(steps).toContain('role="listitem"');
    expect(steps).toContain("border-dashed");
    expect(steps).toContain(`title="${DESIGNER_WORDS.printsOnPage(2, "TRAVELER")}`);
    expect(itemMarkup(stage(layout), "Process steps table")).not.toContain("border-dashed");
  });

  it("titles the barcode and the steps table as required", () => {
    const layout = standardLayout();
    const items = listitems(stage(layout));
    expect(items[layout.items.findIndex((item) => item.kind === "barcode")].title).toBe(DESIGNER_WORDS.required);
    expect(items[layout.items.findIndex((item) => item.id === "table-steps")].title).toBe(DESIGNER_WORDS.required);
    expect(items[layout.items.findIndex((item) => item.id === "field-company_name")].title).toBeNull();
  });

  it("outlines the refusal's items in red with its sentence as their title, and a warning's in amber", () => {
    const layout = standardLayout();
    const refusal: CanvasWarning = { itemIds: ["field-company_name", "field-order_number"], sentence: `The "Company name" field & the rest.` };
    const warnings: CanvasWarning[] = [{ itemIds: ["field-po_number"], sentence: "The PO number field overlaps." }];
    const items = listitems(stage(layout, { refusal, warnings }));
    for (const id of refusal.itemIds) {
      const it = items[layout.items.findIndex((item) => item.id === id)];
      expect(it.cls).toContain("outline-red-700");
      expect(it.title).toBe(refusal.sentence);
    }
    const warned = items[layout.items.findIndex((item) => item.id === "field-po_number")];
    expect(warned.cls).toContain("outline-accent-600");
    expect(warned.cls).not.toContain("outline-red-700");
    expect(warned.title).toBe("The PO number field overlaps.");
    const plain = items[layout.items.findIndex((item) => item.id === "field-customer_name")];
    expect(plain.cls).not.toContain("outline-red-700");
    expect(plain.cls).not.toContain("outline-accent-600");
  });

  it("tints the repeat band from 0 to the top margin and the page-bottom band from its top to the page's foot", () => {
    const base = standardLayout();
    const layout = layoutOf([...base.items, field("ship_date", { id: "foot", anchor: { kind: "page-bottom" }, box: { x: 24, y: 740, w: 180, h: 12 } })]);
    expect(bandHeight(layout)).toBe(28);
    const html = stage(layout);
    expect(marked(html, "band", "repeat")!.style).toContain(`top:0;height:${topMargin(layout) * SCALE}px`);
    expect(marked(html, "band", "repeat")!.cls).toContain("bg-link-50");
    expect(marked(html, "band", "bottom")!.style).toContain(`top:${bandTop(layout) * SCALE}px;height:${bandHeight(layout) * SCALE}px`);
    expect(marked(html, "band", "bottom")!.cls).toContain("bg-accent-25");
  });

  it("draws the \"(continued)\" ghost in italics at its box when the layout repeats an item, and none when it does not", () => {
    const layout = standardLayout();
    const ghost = marked(stage(layout), "ghost", "continued");
    expect(ghost).not.toBeNull();
    expect(ghost!.style).toContain(px(continuedBox(layout)!, SCALE));
    expect(ghost!.style).toContain("font-style:italic");
    expect(ghost!.style).toContain(`font-size:${CONTINUED_FONT_SIZE * SCALE}px`);
    expect(ghost!.text).toBe(DESIGNER_WORDS.continued);
    const still = layoutOf(layout.items.map((item) => (item.kind === "barcode" ? { ...item, repeat: false } : item)));
    expect(continuedBox(still)).toBeNull();
    expect(marked(stage(still), "ghost", "continued")).toBeNull();
  });

  it("carries the family's @font-face rules and sets the family on its text", () => {
    const html = stage(standardLayout(), { fontCss: fontFaceCss("Liberation Serif"), family: "Liberation Serif" });
    expect(html).toContain(`<style>${fontFaceCss("Liberation Serif")}</style>`);
    expect(html).toContain("font-family:&quot;Liberation Serif&quot;");
  });

  it("shows a field's label, else its default label, and its name muted when the label is empty", () => {
    const layout = layoutOf([
      barcode(), table("steps"),
      field("company_name", { label: "Shop" }),
      field("order_number", { id: "blank", label: "", box: { x: 24, y: 100, w: 100, h: 12 } }),
    ]);
    const html = stage(layout);
    expect(html).toContain(">Shop<");
    expect(itemMarkup(html, "Company name")).toContain(`font-size:${8 * SCALE}px`);
    expect(itemMarkup(stage(layoutOf([barcode(), table("steps"), field("company_name", { style: { size: 14, bold: true, align: "left" } })])), "Company name"))
      .toContain(`font-size:${14 * SCALE}px`);
    const blank = html.slice(html.indexOf('aria-label="Order number"'));
    expect(blank.slice(0, blank.indexOf("</div></div>"))).toContain("text-ink-500");
  });

  it("draws a table's heading, its visible columns' labels and the rows-grow body; the logo frame and the barcode frame", () => {
    const checks = table("inspections");
    const layout = layoutOf([barcode(), table("steps"), { ...checks, heading: "My checks", columns: checks.columns.map((c, i) => (i === 0 ? { ...c, visible: false } : c)) }]);
    const html = stage(layout);
    expect(html).toContain(">My checks<");
    expect(html).toContain(">PROCESS STEPS:<");
    expect(html).toContain(DESIGNER_WORDS.rowsGrow);
    const fields = TRAVELER_CONTRACT.sections.flatMap((s) => s.fields).filter((f) => f.column?.table === "inspections");
    expect(fields[0].defaultLabel).toBe("Inspection");
    expect(html).not.toContain(`>${fields[0].defaultLabel}<`);
    expect(html).toContain(`>${fields[1].defaultLabel}<`);
    expect(html).toContain(">Barcode<");
    expect(stage(standardLayout())).toContain(">Logo<");
    expect(stage(standardLayout(), { logoSrc: "/api/templates/t1/logo?v=1" })).toContain('<img src="/api/templates/t1/logo?v=1"');
  });

  it("draws the ticket's party boxes in a border, and no other field (ticket canvas PR 2b)", () => {
    const html = stage(standardTicketLayout(), { contract: SHIPPER_CONTRACT });
    for (const label of ["Sold-to box", "Ship-to box", "Document title"]) expect(listitems(html).map((i) => i.label)).toContain(label);
    expect(itemMarkup(html, "Sold-to box")).toContain(">Sold To:<");
    expect(itemMarkup(html, "Sold-to box")).toContain("border border-ink-900");
    expect(itemMarkup(html, "Ship-to box")).toContain("border border-ink-900");
    expect(itemMarkup(html, "Document title")).toContain(">Shipping Ticket<");
    expect(itemMarkup(html, "Document title")).not.toContain("border border-ink-900");
  });

  it("draws a text block's wording wrapped in its box, and its title muted when the wording is empty", () => {
    const layout = standardTicketLayout();
    const handed = itemMarkup(stage(layout, {
      contract: SHIPPER_CONTRACT, textBlocks: { shipper_liability_text: "Our liability…" },
    }), "Liability text wording");
    expect(handed).toContain(">Our liability…<");
    expect(handed).toContain("white-space:pre-wrap");
    expect(handed).toContain(`font-size:${5.5 * SCALE}px`);
    expect(handed).not.toContain("text-ink-500");
    const empty = itemMarkup(stage(layout, { contract: SHIPPER_CONTRACT }), "Liability text wording");
    expect(empty).toContain(">Liability text wording<");
    expect(empty).toContain("text-ink-500");
  });

  it("draws a rows block's visible rows in order under no header strip, while a column table keeps its strip", () => {
    const layout = standardTicketLayout();
    const html = stage(layout, { contract: SHIPPER_CONTRACT });
    const totals = itemMarkup(html, "Totals table");
    const texts = [...totals.matchAll(/>([^<]+)</g)].map((m) => decode(m[1]));
    expect(texts).toEqual(["Shipped Complete", "Quantity Shipped:", "Net weight:", "Tare:", "Gross weight:", DESIGNER_WORDS.rowsGrow]);
    expect(totals).not.toContain("border-b");
    expect(itemMarkup(html, "Part lines table")).toContain("border-b");
    // A hidden row is not drawn, and a typed label is drawn in its place.
    const rows = ticketTable("totals");
    const edited = layoutOf(layout.items.map((i) => (i.id === rows.id
      ? { ...rows, columns: rows.columns.map((c) => (c.key === "total_tare" ? { ...c, visible: false } : c.key === "total_qty" ? { ...c, label: "Pieces:" } : c)) }
      : i)));
    const shown = [...itemMarkup(stage(edited, { contract: SHIPPER_CONTRACT }), "Totals table").matchAll(/>([^<]+)</g)].map((m) => decode(m[1]));
    expect(shown).toEqual(["Shipped Complete", "Pieces:", "Net weight:", "Gross weight:", DESIGNER_WORDS.rowsGrow]);
  });

  it("draws a Totals table with every row hidden as the hatch alone, no row label on it", () => {
    const layout = standardTicketLayout();
    const rows = ticketTable("totals");
    const hidden = layoutOf(layout.items.map((i) => (i.id === rows.id ? { ...rows, columns: rows.columns.map((c) => ({ ...c, visible: false })) } : i)));
    const totals = itemMarkup(stage(hidden, { contract: SHIPPER_CONTRACT }), "Totals table");
    const texts = [...totals.matchAll(/>([^<]+)</g)].map((m) => decode(m[1]));
    expect(texts).toEqual([DESIGNER_WORDS.rowsGrow]);
    for (const column of rows.columns) {
      const label = SHIPPER_CONTRACT.sections.flatMap((section) => section.fields).find((f) => f.key === column.key)!.defaultLabel;
      expect(totals).not.toContain(`>${label}<`);
    }
  });

  // The bill of lading (BOL canvas PR 2, Task 9): the stage draws the form's ruled fields on their
  // rules (`ruleOf`), a list block as its heading and one line over the hatch (`isListBlock`; owner
  // ruling (b), 2026-11-10: the ticket's Serial numbers list too), and the freight block's header
  // strip in its drawn width less `besideOf` beside a plain outline of the sidebar, the toggle not
  // drawn as a column.
  const RULE = "border-b border-ink-900";
  const bolStage = (layout: CanvasLayout = standardBolLayout(), over: Partial<Parameters<typeof CanvasStage>[0]> = {}) =>
    stage(layout, { contract: BOL_CONTRACT, ...over });
  const bolLabel = (key: string) => BOL_CONTRACT.sections.flatMap((s) => s.fields).find((f) => f.key === key)!.defaultLabel;
  const count = (html: string, needle: string) => html.split(needle).length - 1;
  /** One listitem's markup, decoded, found by its title as React escapes it (`'` as `&#x27;`). */
  const bolItem = (html: string, title: string) => decode(itemMarkup(html, title.replace(/'/g, "&#x27;")));

  it("draws a ruled field on its rule: beside its label, under it, or two rules in its column; any other field bare", () => {
    const layout = standardBolLayout();
    const html = bolStage(layout);
    const pro = bolItem(html, "Carrier's pro number");
    expect(ruleOf(byId(layout, "field-pro_number"), BOL_CONTRACT)?.draw).toBe("beside");
    expect(pro).toContain(`>${bolLabel("pro_number")}<`);
    expect(count(pro, RULE)).toBe(1);
    expect(pro.indexOf(`>${bolLabel("pro_number")}<`)).toBeLessThan(pro.indexOf(RULE));
    // The carrier's name: the rule across the box, the label under it at the small size.
    const carrier = bolItem(html, "Carrier name");
    expect(ruleOf(byId(layout, "field-carrier_name"), BOL_CONTRACT)?.draw).toBe("under");
    expect(count(carrier, RULE)).toBe(1);
    expect(carrier.indexOf(RULE)).toBeLessThan(carrier.indexOf(`>${bolLabel("carrier_name")}<`));
    expect(carrier).toContain(`font-size:${BOL_CONTRACT.fonts.smallSize * SCALE}px`);
    // Consigned to: its label beside two rules in the profile's column, the caption not drawn.
    const consigned = bolItem(html, "Consigned to");
    const column = ruleOf(byId(layout, "field-consigned_to"), BOL_CONTRACT)!.column!;
    expect(column).toBe(180);
    expect(consigned).toContain(`>${bolLabel("consigned_to")}<`);
    expect(count(consigned, `class="block flex-none ${RULE}" style="width:${column * SCALE}px`)).toBe(2);
    // The document title draws neither a rule nor a border.
    const title = bolItem(html, "Document title");
    expect(ruleOf(byId(layout, "field-title"), BOL_CONTRACT)).toBeNull();
    expect(title).toContain(`>${bolLabel("title")}<`);
    expect(title).not.toContain("border-b");
    // A ruled field with its label blank draws its muted name on the rule.
    const blank = layoutOf(layout.items.map((i) => (i.id === "field-pro_number" ? { ...i, label: "" } : i)));
    const muted = bolItem(bolStage(blank), "Carrier's pro number");
    expect(muted).toContain(">Carrier's pro number<");
    expect(muted).toContain("text-ink-500");
    expect(muted).toContain(RULE);
  });

  it("draws a list block as its heading, one line and the hatch, with no column strip: the TRV and PO lists, and the ticket's serials", () => {
    const html = bolStage();
    for (const [title, heading] of [["TRV numbers table", bolLabel("trv_no")], ["Consignee's ref/PO table", bolLabel("consignee_ref")]]) {
      const list = bolItem(html, title);
      expect(list).toContain(`>${heading}<`);
      expect(list).toContain(DESIGNER_WORDS.rowsGrow);
      expect(count(list, "border-b")).toBe(1);
      expect(list).toContain(RULE);
      expect(list).not.toContain("bg-surface-50");
      expect(list.indexOf(`>${heading}<`)).toBeLessThan(list.indexOf(RULE));
      expect(list.indexOf(RULE)).toBeLessThan(list.indexOf(DESIGNER_WORDS.rowsGrow));
    }
    // A typed heading is drawn in the default's place.
    const typed = layoutOf(standardBolLayout().items.map((i) => (i.id === "table-consignee_ref" ? { ...i, heading: "Your PO" } : i)));
    expect(bolItem(bolStage(typed), "Consignee's ref/PO table")).toContain(">Your PO<");
    const serials = bolItem(stage(standardTicketLayout(), { contract: SHIPPER_CONTRACT }), "Serial numbers table");
    expect(serials).toContain(">Serial Numbers:<");
    expect(count(serials, "border-b")).toBe(1);
    expect(serials).toContain(RULE);
    expect(serials).not.toContain("bg-surface-50");
  });

  it("draws the freight block's strip in its width less what it keeps beside, the toggle not a column, beside the sidebar's outline", () => {
    const layout = standardBolLayout();
    const freight = byId(layout, "table-freight");
    expect(freight).toEqual(bolTable("freight"));
    if (freight.kind !== "table") throw new Error("the freight block is a table");
    const beside = besideOf(BOL_CONTRACT, "freight");
    expect(beside).toBeGreaterThan(0);
    const toggle = freight.columns.find((c) => c.key === "collect_checkbox")!;
    expect(toggle.visible).toBe(true);
    const html = bolItem(bolStage(layout), "Freight table");
    expect(html).toContain(`style="width:${(freight.box.w - beside) * SCALE}px`);
    expect(html).toMatch(new RegExp(`data-sidebar="true" class="h-full flex-none border border-l-0 border-ink-500 bg-surface-0" style="width:${beside * SCALE}px"></div>`));
    const columns = freight.columns.filter((c) => c.key !== toggle.key);
    expect(columns).toHaveLength(5);
    for (const column of columns) expect(html).toContain(`>${bolLabel(column.key)}<`);
    expect(html).not.toContain(`>${bolLabel(toggle.key)}<`);
    expect(count(html, "border-r border-line")).toBe(5);
    // The strip follows the box as drawn: 400 pt wide, it keeps the same sidebar.
    const narrow = layoutOf(layout.items.map((i) => (i.id === freight.id ? { ...freight, box: { ...freight.box, w: 400 } } : i)));
    expect(bolItem(bolStage(narrow), "Freight table")).toContain(`style="width:${(400 - beside) * SCALE}px`);
    // Every column hidden: the strip holds no cell, the outline stays.
    const hidden = layoutOf(layout.items.map((i) => (i.id === freight.id ? { ...freight, columns: freight.columns.map((c) => ({ ...c, visible: false })) } : i)));
    const empty = bolItem(bolStage(hidden), "Freight table");
    expect(count(empty, "border-r border-line")).toBe(0);
    expect(empty).toContain('data-sidebar="true"');
    // A table keeping nothing beside draws as before: the ticket's part lines and the traveler's steps.
    const lines = itemMarkup(stage(standardTicketLayout(), { contract: SHIPPER_CONTRACT }), "Part lines table");
    expect(lines).toContain("bg-surface-50");
    expect(lines).not.toContain("data-sidebar");
    expect(itemMarkup(stage(standardLayout()), "Process steps table")).not.toContain("data-sidebar");
  });

  it("at a ruled field's least width a long label may shrink (it truncates), and the rule keeps a one-grid-step floor", () => {
    const least = leastWidth(BOL_CONTRACT, bolField("pro_number"));
    expect(least).toBeGreaterThan(0);
    const label = "A forty-character label for the pro nos.";
    expect(label).toHaveLength(40);
    const layout = layoutOf([bolField("pro_number", { label, box: { x: 338, y: 24, w: least, h: 12 } })]);
    const html = bolItem(bolStage(layout), "Carrier's pro number");
    expect(html).toMatch(new RegExp(`class="min-w-0 truncate text-ink-900"[^>]*>${label}<`));
    expect(html).toContain(`class="flex-1 ${RULE}" style="min-width:${CANVAS_GRID * SCALE}px"`);
  });

  it("draws a measured item at its measured height where taller, else its drawn height", () => {
    const layout = standardTicketLayout();
    const date = byId(layout, "field-ship_date");
    expect(date.box.h).toBe(12);
    const measured = (height: number): CanvasMeasure => ({
      pages: 1, tables: [], regions: [], items: [{ id: date.id, page: 1, left: date.box.x, top: date.box.y, height }],
    });
    const at = layout.items.indexOf(date);
    expect(listitems(stage(layout, { contract: SHIPPER_CONTRACT, measure: measured(30) }))[at].style)
      .toContain(px({ ...date.box, h: 30 }, SCALE));
    expect(listitems(stage(layout, { contract: SHIPPER_CONTRACT, measure: measured(30) }))[at].style).toContain("height:15px");
    expect(listitems(stage(layout, { contract: SHIPPER_CONTRACT, measure: measured(9) }))[at].style).toContain("height:6px");
  });

  it("draws a table measured 0 tall at its drawn box, marked, still focusable", () => {
    // #958: a table the picked record leaves empty is drawn at its stored (drawn) box, never 0 tall
    // at its measured top (red when `stageBox`'s `printsNothing` branch is removed), hatched, muted
    // and titled "Prints nothing for this record" in place of its heading, line and rows-grow hatch.
    // Red when CanvasStage.tsx draws `content(item, box)` for an empty table (the words, the
    // marking's border and the list block's own drawing), when its title entry is removed (the
    // title), when its ` z-5` is removed (the stacking), when `bg-surface-0` is added to the marking
    // (no fill), and when `data-empty` is removed.
    const layout = standardTicketLayout();
    const serials = byId(layout, "table-serials");
    const measure: CanvasMeasure = { pages: 1, tables: [{ key: "serials", page: 1, top: 250, height: 0 }], regions: [], items: [] };
    const html = stage(layout, { contract: SHIPPER_CONTRACT, measure });
    const it0 = listitems(html)[layout.items.indexOf(serials)];
    expect(it0.style).toContain(px({ x: 24, y: 244, w: 564, h: 15 }, SCALE));
    const tag = itemMarkup(html, "Serial numbers table");
    const opening = tag.slice(0, tag.indexOf(">"));
    expect(opening).toContain('tabindex="0"');
    expect(attr(opening, "data-empty")).toBe("true");
    expect(it0.title).toContain(DESIGNER_WORDS.printsNothing);
    expect(it0.title).not.toContain("Prints on page");
    expect(it0.cls.split(/\s+/)).toContain("z-5");
    expect(it0.cls.split(/\s+/)).not.toContain("opacity-60");
    const inner = tag.slice(tag.indexOf(">") + 1);
    expect(inner).toContain(`>${DESIGNER_WORDS.printsNothing}<`);
    const mark = inner.match(new RegExp(`<div([^>]*)>${DESIGNER_WORDS.printsNothing}<`))!;
    const markCls = (attr(mark[1], "class") ?? "").split(/\s+/);
    expect(markCls).toContain("border-ink-300");
    expect(markCls).not.toContain("bg-surface-0");
    expect(inner).not.toContain(DESIGNER_WORDS.rowsGrow);
    expect(inner).not.toContain("border-dashed");
    expect(inner).not.toContain("bg-surface-0");
    expect(inner).not.toContain(">Serial Numbers:<");
    expect(inner).not.toContain("border-b border-ink-900");
    // The same block with no measure draws its heading and its line, as before.
    const drawn = itemMarkup(stage(layout, { contract: SHIPPER_CONTRACT }), "Serial numbers table");
    expect(drawn).toContain(">Serial Numbers:<");
    expect(drawn).toContain("border-b border-ink-900");
    expect(attr(drawn.slice(0, drawn.indexOf(">")), "data-empty")).toBeNull();
  });

  it("puts eight resize handles on the selected item only", () => {
    const html = stage(standardLayout(), { selectedId: "field-company_name" });
    expect([...html.matchAll(/data-handle="(\w+)"/g)].map((m) => m[1]).sort()).toEqual(["e", "n", "ne", "nw", "s", "se", "sw", "w"]);
    expect(stage(standardLayout())).not.toContain("data-handle");
  });

  it("marks the selected item current and lets the page itself take focus", () => {
    const html = stage(standardLayout(), { selectedId: "field-company_name" });
    const items = listitems(html);
    expect([...html.matchAll(/aria-current="true"/g)]).toHaveLength(1);
    expect(itemMarkup(html, "Company name").slice(0, itemMarkup(html, "Company name").indexOf(">"))).toContain('aria-current="true"');
    expect(items).toHaveLength(standardLayout().items.length);
    const list = html.match(/<div([^>]*)\srole="list"([^>]*)>/)!;
    expect(attr(`${list[1]} ${list[2]}`, "tabindex")).toBe("-1");
  });
});

describe("a table the picked record leaves empty (#958)", () => {
  const WORDS = DESIGNER_WORDS.printsNothing;
  const tokens = (cls: string) => cls.split(/\s+/);
  /** An item's own markup, found by its title (`itemTitle`, its apostrophes escaped as React writes them). */
  const own = (html: string, item: CanvasItem, contract: TemplateContract) =>
    itemMarkup(html, itemTitle(item, contract).replace(/'/g, "&#x27;"));
  const opening = (tag: string) => tag.slice(0, tag.indexOf(">"));
  const inner = (tag: string) => tag.slice(tag.indexOf(">") + 1);
  /** The marking: the element whose own text is the words, with its class tokens and style. */
  const marking = (tag: string) => {
    const m = inner(tag).match(new RegExp(`<div([^>]*)>${WORDS}<`));
    return m === null ? null : { cls: tokens(attr(m[1], "class") ?? ""), style: attr(m[1], "style") ?? "" };
  };
  const zeroOf = (key: string, page = 1, top = 250): CanvasMeasure =>
    ({ pages: page, tables: [{ key, page, top, height: 0 }], regions: [], items: [] });
  const fieldsOf = (contract: TemplateContract) => contract.sections.flatMap((s) => s.fields);

  it("draws a column table's header strip nowhere: the ticket's containers", () => {
    // Red when CanvasStage.tsx draws `content(item, box)` for an empty table.
    const layout = standardTicketLayout();
    const containers = byId(layout, "table-containers");
    if (containers.kind !== "table") throw new Error("the containers block is a table");
    const fields = fieldsOf(SHIPPER_CONTRACT);
    const labels = containers.columns.filter((c) => c.visible)
      .map((c) => c.label ?? fields.find((f) => f.key === c.key)?.defaultLabel ?? "").filter((l) => l !== "");
    expect(labels.length).toBeGreaterThan(0);
    const measure = zeroOf("containers", 1, 214);
    expect(printsNothing(containers, measure)).toBe(true);
    const empty = decode(own(stage(layout, { contract: SHIPPER_CONTRACT, measure }), containers, SHIPPER_CONTRACT));
    for (const label of labels) expect(empty).not.toContain(`>${label}<`);
    expect(empty).not.toContain("border-b border-ink-500");
    expect(marking(empty)).not.toBeNull();
    // Control: with no measure the strip and its labels are drawn.
    const drawn = decode(own(stage(layout, { contract: SHIPPER_CONTRACT }), containers, SHIPPER_CONTRACT));
    expect(drawn).toContain("border-b border-ink-500");
    for (const label of labels) expect(drawn).toContain(`>${label}<`);
  });

  it("draws a rows block's rows nowhere: the invoice's parts, at its drawn box", () => {
    // Red when CanvasStage.tsx draws `content(item, box)` for an empty table.
    const layout = standardInvoiceLayout();
    const parts = byId(layout, "table-parts");
    if (parts.kind !== "table") throw new Error("the parts block is a table");
    const fields = fieldsOf(INVOICE_CONTRACT);
    const words = parts.columns.filter((c) => c.visible).map((c) => {
      const field = fields.find((f) => f.key === c.key)!;
      const label = c.label ?? field.defaultLabel;
      return label === "" ? field.name : label;
    });
    expect(words.length).toBeGreaterThan(0);
    const measure = zeroOf("parts", 1, parts.box.y);
    expect(printsNothing(parts, measure)).toBe(true);
    const html = stage(layout, { contract: INVOICE_CONTRACT, measure });
    expect(listitems(html)[layout.items.indexOf(parts)].style).toContain(px(drawnBox(parts, layout), SCALE));
    const empty = decode(own(html, parts, INVOICE_CONTRACT));
    for (const w of words) expect(empty).not.toContain(`>${w}<`);
    expect(marking(empty)).not.toBeNull();
    // Control: with no measure each row is drawn.
    const drawn = decode(own(stage(layout, { contract: INVOICE_CONTRACT }), parts, INVOICE_CONTRACT));
    for (const w of words) expect(drawn).toContain(`>${w}<`);
  });

  it("draws the empty block above a table grown over its stored box, with no fill, and no other item raised", () => {
    // The containers measured 208..270 over the serials' stored 244..259 (the shipment's rows grow
    // past the containers' stored 30 pt); the serials' region and every later point follow from it
    // (the containers' drawn gap to the serials is 6 pt: the serials measure at 276 and print 0 pt,
    // and the liability wording rides its region 4 pt under, at 280). Red when ` z-5` is removed
    // from the list item (the serials' tokens) or `bg-surface-0` is added to the marking (no fill).
    // It holds the owner's answer to questions 3 and 7, default (a): the unselected empty block is
    // drawn above every unselected item, hatched with no fill.
    const layout = standardTicketLayout();
    const measure: CanvasMeasure = {
      pages: 1,
      tables: [{ key: "containers", page: 1, top: 208, height: 62 }, { key: "serials", page: 1, top: 276, height: 0 }],
      regions: [{ after: "containers", page: 1, top: 270, height: 6 }, { after: "serials", page: 1, top: 276, height: 51 }],
      items: [],
    };
    const html = stage(layout, { contract: SHIPPER_CONTRACT, measure });
    const items = listitems(html);
    const containers = byId(layout, "table-containers");
    const serials = byId(layout, "table-serials");
    // The grown table's stage box covers the empty block's drawn box.
    expect(items[layout.items.indexOf(containers)].style).toContain(px({ x: 24, y: 208, w: 564, h: 62 }, SCALE));
    expect(items[layout.items.indexOf(serials)].style).toContain(px({ x: 24, y: 244, w: 564, h: 15 }, SCALE));
    layout.items.forEach((item, i) => {
      if (item.id === serials.id) expect(tokens(items[i].cls)).toContain("z-5");
      else expect(tokens(items[i].cls)).not.toContain("z-5");
    });
    const mark = marking(own(html, serials, SHIPPER_CONTRACT))!;
    expect(mark.cls).not.toContain("bg-surface-0");
    expect(mark.cls).toContain("border-ink-300");
  });

  it("draws the block's own below-table item pulled up inside the hatch, beneath it: the wording carries no z-5", () => {
    // The pulled-up overlap of question 7: the serials measured 0 pt at 250, inside their stored
    // 244..259, so the paper ends them there and the liability wording rides their region 4 pt under,
    // at 254, inside the hatch. The serials are raised (`z-5`, multiplied) and the wording is not, so
    // the wording shows through the hatch and the block stays grabbable. Red when ` z-5` is removed
    // from the empty branch (the serials' tokens), and when the empty branch's classes are given to
    // every unselected item (the wording's).
    const layout = standardTicketLayout();
    const measure: CanvasMeasure = {
      pages: 1,
      tables: [{ key: "serials", page: 1, top: 250, height: 0 }],
      regions: [{ after: "serials", page: 1, top: 250, height: 44 }],
      items: [],
    };
    const items = listitems(stage(layout, { contract: SHIPPER_CONTRACT, measure }));
    const serials = byId(layout, "table-serials");
    const wording = byId(layout, "text-block-shipper_liability_text");
    expect(printsNothing(serials, measure)).toBe(true);
    // The hatch at the serials' stored box, the wording pulled up into it.
    expect(items[layout.items.indexOf(serials)].style).toContain(px({ x: 24, y: 244, w: 564, h: 15 }, SCALE));
    expect(items[layout.items.indexOf(wording)].style).toContain(px({ x: 24, y: 254, w: 564, h: 40 }, SCALE));
    expect(tokens(items[layout.items.indexOf(serials)].cls)).toEqual(expect.arrayContaining(["z-5", "mix-blend-multiply"]));
    const wordingCls = tokens(items[layout.items.indexOf(wording)].cls);
    expect(wordingCls).not.toContain("z-5");
    expect(wordingCls).not.toContain("mix-blend-multiply");
  });

  it("titles an empty block's words after the refusal and the warnings, and before Required", () => {
    // Only the traveler requires a table (`steps`), and an empty table answers page 1 (`stageBox`), so
    // "Prints on page" never joins an empty block's title: its place after the words is not reachable
    // here. Red when the title's `printsNothing` entry is moved above the refusal, or below Required.
    const layout = standardLayout();
    const steps = byId(layout, "table-steps");
    const refusal: CanvasWarning = { itemIds: [steps.id], sentence: "The steps table is refused." };
    const warnings: CanvasWarning[] = [{ itemIds: [steps.id], sentence: "The steps table overlaps." }];
    const measure: CanvasMeasure = { pages: 1, tables: [{ key: "steps", page: 1, top: steps.box.y, height: 0 }], regions: [], items: [] };
    expect(printsNothing(steps, measure)).toBe(true);
    const title = listitems(stage(layout, { measure, refusal, warnings }))[layout.items.indexOf(steps)].title;
    expect(title?.split("\n")).toEqual([refusal.sentence, warnings[0].sentence, WORDS, DESIGNER_WORDS.required]);
  });

  it("keeps the selected empty block at z-10, not z-5", () => {
    // Red when the list item's ` z-5` is added whether or not the item is selected.
    const layout = standardTicketLayout();
    const html = stage(layout, { contract: SHIPPER_CONTRACT, measure: zeroOf("serials"), selectedId: "table-serials" });
    const cls = tokens(listitems(html)[layout.items.indexOf(byId(layout, "table-serials"))].cls);
    expect(cls).toContain("z-10");
    expect(cls).not.toContain("z-5");
  });

  it("multiplies the unselected empty block's hatch over the items beneath it, and nothing else", () => {
    // The hatch's opaque stripes would cut a page-1 item's borders and rules beneath it into dashes,
    // the stage's cue for a later page; multiplied, dark ink stays whole and the stripes still show on
    // white. The blend rides the list item, beside its `z-5` (the item is its own stacking context, so
    // a blend on the marking would have nothing beneath it). A selected empty block (`z-10`) and a
    // printing table take none: the handles' white fill stays opaque. Red when `mix-blend-multiply`
    // is removed from the empty branch, and when it is moved to (or added on) the selected branch.
    const layout = standardTicketLayout();
    const serials = byId(layout, "table-serials");
    const at = layout.items.indexOf(serials);
    const unselected = tokens(listitems(stage(layout, { contract: SHIPPER_CONTRACT, measure: zeroOf("serials") }))[at].cls);
    expect(unselected).toEqual(expect.arrayContaining(["z-5", "mix-blend-multiply"]));
    const selected = tokens(listitems(stage(layout, { contract: SHIPPER_CONTRACT, measure: zeroOf("serials"), selectedId: serials.id }))[at].cls);
    expect(selected).toContain("z-10");
    expect(selected).not.toContain("mix-blend-multiply");
    // A printing table, measured 30 pt tall, selected or not, and every other item: no blend.
    const printing: CanvasMeasure = { pages: 1, tables: [{ key: "serials", page: 1, top: 250, height: 30 }], regions: [], items: [] };
    for (const selectedId of [undefined, serials.id]) {
      for (const item of listitems(stage(layout, { contract: SHIPPER_CONTRACT, measure: printing, selectedId }))) {
        expect(tokens(item.cls)).not.toContain("mix-blend-multiply");
      }
    }
    listitems(stage(layout, { contract: SHIPPER_CONTRACT, measure: zeroOf("serials") })).forEach((item, i) => {
      if (i !== at) expect(tokens(item.cls)).not.toContain("mix-blend-multiply");
    });
  });

  it("draws an empty block measured on page 2 on page 1 at its drawn box, solid, not titled with a page", () => {
    // Red when `stageBox` answers `m.page` for an empty table (the dashed later-page treatment and
    // its title return), or when the title entry is removed.
    const layout = standardTicketLayout();
    const html = stage(layout, { contract: SHIPPER_CONTRACT, measure: zeroOf("serials", 2, 40) });
    const serials = byId(layout, "table-serials");
    const it0 = listitems(html)[layout.items.indexOf(serials)];
    expect(it0.style).toContain(px({ x: 24, y: 244, w: 564, h: 15 }, SCALE));
    expect(tokens(it0.cls)).not.toContain("opacity-60");
    expect(it0.title).toContain(WORDS);
    expect(it0.title).not.toContain("Prints on page");
    expect(inner(own(html, serials, SHIPPER_CONTRACT))).not.toContain("border-dashed");
  });

  it("hatches the marking with the tables' gradient", () => {
    // Red when the marking's `backgroundImage` is removed.
    const layout = standardTicketLayout();
    const mark = marking(own(stage(layout, { contract: SHIPPER_CONTRACT, measure: zeroOf("serials") }), byId(layout, "table-serials"), SHIPPER_CONTRACT))!;
    expect(mark.style).toContain("background-image:repeating-linear-gradient(45deg, var(--color-line) 0 1px, transparent 1px 6px)");
    expect(mark.cls).toEqual(expect.arrayContaining(["text-ink-500", "italic"]));
  });

  // One empty block per document (the plan's §1): each drawn at its drawn box, never 0 tall, marked.
  // Red when CanvasStage.tsx draws `content(item, box)` for an empty table (the words, the border),
  // when the title entry is removed, when `data-empty` is removed, and when `stageBox`'s
  // `printsNothing` branch is removed (the box).
  const DOCUMENTS: [string, TemplateContract, () => CanvasLayout, string][] = [
    ["traveler lines (config)", TRAVELER_CONTRACT, standardLayout, "lines"],
    ["traveler inspections (config)", TRAVELER_CONTRACT, standardLayout, "inspections"],
    ["shipping ticket serials (record)", SHIPPER_CONTRACT, standardTicketLayout, "serials"],
    ["MOS ticket serials (record)", MOS_SHIPPER_CONTRACT, standardTicketLayout, "serials"],
    ["bill of lading TRV (config)", BOL_CONTRACT, standardBolLayout, "trv"],
    ["certification requirements (record)", CERT_CONTRACT, standardCertLayout, "requirements"],
    ["certification serials (record)", CERT_CONTRACT, standardCertLayout, "serials"],
    ["certification freeform (record)", CERT_CONTRACT, standardCertLayout, "freeform"],
    ["certification signature (config)", CERT_CONTRACT, standardCertLayout, "signature"],
    ["invoice parts (record)", INVOICE_CONTRACT, standardInvoiceLayout, "parts"],
    ["invoice price (config + record)", INVOICE_CONTRACT, standardInvoiceLayout, "price"],
    ["statement finance charge (record)", STATEMENT_CONTRACT, standardStatementLayout, "finance_charge"],
  ];
  it.each(DOCUMENTS)("marks the %s block measured 0 pt", (_name, contract, standard, key) => {
    const layout = standard();
    const item = byId(layout, `table-${key}`);
    const measure = zeroOf(key, 1, item.box.y + 6);
    expect(printsNothing(item, measure)).toBe(true);
    const html = stage(layout, { contract, measure });
    const it0 = listitems(html)[layout.items.indexOf(item)];
    expect(it0.style).toContain(px(drawnBox(item, layout), SCALE));
    expect(it0.style).not.toContain("height:0");
    expect(it0.title).toContain(WORDS);
    const tag = own(html, item, contract);
    expect(attr(opening(tag), "data-empty")).toBe("true");
    expect(inner(tag)).toContain(`>${WORDS}<`);
    expect(marking(tag)!.cls).toContain("border-ink-300");
  });

  it("marks nothing with no measure, nor a table measured 30 pt tall", () => {
    // Red when `printsNothing` judges a table the measure does not hold empty (`entry === undefined ||
    // round2(entry.height) === 0`): with no measure every table is marked.
    for (const [, contract, standard] of DOCUMENTS) {
      const html = stage(standard(), { contract });
      expect(html).not.toContain("data-empty");
      expect(html).not.toContain(WORDS);
    }
    const layout = standardTicketLayout();
    const measure: CanvasMeasure = { pages: 1, tables: [{ key: "serials", page: 1, top: 250, height: 30 }], regions: [], items: [] };
    const html = stage(layout, { contract: SHIPPER_CONTRACT, measure });
    expect(html).not.toContain("data-empty");
    expect(html).not.toContain(WORDS);
    for (const item of listitems(html)) expect(tokens(item.cls)).not.toContain("z-5");
  });
});

describe("the palette", () => {
  it("heads each group and marks placed and required entries", () => {
    const entries = paletteEntries(standardLayout(), TRAVELER_CONTRACT);
    const html = renderToStaticMarkup(<CanvasPalette entries={entries} onAdd={() => {}} disabled={false} editTitle={undefined} />);
    const groups = [...new Set(entries.map((e) => e.group))];
    expect(groups.length).toBeGreaterThan(2);
    expect([...decode(html).matchAll(/<h3[^>]*>([^<]*)<\/h3>/g)].map((m) => m[1])).toEqual(groups);
    const buttons = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ attrs: m[1], text: m[2].replace(/<[^>]+>/g, " ") }));
    expect(buttons).toHaveLength(entries.length);
    entries.forEach((entry, i) => {
      expect(buttons[i].text).toContain(entry.label);
      if (entry.state === "placed") expect(buttons[i].text).toContain(DESIGNER_WORDS.placed);
      if (entry.state === "required") expect(buttons[i].text).toContain(DESIGNER_WORDS.required);
      if (entry.state === "available") {
        expect(buttons[i].text).not.toContain(DESIGNER_WORDS.placed);
        expect(buttons[i].text).not.toContain(DESIGNER_WORDS.required);
      }
    });
    expect(entries.some((e) => e.state === "placed")).toBe(true);
    expect(entries.some((e) => e.state === "required")).toBe(true);
    const button = (pred: (e: (typeof entries)[number]) => boolean) => buttons[entries.findIndex(pred)];
    const placedTable = button((e) => e.kind === "table" && e.state === "placed");
    expect(placedTable.attrs).toContain('disabled=""');
    expect(placedTable.text).toContain(DESIGNER_WORDS.placed);
    const required = button((e) => e.kind === "barcode");
    expect(required.attrs).toContain('disabled=""');
    expect(required.text).toContain(DESIGNER_WORDS.required);
    expect(button((e) => e.kind === "field" && e.state === "placed").attrs).not.toContain("disabled");
    expect(html).toMatch(/^<div role="group" aria-label="Palette"/);
  });
});

describe("the inspector", () => {
  const options = (html: string) => {
    const select = html.match(/<select[^>]*aria-label="Anchor"[^>]*>([\s\S]*?)<\/select>/);
    return select ? [...select[1].matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => decode(m[1])) : null;
  };

  it("offers a field Page top, Below each table above it, and Page bottom", () => {
    const layout = standardLayout();
    const process = byId(layout, "field-process");
    const above = tablesByY(layout).filter((t) => t.key === "lines" || t.key === "quantities");
    expect(options(inspector(process, layout))).toEqual([
      DESIGNER_WORDS.anchorPageTop, ...above.map((t) => DESIGNER_WORDS.anchorBelow(itemTitle(t, TRAVELER_CONTRACT))), DESIGNER_WORDS.anchorPageBottom,
    ]);
    const header = byId(layout, "field-company_name");
    expect(options(inspector(header, layout))).toEqual([DESIGNER_WORDS.anchorPageTop, DESIGNER_WORDS.anchorPageBottom]);
  });

  it("shows a field's boxes in inches, its label, and the repeat box", () => {
    const layout = standardLayout();
    const html = inspector(byId(layout, "field-company_name"), layout);
    for (const label of ["X (in)", "Y (in)", "Width (in)", "Height (in)", "Label"]) expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain(`aria-label="${DESIGNER_WORDS.repeat}"`);
  });

  it("shows each inch box's stored figure when it holds no typed text (ruling C15)", () => {
    const layout = standardLayout();
    const item = byId(layout, "field-process");
    const html = inspector(item, layout);
    const value = (label: string) => attr(html.match(new RegExp(`<input[^>]*aria-label="${label.replace(/[()]/g, "\\$&")}"[^>]*>`))![0], "value");
    expect(value("X (in)")).toBe(toInches(item.box.x));
    expect(value("Y (in)")).toBe(toInches(item.box.y));
    expect(value("Width (in)")).toBe(toInches(item.box.w));
    expect(value("Height (in)")).toBe(toInches(item.box.h));
  });

  it("closes a line's zero side with the one-axis sentence, and leaves its drawn side open (ruling C31)", () => {
    const box = (html: string, label: string) => html.match(new RegExp(`<input[^>]*aria-label="${label.replace(/[()]/g, "\\$&")}"[^>]*>`))![0];
    const lineItem = (id: string, b: { x: number; y: number; w: number; h: number }): CanvasItem =>
      ({ id, kind: "line", weight: 1, box: b, anchor: { kind: "page-top" }, repeat: false });
    const horizontal = lineItem("rule", { x: 24, y: 700, w: 200, h: 0 });
    const vertical = lineItem("post", { x: 300, y: 600, w: 0, h: 100 });
    const layout = layoutOf([...standardLayout().items, horizontal, vertical]);
    const across = inspector(horizontal, layout);
    expect(box(across, "Height (in)")).toMatch(/\sdisabled=""/);
    expect(attr(box(across, "Height (in)"), "title")).toBe(DESIGNER_WORDS.lineOneAxis);
    expect(box(across, "Width (in)")).not.toMatch(/\sdisabled=""/);
    const down = inspector(vertical, layout);
    expect(box(down, "Width (in)")).toMatch(/\sdisabled=""/);
    expect(attr(box(down, "Width (in)"), "title")).toBe(DESIGNER_WORDS.lineOneAxis);
    expect(box(down, "Height (in)")).not.toMatch(/\sdisabled=""/);
    // Any other item's four boxes are open.
    const header = inspector(byId(layout, "field-company_name"), layout);
    for (const label of ["X (in)", "Y (in)", "Width (in)", "Height (in)"]) expect(box(header, label)).not.toMatch(/\sdisabled=""/);
  });

  it("closes Remove with its reason on a required item, and leaves it open on any other", () => {
    const layout = standardLayout();
    const removeButton = (html: string) => {
      const m = html.match(/<button([^>]*)>([^<]*)<\/button>/g)!.find((b) => b.includes(DESIGNER_WORDS.remove))!;
      return m.slice(0, m.indexOf(">"));
    };
    for (const id of ["barcode", "table-steps"]) {
      const tag = removeButton(inspector(byId(layout, id), layout));
      expect(tag).toContain('disabled=""');
      expect(attr(tag, "title")).toBe(DESIGNER_WORDS.cannotRemove(TRAVELER_CONTRACT));
    }
    const open = removeButton(inspector(byId(layout, "field-company_name"), layout));
    expect(open).not.toContain("disabled");
    expect(attr(open, "title")).toBeNull();
  });

  it("closes Repeat below a table with the reason, and says what Y measures there (ruling C14)", () => {
    const repeatBox = (html: string) => html.match(new RegExp(`<input([^>]*)aria-label="${DESIGNER_WORDS.repeat}"([^>]*)>`));
    const layout = standardLayout();
    const below = inspector(byId(layout, "field-process"), layout);
    const closed = repeatBox(below)!;
    expect(`${closed[1]}${closed[2]}`).toContain('disabled=""');
    expect(attr(`${closed[1]} ${closed[2]}`, "title")).toBe(DESIGNER_WORDS.repeatBelowTable);
    expect(`${closed[1]}${closed[2]}`).not.toContain('checked=""');
    expect(below).toContain(DESIGNER_WORDS.yBelowTable);
    const top = inspector(byId(layout, "field-company_name"), layout);
    const open = repeatBox(top)!;
    expect(`${open[1]}${open[2]}`).not.toContain("disabled");
    expect(attr(`${open[1]} ${open[2]}`, "title")).toBeNull();
    expect(top).not.toContain(DESIGNER_WORDS.yBelowTable);
  });

  it("gives a rows block's rows a Show box and a Label box and no Width box, and a column table a Width box per column", () => {
    const layout = standardTicketLayout();
    const totals = byId(layout, "table-totals");
    expect(itemTitle(totals, SHIPPER_CONTRACT)).toBe("Totals table");
    const rows = inspector(totals, layout, SHIPPER_CONTRACT);
    expect(rows).toContain(`aria-label="${DESIGNER_WORDS.columnShown("Quantity shipped")}"`);
    expect(rows).toContain(`aria-label="${DESIGNER_WORDS.columnLabel("Quantity shipped")}"`);
    expect(rows).toContain(`>${DESIGNER_WORDS.columns}<`);
    expect(rows).not.toContain("aria-label=\"Width for");
    const lines = ticketTable("lines");
    expect(byId(layout, "table-lines")).toEqual(lines);
    const columns = inspector(lines, layout, SHIPPER_CONTRACT);
    expect(lines.columns.length).toBeGreaterThan(1);
    for (const column of lines.columns) {
      const name = SHIPPER_CONTRACT.sections.flatMap((s) => s.fields).find((f) => f.key === column.key)!.name;
      expect(columns).toContain(`aria-label="${DESIGNER_WORDS.columnWidth(name)}"`);
    }
  });

  it("lists a Totals table's five rows with every row hidden, each with an unticked Show box, a Label box and no Width box", () => {
    const layout = standardTicketLayout();
    const rows = ticketTable("totals");
    const hidden = { ...rows, columns: rows.columns.map((c) => ({ ...c, visible: false })) };
    const html = inspector(hidden, layoutOf(layout.items.map((i) => (i.id === rows.id ? hidden : i))), SHIPPER_CONTRACT);
    const fields = SHIPPER_CONTRACT.sections.flatMap((section) => section.fields);
    expect(rows.columns.map((c) => c.key)).toEqual(["shipped_complete", "total_qty", "total_weight", "total_tare", "total_gross"]);
    const shows = [...html.matchAll(/<input([^>]*)type="checkbox"([^>]*)>/g)]
      .map((m) => `${m[1]} ${m[2]}`).filter((a) => (attr(a, "aria-label") ?? "").startsWith("Show"));
    expect(shows.map((a) => attr(a, "aria-label"))).toEqual(rows.columns.map((c) => DESIGNER_WORDS.columnShown(fields.find((f) => f.key === c.key)!.name)));
    for (const a of shows) expect(a).not.toMatch(/\schecked(=|\s|$)/);
    for (const column of rows.columns) {
      expect(html).toContain(`aria-label="${DESIGNER_WORDS.columnLabel(fields.find((f) => f.key === column.key)!.name)}"`);
    }
    expect(html).not.toContain("aria-label=\"Width for");
  });

  it("gives the freight block's toggle a Show box and a Label box and no Width box, and each of its five columns a Width box", () => {
    const layout = standardBolLayout();
    const freight = bolTable("freight");
    expect(byId(layout, "table-freight")).toEqual(freight);
    const html = inspector(freight, layout, BOL_CONTRACT);
    const fields = BOL_CONTRACT.sections.flatMap((section) => section.fields);
    const name = (key: string) => fields.find((f) => f.key === key)!.name;
    const toggles = tableSpec(BOL_CONTRACT, "freight")!.toggles!;
    expect(toggles).toEqual(["collect_checkbox"]);
    expect(name("collect_checkbox")).toBe("Collect checkbox");
    expect(html).toContain(`aria-label="${DESIGNER_WORDS.columnShown("Collect checkbox")}"`);
    expect(html).toContain(`aria-label="${DESIGNER_WORDS.columnLabel("Collect checkbox")}"`);
    expect(html).not.toContain(`aria-label="${DESIGNER_WORDS.columnWidth("Collect checkbox")}"`);
    const columns = freight.columns.filter((c) => !toggles.includes(c.key));
    expect(columns.map((c) => c.key)).toEqual(["package_count", "freight_description", "freight_weight", "freight_class", "check_column"]);
    for (const column of columns) {
      expect(html).toContain(`aria-label="${DESIGNER_WORDS.columnShown(name(column.key))}"`);
      expect(html).toContain(`aria-label="${DESIGNER_WORDS.columnLabel(name(column.key))}"`);
      expect(html).toContain(`aria-label="${DESIGNER_WORDS.columnWidth(name(column.key))}"`);
    }
    expect([...html.matchAll(/aria-label="Width for /g)]).toHaveLength(5);
    expect(html).toContain(`>${DESIGNER_WORDS.columns}<`);
  });

  it("lists the freight block with every column hidden: six unticked Show boxes, six Label boxes, and Width for the five columns alone", () => {
    const layout = standardBolLayout();
    const freight = bolTable("freight");
    const hidden = { ...freight, columns: freight.columns.map((c) => ({ ...c, visible: false })) };
    const html = inspector(hidden, layoutOf(layout.items.map((i) => (i.id === freight.id ? hidden : i))), BOL_CONTRACT);
    const fields = BOL_CONTRACT.sections.flatMap((section) => section.fields);
    const name = (key: string) => fields.find((f) => f.key === key)!.name;
    expect(freight.columns.map((c) => c.key)).toEqual([
      "package_count", "freight_description", "freight_weight", "freight_class", "check_column", "collect_checkbox",
    ]);
    const shows = [...html.matchAll(/<input([^>]*)type="checkbox"([^>]*)>/g)]
      .map((m) => `${m[1]} ${m[2]}`).filter((a) => (attr(a, "aria-label") ?? "").startsWith("Show"));
    expect(shows.map((a) => attr(a, "aria-label"))).toEqual(freight.columns.map((c) => DESIGNER_WORDS.columnShown(name(c.key))));
    for (const a of shows) expect(a).not.toMatch(/\schecked(=|\s|$)/);
    for (const column of freight.columns) expect(html).toContain(`aria-label="${DESIGNER_WORDS.columnLabel(name(column.key))}"`);
    expect([...html.matchAll(/aria-label="Label for /g)]).toHaveLength(6);
    expect([...html.matchAll(/aria-label="Width for /g)]).toHaveLength(5);
    expect(html).not.toContain(`aria-label="${DESIGNER_WORDS.columnWidth(name("collect_checkbox"))}"`);
    expect(html).toContain(`>${DESIGNER_WORDS.columns}<`);
  });

  it("shows a list block no Columns label, and its Heading box with the heading field's default label as placeholder", () => {
    const layout = standardBolLayout();
    const headingBox = (html: string) => html.match(/<input[^>]*aria-label="Heading"[^>]*>/)![0];
    // The placeholder is the profile's heading field's default label, read from the contract (and pinned below).
    const headingLabel = (contract: TemplateContract, key: string) => {
      const heading = tableHeadingKey(contract, key)!;
      return contract.sections.flatMap((section) => section.fields).find((f) => f.key === heading)!.defaultLabel;
    };
    for (const key of ["trv", "consignee_ref"]) {
      const block = byId(layout, `table-${key}`);
      expect(block.kind === "table" && block.columns).toEqual([]);
      const html = inspector(block, layout, BOL_CONTRACT);
      expect(html).not.toContain(`>${DESIGNER_WORDS.columns}<`);
      expect(attr(headingBox(html), "placeholder")).toBe(headingLabel(BOL_CONTRACT, key));
    }
    expect(headingLabel(BOL_CONTRACT, "trv")).toBe("TRV NO.");
    expect(headingLabel(BOL_CONTRACT, "consignee_ref")).toBe("Consignee's Ref/PO No.");
    // The tickets' Serial numbers table is a list block too (its stored columns are []): no Columns
    // label on either ticket, its Heading box as before (recorded in Task 10's fix round 1).
    const ticketLayout = standardTicketLayout();
    const serials = byId(ticketLayout, "table-serials");
    expect(serials.kind === "table" && serials.columns).toEqual([]);
    for (const contract of [SHIPPER_CONTRACT, MOS_SHIPPER_CONTRACT]) {
      const html = inspector(serials, ticketLayout, contract);
      expect(html).not.toContain(`>${DESIGNER_WORDS.columns}<`);
      expect(attr(headingBox(html), "placeholder")).toBe("Serial Numbers:");
    }
    // A typed heading shows in the box; the block's title stays its name.
    const typed = { ...bolTable("consignee_ref"), heading: "Your PO" };
    const html = inspector(typed, layoutOf(layout.items.map((i) => (i.id === typed.id ? typed : i))), BOL_CONTRACT);
    expect(attr(headingBox(html), "value")).toBe("Your PO");
    expect(decode(html)).toContain(`>${itemTitle(typed, BOL_CONTRACT)}<`);
    expect(itemTitle(typed, BOL_CONTRACT)).toBe("Consignee's ref/PO table");
    // The ticket's Totals table keeps its Columns label (a rows block is no list block).
    const ticket = standardTicketLayout();
    expect(inspector(byId(ticket, "table-totals"), ticket, SHIPPER_CONTRACT)).toContain(`>${DESIGNER_WORDS.columns}<`);
  });

  it("gives a table no anchor select and no repeat box, and says it stacks with the tables", () => {
    const layout = standardLayout();
    const html = inspector(byId(layout, "table-steps"), layout);
    expect(options(html)).toBeNull();
    expect(html).toContain(DESIGNER_WORDS.stacksWithTables);
    expect(html).not.toContain(`aria-label="${DESIGNER_WORDS.repeat}"`);
    expect(html).toContain('aria-label="Heading"');
  });
});

// The certification (cert canvas PR 2, Task 8; design 2026-11-10 §4.6): a rows block's row whose
// label resolves to "" draws the row's contract name muted, as a label-free field's name draws, and
// a list block with no heading key (the statement and the freeform text) draws its block name muted
// where the heading row would be. Every name is read from the contract and the leaf, never retyped;
// each drawn word is matched as an ELEMENT's own text, since the hatch is muted too and the
// listitem's aria-label already carries the block's title.
describe("the certification's blocks on the stage", () => {
  const RULE = "border-b border-ink-900";
  const certStage = (layout: CanvasLayout = standardCertLayout()) => stage(layout, { contract: CERT_CONTRACT });
  const certFields = CERT_CONTRACT.sections.flatMap((s) => s.fields);
  const nameOf = (key: string) => certFields.find((f) => f.key === key)!.name;
  const labelOf = (key: string) => certFields.find((f) => f.key === key)!.defaultLabel;
  const rowKeys = (section: string) => CERT_CONTRACT.sections.find((s) => s.key === section)!.fields.map((f) => f.key);
  /** The block's markup, found by its title (`itemTitle`). */
  const block = (html: string, id: string, layout: CanvasLayout = standardCertLayout()) =>
    decode(itemMarkup(html, itemTitle(byId(layout, id), CERT_CONTRACT).replace(/'/g, "&#x27;")));
  /** Every element's own text in a block's markup, in order, each with its class. */
  const texts = (markup: string) =>
    [...markup.matchAll(/<(?:div|span)([^>]*)>([^<]+)</g)].map((m) => ({ text: m[2], cls: attr(m[1], "class") ?? "" }));
  const muted = (cls: string) => cls.includes("text-ink-500") && cls.includes("italic");
  const count = (html: string, needle: string) => html.split(needle).length - 1;

  it("draws a rows block's label-free rows by their contract names, muted: the requirements and the signature", () => {
    const html = certStage();
    for (const [id, section] of [["table-requirements", "requirements"], ["table-signature", "signature"]] as const) {
      const drawn = texts(block(html, id));
      const names = rowKeys(section).map(nameOf);
      for (const key of rowKeys(section)) expect(labelOf(key)).toBe("");
      expect(drawn.map((t) => t.text)).toEqual([...names, DESIGNER_WORDS.rowsGrow]);
      for (const t of drawn.slice(0, names.length)) expect(muted(t.cls)).toBe(true);
      expect(block(html, id)).not.toContain("bg-surface-50");
    }
    expect(rowKeys("requirements").map(nameOf)).toEqual(["Multi-part line heading", "Specification line", "Readings grid"]);
  });

  it("draws a typed row label in the name's place, not muted", () => {
    const layout = standardCertLayout();
    const typed = layoutOf(layout.items.map((i) => (i.id === "table-requirements" && i.kind === "table"
      ? { ...i, columns: i.columns.map((c) => (c.key === "spec_line" ? { ...c, label: "Spec" } : c)) }
      : i)));
    const drawn = texts(block(certStage(typed), "table-requirements", typed));
    expect(drawn.map((t) => t.text)).toEqual([nameOf("part_heading"), "Spec", nameOf("readings"), DESIGNER_WORDS.rowsGrow]);
    const spec = drawn.find((t) => t.text === "Spec")!;
    expect(spec.cls).not.toContain("italic");
    expect(spec.cls).toContain("text-ink-800");
    expect(muted(drawn[0].cls)).toBe(true);
  });

  it("draws a list block with no heading key as its block name, muted, one line and the hatch: the statement and the freeform text", () => {
    const layout = standardCertLayout();
    const html = certStage(layout);
    const shown: string[] = [];
    for (const id of ["table-statement", "table-freeform"]) {
      const markup = block(html, id);
      const drawn = texts(markup);
      const title = itemTitle(byId(layout, id), CERT_CONTRACT);
      expect(drawn.map((t) => t.text)).toEqual([title, DESIGNER_WORDS.rowsGrow]);
      expect(muted(drawn[0].cls)).toBe(true);
      expect(count(markup, RULE)).toBe(1);
      expect(markup.indexOf(`>${title}<`)).toBeLessThan(markup.indexOf(RULE));
      expect(markup.indexOf(RULE)).toBeLessThan(markup.indexOf(DESIGNER_WORDS.rowsGrow));
      expect(markup).not.toContain("bg-surface-50");
      shown.push(drawn[0].text);
    }
    expect(shown[0]).not.toBe(shown[1]);
  });

  it("draws the To block and the serials under their contract headings, not muted, and the part lines' header strip", () => {
    const html = certStage();
    for (const [id, heading] of [["table-to", labelOf("to")], ["table-serials", labelOf("serials")]] as const) {
      const markup = block(html, id);
      const drawn = texts(markup);
      expect(drawn.map((t) => t.text)).toEqual([heading, DESIGNER_WORDS.rowsGrow]);
      expect(muted(drawn[0].cls)).toBe(false);
      expect(drawn[0].cls).toContain("font-bold");
      expect(count(markup, RULE)).toBe(1);
    }
    expect([labelOf("to"), labelOf("serials")]).toEqual(["To:", "Serial Numbers"]);
    const parts = block(html, "table-parts");
    expect(parts).toContain("bg-surface-50");
    expect(texts(parts).map((t) => t.text)).toEqual([...["part_qty", "part_identity", "part_pounds"].map(labelOf), DESIGNER_WORDS.rowsGrow]);
  });

  // The inspector (pins: CanvasInspector.tsx shows the Heading box only where `tableHeadingKey`
  // answers a key, and a rows block's rows a Show and a Label box with no Width box).
  const certInspector = (id: string) => {
    const layout = standardCertLayout();
    return inspector(byId(layout, id), layout, CERT_CONTRACT);
  };
  const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)</g)].map((m) => m[1]);

  it("pin: the inspector shows the statement and the freeform text no Heading box and no Columns label", () => {
    for (const id of ["table-statement", "table-freeform"]) {
      const html = certInspector(id);
      expect(html).not.toContain('aria-label="Heading"');
      expect(html).not.toContain(`>${DESIGNER_WORDS.columns}<`);
    }
  });

  it("pin: the inspector gives the requirements and the signature each row's Show and Label box, no Width box and no reorder control", () => {
    for (const section of ["requirements", "signature"]) {
      const html = certInspector(`table-${section}`);
      expect(html).toContain(`>${DESIGNER_WORDS.columns}<`);
      for (const key of rowKeys(section)) {
        expect(html).toContain(`aria-label="${DESIGNER_WORDS.columnShown(nameOf(key))}"`);
        expect(html).toContain(`aria-label="${DESIGNER_WORDS.columnLabel(nameOf(key))}"`);
        expect(html).not.toContain(`aria-label="${DESIGNER_WORDS.columnWidth(nameOf(key))}"`);
      }
      // And no Width box under any name: the label's words before the name, read from the leaf.
      const widthPrefix = DESIGNER_WORDS.columnWidth("\u0000").split("\u0000")[0];
      expect(widthPrefix.length).toBeGreaterThan(0);
      expect(html).not.toContain(`aria-label="${widthPrefix}`);
      // Its one button is Remove: no control moves a row.
      expect(buttons(html)).toEqual([DESIGNER_WORDS.remove]);
    }
  });

  it("pin: the inspector's Heading box on the To block has the contract's heading as its placeholder", () => {
    const html = certInspector("table-to");
    const headingBox = html.match(/<input[^>]*aria-label="Heading"[^>]*>/)![0];
    expect(attr(headingBox, "placeholder")).toBe(labelOf("to"));
    expect(html).not.toContain(`>${DESIGNER_WORDS.columns}<`);
  });
});

// The invoice (invoice canvas PR 3, Task 7; design 2026-11-10 §4.6, "nothing new"): the stage and the
// inspector draw an invoice's six blocks with the shapes the earlier lanes built, read through the
// leaf from `INVOICE_CANVAS`, and no production change comes with these cases (plan open question
// 11). The column headers are a column table and draw their header strip; the other five are rows
// blocks and draw their rows, a row whose label resolves to "" by its contract name, muted (the
// certification's fallback). Every name and label is read from the contract, never retyped. Each case
// is green on arrival and names, in a comment, the mutation Task 7 ran that reds it.
describe("the invoice's blocks on the stage", () => {
  const STRIP = "bg-surface-50";
  const RULE = "border-b border-ink-900";
  const BORDER = "h-full border border-ink-900";
  const ROWS_BLOCKS = ["parties", "order_strip", "parts", "price", "totals"] as const;
  const ALL_BLOCKS = ["parties", "column_header", ...ROWS_BLOCKS.slice(1)] as const;
  const invStage = (layout: CanvasLayout = standardInvoiceLayout(), over: Partial<Parameters<typeof CanvasStage>[0]> = {}) =>
    stage(layout, { contract: INVOICE_CONTRACT, ...over });
  const invFields = INVOICE_CONTRACT.sections.flatMap((s) => s.fields);
  const fieldOf = (key: string) => invFields.find((f) => f.key === key)!;
  const rowKeys = (section: string) => INVOICE_CONTRACT.sections.find((s) => s.key === section)!.fields.map((f) => f.key);
  /** What a rows block draws for a row (`column.label ?? field.defaultLabel`, CanvasStage.tsx): its
   *  typed label, else its default label, or its contract name where that resolves to "". */
  const wordsOf = (key: string, label: string | null | undefined) => {
    const words = label ?? fieldOf(key).defaultLabel;
    return words === "" ? fieldOf(key).name : words;
  };
  /** What a rows block draws for a row no label is typed on. */
  const drawnWords = (key: string) => wordsOf(key, null);
  /** An item's markup, found by its title (`itemTitle`). */
  const block = (html: string, id: string, layout: CanvasLayout = standardInvoiceLayout()) =>
    decode(itemMarkup(html, itemTitle(byId(layout, id), INVOICE_CONTRACT).replace(/'/g, "&#x27;")));
  /** Every element's own text in an item's markup, in order, each with its class and style. */
  const texts = (markup: string) => [...markup.matchAll(/<(?:div|span)([^>]*)>([^<]+)</g)]
    .map((m) => ({ text: m[2], cls: attr(m[1], "class") ?? "", style: attr(m[1], "style") ?? "" }));
  const muted = (cls: string) => cls.includes("text-ink-500") && cls.includes("italic");
  const withItem = (layout: CanvasLayout, next: CanvasItem) => layoutOf(layout.items.map((i) => (i.id === next.id ? next : i)));

  it("draws the column headers as their header strip, each fixed column at its default width and the information column flexible", () => {
    // Red when INVOICE_CANVAS's column headers entry is made a rows block (`rows: true`): the four
    // labels then draw as rows with no strip.
    const markup = block(invStage(), "table-column_header");
    const columns = byId(standardInvoiceLayout(), "table-column_header");
    const keys = columns.kind === "table" ? columns.columns.map((c) => c.key) : [];
    expect(keys).toEqual(INVOICE_CONTRACT.sections.find((s) => s.key === "column_header")!.fields.map((f) => f.key));
    expect(keys).toHaveLength(4);
    expect(markup).toContain(STRIP);
    const drawn = texts(markup);
    expect(drawn.map((t) => t.text)).toEqual([...keys.map((k) => fieldOf(k).defaultLabel), DESIGNER_WORDS.rowsGrow]);
    keys.forEach((key, i) => {
      const width = fieldOf(key).column!.defaultWidth;
      expect(drawn[i].style).toBe(width === "*" ? "flex:1" : `width:${width * SCALE}px;flex:none`);
      expect(muted(drawn[i].cls)).toBe(false);
    });
    expect(keys.filter((k) => fieldOf(k).column!.defaultWidth === "*")).toEqual(["col_info"]);
  });

  it("draws each rows block's rows in contract order with no header strip, a row whose label is empty by its contract name, muted", () => {
    // Red when the rows fallback's muted class is removed in CanvasStage.tsx (Task 7's first sampled
    // mutation); also when the price block's entry names `price_heading` as its heading (PRICE then draws twice).
    const layout = standardInvoiceLayout();
    const html = invStage(layout);
    const seen = { muted: 0, plain: 0 };
    for (const key of ROWS_BLOCKS) {
      const item = byId(layout, `table-${key}`);
      expect(item.kind === "table" && item.columns.map((c) => c.key)).toEqual(rowKeys(key));
      const markup = block(html, `table-${key}`, layout);
      expect(markup).not.toContain(STRIP);
      const drawn = texts(markup);
      expect(drawn.map((t) => t.text)).toEqual([...rowKeys(key).map(drawnWords), DESIGNER_WORDS.rowsGrow]);
      // (pin) The same words read through each column's own label: the Standard types none, so this
      // line cannot red here; the typed-label cases below carry the label's proof.
      if (item.kind === "table") {
        expect(drawn.map((t) => t.text).slice(0, -1)).toEqual(item.columns.map((c) => wordsOf(c.key, c.label)));
      }
      rowKeys(key).forEach((row, i) => {
        const empty = fieldOf(row).defaultLabel === "";
        expect(muted(drawn[i].cls)).toBe(empty);
        seen[empty ? "muted" : "plain"] += 1;
      });
    }
    // Both shapes are drawn, so the loop above judges each (the part rows are all muted, the order strip none).
    expect(seen.muted).toBeGreaterThan(0);
    expect(seen.plain).toBeGreaterThan(0);
    expect(rowKeys("parts").map(drawnWords)).toEqual(["Part quantity", "Part identity", "Each weight", "Net weight"]);
  });

  it("draws a typed row label in the name's place, not muted", () => {
    // Red when the rows fallback's muted class is removed in CanvasStage.tsx: the next row, label-free,
    // is no longer drawn muted.
    const layout = standardInvoiceLayout();
    const parts = byId(layout, "table-parts");
    if (parts.kind !== "table") return expect.fail("the part rows are a table");
    const typed = withItem(layout, { ...parts, columns: parts.columns.map((c) => (c.key === "part_qty" ? { ...c, label: "Qty" } : c)) });
    const drawn = texts(block(invStage(typed), "table-parts", typed));
    expect(drawn.map((t) => t.text)).toEqual(["Qty", ...rowKeys("parts").slice(1).map(drawnWords), DESIGNER_WORDS.rowsGrow]);
    expect(muted(drawn[0].cls)).toBe(false);
    expect(drawn[0].cls).toContain("text-ink-800");
    expect(muted(drawn[1].cls)).toBe(true);
  });

  it("draws a row typed an empty label over a non-empty default as its name, muted", () => {
    // Red when the stage's rows block reads `field.defaultLabel` alone (CanvasStage.tsx's `labelOf`
    // made to skip `column.label`): the default label then draws, unmuted.
    const layout = standardInvoiceLayout();
    const strip = byId(layout, "table-order_strip");
    if (strip.kind !== "table") return expect.fail("the order strip is a table");
    const first = strip.columns[0].key;
    expect(fieldOf(first).defaultLabel).not.toBe("");
    const typed = withItem(layout, { ...strip, columns: strip.columns.map((c) => (c.key === first ? { ...c, label: "" } : c)) });
    const drawn = texts(block(invStage(typed), "table-order_strip", typed));
    expect(drawn[0].text).toBe(wordsOf(first, ""));
    expect(drawn[0].text).toBe(fieldOf(first).name);
    expect(muted(drawn[0].cls)).toBe(true);
    expect(muted(drawn[1].cls)).toBe(false);
  });

  it("draws the parties' two rows stacked, one under the other, unmuted, with no strip", () => {
    // Red when the rows block's container in CanvasStage.tsx loses its `flex-col` (its rows then sit side by side).
    const markup = block(invStage(), "table-parties");
    const drawn = texts(markup);
    expect(drawn.map((t) => t.text)).toEqual([fieldOf("bill_to").defaultLabel, fieldOf("ship_to").defaultLabel, DESIGNER_WORDS.rowsGrow]);
    expect(drawn.slice(0, 2).map((t) => t.text)).toEqual(["Billto:", "Shipto:"]);
    // Each row its own line in the block's one column (the live page prints them side by side).
    expect(markup).toContain("flex h-full flex-col");
    for (const t of drawn.slice(0, 2)) {
      expect(t.cls).toContain("truncate px-0.5");
      expect(muted(t.cls)).toBe(false);
    }
    expect(markup).not.toContain(STRIP);
  });

  it("draws the Remit To box in a border, and no other invoice field", () => {
    // Red when `remit_to` is dropped from INVOICE_CANVAS's `boxedFields` (Task 7's second sampled mutation).
    const layout = standardInvoiceLayout();
    const html = invStage(layout);
    expect(block(html, "field-remit_to", layout)).toContain(BORDER);
    const others = layout.items.filter((i) => i.kind === "field" && i.key !== "remit_to");
    expect(others.length).toBeGreaterThan(0);
    for (const item of others) expect(block(html, item.id, layout)).not.toContain(BORDER);
  });

  it("draws no invoice field on a rule", () => {
    // Red when INVOICE_CANVAS's `ruledFields` names a field (`[{ key: "terms", draw: "beside" }]`).
    const layout = standardInvoiceLayout();
    const html = invStage(layout);
    for (const item of layout.items.filter((i) => i.kind === "field")) expect(block(html, item.id, layout)).not.toContain(RULE);
    expect(html).not.toContain(RULE);
  });

  it("draws a Totals block with every row hidden as the hatch alone", () => {
    // Red when the rows branch in CanvasStage.tsx maps `item.columns` in place of the visible ones.
    const layout = standardInvoiceLayout();
    const totals = byId(layout, "table-totals");
    if (totals.kind !== "table") return expect.fail("the totals are a table");
    const hidden = withItem(layout, { ...totals, columns: totals.columns.map((c) => ({ ...c, visible: false })) });
    const markup = block(invStage(hidden), "table-totals", hidden);
    expect(texts(markup).map((t) => t.text)).toEqual([DESIGNER_WORDS.rowsGrow]);
    expect(markup).not.toContain(STRIP);
  });

  it("draws an invoice block measured on page 2 dashed at its drawn box, titled for this invoice or credit", () => {
    // Red when CanvasStage.tsx's dashed overlay for an item printing on another page is removed.
    const layout = standardInvoiceLayout();
    const measure: CanvasMeasure = { pages: 2, tables: [{ key: "totals", page: 2, top: 40, height: 60 }], regions: [], items: [] };
    const html = invStage(layout, { measure });
    const items = listitems(html);
    const i = layout.items.findIndex((item) => item.id === "table-totals");
    expect(stageBox(layout.items[i], layout, measure).page).toBe(2);
    expect(DESIGNER_WORDS.printsOnPage(2, "INVOICE")).toBe("Prints on page 2 for this invoice or credit");
    expect(items[i].title).toBe("Prints on page 2 for this invoice or credit");
    expect(items[i].style).toContain(px(drawnBox(layout.items[i], layout), SCALE));
    expect(items[i].cls).toContain("opacity-60");
    expect(block(html, "table-totals", layout)).toContain("border-dashed");
    expect(block(invStage(layout), "table-totals", layout)).not.toContain("border-dashed");
    // The blocks measured nowhere stay on page 1, solid.
    expect(block(html, "table-parties", layout)).not.toContain("border-dashed");
  });

  // The inspector.
  const invInspector = (id: string, layout: CanvasLayout = standardInvoiceLayout()) => inspector(byId(layout, id), layout, INVOICE_CONTRACT);
  const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)</g)].map((m) => m[1]);
  /** The Width box label's words before the name, read from the leaf. */
  const widthPrefix = DESIGNER_WORDS.columnWidth("\u0000").split("\u0000")[0];
  const anchorOptions = (html: string) => {
    const select = html.match(/<select[^>]*aria-label="Anchor"[^>]*>([\s\S]*?)<\/select>/);
    return select ? [...select[1].matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => decode(m[1])) : null;
  };

  it("gives each rows block's rows a Show and a Label box, no Width box and no reorder control", () => {
    // Red when the inspector's `const rows = spec?.rows === true` is made `false` (Task 7's third sampled
    // mutation): every row then takes a Width box.
    expect(widthPrefix).toBe("Width for ");
    for (const key of ROWS_BLOCKS) {
      const html = invInspector(`table-${key}`);
      expect(html).toContain(`>${DESIGNER_WORDS.columns}<`);
      for (const row of rowKeys(key)) {
        expect(html).toContain(`aria-label="${DESIGNER_WORDS.columnShown(fieldOf(row).name)}"`);
        expect(html).toContain(`aria-label="${DESIGNER_WORDS.columnLabel(fieldOf(row).name)}"`);
      }
      expect(html).not.toContain(`aria-label="${widthPrefix}`);
      expect(buttons(html)).toEqual([DESIGNER_WORDS.remove]);
    }
  });

  it("gives each of the column headers' four columns a Show, a Label and a Width box, named by the field's name", () => {
    // Red when INVOICE_CANVAS's column headers entry is made a rows block (`rows: true`), which takes
    // the Width boxes away.
    const html = invInspector("table-column_header");
    const keys = rowKeys("column_header");
    for (const key of keys) {
      const name = fieldOf(key).name;
      expect(html).toContain(`aria-label="${DESIGNER_WORDS.columnShown(name)}"`);
      expect(html).toContain(`aria-label="${DESIGNER_WORDS.columnLabel(name)}"`);
      expect(html).toContain(`aria-label="${DESIGNER_WORDS.columnWidth(name)}"`);
    }
    expect(DESIGNER_WORDS.columnWidth(fieldOf("col_qty").name)).toBe("Width for Quantity column (pt)");
    expect(html).toContain('aria-label="Width for Quantity column (pt)"');
    expect(html).not.toContain('aria-label="Width for Quantity"');
    expect([...html.matchAll(new RegExp(`aria-label="${widthPrefix}`, "g"))]).toHaveLength(keys.length);
    expect(buttons(html)).toEqual([DESIGNER_WORDS.remove]);
  });

  it("shows no invoice block a Heading box", () => {
    // Red when INVOICE_CANVAS's price block entry names `price_heading` as its heading.
    // The markup first, so the mutation reds the inspector's drawing, not only the leaf's answer.
    for (const key of ALL_BLOCKS) expect(invInspector(`table-${key}`)).not.toContain(`aria-label="${DESIGNER_WORDS.heading}"`);
    for (const key of ALL_BLOCKS) expect(tableHeadingKey(INVOICE_CONTRACT, key)).toBeNull();
    expect(ALL_BLOCKS).toHaveLength(6);
  });

  it("offers an identity line drawn under the stack Page top, Below each of the six blocks by name, and Page bottom", () => {
    // Red when the inspector's table filter (CanvasInspector.tsx's `below`) asks for a bottom 200 pt
    // above the item's top, dropping every block that ends within 200 pt above it. An identity line
    // as the standard layout draws it (y 72) lies above every block, so the select offers it no
    // block; drawn under the totals (which end at 220) it is offered all six.
    const layout = standardInvoiceLayout();
    const line = byId(layout, "field-invoice_no");
    const moved = withItem(layout, { ...line, box: { ...line.box, y: 300 } });
    expect(anchorOptions(invInspector("field-invoice_no", layout))).toEqual([DESIGNER_WORDS.anchorPageTop, DESIGNER_WORDS.anchorPageBottom]);
    const offered = anchorOptions(invInspector("field-invoice_no", moved));
    const blocks = tablesByY(moved);
    expect(blocks.map((t) => t.key)).toEqual(ALL_BLOCKS);
    expect(offered).toEqual([
      DESIGNER_WORDS.anchorPageTop, ...blocks.map((t) => DESIGNER_WORDS.anchorBelow(itemTitle(t, INVOICE_CONTRACT))), DESIGNER_WORDS.anchorPageBottom,
    ]);
    expect(offered).toContain("Below Bill to / ship to table");
  });
});

// The statement (since statement canvas PR 2; design 2026-11-11 §4.6, where the stage "needs nothing
// new to draw the statement's blocks", and §8): the stage and
// the inspector draw a statement's five blocks with the shapes the earlier lanes built, read through
// the leaf from `STATEMENT_CANVAS`, and no production change comes with these cases (plan open
// questions 3 and 8). The Bill To is a list block keyed by its field and draws its heading, one line
// and the hatch; the open items, the finance charge and Total Due are rows blocks and draw their rows;
// the aging is a boxed column table and draws its header strip. Every name and label is read from the
// contract, never retyped. Each case is green on arrival and names, in a comment, the mutation
// that was run and reds it, or says "(pin)". The finance block measured at 0 pt (#958) is pinned by the
// "statement finance charge (record)" row of the empty-table cases above, not repeated here.
describe("the statement's blocks on the stage", () => {
  const STRIP = "bg-surface-50";
  const RULE = "border-b border-ink-900";
  const BORDER = "h-full border border-ink-900";
  const ROWS_BLOCKS = ["open_items", "finance_charge", "total"] as const;
  const ALL_BLOCKS = ["bill_to", "open_items", "aging", "finance_charge", "total"] as const;
  const stStage = (layout: CanvasLayout = standardStatementLayout(), over: Partial<Parameters<typeof CanvasStage>[0]> = {}) =>
    stage(layout, { contract: STATEMENT_CONTRACT, ...over });
  const stFields = STATEMENT_CONTRACT.sections.flatMap((s) => s.fields);
  const fieldOf = (key: string) => stFields.find((f) => f.key === key)!;
  const rowKeys = (section: string) => STATEMENT_CONTRACT.sections.find((s) => s.key === section)!.fields.map((f) => f.key);
  /** What a rows block draws for a row (`column.label ?? field.defaultLabel`, CanvasStage.tsx): its
   *  typed label, else its default label, or its contract name where that resolves to "". */
  const wordsOf = (key: string, label: string | null | undefined) => {
    const words = label ?? fieldOf(key).defaultLabel;
    return words === "" ? fieldOf(key).name : words;
  };
  /** An item's markup, found by its title (`itemTitle`). */
  const block = (html: string, id: string, layout: CanvasLayout = standardStatementLayout()) =>
    decode(itemMarkup(html, itemTitle(byId(layout, id), STATEMENT_CONTRACT).replace(/'/g, "&#x27;")));
  /** Every element's own text in an item's markup, in order, each with its class and style. */
  const texts = (markup: string) => [...markup.matchAll(/<(?:div|span)([^>]*)>([^<]+)</g)]
    .map((m) => ({ text: m[2], cls: attr(m[1], "class") ?? "", style: attr(m[1], "style") ?? "" }));
  const muted = (cls: string) => cls.includes("text-ink-500") && cls.includes("italic");
  const count = (html: string, needle: string) => html.split(needle).length - 1;
  const withItem = (layout: CanvasLayout, next: CanvasItem) => layoutOf(layout.items.map((i) => (i.id === next.id ? next : i)));

  it("draws the Bill To as its heading, one line and the hatch, and a typed heading in the contract's place", () => {
    // Red when STATEMENT_CANVAS's Bill To entry names no heading (`heading: null`): the block's name
    // then draws, muted, where "Bill To" stands.
    const layout = standardStatementLayout();
    const markup = block(stStage(layout), "table-bill_to", layout);
    const heading = fieldOf("bill_to").defaultLabel;
    expect(heading).toBe("Bill To");
    const drawn = texts(markup);
    expect(drawn.map((t) => t.text)).toEqual([heading, DESIGNER_WORDS.rowsGrow]);
    expect(muted(drawn[0].cls)).toBe(false);
    expect(drawn[0].cls).toContain("font-bold");
    expect(count(markup, RULE)).toBe(1);
    expect(markup.indexOf(`>${heading}<`)).toBeLessThan(markup.indexOf(RULE));
    expect(markup.indexOf(RULE)).toBeLessThan(markup.indexOf(DESIGNER_WORDS.rowsGrow));
    expect(markup).not.toContain(STRIP);
    // A typed heading draws in the contract's place.
    const bill = byId(layout, "table-bill_to");
    if (bill.kind !== "table") return expect.fail("the Bill To is a table");
    expect(bill.columns).toEqual([]);
    const typed = withItem(layout, { ...bill, heading: "Sold To" });
    const typedDrawn = texts(block(stStage(typed), "table-bill_to", typed));
    expect(typedDrawn.map((t) => t.text)).toEqual(["Sold To", DESIGNER_WORDS.rowsGrow]);
    expect(muted(typedDrawn[0].cls)).toBe(false);
  });

  it("draws each rows block's rows in contract order over the hatch with no header strip, the open items' five stacked", () => {
    // Red when STATEMENT_CANVAS's open items entry is made a column table (`rows: false`): its five
    // labels then draw in a header strip.
    const layout = standardStatementLayout();
    const html = stStage(layout);
    for (const key of ROWS_BLOCKS) {
      const item = byId(layout, `table-${key}`);
      expect(item.kind === "table" && item.columns.map((c) => c.key)).toEqual(rowKeys(key));
      const markup = block(html, `table-${key}`, layout);
      expect(markup).not.toContain(STRIP);
      const drawn = texts(markup);
      expect(drawn.map((t) => t.text)).toEqual([...rowKeys(key).map((row) => wordsOf(row, null)), DESIGNER_WORDS.rowsGrow]);
      // (pin) The same words read through each column's own label: the Standard types none.
      if (item.kind === "table") {
        expect(drawn.map((t) => t.text).slice(0, -1)).toEqual(item.columns.map((c) => wordsOf(c.key, c.label)));
      }
      // Every statement row has a default label, so none draws muted.
      for (const row of rowKeys(key)) expect(fieldOf(row).defaultLabel).not.toBe("");
      for (const t of drawn.slice(0, -1)) {
        expect(t.cls).toContain("truncate px-0.5");
        expect(muted(t.cls)).toBe(false);
      }
      expect(markup).toContain("flex h-full flex-col");
    }
    expect(rowKeys("open_items")).toHaveLength(5);
    expect(rowKeys("open_items").map((row) => wordsOf(row, null))).toEqual(["Document #", "Date", "Due Date", "Original", "Open"]);
  });

  it("draws a typed row label in place of the default, and a row typed an empty label as its name, muted", () => {
    // Red when the rows fallback's muted class is removed in CanvasStage.tsx: the
    // date row, typed "", then draws its name unmuted.
    const layout = standardStatementLayout();
    const items = byId(layout, "table-open_items");
    if (items.kind !== "table") return expect.fail("the open items are a table");
    const typed = withItem(layout, {
      ...items,
      columns: items.columns.map((c) => (c.key === "document_no" ? { ...c, label: "Invoice" } : c.key === "date" ? { ...c, label: "" } : c)),
    });
    const drawn = texts(block(stStage(typed), "table-open_items", typed));
    expect(drawn.map((t) => t.text)).toEqual([
      "Invoice", fieldOf("date").name, ...rowKeys("open_items").slice(2).map((row) => wordsOf(row, null)), DESIGNER_WORDS.rowsGrow,
    ]);
    expect(fieldOf("date").defaultLabel).not.toBe("");
    expect(drawn[1].text).toBe(wordsOf("date", ""));
    expect(muted(drawn[0].cls)).toBe(false);
    expect(drawn[0].cls).toContain("text-ink-800");
    expect(muted(drawn[1].cls)).toBe(true);
    expect(muted(drawn[2].cls)).toBe(false);
  });

  it("draws only a rows block's visible rows: a hidden open items row draws nothing", () => {
    // Red when the rows branch in CanvasStage.tsx maps `item.columns` in place of the visible ones.
    const layout = standardStatementLayout();
    const items = byId(layout, "table-open_items");
    if (items.kind !== "table") return expect.fail("the open items are a table");
    const hidden = withItem(layout, { ...items, columns: items.columns.map((c) => (c.key === "due_date" ? { ...c, visible: false } : c)) });
    const drawn = texts(block(stStage(hidden), "table-open_items", hidden));
    expect(drawn.map((t) => t.text)).toEqual([
      ...rowKeys("open_items").filter((row) => row !== "due_date").map((row) => wordsOf(row, null)), DESIGNER_WORDS.rowsGrow,
    ]);
    expect(drawn.map((t) => t.text)).not.toContain(fieldOf("due_date").defaultLabel);
  });

  it("draws the aging as its header strip of seven columns, each flexible", () => {
    // Red when STATEMENT_CANVAS's aging entry is made a rows block (`rows: true`): the seven labels then
    // draw as rows with no strip.
    const layout = standardStatementLayout();
    const markup = block(stStage(layout), "table-aging", layout);
    const aging = byId(layout, "table-aging");
    const keys = aging.kind === "table" ? aging.columns.map((c) => c.key) : [];
    expect(keys).toEqual(rowKeys("aging"));
    expect(keys).toHaveLength(7);
    expect(markup).toContain(STRIP);
    const drawn = texts(markup);
    expect(drawn.map((t) => t.text)).toEqual([...keys.map((k) => fieldOf(k).defaultLabel), DESIGNER_WORDS.rowsGrow]);
    keys.forEach((key, i) => {
      expect(fieldOf(key).column!.defaultWidth).toBe("*");
      expect(drawn[i].style).toBe("flex:1");
      expect(muted(drawn[i].cls)).toBe(false);
    });
  });

  it("draws the Remit To box in a border, and no other statement field", () => {
    // Red when STATEMENT_CANVAS's `boxedFields` is emptied.
    const layout = standardStatementLayout();
    const html = stStage(layout);
    expect(block(html, "field-remit_to", layout)).toContain(BORDER);
    const others = layout.items.filter((i) => i.kind === "field" && i.key !== "remit_to");
    expect(others.length).toBeGreaterThan(0);
    for (const item of others) expect(block(html, item.id, layout)).not.toContain(BORDER);
  });

  it("draws no statement field on a rule", () => {
    // Red when STATEMENT_CANVAS's `ruledFields` names a field (`[{ key: "customer", draw: "beside" }]`).
    // Scoped to the field items: the Bill To, a list block, draws its one line with the same classes.
    const layout = standardStatementLayout();
    const html = stStage(layout);
    const fields = layout.items.filter((i) => i.kind === "field");
    expect(fields.map((i) => i.kind === "field" && i.key)).toEqual(["title", "company_name", "customer", "statement_date", "remit_to"]);
    for (const item of fields) expect(block(html, item.id, layout)).not.toContain(RULE);
  });

  it("draws a held Bill To measured taller than its drawn box at the measured box", () => {
    // Red when `stageBox`'s measured table answers the stored height (`h: item.box.h` for
    // `h: Math.min(m.height, BOTTOM - m.top)` in canvas-designer.ts). The block holds at least its drawn
    // height on paper (`holdsHeight`), so a bill-to taller than the box grows it; the stage draws the
    // measured box alone and the inspector's H is the only view of the floor (open question 3).
    const layout = standardStatementLayout();
    const bill = byId(layout, "table-bill_to");
    expect(tableSpec(STATEMENT_CONTRACT, "bill_to")?.holdsHeight).toBe(true);
    const grown = { key: "bill_to", page: 1, top: bill.box.y, height: bill.box.h + 4 * CANVAS_GRID };
    const measure: CanvasMeasure = { pages: 1, tables: [grown], regions: [], items: [] };
    const at = listitems(stStage(layout, { measure }))[layout.items.indexOf(bill)];
    const measured = { ...bill.box, y: grown.top, h: grown.height };
    expect(stageBox(bill, layout, measure)).toEqual({ box: measured, page: 1, measured: true });
    expect(measured.h).toBeGreaterThan(drawnBox(bill, layout).h);
    expect(at.style).toContain(px(measured, SCALE));
    expect(at.style).not.toContain(px(drawnBox(bill, layout), SCALE));
    expect(at.title).toBeNull();
  });

  it("draws a statement block measured on page 2 dashed at its drawn box, titled for this customer", () => {
    // Red when CanvasStage.tsx's dashed overlay for an item printing on another page is removed.
    const layout = standardStatementLayout();
    const measure: CanvasMeasure = { pages: 2, tables: [{ key: "total", page: 2, top: 40, height: 13 }], regions: [], items: [] };
    const html = stStage(layout, { measure });
    const items = listitems(html);
    const i = layout.items.findIndex((item) => item.id === "table-total");
    expect(stageBox(layout.items[i], layout, measure).page).toBe(2);
    expect(DESIGNER_WORDS.printsOnPage(2, "STATEMENT")).toBe("Prints on page 2 for this customer");
    expect(items[i].title).toBe("Prints on page 2 for this customer");
    expect(items[i].style).toContain(px(drawnBox(layout.items[i], layout), SCALE));
    expect(items[i].cls).toContain("opacity-60");
    expect(block(html, "table-total", layout)).toContain("border-dashed");
    expect(block(stStage(layout), "table-total", layout)).not.toContain("border-dashed");
    // The blocks measured nowhere stay on page 1, solid.
    expect(block(html, "table-open_items", layout)).not.toContain("border-dashed");
  });

  // The inspector.
  const stInspector = (id: string, layout: CanvasLayout = standardStatementLayout()) => inspector(byId(layout, id), layout, STATEMENT_CONTRACT);
  const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)</g)].map((m) => m[1]);
  /** The Width box label's words before the name, read from the leaf. */
  const widthPrefix = DESIGNER_WORDS.columnWidth("\u0000").split("\u0000")[0];

  it("gives each rows block's rows a Show and a Label box and no Width box", () => {
    // Red when the inspector's `const rows = spec?.rows === true` is made `false`: every row
    // then takes a Width box. Its buttons holding Remove alone is a pin: the inspector offers no
    // reorder control on any table (the aging's case below asserts the same list).
    expect(widthPrefix).toBe("Width for ");
    for (const key of ROWS_BLOCKS) {
      const html = stInspector(`table-${key}`);
      expect(html).toContain(`>${DESIGNER_WORDS.columns}<`);
      for (const row of rowKeys(key)) {
        expect(html).toContain(`aria-label="${DESIGNER_WORDS.columnShown(fieldOf(row).name)}"`);
        expect(html).toContain(`aria-label="${DESIGNER_WORDS.columnLabel(fieldOf(row).name)}"`);
      }
      expect(html).not.toContain(`aria-label="${widthPrefix}`);
      expect(buttons(html)).toEqual([DESIGNER_WORDS.remove]);
    }
  });

  it("gives each of the aging's seven columns a Show, a Label and a Width box, named by the field's name", () => {
    // Red when STATEMENT_CANVAS's aging entry is made a rows block (`rows: true`), which takes the
    // Width boxes away.
    const html = decode(stInspector("table-aging"));
    const keys = rowKeys("aging");
    for (const key of keys) {
      const name = fieldOf(key).name;
      expect(html).toContain(`aria-label="${DESIGNER_WORDS.columnShown(name)}"`);
      expect(html).toContain(`aria-label="${DESIGNER_WORDS.columnLabel(name)}"`);
      expect(html).toContain(`aria-label="${DESIGNER_WORDS.columnWidth(name)}"`);
    }
    expect(DESIGNER_WORDS.columnWidth(fieldOf("aging_net").name)).toBe("Width for Net (pt)");
    expect(html.split(`aria-label="${widthPrefix}`).length - 1).toBe(keys.length);
    expect(buttons(html)).toEqual([DESIGNER_WORDS.remove]);
  });

  it("shows the Bill To a Heading box with the contract's heading as its placeholder, and no other statement block one", () => {
    // Red when STATEMENT_CANVAS's Bill To entry names no heading (`heading: null`): its Heading box goes.
    const html = stInspector("table-bill_to");
    const headingBox = html.match(/<input[^>]*aria-label="Heading"[^>]*>/);
    expect(headingBox).not.toBeNull();
    expect(attr(headingBox![0], "placeholder")).toBe(fieldOf("bill_to").defaultLabel);
    expect(attr(headingBox![0], "placeholder")).toBe("Bill To");
    // A block with no columns shows no Columns label.
    expect(html).not.toContain(`>${DESIGNER_WORDS.columns}<`);
    for (const key of ALL_BLOCKS.slice(1)) {
      expect(stInspector(`table-${key}`)).not.toContain(`aria-label="${DESIGNER_WORDS.heading}"`);
      expect(tableHeadingKey(STATEMENT_CONTRACT, key)).toBeNull();
    }
    expect(tableHeadingKey(STATEMENT_CONTRACT, "bill_to")).toBe("bill_to");
    expect(DESIGNER_WORDS.heading).toBe("Heading");
  });
});

// The quotation (since quote canvas PR 2; design 2026-11-12 §4.6, "nothing new"): the stage and the
// inspector draw a quote's six blocks with the shapes the earlier lanes built, read through the leaf
// from `QUOTE_CANVAS`, and no production change comes with these cases. The parties, the lines and
// the closing are rows blocks and draw their rows, a row whose label resolves to "" by its contract
// name, muted (the certification's fallback); the column headers are a column table and draw their
// strip; the intro and the liability are list blocks with no heading and draw their block names,
// muted. Every name and label is read from the contract, never retyped. Each case is green on arrival
// and names, in a comment, the mutation that reds it, or says "(pin)" in its title.
describe("the quote's blocks on the stage", () => {
  const STRIP = "bg-surface-50";
  const RULE = "border-b border-ink-900";
  const BORDER = "h-full border border-ink-900";
  const ROWS_BLOCKS = ["parties", "lines", "closing"] as const;
  const LIST_BLOCKS = ["intro", "liability"] as const;
  const ALL_BLOCKS = ["parties", "intro", "column_header", "lines", "closing", "liability"] as const;
  const qtStage = (layout: CanvasLayout = standardQuoteLayout(), over: Partial<Parameters<typeof CanvasStage>[0]> = {}) =>
    stage(layout, { contract: QUOTE_CONTRACT, ...over });
  const qtFields = QUOTE_CONTRACT.sections.flatMap((s) => s.fields);
  const fieldOf = (key: string) => qtFields.find((f) => f.key === key)!;
  const rowKeys = (section: string) => QUOTE_CONTRACT.sections.find((s) => s.key === section)!.fields.map((f) => f.key);
  /** What a rows block draws for a row (`column.label ?? field.defaultLabel`, CanvasStage.tsx): its
   *  typed label, else its default label, or its contract name where that resolves to "". */
  const wordsOf = (key: string, label: string | null | undefined) => {
    const words = label ?? fieldOf(key).defaultLabel;
    return words === "" ? fieldOf(key).name : words;
  };
  /** An item's markup, found by its title (`itemTitle`). */
  const block = (html: string, id: string, layout: CanvasLayout = standardQuoteLayout()) =>
    decode(itemMarkup(html, itemTitle(byId(layout, id), QUOTE_CONTRACT).replace(/'/g, "&#x27;")));
  /** Every element's own text in an item's markup, in order, each with its class and style. */
  const texts = (markup: string) => [...markup.matchAll(/<(?:div|span)([^>]*)>([^<]+)</g)]
    .map((m) => ({ text: m[2], cls: attr(m[1], "class") ?? "", style: attr(m[1], "style") ?? "" }));
  const muted = (cls: string) => cls.includes("text-ink-500") && cls.includes("italic");
  const count = (html: string, needle: string) => html.split(needle).length - 1;
  const withItem = (layout: CanvasLayout, next: CanvasItem) => layoutOf(layout.items.map((i) => (i.id === next.id ? next : i)));
  /** The Standard's two wordings, typed, so a case can show the list blocks never draw them. */
  const WORDING = { quote_intro_text: "We are pleased to quote", quote_liability_text: "Our liability is limited" };

  it("draws each rows block's visible rows in contract order over the hatch with no header strip, a value-only row by its contract name, muted", () => {
    // Red when the rows fallback's muted class is removed in CanvasStage.tsx: every value-only row then
    // draws its name unmuted.
    const layout = standardQuoteLayout();
    const html = qtStage(layout);
    for (const key of ROWS_BLOCKS) {
      const item = byId(layout, `table-${key}`);
      if (item.kind !== "table") return expect.fail(`the ${key} block is a table`);
      expect(item.columns.map((c) => c.key)).toEqual(rowKeys(key));
      expect(item.columns.every((c) => c.visible && c.label === null)).toBe(true);
      const markup = block(html, `table-${key}`, layout);
      expect(markup).not.toContain(STRIP);
      expect(markup).toContain("flex h-full flex-col");
      const drawn = texts(markup);
      expect(drawn.map((t) => t.text)).toEqual([...rowKeys(key).map((row) => wordsOf(row, null)), DESIGNER_WORDS.rowsGrow]);
      rowKeys(key).forEach((row, i) => {
        expect(drawn[i].cls).toContain("truncate px-0.5");
        // A row whose default label is "" draws its contract name, muted; any other its label, unmuted.
        expect(muted(drawn[i].cls), row).toBe(fieldOf(row).defaultLabel === "");
        if (!muted(drawn[i].cls)) expect(drawn[i].cls).toContain("text-ink-800");
      });
    }
    // The value-only rows the design names, among the rest, by their contract names.
    for (const row of ["line_qty", "line_part", "step_name", "price_amount"]) {
      expect(fieldOf(row).defaultLabel).toBe("");
      const drawn = texts(block(html, "table-lines", layout)).find((t) => t.text === fieldOf(row).name);
      expect(drawn, row).toBeDefined();
      expect(muted(drawn!.cls), row).toBe(true);
    }
    expect(rowKeys("closing").every((row) => fieldOf(row).defaultLabel === "")).toBe(true);
    expect(fieldOf("bill_to").defaultLabel).toBe("");
    // The surcharge estimate's default label, "(estimate)", draws in normal text (design §4.6).
    expect(fieldOf("surcharge_estimate").defaultLabel).toBe("(estimate)");
    const estimate = texts(block(html, "table-lines", layout)).find((t) => t.text === "(estimate)");
    expect(estimate).toBeDefined();
    expect(muted(estimate!.cls)).toBe(false);
    expect(estimate!.cls).toContain("text-ink-800");
  });

  it("draws a typed row label in the default's place, not muted, and only the visible rows", () => {
    // Red when the rows branch in CanvasStage.tsx draws the default label over a typed one
    // (`fieldOf(column.key)?.defaultLabel` for `labelOf(column)`), or maps `item.columns` in place of
    // the visible ones.
    const layout = standardQuoteLayout();
    const lines = byId(layout, "table-lines");
    if (lines.kind !== "table") return expect.fail("the lines are a table");
    const typed = withItem(layout, {
      ...lines,
      columns: lines.columns.map((c) => (c.key === "line_qty" ? { ...c, label: "Qty" }
        : c.key === "material" ? { ...c, label: "Alloy:" }
          : c.key === "price_heading" ? { ...c, visible: false } : c)),
    });
    const drawn = texts(block(qtStage(typed), "table-lines", typed));
    const expected = rowKeys("lines").filter((row) => row !== "price_heading").map((row) =>
      (row === "line_qty" ? "Qty" : row === "material" ? "Alloy:" : wordsOf(row, null)));
    expect(drawn.map((t) => t.text)).toEqual([...expected, DESIGNER_WORDS.rowsGrow]);
    expect(drawn.map((t) => t.text)).not.toContain(fieldOf("price_heading").defaultLabel);
    for (const words of ["Qty", "Alloy:"]) {
      const t = drawn.find((d) => d.text === words)!;
      expect(muted(t.cls)).toBe(false);
      expect(t.cls).toContain("text-ink-800");
    }
  });

  it("draws the column headers as their header strip of four columns, each fixed column at its default width and the information column flexible", () => {
    // Red when QUOTE_CANVAS's column headers entry is made a rows block (`rows: true`): the four
    // labels then draw as rows with no strip.
    const layout = standardQuoteLayout();
    const markup = block(qtStage(layout), "table-column_header", layout);
    const headers = byId(layout, "table-column_header");
    const keys = headers.kind === "table" ? headers.columns.map((c) => c.key) : [];
    expect(keys).toEqual(rowKeys("column_header"));
    expect(keys).toHaveLength(4);
    expect(markup).toContain(STRIP);
    const drawn = texts(markup);
    expect(drawn.map((t) => t.text)).toEqual([...keys.map((k) => fieldOf(k).defaultLabel), DESIGNER_WORDS.rowsGrow]);
    keys.forEach((key, i) => {
      const width = fieldOf(key).column!.defaultWidth;
      expect(drawn[i].style).toBe(width === "*" ? "flex:1" : `width:${width * SCALE}px;flex:none`);
      expect(muted(drawn[i].cls)).toBe(false);
    });
    expect(keys.filter((k) => fieldOf(k).column!.defaultWidth === "*")).toEqual(["col_info"]);
  });

  it("draws the intro and the liability as list blocks: each block's name, muted, one line and the hatch, never its wording", () => {
    // Red when QUOTE_CANVAS's liability entry is made a rows block (`rows: true`): `isListBlock` reads `rows` and `printed` alone, so the liability then draws
    // as a rows block of no rows, its name and its line gone. The "never its wording" half is a pin:
    // the stage's table branch never reads `textBlocks`, so no mutation of a quote block reds it.
    const layout = standardQuoteLayout();
    const html = qtStage(layout, { textBlocks: WORDING });
    const shown: string[] = [];
    for (const key of LIST_BLOCKS) {
      expect(isListBlock(QUOTE_CONTRACT, key)).toBe(true);
      expect(tableHeadingKey(QUOTE_CONTRACT, key)).toBeNull();
      const markup = block(html, `table-${key}`, layout);
      const drawn = texts(markup);
      const title = itemTitle(byId(layout, `table-${key}`), QUOTE_CONTRACT);
      expect(drawn.map((t) => t.text)).toEqual([title, DESIGNER_WORDS.rowsGrow]);
      expect(muted(drawn[0].cls)).toBe(true);
      expect(count(markup, RULE)).toBe(1);
      expect(markup.indexOf(`>${title}<`)).toBeLessThan(markup.indexOf(RULE));
      expect(markup.indexOf(RULE)).toBeLessThan(markup.indexOf(DESIGNER_WORDS.rowsGrow));
      expect(markup).not.toContain(STRIP);
      for (const wording of Object.values(WORDING)) expect(markup).not.toContain(wording);
      shown.push(drawn[0].text);
    }
    expect(shown).toEqual(["Intro line table", "Liability text table"]);
    // The wording reaches the stage (the stage draws it for a text block item), and no block draws it.
    for (const wording of Object.values(WORDING)) expect(html).not.toContain(wording);
  });

  it("draws the liability measured 0 pt hatched at its drawn box, marked and titled; the intro measured at its one line never", () => {
    // #958's shared drawing (the hatch, its words, its border, its z-5, no fill) is pinned on the
    // ticket's serials by "draws a table measured 0 tall at its drawn box, marked, still focusable" in
    // the stage's describe, and per document by "marks the %s block measured 0 pt" in "a table the
    // picked record leaves empty (#958)"; this case holds the quote's liability to it and is not a
    // copy. Red when `stageBox`'s `printsNothing` branch is removed (the box), when the title entry is
    // removed (the title) and when `data-empty` is removed. The intro half is red when `printsNothing`
    // judges a table empty by its entry alone (`entry !== undefined`, its height test dropped).
    const layout = standardQuoteLayout();
    const liability = byId(layout, "table-liability");
    const zero: CanvasMeasure = { pages: 1, tables: [{ key: "liability", page: 1, top: liability.box.y + 6, height: 0 }], regions: [], items: [] };
    expect(printsNothing(liability, zero)).toBe(true);
    const html = qtStage(layout, { measure: zero });
    const at = listitems(html)[layout.items.indexOf(liability)];
    expect(at.style).toContain(px(drawnBox(liability, layout), SCALE));
    expect(at.title).toContain(DESIGNER_WORDS.printsNothing);
    expect(DESIGNER_WORDS.printsNothing).toBe("Prints nothing for this record");
    const tag = itemMarkup(html, itemTitle(liability, QUOTE_CONTRACT));
    expect(attr(tag.slice(0, tag.indexOf(">")), "data-empty")).toBe("true");
    expect(tag).toContain(`>${DESIGNER_WORDS.printsNothing}<`);
    expect(tag).not.toContain(DESIGNER_WORDS.rowsGrow);
    // The intro, measured at its one line (PR 1's 11.13 pt in Roboto; it never measures 0), is drawn
    // as a list block, never hatched.
    const intro = byId(layout, "table-intro");
    const oneLine: CanvasMeasure = { pages: 1, tables: [{ key: "intro", page: 1, top: intro.box.y, height: 11.13 }], regions: [], items: [] };
    expect(printsNothing(intro, oneLine)).toBe(false);
    const introHtml = qtStage(layout, { measure: oneLine });
    expect(introHtml).not.toContain("data-empty");
    expect(introHtml).not.toContain(DESIGNER_WORDS.printsNothing);
    expect(texts(block(introHtml, "table-intro", layout)).map((t) => t.text))
      .toEqual([itemTitle(intro, QUOTE_CONTRACT), DESIGNER_WORDS.rowsGrow]);
  });

  it("draws no quote field in a border or on a rule", () => {
    // Red when QUOTE_CANVAS's `boxedFields` names a field (`["quote_number"]`) or its `ruledFields` does
    // (`[{ key: "quote_number", draw: "beside" }]`). Scoped to the field items: the list blocks draw
    // their one line with the rule's classes.
    const layout = standardQuoteLayout();
    const html = qtStage(layout);
    const fields = layout.items.filter((i) => i.kind === "field");
    expect(fields.map((i) => i.kind === "field" && i.key)).toEqual(["title", "company_name", "company_address", "quote_number"]);
    for (const item of fields) {
      expect(drawsBorder(item, QUOTE_CONTRACT)).toBe(false);
      expect(ruleOf(item, QUOTE_CONTRACT)).toBeNull();
      const markup = block(html, item.id, layout);
      expect(markup).not.toContain(BORDER);
      expect(markup).not.toContain(RULE);
    }
  });

  it("draws a quote block measured on page 2 dashed at its drawn box, titled for this quote", () => {
    // Red when CanvasStage.tsx's dashed overlay for an item printing on another page is removed.
    const layout = standardQuoteLayout();
    const measure: CanvasMeasure = { pages: 2, tables: [{ key: "closing", page: 2, top: 40, height: 60 }], regions: [], items: [] };
    const html = qtStage(layout, { measure });
    const items = listitems(html);
    const i = layout.items.findIndex((item) => item.id === "table-closing");
    expect(stageBox(layout.items[i], layout, measure).page).toBe(2);
    expect(DESIGNER_WORDS.printsOnPage(2, "QUOTE")).toBe("Prints on page 2 for this quote");
    expect(items[i].title).toBe("Prints on page 2 for this quote");
    expect(items[i].style).toContain(px(drawnBox(layout.items[i], layout), SCALE));
    expect(items[i].cls).toContain("opacity-60");
    expect(block(html, "table-closing", layout)).toContain("border-dashed");
    expect(block(qtStage(layout), "table-closing", layout)).not.toContain("border-dashed");
    // The blocks measured nowhere stay on page 1, solid.
    expect(block(html, "table-parties", layout)).not.toContain("border-dashed");
  });

  // The inspector.
  const qtInspector = (id: string, layout: CanvasLayout = standardQuoteLayout()) => inspector(byId(layout, id), layout, QUOTE_CONTRACT);
  const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)</g)].map((m) => m[1]);
  /** The Width box label's words before the name, read from the leaf. */
  const widthPrefix = DESIGNER_WORDS.columnWidth("\u0000").split("\u0000")[0];

  it("gives each rows block's rows a Show and a Label box and no Width box", () => {
    // Red when the inspector's `const rows = spec?.rows === true` is made `false`: every row then takes a Width box. Its buttons holding Remove alone is a pin:
    // CanvasInspector.tsx offers no reorder control on any table, so that half cannot fail.
    expect(widthPrefix).toBe("Width for ");
    for (const key of ROWS_BLOCKS) {
      const html = decode(qtInspector(`table-${key}`));
      expect(html).toContain(`>${DESIGNER_WORDS.columns}<`);
      for (const row of rowKeys(key)) {
        expect(html).toContain(`aria-label="${DESIGNER_WORDS.columnShown(fieldOf(row).name)}"`);
        expect(html).toContain(`aria-label="${DESIGNER_WORDS.columnLabel(fieldOf(row).name)}"`);
      }
      expect(html).not.toContain(`aria-label="${widthPrefix}`);
      expect(buttons(html)).toEqual([DESIGNER_WORDS.remove]);
    }
  });

  it("gives each of the column headers' four columns a Show, a Label and a Width box, named by the field's name", () => {
    // Red when QUOTE_CANVAS's column headers entry is made a rows block (`rows: true`), which takes the
    // Width boxes away.
    const html = decode(qtInspector("table-column_header"));
    const keys = rowKeys("column_header");
    for (const key of keys) {
      const name = fieldOf(key).name;
      expect(html).toContain(`aria-label="${DESIGNER_WORDS.columnShown(name)}"`);
      expect(html).toContain(`aria-label="${DESIGNER_WORDS.columnLabel(name)}"`);
      expect(html).toContain(`aria-label="${DESIGNER_WORDS.columnWidth(name)}"`);
    }
    expect(DESIGNER_WORDS.columnWidth(fieldOf("col_info").name)).toBe("Width for Information column (pt)");
    expect(html.split(`aria-label="${widthPrefix}`).length - 1).toBe(keys.length);
    expect(buttons(html)).toEqual([DESIGNER_WORDS.remove]);
  });

  it("shows the intro and the liability no rows and no Columns label", () => {
    // Red when CanvasInspector.tsx's `item.columns.length > 0` is made `true`: the Columns label then
    // shows over no rows. The two blocks hold no columns (`defaultTableColumns`: their sections have
    // no fields), so no Show, Label or Width box shows either.
    const showPrefix = DESIGNER_WORDS.columnShown("\u0000").split("\u0000")[0];
    const labelPrefix = DESIGNER_WORDS.columnLabel("\u0000").split("\u0000")[0];
    expect([showPrefix, labelPrefix]).toEqual(["Show ", "Label for "]);
    for (const key of LIST_BLOCKS) {
      const html = qtInspector(`table-${key}`);
      expect(byId(standardQuoteLayout(), `table-${key}`)).toMatchObject({ columns: [] });
      expect(html).not.toContain(`>${DESIGNER_WORDS.columns}<`);
      for (const prefix of [showPrefix, labelPrefix, widthPrefix]) expect(html).not.toContain(`aria-label="${prefix}`);
      expect(buttons(html)).toEqual([DESIGNER_WORDS.remove]);
    }
  });

  it("shows no quote block a Heading box", () => {
    // Red when QUOTE_CANVAS's lines entry names `price_heading` as its heading.
    for (const key of ALL_BLOCKS) {
      expect(qtInspector(`table-${key}`)).not.toContain(`aria-label="${DESIGNER_WORDS.heading}"`);
      expect(tableHeadingKey(QUOTE_CONTRACT, key)).toBeNull();
    }
    expect(DESIGNER_WORDS.heading).toBe("Heading");
  });
});

describe("the Design panel", () => {
  const config: TemplateConfig = { ...TRAVELER_DEFAULT_CONFIG, layout: standardLayout(), fonts: { ...TRAVELER_DEFAULT_CONFIG.fonts, family: "Roboto Mono" } };
  const render = (over: object = {}) => renderToStaticMarkup(
    <DesignPanel templateId="t1" contract={TRAVELER_CONTRACT} config={config} apply={() => {}} disabled={false}
                 editTitle={undefined} measure={null} logoSrc={null}
                 onBackToSections={() => {}} onClearPage={() => {}} preview={null} {...over} />,
  );
  it("composes the palette, the stage and the inspector under the tab's id, with the family's @font-face", () => {
    const html = render();
    expect(html).toContain('id="canvas-design"');
    expect(html).toContain('aria-label="Canvas items"');
    expect(listitems(html)).toHaveLength(config.layout!.items.length);
    expect(html).toContain(`<style>${fontFaceCss("Roboto Mono")}</style>`);
    expect(html).toContain(DESIGNER_WORDS.selectAnItem);
  });
  it("judges the warnings with the template's own fonts: the ticket's headings warning, in amber on the Containers table", () => {
    // The Containers table drawn 492 wide: its shared columns get 36 pt each per copy, under the 38.91 pt the
    // "Containers" heading word needs at the Standard's 8 pt, so warning (d) speaks (the panel hands the config's fonts
    // on). The 39 pt line warning (f) once judged here is retired (owner ruling R-C, 2026-11-17, #991).
    const containers = ticketTable("containers", { box: { x: 24, y: 208, w: 492, h: 30 } });
    const layout = layoutOf(standardTicketLayout().items.map((i) => (i.id === containers.id ? containers : i)));
    const ticket = (fonts: TemplateConfig["fonts"]) => render({
      contract: SHIPPER_CONTRACT, config: { ...SHIPPER_DEFAULT_CONFIG, layout, fonts },
    });
    const at = layout.items.findIndex((i) => i.id === containers.id);
    const [warning] = canvasWarnings(layout, SHIPPER_CONTRACT, undefined, { fonts: SHIPPER_DEFAULT_CONFIG.fonts });
    expect(warning.sentence).toContain("so its heading words break");
    const warned = listitems(ticket(SHIPPER_DEFAULT_CONFIG.fonts))[at];
    expect(warned.cls).toContain("outline-accent-600");
    expect(warned.title).toBe(warning.sentence);
    // Another base size: 7 pt, at which the "Containers" heading word fits its 36 pt share, so (d) is silent.
    const other = listitems(ticket({ ...SHIPPER_DEFAULT_CONFIG.fonts, baseSize: 7 }))[at];
    expect(other.cls).not.toContain("outline-accent-600");
    expect(other.title).toBeNull();
  });
  it("draws nothing on a template with no layout", () => {
    expect(render({ config: { ...config, layout: null } })).toBe("");
    expect(render({ config: { ...config, layout: null }, preview: <iframe title={DESIGNER_WORDS.livePage} /> })).toBe("");
  });
  it("mounts the live page it is handed in its own column, after the stage and the inspector (Task 6)", () => {
    const html = render({ preview: <iframe title={DESIGNER_WORDS.livePage} /> });
    const at = html.indexOf(`<iframe title="${DESIGNER_WORDS.livePage}"></iframe>`);
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(html.indexOf(DESIGNER_WORDS.selectAnItem));
    expect(html).toContain('data-live-page=""');
    expect(render()).not.toContain("<iframe");
  });
  it("lays the live page out by the leaf's grid, under the stage until the grid is measured (owner ruling 2026-11-20)", () => {
    const html = render({ preview: <iframe title={DESIGNER_WORDS.livePage} /> });
    // A static render measures nothing, so it is the leaf's `under` shape: three columns from lg, the
    // page spanning them, the palette held to the stage's height (the unmeasured scale 1 of 792 pt).
    const under = designGrid(false, 0);
    expect(html).toContain(`class="${under.className}"`);
    expect(html).toContain(`data-live-page="" class="${under.pageClass}"`);
    expect(html).toContain('data-palette-column="" class="min-w-0 lg:max-h-(--stage-height) lg:overflow-y-auto" style="--stage-height:792px"');
    // Ruling C28's container query is gone: the grid's measured width decides (`liveBeside`).
    expect(html).not.toContain("@container");
    expect(html).not.toContain("76rem");
  });
});
