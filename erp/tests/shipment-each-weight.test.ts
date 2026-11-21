// The part's each weight reaches the shipment Lines grid as DISPLAY data only. On a saved shipment it
// rides the order catalog (so it needs orders.view) and is null on the shipping-only fallback rows; on
// the new-shipment form it rides the order source. It enters neither screen's baseline comparison:
// editing a part's each weight must never turn somebody's unsaved shipment into a draft conflict.
// Pure: no database.
import { describe, expect, it } from "vitest";
import { createBulkRecoveryAdapter, emptyBulkDraft } from "../src/lib/bulk-grid-recovery";
import {
  readShipmentCatalogs, shipmentBulkCustomization, shipmentDisplayFromBaseline, shipmentLinesBaseline, toShipmentCatalog,
  type ShipmentOrderRead,
} from "../src/lib/shipment-bulk-recovery";
import {
  newShipmentBaselineFrom, newShipmentDraftFrom, newShipmentRecoveryAdapter,
  type NewShipmentBaseline, type NewShipmentSource, type ShipmentSeed,
} from "../src/lib/new-shipment-recovery";
import type { LineFields } from "../src/app/shipping/ShipmentGrids";
import { shipmentFixture } from "./helpers/remaining-bulk-fixtures";

/** The adapter the saved page's Lines grid binds (`shipmentBulkOptions`, kind "lines"). */
const linesAdapter = createBulkRecoveryAdapter<LineFields>("shipment-lines", "shipment-lines-v1", shipmentBulkCustomization("lines"));
/** `GET /api/orders/:id` as the shipment page reads it; `eachWeight` omitted = an answer without one. */
function orderRead(eachWeight?: number): ShipmentOrderRead {
  return { lines: [
    { id: "ol-1", position: 1, qty: 10, weight: 20, part: { partNumber: "P-10", name: "Shaft", ...(eachWeight === undefined ? {} : { eachWeight }) } },
    { id: "ol-2", position: 2, qty: 5, weight: 10, part: { partNumber: "P-20", name: "Pin" } },
  ], containers: [], serials: [] };
}

describe("saved shipment: each weight rides the order catalog", () => {
  it("toShipmentCatalog carries the part's each weight and writes null when the read has none", () => {
    expect(toShipmentCatalog(orderRead(1.5)).lines).toStrictEqual([
      { id: "ol-1", position: 1, partNumber: "P-10", partName: "Shaft", qty: 10, weight: 20, eachWeight: 1.5 },
      { id: "ol-2", position: 2, partNumber: "P-20", partName: "Pin", qty: 5, weight: 10, eachWeight: null },
    ]);
  });

  it("the lines baseline's display rows carry each weight on the catalog branch", () => {
    const fixture = shipmentFixture();
    const lines = fixture.catalogs.get("order-1")!.lines;
    lines[0].eachWeight = 1.5; lines[1].eachWeight = null;
    const baseline = shipmentLinesBaseline(fixture, "so-1");
    expect(baseline.context.catalogAuthorized).toBe(true);
    expect(shipmentDisplayFromBaseline(baseline).lines.map(l => [l.id, l.eachWeight])).toStrictEqual([["ol-1", 1.5], ["ol-2", null]]);
    expect(linesAdapter.valid(emptyBulkDraft<LineFields>(), baseline)).toBe(true);
  });

  it("the fallback display rows (no orders.view) carry null, never undefined", () => {
    const fixture = shipmentFixture(); fixture.permissions = ["shipping.view", "shipping.edit"];
    const baseline = shipmentLinesBaseline(fixture, "so-1");
    expect(baseline.context.catalogAuthorized).toBe(false);
    // The store's own acceptance check: `contextValid` refuses `undefined` anywhere in a baseline context.
    expect(linesAdapter.valid(emptyBulkDraft<LineFields>(), baseline)).toBe(true);
    expect((baseline.context.display as { lines: unknown[] }).lines).toStrictEqual([
      { id: "ol-1", partNumber: "P-10", partName: "Shaft", qty: 10, weight: 20, eachWeight: null },
      { id: "ol-2", partNumber: "P-20", partName: "Pin", qty: 5, weight: 10, eachWeight: null },
    ]);
  });

  it("an order read with no each weight still projects a baseline the store accepts", async () => {
    const fixture = shipmentFixture();
    const snapshot = await readShipmentCatalogs({ record: fixture.shipper, access: fixture.permissions }, async () => orderRead());
    const baseline = shipmentLinesBaseline(snapshot, "so-1");
    expect(baseline.context.catalogAuthorized).toBe(true);
    expect(linesAdapter.valid(emptyBulkDraft<LineFields>(), baseline)).toBe(true);
    expect(shipmentDisplayFromBaseline(baseline).lines.map(l => l.eachWeight)).toStrictEqual([null, null]);
  });

  it("context.catalog rows stay exactly { id, qty, weight }", () => {
    expect(shipmentLinesBaseline(shipmentFixture(), "so-1").context.catalog).toStrictEqual([
      { id: "ol-1", qty: 10, weight: 20 }, { id: "ol-2", qty: 5, weight: 10 },
    ]);
  });

  it("two baselines that differ only in each weight are equal under the grid's own comparison", () => {
    const saved = shipmentLinesBaseline(shipmentFixture(), "so-1");
    for (const eachWeight of [9.9999, null]) {
      const fixture = shipmentFixture();
      fixture.catalogs.get("order-1")!.lines[0].eachWeight = eachWeight;
      const fresh = shipmentLinesBaseline(fixture, "so-1");
      // The change did reach the fresh baseline, so equality below is the comparison's doing.
      expect(shipmentDisplayFromBaseline(fresh).lines[0].eachWeight, String(eachWeight)).toBe(eachWeight);
      expect(shipmentDisplayFromBaseline(saved).lines[0].eachWeight, String(eachWeight)).not.toBe(eachWeight);
      expect(linesAdapter.baselineEqual(saved, fresh), String(eachWeight)).toBe(true);
    }
  });
});

