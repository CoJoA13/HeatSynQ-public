"use client";
import { formatDate, formatMoney } from "@/lib/format";
// The A/R batch worklist (design spec §11 "/receivables" — "a batch worklist"; task-13-brief.md
// Step 1). The `InvoicingList.tsx` shape, scaled down to one section: a "New batch" form and a
// status-filterable table of deposit batches, each row linking to its own
// `/receivables/batches/[id]` detail page. Since PR 7 of the UX redesign (spec §4.3, §4.5; owner
// 2026-11-01 on #822) the status filter is the three `ListTabs` presets of
// src/lib/receivables-presets.ts, the form stays inline with its submit reading Create batch, and
// the header's New batch button scrolls to and focuses the form's Deposit date.
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { decimalRefusal } from "@/lib/decimal-entry";
import { CONTROL_TOTAL } from "@/lib/money-boxes";
import { RECEIPT_BATCH_STATUS_LABELS, type ReceiptBatchStatusValue } from "@/lib/ar-constants";
import { RECEIVABLES_PRESETS, RECEIVABLES_VIEWS_LABEL, applyPreset, presetFor, type ReceivablesPresetKey } from "@/lib/receivables-presets";
import { controlTotalText } from "@/lib/receipt-batch-page";
import { ReceivablesNav } from "./ReceivablesNav";
import { PageHeader } from "@/components/PageHeader";
import { ListTabs } from "@/components/ListTabs";
import { BUTTON_PRIMARY, BUTTON_PRIMARY_COMPACT, CARD, CARD_FLUSH, INPUT_COMPACT, LINK, NOTICE, TABLE_CELL, TABLE_HEAD } from "@/lib/ui-classes";

// Local mirror of src/server/receipts.ts's `BatchListRow` — not imported from src/server/**
// (CLAUDE.md "Constraints that will bite you": a client component pulling from there drags
// node:async_hooks and Prisma into the browser bundle).
/** `balance` mirrors the server's `number | null` (#163): null = no control total, so nothing has
 *  been proved — rendered as words, never as a 0 that would read as "checked and correct". */
type BatchListRow = {
  id: string; batchNumber: number; depositDate: string; controlTotal: number | null;
  status: ReceiptBatchStatusValue; enteredTotal: number; balance: number | null;
};

type StatusFilter = ReceiptBatchStatusValue | "";

