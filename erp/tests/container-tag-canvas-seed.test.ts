import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs, templateId } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { pageCount } from "./helpers/pdf";
import { STANDARD_TAG_ITEMS } from "./helpers/canvas-prints";
import { printedRuns } from "../e2e/lib/printed-page.mjs";
import { parseDateOnly } from "@/lib/business-days";
import { runWithContext } from "@/server/context";
import { createTemplate, editDraft, publishDraft } from "@/server/templates";
import { assignTemplate } from "@/server/template-assignments";
import { SEEDED_PART_LINES, seedContainerTagItems, seedContainerTagLayout } from "@/server/container-tag-canvas-seed";
import { seedCanvasLayout } from "@/server/template-canvas-seed";
import { buildContainerTagCanvas } from "@/server/pdf/container-tag-canvas";
import { buildContainerTags, type ContainerTagData } from "@/server/pdf/container-tags";
import { renderPdf } from "@/server/pdf/render";
import { POST as seedRoute } from "@/app/api/templates/[id]/draft/canvas/route";
import { POST as previewRoute } from "@/app/api/templates/[id]/preview/route";
import { GET as tagsRoute } from "@/app/api/orders/[id]/container-tags/route";
import { CONTAINER_TAG_CONTRACT, DEFAULT_CONFIG, assertTagFits, flowTagHeight } from "@/lib/template-contracts/container-tag";
import { canvasPrints, validateConfig } from "@/lib/template-contracts/index";
import { canvasPageFor, type CanvasItem, type CanvasLayout } from "@/lib/template-contracts/canvas";
import { FONT_FAMILIES, type FontFamily, type TemplateConfig } from "@/lib/template-contracts/types";
import { canvasRefusal, canvasWarnings } from "@/lib/template-canvas";
import { textWidthOf } from "@/lib/tag-font-metrics";

// Container tag PR 3, Task 5 (the container tag design of 2026-11-13 §7.4, call 14): the tag's canvas
// seed lays out today's tag, and CONTAINER_TAG joins CANVAS_PRINTS, so Design on a canvas is offered on
// a tag draft, the registry accepts a tag layout, and the seed, preview and print routes answer one.
// Paper figures are read back from the rendered PDF: a run's (x, y) is its BASELINE start from the
// page's top-left (`printedRuns`), so two prints of one line in one face and size share a baseline
// exactly where they share a line top.

const TAG = canvasPageFor("CONTAINER_TAG", "4x3-landscape");
const SIZE_CAP = "Customer prints at the body size plus 2 pt, past the 72 pt a canvas item can take; lower the body size.";
const NO_FIT = "The tag's text sizes do not fit one 4 × 3 label as a canvas; lower the base or heading size.";
const asSystem = <T,>(fn: () => Promise<T>) => runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

const std = (): TemplateConfig => structuredClone(DEFAULT_CONFIG);
const withFonts = (patch: Partial<TemplateConfig["fonts"]>, base = std()): TemplateConfig => ({ ...base, fonts: { ...base.fonts, ...patch } });
const fieldOf = (config: TemplateConfig, key: string) => config.sections[0].fields.find((f) => f.key === key)!;
const showOnly = (config: TemplateConfig, keys: string[]): TemplateConfig => {
  for (const f of config.sections[0].fields) f.visible = f.key === "order_number" || keys.includes(f.key);
  return config;
};
const canvasOf = (config: TemplateConfig, items = seedContainerTagItems(config)): TemplateConfig =>
  ({ ...config, layout: { version: 1, items } });

function tag(overrides: Partial<ContainerTagData> = {}): ContainerTagData {
  return {
    orderNumber: "1031", customer: "Tag Customer Inc", poNumber: "4500123",
    parts: ["TAG-LEAD × 1,000", "TAG-RIDER × 20"], containersTotal: "5",
    received: "10/22/2026, 9:02 AM", ...overrides,
  };
}

