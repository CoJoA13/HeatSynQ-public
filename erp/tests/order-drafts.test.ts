import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { getDraft, putDraft, clearDraft } from "@/server/order-drafts";
import { blankDraft, blankLine, normalizeDraft } from "@/app/orders/new/order-draft";

async function user(username: string) {
  return prisma.user.create({ data: { username, passwordHash: "x", displayName: username } });
}

describe("order drafts (the unaudited exception, spec §4)", () => {
  beforeEach(async () => await truncateAll());

  it("has no draft for a user who never saved one", async () => {
    const u = await user("op1");
    expect(await getDraft(u.id)).toBeNull();
  });

  it("round-trips a draft payload", async () => {
    const u = await user("op1");
    const payload = { customerId: "c1", lines: [{ partId: "p1", qty: 5 }] };
    await putDraft(u.id, payload);
    const draft = await getDraft(u.id);
    expect(draft?.payload).toEqual(payload);
    expect(draft?.updatedAt).toBeInstanceOf(Date);
  });

  it("round-trips the entry draft's nonce, raw strings, quote choices and optional workspace fields", async () => {
    const u = await user("op1");
    const draft = blankDraft();
    draft.customerId = "customer-1";
    draft.lines = [undefined, null, "quote-line-1"].map(quoteLineIdOverride => ({
      ...blankLine(), partId: "part-1", qty: "003", weightOverride: " 12.30 ", quoteLineIdOverride,
      serials: [{ id: "serial-1", serial: "EC001", description: "Left" }],
    }));
    draft.loadAdjustmentDraft = { enabled: true, leadPartId: "part-1", loadQty: "0010", loadWeight: "25.50" };
    draft.travelerSelection = { mode: "loads", loadNumbers: [1, 3] };
    draft.containers = [{ id: "container-1", typeId: "type-1", count: "02", pieces: "", tareEachOverride: "0.10",
      scaleGross: "12.40", customerContainerId: "BIN-9" }];
    draft.charges = [{ id: "charge-1", description: " Handling ", amount: " 10.20 " }];
    draft.certRequiredOverride = false;
    draft.certScopeOverride = "ORDER";
    await putDraft(u.id, JSON.parse(JSON.stringify(draft)));
    const stored = (await getDraft(u.id))?.payload;
    expect(normalizeDraft(stored)).toEqual(draft);
    expect(normalizeDraft(stored).clientRequestId).toBe(draft.clientRequestId);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("resumes a container row stored before the weights change with its figures blank, and reading the draft stores nothing", async () => {
    const u = await user("op1");
    const stored = { customerId: "customer-1", containers: [{ id: "container-1", typeId: "type-1", count: "3",
      qty: "84", tareWeight: "42.50", grossWeight: "580.00", customerContainerId: "BIN-9" }] };
    await putDraft(u.id, stored);
    const payload = (await getDraft(u.id))?.payload;
    expect(normalizeDraft(payload).containers).toEqual([{ id: "container-1", typeId: "type-1", count: "3",
      pieces: "", tareEachOverride: null, scaleGross: "", customerContainerId: "BIN-9" }]);
    // The reader drops the old figures from what it returns. It is pure and has no way to write,
    // so the line below holds `getDraft` alone: a read stores nothing, and the stored row is as it
    // was until the next autosave.
    expect((await getDraft(u.id))?.payload).toEqual(stored);
  });

  it("upserts on repeated puts, keeping exactly one row per user", async () => {
    const u = await user("op1");
    await putDraft(u.id, { a: 1 });
    await putDraft(u.id, { a: 2 });
    expect(await prisma.orderDraft.count({ where: { userId: u.id } })).toBe(1);
    expect((await getDraft(u.id))?.payload).toEqual({ a: 2 });
  });

  it("clear nulls the payload but keeps the row (an update, not a delete)", async () => {
    const u = await user("op1");
    await putDraft(u.id, { a: 1 });
    await clearDraft(u.id);
    const row = await prisma.orderDraft.findUnique({ where: { userId: u.id } });
    expect(row).not.toBeNull();
    expect(row?.payload).toBeNull();
    expect((await getDraft(u.id))?.payload).toBeNull();
  });

  it("clearing a user with no draft row at all is a harmless no-op", async () => {
    const u = await user("op1");
    await expect(clearDraft(u.id)).resolves.toBeUndefined();
    expect(await getDraft(u.id)).toBeNull();
  });

  // #663: the cap was 256 KB, which a long order's serials passed at about 3,200 of them while
  // Save accepts 10,000 per line; from then on every autosave was refused and the recovered draft
  // was an older one. The cap is 4 MB, sized so a line of 10,000 serials of the longest serial
  // the create body accepts (120 characters) fits in the compact draft shape, and the sentence
  // says what the operator can do about it.
  it("rejects a payload over 4 MB serialized, naming the limit and the way out, and writes nothing", async () => {
    const u = await user("op1");
    const big = { blob: "x".repeat(5 * 1024 * 1024) };
    await expect(putDraft(u.id, big)).rejects.toMatchObject({ status: 400 });
    await expect(putDraft(u.id, big)).rejects.toThrow(
      "Draft autosave refused: the draft is over the 4 MB limit. Save still works; a draft recovered later may be older than this screen.");
    expect(await getDraft(u.id)).toBeNull();
  });

  it("accepts a payload the old 256 KB cap refused", async () => {
    const u = await user("op1");
    const ok = { blob: "x".repeat(300 * 1024) };
    await expect(putDraft(u.id, ok)).resolves.toBeUndefined();
    expect((await getDraft(u.id))?.payload).toEqual(ok);
  });

  it("writes no audit rows for put, get, or clear (the §12.7 assertion)", async () => {
    const u = await user("op1");
    await putDraft(u.id, { a: 1 });
    await getDraft(u.id);
    await clearDraft(u.id);
    await putDraft(u.id, { a: 2 });
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("keeps drafts isolated per user — one user's writes never touch another's", async () => {
    const a = await user("opA");
    const b = await user("opB");
    await putDraft(a.id, { who: "a" });
    await putDraft(b.id, { who: "b" });

    await clearDraft(a.id);

    expect((await getDraft(a.id))?.payload).toBeNull();
    expect((await getDraft(b.id))?.payload).toEqual({ who: "b" });
  });
});
