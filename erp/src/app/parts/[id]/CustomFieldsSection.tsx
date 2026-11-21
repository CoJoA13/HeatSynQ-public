"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { PanelMessage } from "@/components/PanelMessage";
import { api, ApiError } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { invalidateHistory } from "@/components/HistoryPanel";
import { partDraftHref } from "@/lib/part-tabs";
import { useUnsavedSection } from "@/lib/use-unsaved-section";
import { useDraftIdentity, useRecoverableDraft } from "@/lib/use-recoverable-draft";
import { getBrowserDraftSession, peekBrowserDraftSession } from "@/lib/draft-session";
import { DraftRecoveryNotice } from "@/components/DraftRecoveryNotice";
import { customFieldsRecoveryAdapter, customFieldsRows, prepareCustomFields, readCustomFields, type CustomFieldsBinding, type CustomFieldRow } from "@/lib/custom-fields-recovery";
import { newId } from "@/lib/client-id";
import { UnsavedBadge } from "@/components/UnsavedBadge";
import { DiscardButton } from "@/components/DiscardButton";
import { BUTTON_PRIMARY_COMPACT, CARD, INPUT_COMPACT } from "@/lib/ui-classes";

export function CustomFieldsSection({
  partId, perms,
}: {
  partId: string;
  perms: string[] | undefined;
}) {
  // This section's own message (owner ruling R1, P6 step 5c): its reads, saves and row actions
  // report here, through the shared PanelMessage, where they used to write the page banner. The
  // setter keeps the name `onError` that the handlers and the tests that lift them read.
  const [sectionMessage, onError] = useState<string | null>(null);
  const { store, ...drafts } = useDraftIdentity();
  const authorizationRevision = peekBrowserDraftSession()?.getReadAuthorizationRevision() ?? 0;
  const [binding, setBinding] = useState<CustomFieldsBinding | null>(null);
  const view = useRecoverableDraft(binding); const readIdRef = useRef(0); const mounted = useRef(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!store || !drafts.identityReady || !drafts.owner) { setBinding(null); return; }
    setBinding(store.bind({ owner: drafts.owner, record: { kind: "part", id: partId }, editor: customFieldsRecoveryAdapter.kind }, { label: "Custom fields", href: partDraftHref(partId, "files") }, customFieldsRecoveryAdapter));
  }, [store, drafts.identityReady, drafts.owner, partId]);
  const load = useCallback(async () => {
    const session = getBrowserDraftSession(); if (!binding || !session) return false;
    return readCustomFields({ binding, session, partId, readRows: () => api<CustomFieldRow[]>(`/api/parts/${partId}/fields`),
      readIdentity: () => api<{ id: string; permissions: string[] }>("/api/auth/me"), accepted: id => { readIdRef.current = id; } });
  }, [binding, partId]);
  useEffect(() => { void load(); }, [load, authorizationRevision]);

  const editing = view.mode === "editing" && !view.needsRefresh;
  const baseline = editing ? view.current?.baseline : view.savedBaseline;
  const rows = baseline ? editing && view.current ? customFieldsRows(view.current.data, baseline) : baseline.rows : [];
  const original = editing ? view.current?.data.original : undefined;
  const dirty = rows.filter(r => original && (!original.has(r.fieldId) || original.get(r.fieldId) !== r.value));
  const permission = gate(baseline ? [...baseline.permissions] : perms, "parts.edit");
  const canEdit = editing ? permission : { allowed: false, disabled: true, title: "Resolve retained fields and confirm current access before editing." };

  function setValue(fieldId: string, value: string) {
    if (canEdit.allowed) binding?.change(d => ({ ...d, values: new Map(d.values).set(fieldId, value) }));
  }

  // Not a `useBulkGrid`, but the same hazard and the same contract: an explicit Save means a
  // navigation can discard typed work, so the section declares itself (Codex P1 on !272).
  useUnsavedSection(dirty.length > 0, "Custom fields");

  // Not routed through the optimistic-then-rollback shape the other sections use: nothing here
  // is applied to the UI as if it had already succeeded, so a failed save has nothing to roll
  // back — the draft simply stays on screen exactly as typed, for the user to fix and retry,
  // same as the reason customers/[id]/page.tsx's add-address/add-contact drafts survive a
  // rejected POST. The SUCCESS path carries the mirror-image duty (#148): the inputs stay
  // editable during the PUT by design (the rule the old per-step process editor's `editsAfterSave`
  // stated), so the follow-up fetch must not wholesale-replace `rows` — `rowsAfterSave` keeps any
  // field whose draft moved while the request was in flight and takes the server's value
  // everywhere else, while `original` is always the server data (a kept in-flight edit stays
  // correctly dirty).
  async function save() {
    if (!binding || saving) return;
    const captured = prepareCustomFields(binding, newId()); if (!captured) return;
    setSaving(true);
    try {
      if (!binding.dispatched(captured.submission)) return;
      try {
        await api(`/api/parts/${partId}/fields`, { method: "PUT", body: JSON.stringify(captured.submission.payload) });
      } catch (error) {
        binding.settle(captured.submission, { kind: error instanceof ApiError && error.status < 500 ? "rejected" : "unknown" }); throw error;
      }
      binding.settle(captured.submission, { kind: "persisted", response: undefined });
      if (!mounted.current || binding.getSnapshot().current?.stamp.generation !== captured.submission.stamp.generation) return;
      onError(null);
      invalidateHistory(); // #14 item 1 — success path, before the follow-up load
      await load();
    } catch (e) {
      if (mounted.current) onError((e as Error).message);
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  // Discard (ruling 28, P7 step 8): the draft store's own discard of the copy being edited, which
  // rebuilds a clean copy from the last read and keeps the section editing (the quote page's
  // `discardChanges` precedent). Like a grid's, the section's message goes with it.
  function discardChanges() {
    if (binding && view.current) binding.discard(view.current.stamp);
    onError(null);
  }

  const previews = !["loading", "unavailable", "error"].includes(view.mode) && view.recoveryAllowed !== false;
  const notice = binding && <DraftRecoveryNotice mode={view.mode} canRestore={view.canRestore} hasCurrent={!!view.current} hasReference={!!view.reference}
    currentPreview={previews && view.mode !== "editing" && view.current ? customFieldsRecoveryAdapter.preview(view.current.data, view.current.baseline) : undefined}
    referencePreview={previews && view.reference ? customFieldsRecoveryAdapter.preview(view.reference.data, view.reference.baseline) : undefined}
    submittedPreview={previews && view.submitted ? customFieldsRecoveryAdapter.preview(view.submitted.data, view.submitted.baseline) : undefined}
    restore={() => { if (view.current) binding.restore(view.current.stamp, readIdRef.current); }}
    discard={() => { if (view.current) binding.discard(view.current.stamp); }} discardReference={() => { if (view.reference) binding.discard(view.reference.stamp); }}
    startFresh={view.savedBaseline ? () => { const rows = view.savedBaseline!.rows; binding.startFresh(readIdRef.current, { values: new Map(rows.map(r => [r.fieldId, r.value])), original: new Map(rows.map(r => [r.fieldId, r.value])) }); } : undefined}
    retryRead={() => { void load(); }} />;
  if (rows.length === 0) {
    return (
      <section className={`${CARD} mb-6`}>
        <h2 className="mb-2 font-medium">Custom fields</h2>
        {notice}
        <p className="text-sm text-ink-500">{baseline ? "No custom fields defined." : "Checking access to custom fields…"}</p>
      </section>
    );
  }

  return (
    <section className={`${CARD} mb-6`}>
      {notice}
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-medium">Custom fields</h2>
        <span className="inline-flex items-center gap-2">
          <button onClick={save} disabled={canEdit.disabled || dirty.length === 0 || saving} title={canEdit.title}
                  className={BUTTON_PRIMARY_COMPACT}>
            {saving ? "Saving…" : "Save custom fields"}
          </button>
          <DiscardButton section="Custom fields" dirty={dirty.length > 0} pending={saving} onDiscard={discardChanges} />
          <UnsavedBadge dirty={dirty.length > 0} />
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {rows.map((r) => (
          <label key={r.fieldId} className="block text-sm">
            {r.name}{!r.active && " (inactive)"}
            {r.type === "CHECKBOX" ? (
              <span className="ml-2 inline-flex items-center gap-2">
                <input type="checkbox" checked={r.value === "true"} disabled={!canEdit.allowed} title={canEdit.title}
                       onChange={(e) => setValue(r.fieldId, e.target.checked ? "true" : "false")} />
                {/* H3 (Codex round 3 review): a checkbox can only ever land on "true" or "false"
                    once touched, and since "false" is non-empty it counts as usage for the
                    field-def delete/type-change blockers (setPartFieldValues/partFieldDefBlockers)
                    — an unresolvable block, since nothing else in this control can ever produce
                    "". Shown only once there is something to clear, so it isn't dead space on
                    every already-unset checkbox field. Stages "" the same way every other edit
                    here does (setValue → dirty diff → Save), no server change needed: "" always
                    validates regardless of type (validateValue, src/server/part-field-values.ts). */}
                {r.value !== "" && (
                  <button type="button" onClick={() => setValue(r.fieldId, "")}
                          disabled={!canEdit.allowed} title="Clear this field (unset)"
                          className="text-xs text-ink-500 underline">
                    clear
                  </button>
                )}
              </span>
            ) : r.type === "DATE" ? (
              <input type="date" value={r.value} readOnly={!canEdit.allowed} title={canEdit.title}
                     onChange={(e) => setValue(r.fieldId, e.target.value)}
                     className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
            ) : r.type === "NUMBER" ? (
              <input value={r.value} inputMode="decimal" readOnly={!canEdit.allowed} title={canEdit.title}
                     onChange={(e) => setValue(r.fieldId, e.target.value)}
                     className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
            ) : (
              <input value={r.value} readOnly={!canEdit.allowed} title={canEdit.title}
                     onChange={(e) => setValue(r.fieldId, e.target.value)}
                     className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
            )}
          </label>
        ))}
      </div>
      <PanelMessage message={sectionMessage} />
    </section>
  );
}
