import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { ApiError, api as apiTransport } from "../src/lib/fetcher";
import { composeRows } from "../src/lib/bulk-grid";
import { createBulkRecoveryAdapter, emptyBulkDraft, type BulkBaseline } from "../src/lib/bulk-grid-recovery";
import { shipmentLinesBaseline, shipmentContainersBaseline, shipmentSerialsBaseline,
  shipmentLineFields, shipmentContainerFields, shipmentSerialFields, readShipmentCatalogs, shipmentBulkOptions } from "../src/lib/shipment-bulk-recovery";
import { invoiceLinesBaseline, toLineFields } from "../src/lib/invoice-bulk-recovery";
import { paymentApplicationBaseline } from "../src/lib/payment-bulk-recovery";
import { shipmentFixture, invoiceFixture, paymentFixture } from "./helpers/remaining-bulk-fixtures";
import { openDraftHarness } from "./helpers/draft-store";
import { newId } from "../src/lib/client-id";
import { decimalRefusal } from "../src/lib/decimal-entry";
import { PAYMENT_AMOUNT } from "../src/lib/money-boxes";
import { paymentApplyPayload } from "../src/lib/payment-apply-payload";
import { invoiceLineRefusals } from "../src/lib/invoice-line-refusals";
import { shipmentLinesPayload, settledLinesBaseline } from "../src/lib/shipment-line-save";
import { callback, runNode, source } from "./helpers/lift-callback";
import { shipmentContainersPayload, settledContainersBaseline } from "../src/lib/shipment-container-rows";

vi.mock("../src/lib/fetcher", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/fetcher")>(), api: vi.fn(),
}));

