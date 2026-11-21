import { describe, expect, it } from "vitest";
import { registerSummary, summaryLabel } from "@/lib/invoice-register-summary";

// #592 (owner rulings, 2026-10-20 and 2026-10-21): the Invoice register's summary row, on the Excel
// and the PDF alike: after a blank row, the count of exported rows in words under Document No and
// the sum of every row's Total under Total, a credit memo's negative total netting it. The leaf is
// pure, so each guard below is proven by changing it and watching its case go red.

describe("registerSummary", () => {
  it("sums in cents, so 0.10 and 0.20 total exactly 0.30", () => {
    // Summed as floats, 0.1 + 0.2 is 0.30000000000000004.
    expect(registerSummary([{ total: 0.1 }, { total: 0.2 }])).toEqual({ count: 2, total: 0.3 });
    expect(registerSummary([{ total: 0.1 }, { total: 0.2 }]).total).toBe(0.3);
  });

  it("nets a credit memo's negative total against the invoices, to zero and below", () => {
    expect(registerSummary([{ total: 1250 }, { total: -157.5 }])).toEqual({ count: 2, total: 1092.5 });
    // A credit that cancels its invoice nets to 0. These sums give +0 however they are added, so
    // the case that refuses -0 is the empty one below.
    expect(registerSummary([{ total: 100 }, { total: -100 }]).total).toBe(0);
    expect(registerSummary([{ total: -100 }, { total: 100 }]).total).toBe(0);
    expect(registerSummary([{ total: -40 }]).total).toBe(-40);
  });

  it("counts every row, a $0 row included", () => {
    expect(registerSummary([{ total: 0 }, { total: 0 }, { total: 12.34 }])).toEqual({ count: 3, total: 12.34 });
  });

  it("answers a count and a total of 0 for no rows", () => {
    // Both matchers tell -0 from 0, so a sum started at -0 answers -0 here and turns this red.
    expect(registerSummary([])).toEqual({ count: 0, total: 0 });
    expect(registerSummary([]).total).toBe(0);
  });
});

describe("summaryLabel", () => {
  it("says document for one row and documents for any other count, none included", () => {
    expect(summaryLabel(1)).toBe("Total of 1 document");
    expect(summaryLabel(12)).toBe("Total of 12 documents");
    expect(summaryLabel(0)).toBe("Total of 0 documents");
  });
});
