"use client";
// What's new (release-updates PR 3, Task 3.4; spec §6): once after an update, every release's notes
// since the one this user last saw, newest first. A non-modal <dialog> (the ChargesDialog shape), so
// it never blocks the page. It is marked seen only by the "Got it" click, never from an effect.
import { useEffect, useRef, useState } from "react";
import { PanelMessage } from "./PanelMessage";
import { renderNotes } from "@/lib/release-notes-render";
import { installedNoteBody } from "@/lib/update-words";
import { oneShotHold } from "@/lib/single-flight";
import { BUTTON_PRIMARY, CARD } from "@/lib/ui-classes";
import { loadUpdates, sendSeen, type UpdateNote } from "@/lib/updates-client";

export function WhatsNewView({ notes, busy = false, message = null, onGotIt = () => {} }: {
  notes: UpdateNote[]; busy?: boolean; message?: string | null; onGotIt?: () => void;
}) {
  if (notes.length === 0) return null;
  return (
    <>
      <h2 className="mb-3 text-lg font-semibold">What&apos;s new</h2>
      {notes.map((n) => (
        <section key={n.version} aria-label={`Version ${n.version}`}>
          <h3 className="mt-3 text-base font-semibold">HeatSynQ {n.version}</h3>
          {renderNotes(installedNoteBody(n))}
        </section>
      ))}
      <div className="mt-4 flex items-center justify-end gap-3">
        <PanelMessage message={message} />
        <button type="button" disabled={busy} onClick={onGotIt} className={BUTTON_PRIMARY}>Got it</button>
      </div>
    </>
  );
}

export function WhatsNewDialog() {
  const [notes, setNotes] = useState<UpdateNote[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [hold] = useState(() => oneShotHold(setBusy));
  const ref = useRef<HTMLDialogElement | null>(null);
  // Read once per page load; the Shell mounts this once per signed-in tree.
  useEffect(() => {
    let live = true;
    loadUpdates().then((v) => { if (live && v.whatsNew.length > 0) { setNotes(v.whatsNew); setOpen(true); } }).catch(() => {});
    return () => { live = false; };
  }, []);
  // The `open` property, never show(): show() runs the dialog focusing steps and would pull focus
  // onto "Got it", blurring a box mid-edit (firing its save) or letting Enter mark the notes seen.
  useEffect(() => { if (ref.current) ref.current.open = open; }, [open, notes]);
  const gotIt = () =>
    hold.run(async () => {
      setMessage(null);
      try { await sendSeen(notes); setOpen(false); } catch (e) { setMessage((e as Error).message); }
    });
  if (notes.length === 0) return null;
  return (
    <dialog ref={ref} aria-label="What's new" onClose={() => setOpen(false)}
            className={`${CARD} fixed inset-x-4 top-24 z-30 mx-auto max-h-[calc(100dvh-7rem)] w-[min(96vw,40rem)] overflow-y-auto shadow-xl`}>
      <WhatsNewView notes={notes} busy={busy} message={message} onGotIt={() => { void gotIt(); }} />
    </dialog>
  );
}
