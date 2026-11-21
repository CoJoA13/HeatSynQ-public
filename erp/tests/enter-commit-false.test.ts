// Owner ruling R7 (P8 step 4): a blur-save commit that puts a refused figure back answers `false`,
// which tells the edit guard's Enter commit the box again shows a value it was given, so the blur
// after a refused Enter sends nothing. A commit that sends answers nothing, or the text the box now
// shows where that differs from what was typed ("2" for "002"). Each case runs the
// function the component itself declares (helpers/lift-callback). Accounting's three are in
// admin-rate-boxes.test.ts.
import { describe, expect, it, vi } from "vitest";
import { decimalRefusal } from "../src/lib/decimal-entry";
import { CREDIT_LIMIT } from "../src/lib/money-boxes";
import { FINANCE_CHARGE, SALES_TAX_RATE } from "../src/lib/rate-boxes";
import { fractionFromPercent } from "../src/lib/rate-display";
import { readWholeNumber, wholeNumberRefusal } from "../src/lib/whole-number-entry";
import { LOAD_QTY, REQUEST_DAYS_OVERRIDE } from "../src/lib/whole-number-boxes";
import { EACH_WEIGHT, LOAD_WEIGHT } from "../src/lib/part-boxes";
import { FREIGHT_AMOUNT } from "../src/lib/shipment-boxes";
import { rowBoxRefusal } from "../src/lib/pricing-refusals";
import { callback } from "./helpers/lift-callback";
import { sameSentValue } from "../src/lib/line-field-saves";

type Commit = (v: string, atFocus: string) => void | false;
const sent = () => vi.fn(async () => true);

describe("a commit that puts the box back answers false (R7)", () => {
  const customer = (name: string) => callback<Commit>("app/customers/[id]/page.tsx", "CustomerDetail", name, {
    save: sent(), setC: vi.fn(), setError: vi.fn(), decimalRefusal, CREDIT_LIMIT, FINANCE_CHARGE, SALES_TAX_RATE,
    fractionFromPercent, wholeNumberRefusal, readWholeNumber, REQUEST_DAYS_OVERRIDE,
  });
  it.each([
    ["commitCreditLimit", "1.234", "250"],
    ["commitFinanceCharge", "1.23456", "1.5"],
    ["commitSalesTaxRate", "7.12345", "4"],
    ["commitRequestDaysOverride", "1e2", "05"],
  ])("customer %s", (name, refused, fits) => {
    expect(customer(name)(refused, "")).toBe(false);
    expect(customer(name)(fits, "")).toBe(name === "commitRequestDaysOverride" ? "5" : undefined);
    expect(customer(name)("  ", "1")).toBe("");
  });

  const identity = (name: string) => callback<Commit>("app/parts/[id]/IdentitySection.tsx", "IdentitySection", name, {
    save: sent(), patchDraft: vi.fn(), onError: vi.fn(), decimalRefusal, EACH_WEIGHT, LOAD_WEIGHT,
    wholeNumberRefusal, readWholeNumber, LOAD_QTY, REQUEST_DAYS_OVERRIDE,
  });
  it.each([
    ["commitEachWeight", "1.23456", "2.5"],
    ["commitLoadWeight", "0", "100"],
    ["commitLoadQty", "0", "04"],
    ["commitRequestDaysOverride", "4000", "05"],
  ])("part Identity %s", (name, refused, fits) => {
    expect(identity(name)(refused, "")).toBe(false);
    expect(identity(name)(fits, "")).toBe(name === "commitLoadQty" ? "4" : name === "commitRequestDaysOverride" ? "5" : undefined);
  });

  it("the saved shipment's Freight amount and Package count", () => {
    const containerSumOf = (orders: { containers: { count: number }[] }[]) =>
      orders.reduce((sum, o) => sum + o.containers.reduce((n, c) => n + c.count, 0), 0);
    const env = { setShipper: vi.fn(), setError: vi.fn(), decimalRefusal, FREIGHT_AMOUNT, patchHeader: sent(),
      storedPackageCount: { current: 8 }, containerSumOf,
      shipper: { orders: [{ containers: [{ count: 2 }, { count: 1 }] }] } };
    const freight = callback<Commit>("app/shipping/[id]/ShipmentDetail.tsx", "ShipmentDetail", "commitFreightAmount", env);
    expect(freight("1.234", "5")).toBe(false);
    expect(freight(" 12.50 ", "5")).toBe("12.50");
    const count = callback<Commit>("app/shipping/[id]/ShipmentDetail.tsx", "ShipmentDetail", "commitPackageCount", env);
    expect(count("-1", "")).toBe(false);
    expect(count("03", "")).toBe("3");
    // A blank clears the override and the box shows the container sum, which the Enter session
    // learns, so leaving the box does not store the sum as an override (#811, Codex P2).
    expect(count("", "8")).toBe("3");
  });

  it("a part's Pricing row box", () => {
    const rows = [{ id: "p1", setupCharge: null, unitPrice: "1.00", minimumCharge: null, breaks: [] }];
    const commitRow = callback<(id: string, field: string, value: string, atFocus: string) => void | false>(
      "app/parts/[id]/PricingSection.tsx", "PricingSection", "commitRow", {
        rows, rowBoxRefusal, setRowField: vi.fn(), onError: vi.fn(), saveRow: sent(), setRows: vi.fn(),
        normalizePriceText: (t: string) => t, savedMarks: { mark: vi.fn(), shows: () => false }, sameSentValue,
      });
    expect(commitRow("p1", "unitPrice", "1.234567", "1.00")).toBe(false);
    expect(commitRow("p1", "unitPrice", "2.00", "1.00")).toBeUndefined();
    // The saved figure respelled is not a change (P8 risk 3): nothing is sent.
    const saveRow = vi.fn(async () => true);
    const again = callback<(id: string, field: string, value: string, atFocus: string) => void | false>(
      "app/parts/[id]/PricingSection.tsx", "PricingSection", "commitRow", {
        rows, rowBoxRefusal, setRowField: vi.fn(), onError: vi.fn(), saveRow, setRows: vi.fn(),
        normalizePriceText: (t: string) => t, savedMarks: { mark: vi.fn(), shows: () => false }, sameSentValue,
      });
    again("p1", "unitPrice", "0.55", "0.5500");
    expect(saveRow).not.toHaveBeenCalled();
  });

});
