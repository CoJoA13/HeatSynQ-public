import { expect, it, vi } from "vitest";
import { createDraftStore, type Adapter, type DraftStore, type EditorBinding } from "../src/lib/draft-store";

// `captureRetirement`'s generic draft-store cases. They were written against the process-template
// page's adapter; that page is gone (spec 2026-09-26 §3.6), so they run through the synthetic
// adapter below, which keeps the parts the store reads: a named draft, a baseline that can change
// underneath it, a prepared read (`readRequirements`), a save that keeps its copy and a delete that
// retires it. Every assertion is unchanged. The page's own DELETE-callback cases went with the page;
// tests/quote-recovery.test.ts covers the one remaining caller's (QuoteDetail's DELETE).

type Draft = Readonly<{ nameDraft: string; lastServerName: string | null }>;
type Baseline = Readonly<{ id: string; name: string }>;
type Intent = Readonly<{ kind: "name"; name: string }> | Readonly<{ kind: "delete" }>;
type Requirements = Readonly<{ recordId?: string }>;
type Binding = EditorBinding<Draft, Baseline, Intent, undefined, never, Requirements>;

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
// Adopt the server's name unless the operator typed over the one last seen.
const adopt = (data: Draft, serverName: string) =>
  data.lastServerName === null || data.nameDraft === data.lastServerName ? serverName : data.nameDraft;
const adapter: Adapter<Draft, Baseline, Intent, undefined, never, Requirements> = {
  kind: "retirement-test", schema: "retirement-test-v1",
  valid: (data, baseline) => object(data) && typeof data.nameDraft === "string"
    && (data.lastServerName === null || typeof data.lastServerName === "string")
    && object(baseline) && typeof baseline.id === "string" && typeof baseline.name === "string",
  dirty: data => data.nameDraft !== data.lastServerName,
  // A dirty name conflicts with a changed server name; a clean copy compares whole.
  baselineEqual: (saved, fresh, data) => saved.id === fresh.id && (data
    ? data.nameDraft === data.lastServerName || saved.name === fresh.name
    : JSON.stringify(saved) === JSON.stringify(fresh)),
  preview: data => data.nameDraft !== data.lastServerName ? [{ label: "Name", value: data.nameDraft }] : [],
  readRequirements: ({ current, reference, submitted }) => {
    const b = (current ?? reference ?? submitted)?.baseline; return b ? { recordId: b.id } : {};
  },
  reconcileRead: ({ current, fresh }) => ({ data: { nameDraft: adopt(current.data, fresh.name), lastServerName: fresh.name }, baseline: fresh }),
  settle: ({ current, submission, outcome }) => {
    if (outcome.kind !== "persisted") return { kind: outcome.kind === "unknown" ? "reference" : "keep", data: current.data, baseline: current.baseline, needsRefresh: outcome.kind === "unknown" };
    const intent = submission.payload; if (intent.kind === "delete") return { kind: "retire" };
    return { kind: "keep", data: { ...current.data, lastServerName: intent.name }, baseline: { ...current.baseline, name: intent.name }, needsRefresh: true };
  },
};

const baseline = (name = "Saved"): Baseline => ({ id: "record", name });
const clean = (b = baseline()): Draft => ({ nameDraft: b.name, lastServerName: b.name });
function read(binding: Binding, b = baseline(), editable = true) {
  const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline: b, editable }, clean(b)); return readId;
}
const bindRecord = (store: DraftStore, owner: NonNullable<ReturnType<DraftStore["acceptIdentity"]>>) =>
  store.bind({ owner, record: { kind: "retirement-test", id: "record" }, editor: adapter.kind }, { label: "Record", href: "/record" }, adapter);
function open(store: DraftStore = createDraftStore()) {
  const owner = store.acceptIdentity(store.beginIdentityCheck(), "user")!;
  const binding = bindRecord(store, owner);
  const detach = binding.attach("view"); read(binding);
  return { store, binding, detach };
}
const editName = (binding: Binding, nameDraft: string) => binding.change(d => ({ ...d, nameDraft }));

it("retirement capture requires current visible access and exactly one live lease", () => {
  for (const state of ["no lease", "two leases", "unavailable", "identity checking", "wrong owner"]) {
    const h = open(); editName(h.binding, "mine");
    if (state === "no lease") h.detach();
    if (state === "two leases") h.binding.attach("second");
    if (state === "unavailable") { const readId = h.binding.beginRead(); h.binding.acceptRead({ kind: "unavailable", readId }, clean()); }
    if (state === "identity checking") h.store.beginIdentityCheck();
    if (state === "wrong owner") h.store.resetIdentity();
    expect(h.binding.captureRetirement(), state).toBeNull();
  }
});

it("retirement is one-shot, cancels only captured requests, and cannot reapply after a new generation", () => {
  const h = open(); editName(h.binding, "submitted"); const submission = h.binding.capture({ kind: "name", name: "submitted" }, "name"); h.binding.dispatched(submission);
  const retire = h.binding.captureRetirement(); expect(retire).toBeTypeOf("function"); if (!retire) return;
  expect(retire()).toBe(true); expect(h.binding.getSnapshot().submitted).toBeUndefined();
  read(h.binding); editName(h.binding, "replacement"); const current = h.binding.getSnapshot().current;
  expect(retire()).toBe(false); h.binding.settle(submission, { kind: "persisted", response: undefined });
  expect(h.binding.getSnapshot().current).toBe(current); expect(h.store.getSnapshot().count).toBe(1);
});

