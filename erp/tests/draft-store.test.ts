import { describe, expect, it, vi } from "vitest";
import { createDraftStore, type Adapter } from "../src/lib/draft-store";
import { openDraftHarness, openScalarDraft, scalarAdapter } from "./helpers/draft-store";

describe("document draft store", () => {
  it("retains the last event value across real view replacement", () => {
    const { binding, baseline, clean, detach } = openScalarDraft();
    binding.change(() => ({ value: "last keystroke" }));
    expect(binding.getSnapshot().current?.data.value).toBe("last keystroke");
    detach(); binding.attach("return-view");
    const readId = binding.beginRead();
    binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
    const view = binding.getSnapshot();
    expect(view.mode).toBe("offer");
    expect(binding.restore(view.current!.stamp, readId)).toBe(true);
    expect(binding.getSnapshot().current?.data.value).toBe("last keystroke");
  });
  it("does not let an old save retire a post-discard generation", () => {
    const { binding, baseline, clean } = openScalarDraft();
    binding.change(() => ({ value: "submitted" }));
    const submission = binding.capture({ value: "submitted" }, "request-1");
    expect(binding.dispatched(submission)).toBe(true);
    binding.discard(binding.getSnapshot().current!.stamp);
    const readId = binding.beginRead();
    binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
    binding.change(() => ({ value: "new work" }));
    binding.settle(submission, { kind: "persisted", response: { value: "submitted" } });
    expect(binding.getSnapshot().current?.data.value).toBe("new work");
  });
  it("runs reducers once synchronously and keeps no-op snapshots and notifications stable", () => {
    const { store, binding } = openScalarDraft();
    const notify = vi.fn(); const summaryNotify = vi.fn();
    binding.subscribe(notify); store.subscribe(summaryNotify);
    const before = binding.getSnapshot(); const summary = store.getSnapshot();
    const reduce = vi.fn(data => data);
    binding.change(reduce);
    expect(reduce).toHaveBeenCalledTimes(1);
    expect(binding.getSnapshot()).toBe(before); expect(store.getSnapshot()).toBe(summary);
    expect(notify).not.toHaveBeenCalled(); expect(summaryNotify).not.toHaveBeenCalled();
    binding.change(() => ({ value: "" }));
    expect(binding.getSnapshot().current?.data.value).toBe("");
    expect(store.getSnapshot().count).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it("retains immutable Map and Set submission snapshots across later edits", () => {
    type Data = { rows: ReadonlyMap<string, string>; removed: ReadonlySet<string> };
    const adapter: Adapter<Data, Data, Data, Data> = {
      kind: "maps", schema: "v1", valid: (d, b) => !!d && !!b,
      dirty: d => d.rows.size > 0 || d.removed.size > 0, baselineEqual: () => true,
      preview: () => [], reconcileRead: ({ current, fresh }) => ({ data: current.data, baseline: fresh }),
      settle: ({ current }) => ({ kind: "keep", data: current.data, baseline: current.baseline, needsRefresh: false }),
    };
    const empty = { rows: new Map<string, string>(), removed: new Set<string>() };
    const { binding } = openDraftHarness(adapter, empty, empty);
    binding.change(() => ({ rows: new Map([["r1", "invalid"]]), removed: new Set(["r2"]) }));
    const first = binding.getSnapshot().current!;
    const submission = binding.capture(first.data, "map-request");
    binding.change(d => ({ rows: new Map([...d.rows, ["r3", ""]]), removed: new Set([...d.removed, "r4"]) }));
    expect([...submission.submitted.data.rows]).toEqual([["r1", "invalid"]]);
    expect([...first.data.removed]).toEqual(["r2"]);
    expect([...binding.getSnapshot().current!.data.rows]).toEqual([["r1", "invalid"], ["r3", ""]]);
    expect(empty.rows.size).toBe(0);
  });
  it("same-lease StrictMode reattachment preserves editing", () => {
    const { binding, detach } = openScalarDraft(); binding.change(() => ({ value: "typed" }));
    detach(); binding.attach("first-view");
    expect(binding.getSnapshot().mode).toBe("editing");
    expect(binding.getSnapshot().current?.data.value).toBe("typed");
  });
  it("rejects stale reads and restore stamps and hides unavailable values", () => {
    const { binding, baseline, clean, detach } = openScalarDraft();
    binding.change(() => ({ value: "private" })); const stamp = binding.getSnapshot().current!.stamp;
    detach(); binding.attach("return"); const stale = binding.beginRead(); const fresh = binding.beginRead();
    binding.acceptRead({ kind: "authorized", readId: stale, baseline, editable: true }, clean);
    expect(binding.getSnapshot().current).toBeUndefined(); expect(binding.restore(stamp, stale)).toBe(false);
    binding.acceptRead({ kind: "unavailable", readId: fresh }, clean);
    expect(binding.getSnapshot().mode).toBe("unavailable"); expect(binding.getSnapshot().current).toBeUndefined();
    const retry = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId: retry, baseline, editable: true }, clean);
    expect(binding.getSnapshot().current?.data.value).toBe("private");
    expect(binding.restore(stamp, stale)).toBe(false);
    expect(binding.restore({ ...stamp, version: stamp.version + 1 }, retry)).toBe(false);
    expect(binding.restore(stamp, retry)).toBe(true);
  });
  it("read-only authorization exposes only a reference and refuses restore/change", () => {
    const { binding, baseline, clean } = openScalarDraft(); binding.change(() => ({ value: "private" }));
    const stamp = binding.getSnapshot().current!.stamp; const readId = binding.beginRead();
    binding.acceptRead({ kind: "authorized", readId, baseline, editable: false }, clean);
    expect(binding.getSnapshot().current).toBeUndefined(); expect(binding.getSnapshot().reference?.data.value).toBe("private");
    expect(binding.restore(stamp, readId)).toBe(false);
    const reduce = vi.fn(() => ({ value: "forbidden" })); binding.change(reduce); expect(reduce).not.toHaveBeenCalled();
  });
  for (const dismiss of ["current", "reference"] as const) it(`preserves repeated conflicts until dismissing ${dismiss}`, () => {
    const { binding, detach } = openScalarDraft(); binding.change(() => ({ value: "first work" }));
    detach(); binding.attach("return"); let readId = binding.beginRead();
    binding.acceptRead({ kind: "authorized", readId, baseline: { value: "server two" }, editable: true }, { value: "server two" });
    expect(binding.getSnapshot().mode).toBe("conflict");
    expect(binding.getSnapshot().current?.data.value ?? binding.getSnapshot().reference?.data.value).toBe("first work");
    expect(binding.startFresh(readId, { value: "server two" })).toBe(true);
    binding.change(() => ({ value: "second work" })); readId = binding.beginRead();
    binding.acceptRead({ kind: "authorized", readId, baseline: { value: "server three" }, editable: true }, { value: "server three" });
    expect(binding.getSnapshot().mode).toBe("blocked-two-copies");
    expect(binding.getSnapshot().reference?.data.value).toBe("first work"); expect(binding.getSnapshot().current?.data.value).toBe("second work");
    expect(binding.startFresh(readId, { value: "server three" })).toBe(false);
    binding.discard(binding.getSnapshot()[dismiss]!.stamp);
    expect(binding.startFresh(readId, { value: "server three" })).toBe(true);
    expect(binding.getSnapshot().reference?.data.value).toBe(dismiss === "current" ? "first work" : "second work");
    expect(binding.getSnapshot().current?.data.value).toBe("server three");
  });
  it("queued capture is not pending and stale queued generations cannot dispatch", () => {
    const { binding, store } = openScalarDraft(); binding.change(() => ({ value: "queued" }));
    const queued = binding.capture({ value: "queued" }, "q");
    expect(binding.getSnapshot().mode).toBe("editing"); expect(store.getSnapshot().rows[0].pending).toBe(false);
    binding.discard(queued.stamp); expect(binding.dispatched(queued)).toBe(false);
  });
  it("a returned dispatched request is pending until its identified result arrives", () => {
    const { binding, detach, baseline, clean } = openScalarDraft(); binding.change(() => ({ value: "sent" }));
    const token = binding.capture({ value: "sent" }, "r"); expect(binding.dispatched(token)).toBe(true);
    detach(); binding.attach("return"); const readId = binding.beginRead();
    binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
    expect(binding.getSnapshot().mode).toBe("pending"); expect(binding.restore(token.stamp, readId)).toBe(false);
    binding.settle(token, { kind: "rejected" }); expect(binding.getSnapshot().current?.data.value).toBe("sent");
    expect(binding.getSnapshot().mode).not.toBe("pending");
  });
  it("persistence consumes the adapter generation including later edits and cannot be downgraded", () => {
    const { binding, store } = openScalarDraft(); binding.change(() => ({ value: "sent" }));
    const token = binding.capture({ value: "sent" }, "r"); binding.dispatched(token);
    binding.change(() => ({ value: "later" })); binding.settle(token, { kind: "persisted", response: { value: "sent" } });
    expect(store.getSnapshot().count).toBe(0); const view = binding.getSnapshot();
    binding.settle(token, { kind: "unknown" }); binding.settle(token, { kind: "rejected" });
    expect(binding.getSnapshot()).toBe(view); expect(store.getSnapshot().count).toBe(0);
  });
  it("passes submitted and current data to adapters that preserve later work", () => {
    const settle = vi.fn<typeof scalarAdapter.settle>(({ current, submission }) => ({ kind: "keep", data: current.data, baseline: submission.submitted.data, needsRefresh: true }));
    const { binding } = openDraftHarness({ ...scalarAdapter, settle }, { value: "saved" }, { value: "saved" });
    binding.change(() => ({ value: "sent" })); const token = binding.capture({ value: "sent" }, "r"); binding.dispatched(token);
    binding.change(() => ({ value: "later" })); binding.settle(token, { kind: "persisted", response: { value: "sent" } });
    expect(binding.getSnapshot().current?.data.value).toBe("later"); expect(binding.getSnapshot().needsRefresh).toBe(true);
    binding.settle(token, { kind: "persisted", response: { value: "sent" } }); expect(settle).toHaveBeenCalledTimes(1);
  });
  it("exact discard and current-path selectors preserve sibling and off-page scopes", () => {
    const { store, binding } = openScalarDraft(); const owner = store.getSnapshot().owner!;
    const sibling = store.bind({ owner, record: { kind: "order", id: "o1" }, editor: "test-fields", childId: "child" }, { label: "Sibling", href: "/orders/o1", scope: "serials" }, scalarAdapter);
    const other = store.bind({ owner, record: { kind: "order", id: "o2" }, editor: "test-fields" }, { label: "Other", href: "/orders/o2", scope: "serials" }, scalarAdapter);
    for (const b of [sibling, other]) { b.attach("v"); const readId = b.beginRead(); b.acceptRead({ kind: "authorized", readId, baseline: { value: "saved" }, editable: true }, { value: "saved" }); b.change(() => ({ value: "work" })); }
    binding.change(() => ({ value: "first" })); const old = binding.getSnapshot().current!.stamp; binding.change(() => ({ value: "new" })); store.discard([old]);
    expect(binding.getSnapshot().current?.data.value).toBe("new"); expect(store.labelsForPath("/orders/o1")).toEqual(["Draft", "Sibling"]);
    expect(store.labelsForPath("/orders/o1", ["Draft"])).toEqual(["Sibling"]); expect(store.hasScope("/orders/o3", "serials")).toBe(false);
    store.discard(store.stampsForPath("/orders/o1")); expect(store.getSnapshot().count).toBe(1); expect(other.getSnapshot().current?.data.value).toBe("work");
  });
  it("hides drafts for unresolved identity and preserves them after transient failure", () => {
    const { store, binding, baseline, clean } = openScalarDraft(); binding.change(() => ({ value: "secret" }));
    const owner = store.getSnapshot().owner; const check = store.beginIdentityCheck();
    expect(store.getSnapshot().rows).toEqual([]); expect(store.labelsForPath("/orders/o1")).toEqual([]); expect(binding.getSnapshot().current).toBeUndefined();
    store.identityCheckFailed(check, false); expect(store.getSnapshot().identityReady).toBe(false);
    expect(store.acceptIdentity(store.beginIdentityCheck(), "u1")).toEqual(owner);
    const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
    expect(binding.getSnapshot().current?.data.value).toBe("secret");
  });
  for (const boundary of ["reset", "expiry", "different-user"] as const) it(`purges on ${boundary} and rejects late callbacks`, () => {
    const { store, binding, baseline, clean } = openScalarDraft(); binding.change(() => ({ value: "secret" }));
    const oldOwner = store.getSnapshot().owner!; const token = binding.capture({ value: "secret" }, "r"); binding.dispatched(token); const oldRead = binding.beginRead();
    if (boundary === "reset") store.resetIdentity();
    else if (boundary === "expiry") store.identityCheckFailed(store.beginIdentityCheck(), true);
    else store.acceptIdentity(store.beginIdentityCheck(), "u2");
    const owner = store.acceptIdentity(store.beginIdentityCheck(), "u1")!;
    expect(owner.authGeneration).not.toBe(oldOwner.authGeneration);
    binding.acceptRead({ kind: "authorized", readId: oldRead, baseline, editable: true }, clean);
    binding.settle(token, { kind: "rejected" }); binding.change(() => ({ value: "resurrect" }));
    expect(store.getSnapshot().count).toBe(0); expect(binding.getSnapshot().current).toBeUndefined();
  });
  it("stale identity results cannot replace or expire the validated owner", () => {
    const store = createDraftStore(); const stale = store.beginIdentityCheck(); const current = store.beginIdentityCheck();
    const owner = store.acceptIdentity(current, "u1"); expect(store.acceptIdentity(stale, "u2")).toBeNull();
    store.identityCheckFailed(stale, true); expect(store.getSnapshot().owner).toEqual(owner); expect(store.getSnapshot().identityReady).toBe(true);
  });
  it("same-user identity acceptance requires a fresh record read before values return", () => {
    const { store, binding, baseline, clean } = openScalarDraft();
    binding.change(() => ({ value: "private" }));
    const staleRead = binding.beginRead();
    const owner = store.getSnapshot().owner;
    expect(store.acceptIdentity(store.beginIdentityCheck(), "u1")).toEqual(owner);
    expect(binding.getSnapshot().current).toBeUndefined();
    expect(store.labelsForPath("/orders/o1")).toEqual(["Draft"]);
    binding.acceptRead({ kind: "authorized", readId: staleRead, baseline, editable: true }, clean);
    expect(binding.getSnapshot().current).toBeUndefined();
    const readId = binding.beginRead();
    binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
    expect(binding.getSnapshot().current?.data.value).toBe("private");
    expect(store.labelsForPath("/orders/o1")).toEqual(["Draft"]);
  });
  it("unavailable records reveal neither their values nor identifying labels", () => {
    const { store, binding, clean } = openScalarDraft();
    binding.change(() => ({ value: "private" }));
    const readId = binding.beginRead(); binding.acceptRead({ kind: "unavailable", readId }, clean);
    expect(binding.getSnapshot().current).toBeUndefined(); expect(binding.getSnapshot().reference).toBeUndefined();
    expect(store.labelsForPath("/orders/o1")).toEqual(["Draft"]);
    expect(store.getSnapshot().rows.map(row => row.metadata.label)).toEqual(["Draft"]);
    expect(JSON.stringify(store.getSnapshot())).not.toContain("private");
    expect(store.getSnapshot().count).toBe(1);
  });
  it("clean detached bindings do not retain baselines and may be reopened", () => {
    const { store, binding, detach, baseline, clean } = openScalarDraft();
    detach(); expect(binding.getSnapshot().current).toBeUndefined(); expect(store.getSnapshot().count).toBe(0);
    binding.attach("first-view"); const readId = binding.beginRead();
    binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
    binding.change(() => ({ value: "new" }));
    expect(store.getSnapshot().count).toBe(1);
    store.discard(store.stampsForPath("/orders/o1")); expect(store.getSnapshot().count).toBe(0);
  });
  it("outstanding queued and dispatched tokens cannot undo generation retirement", () => {
    const { store, binding } = openScalarDraft(); binding.change(() => ({ value: "one" }));
    const one = binding.capture({ value: "one" }, "one"); binding.dispatched(one);
    binding.change(() => ({ value: "two" })); const two = binding.capture({ value: "two" }, "two"); binding.dispatched(two);
    const queued = binding.capture({ value: "two" }, "queued");
    binding.settle(two, { kind: "persisted", response: { value: "two" } });
    expect(store.getSnapshot().count).toBe(0);
    binding.settle(one, { kind: "rejected" }); expect(binding.dispatched(queued)).toBe(false);
    expect(store.getSnapshot().count).toBe(0);
  });

  it("a rejected request does not unlock a returned editor with another request pending", () => {
    const { binding, detach, baseline, clean } = openScalarDraft(); binding.change(() => ({ value: "work" }));
    const first = binding.capture({ value: "work" }, "first"); binding.dispatched(first);
    const second = binding.capture({ value: "work" }, "second"); binding.dispatched(second);
    detach(); binding.attach("return"); const readId = binding.beginRead();
    binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
    binding.settle(first, { kind: "rejected" }); expect(binding.getSnapshot().mode).toBe("pending");
    expect(binding.restore(binding.getSnapshot().current!.stamp, readId)).toBe(false);
    binding.settle(second, { kind: "rejected" }); expect(binding.getSnapshot().mode).toBe("offer");
  });

});

