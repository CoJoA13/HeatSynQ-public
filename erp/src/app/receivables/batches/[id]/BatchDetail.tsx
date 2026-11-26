"use client";
import { formatDate, formatMoney } from "@/lib/format";
import { decimalRefusal } from "@/lib/decimal-entry";
import { PAYMENT_AMOUNT } from "@/lib/money-boxes";
import { paymentApplyPayload } from "@/lib/payment-apply-payload";
// The batch entry + apply screen (design spec §11 "/receivables"; task-13-brief.md Step 2).
// Remounted per id by page.tsx's `key={id}` (HANDOFF §5.12) — every field below binds straight
// to `batch`, so a fresh instance per batch id never carries one batch's state onto another's.
//
// THE BINDING STATE MODEL — copied from `InvoiceDetail.tsx` verbatim (task-13-brief.md's explicit
// precedent), not reinvented: one monotonic mutation ticket (`useMutationGate`) shared by every
// write AND by `load` itself, so overlapping calls resolve to whichever is genuinely newest;
// `useEditGuard` merges every arriving server detail over `batch` (there is no free-text header
// field on a `ReceiptBatch` today — `notes` has no edit route — but every "apply a server detail"
// call site still routes through `merge` so a future editable field costs nothing here); the
// apply panel's invoice picker is a `useBulkGrid` instance (below), the `InvoiceLinesGrid`
// "several edited rows submitted as ONE call" shape, even though its rows are not their own
// persisted entities; `gate`/`gateDo` from permission-ui gate every control.
import { Fragment, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api, ApiError, UnreadableAnswerError } from "@/lib/fetcher";
import { gate, gateDo, type Gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useMutationGate } from "@/lib/use-latest";
import { useEditGuard } from "@/lib/use-edit-guard";
import { useBulkGrid } from "@/lib/bulk-grid";
import { formatDateOnly, todayDateOnly } from "@/lib/business-days";
import { HistoryPanel, invalidateHistory } from "@/components/HistoryPanel";
import { DangerButton } from "@/components/DangerButton";
import { useUnsavedSection, askDiscard } from "@/lib/use-unsaved-section";
import { DraftRecoveryNotice } from "@/components/DraftRecoveryNotice";
import { createBulkRecoverySource, readBulkPermissions } from "@/lib/bulk-recovery-source";
import { getBrowserDraftSession, peekBrowserDraftSession } from "@/lib/draft-session";
import { useDraftIdentity } from "@/lib/use-recoverable-draft";
import { toApplyFields, paymentBulkOptions, paymentDraftStamps, consumeSelectedPayment, type ApplyLineFields, type PaymentCandidate, type PaymentBulkSource } from "@/lib/payment-bulk-recovery";
import { DiscardButton } from "@/components/DiscardButton";
import {
  RECEIPT_BATCH_STATUS_LABELS, APPLICATION_TYPE_LABELS,
  type ReceiptBatchStatusValue, type ApplicationTypeValue,
} from "@/lib/ar-constants";
import { newId } from "@/lib/client-id";
import { PageStatus } from "@/components/PageStatus";
import { PanelMessage } from "@/components/PanelMessage";
import { gridAtRest, useMessageClearedAtRest } from "@/lib/grid-message";
import { UnsavedBadge } from "@/components/UnsavedBadge";
import { askConfirm, askReason } from "@/lib/modal";
import { PageHeader } from "@/components/PageHeader";
import { RecordTabs } from "@/components/RecordTabs";
import { AtAGlance } from "@/components/AtAGlance";
import { ActionMenu } from "@/components/ActionMenu";
import { RECEIPT_BATCH_TAB_LABEL, balanceText, batchSubtitle, controlTotalText, postConfirm, receiptBatchTabs } from "@/lib/receipt-batch-page";
import { BUTTON_PRIMARY, BUTTON_PRIMARY_COMPACT, CARD, INPUT_COMPACT, LINK, NOTICE } from "@/lib/ui-classes";
import { Combobox } from "@/components/Combobox";
import { customerOptions } from "@/lib/menu-options";
import { inMenuOrder } from "@/lib/menu-order";

// ---------------------------------------------------------------------------------------------
// Types. Local mirrors of src/server/receipts.ts's `BatchDetail`/`PaymentRow` and
// src/server/applications.ts's `OpenInvoiceRow` — not imported from src/server/** (CLAUDE.md: a
// client component pulling from there drags node:async_hooks and Prisma into the browser
// bundle). Named `BatchDetailData`, not `BatchDetail` — the component below is `BatchDetail`
// (task-13-brief.md's exact file/component name), and the two would collide (the
// `InvoiceDetail.tsx` / `InvoiceDetailData` precedent).
// ---------------------------------------------------------------------------------------------

/** `src/server/receipts.ts`'s `PaymentApplicationRow` — Fix #11 (Round 4 correction-path): the
 *  live applications a payment carries, so this screen can list AND void them (the whole-branch
 *  fix made `voidPayment` refuse a payment with live applications, so this is the only way to
 *  correct a mis-applied payment). */
type PaymentApplicationRow = {
  id: string; type: ApplicationTypeValue; amount: number; invoiceId: string; invoiceDocumentNumber: string;
};

export type PaymentRow = {
  id: string; customerId: string; customerCode: string; customerName: string;
  paymentTypeId: string; paymentTypeName: string; amount: number; reference: string; receivedDate: string;
  onAccount: number; applications: PaymentApplicationRow[];
};

/** `balance` mirrors the server's `number | null` (#163): null = no control total, so nothing has
 *  been proved. It is a THIRD state, rendered distinctly from a proved 0 in the header tile below. */
