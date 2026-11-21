import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, truncateAll, seedOrderGatePrereqs } from "./helpers/db";
import { drawnText, pageCount, paintedImageCounts, textLinesWithY, textRunsWithY } from "./helpers/pdf";
import { standardLayout } from "./helpers/canvas-fixtures";
import { defaultConfigFor, validateConfig } from "@/lib/template-contracts";
import { runWithContext } from "@/server/context";
import { createOrder } from "@/server/orders";
import { saveRecipeNumber } from "@/server/part-process-steps";
import { readProcessDocument, saveProcessDocument } from "@/server/process-document";
import { listProcessPreviewContexts, renderProcessTravelerPreview } from "@/server/process-traveler-preview";
import { assignTemplate } from "@/server/template-assignments";
import { createTemplate, publishDraft } from "@/server/templates";
import { collectTravelerData, buildTravelerDefinitions, printTraveler } from "@/server/traveler";
import { renderSheetGroups, DRAFT_PROCESS_PREVIEW_LABEL } from "@/server/pdf/render";
import * as pdfRenderer from "@/server/pdf/render";
import * as traveler from "@/server/traveler";
import * as travelerSample from "@/server/traveler-sample";
import * as mutations from "@/server/part-process-steps";
const system = <T>(fn: () => Promise<T>) => runWithContext({ actor: { id: null, name: "test" }, user: null }, fn);
/** A caller who may view orders and customers. Every call passes its access explicitly: the service
 *  has no default, so a caller that forgets it cannot be granted order access. */
const FULL = { orders: true, customers: true } as const;
async function fixture(numbered = false) {
  const customer = await prisma.customer.create({ data: { code: "PREVIEW", name: "Preview fixture" } });
  const code = await prisma.processStepCode.create({ data: { code: "HEAT", name: "Standard heat" } });
  const field = await prisma.processStepFieldDef.create({ data: { codeId: code.id, label: "Temperature", type: "NUMBER", unit: "F", sort: 1 } });
  const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P1", eachWeight: 1, loadQty: 5 } });
  const other = await prisma.part.create({ data: { customerId: customer.id, partNumber: "P2", eachWeight: 1 } });
  const revision = await prisma.partProcessRevision.create({ data: { partId: part.id, revisionNumber: 1 } });
  await prisma.partProcessStep.create({ data: { revisionId: revision.id, position: 1, codeId: code.id, instruction: "Saved instruction",
    parameters: { create: { position: 0, key: field.id, label: "Temperature", type: "NUMBER", unit: "F", value: "12.50" } } } });
  if (numbered) await prisma.processStepFieldDef.create({ data: { codeId: code.id, label: "Optional", type: "TEXT", sort: 2 } });
  if (numbered) await system(() => saveRecipeNumber(part.id, { recipeNumber: "0055", expectedRecipeNumber: null }));
  const { order } = await system(() => createOrder({ customerId: customer.id, lines: [{ partId: part.id, qty: 10, weight: "10" }] }));
  const baseline = await readProcessDocument(part.id);
  const input = { expectedBaselineToken: baseline.baselineToken, generation: 7, context: { orderId: order.id, orderNumber: order.orderNumber, loadNumber: 1 },
    steps: baseline.revision!.steps.map(s => ({ clientId: s.id, stepId: s.id, codeId: s.codeId, instruction: s.instruction, parameters: s.parameters.map(p => ({ key: p.key, label: p.label, type: p.type, unit: p.unit, value: p.value })) })) };
  return { part, other, code, field, order, input };
}
/** A part with no order at all, whose customer has a received-from address and a phone: the
 *  SAMPLE preview's first case (spec 2026-09-26 §5). */
