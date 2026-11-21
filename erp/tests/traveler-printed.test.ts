import { describe, expect, it } from "vitest";
import { keepTravelerPrinted } from "@/lib/traveler-printed";

// #550 ruling 2 (owner, 2026-10-18): the order hub keeps `travelerPrinted` monotonic in `load` as
// `applyMutation` already did, and both read this one leaf. A page that holds true keeps it against
// an order computed before the print committed; anything else hands back the order it was given, the
// same object, so the leaf changes nothing it was not asked to.

const order = (travelerPrinted: boolean) => ({ id: "order-1", poNumber: "PO-7", travelerPrinted });

describe("keepTravelerPrinted", () => {
  it("keeps a page's true against an order that says false, in a copy that is otherwise the order's", () => {
    const next = order(false);
    const kept = keepTravelerPrinted({ travelerPrinted: true }, next);
    expect(kept).toEqual({ id: "order-1", poNumber: "PO-7", travelerPrinted: true });
    expect(kept).not.toBe(next);
    expect(next.travelerPrinted).toBe(false); // the order it was handed is not written into
  });

  it("hands back the order itself when the page holds false or holds no order yet", () => {
    for (const prev of [{ travelerPrinted: false }, null]) {
      for (const printed of [false, true]) {
        const next = order(printed);
        expect(keepTravelerPrinted(prev, next)).toBe(next);
      }
    }
  });

  it("hands back the order itself when the order already says true", () => {
    const next = order(true);
    expect(keepTravelerPrinted({ travelerPrinted: true }, next)).toBe(next);
  });
});
