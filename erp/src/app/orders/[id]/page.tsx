"use client";
// The order hub (design spec §11) — the one-page home of a work order. Reached from the board
// row click or the Shell's global search (never its own nav entry — Shell.tsx needs no change).
//
// THE BINDING STATE MODEL, same rule the order entry page's own top comment states (the 2C-3
// lesson): every mutating action here either (a) optimistically patches `order` for a plain
// scalar field and rolls back to server truth on failure — the customers/[id]/page.tsx `save()`
// precedent, used below for Overview's fields and Notes — or (b) never touches `order` before the
// request settles at all, applying the server's own fresh response on success and reporting
// failure otherwise (the customers/[id]/page.tsx `call()` precedent), used for void/link/unlink
// and delegated to every section below for its own add/remove/bulk-PUT actions, and to the Lines
// section for its per-field Qty and Weight saves. The bulk grids
// (Containers/Serials/Charges/Loads) additionally keep only EDITED cells/rows locally
// (src/lib/bulk-grid.ts) rather than a full mutable copy of the server array, for the same reason
// ProcessStepsSection's step editor does — see that file's own top comment. The Lines section
// keeps one entry per Qty or Weight box that holds something the server does not show: text being
// typed, a save in flight, or how the last save ended (src/lib/line-field-saves.ts). Under (b) a
// refused save rolls nothing back, so the refused value stays in its box, marked Not saved, until
// it is restored, saved, or shown by the order (after a save the server did not answer, until a
// later save of that box lands). While it stands the section is registered as unsaved work under
// the label "Lines"; no other blur-saved field on this page registers, because (a) rolls a
// refused value back. The refused value is never written into `order`. A line Remove that got no
// answer is never applied to `order` either: the line stays, marked Removal not confirmed and
// registered under "Lines" too, until a payload no longer lists it (src/lib/line-removals.ts). A
// Remove answered 404 "Order line not found" is the one Lines failure after which the page reads
// the order, through `readAfterRemoval` below. Every read of the order through `load` goes out at
// once, and when a hub write this mount sent was out as the read was sent, the page reads once more
// after those writes have settled (#550; a write from an earlier mount of the same order is not
// seen, see `writes`).
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, ApiError, UnreadableAnswerError } from "@/lib/fetcher";
import { getBrowserDraftSession } from "@/lib/draft-session";
import { createOrderBulkSource } from "@/lib/order-bulk-recovery";
import { orderInvoiceGates } from "@/lib/order-invoice-gates";
import { gate, gateDo, type Gate } from "@/lib/permission-ui";
import { ENTER_ORDER_NUMBER_FIRST, waitingTitle } from "@/lib/waiting-titles";
import { usePermissions } from "@/lib/use-permissions";
import { useEditGuard } from "@/lib/use-edit-guard";
import { useLatest, useMutationGate } from "@/lib/use-latest";
import { drainOtherKeys, makeWriteSignals, reReadAfter } from "@/lib/drain-queue";
import { keepTravelerPrinted } from "@/lib/traveler-printed";
import { ORDER_STATUS_LABELS, type OrderStatusValue } from "@/lib/order-constants";
import { CERT_SCOPES, CERT_SCOPE_LABELS, type CertScopeValue } from "@/lib/cert-constants";
import { LIGHT_DOT_CLASS, LIGHT_LABELS, type TrafficLight } from "@/lib/traffic-light";
import { HistoryPanel, invalidateHistory } from "@/components/HistoryPanel";
import { AttachmentsSection } from "@/components/AttachmentsSection";
import { LinesSection } from "./LinesSection";
import { ProcessSection } from "./ProcessSection";
import { ContainersSection } from "./ContainersSection";
import { SerialsSection } from "./SerialsSection";
import { ChargesSection } from "./ChargesSection";
import { LoadsSection } from "./LoadsSection";
import { OrderAtAGlance } from "./OrderAtAGlance";
import { PageHeader } from "@/components/PageHeader";
import { RecordTabs } from "@/components/RecordTabs";
import { ActionMenu } from "@/components/ActionMenu";
import { DangerButton } from "@/components/DangerButton";
import { HUB_TAB_LABEL, orderHubTabs, scanOpen } from "@/lib/order-hub-tabs";
import { DocumentsSection, TravelerProvider } from "./DocumentsSection";
import { CertificationsSection, invalidateOrderCerts } from "./CertificationsSection";
import { ShipmentsSection, invalidateOrderShipments } from "./ShipmentsSection";
import { InvoicesSection } from "./InvoicesSection";
import { PageStatus } from "@/components/PageStatus";
import { PanelMessage } from "@/components/PanelMessage";
import { askConfirm, askReason } from "@/lib/modal";
import { SavedMark } from "@/components/SavedMark";
import { useSavedMarks } from "@/lib/use-saved-marks";
import { BUTTON_PRIMARY_COMPACT, CARD, INPUT_COMPACT, LINK, NOTICE } from "@/lib/ui-classes";

// ---------------------------------------------------------------------------------------------
// Types. Local mirrors of src/server/orders.ts's exported row shapes — not imported from
// src/server/**, since a client component pulling from there drags node:async_hooks and Prisma
// into the browser bundle (CLAUDE.md "Constraints that will bite you"; the parts/[id]/page.tsx
// `Part` type precedent). Exported so the colocated section components import the ones they
// need — the orders/new/page.tsx precedent.
// ---------------------------------------------------------------------------------------------

export type OrderLine = {
  id: string; position: number; partId: string; revisionNumber: number | null;
  qty: number; weight: number;
  /** The stored quote link (Phase 6 Task 5's detail exposure — spec §5.2 Display). Judged at
   *  link time (ruling 6): what's shown is the STORED link, never a re-derivation, and a
   *  received-date edit re-fetches nothing here — only the re-pick control, when the user
   *  opens it, reads eligibility against the CURRENT received date. */
  quoteLineId: string | null; quoteId: string | null; quoteNumber: number | null;
  // serializationRequired (fix-wave R3 finding 6) rides on the line's own part payload so
  // SerialsSection's warning is governed by orders.view, not a separate parts.view fetch.
  // eachWeight (lb, up to four decimals) rides here for the same reason: quantity × each weight
  // can be calculated for a line under orders.view alone. It is the part's current value as of
  // this read of the order; an order line stores none of its own.
  part: {
    id: string; partNumber: string; name: string; customer: { code: string };
    serializationRequired: boolean; eachWeight: number;
  };
};
export type OrderContainer = {
  id: string; position: number; typeId: string; count: number; pieces: number | null;
  tareEach: number | null; scaleGross: number | null; customerContainerId: string; type: { name: string };
};
export type OrderSerial = { id: string; lineId: string; position: number; serial: string; description: string };
export type OrderLoad = { id: string; loadNumber: number; qty: number | null; weight: number | null };
export type OrderCharge = { id: string; position: number; description: string; amount: number | null };

