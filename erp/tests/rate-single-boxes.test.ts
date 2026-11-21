// The customer page's Finance charge and Sales tax rate, and its surcharge override rows (#517 pull
// request 5b): each checks its box through the one rule on blur, names a refused box, goes back to
// the stored figure and sends nothing. Each case runs the handler the component itself declares
// (helpers/lift-callback).
import { describe, expect, it, vi } from "vitest";
import { decimalRefusal } from "../src/lib/decimal-entry";
import { FINANCE_CHARGE, SALES_TAX_RATE, SURCHARGE_AMOUNT_OVERRIDE, SURCHARGE_RATE_OVERRIDE } from "../src/lib/rate-boxes";
import { fractionFromPercent } from "../src/lib/rate-display";
import { percentToDecimal } from "../src/lib/surcharge-percent";
import { callback } from "./helpers/lift-callback";

const PAGE = "app/customers/[id]/page.tsx";
const SECTION = "app/customers/[id]/SurchargeOverridesSection.tsx";

type Updater = (cur: Record<string, unknown> | null) => Record<string, unknown> | null;

describe("customer page commitSalesTaxRate", () => {
  function commit(v: string, atFocus: string) {
    const save = vi.fn(); const setC = vi.fn(); const setError = vi.fn();
    callback<(v: string, atFocus: string) => void>(PAGE, "CustomerDetail", "commitSalesTaxRate", {
      save, setC, setError, decimalRefusal, SALES_TAX_RATE, fractionFromPercent,
    })(v, atFocus);
    return { save, setC, setError };
  }
  it("too many digits after the point goes back to what the box held, names the box, and saves nothing", () => {
    const r = commit("7.12345", "4");
    expect(r.save).not.toHaveBeenCalled();
    expect(r.setError.mock.calls).toEqual([["Sales tax rate (%): use at most 4 digits after the point."]]);
    const updater = r.setC.mock.calls[0][0] as Updater;
    expect(updater({ name: "x", salesTaxRate: "7.12345" })).toEqual({ name: "x", salesTaxRate: "4" });
    expect(updater(null)).toBeNull();
  });
  it("a percent that fits is sent as its fraction, with the typed text shown", () => {
    const r = commit("7.25", "4");
    expect(r.save.mock.calls).toEqual([[{ salesTaxRate: "0.0725" }, { salesTaxRate: "7.25" }]]);
    expect(r.setC).not.toHaveBeenCalled(); expect(r.setError).not.toHaveBeenCalled();
  });
  it("trailing zeros past the point are no refusal and drop from the fraction", () => {
    expect(commit("7.12340", "4").save.mock.calls[0][0]).toEqual({ salesTaxRate: "0.071234" });
  });
  it("a blank saves none, and the plant rate applies", () => {
    const r = commit("", "4");
    expect(r.save.mock.calls).toEqual([[{ salesTaxRate: null }, { salesTaxRate: null }]]);
    expect(r.setError).not.toHaveBeenCalled();
  });
  it("spaces alone save none too", () => {
    expect(commit("  ", "4").save.mock.calls[0][0]).toEqual({ salesTaxRate: null });
  });
});

describe("customer page commitFinanceCharge", () => {
  function commit(v: string, atFocus: string) {
    const save = vi.fn(); const setC = vi.fn(); const setError = vi.fn();
    callback<(v: string, atFocus: string) => void>(PAGE, "CustomerDetail", "commitFinanceCharge", {
      save, setC, setError, decimalRefusal, FINANCE_CHARGE,
    })(v, atFocus);
    return { save, setC, setError };
  }
  it("a figure that is no number goes back, names the box and saves nothing", () => {
    const r = commit("1,5", "1.5");
    expect(r.save).not.toHaveBeenCalled();
    expect(r.setError.mock.calls).toEqual([["Finance charge (monthly %): enter a number without % or commas, such as 7.25."]]);
    const updater = r.setC.mock.calls[0][0] as Updater;
    expect(updater({ financeChargeRate: "1,5" })).toEqual({ financeChargeRate: "1.5" });
  });
  it("too many digits after the point is refused by name", () => {
    expect(commit("1.23456", "1.5").setError.mock.calls).toEqual([["Finance charge (monthly %): use at most 4 digits after the point."]]);
  });
  it("a figure that fits goes as typed", () => {
    const r = commit("1.5000", "1");
    expect(r.save.mock.calls).toEqual([[{ financeChargeRate: "1.5000" }]]);
    expect(r.setError).not.toHaveBeenCalled();
  });
  it("a blank saves none", () => {
    expect(commit("", "1.5").save.mock.calls).toEqual([[{ financeChargeRate: null }]]);
  });
});

