import { describe, expect, it } from "vitest";
import {
  breakBoxRefusal, breakFieldRefusal, newBreakRefusals, rowBoxRefusal, rowFieldRefusal,
} from "@/lib/pricing-refusals";

describe("a part's Pricing names a refused box by its place", () => {
  it.each([
    [2, "unitPrice", "1e2", "Operation 2, Unit price: enter a number without $ or commas, such as 0.36."],
    [1, "setupCharge", "-1", "Operation 1, Setup charge: cannot be negative."],
    [1, "minimumCharge", "1.005", "Operation 1, Minimum charge: use at most 2 digits after the point."],
    [1, "unitPrice", ".36", null],
    [1, "unitPrice", "", null],
  ] as const)("rowFieldRefusal(%i, %s, %j)", (op, field, text, line) => {
    expect(rowFieldRefusal(op, field, text)).toBe(line);
  });
  it("names a saved break by its place", () => {
    expect(breakFieldRefusal(2, 1, "price", "-1")).toBe("Operation 2, break 1, Price: cannot be negative.");
    expect(breakFieldRefusal(2, 3, "threshold", "0")).toBe("Operation 2, break 3, Threshold: must be greater than zero.");
  });
  it("lists both boxes of a new break", () => {
    expect(newBreakRefusals(2, { threshold: "0", price: "0.12345" })).toEqual([
      "Operation 2, new break, Threshold: must be greater than zero.",
      "Operation 2, new break, Price: use at most 4 digits after the point.",
    ]);
    expect(newBreakRefusals(1, { threshold: "100", price: ".36" })).toEqual([]);
  });
});

describe("the section's own wiring: which refusal, or none, for a box", () => {
  const rows = [
    { id: "p1", breaks: [{ id: "b1" }] },
    { id: "p2", breaks: [{ id: "b2" }, { id: "b3" }, { id: "b4" }] },
  ];
  it("counts the operation and the break from the order rendered", () => {
    expect(breakBoxRefusal(rows, "p2", "b4", "price", "-1")).toBe("Operation 2, break 3, Price: cannot be negative.");
    expect(breakBoxRefusal(rows, "p1", "b1", "threshold", "0")).toBe("Operation 1, break 1, Threshold: must be greater than zero.");
    expect(rowBoxRefusal(rows, "p2", "unitPrice", "1e2")).toBe(
      "Operation 2, Unit price: enter a number without $ or commas, such as 0.36.");
  });
  it("names nothing for a row or break that is not there", () => {
    expect(rowBoxRefusal(rows, "gone", "unitPrice", "1e2")).toBeNull();
    expect(breakBoxRefusal(rows, "gone", "b1", "price", "-1")).toBeNull();
    expect(breakBoxRefusal(rows, "p1", "gone", "price", "-1")).toBeNull();
  });
  it("names nothing for blank or space-only text, and for a good figure", () => {
    expect(rowBoxRefusal(rows, "p1", "unitPrice", "")).toBeNull();
    expect(rowBoxRefusal(rows, "p1", "unitPrice", "   ")).toBeNull();
    expect(breakBoxRefusal(rows, "p1", "b1", "price", "  ")).toBeNull();
    expect(breakBoxRefusal(rows, "p1", "b1", "price", ".36")).toBeNull();
  });
});
