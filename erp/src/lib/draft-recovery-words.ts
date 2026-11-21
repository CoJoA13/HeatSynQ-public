// The draft-recovery notice's sentences (src/components/DraftRecoveryNotice.tsx), stated once (#483).
// The notice renders one per editor mode. On the saved shipment page a grid's gate and the text
// beside an empty Add picker (`gridGate` and `pickerEmptyReason`, shipment-gates.ts) reuse the first
// sentence of the three modes that hold no draft to show, so a title, the picker's text and the
// notice above the grid say one thing in the same words. On the order hub each grid's Save button
// is handed `gridGate` too. New shipment shows the notice alone while it has no form to show, and
// offers the notice's retry (`CHECK_AGAIN`) beside a refused Add order (#695). Pure and client-safe;
// its only import is a type.
import type { EditorView } from "./draft-store";

/** An editor's mode, as the draft store reports it in its view. */
export type EditorMode = EditorView<unknown, unknown, unknown>["mode"];

/** `loading`'s sentence, its only one. */
export const CHECKING_ACCESS = "Checking access to this editor…";
/** `unavailable`'s first sentence. */
export const EDITOR_UNAVAILABLE = "This editor is unavailable.";
/** `error`'s first sentence. */
export const EDITOR_NOT_LOADED = "This editor could not be loaded.";
/** The second sentence of `unavailable` and of `error`. */
export const RETAINED_VALUES_HIDDEN = "Retained values are hidden until access is confirmed.";

/** The notice's retry, which reads access and the saved record again. New shipment's Add order offers
 *  it beside a refusal too (#695). */
export const CHECK_AGAIN = "Check access and saved record again";

/** What the notice says in each mode. `completed` is empty: the notice renders nothing then, and
 *  the owning editor shows its receipt. */
export const DRAFT_RECOVERY_MESSAGES: Readonly<Record<EditorMode, string>> = {
  loading: CHECKING_ACCESS, editing: "An earlier copy is retained below.",
  offer: "Unsaved changes are available in this tab. Restore them to continue editing.",
  conflict: "The saved record changed or is read-only. Review your retained copy before starting fresh.",
  "blocked-two-copies": "Two copies are retained. Dismiss one before starting another copy. Editing is paused.",
  pending: "A save is in progress. Leaving or discarding will not cancel the submitted request.",
  unknown: "The save result is unknown. Check the saved record before taking another action. Editing is paused.",
  unavailable: `${EDITOR_UNAVAILABLE} ${RETAINED_VALUES_HIDDEN}`,
  error: `${EDITOR_NOT_LOADED} ${RETAINED_VALUES_HIDDEN}`, completed: "",
};

// Exhaustive on purpose: a mode added to the draft store does not compile here until someone says
// whether it holds a draft to show.
const ACCESS_SENTENCE: Readonly<Record<EditorMode, string | undefined>> = {
  loading: CHECKING_ACCESS, unavailable: EDITOR_UNAVAILABLE, error: EDITOR_NOT_LOADED,
  editing: undefined, offer: undefined, conflict: undefined, "blocked-two-copies": undefined,
  pending: undefined, unknown: undefined, completed: undefined,
};

/** The notice's first sentence in the three modes that hold no draft to show (loading,
 *  unavailable, error), and undefined in the other seven. */
export function editorAccessSentence(mode: EditorMode): string | undefined {
  return ACCESS_SENTENCE[mode];
}
