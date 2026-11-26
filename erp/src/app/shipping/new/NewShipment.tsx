"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import { gate, gateDo, type Gate } from "@/lib/permission-ui";
import { addOrderButtonTitle } from "@/lib/waiting-titles";
import { usePermissions } from "@/lib/use-permissions";
import { formatDateOnly, todayDateOnly } from "@/lib/business-days";
import { FREIGHT_TERMS, FREIGHT_TERMS_LABELS, type FreightTermsValue } from "@/lib/cert-constants";
import { askDiscard } from "@/lib/use-unsaved-section";
import { askConfirm } from "@/lib/modal";
import { useDraftIdentity, useRecoverableDraft } from "@/lib/use-recoverable-draft";
import { getBrowserDraftSession, peekBrowserDraftSession } from "@/lib/draft-session";
import { DraftRecoveryNotice } from "@/components/DraftRecoveryNotice";
import { PageStatus } from "@/components/PageStatus";
import { PanelMessage } from "@/components/PanelMessage";
import { CHECK_AGAIN } from "@/lib/draft-recovery-words";
import { addOrderRefusalSentence } from "@/lib/add-order-refusal";
import { addOrderOptionLabel, addOrderSelect, type AddableState } from "@/lib/shipment-gates";
import { ShipmentTotalsTable } from "@/components/ShipmentTotalsTable";
import { PageHeader } from "@/components/PageHeader";
import { NET_WEIGHT_LB, TARE_TOTAL_LB } from "@/lib/weight-terms";
import { ActionMenu } from "@/components/ActionMenu";
import { RecordTabs } from "@/components/RecordTabs";
import { AtAGlance } from "@/components/AtAGlance";
import { NEW_SHIPMENT_TAB_LABEL, newShipmentTabForBox, newShipmentTabs } from "@/lib/shipment-tabs";
import { newShipmentDraftFrom, newShipmentRecoveryAdapter, runNewShipmentRead, readNewShipmentAccess, runNewShipmentSave, runNewShipmentRetry,
  runNewShipmentCustomer, runNewShipmentAddOrder, runNewShipmentRemoveOrder, newShipmentRecoveryPreviews,
  type NewShipmentDraft, type NewShipmentOrderDraft, type NewShipmentBinding, type NewShipmentReadRequirements, type ShipmentSeed, type ShipmentCreateResult,
} from "@/lib/new-shipment-recovery";
import { LinesGridView, ContainersGridView, SerialsGridView, type GridRowHandle, type LineFields, type ContainerFields, type SerialFields } from "../ShipmentGrids";
import { newId } from "@/lib/client-id";
import { focusWhenShown } from "@/lib/focus-when-shown";
import { markRefused, refusedBox } from "@/lib/refused-boxes";
import { SHIPMENT_BOX, shipmentContainerBoxId, shipmentLineBoxId, shipmentServerRefusalBox } from "@/lib/shipment-box-ids";
import { newShipmentTotalsInput, shipmentTotals } from "@/lib/shipment-totals";
import { BUTTON_PRIMARY, BUTTON_PRIMARY_COMPACT, CARD, INPUT_COMPACT, LINK, NOTICE } from "@/lib/ui-classes";
import { Combobox } from "@/components/Combobox";
import { customerOptions } from "@/lib/menu-options";
import { labelledOptions } from "@/lib/menu-options";
import { inMenuOrder } from "@/lib/menu-order";

