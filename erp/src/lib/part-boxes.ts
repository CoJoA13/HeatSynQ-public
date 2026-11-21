// Client-safe, no imports but the leaves it names: each box on the part page, its inspections and a
// cert's readings, and its limits, as its column holds them (the money-boxes.ts shape). The screens
// name a refused box with `label` and check it with `box`; the server's schemas build their rule from
// the same `box` (`decimalBoxField`), so a screen and the server cannot disagree on a limit.
//
// Each weight and Load weight keep the minimum they always had. An inspection's Min and Max and a
// reading's value gain `nonnegative` (decimal entry design §9, owner ruling O1): a figure below zero
// is refused on the server and on the screens alike.
import type { DecimalBox } from "./decimal-entry";
import { EACH_WEIGHT_LB } from "./weight-terms";

export type PartBox = { label: string; box: DecimalBox };

/** A part's Each weight (Decimal(10,4), required). */
export const EACH_WEIGHT: PartBox = { label: EACH_WEIGHT_LB, box: { intDigits: 6, scale: 4, min: "positive" } };
/** A part's Load weight (Decimal(10,2)); the part page's own label, not a term in weight-terms.ts. */
export const LOAD_WEIGHT: PartBox = { label: "Load weight (lb)", box: { intDigits: 8, scale: 2, min: "positive" } };
/** An inspection's Min (Decimal(10,4)). */
export const INSPECTION_MIN: PartBox = { label: "Min", box: { intDigits: 6, scale: 4, min: "nonnegative" } };
/** An inspection's Max: Min's box under its own heading. */
export const INSPECTION_MAX: PartBox = { label: "Max", box: INSPECTION_MIN.box };
/** A cert reading's value (Decimal(10,4)). */
export const READING_VALUE: PartBox = { label: "Value", box: { intDigits: 6, scale: 4, min: "nonnegative" } };