function openBaseline(baseline: BulkBaseline<Record<string, string>>, field: string, value: string) {
  const harness = openDraftHarness(createBulkRecoveryAdapter<Record<string, string>>("test", "v1"), emptyBulkDraft<Record<string, string>>(), baseline);
  harness.binding.change(d => ({ ...d, edits: new Map([[baseline.rows[0].id, { [field]: value }]]) }));
  const data = harness.binding.getSnapshot().current!.data;
  return { ...harness, rows: composeRows({ serverRows: baseline.rows, toFields: r => r.fields, ...data }) };
}
const scenarios = [
  { owner: "LinesGrid", path: "app/shipping/[id]/ShipmentOrderPanel.tsx", name: "save", baseline: () => shipmentLinesBaseline(shipmentFixture(), "so-1"), field: "weight", value: " 4.00 ", response: () => ({ shipper: shipmentFixture().shipper, warnings: [] }) },
  { owner: "ContainersGrid", path: "app/shipping/[id]/ShipmentOrderPanel.tsx", name: "save", baseline: () => shipmentContainersBaseline(shipmentFixture(), "so-1"), field: "tareEach", value: " 40.25 ", response: () => ({ shipper: shipmentFixture().shipper, warnings: [] }) },
  { owner: "SerialsGrid", path: "app/shipping/[id]/ShipmentOrderPanel.tsx", name: "save", baseline: () => shipmentSerialsBaseline(shipmentFixture(), "so-1"), field: "printOnShipper", value: "false", response: () => ({ shipper: shipmentFixture().shipper, warnings: [] }) },
  { owner: "InvoiceLinesGrid", path: "app/invoicing/[id]/InvoiceDetail.tsx", name: "save", baseline: () => invoiceLinesBaseline(invoiceFixture()), field: "amount", value: " 71.00 ", response: () => ({ invoice: invoiceFixture().invoice, warnings: [] }) },
  { owner: "ApplyPanel", path: "app/receivables/batches/[id]/BatchDetail.tsx", name: "apply", baseline: () => paymentApplicationBaseline(paymentFixture()), field: "amount", value: " 10.00 ", response: () => ({ ok: true }) },
];
describe("actual five-grid write callbacks", () => {
  for (const scenario of scenarios) {
    for (const result of ["persisted", "rejected", "unknown"] as const) it(`${scenario.owner}: ${result} settles at the raw API boundary`, async () => {
      const { binding, rows } = openBaseline(scenario.baseline(), scenario.field, scenario.value);
      const before = binding.getSnapshot().current!;
      const onError = vi.fn(); const reset = vi.fn(); const effects: string[] = [];
      const api = vi.fn(async () => {
        effects.push("transport");
        if (result === "rejected") throw new ApiError("rejected by server", 409);
        if (result === "unknown") throw new Error("transport outcome unknown");
        return scenario.response();
      });
      const followup = () => {
        effects.push("follow-up");
        expect(binding.getSnapshot().current!.data.edits.size).toBe(0);
        expect(binding.getSnapshot().needsRefresh).toBe(true);
        throw new Error("follow-up failed after persistence");
      };
      const applyMutation = async (run: () => Promise<unknown>) => { const response = await run(); followup(); return response; };
      const save = callback<() => Promise<void>>(scenario.path, scenario.owner, scenario.name, {
        grid: { binding, canEdit: true, reset }, rows, api, ApiError, onError, applyMutation,
        shipperId: "ship-1", shipperOrderId: "so-1", invoiceId: "inv-1", payment: paymentFixture().batch.payments[0],
        creditHoldReason: "  original contextual reason  ", editGate: { allowed: true }, moneyGate: { allowed: true }, recoveryWriteOffGate: { allowed: true },
        shipmentLineFields, shipmentContainerFields, shipmentSerialFields, toLineFields, invoiceLineRefusals,
        shipmentLinesPayload, settledLinesBaseline, infoByLineId: new Map(), shippedByLineId: new Map(), savedQtyByLineId: new Map(),
        shipmentContainersPayload, settledContainersBaseline,
        setApplying: vi.fn(), invalidateHistory: followup, onApplied: vi.fn(), newId, paymentApplyPayload,
      });
      await save(); expect(api).toHaveBeenCalledOnce(); expect(reset).not.toHaveBeenCalled();
      if (result === "persisted") {
        expect(effects).toEqual(["transport", "follow-up"]);
        expect(binding.getSnapshot().current!.data.edits.size).toBe(0);
        expect(binding.getSnapshot().mode).not.toBe("unknown");
        expect(onError).toHaveBeenLastCalledWith("follow-up failed after persistence");
        if (scenario.owner === "LinesGrid") {
          const body = JSON.parse((api.mock.calls[0] as unknown as [string, { body: string }])[1].body);
          expect(body.creditHoldReason).toBe("  original contextual reason  ");
        }
        if (scenario.owner === "ContainersGrid") {
          // The new body: every row with its tare each, the typed one trimmed, and no kept row.
          const body = JSON.parse((api.mock.calls[0] as unknown as [string, { body: string }])[1].body);
          expect(body).toEqual({ containers: [{ orderContainerId: "oc-1", count: 2, tareEach: "40.25" },
            { orderContainerId: "oc-2", count: 1, tareEach: "310" }], kept: [] });
          // The baseline the grid settled to: this shipment order's two rows with their stored
          // figures, not the typed text. The answer here is the fixture the baseline was read
          // from, so this cannot tell the answer's rows from the submitted ones. The leaf's own
          // case does: "a save settles to every row of the answer" (shipment-container-rows.test.ts).
          expect(binding.getSnapshot().current!.baseline.rows).toEqual([
            { id: "sc-1", fields: { orderContainerId: "oc-1", count: "2", tareEach: "42.5" } },
            { id: "sc-2", fields: { orderContainerId: "oc-2", count: "1", tareEach: "310" } }]);
        }
      } else {
        expect(effects).toEqual(["transport"]);
        expect(binding.getSnapshot().current!.data).toEqual(before.data);
        expect(binding.getSnapshot().mode).toBe(result === "unknown" ? "unknown" : "editing");
      }
    });
  }
  // A row the screen's own check refuses: `save` hands `onError` the leaf's sentence whole (V1, V4).
  it.each([
    ["tareEach", "-1", "Container 1, Tare each (lb): cannot be negative."],
    ["tareEach", "42.555", "Container 1, Tare each (lb): use at most 2 digits after the point."],
    ["count", "0", "Container 1: containers must be a whole number of at least 1."],
  ])("ContainersGrid: a refused %s is reported through onError, and nothing is sent", async (field, value, sentence) => {
    const { binding, rows } = openBaseline(shipmentContainersBaseline(shipmentFixture(), "so-1"), field, value);
    const onError = vi.fn(); const api = vi.fn(async () => ({ shipper: shipmentFixture().shipper, warnings: [] }));
    await callback<() => Promise<void>>("app/shipping/[id]/ShipmentOrderPanel.tsx", "ContainersGrid", "save", {
      grid: { binding, canEdit: true, reset: vi.fn() }, rows, api, ApiError, onError, applyMutation: async (run: () => Promise<unknown>) => run(),
      shipperId: "ship-1", shipperOrderId: "so-1", editGate: { allowed: true }, shipmentContainersPayload, settledContainersBaseline, newId,
    })();
    // Every call of `onError`: one, with the sentence.
    expect(onError.mock.calls).toEqual([[sentence]]);
    expect(api).not.toHaveBeenCalled();
  });
  // Several refusals on one save: `save` hands `onError` the leaf's list whole, once, one refusal
  // per line, and sends nothing (#517).
  it("ContainersGrid: every refusal of one save goes to onError once, as one message, and nothing is sent", async () => {
    const baseline = shipmentContainersBaseline(shipmentFixture(), "so-1");
    const harness = openDraftHarness(createBulkRecoveryAdapter<Record<string, string>>("test", "v1"), emptyBulkDraft<Record<string, string>>(), baseline);
    harness.binding.change(d => ({ ...d, edits: new Map([
      [baseline.rows[0].id, { count: "0", tareEach: "-1" }], [baseline.rows[1].id, { tareEach: "1e2" }]]) }));
    const before = harness.binding.getSnapshot().current!;
    const rows = composeRows({ serverRows: baseline.rows, toFields: r => r.fields, ...before.data });
    const onError = vi.fn(); const api = vi.fn(async () => ({ shipper: shipmentFixture().shipper, warnings: [] }));
    await callback<() => Promise<void>>("app/shipping/[id]/ShipmentOrderPanel.tsx", "ContainersGrid", "save", {
      grid: { binding: harness.binding, canEdit: true, reset: vi.fn() }, rows, api, ApiError, onError, applyMutation: async (run: () => Promise<unknown>) => run(),
      shipperId: "ship-1", shipperOrderId: "so-1", editGate: { allowed: true }, shipmentContainersPayload, settledContainersBaseline, newId,
    })();
    expect(onError.mock.calls).toEqual([[[
      "Container 1: containers must be a whole number of at least 1.",
      "Container 1, Tare each (lb): cannot be negative.",
      "Container 2, Tare each (lb): enter a number without $ or commas, such as 0.36.",
    ].join("\n")]]);
    expect(api).not.toHaveBeenCalled();
    // Nothing was captured: the draft is as it was typed, so the grid stays dirty.
    expect(harness.binding.getSnapshot().current!.data).toEqual(before.data);
  });
  // The Lines grid's save does the same with its own leaf's list.
  it("LinesGrid: a refused quantity and weight on one row go to onError once, as one message, and nothing is sent", async () => {
    const baseline = shipmentLinesBaseline(shipmentFixture(), "so-1");
    const harness = openDraftHarness(createBulkRecoveryAdapter<Record<string, string>>("test", "v1"), emptyBulkDraft<Record<string, string>>(), baseline);
    harness.binding.change(d => ({ ...d, edits: new Map([[baseline.rows[0].id, { qty: "1.5", weight: "" }]]) }));
    const before = harness.binding.getSnapshot().current!;
    const rows = composeRows({ serverRows: baseline.rows, toFields: r => r.fields, ...before.data });
    const onError = vi.fn(); const api = vi.fn(async () => ({ shipper: shipmentFixture().shipper, warnings: [] }));
    await callback<() => Promise<void>>("app/shipping/[id]/ShipmentOrderPanel.tsx", "LinesGrid", "save", {
      grid: { binding: harness.binding, canEdit: true, reset: vi.fn() }, rows, api, ApiError, onError, applyMutation: async (run: () => Promise<unknown>) => run(),
      shipperId: "ship-1", shipperOrderId: "so-1", editGate: { allowed: true }, creditHoldReason: "",
      shipmentLinesPayload, settledLinesBaseline, infoByLineId: new Map(), shippedByLineId: new Map(), savedQtyByLineId: new Map(), newId,
    })();
    expect(onError.mock.calls).toEqual([[[
      "Line 1: ship-now quantity must be a whole number of at least 0.",
      "Line 1, Ship now net weight (lb): enter a number without $ or commas, such as 0.36.",
    ].join("\n")]]);
    expect(api).not.toHaveBeenCalled();
    expect(harness.binding.getSnapshot().current!.data).toEqual(before.data);
  });
  // The invoice draft's save does the same with its own leaf's list, rows named by their table (#517).
  it("InvoiceLinesGrid: every refusal of one save goes to onError once, as one message, and nothing is sent", async () => {
    const baseline = invoiceLinesBaseline(invoiceFixture());
    const harness = openDraftHarness(createBulkRecoveryAdapter<Record<string, string>>("test", "v1"), emptyBulkDraft<Record<string, string>>(), baseline);
    harness.binding.change(d => ({ ...d, edits: new Map([
      [baseline.rows[0].id, { weight: "1.234", amount: "5" }], [baseline.rows[1].id, { amount: "1e2" }]]) }));
    const before = harness.binding.getSnapshot().current!;
    const rows = composeRows({ serverRows: baseline.rows, toFields: r => r.fields, ...before.data });
    const onError = vi.fn(); const api = vi.fn(async () => ({ invoice: invoiceFixture().invoice, warnings: [] }));
    await callback<() => Promise<void>>("app/invoicing/[id]/InvoiceDetail.tsx", "InvoiceLinesGrid", "save", {
      grid: { binding: harness.binding, canEdit: true, reset: vi.fn() }, rows, api, ApiError, onError, applyMutation: async (run: () => Promise<unknown>) => run(),
      invoiceId: "inv-1", moneyGate: { allowed: true }, toLineFields, invoiceLineRefusals, newId,
    })();
    expect(onError.mock.calls).toEqual([[[
      "Part / operation line 1, Net weight (lb): use at most 2 digits after the point.",
      "Surcharges line 1, Amount: enter a number without $ or commas, such as 0.36.",
    ].join("\n")]]);
    expect(api).not.toHaveBeenCalled();
    expect(harness.binding.getSnapshot().current!.data).toEqual(before.data);
  });
  // #587 (review focus 5): Save lines sends each row's mark as it stands. The server writes a line
  // the PUT sends with no mark as not chosen (`lineColumns`' `?? false`), so a Save that dropped the
  // field would clear every line's mark on the invoice (the words themselves are saved as sent). One
  // row of each value, so "sent" and "cleared" cannot read alike: the fixture's operation line is
  // marked and its charge line is not.
  it("InvoiceLinesGrid: the PUT carries every row's words-chosen mark, true and false as they stand", async () => {
    const baseline = invoiceLinesBaseline(invoiceFixture());
    const harness = openDraftHarness(createBulkRecoveryAdapter<Record<string, string>>("test", "v1"), emptyBulkDraft<Record<string, string>>(), baseline);
    harness.binding.change(d => ({ ...d, edits: new Map([[baseline.rows[1].id, { description: "Handling, rush" }]]) }));
    const rows = composeRows({ serverRows: baseline.rows, toFields: r => r.fields, ...harness.binding.getSnapshot().current!.data });
    const api = vi.fn(async () => ({ invoice: invoiceFixture().invoice, warnings: [] }));
    await callback<() => Promise<void>>("app/invoicing/[id]/InvoiceDetail.tsx", "InvoiceLinesGrid", "save", {
      grid: { binding: harness.binding, canEdit: true, reset: vi.fn() }, rows, api, ApiError, onError: vi.fn(), applyMutation: async (run: () => Promise<unknown>) => run(),
      invoiceId: "inv-1", moneyGate: { allowed: true }, toLineFields, invoiceLineRefusals, newId,
    })();
    // Every body sent: one, its rows' words and marks in grid order.
    expect(api.mock.calls.map(call => (JSON.parse((call as unknown as [string, { body: string }])[1].body) as { description: string; wordsChosen: unknown }[])
      .map(line => [line.description, line.wordsChosen]))).toEqual([[["Hardening", true], ["Handling, rush", false]]]);
  });
  // A kept row beside a linked one: the fixture's first container row loses its order row, as
  // tests/bulk-grid-recovery.test.ts makes one. `save` hands the body builder every row of the
  // grid, so the kept row goes out under `kept`, once, and the linked row under `containers`.
  it("ContainersGrid: a kept row's typed tare each is sent once, under kept by the row's id, beside the linked row under containers", async () => {
    const fixture = shipmentFixture(); fixture.shipper.orders[0].containers[0].orderContainerId = null;
    const { binding, rows } = openBaseline(shipmentContainersBaseline(fixture, "so-1"), "tareEach", " 40.25 ");
    const api = vi.fn(async () => ({ shipper: fixture.shipper, warnings: [] }));
    await callback<() => Promise<void>>("app/shipping/[id]/ShipmentOrderPanel.tsx", "ContainersGrid", "save", {
      grid: { binding, canEdit: true, reset: vi.fn() }, rows, api, ApiError, onError: vi.fn(), applyMutation: async (run: () => Promise<unknown>) => run(),
      shipperId: "ship-1", shipperOrderId: "so-1", editGate: { allowed: true }, shipmentContainersPayload, settledContainersBaseline, newId,
    })();
    // Every body sent: one.
    expect(api.mock.calls.map(call => JSON.parse((call as unknown as [string, { body: string }])[1].body))).toEqual([
      { containers: [{ orderContainerId: "oc-2", count: 1, tareEach: "310" }], kept: [{ id: "sc-1", tareEach: "40.25" }] }]);
  });
  // #517: the apply grid sends the typed text, not Number() of it, and keeps its own sentences.
  it("ApplyPanel: a typed amount goes as its trimmed text, and a refused one keeps the grid's sentence", async () => {
    const run = async (field: string, value: string) => {
      const { binding, rows } = openBaseline(paymentApplicationBaseline(paymentFixture()), field, value);
      const api = vi.fn(async () => ({ ok: true })); const onError = vi.fn();
      await callback<() => Promise<void>>(scenarios[4].path, "ApplyPanel", "apply", {
        grid: { binding, canEdit: true, reset: vi.fn() }, rows, api, ApiError, onError, payment: paymentFixture().batch.payments[0],
        moneyGate: { allowed: true }, recoveryWriteOffGate: { allowed: true }, setApplying: vi.fn(), invalidateHistory: vi.fn(), onApplied: vi.fn(), newId, paymentApplyPayload,
      })();
      return { api, onError, rows };
    };
    const sent = await run("amount", " .36 ");
    expect(sent.api.mock.calls.map(call => JSON.parse((call as unknown as [string, { body: string }])[1].body).lines))
      .toEqual([[{ invoiceId: sent.rows[0].key, type: "PAYMENT", amount: ".36" }]]);
    const refused = await run("amount", "1e2");
    expect(refused.api).not.toHaveBeenCalled();
    expect(refused.onError.mock.calls).toEqual([[`${refused.rows[0].documentNumber}, Amount: enter a number without $ or commas, such as 0.36.`]]);
    // No reason is typed here, so the reason line joins the box's sentence.
    const writeOff = await run("writeOffAmount", "1e2");
    expect(writeOff.api).not.toHaveBeenCalled();
    const doc = writeOff.rows[0].documentNumber;
    expect(writeOff.onError.mock.calls).toEqual([[
      `${doc}, Write-off: enter a number without $ or commas, such as 0.36.\n${doc}: a write-off needs a reason.`]]);
  });
  // #517: Add a payment checks its amount through the rule and lists every refusal, sending nothing.
  describe("BatchDetail addPayment", () => {
    const addPayment = async (fields: { customer: string; type: string; amount: string; received: string }) => {
      const setError = vi.fn(); const api = vi.fn(async () => ({})); const applyMutation = vi.fn(async (run: () => Promise<unknown>) => run());
      await callback<() => Promise<void>>("app/receivables/batches/[id]/BatchDetail.tsx", "BatchDetail", "addPayment", {
        payCustomerId: fields.customer, payTypeId: fields.type, payAmount: fields.amount, payReceivedDate: fields.received, payReference: "",
        id: "batch-1", api, applyMutation, setAddPaymentMessage: setError, setAddingPayment: vi.fn(), setPayCustomerId: vi.fn(), setPayTypeId: vi.fn(),
        setPayAmount: vi.fn(), setPayReference: vi.fn(), setPayReceivedDate: vi.fn(), decimalRefusal, PAYMENT_AMOUNT,
      })();
      return { setError, api, applyMutation };
    };
    it("a blank amount with every other field set reads as a zero amount, and sends nothing", async () => {
      const r = await addPayment({ customer: "c1", type: "t1", amount: "", received: "2026-10-14" });
      expect(r.setError.mock.calls).toEqual([["Payment amount: must be greater than zero."]]);
      expect(r.api).not.toHaveBeenCalled(); expect(r.applyMutation).not.toHaveBeenCalled();
    });
    it("a missing field and a refused amount are listed together", async () => {
      const r = await addPayment({ customer: "", type: "t1", amount: "1.234", received: "2026-10-14" });
      expect(r.setError.mock.calls).toEqual([[
        "Payer customer, payment type, amount, and received date are all required to add a payment.\nPayment amount: use at most 2 digits after the point."]]);
      expect(r.api).not.toHaveBeenCalled();
    });
    it("a fitting amount is sent as typed", async () => {
      const r = await addPayment({ customer: "c1", type: "t1", amount: " .36 ", received: "2026-10-14" });
      expect(r.setError).toHaveBeenLastCalledWith(null);
      expect(JSON.parse((r.api.mock.calls[0] as unknown as [string, { body: string }])[1].body).amount).toBe(" .36 ");
    });
  });
  it("payment marks persistence before a parent refresh throws, without replay or local reset", async () => {
    const { binding, rows } = openBaseline(paymentApplicationBaseline(paymentFixture()), "amount", "10");
    const api = vi.fn(async () => ({ ok: true })); const onError = vi.fn(); const reset = vi.fn(); const history = vi.fn();
    const onApplied = vi.fn(() => {
      expect(binding.getSnapshot().current!.data.edits.size).toBe(0);
      throw new Error("refresh failed");
    });
    await callback<() => Promise<void>>(scenarios[4].path, "ApplyPanel", "apply", {
      grid: { binding, canEdit: true, reset }, rows, api, ApiError, onError, payment: paymentFixture().batch.payments[0],
      moneyGate: { allowed: true }, recoveryWriteOffGate: { allowed: true }, setApplying: vi.fn(), invalidateHistory: history, onApplied, newId, paymentApplyPayload,
    })();
    expect(api).toHaveBeenCalledOnce(); expect(history).toHaveBeenCalledOnce(); expect(onApplied).toHaveBeenCalledOnce();
    expect(reset).not.toHaveBeenCalled(); expect(binding.getSnapshot().mode).not.toBe("unknown"); expect(onError).toHaveBeenLastCalledWith("refresh failed");
  });
});

