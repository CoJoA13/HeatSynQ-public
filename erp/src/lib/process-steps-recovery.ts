import { documentSteps, parseProcessDocument, sameProcessContent, type ProcessDraftStep, type ProcessDocumentInput, type ProcessDocumentBaseline, type ProcessDocumentResult, type StepFieldType } from "./process-document";
import { STEP_FIELD_TYPES } from "./step-field-constants";
import { parseRecipeSnapshot, type RecipeSnapshotV1 } from "./recipe-snapshot";
import type { Adapter, EditorBinding, Submission } from "./draft-store";
import type { DraftSession } from "./draft-session";
import { stagePendingRekey } from "./step-drafts";
import { newId } from "./client-id";
export type ProcessField = Readonly<{ id: string; label: string; type: string; unit: string | null; sort: number }>;
export type ProcessCode = Readonly<{ id: string; code: string; name: string; active: boolean; fields: readonly ProcessField[] }>;
/** A saved step's own parameter rows (spec 2026-09-26 §3.1), as the revision routes return them. */
export type ProcessParameter = Readonly<{ key: string; label: string; type: StepFieldType; unit: string | null; position: number; value: string }>;
export type ProcessStep = Readonly<{ id: string; position: number; codeId: string; code: string; codeName: string; instruction: string;
  parameters: readonly ProcessParameter[] }>;
export type ProcessRevision = Readonly<{ revisionNumber: number; recipeNumber?: string | null; recipeSnapshot?: RecipeSnapshotV1 | null; lockedAt: string | null; steps: readonly ProcessStep[] }>;
/** `orderCount` (owner ruling 2026-09-26): orders that are not voided whose lead line saved this
 *  revision, each once — what the picker prints as "on N orders". Required, like `stepCount`: a
 *  summary the server answered without it is a shape this client does not know. */
export type ProcessRevisionSummary = Readonly<{ revisionNumber: number; recipeNumber?: string | null; lockedAt: string | null; stepCount: number; orderCount: number; createdAt: string }>;
export type ProcessStepsDraft = Readonly<{ selectedRevision: number | null; recipeNumberEdit?: string | null;
  orderedEdits?: ReadonlyMap<number, readonly ProcessDraftStep[]>; submittedDocument?: ProcessDocumentInput;
  pendingRekey: Readonly<{ fromRevision?: number; toRevision: number; map: Readonly<Record<string, string>> }> | null }>;
export type ProcessStepsBaseline = Readonly<{ document?: ProcessDocumentBaseline; partId: string; permissions: readonly string[]; highestRevision: number | null;
  revisions: ReadonlyMap<number, ProcessRevision>; summaries: readonly ProcessRevisionSummary[]; codes: readonly ProcessCode[]; codesReady: boolean; selectedRevision?: number | null }>;
export type ProcessStepsIntent = Readonly<{ kind: "document"; document: ProcessDocumentInput }>
  | Readonly<{ kind: "recipe-number"; recipeNumber: string | null; expectedRecipeNumber: string | null }>;
