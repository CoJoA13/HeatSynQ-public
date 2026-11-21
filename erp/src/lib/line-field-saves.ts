// Client-safe and pure, importing only the decimal-entry leaf: the save state of the order hub's Qty
// and Weight boxes (the quantity corrections design §4). Each box saves on blur or Enter, one PATCH
// per field. This leaf answers three questions for one box: what text it shows, whether it reads
// Saved or Not saved, and whether a blur, an Enter, an accepted offer or a Restore sends a request.
//
// It lives in src/lib because vitest has no component renderer: decided inline in LinesSection, none
// of this could be proven by mutation (the break-drafts.ts argument). The component holds the state
// and the request; this file holds nothing. Every transition takes the current Map and returns the
// next one, so the component applies each as `setSaves((cur) => f(cur, …))`, and every function
// returns the SAME Map or Set when it changes nothing, so a call that changes nothing is a React
// state bailout and not a re-render.

import { decimalRefusal, spelledDecimal } from "./decimal-entry";
import { LINE_NET_WEIGHT } from "./order-boxes";

export type LineField = "qty" | "weight";

/** How a box's last save ended, and what the box reads for it: Saved, or Not saved with the reason. */
export type FieldOutcome =
  | { readonly kind: "saved"; readonly text: string }
  | { readonly kind: "failed"; readonly message: string };

export type FieldSave = {
  /** Text in the box that the server does not show (yet); null = show the server value. */
  readonly draft: string | null;
  /** The attempt in flight and exactly what it sent. Attempt numbers come from the caller and never repeat. */
  readonly pending: { readonly attempt: number; readonly text: string } | null;
  readonly outcome: FieldOutcome | null;
  /**
   * The box's record that a save of it went UNANSWERED. Absent (or false) = no such record.
   *
   * A failure is unanswered when the request got no answer the page can trust: the connection
   * dropped, or the server answered 5xx. That write may have been committed, so the value the
   * page shows as stored may no longer be what the server holds. One more failure is unanswered
   * since #547, by the owner's ruling of 2026-10-18 (R13 did not cover it): the server answered
   * 2xx and its body could not be read, which `api()` rejects as `UnreadableAnswerError`, an
   * error with no `status`. That write was committed (a 2xx proves it), and the page applied
   * nothing from its answer. Every other failure is answered: the server refused the request and
   * wrote nothing, or the client refused the text and no request was made. The component decides
   * which a failure was, from the error it caught, and says so to `failed`. That rule is R13 with
   * the 2026-10-18 ruling beside it, stated as `unansweredStatus`, and it is the rule a line's
   * removal is marked by too (`line-removals.ts`).
   *
   * The record is the BOX's, not its newest failure's and not its newest attempt's: an answer to
   * a later request says nothing about what became of the earlier write. `failed` sets it for an
   * unanswered failure of ANY attempt of the box: the one the box is waiting on, one that a newer
   * attempt has replaced (two saves of one box can be out at once), and one whose entry has gone
   * since. It then stays, and its entry with it, through a later failure the server answered (any
   * refusal, a 409 "please try again" included), a refusal the client makes, a key typed (also
   * one typed while a save is out, which clears the outcome and not this), a new attempt going
   * out, every order payload, whatever value it shows, and a settle or a Restore that was
   * decided before the record was on screen (`putBackUnsent`).
   *
   * It ends in ONE way: `landed`, for the attempt the box is waiting on. That attempt was sent
   * after the unanswered one and the server answered it, so the server holds what it sent. The
   * only other thing that removes it is its line leaving the order, which drops the entry
   * (`reconciled`).
   *
   * A payload alone never ends it, not even one that shows the very text in the box
   * (`reconciledSave`). A payload can be older than the unanswered save: the answer to a request
   * sent before it, which the page's gate still applies when nothing newer has been applied (a
   * request that fails never advances that gate), or a read begun before the lost write was
   * committed. To know that a payload postdates the unanswered save, each payload's dispatch
   * order would have to be carried here from the page's gate; this leaf is handed values only.
   *
   * Two costs, each a box that reads Not saved for longer and never a clean box over a value the
   * server may not hold. After a save the server did not answer, the box reads Not saved until
   * Enter (which sends the box's text) or Restore (which sends the stored value) lands, even when
   * a later payload shows the value in the box. And there is no exception for an older attempt
   * whose unanswered failure arrives after a newer attempt of the box has landed, where the
   * server holds the newer value if it took the two in order: telling that case apart needs a
   * record of landings that outlives the entries, and the box keeps none.
   *
   * While it stands, the stored value is never put back in the box without a request.
   * `restoreIntent` answers "send": Restore saves the stored value (owner ruling 2026-10-07).
   * `saveIntent` rule 4 answers "send" where it would have answered "settle": the stored value
   * typed back is sent too, and rule 2 lets Enter reach rule 4 on a box that shows the stored
   * value with no draft. The component clears or settles a box only where one of those two
   * functions says so. It asks them from the render on screen, though, and an older attempt's
   * lost answer can set the record between that render and the click, so `cleared` and `settled`
   * never drop an entry that carries it either (`putBackUnsent`). And `anyNotSaved` counts the
   * box whether or not it reads Not saved at that moment. What counts as unanswered (but for the
   * unreadable 2xx above), rule 4's answer, which attempts set the record and the one thing that
   * ends it were decided without the owner (HANDOFF §4 lists them for review). That no order
   * payload ends it (R18) is the owner's ruling of 2026-10-15 (#478), and that an unreadable 2xx
   * counts is the owner's ruling of 2026-10-18 (#547).
   *
   * A box that reads Saved never carries it: only `landed` writes that outcome, and `failed`
   * replaces a Saved outcome where it sets the record. With no attempt in flight, a box that
   * carries it always reads Not saved.
   */
  readonly unanswered?: boolean;
};

