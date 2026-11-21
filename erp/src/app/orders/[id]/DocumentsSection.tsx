"use client";
import { formatDateTime, formatNumber } from "@/lib/format";
import { takeOrderPrintIntent, type OrderPrintIntent } from "@/lib/order-print-intent";
import { INITIAL_AUTOMATIC_PRINT, stepAutomaticPrint, type AutomaticPrintState } from "@/lib/automatic-print";
import { travelerCoverageLabel } from "@/lib/traveler-selection";
import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ApiError, api, trackedFetch } from "@/lib/fetcher";
import { openPendingTab } from "@/lib/print-tab";
import type { Gate } from "@/lib/permission-ui";
import { SAVE_A_LOAD_FIRST, waitingTitle } from "@/lib/waiting-titles";
import { useLatest } from "@/lib/use-latest";
import type { OrderLoad } from "./page";
import { useUnsavedPresent } from "@/lib/use-unsaved-section";
import { useDraftIdentity } from "@/lib/use-recoverable-draft";
import { unsavedPresentExcluding } from "@/lib/unsaved-guard";
import type { NoticeOrder } from "@/lib/traveler-notice";
import { TravelerNoticeView } from "./TravelerNoticeView";
import { listStatus } from "@/lib/list-status";
import { ListStatus } from "@/components/PageStatus";
import { CARD, INPUT_COMPACT, LINK, NOTICE } from "@/lib/ui-classes";

/**
 * Order-hub sections whose edits CANNOT change a traveler, so an unsaved one must not block the
 * print. `readTravelerData` (src/server/traveler.ts) builds the sheet from the order's lines, its
 * containers, its loads and its PO — serials and charges appear nowhere in that payload, and the
 * page-wide predicate was disabling both print actions over them (Codex P2 on !272). The PO box is
 * an Overview blur-save that registers no section, so this list and the print gate never see it;
 * the owner's answer on a print that races that save (#518) is recorded at the print gate below.
 *
 * Module-level so the hook's snapshot closure has a stable operand, and a DENY list so a section
 * that is renamed or newly added still blocks until someone decides otherwise — see
 * `unsavedPresentExcluding`.
 */
const NOT_PRINTED_ON_A_TRAVELER = ["Serials", "Charges"] as const;

/** Mirrors `DocumentMeta` (src/server/documents.ts, Phase 4 Task 3) — a local type, not an
 *  import, for the usual reason (CLAUDE.md): a client component pulling from src/server/** drags
 *  Prisma and node:async_hooks into the browser bundle. `createdAt` arrives as a JSON date
 *  string. No `orderNumber`: `documents.ts` never joins to learn one, so this route only ever
 *  returns the raw `orderId` — unused below, kept for parity with the server shape. */
type StoredDocument = {
  id: string; orderId: string | null; kind: string;
  loadNumber: number | null; createdAt: string; travelerLoadNumbers?: number[];
  /** What a traveler print printed, as JSON text (src/lib/traveler-print-record.ts). Null on a
   *  print made before prints kept one and on every other kind of document. Only the order's own
   *  document list carries it, and only the traveler notice reads it. */
  travelerPrintRecord?: string | null;
};

// Every DocumentKind, so a non-traveler kind renders a friendly label instead of its raw enum
// name (the cosmetic gap HANDOFF §6 recorded; P5A spec §10 completes it). Kept as Record<string>
// with a `?? d.kind` fallback at the call site so a future kind is a plain enum name, never a crash.
const KIND_LABELS: Record<string, string> = {
  TRAVELER: "Traveler",
  SHIPPER: "Shipping ticket",
  BOL: "Bill of lading",
  CERT: "Certification",
  INVOICE: "Invoice",
  CREDIT: "Credit",
};