export type ProcessStepsResponse = Readonly<{ document?: ProcessDocumentResult; revisionNumber: number | null; recipeNumber?: string | null; stepIdMap?: Readonly<Record<string, string>> }>;
export type ProcessStepsRequirements = Readonly<{ partId?: string; selectedRevision?: number | null; revisionNumbers: readonly number[] }>;
export type ProcessStepsBinding = EditorBinding<ProcessStepsDraft, ProcessStepsBaseline, ProcessStepsIntent, ProcessStepsResponse, never, ProcessStepsRequirements>;
export type CapturedProcessSteps = Readonly<{ binding: ProcessStepsBinding; submission: Submission<ProcessStepsDraft, ProcessStepsBaseline, ProcessStepsIntent> }>;
export type ProcessStepsPresentation = Readonly<{ codes: readonly ProcessCode[]; codesReady: boolean }>;
function record(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === "object" && !Array.isArray(v); }
const strings = (v: Record<string, unknown>, keys: readonly string[]) => keys.every(k => typeof v[k] === "string");
const number = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v);
const nullable = (v: unknown) => v === null || typeof v === "string";
function validSnapshot(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  try { parseRecipeSnapshot(value); return true; } catch { return false; }
}
const fieldType = (v: unknown) => typeof v === "string" && (STEP_FIELD_TYPES as readonly string[]).includes(v);
/** A step's rows, drafted or saved: unique keys, the wire shape (`position` only on saved rows). */
function validParameters(value: unknown, saved: boolean): boolean {
  if (!Array.isArray(value)) return false;
  const keys = new Set<string>();
  return value.every(p => {
    if (!record(p) || !strings(p, ["key", "label", "value"]) || !fieldType(p.type) || !nullable(p.unit) || keys.has(String(p.key)) || (saved && !number(p.position))) return false;
    keys.add(String(p.key)); return true;
  });
}
function validOrdered(value: unknown): boolean {
  // Recovery must remain readable even if an older accepted process exceeds today's wire budget.
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  return value.every(s => {
    if (!record(s) || !strings(s, ["clientId", "codeId", "instruction"]) || !nullable(s.stepId) || ids.has(String(s.clientId)) || !validParameters(s.parameters, false)) return false;
    ids.add(String(s.clientId));
    return true;
  });
}
function valid(data: unknown, baseline: unknown): boolean {
  if (!record(data)) return false;
  if (data.orderedEdits !== undefined && (!(data.orderedEdits instanceof Map) || ![...data.orderedEdits].every(([n, rows]) => number(n) && validOrdered(rows)))) return false;
  if (data.submittedDocument !== undefined && (!record(data.submittedDocument) || typeof data.submittedDocument.expectedBaselineToken !== "string" || !validOrdered(data.submittedDocument.steps))) return false;
  if (record(baseline) && baseline.document !== undefined) {
    const d = baseline.document;
    if (!record(d) || typeof d.baselineToken !== "string" || !Array.isArray(d.codes) || !valid({ selectedRevision: null, pendingRekey: null }, { ...baseline, document: undefined, codes: d.codes, revisions: d.revision === null ? new Map() : new Map([[record(d.revision) ? d.revision.revisionNumber : undefined, d.revision]]) })) return false;
  }
  if (!record(data) || !(data.recipeNumberEdit === undefined || nullable(data.recipeNumberEdit)) || !(data.selectedRevision === null || number(data.selectedRevision))) return false;
  if (data.pendingRekey !== null && (!record(data.pendingRekey) || !number(data.pendingRekey.toRevision) || !record(data.pendingRekey.map) || !(data.pendingRekey.fromRevision === undefined || number(data.pendingRekey.fromRevision))
    || !Object.values(data.pendingRekey.map).every(v => typeof v === "string"))) return false;
  if (!record(baseline) || typeof baseline.partId !== "string" || typeof baseline.codesReady !== "boolean" || !(baseline.highestRevision === null || number(baseline.highestRevision))
    || !Array.isArray(baseline.permissions) || !baseline.permissions.every(p => typeof p === "string") || !(baseline.revisions instanceof Map) || !Array.isArray(baseline.codes) || !Array.isArray(baseline.summaries)
    || !(baseline.selectedRevision === undefined || baseline.selectedRevision === null || number(baseline.selectedRevision))) return false;
  const field = (f: unknown) => record(f) && strings(f, ["id", "label", "type"]) && nullable(f.unit) && number(f.sort);
  if (!baseline.codes.every(c => record(c) && strings(c, ["id", "code", "name"]) && typeof c.active === "boolean" && Array.isArray(c.fields) && c.fields.every(field))) return false;
  if (!baseline.summaries.every(s => record(s) && number(s.revisionNumber) && (s.recipeNumber === undefined || nullable(s.recipeNumber)) && nullable(s.lockedAt) && number(s.stepCount) && number(s.orderCount) && typeof s.createdAt === "string")) return false;
  return [...baseline.revisions].every(([n, r]) => {
    if (!number(n) || !record(r) || r.revisionNumber !== n || !(r.recipeNumber === undefined || nullable(r.recipeNumber)) || !validSnapshot(r.recipeSnapshot) || !nullable(r.lockedAt) || !Array.isArray(r.steps)) return false;
    const ids = new Set<string>();
    return r.steps.every(s => {
      if (!record(s) || !strings(s, ["id", "codeId", "code", "codeName", "instruction"]) || !number(s.position) || ids.has(String(s.id)) || !validParameters(s.parameters, true)) return false;
      ids.add(String(s.id)); return true;
    });
  });
}
export function savedRecipeNumber(b: ProcessStepsBaseline): string | null {
  return b.summaries.find(s => s.revisionNumber === b.highestRevision)?.recipeNumber
    ?? (b.highestRevision === null ? null : b.revisions.get(b.highestRevision)?.recipeNumber) ?? null;
}
/** The ordered draft rows for one revision or, when it has none, that revision's saved steps as
 *  document rows. */
