// Client-safe and pure: the Invoicing list's Print selected run (#591, owner rulings 591-4 to 591-8
// and the words the owner approved on 2026-10-20). It decides what each print's answer means for its
// row, when the run stops, how the prints become one zip and its name, which boxes stay ticked
// after a run or a reload, and the run's sentences. No src/server imports (CLAUDE.md: a client
// component pulling from there drags node:async_hooks and Prisma into the browser bundle). Its
// imports are `unansweredStatus`, the one rule for whether a failed request got an answer,
// `printWarningSentence`, the invoice page's reading of a print's folder header (#588), and
// fflate's `zipSync`.
//
// It lives in src/lib for line-field-saves.ts's reason: vitest has no component renderer, so decided
// inline in InvoicingList none of this could be proven by mutation.

import { zipSync, type Zippable } from "fflate";
import { unansweredStatus } from "./line-field-saves";
import { printWarningSentence } from "./print-tab";

/** A print whose answer the page cannot trust: it may have been stored (the owner, 2026-10-20). */
export const LOST_ANSWER = "It may have printed, but the answer was lost. Reload to see.";

/** One print request, `POST /api/invoices/<id>/print?selected=1`, as the page sends it. */
export type PostPrint = (id: string) => Promise<Response>;

/** One printed row: its invoice id and the bytes the server stored. */
export type PrintedRow = { id: string; bytes: Uint8Array };

export type SelectedPrintRun = {
  /** Each printed row, in run order. */
  printed: PrintedRow[];
  /** Invoice id → the sentence shown beside that row. */
  failures: Map<string, string>;
  /** Invoice id → the folder sentence shown beside a row that printed but was not filed in its
   *  customer folder: its answer's `x-print-warnings`, read as the single Print reads it (#588; the
   *  owner's ruling of 2026-10-21). Only a printed row has one, so no row is in both maps. */
  warnings: Map<string, string>;
  /** Whether `stillOpen` answered false before a request, so the rest were never sent. A page that
   *  goes during the last request is not caught here: the run asks nothing after it, and the page
   *  reads its own mount flag once the run returns. */
  stopped: boolean;
};

/**
 * Prints each id through `post`, one at a time in the order given (591-4/5: the list's order), and
 * returns what printed, each failure's sentence and each printed row's folder sentence. A failure
 * is that row's alone and the run carries on. One at a time, never Promise.all: leaving the page
 * stops the run after the request in flight, which needs there to be one, and selected prints
 * running together can abort each other under Serializable even over different invoices
 * (`printSelectedInvoice` retries them).
 *
 * `stillOpen` is asked before every request, the first included (591-6: leaving the page stops the
 * run after the request in flight). A request already sent cannot be taken back; it runs to its
 * answer and the run stops there.
 */
export async function runSelectedPrints(
  ids: readonly string[], post: PostPrint, stillOpen: () => boolean,
): Promise<SelectedPrintRun> {
  const printed: PrintedRow[] = [];
  const failures = new Map<string, string>();
  const warnings = new Map<string, string>();
  for (const id of ids) {
    if (!stillOpen()) return { printed, failures, warnings, stopped: true };
    const outcome = await printOne(id, post);
    if (typeof outcome === "string") {
      failures.set(id, outcome);
    } else {
      printed.push({ id, bytes: outcome.bytes });
      // "" is an empty header array, which the invoice page draws no line for (its `printWarning &&`).
      if (outcome.warning) warnings.set(id, outcome.warning);
    }
  }
  return { printed, failures, warnings, stopped: false };
}

/** One print's bytes and its folder sentence (`printWarningSentence`'s: null when its answer
 *  carries none), or the sentence its row shows when it did not print. */
async function printOne(id: string, post: PostPrint): Promise<{ bytes: Uint8Array; warning: string | null } | string> {
  let refused: Response;
  try {
    const res = await post(id);
    if (res.ok) {
      const warning = printWarningSentence(res.headers.get("x-print-warnings"));
      return { bytes: new Uint8Array(await res.arrayBuffer()), warning };
    }
    // A 5xx is no answer the page can trust: the route resolves the download's file name after its
    // transaction commits, so a 5xx can follow a print that was stored.
    if (unansweredStatus(res.status)) return LOST_ANSWER;
    refused = res;
  } catch {
    // No answer arrived, or the server answered 2xx and its bytes could not be read (#547): the
    // case `unansweredStatus` takes as a null status. The print may have been stored.
    return LOST_ANSWER;
  }
  // Any other status is the server's refusal, which stored nothing: its own sentence, or the
  // invoice page's fallback when it sent none.
  const body: unknown = await refused.json().catch(() => null);
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === "string" ? error : `Print failed (${refused.status})`;
}

