import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedUpdate } from "./audit";
import { claimRecipeCodes } from "./recipe-catalog-claim";
import { claimProcessForEdit, ensureWorkingProcess, replaceStepParameters, validateStepValue, loadCurrentRevision, rowsDetailOf } from "./part-process-steps";
import {
  PROVISIONAL_KEY, assertProcessSize, documentSteps, normalizeUnit, parametersFromSuggestions, parseProcessDocument, sameProcessContent,
  type ProcessDocumentBaseline, type ProcessDocumentResult, type ProcessDraftStep, type ProcessEditorCode, type ProcessDocumentInput, type ProcessParameterInput,
} from "../lib/process-document";

/** Used only behind the process read/edit permission boundary. Defaults are not session vocabulary.
 *  Lists each code's live suggestions only; the save verifies new steps' keys against removed ones
 *  too, with its own read (`saveProcessDocument`). */
export async function readProcessEditorCatalog(tx: Prisma.TransactionClient = prisma): Promise<ProcessEditorCode[]> {
  const codes = await tx.processStepCode.findMany({
    where: { deletedAt: null }, orderBy: [{ code: "asc" }, { id: "asc" }],
    include: { fields: { where: { deletedAt: null }, orderBy: [{ sort: "asc" }, { id: "asc" }] } },
  });
  return codes.map(c => ({
    id: c.id, code: c.code, name: c.name, active: c.active,
    defaultInstruction: z.string().max(4000).parse(c.defaultInstruction),
    fields: c.fields.map(f => ({ id: f.id, label: f.label, type: f.type, unit: f.unit, sort: f.sort })),
  }));
}
/** `claimed` is the current revision a caller already read under its claim, with
 *  `loadCurrentRevision`'s include tree (`claimProcessForEdit`'s answer, #658); left out, it is read
 *  here. */
