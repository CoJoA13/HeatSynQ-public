// The deposit batch page's decisions (spec 2026-10-30-ux-redesign-design.md §4.3–§4.4; the UX
// redesign PR 7, owner 2026-11-01 on #822): its two tabs (Payments holds Add payment, the Payments
// table and each row's inline Apply panel, whose grid registers under "Payment application", so
// that tab badges its unsaved work; History the panel), the subtitle under "Batch #N" (the deposit
// date, the status, a void), the Post confirm split into the modal's title and body, and the words
// a null control total ("Not entered", the owner's rename) and a null balance ("Not proved — no
// control total", #163: proved against nothing is a third state, never a zero) show. Client-safe;
// the E2E helpers read the tabs under plain node.
import type { RecordTab } from "./record-tabs";
import { RECEIPT_BATCH_STATUS_LABELS, type ReceiptBatchStatusValue } from "./ar-constants";
import { formatDate, formatMoney } from "./format";

export const RECEIPT_BATCH_TAB_LABEL = "Batch sections";

export function receiptBatchTabs(): RecordTab[] {
  return [
    { key: "payments", label: "Payments", sections: ["Payment application"], ids: ["add-payment", "payments"] },
    { key: "history", label: "History", sections: [], ids: ["history"] },
  ];
}

/** The page's subtitle: the deposit date, the status label, and "Voided" on a voided batch. */
export function batchSubtitle(b: { depositDate: string; status: ReceiptBatchStatusValue; deletedAt: string | null }): string {
  return [formatDate(b.depositDate), RECEIPT_BATCH_STATUS_LABELS[b.status], ...(b.deletedAt !== null ? ["Voided"] : [])].join(" · ");
}

/** Today's Post confirm sentence, split for the modal: the question is the title, the rest the body. */
export function postConfirm(batchNumber: number): { title: string; body: string; confirm: string } {
  return {
    title: `Post batch #${batchNumber}?`,
    body: "Once posted, no further payments can be added or voided.",
    confirm: "Post batch",
  };
}

/** A null control total was never entered (the owner's rename of the em dash). */
export function controlTotalText(controlTotal: number | null): string {
  return controlTotal === null ? "Not entered" : formatMoney(controlTotal);
}

/** A null balance was proved against nothing (#163): words, never a 0 that reads as checked. */
export function balanceText(balance: number | null): string {
  return balance === null ? "Not proved — no control total" : formatMoney(balance);
}
