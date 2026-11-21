import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { TINY_JPEG, pageCount, paintedImages } from "./helpers/pdf";
import { assertRun, printedPages, printedRuns } from "../e2e/lib/printed-page.mjs";
import { parseDateOnly } from "@/lib/business-days";
import { GET as tagsRoute } from "@/app/api/orders/[id]/container-tags/route";
import { renderContainerTagPreview, renderPreview } from "@/server/template-preview";
import { buildContainerTagCanvas } from "@/server/pdf/container-tag-canvas";
import { TAG_NO_ROWS, TAG_ORDER_NOT_FOUND, TAG_ORDER_VOIDED } from "@/server/container-tags";
import { CONTAINER_TAG_DEFAULT_CONFIG } from "@/lib/template-contracts/index";
import { runWithContext } from "@/server/context";
import { createTemplate, editDraft, publishDraft } from "@/server/templates";
import { assignTemplate, resolveTemplateForPrint } from "@/server/template-assignments";
import type { TemplateConfig } from "@/lib/template-contracts/types";

// A pass-through wrapper on the resolver, so the refusal cases can say it was never called. (A module
// export cannot be reassigned by property under ESM; this wraps it and calls the original.)
vi.mock("@/server/template-assignments", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/template-assignments")>();
  return { ...original, resolveTemplateForPrint: vi.fn(original.resolveTemplateForPrint) };
});

// GET /api/orders/[id]/container-tags: the order hub's Print tags (#743). One 4 in × 3 in page per
// container row (owner rulings 2 and 3, 2026-10-23), the traveler's permission (orders.view), a
// download that is never stored (ruling 4: informational; internal paper like the Invoice register,
// #592) and a pure read (spec §12). The text is the mapping's subject (tests/container-tags.test.ts)
// and the layout the builder's (tests/container-tags-pdf.test.ts); these cases hold the route to them.

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const getReq = (id: string, cookie?: string) =>
  new Request(`http://t/api/orders/${id}/container-tags`, { method: "GET", headers: cookie ? { cookie } : {} });

/** 9:02 AM at the plant on 10/23/2026 (UTC-5 in October). */
const CREATED_AT = new Date("2026-10-23T14:02:00.000Z");

async function writeOrder(input: { containers: number[]; voided?: boolean; lines?: { partNumber: string; qty: number }[] }) {
  const customer = await prisma.customer.create({ data: { code: "TAGS", name: "Tag Customer Inc" } });
  const type = await prisma.containerType.create({ data: { name: "Tag Basket" } });
  const lines = input.lines ?? [{ partNumber: "TAG-LEAD", qty: 1000 }, { partNumber: "TAG-RIDER", qty: 20 }];
  const parts: { id: string }[] = [];
  for (const line of lines) {
    parts.push(await prisma.part.create({ data: { customerId: customer.id, partNumber: line.partNumber, eachWeight: "1.0000" } }));
  }
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

describe("GET /api/orders/[id]/container-tags", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("401s without a session", async () => {
    const order = await writeOrder({ containers: [2] });
    expect((await tagsRoute(getReq(order.id), ctx(order.id))).status).toBe(401);
  });

  it("requires orders.view, the traveler's gate", async () => {
    const order = await writeOrder({ containers: [2] });
    const wrong = await signInWith(["shipping.view"], "tags-wrong");
    expect((await tagsRoute(getReq(order.id, wrong), ctx(order.id))).status).toBe(403);
  });

  it("404s an order that does not exist", async () => {
    const viewer = await signInWith(["orders.view"], "tags-404");
    const res = await tagsRoute(getReq("no-such-order", viewer), ctx("no-such-order"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Order not found" });
  });

  it("refuses a voided order: no new paper prints for one (spec §5c)", async () => {
    const order = await writeOrder({ containers: [2], voided: true });
    const viewer = await signInWith(["orders.view"], "tags-void");
    const res = await tagsRoute(getReq(order.id, viewer), ctx(order.id));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Order is voided — no tags print for it" });
  });

  it("refuses an order with no container rows, before any render", async () => {
    const order = await writeOrder({ containers: [] });
    const viewer = await signInWith(["orders.view"], "tags-none");
    const res = await tagsRoute(getReq(order.id, viewer), ctx(order.id));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "This order has no container rows to tag" });
  });

  it("answers a PDF download named for the order, one page per container row, each page the whole tag", async () => {
    const order = await writeOrder({ containers: [2, 3] });
    const viewer = await signInWith(["orders.view"], "tags-viewer");
    const res = await tagsRoute(getReq(order.id, viewer), ctx(order.id));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="container-tags-1031.pdf"');
    expect(res.headers.get("x-document-id")).toBeNull();
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(pageCount(bytes)).toBe(2);
    const pages = printedPages(bytes, { pages: 2, what: "the container tags" });
    for (const page of pages) {
      assertRun(page, [
        "Order #1031", "Tag Customer Inc", "PO 4500123", "Containers: 5", "Received 10/22/2026, 9:02 AM",
        "TAG-LEAD × 1,000", "TAG-RIDER × 20",
      ], "a container tag");
    }
  });

  it("is a pure read: it stores no document and writes no audit row", async () => {
    const order = await writeOrder({ containers: [1] });
    const viewer = await signInWith(["orders.view"], "tags-pure");
    const counts = async () => ({ documents: await prisma.storedDocument.count(), audit: await prisma.auditLog.count() });
    const was = await counts();
    expect((await tagsRoute(getReq(order.id, viewer), ctx(order.id))).status).toBe(200);
    expect(await counts()).toEqual(was);
  });
});