type Line = { text: string; x: number; y: number };
/** One page's printed lines: the runs sharing a baseline, left to right, the line's x its first run's. */
function linesOf(pdf: Buffer, pages = 1): Line[][] {
  const runs = printedRuns(pdf, { pages, what: "the container tag" }) as Line[][];
  return runs.map((page) => {
    const byY = new Map<number, Line[]>();
    for (const run of page) {
      const key = Math.round(run.y * 100) / 100;
      byY.set(key, [...(byY.get(key) ?? []), run]);
    }
    return [...byY.entries()].sort((a, b) => a[0] - b[0]).map(([y, parts]) => {
      const sorted = parts.sort((a, b) => a.x - b.x);
      return { y, x: sorted[0].x, text: sorted.map((p) => p.text).join("").trimEnd() };
    });
  });
}
const flowLines = async (config: TemplateConfig, data = tag()) => linesOf(await renderPdf(buildContainerTags([data], config)))[0];
const seededLines = async (config: TemplateConfig, data = tag()) =>
  linesOf(await renderPdf(buildContainerTags([data], canvasOf(config))))[0];

describe("seedContainerTagItems: today's tag, worked from line heights", () => {
  it("lays out the Standard's six fields at x 14, w 260, one line tall each, the part lines seven, ids tag-<key>", () => {
    // Roboto's line is 1.171875 × the size: 23.4375 at 20 (23.438 rounded up), 14.0625 at 12 (14.063),
    // 11.71875 at 10 (11.719); the part lines seven of those, 82.033. The tops stack from 14 under the
    // drawn boxes, with Customer 2, PO 4 and the part lines 6 below the box above.
    const items = seedContainerTagItems(std());
    expect(items).toEqual(STANDARD_TAG_ITEMS);
    expect(items.map((i) => [i.id, i.box.y, i.box.h])).toEqual([
      ["tag-order_number", 14, 23.438],
      ["tag-customer", 39.438, 14.063],
      ["tag-po_number", 57.501, 11.719],
      ["tag-containers_total", 69.22, 11.719],
      ["tag-received", 80.939, 11.719],
      ["tag-parts", 98.658, 82.033],
    ]);
    for (const item of items) expect([item.box.x, item.box.w, item.anchor, item.repeat]).toEqual([14, 260, { kind: "page-top" }, false]);
    expect(SEEDED_PART_LINES).toBe(7);
  });

  it("styles each field as the flow prints it: Order # at the heading size bold, Customer at the base plus 2 bold, the rest at the base", () => {
    const items = seedContainerTagItems(withFonts({ baseSize: 9, headingSize: 18 }));
    expect(Object.fromEntries(items.map((i) => [i.id, i.kind === "field" ? i.style : null]))).toEqual({
      "tag-order_number": { size: 18, bold: true, align: "left" },
      "tag-customer": { size: 11, bold: true, align: "left" },
      "tag-po_number": { size: 9, bold: false, align: "left" },
      "tag-containers_total": { size: 9, bold: false, align: "left" },
      "tag-received": { size: 9, bold: false, align: "left" },
      "tag-parts": { size: 9, bold: false, align: "left" },
    });
  });

  it("gives a hidden field no item, and the fields below it close up as the flow's do", () => {
    const config = std();
    fieldOf(config, "customer").visible = false;
    const items = seedContainerTagItems(config);
    expect(items.map((i) => i.id)).toEqual(["tag-order_number", "tag-po_number", "tag-containers_total", "tag-received", "tag-parts"]);
    expect(items[1].box.y).toBe(14 + 23.438 + 4);
  });

  it("seeds a reordered config in its order", () => {
    const config = std();
    const fields = config.sections[0].fields;
    config.sections[0].fields = [fields[0], fields[5], fields[2], fields[1], fields[3], fields[4]];
    const items = seedContainerTagItems(config);
    expect(items.map((i) => i.id)).toEqual([
      "tag-order_number", "tag-parts", "tag-po_number", "tag-customer", "tag-containers_total", "tag-received",
    ]);
    for (let i = 1; i < items.length; i++) expect(items[i].box.y).toBeGreaterThanOrEqual(items[i - 1].box.y + items[i - 1].box.h);
  });

  it("carries the config's typed label onto the item, null where untyped, so the canvas prints the config's words", async () => {
    const config = std();
    fieldOf(config, "po_number").label = "Cust PO";
    const items = seedContainerTagItems(config);
    expect(items.find((i) => i.id === "tag-po_number")).toMatchObject({ label: "Cust PO" });
    expect(items.find((i) => i.id === "tag-customer")).toMatchObject({ label: null });
    expect((await seededLines(config)).map((l) => l.text)).toContain("Cust PO 4500123");
  });
});