/** One entry per box that holds anything, keyed by `fieldKey`. A box with no entry shows the server. */
export type FieldSaves = ReadonlyMap<string, FieldSave>;

export const NO_FIELD_SAVES: FieldSaves = new Map();

export function fieldKey(lineId: string, field: LineField): string {
  return `${lineId}:${field}`;
}

/** What each box shows when it holds nothing of its own: the stored value as text, per key. */
export function serverValues(lines: readonly { id: string; qty: number; weight: number }[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of lines) {
    values.set(fieldKey(line.id, "qty"), String(line.qty));
    values.set(fieldKey(line.id, "weight"), String(line.weight));
  }
  return values;
}

// Two readings of a box's text, and which one a comparison uses is the point.
//
// Text being TYPED: a spelling that ends at its point ("4." on the way to "4.5") is not a number.
// Read as one, "4." would equal a 4 that just landed and the payload would clear the box
// mid-keystroke. A complete spelling passes and still can be text on its way somewhere else:
// "40.0" on the way to "40.05" IS the number 40. So the two places that decide whether text in the
// box is what a request sent or what the server holds, with the cursor possibly still in it,
// compare text and never values: `landed`, and the "failed" branch of `reconciledSave`.
//
// A value a request SENT: the text a landed save carried, which a keystroke would have cleared
// the mark of. It is no longer being typed, so "36." is 36, as the server stored it (decimal
// entry design §9 O4), the way "020" is 20.
function typedNumber(trimmed: string): number | null {
  const spelled = spelledDecimal(trimmed);
  return spelled !== null && spelled.finished ? spelled.value : null;
}

/** Trimmed text equal, or both complete finite numbers and numerically equal ("48.50" is 48.5,
 *  ".5" is 0.5). Text ending at its point is not complete: it is still being typed. */
export function sameValue(text: string, server: string): boolean {
  const a = text.trim();
  const b = server.trim();
  if (a === b) return true;
  const x = typedNumber(a);
  const y = typedNumber(b);
  return x !== null && y !== null && x === y;
}

/** `sameValue` for a value a landed request carried: "36." is 36. Only for an outcome's text, or a
 *  draft that is still exactly that text (`reconciledSave`'s "saved" branch, `fieldView`'s mark). */
export function sameSentValue(sent: string, other: string): boolean {
  const a = sent.trim();
  const b = other.trim();
  if (a === b) return true;
  const x = spelledDecimal(a);
  const y = spelledDecimal(b);
  return x !== null && y !== null && x.value === y.value;
}

