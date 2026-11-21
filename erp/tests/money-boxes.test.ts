import { describe, expect, it } from "vitest";
import {
  AMOUNT_TO_APPLY, AMOUNT_TO_WRITE_OFF, APPLY_LINE_AMOUNT, APPLY_LINE_WRITE_OFF, CONTROL_TOTAL,
  CREDIT_LIMIT, INVOICE_LINE_AMOUNT, INVOICE_LINE_NET_WEIGHT, PAYMENT_AMOUNT,
} from "@/lib/money-boxes";
import { NET_WEIGHT_LB } from "@/lib/weight-terms";

describe("money boxes", () => {
  it("states each box once", () => {
    expect(INVOICE_LINE_NET_WEIGHT).toEqual({ label: NET_WEIGHT_LB, box: { intDigits: 10, scale: 2 } });
    expect(INVOICE_LINE_AMOUNT).toEqual({ label: "Amount", box: { intDigits: 10, scale: 2 } });
    expect(APPLY_LINE_AMOUNT).toEqual({ label: "Amount", box: { intDigits: 10, scale: 2, min: "positive" } });
    expect(APPLY_LINE_WRITE_OFF).toEqual({ label: "Write-off", box: { intDigits: 10, scale: 2, min: "positive" } });
    expect(AMOUNT_TO_APPLY).toEqual({ label: "Amount to apply", box: { intDigits: 10, scale: 2, min: "positive" } });
    expect(AMOUNT_TO_WRITE_OFF).toEqual({ label: "Amount to write off", box: { intDigits: 10, scale: 2, min: "positive" } });
    expect(PAYMENT_AMOUNT).toEqual({ label: "Payment amount", box: { intDigits: 10, scale: 2, min: "positive" } });
    expect(CONTROL_TOTAL).toEqual({ label: "Control total", box: { intDigits: 10, scale: 2 } });
    expect(CREDIT_LIMIT).toEqual({ label: "Credit limit", box: { intDigits: 10, scale: 2 } });
  });

  it("gives the write-off column the apply amount's own box", () => {
    expect(APPLY_LINE_WRITE_OFF.box).toBe(APPLY_LINE_AMOUNT.box);
  });
});
