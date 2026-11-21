// Client-safe, no imports but the two leaves it names: each order box's label, as the order screens
// show it, and its limits, as its column holds them. The screens name a refused box with `label`
// and check it with `box`; the server's order schemas build their rule from the same `box`
// (`decimalBoxField`), so a screen and the server cannot disagree on a limit.
import type { DecimalBox } from "./decimal-entry";
import { NET_WEIGHT_LB, TARE_EACH_LB } from "./weight-terms";

export type OrderBox = { label: string; box: DecimalBox };

/** An order line's or a rider's Net weight: it must hold a figure above zero. */
export const LINE_NET_WEIGHT: OrderBox = { label: NET_WEIGHT_LB, box: { intDigits: 10, scale: 2, min: "positive" } };
/** A load's Net weight: zero is allowed here (a load with a quantity may carry none). */
export const LOAD_NET_WEIGHT: OrderBox = { label: NET_WEIGHT_LB, box: { intDigits: 10, scale: 2, min: "nonnegative" } };
export const TARE_EACH: OrderBox = { label: TARE_EACH_LB, box: { intDigits: 10, scale: 2, min: "nonnegative" } };
export const SCALE_GROSS: OrderBox = { label: "Scale gross (lb)", box: { intDigits: 10, scale: 2, min: "nonnegative" } };
export const CHARGE_AMOUNT: OrderBox = { label: "Amount", box: { intDigits: 10, scale: 2, min: "nonnegative" } };
/** The order-entry load adjustment's weight per load. */
export const WEIGHT_PER_LOAD: OrderBox = { label: "Weight per load (lb)", box: { intDigits: 8, scale: 2, min: "positive" } };
