// A quote line's window as the screens state it (#646): "effective 10/01/2026 to 12/31/2026".
// Pure and client-safe. The server hands both dates as YYYY-MM-DD (quote-links.ts's
// QuoteLinkCandidate); `formatDate` keeps a civil date's day. The server's own refusal sentence
// keeps its ISO dates and does not read this.
import { formatDate } from "./format";

export function quoteWindowLabel(c: { effectiveDate: string; expiryDate: string }): string {
  return `effective ${formatDate(c.effectiveDate)} to ${formatDate(c.expiryDate)}`;
}
