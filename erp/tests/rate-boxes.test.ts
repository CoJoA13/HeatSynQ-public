import { describe, expect, it } from "vitest";
import { decimalRefusal, percentBoxOf } from "@/lib/decimal-entry";
import {
  CERT_CHARGE_DEFAULT, DISCOUNT_PERCENT, FINANCE_CHARGE, SALES_TAX_RATE, SALES_TAX_RATE_FRACTION,
  SURCHARGE_AMOUNT, SURCHARGE_AMOUNT_OVERRIDE, SURCHARGE_MINIMUM_AMOUNT, SURCHARGE_RATE,
  SURCHARGE_RATE_FRACTION, SURCHARGE_RATE_OVERRIDE,
} from "@/lib/rate-boxes";

const AMOUNT = { intDigits: 10, scale: 2, min: "nonnegative" } as const;
const TYPED_RATE = { intDigits: 5, scale: 4, min: "nonnegative", unit: "percent" } as const;

describe("rate boxes", () => {
  it("the stored fractions are the columns' boxes", () => {
    expect(SALES_TAX_RATE_FRACTION).toEqual({ intDigits: 3, scale: 6, min: "nonnegative" });
    expect(SURCHARGE_RATE_FRACTION).toEqual({ intDigits: 3, scale: 6, min: "nonnegative" });
  });

  it.each([
    [SALES_TAX_RATE, "Sales tax rate (%)", TYPED_RATE],
    [FINANCE_CHARGE, "Finance charge (monthly %)", { intDigits: 2, scale: 4, min: "nonnegative", unit: "percent" }],
    [CERT_CHARGE_DEFAULT, "Certification charge ($)", AMOUNT],
    [SURCHARGE_RATE, "Rate (%)", TYPED_RATE],
    [SURCHARGE_RATE_OVERRIDE, "Rate override (%)", TYPED_RATE],
    [SURCHARGE_AMOUNT, "Amount ($)", AMOUNT],
    [SURCHARGE_AMOUNT_OVERRIDE, "Amount override ($)", AMOUNT],
    [SURCHARGE_MINIMUM_AMOUNT, "Minimum amount ($)", AMOUNT],
    [DISCOUNT_PERCENT, "Discount %", { intDigits: 3, scale: 2, min: "nonnegative", unit: "percent" }],
  ] as const)("%j", (rateBox, label, box) => {
    expect(rateBox).toEqual({ label, box });
  });

  it("an override box is its admin box", () => {
    expect(SURCHARGE_RATE_OVERRIDE.box).toBe(SURCHARGE_RATE.box);
    expect(SURCHARGE_AMOUNT_OVERRIDE.box).toBe(SURCHARGE_AMOUNT.box);
    expect(SURCHARGE_MINIMUM_AMOUNT.box).toBe(SURCHARGE_AMOUNT.box);
  });

  it("the sales tax rate is derived from its stored fraction", () => {
    expect(SALES_TAX_RATE.box).toEqual(percentBoxOf(SALES_TAX_RATE_FRACTION));
  });

  it.each([
    ["7.12345", "Sales tax rate (%): use at most 4 digits after the point."],
    ["7.12340", null],
    ["123456", "Sales tax rate (%): must be less than 100,000."],
    ["-1", "Sales tax rate (%): cannot be negative."],
    ["4%", "Sales tax rate (%): enter a number without % or commas, such as 7.25."],
  ])("sales tax rate %j", (text, line) => {
    expect(decimalRefusal(SALES_TAX_RATE.label, text, SALES_TAX_RATE.box)).toBe(line);
  });

  it("the finance charge refuses 100", () => {
    expect(decimalRefusal(FINANCE_CHARGE.label, "100", FINANCE_CHARGE.box))
      .toBe("Finance charge (monthly %): must be less than 100.");
  });
});
