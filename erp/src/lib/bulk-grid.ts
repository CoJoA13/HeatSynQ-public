"use client";
// Shared by the order hub's bulk-edit grids (Containers/Charges/Loads/per-line Serials,
// src/app/orders/[id]/) — every one of them PUTs its ENTIRE array back to a Task 5/6 endpoint
// (replaceContainers/replaceCharges/replaceLoads/replaceSerials), so the natural editor shape is
// "edit several rows, then one Save sends the whole thing" rather than a per-field PATCH.
//
// The 2C-3 lesson (HANDOFF §4a, docs/2026-08-02-2c3-process-steps-design.md §... — "preserving
// unsaved UI work is a model problem, not a patch problem") applies here just as much as it did to
// ProcessStepsSection's step editor: a full local COPY of the server array, once seeded, either
// goes stale the moment something else refreshes the parent order (masking that refresh) or has
// to be defensively re-synced in a way that risks discarding what the user just typed. The fix
// used there — keep only what the user actually touched, in a separate overlay, and compose it
// with server state at RENDER time — generalizes cleanly to "array of rows" once row identity is
// handled: an edited EXISTING row is tracked by its server id (only the touched fields, `step-
// drafts.ts`'s own shape); a newly ADDED row has no server id yet, so it is tracked in full under
// a client-generated id; a REMOVED existing row is tracked as a bare id, never spliced out of the
// server array directly (there is no server array to splice — `containers` etc. are props, not
// state). None of the three can go stale: if the server array is unrelated-refreshed (e.g. the
// Overview section saves a PO change, which re-fetches the whole order), `compose` just re-runs
// against the new (in this case unchanged) server rows with the exact same overlay.
//
// Fix round 1 (Important finding): Charges and per-line Serials sit on DELETE-THEN-RECREATE
// mutators (replaceSerials/replaceCharges each delete every row and reinsert at positions 1..n,
// so EVERY row gets a fresh id on EVERY save, whoever saves it). Containers was the third until
// #493: `replaceContainers` now updates each row the page names by id in place, so a kept row's id
// survives a save and only a removed row's id is gone. Loads is the partial exception:
// `applyLoads` matches existing rows by array position and updates them in place, so ids survive
// a save that keeps the SAME row count — the review's own "Loads is immune" note, which is why
// LoadsSection.tsx originally never rendered `orphanWarning`. That immunity does not extend to a
// save that SHRINKS the array (this section's own remove, or a Re-split landing on fewer loads
// than before): `applyLoads` hard-deletes the trailing rows beyond the new, shorter length, so an
// edit still pending against one of those now-gone ids orphans exactly like it would under the
// churning sections — Task 15 (the shrink-path residual) made LoadsSection.tsx render the warning
// too, since `detectOrphans` below has always run for every caller regardless of which ones
// render its result. Composing an edit keyed on a row id that another actor's save already
// replaced used to just silently produce nothing: `compose` looked up `edits.get(r.id)` for each
// CURRENT row, found no match for the
// stale id, and the edit — real, unsaved, user-typed content — vanished with no trace, the moment
// ANY mutation anywhere on the page (not necessarily this grid's own) next refreshed `order` and
// therefore this grid's `serverRows` prop. `detectOrphans` below catches exactly this: it
// remembers the last set of row ids `compose` saw, and the moment that set changes out from under
// a NON-EMPTY `edits` map, it clears the entries that no longer match anything live and records a
// warning for the section to render — never silently, and never by guessing which new row an old
// edit "must" belong to.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditorBinding, RecordKey } from "./draft-store";
import { getBrowserDraftSession, peekBrowserDraftSession } from "./draft-session";
import { useDraftIdentity, useRecoverableDraft } from "./use-recoverable-draft";
import { bulkGridDirty, bulkRecoveryPreviews, createBulkRecoveryAdapter, emptyBulkDraft, transitionBulkDraft, type BulkAction, type BulkBaseline, type BulkDraft, type BulkRecoveryCustomization } from "./bulk-grid-recovery";
import { newId } from "./client-id";
import type { EditorMode } from "./draft-recovery-words";

