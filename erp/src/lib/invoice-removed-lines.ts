// The computed lines the operator removed from a draft invoice (#594; owner rulings 2026-10-21,
// 2026-11-02 and 2026-11-03). Save lines remembers one when it no longer sends it, Recalculate
// leaves every engine line with a remembered identity out, and Restore forgets one, so the next
// Recalculate bills it again as its own kind on its own account. Client-safe: the page lists them
// and the server reads `Invoice.removedLines` through `readRemovedLines`, so both read one shape.

import { formatMoney } from "./format";

/** One removal: the line's order-side identity (the server's `overrideKey`), and what the list
 *  shows of it, as the line stood when it was removed. */
export type RemovedLine = {
  identity: string;
  kind: string;
  /** The line's part number and words, or its words alone (`removedLineLabel`). */
  label: string;
  amount: number;
  removedAt: string;
};

/** The stored column, read defensively: anything that is not an array of well-formed entries is
 *  read as none, entry by entry, so one bad entry never hides the others. */
export function readRemovedLines(value: unknown): RemovedLine[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    if (typeof v !== "object" || v === null) return [];
    const e = v as Record<string, unknown>;
    if (typeof e.identity !== "string" || e.identity === "" || typeof e.kind !== "string"
      || typeof e.label !== "string" || typeof e.amount !== "number" || !Number.isFinite(e.amount)
      || typeof e.removedAt !== "string") return [];
    return [{ identity: e.identity, kind: e.kind, label: e.label, amount: e.amount, removedAt: e.removedAt }];
  });
}

/** A removed line's name in the list and in Restore's message: the part number and the line's
 *  words, or the words alone on a line with no part number (finalize's `labelOf` rule). */
export function removedLineLabel(l: { partNumber: string; description: string }): string {
  return l.partNumber === "" ? l.description : `${l.partNumber} — ${l.description}`;
}

export const REMOVED_LINES_HEADING = "Removed lines";
export const REMOVED_LINES_NOTE = "Recalculate leaves these out. Restore one and the next Recalculate bills it again.";

/** The figure a row shows beside its name: `$412.50 when removed`. */
export function amountWhenRemoved(amount: number): string {
  return `${formatMoney(amount)} when removed`;
}

/** The message under the list once a Restore lands. */
export function restoredMessage(label: string): string {
  return `${label} comes back at the next Recalculate.`;
}

/** The message under the list once Restore all lands (owner answer 2026-11-04). */
export function restoredAllMessage(count: number): string {
  return `${count} removed lines come back at the next Recalculate.`;
}

/** Restore all's button and its spoken name, drawn while the list holds two or more lines. */
export const RESTORE_ALL = "Restore all";
export const RESTORE_ALL_NAME = "Restore all removed lines";

/** The server's refusal of a Restore whose line is not on the list (restored already, or never
 *  removed). */
export const NOT_REMOVED = "That line is not on this invoice's removed lines";