describe("parent lifecycle regressions", () => {
  it("keeps the tab unload count while identity is being checked without exposing rows", () => {
    const { store, binding } = openScalarDraft();
    binding.change(() => ({ value: "private" }));
    store.beginIdentityCheck();
    expect(store.getSnapshot().rows).toEqual([]);
    expect(binding.getSnapshot().current).toBeUndefined();
    expect(store.getSnapshot().count).toBe(1);
  });
  it("refuses a departed view's delayed edit callback", () => {
    const { binding, detach } = openScalarDraft();
    binding.change(() => ({ value: "last real event" }));
    detach();
    const delayedEdit = vi.fn(() => ({ value: "stale callback" }));
    binding.change(delayedEdit);
    expect(delayedEdit).not.toHaveBeenCalled();
    expect(binding.getSnapshot().current?.data.value).toBe("last real event");
  });
  it("keeps a current-record collapsed draft in the archival refusal during its fresh read", () => {
    const { store, binding, detach } = openScalarDraft();
    binding.change(() => ({ value: "work" }));
    detach();
    binding.attach("return-view");
    binding.beginRead();
    expect(binding.getSnapshot().current).toBeUndefined();
    expect(store.stampsForPath("/orders/o1")).toHaveLength(1);
    // Section labels are generic UI vocabulary, never cached record names.
    expect(store.labelsForPath("/orders/o1")).toEqual(["Draft"]);
  });
});


