import { describe, expect, it, vi } from "vitest";
import type { Adapter, Draft, EditorBinding } from "../src/lib/draft-store";
import { openDraftHarness } from "./helpers/draft-store";

type Data = { header: string; auxiliary: string };
type Base = { header: string; status: "OPEN" | "CLOSED" };
type Binding = EditorBinding<Data, Base, Data, Base>;
const base = (header = "saved", status: Base["status"] = "OPEN"): Base => ({ header, status });
const clean = (baseline: Base): Data => ({ header: baseline.header, auxiliary: "" });
function beginNative(binding: Binding) {
  return (binding as Binding & { beginNativeRead?: () => number | null }).beginNativeRead?.() ?? null;
}
const scalar: Adapter<Data, Base, Data, Base> = {
  kind: "native-test", schema: "native-test-v1",
  valid: (data, baseline) => !!data && !!baseline && typeof data === "object" && typeof baseline === "object"
    && "header" in data && typeof data.header === "string" && "auxiliary" in data && typeof data.auxiliary === "string"
    && "header" in baseline && typeof baseline.header === "string" && "status" in baseline && ["OPEN", "CLOSED"].includes(String(baseline.status)),
  dirty: (data, baseline) => data.header !== baseline.header || data.auxiliary !== "",
  baselineEqual: (a, b) => a.header === b.header && a.status === b.status,
  preview: data => [{ label: "Auxiliary", value: data.auxiliary }],
  reconcileRead: ({ current, fresh }) => ({ data: current.data, baseline: fresh }),
  settle: ({ current, outcome }) => ({ kind: "keep", data: current.data, baseline: current.baseline, needsRefresh: outcome.kind === "unknown" }),
};
function open(optIn = true) {
  const canBeginNativeRead = vi.fn((current: Draft<Data, Base>) => current.data.header === current.baseline.header);
  const reconcileNativeRead = vi.fn(({ current, fresh }: { current: Draft<Data, Base>; fresh: Base }) => ({
    data: { header: fresh.header, auxiliary: current.data.auxiliary }, baseline: fresh,
  }));
  const reconcileMountedRead = vi.fn(({ current, fresh }: { current: Draft<Data, Base>; fresh: Base }) => ({ data: current.data, baseline: fresh }));
  const adapter = { ...scalar, reconcileMountedRead, ...(optIn ? { canBeginNativeRead, reconcileNativeRead } : {}) };
  return { ...openDraftHarness(adapter, clean(base()), base()), adapter, canBeginNativeRead, reconcileNativeRead, reconcileMountedRead };
}
function accept(binding: Binding, readId: number, baseline: Base, editable = baseline.status === "OPEN") {
  return binding.acceptRead({ kind: "authorized", readId, baseline, editable }, clean(baseline));
}

