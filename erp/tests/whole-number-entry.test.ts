// One rule reads a typed whole number for the master-data integer boxes (owner ruling 19 of the
// 2026-10-22 review, G5-4): digits alone, so `1e2` and `0x10` are refused where `Number()` read
// them as 100 and 16, and a figure outside the box's bounds is refused in a sentence that names the
// box and its bounds, where the server's zod answer named the camelCase key. The boxes are the
// four the ruling covers: a part's Load quantity and Request days override, a customer's Request days
// override (the same box), and Terms' Net days and Discount days.
import { describe, expect, it } from "vitest";
import { readWholeNumber, wholeNumberRefusal, wholeNumberSentence } from "@/lib/whole-number-entry";
import { DISCOUNT_DAYS, LOAD_QTY, NET_DAYS, REQUEST_DAYS_OVERRIDE } from "@/lib/whole-number-boxes";

describe("readWholeNumber", () => {
  it("reads digits, with spaces around them, as the whole number they spell", () => {
    expect(readWholeNumber("12", LOAD_QTY)).toEqual({ ok: true, value: 12 });
    expect(readWholeNumber("  7 ", LOAD_QTY)).toEqual({ ok: true, value: 7 });
    expect(readWholeNumber("007", LOAD_QTY)).toEqual({ ok: true, value: 7 });
    expect(readWholeNumber("0", REQUEST_DAYS_OVERRIDE)).toEqual({ ok: true, value: 0 });
    expect(readWholeNumber("3650", REQUEST_DAYS_OVERRIDE)).toEqual({ ok: true, value: 3650 });
  });

  it("refuses every spelling that is not digits: exponents, hex, a point, a sign, words, blank", () => {
    for (const text of ["1e2", "0x10", "12.", "12.0", ".5", "+5", "-1", "1,000", "abc", "", "  "]) {
      expect(readWholeNumber(text, LOAD_QTY)).toEqual({ ok: false });
    }
  });

  it("refuses a figure below the floor or above the ceiling", () => {
    expect(readWholeNumber("0", LOAD_QTY)).toEqual({ ok: false });
    expect(readWholeNumber("0", DISCOUNT_DAYS)).toEqual({ ok: false });
    expect(readWholeNumber("3651", REQUEST_DAYS_OVERRIDE)).toEqual({ ok: false });
    expect(readWholeNumber("4000", REQUEST_DAYS_OVERRIDE)).toEqual({ ok: false });
    // A run of digits too long for a safe integer is no figure the box can hold.
    expect(readWholeNumber("99999999999999999999", NET_DAYS)).toEqual({ ok: false });
  });
});

describe("wholeNumberSentence", () => {
  it("names the box and its floor, or both bounds when the box has a ceiling", () => {
    expect(wholeNumberSentence(LOAD_QTY)).toBe("Load quantity must be a whole number of at least 1.");
    expect(wholeNumberSentence(NET_DAYS)).toBe("Net days must be a whole number of at least 0.");
    expect(wholeNumberSentence(DISCOUNT_DAYS)).toBe("Discount days must be a whole number of at least 1.");
    // The owner's sentence for the one ceiling (2026-10-24).
    expect(wholeNumberSentence(REQUEST_DAYS_OVERRIDE)).toBe("Request days override must be a whole number from 0 to 3650.");
  });
});

describe("wholeNumberRefusal", () => {
  it("answers null for a figure that fits and for a blank box, whose meaning is the caller's", () => {
    expect(wholeNumberRefusal("12", LOAD_QTY)).toBeNull();
    expect(wholeNumberRefusal("", LOAD_QTY)).toBeNull();
    expect(wholeNumberRefusal("   ", REQUEST_DAYS_OVERRIDE)).toBeNull();
  });

  it("answers the box's one sentence for a spelling that is not digits and for a figure out of bounds", () => {
    expect(wholeNumberRefusal("1e2", LOAD_QTY)).toBe("Load quantity must be a whole number of at least 1.");
    expect(wholeNumberRefusal("0", LOAD_QTY)).toBe("Load quantity must be a whole number of at least 1.");
    expect(wholeNumberRefusal("4000", REQUEST_DAYS_OVERRIDE)).toBe("Request days override must be a whole number from 0 to 3650.");
    expect(wholeNumberRefusal("1.5", DISCOUNT_DAYS)).toBe("Discount days must be a whole number of at least 1.");
  });
});