describe("review conflict regressions", () => {
  it("dismissing the old reference preserves actively edited newer work", () => {
    const { binding, detach } = openScalarDraft();
    binding.change(() => ({ value: "old work" }));
    detach(); binding.attach("new-view");
    const readId = binding.beginRead();
    binding.acceptRead({ kind: "authorized", readId, baseline: { value: "server two" }, editable: true }, { value: "server two" });
    binding.startFresh(readId, { value: "server two" });
    binding.change(() => ({ value: "new work" }));
    binding.discard(binding.getSnapshot().reference!.stamp);
    expect(binding.getSnapshot().current?.data.value).toBe("new work");
    expect(binding.getSnapshot().mode).toBe("editing");
  });
  it("a rejected save cannot unlock a conflict established by a newer read", () => {
    const { binding } = openScalarDraft();
    binding.change(() => ({ value: "submitted" }));
    const submission = binding.capture({ value: "submitted" }, "sent");
    binding.dispatched(submission);
    const readId = binding.beginRead();
    binding.acceptRead({ kind: "authorized", readId, baseline: { value: "changed server" }, editable: true }, { value: "changed server" });
    expect(binding.getSnapshot().mode).toBe("conflict");
    binding.settle(submission, { kind: "rejected" });
    expect(binding.getSnapshot().mode).toBe("conflict");
    const reduce = vi.fn(() => ({ value: "cannot edit stale baseline" }));
    binding.change(reduce);
    expect(reduce).not.toHaveBeenCalled();
  });
  it("unknown persistence stays unknown across a new view and matching read", () => {
    const { binding, clean, baseline, detach } = openScalarDraft();
    binding.change(() => ({ value: "submitted" }));
    const submission = binding.capture({ value: "submitted" }, "sent");
    binding.dispatched(submission);
    binding.settle(submission, { kind: "unknown" });
    detach(); binding.attach("return-view");
    const readId = binding.beginRead();
    binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
    expect(binding.getSnapshot().mode).toBe("unknown");
    expect(binding.restore(binding.getSnapshot().current!.stamp, readId)).toBe(false);
  });
});

