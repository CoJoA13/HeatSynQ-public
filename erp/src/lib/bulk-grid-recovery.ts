import type { Adapter, EditorView } from "./draft-store";
import { composeRows, mergeEdit, patchAdded, type AddedRow } from "./bulk-grid";

export type BulkContext = null | boolean | number | string | readonly BulkContext[] | { readonly [key: string]: BulkContext };
export type BulkDraft<F> = Readonly<{
  edits: ReadonlyMap<string, Partial<F>>;
  added: readonly AddedRow<F>[];
  removedIds: ReadonlySet<string>;
  orphanWarning: string | null;
  rangeInput?: string;
}>;
export type BulkBaseline<F> = Readonly<{
  rows: readonly Readonly<{ id: string; fields: F }>[];
  context: { readonly [key: string]: BulkContext };
}>;
export function emptyBulkDraft<F>(rangeInput?: string): BulkDraft<F> {
  return { edits: new Map(), added: [], removedIds: new Set(), orphanWarning: null,
    ...(rangeInput === undefined ? {} : { rangeInput }) };
}
export type BulkAction<F> =
  | { kind: "edit"; id: string; patch: Partial<F> }
  | { kind: "patch-added"; id: string; patch: Partial<F> }
  | { kind: "add"; rows: readonly AddedRow<F>[]; consumeRange?: boolean }
  | { kind: "remove-existing" | "remove-added"; id: string }
  | { kind: "range"; value: string };

