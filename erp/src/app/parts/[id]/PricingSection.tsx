"use client";
import { useCallback, useEffect, useState } from "react";
import { PanelMessage } from "@/components/PanelMessage";
import { api } from "@/lib/fetcher";
import { gate, gateDo, type Gate } from "@/lib/permission-ui";
import { optionsSelectTitle, type OptionsRead } from "@/lib/options-read";
import { PRICE_PER, PRICE_PER_LABELS, type PricePerValue } from "@/lib/part-constants";
import { askConfirm } from "@/lib/modal";
import { removePriceQuestion } from "@/lib/part-tabs";
import { priceBasisAsks, priceBasisQuestion } from "@/lib/price-basis-question";
import { moveGate, swapAt } from "@/lib/reorder";
import { useSaveScope } from "@/lib/save-scope";
import { invalidateHistory } from "@/components/HistoryPanel";
import { normalizePriceText } from "@/lib/price-display";
import { BREAK_PRICE, BREAK_THRESHOLD, MINIMUM_CHARGE, SETUP_CHARGE, UNIT_PRICE } from "@/lib/price-boxes";
import { breakBoxRefusal, newBreakRefusals, rowBoxRefusal } from "@/lib/pricing-refusals";
import type { EditGuard } from "@/lib/use-edit-guard";
import { breakTextKey, retainBreakTexts, withoutBreakText, type BreakTexts } from "@/lib/price-break-texts";
import { SavedMark } from "@/components/SavedMark";
import { useSavedMarks } from "@/lib/use-saved-marks";
import { sameSentValue } from "@/lib/line-field-saves";
import { isEnterCommit, type EnterKeyEvent } from "@/lib/enter-commit";
import { BUTTON_PRIMARY_COMPACT, CARD, INPUT_COMPACT } from "@/lib/ui-classes";

// Local mirrors of src/server/part-prices.ts's PartPriceRow/PartBreakRow — not imported from
// src/server/**, since a client component pulling from there drags node:async_hooks and Prisma
// into the browser bundle (CLAUDE.md "Constraints that will bite you"). Decimal fields are
// `number | string` (and `| null` where the column is nullable): a value loaded from the server is
// a number, but mid-edit the bound input holds whatever text the user is typing — the
// customers/[id]/page.tsx creditLimit precedent.
type PriceBreak = { id: string; threshold: number | string; price: number | string };
type PriceRow = {
  id: string;
  processStepCodeId: string;
  stepCode: string;
  stepName: string;
  position: number;
  setupCharge: number | string | null;
  unitPrice: number | string | null;
  minimumCharge: number | string | null;
  pricePer: PricePerValue;
  breaks: PriceBreak[];
};
type StepCodeOption = { id: string; name: string; active: boolean };

type RowMoneyField = "setupCharge" | "unitPrice" | "minimumCharge";
type BreakField = "threshold" | "price";

