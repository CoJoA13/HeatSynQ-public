// Client-safe: no src/server imports. What a read-backed list shows, decided once (P6 step 3; #632
// bug a, the #223 item 6 `loadedFor` form Statements carried alone).
//
// A list's state records WHICH key its rows were read for (`loadedFor`), not a boolean: a print
// bumps the list's refresh and reads it again under the same key, and a flag reset on that bump
// blanked the table to "Loading…" for a round trip after every print (the #223 review finding).
// So `loadedFor` is set by a read that lands and never cleared by one that fails or by a refresh;
// only a read for another key (Statements' customer) shows "Loading…" again until it lands.

export type ListStatus = "denied" | "error" | "loading" | "empty" | "rows";

export type ListState<T> = { rows: T[]; error: string | null; loadedFor: string | null };

export function emptyListState<T>(): ListState<T> {
  return { rows: [], error: null, loadedFor: null };
}

/** A current read for `key` landed: its rows, no error, and the key it was read for. */
export function landRows<T>(_state: ListState<T>, key: string, rows: T[]): ListState<T> {
  return { rows, error: null, loadedFor: key };
}

/** A current read failed: its message, with the rows and key a read that landed left. */
export function landFailure<T>(state: ListState<T>, message: string): ListState<T> {
  return { ...state, error: message };
}

/** Denied before anything; then an error over everything; then "loading" until a read for `key`
 *  has landed; then empty or rows. */
export function listStatus({ allowed, error, loadedFor, key, count }: {
  allowed: boolean; error: string | null; loadedFor: string | null; key: string | null; count: number;
}): ListStatus {
  if (!allowed) return "denied";
  if (error) return "error";
  if (key === null || loadedFor !== key) return "loading";
  return count === 0 ? "empty" : "rows";
}
