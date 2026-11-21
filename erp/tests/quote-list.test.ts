// The quotes list's leaf (spec 2026-10-30-ux-redesign-design.md §4.5; PR 3, owner 2026-10-31): the
// filter shape and query builder the page and its Export link share, and the three presets
// (Follow-up due / Expired / All quotes) derived from the Follow-up due box and the Status select,
// which are the worklist predicates verbatim (`followUpDue=1`, `expired=1`). Search, Customer and
// the date ranges narrow within a preset and keep it shown (the board's rule).
import { describe, expect, it } from "vitest";
import { DEFAULT_FILTERS, QUOTE_PRESETS, applyPreset, buildQuery, presetFor, sortForPreset } from "@/lib/quote-list";

describe("quote list presets", () => {
  it("names the three presets in order", () => {
    expect(QUOTE_PRESETS).toEqual([
      { key: "followUp", label: "Follow-up due" },
      { key: "expired", label: "Expired" },
      { key: "all", label: "All quotes" },
    ]);
  });

  it("applies each preset to the two controls it owns and keeps every other field", () => {
    const base = { ...DEFAULT_FILTERS, search: "x", customerId: "c1", quoteFrom: "2026-10-01", status: "OPEN" as const };
    expect(applyPreset(base, "followUp")).toEqual({ ...base, followUpDue: true, status: "" });
    expect(applyPreset({ ...base, followUpDue: true }, "expired")).toEqual({ ...base, followUpDue: false, status: "EXPIRED" });
    expect(applyPreset({ ...base, followUpDue: true }, "all")).toEqual({ ...base, followUpDue: false, status: "" });
  });

  it("names the preset the two controls equal", () => {
    expect(presetFor(DEFAULT_FILTERS)).toBe("all");
    expect(presetFor({ ...DEFAULT_FILTERS, followUpDue: true })).toBe("followUp");
    expect(presetFor({ ...DEFAULT_FILTERS, status: "EXPIRED" })).toBe("expired");
    expect(presetFor({ ...DEFAULT_FILTERS, status: "OPEN" })).toBeNull();
    expect(presetFor({ ...DEFAULT_FILTERS, status: "CLOSED" })).toBeNull();
    expect(presetFor({ ...DEFAULT_FILTERS, followUpDue: true, status: "EXPIRED" })).toBeNull();
  });

  it("round-trips every preset", () => {
    for (const { key } of QUOTE_PRESETS) expect(presetFor(applyPreset(DEFAULT_FILTERS, key))).toBe(key);
  });

  it("a search, customer or date edit keeps the preset; a status or follow-up edit clears it", () => {
    const due = applyPreset(DEFAULT_FILTERS, "followUp");
    expect(presetFor({ ...due, search: "x", customerId: "c1", expiryTo: "2026-12-31" })).toBe("followUp");
    expect(presetFor({ ...due, status: "OPEN" })).toBeNull();
    expect(presetFor({ ...due, followUpDue: false })).toBe("all");
  });

  it("orders a worklist view oldest debt first, as the worklist sections did (review finding 5)", () => {
    const rows = [
      { quoteNumber: 3, followUpDate: "2026-10-20", expiryDate: "2026-10-30" },
      { quoteNumber: 2, followUpDate: "2026-10-01", expiryDate: "2026-10-05" },
      { quoteNumber: 1, followUpDate: "2026-10-01", expiryDate: null },
      { quoteNumber: 4, followUpDate: null, expiryDate: "2026-09-01" },
    ];
    // Follow-up due: followUpDate ascending, the newer quote first on a tie, a null last.
    expect(sortForPreset(rows, "followUp").map((r) => r.quoteNumber)).toEqual([2, 1, 3, 4]);
    // Expired: expiryDate ascending, a null last.
    expect(sortForPreset(rows, "expired").map((r) => r.quoteNumber)).toEqual([4, 2, 3, 1]);
    // All quotes and no preset keep the server's order.
    expect(sortForPreset(rows, "all")).toBe(rows);
    expect(sortForPreset(rows, null)).toBe(rows);
    expect(rows.map((r) => r.quoteNumber)).toEqual([3, 2, 1, 4]); // never sorted in place
  });

  it("builds the worklist predicates as the server reads them", () => {
    expect(buildQuery(applyPreset(DEFAULT_FILTERS, "followUp"))).toBe("followUpDue=1");
    expect(buildQuery(applyPreset(DEFAULT_FILTERS, "expired"))).toBe("expired=1");
    expect(buildQuery(applyPreset(DEFAULT_FILTERS, "all"))).toBe("");
    expect(buildQuery({ ...DEFAULT_FILTERS, search: " acme ", status: "OPEN", customerId: "c1" })).toBe("search=acme&status=OPEN&customerId=c1");
  });
});
