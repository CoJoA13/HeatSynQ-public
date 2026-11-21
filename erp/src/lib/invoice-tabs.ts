// The invoice page's tabs, title and action labels (spec 2026-10-30-ux-redesign-design.md §4.4;
// the UX redesign PR 6, owner 2026-10-31 on #821). Header (the blur-saved header fields), Lines
// (the one grid, whose SaveButton registers under "Invoice lines", so that tab badges its unsaved
// work), Documents & history (the stored prints and the History panel): today's section names, by
// the owner's choice over the file's. A credit is titled by the invoice it credits ("Credit from
// invoice IR - 1040"), its own number in the page's subtitle; the six actions name the document's
// kind, the ruled "Finalize invoice" read on a credit as "Finalize credit" (my call, ledgered: the
// rename applied to the kind word). Client-safe, and the E2E helpers read the tabs under plain node.
import type { RecordTab } from "./record-tabs";
import { INVOICE_KIND_LABELS, type InvoiceKindValue } from "./invoice-constants";

export const INVOICE_TAB_LABEL = "Invoice sections";

export type InvoiceTabKey = "header" | "lines" | "documents";

export function invoiceTabs(): RecordTab[] {
  return [
    { key: "header", label: "Header", sections: [], ids: ["header"] },
    { key: "lines", label: "Lines", sections: ["Invoice lines"], ids: ["lines"] },
    { key: "documents", label: "Documents & history", sections: [], ids: ["documents", "history"] },
  ];
}

/** The page's title: an invoice by its document number, a credit by its source invoice's. */
export function invoiceTitle(i: { kind: InvoiceKindValue; documentNumber: string; sourceInvoiceNumber: string | null }): string {
  if (i.kind === "CREDIT" && i.sourceInvoiceNumber !== null) return `Credit from invoice ${i.sourceInvoiceNumber}`;
  return `${INVOICE_KIND_LABELS[i.kind]} ${i.documentNumber}`;
}

export type InvoiceActionLabels = {
  finalize: string; print: string; unlock: string; discard: string; recalculate: string; credit: string;
};

/** The six actions' labels, the kind word by the document ("Finalize invoice" / "Finalize credit"). */
export function invoiceActionLabels(kind: InvoiceKindValue): InvoiceActionLabels {
  const word = kind === "CREDIT" ? "credit" : "invoice";
  return {
    finalize: `Finalize ${word}`, print: `Print ${word}`, unlock: `Unlock ${word}`, discard: `Discard ${word}`,
    recalculate: "Recalculate lines", credit: "Create credit",
  };
}