export async function readProcessDocumentProjection(tx: Prisma.TransactionClient, partId: string, claimed?: Awaited<ReturnType<typeof loadCurrentRevision>>) {
  const part = await tx.part.findFirst({ where: { id: partId, deletedAt: null }, select: { id: true, recipe: true } });
  if (!part) throw new HttpError(404, "Part not found");
  // ONE read of the current revision serves the steps, the token and the baseline's rows (#657;
  // it was read twice, here and again through `readRevisionRows`). `loadCurrentRevision` orders
  // steps by position alone, which `@@unique([revisionId, position])` makes the [position, id]
  // order this projection used, so the token is byte-identical.
  const current = claimed !== undefined ? claimed : await loadCurrentRevision(partId, tx);
  const codes = await readProcessEditorCatalog(tx);
  // Steps come from the part's own rows (spec 2026-09-26 §3.1): keys included, so a re-keyed row
  // changes the token and an open editor learns of it.
  const steps: ProcessDraftStep[] = (current?.steps ?? []).map(s => ({
    clientId: s.id, stepId: s.id, codeId: s.codeId, instruction: s.instruction,
    parameters: s.parameters.map(p => ({ key: p.key, label: p.label, type: p.type, unit: p.unit, value: p.value })),
  }));
  // The identity and names of the codes the revision's steps name, and no other (R11, #659): a
  // catalog edit to a code this part does not use must not answer 409 to every open editor. A code
  // a draft ADDS is checked against the code and name its step sends (`codeSeen`, the save's
  // check in `validateProcessDocumentDraft`), since this read cannot know which those are.
  // Suggestions no longer affect a part's rows (§3.2), so editing one must not answer 409 either;
  // defaults and eligibility flags stay out so a default edit cannot replace the instruction the
  // user copied (eligibility is validated separately under the claims). A deleted code a step
  // names drops out of the live catalog, which changes the token.
  const named = new Set(steps.map(s => s.codeId));
  const semantics = codes.filter(c => named.has(c.id)).map(c => ({ id: c.id, code: c.code, name: c.name }));
  const baselineToken = createHash("sha256").update(JSON.stringify({
    partId,
    revisionId: current?.id ?? null,
    revisionNumber: current?.revisionNumber ?? null,
    locked: !!current?.lockedAt,
    revisionRecipeId: current?.recipeId ?? null,
    recipeId: part.recipe?.id ?? null,
    recipeNumber: part.recipe?.number ?? null,
    steps,
    semantics,
  })).digest("hex");
  // The editable revision is its ROWS even when it is locked and captured (`readRevisionRows`);
  // the captured projection stays for order and history reads.
  const detail = current ? rowsDetailOf(current) : null;
  const baseline: ProcessDocumentBaseline = {
    baselineToken, codes,
    revision: detail ? { ...detail, lockedAt: detail.lockedAt?.toISOString() ?? null } : null,
  };
  return { baseline, steps };
}
export async function readProcessDocument(partId: string): Promise<ProcessDocumentBaseline> {
  return prisma.$transaction(async tx => (await readProcessDocumentProjection(tx, partId)).baseline, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
/** The added steps' codes that are no longer live but still exist: deleted since the operator
 *  added them, which answers the stale 409 (owner answer 2026-11-03), where a code that never
 *  existed keeps its 400. Reads nothing unless an added step names a code the live catalog lacks. */
export async function deletedAddedCodes(
  tx: Prisma.TransactionClient, before: Awaited<ReturnType<typeof readProcessDocumentProjection>>, data: ProcessDocumentInput,
): Promise<ReadonlySet<string>> {
  const missing = [...new Set(data.steps.flatMap(s => s.stepId === null && !before.baseline.codes.some(c => c.id === s.codeId) ? [s.codeId] : []))];
  if (missing.length === 0) return new Set();
  return new Set((await tx.processStepCode.findMany({ where: { id: { in: missing } }, select: { id: true } })).map(c => c.id));
}
/** Read-only semantic validation shared by save and draft preview. `deleted` is
 *  `deletedAddedCodes`'s answer on the same transaction. */
export function validateProcessDocumentDraft(
  before: Awaited<ReturnType<typeof readProcessDocumentProjection>>, data: ProcessDocumentInput, deleted: ReadonlySet<string>,
): boolean {
  // Identity is structural: removing/reinserting an identical row still needs a surviving
  // new-client mapping, and swapping identical rows must preserve their individual identity.
  const sameIdentities = before.steps.length === data.steps.length
    && before.steps.every((step, index) => step.stepId === data.steps[index].stepId);
  const stale = () => new HttpError(409, "The process changed — reload before saving");
  if (before.baseline.baselineToken !== data.expectedBaselineToken) throw stale();
  // The token's other half (R11): an added step's code must still be the code and name the
  // operator saw, and still exist. Checked before any 400, as the token is.
  for (const step of data.steps) {
    if (step.stepId !== null) continue;
    const code = before.baseline.codes.find(c => c.id === step.codeId);
    if (!code ? deleted.has(step.codeId) : step.codeSeen !== undefined && (step.codeSeen.code !== code.code || step.codeSeen.name !== code.name)) throw stale();
  }
  const unchanged = sameIdentities && sameProcessContent(before.steps, data.steps);
  const existing = new Map(before.steps.map(s => [s.stepId, s]));
  for (const step of data.steps) {
    const old = step.stepId === null ? null : existing.get(step.stepId);
    if (step.stepId !== null && (!old || old.codeId !== step.codeId)) throw new HttpError(400, "That step does not belong to this process or its code changed");
    const code = before.baseline.codes.find(c => c.id === step.codeId);
    if (!code || (!old && !code.active)) throw new HttpError(400, "That process code is deleted or inactive");
    if (!old && step.codeSeen === undefined) throw new HttpError(400, "A new step must name the code it was added as");
    // Each row is validated by its OWN type and named by its own label (spec §3.1).
    for (const p of step.parameters) validateStepValue({ label: p.label, type: p.type }, p.value);
  }
  // The budget is the document itself: rows carry their own metadata, so nothing else is stored.
  assertProcessSize(data.steps);
  return unchanged;
}
/** Server-authoritative keys (spec §3.3). A row has an ORIGIN when its submitted key names this
 *  step's saved row or, for a new step only, a suggestion of the step's code; each origin can
 *  be claimed by one row. A row with an origin keeps the key when its type and unit are
 *  unchanged, and gets a new key when either changed (a re-keyed edit may keep its type). Any
 *  other row (no key, or a key that names no origin) was added by hand, so it must be TEXT
 *  (spec §3.1) and gets a new key. Suggestions are copied only when a step is added, so an
 *  existing step may keep only the keys its saved rows carry (Codex, #361). */
export function resolveParameterKeys(
  saved: readonly { key: string; type: string; unit: string | null }[],
  submitted: readonly ProcessParameterInput[],
  suggestions: readonly { id: string; type: string; unit: string | null }[],
): string[] {
  const origins = new Map<string, { type: string; unit: string | null }>(
    [...saved.map(r => [r.key, r] as const), ...suggestions.map(sg => [sg.id, sg] as const)]);
  const claimed = new Set<string>();
  return submitted.map(p => {
    const origin = !PROVISIONAL_KEY.test(p.key) && !claimed.has(p.key) ? origins.get(p.key) : undefined;
    if (origin) {
      claimed.add(p.key);
      const unchanged = origin.type === p.type && normalizeUnit(origin.unit) === normalizeUnit(p.unit);
      return unchanged ? p.key : randomUUID();
    }
    if (p.type !== "TEXT") throw new HttpError(400, `"${p.label.trim()}" was added by hand, so it must be text`);
    return randomUUID();
  });
}
/** Whether a kept step's stored rows already are `rows`, field by field and in order: every field
 *  a row stores, so a change to any one of them is written. */
export function sameStoredRows(
  stored: readonly { key: string; label: string; type: string; unit: string | null; value: string }[],
  rows: readonly { key: string; label: string; type: string; unit: string | null; value: string }[],
): boolean {
  return stored.length === rows.length && stored.every((p, i) => p.key === rows[i].key && p.label === rows[i].label
    && p.type === rows[i].type && p.unit === rows[i].unit && p.value === rows[i].value);
}
export async function saveProcessDocument(partId: string, input: unknown): Promise<ProcessDocumentResult> {
  const data = parseProcessDocument(input);
  return withDbErrors({ entity: "Process" }, () => prisma.$transaction(async tx => {
    const claimed = await claimProcessForEdit(tx, partId);
    await claimRecipeCodes(tx, [...data.steps.map(s => s.codeId), ...(claimed.current?.steps ?? []).map(s => s.codeId)]);
    const before = await readProcessDocumentProjection(tx, partId, claimed.current);
    const unchanged = validateProcessDocumentDraft(before, data, await deletedAddedCodes(tx, before, data));
    if (unchanged) {
      return {
        baseline: before.baseline,
        stepIdMap: Object.fromEntries(before.steps.map(s => [s.clientId, s.stepId!])),
        parameterKeys: Object.fromEntries(before.steps.map(s => [s.clientId, s.parameters.map(p => p.key)])),
      };
    }
    // Keys are resolved BEFORE any write, so a refused hand-added row rolls nothing back. The
    // origins of an existing step are its saved rows as read here: a cut below copies those rows
    // with their keys, so the copies are the same origins. A new step's origins are EVERY
    // suggestion its code has had, removed (soft-deleted) ones included, read on this transaction
    // under the code claim above: an open draft may hold a row copied from a suggestion removed
    // since, and removing a suggestion never changes a draft (spec §3.2). A suggestion's type and
    // unit never change, removed or not, so its ID stays verifiable. An existing step never gains
    // a suggestion's identity (Codex, #361).
    const newStepCodeIds = [...new Set(data.steps.flatMap(s => s.stepId === null ? [s.codeId] : []))];
    const provenance = newStepCodeIds.length === 0 ? [] : await tx.processStepFieldDef.findMany({
      where: { codeId: { in: newStepCodeIds } }, select: { id: true, codeId: true, type: true, unit: true },
    });
    const savedRows = new Map(before.steps.map(s => [s.stepId!, s.parameters]));
    const keysByClient = new Map(data.steps.map(step => [step.clientId, resolveParameterKeys(
      step.stepId === null ? [] : savedRows.get(step.stepId) ?? [],
      step.parameters,
      step.stepId === null ? provenance.filter(sg => sg.codeId === step.codeId) : [],
    )]));
    const { rev, stepIdMap: copied } = await ensureWorkingProcess(tx, claimed);
    const stepIdMap: Record<string, string> = {};
    const parameterKeys: Record<string, string[]> = {};
    // Only what changed is written (#658), compared against the rows the claim read: a cut's copies
    // carry the same content and positions, so they are compared by the copy's id.
    const workId = (stepId: string) => copied?.get(stepId) ?? stepId;
    const prior = new Map((claimed.current?.steps ?? []).map(s => [workId(s.id), s]));
    await auditedUpdate("partProcessRevision", rev.id, async () => {
      const kept = new Set(data.steps.flatMap(s => s.stepId === null ? [] : [workId(s.stepId)]));
      const removed = [...prior.keys()].filter(id => !kept.has(id));
      if (removed.length > 0) {
        await tx.partProcessStepParameter.deleteMany({ where: { stepId: { in: removed } } });
        await tx.partProcessStep.deleteMany({ where: { id: { in: removed } } });
      }
      // `@@unique([revisionId, position])` is checked row by row, so a kept step whose position
      // changes is parked below zero first, in one statement; one that keeps its position already
      // holds its final place, which no other step's final place can be.
      const moved = new Set(data.steps.flatMap((s, i) => s.stepId !== null && prior.get(workId(s.stepId))!.position !== i + 1 ? [workId(s.stepId)] : []));
      if (moved.size > 0) await tx.partProcessStep.updateMany({ where: { id: { in: [...moved] } }, data: { position: { multiply: -1 } } });
      type Rows = Parameters<typeof replaceStepParameters>[2];
      const added: { id: string; position: number; codeId: string; instruction: string; rows: Rows }[] = [];
      for (const [i, step] of data.steps.entries()) {
        const keys = keysByClient.get(step.clientId)!;
        const rows = step.parameters.map((p, index) => ({
          key: keys[index], label: p.label, type: p.type, unit: normalizeUnit(p.unit),
          value: validateStepValue({ label: p.label, type: p.type }, p.value),
        }));
        stepIdMap[step.clientId] = step.stepId === null ? randomUUID() : workId(step.stepId);
        parameterKeys[step.clientId] = keys;
        if (step.stepId === null) { added.push({ id: stepIdMap[step.clientId], position: i + 1, codeId: step.codeId, instruction: step.instruction, rows }); continue; }
        const id = workId(step.stepId); const old = prior.get(id)!;
        const changes = { ...(moved.has(id) ? { position: i + 1 } : {}), ...(old.instruction !== step.instruction ? { instruction: step.instruction } : {}) };
        if (Object.keys(changes).length > 0) await tx.partProcessStep.update({ where: { id }, data: changes });
        if (!sameStoredRows(old.parameters, rows)) await replaceStepParameters(tx, id, rows);
      }
      // New steps last, once every kept step holds its final place.
      if (added.length > 0) {
        await tx.partProcessStep.createMany({ data: added.map(a => ({
          id: a.id, revisionId: rev.id, position: a.position, codeId: a.codeId, instruction: a.instruction,
        })) });
        const rows = added.flatMap(a => a.rows.map((r, position) => ({ stepId: a.id, position, ...r })));
        if (rows.length > 0) await tx.partProcessStepParameter.createMany({ data: rows });
      }
    }, { tx });
    return { baseline: (await readProcessDocumentProjection(tx, partId)).baseline, stepIdMap, parameterKeys };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/** The code's suggestions as a new step's rows, with `values` filled in by label. A label the code
 *  does not suggest is a 400, so a seed cannot silently drop a value. */
function suggestedRows(code: ProcessEditorCode, values: Record<string, string>): ProcessParameterInput[] {
  const rows = parametersFromSuggestions(code);
  for (const [label, value] of Object.entries(values)) {
    const row = rows.find(r => r.label === label);
    if (!row) throw new HttpError(400, `"${label}" is not a suggested parameter of this code`);
    row.value = value;
  }
  return rows;
}

/** Seeds, tests and E2E fixtures only (owner ruling 2026-09-26: there is no per-step write
 *  route). Appends one step through saveProcessDocument, so every rule of the one save path
 *  applies. The instruction defaults to the code's standard instruction, as the editor's Add does;
 *  with no `parameters` the code's suggestions are copied (keys = suggestion IDs) with `values`
 *  filled in by label. Explicit `parameters` carry their own values, so `values` beside them is a
 *  400 rather than silently ignored. An unknown or inactive code reaches the save's own 400. */
export async function appendProcessStep(
  partId: string,
  input: { codeId: string; instruction?: string; values?: Record<string, string>; parameters?: ProcessParameterInput[] },
): Promise<{ revisionNumber: number; stepId: string }> {
  if (input.values !== undefined && input.parameters !== undefined) {
    throw new HttpError(400, "Pass values (filled into the code's suggestions) or explicit parameters, not both");
  }
  const { baseline, steps } = await prisma.$transaction(tx => readProcessDocumentProjection(tx, partId),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  const code = baseline.codes.find(c => c.id === input.codeId);
  const clientId = `new:${randomUUID()}`;
  const parameters = input.parameters ?? (code ? suggestedRows(code, input.values ?? {}) : []);
  const result = await saveProcessDocument(partId, {
    expectedBaselineToken: baseline.baselineToken,
    steps: documentSteps([...steps, { clientId, stepId: null, codeId: input.codeId,
      instruction: input.instruction ?? code?.defaultInstruction ?? "", parameters }], baseline.codes),
  });
  return { revisionNumber: result.baseline.revision!.revisionNumber, stepId: result.stepIdMap[clientId] };
}
