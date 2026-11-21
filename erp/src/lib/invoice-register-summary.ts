// #592: the Invoice register's summary row (owner rulings, 2026-10-20 and 2026-10-21). After a
// blank row, one row: the count of exported rows in words under Document No, and the sum of every
// row's Total under Total. A credit memo's total is stored negative, so it nets the sum; nothing is
// split by sign. Stated once, for the Invoicing list's Excel and its PDF, so the same rows give the
// same total in both files. Client-safe and pure: it imports nothing.

/**
 * The count of `rows` and the sum of their totals. Each total is a Decimal(12,2) figure read into a
 * JS number, so summed as floats it drifts (0.1 + 0.2 is 0.30000000000000004). Each is rounded to
 * its whole cents first, the cents summed as integers and the sum divided by 100 once, the
 * `cents` idiom of `invoice-shipment-fingerprint.ts`. The sum starts at 0, so no rows, or rows that
 * net to nothing, answer 0, never -0.
 */
export function registerSummary(rows: readonly { total: number }[]): { count: number; total: number } {
  let cents = 0;
  for (const row of rows) cents += Math.round(row.total * 100);
  return { count: rows.length, total: cents / 100 };
}

/** The summary row's words under Document No: `Total of 1 document` for one row, and
 *  `Total of N documents` for any other count, none included. */
export function summaryLabel(count: number): string {
  return count === 1 ? "Total of 1 document" : `Total of ${count} documents`;
}
