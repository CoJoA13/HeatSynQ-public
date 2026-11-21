import { describe, it, expect } from "vitest";
import { shipmentLinesPayload, lineLedgerFromBaseline, settledLinesBaseline } from "@/lib/shipment-line-save";
import { shipmentLinesBaseline, type ShipmentBulkSnapshot } from "@/lib/shipment-bulk-recovery";
import { rowFinishesLine } from "@/lib/line-completion";
import type { LineFields } from "@/app/shipping/ShipmentGrids";
import type { ShipperOrder } from "@/app/shipping/[id]/ShipmentDetail";

const LINE = "ol-1";
type SavedOrder = Pick<ShipperOrder, "lines" | "orderLineShippedToDate">;
/** The shipment order as the server answers it: this shipment saved `saved`, `others` came from other
 *  shipments, ordered 10. `shippedToDate` is the ledger, which includes this shipment's own quantity. */
function answer(saved: number, others: number, lineComplete = false): SavedOrder {
  return {
    lines: [{ id: "sl-1", orderLineId: LINE, linePosition: 1, partNumber: "P", partName: "Part", orderedQty: 10, orderedWeight: 100,
      shippedToDateQty: saved + others, shippedToDateWeight: 0, qty: saved, weight: 0, lineComplete }],
    orderLineShippedToDate: [{ orderLineId: LINE, shippedToDateQty: saved + others, shippedToDateWeight: 0 }],
  };
}
function loaded(order: SavedOrder) {
  const snapshot = { shipper: { id: "s", customerId: "c", customerCreditHold: false, deletedAt: null, reversesShipperId: null,
    reversedByShipperNumber: null, orders: [{ id: "so-1", orderId: "o-1", ...order }] }, catalogs: new Map(), permissions: ["shipping.edit"] } as unknown as ShipmentBulkSnapshot;
  return shipmentLinesBaseline(snapshot, "so-1");
}
const row = (qty: string, lineComplete: string): LineFields => ({ orderLineId: LINE, qty, weight: "0", lineComplete });
const info = new Map([[LINE, { orderedQty: 10 }]]);
/** What a save of `typed` would send, read through the ledger the baseline carries. */
function sent(baseline: ReturnType<typeof loaded>, typed: LineFields) {
  const { shippedByLineId, savedQtyByLineId } = lineLedgerFromBaseline(baseline);
  const built = shipmentLinesPayload([typed], info, shippedByLineId, savedQtyByLineId);
  if (!built.ok) throw new Error(built.error);
  return built.payload[0].lineComplete;
}

