"use client";
import { useState } from "react";
import Link from "next/link";
import { decimalRefusal, readDecimal } from "@/lib/decimal-entry";
import { formatNumber } from "@/lib/format";
import type { EntryPlanPreview, LoadAdjustment } from "@/lib/order-entry-plan";
import type { TravelerSelection } from "@/lib/traveler-selection";
import { travelerSelectionSchema } from "@/lib/traveler-selection";
import type { Gate } from "@/lib/permission-ui";
import { WEIGHT_PER_LOAD } from "@/lib/order-boxes";
import { NET_WEIGHT_LB } from "@/lib/weight-terms";
import { blankLoadAdjustment, type LoadAdjustmentDraft } from "./order-draft";
import { formatEntryWeightCents, loadLimitsLabel, type PlanAvailability } from "./OrderSummary";
import { BUTTON_NEUTRAL_COMPACT, INPUT_COMPACT, LINK, NOTICE } from "@/lib/ui-classes";

// Same public bound as travelerSelectionSchema and the traveler renderer. A subset at or below
// the bound remains printable even when the complete order is larger.
export const ENTRY_TRAVELER_LIMIT = 100;
const LOADS_PER_PAGE = 100;

/** The order's load adjustment as the boxes hold it: the adjustment the preview and the save send,
 *  and every refusal, which both the line under the boxes and Save's list show word for word.
 *  Weight per load is read through the one rule (`src/lib/decimal-entry.ts`), never `Number()` on
 *  its own: `1e2` must not be laundered into a figure the server would refuse. A blank box is no
 *  cap. It is read as Save takes it, so `2000.` is 2000: no refusal flashes under the box while
 *  `2000.5` is being typed, and the preview reads the figure Save would send. */
export function parseEntryAdjustment(draft: LoadAdjustmentDraft): {
  adjustment: LoadAdjustment | null; errors: { fieldId: string; message: string }[];
} {
  if (!draft.enabled) return { adjustment: { source: "part" }, errors: [] };
  const errors: { fieldId: string; message: string }[] = [];
  const rawQty = draft.loadQty.trim();
  const qty = rawQty === "" ? null : /^\d+$/.test(rawQty) ? Number(rawQty) : Number.NaN;
  if (qty !== null && (!Number.isSafeInteger(qty) || qty < 1)) errors.push({
    fieldId: "entry-load-quantity", message: "Pieces per load must be a whole number greater than zero, or blank for no cap.",
  });
  const weightRefusal = decimalRefusal(WEIGHT_PER_LOAD.label, draft.loadWeight, WEIGHT_PER_LOAD.box);
  if (weightRefusal) errors.push({ fieldId: "entry-load-weight", message: weightRefusal });
  if (errors.length) return { adjustment: null, errors };
  const reading = draft.loadWeight.trim() === "" ? null : readDecimal(draft.loadWeight, WEIGHT_PER_LOAD.box);
  return { adjustment: { source: "order", loadQty: qty, loadWeight: reading?.ok ? reading.value : null }, errors };
}

export function entryPrintProblem(preview: EntryPlanPreview | null, selection: TravelerSelection): string | null {
  if (!preview) return "Wait for a current load plan before printing.";
  if (!travelerSelectionSchema.safeParse(selection).success) return "Select between 1 and 100 distinct loads to print.";
  const numbers = selection.mode === "all" ? preview.loads.map(load => load.loadNumber) : selection.loadNumbers;
  if (numbers.length > ENTRY_TRAVELER_LIMIT) return "Print at most 100 travelers at once. Select a smaller load set; Save is still available.";
  if (!numbers.length || numbers.some(number => !preview.loads.some(load => load.loadNumber === number))) {
    return "Review the traveler selection for this load plan.";
  }
  return null;
}

