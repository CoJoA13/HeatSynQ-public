// erp/tests/decimal-entry.test.ts
import { describe, expect, it } from "vitest";
import {
  decimalRefusal, decimalSentence, percentBoxOf, readDecimal, readFinishedDecimal, spelledDecimal, type DecimalBox,
} from "@/lib/decimal-entry";
import { LINE_NET_WEIGHT, TARE_EACH } from "@/lib/order-boxes";

const PRICE: DecimalBox = { intDigits: 8, scale: 4, min: "nonnegative" };
const WEIGHT: DecimalBox = { intDigits: 10, scale: 2, min: "positive" };
const SIGNED: DecimalBox = { intDigits: 10, scale: 2 };

describe("spelledDecimal", () => {
  it.each([
    [".36", 0.36, true], ["-.36", -0.36, true], ["36.", 36, false], ["0.36", 0.36, true],
    ["0000.3600", 0.36, true], [" 36 ", 36, true], ["-0", -0, true], ["36", 36, true],
  ])("reads %j as %d (finished %s)", (text, value, finished) => {
    expect(spelledDecimal(text)).toEqual({ value, finished });
  });
  it.each([
    "", " ", ".", "-", "-.", "+0.36", "$0.36", "0,36", "1,250.00", "1e2", "0x10", "0b11",
    "4%", "heavy", "3 6", "Infinity", "NaN", "--1", "1.2.3", "9".repeat(400),
  ])("refuses %j", (text) => {
    expect(spelledDecimal(text)).toBeNull();
  });
});

describe("readDecimal", () => {
  it.each([
    [".36", PRICE, 0.36], ["36.", PRICE, 36], ["0.36", PRICE, 0.36], ["0000.3600", PRICE, 0.36],
    ["99999999.9999", PRICE, 99999999.9999], ["0", PRICE, 0], ["-0", PRICE, -0],
    ["000000000.36", PRICE, 0.36], ["-0000000000012.5", SIGNED, -12.5],
    ["0.36000", PRICE, 0.36], ["7.12340", { intDigits: 5, scale: 4, min: "nonnegative" } as DecimalBox, 7.1234],
    ["0.1" + "0".repeat(400), WEIGHT, 0.1],
    ["-.36", SIGNED, -0.36], ["-9999999999.99", SIGNED, -9999999999.99], [".01", WEIGHT, 0.01],
  ])("accepts %j", (text, box, value) => {
    expect(readDecimal(text, box)).toEqual({ ok: true, value });
  });

  it.each([
    ["$0.36", PRICE, "notNumber"], ["1e2", PRICE, "notNumber"], [".", PRICE, "notNumber"],
    ["+0.36", PRICE, "notNumber"], ["0.36125", PRICE, "tooManyDecimals"],
    ["0.36101", PRICE, "tooManyDecimals"], ["123456789", PRICE, "tooLarge"],
    ["0000000000000", WEIGHT, "notPositive"], ["-1", PRICE, "negative"],
    ["-123456789", PRICE, "negative"], ["-0.12345", PRICE, "negative"],
    ["0", WEIGHT, "notPositive"], ["-0", WEIGHT, "notPositive"], ["-5", WEIGHT, "notPositive"],
    ["12345678901", SIGNED, "tooLarge"], ["-12345678901", SIGNED, "tooLarge"],
    ["9".repeat(400), PRICE, "tooLarge"], ["-" + "9".repeat(400), SIGNED, "tooLarge"],
    ["0." + "0".repeat(400) + "1", WEIGHT, "tooManyDecimals"],
    ["-0." + "0".repeat(400) + "1", PRICE, "negative"],
    ["123456789.12345", PRICE, "tooManyDecimals"], ["-12345678901", WEIGHT, "notPositive"],
  ])("refuses %j as %s", (text, box, fault) => {
    expect(readDecimal(text, box)).toEqual({ ok: false, fault });
  });

  it("reads a number through its decimal spelling, as decimalField always has", () => {
    expect(readDecimal(0.36, PRICE)).toEqual({ ok: true, value: 0.36 });
    expect(readDecimal(Number.NaN, PRICE)).toEqual({ ok: false, fault: "notNumber" });
    expect(readDecimal(Number.POSITIVE_INFINITY, PRICE)).toEqual({ ok: false, fault: "notNumber" });
    expect(readDecimal(1e21, SIGNED)).toEqual({ ok: false, fault: "notNumber" }); // "1e+21"
    expect(readDecimal(0.12345, PRICE)).toEqual({ ok: false, fault: "tooManyDecimals" });
  });
});