describe("the seeded tag prints today's tag (call 14)", () => {
  /** The flow's lines and the seeded canvas's, the same text at the same x and baseline within 0.5 pt. */
  async function samePaper(config: TemplateConfig, data = tag()) {
    const flow = await flowLines(config, data);
    const seeded = await seededLines(config, data);
    expect(seeded.map((l) => l.text)).toEqual(flow.map((l) => l.text));
    for (const [i, line] of flow.entries()) {
      expect(Math.abs(seeded[i].x - line.x), line.text).toBeLessThanOrEqual(0.5);
      expect(Math.abs(seeded[i].y - line.y), line.text).toBeLessThanOrEqual(0.5);
    }
    return flow;
  }

  it.each(FONT_FAMILIES)("%s: the Standard's sizes print every line where the flow prints it", async (family) => {
    const flow = await samePaper(withFonts({ family }));
    expect(flow.map((l) => l.text)).toEqual([
      "Order #1031", "Tag Customer Inc", "PO 4500123", "Containers: 5", "Received 10/22/2026, 9:02 AM",
      "TAG-LEAD × 1,000", "TAG-RIDER × 20",
    ]);
  });

  it("a hidden field and a reordered config print where the flow prints them", async () => {
    const hidden = std();
    fieldOf(hidden, "containers_total").visible = false;
    await samePaper(hidden);
    const reordered = std();
    const f = reordered.sections[0].fields;
    reordered.sections[0].fields = [f[0], f[1], f[4], f[3], f[2], f[5]];
    expect((await samePaper(reordered)).map((l) => l.text).slice(2, 5))
      .toEqual(["Received 10/22/2026, 9:02 AM", "Containers: 5", "PO 4500123"]);
  });

  it("six parts and more than seven print as the flow prints them: six, then the more line", async () => {
    const six = Array.from({ length: 6 }, (_, i) => `P-${i + 1} × 1`);
    await samePaper(std(), tag({ parts: six }));
    const nine = Array.from({ length: 9 }, (_, i) => `P-${i + 1} × 1`);
    const lines = await samePaper(std(), tag({ parts: nine }));
    expect(lines.at(-1)!.text).toBe("and 3 more parts");
  });

  it("the one difference: an order of exactly seven parts prints all seven on the seeded canvas, where the flow prints six and the more line", async () => {
    const seven = Array.from({ length: 7 }, (_, i) => `P-${i + 1} × 1`);
    const flow = (await flowLines(std(), tag({ parts: seven }))).map((l) => l.text);
    const seeded = (await seededLines(std(), tag({ parts: seven }))).map((l) => l.text);
    expect(flow.slice(5)).toEqual(["P-1 × 1", "P-2 × 1", "P-3 × 1", "P-4 × 1", "P-5 × 1", "P-6 × 1", "and 1 more part"]);
    expect(seeded.slice(5)).toEqual(["P-1 × 1", "P-2 × 1", "P-3 × 1", "P-4 × 1", "P-5 × 1", "P-6 × 1", "P-7 × 1"]);
    expect(buildContainerTagCanvas([tag({ parts: seven })], canvasOf(std())).measure.items.find((i) => i.id === "tag-parts"))
      .toMatchObject({ parts: { shown: 7, total: 7 } });
  });

  it("a difference by design (R7): a customer name past the label's right margin in the flow prints cut inside its 260 pt box on the seeded canvas", async () => {
    // The flow prints a noWrap line from x 14 and lets it run through the 14 pt right margin; the canvas
    // cuts a value at its box's edge, x 274 (R7, call 11). Both read back from the rendered PDFs. A run's
    // end is its x plus the metrics leaf's width, which is never narrower than pdfkit draws (#984, #986).
    const name = "Consolidated Heat Treating and Metal Finishing Corporation of America";
    const data = tag({ customer: name });
    const flow = (await flowLines(std(), data)).find((l) => l.text.startsWith("Consolidated"))!;
    const seeded = (await seededLines(std(), data)).find((l) => l.text.startsWith("Consolidated"))!;
    expect(flow.text).toBe(name);
    expect(flow.x + textWidthOf(flow.text, "Roboto", "bold", 12)).toBeGreaterThan(274);
    expect(seeded.text.length).toBeLessThan(name.length);
    expect(name.startsWith(seeded.text)).toBe(true);
    expect(seeded.x).toBeCloseTo(14, 1);
    expect(seeded.x + textWidthOf(seeded.text, "Roboto", "bold", 12)).toBeLessThanOrEqual(274);
    expect(buildContainerTagCanvas([data], canvasOf(std())).measure.items.find((i) => i.id === "tag-customer"))
      .toMatchObject({ cut: true });
  });

  it("with a typed parts label the one difference moves to exactly six parts: the label and six on the canvas, the label, five and the more line in the flow", async () => {
    const config = std();
    fieldOf(config, "parts").label = "Parts:";
    const six = Array.from({ length: 6 }, (_, i) => `P-${i + 1} × 1`);
    const flow = (await flowLines(config, tag({ parts: six }))).map((l) => l.text);
    const seeded = (await seededLines(config, tag({ parts: six }))).map((l) => l.text);
    expect(flow.slice(5)).toEqual(["Parts:", "P-1 × 1", "P-2 × 1", "P-3 × 1", "P-4 × 1", "P-5 × 1", "and 1 more part"]);
    expect(seeded.slice(5)).toEqual(["Parts:", "P-1 × 1", "P-2 × 1", "P-3 × 1", "P-4 × 1", "P-5 × 1", "P-6 × 1"]);
    // Seven parts print the same on both: the label, five and the more line.
    await samePaper(config, tag({ parts: Array.from({ length: 7 }, (_, i) => `P-${i + 1} × 1`) }));
  });

  it("a difference by design: fields the config puts below the part lines sit under the seven-line box, where the flow puts them under the lines it printed", async () => {
    // The seed is the same for every order, so it draws the part lines' box at its most (six and the
    // more line). With two parts the flow's later fields rise under the two lines; the canvas's do not.
    const config = std();
    const f = config.sections[0].fields;
    config.sections[0].fields = [f[0], f[5], f[1], f[2], f[3], f[4]];
    const flow = await flowLines(config);
    const seeded = await seededLines(config);
    expect(seeded.map((l) => l.text)).toEqual(flow.map((l) => l.text));
    const below = (lines: Line[]) => lines.find((l) => l.text === "Tag Customer Inc")!.y;
    // Five more line heights at 10 pt (5 × 11.719) lower on the canvas.
    expect(below(seeded) - below(flow)).toBeCloseTo(5 * 11.71875, 0);
    const parts = seedContainerTagItems(config).find((i) => i.id === "tag-parts")!;
    expect(seedContainerTagItems(config).find((i) => i.id === "tag-customer")!.box.y).toBeCloseTo(parts.box.y + parts.box.h + 2, 3);
  });

  it.each(FONT_FAMILIES)("%s: the seeded Standard passes the rules on the tag's page through the registry, and warns of nothing", (family) => {
    const config = withFonts({ family });
    const layout = canvasOf(config).layout!;
    expect(() => validateConfig("CONTAINER_TAG", { ...config, layout })).not.toThrow();
    const options = { page: TAG, fonts: config.fonts };
    expect(canvasRefusal(layout, CONTAINER_TAG_CONTRACT, options)).toBeNull();
    const { measure } = buildContainerTagCanvas([tag()], { ...config, layout });
    expect(canvasWarnings(layout, CONTAINER_TAG_CONTRACT, measure, options)).toEqual([]);
  });
});

