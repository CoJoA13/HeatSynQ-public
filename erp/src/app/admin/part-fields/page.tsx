"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/fetcher";
import { PART_FIELD_TYPES, type PartFieldTypeValue } from "@/lib/part-constants";
import { nextSort } from "@/lib/next-sort";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { BlockerPanel, type Blocker } from "@/components/BlockerPanel";
import { HistoryPanel, invalidateHistory } from "@/components/HistoryPanel";
import { PageHeader } from "@/components/PageHeader";
import { RecordTabs } from "@/components/RecordTabs";
import { SavedMark } from "@/components/SavedMark";
import { PART_FIELD_TAB_LABEL, partFieldTabs } from "@/lib/admin-tabs";
import { focusWhenShown } from "@/lib/focus-when-shown";
import { askConfirm } from "@/lib/modal";
import { useSavedMarks } from "@/lib/use-saved-marks";
import { enterBox, focusRecord, heldText, leaveBox, noteFocus, trimmedText, withoutSettledDraft, type BoxCommit, type SameText } from "@/lib/focus-record";
import { BUTTON_PRIMARY, BUTTON_PRIMARY_COMPACT, CARD, CARD_FLUSH, INPUT_COMPACT, NOTICE, TABLE_HEAD } from "@/lib/ui-classes";
import { oneShotHold } from "@/lib/single-flight";

type FieldDef = { id: string; name: string; type: PartFieldTypeValue; sort: number; active: boolean };