/** The client-side refusal for this text, or null. A quantity is a whole number of at least 1. A
 *  weight is the Line Net weight box's one rule (`LINE_NET_WEIGHT`, `decimalRefusal`): a blank box
 *  is refused as zero is, and the sentence names the box by its label, `<line>, Net weight (lb)`. */
export function checkLineField(field: LineField, text: string, label: string): string | null {
  const value = Number(text.trim());
  if (field === "qty") {
    return Number.isInteger(value) && value >= 1 ? null : `${label}: quantity must be a whole number of at least 1.`;
  }
  return decimalRefusal(`${label}, ${LINE_NET_WEIGHT.label}`, text, LINE_NET_WEIGHT.box, { required: true });
}

export type SaveIntent = "send" | "skip" | "settle";

/**
 * What a blur, an Enter or an accepted offer does with `text`. `atFocus` is the box's text when focus
 * arrived, for a blur; null for Enter and for an offer. The rules, in order:
 *
 * 1. A save is in flight: the same value as the one in flight → "skip"; any other → "send". A
 *    correction typed while a save is out must go out too, even back to the stored value: the
 *    request already sent is about to change that value.
 * 2. No draft, and the text is the server value → "skip". The box is showing what the server holds,
 *    so there is nothing to send and nothing to settle. This keeps a Saved mark through a blur, a
 *    second Enter, or tabbing through the row. An accepted offer over a box with no draft is not the
 *    server value, so it goes on to rule 5. One exception: Enter on a box that carries the record
 *    that a save of it went unanswered (`FieldSave.unanswered`). Such a box can read Not saved
 *    over the stored value with no draft (`failed`, for an attempt that is not the pending one),
 *    and whether the server holds that value is not known. Enter is the retry there as for any
 *    Not saved box, so it goes on to rule 4, which sends. A blur of that box still skips here:
 *    nobody has typed in a box with no draft, whatever it held when focus arrived.
 * 3. A blur that leaves the box holding the same value it held when focus arrived, however either
 *    is spelled, on a box that reads Saved or Not saved → "skip". Enter records the box's raw text
 *    as the text held at focus, and the save it sends then puts the spelling the request carried
 *    back in the box ("020" is sent, and shown, as 20), so the two texts can differ while the
 *    value is the same. A Not saved value is not sent again by tabbing through it; Enter (no
 *    at-focus text) is the retry. A draft with no mark is never skipped here: unmarked text the
 *    server does not hold must not stay in the box, and the at-focus text can be stale (an order
 *    payload changes what a focused box shows without a focus event, so the earlier stored value
 *    typed back would read as "unchanged").
 * 4. The text is the server value → "settle": nothing to send, the draft goes. Unless the box
 *    carries the record that a save of it went unanswered (`FieldSave.unanswered`) → "send": that
 *    save may have been committed, so the server may not hold this value, and sending it is what
 *    makes the order agree with the box. Rule 3 comes first, so tabbing through such a box still
 *    sends nothing.
 * 5. Otherwise → "send".
 */
export function saveIntent(input: {
  save: FieldSave | undefined; server: string; text: string; atFocus: string | null;
}): SaveIntent {
  const { save, server, text, atFocus } = input;
  if (save?.pending) return sameValue(text, save.pending.text) ? "skip" : "send";
  if ((save?.draft ?? null) === null && sameValue(text, server) && (atFocus !== null || !isUnanswered(save))) return "skip";
  if (atFocus !== null && sameValue(text, atFocus) && (save?.outcome ?? null) !== null) return "skip";
  if (sameValue(text, server)) return isUnanswered(save) ? "send" : "settle";
  return "send";
}

/** Whether the box carries the record that a save of it went unanswered (`FieldSave.unanswered`). */
function isUnanswered(save: FieldSave | undefined): boolean {
  return save?.unanswered === true;
}

