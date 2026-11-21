// Client-safe. A part's Pricing section checks a typed decimal through the one rule
// (`decimalRefusal`) before it saves, and names the refused box by its place: the operation's
// place in the list as rendered, counted from 1, then the break's place in that operation, then
// the box's label (owner answer, decimal entry pull request 2). A blank is not this file's
// question: a row's money box takes one (it clears the figure), and a break's own blank has its
// own sentence in the section.
import { decimalRefusal } from "./decimal-entry";
import {
  BREAK_PRICE, BREAK_THRESHOLD, MINIMUM_CHARGE, SETUP_CHARGE, UNIT_PRICE, type PriceBox,
} from "./price-boxes";

export type RowMoneyBox = "setupCharge" | "unitPrice" | "minimumCharge";
export type BreakBox = "threshold" | "price";

const ROW_BOXES: Record<RowMoneyBox, PriceBox> = {
  setupCharge: SETUP_CHARGE,
  unitPrice: UNIT_PRICE,
  minimumCharge: MINIMUM_CHARGE,
};
const BREAK_BOXES: Record<BreakBox, PriceBox> = { threshold: BREAK_THRESHOLD, price: BREAK_PRICE };

/** The refusal for an operation's money box, or null. `operation` counts from 1. */
export function rowFieldRefusal(operation: number, field: RowMoneyBox, text: string): string | null {
  const { label, box } = ROW_BOXES[field];
  return decimalRefusal(`Operation ${operation}, ${label}`, text, box);
}

/** The refusal for a saved break's box, or null. Both numbers count from 1. */
export function breakFieldRefusal(
  operation: number, breakNumber: number, field: BreakBox, text: string,
): string | null {
  const { label, box } = BREAK_BOXES[field];
  return decimalRefusal(`Operation ${operation}, break ${breakNumber}, ${label}`, text, box);
}

/** Every refusal on the Add break row, threshold first: the row has two boxes and both are named. */
export function newBreakRefusals(operation: number, draft: { threshold: string; price: string }): string[] {
  return (["threshold", "price"] as const).flatMap((field) => {
    const { label, box } = BREAK_BOXES[field];
    const line = decimalRefusal(`Operation ${operation}, new break, ${label}`, draft[field], box);
    return line === null ? [] : [line];
  });
}

type RefusalRows = { id: string; breaks: { id: string }[] }[];

/**
 * The refusal for an operation's money box as the section holds it, or null: the operation's
 * number is its place in `rows` as rendered. A blank (or only spaces) is a clear, not a refusal,
 * and a row that is not there names nothing.
 */
export function rowBoxRefusal(rows: RefusalRows, id: string, field: RowMoneyBox, text: string): string | null {
  const index = rows.findIndex((r) => r.id === id);
  if (index < 0 || text.trim() === "") return null;
  return rowFieldRefusal(index + 1, field, text);
}

/**
 * The refusal for a saved break's box as the section holds it, or null: both numbers are places in
 * `rows` as rendered. Blank text is the section's own sentence, and a row or break that is not
 * there names nothing.
 */
export function breakBoxRefusal(
  rows: RefusalRows, priceId: string, breakId: string, field: BreakBox, text: string,
): string | null {
  const operation = rows.findIndex((r) => r.id === priceId);
  if (operation < 0 || text.trim() === "") return null;
  const breakIndex = rows[operation].breaks.findIndex((b) => b.id === breakId);
  if (breakIndex < 0) return null;
  return breakFieldRefusal(operation + 1, breakIndex + 1, field, text);
}
