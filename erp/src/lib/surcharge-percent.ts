// Client-safe pure functions — no src/server imports. `Surcharge.rate` is stored as a decimal
// (Decimal(9,6): 4% is 0.040000) but the admin screen shows and accepts it as a percent (task-7
// brief) — "4 on screen stores 0.040000". Getting this backwards, or double-converting on a
// save/reload/save round trip, is the most likely real bug in that screen, so the conversion is
// pulled out here where it can be unit-tested directly instead of only exercised through the
// browser.
//
// The typed percent becomes the `rate` text by an exact shift of the decimal point, shared with
// `rate-display.ts` (`fractionFromPercent`) — never a `toFixed` after a floating-point division,
// and never `Number()`. The display side keeps its float shift: `toFixed(4)` on a stored
// Decimal(9,6) is safe for the magnitudes this field sees.

import { fractionFromPercent } from "./rate-display";

/** Percent text as typed (e.g. "4", ".36", "") -> the `rate` text to send (e.g. "0.04", "0.0036",
 *  null). An exact shift of the decimal point, never `Number()`: a number would round "4.12345" to
 *  six places without a word and read "1e2" as 100 and "4%" as no rate (decimal entry design
 *  §1.4). Text that is no decimal spelling is sent as typed, and the server's rule refuses it.
 *  null only for a blank box, which means no rate. */
export function percentToDecimal(percentText: string): string | null {
  const trimmed = percentText.trim();
  return trimmed === "" ? null : fractionFromPercent(trimmed);
}

/** The decimal `rate` value as loaded from the server (e.g. 0.04) -> the percent text to show in
 *  the input (e.g. "4"). `""` for `null` (no rate set). */
export function decimalToPercentText(rate: number | null): string {
  if (rate === null) return "";
  // Fixed to 4 places (rate's 6 fractional digits, shifted 2 by the *100), then re-numbered to
  // drop trailing zeros for display ("4.0000" -> 4 -> "4").
  return String(Number((rate * 100).toFixed(4)));
}
