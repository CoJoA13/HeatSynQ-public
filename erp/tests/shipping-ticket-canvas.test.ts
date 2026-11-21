import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import {
  drawnText, pageCount, paintedImageCounts, strokedLines, textLinesWithY, textRunsWithY, tinyAlphaPng,
} from "./helpers/pdf";
import { runWithContext } from "@/server/context";
import { createOrder, type OrderDetail } from "@/server/orders";
import { addOrderToShipper, createShipper, printShippingTickets, replaceShipperLines } from "@/server/shippers";
import { createTemplate, editDraft, publishDraft, uploadLogo } from "@/server/templates";
import { assignTemplate } from "@/server/template-assignments";
import {
  pngDataUri, renderSheetGroups, renderSheetGroupsWithPositions, type LaidOutNode, type RenderableDefinition,
} from "@/server/pdf/render";
import {
  buildShippingTicketDefinition, buildShippingTicketDefinitions, TICKET_FLOW, TICKET_SEED_IDS, ticketCanvasItemContent,
  type TicketData, type TicketDocType,
} from "@/server/pdf/shipping-ticket";
import { CANVAS_IDS } from "@/server/pdf/canvas-sheet";
import { PARTY_FIELDS, buildCanvasTicketDefinitions, completeTicketCanvas } from "@/server/shipping-ticket-canvas";
import {
  MOS_SHIPPER_DEFAULT_CONFIG, SHIPPER_DEFAULT_CONFIG, validateConfig, type TemplateConfig,
} from "@/lib/template-contracts/index";
import { canvasProfile, canvasRefusal, continuedBox } from "@/lib/template-canvas";
import { MOS_SHIPPER_CONTRACT } from "@/lib/template-contracts/mos-shipper";
import { SHIPPER_CONTRACT, TICKET_TOTALS_LEAST_WIDTH } from "@/lib/template-contracts/shipper";
import { CANVAS_GRID } from "@/lib/template-contracts/canvas";
import { ticketRecord } from "./helpers/keep-in-box-cases";
import type { CanvasItem, CanvasLayout } from "@/lib/template-contracts/canvas";
import { layoutOf, logo } from "./helpers/canvas-fixtures";
import { standardTicketLayout, ticketTable } from "./helpers/ticket-canvas-fixtures";
import { bandClipLayout, expectBandClip } from "./helpers/band-clip";
import type { Customer } from "../prisma/generated/prisma/client";

/**
 * The shipping ticket's canvas paper (PR 2a of the ticket lane, Task 3; design 2026-11-08 §4.2,
 * §4.4, §5.1, §5.2): positioned field items through the ticket's families, the five tables flowing
 * at their drawn places and widths through the flow's own builders, the strip riding the totals
 * block's rendered bottom, the repeat band and the page-bottom band, and the print path through
 * `printShippingTickets`. The pure cases render through `renderSheetGroupsWithPositions`; the last
 * describe block reads and writes the test database.
 *
 * COORDINATES. The positions `renderSheetGroupsWithPositions` answers, and the layout's boxes, are
 * PAGE coordinates: points from the page's top-left corner, y growing down. `strokedLines` is in
 * the same top-down frame. `textLinesWithY` and `textRunsWithY` report a BASELINE in PDF device
 * space, y from the page's BOTTOM edge; each case converts with `PAGE_HEIGHT − y`.
 */

const PAGE_HEIGHT = 792;

/** tests/shipping-ticket-templates.test.ts's ticket, with a stacked Sold To name (`attn`, R14), a
 *  gross (a tare each on its one container row), a flagged serial and the order shipped complete. */
function sampleTicket(overrides: Partial<TicketData> = {}): TicketData {
  return {
    company: {
      name: "Example Heat Treating - Alabama,", address: "1201 Front St", phone: "(256) 555-0100",
      liabilityText: "FIRST LIABILITY PARAGRAPH.\n\nSECOND LIABILITY PARAGRAPH.",
    },
    soldTo: {
      code: "9054", attn: "Accounts payable", name: "Demo Components Corporation", street: "300 Example Way",
      city: "Anniston", state: "AL", zip: "36201",
    },
    shipTo: { code: "", attn: "", name: "Example Coating", street: "88 Dock Rd.", city: "Oxford", state: "AL", zip: "36203" },
    orderLabel: "92036-3", orderNumber: 92036, shipDate: "2026-07-29",
    poNumber: "DEMO-PO-24115", packingListNo: 92826, customerJobNo: "JOB-9", route: "South", carrierName: "Customer",
    lines: [{ qty: 192, partNumber: "DEMO01-HT", partName: "Track Shoe, Vehicular", partDescription: "D-001", pounds: 4128 }],
    containers: [{ typeName: "Bin", count: 3, customerContainerId: "DEMO-COMP-77", tareEach: 42.5 }],
    serials: [{ serial: "SN-0001", description: "Heat A1" }],
    shippedComplete: true, totalQty: 192,
    ...overrides,
  };
}

const cfg = (layout: CanvasLayout | null, over: Partial<TemplateConfig> = {}): TemplateConfig =>
  ({ ...structuredClone(SHIPPER_DEFAULT_CONFIG), layout, ...over });

async function render(tickets: TicketData[], config: TemplateConfig, docType: TicketDocType = "SHIPPER") {
  const defs = buildShippingTicketDefinitions(tickets, docType, config);
  const { pdf, groups } = await renderSheetGroupsWithPositions(defs);
  return { pdf, defs, group: groups[0], groups };
}

/** The laid-out node under an id, which the case requires. */
function at(group: { positions: LaidOutNode[] }, id: string): LaidOutNode {
  const found = group.positions.find((node) => node.id === id);
  if (found === undefined) throw new Error(`no laid-out node "${id}"`);
  return found;
}

/** A layout's item with this id, replaced. */
function withItem(layout: CanvasLayout, id: string, change: (item: CanvasItem) => CanvasItem): CanvasLayout {
  return layoutOf(layout.items.map((item) => (item.id === id ? change(item) : item)));
}

/** The printed lines of a page, each with its baseline in page coordinates (top-down). */
const linesOn = (pdf: Buffer, page: number) =>
  textLinesWithY(pdf)[page - 1].map((line) => ({ text: line.text, top: PAGE_HEIGHT - line.y }));

/** The one printed line holding `needle` (on page 1 unless said), which the case requires. */
function lineWith(pdf: Buffer, needle: string, page = 1, not?: string) {
  const found = linesOn(pdf, page).filter((l) => l.text.includes(needle) && (not === undefined || !l.text.includes(not)));
  expect(found, `one line holding "${needle}"`).toHaveLength(1);
  return found[0];
}