describe("fix-round lifecycle and completion", () => {
  it("a reclaimed binding cannot write outside or remove its replacement", () => {
    const { store, binding: old, detach, clean, baseline } = openScalarDraft();
    const key = old.getSnapshot().current!.stamp.key;
    detach();
    const live = store.bind(key, { label: "Draft", href: "/orders/o1" }, scalarAdapter);
    live.attach("live"); const readId = live.beginRead();
    live.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
    live.change(() => ({ value: "live data" }));
    const oldDetach = old.attach("first-view"); const oldRead = old.beginRead();
    old.acceptRead({ kind: "authorized", readId: oldRead, baseline, editable: true }, clean);
    const staleChange = vi.fn(() => ({ value: "unregistered data" })); old.change(staleChange);
    expect(staleChange).not.toHaveBeenCalled(); oldDetach();
    expect(store.getSnapshot().count).toBe(1);
    expect(store.stampsForPath("/orders/o1")).toEqual([live.getSnapshot().current!.stamp]);
    store.discard(store.stampsForPath("/orders/o1")); expect(store.getSnapshot().count).toBe(0);
    expect(live.getSnapshot().current?.data.value).toBe("saved");
  });
  for (const outcome of ["retire", "keep"] as const) it(`reclaims detached clean state after late ${outcome} settlement`, () => {
    const adapter: typeof scalarAdapter = { ...scalarAdapter, settle: ({ submission }) => outcome === "retire" ? { kind: "retire" }
      : { kind: "keep", data: submission.submitted.data, baseline: submission.submitted.data, needsRefresh: false } };
    const { binding, detach, store } = openDraftHarness(adapter, { value: "saved" }, { value: "saved" });
    const key = binding.getSnapshot().current!.stamp.key;
    binding.change(() => ({ value: "sent" })); const token = binding.capture({ value: "sent" }, "r"); binding.dispatched(token);
    detach(); binding.settle(token, { kind: "persisted", response: { value: "sent" } });
    expect(binding.getSnapshot().current).toBeUndefined(); expect(binding.getSnapshot().reference).toBeUndefined();
    expect(store.getSnapshot().count).toBe(0);
    expect(store.bind(key, { label: "Draft", href: "/orders/o1" }, adapter)).not.toBe(binding);
  });
  it("reclaims clean detached state on explicit discard", () => {
    const { binding, store, detach } = openScalarDraft(); binding.change(() => ({ value: "work" }));
    const stamp = binding.getSnapshot().current!.stamp; detach(); binding.discard(stamp);
    expect(binding.getSnapshot().current).toBeUndefined(); expect(store.getSnapshot().count).toBe(0);
  });
  it("reference dismissal leaves current stamp and dispatch state unchanged", () => {
    const { binding, detach, store } = openScalarDraft(); binding.change(() => ({ value: "old" }));
    detach(); binding.attach("new"); const readId = binding.beginRead();
    binding.acceptRead({ kind: "authorized", readId, baseline: { value: "fresh" }, editable: true }, { value: "fresh" });
    binding.startFresh(readId, { value: "fresh" }); binding.change(() => ({ value: "new" }));
    const current = binding.getSnapshot().current!; const token = binding.capture({ value: "new" }, "save"); binding.dispatched(token);
    binding.discard(binding.getSnapshot().reference!.stamp);
    expect(binding.getSnapshot().current).toBe(current); expect(store.getSnapshot().rows[0].pending).toBe(true);
    binding.settle(token, { kind: "persisted", response: { value: "new" } }); expect(store.getSnapshot().count).toBe(0);
  });
  it("unknown outcomes preserve both stale copies and expose the original submission", () => {
    const { binding, detach } = openScalarDraft(); binding.change(() => ({ value: "old" })); detach(); binding.attach("return");
    let readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline: { value: "fresh" }, editable: true }, { value: "fresh" });
    binding.startFresh(readId, { value: "fresh" }); binding.change(() => ({ value: "submitted" }));
    const token = binding.capture({ value: "submitted" }, "save"); binding.dispatched(token); binding.change(() => ({ value: "later" }));
    readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline: { value: "new server" }, editable: true }, { value: "new server" });
    binding.settle(token, { kind: "unknown" });
    expect(binding.getSnapshot().mode).toBe("blocked-two-copies");
    expect(binding.getSnapshot().reference?.data.value).toBe("old"); expect(binding.getSnapshot().current?.data.value).toBe("later");
    expect(binding.getSnapshot().submitted?.data.value).toBe("submitted");
    expect(binding.startFresh(readId, { value: "new server" })).toBe(false);
  });
  it("dismisses only the current receipt and permits explicit new initialization", () => {
    type Receipt = { id: string; warnings: readonly string[] };
    const adapter: Adapter<{ value: string }, { value: string }, { value: string }, Receipt, Receipt> = {
      ...scalarAdapter, settle: ({ outcome }) => outcome.kind === "persisted" ? { kind: "retire", completed: outcome.response } : { kind: "retire" },
    };
    const { store, binding, clean, baseline, detach } = openDraftHarness(adapter, { value: "saved" }, { value: "saved" });
    binding.change(() => ({ value: "first" })); const first = binding.capture({ value: "first" }, "first"); binding.dispatched(first);
    detach(); const receipt = { id: "s1", warnings: ["Warning one", "Warning two"] };
    binding.settle(first, { kind: "persisted", response: receipt }); expect(store.getSnapshot().count).toBe(0);
    binding.attach("receipt-view"); let readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
    expect(binding.getSnapshot().completed).toEqual(receipt); const oldStamp = binding.getSnapshot().completedStamp!;
    expect(oldStamp).toBeDefined(); expect(binding.dismissCompleted(oldStamp)).toBe(true);
    expect(binding.getSnapshot().completed).toBeUndefined();
    readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
    binding.change(() => ({ value: "second" })); const second = binding.capture({ value: "second" }, "second"); binding.dispatched(second);
    binding.settle(second, { kind: "persisted", response: { id: "s2", warnings: [] } });
    expect(binding.dismissCompleted(oldStamp)).toBe(false); expect(binding.getSnapshot().completed?.id).toBe("s2");
    store.resetIdentity(); expect(binding.getSnapshot().completed).toBeUndefined();
  });
  it("receipt dismissal preserves a separate later-work reference", () => {
    const adapter: Adapter<{ value: string }, { value: string }, { value: string }, { value: string }, string> = {
      ...scalarAdapter, settle: ({ current }) => ({ kind: "retire", completed: "created", reference: { data: current.data, baseline: current.baseline } }),
    };
    const { binding, store } = openDraftHarness(adapter, { value: "saved" }, { value: "saved" });
    binding.change(() => ({ value: "sent" })); const token = binding.capture({ value: "sent" }, "r"); binding.dispatched(token);
    binding.change(() => ({ value: "later" })); binding.settle(token, { kind: "persisted", response: { value: "sent" } });
    const reference = binding.getSnapshot().reference!; expect(reference.data.value).toBe("later");
    expect(binding.dismissCompleted(binding.getSnapshot().completedStamp!)).toBe(true);
    expect(binding.getSnapshot().reference).toBe(reference); expect(store.getSnapshot().count).toBe(1);
  });
});

