// Client-safe pure display helpers for the two things a surcharge's KIND changes on screen: what
// its configured value LOOKS like, and what the plant-level value it falls back to is CALLED.
// Neither can live in format.ts — that leaf formats numbers and dates and knows nothing about
// surcharges (#238) — and neither can live in a client component, because both have two callers
// apiece and a string composed inside a `confirm()` cannot be reached by a unit test at all.
//
// #239 P3a: a surcharge is either a PERCENT rate or a FLAT dollar amount (invoice-constants.ts),
// but every sentence about the plant-level value was written for the percent case only. The
// demonstration dataset's own "Expedite Fee" is FLAT $75.00, so the customer page told an operator
// that clearing a dollar override would "bill at the plant rate" — a rate that surcharge does not
// have. The override INPUTS beside those sentences already branched ("plant rate" / "plant
// amount" placeholders); it was only the prose that did not.
import { formatMoney } from "./format";
import { decimalToPercentText } from "./surcharge-percent";
import type { SurchargeKindValue } from "./invoice-constants";

/** What the plant-level value is called for this kind of surcharge. The two nouns are the override
 *  inputs' own placeholders, so a sentence and the box it describes use one word between them. */
export function plantDefaultNoun(kind: SurchargeKindValue): string {
  return kind === "PERCENT" ? "plant rate" : "plant amount";
}

/** A surcharge's configured value, formatted the way its own kind is entered and printed: a
 *  percent through the admin screen's decimal↔percent conversion (`0.035` is typed and shown as
 *  `3.5`), a flat amount through the shared money formatter (#238).
 *
 *  `null` is a state a live surcharge can genuinely be in — `buildSurchargeBody` nulls the pair
 *  the current kind does not use, so a row flipped PERCENT→FLAT and not yet given an amount has
 *  neither — and it says so in words rather than rendering a gap the reader has to interpret. */
export function surchargeRateText(
  { kind, rate, amount }: { kind: SurchargeKindValue; rate: number | null; amount: number | null },
): string {
  if (kind === "PERCENT") return rate === null ? "no rate set" : `${decimalToPercentText(rate)}%`;
  return amount === null ? "no amount set" : formatMoney(amount);
}
