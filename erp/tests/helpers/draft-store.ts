import { createDraftStore, type Adapter } from "../../src/lib/draft-store";

export type Scalar = Readonly<{ value: string }>;
const isScalar = (value: unknown): value is Scalar => typeof value === "object" && value !== null && "value" in value && typeof value.value === "string";
export const scalarAdapter: Adapter<Scalar, Scalar, Scalar, Scalar> = {
  kind: "test-fields", schema: "test-v1",
  valid: (data, baseline) => isScalar(data) && isScalar(baseline),
  dirty: (data, baseline) => data.value !== baseline.value,
  baselineEqual: (saved, fresh) => saved.value === fresh.value,
  preview: data => [{ label: "Value", value: data.value }],
  reconcileRead: ({ current, fresh }) => ({ data: current.data, baseline: fresh }),
  settle: ({ current, outcome }) => outcome.kind === "persisted"
    ? { kind: "retire" }
    : { kind: "keep", data: current.data, baseline: current.baseline, needsRefresh: outcome.kind === "unknown" },
};
/** A new store with one accepted identity, and `adapter` bound in it to order o1 and attached as
 *  its first view. No read has begun. */
export function bindDraftHarness<D, B, P, R, C, Q = never>(adapter: Adapter<D, B, P, R, C, Q>) {
  const store = createDraftStore();
  const owner = store.acceptIdentity(store.beginIdentityCheck(), "u1")!;
  const key = { owner, record: { kind: "order", id: "o1" }, editor: adapter.kind };
  const binding = store.bind(key, { label: "Draft", href: "/orders/o1" }, adapter);
  const detach = binding.attach("first-view");
  return { store, binding, detach };
}
export function openDraftHarness<D, B, P, R, C, Q = never>(adapter: Adapter<D, B, P, R, C, Q>, clean: D, baseline: B) {
  const { store, binding, detach } = bindDraftHarness(adapter);
  const readId = binding.beginRead();
  binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean);
  return { store, binding, readId, clean, baseline, detach };
}
export function openScalarDraft() {
  return openDraftHarness(scalarAdapter, { value: "saved" }, { value: "saved" });
}
