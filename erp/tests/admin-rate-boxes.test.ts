// Accounting's three rate and amount boxes and the Surcharges screen's Rate, Amount and Minimum amount
// boxes and its Add row (#517 pull request 5b): each checks its box through the one rule before it
// sends, names a refused box by its bare label, goes back to the stored figure (a blur box) or keeps
// the draft (the Add row), and sends nothing. Each case runs the function the component itself
// declares (helpers/lift-callback).
import { describe, expect, it, vi } from "vitest";
import { decimalRefusal } from "../src/lib/decimal-entry";
import {
  CERT_CHARGE_DEFAULT, PLANT_FINANCE_CHARGE, PLANT_SALES_TAX_RATE,
  SURCHARGE_AMOUNT, SURCHARGE_MINIMUM_AMOUNT, SURCHARGE_RATE,
} from "../src/lib/rate-boxes";
import { fractionFromPercent } from "../src/lib/rate-display";
import { percentToDecimal } from "../src/lib/surcharge-percent";
import { callback } from "./helpers/lift-callback";
import { oneShotHold } from "../src/lib/single-flight";

const BILLING = "app/admin/billing/page.tsx";
const SURCHARGES = "app/admin/surcharges/page.tsx";

type Updater<T> = (cur: T) => T;

describe("Accounting commitBillingDecimal", () => {
  function commit(key: string, value: string, atFocus: string) {
    const save = vi.fn(); const setCfg = vi.fn(); const setError = vi.fn();
    const result = callback<(key: string, value: string, atFocus: string) => void | false>(BILLING, "BillingPage", "commitBillingDecimal", {
      save, setCfg, setError, decimalRefusal, fractionFromPercent,
      PLANT_SALES_TAX_RATE, CERT_CHARGE_DEFAULT, PLANT_FINANCE_CHARGE,
    })(key, value, atFocus);
    return { save, setCfg, setError, result };
  }
  it("a sales tax rate with too many digits goes back to what the box held, names the box and saves nothing", () => {
    const r = commit("salesTaxRate", "7.12345", "4");
    expect(r.save).not.toHaveBeenCalled();
    // R7: the box is back on a value it was given, so the guard keeps its session.
    expect(r.result).toBe(false);
    expect(r.setError.mock.calls).toEqual([["Plant sales tax rate (%): use at most 4 digits after the point."]]);
    const updater = r.setCfg.mock.calls[0][0] as Updater<Record<string, unknown> | null>;
    expect(updater({ salesTaxRate: "7.12345", certChargeDefault: "1" })).toEqual({ salesTaxRate: "4", certChargeDefault: "1" });
    expect(updater(null)).toBeNull();
  });
  it("a certification charge with a $ is refused by name", () => {
    const r = commit("certChargeDefault", "$5", "10");
    expect(r.save).not.toHaveBeenCalled();
    expect(r.result).toBe(false);
    expect(r.setError.mock.calls).toEqual([["Certification charge ($): enter a number without $ or commas, such as 0.36."]]);
    const updater = r.setCfg.mock.calls[0][0] as Updater<Record<string, unknown>>;
    expect(updater({ certChargeDefault: "$5" })).toEqual({ certChargeDefault: "10" });
  });
  it("a finance charge that fits is sent as typed", () => {
    const r = commit("financeChargeRate", "1.5", "");
    expect(r.save.mock.calls).toEqual([[{ financeChargeRate: "1.5" }, "1.5", true]]);
    expect(r.setCfg).not.toHaveBeenCalled(); expect(r.setError).not.toHaveBeenCalled();
    expect(r.result).toBeUndefined();
  });
  it("a sales tax percent that fits is sent as its fraction", () => {
    expect(commit("salesTaxRate", "7.25", "").save.mock.calls).toEqual([[{ salesTaxRate: "0.0725" }, "7.25", true]]);
  });
  it("a blank is no refusal and saves none", () => {
    const r = commit("financeChargeRate", "", "1.5");
    expect(r.save.mock.calls).toEqual([[{ financeChargeRate: null }, "", true]]);
    expect(r.setError).not.toHaveBeenCalled();
    expect(commit("salesTaxRate", "  ", "4").save.mock.calls).toEqual([[{ salesTaxRate: null }, "  ", true]]);
  });
  it("a finance charge or amount of spaces only saves none, never the spaces", () => {
    const r = commit("financeChargeRate", "  ", "1.5");
    expect(r.save.mock.calls).toEqual([[{ financeChargeRate: null }, "  ", true]]);
    expect(r.setError).not.toHaveBeenCalled();
    expect(commit("certChargeDefault", "   ", "10").save.mock.calls).toEqual([[{ certChargeDefault: null }, "   ", true]]);
  });
});

