import { describe, it, expect } from "vitest";
import { percentToDecimal, decimalToPercentText } from "@/lib/surcharge-percent";

describe("surcharge percent <-> decimal conversion", () => {
  // The brief's own literal example: "4 on screen stores 0.040000."
  it("converts the brief's literal example both ways", () => {
    expect(percentToDecimal("4")).toBe("0.04");
    expect(decimalToPercentText(0.04)).toBe("4");
  });

  it("round-trips a representative set of percents through decimal and back, save-reload-save style", () => {
    for (const percent of ["4", "2.5", "0.25", "100", "0.0001", "12.3456", "0"]) {
      const decimal = percentToDecimal(percent);
      const displayed = decimalToPercentText(Number(decimal));
      // Re-converting the displayed text must land on the exact same decimal — this is the
      // "save, reload, save again" check the brief calls out: a bug that double-converts (or
      // drifts on floating-point) would show up as displayed !== percent or a second decimal
      // that no longer matches the first.
      expect(displayed).toBe(percent);
      expect(percentToDecimal(displayed)).toBe(decimal);
    }
  });

  it("handles empty input as null and unparseable input as typed, not NaN or a thrown error", () => {
    expect(percentToDecimal("")).toBeNull();
    expect(percentToDecimal("   ")).toBeNull();
    expect(percentToDecimal("not-a-number")).toBe("not-a-number");
    expect(decimalToPercentText(null)).toBe("");
  });

  it("shifts the typed percent exactly, and never through Number()", () => {
    expect(percentToDecimal("4")).toBe("0.04");
    expect(percentToDecimal(".36")).toBe("0.0036");
    expect(percentToDecimal("4.12345")).toBe("0.0412345"); // refused by the server, not rounded
  });
  it("passes text that is no figure through, for the server to refuse", () => {
    expect(percentToDecimal("4%")).toBe("4%");
    expect(percentToDecimal("1e2")).toBe("1e2");
    expect(percentToDecimal("+4")).toBe("+4");
  });
  it("keeps a blank box as no rate", () => {
    expect(percentToDecimal("")).toBeNull();
    expect(percentToDecimal("   ")).toBeNull();
  });
});
