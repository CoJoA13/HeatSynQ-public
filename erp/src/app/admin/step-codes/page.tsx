"use client";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { api, ApiError } from "@/lib/fetcher";
import { invalidateSetupBanner } from "@/components/SetupBanner";
import { DangerButton } from "@/components/DangerButton";
import { PageHeader } from "@/components/PageHeader";
import { RecordTabs } from "@/components/RecordTabs";
import { ActionMenu } from "@/components/ActionMenu";
import { askConfirm } from "@/lib/modal";
import { focusWhenShown } from "@/lib/focus-when-shown";
import { yesNo } from "@/lib/format";
import { STEP_CODE_TAB_LABEL, addSuggestionGate, glAccountText, stepCodeTabs } from "@/lib/step-code-tabs";
import { STEP_FIELD_TYPES, type StepFieldType } from "@/lib/step-field-constants";
import { gate } from "@/lib/permission-ui";
import { addSuggestionRefusal } from "@/lib/suggestion-names";
import { moveGate } from "@/lib/reorder";
import { fieldLabelDraftKey, moveFieldById, relabelFieldById, removeFieldById } from "@/lib/step-field-ops";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest, useMutationGate } from "@/lib/use-latest";
import { BlockerPanel, type Blocker } from "@/components/BlockerPanel";
import { HistoryPanel, invalidateHistory } from "@/components/HistoryPanel";
import { SavedMark } from "@/components/SavedMark";
import { useSavedMarks } from "@/lib/use-saved-marks";
import { enterBox, focusRecord, heldText, leaveBox, noteFocus, trimmedText, withoutSettledDraft, type BoxCommit, type SameText } from "@/lib/focus-record";
import { BADGE_WARNING, BUTTON_NEUTRAL, BUTTON_PRIMARY, BUTTON_PRIMARY_COMPACT, CARD, CARD_FLUSH, INPUT_COMPACT, LINK, NOTICE, TABLE_CELL, TABLE_HEAD } from "@/lib/ui-classes";
import { oneShotHold } from "@/lib/single-flight";
import { Combobox } from "@/components/Combobox";
import { glAccountOptions } from "@/lib/menu-options";

// A saved suggestion always carries its id (`listStepCodes`); only a field being added lacks one.
type Field = { id: string; label: string; type: StepFieldType; unit: string | null; sort: number };
type NewField = Omit<Field, "id">;
// A saved suggestion's type and unit never change in place (spec 2026-09-26 §3.3): a part row
// copied from it carries its ID as the key, and one key always means one type and one unit. The
// server refuses the change; the controls say why instead of offering it.
const FIXED_TYPE_AND_UNIT = "Remove and re-add to change the type or unit";
type Code = {
  id: string; code: string; name: string; glAccountId: string | null;
  defaultInstruction: string; active: boolean; needsGlAccount: boolean; fields: Field[];
};
type Gl = { id: string; name: string; description?: string };
type SavePayload = { body: object };