/**
 * What the Restore control does for this box. "clear": the entry goes and nothing is sent
 * (`cleared`), which is right whenever the stored value on the page is what the server holds.
 * "send": the box carries the record that a save of it went unanswered, so the component SAVES
 * the stored value, as an attempt of this box like any other (`dispatched`, then `landed` or
 * `failed`). While that save is out the box shows the stored value, still Not saved; when it lands
 * the box reads Saved and the record goes; when it fails, answered or not, the box reads Not saved
 * over the stored value, the record stands, and the next Restore sends again.
 *
 * What the box's newest outcome says is not consulted, and neither is a save in flight: the
 * control is disabled while the box's newest attempt is out (`pending`). An older attempt that a
 * newer one replaced is not waited for. Should it end with no answer after a Restore that
 * cleared, `failed` makes the box read Not saved over the stored value, with the record, and
 * the next Restore sends.
 */
export function restoreIntent(save: FieldSave | undefined): "clear" | "send" {
  return isUnanswered(save) ? "send" : "clear";
}

function sameOutcome(a: FieldOutcome | null, b: FieldOutcome | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "saved") return b.kind === "saved" && a.text === b.text;
  return b.kind === "failed" && a.message === b.message;
}

function sameSave(a: FieldSave, b: FieldSave): boolean {
  return a.draft === b.draft
    && a.pending?.attempt === b.pending?.attempt && a.pending?.text === b.pending?.text
    && sameOutcome(a.outcome, b.outcome)
    // No record and a false one are the same entry.
    && isUnanswered(a) === isUnanswered(b);
}

/** One entry. The record that a save went unanswered is written only where it stands, so an entry
 *  without one is the three fields it has always been. */
function entry(
  draft: string | null, pending: FieldSave["pending"], outcome: FieldOutcome | null, unanswered: boolean,
): FieldSave {
  return unanswered ? { draft, pending, outcome, unanswered: true } : { draft, pending, outcome };
}

/** `next` at `key`, or the entry gone for null. The same Map when that is already what it holds. */
function withEntry(saves: FieldSaves, key: string, next: FieldSave | null): FieldSaves {
  const cur = saves.get(key);
  if (next === null ? cur === undefined : cur !== undefined && sameSave(cur, next)) return saves;
  const copy = new Map(saves);
  if (next === null) copy.delete(key);
  else copy.set(key, next);
  return copy;
}

/** The outcome a transition carries over: a Not saved one, never a Saved one. */
function keepFailed(outcome: FieldOutcome | null | undefined): FieldOutcome | null {
  return outcome?.kind === "failed" ? outcome : null;
}

/** A keystroke: the draft is the text. A "saved" outcome clears. A "failed" outcome stays, so the
 *  box goes on reading Not saved while its value is being corrected, unless a save is in flight:
 *  then the outcome is about text that is no longer in the box, and the attempt that is out will
 *  give this box its next outcome. The record that a save went unanswered stays either way: a
 *  key says nothing about the server (`FieldSave.unanswered`). */
export function typed(saves: FieldSaves, key: string, text: string): FieldSaves {
  const cur = saves.get(key);
  const pending = cur?.pending ?? null;
  return withEntry(saves, key, entry(text, pending, pending === null ? keepFailed(cur?.outcome) : null, isUnanswered(cur)));
}

/** An entry that carries the record that a save went unanswered, put back to the stored value
 *  with nothing sent: the draft goes, and the outcome, an attempt in flight and the record stay.
 *  With nothing in flight such an entry reads Not saved (`FieldSave.unanswered`), so the box
 *  shows the stored value, still marked, and Restore still sends.
 *
 *  `settled` and `cleared` come here and never drop such an entry. Neither is asked for where
 *  the record stands: `saveIntent` answers "send" and so does `restoreIntent`. But the component
 *  asks those two from the save state of the render on screen, and an older attempt's lost
 *  answer is not an event: `failed` can set the record between that render and the blur or the
 *  click. Dropped then, the entry would take the record with it and leave a clean box over a
 *  value the server may not hold. Kept, that instant costs one more Enter or Restore. */
function putBackUnsent(saves: FieldSaves, key: string, cur: FieldSave): FieldSaves {
  return withEntry(saves, key, entry(null, cur.pending, cur.outcome, true));
}

/** The "settle" intent: the draft and a "failed" outcome go; a "saved" outcome stays (with draft
 *  null). An entry that carries the record that a save went unanswered is never dropped: its
 *  draft goes and the rest stays (`putBackUnsent`). */
