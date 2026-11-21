"use client";
// One totals table of a shipment (the weights design §12.2): Net (lb), Tare (lb) and Gross (lb)
// over one row of figures, with the line under it. The same component draws one order's totals and
// the whole shipment's.
//
// Every cell and every sentence is decided in src/lib/shipment-totals.ts. This file draws the view
// it is handed and decides nothing. It has no hook, no state and no control, so a test can render
// it to static markup and can call it as a plain function.
//
// The markup is held to what reads it (tests/helpers/shipment-totals-markup.ts):
//  - the root is one `div` marked `data-shipment-totals`. It holds the table and the line under it
//    and no other `div`;
//  - the table's name is set on the table, so the tag in the caption is not part of the name;
//  - the caption is one span, and a second while the view is unsaved;
//  - the line under the table is one status paragraph;
//  - nothing in it is a link.
import { UNSAVED_TOTALS } from "@/lib/order-totals";
import { SHIPMENT_TOTALS_COLUMNS, type TotalsTableView } from "@/lib/shipment-totals";
import { BADGE_WARNING } from "@/lib/ui-classes";

/** The tag of the order totals table, class for class (src/components/OrderTotalsTable.tsx).
 *  shipment-totals-table.test.tsx renders both tables and compares the two tags. */
const TAG = BADGE_WARNING;
/** A figure's cell, and the column heading above it. */
const CELL = "px-2 py-1 text-right tabular-nums";

export function ShipmentTotalsTable({ totals }: { totals: TotalsTableView }) {
  return (
    <div data-shipment-totals className="my-3 overflow-x-auto">
      <table aria-label={totals.caption} className="text-sm">
        <caption className="pb-1 text-left">
          <span className="mr-3 font-medium text-ink-800">{totals.caption}</span>
          {totals.unsaved && <span className={TAG}>{UNSAVED_TOTALS}</span>}
        </caption>
        <thead>
          <tr>
            {SHIPMENT_TOTALS_COLUMNS.map((heading) => (
              <th key={heading} scope="col" className={`${CELL} font-medium`}>{heading}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className={CELL}>{totals.net}</td>
            <td className={CELL}>{totals.tare}</td>
            <td className={CELL}>{totals.gross}</td>
          </tr>
        </tbody>
      </table>
      {totals.note !== null && <p role="status" className="mt-1 text-sm text-ink-500">{totals.note}</p>}
    </div>
  );
}
