/**
 * The list window (ruling R3, 2026-10-22 review; #612): the board, shipping and invoicing lists
 * default to a window of 200 rows with a visible "Showing newest 200, refine or show all", while
 * parts, customers and quotes stay unlimited and every export stays unlimited (the 2026-10-21 "No
 * limit" ruling). The owner's PR B answer (2026-10-25): the window is the FIRST 200 rows of the
 * applied sort, which is the newest 200 under the default newest-first sort.
 *
 * Client-safe and pure: the pages draw the sentence from `windowNotice`, and a route's windowed
 * read takes `LIST_WINDOW + 1` rows and hands them to `cutToWindow`, so one read answers both the
 * rows and whether anything was cut. The window is a ROUTE mode the list page opts into, never a
 * service default: the services behind these routes also feed the exports and other pickers.
 */
export const LIST_WINDOW = 200;

export type ListWindow<T> = { rows: T[]; cut: boolean };

/** `rows` read with `take: window + 1`: the window's rows, and whether the read went past it. */
export function cutToWindow<T>(rows: T[], window = LIST_WINDOW): ListWindow<T> {
  return rows.length > window ? { rows: rows.slice(0, window), cut: true } : { rows, cut: false };
}

export type WindowNotice = { lead: string; action: "show all" };

/** The sentence over a cut list: the ruled one under a newest-first sort, and one that says what
 *  the window holds under any other sort, where the first 200 are not the newest. The action is
 *  the sentence's last words, drawn as the control that re-reads unbounded. */
export function windowNotice(cut: boolean, sort: { newestFirst: boolean }): WindowNotice | null {
  if (!cut) return null;
  return {
    lead: sort.newestFirst ? `Showing newest ${LIST_WINDOW}, refine or` : `Showing first ${LIST_WINDOW} of this sort, refine or`,
    action: "show all",
  };
}

/**
 * The page's "show all" override (Codex on PR B, 2026-10-27): the query it was clicked under and
 * which click, so that a repeat click after a failed read is a NEW value and sends again, where a
 * plain flag set to the same value would send nothing.
 */
export type ShowAll = Readonly<{ query: string; attempt: number }> | null;

/** A click on "show all" under `query`. */
export function showAllClicked(prev: ShowAll, query: string): ShowAll {
  return { query, attempt: (prev?.attempt ?? 0) + 1 };
}

/** The override as it stands under `query`: held while the page is on the query it was clicked
 *  under, DROPPED the moment the query leaves it, never retained for a later return to that query
 *  (a cleared search would otherwise re-read every row unasked). The page asks this in render and
 *  stores the answer when it differs, so no read goes out under a stale override. */
export function showAllFor(state: ShowAll, query: string): ShowAll {
  return state !== null && state.query === query ? state : null;
}