// A database order, its lines in position order and its container rows.
const CREATED_AT = new Date("2026-10-23T14:02:00.000Z");
async function writeOrder(input: { containers: number[]; voided?: boolean; parts?: number }) {
  const customer = await prisma.customer.create({ data: { code: "TAGS", name: "Tag Customer Inc" } });
  const type = await prisma.containerType.create({ data: { name: "Tag Basket" } });
  const lines = Array.from({ length: input.parts ?? 2 }, (_, i) => ({ partNumber: `TAG-${i + 1}`, qty: 10 * (i + 1) }));
  const parts: { id: string }[] = [];
  for (const line of lines) parts.push(await prisma.part.create({ data: { customerId: customer.id, partNumber: line.partNumber, eachWeight: "1.0000" } }));
  return prisma.order.create({
    data: {
      orderNumber: 1031, customerId: customer.id, status: "OPEN", poNumber: "4500123",
      receivedDate: parseDateOnly("2026-10-22"), requestDate: parseDateOnly("2026-10-29"),
      createdAt: CREATED_AT, deletedAt: input.voided ? new Date() : null,
      lines: { create: lines.map((line, i) => ({ position: i + 1, partId: parts[i].id, qty: line.qty, weight: "1.00" })) },
      containers: { create: input.containers.map((count, i) => ({ position: i + 1, typeId: type.id, count })) },
    },
  });
}
const counts = async () => ({ documents: await prisma.storedDocument.count(), audit: await prisma.auditLog.count() });
const NO_LOGO = { docType: "CONTAINER_TAG" as const, logoImage: null, logoMimeType: null };

