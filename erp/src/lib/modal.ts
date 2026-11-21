// The one modal's leaf (spec 2026-10-30-ux-redesign-design.md §4.3; owner ruling 5 of 2026-10-30):
// every in-page confirmation and every reason dialog asks through here, and ModalHost
// (src/components/ModalHost.tsx, mounted once in Shell) renders the current request in a native
// <dialog>. A queue, so two asks raised at once show one after the other and neither is lost.
//
// The reason form keeps `reasonPromptText`'s words: its title is the question and its body the
// line that names what the answer is for, split at the leaf's blank line (`splitReasonText`). A
// blank reason does not resolve: the request is marked `blank` and the host shows the caller's own
// refusal sentence under the box, so where a refusal is worded stays the caller's (ruling R1).
// Cancel resolves `null`, exactly as `prompt()` does, so every caller keeps its
// `if (reason === null) return`. `confirmDiscard` (use-unsaved-section.ts) stays synchronous and
// native for the Shell's navigation guard; `askDiscard` beside it is this modal's form.
//
// The password form (Set password, PR 12, #827) stays open across the caller's write: `submit` is
// the caller's, so the write stays under `api()` in its page, and it answers null when the write
// landed or the sentence to show under the box. Cancelling while it is out answers the caller
// false; the write cannot be unsent, and its landing then touches nothing here.
//
// Client-safe; imports the reason leaf only.
import { reasonPromptText } from "./reason-prompt";

export type ModalRequest =
  | { id: number; kind: "confirm"; title: string; body: string; confirm: string; danger: boolean }
  | { id: number; kind: "reason"; title: string; body: string; verb: string; blankRefusal: string; blank: boolean }
  | { id: number; kind: "password"; title: string; label: string; confirm: string; refusal: string | null; sending: boolean };

type Pending =
  | { kind: "confirm"; request: Extract<ModalRequest, { kind: "confirm" }>; resolve: (v: boolean) => void }
  | { kind: "reason"; request: Extract<ModalRequest, { kind: "reason" }>; resolve: (v: string | null) => void }
  | { kind: "password"; request: Extract<ModalRequest, { kind: "password" }>; submit: (password: string) => Promise<string | null>; resolve: (v: boolean) => void };

let queue: Pending[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const notify = (): void => { for (const l of listeners) l(); };

/** `reasonPromptText`'s text split at its blank line: the question, then the box's label. */
export function splitReasonText(text: string): { title: string; body: string } {
  const at = text.indexOf("\n\n");
  return at === -1 ? { title: text, body: "" } : { title: text.slice(0, at), body: text.slice(at + 2) };
}

export function askConfirm(q: { title: string; body: string; confirm: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    queue.push({ kind: "confirm", request: { id: nextId++, kind: "confirm", title: q.title, body: q.body, confirm: q.confirm, danger: q.danger ?? false }, resolve });
    notify();
  });
}

export function askReason(q: { question: string; verb: string; blankRefusal: string }): Promise<string | null> {
  const { title, body } = splitReasonText(reasonPromptText(q.question, q.verb));
  return new Promise((resolve) => {
    queue.push({ kind: "reason", request: { id: nextId++, kind: "reason", title, body, verb: q.verb, blankRefusal: q.blankRefusal, blank: false }, resolve });
    notify();
  });
}

/** True once `submit` answered null; false on Cancel or Escape. `submit` never rejects. */
export function askPassword(q: { title: string; label: string; confirm: string; submit: (password: string) => Promise<string | null> }): Promise<boolean> {
  return new Promise((resolve) => {
    queue.push({ kind: "password", request: { id: nextId++, kind: "password", title: q.title, label: q.label, confirm: q.confirm, refusal: null, sending: false }, submit: q.submit, resolve });
    notify();
  });
}

/** The host's Set password click: one send at a time, under the current request only. */
export async function sendPassword(id: number, password: string): Promise<void> {
  const head = queue[0];
  if (!head || head.kind !== "password" || head.request.id !== id || head.request.sending) return;
  head.request = { ...head.request, sending: true, refusal: null };
  notify();
  const refusal = await head.submit(password);
  if (queue[0] !== head) return; // cancelled while it was out
  if (refusal === null) {
    queue.shift();
    head.resolve(true);
  } else {
    head.request = { ...head.request, sending: false, refusal };
  }
  notify();
}

/** The request the host shows: the oldest unanswered one, or null. */
export function currentModal(): ModalRequest | null {
  return queue[0]?.request ?? null;
}

export function subscribeModal(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The host's answer. An id that is not current is ignored. For a reason request, a blank string
 *  holds the dialog open and marks it; `null` cancels; a non-blank string resolves. A password
 *  request takes only the cancel: its landing is `sendPassword`'s. */
export function answerModal(id: number, value: boolean | string | null): void {
  const head = queue[0];
  if (!head || head.request.id !== id) return;
  if (head.kind === "confirm") {
    queue.shift();
    head.resolve(value === true);
  } else if (head.kind === "password") {
    queue.shift();
    head.resolve(false);
  } else {
    if (typeof value === "string" && value.trim() === "") {
      head.request = { ...head.request, blank: true };
      notify();
      return;
    }
    queue.shift();
    head.resolve(typeof value === "string" ? value : null);
  }
  notify();
}

/**
 * The host's record of its OWN `close()` calls. A native <dialog> queues its `close` event as a
 * task, so a close the host called when the queue emptied can fire after the caller's continuation
 * has already asked the next question and the host has re-opened; that stale event must answer
 * nothing. Each host-initiated close yields exactly one event: `beginHostClose` counts one,
 * `onClose` consumes one and answers `false` (not the user's), or `true` for a close the user made
 * (Escape), which the host then answers as a cancel.
 */
export function makeCloseTracker(): { beginHostClose: () => void; onClose: () => boolean } {
  let pending = 0;
  return {
    beginHostClose: () => { pending += 1; },
    onClose: () => { if (pending > 0) { pending -= 1; return false; } return true; },
  };
}

/** Tests only: drop every queued request without resolving it. */
export function _resetModalsForTests(): void {
  queue = [];
  notify();
}
