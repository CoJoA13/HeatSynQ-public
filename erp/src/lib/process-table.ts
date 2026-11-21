import { parametersFromSuggestions, type ProcessDraftStep, type ProcessParameterInput } from "./process-document";
import type { ProcessEditorCode } from "./process-editor-catalog";

/** Spec 2026-09-26 §4 "Remove": how long the Undo bar stays offered after a removal. */
export const UNDO_WINDOW_MS = 15_000;

/** A step taken out of the table, and where it sat, so Undo can put it back. */
export type RemovedStep = Readonly<{ step: ProcessDraftStep; index: number }>;

/** The Undo bar's own state: the step to restore, and a token identifying which offer this is.
 *  Task 8 holds this in state and the timer id (armed for `UNDO_WINDOW_MS`) in a ref. */
export type UndoOffer = Readonly<{ removed: RemovedStep; token: number }> | null;

/** A fresh offer always outranks whatever came before it: the token is one past the highest ever
 *  issued, so a stale timer closing an earlier offer (matched by `expireUndo`) can never close a
 *  newer one raised by a second removal inside the first offer's window. */
export function offerUndo(current: UndoOffer, removed: RemovedStep): Exclude<UndoOffer, null> {
  return { removed, token: (current?.token ?? 0) + 1 };
}

/** Clears the offer only while it is still the one `token` names. A timer whose removal has since
 *  been superseded names a token that is no longer current, so firing late leaves the bar alone. */
export function expireUndo(current: UndoOffer, token: number): UndoOffer {
  return current !== null && current.token === token ? null : current;
}

/** A new step from Add or Insert: the code's default instruction and its suggested parameters,
 *  copied once with empty values (spec §3.2). `clientId` is minted by the caller with `newId()`. */
export function stepFromCode(code: ProcessEditorCode, clientId: string): ProcessDraftStep {
  return { clientId, stepId: null, codeId: code.id, instruction: code.defaultInstruction, parameters: parametersFromSuggestions(code) };
}

export function removeStepAt(steps: readonly ProcessDraftStep[], index: number): { steps: ProcessDraftStep[]; removed: RemovedStep } {
  return { steps: steps.filter((_, i) => i !== index), removed: { step: steps[index], index } };
}

/** Reinserts at the removed index, clamped to the current length: the list may have shrunk since
 *  the removal (a later removal, or a Discard), and inserting past the end would otherwise land in
 *  the wrong place. A step of the same identity already present (a repeated Undo) is a no-op,
 *  never a duplicate. */
export function undoRemove(steps: readonly ProcessDraftStep[], removed: RemovedStep): ProcessDraftStep[] {
  if (steps.some(s => s.clientId === removed.step.clientId)) return [...steps];
  const copy = [...steps];
  copy.splice(Math.min(removed.index, copy.length), 0, removed.step);
  return copy;
}

export function replaceStepAt(steps: readonly ProcessDraftStep[], index: number, step: ProcessDraftStep): ProcessDraftStep[] {
  return steps.map((s, i) => (i === index ? step : s));
}

/** A hand-added parameter is always TEXT with an empty label and value (spec §3.1), keyed by the
 *  caller's provisional `new:<uuid>` (minted with `newId()`) until the save returns its real key. */
export function addParameter(step: ProcessDraftStep, provisionalKey: string): ProcessDraftStep {
  return { ...step, parameters: [...step.parameters, { key: provisionalKey, label: "", type: "TEXT", unit: null, value: "" }] };
}

/** Only label, unit and value are ever patched here — a row's key and type never change in place
 *  (spec §3.3). Changing a row's type or unit gives it a new key, which the caller expresses as a
 *  `removeParameter` followed by `addParameter`, not as an update. */
export function updateParameter(step: ProcessDraftStep, index: number, patch: Partial<Pick<ProcessParameterInput, "label" | "unit" | "value">>): ProcessDraftStep {
  return { ...step, parameters: step.parameters.map((p, i) => (i === index ? { ...p, ...patch } : p)) };
}

export function removeParameter(step: ProcessDraftStep, index: number): ProcessDraftStep {
  return { ...step, parameters: step.parameters.filter((_, i) => i !== index) };
}

/** After Add or Insert, focus goes to the new step's first empty parameter value, or the
 *  instruction once every parameter already has one (spec §4 "Add"). */
export function focusAfterAdd(step: ProcessDraftStep): { kind: "parameter"; index: number } | { kind: "instruction" } {
  const index = step.parameters.findIndex(p => p.value.trim() === "");
  return index === -1 ? { kind: "instruction" } : { kind: "parameter", index };
}

/** Which parameter rows print as a handwriting blank: an empty or whitespace-only value. */
export function emptyParameters(step: ProcessDraftStep): boolean[] {
  return step.parameters.map(p => p.value.trim() === "");
}

/** "on N orders" beside a revision (owner ruling 2026-09-26): orders that are not voided whose
 *  lead line saved it, each once. */
export function orderCountLabel(orderCount: number): string {
  return `on ${orderCount} ${orderCount === 1 ? "order" : "orders"}`;
}

/** The note under a LOCKED current revision (owner answer D-3, 2026-09-27). A lock is permanent
 *  and the count excludes voided orders, so a locked revision may be on no order at all: the note
 *  always says a save cuts the next revision, and names the orders keeping this one only when
 *  there are any. */
export function lockedRevisionNote(revisionNumber: number, orderCount: number): string {
  const cut = `Saving creates Rev ${revisionNumber + 1}.`;
  if (orderCount === 0) return cut;
  return orderCount === 1 ? `${cut} The 1 order on Rev ${revisionNumber} keeps it.` : `${cut} The ${orderCount} orders on Rev ${revisionNumber} keep it.`;
}