/**
 * The run's prints as one zip, each entry stored uncompressed (a PDF's streams are compressed
 * already), in the order given. A repeated name is kept as `-2`, then `-3`, before its extension
 * rather than overwriting the entry before it. None is expected (one live invoice per order, and
 * credit numbers are unique), so this only keeps a print from being lost silently.
 *
 * The entries go into an object, which zipSync writes in key order: a name that read as an array
 * index (`1001`) would be moved ahead of the rest. The page's names end in `.pdf`, so none does.
 */
export function zipPrints(entries: readonly { name: string; bytes: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  const files: Zippable = {};
  for (const { name, bytes } of entries) files[freeName(name, files)] = [bytes, { level: 0 }];
  return zipSync(files);
}

/** `name`, or the first of `<stem>-2<ext>`, `<stem>-3<ext>`… that `taken` does not hold. Sliced, not
 *  matched: a pattern naming a digit and a point is refused in src/ (tests/decimal-pattern-sweep). */
function freeName(name: string, taken: Zippable): string {
  if (!Object.hasOwn(taken, name)) return name;
  const point = name.lastIndexOf(".");
  const stem = point > 0 ? name.slice(0, point) : name;
  const extension = point > 0 ? name.slice(point) : "";
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}${extension}`;
    if (!Object.hasOwn(taken, candidate)) return candidate;
  }
}

/** `invoices-YYYY-MM-DD.zip`, the browser's local date (the owner, 2026-10-20). */
export function zipFileName(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `invoices-${now.getFullYear()}-${month}-${day}.zip`;
}

/**
 * The ticks after a run, given the ticks as they stand (`prev`), the ids the run was sent (`ran`),
 * its failures, and the tickable ids of the list the run's reload put on screen. Failed rows stay
 * ticked beside their sentences (591-4), and a tick added during the run survives it (the boxes
 * stay live during a run, #145); a row that printed is unticked.
 *
 * Always intersected with `tickable`, unlike Create invoices' post-run rule, which skips the
 * intersection when its reload applied nothing. The page prunes the ticks to the tickable rows at
 * every applied load of the list, so a failed or superseded reload leaves `tickable` as the last
 * applied list's, and keeping a failure outside it would re-tick a row whose box an earlier load
 * removed.
 *
 * Returns a new Set every time: the result is React state (the `applySelectAll` rule).
 */
export function printTicksAfterRun(
  prev: ReadonlySet<string>, ran: ReadonlySet<string>, failures: ReadonlyMap<string, string>,
  tickable: ReadonlySet<string>,
): Set<string> {
  const next = new Set(failures.keys());
  for (const id of prev) if (!ran.has(id)) next.add(id);
  for (const id of next) if (!tickable.has(id)) next.delete(id);
  return next;
}

/** The ticks after a load of the list: those whose row still has a box. The same Set when nothing
 *  drops, so a load that changes nothing sets no new state (`retained`'s rule, line-field-saves.ts). */
export function pruneToTickable(prev: Set<string>, tickable: ReadonlySet<string>): Set<string> {
  const next = new Set<string>();
  for (const id of prev) if (tickable.has(id)) next.add(id);
  return next.size === prev.size ? prev : next;
}

/** The confirm before a run, naming the count of ticked rows on screen. */
export function confirmText(count: number): string {
  const { title, body } = confirmParts(count);
  return `${title} ${body}`;
}

/** The same sentence as the modal asks it (PR 6, ruling 5): its question the title, the rest the
 *  body. `confirmText` is the two joined, so the native and modal forms cannot drift. */
export function confirmParts(count: number): { title: string; body: string } {
  return count === 1
    ? { title: "Print 1 document?", body: "It is filed under its own Documents, and the PDF downloads as a zip file." }
    : { title: `Print ${count} documents?`, body: "Each is filed under its own Documents, and the PDFs download as one zip file." };
}

/** Said after the closing line when the prints were filed but their zip could not be built (the
 *  owner, 2026-10-21: "Say so, carry on"). */
export const ZIP_FAILED = "The zip could not be made; each print is under its own Documents.";

/** The line beside the button after a run, then `ZIP_FAILED` when the zip could not be made. */
export function resultText(printed: number, count: number, zipFailed = false): string {
  const line = `Printed ${printed} of ${count}.`;
  return zipFailed ? `${line} ${ZIP_FAILED}` : line;
}