/**
 * Traveler printing and the archive of every print (design spec §10/§11).
 *
 * Printing is a POST that streams the freshly-rendered PDF back, so it cannot go through
 * `api()` (which always parses JSON). Raw `fetch` here, with the error body read the same way
 * `api()` reads it, so a refusal — a voided order's 400, a permission 403 — still surfaces as
 * its real server message rather than "something went wrong".
 *
 * Opening the result (#692). A print button's click opens a blank tab before the request is
 * sent, still inside the click (`openPendingTab`, the invoice page's #588 form): browsers block a
 * tab a page opens long after the click, and a 100-load print has a 15-second budget (#305). When
 * the print lands, the tab shows the stored copy (`/api/documents/<x-document-id>`) and the body is
 * cancelled unread; a refused or failed print closes the tab. A tab the browser blocked, or an
 * answer naming no document, leaves the blocked line with its link to the stored copy, set only
 * after the answer, so no "could not be opened" line shows while the print is out.
 *
 * An automatic print (the print intent after a save, the legacy `?print=1`) has no click, so it
 * opens no blank tab: the bytes are turned into an object URL and opened after the answer. A
 * browser may block that, which `window.open` returning null detects, and the blocked line
 * reports it with the link. It is never silently swallowed; the print HAPPENED and is archived
 * either way. The blocked line is set before the body is read, so it keeps the link if reading
 * the body throws. The window is opened without the "noopener" feature (with it `window.open`
 * always answers null, which read every print as blocked: fix round 1) and its opener is cut on
 * the handle instead, and the object URL is revoked on a delay, opened or blocked (fix-wave
 * finding 6): the blocked line's link reads the stored bytes, never this blob.
 */
