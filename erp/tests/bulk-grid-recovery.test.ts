import { describe, expect, it, vi } from "vitest";
import { createBulkRecoveryAdapter, emptyBulkDraft, transitionBulkDraft, type BulkBaseline, type BulkRecoveryCustomization } from "../src/lib/bulk-grid-recovery";
import { openDraftHarness } from "./helpers/draft-store";

type Fields = { serial: string; description: string };
const adapter = createBulkRecoveryAdapter<Fields>("order-serials", "order-serials-v1");
const clean = () => emptyBulkDraft<Fields>("");
const baseline: BulkBaseline<Fields> = {
  rows: [{ id: "a", fields: { serial: "A", description: "original" } }, { id: "b", fields: { serial: "B", description: "" } }],
  context: { status: "OPEN", editable: true, line: { id: "line-1", partId: "part-1", serialized: true } },
};
const open = () => openDraftHarness(adapter, clean(), baseline);

describe("bulk recovery", () => {
  it("prunes orphan identities only during an eligible mounted refresh and never rebases by position", () => {
    const { binding } = open();
    binding.change(d => transitionBulkDraft(d, baseline, { kind: "edit", id: "a", patch: { serial: "orphan" } }));
    binding.change(d => transitionBulkDraft(d, baseline, { kind: "remove-existing", id: "b" }));
    binding.change(d => transitionBulkDraft(d, baseline, { kind: "add", rows: [{ clientId: "new-1", serial: "keep added", description: "" }] }));
    binding.change(d => transitionBulkDraft(d, baseline, { kind: "range", value: "keep raw" }));
    const before = binding.getSnapshot().current!;
    const fresh = { ...baseline, rows: baseline.rows.map(r => ({ ...r, id: `${r.id}-replacement` })) };
    const readId = binding.beginMountedRead()!; binding.acceptRead({ kind: "authorized", readId, baseline: fresh, editable: true }, clean());
    const view = binding.getSnapshot();
    expect(view.mode).toBe("editing");
    expect(view.current!.baseline).toEqual(fresh);
    expect(view.current!.data.edits.size).toBe(0);
    expect(view.current!.data.removedIds.size).toBe(0);
    expect(view.current!.data.added).toEqual([{ clientId: "new-1", serial: "keep added", description: "" }]);
    expect(view.current!.data.rangeInput).toBe("keep raw");
    expect(view.current!.data.orphanWarning).toContain("changed on the server");
    expect(before.data.edits.get("a")).toEqual({ serial: "orphan" });
    expect([...before.data.removedIds]).toEqual(["b"]);
  });
  it("refuses mounted reconciliation when writer context changes", () => {
    const { binding } = open();
    binding.change(d => transitionBulkDraft(d, baseline, { kind: "range", value: "private raw" }));
    const retained = binding.getSnapshot().current!;
    const readId = binding.beginMountedRead()!;
    binding.acceptRead({ kind: "authorized", readId, baseline: { ...baseline, context: { ...baseline.context, status: "VOID" } }, editable: true }, clean());
    expect(binding.getSnapshot().mode).toBe("conflict");
    expect(binding.getSnapshot().current).toBe(retained);
  });
  it("prunes reverted overlays with string-exact equality and preserves old snapshots", () => {
    const { binding } = open();
    binding.change(d => transitionBulkDraft(d, baseline, { kind: "edit", id: "a", patch: { serial: " A " } }));
    const before = binding.getSnapshot().current!;
    expect(before.data.edits.get("a")).toEqual({ serial: " A " });
    binding.change(d => transitionBulkDraft(d, baseline, { kind: "edit", id: "a", patch: { serial: "A" } }));
    expect(binding.getSnapshot().current!.data.edits.size).toBe(0);
    expect(adapter.dirty(binding.getSnapshot().current!.data, baseline)).toBe(false);
    expect(before.data.edits.get("a")).toEqual({ serial: " A " });
  });
  it("preserves added identities, removes by identity, and never changes prior collections", () => {
    const { binding } = open();
    binding.change(d => transitionBulkDraft(d, baseline, { kind: "add", rows: [{ clientId: "new-1", serial: "N", description: "" }] }));
    const before = binding.getSnapshot().current!;
    binding.change(d => transitionBulkDraft(d, baseline, { kind: "patch-added", id: "new-1", patch: { serial: "N2" } }));
    expect(binding.getSnapshot().current!.data.added).toEqual([{ clientId: "new-1", serial: "N2", description: "" }]);
    binding.change(d => transitionBulkDraft(d, baseline, { kind: "remove-existing", id: "b" }));
    binding.change(d => transitionBulkDraft(d, baseline, { kind: "remove-added", id: "new-1" }));
    expect([...binding.getSnapshot().current!.data.removedIds]).toEqual(["b"]);
    expect(binding.getSnapshot().current!.data.added).toEqual([]);
    expect(before.data.added[0].serial).toBe("N");
    expect(before.data.removedIds.size).toBe(0);
  });
  for (const fresh of [
    { ...baseline, rows: baseline.rows.map(r => ({ ...r, id: `${r.id}-replacement` })) },
    { ...baseline, rows: [...baseline.rows, { id: "c", fields: { serial: "C", description: "" } }] },
    { ...baseline, rows: baseline.rows.slice(0, 1) },
    { ...baseline, rows: baseline.rows.toReversed() },
    { ...baseline, rows: baseline.rows.map(r => r.id === "b" ? { ...r, fields: { ...r.fields, description: "changed untouched" } } : r) },
    { ...baseline, context: { ...baseline.context, status: "VOID" } },
  ]) it("requires the complete ordered fields and context on return", () => {
    const { binding, detach } = open();
    binding.change(d => transitionBulkDraft(d, baseline, { kind: "edit", id: "a", patch: { serial: "last input" } }));
    const retained = binding.getSnapshot().current!;
    detach(); binding.attach("return");
    const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, baseline: fresh, editable: true }, clean());
    expect(binding.getSnapshot().mode).toBe("conflict");
    expect(binding.getSnapshot().current).toBe(retained);
    expect(binding.restore(retained.stamp, readId)).toBe(false);
    expect(retained.data.edits.get("a")).toEqual({ serial: "last input" });
  });
  it("stores raw range-only input synchronously and restores it without a write", () => {
    const { binding, store, detach } = open();
    binding.change(d => transitionBulkDraft(d, baseline, { kind: "range", value: "  R{unfinished  " }));
    expect(store.getSnapshot().count).toBe(1);
    detach(); binding.attach("return"); const readId = binding.beginRead();
    binding.acceptRead({ kind: "authorized", readId, baseline, editable: true }, clean());
    expect(binding.restore(binding.getSnapshot().current!.stamp, readId)).toBe(true);
    expect(binding.getSnapshot().current!.data.rangeInput).toBe("  R{unfinished  ");
  });
  it("expands 10,000 serials and clears range in one publication without changing the old snapshot", () => {
    const { binding } = open();
    binding.change(d => transitionBulkDraft(d, baseline, { kind: "range", value: "R{1..10000}" }));
    const before = binding.getSnapshot().current!;
    const rows = Array.from({ length: 10000 }, (_, i) => ({ clientId: `client-${i}`, serial: `R${i + 1}`, description: "" }));
    const notify = vi.fn(); binding.subscribe(notify);
    binding.change(d => transitionBulkDraft(d, baseline, { kind: "add", rows, consumeRange: true }));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(binding.getSnapshot().current!.data.added).toHaveLength(10000);
    expect(new Set(binding.getSnapshot().current!.data.added.map(r => r.clientId)).size).toBe(10000);
    expect(binding.getSnapshot().current!.data.rangeInput).toBe("");
    expect(before.data.added).toEqual([]); expect(before.data.rangeInput).toBe("R{1..10000}");
  });
  it("acknowledges saved grid rows while preserving unsubmitted range text, including later text", () => {
    const { binding } = open();
    binding.change(d => transitionBulkDraft(d, baseline, { kind: "add", rows: [{ clientId: "new-1", serial: "R1", description: "" }] }));
    binding.change(d => transitionBulkDraft(d, baseline, { kind: "range", value: "R{unfinished" }));
    const submission = binding.capture([{ serial: "R1", description: "" }], "save-serials");
    binding.dispatched(submission);
    binding.change(d => transitionBulkDraft(d, baseline, { kind: "range", value: "new raw text" }));
    const saved = { ...baseline, rows: [{ id: "saved-1", fields: { serial: "R1", description: "" } }] };
    binding.settle(submission, { kind: "persisted", response: saved });
    expect(binding.getSnapshot().current!.data.rangeInput).toBe("new raw text");
    expect(binding.getSnapshot().current!.data.added).toEqual([]);
    expect(binding.getSnapshot().current!.baseline).toEqual(saved);
  });
  it("the view says pending while its own save is in transport, and nothing else changes its mode (R23, #702)", () => {
    // useBulkGrid closes the grid's inputs on this flag (bulk-grid.ts): the save below lands its
    // answer over an empty draft, so a keystroke made meanwhile would be dropped without a word.
    for (const outcome of [{ kind: "persisted", response: baseline }, { kind: "rejected" }] as const) {
      const { binding } = open();
      binding.change(d => transitionBulkDraft(d, baseline, { kind: "edit", id: "a", patch: { serial: "typed" } }));
      const submission = binding.capture([], "save");
      // Captured, not yet sent: the request is queued, and nothing is in transport.
      expect(binding.getSnapshot().pending).toBeUndefined();
      binding.dispatched(submission);
      expect(binding.getSnapshot()).toMatchObject({ mode: "editing", pending: true });
      binding.settle(submission, outcome);
      expect(binding.getSnapshot().pending, outcome.kind).toBeUndefined();
      expect(binding.getSnapshot().mode, outcome.kind).toBe("editing");
    }
  });
  it("a late acknowledgement consumes only the captured generation", () => {
    const { binding } = open();
    binding.change(d => transitionBulkDraft(d, baseline, { kind: "edit", id: "a", patch: { serial: "submitted" } }));
    const submission = binding.capture([], "save"); binding.dispatched(submission);
    binding.discard(binding.getSnapshot().current!.stamp);
    binding.change(d => transitionBulkDraft(d, baseline, { kind: "range", value: "new generation" }));
    binding.settle(submission, { kind: "persisted", response: baseline });
    expect(binding.getSnapshot().current!.data.rangeInput).toBe("new generation");
  });
  for (const kind of ["rejected", "unknown"] as const) it(`retains grid input after ${kind} outcome`, () => {
    const { binding } = open();
    binding.change(d => transitionBulkDraft(d, baseline, { kind: "edit", id: "a", patch: { serial: "raw" } }));
    const submission = binding.capture([], "request"); binding.dispatched(submission);
    binding.settle(submission, { kind });
    expect(binding.getSnapshot().current!.data.edits.get("a")).toEqual({ serial: "raw" });
    if (kind === "unknown") expect(binding.getSnapshot().mode).toBe("unknown");
  });
});

