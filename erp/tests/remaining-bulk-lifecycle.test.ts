import { describe, expect, it, vi } from "vitest";
import { createBulkRecoverySource } from "../src/lib/bulk-recovery-source";
import { createDraftSession } from "../src/lib/draft-session";
import { createDraftStore } from "../src/lib/draft-store";
import { createBulkRecoveryAdapter, emptyBulkDraft, bulkRecoveryPreviews } from "../src/lib/bulk-grid-recovery";
import { consumeSelectedPayment, paymentDraftStamps, paymentApplicationBaseline, paymentBulkCustomization, type ApplyLineFields } from "../src/lib/payment-bulk-recovery";
import { paymentFixture } from "./helpers/remaining-bulk-fixtures";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
describe("remaining bulk accepted read lifecycle", () => {
  // "Fresh access for every actual read": each read() that starts a flight reads access anew; a
  // read() begun while a flight is out under the same ticket joins it instead (#608,
  // tests/bulk-read-share.test.ts). The reads here are sequential, so each is its own flight.
  it("captures subscribers before dispatch and fresh access for every actual read", async () => {
    const record = { id: "same-id" }; let permissions = ["edit"];
    const readAccess = vi.fn(async () => permissions);
    const source = createBulkRecoverySource(async () => record, readAccess);
    const first = vi.fn(); source.register(() => first);
    const ticket = source.begin();
    const late = vi.fn(); source.register(() => late);
    permissions = [];
    await ticket.accept(record);
    expect(first).toHaveBeenCalledOnce(); expect(late).not.toHaveBeenCalled();
    expect((await source.read()).access).toEqual([]);
    expect(readAccess).toHaveBeenCalledTimes(2);
  });
  it("a later issued rejection cannot suppress an earlier parent-accepted result", async () => {
    const one = deferred<string[]>(); const two = deferred<string[]>();
    const access = [one, two];
    const source = createBulkRecoverySource(async () => "unused", () => access.shift()!.promise);
    const received: string[] = []; source.register(() => result => { if (result) received.push(result.record); });
    const first = source.begin(); source.begin(); // second request rejects 409; no acceptance/revocation
    const pending = first.accept("accepted earlier"); one.resolve(["edit"]); two.resolve(["edit"]);
    await pending; expect(received).toEqual(["accepted earlier"]);
  });
  it("marks parent acceptance before catalog awaits and prevents older catalog publication", async () => {
    const source = createBulkRecoverySource(async () => "unused", async () => ["edit"]);
    const catalogs = [deferred<string>(), deferred<string>()];
    const values: string[] = []; const completions: Promise<void>[] = [];
    source.register(() => (snapshot, current) => {
      if (!snapshot) return;
      const next = catalogs[completions.length];
      completions.push(next.promise.then(value => { if (current()) values.push(value); }));
    });
    const first = source.begin(); const second = source.begin();
    await first.accept("older"); await second.accept("newer");
    catalogs[0].resolve("stale catalog"); catalogs[1].resolve("fresh catalog");
    await Promise.all(completions); expect(values).toEqual(["fresh catalog"]);
  });
  it("newer unavailable access prevents an older auxiliary response reviving editability", async () => {
    const pending = deferred<string[]>();
    const source = createBulkRecoverySource(async () => "unused", () => pending.promise);
    const results: unknown[] = []; source.register(() => value => { results.push(value); });
    const first = source.begin(); const second = source.begin();
    const landing = first.accept("old"); second.unavailable(); pending.resolve(["edit"]); await landing;
    expect(results).toEqual([null]);
  });
  it("ordinary editing allocates and validates no recovery previews", () => {
    const adapter = createBulkRecoveryAdapter<{ amount: string }>("test", "v1", { preview: vi.fn(() => [{ label: "Amount", value: "1" }]) });
    const valid = vi.spyOn(adapter, "valid"); const preview = vi.spyOn(adapter, "preview");
    const data = emptyBulkDraft<{ amount: string }>(); const baseline = { rows: [], context: {} };
    const current = { data, baseline, schema: "v1", stamp: { key: { owner: { userId: "u", authGeneration: 1 }, record: { kind: "test", id: "1" }, editor: "test" }, generation: 1, version: 1 } };
    expect(bulkRecoveryPreviews(adapter, { mode: "editing", current, canRestore: false, needsRefresh: false })).toEqual({});
    expect(valid).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled();
    expect(bulkRecoveryPreviews(adapter, { mode: "offer", current, canRestore: true, needsRefresh: false }).currentPreview).toEqual([{ label: "Amount", value: "1" }]);
    expect(preview).toHaveBeenCalledOnce(); expect(valid).not.toHaveBeenCalled();
    preview.mockClear();
    for (const mode of ["loading", "unavailable", "error", "completed"] as const) {
      expect(bulkRecoveryPreviews(adapter, { mode, current, reference: current, submitted: current, canRestore: false, needsRefresh: false })).toEqual({});
    }
    expect(preview).not.toHaveBeenCalled(); expect(valid).not.toHaveBeenCalled();
    expect(bulkRecoveryPreviews(adapter, { mode: "editing", current, reference: current, canRestore: false, needsRefresh: false }))
      .toEqual({ referencePreview: [{ label: "Amount", value: "1" }] });
    expect(preview).toHaveBeenCalledOnce(); expect(valid).not.toHaveBeenCalled();
  });
});

