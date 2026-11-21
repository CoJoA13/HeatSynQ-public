import type { BatchDetailData, OpenInvoiceRow } from "../app/receivables/batches/[id]/BatchDetail";
import { api } from "./fetcher";
import { gate, gateDo } from "./permission-ui";
import { composeRows, type BulkRecoveryOptions } from "./bulk-grid";
import type { BulkBaseline, BulkRecoveryCustomization } from "./bulk-grid-recovery";
import type { BulkRecoverySource, BulkSourceSnapshot } from "./bulk-recovery-source";
import type { DraftSession } from "./draft-session";
import type { DraftStore, Stamp } from "./draft-store";

export type DiscountOfferView = { amount: number; settlingAmount: number | null; wouldEarn: number | null };

export type ApplyLineFields = {
  documentNumber: string; customerCode: string; customerName: string; dueDate: string;
  open: string; discountAmount: string;
  /** #155 arm 2 — both "" unless the server offered a route out. `useBulkGrid`'s fields are strings,
   *  so "absent" is the empty string rather than null. NEVER re-derived on the client: the figure
   *  that earns the discount is measured against this receipt's UNAPPLIED cash, which the grid does
   *  not know (see `DiscountOffer`'s docblock for why re-deriving it produces a false sentence). */
  discountSettlingAmount: string; discountWouldEarn: string;
  amount: string; takeDiscount: string; writeOffAmount: string; writeOffReason: string;
};

export function toApplyFields(row: OpenInvoiceRow & { discount: DiscountOfferView }): ApplyLineFields {
  return {
    documentNumber: row.documentNumber, customerCode: row.customerCode, customerName: row.customerName,
    dueDate: row.dueDate ?? "", open: String(row.open), discountAmount: String(row.discount.amount),
    discountSettlingAmount: row.discount.settlingAmount === null ? "" : String(row.discount.settlingAmount),
    discountWouldEarn: row.discount.wouldEarn === null ? "" : String(row.discount.wouldEarn),
    amount: "", takeDiscount: "false", writeOffAmount: "", writeOffReason: "",
  };
}

export type PaymentBatchRecord = Pick<BatchDetailData, "id" | "status" | "deletedAt" | "depositDate" | "payments">;
export type PaymentCandidate = OpenInvoiceRow & { discount: DiscountOfferView };
export type PaymentBulkSnapshot = { batch: PaymentBatchRecord; paymentId: string; permissions: string[]; candidates: PaymentCandidate[] };
export type PaymentBulkSource = BulkRecoverySource<PaymentBatchRecord, string[]>;
/** The panel's candidates come from ONE read, `?customerId=&paymentId=` (#613): each row's open
 * balance and its `DiscountOffer` are answered together, from one snapshot, by the server's
 * `paymentCandidates`. The panel used to send the payer list and then one pair read per row, so a
 * panel of thirty invoices waited through five or six waves of requests before its first row could
 * be edited, and did it all again after every Apply. A row that arrives with no offer record is an
 * incomplete read and rejects: the grid must never compose a row whose discount it does not know. */
