"use client";
import { useRef, useState } from "react";
import { api, ApiError } from "@/lib/fetcher";
import type { Gate } from "@/lib/permission-ui";
import { useBulkGrid, type ComposedRow } from "@/lib/bulk-grid";
import { DraftRecoveryNotice } from "@/components/DraftRecoveryNotice";
import {
  containerFields, projectContainers, orderBulkOptions, orderAckSnapshot, type ContainerFields, type OrderBulkSource,
} from "@/lib/order-bulk-recovery";
import { tareEachAfterTypeChange, typeDefaultTare } from "@/lib/container-tare-prefill";
import { decimalRefusal } from "@/lib/decimal-entry";
import { formatNumber } from "@/lib/format";
import { SCALE_GROSS, TARE_EACH } from "@/lib/order-boxes";
import { tareTotal } from "@/lib/net-weight";
import { TARE_EACH_LB, TARE_TOTAL_LB } from "@/lib/weight-terms";
import { orderTotals, savedOrderTotalsInput, type SavedTotalsLine } from "@/lib/order-totals";
import type { ApplyMutation, ContainerTypeOption, OrderContainer, OrderMutationResult } from "./page";
import { SaveButton } from "@/components/SaveButton";
import { gridGate } from "@/lib/shipment-gates";
import { OrderTotalsTable } from "@/components/OrderTotalsTable";
import { newId } from "@/lib/client-id";
import { PanelMessage } from "@/components/PanelMessage";
import { gridAtRest, useMessageClearedAtRest } from "@/lib/grid-message";
import { useUnsavedPresent } from "@/lib/use-unsaved-section";
import { useDraftIdentity } from "@/lib/use-recoverable-draft";
import { containerTagsGate, containerTagsHref, NOT_PRINTED_ON_A_TAG } from "@/lib/container-tags-gate";
import { CARD, INPUT_COMPACT, LINK, NOTICE } from "@/lib/ui-classes";
import { inMenuOrder } from "@/lib/menu-order";

type Row = ComposedRow<ContainerFields>;

function blankRow(): ContainerFields {
  return { typeId: "", count: "", pieces: "", tareEach: "", scaleGross: "", customerContainerId: "" };
}

/**
 * The saved order's Containers grid (the weights design §9.4). A row says how many containers it
 * holds, the pieces in all of them together, the weight of one empty container, and a scale gross
 * only when the row was weighed. Tare total is shown and never sent: `tareTotal` in
 * `src/lib/net-weight.ts` states it. What a change of type does to Tare each is decided in
 * `src/lib/container-tare-prefill.ts`, and is judged once for a whole visit to the Type list
 * (`typeVisit`, below). Nothing is filled when the grid loads: a stored blank shows blank (owner
 * ruling W4, 2026-10-09).
 *
 * A row is two rows of four cells below 1280 px and one row of eight from 1280 px up (owner ruling
 * of 2026-10-09 on the design's §9.9, point 6).
 *
 * Above the rows the section draws the order totals table (the weights design §10.2; owner ruling
 * P5 of 2026-10-09). `src/lib/order-totals.ts` decides every cell and sentence of it. It is handed
 * `lines`, the page's saved lines, and the rows this grid draws, so it follows a row as it is
 * typed. It is told the grid is unsaved by `grid.dirty`, the flag the Save button reads. Until the
 * grid has a baseline of its own it is handed the `containers` prop's saved rows (§10.7, point 7).
 * The same fallback serves the read `useBulkGrid` begins after this grid's own save, which leaves
 * the grid without a baseline until it lands. `save` settles the draft before the page has set the
 * order the save answered with, so the prop's rows can then be one commit behind: the rows from
 * before the save.
 * The lines are a prop and are not in this grid's recovery context: there, a line save would set
 * a Containers draft aside (`projectContainers`, src/lib/order-bulk-recovery.ts). Nothing reads
 * the table to refuse anything.
 *
 * Save PUTs the whole array to `replaceContainers`, which updates each row it is given an id for in
 * place, creates one sent without an id and deletes the rest (#493), so a kept row's id is stable
 * across a save and its shipment lines stay linked. A row id the order no longer holds refuses the
 * whole save, and the grid keeps its edits. `useBulkGrid`'s overlay is still cleared on success and
 * not carried forward: the read that follows the save is the baseline the rows are drawn from.
 *
 * Beside Save, Print tags (#743) downloads the order's container tags, one 4 in × 3 in tag per SAVED
 * row: a plain link to `GET /api/orders/[id]/container-tags`, the `ExportLink` shape, which renders
 * from server state, answers an attachment and stores nothing, so the page stays where it is, there
 * is no request here to track and no popup result to report (the Shell's click guard lets an `/api/`
 * link through, `shouldGuardNavigation`). When it is open and what closes it is `containerTagsGate` (src/lib/container-tags-gate.ts):
 * the traveler's rungs, then unsaved work in a section the tag prints from, then an order with no
 * saved row. Closed, it is a span with the gate's title, the `ExportLink` shape. It takes `viewGate`
 * (orders.view, the route's gate), never `editGate`: a viewer who cannot edit can print tags.
 */
