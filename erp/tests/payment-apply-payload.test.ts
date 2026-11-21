import { describe, expect, it } from "vitest";
import { paymentApplyPayload } from "../src/lib/payment-apply-payload";

const row = (key: string, patch: Partial<Parameters<typeof paymentApplyPayload>[0][number]> = {}) => ({
  key, documentNumber: `INV-${key}`, amount: "", takeDiscount: "false", discountAmount: "", writeOffAmount: "", writeOffReason: "", ...patch,
});
const open = { allowed: true };

describe("paymentApplyPayload", () => {
  it("sends a typed amount as its trimmed text", () => {
    expect(paymentApplyPayload([row("A", { amount: " .36 " })], open))
      .toEqual({ ok: true, lines: [{ invoiceId: "A", type: "PAYMENT", amount: ".36" }] });
  });
  it("lists every refusal at once, in row and column order", () => {
    expect(paymentApplyPayload([row("A", { amount: "1e2" }), row("B", { writeOffAmount: "1.234", writeOffReason: "" })], open)).toEqual({
      ok: false,
      error: [
        "INV-A, Amount: enter a number without $ or commas, such as 0.36.",
        "INV-B, Write-off: use at most 2 digits after the point.",
        "INV-B: a write-off needs a reason.",
      ].join("\n"),
    });
  });
  it("names a zero and a too-large amount", () => {
    expect(paymentApplyPayload([row("A", { amount: "0" })], open)).toEqual({ ok: false, error: "INV-A, Amount: must be greater than zero." });
    expect(paymentApplyPayload([row("A", { amount: "12345678901" })], open))
      .toEqual({ ok: false, error: "INV-A, Amount: must be less than 10,000,000,000." });
  });
  it("answers a typed write-off without access with the gate's title alone, beside a refused Amount", () => {
    expect(paymentApplyPayload([row("A", { amount: "1e2" }), row("B", { writeOffAmount: "5", writeOffReason: "x" })],
      { allowed: false, title: "Requires write_off" })).toEqual({ ok: false, error: "Requires write_off" });
    expect(paymentApplyPayload([row("B", { writeOffAmount: "5", writeOffReason: "x" })], { allowed: false }))
      .toEqual({ ok: false, error: "Write-off access is required." });
  });
  it("answers a typed write-off without access with the gate's title alone, beside a refused Amount on the SAME row", () => {
    expect(paymentApplyPayload([row("A", { amount: "1e2", writeOffAmount: "5", writeOffReason: "x" })],
      { allowed: false, title: "Requires write_off" })).toEqual({ ok: false, error: "Requires write_off" });
  });
  it("asks for at least one amount when every box is blank, and takes a ticked discount alone", () => {
    expect(paymentApplyPayload([row("A")], open))
      .toEqual({ ok: false, error: "Enter at least one payment, discount, or write-off amount before applying." });
    expect(paymentApplyPayload([row("A", { takeDiscount: "true", discountAmount: "20" })], open))
      .toEqual({ ok: true, lines: [{ invoiceId: "A", type: "DISCOUNT", amount: "20" }] });
  });
  it("keeps the line order: payment, discount, then a write-off with its trimmed reason", () => {
    expect(paymentApplyPayload([row("A", { amount: "10", takeDiscount: "true", discountAmount: "2.50", writeOffAmount: " 1 ", writeOffReason: " r " })], open))
      .toEqual({ ok: true, lines: [
        { invoiceId: "A", type: "PAYMENT", amount: "10" },
        { invoiceId: "A", type: "DISCOUNT", amount: "2.5" },
        { invoiceId: "A", type: "WRITE_OFF", amount: "1", reason: "r" },
      ] });
  });
});
