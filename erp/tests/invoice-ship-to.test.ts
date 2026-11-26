import { describe, it, expect } from "vitest";
import { invoiceShipToAddressId, type ShipToCandidate } from "@/lib/invoice-ship-to";

// #1055 (owner ruling 2026-11-25): the leaf that picks which shipment a new invoice's Ship-to
// comes from. Each case is mutation-proven: remove the guard it names and it reds.

const ship = (over: Partial<ShipToCandidate> & { id: string }): ShipToCandidate => ({
  shipToAddressId: `addr-${over.id}`,
  shipDate: new Date("2026-11-02T00:00:00Z"),
  createdAt: new Date("2026-11-02T08:00:00Z"),
  deletedAt: null,
  reversesShipperId: null,
  ...over,
});

describe("invoiceShipToAddressId (#1055)", () => {
  it("answers null for no shipments", () => {
    expect(invoiceShipToAddressId([])).toBeNull();
  });

  it("takes the one shipment's ship-to", () => {
    expect(invoiceShipToAddressId([ship({ id: "a" })])).toBe("addr-a");
  });

  it("takes the later ship date, in either order", () => {
    const early = ship({ id: "a", shipDate: new Date("2026-11-01T00:00:00Z"), createdAt: new Date("2026-11-05T00:00:00Z") });
    const late = ship({ id: "b", shipDate: new Date("2026-11-03T00:00:00Z"), createdAt: new Date("2026-11-01T00:00:00Z") });
    expect(invoiceShipToAddressId([early, late])).toBe("addr-b");
    expect(invoiceShipToAddressId([late, early])).toBe("addr-b");
  });

  it("on the same ship date, takes the later-created, in either order", () => {
    const first = ship({ id: "b", createdAt: new Date("2026-11-02T08:00:00Z") });
    const second = ship({ id: "a", createdAt: new Date("2026-11-02T09:00:00Z") });
    expect(invoiceShipToAddressId([first, second])).toBe("addr-a");
    expect(invoiceShipToAddressId([second, first])).toBe("addr-a");
  });

  it("on the same ship date and created time, picks by id, in either order", () => {
    expect(invoiceShipToAddressId([ship({ id: "a" }), ship({ id: "b" })])).toBe("addr-b");
    expect(invoiceShipToAddressId([ship({ id: "b" }), ship({ id: "a" })])).toBe("addr-b");
  });

  it("skips a voided shipment, though it is the latest", () => {
    const live = ship({ id: "a" });
    const voided = ship({ id: "b", shipDate: new Date("2026-11-09T00:00:00Z"), deletedAt: new Date() });
    expect(invoiceShipToAddressId([live, voided])).toBe("addr-a");
  });

  it("skips a reversal, though it is the latest and names a ship-to", () => {
    const original = ship({ id: "a" });
    const reversal = ship({ id: "b", shipDate: new Date("2026-11-09T00:00:00Z"), reversesShipperId: "a", shipToAddressId: "addr-z" });
    expect(invoiceShipToAddressId([original, reversal])).toBe("addr-a");
  });

  it("skips a shipment with no ship-to, though it is the latest", () => {
    const named = ship({ id: "a" });
    const unnamed = ship({ id: "b", shipDate: new Date("2026-11-09T00:00:00Z"), shipToAddressId: null });
    expect(invoiceShipToAddressId([named, unnamed])).toBe("addr-a");
  });

  it("answers null when no live, non-reversal shipment names a ship-to", () => {
    expect(invoiceShipToAddressId([
      ship({ id: "a", shipToAddressId: null }),
      ship({ id: "b", deletedAt: new Date() }),
      ship({ id: "c", reversesShipperId: "a" }),
    ])).toBeNull();
  });
});