/** The server row shape every grid's rows need at minimum — a stable id to key edits/removal by. */
export type BulkRow = { id: string };

/** One row as `compose` renders it: either an existing server row (`isNew: false`, keyed by its
 *  real id) or a not-yet-saved local addition (`isNew: true`, keyed by a client-generated id). */
export type ComposedRow<Fields> = { key: string; isNew: boolean } & Fields;

const ORPHAN_WARNING =
  "This list changed on the server while you were editing — your unsaved changes here were " +
  "set aside; please re-check.";

/** What one call to `detectOrphans` (below) decided, given the live id set and what's pending —
 *  pulled out as a pure function (fix-wave R2 finding 5) so the id-churn matrix is unit-testable
 *  without a component-test harness (this codebase has none). `"unchanged"`: the live id set is
 *  the same content as last time (by CONTENT, not Set identity) — a true no-op, nothing recorded.
 *  `"first-seen"`: this hook instance's very first call — there is no prior set to compare
 *  against, so nothing can have "orphaned" yet, only a baseline to remember. `"churned"`: the live
 *  set actually changed since last time, carrying whichever edit keys and/or removedIds entries no
 *  longer match any current row. */
export type OrphanChurn =
  | { kind: "unchanged" }
  | { kind: "first-seen" }
  | { kind: "churned"; orphanedEditKeys: string[]; orphanedRemovedIds: string[] };

export function computeOrphanChurn(params: {
  liveIds: ReadonlySet<string>;
  /** `null` on the very first call — there is nothing yet to have churned away from. */
  priorLiveIds: ReadonlySet<string> | null;
  editKeys: Iterable<string>;
  removedIds: ReadonlySet<string>;
}): OrphanChurn {
  const { liveIds, priorLiveIds, editKeys, removedIds } = params;
  const unchanged = priorLiveIds !== null
    && liveIds.size === priorLiveIds.size
    && [...liveIds].every((id) => priorLiveIds.has(id));
  if (unchanged) return { kind: "unchanged" };
  if (priorLiveIds === null) return { kind: "first-seen" };

  const orphanedEditKeys = [...editKeys].filter((id) => !liveIds.has(id));
  const orphanedRemovedIds = [...removedIds].filter((id) => !liveIds.has(id));
  return { kind: "churned", orphanedEditKeys, orphanedRemovedIds };
}

/** One locally-added row as `useBulkGrid` stores it: the caller's fields plus the client-generated
 *  id they are keyed by (there is no server id yet — that is what makes them "added"). */
export type AddedRow<Fields> = { clientId: string } & Fields;

/**
 * The pure patch behind `updateAdded`: the row whose `clientId` matches takes the patch, everything
 * else is returned untouched.
 *
 * Extracted for the same reason as `appendRows` below — it is the third place an identity can be
 * spread over (#281), and the only way to prove it is not. The `clientId` is re-stamped AFTER the
 * patch: a patch is a `Partial<Fields>`, and while `NoRowIdentity` now stops a typed `Fields` from
 * declaring `clientId`, that guard is invisible to plain JS and to an `as` cast — which is exactly
 * how the original defect reached production through a type that looked fine.
 */
export function patchAdded<Fields extends Record<string, string>>(
  current: readonly AddedRow<Fields>[], clientId: string, patch: Partial<Fields>,
): AddedRow<Fields>[] {
  return current.map((a) => (a.clientId === clientId ? { ...a, ...patch, clientId } : a));
}

/**
 * The pure append behind `addRows` (fix-wave R4 finding 7): every row in `rows` gets its own
 * client id and lands, in order, after everything already there — in ONE pass over one copy.
 *
 * Extracted rather than inlined so the batch behaviour is unit-testable without a component-test
 * harness (this codebase has none; vitest runs `environment: "node"`) — the `computeOrphanChurn`
 * precedent above. Never mutates `current`: the hook hands it straight to a `setAdded` updater,
 * where mutating React's own previous state would be a bug independent of anything here.
 */
