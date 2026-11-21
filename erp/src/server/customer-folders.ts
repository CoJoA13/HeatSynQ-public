// The office share (#588): the customer page's check that a pasted Invoice folder exists, and the
// copy of a finalized invoice or credit print into it. Built by `makeOfficeShare`, so a test can hand
// it its own fs, practice answer, settings, log and a short wait; the module's own pair at the foot
// runs on the real ones. The rules (the plan's T2; Amendments 3, 7, 8 and 9):
//
// - One chain of fs calls runs at a time, across checks and copies: the slot. A request takes its
//   deadline when it reaches the slot (then + waitMs, on a monotonic clock, so a change of the wall
//   clock moves no deadline) and is waiting, running, given up or done, each set where it is
//   decided. A request that reaches the slot while it is held, at or after the holder's deadline,
//   gives up at once, busy: the clock decides, whether or not that deadline's timer has fired yet
//   (a render can hold the event loop past it). Any other waits its turn in arrival order. When the
//   running request's deadline timer fires with its chain unsettled, every request then waiting
//   gives up, busy, and is never run. A waiter needs no timer of its own: the running request
//   arrived first, so its deadline passes first.
// - The running request races its chain against its deadline: the chain first, its answer; the
//   deadline first, timed out, and the chain keeps the slot until it settles. Nothing else frees
//   the slot: a call tied up on a hung share is never joined by a second one (Amendment 3).
// - A chain never rejects: its steps sit in one try, whose catch reads what was thrown only through
//   helpers that cannot throw (codeOf, causeOf, endedOf). The slot still has two belts for a chain
//   that rejects: it is freed at once, and its caller is answered timed out at its deadline, whose
//   timer flushes no later holder's waiters. A chain checks its deadline before every fs call of
//   its steps and, past it, stops. A copy that stops or fails after sending its write removes the
//   temp file it made (best effort, with no deadline check); a write that "wx" refused (EEXIST)
//   made none, and removes nothing.
// - Neither public function rejects: each body sits in one try whose catch answers the side's
//   general sentence (not connected for the check, refused for the copy) with a log line, so a
//   throw nobody foresaw cannot fail a print that has committed.
// - Nothing touches the share on the practice copy: that is asked before the share's settings are
//   refused as misconfigured and before any fs call. No folder is ever created (no mkdir here).
// - A copy is written to a temp dotfile with "wx" (never through anything already at that path),
//   then renamed over the filed name. Prints of one invoice or credit are filed in print order, by
//   a ticket per kind and number: one whose ticket is below the newest filed is not filed.
// - One log line per outcome that is logged, starting "[customer-folders] " and naming the file or
//   the pasted folder and the cause; never the PDF. A filed copy, a found folder, a draft, the
//   practice copy, no share, a blank folder and a pasted path the share cannot hold log nothing.
import { access, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { practiceMode } from "./practice-mode";
import {
  assertInside, filedPath, folderPath, markerPath, officeFolderSegments, resolveOfficeShare, rootDisplay,
  tempPathFor, type OfficeShare,
} from "./office-share-paths";
import { normalizeInvoiceFolder } from "@/lib/invoice-folder-entry";
import { invoiceFileName, type InvoiceFileKind } from "@/lib/invoice-file-names";
import {
  BAD_PATH_NAME, COPY_WAIT_MS, FOLDER_NOT_FOUND, PRINT_FOLDER_NOT_FOUND, PRINT_NO_FOLDER, PRINT_NOT_CONNECTED,
  PRINT_REFUSED, PRINT_SKIPPED, PRINT_TIMED_OUT, SAVE_BUSY, SAVE_NOT_CONNECTED, SAVE_TIMED_OUT, SHARE_ITSELF,
  SHARE_NOT_SET_UP, notInsideShare,
} from "@/lib/customer-folder-words";

/** What a finalized print files: `folder` is the customer's stored Invoice folder ("" = none). */
export type CustomerFiling = { kind: InvoiceFileKind; number: number; folder: string; ticket: number };

/** The fs calls the share takes, and no others. node:fs/promises fits it. */
export type ShareFs = {
  access(path: string): Promise<void>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
  writeFile(path: string, data: Buffer, options: { flag: "wx" }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
};

export type OfficeShareDeps = {
  fs: ShareFs;
  isPractice: () => Promise<boolean>;
  waitMs: number;
  /** Read at each call: the deploy values, never a screen setting. */
  env: () => { OFFICE_SHARE_DIR?: string; OFFICE_SHARE_ROOT?: string };
  log: (line: string) => void;
  /** 8 lowercase hex characters for a temp file's name. */
  suffix: () => string;
  /** Milliseconds on a monotonic clock, for the deadlines; `performance.now()` when not given. */
  now?: () => number;
};

export type FolderCheck = { ok: true; value: string } | { ok: false; message: string };

/** How a chain, or the slot, ended: the sentence for the page (null: nothing to say) and the cause
 *  its log line names (null: no log line). */
type Ended = { sentence: string | null; cause: string | null };

const DONE: Ended = { sentence: null, cause: null };

/** Thrown inside a chain to end it with a sentence and a cause. */
class Stop {
  constructor(readonly sentence: string, readonly cause: string) {}
}

/** One fs call behind the deadline check; a failure becomes the Stop `failed` makes of it. */
type Step = <T>(call: () => Promise<T>, failed: (error: unknown) => Stop) => Promise<T>;

/** The errno code a failure carries, or null. Never throws, whatever was thrown. */
function codeOf(error: unknown): string | null {
  try {
    const code = (error as { code?: unknown } | null | undefined)?.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

/** The errno code, or else the message, for a log line. Never throws: a value that refuses to be
 *  read (String() cannot convert an object with no prototype, and a Proxy can refuse anything) is
 *  named as such. */
function causeOf(error: unknown): string {
  const code = codeOf(error);
  if (code !== null) return code;
  try {
    return error instanceof Error ? String(error.message) : String(error);
  } catch {
    return "a thrown value that cannot be read";
  }
}

const isMissing = (error: unknown) => {
  const code = codeOf(error);
  return code === "ENOENT" || code === "ENOTDIR";
};

/** How a chain ends on what its catch caught: a Stop as it is, anything else `sentence` with its
 *  cause. Never throws: `instanceof` asks the value for its prototype, which a Proxy can refuse. */
function endedOf(error: unknown, sentence: string): Ended {
  let stop = false;
  try {
    stop = error instanceof Stop;
  } catch {
    // Not a Stop, which is this module's own class.
  }
  return stop ? (error as Stop) : { sentence, cause: causeOf(error) };
}

/** Writes one log line, or nothing when building or writing it throws: a lost line fails no caller. */
function logQuietly(log: (line: string) => void, line: () => string): void {
  try {
    log(line());
  } catch {
    // The caller is answered all the same.
  }
}

/** How the save and the print each say what finding the folder met. */
type FolderWords = { notConnected: string; notFound: string; otherError: string };
const SAVE_FOLDER_WORDS: FolderWords = {
  notConnected: SAVE_NOT_CONNECTED, notFound: FOLDER_NOT_FOUND, otherError: SAVE_NOT_CONNECTED,
};
const PRINT_FOLDER_WORDS: FolderWords = {
  notConnected: PRINT_NOT_CONNECTED, notFound: PRINT_FOLDER_NOT_FOUND, otherError: PRINT_REFUSED,
};

type Opened = { kind: "off" } | { kind: "on"; share: OfficeShare } | { kind: "misconfigured"; cause: string };

/** The share's settings read once: off, on, or misconfigured, which is acted on only after the
 *  practice question is asked. */
function openShare(env: { OFFICE_SHARE_DIR?: string; OFFICE_SHARE_ROOT?: string }): Opened {
  try {
    const share = resolveOfficeShare(env);
    return share === null ? { kind: "off" } : { kind: "on", share };
  } catch (error) {
    return { kind: "misconfigured", cause: causeOf(error) };
  }
}

type SlotState = "waiting" | "running" | "given up" | "done";
type SlotRequest = { deadline: number; state: SlotState; run: () => Promise<void>; giveUp: (why: "busy" | "timed out") => void };

/** The slot. Exported for its own tests: its two belts answer a chain that rejects, and only a
 *  test can hand it one, since makeOfficeShare's chains never reject. */
export function makeSlot(waitMs: number, now: () => number) {
  let holder: SlotRequest | null = null;
  const queue: SlotRequest[] = [];

  function release(): void {
    holder = null;
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      // A request the flush gave up was answered busy and is never run.
      if (next.state === "waiting") {
        start(next);
        return;
      }
    }
  }

  function start(request: SlotRequest): void {
    request.state = "running";
    holder = request;
    const timer = setTimeout(() => {
      if (request.state !== "running") return;
      request.giveUp("timed out");
      // A belt, the queue it holds only: a chain that rejected released the slot with this timer
      // still set, and the next holder's waiters are not this request's to flush.
      if (holder !== request) return;
      for (const waiter of queue) {
        if (waiter.state === "waiting") waiter.giveUp("busy");
      }
    }, Math.max(0, request.deadline - now()));
    timer.unref();
    // The rejection arm is a belt: a chain that rejected frees the slot at once, and its caller is
    // answered by the timer above.
    request.run().then(() => clearTimeout(timer)).then(release, release);
  }

  /** Runs `chain` when the slot is free; `words` say busy and timed out on the caller's page. */
  return function take(chain: (step: Step) => Promise<Ended>, words: { busy: string; timedOut: string }): Promise<Ended> {
    return new Promise<Ended>((answer) => {
      const deadline = now() + waitMs;
      const step: Step = async (call, failed) => {
        if (now() >= deadline) throw new Stop(words.timedOut, "the deadline passed before its next call");
        try {
          return await call();
        } catch (error) {
          throw failed(error);
        }
      };
      const request: SlotRequest = {
        deadline,
        state: "waiting",
        run: () => chain(step).then((ended) => {
          if (request.state !== "running") return;
          request.state = "done";
          answer(ended);
        }),
        giveUp: (why) => {
          request.state = "given up";
          answer(why === "busy"
            ? { sentence: words.busy, cause: "the share is busy with an earlier call that has not finished" }
            : { sentence: words.timedOut, cause: `the share did not answer within ${waitMs} ms` });
        },
      };
      if (holder === null) start(request);
      // Stuck: its deadline has passed, by the timer or by the clock alone.
      else if (holder.state === "given up" || now() >= holder.deadline) request.giveUp("busy");
      else queue.push(request);
    });
  };
}

export function makeOfficeShare(deps: OfficeShareDeps) {
  const { fs, isPractice, waitMs, env, log, suffix } = deps;
  const take = makeSlot(waitMs, deps.now ?? (() => performance.now()));
  // The newest ticket filed per `${kind}:${number}`: not per path, as the share compares names
  // without regard to case and the customer's folder can change between prints.
  const newestFiled = new Map<string, number>();

  /** The customer's folder as a real path inside the share's real path, or a Stop. */
  async function findFolder(share: OfficeShare, segments: string[], step: Step, words: FolderWords): Promise<string> {
    const marker = markerPath(share.dir);
    await step(() => fs.access(marker), (error) => new Stop(words.notConnected, `the marker file: ${causeOf(error)}`));
    const realDir = await step(() => fs.realpath(share.dir), (error) => new Stop(words.notConnected, `the share: ${causeOf(error)}`));
    const folder = folderPath(share.dir, segments);
    const folderFailed = (error: unknown) =>
      new Stop(isMissing(error) ? words.notFound : words.otherError, `the folder: ${causeOf(error)}`);
    const realFolder = await step(() => fs.realpath(folder), folderFailed);
    try {
      assertInside(realDir, realFolder);
    } catch {
      throw new Stop(words.notFound, "the folder resolves outside the share");
    }
    const found = await step(() => fs.stat(realFolder), folderFailed);
    if (!found.isDirectory()) throw new Stop(words.notFound, "the folder is not a directory");
    return realFolder;
  }

  async function checkChain(share: OfficeShare, segments: string[], step: Step): Promise<Ended> {
    try {
      await findFolder(share, segments, step, SAVE_FOLDER_WORDS);
      return DONE;
    } catch (error) {
      return endedOf(error, SAVE_NOT_CONNECTED);
    }
  }

  async function copyChain(share: OfficeShare, segments: string[], filing: CustomerFiling, pdf: Buffer, step: Step): Promise<Ended> {
    // Set as the write is sent: from there a failure removes it, unless "wx" refused the write.
    let temp: string | null = null;
    try {
      const realFolder = await findFolder(share, segments, step, PRINT_FOLDER_WORDS);
      const key = `${filing.kind}:${filing.number}`;
      const newest = newestFiled.get(key);
      if (newest !== undefined && filing.ticket < newest) {
        return { sentence: null, cause: "a newer print of it was already filed" };
      }
      const final = filedPath(realFolder, invoiceFileName(filing.kind, filing.number));
      const tempPath = tempPathFor(final, suffix());
      await step(() => {
        temp = tempPath;
        return fs.writeFile(tempPath, pdf, { flag: "wx" });
      }, (error) => {
        // "wx" refused: something was already at the temp path, so this chain made nothing there.
        if (codeOf(error) === "EEXIST") temp = null;
        return new Stop(PRINT_REFUSED, `the write: ${causeOf(error)}`);
      });
      await step(() => fs.rename(tempPath, final), (error) => new Stop(PRINT_REFUSED, `the rename: ${causeOf(error)}`));
      newestFiled.set(key, filing.ticket);
      return DONE;
    } catch (error) {
      if (temp !== null) {
        try {
          await fs.unlink(temp);
        } catch {
          // Best effort: on a dead share the dotfile stays (the plan's residuals).
        }
      }
      return endedOf(error, PRINT_REFUSED);
    }
  }

  async function checkCustomerFolder(pasted: string): Promise<FolderCheck> {
    try {
      const value = normalizeInvoiceFolder(pasted);
      if (value === "") return { ok: true, value: "" };
      const refuse = (message: string, cause: string | null): FolderCheck => {
        // Quoted: a line break in a paste must not split the log line.
        if (cause !== null) log(`[customer-folders] folder check for ${JSON.stringify(value)}: ${cause}`);
        return { ok: false, message };
      };
      const opened = openShare(env());
      if (opened.kind === "off") return refuse(SHARE_NOT_SET_UP, null);
      let practice: boolean;
      try {
        practice = await isPractice();
      } catch (error) {
        return refuse(SAVE_NOT_CONNECTED, `the practice check failed: ${causeOf(error)}`);
      }
      if (practice) return refuse(SHARE_NOT_SET_UP, null);
      if (opened.kind === "misconfigured") return refuse(SHARE_NOT_SET_UP, `the share is misconfigured: ${opened.cause}`);
      const parsed = officeFolderSegments(value, opened.share.root);
      if (!parsed.ok) {
        switch (parsed.reason) {
          case "outside":
            return refuse(notInsideShare(rootDisplay(opened.share.root)), null);
          case "share-itself":
            return refuse(SHARE_ITSELF, null);
          case "bad-name":
            return refuse(BAD_PATH_NAME, null);
        }
      }
      const ended = await take(
        (step) => checkChain(opened.share, parsed.segments, step),
        { busy: SAVE_BUSY, timedOut: SAVE_TIMED_OUT },
      );
      return ended.sentence === null ? { ok: true, value } : refuse(ended.sentence, ended.cause);
    } catch (error) {
      // The belt: nothing above is meant to throw.
      logQuietly(log, () => `[customer-folders] folder check for ${JSON.stringify(pasted)}: ${causeOf(error)}`);
      return { ok: false, message: SAVE_NOT_CONNECTED };
    }
  }

  async function fileCustomerCopy(filing: CustomerFiling | null, pdf: Buffer): Promise<{ warning: string | null }> {
    // The belt's log line names the file once it is known.
    let fileName = "a finalized print";
    try {
      if (filing === null) return { warning: null };
      fileName = invoiceFileName(filing.kind, filing.number);
      const warn = (warning: string | null, cause: string | null) => {
        if (cause !== null) log(`[customer-folders] ${fileName} not filed: ${cause}`);
        return { warning };
      };
      const opened = openShare(env());
      if (opened.kind === "off") return warn(null, null);
      let practice: boolean;
      try {
        practice = await isPractice();
      } catch (error) {
        return warn(PRINT_REFUSED, `the practice check failed: ${causeOf(error)}`);
      }
      if (practice) return warn(null, null);
      if (opened.kind === "misconfigured") return warn(PRINT_NOT_CONNECTED, `the share is misconfigured: ${opened.cause}`);
      const folder = normalizeInvoiceFolder(filing.folder);
      if (folder === "") return warn(PRINT_NO_FOLDER, null);
      // The root may have changed since the folder was saved.
      const parsed = officeFolderSegments(folder, opened.share.root);
      if (!parsed.ok) return warn(PRINT_FOLDER_NOT_FOUND, `the saved folder no longer parses: ${parsed.reason}`);
      const ended = await take(
        (step) => copyChain(opened.share, parsed.segments, filing, pdf, step),
        { busy: PRINT_SKIPPED, timedOut: PRINT_TIMED_OUT },
      );
      return warn(ended.sentence, ended.cause);
    } catch (error) {
      // The belt: nothing above is meant to throw, and the print has already committed.
      logQuietly(log, () => `[customer-folders] ${fileName} not filed: ${causeOf(error)}`);
      return { warning: PRINT_REFUSED };
    }
  }

  return { checkCustomerFolder, fileCustomerCopy };
}

// The module's own share, one for the process. The customer save and the invoice print are two
// routes, and a bundler may evaluate this module once for each, yet they must share one slot (at
// most one call tied up on the share, Amendment 3) and one print order. So the first evaluation
// keeps its share and the ticket counter on globalThis, under a registered symbol, and every later
// evaluation takes them from there: in `next dev`, an edit to this file reaches the running
// server's share only at its next start.
type ModuleShare = { office: ReturnType<typeof makeOfficeShare>; lastTicket: number };
const registry = globalThis as unknown as Record<symbol, ModuleShare | undefined>;
const moduleShare = (registry[Symbol.for("heatsynq.officeShare")] ??= {
  office: makeOfficeShare({
    fs: { access, realpath, stat, writeFile, rename, unlink },
    isPractice: practiceMode,
    waitMs: COPY_WAIT_MS,
    env: () => ({ OFFICE_SHARE_DIR: process.env.OFFICE_SHARE_DIR, OFFICE_SHARE_ROOT: process.env.OFFICE_SHARE_ROOT }),
    log: (line) => console.error(line),
    suffix: () => randomBytes(4).toString("hex"),
  }),
  lastTicket: 0,
});

/** A print's place in print order, from one counter for the process. The invoice print is to take
 *  it while it holds its claim on the order row (the plan's T4 and "Print order"), so prints of one
 *  invoice or credit take theirs in commit order. */
export function nextFilingTicket(): number {
  moduleShare.lastTicket += 1;
  return moduleShare.lastTicket;
}

/** Checks a pasted Invoice folder before it is saved; never rejects. */
export const checkCustomerFolder = moduleShare.office.checkCustomerFolder;

/** Files a finalized print's copy in the customer's folder, to be called after the print commits;
 *  never rejects. `{ warning }` is the line by Print, or null. */
export const fileCustomerCopy = moduleShare.office.fileCustomerCopy;