export default function PartFieldsPage() {
  const [rows, setRows] = useState<FieldDef[]>([]);
  const [draft, setDraft] = useState<{ name: string; type: PartFieldTypeValue; sort: number }>({
    name: "", type: PART_FIELD_TYPES[0], sort: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ row: FieldDef; list: Blocker[]; verb: string } | null>(null);
  // #720: Add's hold, so a second click while the POST is out sends nothing (it would be refused
  // as a duplicate name after the first landed).
  const [adding, setAdding] = useState(false);
  const [addHold] = useState(() => oneShotHold(setAdding));
  const { permissions: perms, error: permsError } = usePermissions();
  // Gated per the permission each route actually enforces (ReferenceTable.tsx precedent, fixed
  // in 2C-1's review, followed here rather than the step-codes page, which gates none of this):
  // add hits POST requiring admin.create, every row edit (name/type/sort/active) hits PUT
  // requiring admin.edit, delete hits DELETE requiring admin.delete
  // (src/app/api/admin/part-fields/route.ts, .../[id]/route.ts).
  const canCreate = gate(perms, "admin.create");
  const canEdit = gate(perms, "admin.edit");
  const canDelete = gate(perms, "admin.delete");

  // includeInactive=1 always: unlike the reference grid, there is no separate "show inactive"
  // filter here — the Active column IS the reactivation control, so an inactive def must stay
  // visible to be turned back on.
  // H1 (Codex round 3 review): the draft's sort used to be seeded once at mount (useState's
  // `sort: 0` initializer) and reset on a successful add to `rows.length` — a papercut on its
  // own (issue #14 item 3: the draft goes stale the moment rows change from any OTHER save/
  // delete, since nothing recomputed it) and a real bug once rows have a gap: two rows sorted
  // 0, 2 (e.g. after the row that held sort 1 was deleted) give `rows.length` = 2, which
  // duplicates the live sort-2 row instead of landing after it. Recomputing from the FRESHLY
  // loaded rows on every load() call — which already runs on mount and after every save/add/
  // delete — fixes both: the draft's sort default is never stale, and it is always one past the
  // highest live sort regardless of gaps.
  // Ticket-gated (the surcharges/page.tsx load shape): load() is refired from six caller sites
  // unserialized, so overlapping loads used to land in arrival order. The gate covers BOTH writes
  // — setRows AND the draft-sort recompute (stale bookkeeping is as wrong as stale rows).
  const latest = useLatest();
  const load = useCallback(async () => {
    const ticket = latest.next();
    try {
      const data = await api<FieldDef[]>("/api/admin/part-fields?includeInactive=1");
      if (!latest.isCurrent(ticket)) return; // a slower, now-superseded load lost the state race
      setRows(data);
      setDraft((d) => ({ ...d, sort: nextSort(data) }));
    } catch (e) {
      // F7 (customers/page.tsx): a superseded load's rejection must not clobber current state.
      if (!latest.isCurrent(ticket)) return;
      throw e;
    }
  }, [latest]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  // What the user has typed into a row's Name/Sort input but not yet blurred, keyed by
  // `${rowId}.${field}` — composed with the server value at render time (`draftValue`), never
  // written into `rows` (the surcharges/page.tsx textDrafts pattern). Writing keystrokes into
  // `rows` meant a landing load reverted mid-typing text, and a blur from there saved the mangled
  // value. NOTE: unlike surcharges/step-codes, save bodies here are SINGLE-FIELD partials, so
  // there is no whole-row write-back amplification and no rowsRef/accept mechanism is needed —
  // the drafts only protect the typing itself. Cleared when the field's OWN save settles.
  const [textDrafts, setTextDrafts] = useState<Record<string, string>>({});
  function draftValue(key: string, serverValue: string): string {
    return Object.hasOwn(textDrafts, key) ? textDrafts[key] : serverValue;
  }

  /** Answers whether the write landed. */
  async function save(id: string, body: Record<string, unknown>): Promise<boolean> {
    try {
      await api(`/api/admin/part-fields/${id}`, { method: "PUT", body: JSON.stringify(body) });
      invalidateHistory(); // the History tab's panel, on the success path before the reload (#158)
      setError(null); setBlocked(null); await load();
      return true;
    } catch (e) {
      // Roll back to server truth FIRST, then report why (§5.13) — a failed edit must not leave
      // a stale, unsaved value sitting in the grid looking as if it took effect. The reload's own
      // failure is swallowed here only because the original error below is what gets reported;
      // it is not silencing that original error.
      await load().catch(() => {});
      const message = (e as Error).message;
      // A blocked type change is the same "not a dead end" case as a blocked delete below
      // (ReferenceTable.tsx precedent): say what's holding a value on this field and make the
      // list exportable, rather than just reporting the 400 text.
      const row = rows.find((r) => r.id === id);
      if (e instanceof ApiError && e.status === 400 && message.includes("its type cannot change") && row) {
        try {
          const list = await api<Blocker[]>(`/api/admin/part-fields/${id}/blockers`);
          if (list.length) { setBlocked({ row, list, verb: "change the type of" }); setError(null); return false; }
        } catch (listErr) {
          setError(`${message} — the list of what's using it could not be loaded ` +
            `(${(listErr as Error).message}). Try again.`);
          return false;
        }
      }
      setError(message);
      return false;
    }
  }

  // onFocus/onBlur split (IdentitySection.tsx precedent): typing doesn't hit the network on every
  // keystroke, and tabbing through a row without changing it writes no no-op audit entry. Enter
  // commits a box as leaving it does, the cursor kept in it (owner ruling R7); each box's text at
  // focus, and the text an accepted Enter sent, live in src/lib/focus-record.ts.
  const focus = useRef(focusRecord());
  const savedMarks = useSavedMarks();
  const clearDraft = (key: string) => setTextDrafts((d) => { const n = { ...d }; delete n[key]; return n; });
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
  // A box's save: the text the box shows once it lands, or false when it did not. Its draft goes
  // when the newest save of the box settles (`leaveSave`, `enterSave`).
  function saveBox(key: string, id: string, body: Record<string, unknown>, shown: string): Promise<string | false> {
    return save(id, body).then((ok) => { if (ok) savedMarks.mark(key, shown); return ok ? shown : false; });
  }

  function commitName(id: string): BoxCommit {
    return (value) => {
      const key = `${id}.name`;
      const name = value.trim();
      if (!name) {
        // Revert to server truth; its own failure is swallowed here the same way save()'s catch
        // swallows it (§5.13) — the validation message below is what gets reported either way.
        void load().catch(() => {});
        setError("Name is required");
        putBack(key);
        return false;
      }
      return saveBox(key, id, { name }, name);
    };
  }

  function commitSort(id: string): BoxCommit {
    return (value) => {
      const key = `${id}.sort`;
      const n = Number(value);
      // Empty is rejected too (the surcharges position-blur guard): Number("") is 0, so a blur from
      // a backspaced-to-empty field used to silently save sort 0 — the mangled-value class.
      if (value.trim() === "" || !Number.isInteger(n) || n < 0) {
        void load().catch(() => {});
        setError("Sort must be a whole number, 0 or greater");
        putBack(key);
        return false;
      }
      return saveBox(key, id, { sort: n }, String(n));
    };
  }

  // The header's Add field opens the definitions and takes the cursor to the row's Name box.
  const [openTab, setOpenTab] = useState<{ id: string; key: string } | null>(null);
  const openRequests = useRef(0);
  const nameRef = useRef<HTMLInputElement>(null);
  function focusNewField() {
    openRequests.current += 1;
    setOpenTab({ id: "field-definitions", key: String(openRequests.current) });
    focusWhenShown(() => nameRef.current);
  }
  // The History tab's field: one the list still holds, so a deleted field's id shows the sentence.
  const [historyId, setHistoryId] = useState("");
  const historyField = rows.some((r) => r.id === historyId) ? historyId : null;

  async function add() {
    await addHold.run(async () => {
      try {
        await api("/api/admin/part-fields", { method: "POST", body: JSON.stringify(draft) });
        invalidateHistory();
        setError(null); setBlocked(null);
        // load() (above) recomputes the draft's sort from the freshly loaded rows, INCLUDING the
        // row just added — this reset must only clear name/type and keep that fresh sort, not
        // reintroduce the same stale rows.length calculation here.
        await load();
        setDraft((d) => ({ name: "", type: PART_FIELD_TYPES[0], sort: d.sort }));
      } catch (e) { setError((e as Error).message); }
    });
  }

  async function remove(row: FieldDef) {
    if (!await askConfirm({ title: `Delete part field "${row.name}"?`, body: "", confirm: "Delete", danger: true })) return;
    try {
      await api(`/api/admin/part-fields/${row.id}`, { method: "DELETE" });
      invalidateHistory();
      setError(null); setBlocked(null); await load();
    } catch (e) {
      // A refusal is not a dead end (ReferenceTable.tsx precedent): say what's blocking, and
      // make the list exportable. Only the delete guard's own 400 means a blocker list exists to
      // fetch — a 500 or a network failure is a genuine error, not a refusal, and fetching (and
      // likely finding no) blockers for it would misreport a real failure as "N records use it".
      if (e instanceof ApiError && e.status === 400) {
        try {
          const list = await api<Blocker[]>(`/api/admin/part-fields/${row.id}/blockers`);
          if (list.length) { setBlocked({ row, list, verb: "delete" }); setError(null); return; }
        } catch (listErr) {
          setError(`${(e as Error).message} — the list of what's using it could not be loaded ` +
            `(${(listErr as Error).message}). Try again.`);
          return;
        }
      }
      setError((e as Error).message);
    }
  }

  return (
    <div className="min-w-0 p-3 sm:p-6">
      <PageHeader title="Part fields" subtitle="Only extra information the shop actually needs."
        actions={
          <button type="button" onClick={focusNewField} disabled={canCreate.disabled} title={canCreate.title}
                  className={BUTTON_PRIMARY}>
            Add field
          </button>
        } />
      {(error ?? permsError) && (
        <p className={`${NOTICE.refusal} mb-3`}>{error ?? permsError}</p>
      )}
      <RecordTabs label={PART_FIELD_TAB_LABEL} tabs={partFieldTabs()} open={openTab} panels={{
        fields: (
          <>
            <div id="field-definitions" className={`${CARD_FLUSH} overflow-x-auto`}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className={`${TABLE_HEAD} p-2`}>Name</th><th className={`${TABLE_HEAD} p-2`}>Type</th><th className={`${TABLE_HEAD} p-2`}>Sort</th>
                  <th className={`${TABLE_HEAD} p-2`}>Active</th><th className={TABLE_HEAD} />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="p-2">
                      {/* value from the draft overlay; onChange writes the draft, never rows (the
                          surcharges/page.tsx textDrafts pattern). */}
                      <input value={draftValue(`${r.id}.name`, r.name)} disabled={canEdit.disabled} title={canEdit.title}
                             aria-label="Name"
                             onFocus={(e) => noteFocus(focus.current, `${r.id}.name`, e.target.value)}
                             onChange={(e) => setTextDrafts((d) => ({ ...d, [`${r.id}.name`]: e.target.value }))}
                             onBlur={(e) => leaveSave(`${r.id}.name`, e.target.value, commitName(r.id), trimmedText)}
                             onKeyDown={(e) => enterSave(e, `${r.id}.name`, commitName(r.id), trimmedText)}
                             className={`${INPUT_COMPACT} w-full disabled:bg-surface-50`} />
                      <SavedMark label="Name" show={savedMarks.shows(`${r.id}.name`, draftValue(`${r.id}.name`, r.name))} />
                    </td>
                    <td className="p-2">
                      <select value={r.type} disabled={canEdit.disabled} title={canEdit.title}
                              onChange={(e) => void save(r.id, { type: e.target.value })}
                              className={`${INPUT_COMPACT} disabled:bg-surface-50`}>
                        {PART_FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </td>
                    <td className="p-2">
                      {/* Draft overlay like Name — the old onChange parsed through `Number(...) || 0`
                          into rows, so backspacing to empty instantly re-rendered as "0" and a blur
                          from there saved sort 0 (the surcharges Position precedent). */}
                      <input value={draftValue(`${r.id}.sort`, String(r.sort))} type="number"
                             disabled={canEdit.disabled} title={canEdit.title}
                             aria-label="Sort"
                             onFocus={(e) => noteFocus(focus.current, `${r.id}.sort`, e.target.value)}
                             onChange={(e) => setTextDrafts((d) => ({ ...d, [`${r.id}.sort`]: e.target.value }))}
                             onBlur={(e) => leaveSave(`${r.id}.sort`, e.target.value, commitSort(r.id))}
                             onKeyDown={(e) => enterSave(e, `${r.id}.sort`, commitSort(r.id))}
                             className={`${INPUT_COMPACT} w-20 disabled:bg-surface-50`} />
                      <SavedMark label="Sort" show={savedMarks.shows(`${r.id}.sort`, draftValue(`${r.id}.sort`, String(r.sort)))} />
                    </td>
                    <td className="p-2">
                      <input type="checkbox" checked={r.active} disabled={canEdit.disabled} title={canEdit.title}
                             onChange={(e) => void save(r.id, { active: e.target.checked })} />
                    </td>
                    <td className="p-2 text-right">
                      <button onClick={() => remove(r)} disabled={canDelete.disabled} title={canDelete.title}
                              className="text-xs text-red-600">
                        delete
                      </button>
                    </td>
                  </tr>
                ))}
                <tr className="border-t bg-surface-50">
                  <td className="p-2">
                    <input ref={nameRef} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                           disabled={canCreate.disabled} title={canCreate.title}
                           placeholder="Name" className={`${INPUT_COMPACT} w-full disabled:bg-surface-50`} />
                  </td>
                  <td className="p-2">
                    <select value={draft.type}
                            onChange={(e) => setDraft({ ...draft, type: e.target.value as PartFieldTypeValue })}
                            disabled={canCreate.disabled} title={canCreate.title}
                            className={`${INPUT_COMPACT} disabled:bg-surface-50`}>
                      {PART_FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </td>
                  <td className="p-2">
                    <input value={draft.sort} type="number"
                           onChange={(e) => setDraft({ ...draft, sort: Number(e.target.value) || 0 })}
                           disabled={canCreate.disabled} title={canCreate.title}
                           className={`${INPUT_COMPACT} w-20 disabled:bg-surface-50`} />
                  </td>
                  <td />
                  <td className="p-2 text-right">
                    <button onClick={add} disabled={canCreate.disabled || adding} title={canCreate.title}
                            className={BUTTON_PRIMARY_COMPACT}>
                      Add
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
            </div>
            {blocked && (
              <BlockerPanel
                label="part field"
                rowName={blocked.row.name}
                list={blocked.list}
                action={blocked.verb}
                exportHref={`/api/admin/part-fields/${blocked.row.id}/blockers/export`}
                onDismiss={() => setBlocked(null)}
              />
            )}
          </>
        ),
        history: (
          <div className={CARD}>
            <select aria-label="Part field" value={historyField ?? ""} onChange={(e) => setHistoryId(e.target.value)}
                    className={`${INPUT_COMPACT} mb-3`}>
              <option value="">Part field…</option>
              {rows.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            {historyField
              ? <HistoryPanel entity="partFieldDef" entityId={historyField} perms={perms} permsError={permsError} />
              : <p className="text-sm text-ink-500">Select a part field to view its history.</p>}
          </div>
        ),
      }} />
    </div>
  );
}
