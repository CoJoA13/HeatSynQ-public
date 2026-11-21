"use client";
import { formatNumber } from "@/lib/format";
// One panel per `ShipperOrderDetail` (design spec §11), headed with its label (`92036-3`) and
// carrying the three grids task-14-brief.md calls out as this phase's largest sibling group:
// lines, containers, serials. The grid MARKUP and candidate-prefill arithmetic live in ONE shared
// copy for the whole group — ../ShipmentGrids.tsx, shared with the create page (`/shipping/new`,
// Task 14b) — so the sibling-split rule (CLAUDE.md: "any fix to one grid lands on all copies in
// the same commit") holds by construction across BOTH pages. What stays here is persistence,
// which is this page's own: each grid is `useBulkGrid` (src/lib/bulk-grid.ts) over the rows
// already on THIS shipper order (`so.lines`/`so.containers`/`so.serials`), with an "Add" picker
// sourced from the order's OWN freshly authorized catalog — the ContainersSection/SerialsSection precedent (src/app/orders/[id]/),
// not an auto-seed-everything mutation chain: nothing is written to the server until the operator
// clicks Save, exactly like every other bulk grid in this codebase.
import { useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/fetcher";
import type { Gate } from "@/lib/permission-ui";
import { useBulkGrid } from "@/lib/bulk-grid";
import {
  LinesGridView, ContainersGridView, SerialsGridView,
  type GridRowHandle, type LineFields, type ContainerFields, type SerialFields,
  type LineInfo, type ContainerInfo, type KeptContainerInfo, type SerialInfo,
} from "../ShipmentGrids";
import type { ApplyMutation, ShipperOrder, ShipperMutationResult } from "./ShipmentDetail";
import { DraftRecoveryNotice } from "@/components/DraftRecoveryNotice";
import { shipmentBulkOptions, shipmentLineFields, shipmentContainerFields, shipmentSerialFields, shipmentDisplayFromBaseline, type ShipmentBulkSource } from "@/lib/shipment-bulk-recovery";
import { SaveButton } from "@/components/SaveButton";
import { shipmentOrderScope } from "@/lib/unsaved-guard";
import { useUnsavedInScope } from "@/lib/use-unsaved-section";
import { gridGate, pickerEmptyReason, removeOrderGate, savingGate } from "@/lib/shipment-gates";
import { gridAtRest, useMessageClearedAtRest } from "@/lib/grid-message";
import { newId } from "@/lib/client-id";
import { shipmentLinesPayload, lineLedgerFromBaseline, settledLinesBaseline } from "@/lib/shipment-line-save";
import { keptFirst, shipmentContainersPayload, settledContainersBaseline } from "@/lib/shipment-container-rows";
import { ShipmentTotalsTable } from "@/components/ShipmentTotalsTable";
import { containersReport, linesReport, type ReportTotals, type TotalsTableView } from "@/lib/shipment-totals";
import { useTotalsReport } from "@/lib/use-totals-report";

/** Read-only strip for RELEASED lines and serials (snapshot + release, ruling 23): the order-side
 *  row was corrected away, so these render from their snapshots and stay out of the editable grid
 *  and its payload. Released containers are not drawn here: they are rows of the Containers grid. */
function ReleasedRows({ label, rows }: { label: string; rows: string[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="mb-1 rounded border border-dashed bg-surface-50 px-2 py-1 text-xs text-ink-500">
      {label} kept from earlier selections (the order-side rows were since corrected away):{" "}
      {rows.join("; ")}
    </div>
  );
}

/** One message slot of an order panel (issue #472, owner ruling R-Q3: an order panel's refusals show
 *  in that panel). Each grid shows its own under its Save row, and the heading shows Remove
 *  order's. Nothing written here reaches the banner at the top of the page. A save the page's own
 *  check refuses lists every refusal, one per line, so the message keeps its line breaks. */
// The panel message is the app's shared one since #649 (ruling R1): lifted to src/components and
// re-exported here under its name, so this page's two call sites and the tests that import it from
// here are unchanged.
import { PanelMessage } from "@/components/PanelMessage";
import { BUTTON_NEUTRAL_COMPACT, CARD, LINK } from "@/lib/ui-classes";
export { PanelMessage };

// -------------------------------------------------------------------------------------------
// Lines grid — `useBulkGrid` over the shipment's saved lines, saved through the bulk PUT.
// -------------------------------------------------------------------------------------------

function LinesGrid({
  shipperId, shipperOrderId, lines, recoverySource, editGate, saveGate, creditHoldReason, applyMutation, onTotalsReport,
}: {
  shipperId: string; shipperOrderId: string; lines: ShipperOrder["lines"];
  /** The page's lines gate: the edit gate, closed as well for a held customer without the override
   *  (§5.4 extended to line replacement, owner ruling 2026-08-06) and under a finalized invoice. */
  recoverySource: ShipmentBulkSource; editGate: Gate;
  /** The gate for Save lines alone: `editGate`, closed as well while a required override reason is
   *  blank (#472). The grid's boxes stay on `editGate`, and `save` still tests `editGate`. */
  saveGate: Gate;
  /** Non-empty exactly when a held customer's save should carry the override reason. */
  creditHoldReason: string;
  applyMutation: ApplyMutation;
  /** Where this grid hands up what the totals tables add up of it (`useTotalsReport`, below). */
  onTotalsReport: ReportTotals;
}) {
  // This grid's own message (issue #472, owner ruling R-Q3): its validation, a refused save and
  // "This draft is no longer available to save." show under its own Save row, and its own successful
  // save and its own Discard clear them. So does the grid coming to rest by any other route (the
  // hook call under `grid`, below). The setter keeps the name `onError` on purpose: `save` and
  // the Discard callback below already report through that name, and
  // tests/remaining-bulk-callbacks.test.ts runs `save` with exactly that free name.
  const [saveMessage, onError] = useState<string | null>(null);
  const liveLines = lines.filter((l): l is typeof l & { orderLineId: string } => l.orderLineId !== null);
  const releasedLines = lines.filter((l) => l.orderLineId === null);
  const grid = useBulkGrid(liveLines, shipmentLineFields, shipmentBulkOptions(recoverySource, shipperId, shipperOrderId, "lines"));
  // The message also goes when this grid has no unsaved edits left, by whatever route: the saved
  // value typed back, an added row removed again, a recovery notice answered with nothing kept
  // (the controller's ruling of 2026-10-08; grid-message.ts). Never while the grid is still
  // unsaved, so a refused save keeps its refusal. Each of the three grids asks about itself.
  useMessageClearedAtRest(gridAtRest(grid.dirty, grid.canEdit), onError);
  const baseline = grid.view.mode === "editing" ? grid.view.current?.baseline : grid.view.savedBaseline;
  const catalog = shipmentDisplayFromBaseline(baseline);
  const recoveryGate: Gate = gridGate(editGate, grid.mode);
  // R23 (#702): the grid's inputs close while its own Save is in transport; its Save keeps `recoveryGate`.
  const inputGate: Gate = savingGate(recoveryGate, grid.saving);
  const rows = grid.rows;
  // What the totals tables add up of this grid, handed to the page (the weights design §12.2): the
  // kept lines' saved weights, then each row's weight box as typed, and whether this grid has
  // unsaved edits. `linesReport` answers null until this grid has a baseline, and the page's saved
  // lines then stand in. A statement of the component itself: tests/shipment-totals-wiring.test.ts
  // reads it from this function's own body.
  useTotalsReport(onTotalsReport, shipperOrderId, { part: "lines", value: linesReport(baseline !== undefined, releasedLines, rows, grid.dirty) });
  const usedLineIds = new Set(rows.map((r) => r.orderLineId));
  const candidates = baseline?.context.catalogAuthorized === true ? catalog.lines.filter((c) => !usedLineIds.has(c.id)) : [];

  // Names and ordered figures come from this accepted shipping projection.
  // Only a separately authorized full catalog can supply Add choices.
  const infoByLineId = new Map<string, LineInfo>();
  for (const c of catalog.lines) {
    infoByLineId.set(c.id, { partNumber: c.partNumber, partName: c.partName, orderedQty: c.qty, orderedWeight: c.weight, eachWeight: c.eachWeight ?? null });
  }
  // "Shipped to date" and THIS shipment's saved quantity both come from this one accepted baseline
  // (`lineLedgerFromBaseline`), and a save settles rows and ledger together (`settledLinesBaseline`),
  // so the completion figures agree after a save without waiting for a catalog read.
  const { shippedByLineId, savedQtyByLineId } = lineLedgerFromBaseline(baseline);

  function patch(row: GridRowHandle, field: keyof LineFields, value: string) {
    if (row.isNew) grid.updateAdded(row.key, { [field]: value } as Partial<LineFields>);
    else grid.updateExisting(row.key, { [field]: value } as Partial<LineFields>);
  }
  function remove(row: GridRowHandle) {
    if (row.isNew) grid.removeAdded(row.key);
    else grid.removeExisting(row.key);
  }

  async function save() {
    const built = shipmentLinesPayload(rows, infoByLineId, shippedByLineId, savedQtyByLineId);
    if (!built.ok) { onError(built.error); return; }
    const payload = built.payload;
    const binding = grid.binding;
    if (!binding || !grid.canEdit || !editGate.allowed) return;
    const submission = binding.capture(creditHoldReason ? { lines: payload, creditHoldReason } : payload, newId());
    try {
      await applyMutation(async () => {
        if (!binding.dispatched(submission)) throw new Error("This draft is no longer available to save.");
        let response: ShipperMutationResult;
        try {
          response = await api<ShipperMutationResult>(`/api/shippers/${shipperId}/orders/${shipperOrderId}/lines`,
            { method: "PUT", body: JSON.stringify(submission.payload) });
        } catch (error) {
          binding.settle(submission, { kind: error instanceof ApiError && error.status >= 400 && error.status < 500 ? "rejected" : "unknown" });
          throw error;
        }
        const savedOrder = response.shipper.orders.find(order => order.id === shipperOrderId);
        binding.settle(submission, { kind: "persisted", response: settledLinesBaseline(submission.submitted.baseline, savedOrder) });
        return response;
      });
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (<>
    {grid.recoveryNotice && <DraftRecoveryNotice {...grid.recoveryNotice} />}
    <ReleasedRows label="Lines"
      rows={releasedLines.map((l) => `${l.partNumber} · ${formatNumber(l.qty)} pcs / ${formatNumber(l.weight, 2)} lb`)} />
    <LinesGridView rows={rows} candidates={candidates} infoByLineId={infoByLineId} shippedByLineId={shippedByLineId} savedQtyByLineId={savedQtyByLineId}
                   gate={inputGate} orphanWarning={grid.orphanWarning} emptyReason={pickerEmptyReason(baseline?.context, grid.mode)}
                   onPatch={patch} onRemove={remove} onAddRows={(rs) => grid.addRows(rs)}
                   footer={<SaveButton label="Save lines" section="Lines" scope={shipmentOrderScope(shipperOrderId)} gate={gridGate(saveGate, grid.mode)} dirty={grid.dirty} onSave={save} onDiscard={() => { grid.discard(); onError(null); }} />} />
    <PanelMessage message={saveMessage} />
  </>);
}

// -------------------------------------------------------------------------------------------
// Containers grid.
// -------------------------------------------------------------------------------------------

function ContainersGrid({
  shipperId, shipperOrderId, containers, recoverySource, editGate, applyMutation, onTotalsReport,
}: {
  shipperId: string; shipperOrderId: string; containers: ShipperOrder["containers"];
  recoverySource: ShipmentBulkSource; editGate: Gate; applyMutation: ApplyMutation;
  /** See LinesGrid. */
  onTotalsReport: ReportTotals;
}) {
  // This grid's own message. See LinesGrid for why the setter is named `onError`.
  const [saveMessage, onError] = useState<string | null>(null);
  const grid = useBulkGrid(keptFirst(containers), shipmentContainerFields, shipmentBulkOptions(recoverySource, shipperId, shipperOrderId, "containers"));
  // See LinesGrid: this grid's message goes when this grid comes to rest.
  useMessageClearedAtRest(gridAtRest(grid.dirty, grid.canEdit), onError);
  const baseline = grid.view.mode === "editing" ? grid.view.current?.baseline : grid.view.savedBaseline;
  const catalog = shipmentDisplayFromBaseline(baseline);
  const recoveryGate: Gate = gridGate(editGate, grid.mode);
  // R23 (#702): the grid's inputs close while its own Save is in transport; its Save keeps `recoveryGate`.
  const inputGate: Gate = savingGate(recoveryGate, grid.saving);
  const rows = grid.rows;
  // See LinesGrid. This grid hands up its rows as typed, kept rows among them, and its own unsaved flag.
  useTotalsReport(onTotalsReport, shipperOrderId, { part: "containers", value: containersReport(baseline !== undefined, rows, grid.dirty) });
  const usedIds = new Set(rows.map((r) => r.orderContainerId));
  const candidates = baseline?.context.catalogAuthorized === true ? catalog.containers.filter((c) => !usedIds.has(c.id)) : [];

  const infoById = new Map<string, ContainerInfo>();
  for (const c of catalog?.containers ?? []) {
    infoById.set(c.id, { typeName: c.typeName, customerContainerId: c.customerContainerId });
  }
  // A kept row is drawn from the shipment row's own data, which the baseline carries by the row's id.
  const keptByKey = new Map<string, KeptContainerInfo>();
  for (const k of catalog.kept) keptByKey.set(k.id, { typeName: k.typeName, customerContainerId: k.customerContainerId, count: k.count });

  function patch(row: GridRowHandle, field: keyof ContainerFields, value: string) {
    if (row.isNew) grid.updateAdded(row.key, { [field]: value } as Partial<ContainerFields>);
    else grid.updateExisting(row.key, { [field]: value } as Partial<ContainerFields>);
  }
  function remove(row: GridRowHandle) {
    if (row.isNew) grid.removeAdded(row.key);
    else grid.removeExisting(row.key);
  }

  // The body and its refusals are `shipmentContainersPayload`'s, and the baseline a save settles to
  // is `settledContainersBaseline`'s (both in src/lib/shipment-container-rows.ts).
  // tests/remaining-bulk-callbacks.test.ts runs this function by its free names, those two among them.
  async function save() {
    const built = shipmentContainersPayload(rows);
    if (!built.ok) { onError(built.error); return; }
    const binding = grid.binding;
    if (!binding || !grid.canEdit || !editGate.allowed) return;
    const submission = binding.capture(built.payload, newId());
    try {
      await applyMutation(async () => {
        if (!binding.dispatched(submission)) throw new Error("This draft is no longer available to save.");
        let response: ShipperMutationResult;
        try {
          response = await api<ShipperMutationResult>(`/api/shippers/${shipperId}/orders/${shipperOrderId}/containers`,
            { method: "PUT", body: JSON.stringify(submission.payload) });
        } catch (error) {
          binding.settle(submission, { kind: error instanceof ApiError && error.status >= 400 && error.status < 500 ? "rejected" : "unknown" });
          throw error;
        }
        const savedOrder = response.shipper.orders.find(order => order.id === shipperOrderId);
        binding.settle(submission, { kind: "persisted", response: settledContainersBaseline(submission.submitted.baseline, savedOrder) });
        return response;
      });
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (<>
    {grid.recoveryNotice && <DraftRecoveryNotice {...grid.recoveryNotice} />}
    <ContainersGridView rows={rows} candidates={candidates} infoById={infoById} keptByKey={keptByKey}
                        gate={inputGate} orphanWarning={grid.orphanWarning} emptyReason={pickerEmptyReason(baseline?.context, grid.mode)}
                        orderHasNone={baseline?.context.catalogAuthorized === true && catalog.containers.length === 0}
                        onPatch={patch} onRemove={remove} onAddRows={(rs) => grid.addRows(rs)}
                        footer={<SaveButton label="Save containers" section="Containers" scope={shipmentOrderScope(shipperOrderId)} gate={recoveryGate} dirty={grid.dirty} onSave={save} onDiscard={() => { grid.discard(); onError(null); }} />} />
    <PanelMessage message={saveMessage} />
  </>);
}

// -------------------------------------------------------------------------------------------
// Serials grid.
// -------------------------------------------------------------------------------------------

function SerialsGrid({
  shipperId, shipperOrderId, serials, recoverySource, editGate, applyMutation,
}: {
  shipperId: string; shipperOrderId: string; serials: ShipperOrder["serials"];
  recoverySource: ShipmentBulkSource; editGate: Gate; applyMutation: ApplyMutation;
}) {
  // This grid's own message. See LinesGrid for why the setter is named `onError`.
  const [saveMessage, onError] = useState<string | null>(null);
  const liveSerials = serials.filter((sr): sr is typeof sr & { orderSerialId: string } => sr.orderSerialId !== null);
  const releasedSerials = serials.filter((sr) => sr.orderSerialId === null);
  const grid = useBulkGrid(liveSerials, shipmentSerialFields, shipmentBulkOptions(recoverySource, shipperId, shipperOrderId, "serials"));
  // See LinesGrid: this grid's message goes when this grid comes to rest.
  useMessageClearedAtRest(gridAtRest(grid.dirty, grid.canEdit), onError);
  const baseline = grid.view.mode === "editing" ? grid.view.current?.baseline : grid.view.savedBaseline;
  const catalog = shipmentDisplayFromBaseline(baseline);
  const recoveryGate: Gate = gridGate(editGate, grid.mode);
  // R23 (#702): the grid's inputs close while its own Save is in transport; its Save keeps `recoveryGate`.
  const inputGate: Gate = savingGate(recoveryGate, grid.saving);
  const rows = grid.rows;
  const usedIds = new Set(rows.map((r) => r.orderSerialId));
  const candidates = baseline?.context.catalogAuthorized === true ? catalog.serials.filter((s) => !usedIds.has(s.id)) : [];

  const infoById = new Map<string, SerialInfo>();
  for (const s of catalog?.serials ?? []) infoById.set(s.id, { serial: s.serial, description: s.description });

  function patch(row: GridRowHandle, field: keyof SerialFields, value: string) {
    if (row.isNew) grid.updateAdded(row.key, { [field]: value } as Partial<SerialFields>);
    else grid.updateExisting(row.key, { [field]: value } as Partial<SerialFields>);
  }
  function remove(row: GridRowHandle) {
    if (row.isNew) grid.removeAdded(row.key);
    else grid.removeExisting(row.key);
  }

  async function save() {
    const payload = rows.map((row) => ({ orderSerialId: row.orderSerialId, printOnShipper: row.printOnShipper === "true" }));
    const binding = grid.binding;
    if (!binding || !grid.canEdit || !editGate.allowed) return;
    const submission = binding.capture(payload, newId());
    try {
      await applyMutation(async () => {
        if (!binding.dispatched(submission)) throw new Error("This draft is no longer available to save.");
        let response: ShipperMutationResult;
        try {
          response = await api<ShipperMutationResult>(`/api/shippers/${shipperId}/orders/${shipperOrderId}/serials`,
            { method: "PUT", body: JSON.stringify(submission.payload) });
        } catch (error) {
          binding.settle(submission, { kind: error instanceof ApiError && error.status >= 400 && error.status < 500 ? "rejected" : "unknown" });
          throw error;
        }
        const saved = response.shipper.orders.find(order => order.id === shipperOrderId)?.serials ?? [];
        binding.settle(submission, { kind: "persisted", response: { ...submission.submitted.baseline,
          rows: saved.filter(row => row.orderSerialId !== null).map(row => ({ id: row.id, fields: shipmentSerialFields(row) })),
        } });
        return response;
      });
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (<>
    {grid.recoveryNotice && <DraftRecoveryNotice {...grid.recoveryNotice} />}
    <ReleasedRows label="Serials"
      rows={releasedSerials.map((sr) => `${sr.serial}${sr.description ? ` — ${sr.description}` : ""}`)} />
    <SerialsGridView rows={rows} candidates={candidates} infoById={infoById}
                     gate={inputGate} orphanWarning={grid.orphanWarning} emptyReason={pickerEmptyReason(baseline?.context, grid.mode)}
                     orderHasNone={baseline?.context.catalogAuthorized === true && catalog.serials.length === 0}
                     onPatch={patch} onRemove={remove} onAddRows={(rs) => grid.addRows(rs)}
                     footer={<SaveButton label="Save serials" section="Serials" scope={shipmentOrderScope(shipperOrderId)} gate={recoveryGate} dirty={grid.dirty} onSave={save} onDiscard={() => { grid.discard(); onError(null); }} />} />
    <PanelMessage message={saveMessage} />
  </>
  );
}

/** The Remove order control (#472). Split out, the `ReverseShipmentButton` precedent, so its gate
 *  is pinned down to the rendered `disabled` and `title` attributes by a static-markup test
 *  (tests/shipment-remove-control.test.tsx). The gate is `removeOrderGate`'s: the page's edit
 *  gate, then the server's own refusal as the page last read it, then this order's unsaved grids. */
export function RemoveOrderButton({ gate, onClick }: { gate: Gate; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={gate.disabled} title={gate.title}
            className="text-xs text-red-600">
      Remove order
    </button>
  );
}

// -------------------------------------------------------------------------------------------
// The panel itself.
// -------------------------------------------------------------------------------------------

export function ShipmentOrderPanel({
  shipperId, order, recoverySource, editGate, linesGate, linesSaveGate, creditHoldReason, applyMutation, onRemove,
  removeRefusal, printGate, printing, certsGate, onPrintTicket, totals, onTotalsReport,
}: {
  shipperId: string; order: ShipperOrder; recoverySource: ShipmentBulkSource;
  editGate: Gate;
  /** The page's lines gate for the Lines grid: `editGate`, closed as well when the customer is on
   *  credit hold and the viewer lacks override_credit_hold (§5.4 extension ruling, 2026-08-06), and
   *  under a finalized invoice (#472). */
  linesGate: Gate;
  /** The gate for each Save lines button, when it differs from `linesGate`: the page closes it as
   *  well while a required credit-hold override reason is blank (#472). `linesGate` when absent. */
  linesSaveGate?: Gate;
  /** Raw contextual override reason to ride line saves for a held customer ("" otherwise). */
  creditHoldReason: string;
  applyMutation: ApplyMutation;
  /** Remove order. The page's `removeOrder` reports a refusal, or `null` once the removal has gone
   *  through, to the reporter it is handed: this panel's own heading message. */
  onRemove: (report: (message: string | null) => void) => void;
  /** What the server would answer a removal of this order with, as the page last read it
   *  (`removeOrderRefusal`); null or absent when it would accept. A snapshot: the click-time check
   *  in ShipmentDetail's `removeOrder` and the server's own refusal still decide. */
  removeRefusal?: string | null;
  /** Ticket printing went live with Task 18 — the gate, the shared in-flight flag and the POST
   *  itself all live on ShipmentDetail (one print pipeline for the whole page). Task 19 added
   *  the cert checkbox (§3.14): `onPrintTicket(certWanted)` carries this panel's own box, and
   *  `certsGate` (certs.view) gates it with a truthful §5.16 tooltip. */
  printGate: Gate; printing: boolean; certsGate: Gate; onPrintTicket: (certWanted: boolean) => void;
  /** This order's totals table, as the page worked it out (`shipmentTotals`). The panel draws it and
   *  reads nothing of it. */
  totals: TotalsTableView;
  /** The page's reporter, for this order's Lines and Containers grids. */
  onTotalsReport: ReportTotals;
}) {
  const [withCert, setWithCert] = useState(true);   // pre-ticked (§3.14)
  const [removeMessage, setRemoveMessage] = useState<string | null>(null);
  // R-Q1 (#472): this order's three grids register under one scope (their SaveButtons below), and
  // a retained draft carries the same scope in the draft store. The hook answers for both, live.
  const gridsUnsaved = useUnsavedInScope(shipmentOrderScope(order.id));
  const removeGate = removeOrderGate(editGate, removeRefusal ?? null, gridsUnsaved, order.label);
  return (
    <section className={`${CARD} mb-6`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-semibold">
          <Link href={`/orders/${order.orderId}`} className={LINK}>{order.label}</Link>
          {order.poNumber && <span className="ml-2 text-sm font-normal text-ink-500">PO {order.poNumber}</span>}
          {order.customerJobNo && <span className="ml-2 text-sm font-normal text-ink-500">Job {order.customerJobNo}</span>}
        </h3>
        {/* A refused removal shows here, under the button, and not at the top of the page
            (issue #472, owner ruling R-Q3). The button and its message share one block so the
            message stays under the button whatever the heading's width. `ml-auto` keeps the
            block at the right edge when a long message wraps it onto a row of its own: alone on
            a row, `justify-between` would start it at the left. */}
        <div className="ml-auto text-right">
          <RemoveOrderButton gate={removeGate} onClick={() => onRemove(setRemoveMessage)} />
          <PanelMessage message={removeMessage} />
        </div>
      </div>

      <LinesGrid shipperId={shipperId} shipperOrderId={order.id} lines={order.lines}
                 creditHoldReason={creditHoldReason}
                 recoverySource={recoverySource}
                 editGate={linesGate} saveGate={linesSaveGate ?? linesGate} applyMutation={applyMutation}
                 onTotalsReport={onTotalsReport} />
      <div className="my-4 border-t" />
      <ContainersGrid shipperId={shipperId} shipperOrderId={order.id} containers={order.containers} recoverySource={recoverySource}
                       editGate={editGate} applyMutation={applyMutation} onTotalsReport={onTotalsReport} />
      {/* This order's totals, under what they add up (owner answer 9 of 2026-10-10). The page works
          the table out and this panel only draws it. */}
      <ShipmentTotalsTable totals={totals} />
      <div className="my-4 border-t" />
      <SerialsGrid shipperId={shipperId} shipperOrderId={order.id} serials={order.serials} recoverySource={recoverySource}
                    editGate={editGate} applyMutation={applyMutation} />

      {/* Print (spec §11) — POST ?doc=ticket&order=<id>, with the cert checkbox pre-ticked
          (§3.14): the order's cert prints alongside as its own archived document. */}
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-3 text-sm">
        <button type="button" onClick={() => onPrintTicket(withCert && certsGate.allowed)}
                disabled={!printGate.allowed || printing}
                title={printGate.title}
                className={BUTTON_NEUTRAL_COMPACT}>
          {printing ? "Printing…" : "Print this order's ticket"}
        </button>
        {/* §5.16: the checkbox can be disabled for TWO reasons — the missing certs.view names
            itself, and on a voided shipment (certs.view held, so certsGate.title is undefined)
            the title falls through to printGate's voided reason rather than saying nothing
            (fix-wave 2026-08-06). */}
        <label className={`flex items-center gap-1 ${certsGate.allowed ? "" : "text-ink-500"}`}
               title={certsGate.title ?? printGate.title}>
          <input type="checkbox" checked={withCert && certsGate.allowed}
                 disabled={!certsGate.allowed || !printGate.allowed}
                 onChange={(e) => setWithCert(e.target.checked)} />
          Also print certification
        </label>
      </div>
    </section>
  );
}