describe("actual read integration", () => {
  // Sequential reads read the order again: each options.read() is a new source snapshot, and the
  // catalog share is per snapshot OBJECT (#608, tests/bulk-read-share.test.ts), never per id.
  it("one shipment binding reads only its own order catalog and re-reads unchanged IDs", async () => {
    const fixture = shipmentFixture();
    fixture.shipper.orders.push({ ...fixture.shipper.orders[0], id: "so-other", orderId: "order-other" });
    const order = (qty: number) => ({ lines: [{ id: "ol-1", position: 1, qty, weight: 20, part: { partNumber: "P-10", name: "Shaft" } }], containers: [], serials: [] });
    const transport = vi.mocked(apiTransport);
    transport.mockResolvedValue(order(10));
    const source = { read: async () => ({ record: fixture.shipper, access: fixture.permissions }), register: vi.fn(), begin: vi.fn() };
    const options = shipmentBulkOptions(source, "ship-1", "so-1", "lines");
    const first = await options.read(); transport.mockResolvedValue(order(8));
    const second = await options.read();
    expect(transport.mock.calls.map(call => call[0])).toEqual(["/api/orders/order-1", "/api/orders/order-1"]);
    expect(first.baseline.context.catalog).toContainEqual({ id: "ol-1", qty: 10, weight: 20 });
    expect(second.baseline.context.catalog).toContainEqual({ id: "ol-1", qty: 8, weight: 20 });
    transport.mockReset();
  });
  it("shipment reads catalogs again with unchanged order IDs and refuses forbidden catalogs", async () => {
    const fixture = shipmentFixture(); let qty = 10;
    const readOrder = vi.fn(async () => ({ lines: [{ id: "ol-1", position: 1, qty, weight: 20, part: { partNumber: "P-10", name: "Shaft" } }], containers: [], serials: [] }));
    const input = { record: fixture.shipper, access: fixture.permissions };
    const first = await readShipmentCatalogs(input, readOrder); qty = 8;
    const second = await readShipmentCatalogs(input, readOrder);
    expect(readOrder).toHaveBeenCalledTimes(2);
    expect(first.catalogs.get("order-1")!.lines[0].qty).toBe(10); expect(second.catalogs.get("order-1")!.lines[0].qty).toBe(8);
    const shippingOnly = await readShipmentCatalogs({ ...input, access: ["shipping.view", "shipping.edit"] }, readOrder);
    expect(shippingOnly.shipper).toBe(input.record); expect(shippingOnly.catalogs.size).toBe(0);
    await expect(readShipmentCatalogs({ ...input, access: ["orders.view"] }, readOrder)).rejects.toThrow("Shipment access is required");
    expect(readOrder).toHaveBeenCalledTimes(2);
    await expect(readShipmentCatalogs(input, async () => { throw new Error("catalog failed"); })).rejects.toThrow("catalog failed");
  });
  it("the actual hook binding effect uses a concrete supplied href", () => {
    const file = source("lib/bulk-grid.ts"); let effect: ts.Expression | undefined;
    function walk(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useEffect"
        && node.arguments[0]?.getText(file).includes("store.bind(")) effect = node.arguments[0];
      ts.forEachChild(node, walk);
    }
    walk(file); expect(effect).toBeDefined();
    for (const [kind, href] of [["shipment", "/shipping/s1"], ["invoice", "/invoicing/i1"], ["payment", "/receivables/batches/b1"]]) {
      const bind = vi.fn(); const options = { kind: "editor", schema: "v1", label: "Draft", href, record: { kind, id: "record" }, childId: "child" };
      runNode<() => void>(effect!, file, { optionsRef: { current: options }, store: { bind }, owner: { userId: "u", authGeneration: 1 }, setBinding: vi.fn(), createBulkRecoveryAdapter })();
      expect(bind).toHaveBeenCalledWith(expect.anything(), { label: "Draft", href, scope: undefined }, expect.anything());
    }
  });
  it("selection effect captures authorization and waits for an accepted fresh batch before consuming", async () => {
    const file = source("app/receivables/batches/[id]/BatchDetail.tsx"); let effect: ts.Expression | undefined;
    function walk(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useEffect"
        && node.arguments[0]?.getText(file).includes("consumeSelectedPayment")) effect = node.arguments[0];
      ts.forEachChild(node, walk);
    }
    walk(file); expect(effect).toBeDefined();
    for (const mode of ["accepted", "superseded", "authorization-changed", "unmounted"] as const) {
      let finish!: (result: { batch: unknown; accepted: boolean }) => void;
      let authorized = true; const events: string[] = [];
      const session = { readAuthorizationTicket: () => { events.push("ticket"); return "ticket"; }, isReadAuthorized: () => authorized };
      const consumeSelectedPayment = vi.fn(() => "pay-1"); const expand = vi.fn();
      const cleanup = runNode<() => () => void>(effect!, file, {
        getBrowserDraftSession: () => session, drafts: { identityReady: true }, selectionRevision: 1,
        load: () => { events.push("read"); return new Promise(resolve => { finish = resolve; }); }, consumeSelectedPayment,
        setExpandedPaymentId: expand, setError: vi.fn(),
      })();
      expect(events).toEqual(["ticket", "read"]); expect(consumeSelectedPayment).not.toHaveBeenCalled();
      if (mode === "authorization-changed") authorized = false;
      if (mode === "unmounted") cleanup();
      finish({ batch: paymentFixture().batch, accepted: mode !== "superseded" });
      await Promise.resolve();
      if (mode === "accepted") { expect(consumeSelectedPayment).toHaveBeenCalledOnce(); expect(expand).toHaveBeenCalledWith("pay-1"); }
      else { expect(consumeSelectedPayment).not.toHaveBeenCalled(); expect(expand).not.toHaveBeenCalled(); }
    }
  });
});