export function processDraftSteps(data: ProcessStepsDraft, baseline: ProcessStepsBaseline, revisionNumber: number): ProcessDraftStep[] {
  const ordered = data.orderedEdits?.get(revisionNumber);
  if (ordered) return ordered.map(s => ({ ...s, parameters: s.parameters.map(p => ({ ...p })) }));
  return (baseline.revisions.get(revisionNumber)?.steps ?? []).map(s => ({
    clientId: s.id, stepId: s.id, codeId: s.codeId, instruction: s.instruction,
    parameters: s.parameters.map(p => ({ key: p.key, label: p.label, type: p.type, unit: p.unit, value: p.value })),
  }));
}
function baselineSteps(baseline: ProcessStepsBaseline, revisionNumber: number): ProcessDraftStep[] {
  return processDraftSteps(clean(revisionNumber), baseline, revisionNumber);
}
/** Re-keys `rows` (the local draft) by what the save answered for `submitted`: each step's new id,
 *  and — when the answer carries them — each row's acknowledged key, adopted BY IDENTITY: the key
 *  the server returned for submitted row `i` goes to the local row whose key is that submitted
 *  row's key, wherever it now sits and whatever was typed into it since (Codex, #361). Matching by
 *  position swapped two hand-added rows reordered in flight, and keeping an old key would leave
 *  one the new baseline no longer holds, so the next save would reject a NUMBER row as hand-added.
 *  A local row whose key names no submitted row keeps its key; the next save resolves it. A
 *  recipe-number cut copies rows with their keys unchanged, so it passes no key map. */
