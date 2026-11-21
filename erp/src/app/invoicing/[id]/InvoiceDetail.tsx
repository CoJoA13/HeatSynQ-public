"use client";
import { formatDateTime, formatMoney, formatNumber } from "@/lib/format";
// The invoice page's body (design spec §11 "/invoicing/[id]"). Remounted per id by page.tsx's
// `key={id}` (HANDOFF §5.12 — a Critical in Phase 2B): every field bound straight to `invoice`
// below and every bulk-grid overlay is therefore guaranteed fresh per invoice id, never carrying
// one invoice's unsaved text onto another's.
//
// THE BINDING STATE MODEL — copied from ShipmentDetail.tsx (task-18-brief.md's explicit
// precedent), not reinvented: header PATCHes are optimistic with rollback-then-report on failure
// (§5.13 — reload BEFORE setting the error, never after); one monotonic mutation ticket
// (`useMutationGate`) is shared by every write AND by `load` itself, so overlapping calls resolve
// to whichever is genuinely newest; `useEditGuard` preserves the field under the cursor when a
// server detail lands mid-edit — the notes-clobber trio's fix, and this page is a fourth member
// of that sibling group; the line grid keeps only what the user actually edited/added/removed
// (`useBulkGrid`, src/lib/bulk-grid.ts), composed with server state at render.
//
// Create credit (`raiseCredit`) is the one action that does NOT go through `applyMutation`: unlike every other
// mutator here, POST .../credit answers with a DIFFERENT document (a new CREDIT with its own id),
// not a fresh copy of THIS invoice — applying it here would silently swap the page's content out
// from under the URL. It navigates to the new credit's own page instead, the orders/new
// "Save & Print" `router.push` precedent.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelMessage } from "@/components/PanelMessage";
import { DangerButton } from "@/components/DangerButton";
import { gridAtRest, useMessageClearedAtRest } from "@/lib/grid-message";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError, trackedFetch, UnreadableAnswerError } from "@/lib/fetcher";
import { percentFromFraction } from "@/lib/rate-display";
import { invoiceLineRateText } from "@/lib/invoice-line-rate";
import { gate, gateDo, type Gate } from "@/lib/permission-ui";
import { savingGate } from "@/lib/shipment-gates";
import { createBulkRecoverySource, readBulkPermissions } from "@/lib/bulk-recovery-source";
import { usePermissions } from "@/lib/use-permissions";
import { useMutationGate } from "@/lib/use-latest";
import { drainOtherKeys, makeWriteSignals, reReadAfter } from "@/lib/drain-queue";
import { useEditGuard } from "@/lib/use-edit-guard";
import { useBulkGrid, type ComposedRow } from "@/lib/bulk-grid";
import { HistoryPanel, invalidateHistory } from "@/components/HistoryPanel";
import { DraftRecoveryNotice } from "@/components/DraftRecoveryNotice";
import { toLineFields, invoiceBulkOptions, type InvoiceLineFields as LineFields, type InvoiceBulkSource } from "@/lib/invoice-bulk-recovery";
import { SaveButton } from "@/components/SaveButton";
import { askDiscard, captureDiscardNavigation, useUnsavedPresent } from "@/lib/use-unsaved-section";
import { peekBrowserDraftSession } from "@/lib/draft-session";
import {
  INVOICE_KIND_LABELS, INVOICE_STATUS_LABELS, INVOICE_LINE_KIND_LABELS, PRICE_SOURCE_LABELS,
  type InvoiceKindValue, type InvoiceStatusValue, type InvoiceLineKindValue, type PriceSourceValue,
} from "@/lib/invoice-constants";
import { newId } from "@/lib/client-id";
import { NET_WEIGHT_LB } from "@/lib/weight-terms";
import { invoiceLineRefusals } from "@/lib/invoice-line-refusals";
import { openPendingTab, printWarningSentence } from "@/lib/print-tab";
import { offersStepSuggestions, pickPatch, suggestionsFor, typedPatch } from "@/lib/invoice-step-pick";
import type { InvoiceStepSuggestions } from "@/lib/invoice-step-suggestions";
import { StepWordsBox } from "./StepWordsBox";
import { RemovedLinesList } from "./RemovedLinesList";
import type { RemovedLine } from "@/lib/invoice-removed-lines";
import { ListStatus, PageStatus } from "@/components/PageStatus";
import { useStoredDocuments } from "@/lib/use-stored-documents";
import { askReason } from "@/lib/modal";
import { PageHeader } from "@/components/PageHeader";
import { RecordTabs } from "@/components/RecordTabs";
import { AtAGlance } from "@/components/AtAGlance";
import { ActionMenu } from "@/components/ActionMenu";
import { INVOICE_TAB_LABEL, invoiceActionLabels, invoiceTabs, invoiceTitle } from "@/lib/invoice-tabs";
import { printedSince } from "@/lib/invoice-printed";
import { SavedMark } from "@/components/SavedMark";
import { useSavedMarks } from "@/lib/use-saved-marks";
import { BADGE_WARNING, BUTTON_NEUTRAL, BUTTON_PRIMARY, CARD, INPUT_COMPACT, LINK, NOTICE } from "@/lib/ui-classes";

// ---------------------------------------------------------------------------------------------
// Types. Local mirrors of src/server/invoices.ts's InvoiceDetail/InvoiceLineDetail — not imported
// from src/server/** (CLAUDE.md: a client component pulling from there drags node:async_hooks and
// Prisma into the browser bundle). Named `InvoiceDetailData`, not `InvoiceDetail` — the component
// below is `InvoiceDetail` (task-18-brief.md's exact file/component name), and the two would
// collide (the CertDetail.tsx / `CertDetailData` precedent).
// ---------------------------------------------------------------------------------------------

export type InvoiceLineRow = {
  id: string; position: number; kind: InvoiceLineKindValue; parentLineId: string | null;
  orderLineId: string | null; processStepCodeId: string | null;
  surchargeId: string | null; orderChargeId: string | null; glAccountId: string | null;
  partNumber: string; partName: string; partDescription: string;
  description: string; glAccountName: string;
  qty: number | null; weight: number | null; eachWeight: number | null;
  pricePer: string | null;
  unitPrice: number | null; setupCharge: number | null; minimumCharge: number | null;
  breakThreshold: number | null; minimumApplied: boolean;
  rate: number | null; priceSource: string | null;
  /** The FROZEN quote number ("Quote #N" on a QUOTE-sourced line) — the line's own column,
   *  never a live join to the quote (the frozen-paper rule; the quote may be long deleted). */
  sourceQuoteNumber: number | null;
  needsPrice: boolean;
  /** #587: the line's words were typed or picked on it (`InvoiceLine.wordsChosen`), which Recalculate
   *  keeps under `recalculateInvoice`'s carry rule. A hidden round-trip field: every Save lines sends
   *  it back as it stands. */
  wordsChosen: boolean;
  amount: number;
};

export type InvoiceDetailData = {
  id: string; kind: InvoiceKindValue; status: InvoiceStatusValue;
  orderId: string; orderNumber: number; documentNumber: string;
  sourceInvoiceId: string | null; creditNumber: number | null;
  /** The source invoice's document number on a credit (PR 6: the title), else null. */
  sourceInvoiceNumber: string | null;
  customerId: string; customerCode: string; customerName: string;
  invoiceDate: string; poNumber: string; termsName: string;
  billTo: string; shipTo: string; materialName: string; processNames: string;
  taxRate: number | null;
  subtotal: number; surchargeTotal: number; chargeTotal: number;
  certTotal: number; freightTotal: number; taxTotal: number; total: number;
  finalizedAt: string | null; deletedAt: string | null;
  lines: InvoiceLineRow[];
  /** #594: the computed lines removed from this draft (`invoice-removed-lines.ts`). */
  removedLines: RemovedLine[];
};

/** Every mutating invoice route (PATCH, lines PUT, recalculate/finalize/unlock POST) — and GET
 *  itself — is wrapped through `invoiceResponse` (src/app/api/invoices/response.ts) into this ONE
 *  shape. `.../credit` answers with the same shape but describing a DIFFERENT document — see the
 *  top comment on why that one is never routed through `applyMutation`. */
export type InvoiceMutationResult = { invoice: InvoiceDetailData; warnings: string[] };
/** Which one-shot write holds the page busy (#651): none, Create credit, Finalize or Recalculate. */
type InvoiceBusy = null | "credit" | "finalize" | "recalc";

// `entity` since #153 — the single-record audit read is a union over the invoice's child
// sections (its applications), so a row in it is not necessarily the invoice's own.
type AuditEntry = { id: string; entity: string; action: string; reason: string | null };
/** Slice of a future `GET /api/invoices/[id]/documents` (Task 19 — not built yet; the route 404s
 *  until then, exactly like this page's own Print button, both by task-18-brief.md's explicit
 *  license). Shape mirrors `listDocumentsForShipper`'s `DocumentMeta` (src/server/documents.ts). */