export function settled(saves: FieldSaves, key: string): FieldSaves {
  const cur = saves.get(key);
  if (cur === undefined) return saves;
  if (isUnanswered(cur)) return putBackUnsent(saves, key, cur);
  const outcome = cur.outcome?.kind === "saved" ? cur.outcome : null;
  if (outcome === null && cur.pending === null) return withEntry(saves, key, null);
  return withEntry(saves, key, entry(null, cur.pending, outcome, false));
}

/** Restore, when `restoreIntent` answers "clear": the entry goes, and nothing is sent. An entry
 *  that carries the record that a save went unanswered is never dropped: its draft goes and the
 *  rest stays (`putBackUnsent`), so the box shows the stored value and the next Restore sends. */
export function cleared(saves: FieldSaves, key: string): FieldSaves {
  const cur = saves.get(key);
  if (cur !== undefined && isUnanswered(cur)) return putBackUnsent(saves, key, cur);
  return withEntry(saves, key, null);
}

/** A request went out. `text` is exactly what it sent: it becomes the draft, and `attempt` is the
 *  one in flight. A "saved" outcome clears; a "failed" one stays until this attempt settles, so a
 *  retry in flight still reads Not saved, and so does a Restore that saves the stored value: the
 *  box shows that value, marked, until the answer comes. The record that a save went unanswered
 *  stays: sending again is not an answer. An older attempt still out is no longer the one the box
 *  waits on. Its landing is ignored (the order it carries reaches the box through `reconciled`),
 *  and so is a failure of it the server answered. A failure of it the server did NOT answer
 *  still sets the box's record (`failed`). */
export function dispatched(saves: FieldSaves, key: string, text: string, attempt: number): FieldSaves {
  const cur = saves.get(key);
  return withEntry(saves, key, entry(text, { attempt, text }, keepFailed(cur?.outcome), isUnanswered(cur)));
}

/**
 * The request answered 2xx. Ignored unless `attempt` is the pending one. Nothing is in flight any
 * more. When the draft is null or is still the sent TEXT (trimmed), the outcome is "saved" with the
 * sent text and the draft is kept: the server payload clears it (`reconciled`), and until one
 * arrives the box goes on showing what was sent. When the draft has moved on, a "failed" outcome
 * stays (a client-side refusal of the newer text) and anything else becomes null.
 *
 * Text, not value. `dispatched` left the box holding exactly the sent text, so a draft that differs
 * from it as text was typed since the request went out, whatever number it spells. Compared by
 * value, "40.0" typed on the way to "40.05" over a sent "40" would be marked Saved here, and
 * `reconciled` would then clear that draft and put "40" in the box under the cursor. Left as a bare
 * draft, the retyped text stays in the box and the blur settles or sends it.
 *
 * Either way the record that a save of this box went unanswered goes (`FieldSave.unanswered`).
 * This attempt was sent after that one and the server answered it, so the server holds what this
 * one sent, its requests being taken to be handled in the order the page sent them (which the
 * page's mutation gate assumes too).
 */
export function landed(saves: FieldSaves, key: string, attempt: number): FieldSaves {
  const cur = saves.get(key);
  if (!cur?.pending || cur.pending.attempt !== attempt) return saves;
  const sent = cur.pending.text;
  if (cur.draft === null || cur.draft.trim() === sent.trim()) {
    return withEntry(saves, key, { draft: cur.draft, pending: null, outcome: { kind: "saved", text: sent } });
  }
  return withEntry(saves, key, { draft: cur.draft, pending: null, outcome: keepFailed(cur.outcome) });
}