export function ReceivablesList() {
  const router = useRouter();
  const { permissions: perms, error: permsError } = usePermissions();
  const createGate = gate(perms, "receivables.create");

  // ---------------------------------------------------------------------------------------
  // The worklist — defaults to OPEN (the batches still needing work), the Posted and All presets
  // its other two settings. `?status=` mirrors `listBatches`'s own filter one-for-one (receipts.ts).
  // ---------------------------------------------------------------------------------------
  const [status, setStatus] = useState<StatusFilter>("OPEN");
  const [batches, setBatches] = useState<BatchListRow[]>([]);
  // A `loaded` flag distinct from "the array is empty" (HANDOFF §5.15) — a failed fetch must say
  // so, never render as a genuinely empty, healthy worklist.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useLatest();

  const load = useCallback(async () => {
    const t = latest.next();
    let data: BatchListRow[];
    try {
      data = await api<BatchListRow[]>(`/api/receivables/batches${status ? `?status=${status}` : ""}`);
    } catch (e) {
      if (latest.isCurrent(t)) { setError((e as Error).message); setLoaded(true); }
      return;
    }
    if (!latest.isCurrent(t)) return;
    setBatches(data);
    setError(null);
    setLoaded(true);
  }, [status, latest]);
  useEffect(() => { void load(); }, [load]);

  // ---------------------------------------------------------------------------------------
  // New batch — deposit date + optional control total (task-13-brief.md Step 1). On success,
  // navigate straight to the new batch's own page — the `InvoiceDetail.tsx` `raiseCredit`
  // `router.push` precedent (create a resource, land on its detail rather than the list).
  // ---------------------------------------------------------------------------------------
  const [depositDate, setDepositDate] = useState("");
  const [controlTotal, setControlTotal] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // The header's New batch button is the way to the form (owner 2026-11-01): it scrolls the form
  // into view and puts the cursor in Deposit date, and submits nothing; the form's own submit is
  // Create batch.
  const depositDateRef = useRef<HTMLInputElement>(null);
  function focusNewBatch() {
    depositDateRef.current?.scrollIntoView({ block: "center" });
    depositDateRef.current?.focus();
  }

  async function createBatch() {
    // Every refusal of the form on one line each, in the form's order: the date, then the total.
    const lines: string[] = [];
    if (!depositDate) lines.push("Deposit date is required.");
    const refused = decimalRefusal(CONTROL_TOTAL.label, controlTotal, CONTROL_TOTAL.box);
    if (refused) lines.push(refused);
    if (lines.length > 0) { setCreateError(lines.join("\n")); return; }
    setCreating(true);
    setCreateError(null);
    try {
      const batch = await api<{ id: string }>("/api/receivables/batches", {
        method: "POST",
        body: JSON.stringify({
          depositDate, controlTotal: controlTotal.trim() === "" ? null : controlTotal,
        }),
      });
      router.push(`/receivables/batches/${batch.id}`);
    } catch (e) {
      setCreateError((e as Error).message);
      setCreating(false);
    }
  }

  const createTitle = !createGate.allowed ? createGate.title : creating ? "Creating…" : undefined;

  return (
    <div className="min-w-0 p-3 sm:p-6">
      <ReceivablesNav />
      {/* The title row (spec §4.3; PR 7): New batch is the page's one action and goes to the form. */}
      <PageHeader title="Receivables" subtitle="Deposit batches, applications and month-end proof."
        actions={
          <button type="button" onClick={focusNewBatch} disabled={!createGate.allowed} title={createGate.title}
                  className={BUTTON_PRIMARY}>
            New batch
          </button>
        } />

      {(error ?? permsError) && (
        <p className={`${NOTICE.refusal} mb-3`}>{error ?? permsError}</p>
      )}

      {/* ------------------------------- New batch ------------------------------- */}
      <section id="new-batch" className={`${CARD} mb-6`}>
        <h2 className="mb-2 font-medium">New batch</h2>
        {createError && <p className="mb-2 whitespace-pre-line text-sm text-red-700">{createError}</p>}
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="block">
            Deposit date
            <input ref={depositDateRef} type="date" value={depositDate} disabled={!createGate.allowed} title={createGate.title}
                   onChange={(e) => setDepositDate(e.target.value)}
                   className={`${INPUT_COMPACT} mt-1 block disabled:cursor-not-allowed disabled:bg-surface-50`} />
          </label>
          <label className="block">
            Control total (optional)
            <input value={controlTotal} inputMode="decimal" disabled={!createGate.allowed} title={createGate.title}
                   onChange={(e) => setControlTotal(e.target.value)} placeholder="e.g. 1250.00"
                   className={`${INPUT_COMPACT} mt-1 block disabled:cursor-not-allowed disabled:bg-surface-50`} />
          </label>
          <button onClick={() => void createBatch()} disabled={createTitle !== undefined} title={createTitle}
                  className={BUTTON_PRIMARY_COMPACT}>
            {creating ? "Creating…" : "Create batch"}
          </button>
        </div>
      </section>

      {/* -------------------------------- Batches -------------------------------- */}
      <section>
        <h2 className="mb-2 text-lg font-medium">Batches</h2>
        {/* The three presets (src/lib/receivables-presets.ts) are the status filter's three
            settings, derived back from it, so one is always lit. */}
        <ListTabs label={RECEIVABLES_VIEWS_LABEL} tabs={RECEIVABLES_PRESETS} active={presetFor({ status })}
                  onSelect={(key) => setStatus(applyPreset({ status }, key as ReceivablesPresetKey).status)} />

        <div className={`${CARD_FLUSH} overflow-x-auto`}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className={`${TABLE_HEAD} p-2`}>Batch #</th>
                <th className={`${TABLE_HEAD} p-2`}>Deposit date</th>
                <th className={`${TABLE_HEAD} p-2`}>Status</th>
                <th className={`${TABLE_HEAD} text-right p-2`}>Control total</th>
                <th className={`${TABLE_HEAD} text-right p-2`}>Entered</th>
                <th className={`${TABLE_HEAD} text-right p-2`}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id} className="border-t">
                  <td className={`${TABLE_CELL} font-mono`}>
                    <Link href={`/receivables/batches/${b.id}`} className={LINK}>
                      {b.batchNumber}
                    </Link>
                  </td>
                  <td className={TABLE_CELL}>{formatDate(b.depositDate)}</td>
                  <td className={TABLE_CELL}>{RECEIPT_BATCH_STATUS_LABELS[b.status]}</td>
                  {/* A null control total was never entered (the owner's rename of the em dash;
                      src/lib/receipt-batch-page.ts). */}
                  <td className={`${TABLE_CELL} tabular-nums text-right`}>{controlTotalText(b.controlTotal)}</td>
                  <td className={`${TABLE_CELL} tabular-nums text-right`}>{formatMoney(b.enteredTotal)}</td>
                  {/* #163: words, not a number. A `—` here would read as "nothing to report" in a
                      BALANCE column, which is the wrong message — this batch was proved against
                      nothing. "Not proved" shares the batch page's lead phrase so the two screens
                      teach one term, and stands out among a column of figures without borrowing a
                      colour: this column carries no colour semantics at all today (an out-of-balance
                      batch is plain text here too), and colouring one state of three would invent a
                      hierarchy the rest of the column does not have. */}
                  <td className={`${TABLE_CELL} tabular-nums text-right`}>{b.balance === null ? "Not proved" : formatMoney(b.balance)}</td>
                </tr>
              ))}
              {batches.length === 0 && loaded && !error && (
                <tr><td colSpan={6} className="p-4 text-center text-ink-500">No batches</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
