// The quote page's Save checks every decimal box through the one rule (decimal entry, #517 pull
// request 2, Task 2): each refused box is named by its place, `Line N, operation M, break K,
// <label>`, counted from 1 in the form's array order, and every refusal is listed in screen order,
// the three existing line refusals included. Pure: `linesPayload` reads only its argument.
import { describe, expect, it } from "vitest";
import { linesPayload, type BreakForm, type LineForm, type PriceForm } from "../src/app/quotes/quote-form";

let seq = 0;
const nextKey = () => `k-${++seq}`;

function brk(threshold: string, price: string): BreakForm {
  return { key: nextKey(), threshold, price };
}
function price(over: Partial<PriceForm> = {}): PriceForm {
  return {
    key: nextKey(), processStepCodeId: "step-a", stepCode: "HT", stepName: "Heat treat",
    setupCharge: "", unitPrice: "", minimumCharge: "", pricePer: "EACH", notes: "", breaks: [],
    ...over,
  };
}
function line(over: Partial<LineForm> = {}): LineForm {
  return {
    key: nextKey(), partId: null,
    partNumberText: "FT-1", partNameText: "", partDescriptionText: "", materialId: null, materialText: "",
    eachWeight: "", quotedQty: "", quotedUnlimited: false, prices: [], linkedOrders: [],
    ...over,
  };
}

describe("linesPayload refusals", () => {
  it("lists every refused box, in screen order, named by position", () => {
    const result = linesPayload([
      line({ partId: null, partNumberText: "FT-1", eachWeight: "0", prices: [
        price({ unitPrice: "$4.50", setupCharge: "-1" }),
        price({ minimumCharge: "1.005", breaks: [brk("100", "4.00"), brk("0", "abc")] }),
      ] }),
      line({ partId: "p1", eachWeight: "garbage-never-sent", prices: [price({ unitPrice: "123456789" })] }),
    ]);
    expect(result).toEqual({ ok: false, errors: [
      "Line 1, Each weight (lb): must be greater than zero.",
      "Line 1, operation 1, Setup charge: cannot be negative.",
      "Line 1, operation 1, Unit price: enter a number without $ or commas, such as 0.36.",
      "Line 1, operation 2, Minimum charge: use at most 2 digits after the point.",
      "Line 1, operation 2, break 2, Threshold: must be greater than zero.",
      "Line 1, operation 2, break 2, Price: enter a number without $ or commas, such as 0.36.",
      "Line 2, operation 1, Unit price: must be less than 100,000,000.",
    ] });
  });

  it("keeps the three line refusals in their place and words", () => {
    // Line 1: a blank free-text part number beside an Each weight fault. Line 2: a quantity of 1.5
    // beside a Unit price fault. Line 3: a blank break cell beside a fault in the same break's
    // other cell, and an operation-1 break fault ahead of an operation-2 box fault, so the list is
    // in screen order (an operation's boxes, then its breaks, then the next operation's).
    const result = linesPayload([
      line({ partNumberText: "  ", eachWeight: "1234567" }),
      line({ quotedQty: "1.5", prices: [price({ unitPrice: "0.12345" })] }),
      line({ prices: [
        price({ breaks: [brk("", "abc"), brk("1e2", "2")] }),
        price({ setupCharge: "12345678901" }),
      ] }),
    ]);
    expect(result).toEqual({ ok: false, errors: [
      "Line 1: pick a part or enter a free-text part number.",
      "Line 1, Each weight (lb): must be less than 1,000,000.",
      "Line 2: quoted quantity must be a whole number of at least 1.",
      "Line 2, operation 1, Unit price: use at most 4 digits after the point.",
      "Line 3, operation 1, break 1, Price: enter a number without $ or commas, such as 0.36.",
      "Line 3, operation 1, break 2, Threshold: enter a number without $ or commas, such as 0.36.",
      "Line 3, operation 2, Setup charge: must be less than 10,000,000,000.",
      "Line 3: a price break needs both a threshold and a price — delete the break instead of blanking it.",
    ] });
  });

  it("takes .36, 36., trailing and leading zeros, and blanks where a box takes none", () => {
    const typed = [
      line({ eachWeight: "000001.5000", quotedQty: "10", prices: [
        price({ setupCharge: ".36", unitPrice: "36.", minimumCharge: "", breaks: [brk("0100.00", "0.36000")] }),
        price({ setupCharge: "", unitPrice: " 4.50 ", minimumCharge: "0" }),
      ] }),
      line({ eachWeight: "" }),
    ];
    const result = linesPayload(typed);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The text is sent as typed: the server's rule trims and reads it.
    expect(result.lines[0]).toMatchObject({
      eachWeight: "000001.5000", quotedQty: 10,
      prices: [
        { setupCharge: ".36", unitPrice: "36.", minimumCharge: null, breaks: [{ threshold: "0100.00", price: "0.36000" }] },
        { setupCharge: null, unitPrice: " 4.50 ", minimumCharge: "0" },
      ],
    });
    expect(result.lines[1]).toMatchObject({ eachWeight: null, quotedQty: null });
  });

  it("never checks a linked line's hidden Each weight", () => {
    const result = linesPayload([line({ partId: "p1", partNumberText: "", eachWeight: "abc" })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines[0]).toMatchObject({ partId: "p1", eachWeight: null });
  });
});
