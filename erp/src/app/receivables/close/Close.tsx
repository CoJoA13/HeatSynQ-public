"use client";
import { formatDateTime, formatMoney, formatNumber } from "@/lib/format";
// The month-end close + GL-export screen (Task 8, P5C §4.1/§4.3/§7). Reachability-critical: Phase
// 5B shipped a deliverable API-only (owner-flagged lesson, docs/history/2026-08-08-phase-5b-
// accounts-receivable.md) — every close/export capability Tasks 5-7 built must be reachable from
// here. Modelled on AgingReport.tsx (guarded `api()` fetch + `useLatest()` + `gate(perms, ...)`)
// and Statements.tsx (mutation gate shape, disabled-with-tooltip buttons, a refresh counter that
// re-pulls both the schedule and the closed-periods list after every mutation).
//
// Consumes: GET .../close/preliminary?year=&month=, GET .../close/readiness?year=&month=
// (fetched together for the SAME month so the readiness panel and the Export button's disabled
// count can never disagree — both read the identical period window `exportClose` refuses on),
// GET .../close/readiness/export?year=&month= (plain <a href>, the aging/export precedent),
// GET .../close (Task 8's own gap fill — nothing listed closed periods + their batches before
// this), POST .../close, POST .../close/[id]/reopen, POST .../close/[id]/export, and
// GET .../close/export/[batchId]/file|register (plain <a href> downloads — cookie-authenticated
// GETs, same as the aging Excel export and the statement documents list).
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { gate, gateDo } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { api } from "@/lib/fetcher";
import { todayDateOnly } from "@/lib/business-days";
import {
  closeMonthFrom, closeTitle as closeButtonTitle, closeYearFrom, messageFor, periodFigures, reversalWarning,
  UNCOMMITTED_YEAR_TITLE,
  type ClosePeriodKey, type ContinuitySchedule, type PeriodMessage, type PeriodReadError, type PeriodReadiness,
  type PreliminaryReport, type ReadinessGap,
} from "@/lib/close-screen";
import { PanelMessage } from "@/components/PanelMessage";
import { ReceivablesNav } from "../ReceivablesNav";
import { askConfirm, askReason } from "@/lib/modal";
import { PageHeader } from "@/components/PageHeader";
import { RecordTabs } from "@/components/RecordTabs";
import { AtAGlance } from "@/components/AtAGlance";
import { CLOSE_TAB_LABEL, closeSubtitle, closeTabs } from "@/lib/close-tabs";
import { BUTTON_PRIMARY, CARD, INPUT_COMPACT, LINK, NOTICE, BADGE_DANGER } from "@/lib/ui-classes";

// ---------------------------------------------------------------------------------------------
// Local mirrors of src/server/close-periods.ts's `ClosePeriodDetail`/`ClosePeriodListItem` — never
// imported from src/server/** (CLAUDE.md: a client component pulling from there drags
// node:async_hooks and Prisma into the browser bundle). `ContinuitySchedule`, `PreliminaryReport`
// and `ReadinessGap` (whose `kind` is the SHARED union from src/lib/gl-constants.ts, #90) are the
// client-safe leaf's, src/lib/close-screen.ts, which decides what this screen shows (#649).
// ---------------------------------------------------------------------------------------------

type ExportBatchSummary = { id: string; exportNumber: number; emittedAt: string; fileName: string };
type ClosePeriodListItem = ContinuitySchedule & {
  id: string; year: number; month: number; status: string; closedAt: string;
  // #88: server-derived broken-chain flag — this CLOSED month's frozen beginning no longer equals
  // the prior month's frozen ending. Flag only; the operator re-closes the month to re-chain.
  chainBroken: boolean;
  priorEndingAr: number | null;
  exportBatches: ExportBatchSummary[];
};
type ClosePeriodDetail = ContinuitySchedule & { id: string; year: number; month: number; status: string };

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
function periodLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

const TITLE = "Month-End Close";

