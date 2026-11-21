"use client";
// The order totals table (the weights design §4.2, §4.3 and §10.2): Parts, Containers and Order
// in Pieces, Net (lb), Tare (lb) and Gross (lb), with the sentences under it. It is written for
// two places: order entry, and the saved order's Containers section.
//
// Every cell and every sentence is decided in src/lib/order-totals.ts. This file draws the view it
// is handed and decides nothing. It has no hook, no state and no control, so a test can render it
// to static markup and can call it as a plain function.
//
// The markup is held to what reads it:
//  - the root is one `div` marked `data-order-totals`, the mark a test or a flow finds the table
//    by. It carries `overflow-x-auto`, and it holds the table and the paragraphs and no other
//    `div`;
//  - no `div` or `label` in it opens with text. The saved order's Containers section test reads
//    each of those as a container row's cell label;
//  - the table's name is set on the table, so the tag in the caption is not part of the name;
//  - a cell the view leaves empty is an empty `td`;
//  - the note is one status paragraph, and a weighed line is a paragraph with no role.
import {
  ORDER_TOTALS_CAPTION, ORDER_TOTALS_COLUMNS, UNSAVED_TOTALS, type OrderTotalsView,
} from "@/lib/order-totals";
import { BADGE_WARNING } from "@/lib/ui-classes";

/** The tag the Loads card shows while its grid is unsaved, class for class
 *  (src/app/orders/[id]/LoadAllocationSummary.tsx). order-totals-table.test.tsx renders both. */
const TAG = BADGE_WARNING;
/** A figure's cell, and the column heading above it. */
const CELL = "px-2 py-1 text-right tabular-nums";

export function OrderTotalsTable({ totals, unsaved = false }: { totals: OrderTotalsView; unsaved?: boolean }) {
  return (
    <div data-order-totals className="my-3 overflow-x-auto">
      <table aria-label={ORDER_TOTALS_CAPTION} className="text-sm">
        <caption className="pb-1 text-left">
          <span className="mr-3 font-medium text-ink-800">{ORDER_TOTALS_CAPTION}</span>
          {unsaved && <span className={TAG}>{UNSAVED_TOTALS}</span>}
        </caption>
        <thead>
          <tr>
            <td />
            {ORDER_TOTALS_COLUMNS.map((heading) => (
              <th key={heading} scope="col" className={`${CELL} font-medium`}>{heading}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {totals.rows.map((row) => (
            <tr key={row.heading}>
              <th scope="row" className="py-1 pr-2 text-left font-medium">{row.heading}</th>
              <td className={CELL}>{row.pieces}</td>
              <td className={CELL}>{row.net}</td>
              <td className={CELL}>{row.tare}</td>
              <td className={CELL}>{row.gross}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {totals.note !== null && <p role="status" className="mt-1 text-sm text-ink-500">{totals.note}</p>}
      {totals.weighed.map((line, index) => <p key={index} className="mt-1 text-sm text-ink-800">{line}</p>)}
    </div>
  );
}
