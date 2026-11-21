// Client-safe leaf: the lines a receipt batch's apply grid sends, or every refusal of what was typed
// (#517). The grid keeps its amounts as text; each typed Amount and Write-off goes through the one
// decimal rule against the server's apply-line box, so a refused box is named by its document and
// column, and a save lists every refusal at once, in row order and, within a row, in column order.
import { decimalRefusal } from "./decimal-entry";
import { APPLY_LINE_AMOUNT, APPLY_LINE_WRITE_OFF } from "./money-boxes";

export type ApplyLine = { invoiceId: string; type: "PAYMENT" | "DISCOUNT" | "WRITE_OFF"; amount: string; reason?: string };

export type ApplyRowText = {
  key: string; documentNumber: string; amount: string; takeDiscount: string;
  discountAmount: string; writeOffAmount: string; writeOffReason: string;
};

export function paymentApplyPayload(
  rows: readonly ApplyRowText[],
  writeOffGate: { allowed: boolean; title?: string },
): { ok: true; lines: ApplyLine[] } | { ok: false; error: string } {
  const lines: ApplyLine[] = [];
  const refusals: string[] = [];
  for (const row of rows) {
    const amount = row.amount.trim();
    if (amount !== "") {
      const refusal = decimalRefusal(`${row.documentNumber}, ${APPLY_LINE_AMOUNT.label}`, amount, APPLY_LINE_AMOUNT.box);
      if (refusal !== null) refusals.push(refusal);
      else lines.push({ invoiceId: row.key, type: "PAYMENT", amount });
    }
    if (row.takeDiscount === "true") {
      const d = Number(row.discountAmount);
      if (d > 0) lines.push({ invoiceId: row.key, type: "DISCOUNT", amount: String(d) });
    }
    const writeOff = row.writeOffAmount.trim();
    if (writeOff !== "") {
      // Without the permission nothing else about the box matters: the gate's own sentence, alone.
      if (!writeOffGate.allowed) return { ok: false, error: writeOffGate.title ?? "Write-off access is required." };
      const refusal = decimalRefusal(`${row.documentNumber}, ${APPLY_LINE_WRITE_OFF.label}`, writeOff, APPLY_LINE_WRITE_OFF.box);
      if (refusal !== null) refusals.push(refusal);
      const reason = row.writeOffReason.trim();
      if (!reason) refusals.push(`${row.documentNumber}: a write-off needs a reason.`);
      else if (refusal === null) lines.push({ invoiceId: row.key, type: "WRITE_OFF", amount: writeOff, reason });
    }
  }
  if (refusals.length > 0) return { ok: false, error: refusals.join("\n") };
  if (lines.length === 0) return { ok: false, error: "Enter at least one payment, discount, or write-off amount before applying." };
  return { ok: true, lines };
}
