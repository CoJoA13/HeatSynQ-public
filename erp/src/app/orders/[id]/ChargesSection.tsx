"use client";
import { useState } from "react";
import { api, ApiError } from "@/lib/fetcher";
import type { Gate } from "@/lib/permission-ui";
import { useBulkGrid } from "@/lib/bulk-grid";
import { DraftRecoveryNotice } from "@/components/DraftRecoveryNotice";
import { chargeFields, projectCharges, orderBulkOptions, orderAckSnapshot, type OrderBulkSource } from "@/lib/order-bulk-recovery";
import type { ApplyMutation, OrderCharge, OrderMutationResult } from "./page";
import { SaveButton } from "@/components/SaveButton";
import { gridGate } from "@/lib/shipment-gates";
import { newId } from "@/lib/client-id";
import { decimalRefusal } from "@/lib/decimal-entry";
import { CHARGE_AMOUNT } from "@/lib/order-boxes";
import { PanelMessage } from "@/components/PanelMessage";
import { gridAtRest, useMessageClearedAtRest } from "@/lib/grid-message";
import { CARD, INPUT_COMPACT, LINK, NOTICE } from "@/lib/ui-classes";

type Fields = { description: string; amount: string };

/** Bulk-edit grid PUTting `replaceCharges`' whole array (Task 5, spec §6/§7.5.3 — a blank amount
 *  is a legitimate "needs price", not an error; Phase 5 prices and bills these). Same
 *  compose-with-server-state shape as ContainersSection — see src/lib/bulk-grid.ts. */
export function ChargesSection({
  recoverySource, orderId, charges, editGate, applyMutation,
}: {
  recoverySource: OrderBulkSource;
  orderId: string;
  charges: OrderCharge[];
  editGate: Gate;
  applyMutation: ApplyMutation;
}) {
  const grid = useBulkGrid(charges, chargeFields, orderBulkOptions(recoverySource, orderId, "order-charges", "Charges", projectCharges));
  const rows = grid.rows;
  // This grid's own message (owner ruling R1, P6 step 5a): its validation, a refused save and a
  // failed one show under its Save row through the shared PanelMessage, the saved shipment page's
  // shape (#472). The setter keeps the name `onError` the section's calls and the tests that lift
  // them read. The message goes when this grid comes to rest (src/lib/grid-message.ts).
  const [saveMessage, onError] = useState<string | null>(null);
  useMessageClearedAtRest(gridAtRest(grid.dirty, grid.canEdit), onError);

  function patch(row: { key: string; isNew: boolean }, field: keyof Fields, value: string) {
    if (row.isNew) grid.updateAdded(row.key, { [field]: value } as Partial<Fields>);
    else grid.updateExisting(row.key, { [field]: value } as Partial<Fields>);
  }
  function remove(row: { key: string; isNew: boolean }) {
    if (row.isNew) grid.removeAdded(row.key);
    else grid.removeExisting(row.key);
  }

  // tests/charges-section.test.tsx lifts `save` out of this file's source and runs it. If it reads a
  // new name from this component, that name goes into the test's environment in the same change.
  async function save() {
    const payload: { description: string; amount: string | null }[] = [];
    // Every row's refusals are collected and listed together; a request goes only when there is none.
    const refused: string[] = [];
    for (const [i, row] of rows.entries()) {
      const description = row.description.trim();
      if (!description) refused.push(`Charge ${i + 1}: enter a description.`);
      const amount = row.amount.trim();
      const amountRefusal = decimalRefusal(`Charge ${i + 1}, ${CHARGE_AMOUNT.label}`, amount, CHARGE_AMOUNT.box);
      if (amountRefusal) refused.push(amountRefusal);
      payload.push({ description, amount: amount === "" ? null : amount });
    }
    if (refused.length > 0) { onError(refused.join("\n")); return; }
    const binding = grid.binding;
    if (!binding || !grid.canEdit || !editGate.allowed) return;
    const submission = binding.capture(payload, newId());
    function projectSavedRows(response: OrderMutationResult) {
      return projectCharges(orderAckSnapshot(response, submission.submitted.baseline)).baseline;
    }
    try {
      await applyMutation(async () => {
        if (!binding.dispatched(submission)) throw new Error("This draft is no longer available to save.");
        let response: OrderMutationResult;
        try {
          response = await api<OrderMutationResult>(`/api/orders/${orderId}/charges`, {
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

  return (
    <section className={`${CARD} mb-6`}>
      <h2 className="mb-2 font-medium">Charges</h2>
      {grid.recoveryNotice && <DraftRecoveryNotice {...grid.recoveryNotice} />}
      {grid.orphanWarning && (
        <p className={`${NOTICE.warning} mb-2`}>{grid.orphanWarning}</p>
      )}
      {rows.length === 0 && <p className="mb-2 text-sm text-ink-500">None.</p>}
      {rows.map((row, i) => (
        <div key={row.key} className="mb-2 flex items-end gap-2 text-sm">
          <label className="block flex-1">
            Description
            <input value={row.description} disabled={!editGate.allowed || !grid.canEdit} title={editGate.title}
                   onChange={(e) => patch(row, "description", e.target.value)}
                   aria-label={`Charge ${i + 1} description`} className={`${INPUT_COMPACT} mt-1 w-full disabled:bg-surface-50`} />
          </label>
          <label className="block w-40">
            Amount
            <input value={row.amount} inputMode="decimal" placeholder="needs price" disabled={!editGate.allowed || !grid.canEdit} title={editGate.title}
                   onChange={(e) => patch(row, "amount", e.target.value)}
                   aria-label={`Charge ${i + 1} amount`} className={`${INPUT_COMPACT} mt-1 w-full disabled:bg-surface-50`} />
          </label>
          <button onClick={() => remove(row)} disabled={!editGate.allowed || !grid.canEdit} title={editGate.title}
                  className="text-xs text-red-600">
            Remove
          </button>
        </div>
      ))}
      <div className="mt-2 flex items-center gap-3">
        <button onClick={() => grid.addRow({ description: "", amount: "" })} disabled={!editGate.allowed || !grid.canEdit} title={editGate.title}
                className={`${LINK} text-sm`}>
          Add charge
        </button>
        <SaveButton label="Save charges" section="Charges" gate={gridGate(editGate, grid.mode)}
                    dirty={grid.dirty} onSave={save} onDiscard={() => { grid.discard(); onError(null); }} />
      </div>
      <PanelMessage message={saveMessage} />
    </section>
  );
}