describe("Surcharges commitSurchargeBox", () => {
  const rows = [{ id: "s1", kind: "PERCENT" }];
  function lift() {
    const save = vi.fn(() => Promise.resolve(true)); const setError = vi.fn();
    const setTextDrafts = vi.fn(); const setKindDraft = vi.fn();
    const savedMarks = { mark: vi.fn() }; const dropSettledDraft = vi.fn();
    const saveBox = callback<(key: string, saved: Promise<boolean>, shown: string, decimal?: boolean) => Promise<string | false>>(
      SURCHARGES, "SurchargesPage", "saveBox", { savedMarks });
    const commit = callback<(id: string, field: string, value: string) => false | Promise<string | false>>(SURCHARGES, "SurchargesPage", "commitSurchargeBox", {
      save, setError, setTextDrafts, setKindDraft, dropSettledDraft, rows,
      // No save of the box is out, so a refusal drops its draft.
      putBack: (key: string) => setTextDrafts((d: Record<string, string>) => { const n = { ...d }; delete n[key]; return n; }), kindValue: (r: { kind: string }) => r.kind, saveBox,
      decimalRefusal, percentToDecimal, SURCHARGE_RATE, SURCHARGE_AMOUNT, SURCHARGE_MINIMUM_AMOUNT,
    });
    return { commit, save, setError, setTextDrafts, setKindDraft, dropSettledDraft, savedMarks };
  }
  it("a rate of 123456 is refused by name, both drafts are cleared and nothing is saved", () => {
    const r = lift();
    // false: the box is back on its stored figure and nothing was sent, so an Enter keeps the
    // box's record of its text at focus (R7).
    expect(r.commit("s1", "rate", "123456")).toBe(false);
    expect(r.setError.mock.calls).toEqual([["Rate (%): must be less than 100,000."]]);
    expect(r.save).not.toHaveBeenCalled();
    const text = r.setTextDrafts.mock.calls[0][0] as Updater<Record<string, string>>;
    expect(text({ "s1.rate": "123456", "s1.amount": "2" })).toEqual({ "s1.amount": "2" });
    const kind = r.setKindDraft.mock.calls[0][0] as Updater<Record<string, string>>;
    expect(kind({ s1: "PERCENT", s2: "FLAT" })).toEqual({ s2: "FLAT" });
  });
  it("a negative minimum amount is refused by name and clears only its text draft", () => {
    const r = lift();
    expect(r.commit("s1", "minimumAmount", "-1")).toBe(false);
    expect(r.setError.mock.calls).toEqual([["Minimum amount ($): cannot be negative."]]);
    expect(r.save).not.toHaveBeenCalled();
    expect(r.setKindDraft).not.toHaveBeenCalled();
    const text = r.setTextDrafts.mock.calls[0][0] as Updater<Record<string, string>>;
    expect(text({ "s1.minimumAmount": "-1" })).toEqual({});
  });
  it("an amount with too many digits is refused by name", () => {
    const r = lift();
    expect(r.commit("s1", "amount", "1.234")).toBe(false);
    expect(r.setError.mock.calls).toEqual([["Amount ($): use at most 2 digits after the point."]]);
    expect(r.save).not.toHaveBeenCalled();
  });
  it("figures that fit are saved as today, with the drafts cleared once the save settles", async () => {
    const r = lift();
    r.commit("s1", "rate", "4");
    r.commit("s1", "amount", "12.50");
    r.commit("s1", "amount", " ");
    r.commit("s1", "minimumAmount", "");
    expect(r.save.mock.calls).toEqual([
      ["s1", { kind: "PERCENT", rate: "0.04" }],
      ["s1", { kind: "PERCENT", amount: "12.50" }],
      ["s1", { kind: "PERCENT", amount: null }],
      ["s1", { minimumAmount: null }],
    ]);
    expect(r.setError).not.toHaveBeenCalled();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    // Each box's draft goes once its save settles, only while it still holds the sent text.
    // The box's draft is the newest save's to drop, through the page's leaveSave or enterSave
    // (tests/enter-non-guard-commits.test.ts), never the commit's.
    expect(r.dropSettledDraft).not.toHaveBeenCalled();
    expect(r.setTextDrafts).not.toHaveBeenCalled();
    expect(r.setKindDraft).toHaveBeenCalledTimes(3);
  });
  it("a save that lands answers the typed text and marks the box Saved; one that does not answers false and marks nothing", async () => {
    const r = lift();
    await expect(r.commit("s1", "rate", "4")).resolves.toBe("4");
    expect(r.savedMarks.mark.mock.calls).toEqual([["s1.rate", "4", { decimal: true }]]);
    r.save.mockImplementationOnce(() => Promise.resolve(false));
    await expect(r.commit("s1", "amount", "12.50")).resolves.toBe(false);
    expect(r.savedMarks.mark).toHaveBeenCalledTimes(1);
  });
});

