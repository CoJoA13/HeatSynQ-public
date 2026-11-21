import { describe, expect, it } from "vitest";
import { invoiceLineRateText } from "@/lib/invoice-line-rate";

// #638 (R9): the invoice screen's Rate column, decided in one leaf.
describe("invoiceLineRateText", () => {
  it("shows a percent surcharge's stored fraction as a percent", () => {
    expect(invoiceLineRateText("SURCHARGE", 0.075)).toBe("7.5%");
    expect(invoiceLineRateText("SURCHARGE", "0.035")).toBe("3.5%");
    expect(invoiceLineRateText("SURCHARGE", 0.04)).toBe("4%");
  });

  it("shows the tax line's stored fraction as the header does", () => {
    expect(invoiceLineRateText("TAX", 0.0725)).toBe("7.25%");
    expect(invoiceLineRateText("TAX", "0.07")).toBe("7%");
  });

  it("shows the dash for a flat surcharge, a blank rate, and every other kind", () => {
    expect(invoiceLineRateText("SURCHARGE", null)).toBe("—");
    expect(invoiceLineRateText("TAX", "  ")).toBe("—");
    for (const kind of ["FREIGHT", "CHARGE", "CERT", "OPERATION", "PART"]) {
      expect(`${kind}: ${invoiceLineRateText(kind, 0.075)}`).toBe(`${kind}: —`);
    }
  });

  it("reads typed text through the decimal rule, never Number()", () => {
    // Number("1e-2") is 0.01; the decimal rule refuses an exponent, so the column shows the dash.
    expect(invoiceLineRateText("SURCHARGE", "1e-2")).toBe("—");
    expect(invoiceLineRateText("TAX", "0x10")).toBe("—");
  });
});
