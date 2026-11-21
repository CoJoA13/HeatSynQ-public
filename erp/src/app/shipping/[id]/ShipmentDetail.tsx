"use client";
import { formatDateTime } from "@/lib/format";
// The shipment page's body (design spec §11 "Shipment page"). A shipment is a DOCUMENT: a header,
// then one panel per order on it (ShipmentOrderPanel.tsx). Remounted per id by page.tsx's
// `key={id}` (HANDOFF §5.12 — a Critical in Phase 2B): every defaultValue-bound field and every
// bulk-grid overlay below is therefore guaranteed fresh per shipment id, never carrying one
// shipment's unsaved text onto another's.
//
// THE BINDING STATE MODEL (the 2C-3 lesson, order hub's own precedent): header PATCHes are
// optimistic with rollback-then-report on failure (§5.13 — reload BEFORE setting the error, never
// after); Add order/Remove order/Void are non-optimistic (apply only the server's own fresh
// response); the three grids per panel keep only what the user actually edited/added/removed,
// composed with server state at render (`useBulkGrid`, src/lib/bulk-grid.ts).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError, trackedFetch, UnreadableAnswerError } from "@/lib/fetcher";
import { openPendingTab } from "@/lib/print-tab";
import { gate, gateDo, permissionsPending, type Gate } from "@/lib/permission-ui";
import { createBulkRecoverySource, readBulkPermissions } from "@/lib/bulk-recovery-source";
import { getBrowserDraftSession, peekBrowserDraftSession } from "@/lib/draft-session";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest, useMutationGate } from "@/lib/use-latest";
import { drainOtherKeys, makeWriteSignals, reReadAfter } from "@/lib/drain-queue";
import { useEditGuard } from "@/lib/use-edit-guard";
import { HistoryPanel, invalidateHistory } from "@/components/HistoryPanel";
import { DangerButton } from "@/components/DangerButton";
import { FREIGHT_TERMS, FREIGHT_TERMS_LABELS, type FreightTermsValue } from "@/lib/cert-constants";
import { decimalRefusal } from "@/lib/decimal-entry";
import { FREIGHT_AMOUNT } from "@/lib/shipment-boxes";
import { ShipmentOrderPanel } from "./ShipmentOrderPanel";
import { ShipmentTotalsTable } from "@/components/ShipmentTotalsTable";
import { NO_REPORTS, savedShipmentTotalsInput, shipmentTotals, withReport, type ShipmentReports, type TotalsReport } from "@/lib/shipment-totals";
import { askDiscard, captureDiscardNavigation, useUnsavedPresent } from "@/lib/use-unsaved-section";
import { askConfirm, askReason } from "@/lib/modal";
import { PageHeader } from "@/components/PageHeader";
import { NET_WEIGHT_LB, TARE_TOTAL_LB } from "@/lib/weight-terms";
import { RecordTabs } from "@/components/RecordTabs";
import { AtAGlance } from "@/components/AtAGlance";
import { SHIPMENT_TAB_LABEL, shipmentTabs } from "@/lib/shipment-tabs";
import { shipmentOrderScope, unsavedPresentInScope } from "@/lib/unsaved-guard";
import {
  addOrderSelect, invoiceNotice, reasonRequiredGate, removeOrderFacts, shipmentFreightGate, shipmentLinesGate, type AddableState,
} from "@/lib/shipment-gates";
import type { InvoicedOrder } from "@/lib/invoice-freeze";
import { NOTHING_PRINTED, mergePrinted, removeOrderRefusal, type PrintedOrders } from "@/lib/shipment-remove-order";
import { shipToChoice, shipToOptionLabel, type ShipToAddress } from "@/lib/shipment-ship-to";
import { addOrderButtonTitle } from "@/lib/waiting-titles";
import { ListStatus, PageStatus } from "@/components/PageStatus";
import { useStoredDocuments } from "@/lib/use-stored-documents";
import { SavedMark } from "@/components/SavedMark";
import { useSavedMarks } from "@/lib/use-saved-marks";
import {
  BUTTON_NEUTRAL, BUTTON_PRIMARY_COMPACT, CARD, INPUT_COMPACT, LINK, NOTICE,
} from "@/lib/ui-classes";

// ---------------------------------------------------------------------------------------------
// Types. Local mirrors of src/server/shippers.ts's exported row shapes — not imported from
// src/server/**, since a client component pulling from there drags node:async_hooks and Prisma
// into the browser bundle (CLAUDE.md). Exported so ShipmentOrderPanel.tsx imports the ones it
// needs — the orders/[id]/page.tsx `OrderLine`/`ApplyMutation` precedent.
// ---------------------------------------------------------------------------------------------

/** A null orderLineId/orderContainerId/orderSerialId marks a RELEASED row (snapshot + release,
 *  ruling 23): the order-side row was corrected away, and the shipment row is drawn from its own
 *  snapshot fields. A released line or serial is read-only and is never sent in a replace. A
 *  released container is a row of the Containers grid marked Kept: its tare each alone can be
 *  typed, and Save containers sends it by the shipment row's own id. */
export type ShipperLine = {
  id: string; orderLineId: string | null; linePosition: number; partNumber: string; partName: string;
  orderedQty: number; orderedWeight: number; shippedToDateQty: number; shippedToDateWeight: number;
  qty: number; weight: number; lineComplete: boolean;
};
/** `tareEach` is the shipment row's own tare each in lb, null when it has none. */
export type ShipperContainer = {
  id: string; orderContainerId: string | null; typeName: string; customerContainerId: string; count: number; tareEach: number | null; position: number;
};
export type ShipperSerial = {
  id: string; orderSerialId: string | null; serial: string; description: string; printOnShipper: boolean;
};
/** Shipped-to-date for one line of the ORDER — including lines not on this shipment, which is what
 *  the "Add line" picker needs to prefill ship-now to the remainder rather than the full ordered
 *  figure (Task 14 review, Important #1). Dense: a never-shipped line arrives as a real 0/0. */
export type OrderLineShipped = { orderLineId: string; shippedToDateQty: number; shippedToDateWeight: number };
export type ShipperOrder = {
  id: string; orderId: string; orderNumber: number; sequence: number; position: number;
  poNumber: string; customerJobNo: string; label: string;
  orderLineShippedToDate: OrderLineShipped[];
  lines: ShipperLine[]; containers: ShipperContainer[]; serials: ShipperSerial[];
};

/** `freightAmount`/`packageCount` are `number | string | null`: a number once loaded, but also a
 *  string mid-edit (the input is bound straight to the field) — the customers/[id]/page.tsx
 *  `creditLimit` precedent. `freightAmount` is sent to the server as the typed text as-is
 *  (`decimalField` accepts a decimal string); `packageCount` is parsed to a real integer before
 *  it is ever sent (`commitPackageCount` below) since the server's schema is `z.number().int()`,
 *  not a decimal string. */
export type ShipperDetail = {
  id: string; shipperNumber: number; bolNumber: number | null;
  customerId: string; customerCode: string; customerName: string;
  customerCreditHold: boolean;
  shipToAddressId: string | null; shipDate: string;
  carrierId: string | null; carrierName: string | null; route: string; comments: string;
  billFreight: boolean;
  freightAmount: number | string | null;
  freightTerms: FreightTermsValue;
  freightClass: string; freightDescription: string;
  packageCount: number | string | null;
  proNumber: string; scacCode: string;
  /** Set when this shipment IS a reversal (§5.6) — with `reversesShipperNumber`, the #139 freeze
   *  banner/titles name the original it mirrors. */
  reversesShipperId: string | null;
  reversesShipperNumber: number | null;
  /** The LIVE reversal pointing at this shipment, if any (#65): its packing-list number. Void
   *  renders disabled naming it (§5.16); the server's `voidShipper` refusal is the enforcement.
   *  Always null on a reversal document itself, so a reversal's own Void stays enabled — voiding
   *  a reversal is the blessed undo. */
  reversedByShipperNumber: number | null;
  /** The §5.7 invoice freeze, pre-worded server-side with `voidShipper`'s own refusal sentence
   *  (Codex MR !141 review) — shown BEFORE the reversal blocker, the server's own guard order. */
  invoiceVoidBlock: string | null;
  /** Every finalized invoice on this shipment's orders, ascending by order number, `[]` when none
   *  (#472). `invoiceVoidBlock` above is the Void sentence for the first of them; the page's other
   *  freezes word themselves from this list. */
  invoicedOrders: InvoicedOrder[];
  deletedAt: string | null;
  orders: ShipperOrder[];
};

/** Every mutating shipment route — PATCH, add/remove order, the three per-order replaces — is
 *  wrapped through `shipperResponse` (src/app/api/shippers/response.ts) into this ONE shape, GET
 *  included. The order hub's edits answer the bare order with nothing beside it; a shipment's
 *  answer always carries the three fields beside `shipper`. `printed` (#472) is the orders that
 *  printed paper pins to this shipment, read after the mutation committed. It is beside
 *  `shipper`, not inside it. `shipToAddress` (#484) is the address `shipper.shipToAddressId`
 *  names, also read after the mutation committed, so it is a snapshot: its name, street, city,
 *  state and zip, with no id. It is null when the shipment names no address, or when no address
 *  is found under that id. */
export type ShipperMutationResult = { shipper: ShipperDetail; warnings: string[]; printed: PrintedOrders; shipToAddress: ShipToAddress | null };

/** The one prop every panel/grid takes to run a whole-shipment mutation and report its result —
 *  a THUNK, not a resolved response, so the mutation-ordering ticket is taken before the request
 *  goes out (the order hub `ApplyMutation` precedent, fix-wave R4 finding 6). */
export type ApplyMutation = (run: () => Promise<ShipperMutationResult>) => Promise<void>;

/** The order's OWN full line/container/serial catalog (`GET /api/orders/[id]`, fetched once per
 *  order on this shipment) — what each panel's "Add line/container/serial" picker offers, since
 *  `ShipperOrderDetail.lines`/`containers`/`serials` only carry what's already on THIS shipment.
 *  A line's `eachWeight` is its part's each weight in lb, null when the order read carried none. It
 *  is display data for the offered ship-now weight and enters no baseline comparison. A container's
 *  `tareEach` is the order row's tare each in lb, null when it has none. It is what a row takes
 *  when it is added, and it enters no baseline comparison either. */
