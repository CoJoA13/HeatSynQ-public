// #591: whether an invoice or credit memo has printed since it was finalized (a draft: its newest
// print), and what Print selected answers when it may not print one (owner rulings 591-1 and 591-2,
// and the owner's "Refuse both", 2026-10-20). Stated once, for the Invoicing list's Printed cell and
// its boxes and for the selected print's server check. Client-safe: it imports only the invoice
// constants.
import { INVOICE_KIND_LABELS, type InvoiceKindValue, type InvoiceStatusValue } from "./invoice-constants";

/**
 * The newest INVOICE or CREDIT print made at or after the row's current `finalizedAt`, else null.
 * A draft (no `finalizedAt`) answers its newest print, and unlock then re-finalize blanks it, since
 * the re-finalize moves `finalizedAt` past every earlier print. Nothing is stored: the list derives
 * it from the row and its stored documents.
 *
 * `>=`, so a print in the finalize's own millisecond counts as printed: both columns are
 * `TIMESTAMP(3)` written from JS milliseconds, so the equal case is exact. The rule rests on both
 * stamps being taken under the order claim from the app's clock: finalize sets `finalizedAt` to its
 * own `new Date()` after its claim, and a print's `StoredDocument.createdAt` is filled by Prisma's
 * `@default(now())` with a `new Date()` at the insert (`storeDocument` passes none), after the
 * print's claim. A raw insert taking the column's `CURRENT_TIMESTAMP` would stamp the transaction's
 * start instead, before its wait on the claim, so a print made just after a finalize could read as
 * made before it.
 */
export function printedSince(finalizedAt: Date | null, newestPrintAt: Date | null): Date | null {
  if (newestPrintAt === null) return null;
  if (finalizedAt === null) return newestPrintAt;
  return newestPrintAt.getTime() >= finalizedAt.getTime() ? newestPrintAt : null;
}

/** Whether a list row takes a Print selected box: finalized, invoice or credit, and not printed
 *  since (591-2), and not on a voided order (the owner, 2026-10-21: "No box"). A finalized credit
 *  memo can outlive its order's void, and every print of it answers the voided refusal. `printedAt`
 *  is the list row's own ISO text. */
export function printTickable(row: {
  status: InvoiceStatusValue; printedAt: string | null; orderVoided: boolean;
}): boolean {
  return row.status === "FINALIZED" && row.printedAt === null && !row.orderVoided;
}

/**
 * The selected print's refusal for a row it may not print (the owner, 2026-10-20: "Refuse
 * both"), in the owner's words, or null when it may. The status is asked first, so a printed draft
 * is refused as not finalized. The label is `INVOICE_KIND_LABELS`, the number the row's document
 * number, prefix included.
 *
 * `printedAt` is a Date, not the list's ISO text: the sentences are for the server's selected
 * print, which has `printedSince`'s Date on its own transaction, and the page shows the server's
 * answer rather than building them. Only whether it is null is read.
 */
export function selectedPrintRefusal(row: {
  kind: InvoiceKindValue; documentNumber: string; status: InvoiceStatusValue; printedAt: Date | null;
}): string | null {
  const label = INVOICE_KIND_LABELS[row.kind];
  if (row.status !== "FINALIZED") return `${label} ${row.documentNumber} is not finalized, so it was not printed.`;
  if (row.printedAt !== null) {
    return `${label} ${row.documentNumber} has already printed since it was finalized, so it was not printed again.`;
  }
  return null;
}
