// erp/tests/line-completion.test.ts
import { describe, it, expect } from "vitest";
import { rowCompletesLine } from "@/app/shipping/ShipmentGrids";
import {
  lineIsComplete, deriveShipStatus, completeAsOf, lineCompletionDate, shipmentCompletesLine,
  buildShipPrefix, shipStateBelow,
} from "@/lib/line-completion";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe("lineIsComplete", () => {
  it("is complete when shipped reaches ordered", () => {
    expect(lineIsComplete({ orderedQty: 32, shippedQty: 32, closedShort: false })).toBe(true);
  });
  it("is complete when over-shipped", () => {
    expect(lineIsComplete({ orderedQty: 300, shippedQty: 310, closedShort: false })).toBe(true);
  });
  it("is open when short and not closed", () => {
    expect(lineIsComplete({ orderedQty: 32, shippedQty: 31, closedShort: false })).toBe(false);
  });
  it("is complete when short and closed short", () => {
    expect(lineIsComplete({ orderedQty: 32, shippedQty: 30, closedShort: true })).toBe(true);
  });
});

describe("deriveShipStatus", () => {
  const line = (orderedQty: number, shippedQty: number, hasLiveShipment = shippedQty !== 0, closedShort = false) =>
    ({ orderedQty, shippedQty, closedShort, hasLiveShipment });
  it("is OPEN with no live shipment on any line", () => {
    expect(deriveShipStatus([line(10, 0), line(5, 0)])).toBe("OPEN");
  });
  it("is OPEN for an order with no lines", () => {
    expect(deriveShipStatus([])).toBe("OPEN");
  });
  it("is PARTIAL_SHIPPED while any line is short", () => {
    expect(deriveShipStatus([line(10, 10), line(5, 0)])).toBe("PARTIAL_SHIPPED");
  });
  it("is SHIPPED when every line is complete", () => {
    expect(deriveShipStatus([line(10, 10), line(5, 6)])).toBe("SHIPPED");
  });
  it("is PARTIAL_SHIPPED, not OPEN, when a reversal leaves net zero on a live line", () => {
    expect(deriveShipStatus([line(10, 0, true)])).toBe("PARTIAL_SHIPPED");
  });
  it("is SHIPPED when the only short line is closed short", () => {
    expect(deriveShipStatus([line(10, 8, true, true)])).toBe("SHIPPED");
  });
});

describe("completeAsOf", () => {
  const rows = [
    { sequence: 1, qty: 4, closedShort: false },
    { sequence: 2, qty: 6, closedShort: false },
  ];
  it("counts only shipments up to the sequence asked about", () => {
    expect(completeAsOf(rows, 10, 1)).toBe(false);
    expect(completeAsOf(rows, 10, 2)).toBe(true);
  });
  it("honours a close short only from its own sequence on", () => {
    const short = [{ sequence: 1, qty: 4, closedShort: false }, { sequence: 2, qty: 1, closedShort: true }];
    expect(completeAsOf(short, 10, 1)).toBe(false);
    expect(completeAsOf(short, 10, 2)).toBe(true);
  });
});