export type BatchDetailData = {
  id: string; batchNumber: number; depositDate: string; controlTotal: number | null;
  status: ReceiptBatchStatusValue; enteredTotal: number; balance: number | null; notes: string;
  payments: PaymentRow[]; deletedAt: string | null;
};

/** `src/server/applications.ts`'s `OpenInvoiceRow` — the apply panel's invoice picker. */
export type OpenInvoiceRow = {
  id: string; orderId: string; orderNumber: number; documentNumber: string;
  customerId: string; customerCode: string; customerName: string;
  invoiceDate: string; dueDate: string | null; total: number; open: number;
};

type CustomerOption = { id: string; code: string; name: string };
/** `src/server/picklists.ts`'s `PickListRow` — the payment-type picker (`/api/picklists/paymentType`,
 *  session-only gated, the `customers/[id]/page.tsx` Terms-picker precedent). */
type PickListRow = { id: string; name: string; active: boolean };

/** A POSTED batch locks EDITING THE PAYMENT LIST — the 5A `statusLocked` shape (InvoiceDetail.tsx),
 *  applied to `ReceiptBatch.status` rather than an invoice's finalized/discarded pair. Applied to
 *  add-payment/void-payment only — `receipts.ts`'s `refusePosted` covers both directly, so this
 *  screen locks the SAME two controls, never more. Fix #7 (Round 4 correction-path, spec §5.2):
 *  on-account cash "is appliable to a later invoice from the same payment at any time (even after
 *  its batch is POSTED)" — `applyPayment` (applications.ts) itself performs no batch-status check,
 *  and this screen must not add one either, so apply/discount/write-off are deliberately NOT run
 *  through this helper (they stay gated by `receivables.create`/`write_off` alone). Nor is it
 *  applied to voiding one APPLICATION (Fix #11): correcting a misapplication is not editing the
 *  payment list, and `voidApplication` itself performs no batch-status check either.
 *
 *  Voiding the BATCH is now posted-locked too (issue #68) but still computes its own gate below,
 *  because it carries a SECOND reason to be disabled (live payments) and §5.16 wants the tooltip to
 *  name whichever one is actually blocking — "Reopen the batch first" and "Void every payment
 *  first" send the operator to different places. */
function statusLocked(g: Gate, posted: boolean): Gate {
  if (posted) return { allowed: false, disabled: true, title: "Batch is posted" };
  return g;
}

// ---------------------------------------------------------------------------------------------
// ApplyPanel — one payment's apply-and-settle grid (design spec: "apply a payment across one or
// more invoices, including across the divisions of a parent customer"; task-13-brief.md: "an
// amount input, a 'take discount' affordance shown only when the server offers a figure — with a
// hint in its place when a bigger remittance would earn one, #155 arm 2 — and a
// write-off input (reason required)"). `useBulkGrid` composes the payer's/family's open finalized
// invoices — fetched fresh whenever the panel opens or a submission lands — with whatever the
// operator has typed so far, the `InvoiceLinesGrid` shape (a whole batch of edited rows submitted
// as ONE call), even though these rows are not their own persisted entities: the same "edit
// several rows, then Save sends the lot" architecture applies, and reuses the same
// orphan-detection if the candidate set changes under the operator mid-edit.
// ---------------------------------------------------------------------------------------------

