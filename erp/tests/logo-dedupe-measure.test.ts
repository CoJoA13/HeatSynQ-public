import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { TINY_JPEG, alphaPng, pageCount } from "./helpers/pdf";
import { runWithContext } from "@/server/context";
import { createOrder, type OrderDetail } from "@/server/orders";
import { createShipper, printShippingTickets } from "@/server/shippers";
import { printTraveler } from "@/server/traveler";
import { createTemplate, editDraft, publishDraft, uploadLogo } from "@/server/templates";
import { assignTemplate } from "@/server/template-assignments";
import { LOGO_MAX_BYTES } from "@/lib/upload-limits";
import { defaultConfigFor } from "@/lib/template-contracts/index";

/**
 * #670, step 1: MEASURE the per-group logo duplication in a merged print before deciding to
 * dedupe it. Runs only when asked, the W5 timing case's shape:
 *
 *   LOGO_DEDUPE_MEASURE=1 npx vitest run tests/logo-dedupe-measure.test.ts
 *
 * It prints a 100-load traveler and a 20-order ticket set, each three times (no logo, a 512 KB
 * alpha PNG, a 512 KB JPEG), and writes out the stored bytes and the time of each. Nothing here
 * asserts a size or a time: the figures go to the issue and HANDOFF §4.
 */

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);

/** The 2×2 fixture JPEG padded with COM segments (legal, skipped by every parser) to the cap. */
function bigJpeg(): Buffer {
  const target = LOGO_MAX_BYTES - 2048;
  const segments: Buffer[] = [];
  let padded = TINY_JPEG.length;
  while (padded < target) {
    const payload = Math.min(65_533, target - padded - 2);
    const seg = Buffer.alloc(2 + 2 + payload, 0x20);
    seg[0] = 0xff; seg[1] = 0xfe; seg.writeUInt16BE(payload + 2, 2);
    segments.push(seg);
    padded += seg.length;
  }
  return Buffer.concat([TINY_JPEG.subarray(0, 2), ...segments, TINY_JPEG.subarray(2)]);
}

async function publishWithLogo(
  docType: "TRAVELER" | "MOS_SHIPPER", customerId: string, logo: { data: Buffer; mime: string } | null,
) {
  const t = await asSystem(() => createTemplate(docType, `Measure ${docType} ${logo?.mime ?? "bare"}`));
  const c = defaultConfigFor(docType);
  if (logo) c.logo = { placement: "header-center", width: 120 };
  await asSystem(() => editDraft(t.id, { config: c, updatedAt: t.draft.updatedAt }));
  if (logo) await asSystem(() => uploadLogo(t.id, logo.data, logo.mime));
  await asSystem(() => publishDraft(t.id));
  await asSystem(() => assignTemplate(customerId, docType, t.id));
}

async function timed<T>(label: string, fn: () => Promise<{ pdf: Buffer } & T>) {
  const started = performance.now();
  const out = await fn();
  const ms = Math.round(performance.now() - started);
  console.log(`#670 measure: ${label}: ${out.pdf.length} bytes, ${pageCount(out.pdf)} pages, ${ms} ms`);
  return out;
}

describe("#670 measurement: a placed logo in a merged print, once per sheet group", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  const logos = () => {
    const png = alphaPng(350, 370), jpeg = bigJpeg();
    expect(png.length).toBeLessThanOrEqual(LOGO_MAX_BYTES);
    expect(jpeg.length).toBeLessThanOrEqual(LOGO_MAX_BYTES);
    console.log(`#670 measure: logos: PNG ${png.length} bytes, JPEG ${jpeg.length} bytes`);
    return { png, jpeg };
  };

  it.skipIf(process.env.LOGO_DEDUPE_MEASURE !== "1")("a 100-load traveler", async () => {
    const { png, jpeg } = logos();
    const customer = await prisma.customer.create({ data: { code: "M670", name: "Measure Co" } });
    const code = await prisma.processStepCode.create({ data: { code: "M670", name: "Bake" } });
    const part = await prisma.part.create({
      data: { customerId: customer.id, partNumber: "M670-1", name: "Measure Part", eachWeight: "1.0000", loadQty: 1 },
    });
    const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
    await prisma.partProcessStep.create({
      data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Bake." },
    });
    const { order } = await asSystem(() => createOrder({
      customerId: customer.id, lines: [{ partId: part.id, qty: 100, weight: "100.00" }],
    }));
    expect(order.loads).toHaveLength(100);

    await publishWithLogo("TRAVELER", customer.id, null);
    await timed("traveler, 100 loads, no logo", () => asSystem(() => printTraveler(order.id)));
    await publishWithLogo("TRAVELER", customer.id, { data: png, mime: "image/png" });
    await timed("traveler, 100 loads, 512 KB alpha PNG", () => asSystem(() => printTraveler(order.id)));
    await publishWithLogo("TRAVELER", customer.id, { data: jpeg, mime: "image/jpeg" });
    await timed("traveler, 100 loads, 512 KB JPEG", () => asSystem(() => printTraveler(order.id)));
  }, 300_000);

  it.skipIf(process.env.LOGO_DEDUPE_MEASURE !== "1")("a 20-order shipping ticket set", async () => {
    const { png, jpeg } = logos();
    const customer = await prisma.customer.create({ data: { code: "M670", name: "Measure Co" } });
    const shipTo = await prisma.customerAddress.create({
      data: {
        customerId: customer.id, kind: "SHIP_TO", name: "Measure Dock", street: "1 Dock Way",
        city: "Anniston", state: "AL", zip: "36201", isDefault: true,
      },
    });
    const code = await prisma.processStepCode.create({ data: { code: "M670", name: "Bake" } });
    const orders: OrderDetail[] = [];
    for (let i = 1; i <= 20; i++) {
      const part = await prisma.part.create({
        data: { customerId: customer.id, partNumber: `M670-${i}`, name: `Measure Part ${i}`, eachWeight: "21.5000" },
      });
      const rev = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
      await prisma.partProcessStep.create({
        data: { revisionId: rev.id, position: 1, codeId: code.id, instruction: "Bake." },
      });
      const { order } = await asSystem(() => createOrder({
        customerId: customer.id, poNumber: `PO-${i}`, lines: [{ partId: part.id, qty: 192, weight: "4128.00" }],
      }));
      orders.push(order);
    }
    const { shipper } = await asSystem(() => createShipper({
      customerId: customer.id, shipDate: "2026-07-29", shipToAddressId: shipTo.id,
      orders: orders.map((order) => ({
        orderId: order.id,
        lines: [{ orderLineId: order.lines[0].id, qty: order.lines[0].qty, weight: order.lines[0].weight, lineComplete: true }],
        containers: [], serials: [],
      })),
    }, { canOverrideCreditHold: false }));

    await publishWithLogo("MOS_SHIPPER", customer.id, null);
    await timed("tickets, 20 orders, no logo", () => asSystem(() => printShippingTickets(shipper.id)));
    await publishWithLogo("MOS_SHIPPER", customer.id, { data: png, mime: "image/png" });
    await timed("tickets, 20 orders, 512 KB alpha PNG", () => asSystem(() => printShippingTickets(shipper.id)));
    await publishWithLogo("MOS_SHIPPER", customer.id, { data: jpeg, mime: "image/jpeg" });
    await timed("tickets, 20 orders, 512 KB JPEG", () => asSystem(() => printShippingTickets(shipper.id)));
  }, 300_000);
});
