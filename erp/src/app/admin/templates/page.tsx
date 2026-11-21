"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/fetcher";
import { gate, gateDo } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { oneShotHold } from "@/lib/single-flight";
import { BlockerPanel, type Blocker } from "@/components/BlockerPanel";
import { DangerButton } from "@/components/DangerButton";
// Client-safe: the contract registry is pure declarations (spec §5.3 — the editor imports it),
// no src/server import. `contractFor(dt).name` is the single source of truth for each docType's
// display name ("Traveler", "Bill of lading", …) — a local label map would drift from it.
import { TEMPLATE_DOC_TYPES, contractFor, type TemplateDocTypeString } from "@/lib/template-contracts/index";
import { askReason } from "@/lib/modal";
import { PageHeader } from "@/components/PageHeader";
import { TemplateVersions, type VersionSummary } from "./TemplateVersions";
import { BADGE_WARNING, BUTTON_NEUTRAL_COMPACT, BUTTON_PRIMARY, BUTTON_PRIMARY_COMPACT, CARD, INPUT_COMPACT, LINK, NOTICE } from "@/lib/ui-classes";

// Local mirrors of src/server/templates.ts's read types (the Shell.tsx precedent: a "use client"
// file must not import from src/server/**). Dates arrive as ISO strings over JSON.
type ListRow = {
  id: string; docType: TemplateDocTypeString; name: string; isDefault: boolean;
  publishedVersionNumber: number | null; hasDraft: boolean; assignmentCount: number;
};
type Detail = {
  id: string; docType: TemplateDocTypeString; name: string; isDefault: boolean;
  publishedVersionNumber: number | null;
  draft: { versionNumber: number; updatedAt: string } | null;
  versions: VersionSummary[];
};

function docTypeName(dt: TemplateDocTypeString): string {
  return contractFor(dt).name;
}