export type OrderCatalogLine = { id: string; position: number; partNumber: string; partName: string; qty: number; weight: number; eachWeight: number | null };
export type OrderCatalogContainer = { id: string; typeName: string; customerContainerId: string; count: number; tareEach: number | null };
export type OrderCatalogSerial = { id: string; lineId: string; serial: string; description: string };
export type OrderCatalog = { lines: OrderCatalogLine[]; containers: OrderCatalogContainer[]; serials: OrderCatalogSerial[] };

/** Slice of `GET /api/customers/[id]`'s `CustomerRow` (src/server/customers.ts). */
type Customer = { id: string; code: string; name: string; shippingNotes: string; creditHold: boolean };
/** Slice of `GET /api/customers/[id]/addresses`'s `AddressRow` (src/server/customer-addresses.ts). */
type Address = { id: string; kind: string; name: string; street: string; city: string; state: string; zip: string };
type CarrierOption = { id: string; name: string };
/** Slice of `GET /api/orders`'s `BoardRow` (src/server/orders.ts) — the "Add order" candidates. */
type OrderOption = { id: string; orderNumber: number; poNumber: string };
// `entity` since #153 — see the order hub's identical note: the single-record audit read is a
// union, so a row in it is not necessarily the shipment's own.
type AuditEntry = { id: string; entity: string; action: string; reason: string | null };
/** Slice of `GET /api/shippers/[id]/documents`'s `DocumentMeta` (src/server/documents.ts). */
type StoredDoc = { id: string; kind: string; orderId: string | null; createdAt: string };

const DOC_KIND_LABELS: Record<string, string> = { SHIPPER: "Shipping ticket", BOL: "Bill of lading", CERT: "Certification" };

/** A voided shipment is read-only everywhere (spec §5.6, the P3 voided-order shape) regardless of
 *  what the permission grid would otherwise allow — the order hub `voidLocked` precedent. */
function voidLocked(g: Gate, voided: boolean): Gate {
  return voided ? { allowed: false, disabled: true, title: "Shipment is voided" } : g;
}

/** #139 freeze-the-pair (owner ruling 2026-08-18): while a reversal pair is live, every edit door
 *  is refused server-side (`claimLiveShipper`'s guard) — the controls say so up front (§5.16),
 *  carrying the server's own sentence as their title. Void and print stay on their own gates:
 *  voiding the reversal is the blessed undo, and a reprint/BOL on a reversed original must keep
 *  working. */
function pairLocked(g: Gate, freeze: string | null): Gate {
  return freeze !== null ? { allowed: false, disabled: true, title: freeze } : g;
}

/**
 * The Reverse gate (#161) — built from what refuses a REVERSAL, and deliberately NOT a clone of
 * `voidGate` below.
 *
 * **`invoiceVoidBlock` is NOT a rung here, and adding it would be a bug.** That block exists
 * because a finalized invoice freezes the shipment against a VOID (`voidShipper`'s
 * `refuseIfInvoiced`); a reversal is the correction for exactly that situation, and
 * `reverseShipper` (shippers.ts) carries no invoice guard at all — its own tests finalize an
 * invoice and then reverse, which is what writes `Order.status = REOPENED`. Cloning the Void
 * ladder would disable this control in the one case it exists for, and would look right in review
 * because it matches the button beside it.
 *
 * The rungs, in `reverseShipperInTx`'s OWN guard order, each carrying that guard's wording so the
 * title and the refusal cannot drift (§5.16 — disabled with the reason, never hidden):
 *   1. voided — step 3's `deletedAt` re-read 404s ("Shipment not found"); a voided shipment already
 *      contributes 0 to the ledger, so there is nothing to net down. This rung is also what keeps
 *      `e2e/flows/void-shipment.mjs`'s lock-every-control sweep green.
 *   2. this document IS a reversal — step 3's `reversesShipperId` refusal.
 *   3. already reversed — step 3b's at-most-one-live-reversal refusal (Codex MR !141 round 2).
 *   4. otherwise the route's own check, `mustDo(user, "void_shipper")` — the SAME special action as
 *      Void, and no `shipping.*` CRUD grant substitutes for it.
 *
 * The two remaining server refusals are data conditions no client can evaluate honestly — a voided
 * ORDER on the shipment, and the below-zero ledger guard — so they stay the server's to report
 * through the error banner rather than becoming a guessed-at disabled title.
 */
export function reverseGate(perms: string[] | undefined, shipper: ShipperDetail): Gate {
  if (shipper.deletedAt !== null) {
    return { allowed: false, disabled: true, title: "Shipment is voided" };
  }
  if (shipper.reversesShipperId !== null) {
    return { allowed: false, disabled: true,
      title: `This shipment is itself a reversal of Packing List ${shipper.reversesShipperNumber ?? "?"} — ` +
        "reverse the original shipment instead" };
  }
  if (shipper.reversedByShipperNumber !== null) {
    return { allowed: false, disabled: true,
      title: `This shipment has already been reversed by Packing List ${shipper.reversedByShipperNumber} — ` +
        "void that reversal first" };
  }
  return gateDo(perms, "void_shipper");
}

/** The Reverse control itself. Split out — the `OpenItemRow` precedent — so `reverseGate`'s ladder
 *  can be pinned all the way to the rendered `disabled` attribute by a `renderToStaticMarkup` test
 *  (tests/shipment-reverse-control.test.tsx) rather than only as a plain object. */
export function ReverseShipmentButton({ gate: g, busy, onClick }: {
  gate: Gate; busy: boolean; onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} disabled={g.disabled || busy} title={g.title}
            className="rounded border border-accent-600 px-3 py-1.5 text-sm text-accent-600">
      {busy ? "Reversing…" : "Reverse shipment"}
    </button>
  );
}

/** The amber line under the page heading that names the finalized invoice behind the freeze (#472,
 *  owner ruling 2026-10-08). A title cannot hold a link, so this is where the invoice is one click
 *  away. The link shows whether or not the viewer holds `invoicing.view`, as the customer link in
 *  the heading does. Split out, the `ReverseShipmentButton` precedent, so a `renderToStaticMarkup`
 *  test pins its words and its link (tests/shipment-invoice-notice.test.tsx). `invoiceNotice`
 *  (src/lib/shipment-gates.ts) decides when it shows. The sentence must not say the shipment cannot
 *  be changed: containers, serials and the rest of the header stay open. */
export function InvoiceFreezeNotice({ invoice }: { invoice: InvoicedOrder }) {
  return (
    <p className={`${NOTICE.warning} mb-3`}>
      <Link href={`/invoicing/${invoice.invoiceId}`} className="underline">{`Invoice ${invoice.orderNumber}`}</Link>
      {" is finalized — lines, added orders and billed freight on this shipment are frozen. " +
        "Unlock the invoice, raise a credit, or reverse this shipment."}
    </p>
  );
}

/** The stored-documents list (spec §11) — `GET /api/shippers/[id]/documents` (Task 14; no other
 *  caller existed for `listDocumentsForShipper` before this page needed one). Not printing itself
 *  (Tasks 18–19 own that); a plain link to the existing, already-gated `GET /api/documents/[id]`
 *  download route, the DocumentsSection.tsx precedent minus the print/blob plumbing this page has
 *  nothing to trigger yet. */
function ShipmentDocumentsList({ shipperId, viewGate, refresh, orders }: {
  shipperId: string; viewGate: Gate;
  orders: Pick<ShipperOrder, "orderId" | "label">[];
  /** Bumped by every successful print above, so a just-archived ticket appears without a page
   *  reload (Task 18 — printing became live on this page). */
  refresh: number;
}) {
  // The shared read and state (P6 step 3, #632): "Loading…" until a read lands, never the empty
  // sentence before then, and a read that lands clears an earlier failure.
  const { docs, error: err, status } = useStoredDocuments<StoredDoc>(`/api/shippers/${shipperId}/documents`, viewGate.allowed, refresh);

  if (status !== "rows") return <ListStatus status={status} denied={viewGate.title} error={err} empty="Nothing printed yet." />;
  return <ShipmentDocumentsTable docs={docs} orders={orders} />;
}

