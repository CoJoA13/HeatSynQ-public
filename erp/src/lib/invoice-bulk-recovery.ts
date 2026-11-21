import type { InvoiceLineRow, InvoiceDetailData } from "../app/invoicing/[id]/InvoiceDetail";
import { composeRows, type BulkRecoveryOptions } from "./bulk-grid";
import type { BulkBaseline, BulkRecoveryCustomization } from "./bulk-grid-recovery";
import type { BulkRecoverySource, BulkSourceSnapshot } from "./bulk-recovery-source";
import { gate, gateDo } from "./permission-ui";

export type InvoiceLineFields = {
  wireKey: string; parentKey: string; kind: string;
  orderLineId: string; processStepCodeId: string; surchargeId: string; orderChargeId: string; glAccountId: string;
  partNumber: string; partName: string; partDescription: string;
  description: string; glAccountName: string;
  qty: string; weight: string; eachWeight: string;
  pricePer: string; unitPrice: string; setupCharge: string; minimumCharge: string; breakThreshold: string;
  minimumApplied: string; rate: string; priceSource: string; sourceQuoteNumber: string;
  needsPrice: string;
  /** #587: `"true"` when the line's words were typed or picked on it (`InvoiceLineRow.wordsChosen`). */
  wordsChosen: string;
  amount: string;
};

export function toLineFields(l: InvoiceLineRow): InvoiceLineFields {
  return {
    wireKey: l.id, parentKey: l.parentLineId ?? "", kind: l.kind,
    orderLineId: l.orderLineId ?? "", processStepCodeId: l.processStepCodeId ?? "",
    surchargeId: l.surchargeId ?? "", orderChargeId: l.orderChargeId ?? "", glAccountId: l.glAccountId ?? "",
    partNumber: l.partNumber, partName: l.partName, partDescription: l.partDescription,
    description: l.description, glAccountName: l.glAccountName,
    qty: l.qty === null ? "" : String(l.qty),
    weight: l.weight === null ? "" : String(l.weight),
    eachWeight: l.eachWeight === null ? "" : String(l.eachWeight),
    pricePer: l.pricePer ?? "",
    unitPrice: l.unitPrice === null ? "" : String(l.unitPrice),
    setupCharge: l.setupCharge === null ? "" : String(l.setupCharge),
    minimumCharge: l.minimumCharge === null ? "" : String(l.minimumCharge),
    breakThreshold: l.breakThreshold === null ? "" : String(l.breakThreshold),
    minimumApplied: String(l.minimumApplied),
    rate: l.rate === null ? "" : String(l.rate),
    priceSource: l.priceSource ?? "",
    sourceQuoteNumber: l.sourceQuoteNumber === null ? "" : String(l.sourceQuoteNumber),
    needsPrice: String(l.needsPrice),
    wordsChosen: String(l.wordsChosen),
    amount: String(l.amount),
  };
}

export type InvoiceRecord = Pick<InvoiceDetailData, "id" | "orderId" | "customerId" | "kind" | "status" | "finalizedAt" | "deletedAt" | "taxRate" | "lines">;
export type InvoiceBulkSnapshot = { invoice: InvoiceRecord; permissions: string[] };
export type InvoiceBulkSource = BulkRecoverySource<InvoiceRecord, string[]>;
export function invoiceLinesBaseline(s: InvoiceBulkSnapshot): BulkBaseline<InvoiceLineFields> {
  const edit = gate(s.permissions, "invoicing.edit").allowed;
  const prices = gateDo(s.permissions, "change_prices").allowed;
  return { rows: s.invoice.lines.map(l => ({ id: l.id, fields: toLineFields(l) })), context: {
    invoiceId: s.invoice.id, orderId: s.invoice.orderId, customerId: s.invoice.customerId, kind: s.invoice.kind,
    status: s.invoice.status, finalizedAt: s.invoice.finalizedAt, deletedAt: s.invoice.deletedAt, taxRate: s.invoice.taxRate,
    edit, changePrices: prices, editable: edit && prices && s.invoice.status !== "FINALIZED" && s.invoice.deletedAt === null,
  } };
}
export const invoiceBulkCustomization: BulkRecoveryCustomization<InvoiceLineFields> = {
  preview(data, baseline) {
    // #587: `wordsChosen` is a hidden round-trip mark, not words the operator typed: the preview
    // names the words themselves (`description`) and never the flag.
    const hidden = new Set(["key", "isNew", "clientId", "wireKey", "parentKey", "orderLineId", "processStepCodeId", "surchargeId", "orderChargeId", "glAccountId", "wordsChosen"]);
    return composeRows({ serverRows: baseline.rows, toFields: r => r.fields, ...data }).flatMap((row, i) =>
      Object.entries(row).filter(([key]) => !hidden.has(key)).map(([key, value]) => ({
        label: `Row ${i + 1} ${key.replace(/([A-Z])/g, " $1").toLowerCase()}`, value: String(value),
      })));
  },
};
export function invoiceBulkOptions(source: InvoiceBulkSource, invoiceId: string): BulkRecoveryOptions<InvoiceLineFields> {
  const project = (snapshot: BulkSourceSnapshot<InvoiceRecord, string[]>) => {
    if (!gate(snapshot.access, "invoicing.view").allowed) throw new Error("Invoice access is required.");
    const baseline = invoiceLinesBaseline({ invoice: snapshot.record, permissions: snapshot.access });
    return { baseline, editable: baseline.context.editable === true };
  };
  return { record: { kind: "invoice", id: invoiceId }, kind: "invoice-lines", schema: "invoice-lines-v1", label: "Invoice lines",
    href: `/invoicing/${invoiceId}`, source, customization: invoiceBulkCustomization,
    read: async () => project(await source.read()),
    register: listener => source.register(() => {
      const accept = listener(); if (!accept) return null;
      return snapshot => {
        if (!snapshot) { accept(null); return; }
        try { accept(project(snapshot)); } catch { accept(null); }
      };
    }),
  };
}