function ApplyPanel({
  batchId, payment, recoverySource, moneyGate, writeOffGate, voidApplicationGate, onApplied,
}: {
  batchId: string; payment: PaymentRow; recoverySource: PaymentBulkSource;
  moneyGate: Gate;
  writeOffGate: Gate;
  /** Fix #11 — gates the per-application "Void" action. Deliberately not `statusLocked`: correcting
   *  a misapplication is not editing the payment list (see `statusLocked`'s own comment). */
  voidApplicationGate: Gate;
  /** Tells the parent to refresh the whole batch (every payment's `onAccount` is derived, so any
   *  successful apply anywhere can move it). */
  onApplied: () => void;
}) {
  const [applying, setApplying] = useState(false);
  const [voidingApplicationId, setVoidingApplicationId] = useState<string | null>(null);
  const candidates: PaymentCandidate[] = [];
  // The hook's authorized projection owns the candidate rows and readiness. A
  // fulfilled catch-all Promise<void> is never treated as a fresh candidate read.
  const grid = useBulkGrid(candidates, toApplyFields, paymentBulkOptions(recoverySource, batchId, payment.id));
  useUnsavedSection(grid.dirty, "Payment application");
  // This panel's own message (owner ruling R1, P6 step 5b): Apply's validation, a refused or failed
  // Apply and a refused application void show inside the expanded row, through the shared
  // PanelMessage, where they used to write the page banner. The setter keeps the name `onError`
  // that the handlers and the tests that lift them read. It goes when the grid comes to rest
  // (src/lib/grid-message.ts), and with the panel when Hide closes it.
  const [applyMessage, onError] = useState<string | null>(null);
  useMessageClearedAtRest(gridAtRest(grid.dirty, grid.canEdit), onError);
  const loaded = grid.view.mode === "editing";
  const loadError = grid.view.mode === "unavailable" ? "Read access or current payment details could not be confirmed." : null;

  const rows = grid.rows;
  const baseline = grid.view.mode === "editing" ? grid.view.current?.baseline : grid.view.savedBaseline;
  const recoveryWriteOffGate: Gate = baseline?.context.writeOff === true ? writeOffGate
    : { allowed: false, disabled: true, title: "Requires write_off" };

  function patchRow(row: { key: string }, patch: Partial<ApplyLineFields>) {
    grid.updateExisting(row.key, patch);
  }

  async function apply() {
    // Every typed Amount and Write-off is read through the decimal rule against the apply route's
    // box, and every refusal is listed at once (src/lib/payment-apply-payload.ts). The server stays
    // the validator.
    const prepared = paymentApplyPayload(rows, recoveryWriteOffGate);
    if (!prepared.ok) { onError(prepared.error); return; }
    const lines = prepared.lines;

    const binding = grid.binding;
    if (!binding || !grid.canEdit || !moneyGate.allowed) return;
    const submission = binding.capture({ paymentId: payment.id, lines }, newId());
    setApplying(true);
    try {
      if (!binding.dispatched(submission)) throw new Error("This draft is no longer available to apply.");
      try {
        await api("/api/receivables/applications", { method: "POST", body: JSON.stringify(submission.payload) });
      } catch (error) {
        binding.settle(submission, { kind: error instanceof ApiError && error.status >= 400 && error.status < 500 ? "rejected" : "unknown" });
        throw error;
      }
      // Raw POST success is final before history, parent callbacks or follow-up
      // reads. The later balance cannot establish the result of an unknown POST.
      binding.settle(submission, { kind: "persisted", response: submission.submitted.baseline });
      // #14 item 1, extended by #153: `application` is a registered child of the batch panel
      // (reached through its payment). Success path, before the follow-up load.
      invalidateHistory();
      onError(null);
      onApplied();
      // useBulkGrid starts the required complete read from needsRefresh.
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setApplying(false);
    }
  }

  // Fix #11 — void one live application (correcting a mis-applied payment). `voidApplication`
  // (applications.ts) trims and requires the reason itself; this mirrors `voidPaymentAction`'s own
  // prompt/confirm shape below. On success, `onApplied()` refreshes the whole batch — the invoice's
  // open balance and this payment's on-account are both derived, so both update from that one call.
  async function voidApplicationAction(app: PaymentApplicationRow) {
    const reason = await askReason({
      question: `Void the ${APPLICATION_TYPE_LABELS[app.type]} application of ${formatMoney(app.amount)} against ` +
        `invoice ${app.invoiceDocumentNumber}?`,
      verb: "voiding", blankRefusal: "A reason is required to void an application.",
    });
    if (reason === null) return; // cancelled
    if (!reason.trim()) { onError("A reason is required to void an application."); return; }
    setVoidingApplicationId(app.id);
    try {
      await api(`/api/receivables/applications/${app.id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
      invalidateHistory(); // #14 item 1
      onError(null);
      onApplied();
      // The parent accepted batch read revalidates this panel and its discounts.
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setVoidingApplicationId(null);
    }
  }

  // "the unapplied remainder shown as on-account" (task-13-brief.md) — `onAccount` is already
  // derived server-side (`ar-balances.paymentOnAccount`) and refreshes on every batch reload.
  const applied = payment.amount - payment.onAccount;
  const disabled = applying || !grid.canEdit;

  return (
    <div className="mt-2 rounded border bg-surface-50 p-3">
      {grid.recoveryNotice && <DraftRecoveryNotice {...grid.recoveryNotice} />}
      <p className="mb-2 text-sm text-ink-500 tabular-nums">
        Payment {formatMoney(payment.amount)} · Applied {formatMoney(applied)} · On account {formatMoney(payment.onAccount)}
      </p>
      {payment.applications.length > 0 && (
        <div className="mb-3 overflow-x-auto rounded border bg-surface-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-ink-500">
                <th className="py-1 pl-2 pr-2 font-medium">Invoice</th>
                <th className="pr-2 font-medium">Type</th>
                <th className="text-right pr-2 font-medium">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {payment.applications.map((a) => (
                <tr key={a.id} className="border-t">
                  <td className="py-1 pl-2 pr-2 font-mono">{a.invoiceDocumentNumber}</td>
                  <td className="pr-2">{APPLICATION_TYPE_LABELS[a.type]}</td>
                  <td className="tabular-nums pr-2 text-right">{formatMoney(a.amount)}</td>
                  <td className="pr-2 text-right">
                    <button onClick={() => void voidApplicationAction(a)}
                            disabled={!voidApplicationGate.allowed || voidingApplicationId === a.id}
                            title={voidApplicationGate.title}
                            className="text-xs text-red-600">
                      {voidingApplicationId === a.id ? "Voiding…" : "Void"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {loadError && <p className="mb-2 text-sm text-red-700">Could not load open invoices: {loadError}</p>}
      {grid.orphanWarning && <p className={`${NOTICE.warning} mb-2`}>{grid.orphanWarning}</p>}
      {rows.length === 0 && loaded && !loadError && (
        <p className="text-sm text-ink-500">No open invoices for this payer{"'"}s family.</p>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-ink-500">
                <th className="py-1 pr-2 font-medium">Invoice</th>
                <th className="pr-2 font-medium">Customer</th>
                <th className="pr-2 font-medium">Due</th>
                <th className="text-right pr-2 font-medium">Open</th>
                <th className="text-right pr-2 font-medium">Apply ($)</th>
                <th className="text-right pr-2 font-medium">Discount</th>
                <th className="text-right pr-2 font-medium">Write-off</th>
                <th className="pr-2 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const discountAmount = Number(row.discountAmount);
                return (
                  <tr key={row.key} className="border-t">
                    <td className="py-1 pr-2 font-mono">{row.documentNumber}</td>
                    <td className="pr-2">{row.customerCode} · {row.customerName}</td>
                    <td className="pr-2">{formatDate(row.dueDate)}</td>
                    <td className="tabular-nums pr-2 text-right">{formatMoney(Number(row.open))}</td>
                    <td className="w-24 pr-2">
                      <input value={row.amount} inputMode="decimal" disabled={!moneyGate.allowed || disabled}
                             title={moneyGate.title}
                             onChange={(e) => patchRow(row, { amount: e.target.value })}
                             aria-label={`${row.documentNumber} amount`}
                             className={`${INPUT_COMPACT} w-full text-right disabled:cursor-not-allowed disabled:bg-surface-50`} />
                    </td>
                    {/* #155 arm 2: THREE renderings, never two. An empty cell used to mean both
                        "nothing is on offer here" and "something is on offer, but not to a receipt
                        this size" — and the second is a §5.14 block that named neither what was
                        blocking it nor the way through, on a screen where 20.00 was reachable.
                          amount > 0        — the offer, as the "Take N" checkbox.
                          settling present  — `would_not_settle`: the hint below. TEXT, never a
                                              disabled checkbox — two E2E flows assert a row-scoped
                                              checkbox count of 0 here, and rightly.
                          otherwise         — silent. The remaining blockers have no route out, and
                                              §5.14 does not ask you to narrate a dead end.
                        The sentence says "applying X HERE", not "remit X": the server measures this
                        receipt's UNAPPLIED cash, so a receipt part-spent on another invoice needs a
                        bigger face than X. Both figures come from the server for that reason. */}
                    <td className="pr-2">
                      {discountAmount > 0 ? (
                        <label className="flex items-center justify-end gap-1 whitespace-nowrap tabular-nums">
                          <input type="checkbox" checked={row.takeDiscount === "true"}
                                 disabled={!moneyGate.allowed || disabled} title={moneyGate.title}
                                 onChange={(e) => patchRow(row, { takeDiscount: e.target.checked ? "true" : "false" })} />
                          Take {formatMoney(discountAmount)}
                        </label>
                      ) : row.discountSettlingAmount !== "" && (
                        <div className="max-w-[14rem] text-xs text-ink-500">
                          <span className="block">Not enough cash left on this receipt to settle.</span>
                          {/* ONE template literal, not interleaved JSX text and expressions: the
                              sentence is asserted verbatim by two E2E flows, and JSX's line-joining
                              rules are not something an exact-text assertion should depend on. */}
                          <span className="block tabular-nums">
                            {`Applying ${formatMoney(Number(row.discountSettlingAmount))} here would earn ` +
                             `${formatMoney(Number(row.discountWouldEarn))}.`}
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="w-24 pr-2">
                      <input value={row.writeOffAmount} inputMode="decimal" disabled={!recoveryWriteOffGate.allowed || disabled}
                             title={recoveryWriteOffGate.title}
                             onChange={(e) => patchRow(row, { writeOffAmount: e.target.value })}
                             aria-label={`${row.documentNumber} write-off amount`}
                             className={`${INPUT_COMPACT} w-full text-right disabled:cursor-not-allowed disabled:bg-surface-50`} />
                    </td>
                    <td className="pr-2">
                      <input value={row.writeOffReason} disabled={!recoveryWriteOffGate.allowed || disabled}
                             title={recoveryWriteOffGate.title}
                             onChange={(e) => patchRow(row, { writeOffReason: e.target.value })}
                             aria-label={`${row.documentNumber} write-off reason`}
                             className={`${INPUT_COMPACT} w-full disabled:cursor-not-allowed disabled:bg-surface-50`} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-2 flex items-center gap-2">
        <button onClick={() => void apply()} disabled={!moneyGate.allowed || disabled || rows.length === 0} title={moneyGate.title}
                className={BUTTON_PRIMARY_COMPACT}>
          {applying ? "Applying…" : "Apply"}
        </button>
        <DiscardButton section="Payment application" dirty={grid.dirty} pending={applying}
                       onDiscard={() => { grid.discard(); onError(null); }} />
        <UnsavedBadge dirty={grid.dirty} />
      </div>
      <PanelMessage message={applyMessage} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The page itself.
// ---------------------------------------------------------------------------------------------

const subscribePaymentSelection = (listener: () => void) => getBrowserDraftSession()?.subscribeSelection(listener) ?? (() => {});
const paymentSelectionRevision = () => peekBrowserDraftSession()?.getSelectionRevision() ?? 0;
const emptySelectionRevision = () => 0;

export function BatchDetail({ id }: { id: string }) {
  const { permissions: perms, error: permsError } = usePermissions();

  const [batch, setBatch] = useState<BatchDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The record read owns its own line (#654, the ShipmentDetail shape): its success and failure
  // must not clear or replace an action's refusal, and an action's success must not erase it.
  const [initialLoadError, setInitialLoadError] = useState<string | null>(null);
  // The two picker reads (payer, payment type) each report here rather than in `error`, which the
  // record read and every action clear (#654): a failed picker would otherwise sit empty with no
  // reason. Nothing clears it; a reload is the retry, as on ShipmentDetail and the order hub.
  const [loadError, setLoadError] = useState<string | null>(null);
  const addLoadError = useCallback((message: string) => {
    setLoadError((cur) => (cur ? `${cur} ${message}` : message));
  }, []);

  const mutations = useMutationGate();
  const recoverySource = useMemo(() => createBulkRecoverySource(
    () => api<BatchDetailData>(`/api/receivables/batches/${id}`), readBulkPermissions,
  ), [id]);
  const editGuard = useEditGuard();

  const load = useCallback(async () => {
    const ticket = mutations.next();
    const recoveryRead = recoverySource.begin();
    let res: BatchDetailData;
    try { res = await api<BatchDetailData>(`/api/receivables/batches/${id}`); }
    catch (error) { recoveryRead.unavailable(); throw error; }
    // Captured-session apply inside the accept branch (use-edit-guard.ts, the round-3 fixpoint).
    const accepted = mutations.accept(ticket);
    // Any accepted read clears the record read's own line (the mount's, the selection's, Void's
    // refresh), never the action slot: a read that landed shows current data (#783 review).
    if (accepted) { void recoveryRead.accept(res); setBatch(editGuard.applyPayload(res)); setInitialLoadError(null); }
    return { batch: res, accepted };
  }, [id, mutations, editGuard, recoverySource]);
  useEffect(() => {
    load().catch((e) => setInitialLoadError((e as Error).message));
  }, [load]);

  const applyMutation = useCallback(async (run: () => Promise<BatchDetailData>) => {
    const ticket = mutations.next();
    const recoveryRead = recoverySource.begin();
    let res: BatchDetailData;
    try { res = await run(); }
    catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) recoveryRead.unavailable();
      // #547 (owner ruling 2026-10-18): a 2xx whose answer could not be read committed its write, so
      // History is told here as the success path below tells it (#158), and reads its own list.
      // Nothing is applied and the batch itself is not read again (no `load`); the rejection still
      // reaches the caller. As of 6e42469 every thunk run through here sends one write and no read
      // (a census, not a guarantee).
      if (error instanceof UnreadableAnswerError) invalidateHistory();
      throw error;
    }
    // #158 — success path, the instant the mutation resolves and BEFORE the accept gate: the
    // server state has certainly changed even when this response is superseded and its payload
    // dropped. Covers all four actions routed through here (add payment, void payment, post,
    // reopen) — a `receiptBatch` row, or a `payment` row that is a registered child of this
    // page's panel. The per-action calls that used to sit at the add-payment and void-payment
    // sites were REMOVED when this landed: two signals per mutation read as intentional and are
    // not. The Apply/void-application panel above is a separate component that does NOT route
    // through this callback, so its own two calls stay where they are.
    invalidateHistory();
    if (!mutations.accept(ticket)) return;
    void recoveryRead.accept(res);
    setBatch(editGuard.applyPayload(res));
  }, [mutations, editGuard, recoverySource]);

  const posted = batch?.status === "POSTED";
  const voided = (batch?.deletedAt ?? null) !== null;

  // §5.5/task-13-brief.md Step 2: money-bearing controls take BOTH receivables.create and, for a
  // write-off, `write_off` on top — computed once with the "whichever is actually the blocker"
  // title (the `InvoiceDetail.tsx` moneyGate/priceGate precedent). Apply is an entity-creation
  // (POST /api/receivables/applications gates `create` — owner ruling, review round 1: the apply
  // gate must match the route it calls, not `edit`), consistent with add-payment and create-batch,
  // which already gate on create. Fix #7 (Round 4 correction-path, spec §5.2): NOT run through
  // `statusLocked` — on-account cash stays appliable to a later invoice from the same payment even
  // after the batch is POSTED, and `applyPayment` itself performs no batch-status check (see
  // `statusLocked`'s own comment).
  // #211 (owner ruling, 2026-08-25): applying cash also takes the `apply_payments` named action —
  // `receivables.create` alone records payments (createPaymentGate below stays create-only) but
  // does not move cash onto invoices, matching what POST /api/receivables/applications now
  // enforces. Combined with the whichever-is-actually-the-blocker title, the same shape as the
  // write-off pair directly below (which composes off THIS gate and so inherits the action).
  const createGateRaw = gate(perms, "receivables.create");
  const applyActionGateRaw = gateDo(perms, "apply_payments");
  const applyBlocked = createGateRaw.disabled || applyActionGateRaw.disabled;
  const applyGateRaw: Gate = {
    allowed: !applyBlocked, disabled: applyBlocked,
    title: createGateRaw.disabled ? createGateRaw.title : applyActionGateRaw.title,
  };
  const writeOffGateRaw = gateDo(perms, "write_off");
  const writeOffDisabled = applyGateRaw.disabled || writeOffGateRaw.disabled;
  const writeOffGateCombined: Gate = {
    allowed: !writeOffDisabled, disabled: writeOffDisabled,
    title: applyGateRaw.disabled ? applyGateRaw.title : writeOffGateRaw.title,
  };
  const moneyGate = applyGateRaw;
  const writeOffGate = writeOffGateCombined;
  const createPaymentGate = statusLocked(gate(perms, "receivables.create"), posted);
  const deletePaymentGate = statusLocked(gate(perms, "receivables.delete"), posted);
  // Fix #11 — void one application (correct a mis-applied payment). Not status-locked: correcting
  // an application is not editing the payment list, and `voidApplication` (applications.ts) itself
  // performs no batch-status check either — matching FIX #7's apply controls, this stays available
  // on a POSTED batch.
  const voidApplicationGate = gate(perms, "receivables.delete");

  const postGate: Gate = voided
    ? { allowed: false, disabled: true, title: "Batch is voided" }
    : posted
      ? { allowed: false, disabled: true, title: "Already posted" }
      : gate(perms, "receivables.edit");
  // The inverse of `postGate` (issue #68) — reopening is only ever available ON a posted batch, and
  // it is the action every other posted-batch refusal now points at, so it must be visible-and-
  // disabled rather than hidden (§5.16) even when there is nothing to reopen.
  const reopenGate: Gate = voided
    ? { allowed: false, disabled: true, title: "Batch is voided" }
    : !posted
      ? { allowed: false, disabled: true, title: "Only a posted batch can be reopened" }
      : gate(perms, "receivables.edit");
  // Two independent blockers, POSTED checked first — the same order `voidBatchInTx` uses, so the
  // tooltip names the guard the server would actually hit. A posted batch told "Void every payment
  // first" would be sent at a control `refusePosted` refuses; "Reopen the batch first" is the one
  // route that unblocks it.
  const voidBatchGate: Gate = voided
    ? { allowed: false, disabled: true, title: "Already voided" }
    : posted
      ? { allowed: false, disabled: true, title: "Reopen the batch first" }
      : (batch?.payments.length ?? 0) > 0
        ? { allowed: false, disabled: true, title: "Void every payment first" }
        : gate(perms, "receivables.delete");

  // Payer picker (Add payment form) — customers.view, the `InvoicingList.tsx` customer-filter
  // precedent: fetched only once the caller is known to hold it, never left silently empty.
  const customersGate = gate(perms, "customers.view");
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  useEffect(() => {
    if (!customersGate.allowed) return;
    api<CustomerOption[]>("/api/customers").then(setCustomers)
      .catch((e) => addLoadError(`Could not load payer customers: ${(e as Error).message}`));
  }, [customersGate.allowed, addLoadError]);

  // Payment-type picker — session-only picklist (`customers/[id]/page.tsx` Terms precedent): any
  // signed-in user, no extra permission beyond having reached this page.
  const [paymentTypes, setPaymentTypes] = useState<PickListRow[]>([]);
  useEffect(() => {
    api<PickListRow[]>("/api/picklists/paymentType").then(setPaymentTypes)
      .catch((e) => addLoadError(`Could not load payment types: ${(e as Error).message}`));
  }, [addLoadError]);

  // ---- Add payment ----

  const [payCustomerId, setPayCustomerId] = useState("");
  const [payTypeId, setPayTypeId] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [payReference, setPayReference] = useState("");
  const [payReceivedDate, setPayReceivedDate] = useState("");
  const [addingPayment, setAddingPayment] = useState(false);
  // Add payment's own message, under its form (owner ruling R1, P6 step 5b), never the banner.
  const [addPaymentMessage, setAddPaymentMessage] = useState<string | null>(null);

  async function addPayment() {
    const refusals: string[] = [];
    if (!payCustomerId || !payTypeId || !payReceivedDate) {
      refusals.push("Payer customer, payment type, amount, and received date are all required to add a payment.");
    }
    const amountRefusal = decimalRefusal(PAYMENT_AMOUNT.label, payAmount, PAYMENT_AMOUNT.box, { required: true });
    if (amountRefusal !== null) refusals.push(amountRefusal);
    if (refusals.length > 0) { setAddPaymentMessage(refusals.join("\n")); return; }
    setAddingPayment(true);
    try {
      await applyMutation(() => api<BatchDetailData>(`/api/receivables/batches/${id}/payments`, {
        method: "POST",
        body: JSON.stringify({
          customerId: payCustomerId, paymentTypeId: payTypeId, amount: payAmount,
          reference: payReference, receivedDate: payReceivedDate,
        }),
      }));
      setPayCustomerId(""); setPayTypeId(""); setPayAmount(""); setPayReference(""); setPayReceivedDate("");
      setAddPaymentMessage(null);
    } catch (e) {
      setAddPaymentMessage((e as Error).message);
    } finally {
      setAddingPayment(false);
    }
  }

  // ---- Void payment ----

  async function voidPaymentAction(payment: PaymentRow) {
    const reason = await askReason({
      question: `Void the ${payment.paymentTypeName} payment of ${formatMoney(payment.amount)} from ` +
        `${payment.customerCode}?`,
      verb: "voiding", blankRefusal: "A reason is required to void a payment.",
    });
    if (reason === null) return; // cancelled
    if (!reason.trim()) { setError("A reason is required to void a payment."); return; }
    try {
      await applyMutation(() => api<BatchDetailData>(`/api/receivables/batches/${id}/payments/${payment.id}`, {
        method: "DELETE", body: JSON.stringify({ reason }),
      }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // ---- Post / void batch ----

  async function postBatchAction() {
    if (!batch) return;
    // The modal (ruling 5), the sentence split into its title and body by the leaf.
    if (!(await askConfirm(postConfirm(batch.batchNumber)))) return;
    try {
      await applyMutation(() => api<BatchDetailData>(`/api/receivables/batches/${id}`, { method: "PATCH" }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // POSTED -> OPEN (issue #68). Reason-prompted like `voidBatchAction`, because it un-settles cash
  // and the service refuses a blank one; optimistic like `postBatchAction`, because the route
  // returns the fresh detail.
  async function reopenBatchAction() {
    if (!batch) return;
    const reason = await askReason({
      question: `Reopen batch #${batch.batchNumber}?\n\n` +
        `Its payments stop counting as posted cash until it is posted again.`,
      verb: "reopening", blankRefusal: "A reason is required to reopen a batch.",
    });
    if (reason === null) return; // cancelled
    if (!reason.trim()) { setError("A reason is required to reopen a batch."); return; }
    try {
      await applyMutation(() => api<BatchDetailData>(`/api/receivables/batches/${id}/reopen`, {
        method: "POST", body: JSON.stringify({ reason }),
      }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Non-optimistic: DELETE returns `{ ok: true }`, not a fresh detail — picking up `deletedAt`
  // needs a follow-up `load()` (the `InvoiceDetail.tsx` `discard` precedent, two separate
  // try/catches so a load failure after a successful void doesn't read as the void itself failing).
  async function voidBatchAction() {
    if (!batch) return;
    const reason = await askReason({
      question: `Void batch #${batch.batchNumber}?`, verb: "voiding", blankRefusal: "A reason is required to void a batch.",
    });
    if (reason === null) return; // cancelled
    if (!reason.trim()) { setError("A reason is required to void a batch."); return; }
    try {
      await api(`/api/receivables/batches/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
    } catch (e) {
      // #547 (owner ruling 2026-10-18): a 2xx proves the void committed, and its answer holds only
      // `{ ok: true }`, so an answer that could not be read falls through to the success path below.
      // Any other failure shows its message and stops.
      if (!(e instanceof UnreadableAnswerError)) {
        setError((e as Error).message);
        return;
      }
    }
    // #158 — success path, before the follow-up load. Void does NOT route through `applyMutation`
    // (DELETE answers `{ ok: true }`, not a fresh detail), and this page stays mounted read-only.
    invalidateHistory();
    setError(null);
    try {
      await load();
    } catch (e) {
      setError(`Batch voided, but the page could not be refreshed — reload to see the current state. (${(e as Error).message})`);
    }
  }

  const [expandedPaymentId, setExpandedPaymentId] = useState<string | null>(null);
  const drafts = useDraftIdentity();
  const selectionRevision = useSyncExternalStore(subscribePaymentSelection, paymentSelectionRevision, emptySelectionRevision);
  const authorizationRevision = peekBrowserDraftSession()?.getReadAuthorizationRevision() ?? 0;
  useEffect(() => {
    const session = getBrowserDraftSession();
    const auth = session?.readAuthorizationTicket();
    if (!session || !auth || !drafts.identityReady || selectionRevision === 0) return;
    let active = true;
    void load().then(result => {
      if (!active || !result.accepted || !session.isReadAuthorized(auth)) return;
      const selected = consumeSelectedPayment(session, result.batch);
      if (selected) setExpandedPaymentId(selected);
    }, error => { if (active && session.isReadAuthorized(auth)) setInitialLoadError((error as Error).message); });
    return () => { active = false; };
  }, [id, load, selectionRevision, drafts.identityReady, authorizationRevision]);

  if (!batch) {
    return (
      <PageStatus error={error ?? initialLoadError ?? permsError}>
        {loadError && <p className={`${NOTICE.warning} mt-3`}>{loadError}</p>}
      </PageStatus>
    );
  }

  return (
    <div className="min-w-0 p-3 sm:p-6">
      {/* The title row (spec §4.3; PR 7, owner 2026-11-01 on #822): Post batch the primary, Reopen
          batch in More actions, Void batch the title-row danger action (ruling 8); the status and
          a void in the subtitle (src/lib/receipt-batch-page.ts). */}
      <PageHeader title={`Batch #${batch.batchNumber}`} subtitle={batchSubtitle(batch)}
        actions={<>
          <button onClick={() => void postBatchAction()} disabled={!postGate.allowed} title={postGate.title}
                  className={BUTTON_PRIMARY}>
            Post batch
          </button>
          <ActionMenu items={[
            { label: "Reopen batch", disabled: !reopenGate.allowed, title: reopenGate.title, onSelect: () => void reopenBatchAction() },
          ]} />
          <DangerButton onClick={() => void voidBatchAction()} disabled={!voidBatchGate.allowed} title={voidBatchGate.title}>
            Void batch
          </DangerButton>
        </>} />

      {(error ?? permsError) && (
        <p className={`${NOTICE.refusal} mb-3 whitespace-pre-line`}>{error ?? permsError}</p>
      )}
      {initialLoadError && (
        <p className={`${NOTICE.refusal} mb-3`}>{initialLoadError}</p>
      )}
      {loadError && <p className={`${NOTICE.warning} mb-3`}>{loadError}</p>}
      {voided && (
        <p className={`${NOTICE.refusal} mb-3 font-medium`}>
          Voided — see History for the reason.
        </p>
      )}

      <div className="flex flex-col gap-6 min-[1360px]:flex-row min-[1360px]:items-start">
      <div className="min-w-0 flex-1">
      {/* Two tabs over the mounted sections (spec §4.4; src/lib/receipt-batch-page.ts): the apply
          grid's registry label badges Payments, and a tab switch is never a departure. */}
      <RecordTabs label={RECEIPT_BATCH_TAB_LABEL} tabs={receiptBatchTabs()} panels={{
        payments: (
          <>
      {/* ---- Add payment ---- */}
      <section id="add-payment" className={`${CARD} mb-6`}>
        <h2 className="mb-2 font-medium">Add payment</h2>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="block">
            Payer customer
            <Combobox value={payCustomerId} options={customerOptions(customers, { blank: "Select…" })}
                    disabled={!createPaymentGate.allowed || !customersGate.allowed}
                    title={!createPaymentGate.allowed ? createPaymentGate.title : customersGate.title}
                    onSelect={(v) => setPayCustomerId(v)} ariaLabel="Payer customer" className="mt-1 w-64" />
          </label>
          <label className="block">
            Payment type
            <select value={payTypeId} disabled={!createPaymentGate.allowed} title={createPaymentGate.title}
                    onChange={(e) => setPayTypeId(e.target.value)}
                    className={`${INPUT_COMPACT} mt-1 block disabled:cursor-not-allowed disabled:bg-surface-50`}>
              <option value="">Select…</option>
              {inMenuOrder(paymentTypes, (r) => r.name).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="block">
            Amount
            <input value={payAmount} inputMode="decimal" disabled={!createPaymentGate.allowed} title={createPaymentGate.title}
                   onChange={(e) => setPayAmount(e.target.value)}
                   className={`${INPUT_COMPACT} mt-1 block disabled:cursor-not-allowed disabled:bg-surface-50`} />
          </label>
          <label className="block">
            Check #
            <input value={payReference} disabled={!createPaymentGate.allowed} title={createPaymentGate.title}
                   onChange={(e) => setPayReference(e.target.value)}
                   className={`${INPUT_COMPACT} mt-1 block disabled:cursor-not-allowed disabled:bg-surface-50`} />
          </label>
          <label className="block">
            Received date
            {/* #73: the server refuses a future receivedDate (payments post after the deposit is
                in hand) — `max` keeps the picker honest up front. */}
            <input type="date" value={payReceivedDate} max={formatDateOnly(todayDateOnly())}
                   disabled={!createPaymentGate.allowed} title={createPaymentGate.title}
                   onChange={(e) => setPayReceivedDate(e.target.value)}
                   className={`${INPUT_COMPACT} mt-1 block disabled:cursor-not-allowed disabled:bg-surface-50`} />
          </label>
          <button onClick={() => void addPayment()} disabled={!createPaymentGate.allowed || addingPayment} title={createPaymentGate.title}
                  className={BUTTON_PRIMARY_COMPACT}>
            {addingPayment ? "Adding…" : "Add payment"}
          </button>
        </div>
        <PanelMessage message={addPaymentMessage} />
      </section>

      {/* ---- Payments + apply ---- */}
      <section id="payments" className={`${CARD} mb-6`}>
        <h2 className="mb-2 font-medium">Payments</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            {/* L3: the table-header convention the rest of the app uses — ReceivablesList.tsx's
                batch list and PaymentsReport.tsx both head their tables with a ruled `border-b
                text-left` row and plain `p-2` cells. This one was grey `font-medium` text with no
                rule, so the same data read as a different kind of table on every screen. The two
                action columns get a visually hidden header rather than an empty `<th />`, which
                announces as a blank column. Body cells take the same `p-2` so the columns still
                line up under the restyled header. */}
            <thead>
              <tr className="border-b text-left">
                <th className="p-2">Customer</th>
                <th className="p-2">Type</th>
                <th className="p-2 text-right tabular-nums">Amount</th>
                <th className="p-2">Check #</th>
                <th className="p-2">Received</th>
                <th className="p-2 text-right tabular-nums">On account</th>
                <th className="p-2"><span className="sr-only">Actions</span></th>
                <th className="p-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {batch.payments.map((p) => (
                <Fragment key={p.id}>
                  <tr className="border-t">
                    <td className="p-2">{p.customerCode} · {p.customerName}</td>
                    <td className="p-2">{p.paymentTypeName}</td>
                    <td className="p-2 text-right tabular-nums">{formatMoney(p.amount)}</td>
                    <td className="p-2">{p.reference}</td>
                    <td className="p-2">{formatDate(p.receivedDate)}</td>
                    <td className="p-2 text-right tabular-nums">{formatMoney(p.onAccount)}</td>
                    <td className="p-2">
                      {/* Not permission-gated: expanding shows a read-only view built from
                          receivables.view-gated data the operator already needed to reach this
                          page — the write-side controls inside are what carry the money gates. */}
                      {/* Hide or opening another payment explicitly asks to discard the current
                          application's captured versions. Unmount itself retains recovery work;
                          only the confirmed, scoped Discard below removes those exact copies. */}
                      <button onClick={() => void (async () => {
                                const store = getBrowserDraftSession()?.store;
                                const stamps = store ? paymentDraftStamps(store, id, expandedPaymentId) : [];
                                if (!(await askDiscard({ action: "Close the current payment application and discard its draft?" }))) return;
                                setExpandedPaymentId(expandedPaymentId === p.id ? null : p.id);
                                store?.discard(stamps);
                              })()}
                              className={`${LINK} text-xs`}>
                        {expandedPaymentId === p.id ? "Hide" : "Apply"}
                      </button>
                    </td>
                    <td className="p-2">
                      <button onClick={() => void voidPaymentAction(p)} disabled={!deletePaymentGate.allowed} title={deletePaymentGate.title}
                              className="text-xs text-red-600">
                        Void payment
                      </button>
                    </td>
                  </tr>
                  {expandedPaymentId === p.id && (
                    <tr>
                      <td colSpan={8}>
                        <ApplyPanel batchId={id} payment={p} recoverySource={recoverySource} moneyGate={moneyGate} writeOffGate={writeOffGate}
                                    voidApplicationGate={voidApplicationGate}
                                    onApplied={() => {
                                      // #146 — the outer `load` rethrows (only its mount effect
                                      // catches), so a network blip HERE after a successful
                                      // apply was an unhandled rejection + a silently stale
                                      // page. Reported the way voidBatchAction's own second
                                      // try/catch does; wording is generic because both
                                      // apply() and voidApplicationAction() fire this.
                                      load().catch((e) => setError(
                                        `The operation succeeded, but the page could not be refreshed — reload to see the current state. (${(e as Error).message})`,
                                      ));
                                    }} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {batch.payments.length === 0 && (
                <tr><td colSpan={8} className="p-4 text-center text-ink-500">No payments yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

          </>
        ),
        history: (
          <div id="history">
            <HistoryPanel entity="receiptBatch" entityId={id} perms={perms} permsError={permsError} />
          </div>
        ),
      }} />
      </div>
      {/* The card reads the loaded batch: what the operator keyed (the date, the control total)
          and what the payments add up to (Entered, Balance). Balance is the PROOF figure, three
          states (#163): a null control total was proved against NOTHING, said in words, never as a
          0 that reads as checked; the tile's colours went with it, the words carrying the meaning. */}
      <AtAGlance rows={[
        { label: "Deposit date", value: formatDate(batch.depositDate) },
        { label: "Status", value: RECEIPT_BATCH_STATUS_LABELS[batch.status] },
        { label: "Control total", value: <span className="tabular-nums">{controlTotalText(batch.controlTotal)}</span> },
        { label: "Entered", value: <span className="tabular-nums">{formatMoney(batch.enteredTotal)}</span> },
        { label: "Balance", value: <span className="tabular-nums">{balanceText(batch.balance)}</span> },
      ]} />
      </div>
    </div>
  );
}
