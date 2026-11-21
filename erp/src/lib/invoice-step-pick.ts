// Client-safe leaf (#587, Amendments 15, 16, 22, 23): what an invoice operation line's description
// box writes, offers and keeps. The box (`StepWordsBox.tsx`) only draws its list and reports a
// keystroke or a pick; every decision is here, where vitest can run it without a component renderer
// (tests/invoice-step-pick.test.ts).
import type { InvoiceLineFields } from "./invoice-bulk-recovery";
import type { InvoiceStepSuggestions, StepSuggestion } from "./invoice-step-suggestions";

/** Whether the page asks for step suggestions at all: a live draft INVOICE. A credit memo offers
 *  none (587-12: it copies paper), a finalized invoice is paper with no box to offer them in, and a
 *  discarded draft's read answers 404. */
export function offersStepSuggestions(invoice: { kind: string; status: string; deletedAt: string | null }): boolean {
  return invoice.kind === "INVOICE" && invoice.status === "DRAFT" && invoice.deletedAt === null;
}

/** The saved line a row stands for, as the page read it: its words and its mark. */
export type SavedWords = { description: string; wordsChosen: boolean };

/** The mark for `words` written onto a row: the saved line's own mark where the words are the saved
 *  line's own, so a row typed or picked back to them holds no edit (the grid's overlay drops a field
 *  equal to the saved one) and no mark the operator cannot see; else "true". With no saved line (an
 *  added row), "true". */
function markFor(words: string, saved: SavedWords | undefined): string {
  return saved !== undefined && words === saved.description ? String(saved.wordsChosen) : "true";
}

/**
 * What a pick writes onto the row (Amendment 16). Always the step's name as the words, and the mark,
 * which Recalculate keeps under `recalculateInvoice`'s carry rule. On a row with no price row of its
 * own (`pricePer` empty: the engine's Needs price line, a price typed on it or not) the pick also
 * sets the step code, and clears the GL account, which Save lines derives from that step code every
 * time (Amendment 17): there is no operator GL picker, so the step's own account is the only right
 * one. A priced row keeps its step code and account: its words change, its pricing does not
 * (587-10 a), and a pick of the saved line's own words takes the saved line's mark (`markFor`).
 */
export function pickPatch(
  row: Pick<InvoiceLineFields, "pricePer">, suggestion: StepSuggestion, saved?: SavedWords,
): Partial<InvoiceLineFields> {
  if (row.pricePer !== "") return { description: suggestion.name, wordsChosen: markFor(suggestion.name, saved) };
  return {
    description: suggestion.name, processStepCodeId: suggestion.id,
    glAccountId: "", glAccountName: "", wordsChosen: "true",
  };
}

/** What a keystroke in the box writes: the text exactly as typed, and the mark (any words can still
 *  be typed, 587-8), but text typed back to the saved line's own words takes the saved line's mark
 *  (`markFor`): a mark left on words the operator typed away and back would have Recalculate keep
 *  them, a step's old name included, though nothing was chosen. */
export function typedPatch(value: string, saved?: SavedWords): Partial<InvoiceLineFields> {
  return { description: value, wordsChosen: markFor(value, saved) };
}

/** A row's suggestions: its order line's own steps first, in their order, then every other step
 *  code, the line's own left out (Amendments 13, 22). Nothing while there is no answer, so the box is
 *  a plain typing box until the read lands, and for good when it failed. A line id is read as the
 *  answer's own key only (`Object.hasOwn`), never off the object's prototype. */
export function suggestionsFor(orderLineId: string, data: InvoiceStepSuggestions | null): StepSuggestion[] {
  if (data === null) return [];
  const own = Object.hasOwn(data.byOrderLine, orderLineId) ? data.byOrderLine[orderLineId] : [];
  const ownIds = new Set(own.map((s) => s.id));
  return [...own, ...data.others.filter((s) => !ownIds.has(s.id))];
}

/** An option's words: `CODE — Name` (Amendment 23, the ProcessCodeSearch form). */
export function suggestionLabel(suggestion: StepSuggestion): string {
  return `${suggestion.code} — ${suggestion.name}`;
}

/**
 * The suggestions typed text keeps: every one whose `CODE — Name` holds the text, ignoring case and
 * the text's edge spaces, in the list's own order. `null` (nothing typed since the list opened) and
 * blank text keep the whole list. Not `rankProcessCodes` (Amendment 15 allowed it where it fits): it
 * re-sorts by match and by code, and the list's order is the only thing that says which steps are
 * the part's own (no group headings, Amendment 23); it also drops inactive codes, and a line's own
 * revision can list one.
 */
export function matchingSuggestions(list: readonly StepSuggestion[], typed: string | null): StepSuggestion[] {
  const query = (typed ?? "").trim().toLowerCase();
  if (query === "") return [...list];
  return list.filter((s) => suggestionLabel(s).toLowerCase().includes(query));
}