// The template preview's CONTAINER_TAG arm (container tag PR 1, Task 3): the order's first tag, the
// Standard's flow until Task 4 threads the config, refused in the print route's own three sentences,
// which the route and the arm both read from src/server/container-tags.ts.
describe("the template preview's CONTAINER_TAG arm", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });
  const preview = (recordId: string) => renderPreview(
    { docType: "CONTAINER_TAG", logoImage: null, logoMimeType: null },
    { config: CONTAINER_TAG_DEFAULT_CONFIG, recordId }, "nobody");

  it("prints the order's first tag alone, one page, and answers no measure", async () => {
    const order = await writeOrder({ containers: [2, 3] });
    const { pdf, measure } = await preview(order.id);
    expect(measure).toBeNull();
    expect(pageCount(pdf)).toBe(1);
  });

  it("refuses a missing order in the route's 404 sentence", async () => {
    await expect(preview("no-such-order")).rejects.toMatchObject({ status: 404, message: TAG_ORDER_NOT_FOUND });
    expect(TAG_ORDER_NOT_FOUND).toBe("Order not found");
  });

  it("refuses a voided order in the route's sentence", async () => {
    const order = await writeOrder({ containers: [2], voided: true });
    await expect(preview(order.id)).rejects.toMatchObject({ status: 400, message: TAG_ORDER_VOIDED });
    expect(TAG_ORDER_VOIDED).toBe("Order is voided — no tags print for it");
  });

  it("refuses an order with no container row in the route's sentence", async () => {
    const order = await writeOrder({ containers: [] });
    await expect(preview(order.id)).rejects.toMatchObject({ status: 400, message: TAG_NO_ROWS });
    expect(TAG_NO_ROWS).toBe("This order has no container rows to tag");
  });
});