describe("seedContainerTagLayout: the picked order, refused as the preview refuses it", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("answers the seeded layout for an order with container rows, and writes nothing", async () => {
    const order = await writeOrder({ containers: [2, 3] });
    const was = await counts();
    expect(await seedContainerTagLayout(order.id, std())).toEqual({ version: 1, items: STANDARD_TAG_ITEMS });
    expect(await counts()).toEqual(was);
  });

  it.each<[string, () => Promise<string>, number, string]>([
    ["an unknown order", async () => "no-such-order", 404, "Order not found"],
    ["a voided order", async () => (await writeOrder({ containers: [1], voided: true })).id, 400, "Order is voided — no tags print for it"],
    ["an order with no container row", async () => (await writeOrder({ containers: [] })).id, 400, "This order has no container rows to tag"],
  ])("refuses %s in the print route's sentence, storing and auditing nothing", async (_name, makeId, status, message) => {
    const id = await makeId();
    const was = await counts();
    await expect(seedContainerTagLayout(id, std())).rejects.toMatchObject({ status, message });
    await expect(seedCanvasLayout(NO_LOGO, { recordId: id, config: std() }, "nobody")).rejects.toMatchObject({ status, message });
    expect(await counts()).toEqual(was);
  });

  it("refuses a Customer the body size puts past a canvas item's 72 pt, a config R11 accepts", async () => {
    // The sweep's config: Roboto, Order # and Customer alone, base 70.5, heading 20. The flow prints
    // Customer at 72.5 pt and fits (110.40 pt), but no canvas item takes a size over 72.
    const order = await writeOrder({ containers: [1] });
    const config = showOnly(withFonts({ baseSize: 70.5, headingSize: 20 }), ["customer"]);
    expect(() => validateConfig("CONTAINER_TAG", config)).not.toThrow();
    expect(flowTagHeight(config)).toBeCloseTo(110.398, 2);
    await expect(seedContainerTagLayout(order.id, config)).rejects.toMatchObject({ status: 400, message: SIZE_CAP });
    // At a base of 70 Customer is 72, and the seed answers.
    const at70 = showOnly(withFonts({ baseSize: 70, headingSize: 20 }), ["customer"]);
    const layout = await seedContainerTagLayout(order.id, at70);
    expect(layout.items.find((i) => i.id === "tag-customer")).toMatchObject({ style: { size: 72 } });
    // A hidden Customer is not refused at any base the flow accepts.
    const hidden = showOnly(withFonts({ baseSize: 72, headingSize: 20 }), ["po_number"]);
    expect(() => assertTagFits(hidden)).not.toThrow();
    await expect(seedContainerTagLayout(order.id, hidden)).resolves.toMatchObject({ version: 1 });
  });

  it("answers an unknown order its 404 before the size cap, as the preview reads the order first", async () => {
    const config = showOnly(withFonts({ baseSize: 70.5, headingSize: 20 }), ["customer"]);
    await expect(seedContainerTagLayout("no-such-order", config)).rejects.toMatchObject({ status: 404, message: "Order not found" });
  });

  it("refuses a stack the boxes' rounding puts past the label's foot, a config R11 accepts", async () => {
    // The sweep's config: Roboto, every field shown, heading 34, base 10.38. The flow is 187.992 pt,
    // under the content's 188, so R11 accepts it; each box rounded up to 0.001 (the part lines' seven
    // times) puts the seeded part lines' bottom past 202.
    const order = await writeOrder({ containers: [1] });
    const config = withFonts({ baseSize: 10.38, headingSize: 34 });
    expect(() => validateConfig("CONTAINER_TAG", config)).not.toThrow();
    expect(flowTagHeight(config)).toBeLessThan(188);
    const items = seedContainerTagItems(config);
    const parts = items.find((i) => i.id === "tag-parts")!;
    expect(parts.box.y + parts.box.h).toBeGreaterThan(202);
    await expect(seedContainerTagLayout(order.id, config)).rejects.toMatchObject({ status: 400, message: NO_FIT });
    await expect(seedCanvasLayout(NO_LOGO, { recordId: order.id, config }, "nobody")).rejects.toMatchObject({ status: 400, message: NO_FIT });
  });
});

