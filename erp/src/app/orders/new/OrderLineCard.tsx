"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/fetcher";
import { useLatest } from "@/lib/use-latest";
import { formatNumber } from "@/lib/format";
import { calculatedNetWeight } from "@/lib/net-weight";
import { EACH_WEIGHT_LB, NET_WEIGHT_LB } from "@/lib/weight-terms";
import { useUnsavedSection } from "@/lib/use-unsaved-section";
import { expandSerialRange } from "@/lib/serial-range";
import type { Gate } from "@/lib/permission-ui";
import { Combobox, type ComboboxOption } from "@/components/Combobox";
import { QuoteLinkPicker } from "./QuoteLinkPicker";
import type { LineDraft, PartOption, SerialDraft } from "./order-draft";
import { EntryOptionalSection } from "./EntryWorkspace";
import { newId } from "@/lib/client-id";
import { INPUT_COMPACT, LINK } from "@/lib/ui-classes";
import { partOptions } from "@/lib/menu-options";

// Mirrors src/server/part-process-steps.ts's RevisionSummary/RevisionDetail (narrowed to what
// this preview renders) — not imported, same reason every client file in this app keeps its own
// copy of a server type rather than importing from src/server/** (CLAUDE.md).
type RevisionSummary = { revisionNumber: number; stepCount: number };
type RevisionStepParameter = { key: string; label: string; unit: string | null; value: string };
type RevisionStep = {
  id: string; position: number; code: string; codeName: string; instruction: string;
  parameters: RevisionStepParameter[];
};
type RevisionDetail = { revisionNumber: number; steps: RevisionStep[] };

type LeadCheck =
  | { status: "checking" }
  | { status: "ok"; revisionNumber: number; steps: RevisionStep[] }
  | { status: "no-steps" }
  | { status: "unknown"; message: string }; // fetch failed or lacking processes.view — never blocks; the save-time 400 is the real gate

// Exported so page.tsx's validation and submit body, and the order hub's add-rider default, use the
// exact figure this card displays. The figure is `calculatedNetWeight` (src/lib/net-weight.ts), the
// one statement of quantity × each weight: whole cents, rounded half up. Null, shown as a blank
// weight box, for no part, for a quantity that is not a whole number above zero, and for a product
// past 9,999,999,999.99 lb.
export function computeLineWeight(part: PartOption | undefined, qty: number): number | null {
  if (!part || !Number.isFinite(qty) || qty <= 0) return null;
  return calculatedNetWeight(qty, part.eachWeight);
}

/** The serials repeated within ONE line, each compared and answered trimmed (#546, owner ruling
 *  2026-10-18), as the server compares them: `SERIAL_ITEM` (src/server/order-internals.ts) trims
 *  each serial, and a repeat is then refused, through `@@unique([lineId, serial])` and
 *  `duplicateSerialError` where `createSerials` writes a line's serials (a new order, an added
 *  rider), and in code by `replaceSerials` (src/server/order-edit.ts), the saved order's Serials
 *  grid. The comparison is exact past the trim, so `A` and `a` are two serials. A serial repeated
 *  across two DIFFERENT lines is not flagged; the server allows it too. A serial blank after
 *  trimming is never a duplicate: it is left to each screen's blank check, as the server refuses a
 *  blank serial in its parse (`SERIAL_ITEM`'s `min(1)`) before it looks for a repeat.
 *  Exported so page.tsx's validate() gates Save on the same check this card displays live, and so
 *  the saved order's SerialsSection reads it too. */
export function findDuplicateSerials(serials: SerialDraft[]): Set<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const s of serials) {
    const serial = s.serial.trim();
    if (!serial) continue;
    if (seen.has(serial)) dupes.add(serial);
    else seen.add(serial);
  }
  return dupes;
}

/**
 * One part line: the picker, qty/weight (derived-until-touched), the lead's read-only revision
 * preview, and its serial entry grid. Position (lead vs. rider) is purely "am I index 0 in the
 * parent's array" — there is no separate "this is the lead" flag to keep in sync.
 */
