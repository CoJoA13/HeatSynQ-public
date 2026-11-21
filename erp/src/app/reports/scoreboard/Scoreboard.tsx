"use client";
// Comparison scoreboard screen (Phase 8A Task 7, spec §4.3). Consumes GET /api/reports/scoreboard
// (`reportScoreboard`, src/server/reports/scoreboard.ts): the weekly parallel-run eyeball page —
// three HeatSynQ figures for one {from,to} window, to compare against Visual Shop's own reports.
// A numeric table — no charts (§3 dashboard-graphs non-goal) — with this-week / this-month preset
// buttons (client-side window math) and an Excel export link that reuses the SAME query string as the
// fetch, so the table and the file can never disagree. Styling and the loaded/error discipline mirror
// SalesReport.tsx.
//
// Each figure prints its BASIS: orders entered by received date, shipped by ship date, invoiced $ by
// INVOICE DATE (the VS eyeball, deliberately not the Sales report's finalizedAt).
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/fetcher";
import { formatDate, formatMoney, formatNumber } from "@/lib/format";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { GateNotice, ExportLink } from "@/lib/report-ui";
import { PageHeader } from "@/components/PageHeader";
import { ReportsNav } from "../ReportsNav";
import { exportState } from "@/lib/report-export-state";
import { thisWeekWindow, thisMonthWindow } from "@/lib/scoreboard-presets";
import { BUTTON_NEUTRAL, BUTTON_NEUTRAL_COMPACT, CARD, CARD_FLUSH, INPUT_COMPACT, NOTICE, TABLE_CELL, TABLE_HEAD } from "@/lib/ui-classes";

// Local mirror of src/server/reports/scoreboard.ts's ScoreboardFigures — NOT imported from
// src/server/** (CLAUDE.md "Constraints that will bite you": a client component pulling from there
// drags node:async_hooks and Prisma into the browser bundle).
type ScoreboardFigures = {
  window: { from: string | null; to: string | null };
  ordersEntered: number;
  shipped: { qty: number; weight: number };
  invoiced: { invoices: number; credits: number; net: number };
};

const EMPTY: ScoreboardFigures = {
  window: { from: null, to: null },
  ordersEntered: 0,
  shipped: { qty: 0, weight: 0 },
  invoiced: { invoices: 0, credits: 0, net: 0 },
};

