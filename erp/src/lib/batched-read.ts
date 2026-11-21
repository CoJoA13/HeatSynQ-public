// One request for every caller of the same task (#701, 2026-10-22 review, G9-2).
//
// The cert page mounts one RequirementBlock per requirement, and each block's recovery read sent
// its own cert GET and then its own /me: 2R requests for R blocks, and a second round when the
// page's permissions landed after the cert. The blocks mount in one React commit, so their reads
// are issued in one task: a batched read collects every caller of that task and sends ONE request
// on the next microtask. A caller that arrives after the send never joins the flight out, which is
// what keeps every joiner's read after its own `beginRead` (the draft-recovery design's "fresh
// authorized read"): a read restarted after a write (`restartReadAfterChange`) runs in a later
// task and starts its own flight. Nothing is kept past the send; this is not a cache. Each caller
// still checks its own ticket and its own requirement when the answer lands (readCertReadings).
//
// Client-safe leaf: no React, no `src/server` import. tests/batched-read.test.ts runs it.
export function batchedRead<T>(read: () => Promise<T>): () => Promise<T> {
  let open: Promise<T> | null = null;
  return () => {
    if (open !== null) return open;
    const flight = new Promise<T>((resolve, reject) => {
      queueMicrotask(() => { open = null; read().then(resolve, reject); });
    });
    open = flight;
    return flight;
  };
}
