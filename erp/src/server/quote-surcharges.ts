// The surcharge estimate a printed quote shows under one line's operations (#948; owner rulings 2,
// 3, 4d and 4f). The rule is `surchargeOnLines`, never restated: this leaf only asks it, once for the
// whole line and once per operation to learn which operations are in scope. It reads no database.
//
// - Ruling 4a: a surcharge with nothing in scope prints no row.
// - Rulings 4d and 4f: a percent surcharge prints its figure only when every in-scope operation has a
//   price (an amount, and not a Needs price stand-in); otherwise the rate prints and the figure is
//   blank, never a partial sum. A flat surcharge needs no amounts and always prints its figure.
import { decimalToPercentText } from "../lib/surcharge-percent";
import { surchargeOnLines, type SurchargeInput } from "./pricing";
import type { IndicativeOperation } from "./quotes";

export type QuoteEstimateOperation = IndicativeOperation & { processStepCodeId: string | null };
export type QuotePdfSurcharge = { name: string; rateText: string | null; amount: number | null };

/** Surcharges in the order given (Admin's `position` order), over one quote line's operations. */
export function quoteSurchargeEstimates(
  surcharges: readonly SurchargeInput[],
  ops: readonly QuoteEstimateOperation[],
): QuotePdfSurcharge[] {
  const rows: QuotePdfSurcharge[] = [];
  for (const s of surcharges) {
    const asLines = ops.map((o) => ({
      kind: "OPERATION" as const, processStepCodeId: o.processStepCodeId, amount: o.amount ?? 0,
    }));
    const figure = surchargeOnLines(s, asLines);
    if (figure === null) continue;
    // In scope = the rule's own scope test, asked of one operation at a time: never restated here.
    const inScope = asLines.filter((l) => surchargeOnLines(s, [l]) !== null);
    const complete = ops.every((o, i) => !inScope.includes(asLines[i]) || (o.amount !== null && !o.needsPrice));
    rows.push({
      name: s.name,
      rateText: s.kind === "PERCENT" && s.rate !== null ? `${decimalToPercentText(s.rate)}%` : null,
      amount: s.kind === "FLAT" || complete ? figure : null,
    });
  }
  return rows;
}
