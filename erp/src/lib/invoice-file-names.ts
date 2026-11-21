// The name an invoice or credit print carries, filed (#588) and downloaded (#591):
// `Invoice-<order#>.pdf` / `Credit-<credit#>.pdf`, the bare number, capitalised (owner rulings
// 2026-10-20). Client-safe: no imports. `documentFilename` (src/server/documents.ts) reads it.
export type InvoiceFileKind = "INVOICE" | "CREDIT";

export function invoiceFileName(kind: InvoiceFileKind, number: number | string): string {
  switch (kind) {
    case "INVOICE":
      return `Invoice-${number}.pdf`;
    case "CREDIT":
      return `Credit-${number}.pdf`;
  }
}
