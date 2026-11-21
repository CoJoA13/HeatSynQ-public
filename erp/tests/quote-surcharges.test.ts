import { describe, expect, it } from "vitest";
import type { SurchargeInput } from "../src/server/pricing";
import { quoteSurchargeEstimates, type QuoteEstimateOperation } from "../src/server/quote-surcharges";

function sur(over: Partial<SurchargeInput> = {}): SurchargeInput {
  return {
    surchargeId: "s1", name: "EnergySur", kind: "PERCENT", rate: 0.04, amount: null,
    minimumAmount: null, scope: "ALL", stepCodeIds: [], position: 0,
    glAccountId: null, glAccountName: "", ...over,
  };
}
function op(amount: number | null, over: Partial<QuoteEstimateOperation> = {}): QuoteEstimateOperation {
  return { amount, needsPrice: false, processStepCodeId: null, ...over };
}

describe("quoteSurchargeEstimates", () => {
  it("figures a percent over every in-scope amount", () => {
    expect(quoteSurchargeEstimates([sur()], [op(100), op(50)]))
      .toEqual([{ name: "EnergySur", rateText: "4%", amount: 6 }]);
  });
  it("floors each line at the minimum on its own", () => {
    expect(quoteSurchargeEstimates([sur({ minimumAmount: 25 })], [op(100)])[0].amount).toBe(25);
  });
  it("judges INCLUDE and EXCLUDE by each operation's own step code", () => {
    const ops = [op(100, { processStepCodeId: "sc1" }), op(50, { processStepCodeId: "sc2" })];
    expect(quoteSurchargeEstimates([sur({ scope: "INCLUDE", stepCodeIds: ["sc1"] })], ops)[0].amount).toBe(4);
    expect(quoteSurchargeEstimates([sur({ scope: "EXCLUDE", stepCodeIds: ["sc1"] })], ops)[0].amount).toBe(2);
    expect(quoteSurchargeEstimates([sur({ scope: "INCLUDE", stepCodeIds: ["sc1"] })], [op(100)])).toEqual([]);
  });
  it("prints no row when nothing is in scope, and none for a line with no operations", () => {
    const ops = [op(100, { processStepCodeId: "sc2" })];
    expect(quoteSurchargeEstimates([sur({ scope: "INCLUDE", stepCodeIds: ["sc1"] })], ops)).toEqual([]);
    expect(quoteSurchargeEstimates([sur()], [])).toEqual([]);
  });
  it("a null amount in scope gives the rate and no figure", () => {
    expect(quoteSurchargeEstimates([sur()], [op(null)])[0]).toMatchObject({ rateText: "4%", amount: null });
  });
  it("a percent estimate is not the minimum when an amount is incomplete", () => {
    expect(quoteSurchargeEstimates([sur({ rate: 0.04, minimumAmount: 25 })], [op(null)]))
      .toEqual([{ name: "EnergySur", rateText: "4%", amount: null }]);
  });
  it("no partial figure", () => {
    expect(quoteSurchargeEstimates([sur()], [op(100), op(null)])[0].amount).toBeNull();
  });
  it("a null amount out of scope does not stop the figure", () => {
    const ops = [op(100, { processStepCodeId: "sc1" }), op(null, { processStepCodeId: "sc2" })];
    expect(quoteSurchargeEstimates([sur({ scope: "INCLUDE", stepCodeIds: ["sc1"] })], ops)[0].amount).toBe(4);
  });
  it("an unpriced row in scope gives no figure (ruling 4f)", () => {
    expect(quoteSurchargeEstimates([sur()], [op(2, { needsPrice: true })])[0].amount).toBeNull();
  });
  it("a flat surcharge prints its figure with no amounts", () => {
    expect(quoteSurchargeEstimates([sur({ kind: "FLAT", rate: null, amount: 75 })], [op(null)])[0])
      .toMatchObject({ rateText: null, amount: 75 });
  });
  it("a flat surcharge is floored at its minimum", () => {
    expect(quoteSurchargeEstimates([sur({ kind: "FLAT", rate: null, amount: 10, minimumAmount: 15 })], [op(1)])[0].amount).toBe(15);
  });
  it("a percent with no rate prints no rate text", () => {
    expect(quoteSurchargeEstimates([sur({ rate: null })], [op(100)])[0].rateText).toBeNull();
  });
  it("keeps the order it is handed", () => {
    const rows = quoteSurchargeEstimates([sur({ name: "B" }), sur({ name: "A" })], [op(100)]);
    expect(rows.map((r) => r.name)).toEqual(["B", "A"]);
  });
});
