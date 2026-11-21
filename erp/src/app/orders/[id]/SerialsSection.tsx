"use client";
import { useState } from "react";
import { api, ApiError } from "@/lib/fetcher";
import type { Gate } from "@/lib/permission-ui";
import { useBulkGrid } from "@/lib/bulk-grid";
import { DraftRecoveryNotice } from "@/components/DraftRecoveryNotice";
import { serialFields, projectSerials, orderBulkOptions, orderAckSnapshot, type OrderBulkSource } from "@/lib/order-bulk-recovery";
import { expandSerialRange } from "@/lib/serial-range";
import { findDuplicateSerials } from "../new/OrderLineCard";
import type { ApplyMutation, OrderLine, OrderMutationResult, OrderSerial } from "./page";
import { SaveButton } from "@/components/SaveButton";
import { gridGate } from "@/lib/shipment-gates";
import { serialsScope } from "@/lib/unsaved-guard";
import { newId } from "@/lib/client-id";
import { PanelMessage } from "@/components/PanelMessage";
import { gridAtRest, useMessageClearedAtRest } from "@/lib/grid-message";
import { CARD, INPUT_COMPACT, NOTICE } from "@/lib/ui-classes";

type Fields = { serial: string; description: string };

function lineLabel(line: OrderLine): string {
  return line.position === 1 ? "Lead" : `Line ${line.position}`;
}

/**
 * One line's serial grid — bulk-PUTs `replaceSerials`' whole per-line array (Task 5, spec §5a).
 * A separate component (not a loop of plain JSX inside SerialsSection) because each line needs
 * its OWN `useBulkGrid` instance — one per mounted instance, the standard "list of components"
 * shape, not a hook called conditionally inside a `.map()`.
 *
 * The serialization-required-but-empty warning is the live, LOCAL row count (`rows.length`), not
 * the server's last-saved `serials` prop — so typing a range in and seeing the warning clear
 * happens before the user even clicks Save, matching the entry page's identical live warning
 * (OrderLineCard.tsx) and the "the serialization warning heritage" carried onto this page
 * (task-14-brief.md).
 */
