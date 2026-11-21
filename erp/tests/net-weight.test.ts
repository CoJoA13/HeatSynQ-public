import { describe, it, expect } from "vitest";
import {
  netWeightCents, calculatedNetWeight, lineWeightOffer, shipNowWeightOffer,
  weightOfferSum, weightOfferUse, weightOfferBlocked, tareEachCents, tareTotalCents, tareTotal, weightTotals,
  scaleGrossCents, weighedNet, weighedDifferenceCents, impliedPieces, shipmentWeightTotals,
  type ImpliedLine, type ShipmentOrderWeights, type ShipmentWeightTotals, type TareRow, type WeighedNet, type WeighedRow,
  type WeightInput, type WeightOffer, type WeightTotals,
} from "@/lib/net-weight";
import { computeLineWeight } from "@/app/orders/new/OrderLineCard";
import type { PartOption } from "@/app/orders/new/order-draft";

// Net weight = quantity × each weight (the quantity corrections design §4 and §8). One leaf states
// it for order entry, the order hub's add-rider default, and the weight offered on the order hub and
// in the shipment Lines grid after a quantity changes.

describe("calculatedNetWeight", () => {
  it("the owner's case: 32 pieces at 1.5 lb each is 48 lb", () => {
    expect(netWeightCents(32, 1.5)).toBe(4800);
    expect(calculatedNetWeight(32, 1.5)).toBe(48);
  });

  it.each([
    [1, 1.005, 1.01],
    [1, 1.255, 1.26],
    [10, 0.0055, 0.06],
    [15, 0.009, 0.14],
  ])("rounds an exact half cent up: %d × %d is %d", (quantity, eachWeight, pounds) => {
    expect(calculatedNetWeight(quantity, eachWeight)).toBe(pounds);
  });

  it("keeps float noise out of the figure", () => {
    const tenths = calculatedNetWeight(3, 0.1);
    expect(tenths).toBe(0.3);
    expect(String(tenths)).toBe("0.3");
    expect(calculatedNetWeight(7, 19.99)).toBe(139.93);
  });

  it("zero pieces weigh zero", () => {
    expect(netWeightCents(0, 1.5)).toBe(0);
    expect(calculatedNetWeight("0", "1.5")).toBe(0);
  });

  it.each<[string, WeightInput]>([
    ["null", null], ["undefined", undefined], ["a blank", ""], ["text", "abc"], ["zero", 0],
    ["a zero decimal", "0.0000"], ["a negative number", -1.5], ["a negative decimal", "-1.5"],
    ["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY], ["a five-decimal string", "1.23456"],
    ["a number below one ten-thousandth of a pound", 0.00001],
  ])("is null when the each weight is %s", (_name, eachWeight) => {
    expect(netWeightCents(32, eachWeight)).toBeNull();
    expect(calculatedNetWeight(32, eachWeight)).toBeNull();
  });

  it("reads decimals that arrive as strings", () => {
    expect(calculatedNetWeight("32", "1.5000")).toBe(48);
    expect(calculatedNetWeight(" 32 ", " 1.5 ")).toBe(48);
    expect(calculatedNetWeight("7", "19.9900")).toBe(139.93);
  });

  it.each<[string, WeightInput]>([
    ["a negative number", -1], ["a negative string", "-1"], ["a fraction", 1.5],
    ["a fraction as text", "1.5"], ["a blank", ""], ["spaces", "   "], ["text", "abc"],
    ["null", null], ["undefined", undefined], ["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY],
    ["a whole number typed with a decimal point", "5.0"], ["an exponent", "1e2"],
  ])("is null when the quantity is %s", (_name, quantity) => {
    expect(netWeightCents(quantity, 1.5)).toBeNull();
    expect(calculatedNetWeight(quantity, 1.5)).toBeNull();
  });

  it("is null, not NaN, for zero pieces at an each weight that is not finite", () => {
    expect(netWeightCents(0, Number.POSITIVE_INFINITY)).toBeNull();
  });

  describe("the Decimal(12,2) ceiling", () => {
    it("keeps exactly 9,999,999,999.99 lb", () => {
      expect(netWeightCents(100_000_100, 99.9999)).toBe(999_999_999_999);
      expect(calculatedNetWeight(100_000_100, 99.9999)).toBe(9_999_999_999.99);
    });
    it("is null one cent past it", () => {
      expect(calculatedNetWeight(100_000_000, 100)).toBeNull();
    });
    it("is null for the largest quantity and each weight the server accepts", () => {
      expect(calculatedNetWeight(10_000_000, 999999.9999)).toBeNull();
      expect(calculatedNetWeight("9999999999", "999999.9999")).toBeNull();
    });
  });
});

describe("lineWeightOffer", () => {
  it("the owner's case: 32 × 1.5 over a stored 498 offers 48", () => {
    expect(lineWeightOffer({ quantity: 32, eachWeight: 1.5, storedWeight: 498 }))
      .toEqual({ quantity: 32, eachWeight: 1.5, pounds: 48, belowShipped: null });
  });

  it.each<[WeightInput]>([[48], ["48"], ["48.0"], ["48.00"], [" 48 "]])(
    "offers nothing when the stored weight %j equals the figure to the cent", (storedWeight) => {
      expect(lineWeightOffer({ quantity: 32, eachWeight: 1.5, storedWeight })).toBeNull();
    });

  it("offers nothing when the figure equals the stored weight after rounding", () => {
    // 3 × 0.3333 = 0.9999 lb, which is 1.00 lb to the cent.
    expect(lineWeightOffer({ quantity: 3, eachWeight: 0.3333, storedWeight: 1 })).toBeNull();
  });

  it.each([
    [3, 1.45, 4.35],
    [1, 1.15, 1.15],
    [3, 0.19, 0.57],
  ])("offers nothing over a stored weight that is not exact in binary: %d × %d over %d", (quantity, eachWeight, stored) => {
    // 4.35 * 100 is 434.99999999999994, 1.15 * 100 is 114.99999999999999, 0.57 * 100 is 56.99999999999999.
    expect(lineWeightOffer({ quantity, eachWeight, storedWeight: stored })).toBeNull();
    expect(lineWeightOffer({ quantity, eachWeight, storedWeight: String(stored) })).toBeNull();
  });

  it("offers nothing for a figure that rounds to 0.00: an order line weight must be above zero", () => {
    expect(netWeightCents(49, 0.0001)).toBe(0);
    expect(lineWeightOffer({ quantity: 49, eachWeight: 0.0001, storedWeight: 5 })).toBeNull();
    expect(lineWeightOffer({ quantity: 0, eachWeight: 1.5, storedWeight: 5 })).toBeNull();
  });

  it.each<[string, WeightInput]>([
    ["null", null], ["undefined", undefined], ["a blank", ""], ["text", "not-a-weight"],
    ["a three-decimal figure", "48.004"], ["NaN", Number.NaN],
  ])("offers to a stored weight that is %s", (_name, storedWeight) => {
    expect(lineWeightOffer({ quantity: 32, eachWeight: 1.5, storedWeight })?.pounds).toBe(48);
  });

  it("offers nothing when the figure cannot be calculated", () => {
    expect(lineWeightOffer({ quantity: 32, eachWeight: null, storedWeight: 498 })).toBeNull();
    expect(lineWeightOffer({ quantity: "abc", eachWeight: 1.5, storedWeight: 498 })).toBeNull();
    expect(lineWeightOffer({ quantity: 10_000_000, eachWeight: 999999.9999, storedWeight: 498 })).toBeNull();
  });

  it("reads Decimal-as-string inputs as it reads numbers", () => {
    expect(lineWeightOffer({ quantity: " 32 ", eachWeight: "1.5000", storedWeight: "498.00", shippedWeight: "95.00" }))
      .toEqual({ quantity: 32, eachWeight: 1.5, pounds: 48, belowShipped: 95 });
  });

  describe("belowShipped", () => {
    it("is the shipped weight when the figure is below it", () => {
      expect(lineWeightOffer({ quantity: 32, eachWeight: 1.5, storedWeight: 498, shippedWeight: 95 })?.belowShipped).toBe(95);
      expect(lineWeightOffer({ quantity: 32, eachWeight: 1.5, storedWeight: 498, shippedWeight: 48.01 })?.belowShipped).toBe(48.01);
    });
    it("is null when the figure equals the shipped weight", () => {
      const offer = lineWeightOffer({ quantity: 32, eachWeight: 1.5, storedWeight: 498, shippedWeight: 48 });
      expect(offer).toEqual({ quantity: 32, eachWeight: 1.5, pounds: 48, belowShipped: null });
    });
    it("is null when the figure is above the shipped weight", () => {
      expect(lineWeightOffer({ quantity: 32, eachWeight: 1.5, storedWeight: 498, shippedWeight: 47.99 })?.belowShipped).toBeNull();
    });
    it.each<[string, WeightInput]>([
      ["absent", undefined], ["null", null], ["unreadable", "abc"], ["not finite", Number.POSITIVE_INFINITY],
    ])("is null when the shipped weight is %s", (_name, shippedWeight) => {
      const offer = lineWeightOffer({ quantity: 32, eachWeight: 1.5, storedWeight: 498, shippedWeight });
      expect(offer).toEqual({ quantity: 32, eachWeight: 1.5, pounds: 48, belowShipped: null });
    });
  });
});

describe("shipNowWeightOffer", () => {
  const row = (over: Partial<Parameters<typeof shipNowWeightOffer>[0]>) =>
    shipNowWeightOffer({ shipNowQty: "8", startQty: 10, eachWeight: 10, typedWeight: "100", ...over });

  it("offers the figure when the ship-now quantity differs from its start", () => {
    expect(row({})).toEqual({ quantity: 8, eachWeight: 10, pounds: 80, belowShipped: null });
  });

  it("offers nothing at the starting quantity", () => {
    // 10 × 10 = 100 lb differs from the typed 55, and still nothing is offered: the quantity did not change.
    expect(row({ shipNowQty: "10", typedWeight: "55" })).toBeNull();
  });

  it.each(["80", "80.0", "80.00", " 80 "])("offers nothing when the typed weight %j already is the figure", (typedWeight) => {
    expect(row({ typedWeight })).toBeNull();
  });

  it("quantity 0 offers 0 against a non-zero typed weight and nothing against 0", () => {
    expect(row({ shipNowQty: "0", startQty: 40, eachWeight: 5, typedWeight: "200" }))
      .toEqual({ quantity: 0, eachWeight: 5, pounds: 0, belowShipped: null });
    expect(row({ shipNowQty: "0", startQty: 40, eachWeight: 5, typedWeight: "0" })).toBeNull();
  });

  it(`reads the quantity as the grid's own save does: "8.0" and " 9 " are 8 and 9`, () => {
    expect(row({ shipNowQty: "8.0" })).toEqual({ quantity: 8, eachWeight: 10, pounds: 80, belowShipped: null });
    expect(row({ shipNowQty: " 9 " })).toEqual({ quantity: 9, eachWeight: 10, pounds: 90, belowShipped: null });
  });

  it.each(["-10", "", "   ", "abc", "1.5"])("offers nothing for the ship-now quantity %j", (shipNowQty) => {
    expect(row({ shipNowQty })).toBeNull();
  });

  it.each([[null], [undefined]])("offers nothing when the starting quantity is %s", (startQty) => {
    expect(row({ startQty })).toBeNull();
  });

  it.each(["not-a-weight", "", "80.004"])("offers to a typed weight it cannot read: %j", (typedWeight) => {
    expect(row({ typedWeight })).toEqual({ quantity: 8, eachWeight: 10, pounds: 80, belowShipped: null });
  });

  it.each<[string, WeightInput]>([["null", null], ["undefined", undefined], ["zero", 0]])(
    "offers nothing when the each weight is %s", (_name, eachWeight) => {
      expect(row({ eachWeight })).toBeNull();
    });

  it.each([
    ["3", 1.45, "4.35"],
    ["1", 1.15, "1.15"],
    ["3", 0.19, "0.57"],
  ])("offers nothing over a typed weight that is not exact in binary: %s × %d over %s", (shipNowQty, eachWeight, typedWeight) => {
    expect(row({ shipNowQty, eachWeight, typedWeight })).toBeNull();
  });
});

describe("the offer's wording", () => {
  const offer: WeightOffer = { quantity: 32, eachWeight: 1.5, pounds: 48, belowShipped: null };

  it("shows the sum, with a multiplication sign (U+00D7)", () => {
    const sum = weightOfferSum(offer);
    expect(sum).toBe("32 × 1.5000 lb = 48.00 lb");
    expect(sum.codePointAt(3)).toBe(0xd7); // the sign itself, not the letter x
  });
  it("names the figure on its control", () => {
    expect(weightOfferUse(offer)).toBe("Use 48.00 lb");
  });
  it("says nothing is blocked when the figure is not below shipped", () => {
    expect(weightOfferBlocked(offer)).toBeNull();
  });
  it("names the shipped weight the figure falls below", () => {
    expect(weightOfferBlocked({ ...offer, belowShipped: 95 })).toBe("Below the 95.00 lb already shipped");
  });
  it("groups thousands, as every other figure on screen does", () => {
    const large: WeightOffer = { quantity: 1200, eachWeight: 1.25, pounds: 1500, belowShipped: 2400.5 };
    expect(weightOfferSum(large)).toBe("1,200 × 1.2500 lb = 1,500.00 lb");
    expect(weightOfferUse(large)).toBe("Use 1,500.00 lb");
    expect(weightOfferBlocked(large)).toBe("Below the 2,400.50 lb already shipped");
  });
});

describe("computeLineWeight (order entry and the add-rider default)", () => {
  const part = (eachWeight: number): PartOption => ({
    id: "part-1", customerId: "cust-1", partNumber: "P-1", name: "Shaft", eachWeight,
    serializationRequired: false, hasProcessSteps: true, certRequired: null, certScope: null,
    inheritedCertRequired: false, inheritedCertScope: "ORDER",
  });

  it.each([
    [32, 1.5, 48],
    [1, 1.005, 1.01],
    [1, 1.255, 1.26],
    [10, 0.0055, 0.06],
    [15, 0.009, 0.14],
    [3, 0.1, 0.3],
    [7, 19.99, 139.93],
    [3, 0.3333, 1],
  ])("is the leaf's figure: %d × %d is %d", (quantity, eachWeight, pounds) => {
    expect(computeLineWeight(part(eachWeight), quantity)).toBe(pounds);
    expect(computeLineWeight(part(eachWeight), quantity)).toBe(calculatedNetWeight(quantity, eachWeight));
  });

  it("is null without a part", () => {
    expect(computeLineWeight(undefined, 32)).toBeNull();
  });
  it("is null for a zero quantity, where the leaf alone would answer 0", () => {
    expect(calculatedNetWeight(0, 1.5)).toBe(0);
    expect(computeLineWeight(part(1.5), 0)).toBeNull();
  });
  it("is null for a negative quantity and for a quantity that is not a number", () => {
    expect(computeLineWeight(part(1.5), -3)).toBeNull();
    expect(computeLineWeight(part(1.5), Number.NaN)).toBeNull();
  });
  it("is null for a fractional quantity", () => {
    expect(computeLineWeight(part(10), 2.5)).toBeNull();
  });
  it("is null for a product past 9,999,999,999.99 lb", () => {
    expect(computeLineWeight(part(999999.9999), 10_000)).toBe(9_999_999_999);
    expect(computeLineWeight(part(999999.9999), 10_001)).toBeNull();
  });
});

// Tare, and net, tare and gross (the weights design §9.4 and §9.7). A container row's tare total is
// its tare each × how many containers it holds. Net is the line weights added up, tare is the rows'
// tare totals added up, and gross is the two together or nothing: no container rows, no gross
// (owner ruling W1, 2026-10-09). Every figure is in whole cents and is compared by value.

const MAX_CENTS = 999_999_999_999; // 9,999,999,999.99 lb, the largest Decimal(12,2)
const INT4_MAX = 2_147_483_647;    // the largest count a container row can hold

const rowOf = (count: WeightInput, tareEach: WeightInput): TareRow => ({ count, tareEach });

/** Every spelling that is no tare each. */
const NO_TARE_EACH: [string, WeightInput][] = [
  ["null", null], ["undefined", undefined], ["a blank", ""], ["spaces", "   "], ["text", "abc"],
  ["a figure typed as far as its decimal point", "42."], ["a bare minus sign", "-"],
  ["a negative number", -1], ["a negative decimal as text", "-42.50"],
  ["three decimals as text", "42.505"], ["eleven integer digits as text", "12345678901"],
  ["an exponent", "1e2"], ["a grouped figure", "1,000"],
  ["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY],
  ["a number past 9,999,999,999.99", 10_000_000_000],
];

/** Every spelling of zero that carries a minus sign. `weightCents` reads each as -0. */
const NEGATIVE_ZEROS: [string, WeightInput][] = [
  ["the number -0", -0], ["-0 as text", "-0"], ["-0.00 as text", "-0.00"],
];

describe("tareEachCents", () => {
  it("reads a tare each in whole cents, from a number or from text", () => {
    expect(tareEachCents(310)).toBe(31_000);
    expect(tareEachCents(42.5)).toBe(4250);
    expect(tareEachCents("42.50")).toBe(4250);
    expect(tareEachCents(" 42.5 ")).toBe(4250);
  });

  it("keeps float noise out of a tare each: 4.35 is 435 cents", () => {
    // 4.35 * 100 is 434.99999999999994.
    expect(tareEachCents("4.35")).toBe(435);
    expect(tareEachCents(4.35)).toBe(435);
  });

  it("counts a typed 0 as a tare each that was entered", () => {
    expect(tareEachCents(0)).toBe(0);
    expect(tareEachCents("0")).toBe(0);
    expect(tareEachCents("0.00")).toBe(0);
  });

  it.each(NEGATIVE_ZEROS)("reads %s as a tare each of 0, never negative zero", (_name, value) => {
    // Object.is, because -0 === 0 is true and a loose check would pass on the wrong zero.
    expect(Object.is(tareEachCents(value), 0)).toBe(true);
  });

  it.each(NO_TARE_EACH)("is null when the tare each is %s", (_name, value) => {
    expect(tareEachCents(value)).toBeNull();
  });

  it.each([[".5", 50], ["-.5", null], ["42.", null], ["0.5", 50]])("tareEachCents reads %j as %s", (text, cents) => {
    expect(tareEachCents(text)).toBe(cents);
  });

  it("zeros before the first other digit are not counted (O2): 00000000042 is 42", () => {
    expect(tareEachCents("00000000042")).toBe(4200);
  });

  it("an each weight typed without a leading zero is read", () => {
    expect(netWeightCents("4", ".25")).toBe(100);
  });

  it("rounds a number to the cent, and holds text to two decimals", () => {
    expect(tareEachCents(42.504)).toBe(4250);
    expect(tareEachCents(42.506)).toBe(4251);
    expect(tareEachCents("42.504")).toBeNull();
    // A number is judged as the cents it rounds to: under half a cent below zero is 0 cents.
    expect(Object.is(tareEachCents(-0.004), 0)).toBe(true);
    expect(tareEachCents(-0.006)).toBeNull();
  });

  it("reads exactly half a cent below zero as a tare each of 0, not as below zero", () => {
    // The boundary itself. -0.005 * 100 is -0.5 exactly, and `Math.round` takes a half toward
    // positive infinity: Math.round(-0.5) is -0, which is not below zero. So a number below zero by
    // half a cent or less reads as 0, and by more than half a cent as no tare each. A rule that
    // rounded a half away from zero would give -1 cent here, and null.
    expect(-0.005 * 100).toBe(-0.5);
    expect(Object.is(tareEachCents(-0.005), 0)).toBe(true);
  });

  it("keeps a tare each of exactly 9,999,999,999.99 lb", () => {
    expect(tareEachCents("9999999999.99")).toBe(MAX_CENTS);
    expect(tareEachCents(9999999999.99)).toBe(MAX_CENTS);
  });
});

/** Every spelling that is no count of containers. */
const NO_COUNT: [string, WeightInput][] = [
  ["null", null], ["undefined", undefined], ["a blank", ""], ["spaces", "   "], ["text", "abc"],
  ["zero", 0], ["zero as text", "0"], ["a negative number", -1], ["a negative number as text", "-1"],
  ["a fraction", 1.5], ["a fraction as text", "1.5"], ["a whole number typed with a decimal point", "3.0"],
  ["an exponent", "1e2"], ["eleven digits as text", "12345678901"],
  ["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY],
];

describe("tareTotalCents and tareTotal", () => {
  it("the owner's case: 14 bins at 310 lb each are 4,340 lb of tare", () => {
    expect(tareTotalCents(rowOf(14, 310))).toBe(434_000);
    expect(tareTotal(rowOf(14, 310))).toBe(4340);
  });

  it("3 baskets at 42.50 lb each are 127.50 lb of tare", () => {
    expect(tareTotalCents(rowOf(3, 42.5))).toBe(12_750);
    expect(tareTotal(rowOf("3", "42.50"))).toBe(127.5);
  });

  it("keeps float noise out of a tare total: 3 containers at 0.1 lb are 30 cents", () => {
    // 0.1 * 3 is 0.30000000000000004.
    expect(tareTotalCents(rowOf(3, 0.1))).toBe(30);
    const pounds = tareTotal(rowOf(3, 0.1));
    expect(pounds).toBe(0.3);
    expect(String(pounds)).toBe("0.3");
  });

  it("reads a stored row and a row of typed text as they are", () => {
    // A container row as an order's read carries it, and a grid's row of typed strings, each handed
    // over whole. That both fit `TareRow` is the type checker's to hold: vitest does not check types.
    const stored = {
      id: "c1", position: 1, typeId: "t1", count: 3, pieces: 252, tareEach: 42.5, scaleGross: null,
      customerContainerId: "", type: { name: "Steel Basket" },
    };
    const typed = { typeId: "t1", count: "3", pieces: "252", tareEach: "42.50", scaleGross: "", customerContainerId: "" };
    expect(tareTotalCents(stored)).toBe(12_750);
    expect(tareTotalCents(typed)).toBe(12_750);
  });

  it("gives a tare total of 0 for a tare each of 0", () => {
    expect(tareTotalCents(rowOf(2, "0"))).toBe(0);
    expect(tareTotal(rowOf(2, 0))).toBe(0);
  });

  it.each(NEGATIVE_ZEROS)("gives a tare total of 0, never negative zero, for %s", (_name, value) => {
    expect(Object.is(tareTotalCents(rowOf(3, value)), 0)).toBe(true);
    expect(Object.is(tareTotal(rowOf(3, value)), 0)).toBe(true);
  });

  it.each(NO_TARE_EACH)("has no tare total when the tare each is %s", (_name, value) => {
    expect(tareTotalCents(rowOf(2, value))).toBeNull();
    expect(tareTotal(rowOf(2, value))).toBeNull();
  });

  // A tare each of one cent, so that eleven digits are refused as a spelling and not by the ceiling.
  it.each(NO_COUNT)("has no tare total when the count is %s", (_name, count) => {
    expect(tareTotalCents(rowOf(count, "0.01"))).toBeNull();
    expect(tareTotal(rowOf(count, "0.01"))).toBeNull();
  });

  describe("the Decimal(12,2) ceiling on a tare total", () => {
    it("keeps one container at exactly 9,999,999,999.99 lb", () => {
      expect(tareTotalCents(rowOf(1, "9999999999.99"))).toBe(MAX_CENTS);
      expect(tareTotal(rowOf(1, "9999999999.99"))).toBe(9_999_999_999.99);
    });
    it("keeps a product that lands exactly on the ceiling", () => {
      // 999,999 cents × 1,000,001 containers is 999,999,999,999 cents.
      expect(tareTotalCents(rowOf(1_000_001, "9999.99"))).toBe(MAX_CENTS);
    });
    it("is null for two containers at 9,999,999,999.99 lb", () => {
      expect(tareTotalCents(rowOf(2, "9999999999.99"))).toBeNull();
      expect(tareTotal(rowOf(2, "9999999999.99"))).toBeNull();
    });
    it("is null one container past a product on the ceiling", () => {
      expect(tareTotalCents(rowOf(1_000_002, "9999.99"))).toBeNull();
    });
    it("is null for the largest count and tare each the server accepts", () => {
      // The true product is past 2^53, where a plain number is no longer exact.
      expect(tareTotalCents(rowOf(INT4_MAX, "9999999999.99"))).toBeNull();
      expect(tareTotal(rowOf(String(INT4_MAX), 9999999999.99))).toBeNull();
    });
  });
});

describe("weightTotals", () => {
  const baskets = [rowOf(3, 42.5)];

  it("the owner's case: 3 baskets at 42.50 lb on 1,600.00 lb of parts gross 1,727.50 lb", () => {
    expect(weightTotals({ lineWeights: [1600], containers: baskets }))
      .toEqual({ netCents: 160_000, tareCents: 12_750, grossCents: 172_750, containerRows: 1, rowsWithoutTare: 0 });
  });

  it("adds every row's tare total: 8 drop pans at 367 lb and 12 bins at 319 lb on 60,750 lb", () => {
    // 2,936 + 3,828 = 6,764 lb of tare, and 67,514 lb gross.
    expect(weightTotals({ lineWeights: ["60750.00"], containers: [rowOf(8, 367), rowOf(12, 319)] }))
      .toEqual({ netCents: 6_075_000, tareCents: 676_400, grossCents: 6_751_400, containerRows: 2, rowsWithoutTare: 0 });
  });

  it("adds every line weight into net, the lead and the riders", () => {
    expect(weightTotals({ lineWeights: [1600, "250.50", 49.5], containers: baskets }).netCents).toBe(190_000);
  });

  it("gives no tare and no gross with no container rows (W1)", () => {
    expect(weightTotals({ lineWeights: [1600], containers: [] }))
      .toEqual({ netCents: 160_000, tareCents: null, grossCents: null, containerRows: 0, rowsWithoutTare: 0 });
  });

  it("gives no tare and no gross for one row of two with no tare each, and counts the row", () => {
    expect(weightTotals({ lineWeights: [1600], containers: [rowOf(2, null)] }))
      .toEqual({ netCents: 160_000, tareCents: null, grossCents: null, containerRows: 1, rowsWithoutTare: 1 });
  });

  it("the owner's case: 3 skids and 1 wire basket with no tare each give no gross", () => {
    // The owner's example gives pieces, not pounds. The 450.00 lb is this case's own figure.
    expect(weightTotals({ lineWeights: ["450.00"], containers: [rowOf(3, ""), rowOf(1, "")] }))
      .toEqual({ netCents: 45_000, tareCents: null, grossCents: null, containerRows: 2, rowsWithoutTare: 2 });
  });

  it("never gives a partial sum: a row with a tare each beside a row without one", () => {
    expect(weightTotals({ lineWeights: [1600], containers: [rowOf(3, 42.5), rowOf(1, null)] }))
      .toEqual({ netCents: 160_000, tareCents: null, grossCents: null, containerRows: 2, rowsWithoutTare: 1 });
  });

  it("does not count a row with a tare each and a blank count as a row without a tare each", () => {
    expect(weightTotals({ lineWeights: [1600], containers: [rowOf("", "42.5")] }))
      .toEqual({ netCents: 160_000, tareCents: null, grossCents: null, containerRows: 1, rowsWithoutTare: 0 });
  });

  it.each(NO_TARE_EACH)("counts a row whose tare each is %s as a row without one", (_name, value) => {
    expect(weightTotals({ lineWeights: [1600], containers: [rowOf(2, value)] }))
      .toEqual({ netCents: 160_000, tareCents: null, grossCents: null, containerRows: 1, rowsWithoutTare: 1 });
  });

  it("gives a tare of 0 and a gross for a tare each of 0", () => {
    expect(weightTotals({ lineWeights: [1600], containers: [rowOf(2, "0")] }))
      .toEqual({ netCents: 160_000, tareCents: 0, grossCents: 160_000, containerRows: 1, rowsWithoutTare: 0 });
  });

  it.each(NEGATIVE_ZEROS)("counts %s as a tare each that was entered: a tare of 0 and a gross", (_name, value) => {
    expect(weightTotals({ lineWeights: [1600], containers: [rowOf(3, value)] }))
      .toEqual({ netCents: 160_000, tareCents: 0, grossCents: 160_000, containerRows: 1, rowsWithoutTare: 0 });
  });

  it("adds no lines up to a net of 0", () => {
    expect(weightTotals({ lineWeights: [], containers: [] }))
      .toEqual({ netCents: 0, tareCents: null, grossCents: null, containerRows: 0, rowsWithoutTare: 0 });
  });

  it("adds negative line weights exactly, as a reversal's are", () => {
    expect(weightTotals({ lineWeights: [100.1, -40.05, "-0.10"], containers: [] }).netCents).toBe(5995);
    expect(weightTotals({ lineWeights: ["-1600.00"], containers: [] }).netCents).toBe(-160_000);
  });

  it("keeps float noise out of the net: 0.1 lb and 0.2 lb are 30 cents", () => {
    expect(weightTotals({ lineWeights: [0.1, 0.2], containers: [] }).netCents).toBe(30);
  });

  it("never answers a net of negative zero", () => {
    expect(Object.is(weightTotals({ lineWeights: ["-0"], containers: [] }).netCents, 0)).toBe(true);
    expect(Object.is(weightTotals({ lineWeights: [-5, 5], containers: [] }).netCents, 0)).toBe(true);
  });

  it.each<[string, WeightInput]>([
    ["null", null], ["undefined", undefined], ["a blank", ""], ["text", "abc"],
    ["three decimals as text", "1600.005"], ["NaN", Number.NaN],
  ])("has no net and no gross when a line weight is %s, and keeps the tare", (_name, weight) => {
    expect(weightTotals({ lineWeights: [1600, weight], containers: baskets }))
      .toEqual({ netCents: null, tareCents: 12_750, grossCents: null, containerRows: 1, rowsWithoutTare: 0 });
  });

  describe("the Decimal(12,2) ceiling on a sum", () => {
    it("keeps a net of exactly 9,999,999,999.99 lb, above zero and below it", () => {
      expect(weightTotals({ lineWeights: ["9999999999.99"], containers: [] }).netCents).toBe(MAX_CENTS);
      expect(weightTotals({ lineWeights: ["-9999999999.99"], containers: [] }).netCents).toBe(-MAX_CENTS);
    });
    it("has no net one cent past the ceiling", () => {
      expect(weightTotals({ lineWeights: ["9999999999.99", "0.01"], containers: [] }).netCents).toBeNull();
    });
    it("has no net one cent below minus the ceiling", () => {
      expect(weightTotals({ lineWeights: ["-9999999999.99", "-0.01"], containers: [] }).netCents).toBeNull();
    });
    it("does not bring back a net whose running sum passed the ceiling", () => {
      expect(weightTotals({ lineWeights: ["9999999999.99", "0.01", "-0.01"], containers: [] }).netCents).toBeNull();
    });
    it("has no tare when two rows each fit and together pass the ceiling", () => {
      expect(weightTotals({ lineWeights: [1600], containers: [rowOf(1, "9999999999.99"), rowOf(1, "0.01")] }))
        .toEqual({ netCents: 160_000, tareCents: null, grossCents: null, containerRows: 2, rowsWithoutTare: 0 });
    });
    it("has no gross when net and tare each fit and together pass the ceiling", () => {
      expect(weightTotals({ lineWeights: ["9999999999.99"], containers: [rowOf(1, "0.01")] }))
        .toEqual({ netCents: MAX_CENTS, tareCents: 1, grossCents: null, containerRows: 1, rowsWithoutTare: 0 });
    });
    it("keeps a gross of exactly 9,999,999,999.99 lb", () => {
      expect(weightTotals({ lineWeights: ["9999999999.98"], containers: [rowOf(1, "0.01")] }).grossCents).toBe(MAX_CENTS);
    });
  });
});

// A shipment of several orders (the weights design §12.2 and §12.5; owner answers 1 to 3 of
// 2026-10-10). Each order is `weightTotals` of its own lines and rows. The shipment's net and tare
// are the orders' added up, and it has a gross only when every order on it has one. Each result is
// compared whole.

describe("shipmentWeightTotals", () => {
  const part = (lineWeights: WeightInput[], containers: TareRow[] = []): ShipmentOrderWeights => ({ lineWeights, containers });
  /** One order's totals, with one container row that has its tare each unless told otherwise. */
  const own = (netCents: number | null, tareCents: number | null, grossCents: number | null, containerRows = 1, rowsWithoutTare = 0): WeightTotals =>
    ({ netCents, tareCents, grossCents, containerRows, rowsWithoutTare });
  /** A whole result: each order's totals, then the shipment's net, tare, gross and three counts. */
  const whole = (
    orders: WeightTotals[], netCents: number | null, tareCents: number | null, grossCents: number | null,
    containerRows: number, rowsWithoutTare: number, ordersWithoutContainers: number,
  ): ShipmentWeightTotals => ({ orders, netCents, tareCents, grossCents, containerRows, rowsWithoutTare, ordersWithoutContainers });
  /** Order 1031: 1,600.00 lb in 3 baskets at 42.50 lb. Order 1032: 450.00 lb and no container row. */
  const O1031 = part([1600], [rowOf(3, 42.5)]);
  const O1032 = part([450]);
  const T1031 = own(160_000, 12_750, 172_750);
  const T1032 = own(45_000, null, null, 0);
  /** 4,000.00 lb in 14 bins at 310 lb. */
  const BINS = own(400_000, 434_000, 834_000);

  it.each<[string, ShipmentOrderWeights[], ShipmentWeightTotals]>([
    ["one complete order: the shipment's figures are that order's",
      [O1031], whole([T1031], 160_000, 12_750, 172_750, 1, 0, 0)],
    ["two complete orders, typed text beside stored numbers: 5,600.00, 4,467.50 and 10,067.50 lb",
      [part(["1600.00"], [rowOf("3", "42.5")]), part([4000], [rowOf(14, 310)])],
      whole([T1031, BINS], 560_000, 446_750, 1_006_750, 2, 0, 0)],
    ["an order with no container row beside one with rows: no gross, and the tare of the listed rows (answers 1 and 2)",
      [O1031, O1032], whole([T1031, T1032], 205_000, 12_750, null, 1, 0, 1)],
    ["no container row on any order, as on a reversal of two orders: no tare and no gross",
      [part([-1600, "-250.50"]), part([-450])],
      whole([own(-185_050, null, null, 0), own(-45_000, null, null, 0)], -230_050, null, null, 0, 0, 2)],
    ["no order at all: a net of 0, and no tare and no gross", [], whole([], 0, null, null, 0, 0, 0)],
    ["a row with no tare each on the second order: no tare and no gross, and the rows counted over every order",
      [part([4000], [rowOf(14, 310)]), part([1600], [rowOf(3, null), rowOf(2, 30)])],
      whole([BINS, own(160_000, null, null, 2, 1)], 560_000, null, null, 3, 1, 0)],
    ["an order with no line: a net of 0, and a gross equal to its tare (answer 3)",
      [part([], [rowOf(3, 42.5)])], whole([own(0, 12_750, 12_750)], 0, 12_750, 12_750, 1, 0, 0)],
    ["one order's net cannot be read: no net and no gross, and the tare is kept",
      [O1031, part([450, "48."], [rowOf(1, 0)])], whole([T1031, own(null, 0, null)], null, 12_750, null, 2, 0, 0)],
    ["the orders' nets each fit and together pass the ceiling: no net and no gross",
      [part(["9999999999.99"], [rowOf(1, 0)]), part(["0.01"], [rowOf(1, 0)])],
      whole([own(MAX_CENTS, 0, MAX_CENTS), own(1, 0, 1)], null, 0, null, 2, 0, 0)],
    ["the orders' tares each fit and together pass the ceiling: no tare and no gross",
      [part([], [rowOf(1, "9999999999.99")]), part([], [rowOf(1, "0.01")])],
      whole([own(0, MAX_CENTS, MAX_CENTS), own(0, 1, 1)], 0, null, null, 2, 0, 0)],
    ["net and tare each fit and together pass the ceiling: no gross, though every order has one",
      [part(["9999999999.98"], [rowOf(1, 0)]), part([], [rowOf(1, "0.02")])],
      whole([own(MAX_CENTS - 1, 0, MAX_CENTS - 1), own(0, 2, 2)], MAX_CENTS - 1, 2, null, 2, 0, 0)],
  ])("%s", (_name, orders, expected) => {
    expect(shipmentWeightTotals(orders)).toEqual(expected);
  });
});

// Weighed net, its difference from a net, and implied pieces (the weights design §10.2 and §10.5).
// A weighed net is the rows' scale gross added up, less their tare totals added up. There is one
// only with at least one container row, and only when every row has a scale gross and a tare
// total. Implied pieces is a weighed net divided by the one part's each weight, to the nearest
// whole piece (owner rulings W5 and W6, 2026-10-09).

const weighedRow = (count: WeightInput, tareEach: WeightInput, scaleGross: WeightInput): WeighedRow =>
  ({ count, tareEach, scaleGross });

describe("scaleGrossCents", () => {
  it("reads a scale gross in whole cents, from a number or from text", () => {
    expect(scaleGrossCents(1740)).toBe(174_000);
    expect(scaleGrossCents("1740.00")).toBe(174_000);
    expect(scaleGrossCents(" 1740 ")).toBe(174_000);
    expect(scaleGrossCents("4.35")).toBe(435);
  });

  it("counts a typed 0 as a scale gross that was entered", () => {
    expect(scaleGrossCents(0)).toBe(0);
    expect(scaleGrossCents("0")).toBe(0);
  });

  // A scale gross is read as a tare each is, so the two lists of spellings serve both.
  it.each(NEGATIVE_ZEROS)("reads %s as a scale gross of 0, never negative zero", (_name, value) => {
    expect(Object.is(scaleGrossCents(value), 0)).toBe(true);
  });

  it.each(NO_TARE_EACH)("has no scale gross when it is %s", (_name, value) => {
    expect(scaleGrossCents(value)).toBeNull();
  });

  it("keeps a scale gross of exactly 9,999,999,999.99 lb", () => {
    expect(scaleGrossCents("9999999999.99")).toBe(MAX_CENTS);
  });
});

describe("weighedNet", () => {
  it("the owner's case: 3 baskets at 42.50 lb that weigh 1,740.00 lb hold 1,612.50 lb", () => {
    expect(weighedNet([weighedRow(3, 42.5, 1740)]))
      .toEqual({ weighedNetCents: 161_250, containerRows: 1, rowsWithoutScaleGross: 0, rowsWithoutTare: 0 });
  });

  it("reads a weighed stored row and a weighed row of typed text as they are", () => {
    // That both fit `WeighedRow` is the type checker's to hold: vitest does not check types.
    const stored = {
      id: "c1", position: 1, typeId: "t1", count: 3, pieces: 252, tareEach: 42.5, scaleGross: 1740,
      customerContainerId: "", type: { name: "Steel Basket" },
    };
    const typed = { typeId: "t1", count: "3", pieces: "252", tareEach: "42.50", scaleGross: " 1740 ", customerContainerId: "" };
    expect(weighedNet([stored]).weighedNetCents).toBe(161_250);
    expect(weighedNet([typed]).weighedNetCents).toBe(161_250);
  });

  it("adds every row's scale gross up and takes every row's tare total off", () => {
    // 1,740.00 + 950.00 = 2,690.00 lb on the scale. 127.50 + 120.00 = 247.50 lb of tare.
    expect(weighedNet([weighedRow(3, 42.5, 1740), weighedRow(2, "60.00", "950.00")]))
      .toEqual({ weighedNetCents: 244_250, containerRows: 2, rowsWithoutScaleGross: 0, rowsWithoutTare: 0 });
  });

  // The cases of the design's §10.2 that have no weighed net, each with the counts that say why.
  it.each<[string, WeighedRow[], WeighedNet]>([
    ["no container rows", [],
      { weighedNetCents: null, containerRows: 0, rowsWithoutScaleGross: 0, rowsWithoutTare: 0 }],
    ["no row weighed", [weighedRow(3, 42.5, null), weighedRow(1, 60, "")],
      { weighedNetCents: null, containerRows: 2, rowsWithoutScaleGross: 2, rowsWithoutTare: 0 }],
    ["one row of two not weighed", [weighedRow(3, 42.5, 1740), weighedRow(1, 60, null)],
      { weighedNetCents: null, containerRows: 2, rowsWithoutScaleGross: 1, rowsWithoutTare: 0 }],
    ["a scale gross typed as far as its decimal point", [weighedRow(3, 42.5, "1740.")],
      { weighedNetCents: null, containerRows: 1, rowsWithoutScaleGross: 1, rowsWithoutTare: 0 }],
    ["every row weighed and one with no tare each", [weighedRow(3, 42.5, 1740), weighedRow(1, null, 500)],
      { weighedNetCents: null, containerRows: 2, rowsWithoutScaleGross: 0, rowsWithoutTare: 1 }],
    ["a weighed row whose tare each has no readable count beside it", [weighedRow("", "42.5", 1740)],
      { weighedNetCents: null, containerRows: 1, rowsWithoutScaleGross: 0, rowsWithoutTare: 0 }],
    ["a weighed row whose tare total is past the ceiling", [weighedRow(2, "9999999999.99", 1740)],
      { weighedNetCents: null, containerRows: 1, rowsWithoutScaleGross: 0, rowsWithoutTare: 0 }],
  ])("has no weighed net with %s", (_name, rows, expected) => {
    expect(weighedNet(rows)).toEqual(expected);
  });

  it("counts a scale gross of 0 as weighed", () => {
    expect(weighedNet([weighedRow(1, 0, 0), weighedRow(1, 0, "0")]))
      .toEqual({ weighedNetCents: 0, containerRows: 2, rowsWithoutScaleGross: 0, rowsWithoutTare: 0 });
  });

  it("gives a weighed net below zero as worked out: 100.00 lb on 127.50 lb of tare", () => {
    expect(weighedNet([weighedRow(3, 42.5, 100)]).weighedNetCents).toBe(-2750);
  });

  it("gives a weighed net of 0, never negative zero, when the scale reads the tare alone", () => {
    expect(Object.is(weighedNet([weighedRow(3, 42.5, 127.5)]).weighedNetCents, 0)).toBe(true);
  });

  describe("the Decimal(12,2) ceiling on the scale gross added up", () => {
    it("keeps a weighed net of exactly 9,999,999,999.99 lb", () => {
      expect(weighedNet([weighedRow(1, 0, "9999999999.98"), weighedRow(1, 0, "0.01")]).weighedNetCents).toBe(MAX_CENTS);
    });
    it("has no weighed net when two rows' scale gross each fit and together pass the ceiling", () => {
      expect(weighedNet([weighedRow(1, 0, "9999999999.99"), weighedRow(1, 0, "0.01")]))
        .toEqual({ weighedNetCents: null, containerRows: 2, rowsWithoutScaleGross: 0, rowsWithoutTare: 0 });
    });
  });

  describe("the Decimal(12,2) ceiling on the tare totals added up", () => {
    // Each row reads 0 on the scale, so the scale gross added up is 0 and only the tare meets the ceiling.
    it("keeps a weighed net when two rows' tare totals add up to exactly 9,999,999,999.99 lb", () => {
      expect(weighedNet([weighedRow(1, "9999999999.98", 0), weighedRow(1, "0.01", 0)]).weighedNetCents).toBe(-MAX_CENTS);
    });
    it("has no weighed net when two rows' tare totals each fit and together pass the ceiling", () => {
      expect(weighedNet([weighedRow(1, "9999999999.99", 0), weighedRow(1, "0.01", 0)]))
        .toEqual({ weighedNetCents: null, containerRows: 2, rowsWithoutScaleGross: 0, rowsWithoutTare: 0 });
    });
  });
});

describe("weighedDifferenceCents", () => {
  it("is the weighed net less the net: above zero is over, below zero is under", () => {
    expect(weighedDifferenceCents(161_250, 160_000)).toBe(1250);
    expect(weighedDifferenceCents(158_750, 160_000)).toBe(-1250);
  });

  it("is 0, never negative zero, when the two are equal to the cent", () => {
    expect(Object.is(weighedDifferenceCents(160_000, 160_000), 0)).toBe(true);
    expect(Object.is(weighedDifferenceCents(0, 0), 0)).toBe(true);
  });

  it("is 0, never negative zero, when a weighed net of negative zero meets a net of 0", () => {
    // As plain numbers subtract, -0 less 0 is -0.
    expect(Object.is(weighedDifferenceCents(-0, 0), 0)).toBe(true);
  });

  it("holds a weighed net against a net below zero, as a reversal's is", () => {
    expect(weighedDifferenceCents(0, -160_000)).toBe(160_000);
    expect(weighedDifferenceCents(-2750, -160_000)).toBe(157_250);
  });

  it.each<[string, number | null, number | null]>([
    ["no weighed net", null, 160_000], ["no net", 161_250, null],
  ])("has no difference with %s", (_name, weighed, net) => {
    expect(weighedDifferenceCents(weighed, net)).toBeNull();
  });

  describe("the Decimal(12,2) ceiling on a difference", () => {
    it("keeps a difference of exactly 9,999,999,999.99 lb, over and under", () => {
      expect(weighedDifferenceCents(MAX_CENTS, 0)).toBe(MAX_CENTS);
      expect(weighedDifferenceCents(0, MAX_CENTS)).toBe(-MAX_CENTS);
    });
    it("has no difference one cent past the ceiling, over", () => {
      expect(weighedDifferenceCents(MAX_CENTS, -1)).toBeNull();
    });
    it("has no difference one cent past the ceiling, under", () => {
      expect(weighedDifferenceCents(-1, MAX_CENTS)).toBeNull();
    });
  });
});

describe("impliedPieces", () => {
  const onePart = (eachWeight: WeightInput): ImpliedLine[] => [{ partId: "p1", eachWeight }];
  const pieces = (weighedNetCents: number | null, eachWeight: WeightInput) =>
    impliedPieces({ weighedNetCents, lines: onePart(eachWeight) });

  it("the owner's case: 1,612.50 lb at 6.4 lb each is 252 pieces", () => {
    // 1,612.50 ÷ 6.4 is a little over 251.95 pieces, and the nearest whole piece is 252 (W6).
    expect(pieces(161_250, 6.4)).toBe(252);
    expect(pieces(161_250, " 6.4000 ")).toBe(252);
  });

  it("rounds an exact half piece up: 7.50 lb at 5 lb each is 2", () => {
    expect(pieces(750, 5)).toBe(2);
    // Half a piece of a very light part: 0.01 lb at 0.02 lb each.
    expect(pieces(1, "0.0200")).toBe(1);
  });

  it("rounds down one cent under the half: 7.49 lb at 5 lb each is 1", () => {
    expect(pieces(749, 5)).toBe(1);
  });

  it("answers a whole number of pieces as it is: 3,937.00 lb at 127 lb each is 31", () => {
    expect(pieces(393_700, 127)).toBe(31);
  });

  it("gives 0 pieces for a weighed net of 0", () => {
    expect(Object.is(pieces(0, 6.4), 0)).toBe(true);
  });

  it("holds the largest weighed net at the smallest each weight", () => {
    // 9,999,999,999.99 lb at 0.0001 lb each. The figure is a whole number a plain number holds.
    expect(pieces(MAX_CENTS, 0.0001)).toBe(99_999_999_999_900);
    expect(Number.isSafeInteger(pieces(MAX_CENTS, 0.0001))).toBe(true);
  });

  it.each<[string, number | null]>([
    ["no weighed net", null], ["a weighed net one cent below zero", -1], ["a weighed net of -27.50 lb", -2750],
  ])("has no implied pieces with %s", (_name, weighedNetCents) => {
    expect(pieces(weighedNetCents, 6.4)).toBeNull();
  });

  it.each<[string, ImpliedLine[]]>([
    ["no lines", []],
    ["a line whose part is null", [{ partId: null, eachWeight: 6.4 }]],
    ["a line whose part is undefined", [{ partId: undefined, eachWeight: 6.4 }]],
    ["a line whose part is a blank id", [{ partId: "", eachWeight: 6.4 }]],
    ["two parts", [{ partId: "p1", eachWeight: 6.4 }, { partId: "p2", eachWeight: 6.4 }]],
    ["a second line with no part", [{ partId: "p1", eachWeight: 6.4 }, { partId: null, eachWeight: 6.4 }]],
  ])("has no implied pieces for %s", (_name, lines) => {
    expect(impliedPieces({ weighedNetCents: 161_250, lines })).toBeNull();
  });

  it("still answers for a rider of the same part", () => {
    const lines = [{ partId: "p1", eachWeight: 6.4 }, { partId: "p1", eachWeight: 6.4 }];
    expect(impliedPieces({ weighedNetCents: 161_250, lines })).toBe(252);
  });

  it("divides by the first line's each weight when the lines of one part carry two", () => {
    // 1,612.50 lb is 252 pieces at 6.4 lb each, and 323 at 5 lb each.
    const lines = [{ partId: "p1", eachWeight: 6.4 }, { partId: "p1", eachWeight: 5 }];
    expect(impliedPieces({ weighedNetCents: 161_250, lines })).toBe(252);
  });

  it.each<[string, WeightInput]>([
    ["null", null], ["undefined", undefined], ["a blank", ""], ["text", "abc"], ["zero", 0],
    ["a zero decimal", "0.0000"], ["a negative number", -6.4], ["a five-decimal string", "6.40001"],
    ["NaN", Number.NaN],
  ])("has no implied pieces when the each weight is %s", (_name, eachWeight) => {
    expect(pieces(161_250, eachWeight)).toBeNull();
  });
});