describe("buildShipPrefix and shipStateBelow", () => {
  const r = (sequence: number, qty: number, closedShort = false) => ({ sequence, qty, closedShort });
  it("sorts unsorted input and reads the total strictly below a sequence", () => {
    const prefix = buildShipPrefix([r(3, 5), r(1, 4), r(2, 6)]);
    expect(prefix.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(shipStateBelow(prefix, 3)).toEqual({ shippedQty: 10, closedShort: false });
    expect(shipStateBelow(prefix, 2)).toEqual({ shippedQty: 4, closedShort: false });
  });
  it("excludes a row at exactly the sequence asked about", () => {
    const prefix = buildShipPrefix([r(1, 4), r(2, 6)]);
    expect(shipStateBelow(prefix, 2).shippedQty).toBe(4);
    expect(shipStateBelow(prefix, 1).shippedQty).toBe(0);
  });
  it("lets a reversal's negative quantity lower the running total", () => {
    const prefix = buildShipPrefix([r(1, 10), r(2, -10), r(3, 10)]);
    expect(shipStateBelow(prefix, 3).shippedQty).toBe(0);
    expect(shipStateBelow(prefix, 4).shippedQty).toBe(10);
  });
  it("counts a close short only from its own sequence on", () => {
    const prefix = buildShipPrefix([r(1, 4), r(2, 1, true), r(3, 1)]);
    expect(shipStateBelow(prefix, 2).closedShort).toBe(false);
    expect(shipStateBelow(prefix, 3).closedShort).toBe(true);
    expect(shipStateBelow(prefix, 9).closedShort).toBe(true);
  });
  it("answers zero for an empty list", () => {
    expect(buildShipPrefix([])).toEqual([]);
    expect(shipStateBelow([], 5)).toEqual({ shippedQty: 0, closedShort: false });
  });
  it("answers zero below the first sequence and the full total above the last", () => {
    const prefix = buildShipPrefix([r(2, 4), r(5, 6, true)]);
    expect(shipStateBelow(prefix, 1)).toEqual({ shippedQty: 0, closedShort: false });
    expect(shipStateBelow(prefix, 99)).toEqual({ shippedQty: 10, closedShort: true });
  });
  it("does not mutate its input", () => {
    const input = [r(2, 1), r(1, 1)];
    buildShipPrefix(input);
    expect(input.map((x) => x.sequence)).toEqual([2, 1]);
  });
});

describe("lineCompletionDate", () => {
  const row = (shipDate: string, sequence: number, qty: number, closedShort = false, reversedLive = false) =>
    ({ shipDate: d(shipDate), sequence, qty, closedShort, reversedLive });
  it("is the ship date on which the running quantity reaches ordered", () => {
    expect(lineCompletionDate([row("2026-06-10", 1, 4), row("2026-06-12", 2, 6)], 10)).toEqual(d("2026-06-12"));
  });
  it("orders rows by ship date, then sequence, not by input order", () => {
    expect(lineCompletionDate([row("2026-06-12", 2, 6), row("2026-06-10", 1, 4)], 10)).toEqual(d("2026-06-12"));
  });
  it("takes the re-ship date after a reversal", () => {
    const rows = [row("2026-06-10", 1, 10), row("2026-06-15", 2, -10), row("2026-06-20", 3, 10)];
    expect(lineCompletionDate(rows, 10)).toEqual(d("2026-06-20"));
  });
  it("is null while the line is short and not closed", () => {
    expect(lineCompletionDate([row("2026-06-10", 1, 4)], 10)).toBeNull();
  });
  it("is null when a reversal leaves the line short again", () => {
    const rows = [
      { shipDate: d("2026-06-10"), sequence: 1, qty: 10, closedShort: false, reversedLive: false },
      { shipDate: d("2026-06-15"), sequence: 2, qty: -10, closedShort: false, reversedLive: false },
    ];
    expect(lineCompletionDate(rows, 10)).toBeNull();
  });
  it("is the close-short ship date for a line that never reaches ordered", () => {
    expect(lineCompletionDate([row("2026-06-10", 1, 4), row("2026-06-14", 2, 2, true)], 10)).toEqual(d("2026-06-14"));
  });
  it("ignores a close short on a shipment reversed by a live reversal", () => {
    expect(lineCompletionDate([row("2026-06-10", 1, 4, true, true)], 10)).toBeNull();
  });
  it("does not move the date when a later row over-ships a line that is already complete", () => {
    expect(lineCompletionDate([row("2026-06-10", 1, 10), row("2026-06-12", 2, 5)], 10)).toEqual(d("2026-06-10"));
  });
  it("takes the close-short date when it is earlier than the date quantity was reached", () => {
    const rows = [row("2026-06-10", 1, 4, true), row("2026-06-12", 2, 6)];
    expect(lineCompletionDate(rows, 10)).toEqual(d("2026-06-10"));
  });
  it("takes the date quantity was reached when a close short comes later", () => {
    const rows = [row("2026-06-10", 1, 10), row("2026-06-14", 2, 0, true)];
    expect(lineCompletionDate(rows, 10)).toEqual(d("2026-06-10"));
  });
});

describe("shipmentCompletesLine", () => {
  it("adds ship-now to what other shipments sent", () => {
    expect(shipmentCompletesLine({ orderedQty: 32, shippedToDateQty: 0, savedQty: 0, shipNowQty: 32 })).toBe(true);
    expect(shipmentCompletesLine({ orderedQty: 32, shippedToDateQty: 0, savedQty: 0, shipNowQty: 31 })).toBe(false);
  });
  it("does not double count this shipment's own saved quantity", () => {
    // Shipped to date (20) already includes this shipment's saved 20; retyping 20 must not read 40.
    expect(shipmentCompletesLine({ orderedQty: 32, shippedToDateQty: 20, savedQty: 20, shipNowQty: 20 })).toBe(false);
    expect(shipmentCompletesLine({ orderedQty: 32, shippedToDateQty: 20, savedQty: 20, shipNowQty: 32 })).toBe(true);
  });
  it("is false while ship-now is not a number", () => {
    expect(shipmentCompletesLine({ orderedQty: 32, shippedToDateQty: 0, savedQty: 0, shipNowQty: Number.NaN })).toBe(false);
  });
});

describe("rowCompletesLine", () => {
  const info = { partNumber: "P", partName: "Part", orderedQty: 10, orderedWeight: 50, eachWeight: null };
  const row = (qty: string) => ({ orderLineId: "l1", qty, weight: "0", lineComplete: "false" });
  it("counts the shipment's own saved quantity once", () => {
    // 6 shipped in all, 4 of them on THIS shipment: retyping 4 leaves 6, retyping 8 makes 10.
    expect(rowCompletesLine(row("4"), info, { qty: 6, weight: 0 }, 4)).toBe(false);
    expect(rowCompletesLine(row("8"), info, { qty: 6, weight: 0 }, 4)).toBe(true);
  });
  it("reads unknown line info, a blank box and a missing ledger entry as not completing", () => {
    expect(rowCompletesLine(row("10"), undefined, undefined, 0)).toBe(false);
    expect(rowCompletesLine(row("  "), info, undefined, 0)).toBe(false);
    expect(rowCompletesLine(row("10"), info, undefined, 0)).toBe(true);
  });
});
