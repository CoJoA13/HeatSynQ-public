import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "@/server/db";
import { readProcessDocumentProjection, saveProcessDocument } from "@/server/process-document";
import type { ProcessDocumentInput, ProcessDocumentResult, ProcessDraftStep } from "@/lib/process-document";

/** A change to a part's saved steps, expressed on the rows the process-document save accepts. */
export type StepsEdit = (steps: ProcessDraftStep[]) => ProcessDraftStep[];

/**
 * The document the one save path accepts for `edit` applied to the part's saved steps (owner
 * ruling 2026-09-26: there is no per-step write route). The projection is read in its own
 * transaction, as the editor reads it, so a lock or another save committing before the save makes
 * this baseline stale and the save refuses it with 409. A race test builds its input here, before
 * the race, so only the save's own transaction takes part in it.
 */
export async function editedProcess(partId: string, edit: StepsEdit): Promise<ProcessDocumentInput> {
  const { baseline, steps } = await prisma.$transaction((tx) => readProcessDocumentProjection(tx, partId),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  return { expectedBaselineToken: baseline.baselineToken, steps: edit(steps) };
}

/** Reads, edits and saves, for a test with nothing racing between the read and the save. */
export async function saveProcessEdit(partId: string, edit: StepsEdit):
  Promise<ProcessDocumentResult & { revisionNumber: number | null }> {
  const result = await saveProcessDocument(partId, await editedProcess(partId, edit));
  return { ...result, revisionNumber: result.baseline.revision?.revisionNumber ?? null };
}

/** Applies `change` to the one saved step named by its id on the current revision. An id that is
 *  not there fails loudly, so a mistargeted edit cannot pass as an unchanged save. */
function editStep(steps: ProcessDraftStep[], stepId: string, change: (step: ProcessDraftStep) => ProcessDraftStep) {
  if (!steps.some((step) => step.stepId === stepId)) throw new Error(`Step ${stepId} is not on the current revision`);
  return steps.map((step) => (step.stepId === stepId ? change(step) : step));
}

/** Sets one saved step's instruction. */
export const setInstruction = (stepId: string, instruction: string): StepsEdit =>
  (steps) => editStep(steps, stepId, (step) => ({ ...step, instruction }));

/** Sets the value of one parameter row, named by its key, on one saved step; "" empties it (the
 *  row stays — spec 2026-09-26 §3.1). A key the step does not carry fails loudly: a saved step
 *  gains rows only by hand (TEXT) or when it is added, never by naming a suggestion. */
export const setValue = (stepId: string, key: string, value: string): StepsEdit =>
  (steps) => editStep(steps, stepId, (step) => {
    if (!step.parameters.some((p) => p.key === key)) throw new Error(`Parameter ${key} is not on step ${stepId}`);
    return { ...step, parameters: step.parameters.map((p) => (p.key === key ? { ...p, value } : p)) };
  });
