"use client";
import { formatNumber } from "@/lib/format";
import { pickerEmptySentence } from "@/lib/shipment-gates";
// The three shipment grids — lines, containers, serials — as PRESENTATIONAL views, extracted from
// ShipmentOrderPanel.tsx (Task 14) when Task 14b's create page (`/shipping/new`) became their
// second consumer. This file is the whole sibling group's single copy: the EDIT page
// ([id]/ShipmentOrderPanel.tsx) composes each view with `useBulkGrid` over the shipment's saved
// rows plus a per-grid Save button in the `footer` slot; the CREATE page (new/NewShipment.tsx)
// composes it with parent-owned local rows (everything `isNew`, nothing saved until the one atomic
// POST) and no footer. The sibling-split rule (CLAUDE.md, task-14-brief.md: "any fix to one grid
// lands on all copies in the same commit") is thereby honored by construction for the MARKUP and
// the prefill arithmetic — a fix here IS both pages' fix. What stays per-page is only persistence:
// where the rows live and what Save means.
//
// Each view owns its add-picker's transient `pick` state and the candidate PREFILL (design §5.1
// `ordered − shipped` for lines; see the per-grid notes below for why containers and serials have
// no ledger arithmetic), and reports every user action upward through three callbacks:
// `onPatch(row, field, value)`, `onRemove(row)`, `onAddRows(fields[])` — batch-shaped for the same
// reason `useBulkGrid.addRows` is (fix-wave R4 finding 7: "Add all remaining" appends the whole
// batch in ONE state update).
import { Fragment, useState, type ReactNode } from "react";
import type { Gate } from "@/lib/permission-ui";
import { pickerAddTitle } from "@/lib/waiting-titles";
import { shipRemainder } from "@/lib/ship-remainder";
import { rowFinishesLine } from "@/lib/line-completion";
import { shipNowWeightOffer, tareTotal } from "@/lib/net-weight";
import { containerLabels, isKeptContainer, prefillContainerRow } from "@/lib/shipment-container-rows";
import { TARE_EACH_LB, TARE_TOTAL_LB } from "@/lib/weight-terms";
import { SHIP_NOW_NET_WEIGHT } from "@/lib/shipment-boxes";
import { WeightOfferNote } from "@/components/WeightOfferNote";
import { INPUT_COMPACT, LINK } from "@/lib/ui-classes";

/** How a view names a row back to its owner: the owner's own key (a server row id on the edit
 *  page's existing rows, a client-generated id everywhere else) plus which kind it is — exactly
 *  the discriminator `useBulkGrid`'s `updateExisting`/`updateAdded` split needs. */
export type GridRowHandle = { key: string; isNew: boolean };

// -------------------------------------------------------------------------------------------
// Lines grid — ordered / shipped-to-date / ship-now qty and net weight / close short, prefilled
// to the remainder (task-14-brief.md Step 2, design §5.1). A row whose ship-now quantity has been
// changed is offered quantity × the part's each weight under it (the quantity corrections design §4).
// -------------------------------------------------------------------------------------------

export type LineFields = { orderLineId: string; qty: string; weight: string; lineComplete: string };
export type LineRow = GridRowHandle & LineFields;
/** `eachWeight` is the part's each weight in lb, or null when this screen was not given one. */
export type LineInfo = { partNumber: string; partName: string; orderedQty: number; orderedWeight: number; eachWeight: number | null };
export type ShippedInfo = { qty: number; weight: number };
export type LineCandidate = { id: string; partNumber: string; qty: number; weight: number };

/** Prefilled to the remainder (design §5.1 `ordered − shipped`): a candidate partly shipped on an
 *  EARLIER shipment defaults to what is left, not to the full ordered figure — which used to hand
 *  the operator an over-shipping default they only found out about from the §5.7 warning AFTER
 *  saving (efde514). A default, never a cap: the field stays editable and the server still
 *  accepts (and warns about) more, since over-shipping warns and never blocks. */