function mapOrdered(rows: readonly ProcessDraftStep[], submitted: readonly ProcessDraftStep[], map: Readonly<Record<string, string>>, parameterKeys?: Readonly<Record<string, readonly string[]>>): ProcessDraftStep[] {
  return rows.map(row => {
    const original = submitted.find(s => s.clientId === row.clientId && s.stepId === row.stepId && s.codeId === row.codeId);
    const id = original ? map[original.clientId] ?? (original.stepId ? map[original.stepId] : undefined) : undefined;
    if (id) {
      const returned = original && parameterKeys?.[original.clientId];
      const adopted = new Map(returned ? original.parameters.map((p, i) => [p.key, returned[i]] as const).filter(([, key]) => key !== undefined) : []);
      return { ...row, clientId: id, stepId: id, parameters: row.parameters.map(p => ({ ...p, key: adopted.get(p.key) ?? p.key })) };
    }
    // A code replacement is an insertion, even if its old identity survived the request.
    if (row.stepId && submitted.some(s => s.clientId === row.clientId && s.codeId !== row.codeId)) return { ...row, stepId: null, clientId: `new:${newId()}` };
    return row;
  });
}
function documentSettlement(data: ProcessStepsDraft, baseline: ProcessStepsBaseline, submitted: ProcessDocumentInput, sourceRevision: number, result: ProcessDocumentResult) {
  const revision = result.baseline.revision;
  const nextRevision = revision?.revisionNumber ?? sourceRevision;
  const orderedEdits = new Map(data.orderedEdits);
  const local = mapOrdered(processDraftSteps(data, baseline, sourceRevision), submitted.steps, result.stepIdMap, result.parameterKeys);
  const acknowledged = mapOrdered(submitted.steps, submitted.steps, result.stepIdMap, result.parameterKeys);
  orderedEdits.delete(sourceRevision);
  if (!sameProcessContent(local, acknowledged) || local.some((s, i) => s.clientId !== acknowledged[i]?.clientId)) orderedEdits.set(nextRevision, local);
  const revisions = new Map(baseline.revisions); if (revision) revisions.set(nextRevision, revision);
  // A revision the save cut is on no order yet; one amended in place keeps the count it had.
  const prior = baseline.summaries.find(s => s.revisionNumber === nextRevision);
  return { data: { ...data, selectedRevision: revision?.revisionNumber ?? null, orderedEdits, submittedDocument: undefined, pendingRekey: null }, baseline: { ...baseline, document: result.baseline, codes: result.baseline.codes, highestRevision: revision?.revisionNumber ?? null, revisions,
    summaries: revision ? [{ revisionNumber: nextRevision, recipeNumber: revision.recipeNumber, lockedAt: revision.lockedAt, stepCount: revision.steps.length, orderCount: prior?.orderCount ?? 0, createdAt: prior?.createdAt ?? "" }, ...baseline.summaries.filter(s => s.revisionNumber !== nextRevision)] : baseline.summaries } };
}
function dirty(data: ProcessStepsDraft, b: ProcessStepsBaseline): boolean {
  if (data.submittedDocument) return true;
  for (const [n, rows] of data.orderedEdits ?? []) {
    const original = baselineSteps(b, n);
    if ((!b.revisions.has(n) && n !== 0) || !sameProcessContent(rows, original) || rows.some((s, i) => s.clientId !== original[i]?.clientId)) return true;
  }
  if (data.recipeNumberEdit !== undefined && data.recipeNumberEdit !== savedRecipeNumber(b)) return true;
  return false;
}
function matches(current: { data: ProcessStepsDraft; baseline: ProcessStepsBaseline }, fresh: ProcessStepsBaseline): boolean {
  const { data, baseline: saved } = current; const stage = data.pendingRekey;
  if (data.recipeNumberEdit !== undefined && savedRecipeNumber(saved) !== savedRecipeNumber(fresh)) return false;
  if (saved.partId !== fresh.partId || (!stage && saved.highestRevision !== fresh.highestRevision)) return false;
  if (stage && fresh.highestRevision !== stage.toRevision) return false;
  const target = stage ? fresh.revisions.get(stage.toRevision) : undefined;
  if (data.orderedEdits?.size && !stage && saved.document?.baselineToken !== fresh.document?.baselineToken) return false;
  // The token covers only the codes the saved steps name (R11), so an added step's code is
  // compared here: renamed or deleted since it was added, the draft lands in conflict mode as any
  // other change under it does (owner answer 2026-11-03).
  const added = addedCodeIds(data);
  if (added.length && saved.document && fresh.document && codeIdentities(saved.document, added) !== codeIdentities(fresh.document, added)) return false;
  for (const [n] of data.orderedEdits ?? []) {
    const before = baselineSteps(saved, n);
    const after = baselineSteps(fresh, stage && (n === stage.fromRevision || before.some(s => stage.map[s.clientId])) ? stage.toRevision : n);
    if (!sameProcessContent(before, after)) return false;
    if (!stage && before.some((s, i) => s.stepId !== after[i]?.stepId)) return false;
  }
  // Validate every explicit endpoint, including mappings no draft row names.
  if (stage) for (const [from, to] of Object.entries(stage.map)) {
    const old = [...saved.revisions.values()].flatMap(r => r.steps).find(s => s.id === from);
    const next = target?.steps.find(s => s.id === to);
    if (!next || (old && next.codeId !== old.codeId)) return false;
  }
  return true;
}
/** The codes a draft's added steps name, in every revision it edits. */
function addedCodeIds(data: ProcessStepsDraft): string[] {
  return [...(data.orderedEdits?.values() ?? [])].flatMap(rows => rows.flatMap(s => s.stepId === null ? [s.codeId] : []));
}
/** The id, code and name of each of `ids` in a document's catalog, `null` for one it lacks: the
 *  scope of the baseline token (R11, #659) when `ids` are the steps' codes plus the added ones. */