function LineSerialsEditor({
  recoverySource, orderId, line, serials, requiresSerials, editGate, applyMutation,
}: {
  recoverySource: OrderBulkSource;
  orderId: string;
  line: OrderLine;
  serials: OrderSerial[];
  requiresSerials: boolean;
  editGate: Gate;
  applyMutation: ApplyMutation;
}) {
  const grid = useBulkGrid(serials, serialFields, orderBulkOptions(recoverySource, orderId, "order-serials", "Serials", snapshot => projectSerials(snapshot, line.id), line.id, serialsScope(line.id)));
  const rows = grid.rows;
  const { rangeInput, setRangeInput } = grid;
  const [rangeError, setRangeError] = useState<string | null>(null);
  // This grid's own message (owner ruling R1, P6 step 5a): its validation, a refused save and a
  // failed one show under its Save row, one per line through the shared PanelMessage, the saved shipment page's
  // shape (#472). The setter keeps the name `onError` the section's calls and the tests that lift
  // them read. The message goes when this grid comes to rest (src/lib/grid-message.ts).
  const [saveMessage, onError] = useState<string | null>(null);
  useMessageClearedAtRest(gridAtRest(grid.dirty, grid.canEdit), onError);

  const dupes = findDuplicateSerials(rows.map((r) => ({ id: r.key, serial: r.serial, description: r.description })));

  function patch(row: { key: string; isNew: boolean }, field: keyof Fields, value: string) {
    if (row.isNew) grid.updateAdded(row.key, { [field]: value } as Partial<Fields>);
    else grid.updateExisting(row.key, { [field]: value } as Partial<Fields>);
  }
  function remove(row: { key: string; isNew: boolean }) {
    if (row.isNew) grid.removeAdded(row.key);
    else grid.removeExisting(row.key);
  }
  function addRange() {
    if (!rangeInput.trim()) return;
    try {
      const expanded = expandSerialRange(rangeInput);
      // ONE state update for the whole expansion (fix-wave R4 finding 7). `addRow` per serial
      // spread the entire added-rows array each time, so a legal `EC{1-10000}` cost ~50 million
      // element copies across 10,000 updates in a single keystroke's handler and froze the grid.
      grid.addRows(expanded.map((serial) => ({ serial, description: "" })), true);
      setRangeError(null);
    } catch (e) {
      // expandSerialRange throws a plain Error with a message already fit to show the user.
      setRangeError((e as Error).message);
    }
  }

  async function save() {
    if (dupes.size > 0) { onError(`${lineLabel(line)}: duplicate serial "${[...dupes][0]}".`); return; }
    const payload: { serial: string; description: string }[] = [];
    for (const [i, row] of rows.entries()) {
      const serial = row.serial.trim();
      if (!serial) { onError(`${lineLabel(line)}: serial ${i + 1} cannot be blank.`); return; }
      payload.push({ serial, description: row.description });
    }
    const binding = grid.binding;
    if (!binding || !grid.canEdit || !editGate.allowed) return;
    const submission = binding.capture(payload, newId());
    function projectSavedRows(response: OrderMutationResult) {
      return projectSerials(orderAckSnapshot(response, submission.submitted.baseline), line.id).baseline;
    }
    try {
      await applyMutation(async () => {
        if (!binding.dispatched(submission)) throw new Error("This draft is no longer available to save.");
        let response: OrderMutationResult;
        try {
          response = await api<OrderMutationResult>(
        `/api/orders/${orderId}/lines/${line.id}/serials`, { method: "PUT", body: JSON.stringify(payload) });
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

  function discard() {
    grid.discard();
    setRangeError(null);
    onError(null);
  }

  return (
    <div className="mb-4 rounded border p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">
          {lineLabel(line)} — <span className="font-mono">{line.part.customer.code} · {line.part.partNumber}</span>
        </span>
        {requiresSerials && rows.length === 0 && (
          <span className="rounded bg-accent-50 px-2 py-0.5 text-xs text-accent-600">
            Serialization required — no serials entered yet
          </span>
        )}
      </div>
      {grid.recoveryNotice && <DraftRecoveryNotice {...grid.recoveryNotice} discard={() => {
        grid.recoveryNotice?.discard(); setRangeError(null); onError(null);
      }} startFresh={() => {
        grid.recoveryNotice?.startFresh(); setRangeError(null); onError(null);
      }} />}
      {grid.orphanWarning && (
        <p className={`${NOTICE.warning} mb-2`}>{grid.orphanWarning}</p>
      )}
      <label className="mb-2 block text-sm">
        Add serial(s)
        <input value={rangeInput} disabled={!editGate.allowed || !grid.canEdit} title={editGate.title}
               onChange={(e) => setRangeInput(e.target.value)} onBlur={addRange}
               onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addRange(); } }}
               placeholder="EC001 or EC{001-025}" aria-label={`${lineLabel(line)} add serial`}
               className={`${INPUT_COMPACT} mt-1 w-full font-mono disabled:bg-surface-50`} />
      </label>
      {grid.mode === "editing" && rangeError && <p className="mb-2 text-xs text-red-700">{rangeError}</p>}
      {rows.length === 0 ? (
        <p className="mb-2 text-sm text-ink-500">No serials on this line.</p>
      ) : (
        <div className="mb-2 space-y-1">
          {rows.map((row, i) => (
            <div key={row.key}
                 className={`flex items-center gap-2 rounded border p-1 text-sm ${dupes.has(row.serial.trim()) ? "border-red-400 bg-red-50" : ""}`}>
              <input value={row.serial} disabled={!editGate.allowed || !grid.canEdit} title={editGate.title}
                     onChange={(e) => patch(row, "serial", e.target.value)}
                     aria-label={`${lineLabel(line)} serial ${i + 1}`}
                     className="w-32 rounded border px-1 py-0.5 font-mono text-xs disabled:bg-surface-50" />
              <input value={row.description} placeholder="Description" disabled={!editGate.allowed || !grid.canEdit} title={editGate.title}
                     onChange={(e) => patch(row, "description", e.target.value)}
                     aria-label={`${lineLabel(line)} serial ${i + 1} description`}
                     className="flex-1 rounded border px-1 py-0.5 text-xs disabled:bg-surface-50" />
              <button onClick={() => remove(row)} disabled={!editGate.allowed || !grid.canEdit} title={editGate.title}
                      aria-label={`Remove serial ${row.serial}`}
                      className="text-xs text-red-600">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {dupes.size > 0 && (
        <p className="mb-2 rounded bg-red-50 p-1.5 text-xs text-red-700">
          Duplicate serial{dupes.size > 1 ? "s" : ""}: {[...dupes].join(", ")}
        </p>
      )}
      {/* The scope is what lets LinesSection's Remove refuse on THIS line's serials and no others
          (#293). Every line's editor registers the same human label "Serials", so the label alone
          could never name one of them; relabelling per line would have scoped it and broken the
          traveler print gate, which matches labels by exact equality. */}
      <SaveButton label="Save serials" section="Serials" scope={serialsScope(line.id)} gate={gridGate(editGate, grid.mode)}
                    dirty={grid.dirty} alsoUnsaved={rangeInput !== ""}
                    onSave={save} onDiscard={discard} />
      <PanelMessage message={saveMessage} />
    </div>
  );
}

/** One sub-grid per order line (lead and every rider alike — serialization is a per-part-number
 *  concern, spec §3.1: "billing and certs stay per part number"). The serialization-required flag
 *  comes straight off `line.part.serializationRequired` (fix-wave R3 finding 6) rather than a
 *  separate parts-catalog lookup: a caller with `orders.view` but not `parts.view` still gets a
 *  correct warning, since order creation reports this requirement independently of catalog access
 *  and the order hub's own fetch of `OrderDetail` already carries it. */
export function SerialsSection({
  recoverySource, orderId, lines, serials, editGate, applyMutation,
}: {
  recoverySource: OrderBulkSource;
  orderId: string;
  lines: OrderLine[];
  serials: OrderSerial[];
  editGate: Gate;
  applyMutation: ApplyMutation;
}) {
  return (
    <section id="serials" data-order-section tabIndex={-1} className={`${CARD} mb-6`}>
      <h2 className="mb-2 font-medium">Serials</h2>
      {lines.map((line) => (
        <LineSerialsEditor recoverySource={recoverySource}
          key={line.id} orderId={orderId} line={line}
          serials={serials.filter((s) => s.lineId === line.id)}
          requiresSerials={line.part.serializationRequired}
          editGate={editGate} applyMutation={applyMutation}
        />
      ))}
    </section>
  );
}
