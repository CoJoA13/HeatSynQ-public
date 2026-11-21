import { isEnterCommit, type EnterKeyEvent } from "./enter-commit";

/**
 * The record a blur-save box OUTSIDE the edit guard keeps of the text it held when the cursor
 * entered it, and the one decision its blur and its Enter make from it (owner ruling R7, P8 step 5:
 * Enter commits as the blur does, the cursor kept in the box). The guard's boxes keep this record as
 * a guard session (`editGuard.onEnterCommit`); these keep it here, one entry per box key.
 *
 * A box's commit answers what it did:
 * - `false`: it refused the text, put the box back on its text at focus and sent nothing;
 * - a promise, when it sent a save: of the text the box shows once that save has landed (learned
 *   as the box's text, so leaving it sends nothing), or of `false` when it did not land (the record
 *   goes back to its text at focus, so the same text can be sent again by leaving the box).
 *
 * An accepted Enter REPLACES the record's text with the sent text, never adds to it: after Enter of
 * 5 over 3, typing 3 back and leaving sends 3.
 */
export type FocusRecord = {
  /** Each box's text at focus, or the text its newest sent save carried. */
  at: Record<string, string>;
  /** The newest save of the box that has not settled yet, by its place in `sent`. */
  held: Record<string, number>;
  /** The text last known stored: the box's text at focus, or the newest sent save that landed. A
   *  save that does not land puts the record back to this, never to an earlier save's text that did
   *  not land either. */
  stored: Record<string, { text: string; seq: number }>;
  /** A count of the saves sent, to tell the newest landed one. */
  sent: number;
};
export function focusRecord(): FocusRecord {
  return { at: {}, held: {}, stored: {}, sent: 0 };
}

export type BoxCommit = (value: string, atFocus: string) => false | Promise<string | false>;
export type SameText = (a: string, b: string) => boolean;
export const exactText: SameText = (a, b) => a === b;
export const trimmedText: SameText = (a, b) => a.trim() === b.trim();

const atFocusOf = (rec: FocusRecord, key: string) => (Object.hasOwn(rec.at, key) ? rec.at[key] : "");

/** The text drafts once a box's save has settled: its draft is dropped only while it still holds the
 *  text that save sent. Enter keeps the cursor in the box, so typing can go on while the save is
 *  out, and that newer text is the box's own, to be sent when the box is left. */
export function withoutSettledDraft(
  drafts: Record<string, string>, key: string, sent: string,
): Record<string, string> {
  if (!Object.hasOwn(drafts, key) || drafts[key] !== sent) return drafts;
  const next = { ...drafts };
  delete next[key];
  return next;
}

/** The text a box's record holds while a save of the box is out (the text that save sent), else
 *  null. A refusal while a save is out puts this back in the box, never the row's figure, which may
 *  still be the one from before that save (Codex on #812). */
export function heldText(rec: FocusRecord, key: string): string | null {
  return Object.hasOwn(rec.held, key) && Object.hasOwn(rec.at, key) ? rec.at[key] : null;
}

/** The cursor entering a box. While a save of that box is out, the record already holds the text
 *  it sent, which the box shows, so it is kept. */
export function noteFocus(rec: FocusRecord, key: string, value: string): void {
  if (Object.hasOwn(rec.held, key)) return;
  rec.at[key] = value;
  rec.stored[key] = { text: value, seq: rec.sent };
}

/** A box being left. `"unchanged"`: it shows its text at focus and nothing is sent, so a page drops
 *  that box's draft; `"held"`: it shows the text a save sent that has not settled, so its draft
 *  stays until that save settles it; `"sent"`: its commit ran. A save sent here is followed exactly
 *  as an Enter's is (`follow`), so the record learns what it stored before the box is entered again. */
export function leaveBox(
  rec: FocusRecord, key: string, value: string, commit: BoxCommit, same: SameText = exactText,
  settled?: Settled,
): "unchanged" | "held" | "sent" {
  const atFocus = atFocusOf(rec, key);
  if (same(value, atFocus)) return Object.hasOwn(rec.held, key) ? "held" : "unchanged";
  const result = commit(value, atFocus);
  if (result !== false) follow(rec, key, value, atFocus, result, settled);
  return "sent";
}

/** A key pressed in a box. Enter commits the box as leaving it would, the cursor kept in it; any
 *  other key, and an Enter that ends an IME composition, does nothing. */
export function enterBox(
  e: EnterKeyEvent, rec: FocusRecord, key: string, value: string, commit: BoxCommit, same: SameText = exactText,
  settled?: Settled,
): void {
  if (!isEnterCommit(e)) return;
  const atFocus = atFocusOf(rec, key);
  if (same(value, atFocus)) return;
  const result = commit(value, atFocus);
  if (result !== false) follow(rec, key, value, atFocus, result, settled);
}

/** Called with the sent text when the newest save of the box settles, never an older one: a page
 *  drops the box's draft there (`withoutSettledDraft`), so an earlier save of the same text cannot
 *  clear a later one's draft (Codex on #812). */
export type Settled = (sent: string) => void;

/** A save the box sent, by blur or Enter: the record takes the sent text and holds it, by the
 *  save's place in the send order, until that save settles. */
function follow(
  rec: FocusRecord, key: string, value: string, atFocus: string, result: Promise<string | false>, settled?: Settled,
): void {
  const seq = ++rec.sent;
  rec.at[key] = value;
  rec.held[key] = seq;
  const settle = (shown: string | false) => {
    const before = Object.hasOwn(rec.stored, key) ? rec.stored[key] : null;
    if (shown !== false && (!before || before.seq < seq)) rec.stored[key] = { text: shown, seq };
    const stored = Object.hasOwn(rec.stored, key) ? rec.stored[key] : null;
    if (Object.hasOwn(rec.held, key) && rec.held[key] === seq) {
      // The newest save of the box settles: the record takes what the box shows if it landed,
      // else the text last known stored, while it still holds this save's text.
      delete rec.held[key];
      if (rec.at[key] === value) rec.at[key] = shown !== false ? shown : stored ? stored.text : atFocus;
      settled?.(value);
      return;
    }
    // An older save landing after the newest one settled (and failed): the record, put back to the
    // text then last known stored, follows the newer stored text. While a save is still out the
    // record is that save's text, which its own settlement decides; a refocus since is newer than
    // any save sent before it, so such a landing changes nothing.
    if (!Object.hasOwn(rec.held, key) && stored && stored !== before) rec.at[key] = stored.text;
  };
  void result.then(settle, () => settle(false));
}