export function prefillLineRow(
  c: { id: string; qty: number; weight: number }, shipped: ShippedInfo | undefined,
): LineFields {
  const s = shipped ?? { qty: 0, weight: 0 };
  return {
    orderLineId: c.id,
    qty: String(shipRemainder(c.qty, s.qty)),
    weight: String(shipRemainder(c.weight, s.weight)),
    lineComplete: "false",
  };
}

/** Does this row, as typed, finish its line? Unknown line info reads as "no", so the close-short
 *  box stays available rather than vanishing on a row the grid cannot describe. */
export function rowCompletesLine(
  row: LineFields, info: LineInfo | undefined, shipped: ShippedInfo | undefined, savedQty: number,
): boolean {
  return rowFinishesLine(row, info?.orderedQty, shipped?.qty, savedQty);
}

export function LinesGridView({
  rows, candidates, infoByLineId, shippedByLineId, savedQtyByLineId, gate, orphanWarning, onPatch, onRemove, onAddRows, footer, emptyReason, boxId,
}: {
  rows: LineRow[];
  /** The order's catalog lines NOT already in `rows` — what the add picker offers. */
  candidates: LineCandidate[];
  infoByLineId: Map<string, LineInfo>;
  shippedByLineId: Map<string, ShippedInfo>;
  /** THIS shipment's own saved quantity per order line (already inside "shipped to date");
   *  empty on a new shipment. */
  savedQtyByLineId: Map<string, number>;
  gate: Gate;
  orphanWarning?: string | null;
  onPatch: (row: GridRowHandle, field: keyof LineFields, value: string) => void;
  onRemove: (row: GridRowHandle) => void;
  onAddRows: (rows: LineFields[]) => void;
  footer?: ReactNode;
  /** Why the add picker is empty, when the reason is not that everything is on the shipment
   *  already. The saved page passes "Requires orders.view" for a viewer whose order catalog was
   *  never read (#472), and, while its grid has no baseline, the grid's recovery notice's first
   *  sentence in loading, unavailable and error (`pickerEmptyReason`, #483). Text beside the
   *  picker, never an option. */
  emptyReason?: string;
  /** The element id of a row's Ship now box (`index` counts from 0): New shipment's jump to a
   *  refused box (ruling R13). The saved page hands none. */
  boxId?: (index: number, box: "qty" | "weight") => string;
}) {
  const [pick, setPick] = useState("");

  function addPicked() {
    const c = candidates.find((x) => x.id === pick);
    if (!c) return;
    onAddRows([prefillLineRow(c, shippedByLineId.get(c.id))]);
    setPick("");
  }
  function addAllRemaining() {
    if (candidates.length === 0) return;
    onAddRows(candidates.map((c) => prefillLineRow(c, shippedByLineId.get(c.id))));
  }

  return (
    <div>
      <h4 className="mb-1 text-sm font-medium">Lines</h4>
      {orphanWarning && <p className="mb-2 rounded bg-accent-50 p-2 text-xs text-accent-600">{orphanWarning}</p>}
      {/* L1b (#239): a shipment covering several orders stacks one of these tables per order
          panel, and an auto-layout table sizes its columns from its own rows — so "Ship now qty"
          sat at a different x position in every panel and the stack read as unrelated grids.
          `table-fixed` plus a `<colgroup>` pins the seven columns to the same fractions in every
          panel, whatever part numbers or figures the order carries. The two ship-now inputs go
          `w-full` with it: a fixed `w-20` inside a fractional column is the one thing that can
          still overflow its cell once the layout stops sizing to content. */}
      {rows.length === 0 ? (
        <p className="mb-2 text-sm text-ink-500">No lines on this shipment yet.</p>
      ) : (
        <table className="mb-2 w-full table-fixed text-sm">
          <colgroup>
            <col className="w-[19%]" /><col className="w-[15%]" /><col className="w-[13%]" />
            <col className="w-[16%]" /><col className="w-[16%]" /><col className="w-[12%]" />
            <col className="w-[9%]" />
          </colgroup>
          <thead>
            <tr className="text-left text-ink-500">
              <th className="py-1 font-medium">Part</th>
              {/* The two right-aligned read-only columns carry `pr-3`: with the layout fixed, their
                  text ends exactly at the column boundary, and "Shipped to date" ran straight into
                  "Ship now qty" (as did the figure below it into the ship-now box). */}
              <th className="pr-3 text-right font-medium">Ordered</th>
              <th className="pr-3 text-right font-medium">Shipped to date</th>
              <th className="font-medium">Ship now qty</th>
              <th className="font-medium">{SHIP_NOW_NET_WEIGHT.label}</th>
              <th className="font-medium">Close line short</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const info = infoByLineId.get(row.orderLineId);
              const shipped = shippedByLineId.get(row.orderLineId);
              // The quantity this row started at. A saved row: what this shipment saved. A row not
              // saved yet: the remainder it was prefilled with (`prefillLineRow` above; the new
              // form's Add order uses the same `shipRemainder`). A weight is offered only while the
              // typed quantity differs from that start, so a row nobody has changed is offered
              // nothing, whatever weight it carries: that weight may be a deliberate received
              // weight. Both are derived at every render from the typed text and the ledger; the
              // grid keeps no record that a quantity changed.
              const startQty = !row.isNew ? savedQtyByLineId.get(row.orderLineId)
                : info ? shipRemainder(info.orderedQty, shipped?.qty ?? 0) : null;
              const offer = shipNowWeightOffer({
                shipNowQty: row.qty, startQty, eachWeight: info?.eachWeight, typedWeight: row.weight,
              });
              // The Fragment is unconditional and the key is on it, so the <tr> holding the two boxes
              // is the same element whether or not an offer follows it. Choosing between a bare <tr>
              // and a Fragment here would remount that row on the keystroke that makes the offer
              // appear or go, and the box would lose focus mid-number.
              return (
                <Fragment key={row.key}>
                  <tr className="border-t align-top">
                    <td className="py-1">
                      <div className="font-mono">{info?.partNumber ?? row.orderLineId}</div>
                      {info && <div className="text-xs text-ink-500">{info.partName}</div>}
                    </td>
                    <td className="pr-3 tabular-nums text-right">{info ? `${formatNumber(info.orderedQty)} / ${formatNumber(info.orderedWeight, 2)} lb` : "—"}</td>
                    {/* A real number for a not-yet-saved row too, so the operator can see what the
                        prefilled ship-now figure was derived from and correct it against. */}
                    <td className="pr-3 tabular-nums text-right">{shipped ? `${formatNumber(shipped.qty)} / ${formatNumber(shipped.weight, 2)} lb` : "—"}</td>
                    <td>
                      <input id={boxId?.(i, "qty")} value={row.qty} inputMode="numeric" disabled={!gate.allowed} title={gate.title}
                             onChange={(e) => onPatch(row, "qty", e.target.value)}
                             aria-label={`Line ${i + 1} ship-now quantity`}
                             className={`${INPUT_COMPACT} w-full disabled:bg-surface-50`} />
                    </td>
                    <td>
                      <input id={boxId?.(i, "weight")} value={row.weight} inputMode="decimal" disabled={!gate.allowed} title={gate.title}
                             onChange={(e) => onPatch(row, "weight", e.target.value)}
                             aria-label={`Line ${i + 1} ship-now weight`}
                             className={`${INPUT_COMPACT} w-full disabled:bg-surface-50`} />
                    </td>
                    <td className="text-center">
                      {/* The tick is KEPT while the box is hidden, so a mistyped completing quantity
                          cannot discard a decision: lower the quantity again and the box returns,
                          still ticked. Both payload builders (`shipmentLinesPayload`,
                          shipment-line-save.ts; `prepareNewShipmentSave`, new-shipment-recovery.ts)
                          send it unticked when the row finishes its line. Known residual: a tick
                          left hidden on a row whose quantity equals its saved value still reads as an
                          unsaved change; Discard clears it and the recovery preview lists it. */}
                      {rowCompletesLine(row, info, shipped, savedQtyByLineId.get(row.orderLineId) ?? 0) ? (
                        <span className="text-xs text-ink-500">Completes line</span>
                      ) : (
                        <input type="checkbox" checked={row.lineComplete === "true"} disabled={!gate.allowed} title={gate.title}
                               onChange={(e) => onPatch(row, "lineComplete", e.target.checked ? "true" : "false")}
                               aria-label={`Line ${i + 1} close short`} />
                      )}
                    </td>
                    <td className="text-right">
                      <button onClick={() => onRemove(row)} disabled={!gate.allowed} title={gate.title}
                              className="text-xs text-red-600">
                        Remove
                      </button>
                    </td>
                  </tr>
                  {offer !== null && (
                    <tr>
                      {/* Accepting fills this row's ship-now weight box through the same `onPatch` a
                          keystroke in that box uses. It saves nothing: Save lines on the saved page and
                          Save shipment on the new form still do. The figure is written as
                          `String(offer.pounds)` ("48", "48.5"), the form a saved weight has, so on the
                          saved page a figure equal to the saved weight is no edit to that box.
                          Gated as the row's own boxes are. */}
                      <td colSpan={7} className="pb-1 text-right text-xs">
                        <WeightOfferNote offer={offer} disabled={!gate.allowed} title={gate.title}
                                         onUse={() => onPatch(row, "weight", String(offer.pounds))} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select value={pick} onChange={(e) => setPick(e.target.value)} disabled={!gate.allowed || candidates.length === 0}
                title={gate.title} aria-label="Add line" className={`${INPUT_COMPACT} disabled:cursor-not-allowed disabled:bg-surface-50`}>
          {/* C7a (#239): the empty option used to double as a status sentence — "Every order line
              is on this shipment" sat inside a picker, reading as something you could choose, in a
              control that is disabled precisely because there is nothing to choose. The option
              keeps the neutral placeholder and the sentence moves out beside the select, where it
              is text. The select's own `aria-label` and disabled condition are unchanged, so every
              selector that names this control still finds it. Same split in all three grids. */}
          <option value="">Add line…</option>
          {/* "remaining" names the figure the row will actually be prefilled with, so the choice
              is made against it rather than discovered after the row lands in the grid. */}
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.partNumber} — ordered {formatNumber(c.qty)}, remaining {formatNumber(shipRemainder(c.qty, shippedByLineId.get(c.id)?.qty ?? 0))}
            </option>
          ))}
        </select>
        {candidates.length === 0 && (
          <span className="text-sm text-ink-500">{emptyReason ?? "Every order line is on this shipment"}</span>
        )}
        <button onClick={addPicked} disabled={!gate.allowed || !pick} title={pickerAddTitle(gate, candidates.length, pick, "line")}
                className={`${LINK} text-sm`}>
          Add
        </button>
        <button onClick={addAllRemaining} disabled={!gate.allowed || candidates.length === 0} title={gate.title}
                className={`${LINK} text-sm`}>
          Add all remaining
        </button>
        {footer}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------------------
// Containers grid — which of the order's container rows went, and how many (spec §4.2 "which of
// the order's container rows went and how many").
//
// SIBLING-SPLIT NOTE (task-14-brief.md, Task 14 review Important #1): the lines grid's "prefill to
// the remainder" fix does NOT land here, and the reason is structural rather than an oversight.
// The ship ledger is defined per ORDER LINE and nothing else (design §5.1, ship-ledger.ts:
// `shippedTotals(db, orderLineIds)`); `ShipperContainer` carries a `count` of bins that travelled
// on this shipment with no ledger, no aggregate, and no "containers shipped to date" anywhere in
// the schema or the spec, so `ordered − shipped` has no second operand to compute. The candidate
// prefill of the number of containers stays the order container's own `count` — which IS its whole
// remainder, since a container row is not consumed across shipments the way a line's quantity is.
//
// Each row also has a Tare each box and a Tare total cell (the weights design §12.2). The box
// holds the shipment row's own tare each as text. The row rules both screens share are in
// src/lib/shipment-container-rows.ts: `prefillContainerRow` there is what a row takes when it is
// added, the order row's tare each included, and `containerLabels` gives the label each box's
// spoken name starts with. The Tare total cell is `tareTotal` (src/lib/net-weight.ts) over the
// row's `count` and `tareEach` as the grid holds them. A row that is not kept has a box for each,
// so the cell follows both as typed. A kept row has the Tare each box alone: its `count` is the
// row's own text, which no box here changes. The cell shows the formatter's dash while it cannot
// be worked out.
// -------------------------------------------------------------------------------------------

export type ContainerFields = { orderContainerId: string; count: string; tareEach: string };
export type ContainerRow = GridRowHandle & ContainerFields;
export type ContainerInfo = { typeName: string; customerContainerId: string };
/** A kept row as the saved page draws it: the shipment row's own type, Cust Cont Id and number of containers. */
export type KeptContainerInfo = ContainerInfo & { count: number };
/** `tareEach` is the order row's tare each in lb, null when it has none. */
export type ContainerCandidate = { id: string; typeName: string; customerContainerId: string; count: number; tareEach: number | null };

export function ContainersGridView({
  rows, candidates, infoById, keptByKey, gate, orphanWarning, onPatch, onRemove, onAddRows, footer, emptyReason,
  orderHasNone = false, boxId,
}: {
  rows: ContainerRow[];
  candidates: ContainerCandidate[];
  infoById: Map<string, ContainerInfo>;
  /** A saved shipment's kept rows by the row's key. A row that names no order container is drawn
   *  from its entry. The new-shipment form has no kept row and hands none. */
  keptByKey?: ReadonlyMap<string, KeptContainerInfo>;
  gate: Gate;
  orphanWarning?: string | null;
  onPatch: (row: GridRowHandle, field: keyof ContainerFields, value: string) => void;
  onRemove: (row: GridRowHandle) => void;
  onAddRows: (rows: ContainerFields[]) => void;
  footer?: ReactNode;
  /** See `LinesGridView`. */
  emptyReason?: string;
  /** The order has no rows of this kind at all (#698): the text beside an empty picker then says
   *  where to add them, since a shipment row must name an order row. */
  orderHasNone?: boolean;
  /** See `LinesGridView`: a row's count or Tare each box. */
  boxId?: (index: number, box: "count" | "tareEach") => string;
}) {
  const [pick, setPick] = useState("");
  const labels = containerLabels(rows);

  // tests/shipment-containers-grid.test.tsx lifts `addPicked` and `addAllRemaining` out of this
  // view and runs them by their free names: `candidates`, `pick`, `onAddRows`, `setPick` and
  // `prefillContainerRow`.
  function addPicked() {
    const c = candidates.find((x) => x.id === pick);
    if (!c) return;
    onAddRows([prefillContainerRow(c)]);
    setPick("");
  }
  function addAllRemaining() {
    if (candidates.length === 0) return;
    onAddRows(candidates.map(prefillContainerRow));
  }

  return (
    <div>
      <h4 className="mb-1 text-sm font-medium">Containers</h4>
      {orphanWarning && <p className="mb-2 rounded bg-accent-50 p-2 text-xs text-accent-600">{orphanWarning}</p>}
      {rows.some(isKeptContainer) && (
        <p className="mb-1 text-xs text-ink-500">
          {"Containers marked Kept are from earlier selections (the order-side rows were since corrected away). Only their Tare each can be changed."}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="mb-2 text-sm text-ink-500">No containers on this shipment yet.</p>
      ) : (
        <table className="mb-2 w-full table-fixed text-sm">
          {/* The six columns keep the same shares of the table in every panel. */}
          <colgroup>
            <col className="w-[22%]" /><col className="w-[14%]" /><col className="w-[19%]" />
            <col className="w-[19%]" /><col className="w-[16%]" /><col className="w-[10%]" />
          </colgroup>
          <thead>
            <tr className="text-left text-ink-500">
              <th className="py-1 font-medium">Type</th>
              <th className="font-medium">Cust Cont Id</th>
              <th className="font-medium">Containers</th>
              <th className="font-medium">{TARE_EACH_LB}</th>
              <th className="font-medium">{TARE_TOTAL_LB}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              // A kept row names no order container. It is drawn from the shipment row's own data,
              // `keptInfo`, which is read for a kept row alone.
              const kept = isKeptContainer(row);
              const keptInfo = keptByKey?.get(row.key);
              const info = kept ? keptInfo : infoById.get(row.orderContainerId);
              return (
                <tr key={row.key} className="border-t">
                  <td className="break-words py-1">{info?.typeName ?? row.orderContainerId}</td>
                  <td className="break-words text-ink-500">{info?.customerContainerId || "—"}</td>
                  <td className="pr-2">
                    {kept ? formatNumber(keptInfo?.count) : (
                      <input id={boxId?.(i, "count")} value={row.count} inputMode="numeric" disabled={!gate.allowed} title={gate.title}
                             onChange={(e) => onPatch(row, "count", e.target.value)}
                             aria-label={`${labels[i]} count`}
                             className={`${INPUT_COMPACT} w-full max-w-20 disabled:bg-surface-50`} />
                    )}
                  </td>
                  {/* tests/shipment-containers-grid.test.tsx runs this box's `onChange` by its free names `onPatch` and `row`. */}
                  <td className="pr-2">
                    <input id={boxId?.(i, "tareEach")} value={row.tareEach} inputMode="decimal" disabled={!gate.allowed} title={gate.title}
                           onChange={(e) => onPatch(row, "tareEach", e.target.value)}
                           aria-label={`${labels[i]} tare each`}
                           className={`${INPUT_COMPACT} w-full max-w-20 disabled:bg-surface-50`} />
                  </td>
                  <td className="tabular-nums">{formatNumber(tareTotal({ count: row.count, tareEach: row.tareEach }), 2)}</td>
                  <td className="text-right">
                    {kept ? <span className="text-xs text-ink-500">Kept</span> : (
                      <button onClick={() => onRemove(row)} disabled={!gate.allowed} title={gate.title}
                              className="text-xs text-red-600">
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select value={pick} onChange={(e) => setPick(e.target.value)} disabled={!gate.allowed || candidates.length === 0}
                title={gate.title} aria-label="Add container" className={`${INPUT_COMPACT} disabled:cursor-not-allowed disabled:bg-surface-50`}>
          {/* C7a (#239) — see the Lines grid above for the reasoning. */}
          <option value="">Add container…</option>
          {candidates.map((c) => <option key={c.id} value={c.id}>{c.typeName} — {formatNumber(c.count)} on the order</option>)}
        </select>
        {candidates.length === 0 && (
          <span className="text-sm text-ink-500">{emptyReason ?? pickerEmptySentence("container", orderHasNone)}</span>
        )}
        <button onClick={addPicked} disabled={!gate.allowed || !pick} title={pickerAddTitle(gate, candidates.length, pick, "container")}
                className={`${LINK} text-sm`}>
          Add
        </button>
        <button onClick={addAllRemaining} disabled={!gate.allowed || candidates.length === 0} title={gate.title}
                className={`${LINK} text-sm`}>
          Add all remaining
        </button>
        {footer}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------------------
// Serials grid — which of the order's serials went, with a per-row print-on-shipper flag (spec
// §4.2).
//
// SIBLING-SPLIT NOTE: the "prefill to the remainder" fix does not land here either, and even less
// ambiguously than for containers — a serial has no quantity at all. Its only prefilled field is
// the boolean `printOnShipper` (defaulted true), so there is no arithmetic to make remainder-aware.
// A serial already in `rows` is excluded from the picker by the caller's own candidates filter,
// which is the whole of "remainder" for a set-membership row.
// -------------------------------------------------------------------------------------------

export type SerialFields = { orderSerialId: string; printOnShipper: string };
export type SerialRow = GridRowHandle & SerialFields;
export type SerialInfo = { serial: string; description: string };
export type SerialCandidate = { id: string; serial: string };

export function prefillSerialRow(s: { id: string }): SerialFields {
  return { orderSerialId: s.id, printOnShipper: "true" };
}

export function SerialsGridView({
  rows, candidates, infoById, gate, orphanWarning, onPatch, onRemove, onAddRows, footer, emptyReason,
  orderHasNone = false,
}: {
  rows: SerialRow[];
  candidates: SerialCandidate[];
  infoById: Map<string, SerialInfo>;
  gate: Gate;
  orphanWarning?: string | null;
  onPatch: (row: GridRowHandle, field: keyof SerialFields, value: string) => void;
  onRemove: (row: GridRowHandle) => void;
  onAddRows: (rows: SerialFields[]) => void;
  footer?: ReactNode;
  /** See `LinesGridView`. */
  emptyReason?: string;
  /** The order has no rows of this kind at all (#698): the text beside an empty picker then says
   *  where to add them, since a shipment row must name an order row. */
  orderHasNone?: boolean;
}) {
  const [pick, setPick] = useState("");

  function addPicked() {
    const s = candidates.find((x) => x.id === pick);
    if (!s) return;
    onAddRows([prefillSerialRow(s)]);
    setPick("");
  }
  function addAllRemaining() {
    if (candidates.length === 0) return;
    onAddRows(candidates.map(prefillSerialRow));
  }

  return (
    <div>
      <h4 className="mb-1 text-sm font-medium">Shipment serials</h4>
      {orphanWarning && <p className="mb-2 rounded bg-accent-50 p-2 text-xs text-accent-600">{orphanWarning}</p>}
      {rows.length === 0 ? (
        <p className="mb-2 text-sm text-ink-500">No serials on this shipment yet.</p>
      ) : (
        <table className="mb-2 w-full text-sm">
          <thead>
            <tr className="text-left text-ink-500">
              <th className="py-1 font-medium">Serial</th>
              <th className="font-medium">Description</th>
              <th className="font-medium">Print on ticket</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const info = infoById.get(row.orderSerialId);
              return (
                <tr key={row.key} className="border-t">
                  <td className="py-1 font-mono">{info?.serial ?? row.orderSerialId}</td>
                  <td className="text-ink-500">{info?.description || "—"}</td>
                  <td className="text-center">
                    <input type="checkbox" checked={row.printOnShipper === "true"} disabled={!gate.allowed} title={gate.title}
                           onChange={(e) => onPatch(row, "printOnShipper", e.target.checked ? "true" : "false")}
                           aria-label={`Serial ${i + 1} print on ticket`} />
                  </td>
                  <td className="text-right">
                    <button onClick={() => onRemove(row)} disabled={!gate.allowed} title={gate.title}
                            className="text-xs text-red-600">
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select value={pick} onChange={(e) => setPick(e.target.value)} disabled={!gate.allowed || candidates.length === 0}
                title={gate.title} aria-label="Add serial" className={`${INPUT_COMPACT} disabled:cursor-not-allowed disabled:bg-surface-50`}>
          {/* C7a (#239) — see the Lines grid above for the reasoning. */}
          <option value="">Add serial…</option>
          {candidates.map((s) => <option key={s.id} value={s.id}>{s.serial}</option>)}
        </select>
        {candidates.length === 0 && (
          <span className="text-sm text-ink-500">{emptyReason ?? pickerEmptySentence("serial", orderHasNone)}</span>
        )}
        <button onClick={addPicked} disabled={!gate.allowed || !pick} title={pickerAddTitle(gate, candidates.length, pick, "serial")}
                className={`${LINK} text-sm`}>
          Add
        </button>
        <button onClick={addAllRemaining} disabled={!gate.allowed || candidates.length === 0} title={gate.title}
                className={`${LINK} text-sm`}>
          Add all remaining
        </button>
        {footer}
      </div>
    </div>
  );
}
