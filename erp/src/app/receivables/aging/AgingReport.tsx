"use client";
import { formatMoney } from "@/lib/format";
// A/R aging report screen (design spec §11 "reports … A/R aging (as-of)"; task-14-brief.md
// Step 1). Consumes Task 10's `GET /api/receivables/aging` (`agingReport`, src/server/aging.ts):
// an as-of date + an optional customer/family filter, a table of `AgingRow`s (the five buckets +
// Unapplied + Net), a totals footer, and an Excel export link mirroring the
// `parts/page.tsx`/`customers/page.tsx` "Export to Excel" `<a href>` precedent. Since PR 7 of the
// UX redesign (spec §4.3; owner 2026-11-01 on #822) the export is the header's action, the filter
// and the table are cards, and the At a glance card reads the footer's Current and Net.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { AGING_BUCKETS, AGING_BUCKET_LABELS, AGING_MONEY_FIELDS, isAgingRowAllZero, type AgingBucketValue } from "@/lib/ar-constants";
import { formatDateOnly, todayDateOnly } from "@/lib/business-days";
import { ReceivablesNav } from "../ReceivablesNav";
import { PageHeader } from "@/components/PageHeader";
import { AtAGlance } from "@/components/AtAGlance";
import { BUTTON_NEUTRAL, CARD, CARD_FLUSH, INPUT_COMPACT, LINK, NOTICE, TABLE_CELL, TABLE_HEAD } from "@/lib/ui-classes";

// Local mirror of src/server/aging.ts's `AgingRow` — not imported from src/server/** (CLAUDE.md
// "Constraints that will bite you": a client component pulling from there drags node:async_hooks
// and Prisma into the browser bundle).
type AgingRow = {
  customerId: string; customerCode: string; customerName: string;
  current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number;
  unapplied: number; net: number;
  // Set only on a parent-family roll-up's synthesized family-TOTAL row (src/server/aging.ts) — it
  // already sums parent + every child, so it is used AS the footer rather than summed alongside the
  // child rows it contains.
  isFamilyTotal?: boolean;
};

// Slice of CustomerRow needed to populate the customer/family filter — the parts.tsx/
// BatchDetail.tsx `CustomerOption` precedent (id/code/name only, fetched from the plain,
// active-only `/api/customers`).
type CustomerOption = { id: string; code: string; name: string };

type MoneyBucketKey = "current" | "d1_30" | "d31_60" | "d61_90" | "d90_plus";
const BUCKET_FIELD: Record<AgingBucketValue, MoneyBucketKey> = {
  CURRENT: "current", D1_30: "d1_30", D31_60: "d31_60", D61_90: "d61_90", D90_PLUS: "d90_plus",
};

// The all-zero-row filter (`isAgingRowAllZero`) and the money-field list (`AGING_MONEY_FIELDS`)
// are shared from ar-constants.ts so this screen and the Excel export apply the SAME rule (the
// export route filters with the same predicate — they can't drift). DISPLAY-SIDE ONLY;
// `agingReport` itself is untouched.
const ZERO_TOTALS: Record<MoneyBucketKey | "unapplied" | "net", number> = {
  current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, unapplied: 0, net: 0,
};

const TITLE = "A/R Aging";
const SUBTITLE = "Open balances as of a chosen date.";

