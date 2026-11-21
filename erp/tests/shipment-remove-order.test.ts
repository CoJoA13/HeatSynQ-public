// erp/tests/shipment-remove-order.test.ts
import { describe, it, expect } from "vitest";
import {
  NOTHING_PRINTED, mergePrinted, printedOrdersFrom, removeOrderRefusal,
  type PinningDocument, type PrintedOrders, type RemoveOrderFacts,
} from "@/lib/shipment-remove-order";

// Why Remove order is refused, stated once (#472). The server's mutator and the shipment page both
// call `removeOrderRefusal`, so its order and its words are pinned here as text.

/** Nothing refuses: two orders, nothing printed, no invoice, the other order ships something. */
const free: RemoveOrderFacts = {
  shipperNumber: 5001, orderCount: 2, paperPrinted: false, invoice: null,
  survivorHasPositiveLine: true, certPrinted: false,
};
/** Every rung refuses at once. A case opens the rungs above the one it tests, one at a time. */
const all: RemoveOrderFacts = {
  shipperNumber: 5001, orderCount: 1, paperPrinted: true, invoice: { invoiceId: "inv1", orderNumber: 1031 },
  survivorHasPositiveLine: false, certPrinted: true,
};

const ONLY_ORDER =
  "This is the only order on the shipment — void the shipment (Packing List 5001) instead of removing its last order.";
const PAPER =
  "Shipment paper covering this order has already printed (Packing List 5001) — void the shipment instead of removing it.";
const INVOICED =
  "This order cannot be removed from the shipment — Invoice 1031 is finalized; unlock it or raise a credit (see /invoicing/inv1)";
const NO_POSITIVE_LINE = "A shipment needs at least one line with a positive quantity";
const CERT =
  "This order's shipment certification has already printed (Packing List 5001) — void the shipment instead of removing it.";

describe("removeOrderRefusal", () => {
  it("allows the removal when nothing refuses it", () => {
    expect(removeOrderRefusal(free)).toBeNull();
  });

  it.each([
    ["the only order on the shipment", { orderCount: 1 }, ONLY_ORDER],
    ["printed paper covering the order", { paperPrinted: true }, PAPER],
    ["a finalized invoice on the order", { invoice: { invoiceId: "inv1", orderNumber: 1031 } }, INVOICED],
    ["no other order with a positive line", { survivorHasPositiveLine: false }, NO_POSITIVE_LINE],
    ["a printed shipment certification", { certPrinted: true }, CERT],
  ] satisfies [string, Partial<RemoveOrderFacts>, string][])("refuses for %s alone", (_name, fact, sentence) => {
    expect(removeOrderRefusal({ ...free, ...fact })).toBe(sentence);
  });

  // The server's order. Each row opens one more rung from the top and names the one that then wins.
  it.each([
    ["the only order comes first", {}, ONLY_ORDER],
    ["then printed paper", { orderCount: 2 }, PAPER],
    ["then the invoice", { orderCount: 2, paperPrinted: false }, INVOICED],
    ["then the positive line", { orderCount: 2, paperPrinted: false, invoice: null }, NO_POSITIVE_LINE],
    ["then the certification", { orderCount: 2, paperPrinted: false, invoice: null, survivorHasPositiveLine: true }, CERT],
  ] satisfies [string, Partial<RemoveOrderFacts>, string][])("%s", (_name, opened, sentence) => {
    expect(removeOrderRefusal({ ...all, ...opened })).toBe(sentence);
  });

  it("is the only-order refusal for a count of one, not for three", () => {
    expect(removeOrderRefusal({ ...free, orderCount: 3 })).toBeNull();
  });
});