describe("Surcharges add", () => {
  function lift(draft: { name: string; kind: string; valueText: string }, answer: () => Promise<unknown> = () => Promise.resolve({})) {
    const api = vi.fn(answer); const setError = vi.fn(); const setDraft = vi.fn();
    const load = vi.fn(() => Promise.resolve());
    const add = callback<() => Promise<void>>(SURCHARGES, "SurchargesPage", "add", {
      rows: [], draft, api, setError, setDraft, load, addHold: oneShotHold(),
      decimalRefusal, percentToDecimal, SURCHARGE_RATE, SURCHARGE_AMOUNT,
    });
    return { add, api, setError, setDraft };
  }
  it("a flat amount with too many digits is refused by name, the draft stays and nothing is posted", async () => {
    const r = lift({ name: "Fuel", kind: "FLAT", valueText: "1.234" });
    await r.add();
    expect(r.setError.mock.calls).toEqual([["Amount ($): use at most 2 digits after the point."]]);
    expect(r.api).not.toHaveBeenCalled();
    expect(r.setDraft).not.toHaveBeenCalled();
  });
  it("a percent that is no number is refused as Rate (%)", async () => {
    const r = lift({ name: "Fuel", kind: "PERCENT", valueText: "4%" });
    await r.add();
    expect(r.setError.mock.calls).toEqual([["Rate (%): enter a number without % or commas, such as 7.25."]]);
    expect(r.api).not.toHaveBeenCalled();
  });
  it("a figure that fits is posted as today, and a blank is left to the server", async () => {
    const r = lift({ name: "Fuel", kind: "PERCENT", valueText: "4" });
    await r.add();
    const sent = (r.api.mock.calls[0] as unknown[])[1] as { body: string };
    expect(JSON.parse(sent.body).rate).toBe("0.04");
    const b = lift({ name: "Fuel", kind: "FLAT", valueText: "" });
    await b.add();
    expect(b.setError.mock.calls).toEqual([[null]]); // the success path's clear, not a refusal
    expect(b.api).toHaveBeenCalledTimes(1);
  });
  it("a second Add while the POST is out sends nothing (#720)", async () => {
    let land!: () => void;
    const r = lift({ name: "Fuel", kind: "PERCENT", valueText: "4" }, () => new Promise((resolve) => { land = () => resolve({}); }));
    const first = r.add(); await r.add();
    expect(r.api).toHaveBeenCalledTimes(1);
    land(); await first;
  });
});