/**
 * The request failed. `unanswered` says it got no answer the page can trust, so its write may
 * have been committed.
 *
 * For the pending attempt: nothing is in flight any more; the outcome is "failed"; a null draft
 * becomes the sent text, so the box shows what was sent. An unanswered failure sets the box's
 * record (`FieldSave.unanswered`). An answered one never takes that record away: it leaves the
 * entry with the record it had, or with none.
 *
 * For any other attempt of the box (one that a newer attempt has replaced, or one whose entry
 * has gone since) an answered failure is ignored: the server wrote nothing for it, and the box
 * no longer holds what it sent. An unanswered one is not ignored. That write may be what the
 * server holds, whatever the box has done since, so the record is set, in one of three ways:
 *
 * - A newer attempt is in flight: the record is set and nothing else changes. That attempt's
 *   landing takes it (`landed`); its failure, answered or not, leaves it.
 * - Nothing is in flight: the record is set and the box is made to read Not saved, because
 *   nothing else is coming that would say so. A "failed" outcome keeps its own message; no
 *   outcome, or a "saved" one, becomes "failed" with this failure's message. The draft stays as
 *   it is: text typed since is still in the box, and a box with no draft shows the stored value.
 * - There is no entry (Restore cleared it, or a payload settled it): one is made, with no draft.
 *   The box shows the stored value, marked Not saved with this failure's message, and Restore
 *   sends (`restoreIntent`).
 *
 * There is no exception where a newer attempt of the box landed before this failure arrived
 * (`FieldSave.unanswered` gives the cost). And the entry is made without asking whether the
 * order still has the line: one made for a line that has left is shown by no box, is not counted
 * (`anyNotSaved`), and goes with the next payload (`reconciled`).
 */
export function failed(saves: FieldSaves, key: string, attempt: number, message: string, unanswered = false): FieldSaves {
  const cur = saves.get(key);
  if (cur?.pending && cur.pending.attempt === attempt) {
    return withEntry(saves, key,
      entry(cur.draft ?? cur.pending.text, null, { kind: "failed", message }, unanswered || isUnanswered(cur)));
  }
  if (!unanswered) return saves;
  if (cur === undefined) return withEntry(saves, key, entry(null, null, { kind: "failed", message }, true));
  if (cur.pending !== null) return withEntry(saves, key, entry(cur.draft, cur.pending, cur.outcome, true));
  return withEntry(saves, key, entry(cur.draft, null, keepFailed(cur.outcome) ?? { kind: "failed", message }, true));
}

/** A client-side refusal: no request. The draft is the text and the outcome is "failed": this
 *  text was never sent. It replaces an earlier outcome. It leaves the record that a save went
 *  unanswered as it was: no request was made, so nothing was learned about the server. An
 *  attempt in flight is untouched: it is still out, and its answer must still find it. */
export function refused(saves: FieldSaves, key: string, text: string, message: string): FieldSaves {
  const cur = saves.get(key);
  return withEntry(saves, key, entry(text, cur?.pending ?? null, { kind: "failed", message }, isUnanswered(cur)));
}

/** One entry against the server's value for its key. The same object = keep; null = drop.
 *  The two outcomes compare differently, on purpose. A "saved" draft is the text its request sent,
 *  give or take a space beside it: `landed` marks nothing else, and a keystroke clears the mark. It
 *  is a value that was sent, not text on its way to another one, so it is compared by value, as a
 *  sent value (`sameSentValue`: "36." is 36). A "failed" draft may be text being retyped right
 *  now, so it is compared as trimmed text: by value, "40.0" typed over a refused value on the way
 *  to "40.05" would equal a stored 40, and the box would be swapped to "40" under the cursor by any
 *  payload.
 *
 *  An entry that carries the record that a save went unanswered is compared with nothing: it is
 *  kept as it is, whatever the payload shows. A payload that shows the box's own text may be
 *  older than the write that was lost (`FieldSave.unanswered`), and dropping the entry for it
 *  would leave a clean box over a value the server may not hold. */
function reconciledSave(save: FieldSave, server: string): FieldSave | null {
  if (save.pending !== null || save.outcome === null) return save;
  if (isUnanswered(save)) return save;
  if (save.outcome.kind === "failed") {
    return save.draft !== null && save.draft.trim() === server.trim() ? null : save;
  }
  if (save.draft === null) return sameSentValue(save.outcome.text, server) ? save : null;
  return sameSentValue(save.draft, server) ? { draft: null, pending: null, outcome: save.outcome } : null;
}

