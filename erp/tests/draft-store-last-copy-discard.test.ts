import { describe, expect, it, vi } from "vitest";
import { createBulkRecoveryAdapter, emptyBulkDraft, transitionBulkDraft } from "../src/lib/bulk-grid-recovery";
import { customFieldsRecoveryAdapter, type CustomFieldsBaseline, type CustomFieldsDraft } from "../src/lib/custom-fields-recovery";
import { createDraftStore, type Adapter, type Draft, type EditorBinding } from "../src/lib/draft-store";
import { projectLoads } from "../src/lib/order-bulk-recovery";
import { scalarAdapter, type Scalar } from "./helpers/draft-store";
import { orderBulkFixture } from "./helpers/order-bulk-fixture";

// #449 (owner ruling 2026-10-05: fix it in the shared draft store). After a conflict and Start
// fresh an editor holds two copies. Whichever is discarded last, an authorized, mounted editor
// with a known baseline ends in clean editing; it stays loading only while a read is owed.
type Fields = { loadNumber: string; qty: string; weight: string };
const loads = createBulkRecoveryAdapter<Fields>("order-loads", "order-loads-v1");
const loadsBaseline = (qty: number) => { const s = orderBulkFixture(); return projectLoads({ ...s, order: { ...s.order, loads: s.order.loads.map(l => ({ ...l, qty })) } }).baseline; };
const fieldsBaseline = (value: string): CustomFieldsBaseline => ({ partId: "part", permissions: ["parts.view", "parts.edit"],
  rows: [{ fieldId: "field-a", name: "A", type: "TEXT", sort: 0, active: true, value }] });