function payments() {
  const store = createDraftStore();
  const owner = store.acceptIdentity(store.beginIdentityCheck(), "u")!;
  const session = createDraftSession(store);
  const data = emptyBulkDraft<ApplyLineFields>(); const base = paymentApplicationBaseline(paymentFixture());
  const adapter = createBulkRecoveryAdapter("payment-application", "v1", paymentBulkCustomization);
  function bind(childId: string, batchId = "batch-1") {
    const key = { owner, record: { kind: "payment", id: batchId }, editor: "payment-application", childId };
    const b = store.bind(key, { label: "Payment application", href: `/receivables/batches/${batchId}` }, adapter);
    b.attach(childId); const readId = b.beginRead(); b.acceptRead({ kind: "authorized", readId, editable: true, baseline: base }, data);
    b.change(d => ({ ...d, edits: new Map([["i1", { amount: childId }]]) }));
    return { key, binding: b };
  }
  return { store, session, bind };
}
describe("exact payment panel intent", () => {
  it("publishes selection when Return stays on the current batch route", () => {
    const { session, bind } = payments(); const one = bind("pay-1"); const two = bind("pay-2");
    const notify = vi.fn(); const off = session.subscribeSelection(notify); const before = session.getSelectionRevision();
    expect(session.select(two.key)).toBe(true); expect(session.getSelectionRevision()).toBeGreaterThan(before); expect(notify).toHaveBeenCalledOnce();
    const batch = paymentFixture().batch; batch.payments.push({ ...batch.payments[0], id: "pay-2" });
    expect(consumeSelectedPayment(session, batch)).toBe("pay-2");
    expect(consumeSelectedPayment(session, batch)).toBeNull();
    expect(one.binding.getSnapshot().current?.data.edits.get("i1")?.amount).toBe("pay-1"); off();
  });
  it("preserves a selected key across navigation until matching authorized batch membership exists", () => {
    const { session, bind } = payments(); const one = bind("pay-1"); session.select(one.key);
    expect(consumeSelectedPayment(session, { ...paymentFixture().batch, id: "different" })).toBeNull();
    expect(consumeSelectedPayment(session, { ...paymentFixture().batch, payments: [] })).toBeNull();
    expect(consumeSelectedPayment(session, paymentFixture().batch)).toBe("pay-1");
  });
  it("clears selection across identity reset and notifies mounted observers", () => {
    const { session, bind } = payments(); session.select(bind("pay-1").key);
    const notify = vi.fn(); session.subscribeSelection(notify); session.loginSucceeded();
    expect(notify).toHaveBeenCalledOnce();
    expect(consumeSelectedPayment(session, paymentFixture().batch)).toBeNull();
  });
  it("confirmed collapse consumes only the old panel's exact versions", () => {
    const { session, store, bind } = payments(); const old = bind("pay-1"); const sibling = bind("pay-2"); const other = bind("pay-1", "batch-2");
    const captured = paymentDraftStamps(store, "batch-1", "pay-1");
    expect(captured).toEqual([old.binding.getSnapshot().current!.stamp]);
    store.discard(captured);
    expect(store.getSnapshot().count).toBe(2);
    expect(sibling.binding.getSnapshot().current?.data.edits.size).toBe(1); expect(other.binding.getSnapshot().current?.data.edits.size).toBe(1);
    old.binding.change(d => ({ ...d, edits: new Map([["i1", { amount: "new generation" }]]) }));
    store.discard(captured); expect(old.binding.getSnapshot().current?.data.edits.get("i1")?.amount).toBe("new generation");
    expect(session.getSelectionRevision()).toBe(0);
  });
});

describe("selection identity checks", () => {
  it("current me 401 clears selection and notifies mounted observers", async () => {
    const { session, bind } = payments(); session.select(bind("pay-1").key);
    const notify = vi.fn(); session.subscribeSelection(notify);
    expect(await session.validateIdentity(async () => { throw { status: 401 }; })).toEqual({ kind: "expired" });
    expect(notify).toHaveBeenCalledOnce();
    await session.validateIdentity(async () => ({ id: "u" }));
    expect(consumeSelectedPayment(session, paymentFixture().batch)).toBeNull();
  });
  it("validated different user clears selection, while an old me response cannot notify or revive it", async () => {
    const { session, bind } = payments(); session.select(bind("pay-1").key);
    const old = deferred<{ id: string }>(); const pending = session.validateIdentity(() => old.promise);
    const notify = vi.fn(); session.subscribeSelection(notify);
    expect(await session.validateIdentity(async () => ({ id: "different" }))).toEqual({ kind: "ready", data: { id: "different" } });
    expect(notify).toHaveBeenCalledOnce();
    old.resolve({ id: "u" }); expect(await pending).toEqual({ kind: "stale" });
    expect(notify).toHaveBeenCalledOnce(); expect(consumeSelectedPayment(session, paymentFixture().batch)).toBeNull();
  });
  it("transient same-user failure preserves selection and notifies neither failure nor revalidation", async () => {
    const { session, bind } = payments(); session.select(bind("pay-1").key);
    const notify = vi.fn(); session.subscribeSelection(notify);
    expect(await session.validateIdentity(async () => { throw new Error("temporary offline"); })).toEqual({ kind: "retry" });
    expect(notify).not.toHaveBeenCalled();
    await session.validateIdentity(async () => ({ id: "u" }));
    expect(notify).not.toHaveBeenCalled(); expect(consumeSelectedPayment(session, paymentFixture().batch)).toBe("pay-1");
  });
});