export function ProcessLoadsPanel({ leadPartName, processesGate, preview, availability, error,
  adjustment, onAdjustmentChange, selection, onSelectionChange, onRefresh, notice }: {
  leadPartName: string | null; processesGate: Gate;
  preview: EntryPlanPreview | null; availability: PlanAvailability; error: string | null;
  adjustment: LoadAdjustmentDraft; onAdjustmentChange: (draft: LoadAdjustmentDraft) => void;
  selection: TravelerSelection; onSelectionChange: (selection: TravelerSelection) => void;
  onRefresh: () => void; notice?: string | null;
}) {
  const [page, setPage] = useState(0);
  const current = availability === "ready" ? preview : null;
  const content = processesGate.allowed ? current?.process : undefined;
  const errors = parseEntryAdjustment(adjustment).errors;
  const printProblem = entryPrintProblem(current, selection);
  const pageCount = Math.ceil((current?.loads.length ?? 0) / LOADS_PER_PAGE);
  const currentPage = Math.min(page, Math.max(0, pageCount - 1));
  const visibleLoads = current?.loads.slice(currentPage * LOADS_PER_PAGE, (currentPage + 1) * LOADS_PER_PAGE) ?? [];
  const selectedCount = current ? (selection.mode === "all" ? current.loads.length : selection.loadNumbers.length) : null;
  return <div className="space-y-5">
    <section className="rounded border border-line bg-surface-0 p-4">
      <h2 className="text-lg font-semibold">Part process</h2>
      <p className="mt-1 text-sm">{leadPartName ?? "Pick a lead part"}{current ? ` · Revision ${current.revisionNumber}` : ""}</p>
      <p className="mt-1 text-xs text-ink-500">Instructions belong to this part. The order captures its revision when saved.</p>
      {!processesGate.allowed && <p className="mt-3 text-sm text-ink-500">
        Process content unavailable: requires processes.view. Load planning and order creation remain available.
      </p>}
      {processesGate.allowed && !content && <p className="mt-3 text-sm text-ink-500">
        {availability === "loading" ? "Updating process and load plan…" : "Process content is unavailable until a current load plan is ready."}
      </p>}
      {content && <>
        <p className="mt-3 text-sm">Recipe number: {content.recipeNumber ?? "—"}</p>
        <div className="mt-2 max-h-80 overflow-auto rounded border border-line">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-surface-50"><tr><th className="p-2">Step</th><th className="p-2">Operation</th><th className="p-2">Instruction</th></tr></thead>
            <tbody>{content.steps.map((step, index) => <tr key={`${step.position}-${index}`} className="border-t border-line align-top">
              <td className="p-2">{step.position}</td>
              <td className="break-words p-2 font-medium">{step.code} — {step.codeName}</td>
              <td className="break-words p-2">
                <p className="whitespace-pre-wrap">{step.instruction}</p>
                {step.fields.length > 0 && <dl className="mt-1 text-xs text-ink-500">{step.fields.map((field, fieldIndex) =>
                  <div key={fieldIndex}><dt className="inline">{field.label}: </dt><dd className="inline">
                    {field.value === null ? "—" : typeof field.value === "boolean" ? field.value ? "Yes" : "No" : field.value}
                    {field.unit ? ` ${field.unit}` : ""}<span className="sr-only"> ({field.type})</span>
                  </dd></div>)}</dl>}
              </td>
            </tr>)}</tbody>
          </table>
        </div>
        <Link href={`/parts/${current!.leadPartId}`} className={`${LINK} mt-2 inline-block text-xs`}>
          Open this part&apos;s Process Steps
        </Link>
      </>}
    </section>

    <section className="rounded border border-line bg-surface-0 p-4">
      <h2 className="text-lg font-semibold">Load plan</h2>
      <p className="mt-1 text-xs text-ink-500">{adjustment.enabled ? "Adjusted for this order only." : "Using this part’s saved load limits."}</p>
      {notice && <p role="status" className={`${NOTICE.info} mt-2`}>{notice}</p>}
      {current && <p className="mt-2 text-sm">Part defaults: {loadLimitsLabel(current.defaults)}</p>}
      {!adjustment.enabled ? <button type="button" disabled={!current} onClick={() => {
        if (current) onAdjustmentChange({ enabled: true, leadPartId: current.leadPartId,
          loadQty: current.defaults.loadQty === null ? "" : String(current.defaults.loadQty),
          loadWeight: current.defaults.loadWeight === null ? "" : String(current.defaults.loadWeight) });
      }} className={`${BUTTON_NEUTRAL_COMPACT} mt-3`}>Adjust for this order</button>
        : <div className="mt-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">Pieces per load
              <input id="entry-load-quantity" aria-invalid={errors.some(item => item.fieldId === "entry-load-quantity")}
                value={adjustment.loadQty} inputMode="numeric" placeholder="No quantity cap"
                onChange={event => onAdjustmentChange({ ...adjustment, loadQty: event.target.value })}
                className={`${INPUT_COMPACT} mt-1 w-full`} />
            </label>
            <label className="text-sm">{WEIGHT_PER_LOAD.label}
              <input id="entry-load-weight" aria-invalid={errors.some(item => item.fieldId === "entry-load-weight")}
                value={adjustment.loadWeight} inputMode="decimal" placeholder="No weight cap"
                onChange={event => onAdjustmentChange({ ...adjustment, loadWeight: event.target.value })}
                className={`${INPUT_COMPACT} mt-1 w-full`} />
            </label>
          </div>
          {errors.map(item => <p key={item.fieldId} role="alert" className="mt-1 text-xs text-red-700">{item.message}</p>)}
          <button type="button" onClick={() => onAdjustmentChange(blankLoadAdjustment())}
            className={`${LINK} mt-2 text-sm`}>Use part defaults</button>
        </div>}
      <p className="mt-2 text-xs text-ink-500">Both caps apply when set. Blank means no cap. Order adjustments leave this part&apos;s saved defaults unchanged.</p>
      {error && <p role="alert" className={`${NOTICE.refusal} mt-3`}>{error}</p>}
      {!current && <p role="status" className="mt-3 text-sm text-ink-500">{availability === "loading"
        ? "Updating load plan…" : "Load plan unavailable. Complete or correct the entry fields."}</p>}
      <button type="button" id="entry-refresh-plan" onClick={onRefresh}
        className={`${LINK} mt-2 text-sm`}>Refresh plan</button>
      {current && <>
        <p className="mt-3 text-sm">Effective limits: {loadLimitsLabel(current.effective)}</p>
        <div className="mt-3 max-h-80 overflow-auto rounded border border-line">
          <table className="w-full text-left text-sm"><thead className="sticky top-0 bg-surface-50"><tr>
            <th className="p-2">Load</th><th className="p-2">Pieces</th><th className="p-2">{NET_WEIGHT_LB}</th>
            {selection.mode === "loads" && <th className="p-2">Print</th>}
          </tr></thead><tbody>{visibleLoads.map(load => <tr key={load.loadNumber} className="border-t border-line">
            <td className="p-2">Load {load.loadNumber}</td><td className="p-2">{formatNumber(load.qty)}</td>
            <td className="p-2">{formatNumber(load.weight, 2)}</td>
            {selection.mode === "loads" && <td className="p-2"><input type="checkbox" aria-label={`Print load ${load.loadNumber}`}
              checked={selection.loadNumbers.includes(load.loadNumber)}
              disabled={selection.loadNumbers.includes(load.loadNumber) ? selection.loadNumbers.length === 1 : selection.loadNumbers.length >= ENTRY_TRAVELER_LIMIT}
              onChange={event => onSelectionChange({ mode: "loads", loadNumbers: (event.target.checked
                ? [...selection.loadNumbers, load.loadNumber] : selection.loadNumbers.filter(number => number !== load.loadNumber)).sort((a, b) => a - b) })} /></td>}
          </tr>)}</tbody></table>
        </div>
        {pageCount > 1 && <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
          <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} className="text-link-700">Previous loads</button>
          <span>Loads {currentPage * LOADS_PER_PAGE + 1}–{Math.min((currentPage + 1) * LOADS_PER_PAGE, current.loads.length)} of {formatNumber(current.loads.length)}</span>
          <button type="button" disabled={currentPage + 1 === pageCount} onClick={() => setPage(currentPage + 1)} className="text-link-700">Next loads</button>
        </div>}
        <p className="mt-3 text-sm">Allocated {formatNumber(current.totalQty)} / {formatNumber(current.totalQty)} pieces · {formatEntryWeightCents(current.totalWeightCents)} / {formatEntryWeightCents(current.totalWeightCents)} lb</p>
        <p className="mt-1 text-xs text-success-700">Fully allocated · 0 pieces remaining</p>
        <div className="mt-4 border-t border-line pt-3">
          <label className="block text-sm">Travelers
            <select id="entry-traveler-selection" value={selection.mode} onChange={event => onSelectionChange(event.target.value === "all"
              ? { mode: "all" } : { mode: "loads", loadNumbers: current.loads.slice(0, ENTRY_TRAVELER_LIMIT).map(load => load.loadNumber) })}
              className={`${INPUT_COMPACT} ml-2 max-w-full`}>
              <option value="all">All {formatNumber(current.loads.length)} loads</option><option value="loads">Selected loads</option>
            </select>
          </label>
          <p className="mt-2 text-xs text-ink-500">{formatNumber(selectedCount)} travelers selected. Keep at least one load selected; at most 100 can print at once. Containers do not determine travelers.</p>
          {printProblem && <p className="mt-2 text-sm text-accent-600">{printProblem}</p>}
        </div>
      </>}
    </section>
  </div>;
}
