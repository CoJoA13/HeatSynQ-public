/**
 * The line-break characters printed paper reads (#522, #590; R15 of the 2026-10-22 review, #672).
 * One set, stated once, and read by every builder that asks: the shipping ticket measures its
 * tear-off strip where the Sold To name holds one (pdf/shipping-ticket.ts `tearOff`), the invoice
 * prints each one in its order strip as a space (pdf/invoice.ts `orderStrip`), the Invoice register
 * folds every run of white space holding one into a space (`oneLine`; invoice-register.ts), and so
 * does the container tag (pdf/container-tags.ts, whose lines are `noWrap`, which stops wrapping by
 * width and nothing else).
 *
 * In src/lib and import-free, so a server mapping that must load with no database can read it
 * (invoice-register.ts's header). tests/shipping-ticket-templates.test.ts reads the ticket's
 * comparison from the source under the name `LINE_BREAK`: keep the name.
 */

/** The line-break characters the owner named for the Sold To name (#522, amended 2026-10-16): line
 *  feed, carriage return, the Unicode line separator (U+2028) and paragraph separator (U+2029), form
 *  feed, vertical tab and next-line (U+0085). */
export const LINE_BREAK = /[\n\r\u2028\u2029\u000C\u000B\u0085]/;

/** Every line break of `LINE_BREAK`'s set, a CR LF pair first so that the pair is one break. */
const EACH_LINE_BREAK = new RegExp(`\\r\\n|${LINE_BREAK.source}`, "g");

/** `text` with each line break, a CR LF pair as one, turned into one space (the owner's amendment of
 *  2026-10-21 on #590). Two breaks in a row are two spaces, and nothing else is changed. */
export function lineBreaksAsSpaces(text: string): string {
  return text.replace(EACH_LINE_BREAK, " ");
}

/** A run of white space that holds a line break of `LINE_BREAK`'s set; a run with none is not
 *  matched. U+0085 is not in JavaScript's `\s`, so it is added to the surrounding white space by
 *  hand (R15). */
const LINE_BREAK_RUN = new RegExp(`[\\s\\u0085]*${LINE_BREAK.source}[\\s\\u0085]*`, "g");

/** `text` with every run of white space that holds a line break printed as one space, as the screen
 *  shows it: `"Acme \n  Steel"` is `"Acme Steel"`, and text with no line break is returned as it is
 *  (the Invoice register's Amendment 17 as R15 amends it; the container tag's rule). */
export const oneLine = (text: string): string => text.replace(LINE_BREAK_RUN, " ");

/** A run of white space holding a line break, with the comma before it when there is one: the
 *  separator `oneLineAddress` replaces. */
const ADDRESS_BREAK = new RegExp(`(,?)[\\s\\u0085]*${LINE_BREAK.source}[\\s\\u0085]*`, "g");

/** An address typed on several lines, printed on one: the text trimmed, and each run of white
 *  space holding a line break (a CR LF pair, a blank line and the spaces around it included) printed
 *  as ", " (one comma, whether or not the line before it ended in one). Text with no line break is
 *  returned trimmed and otherwise as it is. The bill of lading's Ship-from sentence reads it (owner
 *  ruling R2, 2026-11-24). */
export const oneLineAddress = (text: string): string =>
  text.replace(/^[\s\u0085]+|[\s\u0085]+$/g, "").replace(ADDRESS_BREAK, ", ");