const fieldsClean = (b: CustomFieldsBaseline): CustomFieldsDraft => ({ values: new Map(b.rows.map(r => [r.fieldId, r.value])), original: new Map(b.rows.map(r => [r.fieldId, r.value])) });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the cases never touch an adapter's submission, response, receipt or requirement types
type Kit<D, B> = { adapter: Adapter<D, B, any, any, any, any>; baseline: (n: number) => B; clean: (b: B) => D; edit: (binding: EditorBinding<D, B, any, any, any, any>, text: string) => void };
const kits = {
  "order Loads (bulk)": { adapter: loads, baseline: (n: number) => loadsBaseline(20 + n), clean: () => emptyBulkDraft<Fields>(),
    edit: (binding, text) => binding.change(d => transitionBulkDraft(d, binding.getSnapshot().current!.baseline, { kind: "edit", id: "load-1", patch: { weight: text } })) } as Kit<ReturnType<typeof emptyBulkDraft<Fields>>, ReturnType<typeof loadsBaseline>>,
  "part custom fields": { adapter: customFieldsRecoveryAdapter, baseline: (n: number) => fieldsBaseline(`saved ${n}`), clean: fieldsClean,
    edit: (binding, text) => binding.change(d => ({ ...d, values: new Map(d.values).set("field-a", text) })) } as Kit<CustomFieldsDraft, CustomFieldsBaseline>,
  "scalar": { adapter: scalarAdapter, baseline: (n: number) => ({ value: `saved ${n}` }), clean: (b: Scalar) => b,
    edit: (binding, text) => binding.change(() => ({ value: text })) } as Kit<Scalar, Scalar>,
};
function open<D, B>(kit: Kit<D, B>) {
  const store = createDraftStore();
  const owner = store.acceptIdentity(store.beginIdentityCheck(), "u1")!;
  const binding = store.bind({ owner, record: { kind: "order", id: "o1" }, editor: kit.adapter.kind }, { label: "Editor", href: "/orders/o1" }, kit.adapter);
  let view = 0; let detach = binding.attach("view-0");
  const read = (n: number, editable = true) => { const baseline = kit.baseline(n); const readId = binding.beginRead();
    expect(binding.acceptRead({ kind: "authorized", readId, baseline, editable }, kit.clean(baseline))).toBe(true); return { readId, baseline }; };
  return { store, binding, read, leave: () => detach(), comeBack: () => { detach(); detach = binding.attach(`view-${++view}`); } };
}
/** A conflict, Start fresh, then typing again: a dirty current copy beside the earlier one. */
function twoCopies<D, B>(kit: Kit<D, B>, typeAgain = true) {
  const h = open(kit); h.read(0); kit.edit(h.binding, "first"); h.comeBack();
  const { readId, baseline } = h.read(1);
  expect(h.binding.getSnapshot().mode).toBe("conflict");
  expect(h.binding.startFresh(readId, kit.clean(baseline))).toBe(true);
  if (typeAgain) kit.edit(h.binding, "second");
  const view = h.binding.getSnapshot();
  expect(view.mode).toBe("editing"); expect(view.reference).toBeDefined();
  return { ...h, readId, baseline, current: view.current!.stamp, reference: view.reference!.stamp };
}
function expectCleanEditing<D, B>(kit: Kit<D, B>, h: ReturnType<typeof twoCopies<D, B>>, baseline: B = h.baseline) {
  const after = h.binding.getSnapshot();
  expect(after.mode).toBe("editing");
  expect(after.reference).toBeUndefined();
  expect(after.canRestore).toBe(false);
  expect(after.needsRefresh).toBe(false);
  expect(after.current!.baseline).toBe(baseline);
  expect(kit.adapter.dirty(after.current!.data, after.current!.baseline)).toBe(false);
  expect([h.current.generation, h.reference.generation]).not.toContain(after.current!.stamp.generation);
  expect(h.store.getSnapshot().count).toBe(0);
  expect(h.binding.restore(h.reference, h.readId)).toBe(false);
  kit.edit(h.binding, "typed after the discards");
  expect(kit.adapter.dirty(h.binding.getSnapshot().current!.data, baseline)).toBe(true);
  expect(h.store.getSnapshot().count).toBe(1);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- one loop over kits whose data and baseline types differ
for (const [name, kit] of Object.entries(kits) as [string, Kit<any, any>][]) describe(`the last retained copy of ${name} is discarded (#449)`, () => {
  it("current copy first, earlier copy second, from the editor's own notice", () => {
    const h = twoCopies(kit);
    h.binding.discard(h.current);
    expect(h.binding.getSnapshot().mode).toBe("conflict");
    expect(h.binding.getSnapshot().reference!.stamp).toBe(h.reference);
    h.binding.discard(h.reference);
    expectCleanEditing(kit, h);
  });
  it("earlier copy first, current copy second", () => {
    const h = twoCopies(kit);
    const sibling = h.binding.getSnapshot().current;
    h.binding.discard(h.reference);
    expect(h.binding.getSnapshot().current).toBe(sibling); // dismissing a reference never resets the copy being edited
    expect(h.binding.getSnapshot().mode).toBe("editing");
    h.binding.discard(h.current);
    expectCleanEditing(kit, h);
  });
  it("both at once from the Shell's drafts panel, which lists the current stamp first", () => {
    const h = twoCopies(kit);
    const row = h.store.getSnapshot().rows[0];
    expect(row.stamps).toEqual([h.current, h.reference]);
    h.store.discard(row.stamps);
    expectCleanEditing(kit, h);
  });
  it("both at once with the earlier stamp first", () => {
    const h = twoCopies(kit);
    h.store.discard([h.reference, h.current]);
    expectCleanEditing(kit, h);
  });
  it("an earlier copy left alone after leaving and returning", () => {
    const h = twoCopies(kit, false);
    h.comeBack(); const { baseline } = h.read(1);
    const view = h.binding.getSnapshot();
    expect(view.mode).toBe("conflict"); expect(view.current).toBeUndefined();
    h.binding.discard(view.reference!.stamp);
    expectCleanEditing(kit, h, baseline);
  });
  for (const order of ["current first", "earlier first", "Shell"] as const) it(`two blocked copies, ${order}`, () => {
    const h = twoCopies(kit);
    h.comeBack(); const { baseline } = h.read(2);
    const blocked = h.binding.getSnapshot();
    expect(blocked.mode).toBe("blocked-two-copies");
    if (order === "Shell") h.store.discard(h.store.getSnapshot().rows[0].stamps);
    else {
      h.binding.discard((order === "current first" ? blocked.current : blocked.reference)!.stamp);
      const left = h.binding.getSnapshot();
      expect(left.mode).toBe("conflict"); expect(left.current).toBeUndefined();
      h.binding.discard(left.reference!.stamp);
    }
    expectCleanEditing(kit, { ...h, current: blocked.current!.stamp, reference: blocked.reference!.stamp }, baseline);
  });
  it("stays loading while the access read is still out; that read ends it, restarted once under read requirements (#454)", () => {
    const h = twoCopies(kit);
    const readId = h.binding.beginRead();
    if (kit.adapter.readRequirements) expect(h.binding.readRequirements(readId)).not.toBeNull();
    h.store.discard([h.current, h.reference]);
    const waiting = h.binding.getSnapshot();
    expect(waiting.mode).toBe("loading"); expect(waiting.current).toBeUndefined(); expect(waiting.savedBaseline).toBeUndefined();
    const baseline = kit.baseline(1);
    const answer = (id: number) => h.binding.acceptRead({ kind: "authorized", readId: id, baseline, editable: true }, kit.clean(baseline));
    if (!kit.adapter.readRequirements) expect(answer(readId)).toBe(true);
    else {
      // The answer in flight was fetched for the discarded copies: it is refused and the read starts again, once.
      expect(answer(readId)).toBe(false);
      const restarted = h.binding.restartReadAfterChange(readId);
      expect(restarted).toEqual(expect.any(Number));
      expect(h.binding.restartReadAfterChange(readId)).toBeNull();
      expect(h.binding.readRequirements(restarted!)).not.toBeNull();
      expect(answer(restarted!)).toBe(true);
    }
    expectCleanEditing(kit, h, baseline);
  });
  // These two discriminate only for the kit with read requirements (part custom fields). For the
  // other kits the read in flight was never dropped, so they pass before #454 too and are controls.
  for (const gone of ["current", "earlier"] as const) it(`the ${gone} copy alone is discarded while the access read is out: the other keeps its generation (#454)`, () => {
    const h = twoCopies(kit);
    const survivor = gone === "current" ? h.reference : h.current;
    let readId = h.binding.beginRead();
    if (kit.adapter.readRequirements) expect(h.binding.readRequirements(readId)).not.toBeNull();
    h.store.discard([gone === "current" ? h.current : h.reference]);
    expect(h.store.getSnapshot().rows[0].stamps).toEqual([survivor]);
    const baseline = kit.baseline(1);
    const answer = (id: number) => h.binding.acceptRead({ kind: "authorized", readId: id, baseline, editable: true }, kit.clean(baseline));
    if (kit.adapter.readRequirements) {
      expect(answer(readId)).toBe(false);
      const restarted = h.binding.restartReadAfterChange(readId);
      expect(restarted).toEqual(expect.any(Number));
      expect(h.binding.restartReadAfterChange(readId)).toBeNull();
      readId = restarted!;
      expect(h.binding.readRequirements(readId)).not.toBeNull();
    }
    expect(answer(readId)).toBe(true);
    const after = h.binding.getSnapshot();
    expect(after.mode).toBe(gone === "current" ? "conflict" : "editing");
    const kept = gone === "current" ? after.reference : after.current;
    expect(kept!.stamp.generation).toBe(survivor.generation);
    expect(gone === "current" ? after.current : after.reference).toBeUndefined();
    expect(h.store.getSnapshot().count).toBe(1);
  });
  it("keeps an unavailable editor unavailable", () => {
    const h = twoCopies(kit);
    h.binding.acceptRead({ kind: "unavailable", readId: h.binding.beginRead() }, kit.clean(h.baseline));
    h.store.discard([h.current, h.reference]);
    expect(h.binding.getSnapshot()).toMatchObject({ mode: "unavailable", canRestore: false });
    expect(h.binding.getSnapshot().current).toBeUndefined();
  });
  it("builds nothing for an editor that is not mounted", () => {
    const h = twoCopies(kit);
    h.leave(); h.store.discard([h.current, h.reference]);
    expect(h.binding.getSnapshot().mode).toBe("loading");
    expect(h.binding.getSnapshot().savedBaseline).toBeUndefined();
    expect(h.store.getSnapshot().count).toBe(0);
  });
});

describe("what the last earlier copy's discard must not rebuild (#449)", () => {
  it("leaves an owed refresh owed: the baseline is the one from before the save", () => {
    const kit = kits.scalar; const h = twoCopies(kit);
    const submission = h.binding.capture({ value: "second" }, "request-1");
    expect(h.binding.dispatched(submission)).toBe(true);
    h.binding.settle(submission, { kind: "persisted", response: { value: "second" } });
    const saved = h.binding.getSnapshot();
    expect(saved).toMatchObject({ mode: "conflict", needsRefresh: true });
    expect(saved.current).toBeUndefined();
    h.binding.discard(saved.reference!.stamp);
    const after = h.binding.getSnapshot();
    expect(after).toMatchObject({ mode: "loading", needsRefresh: true });
    expect(after.current).toBeUndefined(); expect(after.reference).toBeUndefined();
    // The owed read is what ends it, on the baseline that read brings.
    const fresh = { value: "second" }; const readId = h.binding.beginRead();
    h.binding.acceptRead({ kind: "authorized", readId, baseline: fresh, editable: true }, fresh);
    expect(h.binding.getSnapshot()).toMatchObject({ mode: "editing", needsRefresh: false });
    expect(h.binding.getSnapshot().current!.baseline).toBe(fresh);
  });
  it("builds nothing underneath a completed receipt", () => {
    type Receipt = { id: string };
    const adapter: Adapter<Scalar, Scalar, Scalar, Scalar, Receipt> = { ...scalarAdapter, kind: "receipt-test", schema: "receipt-v1",
      settle: ({ current, submission, outcome }) => outcome.kind === "persisted"
        ? { kind: "retire", completed: { id: "made" }, ...(current.data !== submission.submitted.data ? { reference: { data: current.data, baseline: current.baseline } } : {}) }
        : { kind: "keep", data: current.data, baseline: current.baseline, needsRefresh: false } };
    const h = twoCopies({ ...kits.scalar, adapter } as Kit<Scalar, Scalar>);
    const submission = h.binding.capture({ value: "second" }, "request-1"); h.binding.dispatched(submission);
    h.binding.change(() => ({ value: "typed during the save" }));
    h.binding.settle(submission, { kind: "persisted", response: { value: "second" } });
    // The save completed; what was typed during it is kept beside the earlier copy.
    const done = h.binding.getSnapshot();
    expect(done.mode).toBe("completed"); expect(done.current).toBeDefined(); expect(done.reference).toBeDefined();
    h.binding.discard(done.current!.stamp);
    expect(h.binding.getSnapshot().needsRefresh).toBe(false);
    h.binding.discard(h.binding.getSnapshot().reference!.stamp);
    const after = h.binding.getSnapshot();
    expect(after.mode).toBe("completed"); expect(after.current).toBeUndefined(); expect(after.reference).toBeUndefined();
    // Nothing was rebuilt underneath the receipt, so dismissing it still asks for a new read.
    expect(h.binding.dismissCompleted(after.completedStamp!)).toBe(true);
    expect(h.binding.getSnapshot().savedBaseline).toBeUndefined();
    expect(h.binding.getSnapshot().mode).toBe("loading");
  });
  it("leaves a reinitializing creation editor to its new seed", () => {
    type Data = { nonce: string; note: string }; type Base = { customerId: string };
    const adapter: Adapter<Data, Base, Data, Base> = { kind: "creation-test", schema: "creation-v1", reinitializeAfterDiscard: true,
      valid: (d, b) => !!d && typeof (d as Data).nonce === "string" && !!b && typeof (b as Base).customerId === "string",
      dirty: d => d.note !== "", baselineEqual: (a, b) => a.customerId === b.customerId, preview: d => [{ label: "Note", value: d.note }],
      reconcileRead: ({ current, fresh }) => ({ data: current.data, baseline: fresh }),
      settle: ({ current }) => ({ kind: "keep", data: current.data, baseline: current.baseline, needsRefresh: false }) };
    let seeds = 0;
    const kit: Kit<Data, Base> = { adapter, baseline: n => ({ customerId: `c${n}` }), clean: () => ({ nonce: `seed-${++seeds}`, note: "" }),
      edit: (binding, text) => binding.change(d => ({ ...d, note: text })) };
    const h = twoCopies(kit, false);
    h.comeBack(); h.read(1);
    const view = h.binding.getSnapshot();
    expect(view.mode).toBe("conflict"); expect(view.current).toBeUndefined();
    h.binding.discard(view.reference!.stamp);
    const after = h.binding.getSnapshot();
    expect(after.mode).toBe("loading"); expect(after.savedBaseline).toBeUndefined(); expect(after.current).toBeUndefined();
    const used = seeds;
    h.binding.acceptRead({ kind: "authorized", readId: h.binding.beginRead(), baseline: { customerId: "c1" }, editable: true }, () => ({ nonce: `seed-${++seeds}`, note: "" }));
    expect(h.binding.getSnapshot().current!.data.nonce).toBe(`seed-${used + 1}`);
  });
  it("asks the adapter's cleanAfterDiscard about the earlier copy, and fails closed when it refuses", () => {
    type Data = { value: string; seq: number }; type Base = { value: string; historical?: boolean };
    const cleanAfterDiscard = vi.fn(({ discarded, clean, baseline }: { discarded: Draft<Data, Base>; clean: Data; baseline: Base }): Data => {
      if (baseline.historical) throw new Error("Discard cannot seed a historical draft.");
      return { ...clean, seq: discarded.data.seq };
    });
    const adapter: Adapter<Data, Base, Data, Base> = { kind: "sequence-test", schema: "sequence-v1", cleanAfterDiscard,
      valid: (d, b) => !!d && !!b && typeof (d as Data).value === "string" && Number.isSafeInteger((d as Data).seq) && typeof (b as Base).value === "string",
      dirty: (d, b) => d.value !== b.value, baselineEqual: (a, b) => a.value === b.value && !!a.historical === !!b.historical,
      preview: d => [{ label: "Value", value: d.value }], reconcileRead: ({ current, fresh }) => ({ data: current.data, baseline: fresh }),
      settle: ({ current }) => ({ kind: "keep", data: current.data, baseline: current.baseline, needsRefresh: false }) };
    const kit: Kit<Data, Base> = { adapter, baseline: n => ({ value: `saved ${n}` }), clean: b => ({ value: b.value, seq: 0 }),
      edit: (binding, text) => binding.change(d => ({ value: text, seq: d.seq + (text === "first" ? 7 : 1) })) };
    const h = twoCopies(kit);
    h.binding.discard(h.current);
    expect(cleanAfterDiscard).not.toHaveBeenCalled(); // an earlier copy remains, so nothing is rebuilt yet
    const earlier = h.binding.getSnapshot().reference!;
    h.binding.discard(h.reference);
    expect(cleanAfterDiscard).toHaveBeenCalledTimes(1);
    expect(cleanAfterDiscard.mock.calls[0][0].discarded).toBe(earlier);
    expect(h.binding.getSnapshot().current!.data).toEqual({ value: "saved 1", seq: 7 });

    const refused = twoCopies(kit, false);
    refused.comeBack(); const historical = { value: "saved 1", historical: true }; const readId = refused.binding.beginRead();
    refused.binding.acceptRead({ kind: "authorized", readId, baseline: historical, editable: false, recoveryAllowed: false }, { value: "saved 1", seq: 0 });
    refused.binding.discard(refused.binding.getSnapshot().reference!.stamp);
    const after = refused.binding.getSnapshot();
    expect(after.mode).toBe("error"); expect(after.current).toBeUndefined(); expect(after.reference).toBeUndefined(); expect(after.savedBaseline).toBeUndefined();
  });
});
