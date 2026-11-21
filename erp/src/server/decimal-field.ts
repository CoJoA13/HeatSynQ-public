import { z } from "zod";
import { decimalSentence, readDecimal, type DecimalBox } from "@/lib/decimal-entry";

// Accepts a plain number or a decimal string ("25000.00"), but never an arbitrary string: an
// invalid one (e.g. "not-a-number") used to sail through zod as a string and blow up inside
// Prisma with a PrismaClientValidationError, which has no HTTP status and escapes handle() as a
// bare 500 instead of the field-anchored 400 Spec §12 promises.
//
// `precision`/`scale` must match the column's own `@db.Decimal(precision, scale)` exactly — see
// the paired comment on Customer.creditLimit/financeChargeRate in prisma/schema.prisma, which
// points back here. A shared, column-agnostic validator (the previous shape of this function)
// only checked that a value WAS a decimal, never that it FIT the specific column it was headed
// for: "100" is a fine decimal but overflows financeChargeRate's Decimal(6,4) (max 99.9999) and
// blows up inside Prisma with a status-less error (still a 500); "1.005" is a fine decimal but
// has one more fractional digit than creditLimit's Decimal(12,2) allows, so Postgres silently
// rounds it to 1.01 on write. Both are field-anchored 400s here instead. The digit limits are the
// column's, so a value that passes can neither overflow the column nor lose precision to rounding.
// The reading and the sentences are `src/lib/decimal-entry.ts`'s, the one rule every page reads
// through (decimal entry design §2.2).
// Overloads, not a single signature: the implementation's own inferred return type is a flat
// union (number | null | undefined) because the `shaped = opts?.required ? base : ...` ternary
// is evaluated at runtime, not at the type level, so TS can't narrow it per call site from the
// body alone. At runtime `required: true` genuinely can never produce null/undefined (`shaped`
// is `base` with no `.nullable().optional()`, so the transform's null/undefined branch is
// unreachable) — these overloads just let the caller's type reflect that existing guarantee.
export function decimalField(
  precision: number, scale: number,
  opts: { required: true; min?: "positive" | "nonnegative" },
): z.ZodType<number, number | string>;
export function decimalField(
  precision: number, scale: number,
  opts?: { required?: false; min?: "positive" | "nonnegative" },
): z.ZodType<number | null | undefined, number | string | null | undefined>;
export function decimalField(
  precision: number, scale: number,
  opts?: { required?: boolean; min?: "positive" | "nonnegative" },
): z.ZodType<number | null | undefined, number | string | null | undefined> {
  const box: DecimalBox = { intDigits: precision - scale, scale, min: opts?.min };
  const base = z.union([z.number(), z.string()]);
  const shaped = opts?.required ? base : base.nullable().optional();
  return shaped.transform((value, ctx) => {
    if (value === null || value === undefined) return value as null | undefined;
    // A number is read through its decimal string, so NaN and Infinity are "not a number".
    const reading = readDecimal(value, box);
    if (!reading.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: decimalSentence(reading.fault, box) });
      return z.NEVER;
    }
    return reading.value;
  });
}

// A box stated once in `src/lib/` (price-boxes.ts) read as a schema field. As with `decimalField`,
// the box's digits must match the column's `@db.Decimal(intDigits + scale, scale)` exactly.
export function decimalBoxField(
  box: DecimalBox,
  opts: { required: true },
): z.ZodType<number, number | string>;
export function decimalBoxField(
  box: DecimalBox,
  opts?: { required?: false },
): z.ZodType<number | null | undefined, number | string | null | undefined>;
export function decimalBoxField(
  box: DecimalBox,
  opts?: { required?: boolean },
): z.ZodType<number | null | undefined, number | string | null | undefined> {
  // Deliberately passes no `unit` on: the server answers the plain sentence, and a pasted figure
  // keeps the server's wording (owner ruling).
  const precision = box.intDigits + box.scale;
  return opts?.required
    ? decimalField(precision, box.scale, { required: true, min: box.min })
    : decimalField(precision, box.scale, { min: box.min });
}
