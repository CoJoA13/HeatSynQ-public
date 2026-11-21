// Client-safe and pure: what leaving an edit box of an existing pick-list row sends (the weights
// design §9.4, "Pick lists", and §9.9 point 17; owner ruling R18, #680). A box asks this when it is
// left and when Enter is pressed, and sends only what it is told to: `inlineDecimalSave` answers for
// a decimal or whole-number box (src/components/InlineDecimalBox.tsx and
// src/components/InlineTextBox.tsx), and `inlineNameSave` and `inlineTextSave` for the rest.
//
// The box has no button and holds no unsaved state, so "did anything change" is decided here: the
// typed text against the stored figure, as numbers. The server stores 42.50 and answers "42.5", and
// every update writes a history entry whether or not anything changed (`auditedUpdate`). A
// comparison of spellings would write one for a box nobody changed.
//
// Nothing here says whether a figure is allowed. The table checks the figure by the decimal-entry
// rule (src/lib/decimal-entry.ts) before it sends, and the server's own check backs it: text that
// does not read as the stored figure is handed on as typed, and the table refuses it first, naming
// the row and the column. Text that reads as the stored figure is never sent, whatever
// its spelling ("42.500" over 42.5, "42." over 42, ".5" over 0.5): the box is asked when it is left
// or Enter is pressed, so the text is final. The amount typed is the amount stored,
// so the box goes back to it with no message.
//
// Figures are compared as numbers. Two decimals that differ only past the fifteenth significant
// digit read as the same number here. The one column that uses this, container types' tare each,
// takes twelve digits at most, and the server refuses a longer figure, so nothing wrong is stored
// by not sending one.
//
// Once the server has answered a save 2xx, the table puts the figure it sent into its row
// (`rowsWithStoredFigure`), and the row holds that figure until a read brings another. It does not
// when a read has put rows into the table since the save was sent: those rows can hold a figure
// stored after this one, so the table leaves the row to the reads (Codex P2 on #559;
// src/components/ReferenceTable.tsx says what that costs). The box compares against the row's
// figure, so the blur after Enter, with the text unchanged, sends nothing even when the reload
// after the save failed (#495 item 2). The PUT answers with no row, so the figure is the one sent,
// in the operator's spelling ("60.50"), until a read brings the server's.

import { spelledDecimal } from "@/lib/decimal-entry";

/** The number a stored figure or a trimmed typed text spells, or null when it spells none. The box
 *  has been left, so "42." is 42 (`spelledDecimal`). */
function asNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  return typeof value === "string" ? spelledDecimal(value)?.value ?? null : null;
}

/**
 * What the box sends for `typed` over the row's `stored` figure. `stored` is the value as the
 * table's read gave it: a decimal as text ("42.5"), or null or undefined for no figure.
 *
 * - A blank box over no figure sends nothing.
 * - A blank box over a figure sends null, which clears it. A stored 0 is a figure.
 * - Text that reads as the stored figure ("42.50" over "42.5") sends nothing.
 * - Anything else is sent, without the spaces around it.
 */
export function inlineDecimalSave(
  stored: unknown, typed: string,
): { send: false } | { send: true; value: string | null } {
  const text = typed.trim();
  const nothingStored = stored === null || stored === undefined;
  if (text === "") return nothingStored ? { send: false } : { send: true, value: null };
  const number = asNumber(text);
  if (number !== null && number === asNumber(stored)) return { send: false };
  return { send: true, value: text };
}

export type InlineSave<V> = { send: false } | { send: true; value: V };

/**
 * What a row's Name box sends. The server trims a name and refuses a blank one, so a name is
 * compared and sent trimmed, and a blank box sends nothing: a row keeps its name, and the box takes
 * it back when it is left.
 */
export function inlineNameSave(stored: unknown, typed: string): InlineSave<string> {
  const text = typed.trim();
  return text === "" || text === stored ? { send: false } : { send: true, value: text };
}

/**
 * What a free-text column's box sends. Its text is stored as typed, spaces and line breaks included,
 * and the empty text is a value (`buildPayload`'s note in ReferenceTable.tsx), so a cleared box sends
 * "" unless there was no text to clear.
 */
export function inlineTextSave(stored: unknown, typed: string): InlineSave<string> {
  return typed === (stored ?? "") ? { send: false } : { send: true, value: typed };
}

/**
 * The table's rows once the server has answered 2xx to a save of `value` under `key` on row `id`:
 * that row is a new object holding `value`, a null (a cleared figure) included, and every other
 * row is handed back as it was. With no row of that id the rows are the same. Nothing it is handed
 * is changed.
 */
export function rowsWithStoredFigure<R extends { id: string }>(
  rows: readonly R[], id: string, key: string, value: string | number | null,
): R[] {
  return rows.map((r) => (r.id === id ? { ...r, [key]: value } : r));
}
