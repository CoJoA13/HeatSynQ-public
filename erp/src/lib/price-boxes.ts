// Client-safe, no imports but the two leaves it names: each price box's label, as the quote page
// and a part's Pricing show it, and its limits, as its column holds them. The screens name a
// refused box with `label` and check it with `box`; the server's schemas build their rule from
// the same `box` (`decimalBoxField`), so a screen and the server cannot disagree on a limit.
import type { DecimalBox } from "./decimal-entry";
import { EACH_WEIGHT_LB } from "./weight-terms";

export type PriceBox = { label: string; box: DecimalBox };

export const SETUP_CHARGE: PriceBox = { label: "Setup charge", box: { intDigits: 10, scale: 2, min: "nonnegative" } };
export const UNIT_PRICE: PriceBox = { label: "Unit price", box: { intDigits: 8, scale: 4, min: "nonnegative" } };
export const MINIMUM_CHARGE: PriceBox = { label: "Minimum charge", box: { intDigits: 10, scale: 2, min: "nonnegative" } };
export const BREAK_THRESHOLD: PriceBox = { label: "Threshold", box: { intDigits: 10, scale: 2, min: "positive" } };
export const BREAK_PRICE: PriceBox = { label: "Price", box: { intDigits: 8, scale: 4, min: "nonnegative" } };
/** A free-text quote line's each weight: Part.eachWeight's Decimal(10, 4). */
export const QUOTE_EACH_WEIGHT: PriceBox = { label: EACH_WEIGHT_LB, box: { intDigits: 6, scale: 4, min: "positive" } };
