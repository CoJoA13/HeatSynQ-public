import { describe, expect, it } from "vitest";
import { compareMenuText, inMenuOrder } from "@/lib/menu-order";

// #1056 ruling 4 (owner, 2026-11-25): a menu sorts numbers by value, in the browser, by one rule.
describe("compareMenuText", () => {
  const sorted = (xs: string[]) => [...xs].sort(compareMenuText);

  it("orders a run of digits by its value, not as text", () => {
    expect(sorted(["10", "9", "100001", "92036", "2"])).toEqual(["2", "9", "10", "92036", "100001"]);
    expect(sorted(["A10", "A2", "A1"])).toEqual(["A1", "A2", "A10"]);
    expect(sorted(["WIDGET-100", "WIDGET-20", "WIDGET-3"])).toEqual(["WIDGET-3", "WIDGET-20", "WIDGET-100"]);
  });

  it("reads each digit run between separators as its own number (a GL account's segments)", () => {
    expect(sorted(["4000.10", "4000.2", "4001", "4000.15"])).toEqual(["4000.2", "4000.10", "4000.15", "4001"]);
    // A separator is never dropped: dropping it would read 1-200 as 1200 and put it after 13.
    expect(sorted(["13", "1-200"])).toEqual(["1-200", "13"]);
  });

  it("ignores case, so a lower-case code sits beside its upper-case neighbours", () => {
    expect(sorted(["b", "A", "a3", "A2"])).toEqual(["A", "A2", "a3", "b"]);
  });

  it("breaks a tie that ignores case by the text itself, so the order never depends on the input's", () => {
    expect(sorted(["abc", "ABC", "Abc"])).toEqual(sorted(["Abc", "abc", "ABC"]));
    expect(compareMenuText("abc", "ABC")).not.toBe(0);
    expect(compareMenuText("same", "same")).toBe(0);
  });
});

describe("inMenuOrder", () => {
  it("sorts by the key it is given and leaves the input array alone", () => {
    const rows = [{ code: "C10" }, { code: "C9" }];
    expect(inMenuOrder(rows, (r) => r.code)).toEqual([{ code: "C9" }, { code: "C10" }]);
    expect(rows).toEqual([{ code: "C10" }, { code: "C9" }]);
  });

  it("orders equal first keys by the next key (one part number held by two customers)", () => {
    const parts = [
      { partNumber: "P-1", customer: "ZED" }, { partNumber: "P-1", customer: "ACME" }, { partNumber: "P-0", customer: "ZED" },
    ];
    expect(inMenuOrder(parts, (p) => p.partNumber, (p) => p.customer).map((p) => `${p.partNumber}/${p.customer}`))
      .toEqual(["P-0/ZED", "P-1/ACME", "P-1/ZED"]);
  });
});