describe("printedOrdersFrom", () => {
  const ticketFor = (orderId: string): PinningDocument => ({ orderId, coveredOrderIds: [], certOrderId: null });
  const wholeSet = (covered: string[]): PinningDocument => ({ orderId: null, coveredOrderIds: covered, certOrderId: null });
  const certPrint = (orderId: string): PinningDocument => ({ orderId: null, coveredOrderIds: [], certOrderId: orderId });

  it("pins nothing with no documents", () => {
    expect(printedOrdersFrom([], ["a", "b"])).toEqual({ paperOrderIds: [], certOrderIds: [] });
  });

  it("pins the one order a per-order ticket is for", () => {
    expect(printedOrdersFrom([ticketFor("b")], ["a", "b"])).toEqual({ paperOrderIds: ["b"], certOrderIds: [] });
  });

  it("pins every order whole-shipment paper recorded, and no other", () => {
    expect(printedOrdersFrom([wholeSet(["a", "b"])], ["a", "b", "late"]))
      .toEqual({ paperOrderIds: ["a", "b"], certOrderIds: [] });
  });

  it("does not read a per-order ticket's coverage list as whole-shipment coverage", () => {
    const odd: PinningDocument = { orderId: "a", coveredOrderIds: ["b"], certOrderId: null };
    expect(printedOrdersFrom([odd], ["a", "b"]).paperOrderIds).toEqual(["a"]);
  });

  it("pins a certification's order under certOrderIds and not under paper", () => {
    expect(printedOrdersFrom([certPrint("a")], ["a", "b"])).toEqual({ paperOrderIds: [], certOrderIds: ["a"] });
  });

  it("never counts a certification print as shipment paper, whatever else the row carries", () => {
    const odd: PinningDocument = { orderId: "a", coveredOrderIds: ["b"], certOrderId: "c" };
    expect(printedOrdersFrom([odd], ["a", "b", "c"])).toEqual({ paperOrderIds: [], certOrderIds: ["c"] });
  });

  it("answers in the order it was asked, whatever order the documents came in", () => {
    const docs = [certPrint("c"), wholeSet(["c", "a"]), ticketFor("b")];
    expect(printedOrdersFrom(docs, ["a", "b", "c", "d"]))
      .toEqual({ paperOrderIds: ["a", "b", "c"], certOrderIds: ["c"] });
  });

  it("names no order it was not asked about", () => {
    expect(printedOrdersFrom([ticketFor("x"), certPrint("y")], ["a"])).toEqual({ paperOrderIds: [], certOrderIds: [] });
  });
});

describe("mergePrinted", () => {
  const seen: PrintedOrders = { paperOrderIds: ["a"], certOrderIds: ["c"] };

  it("starts from nothing printed", () => {
    expect(NOTHING_PRINTED).toEqual({ paperOrderIds: [], certOrderIds: [] });
  });

  // It is one object shared by every importer. A holder that could change it would change where
  // every later page starts.
  it("NOTHING_PRINTED refuses a push on either list and an assignment of either", () => {
    expect(() => NOTHING_PRINTED.paperOrderIds.push("a")).toThrow(TypeError);
    expect(() => NOTHING_PRINTED.certOrderIds.push("a")).toThrow(TypeError);
    expect(() => { NOTHING_PRINTED.paperOrderIds = ["a"]; }).toThrow(TypeError);
    expect(() => { NOTHING_PRINTED.certOrderIds = ["a"]; }).toThrow(TypeError);
    expect(NOTHING_PRINTED).toEqual({ paperOrderIds: [], certOrderIds: [] });
  });

  it("an answer that knows less drops nothing", () => {
    expect(mergePrinted(seen, NOTHING_PRINTED)).toEqual({ paperOrderIds: ["a"], certOrderIds: ["c"] });
    expect(mergePrinted(seen, { paperOrderIds: ["b"], certOrderIds: [] }))
      .toEqual({ paperOrderIds: ["a", "b"], certOrderIds: ["c"] });
  });

  it("keeps what was seen first, then adds what arrived", () => {
    expect(mergePrinted(seen, { paperOrderIds: ["b", "a"], certOrderIds: ["a", "c"] }))
      .toEqual({ paperOrderIds: ["a", "b"], certOrderIds: ["c", "a"] });
  });

  it("returns the same object when the answer adds nothing", () => {
    expect(mergePrinted(seen, NOTHING_PRINTED)).toBe(seen);
    expect(mergePrinted(seen, { paperOrderIds: ["a"], certOrderIds: ["c"] })).toBe(seen);
  });

  it("returns a new object, and leaves both inputs as they were, when the answer adds something", () => {
    const arrived: PrintedOrders = { paperOrderIds: ["b"], certOrderIds: [] };
    const merged = mergePrinted(seen, arrived);
    expect(merged).not.toBe(seen);
    expect(seen).toEqual({ paperOrderIds: ["a"], certOrderIds: ["c"] });
    expect(arrived).toEqual({ paperOrderIds: ["b"], certOrderIds: [] });
    expect(NOTHING_PRINTED).toEqual({ paperOrderIds: [], certOrderIds: [] });
  });

  it("adds an id once when the answer repeats it", () => {
    expect(mergePrinted(NOTHING_PRINTED, { paperOrderIds: ["a", "a"], certOrderIds: [] }).paperOrderIds).toEqual(["a"]);
  });
});
