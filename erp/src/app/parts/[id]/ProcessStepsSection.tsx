"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelMessage } from "@/components/PanelMessage";
import { api, ApiError } from "@/lib/fetcher";
import { invalidateHistory } from "@/components/HistoryPanel";
import { gate } from "@/lib/permission-ui";
import { documentSteps, insertProcessStep, sameProcessContent, type ProcessDraftStep, type ProcessDocumentBaseline, type ProcessDocumentInput, type ProcessDocumentResult } from "@/lib/process-document";
import type { ProcessEditorCode } from "@/lib/process-editor-catalog";
import { UNDO_WINDOW_MS, expireUndo, focusAfterAdd, lockedRevisionNote, offerUndo, orderCountLabel, removeStepAt, stepFromCode, undoRemove, type UndoOffer } from "@/lib/process-table";
import { PREVIEW_VIEW_PERMISSIONS } from "@/lib/process-preview-plan";
import { ProcessStepTable, type StepFocus } from "./ProcessStepTable";
import { ProcessCodeSearch } from "./ProcessCodeSearch";
import { ProcessPreviewDialog } from "./ProcessPreviewDialog";
import { useUnsavedSection } from "@/lib/use-unsaved-section";
import { useDraftIdentity, useRecoverableDraft } from "@/lib/use-recoverable-draft";
import { getBrowserDraftSession, peekBrowserDraftSession } from "@/lib/draft-session";
import { DraftRecoveryNotice } from "@/components/DraftRecoveryNotice";
import { processStepsRecoveryAdapter, processDraftSteps, savedRecipeNumber, prepareProcessSteps, readProcessSteps, type ProcessStepsBinding, type ProcessCode, type ProcessRevision, type ProcessRevisionSummary, type ProcessStepsResponse } from "@/lib/process-steps-recovery";
import { newId } from "@/lib/client-id";
import { partDraftHref, type PartRecipe } from "@/lib/part-tabs";
import { BUTTON_NEUTRAL_COMPACT, BUTTON_PRIMARY_COMPACT, INPUT_COMPACT } from "@/lib/ui-classes";

/** Why Undo is disabled while a process or recipe-number save is open (the two share `pending`). */
const UNDO_PENDING_REASON = "Saving — Undo is unavailable until the save settles.";
/** Why Discard is disabled while either save is open: it resets the draft, and cannot unsend a request. */
const DISCARD_PENDING_REASON = "Saving — Discard is unavailable until the save settles.";

