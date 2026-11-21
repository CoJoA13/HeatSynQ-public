"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/fetcher";
import { gate, gateDo } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest, useMutationGate } from "@/lib/use-latest";
import { percentToDecimal, decimalToPercentText } from "@/lib/surcharge-percent";
import { decimalRefusal } from "@/lib/decimal-entry";
import { SURCHARGE_AMOUNT, SURCHARGE_MINIMUM_AMOUNT, SURCHARGE_RATE } from "@/lib/rate-boxes";
import { plantDefaultNoun, surchargeRateText } from "@/lib/surcharge-display";
import {
  buildSurchargeBody as buildBody,
  type SurchargeRow as Surcharge,
  type SurchargeSaveFields as SaveFields,
} from "@/lib/surcharge-body";
import {
  SURCHARGE_KINDS, SURCHARGE_KIND_LABELS, SURCHARGE_SCOPES, SURCHARGE_SCOPE_LABELS,
  type SurchargeKindValue, type SurchargeScopeValue,
} from "@/lib/invoice-constants";
import { BlockerPanel, type Blocker } from "@/components/BlockerPanel";
import { DangerButton } from "@/components/DangerButton";
import { PageHeader } from "@/components/PageHeader";
import { RecordTabs } from "@/components/RecordTabs";
import { SURCHARGE_TAB_LABEL, surchargeTabs } from "@/lib/admin-tabs";
import { focusWhenShown } from "@/lib/focus-when-shown";
import { yesNo } from "@/lib/format";
import { askConfirm } from "@/lib/modal";
import { glAccountText } from "@/lib/step-code-tabs";
import { SavedMark } from "@/components/SavedMark";
import { useSavedMarks } from "@/lib/use-saved-marks";
import { sameSentValue } from "@/lib/line-field-saves";
import { enterBox, focusRecord, heldText, leaveBox, noteFocus, trimmedText, withoutSettledDraft, type BoxCommit, type SameText } from "@/lib/focus-record";
import { HistoryPanel, invalidateHistory } from "@/components/HistoryPanel";
import { BADGE_WARNING, BUTTON_PRIMARY, BUTTON_PRIMARY_COMPACT, CARD, CARD_FLUSH, INPUT_COMPACT, LINK, NOTICE, TABLE_CELL, TABLE_HEAD } from "@/lib/ui-classes";
import { oneShotHold } from "@/lib/single-flight";

type Gl = { id: string; name: string; description?: string };
type StepCodeOption = { id: string; name: string; active: boolean };

/** Formats a Decimal(12,2) money value the way the field itself is scaled, not however many
 *  digits happen to survive `Decimal.toNumber()` — `String(2.5)` is `"2.5"`, silently dropping
 *  the trailing cent a stored `2.50` actually carries (Fix 7, review). */
function moneyText(value: number | null): string {
  return value === null ? "" : value.toFixed(2);
}