describe("shipmentLinesPayload", () => {
  it("sends a ticked row raised to completion unticked, and a ticked row that stays short ticked", () => {
    const base = loaded(answer(4, 0));
    expect(sent(base, row("10", "true"))).toBe(false);
    expect(sent(base, row("6", "true"))).toBe(true);
    expect(sent(base, row("6", "false"))).toBe(false);
  });
  it("keeps the tick across a mistyped completing quantity: the SAME ticked row state, only the quantity moves", () => {
    const base = loaded(answer(4, 0));
    const ticked = row("6", "true");
    expect(sent(base, ticked)).toBe(true);
    expect(sent(base, { ...ticked, qty: "10" })).toBe(false);
    expect(sent(base, { ...ticked, qty: "6" })).toBe(true);
  });
  it("counts what other shipments shipped", () => {
    // 5 elsewhere + this shipment's 4 saved: typing 5 here finishes the line (5 + 5 = 10), typing 4 does not.
    const base = loaded(answer(4, 5));
    expect(sent(base, row("5", "true"))).toBe(false);
    expect(sent(base, row("4", "true"))).toBe(true);
  });
  it("refuses a bad quantity with its own words, and a bad weight through the one rule, named by its row and its label", () => {
    const { shippedByLineId, savedQtyByLineId } = lineLedgerFromBaseline(loaded(answer(4, 0)));
    const built = (weight: string, qty = "1") => shipmentLinesPayload([{ ...row(qty, "false"), weight }], info, shippedByLineId, savedQtyByLineId);
    expect(built("0", "1.5")).toEqual({ ok: false, error: "Line 1: ship-now quantity must be a whole number of at least 0." });
    // A blank weight reads the rule's sentence (owner answer 2).
    expect([" ", "", "heavy", "1e2", "4.555", "-1", "10000000000"].map((weight) => built(weight))).toEqual([
      { ok: false, error: "Line 1, Ship now net weight (lb): enter a number without $ or commas, such as 0.36." },
      { ok: false, error: "Line 1, Ship now net weight (lb): enter a number without $ or commas, such as 0.36." },
      { ok: false, error: "Line 1, Ship now net weight (lb): enter a number without $ or commas, such as 0.36." },
      { ok: false, error: "Line 1, Ship now net weight (lb): enter a number without $ or commas, such as 0.36." },
      { ok: false, error: "Line 1, Ship now net weight (lb): use at most 2 digits after the point." },
      { ok: false, error: "Line 1, Ship now net weight (lb): cannot be negative." },
      { ok: false, error: "Line 1, Ship now net weight (lb): must be less than 10,000,000,000." },
    ]);
  });
  it("sends a weight the rule takes as its trimmed text: zero, a leading point, trailing zeros", () => {
    const { shippedByLineId, savedQtyByLineId } = lineLedgerFromBaseline(loaded(answer(4, 0)));
    const weights = (weight: string) => {
      const built = shipmentLinesPayload([{ ...row("1", "false"), weight }], info, shippedByLineId, savedQtyByLineId);
      if (!built.ok) throw new Error(built.error);
      return built.payload[0].weight;
    };
    expect(["0", " .36 ", "4.500", "9999999999.99"].map(weights)).toEqual(["0", ".36", "4.500", "9999999999.99"]);
  });
  it("lists every refusal, one per line, rows in the order given and within a row the quantity before the weight", () => {
    const { shippedByLineId, savedQtyByLineId } = lineLedgerFromBaseline(loaded(answer(4, 0)));
    const rows: LineFields[] = [
      { orderLineId: LINE, qty: "1.5", weight: "-2", lineComplete: "false" },
      { orderLineId: "ol-2", qty: "3", weight: "4.00", lineComplete: "false" },
      { orderLineId: "ol-3", qty: "2", weight: " ", lineComplete: "false" },
    ];
    expect(shipmentLinesPayload(rows, info, shippedByLineId, savedQtyByLineId)).toEqual({ ok: false, error: [
      "Line 1: ship-now quantity must be a whole number of at least 0.",
      "Line 1, Ship now net weight (lb): cannot be negative.",
      "Line 3, Ship now net weight (lb): enter a number without $ or commas, such as 0.36.",
    ].join("\n") });
  });
});

describe("settledLinesBaseline keeps rows and ledger as one snapshot", () => {
  it("ordered 10, saved 4, raised to 10 and saved: the finished line is still recognised as finishing", () => {
    const before = loaded(answer(4, 0));
    const settled = settledLinesBaseline(before, answer(10, 0));
    const { shippedByLineId, savedQtyByLineId } = lineLedgerFromBaseline(settled);
    expect(savedQtyByLineId.get(LINE)).toBe(10);
    expect(shippedByLineId.get(LINE)?.qty).toBe(10);
    expect(rowFinishesLine({ qty: "10" }, 10, shippedByLineId.get(LINE)?.qty, savedQtyByLineId.get(LINE) ?? 0)).toBe(true);
  });
  it("saved 10, lowered to 6 with close short ticked and saved: the tick survives a second save", () => {
    const before = loaded(answer(10, 0));
    const settled = settledLinesBaseline(before, answer(6, 0, true));
    expect(settled.rows[0].fields).toMatchObject({ qty: "6", lineComplete: "true" });
    expect(sent(settled, row("6", "true"))).toBe(true);
  });
  it("keeps other shipments' quantity across the settle", () => {
    const settled = settledLinesBaseline(loaded(answer(2, 5)), answer(4, 5));
    const { shippedByLineId, savedQtyByLineId } = lineLedgerFromBaseline(settled);
    expect((shippedByLineId.get(LINE)?.qty ?? 0) - (savedQtyByLineId.get(LINE) ?? 0)).toBe(5);
  });
  it("leaves the baseline's context alone when the answer has no such order", () => {
    const before = loaded(answer(4, 0));
    const settled = settledLinesBaseline(before, undefined);
    expect(settled.context).toBe(before.context);
    expect(settled.rows).toEqual([]);
  });
});