describe("opt-in native read provenance", () => {
  it("keeps auxiliary input through Close, readonly display, and Reopen", () => {
    const { binding } = open(); binding.change(d => ({ ...d, auxiliary: "raw unadded" }));
    const close = beginNative(binding); expect(close).not.toBeNull(); if (close === null) return;
    expect(accept(binding, close, base("closed header", "CLOSED"))).toBe(true);
    expect(binding.getSnapshot().reference?.data).toEqual({ header: "closed header", auxiliary: "raw unadded" });
    const reopen = beginNative(binding); expect(reopen).not.toBeNull(); if (reopen === null) return;
    expect(accept(binding, reopen, base("reopened header"))).toBe(true);
    expect(binding.getSnapshot().current?.data).toEqual({ header: "reopened header", auxiliary: "raw unadded" });
    expect(binding.getSnapshot().mode).toBe("editing");
  });
  it("admits an initially clean CLOSED quote without fabricating editable authorization", () => {
    const { binding } = open(); accept(binding, binding.beginRead(), base("saved", "CLOSED"));
    expect(binding.getSnapshot().current).toBeUndefined();
    const readId = beginNative(binding); expect(readId).not.toBeNull(); if (readId === null) return;
    expect(accept(binding, readId, base())).toBe(true); expect(binding.getSnapshot().mode).toBe("editing");
  });
  it("ordinary returned CLOSED input remains unresolved and never invokes native adoption", () => {
    const { binding, detach, reconcileNativeRead } = open(); binding.change(d => ({ ...d, auxiliary: "private" }));
    detach(); binding.attach("return"); accept(binding, binding.beginRead(), base("changed", "CLOSED"));
    expect(beginNative(binding)).toBeNull(); expect(reconcileNativeRead).not.toHaveBeenCalled();
    expect(binding.getSnapshot().reference?.data.auxiliary).toBe("private"); expect(binding.getSnapshot().reference?.baseline.status).toBe("OPEN");
  });
  it("requires explicit adapter opt-in", () => { const { binding } = open(false); expect(beginNative(binding)).toBeNull(); });
  it("admission invokes the adapter predicate and refuses changed submitted fields", () => {
    const { binding, canBeginNativeRead } = open(); binding.change(d => ({ ...d, header: "dirty header" }));
    expect(beginNative(binding)).toBeNull(); expect(canBeginNativeRead).toHaveBeenCalled();
  });
  for (const state of ["queued", "pending", "unknown", "reference", "two-copies"] as const) it(`refuses ${state} state`, () => {
    const { binding, detach } = open(); binding.change(d => ({ ...d, auxiliary: "older" }));
    if (state === "reference" || state === "two-copies") {
      detach(); binding.attach("return"); const readId = binding.beginRead(); accept(binding, readId, base("second"));
      binding.startFresh(readId, clean(base("second")));
      if (state === "two-copies") { binding.change(d => ({ ...d, auxiliary: "newer" })); accept(binding, binding.beginRead(), base("third")); expect(binding.getSnapshot().mode).toBe("blocked-two-copies"); }
      else expect(binding.getSnapshot().reference?.data.auxiliary).toBe("older");
    } else {
      const submission = binding.capture({ header: "saved", auxiliary: "older" }, "save");
      if (state !== "queued") binding.dispatched(submission);
      if (state === "unknown") binding.settle(submission, { kind: "unknown" });
    }
    expect(beginNative(binding)).toBeNull();
  });
  for (const state of ["malformed-incoming", "malformed-current"] as const) it(`fails closed for ${state}`, () => {
    const { binding, reconcileNativeRead } = open(); binding.change(d => ({ ...d, auxiliary: "keep" }));
    if (state === "malformed-current") binding.change(() => ({ header: 1, auxiliary: "keep" }) as unknown as Data);
    const readId = beginNative(binding);
    if (state === "malformed-current") { expect(readId).toBeNull(); expect(binding.getSnapshot().mode).toBe("error"); return; }
    expect(readId).not.toBeNull(); if (readId === null) return;
    binding.acceptRead({ kind: "authorized", readId, baseline: { header: 1, status: "OPEN" } as unknown as Base, editable: true }, clean(base()));
    expect(binding.getSnapshot().mode).toBe("error"); expect(reconcileNativeRead).not.toHaveBeenCalled();
  });
  for (const boundary of ["detach", "same-lease", "new-view", "discard", "auth-check", "new-owner", "queued-after-dispatch"] as const) it(`invalidates a captured native ticket on ${boundary}`, () => {
    const { binding, store, detach, reconcileNativeRead } = open(); binding.change(d => ({ ...d, auxiliary: "retain" }));
    const readId = beginNative(binding); expect(readId).not.toBeNull(); if (readId === null) return;
    if (boundary === "detach") detach();
    if (boundary === "same-lease") { detach(); binding.attach("first-view"); }
    if (boundary === "new-view") { detach(); binding.attach("replacement"); }
    if (boundary === "discard") { binding.discard(binding.getSnapshot().current!.stamp); binding.change(d => ({ ...d, auxiliary: "new generation" })); }
    if (boundary === "auth-check") store.acceptIdentity(store.beginIdentityCheck(), "u1");
    if (boundary === "new-owner") { store.resetIdentity(); store.acceptIdentity(store.beginIdentityCheck(), "u2"); }
    if (boundary === "queued-after-dispatch") binding.capture({ header: "saved", auxiliary: "retain" }, "queued");
    expect(accept(binding, readId, base("stale"))).toBe(false); expect(reconcileNativeRead).not.toHaveBeenCalled();
    if (boundary === "discard") expect(binding.getSnapshot().current?.data.auxiliary).toBe("new generation");
  });
  it("does not accept a native ticket as ordinary after ordinary read supersedes it", () => {
    const { binding, reconcileNativeRead } = open(); const native = beginNative(binding); expect(native).not.toBeNull(); if (native === null) return;
    const ordinary = binding.beginRead(); expect(accept(binding, native, base("stale"))).toBe(false);
    expect(accept(binding, ordinary, base("ordinary"))).toBe(true); expect(reconcileNativeRead).not.toHaveBeenCalled();
  });
  it("keeps mounted and native cohorts separate in both issuance orders", () => {
    for (const order of ["native-first", "mounted-first"] as const) {
      const { binding, reconcileNativeRead, reconcileMountedRead } = open(); binding.change(d => ({ ...d, auxiliary: "retain" }));
      const first = order === "native-first" ? beginNative(binding) : binding.beginMountedRead(); expect(first).not.toBeNull(); if (first === null) continue;
      const second = order === "native-first" ? binding.beginMountedRead() : beginNative(binding); expect(second).not.toBeNull(); if (second === null) continue;
      expect(accept(binding, first, base("old family"))).toBe(false); expect(accept(binding, second, base("new family"))).toBe(true);
      expect(reconcileNativeRead).toHaveBeenCalledTimes(order === "native-first" ? 0 : 1);
      expect(reconcileMountedRead).toHaveBeenCalledTimes(order === "native-first" ? 1 : 0);
    }
  });
  it("an unavailable native result invalidates remaining native callbacks", () => {
    const { binding } = open(); binding.change(d => ({ ...d, auxiliary: "private" }));
    const first = beginNative(binding); const second = beginNative(binding); expect(first).not.toBeNull(); expect(second).not.toBeNull(); if (first === null || second === null) return;
    expect(binding.acceptRead({ kind: "unavailable", readId: first }, clean(base()))).toBe(true);
    expect(accept(binding, second, base("must stay hidden"))).toBe(false);
    expect(binding.getSnapshot().mode).toBe("unavailable"); expect(binding.getSnapshot().current).toBeUndefined();
    expect(beginNative(binding)).toBeNull();
  });
  it("a later issued request that never applies does not erase an earlier accepted result", () => {
    const { binding } = open(); binding.change(d => ({ ...d, auxiliary: "retain" }));
    const first = beginNative(binding); const refusedTransport = beginNative(binding); expect(first).not.toBeNull(); expect(refusedTransport).not.toBeNull(); if (first === null) return;
    // The later native request is rejected by transport; no accepted payload exists for it.
    expect(accept(binding, first, base("earlier successful response"))).toBe(true);
    expect(binding.getSnapshot().current?.data).toEqual({ header: "earlier successful response", auxiliary: "retain" });
  });
  it("a newer applied response suppresses older callbacks and cannot replay its own ticket", () => {
    const { binding, reconcileNativeRead } = open(); binding.change(d => ({ ...d, auxiliary: "retain" }));
    const first = beginNative(binding); const second = beginNative(binding); expect(first).not.toBeNull(); expect(second).not.toBeNull(); if (first === null || second === null) return;
    expect(accept(binding, second, base("newest"))).toBe(true); expect(accept(binding, first, base("old"))).toBe(false);
    expect(accept(binding, second, base("replayed"))).toBe(false);
    expect(binding.getSnapshot().current?.data.header).toBe("newest"); expect(reconcileNativeRead).toHaveBeenCalledTimes(1);
  });
  it("native adoption consumes intervening header edits and retains the latest auxiliary input", () => {
    const { binding } = open(); const readId = beginNative(binding); expect(readId).not.toBeNull(); if (readId === null) return;
    binding.change(() => ({ header: "intervening", auxiliary: "last raw event" }));
    expect(accept(binding, readId, base("accepted native header"))).toBe(true);
    expect(binding.getSnapshot().current?.data).toEqual({ header: "accepted native header", auxiliary: "last raw event" });
  });
});
