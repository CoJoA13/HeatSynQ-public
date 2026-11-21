import { afterEach, describe, expect, it, vi } from "vitest";
import { createDraftStore, type Adapter, type Access, type Draft, type EditorBinding } from "../src/lib/draft-store";

type Data = Readonly<{ nonce: string; customerId: string; note: string }>;
type Base = Readonly<{ customerId: string; creditHold: boolean }>;
type Receipt = Readonly<{ id: string }>;
type Input = Readonly<{ nonce?: string; customerIds: readonly string[]; createdId?: string }>;
type Binding = EditorBinding<Data, Base, Data, Receipt, Receipt, Input>;
// Temporary structural declarations let BASE collect and fail behavior assertions
// without pretending that the proposed shared methods already exist.
type Extended = Binding & {
  readRequirements?: (readId: number) => Input | null;
  beginEditRead?: () => number | null;
  acceptEditRead?: (access: Access<Base>, reduce: (current: Draft<Data, Base>, fresh: Base) => Data | null) => boolean;
  restartReadAfterChange?: (readId: number) => number | null;
};
afterEach(() => vi.restoreAllMocks());
const clean: Data = { nonce: "original", customerId: "c1", note: "" };
const base: Base = { customerId: "c1", creditHold: false };
const subject: Adapter<Data, Base, Data, Receipt, Receipt, Input> & {
  reinitializeAfterDiscard: true;
  allowEditRead: true;
  readRequirements: (copies: { current?: Draft<Data, Base>; reference?: Draft<Data, Base>; submitted?: Draft<Data, Base>; clean?: Data; completed?: Receipt }) => Input;
} = {
  kind: "test-creation", schema: "creation-v1", reinitializeAfterDiscard: true, allowEditRead: true,
  valid: (data, baseline) => !!data && typeof data === "object" && "nonce" in data && typeof data.nonce === "string"
    && !!baseline && typeof baseline === "object" && "customerId" in baseline,
  dirty: data => data.note !== "",
  baselineEqual: (a, b) => a.customerId === b.customerId && a.creditHold === b.creditHold,
  preview: d => [{ label: "Note", value: d.note }],
  reconcileRead: ({ current, fresh }) => ({ data: current.data, baseline: fresh }),
  settle: ({ current, outcome }) => outcome.kind === "persisted" ? { kind: "retire", completed: outcome.response }
    : { kind: "keep", data: current.data, baseline: current.baseline, needsRefresh: outcome.kind === "unknown" },
  readRequirements: copies => ({ nonce: (copies.current?.data ?? copies.clean)?.nonce,
    customerIds: [...new Set([copies.current, copies.reference, copies.submitted].flatMap(d => d ? [d.data.customerId] : []))],
    ...(copies.completed ? { createdId: copies.completed.id } : {}) }),
};
function open() {
  const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "u1")!;
  const key = { owner, record: { kind: "new-shipment", id: "new" }, editor: subject.kind };
  const binding: Extended = store.bind(key, { label: "New shipment", href: "/shipping/new" }, subject);
  const detach = binding.attach("view");
  binding.acceptRead({ kind: "authorized", readId: binding.beginRead(), baseline: base, editable: true }, clean);
  return { store, owner, key, binding, detach };
}
function requirements(binding: Extended, readId: number) {
  expect(typeof binding.readRequirements).toBe("function");
  return binding.readRequirements?.(readId) ?? null;
}
function editRead(binding: Extended) {
  expect(typeof binding.beginEditRead).toBe("function");
  return binding.beginEditRead?.() ?? null;
}
function acceptEdit(binding: Extended, readId: number, baseline: Base, reduce: (d: Draft<Data, Base>) => Data | null) {
  expect(typeof binding.acceptEditRead).toBe("function");
  return binding.acceptEditRead?.({ kind: "authorized", readId, baseline, editable: true }, reduce) ?? false;
}
describe("creation initialization and stamped context reads", () => {
  it("provides only adapter-projected loader requirements while the rendering snapshot stays hidden", () => {
    const h = open(); h.binding.change(d => ({ ...d, note: "PRIVATE RAW NOTE" }));
    h.detach(); h.binding.attach("return"); const readId = h.binding.beginRead();
    expect(h.binding.getSnapshot().current).toBeUndefined();
    expect(requirements(h.binding, readId)).toEqual({ nonce: "original", customerIds: ["c1"] });
    expect(JSON.stringify(requirements(h.binding, readId))).not.toContain("PRIVATE RAW NOTE");
    expect(h.binding.getSnapshot().current).toBeUndefined();
  });
  it("rejects stale read IDs, detached leases, unresolved and replaced identity before invoking the projection", () => {
    const projection = vi.spyOn(subject, "readRequirements"); const h = open(); h.binding.change(d => ({ ...d, note: "keep" }));
    const stale = h.binding.beginRead(); const current = h.binding.beginRead();
    projection.mockClear(); expect(requirements(h.binding, stale)).toBeNull(); expect(projection).not.toHaveBeenCalled();
    const checking = h.store.beginIdentityCheck(); expect(requirements(h.binding, current)).toBeNull();
    h.store.acceptIdentity(checking, "u1"); const valid = h.binding.beginRead(); expect(requirements(h.binding, valid)?.nonce).toBe("original");
    h.detach(); projection.mockClear(); expect(requirements(h.binding, valid)).toBeNull(); expect(projection).not.toHaveBeenCalled();
    h.binding.attach("later"); h.store.resetIdentity(); h.store.acceptIdentity(h.store.beginIdentityCheck(), "u2");
    expect(requirements(h.binding, h.binding.beginRead())).toBeNull(); projection.mockRestore();
  });
  it("invokes a new nonce factory once only after the latest accepted read, including StrictMode setup replay", () => {
    const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "u1")!;
    const binding = store.bind({ owner, record: { kind: "new-shipment", id: "new" }, editor: subject.kind }, { label: "New shipment", href: "/shipping/new" }, subject);
    const detach = binding.attach("same-view"); const stale = binding.beginRead(); detach(); binding.attach("same-view"); const current = binding.beginRead();
    const mint = vi.fn(() => ({ ...clean, nonce: "new-once" }));
    const accept = binding.acceptRead as unknown as (access: Access<Base>, clean: Data | (() => Data)) => boolean;
    expect(accept({ kind: "authorized", readId: stale, baseline: base, editable: true }, mint)).toBe(false); expect(mint).not.toHaveBeenCalled();
    expect(accept({ kind: "authorized", readId: current, baseline: base, editable: true }, mint)).toBe(true);
    expect(accept({ kind: "authorized", readId: current, baseline: base, editable: true }, mint)).toBe(false);
    expect(mint).toHaveBeenCalledTimes(1); expect(binding.getSnapshot().current?.data.nonce).toBe("new-once");
  });
  it("ends a discarded nonce without reseeding it, and ignores its late acknowledgement after explicit new initialization", () => {
    const h = open(); h.binding.change(d => ({ ...d, note: "submitted" }));
    const submitted = h.binding.capture(h.binding.getSnapshot().current!.data, "old-save"); h.binding.dispatched(submitted);
    h.binding.discard(h.binding.getSnapshot().current!.stamp);
    expect(h.binding.getSnapshot().current).toBeUndefined(); expect(h.store.getSnapshot().count).toBe(0);
    const mint = vi.fn(() => ({ ...clean, nonce: "replacement" }));
    const accept = h.binding.acceptRead as unknown as (access: Access<Base>, clean: Data | (() => Data)) => boolean;
    accept({ kind: "authorized", readId: h.binding.beginRead(), baseline: base, editable: true }, mint);
    expect(mint).toHaveBeenCalledTimes(1); h.binding.change(d => ({ ...d, note: "new independent work" }));
    h.binding.settle(submitted, { kind: "persisted", response: { id: "old-created" } });
    expect(h.binding.getSnapshot().completed).toBeUndefined();
    expect(h.binding.getSnapshot().current?.data).toEqual({ nonce: "replacement", customerId: "c1", note: "new independent work" });
  });
  it("restarts a requirements read once when the last copy is discarded under it, with no nonce left to reuse (#454)", () => {
    const h = open(); h.binding.change(d => ({ ...d, note: "typed" })); const old = h.binding.getSnapshot().current!.stamp;
    const readId = h.binding.beginRead(); expect(requirements(h.binding, readId)).toEqual({ nonce: "original", customerIds: ["c1"] });
    h.store.discard(h.store.getSnapshot().rows[0].stamps);
    expect(h.binding.getSnapshot().current).toBeUndefined(); expect(h.store.getSnapshot().count).toBe(0);
    const mint = vi.fn(() => ({ ...clean, nonce: "replacement" }));
    const accept = (id: number) => (h.binding.acceptRead as unknown as (access: Access<Base>, clean: Data | (() => Data)) => boolean)({ kind: "authorized", readId: id, baseline: base, editable: true }, mint);
    // The answer in flight was fetched for the discarded nonce: refused, never seeded.
    expect(accept(readId)).toBe(false); expect(mint).not.toHaveBeenCalled();
    const restarted = h.binding.restartReadAfterChange(readId); expect(restarted).toEqual(expect.any(Number));
    expect(h.binding.restartReadAfterChange(readId)).toBeNull();
    const again = requirements(h.binding, restarted!); expect(again).toEqual({ customerIds: [] }); expect(again?.nonce).toBeUndefined();
    expect(accept(restarted!)).toBe(true); expect(mint).toHaveBeenCalledTimes(1);
    const after = h.binding.getSnapshot();
    expect(after).toMatchObject({ mode: "editing", needsRefresh: false });
    expect(after.current!.data).toEqual({ ...clean, nonce: "replacement" });
    expect(after.current!.stamp.generation).not.toBe(old.generation);
  });
  it("asks the page for nothing when the discard kept a read in flight (#454, #456)", () => {
    const h = open(); h.binding.change(d => ({ ...d, note: "typed" }));
    const readId = h.binding.beginRead(); requirements(h.binding, readId);
    h.store.discard(h.store.getSnapshot().rows[0].stamps);
    expect(h.binding.getSnapshot()).toMatchObject({ mode: "loading", needsRefresh: false });
    // With no read out, the same discard does ask.
    const settled = open(); settled.binding.change(d => ({ ...d, note: "typed" }));
    settled.store.discard(settled.store.getSnapshot().rows[0].stamps);
    expect(settled.binding.getSnapshot()).toMatchObject({ mode: "loading", needsRefresh: true });
  });
  it("neither restarts a read nor asks for one when the discarded copy had a save in flight", () => {
    const h = open(); h.binding.change(d => ({ ...d, note: "submitted" }));
    const submitted = h.binding.capture(h.binding.getSnapshot().current!.data, "save"); expect(h.binding.dispatched(submitted)).toBe(true);
    const readId = h.binding.beginRead(); expect(requirements(h.binding, readId)).not.toBeNull();
    h.store.discard(h.store.getSnapshot().rows[0].stamps);
    expect(h.binding.getSnapshot()).toMatchObject({ mode: "loading", needsRefresh: false });
    expect(h.binding.acceptRead({ kind: "authorized", readId, baseline: base, editable: true }, clean)).toBe(false);
    expect(h.binding.restartReadAfterChange(readId)).toBeNull();
    expect(h.binding.getSnapshot()).toMatchObject({ mode: "loading", needsRefresh: false });
    expect(h.binding.getSnapshot().current).toBeUndefined();
  });
  it("invalidates a loader requirement snapshot if a pending outcome creates a receipt before its read lands", () => {
    const h = open(); h.binding.change(d => ({ ...d, note: "submitted" }));
    const submission = h.binding.capture(h.binding.getSnapshot().current!.data, "pending"); h.binding.dispatched(submission);
    h.detach(); h.binding.attach("return"); const readId = h.binding.beginRead(); expect(requirements(h.binding, readId)?.customerIds).toEqual(["c1"]);
    h.binding.settle(submission, { kind: "persisted", response: { id: "created" } });
    expect(h.binding.acceptRead({ kind: "authorized", readId, baseline: base, editable: true }, clean)).toBe(false);
    expect(typeof h.binding.restartReadAfterChange).toBe("function");
    const receiptRead = h.binding.restartReadAfterChange?.(readId); expect(receiptRead).toEqual(expect.any(Number));
    expect(h.binding.restartReadAfterChange?.(readId)).toBeNull();
    expect(requirements(h.binding, receiptRead!)?.createdId).toBe("created");
  });
  it("keeps later raw typing when an explicit fresh customer-context read lands, but refuses a superseded action", () => {
    const h = open(); const stale = editRead(h.binding); expect(stale).not.toBeNull();
    const current = editRead(h.binding); expect(current).not.toBeNull();
    h.binding.change(d => ({ ...d, note: "typed during GET" }));
    const reduce = (d: Draft<Data, Base>) => ({ ...d.data, customerId: "c2" });
    expect(acceptEdit(h.binding, stale!, { customerId: "wrong", creditHold: false }, reduce)).toBe(false);
    expect(acceptEdit(h.binding, current!, { customerId: "c2", creditHold: true }, reduce)).toBe(true);
    expect(h.binding.getSnapshot().current?.data).toEqual({ nonce: "original", customerId: "c2", note: "typed during GET" });
    expect(h.binding.getSnapshot().current?.baseline).toEqual({ customerId: "c2", creditHold: true });
    expect(h.binding.getSnapshot().mode).toBe("editing");
  });
  it("allows explicit order-context editing beside one reference and during an already-dispatched save without replacing its submission", () => {
    const h = open(); h.binding.change(d => ({ ...d, note: "old reference" }));
    h.detach(); h.binding.attach("return"); const readId = h.binding.beginRead(); const fresh = { customerId: "c1", creditHold: true };
    h.binding.acceptRead({ kind: "authorized", readId, baseline: fresh, editable: true }, clean);
    expect(h.binding.startFresh(readId, { ...clean, nonce: "fresh" })).toBe(true);
    h.binding.change(d => ({ ...d, note: "submitted fresh" }));
    const saved = h.binding.capture(h.binding.getSnapshot().current!.data, "fresh-save"); h.binding.dispatched(saved);
    const id = editRead(h.binding); expect(id).not.toBeNull();
    expect(acceptEdit(h.binding, id!, { customerId: "c2", creditHold: false }, d => ({ ...d.data, customerId: "c2", note: "later intent" }))).toBe(true);
    expect(h.binding.getSnapshot().reference?.data.note).toBe("old reference");
    expect(h.binding.getSnapshot().submitted).toBe(saved.submitted);
    expect(h.binding.getSnapshot().current?.data.note).toBe("later intent");
    expect(h.store.getSnapshot().count).toBe(1);
  });
  it("refuses context adoption after Discard, auth invalidation, failed fresh access, or an ordinary recovery read", () => {
    for (const cause of ["discard", "auth", "ordinary", "denied"] as const) {
      const h = open(); h.binding.change(d => ({ ...d, note: "keep" })); const id = editRead(h.binding); expect(id).not.toBeNull();
      const reduce = vi.fn((d: Draft<Data, Base>) => ({ ...d.data, customerId: "c2" }));
      if (cause === "discard") h.binding.discard(h.binding.getSnapshot().current!.stamp);
      if (cause === "auth") h.store.beginIdentityCheck();
      if (cause === "ordinary") h.binding.beginRead();
      if (cause === "denied") h.binding.acceptEditRead?.({ kind: "unavailable", readId: id! }, reduce);
      expect(acceptEdit(h.binding, id!, { customerId: "c2", creditHold: false }, reduce)).toBe(false); expect(reduce).not.toHaveBeenCalled();
    }
  });
  it("rejects a null command reducer atomically without publishing its fresh baseline", () => {
    const h = open(); h.binding.change(d => ({ ...d, note: "keep" })); const before = h.binding.getSnapshot();
    const id = editRead(h.binding)!;
    expect(acceptEdit(h.binding, id, { customerId: "c2", creditHold: true }, () => null)).toBe(false);
    expect(h.binding.getSnapshot().current).toBe(before.current);
    expect(h.binding.getSnapshot().savedBaseline).toBe(before.savedBaseline);
    expect(acceptEdit(h.binding, id, base, d => d.data)).toBe(false);
  });
  it("cannot use restart to revive another read family, replaced owner, lease or an ordinary rejection", () => {
    for (const cause of ["newer", "lease", "owner", "unavailable", "unmarked"] as const) {
      const h = open(); h.binding.change(d => ({ ...d, note: "pending" }));
      const sub = h.binding.capture(h.binding.getSnapshot().current!.data, "save"); h.binding.dispatched(sub);
      const id = h.binding.beginRead(); requirements(h.binding, id);
      if (cause !== "unmarked" && cause !== "unavailable") {
        h.binding.settle(sub, { kind: "persisted", response: { id: "created" } });
        expect(h.binding.acceptRead({ kind: "authorized", readId: id, baseline: base, editable: true }, clean)).toBe(false);
      }
      if (cause === "newer") h.binding.beginRead();
      if (cause === "lease") { h.detach(); h.binding.attach("replacement"); }
      if (cause === "owner") h.store.beginIdentityCheck();
      if (cause === "unavailable") h.binding.acceptRead({ kind: "unavailable", readId: id }, clean);
      expect(typeof h.binding.restartReadAfterChange).toBe("function");
      expect(h.binding.restartReadAfterChange?.(id)).toBeNull();
    }
  });
  it("preserves eager initialization and default Discard reseeding without new opt-ins", () => {
    const { readRequirements: omitted, allowEditRead: noEdit, reinitializeAfterDiscard: noReseed, ...legacy } = subject;
    void omitted; void noEdit; void noReseed;
    const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "u")!;
    const b = store.bind({ owner, record: { kind: "legacy", id: "1" }, editor: legacy.kind }, { label: "Legacy", href: "/" }, legacy) as Extended;
    b.attach("legacy"); expect(b.acceptRead({ kind: "authorized", readId: b.beginRead(), baseline: base, editable: true }, clean)).toBe(true);
    b.change(d => ({ ...d, note: "edited" })); b.discard(b.getSnapshot().current!.stamp);
    expect(b.getSnapshot().current?.data).toEqual(clean);
    expect(editRead(b)).toBeNull(); expect(requirements(b, b.beginRead())).toBeNull();
  });

  it("refuses a prepared original retry once fresh access revokes recovery", () => {
    const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "u")!;
    const b = store.bind({ owner, record: { kind: "retry", id: "1" }, editor: subject.kind }, { label: "Retry", href: "/" }, { ...subject, allowUnknownRetry: true });
    b.attach("view"); b.acceptRead({ kind: "authorized", readId: b.beginRead(), baseline: base, editable: true }, clean);
    b.change(d => ({ ...d, note: "original" })); const original = b.capture(b.getSnapshot().current!.data, "original"); b.dispatched(original);
    b.settle(original, { kind: "unknown" });
    const readId = b.beginRead(); b.acceptRead({ kind: "authorized", readId, baseline: base, editable: true }, clean);
    const retry = b.prepareUnknownRetry(b.getSnapshot().current!.stamp, readId, "retry"); expect(retry).not.toBeNull();
    b.acceptRead({ kind: "authorized", readId: b.beginRead(), baseline: base, editable: true, recoveryAllowed: false }, clean);
    expect(b.dispatched(retry!)).toBe(false);
  });

  it("mints Start fresh identity only after actual binding admission, including a detached stale callback", () => {
    const h = open(); h.binding.change(d => ({ ...d, note: "old" })); h.detach(); const detach = h.binding.attach("return");
    const id = h.binding.beginRead(); h.binding.acceptRead({ kind: "authorized", readId: id, baseline: { ...base, creditHold: true }, editable: true }, clean);
    const start = h.binding.startFresh as unknown as (id: number, initialize: () => Data) => boolean;
    const mint = vi.fn(() => ({ ...clean, nonce: "new-intent" })); detach();
    expect(start(id, mint)).toBe(false); expect(mint).not.toHaveBeenCalled();
    h.binding.attach("another-return"); const next = h.binding.beginRead(); h.binding.acceptRead({ kind: "authorized", readId: next, baseline: { ...base, creditHold: true }, editable: true }, clean);
    expect(start(next, mint)).toBe(true); expect(mint).toHaveBeenCalledTimes(1);
    expect(start(next, mint)).toBe(false); expect(mint).toHaveBeenCalledTimes(1);
    expect(h.binding.getSnapshot().current?.data.nonce).toBe("new-intent");
  });

});