/** Event reducer: IDs are created by the event caller, never by this transition. */
export function transitionBulkDraft<F extends Record<string, string>>(
  data: BulkDraft<F>, baseline: BulkBaseline<F>, action: BulkAction<F>,
): BulkDraft<F> {
  switch (action.kind) {
    case "edit": {
      const row = baseline.rows.find(r => r.id === action.id);
      if (!row) return data;
      const patch = mergeEdit(data.edits.get(action.id), action.patch, row.fields);
      const edits = new Map(data.edits);
      if (patch) edits.set(action.id, patch); else edits.delete(action.id);
      return { ...data, edits };
    }
    case "patch-added": return { ...data, added: patchAdded(data.added, action.id, action.patch) };
    case "add": return { ...data, added: [...data.added, ...action.rows.map(r => ({ ...r, clientId: r.clientId }))],
      ...(action.consumeRange ? { rangeInput: "" } : {}) };
    case "remove-existing": {
      const removedIds = new Set(data.removedIds); removedIds.add(action.id);
      const edits = new Map(data.edits); edits.delete(action.id);
      return { ...data, removedIds, edits };
    }
    case "remove-added": return { ...data, added: data.added.filter(r => r.clientId !== action.id) };
    case "range": return data.rangeInput === action.value ? data : { ...data, rangeInput: action.value };
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function contextValid(value: unknown): boolean {
  return value === null || typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
    || (Array.isArray(value) ? value.every(contextValid) : record(value) && Object.values(value).every(contextValid));
}
function fieldsValid(value: unknown): boolean {
  return record(value) && Object.values(value).every(v => typeof v === "string")
    && !["key", "isNew", "clientId"].some(key => key in value);
}
/** Ordered arrays compare exactly; object property enumeration order is irrelevant. */
function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (!record(a) || !record(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}
export function bulkGridDirty<F>(data: BulkDraft<F>): boolean {
  return data.edits.size > 0 || data.added.length > 0 || data.removedIds.size > 0;
}
export type BulkPreview = readonly Readonly<{ label: string; value: string }>[];
export type BulkRecoveryCustomization<F> = Readonly<{
  /** Additional domain checks after generic validation, only at store transitions. */
  valid?: (data: BulkDraft<F>, baseline: BulkBaseline<F>) => boolean;
  comparison?: (baseline: BulkBaseline<F>) => BulkContext;
  preview?: (data: BulkDraft<F>, baseline: BulkBaseline<F>) => BulkPreview;
}>;
/** Store transitions already validate and authorize these projections. Hidden or
 * failed views remain discardable by their stamps, but never expose previews. */
export function bulkRecoveryPreviews<F, P, R, C>(
  adapter: Adapter<BulkDraft<F>, BulkBaseline<F>, P, R, C>,
  view: EditorView<BulkDraft<F>, BulkBaseline<F>, C>,
): { currentPreview?: BulkPreview; referencePreview?: BulkPreview; submittedPreview?: BulkPreview } {
  if (view.recoveryAllowed === false || ["loading", "unavailable", "error", "completed"].includes(view.mode)) return {};
  if (view.mode === "editing") return view.reference ? { referencePreview: adapter.preview(view.reference.data, view.reference.baseline) } : {};
  return {
    ...(view.current ? { currentPreview: adapter.preview(view.current.data, view.current.baseline) } : {}),
    ...(view.reference ? { referencePreview: adapter.preview(view.reference.data, view.reference.baseline) } : {}),
    ...(view.submitted ? { submittedPreview: adapter.preview(view.submitted.data, view.submitted.baseline) } : {}),
  };
}
export function createBulkRecoveryAdapter<F extends Record<string, string>>(
  kind: string, schema: string, customization: BulkRecoveryCustomization<F> = {},
): Adapter<BulkDraft<F>, BulkBaseline<F>, unknown, BulkBaseline<F>> {
  return {
    kind, schema,
    valid(data, baseline) {
      if (!record(data) || !record(baseline) || !Array.isArray(baseline.rows)
        || !record(baseline.context) || !contextValid(baseline.context)
        || !(data.edits instanceof Map) || !(data.removedIds instanceof Set) || !Array.isArray(data.added)
        || !(data.orphanWarning === null || typeof data.orphanWarning === "string")
        || !(data.rangeInput === undefined || typeof data.rangeInput === "string")) return false;
      return baseline.rows.every(r => record(r) && typeof r.id === "string" && fieldsValid(r.fields))
        && new Set(baseline.rows.map(r => r.id)).size === baseline.rows.length
        && [...data.edits].every(([id, fields]) => typeof id === "string" && fieldsValid(fields))
        && [...data.removedIds].every(id => typeof id === "string")
        && data.added.every(r => { if (!record(r) || typeof r.clientId !== "string") return false;
          const { clientId: _clientId, ...fields } = r; void _clientId; return fieldsValid(fields); })
        && new Set(data.added.map(r => r.clientId)).size === data.added.length
        && (customization.valid?.(data as BulkDraft<F>, baseline as BulkBaseline<F>) ?? true);
    },
    dirty: data => bulkGridDirty(data) || (data.rangeInput !== undefined && data.rangeInput !== ""),
    baselineEqual: (saved, fresh) => equal(customization.comparison?.(saved) ?? saved, customization.comparison?.(fresh) ?? fresh),
    preview(data, baseline) {
      if (customization.preview) return customization.preview(data, baseline);
      const rows = composeRows({ serverRows: baseline.rows, toFields: r => r.fields, ...data });
      const preview = rows.flatMap((row, i) => Object.entries(row)
        .filter(([key]) => !["key", "isNew", "clientId"].includes(key))
        .map(([key, value]) => {
          if (key === "typeId") {
            const catalog = baseline.context.containerTypes;
            const item = Array.isArray(catalog) ? catalog.find(item => record(item) && item.id === value) : undefined;
            return { label: `Row ${i + 1} type`, value: record(item) && typeof item.name === "string" ? item.name : value === "" ? "" : "Unavailable type" };
          }
          return { label: `Row ${i + 1} ${key.replace(/([A-Z])/g, " $1").toLowerCase()}`, value: String(value) };
        }));
      if (data.rangeInput !== undefined) preview.push({ label: "Unadded serial input", value: data.rangeInput });
      return preview;
    },
    reconcileRead: ({ current, fresh }) => ({ data: current.data, baseline: fresh }),
    reconcileMountedRead({ current, fresh }) {
      const contextOnly = (baseline: BulkBaseline<F>) => customization.comparison?.({ ...baseline, rows: [] }) ?? baseline.context;
      if (!equal(contextOnly(current.baseline), contextOnly(fresh))) return null;
      const ids = new Set(fresh.rows.map(r => r.id));
      const edits = new Map([...current.data.edits].filter(([id]) => ids.has(id)));
      const removedIds = new Set([...current.data.removedIds].filter(id => ids.has(id)));
      const orphaned = edits.size !== current.data.edits.size || removedIds.size !== current.data.removedIds.size;
      return { baseline: fresh, data: { ...current.data, edits, removedIds,
        orphanWarning: orphaned ? "This list changed on the server while you were editing — your unsaved changes here were set aside; please re-check." : current.data.orphanWarning } };
    },
    settle({ current, outcome }) {
      if (outcome.kind !== "persisted") return { kind: "keep", data: current.data, baseline: current.baseline, needsRefresh: outcome.kind === "unknown" };
      // A landed Save consumes every grid edit in this generation. None can be made during
      // transport, since the grid closes its inputs while its own save is out (R23, #702;
      // `saving` in bulk-grid.ts). Unsubmitted serial text is a separate input and survives.
      return { kind: "keep", data: emptyBulkDraft<F>(current.data.rangeInput), baseline: outcome.response, needsRefresh: true };
    },
  };
}
