"use client";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/fetcher";
import type { Gate } from "@/lib/permission-ui";
import { useBulkGrid } from "@/lib/bulk-grid";
import { DraftRecoveryNotice } from "@/components/DraftRecoveryNotice";
import { loadFields, projectLoads, orderBulkOptions, orderAckSnapshot, type OrderBulkSource } from "@/lib/order-bulk-recovery";
import { LoadAllocationSummary } from "./LoadAllocationSummary";
import { TravelerPrintButton } from "./DocumentsSection";
import type { ApplyMutation, OrderLoad, OrderMutationResult } from "./page";
import { SaveButton } from "@/components/SaveButton";
import { gridGate } from "@/lib/shipment-gates";
import { askDiscard } from "@/lib/use-unsaved-section";
import { newId } from "@/lib/client-id";
import { PanelMessage } from "@/components/PanelMessage";
import { gridAtRest, useMessageClearedAtRest } from "@/lib/grid-message";
import { NET_WEIGHT_LB } from "@/lib/weight-terms";
import { decimalRefusal, decimalSentence } from "@/lib/decimal-entry";
import { LOAD_NET_WEIGHT } from "@/lib/order-boxes";
import { CARD, INPUT_COMPACT, LINK, NOTICE } from "@/lib/ui-classes";

type Fields = { loadNumber: string; qty: string; weight: string };

/**
 * Grid edit + renumber + Re-split (Task 6, spec §5.4/§5b). Neither mutation answers a warning.
 * Whether the loads sum to the order shows in this section's allocation card, which follows
 * unsaved edits, and in the order summary's quantities line, which reads saved values only.
 *
 * Renumber is purely local (not itself a save): it reassigns every composed row's `loadNumber` to
 * its current display position, 1..N, so closing a gap left by a removed row — or fixing a typo —
 * does not mean retyping every other row by hand. `Save loads` still has to be clicked afterward.
 *
 * Task 15 (T14 review rider): DOES still read `grid.orphanWarning`, same as the other three grid
 * sections, despite `applyLoads` (order-loads.ts) matching existing rows by array position and
 * updating them IN PLACE rather than delete-then-recreating them — the shrink path is the
 * exception. When a save (this section's own, or a Re-split producing fewer loads than before)
 * shortens the array, `applyLoads` hard-deletes the trailing rows beyond the new length, so an
 * edit still pending against one of THOSE ids goes stale exactly like it would under
 * replaceContainers/replaceSerials/replaceCharges — `detectOrphans` (bulk-grid.ts) already runs
 * unconditionally inside `compose` for every grid instance, this one included; only the render was
 * missing.
 */