// The server reads request bodies through this rule, so a long body must cost a linear scan. The
// 1-second bound is what fails a quadratic pattern (10 s and more at this length).
describe("readDecimal on a very long body", () => {
  it("refuses a long run of digits ending in a letter as not a number", () => {
    expect(readDecimal("9".repeat(200_000) + "x", PRICE)).toEqual({ ok: false, fault: "notNumber" });
  }, 1000);
  it("refuses a long run of zeros after the point, then a digit, as too many decimals", () => {
    expect(readDecimal("0." + "0".repeat(200_000) + "1", WEIGHT)).toEqual({ ok: false, fault: "tooManyDecimals" });
  }, 1000);
  it("refuses a one followed by a long run of zeros as too large", () => {
    expect(readDecimal("1" + "0".repeat(200_000), PRICE)).toEqual({ ok: false, fault: "tooLarge" });
  }, 1000);
});

describe("readFinishedDecimal", () => {
  it("is readDecimal's figure, except that a spelling ending at its point is none yet", () => {
    expect(readFinishedDecimal(".5", WEIGHT)).toBe(0.5);
    expect(readFinishedDecimal("42.", WEIGHT)).toBeNull();
    expect(readFinishedDecimal(" 42. ", WEIGHT)).toBeNull();
    expect(readFinishedDecimal("1.005", WEIGHT)).toBeNull();
    expect(readFinishedDecimal(42, WEIGHT)).toBe(42);
  });
});

describe("decimalSentence", () => {
  it.each([
    ["notNumber", PRICE, "enter a number without $ or commas, such as 0.36."],
    ["tooManyDecimals", PRICE, "use at most 4 digits after the point."],
    ["tooManyDecimals", { intDigits: 3, scale: 1, min: "nonnegative" }, "use at most 1 digit after the point."],
    ["tooLarge", PRICE, "must be less than 100,000,000."],
    ["tooLarge", WEIGHT, "must be less than 10,000,000,000."],
    ["tooLarge", { intDigits: 2, scale: 4, min: "nonnegative" }, "must be less than 100."],
    ["tooLarge", SIGNED, "must be between -10,000,000,000 and 10,000,000,000."],
    ["negative", PRICE, "cannot be negative."],
    ["notPositive", WEIGHT, "must be greater than zero."],
  ] as const)("%s in %j", (fault, box, sentence) => {
    expect(decimalSentence(fault, box)).toBe(sentence);
  });
});

describe("decimalRefusal", () => {
  it.each([
    ["Unit price", "", null],
    ["Unit price", "   ", null],
    ["Unit price", ".36", null],
    ["Unit price", "$0.36", "Unit price: enter a number without $ or commas, such as 0.36."],
    ["Line 1, operation 2, Unit price", " 0.12345 ", "Line 1, operation 2, Unit price: use at most 4 digits after the point."],
  ] as const)("%s %j", (name, text, line) => {
    expect(decimalRefusal(name, text, PRICE)).toBe(line);
  });
});

describe("decimalRefusal, a box that must hold a figure", () => {
  const NAME = "Lead line, Net weight (lb)";
  it.each([
    ["", true, `${NAME}: must be greater than zero.`],
    ["   ", true, `${NAME}: must be greater than zero.`],
    ["   ", false, null],
    ["", undefined, null],
    ["12.5", true, null],
    ["0", true, `${NAME}: must be greater than zero.`],
  ] as const)("%j required %j", (text, required, line) => {
    expect(decimalRefusal(NAME, text, LINE_NET_WEIGHT.box, required === undefined ? undefined : { required })).toBe(line);
  });

  it("a nonnegative box refuses a blank as not a number", () => {
    expect(decimalRefusal("Container 1, Tare each (lb)", " ", TARE_EACH.box, { required: true }))
      .toBe("Container 1, Tare each (lb): enter a number without $ or commas, such as 0.36.");
  });
});

describe("a percent box", () => {
  it("only the not-a-figure sentence changes", () => {
    const plain: DecimalBox = { intDigits: 5, scale: 4 };
    expect(decimalSentence("notNumber", { ...plain, unit: "percent" }))
      .toBe("enter a number without % or commas, such as 7.25.");
    expect(decimalSentence("notNumber", plain)).toBe("enter a number without $ or commas, such as 0.36.");
    for (const fault of ["tooManyDecimals", "tooLarge", "negative", "notPositive"] as const) {
      expect(decimalSentence(fault, { ...plain, unit: "percent" })).toBe(decimalSentence(fault, plain));
    }
  });

  it("percentBoxOf moves two digits from the scale to the integer part and keeps min only when set", () => {
    expect(percentBoxOf({ intDigits: 3, scale: 6, min: "nonnegative" }))
      .toEqual({ intDigits: 5, scale: 4, min: "nonnegative", unit: "percent" });
    const unset = percentBoxOf({ intDigits: 3, scale: 6 });
    expect(unset).toEqual({ intDigits: 5, scale: 4, unit: "percent" });
    expect("min" in unset).toBe(false);
  });
});
