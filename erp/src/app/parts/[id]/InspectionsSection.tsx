"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { PanelMessage } from "@/components/PanelMessage";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { optionsSelectTitle, type OptionsRead } from "@/lib/options-read";
import { moveGate } from "@/lib/reorder";
import { useSaveScope } from "@/lib/save-scope";
import { invalidateHistory } from "@/components/HistoryPanel";
import { decimalRefusal } from "@/lib/decimal-entry";
import { INSPECTION_MAX, INSPECTION_MIN } from "@/lib/part-boxes";
import { enterBox, focusRecord, leaveBox, noteFocus, type BoxCommit } from "@/lib/focus-record";
import { SavedMark } from "@/components/SavedMark";
import { useSavedMarks } from "@/lib/use-saved-marks";
import { BUTTON_PRIMARY_COMPACT, CARD, INPUT_COMPACT } from "@/lib/ui-classes";

type InspRow = {
  id: string; inspectionCodeId: string; inspectionCodeName: string;
  scaleId: string | null; scaleName: string | null;
  min: number | string | null; max: number | string | null; sampleQty: string; location: string; sort: number;
};
/** The free-text/decimal cells this grid edits in place (the two <select>s save directly).
 *  `sampleQty` is deliberately a string, not a number — owner ruling 2026-08-03, spec §3.9. */
type TextField = "min" | "max" | "sampleQty" | "location";
type CodeOption = { id: string; name: string; active: boolean };
type ScaleOption = { id: string; name: string; active: boolean };

const emptyDraft = { inspectionCodeId: "", scaleId: "", min: "", max: "", sampleQty: "", location: "" };