type StoredDoc = { id: string; kind: string; createdAt: string };

const DOC_KIND_LABELS: Record<string, string> = { INVOICE: "Invoice", CREDIT: "Credit" };

/** A FINALIZED invoice locks every editing control; a DISCARDED draft reuses the shape with its
 *  own title — the `voidLocked` helper's shape (ShipmentDetail.tsx:110-127), applied twice since
 *  an invoice has two lock states voided-shipment doesn't. Discarded wins if somehow both were
 *  true (they cannot co-occur — discard refuses a FINALIZED invoice — but the check order still
 *  names the more specific state first, the way voidLocked itself is unconditional). */
function statusLocked(g: Gate, finalized: boolean, discarded: boolean): Gate {
  if (discarded) return { allowed: false, disabled: true, title: "Invoice is discarded" };
  if (finalized) return { allowed: false, disabled: true, title: "Invoice is finalized" };
  return g;
}

/** The stored-documents list (spec §10/§11) — mirrors ShipmentDocumentsList (ShipmentDetail.tsx),
 *  minus the print/blob plumbing this page owns itself above. Since PR 6 the read itself
 *  (`useStoredDocuments`) is the page's, which hands it down: the At a glance card reads the newest
 *  print from the same answer, so the list and the card cannot disagree (one read, two readers). */