/** Every node of a definition, depth first. */
function nodesOf(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) { for (const n of node) nodesOf(n, out); return out; }
  out.push(node as Record<string, unknown>);
  for (const value of Object.values(node as Record<string, unknown>)) nodesOf(value, out);
  return out;
}
const idsOf = (def: unknown) => nodesOf(def).map((n) => n.id).filter((id): id is string => typeof id === "string");

const TABLES = ["field_strip", "lines", "containers", "serials", "totals"] as const;

describe("the party boxes", () => {
  it("the fields the paper prints as a bordered party box are the ones each ticket's profile boxes (the designer draws its border from the profile)", () => {
    expect([...PARTY_FIELDS]).toEqual(canvasProfile(SHIPPER_CONTRACT).boxedFields);
    expect([...PARTY_FIELDS]).toEqual(canvasProfile(MOS_SHIPPER_CONTRACT).boxedFields);
  });
});

describe("buildCanvasTicketDefinitions: items, tables, regions", () => {
  it("prints every page-top field at its drawn position and each of the five tables at its drawn top, in y order; the strip rides the totals block's rendered bottom", async () => {
    // A table is as tall as its rows need, so first fit each table's drawn height to what it printed
    // and restack the tables under it at their drawn gaps (the items below a table keep their offsets).
    const standard = standardTicketLayout();
    const first = await render([sampleTicket()], cfg(standard));
    const drawnOf = (layout: CanvasLayout, key: string) =>
      layout.items.find((item) => item.kind === "table" && item.key === key)!.box;
    let fitted = standard;
    let top = drawnOf(standard, "field_strip").y;
    for (const [i, key] of TABLES.entries()) {
      const start = i === 0 ? top : at(first.group, CANVAS_IDS.regionEnd(TABLES[i - 1])).top;
      const h = at(first.group, CANVAS_IDS.end(key)).top - start;
      if (i > 0) {
        const above = drawnOf(standard, TABLES[i - 1]);
        top += drawnOf(fitted, TABLES[i - 1]).h + (drawnOf(standard, key).y - above.y - above.h);
      }
      const y = top;
      fitted = withItem(fitted, `table-${key}`, (item) => ({ ...item, box: { ...item.box, y, h } }));
    }
    const { pdf, group } = await render([sampleTicket()], cfg(fitted));
    expect(pageCount(pdf)).toBe(1);
    let previous = -Infinity;
    for (const [i, key] of TABLES.entries()) {
      const drawn = fitted.items.find((item) => item.kind === "table" && item.key === key)!.box;
      const start = i === 0 ? drawn.y : at(group, CANVAS_IDS.regionEnd(TABLES[i - 1])).top;
      expect(Math.abs(start - drawn.y)).toBeLessThan(2);
      // The block's own node reports its first laid-out line: under a boxed or ruled table's top rule
      // and padding, under the totals banner's 2 pt margin, at the serial list's heading.
      const own = at(group, CANVAS_IDS.table(key));
      expect(own.page).toBe(1);
      expect(own.top - drawn.y).toBeGreaterThan(-2);
      expect(own.top - drawn.y).toBeLessThan(4);
      expect(own.top).toBeGreaterThan(previous);
      previous = own.top;
    }
    // Every page-top text field: its wrapper exactly at its box's top-left; the two party boxes'
    // wrappers report their first line, inside the boxed rule (0.8), padding (2) and margin (1).
    for (const item of fitted.items) {
      if (item.kind !== "field" || item.anchor.kind !== "page-top") continue;
      const node = at(group, CANVAS_IDS.item(item.id));
      expect(node.page).toBe(1);
      if (item.key === "sold_to" || item.key === "ship_to") {
        expect(node.top - item.box.y).toBeGreaterThan(0);
        expect(node.top - item.box.y).toBeLessThanOrEqual(4);
      } else {
        expect(node).toMatchObject({ left: item.box.x, top: item.box.y });
      }
    }
    // The header's lines: each baseline under its box's top and above the item's end mark.
    for (const [id, needle] of [["field-order_no", "Order No.: 92036-3"], ["field-ship_date", "Ship Date: 7/29/2026"]] as const) {
      const box = fitted.items.find((item) => item.id === id)!.box;
      const line = lineWith(pdf, needle);
      expect(line.top).toBeGreaterThan(box.y);
      expect(line.top).toBeLessThan(at(group, CANVAS_IDS.itemEnd(id)).top);
    }
    // The strip: each line's baseline inside its item's box placed at the totals block's rendered
    // bottom (its `end` mark) plus the item's stored offset.
    const totalsEnd = at(group, CANVAS_IDS.end("totals")).top;
    for (const [id, needle, not] of [
      ["field-tear_order_no", "Order No.: 92036", "92036-3"],
      ["field-received_by", "Received By: _______________________", undefined],
      ["field-tear_sold_to", "Sold To: Demo Components Corporation", undefined],
    ] as const) {
      const box = fitted.items.find((item) => item.id === id)!.box;
      const line = lineWith(pdf, needle, 1, not);
      expect(line.top).toBeGreaterThan(totalsEnd + box.y);
      expect(line.top).toBeLessThan(totalsEnd + box.y + box.h);
    }
  });

  it("the containers table drawn { x: 24, w: 400 } prints its outer rules at 24 and 424, each copy's columns inside its 200 pt half, and no rule past 424", async () => {
    // Two narrow fixed columns, so the two "*" columns of each copy have room for their headings'
    // widest word: pdfmake widens a "*" column to its widest word, past the table's width.
    const layout = withItem(standardTicketLayout(), "table-containers", (item) => item.kind !== "table" ? item : {
      ...item, box: { ...item.box, w: 400 },
      columns: item.columns.map((column) =>
        (column.key === "container_type" || column.key === "cust_cont_id" ? { ...column, width: 36 } : column)),
    });
    const ticket = sampleTicket({
      containers: [
        { typeName: "Bin", count: 3, customerContainerId: "CC-7", tareEach: 42.5 },
        { typeName: "Pan", count: 2, customerContainerId: "CC-8", tareEach: 30 },
      ],
    });
    const { pdf, group } = await render([ticket], cfg(layout));
    const top = at(group, CANVAS_IDS.table("containers")).top - 3;
    const end = at(group, CANVAS_IDS.end("containers")).top + 0.5;
    // `LAYOUT.ruled` strokes horizontal rules only, one segment a cell.
    const rules = strokedLines(pdf)[0].filter((s) => s.y1 === s.y2 && s.y1 >= top && s.y1 <= end);
    expect(rules.length).toBeGreaterThan(8);
    expect(Math.abs(Math.min(...rules.map((s) => s.x1)) - 24)).toBeLessThan(1);
    expect(Math.abs(Math.max(...rules.map((s) => s.x2)) - 424)).toBeLessThan(1);
    expect(rules.filter((s) => Math.max(s.x1, s.x2) > 425)).toEqual([]);
    // The fold: every cell's segment lies in one half, the halves meeting at 224.
    for (const s of rules) {
      const inLeft = s.x1 >= 23 && s.x2 <= 225;
      const inRight = s.x1 >= 223 && s.x2 <= 425;
      expect(inLeft || inRight).toBe(true);
    }
    expect(rules.some((s) => Math.abs(s.x2 - 224) < 1)).toBe(true);
    expect(rules.some((s) => Math.abs(s.x1 - 224) < 1)).toBe(true);
  });

  it("the two date styles: with dateFormat YYYY-MM-DD the header prints Ship Date: 2026-07-29 and the strip Shipped ON: 07/29/2026", async () => {
    const config = cfg(standardTicketLayout());
    config.formats = { ...config.formats, dateFormat: "YYYY-MM-DD" };
    const { pdf } = await render([sampleTicket()], validateConfig("SHIPPER", config));
    expect(lineWith(pdf, "Ship Date:").text).toBe("Ship Date: 2026-07-29");
    expect(lineWith(pdf, "Shipped ON:").text).toContain("Shipped ON: 07/29/2026");
    expect(drawnText(pdf)).not.toContain("Shipped ON: 2026-07-29");
  });

  it("every weight carries its unit and the Tare cell its each line; the Sold To box prints attn above the name, the strip's Sold To line the name alone", async () => {
    const { pdf } = await render([sampleTicket()], cfg(standardTicketLayout()));
    const text = drawnText(pdf);
    for (const figure of ["4,128 lb", "127.5 lb", "42.5 lb each", "4,128.00 lb", "127.50 lb", "4,255.50 lb"]) {
      expect(text).toContain(figure);
    }
    // The strip's pair: Net weight with its figure and unit (W16: never tare or gross).
    expect(lineWith(pdf, "Net weight:4,128.00 lb").text).toBe("Net weight:4,128.00 lb");
    const attn = lineWith(pdf, "Accounts payable");
    const name = lineWith(pdf, "Demo Components Corporation", 1, "Sold To:");
    expect(attn.top).toBeLessThan(name.top);
    expect(lineWith(pdf, "Sold To: Demo Components Corporation").text).not.toContain("Accounts payable");
    expect(text).not.toContain("Sold To: Accounts payable");
  });

  it("a ticket with no gross prints no Tare and no Gross weight row: the totals block is exactly two rows shorter and the strip sits higher by the same distance", async () => {
    const layout = standardTicketLayout();
    // Two container rows on each ticket (one row of the fold), so the containers table is the same
    // height: a tare each on both gives a gross, one row without gives none.
    const gross = sampleTicket({
      containers: [
        { typeName: "Bin", count: 3, customerContainerId: "CC-7", tareEach: 42.5 },
        { typeName: "Pan", count: 2, customerContainerId: "CC-8", tareEach: 30 },
      ],
    });
    const none = sampleTicket({
      containers: [
        { typeName: "Bin", count: 3, customerContainerId: "CC-7", tareEach: 42.5 },
        { typeName: "Pan", count: 2, customerContainerId: "CC-8", tareEach: null },
      ],
    });
    const a = await render([gross], cfg(layout));
    const b = await render([none], cfg(layout));
    expect(drawnText(a.pdf)).toContain("Gross weight:");
    expect(drawnText(b.pdf)).not.toContain("Gross weight:");
    expect(drawnText(b.pdf)).not.toContain("Tare:");
    // Nothing above the totals block moves.
    expect(at(b.group, CANVAS_IDS.table("totals")).top).toBeCloseTo(at(a.group, CANVAS_IDS.table("totals")).top, 6);
    const height = (r: typeof a) => at(r.group, CANVAS_IDS.end("totals")).top - at(r.group, CANVAS_IDS.table("totals")).top;
    // One row: the baseline gap between the Tare and Gross weight rows on the gross render (the runs'
    // own baselines, unrounded).
    const runTop = (pdf: Buffer, word: string) => PAGE_HEIGHT - textRunsWithY(pdf)[0].find((r) => r.text.startsWith(word))!.y;
    const row = runTop(a.pdf, "Gross") - runTop(a.pdf, "Tare:");
    expect(row).toBeGreaterThan(10);
    const difference = height(a) - height(b);
    expect(difference).toBeCloseTo(2 * row, 3);
    const strip = (pdf: Buffer) => PAGE_HEIGHT - textRunsWithY(pdf)[0].find((r) => r.text.startsWith("Received"))!.y;
    expect(strip(a.pdf) - strip(b.pdf)).toBeCloseTo(difference, 3);
  });

  it("a ticket with no flagged serial prints no serial list and what follows rides up by the list's rendered height; one not shipped complete prints neither banner", async () => {
    const layout = standardTicketLayout();
    const listed = await render([sampleTicket()], cfg(layout));
    const bare = await render([sampleTicket({ serials: [], shippedComplete: false })], cfg(layout));
    expect(drawnText(bare.pdf)).not.toContain("Serial Numbers:");
    expect(drawnText(bare.pdf)).not.toContain("Shipped Complete");
    expect(drawnText(listed.pdf).match(/Shipped Complete/g)).toHaveLength(2);
    // The list printed no block, so its end mark is at its start; its marks and region are kept.
    const start = at(bare.group, CANVAS_IDS.regionEnd("containers")).top;
    expect(at(bare.group, CANVAS_IDS.end("serials")).top).toBeCloseTo(start, 6);
    const listHeight = at(listed.group, CANVAS_IDS.end("serials")).top - at(listed.group, CANVAS_IDS.regionEnd("containers")).top;
    expect(listHeight).toBeGreaterThan(10);
    expect(at(listed.group, CANVAS_IDS.regionEnd("serials")).top - at(bare.group, CANVAS_IDS.regionEnd("serials")).top)
      .toBeCloseTo(listHeight, 6);
    // The totals block starts where the serial list's region ends; the bare ticket's is one banner
    // row shorter (it is not shipped complete).
    const totalsHeight = (r: typeof listed) =>
      at(r.group, CANVAS_IDS.end("totals")).top - at(r.group, CANVAS_IDS.regionEnd("serials")).top;
    const banner = totalsHeight(listed) - totalsHeight(bare);
    expect(banner).toBeGreaterThan(10);
    // The strip (its Received By line) rides up by the list's height and the banner row's.
    const strip = (pdf: Buffer) => PAGE_HEIGHT - textRunsWithY(pdf)[0].find((r) => r.text.startsWith("Received"))!.y;
    expect(Math.abs(strip(listed.pdf) - strip(bare.pdf) - (listHeight + banner))).toBeLessThan(1);
  });

  it("the text block prints the config's two paragraphs at the item's size, wrapped inside its box: a 200 pt box wraps where a 564 pt one does not", async () => {
    const first = "FIRST PARAGRAPH of the liability wording, long enough to wrap in a narrow box at five and a half points.";
    const second = "SECOND PARAGRAPH, shorter.";
    const textBlocks = { shipper_liability_text: `${first}\n\n${second}` };
    const sized = (w: number, size: number) => withItem(standardTicketLayout(), "text-block-shipper_liability_text",
      (item) => item.kind !== "textBlock" ? item : { ...item, box: { ...item.box, w }, style: { ...item.style, size } });
    const blockLines = (pdf: Buffer) => textRunsWithY(pdf)[0]
      .filter((run) => /PARAGRAPH|liability|wrap|box|points|shorter/.test(run.text))
      .reduce((ys, run) => ys.add(Math.round(run.y * 2) / 2), new Set<number>());

    const wide = await render([sampleTicket()], cfg(sized(564, 5.5), { textBlocks }));
    const wideLines = linesOn(wide.pdf, 1).filter((l) => l.text.includes("PARAGRAPH"));
    expect(wideLines.map((l) => l.text)).toEqual([first, second]);
    // Not the data's text: the canvas prints the config's Wording text.
    expect(drawnText(wide.pdf)).not.toContain("FIRST LIABILITY PARAGRAPH.");

    const narrow = await render([sampleTicket()], cfg(sized(200, 5.5), { textBlocks }));
    expect(blockLines(narrow.pdf).size).toBeGreaterThan(2);
    for (const run of textRunsWithY(narrow.pdf)[0].filter((r) => /PARAGRAPH/.test(r.text))) {
      expect(run.x).toBeGreaterThanOrEqual(24);
      expect(run.x).toBeLessThan(224);
    }
    // The item's size: the gap between the two paragraphs' baselines (the runs' own, unrounded), less
    // the 4 pt under the first, doubles with the size.
    const gap = (pdf: Buffer) => {
      const runs = textRunsWithY(pdf)[0];
      const y = (word: string) => runs.find((r) => r.text.trim() === word)!.y;
      return y("FIRST") - y("SECOND") - 4;
    };
    const big = await render([sampleTicket()], cfg(sized(564, 11), { textBlocks }));
    const bigLines = linesOn(big.pdf, 1).filter((l) => l.text.startsWith("FIRST PARAGRAPH") || l.text.startsWith("SECOND PARAGRAPH"));
    expect(bigLines.map((l) => l.text)).toEqual([first, second]);
    expect(gap(big.pdf) / gap(wide.pdf)).toBeCloseTo(2, 3);
  });

  it("forty part lines: the containers table starts page 2, which alone repeats the order number with (continued) at the band's bottom-left; with the strip anchored page-bottom it prints on page 2 alone and page 1 stops above the band", async () => {
    const forty = Array.from({ length: 40 }, (_, i) => ({
      // Every other line one printed line, the rest two: the part lines overflow page 1, and with the
      // strip in the band (which every page reserves) what follows them still fits page 2.
      qty: i + 1, partNumber: `DEMO-${i}`, partName: i % 2 === 0 ? "Ring gear" : "", partDescription: "", pounds: 10 + i,
    }));
    const ticket = sampleTicket({ lines: forty, totalQty: 820 });
    const layout = standardTicketLayout();
    const { pdf, group } = await render([ticket], cfg(layout));
    expect(pageCount(pdf)).toBe(2);
    expect(at(group, CANVAS_IDS.table("containers")).page).toBe(2);
    for (const page of [1, 2]) {
      expect(linesOn(pdf, page).filter((l) => l.text.includes("Order No.: 92036-3"))).toHaveLength(1);
    }
    expect(linesOn(pdf, 1).some((l) => l.text.includes("(continued)"))).toBe(false);
    const continued = linesOn(pdf, 2).filter((l) => l.text.includes("(continued)"));
    expect(continued).toHaveLength(1);
    const box = continuedBox(layout)!;
    const run = textRunsWithY(pdf)[1].find((r) => r.text.includes("continued"))!;
    expect(run.x).toBeCloseTo(box.x, 0);
    expect(continued[0].top).toBeGreaterThan(box.y);
    expect(continued[0].top).toBeLessThan(box.y + box.h);

    // The strip's items (drawn 6..80 below totals) re-anchored page-bottom at the page's foot.
    const FOOT = 768;
    const strip = new Set(layout.items
      .filter((item) => item.kind !== "table" && item.anchor.kind === "below-table" && item.anchor.table === "totals")
      .map((item) => item.id));
    const pinned = layoutOf(layout.items.map((item) => (item.kind === "table" || !strip.has(item.id) ? item
      : { ...item, anchor: { kind: "page-bottom" }, box: { ...item.box, y: FOOT - 80 + item.box.y } })));
    const bandTop = Math.min(...pinned.items.filter((item) => strip.has(item.id)).map((item) => item.box.y));
    const banded = await render([ticket], validateConfig("SHIPPER", cfg(pinned)));
    expect(pageCount(banded.pdf)).toBe(2);
    for (const needle of ["Received By:", "Shipped ON:"]) {
      expect(linesOn(banded.pdf, 1).some((l) => l.text.includes(needle))).toBe(false);
      const line = lineWith(banded.pdf, needle, 2);
      expect(line.top).toBeGreaterThan(bandTop);
    }
    expect(Math.max(...linesOn(banded.pdf, 1).map((l) => l.top))).toBeLessThan(bandTop);
  });

  it("a page-bottom Text item whose words run past the band's foot is cut at the band's bottom edge, whole lines, with the page line off and on (#978)", async () => {
    // Red when the band's footer frame is not ended at the band's bottom edge (render.ts's
    // `installBandFrame` wrapper): the item's overflow then prints below the edge, in the page's
    // bottom margin, and with the page line on over and under it. SHIPPER alone: MOS_SHIPPER prints
    // through the same builder and band.
    for (const pageFooter of [false, true]) {
      const layout = bandClipLayout(standardTicketLayout(), pageFooter);
      expect(canvasRefusal(layout, SHIPPER_CONTRACT, { pageFooter }), `page line ${pageFooter}`).toBeNull();
      const { pdf } = await render([sampleTicket()], validateConfig("SHIPPER", cfg(layout, { pageFooter })));
      expect(pageCount(pdf), `page line ${pageFooter}`).toBe(1);
      expectBandClip(pdf, pageFooter);
    }
  });

  describe("a totals block drawn narrower than the content that breaks across a page (#969)", () => {
    // The probe's record (#969 plan, Task 6): the containers table first, then the totals block, then
    // the part lines and the serial list, so 110 container rows push the totals block across the
    // page's foot and the part lines print after its break.
    const probeTicket = (nLines: number, nContainers: number, order: number): TicketData => ({
      company: { name: "Example Heat Treating", address: "1201 Front St", phone: "(256) 555-0100", liabilityText: "LIABILITY ONE.\n\nLIABILITY TWO." },
      soldTo: { code: "9054", attn: "", name: "Demo Components Corporation", street: "300 Example Way", city: "Anniston", state: "AL", zip: "36201" },
      shipTo: { code: "", attn: "", name: "Example Coating", street: "88 Dock Rd.", city: "Oxford", state: "AL", zip: "36203" },
      orderLabel: `${order}-1`, orderNumber: order, shipDate: "2026-07-29",
      poNumber: "PO-1", packingListNo: 1, customerJobNo: "JOB-9", route: "South", carrierName: "Customer",
      lines: Array.from({ length: nLines }, (_, i) => ({
        qty: 1000 + i, partNumber: `PART-${i}`, partName: "Track Shoe, Vehicular", partDescription: `DESC-${i}`, pounds: 4128 + i,
      })),
      containers: Array.from({ length: nContainers }, (_, i) => ({ typeName: `Bin${i}`, count: 3, customerContainerId: `CC-${i}`, tareEach: 42.5 })),
      serials: [{ serial: "SN-0001", description: "Heat A1" }],
      shippedComplete: true, totalQty: 1,
    });
    const withSerials = (t: TicketData, n: number): TicketData => ({
      ...t,
      serials: Array.from({ length: n }, (_, i) => ({ serial: `SN-${String(i).padStart(4, "0")}`, description: `Heat lot description number ${i} for the long serial list` })),
    });
    const RECORD = (): TicketData[] => [withSerials(probeTicket(3, 110, 92036), 6), probeTicket(2, 2, 92037)];
    /** The standard layout restacked: containers, totals, lines, then the serial list. */
    const reordered = (): CanvasLayout => {
      const std = standardTicketLayout();
      const below = (table: "field_strip" | "containers" | "totals" | "lines") => ({ kind: "below-table" as const, table });
      const serialsH = std.items.find((item) => item.kind === "table" && item.key === "serials")!.box.h;
      const moved: Record<string, CanvasItem> = {
        containers: ticketTable("containers", { box: { x: 24, y: 172, w: 564, h: 30 }, anchor: below("field_strip") }),
        totals: ticketTable("totals", { box: { x: 24, y: 208, w: 564, h: 80 }, anchor: below("containers") }),
        lines: ticketTable("lines", { box: { x: 24, y: 376, w: 564, h: 30 }, anchor: below("totals") }),
        serials: ticketTable("serials", { box: { x: 24, y: 412, w: 564, h: serialsH }, anchor: below("lines") }),
      };
      return layoutOf(std.items.map((item) => (item.kind === "table" && moved[item.key] ? moved[item.key] : item)));
    };
    /** `base` with its totals block drawn 40 pt in on each side. */
    const narrowTotals = (base: CanvasLayout): CanvasLayout => layoutOf(base.items.map((item) =>
      item.kind === "table" && item.key === "totals" ? { ...item, box: { ...item.box, x: item.box.x + 40, w: item.box.w - 80 } } : item));
    const configFor = (docType: TicketDocType, layout: CanvasLayout, pageFooter: boolean): TemplateConfig => ({
      ...structuredClone(docType === "SHIPPER" ? SHIPPER_DEFAULT_CONFIG : MOS_SHIPPER_DEFAULT_CONFIG), layout, pageFooter,
    });
    const RIGHT_MARGIN = 588;
    /** No non-blank run starts past the right margin, and no stroke ends past it by more than 0.5. */
    const insideTheMargin = (pdf: Buffer) => {
      const pastRuns = textRunsWithY(pdf).flatMap((runs, p) =>
        runs.filter((r) => r.text.trim() !== "" && r.x > RIGHT_MARGIN).map((r) => `${p + 1}:${r.text.trim()}@${r.x.toFixed(2)}`));
      expect(pastRuns).toEqual([]);
      const pastStrokes = strokedLines(pdf).flatMap((lines, p) =>
        lines.filter((s) => Math.max(s.x1, s.x2) > RIGHT_MARGIN + 0.5)
          .map((s) => `${p + 1}:${Math.min(s.x1, s.x2).toFixed(1)}..${Math.max(s.x1, s.x2).toFixed(1)}`));
      expect(pastStrokes).toEqual([]);
    };
    /** The non-blank runs printed from a table's id to its end mark, by page and top, as
     *  [page, text, x]. */
    const runsIn = (r: Awaited<ReturnType<typeof render>>, key: "lines" | "totals") => {
      const from = at(r.group, CANVAS_IDS.table(key));
      const to = at(r.group, CANVAS_IDS.end(key));
      const inside = (page: number, top: number) =>
        (page > from.page || (page === from.page && top >= from.top)) && (page < to.page || (page === to.page && top <= to.top));
      return textRunsWithY(r.pdf).flatMap((runs, p) => runs
        .filter((run) => run.text.trim() !== "" && inside(p + 1, PAGE_HEIGHT - run.y))
        .map((run) => [p + 1, run.text.trim(), run.x] as const));
    };
    /** The part lines' "Net" heading runs, as [page, x] (the totals block's own "Net" row and the
     *  strip's stand outside the lines table). */
    const linesNet = (r: Awaited<ReturnType<typeof render>>) =>
      runsIn(r, "lines").filter(([, text]) => text === "Net").map(([page, , x]) => [page, x] as const);
    const CASES = (["SHIPPER", "MOS_SHIPPER"] as const).flatMap((docType) => [false, true].map((pageFooter) => ({ docType, pageFooter })));

    it.each(CASES)("a totals block drawn 40 pt in that breaks across a page leaves the lines table after it its width ($docType, page line $pageFooter)", async ({ docType, pageFooter }) => {
      const contract = docType === "SHIPPER" ? SHIPPER_CONTRACT : MOS_SHIPPER_CONTRACT;
      const fullLayout = reordered();
      const narrowLayout = narrowTotals(reordered());
      expect(canvasRefusal(fullLayout, contract, { pageFooter })).toBeNull();
      expect(canvasRefusal(narrowLayout, contract, { pageFooter })).toBeNull();
      const full = await render(RECORD(), configFor(docType, fullLayout, pageFooter), docType);
      const narrow = await render(RECORD(), configFor(docType, narrowLayout, pageFooter), docType);
      // The premise: the narrowed totals block breaks across a page, its first row (Quantity) on the
      // page it starts on and its last (Gross weight) on the page it ends on. A block moved whole
      // would print both on the later page while its id still stood on the earlier one.
      const totalsFrom = at(narrow.group, CANVAS_IDS.table("totals")).page;
      const totalsTo = at(narrow.group, CANVAS_IDS.end("totals")).page;
      expect(totalsTo, "the totals block breaks across a page").toBeGreaterThan(totalsFrom);
      const pageOf = (text: string) => runsIn(narrow, "totals").filter(([, t]) => t === text).map(([page]) => page);
      expect(pageOf("Quantity"), "the totals' first row").toEqual([totalsFrom]);
      expect(pageOf("Gross"), "the totals' last row").toEqual([totalsTo]);
      insideTheMargin(full.pdf);
      insideTheMargin(narrow.pdf);
      // The part lines' Net heading at the full-width control's one x, on every page the table takes.
      const controlXs = [...new Set(linesNet(full).map(([, x]) => Math.round(x * 100) / 100))];
      expect(controlXs, "the control's lines Net x").toHaveLength(1);
      if (docType === "SHIPPER") expect(controlXs[0]).toBeCloseTo(519.74, 1);
      const nets = linesNet(narrow);
      const from = at(narrow.group, CANVAS_IDS.table("lines")).page;
      const to = at(narrow.group, CANVAS_IDS.end("lines")).page;
      for (let page = from; page <= to; page++) expect(nets.some(([p]) => p === page), `a lines Net heading on page ${page}`).toBe(true);
      for (const [p, x] of nets) expect(Math.abs(x - controlXs[0]), `lines Net on page ${p} at ${x.toFixed(2)}`).toBeLessThan(0.5);
    }, 60_000);
  });

  it("the definitions are pure JSON, one per ticket, with no ticket-totals or ticket-tear-off id and no unbreakable on the totals block, a typed Totals label included", async () => {
    const layout = withItem(standardTicketLayout(), "table-totals", (item) => item.kind !== "table" ? item : {
      ...item, columns: item.columns.map((column) => (column.key === "total_qty" ? { ...column, label: "Pieces:" } : column)),
    });
    // The control: the flow, under the same typed label, marks its totals for #673's measure.
    const flowConfig = structuredClone(SHIPPER_DEFAULT_CONFIG);
    flowConfig.sections.find((s) => s.key === "totals")!.fields.find((f) => f.key === "total_qty")!.label = "Pieces:";
    expect(idsOf(buildShippingTicketDefinitions([sampleTicket()], "SHIPPER", flowConfig))).toContain("ticket-totals");

    const defs = buildShippingTicketDefinitions([sampleTicket(), sampleTicket({ orderLabel: "92037-1", orderNumber: 92037 })],
      "SHIPPER", cfg(layout));
    expect(defs).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(defs))).toEqual(defs);
    for (const def of defs) {
      const ids = idsOf(def);
      expect(ids).not.toContain("ticket-totals");
      expect(ids).not.toContain("ticket-tear-off");
      const totals = nodesOf(def).filter((n) => n.id === CANVAS_IDS.table("totals"));
      expect(totals).toHaveLength(1);
      // The wrapper never carries the mark: walk the block, the flow's own node included.
      expect(nodesOf(totals[0]).some((n) => n.unbreakable !== undefined)).toBe(false);
    }
    const { pdf } = await renderSheetGroupsWithPositions(defs);
    expect(drawnText(pdf)).toContain("Pieces:");
    expect(completeTicketCanvas(layout)).toBe(layout);
  });

  it("a template with layout null builds the flow's definitions, which hold no canvas id, and the legacy builder refuses a canvas", () => {
    const tickets = [sampleTicket(), sampleTicket({ orderLabel: "92037-1", orderNumber: 92037, serials: [] })];
    const defs = buildShippingTicketDefinitions(tickets, "SHIPPER", cfg(null));
    expect(defs).toHaveLength(2);
    for (const def of defs) {
      expect(idsOf(def).filter((id) => id.startsWith("canvas:"))).toEqual([]);
      expect(JSON.stringify(def)).toContain("Purchase Order Number");
    }

    expect(() => buildShippingTicketDefinition(tickets, "SHIPPER", cfg(standardTicketLayout())))
      .toThrow("A canvas ticket prints per sheet group: use buildShippingTicketDefinitions");
  });

  it("a ticket table block is one node: a flow builder answering two for a table is refused, naming the table", () => {
    const two = { ...TICKET_FLOW, linesTable: () => [{ text: "a" }, { text: "b" }] } as unknown as typeof TICKET_FLOW;
    expect(() => buildCanvasTicketDefinitions([sampleTicket()], "SHIPPER", cfg(standardTicketLayout()), standardTicketLayout(), two))
      .toThrow("A ticket table block answers one node; lines answered 2.");
  });

  it("ticketCanvasItemContent answers the FIRST ticket's item node and refuses a config with no layout", () => {
    expect(() => ticketCanvasItemContent([sampleTicket()], "SHIPPER", cfg(null))).toThrow("ticketCanvasItemContent needs a canvas config.");
    const layout = standardTicketLayout();
    const itemContent = ticketCanvasItemContent(
      [sampleTicket(), sampleTicket({ orderLabel: "92037-1", orderNumber: 92037 })], "SHIPPER", cfg(layout));
    const node = itemContent(layout.items.find((item) => item.id === "field-order_no")!);
    const texts = nodesOf(node).map((n) => n.text).filter((t): t is string => typeof t === "string");
    expect(texts).toEqual(["Order No.: 92036-3"]);
  });

  it("the folded containers table prints its heading row in both copies (Ruling 19: the sheet lays out a copy of each table's block)", async () => {
    const { pdf } = await render([sampleTicket()], cfg(standardTicketLayout()));
    expect(linesOn(pdf, 1).filter((l) => l.text.split("Container Type").length - 1 === 2)).toHaveLength(1);
  });

  it("an empty canvas (design §4.3) on a two-order MOS shipment prints one blank page per ticket", async () => {
    const config = validateConfig("MOS_SHIPPER", { ...structuredClone(MOS_SHIPPER_DEFAULT_CONFIG), layout: layoutOf([]) });
    const tickets = [sampleTicket(), sampleTicket({ orderLabel: "92037-1", orderNumber: 92037 })];
    const { pdf, defs } = await render(tickets, config, "MOS_SHIPPER");
    expect(defs).toHaveLength(2);
    expect(pageCount(pdf)).toBe(2);
    expect(textLinesWithY(pdf)).toEqual([[], []]);
  });

  it("a print's definition carries no seed id and no placeholder line; under the seed's options every piece is marked and the paper is the same", async () => {
    const plain = buildShippingTicketDefinitions([sampleTicket({ serials: [] })]);
    expect(idsOf(plain).filter((id) => id.startsWith("seed:"))).toEqual([]);
    expect(nodesOf(plain).some((n) => n.text === " ")).toBe(false);
    expect(nodesOf(plain).some((n) => n.text === "Serial Numbers:")).toBe(false);

    const placed: TemplateConfig = { ...structuredClone(SHIPPER_DEFAULT_CONFIG), logo: { placement: "header-left", width: 60 } };
    const LOGO = pngDataUri(tinyAlphaPng());
    const seeded = buildShippingTicketDefinitions([sampleTicket()], "SHIPPER", placed, LOGO, { seedIds: true });
    const ids = idsOf(seeded);
    for (const key of [
      "logo", "company_name", "title", "order_no", "ship_date", "company_address", "company_phone", "sold_to", "ship_to",
      "shipped_complete", "total_qty", "total_weight", "total_tare", "total_gross", "shipper_liability_text", "liability_rule",
      "tear_off_rule", "tear_order_no", "tear_shipped_complete", "tear_total_qty", "tear_total_weight",
      "received_by", "received_date", "tear_sold_to", "shipped_on",
    ]) {
      expect(ids).toContain(TICKET_SEED_IDS.piece(key));
      expect(ids).toContain(TICKET_SEED_IDS.end(key));
    }
    for (const section of ["header", "parties", "field_strip", "lines", "containers", "serials", "liability", "totals", "tear_off"]) {
      expect(ids).toContain(TICKET_SEED_IDS.start(section));
      expect(ids).toContain(TICKET_SEED_IDS.sectionEnd(section));
    }
    // No id is on a text node.
    expect(nodesOf(seeded).filter((n) => typeof n.id === "string" && n.id.startsWith("seed:") && "text" in n)).toEqual([]);
    const seededPdf = await renderSheetGroups(seeded as RenderableDefinition[]);
    const plainPdf = await renderSheetGroups(buildShippingTicketDefinitions([sampleTicket()], "SHIPPER", placed, LOGO));
    expect(drawnText(seededPdf)).toBe(drawnText(plainPdf));

    // The placeholder: one blank serial line under the heading, and only under its option.
    const placeheld = buildShippingTicketDefinitions([sampleTicket({ serials: [] })], "SHIPPER", SHIPPER_DEFAULT_CONFIG, undefined,
      { seedPlaceholders: true });
    expect(nodesOf(placeheld).filter((n) => n.text === " ")).toHaveLength(1);
    expect(nodesOf(placeheld).some((n) => n.text === "Serial Numbers:")).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------
// The print path: a published canvas template with a Logo item and `config.logo` null.
// ------------------------------------------------------------------------------------------------

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

let seq = 0;
async function makeCustomer(): Promise<Customer> {
  seq += 1;
  return prisma.customer.create({ data: { code: `TC${seq}`, name: `Ticket Canvas Customer ${seq}` } });
}

async function makePart(customerId: string) {
  seq += 1;
  const part = await prisma.part.create({
    data: { customerId, partNumber: `TCP-${seq}`, name: `Canvas Part ${seq}`, description: "D-001", eachWeight: "21.5000" },
  });
  const code = await prisma.processStepCode.create({ data: { code: `TC-${part.id}`, name: "Austenitize" } });
  const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({
    data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Austenitize at 1650F." },
  });
  return part;
}

async function shipTo(customerId: string) {
  await prisma.customerAddress.create({
    data: {
      customerId, kind: "BILL_TO", name: "Accounts payable", street: "300 Example Way",
      city: "Anniston", state: "AL", zip: "36201", isDefault: true,
    },
  });
  return prisma.customerAddress.create({
    data: {
      customerId, kind: "SHIP_TO", name: "Demo Components Corporation", street: "300 Example Way",
      city: "Anniston", state: "AL", zip: "36201", isDefault: true,
    },
  });
}

async function orderFor(customer: Customer, poNumber: string): Promise<OrderDetail> {
  const part = await makePart(customer.id);
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, poNumber, customerJobNo: "JOB-9",
    lines: [{ partId: part.id, qty: 192, weight: "4128.00" }],
  }));
  return order;
}