export function TravelerProvider({
  orderId, loads, voided, viewGate, autoPrint, printIntentKey = null, permissionsReady = true, onPrinted, children,
}: {
  children: ReactNode;
  orderId: string;
  loads: OrderLoad[];
  voided: boolean;
  viewGate: Gate;
  /** Legacy `?print=1` callers — prints once, then never again
   *  for this page instance. */
  autoPrint: boolean;
  /** Present (including empty) always takes precedence over legacy automatic printing. */
  printIntentKey?: string | null;
  /** Wait only for unresolved permission reads; terminal denial/error must use manual review. */
  permissionsReady?: boolean;
  /** Called after a print successfully archives (Codex MR !141 round 3) — the parent's
   *  `travelerPrinted` state is stale the moment a first print lands, and without this the #41
   *  loads-editor warning waits for a reload or an unrelated mutation to appear. Optional: the
   *  section is self-contained everywhere a parent doesn't carry that state. */
  onPrinted?: () => void;
}) {
  const [docs, setDocs] = useState<StoredDocument[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  // Which order's archive a read has landed for (P6 step 3, #632 bug a; the Statements `loadedFor`
  // form): the list says "Loading…" until then, never "Nothing printed yet." A print's refresh reads
  // again under the same order, so it never blanks the list; a failed read leaves it as it was.
  const [docsLoadedFor, setDocsLoadedFor] = useState<string | null>(null);
  /** Retain archive retrieval until its returned PDF window opens successfully. */
  const [blocked, setBlocked] = useState<{ id: string; label: string } | null>(null);
  const [printing, setPrinting] = useState(false);
  // Shared by every entry point; a ref closes the same-event double-click window.
  const printInFlight = useRef(false);

  // §5.13 stale-gate, the InvoicesSection shape, both paths (F7): the mount fetch races print's
  // post-archive refresh (auto-print makes both routinely in flight), and a superseded response —
  // success or rejection — must touch nothing.
  const latest = useLatest();
  const load = useCallback(async () => {
    const t = latest.next();
    let data: StoredDocument[];
    try {
      data = await api<StoredDocument[]>(`/api/orders/${orderId}/documents`);
    } catch (e) {
      if (latest.isCurrent(t)) setArchiveError((e as Error).message);
      return;
    }
    if (!latest.isCurrent(t)) return;
    setDocs(data);
    setArchiveError(null);
    setDocsLoadedFor(orderId);
  }, [orderId, latest]);
  // Read when this mounts, and again behind each order the page takes from the server. `loads` is
  // the page's `order.loads`. The page puts each server answer it accepts (a save's, a same-order
  // scan's, the Loads section's Refresh, the read that follows the hub writes a read overlapped)
  // in place of its order, keeping at most the one text field being typed in, and a
  // `travelerPrinted` the page already holds true (`keepTravelerPrinted`, #550), so the array is a
  // new one with each such answer. A key typed into the header, an optimistic patch and `onPrinted`
  // spread the order and leave its arrays, so none of those reads the list. Nothing of the array is
  // read here: a new one is the sign that the order beside this list is newer. Without it the
  // traveler notice went wrong across sessions. A print made elsewhere reaches this list only by a
  // read of it, while lines and loads saved elsewhere reach the page's order with any answer. So the
  // notice set the newer order against the older list, until a reload or a print from this page. The
  // cost is one more GET of the list after each accepted answer. A print hands the page no new
  // order, so it still reads the list once, in `print`'s `finally`. Where two reads are in flight,
  // the gate above lands the one issued last and drops the other.
  useEffect(() => { void load(); }, [load, loads]);

  // Printing is disabled on a voided order (spec §5c: new prints refused, stored prints stay
  // readable), and on a caller without orders.view — disabled with a tooltip, never hidden (§5.16).
  // The order hub's grids are registered editors, and `readTravelerData` reads the SERVER's lines,
  // containers and loads — so a traveler printed over an unsaved one of THOSE archives quantities
  // the screen does not show (Codex P1, round 7). Serials and charges are not on the paper, so
  // they are excluded rather than left to block a print they cannot affect (Codex P2, round 8).
  // It reads the order's PO too (#518), but the PO box is an Overview blur-save that registers no
  // section, and nothing here waits for the page's in-flight Overview saves: a print clicked while
  // a PO save is still out can archive the old PO. The owner accepted that and had it recorded
  // (2026-10-17, on #518); the manual says to let the PO save before printing.
  // The Lines section registers too, under "Lines", while a Qty or Weight box holds a value marked
  // Not saved (owner ruling 2026-10-07), or while a line whose Remove got no answer is marked
  // Removal not confirmed (#475, owner ruling 2026-10-15): the screen may show a figure or a line
  // the paper would not carry. Neither has a Save control, so the title below also names their ways
  // out, Restore and Remove again. It is one sentence for every registered cause (Containers, Loads
  // and Lines alike): a title per cause would need a removal scope registered and asked about.
  const pathname = usePathname();
  const unsavedGrids = useUnsavedPresent(NOT_PRINTED_ON_A_TRAVELER);
  const { store: draftStore, ...draftIdentity } = useDraftIdentity();
  // The browser-store hook binds in a passive effect. Its first null snapshot is unknown,
  // not clean; hidden retained drafts likewise cannot authorize printing during identity checks.
  const draftsReady = draftStore !== null && draftIdentity.identityReady;
  const printGate: Gate = voided
    ? { allowed: false, disabled: true, title: "Order is voided — stored prints stay available" }
    : !viewGate.allowed ? viewGate
    : !draftsReady
      ? { allowed: false, disabled: true, title: "Checking retained drafts before printing" }
    : unsavedGrids
      ? {
          allowed: false, disabled: true,
          title: "Save the changes first, restore a value marked Not saved, or press Remove again on a line marked Removal not confirmed — a print archives what the server holds",
        }
      : viewGate;

  const print = useCallback(async (loadNumber?: number, intent?: OrderPrintIntent, openTab = false) => {
    if (!printGate.allowed || printInFlight.current) return;
    // Re-read at admission, not just render: retained/legacy edits or identity invalidation
    // may have changed after this callback was rendered. Never initialize a new store here.
    if (!draftStore?.getSnapshot().identityReady ||
        draftStore.labelsForPath(pathname, NOT_PRINTED_ON_A_TRAVELER).length > 0 ||
        unsavedPresentExcluding(NOT_PRINTED_ON_A_TRAVELER)) {
      setError("Review the saved order before printing. Resolve its retained or unsaved changes first.");
      return;
    }
    if (loadNumber !== undefined && !loads.some(load => load.loadNumber === loadNumber)) {
      setError("This load is no longer available. Refresh the order before printing.");
      return;
    }
    if (intent && (intent.orderId !== orderId || (intent.selection.mode === "loads" &&
        intent.selection.loadNumbers.some(number => !loads.some(load => load.loadNumber === number))))) {
      setError("Review the saved order before printing. The selected loads are no longer available.");
      return;
    }
    // A click's print opens its tab here, after the refusals above and before the first await, so
    // still inside the click (#692): the browser opens a tab for a page only shortly after a click,
    // and a long print (a 15-second budget, #305) would land past it. An automatic print has no
    // click and opens nothing; it keeps the blob and the blocked line's link below.
    const tab = openTab ? openPendingTab(window) : null;
    let shown = false;
    printInFlight.current = true;
    setPrinting(true);
    setBlocked(null);
    setError(null);
    let archived = false;
    const label = intent?.selection.mode === "loads" ? `travelers for loads ${intent.selection.loadNumbers.join(", ")}`
      : loadNumber === undefined ? "the traveler" : `the load ${loadNumber} traveler`;
    try {
      const query = loadNumber === undefined ? "" : `?load=${loadNumber}`;
      const res = await trackedFetch(`/api/orders/${orderId}/traveler${query}`, intent ? {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selection: intent.selection, expectedPrintFingerprint: intent.expectedPrintFingerprint }),
      } : { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError((body as { error?: string }).error ?? `Print failed (${res.status})`, res.status);
      }
      // A successful response establishes archive success even if reading/opening its body fails.
      archived = true;
      onPrinted?.();
      const documentId = res.headers.get("x-document-id") ?? "";
      if (tab) {
        // The tab shows the stored copy, so the body is not read (the invoice page's #588 form).
        // A body that failed in transit rejects its cancel; nothing waits on it.
        void res.body?.cancel().catch(() => {});
        if (documentId) { tab.show(`/api/documents/${documentId}`); shown = true; } else tab.close();
        if (tab.blocked || !documentId) setBlocked({ id: documentId, label });
        setError(null);
        return;
      }
      setBlocked({ id: documentId, label: "the saved traveler" });
      const url = URL.createObjectURL(await res.blob());
      // Bound the blob lifetime even if opening the window throws; recovery uses archived bytes.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      const opened = window.open(url, "_blank");
      if (opened) { opened.opener = null; setBlocked(null); }
      if (opened === null) setBlocked({ id: documentId, label });
      setError(null);
    } catch (e) {
      if (!shown) tab?.close(); // a refused or failed print leaves no blank tab behind
      setError(e instanceof ApiError && e.status === 412
        ? "Review the saved order before printing. Its loads or order details changed after save."
        : archived ? "The traveler was saved, but its PDF could not be opened. Retrieve the saved document below."
        : e instanceof ApiError && e.status < 500 ? e.message
        : `${(e as Error).message} Review the document archive before printing again; the request may already have archived a traveler.`);
    } finally {
      if (archived) await load();
      printInFlight.current = false;
      setPrinting(false);
    }
  }, [orderId, load, onPrinted, loads, printGate.allowed, draftStore, pathname]);
  /** The print buttons' entry point: a click, so it opens its tab in the click (#692). */
  const printFromClick = useCallback((loadNumber?: number) => print(loadNumber, undefined, true), [print]);

  // One effect and the same controller own both handoff and legacy automatic printing.
  const router = useRouter();
  const automatic = useRef<AutomaticPrintState>(INITIAL_AUTOMATIC_PRINT);
  useEffect(() => {
    // Nothing is consumed until permission and draft readiness are both known, but the drafts are
    // judged at THEIR first readiness (#340, see automatic-print.ts): a slow permission read must
    // not let Restore + Discard turn a draft-refused request into a print. Once decided, blocked
    // requests are consumed too (legacy included), never deferred until the drafts are cleared.
    const step = stepAutomaticPrint(automatic.current, {
      requested: printIntentKey !== null || autoPrint, permissionsReady, draftsReady,
      draftsBlock: draftsReady && (draftStore.labelsForPath(pathname, NOT_PRINTED_ON_A_TRAVELER).length > 0 ||
        unsavedPresentExcluding(NOT_PRINTED_ON_A_TRAVELER)),
    });
    automatic.current = step.state;
    if (step.decision !== "run" && step.decision !== "refuse") return;
    const refused = step.decision === "refuse" || !printGate.allowed || printInFlight.current;
    const params = new URLSearchParams(window.location.search);
    params.delete("printIntent");
    params.delete("print");
    router.replace(`${pathname}${params.size ? `?${params}` : ""}${window.location.hash}`);
    if (printIntentKey !== null) {
      let intent: OrderPrintIntent | null = null;
      try { intent = takeOrderPrintIntent(window.sessionStorage, printIntentKey, orderId); }
      catch { /* Accessing sessionStorage itself can throw. */ }
      if (!intent || refused) {
        setError("Review the saved order before printing. Automatic printing was not started; choose a manual traveler action after reviewing the loads.");
        return;
      }
      void print(undefined, intent);
    } else if (refused) {
      setError("Review the saved order before printing. Automatic printing was not started; choose a manual traveler action after reviewing the loads.");
    } else void print();
  }, [autoPrint, printIntentKey, permissionsReady, draftsReady, draftStore, orderId, printGate.allowed, print, router, pathname]);

  return (
    <TravelerContext.Provider value={{ docs, docsLoaded: docsLoadedFor === orderId, error, archiveError, blocked, printing, printGate, print: printFromClick, loads, refreshArchive: load }}>
      {children}
    </TravelerContext.Provider>
  );
}