export function Scoreboard() {
  const { permissions: perms, error: permsError } = usePermissions();
  const viewGate = gate(perms, "reports.view");

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [figures, setFigures] = useState<ScoreboardFigures>(EMPTY);
  // A `loaded` flag distinct from "zeroes" (HANDOFF §5.15): a failed fetch must say so, never render
  // as a genuinely empty, healthy report.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Codex fixes 5 & 6: the query string of the CURRENTLY-DISPLAYED figures, or `null` until the FIRST
  // successful load (a failed load must NOT enable Export — a "" init would collide with the default
  // empty query). Set to `query` only on success (never on failure); the Export link is built from
  // THIS, never the live filter state, so a stale/failed reload keeps it pinned to the shown window.
  const [appliedQuery, setAppliedQuery] = useState<string | null>(null);

  const allowed = viewGate.allowed;

  // ONE query string, reused for the JSON fetch AND the export link (the shared-parse invariant on
  // the client side — the routes share `parseScoreboardFilter`, this shares the string that feeds it).
  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    return p.toString();
  }, [from, to]);

  const latest = useLatest();
  const load = useCallback(async () => {
    if (!allowed) return;
    const t = latest.next();
    let data: ScoreboardFigures;
    try {
      data = await api<ScoreboardFigures>(`/api/reports/scoreboard${query ? `?${query}` : ""}`);
    } catch (e) {
      if (latest.isCurrent(t)) { setError((e as Error).message); setLoaded(true); }
      return;
    }
    if (!latest.isCurrent(t)) return;
    setFigures(data);
    setAppliedQuery(query);
    setError(null);
    setLoaded(true);
  }, [query, allowed, latest]);
  useEffect(() => { void load(); }, [load]);

  const applyPreset = (window: { from: string; to: string }) => {
    setFrom(window.from);
    setTo(window.to);
  };

  // §5.16 + Codex fix 2: distinguish a permissions-fetch FAILURE (retryable banner) from the initial
  // LOADING state from a genuine denial — a failed /api/auth/me must never read as "Requires
  // reports.view", which also hid the retryable banner behind this early return.
  if (permsError || perms === undefined || !viewGate.allowed) {
    return (
      <GateNotice
        header={<>
          <ReportsNav />
          <PageHeader title="Comparison scoreboard" subtitle="Basis: Per metric" />
        </>}
        permsError={permsError}
        loading={perms === undefined}
        deniedMessage={viewGate.title ?? "You do not have permission to view reports."}
      />
    );
  }

  // Export is live only once a load has SUCCEEDED (appliedQuery non-null); the table shows stale
  // figures while a reload is behind the current window. See report-export-state.ts (Codex fixes 5 & 6).
  const { exportable, showingStale } = exportState(appliedQuery, query);

  const rows: { metric: string; basis: string; value: string; unit: string; strong?: boolean }[] = [
    { metric: "Orders entered", basis: "by received date", value: formatNumber(figures.ordersEntered), unit: "orders" },
    { metric: "Shipped — pieces", basis: "by ship date", value: formatNumber(figures.shipped.qty), unit: "pieces" },
    { metric: "Shipped — net weight", basis: "by ship date", value: formatNumber(figures.shipped.weight, 2), unit: "lb" },
    { metric: "Invoiced — invoice total", basis: "by invoice date, tax included", value: formatMoney(figures.invoiced.invoices), unit: "USD" },
    { metric: "Invoiced — credit total", basis: "by invoice date, tax included", value: formatMoney(figures.invoiced.credits), unit: "USD" },
    { metric: "Invoiced — net total", basis: "by invoice date, tax included", value: formatMoney(figures.invoiced.net), unit: "USD", strong: true },
  ];

  return (
    <div className="min-w-0 p-3 sm:p-6">
      <ReportsNav />
      <PageHeader title="Comparison scoreboard" subtitle="Basis: Per metric"
        actions={<>
          {showingStale && <span className="self-center text-xs text-ink-500">Updating…</span>}
          <ExportLink base="/api/reports/scoreboard/export" query={appliedQuery} ready={exportable} className={BUTTON_NEUTRAL} />
        </>} />
      {error && (
        <p className={`${NOTICE.refusal} mb-3`}>{error}</p>
      )}

      <section className={`${CARD} mb-3`}>
        <h2 className="mb-2 font-medium">Report filters</h2>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="block">
            From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                   className={`${INPUT_COMPACT} mt-1 block`} />
          </label>
          <label className="block">
            To
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                   className={`${INPUT_COMPACT} mt-1 block`} />
          </label>
          <button type="button" onClick={() => applyPreset(thisWeekWindow(new Date()))}
                  className={`${BUTTON_NEUTRAL_COMPACT} hover:bg-surface-50`}>
            This week
          </button>
          <button type="button" onClick={() => applyPreset(thisMonthWindow(new Date()))}
                  className={`${BUTTON_NEUTRAL_COMPACT} hover:bg-surface-50`}>
            This month
          </button>
        </div>
      </section>

      <p className="mb-2 text-sm text-ink-500">
        {from || to
          ? <>Window <span className="font-medium">{from ? formatDate(from) : "…"}</span> to <span className="font-medium">{to ? formatDate(to) : "…"}</span></>
          : "All dates (pick a window or a preset above)"}
      </p>

      <div className={`${CARD_FLUSH} overflow-x-auto ${showingStale ? "opacity-60" : ""}`}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className={`${TABLE_HEAD} p-2`}>Metric</th>
              <th className={`${TABLE_HEAD} p-2`}>Basis</th>
              <th className={`${TABLE_HEAD} p-2 text-right tabular-nums`}>Value</th>
              <th className={`${TABLE_HEAD} p-2`}>Unit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.metric} className={`border-t ${r.strong ? "bg-surface-50 font-medium" : ""}`}>
                <td className={TABLE_CELL}>{r.metric}</td>
                <td className={`${TABLE_CELL} text-ink-500`}>{r.basis}</td>
                <td className={`${TABLE_CELL} text-right tabular-nums`}>{r.value}</td>
                <td className={`${TABLE_CELL} text-ink-500`}>{r.unit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loaded && !error && <p className="mt-2 text-sm text-ink-500">Loading…</p>}
    </div>
  );
}
