import { expect, it, vi } from "vitest";
import { createDraftStore, type Adapter, type Draft } from "../src/lib/draft-store";

type Data = Readonly<{ changed: string; clean: string }>;
type Baseline = Readonly<{ changed: string; clean: string }>;
type Proposed = Adapter<Data, Baseline, string, undefined> & {
  baselineEqual(saved: Baseline, fresh: Baseline, current?: Data): boolean;
  reconcileRestore?(args: { current: Draft<Data, Baseline>; fresh: Baseline }): { data: Data; baseline: Baseline } | null;
};
const initial = { changed: "original", clean: "before" };
function open(extra: Partial<Proposed> = {}) {
  const adapter: Proposed = { kind: "partial-test", schema: "partial-test-1", valid: (data) => typeof (data as Data).changed === "string",
    dirty: (data, baseline) => data.changed !== baseline.changed,
    baselineEqual: (saved, fresh) => saved.changed === fresh.changed && saved.clean === fresh.clean,
    reconcileRead: ({ current, fresh }) => ({ data: current.data, baseline: fresh }), preview: () => [], settle: () => ({ kind: "retire" }), ...extra };
  const store = createDraftStore(); const owner = store.acceptIdentity(store.beginIdentityCheck(), "user")!;
  const binding = store.bind({ owner, record: { kind: "part", id: "part" }, editor: adapter.kind }, { label: "Partial test", href: "/parts/part" }, adapter);
  const detach = binding.attach("first"); const id = binding.beginRead();
  binding.acceptRead({ kind: "authorized", readId: id, editable: true, baseline: initial }, initial);
  binding.change(d => ({ ...d, changed: "mine" }));
  return { store, binding, detach };
}
function revisit(h: ReturnType<typeof open>, fresh: Baseline) {
  h.detach(); h.binding.attach("return"); const id = h.binding.beginRead();
  h.binding.acceptRead({ kind: "authorized", readId: id, editable: true, baseline: fresh }, fresh); return id;
}
it("comparison receives the exact owned current data, without a second intent cache", () => {
  const compare = vi.fn((saved: Baseline, fresh: Baseline, data?: Data) => !!data && data.changed !== saved.changed && saved.changed === fresh.changed);
  const h = open({ baselineEqual: compare }); const owned = h.binding.getSnapshot().current!.data;
  revisit(h, { changed: "original", clean: "server moved" });
  expect(h.binding.getSnapshot().canRestore).toBe(true);
  expect(compare).toHaveBeenLastCalledWith(initial, { changed: "original", clean: "server moved" }, owned);
});
it("default two-baseline adapters still conflict on their complete baseline", () => {
  const h = open(); revisit(h, { changed: "original", clean: "server moved" });
  expect(h.binding.getSnapshot().mode).toBe("conflict"); expect(h.binding.getSnapshot().canRestore).toBe(false);
});
it("opt-in Restore lands fresh clean fields atomically only after exact admission", () => {
  const reconcileRestore = vi.fn(({ current, fresh }: { current: Draft<Data, Baseline>; fresh: Baseline }) => ({ data: { changed: current.data.changed, clean: fresh.clean }, baseline: fresh }));
  const h = open({ baselineEqual: () => true, reconcileRestore }); const id = revisit(h, { changed: "original", clean: "fresh" });
  const stamp = h.binding.getSnapshot().current!.stamp;
  expect(h.binding.restore({ ...stamp, version: stamp.version + 1 }, id)).toBe(false);
  expect(h.binding.restore(stamp, id - 1)).toBe(false); expect(reconcileRestore).not.toHaveBeenCalled();
  const observed: unknown[] = []; h.binding.subscribe(() => observed.push(h.binding.getSnapshot()));
  expect(h.binding.restore(stamp, id)).toBe(true); expect(reconcileRestore).toHaveBeenCalledTimes(1);
  expect(h.binding.getSnapshot().current).toMatchObject({ data: { changed: "mine", clean: "fresh" }, baseline: { changed: "original", clean: "fresh" } });
  expect(observed).toHaveLength(1);
  expect(h.binding.restore(stamp, id)).toBe(false); expect(reconcileRestore).toHaveBeenCalledTimes(1);
});
it("refused, thrown or malformed Restore reconciliation never enables editing or destroys the stamped copy", () => {
  for (const result of [null, "throw", { data: { changed: 42, clean: "bad" }, baseline: initial }]) {
    const h = open({ baselineEqual: () => true, reconcileRestore: () => {
      if (result === "throw") throw new Error("invalid projection");
      return result as { data: Data; baseline: Baseline } | null;
    } });
    const id = revisit(h, initial); const stamp = h.binding.getSnapshot().current!.stamp;
    expect(h.binding.restore(stamp, id)).toBe(false);
    expect(h.binding.getSnapshot().mode).toBe("error"); expect(h.binding.getSnapshot().current?.stamp).toEqual(stamp);
    h.binding.discard(stamp); expect(h.store.getSnapshot().count).toBe(0);
  }
});
it("an ordinary read prepared after an offer hides access and cannot overlap Restore admission", () => {
  const reconcileRestore = vi.fn(({ current, fresh }: { current: Draft<Data, Baseline>; fresh: Baseline }) => ({ data: current.data, baseline: fresh }));
  const h = open({ baselineEqual: () => true, reconcileRestore }); const acceptedId = revisit(h, initial); const stamp = h.binding.getSnapshot().current!.stamp;
  const pendingId = h.binding.beginRead(); expect(h.binding.getSnapshot().savedBaseline).toBeUndefined();
  expect(h.binding.restore(stamp, acceptedId)).toBe(false); expect(reconcileRestore).not.toHaveBeenCalled();
  h.binding.acceptRead({ kind: "authorized", readId: pendingId, editable: true, baseline: initial }, initial);
  expect(h.binding.restore(stamp, acceptedId)).toBe(false); expect(reconcileRestore).not.toHaveBeenCalled();
  expect(h.binding.restore(stamp, pendingId)).toBe(true); expect(reconcileRestore).toHaveBeenCalledTimes(1);
});
it("Restore never invokes customization after owner change or without a live lease", () => {
  const restore = vi.fn(() => ({ data: initial, baseline: initial }));
  const h = open({ baselineEqual: () => true, reconcileRestore: restore }); h.detach();
  const id = h.binding.beginRead(); h.binding.acceptRead({ kind: "authorized", readId: id, baseline: initial, editable: true }, initial);
  const stamp = h.store.getSnapshot().rows[0].stamps[0]; expect(h.binding.restore(stamp, id)).toBe(false);
  h.store.resetIdentity(); expect(h.binding.restore(stamp, id)).toBe(false); expect(restore).not.toHaveBeenCalled();
});
