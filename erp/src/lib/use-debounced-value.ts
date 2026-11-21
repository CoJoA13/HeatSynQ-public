import { useEffect, useState } from "react";
import { SEARCH_DEBOUNCE_MS, debounceInput, debounceStart, debounceTick, type Debounce } from "./debounce";

/**
 * `value` as it stood `wait` ms after it last changed (ruling R3; #612): the five list searches
 * build their query, and their Excel export link, from this, while the box keeps the raw text.
 * The rule is `debounce.ts`'s; this only puts it on the clock: each new `value` is handed to
 * `debounceInput`, and one timer per pending value hands `debounceTick` the moment it is due.
 * Both setters derive from the previous state, so a value typed and retyped within one wait is
 * one pending value, not two timers.
 *
 * `settleKey`, when given: a render where it differs from the last one settles `value` as it stands
 * at once, with nothing pending (`debounceStart`). New order passes its draft's readiness, so a
 * resumed draft's received date is read at once and only typing waits (#668). The list searches
 * pass none, and an absent key never changes.
 */
export function useDebouncedValue<T>(value: T, wait = SEARCH_DEBOUNCE_MS, settleKey?: unknown): T {
  const [state, setState] = useState<Debounce<T>>(() => debounceStart(value));
  const [key, setKey] = useState(settleKey);
  let current = state;
  if (!Object.is(key, settleKey)) {
    // React's adjust-state-while-rendering form: this render already answers the settled value.
    current = debounceStart(value);
    setKey(settleKey); setState(current);
  }
  useEffect(() => {
    setState((s) => debounceInput(s, value, Date.now(), wait));
  }, [value, wait]);
  useEffect(() => {
    if (state.pending === null) return;
    const timer = setTimeout(() => setState((s) => debounceTick(s, Date.now())), Math.max(0, state.pending.dueAt - Date.now()));
    return () => clearTimeout(timer);
  }, [state]);
  return current.settled;
}
