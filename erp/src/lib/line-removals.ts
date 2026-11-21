// Client-safe and pure: the order hub's record of a line Remove the server did not answer, and the
// one answer that proves the line gone (#475, owner ruling 2026-10-15, "Mark until gone"). Its one
// import is `retained`, from the Qty and Net weight boxes' leaf, so `removalsListed` prunes marks
// by the same intersection that prunes the lines a weight is offered for.
//
// The record is a Set of line ids. Its holder keeps it in state and applies each transition as
// `setRemovals((cur) => f(cur, …))`. Every transition returns the SAME Set when it changes nothing,
// so a call that changes nothing is a React state bailout and not a re-render, and none writes into
// the Set it is given. It lives in src/lib for line-field-saves.ts's reason: vitest has no
// component renderer, so decided inline none of this could be proven by mutation.
//
// WHAT SETS A MARK: a Remove that got no answer the page can trust, by R13 (no response, or a 5xx),
// which `unansweredStatus` in line-field-saves.ts states. That DELETE may have been committed, so
// the order on the page may list a line the server no longer holds. Since #547 a Remove answered
// 2xx whose body could not be read (`UnreadableAnswerError`, no `status`) sets a mark too, by the
// owner's ruling of 2026-10-18, which R13 did not cover. That DELETE was committed (a 2xx proves
// it), so the line is gone; it is marked all the same (the owner's answer of 2026-10-18 on the
// marks, "Accept as they are"), and nothing reads the order for it (ruling 2 of 2026-10-18: no
// re-read). A refusal the server answered sets nothing: it wrote nothing.
//
// WHAT ENDS IT: one thing, a payload that no longer lists the line (`removalsListed`). A payload
// that still lists it ends nothing (R18, the owner's ruling of 2026-10-15, #478): it may have been
// read or answered before the lost DELETE was committed. Neither does a refusal of a retry: the
// answer to a later request ends nothing by itself. A 404 LINE_NOT_FOUND (below) proves the line
// gone, so the section has the page read the order, and that read's payload, when it lands, is
// what ends the mark. The record is page state and nothing else, so a reload starts without it.
//
// WHY 404 "Order line not found" PROVES THE LINE GONE, for any Remove so answered, a first one as
// well as a retry (owner, 2026-10-15). `removeLine` (src/server/order-edit.ts) runs Serializable,
// and its first statement claims the order with SELECT … FOR UPDATE, so its snapshot is fixed when
// that claim starts. It answers 404 "Order not found" for a missing or voided order, and 400 under
// a finalized invoice (#486), before it reads the line; LINE_NOT_FOUND therefore means a live order
// whose snapshot does not hold the line, so a line it held was deleted by a commit before then. A
// snapshot taken before a concurrent delete committed still holds the line, and the removal then
// aborts with 40001, which `withDbErrors` answers as a 409 that proves nothing. A line id is a cuid,
// the line is hard-deleted, and no write moves a line to another order, so a line this order held
// and lost is gone for good: a read begun after the 404 arrived cannot list it. "Order not found",
// a 404 that is not the app's (`api()` reads one whose body names no error as "Request failed
// (404)"), every 400, every 409 and no answer at all prove nothing. A 2xx whose body could not be
// read does prove the line gone, but `removalProvesGone` is handed it as `status` null and answers
// false, so the line is marked (WHAT SETS A MARK, above).

import { retained } from "./line-field-saves";

/** `removeLine`'s, `updateLine`'s and `replaceSerials`' answer for a line the order does not hold.
 *  The server throws this constant, so the page compares against the very text it sends. */
export const LINE_NOT_FOUND = "Order line not found";

/** The mark beside a marked line's Remove control. */
export const REMOVAL_NOT_CONFIRMED = "Removal not confirmed";

/** The reason in a marked line's detail row. `label` is the line's own ("Line 2"). */
export function removalReason(label: string): string {
  return `${label}: the app could not tell whether the removal went through. Press Remove to try ` +
    "again, or reload the page to see what the order holds.";
}

/** The banner after a Remove proved the line gone and the order read after it landed. `naming` is
 *  the line as the Remove confirm names it ("ACME · P-100 (Line 2)"). */
export function alreadyRemovedMessage(naming: string): string {
  return `${naming} had already been removed from this order.`;
}

/** The banner after a Remove proved the line gone and the order read after it failed. `naming` is
 *  as for `alreadyRemovedMessage`; `readError` is the failed read's message. */
export function removedNotRefreshedMessage(naming: string, readError: string): string {
  return `${naming} is no longer on this order, but the page could not be refreshed — reload to ` +
    `see the current state. (${readError})`;
}

/** The ids of the lines whose Remove got no answer the page can trust. */
export type UnconfirmedRemovals = ReadonlySet<string>;

/** The empty record. One module-level Set: its identity is the initial state. */
export const NO_UNCONFIRMED_REMOVALS: UnconfirmedRemovals = new Set();

/** A Remove of `lineId` got no answer: the line is marked. The same Set when it already is. */
export function removalUnanswered(marks: UnconfirmedRemovals, lineId: string): UnconfirmedRemovals {
  if (marks.has(lineId)) return marks;
  const next = new Set(marks);
  next.add(lineId);
  return next;
}

/** A payload arrived listing `liveIds`: the mark of every line it no longer lists goes, and the
 *  mark of a line it still lists stays (R18). The same Set when nothing goes. */
export function removalsListed(marks: UnconfirmedRemovals, liveIds: Iterable<string>): UnconfirmedRemovals {
  return retained(marks, liveIds);
}

/** Whether a removal stands unconfirmed on a line of `lines`, the order on the page. A mark on a
 *  line it no longer lists does not count: a failure that landed after a payload had dropped the
 *  line, which the next payload prunes (`anyNotSaved`'s server filter). */
export function anyRemovalUnconfirmed(marks: UnconfirmedRemovals, lines: readonly { readonly id: string }[]): boolean {
  if (marks.size === 0) return false;
  return lines.some((line) => marks.has(line.id));
}

/** Whether the line is marked. */
export function removalUnconfirmed(marks: UnconfirmedRemovals, lineId: string): boolean {
  return marks.has(lineId);
}

/** What a line's detail row says about its removal: the reason for a marked line (`label` is the
 *  line's own), null for any other. */
export function removalNotice(marks: UnconfirmedRemovals, lineId: string, label: string): string | null {
  return removalUnconfirmed(marks, lineId) ? removalReason(label) : null;
}

/** Whether a Remove's failure proves the line gone: the app's 404 with LINE_NOT_FOUND, word for
 *  word, and nothing else. `status` is null when no response arrived or, since #547, when the
 *  server answered 2xx and its body could not be read (`UnreadableAnswerError` carries no
 *  `status`). That 2xx committed the DELETE, and this answers false for it all the same: the line
 *  is marked, by the owner's answer of 2026-10-18 on the marks ("Accept as they are"). */
export function removalProvesGone(status: number | null, message: string): boolean {
  return status === 404 && message === LINE_NOT_FOUND;
}
