// Client-safe leaf (no src/server imports). What the invoice screen's Rate column shows for one
// line (owner ruling R9, 2026-10-22, #638; the owner's answers of 2026-11-06 on the issue).
//
// The server writes a line's `rate` only on a PERCENT surcharge and on the TAX line, both as a
// FRACTION (`pricing.ts`; the schema's "SURCHARGE percent or TAX rate"), so the column sits on
// the surcharge, freight, charge, cert and tax table, and the operation table carries none. A
// surcharge reads through `surchargeRateText`, the surcharge screens' own form, and tax through
// `percentFromFraction`, the invoice header's form (`7.25%`). Any other kind, a FLAT surcharge
// (whose rate is null) and a blank rate show `format.ts`'s em dash. Screen only: the invoice PDF
// still prints a surcharge as its name and amount (the owner's answer).
//
// The editable grid holds the rate as text, so it is read through `spelledDecimal` (the Decimal
// entry rule), never `Number()`; text that is not a decimal shows the dash rather than a guess.
import { spelledDecimal } from "./decimal-entry";
import { MISSING } from "./format";
import { percentFromFraction } from "./rate-display";
import { surchargeRateText } from "./surcharge-display";

export function invoiceLineRateText(kind: string, rate: number | string | null): string {
  const text = typeof rate === "number" ? String(rate) : (rate ?? "").trim();
  if (text === "") return MISSING;
  const read = spelledDecimal(text);
  if (read === null) return MISSING;
  if (kind === "SURCHARGE") return surchargeRateText({ kind: "PERCENT", rate: read.value, amount: null });
  if (kind === "TAX") return `${percentFromFraction(text)}%`;
  return MISSING;
}