/** Defaults the picker to the most recently COMPLETED month — the one an operator closing books
 *  at the start of a new month is actually here for, not the still-open current month. */
function defaultPeriod(): { year: number; month: number } {
  const today = todayDateOnly();
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth() + 1; // 1-based
  return m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 };
}

/**
 * A CLIENT-SIDE HINT ONLY, mirroring close-periods.ts's `priorEndingAr` genesis rule (spec §4.1,
 * ruling 5): the immediately-prior month must be CLOSED, UNLESS nothing strictly earlier is
 * closed either (a legitimate genesis close). The server re-derives and enforces this
 * independently under its own lock — this only decides whether the Close button shows a reason
 * up front instead of the operator discovering it from a 409 after clicking.
 */
function priorMonthOk(periods: ClosePeriodListItem[], year: number, month: number): boolean {
  const py = month === 1 ? year - 1 : year;
  const pm = month === 1 ? 12 : month - 1;
  const prior = periods.find((p) => p.year === py && p.month === pm);
  if (prior) return prior.status === "CLOSED";
  return !periods.some((p) => p.status === "CLOSED" && (p.year < year || (p.year === year && p.month < month)));
}

function ClosePeriodsScreen() {
  const { permissions: perms, error: permsError } = usePermissions();
  const viewGate = gate(perms, "receivables.view");
  // Close and export both require receivables.edit on top of their own dangerous special — one
  // gate covers the shared half, so it isn't recomputed per button.
  const editGate = gate(perms, "receivables.edit");
  const closeDoGate = gateDo(perms, "close_ar_period");
  const exportDoGate = gateDo(perms, "run_qbo_export");
  const viewAllowed = viewGate.allowed;

  // `?year=&month=` preselects — a readiness "Fix" link (e.g. /admin/billing) sends the operator
  // away from this screen; round-tripping the period in the URL means Back returns to the same
  // month instead of resetting to the default. Read once, through the leaf's own rule (`2e3` and a
  // year out of bounds fall back to the default); the picker below owns the state after.
  //
  // The Year box's TEXT and the COMMITTED year are two things (#649): the text is what the box
  // shows, and a period is committed only while that text names a whole year inside the close
  // bounds (`closeYearFrom`, ruling 19's whole-number rule). `Number()` used to commit every
  // keystroke: a cleared box was year 0, and 2, 20 and 202 were committed, and fetched, on the way
  // to 2026, each read refused by the route and each leaving the previous period's figures on
  // screen under the new heading.
  const searchParams = useSearchParams();
  const initial = defaultPeriod();
  const [yearText, setYearText] = useState(() => String(closeYearFrom(searchParams.get("year")) ?? initial.year));
  const [month, setMonth] = useState(() => closeMonthFrom(searchParams.get("month")) ?? initial.month);
  const year = closeYearFrom(yearText);
  const period: ClosePeriodKey | null = year === null ? null : { year, month };

  // Bumped by every successful close/reopen/export so the schedule, readiness, and closed-periods
  // list all re-pull without a page reload (the Statements.tsx `docsRefresh` precedent).
  const [refresh, setRefresh] = useState(0);

  // ---- Preliminary schedule + readiness gap list, fetched together for the SAME month ----
  // Each payload is held WITH the period it was read for, and a failed read with the period it
  // failed for; the leaf's `periodFigures` shows only the committed period's own (#649). Nothing is
  // cleared when the period changes: the previous period's payloads stay held and simply do not
  // match, so the screen reads Loading… until this period's land, and the Close button, whose
  // title reads the same figures, is held too. A failed read hides even a matching payload.
  const [preliminary, setPreliminary] = useState<PreliminaryReport | null>(null);
  const [readiness, setReadiness] = useState<PeriodReadiness | null>(null);
  const [readError, setReadError] = useState<PeriodReadError | null>(null);
  const latest = useLatest();

  const load = useCallback(async () => {
    if (!viewAllowed || year === null) return;
    const t = latest.next();
    let prelim: PreliminaryReport;
    let gaps: ReadinessGap[];
    try {
      [prelim, gaps] = await Promise.all([
        api<PreliminaryReport>(`/api/receivables/close/preliminary?year=${year}&month=${month}`),
        api<ReadinessGap[]>(`/api/receivables/close/readiness?year=${year}&month=${month}`),
      ]);
    } catch (e) {
      // Inside the ticket guard (F7: a superseded rejection must not clobber current state), and
      // keyed to the period this read was for, so a later period's figures are not hidden by it.
      if (latest.isCurrent(t)) setReadError({ year, month, message: (e as Error).message });
      return;
    }
    if (!latest.isCurrent(t)) return;
    setPreliminary(prelim);
    setReadiness({ year, month, gaps });
    setReadError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `refresh` triggers a re-pull; unused in the body (Statements.tsx `docsRefresh` precedent)
  }, [year, month, viewAllowed, latest, refresh]);
  useEffect(() => { void load(); }, [load]);

  // ---- Closed periods + their export batches (Task 8's own gap fill) ----
  const [closedPeriods, setClosedPeriods] = useState<ClosePeriodListItem[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const listLatest = useLatest();

  const loadClosed = useCallback(async () => {
    if (!viewAllowed) return;
    const t = listLatest.next();
    let data: ClosePeriodListItem[];
    try {
      data = await api<ClosePeriodListItem[]>("/api/receivables/close");
    } catch (e) {
      if (listLatest.isCurrent(t)) { setListError((e as Error).message); setListLoaded(true); }
      return;
    }
    if (!listLatest.isCurrent(t)) return;
    setClosedPeriods(data);
    setListError(null);
    setListLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `refresh` triggers a re-pull; unused in the body
  }, [viewAllowed, listLatest, refresh]);
  useEffect(() => { void loadClosed(); }, [loadClosed]);

  // ---- Close ----
  // Its refusal is kept with the period it was raised for and shown under the Close button only
  // while that period is the one on screen (ruling R1: beside the control; #649: keyed).
  const [closing, setClosing] = useState(false);
  const [closeMessage, setCloseMessage] = useState<PeriodMessage | null>(null);
  async function doClose() {
    if (period === null) return;
    setClosing(true);
    setCloseMessage(null);
    try {
      await api<ClosePeriodDetail>("/api/receivables/close", {
        method: "POST", body: JSON.stringify({ year: period.year, month: period.month }),
      });
      setRefresh((n) => n + 1);
    } catch (e) {
      setCloseMessage({ ...period, text: (e as Error).message });
    } finally {
      setClosing(false);
    }
  }

  // ---- Reopen and Export to GL (per closed-period row) ----
  // One message slot for the rows, keyed by the row it belongs to and shown under that row's
  // buttons (ruling R1); any row action clears it first.
  const [rowMessage, setRowMessage] = useState<{ id: string; text: string } | null>(null);
  async function doReopen(id: string, label: string) {
    setRowMessage(null);
    // One prompt that both asks and takes the reason (the receipt batch's `reopenBatchAction`
    // shape, #649): it used to be a confirm dialog and then a prompt, the app's only such pair,
    // whose two back-to-back dialogs the E2E flow needed a listener of its own to answer.
    // The modal (ruling 5) holds a blank reason open with the server's own sentence
    // (close-periods.ts), byte for byte, and Cancel answers null.
    const reason = await askReason({
      question: `Reopen ${label}?\n\n` +
        `Postings will be allowed into it again until it is re-closed.`,
      verb: "reopening", blankRefusal: "A reason is required to reopen a period",
    });
    if (reason === null) return; // cancelled
    if (!reason.trim()) { setRowMessage({ id, text: "A reason is required to reopen a period" }); return; }
    try {
      await api(`/api/receivables/close/${id}/reopen`, { method: "POST", body: JSON.stringify({ reason }) });
      setRefresh((n) => n + 1);
    } catch (e) {
      setRowMessage({ id, text: (e as Error).message });
    }
  }

  const [exportingId, setExportingId] = useState<string | null>(null);
  // The modal's answer lands a tick later with the page still running (CLAUDE.md's modal rule), so
  // the export asks this after it.
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  /** Export to GL. An export that would reverse events already exported asks first, naming how many
   *  (owner ruling R25, #705): the count is read just before, on the export's own delta, and a
   *  refusal of that read (a readiness gap, #709's sentence) shows under the row with nothing
   *  exported. The row's button stays busy through the question. */
  async function doExport(id: string) {
    setExportingId(id);
    setRowMessage(null);
    try {
      const { reversals } = await api<{ reversals: number }>(`/api/receivables/close/${id}/reversals`);
      const warning = reversalWarning(reversals);
      if (warning && (!(await askConfirm(warning)) || !mounted.current)) return;
      await api(`/api/receivables/close/${id}/export`, { method: "POST" });
      setRefresh((n) => n + 1);
    } catch (e) {
      setRowMessage({ id, text: (e as Error).message });
    } finally {
      if (mounted.current) setExportingId(null);
    }
  }

  // §5.16: a caller without receivables.view sees the page saying why, never a silently empty one.
  if (!viewGate.allowed) {
    return (
      <div className="min-w-0 p-3 sm:p-6">
        <ReceivablesNav />
        <PageHeader title={TITLE} subtitle={closeSubtitle(null)} />
        <p className="text-sm text-ink-500">{viewGate.title ?? "You do not have permission to view A/R close."}</p>
      </div>
    );
  }

  // What this period shows, out of what is held: the leaf decides (#649). The Close button's title
  // reads the same figures, so it is held while they are loading or failed, and over an
  // uncommitted year; the shown schedule, readiness list and the selected row's gap count all
  // come from here, never from the raw state.
  const figures = periodFigures({ preliminary, readiness, readError }, period);
  const schedule = figures.preliminary?.schedule ?? null;
  const priorOk = period === null ? true : priorMonthOk(closedPeriods, period.year, period.month);
  const closeTitle = closeButtonTitle({ editGate, closeDoGate, figures, priorOk, closing });
  const closeRefusal = messageFor(closeMessage, period);

  const query = period === null ? null : `year=${period.year}&month=${period.month}`;

  return (
    <div className="min-w-0 p-3 sm:p-6">
      <ReceivablesNav />
      {/* The title row (spec §4.3; PR 7, owner 2026-11-01 on #822): Close period is the page's one
          action, its title the leaf's (`closeButtonTitle`), so it is held while the figures are
          loading or failed and over an uncommitted year, as it was in the Period section. */}
      <PageHeader title={TITLE} subtitle={closeSubtitle(period && periodLabel(period.year, period.month))}
        actions={
          <button onClick={() => void doClose()} disabled={closeTitle !== undefined} title={closeTitle}
                  className={BUTTON_PRIMARY}>
            {closing ? "Closing…" : "Close period"}
          </button>
        } />

      {/* The page's reads alone (ruling R1): the figures' failed read for THIS period, the
          permission read and the closed-periods list. An action's refusal is beside its control. */}
      {(figures.message ?? permsError ?? listError) && (
        <p className={`${NOTICE.refusal} mb-3`}>{figures.message ?? permsError ?? listError}</p>
      )}

      <div className="flex flex-col gap-6 min-[1360px]:flex-row min-[1360px]:items-start">
      <div className="min-w-0 flex-1">
      {/* Two tabs over the mounted sections (spec §4.4; src/lib/close-tabs.ts): Reconcile holds
          the picker, the schedule and the readiness; Closed periods the period cards. The file's
          GL export tab draws a journal preview the app has no read for (#822). */}
      <RecordTabs label={CLOSE_TAB_LABEL} tabs={closeTabs()} panels={{
        reconcile: (
          <>
      {/* ---- Period picker + Close ---- */}
      <section id="period" className={`${CARD} mb-6`}>
        <h2 className="mb-2 font-medium">Period</h2>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="block">
            Year
            <input type="text" inputMode="numeric" value={yearText}
                   onChange={(e) => setYearText(e.target.value)}
                   className={`${INPUT_COMPACT} mt-1 block w-24`} />
          </label>
          <label className="block">
            Month
            <select value={month} onChange={(e) => setMonth(closeMonthFrom(e.target.value) ?? month)}
                    className={`${INPUT_COMPACT} mt-1 block`}>
              {MONTH_NAMES.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}
            </select>
          </label>
        </div>
        {figures.preliminary?.alreadyClosed && (
          <p className="mt-2 text-sm text-accent-600">This period is already closed — closing again re-freezes its schedule.</p>
        )}
        {!!figures.preliminary && figures.preliminary.unpostedBatchCount > 0 && (
          <p className="mt-2 text-sm text-accent-600">
            {formatNumber(figures.preliminary.unpostedBatchCount)} open receipt batch{figures.preliminary.unpostedBatchCount === 1 ? "" : "es"} dated
            in this month {figures.preliminary.unpostedBatchCount === 1 ? "is" : "are"} not yet posted — post first if it belongs in this close.
          </p>
        )}
      </section>

      {/* ---- Continuity schedule ---- */}
      <section id="continuity" className={`${CARD} mb-6`}>
        <h2 className="mb-2 font-medium">Continuity schedule{period && ` — ${periodLabel(period.year, period.month)}`}</h2>
        {figures.status === "uncommitted" && <p className="text-sm text-ink-500">{UNCOMMITTED_YEAR_TITLE}</p>}
        {figures.status === "loading" && <p className="text-sm text-ink-500">Loading…</p>}
        {schedule && (
          <table className="w-full max-w-md text-sm">
            <tbody>
              <tr><td className="py-1">Beginning A/R</td><td className="tabular-nums py-1 text-right">{formatMoney(schedule.beginningAr)}</td></tr>
              <tr><td className="py-1">+ Invoiced</td><td className="tabular-nums py-1 text-right">{formatMoney(schedule.invoicedTotal)}</td></tr>
              <tr><td className="py-1">− Credits</td><td className="tabular-nums py-1 text-right">{formatMoney(schedule.creditTotal)}</td></tr>
              <tr><td className="py-1">− Posted payments</td><td className="tabular-nums py-1 text-right">{formatMoney(schedule.paymentTotal)}</td></tr>
              <tr><td className="py-1">− Discounts</td><td className="tabular-nums py-1 text-right">{formatMoney(schedule.discountTotal)}</td></tr>
              <tr><td className="py-1">− Write-offs</td><td className="tabular-nums py-1 text-right">{formatMoney(schedule.writeOffTotal)}</td></tr>
              <tr className="border-t font-medium"><td className="py-1">Ending A/R</td><td className="tabular-nums py-1 text-right">{formatMoney(schedule.endingAr)}</td></tr>
              <tr>
                <td className="py-1 text-ink-500">Aging ending A/R</td>
                <td className="tabular-nums py-1 text-right text-ink-500">{formatMoney(schedule.agingEndingAr)}</td>
              </tr>
              <tr className={schedule.variance !== 0 ? "font-medium text-red-700" : "text-success-700"}>
                <td className="py-1">Variance</td>
                <td className="tabular-nums py-1 text-right">{formatMoney(schedule.variance)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </section>

      {/* ---- Readiness ---- */}
      <section id="readiness" className={`${CARD} mb-6`}>
        <h2 className="mb-2 font-medium">GL-export readiness</h2>
        {/* #147, now the leaf's: the gaps shown are the committed period's own payload and none
            other (`periodFigures`), so after a failed month-switch neither the affirmative
            all-clear nor the prior month's gap list can render (the banner at the top is what
            reports the failure), and while the new month's read is out the list reads Loading… */}
        {figures.status === "uncommitted" && <p className="text-sm text-ink-500">{UNCOMMITTED_YEAR_TITLE}</p>}
        {figures.status === "loading" && <p className="text-sm text-ink-500">Loading…</p>}
        {figures.gaps !== null && query !== null && (figures.gaps.length === 0 ? (
          <p className="text-sm text-success-700">No GL account gaps for this period — ready to export once closed.</p>
        ) : (
          <>
            <ul className="mb-2 list-inside list-disc text-sm">
              {figures.gaps.map((g, i) => (
                <li key={`${g.kind}-${g.id ?? i}`}>
                  {g.label} — <a href={g.href} data-navigation="document" className={LINK}>Fix</a>
                </li>
              ))}
            </ul>
            <a href={`/api/receivables/close/readiness/export?${query}`} className={`${LINK} text-sm`}>
              Export gap list to Excel
            </a>
          </>
        ))}
      </section>

          </>
        ),
        closed: (
          /* ---- Closed periods ---- */
          <section id="closed-periods" className={CARD}>
        <h2 className="mb-2 font-medium">Closed periods</h2>
        {!listLoaded && !listError && <p className="text-sm text-ink-500">Loading…</p>}
        {listLoaded && closedPeriods.length === 0 && (
          <p className="text-sm text-ink-500">No period has been closed yet.</p>
        )}
        {closedPeriods.map((p) => {
          const isSelected = period !== null && p.year === period.year && p.month === period.month;
          // The gap count is only known-fresh for the period under the picker above (the SAME
          // fetch the Close button's own variance check reads) — a historical row's gap count
          // would need its own readiness fetch, which this screen deliberately doesn't do N times
          // over. Any real gap on a non-selected row still surfaces: `exportClose` refuses (409)
          // and the message lands under that row. #147, through the leaf: for the selected row the
          // count is the committed period's own gaps (`figures.gaps`), UNKNOWN (null) while its
          // read is out and after it failed, never the prior month's.
          const gapCount = !isSelected ? 0 : figures.gaps !== null ? figures.gaps.length : null;
          const exportTitle = !editGate.allowed ? editGate.title
            : !exportDoGate.allowed ? exportDoGate.title
              : p.status !== "CLOSED" ? "Must be closed (not reopened) to export"
                : gapCount === null ? (figures.status === "error" ? "GL-export readiness could not be loaded" : "Loading…")
                  : gapCount > 0 ? `${gapCount} GL account gap${gapCount === 1 ? "" : "s"} must be resolved first`
                    : exportingId === p.id ? "Exporting…" : undefined;
          const reopenTitle = !editGate.allowed ? editGate.title
            : !closeDoGate.allowed ? closeDoGate.title
              : p.status !== "CLOSED" ? "Already reopened" : undefined;
          return (
            // data-testid: the E2E flow's `periodRow` keys on it (#90) — the old xpath
            // `ancestor::div[contains(@class,'p-3')]` broke on any padding retune.
            <div key={p.id} data-testid="closed-period-row" className="mb-3 rounded border p-3 text-sm last:mb-0">
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-medium">{periodLabel(p.year, p.month)}</span>{" "}
                  <span className={`rounded px-1.5 py-0.5 text-xs ${p.status === "CLOSED" ? "bg-success-50 text-success-700" : "bg-accent-50 text-accent-600"}`}>
                    {p.status}
                  </span>{" "}
                  {p.chainBroken && (
                    <>
                      <span className={BADGE_DANGER}>CHAIN BROKEN</span>{" "}
                    </>
                  )}
                  <span className="text-ink-500">closed {formatDateTime(p.closedAt)}</span>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => void doReopen(p.id, periodLabel(p.year, p.month))}
                          disabled={reopenTitle !== undefined} title={reopenTitle}
                          className="rounded border px-2 py-1 text-xs">
                    {`Reopen ${periodLabel(p.year, p.month)}`}
                  </button>
                  <button onClick={() => void doExport(p.id)} disabled={exportTitle !== undefined} title={exportTitle}
                          className="rounded border px-2 py-1 text-xs">
                    {exportingId === p.id ? "Exporting…" : "Export GL summary"}
                  </button>
                </div>
              </div>
              {/* This row's own refusal, under its buttons (ruling R1): Reopen's blank reason, or
                  what the server answered its Reopen or Export. */}
              <PanelMessage message={rowMessage !== null && rowMessage.id === p.id ? rowMessage.text : null} />
              <p className="text-ink-500">
                Beginning {formatMoney(p.beginningAr)} · Ending {formatMoney(p.endingAr)} · Variance {formatMoney(p.variance)}
              </p>
              {p.chainBroken && (
                <p className="text-red-700">
                  {/* Three flagged shapes, each named with its real way out (§5.14): a moved prior
                      ending re-closes THIS month; a gap must close the MISSING month first (this
                      month's re-close would 409 on the skipped-month rule); a nonzero genesis has
                      no prior at all — its beginning should be the 0.00 chain baseline. */}
                  {p.priorEndingAr !== null ? (
                    <>Beginning {formatMoney(p.beginningAr)} no longer matches the prior month&apos;s ending{" "}
                      {formatMoney(p.priorEndingAr)} — re-close this month to re-chain.</>
                  ) : closedPeriods.some((q) => q.year < p.year || (q.year === p.year && q.month < p.month)) ? (
                    <>Beginning {formatMoney(p.beginningAr)} does not chain — the month before this one has
                      no close on record; close the missing month first, then re-close this one.</>
                  ) : (
                    <>Beginning {formatMoney(p.beginningAr)} does not chain — this is the first closed month,
                      so its beginning should be 0.00; re-close this month to re-chain.</>
                  )}
                </p>
              )}
              {p.exportBatches.length === 0 ? (
                <p className="mt-1 text-ink-500">No export yet.</p>
              ) : (
                <ul className="mt-1">
                  {p.exportBatches.map((b) => (
                    <li key={b.id}>
                      Export #{b.exportNumber} ({formatDateTime(b.emittedAt)}) —{" "}
                      <a href={`/api/receivables/close/export/${b.id}/file`} className={LINK}>File</a>
                      {" "}·{" "}
                      <a href={`/api/receivables/close/export/${b.id}/register`} target="_blank" rel="noreferrer"
                         className={LINK}>
                        Register
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </section>
        ),
      }} />
      </div>
      {/* The card's three figures are the committed period's schedule (`periodFigures`, #649),
          "—" while none is shown. It also holds Close period's refusal (ruling R1: beside its
          control, keyed to the period it was raised for, #649): the button is the header's,
          reachable from either tab, so its message is the card's, seen from either tab too
          (Codex on #848), never the hidden Reconcile panel's. */}
      <AtAGlance rows={[
        { label: "Continuity A/R", value: <span className="tabular-nums">{schedule ? formatMoney(schedule.endingAr) : "—"}</span> },
        { label: "Aging A/R", value: <span className="tabular-nums">{schedule ? formatMoney(schedule.agingEndingAr) : "—"}</span> },
        { label: "Variance", value: <span className="tabular-nums">{schedule ? formatMoney(schedule.variance) : "—"}</span> },
      ]}>
        <div className="mt-4 text-xs">
          <PanelMessage message={closeRefusal} />
        </div>
      </AtAGlance>
      </div>
    </div>
  );
}

/** `useSearchParams` suspends during prerender, and Next refuses to build a page that reads it
 *  outside a Suspense boundary — the `Statements.tsx` wrapper precedent. */
export function Close() {
  return (
    <Suspense fallback={<div className="p-6">Loading…</div>}>
      <ClosePeriodsScreen />
    </Suspense>
  );
}
