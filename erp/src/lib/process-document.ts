import { z } from "zod";
import type { ProcessRevision } from "./process-steps-recovery";
import type { ProcessEditorCode } from "./process-editor-catalog";
import { STEP_FIELD_TYPES, type StepFieldType } from "./step-field-constants";
export type { ProcessEditorCode } from "./process-editor-catalog";
export type { StepFieldType } from "./step-field-constants";
/** `key` is the row's identity: a saved key, a suggestion ID (a row copied onto a new step), or a
 *  provisional `new:<uuid>` for a row added by hand and not yet saved. */
export type ProcessParameterInput = { key: string; label: string; type: StepFieldType; unit: string | null; value: string };
export const PROVISIONAL_KEY = /^new:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type ProcessDraftStep = { clientId: string; stepId: string | null; codeId: string; instruction: string; parameters: ProcessParameterInput[] };
/** The code and name the operator saw when a step was added (R11, owner ruling 2026-11-02). The
 *  baseline token hashes only the codes the revision's steps name, so the save checks an added
 *  step's code against these instead, and a mismatch answers the token's own 409. A wire field
 *  only: `documentSteps` attaches it from the editor's current catalog as the request is built,
 *  never from a copy kept on the draft row, which would resend an old name after the re-read. */
export type ProcessCodeSeen = { code: string; name: string };
export type ProcessDocumentStep = ProcessDraftStep & { codeSeen?: ProcessCodeSeen };
export type ProcessDocumentInput = { expectedBaselineToken: string; steps: ProcessDocumentStep[] };
export type ProcessDocumentBaseline = { revision: ProcessRevision | null; baselineToken: string; codes: ProcessEditorCode[] };
/** `parameterKeys[clientId][i]` is the key the save gave submitted row `i` of that step (spec §3.3):
 *  the row's new origin, which the editor adopts by identity, never by position. */
export type ProcessDocumentResult = { baseline: ProcessDocumentBaseline; stepIdMap: Record<string, string>; parameterKeys: Record<string, string[]> };
export const PROCESS_DOCUMENT_MAX_BYTES = 1024 * 1024;
/** The one unit rule for keys, comparisons and storage (spec §3.3): trimmed, and empty means no
 *  unit. A suggestion's stored unit is not trimmed today, so comparing verbatim would re-key a row
 *  on an unrelated save (Codex, #361). */
export function normalizeUnit(unit: string | null | undefined): string | null {
  const u = (unit ?? "").trim();
  return u === "" ? null : u;
}
const PARAMETER = z.object({
  key: z.string().min(1).max(100),
  label: z.string().trim().min(1, "Every parameter needs a name").max(60),
  type: z.enum(STEP_FIELD_TYPES),
  unit: z.string().trim().max(20).nullable().transform(normalizeUnit),
  value: z.string().max(500),
}).strict();
const STEP = z.object({
  clientId: z.string().min(1), stepId: z.string().min(1).nullable(), codeId: z.string().min(1),
  instruction: z.string().max(4000), parameters: z.array(PARAMETER),
  codeSeen: z.object({ code: z.string().max(200), name: z.string().max(200) }).strict().optional(),
}).strict();
const DOCUMENT = z.object({ expectedBaselineToken: z.string().min(1), steps: z.array(STEP) }).strict().superRefine((data, ctx) => {
  const clients = new Set<string>(), ids = new Set<string>();
  for (const step of data.steps) {
    if (clients.has(step.clientId) || (step.stepId !== null && ids.has(step.stepId))) ctx.addIssue({ code: "custom", message: "Duplicate step identity" });
    clients.add(step.clientId);
    if (step.stepId !== null) ids.add(step.stepId);
    if (step.stepId === null && !PROVISIONAL_KEY.test(step.clientId)) ctx.addIssue({ code: "custom", message: "New steps require a new:UUID client identity" });
    if (step.stepId !== null && step.clientId !== step.stepId) ctx.addIssue({ code: "custom", message: "Existing client identity must match the step identity" });
    if (step.stepId !== null && step.codeSeen !== undefined) ctx.addIssue({ code: "custom", message: "Only a new step names the code it was added as" });
    const keys = step.parameters.map(p => p.key);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "Duplicate parameter key" });
  }
});
export function assertProcessSize(value: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > PROCESS_DOCUMENT_MAX_BYTES) {
    throw new z.ZodError([{ code: "custom", path: [], message: "Process exceeds the 1 MiB UTF-8 limit" }]);
  }
}
export function parseProcessDocument(input: unknown): ProcessDocumentInput {
  assertProcessSize(input);
  const data = DOCUMENT.parse(input);
  assertProcessSize(data.steps);
  return data;
}
/** The document's steps as the request carries them: each added step names its code and name from
 *  `codes`, the editor's current catalog. An added step whose code the catalog lacks names none,
 *  and the save refuses it. */
export function documentSteps(steps: readonly ProcessDraftStep[], codes: readonly { id: string; code: string; name: string }[]): ProcessDocumentStep[] {
  return steps.map(({ clientId, stepId, codeId, instruction, parameters }) => {
    // Rebuilt field by field, so no `codeSeen` an earlier request carried rides along.
    const step = { clientId, stepId, codeId, instruction, parameters };
    const code = stepId === null ? codes.find(c => c.id === codeId) : undefined;
    return code ? { ...step, codeSeen: { code: code.code, name: code.name } } : step;
  });
}
export function moveProcessStep(steps: readonly ProcessDraftStep[], from: number, to: number): ProcessDraftStep[] {
  if (![from, to].every(n => Number.isInteger(n) && n >= 0 && n < steps.length)) throw new RangeError("Step position is out of bounds");
  const copy = [...steps];
  const [step] = copy.splice(from, 1);
  copy.splice(to, 0, step);
  return copy;
}
export function insertProcessStep(steps: readonly ProcessDraftStep[], index: number, step: ProcessDraftStep): ProcessDraftStep[] {
  if (!Number.isInteger(index) || index < 0 || index > steps.length) throw new RangeError("Step position is out of bounds");
  const copy = [...steps];
  copy.splice(index, 0, step);
  return copy;
}
/** Adding a step copies the code's suggestions in order, keyed by their IDs, with empty values
 *  (spec §3.2). After that there is no link between the rows and the suggestions. */
export function parametersFromSuggestions(code: ProcessEditorCode): ProcessParameterInput[] {
  return code.fields.map(f => ({ key: f.id, label: f.label, type: f.type as StepFieldType, unit: normalizeUnit(f.unit), value: "" }));
}
export function normalizedProcessContent(steps: readonly ProcessDraftStep[], options: { ignoreKeys?: boolean } = {}) {
  return steps.map(s => ({
    codeId: s.codeId, instruction: s.instruction,
    parameters: s.parameters.map(p => ({
      ...(options.ignoreKeys ? {} : { key: p.key }),
      label: p.label.trim(), type: p.type, unit: normalizeUnit(p.unit), value: p.value.trim(),
    })),
  }));
}
/** Parameter order is content (spec §3.1): a swapped pair differs. Keys are compared unless the
 *  caller has only content to go on (`reconcileUnknownRead`, whose fresh rows carry the keys the
 *  lost answer would have returned). */
export function sameProcessContent(a: readonly ProcessDraftStep[], b: readonly ProcessDraftStep[], options: { ignoreKeys?: boolean } = {}): boolean {
  return JSON.stringify(normalizedProcessContent(a, options)) === JSON.stringify(normalizedProcessContent(b, options));
}
