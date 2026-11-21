"use client";
// Order entry — the shop's keyboard-speed data-entry screen (design spec §11) and the page the
// spec's crash-safety promise lives on (autosaved drafts, task-13-brief.md).
//
// THE BINDING STATE MODEL (the 2C-3 lesson): every piece of state below is either something the
// user actually typed/chose, or an explicit override flag/value. Nothing server-derived — the
// selected part's eachWeight, the entry-defaults request date, the customer's defaultPo — is ever
// stored here; those compose with the typed state at render time (computeLineWeight below,
// entryDefaultRequestDate, selectedCustomer.defaultPo). `OrderDraftState` is exactly what gets
// autosaved, so its extracted shape IS the draft payload — there is no separate "what do we send to
// /api/order-drafts" mapping to drift from what the form actually holds.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError, READ_ANSWER_UNREADABLE, UnreadableAnswerError } from "@/lib/fetcher";
import { decimalRefusal, readDecimal, readFinishedDecimal } from "@/lib/decimal-entry";
import { formatDateTime, formatNumber } from "@/lib/format";
import { CHARGE_AMOUNT, LINE_NET_WEIGHT, SCALE_GROSS, TARE_EACH } from "@/lib/order-boxes";
import { prepareOrderPrintIntent, storeOrderPrintIntent, type CreatedOrderForPrint, type OrderPrintIntent } from "@/lib/order-print-intent";
import { INT4_MAX } from "@/lib/order-constants";
import type { EntryPlanInput, EntryPlanPreview } from "@/lib/order-entry-plan";
import { useUnsavedSection } from "@/lib/use-unsaved-section";
import { gate, type Gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { SEARCH_DEBOUNCE_MS } from "@/lib/debounce";
import { PanelMessage } from "@/components/PanelMessage";
import { PLAN_WAIT_FIELD, PLAN_WAIT_MESSAGE, pendingSaveOutcome, saveDecision, type PendingSave } from "@/lib/entry-save-wait";
import { submitWithConflictRetry } from "@/lib/idempotent-save";
import { resolveLeadValidity, type LeadValidityReport } from "@/lib/lead-validity";
import { formatDateOnly, todayDateOnly } from "@/lib/business-days";
import { CERT_SCOPES, CERT_SCOPE_LABELS, type CertScopeValue } from "@/lib/cert-constants";
import { entryTareEach, typeDefaultTare } from "@/lib/container-tare-prefill";
import { ADD_CONTAINER_ID, containerRefusalField } from "@/lib/container-refusal-field";
import { chargeRefusalField } from "@/lib/charge-refusal-field";
import { lineRefusalField } from "@/lib/line-refusal-field";
import { orderTotals } from "@/lib/order-totals";
import { OrderTotalsTable } from "@/components/OrderTotalsTable";
import { Combobox, type ComboboxOption } from "./Combobox";
import { OrderLineCard, computeLineWeight, findDuplicateSerials } from "./OrderLineCard";
import { EntryContainerRow } from "./EntryContainerRow";
import { blankLine, blankContainer, blankCharge, type OrderDraftState, type LineDraft,
  type ContainerDraft, type ChargeDraft, type CustomerOption, type PartOption,
  type ContainerTypeOption } from "./order-draft";
import { useOrderAutosave } from "./use-order-autosave";
import { CONTAINER_TYPES_NOT_LOADED, changeLeadAdjustment, entryContainerBody, entryTotalsInput,
  reconcileTravelerSelection, type EntryTab } from "./entry-state";
import { EntryWorkspace, StandingOrderNotes } from "./EntryWorkspace";
import { OrderSummary, formatEntryWeightCents, type PlanAvailability } from "./OrderSummary";
import { containerTotal } from "@/lib/container-total";
import { ProcessLoadsPanel, entryPrintProblem, parseEntryAdjustment } from "./ProcessLoadsPanel";
import { markRefused, refusedBox } from "@/lib/refused-boxes";
import { BUTTON_NEUTRAL, BUTTON_NEUTRAL_COMPACT, BUTTON_PRIMARY, BUTTON_PRIMARY_COMPACT, CARD, INPUT_COMPACT, LINK, NOTICE, TEXT_MUTED } from "@/lib/ui-classes";
import { PageHeader } from "@/components/PageHeader";
import { ActionMenu } from "@/components/ActionMenu";
import { ChargesDialog } from "./ChargesDialog";
import { askDiscard } from "@/lib/use-unsaved-section";

type EntryProblem = { message: string; tab: EntryTab; fieldId: string };
/** What the page's red line shows: every problem's message, one per line, the first problem's tab
 *  and field (where "Review in …" goes and the cursor lands), and every problem's field (each
 *  section holding a refused box opens). */
type EntryError = { message: string; tab: EntryTab; fieldId: string; fieldIds: string[] };

export default function NewOrderPage() {
  const router = useRouter();
  const openingSavedOrder = useRef(false);
  const { permissions: perms, error: permsError } = usePermissions();

  const { draft, setDraft, draftPrompt, draftReady, draftPromptError, draftPromptBusy, saveState,
    resumeDraft, discardDraft, beginSave, saveSucceeded, saveFailed } = useOrderAutosave();
  const autosaveError = saveState.message;

  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [parts, setParts] = useState<PartOption[]>([]);
  const [containerTypes, setContainerTypes] = useState<ContainerTypeOption[]>([]);
  // Set by the catch of the container types read below and by nothing else, so nothing sets it
  // back. While it is true the Containers section shows CONTAINER_TYPES_NOT_LOADED (owner ruling
  // P3 of 2026-10-09; the weights design §10.7, point 12). tests/order-entry-containers.test.tsx
  // lifts that read's effect out of this file and runs it.
  const [containerTypesFailed, setContainerTypesFailed] = useState(false);
  // F9 precedent (parts/[id]/page.tsx): a failed background list fetch gets its OWN banner, never
  // the shared `error` state a later successful save clears — otherwise a save elsewhere on the
  // page can silently erase the report that a picker's options failed to load.
  const [loadError, setLoadError] = useState<string | null>(null);
  const addLoadError = useCallback((message: string) => {
    setLoadError((cur) => (cur ? `${cur} ${message}` : message));
  }, []);

  const [entryDefaultRequestDate, setEntryDefaultRequestDate] = useState<string | null>(null);
  // The request-date read's own failure, shown beside the Request date box (#664): never the F9
  // banner above, which only appends and is never cleared, and cleared by the read's next run.
  const [entryDefaultsError, setEntryDefaultsError] = useState<string | null>(null);
  // Fix-wave R4 finding 9: the lead-part check's verdict is stored WITH the line id it came from,
  // and read back only while that line is still the lead. A late report from a line the operator
  // has since removed (or that a removal demoted out of position 1) describes a part that is no
  // longer being ordered, and used to block — or unblock — Save on it. `resolveLeadValidity` is
  // that read; OrderLineCard's own effect cleanup is the other half, stopping an unmounted card
  // from reporting at all.
  const [leadReport, setLeadReport] = useState<LeadValidityReport | null>(null);
  const onLeadValidity = useCallback(
    (lineId: string, ok: boolean | null) => setLeadReport({ lineId, ok }), []);
  const [serialProblems, setSerialProblems] = useState<Record<string, string | null>>({});
  const onSerialProblem = useCallback((lineId: string, message: string | null) => {
    setSerialProblems(current => current[lineId] === message ? current : { ...current, [lineId]: message });
  }, []);

  const [error, setError] = useState<EntryError | null>(null);
  const [activeTab, setActiveTab] = useState<EntryTab>("details");
  const [planNotice, setPlanNotice] = useState<string | null>(null);
  const [refreshPlan, setRefreshPlan] = useState(0);
  const [previousPlanKey, setPreviousPlanKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Set only when a save SUCCEEDS with non-empty warnings — the owner's standing "visibly, never
  // silently" ruling (HANDOFF issue #4 heritage) means a credit-hold or serialization notice
  // returned alongside a successful save must not vanish behind an immediate navigate. Zero
  // warnings still navigates immediately (below); this state exists only for the other case.
  const [savedOrder, setSavedOrder] =
    useState<{ id: string; orderNumber: number; warnings: string[]; print: boolean; intent: OrderPrintIntent | null } | null>(null);
  // Phase 8B §5.6: null until the gate predicate is fetched; `ready:false` shows the blocking notice.
  const [readiness, setReadiness] =
    useState<{ ready: boolean; gaps: { label: string; href: string }[] } | null>(null);

  const customersGate = gate(perms, "customers.view");
  const partsGate = gate(perms, "parts.view");
  const processesGate = gate(perms, "processes.view");
  const saveGate = gate(perms, "orders.create");
  // The quote-link preview fetch (/api/quotes/eligible) is gated orders.view server-side; the
  // re-pick CONTROL itself is gated on the save permission this form feeds (§5.16 — saveGate).
  const ordersViewGate = gate(perms, "orders.view");
  // #44: Save & Print lands on /orders/[id]?print=1, where both the hub GET and the traveler
  // POST require orders.view — a caller holding orders.create alone would create the order and
  // then strand on a forbidden page without printing. So THAT button also needs orders.view
  // (§5.16: visible, disabled, title naming the missing permission); plain Save keeps
  // orders.create alone.
  const savePrintGate: Gate = saveGate.disabled ? saveGate : ordersViewGate;
  useUnsavedSection(draftReady && !savedOrder && ["dirty", "saving", "error"].includes(saveState.status), "New order");
  const [chargesOpen, setChargesOpen] = useState(false);

  // A refusal first reveals its panel, then focuses the actual input after the DOM is committed.
  // With several refusals that is the first one's.
  useEffect(() => {
    if (!error || activeTab !== error.tab) return;
    const field = refusedBox(document, error.fieldId) as HTMLElement | null;
    field?.focus();
    field?.scrollIntoView({ block: "center" });
  }, [error, activeTab]);
  // Every box the refusals name carries `aria-invalid` while they show (owner ruling R13; G2-5).
  useEffect(() => (error ? markRefused(document, error.fieldIds) : undefined), [error]);

  /** Shows `error` and takes the cursor to its first field. A new object each time, so the focus
   *  effect runs again for the same refusals ("Review in …"). */
  function reveal(error: EntryError) {
    setActiveTab(error.tab);
    // A refused charge box lives in the charges dialog: open it so the focus below can reach it.
    if (error.fieldIds.some((id) => id.startsWith("entry-charge-"))) setChargesOpen(true);
    setError(error);
  }
  /** Shows every problem at once, one per line, and jumps to the first. `problems` is never empty. */
  function refuse(problems: EntryProblem[]) {
    const [first] = problems;
    reveal({ message: problems.map((problem) => problem.message).join("\n"), tab: first.tab, fieldId: first.fieldId,
      fieldIds: problems.map((problem) => problem.fieldId) });
  }

  // ---- mount-time fetches ----

  useEffect(() => {
    if (!customersGate.allowed) return;
    api<CustomerOption[]>("/api/customers").then(setCustomers).catch((e) => addLoadError((e as Error).message));
  }, [customersGate.allowed, addLoadError]);

  useEffect(() => {
    // No customerId filter exists on GET /api/parts (verified against src/app/api/parts/route.ts
    // and listParts in src/server/parts.ts — only includeInactive/search) — fetch the whole
    // active catalog once and filter to the chosen customer client-side (customerParts below).
    if (!partsGate.allowed) return;
    api<PartOption[]>("/api/parts").then(setParts).catch((e) => addLoadError((e as Error).message));
  }, [partsGate.allowed, addLoadError]);

  useEffect(() => {
    // Session-only route (no permission gate beyond being signed in) — matches every other
    // pick-list consumer in the app.
    api<ContainerTypeOption[]>("/api/picklists/containerType").then(setContainerTypes)
      .catch((e) => {
        setContainerTypesFailed(true);
        addLoadError((e as Error).message);
      });
  }, [addLoadError]);

  useEffect(() => {
    // The Phase 8B order-entry gate: if company identity + a chart of accounts are not configured,
    // createOrder is blocked server-side, so show the blocking notice instead of the form. This is
    // the SAME predicate the gate enforces (order-entry-readiness.ts), so the two cannot disagree.
    if (!saveGate.allowed) return;
    api<{ ready: boolean; gaps: { label: string; href: string }[] }>("/api/orders/entry-readiness")
      .then(setReadiness)
      .catch((e) => {
        addLoadError((e as Error).message);
        // Don't strand the form on "Checking setup…" forever on a fetch failure — fall through
        // optimistically; the SERVER-side gate is the real enforcement and refuses a genuine block.
        setReadiness({ ready: true, gaps: [] });
      });
  }, [saveGate.allowed, addLoadError]);

  // ---- entry-defaults (request date) — refetched whenever the customer, the LEAD part, or the
  // operator's own received-date override changes (fix-wave finding 1: the untouched preview
  // used to always compute from TODAY even after the received date was backdated on this same
  // form, so it could show a request date the eventual save — which computes from the OVERRIDDEN
  // received date, exactly like createOrder itself — would not agree with). ----

  const customerId = draft.customerId;
  const leadPartId = draft.lines[0]?.partId ?? null;
  // The received date the two reads ask with (#668): as typed 250 ms after its last change, so a
  // year typed digit by digit is read once, but at once when the draft becomes ready, so a resumed
  // draft reads with its own date. The box, the draft and the save read the live value.
  const readReceivedDate = useDebouncedValue(draft.receivedDateOverride, SEARCH_DEBOUNCE_MS, draftReady);
  // The read needs orders.view (the route's gate). Without it nothing is read and the box says so
  // (#664); while the permissions are still out, nothing is read and nothing is said.
  const ordersViewAllowed = ordersViewGate.allowed;
  const entryDefaultsLatest = useLatest();
  useEffect(() => {
    const t = entryDefaultsLatest.next();
    setEntryDefaultsError(null);
    if (!customerId || !ordersViewAllowed) { setEntryDefaultRequestDate(null); return; }
    const qs = new URLSearchParams({
      customerId,
      ...(leadPartId ? { partId: leadPartId } : {}),
      // Omitted while untouched — same "not overridden yet" shape as buildCreateBody's own
      // `receivedDate: draft.receivedDateOverride ?? undefined` — so the server bases the preview
      // on ITS OWN today, identically to what an unbackdated save would do.
      ...(readReceivedDate ? { receivedDate: readReceivedDate } : {}),
    });
    api<{ requestDate: string }>(`/api/orders/entry-defaults?${qs}`).then((r) => {
      if (entryDefaultsLatest.isCurrent(t)) setEntryDefaultRequestDate(r.requestDate);
    }).catch((e) => {
      // A failed read leaves no date behind: the one shown may be another customer's.
      if (entryDefaultsLatest.isCurrent(t)) { setEntryDefaultsError((e as Error).message); setEntryDefaultRequestDate(null); }
    });
    return () => { entryDefaultsLatest.next(); };
  }, [customerId, leadPartId, readReceivedDate, ordersViewAllowed, entryDefaultsLatest]);

  // ---- derived display values (composed at render, never persisted) ----

  const selectedCustomer = customers.find((c) => c.id === draft.customerId) ?? null;
  const customerParts = draft.customerId ? parts.filter((p) => p.customerId === draft.customerId) : [];
  const displayedPo = draft.poOverride ?? (selectedCustomer?.defaultPo ?? "");
  const displayedReceivedDate = draft.receivedDateOverride ?? formatDateOnly(todayDateOnly());
  const displayedRequestDate = draft.requestDateOverride ?? (entryDefaultRequestDate ?? "");

  // The §6.1 chain, composed AT RENDER from the picked parts (2C-3: derive, never store) —
  // `certRequired ?? inheritedCertRequired` per line IS `part ?? customer ?? plant`, because
  // parts.ts folds the customer default and the plant setting into `inheritedCert*` server-side.
  // Required is OR'd across every picked line (a rider's requirement is never dropped); scope
  // reads the LEAD alone. Until a lead part is picked there is nothing to resolve — `null` here
  // renders the controls disabled with that reason (§5.16), never a made-up "No".
  const linePartRows = draft.lines.map((l) => (l.partId ? customerParts.find((p) => p.id === l.partId) ?? null : null));
  const leadPartRow = linePartRows[0];
  const resolvedCertRequired: boolean | null = leadPartRow
    ? linePartRows.some((p) => p !== null && (p.certRequired ?? p.inheritedCertRequired))
    : null;
  const resolvedCertScope: CertScopeValue | null = leadPartRow
    ? (leadPartRow.certScope ?? leadPartRow.inheritedCertScope)
    : null;
  const displayedCertRequired = draft.certRequiredOverride ?? resolvedCertRequired;
  const displayedCertScope = draft.certScopeOverride ?? resolvedCertScope;
  const certPreviewReady = resolvedCertRequired !== null;

  const customerOptions: ComboboxOption[] = customers.map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` }));

  useEffect(() => {
    const changed = changeLeadAdjustment(draft, leadPartId);
    if (changed.draft === draft) return;
    setDraft(changed.draft);
    setPlanNotice(changed.notice);
  }, [draft, leadPartId, setDraft]);

  const adjustmentResult = parseEntryAdjustment(draft.loadAdjustmentDraft);
  // Each part line as a figure, with its weight box read by `weightOf`, or null for a line that
  // cannot be one. Two readings (spec §11): the preview, the summary and the save read a box as
  // Save takes it (`readDecimal`: `36.` is 36), so a half-typed weight still gets its read-only
  // preview and Save is never held waiting for one; the totals table under the container rows
  // reads it as it is being typed (`readFinishedDecimal`: `42.` is no figure yet), as it reads Tare
  // each. tests/order-entry-containers.test.tsx lifts these initializers out of this file and runs them.
  const readLines = (weightOf: (text: string) => number | null) => draft.lines.map(line => {
    const part = customerParts.find(row => row.id === line.partId);
    const qty = Number(line.qty);
    const weight = weightOf(line.weightOverride ?? String(computeLineWeight(part, qty) ?? ""));
    return part && Number.isInteger(qty) && qty >= 1 && qty <= 10_000_000 && weight !== null
      ? { partId: part.id, qty, weight } : null;
  });
  const normalizedLines = readLines(text => {
    const reading = readDecimal(text, LINE_NET_WEIGHT.box);
    return reading.ok ? reading.value : null;
  });
  const totalsLines = readLines(text => readFinishedDecimal(text, LINE_NET_WEIGHT.box));
  const validLines = normalizedLines.length > 0 && normalizedLines.every(line => line !== null);
  const totalQty = validLines ? normalizedLines.reduce((sum, line) => sum + line!.qty, 0) : null;
  const totalWeightCents = validLines
    ? normalizedLines.reduce((sum, line) => sum + BigInt(Math.round(line!.weight * 100)), BigInt(0)) : null;
  const containerCountValid = draft.containers.every(container => Number.isInteger(Number(container.count)) && Number(container.count) >= 1 && Number(container.count) <= INT4_MAX);
  // The Loads card's Containers figure: every row's count added up, the rule every container tag
  // prints as the order's total (`containerTotal`, #743).
  const containerCount = containerCountValid ? containerTotal(draft.containers.map(container => ({ count: Number(container.count) }))) : null;
  // Order totals, under the container rows (the weights design §10.2). `entryTotalsInput` is handed
  // the page's own checked lines as they are being typed, each part line's part, the customer's parts, and each container
  // row with the type list, so a row's Tare each is read as its box shows it.
  // tests/order-entry-containers.test.tsx lifts this initializer out of this file and runs it.
  const totals = orderTotals(entryTotalsInput({ draftLines: draft.lines, lines: totalsLines,
    parts: customerParts, containers: draft.containers, containerTypes }));
  const adjustmentMatchesLead = !draft.loadAdjustmentDraft.enabled || draft.loadAdjustmentDraft.leadPartId === leadPartId;
  const planInput: EntryPlanInput | null = draftReady && saveGate.allowed && customerId && validLines && adjustmentResult.adjustment && adjustmentMatchesLead
    ? { customerId, lines: normalizedLines as EntryPlanInput["lines"], loadAdjustment: adjustmentResult.adjustment } : null;
  const inputKey = planInput ? JSON.stringify(planInput) : null;
  // Object identity covers A → B → A and a manual refresh even if revision/input strings match.
  // Every rendered consumer checks it, so old content/count disappears before the effect runs.
  const previewIdentity = useMemo(() => ({ inputKey, refreshPlan, includeProcess: processesGate.allowed }), [inputKey, refreshPlan, processesGate.allowed]);
  const [planState, setPlanState] = useState<{ identity: typeof previewIdentity; preview: EntryPlanPreview | null; error: string | null } | null>(null);
  const previewLatest = useLatest();
  // R12 (#662): a Save clicked while the plan is pending waits on this identity's preview instead
  // of being refused. `rushPlan` names the identity whose preview is sent at once (the debounce
  // dropped to nothing), and `sentFor` the identity whose preview is already out, so a wait never
  // sends a second one. The decisions are src/lib/entry-save-wait.ts's.
  const [pendingSave, setPendingSave] = useState<PendingSave<typeof previewIdentity> | null>(null);
  const [rushPlan, setRushPlan] = useState<typeof previewIdentity | null>(null);
  const sentFor = useRef<typeof previewIdentity | null>(null);
  useEffect(() => {
    const ticket = previewLatest.next();
    if (!previewIdentity.inputKey) return;
    const timer = setTimeout(() => {
      sentFor.current = previewIdentity;
      api<EntryPlanPreview>("/api/orders/preview", { method: "POST", body: previewIdentity.inputKey! }).then(preview => {
        if (previewLatest.isCurrent(ticket)) setPlanState({ identity: previewIdentity, preview, error: null });
      }).catch(reason => {
        // #547: the preview is a POST that only reads, so `api()` words an answer it could not read
        // as a committed write. Nothing was written, so the plan shows the read sentence (the
        // owner's answer of 2026-10-18 to the plan's question 5).
        if (previewLatest.isCurrent(ticket)) setPlanState({ identity: previewIdentity, preview: null,
          error: reason instanceof UnreadableAnswerError ? READ_ANSWER_UNREADABLE
            : reason instanceof Error ? reason.message : "Could not preview the load plan." });
      });
    }, rushPlan === previewIdentity ? 0 : 250);
    return () => { clearTimeout(timer); previewLatest.next(); };
  }, [previewIdentity, previewLatest, rushPlan]);
  const currentState = planState?.identity === previewIdentity ? planState : null;
  const preview = currentState?.preview ?? null;
  const planAvailability: PlanAvailability = !inputKey ? "incomplete" : currentState?.error ? "error" : preview ? "ready" : "loading";
  const waitingOnPlan = pendingSave?.identity === previewIdentity;
  // The old lead check remains a fallback only until the coherent plan owns orderability.
  const leadValid = preview ? true : resolveLeadValidity(leadReport, draft.lines[0]?.id ?? null);
  const planKey = preview ? JSON.stringify({ customerId, leadPartId: preview.leadPartId, loads: preview.loads }) : null;
  useEffect(() => {
    if (!planKey || previousPlanKey === planKey) return;
    const next = reconcileTravelerSelection(draft.travelerSelection, previousPlanKey, planKey);
    if (draft.travelerSelection.mode !== "all") {
      setDraft(current => ({ ...current, travelerSelection: next.selection }));
      setPlanNotice(next.notice);
    }
    setPreviousPlanKey(planKey);
  }, [planKey, previousPlanKey, draft.travelerSelection, setDraft]);
  // Do not briefly expose a stale subset between a new preview render and reconciliation.
  const selection = planKey && planKey !== previousPlanKey ? { mode: "all" as const } : draft.travelerSelection;
  const travelerCount = preview ? (selection.mode === "all" ? preview.loads.length : selection.loadNumbers.length) : null;
  const printProblem = entryPrintProblem(preview, selection);
  // #662: while the plan is loading the reason is "wait for the plan", which the summary's
  // "Updating load plan…" already says; drawing it too shifted the header twice per typing burst.
  // The button's title still carries it, and Save & Print stays disabled.
  const printReasonShown = !!printProblem && planAvailability !== "loading";

  // ---- typed-state mutators ----

  function patch(p: Partial<OrderDraftState>) {
    setDraft((d) => ({ ...d, ...p }));
  }
  function patchLine(id: string, p: Partial<LineDraft>) {
    setDraft((d) => ({ ...d, lines: d.lines.map((l) => (l.id === id ? { ...l, ...p } : l)) }));
  }
  function addLine() {
    setDraft((d) => ({ ...d, lines: [...d.lines, blankLine()] }));
  }
  function removeLine(id: string) {
    // At least one line always — the empty-state rule — so this is a no-op on the last one rather
    // than something the caller needs to guard against separately.
    setDraft((d) => (d.lines.length <= 1 ? d : { ...d, lines: d.lines.filter((l) => l.id !== id) }));
  }
  function patchContainer(id: string, p: Partial<ContainerDraft>) {
    setDraft((d) => ({ ...d, containers: d.containers.map((c) => (c.id === id ? { ...c, ...p } : c)) }));
  }
  function addContainer() {
    setDraft((d) => ({ ...d, containers: [...d.containers, blankContainer()] }));
  }
  function removeContainer(id: string) {
    setDraft((d) => ({ ...d, containers: d.containers.filter((c) => c.id !== id) }));
  }
  function patchCharge(id: string, p: Partial<ChargeDraft>) {
    setDraft((d) => ({ ...d, charges: d.charges.map((c) => (c.id === id ? { ...c, ...p } : c)) }));
  }
  function addCharge() {
    setDraft((d) => ({ ...d, charges: [...d.charges, blankCharge()] }));
  }
  function removeCharge(id: string) {
    setDraft((d) => ({ ...d, charges: d.charges.filter((c) => c.id !== id) }));
  }

  // ---- validation + save ----

  // tests/order-entry-containers.test.tsx lifts `validate`, `serverProblem` and `buildCreateBody`
  // out of this file's source and runs them, because the page cannot be rendered in a test. Each
  // stays a function declaration of its name. One that reads a new name from this component gains
  // that name in the test's environment in the same change.
  //
  // Client-side pre-check for the common empty-state mistakes (spec's own empty-state rules) —
  // a UX nicety, not a substitute for the server's authoritative validation, which still runs
  // (and still wins) on every save.
  //
  // Every refusal, in the order the page checks them (owner answer 2, 2026-10-14): the order
  // details, each part line, each container row, each charge, then the load adjustment. A line with
  // no part, or a part outside the customer's catalog, is asked for its part alone: there is no
  // weight to work out, nor from a refused quantity unless a weight was typed. The per-serial
  // check gives one line at most (its first refused serial); the range, duplicate and count checks
  // keep their own lines. A container row with no type skips its count, pieces and tare each. The load
  // plan is asked for only when nothing else is refused. A decimal box is checked through the one
  // rule as the box shows it and named by its place and label (`decimalRefusal`, `order-boxes.ts`).
  function validate(): EntryProblem[] {
    const problems: EntryProblem[] = [];
    const details = (message: string, fieldId: string) => { problems.push({ message, tab: "details", fieldId }); };
    const partProblem = (message: string, fieldId: string) => { problems.push({ message, tab: "parts", fieldId }); };
    if (!draft.customerId) details("Pick a customer.", "entry-customer");
    if (displayedPo.length > 200) details("PO number must be at most 200 characters.", "entry-po");
    if (draft.vsOrderNumber.length > 60) details("VS reference must be at most 60 characters.", "entry-vs");
    if (draft.customerJobNo.length > 60) details("Customer job must be at most 60 characters.", "entry-job");
    if (draft.notes.length > 4000) details("Notes must be at most 4,000 characters.", "entry-notes");
    if (draft.lines.length === 0) partProblem("Add at least one part line.", "entry-add-line");
    for (const [i, line] of draft.lines.entries()) {
      const label = i === 0 ? "Lead line" : `Line ${i + 1}`;
      const field = (suffix: string) => `entry-line-${line.id}-${suffix}`;
      if (serialProblems[line.id]) partProblem(`${label}: ${serialProblems[line.id]}`, field("serials"));
      if (!line.partId) { partProblem(`${label}: pick a part.`, field("part")); continue; }
      const qty = Number(line.qty);
      const qtyFits = Number.isInteger(qty) && qty >= 1 && qty <= 10_000_000;
      if (!qtyFits) partProblem(`${label}: enter a whole quantity from 1 to 10,000,000.`, field("qty"));
      const part = customerParts.find((p) => p.id === line.partId);
      if (!part) { partProblem(`${label}: pick a part from the selected customer's catalog.`, field("part")); continue; }
      // A weight worked out from a refused quantity is not checked: there is nothing to work it out
      // from. A typed weight is checked whatever the quantity holds.
      if (qtyFits || line.weightOverride !== null) {
        const weight = decimalRefusal(`${label}, ${LINE_NET_WEIGHT.label}`,
          line.weightOverride ?? String(computeLineWeight(part, qty) ?? ""), LINE_NET_WEIGHT.box, { required: true });
        if (weight) partProblem(weight, field("weight"));
      }
      // Save is refused on the card's own live "Duplicate serial" check, so it never sends a repeat
      // the server would refuse. `findDuplicateSerials` compares serials trimmed, as the server
      // does, and leaves a blank serial to the blank check below (#546). The refusal names the
      // first serial box whose trimmed value repeats and quotes the trimmed value, as the server's
      // sentence and the card's banner do.
      const dupes = findDuplicateSerials(line.serials);
      const duplicate = line.serials.find(serial => dupes.has(serial.serial.trim()));
      if (duplicate) partProblem(`${label}: serial "${duplicate.serial.trim()}" is entered twice.`, field(`serial-${duplicate.id}`));
      if (line.serials.length > 10_000) partProblem(`${label}: use at most 10,000 serials.`, field("serials"));
      // The per-serial check gives one line at most: the first serial refused, with its first refusal.
      for (const [serialIndex, serial] of line.serials.entries()) {
        if (!serial.serial.trim() || serial.serial.trim().length > 120) {
          partProblem(`${label}: serial ${serialIndex + 1} must be 1–120 characters.`, field(`serial-${serial.id}`));
          break;
        }
        if (serial.description.length > 500) {
          partProblem(`${label}: serial ${serialIndex + 1} description must be at most 500 characters.`, field(`serial-${serial.id}-description`));
          break;
        }
      }
    }
    if (leadValid === false && draft.lines.length > 0) partProblem("Lead line: this part has no process steps — choose a different lead part.", `entry-line-${draft.lines[0].id}-part`);
    for (const [i, c] of draft.containers.entries()) {
      const field = (suffix: string) => `entry-container-${c.id}-${suffix}`;
      if (!c.typeId) partProblem(`Container ${i + 1}: pick a type.`, field("type"));
      else {
        const count = Number(c.count);
        if (!Number.isInteger(count) || count < 1 || count > INT4_MAX) partProblem(`Container ${i + 1}: enter a whole number of containers from 1 to ${formatNumber(INT4_MAX)}.`, field("count"));
        // Pieces is optional, but a value that is not a number must not quietly become "unset":
        // Number("abc") is NaN, and JSON.stringify(NaN) is null, which would reach the server as a
        // valid-looking omission and not as the typing mistake it is.
        if (c.pieces.trim() !== "" && (!Number.isInteger(Number(c.pieces)) || Number(c.pieces) < 1 || Number(c.pieces) > INT4_MAX)) {
          partProblem(`Container ${i + 1}: Pieces must be a whole number from 1 to ${formatNumber(INT4_MAX)}.`, field("pieces"));
        }
        // Tare each is checked as its box shows it: the operator's own text, or the type's default.
        const tareEach = decimalRefusal(`Container ${i + 1}, ${TARE_EACH.label}`,
          entryTareEach(c.tareEachOverride, typeDefaultTare(containerTypes, c.typeId)), TARE_EACH.box);
        if (tareEach) partProblem(tareEach, field("tareEach"));
      }
      const scaleGross = decimalRefusal(`Container ${i + 1}, ${SCALE_GROSS.label}`, c.scaleGross, SCALE_GROSS.box);
      if (scaleGross) partProblem(scaleGross, field("scaleGross"));
      if (c.customerContainerId.length > 60) partProblem(`Container ${i + 1}: customer container ID must be at most 60 characters.`, field("customerContainerId"));
    }
    for (const [i, c] of draft.charges.entries()) {
      if (!c.description.trim() || c.description.trim().length > 500) details(`Charge ${i + 1}: enter a description of at most 500 characters.`, `entry-charge-${c.id}-description`);
      const amount = decimalRefusal(`Charge ${i + 1}, ${CHARGE_AMOUNT.label}`, c.amount, CHARGE_AMOUNT.box);
      if (amount) details(amount, `entry-charge-${c.id}-amount`);
    }
    for (const adjustmentError of adjustmentResult.errors) problems.push({ ...adjustmentError, tab: "process" });
    if (!problems.length && !preview) {
      problems.push({ message: currentState?.error ?? PLAN_WAIT_MESSAGE, tab: "process", fieldId: PLAN_WAIT_FIELD });
    }
    return problems;
  }

  // Where a server refusal of the save takes the cursor. `draft` is the one Save checked and built
  // its body from, so the server's line and charge numbers count these rows. The part line leaf and
  // then the charge leaf are asked first (owner answer 1, 2026-10-18). Between them they take only a
  // refusal that begins with `lineLabel`'s `Line N` or with a path under `lines` or `charges`, and
  // pick the box by the line, serial or charge it names, so a part number or serial in it (`RECEIVED DATE-1`)
  // does not reach the checks below, which read the whole message. `parseDate`'s refusal begins
  // with the typed value in quotes, never with `Line ` or a path, so it still reaches the date
  // check. The line leaf asks the document for a line's quote list when the refusal arrives: the
  // `-quote` id is on QuoteLinkPicker's list alone, and a hidden tab's panel stays in the document
  // (`EntryWorkspace`; #546, D4). What is left names no line, so it reads the lead line (D3).
  function serverProblem(message: string): EntryProblem {
    const lineField = lineRefusalField(message, draft.lines, (id) => document.getElementById(id) !== null);
    if (lineField) return { message, tab: "parts", fieldId: lineField };
    // `?? ""` is for the type: `validate` refuses a save with no part line before it is sent.
    const chargeField = chargeRefusalField(message, draft.charges.map((c) => c.id), draft.lines[0]?.id ?? "");
    if (chargeField) return { message, tab: chargeField.tab, fieldId: chargeField.fieldId };
    const date = /received date/i.test(message) ? "received" : /request date/i.test(message) ? "request" : /target date/i.test(message) ? "target" : null;
    if (date) return { message, tab: "details", fieldId: `entry-${date}` };
    const containerField = containerRefusalField(message, draft.containers.map((c) => c.id));
    if (containerField) return { message, tab: "parts", fieldId: containerField };
    const line = draft.lines[0];
    if (/quote|part|serial|line/i.test(message) && line) return { message, tab: "parts",
      fieldId: `entry-line-${line.id}-${/quote/i.test(message) ? "quote" : /serial/i.test(message) ? "serials" : /weight/i.test(message) ? "weight" : /quantity|qty/i.test(message) ? "qty" : "part"}` };
    if (/customer/i.test(message)) return { message, tab: "details", fieldId: "entry-customer" };
    return { message, tab: "process", fieldId: "entry-refresh-plan" };
  }

  function buildCreateBody() {
    return {
      customerId: draft.customerId,
      loadAdjustment: adjustmentResult.adjustment ?? undefined,
      expectedPreviewFingerprint: preview?.fingerprint,
      // The draft's own nonce (R4 finding 5) — sent on the first attempt AND, because handleSave
      // builds this body once and hands the SAME object to the retry, on the 409 retry too.
      clientRequestId: draft.clientRequestId,
      poNumber: displayedPo,
      vsOrderNumber: draft.vsOrderNumber,
      customerJobNo: draft.customerJobNo,
      // Omitted (never frozen to the client's preview) while untouched — the SERVER resolves and
      // freezes the chain at the moment it saves (spec §6.1), exactly like receivedDate below.
      // Only an explicit override travels.
      certRequired: draft.certRequiredOverride ?? undefined,
      certScope: draft.certScopeOverride ?? undefined,
      // Omitted (not frozen to the client's preview) while untouched — the server computes its
      // own "today"/business-day default at the moment it actually saves, which is the more
      // correct instant to read "today" from than whenever the form happened to render.
      receivedDate: draft.receivedDateOverride ?? undefined,
      requestDate: draft.requestDateOverride ?? undefined,
      targetDate: draft.targetDate,
      notes: draft.notes,
      lines: draft.lines.map((l) => {
        const part = customerParts.find((p) => p.id === l.partId);
        const qty = Number(l.qty);
        // Same trimmed-string wire shape either way (matching containers'/charges' decimal
        // fields below) — validate() has already confirmed this resolves to a real number > 0,
        // so String(...) here is never "NaN" or an empty string in practice.
        const weight = l.weightOverride !== null ? l.weightOverride.trim() : String(computeLineWeight(part, qty) ?? 0);
        return {
          partId: l.partId,
          qty,
          weight,
          serials: l.serials.map((s) => ({ serial: s.serial, description: s.description })),
          // Three-way (spec §5.2): the key is PRESENT only for an explicit pick (id) or an
          // explicit "No quote" (null); untouched sends ABSENT and the server auto-resolves at
          // save time — never the previewed id (LineDraft.quoteLineIdOverride's contract).
          ...(l.quoteLineIdOverride !== undefined ? { quoteLineId: l.quoteLineIdOverride } : {}),
        };
      }),
      containers: draft.containers.map((c) => entryContainerBody(c, containerTypes)),
      charges: draft.charges.map((c) => ({
        description: c.description.trim(),
        amount: c.amount.trim() === "" ? null : c.amount.trim(),
      })),
    };
  }

  type CreateResult = CreatedOrderForPrint & {
    order: CreatedOrderForPrint["order"] & { orderNumber: number }; warnings: string[];
  };

  async function submitOnce(body: unknown) {
    return api<CreateResult>("/api/orders", { method: "POST", body: JSON.stringify(body) });
  }

  function openSavedOrder(id: string, print: boolean, intent: OrderPrintIntent | null) {
    if (openingSavedOrder.current) return;
    openingSavedOrder.current = true;
    let suffix = "";
    if (print) {
      // An empty intent parameter deliberately requests manual review. Storage access itself
      // can throw (browser policy); the order has already saved and must never be re-created.
      suffix = "?printIntent=";
      try {
        if (intent) suffix += encodeURIComponent(storeOrderPrintIntent(window.sessionStorage, intent));
      } catch { /* The hub explains manual review; no automatic fallback. */ }
    }
    router.push(`/orders/${id}${suffix}`);
  }

  // R12 (#662): the waiting save continues once this identity's plan lands, is refused with the
  // preview's own sentence when it fails, and with the plan-wait sentence when an edit superseded
  // the identity first: the refusals Save gave before, and the cursor goes where they went.
  const handleSaveRef = useRef<(print?: boolean) => Promise<void>>(async () => {});
  useEffect(() => {
    if (!pendingSave) return;
    const outcome = pendingSaveOutcome(pendingSave, previewIdentity, currentState);
    if (outcome.kind === "waiting") return;
    setPendingSave(null);
    if (outcome.kind === "continue") { void handleSaveRef.current(pendingSave.print); return; }
    refuse([{ message: outcome.kind === "failed" ? outcome.error : PLAN_WAIT_MESSAGE, tab: "process", fieldId: PLAN_WAIT_FIELD }]);
  }, [pendingSave, previewIdentity, currentState]); // eslint-disable-line react-hooks/exhaustive-deps -- `refuse` is a render-scoped function over setters; the ref carries handleSave.
  handleSaveRef.current = handleSave;

  /** Save first; warnings must be acknowledged before storing the same-tab print intent. */
  async function handleSave(print = false) {
    const problems = validate();
    if (saving || saveGate.disabled || (print && savePrintGate.disabled)) return;
    // R12 (#662): when the only problem is the plan still pending for this identity, wait on it
    // (sending the preview at once unless it is already out) rather than refuse; the form stays
    // editable, so an edit supersedes the wait, and `saving` is not set.
    const decision = saveDecision({ problems, availability: planAvailability, identity: previewIdentity, pending: pendingSave });
    if (decision.kind === "already-waiting") return;
    if (decision.kind === "wait") {
      setPendingSave({ identity: previewIdentity, print });
      if (sentFor.current !== previewIdentity) setRushPlan(previewIdentity);
      return;
    }
    if (decision.kind === "refuse") { refuse(problems); return; }
    if (print && printProblem) { refuse([{ message: printProblem, tab: "process", fieldId: "entry-traveler-selection" }]); return; }
    setError(null);
    // The controller suspends scheduling synchronously and drains dispatched autosaves.
    const autosavesSettled = beginSave();
    setSaving(true);
    const body = buildCreateBody();
    try {
      await autosavesSettled;
      // The T4-measured concurrent-save behavior: a 409 means the transaction wrote NOTHING and
      // consumed no order number (src/server/orders.ts), so retrying the identical body is the
      // documented-safe response, not a guess. `body` was built ONCE above and is handed through
      // by reference — fix-wave R4 finding 5: rebuilding it would mint a new `clientRequestId`,
      // and the retry would then create a SECOND order rather than being recognized as the same
      // request the first attempt already committed under another tab's (or its own) save.
      const result = await submitWithConflictRetry(body, submitOnce);
      saveSucceeded();
      const printIntent = print && !result.deduped && preview
        ? prepareOrderPrintIntent(result, selection, preview.loads) : null;
      if (result.warnings.length > 0) {
        // Owner ruling, applied (HANDOFF issue #4 heritage: skipped/degraded outcomes are named
        // visibly, never silently) — a credit-hold or serialization warning returned alongside a
        // successful save must be SEEN, not raced past by an immediate navigate. Zero warnings
        // keeps the immediate navigate below; this is the one case that doesn't.
        setSaving(false);
        setSavedOrder({
          id: result.order.id, orderNumber: result.order.orderNumber, warnings: result.warnings, print: print && !result.deduped, intent: printIntent,
        });
      } else {
        // createOrder clears the caller's draft inside the SAME transaction as the save — a
        // second, client-side DELETE here would be redundant and racy against that clear.
        openSavedOrder(result.order.id, print && !result.deduped, printIntent);
      }
    } catch (e) {
      if (e instanceof UnreadableAnswerError) {
        // #547 (owner ruling 2026-10-18): the 2xx committed the order, and createOrder cleared the
        // server draft in that transaction, so the draft is never sent again: saveSucceeded freezes
        // it as a landed save does (no autosave, typing ignored). Save stays enabled and takes the
        // cursor. A retried Save builds its body from the same frozen draft, so it carries the same
        // clientRequestId, and createOrder's idempotency read answers with this order (deduped: no
        // warnings and no automatic print, which the owner's sentence names).
        setSaving(false);
        saveSucceeded();
        reveal({
          message: "The order was saved, but the answer could not be read. Click Save only again to open it. Its travelers will not print automatically, and save warnings were not shown: check the customer's credit hold on the customer page and the order's Serials.",
          tab: activeTab, fieldId: "entry-save", fieldIds: [],
        });
        return;
      }
      // §5.13: no reload after an error. Every field above is left exactly as typed so the user
      // can fix the one thing that was wrong and retry without losing anything else.
      saveFailed();
      setSaving(false);
      if (e instanceof ApiError && e.status === 412) {
        // No automatic resubmission: the next click must follow review of the refreshed plan.
        setRefreshPlan(value => value + 1);
        refuse([{ message: `${e.message} Review the refreshed process and load plan, then click Save only again.`, tab: "process", fieldId: "entry-refresh-plan" }]);
      } else refuse([serverProblem(e instanceof Error ? e.message : "Save failed")]);
    }
  }

  // Save's refusals (owner ruling R13; G2-5): the page-top banner, drawn inside the workspace's
  // sticky header so it stays on screen while the cursor's box is centred; a long list scrolls
  // inside it (owner answer 2026-10-29).
  const saveAlert = error && (
    <div role="alert" className={`${NOTICE.refusal} max-h-[33vh] overflow-y-auto whitespace-pre-line`}>
      {error.message}
      <button type="button" onClick={() => reveal({ ...error })} className="ml-2 underline">
        Review in {error.tab === "details" ? "Order details" : error.tab === "parts" ? "Parts & containers" : "Process & loads"}
      </button>
    </div>
  );

  return (
    <div className="min-w-0 p-4 sm:p-6">
      {(!draftReady || savedOrder || (saveGate.allowed && readiness === null) || readiness?.ready === false) &&
        <PageHeader title="New order" actions={<Link href="/" className={BUTTON_NEUTRAL}>Back to orders</Link>} />}

      {/* Save's refusals show in the workspace's sticky header (`saveAlert`); this slot keeps the
          permission read's and the draft prompt's, which can show before the workspace mounts. */}
      {!error && (permsError ?? draftPromptError) && (
        <div role="alert" className={`${NOTICE.refusal} mb-3 whitespace-pre-line`}>
          {permsError ?? draftPromptError}
        </div>
      )}
      {/* Each in its own line, so a list read's failure never hides the autosave's (#664). */}
      {loadError && <p className={`${NOTICE.warning} mb-3`}>{loadError}</p>}
      {autosaveError && <p className={`${NOTICE.warning} mb-3`}>{autosaveError}</p>}

      {saveGate.allowed && readiness === null ? (
        // Wait for the readiness predicate before rendering the form, so a fast user can't start or
        // submit an order in the window before the gate result arrives (Codex).
        <p className="text-sm text-ink-500">Checking setup…</p>
      ) : readiness && !readiness.ready ? (
        // Phase 8B §5.6: real order entry is blocked until company identity + a chart of accounts
        // are configured. The form is replaced (not merely disabled) by a notice linking to /setup.
        <div className="rounded border border-accent-600 bg-accent-50 p-4">
          <p className="mb-2 font-medium text-accent-600">Finish setup before entering orders</p>
          <ul className="mb-3 list-disc space-y-0.5 pl-5 text-sm text-accent-600">
            {readiness.gaps.map((g, i) => <li key={i}>{g.label}</li>)}
          </ul>
          <Link href="/setup" className="inline-block rounded bg-ink-900 px-4 py-2 text-sm text-white">
            Go to setup
          </Link>
        </div>
      ) : savedOrder ? (
        // Owner ruling, applied (HANDOFF issue #4 heritage — a degraded/flagged outcome is named
        // visibly, never silently): a save that succeeded WITH warnings stops here instead of
        // navigating straight past them. The form is gone (not merely disabled) — draft state is
        // never touched again post-save (the autosave controller), so there is nothing left to autosave
        // regardless, and there is nothing here for a stray keystroke to land in.
        <div className="rounded border border-success-700 bg-success-50 p-4">
          <p className="mb-2 font-medium">Order #{savedOrder.orderNumber} saved.</p>
          <ul className="mb-3 list-disc space-y-0.5 pl-5 text-sm text-accent-600">
            {savedOrder.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
          <button type="button"
                  onClick={() => openSavedOrder(savedOrder.id, savedOrder.print, savedOrder.intent)}
                  className={BUTTON_PRIMARY_COMPACT}>
            {savedOrder.print ? "Go to order and print" : "Go to order"}
          </button>
        </div>
      ) : (
        <>
          {!draftReady && !draftPrompt && <p className="text-sm text-ink-500">Loading…</p>}

          {draftPrompt && (
            <div className="mb-4 rounded border border-line bg-link-50 p-3 text-sm">
              <p className="mb-2">
                Draft from {formatDateTime(draftPrompt.updatedAt)}
              </p>
              <div className="flex gap-3">
                <button type="button" onClick={resumeDraft} disabled={draftPromptBusy}
                        title={draftPromptBusy ? "Discarding draft…" : undefined}
                        className={BUTTON_PRIMARY_COMPACT}>
                  Resume
                </button>
                <button type="button" onClick={() => void discardDraft()} disabled={draftPromptBusy}
                        title={draftPromptBusy ? "Discarding draft…" : undefined}
                        className={BUTTON_NEUTRAL_COMPACT}>
                  Discard
                </button>
              </div>
            </div>
          )}

          {draftReady && (
            <fieldset disabled={saving} className="min-w-0">
              <EntryWorkspace activeTab={activeTab} onTabChange={setActiveTab} saveState={saveState} alert={saveAlert}
                headerContext={<><span>Customer: {selectedCustomer?.name ?? "—"}</span><span>PO: {displayedPo || "—"}</span></>}
                headerActions={<>
                  <button type="button" onClick={() => void handleSave(true)} disabled={saving || savePrintGate.disabled || !!printProblem}
                    title={savePrintGate.title ?? printProblem ?? undefined} aria-describedby={printReasonShown ? "entry-print-reason" : undefined}
                    className={BUTTON_PRIMARY}>
                    Save &amp; Print{travelerCount === null ? "" : ` ${formatNumber(travelerCount)} travelers`}
                  </button>
                  <button id="entry-save" type="button" onClick={() => void handleSave()} disabled={saving || saveGate.disabled || waitingOnPlan}
                    title={saveGate.title} className={BUTTON_NEUTRAL}>
                    {waitingOnPlan ? "Checking plan…" : saving ? "Saving…" : "Save only"}
                  </button>
                  {printReasonShown && <span id="entry-print-reason" className="max-w-xs text-xs text-ink-500">{printProblem}</span>}
                  {/* The draft persists either way; the ask is what the Shell's guard asked on the old link. */}
                  <ActionMenu items={[{ label: "Back to orders", onSelect: () => { void (async () => { if (await askDiscard({ action: "Leave New order?" })) router.push("/"); })(); } }]} />
                </>}
                summary={<OrderSummary customerName={selectedCustomer?.name ?? null} poNumber={displayedPo} customerJobNo={draft.customerJobNo}
                  leadPartName={leadPartRow ? `${leadPartRow.partNumber} — ${leadPartRow.name}` : null} totalQty={totalQty}
                  totalWeight={totalWeightCents === null ? null : formatEntryWeightCents(String(totalWeightCents))} eachWeight={leadPartRow?.eachWeight ?? null}
                  containerCount={containerCount} preview={preview} availability={planAvailability} travelerCount={travelerCount} />}
                detailsPanel={<div className="space-y-4"><section id="entry-customer" className={CARD}>
                <h2 className="mb-2 font-medium">Customer</h2>
                <Combobox value={draft.customerId} options={customerOptions} onSelect={(id) => patch({ customerId: id })}
                           disabled={!customersGate.allowed} title={customersGate.allowed ? undefined : customersGate.title}
                           placeholder="Customer code or name" ariaLabel="Customer" />
                {/* A resumed draft's customerId can outlive the customer it names (deactivated —
                    listCustomers is active-only by default — or deleted between autosave and
                    resume, caught live while re-verifying this task's own fix for the analogous
                    part case below). Without this the picker just goes silently blank, the exact
                    misrepresenting-stored-data shape this codebase's history keeps flagging as
                    Critical; naming it matches OrderLineCard's "not in this customer's catalog". */}
                {draft.customerId && !selectedCustomer && customers.length > 0 && (
                  <p className={`${NOTICE.warning} mt-2`}>
                    This customer is no longer available — pick a different one.
                  </p>
                )}
                {selectedCustomer?.creditHold && (
                  <p className={`${NOTICE.warning} mt-2`}>
                    ⚠ {selectedCustomer.code} is on credit hold — orders can be entered; shipping will require release.
                  </p>
                )}
                <StandingOrderNotes notes={selectedCustomer?.orderNotes ?? ""} />
              </section>
<section className={CARD}>
                <h2 className="mb-2 font-medium">Reference &amp; dates</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                  <label className="block">
                    PO number
                    <input id="entry-po" value={displayedPo} onChange={(e) => patch({ poOverride: e.target.value })}
                           className={`${INPUT_COMPACT} mt-1 w-full`} />
                  </label>
                  <label className="block">
                    VS reference
                    <input id="entry-vs" value={draft.vsOrderNumber} onChange={(e) => patch({ vsOrderNumber: e.target.value })}
                           className={`${INPUT_COMPACT} mt-1 w-full`} />
                  </label>
                  <label className="block">
                    Customer job
                    {/* §3.22 (Task 17): the customer's own job number, printed on the shipping
                        ticket beside the PO. Plain typed state, no derivation to override. */}
                    <input id="entry-job" value={draft.customerJobNo} onChange={(e) => patch({ customerJobNo: e.target.value })}
                           className={`${INPUT_COMPACT} mt-1 w-full`} />
                  </label>
                  <label className="block">
                    Received date
                    <input id="entry-received" type="date" value={displayedReceivedDate}
                           onChange={(e) => patch({ receivedDateOverride: e.target.value })}
                           className={`${INPUT_COMPACT} mt-1 w-full`} />
                  </label>
                  <div>
                    <label className="block">
                      Request date
                      <input id="entry-request" type="date" value={displayedRequestDate}
                             onChange={(e) => patch({ requestDateOverride: e.target.value })}
                             className={`${INPUT_COMPACT} mt-1 w-full`} />
                    </label>
                    {/* #664: why no date was worked out. The permission, once the permissions have
                        been read, with a customer picked; or the read's own failure. */}
                    {customerId && perms !== undefined && !ordersViewAllowed && <p className={`mt-1 ${TEXT_MUTED}`}>{ordersViewGate.title}</p>}
                    <PanelMessage message={entryDefaultsError} />
                  </div>
                  <label className="block">
                    Target date
                    <input id="entry-target" type="date" value={draft.targetDate ?? ""}
                           onChange={(e) => patch({ targetDate: e.target.value || null })}
                           className={`${INPUT_COMPACT} mt-1 w-full`} />
                  </label>
                </div>
              </section>
<section className={CARD}>
                <h2 className="mb-2 font-medium">Certification</h2>
                {/* Spec §6.1/§11 (Task 17): the RESOLVED preview with an override. The untouched
                    state re-derives from the picked parts on every render (the 2C-3 rule — see
                    the derivation beside displayedPo above); touching a control records an
                    explicit override that wins until "reset to resolved", and only an override
                    ever travels in the create body — the server re-resolves and freezes its own
                    answer otherwise. Until a lead part is picked there is nothing to resolve, so
                    the controls are disabled saying exactly that (§5.16), never showing a
                    made-up "No". */}
                {!certPreviewReady && (
                  <p className="mb-2 text-sm text-ink-500">Pick a lead part to resolve the certification requirement.</p>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                  <div className="block">
                    <span className="flex items-center gap-2">
                      <label htmlFor="entry-cert-required">Certification required</label>
                      <select id="entry-cert-required" value={displayedCertRequired ? "yes" : "no"}
                              disabled={!certPreviewReady}
                              title={certPreviewReady ? undefined : "Pick a lead part first"}
                              onChange={(e) => patch({ certRequiredOverride: e.target.value === "yes" })}
                              className={`${INPUT_COMPACT} disabled:bg-surface-50`}>
                        <option value="yes">Yes</option>
                        <option value="no">No</option>
                      </select>
                      {draft.certRequiredOverride !== null && (
                        <button type="button" onClick={() => patch({ certRequiredOverride: null })}
                                className={`${LINK} text-xs`}>
                          overridden — reset to resolved
                        </button>
                      )}
                    </span>
                    {certPreviewReady && draft.certRequiredOverride === null && (
                      <span className="mt-1 block text-xs text-ink-500">
                        Resolved from the part/customer settings: {resolvedCertRequired ? "Yes" : "No"}.
                      </span>
                    )}
                  </div>
                  <div className="block">
                    <label className="block">
                      Certification scope
                      <select value={displayedCertScope ?? ""} disabled={!certPreviewReady}
                              title={certPreviewReady ? undefined : "Pick a lead part first"}
                              onChange={(e) => patch({ certScopeOverride: e.target.value === "" ? null : e.target.value as CertScopeValue })}
                              className={`${INPUT_COMPACT} mt-1 w-full disabled:bg-surface-50`}>
                        {!certPreviewReady && <option value="">—</option>}
                        {CERT_SCOPES.map((s) => <option key={s} value={s}>{CERT_SCOPE_LABELS[s]}</option>)}
                      </select>
                    </label>
                    {certPreviewReady && (draft.certScopeOverride === null ? (
                      <span className="mt-1 block text-xs text-ink-500">
                        Resolved from the lead part: {CERT_SCOPE_LABELS[resolvedCertScope!]}.
                      </span>
                    ) : (
                      <button type="button" onClick={() => patch({ certScopeOverride: null })}
                              className={`${LINK} mt-1 text-xs`}>
                        overridden — reset to resolved
                      </button>
                    ))}
                  </div>
                </div>
              </section>
<section className={CARD}>
                <h2 className="mb-2 font-medium">Order notes</h2>
                <textarea id="entry-notes" aria-label="Order notes" value={draft.notes} onChange={(e) => patch({ notes: e.target.value })} rows={3}
                          className={`${INPUT_COMPACT} w-full`} />
              </section>
<section className={CARD}>
                <h2 className="mb-2 text-lg font-semibold">Extra charges</h2>
                <p className="mb-2 text-sm text-ink-500">{draft.charges.length === 0 ? "None." : `${draft.charges.length} charge${draft.charges.length === 1 ? "" : "s"} entered.`}</p>
                <button type="button" onClick={() => setChargesOpen(true)} className={BUTTON_NEUTRAL}>
                  Review extra charges{draft.charges.length > 0 ? ` (${draft.charges.length})` : ""}
                </button>
              </section>
              <ChargesDialog open={chargesOpen} onClose={() => setChargesOpen(false)}>
                {draft.charges.length === 0 && <p className="text-sm text-ink-500">None.</p>}
                {draft.charges.map((c, i) => (
                  <div key={c.id} className="mb-2 flex flex-wrap items-end gap-2 text-sm">
                    <label className="block min-w-0 flex-1">
                      Description
                      <input id={`entry-charge-${c.id}-description`} value={c.description} onChange={(e) => patchCharge(c.id, { description: e.target.value })}
                             aria-label={`Charge ${i + 1} description`} className={`${INPUT_COMPACT} mt-1 w-full`} />
                    </label>
                    <label className="block w-32">
                      {CHARGE_AMOUNT.label}
                      <input id={`entry-charge-${c.id}-amount`} value={c.amount} inputMode="decimal" placeholder="needs price"
                             onChange={(e) => patchCharge(c.id, { amount: e.target.value })}
                             aria-label={`Charge ${i + 1} amount`} className={`${INPUT_COMPACT} mt-1 w-full`} />
                    </label>
                    <button type="button" onClick={() => removeCharge(c.id)} className="text-xs text-red-600">Remove</button>
                  </div>
                ))}
                <button type="button" onClick={addCharge} className={`${LINK} text-sm`}>Add charge</button>
              </ChargesDialog></div>}
                partsPanel={<div className="space-y-4"><section className={CARD}>
                <h2 className="mb-2 font-medium">Part lines</h2>
                {!draft.customerId && <p className="mb-2 text-sm text-ink-500">Pick a customer to add part lines.</p>}
                {draft.lines.map((line, i) => (
                  <OrderLineCard coordinatedProcess onSerialProblem={onSerialProblem} serialError={error?.fieldIds.some((id) => id.startsWith(`entry-line-${line.id}-serial`))} key={line.id} index={i} isLead={i === 0} line={line} parts={customerParts}
                                 customerChosen={!!draft.customerId} partsGate={partsGate} processesGate={processesGate}
                                 customerId={draft.customerId}
                                 // Untouched = undefined = the param is OMITTED and the preview
                                 // uses the server's own today, exactly like the save would
                                 // (QuoteLinkPicker's contract). A change re-runs every line's
                                 // preview — all entry lines are unsaved, so this is precisely
                                 // ruling 6's "refresh the preview for unsaved lines".
                                 receivedDate={readReceivedDate ?? undefined}
                                 ordersViewAllowed={ordersViewGate.allowed} quotePickGate={saveGate}
                                 onChange={(p) => patchLine(line.id, p)}
                                 onRemove={draft.lines.length > 1 ? () => removeLine(line.id) : undefined}
                                 onLeadValidity={i === 0 ? onLeadValidity : undefined} />
                ))}
                <button id="entry-add-line" type="button" onClick={addLine} className={`${LINK} text-sm`}>Add part line</button>
              </section>
<section className={CARD}>
                <h2 className="mb-2 font-medium">Containers</h2>
                <p className="mb-3 text-xs text-ink-500">Customer packaging, independent of furnace loads.</p>
                {containerTypesFailed && <p className={`${NOTICE.warning} mb-3`}>{CONTAINER_TYPES_NOT_LOADED}</p>}
                {draft.containers.length === 0 && <p className="text-sm text-ink-500">None.</p>}
                {draft.containers.map((c, i) => (
                  <EntryContainerRow key={c.id} container={c} index={i} containerTypes={containerTypes}
                                     errorFieldIds={error?.fieldIds ?? []}
                                     onChange={(p) => patchContainer(c.id, p)}
                                     onRemove={() => removeContainer(c.id)} />
                ))}
                <button id={ADD_CONTAINER_ID} type="button" onClick={addContainer} className={`${LINK} text-sm`}>Add container</button>
                <OrderTotalsTable totals={totals} />
              </section></div>}
                processPanel={<ProcessLoadsPanel leadPartName={leadPartRow ? `${leadPartRow.partNumber} — ${leadPartRow.name}` : null}
                  processesGate={processesGate} preview={preview} availability={planAvailability} error={currentState?.error ?? null}
                  adjustment={draft.loadAdjustmentDraft} onAdjustmentChange={loadAdjustmentDraft => patch({ loadAdjustmentDraft })}
                  selection={selection} onSelectionChange={travelerSelection => patch({ travelerSelection })}
                  onRefresh={() => setRefreshPlan(value => value + 1)} notice={planNotice} />} />
            </fieldset>
          )}
        </>
      )}
    </div>
  );
}
