"use client";
import { formatDate, formatDateTime, formatNumber } from "@/lib/format";
// The quote page's body (spec §5.1; task-08-brief.md item 2). Remounted per id by page.tsx's
// `key={id}` (HANDOFF §5.12). The document-owned quote binding carries one raw
// draft per authenticated quote; each returned view requires fresh recovery access.
//
// THE BINDING STATE MODEL — a SINGLE-SAVE form, deliberately NOT the optimistic per-field PATCH
// the sibling detail pages use: `PATCH /api/quotes/[id]` is the only write surface for header
// AND line tree alike (Task 4's array-replace), and the notes pair (`notes`/`internalNotes`)
// riding one form with one Save is the brief's named defense against the three-page
// optimistic-PATCH notes-clobber family — this page must not become its fourth member. The form
// is an explicit draft over the last-loaded server detail:
//
//  - Save sends the CLIENT-SIDE DIFF (quote-form.ts: changed header keys only, plus `lines`
//    only when the tree changed), so an untouched load→save is a server-side no-op — nothing is
//    even sent (Save stays disabled), and a partial edit writes exactly what changed, with
//    `eachWeight` carried on free-text lines (the Task 4 Minor this page exists to fix).
//  - A failed save KEEPS the draft and surfaces the server's message verbatim (the
//    InvoiceLinesGrid precedent): nothing was optimistic, so there is no divergence to roll
//    back — §5.13's rollback-first rule applies to the page's optimistic surfaces (none here)
//    and to the actions below, which reload server truth before reporting.
//  - Actions that ADOPT a fresh server detail (close/reopen/attach-part) are disabled while the
//    form is dirty — adopting would silently discard the draft — with a title saying so.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ApiError, api, trackedFetch } from "@/lib/fetcher";
import { gate, gateDo, type Gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { HistoryPanel, invalidateHistory } from "@/components/HistoryPanel";
import { DangerButton } from "@/components/DangerButton";
import { ActionMenu } from "@/components/ActionMenu";
import { PageHeader } from "@/components/PageHeader";
import { RecordTabs } from "@/components/RecordTabs";
import { AtAGlance } from "@/components/AtAGlance";
import { BlockerPanel, type Blocker } from "@/components/BlockerPanel";
import { PRICE_PER, PRICE_PER_LABELS, type PricePerValue } from "@/lib/part-constants";
import { priceBasisAsks, priceBasisQuestion } from "@/lib/price-basis-question";
import { QUOTE_STATUS_LABELS, QUOTE_EXPIRED_LABEL } from "@/lib/quote-constants";
import { DraftRecoveryNotice } from "@/components/DraftRecoveryNotice";
import { getBrowserDraftSession, peekBrowserDraftSession } from "@/lib/draft-session";
import { useDraftIdentity, useRecoverableDraft } from "@/lib/use-recoverable-draft";
import {
  quoteBaselineFrom, quoteDraftFrom, quoteRecoveryAdapter,
  addQuoteLine, addQuotePrice, addQuoteBreak, removeQuoteLine, removeQuotePrice,
  runQuoteSave, runQuoteNative, runQuoteDelete,
  type QuoteBinding, type QuoteBaseline, type QuoteRecoveryCatalogs,
} from "@/lib/quote-recovery";
import { useUnsavedSection } from "@/lib/use-unsaved-section";
import {
  breakDraftStarted as anyBreakDraftStarted, patchBreakDraft, EMPTY_BREAK_DRAFT,
} from "@/lib/break-drafts";
import {
  headerPatch, linesComparable, materialOptions, pickMaterial, freeTextFromPart, partDisplayFor, BLANK_PART_DISPLAY,
  type HeaderForm, type PartDisplay, type LineForm, type LinkedOrderRef, type PriceForm,
  type QuoteCloseResultData, type QuoteDetailData, type QuoteMutationData,
} from "../quote-form";
import { newId } from "@/lib/client-id";
import { moveGate } from "@/lib/reorder";
import { EACH_WEIGHT_LB } from "@/lib/weight-terms";
import { oneShotHold } from "@/lib/single-flight";
import { BREAK_PRICE, BREAK_THRESHOLD, MINIMUM_CHARGE, SETUP_CHARGE, UNIT_PRICE } from "@/lib/price-boxes";
import { ListStatus, PageStatus } from "@/components/PageStatus";
import { useStoredDocuments } from "@/lib/use-stored-documents";
import { UnsavedBadge } from "@/components/UnsavedBadge";
import { askConfirm, askReason } from "@/lib/modal";
import { QUOTE_DETAILS_SECTION, QUOTE_LINES_SECTION, QUOTE_TAB_LABEL, quoteTabs } from "@/lib/quote-tabs";
import {
  BUTTON_NEUTRAL, BUTTON_NEUTRAL_COMPACT, BUTTON_PRIMARY, BUTTON_PRIMARY_COMPACT, CARD, INPUT_COMPACT, LINK, NOTICE,
} from "@/lib/ui-classes";
import { Combobox } from "@/components/Combobox";
import { labelledOptions, partOptions } from "@/lib/menu-options";
import { inMenuOrder } from "@/lib/menu-order";

// Picker option slices (local mirrors, never src/server/** imports — CLAUDE.md).
type ContactOption = { id: string; name: string; active: boolean };
type UserOption = { id: string; displayName: string; active: boolean };
type PickListOption = { id: string; name: string; active: boolean };
type PartOption = {
  id: string; customerId: string; partNumber: string; name: string;
  materialId: string | null; materialName: string | null; eachWeight: number; active: boolean;
};
/** Slice of the quote documents list (kind QUOTE — Task 10's print route archives into it;
 *  mirrors the invoices documents shape). */
type StoredDoc = { id: string; kind: string; createdAt: string };

/** Lock every editing control on a CLOSED or deleted quote (the InvoiceDetail `statusLocked`
 *  shape): the service refuses non-OPEN edits, so the controls say so up front (§5.16 style —
 *  disabled with the reason, never hidden). */
function statusLocked(g: Gate, closed: boolean, deleted: boolean): Gate {
  if (deleted) return { allowed: false, disabled: true, title: "Quote is deleted" };
  if (closed) return { allowed: false, disabled: true, title: "This quote is closed — reopen it before editing" };
  return g;
}

/** The stored-documents list — mirrors InvoiceDocumentsList (InvoiceDetail.tsx). Task 8 wired
 *  this section one task ahead of the route (the invoices Task 18→19 precedent, 404 rendered as
 *  the empty state); Task 10 landed `GET /api/quotes/[id]/documents` at exactly this path, so a
 *  failure now surfaces as the error it is. */
function QuoteDocumentsList({ quoteId, viewGate, refresh }: {
  quoteId: string; viewGate: Gate;
  /** Bumped by every successful print, so a just-archived document appears without a reload. */
  refresh: number;
}) {
  // The shared read and state (P6 step 3, #632): "Loading…" until a read lands, never the empty
  // sentence before then, and a read that lands clears an earlier failure.
  const { docs, error: err, status } = useStoredDocuments<StoredDoc>(`/api/quotes/${quoteId}/documents`, viewGate.allowed, refresh);

  if (status !== "rows") return <ListStatus status={status} denied={viewGate.title} error={err} empty="Nothing printed yet." />;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-ink-500">
          <th className="py-1 font-medium">Type</th><th className="font-medium">Created</th>
          <th className="font-medium"><span className="sr-only">Open</span></th>
        </tr>
      </thead>
      <tbody>
        {/* Type / Created and an "Open PDF" link column (owner 2026-10-31, #818). */}
        {docs.map((d) => (
          <tr key={d.id} className="border-t">
            <td className="py-1">{d.kind === "QUOTE" ? "Quote" : d.kind}</td>
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

/** The §5.14 delete-blocker list, derived from the detail payload itself: every line's
 *  `linkedOrders` is exactly the live-order predicate `quoteOrderBlockers` refuses over
 *  (quotes.ts reads both from `OrderLine.quoteLineId` with voided orders excluded), so the
 *  panel needs no extra route — the Excel export rides the existing blockers/export route. */
function blockersFrom(d: QuoteDetailData): Blocker[] {
  const seen = new Map<string, number>();
  for (const l of d.lines) for (const o of l.linkedOrders) seen.set(o.id, o.orderNumber);
  return [...seen.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([id, n]) => ({ entityLabel: "Order", name: `#${n}`, id, href: `/orders/${id}` }));
}

const linkedOrderNumbers = (orders: LinkedOrderRef[]): string =>
  orders.map((o) => `#${o.orderNumber}`).join(", ");

/** Live part identity beside the quote's part picker; free-text fields keep their own raw values. */
export function QuotePartSummary({ display }: {
  display: { name: string; material: string; eachWeight: string } | null;
}) {
  return (
    <div className="text-xs text-ink-500">
      {display?.name}{display?.material ? ` · ${display.material}` : ""}
      {display?.eachWeight ? ` · ${formatNumber(display.eachWeight, 4)} lb each` : ""} (live from the part)
    </div>
  );
}

export function QuoteDetail({ id }: { id: string }) {
  const router = useRouter();
  const { permissions: loadedPerms, error: permsError } = usePermissions();

  const [detail, setDetail] = useState<QuoteDetailData | null>(null);
  const { store, ...drafts } = useDraftIdentity();
  const authorizationRevision = peekBrowserDraftSession()?.getReadAuthorizationRevision() ?? 0;
  const [binding, setBinding] = useState<QuoteBinding | null>(null);
  const view = useRecoverableDraft(binding);
  const perms = view.savedBaseline ? [...view.savedBaseline.catalogs.permissions] : loadedPerms;
  const readIdRef = useRef(0);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!store || !drafts.identityReady || !drafts.owner) { setBinding(null); return; }
    setBinding(store.bind({ owner: drafts.owner, record: { kind: "quote", id }, editor: quoteRecoveryAdapter.kind },
      { label: "Quote", href: `/quotes/${id}` }, quoteRecoveryAdapter));
  }, [id, store, drafts.identityReady, drafts.owner]);
  // Accepted native Close keeps a read-only current copy whose baseline is the
  // exact accepted saved object. Ordinary return never receives this provenance.
  const nativeReadonly = !!view.reference && !view.current && view.reference.baseline === view.savedBaseline;
  const data = view.mode === "editing" ? view.current?.data
    : nativeReadonly ? view.reference?.data : view.savedBaseline ? quoteDraftFrom(view.savedBaseline) : undefined;
  const header = data?.header ?? null;
  const lines = data?.lines ?? [];
  const breakDrafts = data?.breakDrafts ?? {};
  const recoveryBlocked = !!view.reference && !nativeReadonly || (!!view.current && view.mode !== "editing");
  const patchHeader = (patch: Partial<HeaderForm>) => binding?.change(d => ({ ...d, header: { ...d.header, ...patch } }));
  const changeLines = (reduce: (lines: LineForm[]) => LineForm[]) => binding?.change(d => ({ ...d, lines: reduce(d.lines) }));
  const [error, setError] = useState<string | null>(null);
  // Pick-list failures get their own banner, never cleared by a later successful save (the
  // parts/[id] F9 `loadError` pattern) — the affected select stays honest via its synthesized
  // current-value option meanwhile.
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [closeWarning, setCloseWarning] = useState<LinkedOrderRef[] | null>(null);
  // Ruling 7's overlap-save warnings (amber, non-blocking — the ShipmentDetail warnings banner).
  // Set ONLY from mutation responses (Save and attach-part carry them; GET does not), and load()
  // deliberately never touches this state — so a reload that follows the save (§5.13's
  // rollback-first refresh after some LATER failed action, or any other adopt) cannot clear a
  // warning the save just raised. Navigation dismisses it: page.tsx remounts this component per
  // id. A later save with ZERO warnings replaces it with the empty surface — the fresh save's
  // truth (the §5.7 full-surface rule).
  const [overlapWarnings, setOverlapWarnings] = useState<string[]>([]);
  const [blocked, setBlocked] = useState<{ list: Blocker[] } | null>(null);

  const draftFor = (priceKey: string) => breakDrafts[priceKey] ?? EMPTY_BREAK_DRAFT;

  // Read authorization is captured before detail, permission and catalog awaits.
  // The accepted baseline is the only draft authority; detail is presentation.
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [statements, setStatements] = useState<PickListOption[]>([]);
  const [stepCodes, setStepCodes] = useState<PickListOption[]>([]);
  const [stepCodesReady, setStepCodesReady] = useState(false);
  const [parts, setParts] = useState<PartOption[]>([]);
  // The Materials pick list (#541) for a free-text line's drop-down; null while unread or when
  // its read failed, which greys the select (the parts/[id] IdentitySection `materialsReady`).
  const [materials, setMaterials] = useState<PickListOption[] | null>(null);

  // Who is reading, checked before any catalog is asked for (#618 split it out of `readCatalogs`
  // so `load` can send it beside the quote GET): the signed-in user must be the draft session's
  // owner (the draft-recovery design's identity-before-retained-content rule) and hold quotes.view.
  const checkIdentity = useCallback(async (): Promise<readonly string[]> => {
    const me = await api<{ id: string; permissions: string[] }>("/api/auth/me");
    const session = getBrowserDraftSession();
    if (session?.store.getSnapshot().owner?.userId !== me.id) throw new Error("Confirm your identity to access this quote.");
    if (!me.permissions.includes("quotes.view")) throw new Error("Requires quotes.view");
    return me.permissions;
  }, []);
  // The six catalogs in one wave, under permissions `checkIdentity` has already answered for.
  const readCatalogs = useCallback(async (customerId: string, permissions: readonly string[]): Promise<QuoteRecoveryCatalogs> => {
    const [contacts, users, statements, steps, parts, materials] = await Promise.all([
      permissions.includes("customers.view") ? api<ContactOption[]>(`/api/customers/${customerId}/contacts?includeInactive=1`) : Promise.resolve([]),
      permissions.includes("action.manage_users") ? api<UserOption[]>("/api/admin/users") : Promise.resolve([]),
      api<PickListOption[]>("/api/picklists/endingStatement?includeInactive=1"),
      api<PickListOption[]>("/api/picklists/processStepCode?includeInactive=1"),
      // One customer's parts (#614), inactive included: a stored pick may name a since-inactive part.
      permissions.includes("parts.view") ? api<PartOption[]>(`/api/parts?includeInactive=1&customerId=${customerId}`) : Promise.resolve([]),
      // Never rejects: a failed Materials read greys one select and must not fail the page (#541).
      api<PickListOption[]>("/api/picklists/material?includeInactive=1").then(rows => rows, () => null),
    ]);
    return { permissions, contacts, users, statements, steps, parts, materials };
  }, []);
  const showAccepted = useCallback((d: QuoteDetailData, baseline: QuoteBaseline) => {
    setDetail(d); setContacts([...baseline.catalogs.contacts]); setUsers([...baseline.catalogs.users]);
    setStatements([...baseline.catalogs.statements]); setStepCodes([...baseline.catalogs.steps]); setStepCodesReady(true);
    setParts(baseline.catalogs.parts.map(p => ({ ...p, materialId: p.materialId ?? null, materialName: p.materialName ?? null, eachWeight: p.eachWeight ?? 0 })));
    setMaterials(baseline.catalogs.materials === null ? null : [...baseline.catalogs.materials]);
    setOptionsError(null);
  }, []);
  const load = useCallback(async () => {
    const session = getBrowserDraftSession(); const ticket = session?.readAuthorizationTicket();
    if (!binding || !session || !ticket) return;
    let readId = binding.beginRead();
    // A settled Save may supersede a return read while catalogs are in flight.
    // Only the original source-qualified read may request one fresh continuation.
    for (let attempt = 0; attempt < 2; attempt++) {
      const requirements = binding.readRequirements(readId);
      if (!requirements || !mounted.current || !session.isReadAuthorized(ticket)) return;
      try {
        if (requirements.quoteId !== undefined && requirements.quoteId !== id) throw new Error("The quote response did not match this editor.");
        // The quote GET first, /me beside it (#618: one round trip, not two); the catalogs wait for
        // both, so the quote's identity and the reader's are checked before any catalog request.
        const [d, permissions] = await Promise.all([api<QuoteDetailData>(`/api/quotes/${id}`), checkIdentity()]);
        if (!mounted.current || !session.isReadAuthorized(ticket)) return;
        if (d.id !== id || (requirements.customerId !== undefined && requirements.customerId !== d.customerId)) throw new Error("The quote response did not match this editor.");
        const catalogs = await readCatalogs(d.customerId, permissions);
        if (!mounted.current || !session.isReadAuthorized(ticket)) return;
        const baseline = quoteBaselineFrom(d, catalogs);
        const editable = catalogs.permissions.includes("quotes.edit") && d.status === "OPEN" && d.deletedAt === null;
        if (binding.acceptRead({ kind: "authorized", readId, baseline, editable }, quoteDraftFrom(baseline))) {
          readIdRef.current = readId; showAccepted(d, baseline); setError(null); return;
        }
      } catch (error) {
        if (!mounted.current || !session.isReadAuthorized(ticket)) return;
        if (binding.acceptRead({ kind: "unavailable", readId }, {} as never)) {
          setError((error as Error).message); throw error;
        }
      }
      if (attempt !== 0 || !mounted.current || !session.isReadAuthorized(ticket)) return;
      const restarted = binding.restartReadAfterChange(readId);
      if (restarted === null) return;
      readId = restarted;
    }
  }, [binding, id, checkIdentity, readCatalogs, showAccepted]);
  useEffect(() => {
    // Cleanup forbids StrictMode's abandoned request from presenting values;
    // the binding's lease and pre-await ticket independently reject its read.
    let stale = false;
    void load().catch(e => { if (!stale) setError((e as Error).message); });
    return () => { stale = true; };
  }, [load, authorizationRevision]);

  // ---- Dirty tracking: the loaded detail IS the baseline; both diffs derive from it. ----
  const baseHeader = view.current?.baseline.header ?? view.savedBaseline?.header ?? null;
  const patch = header !== null && baseHeader !== null ? headerPatch(header, baseHeader) : {};
  const linesDirty = !!data && !!view.current && linesComparable(lines) !== linesComparable(view.current.baseline.lines);
  const dirty = Object.keys(patch).length > 0 || linesDirty;
  const rawDraftRetained = !!view.current && quoteRecoveryAdapter.dirty(view.current.data, view.current.baseline);

  // ---- Gates (§5.16: every gated control disabled WITH the reason, via the shared helper). ----
  const closed = detail?.status === "CLOSED";
  const deleted = (detail?.deletedAt ?? null) !== null;
  const editGateRaw = gate(perms, "quotes.edit");
  const statusGate = statusLocked(editGateRaw, closed, deleted);
  const editGate = view.mode !== "editing" || view.needsRefresh ? { allowed: false, disabled: true, title: "Resolve retained changes before editing" } : statusGate;
  const customersGate = gate(perms, "customers.view");
  const partsGate = gate(perms, "parts.view");
  const usersGate = gateDo(perms, "manage_users");
  const docsGate = gate(perms, "quotes.view");

  /** Actions that adopt a fresh detail are locked while the form holds unsaved edits. */
  const dirtyLocked = (g: Gate): Gate =>
    (g.allowed && (dirty || recoveryBlocked) ? { allowed: false, disabled: true, title: "Save or discard your changes first" } : g);

  const closeGate: Gate = dirtyLocked(deleted
    ? { allowed: false, disabled: true, title: "Quote is deleted" }
    : closed
      ? { allowed: false, disabled: true, title: "Already closed" }
      : editGateRaw);
  const reopenGate: Gate = dirtyLocked(deleted
    ? { allowed: false, disabled: true, title: "Quote is deleted" }
    : !closed
      ? { allowed: false, disabled: true, title: "This quote is not closed" }
      : editGateRaw);
  const deleteGate: Gate = deleted
    ? { allowed: false, disabled: true, title: "Already deleted" }
    : gate(perms, "quotes.delete");
  // Print (Task 10) — gated on the area's OWN .view permission, locked only by "deleted" (the
  // InvoiceDetail printGate / traveler-print precedent: printing is a read of the document, and
  // the one state that refuses a NEW print is a voided owner — the server's shared VOIDED_PRINT
  // guard; a CLOSED or expired quote still prints the agreement it records).
  // Sixth path on the archival rule (Codex P1, round 7). `printQuote` posts no header or line
  // draft, so the endpoint renders and ARCHIVES a document built from server state — a stored
  // quote that disagrees with what the operator is looking at.
  const printGate: Gate = deleted
    ? { allowed: false, disabled: true, title: "Quote is deleted — nothing to print" }
    : (dirty || recoveryBlocked)
      ? { allowed: false, disabled: true, title: "Save the changes first — a print archives what the server holds" }
      : gate(perms, "quotes.view");

  // Compound picker gates (the PricingSection two-gate precedent): the control needs quotes.edit
  // AND the permission its options ride on; the title names whichever is actually the blocker.
  const contactGate: Gate = editGate.disabled ? editGate
    : customersGate.allowed ? editGate : { allowed: false, disabled: true, title: customersGate.title };
  const quotedByGate: Gate = editGate.disabled ? editGate
    : usersGate.allowed ? editGate : { allowed: false, disabled: true, title: usersGate.title };

  // ---- Pick-lists (§5.15: ending statements + step codes via /api/picklists; contacts/users/
  // parts from their own guarded reads, fetched only when the gate allows — never silently
  // empty for someone who lacks the permission). includeInactive=1 throughout: a stored pick may
  // point at a row that has since gone inactive (the PricingSection precedent). ----

  const customerId = detail?.customerId;
  // The read is already this customer's (#614); the filter stays as a belt.
  const customerParts = customerId ? parts.filter((p) => p.customerId === customerId) : [];

  // ---- Save / discard ----

  async function save() {
    if (!binding || !detail || !header || saving || editGate.disabled) return;
    const session = getBrowserDraftSession(); const ticket = session?.readAuthorizationTicket();
    if (!session || !ticket) return;
    setSaving(true);
    try {
      const result = await runQuoteSave({ binding, requestId: newId(),
        write: body => api<QuoteMutationData>(`/api/quotes/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
        rejected: error => error instanceof ApiError && error.status >= 400 && error.status < 500,
        persisted: async res => {
          invalidateHistory();
          if (!mounted.current || !session.isReadAuthorized(ticket)) return;
          setOverlapWarnings(res.warnings); setError(null);
          await load();
        },
      });
      if (mounted.current && session.isReadAuthorized(ticket)) {
        if (result.kind === "invalid") setError(result.error);
        if (result.kind === "failed") setError((result.error as Error).message);
      }
    } catch (error) {
      // Persistence was recorded before these history/read/UI callbacks ran.
      if (mounted.current && session.isReadAuthorized(ticket)) setError((error as Error).message);
    } finally { if (mounted.current) setSaving(false); }
  }

  function discardChanges() {
    if (!binding) return;
    const snapshot = binding.getSnapshot();
    if (snapshot.current) binding.discard(snapshot.current.stamp);
    if (snapshot.reference) binding.discard(snapshot.reference.stamp);
    setError(null);
  }

  async function nativeAction<R>(write: () => Promise<R>, select: (response: R) => QuoteDetailData, show: (response: R) => void, rollback = false) {
    const session = getBrowserDraftSession(); const ticket = session?.readAuthorizationTicket();
    if (!binding || !detail || !session || !ticket) return;
    const result = await runQuoteNative({ binding, write, detail: select,
      catalogs: async () => readCatalogs(detail.customerId, await checkIdentity()), authorized: () => mounted.current && session.isReadAuthorized(ticket),
      acknowledged: invalidateHistory,
      ...(rollback ? { rollback: () => api<QuoteDetailData>(`/api/quotes/${id}`), rolledBack: showAccepted } : {}),
      accepted: (response, baseline) => { showAccepted(select(response), baseline); show(response); },
    });
    if ("readId" in result && typeof result.readId === "number" && (result.kind === "accepted" || result.kind === "failed")) readIdRef.current = result.readId;
    if (result.kind === "failed" && mounted.current && session.isReadAuthorized(ticket)) throw result.error;
    if (result.kind === "accepted" && "warning" in result && result.warning && mounted.current && session.isReadAuthorized(ticket)) throw result.warning;
  }

  // ---- Lifecycle actions ----

  // The three reason dialogs ask through the modal (ruling 5 of 2026-10-30; PR 3): it holds the
  // dialog open on a blank reason with `blankRefusal`, so a reason that comes back is never blank,
  // and resolves null on Cancel, which each keeps checking (§5.17: the reason is required and
  // recorded in the audit history).
  async function closeQuote() {
    if (detail === null || closeGate.disabled) return;
    const reason = await askReason({
      question: `Close quote #${detail.quoteNumber}?\n\nIt stops pricing new orders; orders already ` +
        `linked keep their pricing. Closing is reversible (Reopen).`,
      verb: "closing", blankRefusal: "A reason is required to close a quote.",
    });
    if (reason === null) return; // cancelled
    try {
      await nativeAction(() => api<QuoteCloseResultData>(`/api/quotes/${id}/close`, {
        method: "POST", body: JSON.stringify({ reason }),
      }), res => res.quote, res => {
        setCloseWarning(res.linkedOpenOrders.length > 0 ? res.linkedOpenOrders : null);
        setOverlapWarnings([]); setError(null);
      }, true);
    } catch (e) {
      // The helper already reconciled any raw transport refusal using its original
      // native ticket. Presentation failures never trigger another rollback read.
      if (mounted.current) setError((e as Error).message);
    }
  }

  async function reopenQuote() {
    if (detail === null || reopenGate.disabled) return;
    const reason = await askReason({
      question: `Reopen quote #${detail.quoteNumber}?\n\nIt becomes a standing agreement again and ` +
        `resumes pricing new orders in its window.`,
      verb: "reopening", blankRefusal: "A reason is required to reopen a quote.",
    });
    if (reason === null) return; // cancelled
    try {
      await nativeAction(() => api<QuoteDetailData>(`/api/quotes/${id}/reopen`, {
        method: "POST", body: JSON.stringify({ reason }),
      }), res => res, () => { setError(null); setCloseWarning(null); setOverlapWarnings([]); }, true);
    } catch (e) {
      // The helper already reconciled any raw transport refusal using its original
      // native ticket. Presentation failures never trigger another rollback read.
      if (mounted.current) setError((e as Error).message);
    }
  }

  async function deleteQuote() {
    if (detail === null || deleteGate.disabled) return;
    const reason = await askReason({
      question: `Delete quote #${detail.quoteNumber}?\n\nIts lines and price rows are deleted with it; ` +
        `the quote number is never reused.`,
      verb: "deleting", blankRefusal: "A reason is required to delete a quote.",
    });
    if (reason === null) return; // cancelled
    const session = getBrowserDraftSession(); const ticket = session?.readAuthorizationTicket();
    if (!session || !ticket) return;
    try {
      if (!store) return;
      const retire = binding?.captureRetirement() ?? null;
      await runQuoteDelete({ retire,
        remove: () => api(`/api/quotes/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) }),
        deleted: () => { if (mounted.current && session.isReadAuthorized(ticket)) router.push("/quotes"); },
      });
    } catch (e) {
      if (!mounted.current || !session.isReadAuthorized(ticket)) return;
      const message = (e as Error).message;
      // The §5.14 refusal ("order(s) … still price from it") becomes the discoverable blockers
      // panel (the parts/[id] removePart precedent) — the list derives from a FRESH detail so it
      // names what is blocking right now, with the Excel export riding the existing route.
      // Deliberately NOT adopt(fresh): delete is the one action allowed while the form is dirty
      // (report deviation 3 — "a refusal leaves the draft untouched"), so adopting here would
      // silently discard the user's unsaved edits, the exact clobber the dirty-lock model
      // exists to prevent (review fix round, Important 1). The panel gets the fresh truth; the
      // per-line indicators keep the load-time links until the next adopt — the server guard,
      // not the indicator, is the enforcement.
      if (e instanceof ApiError && e.status === 400 && message.includes("still price from it")) {
        try {
          const fresh = await api<QuoteDetailData>(`/api/quotes/${id}`);
          if (!mounted.current || !session.isReadAuthorized(ticket)) return;
          const list = blockersFrom(fresh);
          if (list.length > 0) { setBlocked({ list }); setError(null); return; }
        } catch (listErr) {
          if (!mounted.current || !session.isReadAuthorized(ticket)) return;
          setError(`${message} — the list of blocking orders could not be refreshed ` +
            `(${(listErr as Error).message}). Try again.`);
          return;
        }
      }
      setError(message);
    }
  }

  // ---- Print (Task 10: POST, open the answered PDF as a blob in a new tab, bump the documents
  // list so the just-archived print appears). REFUSED while the form is dirty, by `printGate`
  // above: the print renders the SAVED quote and files it permanently, so printing over unsaved
  // edits archives paper that disagrees with the screen. (This comment used to say the opposite —
  // "legal while the form is dirty" — and had been false since round 7's Codex P1 added that
  // branch to `printGate`. Found by #277's sweep.) ----

  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const [docsRefresh, setDocsRefresh] = useState(0);

  async function printQuote() {
    if (!printGate.allowed) return;
    setPrinting(true);
    setPrintError(null);
    try {
      const res = await trackedFetch(`/api/quotes/${id}/print`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Print failed (${res.status})`);
      }
      const url = URL.createObjectURL(await res.blob());
      const opened = window.open(url, "_blank");
      if (opened) opened.opener = null;
      if (opened === null) {
        setPrintError("The browser blocked the print window — the document was archived and is in Documents below.");
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setDocsRefresh((n) => n + 1);
    } catch (e) {
      setPrintError((e as Error).message);
    } finally {
      setPrinting(false);
    }
  }

  // ---- Line-tree local edits (saved only by Save) ----

  function patchLine(key: string, linePatch: Partial<LineForm>) {
    changeLines((cur) => cur.map((l) => (l.key === key ? { ...l, ...linePatch } : l)));
  }
  function addLine() { binding?.change(addQuoteLine); }
  function removeLine(key: string) { binding?.change(d => removeQuoteLine(d, key)); }
  function moveLine(index: number, dir: -1 | 1) {
    changeLines((cur) => {
      const j = index + dir;
      if (j < 0 || j >= cur.length) return cur;
      const next = [...cur];
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });
  }
  function patchPrice(lineKey: string, priceKey: string, pricePatch: Partial<PriceForm>) {
    changeLines((cur) => cur.map((l) => (l.key === lineKey
      ? { ...l, prices: l.prices.map((p) => (p.key === priceKey ? { ...p, ...pricePatch } : p)) }
      : l)));
  }
  function addPrice(lineKey: string, stepId: string) {
    const step = stepCodes.find(s => s.id === stepId);
    binding?.change(d => addQuotePrice(d, lineKey, stepId, step?.name ?? ""));
  }
  function removePrice(lineKey: string, priceKey: string) { binding?.change(d => removeQuotePrice(d, lineKey, priceKey)); }
  function movePrice(lineKey: string, index: number, dir: -1 | 1) {
    changeLines((cur) => cur.map((l) => {
      if (l.key !== lineKey) return l;
      const j = index + dir;
      if (j < 0 || j >= l.prices.length) return l;
      const next = [...l.prices];
      [next[index], next[j]] = [next[j], next[index]];
      return { ...l, prices: next };
    }));
  }
  /** The 5A basis-change warning (PricingSection.changePricePer, same wording, asked through the
   *  modal since PR 3): moving a row among the non-LOT units while it has breaks silently changes
   *  what every stored number means — warn, don't refuse, don't re-derive. LOT-with-breaks stays
   *  the server's refusal, surfaced verbatim at save. */
  async function changePricePer(lineKey: string, price: PriceForm, next: PricePerValue) {
    if (next === price.pricePer) return;
    if (priceBasisAsks(price.pricePer, next, price.breaks.length)
      && !await askConfirm(priceBasisQuestion(price.pricePer, next, price.breaks.length))) return;
    patchPrice(lineKey, price.key, { pricePer: next });
  }
  function patchBreak(lineKey: string, priceKey: string, breakKey: string, field: "threshold" | "price", value: string) {
    changeLines((cur) => cur.map((l) => (l.key === lineKey
      ? {
        ...l,
        prices: l.prices.map((p) => (p.key === priceKey
          ? { ...p, breaks: p.breaks.map((b) => (b.key === breakKey ? { ...b, [field]: value } : b)) }
          : p)),
      }
      : l)));
  }
  // Registered HERE rather than beside `dirty` above, because a break draft is real work that
  // `dirty` cannot see: `dirty` diffs the header and `lines` against the loaded detail, and a
  // threshold/price typed into the Add break controls does not reach `lines` until Add break is
  // clicked. So a fully typed break was discardable by any navigation or reload with no warning,
  // from a file the sweep already counted as registered (Codex P1 on !272) — the same
  // file-registers-therefore-covered blind spot the per-flag assertion closed for Save buttons.
  // `dirty` itself is left alone: it answers "does the server disagree with this form", which is
  // what the Save and print gates need, and an unadded break changes neither.
  // Content, not key count: an input typed into and then cleared leaves a blank entry behind. The
  // pruners above are what keep an ORPHANED one from arming this forever (#278).
  const breakDraftStarted = anyBreakDraftStarted(breakDrafts);
  // Two sections for one single-save form (PR 3): each tab badges its own half, and the Shell's
  // navigation prompt names the half that is dirty (`src/lib/quote-tabs.ts`). Both halves, the
  // typed breaks included, are kept in the Quote draft after a departure, so the prompt says they
  // stay under Drafts (R24, owner's answer 2026-11-03; #704).
  useUnsavedSection(Object.keys(patch).length > 0, QUOTE_DETAILS_SECTION, undefined, { recoverable: true });
  useUnsavedSection(linesDirty || breakDraftStarted, QUOTE_LINES_SECTION, undefined, { recoverable: true });
  function addBreak(lineKey: string, priceKey: string) { binding?.change(d => addQuoteBreak(d, lineKey, priceKey)); }
  function removeBreak(lineKey: string, priceKey: string, breakKey: string) {
    changeLines((cur) => cur.map((l) => (l.key === lineKey
      ? {
        ...l,
        prices: l.prices.map((p) => (p.key === priceKey
          ? { ...p, breaks: p.breaks.filter((b) => b.key !== breakKey) } : p)),
      }
      : l)));
  }

  // ---- Attach part (the dedicated route — an immediate, audited action; spec §4.1) ----

  const [attachPicks, setAttachPicks] = useState<Record<string, string>>({});
  // #720: one hold for every line's Attach, so a second click while the POST is out sends nothing
  // (it would be refused once the first attach landed).
  const [attaching, setAttaching] = useState(false);
  const [attachHold] = useState(() => oneShotHold(setAttaching));
  async function attachPart(line: LineForm) {
    const partId = attachPicks[line.key];
    if (!partId || line.id === undefined || editGate.disabled || dirty || recoveryBlocked) return;
    await attachHold.run(async () => {
      try {
        await nativeAction(() => api<QuoteMutationData>(`/api/quotes/${id}/attach-part`, {
          method: "POST", body: JSON.stringify({ lineId: line.id, partId }),
        }), res => res, res => {
          setOverlapWarnings(res.warnings); setAttachPicks(cur => ({ ...cur, [line.key]: "" })); setError(null);
        });
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

  // ---- Rendering ----

  const previewsHidden = ["loading", "unavailable", "error", "completed"].includes(view.mode);
  const preview = (copy: typeof view.current) => copy && !previewsHidden ? quoteRecoveryAdapter.preview(copy.data, copy.baseline) : undefined;
  const notice = binding && <DraftRecoveryNotice mode={nativeReadonly && !anyBreakDraftStarted(breakDrafts) ? "editing" : view.mode}
    canRestore={view.canRestore} hasCurrent={!!view.current} hasReference={!!view.reference}
    currentPreview={view.mode === "editing" ? undefined : preview(view.current)} referencePreview={preview(view.reference)} submittedPreview={preview(view.submitted)}
    restore={() => { if (view.current) binding.restore(view.current.stamp, readIdRef.current); }}
    discard={() => { if (view.current) binding.discard(view.current.stamp); }}
    discardReference={() => { if (view.reference) binding.discard(view.reference.stamp); }}
    startFresh={() => { if (view.savedBaseline) binding.startFresh(readIdRef.current, quoteDraftFrom(view.savedBaseline)); }}
    retryRead={() => { void load().catch(() => {}); }} />;

  if (detail === null || header === null) {
    return <PageStatus error={error ?? permsError}>{notice}</PageStatus>;
  }

  const saveTitle = editGate.disabled ? editGate.title
    : saving ? "Saving…" : !dirty ? "No unsaved changes" : undefined;

  /** Part display for a part-linked line (`partDisplayFor`): catalog row first, the loaded detail
   *  line as fallback (a missing parts.view or a catalog fetch failure: the R3 honest-select rule). */
  function partDisplay(line: LineForm): PartDisplay {
    return partDisplayFor(
      line.partId, customerParts.find((p) => p.id === line.partId), detail?.lines.find((dl) => dl.id === line.id),
    );
  }

  function lineCard(line: LineForm, index: number) {
    const linked = line.linkedOrders.length > 0;
    // §5.14, said up front: a linked line's part cannot be changed and the line cannot be
    // removed — a vanished or re-pointed line would silently re-price the named orders.
    const linkLockTitle = linked
      ? `Order(s) ${linkedOrderNumbers(line.linkedOrders)} still price from this line — its part ` +
        "cannot be changed and the line cannot be removed while they do"
      : undefined;
    const lastLine = lines.length === 1;
    const removeGate: Gate = editGate.disabled ? editGate
      : linked ? { allowed: false, disabled: true, title: linkLockTitle }
        : lastLine ? { allowed: false, disabled: true, title: "A quote must keep at least one line" }
          : editGate;
    const display = line.partId !== null ? partDisplay(line) : null;
    const loadedLine = detail?.lines.find((dl) => dl.id === line.id && dl.partId === null && dl.materialId === line.materialId);
    const materialChoice = materialOptions(materials, line, loadedLine?.material);
    const attachGate: Gate = editGate.disabled ? editGate
      : dirty ? { allowed: false, disabled: true, title: "Save or discard your changes first" }
        : !partsGate.allowed ? { allowed: false, disabled: true, title: partsGate.title }
          : editGate;

    return (
      <div key={line.key} className="rounded border p-3">
        <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
          <div className="text-sm">
            <span className="font-medium">Line {index + 1}</span>
            {line.partId !== null
              ? <span className="ml-2 font-mono">{display?.partNumber}</span>
              : <span className="ml-2 text-ink-500">free text</span>}
            {linked && (
              <span className="ml-3 rounded bg-link-50 px-1.5 py-0.5 text-xs text-link-700">
                Priced on order(s):{" "}
                {line.linkedOrders.map((o, i) => (
                  <span key={o.id}>
                    {i > 0 && ", "}
                    <Link href={`/orders/${o.id}`} className="underline">#{o.orderNumber}</Link>
                  </span>
                ))}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => moveLine(index, -1)}
                    {...moveGate(editGate, index, lines.length, -1)} aria-label="Move line up"
                    className="text-sm text-ink-500 hover:text-ink-800">↑</button>
            <button type="button" onClick={() => moveLine(index, 1)}
                    {...moveGate(editGate, index, lines.length, 1)} aria-label="Move line down"
                    className="text-sm text-ink-500 hover:text-ink-800">↓</button>
            <button type="button" onClick={() => removeLine(line.key)}
                    disabled={removeGate.disabled} title={removeGate.title}
                    className="text-xs text-red-600">
              Remove line
            </button>
          </div>
        </div>

        {/* ---- Part identity: part-picker vs free-text (spec §4.1's XOR, ruling 1) ---- */}
        {line.partId !== null ? (
          <div className="mb-3 flex flex-wrap items-end gap-3 text-sm">
            {linked ? (
              <div className="block">
                Part
                <div className="mt-1 rounded border bg-surface-50 px-2 py-1" title={linkLockTitle}>
                  <span className="font-mono">{display?.partNumber}</span> — {display?.name}
                </div>
              </div>
            ) : (
              <>
                <label className="block">
                  Part
                  {/* Synthesized current option when the catalog lacks the id (R3). */}
                  <Combobox value={line.partId}
                            options={[
                              ...(!customerParts.some((p) => p.id === line.partId)
                                ? [{ value: line.partId, label: display?.partNumber || "(current part)" }] : []),
                              ...partOptions(customerParts.filter((p) => p.active || p.id === line.partId), { separator: " — ", markInactive: true }),
                            ]}
                            disabled={editGate.disabled || !partsGate.allowed}
                            title={editGate.disabled ? editGate.title : partsGate.allowed ? undefined : partsGate.title}
                            onSelect={(v) => patchLine(line.key, { partId: v })} ariaLabel="Part" className="mt-1 w-64" />
                </label>
                <button type="button"
                        onClick={() => patchLine(line.key, freeTextFromPart(
                          // Prefill from what the paper currently shows, so the XOR rule is
                          // satisfied and the printed identity survives the detach; the part's
                          // material is carried into the drop-down (#541 ruling 5).
                          display ?? BLANK_PART_DISPLAY,
                        ))}
                        disabled={editGate.disabled} title={editGate.title}
                        className={`${LINK} pb-1 text-xs`}>
                  Switch to free text
                </button>
              </>
            )}
            <QuotePartSummary display={display} />
          </div>
        ) : (
          <div className="mb-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
            <label className="block">
              Part number (free text)
              <input value={line.partNumberText} readOnly={!editGate.allowed} title={editGate.title}
                     onChange={(e) => patchLine(line.key, { partNumberText: e.target.value })}
                     className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
            </label>
            <label className="block">
              Name
              <input value={line.partNameText} readOnly={!editGate.allowed} title={editGate.title}
                     onChange={(e) => patchLine(line.key, { partNameText: e.target.value })}
                     className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
            </label>
            <label className="block">
              Material
              {/* The Materials pick list only (#541): typed text from before the list shows as the
                  current choice until a pick (materialOptions, quote-form.ts). */}
              <select value={materialChoice.value}
                      disabled={editGate.disabled || materials === null}
                      title={materials === null ? "Options failed to load — reload the page" : editGate.title}
                      onChange={(e) => {
                        const picked = pickMaterial(e.target.value);
                        if (picked) patchLine(line.key, picked);
                      }}
                      className={`${INPUT_COMPACT} mt-1 w-full disabled:cursor-not-allowed disabled:bg-surface-50`}>
                {materialChoice.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="block">
              {EACH_WEIGHT_LB}
              <input value={line.eachWeight} inputMode="decimal" readOnly={!editGate.allowed} title={editGate.title}
                     onChange={(e) => patchLine(line.key, { eachWeight: e.target.value })}
                     className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
            </label>
            <label className="col-span-2 block">
              Description
              <input value={line.partDescriptionText} readOnly={!editGate.allowed} title={editGate.title}
                     onChange={(e) => patchLine(line.key, { partDescriptionText: e.target.value })}
                     className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
            </label>
            {line.id !== undefined ? (
              // The dedicated attach-part action (spec §4.1: an audited quotes.edit act — from
              // then on the line auto-links). Immediate, so it adopts a fresh detail.
              <div className="flex items-end gap-2">
                <label className="block">
                  Attach part
                  <Combobox value={attachPicks[line.key] ?? ""}
                            options={partOptions(customerParts.filter((p) => p.active), { blank: "Part…", separator: " — " })}
                            disabled={attachGate.disabled} title={attachGate.title}
                            onSelect={(v) => setAttachPicks((cur) => ({ ...cur, [line.key]: v }))}
                            ariaLabel="Attach part" className="mt-1 w-64" />
                </label>
                <button type="button" onClick={() => void attachPart(line)}
                        disabled={attachGate.disabled || !(attachPicks[line.key] ?? "") || attaching}
                        title={attachGate.disabled ? attachGate.title : !(attachPicks[line.key] ?? "") ? "Pick a part first" : undefined}
                        className={BUTTON_NEUTRAL_COMPACT}>
                  Attach
                </button>
              </div>
            ) : (
              <label className="block">
                Use memorized part instead
                <Combobox value="" placeholder="Part…"
                          options={partOptions(customerParts.filter((p) => p.active), { separator: " — " })}
                          disabled={editGate.disabled || !partsGate.allowed}
                          title={editGate.disabled ? editGate.title : partsGate.allowed ? undefined : partsGate.title}
                          onSelect={(v) => { if (v) patchLine(line.key, { partId: v }); }}
                          ariaLabel="Use memorized part instead" className="mt-1 w-64" />
              </label>
            )}
          </div>
        )}

        {/* ---- Quoted quantity (ruling 9 — informational; brackets remain the breaks' job) ---- */}
        <div className="mb-3 flex flex-wrap items-end gap-3 text-sm">
          <label className="block">
            Quoted qty (&quot;based on N pcs&quot;)
            <input value={line.quotedQty} inputMode="numeric"
                   readOnly={!editGate.allowed || line.quotedUnlimited}
                   title={editGate.disabled ? editGate.title : line.quotedUnlimited ? "Untick Unlimited to quote a quantity" : undefined}
                   onChange={(e) => patchLine(line.key, { quotedQty: e.target.value })}
                   className={`${INPUT_COMPACT} mt-1 w-32 read-only:bg-surface-50`} />
          </label>
          <label className="flex items-center gap-1 pb-1">
            <input type="checkbox" checked={line.quotedUnlimited}
                   disabled={editGate.disabled} title={editGate.title}
                   onChange={(e) => patchLine(line.key, {
                     quotedUnlimited: e.target.checked,
                     // Mutually exclusive (the service 400s the pair) — ticking clears the qty.
                     ...(e.target.checked ? { quotedQty: "" } : {}),
                   })} />
            Unlimited
          </label>
        </div>

        {/* ---- Price rows (ruling 2: the exact PartPrice mirror — the 5A grid UX) ---- */}
        <h3 className="mb-1 text-xs font-medium text-ink-500">Pricing</h3>
        {line.prices.length === 0 && (
          <p className="mb-2 text-sm text-ink-500">
            No priced operations yet — an empty agreement invoices as needs-price, never part
            prices (ruling 4).
          </p>
        )}
        <div className="mb-2 space-y-3">
          {line.prices.map((price, pIdx) => {
            const hasCode = stepCodes.some((c) => c.id === price.processStepCodeId);
            return (
              <div key={price.key} className="rounded border bg-surface-50/50 p-2">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <Combobox value={price.processStepCodeId} disabled={editGate.disabled || !stepCodesReady}
                            title={!stepCodesReady ? "Options failed to load — reload the page" : editGate.title}
                            onSelect={(v) => patchPrice(line.key, price.key, { processStepCodeId: v })}
                            options={[
                              ...(!hasCode ? [{ value: price.processStepCodeId, label: `${price.stepCode}${price.stepName ? ` — ${price.stepName}` : ""}` }] : []),
                              ...labelledOptions(stepCodes, (c) => `${c.name}${c.active ? "" : " (inactive)"}`),
                            ]}
                            ariaLabel="Operation step code" className="w-72" />
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => movePrice(line.key, pIdx, -1)}
                            {...moveGate(editGate, pIdx, line.prices.length, -1)} aria-label="Move operation up"
                            className="text-sm text-ink-500 hover:text-ink-800">↑</button>
                    <button type="button" onClick={() => movePrice(line.key, pIdx, 1)}
                            {...moveGate(editGate, pIdx, line.prices.length, 1)} aria-label="Move operation down"
                            className="text-sm text-ink-500 hover:text-ink-800">↓</button>
                    <button type="button" onClick={() => removePrice(line.key, price.key)}
                            disabled={editGate.disabled} title={editGate.title}
                            className="text-xs text-red-600">
                      Remove operation
                    </button>
                  </div>
                </div>

                <div className="mb-2 grid grid-cols-2 gap-3 md:grid-cols-5">
                  <label className="block text-sm">
                    {SETUP_CHARGE.label}
                    <input value={price.setupCharge} inputMode="decimal" readOnly={!editGate.allowed} title={editGate.title}
                           onChange={(e) => patchPrice(line.key, price.key, { setupCharge: e.target.value })}
                           className={`${INPUT_COMPACT} mt-1 w-full text-right read-only:bg-surface-50`} />
                  </label>
                  <label className="block text-sm">
                    {UNIT_PRICE.label}
                    <input value={price.unitPrice} inputMode="decimal" readOnly={!editGate.allowed} title={editGate.title}
                           onChange={(e) => patchPrice(line.key, price.key, { unitPrice: e.target.value })}
                           className={`${INPUT_COMPACT} mt-1 w-full text-right read-only:bg-surface-50`} />
                  </label>
                  <label className="block text-sm">
                    {MINIMUM_CHARGE.label}
                    <input value={price.minimumCharge} inputMode="decimal" readOnly={!editGate.allowed} title={editGate.title}
                           onChange={(e) => patchPrice(line.key, price.key, { minimumCharge: e.target.value })}
                           className={`${INPUT_COMPACT} mt-1 w-full text-right read-only:bg-surface-50`} />
                  </label>
                  <label className="block text-sm">
                    Price per
                    <select value={price.pricePer} disabled={editGate.disabled} title={editGate.title}
                            onChange={(e) => void changePricePer(line.key, price, e.target.value as PricePerValue)}
                            className={`${INPUT_COMPACT} mt-1 w-full disabled:bg-surface-50`}>
                      {PRICE_PER.map((p) => <option key={p} value={p}>{PRICE_PER_LABELS[p]}</option>)}
                    </select>
                  </label>
                  <label className="block text-sm">
                    Quote notes (print)
                    <input value={price.notes} readOnly={!editGate.allowed} title={editGate.title}
                           onChange={(e) => patchPrice(line.key, price.key, { notes: e.target.value })}
                           className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
                  </label>
                </div>

                <h4 className="mb-1 text-xs font-medium text-ink-500">Price breaks</h4>
                {price.breaks.length > 0 && (
                  <table className="mb-2 w-full text-sm">
                    <thead>
                      <tr className="text-left"><th className="py-1">{BREAK_THRESHOLD.label}</th><th>{BREAK_PRICE.label}</th><th /></tr>
                    </thead>
                    <tbody>
                      {price.breaks.map((b) => (
                        <tr key={b.key} className="border-t">
                          <td className="py-1">
                            <input value={b.threshold} inputMode="decimal" readOnly={!editGate.allowed} title={editGate.title}
                                   onChange={(e) => patchBreak(line.key, price.key, b.key, "threshold", e.target.value)}
                                   className={`${INPUT_COMPACT} w-24 text-right read-only:bg-surface-50`} />
                          </td>
                          <td>
                            <input value={b.price} inputMode="decimal" readOnly={!editGate.allowed} title={editGate.title}
                                   onChange={(e) => patchBreak(line.key, price.key, b.key, "price", e.target.value)}
                                   className={`${INPUT_COMPACT} w-24 text-right read-only:bg-surface-50`} />
                          </td>
                          <td className="text-right">
                            <button type="button" onClick={() => removeBreak(line.key, price.key, b.key)}
                                    disabled={editGate.disabled} title={editGate.title}
                                    className="text-xs text-red-600">
                              delete
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div className="flex gap-2">
                  <input value={draftFor(price.key).threshold} placeholder={BREAK_THRESHOLD.label} inputMode="decimal"
                         disabled={editGate.disabled} title={editGate.title}
                         onChange={(e) => binding?.change(d => ({ ...d, breakDrafts: patchBreakDraft(d.breakDrafts, price.key, "threshold", e.target.value) }))}
                         className={`${INPUT_COMPACT} w-24 disabled:bg-surface-50`} />
                  <input value={draftFor(price.key).price} placeholder={BREAK_PRICE.label} inputMode="decimal"
                         disabled={editGate.disabled} title={editGate.title}
                         onChange={(e) => binding?.change(d => ({ ...d, breakDrafts: patchBreakDraft(d.breakDrafts, price.key, "price", e.target.value) }))}
                         className={`${INPUT_COMPACT} w-24 disabled:bg-surface-50`} />
                  <button type="button" onClick={() => addBreak(line.key, price.key)}
                          disabled={editGate.disabled || !draftFor(price.key).threshold || !draftFor(price.key).price}
                          title={editGate.disabled ? editGate.title
                            : !draftFor(price.key).threshold || !draftFor(price.key).price
                              ? "Enter a threshold and price first" : undefined}
                          className={BUTTON_PRIMARY_COMPACT}>
                    Add break
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex items-end gap-2">
          <Combobox value="" disabled={editGate.disabled || !stepCodesReady}
                    title={!stepCodesReady ? "Options failed to load — reload the page" : editGate.title}
                    onSelect={(v) => { if (v) addPrice(line.key, v); }} placeholder="Add operation"
                    options={labelledOptions(stepCodes.filter((c) => c.active), (c) => c.name)}
                    ariaLabel="Add operation" className="w-72" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0 p-3 sm:p-6">
      {/* The title row (spec §4.3; PR 3): the badges stay inside the h1, so the flows' heading
          locators (`/^Quote #\d+.*Expired/`) still read them; Save quote is the screen's one
          primary; Close and Reopen are More actions items, the one that does not apply disabled
          with its reason; Delete quote stays in the title row (ruling 8). */}
      <PageHeader
        title={<>
          Quote #{detail.quoteNumber}
          <span className="ml-3 rounded bg-surface-50 px-2 py-0.5 text-base font-normal text-ink-500">
            {QUOTE_STATUS_LABELS[detail.status]}
          </span>
          {detail.expired && (
            <span className="ml-2 rounded bg-accent-50 px-2 py-0.5 text-base font-normal text-accent-600">
              {QUOTE_EXPIRED_LABEL}
            </span>
          )}
          {deleted && (
            <span className="ml-2 rounded bg-line px-2 py-0.5 text-base font-normal text-ink-800">
              Deleted
            </span>
          )}
        </>}
        subtitle={`${detail.customerCode} · ${detail.customerName} · ${formatDate(detail.effectiveDate)} – ${formatDate(detail.expiryDate)}`}
        actions={<div className="flex flex-wrap items-center justify-end gap-2">
          {/* Deliberately NOT `|| breakDraftStarted`, the SaveButton `alsoUnsaved` precedent: a
              started break is work Save cannot send, so badging it beside a disabled Save reads
              as a broken control — and unlike an orphan it is still sitting visible in its own
              input. Discard beside it DOES gate on it, because that is the control able to
              clear it. One click, no prompt (ruling 9 of 2026-10-30; #309). */}
          <UnsavedBadge dirty={dirty} />
          <button onClick={discardChanges} disabled={!dirty && !breakDraftStarted && !recoveryBlocked && !rawDraftRetained}
                  title={dirty || breakDraftStarted || recoveryBlocked || rawDraftRetained ? undefined : "No unsaved changes"}
                  className="text-sm text-ink-500 underline">
            Discard changes
          </button>
          <button onClick={() => void save()} disabled={editGate.disabled || !dirty || saving} title={saveTitle}
                  className={BUTTON_PRIMARY}>
            {saving ? "Saving…" : "Save quote"}
          </button>
          <button onClick={() => void printQuote()} disabled={!printGate.allowed || printing} title={printGate.title}
                  className={BUTTON_NEUTRAL}>
            {printing ? "Printing…" : "Print quotation"}
          </button>
          <ActionMenu items={[
            { label: "Close quote", sub: "Stops pricing new orders", disabled: closeGate.disabled, title: closeGate.title,
              onSelect: () => void closeQuote() },
            { label: "Reopen quote", sub: "Resumes pricing new orders in its window", disabled: reopenGate.disabled, title: reopenGate.title,
              onSelect: () => void reopenQuote() },
          ]} />
          <DangerButton onClick={() => void deleteQuote()} disabled={deleteGate.disabled} title={deleteGate.title}>
            Delete quote
          </DangerButton>
        </div>} />

      {notice}
      {(error ?? permsError) && (
        <p className={`${NOTICE.refusal} mb-3 whitespace-pre-line`}>{error ?? permsError}</p>
      )}
      {printError && <p className={`${NOTICE.refusal} mb-3`}>{printError}</p>}
      {optionsError && (
        <p className={`${NOTICE.warning} mb-3`}>{optionsError}</p>
      )}
      {overlapWarnings.length > 0 && (
        // Ruling 7: overlapping open quotes for the same part WARN at save and never block —
        // the house amber warnings list (ShipmentDetail.tsx's §5.7 banner).
        <ul className={`${NOTICE.warning} mb-3 list-disc space-y-0.5 pl-7`}>
          {overlapWarnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
      {closed && (
        <p className="mb-3 rounded bg-surface-50 p-2 text-sm text-ink-800">
          Closed — {detail.closeReason || "no reason recorded"}
          {detail.closedByName && ` — by ${detail.closedByName}`}
          {detail.closedAt !== null && ` on ${formatDateTime(detail.closedAt)}`}.
          Existing links keep pricing their orders; it no longer prices new ones.
        </p>
      )}
      {closeWarning && (
        <div className="mb-3 rounded border border-accent-600 bg-accent-50 p-3 text-sm">
          <p className="mb-1 font-medium">
            {closeWarning.length} open order(s) still price from this quote and are not yet fully
            invoiced:
          </p>
          <ul className="mb-2 flex flex-wrap gap-2">
            {closeWarning.map((o) => (
              <li key={o.id}>
                <Link href={`/orders/${o.id}`} className={LINK}>#{o.orderNumber}</Link>
              </li>
            ))}
          </ul>
          <p className="mb-2 text-ink-800">
            Their stored links keep pricing them — invoices for these orders will still use this
            quote&apos;s rows (judged at link time).
          </p>
          <button onClick={() => setCloseWarning(null)} className="text-ink-500">dismiss</button>
        </div>
      )}
      {blocked && (
        <BlockerPanel
          label="quote"
          rowName={`#${detail.quoteNumber}`}
          list={blocked.list}
          action="delete"
          exportHref={`/api/quotes/${id}/blockers/export`}
          onDismiss={() => setBlocked(null)}
          note={"Unlinking is an order-side edit: re-pick or unlink the quote on each order's " +
            "line, or invoice the orders through — then the delete goes through."}
        />
      )}

      <div className="flex flex-col gap-6 min-[1360px]:flex-row min-[1360px]:items-start">
      <div className="min-w-0 flex-1">
      {/* Three tabs over the mounted sections (spec §4.4; `src/lib/quote-tabs.ts`): the form is one
          single-save draft across them, so a tab switch is never a departure. */}
      <RecordTabs label={QUOTE_TAB_LABEL} tabs={quoteTabs()} panels={{
        parts: (
          /* ---- Lines ---- */
          <section id="lines" tabIndex={-1} className={`${CARD} mb-6`}>
            <h2 className="mb-2 font-medium">Lines</h2>
        <div className="mb-3 space-y-4">
          {lines.map((line, i) => lineCard(line, i))}
        </div>
        <button onClick={addLine} disabled={editGate.disabled} title={editGate.title}
                className={`${LINK} text-sm`}>
          Add quote line
        </button>
          </section>
        ),
        details: (
          /* ---- Header (single-save; the notes pair saves together with everything else) ---- */
          <section id="header" tabIndex={-1} className={`${CARD} mb-6`}>
            <h2 className="mb-2 font-medium">Header</h2>
        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
          <div className="block">
            Customer
            <div className="mt-1 rounded border bg-surface-50 px-2 py-1"
                 title="The customer on a quote cannot be changed — delete this quote and enter a new one">
              <Link href={`/customers/${detail.customerId}`} className={LINK}>
                {detail.customerCode} · {detail.customerName}
              </Link>
            </div>
          </div>
          <label className="block">
            Contact (prints in the Attn block)
            <select value={header.contactId} disabled={contactGate.disabled} title={contactGate.title}
                    onChange={(e) => patchHeader({ contactId: e.target.value })}
                    className={`${INPUT_COMPACT} mt-1 w-full disabled:cursor-not-allowed disabled:bg-surface-50`}>
              <option value="">No contact</option>
              {/* Synthesized current option when the list lacks the stored pick (R3) — a DELETED
                  contact renders blank server-side (deletion is deliberately not blocked). */}
              {header.contactId !== "" && !contacts.some((c) => c.id === header.contactId) && (
                <option value={header.contactId}>{detail.contactName || "(current contact)"}</option>
              )}
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>{c.name}{!c.active && " (inactive)"}</option>
              ))}
            </select>
          </label>
          <label className="block">
            Quoted by (signs the quote)
            <select value={header.quotedById} disabled={quotedByGate.disabled} title={quotedByGate.title}
                    onChange={(e) => patchHeader({ quotedById: e.target.value })}
                    className={`${INPUT_COMPACT} mt-1 w-full disabled:cursor-not-allowed disabled:bg-surface-50`}>
              {!users.some((u) => u.id === header.quotedById) && (
                <option value={header.quotedById}>{detail.quotedByName}</option>
              )}
              {/* By the display name each option shows, not the username the list is read by (#1056
                  ruling 3). */}
              {inMenuOrder(users, (u) => u.displayName).map((u) => (
                <option key={u.id} value={u.id}>{u.displayName}{!u.active && " (inactive)"}</option>
              ))}
            </select>
          </label>
          <label className="block">
            Quote date
            <input type="date" value={header.quoteDate} disabled={editGate.disabled} title={editGate.title}
                   onChange={(e) => patchHeader({ quoteDate: e.target.value })}
                   className={`${INPUT_COMPACT} mt-1 w-full disabled:bg-surface-50`} />
          </label>
          <label className="block">
            Effective
            <input type="date" value={header.effectiveDate} disabled={editGate.disabled} title={editGate.title}
                   onChange={(e) => patchHeader({ effectiveDate: e.target.value })}
                   className={`${INPUT_COMPACT} mt-1 w-full disabled:bg-surface-50`} />
          </label>
          <label className="block">
            Expires
            <input type="date" value={header.expiryDate} disabled={editGate.disabled} title={editGate.title}
                   onChange={(e) => patchHeader({ expiryDate: e.target.value })}
                   className={`${INPUT_COMPACT} mt-1 w-full disabled:bg-surface-50`} />
          </label>
          <label className="block">
            Follow-up
            <input type="date" value={header.followUpDate} disabled={editGate.disabled} title={editGate.title}
                   onChange={(e) => patchHeader({ followUpDate: e.target.value })}
                   className={`${INPUT_COMPACT} mt-1 w-full disabled:bg-surface-50`} />
          </label>
          <label className="block">
            RFQ number (prints)
            <input value={header.rfqNumber} readOnly={!editGate.allowed} title={editGate.title}
                   onChange={(e) => patchHeader({ rfqNumber: e.target.value })}
                   className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
          </label>
          <label className="block">
            Ending statement (prints in the footer)
            <select value={header.endingStatementId} disabled={editGate.disabled} title={editGate.title}
                    onChange={(e) => patchHeader({ endingStatementId: e.target.value })}
                    className={`${INPUT_COMPACT} mt-1 w-full disabled:cursor-not-allowed disabled:bg-surface-50`}>
              <option value="">None</option>
              {header.endingStatementId !== "" && !statements.some((s) => s.id === header.endingStatementId) && (
                <option value={header.endingStatementId}>{detail.endingStatementName || "(current statement)"}</option>
              )}
              {inMenuOrder(statements, (r) => r.name).map((s) => (
                <option key={s.id} value={s.id}>{s.name}{!s.active && " (inactive)"}</option>
              ))}
            </select>
            {header.endingStatementId === (detail.endingStatementId ?? "") && detail.endingStatementText !== "" && (
              <span className="mt-1 block text-xs text-ink-500">{detail.endingStatementText}</span>
            )}
          </label>
          <label className="block md:col-span-2">
            Notes (print on the quote)
            <textarea value={header.notes} rows={3} readOnly={!editGate.allowed} title={editGate.title}
                      onChange={(e) => patchHeader({ notes: e.target.value })}
                      className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
          </label>
          <label className="block">
            Internal notes (never print)
            <textarea value={header.internalNotes} rows={3} readOnly={!editGate.allowed} title={editGate.title}
                      onChange={(e) => patchHeader({ internalNotes: e.target.value })}
                      className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
          </label>
        </div>
          </section>
        ),
        documents: (<>
          {/* ---- Documents + History ---- */}
          <section id="documents" tabIndex={-1} className={`${CARD} mb-6`}>
            <h2 className="mb-2 font-medium">Documents</h2>
            <QuoteDocumentsList quoteId={id} viewGate={docsGate} refresh={docsRefresh} />
          </section>
          <div id="history" tabIndex={-1} className="mb-6">
            <HistoryPanel entity="quote" entityId={id} perms={loadedPerms} permsError={permsError} />
          </div>
        </>),
      }} />
      </div>
      {/* The card reads the LOADED record (spec §4.4), never the draft: a typed date that is not
          saved yet is the Details tab's. */}
      <AtAGlance rows={[
        { label: "Status", value: <>{QUOTE_STATUS_LABELS[detail.status]}{detail.expired && ` · ${QUOTE_EXPIRED_LABEL}`}{deleted && " · Deleted"}</> },
        { label: "Customer", value: `${detail.customerCode} · ${detail.customerName}` },
        { label: "Effective", value: formatDate(detail.effectiveDate) },
        { label: "Expires", value: formatDate(detail.expiryDate) },
        { label: "Follow-up", value: detail.followUpDate ? formatDate(detail.followUpDate) : "—" },
      ]} />
      </div>
    </div>
  );
}