export async function readPaymentCandidates(
  readCandidates: () => Promise<Array<OpenInvoiceRow & { discount?: DiscountOfferView }>>,
): Promise<PaymentCandidate[]> {
  const rows = await readCandidates();
  return rows.map(row => {
    const { discount } = row;
    if (!discount) throw new Error("Candidate read is incomplete.");
    return { ...row, discount: { amount: discount.amount, settlingAmount: discount.settlingAmount, wouldEarn: discount.wouldEarn } };
  });
}
async function hydrate(snapshot: BulkSourceSnapshot<PaymentBatchRecord, string[]>, paymentId: string): Promise<PaymentBulkSnapshot> {
  if (!gate(snapshot.access, "receivables.view").allowed) throw new Error("Receivables access is required.");
  const payment = snapshot.record.payments.find(p => p.id === paymentId);
  if (!payment) throw new Error("Payment is no longer available in this batch.");
  const candidates = await readPaymentCandidates(
    () => api(`/api/receivables/applications?customerId=${payment.customerId}&paymentId=${paymentId}`),
  );
  return { batch: snapshot.record, permissions: snapshot.access, paymentId, candidates };
}
export function paymentApplicationBaseline(s: PaymentBulkSnapshot): BulkBaseline<ApplyLineFields> {
  const payment = s.batch.payments.find(p => p.id === s.paymentId);
  const create = gate(s.permissions, "receivables.create").allowed;
  const applyPayments = gateDo(s.permissions, "apply_payments").allowed;
  return { rows: s.candidates.map(row => ({ id: row.id, fields: toApplyFields(row) })), context: {
    batch: { id: s.batch.id, status: s.batch.status, deletedAt: s.batch.deletedAt, depositDate: s.batch.depositDate },
    payment: payment ? { id: payment.id, customerId: payment.customerId, receivedDate: payment.receivedDate,
      amount: payment.amount, onAccount: payment.onAccount, paymentTypeId: payment.paymentTypeId,
      applications: payment.applications.map(a => ({ id: a.id, type: a.type, amount: a.amount, invoiceId: a.invoiceId })) } : null,
    create, applyPayments, editable: create && applyPayments && !!payment && s.batch.deletedAt === null,
    writeOff: gateDo(s.permissions, "write_off").allowed,
    candidates: s.candidates.map(c => ({ id: c.id, customerId: c.customerId, orderId: c.orderId, invoiceDate: c.invoiceDate,
      total: c.total, open: c.open, status: "FINALIZED", kind: "INVOICE", deletedAt: null,
      discount: { amount: c.discount.amount, settlingAmount: c.discount.settlingAmount, wouldEarn: c.discount.wouldEarn } })),
  } };
}
export const paymentBulkCustomization: BulkRecoveryCustomization<ApplyLineFields> = {
  comparison(baseline) {
    return { rows: baseline.rows.map(row => {
      const { documentNumber, customerCode, customerName, dueDate, ...fields } = row.fields;
      void documentNumber; void customerCode; void customerName; void dueDate;
      return { id: row.id, fields };
    }), context: baseline.context };
  },
  preview(data, baseline) {
    return composeRows({ serverRows: baseline.rows, toFields: r => r.fields, ...data }).flatMap((row, i) =>
      Object.entries(row).filter(([key]) => !["key", "isNew", "clientId"].includes(key)).map(([key, value]) => ({
        label: `Row ${i + 1} ${key.replace(/([A-Z])/g, " $1").toLowerCase()}`, value: String(value),
      })));
  },
};
export function paymentBulkOptions(source: PaymentBulkSource, batchId: string, paymentId: string): BulkRecoveryOptions<ApplyLineFields> {
  const project = (snapshot: PaymentBulkSnapshot) => {
    const baseline = paymentApplicationBaseline(snapshot); return { baseline, editable: baseline.context.editable === true };
  };
  return { record: { kind: "payment", id: batchId }, childId: paymentId, kind: "payment-application", schema: "payment-application-v1",
    label: "Payment application", href: `/receivables/batches/${batchId}`, source, customization: paymentBulkCustomization,
    read: async () => project(await hydrate(await source.read(), paymentId)),
    register: listener => source.register(() => {
      const accept = listener(); if (!accept) return null;
      return (snapshot, current) => {
        if (!snapshot) { accept(null); return; }
        void hydrate(snapshot, paymentId).then(fresh => { if (current()) accept(project(fresh)); }, () => { if (current()) accept(null); });
      };
    }),
  };
}
/** Called only after an accepted, ticket-authorized fresh batch read. Selection
 * is explicit and one-shot; ordinary mount never opens all retained panels. */
export function consumeSelectedPayment(session: DraftSession, batch: PaymentBatchRecord): string | null {
  for (const row of session.store.getSnapshot().rows) {
    if (row.key.record.kind !== "payment" || row.key.record.id !== batch.id || row.key.editor !== "payment-application"
      || !batch.payments.some(payment => payment.id === row.key.childId)) continue;
    if (session.consumeSelection(row.key)) return row.key.childId!;
  }
  return null;
}
export function paymentDraftStamps(store: DraftStore, batchId: string, paymentId: string | null): readonly Stamp[] {
  return store.getSnapshot().rows.filter(row => row.key.record.kind === "payment" && row.key.record.id === batchId
    && row.key.editor === "payment-application" && row.key.childId === paymentId).flatMap(row => row.stamps);
}
