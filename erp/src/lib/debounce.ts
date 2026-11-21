/**
 * The debounce rule for a typed search term (ruling R3, 2026-10-22 review; #612): a list screen
 * reads on the term as it stood 250 ms after the last keystroke, never on every keystroke. Pure
 * and clock-free, so vitest can prove it; `use-debounced-value.ts` runs it on React's clock.
 *
 *  - `settled` is the value the screen reads with; `pending` is a typed value whose wait has not
 *    ended, with the moment it is due.
 *  - Another keystroke RESTARTS the wait: the pending value is replaced and its `dueAt` moves.
 *  - Typing the settled value back cancels the pending one (nothing new is read), and a tick before
 *    `dueAt` changes nothing. Both answer the same object, so a caller keyed on identity sees no
 *    change.
 *
 * The Shell's global search keeps its own 250 ms timer (`Shell.tsx`), written before this leaf
 * and carrying rules of its own (the escape-before-debounce flow); the five list searches share
 * this one.
 */
export const SEARCH_DEBOUNCE_MS = 250;

export type Debounce<T> = Readonly<{ settled: T; pending: Readonly<{ value: T; dueAt: number }> | null }>;

export function debounceStart<T>(value: T): Debounce<T> {
  return { settled: value, pending: null };
}

/** A new typed `value` at `now`: pending until `now + wait`, unless it is the settled value. */
export function debounceInput<T>(state: Debounce<T>, value: T, now: number, wait: number): Debounce<T> {
  if (Object.is(value, state.settled)) return state.pending === null ? state : { settled: state.settled, pending: null };
  return { settled: state.settled, pending: { value, dueAt: now + wait } };
}

/** The clock at `now`: a pending value whose wait has ended settles. */
export function debounceTick<T>(state: Debounce<T>, now: number): Debounce<T> {
  if (state.pending === null || now < state.pending.dueAt) return state;
  return { settled: state.pending.value, pending: null };
}
