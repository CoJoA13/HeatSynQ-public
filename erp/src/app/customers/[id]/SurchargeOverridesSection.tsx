"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { PanelMessage } from "@/components/PanelMessage";
import { api } from "@/lib/fetcher";
import { invalidateHistory } from "@/components/HistoryPanel";
import { gate, gateDo } from "@/lib/permission-ui";
import { useLatest } from "@/lib/use-latest";
import { shownValue, withPick, withoutSettledPick, type PendingPicks } from "@/lib/pending-pick";
import { decimalRefusal } from "@/lib/decimal-entry";
import { askConfirm } from "@/lib/modal";
import { SURCHARGE_AMOUNT_OVERRIDE, SURCHARGE_RATE_OVERRIDE } from "@/lib/rate-boxes";
import { percentToDecimal, decimalToPercentText } from "@/lib/surcharge-percent";
import { plantDefaultNoun } from "@/lib/surcharge-display";
import type { SurchargeKindValue } from "@/lib/invoice-constants";
import { SavedMark } from "@/components/SavedMark";
import { useSavedMarks } from "@/lib/use-saved-marks";
import { sameSentValue } from "@/lib/line-field-saves";
import { enterBox, focusRecord, heldText, leaveBox, noteFocus, withoutSettledDraft, type BoxCommit } from "@/lib/focus-record";
import {
  buildCustomerSurchargeBody as buildBody,
  type CustomerSurchargeOptionRow as SurchargeRow,
  type CustomerSurchargeSaveFields as SaveFields,
} from "@/lib/customer-surcharge-body";
import { CARD, INPUT_COMPACT } from "@/lib/ui-classes";

/** Formats a Decimal(12,2) money value the way the field itself is scaled — the admin
 *  surcharges page `moneyText` precedent (src/app/admin/surcharges/page.tsx). */
function moneyText(value: number | null): string {
  return value === null ? "" : value.toFixed(2);
}