export type OrderDetail = {
  id: string; orderNumber: number; customerId: string;
  /** #46: carried unconditionally under orders.view (the board precedent) — rendered as plain
   *  text without customers.view, as the customer link with it. */
  customer: { code: string; name: string };
  poNumber: string; vsOrderNumber: string; customerJobNo: string;
  /** The values RESOLVED AND FROZEN at save (spec §6.1) — shown and edited here as stored, never
   *  re-derived from the part/customer chain (that only runs inside createOrder). */
  certRequired: boolean; certScope: CertScopeValue;
  receivedDate: string; requestDate: string; targetDate: string | null;
  status: OrderStatusValue; notes: string; linkGroupId: string | null;
  voided: boolean;
  light: TrafficLight;
  travelerPrinted: boolean;
  /** What has already shipped against each line: the server's `orderLineShippedToDate`, sent on
   *  every read of the order and in every mutation response. Dense: one entry per line, and a line
   *  that never shipped reports 0 and 0. */
  orderLineShippedToDate: { orderLineId: string; shippedToDateQty: number; shippedToDateWeight: number }[];
  lines: OrderLine[];
  containers: OrderContainer[];
  serials: OrderSerial[];
  loads: OrderLoad[];
  charges: OrderCharge[];
  linkedOrders: { id: string; orderNumber: number }[];
};

/** What `GET /api/orders/[id]` answers: the order, and the id of its finalized invoice, or null
 *  (#472). The server reads the id from the Invoice row with the reader its own refusals use, so a
 *  draft invoice and a credit both read as null. It rides on that one route only. A mutation
 *  response is an `OrderMutationResult` and does not carry it, which is why this is a type of its
 *  own and not a field of `OrderDetail`. */
export type OrderRead = OrderDetail & { finalizedInvoiceId: string | null };

/** What every mutation this page runs through `applyMutation` answers: the fresh `OrderDetail`
 *  and nothing beside it. That is the header PATCH, the line add, change and remove, the three
 *  bulk replaces, the loads save, re-split, link and unlink. None answers a warning. The name is
 *  kept as an alias so the section files that import it do not change. */
export type OrderMutationResult = OrderDetail;

/** The one prop every section takes to run a whole-order mutation and report its result. A THUNK,
 *  not a resolved response: the page's ordering ticket (R4 finding 6) has to be taken before the
 *  request goes out. Awaiting it is optional — a caller that has follow-up work (clearing its own
 *  bulk-grid overlay, resetting an input) awaits so a rejection reaches its own catch instead. */
export type ApplyMutation = (run: () => Promise<OrderMutationResult>) => Promise<void>;

/** `GET /api/parts`'s `PartRow` (src/server/parts.ts), narrowed to what this page's rider picker
 *  needs. A line already on the order reads nothing from here: its part's `serializationRequired`
 *  and `eachWeight` ride on `OrderLine.part`, under orders.view. The `eachWeight` below is read
 *  for the part picked in the add-rider form, to give that form its default weight, and this
 *  catalog is fetched only with parts.view. `hasProcessSteps` is irrelevant for riders (spec §11
 *  — only the LEAD locks a revision) but carried anyway since the fetch already returns it and
 *  `computeLineWeight` (imported from the entry page's OrderLineCard by LinesSection) is typed
 *  against a structurally-identical `PartOption` that includes it. */
export type PartOption = {
  id: string; customerId: string; partNumber: string; name: string;
  eachWeight: number; serializationRequired: boolean; hasProcessSteps: boolean; active: boolean;
  /** Carried for structural compatibility with the entry page's own `PartOption` (Task 17 added
   *  the cert chain there for its resolved preview) — `computeLineWeight`, imported from
   *  OrderLineCard by LinesSection, is typed against that shape. The fetch already returns them;
   *  nothing on the hub reads them (the hub shows the order's own FROZEN values, never a
   *  re-derivation — spec §6.1). */
  certRequired: boolean | null; certScope: CertScopeValue | null;
  inheritedCertRequired: boolean; inheritedCertScope: CertScopeValue;
};

/** A container type as `GET /api/picklists/containerType` answers it. `tareEach` is the type's
 *  default tare each in pounds, or null when it has none. */
export type ContainerTypeOption = { id: string; name: string; tareEach: number | null };

/** Slice of `getCustomer`'s row (src/server/customers.ts) this page actually reads. */
type Customer = { id: string; code: string; name: string; orderNotes: string };

// `entity` since #153: the single-record audit read is a UNION over the parent's child sections,
// so a row in it is not necessarily the order's own.
type AuditEntry = { id: string; entity: string; action: string; reason: string | null };

/** A voided order is read-only everywhere (spec §5c) regardless of what the permission grid would
 *  otherwise allow — this is the one place that override is applied, so every section downstream
 *  just consumes the resulting `Gate` exactly like any other permission gate. */
function voidLocked(g: Gate, voided: boolean): Gate {
  return voided ? { allowed: false, disabled: true, title: "Order is voided" } : g;
}

/** `useSearchParams` suspends during prerender, and Next refuses to build a page that reads it
 *  outside a Suspense boundary — hence this thin wrapper around the real route component. */
/** The More actions item "Link another order": the hash opens Overview through RecordTabs' hashchange
 *  listener (a tab switch clears the hash, so it is never already set while another tab shows), then
 *  the Link box takes focus. Module-level and hook-free: it writes a browser global, not state. */
function focusLinkRow(): void {
  window.location.hash = "#link-order";
  requestAnimationFrame(() => document.getElementById("link-order")?.focus());
}

export default function OrderHubPage() {
  return (
    <Suspense fallback={<div className="p-6">Loading…</div>}>
      <OrderHubRoute />
    </Suspense>
  );
}

function OrderHubRoute() {
  const { id } = useParams<{ id: string }>();
  // Keep legacy callers while passing the new same-tab intent with the keyed order identity.
  const searchParams = useSearchParams();
  const autoPrint = searchParams.get("print") === "1";
  const printIntentKey = searchParams.get("printIntent");
  const scannedLoad = searchParams.get("load");
  const scanKey = scannedLoad === null ? null : `${scannedLoad}:${searchParams.get("scan") ?? ""}`;
  // Next reuses this route's component instance across /orders/A -> /orders/B (only the param
  // changes, no remount). Keying the body by id forces a fresh instance per order, so no state
  // below (bulk-grid overlays included) can carry one order's unsaved edits onto another order's
  // id (handoff §5.12 — cost a Critical in 2B).
  return <OrderHub key={id} id={id} autoPrint={autoPrint} printIntentKey={printIntentKey} scannedLoad={scannedLoad} scanKey={scanKey} />;
}

