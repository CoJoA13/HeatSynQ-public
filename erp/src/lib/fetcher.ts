import { getBrowserDraftSession } from "./draft-session";
import { beginWrite, isWriteMethod } from "./in-flight-writes";

/** Thrown by `api()` on a non-OK response. Carries the HTTP status alongside the server's own
 *  error message, so a caller can tell a specific, expected refusal (e.g. the reference-delete
 *  guard's 400 "still in use by N records") apart from a 500 or a network failure — a plain
 *  `Error` loses the status the moment it's thrown. */
export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/** Thrown by `api()` when the server answered 2xx and the body could not be read: empty, cut short,
 *  the connection lost after the headers, or not JSON (#547, owner ruling 2026-10-18). Nothing sits
 *  between the operators' browsers and an install, so a 2xx proves a write committed: a write's
 *  message takes that reading (`WRITE_ANSWER_UNREADABLE`), and a read's says only that the answer
 *  was lost (`READ_ANSWER_UNREADABLE`). The read's own error is `cause`.
 *
 *  It is never an `ApiError`, and it carries NO `status` key, so that every caller takes its
 *  existing no-answer path (the ruling's words). Many settle classifiers read an `ApiError` whose
 *  status is below 500 as a refusal that wrote nothing, so a 2xx carried as one would read a
 *  committed write as refused. Some callers duck-type the key without asking for the class, to tell
 *  a refusal (400 to 499), an expired session (401) or a conflict (409), and a `status` key of any
 *  value would put this error within their reach. A diagnostic code, if one is ever wanted, goes
 *  under another name.
 *
 *  The reading rests on no route that `api()` reaches answering 2xx with no body on purpose;
 *  `tests/api-answer-body-sweep.test.ts` holds that, from each reached handler's checked return type
 *  (#569). */
export class UnreadableAnswerError extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = "UnreadableAnswerError";
  }
}

/** The owner's sentences for `UnreadableAnswerError` (2026-10-18), chosen by method: a write
 *  (POST, PUT, PATCH, DELETE) committed, and a read only lost its answer. */
export const WRITE_ANSWER_UNREADABLE = "The change was saved, but the answer could not be read. Reload the page to see it.";
export const READ_ANSWER_UNREADABLE = "The answer could not be read. Reload the page to try again.";

/**
 * `fetch`, with every WRITE counted while it is in flight (#276).
 *
 * The count is what lets the unsaved-edit guard tell the truth: during a save the editing section
 * is still registered dirty (its flag clears only after the response lands), and without this the
 * navigation prompt offered to discard changes that were committing regardless. See
 * `in-flight-writes.ts` for why this is counted centrally rather than registered per save.
 *
 * Exported because `api()` does not serve every caller: a print streams a `Blob` and reads
 * `x-document-id` off the headers, and the signature and logo uploads send `FormData` and read the
 * raw `Response` themselves (the attachments upload sends its `FormData` through `api()`, with
 * `headers: {}`). Those callers use this instead of bare `fetch`, and
 * `tests/unsaved-registration-sweep.test.ts` refuses a bare `fetch` write anywhere under `src/`
 * except `src/server`, `src/app/api` and this file, so the count cannot quietly stop being complete.
 *
 * The counter is released in a `finally`, so a rejected request — a dropped connection, an aborted
 * navigation — releases it exactly like a resolved one.
 *
 * **The `await` on the next line is load-bearing.** Without it the promise is returned rather than
 * awaited, the `finally` runs at request-ISSUE time, and the count is raised for zero async ticks —
 * so `confirmDiscard`, which reads it from a click handler while the response is still outstanding,
 * sees nothing in flight and the untruthful wording is back. It looks like the redundant
 * `return await` some lint rules flag; it is not. `tests/in-flight-writes.test.ts` reds if it goes.
 *
 * The window closes when the response HEADERS arrive, which is when the server has taken the write.
 * An editor that clears its dirty flag from a FOLLOW-UP GET rather than from this response is
 * therefore still briefly dirty-with-nothing-in-flight — see `in-flight-writes.ts` for the two that
 * do, recorded rather than papered over.
 */
export async function trackedFetch(path: string, init?: RequestInit): Promise<Response> {
  const session = getBrowserDraftSession();
  const ticket = session?.requestTicket();
  const endWrite = isWriteMethod(init?.method) ? beginWrite() : () => {};
  try {
    const response = await fetch(path, init);
    if (response.status === 401 && ticket) session?.observeUnauthorized(ticket, path);
    return response;
  } finally {
    endWrite();
  }
}

/**
 * A JSON request through `trackedFetch`. It ends one of four ways (#547, owner ruling 2026-10-18):
 *
 * - **Not OK:** an `ApiError` carrying the status and the server's own `error` sentence, or
 *   `Request failed (<status>)` when the body has none. This path reads the body as it always has.
 * - **OK, and the body read:** the parsed body, whatever it is. A readable `null`, `false`, `0` or
 *   `{}` is an answer: the test is whether the read threw, never what it returned.
 * - **OK, and the body could not be read:** an `UnreadableAnswerError`, whose message is the
 *   committed reading for a write (`isWriteMethod`) and the read sentence otherwise. Before #547 the
 *   body was read as `{}` on any failure, so an answer cut short resolved `{}`, and a page that
 *   rendered it went down.
 * - **The caller's own abort:** when `init.signal` is aborted as the read fails, the read's error
 *   passes through as it came, whatever it is (a DOMException named `AbortError`, or the reason the
 *   caller gave). The test is the signal, not the error's name: an AbortError the caller did not
 *   cause (a page unload, where "committed" is still the true reading for a write) takes the
 *   sentence. An abort before the headers rejects `fetch` itself and never reaches the read.
 *
 * **A census, not a guarantee.** As of `6e42469`, no route answers a 2xx with no body, and no `api()`
 * call reaches a route that answers a file (a print, an export, an attachment): those are read
 * without `api()`. Nothing enforces it: a route answering a 2xx that is not JSON, reached through
 * `api()`, would be rejected as unreadable on every call. A fail-closed census test is #569.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await trackedFetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError((body as { error?: string }).error ?? `Request failed (${res.status})`, res.status);
  }
  try {
    return (await res.json()) as T;
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    const sentence = isWriteMethod(init?.method) ? WRITE_ANSWER_UNREADABLE : READ_ANSWER_UNREADABLE;
    throw new UnreadableAnswerError(sentence, { cause: error });
  }
}