// Container tag PR 1, Task 4: Print tags resolves the order's customer's tag template.
describe("GET /api/orders/[id]/container-tags: the customer's tag template", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); vi.mocked(resolveTemplateForPrint).mockClear(); });
  const asSystem = <T,>(fn: () => Promise<T>) => runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

  async function publishedTagTemplate(poLabel: string): Promise<string> {
    const t = await asSystem(() => createTemplate("CONTAINER_TAG", `Tags ${poLabel}`));
    const config = structuredClone(CONTAINER_TAG_DEFAULT_CONFIG) as TemplateConfig;
    config.sections[0].fields.find((f) => f.key === "po_number")!.label = poLabel;
    await asSystem(() => editDraft(t.id, { config, updatedAt: t.draft.updatedAt }));
    await asSystem(() => publishDraft(t.id));
    return t.id;
  }
  const printed = async (orderId: string, name: string): Promise<string[]> => {
    const viewer = await signInWith(["orders.view"], name);
    const res = await tagsRoute(getReq(orderId, viewer), ctx(orderId));
    expect(res.status).toBe(200);
    return printedPages(Buffer.from(await res.arrayBuffer()), { pages: 1, what: "the container tag" })[0];
  };

  it("prints the template assigned to the order's customer", async () => {
    const order = await writeOrder({ containers: [1] });
    await asSystem(async () => assignTemplate(order.customerId, "CONTAINER_TAG", await publishedTagTemplate("Cust PO")));
    assertRun(await printed(order.id, "tags-own"), [
      "Order #1031", "Tag Customer Inc", "Cust PO 4500123", "Containers: 1", "Received 10/22/2026, 9:02 AM",
      "TAG-LEAD × 1,000", "TAG-RIDER × 20",
    ], "a customer's tag");
  });

  it("falls to the parent's assignment over the default", async () => {
    const order = await writeOrder({ containers: [1] });
    const parent = await prisma.customer.create({ data: { code: "TAGP", name: "Tag Parent Inc" } });
    await prisma.customer.update({ where: { id: order.customerId }, data: { parentId: parent.id } });
    await asSystem(async () => assignTemplate(parent.id, "CONTAINER_TAG", await publishedTagTemplate("Parent PO")));
    expect(await printed(order.id, "tags-parent")).toContain("Parent PO 4500123");
  });

  it("prints today's text on the Standard", async () => {
    const order = await writeOrder({ containers: [1] });
    assertRun(await printed(order.id, "tags-std"), [
      "Order #1031", "Tag Customer Inc", "PO 4500123", "Containers: 1", "Received 10/22/2026, 9:02 AM",
      "TAG-LEAD × 1,000", "TAG-RIDER × 20",
    ], "the Standard tag");
  });

  it.each<[string, () => Promise<string>, number]>([
    ["a missing order", async () => "no-such-order", 404],
    ["a voided order", async () => (await writeOrder({ containers: [1], voided: true })).id, 400],
    ["an order with no container row", async () => (await writeOrder({ containers: [] })).id, 400],
  ])("resolves no template for %s", async (_name, makeId, status) => {
    const id = await makeId();
    const viewer = await signInWith(["orders.view"], "tags-refused");
    expect((await tagsRoute(getReq(id, viewer), ctx(id))).status).toBe(status);
    expect(resolveTemplateForPrint).not.toHaveBeenCalled();
  });
});

describe("the template preview's CONTAINER_TAG arm reads the submitted config", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });
  it("prints a typed po_number label on the order's first tag", async () => {
    const order = await writeOrder({ containers: [2] });
    const config = structuredClone(CONTAINER_TAG_DEFAULT_CONFIG) as TemplateConfig;
    config.sections[0].fields.find((f) => f.key === "po_number")!.label = "Preview PO";
    const { pdf } = await renderPreview(
      { docType: "CONTAINER_TAG", logoImage: null, logoMimeType: null }, { config, recordId: order.id }, "nobody");
    expect(printedPages(pdf, { pages: 1, what: "the preview tag" })[0]).toContain("Preview PO 4500123");
  });
});

