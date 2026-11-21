// Client-safe and pure, with no imports: the one rule for a typed decimal (decimal entry design,
// docs/superpowers/specs/2026-10-14-decimal-entry-design.md §2). The server's `decimalField` and
// every page read a typed figure through it, so the same text gets the same answer everywhere.
// `tests/decimal-pattern-sweep.test.ts` refuses a decimal pattern written outside its listed exemptions in `src/`.
//
// A box is described by its limits: the most digits before the point (a column's precision minus
// its scale), the most after it (its scale), and whether it takes zero or a figure below zero.
// Digits that do not change the figure are not counted (§9 O2): zeros before the first other
// digit before the point, and zeros at the end after it. So "0.36000" is 0.36 in a four-decimal
// box, and every refusal's sentence is true of the figure typed.

export type DecimalBox = {
  intDigits: number;
  scale: number;
  min?: "positive" | "nonnegative";
  /** A box the screen reads as a percent (`7.25`, not the stored fraction). Only the not-a-figure
   *  sentence reads it; the server's `decimalBoxField` passes no unit on, so its sentence stays the
   *  plain one. */
  unit?: "percent";
};

export type DecimalFault = "notNumber" | "tooManyDecimals" | "tooLarge" | "negative" | "notPositive";

export type DecimalReading = { ok: true; value: number } | { ok: false; fault: DecimalFault };

// An optional minus, then digits with an optional point and optional digits after it, or a point
// and digits: `36`, `36.`, `36.5`, `.5`. At least one digit in all, so `.` and `-` are not figures.
// The point and the digits after it are one optional group, so a long run of digits followed by a
// character that is not one can only be given back one digit at a time (linear), never split two
// ways between `\d+` and `\d*` (quadratic): this reads request bodies on the server.
const SPELLING = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;

/** The figure a decimal spelling names, or null when the text is not one. `finished` is false for a
 *  spelling that ends at its point (`36.`): a person typing `36.5` passes through it, so a caller
 *  comparing text being typed must not read it as 36 yet. A spelling too long to be finite is no
 *  figure (null), and one too small for a number reads as 0. */
export function spelledDecimal(text: string): { value: number; finished: boolean } | null {
  const trimmed = text.trim();
  if (!SPELLING.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  return { value, finished: !trimmed.endsWith(".") };
}

/** Whether the typed text, or a number read through its decimal spelling, fits `box`. The faults
 *  are checked in this order and the first that applies is the answer: not a number, then the
 *  sign (a box that takes no negative or no zero), then digits after the point, then digits
 *  before it. All four are judged from the text, and the text becomes a number only once it fits:
 *  a 400-digit figure is too large, not "not a number" because it overflows to Infinity, and a
 *  figure with 400 zeros after the point has too many decimals, not "zero" because it underflows. */
export function readDecimal(input: string | number, box: DecimalBox): DecimalReading {
  const text = typeof input === "number" ? String(input) : input.trim();
  if (!SPELLING.test(text)) return { ok: false, fault: "notNumber" };
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const zero = !/[1-9]/.test(unsigned);
  if (box.min === "positive" && (negative || zero)) return { ok: false, fault: "notPositive" };
  if (box.min === "nonnegative" && negative && !zero) return { ok: false, fault: "negative" };
  const [whole, fraction = ""] = unsigned.split(".");
  // Zeros at the end after the point, and before the first other digit before it, do not change
  // the figure, so they are not counted (§9 O2, as amended): "0.36000" and "000000000.36" are 0.36.
  if (significantDecimals(fraction) > box.scale) return { ok: false, fault: "tooManyDecimals" };
  if (whole.replace(/^0+/, "").length > box.intDigits) return { ok: false, fault: "tooLarge" };
  return { ok: true, value: Number(text) };
}

/** The digits of a fraction up to its last other-than-zero digit, counted by one scan from the end:
 *  a pattern for the trailing zeros is quadratic on a long run of them followed by another digit. */
function significantDecimals(fraction: string): number {
  let end = fraction.length;
  while (end > 0 && fraction.charCodeAt(end - 1) === 48) end -= 1;
  return end;
}

/** `readDecimal`'s figure, or null. A spelling that ends at its point is none yet, for a caller
 *  that reads a box while it is being typed in (a running total, a live verdict). */
export function readFinishedDecimal(input: string | number, box: DecimalBox): number | null {
  const reading = readDecimal(input, box);
  if (!reading.ok) return null;
  return typeof input === "string" && input.trim().endsWith(".") ? null : reading.value;
}

/** 10 to the power `digits`, grouped with commas: 8 → "100,000,000". */
function limitText(digits: number): string {
  return ("1" + "0".repeat(digits)).replace(/\B(?=(?:\d{3})+$)/g, ",");
}

/** The box a person types a percent into, from the box its stored fraction is read through: the
 *  fraction's two leading decimal places become the percent's two integer digits. */
export function percentBoxOf(stored: DecimalBox): DecimalBox {
  return {
    intDigits: stored.intDigits + 2,
    scale: stored.scale - 2,
    ...(stored.min === undefined ? {} : { min: stored.min }),
    unit: "percent",
  };
}

/** The sentence for a fault, to follow the box's name and a colon (spec §1.2 ruling 4). */
export function decimalSentence(fault: DecimalFault, box: DecimalBox): string {
  switch (fault) {
    case "notNumber":
      return box.unit === "percent"
        ? "enter a number without % or commas, such as 7.25."
        : "enter a number without $ or commas, such as 0.36.";
    case "tooManyDecimals":
      return `use at most ${box.scale} digit${box.scale === 1 ? "" : "s"} after the point.`;
    case "tooLarge": {
      const limit = limitText(box.intDigits);
      return box.min === undefined ? `must be between -${limit} and ${limit}.` : `must be less than ${limit}.`;
    }
    case "negative":
      return "cannot be negative.";
    case "notPositive":
      return "must be greater than zero.";
  }
}

/** One refused box's line, `<name>: <sentence>`, or null when the text fits or is blank. A blank
 *  box is the caller's question: some boxes take none, some refuse it in their own words. A box
 *  that must hold a figure (`required`) refuses a blank or space-only text with the sentence for
 *  zero in that box: "must be greater than zero." where it takes only a figure above zero, else
 *  "enter a number ...". */
export function decimalRefusal(
  name: string, text: string, box: DecimalBox, opts?: { required?: boolean },
): string | null {
  if (text.trim() === "") {
    if (!opts?.required) return null;
    return `${name}: ${decimalSentence(box.min === "positive" ? "notPositive" : "notNumber", box)}`;
  }
  const reading = readDecimal(text, box);
  return reading.ok ? null : `${name}: ${decimalSentence(reading.fault, box)}`;
}
