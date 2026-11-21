// #743: the order's container total, every container row's count added up. It is the figure order
// entry's Loads card shows as Containers, and the one every container tag prints as the number of
// containers for the work order (owner confirmation, 2026-10-23). A row's count is how many
// containers the row is; its pieces are not read here (`containerPieces`, order-reconciliation.ts,
// adds those). Client-safe: no import.

/** Every row's count added up; 0 for no rows. */
export function containerTotal(rows: readonly { count: number }[]): number {
  return rows.reduce((sum, row) => sum + row.count, 0);
}