describe("explicit captured-body unknown retry", () => {
  const openUnknown = (allowUnknownRetry = true) => {
    const harness = openDraftHarness({ ...scalarAdapter, allowUnknownRetry }, { value: "saved" }, { value: "saved" });
    harness.binding.change(() => ({ value: "original" })); const payload = { value: "immutable original nonce/body" };
    const token = harness.binding.capture(payload, "original"); harness.binding.dispatched(token);
    harness.binding.change(() => ({ value: "later work" })); harness.binding.settle(token, { kind: "unknown" });
    return { ...harness, payload, token };
  };
  it("uses original immutable body and submitted snapshot after remount and later edits", () => {
    const { binding, store, baseline, clean, payload, token, detach } = openUnknown(); detach(); binding.attach("return");
    const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
    expect(binding.getSnapshot().submitted).toBe(token.submitted); expect(binding.getSnapshot().current?.data.value).toBe("later work");
    const retry = binding.prepareUnknownRetry(binding.getSnapshot().current!.stamp, readId, "retry")!;
    expect(retry).not.toBeNull(); expect(retry.payload).toBe(payload); expect(retry.submitted).toBe(token.submitted);
    expect(retry.requestId).toBe("retry"); expect(binding.getSnapshot().mode).toBe("unknown");
    expect(store.getSnapshot().rows[0].pending).toBe(false);
    expect(binding.dispatched(retry)).toBe(true);
    binding.settle(retry, { kind: "persisted", response: { value: "created" } });
    binding.settle(token, { kind: "rejected" }); expect(store.getSnapshot().count).toBe(0);
    expect(binding.prepareUnknownRetry(retry.stamp, readId, "duplicate")).toBeNull();
  });
  for (const refusal of ["no-opt-in", "stale-read", "stale-stamp", "read-only", "unavailable", "detached", "owner", "pending"] as const) it(`refuses unknown retry for ${refusal}`, () => {
    const { binding, store, clean, baseline, detach } = openUnknown(refusal !== "no-opt-in");
    let readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
    let stamp = binding.getSnapshot().current!.stamp;
    if (refusal === "stale-read") binding.beginRead();
    if (refusal === "stale-stamp") stamp = { ...stamp, version: stamp.version + 1 };
    if (refusal === "read-only" || refusal === "unavailable") {
      readId = binding.beginRead(); binding.acceptRead(refusal === "unavailable" ? { kind: "unavailable", readId } : { kind: "authorized", readId, baseline, editable: false }, clean);
    }
    if (refusal === "detached") detach();
    if (refusal === "owner") { store.resetIdentity(); store.acceptIdentity(store.beginIdentityCheck(), "u1"); }
    if (refusal === "pending") { const retry = binding.prepareUnknownRetry(stamp, readId, "first")!; expect(retry).not.toBeNull(); binding.dispatched(retry); }
    expect(binding.prepareUnknownRetry(stamp, readId, "refused")).toBeNull();
  });
  it("keeps unknown status through identity revalidation and hides submitted input until a fresh read", () => {
    const { store, binding, baseline, clean, token } = openUnknown();
    store.acceptIdentity(store.beginIdentityCheck(), "u1"); expect(binding.getSnapshot().submitted).toBeUndefined();
    const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
    expect(binding.getSnapshot().mode).toBe("unknown"); expect(binding.getSnapshot().submitted).toBe(token.submitted);
    expect(binding.restore(binding.getSnapshot().current!.stamp, readId)).toBe(false);
  });
});


