// The reason dialog every destructive action raises (spec §9: a destructive action records a
// reason), stated once (P7 step 7, 2026-10-22 review). The question comes first, then a blank line,
// then the line naming what the answer is for. Each caller keeps its own `prompt` call, its
// cancelled (`null`) return and its blank refusal in its own sentence and message slot, because
// where a refusal shows is the caller's (ruling R1), and the flows read the dialog's text
// (`modalTitle`, `e2e/lib/modal.mjs`), so this sentence is byte for byte the one they read.
// `tests/reason-prompt.test.ts` refuses a `prompt(` anywhere in `src/` that does not ask through
// it. Since 2026-10-30 (ruling 5) the dialog
// is also raised through `askReason` (`src/lib/modal.ts`), whose title and body are this text
// split at its blank line; the same test counts both forms. Import-free.

/** `verb` is the action's -ing form: "voiding", "deleting", "reopening". */
export function reasonPromptText(question: string, verb: string): string {
  return `${question}\n\nReason for ${verb} (recorded in the audit history):`;
}
