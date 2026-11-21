export type Owner = Readonly<{ userId: string; authGeneration: number }>;
export type RecordKey = Readonly<{ kind: string; id: string }>;
export type EditorKey = Readonly<{
  owner: Owner; record: RecordKey; editor: string;
  childId?: string; entityVersion?: string;
}>;
export type EditorMetadata = Readonly<{
  label: string; href: string; scope?: string;
}>;
export type Stamp = Readonly<{
  key: EditorKey; generation: number; version: number;
}>;
export type Draft<D, B> = Readonly<{
  stamp: Stamp; schema: string; data: D; baseline: B;
}>;
export type Access<B> =
  | { kind: "unavailable"; readId: number }
  | { kind: "authorized"; readId: number; baseline: B; editable: boolean; recoveryAllowed?: boolean };
export type Outcome<R> =
  | { kind: "persisted"; response: R }
  | { kind: "rejected"; response?: R }
  | { kind: "unknown" };
export type Submission<D, B, P> = Readonly<{
  stamp: Stamp; requestId: string; submitted: Draft<D, B>; payload: P;
}>;
export type Settlement<D, B, C> =
  | { kind: "retire"; completed?: C; reference?: { data: D; baseline: B } }
  | { kind: "keep"; data: D; baseline: B; needsRefresh: boolean }
  | { kind: "reference"; data: D; baseline: B; needsRefresh: boolean };
export type ReadCopies<D, B, C> = Readonly<{ current?: Draft<D, B>; reference?: Draft<D, B>; submitted?: Draft<D, B>; clean?: D; completed?: C }>;
export interface Adapter<D, B, P, R, C = never, Q = never> {
  readonly kind: string;
  readonly schema: string;
  readonly allowUnknownRetry?: boolean;
  readonly allowRejectedFollowUp?: boolean;
  readonly reinitializeAfterDiscard?: boolean;
  readonly allowEditRead?: boolean;
  readRequirements?(copies: ReadCopies<D, B, C>): Q;
  valid(data: unknown, baseline: unknown): boolean;
  dirty(data: D, baseline: B): boolean;
  baselineEqual(saved: B, fresh: B, current?: D): boolean;
  reconcileRestore?(args: { current: Draft<D, B>; fresh: B }): { data: D; baseline: B } | null;
  preview(data: D, baseline: B): readonly Readonly<{ label: string; value: string }>[];
  cleanAfterDiscard?(args: { discarded: Draft<D, B>; clean: D; baseline: B }): D;
  canBeginNativeRead?(current: Draft<D, B>): boolean;
  reconcileNativeRead?(args: { current: Draft<D, B>; fresh: B }): { data: D; baseline: B } | null;
  reconcileMountedRead?(args: { current: Draft<D, B>; fresh: B }): { data: D; baseline: B } | null;
  /** Opt-in resolution of one unknown submission by a fresh authorized read; never retries it. */
  reconcileUnknownRead?(args: { current: Draft<D, B>; submission: Submission<D, B, P>; fresh: B }): { data: D; baseline: B } | null;
  reconcileRead(args: { current: Draft<D, B>; fresh: B }): { data: D; baseline: B };
  settle(args: {
    current: Draft<D, B>; submission: Submission<D, B, P>; outcome: Outcome<R>;
  }): Settlement<D, B, C>;
}
export interface EditorView<D, B, C> {
  /** Latest authorized saved projection, for disabled server-data display only. */
  readonly savedBaseline?: B;
  readonly submissionPhase?: "transport" | "rollback";
  /** Set, as true, while one of this editor's own submissions is in transport, for any adapter
   *  (R23, #702). `mode` is unchanged by it: a mounted editor stays `editing` during its own save,
   *  and an editor seen again on a return reads `pending` as before. */
  readonly pending?: true;
  readonly mode: "loading" | "editing" | "offer" | "conflict" |
    "blocked-two-copies" | "pending" | "unknown" | "unavailable" | "error" | "completed";
  readonly current?: Draft<D, B>;
  readonly reference?: Draft<D, B>;
  readonly completed?: C;
  readonly completedStamp?: Stamp;
  readonly submitted?: Draft<D, B>;
  /** Latest stamped recovery eligibility; omission preserves ordinary adapter behavior. */
  readonly recoveryAllowed?: boolean;
  readonly canRetryUnknown?: boolean;
  readonly canRestore: boolean;
  readonly needsRefresh: boolean;
}
export interface EditorBinding<D, B, P, R, C = never, Q = never> {
  subscribe(listener: () => void): () => void;
  getSnapshot(): EditorView<D, B, C>;
  attach(viewId: string): () => void;
  beginRead(): number;
  beginMountedRead(): number | null;
  beginNativeRead(): number | null;
  /** True means this stamped outcome was accepted, not that access is editable. */
  acceptRead(access: Access<B>, clean: D | (() => D)): boolean;
  readRequirements(readId: number): Q | null;
  restartReadAfterChange(readId: number): number | null;
  beginEditRead(): number | null;
  acceptEditRead(access: Access<B>, reduce: (current: Draft<D, B>, fresh: B) => D | null): boolean;
  change(reduce: (current: D) => D): void;
  restore(expected: Stamp, readId: number): boolean;
  startFresh(readId: number, clean: D | (() => D)): boolean;
  discard(expected: Stamp): void;
  /** Capture metadata-only generation retirement before an independently authorized deletion. */
  captureRetirement(): (() => boolean) | null;
  dismissCompleted(expected: Stamp): boolean;
  prepareUnknownRetry(expected: Stamp, readId: number, requestId: string): Submission<D, B, P> | null;
  capture(payload: P, requestId: string): Submission<D, B, P>;
  dispatched(submission: Submission<D, B, P>): boolean;
  noteRejectedSubmission(submission: Submission<D, B, P>): boolean;
  settle(submission: Submission<D, B, P>, outcome: Outcome<R>): void;
}
export type DraftListRow = Readonly<{
  key: EditorKey; metadata: EditorMetadata;
  stamps: readonly Stamp[]; pending: boolean; submissionPhase?: "transport" | "rollback";
}>;
export type DraftSummary = Readonly<{
  owner: Owner | null; identityReady: boolean;
  count: number; rows: readonly DraftListRow[];
}>;
export interface DraftStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): DraftSummary;
  beginIdentityCheck(): number;
  acceptIdentity(checkId: number, userId: string): Owner | null;
  identityCheckFailed(checkId: number, expired: boolean): void;
  resetIdentity(): void;
  bind<D, B, P, R, C, Q = never>(key: EditorKey, metadata: EditorMetadata,
    adapter: Adapter<D, B, P, R, C, Q>): EditorBinding<D, B, P, R, C, Q>;
  labelsForPath(pathname: string, ignoreLabels?: readonly string[]): readonly string[];
  hasScope(pathname: string, scope: string): boolean;
  stampsForPath(pathname: string): readonly Stamp[];
  discard(stamps: readonly Stamp[]): void;
}


