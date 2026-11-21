"use client";
// How a grid of a saved shipment's order panel hands the page what the totals tables add up (the
// weights design §12.2, "The two mounts on each page", and §12.7, point 8). The Lines and
// Containers grids each keep their own `useBulkGrid`, so the page cannot read their typed rows.
// Each grid reports them through this hook. The page keeps the reports (`withReport`,
// src/lib/shipment-totals.ts) and makes the one call that feeds every table.
//
// What a grid reports is that leaf's to decide (`linesReport`, `containersReport`). This file
// decides only when: in an effect, never while rendering.
import { useEffect } from "react";
import type { ReportTotals, TotalsReport } from "./shipment-totals";

/**
 * Reports `value` for `orderKey` from an effect, and takes the report away, as the same part with
 * a null value, in that effect's cleanup.
 *
 * A grid builds `value` anew at every render, so the effect does not depend on it. It depends on
 * `value` written out as one string, and reports what that string reads back as. A render that
 * builds an equal value builds an equal string, and the effect does not run for it. A report must
 * therefore be plain data: finite numbers, text, true or false, null, and lists and objects of
 * them.
 *
 * The cleanup runs before every later run of the effect as well as at unmount, so a change of
 * content reports the part gone and then the new value, in that order.
 *
 * Nothing here remembers that a report was made: the effect keeps nothing from one run to the
 * next, so each run reports, the run after a cleanup included. Where the effect is run, cleaned up
 * and run again, the cleanup takes the report away and the second run gives it again
 * (tests/shipment-totals-wiring.test.ts plays that by hand, and the weights design §12.2 says
 * which mount does it). Do not add a ref, or a variable outside the effect, that skips a report
 * already made.
 */
export function useTotalsReport(report: ReportTotals, orderKey: string, value: TotalsReport): void {
  const content = JSON.stringify(value);
  useEffect(() => {
    const reported = JSON.parse(content) as TotalsReport;
    report(orderKey, reported);
    return () => report(orderKey, { part: reported.part, value: null });
  }, [report, orderKey, content]);
}