async function shipment(customer: Customer, orders: number) {
  const address = await shipTo(customer.id);
  const placed: OrderDetail[] = [];
  for (let i = 0; i < orders; i++) placed.push(await orderFor(customer, `PO-${i}`));
  const { shipper } = await asSystem(() => createShipper({
    customerId: customer.id, shipDate: "2026-07-29", shipToAddressId: address.id, route: "South",
    orders: placed.map((order) => ({
      orderId: order.id,
      lines: [{ orderLineId: order.lines[0].id, qty: order.lines[0].qty, weight: order.lines[0].weight, lineComplete: true }],
      containers: [], serials: [],
    })),
  }, { canOverrideCreditHold: false }));
  return shipper;
}

/** `shipment`'s large form, built the way tests/print-claim-timing.test.ts's `ticketShipment` is: one
 *  part, an order each, `createShipper` with the first and `addOrderToShipper` + `replaceShipperLines`
 *  for the rest, every step its own small transaction (one Serializable save over 160 orders could
 *  expire on its own). */
async function bigShipment(customer: Customer, n: number) {
  const address = await shipTo(customer.id);
  const part = await makePart(customer.id);
  const placed: OrderDetail[] = [];
  for (let i = 0; i < n; i++) {
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, poNumber: `BIG-PO-${i + 1}`, customerJobNo: "JOB-9",
      lines: [{ partId: part.id, qty: 192, weight: "4128.00" }],
    }));
    placed.push(order);
  }
  const lineOf = (o: OrderDetail) => ({
    orderLineId: o.lines[0].id, qty: o.lines[0].qty, weight: o.lines[0].weight, lineComplete: true,
  });
  const { shipper } = await asSystem(() => createShipper({
    customerId: customer.id, shipDate: "2026-07-29", shipToAddressId: address.id, route: "South",
    orders: [{ orderId: placed[0].id, lines: [lineOf(placed[0])], containers: [], serials: [] }],
  }, { canOverrideCreditHold: false }));
  for (const order of placed.slice(1)) {
    const detail = await asSystem(() => addOrderToShipper(shipper.id, order.id));
    const so = detail.orders.find((o) => o.orderId === order.id)!;
    await asSystem(() => replaceShipperLines(shipper.id, so.id, [lineOf(order)]));
  }
  return shipper;
}