function OrderHub({ id, autoPrint, printIntentKey, scannedLoad, scanKey }: { id: string; autoPrint: boolean; printIntentKey: string | null; scannedLoad: string | null; scanKey: string | null }) {
  const { permissions: perms, error: permsError } = usePermissions();

  const [order, setOrder] = useState<OrderDetail | null>(null);
  // The id of this order's finalized invoice, or null. It is what closes Lines and Charges below
  // (#472). `load` alone sets it, from the full read of the order. No action on this page
  // finalizes or unlocks an invoice, and a mutation response does not carry the id. So it is as
  // old as the page's last full read: an invoice finalized or unlocked elsewhere shows here after
  // a reload, and until then the server's own refusal is the enforcement.
  const [finalizedInvoiceId, setFinalizedInvoiceId] = useState<string | null>(null);
  const [scanRead, setScanRead] = useState<{ key: string | null; status: "ready" | "failed" }>({ key: null, status: "ready" });
  const scanStatus = scanRead.key === scanKey ? scanRead.status : "loading";
  const [error, setError] = useState<string | null>(null);
  const [orderReadError, setOrderReadError] = useState<string | null>(null);
  // Supplementary fetches (customer name/notes, the rider-parts list, container types, the void
  // reason) each get their OWN banner rather than the shared `error` a later mutation clears —
  // the customers/[id]/page.tsx `optionsError`/parts/[id]/page.tsx `loadError` precedent: a save
  // elsewhere on the page must not be able to silently erase the report that one of these failed.
  const [loadError, setLoadError] = useState<string | null>(null);
  const addLoadError = useCallback((message: string) => {
    setLoadError((cur) => (cur ? `${cur} ${message}` : message));
  }, []);

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [parts, setParts] = useState<PartOption[]>([]);
  const [containerTypes, setContainerTypes] = useState<ContainerTypeOption[]>([]);
  // undefined = fetched but no reason could be resolved (missing admin.view, the fetch failed, or
  // the latest entry wasn't a delete) — the brief's fallback copy is used for `undefined`, never
  // for a genuine empty-string reason. null = not applicable (order isn't voided).
  const [voidReason, setVoidReason] = useState<string | null | undefined>(null);

  // Fix-wave R4 finding 6: ONE monotonic ticket sequence shared by every write on this page and
  // by `load`'s own full refresh. Each of them replaces the whole `order` state, so overlapping
  // calls race and the winner used to be whichever response happened to arrive last — a slow line
  // edit answering after a fast bulk replace put the page back to a state the server had already
  // moved past, and the sections' bulk-grid overlays then composed against rows that no longer
  // existed. The ticket is taken at DISPATCH; a completion older than the newest one already
  // applied is dropped. `load` participates in the same sequence rather than a private one of its
  // own — otherwise a refresh and a mutation could still each be "newest" on their own counter and
  // clobber each other. A read the server served before a write still out had committed holds the
  // newer ticket, so it either reverts that write on screen or has the write's answer dropped:
  // that is why `load` reads once more after the hub writes it overlapped (#550, `writes` below).
  const mutations = useMutationGate();
  // #550 (owner ruling 2026-10-18, "read now, re-read after"): the hub writes in flight, one
  // request-settled signal per `applyMutation` dispatch, each deleted when its request settles
  // (`makeWriteSignals`, drain-queue.ts), which `load` snapshots as it reads. One registry per
  // mount, built once the way `useMutationGate` builds the gate above: one built per render would
  // start empty on every render, forgetting the writes still out, and would change the identity of
  // `applyMutation` and `load` with it, and through `refreshOrder` re-run the read on every render.
  // A residual (HANDOFF §4, #550): a mount starts with an empty registry, so a write an earlier
  // mount of the same order sent and still out (the order left and opened again within one round
  // trip) is not in it. Nothing aborts that write on unmount, its answer reaches only the unmounted
  // instance, and no read of this mount is followed for it.
  const [writes] = useState(makeWriteSignals);
  const recoverySource = useMemo(() => createOrderBulkSource(
    () => api<OrderDetail>(`/api/orders/${id}`),
    async () => {
      const [me, containerTypes] = await Promise.all([
        api<{ id: string; permissions: string[] }>("/api/auth/me"),
        api<ContainerTypeOption[]>("/api/picklists/containerType"),
      ]);
      const identity = getBrowserDraftSession()?.store.getSnapshot();
      if (!identity?.identityReady || identity.owner?.userId !== me.id) throw new Error("Confirm your identity to access this editor.");
      if (!gate(me.permissions, "orders.view").allowed) throw new Error("Requires orders.view");
      return { editable: gate(me.permissions, "orders.edit").allowed, containerTypes };
    },
  ), [id]);

  // Every set-of-`order`-from-server (load()'s refresh — the §5.13 rollback path included — and
  // applyMutation's response apply below) routes through `editGuard.capturePayload` and an
  // updater that also keeps `travelerPrinted` (`keepTravelerPrinted`, #550), so a response landing
  // mid-typing never resets the Overview/Notes field the user is actively editing
  // (use-edit-guard.ts — the #149 adoption; the parts/[id]/page.tsx shape). The classic trigger
  // here is an onChange-saving date input's PATCH resolving while the user has already moved on
  // to typing in PO/VS/job # or Notes — the whole-detail swap used to eat those keystrokes.
  const editGuard = useEditGuard();
  const savedMarks = useSavedMarks();

  const load = useCallback(async () => {
    // #550 (owner ruling 2026-10-18, "read now, re-read after"; the plan's amendments 1-4): the GET
    // goes out at once, as before. A hub write that was out as it was sent may commit after the
    // server served it, and then the payload predates that write: applied after the write's
    // answer it reverts the write on screen, and applied before it the answer, older-ticketed, is
    // dropped. So when the snapshot below holds a write, the page reads once more after every
    // write in it has settled, whether or not one was still out when this read landed, and
    // whether or not this read was accepted. Detached: `load` resolves with this read, and its
    // caller's message or refusal follows it, without waiting on a write (#276: `api()` has no
    // timeout). The follow-up is this same read, with its own ticket and its own `begin()` taken
    // as it is sent, so it is followed in turn when a write sent since was out as it went; the
    // chain ends at the first read sent with no hub write out. A read that fails applied nothing
    // and is followed by nothing. A follow-up that fails marks the bulk grids' recovery read
    // unavailable in the catch below, as every failed read of the order does, shows no message
    // and is not retried: the page keeps what it shows until the next payload or a reload.
    const readOrder = async (): Promise<OrderRead> => {
      const ticket = mutations.next();
      const recoveryRead = recoverySource.begin();
      // The hub writes out as this GET is sent. One sent after it holds a newer ticket, so the
      // gate already orders its answer against this read, and it is not waited for.
      const writesOut = writes.outstanding();
      let o: OrderRead;
      try { o = await api<OrderRead>(`/api/orders/${id}`); }
      catch (error) { recoveryRead.unavailable(); throw error; }
      // Captured-session apply inside the accept branch (use-edit-guard.ts, the round-3
      // fixpoint): a dropped stale payload is never applied, so it is never noted either.
      // `travelerPrinted` stays true once the page holds it (#550, owner ruling 2): a read served
      // before a traveler print committed and landing after `onPrinted` says false, and applied
      // whole it cleared the banner until the next payload. So this is applyMutation's composed
      // updater, for the reason given there. The read is wider than the `OrderDetail` the state
      // holds. The type argument only names that narrower type (nothing reads it at run time), and
      // `merge` returns `prev`'s `OrderDetail`, not the read's type.
      if (mutations.accept(ticket)) {
        const captured = editGuard.capturePayload<OrderDetail>(o);
        setOrder((prev) => captured.merge(prev, keepTravelerPrinted(prev, o)));
        setFinalizedInvoiceId(o.finalizedInvoiceId);
        void recoveryRead.accept(o);
      }
      reReadAfter(writesOut, () => { void readOrder().catch(() => {}); });
      return o;
    };
    return readOrder();
  }, [id, mutations, editGuard, recoverySource, writes]);
  const scanReads = useLatest();
  const refreshOrder = useCallback(async () => {
    const ticket = scanReads.next();
    try {
      await load();
      if (scanReads.isCurrent(ticket)) {
        setOrderReadError(null);
        setScanRead({ key: scanKey, status: "ready" });
      }
    } catch (e) {
      if (scanReads.isCurrent(ticket)) {
        setOrderReadError((e as Error).message);
        setScanRead({ key: scanKey, status: "failed" });
      }
      throw e;
    }
  }, [load, scanKey, scanReads]);
  useEffect(() => {
    void refreshOrder().catch(() => {}); // The guarded callback exposes the read error.
    return () => { scanReads.next(); };
  }, [refreshOrder, scanReads]);

  /** Runs one whole-order mutation and applies the order it answers with. It is the one place
   *  every action on this page (Overview/Notes/Lines/Containers/Serials/Charges/Loads/
   *  Link/Unlink) reports its result. No mutation answers a warning, and this sets none: what a
   *  save leaves out of step is read from the order it sets.
   *
   *  Takes the request as a THUNK, not its already-resolved result (R4 finding 6): the ordering
   *  ticket has to be taken before the request is dispatched, and a ticket taken after the caller's
   *  own `await` would order responses by arrival — which is the bug, not the fix. Callers still
   *  `await` this and still catch their own failures; the rejection passes straight through. */
  const applyMutation = useCallback(async (run: () => Promise<OrderMutationResult>) => {
    const ticket = mutations.next();
    const recoveryRead = recoverySource.begin();
    let res: OrderMutationResult;
    try {
      const request = run();
      // #550 (owner ruling 2026-10-18): registered at dispatch, in the same synchronous run as the
      // ticket, so the registry holds the write from the instant it is sent until its request
      // settles, however it ends: an answer, a refusal, no answer, a 401 or 403, or #547's unreadable
      // 2xx. The catch below rethrows, but the signal hangs on the request, not on this function. A
      // thunk that throws synchronously sent nothing and registers nothing; an async thunk that
      // rejects before its fetch registers a signal that settles at once, and a read sent in that
      // instant is followed once, for nothing. Neither happens here: every thunk returns `api()`'s
      // promise or is async.
      writes.dispatched(request);
      res = await request;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) recoveryRead.unavailable();
      // #547 (owner ruling 2026-10-18): a 2xx whose answer could not be read committed its write, so
      // History and Shipments are told here as the success path below tells them (#158, #473), and
      // each reads its own list. Nothing is applied and the order itself is not read again (no
      // `load` or `refreshOrder`); the rejection still reaches the caller. As of 6e42469 every thunk
      // run through here sends one write and no read (a census, not a guarantee).
      if (error instanceof UnreadableAnswerError) { invalidateHistory(); invalidateOrderShipments(); }
      throw error;
    }
    // #158 — success path, the instant the mutation resolves and BEFORE the accept gate: the
    // server state has certainly changed even when this response is superseded and its payload
    // dropped. This one seam covers the header PATCH, Link and Unlink here AND every write the
    // five co-located sections make through the same callback (lines, containers, serials,
    // charges, loads) — all of them the order's own before/after diff, which is exactly what the
    // panel at the bottom of this page renders.
    invalidateHistory();
    // #473 — the same seam and the same position, for the Shipments section: a shipment row's
    // Complete or Partial tag is computed from the order's current line quantities, so a line
    // save, add or remove can change it. Before the accept gate for the reason above: a dropped
    // payload's write still happened.
    invalidateOrderShipments();
    if (!mutations.accept(ticket)) return;
    const fresh = res;
    void recoveryRead.accept(fresh);
    // `travelerPrinted` merges MONOTONICALLY (Codex MR !141 round 5; `keepTravelerPrinted`): a
    // mutation dispatched before a traveler print commits can resolve after it, carrying a
    // snapshot computed when the flag was still false — and a whole-detail swap would un-print it
    // until reload. The fact only ever goes false → true (stored documents never delete, spec
    // §5.6), so preserving a local true is exact under EVERY response ordering — the fixpoint the
    // per-callback timing fixes could not reach. The #149 focused-field preserve composes OVER
    // that adjustment: `next` is the incoming server detail (flag-corrected), and the captured
    // session's merge then keeps only the one text field the user is actively editing — a
    // boolean is never under a text cursor, so the two preserves cannot collide.
    // One of two composed sites, `load` and `applyMutation`, both through `keepTravelerPrinted`
    // (#550): the updater derives `next` FROM prev (the monotonic boolean preserve above), so it
    // cannot be a plain applyPayload — capturePayload takes the same capture+note at dispatch
    // (against `fresh` itself, which is exact: `keepTravelerPrinted` only ever alters
    // `travelerPrinted`, a boolean never registered with the guard) and the updater merges
    // `next` with that captured session (use-edit-guard.ts, round 3).
    const captured = editGuard.capturePayload(fresh);
    setOrder((prev) => captured.merge(prev, keepTravelerPrinted(prev, fresh)));
  }, [mutations, editGuard, recoverySource, writes]);

  /** The read the Lines section asks for once, after a line Remove the server answered 404 "Order
   *  line not found" (#475). The order no longer holds the line, and the write that removed it ran no
   *  success path here: a DELETE of this page's whose answer was lost, or another tab's or
   *  user's. So the server state has certainly changed, with nothing told unless the lost answer
   *  was a 2xx whose body could not be read, which applyMutation's catch told (#547; a second tell
   *  is a refresh that finds nothing new). History and Shipments are told here (#158 and #473,
   *  applyMutation's seam above). Then the order is read through `load`, which reads it once more
   *  after any hub write that was out as its GET was sent, such as a save sent during the DELETE's
   *  round trip (#550). An order read after that answer cannot list the line, so its payload ends
   *  any mark the line carries. Not `refreshOrder`: a failed read there marks the scan read
   *  failed, which closes the per-load prints. A failed read rejects to the section, which says
   *  so; `load` has then marked the bulk grids' recovery read unavailable, as every failed read of
   *  the order does. The section's words follow the first read: a follow-up that fails reaches no
   *  caller and shows no message, and marks the grids unavailable the same way. */
  const readAfterRemoval = useCallback(async () => {
    invalidateHistory();
    invalidateOrderShipments();
    await load();
  }, [load]);

  const customersGate = gate(perms, "customers.view");
  const partsGate = gate(perms, "parts.view");
  const auditGate = gate(perms, "admin.view");
  const editGate = voidLocked(gate(perms, "orders.edit"), order?.voided ?? false);
  // Under a finalized invoice the server refuses a line change, a line removal (#486), an added
  // line and a charges save with the invoice's sentence, and no other save behind `editGate` asks
  // about the invoice (#472, owner ruling R-Q5 of 2026-10-08). So only the Lines and Charges
  // sections get the invoice rung, each titled with the sentence its own save would be refused
  // with. The rung comes last: a voided order and a missing permission keep their own reason.
  // Overview, Notes, Containers, Serials, Loads and attachments keep `editGate`. The server
  // refuses Void order under a finalized invoice too, and it keeps `voidGate` all the same: with
  // money applied the server names that first, and this page cannot know it. The order number is
  // read only when the id is set, and the id is set only by a read that also set `order`.
  const { linesGate, chargesGate } = orderInvoiceGates(editGate, order?.orderNumber ?? 0, finalizedInvoiceId);
  const voidGate = order?.voided
    ? { allowed: false, disabled: true, title: "Already voided" }
    : gateDo(perms, "void_order");
  // AttachmentsSection takes a plain boolean, not a Gate — task-14-brief.md's exact formula.
  const attachmentsCanEdit = gate(perms, "orders.edit").allowed && !(order?.voided ?? false);

  const customerId = order?.customerId;

  // Customer name/standing-notes (Overview + Notes sections). Attempted only once the caller is
  // known to hold customers.view — the entry page's own precedent (`if (!customersGate.allowed)
  // return;`) — rather than firing a call guaranteed to 403; refires once permissions resolve.
  useEffect(() => {
    if (!customerId || !customersGate.allowed) return;
    api<Customer>(`/api/customers/${customerId}`).then(setCustomer)
      .catch((e) => addLoadError(`Could not load the customer: ${(e as Error).message}`));
  }, [customerId, customersGate.allowed, addLoadError]);

  // The customer's ACTIVE parts, read as one customer's rows (`?customerId=`, #614; the page used
  // to read the whole catalog, inactive rows included, and keep this customer's in the browser).
  // Feeds the rider-add picker only (LinesSection, active parts only — an inactive part cannot be
  // added, per resolveLineParts), so the inactive rows are not asked for; the client-side filter
  // stays as a belt. SerialsSection's serialization warning no longer needs this fetch at all
  // (fix-wave R3 finding 6): `line.part.serializationRequired` rides on OrderDetail itself, gated
  // by orders.view. A saved line's each weight does not come from here either:
  // `line.part.eachWeight` rides on OrderDetail the same way, so it is there without parts.view
  // and before this fetch answers.
  useEffect(() => {
    if (!customerId || !partsGate.allowed) return;
    api<PartOption[]>(`/api/parts?customerId=${customerId}`)
      .then((rows) => setParts(rows.filter((p) => p.customerId === customerId)))
      .catch((e) => addLoadError(`Could not load parts: ${(e as Error).message}`));
  }, [customerId, partsGate.allowed, addLoadError]);

  // Session-only pick-list (no permission beyond signed-in) — the entry page's own precedent.
  useEffect(() => {
    api<ContainerTypeOption[]>("/api/picklists/containerType").then(setContainerTypes)
      .catch((e) => addLoadError(`Could not load container types: ${(e as Error).message}`));
  }, [addLoadError]);

  const voided = order?.voided ?? false;

  // The voided banner's reason (task-14-brief.md: "fetch the void reason from the latest audit
  // entry via the existing audit read API ... if only HistoryPanel surfaces it, the banner says
  // 'Voided — see History for the reason' and that's acceptable"). `/api/admin/audit` is gated
  // admin.view (HistoryPanel.tsx's own comment), so a caller without it — plausible; orders.view
  // does not imply admin.view — gets the fallback copy rather than a guaranteed 403. Safe to key
  // on `voided` alone: once voided, no mutator can touch the order again (every one of them
  // requires deletedAt: null), so the delete entry is the order's own newest.
  //
  // It is NOT necessarily the newest row in the response, though: since #153 this read is a
  // union over the order's child sections, hence the `entity` filter below rather than `rows[0]`.
  // The union is also CAPPED (AUDIT_PANEL_LIMIT), so a parent holding more child rows than the
  // cap NEWER than its own delete entry would push that entry out of the window and drop this
  // banner to its generic copy. Not reachable today — a voided order takes no further child
  // edits either — but it is the failure mode to remember if the cap or the registry changes.
  useEffect(() => {
    if (!voided) { setVoidReason(null); return; }
    if (!auditGate.allowed) { setVoidReason(undefined); return; }
    api<{ rows: AuditEntry[]; hasMore: boolean }>(`/api/admin/audit?entity=order&entityId=${id}`)
      .then(({ rows }) => {
        // The newest row belonging to the ORDER — `rows[0]` since #153 may be an attachment's
        // entry, and reading the reason off that would quietly drop the banner's copy back to
        // the generic fallback with nothing to show it had happened. See the cap note above.
        const latest = rows.find((e) => e.entity === "order");
        setVoidReason(latest?.action === "delete" ? (latest.reason ?? undefined) : undefined);
      })
      .catch(() => setVoidReason(undefined));
  }, [voided, auditGate.allowed, id]);

  // ---- Overview + Notes: optimistic scalar PATCH (customers/[id]/page.tsx `save()` precedent) ----

  // Per-key request queue: without it, two overlapping PATCHes to the same field (an ordinary
  // double-blur) can commit out of order and leave the database holding the opposite of the last
  // thing the UI showed.
  const queue = useRef<Map<string, Promise<unknown>>>(new Map());
  function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = queue.current.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    queue.current.set(key, next.catch(() => {}));
    return next;
  }
  // Per-key REQUEST-settled signals for the failure drain below (Task 7 fix round 1): the drain
  // must never await the queue's chain TAILS — a tail settles only after its own catch, drain
  // included, completes, so two keys' saves both failing while overlapping had each catch
  // awaiting the other's tail: a mutual deadlock. A signal settles with its key's dispatched
  // request — which IS the commit/failure the rollback GET must postdate — and never depends on
  // a drain, so no cycle is possible (drain-queue.ts carries the full story).
  const inFlight = useRef<Map<string, Promise<unknown>>>(new Map());

  // A keystroke into a guarded detail object types through this pure updater, never an object
  // built from the render's copy, so a server payload landing beside the keystroke is kept (#574).
  // `travelerPrinted` is out of its reach by type: only `keepTravelerPrinted` and `onPrinted` write
  // the flag (#550).
  function patchDraft(patch: Partial<Omit<OrderDetail, "travelerPrinted">>) {
    setOrder((cur) => (cur ? { ...cur, ...patch } : cur));
  }

  /** Overview's scalar fields + Notes' textarea share one PATCH surface (Task 5's `updateOrder`).
   *  Optimistic: the field shows the typed value immediately; a rejection rolls back to server
   *  truth first and then reports why (§5.13). `load()` calls no `setError`, on success or on
   *  failure, so the rollback read cannot clear the message whichever of the two comes first; nor
   *  does the read `load` may send once more after the hub writes the rollback read overlapped
   *  (#550). */
  async function saveOrder(
    patch: Partial<Pick<OrderDetail,
      "poNumber" | "vsOrderNumber" | "customerJobNo" | "receivedDate" | "requestDate" | "targetDate" | "notes"
      | "certRequired" | "certScope">>,
  ): Promise<boolean> {
    // The optimistic patch needs no editGuard apply (the customers/parts save() shape): it
    // spreads over `cur`, touching only the just-blurred field (or an unfocusable date input's),
    // so the focused sibling's in-flight text is untouched by construction. The merges guard the
    // SERVER-detail applies — applyMutation's response and the rollback load() below.
    setOrder((cur) => (cur ? { ...cur, ...patch } : cur));
    // A multi-field patch's composite key would NOT serialize against its constituent
    // single-field keys — latent only: every caller PATCHes one field per save.
    const key = Object.keys(patch).sort().join(",");
    // #693: a PATCH carrying either cert field can mint the order-scope cert server-side, so the
    // Certifications section is told to read again once it has landed, or answered a 2xx the
    // page could not read (that write committed, #547). Never after a refusal: it minted nothing.
    const certFields = "certRequired" in patch || "certScope" in patch;
    return serial(key, async () => {
      try {
        const req = applyMutation(() => api<OrderMutationResult>(
          `/api/orders/${id}`, { method: "PATCH", body: JSON.stringify(patch) }));
        inFlight.current.set(key, req.then(() => {}, () => {})); // request-settled signal, at dispatch
        await req;
        if (certFields) invalidateOrderCerts();
        setError(null);
        // The one Saved mark (R7): each field this save carried reads Saved while its box shows it.
        for (const [field, value] of Object.entries(patch)) savedMarks.mark(field, String(value ?? ""));
        return true;
      } catch (e) {
        if (certFields && e instanceof UnreadableAnswerError) invalidateOrderCerts();
        // §5.13 rollback-drain (Task 7): wait out every OTHER key's in-flight request before
        // the rollback GET — served before a sibling key's PATCH commits, the newest-ticket GET
        // would revert that sibling's committed write on screen (its own response then drops as
        // older-ticketed). Drains the request-settled SIGNALS above, never the queue tails
        // (fix round 1 — mutual deadlock). Same-key corrections need no drain — a same-key
        // response re-applies through the accept gate. The hub's writes under no key of this map
        // (Lines, the grids, Link and Unlink) are not drained: when one is out as the rollback GET
        // is sent, `load` reads once more after it settles (#550).
        await drainOtherKeys(inFlight.current, key);
        await load().catch(() => {});
        setError((e as Error).message);
        return false;
      }
    });
  }

  // Blur-save guard and focused-field tracking are both `editGuard`'s (use-edit-guard.ts — the
  // #149 adoption; this page carried the pre-guard `focusedValue` ref the guard itself grew out
  // of). The no-op half is unchanged: only fields the user actually changed reach the network,
  // still diffing the blur value against the at-focus snapshot. What's new is registering WHICH
  // OrderDetail property is under the cursor, which is what lets load()'s and applyMutation's
  // merges above preserve the field mid-typing when a response lands (the parts/[id]/
  // IdentitySection.tsx noteFocus shape). The onChange-saving date inputs register nothing —
  // they are the clobber TRIGGER, not the target; their behavior is unchanged.
  const noteFocus = (key: keyof OrderDetail & string) => editGuard.onFocusField(key);
  function onBlurSave(
    e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>,
    commit: (value: string) => void,
  ) {
    editGuard.onBlurSave(e, commit);
  }
  // Enter commits a single-line box as its blur does, the cursor kept in it (owner ruling R7): the
  // same commit, through the guard, whose fresh session makes the blur after it send nothing.
  function onEnterSave(e: React.KeyboardEvent<HTMLInputElement>, commit: (value: string) => void) {
    editGuard.onEnterCommit(e, commit);
  }

  // ---- Void / Link / Unlink: non-optimistic (customers/[id]/page.tsx `call()` precedent) ----

  async function voidAction() {
    if (!order) return;
    // PR 2 (ruling 5): the modal form; a blank reason holds the dialog open with the sentence below,
    // and Cancel resolves null, so the two checks after it are kept as the native form had them.
    const reason = await askReason({
      question: `Void order #${order.orderNumber}?\n\n` +
        `Every control on this order becomes read-only. The order number is never reused and this ` +
        `cannot be undone through the UI.`,
      verb: "voiding", blankRefusal: "A reason is required to void an order.",
    });
    if (reason === null) return; // cancelled
    if (!reason.trim()) { setError("A reason is required to void an order."); return; }
    // Two separate try/catches (the customers/[id]/page.tsx `call()` precedent), not one wrapping
    // both calls: DELETE returns { ok: true }, not a fresh OrderDetail, so picking up voided:true
    // needs a follow-up `load()` — and if THAT fails, the void itself still succeeded. Reporting
    // that as a generic failure would misrepresent an order that WAS voided as one that wasn't.
    try {
      await api(`/api/orders/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
    } catch (e) {
      // #547 (owner ruling 2026-10-18): a 2xx proves the void committed, and its answer holds only
      // `{ ok: true }`, so an answer that could not be read falls through to the success path below.
      // Any other failure shows its message and stops.
      if (!(e instanceof UnreadableAnswerError)) {
        setError((e as Error).message);
        return;
      }
    }
    // #158 — success path, before the follow-up load. The void is an `auditedSoftDelete("order", …)`
    // carrying the typed reason, and this page stays mounted (read-only) to show it.
    invalidateHistory();
    setError(null);
    try {
      await load();
    } catch (e) {
      setError(`Order voided, but the page could not be refreshed — reload to see the current state. (${(e as Error).message})`);
    }
  }

  const [linkInput, setLinkInput] = useState("");
  const [linking, setLinking] = useState(false);
  // Link's and Unlink's own message, under the Link row (owner ruling R1, P6 step 5a): a row
  // action's refusal shows beside its control, never in the page banner.
  const [linkMessage, setLinkMessage] = useState<string | null>(null);
  /** Link takes an order NUMBER, not an id (the brief's own contract) — resolved via
   *  `GET /api/orders?search=&customerId=` (the board's own query route, already required for
   *  `orders.view`), scoped to THIS order's customer, then matched to the exact number typed. The
   *  alternative considered was the global-search route (`/api/search`, which returns
   *  `exactOrderId` directly) — rejected because it does not accept a customer scope, so a second
   *  round trip (fetch that order, check its customerId) would still be needed; the board query
   *  does both in one call. */
  async function linkAction() {
    if (!order) return;
    const typed = linkInput.trim();
    if (!typed) return;
    setLinking(true);
    try {
      const rows = await api<{ id: string; orderNumber: number }[]>(
        `/api/orders?search=${encodeURIComponent(typed)}&customerId=${order.customerId}`,
      );
      const match = rows.find((r) => String(r.orderNumber) === typed && r.id !== order.id);
      if (!match) {
        // order.customer, not the customers.view-gated fetch (#46) — the refusal names the
        // customer for every caller who can use this control at all.
        setLinkMessage(`No order #${typed} found for ${order.customer.code} · ${order.customer.name}.`);
        return;
      }
      await applyMutation(() => api<OrderMutationResult>(
        `/api/orders/${id}/link`, { method: "POST", body: JSON.stringify({ otherId: match.id }) },
      ));
      setLinkInput("");
      setLinkMessage(null);
    } catch (e) {
      setLinkMessage((e as Error).message);
    } finally {
      setLinking(false);
    }
  }

  async function unlinkAction() {
    if (!(await askConfirm({ title: "Unlink this order from its group?", body: "Its linked siblings are unaffected.", confirm: "Unlink" }))) return;
    try {
      await applyMutation(() => api<OrderMutationResult>(`/api/orders/${id}/unlink`, { method: "POST" }));
      setLinkMessage(null);
    } catch (e) {
      setLinkMessage((e as Error).message);
    }
  }

  if (!order) return <PageStatus error={orderReadError ?? error ?? permsError} />;

  // The Lines section shows an offered weight blocked when it is below what has already shipped,
  // which is when the server would refuse it. Every read of the order carries this ledger.
  const shippedWeightByLineId = new Map(order.orderLineShippedToDate.map((s) => [s.orderLineId, s.shippedToDateWeight]));

  return (
    <TravelerProvider orderId={id} loads={order.loads} voided={voided} viewGate={gate(perms, "orders.view")}
      autoPrint={autoPrint} printIntentKey={printIntentKey} permissionsReady={perms !== undefined || permsError !== null} onPrinted={() => setOrder(o => o === null ? o : { ...o, travelerPrinted: true })}>
    <div className="min-w-0 p-3 sm:p-6">
      <PageHeader title={`Order #${order.orderNumber}`}
        subtitle={<span className="flex flex-wrap items-center gap-1 break-words">
          {customersGate.allowed
            ? <Link href={`/customers/${order.customerId}`} className={LINK}>{order.customer.code} · {order.customer.name}</Link>
            : <span>{order.customer.code} · {order.customer.name}</span>}
          {order.poNumber && <span> · {order.poNumber}</span>}
          <span> · </span>
          <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-full ${LIGHT_DOT_CLASS[order.light]}`} />
          <span>{LIGHT_LABELS[order.light]} · {ORDER_STATUS_LABELS[order.status]}</span>
          {order.voided && <span className="font-medium text-red-700"> · Voided</span>}
        </span>}
        actions={<>
          {/* Link and Unlink in More actions (owner ruling 2026-10-31); Void stays in the title row (ruling 8). */}
          <ActionMenu items={[
            { label: "Link another order", sub: "Same customer only", disabled: editGate.disabled, title: editGate.title, onSelect: focusLinkRow },
            { label: "Unlink from group", sub: "Linked orders remain unchanged", disabled: editGate.disabled || order.linkedOrders.length === 0,
              title: order.linkedOrders.length === 0 ? "Not linked to any other orders" : editGate.title, onSelect: () => void unlinkAction() },
          ]} />
          <DangerButton disabled={voidGate.disabled} title={voidGate.title} onClick={() => void voidAction()}>Void order</DangerButton>
        </>} />

      {orderReadError && <p className={`${NOTICE.refusal} mb-3`}>{orderReadError}</p>}
      {(error ?? permsError) && (
        <p className={`${NOTICE.refusal} mb-3 whitespace-pre-line`}>{error ?? permsError}</p>
      )}
      {voided && (
        <p className={`${NOTICE.refusal} mb-3 font-medium`}>
          Voided — {voidReason ?? "see History for the reason"}
        </p>
      )}
      {loadError && <p className={`${NOTICE.warning} mb-3`}>{loadError}</p>}

      <div className="flex flex-col gap-6 min-[1360px]:flex-row min-[1360px]:items-start">
      <div className="min-w-0 flex-1">
      <RecordTabs label={HUB_TAB_LABEL} tabs={orderHubTabs(order.loads.map((l) => l.loadNumber))}
        open={scanOpen(scannedLoad, scanKey)} panels={{
        overview: <>
      {/* ---- Overview ---- */}
      <section id="overview" data-order-section tabIndex={-1} className={`${CARD} mb-6`}>
        <h2 className="mb-2 font-medium">Overview</h2>
        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
          <label className="block">
            PO number<SavedMark label="PO number" show={savedMarks.shows("poNumber", order.poNumber)} />
            <input aria-label="PO number" value={order.poNumber} onFocus={noteFocus("poNumber")} readOnly={!editGate.allowed} title={editGate.title}
                   onChange={(e) => patchDraft({ poNumber: e.target.value })}
                   onBlur={(e) => onBlurSave(e, (poNumber) => void saveOrder({ poNumber }))}
                   onKeyDown={(e) => onEnterSave(e, (poNumber) => void saveOrder({ poNumber }))}
                   className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
          </label>
          <label className="block">
            VS reference<SavedMark label="VS reference" show={savedMarks.shows("vsOrderNumber", order.vsOrderNumber)} />
            <input aria-label="VS reference" value={order.vsOrderNumber} onFocus={noteFocus("vsOrderNumber")} readOnly={!editGate.allowed} title={editGate.title}
                   onChange={(e) => patchDraft({ vsOrderNumber: e.target.value })}
                   onBlur={(e) => onBlurSave(e, (vsOrderNumber) => void saveOrder({ vsOrderNumber }))}
                   onKeyDown={(e) => onEnterSave(e, (vsOrderNumber) => void saveOrder({ vsOrderNumber }))}
                   className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
          </label>
          <label className="block">
            Customer job<SavedMark label="Customer job" show={savedMarks.shows("customerJobNo", order.customerJobNo)} />
            {/* §3.22: the customer's own job number, printed on the shipping ticket beside the
                PO. Same blur-save shape as PO/VS # above; stays editable at every status
                (spec §5.5's "everything else stays editable" list names it). */}
            <input aria-label="Customer job" value={order.customerJobNo} onFocus={noteFocus("customerJobNo")} readOnly={!editGate.allowed} title={editGate.title}
                   onChange={(e) => patchDraft({ customerJobNo: e.target.value })}
                   onBlur={(e) => onBlurSave(e, (customerJobNo) => void saveOrder({ customerJobNo }))}
                   onKeyDown={(e) => onEnterSave(e, (customerJobNo) => void saveOrder({ customerJobNo }))}
                   className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
          </label>
          <div className="block">
            Status
            <div className="mt-1 flex items-center gap-1.5 rounded border bg-surface-50 px-2 py-1">
              <span className={`inline-block h-2.5 w-2.5 rounded-full ${LIGHT_DOT_CLASS[order.light]}`} />
              <span>{LIGHT_LABELS[order.light]}</span>
              <span className="text-ink-500">· {ORDER_STATUS_LABELS[order.status]}</span>
            </div>
          </div>
          <label className="block">
            Received date
            <input type="date" value={order.receivedDate} disabled={!editGate.allowed} title={editGate.title}
                   onChange={(e) => void saveOrder({ receivedDate: e.target.value })}
                   className={`${INPUT_COMPACT} mt-1 w-full disabled:bg-surface-50`} />
          </label>
          <label className="block">
            Request date
            <input type="date" value={order.requestDate} disabled={!editGate.allowed} title={editGate.title}
                   onChange={(e) => void saveOrder({ requestDate: e.target.value })}
                   className={`${INPUT_COMPACT} mt-1 w-full disabled:bg-surface-50`} />
          </label>
          <label className="block">
            Target date
            <input type="date" value={order.targetDate ?? ""} disabled={!editGate.allowed} title={editGate.title}
                   onChange={(e) => void saveOrder({ targetDate: e.target.value || null })}
                   className={`${INPUT_COMPACT} mt-1 w-full disabled:bg-surface-50`} />
          </label>
          {/* Spec §6.1: certRequired/certScope were RESOLVED (part → customer → plant) and frozen
              onto the order at save; what's shown and edited here is the stored pair, never a
              re-derivation — an edit is a plain scalar PATCH like every field above (spec §5.5
              keeps both editable at every status). An edit that lands the order on required +
              By order creates the order-scope cert in the same transaction (§6.2, ruling 26), and
              `saveOrder` then tells the Certifications section below to read again (#693); no edit
              destroys a cert. That section's picker raises a cert by hand at any scope (#165). */}
          <div className="block">
            <span className="flex items-center gap-2">
              <input type="checkbox" id="cert-required" checked={order.certRequired}
                     disabled={!editGate.allowed} title={editGate.title}
                     onChange={(e) => void saveOrder({ certRequired: e.target.checked })} />
              <label htmlFor="cert-required">Certification required</label>
            </span>
            <label className="mt-1 block">
              <span className="sr-only">Certification scope</span>
              <select value={order.certScope} disabled={!editGate.allowed} title={editGate.title}
                      onChange={(e) => void saveOrder({ certScope: e.target.value as CertScopeValue })}
                      className={`${INPUT_COMPACT} w-full disabled:bg-surface-50`}>
                {CERT_SCOPES.map((s) => <option key={s} value={s}>{CERT_SCOPE_LABELS[s]}</option>)}
              </select>
            </label>
          </div>
        </div>

        <div className="mt-4 border-t pt-3">
          <h3 className="mb-1 text-sm font-medium">Linked orders</h3>
          {order.linkedOrders.length === 0 ? (
            <p className="text-sm text-ink-500">Not linked to any other orders.</p>
          ) : (
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
              {order.linkedOrders.map((o) => (
                <Link key={o.id} href={`/orders/${o.id}`} className={`${LINK} rounded bg-surface-50 px-2 py-0.5`}>
                  #{o.orderNumber}
                </Link>
              ))}
              <button onClick={unlinkAction} disabled={editGate.disabled} title={editGate.title}
                      className="text-xs text-red-600">
                Unlink
              </button>
            </div>
          )}
          <div className="flex items-center gap-2">
            <input id="link-order" value={linkInput} onChange={(e) => setLinkInput(e.target.value)}
                   placeholder="Order #" disabled={editGate.disabled} title={editGate.title}
                   className={`${INPUT_COMPACT} w-32 disabled:cursor-not-allowed disabled:bg-surface-50`} />
            <button onClick={() => void linkAction()} disabled={editGate.disabled || linking || !linkInput.trim()}
                    title={waitingTitle(editGate, linkInput.trim() === "", ENTER_ORDER_NUMBER_FIRST)}
                    className={BUTTON_PRIMARY_COMPACT}>
              {linking ? "Linking…" : "Link"}
            </button>
          </div>
          <PanelMessage message={linkMessage} />
        </div>
      </section>

      <section className={`${CARD} mb-6`}>
        <h2 className="mb-2 font-medium">Notes</h2>
        <label className="mb-3 block text-sm">
          Order notes
          <textarea value={order.notes} rows={3} onFocus={noteFocus("notes")} readOnly={!editGate.allowed} title={editGate.title}
                    onChange={(e) => patchDraft({ notes: e.target.value })}
                    onBlur={(e) => onBlurSave(e, (notes) => void saveOrder({ notes }))}
                    className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
        </label>
        {customer?.orderNotes && (
          <div className="text-sm">
            <span className="font-medium">Customer standing order notes: </span>
            <span className="text-ink-500">{customer.orderNotes}</span>
          </div>
        )}
      </section>

        </>,
        parts: <>
      <LinesSection
        orderId={id} lines={order.lines} shippedWeightByLineId={shippedWeightByLineId}
        customerParts={parts} editGate={linesGate} partsGate={partsGate}
        customerId={order.customerId} receivedDate={order.receivedDate}
        ordersViewAllowed={gate(perms, "orders.view").allowed}
        applyMutation={applyMutation} readAfterRemoval={readAfterRemoval}
      />

      <ContainersSection recoverySource={recoverySource}
        orderId={id} containers={order.containers} lines={order.lines} containerTypes={containerTypes} editGate={editGate}
        viewGate={gate(perms, "orders.view")} voided={voided}
        applyMutation={applyMutation}
      />

      <SerialsSection recoverySource={recoverySource}
        orderId={id} lines={order.lines} serials={order.serials} editGate={editGate}
        applyMutation={applyMutation}
      />

      <ChargesSection recoverySource={recoverySource}
        orderId={id} charges={order.charges} editGate={chargesGate} applyMutation={applyMutation}
      />

        </>,
        process: <>
      <div id="process" data-order-section tabIndex={-1}><ProcessSection orderId={id} /></div>

        </>,
        loads: <>
      <LoadsSection recoverySource={recoverySource}
        orderId={id} loads={order.loads} onRefresh={refreshOrder} travelerPrinted={order.travelerPrinted} scannedLoad={scannedLoad} scanStatus={scanStatus}
        editGate={editGate} applyMutation={applyMutation}
      />

      <DocumentsSection />

        </>,
        shipping: <>
      <div id="shipping" data-order-section tabIndex={-1}><ShipmentsSection orderId={id} orderNumber={order.orderNumber} viewGate={gate(perms, "shipping.view")} /></div>

      <CertificationsSection
        orderId={id} loads={order.loads} certRequired={order.certRequired} certScope={order.certScope}
        viewGate={gate(perms, "certs.view")}
        createGate={voidLocked(gate(perms, "certs.create"), voided)}
        // #165: what it takes to LIST this order's shipments, which is the only way the section's
        // scope picker can name a SHIPMENT-scope target. NOT void-locked — it gates a read, and
        // the create it feeds is already void-locked by `createGate` above.
        shipmentsGate={gate(perms, "shipping.view")}
      />

        </>,
        billing: <div id="invoices" data-order-section tabIndex={-1}>
      <InvoicesSection
        orderId={id} orderStatus={order.status}
        viewGate={gate(perms, "invoicing.view")} createGate={gate(perms, "invoicing.create")}
      />

      </div>,
        files: <>
      <div id="attachments" data-order-section tabIndex={-1}>
      {/* #37: when the block is the order's own state, say so — voidLocked's exact wording —
          instead of the component's default "Requires orders.edit" (§5.16: the title must name
          the REAL reason; a voided order is read-only regardless of the permission grid). */}
      <AttachmentsSection owner="order" ownerId={id} canEdit={attachmentsCanEdit}
                          disabledTitle={voided ? "Order is voided" : undefined} />

      </div>
      <div id="history" data-order-section tabIndex={-1} className="mb-6">
        <HistoryPanel entity="order" entityId={id} perms={perms} permsError={permsError} />
      </div>
        </>,
      }} />
      </div>
      <OrderAtAGlance order={order} />
      </div>
    </div>
    </TravelerProvider>
  );
}