export function OrderLineCard({
  index, isLead, line, parts, customerChosen, partsGate, processesGate,
  customerId, receivedDate, ordersViewAllowed, quotePickGate, onChange, onRemove, onLeadValidity,
  coordinatedProcess = false, serialError = false, onSerialProblem,
}: {
  index: number;
  isLead: boolean;
  line: LineDraft;
  parts: PartOption[]; // already filtered to the selected customer
  customerChosen: boolean;
  partsGate: Gate;
  processesGate: Gate;
  /** For the quote-link preview (Task 9): the selected customer, the form's received-date
   *  override (undefined while untouched — QuoteLinkPicker omits the param and the server
   *  previews against its own today), and the two gates the picker needs (§5.16). */
  customerId: string | null;
  receivedDate: string | undefined;
  ordersViewAllowed: boolean;
  quotePickGate: Gate;
  onChange: (patch: Partial<LineDraft>) => void;
  onRemove?: () => void;
  /** Fires only while isLead, reporting THIS line's id alongside the verdict (`null` =
   *  unknown/unchecked — never blocks Save on its own). The id is what lets the parent ignore a
   *  report from a line that is no longer the lead (fix-wave R4 finding 9, `resolveLeadValidity`). */
  onLeadValidity?: (lineId: string, ok: boolean | null) => void;
  /** Entry's coherent preview owns process presentation and lead-part orderability. */
  coordinatedProcess?: boolean;
  serialError?: boolean;
  onSerialProblem?: (lineId: string, message: string | null) => void;
}) {
  const part = parts.find((p) => p.id === line.partId);
  const qtyNum = Number(line.qty);
  const computedWeight = computeLineWeight(part, qtyNum);
  const displayedWeight = line.weightOverride ?? (computedWeight !== null ? computedWeight.toFixed(2) : "");

  const [rangeInput, setRangeInput] = useState("");
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [leadCheck, setLeadCheck] = useState<LeadCheck | null>(null);
  useUnsavedSection(rangeInput.trim() !== "", `Line ${index + 1} serial range`);
  useEffect(() => { onSerialProblem?.(line.id, rangeError); }, [line.id, rangeError, onSerialProblem]);

  const checkLead = useCallback(async (partId: string): Promise<LeadCheck> => {
    const revs = await api<RevisionSummary[]>(`/api/parts/${partId}/process/revisions`);
    const current = revs[0]; // getRevisions orders revisionNumber desc — [0] is the current one
    if (!current || current.stepCount === 0) return { status: "no-steps" };
    const detail = await api<RevisionDetail>(`/api/parts/${partId}/process/revisions/${current.revisionNumber}`);
    return { status: "ok", revisionNumber: detail.revisionNumber, steps: detail.steps };
  }, []);

  const latest = useLatest();
  // Lazily validated ONLY for the lead line, and ONLY the one part actually picked — not every
  // option in the picker's dropdown, which would mean one fetch per part instead of one per pick
  // (task-13-brief.md's steer: the parts list payload carries no steps-status column, so
  // upfront per-option disabling would need N fetches; validating the single pick is the cheap
  // alternative). Re-runs whenever this card becomes/stops being the lead too, since removing an
  // earlier line can promote this one to index 0 without its partId changing.
  const lineId = line.id;
  useEffect(() => {
    if (!isLead || !line.partId || !processesGate.allowed) {
      setLeadCheck(null);
      onLeadValidity?.(lineId, null);
      return;
    }
    // The coordinated entry page validates the lead through its coherent plan preview. Reporting
    // unknown here leaves that preview as the sole client-side authority and avoids a second,
    // independently timed read of the legacy revision endpoints. Standalone cards retain the
    // full list/detail check below.
    if (coordinatedProcess) {
      setLeadCheck(null);
      onLeadValidity?.(lineId, null);
      return () => { latest.next(); };
    }
    const partId = line.partId;
    const t = latest.next();
    setLeadCheck({ status: "checking" });
    // A fresh dispatch means the verdict is unknown until this check resolves (null never blocks,
    // src/lib/lead-validity.ts) — without this the guard branch above reported null at dispatch
    // but the fetch path never did, so a part swap left Save refusing on the PREVIOUS part's
    // verdict while the panel showed "Checking…".
    onLeadValidity?.(lineId, null);
    checkLead(partId).then((result) => {
      if (!latest.isCurrent(t)) return;
      setLeadCheck(result);
      onLeadValidity?.(lineId, result.status === "ok");
    }).catch((e) => {
      if (!latest.isCurrent(t)) return;
      setLeadCheck({ status: "unknown", message: (e as Error).message });
      onLeadValidity?.(lineId, null);
    });
    // Fix-wave R4 finding 9: bump the gate on cleanup, so a check still in flight when this card
    // UNMOUNTS resolves into nothing. Without it, removing the lead line mid-check left the
    // resolution free to run `setLeadCheck` on a dead component and — worse — to report a verdict
    // about the removed part, which the parent then held against whichever line had been promoted
    // into the lead position. `latest.isCurrent(t)` is false for every outstanding ticket after
    // this, which is exactly the "report nothing" the two `.then`/`.catch` guards above already
    // implement for a superseded (rather than unmounted) check.
    return () => { latest.next(); };
  }, [isLead, lineId, line.partId, processesGate.allowed, coordinatedProcess, latest, checkLead, onLeadValidity]);

  // Spec §11: the picker shows step-status up front rather than only after a pick — but only for
  // the LEAD slot. Riders never lock a revision (resolveLineParts exempts them from the
  // orderability check server-side too), so a steps-less part is perfectly valid there.
  const partMenu: ComboboxOption[] = partOptions(parts, {
    separator: " — ", disabledReason: (p) => (isLead && !p.hasProcessSteps ? "No process steps" : undefined),
  });
  const dupes = findDuplicateSerials(line.serials);

  function addRange() {
    if (!rangeInput.trim()) {
      // Removing an invalid pending range also removes its local/parent refusal. No serials
      // are added or removed; the existing effect reports this cleared verdict to the page.
      setRangeError(null);
      return;
    }
    try {
      const expanded = expandSerialRange(rangeInput);
      onChange({ serials: [...line.serials, ...expanded.map((serial) => ({ id: newId(), serial, description: "" }))] });
      setRangeInput("");
      setRangeError(null);
    } catch (e) {
      // expandSerialRange throws a plain Error with a message already fit to show the user
      // (src/lib/serial-range.ts) — nothing left to translate.
      setRangeError((e as Error).message);
    }
  }

  function updateSerial(i: number, patch: Partial<SerialDraft>) {
    onChange({ serials: line.serials.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) });
  }
  function removeSerial(i: number) {
    onChange({ serials: line.serials.filter((_, idx) => idx !== i) });
  }

  const partsTitle = !customerChosen ? "Pick a customer first" : !partsGate.allowed ? partsGate.title : undefined;
  // C2a (#239): every field on a part line hangs off the chosen customer — the picker offers only
  // that customer's catalog, the weight shown is derived from the picked part's each-weight, and
  // the serials name pieces of that part. The Part picker has always said so; Qty, Weight and the
  // serial range box stayed typeable, so the blank form invited work with nothing yet to attach it
  // to. One condition, named once, so the three cannot drift from the picker they sit beside.
  // (Permission is deliberately NOT folded in: `partsGate` is `parts.view`, which gates reading the
  // CATALOG, not typing a quantity.)
  const customerTitle = customerChosen ? undefined : "Pick a customer first";

  return (
    <div className="mb-4 rounded border p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">
          {isLead
            ? <span className="rounded bg-ink-900 px-1.5 py-0.5 text-xs text-white">Lead</span>
            : `Line ${index + 1}`}
        </span>
        {onRemove && <button type="button" onClick={onRemove} className="text-xs text-red-600">Remove</button>}
      </div>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(4rem,0.6fr)_minmax(5rem,0.8fr)_minmax(6rem,1fr)]">
        <label className="min-w-0 block text-sm" id={`entry-line-${line.id}-part`}>
          Part
          {/* A part swap resets the quote pick to auto (spec §5.2's "swapping a line's part
              clears and re-resolves its link") — an explicit pick made for the OLD part must
              never ride onto the new one; the fresh part's preview re-resolves from scratch. */}
          <Combobox value={line.partId} options={partMenu}
                     onSelect={(partId) => onChange({ partId, quoteLineIdOverride: undefined })}
                     disabled={!customerChosen || !partsGate.allowed} title={partsTitle}
                     placeholder="Part number or name" ariaLabel={`Line ${index + 1} part`} />
        </label>
        <label className="block text-sm">
          Qty
          <input id={`entry-line-${line.id}-qty`} value={line.qty} inputMode="numeric" onChange={(e) => onChange({ qty: e.target.value })}
                 disabled={!customerChosen} title={customerTitle}
                 aria-label={`Line ${index + 1} quantity`}
                 className={`${INPUT_COMPACT} mt-1 w-full disabled:cursor-not-allowed disabled:bg-surface-50`} />
        </label>
        <div className="text-sm"><span>{EACH_WEIGHT_LB}</span><p className="mt-1 rounded border bg-surface-50 px-2 py-1">
          {part ? formatNumber(part.eachWeight, 4) : "—"}
        </p></div>
        <label className="block text-sm">{NET_WEIGHT_LB}
          <input id={`entry-line-${line.id}-weight`} value={displayedWeight} inputMode="decimal"
            onChange={(e) => onChange({ weightOverride: e.target.value })}
            disabled={!customerChosen} title={customerTitle} aria-label={`Line ${index + 1} weight`}
            className={`${INPUT_COMPACT} mt-1 w-full disabled:cursor-not-allowed disabled:bg-surface-50`} />
        </label>
      </div>
      {line.weightOverride !== null && <button type="button" onClick={() => onChange({ weightOverride: null })}
        className={`${LINK} mt-1 text-xs`}>Reset to computed</button>}

      {/* The customer can change after a part was already picked (the picker's `parts` prop is
          filtered to whichever customer is CURRENTLY selected) — rather than silently clearing
          what the user typed, name what's now wrong, the same "never a dead end without an
          explanation" rule every blocked-delete guard in this app follows. */}
      {line.partId && !part && (
        <p className="mt-2 rounded bg-accent-50 p-1.5 text-xs text-accent-600">
          This part is not in the selected customer&apos;s catalog — pick a different part.
        </p>
      )}

      {/* Spec §5.2 / Task 9: the resolution shown BEFORE save, with re-pick/unlink. Hidden while
          the picked part is stale (`part` unresolved — the amber warning above already owns that
          state, and a preview for a part of another customer would only mislead). */}
      <QuoteLinkPicker id={`entry-line-${line.id}-quote`} customerId={customerId} partId={part ? line.partId : null}
                       receivedDate={receivedDate}
                       value={line.quoteLineIdOverride}
                       onChange={(pick) => onChange({ quoteLineIdOverride: pick })}
                       pickGate={quotePickGate} viewAllowed={ordersViewAllowed}
                       ariaLabel={`Line ${index + 1} quote link`} />

      {part?.serializationRequired && line.serials.length === 0 && (
        <p className="mt-2 rounded bg-accent-50 p-1.5 text-xs text-accent-600">
          Serialization required — no serials entered yet.
        </p>
      )}

      {/* L4a (#239): the panel is gated on the VERDICT, not on being the lead. Every branch inside
          it is conditional on `leadCheck`, which is null until a part is picked (and whenever this
          card stops being the lead, or `processes.view` is missing) — so on a blank form the outer
          box rendered an empty grey strip with nothing in it. Nothing is lost by hiding it: a null
          verdict has no sentence to show. */}
      {!coordinatedProcess && isLead && leadCheck !== null && (
        <div className="mt-3 rounded border border-line bg-surface-50 p-2 text-sm">
          {leadCheck?.status === "checking" && <p className="text-ink-500">Checking process steps…</p>}
          {leadCheck?.status === "no-steps" && (
            <p className="text-red-700">No process steps — this part cannot be the lead.</p>
          )}
          {leadCheck?.status === "unknown" && (
            <p className="text-ink-500">Could not verify process steps: {leadCheck.message}</p>
          )}
          {leadCheck?.status === "ok" && (
            <div>
              <p className="font-medium">Rev {leadCheck.revisionNumber} — locks at save</p>
              <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-xs text-ink-500">
                {leadCheck.steps.map((s) => (
                  <li key={s.id}>
                    {s.code} — {s.codeName}
                    {s.instruction && `: ${s.instruction}`}
                    {s.parameters.length > 0 && (
                      <span> ({s.parameters.map((p) => `${p.label}: ${p.value}${p.unit ? ` ${p.unit}` : ""}`).join(", ")})</span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}

      <div className="mt-3"><EntryOptionalSection title="Serial numbers" optional={!part?.serializationRequired}
        forceOpen={!!part?.serializationRequired || line.serials.length > 0 || !!rangeInput || !!rangeError || serialError}>
        <label className="block text-sm">
          Add serial(s)
          <input id={`entry-line-${line.id}-serials`} value={rangeInput} onChange={(e) => setRangeInput(e.target.value)} onBlur={addRange}
                 onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addRange(); } }}
                 disabled={!customerChosen} title={customerTitle}
                 placeholder="EC001 or EC{001-025}" aria-label={`Line ${index + 1} add serial`}
                 className={`${INPUT_COMPACT} mt-1 w-full font-mono disabled:cursor-not-allowed disabled:bg-surface-50`} />
        </label>
        {rangeError && <p className="mt-1 text-xs text-red-700">{rangeError}</p>}
        {dupes.size > 0 && (
          <p className="mt-1 rounded bg-red-50 p-1.5 text-xs text-red-700">
            Duplicate serial{dupes.size > 1 ? "s" : ""}: {[...dupes].join(", ")}
          </p>
        )}
        {line.serials.length > 0 && (
          <div className="mt-2 space-y-1">
            {line.serials.map((s, i) => (
              <div key={s.id} className={`flex items-center gap-2 rounded border p-1 ${dupes.has(s.serial.trim()) ? "border-red-400 bg-red-50" : ""}`}>
                <input id={`entry-line-${line.id}-serial-${s.id}`} value={s.serial} onChange={(e) => updateSerial(i, { serial: e.target.value })}
                       aria-label={`Line ${index + 1} serial ${i + 1}`}
                       className="w-28 min-w-0 rounded border px-1 py-0.5 font-mono text-xs" />
                <input id={`entry-line-${line.id}-serial-${s.id}-description`} value={s.description} onChange={(e) => updateSerial(i, { description: e.target.value })}
                       placeholder="Description" aria-label={`Line ${index + 1} serial ${i + 1} description`}
                       className="min-w-0 flex-1 rounded border px-1 py-0.5 text-xs" />
                <button type="button" onClick={() => removeSerial(i)} aria-label={`Remove serial ${s.serial}`}
                        className="text-xs text-red-600">
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </EntryOptionalSection></div>
    </div>
  );
}