/** A published template of `docType` holding the standard ticket layout and a Logo item, with
 *  `config.logo` null, its version holding a 2×2 alpha PNG; assigned to the customer. */
async function canvasTemplate(docType: TicketDocType, customer: Customer) {
  const t = await asSystem(() => createTemplate(docType, `Canvas ${docType}`));
  const base = docType === "SHIPPER" ? SHIPPER_DEFAULT_CONFIG : MOS_SHIPPER_DEFAULT_CONFIG;
  const layout = layoutOf([...standardTicketLayout().items, logo({ box: { x: 284, y: 70, w: 44, h: 44 } })]);
  const config: TemplateConfig = { ...structuredClone(base), logo: null, layout };
  await asSystem(() => editDraft(t.id, { config, updatedAt: t.draft.updatedAt }));
  await asSystem(() => uploadLogo(t.id, tinyAlphaPng(), "image/png"));
  await asSystem(() => publishDraft(t.id));
  await asSystem(() => assignTemplate(customer.id, docType, t.id));
}

describe("printShippingTickets: a canvas template with a Logo item", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("paints the logo once per page with config.logo null, and a MOS two-order shipment prints two sheet groups", async () => {
    const customer = await makeCustomer();
    await canvasTemplate("SHIPPER", customer);
    await canvasTemplate("MOS_SHIPPER", customer);

    const single = await shipment(customer, 1);
    const one = await asSystem(() => printShippingTickets(single.id));
    const stored = await prisma.storedDocument.findUniqueOrThrow({ where: { id: one.documentId } });
    const bytes = Buffer.from(stored.fileData);
    expect(paintedImageCounts(bytes)).toEqual([1]);
    expect(drawnText(bytes)).toContain("Order No.: ");

    const multi = await shipment(customer, 2);
    const two = await asSystem(() => printShippingTickets(multi.id));
    const storedTwo = await prisma.storedDocument.findUniqueOrThrow({ where: { id: two.documentId } });
    const bytesTwo = Buffer.from(storedTwo.fileData);
    expect(pageCount(bytesTwo)).toBe(2);
    expect(paintedImageCounts(bytesTwo)).toEqual([1, 1]);
    // One ticket per order: each page names its own order once.
    const labels = textLinesWithY(bytesTwo).map((page) => page.filter((l) => /^Order No\.: \d+-\d+/.test(l.text)).length);
    expect(labels).toEqual([1, 1]);
  });

  // The canvas path's budget (ticket canvas design §5.4): a 160-order shipment printed on the flow
  // Standard, then under a published template holding the standard canvas layout. Runs only when asked:
  // CANVAS_TIMING=1 npx vitest run tests/shipping-ticket-canvas.test.ts -t "CANVAS timing" --reporter=verbose --silent=false
  it.skipIf(process.env.CANVAS_TIMING !== "1")("CANVAS timing: a 160-order canvas ticket set prints inside the 15 s budget, beside the flow Standard on the same shipment", async () => {
    const customer = await makeCustomer();
    const shipper = await bigShipment(customer, 160);

    // The flow first: nothing is assigned, so the shipment resolves the MOS_SHIPPER Standard.
    const startedF = performance.now();
    const flow = await asSystem(() => printShippingTickets(shipper.id));
    const msF = Math.round(performance.now() - startedF);
    const pagesF = pageCount(flow.pdf);

    const t = await asSystem(() => createTemplate("MOS_SHIPPER", "Canvas timing MOS_SHIPPER"));
    const config = validateConfig("MOS_SHIPPER", { ...structuredClone(MOS_SHIPPER_DEFAULT_CONFIG), layout: standardTicketLayout() });
    await asSystem(() => editDraft(t.id, { config, updatedAt: t.draft.updatedAt }));
    const { versionId } = await asSystem(() => publishDraft(t.id));
    await asSystem(() => assignTemplate(customer.id, "MOS_SHIPPER", t.id));

    const startedC = performance.now();
    const canvas = await asSystem(() => printShippingTickets(shipper.id));
    const msC = Math.round(performance.now() - startedC);
    const pagesC = pageCount(canvas.pdf);

    console.log(`CANVAS timing: 160 orders; flow ${pagesF} pages in ${msF} ms; canvas ${pagesC} pages in ${msC} ms, against a limit of 15000 ms`);
    expect(pagesF).toBeGreaterThanOrEqual(160);
    expect(pagesC).toBeGreaterThanOrEqual(160);
    // The canvas template printed it, not the flow Standard.
    const stamped = await prisma.storedDocument.findUniqueOrThrow({
      where: { id: canvas.documentId }, select: { templateVersionId: true },
    });
    expect(stamped.templateVersionId).toBe(versionId);
    expect(msC).toBeLessThan(15000);
  }, 300_000);
});