export type InvoiceDocumentsRead = ReturnType<typeof useStoredDocuments<StoredDoc>>;
function InvoiceDocumentsList({ documents, viewGate }: { documents: InvoiceDocumentsRead; viewGate: Gate }) {
  // The shared read and state (P6 step 3, #632): "Loading…" until a read lands, never the empty
  // sentence before then, and a read that lands clears an earlier failure.
  const { docs, error: err, status } = documents;

  if (status !== "rows") return <ListStatus status={status} denied={viewGate.title} error={err} empty="Nothing printed yet." />;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-ink-500">
          <th className="py-1 font-medium">Document</th><th className="font-medium">Created</th>
        </tr>
      </thead>
      <tbody>
        {docs.map((d) => (
          <tr key={d.id} className="border-t">
            <td className="py-1">
              <a href={`/api/documents/${d.id}`} target="_blank" rel="noreferrer" className={LINK}>
                {DOC_KIND_LABELS[d.kind] ?? d.kind}
              </a>
            </td>
            <td className="text-ink-500">{formatDateTime(d.createdAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------------------------
// The line grid — one `useBulkGrid` instance shared by BOTH visual sections (the PART/OPERATION
// grid and the surcharge/freight/charge/cert/tax lines), because `PUT .../lines` replaces the
// WHOLE array in one call (§5.5) — splitting into two grid instances would need to be recombined
// at save time anyway, so one instance composed once and filtered twice for display is simpler
// and cannot let the two "halves" drift out of position order relative to each other.
//
// `wireKey`/`parentKey` carry the OPERATION -> PART self-relation across the save (invoices.ts's
// `lineIdentities`): every row keeps its own server id as `wireKey` so a child can still
// resolve its parent, and a PART line removed without removing its children leaves them flat rather
// than dangling (the server's own documented fallback — not re-implemented here).
//
// It is `wireKey`, not `key`, because it is NOT this row's identity — it is an opaque token the
// server correlates WITHIN one payload and never persists (`lineColumns` drops it). The grid's own
// identity is `ComposedRow.key`, which `useBulkGrid` supplies. Naming both `key` is what #281 was:
// the field shadowed the identity, so an added row composed under `key: ""`, matched no `clientId`,
// and could not be typed into or removed. `useBulkGrid` now refuses the collision at compile time.
//
// Editing a row's `amount` is the one edit that also stamps `priceSource: MANUAL` and clears
// `needsPrice` — a deliberate UI decision (not spec-mandated): the operator just supplied the
// missing/overridden price, so Recalculate (which preserves only `priceSource = MANUAL` lines)
// must not silently discard it on its next run, and a line the operator just priced no longer
// "needs" one. Editing other fields (description, qty, weight) does not reclassify the line —
// those are corrections, not a pricing decision.
//
// On a draft INVOICE an OPERATION row's description is a `StepWordsBox` (#587): its words can be
// typed or picked from the part's steps, then every other step code. Either marks the line's words
// chosen (`wordsChosen`), which Recalculate keeps under `recalculateInvoice`'s carry rule; a pick on
// a row with no price row of its own also sets the step code and clears the GL account, which Save
// lines derives from that step code (invoice-step-pick.ts). Neither touches the price. Words typed
// or picked back to the saved line's own take its own mark, so the row holds no edit; the saved line
// is found by the row's key, its server id (an OPERATION row is never an added one: Add charge line
// adds a CHARGE). A PART row, a credit memo's rows and the surcharge/charge rows keep the plain box
// and never set the mark.
// ---------------------------------------------------------------------------------------------

/** The §7.5 "every line names its source" label for an OPERATION row: "Part price", "Manual", or
 *  "Quote #1006" — the QUOTE label with the line's FROZEN sourceQuoteNumber appended (never a live
 *  join; the quote may be long deleted and the label must not blank). */
function sourceLabel(row: { priceSource: string; sourceQuoteNumber: string }): string | null {
  if (row.priceSource === "") return null;
  const label = PRICE_SOURCE_LABELS[row.priceSource as PriceSourceValue] ?? row.priceSource;
  if (row.priceSource === "QUOTE" && row.sourceQuoteNumber !== "") {
    return `${label} #${row.sourceQuoteNumber}`;
  }
  return label;
}

/** A manually-added line — always kind CHARGE (the one ad-hoc addition that needs no order-side
 *  or surcharge-side link) and pre-stamped MANUAL/needsPrice=false, the same reasoning as the
 *  amount-edit stamp above: a line the operator typed in themselves is never "needs price". */
function blankChargeRow(): LineFields {
  return {
    wireKey: "", parentKey: "", kind: "CHARGE",
    orderLineId: "", processStepCodeId: "", surchargeId: "", orderChargeId: "", glAccountId: "",
    partNumber: "", partName: "", partDescription: "", description: "", glAccountName: "",
    qty: "", weight: "", eachWeight: "",
    pricePer: "", unitPrice: "", setupCharge: "", minimumCharge: "", breakThreshold: "",
    minimumApplied: "false", rate: "", priceSource: "MANUAL", sourceQuoteNumber: "",
    needsPrice: "false", wordsChosen: "false", amount: "0",
  };
}

export function InvoiceLinesGrid({
  invoiceId, lines, kind, stepSuggestions = null, moneyGate, recoverySource, applyMutation, readOnly,
}: {
  invoiceId: string;
  lines: InvoiceLineRow[];
  /** The document's kind: only an INVOICE's operation rows offer step suggestions (587-12). */
  kind: InvoiceKindValue;
  /** #587: the page's read of `GET .../step-suggestions`; null (or absent) while unread, after a
   *  failed read, and on any invoice the page does not read it for, which leaves every operation
   *  row's box a plain typing box. */
  stepSuggestions?: InvoiceStepSuggestions | null;
  recoverySource: InvoiceBulkSource;
  moneyGate: Gate;
  applyMutation: (run: () => Promise<InvoiceMutationResult>) => Promise<void>;
  /** S3 (#239): a FINALIZED invoice renders its lines as PAPER — plain cells, no controls. The
   *  server already refuses every edit (`statusLocked`, and the routes' own guards); this is
   *  presentation. The hook below stays mounted either way, deliberately — see the branch note. */
  readOnly: boolean;
}) {
  const grid = useBulkGrid(lines, toLineFields, invoiceBulkOptions(recoverySource, invoiceId));
  const recoveryGate: Gate = grid.mode === "editing" ? moneyGate : { allowed: false, disabled: true, title: "Resolve draft recovery before editing." };
  // R23 (#702): the line controls close while this grid's own Save is in transport; Save lines
  // keeps `recoveryGate`, so its "Saving…" carries no title (waiting-titles.ts).
  const linesGate: Gate = savingGate(recoveryGate, grid.saving);
  // This grid's own message (owner ruling R1, P6 step 5b): its validation, a refused save and a
  // failed one show under its Save row through the shared PanelMessage, the saved shipment page's
  // shape (#472). The setter keeps the name `onError` that `save` and the tests that lift it read.
  // The message goes when this grid comes to rest (src/lib/grid-message.ts).
  const [saveMessage, onError] = useState<string | null>(null);
  useMessageClearedAtRest(gridAtRest(grid.dirty, grid.canEdit), onError);
  const rows = grid.rows;
  const partOpRows = rows.filter((r) => r.kind === "PART" || r.kind === "OPERATION");
  const otherRows = rows.filter((r) => r.kind !== "PART" && r.kind !== "OPERATION");
  // The same two-way split, over the server's own frozen array, for the read-only branch below.
  const paperPartOps = lines.filter((l) => l.kind === "PART" || l.kind === "OPERATION");
  const paperOthers = lines.filter((l) => l.kind !== "PART" && l.kind !== "OPERATION");

  function patchFields(row: { key: string; isNew: boolean }, patch: Partial<LineFields>) {
    if (row.isNew) grid.updateAdded(row.key, patch); else grid.updateExisting(row.key, patch);
  }
  function patchRow(row: { key: string; isNew: boolean }, field: keyof LineFields, value: string) {
    const patch: Partial<LineFields> = { [field]: value };
    if (field === "amount") { patch.priceSource = "MANUAL"; patch.needsPrice = "false"; }
    patchFields(row, patch);
  }
  function removeRow(row: { key: string; isNew: boolean }) {
    if (row.isNew) grid.removeAdded(row.key); else grid.removeExisting(row.key);
  }

  async function save() {
    // One pass over every box through the one rule, before anything is built or sent: the draft
    // stays as typed, and the message lists every refusal, one per line (#517).
    const refusals = invoiceLineRefusals(rows);
    if (refusals.length > 0) { onError(refusals.join("\n")); return; }
    const payload: Record<string, unknown>[] = [];
    for (const row of rows) {
      const amount = row.amount.trim();
      const qty: number | null = row.qty.trim() === "" ? null : Number(row.qty);
      payload.push({
        // The WIRE token, deliberately not `row.key` (this row's grid identity): a locally-added
        // row has no server id, and omitting the key is what tells `lineIdentities` it is new.
        ...(row.wireKey ? { key: row.wireKey } : {}),
        parentKey: row.parentKey || null,
        kind: row.kind,
        orderLineId: row.orderLineId || null, processStepCodeId: row.processStepCodeId || null,
        surchargeId: row.surchargeId || null, orderChargeId: row.orderChargeId || null, glAccountId: row.glAccountId || null,
        partNumber: row.partNumber, partName: row.partName, partDescription: row.partDescription,
        description: row.description, glAccountName: row.glAccountName,
        qty,
        weight: row.weight.trim() === "" ? null : row.weight,
        eachWeight: row.eachWeight.trim() === "" ? null : row.eachWeight,
        pricePer: row.pricePer === "" ? null : row.pricePer,
        unitPrice: row.unitPrice.trim() === "" ? null : row.unitPrice,
        setupCharge: row.setupCharge.trim() === "" ? null : row.setupCharge,
        minimumCharge: row.minimumCharge.trim() === "" ? null : row.minimumCharge,
        breakThreshold: row.breakThreshold.trim() === "" ? null : row.breakThreshold,
        minimumApplied: row.minimumApplied === "true",
        rate: row.rate.trim() === "" ? null : row.rate,
        priceSource: row.priceSource === "" ? null : row.priceSource,
        // Echoed back whole (a hidden round-trip field, like priceSource): dropping it from the
        // save would blank the frozen "Quote #N" off the paper on any line edit.
        sourceQuoteNumber: row.sourceQuoteNumber === "" ? null : Number(row.sourceQuoteNumber),
        needsPrice: row.needsPrice === "true",
        // #587 (review focus 5): the mark goes back as it stands on every row. The server writes a
        // line sent without it as not chosen, so leaving it out would clear every line's mark (the
        // words themselves are saved as sent).
        wordsChosen: row.wordsChosen === "true",
        amount,
      });
    }
    const binding = grid.binding;
    if (!binding || !grid.canEdit || !moneyGate.allowed) return;
    const submission = binding.capture(payload, newId());
    try {
      await applyMutation(async () => {
        if (!binding.dispatched(submission)) throw new Error("This draft is no longer available to save.");
        let response: InvoiceMutationResult;
        try {
          response = await api<InvoiceMutationResult>(`/api/invoices/${invoiceId}/lines`, {
            method: "PUT", body: JSON.stringify(submission.payload),
          });
        } catch (error) {
          binding.settle(submission, { kind: error instanceof ApiError && error.status >= 400 && error.status < 500 ? "rejected" : "unknown" });
          throw error;
        }
        binding.settle(submission, { kind: "persisted", response: { ...submission.submitted.baseline,
          rows: response.invoice.lines.map(row => ({ id: row.id, fields: toLineFields(row) })),
        } });
        return response;
      });
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  // Locked amount controls show the shared money display. The grid keeps raw decimal strings,
  // so unlocking restores the original editable value and save payloads never contain currency.
  function partOpRow(row: ComposedRow<LineFields>, i: number) {
    return (
      <tr key={row.key} className={row.needsPrice === "true" ? "bg-accent-50" : undefined}>
        <td className="py-1 pr-2 text-xs text-ink-500">
          {INVOICE_LINE_KIND_LABELS[row.kind as InvoiceLineKindValue] ?? row.kind}
        </td>
        <td className="pr-2">
          {kind === "INVOICE" && row.kind === "OPERATION" ? (
            <StepWordsBox value={row.description} suggestions={suggestionsFor(row.orderLineId, stepSuggestions)}
                          disabled={!linesGate.allowed} title={linesGate.title} ariaLabel={`Line ${i + 1} description`}
                          onType={(value) => patchFields(row, typedPatch(value, lines.find((l) => l.id === row.key)))}
                          onPick={(suggestion) => patchFields(row, pickPatch(row, suggestion, lines.find((l) => l.id === row.key)))} />
          ) : (
            <input value={row.description} disabled={!linesGate.allowed} title={linesGate.title}
                   onChange={(e) => patchRow(row, "description", e.target.value)}
                   aria-label={`Line ${i + 1} description`}
                   className={`${INPUT_COMPACT} w-full disabled:bg-surface-50`} />
          )}
          {row.partNumber && <div className="text-xs text-ink-500">{row.partNumber} · {row.partName}</div>}
          {row.kind === "OPERATION" && sourceLabel(row) && (
            // §7.5: every line names its source — "Quote #1006" reads the FROZEN sourceQuoteNumber.
            <div className="text-xs text-ink-500">{sourceLabel(row)}</div>
          )}
        </td>
        <td className="w-20 pr-2">
          <input value={row.qty} inputMode="numeric" disabled={!linesGate.allowed} title={linesGate.title}
                 onChange={(e) => patchRow(row, "qty", e.target.value)}
                 aria-label={`Line ${i + 1} qty`} className={`${INPUT_COMPACT} w-full text-right tabular-nums disabled:bg-surface-50`} />
        </td>
        <td className="w-24 pr-2">
          <input value={row.weight} inputMode="decimal" disabled={!linesGate.allowed} title={linesGate.title}
                 onChange={(e) => patchRow(row, "weight", e.target.value)}
                 aria-label={`Line ${i + 1} weight`} className={`${INPUT_COMPACT} w-full text-right tabular-nums disabled:bg-surface-50`} />
        </td>
        <td className="pr-2 text-right tabular-nums text-ink-500">{formatMoney(row.unitPrice, 4)}</td>
        <td className="pr-2 text-ink-500">{row.glAccountName || "—"}</td>
        <td className="w-28 pr-2">
          <input value={row.kind === "PART" || !recoveryGate.allowed ? formatMoney(row.amount) : row.amount} inputMode="decimal"
                 disabled={row.kind === "PART" || !linesGate.allowed}
                 title={row.kind === "PART" ? "A PART line carries no money — its operations do" : linesGate.title}
                 onChange={(e) => patchRow(row, "amount", e.target.value)}
                 aria-label={`Line ${i + 1} amount`} className={`${INPUT_COMPACT} w-full text-right tabular-nums disabled:bg-surface-50`} />
        </td>
        <td className="pr-2">
          {row.needsPrice === "true" && (
            <span className={BADGE_WARNING}>needs price</span>
          )}
        </td>
        <td>
          <button onClick={() => removeRow(row)} disabled={!linesGate.allowed} title={linesGate.title}
                  className="text-xs text-red-600">
            Remove
          </button>
        </td>
      </tr>
    );
  }

  // ---- The read-only branch (S3, #239) -------------------------------------------------------
  //
  // It renders from `lines` — the server's own frozen array — not from `grid.rows`. For a
  // finalized invoice those two agree (recovery reports `editable: false`, so the composed rows
  // are the saved baseline under empty overlays; invoice-bulk-recovery.ts states the rule), but
  // `lines` is the thing this branch is ABOUT: an invoice is frozen paper and its snapshot
  // columns are read unconditionally (CLAUDE.md). Reading them straight also means the paper is
  // on screen at first paint rather than after the draft-recovery read admits the grid.
  //
  // Amounts, quantities and weights go through the shared #238 formatters — the formatting rule
  // reads "disabled invoice amounts may format their raw state at render time; enabled inputs and
  // save payloads stay raw", and a cell with no input in it is the purest case of that: nothing
  // here is ever typed into or submitted. The Rate column is on the surcharge and tax table only,
  // a percent through `invoiceLineRateText` in both branches (R9, #638).
  function readOnlyText(row: InvoiceLineRow) {
    return sourceLabel({
      priceSource: row.priceSource ?? "",
      sourceQuoteNumber: row.sourceQuoteNumber === null ? "" : String(row.sourceQuoteNumber),
    });
  }
  function needsPriceBadge(row: InvoiceLineRow) {
    return row.needsPrice
      ? <span className={BADGE_WARNING}>needs price</span>
      : null;
  }
  function readOnlyPartOpRow(row: InvoiceLineRow) {
    return (
      <tr key={row.id} className={row.needsPrice ? "bg-accent-50" : undefined}>
        <td className="py-1 pr-2 text-xs text-ink-500">
          {INVOICE_LINE_KIND_LABELS[row.kind] ?? row.kind}
        </td>
        <td className="pr-2">
          <div>{row.description}</div>
          {row.partNumber && <div className="text-xs text-ink-500">{row.partNumber} · {row.partName}</div>}
          {row.kind === "OPERATION" && readOnlyText(row) && (
            <div className="text-xs text-ink-500">{readOnlyText(row)}</div>
          )}
        </td>
        <td className="pr-2 text-right tabular-nums text-ink-500">{formatNumber(row.qty)}</td>
        <td className="pr-2 text-right tabular-nums text-ink-500">{formatNumber(row.weight, 2)}</td>
        <td className="pr-2 text-right tabular-nums text-ink-500">{formatMoney(row.unitPrice, 4)}</td>
        <td className="pr-2 text-ink-500">{row.glAccountName || "—"}</td>
        <td className="pr-2 text-right tabular-nums">{formatMoney(row.amount)}</td>
        <td className="pr-2">{needsPriceBadge(row)}</td>
      </tr>
    );
  }
  function readOnlyOtherRow(row: InvoiceLineRow) {
    return (
      <tr key={row.id} className={row.needsPrice ? "bg-accent-50" : undefined}>
        <td className="py-1 pr-2 text-xs text-ink-500">
          {INVOICE_LINE_KIND_LABELS[row.kind] ?? row.kind}
        </td>
        <td className="pr-2">{row.description}</td>
        <td className="pr-2 text-right tabular-nums text-ink-500">{invoiceLineRateText(row.kind, row.rate)}</td>
        <td className="pr-2 text-ink-500">{row.glAccountName || "—"}</td>
        <td className="pr-2 text-right tabular-nums">{formatMoney(row.amount)}</td>
        <td className="pr-2">{needsPriceBadge(row)}</td>
      </tr>
    );
  }

  function otherRow(row: ComposedRow<LineFields>, i: number) {
    return (
      <tr key={row.key} className={row.needsPrice === "true" ? "bg-accent-50" : undefined}>
        <td className="py-1 pr-2 text-xs text-ink-500">
          {INVOICE_LINE_KIND_LABELS[row.kind as InvoiceLineKindValue] ?? row.kind}
        </td>
        <td className="pr-2">
          <input value={row.description} disabled={!linesGate.allowed} title={linesGate.title}
                 onChange={(e) => patchRow(row, "description", e.target.value)}
                 aria-label={`Line ${i + 1} description`}
                 className={`${INPUT_COMPACT} w-full disabled:bg-surface-50`} />
        </td>
        <td className="pr-2 text-right tabular-nums text-ink-500">{invoiceLineRateText(row.kind, row.rate)}</td>
        <td className="pr-2 text-ink-500">{row.glAccountName || "—"}</td>
        <td className="w-28 pr-2">
          <input value={recoveryGate.allowed ? row.amount : formatMoney(row.amount)} inputMode="decimal" disabled={!linesGate.allowed} title={linesGate.title}
                 onChange={(e) => patchRow(row, "amount", e.target.value)}
                 aria-label={`Line ${i + 1} amount`} className={`${INPUT_COMPACT} w-full text-right tabular-nums disabled:bg-surface-50`} />
        </td>
        <td className="pr-2">
          {row.needsPrice === "true" && (
            <span className={BADGE_WARNING}>needs price</span>
          )}
        </td>
        <td>
          <button onClick={() => removeRow(row)} disabled={!linesGate.allowed} title={linesGate.title}
                  className="text-xs text-red-600">
            Remove
          </button>
        </td>
      </tr>
    );
  }

  return (
    <section className={`${CARD} mb-6`}>
      {grid.recoveryNotice && <DraftRecoveryNotice {...grid.recoveryNotice} />}
      <h2 className="mb-2 font-medium">Lines</h2>
      {grid.orphanWarning && (
        <p className={`${NOTICE.warning} mb-2`}>{grid.orphanWarning}</p>
      )}

      {readOnly && (
        // Why the reason moves ON SCREEN rather than staying in a native `title`. Measured, not
        // assumed: a finalized invoice projects `editable: false` (invoice-bulk-recovery.ts), so
        // draft-store's `emit` yields mode "conflict", `grid.canEdit` is false, and `recoveryGate`
        // — not `moneyGate` — is what every control above took its `title` from. All seven of them
        // therefore read "Resolve draft recovery before editing." on a perfectly healthy finalized
        // invoice with no draft anywhere; `moneyGate`'s own "Invoice is finalized" never reached
        // the grid at all. A tooltip is browser chrome in any case — invisible in the manual's
        // figures and to anyone not hovering. Taking the controls away takes the wrong sentence
        // with them, and the right one is stated where it can be read (§5.16's spirit).
        <p className="mb-3 text-sm text-ink-500">
          Finalized — these are the figures this invoice was issued on.
        </p>
      )}

      <h3 className="mb-1 text-sm font-medium text-ink-500">Part / operation lines</h3>
      {(readOnly ? paperPartOps.length : partOpRows.length) === 0 ? (
        <p className="mb-3 text-sm text-ink-500">None.</p>
      ) : (
        <table className="mb-4 w-full text-sm">
          <thead>
            <tr className="text-left text-ink-500">
              <th className="py-1 font-medium">Kind</th><th className="font-medium">Description</th>
              <th className="pr-2 font-medium text-right">Qty</th><th className="lg:whitespace-nowrap pr-2 font-medium text-right">{NET_WEIGHT_LB}</th>
              <th className="pr-2 font-medium text-right">Unit price</th>
              <th className="font-medium">GL account</th><th className="pr-2 font-medium text-right">Amount</th>
              {/* The same columns either way. The trailing header is the Remove column's, so it
                  is the ONE that goes when there is no Remove; the one before it carries the
                  "needs price" badge and stays. */}
              <th />{!readOnly && <th />}
            </tr>
          </thead>
          <tbody>
            {readOnly
              ? paperPartOps.map((row) => readOnlyPartOpRow(row))
              : partOpRows.map((row, i) => partOpRow(row, i))}
          </tbody>
        </table>
      )}

      <h3 className="mb-1 text-sm font-medium text-ink-500">Surcharges, freight, charges, cert &amp; tax</h3>
      {(readOnly ? paperOthers.length : otherRows.length) === 0 ? (
        <p className="mb-3 text-sm text-ink-500">None.</p>
      ) : (
        <table className="mb-2 w-full text-sm">
          <thead>
            <tr className="text-left text-ink-500">
              <th className="py-1 font-medium">Kind</th><th className="font-medium">Description</th>
              <th className="pr-2 font-medium text-right">Rate</th>
              <th className="font-medium">GL account</th><th className="pr-2 font-medium text-right">Amount</th>
              <th />{!readOnly && <th />}
            </tr>
          </thead>
          <tbody>
            {readOnly
              ? paperOthers.map((row) => readOnlyOtherRow(row))
              : otherRows.map((row, i) => otherRow(row, i))}
          </tbody>
        </table>
      )}

      {!readOnly && (
        <div className="mt-2 flex items-center gap-3">
          <button onClick={() => grid.addRow(blankChargeRow())} disabled={!linesGate.allowed} title={linesGate.title}
                  className={`${LINK} text-sm`}>
            Add charge line
          </button>
          <SaveButton label="Save lines" section="Invoice lines" gate={recoveryGate}
                      dirty={grid.dirty} onSave={save} onDiscard={() => { grid.discard(); onError(null); }} />
        </div>
      )}
      <PanelMessage message={saveMessage} />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// The page itself.
// ---------------------------------------------------------------------------------------------

export function InvoiceDetail({ id }: { id: string }) {
  const router = useRouter();
  // The mount's departure-attempt lifetime (#568/#581; InvoicesSection's shape), for Create credit.
  const navigationLifetime = useRef<{ live: boolean; request?: object }>({ live: false });
  useEffect(() => {
    const token = { live: true };
    navigationLifetime.current = token;
    return () => { token.live = false; };
  }, [id]);
  const { permissions: perms, error: permsError } = usePermissions();

  const [invoice, setInvoice] = useState<InvoiceDetailData | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [discardReason, setDiscardReason] = useState<string | null | undefined>(null);

  // The one monotonic ticket (the file's top comment). A read the server served before a write
  // still out had committed holds the newer ticket, so it either reverts that write on screen or has
  // the write's answer dropped: that is why `load` reads once more after the writes it overlapped
  // (#573, `writes` below).
  const mutations = useMutationGate();
  // #573 (owner ruling 2026-10-20, the hub's #550 "read now, re-read after"): this page's writes in
  // flight, one request-settled signal per `applyMutation` dispatch, each deleted when its request
  // settles (`makeWriteSignals`, drain-queue.ts), which `load` snapshots as it reads. One registry
  // per mount, built once the way `useMutationGate` builds the gate above: one built per render
  // would start empty on every render, forgetting the writes still out, and would change the
  // identity of `applyMutation` and `load` with it, and through the mount effect re-run the read on
  // every render. A residual: a mount starts with an empty registry, so a write an earlier mount of
  // the same invoice sent and still out (the invoice left and opened again within one round trip;
  // page.tsx remounts on `key={id}`) is not in it. Nothing aborts that write on unmount, its answer
  // reaches only the unmounted instance, and no read of this mount is followed for it.
  const [writes] = useState(makeWriteSignals);
  const recoverySource = useMemo(() => createBulkRecoverySource(
    async () => (await api<InvoiceMutationResult>(`/api/invoices/${id}`)).invoice, readBulkPermissions,
  ), [id]);
  const editGuard = useEditGuard();
  const savedMarks = useSavedMarks();

  const load = useCallback(async () => {
    // #573 (owner ruling 2026-10-20, the hub's #550 "read now, re-read after"): the GET goes out at
    // once, as before. A write of this page that was out as it was sent (the header PATCH, the lines
    // save, Recalculate, Finalize, Unlock: everything `applyMutation` registers) may commit after
    // the server served it, and then the payload predates that write: applied after the write's
    // answer it reverts the write on screen, and applied before it the answer, older-ticketed, is
    // dropped (with Finalize out, the invoice shown as a draft, its draft controls open, while the
    // server had finalized it). So when the snapshot below holds a write, the page reads once more
    // after every write in it has settled, whether or not one was still out when this read landed,
    // and whether or not this read was accepted. Detached: `load` resolves with this read, and its
    // caller (the mount effect, `patchHeader`'s rollback read, Discard's read) follows it without
    // waiting on a write (#276: `api()` has no timeout). The follow-up is this same read, applying
    // the same two states under its own ticket and its own `begin()` taken as it is sent, so it is
    // followed in turn when a write sent since was out as it went; the chain ends at the first read
    // sent with no write out. A read that fails applied nothing and is followed by nothing. A
    // follow-up that fails marks the lines grid's recovery read unavailable in the catch below, as
    // every failed read of the invoice does (the grid reads "This editor is unavailable.", with no
    // banner), shows no message and is not retried: the page keeps what it shows until the next
    // payload or a reload.
    const readInvoice = async (): Promise<InvoiceDetailData> => {
      const ticket = mutations.next();
      const recoveryRead = recoverySource.begin();
      // The writes out as this GET is sent. One sent after it holds a newer ticket, so the gate
      // already orders its answer against this read, and it is not waited for.
      const writesOut = writes.outstanding();
      let res: InvoiceMutationResult;
      try { res = await api<InvoiceMutationResult>(`/api/invoices/${id}`); }
      catch (error) { recoveryRead.unavailable(); throw error; }
      // Captured-session apply inside the accept branch (use-edit-guard.ts, the round-3 fixpoint).
      if (mutations.accept(ticket)) {
        void recoveryRead.accept(res.invoice);
        setInvoice(editGuard.applyPayload(res.invoice));
        setWarnings(res.warnings);
      }
      reReadAfter(writesOut, () => { void readInvoice().catch(() => {}); });
      return res.invoice;
    };
    return readInvoice();
  }, [id, mutations, editGuard, recoverySource, writes]);
  useEffect(() => {
    load().then(() => setError(null)).catch((e) => setError((e as Error).message));
  }, [load]);

  const applyMutation = useCallback(async (run: () => Promise<InvoiceMutationResult>) => {
    const ticket = mutations.next();
    const recoveryRead = recoverySource.begin();
    let res: InvoiceMutationResult;
    try {
      const request = run();
      // #573 (owner ruling 2026-10-20): registered at dispatch, in the same synchronous run as the
      // ticket, so the registry holds the write from the instant it is sent until its request
      // settles, however it ends: an answer, a refusal, no answer, a 401 or 403, or #547's unreadable
      // 2xx. The catch below rethrows, but the signal hangs on the request, not on this function. A
      // thunk that throws synchronously sent nothing and registers nothing; an async thunk that
      // rejects before its fetch registers a signal that settles at once, and a read sent in that
      // instant is followed once, for nothing. Neither happens here: every thunk returns `api()`'s
      // promise or is async.
      writes.dispatched(request);
      res = await request;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) recoveryRead.unavailable();
      // #547 (owner ruling 2026-10-18): a 2xx whose answer could not be read committed its write, so
      // History is told here as the success path below tells it (#158), and reads its own list.
      // Nothing is applied and the invoice itself is not read again (no `load`); the rejection still
      // reaches the caller, and the write's registry entry is deleted as its request settles, so a
      // `load` sent beside it reads once more after it (#573). As of 6e42469 every thunk run through
      // here sends one write and no read (a census, not a guarantee).
      if (error instanceof UnreadableAnswerError) invalidateHistory();
      throw error;
    }
    // #158 — success path, the instant the mutation resolves and BEFORE the accept gate: the five
    // actions that route through here (the lines save, the header PATCH, Recalculate, Finalize,
    // Unlock) each write an `invoice` row, and the server state has certainly changed even when
    // this response is superseded and its payload dropped. The panel at the bottom of this page
    // is that same entity.
    invalidateHistory();
    if (!mutations.accept(ticket)) return;
    void recoveryRead.accept(res.invoice);
    setInvoice(editGuard.applyPayload(res.invoice));
    setWarnings(res.warnings);
  }, [mutations, editGuard, recoverySource, writes]);

  const finalized = invoice?.status === "FINALIZED";
  const discarded = (invoice?.deletedAt ?? null) !== null;

  // #587 (Amendment 22): the step suggestions an operation line's description box offers, read in an
  // effect of its own, never inside `load` (so a write's payload, which lands on every save, reads
  // nothing again), and only for a live draft invoice. A failed read leaves every box a plain typing
  // box, with no message: the words can still be typed. Keyed on `id` and the one flag, so unlocking
  // a finalized invoice reads it, and nothing else does. Each run first clears the list it held, so
  // the grid is never handed a list read for another invoice, or read before this one was finalized.
  const [stepSuggestions, setStepSuggestions] = useState<InvoiceStepSuggestions | null>(null);
  const offersSteps = invoice !== null && offersStepSuggestions(invoice);
  useEffect(() => {
    setStepSuggestions(null);
    if (!offersSteps) return;
    let stale = false;
    api<InvoiceStepSuggestions>(`/api/invoices/${id}/step-suggestions`)
      .then((data) => { if (!stale) setStepSuggestions(data); })
      .catch(() => { if (!stale) setStepSuggestions(null); });
    return () => { stale = true; };
  }, [id, offersSteps]);

  const auditGate = gate(perms, "admin.view");
  const editGate = statusLocked(gate(perms, "invoicing.edit"), finalized, discarded);
  // §5.5/task-18-brief.md Step 3: money-bearing controls take BOTH invoicing.edit and
  // change_prices, computed once with the "whichever is actually the blocker" title (the
  // parts/[id]/PricingSection.tsx precedent), THEN status-locked on top — a user holding both
  // permissions still sees "Invoice is finalized" once that is the real blocker.
  const editGateRaw = gate(perms, "invoicing.edit");
  const priceGateRaw = gateDo(perms, "change_prices");
  const moneyDisabled = editGateRaw.disabled || priceGateRaw.disabled;
  const moneyGateRaw: Gate = {
    allowed: !moneyDisabled, disabled: moneyDisabled,
    title: editGateRaw.disabled ? editGateRaw.title : priceGateRaw.title,
  };
  const moneyGate = statusLocked(moneyGateRaw, finalized, discarded);

  // Unsaved line edits BLOCK the finalize (Codex P1, round 5). Finalize freezes the lines the
  // SERVER holds — it sends nothing local — so running it over an unsaved grid raises paper from
  // the previously saved lines while the operator is looking at different ones. Worse, the
  // finalized status that comes back disables the grid's own Save, so the local overlay is
  // stranded: it can no longer be committed, and the invoice is already issued. Refusing is the
  // only order of events that leaves the operator somewhere they can act from.
  const unsavedLines = useUnsavedPresent();
  const finalizeGate: Gate = discarded
    ? { allowed: false, disabled: true, title: "Invoice is discarded" }
    : finalized
      ? { allowed: false, disabled: true, title: "Already finalized" }
      : unsavedLines
        ? { allowed: false, disabled: true, title: "Save the line changes first — finalize freezes what the server holds" }
        : gate(perms, "invoicing.edit");
  const unlockGate: Gate = !finalized
    ? { allowed: false, disabled: true, title: "That invoice is not finalized — there is nothing to unlock" }
    : gateDo(perms, "unlock_invoice");
  const discardGate: Gate = discarded
    ? { allowed: false, disabled: true, title: "Already discarded" }
    : finalized
      ? { allowed: false, disabled: true, title: "Cannot discard a finalized invoice — unlock or credit it instead" }
      : gate(perms, "invoicing.delete");
  const creditGate: Gate = invoice && invoice.kind !== "INVOICE"
    ? { allowed: false, disabled: true, title: "A credit cannot itself be credited" }
    : !finalized
      ? { allowed: false, disabled: true, title: "Only a finalized invoice can be credited" }
      : gate(perms, "invoicing.create");
  // A credit's lines are derived from its source invoice with the sign flipped (§5.6) — recalculate
  // re-derives from the order at ordinary POSITIVE prices, which has no meaning for a credit and
  // would overwrite its negated lines. Kind check takes precedence over moneyGate's own reasons,
  // same shape as `creditGate` above.
  // Recalculate is the other shape of this hazard (Codex P1, round 7): not an archive but a
  // REPLACE. `recalculateInvoice` deletes and recreates the whole line set, so every existing row
  // id disappears and `useBulkGrid` drops the pending edit and removal overlays as orphans —
  // silently discarding typed MONEY. Same refusal.
  const recalcGate: Gate = invoice && invoice.kind === "CREDIT"
    ? { allowed: false, disabled: true, title: "A credit cannot be recalculated" }
    : unsavedLines
      ? { allowed: false, disabled: true, title: "Save the line changes first — a recalculate replaces every line" }
      : moneyGate;
  // Print (Task 19 — the route does not exist yet and 404s until then, per task-18-brief.md's
  // explicit license). Gated on the area's OWN .view permission, locked by "discarded" rather
  // than "finalized" (a finalized invoice prints — the stored-PDF case is the whole point) — the
  // ShipmentDetail.tsx `printGate`/DocumentsSection.tsx traveler-print precedent: both gate
  // printing on `<area>.view`, not `.edit`, and lock it only on the state that makes a NEW print
  // meaningless (voided there, discarded here — nothing to print from and nothing was ever
  // printed to fall back on).
  // Unsaved lines block PRINTING as well as finalizing (Codex P1, round 6). Gating only finalize
  // was half a fix: `printInvoice` sends no grid overlay either, so the endpoint renders and
  // ARCHIVES the server-side invoice — permanently filing a document that shows the old lines
  // while the screen shows the draft ones. Same hazard, same refusal.
  const printGate: Gate = discarded
    ? { allowed: false, disabled: true, title: "Invoice is discarded — nothing to print" }
    : unsavedLines
      ? { allowed: false, disabled: true, title: "Save the line changes first — a print archives what the server holds" }
      : gate(perms, "invoicing.view");
  const docsGate = gate(perms, "invoicing.view");

  // Discarded banner's reason — the order hub / ShipmentDetail `voidReason` precedent. Safe to
  // key on `discarded` alone: once discarded, no mutator can touch the invoice again. Since #153
  // this read is a capped union over the invoice's child sections (its applications), so the
  // delete entry is found by `entity`, not by position — see the order hub's fuller note.
  useEffect(() => {
    if (!discarded) { setDiscardReason(null); return; }
    if (!auditGate.allowed) { setDiscardReason(undefined); return; }
    api<{ rows: AuditEntry[]; hasMore: boolean }>(`/api/admin/audit?entity=invoice&entityId=${id}`)
      .then(({ rows }) => {
        const latest = rows.find((e) => e.entity === "invoice");
        setDiscardReason(latest?.action === "delete" ? (latest.reason ?? undefined) : undefined);
      })
      .catch(() => setDiscardReason(undefined));
  }, [discarded, auditGate.allowed, id]);

  // ---- Header: optimistic scalar PATCH (ShipmentDetail.tsx `patchHeader` precedent) ----

  const queue = useRef<Map<string, Promise<unknown>>>(new Map());
  function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = queue.current.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    queue.current.set(key, next.catch(() => {}));
    return next;
  }
  // Per-key REQUEST-settled signals for the failure drain below (Task 7 fix round 1): the drain
  // must never await the queue's chain TAILS — a tail settles only after its own catch, drain
  // included, completes, so two keys' saves both failing while overlapping had each catch
  // awaiting the other's tail: a mutual deadlock. A signal settles with its key's dispatched
  // request — which IS the commit/failure the rollback GET must postdate — and never depends on
  // a drain, so no cycle is possible (drain-queue.ts carries the full story).
  const inFlight = useRef<Map<string, Promise<unknown>>>(new Map());

  type HeaderPatch = { poNumber?: string; invoiceDate?: string; termsName?: string; billTo?: string; shipTo?: string };

  // A keystroke into a guarded detail object types through this pure updater, never an object
  // built from the render's copy, so a server payload landing beside the keystroke is kept (#574).
  function patchDraft(patch: Partial<InvoiceDetailData>) {
    setInvoice((cur) => (cur ? { ...cur, ...patch } : cur));
  }

  async function patchHeader(patch: HeaderPatch): Promise<boolean> {
    setInvoice((cur) => (cur ? { ...cur, ...patch } : cur));
    // A multi-field patch's composite key would NOT serialize against its constituent
    // single-field keys — latent only: every caller PATCHes one field per save.
    const key = Object.keys(patch).sort().join(",");
    return serial(key, async () => {
      try {
        const req = applyMutation(() => api<InvoiceMutationResult>(
          `/api/invoices/${id}`, { method: "PATCH", body: JSON.stringify(patch) }));
        inFlight.current.set(key, req.then(() => {}, () => {})); // request-settled signal, at dispatch
        await req;
        setError(null);
        // The one Saved mark (R7): each field this save carried reads Saved while its box shows it.
        for (const [field, value] of Object.entries(patch)) savedMarks.mark(field, String(value ?? ""));
        return true;
      } catch (e) {
        // §5.13 rollback-drain (Task 7): wait out every OTHER key's in-flight request before
        // the rollback GET — served before a sibling key's PATCH commits, the newest-ticket GET
        // would revert that sibling's committed write on screen (its own response then drops as
        // older-ticketed). Drains the request-settled SIGNALS above, never the queue tails
        // (fix round 1 — mutual deadlock; drain-queue.ts carries the full story). The rollback
        // read is `load`, which re-reads after any registered write that was out as it was sent
        // (#573): a drained sibling's registry entry is gone before the GET snapshots it, so the
        // drain keeps only its timing effect, and the writes it never saw (the lines save,
        // Recalculate, Finalize, Unlock) are what the follow-up covers.
        await drainOtherKeys(inFlight.current, key);
        await load().catch(() => {});
        setError((e as Error).message);
        return false;
      }
    });
  }

  // ---- Lifecycle actions ----

  // #651 (P11 step 1): the three one-shot writes below hold the page busy while their own request
  // is out. A double-click on Create credit used to commit a second DRAFT credit and consume a credit
  // number for good; on Finalize or Recalculate it ended a success with a red refusal. The hold is
  // a ref checked first, so a same-tick second click is refused before any state lands, with state
  // beside it for the labels and `disabled=`. Kept out of `editGate` and `recoveryGate`: the header
  // boxes stay editable while Finalize is held (invoice-shipped-order.mjs types beside it).
  const busyRef = useRef<InvoiceBusy>(null);
  const [busy, setBusy] = useState<InvoiceBusy>(null);
  function hold(kind: Exclude<InvoiceBusy, null>): boolean {
    if (busyRef.current !== null) return false;
    busyRef.current = kind;
    setBusy(kind);
    return true;
  }
  function release() {
    busyRef.current = null;
    setBusy(null);
  }

  // Recalculate's and Finalize's own message, under their buttons (owner ruling R1, P6 step 5b):
  // each acts on the Totals section it sits in, so its refusal shows there, never in the banner.
  const [totalsMessage, setTotalsMessage] = useState<string | null>(null);

  async function recalculate() {
    if (!hold("recalc")) return;
    try {
      await applyMutation(() => api<InvoiceMutationResult>(`/api/invoices/${id}/recalculate`, { method: "POST" }));
      setTotalsMessage(null);
    } catch (e) {
      setTotalsMessage((e as Error).message);
    } finally { release(); }
  }

  async function finalize() {
    if (!hold("finalize")) return;
    try {
      await applyMutation(() => api<InvoiceMutationResult>(`/api/invoices/${id}/finalize`, { method: "POST" }));
      setTotalsMessage(null);
    } catch (e) {
      setTotalsMessage((e as Error).message);
    } finally { release(); }
  }

  async function unlock() {
    if (!invoice) return;
    // Ruling 5 (PR 6): the modal holds a blank reason open with this page's own sentence; Cancel
    // resolves null, as the native dialog did, so the null check below is unchanged.
    const reason = await askReason({
      question: `Unlock ${INVOICE_KIND_LABELS[invoice.kind]} ${invoice.documentNumber}?\n\n` +
        "It returns to Draft and every editing control unlocks; the order returns to its " +
        "ship-derived status.",
      verb: "unlocking", blankRefusal: "A reason is required to unlock an invoice.",
    });
    if (reason === null) return; // cancelled
    try {
      await applyMutation(() => api<InvoiceMutationResult>(
        `/api/invoices/${id}/unlock`, { method: "POST", body: JSON.stringify({ reason }) }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Non-optimistic and NOT routed through applyMutation — see the file's top comment: the
  // response describes a different document (the new credit), not this invoice. The third action
  // that navigates after its write (#651, the #568/#581 shape of InvoicesSection's Create invoice
  // and ShipmentDetail's Reverse): the departure attempt is captured before the request and
  // followed only while it is current; a request that lands after its departure was cancelled
  // adopts nothing and reads this invoice again, busy until that read settles; a refusal releases
  // the hold; a push that happened keeps it, since the page is leaving.
  async function raiseCredit() {
    if (busyRef.current !== null) return;
    const token = navigationLifetime.current;
    const request = {};
    token.request = request;
    const owner = peekBrowserDraftSession()?.store.getSnapshot().owner;
    const ownRequest = () => {
      const fresh = peekBrowserDraftSession()?.store.getSnapshot();
      return token.live && navigationLifetime.current === token && token.request === request &&
        !!owner && fresh?.identityReady === true && fresh.owner?.userId === owner.userId &&
        fresh.owner.authGeneration === owner.authGeneration;
    };
    const attempt = captureDiscardNavigation(() => token.live && navigationLifetime.current === token);
    if (!attempt || !ownRequest()) { attempt?.cancel(); return; }
    // Ruling 5 (PR 6): the discard question through the modal, the attempt and the owner re-checked
    // after its answer, as before (the shipment page's Reverse, PR 4).
    if (!(await askDiscard())) { attempt.cancel(); return; }
    if (!attempt.isCurrent() || !ownRequest()) { attempt.cancel(); return; }
    if (!hold("credit")) { attempt.cancel(); return; }
    let res: InvoiceMutationResult;
    try {
      res = await api<InvoiceMutationResult>(`/api/invoices/${id}/credit`, { method: "POST" });
    } catch (e) {
      if (ownRequest()) {
        if (attempt.isCurrent()) {
          release();
          setError((e as Error).message);
        } else {
          // The credit may have been raised: read this invoice again, busy until the read settles.
          void load().then(() => { if (ownRequest()) release(); }, () => { if (ownRequest()) release(); });
        }
      }
      attempt.cancel();
      return;
    }
    if (!ownRequest()) return;
    if (!attempt.isCurrent()) { void load().then(() => { if (ownRequest()) release(); }, () => { if (ownRequest()) release(); }); return; }
    try {
      if (!attempt.attach(`/invoicing/${res.invoice.id}`)) { release(); return; }
      router.push(`/invoicing/${res.invoice.id}`);
    } catch {
      if (ownRequest() && attempt.isCurrent()) {
        setError("Credit created, but navigation failed. Open it from the Invoicing list.");
      }
      attempt.cancel();
      release();
    }
  }

  async function discard() {
    if (!invoice) return;
    const reason = await askReason({
      question: `Discard ${INVOICE_KIND_LABELS[invoice.kind]} ${invoice.documentNumber}?\n\n` +
        "This frees the order for a new invoice and cannot be undone through the UI.",
      verb: "discarding", blankRefusal: "A reason is required to discard an invoice.",
    });
    if (reason === null) return; // cancelled
    // Two separate try/catches (the ShipmentDetail.tsx `voidAction` precedent): DELETE returns
    // `{ ok: true }`, not a fresh detail, so picking up `deletedAt` needs a follow-up `load()` —
    // and if THAT fails, the discard itself still succeeded.
    try {
      await api(`/api/invoices/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
    } catch (e) {
      // #547 (owner ruling 2026-10-18): a 2xx proves the discard committed, and its answer holds
      // only `{ ok: true }`, so an answer that could not be read falls through to the success path
      // below. Any other failure shows its message and stops.
      if (!(e instanceof UnreadableAnswerError)) {
        setError((e as Error).message);
        return;
      }
    }
    // #158 — success path, before the follow-up load. The discard is an `auditedSoftDelete`
    // carrying the typed reason, and this page stays mounted (read-only) to show it.
    invalidateHistory();
    setError(null);
    try {
      await load();
    } catch (e) {
      setError(`Invoice discarded, but the page could not be refreshed — reload to see the current state. (${(e as Error).message})`);
    }
  }

  // ---- Print (Task 19; #588) ----
  //
  // Print opens a blank tab in the click itself, before the request, and fills it with the stored
  // copy (`/api/documents/<x-document-id>`) when the print lands (#588, owner ruling 2026-10-20):
  // a finalized print's answer waits for its copy in the customer's folder, up to 10 seconds, and
  // Chrome, Edge and Firefox block a tab a page opens more than about 5 seconds after the click
  // (inferred, not measured), so the tab opens however long the copy holds the answer
  // (`src/lib/print-tab.ts`). The answer's body is not read: the tab reads the stored bytes. A
  // refused print closes the blank tab before it reads the refusal, and its throw reaches the catch,
  // whose second close of the closed tab does nothing; a request that failed closes it in the catch;
  // each shows its message as before. A blocked tab, or an answer with no document id, says the
  // print is in Documents & history, and only once the print has landed. A finalized print the route
  // did not file is one amber line (`x-print-warnings`), cleared at the next Print. Documents is
  // bumped after `show`, so a browser flow that waits for the new Documents link before it closes
  // the tab closes it after `show`.

  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const [printWarning, setPrintWarning] = useState<string | null>(null);
  const [docsRefresh, setDocsRefresh] = useState(0);
  // PR 6: the documents read is the page's (one read: the list draws it, the card reads the newest
  // print from it), gated as the list was and bumped by every successful print as before.
  const documents = useStoredDocuments<StoredDoc>(`/api/invoices/${id}/documents`, docsGate.allowed, docsRefresh);

  async function printInvoice() {
    const tab = openPendingTab(window);
    setPrinting(true);
    setPrintError(null);
    setPrintWarning(null);
    try {
      const res = await trackedFetch(`/api/invoices/${id}/print`, { method: "POST" });
      if (!res.ok) {
        tab.close();
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Print failed (${res.status})`);
      }
      // A body that failed in transit rejects its cancel; nothing waits on it.
      void res.body?.cancel().catch(() => {});
      const docId = res.headers.get("x-document-id");
      if (docId) tab.show(`/api/documents/${docId}`);
      else tab.close();
      if (tab.blocked || !docId) {
        setPrintError("The browser blocked the print window — the document was archived and is in Documents & history.");
      }
      setPrintWarning(printWarningSentence(res.headers.get("x-print-warnings")));
      setDocsRefresh((n) => n + 1);
    } catch (e) {
      tab.close();
      setPrintError((e as Error).message);
    } finally {
      setPrinting(false);
    }
  }

  if (!invoice) return <PageStatus error={error ?? permsError} />;

  const labels = invoiceActionLabels(invoice.kind);
  // One string (a credit's own number first, then the status, the customer and the order), so the
  // card's Status row is the page's one node reading exactly "Draft" or "Finalized" (the flows
  // wait on it by that text).
  const subtitle = [
    ...(invoice.kind === "CREDIT" ? [`Credit ${invoice.documentNumber}`] : []),
    INVOICE_STATUS_LABELS[invoice.status],
    ...(discarded ? ["Discarded"] : []),
    `${invoice.customerCode} · ${invoice.customerName}`,
    `Order #${invoice.orderNumber}`,
  ].join(" · ");
  // The newest print the page's documents read holds, judged as the list's Printed is (#591,
  // `printedSince`): a draft's newest print, a finalized invoice's newest since it was finalized.
  const newestPrint = documents.status === "rows"
    ? documents.docs.reduce<Date | null>((newest, d) => {
      const at = new Date(d.createdAt);
      return newest === null || at > newest ? at : newest;
    }, null)
    : null;
  const printedAt = documents.status === "rows"
    ? printedSince(invoice.finalizedAt ? new Date(invoice.finalizedAt) : null, newestPrint)
    : null;

  return (
    <div className="min-w-0 p-3 sm:p-6">
      {/* The title row (spec §4.3; PR 6): Finalize the primary, Print beside it, the three other
          actions in More actions, Discard the title-row danger action (ruling 8). The labels name
          the document's kind (src/lib/invoice-tabs.ts). */}
      <PageHeader title={invoiceTitle(invoice)} subtitle={subtitle}
        actions={<>
          <button onClick={() => void finalize()} disabled={!finalizeGate.allowed || busy !== null} title={finalizeGate.title}
                  className={BUTTON_PRIMARY}>
            {busy === "finalize" ? "Finalizing…" : labels.finalize}
          </button>
          <button onClick={() => void printInvoice()} disabled={!printGate.allowed || printing} title={printGate.title}
                  className={BUTTON_NEUTRAL}>
            {printing ? "Printing…" : labels.print}
          </button>
          <ActionMenu items={[
            { label: busy === "recalc" ? "Recalculating…" : labels.recalculate, disabled: !recalcGate.allowed || busy !== null, title: recalcGate.title, onSelect: () => void recalculate() },
            { label: busy === "credit" ? "Creating…" : labels.credit, disabled: !creditGate.allowed || busy !== null, title: creditGate.title, onSelect: () => void raiseCredit() },
            { label: labels.unlock, disabled: !unlockGate.allowed, title: unlockGate.title, onSelect: () => void unlock() },
          ]} />
          <DangerButton onClick={() => void discard()} disabled={!discardGate.allowed} title={discardGate.title}>
            {labels.discard}
          </DangerButton>
        </>} />

      {(error ?? permsError) && (
        <p className={`${NOTICE.refusal} mb-3 whitespace-pre-line`}>{error ?? permsError}</p>
      )}
      {discarded && (
        <p className={`${NOTICE.refusal} mb-3 font-medium`}>
          Discarded — {discardReason ?? "see History for the reason"}
        </p>
      )}
      {warnings.length > 0 && (
        <ul className={`${NOTICE.warning} mb-3 list-disc space-y-0.5 pl-7`}>
          {warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}

      <div className="flex flex-col gap-6 min-[1360px]:flex-row min-[1360px]:items-start">
      <div className="min-w-0 flex-1">
      {/* Three tabs over the mounted sections (spec §4.4; src/lib/invoice-tabs.ts): the grid's
          registry label badges Lines, and a tab switch is never a departure. */}
      <RecordTabs label={INVOICE_TAB_LABEL} tabs={invoiceTabs()} panels={{
        header: (
      <>
      {/* ---- Header ---- */}
      <section id="header" className={`${CARD} mb-6`}>
        <h2 className="mb-2 font-medium">Header</h2>
        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
          <div className="block">
            Customer
            <div className="mt-1 rounded border bg-surface-50 px-2 py-1">
              <Link href={`/customers/${invoice.customerId}`} className={LINK}>
                {invoice.customerCode} · {invoice.customerName}
              </Link>
            </div>
          </div>
          <div className="block">
            Order
            <div className="mt-1 rounded border bg-surface-50 px-2 py-1">
              <Link href={`/orders/${invoice.orderId}`} className={LINK}>
                #{invoice.orderNumber}
              </Link>
            </div>
          </div>
          {invoice.kind === "CREDIT" && invoice.sourceInvoiceId && (
            <div className="block">
              Credit for
              <div className="mt-1 rounded border bg-surface-50 px-2 py-1">
                <Link href={`/invoicing/${invoice.sourceInvoiceId}`} className={LINK}>
                  source invoice
                </Link>
              </div>
            </div>
          )}
          <label className="block">
            PO number<SavedMark label="PO number" show={savedMarks.shows("poNumber", invoice.poNumber)} />
            <input aria-label="PO number" value={invoice.poNumber} onFocus={editGuard.onFocusField("poNumber")} readOnly={!editGate.allowed} title={editGate.title}
                   onChange={(e) => patchDraft({ poNumber: e.target.value })}
                   onBlur={(e) => editGuard.onBlurSave(e, (poNumber) => void patchHeader({ poNumber }))}
                   onKeyDown={(e) => editGuard.onEnterCommit(e, (poNumber) => void patchHeader({ poNumber }))}
                   className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
          </label>
          <label className="block">
            Terms<SavedMark label="Terms" show={savedMarks.shows("termsName", invoice.termsName)} />
            <input aria-label="Terms" value={invoice.termsName} onFocus={editGuard.onFocusField("termsName")} readOnly={!editGate.allowed} title={editGate.title}
                   onChange={(e) => patchDraft({ termsName: e.target.value })}
                   onBlur={(e) => editGuard.onBlurSave(e, (termsName) => void patchHeader({ termsName }))}
                   onKeyDown={(e) => editGuard.onEnterCommit(e, (termsName) => void patchHeader({ termsName }))}
                   className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
          </label>
          <label className="block">
            Invoice date
            <input type="date" value={invoice.invoiceDate} disabled={!editGate.allowed} title={editGate.title}
                   onChange={(e) => void patchHeader({ invoiceDate: e.target.value })}
                   className={`${INPUT_COMPACT} mt-1 w-full disabled:bg-surface-50`} />
          </label>
          <label className="block">
            Bill to
            <textarea value={invoice.billTo} rows={3} onFocus={editGuard.onFocusField("billTo")} readOnly={!editGate.allowed} title={editGate.title}
                      onChange={(e) => patchDraft({ billTo: e.target.value })}
                      onBlur={(e) => editGuard.onBlurSave(e, (billTo) => void patchHeader({ billTo }))}
                      className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
          </label>
          <label className="block">
            Ship to
            <textarea value={invoice.shipTo} rows={3} onFocus={editGuard.onFocusField("shipTo")} readOnly={!editGate.allowed} title={editGate.title}
                      onChange={(e) => patchDraft({ shipTo: e.target.value })}
                      onBlur={(e) => editGuard.onBlurSave(e, (shipTo) => void patchHeader({ shipTo }))}
                      className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
          </label>
          <div className="block">
            Material / process
            <div className="mt-1 rounded border bg-surface-50 px-2 py-1 text-ink-500">
              {invoice.materialName || "—"}{invoice.processNames ? ` · ${invoice.processNames}` : ""}
            </div>
          </div>
          <div className="block">
            Tax rate
            <div className="mt-1 rounded border bg-surface-50 px-2 py-1 text-ink-500">
              {/* #227: `taxRate` is the FROZEN fraction snapshot (0.07 = 7%); the old template
                  printed "0.07%", understating the rate 100×. Read-side formatting only. */}
              {invoice.taxRate === null ? "Not taxable" : `${percentFromFraction(invoice.taxRate)}%`}
            </div>
          </div>
        </div>
      </section>

      </>
        ),
        lines: (
      <div id="lines">
      <InvoiceLinesGrid invoiceId={id} lines={invoice.lines} kind={invoice.kind} stepSuggestions={stepSuggestions} moneyGate={moneyGate} recoverySource={recoverySource} applyMutation={applyMutation} readOnly={finalized} />
      {!finalized && !discarded && (
        <RemovedLinesList invoiceId={id} removedLines={invoice.removedLines} gate={moneyGate} applyMutation={applyMutation} />
      )}

      </div>
        ),
        documents: (
      <>
      {/* ---- Documents + History (brief Step 5) ---- */}
      <section id="documents" className={`${CARD} mb-6`}>
        <h2 className="mb-2 font-medium">Documents</h2>
        <InvoiceDocumentsList documents={documents} viewGate={docsGate} />
      </section>
      <div id="history" className="mb-6">
        <HistoryPanel entity="invoice" entityId={id} perms={perms} permsError={permsError} />
      </div>
      </>
        ),
      }} />
      </div>

      {/* The card reads the loaded record (the seven totals that were the Totals section's) and
          holds Recalculate's and Finalize's message (owner ruling R1, P6 step 5b: their own slot,
          never the banner) and the print's messages beside the header's controls. */}
      <AtAGlance rows={[
        { label: "Customer", value: <Link href={`/customers/${invoice.customerId}`} className={LINK}>{invoice.customerCode} · {invoice.customerName}</Link> },
        { label: "Order", value: <Link href={`/orders/${invoice.orderId}`} className={`${LINK} font-mono`}>#{invoice.orderNumber}</Link> },
        { label: "Status", value: discarded ? "Discarded" : INVOICE_STATUS_LABELS[invoice.status] },
        // A landed read with no prints ("empty") is Not printed; only an unlanded one reads "—".
        { label: "Printed", value: documents.status === "rows" || documents.status === "empty" ? (printedAt ? formatDateTime(printedAt) : "Not printed") : "—" },
        { label: "Operations", value: <span className="tabular-nums">{formatMoney(invoice.subtotal)}</span> },
        { label: "Surcharges", value: <span className="tabular-nums">{formatMoney(invoice.surchargeTotal)}</span> },
        { label: "Charges", value: <span className="tabular-nums">{formatMoney(invoice.chargeTotal)}</span> },
        { label: "Certification", value: <span className="tabular-nums">{formatMoney(invoice.certTotal)}</span> },
        { label: "Freight", value: <span className="tabular-nums">{formatMoney(invoice.freightTotal)}</span> },
        { label: "Tax", value: <span className="tabular-nums">{formatMoney(invoice.taxTotal)}</span> },
        { label: "Invoice total", value: <span className="tabular-nums">{formatMoney(invoice.total)}</span> },
      ]}>
        <div className="mt-4 flex flex-col gap-2 text-xs">
          <PanelMessage message={totalsMessage} />
          {printError && <p className={NOTICE.refusal}>{printError}</p>}
          {printWarning && <p className={NOTICE.warning}>{printWarning}</p>}
        </div>
      </AtAGlance>
      </div>
    </div>
  );
}
