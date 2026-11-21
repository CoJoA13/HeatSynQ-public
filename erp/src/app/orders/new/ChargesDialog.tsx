"use client";
// New order's charges editor in a dialog (PR 2; owner ruling 2026-10-31, #817: "Additional charges"
// → a "Review extra charges" button). Opened NON-modally (`show()`, never `showModal()`): the
// sticky header's Save & Print, Save only and the refusal banner's Review button stay live while
// the dialog is open, which the flows rely on after a refused charge box opens it. The element
// follows `open` the ProcessPreviewDialog way: never a second `show()` on an open element (the
// app router runs effects twice in development), never a `close()` from a cleanup. It is fixed in
// the viewport, so the page cannot scroll it: its height is bound to the viewport (`top-24` is 6rem,
// one rem kept below) and it scrolls inside itself, or the last rows and Done fell off a short
// screen (Codex on #833).
import { useEffect, useRef, type ReactNode } from "react";
import { BUTTON_NEUTRAL, CARD } from "@/lib/ui-classes";

/** The element follows `open`: shown once while closed, closed once while open. */
export function followOpen(open: boolean, el: { open: boolean; show: () => void; close: () => void } | null): void {
  if (!el) return;
  if (open && !el.open) el.show();
  else if (!open && el.open) el.close();
}

export function ChargesDialog({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement | null>(null);
  useEffect(() => { followOpen(open, ref.current); }, [open]);
  return (
    <dialog ref={ref} aria-label="Extra charges" onClose={() => onClose()}
            className={`${CARD} fixed inset-x-4 top-24 z-30 mx-auto max-h-[calc(100dvh-7rem)] w-[min(96vw,40rem)] overflow-y-auto shadow-xl`}>
      <h2 className="mb-3 text-lg font-semibold">Extra charges</h2>
      {children}
      <div className="mt-4 flex justify-end">
        <button type="button" onClick={onClose} className={BUTTON_NEUTRAL}>Done</button>
      </div>
    </dialog>
  );
}
