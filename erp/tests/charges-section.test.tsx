// The saved order's Charges grid: what Save charges sends and how it refuses (decimal entry,
// orders). vitest has no DOM and fires no handler, so the section's own `save` is lifted out of its
// source by its name and run against the real leaves, the way containers-section.test.tsx runs
// the Containers one. A lifted function that gains a free identifier must gain it in the
// environment given here, in the same change, or it is a ReferenceError.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { decimalRefusal } from "../src/lib/decimal-entry";
import { ApiError } from "../src/lib/fetcher";
import { CHARGE_AMOUNT } from "../src/lib/order-boxes";
import { orderAckSnapshot, projectCharges, type ChargeFields } from "../src/lib/order-bulk-recovery";
import type { Gate } from "../src/lib/permission-ui";
import { orderBulkFixture } from "./helpers/order-bulk-fixture";
import { all, run } from "./helpers/source-lift";

const FILE = "src/app/orders/[id]/ChargesSection.tsx";
const path = fileURLToPath(new URL(`../${FILE}`, import.meta.url));
const tree = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function actual<T>(name: string, environment: Record<string, unknown>): T {
  const found = all(tree, ts.isFunctionDeclaration).filter(declaration => declaration.name?.text === name);
  if (found.length !== 1) throw new Error(`Expected one function ${name} in ${FILE}, found ${found.length}`);
  return run<T>(found[0].getText(tree), environment);
}

type Row = ChargeFields & { key: string; isNew: boolean };
const row = (over: Partial<ChargeFields> = {}, key = "charge-1"): Row => ({ key, isNew: false, description: "Handling", amount: "12.50", ...over });
const OPEN: Gate = { allowed: true, disabled: false, title: undefined };

/** The section's own `save` over these rows. The request is answered at once with an order. */
function saver(rows: Row[]) {
  const onError = vi.fn<(message: string | null) => void>();
  const requests: { url: string; init: { method: string; body: string } }[] = [];
  const response = orderBulkFixture().order;
  const baseline = projectCharges(orderBulkFixture()).baseline;
  const binding = { capture: vi.fn(() => ({ submitted: { baseline } })), dispatched: () => true, settle: vi.fn() };
  const save = actual<() => Promise<void>>("save", {
    rows, onError, grid: { binding, canEdit: true }, editGate: OPEN, newId: () => "request-1",
    applyMutation: async (mutation: () => Promise<unknown>) => { await mutation(); },
    api: async (url: string, init: { method: string; body: string }) => { requests.push({ url, init }); return response; },
    ApiError, orderId: "order-1", projectCharges, orderAckSnapshot, decimalRefusal, CHARGE_AMOUNT,
  });
  return { save, onError, requests, binding };
}

describe("the saved order's Charges grid: Save charges", () => {
  it("sends each row's description and amount, trimmed, and null for a blank amount", async () => {
    const { save, onError, requests, binding } = saver([row({ description: "  Handling ", amount: " 12.50 " }), row({ description: "Setup", amount: " " }, "added-1")]);
    await save();
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/api/orders/order-1/charges");
    expect(requests[0].init.method).toBe("PUT");
    expect(JSON.parse(requests[0].init.body)).toStrictEqual([
      { description: "Handling", amount: "12.50" },
      { description: "Setup", amount: null },
    ]);
    expect(onError.mock.calls).toEqual([[null]]);
    expect(binding.settle.mock.calls[0][1]).toMatchObject({ kind: "persisted" });
  });

  it.each<[string, Partial<ChargeFields>, string]>([
    ["a blank description", { description: "  " }, "Charge 1: enter a description."],
    ["a negative amount", { amount: "-1" }, "Charge 1, Amount: cannot be negative."],
    ["an amount that is not a number", { amount: "abc" }, "Charge 1, Amount: enter a number without $ or commas, such as 0.36."],
    ["an amount with three decimals", { amount: "1.005" }, "Charge 1, Amount: use at most 2 digits after the point."],
    ["an amount past the column", { amount: "10000000000" }, "Charge 1, Amount: must be less than 10,000,000,000."],
  ])("refuses %s before any request, naming the row and the box", async (_what, over, sentence) => {
    const { save, onError, requests, binding } = saver([row(over)]);
    await save();
    expect(onError.mock.calls).toEqual([[sentence]]);
    expect(requests).toEqual([]);
    expect(binding.capture).not.toHaveBeenCalled();
  });

  it("lists every refusal of every row at once, the description's first, and sends nothing", async () => {
    const { save, onError, requests, binding } = saver([
      row({ description: "", amount: "-1" }), row(), row({ amount: "1.234" }, "added-1"),
    ]);
    await save();
    expect(onError.mock.calls).toEqual([[[
      "Charge 1: enter a description.",
      "Charge 1, Amount: cannot be negative.",
      "Charge 3, Amount: use at most 2 digits after the point.",
    ].join("\n")]]);
    expect(requests).toEqual([]);
    expect(binding.capture).not.toHaveBeenCalled();
  });
});
