"use client";
import { Fragment, type MouseEvent } from "react";
import {
  reconcileOrder, STRIP_SEPARATOR, type ReconciliationOrder, type StripSection,
} from "@/lib/order-reconciliation";
import { weighedFigure, type WeighedOrder } from "@/lib/order-totals";

// The reconciliation strip of a saved order: one standing line in the sticky summary. It reads
// Parts, Container pieces, Loads and Serials (the quantity corrections design, §5 and §10.2), and
// then, when `weighedFigure` answers one, Net against the weighed net (the weights design, §4.5
// and §10.2; owner ruling W10 of 2026-10-09).
//
// Every decision is a leaf's. `reconcileOrder` answers the four piece figures: what each says,
// whether it differs from Parts and which section it links to. `weighedFigure`
// (src/lib/order-totals.ts) answers the fifth as one sentence, or null when there is none to
// show. This file draws what the two return and decides nothing. It has no hook and no state, so
// a test can render it to static markup and can call it as a plain function.
//
// It reads the `order` it is given and nothing else. On the hub that is the page's `order`. The
// four lists the strip reads from it (lines, containers, loads and serials) are as the server last
// sent them: the page writes them from a server payload and from nothing else. So the weighed
// figure is saved state too, and does not follow the Containers grid as it is typed. The same
// object also holds header text as it is typed, which the strip does not read.
//
// The markup is held to what the browser flows already look for on this page:
//  - the root is a `div` with `role="group"`, not a `p` and not a `nav`;
//  - it holds no heading, no button and no input;
//  - a link's whole text is its figure. The Parts link reads "Parts 250 pcs" and is never named
//    exactly "Parts", the name three flows find the main menu's link by;
//  - a link is a plain `<a href="#…">`, as the section links under it are, never `next/link`.
//    The leave guard does not ask about a bare hash, whatever draws the anchor: that is one of
//    the clicks `shouldGuardNavigation` (src/lib/unsaved-guard.ts) lets through. What the plain
//    anchor adds is that a click `onJump` did not stop is the browser's own jump inside the
//    page, where `next/link` would hand that click to the router;
//  - the weighed figure is a `span` with no class, after the four. It is never amber and never a
//    link, and it does not make Parts a link.
// The figures sit in normal inline flow, not a flex row, so a long Serials figure can wrap and the
// spaces around each separator are kept.
//
// It informs only. It has no control and sends no request.

/** A figure that differs from Parts: amber, on an amber ground. */
const DIFFERS = "rounded bg-accent-50 px-1 text-accent-600 underline";
/** The Parts figure while another figure differs: the hub's plain link. */
const PLAIN_LINK = "text-link-700 underline";

/** The part of an order the strip reads: what `reconcileOrder` reads, and on each line and each
 *  container row what `weighedFigure` reads as well. Spelled element by element: a plain
 *  `ReconciliationOrder & WeighedOrder` refuses an order written as an object literal. The page's
 *  `OrderDetail` satisfies it as it is. */
export type StripOrder = Omit<ReconciliationOrder, "lines" | "containers"> & {
  lines: readonly (ReconciliationOrder["lines"][number] & WeighedOrder["lines"][number])[];
  containers: readonly (ReconciliationOrder["containers"][number] & WeighedOrder["containers"][number])[];
};

export function ReconciliationStrip({ order, onJump }: {
  order: StripOrder;
  /** Without it a link is the browser's own hash jump, which RecordTabs follows into its tab (PR 2). */
  onJump?: (event: MouseEvent<HTMLAnchorElement>, section: StripSection) => void;
}) {
  const { figures } = reconcileOrder(order);
  const weighed = weighedFigure(order);
  return (
    <div role="group" aria-label="Order quantities" className="px-1 pt-2 text-sm text-ink-800">
      {figures.map((figure, index) => {
        const section = figure.section;
        return (
          <Fragment key={figure.key}>
            {index > 0 && STRIP_SEPARATOR}
            {section === null
              ? <span>{figure.text}</span>
              : <a href={`#${section}`} onClick={onJump && ((event) => onJump(event, section))}
                  className={figure.differs ? DIFFERS : PLAIN_LINK}>{figure.text}</a>}
          </Fragment>
        );
      })}
      {weighed !== null && <>{STRIP_SEPARATOR}<span>{weighed}</span></>}
    </div>
  );
}