// The page (the UX redesign PR 9, spec §4.3–§4.4; owner 2026-11-01 on #824): Codes, Selected code
// and History over mounted panels (src/lib/step-code-tabs.ts). A row opens Selected code, and each
// header button opens its panel and takes the cursor to its row, through RecordTabs' `open`; every
// save, queue and draft below is what the master-detail page had.
export default function StepCodesPage() {
  const [codes, setCodes] = useState<Code[]>([]);
  const [gls, setGls] = useState<Gl[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState({ code: "", name: "", defaultInstruction: "" });
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ code: Code; list: Blocker[] } | null>(null);
  // #720: Add's hold, so a second click while the POST is out sends nothing (it would be refused
  // as a duplicate code after the first landed). Add suggestion is a queued op and takes none.
  const [adding, setAdding] = useState(false);
  const [addHold] = useState(() => oneShotHold(setAdding));
  // What the user has actually typed into a suggestion's Label input but not yet blurred, keyed
  // by `fieldLabelDraftKey` (the code and the suggestion's id, #650) — composed with the server value at render time
  // (`draftValue`), never written into `codes`/`codesRef` (the surcharges/page.tsx textDrafts
  // pattern). Writing keystrokes into `codes` meant a load landing mid-word clobbered the typing,
  // and — worse — the half-typed text sat in `codesRef`, which every queued field op composes its
  // ENTIRE whole-array PUT from at run time, so an unrelated control's save could persist it.
  // Cleared on selection change and when the field's own blur-save settles.
  const [textDrafts, setTextDrafts] = useState<Record<string, string>>({});
  function draftValue(key: string, serverValue: string): string {
    return Object.hasOwn(textDrafts, key) ? textDrafts[key] : serverValue;
  }
  const { permissions: perms, error: permsError } = usePermissions();

  // Gated per the permission each route actually enforces (part-fields.tsx / ReferenceTable.tsx
  // precedent — this page previously gated none of this): create hits POST requiring
  // admin.create; every scalar edit, active toggle, and field-def change hits PUT requiring
  // admin.edit (fields are replaced wholesale, id-preserving, through the same PUT — there is no
  // separate per-field route); delete hits DELETE requiring admin.delete.
  const canCreate = gate(perms, "admin.create");
  const canEdit = gate(perms, "admin.edit");
  const canDelete = gate(perms, "admin.delete");

  // includeInactive=1 always: the Active column IS the reactivation control (part-fields.tsx
  // precedent), so a code just switched off must stay visible and selectable to be switched back on.
  // Mirrors `codes` for the save queue to read at RUN time. A queued transform must see the field
  // set as it is when its turn comes, not as it was when the user clicked — see enqueueFieldOp.
  const codesRef = useRef<Code[]>([]);
  // Named `latest`, not `gate` — this file also imports `gate` from permission-ui, and shadowing
  // that binding would break every `gate(perms, ...)` call (the customers/page.tsx hazard).
  const latest = useLatest();
  // The codesRef landing (the surcharges/page.tsx rowsRef question, its Task 7 comment): the ref
  // exists to hand a QUEUED run the freshest server truth, not to gate what the user sees, so a
  // superseded load must still be allowed to land it — but landing on ARRIVAL order lets an older
  // fetch resolving after a newer one rewind the ref to a PRE-mutation field set, and the next
  // queued field op composes its ENTIRE array from the ref at run time (enqueueFieldOp), so it
  // would persist the reverted set server-side — the MR !22 clobber reopened. The write is
  // therefore applied-monotonic on the load ticket (makeMutationGate semantics): an early
  // finisher of a superseded load still lands, an out-of-order straggler is dropped.
  const codesRefGate = useMutationGate();
  const load = useCallback(async () => {
    const ticket = latest.next();
    try {
      const [c, g] = await Promise.all([
        api<Code[]>("/api/admin/step-codes?includeInactive=1"),
        api<Gl[]>("/api/admin/reference/glAccount"),
      ]);
      if (codesRefGate.accept(ticket)) codesRef.current = c;
      if (!latest.isCurrent(ticket)) return; // a slower, now-superseded load lost the state race
      setCodes(c); setGls(g);
    } catch (e) {
      // F7 (customers/page.tsx): a superseded load's rejection must not surface an error over
      // state a newer load has already refreshed — only a current load's failure reaches the
      // caller's own handling.
      if (!latest.isCurrent(ticket)) return;
      throw e;
    }
  }, [latest, codesRefGate]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  // A stale blocker panel — and any in-progress Label typing — from a previously selected
  // code must not linger once selection moves on.
  useEffect(() => {
    setBlocked(null); setTextDrafts({});
  }, [selected]);

  const current = codes.find((c) => c.id === selected) ?? null;

  // A fresh key per request: the same row clicked again after going back to Codes opens Selected
  // code again.
  const [openTab, setOpenTab] = useState<{ id: string; key: string } | null>(null);
  const openRequests = useRef(0);
  function openPanel(id: string) {
    openRequests.current += 1;
    setOpenTab({ id, key: String(openRequests.current) });
  }
  function openCode(id: string) {
    setSelected(id);
    openPanel("selected-code");
  }
  const codeRef = useRef<HTMLInputElement>(null);
  const suggestionNameRef = useRef<HTMLInputElement>(null);
  function focusNewCode() {
    openPanel("new-step-code");
    focusWhenShown(() => codeRef.current);
  }
  function focusNewSuggestion() {
    openPanel("add-suggestion");
    focusWhenShown(() => suggestionNameRef.current);
  }
  const suggestionGate = addSuggestionGate(canEdit, current !== null);

  // Shared by every scalar/active/field-def edit: rolls back to server truth on failure BEFORE
  // reporting why (§5.13) — a failed save must not leave a stale, unsaved value in the grid
  // looking as if it took effect. The reload's own failure is swallowed only because the original
  // error is what gets reported; it is not silencing that error.
  //
  // One at a time (Codex, MR !22). Every write here PUTs the code's ENTIRE field array, so two
  // overlapping saves are last-writer-wins over the whole set — and they overlap on the most
  // ordinary interaction there is: editing a label and then clicking a control. mousedown blurs
  // the input, which starts the label save, and the click then starts a second save before the
  // first has returned. If the label save lands second, its payload — which carries the old order
  // and the old field set — silently reverts the reorder or removal that was just
  // clicked, and the two `load()` calls race to leave the grid showing either.
  //
  // A queue rather than disabling the controls: disabling on blur would swallow the very click
  // that caused the blur. Chained on both settle paths so one failure cannot wedge the rest —
  // `run` handles its own errors, so this is belt and braces.
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  function save(id: string, build: SavePayload | (() => SavePayload | null)): Promise<boolean> {
    // Answers whether the write landed; an operation that no longer applies did not.
    const run = async (): Promise<boolean> => {
      // Resolved here, not at call time: a deferred build sees the field set as it is when its
      // turn in the queue comes. `null` means the operation no longer applies (its code or row
      // went away while it waited) — a no-op, not an error.
      const payload = typeof build === "function" ? build() : build;
      if (!payload) return false;
      const { body } = payload;
      try {
        await api(`/api/admin/step-codes/${id}`, { method: "PUT", body: JSON.stringify(body) });
        // #158 — success path, before the follow-up load (#124/!131). Every scalar edit, active
        // toggle and field-def change on this page comes through here, and each writes a
        // `processStepCode` row: exactly the entity the panel below is showing.
        invalidateHistory();
        setError(null); setBlocked(null); await load();
        return true;
      } catch (e) {
        await load().catch(() => {});
        setError((e as Error).message);
        return false;
      }
    };
    const landed = saveQueue.current.then(run, run);
    saveQueue.current = landed.then(() => {});
    return landed;
  }

  async function add() {
    await addHold.run(async () => {
      try {
        await api("/api/admin/step-codes", { method: "POST", body: JSON.stringify(draft) });
        // #110: the first step code completes the banner's `stepCodes` readiness step (#124/!131 ordering: before load()).
        invalidateSetupBanner();
        setDraft({ code: "", name: "", defaultInstruction: "" }); setError(null); await load();
      } catch (e) { setError((e as Error).message); }
    });
  }

  async function removeCode(code: Code) {
    if (!await askConfirm({ title: `Delete step code "${code.code} — ${code.name}"?`, body: "", confirm: "Delete step code", danger: true })) return;
    try {
      await api(`/api/admin/step-codes/${code.id}`, { method: "DELETE" });
      setSelected(null); setError(null); setBlocked(null); await load();
    } catch (e) {
      // A refusal is not a dead end (ReferenceTable.tsx / part-fields.tsx precedent): say what's
      // blocking, and make the list exportable. Only the delete guard's own 400 means a blocker
      // list exists to fetch — a 500 or network failure is a genuine error, not a refusal.
      if (e instanceof ApiError && e.status === 400) {
        try {
          const list = await api<Blocker[]>(`/api/admin/step-codes/${code.id}/blockers`);
          if (list.length) { setBlocked({ code, list }); setError(null); return; }
        } catch (listErr) {
          setError(`${(e as Error).message} — the list of what's using it could not be loaded ` +
            `(${(listErr as Error).message}). Try again.`);
          return;
        }
      }
      setError((e as Error).message);
    }
  }

  // Every field op replaces the whole suggestion set, id-preserving — each suggestion carries its
  // own `id` from listStepCodes and it is passed straight through, so a relabel keeps the same
  // suggestion (and the same key a part row copied from it) instead of a delete+recreate.
  // `sort` is renumbered to the on-screen order (see enqueueFieldOp).

  // Spec §6 lists reorder alongside add/edit/delete as one of the field-def row operations, and
  // it was the one that never got built (Codex, MR !22). `sort` is the order in which a new step
  // copies the suggestions, so remove-and-re-add would also mint a new suggestion id.
  // enqueueFieldOp renumbers `sort` to the resulting order, so returning a reordered array is the
  // whole operation.
  function moveField(codeId: string, fieldId: string, dir: -1 | 1) {
    void enqueueFieldOp(codeId, (fields) => moveFieldById(fields, fieldId, dir));
  }

  /**
   * Queues a save whose payload is computed when it RUNS, from the freshest field set, rather than
   * captured now. Serializing the requests was only half the problem (Codex, MR !22): each payload
   * is the whole field array, so a payload built before an earlier queued save reloaded carries
   * that save's column back to its old value and undoes it — relabel a suggestion, click reorder
   * before the reload lands, and the reorder's stale array restores the old label. Expressing each
   * operation as a transform over the current fields removes the staleness rather than papering
   * over it, and it keeps the controls live, which disabling them would not. That holds for the
   * array, not for an index captured at click (#650): each transform finds its row by id
   * (src/lib/step-field-ops.ts), and an id the fresh array no longer holds is the `null` no-op.
   */
  function enqueueFieldOp(
    codeId: string,
    transform: (fields: Field[]) => (Field | NewField)[] | null,
  ): Promise<boolean> {
    return save(codeId, () => {
      const code = codesRef.current.find((c) => c.id === codeId);
      if (!code) return null;
      const fields = transform(code.fields);
      if (!fields) return null;
      return { body: { fields: fields.map((f, i) => ({ ...f, sort: i })) } };
    });
  }

  function removeField(codeId: string, fieldId: string) {
    void enqueueFieldOp(codeId, (fields) => removeFieldById(fields, fieldId));
  }

  // onFocus/onBlur split (part-fields.tsx precedent): typing doesn't hit the network on every
  // keystroke, and tabbing through a row without changing it writes no no-op audit entry. Enter
  // commits a parameter name as leaving it does, the cursor kept in it (owner ruling R7); each box's
  // text at focus, and the text an accepted Enter sent, live in src/lib/focus-record.ts.
  const focus = useRef(focusRecord());
  const savedMarks = useSavedMarks();
  const clearDraft = (key: string) => setTextDrafts((d) => { const n = { ...d }; delete n[key]; return n; });
  // Once a save settles its box's draft goes only while it still holds the sent text: Enter keeps
  // the cursor in the box, and text typed since is the box's own.
  const dropSettledDraft = (key: string, sent: string) => setTextDrafts((d) => withoutSettledDraft(d, key, sent));
  // A refused box goes back to the stored figure (its draft dropped), or, while a save of the box is
  // out, to the text that save sent: the row may still hold the figure from before it.
  function putBack(key: string) {
    const held = heldText(focus.current, key);
    if (held === null) clearDraft(key);
    else setTextDrafts((d) => ({ ...d, [key]: held }));
  }
  function leaveSave(key: string, value: string, commit: BoxCommit, same?: SameText) {
    const settled = (sent: string) => dropSettledDraft(key, sent);
    if (leaveBox(focus.current, key, value, commit, same, settled) === "unchanged") clearDraft(key);
  }
  function enterSave(e: React.KeyboardEvent<HTMLInputElement>, key: string, commit: BoxCommit, same?: SameText) {
    enterBox(e, focus.current, key, e.currentTarget.value, commit, same, (sent) => dropSettledDraft(key, sent));
  }

  function commitLabel(codeId: string, fieldId: string, value: string): false | Promise<string | false> {
    const key = fieldLabelDraftKey(codeId, fieldId);
    const label = value.trim();
    if (!label) {
      void load().catch(() => {});
      setError("Parameter name is required");
      putBack(key);
      return false;
    }
    return enqueueFieldOp(codeId, (fields) => relabelFieldById(fields, fieldId, label))
      .then((ok) => { if (ok) savedMarks.mark(key, label); return ok ? label : false; });
  }

  function commitDefaultInstruction(codeId: string, value: string): Promise<string | false> {
    return save(codeId, { body: { defaultInstruction: value } })
      .then((ok) => (ok ? value : false));
  }

  // The two panels with nothing to show until a code is picked read the same sentence.
  const pickACode = (
    <div className={CARD}>
      <p className="text-sm text-ink-500">
        Select a process step code to view its settings and suggested parameters.
      </p>
    </div>
  );

  return (
    <div className="min-w-0 p-3 sm:p-6">
      <PageHeader title="Process step codes" subtitle="The operation vocabulary used by part recipes."
        actions={<>
          <button type="button" onClick={focusNewCode} disabled={canCreate.disabled} title={canCreate.title}
                  className={BUTTON_PRIMARY}>
            Add step code
          </button>
          <button type="button" onClick={focusNewSuggestion} disabled={suggestionGate.disabled} title={suggestionGate.title}
                  className={BUTTON_NEUTRAL}>
            Add parameter suggestion
          </button>
          <ActionMenu items={[
            { label: "Parts", href: "/parts" },
          ]} />
        </>} />
      {(error ?? permsError) && (
        <p className={`${NOTICE.refusal} mb-3`}>{error ?? permsError}</p>
      )}
      <RecordTabs label={STEP_CODE_TAB_LABEL} tabs={stepCodeTabs()} open={openTab} panels={{
        codes: (
          <>
            <div id="step-codes-list" className={`${CARD_FLUSH} mb-3 overflow-x-auto`}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className={`${TABLE_HEAD} p-2`}>Code</th><th className={`${TABLE_HEAD} p-2`}>Name</th>
                    <th className={`${TABLE_HEAD} p-2`}>GL account</th><th className={`${TABLE_HEAD} p-2`}>Active</th>
                  </tr>
                </thead>
                <tbody>
                  {codes.map((c) => (
                    /* The row's one control is the Code cell's button, stretched over the row by
                       its ::after, so a click anywhere on the row is one click on one handler.
                       S2a (#239): hover feedback, suppressed on the selected row. */
                    <tr key={c.id} className={`relative border-t ${selected === c.id ? "bg-link-50" : "hover:bg-surface-50"}`}>
                      <td className={`${TABLE_CELL} font-mono`}>
                        <button type="button" onClick={() => openCode(c.id)}
                                aria-current={selected === c.id ? "true" : undefined}
                                className={`${LINK} cursor-pointer after:absolute after:inset-0`}>
                          {c.code}
                        </button>
                      </td>
                      <td className={TABLE_CELL}>{c.name}</td>
                      <td className={TABLE_CELL}>
                        {c.needsGlAccount ? <span className={BADGE_WARNING}>needs GL</span> : glAccountText(c.glAccountId, gls)}
                      </td>
                      <td className={TABLE_CELL}>{yesNo(c.active)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div id="new-step-code" className={CARD}>
              <div className="flex gap-1">
                <input ref={codeRef} value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                       disabled={canCreate.disabled} title={canCreate.title}
                       placeholder="Code" className={`${INPUT_COMPACT} w-24 disabled:bg-surface-50`} />
                <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                       disabled={canCreate.disabled} title={canCreate.title}
                       placeholder="Name" className={`${INPUT_COMPACT} min-w-0 flex-1 disabled:bg-surface-50`} />
                <button onClick={add} disabled={canCreate.disabled || adding} title={canCreate.title}
                        className={BUTTON_PRIMARY_COMPACT}>
                  Add
                </button>
              </div>
              <textarea value={draft.defaultInstruction}
                        onChange={(e) => setDraft({ ...draft, defaultInstruction: e.target.value })}
                        disabled={canCreate.disabled} title={canCreate.title}
                        aria-label="New code standard instructions"
                        rows={3} maxLength={4000} placeholder="Standard instructions (optional)"
                        className={`${INPUT_COMPACT} mt-2 w-full disabled:bg-surface-50`} />
            </div>
          </>
        ),
        selected: current ? (
          <div id="selected-code" className={CARD}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-medium">{current.code} — {current.name}</h2>
              <DangerButton onClick={() => void removeCode(current)} disabled={canDelete.disabled} title={canDelete.title}>
                Delete step code
              </DangerButton>
            </div>

            <label className="mb-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={current.active} disabled={canEdit.disabled} title={canEdit.title}
                     onChange={(e) => void save(current.id, { body: { active: e.target.checked } })} />
              Active
            </label>

            <label className="mb-4 block text-sm">
              GL account
              <Combobox value={current.glAccountId ?? ""} disabled={canEdit.disabled} title={canEdit.title}
                        options={glAccountOptions(gls, { blank: "(needs GL account)" })}
                        onSelect={(v) => void save(current.id, { body: { glAccountId: v || null } })}
                        ariaLabel="GL account" className="ml-2 inline-block w-72 align-middle" />
            </label>

            <label className="mb-4 block text-sm">
              Standard instructions
              <textarea
                value={draftValue(`${current.id}.defaultInstruction`, current.defaultInstruction)}
                disabled={canEdit.disabled} title={canEdit.title}
                rows={4} maxLength={4000}
                onFocus={(e) => noteFocus(focus.current, `${current.id}.defaultInstruction`, e.target.value)}
                onChange={(e) => setTextDrafts((drafts) => ({
                  ...drafts, [`${current.id}.defaultInstruction`]: e.target.value,
                }))}
                onBlur={(e) => leaveSave(`${current.id}.defaultInstruction`, e.target.value, (value) => commitDefaultInstruction(current.id, value))}
                className={`${INPUT_COMPACT} mt-1 block w-full disabled:bg-surface-50`}
              />
              <span className="mt-1 block text-xs text-ink-500">
                Copied into new part steps. Existing steps stay unchanged.
              </span>
            </label>

            <h3 className="mb-2 font-medium">Suggested parameters</h3>
            <table className="mb-2 w-full text-sm">
              <thead><tr className="text-left"><th>Name</th><th>Type</th><th>Unit</th><th /></tr></thead>
              <tbody>
                {current.fields.map((f, i) => (
                  <tr key={f.id} className="border-t">
                    <td className="py-1">
                      <input value={draftValue(fieldLabelDraftKey(current.id, f.id), f.label)}
                             disabled={canEdit.disabled} title={canEdit.title}
                             onFocus={(e) => noteFocus(focus.current, fieldLabelDraftKey(current.id, f.id), e.target.value)}
                             onChange={(e) => setTextDrafts((d) => ({ ...d, [fieldLabelDraftKey(current.id, f.id)]: e.target.value }))}
                             onBlur={(e) => leaveSave(fieldLabelDraftKey(current.id, f.id), e.target.value, (value) => commitLabel(current.id, f.id, value), trimmedText)}
                             onKeyDown={(e) => enterSave(e, fieldLabelDraftKey(current.id, f.id), (value) => commitLabel(current.id, f.id, value), trimmedText)}
                             className={`${INPUT_COMPACT} w-full disabled:bg-surface-50`} />
                      <SavedMark label="Name" show={savedMarks.shows(fieldLabelDraftKey(current.id, f.id), draftValue(fieldLabelDraftKey(current.id, f.id), f.label))} />
                    </td>
                    <td>
                      <select value={f.type} disabled title={FIXED_TYPE_AND_UNIT}
                              className={`${INPUT_COMPACT} disabled:bg-surface-50`}>
                        {STEP_FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </td>
                    <td>
                      <input value={f.unit ?? ""} disabled title={FIXED_TYPE_AND_UNIT}
                             className={`${INPUT_COMPACT} w-20 disabled:bg-surface-50`} />
                    </td>
                    <td className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        {/* §5.16 (#363): a button disabled at the end of the list says so. The
                            permission's reason wins when both apply, as in the part editor's ⋮ menu. */}
                        <button type="button" onClick={() => moveField(current.id, f.id, -1)}
                                {...moveGate(canEdit, i, current.fields.length, -1)}
                                aria-label="Move suggestion up"
                                className="text-sm text-ink-500 hover:text-ink-800">
                          ↑
                        </button>
                        <button type="button" onClick={() => moveField(current.id, f.id, 1)}
                                {...moveGate(canEdit, i, current.fields.length, 1)}
                                aria-label="Move suggestion down"
                                className="text-sm text-ink-500 hover:text-ink-800">
                          ↓
                        </button>
                        <button disabled={canEdit.disabled} title={canEdit.title}
                                className="text-xs text-red-600"
                                onClick={() => removeField(current.id, f.id)}>
                          remove
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div id="add-suggestion">
              <AddField disabled={canEdit.disabled} title={canEdit.title} nameRef={suggestionNameRef}
                        names={current.fields.map((f) => f.label)}
                        onAdd={(f) => void enqueueFieldOp(current.id, (fields) => [...fields, f])} />
            </div>
            <p className="mt-3 text-xs text-ink-500">
              Copied onto a new step of this code, in this order and with empty values. Editing a
              suggestion never changes a part&apos;s saved steps. To change a suggestion&apos;s type
              or unit, remove it and add a new one.
            </p>

            {blocked && blocked.code.id === current.id && (
              <BlockerPanel
                label="process step code"
                rowName={`${blocked.code.code} — ${blocked.code.name}`}
                list={blocked.list}
                exportHref={`/api/admin/step-codes/${blocked.code.id}/blockers/export`}
                onDismiss={() => setBlocked(null)}
                note={
                  "A step on a locked revision cannot be removed from it — that recipe is frozen " +
                  "by design, so a reference from one never goes away. If the parts above use " +
                  "this code only on superseded revisions, deleting it will never become " +
                  "possible: switch it to Inactive instead, which leaves the history intact and " +
                  "stops the code being offered on new steps."
                }
              />
            )}

          </div>
        ) : <div id="selected-code">{pickACode}</div>,
        history: (
          <div id="step-code-history">
            {current
              ? <HistoryPanel entity="processStepCode" entityId={current.id} perms={perms} permsError={permsError} />
              : pickACode}
          </div>
        ),
      }} />
    </div>
  );
}

function AddField({ onAdd, disabled, title, names, nameRef }: {
  onAdd: (f: NewField) => void; disabled: boolean; title: string | undefined; names: readonly string[];
  nameRef: RefObject<HTMLInputElement | null>;
}) {
  const [label, setLabel] = useState("");
  const [type, setType] = useState<StepFieldType>("NUMBER");
  const [unit, setUnit] = useState("");
  return (
    <div className="flex gap-1">
      <input ref={nameRef} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Parameter name"
             disabled={disabled} title={title}
             className={`${INPUT_COMPACT} flex-1 disabled:bg-surface-50`} />
      <select value={type} onChange={(e) => setType(e.target.value as StepFieldType)}
              disabled={disabled} title={title}
              className={`${INPUT_COMPACT} disabled:bg-surface-50`}>
        {STEP_FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="Unit"
             disabled={disabled} title={title}
             className={`${INPUT_COMPACT} w-20 disabled:bg-surface-50`} />
      {/* §5.16 (#396, #406): a name that is empty, only whitespace, or one the code already has
          disables the button, with the reason; the permission's reason wins. The name is added
          trimmed, as a rename saves it. */}
      <button disabled={disabled || addSuggestionRefusal(label, names) !== undefined}
              title={disabled ? title : addSuggestionRefusal(label, names)}
              className={BUTTON_PRIMARY_COMPACT}
              onClick={() => { if (addSuggestionRefusal(label, names) === undefined) { onAdd({ label: label.trim(), type, unit: unit || null, sort: 0 }); setLabel(""); setUnit(""); } }}>
        Add parameter suggestion
      </button>
    </div>
  );
}
