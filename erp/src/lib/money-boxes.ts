// Client-safe, no imports but the leaves it names: each money box, as the invoice draft, the
// receipt batch, the apply panels and the customer page show it, and its limits, as its column holds
// them (the shipment-boxes.ts shape). The screens name a refused box with `label` and check it with
// `box`; the server's schemas build their rule from the same `box` (`decimalBoxField`), so a screen
// and the server cannot disagree on a limit.
import type { DecimalBox } from "./decimal-entry";
import { NET_WEIGHT_LB } from "./weight-terms";

export type MoneyBox = { label: string; box: DecimalBox };

/** An invoice or credit memo draft line's Net weight; a credit memo keeps the billed weight's sign. */
export const INVOICE_LINE_NET_WEIGHT: MoneyBox = { label: NET_WEIGHT_LB, box: { intDigits: 10, scale: 2 } };
/** A draft line's Amount; a credit memo's carries the sign flipped, so no min. */
export const INVOICE_LINE_AMOUNT: MoneyBox = { label: "Amount", box: { intDigits: 10, scale: 2 } };
/** A receipt batch's apply grid: one box on the server for a payment and a write-off line. */
export const APPLY_LINE_AMOUNT: MoneyBox = { label: "Amount", box: { intDigits: 10, scale: 2, min: "positive" } };
/** The grid's Write-off column: the same box under its own heading. */
export const APPLY_LINE_WRITE_OFF: MoneyBox = { label: "Write-off", box: APPLY_LINE_AMOUNT.box };
/** An open item's credit application amount. */
export const AMOUNT_TO_APPLY: MoneyBox = { label: "Amount to apply", box: { intDigits: 10, scale: 2, min: "positive" } };
/** An open item's write-off amount. */
export const AMOUNT_TO_WRITE_OFF: MoneyBox = { label: "Amount to write off", box: { intDigits: 10, scale: 2, min: "positive" } };
/** A payment's amount on a receipt batch. */
export const PAYMENT_AMOUNT: MoneyBox = { label: "Payment amount", box: { intDigits: 10, scale: 2, min: "positive" } };
/** A receipt batch's optional control total; no min. */
export const CONTROL_TOTAL: MoneyBox = { label: "Control total", box: { intDigits: 10, scale: 2 } };
/** A customer's credit limit; no min. */
export const CREDIT_LIMIT: MoneyBox = { label: "Credit limit", box: { intDigits: 10, scale: 2 } };