export default function SurchargesPage() {
  const [rows, setRows] = useState<Surcharge[]>([]);
  const [gls, setGls] = useState<Gl[]>([]);
  const [stepCodeOptions, setStepCodeOptions] = useState<StepCodeOption[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ name: string; kind: SurchargeKindValue; valueText: string }>({
    name: "", kind: "PERCENT", valueText: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ row: Surcharge; list: Blocker[] } | null>(null);
  // #720: Add's hold, so a second click while the POST is out sends nothing (it would be refused
  // as a duplicate name after the first landed).
  const [adding, setAdding] = useState(false);
  const [addHold] = useState(() => oneShotHold(setAdding));
  // What the user has actually typed into a free-text numeric field (rate%, amount, minimum
  // amount, position) but not yet blurred, keyed by `${rowId}.${field}` — composed with the
  // server value at render time (`draftValue` below), not a parallel editable copy of the row.
  // Reformatting the display on every keystroke (e.g. converting through `Number(...)`
  // immediately) strips a trailing decimal point the instant it's typed, making "4.5" untypeable
  // — and for `position`, `Number("")` is `0`, so backspacing to empty would instantly re-render
  // as "0" and a stray blur from there would silently save `position: 0` (Fix 4, review). Keeping
  // the raw text here until blur avoids both. Cleared on selection change and after every save
  // settles.
  const [textDrafts, setTextDrafts] = useState<Record<string, string>>({});
  function draftValue(key: string, serverValue: string): string {
    return Object.hasOwn(textDrafts, key) ? textDrafts[key] : serverValue;
  }
  // The one place this page departed from "keep only what the user typed" (Fix 3, review):
  // `setKindLocal` used to write straight into `rows`/`rowsRef`, so a kind flipped but never
  // paired with a rate/amount edit survived switching to another row and back, showing e.g.
  // PERCENT with an empty Rate while the server still held FLAT + amount — and any later
  // unrelated save then composed `kind: PERCENT, rate: null` and failed with an error naming a
  // field the user never touched. Tracked as a draft instead, exactly like `textDrafts`, and
  // cleared alongside it below.
  const [kindDraft, setKindDraft] = useState<Record<string, SurchargeKindValue>>({});
  function kindValue(row: Surcharge): SurchargeKindValue {
    return Object.hasOwn(kindDraft, row.id) ? kindDraft[row.id] : row.kind;
  }
  const { permissions: perms, error: permsError } = usePermissions();

  // Gated per the permission each route actually enforces (step-codes/page.tsx precedent, review
  // Fix 2 — an owner ruling: split like every other admin CRUD list rather than the single
  // admin.edit gate this page originally shipped with). Create hits POST requiring admin.create;
  // every scalar edit, the active toggle, and the step-code list hits PUT requiring admin.edit;
  // delete hits DELETE requiring admin.delete. Disabled with a tooltip, never hidden (§5.16).
  const canCreate = gate(perms, "admin.create");
  const canEdit = gate(perms, "admin.edit");
  const canDelete = gate(perms, "admin.delete");
  // Gates the "Clear override" escape hatch below (task-8 brief's opening blockquote, concern 2)
  // on the exact same permissions the DELETE route enforces
  // (src/app/api/customers/[id]/surcharges/route.ts) — customers.edit AND change_prices, the
  // PricingSection.tsx "whichever is actually the blocker" title rule.
  const canEditC = gate(perms, "customers.edit");
  const canChangePricesC = gateDo(perms, "change_prices");
  const clearOverrideDisabled = canEditC.disabled || canChangePricesC.disabled;
  const clearOverrideTitle = canEditC.disabled ? canEditC.title : canChangePricesC.title;

  // Mirrors `rows` for save-time reads: a save must compose its payload from the FRESHEST known
  // row, not a value captured when the input was first focused (the step-codes/page.tsx
  // `codesRef` precedent).
  const rowsRef = useRef<Surcharge[]>([]);
  const latest = useLatest();
  // The rowsRef landing is applied-monotonic on the load ticket (makeMutationGate semantics, the
  // step-codes/page.tsx codesRefGate shape): the ref exists to hand a QUEUED run the freshest
  // server truth, not to gate what the user sees, so a superseded load must still be allowed to
  // land it (the Task 7 intent, preserved — an early-arriving superseded response still lands) —
  // but the old unconditional write was ARRIVAL-ordered while tickets are dispatch-ordered, so an
  // older fetch resolving after a newer one rewound the ref to a PRE-mutation row set, and the
  // next queued save composed its whole-row PUT from that reverted row. A late arrival that would
  // regress a newer applied one is now dropped.
  const rowsRefGate = useMutationGate();
  const load = useCallback(async () => {
    const ticket = latest.next();
    try {
      const [r, g, sc] = await Promise.all([
        api<Surcharge[]>("/api/admin/surcharges?includeInactive=1"),
        api<Gl[]>("/api/admin/reference/glAccount"),
        api<StepCodeOption[]>("/api/picklists/processStepCode"),
      ]);
      if (rowsRefGate.accept(ticket)) rowsRef.current = r;
      if (!latest.isCurrent(ticket)) return; // a slower, now-superseded load lost the state race
      setRows(r); setGls(g); setStepCodeOptions(sc);
    } catch (e) {
      // F7 (customers/page.tsx): a superseded load's rejection must not surface an error over
      // state a newer load has already refreshed.
      if (!latest.isCurrent(ticket)) return;
      throw e;
    }
  }, [latest, rowsRefGate]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  // A stale blocker panel — and any in-progress typing/kind draft — from a previously selected
  // row must not linger once selection moves on.
  useEffect(() => { setBlocked(null); setTextDrafts({}); setKindDraft({}); }, [selected]);

  const current = rows.find((r) => r.id === selected) ?? null;

  // A fresh key per request: the same row clicked again after going back to the list opens Selected
  // surcharge again (the step-code page's shape).
  const [openTab, setOpenTab] = useState<{ id: string; key: string } | null>(null);
  const openRequests = useRef(0);
  function openPanel(id: string) {
    openRequests.current += 1;
    setOpenTab({ id, key: String(openRequests.current) });
  }
  function openRow(id: string) {
    setSelected(id);
    openPanel("selected-surcharge");
  }
  const nameRef = useRef<HTMLInputElement>(null);
  function focusNewSurcharge() {
    openPanel("new-surcharge");
    focusWhenShown(() => nameRef.current);
  }

  // One at a time (step-codes/page.tsx precedent, Codex MR !22 — the same class of bug, fix wave
  // 1 Fix 1). Every write here PUTs the surcharge's ENTIRE row, so two overlapping saves are
  // last-writer-wins over the whole thing — and they overlap on the most ordinary interaction
  // there is: typing a value, then clicking a control. mousedown blurs the input, which starts
  // save #1; the click starts save #2 before #1 has returned. Serializing the requests is only
  // half of it: `save`/`toggleStepCode` below look their row up from `rowsRef.current` INSIDE the
  // queued run, not at call time, so save #2 composes against the row as it stands on ITS OWN
  // turn — after `rowsRef.current` has been updated by save #1's `load()` fetch (or a newer one
  // still: the ref lands applied-monotonic on the load ticket, `rowsRefGate` above, so a queued
  // run is never left composing from a pre-save ref and an out-of-order straggler can no longer
  // rewind it — Task 7 re-review, tightened by Task 8) —
  // instead of the stale snapshot that existed when the click first fired. Shared by both
  // functions because they must serialize against EACH OTHER too: a rate edit and a step-code
  // toggle fired in quick succession are exactly as ordinary an overlap as two field saves.
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  /** The one save path every field on the detail pane goes through. `patch` carries only what
   *  changed; `buildBody` composes it — at the queued run's own turn, not at call time — with the
   *  freshest server row into the whole thing the route expects. On failure, rolls back to server
   *  truth FIRST (reload), then reports why (§5.13) — a failed save must not leave a stale,
   *  unsaved value in the grid looking as if it took effect. `blocked` is cleared unconditionally
   *  (Fix 7, review): a stale delete-blocker panel from an earlier refused delete has nothing to
   *  do with a field save's own outcome, success or failure, so the previous code's
   *  success-only clear left it lingering through an unrelated failed save. */
  function save(id: string, patch: Partial<SaveFields>): Promise<boolean> {
    // Answers whether the write landed.
    const run = async (): Promise<boolean> => {
      const row = rowsRef.current.find((r) => r.id === id);
      if (!row) return false;
      const body = buildBody(row, patch);
      setBlocked(null);
      try {
        await api(`/api/admin/surcharges/${id}`, { method: "PUT", body: JSON.stringify(body) });
        // #158 — success path, before the follow-up load (#124/!131). Every scalar edit on this
        // page comes through here and writes a `surcharge` row: the panel's own entity.
        invalidateHistory();
        setError(null); await load();
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

  /** Local-only — no network call. Switching `kind` alone can never be a valid save on its own
   *  (a PERCENT row with no rate yet, or a FLAT row with no amount yet, both fail `SAVE`'s
   *  superRefine), so this only flips which control the pane shows; the actual PUT happens when
   *  the user then edits the newly-visible rate/amount field, at which point that field's `save`
   *  call passes `kind: kindValue(current)` explicitly (the row in `rowsRef` is never mutated by
   *  this — see `kindDraft` above) so `buildBody` nulls the opposite field correctly. */
  function setKindLocal(id: string, kind: SurchargeKindValue) {
    setKindDraft((d) => ({ ...d, [id]: kind }));
  }

  /** Same queue as `save` — see its comment above. `next` is derived from `rowsRef.current`
   *  inside the queued run, not at call time: the checkbox below isn't optimistic
   *  (`checked={current.stepCodeIds.includes(sc.id)}`), so a fast second click lands before the
   *  first's round trip completes, and computing `next` from the stale `row.stepCodeIds`
   *  captured when the click fired would overwrite the first click's effect entirely instead of
   *  adding to it (Fix 1(b), review — the brief's own Step 4 scenario). */
  function toggleStepCode(id: string, stepCodeId: string): Promise<void> {
    const run = async () => {
      const row = rowsRef.current.find((r) => r.id === id);
      if (!row) return;
      const has = row.stepCodeIds.includes(stepCodeId);
      const next = has ? row.stepCodeIds.filter((s) => s !== stepCodeId) : [...row.stepCodeIds, stepCodeId];
      try {
        await api(`/api/admin/surcharges/${id}/step-codes`, { method: "PUT", body: JSON.stringify({ stepCodeIds: next }) });
        // #158 — success path, before the follow-up load. The step-code grid is a replace-grid
        // audited through the surcharge itself (SNAPSHOT_INCLUDE.surcharge), so a toggle here
        // moves the very history the panel below renders.
        invalidateHistory();
        setError(null); await load();
      } catch (e) {
        await load().catch(() => {});
        setError((e as Error).message);
      }
    };
    saveQueue.current = saveQueue.current.then(run, run);
    return saveQueue.current;
  }

  // Enter commits a box as leaving it does, the cursor kept in it (owner ruling R7); each box's text
  // at focus, and the text an accepted Enter sent, live in src/lib/focus-record.ts (the onFocus/
  // onBlur split below is the step-codes/page.tsx and billing/page.tsx precedent: typing doesn't hit
  // the network on every keystroke, and tabbing through an untouched field writes no no-op save).
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
  // A box's save, answering the text the box shows once it lands, or false when it did not.
  function saveBox(key: string, saved: Promise<boolean>, shown: string, decimal = false): Promise<string | false> {
    return saved.then((ok) => {
      if (ok) savedMarks.mark(key, shown, { decimal });
      return ok ? shown : false;
    });
  }
  function commitName(id: string, value: string): false | Promise<string | false> {
    const key = `${id}.name`;
    const name = value.trim();
    if (!name) { void load().catch(() => {}); setError("Name is required"); putBack(key); return false; }
    return saveBox(key, save(id, { name }), name);
  }
  // Reformatting/parsing happens only on leaving the box (Fix 4, review): `Number("")` is `0`, so a
  // parse on every keystroke saved `position: 0` from a backspaced box.
  function commitPosition(id: string, value: string): false | Promise<string | false> {
    const key = `${id}.position`;
    const trimmed = value.trim();
    const n = Number(trimmed);
    if (trimmed === "" || !Number.isFinite(n)) {
      void load().catch(() => {});
      setError("Position must be a number");
      putBack(key);
      return false;
    }
    return saveBox(key, save(id, { position: n }), String(n));
  }

  /** The Rate, Amount and Minimum amount boxes' blur commit (#517): the figure is read by the box's
   *  own rule (`rate-boxes.ts`) BEFORE a request. A refusal is named, drops that box's text draft (so
   *  it shows the stored figure again) and, for Rate and Amount, the kind draft, exactly as a settled
   *  save does, and sends nothing. */
  function commitSurchargeBox(id: string, field: "rate" | "amount" | "minimumAmount", value: string): false | Promise<string | false> {
    const key = `${id}.${field}`;
    const box = field === "rate" ? SURCHARGE_RATE : field === "amount" ? SURCHARGE_AMOUNT : SURCHARGE_MINIMUM_AMOUNT;
    const clearDrafts = () => {
      putBack(key);
      if (field !== "minimumAmount") setKindDraft((d) => { const n = { ...d }; delete n[id]; return n; });
    };
    const refused = decimalRefusal(box.label, value, box.box);
    if (refused) { clearDrafts(); setError(refused); return false; }
    const row = rows.find((r) => r.id === id);
    if (!row) return false;
    // `kind` is sent explicitly for Rate and Amount — the row in `rowsRef` still carries the server's
    // real kind (setKindLocal no longer mutates it, Fix 3), so buildBody needs telling which kind
    // this save is for in order to null the other figure correctly on a pending flip. Amount is sent
    // as the raw string, not `Number(value)`: the server's decimalField takes a decimal string, and
    // parsing here would reintroduce the reformat-while-typing problem the draft exists to avoid.
    const patch: Partial<SaveFields> =
      field === "rate" ? { kind: kindValue(row), rate: percentToDecimal(value) }
      : field === "amount" ? { kind: kindValue(row), amount: value.trim() === "" ? null : value }
      : { minimumAmount: value.trim() === "" ? null : value };
    return saveBox(key, save(id, patch), value, true).finally(() => {
      if (field !== "minimumAmount") setKindDraft((d) => { const n = { ...d }; delete n[id]; return n; });
    });
  }

  async function add() {
    // The draft's figure is read by its kind's box before a request (#517); a blank is left to the
    // server's own refusal. A refusal keeps what was typed.
    const box = draft.kind === "PERCENT" ? SURCHARGE_RATE : SURCHARGE_AMOUNT;
    const refused = decimalRefusal(box.label, draft.valueText, box.box);
    if (refused) { setError(refused); return; }
    await addHold.run(async () => {
      const position = rows.reduce((max, r) => Math.max(max, r.position), 0) + 1;
      const body: SaveFields = {
        name: draft.name, kind: draft.kind,
        rate: draft.kind === "PERCENT" ? percentToDecimal(draft.valueText) : null,
        amount: draft.kind === "FLAT" ? (draft.valueText.trim() === "" ? null : draft.valueText) : null,
        minimumAmount: null, glAccountId: null, scope: "ALL", position, active: true,
      };
      try {
        await api("/api/admin/surcharges", { method: "POST", body: JSON.stringify(body) });
        setDraft({ name: "", kind: "PERCENT", valueText: "" }); setError(null); await load();
      } catch (e) { setError((e as Error).message); }
    });
  }

  async function removeRow(row: Surcharge) {
    if (!await askConfirm({ title: `Delete surcharge "${row.name}"?`, body: "", confirm: "Delete", danger: true })) return;
    try {
      await api(`/api/admin/surcharges/${row.id}`, { method: "DELETE" });
      setSelected(null); setError(null); setBlocked(null); await load();
    } catch (e) {
      // A refusal is not a dead end (step-codes/page.tsx precedent): say what's blocking, and
      // make the list exportable. Only the delete guard's own 400 means a blocker list exists to
      // fetch — a 500 or network failure is a genuine error, not a refusal.
      if (e instanceof ApiError && e.status === 400) {
        try {
          const list = await api<Blocker[]>(`/api/admin/surcharges/${row.id}/blockers`);
          if (list.length) { setBlocked({ row, list }); setError(null); return; }
        } catch (listErr) {
          setError(`${(e as Error).message} — the list of what's using it could not be loaded ` +
            `(${(listErr as Error).message}). Try again.`);
          return;
        }
      }
      setError((e as Error).message);
    }
  }

  /** The escape hatch for a stale override belonging to a SOFT-DELETED customer (task-8 brief's
   *  opening blockquote, concern 2): `customerSurcharge -> surcharge`'s blocker entry links to
   *  `/customers/{id}`, but a deleted customer's detail page 404s (getCustomer filters
   *  `deletedAt: null`) — soft-deleted customers are invisible to every list and every detail
   *  page in this app by design, so that page is never reachable again once the customer is
   *  gone. Clearing the override right here, where the block is actually discovered (an admin
   *  trying to delete THIS surcharge), closes the loop without requiring the customer itself to
   *  be reachable. Reuses `deleteCustomerSurcharge` through the customer-facing DELETE route —
   *  the same one the customer page's own "Clear override" control uses — since the service
   *  itself checks only the override row's own liveness, never the customer's (surcharges.ts).
   *
   *  Fix 4, fix wave 1 review: was a one-click destructive write with no confirmation — an
   *  asymmetry against the surcharge delete that surfaces this very panel, which IS
   *  confirm-guarded (`removeRow` above). Asked through the modal, worded plainly since
   *  the change is audited and therefore recoverable (re-entering the override on the customer
   *  recreates it), including for a live (non-deleted) customer reached from this admin panel. */
  // Orders overlapping clears' blocker refetches (the use-latest.ts ticket idiom): the ticket is
  // taken BEFORE the DELETE — the DELETE itself changes what the correct panel is, so a second
  // clear must supersede the first's still-in-flight refetch from that moment, not from when its
  // own refetch dispatches.
  const blockerRefetchGate = useLatest();
  async function clearCustomerOverride(
    customerId: string, surchargeId: string, customerName: string,
    surchargeName: string, kind: SurchargeKindValue,
  ) {
    // P3a (#239): "the plant rate" is the wrong noun for a FLAT surcharge — the demonstration
    // dataset's own Expedite Fee is $75.00 and has no rate at all. `plantDefaultNoun` is the same
    // branch the override inputs' placeholders already made.
    if (!await askConfirm({
      title: `Clear "${customerName}"'s override for "${surchargeName}"?`,
      body: `They will bill at the ${plantDefaultNoun(kind)} instead.`,
      confirm: "Clear override", danger: true,
    })) return;
    const ticket = blockerRefetchGate.next();
    try {
      await api(`/api/customers/${customerId}/surcharges`, {
        method: "DELETE", body: JSON.stringify({ surchargeId }),
      });
      // #158 — success path, the instant the DELETE resolves and before the blocker refetch.
      // `customerSurcharge` is a REGISTERED CHILD of `surcharge` (audit-children.ts), so the
      // panel below already advertises customer-override history — and went stale on exactly the
      // overrides this control clears. The entity-keyed manifest could not see it: it names only
      // the customer page's own section, and requires just one file per entity.
      invalidateHistory();
      setError(null);
    } catch (e) {
      // The DELETE's own failure is a mutation report, not a stale fetch — surfaced regardless.
      setError((e as Error).message);
      return;
    }
    try {
      const list = await api<Blocker[]>(`/api/admin/surcharges/${surchargeId}/blockers`);
      if (!blockerRefetchGate.isCurrent(ticket)) return; // a newer clear owns the panel now
      if (list.length) { setBlocked((b) => (b ? { ...b, list } : b)); } else { setBlocked(null); }
    } catch (e) {
      // F7: a superseded refetch's rejection must not clobber the newer clear's outcome.
      if (!blockerRefetchGate.isCurrent(ticket)) return;
      setError((e as Error).message);
    }
  }

  // The two panels with nothing to show until a surcharge is picked read the same sentence.
  const pickASurcharge = (
    <div className={CARD}>
      <p className="text-sm text-ink-500">Select a surcharge to view its settings.</p>
    </div>
  );

  return (
    <div className="min-w-0 p-3 sm:p-6">
      <PageHeader title="Surcharges"
        actions={
          <button type="button" onClick={focusNewSurcharge} disabled={canCreate.disabled} title={canCreate.title}
                  className={BUTTON_PRIMARY}>
            Add surcharge
          </button>
        } />
      {(error ?? permsError) && (
        <p className={`${NOTICE.refusal} mb-3`}>{error ?? permsError}</p>
      )}
      <RecordTabs label={SURCHARGE_TAB_LABEL} tabs={surchargeTabs()} open={openTab} panels={{
        list: (
          <>
            <div id="surcharge-list" className={`${CARD_FLUSH} mb-3 overflow-x-auto`}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className={`${TABLE_HEAD} p-2`}>Name</th><th className={`${TABLE_HEAD} p-2`}>Kind</th>
                    <th className={`${TABLE_HEAD} p-2`}>Value</th><th className={`${TABLE_HEAD} p-2`}>GL account</th>
                    <th className={`${TABLE_HEAD} p-2`}>Active</th>
                  </tr>
                </thead>
                <tbody>
                  {[...rows].sort((a, b) => a.position - b.position).map((r) => (
                    /* The row's one control is the Name cell's button, stretched over the row by
                       its ::after, so a click anywhere on the row is one click on one handler (the
                       step-code table's shape). S2a (#239): hover feedback, suppressed on the
                       selected row. */
                    <tr key={r.id} className={`relative border-t ${selected === r.id ? "bg-link-50" : "hover:bg-surface-50"}`}>
                      <td className={TABLE_CELL}>
                        <button type="button" onClick={() => openRow(r.id)}
                                aria-current={selected === r.id ? "true" : undefined}
                                className={`${LINK} cursor-pointer after:absolute after:inset-0`}>
                          {r.name}
                        </button>
                      </td>
                      <td className={TABLE_CELL}>{SURCHARGE_KIND_LABELS[r.kind]}</td>
                      <td className={TABLE_CELL}>{surchargeRateText(r)}</td>
                      <td className={TABLE_CELL}>
                        {r.needsGlAccount ? <span className={BADGE_WARNING}>needs GL</span> : glAccountText(r.glAccountId, gls)}
                      </td>
                      <td className={TABLE_CELL}>{yesNo(r.active)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div id="new-surcharge" className={CARD}>
          <div className="flex flex-col gap-1">
            <input ref={nameRef} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                   disabled={canCreate.disabled} title={canCreate.title}
                   placeholder="Name" className={`${INPUT_COMPACT} disabled:bg-surface-50`} />
            <div className="flex gap-1">
              <select value={draft.kind}
                      onChange={(e) => setDraft({ ...draft, kind: e.target.value as SurchargeKindValue, valueText: "" })}
                      disabled={canCreate.disabled} title={canCreate.title}
                      className={`${INPUT_COMPACT} disabled:bg-surface-50`}>
                {SURCHARGE_KINDS.map((k) => <option key={k} value={k}>{SURCHARGE_KIND_LABELS[k]}</option>)}
              </select>
              <input value={draft.valueText} onChange={(e) => setDraft({ ...draft, valueText: e.target.value })}
                     disabled={canCreate.disabled} title={canCreate.title} inputMode="decimal"
                     placeholder={draft.kind === "PERCENT" ? "% rate" : "$ amount"}
                     className={`${INPUT_COMPACT} w-24 disabled:bg-surface-50`} />
              <button onClick={add} disabled={canCreate.disabled || adding} title={canCreate.title}
                      className={BUTTON_PRIMARY_COMPACT}>
                Add
              </button>
            </div>
          </div>
            </div>
          </>
        ),
        selected: current ? (
          <div id="selected-surcharge">
            <section className={`${CARD} mb-3`}>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-medium">{current.name}</h2>
                <DangerButton onClick={() => void removeRow(current)} disabled={canDelete.disabled} title={canDelete.title}>
                  Delete surcharge
                </DangerButton>
              </div>
              <h3 className="mb-2 text-sm font-medium">Value &amp; accounting</h3>
              <label className="mb-2 block text-sm">
                Name
                {/* Routed through textDrafts exactly like rate/amount/minimumAmount/position — Name
                    was the ONE text field still edited optimistically into rows/rowsRef, so
                    mid-typing text sat in the ref and leaked into OTHER saves' whole-row PUT bodies
                    (buildSurchargeBody falls back to row.name). */}
                <input value={draftValue(`${current.id}.name`, current.name)}
                       disabled={canEdit.disabled} title={canEdit.title}
                       aria-label="Name"
                       onFocus={(e) => noteFocus(focus.current, `${current.id}.name`, e.target.value)}
                       onChange={(e) => setTextDrafts((d) => ({ ...d, [`${current.id}.name`]: e.target.value }))}
                       onBlur={(e) => leaveSave(`${current.id}.name`, e.target.value, (value) => commitName(current.id, value), trimmedText)}
                       onKeyDown={(e) => enterSave(e, `${current.id}.name`, (value) => commitName(current.id, value), trimmedText)}
                       className={`${INPUT_COMPACT} ml-2 w-full disabled:bg-surface-50`} />
                <SavedMark label="Name" show={savedMarks.shows(`${current.id}.name`, draftValue(`${current.id}.name`, current.name))} />
              </label>

              <div className="mb-2 flex gap-4">
                <label className="flex-1 text-sm">
                  Kind
                  <select value={kindValue(current)} disabled={canEdit.disabled} title={canEdit.title}
                          onChange={(e) => setKindLocal(current.id, e.target.value as SurchargeKindValue)}
                          className={`${INPUT_COMPACT} ml-2 w-full disabled:bg-surface-50`}>
                    {SURCHARGE_KINDS.map((k) => <option key={k} value={k}>{SURCHARGE_KIND_LABELS[k]}</option>)}
                  </select>
                </label>

                {kindValue(current) === "PERCENT" ? (
                  <label className="flex-1 text-sm">
                    Rate (%)
                    <input value={draftValue(`${current.id}.rate`, decimalToPercentText(current.rate))}
                           disabled={canEdit.disabled} title={canEdit.title} inputMode="decimal"
                           aria-label={SURCHARGE_RATE.label}
                           onFocus={(e) => noteFocus(focus.current, `${current.id}.rate`, e.target.value)}
                           onChange={(e) => setTextDrafts((d) => ({ ...d, [`${current.id}.rate`]: e.target.value }))}
                           onBlur={(e) => leaveSave(`${current.id}.rate`, e.target.value, (value) => commitSurchargeBox(current.id, "rate", value), sameSentValue)}
                           onKeyDown={(e) => enterSave(e, `${current.id}.rate`, (value) => commitSurchargeBox(current.id, "rate", value), sameSentValue)}
                           className={`${INPUT_COMPACT} ml-2 w-full text-right disabled:bg-surface-50`} />
                    <SavedMark label={SURCHARGE_RATE.label} show={savedMarks.shows(`${current.id}.rate`, draftValue(`${current.id}.rate`, decimalToPercentText(current.rate)))} />
                  </label>
                ) : (
                  <label className="flex-1 text-sm">
                    Amount ($)
                    <input value={draftValue(`${current.id}.amount`, moneyText(current.amount))}
                           disabled={canEdit.disabled} title={canEdit.title} inputMode="decimal"
                           aria-label={SURCHARGE_AMOUNT.label}
                           onFocus={(e) => noteFocus(focus.current, `${current.id}.amount`, e.target.value)}
                           onChange={(e) => setTextDrafts((d) => ({ ...d, [`${current.id}.amount`]: e.target.value }))}
                           onBlur={(e) => leaveSave(`${current.id}.amount`, e.target.value, (value) => commitSurchargeBox(current.id, "amount", value), sameSentValue)}
                           onKeyDown={(e) => enterSave(e, `${current.id}.amount`, (value) => commitSurchargeBox(current.id, "amount", value), sameSentValue)}
                           className={`${INPUT_COMPACT} ml-2 w-full text-right disabled:bg-surface-50`} />
                    <SavedMark label={SURCHARGE_AMOUNT.label} show={savedMarks.shows(`${current.id}.amount`, draftValue(`${current.id}.amount`, moneyText(current.amount)))} />
                  </label>
                )}
              </div>

              <div className="mb-2 flex gap-4">
                <label className="flex-1 text-sm">
                  Minimum amount ($)
                  <input value={draftValue(`${current.id}.minimumAmount`, moneyText(current.minimumAmount))}
                         disabled={canEdit.disabled} title={canEdit.title} inputMode="decimal"
                         aria-label={SURCHARGE_MINIMUM_AMOUNT.label}
                         onFocus={(e) => noteFocus(focus.current, `${current.id}.minimumAmount`, e.target.value)}
                         onChange={(e) => setTextDrafts((d) => ({ ...d, [`${current.id}.minimumAmount`]: e.target.value }))}
                         onBlur={(e) => leaveSave(`${current.id}.minimumAmount`, e.target.value, (value) => commitSurchargeBox(current.id, "minimumAmount", value), sameSentValue)}
                         onKeyDown={(e) => enterSave(e, `${current.id}.minimumAmount`, (value) => commitSurchargeBox(current.id, "minimumAmount", value), sameSentValue)}
                         className={`${INPUT_COMPACT} ml-2 w-full text-right disabled:bg-surface-50`} />
                  <SavedMark label={SURCHARGE_MINIMUM_AMOUNT.label} show={savedMarks.shows(`${current.id}.minimumAmount`, draftValue(`${current.id}.minimumAmount`, moneyText(current.minimumAmount)))} />
                </label>

                <label className="flex-1 text-sm">
                  Position
                  {/* Routed through textDrafts like rate/amount/minimumAmount (Fix 4, review):
                      `onChange` used to run `Number(e.target.value)` immediately, and
                      `Number("")` is `0`, so backspacing to empty instantly re-rendered as "0" —
                      blurring from there saved `position: 0`, silently jumping the row to the top
                      of the list. Reformatting/parsing now happens only when the box is left or
                      Enter is pressed. */}
                  <input value={draftValue(`${current.id}.position`, String(current.position))}
                         disabled={canEdit.disabled} title={canEdit.title}
                         inputMode="numeric"
                         aria-label="Position"
                         onFocus={(e) => noteFocus(focus.current, `${current.id}.position`, e.target.value)}
                         onChange={(e) => setTextDrafts((d) => ({ ...d, [`${current.id}.position`]: e.target.value }))}
                         onBlur={(e) => leaveSave(`${current.id}.position`, e.target.value, (value) => commitPosition(current.id, value))}
                         onKeyDown={(e) => enterSave(e, `${current.id}.position`, (value) => commitPosition(current.id, value))}
                         className={`${INPUT_COMPACT} ml-2 w-full text-right disabled:bg-surface-50`} />
                  <SavedMark label="Position" show={savedMarks.shows(`${current.id}.position`, draftValue(`${current.id}.position`, String(current.position)))} />
                </label>
              </div>

              <label className="mb-4 block text-sm">
                GL account
                <select value={current.glAccountId ?? ""} disabled={canEdit.disabled} title={canEdit.title}
                        className={`${INPUT_COMPACT} ml-2 w-full disabled:bg-surface-50`}
                        onChange={(e) => void save(current.id, { glAccountId: e.target.value || null })}>
                  <option value="">(needs GL account)</option>
                  {gls.map((g) => <option key={g.id} value={g.id}>{g.name} {g.description}</option>)}
                </select>
              </label>

              <label className="mb-2 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={current.active} disabled={canEdit.disabled} title={canEdit.title}
                       onChange={(e) => void save(current.id, { active: e.target.checked })} />
                Active
              </label>

            </section>
            <section className={`${CARD} mb-3`}>
              <h3 className="mb-2 text-sm font-medium">Operation scope</h3>
              <label className="mb-2 block text-sm">
                Scope
                <select value={current.scope} disabled={canEdit.disabled} title={canEdit.title}
                        className={`${INPUT_COMPACT} ml-2 w-full disabled:bg-surface-50`}
                        onChange={(e) => void save(current.id, { scope: e.target.value as SurchargeScopeValue })}>
                  {SURCHARGE_SCOPES.map((s) => <option key={s} value={s}>{SURCHARGE_SCOPE_LABELS[s]}</option>)}
                </select>
              </label>

              {current.scope !== "ALL" && (
                <div className="mb-4">
                  <h3 className="mb-1 text-sm font-medium">
                    {current.scope === "INCLUDE"
                      ? "Applies only to these operations"
                      : "Applies to all operations except these"}
                  </h3>
                  <div className="max-h-48 overflow-y-auto rounded border p-2 text-sm">
                    {stepCodeOptions.length === 0 && <p className="text-ink-500">No process step codes yet.</p>}
                    {stepCodeOptions.map((sc) => (
                      <label key={sc.id} className="flex items-center gap-2 py-0.5">
                        <input type="checkbox" checked={current.stepCodeIds.includes(sc.id)}
                               disabled={canEdit.disabled} title={canEdit.title}
                               onChange={() => void toggleStepCode(current.id, sc.id)} />
                        {sc.name}
                      </label>
                    ))}
                  </div>
                </div>
              )}

            </section>
            {blocked && blocked.row.id === current.id && (() => {
              // Fix 1, fix wave 2 review: `entityLabel === "Customer"` alone was correct only
              // because no OTHER surcharge-targeting link happens to use that entityLabel today —
              // a future one would silently pick up this "Clear override" button and 404 when
              // clicked (it POSTs to /api/customers/{id}/surcharges, which only exists for an
              // actual customer). Fix wave 1 tried pairing it with `label === "Surcharge"` — the
              // customerSurcharge -> surcharge registry entry's own column-header label — but
              // that conjunct adds nothing: every link `findBlockers("surcharge", …)` can ever
              // return has an FK column named `surchargeId`, so its column-header `label` reads
              // "Surcharge" on 100% of rows this panel can ever hold. `model` — the registry
              // entry's own Prisma model identity (src/lib/reference-links.ts's
              // `ReferenceLinkModel` union) — is genuine identity rather than a rendered string,
              // so `model === "customerSurcharge"` alone is true only for the one link this
              // escape hatch was built for, and stays true even if a future link shares this
              // one's entityLabel or label.
              const customerBlockers = blocked.list.filter((b) => b.model === "customerSurcharge");
              return (
                <>
                  <BlockerPanel
                    label="surcharge"
                    rowName={blocked.row.name}
                    list={blocked.list}
                    exportHref={`/api/admin/surcharges/${blocked.row.id}/blockers/export`}
                    onDismiss={() => setBlocked(null)}
                  />
                  {/* Task-8 brief, concern 2: a Customer blocker here is a live CustomerSurcharge
                      override — including one belonging to a soft-deleted customer, whose own
                      detail page (the panel's link above) 404s and can never be visited again.
                      This clears it directly, right where the block is discovered, regardless of
                      whether that customer is still reachable. */}
                  {customerBlockers.length > 0 && (
                    <div className="mt-2 rounded border border-line bg-surface-50 p-2 text-sm">
                      <p className="mb-1 text-ink-500">
                        Clear a customer&apos;s override directly (works even if that customer has since been deleted):
                      </p>
                      <ul className="space-y-1">
                        {customerBlockers.map((b) => (
                          <li key={b.id} className="flex items-center justify-between gap-2">
                            <span>{b.name}</span>
                            <button onClick={() => void clearCustomerOverride(b.id, blocked.row.id, b.name, blocked.row.name, blocked.row.kind)}
                                    disabled={clearOverrideDisabled} title={clearOverrideTitle}
                                    className="text-xs text-red-600">
                              Clear override
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              );
            })()}

          </div>
        ) : <div id="selected-surcharge">{pickASurcharge}</div>,
        history: (
          <div id="surcharge-history">
            {current
              ? <HistoryPanel entity="surcharge" entityId={current.id} perms={perms} permsError={permsError} />
              : pickASurcharge}
          </div>
        ),
      }} />
    </div>
  );
}
