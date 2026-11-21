import { createDraftStore, type DraftStore, type DraftSummary, type EditorKey } from "./draft-store";
import { subscribeUnsaved, unsavedCount } from "./unsaved-guard";

export const EMPTY_DRAFT_SUMMARY: DraftSummary = Object.freeze({ owner: null, identityReady: false, count: 0, rows: Object.freeze([]) });
type RequestTicket = Readonly<{ generation: number }>;
type ReadAuthorizationTicket = Readonly<{ generation: number; identitySequence: number }>;
export type IdentityResult<T> = { kind: "ready"; data: T } | { kind: "retry" | "expired" | "stale" };
/** Pure lifecycle seam: transports are supplied by the browser and tests. */
export function createDraftSession(store: DraftStore) {
  let generation = 0;
  let identitySequence = 0;
  let observedUser = store.getSnapshot().owner?.userId;
  let selection: EditorKey | null = null;
  let selectionRevision = 0;
  const selectionListeners = new Set<() => void>();
  const unauthorizedListeners = new Set<() => void>();
  function selectionChanged() { selectionRevision++; for (const listener of selectionListeners) listener(); }
  const requestTicket = (): RequestTicket => ({ generation });
  const isCurrent = (ticket: RequestTicket) => ticket.generation === generation;
  function reset() { generation++; identitySequence++; selection = null; observedUser = undefined; store.resetIdentity(); selectionChanged(); }
  return {
    store, requestTicket, isCurrent,
    subscribeSelection(listener: () => void) { selectionListeners.add(listener); return () => { selectionListeners.delete(listener); }; },
    getSelectionRevision: () => selectionRevision,
    // Read authorization expires at EVERY identity check, even a same-user check.
    // Transport tickets deliberately retain their separate generation-only semantics.
    getReadAuthorizationRevision: () => identitySequence,
    readAuthorizationTicket(): ReadAuthorizationTicket | null {
      return store.getSnapshot().identityReady ? { generation, identitySequence } : null;
    },
    isReadAuthorized(ticket: ReadAuthorizationTicket | null): boolean {
      return ticket !== null && store.getSnapshot().identityReady &&
        ticket.generation === generation && ticket.identitySequence === identitySequence;
    },
    loginSucceeded: reset,
    async validateIdentity<T extends { id: string }>(read: () => Promise<T>): Promise<IdentityResult<T>> {
      const sequence = ++identitySequence;
      const epoch = generation;
      const check = store.beginIdentityCheck();
      try {
        const data = await read();
        if (epoch !== generation || sequence !== identitySequence) return { kind: "stale" };
        const previous = observedUser;
        const owner = store.acceptIdentity(check, data.id);
        if (!owner) return { kind: "stale" };
        if (previous !== undefined && previous !== data.id) { generation++; selection = null; selectionChanged(); }
        observedUser = data.id;
        return { kind: "ready", data };
      } catch (error) {
        if (epoch !== generation || sequence !== identitySequence) return { kind: "stale" };
        const expired = typeof error === "object" && error !== null && "status" in error && error.status === 401;
        store.identityCheckFailed(check, expired);
        if (expired) { generation++; selection = null; observedUser = undefined; selectionChanged(); }
        return { kind: expired ? "expired" : "retry" };
      }
    },
    async logout(send: () => Promise<unknown>): Promise<boolean> {
      const ticket = requestTicket();
      try { await send(); }
      catch (error) {
        if (!isCurrent(ticket)) return false;
        throw error;
      }
      if (!isCurrent(ticket)) return false;
      reset(); return true;
    },
    // Told only after a current 401 has reset identity, so a check started here runs in the new
    // generation. The Shell re-runs its identity check: the only route from expiry to /login (#332).
    subscribeUnauthorized(listener: () => void) { unauthorizedListeners.add(listener); return () => { unauthorizedListeners.delete(listener); }; },
    observeUnauthorized(ticket: RequestTicket, path: string) {
      // Auth endpoints own their explicit lifecycle. A bad password is not expired identity;
      // /me needs its latest-read gate, and failed logout must preserve this document's data.
      if (path.split("?")[0].startsWith("/api/auth/")) return;
      if (!path.startsWith("/api/") || !isCurrent(ticket)) return;
      reset();
      for (const listener of [...unauthorizedListeners]) listener();
    },
    select(key: EditorKey): boolean {
      const summary = store.getSnapshot();
      if (!summary.identityReady || !summary.rows.some(row => sameEditor(row.key, key))) return false;
      selection = key; selectionChanged(); return true;
    },
    consumeSelection(key: EditorKey): boolean {
      if (!selection || !store.getSnapshot().identityReady || !sameEditor(selection, key)) return false;
      selection = null; selectionChanged(); return true;
    },
  };
}
function sameEditor(a: EditorKey, b: EditorKey) {
  return a.owner.userId === b.owner.userId && a.owner.authGeneration === b.owner.authGeneration &&
    a.record.kind === b.record.kind && a.record.id === b.record.id && a.editor === b.editor &&
    a.childId === b.childId && a.entityVersion === b.entityVersion;
}
/** The session holding screen's status. It names hidden drafts only while some are retained:
 *  a 401 purges them before the check it starts can fail (#332). */
export function sessionCheckStatus(failed: boolean, drafts: Pick<DraftSummary, "count">): string {
  if (!failed) return "Confirming your session…";
  return drafts.count > 0
    ? "Could not confirm your session. Your retained drafts are hidden. Please retry."
    : "Could not confirm your session. Please retry.";
}
export type DraftSession = ReturnType<typeof createDraftSession>;
let browserSession: DraftSession | null = null;
/** Call from a browser event/load callback or committed effect, never render. */
export function getBrowserDraftSession(): DraftSession | null {
  if (typeof window === "undefined") return null;
  if (!browserSession) {
    browserSession = createDraftSession(createDraftStore());
    installDraftUnload(browserSession.store, window);
  }
  return browserSession;
}
export function getBrowserDraftStore(): DraftStore | null { return getBrowserDraftSession()?.store ?? null; }
/** Observation only: safe for useSyncExternalStore and render; does not initialize. */
export function peekBrowserDraftSession(): DraftSession | null { return browserSession; }

export function installDraftUnload(store: DraftStore, target: Pick<Window, "addEventListener" | "removeEventListener">): () => void {
  let armed = false;
  const dirty = () => store.getSnapshot().count > 0 || unsavedCount() > 0;
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!dirty()) return;
    event.preventDefault(); event.returnValue = "";
  };
  const update = () => {
    const next = dirty();
    if (next === armed) return;
    armed = next;
    if (armed) target.addEventListener("beforeunload", beforeUnload);
    else target.removeEventListener("beforeunload", beforeUnload);
  };
  const offStore = store.subscribe(update); const offLegacy = subscribeUnsaved(update);
  update();
  return () => { offStore(); offLegacy(); if (armed) target.removeEventListener("beforeunload", beforeUnload); };
}