export function ProcessStepsSection({ partId, partLabel, perms, onRecipe }: {
  partId: string; partLabel?: string; perms: string[] | undefined;
  /** The saved recipe number and the current revision, for the page's subtitle and card; a stable
   *  setter, since the effect below depends on it. Whatever revision is selected, these do not move. */
  onRecipe?: (recipe: PartRecipe | null) => void;
}) {
  // This section's own message (owner ruling R1, P6 step 5c; G1-4): the recipe number's refusals,
  // a document the page refuses to send and a failed refresh after a save show here, beside the
  // controls, where they used to write the page banner seven sections up. A refused or failed
  // document save shows once, in `saveError`'s line, never here as well. The setter keeps the name
  // `onError` the handlers and the tests that lift them read.
  const [sectionMessage, onError] = useState<string | null>(null);
  const { store, ...drafts } = useDraftIdentity();
  const authorizationRevision = peekBrowserDraftSession()?.getReadAuthorizationRevision() ?? 0;
  const [binding, setBinding] = useState<ProcessStepsBinding | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const view = useRecoverableDraft(binding); const readIdRef = useRef(0); const mounted = useRef(false);
  const [codes, setCodes] = useState<readonly ProcessCode[]>([]);
  const [codesReady, setCodesReady] = useState(false);
  const [insertAt, setInsertAt] = useState<number | null>(null);
  const [focus, setFocus] = useState<StepFocus | null>(null);
  // The Undo bar (spec 2026-09-26 §4 "Remove"): the offer in state for rendering, mirrored in a
  // ref so a handler reads the latest one, and its single timer's id in a ref (Task 7's shape).
  const [undo, setUndo] = useState<UndoOffer>(null); const undoRef = useRef<UndoOffer>(null);
  const undoTimer = useRef<number | null>(null); const undoButton = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [pending, setPending] = useState(false); const pendingRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  // Spec §4 "Permissions": without processes.view the section is its frame and the missing
  // permission — decided from the page's own permission read, before any request is issued (the
  // recovery read would only 403 into the generic unavailable text). `undefined` means the page
  // has not answered yet, and decides nothing.
  const noView = perms !== undefined && !gate(perms, "processes.view").allowed;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!store || !drafts.identityReady || !drafts.owner) { setBinding(null); return; }
    setBinding(store.bind({ owner: drafts.owner, record: { kind: "part", id: partId }, editor: processStepsRecoveryAdapter.kind },
      { label: "Process steps", href: partDraftHref(partId, "process") }, processStepsRecoveryAdapter));
  }, [store, drafts.identityReady, drafts.owner, partId]);
  const load = useCallback(async (selectedRevision?: number | null) => {
    const session = getBrowserDraftSession(); if (!binding || !session) return false;
    return readProcessSteps({ binding, session, partId, selectedRevision,
      readRevisions: () => api<ProcessRevisionSummary[]>(`/api/parts/${partId}/process/revisions`),
      readRevision: revision => api<ProcessRevision>(`/api/parts/${partId}/process/revisions/${revision}`),
      readCodes: () => api<ProcessCode[]>("/api/process/editor-catalog"),
      readDocument: () => api<ProcessDocumentBaseline>(`/api/parts/${partId}/process/document`),
      readIdentity: () => api<{ id: string; permissions: string[] }>("/api/auth/me"),
      accepted: (id, presentation) => { readIdRef.current = id; setCodes(presentation.codes); setCodesReady(presentation.codesReady); } });
  }, [binding, partId]);
  useEffect(() => { if (noView) return; void load(); }, [load, authorizationRevision, noView]);

  const editing = view.mode === "editing" && !view.needsRefresh;
  const baseline = editing ? view.current?.baseline : view.savedBaseline;
  const selected = editing ? view.current?.data.selectedRevision ?? null : baseline?.selectedRevision ?? baseline?.highestRevision ?? null;
  const revisions = baseline?.summaries ?? [];
  const detail = selected === null ? undefined : baseline?.revisions.get(selected);
  const currentData = view.current?.data;
  const rows = useMemo(() => baseline ? processDraftSteps(editing && currentData ? currentData : { selectedRevision: selected, pendingRekey: null }, baseline, selected ?? 0) : [], [baseline, editing, currentData, selected]);
  const savedRows = useMemo(() => baseline ? processDraftSteps({ selectedRevision: selected, pendingRekey: null }, baseline, selected ?? 0) : [], [baseline, selected]);
  const processDirty = !sameProcessContent(rows, savedRows) || rows.some((row, index) => row.clientId !== savedRows[index]?.clientId);
  // Everything Discard would reset — every revision's ordered rows and the recipe-number edit —
  // judged by the adapter, the same predicate the unsaved-edit guard registers.
  const sectionDirty = !!view.current && processStepsRecoveryAdapter.dirty(view.current.data, view.current.baseline);
  const catalog = useMemo<readonly ProcessEditorCode[]>(() => baseline?.document?.codes ?? (baseline?.codes ?? codes).map(c => ({ ...c, defaultInstruction: "" })), [baseline, codes]);
  // A step whose code the catalog cannot name (the catalog read failed) still shows its saved code
  // and name; the fallback entries are inactive, so the search never offers them.
  const tableCatalog = useMemo<readonly ProcessEditorCode[]>(() => {
    const known = new Set(catalog.map(c => c.id)); const missing: ProcessEditorCode[] = [];
    for (const s of detail?.steps ?? []) if (!known.has(s.codeId)) { known.add(s.codeId); missing.push({ id: s.codeId, code: s.code, name: s.codeName, active: false, defaultInstruction: "", fields: [] }); }
    return missing.length ? [...catalog, ...missing] : catalog;
  }, [catalog, detail]);
  const document = useMemo<ProcessDocumentInput | null>(() => baseline?.document ? { expectedBaselineToken: baseline.document.baselineToken, steps: documentSteps(rows, baseline.document.codes) } : null, [baseline, rows]);
  const permission = gate(baseline ? [...baseline.permissions] : perms, "processes.edit");
  // Keep the specific denial from accepted access; permitted recovery still needs Restore.
  const canEdit = editing || (baseline && !permission.allowed) ? permission
    : { allowed: false, disabled: true, title: "Resolve retained steps and confirm current access before editing." };
  const highest = baseline?.highestRevision ?? null;
  const isCurrent = selected !== null && selected === highest;
  const readOnly = revisions.length > 0 && !isCurrent;
  const selectedMeta = revisions.find(r => r.revisionNumber === selected);
  const rowDisabled = canEdit.disabled || readOnly;
  const rowTitle = readOnly ? "Superseded revision — read-only" : canEdit.title;
  const isCurrentLocked = isCurrent && !!selectedMeta?.lockedAt;
  const savedNumber = baseline ? savedRecipeNumber(baseline) : null;
  const hasBaseline = !!baseline;
  useEffect(() => { onRecipe?.(hasBaseline ? { recipeNumber: savedNumber, revision: highest } : null); }, [onRecipe, hasBaseline, savedNumber, highest]);
  const recipeUsed = revisions.some(r => r.lockedAt && r.recipeNumber != null);
  const numberDisabled = rowDisabled || recipeUsed;
  const numberTitle = rowDisabled ? rowTitle : recipeUsed ? "A recipe number used by an order cannot be changed or removed." : undefined;
  const numberValue = editing && !readOnly && currentData?.recipeNumberEdit !== undefined ? currentData.recipeNumberEdit ?? "" : (readOnly ? detail?.recipeNumber : savedNumber) ?? "";
  const numberDirty = currentData?.recipeNumberEdit !== undefined && currentData.recipeNumberEdit !== savedNumber;
  // Discard (ruling D-2, #309): section-owned and always rendered, disabled with its reason — the
  // row reason (permission, superseded revision, retained work, a needed refresh: `binding.change`
  // does nothing outside editing), then a save in flight, then nothing to discard.
  const discardDisabled = rowDisabled || pending || !sectionDirty;
  const discardTitle = rowDisabled ? rowTitle : pending ? DISCARD_PENDING_REASON : !sectionDirty ? "No unsaved changes" : undefined;
  // Preview traveler (spec §5): parts.view and processes.view only — a viewer without orders.view
  // gets the SAMPLE header inside the dialog — and never on a superseded revision or over
  // unresolved recovery work, for the reasons the side panel used to print.
  const previewPermitted = PREVIEW_VIEW_PERMISSIONS.every(p => (baseline ? baseline.permissions : perms ?? []).includes(p));
  const previewReason = readOnly ? "Historical revision — select the current revision to preview a local process draft." : !editing && permission.allowed ? "Resolve retained process work before previewing." : view.needsRefresh ? "Refresh process access before previewing." : undefined;
  const previewTitle = !previewPermitted ? "Requires parts.view and processes.view" : !document ? "Checking process…" : previewReason;
  const previewDisabled = previewTitle !== undefined;
  function changeRows(next: ProcessDraftStep[]) {
    if (rowDisabled) return;
    binding?.change(d => ({ ...d, orderedEdits: new Map(d.orderedEdits).set(selected ?? 0, next) }));
  }
  function applyRows(next: ProcessDraftStep[], nextFocus?: StepFocus) {
    if (rowDisabled) return;
    changeRows(next); if (nextFocus) setFocus(nextFocus);
  }
  const clearUndo = useCallback(() => {
    if (undoTimer.current !== null) { window.clearTimeout(undoTimer.current); undoTimer.current = null; }
    undoRef.current = null; setUndo(null);
  }, []);
  // Ruling D-2: a successful save deletes the removed step server-side and a revision change
  // moves to another id space, so Undo after either would reinsert an id the baseline no longer
  // holds and every later save would 400. The two saves clear it explicitly; this covers every
  // path that lands on another revision (the picker, a cut, Restore, Current revision).
  useEffect(() => { clearUndo(); }, [selected, clearUndo]);
  // An unknown-outcome save may have committed the deletion as well (whole-branch review,
  // Important 1). Either save's unknown outcome suspends editing (the adapter answers `reference`
  // with a refresh needed), and a reconciling read or the notice's Discard resumes it on the SAME
  // revision number, so the effect above never fires. Clearing whenever editing is suspended
  // covers that and every other suspension (a re-read, a conflict, lost access). A refused save
  // keeps `editing`, so its offer stays, and no offer is armed while editing is suspended
  // (`rowDisabled`).
  useEffect(() => { if (!editing) clearUndo(); }, [editing, clearUndo]);
  useEffect(() => () => { if (undoTimer.current !== null) window.clearTimeout(undoTimer.current); }, []);
  function removeStep(index: number) {
    if (rowDisabled) return;
    const { steps, removed } = removeStepAt(rows, index);
    changeRows(steps);
    const offer = offerUndo(undoRef.current, removed);
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => {
      // By token, never by identity of the timer: a superseded timer that still fires leaves a
      // newer offer alone (`expireUndo`).
      if (undoRef.current?.token === offer.token) { undoRef.current = null; undoTimer.current = null; }
      setUndo(current => expireUndo(current, offer.token));
    }, UNDO_WINDOW_MS);
    undoRef.current = offer; setUndo(offer);
    requestAnimationFrame(() => undoButton.current?.focus());
  }
  function undoAction() {
    const offer = undoRef.current;
    // Refused while either save is in flight (review, fix round 1): the request may be deleting
    // the removed step or cutting a revision, so a reinserted row would ride through settlement
    // with a dead id and 400 every later save. The offer itself stays — a refused save deletes
    // nothing — which is why the guard sits before `clearUndo()`.
    if (!offer || rowDisabled || pendingRef.current) return;
    clearUndo();
    applyRows(undoRemove(rows, offer.removed), { clientId: offer.removed.step.clientId, target: { kind: "handle" } });
  }
  function discardAction() {
    // One click, the Quote precedent (#309): every ordered draft and the recipe-number edit go back
    // to the saved baseline. The removed row an Undo offer holds is part of that draft, so the
    // offer goes with it, as do an open insert position and a failed save's "draft retained".
    if (discardDisabled || !binding) return;
    binding.change(d => ({ ...d, orderedEdits: new Map(), recipeNumberEdit: undefined }));
    clearUndo(); setInsertAt(null); setSaveError(null);
  }
  function openInsert(index: number) {
    if (rowDisabled) return;
    // The table focuses the chip or ⋮ button before asking, so this is the control to return to.
    // (`window.document`: the bare name is this component's process document.)
    const active = window.document.activeElement;
    openerRef.current = active instanceof HTMLElement ? active : null;
    setInsertAt(index);
    requestAnimationFrame(() => sectionRef.current?.querySelector<HTMLInputElement>('input[role="combobox"]')?.focus());
  }
  function cancelInsert() {
    setInsertAt(null);
    const opener = openerRef.current; openerRef.current = null;
    opener?.focus();
  }
  function pickCode(code: ProcessEditorCode) {
    const step = stepFromCode(code, `new:${newId()}`);
    // Clamped (pre-flight M4): rows may have been removed while the search stayed open at a
    // later position, and `insertProcessStep` throws past the end.
    applyRows(insertProcessStep(rows, Math.min(insertAt ?? rows.length, rows.length), step), { clientId: step.clientId, target: focusAfterAdd(step) });
    setInsertAt(null); openerRef.current = null;
  }
  useUnsavedSection(sectionDirty, "Process steps");
  // #657: the save's answer already carries the fresh baseline; this refresh reads the summaries
  // and identity anew, and the status says so meanwhile ("Saved — refreshing…"), keeping "Saved
  // state needs refresh" for a refresh that failed or a save whose outcome is unknown.
  const [refreshing, setRefreshing] = useState(false);
  async function refreshAfter(revisionNumber: number | null) {
    setRefreshing(true);
    try {
      if (!await load(revisionNumber === null ? undefined : revisionNumber) && mounted.current) onError("Saved, but the process steps could not be reloaded. Retry the recovery read to see current state.");
    } finally { if (mounted.current) setRefreshing(false); }
  }
  // #659: a 409 means the baseline the draft was captured against is stale (the server's token:
  // another user's save, or a catalog edit). The adapter settles the draft as rejected and keeps
  // it in editing mode, and nothing read, so every later Save resent the same token and was
  // refused again. Read the section again, after `settle` and detached: the store's conflict
  // check finds the changed token and lands conflict mode (Restore, Discard, Start fresh), with
  // the refusal still shown. The section's own `load()` rather than the adapter's
  // `allowRejectedFollowUp` (the template editor's), which needs the rejected submission noted
  // before settle and a rollback phase this adapter has no other use for. A 400 is a validation
  // refusal a read does nothing for; a 5xx settles as unknown, which suspends editing itself.
  function readAgainIfStale(error: unknown) {
    if (error instanceof ApiError && error.status === 409) void load().catch(() => {});
  }
  async function saveRecipeNumberAction() {
    if (!binding || numberDisabled || pendingRef.current) return;
    const captured = prepareProcessSteps(binding, { kind: "recipe-number", recipeNumber: numberValue || null, expectedRecipeNumber: savedNumber }, newId());
    if (!captured || !binding.dispatched(captured.submission) || captured.submission.payload.kind !== "recipe-number") return;
    pendingRef.current = true; setPending(true);
    const { recipeNumber, expectedRecipeNumber } = captured.submission.payload;
    let res: ProcessStepsResponse;
    try { res = await api<ProcessStepsResponse>(`/api/parts/${partId}/process/recipe-number`, { method: "PATCH", body: JSON.stringify({ recipeNumber, expectedRecipeNumber }) }); }
    catch (error) { binding.settle(captured.submission, { kind: error instanceof ApiError && error.status < 500 ? "rejected" : "unknown" }); if (mounted.current) onError((error as Error).message); readAgainIfStale(error); return; }
    finally { pendingRef.current = false; if (mounted.current) setPending(false); }
    binding.settle(captured.submission, { kind: "persisted", response: res });
    clearUndo();
    if (!mounted.current || binding.getSnapshot().current?.stamp.generation !== captured.submission.stamp.generation) return;
    try { invalidateHistory(); onError(null); await refreshAfter(res.revisionNumber); }
    catch (error) { if (mounted.current) onError((error as Error).message); }
  }
  async function saveProcessAction() {
    if (!binding || rowDisabled || !document || pendingRef.current) return;
    let captured;
    try { captured = prepareProcessSteps(binding, { kind: "document", document }, newId()); }
    catch (error) { onError((error as Error).message); return; }
    if (!captured || captured.submission.payload.kind !== "document" || !binding.dispatched(captured.submission)) return;
    pendingRef.current = true; setPending(true); setSaveError(null);
    let result: ProcessDocumentResult;
    try { result = await api<ProcessDocumentResult>(`/api/parts/${partId}/process/document`, { method: "PUT", body: JSON.stringify(captured.submission.payload.document) }); }
    catch (error) { binding.settle(captured.submission, { kind: error instanceof ApiError && error.status < 500 ? "rejected" : "unknown" }); if (mounted.current) setSaveError((error as Error).message); readAgainIfStale(error); return; }
    finally { pendingRef.current = false; if (mounted.current) setPending(false); }
    const response = { revisionNumber: result.baseline.revision?.revisionNumber ?? null, document: result };
    binding.settle(captured.submission, { kind: "persisted", response });
    clearUndo();
    if (!mounted.current || binding.getSnapshot().current?.stamp.generation !== captured.submission.stamp.generation) return;
    try { invalidateHistory(); onError(null); await refreshAfter(response.revisionNumber); }
    catch (error) { if (mounted.current) onError((error as Error).message); }
  }
  const previews = !["loading", "unavailable", "error"].includes(view.mode) && view.recoveryAllowed !== false;
  const notice = binding && <DraftRecoveryNotice mode={view.mode} canRestore={view.canRestore} hasCurrent={!!view.current} hasReference={!!view.reference}
    currentPreview={previews && view.mode !== "editing" && view.current ? processStepsRecoveryAdapter.preview(view.current.data, view.current.baseline) : undefined}
    referencePreview={previews && view.reference ? processStepsRecoveryAdapter.preview(view.reference.data, view.reference.baseline) : undefined}
    submittedPreview={previews && view.submitted ? processStepsRecoveryAdapter.preview(view.submitted.data, view.submitted.baseline) : undefined}
    restore={() => { if (view.current) binding.restore(view.current.stamp, readIdRef.current); }}
    discard={() => { if (view.current) binding.discard(view.current.stamp); }} discardReference={() => { if (view.reference) binding.discard(view.reference.stamp); }}
    startFresh={view.savedBaseline ? () => { binding.startFresh(readIdRef.current, { selectedRevision: view.savedBaseline!.selectedRevision ?? view.savedBaseline!.highestRevision, pendingRekey: null }); } : undefined}
    retryRead={() => { void load(); }} />;

  if (noView) return <section ref={sectionRef} className="mb-6 rounded-lg border bg-surface-0">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3"><div><h2 className="font-semibold">Process steps</h2><p className="text-xs text-ink-500">{partLabel ?? partId}</p></div></div>
    <p className="p-4 text-sm text-ink-500">Process steps need processes.view access.</p>
  </section>;
  return <section ref={sectionRef} className="mb-6 rounded-lg border bg-surface-0">
    <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b bg-surface-0 px-4 py-3">
      <div><h2 className="font-semibold">Process steps</h2><p className="text-xs text-ink-500">{partLabel ?? partId} · Recipe {savedNumber ?? "unassigned"} · {selected === null ? "New process" : `Revision ${selected}`}</p></div>
      <div className="flex flex-wrap items-center gap-3"><span role="status" className="text-xs text-ink-500">{pending ? "Saving…" : saveError ? "Save failed — draft retained" : refreshing ? "Saved — refreshing…" : view.needsRefresh ? "Saved state needs refresh" : processDirty ? "Unsaved process changes" : baseline ? "Process saved" : "Checking process"}</span>
        <button type="button" onClick={discardAction} disabled={discardDisabled} title={discardTitle} className={BUTTON_NEUTRAL_COMPACT}>Discard process changes</button>
        <button type="button" onClick={() => setPreviewOpen(true)} disabled={previewDisabled} title={previewTitle} className={BUTTON_NEUTRAL_COMPACT}>Preview traveler</button>
        <button type="button" onClick={saveProcessAction} disabled={rowDisabled || pending || !document || !processDirty} title={rowDisabled ? rowTitle : pending ? "Saving…" : !processDirty ? "No unsaved changes" : undefined} className={BUTTON_PRIMARY_COMPACT}>Save process steps</button>
      </div>
    </div>
    <div className="p-4">
      {notice}
      {!baseline && <p className="text-sm text-ink-500">{view.mode === "unavailable" ? "Process steps unavailable. Confirm current processes.view access and retry the recovery read." : "Checking access to process steps…"}</p>}
      {saveError && <p role="alert" className="mb-3 text-sm text-red-700">{saveError}</p>}
      {revisions.length > 0 && <div className="mb-3 flex flex-wrap items-center gap-2">
        <select aria-label="Process revision" value={selected ?? ""} disabled={pending} onChange={e => { void load(Number(e.target.value)); }} className={INPUT_COMPACT}>{revisions.map(r => <option key={r.revisionNumber} value={r.revisionNumber}>{`Rev ${r.revisionNumber} · ${orderCountLabel(r.orderCount)}`}</option>)}</select>
        <span className="rounded-full bg-surface-50 px-2 py-0.5 text-xs text-ink-800">Rev {selected} · {selectedMeta?.lockedAt ? "locked" : "working"}</span>
        {isCurrentLocked && selected !== null && selectedMeta && <span className="rounded bg-accent-50 px-2 py-0.5 text-xs text-accent-600">{lockedRevisionNote(selected, selectedMeta.orderCount)}</span>}
        {readOnly && selected !== null && <>
          <span className="text-xs text-ink-800">{`Rev ${selected} is superseded and read-only.`}</span>
          <button type="button" onClick={() => { if (highest !== null) void load(highest); }} disabled={pending} className="rounded border px-2 py-1 text-xs">Current revision</button>
        </>}
      </div>}
      <p className="mb-3 text-xs text-ink-500">Changes apply to future orders. Existing orders keep their saved process revision.</p>
      {baseline && <div className="mb-4 flex flex-wrap items-end gap-2">
        <label className="block text-sm">Recipe number<input type="text" value={numberValue} disabled={numberDisabled} title={numberTitle} onChange={e => binding?.change(d => ({ ...d, recipeNumberEdit: e.target.value === "" ? null : e.target.value }))} className={`${INPUT_COMPACT} mt-1 block w-40 disabled:bg-surface-50`} /></label>
        <button type="button" onClick={saveRecipeNumberAction} disabled={numberDisabled || pending || !numberDirty} title={numberTitle} className={BUTTON_PRIMARY_COMPACT}>Save recipe</button>
        {recipeUsed && <p className="text-xs text-ink-500">Used by an order — recipe number cannot be changed or removed.</p>}
      </div>}
      <PanelMessage message={sectionMessage} />
      <ProcessStepTable rows={rows} catalog={tableCatalog} disabled={rowDisabled} title={rowTitle} focus={focus} onChange={applyRows} onInsertAt={openInsert} onRemove={removeStep} />
      <div role="status" aria-live="polite" className="mt-2 min-h-6 text-sm">
        {undo && <span className="inline-flex items-center gap-3 rounded border border-line bg-surface-50 px-3 py-1">
          Step {undo.removed.index + 1} removed.
          <button ref={undoButton} type="button" onClick={undoAction} disabled={rowDisabled || pending} title={pending ? UNDO_PENDING_REASON : rowTitle} className="font-medium underline">Undo</button>
        </span>}
      </div>
      <ProcessCodeSearch catalog={baseline?.permissions.includes("processes.view") ? catalog : []} disabled={rowDisabled || !codesReady}
        title={rowDisabled ? rowTitle : codesReady ? undefined : "Process codes could not be loaded. Retry the recovery read."}
        insertAt={insertAt} stepCount={rows.length} onPick={pickCode} onCancel={cancelInsert} />
      <ProcessPreviewDialog open={previewOpen} onClose={() => setPreviewOpen(false)} partId={partId} document={document} permissions={baseline?.permissions ?? []}
        generation={view.current?.stamp.version ?? 0} authorizationRevision={authorizationRevision} unavailableReason={previewReason} />
    </div>
  </section>;
}