export function AgingReport() {
  const { permissions: perms, error: permsError } = usePermissions();
  const viewGate = gate(perms, "receivables.view");
  const customersGate = gate(perms, "customers.view");

  const [asOf, setAsOf] = useState(() => formatDateOnly(todayDateOnly()));
  const [customerId, setCustomerId] = useState("");
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [rows, setRows] = useState<AgingRow[]>([]);
  // A `loaded` flag distinct from "the array is empty" (HANDOFF §5.15): a failed fetch must say
  // so, never render as a genuinely empty, healthy report.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The customer filter's own line (#639, the CertList #144 shape): `error` is cleared by every
  // aging read that lands, so a picker failure written there vanished while the picker stayed empty.
  const [customersError, setCustomersError] = useState<string | null>(null);

  const allowed = viewGate.allowed;
  const query = `asOf=${encodeURIComponent(asOf)}${customerId ? `&customerId=${encodeURIComponent(customerId)}` : ""}`;

  // Named `latest`, not `gate` — this file also imports `gate` from permission-ui for the
  // held-permission checks above, and shadowing that binding with the stale-response gate would
  // break every `gate(perms, ...)` call here (ReceivablesList.tsx / CustomersPage precedent).
  const latest = useLatest();
  const load = useCallback(async () => {
    if (!allowed) return;
    const t = latest.next();
    let data: AgingRow[];
    try {
      data = await api<AgingRow[]>(`/api/receivables/aging?${query}`);
    } catch (e) {
      if (latest.isCurrent(t)) { setError((e as Error).message); setLoaded(true); }
      return;
    }
    if (!latest.isCurrent(t)) return;
    setRows(data);
    setError(null);
    setLoaded(true);
  }, [query, allowed, latest]);
  useEffect(() => { void load(); }, [load]);

  // Customer/family filter options — fetched only once the caller is known to hold
  // customers.view (§5.16: a blocked control must say why, not just refuse silently), never
  // left in a `.catch(() => {})` silent-empty state. A failed fetch reports into
  // `customersError`, NOT the shared `error` (#144, #639): every aging read that lands clears
  // that channel, so the failure would vanish while the picker stayed broken.
  useEffect(() => {
    if (!customersGate.allowed) return;
    api<CustomerOption[]>("/api/customers").then(setCustomers).catch((e) => setCustomersError((e as Error).message));
  }, [customersGate.allowed]);

  // §5.16: a caller without receivables.view sees the page saying why, never a silently empty one.
  if (!viewGate.allowed) {
    return (
      <div className="min-w-0 p-3 sm:p-6">
        <ReceivablesNav />
        <PageHeader title={TITLE} subtitle={SUBTITLE} />
        <p className="text-sm text-ink-500">{viewGate.title ?? "You do not have permission to view A/R aging."}</p>
      </div>
    );
  }

  const visibleRows = rows.filter((r) => !isAgingRowAllZero(r));
  // A parent-family roll-up returns per-child rows PLUS a synthesized family-total row that already
  // sums parent + every child (src/server/aging.ts). Summing every visible row would double-count,
  // so the family-total row is pulled out and used AS the footer; the child rows render on their
  // own, and any other view (standalone/unfiltered) has no family-total row and sums its leaf rows.
  const familyTotalRow = visibleRows.find((r) => r.isFamilyTotal) ?? null;
  const leafRows = visibleRows.filter((r) => !r.isFamilyTotal);
  const totals: Record<MoneyBucketKey | "unapplied" | "net", number> = familyTotalRow ?? leafRows.reduce((sum, r) => {
    const next = { ...sum };
    for (const k of AGING_MONEY_FIELDS) next[k] = sum[k] + r[k];
    return next;
  }, { ...ZERO_TOTALS });
  // The card's two figures are the footer's, shown once the read has landed and only while it did.
  const figures = loaded && !error;

  return (
    <div className="min-w-0 p-3 sm:p-6">
      <ReceivablesNav />
      {/* The title row (spec §4.3; PR 7): Export is the page's one action. It stays a plain
          `<a href>` (a cookie-authenticated download, the aging/export precedent), so the
          capture's readiness and the flows still find a link named Export to Excel. */}
      <PageHeader title={TITLE} subtitle={SUBTITLE}
        actions={<a href={`/api/receivables/aging/export?${query}`} className={BUTTON_NEUTRAL}>Export to Excel</a>} />
      {(error ?? permsError) && (
        <p className={`${NOTICE.refusal} mb-3`}>{error ?? permsError}</p>
      )}
      {customersError && (
        <p className={`${NOTICE.warning} mb-3`}>
          Could not load the customer filter: {customersError}
        </p>
      )}

      <div className="flex flex-col gap-6 min-[1360px]:flex-row min-[1360px]:items-start">
      <div className="min-w-0 flex-1">
      <section className={`${CARD} mb-6`}>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="block">
            As of
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)}
                   className={`${INPUT_COMPACT} mt-1 block`} />
          </label>
          <label className="block">
            Customer
            <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}
                    disabled={!customersGate.allowed} title={customersGate.allowed ? undefined : customersGate.title}
                    className={`${INPUT_COMPACT} mt-1 block disabled:cursor-not-allowed disabled:bg-surface-50`}>
              <option value="">All customers</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {/* The note stays the LAST thing before the table: it explains that table's own Net column,
          and a caption that has drifted a control away from what it captions is read as belonging
          to the control instead (Duo review, AgingReport.tsx:147; pinned by test). */}
      <p className="mb-2 text-sm text-ink-500">Unapplied credit and cash reduce Net.</p>

      <div className={`${CARD_FLUSH} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className={`${TABLE_HEAD} p-2`}>Customer</th>
              {AGING_BUCKETS.map((b) => (
                <th key={b} className={`${TABLE_HEAD} p-2 text-right`}>{AGING_BUCKET_LABELS[b]}</th>
              ))}
              <th className={`${TABLE_HEAD} p-2 text-right`}>Unapplied</th>
              <th className={`${TABLE_HEAD} p-2 text-right`}>Net</th>
            </tr>
          </thead>
          <tbody>
            {leafRows.map((r) => (
              <tr key={r.customerId} className="border-t">
                <td className={TABLE_CELL}>
                  <Link href={`/customers/${r.customerId}`} className={LINK}>{r.customerCode} · {r.customerName}</Link>
                </td>
                {AGING_BUCKETS.map((b) => (
                  <td key={b} className={`${TABLE_CELL} tabular-nums text-right`}>{formatMoney(r[BUCKET_FIELD[b]])}</td>
                ))}
                <td className={`${TABLE_CELL} tabular-nums text-right`}>{formatMoney(r.unapplied)}</td>
                <td className={`${TABLE_CELL} tabular-nums text-right`}>{formatMoney(r.net)}</td>
              </tr>
            ))}
            {visibleRows.length === 0 && loaded && !error && (
              <tr>
                <td colSpan={AGING_BUCKETS.length + 3} className="p-4 text-center text-ink-500">
                  No aging activity
                </td>
              </tr>
            )}
          </tbody>
          {visibleRows.length > 0 && (
            <tfoot>
              {/* When a family-total row is present it IS the footer (already sums parent + every
                  child), labeled distinctly; otherwise the footer is the sum of the leaf rows. */}
              <tr className="border-t bg-surface-50 font-medium">
                <td className={TABLE_CELL}>{familyTotalRow ? "Family total" : "Total"}</td>
                {AGING_BUCKETS.map((b) => (
                  <td key={b} className={`${TABLE_CELL} tabular-nums text-right`}>{formatMoney(totals[BUCKET_FIELD[b]])}</td>
                ))}
                <td className={`${TABLE_CELL} tabular-nums text-right`}>{formatMoney(totals.unapplied)}</td>
                <td className={`${TABLE_CELL} tabular-nums text-right`}>{formatMoney(totals.net)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      </div>
      {/* The card's figures are the footer's: Current, and Total A/R as the footer's Net (the file
          draws a Total where the app's last column is Net; owner 2026-11-01). */}
      <AtAGlance rows={[
        { label: "Current", value: <span className="tabular-nums">{figures ? formatMoney(totals.current) : "—"}</span> },
        { label: "Total A/R", value: <span className="tabular-nums">{figures ? formatMoney(totals.net) : "—"}</span> },
      ]} />
      </div>
    </div>
  );
}
