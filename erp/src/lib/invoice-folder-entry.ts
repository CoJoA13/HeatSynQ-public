// What a pasted Invoice folder becomes before it is checked and stored (#588, owner ruling Round 9,
// 2026-10-20). Built for the customer page to apply before it sends and the server to apply again
// before it checks (the plan's T2 and T3), so the box shows what the server stores.
//
// PLAIN NODE LOADS THIS FILE: the E2E harness imports it by its `.ts` name, and node strips the
// types and changes nothing else. So it imports nothing and keeps to syntax node can strip
// (annotations and type aliases: no enum, no namespace, no parameter property). One case of
// tests/invoice-folder-entry.test.ts holds that: it imports this file under plain node.

/** The file at the top of the share's mount that proves the share is mounted (owner ruling,
 *  2026-10-20). The app only checks that it exists. */
export const CUSTOMER_FOLDERS_MARKER = "HeatSynQ - do not delete.txt";

// One pass: trim; strip one pair of surrounding double quotes (Explorer's "Copy as path") when no
// other quote is inside them; "/" becomes "\"; trailing "\" go, but a value made only of
// backslashes is kept whole, so stripping them never makes the blank that files nothing (whitespace
// or empty quotes alone do become it); a bare drive root is "X:\" ("Z:" and "Z:\" both become "Z:\").
// Inner doubled backslashes are kept (the leading "\\" of a UNC path is not inner).
function normalizeOnce(raw: string): string {
  let value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"') && !value.slice(1, -1).includes('"')) {
    value = value.slice(1, -1);
  }
  value = value.replaceAll("/", "\\").replace(/([^\\])\\+$/, "$1");
  return /^[A-Za-z]:$/.test(value) ? `${value}\\` : value;
}

/** The pass repeated until the value stops changing, so normalising a normalised value changes
 *  nothing; a value wrapped in two pairs of quotes keeps both. The loop ends: a pass whose result is
 *  a drive root ("X:\") is followed by one that keeps it, and any other pass that changes the value
 *  shortens it or turns a "/" into a "\". */
export function normalizeInvoiceFolder(raw: string): string {
  let value = raw;
  for (;;) {
    const next = normalizeOnce(value);
    if (next === value) return value;
    value = next;
  }
}
