// Single-flight: at most one invocation of `fn` runs at a time per wrapper; a call issued while
// one is in flight JOINS it — it receives the very same promise — instead of starting a second
// run. The slot clears when the flight settles, on rejection as much as resolution, so one failed
// run can never wedge the wrapper; the next call after settlement runs fresh. The joiner contract
// is deliberate: a joined caller sees the running flight's outcome — its rejection included —
// because "the work was done once, and this is how it ended" is the whole promise being shared.
//
// Pure and dependency-free (the drain-queue.ts leaf shape). Lives in the shared layer so server
// code may use it: #111's practice reset serializes its concurrent callers with a module-scoped
// wrapper instead of a connection-pinning advisory-lock transaction (see practice-reset.ts for
// the process-model rationale).
//
// `fn` must return a promise. A SYNCHRONOUS throw from `fn` propagates synchronously to the one
// caller that triggered it and leaves the slot clear — nothing was ever in flight to join.
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () =>
    (inFlight ??= fn().finally(() => {
      inFlight = null;
    }));
}

/** A one-shot write's hold (#720), from `oneShotHold`. */
export type OneShotHold = {
  /** Runs `fn` when nothing is held and holds until its promise settles, either way. A call while
   *  held runs nothing and answers `undefined`: a second click sends no second request. */
  run<T>(fn: () => Promise<T>): Promise<T | undefined>;
  /** Whether a run is out, read synchronously: the same-tick guard a state copy cannot be. */
  inFlight(): boolean;
};

// A one-shot write button's pending state (#720): `singleFlight`'s refusing sibling. A click that
// arrives while the button's own request is out sends nothing, where a joined caller would run the
// handler's own follow-up twice; and each run takes its `fn` at call time, so a handler a component
// declares reads the render it was clicked in rather than the one the hold was built in. The hold
// clears when the flight settles, on a refusal as much as on success, so a refused click can be
// tried again at once. `onChange` is told each change, which is how a component copies the hold
// into the state its `disabled=` reads: `const [adding, setAdding] = useState(false)` and
// `const [addHold] = useState(() => oneShotHold(setAdding))`. The state draws the button; `run`
// refuses a click that lands before the state does.
//
// As with `singleFlight`, a SYNCHRONOUS throw from `fn` propagates to the click that ran it and
// leaves the hold clear.
export function oneShotHold(onChange: (held: boolean) => void = () => {}): OneShotHold {
  let held = false;
  const release = () => {
    held = false;
    onChange(false);
  };
  return {
    inFlight: () => held,
    run<T>(fn: () => Promise<T>): Promise<T | undefined> {
      if (held) return Promise.resolve(undefined);
      held = true;
      onChange(true);
      let flight: Promise<T>;
      try {
        flight = fn();
      } catch (e) {
        release();
        throw e;
      }
      return flight.finally(release);
    },
  };
}