const keyId = (key: EditorKey) => JSON.stringify([
  key.owner.userId, key.owner.authGeneration, key.record.kind, key.record.id,
  key.editor, key.childId ?? null, key.entityVersion ?? null,
]);
const sameStamp = (a: Stamp, b: Stamp) => keyId(a.key) === keyId(b.key)
  && a.generation === b.generation && a.version === b.version;
const sameOwner = (a: Owner | null, b: Owner) => a?.userId === b.userId && a.authGeneration === b.authGeneration;
const hidden: EditorView<never, never, never> = Object.freeze({ mode: "loading", canRestore: false, needsRefresh: false });
/** Hidden, and the mounted page owes the read that seeds this editor again (#456). */
const seedOwed: EditorView<never, never, never> = Object.freeze({ mode: "loading", canRestore: false, needsRefresh: true });

// Type erasure stays at the registry boundary; each entry's operations close over
// the concrete adapter and its recursively immutable business projections.
interface Entry {
  schema: string;
  binding: unknown;
  invalidate(): void;
  purge(): void;
  row(): DraftListRow | undefined;
  /** `call` is one store-level discard: the ids of the entries whose pending save it has dropped. */
  discard(stamp: Stamp, call: Set<string>): void;
}
export function createDraftStore(): DraftStore {
  let owner: Owner | null = null;
  let identityReady = false;
  let authGeneration = 0;
  let checkId = 0;
  let generation = 0;
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let summary: DraftSummary = Object.freeze({ owner, identityReady, count: 0, rows: Object.freeze([]) });
  const publish = () => {
    const retained = [...entries.values()].flatMap(entry => { const row = entry.row(); return row ? [row] : []; });
    const rows = identityReady ? retained : [];
    const publicOwner = identityReady ? owner : null;
    const unchanged = summary.rows.length === rows.length && summary.rows.every((row, i) => {
      const next = rows[i];
      return row.key === next.key && row.metadata === next.metadata && row.pending === next.pending && row.submissionPhase === next.submissionPhase
        && row.stamps.length === next.stamps.length && row.stamps.every((stamp, j) => stamp === next.stamps[j]);
    });
    if (summary.owner === publicOwner && summary.identityReady === identityReady && summary.count === retained.length && unchanged) return;
    summary = Object.freeze({ owner: publicOwner, identityReady, count: retained.length, rows: Object.freeze(rows) });
    for (const listener of [...listeners]) listener();
  };
  const purge = () => {
    identityReady = false; owner = null; authGeneration++;
    for (const entry of entries.values()) entry.purge();
    entries.clear();
  };
  function bind<D, B, P, R, C, Q = never>(key: EditorKey, metadata: EditorMetadata, adapter: Adapter<D, B, P, R, C, Q>): EditorBinding<D, B, P, R, C, Q> {
    const id = keyId(key);
    const existing = entries.get(id);
    if (existing) {
      if (existing.schema !== adapter.schema || key.editor !== adapter.kind) throw new Error("Incompatible draft schema");
      return existing.binding as EditorBinding<D, B, P, R, C, Q>;
    }
    if (key.editor !== adapter.kind) throw new Error("Incompatible draft kind");
    key = Object.freeze({ ...key, owner: Object.freeze({ ...key.owner }), record: Object.freeze({ ...key.record }) });
    metadata = Object.freeze({ ...metadata });
    let current: Draft<D, B> | undefined;
    let reference: Draft<D, B> | undefined;
    let receipt: { value: C; stamp: Stamp } | undefined;
    let access: Access<B> | undefined;
    let clean: D | undefined;
    let readId = 0;
    // Ordinary reads remain newest-issued. Mounted reads share a contiguous
    // cohort only while the same generation/lease is eligible; its lower bound
    // advances when a page-accepted response is applied (newest-applied).
    let ordinaryReadId = 0;
    let mountedRead: { kind: "mounted" | "native"; firstId: number; lastId: number; generation: number; lease: object } | undefined;
    let sourceRevision = 0;
    type Preparation = { kind: "read"; id: number; revision: number; lease: object; requirements?: Q }
      | { kind: "changed"; id: number; revision: number; lease: object }
      | { kind: "edit"; id: number; generation: number; baseline: B; lease: object };
    let preparation: Preparation | undefined;
    let consumedRead = -1;
    const clearPreparation = () => { preparation = undefined; };
    let retired = false;
    let needsRefresh = false;
    // A reinitializing adapter's discard leaves nothing to show until its page reads again (#456).
    // `reseedOwed` asks the page for that read. The next read's start clears it.
    let reseedOwed = false;
    let failed = false;
    let referenceOnly = false;
    let revisit = false;
    let lastLease: string | undefined;
    const leases = new Map<string, object>();
    const subscribers = new Set<() => void>();
    type Request = { submission: Submission<D, B, P>; state: "queued" | "pending" | "unknown"; root: string; rootOrder: number; retry: boolean; rejected?: boolean };
    const requests = new Map<string, Request>();
    let nextRootOrder = 0;
    let snapshot: EditorView<D, B, C> = hidden;
    const owned = () => {
      if (retired || !sameOwner(owner, key.owner)) return false;
      const registered = entries.get(id);
      if (registered && registered !== entry) { retired = true; return false; }
      return true;
    };
    const visible = () => owned() && identityReady && access?.kind === "authorized";
    const liveEditable = () => visible() && leases.size > 0 && access?.kind === "authorized" && access.editable;
    const dirty = (draft: Draft<D, B> | undefined) => !!draft && adapter.dirty(draft.data, draft.baseline);
    const pending = () => [...requests.values()].some(request => request.state === "pending");
    const submissionPhase = (): "transport" | "rollback" | undefined => {
      if (!adapter.allowRejectedFollowUp) return undefined;
      const active = [...requests.values()].filter(request => request.state === "pending");
      return active.length ? active.some(request => !request.rejected) ? "transport" : "rollback" : undefined;
    };
    const unknown = () => [...requests.values()].some(request => request.state === "unknown");
    const latestSubmitted = () => [...requests.values()].filter(request => request.state !== "queued").at(-1)?.submission.submitted;
    const make = (data: D, baseline: B, prior?: Draft<D, B>): Draft<D, B> => Object.freeze({
      stamp: Object.freeze({ key, generation: prior?.stamp.generation ?? ++generation, version: prior ? prior.stamp.version + 1 : 0 }),
      schema: adapter.schema, data, baseline,
    });
    const valid = (draft: Draft<D, B>) => draft.schema === adapter.schema && adapter.valid(draft.data, draft.baseline);
    const conflicts = () => !!current && dirty(current) && access?.kind === "authorized"
      && !adapter.baselineEqual(current.baseline, access.baseline, current.data);
    const retryOriginal = () => {
      if (!adapter.allowUnknownRetry || !liveEditable() || access?.kind !== "authorized" || access.recoveryAllowed === false
        || !current || !valid(current) || pending() || failed || receipt) return undefined;
      const candidates = [...requests.values()].filter(r => r.submission.stamp.generation === current!.stamp.generation);
      if (candidates.some(r => r.retry && r.state === "queued")) return undefined;
      // Replacing a settled attempt must not move its original root behind other roots.
      return candidates.reduce<Request | undefined>((first, request) => request.state === "unknown"
        && (!first || request.rootOrder < first.rootOrder) ? request : first, undefined);
    };
    const mode = (): EditorView<D, B, C>["mode"] => {
      if (failed) return "error";
      if (receipt) return "completed";
      if (conflicts() || referenceOnly) return reference && current && dirty(current) ? "blocked-two-copies" : "conflict";
      if (!current && reference) return "conflict";
      if (unknown()) return "unknown";
      if (pending() && revisit) return "pending";
      if (!current) return "loading";
      if (revisit && dirty(current)) return access?.kind === "authorized" && access.recoveryAllowed === false ? "conflict" : "offer";
      return "editing";
    };
    const reclaim = () => {
      if (leases.size || dirty(current) || reference || receipt || pending() || unknown()) return;
      clearPreparation(); current = undefined; clean = undefined; access = undefined; mountedRead = undefined; requests.clear(); failed = false; referenceOnly = false; needsRefresh = false; reseedOwed = false;
      if (entries.get(id) === entry) entries.delete(id);
    };
    const emit = () => {
      reclaim();
      let next: EditorView<D, B, C>;
      if (!owned() || !identityReady) next = hidden;
      else if (!access) next = reseedOwed ? seedOwed : hidden;
      else if (access.kind === "unavailable") next = { mode: "unavailable", canRestore: false, needsRefresh };
      else if (!access.editable) next = {
        savedBaseline: failed ? undefined : access.baseline, recoveryAllowed: access.recoveryAllowed !== false,
        mode: failed ? "error" : receipt ? "completed" : reference && current && dirty(current) ? "blocked-two-copies" : "conflict",
        current: reference && dirty(current) ? current : undefined,
        // Clean saved data remains a baseline, not a retained user copy. Keep all
        // unresolved/error/reference-only projections under their existing ownership.
        reference: reference ?? (failed || dirty(current) || pending() || unknown() || referenceOnly ? current : undefined),
        completed: receipt?.value, completedStamp: receipt?.stamp, submitted: latestSubmitted(), canRestore: false, needsRefresh,
      };
      else {
        const state = mode();
        next = { mode: state, savedBaseline: failed ? undefined : access.baseline, recoveryAllowed: access.recoveryAllowed !== false, current, reference, completed: receipt?.value, completedStamp: receipt?.stamp, submitted: latestSubmitted(),
          ...(pending() ? { pending: true as const } : {}),
          canRetryUnknown: adapter.allowUnknownRetry ? !!retryOriginal() : undefined,
          canRestore: access.recoveryAllowed !== false && state === "offer" && !needsRefresh && !!current && !pending() && !unknown(), needsRefresh };
      }
      const phase = submissionPhase();
      if (phase && visible()) next = { ...next, submissionPhase: phase };
      if (snapshot.submissionPhase !== next.submissionPhase || snapshot.pending !== next.pending || snapshot.mode !== next.mode || snapshot.savedBaseline !== next.savedBaseline || snapshot.current !== next.current || snapshot.reference !== next.reference
        || snapshot.completed !== next.completed || snapshot.completedStamp !== next.completedStamp || snapshot.submitted !== next.submitted
        || snapshot.canRetryUnknown !== next.canRetryUnknown || snapshot.recoveryAllowed !== next.recoveryAllowed || snapshot.canRestore !== next.canRestore || snapshot.needsRefresh !== next.needsRefresh) {
        snapshot = Object.freeze(next);
        for (const listener of [...subscribers]) listener();
      }
      publish();
    };
    const clearRequests = (draftGeneration: number) => {
      for (const [requestId, request] of requests) if (request.submission.stamp.generation === draftGeneration) requests.delete(requestId);
    };
    // `call` lives for one discard call: the store's, which loops the stamps it is given (the Shell's
    // panel discards a row's two copies together), or a single in-page discard of one stamp.
    // It remembers that this call dropped a copy whose save was in flight, and nothing later can read it.
    const discard = (expected: Stamp, call: Set<string> = new Set()) => {
      if (!owned()) return;
      const discardedCurrent = !!current && sameStamp(current.stamp, expected);
      const discardedReference = !!reference && sameStamp(reference.stamp, expected);
      if (!discardedCurrent && !discardedReference) return;
      // A requirements read in flight is kept (#454): the revision bump below makes its answer,
      // fetched for the copies as they were, refused as changed, and a loader still waiting on
      // that answer then restarts the read once. Clearing it left the editor loading with no read out.
      // Residual (owner ruling 2026-10-05): a kept read that no loader will restart stays loading
      // until the page's own re-check. For example, a discard during a loader's second attempt, which
      // does not restart again, or after the loader returned on an authorization or requirements check.
      if (preparation?.kind !== "read") clearPreparation();
      sourceRevision++;
      const discarded = discardedCurrent ? current : reference;
      const wasBlocked = mode() === "blocked-two-copies";
      if (mountedRead) { mountedRead = undefined; readId++; }
      if ([...requests.values()].some(request => request.state === "pending" && request.submission.stamp.generation === expected.generation)) call.add(id);
      // Owner ruling 2026-10-06: a pending save wins over the restart, for every adapter. The
      // discarded save was not cancelled, so the read is dropped and the page keeps its manual re-check.
      if (call.has(id)) clearPreparation();
      clearRequests(expected.generation);
      if (discardedCurrent) { current = undefined; if (adapter.reinitializeAfterDiscard) clean = undefined; }
      if (discardedReference) reference = undefined;
      // Removal is stamp-based even when a copy or the latest read is malformed.
      // Never turn a rejected baseline (or an invalid remaining sibling) into an
      // editing generation merely because its other copy was discarded.
      failed = !!(current && !valid(current)) || !!(reference && !valid(reference))
        || (access?.kind === "authorized" && clean !== undefined && !adapter.valid(clean, access.baseline));
      if (wasBlocked && current && !reference) { reference = current; current = undefined; }
      // Dismissing a reference during ordinary editing must not reset its sibling.
      // The earlier copy can also be the last one to go (#449): with no receipt and no
      // refresh owed, that ends in the same clean copy as a discarded current. A
      // reinitializing adapter takes its new seed below instead.
      const lastCopyGone = !current && !receipt && !needsRefresh && !adapter.reinitializeAfterDiscard;
      if (discardedCurrent || wasBlocked || lastCopyGone) {
        needsRefresh = false; referenceOnly = false;
        if (!failed && !reference && access?.kind === "authorized" && clean !== undefined && leases.size) {
          let next: D = clean;
          if (discarded && valid(discarded) && adapter.cleanAfterDiscard) {
            try { next = adapter.cleanAfterDiscard({ discarded, clean, baseline: access.baseline }); }
            catch { failed = true; }
          }
          if (!adapter.valid(next, access.baseline) || adapter.dirty(next, access.baseline)) failed = true;
          if (!failed) { current = make(next, access.baseline); revisit = false; }
        }
      }
      if (adapter.reinitializeAfterDiscard && !current && !reference && !receipt) {
        clean = undefined; access = undefined; failed = false; needsRefresh = false;
        // Owner ruling 2026-10-05: no automatic reload under a pending save either; its read was
        // dropped above.
        const saveDiscarded = call.has(id);
        // A kept read is its loader's to restart, with no seed (the residual is stated above);
        // asking the page as well would supersede it.
        const keptRead = preparation?.kind === "read";
        if (!keptRead) readId++;
        reseedOwed = !keptRead && !saveDiscarded;
      }
      emit();
    };
    const binding: EditorBinding<D, B, P, R, C, Q> = {
      captureRetirement() {
        if (!visible() || leases.size !== 1 || (!current && !reference)) return null;
        // Capture only generation metadata. Later edits in these generations belong
        // to the deleted entity; separately recreated generations do not.
        const currentGeneration = current?.stamp.generation;
        const referenceGeneration = reference?.stamp.generation;
        let consumed = false;
        return () => {
          if (consumed) return false;
          consumed = true;
          // Known acknowledgement remains authoritative through same-owner hidden
          // or detached states. Reset/re-registration still revokes this binding.
          if (!owned()) return false;
          const removeCurrent = !!current && (current.stamp.generation === currentGeneration || current.stamp.generation === referenceGeneration);
          const removeReference = !!reference && (reference.stamp.generation === currentGeneration || reference.stamp.generation === referenceGeneration);
          if (!removeCurrent && !removeReference) return false;
          if (removeCurrent) { clearRequests(current!.stamp.generation); current = undefined; }
          if (removeReference) { clearRequests(reference!.stamp.generation); reference = undefined; }
          // This clears request bookkeeping, never the dispatched network request.
          clearPreparation(); sourceRevision++; readId++; mountedRead = undefined;
          const hasReplacement = !!current || !!reference || !!receipt;
          if (!hasReplacement) {
            clean = undefined; access = undefined; failed = false;
            referenceOnly = false; revisit = false; needsRefresh = true;
          }
          // Ordinary reclaim still releases clean, detached, otherwise empty
          // entries. Retained work, receipts and live replacements remain intact.
          emit();
          return true;
        };
      },
      subscribe(listener) { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
      // Auth invalidation changes the owner gate before notifying any entry.
      // A synchronous subscriber must not observe another entry's old snapshot
      // while that entry is still waiting for its own invalidation notification.
      getSnapshot: () => identityReady && !retired && sameOwner(owner, key.owner) ? snapshot : hidden,
      attach(viewId) {
        if (!owned()) { emit(); return () => {}; }
        if (!entries.has(id)) entries.set(id, entry);
        const lease = {};
        clearPreparation();
        mountedRead = undefined;
        if (lastLease !== undefined && lastLease !== viewId) { revisit = true; access = undefined; readId++; }
        lastLease = viewId; leases.set(viewId, lease); emit();
        return () => {
          if (leases.get(viewId) !== lease) return;
          clearPreparation(); leases.delete(viewId);
          mountedRead = undefined;
          if (!leases.size) readId++;
          emit();
        };
      },
      beginRead() {
        clearPreparation(); mountedRead = undefined; ordinaryReadId = ++readId; access = undefined; reseedOwed = false;
        if (adapter.readRequirements && owned() && identityReady && leases.size === 1)
          preparation = { kind: "read", id: readId, revision: sourceRevision, lease: [...leases.values()][0] };
        emit(); return readId;
      },
      readRequirements(expected) {
        if (!adapter.readRequirements || !owned() || !identityReady || leases.size !== 1 || expected !== readId || expected !== ordinaryReadId
          || preparation?.kind !== "read" || preparation.id !== expected || preparation.revision !== sourceRevision
          || ![...leases.values()].includes(preparation.lease) || (current && !valid(current)) || (reference && !valid(reference))) return null;
        const submitted = latestSubmitted(); if (submitted && !valid(submitted)) return null;
        if (preparation.requirements === undefined) preparation.requirements = adapter.readRequirements({ current, reference, submitted, clean, completed: receipt?.value });
        return preparation.requirements;
      },
      restartReadAfterChange(expected) {
        if (!adapter.readRequirements || !owned() || !identityReady || leases.size !== 1 || expected !== readId || expected !== ordinaryReadId
          || preparation?.kind !== "changed" || preparation.id !== expected || preparation.revision !== sourceRevision
          || ![...leases.values()].includes(preparation.lease)) return null;
        clearPreparation(); return binding.beginRead();
      },
      beginEditRead() {
        if (!adapter.allowEditRead || !liveEditable() || leases.size !== 1 || !current || !valid(current)
          || mode() !== "editing" || revisit || referenceOnly || receipt || failed || needsRefresh || unknown()) return null;
        mountedRead = undefined; preparation = { kind: "edit", id: ++readId, generation: current.stamp.generation,
          baseline: current.baseline, lease: [...leases.values()][0] }; return readId;
      },
      acceptEditRead(result, reduce) {
        const prepared = preparation;
        if (!adapter.allowEditRead || !owned() || !identityReady || leases.size !== 1 || prepared?.kind !== "edit"
          || result.readId !== readId || prepared.id !== readId || ![...leases.values()].includes(prepared.lease)
          || !current || current.stamp.generation !== prepared.generation || current.baseline !== prepared.baseline
          || !liveEditable() || mode() !== "editing" || revisit || referenceOnly || receipt || failed || needsRefresh || !valid(current)) return false;
        clearPreparation();
        if (result.kind === "unavailable") { access = result; emit(); return false; }
        if (!result.editable || result.recoveryAllowed === false || !adapter.valid(current.data, result.baseline)) return false;
        const data = reduce(current, result.baseline);
        if (data === null || !adapter.valid(data, result.baseline)) return false;
        current = make(data, result.baseline, current); access = result; sourceRevision++; emit(); return true;
      },
      beginMountedRead() {
        if (!adapter.reconcileMountedRead || !liveEditable() || leases.size !== 1 || !current
          || mode() !== "editing" || revisit || reference || referenceOnly || receipt || failed || needsRefresh || requests.size) return null;
        clearPreparation(); readId++;
        const lease = [...leases.values()][0];
        const sameCohort = mountedRead?.kind === "mounted" && mountedRead.generation === current.stamp.generation && mountedRead.lease === lease;
        mountedRead = { kind: "mounted", firstId: sameCohort ? mountedRead!.firstId : readId, lastId: readId,
          generation: current.stamp.generation, lease };
        return readId;
      },
      beginNativeRead() {
        if (!adapter.canBeginNativeRead || !adapter.reconcileNativeRead || !visible() || leases.size !== 1 || !current
          || mode() !== "editing" || revisit || reference || referenceOnly || receipt || failed || needsRefresh || requests.size
          || !valid(current) || !adapter.canBeginNativeRead(current)) return null;
        clearPreparation(); readId++;
        const lease = [...leases.values()][0];
        const sameCohort = mountedRead?.kind === "native" && mountedRead.generation === current.stamp.generation && mountedRead.lease === lease;
        mountedRead = { kind: "native", firstId: sameCohort ? mountedRead!.firstId : readId, lastId: readId,
          generation: current.stamp.generation, lease };
        return readId;
      },
      acceptRead(result, initialize) {
        if (!owned() || !identityReady || leases.size === 0) return false;
        const mounted = mountedRead && result.readId >= mountedRead.firstId && result.readId <= mountedRead.lastId ? mountedRead : undefined;
        // A consumed mounted ID is never an ordinary read, even when it is the
        // latest issued number and the cohort has become empty.
        if (!mounted && (result.readId !== readId || result.readId !== ordinaryReadId)) return false;
        if (mounted && (!current || current.stamp.generation !== mounted.generation || leases.size !== 1
          || ![...leases.values()].includes(mounted.lease) || revisit || reference || referenceOnly
          || receipt || failed || requests.size)) return false;
        if (mounted?.kind === "native" && (!visible() || conflicts() || mode() !== "editing" || needsRefresh)) return false;
        if (adapter.readRequirements && !mounted) {
          if (leases.size !== 1 || consumedRead === result.readId || preparation?.kind !== "read" || preparation.id !== result.readId
            || ![...leases.values()].includes(preparation.lease)) return false;
          if (preparation.revision !== sourceRevision) {
            preparation = { kind: "changed", id: result.readId, revision: sourceRevision, lease: preparation.lease }; return false;
          }
          consumedRead = result.readId; clearPreparation();
        }
        const wasEditing = liveEditable() && mode() === "editing";
        if (mounted) mountedRead = result.readId === mounted.lastId ? undefined : { ...mounted, firstId: result.readId + 1 };
        access = result;
        if (result.kind === "unavailable") { if (mounted?.kind === "native") mountedRead = undefined; emit(); return true; }
        // Only a genuinely empty creation slot evaluates a new-seed initializer.
        const freshClean = typeof initialize === "function"
          ? clean ?? current?.data ?? reference?.data ?? (initialize as () => D)()
          : initialize;
        clean = freshClean;
        if (!adapter.valid(freshClean, result.baseline) || (current && !valid(current)) || (reference && !valid(reference))) {
          failed = true; emit(); return true;
        }
        failed = false;
        if (!receipt && !pending() && unknown() && current && !reference && result.editable && result.recoveryAllowed !== false && adapter.reconcileUnknownRead) {
          const unresolved = [...requests.values()].filter(r => r.state === "unknown");
          if (requests.size === 1 && unresolved.length === 1 && unresolved[0].submission.stamp.generation === current.stamp.generation) {
            const reconciled = adapter.reconcileUnknownRead({ current, submission: unresolved[0].submission, fresh: result.baseline });
            if (reconciled && adapter.valid(reconciled.data, reconciled.baseline)) {
              current = make(reconciled.data, reconciled.baseline, current);
              requests.delete(unresolved[0].submission.requestId);
              referenceOnly = false;
            }
          }
        }
        if (receipt || unknown() || pending()) { emit(); return true; }
        needsRefresh = false;
        if (mounted?.kind === "native" && current) {
          const reconciled = adapter.reconcileNativeRead?.({ current, fresh: result.baseline });
          if (!reconciled) { referenceOnly = true; mountedRead = undefined; }
          else if (!adapter.valid(reconciled.data, reconciled.baseline)) { failed = true; mountedRead = undefined; }
          else current = make(reconciled.data, reconciled.baseline, current);
          emit(); return true;
        }
        if (current && dirty(current)) {
          if (mounted && result.editable && conflicts()) {
            // A prior accepted cohort result may already have frozen this
            // copy. Later authorization may advance, but never prune it.
            if (wasEditing) {
              const reconciled = adapter.reconcileMountedRead?.({ current, fresh: result.baseline });
              if (reconciled) {
                if (!adapter.valid(reconciled.data, reconciled.baseline)) failed = true;
                else current = make(reconciled.data, reconciled.baseline, current);
              }
            }
          } else if (!conflicts() && !revisit && !referenceOnly) {
            const reconciled = adapter.reconcileRead({ current, fresh: result.baseline });
            if (!adapter.valid(reconciled.data, reconciled.baseline)) failed = true;
            else current = make(reconciled.data, reconciled.baseline, current);
          }
        } else if (reference) current = undefined;
        else { current = make(freshClean, result.baseline, mounted ? current : undefined); revisit = false; referenceOnly = false; }
        emit(); return true;
      },
      change(reduce) {
        if (!liveEditable() || mode() !== "editing" || !current) return;
        const data = reduce(current.data);
        if (data === current.data) return;
        if (!adapter.valid(data, current.baseline)) { failed = true; emit(); return; }
        current = make(data, current.baseline, current); sourceRevision++; emit();
      },
      restore(expected, expectedRead) {
        if (!liveEditable() || expectedRead !== access?.readId || !snapshot.canRestore || !current || !sameStamp(current.stamp, expected)) return false;
        if (!valid(current)) { failed = true; emit(); return false; }
        if (adapter.reconcileRestore && access?.kind === "authorized") {
          let next: { data: D; baseline: B } | null;
          try { next = adapter.reconcileRestore({ current, fresh: access.baseline }); }
          catch { next = null; }
          if (!next || !adapter.valid(next.data, next.baseline)) { failed = true; emit(); return false; }
          clearPreparation(); sourceRevision++; mountedRead = undefined;
          current = make(next.data, next.baseline, current);
        }
        revisit = false; emit(); return true;
      },
      startFresh(expectedRead, initialize) {
        if (!liveEditable() || access?.kind !== "authorized" || expectedRead !== access?.readId || mode() !== "conflict"
          || (reference && current && dirty(current)) || pending() || unknown()) return false;
        const freshClean = typeof initialize === "function" ? (initialize as () => D)() : initialize;
        if (!adapter.valid(freshClean, access.baseline)) return false;
        clearPreparation(); sourceRevision++; mountedRead = undefined;
        if (current && dirty(current)) reference = current;
        current = make(freshClean, access.baseline); clean = freshClean; revisit = false; referenceOnly = false; needsRefresh = false; emit(); return true;
      },
      discard: expected => discard(expected),
      dismissCompleted(expected) {
        if (!visible() || !leases.size || !receipt || !sameStamp(receipt.stamp, expected)) return false;
        clearPreparation(); sourceRevision++; receipt = undefined; clean = undefined;
        if (!reference && !current) { access = undefined; readId++; }
        needsRefresh = false; emit(); return true;
      },
      prepareUnknownRetry(expected, expectedRead, requestId) {
        if (!current || expectedRead !== access?.readId || !sameStamp(current.stamp, expected) || requests.has(requestId)) return null;
        const original = retryOriginal(); if (!original) return null;
        const submission = Object.freeze({ stamp: current.stamp, requestId, submitted: original.submission.submitted, payload: original.submission.payload });
        requests.set(requestId, { submission, state: "queued", root: original.root, rootOrder: original.rootOrder, retry: true }); return submission;
      },
      capture(payload, requestId) {
        if (!liveEditable() || mode() !== "editing" || !current || !valid(current)) throw new Error("Draft is not editable");
        if (requests.has(requestId)) throw new Error("Duplicate draft request");
        if (mountedRead) { mountedRead = undefined; readId++; }
        const submission = Object.freeze({ stamp: current.stamp, requestId, submitted: current, payload });
        requests.set(requestId, { submission, state: "queued", root: requestId, rootOrder: ++nextRootOrder, retry: false }); return submission;
      },
      dispatched(submission) {
        const request = requests.get(submission.requestId);
        if (!owned() || !identityReady || !current || current.stamp.generation !== submission.stamp.generation
          || request?.submission !== submission || request.state !== "queued") return false;
        if (request.retry && (!liveEditable() || (access?.kind === "authorized" && access.recoveryAllowed === false) || !sameStamp(current.stamp, submission.stamp))) return false;
        request.state = "pending"; emit(); return true;
      },
      noteRejectedSubmission(submission) {
        const request = requests.get(submission.requestId);
        if (!adapter.allowRejectedFollowUp || !owned() || entries.get(id) !== entry
          || request?.submission !== submission || request.state !== "pending" || request.rejected
          || (current?.stamp.generation !== submission.stamp.generation && reference?.stamp.generation !== submission.stamp.generation)) return false;
        request.rejected = true; emit(); return true;
      },
      settle(submission, outcome) {
        const request = requests.get(submission.requestId);
        if (!owned() || request?.submission !== submission || request.state !== "pending") return;
        if (request.rejected && outcome.kind !== "rejected") return;
        const target = current?.stamp.generation === submission.stamp.generation ? current
          : reference?.stamp.generation === submission.stamp.generation ? reference : undefined;
        if (!target) { requests.delete(submission.requestId); emit(); return; }
        sourceRevision++; if (preparation?.kind === "edit" || preparation?.kind === "changed") clearPreparation();
        const result = adapter.settle({ current: target, submission, outcome });
        if (outcome.kind === "unknown") {
          request.state = "unknown";
          // Only the newest settled unknown wrapper is needed for this original body.
          // Queued/pending requests retain their exact callback authority.
          for (const [id, sibling] of requests) {
            if (sibling !== request && sibling.root === request.root && sibling.state === "unknown") requests.delete(id);
          }
        } else requests.delete(submission.requestId);
        if (outcome.kind === "persisted") {
          // Retry attempts share an original captured body. A known successful
          // attempt settles that lineage even when an adapter preserves later work.
          for (const [id, sibling] of requests) if (sibling.root === request.root) requests.delete(id);
        }
        if (result.kind !== "retire" && !adapter.valid(result.data, result.baseline)) { failed = true; emit(); return; }
        if (result.kind === "retire") {
          clearRequests(target.stamp.generation);
          if (target === current) current = undefined; else reference = undefined;
          if (result.completed !== undefined) receipt = { value: result.completed, stamp: target.stamp };
          if (result.reference) {
            if (!adapter.valid(result.reference.data, result.reference.baseline)) failed = true;
            else if (!reference) reference = make(result.reference.data, result.reference.baseline);
            else { current = make(result.reference.data, result.reference.baseline); referenceOnly = true; }
          }
          needsRefresh = true;
        } else {
          const updated = make(result.data, result.baseline, target);
          if (target === reference) reference = updated; else current = updated;
          needsRefresh = result.needsRefresh;
          if (result.kind === "reference") referenceOnly = true;
        }
        emit();
      },
    };
    const entry: Entry = {
      schema: adapter.schema, binding, discard,
      invalidate() { clearPreparation(); readId++; mountedRead = undefined; access = undefined; revisit = true; emit(); },
      purge() { clearPreparation(); retired = true; mountedRead = undefined; current = undefined; reference = undefined; clean = undefined; receipt = undefined; requests.clear(); access = undefined; emit(); },
      row() {
        if (!owned()) return undefined;
        const stamps = [current, reference].filter((draft): draft is Draft<D, B> => !!draft && (dirty(draft) || draft === reference || pending() || unknown()));
        if (!stamps.length) return undefined;
        const phase = submissionPhase();
        return Object.freeze({ key, metadata, stamps: Object.freeze(stamps.map(draft => draft.stamp)), pending: pending(), ...(phase ? { submissionPhase: phase } : {}) });
      },
    };
    if (owned()) entries.set(id, entry);
    return binding;
  }
  return {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => summary,
    beginIdentityCheck() {
      checkId++; identityReady = false;
      for (const entry of entries.values()) entry.invalidate();
      publish(); return checkId;
    },
    acceptIdentity(ticket, userId) {
      if (ticket !== checkId) return null;
      if (owner && owner.userId !== userId) purge();
      if (!owner) owner = Object.freeze({ userId, authGeneration });
      identityReady = true; publish(); return owner;
    },
    identityCheckFailed(ticket, expired) {
      if (ticket !== checkId) return;
      if (expired) { checkId++; purge(); } else identityReady = false;
      publish();
    },
    resetIdentity() { checkId++; purge(); publish(); },
    bind,
    labelsForPath(pathname, ignoreLabels = []) {
      if (!identityReady) return [];
      return [...new Set([...entries.values()].flatMap(entry => {
        const row = entry.row();
        return row?.metadata.href.split(/[?#]/)[0] === pathname && !ignoreLabels.includes(row.metadata.label) ? [row.metadata.label] : [];
      }))];
    },
    hasScope(pathname, scope) {
      return identityReady && [...entries.values()].some(entry => {
        const row = entry.row(); return row?.metadata.href.split(/[?#]/)[0] === pathname && row.metadata.scope === scope;
      });
    },
    stampsForPath(pathname) {
      return identityReady ? [...entries.values()].flatMap(entry => {
        const row = entry.row(); return row?.metadata.href.split(/[?#]/)[0] === pathname ? row.stamps : [];
      }) : [];
    },
    discard(stamps) { const call = new Set<string>(); for (const stamp of stamps) entries.get(keyId(stamp.key))?.discard(stamp, call); },
  };
}