type CustomerOption = { id: string; code: string; name: string; creditHold: boolean; shippingNotes: string };
type OrderOption = { id: string; orderNumber: number; poNumber: string };
/** A new shipment has no saved quantity of its own, so "shipped to date" is all other shipments. */
const NO_SAVED_QTY = new Map<string, number>();
/** Add order's list sits under no lines gate on this form: `addOrderSelect` is handed an open one. */
const NO_LINES_GATE: Gate = { allowed: true, disabled: false, title: undefined };
const emptyDisplay = newShipmentDraftFrom({ clientRequestId: "", defaultShipDate: "", defaultFreightTerms: "PREPAID" });
function initialize(seed?: ShipmentSeed) {
  return newShipmentDraftFrom(seed ?? { clientRequestId: newId(), defaultShipDate: formatDateOnly(todayDateOnly()), defaultFreightTerms: "PREPAID" });
}
function newRows<F extends Record<string, string>>(fields: F[]): (GridRowHandle & F)[] { return fields.map(f => ({ key: newId(), isNew: true, ...f })); }
function ErrorText({ message }: { message: string }) {
  const m = message.match(/^(.*) — see (\/customers\/\S+) to lift it$/);
  return m ? <>{m[1]} — <Link href={m[2]} className="underline">see their record</Link> to lift it.</> : <>{message}</>;
}
export function NewShipment() {
  const router = useRouter();
  const { permissions: loadedPerms, error: permsError } = usePermissions();
  const { store, ...drafts } = useDraftIdentity();
  const authorizationRevision = peekBrowserDraftSession()?.getReadAuthorizationRevision() ?? 0;
  const [binding, setBinding] = useState<NewShipmentBinding | null>(null);
  const view = useRecoverableDraft(binding);
  const mounted = useRef(false); const readIdRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  // A refused Save's boxes (owner ruling R13; G8-3): the banner stays at the page top, the cursor
  // goes to the first box and each one carries `aria-invalid`, while `error` still shows that
  // Save's sentence. A new object per refusal, so the same boxes are jumped to again.
  const [refused, setRefused] = useState<{ message: string; ids: readonly string[] } | null>(null);
  // The tab the first refused box sits on, asked open through RecordTabs' `open` (PR 4): the key
  // changes per refusal so the same tab is asked for again.
  const [refusedOpen, setRefusedOpen] = useState<{ id: string; key: string } | null>(null);
  const refusalSeq = useRef(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  // The customer's open orders as last read, and what that read did (#699). The orders on the form
  // are filtered out at render, so Add order and Remove order neither clear the list nor read it.
  const [candidates, setCandidates] = useState<OrderOption[]>([]);
  const [candidatesState, setCandidatesState] = useState<AddableState>("loading");
  const [addChoice, setAddChoice] = useState("");
  const [addingOrder, setAddingOrder] = useState(false);
  // Add order's own refusal, beside its control (#695, owner ruling R1); never `error`, which is Save's.
  const [addRefusal, setAddRefusal] = useState<string | null>(null);
  const [pickingCustomer, setPickingCustomer] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!refused || refused.ids.length === 0) return;
    // The box's tab may still be opening (`focusWhenShown`).
    return focusWhenShown(() => refusedBox(document, refused.ids[0]) as HTMLElement | null);
  }, [refused]);
  useEffect(() => (refused && refused.message === error ? markRefused(document, refused.ids) : undefined), [refused, error]);
  useEffect(() => {
    if (!store || !drafts.identityReady || !drafts.owner) { setBinding(null); return; }
    setBinding(store.bind({ owner: drafts.owner, record: { kind: "new-shipment", id: "new" }, editor: newShipmentRecoveryAdapter.kind },
      { label: "New shipment", href: "/shipping/new" }, newShipmentRecoveryAdapter));
  }, [store, drafts.identityReady, drafts.owner]);
  const readContext = useCallback(async (q: NewShipmentReadRequirements) => {
    const session = getBrowserDraftSession(); const ticket = session?.readAuthorizationTicket();
    if (!session || !ticket) throw new Error("Confirm your identity to access this shipment.");
    const owner = session.store.getSnapshot().owner;
    const me = await api<{ id: string; permissions: string[] }>("/api/auth/me");
    if (!session.isReadAuthorized(ticket) || !owner || owner.userId !== me.id || session.store.getSnapshot().owner !== owner)
      throw new Error("Confirm your identity to access this shipment.");
    return readNewShipmentAccess(q, me.permissions, path => api<unknown>(path));
  }, []);
  const load = useCallback(async () => {
    const session = getBrowserDraftSession(); const ticket = session?.readAuthorizationTicket();
    if (!binding || !session || !ticket) return;
    const outcome = await runNewShipmentRead({ binding, read: readContext, initialize,
      authorized: () => mounted.current && session.isReadAuthorized(ticket) });
    if (!mounted.current || !session.isReadAuthorized(ticket)) return;
    if (outcome.readId !== undefined) readIdRef.current = outcome.readId;
    if (outcome.kind === "authorized") { setError(null); setAddRefusal(null); }
  }, [binding, readContext]);
  useEffect(() => {
    let stale = false;
    void load().catch(e => { if (!stale) setError((e as Error).message); });
    return () => { stale = true; };
  }, [load, authorizationRevision]);
  useEffect(() => {
    // A discard from the Shell's drafts panel leaves this form waiting for a new seed (#456).
    // Starting the read clears the request, so this runs once per discard.
    if (view.mode === "loading" && view.needsRefresh) void load();
  }, [view.mode, view.needsRefresh, load]);

  const formBaseline = view.current?.baseline.kind === "form" ? view.current.baseline : view.savedBaseline?.kind === "form" ? view.savedBaseline : null;
  const data = view.current?.data ?? emptyDisplay;
  const { customerId, shipToAddressId, shipDate, carrierId, route, comments, billFreight, freightAmount, freightTerms, freightClass,
    freightDescription, packageCount, proNumber, scacCode, creditHoldReason } = data;
  const perms = view.savedBaseline ? [...(view.savedBaseline.kind === "form" ? view.savedBaseline.source.permissions : view.savedBaseline.permissions)] : loadedPerms;
  const customersGate = gate(perms, "customers.view"); const ordersGate = gate(perms, "orders.view");
  const createGate = gate(perms, "shipping.create"); const overrideGate = gateDo(perms, "override_credit_hold");
  const addresses = formBaseline?.source.addresses ?? []; const carriers = formBaseline?.source.carriers ?? [];
  const selectedCustomer = formBaseline?.source.customer ?? null;
  const holdBlocked = !!selectedCustomer?.creditHold && !overrideGate.allowed;
  // C2b (#239): `createGate` is `shipping.create` and `holdBlocked` is the §5.4 credit-hold
  // refusal — neither of them knows whether a customer has been picked. Every other control on the
  // form already waits for one (the ship-to address, the order picker, their own "Pick a customer
  // first" tooltips), and the save it gates cannot succeed without one — `CREATE_SHIPPER` requires
  // a non-empty `customerId`, and no order can be added before a customer is picked, so
  // `validate`'s own refusal is reached first and names the wrong thing ("A shipment needs at
  // least one line with a positive quantity"). The button was the one control on the form still
  // inviting that. Title order follows refusal order — the permission the actor cannot fix, then
  // the field they can, then the hold.
  const noCustomer = !customerId;
  const saveDisabledTitle = createGate.disabled ? createGate.title : noCustomer ? "Pick a customer first"
    : holdBlocked && selectedCustomer
    ? `${selectedCustomer.code} · ${selectedCustomer.name} is on credit hold — saving requires the override_credit_hold action` : undefined;
  const savedShipment = view.completed ?? null;
  const selected = data.selected.flatMap(raw => {
    const o = formBaseline?.source.orders.find(o => o.id === raw.orderId); if (!o) return [];
    return [{ ...raw, lines: [...raw.lines], containers: [...raw.containers], serials: [...raw.serials], orderNumber: o.orderNumber, poNumber: o.poNumber, customerJobNo: o.customerJobNo,
      lineCandidates: o.lines.map(l => ({ id: l.id, partNumber: l.part.partNumber, qty: l.qty, weight: l.weight })),
      // tests/shipment-containers-grid.test.tsx runs this initializer by its free name `o`.
      containerCandidates: o.containers.map(c => ({ id: c.id, typeName: c.type.name, customerContainerId: c.customerContainerId, count: c.count, tareEach: c.tareEach ?? null })),
      serialCandidates: o.serials.map(s => ({ id: s.id, serial: s.serial })),
      infoByLineId: new Map(o.lines.map(l => [l.id, { partNumber: l.part.partNumber, partName: l.part.name, orderedQty: l.qty, orderedWeight: l.weight, eachWeight: l.part.eachWeight ?? null }])),
      shippedByLineId: new Map(o.orderLineShippedToDate.map(s => [s.orderLineId, { qty: s.shippedToDateQty, weight: s.shippedToDateWeight }])),
      containerInfoById: new Map(o.containers.map(c => [c.id, { typeName: c.type.name, customerContainerId: c.customerContainerId }])),
      serialInfoById: new Map(o.serials.map(s => [s.id, { serial: s.serial, description: s.description }])) }];
  });
  const selectedOrderIds = new Set(data.selected.map(o => o.orderId));
  const addable = candidates.filter(o => !selectedOrderIds.has(o.id));
  // The list's state, worded as the saved shipment page words it (`addOrderSelect`, #699).
  const addSelect = addOrderSelect({ gate: NO_LINES_GATE, ordersGate, state: candidatesState, count: addable.length });
  // The Add order list is closed with no customer, without orders.view, while its read is out or
  // after it failed, or with no order listed. Its button reads the same condition: it says "Pick an
  // order first" only while the list is open (#487), and stays untitled with no customer picked
  // (owner answer 5, 2026-10-16).
  const addListClosed = !customerId || addSelect.disabled;
  // Net, Tare and Gross for each panel and for the whole shipment (the weights design §12.2), from
  // the draft's rows as they stand at this render. One call answers every table on the form.
  const totals = shipmentTotals(newShipmentTotalsInput(selected));
  // Picker catalogs are presentation state, guarded independently from draft adoption.
  useEffect(() => {
    const session = getBrowserDraftSession(); const ticket = session?.readAuthorizationTicket(); let stale = false;
    if (!session || !ticket || !customersGate.allowed) { setCustomers([]); return; }
    api<CustomerOption[]>("/api/customers").then(rows => { if (!stale && session.isReadAuthorized(ticket)) setCustomers(rows); })
      .catch(e => { if (!stale && session.isReadAuthorized(ticket)) setLoadError((e as Error).message); });
    return () => { stale = true; };
  }, [customersGate.allowed, authorizationRevision]);
  // A full read (`load()`, the notice's retry and Add order's) takes the editor out of editing until
  // it lands (`beginRead` clears access), so `view.mode` reads the list again beside the saved records.
  useEffect(() => {
    setCandidates([]); setCandidatesState("loading");
    const session = getBrowserDraftSession(); const ticket = session?.readAuthorizationTicket(); let stale = false;
    if (!session || !ticket || !customerId || !ordersGate.allowed || view.mode !== "editing") return;
    api<OrderOption[]>(`/api/orders?customerId=${encodeURIComponent(customerId)}&status=OPEN,PARTIAL_SHIPPED`).then(rows => {
      if (!stale && session.isReadAuthorized(ticket)) { setCandidates(rows); setCandidatesState("ready"); }
    }).catch(() => { if (!stale && session.isReadAuthorized(ticket)) setCandidatesState("failed"); });
    return () => { stale = true; };
  }, [customerId, ordersGate.allowed, authorizationRevision, view.mode]);
  function changeField<K extends keyof NewShipmentDraft>(field: K, value: NewShipmentDraft[K]) { binding?.change(d => ({ ...d, [field]: value })); }
  async function pickCustomer(id: string) {
    if (!binding || id === customerId) return;
    if ((data.selected.length || shipToAddressId || creditHoldReason.trim()) && !(await askDiscard({ action: "Change customer? This clears the picked orders and their line, container and serial drafts, the ship-to address, and the credit-hold reason." }))) return;
    if (!mounted.current) return; // the answer lands a tick later; the pick stands on its own
    const session = getBrowserDraftSession(); const ticket = session?.readAuthorizationTicket(); if (!session || !ticket) return;
    // The select holds the earlier customer until the read lands (#699), so it says it is busy.
    setPickingCustomer(true);
    try { if (await runNewShipmentCustomer({ binding, customerId: id, read: readContext, accepted: id => { readIdRef.current = id; }, authorized: () => mounted.current && session.isReadAuthorized(ticket) })) { setAddChoice(""); setError(null); setAddRefusal(null); } }
    finally { if (mounted.current) setPickingCustomer(false); }
  }
  async function addOrder() {
    if (!binding || !addChoice || addingOrder) return;
    const session = getBrowserDraftSession(); const ticket = session?.readAuthorizationTicket(); if (!session || !ticket) return;
    setAddingOrder(true); setAddRefusal(null);
    try { const outcome = await runNewShipmentAddOrder({ binding, orderId: addChoice, read: readContext, accepted: id => { readIdRef.current = id; }, newKey: () => newId(), authorized: () => mounted.current && session.isReadAuthorized(ticket) });
      if (!mounted.current) return;
      if (outcome === "added") { setAddChoice(""); setError(null); }
      setAddRefusal(addOrderRefusalSentence(outcome)); }
    finally { if (mounted.current) setAddingOrder(false); }
  }
  async function removeOrder(orderId: string) {
    const order = selected.find(o => o.orderId === orderId);
    if (!binding || !order) return;
    const ok = await askConfirm({
      title: `Remove order ${order.orderNumber} from this shipment?`,
      body: "Its lines, containers and serials on this draft are discarded — re-adding the order starts from the prefilled quantities again.",
      confirm: "Remove order", danger: true,
    });
    if (!ok || !mounted.current) return;
    runNewShipmentRemoveOrder(binding, orderId, id => { readIdRef.current = id; });
  }
  /** Back to shipping: a leave, so the shared prompt's navigation wording is the right one. */
  async function leave() {
    if (await askDiscard()) router.push("/shipping");
  }
  function patchOrder(orderId: string, patch: (o: NewShipmentOrderDraft) => NewShipmentOrderDraft) {
    binding?.change(d => ({ ...d, selected: d.selected.map(o => o.orderId === orderId ? patch(o) : o) }));
  }
  function gridPatch<F extends Record<string, string>>(rows: readonly (GridRowHandle & F)[], row: GridRowHandle, field: keyof F & string, value: string) { return rows.map(r => r.key === row.key ? { ...r, [field]: value } : r); }
  function gridRemove<R extends GridRowHandle>(rows: readonly R[], row: GridRowHandle) { return rows.filter(r => r.key !== row.key); }
  async function persisted(result: ShipmentCreateResult) {
    const completed = binding?.getSnapshot().completed;
    if (mounted.current && completed?.id === result.shipper.id && result.warnings.length === 0) router.push(`/shipping/${result.shipper.id}`);
  }
  /** Shows a Save's refusal in the banner and takes the cursor to its first box: the page's own
   *  check names its boxes, and a server sentence names one only when it names a box exactly. */
  function refuseSave(outcome: { error?: unknown; fieldIds?: string[] }, orderIds: readonly string[]) {
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    const routed = outcome.fieldIds ?? [shipmentServerRefusalBox(message, orderIds)].flatMap(id => id === null ? [] : [id]);
    setError(message);
    setRefused({ message, ids: routed });
    setRefusedOpen(routed.length > 0 ? { id: newShipmentTabForBox(routed[0]), key: String(++refusalSeq.current) } : null);
  }
  async function handleSave() {
    if (!binding || saving) return; setError(null); setRefused(null); setSaving(true);
    const orderIds = binding.getSnapshot().current?.data.selected.map(o => o.orderId) ?? [];
    try { const outcome = await runNewShipmentSave({ binding, requestId: newId(), write: body => api<ShipmentCreateResult>("/api/shippers", { method: "POST", body: JSON.stringify(body) }), persisted });
      if (mounted.current && "error" in outcome) refuseSave(outcome, orderIds);
    } finally { if (mounted.current) setSaving(false); }
  }
  async function retryOriginal() {
    if (!binding || !view.current || !view.canRetryUnknown) return;
    setSaving(true);
    const orderIds = view.current.data.selected.map(o => o.orderId);
    try { const outcome = await runNewShipmentRetry({ binding, stamp: view.current.stamp, readId: readIdRef.current, requestId: newId(),
      write: body => api<ShipmentCreateResult>("/api/shippers", { method: "POST", body: JSON.stringify(body) }), persisted });
      if (mounted.current && "error" in outcome) refuseSave(outcome, orderIds);
    } finally { if (mounted.current) setSaving(false); }
  }
  const previews = newShipmentRecoveryPreviews(view);
  const notice = binding && <DraftRecoveryNotice mode={view.mode} canRestore={view.canRestore} hasCurrent={!!view.current} hasReference={!!view.reference}
    {...previews} currentPreview={view.mode === "editing" ? undefined : previews.currentPreview}
    restore={() => { if (view.current) binding.restore(view.current.stamp, readIdRef.current); }}
    discard={() => { if (view.current) { binding.discard(view.current.stamp); void load(); } }}
    discardReference={() => { if (view.reference) {
      binding.discard(view.reference.stamp);
      const remaining = binding.getSnapshot();
      if (!remaining.current && !remaining.reference && !remaining.completed) void load();
    } }}
    startFresh={!view.canRetryUnknown && !view.submitted && view.savedBaseline?.kind === "form" ? () => { binding.startFresh(readIdRef.current, initialize); } : undefined}
    retryRead={() => { void load(); }} />;
  const receiptReference = view.reference && <div className="mt-3">
    {previews.referencePreview && <section><h3>Later unsaved input</h3>{previews.referencePreview.map((v, i) => <p key={i} className="whitespace-pre-wrap">{v.label}: {v.value}</p>)}</section>}
    {binding && <button type="button" className="underline" onClick={() => { if (view.reference) {
      binding.discard(view.reference.stamp);
      const remaining = binding.getSnapshot();
      if (!remaining.current && !remaining.reference && !remaining.completed) void load();
    } }}>Dismiss earlier copy</button>}
  </div>;
  const shipToAddress = addresses.find(a => a.id === shipToAddressId);
  // No form to show (#695 (b)): the recovery notice says why, its first sentence being
  // `editorAccessSentence(view.mode)`, and no Save or read message is carried over beside it. Before
  // the draft store binds there is no notice, and the read has not started: "Loading…" (#634).
  if (["loading", "unavailable", "error"].includes(view.mode)) return notice ? <div className="p-6">{notice}</div> : <PageStatus />;
  return (
    <div className="min-w-0 p-3 sm:p-6">
      {/* The title row (spec §4.3; PR 4): Save shipment is the one primary, Back to shipping a More
          actions item asking through the modal when the draft holds unsaved work. The Save's gate
          and title are what the bottom button carried. */}
      <PageHeader title="New shipment" subtitle="One customer. Add the orders going on this truck."
        actions={savedShipment ? undefined : <>
          {/* Gone with the form once a save has landed: the receipt view below offers Go to
              shipment, and a Save over a completed draft is the stray second Save this page must
              never produce. */}
          <button type="button" onClick={() => void handleSave()}
                  disabled={saving || createGate.disabled || noCustomer || holdBlocked}
                  title={saveDisabledTitle}
                  className={BUTTON_PRIMARY}>
            {saving ? "Saving…" : "Save shipment"}
          </button>
          <ActionMenu items={[{ label: "Back to shipping", onSelect: () => void leave() }]} />
        </>} />

      {/* The page-top banner holds Save's refusals (ruling R13), so it stays on screen while the
          cursor's box is centred: it sticks to the top of the window, and a long list scrolls
          inside it (owner answers 2026-10-29). */}
      {(error ?? permsError) && (
        <p role="alert" className={`${NOTICE.refusal} sticky top-0 z-20 mb-3 max-h-[33vh] overflow-y-auto whitespace-pre-line`}><ErrorText message={error ?? permsError ?? ""} /></p>
      )}
      {loadError && <p className={`${NOTICE.warning} mb-3`}>{loadError}</p>}

      {notice}
      {view.canRetryUnknown && <button type="button" className="my-2 underline" onClick={() => void retryOriginal()}>Retry original submission</button>}
      {savedShipment ? (
        // A save that succeeded WITH warnings stops here instead of navigating straight past them
        // (the orders/new precedent; owner's "visibly, never silently" ruling). The form is gone —
        // the shipment exists now, and a stray second Save from a kept-alive form is exactly what
        // this page must never produce.
        <div className="rounded border border-success-700 bg-success-50 p-4">
          <p className="mb-2 font-medium">Packing List {savedShipment.shipperNumber} saved.</p>
          <ul className="mb-3 list-disc space-y-0.5 pl-5 text-sm text-accent-600">
            {savedShipment.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
          <button type="button" onClick={() => router.push(`/shipping/${savedShipment.id}`)}
                  className={BUTTON_PRIMARY_COMPACT}>
            Go to shipment
          </button>
          {receiptReference}
          {binding && view.completedStamp && <button type="button" className="ml-3 underline" onClick={() => { if (view.completedStamp && binding.dismissCompleted(view.completedStamp)) void load(); }}>Dismiss completed shipment</button>}
        </div>
      ) : (
        <fieldset disabled={view.mode !== "editing"}>
          {/* Three tabs over the sections (spec §4.4; `src/lib/shipment-tabs.ts`), the draft one
              binding across them, so a tab switch is never a departure; the card beside them reads
              the totals the page already computes. */}
          <div className="flex flex-col gap-6 min-[1360px]:flex-row min-[1360px]:items-start">
          <div className="min-w-0 flex-1">
          <RecordTabs label={NEW_SHIPMENT_TAB_LABEL} tabs={newShipmentTabs()} open={refusedOpen} panels={{
            route: <>
          {/* ---- Customer ---- */}
          <section id="customer" className={`${CARD} mb-6`}>
            <h2 className="mb-2 font-medium">Customer</h2>
            <Combobox value={customerId} options={customerOptions(customers, { blank: "— choose a customer —" })}
                    onSelect={(v) => pickCustomer(v)}
                    disabled={!customersGate.allowed || pickingCustomer} title={customersGate.title} id={SHIPMENT_BOX.customer} ariaLabel="Customer" className="w-full max-w-md" />
            {pickingCustomer && <span className="ml-2 text-sm text-ink-500">Loading customer…</span>}

            {/* The credit-hold gate, made visible BEFORE the refused round trip (spec §5.4): named,
                linked, and — only for an actor who can actually override — the required reason. */}
            {selectedCustomer?.creditHold && (
              <div className={`${NOTICE.refusal} mt-2`}>
                <p>
                  {selectedCustomer.code} · {selectedCustomer.name} is on credit hold —{" "}
                  <Link href={`/customers/${selectedCustomer.id}`} className="underline">see their record</Link>.
                </p>
                {overrideGate.allowed ? (
                  <label className="mt-2 block">
                    Saving this shipment records a credit-hold override. Reason (required, kept in the audit history — printed nowhere):
                    <input value={creditHoldReason} onChange={(e) => changeField("creditHoldReason", e.target.value)}
                           aria-label="Credit hold override reason" id={SHIPMENT_BOX.creditHoldReason}
                           className="mt-1 w-full rounded border border-red-300 px-2 py-1" />
                  </label>
                ) : (
                  <p className="mt-1">Saving a shipment for them requires the <span className="font-mono">override_credit_hold</span> action.</p>
                )}
              </div>
            )}
            {selectedCustomer?.shippingNotes && (
              <div className="mt-2 rounded bg-link-50 p-2 text-sm text-link-700">
                <span className="font-medium">Customer standing shipping notes: </span>{selectedCustomer.shippingNotes}
              </div>
            )}
          </section>

          {/* ---- Header (the edit page's field set) ---- */}
          <section id="header" className={`${CARD} mb-6`}>
            <h2 className="mb-2 font-medium">Header</h2>
            <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
              <label className="block">
                Ship-to address
                <Combobox value={shipToAddressId} options={labelledOptions(addresses, (a) => `${a.name} — ${a.street ?? ""}, ${a.city ?? ""} ${a.state ?? ""}`, { blank: "— none —" })}
                          onSelect={(v) => changeField("shipToAddressId", v)}
                          disabled={!customerId} title={customerId ? undefined : "Pick a customer first"}
                          ariaLabel="Ship-to address" className="mt-1 w-full" />
              </label>
              <label className="block">
                Ship date
                <input type="date" id={SHIPMENT_BOX.shipDate} value={shipDate} onChange={(e) => changeField("shipDate", e.target.value)}
                       className={`${INPUT_COMPACT} mt-1 w-full`} />
              </label>
              <label className="block">
                Carrier
                <select value={carrierId} onChange={(e) => changeField("carrierId", e.target.value)}
                        className={`${INPUT_COMPACT} mt-1 w-full`}>
                  <option value="">— none —</option>
                  {inMenuOrder(carriers, (r) => r.name).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <label className="block">
                Route
                <input value={route} onChange={(e) => changeField("route", e.target.value)}
                       className={`${INPUT_COMPACT} mt-1 w-full`} />
              </label>
              <label className="col-span-2 block md:col-span-3">
                Comments
                <textarea value={comments} rows={2} onChange={(e) => changeField("comments", e.target.value)}
                          className={`${INPUT_COMPACT} mt-1 w-full`} />
              </label>
            </div>

            {shipToAddress && (
              <p className="mt-2 text-xs text-ink-500">
                Ships to: {shipToAddress.name} — {shipToAddress.street}, {shipToAddress.city} {shipToAddress.state} {shipToAddress.zip}
              </p>
            )}
          </section>
            </>,
            freight: (
          /* ---- Freight & bill of lading (the edit page's field set) ---- */
          <section id="freight" className={`${CARD} mb-6`}>
            <h2 className="mb-2 font-medium">Freight</h2>
              <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={billFreight} onChange={(e) => changeField("billFreight", e.target.checked)} />
                  Bill freight
                </label>
                <label className="block">
                  Freight amount
                  <input id={SHIPMENT_BOX.freightAmount} value={freightAmount} inputMode="decimal" onChange={(e) => changeField("freightAmount", e.target.value)}
                         className={`${INPUT_COMPACT} mt-1 w-full`} />
                </label>
                <label className="block">
                  Terms
                  <select value={freightTerms} onChange={(e) => changeField("freightTerms", e.target.value as FreightTermsValue)}
                          className={`${INPUT_COMPACT} mt-1 w-full`}>
                    {FREIGHT_TERMS.map((t) => <option key={t} value={t}>{FREIGHT_TERMS_LABELS[t]}</option>)}
                  </select>
                </label>
                <label className="block">
                  Freight class
                  <input value={freightClass} onChange={(e) => changeField("freightClass", e.target.value)}
                         className={`${INPUT_COMPACT} mt-1 w-full`} />
                </label>
                <label className="col-span-2 block">
                  Freight description
                  <input value={freightDescription} onChange={(e) => changeField("freightDescription", e.target.value)}
                         className={`${INPUT_COMPACT} mt-1 w-full`} />
                </label>
                <label className="block">
                  Package count
                  {/* P2 (#239): the placeholder read "container count", which on a page whose order
                      panels each carry a Containers grid looked like an instruction to type one —
                      the Containers concept under a second name. It is a DEFAULT, not a prompt, so
                      it now says so; the title keeps the fuller sentence and nothing about the
                      behaviour (blank → the container sum, derived at print time) changes. */}
                  <input id={SHIPMENT_BOX.packageCount} value={packageCount} inputMode="numeric" onChange={(e) => changeField("packageCount", e.target.value)}
                         placeholder="defaults to container count" title="Blank uses the current container count"
                         className={`${INPUT_COMPACT} mt-1 w-full`} />
                </label>
                <label className="block">
                  Pro number
                  <input value={proNumber} onChange={(e) => changeField("proNumber", e.target.value)}
                         className={`${INPUT_COMPACT} mt-1 w-full`} />
                </label>
                <label className="block">
                  SCAC
                  <input value={scacCode} onChange={(e) => changeField("scacCode", e.target.value)}
                         className={`${INPUT_COMPACT} mt-1 w-full`} />
                </label>
              </div>
          </section>
            ),
            orders: <>
          {/* ---- Add order ---- */}
          <section id="orders" className={`${CARD} mb-6`}>
            <h2 className="mb-2 font-medium">Orders</h2>
            {!customerId && <p className="mb-2 text-sm text-ink-500">Pick a customer to add their orders.</p>}
            <div className="flex flex-wrap items-center gap-2">
              {/* Newest order first, as the server lists them: an order on purpose (#1056 ruling 3). */}
              <Combobox value={addChoice} onSelect={(v) => setAddChoice(v)}
                        options={addable.map((o) => ({ value: o.id, label: addOrderOptionLabel(o) }))}
                        placeholder={!customerId ? "Pick a customer first" : addSelect.placeholder}
                        disabled={addListClosed}
                        title={addSelect.title} ariaLabel="Add order" id={SHIPMENT_BOX.addOrder} className="w-64" />
              <button onClick={() => void addOrder()} disabled={!addChoice || addingOrder}
                      title={addOrderButtonTitle({ listOffers: !addListClosed, choice: addChoice })}
                      className={BUTTON_PRIMARY_COMPACT}>
                {addingOrder ? "Adding…" : "Add order"}
              </button>
            </div>
            <PanelMessage message={addRefusal} />
            {addRefusal && <button type="button" className="mt-1 text-sm underline" onClick={() => void load()}>{CHECK_AGAIN}</button>}
          </section>

          {/* ---- One panel per selected order — the shared sibling-group grids ---- */}
          {selected.map((o, i) => (
            <section key={o.orderId} className={`${CARD} mb-6`}>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-lg font-semibold">
                  <Link href={`/orders/${o.orderId}`} className={LINK}>#{o.orderNumber}</Link>
                  {o.poNumber && <span className="ml-2 text-sm font-normal text-ink-500">PO {o.poNumber}</span>}
                  {o.customerJobNo && <span className="ml-2 text-sm font-normal text-ink-500">Job {o.customerJobNo}</span>}
                </h3>
                <button onClick={() => void removeOrder(o.orderId)}
                        className="text-xs text-red-600">
                  Remove order
                </button>
              </div>

              <LinesGridView
                rows={o.lines}
                candidates={o.lineCandidates.filter((c) => !o.lines.some((r) => r.orderLineId === c.id))}
                infoByLineId={o.infoByLineId} shippedByLineId={o.shippedByLineId} savedQtyByLineId={NO_SAVED_QTY} gate={createGate}
                boxId={(index, box) => shipmentLineBoxId(o.orderId, index, box)}
                onPatch={(row, field, value) => patchOrder(o.orderId, (cur) => ({ ...cur, lines: gridPatch<LineFields>(cur.lines, row, field, value) }))}
                onRemove={(row) => patchOrder(o.orderId, (cur) => ({ ...cur, lines: gridRemove(cur.lines, row) }))}
                onAddRows={(rows) => patchOrder(o.orderId, (cur) => ({ ...cur, lines: [...cur.lines, ...newRows(rows)] }))} />
              <div className="my-4 border-t" />
              <ContainersGridView
                rows={o.containers}
                candidates={o.containerCandidates.filter((c) => !o.containers.some((r) => r.orderContainerId === c.id))}
                infoById={o.containerInfoById} gate={createGate} orderHasNone={o.containerCandidates.length === 0}
                boxId={(index, box) => shipmentContainerBoxId(o.orderId, index, box)}
                onPatch={(row, field, value) => patchOrder(o.orderId, (cur) => ({ ...cur, containers: gridPatch<ContainerFields>(cur.containers, row, field, value) }))}
                onRemove={(row) => patchOrder(o.orderId, (cur) => ({ ...cur, containers: gridRemove(cur.containers, row) }))}
                onAddRows={(rows) => patchOrder(o.orderId, (cur) => ({ ...cur, containers: [...cur.containers, ...newRows(rows)] }))} />
              <ShipmentTotalsTable totals={totals.orders[i]} />
              <div className="my-4 border-t" />
              <SerialsGridView
                rows={o.serials}
                candidates={o.serialCandidates.filter((c) => !o.serials.some((r) => r.orderSerialId === c.id))}
                infoById={o.serialInfoById} gate={createGate} orderHasNone={o.serialCandidates.length === 0}
                onPatch={(row, field, value) => patchOrder(o.orderId, (cur) => ({ ...cur, serials: gridPatch<SerialFields>(cur.serials, row, field, value) }))}
                onRemove={(row) => patchOrder(o.orderId, (cur) => ({ ...cur, serials: gridRemove(cur.serials, row) }))}
                onAddRows={(rows) => patchOrder(o.orderId, (cur) => ({ ...cur, serials: [...cur.serials, ...newRows(rows)] }))} />
            </section>
          ))}

          {/* ---- Shipment totals, once an order is on the form ---- */}
          {totals.shipment !== null && (
            <section className={`${CARD} mb-6`}>
              <ShipmentTotalsTable totals={totals.shipment} />
            </section>
          )}
            </>,
          }} />
          </div>
          {/* The card reads what the page already holds: the picked customer, the orders on the
              form and the shipment totals as typed (`shipment-totals.ts`), nothing new. */}
          <AtAGlance rows={[
            { label: "Customer", value: selectedCustomer ? `${selectedCustomer.code} · ${selectedCustomer.name}` : "—" },
            { label: "Orders", value: String(selected.length) },
            { label: NET_WEIGHT_LB, value: totals.shipment?.net ?? "—" },
            { label: TARE_TOTAL_LB, value: totals.shipment?.tare ?? "—" },
            { label: "Gross weight (lb)", value: totals.shipment?.gross ?? "—" },
          ]} />
          </div>
        </fieldset>
      )}
    </div>
  );
}
