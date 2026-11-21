import { describe, expect, it, vi } from "vitest";
import type { Adapter, Draft } from "../src/lib/draft-store";
import { openDraftHarness } from "./helpers/draft-store";
type Data = { value: string; seq: number };
type Base = { value: string };
function open() {
  const observeNative = vi.fn((_current: Draft<Data, Base>) => { void _current; return false; });
  const reconcileNativeRead = vi.fn(() => null);
  const cleanAfterDiscard = vi.fn(({ discarded, clean }: { discarded: Draft<Data, Base>; clean: Data; baseline: Base }): Data => ({ ...clean, seq: discarded.data.seq }));
  const adapter: Adapter<Data, Base, Data, Base> & { cleanAfterDiscard: typeof cleanAfterDiscard } = {
    kind: "sequence-test", schema: "sequence-v1", cleanAfterDiscard, canBeginNativeRead: observeNative, reconcileNativeRead,
    valid: (d, b) => !!d && !!b && typeof d === "object" && typeof b === "object" && "value" in d && typeof d.value === "string"
      && "seq" in d && Number.isSafeInteger(d.seq) && Number(d.seq) >= 0 && "value" in b && typeof b.value === "string",
    dirty: (d, b) => d.value !== b.value, baselineEqual: (a, b) => a.value === b.value,
    preview: d => [{ label: "Value", value: d.value }],
    reconcileRead: ({ current, fresh }) => ({ data: current.data, baseline: fresh }),
    settle: () => ({ kind: "retire" }),
  };
  return { ...openDraftHarness(adapter, { value: "saved", seq: 0 }, { value: "saved" }), cleanAfterDiscard, observeNative, reconcileNativeRead };
}
describe("optional current Discard clean projection", () => {
  for (const editable of [true, false]) it(`retains the latest sequence across exact Discard with editable=${editable}`, () => {
    const { binding, baseline, clean, cleanAfterDiscard, store, observeNative, reconcileNativeRead } = open();
    binding.change(() => ({ value: "work", seq: 9 }));
    const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline, editable }, clean);
    const view = binding.getSnapshot(); const copy = view.current ?? view.reference;
    expect(copy?.data.seq).toBe(9); binding.discard(copy!.stamp);
    const after = binding.getSnapshot();
    if (editable) expect(after.current?.data).toEqual({ value: "saved", seq: 9 });
    else {
      expect(after.savedBaseline).toEqual(baseline); expect(after.current).toBeUndefined(); expect(after.reference).toBeUndefined();
      expect(after.mode).toBe("conflict"); expect(store.getSnapshot().count).toBe(0);
      // Observe the existing adapter admission boundary without admitting a read or
      // re-exposing clean readonly state as unsaved user work.
      expect(binding.beginNativeRead()).toBeNull(); expect(observeNative).toHaveBeenCalledTimes(1);
      expect(observeNative.mock.calls[0][0].data).toEqual({ value: "saved", seq: 9 });
      expect(reconcileNativeRead).not.toHaveBeenCalled();
    }
    expect(cleanAfterDiscard).toHaveBeenCalledTimes(1);
  });
  it("dropping an old reference leaves the active sibling and counter untouched", () => {
    const { binding, detach, cleanAfterDiscard } = open(); binding.change(() => ({ value: "old", seq: 5 }));
    detach(); binding.attach("return"); const readId = binding.beginRead();
    binding.acceptRead({ kind: "authorized", readId, baseline: { value: "fresh" }, editable: true }, { value: "fresh", seq: 0 });
    binding.startFresh(readId, { value: "fresh", seq: 0 }); binding.change(() => ({ value: "new work", seq: 12 }));
    const current = binding.getSnapshot().current!; binding.discard(binding.getSnapshot().reference!.stamp);
    expect(binding.getSnapshot().current).toBe(current); expect(current.data.seq).toBe(12); expect(cleanAfterDiscard).not.toHaveBeenCalled();
  });
  it("malformed discarded values remain dismissible without passing them to the projection", () => {
    const { binding, cleanAfterDiscard } = open(); binding.change(() => ({ value: "work", seq: 3 }));
    const copy = binding.getSnapshot().current!;
    // Simulate incompatible retained in-memory data at the explicit discard boundary.
    Object.assign(copy.data, { seq: "bad" });
    binding.discard(copy.stamp);
    expect(binding.getSnapshot().current?.data).toEqual({ value: "saved", seq: 0 });
    expect(cleanAfterDiscard).not.toHaveBeenCalled();
  });
  for (const invalid of ["malformed", "dirty"] as const) it(`fails closed for ${invalid} projection output without republishing discarded fields`, () => {
    const { binding, cleanAfterDiscard } = open(); binding.change(() => ({ value: "discarded secret", seq: 9 }));
    cleanAfterDiscard.mockImplementation(() => invalid === "malformed" ? { value: "discarded secret", seq: "bad" } as unknown as Data : { value: "discarded secret", seq: 9 });
    binding.discard(binding.getSnapshot().current!.stamp);
    expect(binding.getSnapshot().mode).toBe("error"); expect(binding.getSnapshot().current).toBeUndefined();
    expect(binding.getSnapshot().reference).toBeUndefined(); expect(binding.getSnapshot().savedBaseline).toBeUndefined();
  });

});
