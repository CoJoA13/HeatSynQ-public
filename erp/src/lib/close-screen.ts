// Client-safe leaf (no src/server imports): the Month-End Close screen's decisions, in one place so
// vitest can mutation-prove them without a renderer (#649, the 2026-10-22 review's P10; the
// `printControlTitle` precedent, statements-screen.ts). The screen used to hold one `year` for two
// jobs, the Year box's text and the period it had committed to, so `Number()` committed every
// keystroke (`""` is 0, `202` on the way to `2026` is a year), and it kept the previous period's
// schedule and gaps in page-wide state that nothing keyed to a period: a month switch showed last
// month's figures under this month's heading with Close enabled while the reads were out, and for
// good after a failed read. Here the Year box commits only a whole year inside the close bounds
// (ruling 19's whole-number rule), the figures shown are the committed period's own payloads
// (`PreliminaryReport` carries its `year`/`month`; the readiness gaps are stored with theirs), a
// read error is keyed to the period it was raised for, and the Close button's title reads all of
// that, so no period's figures can be acted on under another's heading.
import { formatMoney } from "./format";
import { MAX_CLOSE_YEAR, MIN_CLOSE_YEAR, type ReadinessGapKind } from "./gl-constants";
import type { Gate } from "./permission-ui";
import { readWholeNumber } from "./whole-number-entry";

export type ClosePeriodKey = { year: number; month: number };
export type ReadinessGap = { kind: ReadinessGapKind; id: string | null; label: string; href: string };
export type ContinuitySchedule = {
  beginningAr: number; invoicedTotal: number; creditTotal: number; paymentTotal: number;
  discountTotal: number; writeOffTotal: number; endingAr: number; agingEndingAr: number; variance: number;
};
export type PreliminaryReport = ClosePeriodKey & {
  schedule: ContinuitySchedule; unpostedBatchCount: number; alreadyClosed: boolean;
};
/** The readiness gaps as the screen stores them: with the period they were read for. */
export type PeriodReadiness = ClosePeriodKey & { gaps: ReadinessGap[] };
/** A failed read, kept with the period it failed for. */
export type PeriodReadError = ClosePeriodKey & { message: string };
/** A message raised by an action on a period (the Close button's refusal), kept with its period. */
export type PeriodMessage = ClosePeriodKey & { text: string };

const YEAR_BOX = { label: "Year", min: MIN_CLOSE_YEAR, max: MAX_CLOSE_YEAR };
const MONTH_BOX = { label: "Month", min: 1, max: 12 };

/** The whole year `text` names, inside the close bounds (`MIN_CLOSE_YEAR`..`MAX_CLOSE_YEAR`), or
 *  null: the Year box's text and the `?year=` URL value both read through this, so neither `""`
 *  nor `2e3` nor a year still being typed commits a period. */
export function closeYearFrom(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  const reading = readWholeNumber(text, YEAR_BOX);
  return reading.ok ? reading.value : null;
}

/** The month `text` names, 1 to 12, or null (the `?month=` URL value). */
export function closeMonthFrom(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  const reading = readWholeNumber(text, MONTH_BOX);
  return reading.ok ? reading.value : null;
}

const samePeriod = (a: ClosePeriodKey, b: ClosePeriodKey) => a.year === b.year && a.month === b.month;

export type PeriodFigures = {
  /** `uncommitted`: no period (the Year box holds no whole year in bounds). `loading`: the period's
   *  two payloads have not both landed. `error`: the period's read failed, and its figures are
   *  hidden even where a matching payload is held. `ready`: both payloads are the period's own. */
  status: "uncommitted" | "loading" | "error" | "ready";
  preliminary: PreliminaryReport | null;
  gaps: ReadinessGap[] | null;
  message: string | null;
};

/** What the screen shows for `period` out of what it holds: only payloads whose own period is
 *  `period`, and nothing of a period whose read failed. Payloads of another period are neither
 *  shown nor an error: they are the previous month's, left in state until this month's land. */
export function periodFigures(
  held: { preliminary: PreliminaryReport | null; readiness: PeriodReadiness | null; readError: PeriodReadError | null },
  period: ClosePeriodKey | null,
): PeriodFigures {
  if (period === null) return { status: "uncommitted", preliminary: null, gaps: null, message: null };
  if (held.readError !== null && samePeriod(held.readError, period)) {
    return { status: "error", preliminary: null, gaps: null, message: held.readError.message };
  }
  const preliminary = held.preliminary !== null && samePeriod(held.preliminary, period) ? held.preliminary : null;
  const readiness = held.readiness !== null && samePeriod(held.readiness, period) ? held.readiness : null;
  if (preliminary === null || readiness === null) return { status: "loading", preliminary: null, gaps: null, message: null };
  return { status: "ready", preliminary, gaps: readiness.gaps, message: null };
}

export const UNCOMMITTED_YEAR_TITLE = `Enter a year from ${MIN_CLOSE_YEAR} to ${MAX_CLOSE_YEAR}`;
export const FIGURES_FAILED_TITLE = "The schedule for this period could not be loaded";

/** The Close button's title (its disabled reason), or undefined when it may be clicked. In order: a
 *  missing permission, the two dangerous specials' gate first; then the period's figures (an
 *  uncommitted year, a read still out, a failed read); then the schedule's variance; then the
 *  prior month; then a close already in flight. */
export function closeTitle(input: {
  editGate: Gate; closeDoGate: Gate; figures: PeriodFigures; priorOk: boolean; closing: boolean;
}): string | undefined {
  if (!input.editGate.allowed) return input.editGate.title;
  if (!input.closeDoGate.allowed) return input.closeDoGate.title;
  const { figures } = input;
  if (figures.status === "uncommitted") return UNCOMMITTED_YEAR_TITLE;
  if (figures.status === "error") return FIGURES_FAILED_TITLE;
  if (figures.status === "loading" || figures.preliminary === null) return "Loading…";
  const { variance } = figures.preliminary.schedule;
  if (variance !== 0) return `Variance must be zero to close (currently ${formatMoney(variance)})`;
  if (!input.priorOk) return "The prior month must be closed first";
  if (input.closing) return "Closing…";
  return undefined;
}

/** A message's text when it was raised for `period`, else null: a refusal of September's close is
 *  not shown under October's heading. */
export function messageFor(message: PeriodMessage | null, period: ClosePeriodKey | null): string | null {
  if (message === null || period === null || !samePeriod(message, period)) return null;
  return message.text;
}

/** What Export to GL asks before an export that reverses events already exported (owner ruling R25,
 *  #705; worded by the owner 2026-11-02): `count` is every event the export reverses, a changed one
 *  posted again and one no longer in the month alike (the owner's answer: one sentence for both).
 *  Null at zero: the export goes ahead without asking. */
export function reversalWarning(count: number): { title: string; body: string; confirm: string } | null {
  if (count <= 0) return null;
  return {
    title: "Reverse earlier postings?",
    body: count === 1
      ? "This export reverses 1 event already exported and posts it again."
      : `This export reverses ${count} events already exported and posts them again.`,
    confirm: "Export GL summary",
  };
}
