// The print tab and the invoice page's folder line (#588). A finalized print's answer waits for its
// copy in the customer's folder, up to 10 seconds (the print route files the copy before it
// answers), and Chrome, Edge and Firefox block a tab a page opens more than about 5 seconds after
// the click (inferred, not measured). So the page opens a blank tab in the click itself and fills
// it with the stored copy when the print lands, however long that takes, and a refused print closes
// the blank tab (the owner's ruling of 2026-10-20, the plan's Amendment 8). The order hub's traveler
// buttons and the saved shipment's ticket and bill of lading open theirs the same way (#692), since
// their prints have 15-second budgets (#305, #556).
//
// Client-safe: no `src/server` import. tests/print-tab.test.ts runs both functions over a fake
// window and the invoice page's own `printInvoice` over them.
import { PRINT_WARNING_UNREADABLE } from "@/lib/customer-folder-words";

/** The tab Print opened at the click. */
export type PendingTab = {
  /** The browser refused the tab, so nothing will show the print. */
  readonly blocked: boolean;
  /** Takes the tab to `path`, a path on this app. Does nothing when the tab was blocked or has been
   *  closed, and never throws. */
  show(path: string): void;
  /** Closes the blank tab. Does nothing when it was blocked or has been closed, and never throws. */
  close(): void;
};

/**
 * Opens a blank tab. Call it synchronously in the click's handler, before any `await`: a browser
 * opens a tab for a page only shortly after a click.
 *
 * The tab is opened without the `noopener` feature, under which `open` answers null as a blocked
 * tab does, and its `opener` is cut instead, so the document it shows cannot reach this page. `show`
 * and `close` never throw: the user may close the blank tab while the print is out, and a browser
 * flow closes it too.
 */
export function openPendingTab(win: Pick<Window, "open" | "location">): PendingTab {
  const tab = win.open("", "_blank");
  if (tab) tab.opener = null;
  return {
    blocked: tab === null,
    show(path) {
      if (tab === null || tab.closed) return;
      try {
        // Absolute, built against this page's address, so the blank tab's own base never decides it.
        tab.location.replace(new URL(path, win.location.href).href);
      } catch {
        // A tab the browser will not navigate shows nothing; the print is in Documents.
      }
    },
    close() {
      if (tab === null || tab.closed) return;
      try {
        tab.close();
      } catch {
        // A tab the browser will not close stays blank.
      }
    },
  };
}

/**
 * The one line by Print for a print's `x-print-warnings` header (the print route's shape, a
 * URI-encoded JSON array of sentences), or null when the header is absent. The route sends one
 * sentence; more are joined by a space, and an empty array is "", no line, which the route never
 * sends. A header that is not that shape is the unreadable-header sentence: the route sends the
 * header only for a finalized print it did not file.
 */
export function printWarningSentence(header: string | null): string | null {
  if (header === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(header));
  } catch {
    return PRINT_WARNING_UNREADABLE;
  }
  if (!Array.isArray(parsed) || !parsed.every((sentence) => typeof sentence === "string")) {
    return PRINT_WARNING_UNREADABLE;
  }
  return parsed.join(" ");
}
