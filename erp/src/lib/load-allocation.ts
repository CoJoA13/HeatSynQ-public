import { INT4_MAX } from "./order-constants";
import { readFinishedDecimal, type DecimalBox } from "./decimal-entry";

export type AllocationRow = { qty: number | string | null; weight: number | string | null };
export type AllocationLine = { qty: number; weight: number };
export type AllocationMetric = {
  /** Weight values are integer cents of a pound; quantities are whole pieces. */
  allocated: bigint | null;
  ordered: bigint | null;
  /** Allocated minus ordered. Null means the comparison is unavailable. */
  difference: bigint | null;
  incomplete: boolean;
};
export type LoadAllocation = { quantity: AllocationMetric; weight: AllocationMetric };

type Parsed = { value: bigint | null; missing: boolean };
const ZERO = BigInt(0);
const HUNDRED = BigInt(100);
const LOAD_WEIGHT: DecimalBox = { intDigits: 10, scale: 2, min: "nonnegative" }; // decimalField(12, 2), nonnegative

function parse(value: AllocationRow["qty"], field: "qty" | "weight"): Parsed {
  if (value === null || (typeof value === "string" && value.trim() === "")) {
    // The saved-order warning counts absent fields as zero. Keep that arithmetic, but never
    // present a partly entered row as a completed allocation merely because the sum matches.
    return { value: ZERO, missing: true };
  }
  if (typeof value !== "number" && typeof value !== "string") return { value: null, missing: false };
  const raw = String(value).trim();
  const number = Number(raw);
  if (field === "qty") {
    // LoadsSection sends Number(input), then the server accepts positive int4 quantities.
    return { value: Number.isInteger(number) && number >= 1 && number <= INT4_MAX ? BigInt(number) : null, missing: false };
  }
  // The server's rule for a load's weight (decimalField(12, 2), nonnegative), read through the
  // same leaf. A partially typed decimal ("4.") or an invalid recovered field must not silently
  // turn into an allocated zero.
  if (readFinishedDecimal(raw, LOAD_WEIGHT) === null) return { value: null, missing: false };
  const [whole, fraction = ""] = raw.replace(/^-/, "").split(".");
  // The leaf has already held the fraction to two significant decimals, so its first two
  // characters, padded, are the cents: "0.36000" is 36, never 36,000. No pattern over the zeros.
  const cents = (fraction + "00").slice(0, 2);
  return { value: BigInt(whole || "0") * HUNDRED + BigInt(cents), missing: false };
}

function metric(rows: readonly AllocationRow[], lines: readonly AllocationLine[], field: "qty" | "weight"): AllocationMetric {
  let allocated: bigint | null = ZERO;
  let ordered: bigint | null = lines.length ? ZERO : null;
  let incomplete = rows.length === 0;
  for (const row of rows) {
    const parsed = parse(row[field], field);
    incomplete ||= parsed.missing;
    allocated = allocated === null || parsed.value === null ? null : allocated + parsed.value;
  }
  for (const line of lines) {
    const parsed = parse(line[field], field);
    ordered = ordered === null || parsed.value === null || parsed.missing ? null : ordered + parsed.value;
  }
  return { allocated, ordered, difference: allocated === null || ordered === null ? null : allocated - ordered, incomplete };
}

/** Client-safe advisory totals, including all supplied order lines (lead and riders).
 * BigInt accumulation preserves cents even when the combined order exceeds safe float cents.
 * This does not validate load numbering, authorize mutations, or add any allocation save gate.
 */
export function summarizeLoadAllocation(rows: readonly AllocationRow[], lines: readonly AllocationLine[]): LoadAllocation {
  return { quantity: metric(rows, lines, "qty"), weight: metric(rows, lines, "weight") };
}
