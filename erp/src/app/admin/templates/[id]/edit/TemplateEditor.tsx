"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { canvasPrints, contractFor, type TemplateConfig } from "@/lib/template-contracts";
import { canvasSaveBlock, lockIndex, seedFailureMessage, seedRequest, setLayout, widthBudgetError } from "@/lib/template-editor";
import { editorWithholds, logoUploadOffered } from "@/lib/template-editor";
import { askConfirm } from "@/lib/modal";
import { DESIGNER_WORDS, clearedLayout, designOnCanvasGate } from "@/lib/canvas-designer";
import { canvasPageFor } from "@/lib/template-contracts/canvas";
import type { CanvasLayout } from "@/lib/template-contracts/canvas";
import { FontsPanel, FormatsPanel, FooterAndLogoPanel, LogoUploadPanel, SectionsPanel, TextBlocksPanel, WidthsPanel } from "./panels";
import { LogoPanel } from "./LogoPanel";
import { PreviewPane } from "./PreviewPane";
import { DesignPanel } from "./DesignPanel";
import type { CanvasMeasure } from "@/lib/template-canvas";
import { useUnsavedSection } from "@/lib/use-unsaved-section";
import { useBrowserDraftStore, useRecoverableDraft } from "@/lib/use-recoverable-draft";
import { getBrowserDraftSession, peekBrowserDraftSession } from "@/lib/draft-session";
import type { EditorKey, Stamp } from "@/lib/draft-store";
import { DraftRecoveryNotice } from "@/components/DraftRecoveryNotice";
import { UnsavedBadge } from "@/components/UnsavedBadge";
import { AtAGlance } from "@/components/AtAGlance";
import { PageHeader } from "@/components/PageHeader";
import { RecordTabs } from "@/components/RecordTabs";
import { EDITOR_TAB_LABEL, editorTabs } from "@/lib/admin-tabs";
import { TemplateVersions, type VersionSummary } from "../../TemplateVersions";
import { applyDocumentTemplate, consumeDocumentTemplateSelection, documentTemplateDraftFrom, documentTemplateRecoveryAdapter,
  prepareDocumentTemplate, readDocumentTemplate, readDocumentTemplateMetadata, readRetainedDocumentTemplate, reapplyDocumentTemplate, runDocumentTemplateSave,
  type DocumentTemplateBinding, type DocumentTemplateDetail, type DocumentTemplateVersion } from "@/lib/document-template-recovery";
import { BUTTON_NEUTRAL, BUTTON_PRIMARY, CARD, NOTICE } from "@/lib/ui-classes";
type Detail = DocumentTemplateDetail & { publishedVersionNumber: number | null; versions: VersionSummary[] };
type Lifetime = { live: boolean; binding: DocumentTemplateBinding };
const sameKey = (a: EditorKey, b: EditorKey) => a.owner.userId === b.owner.userId && a.owner.authGeneration === b.owner.authGeneration
  && a.record.id === b.record.id && a.entityVersion === b.entityVersion;