export function appendRows<Fields extends Record<string, string>>(
  current: readonly AddedRow<Fields>[], rows: readonly Fields[],
): AddedRow<Fields>[] {
  const next = current.slice();
  // The generated id spreads LAST, the #281 rule: a `Fields` carrying a `clientId` of its own would
  // otherwise overwrite it, and a row whose clientId is not its own can never be patched or removed.
  for (const row of rows) next.push({ ...row, clientId: newId() });
  return next;
}

/**
 * Merges one patch into an existing row's overlay and DROPS every field that matches the server
 * row's own value — returning `undefined` when nothing is left, i.e. the row is no longer edited.
 *
 * The pure decision behind `updateExisting`, extracted so it can be mutation-tested without a
 * component harness (the `computeOrphanChurn` / `appendRows` precedent above).
 *
 * Pruning, not merely ignoring (#279). Narrowing the `dirty` PREDICATE alone would leave the no-op
 * entry in the overlay, where `compose` still spreads it over the server row it equals — invisible,
 * unclearable (Save is disabled, and Save is the only thing that calls `reset`), and it re-arms
 * without any user action the moment another actor changes that row underneath it, because
 * `detectOrphans` returns early while the id set is unchanged. Removing the entry is what makes
 * "nothing to send" and "nothing overlaid" the same state. It also matches the settled answer in
 * `field-drafts.ts`: a field typed away and back to the server's value is no longer the user's, and
 * the server's copy shows through.
 *
 * Compared as STRINGS, exactly — never trimmed, never through `Number`. Composed values are the
 * strings the PUT carries (see the `Fields` note below), so `"5.00"` typed over a server `5` is a
 * real difference, and callers deliberately differ on trimming (`SerialsSection` trims `serial` at
 * save but sends `description` untrimmed), so a normalising comparison here would report a genuine
 * payload difference clean.
 *
 * The whole merged overlay is re-checked, not just the incoming patch's keys: a caller may write
 * several fields at once (the invoice grid stamps `priceSource`/`needsPrice` alongside an amount),
 * and a field left over from an earlier keystroke can be the one that just became equal.
 */
export function mergeEdit<Fields extends Record<string, string>>(
  current: Partial<Fields> | undefined, patch: Partial<Fields>, base: Fields,
): Partial<Fields> | undefined {
  const merged = { ...current, ...patch } as Partial<Fields>;
  for (const key of Object.keys(merged) as (keyof Fields)[]) {
    if (merged[key] === base[key]) delete merged[key];
  }
  return Object.keys(merged).length === 0 ? undefined : merged;
}

/**
 * The two names this hook OWNS on every composed row, declared as an impossible-to-satisfy shape so
 * that a `Fields` type claiming either one is a COMPILE ERROR at the call site rather than a silent
 * shadow at runtime (#281).
 *
 * Three names, not two: an ADDED row is identified by its `clientId` before it has a server id, so
 * a field of that name shadows an identity just as surely — and an added row that loses its
 * `clientId` can never be patched or removed, which is the same dead end by a different route.
 *
 * The members are optional string LITERALS on purpose: TypeScript reports the mismatch by printing
 * the literal, so the compiler itself tells the next author what is wrong and why. A plain
 * `key?: never` also rejects the call, but on the type PARAMETER it collapses `ComposedRow<Fields>`
 * to `never` and buries the one real message under dozens of "property does not exist on type
 * 'never'" — so the prohibition rides `toFields`'s RETURN TYPE, where it produces exactly one error,
 * at the call site, naming the offending property.
 */
type NoRowIdentity = {
  key?: "useBulkGrid supplies `key` — a Fields type must not declare one (#281)";
  isNew?: "useBulkGrid supplies `isNew` — a Fields type must not declare one (#281)";
  clientId?: "useBulkGrid supplies `clientId` — a Fields type must not declare one (#281)";
};

