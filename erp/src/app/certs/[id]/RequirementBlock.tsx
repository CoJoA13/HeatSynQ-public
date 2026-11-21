"use client";
// One seeded requirement (spec §6.3): the frozen fields READ-ONLY on top — code, scale, min,
// max, sample qty, location are COPIED from the part's inspections at cert creation and frozen
// by design (§4.1); editing the part next month must not rewrite a cert already being filled in
// — and the editable readings grid underneath: value, computed pass/fail (the exact same
// `computePassed` the server runs, so the screen never disagrees with what gets stored), an
// explicit override toggle, and a note.
//
// The document-owned binding retains one raw draft per cert/requirement business key.
// Dispatched success and failure retire only their captured generation. Parent reset counters
// control presentation refresh; they never identify or erase another generation.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Gate } from "@/lib/permission-ui";
import { computePassed } from "@/lib/pass-fail";
import type { CertDetailData, CertRequirementRow } from "./CertDetail";
import { api } from "@/lib/fetcher";
import { getBrowserDraftSession, peekBrowserDraftSession } from "@/lib/draft-session";
import { useDraftIdentity, useRecoverableDraft } from "@/lib/use-recoverable-draft";
import { DraftRecoveryNotice } from "@/components/DraftRecoveryNotice";
import {
  certReadingsRecoveryAdapter, certReadingsDraftFrom, readingRows, readCertReadings, prepareCertReadings,
  editCertReading, addCertReading, removeCertReading,
  type CertReadingsBinding, type CertReadingsRow as DraftRow, type CapturedCertReadings,
} from "@/lib/cert-readings-recovery";
import { useUnsavedSection } from "@/lib/use-unsaved-section";
import { newId } from "@/lib/client-id";
import { readFinishedDecimal } from "@/lib/decimal-entry";
import { READING_VALUE } from "@/lib/part-boxes";
import { batchedRead } from "@/lib/batched-read";
import { UnsavedBadge } from "@/components/UnsavedBadge";
import { DiscardButton } from "@/components/DiscardButton";
import { BADGE_WARNING, INPUT_COMPACT, NOTICE, BADGE_DANGER } from "@/lib/ui-classes";
import { requiredText, valueHeading } from "@/lib/cert-tabs";

/** The page's blocks read the cert and /me through one batched reader each per cert (#701): the
 *  blocks mount in one commit, so one task's reads are one request. The readers hold nothing past a
 *  flight's send (`batchedRead`) and the map is pruned when a cert's reads settle. */
const certReaders = new Map<string, { cert: () => Promise<CertDetailData>; identity: () => Promise<{ id: string; permissions: string[] }> }>();
function sharedCertReaders(certId: string) {
  let readers = certReaders.get(certId);
  if (!readers) {
    const prune = <T,>(p: Promise<T>) => { const drop = () => { if (certReaders.get(certId) === readers) certReaders.delete(certId); }; p.then(drop, drop); return p; };
    const cert = batchedRead(() => prune(api<CertDetailData>(`/api/certs/${certId}`)));
    const identity = batchedRead(() => prune(api<{ id: string; permissions: string[] }>("/api/auth/me")));
    readers = { cert, identity }; certReaders.set(certId, readers);
  }
  return readers;
}

// The verdict judges the figure; refusing a figure below zero is Save's job (READING_VALUE.box is nonnegative).
const VERDICT_BOX = { intDigits: READING_VALUE.box.intDigits, scale: READING_VALUE.box.scale };

/** One reading as PUT /api/certs/[id]/results accepts it. `value` crosses as the typed decimal
 *  string (`decimalField(10, 4)` accepts a decimal string); `passed` is only meaningful when
 *  `overridden` — otherwise the server recomputes it against the frozen min/max. */
export type ReadingPayload = {
  value: string | null; passed: boolean | null; overridden: boolean; note: string;
};

/** The row's on-screen verdict — three states, never two (the Task 15 review finding): an empty
 *  value is PENDING (`null`), not a pass and not a fail. An overridden row's verdict is whatever
 *  the override says; otherwise it is `computePassed` against the frozen min/max, exactly what
 *  the server will store on save. */
function rowVerdict(row: DraftRow, min: number | null, max: number | null): boolean | null {
  if (row.overridden) {
    return row.passedChoice === "pass" ? true : row.passedChoice === "fail" ? false : null;
  }
  const value = readFinishedDecimal(row.value, VERDICT_BOX);
  if (value === null) return null; // nothing judgeable yet
  return computePassed(value, min, max);
}

function VerdictBadge({ verdict }: { verdict: boolean | null }) {
  if (verdict === true) {
    return <span className="rounded bg-success-50 px-1.5 py-0.5 text-xs font-medium text-success-700">Pass</span>;
  }
  if (verdict === false) {
    return <span className={BADGE_DANGER}>Fail</span>;
  }
  return <span className={BADGE_WARNING}>Pending</span>;
}

function Frozen({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="text-ink-500">{label}</span> <b>{value}</b>
    </span>
  );
}

