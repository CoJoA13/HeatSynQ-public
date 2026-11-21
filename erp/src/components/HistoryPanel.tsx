"use client";
import { formatDateTime } from "@/lib/format";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/fetcher";
// The pure diff logic lives in a client-safe leaf so tests/audit-diff.test.ts can pin it —
// including the raw-FK suppression (#14 item 2's render half) — without a DOM test env.
import { changedFields, summarizeChange, detailJson } from "@/lib/audit-diff";
// Whether this viewer may read history at all (#620): decided in a pure leaf from the page's own
// permission read, before anything is sent.
import { historyAccess } from "@/lib/history-access";
// The parent → child-section registry the server walked to build this union (#153) — imported
// here so a foreign row is LABELLED by the same source of truth that decided to include it, and
// the panel can never render a row it cannot name.
import { auditChildLabel } from "@/lib/audit-children";

type Entry = {
  // `entity` matters now that the read is a union: it is what distinguishes the parent's own
  // rows from a child section's, and it is what `auditChildLabel` names the latter by.
  id: string; entity: string; at: string; actorName: string; action: string; reason: string | null;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null;
};

/** What the audit route's single-record branch answers since #153 — capped rows plus whether the
 *  cap actually bit, so the panel can state the truncation instead of quietly shortening history. */
type HistoryResponse = { rows: Entry[]; hasMore: boolean };

// The audit endpoint is gated on admin.view (a permission-model decision recorded in
// docs/HANDOFF.md §6, deliberately not revisited here). A user who can view the record this
// panel is attached to but lacks admin.view is told so by the panel itself and sends nothing
// (#620: `historyAccess` over the page's permission read); before that the request went out on
// every mount and after every write, was refused with a 403, and the old code once treated that
// identically to "zero entries" — silently misreporting a record that does have history as having
// none. "loading" also matters as its own state, not folded into "ok" with zero entries: the
// panel must not flash "No history" for the instant before the real answer arrives. The route's
// gate stays the enforcement; this panel's check only spares the request.
type Status = "loading" | "ok" | "error";

/**
 * Mounted panels ↔ mutating pages, the invalidateSetupBanner/invalidateBackupBanner mechanism
 * (#124/#110) cloned for #14 item 1. A module-level Set rather than context: the panel lives at
 * the bottom of a detail page and the mutations that move its history live in that page's
 * sections, with no common provider worth wrapping the app for; a Set also means a remount
 * cannot leave a stale subscriber behind. Per-tab, like both precedents.
 */
const invalidationListeners = new Set<() => void>();

/** Subscribe a listener; returns the unsubscribe. Exported so tests/history-invalidation.test.ts
 *  can pin the register/invalidate/unsubscribe contract without a DOM test env (the
 *  subscribeSetupInvalidations precedent); the component's own effect subscribes through this
 *  too, so the tested path IS the wired path. */
export function subscribeHistoryInvalidations(listener: () => void): () => void {
  invalidationListeners.add(listener);
  return () => { invalidationListeners.delete(listener); };
}

/**
 * Tell every mounted HistoryPanel that the history it shows is out of date, or may be, and to
 * refetch NOW (#14 item 1). The panel otherwise fetches once per mount per entity, so without
 * this an edit made while staying on the page — set the material, then a price — never appeared
 * until a full reload, teaching an operator the panel lies. Call sites fire it on a mutation's
 * SUCCESS path, the instant the mutation resolves and BEFORE any follow-up load (the #124/!131
 * ordering: the server state has certainly changed by then, and a transiently failing follow-up
 * read must not skip the signal). Two fire it off that path, before a read the page makes about a
 * write it never heard land: the order hub's read after a line Remove answered 404 "Order line
 * not found" (`readAfterRemoval` in src/app/orders/[id]/page.tsx, #475), where the line has
 * certainly gone, and ReferenceTable's read after a save the server did not answer, which may
 * have been committed (and was, when the answer was a 2xx whose body could not be read). Five
 * more fire it from a catch, for an `UnreadableAnswerError` only (#547, owner ruling 2026-10-18:
 * a 2xx proves the write committed): each record page's `applyMutation` (the order hub, the saved
 * shipment, the invoice, the cert and the receipt batch). That seam reads nothing itself; some of
 * its callers' existing §5.13 rollback reads follow, in their own catch. Every mounted panel
 * refetches — cheap (one gated GET each), and a cross-entity signal is at worst a refresh that
 * finds nothing new.
 */
export function invalidateHistory(): void {
  for (const listen of invalidationListeners) listen();
}

/** `perms` and `permsError` are the page's own `usePermissions()` state (every mounting page
 *  already holds it), REQUIRED so a mount that forgets them is a compile error rather than a panel
 *  that fetches ungated as before (#620). */