/** Archive rows are independently renderable so scope labels and download links stay covered. */
export function ShipmentDocumentsTable({ docs, orders }: {
  docs: StoredDoc[]; orders: Pick<ShipperOrder, "orderId" | "label">[];
}) {
  // Printed paper prevents removal of its covered orders (#140), so their existing labels
  // retain the printed sequence even after voiding. Legacy missing membership stays explicit.
  const orderLabels = new Map(orders.map((order) => [order.orderId, order.label]));
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-ink-500">
          <th className="py-1 font-medium">Type</th><th className="font-medium">Scope</th><th className="font-medium">Created</th>
          <th className="font-medium"><span className="sr-only">Open</span></th>
        </tr>
      </thead>
      <tbody>
        {docs.map((d) => (
          <tr key={d.id} className="border-t">
            {/* Type / Scope / Created and an "Open PDF" link column (owner 2026-10-31, #819). */}
            <td className="py-1">{DOC_KIND_LABELS[d.kind] ?? d.kind}</td>
            <td>{d.orderId === null ? "Whole shipment"
              : orderLabels.has(d.orderId) ? `Order ${orderLabels.get(d.orderId)}`
                : "One order (details unavailable)"}</td>
            <td className="text-ink-500">{formatDateTime(d.createdAt)}</td>
            <td className="text-right">
              <a href={`/api/documents/${d.id}`} target="_blank" rel="noreferrer" className={LINK}>Open PDF</a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The containers across a shipment's orders: the Package count a blank box shows and prints. */
function containerSumOf(orders: readonly { containers: readonly { count: number }[] }[]): number {
  return orders.reduce((sum, o) => sum + o.containers.reduce((s, c) => s + c.count, 0), 0);
}

export function ShipmentDetail({ id }: { id: string }) {
  const { permissions: perms, error: permsError } = usePermissions();
  const router = useRouter();
  const navigationLifetime = useRef<{ live: boolean; request?: object }>({ live: false });
  useEffect(() => {
    const token = { live: true };
    navigationLifetime.current = token;
    return () => { token.live = false; };
  }, [id]);

  const [shipper, setShipper] = useState<ShipperDetail | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  // R-Q2 (#472): which orders printed paper pins, as the shipment answers this page adopts
  // reported it. It only grows: a stored document is never deleted and its coverage is never
  // rewritten. So each of those answers is MERGED in (`mergePrinted`) and none replaces it, and a
  // late answer that knows less can never re-open a Remove order button. Three answers feed it:
  // the page's `load`, each mutation's answer (`applyMutation`) and the read after a print
  // (`printDoc`). The grids' own recovery reads of the shipment (`recoverySource` below) keep
  // `.shipper` only and do not feed it.
  const [printedOrders, setPrintedOrders] = useState<PrintedOrders>(NOTHING_PRINTED);
  // #484: the ship-to address the newest adopted answer carries. It is ASSIGNED, never merged,
  // unlike `printedOrders`, which only grows: it is the server's current value. It is set from
  // `load` and `applyMutation` only, in the same accept branch as `shipper`. The read after a print
  // (`printDoc`) and the grids' recovery reads (`recoverySource`) keep their reads as they are and
  // do not set it. The Ship-to select is not registered with `editGuard.onFocusField`, so
  // `applyPayload` always applies the answer's `shipToAddressId`: each adopted answer sets the id
  // and this address together. Between a Ship-to change and its answer, `patchHeader` has already
  // set the new id on screen while this still holds the previous answer's address, which is why
  // `shipToChoice` keys on the id.
  const [shipToAddress, setShipToAddress] = useState<ShipToAddress | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Initial reads can settle after an editor has already triggered a local refusal. Their
  // success/failure must not clear or replace the action banner (including StrictMode replays).
  const [initialLoadError, setInitialLoadError] = useState<string | null>(null);
  // Supplementary fetches (customer, addresses, carriers, add-order candidates, per-order
  // catalogs, void reason) each get their OWN banner rather than the shared `error` a later
  // mutation clears — the order hub `loadError` precedent: a save elsewhere on the page must not
  // silently erase the report that one of these failed.
  const [loadError, setLoadError] = useState<string | null>(null);
  const addLoadError = useCallback((message: string) => {
    setLoadError((cur) => (cur ? `${cur} ${message}` : message));
  }, []);

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [carriers, setCarriers] = useState<CarrierOption[]>([]);
  const [addableOrders, setAddableOrders] = useState<OrderOption[]>([]);
  // What the candidates read below last did. The select reads it through `addOrderSelect`, so it
  // says there is nothing to add only after a read that offered nothing (#472).
  const [addableState, setAddableState] = useState<AddableState>("loading");
  const [addOrderChoice, setAddOrderChoice] = useState("");
  const [addingOrder, setAddingOrder] = useState(false);
  const [creditHoldReason, setCreditHoldReason] = useState("");
  // undefined = fetched but no reason could be resolved (missing admin.view, the fetch failed, or
  // the latest entry wasn't a delete) — the order hub `voidReason` precedent. null = not
  // applicable (shipment isn't voided).
  const [voidReason, setVoidReason] = useState<string | null | undefined>(null);

  // ONE monotonic ticket sequence shared by every write on this page and by `load`'s own full
  // refresh — the order hub `mutations` precedent (fix-wave R4 finding 6): every action here
  // replaces the whole `shipper` state, so overlapping calls race and the ticket ensures the
  // winner is whichever call is genuinely newest, not whichever happens to answer last. A read the
  // server served before a write still out had committed holds the newer ticket, so it either
  // reverts that write on screen or has the write's answer dropped: that is why `load` reads once
  // more after the writes it overlapped (#573, `writes` below).
  const mutations = useMutationGate();
  // #573 (owner ruling 2026-10-20, the hub's #550 "read now, re-read after"): this page's writes in
  // flight, one request-settled signal per `applyMutation` dispatch, each deleted when its request
  // settles (`makeWriteSignals`, drain-queue.ts), which `load` snapshots as it reads. One registry
  // per mount, built once the way `useMutationGate` builds the gate above: one built per render
  // would start empty on every render, forgetting the writes still out, and would change the
  // identity of `applyMutation` and `load` with it, and through the mount effect re-run the read on
  // every render. A residual: a mount starts with an empty registry, so a write an earlier mount of
  // the same shipment sent and still out (the shipment left and opened again within one round trip;
  // page.tsx remounts on `key={id}`) is not in it. Nothing aborts that write on unmount, its answer
  // reaches only the unmounted instance, and no read of this mount is followed for it.
  const [writes] = useState(makeWriteSignals);
  const recoverySource = useMemo(() => createBulkRecoverySource(
    async () => (await api<ShipperMutationResult>(`/api/shippers/${id}`)).shipper, readBulkPermissions,
  ), [id]);
  // Every set-from-server-detail below routes through `editGuard.applyPayload` so an arriving detail —
  // another header field's PATCH response, a grid save, or §5.13's rollback `load()` — never
  // resets the header text field the user is actively typing in (use-edit-guard.ts; the fix-wave
  // notes-clobber trio, of which CertDetail.tsx and customers/[id]/page.tsx carry the same shape).
  const editGuard = useEditGuard();
  const savedMarks = useSavedMarks();
  // The server's last adopted Package count (#653), noted beside each `applyPayload` adoption and
  // read in `commitPackageCount`'s handler when it refuses a value: the guard's `atFocus` is the
  // box's TEXT, which for a null count is the container sum, and restoring that would turn a
  // tracking null into a literal that stops following the container rows (weights design).
  const storedPackageCount = useRef<number | string | null>(null);

  const load = useCallback(async () => {
    // #573 (owner ruling 2026-10-20, the hub's #550 "read now, re-read after"): the GET goes out at
    // once, as before. A write of this page that was out as it was sent (the header PATCH, an order
    // panel's Lines, Containers or Serials save, Add order, Remove order: everything `applyMutation`
    // registers) may commit after the server served it, and then the payload predates that write:
    // applied after the write's answer it reverts the write on screen, and applied before it the
    // answer, older-ticketed, is dropped. So when the snapshot below holds a write, the page reads
    // once more after every write in it has settled, whether or not one was still out when this read
    // landed, and whether or not this read was accepted. Detached: `load` resolves with this read,
    // and its caller (the mount effect, `patchHeader`'s rollback read, Void's read, the #581
    // cancelled-departure re-read) follows it without waiting on a write (#276: `api()` has no
    // timeout). The follow-up is this same read, applying the same four states under its own ticket
    // and its own `begin()` taken as it is sent, so it is followed in turn when a write sent since
    // was out as it went; the chain ends at the first read sent with no write out. A read that fails
    // applied nothing and is followed by nothing. A follow-up that fails marks the bulk grids'
    // recovery read unavailable in the catch below, as every failed read of the shipment does
    // (every grid of every order panel reads "This editor is unavailable.", with no banner), shows
    // no message and is not retried: the page keeps what it shows until the next payload or a reload.
    const readShipper = async (): Promise<ShipperDetail> => {
      const ticket = mutations.next();
      const recoveryRead = recoverySource.begin();
      // The writes out as this GET is sent. One sent after it holds a newer ticket, so the gate
      // already orders its answer against this read, and it is not waited for.
      const writesOut = writes.outstanding();
      let res: ShipperMutationResult;
      try { res = await api<ShipperMutationResult>(`/api/shippers/${id}`); }
      catch (error) { recoveryRead.unavailable(); throw error; }
      // Captured-session apply inside the accept branch (use-edit-guard.ts, the round-3 fixpoint).
      if (mutations.accept(ticket)) {
        void recoveryRead.accept(res.shipper);
        setShipper(editGuard.applyPayload(res.shipper));
        storedPackageCount.current = res.shipper.packageCount;
        setWarnings(res.warnings);
        setPrintedOrders((seen) => mergePrinted(seen, res.printed));
        setShipToAddress(res.shipToAddress);
      }
      reReadAfter(writesOut, () => { void readShipper().catch(() => {}); });
      return res.shipper;
    };
    return readShipper();
  }, [id, mutations, editGuard, recoverySource, writes]);
  useEffect(() => {
    let active = true;
    load().then(() => { if (active) setInitialLoadError(null); })
      .catch((e) => { if (active) setInitialLoadError((e as Error).message); });
    return () => { active = false; };
  }, [load]);

  const applyMutation = useCallback(async (run: () => Promise<ShipperMutationResult>) => {
    const ticket = mutations.next();
    const recoveryRead = recoverySource.begin();
    let res: ShipperMutationResult;
    try {
      const request = run();
      // #573 (owner ruling 2026-10-20): registered at dispatch, in the same synchronous run as the
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
      // History is told here as the success path below tells it (#158), and reads its own list.
      // Nothing is applied and the shipment itself is not read again (no `load`); the rejection still
      // reaches the caller, and the write's registry entry is deleted as its request settles, so a
      // `load` sent beside it reads once more after it (#573). As of 6e42469 every thunk run through
      // here sends one write and no read (a census, not a guarantee).
      if (error instanceof UnreadableAnswerError) invalidateHistory();
      throw error;
    }
    // #158 — success path, the instant the mutation resolves and BEFORE the accept gate: the
    // server state has certainly changed even when this response is superseded and its payload
    // dropped. This one seam covers the header PATCH, Add order and Remove order here AND every
    // write `ShipmentOrderPanel` makes through the same callback — all of them the shipper's own
    // before/after diff, which is what the panel at the bottom of this page renders.
    invalidateHistory();
    if (!mutations.accept(ticket)) return;
    void recoveryRead.accept(res.shipper);
    setShipper(editGuard.applyPayload(res.shipper));
    storedPackageCount.current = res.shipper.packageCount;
    setWarnings(res.warnings);
    setPrintedOrders((seen) => mergePrinted(seen, res.printed));
    setShipToAddress(res.shipToAddress);
  }, [mutations, editGuard, recoverySource, writes]);

  // What each order panel's Lines and Containers grids last handed up for the totals tables (the
  // weights design §12.2), by shipper order id: their rows as typed, and whether the grid has
  // unsaved edits. Display only: tests/shipment-totals-wiring.test.ts counts every reader of
  // `reports` and of `totals`, and no gate, save or print is among them.
  const [reports, setReports] = useState<ShipmentReports>(NO_REPORTS);
  // No dependency, so it is one function for as long as the page is mounted. Each grid's effect
  // depends on it (`useTotalsReport`): a function that changed when the reports change would run
  // every grid's effect again, which changes the reports again.
  const onTotalsReport = useCallback((orderKey: string, report: TotalsReport) => {
    setReports((held) => withReport(held, orderKey, report));
  }, []);

  const customersGate = gate(perms, "customers.view");
  const ordersGate = gate(perms, "orders.view");
  const auditGate = gate(perms, "admin.view");
  const docsGate = gate(perms, "shipping.view");
  const voided = (shipper?.deletedAt ?? null) !== null;
  // #182 / Codex MR !141: on an original carrying a live reversal, the §5.7 invoice freeze OUTRANKS
  // the #65 reversal blocker — `voidShipper` runs `refuseIfInvoiced` before the reversal guard, so on
  // an invoiced pair "void the reversal first" names a step the server ALSO refuses. The first
  // obstacle is therefore the invoice sentence (unlock / raise a credit) when the pair is invoiced,
  // and the reversal step otherwise. Encoded ONCE here and consumed by BOTH the edit-freeze banner
  // and the Void button below, so the two surfaces cannot drift (which is exactly #182); each passes
  // the reversal-step phrasing it wants.
  const reversedOriginalObstacle = (reversalStep: string): string =>
    shipper?.invoiceVoidBlock ?? reversalStep;
  // #139: the pair freeze, worded exactly as `claimLiveShipper`'s refusals so title and server
  // sentence cannot drift. The reversal side freezes whenever `reversesShipperId` is set (the server
  // refuses ALWAYS — mirror paper); the original's side follows `reversedByShipperNumber`, which is
  // live-filtered, so a void + reload clears the freeze for free — and (since #182) it leads with the
  // invoice sentence on an invoiced pair, deferring to `reversedOriginalObstacle` above.
  const pairFreeze = shipper === null ? null
    : shipper.reversesShipperId !== null
      ? `This is a reversal of Packing List ${shipper.reversesShipperNumber ?? "?"} — a reversal is machine-generated mirror paper; void it and re-reverse instead of editing it`
      : shipper.reversedByShipperNumber !== null
        ? reversedOriginalObstacle(`This shipment has been reversed by Packing List ${shipper.reversedByShipperNumber} — void the reversal first, then edit, then re-reverse`)
        : null;
  const editGate = voidLocked(pairLocked(gate(perms, "shipping.edit"), pairFreeze), voided);
  // §5.4 extended to shipment extension (owner ruling 2026-08-06): adding orders and replacing
  // lines on a HELD customer's shipment needs override_credit_hold + a reason. NewShipment's own
  // shape — a disabled control says why, an allowed override renders the reason field.
  const overrideGate = gateDo(perms, "override_credit_hold");
  const held = shipper?.customerCreditHold ?? false;
  const extendGate: Gate = held && editGate.allowed && !overrideGate.allowed
    ? { allowed: false, disabled: true,
        title: `${shipper?.customerCode} · ${shipper?.customerName} is on credit hold — adding orders or changing lines requires the override_credit_hold action` }
    : editGate;
  // #472: a finalized invoice on any order of this shipment freezes its lines, added orders and
  // billed freight (`replaceShipperLines`, `addOrderToShipper`, and `updateShipper` for the two
  // billed fields). The controls say so up front, with the server's own sentence. The rung is the
  // last one on each gate, which is the server's order: a gate that is already closed keeps its
  // reason. What an invoice does not freeze stays on `editGate`, and Reverse takes no invoice rung
  // (`reverseGate`, above). Built here, above the null return, where `shipper` can still be null.
  const linesAddGate: Gate = shipmentLinesGate(extendGate, shipper?.invoicedOrders ?? []);
  const freightGate: Gate = shipmentFreightGate(editGate, shipper?.invoicedOrders ?? []);
  // The blank override reason closes Add order and every panel's Save lines with one gate and one
  // sentence (#472). It wraps the lines gate, so it comes after the invoice rung: on an invoiced
  // shipment a typed reason would not help. The Lines grid's boxes stay on `linesAddGate`.
  const reasonGate: Gate = reasonRequiredGate(linesAddGate, held && overrideGate.allowed, creditHoldReason);
  const addSelect = addOrderSelect({ gate: linesAddGate, ordersGate, state: addableState, count: addableOrders.length });
  // #65: an original with a live reversal cannot void (the server refuses, naming the reversal) —
  // the button says so up front (§5.16, disabled with the blocker as its title, never hidden). A
  // reversal document's own `reversedByShipperNumber` is always null, so its Void stays enabled:
  // voiding a reversal is the blessed undo. PRECEDENCE (Codex MR !141 review): on a reversed original
  // the §5.7 invoice freeze wins — `reversedOriginalObstacle` above returns the invoice sentence
  // (unlock / raise a credit) when the pair is invoiced, mirroring `voidShipper`'s own guard order
  // (`refuseIfInvoiced` before the reversal blocker). That one helper is shared with the edit-freeze
  // banner (#182), so the two can never disagree. A non-reversed invoiced shipment still gets the
  // bare invoice sentence from the arm below.
  const voidGate = voided
    ? { allowed: false, disabled: true, title: "Already voided" }
    : shipper != null && shipper.reversedByShipperNumber !== null
      ? { allowed: false, disabled: true,
          title: reversedOriginalObstacle(`This shipment has been reversed by Packing List ${shipper.reversedByShipperNumber} — void the reversal first`) }
      : shipper != null && shipper.invoiceVoidBlock !== null
        ? { allowed: false, disabled: true, title: shipper.invoiceVoidBlock }
        : gateDo(perms, "void_shipper");
  // #161: the Reverse control's own ladder — see `reverseGate` above for why it is NOT `voidGate`
  // with a different label (the §5.7 invoice block is deliberately absent).
  //
  // The null arm is unreachable — the component early-returns below before anything renders this —
  // and is kept only to satisfy `reverseGate`'s non-null parameter at a point where the compiler
  // cannot see that. `voidGate` handles the same condition with inline `shipper != null` guards
  // instead; two shapes for one condition, noted rather than unified because collapsing them means
  // touching the Void ladder, which is not this task's to move (review Minor 2).
  const reverseControlGate = shipper === null
    ? { allowed: false, disabled: true, title: undefined }
    : reverseGate(perms, shipper);
  const [reversing, setReversing] = useState(false);

  // Ticket printing (Task 18; spec §9's POST /api/shippers/[id]/print). Gated shipping.view like
  // the route; a voided shipment refuses NEW prints while stored ones stay downloadable (§5.6), so
  // the button says exactly that (§5.16 — disabled with a truthful title, never hidden). The
  // DocumentsSection.tsx print shape, minus the auto-print machinery this page has no entry for.
  // Unsaved line/container/serial grids block the ticket and BOL prints (Codex P1, round 6). Those
  // callbacks generate and ARCHIVE paperwork from server state and send no local overlay, so an
  // operator could permanently file a packing list or bill of lading carrying the pre-edit
  // quantities, containers or serials while the screen shows the edited ones. Same refusal as the
  // invoice and the certification: a discarded edit can be retyped, filed paper cannot be unfiled.
  const unsavedGrids = useUnsavedPresent();
  const printGate: Gate = voided
    ? { allowed: false, disabled: true, title: "Shipment is voided — stored prints stay available" }
    : unsavedGrids
      ? { allowed: false, disabled: true, title: "Save the grid changes first — a print archives what the server holds" }
      : docsGate;
  // The cert checkbox (§3.14) needs certs.view on top: the archived paper is certs-area paper
  // (the route enforces the same pair), so the §5.16 tooltip names the missing permission and the
  // box unchecks itself rather than sending a request that can only 403.
  const certsGate = gate(perms, "certs.view");
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  // The bundled certs' archived document ids (x-cert-document-ids) — surfaced as DIRECT links:
  // the Documents list below filters on shipperId and a CERT document carries only certId, so
  // "open them from Documents below" would point at a list that can never show them.
  const [certDocIds, setCertDocIds] = useState<string[]>([]);
  // §9 amendment 2026-08-05: a cert-requiring covered order with no cert prints its tickets and
  // WARNS — the route carries the named warnings in x-print-warnings (URI-encoded JSON, since the
  // body is PDF bytes) and this page surfaces them beside the print bar.
  const [printWarnings, setPrintWarnings] = useState<string[]>([]);
  const [docsRefresh, setDocsRefresh] = useState(0);
  const [withCerts, setWithCerts] = useState(true);   // pre-ticked (§3.14)

  /** Shared print pipeline for every document this page can produce. `query` names the doc.
   *
   *  Every caller is a click (the ticket, an order's ticket, the bill of lading), so the tab opens
   *  here, before the first await, still inside the click (#692): a browser opens a tab for a page
   *  only shortly after a click, and a whole-shipment ticket has a 15-second budget (#556). The tab
   *  shows the stored copy once the print lands (`/api/documents/<x-document-id>`, the invoice
   *  page's #588 form), and a refused or failed print closes it. */
  const printDoc = useCallback(async (query: string, label: string) => {
    const tab = openPendingTab(window);
    let shown = false;
    setPrinting(true);
    setPrintError(null);
    setCertDocIds([]);
    setPrintWarnings([]);
    try {
      const res = await trackedFetch(`/api/shippers/${id}/print?${query}`, { method: "POST" });
      if (!res.ok) {
        tab.close();
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Print failed (${res.status})`);
      }
      // #158 — success path, the instant the print resolves. The FIRST BOL print allocates
      // `bolNumber` through `auditedUpdate("shipper", …)` (shippers.ts `printBol`); a reprint
      // writes no shipper row, and an invalidation that finds nothing new is one gated GET.
      invalidateHistory();
      // The tab shows the stored copy, so the body is not read. A body that failed in transit
      // rejects its cancel; nothing waits on it.
      void res.body?.cancel().catch(() => {});
      const documentId = res.headers.get("x-document-id");
      if (documentId) { tab.show(`/api/documents/${documentId}`); shown = true; } else tab.close();
      if (tab.blocked || !documentId) {
        // Never silent (the DocumentsSection rule): the print HAPPENED and is archived — the
        // refreshed Documents list below is the escape hatch, and this message says so.
        setPrintError(`The browser blocked the print window — the ${label} was archived and is in Documents below.`);
      }
      // The certs print as their own archived documents (§3.14); a browser allows one popup per
      // click, so they are surfaced as direct links beside the print bar rather than a volley of
      // blocked tabs.
      const certDocs = res.headers.get("x-cert-document-ids");
      setCertDocIds(certDocs === null ? [] : certDocs.split(","));
      const warned = res.headers.get("x-print-warnings");
      if (warned !== null) {
        try {
          setPrintWarnings(JSON.parse(decodeURIComponent(warned)) as string[]);
        } catch {
          // A malformed header must not hide that something warned (never a silent drop).
          setPrintWarnings(["The print reported a warning that could not be read — check the shipment's certifications."]);
        }
      }
      setDocsRefresh((n) => n + 1);
      // R-Q2 (#472): this print may have pinned its orders, so read what has printed once more and
      // merge it. Remove order then greys without a reload. The read is detached and merged only
      // (design 2026-10-08 §3.3): it takes no mutation ticket and replaces nothing, so it cannot
      // drop a save sent during the print, and the BOL number in the heading stays as stale as it
      // was. A failure shows nothing: the server still refuses the removal.
      void api<ShipperMutationResult>(`/api/shippers/${id}`)
        .then((res) => setPrintedOrders((seen) => mergePrinted(seen, res.printed)))
        .catch(() => {});
    } catch (e) {
      if (!shown) tab.close();
      setPrintError((e as Error).message);
    } finally {
      setPrinting(false);
    }
  }, [id]);

  const printTicket = useCallback((orderId: string | undefined, certWanted: boolean) => {
    const query = `doc=ticket${orderId === undefined ? "" : `&order=${orderId}`}${certWanted ? "&cert=1" : ""}`;
    return printDoc(query, "ticket");
  }, [printDoc]);
  const printBol = useCallback(() => printDoc("doc=bol", "bill of lading"), [printDoc]);

  const customerId = shipper?.customerId;

  // Customer (shippingNotes banner, credit-hold banner, the customer link).
  useEffect(() => {
    if (!customerId || !customersGate.allowed) return;
    api<Customer>(`/api/customers/${customerId}`).then(setCustomer)
      .catch((e) => addLoadError(`Could not load the customer: ${(e as Error).message}`));
  }, [customerId, customersGate.allowed, addLoadError]);

  // Ship-to selector — that customer's live SHIP_TO addresses (task-14-brief.md). `listAddresses`
  // already filters to active-only when includeInactive is omitted (customer-addresses.ts), so
  // the kind filter here is the only narrowing this page needs to do itself. When the list lacks
  // the shipment's set id, for any reason (among them no customers.view, a failed read, an address
  // since made inactive or deleted or no longer Ship to, or an id a later load brings in after the
  // list was read), the select offers the set address from the answer (`shipToChoice`, #484).
  useEffect(() => {
    if (!customerId || !customersGate.allowed) return;
    api<Address[]>(`/api/customers/${customerId}/addresses`)
      .then((rows) => setAddresses(rows.filter((a) => a.kind === "SHIP_TO")))
      .catch((e) => addLoadError(`Could not load ship-to addresses: ${(e as Error).message}`));
  }, [customerId, customersGate.allowed, addLoadError]);

  // Carrier picker — session-only pick-list (no permission beyond signed-in), the order hub
  // `containerTypes` precedent.
  useEffect(() => {
    api<CarrierOption[]>("/api/picklists/carrier").then(setCarriers)
      .catch((e) => addLoadError(`Could not load carriers: ${(e as Error).message}`));
  }, [addLoadError]);

  // Add-order candidates: this customer's own orders not yet fully shipped (OPEN/PARTIAL_SHIPPED
  // — voided and SHIPPED orders are excluded by construction), minus whatever is already on this
  // shipment. `GET /api/orders` excludes voided orders unless includeVoided=1 is passed (orders.ts
  // `boardWhere`), so nothing extra is needed here for that half.
  const onShipmentOrderIds = shipper ? shipper.orders.map((o) => o.orderId).join(",") : "";
  // §5.13 stale-gate, the NewShipment #51 `candidatesLatest` shape, both paths (F7): re-runs on
  // every add/remove order, so a slow earlier response must not clobber a newer order-set's list.
  const addableLatest = useLatest();
  useEffect(() => {
    const t = addableLatest.next();
    if (!customerId || !ordersGate.allowed) return;
    // Loading again on every re-read (#472): the list held from before an order was added still
    // names that order, and a list that was empty before an order was removed would say there is
    // nothing to add while the removed order is on its way back into it.
    setAddableState("loading");
    api<OrderOption[]>(`/api/orders?customerId=${customerId}&status=OPEN,PARTIAL_SHIPPED`)
      .then((rows) => {
        if (!addableLatest.isCurrent(t)) return;
        const already = new Set(onShipmentOrderIds ? onShipmentOrderIds.split(",") : []);
        setAddableOrders(rows.filter((r) => !already.has(r.id)));
        setAddableState("ready");
      })
      .catch((e) => {
        if (!addableLatest.isCurrent(t)) return;
        setAddableState("failed");
        addLoadError(`Could not load orders available to add: ${(e as Error).message}`);
      });
  }, [customerId, ordersGate.allowed, onShipmentOrderIds, addableLatest, addLoadError]);

  // Catalog readiness belongs to each recovery read. The source re-fetches all
  // relevant catalogs even when the parent order-ID set is unchanged.

  // Voided banner's reason (order hub `voidReason` precedent) — safe to key on `voided` alone:
  // once voided, no mutator can touch the shipment again, so the delete entry is the shipment's
  // own newest. Since #153 this read is a capped union over the parent's child sections, so it is
  // found by `entity`, not by position — see the order hub's fuller note on both points.
  useEffect(() => {
    if (!voided) { setVoidReason(null); return; }
    if (!auditGate.allowed) { setVoidReason(undefined); return; }
    api<{ rows: AuditEntry[]; hasMore: boolean }>(`/api/admin/audit?entity=shipper&entityId=${id}`)
      .then(({ rows }) => {
        const latest = rows.find((e) => e.entity === "shipper");
        setVoidReason(latest?.action === "delete" ? (latest.reason ?? undefined) : undefined);
      })
      .catch(() => setVoidReason(undefined));
  }, [voided, auditGate.allowed, id]);

  // ---- Header: optimistic scalar PATCH (customers/[id]/page.tsx `save()` / order hub `saveOrder()` precedent) ----

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

  type HeaderPatch = {
    shipToAddressId?: string | null; shipDate?: string; carrierId?: string | null;
    route?: string; comments?: string; billFreight?: boolean;
    freightAmount?: number | string | null; freightTerms?: FreightTermsValue;
    freightClass?: string; freightDescription?: string; packageCount?: number | null;
    proNumber?: string; scacCode?: string;
  };

  // A keystroke into a guarded detail object types through this pure updater, never an object
  // built from the render's copy, so a server payload landing beside the keystroke is kept (#574).
  function patchDraft(patch: Partial<ShipperDetail>) {
    setShipper((cur) => (cur ? { ...cur, ...patch } : cur));
  }

  /** Optimistic: the field shows the typed/chosen value immediately; a rejection rolls back to
   *  server truth FIRST and only then reports why (§5.13), so the refusal is shown alongside
   *  the restored field values. */
  async function patchHeader(patch: HeaderPatch): Promise<boolean> {
    setShipper((cur) => (cur ? { ...cur, ...patch } : cur));
    // A multi-field patch's composite key would NOT serialize against its constituent
    // single-field keys — latent only: every caller PATCHes one field per save.
    const key = Object.keys(patch).sort().join(",");
    return serial(key, async () => {
      try {
        const req = applyMutation(() => api<ShipperMutationResult>(
          `/api/shippers/${id}`, { method: "PATCH", body: JSON.stringify(patch) }));
        inFlight.current.set(key, req.then(() => {}, () => {})); // request-settled signal, at dispatch
        await req;
        setError(null);
        // The one Saved mark (R7): each field this save carried reads Saved while its box shows it.
        for (const [field, value] of Object.entries(patch)) {
          savedMarks.mark(field, String(value ?? ""), { decimal: field === "freightAmount" });
        }
        return true;
      } catch (e) {
        // §5.13 rollback-drain (Task 7): wait out every OTHER key's in-flight request before
        // the rollback GET — served before a sibling key's PATCH commits, the newest-ticket GET
        // would revert that sibling's committed write on screen (its own response then drops as
        // older-ticketed). Drains the request-settled SIGNALS above, never the queue tails
        // (fix round 1 — mutual deadlock; drain-queue.ts carries the full story). The rollback
        // read is `load`, which re-reads after any registered write that was out as it was sent
        // (#573): a drained sibling's registry entry is gone before the GET snapshots it, so the
        // drain keeps only its timing effect, and the writes it never saw (the panels' grid saves,
        // Add order, Remove order) are what the follow-up covers.
        await drainOtherKeys(inFlight.current, key);
        await load().catch(() => {});
        setError((e as Error).message);
        return false;
      }
    });
  }

  // Blur-save guard and focused-field tracking are both `editGuard`'s (use-edit-guard.ts): the
  // no-op guard is unchanged, and the focus handler now also names which header field is under
  // the cursor so `merge` above can preserve it.
  // A Freight amount the one rule refuses goes back to the figure the box was given (`atFocus`,
  // the guard's newest snapshot: the stored figure) and is named in the banner; nothing is sent,
  // so `patchHeader`'s optimistic write and its rollback read never run (owner answer 4). A blank
  // is no refusal: it still clears the freight.
  function commitFreightAmount(value: string, atFocus: string) {
    const refusal = decimalRefusal(FREIGHT_AMOUNT.label, value, FREIGHT_AMOUNT.box);
    if (refusal !== null) {
      setShipper((cur) => (cur ? { ...cur, freightAmount: atFocus } : cur));
      setError(refusal);
      return false; // the box is back on a value it was given (the guard's Enter contract)
    }
    const trimmed = value.trim();
    void patchHeader({ freightAmount: trimmed === "" ? null : trimmed });
    return trimmed; // the box shows the trimmed figure (the text the guard's Enter learns)
  }
  // A Package count the rule refuses goes back to the STORED count (#653), never the guard's
  // `atFocus` (see `storedPackageCount`), and is named in the banner; nothing is sent, so a null
  // stays null and the box shows the container sum again. The ref is read here, in the handler:
  // React runs the updater later and may replay it. A blank is no refusal: it clears the count.
  function commitPackageCount(value: string) {
    const trimmed = value.trim();
    // A blank clears the override, and the box then shows the container sum: that is the text the
    // guard's Enter learns, or leaving the box would store the sum as an override (#811, Codex).
    if (trimmed === "") {
      void patchHeader({ packageCount: null });
      return shipper ? String(containerSumOf(shipper.orders)) : "";
    }
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 0) {
      const stored = storedPackageCount.current;
      setShipper((cur) => (cur ? { ...cur, packageCount: stored } : cur));
      setError("Package count must be a whole number of at least 0.");
      return false; // the box is back on a value it was given (the guard's Enter contract)
    }
    void patchHeader({ packageCount: n });
    return String(n); // the box shows the number ("2" for "002")
  }

  // ---- Add order / Remove order / Void: non-optimistic (order hub `linkAction`/`voidAction` precedent) ----

  async function addOrder() {
    if (!addOrderChoice) return;
    setAddingOrder(true);
    try {
      await applyMutation(() => api<ShipperMutationResult>(
        `/api/shippers/${id}/orders`, { method: "POST", body: JSON.stringify({
          orderId: addOrderChoice,
          ...(held && overrideGate.allowed && creditHoldReason.trim() ? { creditHoldReason: creditHoldReason.trim() } : {}),
        }) }));
      setAddOrderChoice("");
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAddingOrder(false);
    }
  }

  // `report` is where this removal's own messages go. An order panel passes its heading's setter
  // (issue #472: a panel's refusals show in that panel). With none passed it is the page banner,
  // which is how tests/shipment-order-retained-scope.test.ts runs this function.
  async function removeOrder(shipperOrderId: string, label: string, report: (message: string | null) => void = setError) {
    // #294. `removeOrderFromShipper` deleteMany's this order's shipperLine, shipperContainer and
    // shipperSerial rows — precisely the three grids this order's panel is holding — so it REPLACES
    // server rows an editor owns and must refuse rather than warn. The confirm below already NAMED
    // the loss, which made this the harder gap to see: it reads well and consults nothing, so it
    // could not say that some of what it drops was never saved, and could not decline.
    //
    // SCOPED to this order's panel. A page-wide `useUnsavedPresent()` would refuse removing order A
    // because order B's grid is dirty, and this page already over-refuses that way for the prints
    // (`printGate`, above, is page-wide by design: a print archives what the SERVER holds, so any
    // unsaved editor can make the paper disagree with the screen). Reusing that binding here would
    // also recreate the one-answer-many-gates shape #294 was filed about.
    // #309 supplies Save/Discard on each of these grids. Clearing this panel's drafts leaves
    // other orders' drafts alone, so a page reload is no longer the route out.
    const panelUnsaved = unsavedPresentInScope(shipmentOrderScope(shipperOrderId))
      || (getBrowserDraftSession()?.store.hasScope(`/shipping/${id}`, shipmentOrderScope(shipperOrderId)) ?? false);
    if (panelUnsaved) {
      report(`Order ${label} has unsaved lines, containers or serials on this shipment. Removing ` +
        `it drops those rows, so save them first — or use Discard beside each unsaved grid's Save button.`);
      return;
    }
    const ok = await askConfirm({
      title: `Remove order ${label} from this shipment?`,
      body: "Its lines, containers and serials on this shipment are dropped.",
      confirm: "Remove order", danger: true,
    });
    if (!ok) return;
    try {
      await applyMutation(() => api<ShipperMutationResult>(
        `/api/shippers/${id}/orders/${shipperOrderId}`, { method: "DELETE" }));
      report(null);
    } catch (e) {
      report((e as Error).message);
    }
  }

  async function voidAction() {
    if (!shipper) return;
    // Through the modal (ruling 5 of 2026-10-30; PR 4): it holds the dialog open on a blank reason
    // with the server's own sentence and resolves null on Cancel.
    const reason = await askReason({
      question: `Void shipment (Packing list #${shipper.shipperNumber})?\n\n` +
        "Every control on this shipment becomes read-only; its stored documents stay reprintable " +
        "forever. The shipment's own number and every order's shipment sequence are never reused, " +
        "and this cannot be undone through the UI.",
      verb: "voiding", blankRefusal: "A reason is required to void a shipment.",
    });
    if (reason === null) return; // cancelled
    // The void is what was answered, so it is sent whatever happened to the page meanwhile; the
    // setError and load that follow are no-ops on an unmounted component.
    // Two separate try/catches (the order hub `voidAction` precedent): DELETE returns
    // `{ ok: true }`, not a fresh ShipperDetail, so picking up deletedAt needs a follow-up
    // `load()` — and if THAT fails, the void itself still succeeded.
    try {
      await api(`/api/shippers/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
    } catch (e) {
      // #547 (owner ruling 2026-10-18): a 2xx proves the void committed, and its answer holds only
      // `{ ok: true }`, so an answer that could not be read falls through to the success path below.
      // Any other failure shows its message and stops.
      if (!(e instanceof UnreadableAnswerError)) {
        setError((e as Error).message);
        return;
      }
    }
    // #158 — success path, before the follow-up load. The void is an `auditedSoftDelete("shipper", …)`
    // carrying the typed reason, and this page stays mounted (read-only) to show it.
    invalidateHistory();
    setError(null);
    try {
      await load();
    } catch (e) {
      setError(`Shipment voided, but the page could not be refreshed — reload to see the current state. (${(e as Error).message})`);
    }
  }

  /**
   * Reverse (#161; spec §5.2/§5.6). Non-optimistic and NOT `applyMutation`'s shape: the response is
   * a DIFFERENT document — the newly created reversal — so folding it into this page's `shipper`
   * state would leave the reversal's detail rendered under the original's URL. Navigate to it
   * instead, exactly as NewShipment does after a save; `page.tsx`'s `key={id}` remounts, and the
   * reversal's own GET recomputes the same §5.7 warning array through `shipperResponse` (the GET is
   * wrapped too), so nothing is raced past by the navigate.
   *
   * A request that finishes after its departure attempt was cancelled (a keystroke in the search
   * box, a cancelled leave prompt, Back) while still this page's own re-reads instead (#581, owner
   * ruling 2026-10-19, the #568 hub shape): on a success and on a failure alike, since the reversal
   * may have committed either way, it tells History and reads the shipment again; a reversal that
   * committed then shows the original frozen as a pair with Reverse closed, and one that was
   * refused shows the shipment as it was. Busy holds until the first read settles (a follow-up,
   * when a write was out as it was sent, is detached: #573), and clears only while the request is
   * still its own: cleared earlier, Reverse is enabled over the pre-reversal state,
   * where a click is refused 400 once the reversal committed. Unlike the hub's list read, `load`
   * rejects on a failed GET, so the re-read sets the owner's sentence (owner ruling 2026-10-19, the
   * plan's amendment 2, docs/execution/2026-10-19-581-reverse-reread/plan.md) then; a failure whose
   * re-read succeeds sets none (the read state speaks).
   */
  async function reverseAction() {
    if (!shipper) return;
    const token = navigationLifetime.current;
    const request = {};
    token.request = request;
    const owner = peekBrowserDraftSession()?.store.getSnapshot().owner;
    const ownRequest = () => {
      const fresh = peekBrowserDraftSession()?.store.getSnapshot();
      return token.live && navigationLifetime.current === token && token.request === request &&
        !!owner && fresh?.identityReady === true && fresh.owner?.userId === owner.userId &&
        fresh.owner.authGeneration === owner.authGeneration;
    };
    const attempt = captureDiscardNavigation(() => token.live && navigationLifetime.current === token);
    if (!attempt || !ownRequest()) { attempt?.cancel(); return; }
    // The discard question and the reason through the modal (ruling 5; PR 4): each answer lands
    // a tick later, so the request is proved its own again after each, and a departure meanwhile
    // cancels the attempt. The blank-reason sentence is the server's own (`reverseShipper`), so
    // the two cannot drift.
    if (!(await askDiscard())) { attempt.cancel(); return; }
    if (!ownRequest()) { attempt.cancel(); return; }
    const reason = await askReason({
      question: `Reverse shipment (Packing list #${shipper.shipperNumber})?\n\n` +
        "A reversal is a NEW shipment carrying the negative of every line on this one: it un-ships " +
        "the goods, un-marks the completions this shipment made, and reopens the order — it is the " +
        "correction to use once an invoice has been raised and a void is refused. Both documents " +
        "then freeze as a pair until the reversal is voided, and each keeps its own packing-list " +
        "number forever.",
      verb: "reversing", blankRefusal: "A reason is required to reverse a shipment.",
    });
    if (reason === null) { attempt.cancel(); return; } // cancelled
    if (!ownRequest()) { attempt.cancel(); return; } // left meanwhile
    if (!attempt.isCurrent() || !ownRequest()) { attempt.cancel(); return; }
    setReversing(true);
    // The cancelled-departure re-read (#581). A prior refusal's line is cleared first so it does not
    // sit over the frozen state; a rejected read sets `sentence` while the request is still this
    // page's own; busy clears only when the read settles and only while own. No handler throws, so
    // nothing here is an unhandled rejection.
    const reread = (sentence: (readError: unknown) => string) => {
      setError(null);
      void load()
        .then(() => {}, (readError: unknown) => { if (ownRequest()) setError(sentence(readError)); })
        .finally(() => { if (ownRequest()) setReversing(false); });
    };
    let res: ShipperMutationResult;
    try {
      res = await api<ShipperMutationResult>(
        `/api/shippers/${id}/reverse`, { method: "POST", body: JSON.stringify({ reason }) });
    } catch (reverseError) {
      if (ownRequest()) {
        if (attempt.isCurrent()) {
          setReversing(false);
          setError((reverseError as Error).message);
        } else {
          // The reversal may have committed: tell History, then read the shipment again.
          invalidateHistory();
          reread((e) => `${(reverseError as Error).message} — and the page could not be refreshed (${(e as Error).message}). Reload to see the current state.`);
        }
      }
      attempt.cancel();
      return;
    }
    // Busy and the re-read belong to this local request, even if another caller cancelled its
    // departure. This is a different, already-created document; never adopt it as the original
    // shipment: a cancelled departure tells History (a reversal writes the original's own history
    // when any of its lines was complete, shippers.ts) and reads the original again instead, busy
    // until that read settles.
    if (!ownRequest()) return;
    if (!attempt.isCurrent()) {
      invalidateHistory();
      reread((e) => `Shipment reversed, but the page could not be refreshed — reload to see the current state. (${(e as Error).message})`);
      return;
    }
    setReversing(false);
    try {
      setError(null);
      if (!attempt.attach(`/shipping/${res.shipper.id}`)) return;
      router.push(`/shipping/${res.shipper.id}`);
    } catch {
      if (ownRequest() && attempt.isCurrent()) {
        setError("Shipment reversed, but navigation failed. Reload the shipment list to open the reversal.");
      }
      attempt.cancel();
    }
  }

  // Held until the permission read answers too, so no control renders reading the in-flight array
  // as no grants (#483). A failed read is not pending: the page renders, and the red banner below
  // shows that error when the page has none of its own.
  if (!shipper || permissionsPending(perms, permsError)) {
    return <PageStatus error={error ?? initialLoadError ?? permsError} />;
  }

  // Every totals table of the page from one call, so an order's table and the shipment's cannot
  // disagree. `totals.orders[i]` is the table of `shipper.orders[i]`: the panels below are drawn
  // from the same list, in the same order.
  const totals = shipmentTotals(savedShipmentTotalsInput(shipper.orders, reports));
  const containerSum = containerSumOf(shipper.orders);
  const packageCountDisplay = shipper.packageCount === null ? String(containerSum) : String(shipper.packageCount);
  // The Ship-to select's own option and the "Ships to:" line (#484), decided in the leaf.
  const shipTo = shipToChoice({ listed: addresses, setId: shipper.shipToAddressId, answered: shipToAddress });
  const notice = invoiceNotice(shipper);

  return (
    <div className="min-w-0 p-3 sm:p-6">
      {/* The title row (spec §4.3; PR 4): "Packing list #N", the BOL number and the customer link
          under it; the print controls (spec §11: the whole-shipment ticket, the cert checkbox, the
          BOL) in the header; Reverse and Void stay in the title row (ruling 8). */}
      <PageHeader title={`Packing list #${shipper.shipperNumber}`}
        subtitle={<span className="flex flex-wrap items-center gap-1 break-words">
          <Link href={`/customers/${shipper.customerId}`} className={LINK}>
            {shipper.customerCode} · {shipper.customerName}
          </Link>
          {shipper.bolNumber !== null && <span> · BOL {shipper.bolNumber}</span>}
        </span>}
        actions={<div className="flex flex-wrap items-center justify-end gap-2 text-sm">

        <button type="button" onClick={() => void printTicket(undefined, withCerts && certsGate.allowed)}
                disabled={!printGate.allowed || printing}
                title={printGate.title}
                className={BUTTON_NEUTRAL}>
          {printing ? "Printing…" : "Print shipping ticket"}
        </button>
        {/* §5.16: the checkbox can be disabled for TWO reasons — the missing certs.view names
            itself, and on a voided shipment (certs.view held, so certsGate.title is undefined)
            the title falls through to printGate's voided reason rather than saying nothing
            (fix-wave 2026-08-06; the ShipmentOrderPanel checkbox carries the same pair). */}
        <label className={`flex items-center gap-1 ${certsGate.allowed ? "" : "text-ink-500"}`}
               title={certsGate.title ?? printGate.title}>
          <input type="checkbox" checked={withCerts && certsGate.allowed}
                 disabled={!certsGate.allowed || !printGate.allowed}
                 onChange={(e) => setWithCerts(e.target.checked)} />
          Also print certifications
        </label>
        <button type="button" onClick={() => void printBol()} disabled={!printGate.allowed || printing}
                title={printGate.title}
                className={BUTTON_NEUTRAL}>
          {printing ? "Printing…" : "Print BOL"}
        </button>
          {/* #161: beside Void, on the SAME `void_shipper` special action the reverse route
              enforces — but on its own ladder, which is not Void's (see `reverseGate`). */}
          <ReverseShipmentButton gate={reverseControlGate} busy={reversing} onClick={() => void reverseAction()} />
          <DangerButton onClick={() => void voidAction()} disabled={voidGate.disabled} title={voidGate.title}>
            Void shipment
          </DangerButton>
        </div>} />

      {(error ?? permsError) && (
        <p className={`${NOTICE.refusal} mb-3`}>{error ?? permsError}</p>
      )}
      {initialLoadError && (
        <p className={`${NOTICE.refusal} mb-3`}>{initialLoadError}</p>
      )}
      {voided && (
        <p className={`${NOTICE.refusal} mb-3 font-medium`}>
          Voided — {voidReason ?? "see History for the reason"}
        </p>
      )}
      {/* #139: the pair freeze named once at the top, on top of every disabled control's title —
          hidden on a voided document, whose own banner already says why everything is locked. */}
      {!voided && pairFreeze !== null && (
        <p className={`${NOTICE.warning} mb-3`}>{pairFreeze}</p>
      )}
      {/* #472: the invoice freeze named once, with a link to the invoice. `invoiceNotice` hides it
          on a voided shipment and on either side of a reversal pair, where the banner above is up.
          On a reversed original that banner already leads with the invoice sentence when the pair
          is invoiced. */}
      {notice !== null && <InvoiceFreezeNotice invoice={notice} />}
      {/* The hold, named and linked (§5.4, the §5.14 discoverability habit). On this page it gates
          two things, since the 2026-08-06 extension ruling: adding an order and saving lines need
          override_credit_hold and a reason (`extendGate` and `reasonGate` above; the server's
          `creditHoldGate` is the enforcement). This banner reads the customer record, which needs
          customers.view; the gates read `shipper.customerCreditHold`, so they hold without it. */}
      {customer?.creditHold && (
        <p className={`${NOTICE.refusal} mb-3`}>
          {customer.code} · {customer.name} is on credit hold —{" "}
          <Link href={`/customers/${customer.id}`} className="underline">see their record</Link>.
        </p>
      )}
      {warnings.length > 0 && (
        <ul className={`${NOTICE.warning} mb-3 list-disc space-y-0.5 pl-7`}>
          {warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
      {loadError && <p className={`${NOTICE.warning} mb-3`}>{loadError}</p>}
      {customer?.shippingNotes && (
        <div className="mb-3 rounded bg-link-50 p-2 text-sm text-link-700">
          <span className="font-medium">Customer standing shipping notes: </span>{customer.shippingNotes}
        </div>
      )}

      <div className="flex flex-col gap-6 min-[1360px]:flex-row min-[1360px]:items-start">
      <div className="min-w-0 flex-1">
      {/* Four tabs over the mounted sections (spec §4.4; `src/lib/shipment-tabs.ts`): the grids'
          registry labels badge Orders & quantities, and a tab switch is never a departure. */}
      <RecordTabs label={SHIPMENT_TAB_LABEL} tabs={shipmentTabs()} panels={{
        orders: <>
      {/* ---- Add order ---- */}
      <section id="add-order" className={`${CARD} mb-6`}>
        <h2 className="mb-2 font-medium">Add order</h2>
        <div className="flex flex-wrap items-center gap-2">
          <select value={addOrderChoice} onChange={(e) => setAddOrderChoice(e.target.value)}
                  disabled={addSelect.disabled} title={addSelect.title}
                  className={`${INPUT_COMPACT} disabled:cursor-not-allowed disabled:bg-surface-50`}>
            {/* The first option says what the list is: the permission it needs, loading, failed,
                nothing to add, or a prompt to choose. `addOrderSelect` words all five (#472). */}
            <option value="">{addSelect.placeholder}</option>
            {addableOrders.map((o) => (
              <option key={o.id} value={o.id}>#{o.orderNumber}{o.poNumber ? ` · PO ${o.poNumber}` : ""}</option>
            ))}
          </select>
          <button onClick={() => void addOrder()}
                  disabled={reasonGate.disabled || !addOrderChoice || addingOrder}
                  title={addOrderButtonTitle({ gate: reasonGate, listOffers: !addSelect.disabled, choice: addOrderChoice })}
                  className={BUTTON_PRIMARY_COMPACT}>
            {addingOrder ? "Adding…" : "Add order"}
          </button>
          {held && overrideGate.allowed && !voided && (
            <input value={creditHoldReason} onChange={(e) => setCreditHoldReason(e.target.value)}
                   aria-label="Credit hold override reason"
                   placeholder={`${shipper?.customerCode} is on credit hold — override reason (required)`}
                   className={`${INPUT_COMPACT} min-w-72`} />
          )}
        </div>
      </section>

      <div id="orders">
      {/* ---- One panel per order on the shipment ---- */}
      {shipper.orders.length === 0 && (
        <p className="mb-6 text-sm text-ink-500">No orders on this shipment.</p>
      )}
      {shipper.orders.map((so, i) => (
        <ShipmentOrderPanel
          key={so.id} shipperId={id} order={so} recoverySource={recoverySource}
          editGate={editGate} linesGate={linesAddGate} linesSaveGate={reasonGate}
          creditHoldReason={held && overrideGate.allowed ? creditHoldReason : ""}
          applyMutation={applyMutation}
          onRemove={(report) => void removeOrder(so.id, so.label, report)}
          removeRefusal={removeOrderRefusal(removeOrderFacts(shipper, printedOrders, so))}
          printGate={printGate} printing={printing} certsGate={certsGate}
          onPrintTicket={(certWanted) => void printTicket(so.orderId, certWanted)}
          totals={totals.orders[i]} onTotalsReport={onTotalsReport}
        />
      ))}

      </div>
      {/* ---- Shipment totals, under the last order's panel (owner answer 9 of 2026-10-10) ----
          Its one condition is that there is a table, which is whenever an order is on the shipment.
          No gate is written beside it, so it shows on a voided, a reversed and an invoiced
          shipment. It holds no link: a browser flow finds an order's panel as the `section` that
          holds that order's link (`orderPanel`, e2e/lib/orders.mjs), so it does not find this one. */}
      {totals.shipment !== null && (
        <section id="totals" className={`${CARD} mb-6`}>
          <ShipmentTotalsTable totals={totals.shipment} />
        </section>
      )}

        </>,
        header: <>
      {/* ---- Header ---- */}
      <section id="header" className={`${CARD} mb-6`}>
        <h2 className="mb-2 font-medium">Header</h2>
        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
          <div>
            <label className="block">
              Ship-to address
              <select value={shipper.shipToAddressId ?? ""} disabled={!editGate.allowed} title={editGate.title}
                      onChange={(e) => void patchHeader({ shipToAddressId: e.target.value || null })}
                      className={`${INPUT_COMPACT} mt-1 w-full disabled:bg-surface-50`}>
                <option value="">— none —</option>
                {shipTo.own !== null && <option value={shipTo.own.value}>{shipTo.own.label}</option>}
                {addresses.map((a) => <option key={a.id} value={a.id}>{shipToOptionLabel(a)}</option>)}
              </select>
            </label>
            {/* Without customers.view the address list is never read, so the select can offer no
                address but the shipment's own (#484, owner ruling 2026-10-15). The gate's title
                shows beside it as the reason, on that permission alone, whether or not the select is
                open. The select takes no lock from it: a clear is a write the server accepts. The
                text sits outside the label, so the select's accessible name stays "Ship-to address".
                A failed permission read renders the page with every gate closed (#483), so the text
                then shows to a holder too, beside the red banner. */}
            {!customersGate.allowed && (<span className="mt-1 block text-xs text-ink-500">{customersGate.title}</span>)}
          </div>
          <label className="block">
            Ship date
            <input type="date" value={shipper.shipDate} disabled={!editGate.allowed} title={editGate.title}
                   onChange={(e) => void patchHeader({ shipDate: e.target.value })}
                   className={`${INPUT_COMPACT} mt-1 w-full disabled:bg-surface-50`} />
          </label>
          <label className="block">
            Carrier
            <select value={shipper.carrierId ?? ""} disabled={!editGate.allowed} title={editGate.title}
                    onChange={(e) => void patchHeader({ carrierId: e.target.value || null })}
                    className={`${INPUT_COMPACT} mt-1 w-full disabled:bg-surface-50`}>
              <option value="">— none —</option>
              {shipper.carrierId && !carriers.some((c) => c.id === shipper.carrierId) && (
                <option value={shipper.carrierId}>{shipper.carrierName ?? "(inactive carrier)"}</option>
              )}
              {carriers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="block">
            Route<SavedMark label="Route" show={savedMarks.shows("route", shipper.route)} />
            <input aria-label="Route" value={shipper.route} onFocus={editGuard.onFocusField("route")} readOnly={!editGate.allowed} title={editGate.title}
                   onChange={(e) => patchDraft({ route: e.target.value })}
                   onBlur={(e) => editGuard.onBlurSave(e, (route) => void patchHeader({ route }))}
                     onKeyDown={(e) => editGuard.onEnterCommit(e, (route) => void patchHeader({ route }))}
                   className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
          </label>
          <label className="col-span-2 block md:col-span-3">
            Comments
            <textarea value={shipper.comments} rows={2} onFocus={editGuard.onFocusField("comments")} readOnly={!editGate.allowed} title={editGate.title}
                      onChange={(e) => patchDraft({ comments: e.target.value })}
                      onBlur={(e) => editGuard.onBlurSave(e, (comments) => void patchHeader({ comments }))}
                      className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
          </label>
        </div>

        <div className="mt-4 border-t pt-3">
          <h3 className="mb-2 text-sm font-medium">Freight</h3>
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={shipper.billFreight} disabled={!freightGate.allowed} title={freightGate.title}
                     onChange={(e) => void patchHeader({ billFreight: e.target.checked })} />
              Bill freight
            </label>
            <label className="block">
              Freight amount<SavedMark label="Freight amount" show={savedMarks.shows("freightAmount", String(shipper.freightAmount ?? ""))} />
              <input aria-label="Freight amount" value={String(shipper.freightAmount ?? "")} inputMode="decimal" onFocus={editGuard.onFocusField("freightAmount")}
                     readOnly={!freightGate.allowed} title={freightGate.title}
                     onChange={(e) => patchDraft({ freightAmount: e.target.value })}
                     onBlur={(e) => editGuard.onBlurSave(e, commitFreightAmount)}
                     onKeyDown={(e) => editGuard.onEnterCommit(e, commitFreightAmount)}
                     className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
            </label>
            <label className="block">
              Terms
              <select value={shipper.freightTerms} disabled={!editGate.allowed} title={editGate.title}
                      onChange={(e) => void patchHeader({ freightTerms: e.target.value as FreightTermsValue })}
                      className={`${INPUT_COMPACT} mt-1 w-full disabled:bg-surface-50`}>
                {FREIGHT_TERMS.map((t) => <option key={t} value={t}>{FREIGHT_TERMS_LABELS[t]}</option>)}
              </select>
            </label>
            <label className="block">
              Freight class<SavedMark label="Freight class" show={savedMarks.shows("freightClass", shipper.freightClass)} />
              <input aria-label="Freight class" value={shipper.freightClass} onFocus={editGuard.onFocusField("freightClass")} readOnly={!editGate.allowed} title={editGate.title}
                     onChange={(e) => patchDraft({ freightClass: e.target.value })}
                     onBlur={(e) => editGuard.onBlurSave(e, (freightClass) => void patchHeader({ freightClass }))}
                     onKeyDown={(e) => editGuard.onEnterCommit(e, (freightClass) => void patchHeader({ freightClass }))}
                     className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
            </label>
            <label className="col-span-2 block">
              Freight description<SavedMark label="Freight description" show={savedMarks.shows("freightDescription", shipper.freightDescription)} />
              <input aria-label="Freight description" value={shipper.freightDescription} onFocus={editGuard.onFocusField("freightDescription")} readOnly={!editGate.allowed} title={editGate.title}
                     onChange={(e) => patchDraft({ freightDescription: e.target.value })}
                     onBlur={(e) => editGuard.onBlurSave(e, (freightDescription) => void patchHeader({ freightDescription }))}
                     onKeyDown={(e) => editGuard.onEnterCommit(e, (freightDescription) => void patchHeader({ freightDescription }))}
                     className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
            </label>
            <label className="block">
              Package count<SavedMark label="Package count" show={savedMarks.shows("packageCount", packageCountDisplay)} />
              <input aria-label="Package count" value={packageCountDisplay} inputMode="numeric" onFocus={editGuard.onFocusField("packageCount")}
                     readOnly={!editGate.allowed} title={editGate.allowed ? "Blank uses the current container count" : editGate.title}
                     onChange={(e) => patchDraft({ packageCount: e.target.value })}
                     onBlur={(e) => editGuard.onBlurSave(e, commitPackageCount)}
                     onKeyDown={(e) => editGuard.onEnterCommit(e, commitPackageCount)}
                     className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
            </label>
            <label className="block">
              Pro number<SavedMark label="Pro number" show={savedMarks.shows("proNumber", shipper.proNumber)} />
              <input aria-label="Pro number" value={shipper.proNumber} onFocus={editGuard.onFocusField("proNumber")} readOnly={!editGate.allowed} title={editGate.title}
                     onChange={(e) => patchDraft({ proNumber: e.target.value })}
                     onBlur={(e) => editGuard.onBlurSave(e, (proNumber) => void patchHeader({ proNumber }))}
                     onKeyDown={(e) => editGuard.onEnterCommit(e, (proNumber) => void patchHeader({ proNumber }))}
                     className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
            </label>
            <label className="block">
              SCAC<SavedMark label="SCAC" show={savedMarks.shows("scacCode", shipper.scacCode)} />
              <input aria-label="SCAC" value={shipper.scacCode} onFocus={editGuard.onFocusField("scacCode")} readOnly={!editGate.allowed} title={editGate.title}
                     onChange={(e) => patchDraft({ scacCode: e.target.value })}
                     onBlur={(e) => editGuard.onBlurSave(e, (scacCode) => void patchHeader({ scacCode }))}
                     onKeyDown={(e) => editGuard.onEnterCommit(e, (scacCode) => void patchHeader({ scacCode }))}
                     className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
            </label>
          </div>
          {shipTo.shipsTo !== null && (
            <p className="mt-2 text-xs text-ink-500">
              Ships to: {shipTo.shipsTo}
            </p>
          )}
        </div>
      </section>

        </>,
        documents: (
          /* ---- Documents + History ---- */
      <section id="documents" className={`${CARD} mb-6`}>
        <h2 className="mb-2 font-medium">Documents</h2>
        <ShipmentDocumentsList shipperId={id} viewGate={docsGate} refresh={docsRefresh} orders={shipper.orders} />
      </section>

        ),
        history: (
      <div id="history" className="mb-6">
        <HistoryPanel entity="shipper" entityId={id} perms={perms} permsError={permsError} />
      </div>
        ),
      }} />
      </div>
      {/* The card reads the totals the page already computes from the grids as typed
          (`shipment-totals.ts`), and holds the print messages beside the header's controls. */}
      <AtAGlance rows={[
        { label: "Orders", value: String(shipper.orders.length) },
        { label: NET_WEIGHT_LB, value: totals.shipment?.net ?? "—" },
        { label: TARE_TOTAL_LB, value: totals.shipment?.tare ?? "—" },
        { label: "Gross weight (lb)", value: totals.shipment?.gross ?? "—" },
      ]}>
        <div className="mt-4 flex flex-col gap-2 text-sm">
        {printError && <span className="text-xs text-red-700">{printError}</span>}
        {certDocIds.length > 0 && (
          <span className="text-xs text-ink-500">
            {certDocIds.length} certification{certDocIds.length === 1 ? "" : "s"} archived:{" "}
            {certDocIds.map((docId, i) => (
              <a key={docId} href={`/api/documents/${docId}`} target="_blank" rel="noreferrer"
                 className={LINK}>
                certification PDF{certDocIds.length === 1 ? "" : ` ${i + 1}`}{i < certDocIds.length - 1 ? ", " : ""}
              </a>
            ))}
          </span>
        )}
        {printWarnings.map((w) => (
          <span key={w} className="w-full text-xs text-accent-600">{w}</span>
        ))}
              </div>
      </AtAGlance>
      </div>
    </div>
  );
}
