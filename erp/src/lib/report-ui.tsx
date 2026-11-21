"use client";
// Client-safe UI shared by every /reports screen (Phase 8A Codex fixes 2 & 5). No src/server/**
// imports — a client component pulling from there drags node:async_hooks and Prisma into the
// browser bundle (CLAUDE.md "Constraints that will bite you"; the permission-ui.ts precedent).
import type { ReactNode } from "react";
import { LINK, NOTICE } from "@/lib/ui-classes";

/**
 * The gate/loading/error notice a /reports screen shows in place of its body when the caller cannot
 * (yet) see the report. THREE distinct states the screens previously collapsed into one always-
 * "denied" branch (Codex fix 2), which misreported a transient permissions-fetch failure as an
 * authorization denial AND left the retryable error banner unreachable:
 *   • `permsError` — the `/api/auth/me` fetch FAILED → a retryable red banner, NEVER "Requires
 *     reports.view";
 *   • `loading` — the permissions are still in flight → a neutral "Loading…" line;
 *   • otherwise — the caller is genuinely loaded-but-denied → the permission "why" message.
 * `header` carries the screen's own chrome (its back-link + heading) so the notice sits under it.
 */
export function GateNotice({ header, permsError, loading, deniedMessage }: {
  header: ReactNode;
  permsError: string | null;
  loading: boolean;
  deniedMessage: string;
}): ReactNode {
  return (
    <div className="min-w-0 p-3 sm:p-6">
      {header}
      {permsError ? (
        <p className={`${NOTICE.refusal} mb-3`}>{permsError}</p>
      ) : loading ? (
        <p className="text-sm text-ink-500">Loading…</p>
      ) : (
        <p className="text-sm text-ink-500">{deniedMessage}</p>
      )}
    </div>
  );
}

/**
 * The export link ("Export to Excel" unless `label` names another file, as the Invoicing list's
 * Export to PDF does, #592), built from `query` — which every screen passes as the query of the
 * CURRENTLY-DISPLAYED result (`appliedQuery`), never the live filter state (Codex fix 5). It is a
 * live link only when `ready` AND `query` is non-null: `query === null` is the "no successful load
 * yet" sentinel (Codex fix 6), and `ready` is false is unreachable-but-defended. Inert otherwise —
 * exporting a never-loaded or filter-mismatched view would hand back a file the on-screen table does
 * not show, breaking the screen==export guarantee. The inert span reads the same words.
 */
export function ExportLink({ base, query, ready, label = "Export to Excel", className }: {
  base: string;
  query: string | null;
  ready: boolean;
  label?: string;
  /** A page header's action reads as a button (the UX redesign PR 10); without one, a text link. */
  className?: string;
}): ReactNode {
  if (!ready || query === null) {
    return (
      <span aria-disabled="true" title="Loading the current view…"
            className={className ? `${className} cursor-not-allowed opacity-60` : "cursor-not-allowed text-ink-500 underline"}>
        {label}
      </span>
    );
  }
  return (
    <a href={`${base}${query ? `?${query}` : ""}`} className={className ?? LINK}>
      {label}
    </a>
  );
}