type TravelerController = {
  docs: StoredDocument[];
  error: string | null;
  archiveError: string | null;
  /** A read of this order's archive has landed (P6 step 3): until then the list is not empty. */
  docsLoaded: boolean;
  refreshArchive: () => Promise<void>;
  blocked: { id: string; label: string } | null;
  printing: boolean;
  printGate: Gate;
  print: (loadNumber?: number) => Promise<void>;
  loads: OrderLoad[];
};
const TravelerContext = createContext<TravelerController | null>(null);

function useTraveler(): TravelerController {
  const value = useContext(TravelerContext);
  if (!value) throw new Error("Traveler actions require the order's TravelerProvider");
  return value;
}

/** All print entry points share one guard, in-flight state and archive refresh. */
export function TravelerPrintButton({ loadNumber, disabledReason }: {
  loadNumber?: number | null;
  disabledReason?: string;
}) {
  const { print, printGate, printing, loads } = useTraveler();
  const missingLoad = loadNumber !== undefined && !loads.some(load => load.loadNumber === loadNumber);
  const label = loadNumber === undefined
    ? loads.length > 0 ? `Print ${loads.length} traveler${loads.length === 1 ? "" : "s"}` : "Print traveler"
    : loadNumber === null ? "Print selected load traveler" : `Print Load ${loadNumber} traveler`;
  return <button type="button" onClick={() => {
    if (!disabledReason && !missingLoad) void print(loadNumber ?? undefined);
  }}
    disabled={printGate.disabled || printing || missingLoad || !!disabledReason}
    title={printGate.title ?? disabledReason ?? (missingLoad ? "Select a saved load first" : undefined)}
    className={`rounded px-3 py-2 text-sm ${loadNumber === undefined
      ? "bg-ink-900 text-white" : "border border-ink-500 bg-surface-0 text-ink-800"}`}>
    {printing ? "Printing…" : label}
  </button>;
}

