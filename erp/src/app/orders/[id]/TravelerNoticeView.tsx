"use client";
import { staleTravelers, travelerNoticeText, type NoticeOrder, type NoticePrint } from "@/lib/traveler-notice";
import { NOTICE } from "@/lib/ui-classes";

/**
 * The traveler notice as it is drawn: one amber line, or nothing.
 *
 * Whether a printed traveler is out of date, which loads it names and every word of the sentence
 * are `src/lib/traveler-notice.ts`'s. This component decides nothing and holds no hook, so it
 * renders the same from a test as on the page.
 *
 * It has no control of its own. The print action is the summary's Print all button beside it:
 * one print controller, no second request site (design 2026-10-06, §10.3 "Shown").
 */
export function TravelerNoticeView({ order, prints }: { order: NoticeOrder; prints: readonly NoticePrint[] }) {
  const text = travelerNoticeText(staleTravelers(order, prints));
  if (text === null) return null;
  return <p role="status" className={NOTICE.warning}>{text}</p>;
}