export function TemplateEditor({ templateId }: { templateId: string }) {
  const { store, summary } = useBrowserDraftStore();
  const revision = peekBrowserDraftSession()?.getReadAuthorizationRevision() ?? 0;
  const [discovery, setDiscovery] = useState<{ detail: Detail; revision: number } | null>(null);
  const [requested, setRequested] = useState<EditorKey | null>(null);
  const [slot, setSlot] = useState<{ key: EditorKey; binding: DocumentTemplateBinding } | null>(null);
  const [retry, setRetry] = useState(0);
  const [readId, setReadId] = useState(0);
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lifetime, setLifetime] = useState<Lifetime | null>(null);
  // The canvas preview's measure (ruling C1): the Design tab draws with it and its live page
  // (Task 6, the PreviewPane under autoRun built below) reports it.
  const [measure, setMeasure] = useState<CanvasMeasure | null>(null);
  // The Preview tab's record and All loads, held here (ruling C2): Design on a canvas seeds from the
  // picked record and names it in its question by the record's number. A statement's as-of date and
  // Combine family are held here too (since statement canvas PR 2), so both panes render one
  // statement.
  const [previewRecord, setPreviewRecord] = useState<{ id: string; label: string; recordNumber: string } | null>(null);
  const [allLoads, setAllLoads] = useState(false);
  const [asOf, setAsOf] = useState("");
  const [combineFamily, setCombineFamily] = useState(false);
  // Design on a canvas's request (held while it is out) and its refusal, shown in the Sections panel.
  const [seeding, setSeeding] = useState(false);
  const [seedMessage, setSeedMessage] = useState<string | null>(null);
  const active = useRef<Lifetime | null>(null);
  const requestSequence = useRef(0);
  const detail = summary.identityReady && discovery?.revision === revision ? discovery.detail : null;
  const detailReady = detail !== null;
  const binding = slot?.binding ?? null;
  const view = useRecoverableDraft(binding);
  const openVersion = detail?.draft?.versionNumber;
  const historical = !!slot && !!detail && Number(slot.key.entityVersion) !== openVersion;

  // Resolve an existing exact version selection before choosing the open-version default.
  useEffect(() => {
    const session = getBrowserDraftSession(); if (!session || !store) return;
    const selected = () => {
      const key = consumeDocumentTemplateSelection(session, templateId);
      if (key) { setRequested(key); setRetry(value => value + 1); }
    };
    const off = session.subscribeSelection(selected); selected(); return off;
  }, [store, templateId]);
  useEffect(() => {
    const session = getBrowserDraftSession(); const ticket = session?.readAuthorizationTicket();
    if (!session || !ticket || !summary.identityReady) return;
    let live = true;
    const load = async () => {
      try {
        // Both reads go out together (#676): the draft opened only after four serial round trips,
        // this pair and loadRecovery's. The authorization check stays after both have landed.
        const [fresh, me] = await Promise.all([
          api<Detail>(`/api/templates/${templateId}`),
          api<{ id: string; permissions: string[] }>("/api/auth/me"),
        ]);
        if (!live || !session.isReadAuthorized(ticket)) return;
        if (fresh.id !== templateId || me.id !== session.store.getSnapshot().owner?.userId || !me.permissions.includes("templates.view")) throw new Error("Access unavailable.");
        setDiscovery({ detail: fresh, revision }); setError(null);
      } catch (e) { if (live && session.isReadAuthorized(ticket)) { setDiscovery(null); setError(e instanceof Error ? e.message : String(e)); } }
    };
    void load(); return () => { live = false; };
  }, [store, templateId, summary.identityReady, revision]);
  useEffect(() => {
    if (!store || !summary.owner || !detail) return;
    const selected = requested && requested.owner.userId === summary.owner.userId && requested.owner.authGeneration === summary.owner.authGeneration && requested.record.id === templateId ? requested : null;
    const key = selected ?? (openVersion === undefined ? null : { owner: summary.owner, record: { kind: "document-template", id: templateId }, editor: documentTemplateRecoveryAdapter.kind, entityVersion: String(openVersion) });
    if (!key) { setSlot(null); return; }
    if (!slot || !sameKey(slot.key, key)) setSlot({ key, binding: store.bind(key, { label: "Template", href: `/admin/templates/${templateId}/edit` }, documentTemplateRecoveryAdapter) });
  }, [store, summary.owner, detail, requested, templateId, openVersion, slot]);
  useEffect(() => {
    if (!binding) return;
    const token: Lifetime = { live: true, binding }; active.current = token; setLifetime(token); setSaving(false); setSavedTick(false); setSeeding(false); setSeedMessage(null);
    return () => { token.live = false; if (active.current === token) active.current = null; };
  }, [binding]);
  const loadRecovery = useCallback(async () => {
    const session = getBrowserDraftSession(); const token = active.current;
    if (!session || !binding || !slot || !token?.live || token.binding !== binding) return;
    if (requested ? !sameKey(requested, slot.key) : Number(slot.key.entityVersion) !== openVersion) return;
    let fresh: Detail | null = null;
    const readDetail = async () => { fresh = await api<Detail>(`/api/templates/${templateId}`); return fresh; };
    const readIdentity = () => api<{ id: string; permissions: string[] }>("/api/auth/me");
    const expectedRevision = session.getReadAuthorizationRevision();
    const accepted = historical
      ? await readRetainedDocumentTemplate({ binding, session, templateId, versionNumber: Number(slot.key.entityVersion), readDetail,
        readVersion: () => api<DocumentTemplateVersion>(`/api/templates/${templateId}/versions/${slot.key.entityVersion}`), readIdentity })
      : await readDocumentTemplate({ binding, session, templateId, versionNumber: Number(slot.key.entityVersion), readDetail, readIdentity,
        accepted: id => { if (token.live && active.current === token) setReadId(id); } });
    if (!token.live || active.current !== token || session.getReadAuthorizationRevision() !== expectedRevision) return;
    if (accepted && fresh) { setDiscovery({ detail: fresh, revision: expectedRevision }); setError(null); }
    else setError("This template could not be refreshed. Retained changes remain in this tab.");
  }, [binding, slot, templateId, historical, requested, openVersion]);
  useEffect(() => { if (summary.identityReady && detailReady) void loadRecovery(); }, [loadRecovery, summary.identityReady, revision, retry, detailReady]);
  useEffect(() => {
    // A historical view exists only for its retained copy. When that copy is discarded from the
    // Shell's drafts panel, drop the selection as discardCopy does for this page's own buttons (#454).
    if (historical && slot && requested && sameKey(requested, slot.key) && !summary.rows.some(row => sameKey(row.key, slot.key))) { setRequested(null); setRetry(n => n + 1); }
  }, [historical, slot, requested, summary.rows]);

  const editable = !historical && view.mode === "editing" && view.savedBaseline?.source === "open";
  const current = editable ? view.current?.data : undefined;
  const config = current?.config ?? view.savedBaseline?.config ?? null;
  const dirty = current?.dirty ?? false;
  const stashed = current?.stashed ?? null;
  const conflict = current?.conflict ?? null;
  const logoMimeType = current?.logoMimeType ?? (view.savedBaseline?.source === "open" ? view.savedBaseline.logoMimeType : null);
  // The draft's logo as the Design tab draws it; `?v` is the draft's updatedAt, so a re-upload reads again.
  const logoVersion = current?.updatedAt ?? view.savedBaseline?.updatedAt ?? "";
  const logoSrc = logoMimeType === null ? null : `/api/templates/${templateId}/logo?v=${encodeURIComponent(logoVersion)}`;
  const canEdit = gate(view.savedBaseline?.permissions ? [...view.savedBaseline.permissions] : undefined, "templates.edit");
  const blocked = !editable || canEdit.disabled;
  useUnsavedSection(!!view.current && documentTemplateRecoveryAdapter.dirty(view.current.data, view.current.baseline), "Template");
  const apply = useCallback((fn: (config: TemplateConfig) => TemplateConfig) => {
    if (!binding) return; binding.change(data => applyDocumentTemplate(data, fn)); setSavedTick(false);
  }, [binding]);
  const expectedStamp = view.current?.stamp;
  const refreshDraftMeta = useCallback(async () => {
    const session = getBrowserDraftSession();
    if (!session || !binding || !expectedStamp || !lifetime?.live || active.current !== lifetime || lifetime.binding !== binding) return;
    // The Versions tab reads `discovery`, so a logo change refreshes it as a recovery read does.
    let fresh: Detail | null = null;
    const expectedRevision = session.getReadAuthorizationRevision();
    const accepted = await readDocumentTemplateMetadata({ binding, session, expectedStamp,
      readDetail: async () => { fresh = await api<Detail>(`/api/templates/${templateId}`); return fresh; },
      readIdentity: () => api<{ id: string; permissions: string[] }>("/api/auth/me") });
    if (accepted && fresh && active.current === lifetime && session.getReadAuthorizationRevision() === expectedRevision) {
      setDiscovery({ detail: fresh, revision: expectedRevision });
    }
  }, [binding, expectedStamp, lifetime, templateId]);
  async function save() {
    const session = getBrowserDraftSession(); if (!session || !binding || blocked || saving || !lifetime?.live || active.current !== lifetime) return;
    const submission = prepareDocumentTemplate(binding, `template-${++requestSequence.current}`); if (!submission) return;
    const token = lifetime; const isLive = () => token.live && active.current === token && token.binding === binding;
    let refresh = false; setSaving(true); setError(null);
    try {
      await runDocumentTemplateSave({ binding, session, submission, isLive,
        patch: async () => {
          try {
            const result = await api<{ updatedAt: string }>(`/api/templates/${templateId}/draft`, { method: "PATCH", body: JSON.stringify({ config: submission.payload.config, updatedAt: submission.payload.updatedAt }) });
            refresh = true; return result;
          } catch (e) { if (typeof e === "object" && e !== null && "status" in e && e.status === 409) refresh = true; throw e; }
        },
        readDetail: () => api<Detail>(`/api/templates/${templateId}`), readIdentity: () => api<{ id: string; permissions: string[] }>("/api/auth/me"),
        onSaved: () => setSavedTick(binding.getSnapshot().current?.data.dirty === false), onConflict: () => setSavedTick(false),
        onError: e => setError(e instanceof Error ? e.message : String(e)) });
    } finally {
      if (isLive()) { if (refresh) await loadRecovery(); if (isLive()) setSaving(false); }
    }
  }
  // Each Edit fields and widths takes a fresh key, so the same item opens the tab again.
  const [openTab, setOpenTab] = useState<{ id: string; key: string } | null>(null);
  const openRequests = useRef(0);
  function openWidths() {
    openRequests.current += 1;
    setOpenTab({ id: "column-widths", key: String(openRequests.current) });
  }
  // A record picked in Preview; a seed refusal named the record before it, so it goes. Clearing the
  // record clears the live page's measure too (ruling C19): no other order's measure stays.
  function pickPreviewRecord(id: string, label: string, recordNumber: string | undefined) {
    setPreviewRecord(id === "" ? null : { id, label, recordNumber: recordNumber ?? "" });
    if (id === "") setMeasure(null);
    setSeedMessage(null);
  }
  function openDesign() {
    openRequests.current += 1;
    setOpenTab({ id: "canvas-design", key: String(openRequests.current) });
  }
  /** The editor's own lifetime check for an ask: `askConfirm` answers a tick later with the page
   *  still running, so nothing is applied unless this draft is still the one on screen. */
  function liveCheck(): (() => boolean) | null {
    if (!binding || !lifetime?.live || active.current !== lifetime) return null;
    const token = lifetime;
    return () => token.live && active.current === token && token.binding === binding;
  }
  // Design on a canvas (PR C of #926, Task 5): asked, then the seed route lays today's paper out for
  // the picked record and answers a layout, applied as an ordinary edit that Save keeps and Discard
  // undoes; the Design tab opens once it holds the layout. A refusal shows in the Sections panel.
  async function designOnCanvas() {
    const record = previewRecord; const isLive = liveCheck();
    if (!isLive || !binding || !detail || blocked || seeding || record === null) return;
    const confirmed = await askConfirm({ title: DESIGNER_WORDS.designOnCanvas,
      body: DESIGNER_WORDS.designConfirm(detail.docType, record.recordNumber), confirm: DESIGNER_WORDS.designOnCanvas });
    const working = binding.getSnapshot().current?.data.config;
    if (!confirmed || !isLive() || working === undefined) return;
    setSeeding(true); setSeedMessage(null);
    try {
      const layout = await api<CanvasLayout>(`/api/templates/${templateId}/draft/canvas`,
        { method: "POST", body: JSON.stringify(seedRequest(working, record.id)) });
      if (!isLive()) return;
      apply((c) => setLayout(c, layout));
      openDesign();
    } catch (e) {
      if (isLive()) setSeedMessage(seedFailureMessage(e));
    } finally {
      if (isLive()) setSeeding(false);
    }
  }
  // Back to sections sets the canvas aside and drops its measure (ruling C1); the sections print again.
  async function backToSections() {
    const isLive = liveCheck(); if (!isLive || blocked) return;
    const confirmed = await askConfirm({ title: DESIGNER_WORDS.backToSections, body: DESIGNER_WORDS.backToSectionsConfirm,
      confirm: DESIGNER_WORDS.backToSections });
    if (!confirmed || !isLive()) return;
    apply((c) => setLayout(c, null));
    setMeasure(null);
  }
  // Clear the page keeps the items the profile requires alone (`clearedLayout`; the traveler's
  // barcode and Process steps table).
  async function clearPage() {
    const isLive = liveCheck(); if (!isLive || blocked || !detail) return;
    // The contract from the detail: the `contract` memo below is declared after this function.
    const confirmed = await askConfirm({ title: DESIGNER_WORDS.clearPage,
      body: DESIGNER_WORDS.clearPageConfirm(contractFor(detail.docType)), confirm: DESIGNER_WORDS.clearPage });
    if (!confirmed || !isLive()) return;
    apply((c) => (c.layout === null ? c : setLayout(c, clearedLayout(contractFor(detail.docType), canvasPageFor(detail.docType, c.formats.labelSize), c.fonts))));
  }
  function reapplyStashed() { if (!blocked && !saving && binding) { binding.change(reapplyDocumentTemplate); setSavedTick(false); } }
  const contract = useMemo(() => detail ? contractFor(detail.docType) : null, [detail]);
  const locks = useMemo(() => contract ? lockIndex(contract) : new Map<string, string>(), [contract]);
  const saveBlock = useMemo(() => contract && config ? widthBudgetError(contract, config) ?? canvasSaveBlock(contract, config) : null, [contract, config]);
  const preview = (copy: typeof view.current) => copy ? documentTemplateRecoveryAdapter.preview(copy.data, copy.baseline) : undefined;
  const discardCopy = (stamp: Stamp | undefined) => {
    if (!binding || !stamp) return;
    binding.discard(stamp);
    if (historical && !store?.getSnapshot().rows.some(row => sameKey(row.key, stamp.key))) { setRequested(null); setRetry(n => n + 1); }
  };
  const notice = <DraftRecoveryNotice mode={view.mode} submissionPhase={view.submissionPhase} canRestore={!historical && view.canRestore}
    hasCurrent={!!view.current} hasReference={!!view.reference} currentPreview={preview(view.current)} referencePreview={preview(view.reference)} submittedPreview={preview(view.submitted)}
    restore={() => { if (view.current && binding) binding.restore(view.current.stamp, readId); }}
    discard={() => discardCopy(view.current?.stamp)}
    discardReference={() => discardCopy(view.reference?.stamp)}
    startFresh={!historical && !saving && view.savedBaseline?.source === "open" ? () => { if (binding && view.savedBaseline) binding.startFresh(readId, documentTemplateDraftFrom(view.savedBaseline)); } : undefined}
    retryRead={() => void loadRecovery()} />;
  if (!detail || !contract) return <div className="p-6"><p>{error ?? "Checking template access…"}</p><Link href="/admin/templates">Back to templates</Link></div>;
  if (historical) return <div className="p-6"><h1 className="text-xl font-semibold">Retained changes — version {slot?.key.entityVersion}</h1>
    {view.savedBaseline?.source === "historical" && <p>{detail.name}</p>}{notice}
    {openVersion !== undefined && <button type="button" onClick={() => { setRequested(null); setRetry(n => n + 1); }}>Open current draft (version {openVersion})</button>}
    <Link href="/admin/templates" className="ml-4 underline">Back to templates</Link></div>;
  if (!detail.draft || !binding) return <div className="p-6"><p>This template has no open draft to edit. Open one from the templates list first.</p><Link href="/admin/templates">Back to templates</Link></div>;
  if (!config) return <div className="p-6">{notice}</div>;
  const hasWidths = contract.sections.some((section) => section.fields.some((field) => field.column !== undefined));
  const tabs = editorTabs({ wording: contract.textBlocks.length > 0, widths: hasWidths, canvas: config.layout !== null });
  const panelProps = { contract, config, apply, disabled: blocked, editTitle: blocked ? canEdit.title ?? "Restore or refresh this draft before editing." : undefined, locks };
  const withholds = editorWithholds(contract);
  const designState = { ...designOnCanvasGate({ blocked, editTitle: panelProps.editTitle, picked: previewRecord !== null, busy: seeding }, contract.docType), message: seedMessage };
  return (
    <div className="min-w-0 p-3 sm:p-6">
      <PageHeader title={detail.name} subtitle={`${contract.name} · editing draft v${detail.draft.versionNumber}`}
        actions={<>
          <UnsavedBadge dirty={dirty} />
          {savedTick && !dirty && <span className="self-center text-xs text-success-700">Saved</span>}
          <button type="button" onClick={() => void save()}
                  disabled={blocked || saving || !dirty || saveBlock !== null}
                  title={canEdit.title ?? saveBlock ?? undefined}
                  className={BUTTON_PRIMARY}>
            {saving ? "Saving…" : "Save draft"}
          </button>
          <Link href="/admin/templates" className={BUTTON_NEUTRAL}>Templates</Link>
        </>} />

      {notice}
      {error && (
        <p className={`${NOTICE.refusal} mb-3`} role="alert">{error}</p>
      )}
      {conflict && (
        <div className="mb-3 rounded border border-accent-600 bg-accent-50 p-3 text-sm text-accent-600" role="alert">
          <p>{conflict}</p>
          {stashed !== null && (
            <button type="button" onClick={reapplyStashed} disabled={saving}
                    className="mt-2 rounded border border-accent-400 bg-surface-0 px-3 py-1 text-xs font-medium text-accent-600 hover:bg-accent-50">
              Re-apply my changes
            </button>
          )}
        </div>
      )}
      {canEdit.disabled && (
        <p className="mb-3 rounded bg-surface-50 p-2 text-xs text-ink-500">
          You can view this draft. Editing needs template-edit permission.
        </p>
      )}

      <div className="flex flex-col gap-6 min-[1360px]:flex-row min-[1360px]:items-start">
      <div className="min-w-0 flex-1">
      {/* The tabs over the mounted panels (src/lib/admin-tabs.ts): one config, one Save draft, so a
          tab switch touches nothing. The banners above stay with the page, not with a panel. */}
      <RecordTabs label={EDITOR_TAB_LABEL} tabs={tabs} open={openTab} panels={{
        design: <DesignPanel templateId={templateId} contract={contract} config={config} apply={apply} disabled={blocked}
                             editTitle={panelProps.editTitle} measure={measure} logoSrc={logoSrc}
                             onBackToSections={backToSections} onClearPage={clearPage}
                             preview={<PreviewPane templateId={templateId} docType={detail.docType} config={config}
                                                   perms={view.savedBaseline?.permissions}
                                                   recordId={previewRecord?.id ?? ""}
                                                   onRecordId={pickPreviewRecord}
                                                   allLoads={allLoads} onAllLoads={setAllLoads}
                                                   asOf={asOf} onAsOf={setAsOf}
                                                   combineFamily={combineFamily} onCombineFamily={setCombineFamily}
                                                   autoRun onMeasure={setMeasure} />} />,
        sections: <SectionsPanel {...panelProps} onEditWidths={hasWidths ? openWidths : undefined}
                                 onDesign={designOnCanvas} design={canvasPrints(contract.docType) ? designState : undefined} />,
        widths: <div id="column-widths"><WidthsPanel {...panelProps} /></div>,
        appearance: (
          <div className="grid gap-4 lg:grid-cols-2">
            <FontsPanel {...panelProps} />
            <FormatsPanel {...panelProps} />
            <FooterAndLogoPanel {...panelProps}>
              {!withholds.logo && (
                <LogoPanel templateId={templateId} logoMimeType={logoMimeType} config={config} apply={apply}
                           disabled={blocked} editTitle={panelProps.editTitle} onLogoChanged={refreshDraftMeta} />
              )}
            </FooterAndLogoPanel>
            {withholds.logo && logoUploadOffered(contract, config) && (
              <LogoUploadPanel>
                <LogoPanel templateId={templateId} logoMimeType={logoMimeType} config={config} apply={apply}
                           disabled={blocked} editTitle={panelProps.editTitle} onLogoChanged={refreshDraftMeta}
                           placementWithheld />
              </LogoUploadPanel>
            )}
          </div>
        ),
        wording: <TextBlocksPanel {...panelProps} />,
        preview: <PreviewPane templateId={templateId} docType={detail.docType} config={config}
                              perms={view.savedBaseline?.permissions}
                              recordId={previewRecord?.id ?? ""}
                              onRecordId={pickPreviewRecord}
                              allLoads={allLoads} onAllLoads={setAllLoads}
                              asOf={asOf} onAsOf={setAsOf}
                              combineFamily={combineFamily} onCombineFamily={setCombineFamily} />,
        versions: (
          <div className={CARD}>
            <TemplateVersions versions={detail.versions} publishedVersionNumber={detail.publishedVersionNumber} />
          </div>
        ),
      }} />
      </div>
      <AtAGlance title="Template status" rows={[
        { label: "Document", value: contract.name },
        { label: "Published", value: detail.publishedVersionNumber === null ? "None" : `Version ${detail.publishedVersionNumber}` },
        { label: "Editing", value: `Draft v${detail.draft.versionNumber}` },
        { label: "Changes", value: dirty ? "Unsaved" : "Saved" },
      ]}>
        <p className="mt-3 text-xs text-ink-500">Preview uses this draft. Existing documents and print status stay unchanged.</p>
      </AtAGlance>
      </div>
    </div>
  );
}
