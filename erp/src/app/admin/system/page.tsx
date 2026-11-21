"use client";
// Admin > System (release-updates PR 3, Task 3.4; spec §6): the running version, the pending one and
// the hold, read-only apart from Hold. Reads through src/lib/updates-client.ts, as the banner does.
import { useEffect, useState } from "react";
import { usePermissions } from "@/lib/use-permissions";
import { gate } from "@/lib/permission-ui";
import { AtAGlance } from "@/components/AtAGlance";
import { PageHeader } from "@/components/PageHeader";
import { HoldControl, useHoldAction } from "@/components/UpdateHoldControl";
import { renderInline, renderNotes } from "@/lib/release-notes-render";
import { bannerParts, emptyLine, heldLine, holdOffered, installsRow, pendingBlock, pendingCard } from "@/lib/update-words";
import { loadUpdates, shouldCommitUpdatesRead, subscribeUpdates, updatesGeneration, type UpdatesView } from "@/lib/updates-client";
import { CARD, NOTICE } from "@/lib/ui-classes";

export default function SystemPage() {
  const [view, setView] = useState<UpdatesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const action = useHoldAction();
  const { permissions, error: permError } = usePermissions();
  useEffect(() => subscribeUpdates(() => setNonce((n) => n + 1)), []);
  useEffect(() => {
    let live = true;
    const started = updatesGeneration();
    loadUpdates().then((v) => { if (shouldCommitUpdatesRead(started, updatesGeneration(), !live)) { setView(v); setError(null); } })
      .catch((e: Error) => { if (shouldCommitUpdatesRead(started, updatesGeneration(), !live)) setError(e.message); });
    return () => { live = false; };
  }, [nonce]);

  const pending = view?.pending ?? null;
  const empty = emptyLine({
    viewLoaded: view !== null, permsLoaded: permissions !== undefined, permsFailed: permError !== null,
    canView: gate(permissions, "admin.view").allowed, running: view?.running ?? null,
  });
  const card = pending ? pendingCard(pending, view?.hold ?? null, new Date()) : null;
  // Release hold is offered whenever a hold stands, whatever the pending release now is.
  const showControl = holdOffered(pending, view?.hold ?? null);
  const block = pending ? pendingBlock(pending, view?.pendingNote ?? null) : null;
  const installs = installsRow(pending, view?.hold ?? null, new Date());
  const unanswered = view === null || view.hold === null;
  const holdText = unanswered ? "—" : view.hold!.held ? heldLine(view.hold!) : "Not held";
  return (
    <div className="p-6">
      <PageHeader title="System" subtitle="The running version, the update waiting to install and its hold." />
      {error && <p className={`${NOTICE.refusal} mb-3`}>{error}</p>}
      {permError && <p className={`${NOTICE.refusal} mb-3`}>{permError}</p>}
      <div className="flex flex-col gap-4 min-[1360px]:flex-row">
        <div className={`${CARD} min-w-0 flex-1`}>
          <h2 className="text-[17px] font-semibold text-ink-800">{pending ? `Pending update ${pending.version}` : "Pending update"}</h2>
          {pending ? (
            <>
              <p className="my-2 text-sm text-ink-800">
                <strong>{card?.headline}</strong>{card?.detail ? ` ${card.detail}` : ""}
              </p>
              {block === "note" && view?.pendingNote && renderNotes(view.pendingNote.body)}
              {block === "wording" && bannerParts(pending, new Date(), view?.hold?.held === true).sections.map((sec) => (
                <p key={sec.label} className="my-2 text-sm text-ink-800"><strong>{sec.label}</strong> {renderInline(sec.text)}</p>
              ))}
            </>
          ) : empty !== null && <p className="text-sm text-ink-500">{empty}</p>}
        </div>
        <AtAGlance title="Updates" rows={[
          { label: "Running", value: view?.running ?? "—" },
          { label: "Pending", value: unanswered ? "—" : pending ? pending.version : "None" },
          { label: "Installs", value: installs },
          { label: "Hold", value: holdText },
        ]}>
          {showControl && (
            <div className="mt-3">
              <HoldControl hold={view?.hold ?? null} canHold={view?.canHold === true} busy={action.busy} message={action.message}
                           onHold={(h) => { void action.run(h); }} />
            </div>
          )}
        </AtAGlance>
      </div>
    </div>
  );
}