export function InspectionsSection({
  partId, perms, onOptionsError,
}: {
  partId: string;
  perms: string[] | undefined;
  onOptionsError: (message: string) => void;
}) {
  // This section's own message (owner ruling R1, P6 step 5c): its reads, saves and row actions
  // report here, through the shared PanelMessage, where they used to write the page banner. The
  // setter keeps the name `onError` that the handlers and the tests that lift them read.
  const [sectionMessage, onError] = useState<string | null>(null);
  const [rows, setRows] = useState<InspRow[]>([]);
  // Set only once `load()` has actually landed a real list (the PricingSection `rowsReady`
  // port): `rows` starts `[]` the same as "loaded, genuinely empty", so `add()` used to be
  // unable to tell those apart and would happily mint sort 0 while the initial GET was still in
  // flight OR had already failed — a failed load is the steady state on an error, not a
  // transient race, so without this a duplicate sort-0 could sit there indefinitely.
  const [rowsReady, setRowsReady] = useState(false);
  const [codes, setCodes] = useState<CodeOption[]>([]);
  const [scales, setScales] = useState<ScaleOption[]>([]);
  const [draft, setDraft] = useState(emptyDraft);
  const canEdit = gate(perms, "parts.edit");

  // Guards the list reload two ways (save-scope.ts — the PricingSection shape; this section
  // previously had no reload ticket at all): overlapping reloads stay ordered, and a reload's
  // GET waits out the saves registered below, re-fetching if one is dispatched mid-fetch, so a
  // §5.13 rollback reload can never revert a NEWER row's optimistic patch (#15's section-local
  // analog). `load` never touches the error state, so it doubles as the no-clear rollback
  // variant.
  const saveScope = useSaveScope();
  const load = useCallback(
    () => saveScope.reload(
      () => api<InspRow[]>(`/api/parts/${partId}/inspections`),
      (data) => { setRows(data); setRowsReady(true); },
    ),
    [partId, saveScope],
  );
  useEffect(() => { load().catch((e) => onError((e as Error).message)); }, [load, onError]);

  // F9: a failed code/scale-options fetch used to report through the shared `onError`, which a
  // later successful save elsewhere on the page resets to null — see IdentitySection's comment on
  // the same fix. `onOptionsError` writes into the page's persistent `loadError` instead, and
  // `codesRead`/`scalesRead` disable the affected selects (both the per-row ones and the
  // add-row draft ones) until their fetch actually succeeds.
  //
  // includeInactive=1 on both: an inspection row can carry a code or scale that's since been
  // marked inactive (the R3 pattern from customers/[id]/page.tsx's Terms/Parent selects).
  // Without it a controlled <select> bound to that id would match no <option> and silently fall
  // back to blank, misrepresenting stored data and risking clobbering the real value on the next
  // interaction.
  //
  // Note the deliberate gap this section does NOT try to close: the inspection code's default
  // scale (inspectionCode.defaultScaleId) lives on the reference row, but the pick-list
  // projection this route exposes is `{ id, name, active }` only — no default-scale prefill is
  // available to a non-admin screen. The scale select is left blank for the user to choose
  // rather than widening /api/picklists to leak that field; recorded as a papercut in the PR body.
  const [codesRead, setCodesRead] = useState<OptionsRead>("loading");
  const [scalesRead, setScalesRead] = useState<OptionsRead>("loading");
  useEffect(() => {
    api<CodeOption[]>("/api/picklists/inspectionCode?includeInactive=1").then((data) => {
      setCodes(data);
      setCodesRead("ready");
    }).catch((e) => { setCodesRead("failed"); onOptionsError((e as Error).message); });
  }, [onOptionsError]);
  useEffect(() => {
    api<ScaleOption[]>("/api/picklists/inspectionScale?includeInactive=1").then((data) => {
      setScales(data);
      setScalesRead("ready");
    }).catch((e) => { setScalesRead("failed"); onOptionsError((e as Error).message); });
  }, [onOptionsError]);

  function setRowField(id: string, field: TextField, value: string) {
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  }
  // Optimistic (mirrors customers/[id]/page.tsx's saveAddressField): the row already shows the
  // new value (either from setRowField above on a text field, or from the <select>'s own native
  // behavior), so a failure has something to roll back. The PATCH registers with saveScope at
  // call time — no serial() queue here, so the round-trip itself is the registered save — and
  // the §5.13 rollback is fired detached (never awaited: the reload waits for every registered
  // save, this one included, to settle before its GET dispatches).
  async function saveRow(id: string, patch: Record<string, unknown>): Promise<boolean> {
    setRows((cur) => cur.map((r) => (r.id === id ? ({ ...r, ...patch } as InspRow) : r)));
    const put = api(`/api/parts/${partId}/inspections/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
    saveScope.begin(put);
    try {
      await put;
      onError(null);
      invalidateHistory(); // #14 item 1 — success path, the instant the save resolves
      return true;
    } catch (e) {
      onError((e as Error).message);
      void load().catch(() => {});
      return false;
    }
  }
  // Each box's text when the cursor entered it, and the text an accepted Enter sent (owner ruling
  // R7: Enter commits a box as leaving it does, the cursor kept in it), in src/lib/focus-record.ts.
  const focus = useRef(focusRecord());
  const savedMarks = useSavedMarks();
  const boxKey = (id: string, field: TextField) => `${id}.${field}`;
  const noteBox = (id: string, field: TextField) =>
    (e: React.FocusEvent<HTMLInputElement>) => noteFocus(focus.current, boxKey(id, field), e.target.value);
  // A box's save, answering the text the box shows once it lands, or false when it did not.
  function saveBox(id: string, field: TextField, value: string, sent: string | null): Promise<string | false> {
    return saveRow(id, { [field]: sent }).then((ok) => {
      if (!ok) return false;
      savedMarks.mark(boxKey(id, field), value, { decimal: field === "min" || field === "max" });
      return value;
    });
  }
  // A saved row's Min or Max is read by the one rule before it is sent (#517): a refused figure is
  // named with its row's code, the box goes back to what it held at focus, and nothing is sent.
  // A blank (spaces alone included) is "no bound", which the service reads as null.
  function commitInspectionLimit(id: string, field: "min" | "max", value: string, atFocus: string): false | Promise<string | false> {
    const blank = value.trim() === "";
    if (!blank) {
      const box = field === "min" ? INSPECTION_MIN : INSPECTION_MAX;
      const row = rows.find((r) => r.id === id);
      // The code the row holds now: a Code change saves only its id, so the row's name can lag
      // until the next load. The code list names it as the select shows it.
      const codeName = codes.find((c) => c.id === row?.inspectionCodeId)?.name ?? row?.inspectionCodeName ?? "";
      const refused = decimalRefusal(`${codeName}, ${box.label}`, value, box.box);
      if (refused) {
        setRowField(id, field, atFocus);
        onError(refused);
        return false;
      }
    }
    return saveBox(id, field, value, blank ? null : value);
  }
  // min/max are nullable decimals, checked above. sampleQty and location are plain strings whose
  // empty value IS "" (their column default); sending null there would fail the zod string parse
  // rather than clear the field.
  function commitBox(id: string, field: TextField): BoxCommit {
    return (value, atFocus) => (field === "min" || field === "max"
      ? commitInspectionLimit(id, field, value, atFocus)
      : saveBox(id, field, value, value));
  }
  function blurSave(e: React.FocusEvent<HTMLInputElement>, id: string, field: TextField) {
    leaveBox(focus.current, boxKey(id, field), e.target.value, commitBox(id, field));
  }
  function enterSave(e: React.KeyboardEvent<HTMLInputElement>, id: string, field: TextField) {
    enterBox(e, focus.current, boxKey(id, field), e.currentTarget.value, commitBox(id, field));
  }

  // #681 (G5-3): one request in flight per control (#145's rule, which PricingSection already
  // keeps). Each hold is a ref checked first, so a second click of the same tick is refused before
  // any state lands, with state beside it for `disabled=` and the Add label. A double-click on Add
  // used to store two identical inspection rows, which both printed on the traveler and seeded cert
  // requirements; on delete it sent a second DELETE answered 404.
  const adding = useRef(false); const [addingState, setAddingState] = useState(false);
  const removing = useRef(false); const [removingState, setRemovingState] = useState(false);
  async function removeRow(id: string) {
    if (removing.current) return;
    removing.current = true; setRemovingState(true);
    try {
      await api(`/api/parts/${partId}/inspections/${id}`, { method: "DELETE" });
      onError(null);
      invalidateHistory(); // #14 item 1
      await load();
    } catch (e) { onError((e as Error).message); }
    finally { removing.current = false; setRemovingState(false); }
  }
  // G1: computes the full new order client-side (swap idx/j in the displayed list) and sends it
  // as ONE call to the atomic reorder route, which writes every changed `sort` inside a single
  // Serializable transaction. Replaces the old two-PATCH swap of `sort` values: if the second of
  // those PATCHes failed, both rows kept the SAME sort, and since listPartInspections orders
  // purely by sort, a tie rendered nondeterministically with no way to "swap back" out of it.
  async function move(idx: number, dir: -1 | 1) {
    const j = idx + dir;
    if (j < 0 || j >= rows.length) return;
    const reordered = [...rows];
    [reordered[idx], reordered[j]] = [reordered[j], reordered[idx]];
    const put = api(`/api/parts/${partId}/inspections/order`, {
      method: "PUT",
      body: JSON.stringify({ orderedIds: reordered.map((r) => r.id) }),
    });
    saveScope.begin(put);
    try {
      await put;
      onError(null);
      invalidateHistory(); // #14 item 1
      await load();
    } catch (e) {
      // §5.13 rollback, detached — the saveRow() shape above. (The success path may await
      // load(): by then the registered PUT has settled, so the reload cannot deadlock on it.)
      onError((e as Error).message);
      void load().catch(() => {});
    }
  }
  async function add() {
    if (!draft.inspectionCodeId) return;
    // The PricingSection addRow guard: `rows` reads `[]` both when the part genuinely has no
    // inspections yet AND when the initial GET is still in flight or has failed outright — on a
    // failed load that empty array is the steady state, not a momentary race. Without this,
    // `nextSort` below computed `0` either way, so a failed fetch silently produced a duplicate
    // sort-0 the instant the user added a row. Refuse rather than guess.
    if (!rowsReady) {
      onError("Inspection rows have not finished loading yet — reload the page and try again.");
      return;
    }
    // The Add row's Min and Max are read by the one rule before anything is posted: each refused
    // box is a line of its own, Min first, the draft stays as typed, and nothing is sent.
    const lines = [
      decimalRefusal(INSPECTION_MIN.label, draft.min, INSPECTION_MIN.box),
      decimalRefusal(INSPECTION_MAX.label, draft.max, INSPECTION_MAX.box),
    ].filter((line): line is string => line !== null);
    if (lines.length > 0) { onError(lines.join("\n")); return; }
    if (adding.current) return; // #681: the hold, after the guards above and before the request
    adding.current = true; setAddingState(true);
    try {
      // F6: rows.length duplicates a sort value after a mid-list delete — deleting row 0 of 3
      // leaves rows at sort {1, 2}, and rows.length (now 2) collides with the row still at sort
      // 2 instead of landing after it. The highest sort actually present, plus one, always lands
      // strictly after every row on screen regardless of gaps left by earlier deletes.
      const nextSort = rows.length ? Math.max(...rows.map((r) => r.sort)) + 1 : 0;
      await api(`/api/parts/${partId}/inspections`, {
        method: "POST",
        body: JSON.stringify({
          inspectionCodeId: draft.inspectionCodeId,
          scaleId: draft.scaleId || null,
          min: draft.min === "" ? undefined : draft.min,
          max: draft.max === "" ? undefined : draft.max,
          // Fix-wave R2 finding 1: this was missing entirely, so every add silently dropped
          // whatever the operator typed into Sample qty (the server's own default, "", is
          // indistinguishable from "the field was never sent").
          sampleQty: draft.sampleQty,
          location: draft.location,
          sort: nextSort,
        }),
      });
      setDraft(emptyDraft);
      onError(null);
      invalidateHistory(); // #14 item 1
      await load();
    } catch (e) { onError((e as Error).message); }
    finally { adding.current = false; setAddingState(false); }
  }

  return (
    <section className={`${CARD} mb-6`}>
      <h2 className="mb-2 font-medium">Inspection requirements</h2>
      {/* The table scrolls inside this card on a narrow screen, so the part page never scrolls
          sideways (spec 2026-09-26 §4, measured at 863 px). An overflow wrapper alone is not
          enough: the page's column beside the rail is a flex item that cannot shrink below its
          content's minimum width, and that minimum still counts the table's. `w-0 min-w-full`
          takes the table out of it (a zero width is what the wrapper contributes) while laying
          the wrapper out full width, so it scrolls instead of widening the page. */}
      <div className="w-0 min-w-full overflow-x-auto">
      <table className="mb-2 w-full text-sm">
        <thead>
          <tr className="text-left">
            <th className="py-1">Code</th><th>Scale</th><th>Min</th><th>Max</th><th>Sample qty</th>
            <th>Location</th><th /><th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={r.id} className="border-t">
              <td className="py-1">
                <select value={r.inspectionCodeId} disabled={!canEdit.allowed || codesRead !== "ready"}
                        title={optionsSelectTitle(canEdit, codesRead)}
                        onChange={(e) => void saveRow(r.id, { inspectionCodeId: e.target.value })}
                        className={INPUT_COMPACT}>
                  {codes.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}{!c.active && " (inactive)"}</option>
                  ))}
                </select>
              </td>
              <td>
                <select value={r.scaleId ?? ""} disabled={!canEdit.allowed || scalesRead !== "ready"}
                        title={optionsSelectTitle(canEdit, scalesRead)}
                        onChange={(e) => void saveRow(r.id, { scaleId: e.target.value || null })}
                        className={INPUT_COMPACT}>
                  <option value="">—</option>
                  {scales.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}{!s.active && " (inactive)"}</option>
                  ))}
                </select>
              </td>
              <td>
                <input value={r.min ?? ""} inputMode="decimal" onFocus={noteBox(r.id, "min")} readOnly={!canEdit.allowed}
                       title={canEdit.title}
                       onChange={(e) => setRowField(r.id, "min", e.target.value)}
                       onBlur={(e) => blurSave(e, r.id, "min")}
                       onKeyDown={(e) => enterSave(e, r.id, "min")}
                       className={`${INPUT_COMPACT} w-16 read-only:bg-surface-50`} />
                <SavedMark label={INSPECTION_MIN.label} show={savedMarks.shows(`${r.id}.min`, String(r.min ?? ""))} />
              </td>
              <td>
                <input value={r.max ?? ""} inputMode="decimal" onFocus={noteBox(r.id, "max")} readOnly={!canEdit.allowed}
                       title={canEdit.title}
                       onChange={(e) => setRowField(r.id, "max", e.target.value)}
                       onBlur={(e) => blurSave(e, r.id, "max")}
                       onKeyDown={(e) => enterSave(e, r.id, "max")}
                       className={`${INPUT_COMPACT} w-16 read-only:bg-surface-50`} />
                <SavedMark label={INSPECTION_MAX.label} show={savedMarks.shows(`${r.id}.max`, String(r.max ?? ""))} />
              </td>
              <td>
                <input value={r.sampleQty} onFocus={noteBox(r.id, "sampleQty")} readOnly={!canEdit.allowed} title={canEdit.title}
                       aria-label="Sample quantity"
                       onChange={(e) => setRowField(r.id, "sampleQty", e.target.value)}
                       onBlur={(e) => blurSave(e, r.id, "sampleQty")}
                       onKeyDown={(e) => enterSave(e, r.id, "sampleQty")}
                       className={`${INPUT_COMPACT} w-24 read-only:bg-surface-50`} />
                <SavedMark label="Sample quantity" show={savedMarks.shows(`${r.id}.sampleQty`, r.sampleQty)} />
              </td>
              <td>
                <input value={r.location} onFocus={noteBox(r.id, "location")} readOnly={!canEdit.allowed} title={canEdit.title}
                       onChange={(e) => setRowField(r.id, "location", e.target.value)}
                       onBlur={(e) => blurSave(e, r.id, "location")}
                       onKeyDown={(e) => enterSave(e, r.id, "location")}
                       className={`${INPUT_COMPACT} w-28 read-only:bg-surface-50`} />
                <SavedMark label="Location" show={savedMarks.shows(`${r.id}.location`, r.location)} />
              </td>
              <td className="text-right">
                <button onClick={() => move(idx, -1)} {...moveGate(canEdit, idx, rows.length, -1)}
                        aria-label="Move up"
                        className="mr-1 text-sm text-ink-500 hover:text-ink-800">
                  ↑
                </button>
                <button onClick={() => move(idx, 1)} {...moveGate(canEdit, idx, rows.length, 1)}
                        aria-label="Move down"
                        className="text-sm text-ink-500 hover:text-ink-800">
                  ↓
                </button>
              </td>
              <td className="text-right">
                <button onClick={() => removeRow(r.id)} disabled={canEdit.disabled || removingState}
                        title={removingState ? "Removing…" : canEdit.title}
                        className="text-xs text-red-600">
                  delete
                </button>
              </td>
            </tr>
          ))}
          {/* The entry row is a row OF this table (#239 L2a). It used to be a `flex` strip under
              the table with the same six controls in the same order and its own padding, so it
              lined up with the column grid only by coincidence — and stopped doing so the moment
              a saved row's code name, scale name or location was longer than the placeholder
              beside it. Same controls, same draft state, same handlers; only the box they sit in
              changed, and each cell takes the data rows' own `px-1 py-0.5` so the two read as one
              grid. The Add button spans the two action columns the saved rows use for reorder and
              delete, neither of which an unsaved row has. */}
          <tr className="border-t">
            <td className="py-1">
              <select value={draft.inspectionCodeId} disabled={!canEdit.allowed || codesRead !== "ready"}
                      title={optionsSelectTitle(canEdit, codesRead)}
                      onChange={(e) => setDraft({ ...draft, inspectionCodeId: e.target.value })}
                      className={INPUT_COMPACT}>
                <option value="">Code…</option>
                {codes.map((c) => <option key={c.id} value={c.id}>{c.name}{!c.active && " (inactive)"}</option>)}
              </select>
            </td>
            <td>
              <select value={draft.scaleId} disabled={!canEdit.allowed || scalesRead !== "ready"}
                      title={optionsSelectTitle(canEdit, scalesRead)}
                      onChange={(e) => setDraft({ ...draft, scaleId: e.target.value })}
                      className={INPUT_COMPACT}>
                <option value="">Scale…</option>
                {scales.map((s) => <option key={s.id} value={s.id}>{s.name}{!s.active && " (inactive)"}</option>)}
              </select>
            </td>
            <td>
              <input value={draft.min} placeholder="Min" inputMode="decimal" disabled={!canEdit.allowed}
                     title={canEdit.title}
                     onChange={(e) => setDraft({ ...draft, min: e.target.value })}
                     className={`${INPUT_COMPACT} w-16`} />
            </td>
            <td>
              <input value={draft.max} placeholder="Max" inputMode="decimal" disabled={!canEdit.allowed}
                     title={canEdit.title}
                     onChange={(e) => setDraft({ ...draft, max: e.target.value })}
                     className={`${INPUT_COMPACT} w-16`} />
            </td>
            <td>
              <input value={draft.sampleQty} placeholder="Sample qty" disabled={!canEdit.allowed}
                     title={canEdit.title}
                     onChange={(e) => setDraft({ ...draft, sampleQty: e.target.value })}
                     className={`${INPUT_COMPACT} w-24`} />
            </td>
            <td>
              <input value={draft.location} placeholder="Location" disabled={!canEdit.allowed}
                     title={canEdit.title}
                     onChange={(e) => setDraft({ ...draft, location: e.target.value })}
                     className={`${INPUT_COMPACT} w-28`} />
            </td>
            <td colSpan={2} className="text-right">
              <button onClick={add} disabled={canEdit.disabled || !draft.inspectionCodeId || !rowsReady || addingState}
                      title={!rowsReady ? "Inspection rows have not finished loading yet — reload the page and try again."
                        : addingState ? "Adding…" : canEdit.title}
                      className={BUTTON_PRIMARY_COMPACT}>
                {addingState ? "Adding…" : "Add inspection requirement"}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      </div>
      <PanelMessage message={sectionMessage} />
    </section>
  );
}
