"use client";
import { formatDate, formatNumber } from "@/lib/format";
import Link from "next/link";
import { LIGHT_LABELS, LIGHT_DOT_CLASS, type TrafficLight } from "@/lib/traffic-light";
import { ORDER_STATUS_LABELS, type OrderStatusValue } from "@/lib/order-constants";
import type { ColumnDef, ColumnKey, SortState } from "@/lib/board-columns";
import { LINK, TABLE_CELL, TABLE_HEAD } from "@/lib/ui-classes";

// Presentational only (#33's bounded slice): rows, the visible column defs and the sort state all
// live in the board page (src/app/page.tsx) — this file renders the table, computes each cell's
// display (renderCell/sortArrow are pure functions of props), and reports header/row clicks up.

// Local mirror of src/server/order-board.ts's BoardRow — not imported from src/server/** (CLAUDE.md
// "Constraints that will bite you": a client component pulling from there drags node:async_hooks
// and Prisma into the browser bundle). Dates arrive pre-formatted as "yyyy-mm-dd" strings
// (`formatDateOnly` runs server-side before `NextResponse.json`). Display helpers arrange those
// civil-date fields without timezone conversion; sort and filter values remain ISO strings.
export type BoardRow = {
  id: string; orderNumber: number; customerCode: string; customerName: string;
  leadPartNumber: string; poNumber: string; vsOrderNumber: string;
  qty: number; weight: number;
  receivedDate: string; requestDate: string; targetDate: string | null;
  status: OrderStatusValue; voided: boolean; light: TrafficLight;
  loadCount: number; linked: boolean;
};

type Props = {
  rows: BoardRow[];
  /** #223 item 4: has the first load resolved? The empty-state row must not render before it
   *  (the board makes two sequential round trips per visit), and "no rows yet" is not "no
   *  match". Owned by the parent, which owns the fetch. */
  loaded: boolean;
  visibleDefs: ColumnDef[];
  sort: SortState;
  onToggleSort: (col: ColumnDef) => void;
  onOpenOrder: (id: string) => void;
};

function renderCell(row: BoardRow, key: ColumnKey) {
  switch (key) {
    case "orderNumber": return (
      <Link href={`/orders/${row.id}`} onClick={(event) => event.stopPropagation()}
            className={`${LINK} font-mono`}>
        {row.orderNumber}
      </Link>
    );
    case "customer": return `${row.customerCode} · ${row.customerName}`;
    case "leadPart": return row.leadPartNumber;
    case "po": return row.poNumber;
    case "qty": return formatNumber(row.qty);
    case "weight": return formatNumber(row.weight, 2);
    case "received": return formatDate(row.receivedDate);
    case "request": return formatDate(row.requestDate);
    case "target": return formatDate(row.targetDate);
    case "lightStatus":
      return row.voided ? "Voided" : (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${LIGHT_DOT_CLASS[row.light]}`} />
          <span>{LIGHT_LABELS[row.light]}</span>
          <span className="text-ink-500">· {ORDER_STATUS_LABELS[row.status]}</span>
        </span>
      );
    case "loads": return formatNumber(row.loadCount);
    case "linked":
      return row.linked
        ? <span className="rounded bg-link-50 px-1 text-xs text-link-700">linked</span>
        : null;
    case "vsNumber": return row.vsOrderNumber;
    default: return null;
  }
}

export function BoardTable({ rows, loaded, visibleDefs, sort, onToggleSort, onOpenOrder }: Props) {
  function sortArrow(col: ColumnDef): string {
    if (!col.sortKey || sort.sort !== col.sortKey) return "";
    return sort.dir === "asc" ? " ▲" : " ▼";
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full bg-surface-0 text-sm">
        <thead>
          <tr className="border-b text-left">
            {visibleDefs.map((col) => (
              <th key={col.key} className={`${TABLE_HEAD} p-2 ${["qty", "weight", "loads"].includes(col.key) ? "text-right" : ""}${col.key === "weight" ? " lg:whitespace-nowrap" : ""}`}
                  aria-sort={col.sortKey
                    ? (sort.sort === col.sortKey ? (sort.dir === "asc" ? "ascending" : "descending") : "none")
                    : undefined}>
                {col.sortKey ? (
                  <button type="button" onClick={() => onToggleSort(col)}
                          className="cursor-pointer select-none">
                    {col.label}{sortArrow(col)}
                  </button>
                ) : col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && loaded && (
            <tr>
              <td colSpan={visibleDefs.length || 1} className="p-4 text-center text-ink-500">
                No orders match these filters.
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <tr key={row.id} onClick={() => onOpenOrder(row.id)}
                className={`cursor-pointer border-t hover:bg-surface-50 ${row.voided ? "[&>td]:text-ink-500" : ""}`}>
              {visibleDefs.map((col) => (
                <td key={col.key}
                    className={`${TABLE_CELL} ${["qty", "weight", "loads"].includes(col.key) ? "text-right tabular-nums" : ""} ${["orderNumber", "po", "received", "request", "target", "vsNumber"].includes(col.key) ? "whitespace-nowrap" : ""}`}>
                  {renderCell(row, col.key)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