/** Kept in the At-a-glance card so a load-row print cannot fail out of sight. */
export function TravelerFeedback() {
  const { error, archiveError, blocked, printGate, refreshArchive } = useTraveler();
  return <div aria-live="polite">
      {error && <p className={`${NOTICE.refusal} mb-3`}>{error}</p>}
      {archiveError && <p className="mb-3 text-sm text-red-700">Could not refresh the document archive: {archiveError}</p>}
      {(error || archiveError) && <p className="mb-3 text-sm">
        <a href="#documents" className={LINK}>Review saved documents</a>{" · "}
        <button type="button" onClick={() => void refreshArchive()} className={LINK}>Refresh document archive</button>
      </p>}
      {blocked && (
        <p className={`${NOTICE.warning} mb-3`}>
          The traveler is saved, but its window could not be opened (it may have been blocked).{" "}
          {blocked.id === "" ? "Open it from the list below." : (
            <a href={`/api/documents/${blocked.id}`} target="_blank" rel="noreferrer"
               className={LINK}>Open {blocked.label}</a>
          )}
        </p>
      )}

      {printGate.disabled && <p className="mt-2 text-sm text-ink-500">{printGate.title}</p>}
    </div>;
}

/**
 * The standing notice that a printed traveler is out of date (design 2026-10-06, §6 and §10.3),
 * mounted in the sticky summary beside the all-loads print button.
 *
 * It lives in this file because the controller's document list is private to it. It reads that
 * list and the page's order, and sends no request and holds no state: the rule and the sentence
 * are `src/lib/traveler-notice.ts`'s, the markup `TravelerNoticeView`'s.
 *
 * `docs` is handed on as it stands, newest first as the route answers it. It is empty until the
 * first read lands, so the notice says nothing before then. A failed read leaves it unchanged, so
 * the notice keeps its last answer, and `TravelerFeedback` shows the failed read. After a save the
 * notice follows the new order at once. After a print it clears when the controller's own refresh
 * of the list lands. The controller also reads the list again behind each order the page takes
 * from the server, so a print made in another session is known here from the page's next save,
 * scan or Refresh, and for the length of that one read the notice is worked out from the new
 * order and the list as it was. What this page has not read it does not know: a change or a print
 * made elsewhere since its last answer.
 *
 * The view is memoized on what the rule reads: the order's lines, loads, status and void, and the
 * document list. This function runs at every render of the page, a key typed into the PO number
 * included, because the controller's value is a new object each time. The view compares every
 * load with its print and parses each deciding print's record. So it is handed the same element
 * until one of those five is a new value, and React does not render again a child whose element
 * is the one it was handed last time. The page keeps the arrays the server sent until the next
 * answer replaces them: a header edit spreads the order into a new object and leaves its lines
 * and loads as they are.
 */