describe("additional owner and conflict safeguards", () => {
  it("a freshly bound stale-owner key cannot publish through fresh callbacks", () => {
    const { store, binding, clean, baseline } = openScalarDraft();
    const key = binding.getSnapshot().current!.stamp.key;
    store.resetIdentity(); store.acceptIdentity(store.beginIdentityCheck(), "u2");
    const stale = store.bind(key, { label: "Draft", href: "/orders/o1" }, scalarAdapter);
    stale.attach("fresh-stale-owner"); const readId = stale.beginRead();
    stale.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
    const reduce = vi.fn(() => ({ value: "old owner" })); stale.change(reduce);
    expect(reduce).not.toHaveBeenCalled(); expect(stale.getSnapshot().current).toBeUndefined();
    expect(store.getSnapshot().count).toBe(0);
  });
  it("rejected save keeps two copies blocked and read-only access reveals both selectable copies", () => {
    const { binding, detach } = openScalarDraft(); binding.change(() => ({ value: "old" })); detach(); binding.attach("return");
    let readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline: { value: "fresh" }, editable: true }, { value: "fresh" });
    binding.startFresh(readId, { value: "fresh" }); binding.change(() => ({ value: "new" }));
    const token = binding.capture({ value: "new" }, "save"); binding.dispatched(token);
    readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline: { value: "new server" }, editable: true }, { value: "new server" });
    binding.settle(token, { kind: "rejected" }); expect(binding.getSnapshot().mode).toBe("blocked-two-copies");
    readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline: { value: "new server" }, editable: false }, { value: "new server" });
    expect(binding.getSnapshot().reference?.data.value).toBe("old"); expect(binding.getSnapshot().current?.data.value).toBe("new");
    const reduce = vi.fn(() => ({ value: "forbidden" })); binding.change(reduce); expect(reduce).not.toHaveBeenCalled();
    expect(binding.getSnapshot().canRestore).toBe(false);
  });
});


