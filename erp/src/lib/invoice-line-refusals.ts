// Client-safe leaf: every refusal of an invoice or credit memo draft's line boxes, decided before
// "Save lines" sends anything (#517). The page shows its lines as two tables, Part / operation
// lines (kind PART or OPERATION) and Surcharges (every other kind), so a box is named by its table
// and its row in that table, which is what the operator counts on the screen. The grid's own
// order interleaves the two, so numbering over the whole grid would call a surcharge row "line 2"
// where the screen shows it as the first row of its table. Refusals come in the screen's order:
// the first table's rows, then the second's, and within a row the quantity, the Net weight, the
// Amount.
import { decimalRefusal } from "./decimal-entry";
import { INVOICE_LINE_AMOUNT, INVOICE_LINE_NET_WEIGHT } from "./money-boxes";

export type InvoiceLineText = { kind: string; qty: string; weight: string; amount: string };

function tableRefusals(table: string, rows: readonly InvoiceLineText[]): string[] {
  const refusals: string[] = [];
  for (const [i, row] of rows.entries()) {
    const name = `${table} line ${i + 1}`;
    if (row.qty.trim() !== "" && !Number.isInteger(Number(row.qty))) refusals.push(`${name}: quantity must be a whole number.`);
    const weight = decimalRefusal(`${name}, ${INVOICE_LINE_NET_WEIGHT.label}`, row.weight, INVOICE_LINE_NET_WEIGHT.box);
    if (weight !== null) refusals.push(weight);
    const amount = decimalRefusal(`${name}, ${INVOICE_LINE_AMOUNT.label}`, row.amount, INVOICE_LINE_AMOUNT.box, { required: true });
    if (amount !== null) refusals.push(amount);
  }
  return refusals;
}

/** Every refusal of the draft's rows, in grid order within each of the two tables. */
export function invoiceLineRefusals(rows: readonly InvoiceLineText[]): string[] {
  const isPartOp = (r: InvoiceLineText) => r.kind === "PART" || r.kind === "OPERATION";
  return [
    ...tableRefusals("Part / operation", rows.filter(isPartOp)),
    ...tableRefusals("Surcharges", rows.filter(r => !isPartOp(r))),
  ];
}
