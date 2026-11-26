// Client-safe and pure: the Invoicing list's Finalize selected (#1057 ruling 2b, owner 2026-11-26, and
// the build answers of the same day). The register's one box column takes a draft's box for Finalize
// selected beside a finalized, unprinted row's for Print selected (`registerTickable`); the run sends
// one finalize per ticked draft, in the list's order, through the single Finalize's own route
// (`POST /api/invoices/<id>/finalize`, so each draft gets every check a single Finalize runs, under
// its Serializable transaction and the period lock), and each refusal is its own row's, as are a
// finalized row's warnings, read from its answer (owner ruling 2026-11-26 on #1063). The shape is
// Print selected's (`runSelectedPrints`, src/lib/print-selected.ts): one at a time, never
// Promise.all, and `stillOpen` asked before each request, so leaving the page stops the run after
// the request in flight. Decided here, not inline in InvoicingList, for line-field-saves.ts's reason:
// vitest has no component renderer.

import type { InvoiceStatusValue } from "./invoice-constants";
import { printTickable } from "./invoice-printed";
import { unansweredStatus } from "./line-field-saves";

/** A finalize whose answer the page cannot trust: it may have committed. */
export const LOST_FINALIZE = "It may have finalized, but the answer was lost. Reload to see.";

/** One finalize request, `POST /api/invoices/<id>/finalize`, as the page sends it. */
export type PostFinalize = (id: string) => Promise<Response>;

export type SelectedFinalizeRun = {
  /** Each finalized row's id, in run order. */
  finalized: string[];
  /** Invoice id → the sentence shown beside that row. */
  failures: Map<string, string>;
  /** Invoice id → the warnings a finalized row's answer carried (the finalize route's own
   *  `warnings`, `invoiceWarnings`: needs price, no GL account and the like), shown beside its row as
   *  the invoice page shows them (owner ruling 2026-11-26 on #1063: "Yes, show warnings"). Only a
   *  finalized row with at least one warning is here, so no row is in both maps. */
  warnings: Map<string, string[]>;
  /** Whether `stillOpen` answered false before a request, so the rest were never sent. */
  stopped: boolean;
};

/** Whether a register row takes a box for Finalize selected: a draft, invoice or credit, on a live
 *  order (a draft on a voided order cannot finalize: the route refuses it, as `printTickable`
 *  draws no box for a print that would be refused). */
export function finalizeTickable(row: { status: InvoiceStatusValue; orderVoided: boolean }): boolean {
  return row.status === "DRAFT" && !row.orderVoided;
}

/** Whether a register row draws a box at all: for Finalize selected or for Print selected. */
export function registerTickable(row: {
  status: InvoiceStatusValue; printedAt: string | null; orderVoided: boolean;
}): boolean {
  return finalizeTickable(row) || printTickable(row);
}

/** Finalizes each id through `post`, one at a time in the order given, and returns which finalized
 *  and each failure's sentence. A failure is that row's alone and the run carries on. */
export async function runSelectedFinalizes(
  ids: readonly string[], post: PostFinalize, stillOpen: () => boolean,
): Promise<SelectedFinalizeRun> {
  const finalized: string[] = [];
  const failures = new Map<string, string>();
  const warnings = new Map<string, string[]>();
  for (const id of ids) {
    if (!stillOpen()) return { finalized, failures, warnings, stopped: true };
    const outcome = await finalizeOne(id, post);
    if (typeof outcome === "string") {
      failures.set(id, outcome);
    } else {
      finalized.push(id);
      if (outcome.warnings.length > 0) warnings.set(id, outcome.warnings);
    }
  }
  return { finalized, failures, warnings, stopped: false };
}

/** The finalized draft's warnings, or the sentence its row shows. */
async function finalizeOne(id: string, post: PostFinalize): Promise<{ warnings: string[] } | string> {
  let refused: Response;
  try {
    const res = await post(id);
    // A 2xx is a committed finalize. Its warnings are the route's own (`invoiceResponse`), never
    // worked out here; a 2xx whose body cannot be read (#547) still finalized, and shows none.
    if (res.ok) return { warnings: await answeredWarnings(res) };
    if (unansweredStatus(res.status)) return LOST_FINALIZE;
    refused = res;
  } catch {
    // No answer arrived: the finalize may have committed.
    return LOST_FINALIZE;
  }
  // Any other status is the server's refusal, which wrote nothing: its own sentence, or a fallback.
  const body: unknown = await refused.json().catch(() => null);
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === "string" ? error : `Finalize failed (${refused.status})`;
}

/** The `warnings` of a finalize's answer, `{ invoice, warnings }`: each string as the server wrote
 *  it, and none when the body cannot be read or carries no list. */
async function answeredWarnings(res: Response): Promise<string[]> {
  const body: unknown = await res.json().catch(() => null);
  const list = (body as { warnings?: unknown } | null)?.warnings;
  return Array.isArray(list) ? list.filter((w): w is string => typeof w === "string") : [];
}

/** The confirm before a run, naming the count of ticked drafts on screen. */
export function finalizeConfirmParts(count: number): { title: string; body: string } {
  return count === 1
    ? { title: "Finalize 1 draft?", body: "It gets the checks Finalize runs, and if it cannot be finalized its row says why." }
    : { title: `Finalize ${count} drafts?`, body: "Each gets the checks Finalize runs, and a draft that cannot be finalized says why on its row." };
}

/** The line beside the button after a run. */
export function finalizeResultText(finalized: number, count: number): string {
  return `Finalized ${finalized} of ${count}.`;
}
