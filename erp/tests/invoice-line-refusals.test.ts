import { describe, expect, it } from "vitest";
import { invoiceLineRefusals } from "../src/lib/invoice-line-refusals";

const row = (kind: string, over: Partial<{ qty: string; weight: string; amount: string }> = {}) =>
  ({ kind, qty: "", weight: "", amount: "1", ...over });

describe("invoiceLineRefusals", () => {
  it("names a refused box by its table and its row in that table, and lists every refusal", () => {
    expect(invoiceLineRefusals([
      row("OPERATION", { weight: "1.234", amount: "5" }),
      row("CHARGE", { amount: "" }),
      row("OPERATION", { qty: "1.5", weight: "", amount: "1e2" }),
      row("TAX", { amount: "-3" }),
    ])).toEqual([
      "Part / operation line 1, Net weight (lb): use at most 2 digits after the point.",
      "Part / operation line 2: quantity must be a whole number.",
      "Part / operation line 2, Amount: enter a number without $ or commas, such as 0.36.",
      "Surcharges line 1, Amount: enter a number without $ or commas, such as 0.36.",
    ]);
  });
  it("a PART row's amount past the box says its limits", () => {
    expect(invoiceLineRefusals([row("PART", { amount: "12345678901" })]))
      .toEqual(["Part / operation line 1, Amount: must be between -10,000,000,000 and 10,000,000,000."]);
  });
  it("clean rows are no refusal", () => {
    expect(invoiceLineRefusals([
      row("PART", { amount: ".36" }), row("OPERATION", { amount: "36." }), row("CHARGE", { amount: "-0.5" }),
      row("TAX", { weight: "", qty: "", amount: "0" }), row("PART", { qty: " 7 ", amount: "1" }),
    ])).toEqual([]);
  });
});
