import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, seedOrderGatePrereqs, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { drawnPages, paintedImageCounts } from "./helpers/pdf";
import { runWithContext } from "@/server/context";
import { createOrder, voidOrder } from "@/server/orders";
import { replaceLoads } from "@/server/order-loads";
import { getDocument, listDocumentsForOrder, resolveDocumentFilename } from "@/server/documents";
import { printSelectedTraveler, printTraveler } from "@/server/traveler";
import { printExpectationFor } from "@/server/traveler-identity";
import { travelerCoverageLabel } from "@/lib/traveler-selection";
import * as rendering from "@/server/pdf/render";
import * as locks from "@/server/order-locks";
import { POST } from "@/app/api/orders/[id]/traveler/route";
import { GET as download } from "@/app/api/documents/[docId]/route";

const asSystem = <T>(fn: () => Promise<T>) =>
  runWithContext({ actor: { id: null, name: "selected-load-test" }, user: null }, fn);

async function fixture(stepCount = 1) {
  const customer = await prisma.customer.create({ data: { code: "SELECT", name: "Selected Loads Demo" } });
  const code = await prisma.processStepCode.create({ data: { code: "HT", name: "Heat" } });
  const part = await prisma.part.create({ data: {
    customerId: customer.id, partNumber: "SELECT-1", eachWeight: "1.0000", loadQty: 10,
  } });
  const revision = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  await prisma.partProcessStep.createMany({ data: Array.from({ length: stepCount }, (_, i) => ({
    revisionId: revision.id, position: i + 1, codeId: code.id,
    instruction: stepCount === 1 ? "Heat selected work" :
      "Hold at the specified temperature until the part core reaches temperature. Verify the thermocouple reading against the pyrometer log, then transfer to the quench within the allowed window and record the elapsed transfer time on this line before the next step begins.",
  })) });
  const { order } = await asSystem(() => createOrder({
    customerId: customer.id, lines: [{ partId: part.id, qty: 30, weight: "30.00" }],
  }));
  return order;
}

function printRequest(orderId: string, cookie: string, body: unknown, query = "") {
  return POST(new Request(`http://t/api/orders/${orderId}/traveler${query}`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: orderId }) });
}