async function samplePart() {
  const customer = await prisma.customer.create({ data: { code: "CONTACT", name: "Contact fixture", phone: "555-0177" } });
  await prisma.customerAddress.create({ data: { customerId: customer.id, kind: "RECEIVED_FROM", street: "77 Preview Street", city: "Fixture City", state: "AL", zip: "35001", isDefault: true } });
  const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "PRV-5150", name: "Preview bracket", eachWeight: 2, processName: "Austemper preview" } });
  const baseline = await readProcessDocument(part.id);
  return { customer, part, input: { expectedBaselineToken: baseline.baselineToken, generation: 1, context: null, steps: [] } };
}
/** An order whose lead line is `partId`, with loads created in the given (deliberately unsorted) order. */
async function orderWithLoads(customerId: string, partId: string, orderNumber: number, loadNumbers: number[], deletedAt: Date | null = null) {
  return prisma.order.create({ data: { customerId, orderNumber, receivedDate: new Date(), requestDate: new Date(), deletedAt,
    lines: { create: { partId, position: 1, qty: 1, weight: 1 } },
    loads: { create: loadNumbers.map(loadNumber => ({ loadNumber, qty: 1, weight: 1 })) } } });
}
async function state() {
  return Promise.all([prisma.order.findMany(), prisma.part.findMany(), prisma.partProcessRevision.findMany(), prisma.partProcessStep.findMany(), prisma.partProcessStepParameter.findMany(), prisma.auditLog.findMany(), prisma.setting.findMany(), prisma.storedDocument.findMany(), prisma.load.findMany(), prisma.partRecipe.findMany(), prisma.recipeSnapshotField.findMany()]);
}
/** Every application table's row count, one query at a time. */
async function everyTableCount(): Promise<Record<string, number>> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename`;
  const counts: Record<string, number> = {};
  for (const { tablename } of tables) {
    counts[tablename] = Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${tablename}"`))[0].n);
  }
  return counts;
}
/** Counts the transactions `fn` opens. Plain save/restore of the client's own method, never
 *  `vi.spyOn` (CLAUDE.md): restoring a spy on this client can leave the shared singleton broken. */