export function ContainersSection({
  recoverySource, orderId, containers, lines, containerTypes, editGate, viewGate, voided, applyMutation,
}: {
  recoverySource: OrderBulkSource;
  orderId: string;
  containers: OrderContainer[];
  lines: readonly SavedTotalsLine[];
  containerTypes: ContainerTypeOption[];
  editGate: Gate;
  viewGate: Gate;
  voided: boolean;
  applyMutation: ApplyMutation;
}) {
  const grid = useBulkGrid(containers, containerFields, orderBulkOptions(recoverySource, orderId, "order-containers", "Containers", projectContainers));
  const rows = grid.rows;
  // This grid's own message (owner ruling R1, P6 step 5a): its validation, a refused save and a
  // failed one show under its Save row through the shared PanelMessage, the saved shipment page's
  // shape (#472). The setter keeps the name `onError` the section's calls and the tests that lift
  // them read. The message goes when this grid comes to rest (src/lib/grid-message.ts).
  const [saveMessage, onError] = useState<string | null>(null);
  useMessageClearedAtRest(gridAtRest(grid.dirty, grid.canEdit), onError);
  // What the totals table adds up. `baseline` is the baseline `useBulkGrid` draws this grid's rows
  // from (src/lib/bulk-grid.ts): the draft's while the view is editing, and the view's saved one
  // otherwise. While there is none the grid draws no row, and the table is handed the page's saved
  // rows (the weights design §10.7, point 7). tests/containers-section.test.tsx holds this line to
  // the hook's, arm by arm, by reading the grid's boxes and the table from one render.
  const baseline = grid.view.mode === "editing" ? grid.view.current?.baseline : grid.view.savedBaseline;
  const totalsRows = baseline ? rows : containers.map(containerFields);
  // One visit to a Type list: the row as it stood when that list took focus. A closed list fires a
  // change for every option a keyboard user passes with the arrow keys, so one correction can be
  // several changes. Owner ruling W3 means the type the row had before the operator's change, and
  // `changeType` reads it here. Judged one step at a time, a typed figure that equals the default
  // of a type only passed through would count as following that type, and the next step would
  // replace or clear it (the design's §9.10). One ref serves every row, because one list has focus
  // at a time. A ref and not state: it must outlive the render each step causes, and it draws
  // nothing.
  const typeVisit = useRef<{ key: string; typeId: string; tareEach: string } | null>(null);

  // tests/containers-section.test.tsx lifts `patch`, `startTypeVisit`, `endTypeVisit`, `changeType`
  // and `save` out of this file's source and runs them, because vitest has no DOM to fire a handler
  // in. Each stays a function declaration of its name. One that reads a new name from this
  // component gains that name in the test's environment in the same change.
  function patch(row: Row, fields: Partial<ContainerFields>) {
    if (row.isNew) grid.updateAdded(row.key, fields);
    else grid.updateExisting(row.key, fields);
  }
  /** The row's Type list took focus. Always a new visit, whatever the last one left: a control that
   *  is closed while it has the cursor may never be told it lost focus. */
  function startTypeVisit(row: Row) {
    typeVisit.current = { key: row.key, typeId: row.typeId, tareEach: row.tareEach };
  }
  /** The Type list lost focus. A later change is judged against the row as it then stands. */
  function endTypeVisit() {
    typeVisit.current = null;
  }
  /** One edit of the row: the type, and Tare each with it when the prefill rule gives a text. The
   *  weights design §9.4 has the two change together, so it is one change of the draft and never
   *  two. The rule answers null to leave the box alone and "" to clear it, and both are falsy: the
   *  test is `=== null`, never truthiness.
   *
   *  The rule is asked about the row as its Type list's visit found it, when the visit is this
   *  row's, and about the row as it stands otherwise. So however many types a visit passes, the
   *  box ends as one pick of the last type leaves it. An earlier step of the visit may already have
   *  written the box. When the rule then says to leave the box alone, the text it held at focus
   *  goes back. Nothing else can change the box during a visit: typing in it takes focus from the
   *  list. */
  function changeType(row: Row, next: string) {
    const visit = typeVisit.current;
    const from = visit !== null && visit.key === row.key ? visit : row;
    const tareEach = tareEachAfterTypeChange({
      current: from.tareEach,
      oldDefault: typeDefaultTare(containerTypes, from.typeId),
      newDefault: typeDefaultTare(containerTypes, next),
    });
    if (tareEach !== null) patch(row, { typeId: next, tareEach });
    else if (from.tareEach !== row.tareEach) patch(row, { typeId: next, tareEach: from.tareEach });
    else patch(row, { typeId: next });
  }
  function remove(row: Row) {
    if (row.isNew) grid.removeAdded(row.key);
    else grid.removeExisting(row.key);
  }

  async function save() {
    const payload: {
      id?: string; typeId: string; count: number; pieces: number | null;
      tareEach: string | null; scaleGross: string | null; customerContainerId: string;
    }[] = [];
    // Every row's refusals are collected, each row's checks in field order, and listed together in
    // the page's red line; a request goes only when there is none.
    const refused: string[] = [];
    for (const [i, row] of rows.entries()) {
      const label = `Container ${i + 1}`;
      if (!row.typeId) refused.push(`${label}: pick a type.`);
      const count = Number(row.count);
      if (!Number.isInteger(count) || count < 1) refused.push(`${label}: Containers must be a whole number of at least 1.`);
      let pieces: number | null = null;
      if (row.pieces.trim() !== "") {
        pieces = Number(row.pieces);
        if (!Number.isInteger(pieces) || pieces < 1) refused.push(`${label}: Pieces must be a whole number of at least 1.`);
      }
      const tareEach = row.tareEach.trim();
      const tareRefusal = decimalRefusal(`${label}, ${TARE_EACH.label}`, tareEach, TARE_EACH.box);
      if (tareRefusal) refused.push(tareRefusal);
      const scaleGross = row.scaleGross.trim();
      const scaleRefusal = decimalRefusal(`${label}, ${SCALE_GROSS.label}`, scaleGross, SCALE_GROSS.box);
      if (scaleRefusal) refused.push(scaleRefusal);
      // A kept row names itself by its server id (`row.key`, which `composeRows` sets to the saved
      // row's id) so the server updates it in place; an added row sends none and is created (#493).
      payload.push({
        ...(row.isNew ? {} : { id: row.key }),
        typeId: row.typeId, count, pieces,
        tareEach: tareEach === "" ? null : tareEach, scaleGross: scaleGross === "" ? null : scaleGross,
        customerContainerId: row.customerContainerId,
      });
    }
    if (refused.length > 0) { onError(refused.join("\n")); return; }
    const binding = grid.binding;
    if (!binding || !grid.canEdit || !editGate.allowed) return;
    const submission = binding.capture(payload, newId());
    function projectSavedRows(response: OrderMutationResult) {
      return projectContainers(orderAckSnapshot(response, submission.submitted.baseline)).baseline;
    }
    try {
      await applyMutation(async () => {
        if (!binding.dispatched(submission)) throw new Error("This draft is no longer available to save.");
        let response: OrderMutationResult;
        try {
          response = await api<OrderMutationResult>(`/api/orders/${orderId}/containers`, {
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
    <section id="containers" data-order-section tabIndex={-1} className={`${CARD} mb-6`}>
      <h2 className="mb-2 font-medium">Containers</h2>
      <OrderTotalsTable totals={orderTotals(savedOrderTotalsInput(lines, totalsRows))} unsaved={grid.dirty} />
      {grid.recoveryNotice && <DraftRecoveryNotice {...grid.recoveryNotice} />}
      {grid.orphanWarning && (
        <p className={`${NOTICE.warning} mb-2`}>{grid.orphanWarning}</p>
      )}
      {rows.length === 0 && <p className="mb-2 text-sm text-ink-500">None.</p>}
      {rows.map((row, i) => (
        <div key={row.key} className="mb-4 grid grid-cols-4 items-end gap-2 text-sm xl:mb-2 xl:grid-cols-8">
          <label className="block">
            Type
            <select value={row.typeId} disabled={!editGate.allowed || !grid.canEdit} title={editGate.title}
                    onFocus={() => startTypeVisit(row)} onBlur={endTypeVisit}
                    onChange={(e) => changeType(row, e.target.value)}
                    aria-label={`Container ${i + 1} type`}
                    className={`${INPUT_COMPACT} mt-1 w-full disabled:bg-surface-50`}>
              <option value="">— choose —</option>
              {inMenuOrder(containerTypes, (r) => r.name).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label className="block">
            Containers
            <input value={row.count} inputMode="numeric" disabled={!editGate.allowed || !grid.canEdit} title={editGate.title}
                   onChange={(e) => patch(row, { count: e.target.value })}
                   aria-label={`Container ${i + 1} count`} className={`${INPUT_COMPACT} mt-1 w-full disabled:bg-surface-50`} />
          </label>
          <label className="block">
            Pieces (total)
            <input value={row.pieces} inputMode="numeric" disabled={!editGate.allowed || !grid.canEdit} title={editGate.title}
                   onChange={(e) => patch(row, { pieces: e.target.value })}
                   aria-label={`Container ${i + 1} pieces`} className={`${INPUT_COMPACT} mt-1 w-full disabled:bg-surface-50`} />
          </label>
          <label className="block">
            {TARE_EACH_LB}
            <input value={row.tareEach} inputMode="decimal" disabled={!editGate.allowed || !grid.canEdit} title={editGate.title}
                   onChange={(e) => patch(row, { tareEach: e.target.value })}
                   aria-label={`Container ${i + 1} tare each`} className={`${INPUT_COMPACT} mt-1 w-full disabled:bg-surface-50`} />
          </label>
          <div>
            {TARE_TOTAL_LB}
            <p className="mt-1 rounded border bg-surface-50 px-2 py-1">{formatNumber(tareTotal({ count: row.count, tareEach: row.tareEach }), 2)}</p>
          </div>
          <label className="block">
            Scale gross (lb)
            <input value={row.scaleGross} inputMode="decimal" disabled={!editGate.allowed || !grid.canEdit} title={editGate.title}
                   onChange={(e) => patch(row, { scaleGross: e.target.value })}
                   aria-label={`Container ${i + 1} scale gross`} className={`${INPUT_COMPACT} mt-1 w-full disabled:bg-surface-50`} />
          </label>
          <label className="block">
            Cust Cont Id
            <input value={row.customerContainerId} disabled={!editGate.allowed || !grid.canEdit} title={editGate.title}
                   onChange={(e) => patch(row, { customerContainerId: e.target.value })}
                   aria-label={`Container ${i + 1} customer container id`} className={`${INPUT_COMPACT} mt-1 w-full disabled:bg-surface-50`} />
          </label>
          <div className="flex items-center justify-end">
            <button onClick={() => remove(row)} disabled={!editGate.allowed || !grid.canEdit} title={editGate.title}
                    className="text-xs text-red-600">
              Remove
            </button>
          </div>
        </div>
      ))}
      <div className="mt-2 flex items-center gap-3">
        <button onClick={() => grid.addRow(blankRow())} disabled={!editGate.allowed || !grid.canEdit} title={editGate.title}
                className={`${LINK} text-sm`}>
          Add container
        </button>
        <SaveButton label="Save containers" section="Containers" gate={gridGate(editGate, grid.mode)}
                    dirty={grid.dirty} onSave={save} onDiscard={() => { grid.discard(); onError(null); }} />
        <PrintTagsLink orderId={orderId} rows={containers.length} viewGate={viewGate} voided={voided} />
      </div>
      <PanelMessage message={saveMessage} />
    </section>
  );
}

/** Print tags (#743): see `ContainersSection`'s docblock. `rows` is the page's SAVED rows, which are
 *  what the route prints; the grid's own unsaved rows close the link through the unsaved rung. The
 *  browser-store hook binds in a passive effect, so its first null snapshot is unknown, not clean. */
function PrintTagsLink({ orderId, rows, viewGate, voided }: { orderId: string; rows: number; viewGate: Gate; voided: boolean }) {
  const unsaved = useUnsavedPresent(NOT_PRINTED_ON_A_TAG);
  const { store, ...drafts } = useDraftIdentity();
  const tagsGate = containerTagsGate({
    voided, viewGate, draftsReady: store !== null && drafts.identityReady, unsaved, rows,
  });
  if (!tagsGate.allowed) {
    return (
      <span aria-disabled="true" title={tagsGate.title} className="cursor-not-allowed text-sm text-ink-500 underline">
        Print tags
      </span>
    );
  }
  return (
    <a href={containerTagsHref(orderId)} className={`${LINK} text-sm`}>
      Print tags
    </a>
  );
}
