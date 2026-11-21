// Client-safe and pure, with no imports: the one rule for a typed whole number in the master-data
// integer boxes (owner ruling 19 of the 2026-10-22 review, G5-4). The decimal entry design
// (docs/superpowers/specs/2026-10-14-decimal-entry-design.md §2.1) left whole-number boxes out of
// `decimal-entry.ts` on purpose; this leaf is the whole-number rule for the boxes ruling 19 named,
// beside it: a part's Load quantity and Request days override, a customer's Request days override, and
// Terms' Net days and Discount days, on their screens and in spreadsheet paste. Each read `Number()`
// before, which takes `1e2` as 100 and `0x10` as 16 and let a figure outside the server's bounds
// come back as the zod path (`loadQty: Too small…`), not the box's name.
//
// A whole number is digits, with spaces around them allowed and nothing else: no sign, no point,
// no exponent, no comma. A box is its label and its bounds, and it has ONE sentence, which names
// the box and its bounds and is the answer to every refusal: a spelling that is not digits and a
// figure out of bounds alike (the order screens' `must be a whole number of at least N` form). The
// order and shipment screens' whole-number boxes keep their own checks and sentences, which their
// tests pin; moving them here is a later change. The server's `z.number().int().min().max()`
// bounds stay the enforcement.

export type WholeNumberBox = { label: string; min: number; max?: number };

export type WholeNumberReading = { ok: true; value: number } | { ok: false };

/** Digits, and nothing else, after the spaces around them are dropped. Anchored and linear. */
const DIGITS = /^\d+$/;

/** The whole number `text` spells within `box`, or `{ ok: false }` for anything else: a spelling
 *  that is not digits, a run of digits too long for a safe integer, a figure below `min` or, where
 *  the box has one, above `max`. A blank is `{ ok: false }` too; `wholeNumberRefusal` is what
 *  treats a blank as the caller's question. */
export function readWholeNumber(text: string, box: WholeNumberBox): WholeNumberReading {
  const trimmed = text.trim();
  if (!DIGITS.test(trimmed)) return { ok: false };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) return { ok: false };
  if (value < box.min) return { ok: false };
  if (box.max !== undefined && value > box.max) return { ok: false };
  return { ok: true, value };
}

/** The box's one sentence: its label, then its floor, or both bounds when it has a ceiling (the
 *  ceiling's form is the owner's, 2026-10-24: "… must be a whole number from 0 to 3650."). */
export function wholeNumberSentence(box: WholeNumberBox): string {
  return box.max === undefined
    ? `${box.label} must be a whole number of at least ${box.min}.`
    : `${box.label} must be a whole number from ${box.min} to ${box.max}.`;
}

/** The sentence for text that does not fit `box`, or null when it fits or is blank. A blank box is
 *  the caller's question: Load quantity's and the overrides' blank clears the figure, and the Add row's
 *  blank drops the key. */
export function wholeNumberRefusal(text: string, box: WholeNumberBox): string | null {
  if (text.trim() === "") return null;
  return readWholeNumber(text, box).ok ? null : wholeNumberSentence(box);
}
