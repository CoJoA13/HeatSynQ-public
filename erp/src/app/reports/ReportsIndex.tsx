"use client";
// The /reports index (Phase 8A Task 0, spec §4) — the landing page for every report, closing the
// dead 404 the nav's Reports entry used to hit. A CLIENT component against the guarded /api/reports
// (the Phase 1 precedent: a server page that fetches must call requireUser itself, so a client
// component against a guarded API sidesteps that rule). Gated on reports.view — without it the page
// says why (§5.16), never a silently empty list, mirroring AgingReport.tsx.
import { useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { GateNotice } from "@/lib/report-ui";
import { PageHeader } from "@/components/PageHeader";
import { ReportsNav } from "./ReportsNav";
import type { ReportEntry } from "@/lib/report-registry";
import { CARD, LINK, NOTICE } from "@/lib/ui-classes";

export function ReportsIndex() {
  const { permissions: perms, error: permsError } = usePermissions();
  const viewGate = gate(perms, "reports.view");
  // A `loaded` flag distinct from "the array is empty" (HANDOFF §5.15): a failed fetch must say so,
  // never render as a genuinely empty, healthy index.
  const [reports, setReports] = useState<ReportEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allowed = viewGate.allowed;
  useEffect(() => {
    if (!allowed) return;
    api<ReportEntry[]>("/api/reports")
      .then((data) => { setReports(data); setLoaded(true); })
      .catch((e) => { setError((e as Error).message); setLoaded(true); });
  }, [allowed]);

  // §5.16 + Codex fix 2: distinguish a permissions-fetch FAILURE (retryable banner) from the initial
  // LOADING state from a genuine denial — a failed /api/auth/me must never read as "Requires
  // reports.view", which also hid the retryable banner behind this early return.
  if (permsError || perms === undefined || !viewGate.allowed) {
    return (
      <GateNotice
        header={<><ReportsNav /><PageHeader title="Reports" subtitle="Read-only answers to practical shop questions." /></>}
        permsError={permsError}
        loading={perms === undefined}
        deniedMessage={viewGate.title ?? "You do not have permission to view reports."}
      />
    );
  }

  return (
    <div className="min-w-0 p-3 sm:p-6">
      <ReportsNav />
      <PageHeader title="Reports" subtitle="Read-only answers to practical shop questions." />
      {error && (
        <p className={`${NOTICE.refusal} mb-3`}>{error}</p>
      )}
      {reports.length === 0 && loaded && !error ? (
        <p className="text-sm text-ink-500">No reports are available to you yet.</p>
      ) : (
        <ul className="space-y-2">
          {reports.map((r) => (
            <li key={r.key} className={CARD}>
              <a href={r.href} data-navigation="document" className={LINK}>{r.label}</a>
              {r.description && <p className="mt-1 text-sm text-ink-500">{r.description}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
