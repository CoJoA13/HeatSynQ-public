import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shipmentFingerprintSource, type ShipmentFingerprintInput } from "@/lib/invoice-shipment-fingerprint";

const base: ShipmentFingerprintInput = {
  lines: [{ orderLineId: "b", qty: 8, weight: 20 }, { orderLineId: "a", qty: 3, weight: 7.5 }],
  freight: [{ shipperId: "s2", amount: 100 }, { shipperId: "s1", amount: 25.5 }],
};

describe("shipmentFingerprintSource", () => {
  it("is a fixed canonical text: sorted by id, integer quantities, integer cents", () => {
    expect(shipmentFingerprintSource(base))
      .toBe('{"v":1,"lines":[["a",3,750],["b",8,2000]],"freight":[["s1",2550],["s2",10000]]}');
  });

  it("does not depend on the order the entries arrive in", () => {
    const shuffled = { lines: [...base.lines].reverse(), freight: [...base.freight].reverse() };
    expect(shipmentFingerprintSource(shuffled)).toBe(shipmentFingerprintSource(base));
  });

  it("changes with each input", () => {
    const text = shipmentFingerprintSource(base);
    const variants: ShipmentFingerprintInput[] = [
      { ...base, lines: [{ orderLineId: "b", qty: 9, weight: 20 }, base.lines[1]] },      // a quantity
      { ...base, lines: [{ orderLineId: "b", qty: 8, weight: 20.01 }, base.lines[1]] },   // a weight
      { ...base, lines: [{ orderLineId: "c", qty: 8, weight: 20 }, base.lines[1]] },      // which line
      { ...base, lines: [...base.lines, { orderLineId: "c", qty: 1, weight: 1 }] },        // a line more
      { ...base, freight: [{ shipperId: "s2", amount: 100.01 }, base.freight[1]] },        // an amount
      { ...base, freight: [{ shipperId: "s3", amount: 100 }, base.freight[1]] },           // which shipment
      { ...base, freight: [base.freight[1]] },                                             // a shipment less
    ];
    for (const v of variants) expect(shipmentFingerprintSource(v)).not.toBe(text);
    expect(new Set(variants.map(shipmentFingerprintSource)).size).toBe(variants.length);
  });

  it("formats float sums the same as the exact value", () => {
    const summed = { lines: [{ orderLineId: "a", qty: 1, weight: 0.1 + 0.2 }], freight: [{ shipperId: "s", amount: 0.1 + 0.2 }] };
    const exact = { lines: [{ orderLineId: "a", qty: 1, weight: 0.3 }], freight: [{ shipperId: "s", amount: 0.3 }] };
    expect(shipmentFingerprintSource(summed)).toBe(shipmentFingerprintSource(exact));
  });

  it("leaves out a line that nets to nothing, which is never priced", () => {
    const withZero = { ...base, lines: [...base.lines, { orderLineId: "z", qty: 0, weight: 0 }] };
    expect(shipmentFingerprintSource(withZero)).toBe(shipmentFingerprintSource(base));
    // Quantity zero with weight, or weight zero with quantity, is priced and stays in.
    const qtyOnly = { ...base, lines: [...base.lines, { orderLineId: "z", qty: 1, weight: 0 }] };
    const weightOnly = { ...base, lines: [...base.lines, { orderLineId: "z", qty: 0, weight: 1 }] };
    expect(shipmentFingerprintSource(qtyOnly)).not.toBe(shipmentFingerprintSource(base));
    expect(shipmentFingerprintSource(weightOnly)).not.toBe(shipmentFingerprintSource(base));
  });

  it("is a client-safe leaf: no imports at all", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/invoice-shipment-fingerprint.ts"), "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
  });
});
