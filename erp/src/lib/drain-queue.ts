// Pure, client-safe (no src/server imports, no React — the next-sort.ts leaf shape). Two parts:
// the §5.13 rollback-drain (`drainOtherKeys`) for the detail pages built on `useMutationGate` + a
// per-key `serial()` save queue — orders/[id]/page.tsx, invoicing/[id]/InvoiceDetail.tsx,
// shipping/[id]/ShipmentDetail.tsx, certs/[id]/CertDetail.tsx (Group D Task 7) — and, for those
// four record pages, the registry of writes in flight and the read that follows them
// (`makeWriteSignals`, `reReadAfter`; #550 on the hub, #573 on the other three; the section at the
// end of this file).
//
// The hole: a failed save's rollback `load()` takes the NEWEST mutation ticket, so its GET can be
// served before a SIBLING key's still-in-flight PATCH commits. The payload then carries the
// sibling's PRE-save value, the accept gate applies it (nothing newer has landed yet), and the
// sibling's committed write reverts on screen — its own response is dropped as older-ticketed, so
// the reversion sticks until the next full refresh. Same-key corrections are already safe on
// these pages (a same-key response re-applies through the accept gate), so the fix is to wait out
// every OTHER key's in-flight request before dispatching the rollback GET. Only the keys a page
// registers are drained: the hub, the saved shipment and the invoice register their header fields
// alone (on the hub, Overview and Notes), and the cert page its notes and every readings block. Each
// page's other writes through `applyMutation` (on the hub Lines, the grids, Link and Unlink; on the
// saved shipment the order panels' Lines, Containers and Serials saves, Add order and Remove order;
// on the invoice the lines save, Recalculate, Finalize and Unlock; on the cert none, whose two
// `applyMutation` callers are its drained keys, so the read exposed there was the print's follow-up
// `load()`) are covered by the read that follows (#550 on the hub, #573 on the other three, below).
//
// WHAT THE MAP MUST HOLD (fix round 1, review CRITICAL): per-key REQUEST-settled signals —
// registered at dispatch (`inFlight.current.set(key, req.then(noop, noop))` beside the `await`),
// settling when the request itself settles. NEVER hand this function the `serial()` chain-TAIL
// map: a key's stored tail settles only after its own catch — drain included — completes, so two
// saves on different keys both failing while overlapping (one network blip rejects both in-flight
// PATCHes) had each catch awaiting the other's tail: a reproducible mutual deadlock — no
// rollback, no error banner, both queues permanently wedged, and any third key's failing save
// hanging behind them. A request's settlement IS its commit/failure, which is all the rollback
// GET must postdate — nothing about a sibling's RECOVERY (its own drain, rollback load, banner)
// needs to have finished — and a signal never depends on a drain, so no cycle is possible.
//
//  - The OWN key is excluded, always. Under the signals contract the own entry is settled by the
//    time the catch drains (the own request just failed — that is why the catch is running), but
//    the exclusion must not DEPEND on that: an own entry that never settles still must not wedge
//    the drain.
//  - The wait re-snapshots until the other keys' signals are stable (the save-scope.ts "park is
//    itself a save window" lesson, Task 2 review R1): a save dispatched WHILE we sit on
//    allSettled registers a fresh signal under its key, and its commit could still postdate a GET
//    released on the old snapshot alone — the exact reversion this drain exists to prevent.
//    Terminates because signals are only registered by user actions — which is also the
//    starvation acceptance: under SUSTAINED sibling saving the rollback waits indefinitely,
//    bounded only by the user pausing, the same acceptance the save-scope reload made.
//  - `allSettled`, never `all`: a rejecting sibling request must release the drain either way —
//    the drain ORDERS the rollback GET after the siblings; it does not care how they fared.

/** Await the settlement of every key's request-settled signal in `signals` EXCEPT `ownKey`'s.
 *  Call from a failing save's catch, before dispatching the §5.13 rollback load. `signals` must
 *  be the dispatch-time request-signal map, never the serial() chain-tail map — see above. */