export function RequirementBlock({ certId, requirement, editGate: parentEditGate, onSave }: {
  certId: string;
  requirement: CertRequirementRow;
  editGate: Gate;
  onSave: (requirementId: string, readings: ReadingPayload[], captured: CapturedCertReadings) => Promise<void>;
}) {
  const { store, ...drafts } = useDraftIdentity();
  const authorizationRevision = peekBrowserDraftSession()?.getReadAuthorizationRevision() ?? 0;
  const [binding, setBinding] = useState<CertReadingsBinding | null>(null);
  const view = useRecoverableDraft(binding);
  const readIdRef = useRef(0);
  const requirementId = requirement.id;
  useEffect(() => {
    if (!store || !drafts.identityReady || !drafts.owner) { setBinding(null); return; }
    setBinding(store.bind({ owner: drafts.owner, record: { kind: "cert", id: certId },
      editor: certReadingsRecoveryAdapter.kind, childId: requirementId },
    { label: "Cert results", href: `/certs/${certId}` }, certReadingsRecoveryAdapter));
  }, [store, drafts.identityReady, drafts.owner, certId, requirementId]);
  const loadRecovery = useCallback(async () => {
    const session = getBrowserDraftSession();
    if (!binding || !session) return;
    const readers = sharedCertReaders(certId);
    await readCertReadings({ binding, session, certId, requirementId,
      readCert: readers.cert,
      readIdentity: readers.identity,
      accepted: readId => { readIdRef.current = readId; },
    });
  }, [binding, certId, requirementId]);
  useEffect(() => { void loadRecovery(); }, [loadRecovery, authorizationRevision]);
  // The page's gate changes re-read the block (a void or a print moves `deletedAt`/`printedAt`,
  // which decide Restore), but not its FIRST false-to-true flip: that is the page's permissions
  // landing after the cert, and the block's own read already carries the permissions (#701).
  const gateSeen = useRef(parentEditGate.allowed); const gateEverTrue = useRef(parentEditGate.allowed);
  useEffect(() => {
    const was = gateSeen.current; const now = parentEditGate.allowed; gateSeen.current = now;
    if (was === now) return;
    if (!was && now && !gateEverTrue.current) { gateEverTrue.current = true; return; }
    gateEverTrue.current = gateEverTrue.current || now;
    void loadRecovery();
  }, [parentEditGate.allowed, loadRecovery]);
  // Same-path Return from Drafts in this tab still needs a real fresh read.
  useEffect(() => {
    const session = getBrowserDraftSession(); const owner = drafts.owner;
    if (!session || !binding || !owner) return;
    const key = { owner, record: { kind: "cert", id: certId }, editor: certReadingsRecoveryAdapter.kind, childId: requirementId };
    const selected = () => { if (session.consumeSelection(key)) void loadRecovery(); };
    const unsubscribe = session.subscribeSelection(selected); selected(); return unsubscribe;
  }, [binding, drafts.owner, certId, requirementId, loadRecovery]);

  const savedRequirement = view.savedBaseline?.requirement;
  // Until the block's own read lands (after a save it is re-keyed and reads again) the parent's
  // row, which the PUT's answer updated, is shown read-only (#701): the gate below is closed
  // while the view is not editing, so nothing from it can be typed into or saved.
  const shownRequirement = savedRequirement ?? requirement;
  const data = view.mode === "editing" ? view.current?.data : view.savedBaseline ? certReadingsDraftFrom(view.savedBaseline) : undefined;
  const rows = data?.rows ?? (savedRequirement ? [] : readingRows(requirement.readings));
  const dirty = view.current?.data.dirty ?? false;
  useUnsavedSection(dirty, "Cert results");
  const editGate = view.mode !== "editing" || !view.current || view.needsRefresh
    ? { allowed: false, disabled: true, title: "Confirm access and resolve retained readings before editing" } : parentEditGate;
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  function edit(key: number, patch: Partial<Omit<DraftRow, "key">>) {
    if (editGate.allowed) binding?.change(data => editCertReading(data, key, patch));
  }
  function addRow() {
    if (editGate.allowed) binding?.change(addCertReading);
  }
  function removeRow(key: number) {
    if (editGate.allowed) binding?.change(data => removeCertReading(data, key));
  }
  // Discard (ruling 28, P7 step 8): the draft store's own discard of the copy being edited, which
  // rebuilds a clean copy from the last read and keeps the block editing (the quote page's
  // `discardChanges` precedent). Like a grid's, the block's message goes with it.
  function discardChanges() {
    if (binding && view.current) binding.discard(view.current.stamp);
    setLocalError(null);
  }
  async function save() {
    if (!binding || !editGate.allowed || saving) return;
    const prepared = prepareCertReadings(binding, newId());
    if (prepared.kind === "refused") { setLocalError(prepared.error); return; }
    setLocalError(null); setSaving(true);
    try {
      await onSave(requirement.id, prepared.captured.submission.payload, prepared.captured);
    } finally { setSaving(false); }
  }
  const previewsVisible = view.mode !== "loading" && view.mode !== "unavailable" && view.mode !== "error";


  return (
    <div className="mb-3 rounded border border-line p-3 last:mb-0">
      <DraftRecoveryNotice mode={view.mode} canRestore={view.canRestore} hasCurrent={!!view.current} hasReference={!!view.reference}
        currentPreview={previewsVisible && view.mode !== "editing" && view.current ? certReadingsRecoveryAdapter.preview(view.current.data, view.current.baseline) : undefined}
        referencePreview={previewsVisible && view.reference ? certReadingsRecoveryAdapter.preview(view.reference.data, view.reference.baseline) : undefined}
        restore={() => { if (view.current) binding?.restore(view.current.stamp, readIdRef.current); }}
        discard={() => { if (view.current) binding?.discard(view.current.stamp); }}
        discardReference={() => { if (view.reference) binding?.discard(view.reference.stamp); }}
        startFresh={() => { if (view.savedBaseline) binding?.startFresh(readIdRef.current, certReadingsDraftFrom(view.savedBaseline)); }}
        retryRead={() => { void loadRecovery(); }} />
      {shownRequirement && <>
      {/* Frozen fields — read-only by design (§4.1), rendered as text, not inputs. */}
      <div className="mb-2 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
        <span className="font-medium">
          {shownRequirement.position}. {shownRequirement.inspectionCodeName}
        </span>
        <span>{requiredText(shownRequirement)}</span>
        <Frozen label="Sample qty" value={shownRequirement.sampleQty || "—"} />
        <Frozen label="Location" value={shownRequirement.location || "—"} />
        <span className="text-xs text-ink-500">
          Frozen when this certification was created — part changes never rewrite it.
        </span>
      </div>

      {localError && <p className={`${NOTICE.refusal} mb-2 whitespace-pre-line`}>{localError}</p>}

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-ink-500">
            <th className="w-8 py-1 font-medium">#</th>
            <th className="w-36 font-medium">{valueHeading(shownRequirement.scaleName)}</th>
            <th className="w-40 font-medium">Pass/fail <span className="font-normal text-ink-500">(screen only)</span></th>
            <th className="w-24 font-medium">Override</th>
            <th className="font-medium">Note</th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.key} className="border-t">
              <td className="py-1 text-ink-500">{i + 1}</td>
              <td className="pr-2">
                <input value={row.value} inputMode="decimal"
                       readOnly={!editGate.allowed} title={editGate.title}
                       onChange={(e) => edit(row.key, { value: e.target.value })}
                       className={`${INPUT_COMPACT} w-full read-only:bg-surface-50`} />
              </td>
              <td className="pr-2">
                {row.overridden ? (
                  <select value={row.passedChoice} disabled={!editGate.allowed} title={editGate.title}
                          onChange={(e) => edit(row.key, { passedChoice: e.target.value as DraftRow["passedChoice"] })}
                          className={`${INPUT_COMPACT} disabled:cursor-not-allowed disabled:bg-surface-50`}>
                    <option value="">Pending</option>
                    <option value="pass">Pass</option>
                    <option value="fail">Fail</option>
                  </select>
                ) : (
                  <VerdictBadge verdict={rowVerdict(row, shownRequirement.min, shownRequirement.max)} />
                )}
              </td>
              <td className="pr-2">
                <label className="flex items-center gap-1 text-xs text-ink-500" title={editGate.title}>
                  <input type="checkbox" checked={row.overridden} disabled={!editGate.allowed}
                         onChange={(e) => edit(row.key, { overridden: e.target.checked })} />
                  override
                </label>
              </td>
              <td className="pr-2">
                <input value={row.note} readOnly={!editGate.allowed} title={editGate.title}
                       onChange={(e) => edit(row.key, { note: e.target.value })}
                       className={`${INPUT_COMPACT} w-full read-only:bg-surface-50`} />
              </td>
              <td>
                {/* The label is the button's real name: its CONTENT is "×", which wins the
                    accessible-name computation outright, so the title beside it never got a look
                    in and the control announced as "times". And it is legible at REST — the old
                    text-slate-400 reached a readable colour only on :hover, which no touch user
                    and no keyboard user ever produces. */}
                <button type="button" onClick={() => removeRow(row.key)}
                        disabled={!editGate.allowed} aria-label={`Remove reading ${i + 1}`}
                        title={editGate.allowed ? "Remove this reading" : editGate.title}
                        className="rounded px-1 text-sm text-ink-500 hover:text-red-600">
                  ×
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr className="border-t">
              <td colSpan={6} className="py-1 text-ink-500">No readings yet.</td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="mt-2 flex items-center gap-2">
        <button type="button" onClick={addRow} disabled={!editGate.allowed} title={editGate.title}
                className="rounded border px-2 py-1 text-xs">
          Add another reading
        </button>
        <button type="button" onClick={() => void save()}
                disabled={!editGate.allowed || !dirty || saving}
                title={editGate.allowed ? (dirty ? undefined : "No unsaved changes") : editGate.title}
                className="rounded bg-ink-900 px-3 py-1 text-xs text-white">
          {saving ? "Saving…" : "Save readings"}
        </button>
        <DiscardButton section="Cert results" dirty={dirty} pending={saving} onDiscard={discardChanges} />
        <UnsavedBadge dirty={dirty} />
      </div>
      </>}
    </div>
  );
}
