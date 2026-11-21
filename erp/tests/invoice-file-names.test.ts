import { describe, expect, it } from "vitest";
import { invoiceFileName } from "@/lib/invoice-file-names";

// #588 and #591 (owner rulings 2026-10-20): a printed invoice is named `Invoice-<order#>.pdf` and a
// credit memo `Credit-<credit#>.pdf`, the bare number, capitalised. The leaf is shared byte for byte
// with #588's lane; only this lane carries its test.

describe("invoiceFileName", () => {
  it("names an invoice by its order number", () => {
    expect(invoiceFileName("INVOICE", 1001)).toBe("Invoice-1001.pdf");
    expect(invoiceFileName("INVOICE", "1001")).toBe("Invoice-1001.pdf");
  });

  it("names a credit memo by its credit number", () => {
    expect(invoiceFileName("CREDIT", 1000)).toBe("Credit-1000.pdf");
    expect(invoiceFileName("CREDIT", "1000")).toBe("Credit-1000.pdf");
  });
});