/**
 * The composed, render-ready row list — server rows (skipping any marked removed, mapped through
 * `toFields` and overlaid with whatever edit exists for the id) followed by locally-added rows.
 *
 * Pure and exported for the same reason as `computeOrphanChurn` / `appendRows` / `mergeEdit`: the
 * hook itself cannot be driven under vitest (environment "node", no component renderer), so this is
 * the only place the composition can be mutation-proven. It is NOT a re-supply hatch — a consumer
 * that calls it with its own rows would recreate the two-baselines drift #279 removed, and the
 * call-site sweep in tests/bulk-grid.test.ts refuses it.
 *
 * THE IDENTITY SPREADS LAST, in both branches, and that is the whole of #281. It used to spread
 * first, so a caller whose `Fields` declared a `key` overwrote it — the invoice grid's added charge
 * rows composed under `key: ""`, which matched no `clientId`, leaving a row that could not be typed
 * into, could not be removed, and held the grid dirty forever. Last-wins makes the identity
 * un-shadowable whatever a caller passes, and `NoRowIdentity` above stops the collision compiling
 * in the first place; neither alone is enough, because the type guard is invisible to plain JS and
 * an `as` cast, and the ordering is invisible to a reader who never looks.
 */
export function composeRows<Row extends BulkRow, Fields extends Record<string, string>>(params: {
  serverRows: readonly Row[];
  toFields: (row: Row) => Fields;
  edits: ReadonlyMap<string, Partial<Fields>>;
  added: readonly AddedRow<Fields>[];
  removedIds: ReadonlySet<string>;
}): ComposedRow<Fields>[] {
  const { serverRows, toFields, edits, added, removedIds } = params;
  return [
    ...serverRows
      .filter((r) => !removedIds.has(r.id))
      .map((r) => ({ ...toFields(r), ...(edits.get(r.id) ?? {}), key: r.id, isNew: false })),
    ...added.map((a) => ({ ...a, key: a.clientId, isNew: true })),
  ];
}

/**
 * The mode `useBulkGrid` reports (#483): its view's mode when the grid has recovery options, and
 * `editing` when it has none. A grid with no recovery options never binds, so its view is the
 * frozen empty view `useRecoverableDraft(null)` answers, whose mode is `loading` and never changes;
 * handed on as is, it would report a grid with nothing to recover as one still checking access.
 * The hook's `canEdit` is this mode being `editing` while no save of the grid's own is in
 * transport (`saving`; R23, #702).
 */
export function gridEditorMode(hasRecovery: boolean, viewMode: EditorMode): EditorMode {
  return hasRecovery ? viewMode : "editing";
}

/**
 * `Fields` is the flat, string-valued shape a grid's inputs are bound to (e.g. containers'
 * `{ typeId, count, pieces, tareEach, scaleGross }` — every value a plain string, same wire-shape
 * convention the order entry page uses throughout: what a text input can hold, converted to the
 * server's numbers/decimals only when a Save actually builds the request body).
 */

export type BulkRead<F> = { baseline: BulkBaseline<F>; editable: boolean; recoveryAllowed?: boolean };
export type BulkRecoveryOptions<F> = {
  record: RecordKey; kind: string; schema: string; label: string; childId?: string; scope?: string;
  href?: string; customization?: BulkRecoveryCustomization<F>;
  source: object;
  read(): Promise<BulkRead<F>>;
  register(listener: () => ((read: BulkRead<F> | null) => void) | null): () => void;
  rangeInput?: string;
};

/** Recovery owns one accepted baseline. Legacy callers temporarily keep the same
 * event reducer locally until their Task 4 registrations are installed. */