describe("SurchargeOverridesSection override boxes", () => {
  const row = { surchargeId: "s1", surchargeName: "Heat treat" };
  function lift(name: "commitRateOverride" | "commitAmountOverride") {
    const save = vi.fn(() => Promise.resolve(true)); const clearDraft = vi.fn(); const onError = vi.fn();
    const dropSettledDraft = vi.fn();
    const savedMarks = { mark: vi.fn() };
    const saveBox = callback<(key: string, saved: Promise<boolean>, shown: string) => Promise<string | false>>(
      SECTION, "SurchargeOverridesSection", "saveBox", { savedMarks });
    const commit = callback<(row: unknown, value: string) => false | Promise<string | false>>(SECTION, "SurchargeOverridesSection", name, {
      save, clearDraft, dropSettledDraft, onError, decimalRefusal, percentToDecimal, saveBox,
      // No save of the box is out, so a refusal drops its draft.
      putBack: clearDraft,
      SURCHARGE_RATE_OVERRIDE, SURCHARGE_AMOUNT_OVERRIDE,
    });
    return { commit, save, clearDraft, dropSettledDraft, onError, savedMarks };
  }
  it("a negative rate override is refused by name, the draft is cleared and nothing is saved", async () => {
    const r = lift("commitRateOverride");
    // false: the box is back on its stored figure and nothing was sent (R7).
    expect(r.commit(row, "-1")).toBe(false);
    expect(r.onError.mock.calls).toEqual([["Heat treat, Rate override (%): cannot be negative."]]);
    expect(r.clearDraft.mock.calls).toEqual([["s1.rate"]]);
    expect(r.save).not.toHaveBeenCalled();
  });
  it("a rate override that fits is saved as its fraction and the draft is cleared once it lands", async () => {
    const r = lift("commitRateOverride");
    await r.commit(row, "4");
    expect(r.save.mock.calls).toEqual([["s1", { rate: "0.04" }]]);
    // The box's draft is the newest save's to drop, through the section's leaveSave or enterSave
    // (tests/enter-non-guard-commits.test.ts), never the commit's.
    expect(r.dropSettledDraft).not.toHaveBeenCalled();
    expect(r.clearDraft).not.toHaveBeenCalled();
    expect(r.onError).not.toHaveBeenCalled();
  });
  it("a blank rate override still clears the rate", async () => {
    const r = lift("commitRateOverride");
    await r.commit(row, "  ");
    expect(r.save.mock.calls).toEqual([["s1", { rate: null }]]);
    expect(r.onError).not.toHaveBeenCalled();
  });
  it("an amount override with too many digits after the point is refused by name", async () => {
    const r = lift("commitAmountOverride");
    expect(r.commit(row, "1.234")).toBe(false);
    expect(r.onError.mock.calls).toEqual([["Heat treat, Amount override ($): use at most 2 digits after the point."]]);
    expect(r.clearDraft.mock.calls).toEqual([["s1.amount"]]);
    expect(r.save).not.toHaveBeenCalled();
  });
  it("an amount override that fits goes as typed, a blank as none", async () => {
    const r = lift("commitAmountOverride");
    await r.commit(row, "12.50");
    expect(r.save.mock.calls).toEqual([["s1", { amount: "12.50" }]]);
    const b = lift("commitAmountOverride");
    await b.commit(row, "");
    expect(b.save.mock.calls).toEqual([["s1", { amount: null }]]);
  });
  it("a save that lands answers the typed text and marks the box Saved; one that does not answers false", async () => {
    const r = lift("commitRateOverride");
    await expect(r.commit(row, "4")).resolves.toBe("4");
    expect(r.savedMarks.mark.mock.calls).toEqual([["s1.rate", "4", { decimal: true }]]);
    r.save.mockImplementationOnce(() => Promise.resolve(false));
    await expect(r.commit(row, "5")).resolves.toBe(false);
    expect(r.savedMarks.mark).toHaveBeenCalledTimes(1);
  });
});