const seed: ShipmentSeed = { clientRequestId: "3f6a1b2c-1111-4d22-8e33-9f0a1b2c3d4e", defaultShipDate: "2026-09-12", defaultFreightTerms: "PREPAID" };
function source(eachWeight?: number): NewShipmentSource {
  return { permissions: ["shipping.create", "shipping.view", "customers.view", "orders.view"],
    customer: { id: "customer", code: "C", name: "Customer", creditHold: false }, addresses: [], carriers: [],
    orders: [{ id: "order", customerId: "customer", orderNumber: 42, poNumber: "PO", customerJobNo: "JOB", status: "OPEN", voided: false,
      lines: [{ id: "line", position: 1, qty: 10, weight: 20, part: { partNumber: "P", name: "Part", ...(eachWeight === undefined ? {} : { eachWeight }) } }],
      containers: [], serials: [], orderLineShippedToDate: [{ orderLineId: "line", shippedToDateQty: 0, shippedToDateWeight: 0 }] }] };
}
function formSource(baseline: NewShipmentBaseline): NewShipmentSource {
  if (baseline.kind !== "form") throw new Error("expected a form baseline");
  return baseline.source;
}
/** A form baseline whose one line carries this value as its each weight, whatever its type. Built by
 *  hand because `newShipmentBaselineFrom` copies numbers only, so it cannot produce the bad cases. */
function formWithEachWeight(value: unknown): NewShipmentBaseline {
  const good = formSource(newShipmentBaselineFrom(source()));
  return { kind: "form", source: { ...good, orders: good.orders.map(o => ({ ...o,
    lines: o.lines.map(l => ({ ...l, part: { ...l.part, eachWeight: value as number } })) })) } };
}

describe("new shipment form: each weight rides the order source", () => {
  it("newShipmentBaselineFrom copies a numeric each weight, omits the key otherwise, and still drops unrelated endpoint fields", () => {
    const line = (id: string, part: Record<string, unknown>) => ({ id, position: 1, qty: 10, weight: 20, quoteId: "PRIVATE QUOTE ID",
      part: { partNumber: id, name: "Part", internalMetadata: "PRIVATE PART", ...part } as { partNumber: string; name: string; eachWeight?: number } });
    const response = { ...source(), orders: [{ ...source().orders[0], notes: "PRIVATE ORDER NOTES",
      lines: [line("numeric", { eachWeight: 1.5 }), line("absent", {}), line("text", { eachWeight: "1.5" })] }] };
    const baseline = newShipmentBaselineFrom(response);
    expect(formSource(baseline).orders[0].lines.map(l => l.part)).toStrictEqual([
      { partNumber: "numeric", name: "Part", eachWeight: 1.5 },
      { partNumber: "absent", name: "Part" },
      { partNumber: "text", name: "Part" },
    ]);
    expect(JSON.stringify(baseline)).not.toContain("PRIVATE");
  });

  it("a form baseline is valid with no each weight or a finite one, and invalid with a string, NaN, Infinity or null", () => {
    const draft = newShipmentDraftFrom(seed);
    expect(newShipmentRecoveryAdapter.valid(draft, newShipmentBaselineFrom(source()))).toBe(true);
    expect(newShipmentRecoveryAdapter.valid(draft, newShipmentBaselineFrom(source(1.5)))).toBe(true);
    expect(newShipmentRecoveryAdapter.valid(draft, formWithEachWeight(1.5))).toBe(true);
    for (const [label, bad] of [["a string", "1.5"], ["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY], ["null", null]] as const) {
      expect(newShipmentRecoveryAdapter.valid(draft, formWithEachWeight(bad)), label).toBe(false);
    }
  });

  it("baselineEqual on the new form ignores each weight", () => {
    const light = newShipmentBaselineFrom(source(1.5));
    const heavy = newShipmentBaselineFrom(source(2.25));
    const none = newShipmentBaselineFrom(source());
    // The three baselines do differ, so equality below is `writer()` leaving each weight out.
    expect([light, heavy, none].map(b => formSource(b).orders[0].lines[0].part.eachWeight)).toStrictEqual([1.5, 2.25, undefined]);
    expect(newShipmentRecoveryAdapter.baselineEqual(light, heavy)).toBe(true);
    expect(newShipmentRecoveryAdapter.baselineEqual(light, none)).toBe(true);
  });
});
