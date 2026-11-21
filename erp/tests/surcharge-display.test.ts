import { describe, expect, it } from "vitest";
import { plantDefaultNoun, surchargeRateText } from "@/lib/surcharge-display";

/**
 * #239 P3a / C10 — the two things a surcharge's KIND changes on screen.
 *
 * A surcharge is either a PERCENT rate or a FLAT dollar amount, and the prose around the
 * per-customer overrides was written for the percent case only. The demonstration dataset's own
 * "Expedite Fee" is FLAT $75.00 (`prisma/manual-seed.ts`), so the customer page promised an
 * operator that clearing its override would bill "at the plant rate" — a rate that surcharge does
 * not have and cannot be given. The inputs beside those sentences already branched; the words did
 * not.
 *
 * Both helpers have two callers apiece and one caller each is a `confirm()` string, which no test
 * can reach inside a client component — which is why the decision lives in a leaf.
 */

describe("plantDefaultNoun — what the plant-level value is called (P3a)", () => {
  it("a percent surcharge has a plant RATE", () => {
    expect(plantDefaultNoun("PERCENT")).toBe("plant rate");
  });

  it("a flat surcharge has a plant AMOUNT — the sentence that was wrong", () => {
    expect(plantDefaultNoun("FLAT")).toBe("plant amount");
  });

  it("agrees with the override inputs' own placeholders, so a box and its sentence use one word", () => {
    // SurchargeOverridesSection renders `placeholder="plant rate"` on the PERCENT branch and
    // `placeholder="plant amount"` on the FLAT one. Asserted as literals here on purpose: a
    // shared constant would make the two agree by construction and prove nothing about what
    // ships.
    expect([plantDefaultNoun("PERCENT"), plantDefaultNoun("FLAT")])
      .toEqual(["plant rate", "plant amount"]);
  });
});

describe("surchargeRateText — a surcharge's configured value, formatted per kind (C10)", () => {
  it("shows a percent the way the admin screen types it, not the decimal it stores", () => {
    // Surcharge.rate is Decimal(9,6): 3.5% is stored 0.035000.
    expect(surchargeRateText({ kind: "PERCENT", rate: 0.035, amount: null })).toBe("3.5%");
    expect(surchargeRateText({ kind: "PERCENT", rate: 0.04, amount: null })).toBe("4%");
  });

  it("shows a flat amount as money, with the cents a stored 75.00 actually carries", () => {
    expect(surchargeRateText({ kind: "FLAT", rate: null, amount: 75 })).toBe("$75.00");
    expect(surchargeRateText({ kind: "FLAT", rate: null, amount: 2.5 })).toBe("$2.50");
  });

  it("reads the field its own kind uses, never the other one", () => {
    // buildSurchargeBody nulls the pair the current kind does not use, but a row mid-flip can
    // carry both — and reading the wrong one would print a rate as dollars or an amount as a
    // percent, which is worse than printing nothing.
    expect(surchargeRateText({ kind: "PERCENT", rate: 0.02, amount: 999 })).toBe("2%");
    expect(surchargeRateText({ kind: "FLAT", rate: 0.02, amount: 999 })).toBe("$999.00");
  });

  it("says a value is unset rather than rendering an empty gap", () => {
    expect(surchargeRateText({ kind: "PERCENT", rate: null, amount: null })).toBe("no rate set");
    expect(surchargeRateText({ kind: "FLAT", rate: null, amount: null })).toBe("no amount set");
  });

  it("keeps a zero, which is a configured value and not a missing one", () => {
    expect(surchargeRateText({ kind: "PERCENT", rate: 0, amount: null })).toBe("0%");
    expect(surchargeRateText({ kind: "FLAT", rate: null, amount: 0 })).toBe("$0.00");
  });
});