// Task 4: literal domain projections, not reduced illustrative fields.
import { shipmentLinesBaseline, shipmentContainersBaseline, shipmentSerialsBaseline,
  shipmentBulkCustomization, shipmentBulkOptions, shipmentDisplayFromBaseline, toShipmentCatalog } from "../src/lib/shipment-bulk-recovery";
import { invoiceLinesBaseline, invoiceBulkCustomization, invoiceBulkOptions } from "../src/lib/invoice-bulk-recovery";
import { typedPatch } from "../src/lib/invoice-step-pick";
import { paymentApplicationBaseline, paymentBulkCustomization, paymentBulkOptions, readPaymentCandidates } from "../src/lib/payment-bulk-recovery";
import { shipmentFixture, invoiceFixture, paymentFixture } from "./helpers/remaining-bulk-fixtures";

const shipmentCases = [
  ["lines", shipmentLinesBaseline, "orderLineId"],
  ["containers", shipmentContainersBaseline, "orderContainerId"],
  ["serials", shipmentSerialsBaseline, "orderSerialId"],
] as const;
describe("remaining bulk projections", () => {
  it("projects shipment writer values, released membership, quantities, totals, and credit hold", () => {
    const s = shipmentFixture();
    const b = shipmentLinesBaseline(s, "so-1");
    expect(shipmentContainersBaseline(s, "so-1").rows).toEqual([
      { id: "sc-1", fields: { orderContainerId: "oc-1", count: "2", tareEach: "42.5" } },
      { id: "sc-2", fields: { orderContainerId: "oc-2", count: "1", tareEach: "310" } },
    ]);
    expect(shipmentSerialsBaseline(s, "so-1").rows).toEqual([
      { id: "ss-1", fields: { orderSerialId: "os-1", printOnShipper: "true" } },
      { id: "ss-2", fields: { orderSerialId: "os-2", printOnShipper: "false" } },
    ]);
    s.shipper.orders[0].containers[1].orderContainerId = null;
    s.shipper.orders[0].serials[1].orderSerialId = null;
    // A released container stays in its grid, first (the weights design §12.2). A released serial is left out.
    expect(shipmentContainersBaseline(s, "so-1").rows.map(r => r.id)).toEqual(["sc-2", "sc-1"]);
    expect(shipmentSerialsBaseline(s, "so-1").rows.map(r => r.id)).toEqual(["ss-1"]);
    expect(b.rows).toEqual([
      { id: "sl-1", fields: { orderLineId: "ol-1", qty: "2", weight: "4", lineComplete: "false" } },
      { id: "sl-2", fields: { orderLineId: "ol-2", qty: "1", weight: "2", lineComplete: "false" } },
    ]);
    expect(b.context).toMatchObject({ shipperId: "ship-1", order: { id: "so-1", orderId: "order-1" }, editable: true,
      customerCreditHold: false, overrideCreditHold: false,
      membership: [{ id: "sl-1", parentId: "ol-1" }, { id: "sl-2", parentId: "ol-2" }],
      catalog: [{ id: "ol-1", qty: 10, weight: 20 }, { id: "ol-2", qty: 5, weight: 10 }],
      shipped: [{ orderLineId: "ol-1", shippedToDateQty: 2, shippedToDateWeight: 4 }] });
    s.shipper.orders[0].lines[1].orderLineId = null;
    expect(shipmentLinesBaseline(s, "so-1").rows.map(r => r.id)).toEqual(["sl-1"]);
    expect(shipmentLinesBaseline(s, "so-1").context.membership).toEqual([{ id: "sl-1", parentId: "ol-1" }, { id: "sl-2", parentId: null }]);
  });
  for (const [kind, project] of shipmentCases) {
    it(`${kind}: every untouched row and catalog membership participates, labels alone do not`, () => {
      const original = shipmentFixture();
      const compare = createBulkRecoveryAdapter("shipment-" + kind, "v1", shipmentBulkCustomization(kind));
      const baseline = project(original, "so-1");
      for (const mode of ["add", "change", "remove", "release", "catalog", "parent"] as const) {
        const fresh = shipmentFixture();
        const so = fresh.shipper.orders[0];
        if (mode === "add") {
          if (kind === "lines") so.lines.push({ ...so.lines[1], id: "third" });
          if (kind === "containers") so.containers.push({ ...so.containers[1], id: "third" });
          if (kind === "serials") so.serials.push({ ...so.serials[1], id: "third" });
        }
        if (mode === "remove") so[kind].pop();
        if (mode === "change") {
          if (kind === "lines") so.lines[1].weight = 9;
          if (kind === "containers") so.containers[1].count = 9;
          if (kind === "serials") so.serials[1].printOnShipper = true;
        }
        if (mode === "release") {
          if (kind === "lines") so.lines[1].orderLineId = null;
          if (kind === "containers") so.containers[1].orderContainerId = null;
          if (kind === "serials") so.serials[1].orderSerialId = null;
        }
        if (mode === "catalog") fresh.catalogs.get("order-1")![kind].pop();
        if (mode === "parent") so.id = "replacement-parent";
        expect(compare.baselineEqual(baseline, project(fresh, "so-1")), mode).toBe(false);
      }
      const label = shipmentFixture();
      label.shipper.orders[0].poNumber = "Display-only PO";
      label.catalogs.get("order-1")!.lines[0].partName = "Renamed label";
      expect(compare.baselineEqual(baseline, project(label, "so-1"))).toBe(true);
    });
  }
  it("shipment catalogs and gates invalidate without row churn", () => {
    const b = shipmentLinesBaseline(shipmentFixture(), "so-1");
    const a = createBulkRecoveryAdapter("shipment-lines", "v1", shipmentBulkCustomization("lines"));
    for (const field of ["qty", "weight"] as const) {
      const s = shipmentFixture(); s.catalogs.get("order-1")!.lines[0][field] = 99;
      expect(a.baselineEqual(b, shipmentLinesBaseline(s, "so-1"))).toBe(false);
    }
    const held = shipmentFixture(); held.shipper.customerCreditHold = true;
    expect(shipmentLinesBaseline(held, "so-1").context.editable).toBe(false);
    expect(shipmentContainersBaseline(held, "so-1").context.editable).toBe(true);
    expect(shipmentSerialsBaseline(held, "so-1").context.editable).toBe(true);
    held.permissions.push("action.override_credit_hold");
    expect(shipmentLinesBaseline(held, "so-1").context.editable).toBe(true);
    const released = shipmentFixture(); released.shipper.reversesShipperId = "old-shipment";
    expect(shipmentLinesBaseline(released, "so-1").context.editable).toBe(false);
  });
  it("retains the complete invoice wire shape, including invisible pricing and source links", () => {
    const b = invoiceLinesBaseline(invoiceFixture());
    expect(b.rows[0]).toEqual({ id: "il-1", fields: {
      wireKey: "il-1", parentKey: "il-parent", kind: "OPERATION", orderLineId: "ol-1", processStepCodeId: "step-1",
      surchargeId: "sur-1", orderChargeId: "charge-1", glAccountId: "gl-1", partNumber: "P-10", partName: "Shaft", partDescription: "Turned shaft",
      description: "Hardening", glAccountName: "Sales", qty: "10", weight: "20", eachWeight: "2", pricePer: "POUND", unitPrice: "3.5",
      setupCharge: "4", minimumCharge: "25", breakThreshold: "8", minimumApplied: "false", rate: "0.05", priceSource: "QUOTE",
      sourceQuoteNumber: "1006", needsPrice: "true", wordsChosen: "true", amount: "70",
    } });
    // #587: the CHARGE row's mark reads "false", so the field is the line's own, never a constant.
    expect(b.rows[1].fields.wordsChosen).toBe("false");
    const a = createBulkRecoveryAdapter("invoice-lines", "v1", invoiceBulkCustomization);
    for (const field of Object.keys(b.rows[0].fields) as (keyof typeof b.rows[0]["fields"])[]) {
      const fresh = { ...b, rows: b.rows.map((row, i) => i ? row : { ...row, fields: { ...row.fields, [field]: "changed" } }) };
      expect(a.baselineEqual(b, fresh), field).toBe(false);
    }
    for (const mode of ["add", "change", "remove", "finalized", "deleted", "tax", "prices"] as const) {
      const s = invoiceFixture();
      if (mode === "add") s.invoice.lines.push({ ...s.invoice.lines[1], id: "il-3" });
      if (mode === "change") s.invoice.lines[1].description = "Changed untouched";
      if (mode === "remove") s.invoice.lines.pop();
      if (mode === "finalized") s.invoice.status = "FINALIZED";
      if (mode === "deleted") s.invoice.deletedAt = "2026-09-12";
      if (mode === "tax") s.invoice.taxRate = 0.08;
      if (mode === "prices") s.permissions = ["invoicing.view", "invoicing.edit"];
      expect(a.baselineEqual(b, invoiceLinesBaseline(s)), mode).toBe(false);
    }
  });
  // #587 fix wave (F5): an operation row's words typed away and back leave no edit behind. The saved
  // line's mark is false (the engine's own words), so the hidden "true" a keystroke used to write
  // would have stayed in the overlay, unseen, after the words were typed back: a dirty grid, and a
  // mark that has Recalculate keep the saved words.
  it("invoice: words typed away and back to the saved line's own leave no edit, its mark included", () => {
    const s = invoiceFixture();
    s.invoice.lines[0].description = "Needs price";
    s.invoice.lines[0].wordsChosen = false;
    const b = invoiceLinesBaseline(s);
    const saved = s.invoice.lines[0];
    const away = transitionBulkDraft(emptyBulkDraft(), b, { kind: "edit", id: "il-1", patch: typedPatch("Needs price, rush", saved) });
    expect(away.edits.get("il-1")).toEqual({ description: "Needs price, rush", wordsChosen: "true" });
    const back = transitionBulkDraft(away, b, { kind: "edit", id: "il-1", patch: typedPatch("Needs price", saved) });
    expect(back.edits.size).toBe(0);
  });
  it("payment preserves the complete raw fields and concrete read-authorized legality", () => {
    const b = paymentApplicationBaseline(paymentFixture());
    expect(b.rows[0]).toEqual({ id: "i1", fields: { documentNumber: "INV-101", customerCode: "C1", customerName: "Customer", dueDate: "2026-10-10",
      open: "100", discountAmount: "2", discountSettlingAmount: "", discountWouldEarn: "", amount: "", takeDiscount: "false", writeOffAmount: "", writeOffReason: "" } });
    expect(b.rows[1].fields).toMatchObject({ open: "180", discountAmount: "0", discountSettlingAmount: "176", discountWouldEarn: "4" });
    expect(b.context).toMatchObject({ batch: { id: "batch-1", status: "POSTED", deletedAt: null, depositDate: "2026-09-12" },
      payment: { id: "pay-1", customerId: "cust-1", receivedDate: "2026-09-12", amount: 100, onAccount: 100 },
      editable: true, writeOff: true, candidates: [
        { id: "i1", customerId: "cust-1", orderId: "o1", invoiceDate: "2026-09-10", total: 100, open: 100, status: "FINALIZED", kind: "INVOICE", deletedAt: null,
          discount: { amount: 2, settlingAmount: null, wouldEarn: null } },
        { id: "i2", customerId: "cust-2", orderId: "o2", invoiceDate: "2026-09-11", total: 200, open: 180, status: "FINALIZED", kind: "INVOICE", deletedAt: null,
          discount: { amount: 0, settlingAmount: 176, wouldEarn: 4 } },
      ] });
  });
  it("payment compares all writer conditions but ignores exactly four display-only fields", () => {
    const b = paymentApplicationBaseline(paymentFixture());
    const a = createBulkRecoveryAdapter("payment-application", "v1", paymentBulkCustomization);
    for (const mode of ["add", "change", "remove", "discount", "settlement", "wouldEarn", "onAccount", "amount", "date", "customer", "deleted", "membership", "status", "permission", "writeOff"] as const) {
      const s = paymentFixture();
      if (mode === "add") s.candidates.push({ ...s.candidates[1], id: "i3" });
      if (mode === "remove") s.candidates.pop();
      if (mode === "change") s.candidates[1].open = 160;
      if (mode === "discount") s.candidates[1].discount.amount = 3;
      if (mode === "settlement") s.candidates[1].discount.settlingAmount = 175;
      if (mode === "wouldEarn") s.candidates[1].discount.wouldEarn = 3;
      if (mode === "onAccount") s.batch.payments[0].onAccount = 80;
      if (mode === "amount") s.batch.payments[0].amount = 120;
      if (mode === "date") s.batch.payments[0].receivedDate = "2026-09-13";
      if (mode === "customer") s.batch.payments[0].customerId = "different";
      if (mode === "deleted") s.batch.deletedAt = "2026-09-12";
      if (mode === "membership") s.batch.payments = [];
      if (mode === "status") s.batch.status = "OPEN";
      if (mode === "permission") s.permissions = ["receivables.view", "receivables.create", "action.write_off"];
      if (mode === "writeOff") s.permissions = ["receivables.view", "receivables.create", "action.apply_payments"];
      expect(a.baselineEqual(b, paymentApplicationBaseline(s)), mode).toBe(false);
    }
    const s = paymentFixture(); s.candidates[0].documentNumber = "Label"; s.candidates[0].customerCode = "Name";
    s.candidates[0].customerName = "New display"; s.candidates[0].dueDate = "2026-10-11";
    const relabeled = paymentApplicationBaseline(s);
    expect(relabeled.rows[0].fields).toMatchObject({ documentNumber: "Label", customerName: "New display" });
    expect(a.baselineEqual(b, relabeled)).toBe(true);
    for (const field of ["amount", "takeDiscount", "writeOffAmount", "writeOffReason", "open", "discountAmount", "discountSettlingAmount", "discountWouldEarn"] as const) {
      const fresh = { ...b, rows: b.rows.map((r, i) => i ? r : { ...r, fields: { ...r.fields, [field]: "changed" } }) };
      expect(a.baselineEqual(b, fresh), field).toBe(false);
    }
  });
  it("refuses payment recovery against changed open balances while preserving literal raw amounts", () => {
    const b = paymentApplicationBaseline(paymentFixture());
    const a = createBulkRecoveryAdapter("payment-application", "v1", paymentBulkCustomization);
    const { binding, detach } = openDraftHarness(a, emptyBulkDraft(), b);
    binding.change(d => ({ ...d, edits: new Map([["i1", { amount: " 10.00 ", takeDiscount: "true", writeOffAmount: "bad", writeOffReason: " raw reason " }]]) }));
    detach(); binding.attach("return");
    const s = paymentFixture(); s.candidates[0].open = 80;
    const readId = binding.beginRead(); binding.acceptRead({ kind: "authorized", readId, editable: true, baseline: paymentApplicationBaseline(s) }, emptyBulkDraft());
    expect(binding.getSnapshot().mode).toBe("conflict"); expect(binding.getSnapshot().canRestore).toBe(false);
    expect(binding.getSnapshot().current?.data.edits.get("i1")).toEqual({ amount: " 10.00 ", takeDiscount: "true", writeOffAmount: "bad", writeOffReason: " raw reason " });
  });
  it("takes each candidate's open balance and offer from the one batched read, and rejects a row with no offer (#613)", async () => {
    const rows = paymentFixture().candidates;
    const read = vi.fn(async () => rows.map((r, i) => ({ ...r, open: i ? 160 : 80, discount: { ...r.discount, blockedBy: null } })));
    const candidates = await readPaymentCandidates(read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(candidates.map(r => r.open)).toEqual([80, 160]);
    expect(candidates.map(r => Object.keys(r.discount).sort())).toEqual(rows.map(() => ["amount", "settlingAmount", "wouldEarn"]));
    const [{ discount, ...first }] = rows;
    await expect(readPaymentCandidates(async () => [first as typeof rows[number]])).rejects.toThrow("Candidate read is incomplete.");
    void discount;
    await expect(readPaymentCandidates(async () => { throw new Error("candidates forbidden"); })).rejects.toThrow("candidates forbidden");
  });
  it("previews readable domain labels and never emits hidden internal reference IDs", () => {
    const s = shipmentFixture();
    const line = createBulkRecoveryAdapter("shipment-lines", "v1", shipmentBulkCustomization("lines"));
    const preview = line.preview(emptyBulkDraft(), shipmentLinesBaseline(s, "so-1"));
    expect(preview).toContainEqual({ label: "Row 1 order line", value: "P-10 · Shaft" });
    const inv = createBulkRecoveryAdapter("invoice-lines", "v1", invoiceBulkCustomization);
    const values = inv.preview(emptyBulkDraft(), invoiceLinesBaseline(invoiceFixture()));
    expect(values).toContainEqual({ label: "Row 1 description", value: "Hardening" });
    expect(values.some(v => ["il-1", "il-parent", "ol-1", "step-1", "sur-1", "charge-1", "gl-1"].includes(v.value))).toBe(false);
    expect(values).toContainEqual({ label: "Row 1 source quote number", value: "1006" });
    // #587: the mark is a hidden round-trip field, like the ids: a retained draft's preview names
    // what the operator typed (the words themselves, above), never a "words chosen" flag.
    expect(values.filter(v => v.label.endsWith(" words chosen"))).toEqual([]);
  });
  it("uses concrete normal route links and the payment key that authorizes child membership", () => {
    const source = { read: vi.fn(), register: vi.fn(), begin: vi.fn() };
    expect(shipmentBulkOptions(source, "ship-1", "so-1", "lines").href).toBe("/shipping/ship-1");
    expect(invoiceBulkOptions(source, "inv-1").href).toBe("/invoicing/inv-1");
    const options = paymentBulkOptions(source, "batch-1", "pay-1");
    expect(options.href).toBe("/receivables/batches/batch-1");
    expect(options.record).toEqual({ kind: "payment", id: "batch-1" }); expect(options.childId).toBe("pay-1");
  });
});

// ---- a shipment's Containers grid: the tare each field (the weights design §12.2) ----

describe("a shipment's Containers grid: tare each in its recovery", () => {
  type Row = Record<string, string>;
  // The schema's name as production gives it (`shipmentBulkOptions`; the last case of this block holds it).
  const containers = () => createBulkRecoveryAdapter<Row>("shipment-containers", "shipment-containers-v2", shipmentBulkCustomization("containers") as BulkRecoveryCustomization<Row>);

  it("the order read's container rows become catalog rows with their tare each, a 0 as 0 and none as null", () => {
    expect(toShipmentCatalog({ lines: [], serials: [], containers: [
      { id: "oc-1", count: 3, customerContainerId: "BIN-0007", type: { name: "Steel Basket" }, tareEach: 42.5 },
      { id: "oc-2", count: 14, customerContainerId: "", type: { name: "Bin" }, tareEach: 0 },
      { id: "oc-3", count: 2, customerContainerId: "", type: { name: "Skid" }, tareEach: null },
      { id: "oc-4", count: 1, customerContainerId: "", type: { name: "Crate" } },
    ] }).containers).toEqual([
      { id: "oc-1", typeName: "Steel Basket", customerContainerId: "BIN-0007", count: 3, tareEach: 42.5 },
      { id: "oc-2", typeName: "Bin", customerContainerId: "", count: 14, tareEach: 0 },
      { id: "oc-3", typeName: "Skid", customerContainerId: "", count: 2, tareEach: null },
      { id: "oc-4", typeName: "Crate", customerContainerId: "", count: 1, tareEach: null },
    ]);
  });

  it("offers the order's rows with the order's tare each, compares their id and number of containers only, and has no order figure without orders.view", () => {
    const baseline = shipmentContainersBaseline(shipmentFixture(), "so-1");
    expect(baseline.context.catalog).toEqual([{ id: "oc-1", count: 2 }, { id: "oc-2", count: 1 }]);
    expect(shipmentDisplayFromBaseline(baseline).containers).toEqual([
      { id: "oc-1", typeName: "Box", customerContainerId: "B-10", count: 2, tareEach: 55 },
      { id: "oc-2", typeName: "Drum", customerContainerId: "D-20", count: 1, tareEach: 12.25 },
    ]);
    const shippingOnly = shipmentFixture(); shippingOnly.permissions = ["shipping.view", "shipping.edit"];
    expect(shipmentDisplayFromBaseline(shipmentContainersBaseline(shippingOnly, "so-1")).containers).toEqual([
      { id: "oc-1", typeName: "Box", customerContainerId: "B-10", count: 2, tareEach: null },
      { id: "oc-2", typeName: "Drum", customerContainerId: "D-20", count: 1, tareEach: null },
    ]);
  });

  it("a changed tare each on the order's row sets no draft aside, and a changed figure on the shipment's own row does", () => {
    const baseline = shipmentContainersBaseline(shipmentFixture(), "so-1");
    const order = shipmentFixture(); order.catalogs.get("order-1")!.containers[0].tareEach = 99;
    expect(containers().baselineEqual(baseline, shipmentContainersBaseline(order, "so-1"))).toBe(true);
    const shipment = shipmentFixture(); shipment.shipper.orders[0].containers[0].tareEach = 99;
    expect(containers().baselineEqual(baseline, shipmentContainersBaseline(shipment, "so-1"))).toBe(false);
  });

  it("the notice lists each row's order container, its count and its tare each, in that order", () => {
    const baseline = shipmentContainersBaseline(shipmentFixture(), "so-1");
    const draft = { ...emptyBulkDraft<Row>(), edits: new Map([["sc-1", { tareEach: " 40.25 " }]]) };
    expect(containers().preview(draft, baseline)).toEqual([
      { label: "Row 1 order container", value: "Box · B-10" }, { label: "Row 1 count", value: "2" }, { label: "Row 1 tare each", value: " 40.25 " },
      { label: "Row 2 order container", value: "Drum · D-20" }, { label: "Row 2 count", value: "1" }, { label: "Row 2 tare each", value: "310" },
    ]);
  });

  it("a draft row is three fields of text, and an offered order row carries a tare each that is a number or null", () => {
    const base = () => shipmentContainersBaseline(shipmentFixture(), "so-1");
    const clean = emptyBulkDraft<Row>();
    // An edit of the third field is a draft. An added row without it is not.
    expect([{ ...clean, edits: new Map([["sc-1", { tareEach: " 40.25 " }]]) }, { ...clean, added: [{ clientId: "new-1", orderContainerId: "oc-9", count: "1" }] }]
      .map(draft => containers().valid(draft, base()))).toEqual([true, false]);
    /** The baseline with its first offered order row changed by hand. */
    const offered = (change: (row: Record<string, unknown>) => void) => {
      const baseline = base();
      change((baseline.context.display as unknown as { containers: Record<string, unknown>[] }).containers[0]);
      return containers().valid(clean, baseline);
    };
    expect(offered((row) => { row.tareEach = null; })).toBe(true);
    expect(offered((row) => { row.tareEach = "55"; })).toBe(false);
  });

  it("names the Containers grid's recovery schema v2, and leaves Lines and Serials at v1", () => {
    const source = { read: vi.fn(), register: vi.fn(), begin: vi.fn() };
    expect((["lines", "containers", "serials"] as const).map(kind => shipmentBulkOptions(source, "ship-1", "so-1", kind).schema))
      .toEqual(["shipment-lines-v1", "shipment-containers-v2", "shipment-serials-v1"]);
  });
});

// ---- kept container rows in the Containers grid's recovery (the weights design §12.2 and §12.3: C11, C13) ----

describe("a kept container row in the Containers grid's recovery", () => {
  /** The owner's example of the notice (C13): Steel Basket · BIN-0007, 3 at 42.5, has lost its order
   *  row and is stored AFTER Skid, 2 at 30, which still has one. */
  function keptAndLinked(): ReturnType<typeof shipmentFixture> {
    const s = shipmentFixture();
    s.shipper.orders[0].containers = [
      { id: "sc-1", orderContainerId: "oc-1", typeName: "Skid", customerContainerId: "", count: 2, tareEach: 30, position: 1 },
      { id: "sc-2", orderContainerId: null, typeName: "Steel Basket", customerContainerId: "BIN-0007", count: 3, tareEach: 42.5, position: 2 },
    ];
    s.catalogs.get("order-1")!.containers = [{ id: "oc-1", typeName: "Skid", customerContainerId: "", count: 2, tareEach: 30 }];
    return s;
  }
  // Each adapter here takes its schema's name as production gives it: v2 for Containers, whose
  // rows gained a field, and v1 still for Lines (the block above holds both names).
  const containers = createBulkRecoveryAdapter("shipment-containers", "shipment-containers-v2", shipmentBulkCustomization("containers"));
  const displayOf = (b: { context: { display?: unknown } }) => b.context.display as Record<string, unknown>;

  it("lists the kept row first, with its three fields and no order container", () => {
    expect(shipmentContainersBaseline(keptAndLinked(), "so-1").rows).toEqual([
      { id: "sc-2", fields: { orderContainerId: "", count: "3", tareEach: "42.5" } },
      { id: "sc-1", fields: { orderContainerId: "oc-1", count: "2", tareEach: "30" } },
    ]);
  });

  it.each([
    ["with orders.view", ["shipping.view", "shipping.edit", "orders.view"]],
    ["without orders.view, from the shipment's own row", ["shipping.view", "shipping.edit"]],
  ])("describes it under display.kept by the shipment row's own id: %s", (_what, permissions) => {
    const s = keptAndLinked(); s.permissions = permissions;
    expect(displayOf(shipmentContainersBaseline(s, "so-1")).kept)
      .toEqual([{ id: "sc-2", typeName: "Steel Basket", customerContainerId: "BIN-0007", count: 3 }]);
  });

  it("carries an empty kept list for a panel with no kept row", () => {
    expect(displayOf(shipmentContainersBaseline(shipmentFixture(), "so-1")).kept).toEqual([]);
  });

  it.each([
    ["no kept list", (display: Record<string, unknown>) => ({ containers: display.containers })],
    ["a kept row with no number of containers", (display: Record<string, unknown>) => ({ ...display, kept: [{ id: "sc-2", typeName: "Steel Basket", customerContainerId: "BIN-0007" }] })],
  ])("the store refuses a Containers baseline with %s", (_what, change) => {
    const b = shipmentContainersBaseline(keptAndLinked(), "so-1");
    expect(containers.valid(emptyBulkDraft(), { ...b, context: { ...b.context, display: change(displayOf(b)) } })).toBe(false);
  });

  it("the kept list is the Containers grid's alone: a Lines baseline is refused with one", () => {
    const lines = createBulkRecoveryAdapter("shipment-lines", "shipment-lines-v1", shipmentBulkCustomization("lines"));
    const b = shipmentLinesBaseline(keptAndLinked(), "so-1");
    const withKept = { ...b, context: { ...b.context, display: { ...displayOf(b), kept: [] } } };
    expect([lines.valid(emptyBulkDraft(), b), lines.valid(emptyBulkDraft(), withKept)]).toEqual([true, false]);
  });

  it("the notice names every row of the table, kept rows first, three lines a row (C13)", () => {
    expect(containers.preview(emptyBulkDraft(), shipmentContainersBaseline(keptAndLinked(), "so-1"))).toEqual([
      { label: "Row 1 order container", value: "Steel Basket · BIN-0007 (kept)" },
      { label: "Row 1 count", value: "3" },
      { label: "Row 1 tare each", value: "42.5" },
      { label: "Row 2 order container", value: "Skid" },
      { label: "Row 2 count", value: "2" },
      { label: "Row 2 tare each", value: "30" },
    ]);
  });

  // The notice asks `isKeptContainer` whether a row is kept, and that is a row that names no order
  // container. This draft gives sc-2, the kept row's key, an order container.
  it("a draft edit that names an order container on a kept row's key is read as that order container, not as kept", () => {
    const draft: Parameters<typeof containers.preview>[0] = { ...emptyBulkDraft(), edits: new Map([["sc-2", { orderContainerId: "oc-1" }]]) };
    expect(containers.preview(draft, shipmentContainersBaseline(keptAndLinked(), "so-1"))[0])
      .toEqual({ label: "Row 1 order container", value: "Skid" });
  });

  it("a tare each typed on a kept row is retained, offered on return and restored", () => {
    const b = shipmentContainersBaseline(keptAndLinked(), "so-1");
    const { binding, detach } = openDraftHarness(containers, emptyBulkDraft(), b);
    binding.change(d => transitionBulkDraft(d, b, { kind: "edit", id: "sc-2", patch: { tareEach: "40" } }));
    // The page is left and come back to. The fresh read is of the same shipment.
    detach(); binding.attach("return");
    const readId = binding.beginRead();
    binding.acceptRead({ kind: "authorized", readId, baseline: shipmentContainersBaseline(keptAndLinked(), "so-1"), editable: true }, emptyBulkDraft());
    const offered = binding.getSnapshot();
    if (offered.current) binding.restore(offered.current.stamp, readId);
    const restored = binding.getSnapshot();
    expect([offered.mode, restored.mode, [...(restored.current?.data.edits ?? [])]]).toEqual(["offer", "editing", [["sc-2", { tareEach: "40" }]]]);
  });
});
