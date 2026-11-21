"use client";
// The before-update banner (release-updates PR 3, Task 3.4; spec §6). Admins only (the API hands
// `pending` to admin.view holders alone), and only while a database-changing release is pending and
// not manual. Hook-free `UpdateBannerView` for the tests, the stateful `UpdateBanner` beside it; the
// read is src/lib/updates-client.ts's, shared with the dialog and the System page.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { HoldControl, useHoldAction } from "./UpdateHoldControl";
import { renderInline } from "@/lib/release-notes-render";
import { bannerParts, heldStatus } from "@/lib/update-words";
import { loadUpdates, shouldCommitUpdatesRead, subscribeUpdates, updatesGeneration, type UpdatesView } from "@/lib/updates-client";
import { LINK } from "@/lib/ui-classes";

const REFRESH_MS = 5 * 60 * 1000;

export function UpdateBannerView({ view, now, busy = false, message = null, onHold = () => {} }: {
  view: Pick<UpdatesView, "pending" | "hold" | "canHold"> | null; now: Date;
  busy?: boolean; message?: string | null; onHold?: (held: boolean) => void;
}) {
  const pending = view?.pending;
  if (!view || !pending || !pending.databaseChanges || pending.state === "manual") return null;
  const held = view.hold?.held === true || pending.state === "held";
  const parts = bannerParts(pending, now, held);
  const status = heldStatus(pending, view.hold);
  return (
    <div role="region" aria-label="Update notice" className="border-b border-line bg-accent-50 px-4 py-2 text-sm text-ink-800">
      <p><strong>{parts.headline}</strong>{parts.installs ? ` ${parts.installs}` : ""}</p>
      {parts.sections.map((s) => (
        <p key={s.label}><strong>{s.label}</strong> {renderInline(s.text)}</p>
      ))}
      <div className="mt-1 flex flex-wrap items-center gap-3">
        {held && status && <span>{status}</span>}
        <HoldControl hold={view.hold} canHold={view.canHold} busy={busy} message={message} onHold={onHold} />
        <Link href="/admin/system" className={LINK}>Read the release notes</Link>
      </div>
    </div>
  );
}

export function UpdateBanner() {
  const pathname = usePathname();
  const [view, setView] = useState<UpdatesView | null>(null);
  const [nonce, setNonce] = useState(0);
  const fetchedAt = useRef(0);
  const action = useHoldAction();
  useEffect(() => subscribeUpdates(() => { fetchedAt.current = 0; setNonce((n) => n + 1); }), []);
  useEffect(() => {
    if (pathname === "/login") { setView(null); fetchedAt.current = 0; return; }
    if (Date.now() - fetchedAt.current < REFRESH_MS) return;
    let live = true;
    const started = updatesGeneration();
    // A read an invalidation overtook is stale: committing it would restore the old hold state and a
    // fresh fetchedAt that throttles the refetch the invalidation asked for.
    loadUpdates().then((v) => {
      if (!shouldCommitUpdatesRead(started, updatesGeneration(), !live)) return;
      fetchedAt.current = Date.now();
      setView(v);
    }).catch(() => { if (shouldCommitUpdatesRead(started, updatesGeneration(), !live)) setView(null); });
    return () => { live = false; };
  }, [pathname, nonce]);
  // The System page draws its own copy of the notice and the Hold control.
  if (pathname?.startsWith("/admin/system")) return null;
  return <UpdateBannerView view={view} now={new Date()} busy={action.busy} message={action.message} onHold={(h) => { void action.run(h); }} />;
}
