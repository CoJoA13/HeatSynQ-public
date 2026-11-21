/**
 * The bill of lading's TRV order list as printed (#943): page 1's runs in the TRV line's bold 9.5 pt,
 * from the list's column (`listX`, the label's x plus its 55 pt column) rightwards, on the TRV label's
 * baseline or below it and above the "Delivering Carrier" label's, each with its end (x plus
 * `textWidthOf` of its text, in Roboto bold at 9.5 pt; none of the kerned pairs it counts, #986, holds
 * a digit or a comma). Shared by the flow's suite (tests/bol.test.ts) and the canvas's
 * (tests/bol-canvas.test.ts), so the two read the list one way.
 */
import { textWidthOf } from "@/lib/tag-font-metrics";
import { runFonts } from "./pdf";

export type TrvRun = { text: string; x: number; y: number; end: number };

/** The TRV list's runs, top line first, left to right. Throws when the TRV label or the delivering
 *  carrier's label is not on page 1 (the reading has no band without them). */
export function trvListRuns(pdf: Buffer, listX: number): TrvRun[] {
  const runs = runFonts(pdf);
  const label = runs.find((r) => r.text.startsWith("TRV"));
  const delivering = runs.find((r) => r.text.startsWith("Delivering"));
  if (label === undefined || delivering === undefined) throw new Error("trvListRuns: no TRV or Delivering Carrier label on page 1");
  return runs
    .filter((r) => r.font === "Roboto-Medium" && r.size === 9.5 && r.x > listX - 0.01
      && r.y <= label.y + 0.5 && r.y > delivering.y + 0.5 && r.text !== "")
    .map((r) => ({ text: r.text, x: r.x, y: r.y, end: r.x + textWidthOf(r.text, "Roboto", "bold", r.size) }))
    .sort((a, b) => b.y - a.y || a.x - b.x);
}

/** The distinct baselines the list prints on, top first. */
export function trvLines(runs: TrvRun[]): number[] {
  const ys: number[] = [];
  for (const r of runs) if (!ys.some((y) => Math.abs(y - r.y) < 0.5)) ys.push(r.y);
  return ys;
}

/** The runs a list of `orderNumbers` prints as once it wraps: one run an order number, each but the
 *  last carrying its comma (the zero-width break after the comma prints nothing and reads as nothing). */
export const wrappedRuns = (orderNumbers: number[]): string[] =>
  orderNumbers.map((n, i) => (i < orderNumbers.length - 1 ? `${n},` : `${n}`));