async function countTransactions(fn: () => Promise<unknown>): Promise<number> {
  const client = prisma as unknown as Record<string, unknown>;
  const real = client.$transaction as (...args: unknown[]) => unknown;
  let opened = 0;
  client.$transaction = (...args: unknown[]) => { opened++; return real.apply(prisma, args); };
  try { await fn(); } finally { client.$transaction = real; }
  return opened;
}
const sampleRuns = (pdf: Buffer, page = 0) => textRunsWithY(pdf)[page].filter(r => r.text === "SAMPLE");
beforeEach(async () => { vi.restoreAllMocks(); await truncateAll(); await seedOrderGatePrereqs(); });
describe("read-only process traveler", () => {
  it("an order context reads no locked revision, which the draft's own steps replace, while the print path reads it (#660)", async () => {
    const f = await fixture();
    const read = vi.spyOn(mutations, "getRevision");
    try {
      await renderProcessTravelerPreview(f.part.id, f.input, FULL);
      expect(read).not.toHaveBeenCalled();
      await collectTravelerData(f.order.id, 1);
      expect(read).toHaveBeenCalledTimes(1);
    } finally { read.mockRestore(); }
  });
  it("uses production layout for exactly one saved load and preserves actual archived bytes and database state", async () => {
    const f = await fixture();
    await system(() => printTraveler(f.order.id, 1));
    const archived = await prisma.storedDocument.findFirstOrThrow();
    const hash = createHash("sha256").update(archived.fileData).digest("hex");
    const before = await state();
    const production = await renderSheetGroups(buildTravelerDefinitions(await collectTravelerData(f.order.id, 1)));
    for (const name of ["claimProcessForEdit", "ensureWorkingProcess", "lockRevision", "replaceStepParameters"] as const) vi.spyOn(mutations, name).mockImplementation(async () => { throw new Error("Forbidden preview mutation"); });
    const result = await renderProcessTravelerPreview(f.part.id, f.input, FULL);
    expect(result.generation).toBe(7);
    expect(result.sample).toBe(false);
    expect(sampleRuns(result.pdf)).toEqual([]);
    expect(result.pageCount).toBe(pageCount(production));
    expect(drawnText(result.pdf).replaceAll(DRAFT_PROCESS_PREVIEW_LABEL, "")).toBe(drawnText(production));
    expect(await state()).toEqual(before);
    const after = await prisma.storedDocument.findUniqueOrThrow({ where: { id: archived.id } });
    expect(Buffer.from(after.fileData)).toEqual(Buffer.from(archived.fileData));
    expect(createHash("sha256").update(after.fileData).digest("hex")).toBe(hash);
  });
  it("renders local instructions and typed rows, empty values included, with continuation identity without saving", async () => {
    const f = await fixture();
    f.input.steps[0].instruction = "LOCAL-INSTRUCTION ".repeat(220);
    f.input.steps[0].parameters.push({ key: `new:${randomUUID()}`, label: "Basket", type: "TEXT", unit: null, value: "" });
    const before = await state();
    const result = await renderProcessTravelerPreview(f.part.id, f.input, FULL);
    expect(result.pageCount).toBeGreaterThan(1);
    const text = drawnText(result.pdf);
    expect(text).toContain("LOCAL-INSTRUCTION"); expect(text).not.toContain("Saved instruction");
    expect(text).toContain("12.50"); expect(text).toContain("Basket:"); expect(text).toContain("(continued)"); expect(text).toContain(String(f.order.orderNumber));
    expect(await state()).toEqual(before);
  });
  it("rejects a stale baseline, invalid row values and inactive insertions, and ignores a suggestion edit", async () => {
    const f = await fixture();
    await expect(renderProcessTravelerPreview(f.part.id, { ...f.input, expectedBaselineToken: "stale" }, FULL)).rejects.toMatchObject({ status: 409 });
    const invalid = structuredClone(f.input); invalid.steps[0].parameters[0].value = "nope";
    await expect(renderProcessTravelerPreview(f.part.id, invalid, FULL)).rejects.toMatchObject({ status: 400, message: `"nope" is not a valid number for Temperature` });
    await prisma.processStepCode.update({ where: { id: f.code.id }, data: { active: false } });
    await expect(renderProcessTravelerPreview(f.part.id, { ...f.input, steps: [{ ...f.input.steps[0], stepId: null, clientId: `new:${randomUUID()}` }] }, FULL)).rejects.toMatchObject({ status: 400 });
    // A suggestion's unit is not the row's (spec 2026-09-26 §3.2): the open document still renders.
    await prisma.processStepFieldDef.update({ where: { id: f.field.id }, data: { unit: "C" } });
    expect(drawnText((await renderProcessTravelerPreview(f.part.id, f.input, FULL)).pdf)).toContain("12.50 F");
  });
  it("previews a captured revision from its rows, unchanged or edited, and saves without a metadata refusal (owner 2026-09-27)", async () => {
    const f = await fixture(true);
    // A snapshot captured before part-owned rows: a captured label that differs from the row's,
    // and an unset field that has no row. Orders on the revision still print it; the editor
    // previews and edits the rows.
    const revision = await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: f.part.id } });
    const snapshot = JSON.parse(JSON.stringify(revision.recipeSnapshot));
    snapshot.steps[0].fields[0].label = "Captured temperature";
    snapshot.steps[0].fields.push({ fieldDefId: "ghost", label: "Ghost", type: "TEXT", unit: null, position: 1, value: null });
    await prisma.partProcessRevision.update({ where: { id: revision.id }, data: { recipeSnapshot: snapshot } });
    const baseline = await readProcessDocument(f.part.id);
    f.input.expectedBaselineToken = baseline.baselineToken;
    const unchanged = drawnText((await renderProcessTravelerPreview(f.part.id, f.input, FULL)).pdf);
    expect(unchanged).toContain("Temperature: 12.50 F"); expect(unchanged).not.toContain("Captured temperature"); expect(unchanged).not.toContain("Ghost");
    expect(drawnText((await printTraveler(f.order.id, 1)).pdf)).toContain("Captured temperature: 12.50 F");
    f.input.steps[0].instruction = "Changed instruction";
    const edited = drawnText((await renderProcessTravelerPreview(f.part.id, f.input, FULL)).pdf);
    expect(edited).toContain("Changed instruction"); expect(edited).toContain("Temperature: 12.50 F"); expect(edited).not.toContain("Ghost");
    const saved = await system(() => saveProcessDocument(f.part.id, { expectedBaselineToken: f.input.expectedBaselineToken, steps: f.input.steps }));
    expect(saved.baseline.revision?.revisionNumber).toBe(2);
    expect(saved.baseline.revision?.steps[0].parameters.map(p => p.label)).toEqual(["Temperature"]);
    expect((await prisma.partProcessRevision.findUniqueOrThrow({ where: { id: revision.id } })).recipeSnapshot).toEqual(snapshot);
  });
  describe("resolves the assigned layout from the same snapshot even when its configuration changes mid-read", () => {
    /** Relabels the default traveler's order-number field in its published config. */
    async function relabeller() {
      const template = await prisma.documentTemplate.findFirstOrThrow({ where: { docType: "TRAVELER", isDefault: true } });
      const version = await prisma.documentTemplateVersion.findUniqueOrThrow({ where: { id: template.publishedVersionId! } });
      const config = JSON.parse(JSON.stringify(version.config));
      const field = config.sections.find((s: { key: string }) => s.key === "header").fields.find((v: { key: string }) => v.key === "order_number");
      return (label: string) => { field.label = label; return prisma.documentTemplateVersion.update({ where: { id: version.id }, data: { config } }); };
    }
    it("for an order", async () => {
      const f = await fixture();
      const relabel = await relabeller();
      await relabel("SNAPSHOT-BEFORE");
      const read = traveler.readTravelerData;
      vi.spyOn(traveler, "readTravelerData").mockImplementationOnce(async (...args) => { await relabel("SNAPSHOT-AFTER"); return read(...args); });
      const text = drawnText((await renderProcessTravelerPreview(f.part.id, f.input, FULL)).pdf);
      expect(text).toContain("SNAPSHOT-BEFORE");
      expect(text).not.toContain("SNAPSHOT-AFTER");
    });
    it("for a SAMPLE", async () => {
      const f = await fixture();
      const relabel = await relabeller();
      await relabel("SNAPSHOT-BEFORE");
      const read = travelerSample.readSampleTravelerData;
      vi.spyOn(travelerSample, "readSampleTravelerData").mockImplementationOnce(async (...args) => { await relabel("SNAPSHOT-AFTER"); return read(...args); });
      const text = drawnText((await renderProcessTravelerPreview(f.part.id, { ...f.input, context: null }, FULL)).pdf);
      expect(text).toContain("SNAPSHOT-BEFORE");
      expect(text).not.toContain("SNAPSHOT-AFTER");
    });
  });
  it("renders a captured revision's rows even when its captured metadata is oversized, leaving the snapshot alone", async () => {
    const f = await fixture(true);
    const revision = await prisma.partProcessRevision.findFirstOrThrow({ where: { partId: f.part.id } });
    const snapshot = JSON.parse(JSON.stringify(revision.recipeSnapshot));
    snapshot.steps[0].fields[0].label = "x".repeat(1024 * 1024);
    await prisma.partProcessRevision.update({ where: { id: revision.id }, data: { recipeSnapshot: snapshot } });
    const baseline = await readProcessDocument(f.part.id);
    f.input.expectedBaselineToken = baseline.baselineToken;
    const result = await renderProcessTravelerPreview(f.part.id, f.input, FULL);
    expect(drawnText(result.pdf)).toContain("Temperature: 12.50 F");
    expect((await prisma.partProcessRevision.findUniqueOrThrow({ where: { id: revision.id } })).recipeSnapshot).toEqual(snapshot);
  });
  it("refuses an oversized document before rendering and reads settings only on the transaction, for an order and a SAMPLE", async () => {
    const f = await fixture();
    // Plain save/restore of the delegate's method, never `vi.spyOn` on a Prisma model delegate
    // (CLAUDE.md): `mockRestore()` does not put the original back on this client.
    const settings = prisma.setting as unknown as Record<string, unknown>;
    const findUnique = settings.findUnique;
    settings.findUnique = () => { throw new Error("Settings escaped snapshot"); };
    try {
      expect((await renderProcessTravelerPreview(f.part.id, f.input, FULL)).pageCount).toBeGreaterThan(0);
      expect((await renderProcessTravelerPreview(f.part.id, { ...f.input, context: null }, FULL)).pageCount).toBeGreaterThan(0);
    } finally { settings.findUnique = findUnique; }
    vi.spyOn(pdfRenderer, "renderDraftTraveler").mockImplementation(() => { throw new Error("Oversized document reached rendering"); });
    const rows = Array.from({ length: 30 }, (_, i) => ({ key: `new:${randomUUID()}`, label: `Row ${i}`, type: "TEXT" as const, unit: null, value: "v".repeat(500) }));
    const input = { ...f.input, steps: Array.from({ length: 80 }, () => ({ clientId: `new:${randomUUID()}`, stepId: null, codeId: f.code.id, instruction: "", parameters: rows })) };
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(1024 * 1024);
    // Both headers (whole-branch review, Minor 4): the SAMPLE first, so a mutation reaching
    // rendering names the SAMPLE path.
    await expect(renderProcessTravelerPreview(f.part.id, { ...input, context: null }, FULL)).rejects.toThrow(/1 MiB/);
    await expect(renderProcessTravelerPreview(f.part.id, input, FULL)).rejects.toThrow(/1 MiB/);
  });
  it("refuses missing orders, wrong numbers, rider-only parts, voided orders and removed loads", async () => {
    const f = await fixture();
    await expect(renderProcessTravelerPreview(f.part.id, { ...f.input, context: { ...f.input.context, orderId: "missing" } }, FULL)).rejects.toMatchObject({ status: 404 });
    await expect(renderProcessTravelerPreview(f.part.id, { ...f.input, context: { ...f.input.context, orderNumber: 999 } }, FULL)).rejects.toMatchObject({ status: 409 });
    await prisma.orderLine.create({ data: { orderId: f.order.id, position: 2, partId: f.other.id, qty: 1, weight: 1 } });
    expect((await listProcessPreviewContexts(f.other.id, "")).items).toEqual([]);
    await expect(renderProcessTravelerPreview(f.other.id, f.input, FULL)).rejects.toMatchObject({ status: 409 });
    await prisma.load.deleteMany({ where: { orderId: f.order.id } });
    expect((await listProcessPreviewContexts(f.part.id, "")).items).toEqual([]);
    await expect(renderProcessTravelerPreview(f.part.id, f.input, FULL)).rejects.toMatchObject({ status: 404 });
    await prisma.order.update({ where: { id: f.order.id }, data: { deletedAt: new Date() } });
    await expect(renderProcessTravelerPreview(f.part.id, f.input, FULL)).rejects.toMatchObject({ status: 404 });
  });
  it("paginates existing contexts by order then load, searches order numbers and handles no order", async () => {
    const f = await fixture();
    await prisma.load.createMany({ data: Array.from({ length: 28 }, (_, i) => ({ orderId: f.order.id, loadNumber: i + 3, qty: 1, weight: 1 })) });
    const first = await listProcessPreviewContexts(f.part.id, String(f.order.orderNumber));
    expect(first.items.map(c => c.loadNumber)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(first.nextCursor).not.toBeNull();
    const second = await listProcessPreviewContexts(f.part.id, "", first.nextCursor!);
    expect(second.items.map(c => c.loadNumber)).toEqual([26, 27, 28, 29, 30]); expect(second.nextCursor).toBeNull();
    expect((await listProcessPreviewContexts(f.part.id, "999999")).items).toEqual([]);
    expect((await listProcessPreviewContexts(f.other.id, "")).items).toEqual([]);
  });
});