describe("the gate: CONTAINER_TAG is in CANVAS_PRINTS", () => {
  const order = (h = 26.4): CanvasItem => ({
    id: "o", kind: "field", key: "order_number", label: null, style: { size: 20, bold: true, align: "left" },
    box: { x: 14, y: 14, w: 260, h }, anchor: { kind: "page-top" }, repeat: false,
  });
  const po: CanvasItem = {
    id: "p", kind: "field", key: "po_number", label: null, style: { size: 10, bold: false, align: "left" },
    box: { x: 14, y: 45, w: 260, h: 12 }, anchor: { kind: "page-top" }, repeat: false,
  };
  const withLayout = (family: FontFamily, items: CanvasItem[]): TemplateConfig => ({
    ...withFonts({ family }), layout: { version: 1, items } satisfies CanvasLayout,
  });

  it("offers Design on a canvas on a tag draft", () => {
    expect(canvasPrints("CONTAINER_TAG")).toBe(true);
  });

  it("the registry judges a tag layout on the tag's page with the config's fonts: a 12 pt-tall field passes in Roboto and is refused in Roboto Mono", () => {
    // One line at 10 pt is 11.72 pt in Roboto and 13.19 pt in Roboto Mono; Order # is drawn 26.4 pt
    // tall, past one 20 pt bold line in either (23.44, 26.38), so only the field under test can fail.
    expect(validateConfig("CONTAINER_TAG", withLayout("Roboto", [order(), po])).layout?.items).toHaveLength(2);
    expect(() => validateConfig("CONTAINER_TAG", withLayout("Roboto Mono", [order(), po])))
      .toThrow("The PO number field is shorter than one line of its text; draw it at least 0.19 in tall.");
    // On Letter x 14 would lie before the 24 pt margin: the tag's own page is the one judged.
    expect(() => validateConfig("CONTAINER_TAG", withLayout("Roboto", [order()]))).not.toThrow();
  });
});

