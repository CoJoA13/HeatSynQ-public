// One flight for concurrent readers under one read authorization (#608, 2026-10-22 review).
//
// Every bulk grid runs its own recovery read once its binding and identity are ready, so the
// hub's eight grids sent eight order GETs, eight /me and eight pick-list reads on one mount, each
// paying the server's session prelude. The draft-recovery design wants a fresh AUTHORIZED read per
// adapter and allows sharing unchanged data where safe: a read begun while another is in flight
// under the same read-authorization ticket is that same fresh authorized read, so it joins it. This
// is not a cache. A settled flight is forgotten at once, a flight begun under a ticket that is no
// longer authorized (an identity check has started since) is never joined, and while no ticket is
// held nothing is shared. Each grid still checks its own ticket when the read lands
// (bulk-grid.ts's `retryRead`), so a joiner cannot adopt an answer its ticket does not cover.
// A MUTATION is a boundary too (Codex on #738): a save does not retire the session's ticket, so a
// flight begun before the save could otherwise serve the saving grid's post-acknowledgement refresh
// a pre-save record; each source calls `retire()` as its `begin()` runs, so a read asked for after
// the dispatch starts its own flight.
//
// Client-safe leaf: no React, no `src/server` import; tests/bulk-read-share.test.ts runs it over a
// fake authorization. `readAuthorizationTicket()` answers a new object per call, so a flight is
// matched by `isReadAuthorized(flight.ticket)`, never by ticket identity.
import { getBrowserDraftSession } from "./draft-session";

export type ReadAuthorization = {
  /** The current read-authorization ticket, or null while identity is unresolved. */
  ticket(): object | null;
  /** Whether a ticket taken earlier still authorizes a read now. */
  authorized(ticket: object): boolean;
};

/** The browser session's authorization; shares nothing where no session holds one (server rendering,
 *  and a test whose session stub carries no ticket). */
export function sessionReadAuthorization(): ReadAuthorization {
  return {
    ticket() {
      const session = getBrowserDraftSession();
      return typeof session?.readAuthorizationTicket === "function" ? session.readAuthorizationTicket() : null;
    },
    authorized(ticket) {
      const session = getBrowserDraftSession();
      return typeof session?.isReadAuthorized === "function" && session.isReadAuthorized(ticket as Parameters<typeof session.isReadAuthorized>[0]);
    },
  };
}

export type SharedRead<T> = {
  /** A read: joins the flight out under a still-authorized ticket, or starts one. */
  read(): Promise<T>;
  /** Forgets the flight out now, so the next read starts its own; the flight itself still answers
   *  the readers that joined it. Called at every mutation boundary (`begin()`). */
  retire(): void;
};

/** Wraps `read` so a call made while an earlier call's flight is still out, under a ticket that is
 *  still authorized and not retired, answers that flight's promise. */
export function shareInFlight<T>(auth: ReadAuthorization, read: () => Promise<T>): SharedRead<T> {
  let inflight: { ticket: object; promise: Promise<T> } | null = null;
  return {
    read() {
      if (inflight !== null && auth.authorized(inflight.ticket)) return inflight.promise;
      const promise = read();
      const ticket = auth.ticket();
      if (ticket === null) return promise;
      const flight = { ticket, promise };
      inflight = flight;
      const forget = () => { if (inflight === flight) inflight = null; };
      promise.then(forget, forget);
      return promise;
    },
    retire() { inflight = null; },
  };
}