export function HistoryPanel({ entity, entityId, perms, permsError }: {
  entity: string; entityId: string; perms: string[] | undefined; permsError: string | null;
}) {
  const access = historyAccess(perms, permsError);
  const allowed = access.kind === "allowed";
  const [entries, setEntries] = useState<Entry[]>([]);
  // Set from the SAME response as `entries`, in the same gated branch, so the two can never
  // disagree about which read they describe.
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<Status>("loading");
  // Bumped by an invalidation to re-run the fetch effect below (the SetupBanner refreshNonce
  // shape, minus the one-shot latch). The read is one capped GET whose rows the route has already
  // reduced to the keys this panel draws (#615), so a re-run after every write is affordable.
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Subscribed only while allowed: a denied panel has no read to re-run, and an invalidation
  // must not wake a request the gate refused.
  useEffect(() => {
    if (!allowed) return;
    return subscribeHistoryInvalidations(() => setRefreshNonce((n) => n + 1));
  }, [allowed]);
  // Which entity/entityId the currently rendered entries belong to — so an invalidation refetch
  // (same key) keeps the list on screen instead of flashing "Loading history…" after every
  // section save, while a re-pointed panel (call sites re-point `entityId` into this unkeyed
  // subtree) still blanks to loading rather than showing row A's history under row B's heading.
  const loadedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    // Nothing is sent until the page's permission read has landed and allows it (#620); `allowed`
    // is a dep, so the read fires the moment pending turns to allowed.
    if (!allowed) return;
    const key = `${entity}:${entityId}`;
    if (loadedKeyRef.current !== key) setStatus("loading");
    // Effect-scoped stale flag (the QuoteDetail/templates-list shape — the sanctioned useLatest
    // equivalent where the fetch is keyed entirely by the effect's deps, refreshNonce included),
    // gating BOTH paths: a superseded response must not paint stale rows, flip a fresh "ok" to
    // "error", or mask a real 403 with a stale success.
    let stale = false;
    api<HistoryResponse>(`/api/admin/audit?entity=${entity}&entityId=${entityId}`)
      .then((res) => {
        if (stale) return;
        loadedKeyRef.current = key;
        setEntries(res.rows);
        setHasMore(res.hasMore);
        setStatus("ok");
      })
      .catch(() => { if (!stale) { loadedKeyRef.current = null; setStatus("error"); } });
    return () => { stale = true; };
  }, [entity, entityId, refreshNonce, allowed]);
  if (access.kind === "pending") return <p className="text-sm text-ink-500">Loading history…</p>;
  if (access.kind === "denied") return <p className="text-sm text-ink-500">{access.title}</p>;
  if (access.kind === "failed") return <p className="text-sm text-ink-500">History could not be loaded.</p>;
  if (status === "loading") return <p className="text-sm text-ink-500">Loading history…</p>;
  // Never render "No history" for a request that did not succeed — that's indistinguishable
  // from a record that genuinely has none, and actively misinforms whoever lacks admin.view.
  if (status === "error") {
    return <p className="text-sm text-ink-500">History could not be loaded.</p>;
  }
  if (entries.length === 0) return <p className="text-sm text-ink-500">No history.</p>;
  return (
    <>
      <ul className="divide-y rounded border bg-surface-0 text-sm">
        {entries.map((e) => {
          // null for the parent's own rows, which need no label — and for any entity that is not
          // a registered child of this parent, which renders plainly rather than under a guess.
          const section = auditChildLabel(entity, e.entity);
          return (
            <li key={e.id} className="p-2">
              <div className="flex justify-between">
                <span>
                  {section && (
                    <span className="mr-1 rounded bg-surface-50 px-1.5 py-0.5 text-xs text-ink-500">
                      {section}
                    </span>
                  )}
                  <b>{e.actorName}</b> — {e.action}{e.reason ? ` (${e.reason})` : ""}
                </span>
                <span className="text-ink-500">{formatDateTime(e.at)}</span>
              </div>
              {changedFields(e.before, e.after).map((k) => {
                // A changed field LEADS with a human line (`summarizeChange`) and keeps the raw
                // snapshots behind a disclosure. A scalar says everything on its own line and gets
                // no disclosure at all; a relation array or object gets "5 items, contents changed"
                // over a <details> holding the indented before/after.
                //
                // #170's rule still governs the box that holds the bytes, and its classes are
                // load-bearing: a SNAPSHOT_INCLUDE relation is kilobytes of single-line JSON with
                // almost no break opportunities, so with no wrapping rule it pushed the whole page
                // wider than the viewport (a line write's `lines` array, every line's columns on
                // both sides, is the worst case; a CREATE entry draws no diff line at all, since
                // `changedFields` answers [] for a null side). `break-all` lets it wrap at any
                // character so it can never resize the page again; `max-h-40 overflow-y-auto`
                // keeps a multi-KB payload scrolling inside its own box rather than turning one row
                // into a wall. Do not drop them in a "cleanup" — the defect was the ABSENCE of
                // exactly this.
                //
                // The disclosure does NOT weaken that contract: it constrains the rendering, it
                // still does not truncate. Every byte of the changed keys the route ships (#615:
                // an update row's snapshots arrive reduced to those keys, which are the keys this
                // loop draws) is in `detailJson`, one click away instead of zero.
                const { inline, expandable } = summarizeChange(e.before?.[k], e.after?.[k]);
                if (!expandable) {
                  // The cap belongs here too, and dropping it was a regression (Codex P2 on !272):
                  // a scalar is not necessarily short — an audited `notes` or `reason` runs to
                  // thousands of characters — so an uncapped scalar turns one history row into the
                  // multi-screen wall #170's box exists to prevent. Same classes, same reason.
                  return (
                    <div key={k} className="ml-2 max-h-40 overflow-y-auto break-all text-xs text-ink-500">
                      {k}: {inline}
                    </div>
                  );
                }
                return (
                  <details key={k} className="ml-2 text-xs text-ink-500">
                    <summary className="cursor-pointer break-all">{k}: {inline}</summary>
                    <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded bg-surface-50 p-1">
                      {detailJson(e.before?.[k], e.after?.[k])}
                    </pre>
                  </details>
                );
              })}
            </li>
          );
        })}
      </ul>
      {/* The read is capped (AUDIT_PANEL_LIMIT), and a silently shortened history is the same
          class of lie as the "No history" on a 403 this panel already refuses to show. Stated
          from the response's own `hasMore` and the rows actually rendered, so the sentence stays
          true whatever the cap is set to. */}
      {hasMore && (
        <p className="mt-1 text-xs text-ink-500">
          Showing the most recent {entries.length} changes — older history is not listed.
        </p>
      )}
    </>
  );
}