function codeIdentities(document: ProcessDocumentBaseline | undefined, ids: readonly string[]): string {
  return JSON.stringify([...new Set(ids)].sort().map(id => {
    const c = document?.codes.find(code => code.id === id);
    return c ? { id: c.id, code: c.code, name: c.name } : null;
  }));
}
function clean(selectedRevision: number | null): ProcessStepsDraft { return { selectedRevision, pendingRekey: null }; }
// v2 (owner ruling 2026-09-26): whole-document ordered drafts only. Drafts live in the open tab's
// memory, so no v1 draft (per-step overlays) survives the reload that installs this; none is converted.
export const processStepsRecoveryAdapter: Adapter<ProcessStepsDraft, ProcessStepsBaseline, ProcessStepsIntent, ProcessStepsResponse, never, ProcessStepsRequirements> = {
  kind: "process-steps", schema: "process-steps-v2", valid, dirty,
  baselineEqual: (saved, fresh, data) => data ? matches({ data, baseline: saved }, fresh)
    : JSON.stringify({ ...saved, revisions: [...saved.revisions] }) === JSON.stringify({ ...fresh, revisions: [...fresh.revisions] }),
  preview: (data, baseline) => [ ...[...(data.orderedEdits ?? [])].flatMap(([n, rows]) => [
    { label: `Rev ${n} process order`, value: rows.length ? rows.map(s => baseline.codes.find(c => c.id === s.codeId)?.code ?? s.codeId).join(" → ") : "All steps removed" },
    ...rows.flatMap((s, i) => [{ label: `Rev ${n} step ${i + 1} instruction`, value: s.instruction }, ...s.parameters.map(p => ({ label: `Rev ${n} step ${i + 1} ${p.label}`, value: p.value }))]),
  ]), ...(data.recipeNumberEdit !== undefined ? [{ label: "Recipe number", value: data.recipeNumberEdit ?? "(remove)" }] : []) ],
  readRequirements: ({ current, reference, submitted }) => {
    const copies = [current, reference, submitted].filter(c => c !== undefined);
    const first = copies[0]; const numbers = new Set<number>();
    for (const copy of copies) { if (copy.data.selectedRevision !== null) numbers.add(copy.data.selectedRevision); for (const n of copy.data.orderedEdits?.keys() ?? []) if (n !== 0) numbers.add(n); if (copy.data.pendingRekey) numbers.add(copy.data.pendingRekey.toRevision); }
    return { ...(first ? { partId: first.baseline.partId, selectedRevision: first.data.pendingRekey?.toRevision ?? first.data.selectedRevision } : {}), revisionNumbers: [...numbers] };
  },
  reconcileRead: ({ current, fresh }) => processStepsLand(current, fresh) ?? { data: current.data, baseline: current.baseline },
  reconcileRestore: ({ current, fresh }) => processStepsLand(current, fresh),
  reconcileUnknownRead: ({ current, submission, fresh }) => {
    if (submission.payload.kind !== "document" || !fresh.document || !fresh.permissions.includes("processes.edit") || current.baseline.partId !== fresh.partId) return null;
    if (current.data.recipeNumberEdit !== undefined && savedRecipeNumber(submission.submitted.baseline) !== savedRecipeNumber(fresh)) return null;
    const submitted = submission.payload.document;
    const revision = fresh.document.revision;
    const rows = revision ? baselineSteps({ ...fresh, revisions: new Map(fresh.revisions).set(revision.revisionNumber, revision) }, revision.revisionNumber) : [];
    // Keys are ignored here and adopted from the fresh rows: the lost answer is what would have
    // carried them, and a hand-added row's provisional key can never match a saved one.
    if (!sameProcessContent(submitted.steps, rows, { ignoreKeys: true })) return null;
    // The submitted steps' codes, added ones included: the token's scope (R11), not the catalog.
    const named = submitted.steps.map(s => s.codeId);
    if (codeIdentities(submission.submitted.baseline.document, named) !== codeIdentities(fresh.document, named)) return null;
    const result = documentSettlement(current.data, current.baseline, submitted, submission.submitted.data.selectedRevision ?? 0, {
      baseline: fresh.document,
      stepIdMap: Object.fromEntries(submitted.steps.map((s, i) => [s.clientId, rows[i].stepId!])),
      parameterKeys: Object.fromEntries(submitted.steps.map((s, i) => [s.clientId, rows[i].parameters.map(p => p.key)])),
    });
    return { data: result.data, baseline: { ...fresh, revisions: new Map([...current.baseline.revisions, ...fresh.revisions]) } };
  },
  settle: ({ current, submission, outcome }) => {
    if (submission.payload.kind === "document") {
      if (outcome.kind === "unknown") return { kind: "reference", data: { ...current.data, submittedDocument: submission.payload.document }, baseline: current.baseline, needsRefresh: true };
      if (outcome.kind === "persisted" && outcome.response.document) return { kind: "keep", ...documentSettlement(current.data, current.baseline, submission.payload.document, submission.submitted.data.selectedRevision ?? 0, outcome.response.document), needsRefresh: true };
    }
    if (outcome.kind !== "persisted") return { kind: outcome.kind === "unknown" ? "reference" : "keep", data: current.data, baseline: current.baseline, needsRefresh: outcome.kind === "unknown" };
    const intent = submission.payload; const result = outcome.response; let data = current.data; let baseline = current.baseline;
    if (intent.kind === "recipe-number") {
      if (data.recipeNumberEdit === submission.submitted.data.recipeNumberEdit) data = { ...data, recipeNumberEdit: undefined };
      // Record acknowledged identity even when N+1 has not been fetched yet. Keep old
      // step IDs until the returned explicit mapping lands against fresh rows.
      const recipeNumber = result.recipeNumber ?? null;
      const prior = baseline.summaries.find(s => s.revisionNumber === result.revisionNumber);
      baseline = { ...baseline, highestRevision: result.revisionNumber,
        summaries: result.revisionNumber === null ? [] : [{ revisionNumber: result.revisionNumber, recipeNumber,
          lockedAt: prior?.lockedAt ?? null, stepCount: prior?.stepCount ?? 0, orderCount: prior?.orderCount ?? 0, createdAt: prior?.createdAt ?? "" },
          ...baseline.summaries.filter(s => s.revisionNumber !== result.revisionNumber)],
        revisions: new Map([...baseline.revisions].map(([n, r]) => [n, n === result.revisionNumber ? { ...r, recipeNumber } : r])),
      };
      const acknowledged = result.document?.baseline;
      const previous = current.baseline.document;
      if (acknowledged && previous && (acknowledged.revision?.revisionNumber ?? null) === result.revisionNumber) {
        const before = baselineSteps(current.baseline, current.baseline.highestRevision ?? 0);
        const received = acknowledged.revision
          ? baselineSteps({ ...baseline, revisions: new Map([[acknowledged.revision.revisionNumber, acknowledged.revision]]) }, acknowledged.revision.revisionNumber)
          : [];
        // The token's scope (R11): the steps' codes, plus the codes the draft adds, which the
        // adopted catalog would otherwise bless unseen.
        const named = [...before.map(s => s.codeId), ...addedCodeIds(current.data)];
        const semantics = (document: ProcessDocumentBaseline) => codeIdentities(document, named);
        // A number-only acknowledgement may advance the document token, but cannot
        // silently bless unrelated process, identity, or code-name changes. (A parameter's
        // label, type and unit are the row's own now, so `sameProcessContent` covers them.)
        if (sameProcessContent(before, received)
          && before.every((step, index) => (result.stepIdMap?.[step.clientId] ?? step.clientId) === received[index]?.clientId)
          && semantics(previous) === semantics(acknowledged)
          && (previous.revision?.revisionNumber !== acknowledged.revision?.revisionNumber
            || previous.revision?.lockedAt === acknowledged.revision?.lockedAt)) {
          baseline = { ...baseline, document: acknowledged };
        }
      }
    }
    let pendingRekey: ProcessStepsDraft["pendingRekey"] = result.revisionNumber === null ? data.pendingRekey : stagePendingRekey(data.pendingRekey ? { toRevision: data.pendingRekey.toRevision, map: { ...data.pendingRekey.map } } : null, result.revisionNumber, { ...(result.stepIdMap ?? {}) });
    if (data.orderedEdits?.size && result.revisionNumber !== null && result.revisionNumber !== submission.submitted.data.selectedRevision) {
      pendingRekey = { toRevision: result.revisionNumber, map: pendingRekey?.map ?? {}, fromRevision: data.pendingRekey?.fromRevision ?? submission.submitted.data.selectedRevision ?? 0 };
    }
    data = { ...data, pendingRekey };
    return { kind: "keep", data, baseline, needsRefresh: true };
  },
};
export function prepareProcessSteps(binding: ProcessStepsBinding, intent: ProcessStepsIntent, requestId: string): CapturedProcessSteps | null {
  const view = binding.getSnapshot(); if (view.mode !== "editing" || !view.current || view.needsRefresh || !view.current.baseline.permissions.includes("processes.edit")) return null;
  const { data, baseline } = view.current;
  if (baseline.highestRevision !== null && data.selectedRevision !== baseline.highestRevision) return null;
  if (intent.kind === "document") {
    if (!baseline.document || !baseline.codesReady || data.submittedDocument) return null;
    const steps = processDraftSteps(data, baseline, data.selectedRevision ?? 0);
    const original = baselineSteps(baseline, data.selectedRevision ?? 0);
    if (sameProcessContent(steps, original) && steps.every((s, i) => s.stepId === original[i]?.stepId)) return null;
    // Each added step names the code and name it shows NOW (R11): after a 409's re-read the
    // catalog is the fresh one, so a kept copy would resend the old name forever.
    const document = parseProcessDocument({ expectedBaselineToken: baseline.document.baselineToken, steps: documentSteps(steps, baseline.document.codes) });
    return { binding, submission: binding.capture({ kind: "document", document }, requestId) };
  }
  // The only other intent: the recipe number, sent from the draft's own edit.
  if (data.recipeNumberEdit === undefined || data.recipeNumberEdit === savedRecipeNumber(baseline)) return null;
  return { binding, submission: binding.capture({ kind: "recipe-number", recipeNumber: data.recipeNumberEdit,
    expectedRecipeNumber: savedRecipeNumber(baseline) }, requestId) };
}
export function processStepsLand(current: Readonly<{ data: ProcessStepsDraft; baseline: ProcessStepsBaseline }>, fresh: ProcessStepsBaseline): Readonly<{ data: ProcessStepsDraft; baseline: ProcessStepsBaseline }> | null {
  const stage = current.data.pendingRekey;
  if (stage && !fresh.revisions.has(stage.toRevision)) return current;
  if (!matches(current, fresh)) return null;
  const displayed = fresh.selectedRevision === undefined ? fresh.highestRevision : fresh.selectedRevision;
  if (stage && displayed !== stage.toRevision) {
    // These old-ID projections include known submitted originals. A fetched old
    // revision is historical truth, not a rollback of that acknowledged write.
    const revisions = new Map(fresh.revisions);
    for (const [n, revision] of current.baseline.revisions) if (current.data.orderedEdits?.has(n)) revisions.set(n, revision);
    return { data: { ...current.data, selectedRevision: displayed }, baseline: { ...fresh, revisions } };
  }
  // The staged mapping is applied here, in the same commit that installs the rows it names (#288).
  const orderedEdits = new Map(current.data.orderedEdits);
  if (stage) for (const [n, rows] of orderedEdits) {
    if (n !== stage.fromRevision && !baselineSteps(current.baseline, n).some(s => stage.map[s.clientId])) continue;
    orderedEdits.delete(n);
    orderedEdits.set(stage.toRevision, mapOrdered(rows, baselineSteps(current.baseline, n), stage.map));
  }
  return { data: { ...current.data, orderedEdits, selectedRevision: fresh.selectedRevision === undefined ? stage?.toRevision ?? current.data.selectedRevision : fresh.selectedRevision, pendingRekey: null }, baseline: fresh };
}
export async function readProcessSteps(args: {
  binding: ProcessStepsBinding; session: DraftSession; partId: string; selectedRevision?: number | null;
  readRevisions: () => Promise<readonly ProcessRevisionSummary[]>;
  readRevision: (number: number) => Promise<ProcessRevision>;
  readCodes: () => Promise<readonly ProcessCode[]>;
  readDocument?: () => Promise<ProcessDocumentBaseline>;
  readIdentity: () => Promise<{ id: string; permissions: string[] }>;
  accepted: (id: number, presentation: ProcessStepsPresentation) => void;
}): Promise<boolean> {
  const { binding, session } = args; const ticket = session.readAuthorizationTicket(); if (!ticket) return false;
  let readId = binding.beginRead();
  for (let attempt = 0; attempt < 2; attempt++) {
    const q = binding.readRequirements(readId); if (!q || !session.isReadAuthorized(ticket)) return false;
    let baseline: ProcessStepsBaseline | undefined; let presentation: ProcessStepsPresentation = { codes: [], codesReady: false }; let selected: number | null = null;
    try {
      if (q.partId !== undefined && q.partId !== args.partId) throw new Error("Part identity changed.");
      const summaries = await args.readRevisions(); if (!session.isReadAuthorized(ticket)) return false;
      // A recovered null selection predates the first revision; follow the new current revision.
      selected = args.selectedRevision !== undefined ? args.selectedRevision : q.selectedRevision ?? summaries[0]?.revisionNumber ?? null;
      const numbers = new Set(q.revisionNumbers); if (selected !== null) numbers.add(selected);
      const revisions = new Map<number, ProcessRevision>();
      // The document answer carries the current revision and the catalog (#657), so with it
      // supplied neither is read on its own: only a revision other than the current is. Without
      // it (the older callers) every needed revision and the catalog are read as before.
      const document = args.readDocument ? await args.readDocument() : undefined;
      if (!session.isReadAuthorized(ticket)) return false;
      if (document) {
        if ((document.revision?.revisionNumber ?? null) !== (summaries[0]?.revisionNumber ?? null)) throw new Error("Process revision changed during read.");
        if (document.revision) revisions.set(document.revision.revisionNumber, document.revision);
      }
      for (const n of numbers) {
        if (!summaries.some(r => r.revisionNumber === n)) throw new Error("Revision unavailable.");
        if (revisions.has(n)) continue;
        const r = await args.readRevision(n); if (!session.isReadAuthorized(ticket)) return false;
        if (r.revisionNumber !== n) throw new Error("Revision identity changed.");
        revisions.set(n, { revisionNumber: r.revisionNumber, recipeNumber: r.recipeNumber ?? null, recipeSnapshot: r.recipeSnapshot ?? null, lockedAt: r.lockedAt, steps: r.steps.map(s => ({ id: s.id, position: s.position, codeId: s.codeId, code: s.code, codeName: s.codeName, instruction: s.instruction,
          parameters: s.parameters.map(p => ({ key: p.key, label: p.label, type: p.type, unit: p.unit, position: p.position, value: p.value })) })) });
      }
      if (document) presentation = { codes: document.codes, codesReady: true };
      else {
        try { const codes = await args.readCodes(); presentation = { codes: codes.map(c => ({ id: c.id, code: c.code, name: c.name, active: c.active, fields: c.fields.map(f => ({ id: f.id, label: f.label, type: f.type, unit: f.unit, sort: f.sort })) })), codesReady: true }; }
        catch { presentation = { codes: [], codesReady: false }; }
        if (!session.isReadAuthorized(ticket)) return false;
      }
      const me = await args.readIdentity(); if (!session.isReadAuthorized(ticket)) return false;
      if (me.id !== session.store.getSnapshot().owner?.userId || !me.permissions.includes("processes.view")) throw new Error("Process steps unavailable.");
      const used = new Set([...revisions.values()].flatMap(r => r.steps.map(s => s.codeId)));
      baseline = { ...(document ? { document } : {}), partId: args.partId, permissions: [...me.permissions], highestRevision: summaries[0]?.revisionNumber ?? null, selectedRevision: selected, revisions,
        summaries: summaries.map(s => ({ revisionNumber: s.revisionNumber, recipeNumber: s.recipeNumber ?? null, lockedAt: s.lockedAt, stepCount: s.stepCount, orderCount: s.orderCount, createdAt: s.createdAt })), codes: presentation.codes.filter(c => used.has(c.id)), codesReady: presentation.codesReady };
    } catch {
      if (!session.isReadAuthorized(ticket)) return false;
      if (binding.acceptRead({ kind: "unavailable", readId }, clean(null))) return false;
    }
    if (baseline && binding.acceptRead({ kind: "authorized", readId, baseline, editable: baseline.permissions.includes("processes.edit"), recoveryAllowed: baseline.codesReady }, clean(selected))) { args.accepted(readId, presentation); return true; }
    if (attempt !== 0 || !session.isReadAuthorized(ticket)) return false;
    const next = binding.restartReadAfterChange(readId); if (next === null) return false; readId = next;
  }
  return false;
}