it("receipt dismissal keeps both older and later reference copies", () => {
  const adapter: Adapter<{value:string}, {value:string}, {value:string}, {value:string}, string> = {
    ...scalarAdapter,
    settle: ({ current }) => ({ kind: "retire", completed: "Created shipment 701", reference: { data: current.data, baseline: current.baseline } }),
  };
  const { binding, detach } = openDraftHarness(adapter, { value: "saved" }, { value: "saved" });
  binding.change(() => ({ value: "old work" })); detach(); binding.attach("return");
  const readId = binding.beginRead();
  binding.acceptRead({ kind: "authorized", readId, baseline: { value: "server two" }, editable: true }, { value: "server two" });
  binding.startFresh(readId, { value: "server two" });
  binding.change(() => ({ value: "submitted" }));
  const submission = binding.capture({ value: "submitted" }, "creation"); binding.dispatched(submission);
  binding.change(() => ({ value: "later work" }));
  binding.settle(submission, { kind: "persisted", response: { value: "submitted" } });
  const before = binding.getSnapshot();
  expect(before.current?.data.value).toBe("later work");
  expect(before.reference?.data.value).toBe("old work");
  expect(binding.dismissCompleted(before.completedStamp!)).toBe(true);
  expect(binding.getSnapshot().current?.data.value).toBe("later work");
  expect(binding.getSnapshot().reference?.data.value).toBe("old work");
  expect(binding.getSnapshot().mode).toBe("blocked-two-copies");
});