export function TravelerNotice({ order }: { order: NoticeOrder }) {
  const { docs } = useTraveler();
  const { lines, loads, status, voided } = order;
  return useMemo(
    () => <TravelerNoticeView order={{ lines, loads, status, voided }} prints={docs} />,
    [lines, loads, status, voided, docs]);
}

export function DocumentsSection() {
  const { docs, docsLoaded, archiveError, loads, printGate } = useTraveler();
  const [loadChoice, setLoadChoice] = useState("");
  // Before a read lands the list is "Loading…", or nothing under a failed first read, whose message
  // `TravelerFeedback` shows; after one lands, a later failure leaves the list it read in place.
  const status = listStatus({ allowed: true, error: docsLoaded ? null : archiveError, loadedFor: docsLoaded ? "order" : null, key: "order", count: docs.length });
  return (
    <section id="documents" data-order-section tabIndex={-1} className={`${CARD} mb-6`}>
      <h2 className="mb-2 font-medium">Documents</h2>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <TravelerPrintButton />

        <span className="ml-4 text-sm text-ink-500">|</span>
        <select value={loadChoice} onChange={(e) => setLoadChoice(e.target.value)}
                disabled={printGate.disabled || loads.length === 0}
                title={waitingTitle(printGate, loads.length === 0, SAVE_A_LOAD_FIRST)}
                aria-label="Load to print"
                className={`${INPUT_COMPACT} disabled:cursor-not-allowed disabled:bg-surface-50`}>
          <option value="">Single load…</option>
          {loads.map((l) => (
            <option key={l.id} value={l.loadNumber}>
              Load {l.loadNumber}{l.qty === null ? "" : ` · ${formatNumber(l.qty)} pcs`}
            </option>
          ))}
        </select>
        <TravelerPrintButton loadNumber={loadChoice === "" ? null : Number(loadChoice)} />
      </div>

      {status !== "rows" ? (
        <ListStatus status={status} empty="Nothing printed yet." />
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-ink-500">
              <th className="py-1 font-medium">Document</th>
              <th className="font-medium">Load</th>
              <th className="font-medium">Printed</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id} className="border-t">
                <td className="py-1">
                  {/* A plain link, not a fetch: GET /api/documents/[id] streams the STORED bytes
                      inline, so the browser renders the exact archived file (spec §8). */}
                  <a href={`/api/documents/${d.id}`} target="_blank" rel="noreferrer"
                     className={LINK}>
                    {KIND_LABELS[d.kind] ?? d.kind}
                  </a>
                </td>
                <td>{travelerCoverageLabel(d)}</td>
                <td className="text-ink-500">{formatDateTime(d.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
