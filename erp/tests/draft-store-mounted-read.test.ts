import { describe, expect, it, vi } from "vitest";
import { openDraftHarness, scalarAdapter } from "./helpers/draft-store";
import type { EditorBinding } from "../src/lib/draft-store";

type Scalar = { readonly value: string };
function beginMounted(binding: EditorBinding<Scalar, Scalar, Scalar, Scalar>) {
  // Optional structural access lets the pre-amendment source run and fail on
  // observable behavior rather than failing test collection.
  return (binding as typeof binding & { beginMountedRead?: () => number | null }).beginMountedRead?.() ?? null;
}

function open() {
  const reconcileMountedRead = vi.fn(({ current, fresh }) => ({ data: current.data, baseline: fresh }));
  // The optional method is structurally accepted before the core amendment, so
  // RED demonstrates behavior rather than a missing module or type declaration.
  const adapter = { ...scalarAdapter, reconcileMountedRead };
  return { ...openDraftHarness(adapter, { value: "saved" }, { value: "saved" }), reconcileMountedRead };
}
describe("pre-dispatch mounted reconciliation eligibility", () => {
  it("exposes only the fresh authorized saved baseline while offering or conflicting retained work", () => {
    const { binding, store, detach } = open(); binding.change(() => ({ value: "private typed" }));
    detach(); binding.attach("return");
    const readId = binding.beginRead();
    expect((binding.getSnapshot() as { savedBaseline?: Scalar }).savedBaseline).toBeUndefined();
    binding.acceptRead({ kind: "authorized", readId, baseline: { value: "fresh saved" }, editable: true }, { value: "fresh saved" });
    expect(binding.getSnapshot().mode).toBe("conflict");
    expect((binding.getSnapshot() as { savedBaseline?: Scalar }).savedBaseline).toEqual({ value: "fresh saved" });
    expect(binding.getSnapshot().current!.data.value).toBe("private typed");
    const newer = binding.beginRead();
    binding.acceptRead({ kind: "authorized", readId, baseline: { value: "stale" }, editable: true }, { value: "stale" });
    expect((binding.getSnapshot() as { savedBaseline?: Scalar }).savedBaseline).toBeUndefined();
    binding.acceptRead({ kind: "authorized", readId: newer, baseline: { value: "read only saved" }, editable: false }, { value: "read only saved" });
    expect((binding.getSnapshot() as { savedBaseline?: Scalar }).savedBaseline).toEqual({ value: "read only saved" });
    store.beginIdentityCheck();
    expect((binding.getSnapshot() as { savedBaseline?: Scalar }).savedBaseline).toBeUndefined();
  });
  it("lets an explicitly opted-in active editor adopt a changed read baseline", () => {
    const { binding, reconcileMountedRead } = open();
    binding.change(() => ({ value: "typed" }));
    const readId = beginMounted(binding);
    expect(readId).not.toBeNull();
    if (readId === null) return;
    binding.acceptRead({ kind: "authorized", readId, baseline: { value: "changed" }, editable: true }, { value: "changed" });
    expect(reconcileMountedRead).toHaveBeenCalledTimes(1);
    expect(binding.getSnapshot().mode).toBe("editing");
    expect(binding.getSnapshot().current?.data.value).toBe("typed");
    expect(binding.getSnapshot().current?.baseline.value).toBe("changed");
  });
  for (const state of ["returning", "conflicting", "pending", "unknown", "hidden", "detached", "readonly", "replaced-lease", "superseded-read"] as const) {
    it(`does not prune ${state} work`, () => {
      const { binding, store, detach, reconcileMountedRead } = open();
      binding.change(() => ({ value: "retain verbatim" }));
      const retained = binding.getSnapshot().current!;
      if (state === "returning") { detach(); binding.attach("return"); }
      if (state === "conflicting") {
        detach(); binding.attach("return"); const firstRead = binding.beginRead();
        binding.acceptRead({ kind: "authorized", readId: firstRead, baseline: { value: "already different" }, editable: true }, { value: "already different" });
      }
      if (state === "pending" || state === "unknown") {
        const submission = binding.capture({ value: "retain verbatim" }, "request"); binding.dispatched(submission);
        if (state === "unknown") binding.settle(submission, { kind: "unknown" });
      }
      if (state === "hidden") {
        const identity = store.beginIdentityCheck(); store.acceptIdentity(identity, "u1");
      }
      const readId = beginMounted(binding);
      if (state === "detached") detach();
      if (state === "replaced-lease") { detach(); binding.attach("new-view"); }
      if (state === "superseded-read") binding.beginRead();
      if (readId !== null) binding.acceptRead({ kind: "authorized", readId, baseline: { value: "changed" }, editable: state !== "readonly" }, { value: "changed" });
      expect(reconcileMountedRead).not.toHaveBeenCalled();
      expect(retained.data.value).toBe("retain verbatim");
      const view = binding.getSnapshot();
      if (view.current) expect(view.current.baseline.value).toBe("saved");
      if (view.reference) expect(view.reference.baseline.value).toBe("saved");
    });
  }
  it("lets the opt-in adapter refuse a write-context change without editing either copy", () => {
    const reconcileMountedRead = vi.fn(() => null);
    const { binding } = openDraftHarness({ ...scalarAdapter, reconcileMountedRead }, { value: "saved" }, { value: "saved" });
    binding.change(() => ({ value: "retain" })); const retained = binding.getSnapshot().current;
    const readId = beginMounted(binding);
    expect(readId).not.toBeNull();
    if (readId === null) return;
    binding.acceptRead({ kind: "authorized", readId, baseline: { value: "different context" }, editable: true }, { value: "different context" });
    expect(reconcileMountedRead).toHaveBeenCalledTimes(1);
    expect(binding.getSnapshot().mode).toBe("conflict");
    expect(binding.getSnapshot().current).toBe(retained);
  });
  it("keeps typing editable during mounted refresh and adopts the latest event data", () => {
    const { binding, reconcileMountedRead } = open();
    binding.change(() => ({ value: "before dispatch" }));
    const readId = beginMounted(binding);
    expect(readId).not.toBeNull();
    if (readId === null) return;
    expect(binding.getSnapshot().mode).toBe("editing");
    binding.change(() => ({ value: "typed while request pending" }));
    binding.acceptRead({ kind: "authorized", readId, baseline: { value: "changed" }, editable: true }, { value: "changed" });
    expect(reconcileMountedRead).toHaveBeenCalledTimes(1);
    expect(binding.getSnapshot().current?.data.value).toBe("typed while request pending");
    expect(binding.getSnapshot().current?.baseline.value).toBe("changed");
  });
  for (const transition of ["discard", "queued", "dispatched", "same-lease"] as const) it(`invalidates mounted eligibility after ${transition}`, () => {
    const { binding, detach, reconcileMountedRead } = open();
    binding.change(() => ({ value: "old work" }));
    const readId = beginMounted(binding);
    expect(readId).not.toBeNull();
    if (readId === null) return;
    if (transition === "discard") {
      binding.discard(binding.getSnapshot().current!.stamp);
      binding.change(() => ({ value: "new generation" }));
    } else if (transition === "same-lease") { detach(); binding.attach("first-view"); }
    else {
      const submission = binding.capture({ value: "old work" }, "intervening");
      if (transition === "dispatched") binding.dispatched(submission);
    }
    const before = binding.getSnapshot().current!;
    binding.acceptRead({ kind: "authorized", readId, baseline: { value: "changed" }, editable: true }, { value: "changed" });
    expect(reconcileMountedRead).not.toHaveBeenCalled();
    expect(binding.getSnapshot().current).toBe(before);
    expect(binding.getSnapshot().current!.data.value).toBe(transition === "discard" ? "new generation" : "old work");
  });
  it("refuses an already queued submission without hiding or blocking local typing", () => {
    const { binding } = open(); binding.change(() => ({ value: "submitted" }));
    const submission = binding.capture({ value: "submitted" }, "queued");
    expect(beginMounted(binding)).toBeNull();
    expect(binding.dispatched(submission)).toBe(true);
    binding.change(() => ({ value: "typed while save pending" }));
    expect(binding.getSnapshot().current?.data.value).toBe("typed while save pending");
  });
});
