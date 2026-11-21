"use client";
// The one modal (spec 2026-10-30-ux-redesign-design.md §4.3; owner ruling 5 of 2026-10-30), mounted
// once in Shell. It renders whatever src/lib/modal.ts holds as the current request in a native
// <dialog>, the ProcessPreviewDialog precedent: `showModal()` only while not already open and
// `close()` only while open, since the app router runs effects twice in development and a second
// `showModal()` throws. Escape closes the dialog natively; its `close` event answers the request
// as a cancel, so a caller's null check or false branch runs exactly as it does for `prompt()`.
//
// A reason request shows the leaf's question as the title and its "Reason for <verb>…" line as the
// box's label; a blank answer keeps the dialog open and shows the caller's own refusal sentence
// (the leaf marks the request `blank`). Enter in the box submits. No request is sent from here:
// the caller does its own work with the answer, so the message-slot and write sweeps see nothing.
// A password request hands the typed text to the caller's own `submit` (`sendPassword`), empties
// the box on each send, and shows what the caller answered under it.
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { answerModal, currentModal, makeCloseTracker, sendPassword, subscribeModal, type ModalRequest } from "@/lib/modal";
import { BUTTON_DANGER_FILL, BUTTON_NEUTRAL, BUTTON_PRIMARY, INPUT, LABEL, NOTICE } from "@/lib/ui-classes";

export function ModalHost() {
  const request = useSyncExternalStore(subscribeModal, currentModal, currentModal);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const tracker = useRef(makeCloseTracker());
  const titleId = useId();
  const id = request?.id ?? null;
  // Keyed on the request's ID, not on open/closed: when the user closes request A natively
  // (Escape) while B is queued, A is answered and B becomes current with the dialog closed, so the
  // host must re-open for B; keyed on `open` alone it would not re-run and B would sit invisible.
  useEffect(() => {
    const el = dialogRef.current; if (!el) return;
    if (id !== null && !el.open) el.showModal();
    else if (id === null && el.open) { tracker.current.beginHostClose(); el.close(); }
  }, [id]);
  return (
    <dialog ref={dialogRef} aria-labelledby={request ? titleId : undefined}
            onClose={() => {
              // A close the host made itself answers nothing (its event may fire after the next
              // request is already showing); a user's close (Escape) cancels the current request.
              if (!tracker.current.onClose()) return;
              if (request) answerModal(request.id, request.kind === "confirm" ? false : null);
            }}
            className="m-auto w-[min(96vw,600px)] max-w-none rounded-lg border border-line bg-surface-0 p-8 text-ink-800 shadow-[0_16px_16px_rgba(12,12,13,.10),0_4px_2px_rgba(12,12,13,.05)] backdrop:bg-ink-900/50">
      {request && <Body key={request.id} request={request} titleId={titleId} />}
    </dialog>
  );
}

function Body({ request, titleId }: { request: ModalRequest; titleId: string }) {
  const [reason, setReason] = useState("");
  const boxId = useId();
  const cancel = () => answerModal(request.id, request.kind === "confirm" ? false : null);
  const submit = () => {
    if (request.kind !== "password") { answerModal(request.id, request.kind === "confirm" ? true : reason); return; }
    if (request.sending) return;
    setReason("");
    void sendPassword(request.id, reason);
  };
  const password = request.kind === "password";
  const refusal = request.kind === "reason" ? (request.blank ? request.blankRefusal : null)
    : request.kind === "password" ? request.refusal : null;
  const sending = request.kind === "password" && request.sending;
  // The button a click sent from is closed during the send, which leaves the cursor nowhere, so a
  // refused password hands it back to the box. A send clears `refusal`, so a repeat runs this again.
  const box = useRef<HTMLInputElement | null>(null);
  const refusedPassword = request.kind === "password" ? request.refusal : null;
  useEffect(() => { if (refusedPassword !== null) box.current?.focus(); }, [refusedPassword]);
  return (
    <div className="flex flex-col gap-4">
      <h2 id={titleId} className="text-2xl font-semibold leading-snug">{request.title}</h2>
      {request.kind === "confirm"
        ? request.body !== "" && <p className="whitespace-pre-line text-sm text-ink-500">{request.body}</p>
        : <div>
            <label htmlFor={boxId} className={LABEL}>{request.kind === "password" ? request.label : request.body}</label>
            <input ref={box} id={boxId} type={password ? "password" : "text"} autoComplete={password ? "new-password" : undefined}
                   value={reason} autoFocus aria-invalid={refusal !== null}
                   onChange={(e) => setReason(e.target.value)}
                   onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
                   className={`${INPUT} mt-1 w-full`} />
            {refusal !== null && <div role="alert" className={`${NOTICE.refusal} mt-2`}>{refusal}</div>}
          </div>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={cancel} className={BUTTON_NEUTRAL}>Cancel</button>
        <button type="button" onClick={submit} disabled={sending}
                className={request.kind === "confirm" && request.danger ? BUTTON_DANGER_FILL : BUTTON_PRIMARY}>
          {request.kind === "reason" ? "Continue" : request.confirm}
        </button>
      </div>
    </div>
  );
}