export function useBulkGrid<Row extends BulkRow, Fields extends Record<string, string>>(
  serverRows: readonly Row[], toFields: (row: Row) => Fields & NoRowIdentity,
  recovery?: BulkRecoveryOptions<Fields>,
) {
  type Data = BulkDraft<Fields>;
  type Base = BulkBaseline<Fields>;
  type Binding = EditorBinding<Data, Base, unknown, Base>;
  const { store, ...drafts } = useDraftIdentity();
  const [binding, setBinding] = useState<Binding | null>(null);
  const [local, setLocal] = useState<Data>(() => emptyBulkDraft<Fields>());
  const localRef = useRef(local);
  const localBaseRef = useRef<Base>({ rows: [], context: {} });
  const readRef = useRef(0);
  const optionsRef = useRef(recovery);
  const owner = drafts.owner;
  const authorizationRevision = peekBrowserDraftSession()?.getReadAuthorizationRevision() ?? 0;
  const recordId = recovery?.record.id;
  const recordKind = recovery?.record.kind;
  const kind = recovery?.kind;
  const schema = recovery?.schema;
  const childId = recovery?.childId;
  const source = recovery?.source;
  useEffect(() => { optionsRef.current = recovery; });
  useEffect(() => {
    const options = optionsRef.current;
    if (!options || !store) { setBinding(null); return; }
    // Keep the existing hidden binding during same-owner revalidation. The
    // authorization revision below schedules the fresh read after readiness.
    if (!owner) return;
    const adapter = createBulkRecoveryAdapter<Fields>(options.kind, options.schema, options.customization);
    setBinding(store.bind({ owner, record: options.record, editor: options.kind, childId: options.childId },
      { label: options.label, href: options.href ?? "/" + options.record.kind + "s/" + options.record.id, scope: options.scope }, adapter));
  }, [store, owner, recordId, recordKind, kind, schema, childId, source]);
  const view = useRecoverableDraft(binding);
  const mode = gridEditorMode(!!recovery, view.mode);
  // R23 (owner ruling 2026-10-22, #702): a grid closes its inputs while its own Save is in
  // transport, because the landed save installs the response baseline over an empty draft and
  // would drop anything typed meanwhile. The Save button's "Saving…" is what says why.
  const saving = !!recovery && view.pending === true;
  const retryRead = useCallback(() => {
    const options = optionsRef.current;
    const session = getBrowserDraftSession();
    const auth = session?.readAuthorizationTicket();
    if (!binding || !options || !session || !auth) return;
    const readId = binding.beginRead(); readRef.current = readId;
    const clean = emptyBulkDraft<Fields>(options.rangeInput);
    void options.read().then(result => {
      if (session.isReadAuthorized(auth)) binding.acceptRead({ kind: "authorized", readId, ...result }, clean);
    }, () => {
      if (session.isReadAuthorized(auth)) binding.acceptRead({ kind: "unavailable", readId }, clean);
    });
  }, [binding]);
  useEffect(() => {
    if (!binding || !drafts.identityReady) return;
    retryRead();
    const options = optionsRef.current;
    if (!options) return;
    return options.register(() => {
      const session = getBrowserDraftSession();
      const auth = session?.readAuthorizationTicket();
      if (!session || !auth) return null;
      const readId = binding.beginMountedRead();
      if (readId === null) return null;
      return result => {
        if (!session.isReadAuthorized(auth)) return;
        const clean = emptyBulkDraft<Fields>(options.rangeInput);
        const accepted = binding.acceptRead(result ? { kind: "authorized", readId, ...result } : { kind: "unavailable", readId }, clean);
        if (accepted) readRef.current = Math.max(readRef.current, readId);
      };
    });
  }, [binding, retryRead, drafts.identityReady, authorizationRevision]);
  useEffect(() => {
    // Known raw acknowledgement may precede parent acceptance (or unmount).
    // A real follow-up read, never Promise<void>, establishes fresh readiness.
    if (view.needsRefresh && !view.submitted) retryRead();
  }, [view.needsRefresh, view.submitted, retryRead]);

  const propBase: Base = { rows: serverRows.map(row => ({ id: row.id, fields: toFields(row) })), context: {} };
  useEffect(() => {
    if (recovery) return;
    const previous = localBaseRef.current;
    const current = localRef.current;
    const ids = new Set(serverRows.map(row => row.id));
    const churn = computeOrphanChurn({ liveIds: ids, priorLiveIds: new Set(previous.rows.map(row => row.id)),
      editKeys: current.edits.keys(), removedIds: current.removedIds });
    const nextBase: Base = { rows: serverRows.map(row => ({ id: row.id, fields: toFields(row) })), context: {} };
    localBaseRef.current = nextBase;
    if (churn.kind === "churned" && (churn.orphanedEditKeys.length || churn.orphanedRemovedIds.length)) {
      const edits = new Map(current.edits); for (const id of churn.orphanedEditKeys) edits.delete(id);
      const removedIds = new Set(current.removedIds); for (const id of churn.orphanedRemovedIds) removedIds.delete(id);
      const next = { ...current, edits, removedIds, orphanWarning: ORPHAN_WARNING };
      localRef.current = next; setLocal(next);
    }
  }, [serverRows, toFields, recovery]);

  const data = recovery ? (view.mode === "editing" ? view.current?.data : undefined) ?? emptyBulkDraft<Fields>(recovery.rangeInput) : local;
  const baseline = recovery ? (view.mode === "editing" ? view.current?.baseline : view.savedBaseline) ?? { rows: [], context: {} } : propBase;
  // Authorized non-editing views show fresh saved rows with empty overlays;
  // retained input remains exclusively in the selectable recovery reference.
  const rows = composeRows({
    serverRows: baseline.rows, toFields: row => row.fields, edits: data.edits, added: data.added, removedIds: data.removedIds,
  });
  function change(action: BulkAction<Fields>) {
    if (recovery) {
      if (!binding) return;
      binding.change(current => transitionBulkDraft(current, binding.getSnapshot().current!.baseline, action));
    } else {
      const next = transitionBulkDraft(localRef.current, propBase, action);
      localRef.current = next; setLocal(next);
    }
  }
  function reset() {
    if (recovery) {
      const current = binding?.getSnapshot().current;
      if (current) binding!.discard(current.stamp);
    } else {
      const next = emptyBulkDraft<Fields>(); localRef.current = next; setLocal(next);
    }
  }
  const customization = recovery?.customization;
  const adapter = useMemo(() => kind && schema ? createBulkRecoveryAdapter<Fields>(kind, schema, customization) : null, [kind, schema, customization]);
  const previews = useMemo(() => adapter ? bulkRecoveryPreviews(adapter, view) : {}, [adapter, view]);
  const recoveryNotice = recovery ? {
    mode: view.mode, canRestore: view.canRestore,
    hasCurrent: !!view.current, hasReference: !!view.reference,
    ...previews,
    restore: () => { if (view.current) binding?.restore(view.current.stamp, readRef.current); },
    discard: () => { if (view.current) binding?.discard(view.current.stamp); },
    discardReference: () => { if (view.reference) binding?.discard(view.reference.stamp); },
    startFresh: () => { binding?.startFresh(readRef.current, emptyBulkDraft<Fields>(recovery.rangeInput)); },
    retryRead,
  } : undefined;
  return {
    edits: data.edits, added: data.added, removedIds: data.removedIds,
    rows, dirty: bulkGridDirty(data), orphanWarning: data.orphanWarning,
    updateExisting: (id: string, patch: Partial<Fields>) => change({ kind: "edit", id, patch }),
    updateAdded: (id: string, patch: Partial<Fields>) => change({ kind: "patch-added", id, patch }),
    removeExisting: (id: string) => change({ kind: "remove-existing", id }),
    removeAdded: (id: string) => change({ kind: "remove-added", id }),
    addRow: (row: Fields) => { const clientId = newId(); change({ kind: "add", rows: [{ ...row, clientId }] }); return clientId; },
    addRows: (newRows: readonly Fields[], consumeRange = false) => {
      const added = appendRows<Fields>([], newRows); change({ kind: "add", rows: added, consumeRange });
    },
    reset, discard: reset, binding, view, recoveryNotice, mode,
    canEdit: mode === "editing" && !saving, saving,
    rangeInput: data.rangeInput ?? "",
    setRangeInput: (value: string) => change({ kind: "range", value }),
  };
}
