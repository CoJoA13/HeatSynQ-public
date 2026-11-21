// The each weight, net weight, tare each and tare total headings, each written once.
//
// A column heading, a field label or an Excel header that is exactly one of these five texts
// reads it from here. tests/weight-words-sweep.test.ts fails a second copy: one of the five as the
// whole of a string, of a template's piece or of a piece of JSX text, in any other file under src/.
// That check compares whole texts, so a longer heading that holds one of these is not a copy.
//
// "Scale gross (lb)" is not here, and neither are "Net (lb)", "Tare (lb)" and "Gross (lb)", the
// totals tables' headings, which src/lib/order-totals.ts holds.
//
// This file imports nothing, so client code and server code can both import it.
export const EACH_WEIGHT_LB = "Each weight (lb)";
export const NET_WEIGHT_LB = "Net weight (lb)";
export const NET_WEIGHT = "Net weight";
export const TARE_EACH_LB = "Tare each (lb)";
export const TARE_TOTAL_LB = "Tare total (lb)";