export async function drainOtherKeys(
  signals: Map<string, Promise<unknown>>,
  ownKey: string,
): Promise<void> {
  for (;;) {
    const others = [...signals.entries()].filter(([k]) => k !== ownKey).map(([, p]) => p);
    if (others.length === 0) return;
    await Promise.allSettled(others);
    const seen = new Set(others);
    const now = [...signals.entries()].filter(([k]) => k !== ownKey).map(([, p]) => p);
    if (now.every((p) => seen.has(p))) return;
  }
}

// ── A record page's writes in flight and the read that follows them (#550, #573) ────────────────
// Owner ruling 2026-10-18, "read now, re-read after", with the owner's answers to the build plan
// (docs/execution/2026-10-18-550-hub-reread/plan.md, amendments 1 and 2); taken by the saved
// shipment, the invoice and the cert on 2026-10-20 (#573,
// docs/execution/2026-10-20-573-rollback-reads-wait/plan.md, amendment 1), each page's `load` and
// `applyMutation` reading one registry of its own. A read of the record goes out at once and waits
// on nothing the page has sent (`api()` has no timeout, #276). A write of the page dispatched
// before that GET and unanswered as it goes out may commit after the server served it, so the
// payload can predate the write: applied after the write's answer, it reverts the write on screen;
// applied before it, the answer, older-ticketed, is dropped at the gate. So the page reads once
// more after those writes settle.
//
//  - The registry holds one request-settled signal per dispatch, added synchronously at dispatch
//    and deleted when its request settles, whichever way. A Set, the save-scope.ts shape, not the
//    pages' per-key map that `drainOtherKeys` drains, which never deletes and stays bounded only
//    because its keys are field names.
//  - A read snapshots `outstanding()` as its GET is sent. When the snapshot is not empty the read
//    is followed once, after every write in it has settled, whether or not any is still out when
//    the read lands (answer A to the plan's question 1): where the write's answer landed first,
//    the stale read was applied over it, and only a later read ends on the server's value. The
//    client cannot tell that case from one where the server committed the write before serving the
//    GET; there the follow-up is one spare GET.
//  - A follow-up is a read like any other (answer A to question 2): a caller that snapshots again
//    as the follow-up is sent follows it in turn when a write sent since is still out, so the chain
//    ends at the first read sent with no registered write out. It ends because the delete reaction
//    is attached to the signal at dispatch and `reReadAfter`'s `allSettled` attaches its own only
//    when the read lands; reactions run in the order attached, so a settled write's entry is gone
//    before the follow-up snapshots the registry. A settled entry left behind would bring a
//    follow-up after every follow-up. The ordering is the microtask queue's, not this API's, so a
//    test pins it.
//  - `allSettled`, never `all`: the follow-up is ordered after the writes, however they fared. A
//    stalled write withholds the follow-up of every read whose snapshot holds it, until it settles
//    or the page reloads; nothing else waits on it.

/** A record page's writes in flight (#550 on the order hub; #573 on the saved shipment, the invoice
 *  and the cert): one request-settled signal per dispatch, deleted when the request settles,
 *  whichever way. */
export type WriteSignals = {
  /** Register a dispatched request. Call synchronously at dispatch, with the request itself. */
  dispatched(request: Promise<unknown>): void;
  /** The writes out at this instant, as a copy. Call synchronously as a read is sent. */
  outstanding(): readonly Promise<void>[];
};

export function makeWriteSignals(): WriteSignals {
  const out = new Set<Promise<void>>();
  return {
    dispatched(request) {
      const signal = request.then(() => {}, () => {}); // settles with the request; never rejects
      out.add(signal);
      void signal.then(() => { out.delete(signal); }); // attached at dispatch: runs before any wait's reaction
    },
    outstanding: () => [...out],
  };
}

/** After a read has landed: when any of the page's registered writes was out as it was sent
 *  (`atSend`, its snapshot of `outstanding()`), run `again` once, after every one of them has
 *  settled. Never awaited by the read's caller, so a stalled write delays only `again`. `again` must
 *  not throw: nothing awaits the promise it runs in, so a throw would be an unhandled rejection. */
export function reReadAfter(atSend: readonly Promise<void>[], again: () => void): void {
  if (atSend.length === 0) return;
  void Promise.allSettled(atSend).then(() => { again(); });
}