/**
 * Run when a new `lines` payload arrives. Drops keys the server no longer has, whatever their
 * entries hold. For an entry with no save in flight and no record that a save went unanswered:
 * "saved" with a draft the server now shows → the draft goes and the mark stays; "saved" that the
 * server contradicts (no draft and the saved text differs, or a draft that differs) → dropped;
 * "failed" whose draft is the server's value as text → dropped (the box holds what the order on
 * the page holds, and no save of it is known to have gone unanswered). A bare draft (text being
 * typed) and an entry with a save in flight are left alone.
 *
 * A "failed" draft that spells the server's value another way stays, mark and all: a weight
 * typed as "48.50" and refused reads Not saved over a stored 48.5 until Enter settles it or
 * Restore clears it. That is the cost of never replacing text that may still be being typed.
 *
 * An entry that carries the record that a save went unanswered is left as it is by every payload
 * (`reconciledSave`): a payload alone never ends that record, because one that was read or
 * answered before the lost write was committed can arrive after it. Such a box reads Not saved
 * until Enter or Restore sends a save that lands (`landed`), even when the payload shows the
 * very value in the box. Its line leaving the order still drops it.
 */
export function reconciled(saves: FieldSaves, server: ReadonlyMap<string, string>): FieldSaves {
  let next: Map<string, FieldSave> | null = null;
  for (const [key, save] of saves) {
    const value = server.get(key);
    const after = value === undefined ? null : reconciledSave(save, value);
    if (after === save) continue;
    next ??= new Map(saves);
    if (after === null) next.delete(key);
    else next.set(key, after);
  }
  return next ?? saves;
}

export type FieldView = {
  readonly text: string;
  readonly mark: "saved" | "not-saved" | null;
  readonly message: string | null;
  readonly saving: boolean;
};

/** What one box renders. The text is the draft, or the server value when there is none. "saved"
 *  shows only while the box still shows the saved value, however either side writes it. The mark
 *  is read from the outcome alone: the record that a save went unanswered is not rendered. What it
 *  changes is what Restore, a blur and Enter do (`restoreIntent`, `saveIntent`), that no payload
 *  and no `settled` or `cleared` takes the entry away (`reconciledSave`, `putBackUnsent`), and
 *  whether the box is counted (`anyNotSaved`). */
export function fieldView(save: FieldSave | undefined, server: string): FieldView {
  const text = save?.draft ?? server;
  const outcome = save?.outcome ?? null;
  const saving = (save?.pending ?? null) !== null;
  if (outcome?.kind === "failed") return { text, mark: "not-saved", message: outcome.message, saving };
  const mark = outcome !== null && sameSentValue(outcome.text, text) ? "saved" : null;
  return { text, mark, message: null, saving };
}

/** Whether the section holds unsaved work: some key the server still has, whose box reads Not
 *  saved (a "failed" outcome) or carries the record that a save of it went unanswered. The record
 *  counts on its own because there are moments when such a box has no "failed" outcome, each
 *  while a save of it is out: a key typed while its retry or its Restore's save is out clears the
 *  outcome (`typed`), and an older attempt that ends with no answer while a newer one is out
 *  sets the record beside whatever outcome the box has, which may be none (`failed`). The
 *  section must stay registered through that request. The server filter means a removed line
 *  stops counting in the render that drops it, before the effect has pruned its entries. */
export function anyNotSaved(saves: FieldSaves, server: ReadonlyMap<string, string>): boolean {
  for (const [key, save] of saves) {
    if ((save.outcome?.kind === "failed" || isUnanswered(save)) && server.has(key)) return true;
  }
  return false;
}

/** R13: a failed request got no answer the page can trust when no response arrived or the server
 *  answered 5xx. Callers pass `status` null for an error that is not an `ApiError`: no response
 *  arrived, or, since #547, the server answered 2xx and its body could not be read
 *  (`UnreadableAnswerError`, which carries no `status`). That write committed, and it counts as
 *  unanswered by the owner's ruling of 2026-10-18, which R13 did not cover. Every other status is
 *  an answer: the server refused it and wrote nothing. */
export function unansweredStatus(status: number | null): boolean {
  return status === null || status >= 500;
}

/** Intersection; the same Set when nothing was dropped. */
export function retained(ids: ReadonlySet<string>, live: Iterable<string>): ReadonlySet<string> {
  const keep = live instanceof Set ? live : new Set(live);
  const next = new Set<string>();
  for (const id of ids) {
    if (keep.has(id)) next.add(id);
  }
  return next.size === ids.size ? ids : next;
}