export function SurchargeOverridesSection({
  customerId, perms, onOptionsError,
}: {
  customerId: string;
  perms: string[] | undefined;
  /** Fix wave 1, Fix 1 (review): the mount fetch's own failure channel, mirroring
   *  parts/[id]/PricingSection.tsx's `onOptionsError` prop. When `onError` was the page's shared
   *  banner (before P6 step 5c), the page's own `load()`, running concurrently on mount, cleared it
   *  on its own unrelated success, so a load failure could vanish before the user saw it, leaving
   *  `rows` at its initial `[]` with nothing on screen to say the list never loaded (HANDOFF §5.15:
   *  a failed request must say so rather than impersonate an empty list). `onOptionsError` is the
   *  page's `optionsError` state, a channel that no unrelated refresh clears (page.tsx's F4
   *  comment). Every write this section makes (save/clearOverride) reports through `onError`, now
   *  the section's own message, matching PricingSection's own saveRow/removeRow. */
  onOptionsError: (message: string) => void;
}) {
  // This section's own message (owner ruling R1, P6 step 5c): its reads, saves and row actions
  // report here, through the shared PanelMessage, where they used to write the page banner. The
  // setter keeps the name `onError` that the handlers and the tests that lift them read.
  const [sectionMessage, onError] = useState<string | null>(null);
  const canEdit = gate(perms, "customers.edit");
  const priceGate = gateDo(perms, "change_prices");
  // Both gates, same as the parts Pricing section (task-8 brief): every control here needs
  // customers.edit (can this user touch the customer at all) AND change_prices (can they touch
  // pricing specifically — a per-customer surcharge override is a price change, the route's own
  // mustCan+mustDo). The title favors whichever is actually the blocker (PricingSection.tsx's own
  // comment): a user who holds change_prices but not customers.edit sees the edit gate's reason,
  // not "Requires change_prices" for a control they were never going to be allowed to touch
  // regardless.
  const disabled = canEdit.disabled || priceGate.disabled;
  const title = canEdit.disabled ? canEdit.title : priceGate.title;

  const [rows, setRows] = useState<SurchargeRow[]>([]);
  // Set only once `load()` has actually landed a real list — the PricingSection `rowsReady`
  // precedent (its comment at :53-58). `rows` starts `[]` the same as "loaded, genuinely empty",
  // so without this flag the empty-state text below could not tell a customer with zero active
  // surcharges apart from a mount fetch that is still in flight OR has already failed — and a
  // failed load is the steady state on an error, not a momentary race (Fix 1, fix wave 1 review).
  const [rowsReady, setRowsReady] = useState(false);

  // rowsRef mirrors `rows` for save-time reads (surcharges/page.tsx's `rowsRef` precedent): a
  // queued save must compose its payload from the FRESHEST known row, not whatever was on screen
  // when the field was first focused. Written unconditionally on every completed fetch, never
  // gated by the `useLatest` ticket that guards only the rendered state below — a save queued
  // between a superseded load and the load that supersedes it must still see the newer row
  // (Task 7 re-review's fix, task-8 brief's carried-in note 3).
  const rowsRef = useRef<SurchargeRow[]>([]);
  const latest = useLatest();
  const load = useCallback(async () => {
    const ticket = latest.next();
    const r = await api<SurchargeRow[]>(`/api/customers/${customerId}/surcharges`);
    rowsRef.current = r;
    if (!latest.isCurrent(ticket)) return;
    setRows(r);
    setRowsReady(true);
  }, [customerId, latest]);
  // Routed to `onOptionsError`, not `onError` — see the prop's own doc comment above (Fix 1, fix
  // wave 1 review). Prefixed with its own source (Fix 2, fix wave 2 review), matching page.tsx's
  // two established siblings ("Could not load terms: …", "Could not load parent options: …") —
  // `onOptionsError`/`addOptionsError` CONCATENATES rather than replaces, so an unprefixed message
  // here was indistinguishable from whichever of those two also happened to fail, with nothing
  // tying the blank section on screen to its share of the banner text.
  useEffect(() => {
    load().catch((e) => onOptionsError(`Could not load surcharge overrides: ${(e as Error).message}`));
  }, [load, onOptionsError]);

  // What the user has actually typed into a free-text numeric field (rate%, amount) but not yet
  // blurred, keyed by `${surchargeId}.${field}` — composed with the server value at render time,
  // not a parallel editable copy of the row (surcharges/page.tsx `textDrafts` precedent).
  const [textDrafts, setTextDrafts] = useState<Record<string, string>>({});
  function draftValue(key: string, serverValue: string): string {
    return Object.hasOwn(textDrafts, key) ? textDrafts[key] : serverValue;
  }
  // Each box's text at focus, and the text an accepted Enter sent (owner ruling R7: Enter commits a
  // box as leaving it does, the cursor kept in it), in src/lib/focus-record.ts. A decimal box is
  // compared by figure, so the stored figure's own spelling after a save sends nothing.
  const focus = useRef(focusRecord());
  const savedMarks = useSavedMarks();
  function clearDraft(key: string) {
    setTextDrafts((d) => { const n = { ...d }; delete n[key]; return n; });
  }
  // Once a save settles its box's draft goes only while it still holds the sent text: Enter keeps
  // the cursor in the box, and text typed since is the box's own.
  function dropSettledDraft(key: string, sent: string) {
    setTextDrafts((d) => withoutSettledDraft(d, key, sent));
  }
  // A refused box goes back to the stored figure (its draft dropped), or, while a save of the box is
  // out, to the text that save sent: the row may still hold the figure from before it.
  function putBack(key: string) {
    const held = heldText(focus.current, key);
    if (held === null) clearDraft(key);
    else setTextDrafts((d) => ({ ...d, [key]: held }));
  }
  function leaveSave(key: string, value: string, commit: BoxCommit) {
    const settled = (sent: string) => dropSettledDraft(key, sent);
    if (leaveBox(focus.current, key, value, commit, sameSentValue, settled) === "unchanged") clearDraft(key);
  }
  function enterSave(e: React.KeyboardEvent<HTMLInputElement>, key: string, commit: BoxCommit) {
    enterBox(e, focus.current, key, e.currentTarget.value, commit, sameSentValue, (sent) => dropSettledDraft(key, sent));
  }
  // A box's save, answering the text the box shows once it lands, or false when it did not.
  function saveBox(key: string, saved: Promise<boolean>, shown: string): Promise<string | false> {
    return saved.then((ok) => {
      if (ok) savedMarks.mark(key, shown, { decimal: true });
      return ok ? shown : false;
    });
  }

  // One at a time, shared by every write this section makes (surcharges/page.tsx `saveQueue`
  // precedent, task-8 brief's carried-in note 2): each write PUTs the surcharge override's ENTIRE
  // row, so two overlapping saves are last-writer-wins over the whole thing, and they overlap on
  // the most ordinary interaction there is — typing a value, then clicking a control (mousedown
  // blurs the input, starting save #1; the click starts save #2 before #1 returns). `save`/
  // `clearOverride` below look their row up from `rowsRef.current` INSIDE the queued run, not at
  // call time, so a later-queued run always composes against the row as it stands on ITS OWN
  // turn — after `rowsRef.current` has been updated by an earlier save's own `load()`.
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  // Each Opt out box's pick while its save and the re-read after it are out (#677, the template
  // picker's form, src/lib/pending-pick.ts): the box is bound to the row, so without it the click
  // was put back until `load()` landed. Numbered, so an earlier save's re-read never clears a later
  // pick of the same box; cleared when the pick's own save settles, landed or failed.
  const [optOutPicks, setOptOutPicks] = useState<PendingPicks<boolean>>({});
  const optOutSeq = useRef(0);
  function pickOptOut(surchargeId: string, optOut: boolean): void {
    const seq = ++optOutSeq.current;
    setOptOutPicks((p) => withPick(p, surchargeId, optOut, seq));
    void save(surchargeId, { optOut }).finally(() => setOptOutPicks((p) => withoutSettledPick(p, surchargeId, seq)));
  }

  /** The one save path every field on this section goes through. `patch` carries only what
   *  changed; `buildBody` composes it — at the queued run's own turn — with the freshest server
   *  row into the WHOLE row `setCustomerSurcharge` expects (an omitted field clears it, task-8
   *  brief's opening blockquote note 1). On failure, rolls back to server truth FIRST, then
   *  reports why (§5.13). */
  function save(surchargeId: string, patch: Partial<SaveFields>): Promise<boolean> {
    // Answers whether the write landed.
    const run = async (): Promise<boolean> => {
      const row = rowsRef.current.find((r) => r.surchargeId === surchargeId);
      if (!row) return false;
      const body = buildBody(row, patch);
      try {
        await api(`/api/customers/${customerId}/surcharges`, {
          method: "PUT", body: JSON.stringify({ surchargeId, ...body }),
        });
        // #14 item 1, extended by #153: `customerSurcharge` is a registered child of the customer
        // panel (and of the surcharge panel). Success path, before the follow-up load.
        invalidateHistory();
        onError(null); await load();
        return true;
      } catch (e) {
        await load().catch(() => {});
        onError((e as Error).message);
        return false;
      }
    };
    const landed = saveQueue.current.then(run, run);
    saveQueue.current = landed.then(() => {});
    return landed;
  }

  /** A rate or amount override box's blur commit (the box already differs from the figure it held at
   *  focus). A blank clears the override as before; anything else is read by the box's own rule
   *  (`rate-boxes.ts`) BEFORE a request. A refused figure is named with its surcharge, the box goes
   *  back to the stored figure (its draft is dropped) and nothing is sent. */
  function commitRateOverride(row: SurchargeRow, value: string): false | Promise<string | false> {
    const key = `${row.surchargeId}.rate`;
    const refused = decimalRefusal(`${row.surchargeName}, ${SURCHARGE_RATE_OVERRIDE.label}`, value, SURCHARGE_RATE_OVERRIDE.box);
    if (refused) { putBack(key); onError(refused); return false; }
    return saveBox(key, save(row.surchargeId, { rate: percentToDecimal(value) }), value);
  }
  function commitAmountOverride(row: SurchargeRow, value: string): false | Promise<string | false> {
    const key = `${row.surchargeId}.amount`;
    const refused = decimalRefusal(`${row.surchargeName}, ${SURCHARGE_AMOUNT_OVERRIDE.label}`, value, SURCHARGE_AMOUNT_OVERRIDE.box);
    if (refused) { putBack(key); onError(refused); return false; }
    return saveBox(key, save(row.surchargeId, { amount: value.trim() === "" ? null : value }), value);
  }

  /** Removes the override entirely (rather than PUTting optOut:false/rate:null/amount:null),
   *  which is what actually frees this surcharge to be deleted — a live override row blocks its
   *  surcharge's deletion even when every field on it reads empty (task-8 brief's opening
   *  blockquote; `customerSurchargeOptions`' own `hasOverride` distinguishes the two). Same queue
   *  as `save`: must serialize against edits to this same row too.
   *
   *  Fix 4, fix wave 1 review: was a one-click destructive write with no confirmation, unlike the
   *  surcharge delete on admin/surcharges/page.tsx that surfaces this same escape hatch — the
   *  one modal (ruling 5), asked before the run joins the queue. Plain wording, not alarming:
   *  the change is audited and therefore recoverable (re-entering the override recreates it). */
  async function clearOverride(surchargeId: string, surchargeName: string, kind: SurchargeKindValue): Promise<void> {
    // P3a (#239): branched by kind, like the placeholder in the box directly beside this button.
    // "the plant rate" is the wrong noun for a FLAT surcharge, which has an amount and no rate.
    if (!await askConfirm({
      title: `Clear the "${surchargeName}" override?`,
      body: `This customer will bill at the ${plantDefaultNoun(kind)} instead.`,
      confirm: "Clear override", danger: true,
    })) return;
    const run = async () => {
      try {
        await api(`/api/customers/${customerId}/surcharges`, {
          method: "DELETE", body: JSON.stringify({ surchargeId }),
        });
        invalidateHistory(); // #14 item 1
        onError(null); await load();
      } catch (e) {
        await load().catch(() => {});
        onError((e as Error).message);
      }
    };
    saveQueue.current = saveQueue.current.then(run, run);
    return saveQueue.current;
  }

  return (
    <section className={`${CARD} mb-6`}>
      <h2 className="mb-2 font-medium">Surcharge overrides</h2>
      {/* Gated on `rowsReady` (Fix 1, fix wave 1 review): without it this read exactly as "no
          active surcharges" while the mount fetch was still in flight or had already failed —
          the empty array `rows` starts at is indistinguishable from a genuinely empty, loaded
          list. */}
      {rowsReady && rows.length === 0 && (
        <p className="text-sm text-ink-500">No active surcharges are configured.</p>
      )}
      <div className="divide-y">
        {rows.map((row) => {
          const rateKey = `${row.surchargeId}.rate`;
          const amountKey = `${row.surchargeId}.amount`;
          return (
            <div key={row.surchargeId} className="flex flex-wrap items-center gap-4 py-2 text-sm">
              <span className="w-48 shrink-0 font-medium">{row.surchargeName}</span>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={shownValue(optOutPicks[row.surchargeId], row.optOut)} disabled={disabled} title={title}
                       onChange={(e) => pickOptOut(row.surchargeId, e.target.checked)} />
                Opt out
              </label>
              {row.kind === "PERCENT" ? (
                <label className="flex items-center gap-1">
                  Rate override (%)
                  <input value={draftValue(rateKey, decimalToPercentText(row.rate))} inputMode="decimal"
                         disabled={disabled} title={title} placeholder="plant rate"
                         aria-label={SURCHARGE_RATE_OVERRIDE.label}
                         onFocus={(e) => noteFocus(focus.current, rateKey, e.target.value)}
                         onChange={(e) => setTextDrafts((d) => ({ ...d, [rateKey]: e.target.value }))}
                         onBlur={(e) => leaveSave(rateKey, e.target.value, (value) => commitRateOverride(row, value))}
                         onKeyDown={(e) => enterSave(e, rateKey, (value) => commitRateOverride(row, value))}
                         className={`${INPUT_COMPACT} w-20 text-right disabled:bg-surface-50`} />
                  <SavedMark label={SURCHARGE_RATE_OVERRIDE.label} show={savedMarks.shows(rateKey, draftValue(rateKey, decimalToPercentText(row.rate)))} />
                </label>
              ) : (
                <label className="flex items-center gap-1">
                  Amount override ($)
                  <input value={draftValue(amountKey, moneyText(row.amount))} inputMode="decimal"
                         disabled={disabled} title={title} placeholder="plant amount"
                         aria-label={SURCHARGE_AMOUNT_OVERRIDE.label}
                         onFocus={(e) => noteFocus(focus.current, amountKey, e.target.value)}
                         onChange={(e) => setTextDrafts((d) => ({ ...d, [amountKey]: e.target.value }))}
                         onBlur={(e) => leaveSave(amountKey, e.target.value, (value) => commitAmountOverride(row, value))}
                         onKeyDown={(e) => enterSave(e, amountKey, (value) => commitAmountOverride(row, value))}
                         className={`${INPUT_COMPACT} w-24 text-right disabled:bg-surface-50`} />
                  <SavedMark label={SURCHARGE_AMOUNT_OVERRIDE.label} show={savedMarks.shows(amountKey, draftValue(amountKey, moneyText(row.amount)))} />
                </label>
              )}
              {/* Discoverable removal (task-8 brief's opening blockquote): only shown once a live
                  override row actually exists — `hasOverride`, not the field values, which read
                  identically to "no override" once every field is cleared back to empty. */}
              {row.hasOverride ? (
                <button onClick={() => void clearOverride(row.surchargeId, row.surchargeName, row.kind)} disabled={disabled} title={title}
                        className="text-xs text-red-600">
                  Clear override
                </button>
              ) : (
                <span className="text-xs text-ink-500">no override — bills at the {plantDefaultNoun(row.kind)}</span>
              )}
            </div>
          );
        })}
      </div>
      <PanelMessage message={sectionMessage} />
    </section>
  );
}
