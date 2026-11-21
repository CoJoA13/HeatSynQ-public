"use client";
// The first-run setup checklist (Phase 8B §5.5). A CLIENT component against the guarded
// /api/setup/readiness (the Phase 1 precedent, the ReportsIndex.tsx clone): gated admin.view —
// without it the page says why (§5.16 / GateNotice), never a silently empty list. Every step
// deep-links to an EXISTING admin screen; the only NEW mutation is PUT /api/setup/state, which
// records the two non-derivable facts (numbers confirmed, checklist dismissed).
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import { useLatest } from "@/lib/use-latest";
import { invalidateSetupBanner } from "@/components/SetupBanner";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { GateNotice } from "@/lib/report-ui";
import { PageHeader } from "@/components/PageHeader";
import { setupStateWord } from "@/lib/setup-words";
import { BADGE_WARNING, BUTTON_NEUTRAL_COMPACT, CARD_FLUSH, LINK, NOTICE, TABLE_CELL, TABLE_HEAD } from "@/lib/ui-classes";

type SetupStep = { key: string; label: string; href: string; complete: boolean; blocking: boolean };
type Readiness = { steps: SetupStep[]; dismissed: boolean; complete: boolean };

/**
 * The checklist's footer — C7b (#239). A dismissed checklist is a FACT about this installation,
 * not an action offered and then refused. It used to be ONE button, relabelled to "Checklist
 * dismissed" and disabled: it said "there is something to click here" and then said "you may
 * not", and because `disabled` is also how §5.16 renders a missing `admin.edit`, two completely
 * different reasons rendered identically — a read-only admin looking at a NOT-yet-dismissed
 * checklist saw the same greyed-out control as anyone looking at a dismissed one.
 *
 * So the two states are two elements: a status line once it is dismissed, the action while it is
 * not. Hook-free and props-in/markup-out, the `SetupBannerView` precedent — this repo has no DOM
 * test environment, so a rule that lives inside the fetching component cannot be rendered by a
 * test at all (`tests/admin-screens.test.tsx` drives this directly).
 */
export function DismissChecklistView({ dismissed, busy, editGate, onDismiss }: {
  dismissed: boolean;
  busy: boolean;
  editGate: { allowed: boolean; title: string | undefined };
  onDismiss: () => void;
}) {
  if (dismissed) {
    return (
      <p className="inline-flex items-center gap-2 text-sm text-ink-500">
        <span aria-hidden className="text-success-700">✓</span>
        <span className="rounded bg-surface-50 px-2 py-0.5">Checklist dismissed</span>
      </p>
    );
  }
  return (
    <button type="button" disabled={busy || !editGate.allowed}
            title={editGate.allowed ? undefined : editGate.title}
            onClick={onDismiss}
            className="rounded border px-3 py-1 text-sm text-ink-500">
      Dismiss checklist
    </button>
  );
}

export function SetupChecklist() {
  const { permissions: perms, error: permsError } = usePermissions();
  const viewGate = gate(perms, "admin.view");
  // The page is viewable with admin.view, but the confirm/dismiss controls PUT /api/setup/state
  // (admin.edit) — disable them for a read-only admin so they never see a control that 403s (Codex).
  const editGate = gate(perms, "admin.edit");
  const [data, setData] = useState<Readiness | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const allowed = viewGate.allowed;
  // §5.13 stale-gate, both paths (F7) — #223 item 2: every action refires this un-awaited while
  // the buttons re-enable, so two rapid actions could repaint pre-action state. The window is
  // wide by construction: `install-readiness.ts` argon2-verifies the admin password on every
  // read. `setLoaded` is gated with the payload (review finding): released alone, a superseded
  // response could clear the loading line while `data` was still null — a blank body. The
  // superseding response always sets it, so gating costs nothing.
  const latest = useLatest();
  const load = useCallback(() => {
    if (!allowed) return;
    const t = latest.next();
    api<Readiness>("/api/setup/readiness")
      .then((d) => { if (latest.isCurrent(t)) { setData(d); setLoaded(true); } })
      .catch((e) => { if (latest.isCurrent(t)) { setError((e as Error).message); setLoaded(true); } });
  }, [allowed, latest]);
  useEffect(load, [load]);

  async function putState(body: { confirmNumbers?: boolean; dismiss?: boolean }) {
    setBusy(true);
    setError(null);
    try {
      await api<unknown>("/api/setup/state", { method: "PUT", body: JSON.stringify(body) });
      // #110: the shell banner fetches readiness once per session, and a confirm/dismiss moves
      // that signal — fired the instant the PUT resolves, BEFORE the follow-up load (the
      // #124/!131 ordering: the server state has certainly changed by now, and a transiently
      // failing load() must not skip the signal). Success path only: a failed PUT writes nothing.
      invalidateSetupBanner();
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (permsError || perms === undefined || !viewGate.allowed) {
    return (
      <GateNotice
        header={<PageHeader title="Setup checklist" />}
        permsError={permsError}
        loading={perms === undefined}
        deniedMessage={viewGate.title ?? "You do not have permission to view setup."}
      />
    );
  }

  return (
    <div className="p-6">
      <PageHeader title="Setup checklist" subtitle={<>
        Complete these steps to configure the system. The steps marked <span className="font-medium">required</span>{" "}
        must be done before you can enter orders.
      </>} />
      {error && <p className={`${NOTICE.refusal} mb-3`}>{error}</p>}
      {!loaded && <p className="text-sm text-ink-500">Loading…</p>}
      {loaded && data && (
        <>
          <div className={`${CARD_FLUSH} overflow-x-auto`}>
            <table className="w-full text-sm">
              <thead><tr className="border-b text-left">
                <th className={`${TABLE_HEAD} p-2`}>Item</th><th className={`${TABLE_HEAD} p-2`}>State</th>
                <th className={`${TABLE_HEAD} p-2`}>Where</th>
              </tr></thead>
              <tbody>
                {data.steps.map((s) => (
                  <tr key={s.key} className="border-t">
                    <td className={TABLE_CELL}>{s.label}</td>
                    <td className={TABLE_CELL}>
                      <span className={s.blocking && !s.complete ? BADGE_WARNING : s.complete ? "text-success-700" : undefined}>
                        {setupStateWord(s)}
                      </span>
                    </td>
                    <td className={TABLE_CELL}>
                      <span className="flex items-center gap-3">
                        {s.key === "numbers" && !s.complete && (
                          <button type="button" disabled={busy || !editGate.allowed}
                                  title={editGate.allowed ? undefined : editGate.title}
                                  onClick={() => void putState({ confirmNumbers: true })}
                                  className={BUTTON_NEUTRAL_COMPACT}>
                            Mark confirmed
                          </button>
                        )}
                        {!s.complete && (
                          <Link href={s.href} className={`${LINK} text-sm`}>Set up</Link>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4">
            <DismissChecklistView dismissed={data.dismissed} busy={busy} editGate={editGate}
                                  onDismiss={() => void putState({ dismiss: true })} />
          </div>
        </>
      )}
    </div>
  );
}
