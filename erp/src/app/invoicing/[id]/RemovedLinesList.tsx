"use client";

// #594 (owner rulings 2026-11-02 and 2026-11-03): the computed lines removed from this draft, under
// the line grid, each with a Restore button. Restore takes the line off the list and re-prices
// nothing: the next Recalculate bills it again, which the message under the list says. The list is
// the server's, as last read: a row removed in the grid and not yet saved is not on it. Drawn on a
// draft only; a finalized invoice keeps its marks for Unlock and draws none. Restore all (owner
// answer 2026-11-04), drawn while the list holds two or more, sends every identity it shows.

import { useState } from "react";
import { api } from "@/lib/fetcher";
import type { Gate } from "@/lib/permission-ui";
import { PanelMessage } from "@/components/PanelMessage";
import { BUTTON_NEUTRAL_COMPACT, CARD, NOTICE } from "@/lib/ui-classes";
import {
  REMOVED_LINES_HEADING, REMOVED_LINES_NOTE, RESTORE_ALL, RESTORE_ALL_NAME, amountWhenRemoved,
  restoredAllMessage, restoredMessage, type RemovedLine,
} from "@/lib/invoice-removed-lines";
import type { InvoiceMutationResult } from "./InvoiceDetail";

/** The busy key while Restore all is out: an identity is never empty. */
const ALL = "";

export function RemovedLinesList({ invoiceId, removedLines, gate, applyMutation }: {
  invoiceId: string;
  removedLines: RemovedLine[];
  /** The page's money gate: Restore changes what the next Recalculate bills. */
  gate: Gate;
  applyMutation: (run: () => Promise<InvoiceMutationResult>) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  async function restore(lines: RemovedLine[]) {
    if (busy !== null) return;
    const one = lines.length === 1 ? lines[0] : null;
    setBusy(one ? one.identity : ALL);
    setRefusal(null);
    setRestored(null);
    try {
      await applyMutation(() => api<InvoiceMutationResult>(`/api/invoices/${invoiceId}/restore-line`, {
        method: "POST",
        body: JSON.stringify(one ? { identity: one.identity } : { identities: lines.map((l) => l.identity) }),
      }));
      setRestored(one ? restoredMessage(one.label) : restoredAllMessage(lines.length));
    } catch (e) {
      setRefusal((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (removedLines.length === 0 && restored === null && refusal === null) return null;
  return (
    <section aria-label={REMOVED_LINES_HEADING} className={`${CARD} mb-6`}>
      {removedLines.length > 0 && <>
        <h2 className="mb-1 font-medium">{REMOVED_LINES_HEADING}</h2>
        <p className="mb-3 text-xs text-ink-500">{REMOVED_LINES_NOTE}</p>
        <ul className="flex flex-col gap-2">
          {removedLines.map((line) => (
            <li key={line.identity} className="flex flex-wrap items-center gap-3 text-sm">
              <span className="min-w-0 flex-1 break-words">{line.label}</span>
              <span className="tabular-nums text-ink-500">{amountWhenRemoved(line.amount)}</span>
              <button type="button" className={BUTTON_NEUTRAL_COMPACT} aria-label={`Restore ${line.label}`}
                      onClick={() => void restore([line])} disabled={!gate.allowed || busy !== null} title={gate.title}>
                {busy === line.identity ? "Restoring…" : "Restore"}
              </button>
            </li>
          ))}
        </ul>
        {removedLines.length > 1 && (
          <button type="button" className={`${BUTTON_NEUTRAL_COMPACT} mt-3`} aria-label={RESTORE_ALL_NAME}
                  onClick={() => void restore(removedLines)} disabled={!gate.allowed || busy !== null} title={gate.title}>
            {busy === ALL ? "Restoring…" : RESTORE_ALL}
          </button>
        )}
      </>}
      {restored !== null && <p role="status" className={`${NOTICE.success} mt-3`}>{restored}</p>}
      <PanelMessage message={refusal} />
    </section>
  );
}
