import { z } from "zod";

export type TravelerSelection = { mode: "all" } | { mode: "loads"; loadNumbers: number[] };

export const travelerSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }).strict(),
  z.object({ mode: z.literal("loads"), loadNumbers: z.array(z.number().int().positive().safe())
    .min(1).max(100).refine(numbers => new Set(numbers).size === numbers.length,
      "Select each load only once") }).strict(),
]);

/** Reject malformed sets before sorting; never silently discard an invalid entry. */
export function normalizeTravelerSelection(input: unknown): TravelerSelection {
  const selection = travelerSelectionSchema.parse(input);
  return selection.mode === "all" ? selection
    : { mode: "loads", loadNumbers: [...selection.loadNumbers].sort((a, b) => a - b) };
}

/** Coverage comes from the archived row, never today's editable load plan. */
export function travelerCoverageLabel(meta: { loadNumber: number | null; travelerLoadNumbers?: number[] }): string {
  if (meta.travelerLoadNumbers?.length) return `Loads ${meta.travelerLoadNumbers.join(", ")}`;
  return meta.loadNumber === null ? "All loads" : `Load ${meta.loadNumber}`;
}

export type PrintExpectationInput = {
  id: string;
  customerId: string;
  /** Ordered by saved line position; the first line owns the process revision. */
  lines: { partId: string; revisionNumber: number | null; qty: number; weight: number }[];
  loads: { loadNumber: number; qty: number | null; weight: number | null }[];
};

/** Client-safe saved-state projection. Callers supply validated persisted two-decimal weights.
 * Line order is meaningful; load order is normalized by the saved load number.
 * Only these fields participate, so DTO additions and object insertion order cannot change it. */
export function canonicalPrintExpectation(input: PrintExpectationInput): string {
  return JSON.stringify({
    id: input.id,
    customerId: input.customerId,
    lines: input.lines.map((line) => ({
      partId: line.partId,
      revisionNumber: line.revisionNumber,
      qty: line.qty,
      weightCents: String(Math.round(line.weight * 100)),
    })),
    loads: [...input.loads].sort((a, b) => a.loadNumber - b.loadNumber).map((load) => ({
      loadNumber: load.loadNumber,
      qty: load.qty,
      weightCents: load.weight === null ? null : String(Math.round(load.weight * 100)),
    })),
  });
}