export function LoadsSection({
  recoverySource, orderId, loads, travelerPrinted, editGate, applyMutation, scannedLoad, scanStatus, onRefresh,
}: {
  recoverySource: OrderBulkSource;
  orderId: string;
  loads: OrderLoad[];
  onRefresh: () => Promise<unknown>;
  scannedLoad: string | null;
  scanStatus: "loading" | "ready" | "failed";
  /** #41: `OrderDetail.travelerPrinted` is order state, refreshed by every mutation response. The
   *  reprint notice below derives from it, so it shows the moment the editor renders and no save
   *  elsewhere on the page can clear it. */
  travelerPrinted: boolean;
  editGate: Gate;
  applyMutation: ApplyMutation;
}) {
  const grid = useBulkGrid(loads, loadFields, orderBulkOptions(recoverySource, orderId, "order-loads", "Loads", projectLoads));
  // This grid's own message (owner ruling R1, P6 step 5a): its validation, a refused save and a
  // failed one show under its Save row through the shared PanelMessage, the saved shipment page's
  // shape (#472). The setter keeps the name `onError` the section's calls and the tests that lift
  // them read. The message goes when this grid comes to rest (src/lib/grid-message.ts).
  const [saveMessage, onError] = useState<string | null>(null);
  useMessageClearedAtRest(gridAtRest(grid.dirty, grid.canEdit), onError);
  const rows = grid.rows;
  const baseline = grid.view.mode === "editing" ? grid.view.current?.baseline : grid.view.savedBaseline;
  const ready = !!baseline;
  // Recovery reads can be newer than the parent. Compare loads and lines from the SAME read.
  const contextLines = baseline?.context?.lines;
  const lines = Array.isArray(contextLines) && contextLines.every(line => line && typeof line === "object"
    && "qty" in line && typeof line.qty === "number" && "weight" in line && typeof line.weight === "number")
    ? contextLines as { qty: number; weight: number }[] : [];
  const parentBehind = ready && !grid.dirty && rows.some(row => {
    const saved = loads.find(load => load.id === row.key);
    return !saved || Object.entries(loadFields(saved)).some(([key, value]) => row[key as keyof Fields] !== value);
  });
  const sectionRef = useRef<HTMLElement>(null);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const loadNumber = scannedLoad !== null && /^[1-9]\d*$/.test(scannedLoad)
    && Number.isSafeInteger(Number(scannedLoad)) ? Number(scannedLoad) : null;
  const savedLoad = loads.find(load => load.loadNumber === loadNumber);
  // Local edits can renumber/remove rows. Do not identify an unsaved row as the scanned load.
  const savedFields = savedLoad ? loadFields(savedLoad) : null;
  const displayedLoad = savedFields && rows.find(row => !row.isNew && row.key === savedLoad?.id
    && row.loadNumber === savedFields.loadNumber && row.qty === savedFields.qty && row.weight === savedFields.weight);
  const selectedId = scanStatus === "ready" && !grid.dirty && displayedLoad ? displayedLoad.key : undefined;
  useEffect(() => {
    if (scannedLoad === null) return;
    const section = sectionRef.current;
    const selected = section?.querySelector<HTMLElement>('[aria-current="true"]');
    (selected ?? section)?.scrollIntoView({ block: "center" });
  }, [scannedLoad, selectedId, scanStatus]);

  function patch(row: { key: string; isNew: boolean }, field: keyof Fields, value: string) {
    if (row.isNew) grid.updateAdded(row.key, { [field]: value } as Partial<Fields>);
    else grid.updateExisting(row.key, { [field]: value } as Partial<Fields>);
  }
  function remove(row: { key: string; isNew: boolean }) {
    // REPLACE_LOADS requires at least one row (z.array(LOAD_ITEM).min(1)) — refuse client-side
    // rather than let a doomed PUT round-trip just to learn that.
    if (rows.length <= 1) { onError("An order must keep at least one load."); return; }
    if (row.isNew) grid.removeAdded(row.key);
    else grid.removeExisting(row.key);
  }
  function addRow() {
    grid.addRow({ loadNumber: String(rows.length + 1), qty: "", weight: "" });
  }
  function renumber() {
    const byKey = new Map(rows.map((r, i) => [r.key, String(i + 1)]));
    for (const row of rows) patch(row, "loadNumber", byKey.get(row.key)!);
    // Clearing the message is part of the action, not a courtesy. `buildPayload` refuses a list
    // whose numbers are not 1..N by NAMING this control, and nothing else clears that message
    // except a successful save — but renumbering assigns by position, so it always satisfies the
    // complaint, and since #279 it may satisfy it by writing values the server already holds,
    // which leaves nothing to save and disables the Save button. Without this, following the
    // instruction the error gives would grey out the only control it mentions while the error
    // still stood. Any OTHER validation message returns on the next save attempt.
    onError(null);
  }

  // tests/loads-section.test.tsx lifts `buildPayload` out of this file's source and runs it, because
  // vitest has no DOM to fire a handler in. It stays a function declaration of its name. If it reads
  // a new name from this component, that name goes into the test's environment in the same change.
  function buildPayload(): { loadNumber: number; qty: number | null; weight: string | null }[] | null {
    const parsed = rows.map((r) => ({
      loadNumber: Number(r.loadNumber),
      qty: r.qty.trim() === "" ? null : Number(r.qty),
      weight: r.weight.trim() === "" ? null : r.weight.trim(),
    }));
    // Every refusal is collected, row by row and each row's checks in field order, and listed
    // together in the page's red line; the numbering line comes last. No request goes with any.
    const refused: string[] = [];
    for (const [i, r] of parsed.entries()) {
      if (!Number.isInteger(r.loadNumber) || r.loadNumber < 1) refused.push(`Load ${i + 1}: load # must be a whole number of at least 1.`);
      if (r.qty !== null && (!Number.isInteger(r.qty) || r.qty < 1)) refused.push(`Load ${i + 1}: quantity must be a whole number of at least 1.`);
      // Fix-wave R3 finding 3: a load carrying a qty may legitimately weigh 0 (cumulative
      // rounding on an auto-split — load-split.test.ts's counter-example); only a WEIGHT-ONLY row
      // (no qty at all) still needs a strictly positive weight, mirroring order-loads.ts's own
      // LOAD_ITEM schema exactly.
      if (r.weight !== null) {
        const name = `Load ${i + 1}, ${LOAD_NET_WEIGHT.label}`;
        const refusal = decimalRefusal(name, r.weight, LOAD_NET_WEIGHT.box);
        if (refusal) refused.push(refusal);
        else if (r.qty === null && !(Number(r.weight) > 0)) refused.push(`${name}: ${decimalSentence("notPositive", LOAD_NET_WEIGHT.box)}`);
      }
      if (r.qty === null && r.weight === null) refused.push(`Load ${i + 1}: needs a quantity, a net weight, or both.`);
    }
    const numbers = new Set(parsed.map((r) => r.loadNumber));
    if (numbers.size !== parsed.length || [...numbers].some((n) => n < 1 || n > parsed.length)) {
      refused.push("Load numbers must be 1..N with no gaps or repeats — try Renumber.");
    }
    if (refused.length > 0) { onError(refused.join("\n")); return null; }
    return parsed;
  }

  async function save() {
    const payload = buildPayload();
    if (!payload) return;
    const binding = grid.binding;
    if (!binding || !grid.canEdit || !editGate.allowed) return;
    const submission = binding.capture(payload, newId());
    function projectSavedRows(response: OrderMutationResult) {
      return projectLoads(orderAckSnapshot(response, submission.submitted.baseline)).baseline;
    }
    try {
      await applyMutation(async () => {
        if (!binding.dispatched(submission)) throw new Error("This draft is no longer available to save.");
        let response: OrderMutationResult;
        try {
          response = await api<OrderMutationResult>(`/api/orders/${orderId}/loads`, {
        method: "PUT", body: JSON.stringify(payload),
      });
        } catch (error) {
          binding.settle(submission, { kind: error instanceof ApiError && error.status >= 400 && error.status < 500 ? "rejected" : "unknown" });
          throw error;
        }
        binding.settle(submission, { kind: "persisted", response: projectSavedRows(response) });
        return response;
      });
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  async function resplit() {
    const binding = grid.binding;
    if (!binding || !grid.canEdit || !editGate.allowed) return;
    const submission = binding.capture({ action: "resplit" }, newId());
    function projectSavedRows(response: OrderMutationResult) {
      return projectLoads(orderAckSnapshot(response, submission.submitted.baseline)).baseline;
    }
    try {
      await applyMutation(async () => {
        if (!binding.dispatched(submission)) throw new Error("This draft is no longer available to re-split.");
        let response: OrderMutationResult;
        try {
          response = await api<OrderMutationResult>(`/api/orders/${orderId}/loads/resplit`, { method: "POST" });
        } catch (error) {
          binding.settle(submission, { kind: error instanceof ApiError && error.status >= 400 && error.status < 500 ? "rejected" : "unknown" });
          throw error;
        }
        binding.settle(submission, { kind: "persisted", response: projectSavedRows(response) });
        return response;
      });
      onError(null);
    } catch (e) { onError((e as Error).message); }
  }

  // The modal's answer lands a tick later (ruling 5), and the page can go under an open question
  // (Back), so a section no longer here sends nothing.
  async function askResplit() {
    if (!(await askDiscard({
      action: "Re-split loads using the part’s current defaults? This replaces the current load rows and their unsaved edits.",
    }))) return;
    if (mounted.current) void resplit();
  }

  return (
    <section ref={sectionRef} id="loads" data-order-section tabIndex={-1} className={`${CARD} mb-6`}>
      <h2 className="mb-2 font-medium">Loads</h2>
      <LoadAllocationSummary rows={rows} lines={lines} dirty={grid.dirty} ready={ready} />
      {(parentBehind || scanStatus === "failed") && <p className="mb-3 rounded bg-link-50 p-2 text-sm text-link-700">
        {parentBehind ? "Recovered loads are newer than this order view." : "Current loads could not be verified."} <button type="button" className="underline"
          onClick={() => void onRefresh().then(() => {
            // A parent read only reconciles mounted editors. Reauthorize a hidden/recovered
            // grid through its own ordinary read before making saved rows printable again.
            grid.recoveryNotice?.retryRead();
          }).catch(() => {})}>Refresh order before printing</button>
      </p>}
      {scannedLoad !== null && (
        <p role="status" className="mb-2 rounded bg-link-50 p-2 text-sm text-link-700">
          {loadNumber === null ? "Invalid load number in this link."
            : scanStatus === "loading" ? `Checking current Load ${scannedLoad}…`
            : scanStatus === "failed" ? "Could not refresh this load. Scan again to retry."
            : !savedLoad ? `Load ${scannedLoad} is no longer present on this order. Check the traveler.`
            : grid.dirty ? `Scanned Load ${scannedLoad}. Save or discard load edits to locate its saved row.`
            : !selectedId ? `Waiting for saved Load ${scannedLoad} in the editor…`
            : `Scanned Load ${scannedLoad} is highlighted below.`}
        </p>
      )}
      {/* Standing, read from order state (#41): a stored traveler describes the loads as they
          were at print time, so the operator must see this BEFORE editing, on every visit. No
          save answers a warning of its own. */}
      {travelerPrinted && (
        <p className={`${NOTICE.warning} mb-2`}>
          A traveler has already printed — changes to these loads will need a fresh traveler.
        </p>
      )}
      {grid.recoveryNotice && <DraftRecoveryNotice {...grid.recoveryNotice} />}
      {grid.orphanWarning && (
        <p className={`${NOTICE.warning} mb-2`}>{grid.orphanWarning}</p>
      )}
      {rows.length === 0 && <p className="mb-2 text-sm text-ink-500">None.</p>}
      <div className="overflow-x-auto">
      <table className="mb-2 w-full text-sm">
        <thead>
          <tr className="text-left">
            <th className="py-1 w-24">Load #</th><th className="w-32">Qty</th><th className="w-32">{NET_WEIGHT_LB}</th><th className="px-3 text-left">Traveler</th><th className="text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const saved = loads.find(load => load.id === row.key);
            const sameSaved = saved && !row.isNew && Object.entries(loadFields(saved)).every(([key, value]) => row[key as keyof Fields] === value);
            const printReason = !ready || scanStatus !== "ready" ? "Wait for the current saved loads before printing"
              : grid.dirty || row.isNew ? "Save or discard load changes before printing"
              : !sameSaved ? "Refresh order before printing the recovered loads" : undefined;
            return (
            <tr key={row.key} id={!row.isNew && row.key === selectedId ? `load-${loadNumber}` : undefined}
                aria-current={row.key === selectedId ? "true" : undefined}
                className={`border-t ${row.key === selectedId ? "bg-link-50 outline outline-2 outline-accent-600" : ""}`}>
              <td className="py-1">
                <input value={row.loadNumber} inputMode="numeric" disabled={!editGate.allowed || !grid.canEdit} title={editGate.title}
                       onChange={(e) => patch(row, "loadNumber", e.target.value)}
                       aria-label={`Load ${i + 1} number`} className={`${INPUT_COMPACT} w-16 disabled:bg-surface-50`} />
              </td>
              <td>
                <input value={row.qty} inputMode="numeric" disabled={!editGate.allowed || !grid.canEdit} title={editGate.title}
                       onChange={(e) => patch(row, "qty", e.target.value)}
                       aria-label={`Load ${i + 1} quantity`} className={`${INPUT_COMPACT} w-24 disabled:bg-surface-50`} />
              </td>
              <td>
                <input value={row.weight} inputMode="decimal" disabled={!editGate.allowed || !grid.canEdit} title={editGate.title}
                       onChange={(e) => patch(row, "weight", e.target.value)}
                       aria-label={`Load ${i + 1} weight`} className={`${INPUT_COMPACT} w-24 disabled:bg-surface-50`} />
              </td>
              <td className="px-3 py-2">
                <TravelerPrintButton loadNumber={saved?.loadNumber ?? null} disabledReason={printReason} />
              </td>
              <td className="text-right">
                <button aria-label={`Remove load ${i + 1}`} onClick={() => remove(row)} disabled={!editGate.allowed || !grid.canEdit} title={editGate.title}
                        className="text-xs text-red-600">
                  Remove
                </button>
              </td>
            </tr>
          ); })}
        </tbody>
      </table>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={addRow} disabled={!editGate.allowed || !grid.canEdit} title={editGate.title}
                className={`${LINK} text-sm`}>
          Add load
        </button>
        <button onClick={renumber} disabled={!editGate.allowed || !grid.canEdit} title={editGate.title}
                className="rounded border border-ink-900 px-3 py-1 text-sm text-ink-800">
          Renumber
        </button>
        {/* Re-split POSTS a freshly computed load set and then resets the grid, so a pending
            quantity, weight, addition or removal is replaced rather than saved — an in-page
            destruction with no click on a link and no unload, so no Shell guard sees it
            (Codex P1, round 7; the apply-panel-collapse shape). It asks first. */}
        <button onClick={() => void askResplit()}
                disabled={!editGate.allowed || !grid.canEdit} title={editGate.title}
                className="rounded border border-ink-900 px-3 py-1 text-sm text-ink-800">
          Re-split
        </button>
        <SaveButton label="Save loads" section="Loads" gate={gridGate(editGate, grid.mode)}
                    dirty={grid.dirty} onSave={save} onDiscard={() => { grid.discard(); onError(null); }} />
        {ready && !grid.dirty && <span className="text-sm text-ink-500">No unsaved load changes</span>}
      </div>
      <PanelMessage message={saveMessage} />
    </section>
  );
}
