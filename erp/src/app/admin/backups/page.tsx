"use client";
// The Backups page (Phase 8C §6.2). Gated on `manage_backups`, production-only (the routes refuse
// the practice copy). Everything it shows comes from one guarded endpoint; it holds no business
// logic — the green rule lives in evaluateHealth (backups.ts), which is where it is tested.
import { formatDateTime } from "@/lib/format";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, UnreadableAnswerError } from "@/lib/fetcher";
import { gateDo } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { invalidateBackupBanner } from "@/components/BackupBanner";
import type { ArchiveInfo, BackupsView } from "@/lib/backup-constants";
import { archiveTableNote, runControlState } from "./run-control-state";
import { AtAGlance } from "@/components/AtAGlance";
import { PageHeader } from "@/components/PageHeader";
import { backupGlance } from "@/lib/backup-glance";
import { BUTTON_PRIMARY, CARD, CARD_FLUSH, NOTICE, TABLE_CELL, TABLE_HEAD } from "@/lib/ui-classes";

const fmtBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB`
  : n >= 1024 ? `${(n / 1024).toFixed(0)} KB`
  : `${n} B`;



export default function BackupsPage() {
  const [view, setView] = useState<BackupsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  /**
   * The server's own sentence when the VIEW endpoint refuses this caller (#123) — set on any 403,
   * cleared on a successful load.
   *
   * On the practice copy the routes 403 with "Backups are managed on the production copy only…",
   * and the page went on rendering an enabled "Back up now" plus a `…` folder placeholder: a
   * control that can never work, presented as available (§5.16). It keys on the 403 itself rather
   * than on which CAUSE produced it, deliberately — `mustDo` and `assertNotPracticeDatabase` are
   * both reasons this page's actions cannot work, so one path handles both and the tooltip carries
   * whichever sentence the server actually sent. Nothing here reads the practice flag: §8 forbids
   * that in a client component, and `nav.ts` is left alone for the same reason (the ruling keeps the
   * nav entry).
   */
  const [refusal, setRefusal] = useState<string | null>(null);
  /** Has the view request FINISHED — succeeded or failed? Distinct from "did it return a view", so a
   *  transient failure re-opens the control rather than pinning it on "Loading…" forever. */
  const [viewSettled, setViewSettled] = useState(false);
  // The SHARED hook, never a hand-rolled /api/auth/me effect. Its own header names "reimplemented
  // rather than shared" as this repo's recurring defect shape, and it gets two things right that a
  // local copy reliably gets wrong: `permissions` stays `undefined` while in flight (so gateDo
  // keeps controls DISABLED rather than flashing them open and then locking), and a failed fetch
  // surfaces as `error` instead of being swallowed into `[]`, which is indistinguishable from a
  // real "no grants" account and would permanently disable every control with no explanation.
  const { permissions, error: permError } = usePermissions();

  // The 403 classification lives INSIDE `load`, not at one call site (Codex, MR !131). A grant can
  // be revoked while this page is mounted — most plausibly during a long-running dump — and both
  // the reload after a successful POST and the catch path's retry would then 403 with only the
  // outer catch to see them. `refusal` would stay null, and the stale permission grant plus the
  // previously loaded view would re-enable "Back up now" though every later request is forbidden.
  // `usePermissions` is fetched once and cannot notice either. Classifying here means every reload
  // caller — present and future — updates the latch without having to remember.
  const load = useCallback(async () => {
    try {
      const v = await api<BackupsView>("/api/admin/backups");
      setView(v);
      setRefusal(null);
      return v;
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setRefusal(e.message);
      throw e;
    }
  }, []);

  useEffect(() => {
    load()
      .catch((e) => {
        setError(e instanceof ApiError ? e.message : "Could not read the backup folder.");
      })
      .finally(() => setViewSettled(true));
  }, [load]);

  const gate = gateDo(permissions, "manage_backups");

  async function backUpNow() {
    setRunning(true);
    setError(null);
    try {
      await api<{ archive: ArchiveInfo }>("/api/admin/backups/run", { method: "POST" });
      // #124: the shell's staleness bar caches its health for REFRESH_MS, so without this the bar
      // stayed RED directly above a panel that had just gone green — the two contradicting each
      // other on one screen. The ordinary polling throttle is untouched; this is an explicit
      // "something happened" signal.
      //
      // Fired the instant the POST resolves, BEFORE the view refresh (Codex, MR !131). The backup
      // has already happened by then, so the banner's cached health is already wrong — and if
      // `load()` were to fail transiently we would fall into the catch, which retries it and can
      // turn the panel green while never reaching an invalidation placed after it. That recreates
      // the exact stale-red-over-green contradiction this is here to prevent.
      invalidateBackupBanner();
      await load();
    } catch (e) {
      // A FAILED attempt invalidates too (Codex, MR !131). `runBackupNow`'s `fail()` writes
      // `ok:false` to the status file, so the health the banner is holding is now stale in the RED
      // direction — and without this the page would render a red panel while the shell bar stayed
      // HIDDEN on its cached green until the throttle lapsed. That is #124's contradiction pointing
      // the other way, and the more dangerous direction of the two: a failure that does not surface.
      invalidateBackupBanner();
      // §5.13: refresh to server truth FIRST, then report — a reload after setError would wipe the
      // banner the operator needs to read.
      await load().catch(() => {});
      // #547: an `UnreadableAnswerError` shows its own sentence, never "The backup failed." (the
      // owner's answer of 2026-10-18 to the plan's question 5). From the run's POST it is the write
      // sentence: a 2xx means the backup ran. From the view's read after the run (`load` in the try
      // above) it is the read sentence: the backup ran, and the view's answer was lost.
      setError(e instanceof ApiError || e instanceof UnreadableAnswerError ? e.message : "The backup failed.");
    } finally {
      setRunning(false);
    }
  }

  const health = view?.health;
  const green = health?.state === "ok";
  const { disabled: runDisabled, title: runTitle } = runControlState(gate, running, refusal, viewSettled);
  const tableNote = archiveTableNote(viewSettled, view ? view.archives.length : null);

  const glance = health ? backupGlance(health, view?.archives ?? []) : null;

  return (
    <div className="p-6">
      <PageHeader title="Backups" subtitle="Production archives and current backup health." actions={
        <button type="button" onClick={backUpNow} disabled={runDisabled} title={runTitle} className={BUTTON_PRIMARY}>
          {running ? "Backing up…" : "Back up now"}
        </button>} />

      {/* The permissions failure folds in beside the page's own — a swallowed one would leave every
          control disabled with nothing on screen explaining why (usePermissions' documented rule). */}
      {(error ?? permError) && (
        <p className={`${NOTICE.refusal} mb-3`}>{error ?? permError}</p>
      )}

      <div className="flex flex-col gap-4 min-[1360px]:flex-row min-[1360px]:items-start">
        <div className="min-w-0 flex-1">
          {health && (
            <div
              className={`mb-4 rounded border px-4 py-3 ${
                green ? "border-success-700 bg-success-50 text-success-700"
                      : "border-red-300 bg-red-50 text-red-900"}`}
            >
              <div className="font-semibold">
                {green ? "Backups are up to date" : "Backups need attention"}
              </div>
              <div className="text-sm">{health.reason}</div>
              <div className="mt-1 text-xs opacity-80">
                {health.lastSuccessAt
                  ? `Last successful backup: ${formatDateTime(health.lastSuccessAt)}`
                  : "No successful backup on record."}
                {" · "}Threshold: {health.staleHours} hours
              </div>
            </div>
          )}

          <div className={`${CARD} mb-4`}>
            {/* #123: no `…` placeholder. When the folder is unknown because the route refused us, the
                refusal above already says why — a lone ellipsis just reads as "still loading" forever. */}
            {view?.folder && (
              <span className="mb-2 block text-sm text-ink-500">
                Backup folder: <code className="rounded bg-surface-50 px-1">{view.folder}</code>
              </span>
            )}
            <p className="text-sm text-ink-500">
              Restoring is a deliberate terminal command, not a button — see the restore runbook in{" "}
              <code className="rounded bg-surface-50 px-1">erp/README.md</code>.
            </p>
          </div>

          <div className={`${CARD_FLUSH} overflow-x-auto`}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className={`${TABLE_HEAD} p-2`}>Archive</th><th className={`${TABLE_HEAD} p-2`}>Taken</th>
                  <th className={`${TABLE_HEAD} p-2`}>Source</th><th className={`${TABLE_HEAD} p-2`}>Size</th>
                  <th className={`${TABLE_HEAD} p-2`}>Integrity</th>
                </tr>
              </thead>
              <tbody>
                {(view?.archives ?? []).map((a) => (
                  <tr key={a.name} className="border-t">
                    <td className={`${TABLE_CELL} font-mono`}>{a.name}</td>
                    <td className={TABLE_CELL}>{formatDateTime(a.modifiedAt)}</td>
                    <td className={TABLE_CELL}>{a.source === "manual" ? "On demand" : "Nightly"}</td>
                    <td className={TABLE_CELL}>{fmtBytes(a.sizeBytes)}</td>
                    <td className={`${TABLE_CELL} ${a.integrityOk ? "text-success-700" : "text-red-700"}`}>
                      {a.integrityOk ? "OK" : "CORRUPT"}
                    </td>
                  </tr>
                ))}
                {tableNote !== null && (
                  <tr><td colSpan={5} className={`${TABLE_CELL} text-ink-500`}>{tableNote}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        {glance && (
          <AtAGlance rows={[
            { label: "Latest run", value: glance.latestRun },
            { label: "Integrity", value: glance.integrity },
            { label: "Stale threshold", value: glance.staleThreshold },
          ]} />
        )}
      </div>
    </div>
  );
}
