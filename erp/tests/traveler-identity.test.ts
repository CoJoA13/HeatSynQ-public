import { describe, expect, it } from "vitest";
import { canonicalPrintExpectation, type PrintExpectationInput } from "@/lib/traveler-selection";
import { printExpectationFor } from "@/server/traveler-identity";

const saved: PrintExpectationInput = {
  id: "order-demo-008", customerId: "customer-demo",
  lines: [
    { partId: "part-lead", revisionNumber: 1, qty: 20, weight: 2540 },
    { partId: "part-rider", revisionNumber: null, qty: 10, weight: 1270 },
  ],
  loads: [
    { loadNumber: 1, qty: 15, weight: 1905 },
    { loadNumber: 2, qty: 15, weight: 1905 },
  ],
};

describe("saved traveler print identity", () => {
  it("canonicalizes object keys and load order without mutating the input", () => {
    const reordered = {
      loads: [...saved.loads].reverse(),
      lines: saved.lines.map((line) => ({
        weight: line.weight, qty: line.qty, revisionNumber: line.revisionNumber, partId: line.partId,
      })),
      customerId: saved.customerId,
      id: saved.id,
      notes: "Unrelated DTO additions do not participate",
    };
    expect(canonicalPrintExpectation(reordered)).toBe(canonicalPrintExpectation(saved));
    expect(printExpectationFor(reordered)).toBe(printExpectationFor(saved));
    expect(reordered.loads.map((load) => load.loadNumber)).toEqual([2, 1]);
    expect(printExpectationFor(saved)).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(canonicalPrintExpectation(saved)).lines[0].weightCents).toBe("254000");
  });

  it.each(["line", "load"])("a one-cent %s change changes the expectation", (target) => {
    const changed = structuredClone(saved);
    if (target === "line") changed.lines[0].weight += 0.01;
    else changed.loads[0].weight! += 0.01;
    expect(printExpectationFor(changed)).not.toBe(printExpectationFor(saved));
  });

  it("different orders with identical quantities and loads have different identities", () => {
    expect(printExpectationFor({ ...saved, id: "order-demo-009" })).not.toBe(printExpectationFor(saved));
    expect(printExpectationFor({ ...saved, customerId: "customer-other" })).not.toBe(printExpectationFor(saved));
  });

  it("preserves meaningful line ordering, revision identity and nullable loads", () => {
    expect(printExpectationFor({ ...saved, lines: [...saved.lines].reverse() })).not.toBe(printExpectationFor(saved));
    expect(printExpectationFor({ ...saved, lines: [{ ...saved.lines[0], revisionNumber: 2 }, saved.lines[1]] }))
      .not.toBe(printExpectationFor(saved));
    const incomplete = { ...saved, loads: [{ loadNumber: 1, qty: null, weight: null }] };
    const zero = { ...saved, loads: [{ loadNumber: 1, qty: 0, weight: 0 }] };
    expect(printExpectationFor(incomplete)).not.toBe(printExpectationFor(zero));
    expect(JSON.parse(canonicalPrintExpectation(incomplete)).loads[0])
      .toEqual({ loadNumber: 1, qty: null, weightCents: null });
  });
});