export default function TemplatesPage() {
  const [rows, setRows] = useState<ListRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ id: string; name: string; list: Blocker[] } | null>(null);
  const [newDocType, setNewDocType] = useState<TemplateDocTypeString>(TEMPLATE_DOC_TYPES[0]);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<string>("");
  // #720: New template's hold, and one hold for the five lifecycle buttons `act` sends, so a second
  // click while the first request is out sends nothing (a second Publish would be refused as
  // already published; Set default, idempotent, is held with its siblings).
  const [creating, setCreating] = useState(false);
  const [createHold] = useState(() => oneShotHold(setCreating));
  const [acting, setActing] = useState(false);
  const [actHold] = useState(() => oneShotHold(setActing));

  const { permissions: perms, error: permsError } = usePermissions();
  // Publish AND set-default both require templates.edit AND the edit_templates special (spec §7,
  // the change_prices pattern) — disabled if either is missing, the tooltip naming whichever is
  // the blocker (PricingSection's "whichever is actually the blocker" rule).
  const canCreate = gate(perms, "templates.create");
  const canEdit = gate(perms, "templates.edit");
  const canDelete = gate(perms, "templates.delete");
  const editTemplates = gateDo(perms, "edit_templates");
  const consequentialDisabled = canEdit.disabled || editTemplates.disabled;
  const consequentialTitle = canEdit.disabled ? canEdit.title : editTemplates.title;

  // Rows-list gate (the surcharges/page.tsx load shape): refresh()/createTemplate/removeTemplate
  // refire load() with the buttons un-disabled, so overlapping list loads used to land in
  // arrival order.
  const rowsLatest = useLatest();
  const load = useCallback(async () => {
    const ticket = rowsLatest.next();
    try {
      const data = await api<ListRow[]>("/api/templates");
      if (!rowsLatest.isCurrent(ticket)) return; // a slower, now-superseded load lost the race
      setRows(data);
    } catch (e) {
      // F7 (customers/page.tsx): a superseded load's rejection must not clobber current state.
      if (!rowsLatest.isCurrent(ticket)) return;
      throw e;
    }
  }, [rowsLatest]);
  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [load]);

  // ONE shared gate for EVERY writer of `detail` — the selection effect below and loadDetail (the
  // post-mutation refresh path). loadDetail used to be ungated: publish A then click B, and
  // loadDetail(A)'s late response repainted A's pane under B's highlighted row — "always targets
  // the open detail's id" was only true at dispatch time, not response time. On the shared gate a
  // newer selection automatically invalidates any in-flight post-mutation detail refresh.
  const detailLatest = useLatest();
  const loadDetail = useCallback(async (id: string) => {
    const ticket = detailLatest.next();
    try {
      const d = await api<Detail>(`/api/templates/${id}`);
      if (!detailLatest.isCurrent(ticket)) return; // selection moved on — the pane is theirs now
      setDetail(d);
    } catch (e) {
      // F7 (customers/page.tsx): a superseded refresh's rejection must not clobber current state.
      if (!detailLatest.isCurrent(ticket)) return;
      throw e;
    }
  }, [detailLatest]);
  // §5.13 stale-gate: selecting A then B before A's detail lands must not let A's response
  // overwrite B — every lifecycle/rename/delete handler acts on `detail.id`, so a stale adopt
  // would aim publish/rename/DELETE at the wrong template. Ticketed on the SAME gate as loadDetail
  // (replacing the old effect-scoped `stale` flag) so the two writers of `detail` order against
  // each other; success never clears the error banner (§5.13 — a reload must not erase a live
  // failure), and deselecting bumps the gate so an in-flight detail fetch cannot repaint a pane
  // the user just closed.
  useEffect(() => {
    setBlocked(null);
    setRenaming("");
    const ticket = detailLatest.next();
    if (selected === null) { setDetail(null); return; }
    setDetail(null);
    api<Detail>(`/api/templates/${selected}`)
      .then((d) => { if (detailLatest.isCurrent(ticket)) setDetail(d); })
      .catch((e) => { if (detailLatest.isCurrent(ticket)) setError((e as Error).message); });
  }, [selected, detailLatest]);

  // Every mutation reloads BOTH the list (badges/counts) and the open detail (lifecycle state),
  // then reports on failure — rolling back to server truth first is unnecessary here because
  // nothing is optimistic (no local edits held), so a plain reload after the action suffices.
  async function refresh(id: string | null) {
    await load();
    if (id !== null) await loadDetail(id);
  }

  // The header's New template takes the cursor to the form's name box; the form's Create template
  // saves.
  const newNameRef = useRef<HTMLInputElement>(null);
  function focusNewTemplate() {
    newNameRef.current?.scrollIntoView({ block: "center" });
    newNameRef.current?.focus();
  }

  async function createTemplate() {
    const name = newName.trim();
    if (!name) { setError("A template name is required"); return; }
    await createHold.run(async () => {
      try {
        const created = await api<{ id: string }>("/api/templates", {
          method: "POST", body: JSON.stringify({ docType: newDocType, name }),
        });
        setNewName(""); setError(null);
        await load();
        setSelected(created.id); // select the new template — its v1 draft is open (create opens it)
      } catch (e) { setError((e as Error).message); }
    });
  }

  async function act(id: string, fn: () => Promise<unknown>) {
    await actHold.run(async () => {
      try {
        await fn();
        setError(null);
        await refresh(id);
      } catch (e) { setError((e as Error).message); }
    });
  }

  const openDraft = (id: string, fromVersion?: number) =>
    act(id, () => api(`/api/templates/${id}/draft`, {
      method: "POST", body: JSON.stringify(fromVersion === undefined ? {} : { fromVersion }),
    }));
  const discardDraft = (id: string) =>
    act(id, () => api(`/api/templates/${id}/draft`, { method: "DELETE" }));
  const publish = (id: string) =>
    act(id, () => api(`/api/templates/${id}/publish`, { method: "POST" }));
  const setDefault = (id: string) =>
    act(id, () => api(`/api/templates/${id}/default`, { method: "POST" }));

  async function rename(id: string) {
    const name = renaming.trim();
    if (!name) { setError("A template name is required"); return; }
    try {
      await api(`/api/templates/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      setRenaming(""); setError(null);
      await refresh(id);
    } catch (e) { setError((e as Error).message); }
  }

  async function removeTemplate(row: Detail) {
    // Reasoned delete (§5.17 — it retires a whole version history and frees a name for reuse). The
    // server requires the reason too (deleteTemplate); this ask only spares a round trip.
    const reason = await askReason({
      question: `Delete template "${row.name}" (${docTypeName(row.docType)})?\n\n` +
        `Its entire version history is retired from view and the name can be reused later, ` +
        `starting a fresh template rather than restoring this one.`,
      verb: "deleting",
      blankRefusal: "A reason is required to delete a template",
    });
    if (reason === null) return; // cancelled
    if (!reason.trim()) { setError("A reason is required to delete a template"); return; } // the modal holds a blank open; this stays the caller's own check
    try {
      await api(`/api/templates/${row.id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
      setSelected(null); setError(null); setBlocked(null);
      await load();
    } catch (e) {
      // §5.14: a refused delete is not a dead end. On a 400, fetch the blocker list and show it
      // linked, with the Excel export (carried Task-4 minor b: the export is reachable ONLY from
      // this refusal, never as a standalone control). An empty list means the refusal was the
      // default-template guard (no assignments), which falls through to the plain banner below.
      if (e instanceof ApiError && e.status === 400) {
        try {
          const list = await api<Blocker[]>(`/api/templates/${row.id}/blockers`);
          if (list.length) { setBlocked({ id: row.id, name: row.name, list }); setError(null); return; }
        } catch (listErr) {
          setError(`${(e as Error).message} — the list of what's using it could not be loaded ` +
            `(${(listErr as Error).message}). Try again.`);
          return;
        }
      }
      setError((e as Error).message);
    }
  }

  const grouped = TEMPLATE_DOC_TYPES.map((dt) => ({
    docType: dt,
    templates: rows.filter((r) => r.docType === dt).sort((a, b) => a.name.localeCompare(b.name)),
  }));

  return (
    <div className="min-w-0 p-3 sm:p-6">
      <PageHeader title="Document templates"
        subtitle="One template per document type is starred as the default. Editing happens in a draft that you publish when ready; published versions are frozen and kept as history."
        actions={
          <button type="button" onClick={focusNewTemplate} disabled={canCreate.disabled} title={canCreate.title}
                  className={BUTTON_PRIMARY}>
            New template
          </button>
        } />
      {(error ?? permsError) && (
        <p className={`${NOTICE.refusal} mb-3`}>{error ?? permsError}</p>
      )}

      {/* Create — a docType picker + name, gated on templates.create (§5.16 disabled-with-reason) */}
      <div className={`${CARD} mb-5 flex flex-wrap items-end gap-2`}>
        <label className="text-sm">
          <span className="mr-2">New template for</span>
          <select aria-label="New template document type" value={newDocType}
                  disabled={canCreate.disabled} title={canCreate.title}
                  onChange={(e) => setNewDocType(e.target.value as TemplateDocTypeString)}
                  className={`${INPUT_COMPACT} disabled:bg-surface-50`}>
            {TEMPLATE_DOC_TYPES.map((dt) => <option key={dt} value={dt}>{docTypeName(dt)}</option>)}
          </select>
        </label>
        <input ref={newNameRef} value={newName} onChange={(e) => setNewName(e.target.value)}
               disabled={canCreate.disabled} title={canCreate.title}
               placeholder="Template name"
               className={`${INPUT_COMPACT} disabled:bg-surface-50`} />
        <button onClick={() => void createTemplate()} disabled={canCreate.disabled || creating} title={canCreate.title}
                className={BUTTON_PRIMARY_COMPACT}>
          Create template
        </button>
      </div>

      <div className="flex gap-6">
        {/* S2c (#239): the one column width shared with roles, surcharges, step codes and pick
            lists. This list's rows are the batch's widest — a two-line row whose meta line can
            read "No published version · Draft · N assigned" — and they were measured at 1440px
            against the demonstration dataset's longest name ("Invoice — Aerospace layout")
            before the column was narrowed; the meta line is `flex-wrap`, so the one case that
            does not fit wraps rather than clipping. */}
        <div className="w-72 shrink-0 space-y-4">
          {grouped.map(({ docType, templates }) => (
            <div key={docType}>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
                {docTypeName(docType)}
              </div>
              {/* Labelled per document type: a list needs an accessible name, and it gives the
                  templates-admin flow a per-type scope so its assertions stop counting rows
                  plant-wide (#234). */}
              <ul aria-label={docTypeName(docType)} className="divide-y rounded border bg-surface-0 text-sm">
                {templates.length === 0 && (
                  <li className="px-3 py-2 text-ink-500">No templates yet</li>
                )}
                {templates.map((r) => (
                  <li key={r.id} className={selected === r.id ? "bg-link-50" : ""}>
                    <button type="button" onClick={() => setSelected(r.id)}
                            aria-current={selected === r.id ? "true" : undefined}
                            className={`w-full cursor-pointer px-3 py-2 text-left ${selected === r.id ? "" : "hover:bg-surface-50"}`}>
                      <div className="flex items-center gap-1">
                        {r.isDefault && <span title="Default for this document type" aria-label="default">★</span>}
                        <span className="font-medium">{r.name}</span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-2 text-xs text-ink-500">
                        <span>{r.publishedVersionNumber !== null
                          ? `Published v${r.publishedVersionNumber}` : "No published version"}</span>
                        {r.hasDraft && <span className="rounded bg-accent-50 px-1 text-accent-600">Draft</span>}
                        <span>{r.assignmentCount} assigned</span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="flex-1">
          {detail === null ? (
            <p className="text-sm text-ink-500">Select a template to manage its versions.</p>
          ) : (
            <div className={CARD}>
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-medium">
                    {detail.isDefault && <span className="mr-1" aria-label="default">★</span>}
                    {detail.name}
                  </h2>
                  <p className="text-xs text-ink-500">{docTypeName(detail.docType)}</p>
                </div>
                <DangerButton onClick={() => void removeTemplate(detail)}
                              disabled={canDelete.disabled} title={canDelete.title}>
                  Delete template
                </DangerButton>
              </div>

              {/* Rename (templates.edit) */}
              <div className="mb-4 flex items-center gap-2">
                <input value={renaming === "" ? detail.name : renaming}
                       disabled={canEdit.disabled} title={canEdit.title}
                       onChange={(e) => setRenaming(e.target.value)}
                       className={`${INPUT_COMPACT} w-64 disabled:bg-surface-50`} />
                <button onClick={() => void rename(detail.id)}
                        disabled={canEdit.disabled || renaming.trim() === "" || renaming.trim() === detail.name}
                        title={canEdit.title}
                        className={BUTTON_NEUTRAL_COMPACT}>
                  Rename
                </button>
              </div>

              {/* Lifecycle */}
              <div className="mb-4 flex flex-wrap items-center gap-2">
                {detail.draft ? (
                  <>
                    <span className={BADGE_WARNING}>
                      Open draft: v{detail.draft.versionNumber}
                    </span>
                    <Link href={`/admin/templates/${detail.id}/edit`}
                          className="rounded bg-ink-900 px-3 py-1 text-sm text-white">
                      Edit draft
                    </Link>
                    <button onClick={() => void discardDraft(detail.id)}
                            disabled={canEdit.disabled || acting} title={canEdit.title}
                            className={BUTTON_NEUTRAL_COMPACT}>
                      Discard local edits
                    </button>
                    <button onClick={() => void publish(detail.id)}
                            disabled={consequentialDisabled || acting} title={consequentialTitle}
                            className={BUTTON_PRIMARY_COMPACT}>
                      Publish saved draft
                    </button>
                  </>
                ) : (
                  <button onClick={() => void openDraft(detail.id)}
                          disabled={canEdit.disabled || acting} title={canEdit.title}
                          className={BUTTON_PRIMARY_COMPACT}>
                    Open draft
                  </button>
                )}
                {!detail.isDefault && (
                  <button onClick={() => void setDefault(detail.id)}
                          disabled={consequentialDisabled || detail.publishedVersionNumber === null || acting}
                          title={detail.publishedVersionNumber === null
                            ? "Publish a version before making this the default" : consequentialTitle}
                          className={BUTTON_NEUTRAL_COMPACT}>
                    Set as default
                  </button>
                )}
              </div>

              {/* View version history */}
              <h3 className="mb-2 text-sm font-medium">View version history</h3>
              <TemplateVersions versions={detail.versions} publishedVersionNumber={detail.publishedVersionNumber}
                action={(v) => v.status === "PUBLISHED" && (
                  <button onClick={() => void openDraft(detail.id, v.versionNumber)}
                          disabled={canEdit.disabled || detail.draft !== null || acting}
                          title={detail.draft !== null
                            ? "Discard or publish the open draft first" : canEdit.title}
                          className={`${LINK} text-xs`}>
                    Open draft from this version
                  </button>
                )} />

              {blocked && blocked.id === detail.id && (
                <BlockerPanel
                  label="template"
                  rowName={blocked.name}
                  list={blocked.list}
                  exportHref={`/api/templates/${detail.id}/blockers/export`}
                  onDismiss={() => setBlocked(null)}
                  note="Clear the assignment on each customer's page, then delete the template."
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
