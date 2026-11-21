// The four single money boxes outside the grids (#517 pull request 5a): an open item's Apply credit
// and Write off, New batch's Control total and a customer's Credit limit refuse a box by name before
// anything is sent. Each case runs the handler the component itself declares (helpers/lift-callback).
import { describe, expect, it, vi } from "vitest";
import { decimalRefusal } from "../src/lib/decimal-entry";
import { AMOUNT_TO_APPLY, AMOUNT_TO_WRITE_OFF, CONTROL_TOTAL, CREDIT_LIMIT } from "../src/lib/money-boxes";
import { callback } from "./helpers/lift-callback";

const SECTION = "app/customers/[id]/ReceivablesSection.tsx";
const body = (api: ReturnType<typeof vi.fn>) => JSON.parse((api.mock.calls[0] as unknown as [string, { body: string }])[1].body);

describe("OpenItemRow: Apply credit and Write off", () => {
  async function submit(name: "submit" | "submitWriteOff", amount: string) {
    const api = vi.fn(async () => ({})); const inFlight = { current: false };
    const setApplyError = vi.fn(); const setSaving = vi.fn();
    await callback<() => Promise<void>>(SECTION, "OpenItemRow", name, {
      inFlight, api, setApplyError, setSaving, setOpen: vi.fn(), setWriteOffOpen: vi.fn(), onApplied: vi.fn(),
      item: { id: "inv-1" }, invoiceId: "inv-2", amount, writeOffAmount: amount, writeOffReason: "bad debt",
      decimalRefusal, AMOUNT_TO_APPLY, AMOUNT_TO_WRITE_OFF,
    })();
    return { api, inFlight, setApplyError, setSaving };
  }
  it("a blank Amount to apply is refused by name, the form stays open and nothing is taken or sent", async () => {
    const r = await submit("submit", "");
    expect(r.setApplyError.mock.calls).toEqual([["Amount to apply: must be greater than zero."]]);
    expect(r.api).not.toHaveBeenCalled(); expect(r.inFlight.current).toBe(false); expect(r.setSaving).not.toHaveBeenCalled();
  });
  it("too many digits after the point is refused by name", async () => {
    const r = await submit("submit", "1.234");
    expect(r.setApplyError.mock.calls).toEqual([["Amount to apply: use at most 2 digits after the point."]]);
    expect(r.api).not.toHaveBeenCalled();
  });
  it("a fitting amount goes as its trimmed text", async () => {
    const r = await submit("submit", " .36 ");
    expect(body(r.api)).toEqual({ creditInvoiceId: "inv-1", invoiceId: "inv-2", amount: ".36" });
    expect(r.inFlight.current).toBe(false);
  });
  it("a negative Amount to write off is refused by name", async () => {
    const r = await submit("submitWriteOff", "-5");
    expect(r.setApplyError.mock.calls).toEqual([["Amount to write off: must be greater than zero."]]);
    expect(r.api).not.toHaveBeenCalled(); expect(r.inFlight.current).toBe(false);
  });
  it("a fitting write-off goes as its trimmed text", async () => {
    const r = await submit("submitWriteOff", " 12.50 ");
    expect(body(r.api)).toEqual({ invoiceId: "inv-1", amount: "12.50", reason: "bad debt" });
  });
  it("a save already in flight returns before the check", async () => {
    const api = vi.fn(); const setApplyError = vi.fn();
    await callback<() => Promise<void>>(SECTION, "OpenItemRow", "submit", {
      inFlight: { current: true }, api, setApplyError, amount: "", decimalRefusal, AMOUNT_TO_APPLY,
    })();
    expect(setApplyError).not.toHaveBeenCalled(); expect(api).not.toHaveBeenCalled();
  });
});

describe("ReceivablesList createBatch", () => {
  async function create(depositDate: string, controlTotal: string) {
    const api = vi.fn(async () => ({ id: "b1" })); const setCreateError = vi.fn(); const setCreating = vi.fn(); const push = vi.fn();
    await callback<() => Promise<void>>("app/receivables/ReceivablesList.tsx", "ReceivablesList", "createBatch", {
      depositDate, controlTotal, api, setCreateError, setCreating, router: { push }, decimalRefusal, CONTROL_TOTAL,
    })();
    return { api, setCreateError, setCreating, push };
  }
  it("a missing date and a refused control total are listed together, one per line, and nothing is sent", async () => {
    const r = await create("", "$5");
    expect(r.setCreateError.mock.calls).toEqual([["Deposit date is required.\nControl total: enter a number without $ or commas, such as 0.36."]]);
    expect(r.api).not.toHaveBeenCalled(); expect(r.setCreating).not.toHaveBeenCalled();
  });
  it("a missing date alone reads as before", async () => {
    const r = await create("", "");
    expect(r.setCreateError.mock.calls).toEqual([["Deposit date is required."]]);
  });
  it("a refused control total alone is named", async () => {
    const r = await create("2026-10-14", "1.234");
    expect(r.setCreateError.mock.calls).toEqual([["Control total: use at most 2 digits after the point."]]);
    expect(r.api).not.toHaveBeenCalled();
  });
  it("a negative control total is a figure, and goes as typed", async () => {
    const r = await create("2026-10-14", "-12.5");
    expect(body(r.api)).toEqual({ depositDate: "2026-10-14", controlTotal: "-12.5" });
    expect(r.push).toHaveBeenCalledWith("/receivables/batches/b1");
  });
  it("a blank control total goes as null", async () => {
    const r = await create("2026-10-14", "  ");
    expect(body(r.api)).toEqual({ depositDate: "2026-10-14", controlTotal: null });
  });
});

describe("customer page commitCreditLimit", () => {
  function commit(v: string, atFocus: string) {
    const save = vi.fn(); const setC = vi.fn(); const setError = vi.fn();
    callback<(v: string, atFocus: string) => void>("app/customers/[id]/page.tsx", "CustomerDetail", "commitCreditLimit", {
      save, setC, setError, decimalRefusal, CREDIT_LIMIT,
    })(v, atFocus);
    return { save, setC, setError };
  }
  it("a refused figure goes back to what the box held, names the box, and saves nothing", () => {
    const r = commit("1.234", "500");
    expect(r.save).not.toHaveBeenCalled();
    expect(r.setError.mock.calls).toEqual([["Credit limit: use at most 2 digits after the point."]]);
    const updater = r.setC.mock.calls[0][0] as (cur: Record<string, unknown> | null) => Record<string, unknown> | null;
    expect(updater({ name: "x", creditLimit: "1.234" })).toEqual({ name: "x", creditLimit: "500" });
    expect(updater(null)).toBeNull();
  });
  it("a box that held nothing goes back to an empty box", () => {
    const r = commit("abc", "");
    const updater = r.setC.mock.calls[0][0] as (cur: Record<string, unknown>) => Record<string, unknown>;
    expect(updater({ creditLimit: "abc" })).toEqual({ creditLimit: "" });
  });
  it("a blank clears the limit", () => {
    const r = commit("", "500");
    expect(r.save.mock.calls).toEqual([[{ creditLimit: null }]]);
    expect(r.setC).not.toHaveBeenCalled(); expect(r.setError).not.toHaveBeenCalled();
  });
  it("spaces alone clear the limit too", () => {
    expect(commit("   ", "500").save.mock.calls).toEqual([[{ creditLimit: null }]]);
  });
  it("a negative figure is a figure, and goes as typed", () => {
    const r = commit("-250", "500");
    expect(r.save.mock.calls).toEqual([[{ creditLimit: "-250" }]]);
    expect(r.setError).not.toHaveBeenCalled();
  });
});