export function PricingSection({
  partId, perms, onOptionsError, editGuard,
}: {
  partId: string;
  perms: string[] | undefined;
  onOptionsError: (message: string) => void;
  /** The page's one edit guard (#652): the three money boxes of each row register as keyed cells
   *  of the "prices" collection and every landing of `rows` goes through `applyRows`, so a reload
   *  (every add, remove, move, and every failed save's rollback) refreshes every row but the cell
   *  under the cursor. A break's cells are nested and keep their typed text in `breakTexts`. */
  editGuard: EditGuard;
}) {
  // This section's own message (owner ruling R1, P6 step 5c): its reads, saves and row actions
  // report here, through the shared PanelMessage, where they used to write the page banner. The
  // setter keeps the name `onError` that the handlers and the tests that lift them read.
  const [sectionMessage, onError] = useState<string | null>(null);
  const canEdit = gate(perms, "parts.edit");
  const priceGate = gateDo(perms, "change_prices");
  // Every control in this section needs BOTH gates — parts.edit (can this user touch the part at
  // all) and change_prices (can they touch pricing specifically), spec §7. Computed once and
  // reused rather than re-derived per control. The title favors whichever is actually the
  // blocker: a user who holds change_prices but not parts.edit sees the edit gate's reason
  // instead of "Requires change_prices" for a control they were never going to be allowed to
  // touch regardless. (Carried over from the pre-Phase-5A PricingSection.)
  const disabled = canEdit.disabled || priceGate.disabled;
  const title = canEdit.disabled ? canEdit.title : priceGate.title;
  /** The two gates as one, for the step-code selects' title while their options read is out (#684). */
  const priceEdit: Gate = { allowed: !disabled, disabled, title };

  const [rows, setRows] = useState<PriceRow[]>([]);
  const savedMarks = useSavedMarks();
  // Set only once `load()` has actually landed a real list (fix-wave 1, finding 1's "also fix"):
  // `rows` starts `[]` the same as "loaded, genuinely empty", so `addRow` used to be unable to
  // tell those apart and would happily mint position 0 while the initial GET was still in
  // flight OR had already failed — a failed load is the steady state on an error, not a
  // transient race, so without this a duplicate position-0 could sit there indefinitely.
  const [rowsReady, setRowsReady] = useState(false);
  const [codes, setCodes] = useState<StepCodeOption[]>([]);
  const [codesRead, setCodesRead] = useState<OptionsRead>("loading");
  const [addCodeId, setAddCodeId] = useState("");
  const [addingRow, setAddingRow] = useState(false);
  // #145: the `addingRow` shape ported to the section's other three fire-a-request buttons — a
  // second click faster than the round trip otherwise issues a second unordered request (a
  // duplicate break POST, a double DELETE). One boolean per operation kind (the literal addingRow
  // port): every button of that kind disables for the one-request window, which also sidesteps
  // the scalar-id race where a second target's start forgets the first's in-flight state.
  const [addingBreak, setAddingBreak] = useState(false);
  const [removingBreak, setRemovingBreak] = useState(false);
  const [removingRow, setRemovingRow] = useState(false);
  // Per-row "add a break" draft, keyed by price row id — a card's own nested table gets its own
  // add-row, so one shared draft (the old flat section's shape) would leak text typed under one
  // operation's breaks into another's the moment either was submitted.
  const [breakDrafts, setBreakDrafts] = useState<Record<string, { threshold: string; price: string }>>({});
  function draftFor(priceId: string) {
    return breakDrafts[priceId] ?? { threshold: "", price: "" };
  }
  // A SAVED break's typed-but-unblurred text, keyed by break id and field and composed with the
  // row's figure at render (#652; src/lib/price-break-texts.ts says why it is not in `rows`).
  // Pruned to the payload's breaks at every landing; dropped at the cell's blur.
  const [breakTexts, setBreakTexts] = useState<BreakTexts>({});
  function breakText(b: PriceBreak, field: BreakField): string {
    const key = breakTextKey(b.id, field);
    return Object.hasOwn(breakTexts, key) ? breakTexts[key] : String(b[field]);
  }
  function setBreakText(breakId: string, field: BreakField, value: string) {
    setBreakTexts((cur) => ({ ...cur, [breakTextKey(breakId, field)]: value }));
  }

  // Guards the list reload two ways (save-scope.ts, whose internal latest-gate replaced the
  // bare useLatest ticket this section carried): overlapping reloads stay ordered — this section
  // funnels every mutation through the same full-list `load()`, so a slower earlier reload
  // landing after a faster later one would otherwise silently revert the screen past what the
  // user just did — AND a reload's GET waits out the saves registered below, re-fetching if one
  // is dispatched mid-fetch, so a §5.13 rollback reload can never revert a NEWER row's
  // optimistic patch (#15's section-local analog). `load` never touches the error state, so it
  // doubles as the no-clear rollback variant.
  const saveScope = useSaveScope();
  const load = useCallback(
    () => saveScope.reload(
      () => api<PriceRow[]>(`/api/parts/${partId}/prices`),
      (data) => {
        setRows(editGuard.applyRows("prices", data));
        setBreakTexts((cur) => retainBreakTexts(cur, data.flatMap((r) => r.breaks.map((b) => b.id))));
        setRowsReady(true);
      },
    ),
    [partId, saveScope, editGuard],
  );
  useEffect(() => { load().catch((e) => onError((e as Error).message)); }, [load, onError]);

  // F9: a failed step-code-options fetch reports through `onOptionsError` (the page's persistent
  // loadError banner), not `onError`, which a later successful save in this section clears —
  // the Inspections/Specs sections' precedent. includeInactive=1: an existing row can be priced
  // against a step code that's since gone inactive (the Inspections code/scale precedent) — the
  // per-row select below still needs it as an option, not just the Add-operation picker.
  useEffect(() => {
    api<StepCodeOption[]>("/api/picklists/processStepCode?includeInactive=1").then((data) => {
      setCodes(data);
      setCodesRead("ready");
    }).catch((e) => { setCodesRead("failed"); onOptionsError((e as Error).message); });
  }, [onOptionsError]);

  function setRowField(id: string, field: RowMoneyField, value: string) {
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  }
  // Optimistic (mirrors InspectionsSection's saveRow): the row already shows the new value, so a
  // failure has something to roll back. The PATCH registers with saveScope at call time — no
  // serial() queue here, so the round-trip itself is the registered save — and the §5.13
  // rollback is fired detached (never awaited: the reload waits for every registered save,
  // this one included, to settle before its GET dispatches). Server messages (the
  // LOT-with-breaks refusal, the duplicate-operation refusal) surface verbatim; no client
  // re-paraphrasing.
  async function saveRow(id: string, patch: Record<string, unknown>): Promise<boolean> {
    setRows((cur) => cur.map((r) => (r.id === id ? ({ ...r, ...patch } as PriceRow) : r)));
    const put = api(`/api/parts/${partId}/prices/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
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

  // A row money box blurs through `editGuard.onBlurSave`, which hands this only a value the user
  // typed (a value the box was given, at focus or by a landed payload, is a no-op) together with
  // the newest value the box was given, the stored figure.
  function commitRow(id: string, field: RowMoneyField, value: string, atFocus: string) {
    // The same figure respelled ("0.55" for "0.5500", the re-set below after a landed save, now made
    // under the cursor once Enter keeps it there) is not a change: nothing is sent (P8 risk 3).
    if (value.trim() !== "" && atFocus.trim() !== "" && sameSentValue(atFocus, value)) return;
    // A box the one decimal rule refuses goes back to the figure it held at focus, which is the
    // stored one: this section has no unsaved-work guard, so a refused figure left on screen
    // would read as saved (owner answer 3). The red line names the box by its place; nothing is
    // sent, so there is no rollback reload and no history entry. A blank is a clear, not a refusal.
    if (value.trim() !== "") {
      const refusal = rowBoxRefusal(rows, id, field, value);
      if (refusal !== null) {
        setRowField(id, field, atFocus);
        onError(refusal);
        return false; // the box is back on a value it was given (the guard's Enter contract)
      }
    }
    const sent = value.trim() === "" ? null : value;
    void saveRow(id, { [field]: sent }).then((ok) => {
      // The one Saved mark (R7), on the landed save only.
      if (ok) savedMarks.mark(`price:${id}:${field}`, sent ?? "", { decimal: true });
      // #14 item 4: on a SUCCESSFUL blur-save, re-set the field to the text a reload would render
      // ("0.5500" → "0.55" — src/lib/price-display.ts), so the session never shows text the next
      // reload (or the audit diff) contradicts. Only if the field still holds the exact text this
      // save sent — the user may have refocused and typed on while the PATCH was in flight, and a
      // late re-set must not clobber that. This is a set from the client, not a landed payload,
      // so the guard does not judge it; the equality check is its stand-in for this one write.
      if (!ok || sent === null) return;
      setRows((cur) => cur.map((r) => (r.id === id && r[field] === sent
        ? { ...r, [field]: normalizePriceText(sent) } : r)));
    });
  }

  // The open question this task owns (task-5 brief, carried in from Task 4's review): moving a
  // row's basis among the non-LOT units (EACH/LB/PER_1000/PER_100) while it still has live breaks
  // silently changes what every stored `threshold` means — the service does not (and, per Task 9's
  // marker, should not: a row whose breaks predate a basis change is a state the pricing engine is
  // explicitly expected to cope with) refuse this the way it refuses a LOT move. Decision: warn,
  // don't refuse and don't attempt to re-derive new thresholds — refusing would foreclose a state
  // Task 9 is already scoped to handle, and re-stating the numbers would require a unit conversion
  // (e.g. EACH -> LB needs a weight-per-piece) this screen has no authority to invent. The old
  // flat-column surface allowed the same move with no warning at all; this at least tells the user
  // what just happened before it happens. LOT itself needs no client-side pre-check — the existing
  // save path already surfaces the server's LOT_WITH_BREAKS refusal verbatim.
  // PR 3's question on the quote page, stated once (`price-basis-question.ts`): the wording names the
  // row's Unit price as well as every break's threshold and price (fix-wave 1, finding 2), since an
  // EACH -> LB switch silently turns $2.25/piece into $2.25/lb on every one of them. Nothing is set
  // locally before the answer, so a no leaves the controlled <select> at row.pricePer.
  async function changePricePer(row: PriceRow, next: PricePerValue) {
    if (next === row.pricePer) return;
    if (priceBasisAsks(row.pricePer, next, row.breaks.length)
      && !await askConfirm(priceBasisQuestion(row.pricePer, next, row.breaks.length))) return;
    void saveRow(row.id, { pricePer: next });
  }

  async function removeRow(row: PriceRow) {
    if (removingRow) return; // one at a time (#145, the addRow guard's shape)
    if (!await askConfirm(removePriceQuestion(row.stepName))) return;
    setRemovingRow(true);
    try {
      await api(`/api/parts/${partId}/prices/${row.id}`, { method: "DELETE" });
      onError(null);
      invalidateHistory(); // #14 item 1
      await load();
    } catch (e) { onError((e as Error).message); }
    finally { setRemovingRow(false); }
  }

  // Fix-wave 1, finding 1: computes the full new order client-side and sends it as ONE call to
  // the atomic /prices/order route (the InspectionsSection/ProcessStepsSection `move()`
  // precedent). The old two-PATCH position swap (assign a.position = b.position, then
  // b.position = a.position) is a permutation of the multiset of position values — no sequence of
  // up/down clicks can ever remove a duplicate from it. If the second PATCH failed (network blip,
  // session expiry, the row soft-deleted by another user mid-swap), both rows kept the SAME
  // position, and since listPartPrices orders purely by position (then id), that tie is
  // permanent: the up/down buttons between the tied rows become no-ops forever, with deleting and
  // re-adding the row as the only escape. This ordering is what an invoice prints in.
  async function move(idx: number, dir: -1 | 1) {
    const reordered = swapAt(rows, idx, dir); // bounds check only — the buttons are already
    if (!reordered) return;                   // disabled at the ends of the list (belt + braces).
    const put = api(`/api/parts/${partId}/prices/order`, {
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

  // One at a time (the ProcessStepsSection addStepAction precedent) — `addingRow` blocks a second
  // click from firing before the first POST returns.
  async function addRow() {
    if (!addCodeId || addingRow) return;
    // Fix-wave 1, finding 1: `rows` reads `[]` both when the part genuinely has no priced
    // operations yet AND when the initial GET is still in flight or has failed outright — on a
    // failed load that empty array is the steady state, not a momentary race. Without this guard,
    // `nextPosition` below computed `0` either way, so a failed prices fetch silently produced a
    // duplicate position-0 the instant the user added an operation. Refuse rather than guess.
    if (!rowsReady) {
      onError("Price rows have not finished loading yet — reload the page and try again.");
      return;
    }
    setAddingRow(true);
    try {
      // The highest position actually present, plus one — not rows.length, which duplicates a
      // position after a mid-list delete (the InspectionsSection F6 fix).
      const nextPosition = rows.length ? Math.max(...rows.map((r) => r.position)) + 1 : 0;
      await api(`/api/parts/${partId}/prices`, {
        method: "POST", body: JSON.stringify({ processStepCodeId: addCodeId, position: nextPosition }),
      });
      setAddCodeId("");
      onError(null);
      invalidateHistory(); // #14 item 1
      await load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setAddingRow(false);
    }
  }

  function setBreakDraft(priceId: string, field: BreakField, value: string) {
    setBreakDrafts((cur) => ({ ...cur, [priceId]: { ...draftFor(priceId), [field]: value } }));
  }
  async function saveBreak(priceId: string, breakId: string, patch: Record<string, unknown>): Promise<boolean> {
    setRows((cur) => cur.map((r) => (r.id === priceId
      ? { ...r, breaks: r.breaks.map((b) => (b.id === breakId ? ({ ...b, ...patch } as PriceBreak) : b)) }
      : r)));
    const put = api(`/api/parts/${partId}/prices/${priceId}/breaks/${breakId}`, {
      method: "PATCH", body: JSON.stringify(patch) });
    saveScope.begin(put);
    try {
      await put;
      onError(null);
      invalidateHistory(); // #14 item 1
      return true;
    } catch (e) {
      // §5.13 rollback, detached — the saveRow() shape above.
      onError((e as Error).message);
      void load().catch(() => {});
      return false;
    }
  }
  // A saved break's cell blurs here. Its typed text is `breakTexts`' entry (#652), dropped
  // whatever the blur decides, so the box shows the row's figure again unless a save lands a
  // new one: no entry means nothing was typed since the last blur, and text equal to the row's
  // figure means nothing changed, so neither sends anything.
  function blurSaveBreak(priceId: string, breakId: string, field: BreakField) {
    const key = breakTextKey(breakId, field);
    if (!Object.hasOwn(breakTexts, key)) return;
    const value = breakTexts[key];
    setBreakTexts((cur) => withoutBreakText(cur, key));
    const stored = rows.find((r) => r.id === priceId)?.breaks.find((b) => b.id === breakId)?.[field];
    if (stored === undefined || value === String(stored)) return;
    // Fix-wave 1, finding 5: unlike the row money fields above (setupCharge/unitPrice/
    // minimumCharge, all nullable — commitRow sends `null` on ""), a break's threshold/price
    // columns are NOT NULL, so there is no legal "cleared" value to send here. Sending raw ""
    // used to reach decimalField(12,2,{required:true}), which rejects it with "enter a number
    // without $ or commas, such as 0.36." — a refusal that names the wrong problem (a house rule,
    // not a format error). Short-circuit client-side: the dropped text leaves the stored figure
    // in the box; say plainly why, instead of firing a save that can only fail.
    if (value.trim() === "") {
      onError(`${field === "threshold" ? BREAK_THRESHOLD.label : BREAK_PRICE.label} cannot be blank — delete the break instead.`);
      return;
    }
    // The same rule for a typed figure: the stored text stays, the box named by its place.
    const refusal = breakBoxRefusal(rows, priceId, breakId, field, value);
    if (refusal !== null) {
      onError(refusal);
      return;
    }
    void saveBreak(priceId, breakId, { [field]: value }).then((ok) => {
      // #14 item 4 — the blurSaveRow convention above, applied to the break cells (they are the
      // same class of 4-decimal input; leaving them un-normalized would recreate the issue one
      // table down). Same still-holds-the-sent-text guard.
      if (!ok) return;
      savedMarks.mark(`break:${breakId}:${field}`, value, { decimal: true });
      setRows((cur) => cur.map((r) => (r.id === priceId
        ? {
            ...r,
            breaks: r.breaks.map((b) => (b.id === breakId && b[field] === value
              ? { ...b, [field]: normalizePriceText(value) } : b)),
          }
        : r)));
    });
  }
  // Enter commits a break's cell as leaving it does, the cursor kept in it (owner ruling R7). The
  // cell needs no record of its text at focus: the blur drops the cell's typed text whatever it
  // decides, so the blur after an Enter finds none and sends nothing.
  function enterSaveBreak(e: EnterKeyEvent, priceId: string, breakId: string, field: BreakField) {
    if (isEnterCommit(e)) blurSaveBreak(priceId, breakId, field);
  }
  async function addBreak(priceId: string) {
    const draft = draftFor(priceId);
    if (!draft.threshold.trim() || !draft.price.trim() || addingBreak) return; // one at a time (#145)
    // Both boxes of the Add break row are checked and every refusal listed, one per line. The
    // draft keeps its text: it is this row's own typing, not a saved figure.
    const refusals = newBreakRefusals(rows.findIndex((r) => r.id === priceId) + 1, draft);
    if (refusals.length > 0) {
      onError(refusals.join("\n"));
      return;
    }
    setAddingBreak(true);
    try {
      await api(`/api/parts/${partId}/prices/${priceId}/breaks`, {
        method: "POST", body: JSON.stringify({ threshold: draft.threshold, price: draft.price }),
      });
      setBreakDrafts((cur) => ({ ...cur, [priceId]: { threshold: "", price: "" } }));
      onError(null);
      invalidateHistory(); // #14 item 1
      await load();
    } catch (e) { onError((e as Error).message); }
    finally { setAddingBreak(false); }
  }
  async function removeBreak(priceId: string, breakId: string) {
    if (removingBreak) return; // one at a time (#145)
    setRemovingBreak(true);
    try {
      await api(`/api/parts/${partId}/prices/${priceId}/breaks/${breakId}`, { method: "DELETE" });
      onError(null);
      invalidateHistory(); // #14 item 1
      await load();
    } catch (e) { onError((e as Error).message); }
    finally { setRemovingBreak(false); }
  }

  return (
    <section className={`${CARD} mb-6`}>
      <h2 className="mb-2 font-medium">Operation prices</h2>

      {rows.length === 0 && (
        <p className="mb-3 text-sm text-ink-500">No priced operations yet — add one below.</p>
      )}

      <div className="mb-4 space-y-4">
        {rows.map((row, idx) => {
          // R3: a controlled <select> bound to an id absent from its options renders blank,
          // misrepresenting the stored assignment and risking clobbering it on the next
          // interaction (the InspectionsSection/customers-page precedent) — reachable here if the
          // options fetch is still in flight, failed, or (in principle) omitted a code. A
          // synthesized fallback option built straight from the row's own embedded stepCode/
          // stepName (no extra fetch needed) keeps the control honest either way.
          const hasCode = codes.some((c) => c.id === row.processStepCodeId);
          return (
            <div key={row.id} className="rounded border p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <select value={row.processStepCodeId} disabled={disabled || codesRead !== "ready"}
                        title={optionsSelectTitle(priceEdit, codesRead)}
                        onChange={(e) => void saveRow(row.id, { processStepCodeId: e.target.value })}
                        className={INPUT_COMPACT}>
                  {!hasCode && (
                    <option value={row.processStepCodeId}>{row.stepCode} — {row.stepName}</option>
                  )}
                  {codes.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}{!c.active && " (inactive)"}</option>
                  ))}
                </select>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => move(idx, -1)}
                          {...moveGate({ disabled, title }, idx, rows.length, -1)} aria-label="Move up"
                          className="text-sm text-ink-500 hover:text-ink-800">
                    ↑
                  </button>
                  <button type="button" onClick={() => move(idx, 1)}
                          {...moveGate({ disabled, title }, idx, rows.length, 1)} aria-label="Move down"
                          className="text-sm text-ink-500 hover:text-ink-800">
                    ↓
                  </button>
                  <button type="button" onClick={() => void removeRow(row)}
                          disabled={disabled || removingRow}
                          title={removingRow ? "Removing…" : title}
                          className="text-xs text-red-600">
                    Remove operation price
                  </button>
                </div>
              </div>

              <div className="mb-3 grid grid-cols-4 gap-3">
                <label className="block text-sm">
                  {SETUP_CHARGE.label}
                  <input aria-label={SETUP_CHARGE.label} value={row.setupCharge ?? ""} inputMode="decimal"
                         onFocus={editGuard.onFocusCell("prices", row.id, "setupCharge")}
                         readOnly={disabled} title={title}
                         onChange={(e) => setRowField(row.id, "setupCharge", e.target.value)}
                         onBlur={(e) => editGuard.onBlurSave(e, (value, atFocus) => commitRow(row.id, "setupCharge", value, atFocus))}
                         onKeyDown={(e) => editGuard.onEnterCommit(e, (value, atFocus) => commitRow(row.id, "setupCharge", value, atFocus))}
                         className={`${INPUT_COMPACT} mt-1 w-full text-right read-only:bg-surface-50`} />
                  <SavedMark label={SETUP_CHARGE.label} show={savedMarks.shows(`price:${row.id}:setupCharge`, String(row.setupCharge ?? ""))} />
                </label>
                <label className="block text-sm">
                  {UNIT_PRICE.label}
                  <input aria-label={UNIT_PRICE.label} value={row.unitPrice ?? ""} inputMode="decimal"
                         onFocus={editGuard.onFocusCell("prices", row.id, "unitPrice")}
                         readOnly={disabled} title={title}
                         onChange={(e) => setRowField(row.id, "unitPrice", e.target.value)}
                         onBlur={(e) => editGuard.onBlurSave(e, (value, atFocus) => commitRow(row.id, "unitPrice", value, atFocus))}
                         onKeyDown={(e) => editGuard.onEnterCommit(e, (value, atFocus) => commitRow(row.id, "unitPrice", value, atFocus))}
                         className={`${INPUT_COMPACT} mt-1 w-full text-right read-only:bg-surface-50`} />
                  <SavedMark label={UNIT_PRICE.label} show={savedMarks.shows(`price:${row.id}:unitPrice`, String(row.unitPrice ?? ""))} />
                </label>
                <label className="block text-sm">
                  {MINIMUM_CHARGE.label}
                  <input aria-label={MINIMUM_CHARGE.label} value={row.minimumCharge ?? ""} inputMode="decimal"
                         onFocus={editGuard.onFocusCell("prices", row.id, "minimumCharge")}
                         readOnly={disabled} title={title}
                         onChange={(e) => setRowField(row.id, "minimumCharge", e.target.value)}
                         onBlur={(e) => editGuard.onBlurSave(e, (value, atFocus) => commitRow(row.id, "minimumCharge", value, atFocus))}
                         onKeyDown={(e) => editGuard.onEnterCommit(e, (value, atFocus) => commitRow(row.id, "minimumCharge", value, atFocus))}
                         className={`${INPUT_COMPACT} mt-1 w-full text-right read-only:bg-surface-50`} />
                  <SavedMark label={MINIMUM_CHARGE.label} show={savedMarks.shows(`price:${row.id}:minimumCharge`, String(row.minimumCharge ?? ""))} />
                </label>
                <label className="block text-sm">
                  Price per
                  <select value={row.pricePer} disabled={disabled} title={title}
                          onChange={(e) => void changePricePer(row, e.target.value as PricePerValue)}
                          className={`${INPUT_COMPACT} mt-1 w-full disabled:bg-surface-50`}>
                    {PRICE_PER.map((p) => <option key={p} value={p}>{PRICE_PER_LABELS[p]}</option>)}
                  </select>
                </label>
              </div>

              <h3 className="mb-1 text-xs font-medium text-ink-500">Price breaks</h3>
              <table className="mb-2 w-full text-sm">
                <thead>
                  <tr className="text-left">
                    <th className="py-1">{BREAK_THRESHOLD.label}</th><th>{BREAK_PRICE.label}</th><th />
                  </tr>
                </thead>
                <tbody>
                  {row.breaks.map((b) => (
                    <tr key={b.id} className="border-t">
                      <td className="py-1">
                        <input value={breakText(b, "threshold")} inputMode="decimal"
                               readOnly={disabled} title={title}
                               onChange={(e) => setBreakText(b.id, "threshold", e.target.value)}
                               onBlur={() => blurSaveBreak(row.id, b.id, "threshold")}
                               onKeyDown={(e) => enterSaveBreak(e, row.id, b.id, "threshold")}
                               className={`${INPUT_COMPACT} w-24 text-right read-only:bg-surface-50`} />
                        <SavedMark label={BREAK_THRESHOLD.label} show={savedMarks.shows(`break:${b.id}:threshold`, breakText(b, "threshold"))} />
                      </td>
                      <td>
                        <input value={breakText(b, "price")} inputMode="decimal"
                               readOnly={disabled} title={title}
                               onChange={(e) => setBreakText(b.id, "price", e.target.value)}
                               onBlur={() => blurSaveBreak(row.id, b.id, "price")}
                               onKeyDown={(e) => enterSaveBreak(e, row.id, b.id, "price")}
                               className={`${INPUT_COMPACT} w-24 text-right read-only:bg-surface-50`} />
                        <SavedMark label={BREAK_PRICE.label} show={savedMarks.shows(`break:${b.id}:price`, breakText(b, "price"))} />
                      </td>
                      <td className="text-right">
                        <button onClick={() => removeBreak(row.id, b.id)}
                                disabled={disabled || removingBreak}
                                title={removingBreak ? "Removing…" : title}
                                className="text-xs text-red-600">
                          delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex gap-2">
                <input value={draftFor(row.id).threshold} placeholder={BREAK_THRESHOLD.label} inputMode="decimal"
                       disabled={disabled} title={title}
                       onChange={(e) => setBreakDraft(row.id, "threshold", e.target.value)}
                       className={`${INPUT_COMPACT} w-24`} />
                <input value={draftFor(row.id).price} placeholder={BREAK_PRICE.label} inputMode="decimal"
                       disabled={disabled} title={title}
                       onChange={(e) => setBreakDraft(row.id, "price", e.target.value)}
                       className={`${INPUT_COMPACT} w-24`} />
                <button onClick={() => addBreak(row.id)}
                        disabled={disabled || !draftFor(row.id).threshold || !draftFor(row.id).price || addingBreak}
                        title={addingBreak ? "Adding…" : title}
                        className={BUTTON_PRIMARY_COMPACT}>
                  Add price break
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <select value={addCodeId} disabled={disabled || codesRead !== "ready"}
                title={optionsSelectTitle(priceEdit, codesRead)}
                onChange={(e) => setAddCodeId(e.target.value)}
                className={INPUT_COMPACT}>
          <option value="">Add operation: code…</option>
          {codes.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button onClick={addRow} disabled={disabled || !addCodeId || addingRow || !rowsReady}
                title={!rowsReady ? "Price rows have not finished loading yet — reload the page and try again."
                  : addingRow ? "Adding…" : title}
                className={BUTTON_PRIMARY_COMPACT}>
          {addingRow ? "Adding…" : "Add operation"}
        </button>
      </div>
      <PanelMessage message={sectionMessage} />
    </section>
  );
}
