import type { Adapter, EditorBinding, Submission } from "./draft-store";
import type { DraftSession } from "./draft-session";
import { rowsAfterSave } from "./field-drafts";
export type CustomFieldRow = Readonly<{ fieldId: string; name: string; type: string; sort: number; active: boolean; value: string }>;
export type CustomFieldsDraft = Readonly<{ values: ReadonlyMap<string, string>; original: ReadonlyMap<string, string> }>;
export type CustomFieldsBaseline = Readonly<{ partId: string; permissions: readonly string[]; rows: readonly CustomFieldRow[] }>;
export type CustomFieldsPayload = Readonly<{ values: readonly Readonly<{ fieldId: string; value: string }>[] }>;
export type CustomFieldsBinding = EditorBinding<CustomFieldsDraft, CustomFieldsBaseline, CustomFieldsPayload, undefined, never, Readonly<{ partId?: string }>>;
export type CapturedCustomFields = Readonly<{ binding: CustomFieldsBinding; submission: Submission<CustomFieldsDraft, CustomFieldsBaseline, CustomFieldsPayload> }>;
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function stringMap(value: unknown): value is ReadonlyMap<string, string> { return value instanceof Map && [...value].every(([key, item]) => typeof key === "string" && typeof item === "string"); }
function valid(data: unknown, baseline: unknown): boolean {
  if (!record(data) || !stringMap(data.values) || !stringMap(data.original) || !record(baseline)
    || typeof baseline.partId !== "string" || !Array.isArray(baseline.permissions) || !baseline.permissions.every(p => typeof p === "string") || !Array.isArray(baseline.rows)) return false;
  const ids = new Set<string>();
  return baseline.rows.every(row => {
    if (!record(row) || typeof row.fieldId !== "string" || ids.has(row.fieldId) || typeof row.name !== "string"
      || typeof row.type !== "string" || typeof row.active !== "boolean" || typeof row.value !== "string" || !Number.isFinite(row.sort)) return false;
    ids.add(row.fieldId); return true;
  });
}
function changes(data: CustomFieldsDraft) { return [...data.values].filter(([id, value]) => !data.original.has(id) || value !== data.original.get(id)); }
function clean(baseline: CustomFieldsBaseline): CustomFieldsDraft {
  return { values: new Map(baseline.rows.map(r => [r.fieldId, r.value])), original: new Map(baseline.rows.map(r => [r.fieldId, r.value])) };
}
function same(saved: CustomFieldsBaseline, fresh: CustomFieldsBaseline, data?: CustomFieldsDraft): boolean {
  if (saved.partId !== fresh.partId) return false;
  if (!data) return JSON.stringify(saved) === JSON.stringify(fresh);
  return changes(data).every(([id]) => {
    const a = saved.rows.find(r => r.fieldId === id), b = fresh.rows.find(r => r.fieldId === id);
    return !!a && !!b && a.type === b.type && a.active === b.active && data.original.has(id) && data.original.get(id) === b.value;
  });
}
function reconcile(current: { data: CustomFieldsDraft }, fresh: CustomFieldsBaseline) {
  const rows = rowsAfterSave(fresh.rows, [...current.data.original].map(([fieldId, value]) => ({ fieldId, value })), [...current.data.values].map(([fieldId, value]) => ({ fieldId, value })));
  return { data: { values: new Map(rows.map(r => [r.fieldId, r.value])), original: new Map(fresh.rows.map(r => [r.fieldId, r.value])) }, baseline: fresh };
}
export const customFieldsRecoveryAdapter: Adapter<CustomFieldsDraft, CustomFieldsBaseline, CustomFieldsPayload, undefined, never, Readonly<{ partId?: string }>> = {
  kind: "custom-fields", schema: "custom-fields-v1", valid, dirty: data => changes(data).length > 0,
  baselineEqual: same,
  preview: (data, baseline) => changes(data).map(([id, value]) => ({ label: baseline.rows.find(r => r.fieldId === id)?.name ?? "Field", value })),
  readRequirements: ({ current, reference, submitted }) => { const b = (current ?? reference ?? submitted)?.baseline; return b ? { partId: b.partId } : {}; },
  reconcileRead: ({ current, fresh }) => reconcile(current, fresh),
  reconcileRestore: ({ current, fresh }) => same(current.baseline, fresh, current.data) ? reconcile(current, fresh) : null,
  settle: ({ current, submission, outcome }) => {
    if (outcome.kind !== "persisted") return { kind: outcome.kind === "unknown" ? "reference" : "keep", data: current.data, baseline: current.baseline, needsRefresh: outcome.kind === "unknown" };
    const values = new Map(current.data.values), original = new Map(current.data.original);
    const acknowledged = new Map(submission.payload.values.map(row => [row.fieldId, row.value.trim()]));
    for (const row of submission.payload.values) {
      const saved = acknowledged.get(row.fieldId)!;
      if (values.get(row.fieldId) === row.value) values.set(row.fieldId, saved);
      original.set(row.fieldId, saved);
    }
    return { kind: "keep", data: { values, original }, baseline: { ...current.baseline, rows: current.baseline.rows.map(row => acknowledged.has(row.fieldId) ? { ...row, value: acknowledged.get(row.fieldId)! } : row) }, needsRefresh: true };
  },
};
export function prepareCustomFields(binding: CustomFieldsBinding, requestId: string): CapturedCustomFields | null {
  const view = binding.getSnapshot();
  if (view.mode !== "editing" || !view.current || view.needsRefresh || !view.current.baseline.permissions.includes("parts.edit")) return null;
  const values = changes(view.current.data).map(([fieldId, value]) => ({ fieldId, value }));
  return values.length ? { binding, submission: binding.capture({ values }, requestId) } : null;
}
export function customFieldsRows(data: CustomFieldsDraft, baseline: CustomFieldsBaseline): readonly CustomFieldRow[] {
  return baseline.rows.map(row => data.values.has(row.fieldId) ? { ...row, value: data.values.get(row.fieldId)! } : row);
}
export async function readCustomFields(args: {
  binding: CustomFieldsBinding; session: DraftSession; partId: string;
  readRows: () => Promise<readonly CustomFieldRow[]>;
  readIdentity: () => Promise<{ id: string; permissions: string[] }>;
  accepted: (id: number) => void;
}): Promise<boolean> {
  const { binding, session } = args; const ticket = session.readAuthorizationTicket(); if (!ticket) return false;
  let readId = binding.beginRead();
  for (let attempt = 0; attempt < 2; attempt++) {
    const q = binding.readRequirements(readId); if (!q || !session.isReadAuthorized(ticket)) return false;
    let baseline: CustomFieldsBaseline | undefined;
    try {
      if (q.partId !== undefined && q.partId !== args.partId) throw new Error("Part identity changed.");
      const rows = await args.readRows(); if (!session.isReadAuthorized(ticket)) return false;
      const me = await args.readIdentity(); if (!session.isReadAuthorized(ticket)) return false;
      if (me.id !== session.store.getSnapshot().owner?.userId || !me.permissions.includes("parts.view")) throw new Error("Part fields are unavailable.");
      baseline = { partId: args.partId, permissions: [...me.permissions], rows: rows.map(r => ({ fieldId: r.fieldId, name: r.name, type: r.type, sort: r.sort, active: r.active, value: r.value })) };
    } catch {
      if (!session.isReadAuthorized(ticket)) return false;
      if (binding.acceptRead({ kind: "unavailable", readId }, { values: new Map(), original: new Map() })) return false;
    }
    if (baseline && binding.acceptRead({ kind: "authorized", readId, baseline, editable: baseline.permissions.includes("parts.edit") }, clean(baseline))) { args.accepted(readId); return true; }
    if (attempt !== 0 || !session.isReadAuthorized(ticket)) return false;
    const next = binding.restartReadAfterChange(readId); if (next === null) return false; readId = next;
  }
  return false;
}