describe("end to end: the seed route, the preview route, a published canvas template and Print tags", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });
  const json = (cookie: string, body: unknown) => ({
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const draftOf = async (id: string) =>
    JSON.stringify(await prisma.documentTemplateVersion.findMany({ where: { templateId: id }, orderBy: { versionNumber: "asc" } }));

  it("seeds, previews with its measure, publishes and prints a canvas tag for the order's customer", async () => {
    const order = await writeOrder({ containers: [2, 3], parts: 7 });
    const t = await asSystem(() => createTemplate("CONTAINER_TAG", "Canvas tags"));
    const cookie = await signInWith(["templates.edit", "templates.view", "orders.view"], "tag-e2e");

    // The seed route answers the seeded layout and writes nothing.
    const was = { counts: await counts(), draft: await draftOf(t.id) };
    const seeded = await seedRoute(new Request(`http://t/api/templates/${t.id}/draft/canvas`, json(cookie, { recordId: order.id, config: std() })),
      { params: Promise.resolve({ id: t.id }) });
    expect(seeded.status).toBe(200);
    const layout = await seeded.json() as CanvasLayout;
    expect(layout).toEqual({ version: 1, items: STANDARD_TAG_ITEMS });
    expect({ counts: await counts(), draft: await draftOf(t.id) }).toEqual(was);

    // The preview route answers the canvas and the builder's measure.
    const config: TemplateConfig = { ...std(), layout };
    const preview = await previewRoute(new Request(`http://t/api/templates/${t.id}/preview`, json(cookie, { recordId: order.id, config })),
      { params: Promise.resolve({ id: t.id }) });
    expect(preview.status).toBe(200);
    expect(pageCount(Buffer.from(await preview.arrayBuffer()))).toBe(1);
    const measure = JSON.parse(decodeURIComponent(preview.headers.get("X-Preview-Measure")!));
    const one = tag({ customer: "Tag Customer Inc", containersTotal: "5", parts: Array.from({ length: 7 }, (_, i) => `TAG-${i + 1} × ${10 * (i + 1)}`) });
    expect(measure).toEqual(buildContainerTagCanvas([one], config).measure);
    expect(measure.items.find((i: { id: string }) => i.id === "tag-parts")).toMatchObject({ parts: { shown: 7, total: 7 } });

    // Saved, published and assigned to the order's customer, Print tags prints it, one page a row.
    await asSystem(() => editDraft(t.id, { config, updatedAt: t.draft.updatedAt }));
    await asSystem(() => publishDraft(t.id));
    await asSystem(() => assignTemplate(order.customerId, "CONTAINER_TAG", t.id));
    const res = await tagsRoute(new Request(`http://t/api/orders/${order.id}/container-tags`, { headers: { cookie } }),
      { params: Promise.resolve({ id: order.id }) });
    expect(res.status).toBe(200);
    const pdf = Buffer.from(await res.arrayBuffer());
    expect(pageCount(pdf)).toBe(2);
    for (const page of linesOf(pdf, 2)) {
      // All seven parts, the canvas's part lines box holding seven lines.
      expect(page.map((l) => l.text)).toEqual([
        "Order #1031", "Tag Customer Inc", "PO 4500123", "Containers: 5", "Received 10/22/2026, 9:02 AM",
        ...Array.from({ length: 7 }, (_, i) => `TAG-${i + 1} × ${10 * (i + 1)}`),
      ]);
      // Each field's baseline inside its seeded box.
      for (const [text, id] of [["Order #1031", "tag-order_number"], ["PO 4500123", "tag-po_number"], ["TAG-1 × 10", "tag-parts"]] as const) {
        const box = layout.items.find((i) => i.id === id)!.box;
        const line = page.find((l) => l.text === text)!;
        expect(line.y).toBeGreaterThan(box.y);
        expect(line.y).toBeLessThanOrEqual(box.y + box.h);
        expect(line.x).toBeCloseTo(14, 1);
      }
    }
  }, 60_000);

  it("the seed route refuses an unknown order 404 in the route's sentence, the draft untouched", async () => {
    const id = templateId("CONTAINER_TAG");
    const cookie = await signInWith(["templates.edit", "orders.view"], "tag-seed-404");
    const was = await draftOf(id);
    const res = await seedRoute(new Request(`http://t/api/templates/${id}/draft/canvas`, json(cookie, { recordId: "no-such-order", config: std() })),
      { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Order not found" });
    expect(await draftOf(id)).toBe(was);
  });

  it("the seed route answers a seed refusal as a 400, never a 500", async () => {
    const order = await writeOrder({ containers: [1] });
    const id = templateId("CONTAINER_TAG");
    const cookie = await signInWith(["templates.edit", "orders.view"], "tag-seed-400");
    const config = withFonts({ baseSize: 10.38, headingSize: 34 });
    const res = await seedRoute(new Request(`http://t/api/templates/${id}/draft/canvas`, json(cookie, { recordId: order.id, config })),
      { params: Promise.resolve({ id }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: NO_FIT });
  });
});
