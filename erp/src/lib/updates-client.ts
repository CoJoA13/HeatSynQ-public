// The one client read of GET /api/updates (ruling P9): the banner, the What's new dialog and the
// System page all read through it, and callers that ask while a GET is out share that GET. `invalidateUpdates()` tells every subscriber to read again; call it after
// a hold, a lift or a seen lands. Client-safe: no server import, the shapes are restated.
import { api } from "./fetcher";

export type UpdateNote = { version: string; publishedAt: string; databaseChanges: boolean; body: string };
export type UpdatePending = {
  version: string; publishedAt: string; firstSeenAt: string; databaseChanges: boolean;
  installAfter: string; state: "scheduled" | "held" | "manual"; reason: string | null;
};
export type UpdateHoldState = { held: boolean; fromVersion: string | null; by: string | null; at: string | null };
export type UpdatesView = {
  running: string | null; whatsNew: UpdateNote[]; pending: UpdatePending | null; pendingNote: UpdateNote | null;
  hold: UpdateHoldState | null; canHold: boolean;
};

let inFlight: Promise<UpdatesView> | null = null;

/** The current answer; a call made while a read is out joins it. */
export function loadUpdates(): Promise<UpdatesView> {
  if (inFlight) return inFlight;
  const flight: Promise<UpdatesView> = api<UpdatesView>("/api/updates").finally(() => {
    if (inFlight === flight) inFlight = null;
  });
  inFlight = flight;
  return flight;
}

const listeners = new Set<() => void>();
/** Calls `fn` on every invalidation; returns the unsubscribe. */
export function subscribeUpdates(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
// Bumped SYNCHRONOUSLY by every invalidation, so a read that resolves after one it predates can tell,
// before React has processed any state update (the BackupBanner's shouldCommitBannerFetch shape).
let generation = 0;
export const updatesGeneration = (): number => generation;
/** Whether a read started at `started` may be committed: not cancelled, and no invalidation since. */
export function shouldCommitUpdatesRead(started: number, current: number, cancelled: boolean): boolean {
  return !cancelled && started === current;
}
export function invalidateUpdates(): void {
  generation += 1;
  // A read sent before the write must not be joined by the read that follows it (#608).
  inFlight = null;
  for (const fn of [...listeners]) fn();
}

/** Hold (or lift) the pending database update; the server's own sentence is the refusal. */
export async function sendHold(held: boolean): Promise<UpdateHoldState> {
  const answer = await api<UpdateHoldState>("/api/updates/hold", { method: "POST", body: JSON.stringify({ held }) });
  invalidateUpdates();
  return answer;
}

/** Mark the newest listed note seen for this user. */
export async function sendSeen(notes: readonly UpdateNote[]): Promise<void> {
  if (notes.length === 0) return;
  await api("/api/updates/seen", { method: "POST", body: JSON.stringify({ version: notes[0].version }) });
  invalidateUpdates();
}