describe("the totals' least width is held to the builder's totals column (#971)", () => {
  /** Every `columns` node's numeric-width column holding the totals' `["*", 80]` table, in the content. */
  function totalsColumnWidths(node: unknown, out: number[] = []): number[] {
    if (Array.isArray(node)) {
      for (const child of node) totalsColumnWidths(child, out);
      return out;
    }
    if (node === null || typeof node !== "object") return out;
    const n = node as Record<string, unknown>;
    if (Array.isArray(n.columns)) {
      for (const column of n.columns as Record<string, unknown>[]) {
        const widths = (column?.table as { widths?: unknown } | undefined)?.widths;
        if (typeof column?.width === "number" && JSON.stringify(widths) === JSON.stringify(["*", 80])) out.push(column.width);
      }
    }
    for (const value of Object.values(n)) totalsColumnWidths(value, out);
    return out;
  }
  it.each(["SHIPPER", "MOS_SHIPPER"] as const)("%s: the totals print in one column the profile's floor less one grid step wide", (docType) => {
    const [definition] = buildShippingTicketDefinitions(ticketRecord(), docType);
    const widths = totalsColumnWidths((definition as { content: unknown }).content);
    expect(widths).toHaveLength(1);
    const contract = docType === "SHIPPER" ? SHIPPER_CONTRACT : MOS_SHIPPER_CONTRACT;
    expect(contract.canvas!.leastWidths.totals).toBe(TICKET_TOTALS_LEAST_WIDTH);
    expect(widths[0]).toBe(TICKET_TOTALS_LEAST_WIDTH - CANVAS_GRID);
  });
});
