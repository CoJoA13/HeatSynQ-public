// Client-safe, no imports but the leaves it names: each rate, percent and amount box on the customer,
// plant billing, surcharge and reference screens, and its limits (the money-boxes.ts shape). The
// screens name a refused box with `label` and check it with `box`; the server's schemas build their
// rule from the same boxes (`decimalBoxField`), so a screen and the server cannot disagree on a limit.
//
// A rate is STORED as a fraction (`0.0725`) and TYPED as a percent (`7.25`). Each `*_FRACTION` is the
// stored box the server reads; the screen's box is `percentBoxOf` it, and the percent is converted
// to the fraction only after the check. A box stored as a percent (finance charge, a term's
// discount) is its own typed box. `decimalBoxField` passes no `unit` on (it rebuilds the box from
// its digits and minimum), so the server's sentences do not change.
import { percentBoxOf, type DecimalBox } from "./decimal-entry";

export type RateBox = { label: string; box: DecimalBox };

/** A customer's and the plant's sales tax rate, as the column stores it (Decimal(9,6)). */
export const SALES_TAX_RATE_FRACTION: DecimalBox = { intDigits: 3, scale: 6, min: "nonnegative" };
/** The same rate as a person types it. */
export const SALES_TAX_RATE: RateBox = { label: "Sales tax rate (%)", box: percentBoxOf(SALES_TAX_RATE_FRACTION) };
/** The plant's rate on Accounting: the same box under the owner's heading (2026-11-01 on #826). */
export const PLANT_SALES_TAX_RATE: RateBox = { label: "Plant sales tax rate (%)", box: SALES_TAX_RATE.box };
/** A customer's and the plant's finance charge, stored and typed as a monthly percent (Decimal(6,4)). */
export const FINANCE_CHARGE: RateBox = {
  label: "Finance charge (monthly %)", box: { intDigits: 2, scale: 4, min: "nonnegative", unit: "percent" },
};
/** The plant's on Accounting, the same box under the owner's heading. */
export const PLANT_FINANCE_CHARGE: RateBox = { label: "Monthly rate (%)", box: FINANCE_CHARGE.box };
/** The plant's default certification charge amount (Decimal(12,2)). */
export const CERT_CHARGE_DEFAULT: RateBox = {
  label: "Certification charge ($)", box: { intDigits: 10, scale: 2, min: "nonnegative" },
};
/** A surcharge's rate and a customer's override of it, as the columns store them (Decimal(9,6)). */
export const SURCHARGE_RATE_FRACTION: DecimalBox = { intDigits: 3, scale: 6, min: "nonnegative" };
/** The same rate as a person types it. */
export const SURCHARGE_RATE: RateBox = { label: "Rate (%)", box: percentBoxOf(SURCHARGE_RATE_FRACTION) };
/** A customer's rate override: the admin rate's box under its own heading. */
export const SURCHARGE_RATE_OVERRIDE: RateBox = { label: "Rate override (%)", box: SURCHARGE_RATE.box };
/** A surcharge's amount (Decimal(12,2)). */
export const SURCHARGE_AMOUNT: RateBox = {
  label: "Amount ($)", box: { intDigits: 10, scale: 2, min: "nonnegative" },
};
/** A customer's amount override: the admin amount's box under its own heading. */
export const SURCHARGE_AMOUNT_OVERRIDE: RateBox = { label: "Amount override ($)", box: SURCHARGE_AMOUNT.box };
/** A surcharge's minimum amount: the same box under its own heading. */
export const SURCHARGE_MINIMUM_AMOUNT: RateBox = { label: "Minimum amount ($)", box: SURCHARGE_AMOUNT.box };
/** A term's early-pay discount, stored and typed as a percent (Decimal(5,2)). */
export const DISCOUNT_PERCENT: RateBox = {
  label: "Discount %", box: { intDigits: 3, scale: 2, min: "nonnegative", unit: "percent" },
};