describe("preview contexts, newest first (spec 2026-09-26 §5)", () => {
  async function listPart() {
    const customer = await prisma.customer.create({ data: { code: "LIST", name: "List fixture" } });
    const part = await prisma.part.create({ data: { customerId: customer.id, partNumber: "LIST-1", eachWeight: 1 } });
    return { customerId: customer.id, partId: part.id };
  }
  const labels = (items: { orderNumber: number; loadNumber: number }[]) => items.map(c => `${c.orderNumber}·${c.loadNumber}`);
  it("lists the highest order number first with its loads ascending, and leaves a voided order out", async () => {
    const { customerId, partId } = await listPart();
    const o1001 = await orderWithLoads(customerId, partId, 1001, [1]);
    const o1003 = await orderWithLoads(customerId, partId, 1003, [2, 1]);
    const o1002 = await orderWithLoads(customerId, partId, 1002, [1]);
    // Voided, and the highest number of all: listed first if the exclusion were missing.
    await orderWithLoads(customerId, partId, 1004, [1], new Date());
    const { items, nextCursor } = await listProcessPreviewContexts(partId, "");
    // The first item is the default the dialog selects: the newest order with its lowest load.
    expect(items).toEqual([
      { orderId: o1003.id, orderNumber: 1003, loadNumber: 1 },
      { orderId: o1003.id, orderNumber: 1003, loadNumber: 2 },
      { orderId: o1002.id, orderNumber: 1002, loadNumber: 1 },
      { orderId: o1001.id, orderNumber: 1001, loadNumber: 1 },
    ]);
    expect(nextCursor).toBeNull();
  });
  it("pages newest first: the cursor continues through the same order's loads, then down the order numbers", async () => {
    const { customerId, partId } = await listPart();
    const top = Array.from({ length: 24 }, (_, i) => i + 1);
    await orderWithLoads(customerId, partId, 3000, [...top].reverse());
    await orderWithLoads(customerId, partId, 2999, [3, 1, 2]);
    await orderWithLoads(customerId, partId, 2998, [1]);
    await orderWithLoads(customerId, partId, 3001, [1], new Date());
    const first = await listProcessPreviewContexts(partId, "");
    expect(labels(first.items)).toEqual([...top.map(n => `3000·${n}`), "2999·1"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await listProcessPreviewContexts(partId, "", first.nextCursor!);
    expect(labels(second.items)).toEqual(["2999·2", "2999·3", "2998·1"]);
    expect(second.nextCursor).toBeNull();
  });
});

describe("SAMPLE preview (spec 2026-09-26 §5)", () => {
  it("an added step whose code was renamed since it was added answers the save's own 409 (R11, #659)", async () => {
    const f = await fixture();
    const s = await samplePart();
    const added = { clientId: `new:${randomUUID()}`, stepId: null, codeId: f.code.id, codeSeen: { code: "HEAT", name: "Standard heat" }, instruction: "", parameters: [] };
    await prisma.processStepCode.update({ where: { id: f.code.id }, data: { name: "Renamed heat" } });
    await expect(renderProcessTravelerPreview(s.part.id, { ...s.input, steps: [added] }, FULL)).rejects.toMatchObject({ status: 409, message: "The process changed — reload before saving" });
    await expect(renderProcessTravelerPreview(s.part.id, { ...s.input, steps: [{ ...added, codeSeen: { code: "HEAT", name: "Renamed heat" } }] }, FULL)).resolves.toMatchObject({ sample: true });
  });
  it("renders context null as a SAMPLE around the draft: SAMPLE order, load and barcode, and the part's own details", async () => {
    const f = await fixture();
    const s = await samplePart();
    const input = { ...s.input, generation: 11, steps: [{
      clientId: `new:${randomUUID()}`, stepId: null, codeId: f.code.id, codeSeen: { code: "HEAT", name: "Standard heat" }, instruction: "Draft-only instruction",
      parameters: [
        { key: f.field.id, label: "Temperature", type: "NUMBER", unit: "F", value: "900" },
        { key: `new:${randomUUID()}`, label: "Basket", type: "TEXT", unit: null, value: "" },
      ],
    }] };
    const result = await renderProcessTravelerPreview(s.part.id, input, { orders: false, customers: false });
    expect(result).toMatchObject({ sample: true, generation: 11, pageCount: 1 });
    // Exactly three SAMPLE runs, the order number, the load and the barcode slot, and no image:
    // no barcode is encoded, and the default template carries no logo.
    expect(sampleRuns(result.pdf)).toHaveLength(3);
    expect(paintedImageCounts(result.pdf)).toEqual([0]);
    const text = drawnText(result.pdf);
    for (const expected of ["PRV-5150", "Preview bracket", "Austemper preview", "Contact fixture", "Draft-only instruction",
      "Temperature: 900 F", "Basket: ________", DRAFT_PROCESS_PREVIEW_LABEL]) {
      expect(text, expected).toContain(expected);
    }
  });
  it("renders a SAMPLE for a part that has orders when the request's context is null, from its saved rows", async () => {
    const f = await fixture();
    const result = await renderProcessTravelerPreview(f.part.id, { ...f.input, context: null }, { orders: false, customers: false });
    expect(result.sample).toBe(true);
    expect(sampleRuns(result.pdf)).toHaveLength(3);
    const text = drawnText(result.pdf);
    expect(text).toContain("Saved instruction"); expect(text).toContain("Temperature: 12.50 F"); expect(text).toContain("Preview fixture");
  });
  it("prints the received-from street and phone only for a caller who may view customers; the customer name always", async () => {
    const s = await samplePart();
    const without = drawnText((await renderProcessTravelerPreview(s.part.id, s.input, { orders: true, customers: false })).pdf);
    const withContact = drawnText((await renderProcessTravelerPreview(s.part.id, s.input, { orders: false, customers: true })).pdf);
    expect(without).toContain("Contact fixture");
    expect(without).not.toContain("77 Preview Street"); expect(without).not.toContain("555-0177");
    expect(withContact).toContain("Contact fixture");
    expect(withContact).toContain("77 Preview Street"); expect(withContact).toContain("555-0177");
  });
  it("resolves the traveler template assigned to the part's customer, as that customer's prints do", async () => {
    const s = await samplePart();
    const { id } = await system(() => createTemplate("TRAVELER", "Contact layout"));
    await system(() => publishDraft(id));
    await system(() => assignTemplate(s.customer.id, "TRAVELER", id));
    expect(await renderProcessTravelerPreview(s.part.id, s.input, FULL)).toMatchObject({ sample: true, templateId: id, templateName: "Contact layout" });
  });
  it("renders the draft's steps through a published canvas template, SAMPLE header and DRAFT label included (design §9)", async () => {
    const f = await fixture();
    const config = validateConfig("TRAVELER", { ...defaultConfigFor("TRAVELER"), layout: standardLayout() });
    const { id } = await system(() => createTemplate("TRAVELER", "Canvas layout"));
    const { versionId } = await system(() => publishDraft(id));
    await prisma.documentTemplateVersion.update({ where: { id: versionId }, data: { config: config as never } });
    const part = await prisma.part.findUniqueOrThrow({ where: { id: f.part.id } });
    await system(() => assignTemplate(part.customerId, "TRAVELER", id));
    const stepsTop = standardLayout().items.find(i => i.kind === "table" && i.key === "steps")!.box.y;

    const sample = await renderProcessTravelerPreview(f.part.id, { ...f.input, context: null }, FULL);
    expect(sample).toMatchObject({ sample: true, templateId: id });
    const text = drawnText(sample.pdf);
    expect(text).toContain("Saved instruction");
    expect(text).toContain("PROCESS STEPS:");
    expect(text).toContain(DRAFT_PROCESS_PREVIEW_LABEL);
    expect(sampleRuns(sample.pdf).length).toBeGreaterThanOrEqual(2);
    expect(paintedImageCounts(sample.pdf).every(n => n === 0)).toBe(true);
    // The canvas stacks its tables at their printed heights, so the heading sits within 40 pt above the
    // drawn steps top (309 against 339 here); the flow path's heading is 87.5 pt away (page height 792).
    const heading = textLinesWithY(sample.pdf)[0].find(l => l.text.includes("PROCESS STEPS:"))!;
    expect(Math.abs((792 - heading.y) - stepsTop)).toBeLessThanOrEqual(40);
    expect(textLinesWithY(sample.pdf)[0].some(l => l.text === "SAMPLE")).toBe(true);

    const real = await renderProcessTravelerPreview(f.part.id, f.input, FULL);
    expect(real).toMatchObject({ sample: false, templateId: id });
    expect(drawnText(real.pdf)).toContain(String(f.order.orderNumber));
    expect(drawnText(real.pdf)).toContain(DRAFT_PROCESS_PREVIEW_LABEL);
    expect(paintedImageCounts(real.pdf).some(n => n >= 1)).toBe(true);
  });
  it("writes nothing: every table's row count, the order-number counter and the process rows stay as they were", async () => {
    const f = await fixture();
    const counts = await everyTableCount();
    const before = await state();
    expect(before[6].some(s => s.key === "order_number_next")).toBe(true); // the counter is in the comparison
    expect((await renderProcessTravelerPreview(f.part.id, { ...f.input, context: null }, FULL)).sample).toBe(true);
    expect(await everyTableCount()).toEqual(counts);
    expect(await state()).toEqual(before);
  });
  it("validates the draft as an order preview does, and refuses a part that is not live", async () => {
    const f = await fixture();
    const sample = { ...f.input, context: null };
    await expect(renderProcessTravelerPreview(f.part.id, { ...sample, expectedBaselineToken: "stale" }, FULL)).rejects.toMatchObject({ status: 409 });
    const invalid = structuredClone(sample); invalid.steps[0].parameters[0].value = "nope";
    await expect(renderProcessTravelerPreview(f.part.id, invalid, FULL)).rejects.toMatchObject({ status: 400, message: `"nope" is not a valid number for Temperature` });
    await prisma.part.update({ where: { id: f.part.id }, data: { deletedAt: new Date() } });
    await expect(renderProcessTravelerPreview(f.part.id, sample, FULL)).rejects.toMatchObject({ status: 404, message: "Part not found" });
    await expect(renderProcessTravelerPreview("missing-part", sample, FULL)).rejects.toMatchObject({ status: 404, message: "Part not found" });
  });
});

describe("preview permissions (spec 2026-09-26 §5)", () => {
  it("refuses an order context without orders.view before opening a transaction, and still renders that caller's SAMPLE", async () => {
    const f = await fixture();
    const noOrders = { orders: false, customers: true };
    const refusal = { status: 403, message: "Previewing an order needs orders.view access" };
    const opened = await countTransactions(async () => {
      await expect(renderProcessTravelerPreview(f.part.id, f.input, noOrders)).rejects.toMatchObject(refusal);
      // Nothing was read: a missing order, a missing part and a stale baseline are the same 403,
      // never the 404 or 409 that would reveal what exists.
      await expect(renderProcessTravelerPreview(f.part.id, { ...f.input, context: { ...f.input.context, orderId: "missing" } }, noOrders)).rejects.toMatchObject(refusal);
      await expect(renderProcessTravelerPreview("missing-part", f.input, noOrders)).rejects.toMatchObject(refusal);
      await expect(renderProcessTravelerPreview(f.part.id, { ...f.input, expectedBaselineToken: "stale" }, noOrders)).rejects.toMatchObject(refusal);
    });
    expect(opened).toBe(0);
    expect((await renderProcessTravelerPreview(f.part.id, { ...f.input, context: null }, noOrders)).sample).toBe(true);
  });
});
