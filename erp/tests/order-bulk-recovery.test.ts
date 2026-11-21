import { describe, expect, it, vi } from "vitest";
import type { ContainerTypeOption, OrderDetail } from "../src/app/orders/[id]/page";
import { createBulkRecoveryAdapter, emptyBulkDraft } from "../src/lib/bulk-grid-recovery";
import { createOrderBulkSource, orderBulkOptions, projectCharges, projectContainers, projectLoads, projectSerials, type OrderBulkSnapshot } from "../src/lib/order-bulk-recovery";
import { openDraftHarness } from "./helpers/draft-store";

function fixture(): OrderBulkSnapshot {
  const order: OrderDetail = {
    id: "order-1", orderNumber: 101, customerId: "customer-1", customer: { code: "ACME", name: "Acme" },
    poNumber: "", vsOrderNumber: "", customerJobNo: "", certRequired: false, certScope: "ORDER",
    receivedDate: "2026-09-12", requestDate: "2026-09-13", targetDate: null, status: "OPEN", notes: "", linkGroupId: null,
    voided: false, light: "on_target", travelerPrinted: false, linkedOrders: [],
    orderLineShippedToDate: [{ orderLineId: "line-1", shippedToDateQty: 0, shippedToDateWeight: 0 }],
    lines: [{ id: "line-1", position: 1, partId: "part-1", revisionNumber: 1, qty: 20, weight: 40,
      quoteLineId: null, quoteId: null, quoteNumber: null,
      part: { id: "part-1", partNumber: "P1", name: "Part", customer: { code: "ACME" }, serializationRequired: true, eachWeight: 2 } }],
    containers: [{ id: "container-1", position: 1, typeId: "type-1", count: 2, pieces: null, tareEach: 1.25,
      scaleGross: 4.5, customerContainerId: "  Bin-7  ", type: { name: "Basket" } }],
    charges: [{ id: "charge-1", position: 1, description: "  handling  ", amount: null }],
    loads: [{ id: "load-1", loadNumber: 1, qty: 20, weight: 40 }],
    serials: [{ id: "serial-1", lineId: "line-1", position: 1, serial: " R1 ", description: " raw " }],
  };
  return { order, editable: true, containerTypes: [{ id: "type-1", name: "Basket" }] };
}
describe("complete order editor projections", () => {
  it("projects all container fields and catalog membership with readable preview labels", () => {
    const s = fixture(); const { baseline } = projectContainers(s);
    expect(baseline.rows).toEqual([{ id: "container-1", fields: {
      typeId: "type-1", count: "2", pieces: "", tareEach: "1.25", scaleGross: "4.5", customerContainerId: "  Bin-7  ",
    } }]);
    const adapter = createBulkRecoveryAdapter("order-containers", "order-containers-v2");
    expect(adapter.baselineEqual(baseline, projectContainers({ ...s, containerTypes: [] }).baseline)).toBe(false);
    const preview = adapter.preview(emptyBulkDraft(), baseline);
    expect(preview).toContainEqual({ label: "Row 1 type", value: "Basket" });
    expect(preview.some(row => row.value === "type-1")).toBe(false);
    // The recovery notice builds its labels from the field names (the weights design §9.5, P1).
    expect(preview.map(row => row.label)).toEqual([
      "Row 1 type", "Row 1 count", "Row 1 pieces", "Row 1 tare each", "Row 1 scale gross", "Row 1 customer container id",
    ]);
    for (const field of ["typeId", "count", "pieces", "tareEach", "scaleGross", "customerContainerId"] as const) {
      const changed = { ...baseline, rows: baseline.rows.map(row => ({ ...row, fields: { ...row.fields, [field]: "changed" } })) };
      expect(adapter.baselineEqual(baseline, changed), field).toBe(false);
    }
  });
  it("gives the Containers grid the v2 recovery schema, and every other order grid its v1", () => {
    // The grid's field names changed with their meaning, so a draft of the old shape is not read
    // as one of the new. Those drafts live in page memory and do not outlive a reload.
    const s = fixture();
    const source = createOrderBulkSource(async () => s.order, async () => s);
    expect(orderBulkOptions(source, "order-1", "order-containers", "Containers", projectContainers).schema).toBe("order-containers-v2");
    expect(orderBulkOptions(source, "order-1", "order-charges", "Charges", projectCharges).schema).toBe("order-charges-v1");
    expect(orderBulkOptions(source, "order-1", "order-loads", "Loads", projectLoads).schema).toBe("order-loads-v1");
    expect(orderBulkOptions(source, "order-1", "order-serials", "Serials", snapshot => projectSerials(snapshot, "line-1"), "line-1").schema)
      .toBe("order-serials-v1");
  });
  it("keeps a container type in the recovery context as its id and name: a changed default tare each sets no draft aside", () => {
    const s = fixture();
    const at = (tareEach: number | null): ContainerTypeOption[] => [{ id: "type-1", name: "Basket", tareEach }];
    const before = projectContainers({ ...s, containerTypes: at(42.5) }).baseline;
    const after = projectContainers({ ...s, containerTypes: at(60) }).baseline;
    expect(before.context.containerTypes).toStrictEqual([{ id: "type-1", name: "Basket" }]);
    expect(after.context).toStrictEqual(before.context);
    const adapter = createBulkRecoveryAdapter("order-containers", "order-containers-v2");
    expect(adapter.baselineEqual(before, after)).toBe(true);
    // The catalog itself still counts: a type that is gone is a changed record.
    expect(adapter.baselineEqual(before, projectContainers({ ...s, containerTypes: [] }).baseline)).toBe(false);
  });
  it("retains raw charge whitespace and blank amount and detects untouched charge change", () => {
    const s = fixture(); const { baseline } = projectCharges(s);
    expect(baseline.rows).toEqual([{ id: "charge-1", fields: { description: "  handling  ", amount: "" } }]);
    const adapter = createBulkRecoveryAdapter("order-charges", "v1");
    for (const changes of [{ description: "handling" }, { amount: 1 }]) {
      expect(adapter.baselineEqual(baseline, projectCharges({ ...s, order: { ...s.order,
        charges: [{ ...s.order.charges[0], ...changes }] } }).baseline)).toBe(false);
    }
  });
  it("projects every load field and all immediate split context without requiring parts access", () => {
    const s = fixture(); const { baseline } = projectLoads(s);
    expect(baseline.rows).toEqual([{ id: "load-1", fields: { loadNumber: "1", qty: "20", weight: "40" } }]);
    expect(baseline.context.lines).toEqual([{ id: "line-1", position: 1, partId: "part-1", qty: 20, weight: 40 }]);
    const adapter = createBulkRecoveryAdapter("order-loads", "v1");
    for (const fresh of [
      { ...s, order: { ...s.order, travelerPrinted: true } },
      { ...s, order: { ...s.order, lines: [{ ...s.order.lines[0], qty: 21 }] } },
      { ...s, order: { ...s.order, lines: [{ ...s.order.lines[0], weight: 41 }] } },
      { ...s, order: { ...s.order, lines: [{ ...s.order.lines[0], partId: "another-part" }] } },
      { ...s, order: { ...s.order, loads: [{ ...s.order.loads[0], qty: null }] } },
      { ...s, order: { ...s.order, loads: [{ ...s.order.loads[0], weight: null }] } },
      { ...s, order: { ...s.order, loads: [{ ...s.order.loads[0], loadNumber: 2 }] } },
    ]) expect(adapter.baselineEqual(baseline, projectLoads(fresh).baseline)).toBe(false);
  });
  it("isolates each serial line and compares parent membership, part and serialization context", () => {
    const s = fixture(); const { baseline } = projectSerials(s, "line-1");
    expect(baseline.rows).toEqual([{ id: "serial-1", fields: { serial: " R1 ", description: " raw " } }]);
    expect(projectSerials(s, "missing").editable).toBe(false);
    const adapter = createBulkRecoveryAdapter("order-serials", "v1");
    for (const fresh of [
      { ...s, order: { ...s.order, lines: [] } },
      { ...s, order: { ...s.order, lines: [{ ...s.order.lines[0], partId: "part-2" }] } },
      { ...s, order: { ...s.order, lines: [{ ...s.order.lines[0], part: { ...s.order.lines[0].part, serializationRequired: false } }] } },
      { ...s, order: { ...s.order, serials: [{ ...s.order.serials[0], lineId: "line-2" }] } },
      { ...s, order: { ...s.order, serials: [{ ...s.order.serials[0], description: "changed" }] } },
      { ...s, order: { ...s.order, serials: [{ ...s.order.serials[0], serial: "changed" }] } },
    ]) expect(adapter.baselineEqual(baseline, projectSerials(fresh, "line-1").baseline)).toBe(false);
  });
  it("retains manual loads after rejected re-split and consumes them after acknowledged re-split", async () => {
    const projection = projectLoads(fixture());
    const adapter = createBulkRecoveryAdapter<{ loadNumber: string; qty: string; weight: string }>("order-loads", "v1");
    const { binding } = openDraftHarness(adapter, emptyBulkDraft<{ loadNumber: string; qty: string; weight: string }>(), projection.baseline);
    binding.change(d => ({ ...d, edits: new Map([["load-1", { qty: "unvalidated" }]]) }));
    const rejected = binding.capture({ action: "resplit" }, "resplit-rejected"); binding.dispatched(rejected);
    binding.settle(rejected, { kind: "rejected" });
    expect(binding.getSnapshot().current!.data.edits.get("load-1")).toEqual({ qty: "unvalidated" });
    const submitted = binding.capture({ action: "resplit" }, "resplit-accepted"); binding.dispatched(submitted);
    const fresh = fixture(); fresh.order.loads = [{ id: "load-1", loadNumber: 1, qty: 10, weight: 20 }, { id: "load-2", loadNumber: 2, qty: 10, weight: 20 }];
    binding.settle(submitted, { kind: "persisted", response: projectLoads(fresh).baseline });
    expect(binding.getSnapshot().current!.data.edits.size).toBe(0);
    const readId = binding.beginRead();
    binding.acceptRead({ kind: "authorized", readId, ...projectLoads(fresh) }, emptyBulkDraft());
    expect(binding.getSnapshot().mode).toBe("editing");
    expect(binding.getSnapshot().needsRefresh).toBe(false);
    expect(binding.getSnapshot().current!.baseline.rows).toHaveLength(2);
  });
});

describe("parent pre-dispatch provenance", () => {
  it("captures only already registered listeners and publishes only accepted native responses", async () => {
    const s = fixture(); const events: string[] = [];
    const source = createOrderBulkSource(async () => s.order, async () => { events.push("access dispatched"); return s; });
    const accepted = vi.fn(); const late = vi.fn();
    source.register(() => { events.push("captured"); return accepted; });
    const request = source.begin(); events.push("mutation dispatched");
    source.register(() => late);
    expect(events).toEqual(["captured", "access dispatched", "mutation dispatched"]);
    expect(accepted).not.toHaveBeenCalled();
    await request.accept(s.order);
    expect(accepted).toHaveBeenCalledWith(s); expect(late).not.toHaveBeenCalled();
  });
  it("ignores responses older than an accepted result and reports failed fresh access as unavailable", async () => {
    const s = fixture(); const accepted = vi.fn();
    const source = createOrderBulkSource(async () => s.order, async () => { throw new Error("forbidden"); });
    source.register(() => accepted);
    const old = source.begin(); const current = source.begin();
    await current.accept(s.order); expect(accepted).toHaveBeenCalledWith(null);
    accepted.mockClear();
    await old.accept(s.order); expect(accepted).not.toHaveBeenCalled();
  });
});