it("retirement invalidates pre-deletion prepared reads and does not regenerate obsolete clean data", () => {
  const h = open(); editName(h.binding, "raw"); const retire = h.binding.captureRetirement(); expect(retire).toBeTypeOf("function"); if (!retire) return;
  const readId = h.binding.beginRead(); expect(retire()).toBe(true);
  expect(h.binding.acceptRead({ kind: "authorized", readId, baseline: baseline(), editable: true }, clean())).toBe(false);
  expect(h.binding.getSnapshot().current).toBeUndefined(); expect(h.binding.getSnapshot().reference).toBeUndefined(); expect(h.store.getSnapshot().count).toBe(0);
});

it("retiring a captured reference preserves an independently replaced current generation and its access", () => {
  const h = open(); editName(h.binding, "reference raw"); h.detach(); h.binding.attach("return");
  const fresh = baseline("Fresh"); const readId = read(h.binding, fresh);
  expect(h.binding.startFresh(readId, clean(fresh))).toBe(true); editName(h.binding, "captured current");
  const retire = h.binding.captureRetirement(); expect(retire).toBeTypeOf("function"); if (!retire) return;
  h.binding.discard(h.binding.getSnapshot().current!.stamp);
  expect(h.binding.startFresh(readId, clean(fresh))).toBe(true); editName(h.binding, "independent replacement");
  const before = h.binding.getSnapshot(); const replacement = before.current!;
  expect(retire()).toBe(true); const after = h.binding.getSnapshot();
  expect(after.reference).toBeUndefined(); expect(after.current).toBe(replacement);
  expect(after.savedBaseline).toBe(before.savedBaseline); expect(after.mode).toBe("editing"); expect(after.needsRefresh).toBe(before.needsRefresh);
  expect(after.recoveryAllowed).toBe(before.recoveryAllowed); expect(h.store.getSnapshot().count).toBe(1);
});

it("a one-shot invocation with no matching generation leaves replacement snapshot and access untouched", () => {
  const h = open(); editName(h.binding, "old"); const retire = h.binding.captureRetirement(); expect(retire).toBeTypeOf("function"); if (!retire) return;
  h.binding.discard(h.binding.getSnapshot().current!.stamp); editName(h.binding, "replacement");
  const before = h.binding.getSnapshot(); const listener = vi.fn(); h.binding.subscribe(listener);
  expect(retire()).toBe(false); expect(retire()).toBe(false); expect(h.binding.getSnapshot()).toBe(before); expect(listener).not.toHaveBeenCalled();
});

it("capture refuses a zero-copy slot even when the last saved access remains authorized", () => {
  const h = open(); const submission = h.binding.capture({ kind: "delete" }, "already-deleted"); h.binding.dispatched(submission);
  h.binding.settle(submission, { kind: "persisted", response: undefined });
  expect(h.binding.getSnapshot().current).toBeUndefined(); expect(h.binding.getSnapshot().reference).toBeUndefined();
  expect(h.binding.captureRetirement()).toBeNull();
});

it("a reclaimed binding cannot retire a newly registered binding under the same owner/key", () => {
  const h = open(); const retire = h.binding.captureRetirement(); expect(retire).toBeTypeOf("function"); if (!retire) return;
  h.detach(); // clean unmounted entries are reclaimed
  const next = bindRecord(h.store, h.store.getSnapshot().owner!);
  next.attach("new registration"); read(next); editName(next, "replacement registration"); const before = next.getSnapshot();
  expect(retire()).toBe(false); expect(next.getSnapshot()).toBe(before);
});

it("no-match retirement preserves a completed receipt and its access/stamp", () => {
  const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "user")!;
  const receiptAdapter: Adapter<string, string, string, string, string> = { kind: "receipt-test", schema: "1",
    valid: (d, b) => typeof d === "string" && typeof b === "string", dirty: (d, b) => d !== b, baselineEqual: (a, b) => a === b,
    preview: () => [], reconcileRead: ({ current, fresh }) => ({ data: current.data, baseline: fresh }), settle: () => ({ kind: "retire", completed: "saved receipt" }) };
  const binding = store.bind({ owner, record: { kind: "test", id: "record" }, editor: receiptAdapter.kind }, { label: "Receipt", href: "/receipt" }, receiptAdapter);
  binding.attach("view"); const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline: "saved", editable: true }, "draft");
  const retire = binding.captureRetirement(); expect(retire).toBeTypeOf("function"); if (!retire) return;
  const submission = binding.capture("body", "request"); binding.dispatched(submission); binding.settle(submission, { kind: "persisted", response: "ok" });
  const before = binding.getSnapshot(); expect(before.completed).toBe("saved receipt"); expect(before.completedStamp).toBeDefined();
  expect(retire()).toBe(false); expect(binding.getSnapshot()).toBe(before);
});