// Container tag PR 3, Task 4: Print tags prints a canvas tag template. Written before Task 5 added the
// tag to CANVAS_PRINTS, so the resolver is answered once with one (the controller's ruling); the
// published canvas template is printed end to end in tests/container-tag-canvas-seed.test.ts.
describe("GET /api/orders/[id]/container-tags: a canvas tag template", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); vi.mocked(resolveTemplateForPrint).mockClear(); });
  const orderAt = (x: number) => ({
    id: "o", kind: "field" as const, key: "order_number", label: null, style: { size: 20, bold: true, align: "left" as const },
    box: { x, y: 14, w: 160, h: 24 }, anchor: { kind: "page-top" as const }, repeat: false,
  });
  const canvasConfig = (items: NonNullable<TemplateConfig["layout"]>["items"]): TemplateConfig =>
    ({ ...structuredClone(CONTAINER_TAG_DEFAULT_CONFIG), layout: { version: 1, items } });
  const resolvedWith = (config: TemplateConfig, logoImage: Uint8Array | null = null) =>
    vi.mocked(resolveTemplateForPrint).mockResolvedValueOnce({
      templateId: "t", versionId: "v", config, logoImage, logoMimeType: logoImage === null ? null : "image/jpeg",
    });
  const download = async (orderId: string, name: string): Promise<Buffer> => {
    const viewer = await signInWith(["orders.view"], name);
    const res = await tagsRoute(getReq(orderId, viewer), ctx(orderId));
    expect(res.status).toBe(200);
    return Buffer.from(await res.arrayBuffer());
  };

  it("prints the canvas: the order number at its drawn place on every tag, and nothing the layout does not hold", async () => {
    const order = await writeOrder({ containers: [2, 3] });
    resolvedWith(canvasConfig([orderAt(100)]));
    const pdf = await download(order.id, "tags-canvas");
    expect(pageCount(pdf)).toBe(2);
    const runs = printedRuns(pdf, { pages: 2, what: "the canvas tags" }) as { text: string; x: number }[][];
    for (const page of runs) {
      expect(page.map((r) => r.text).join("").trim()).toBe("Order #1031");
      expect(page[0].x).toBeCloseTo(100, 1);
    }
  });

  it("hands the template's logo to a canvas Logo item", async () => {
    const order = await writeOrder({ containers: [1] });
    resolvedWith(canvasConfig([orderAt(14), {
      id: "lg", kind: "logo", box: { x: 200, y: 150, w: 60, h: 40 }, anchor: { kind: "page-top" }, repeat: false,
    }]), new Uint8Array(TINY_JPEG));
    expect(paintedImages(await download(order.id, "tags-logo"))[0]).toEqual([{ x: 200, y: 150, w: 40, h: 40 }]);
  });

  it("still prints the Standard's flow", async () => {
    const order = await writeOrder({ containers: [1] });
    const pdf = await download(order.id, "tags-flow");
    expect(printedPages(pdf, { pages: 1, what: "the Standard tag" })[0]).toContain("PO 4500123");
  });
});

// The preview's CONTAINER_TAG arm answers the builder's measure for a canvas config (Task 4). The
// arm's helper is called directly; the preview route answers a canvas tag end to end in
// tests/container-tag-canvas-seed.test.ts (Task 5).
describe("renderContainerTagPreview", () => {
  const one = {
    orderNumber: "1031", customer: "Acme Heat Treating and Metal Finishing", poNumber: "4500123",
    parts: ["A-1 × 1", "A-2 × 2", "A-3 × 3"], containersTotal: "5", received: "10/23/2026, 9:02 AM",
  };
  it("answers the canvas builder's measure and one page for a canvas config", async () => {
    const config: TemplateConfig = { ...structuredClone(CONTAINER_TAG_DEFAULT_CONFIG), layout: { version: 1, items: [
      { id: "o", kind: "field", key: "order_number", label: null, style: { size: 20, bold: true, align: "left" },
        box: { x: 14, y: 14, w: 260, h: 24 }, anchor: { kind: "page-top" }, repeat: false },
      { id: "c", kind: "field", key: "customer", label: null, style: { size: 12, bold: true, align: "left" },
        box: { x: 14, y: 40, w: 60, h: 15 }, anchor: { kind: "page-top" }, repeat: false },
      { id: "p", kind: "field", key: "parts", label: null, style: { size: 10, bold: false, align: "left" },
        box: { x: 14, y: 60, w: 260, h: 24 }, anchor: { kind: "page-top" }, repeat: false },
    ] } };
    const { pdf, measure } = await renderContainerTagPreview(one, config, undefined);
    expect(pageCount(pdf)).toBe(1);
    expect(measure).toEqual(buildContainerTagCanvas([one], config).measure);
    expect(measure?.items.find((i) => i.id === "c")).toMatchObject({ cut: true });
    expect(measure?.items.find((i) => i.id === "p")).toMatchObject({ parts: { shown: 1, total: 3 } });
  });
  it("answers no measure for a flow config", async () => {
    const { pdf, measure } = await renderContainerTagPreview(one, CONTAINER_TAG_DEFAULT_CONFIG, undefined);
    expect(measure).toBeNull();
    expect(printedPages(pdf, { pages: 1, what: "the preview tag" })[0]).toContain("PO 4500123");
  });
});