function retainPdf(name: string, pdf: Buffer, orderNumber: number, pageLoads: number[]) {
  const directory = process.env.SELECTED_TRAVELER_EVIDENCE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `${name}.pdf`), pdf);
  writeFileSync(path.join(directory, `${name}.json`), JSON.stringify({
    file: `${name}.pdf`, orderNumber, selectedLoads: [1, 3],
    pages: pageLoads.map((loadNumber, index) => ({ page: index + 1, loadNumber, barcode: `${orderNumber}-${loadNumber}` })),
  }, null, 2));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("selected-load traveler route and permanent archive", () => {
  beforeEach(async () => { await truncateAll(); await seedOrderGatePrereqs(); });

  it("selecting loads 3,1 prints one PDF in ascending order and archives only loads 1,3", async () => {
    const order = await fixture();
    const cookie = await signInWith(["orders.view"]);
    const response = await printRequest(order.id, cookie, { selection: { mode: "loads", loadNumbers: [3, 1] } });
    expect(response.status).toBe(200);
    const pdf = Buffer.from(await response.arrayBuffer());
    const pages = drawnPages(pdf);
    expect(pages).toHaveLength(2);
    // The header draws the order and load in adjacent columns; the barcode is an image.
    expect(pages[0]).toContain(`${order.orderNumber}1`);
    expect(pages[1]).toContain(`${order.orderNumber}3`);
    expect(pages.join("\n")).not.toContain(`${order.orderNumber}2`);
    expect(paintedImageCounts(pdf)).toEqual([1, 1]);
    retainPdf("selected-loads", pdf, order.orderNumber, [1, 3]);
    const docs = await listDocumentsForOrder(order.id);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ loadNumber: null, travelerLoadNumbers: [1, 3] });
    expect(response.headers.get("x-document-id")).toBe(docs[0].id);
    expect(response.headers.get("content-disposition")).toContain(`traveler-${order.orderNumber}-selected-loads.pdf`);
    expect((await getDocument(docs[0].id)).fileData.equals(pdf)).toBe(true);
    const audits = await prisma.auditLog.findMany({ where: { entity: "storedDocument", entityId: docs[0].id } });
    expect(audits).toHaveLength(1);
    expect(audits[0].after).toMatchObject({ loadNumber: null, travelerLoadNumbers: [1, 3] });
  });

  it("refuses an empty selected set before archiving", async () => {
    const order = await fixture();
    const cookie = await signInWith(["orders.view"]);
    const response = await printRequest(order.id, cookie, { selection: { mode: "loads", loadNumbers: [] } });
    expect(response.status).toBe(400);
    expect(await listDocumentsForOrder(order.id)).toHaveLength(0);
  });

  it("refuses duplicate, invalid, oversized, unknown and missing selections without rendering or archiving", async () => {
    const order = await fixture();
    const cookie = await signInWith(["orders.view"]);
    const render = vi.spyOn(rendering, "renderSheetGroups");
    try {
      const bad: [unknown, number, string?][] = [
        ...[[1, 1], [-1], [0], [1.5], ["1"], [null], Array.from({ length: 101 }, (_, i) => i + 1)]
          .map(loadNumbers => [{ selection: { mode: "loads", loadNumbers } }, 400] as [unknown, number]),
        [{ selection: { mode: "loads", loadNumbers: [1, 4] } }, 404],
        [{ selection: { mode: "loads", loadNumbers: [1, 3] }, extra: true }, 400],
        [{ selection: { mode: "loads", loadNumbers: [1], extra: true } }, 400],
        [{ selection: { mode: "all", loadNumbers: [1] } }, 400],
        [{ selection: { mode: "all" }, expectedPrintFingerprint: "" }, 400],
        [{ selection: { mode: "all" } }, 400, "?load=1"],
        [{ selection: { mode: "all" } }, 400, "?unknown=yes"],
        [null, 400], [{}, 400],
      ];
      for (const [body, status, query] of bad) {
        const response = await printRequest(order.id, cookie, body, query);
        expect(response.status, JSON.stringify(body)).toBe(status);
      }
      const malformedJson = await POST(new Request(`http://t/api/orders/${order.id}/traveler`, {
        method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{",
      }), { params: Promise.resolve({ id: order.id }) });
      expect(malformedJson.status).toBe(400);
      expect(render).not.toHaveBeenCalled();
      expect(await listDocumentsForOrder(order.id)).toHaveLength(0);
    } finally { render.mockRestore(); }
  });

  it("preserves orders.view and void guards for selected requests", async () => {
    const order = await fixture();
    const wrong = await signInWith(["parts.view"], "wrong");
    const right = await signInWith(["orders.view"], "right");
    const body = { selection: { mode: "loads", loadNumbers: [1, 3] } };
    expect((await printRequest(order.id, "", body)).status).toBe(401);
    expect((await printRequest(order.id, wrong, body)).status).toBe(403);
    await asSystem(() => voidOrder(order.id, "fixture void"));
    expect((await printRequest(order.id, right, body)).status).toBe(400);
    expect(await listDocumentsForOrder(order.id)).toHaveLength(0);
  });

  it("keeps legacy all/single requests and stores a selected singleton as a single-load archive", async () => {
    const order = await fixture();
    const cookie = await signInWith(["orders.view"]);
    for (const [query, expectedPages, loadNumber] of [["", 3, null], ["?load=2", 1, 2]] as const) {
      const response = await POST(new Request(`http://t/api/orders/${order.id}/traveler${query}`, {
        method: "POST", headers: { cookie },
      }), { params: Promise.resolve({ id: order.id }) });
      expect(response.status).toBe(200);
      expect(drawnPages(Buffer.from(await response.arrayBuffer()))).toHaveLength(expectedPages);
      expect(await getDocument(response.headers.get("x-document-id")!)).toMatchObject({ loadNumber, travelerLoadNumbers: [] });
      expect(response.headers.get("content-disposition")).toContain(loadNumber === null
        ? `traveler-${order.orderNumber}.pdf` : `traveler-${order.orderNumber}-load-2.pdf`);
    }
    const single = await asSystem(() => printSelectedTraveler(order.id, { mode: "loads", loadNumbers: [3] }));
    expect(single).toMatchObject({ loadNumber: 3, travelerLoadNumbers: [] });
    expect(await getDocument(single.documentId)).toMatchObject({ loadNumber: 3, travelerLoadNumbers: [] });
    // Legacy imported orders may have no loads; the current editor requires at least one.
    await prisma.load.deleteMany({ where: { orderId: order.id } });
    const bare = await asSystem(() => printTraveler(order.id));
    expect(drawnPages(bare.pdf)).toHaveLength(1);
    expect(bare).toMatchObject({ loadNumber: null, travelerLoadNumbers: [] });
    await expect(asSystem(() => printSelectedTraveler(order.id, { mode: "loads", loadNumbers: [1] })))
      .rejects.toMatchObject({ status: 404 });
  });

  it("renders a selected 100-load boundary even when the order has 101 loads", async () => {
    const order = await fixture();
    await asSystem(() => replaceLoads(order.id, Array.from({ length: 101 }, (_, i) => ({ loadNumber: i + 1, qty: 1, weight: "1.00" }))));
    const printed = await asSystem(() => printSelectedTraveler(order.id, {
      mode: "loads", loadNumbers: Array.from({ length: 100 }, (_, i) => 100 - i),
    }));
    expect(drawnPages(printed.pdf)).toHaveLength(100);
    expect(printed.travelerLoadNumbers).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    await expect(asSystem(() => printTraveler(order.id))).rejects.toMatchObject({ status: 400 });
    expect(await listDocumentsForOrder(order.id)).toHaveLength(1);
  }, 20000);

  it("keeps selected archive coverage and bytes after loads are replaced and renumbered", async () => {
    const order = await fixture();
    const printed = await asSystem(() => printSelectedTraveler(order.id, { mode: "loads", loadNumbers: [3, 1] }));
    await asSystem(() => replaceLoads(order.id, [{ loadNumber: 1, qty: 30, weight: "30.00" }]));
    const archived = await getDocument(printed.documentId);
    expect(travelerCoverageLabel(archived)).toBe("Loads 1, 3");
    expect(archived.fileData.equals(printed.pdf)).toBe(true);
    expect(await resolveDocumentFilename(archived)).toBe(`traveler-${order.orderNumber}-selected-loads.pdf`);
    expect((await listDocumentsForOrder(order.id))[0].travelerLoadNumbers).toEqual([1, 3]);
    const cookie = await signInWith(["orders.view"]);
    const response = await download(new Request(`http://t/api/documents/${printed.documentId}`, {
      headers: { cookie },
    }), { params: Promise.resolve({ docId: printed.documentId }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(`traveler-${order.orderNumber}-selected-loads.pdf`);
    expect(Buffer.from(await response.arrayBuffer()).equals(printed.pdf)).toBe(true);
  });

  it("uses each selected load's identity on every actual continuation page", async () => {
    const order = await fixture(25);
    const printed = await asSystem(() => printSelectedTraveler(order.id, { mode: "loads", loadNumbers: [3, 1] }));
    const pages = drawnPages(printed.pdf);
    expect(pages.length).toBeGreaterThanOrEqual(4);
    const secondGroup = pages.findIndex(text => text.includes(`${order.orderNumber}3`));
    expect(secondGroup).toBeGreaterThanOrEqual(2);
    expect(pages.length - secondGroup).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < pages.length; i++) {
      const load = i < secondGroup ? 1 : 3;
      if (i === 0 || i === secondGroup) expect(pages[i]).toContain(`${order.orderNumber}${load}`);
      else {
        expect(pages[i]).toContain(`Order Number ${order.orderNumber}`);
        expect(pages[i]).toContain(`Load ${load}`);
        expect(pages[i]).toContain("(continued)");
      }
      expect(pages[i]).not.toContain("Load 2");
      expect(paintedImageCounts(printed.pdf)[i]).toBeGreaterThanOrEqual(1);
    }
    retainPdf("selected-continuations", printed.pdf, order.orderNumber,
      pages.map((_, i) => i < secondGroup ? 1 : 3));
  });

  it("rejects an expectation made before a committed load change before rendering", async () => {
    const order = await fixture();
    const cookie = await signInWith(["orders.view"]);
    await asSystem(() => replaceLoads(order.id, [{ loadNumber: 1, qty: 30, weight: "30.00" }]));
    const render = vi.spyOn(rendering, "renderSheetGroups");
    try {
      const response = await printRequest(order.id, cookie, {
        selection: { mode: "loads", loadNumbers: [1] }, expectedPrintFingerprint: printExpectationFor(order),
      });
      expect(response.status).toBe(412);
      expect(await response.json()).toMatchObject({ error: "The saved load plan changed. Review the order before printing." });
      expect(render).not.toHaveBeenCalled();
      expect(await listDocumentsForOrder(order.id)).toHaveLength(0);
    } finally { render.mockRestore(); }
  });

  it("checks the expectation after a competing writer releases the order claim", async () => {
    const order = await fixture();
    const held = deferred(); const release = deferred(); const attempting = deferred();
    const realClaim = locks.claimOrder;
    const holder = prisma.$transaction(async tx => {
      await realClaim(tx, order.id);
      held.resolve();
      await release.promise;
      await tx.load.updateMany({ where: { orderId: order.id, loadNumber: 1 }, data: { qty: 11 } });
    }, { timeout: 10000 });
    await held.promise;
    const claim = vi.spyOn(locks, "claimOrder").mockImplementation(async (...args) => {
      attempting.resolve();
      return realClaim(...args);
    });
    const render = vi.spyOn(rendering, "renderSheetGroups");
    const print = asSystem(() => printSelectedTraveler(order.id, { mode: "loads", loadNumbers: [1, 3] }, printExpectationFor(order)));
    const outcome = print.then(value => ({ value }), error => ({ error }));
    try {
      await attempting.promise;
      release.resolve();
      await holder;
      expect(await outcome).toMatchObject({ error: { status: 412 } });
      expect(render).not.toHaveBeenCalled();
      expect(await listDocumentsForOrder(order.id)).toHaveLength(0);
    } finally {
      release.resolve();
      await Promise.allSettled([holder, print]);
      claim.mockRestore(); render.mockRestore();
    }
  });

  it("holds the real print claim through rendering and archival while another writer waits", async () => {
    const order = await fixture();
    const entered = deferred(); const release = deferred(); const writerAttempt = deferred();
    const realRender = rendering.renderSheetGroups;
    const realClaim = locks.claimOrder;
    const render = vi.spyOn(rendering, "renderSheetGroups").mockImplementation(async (...args) => {
      entered.resolve(); await release.promise; return realRender(...args);
    });
    let claimCount = 0;
    const claim = vi.spyOn(locks, "claimOrder").mockImplementation(async (...args) => {
      if (++claimCount === 2) writerAttempt.resolve();
      return realClaim(...args);
    });
    const print = asSystem(() => printSelectedTraveler(order.id, { mode: "loads", loadNumbers: [1, 3] }, printExpectationFor(order)));
    let writer: ReturnType<typeof replaceLoads> | undefined;
    try {
      await Promise.race([entered.promise, print.then(() => { throw new Error("Print skipped the render barrier"); })]);
      writer = asSystem(() => replaceLoads(order.id, [{ loadNumber: 1, qty: 30, weight: "30.00" }]));
      await writerAttempt.promise;
      expect(await Promise.race([writer.then(() => "settled"), new Promise(resolve => setTimeout(() => resolve("blocked"), 100))])).toBe("blocked");
      release.resolve();
      const printed = await print;
      const changed = await writer;
      expect(changed.loads).toHaveLength(1);
      expect(drawnPages(printed.pdf)).toHaveLength(2);
      const archived = await getDocument(printed.documentId);
      expect(archived.travelerLoadNumbers).toEqual([1, 3]);
      expect(archived.fileData.equals(printed.pdf)).toBe(true);
    } finally {
      release.resolve();
      await Promise.allSettled([print, ...(writer ? [writer] : [])]);
      claim.mockRestore(); render.mockRestore();
    }
  });
});
