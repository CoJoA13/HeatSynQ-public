"use client";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { api, ApiError, trackedFetch } from "@/lib/fetcher";
import { getBrowserDraftSession } from "@/lib/draft-session";
import { acceptPreview, previewReducer, type PreviewIdentity } from "@/lib/process-preview-state";
import { PREVIEW_VIEW_PERMISSIONS, PreviewDenied, contextKeyOf, previewAvailable, readPreviewResponse, resolvePreviewTarget, type PreviewContext } from "@/lib/process-preview-plan";
import type { ProcessDocumentInput } from "@/lib/process-document";
import { BUTTON_NEUTRAL_COMPACT, INPUT_COMPACT } from "@/lib/ui-classes";

type ContextPage = { items: PreviewContext[]; nextCursor: string | null };
const DENIED_REASON = "Preview requires current parts and processes view access.";

/**
 * The traveler preview (spec 2026-09-26 §5): a native `<dialog>` over the real draft-render path.
 * It renders the current draft around the newest eligible order (a picker offers the others) or,
 * without `orders.view` or without any eligible order, around a SAMPLE header — and says which.
 *
 * Nothing is requested while the dialog is closed (pre-flight M8): the context list and the render
 * are both gated on `open`, so a part-page load or an edit made with the dialog closed issues no
 * request. While open, the single-slot request queue, the generation/`contextKey` identity and the
 * response checks are the side panel's, moved here (`readPreviewResponse` holds the checks).
 */
export function ProcessPreviewDialog({ open, onClose, partId, document, permissions, generation, authorizationRevision, unavailableReason }: {
  open: boolean; onClose: () => void; partId: string; document: ProcessDocumentInput | null; permissions: readonly string[]; generation: number; authorizationRevision: number; unavailableReason?: string;
}) {
  const viewAllowed = PREVIEW_VIEW_PERMISSIONS.every(p => permissions.includes(p));
  const ordersAllowed = viewAllowed && permissions.includes("orders.view");
  const [contexts, setContexts] = useState<ContextPage>({ items: [], nextCursor: null });
  const [query, setQuery] = useState(""); const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState(""); const [refresh, setRefresh] = useState(0);
  const [contextRead, setContextRead] = useState(""); const [contextError, setContextError] = useState<string | null>(null);
  // `denied`: the context list was refused, so orders.view is not current — the SAMPLE path.
  // `previewDenied`: the render itself was refused — parts/processes view is not current.
  const [denied, setDenied] = useState(false); const [previewDenied, setPreviewDenied] = useState(false);
  const [state, dispatch] = useReducer(previewReducer, { status: "unavailable" });
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const sequence = useRef(0); const expected = useRef<PreviewIdentity | null>(null);
  const running = useRef(false); const queued = useRef<(() => Promise<void>) | null>(null);
  const objectUrl = useRef<string | null>(null); const controller = useRef<AbortController | null>(null);
  // What the last list read and the last render were asked for while open, `null` while closed:
  // only a changed search waits out the list's debounce, and only a changed draft the render's
  // (#660). Opening, Refresh, a page and a picked context go at once, on a 0 ms timer, so the
  // development double run still sends once.
  const listedQuery = useRef<string | null>(null); const renderedPayload = useRef<string | null>(null);
  const listKey = `${partId}:${authorizationRevision}:${query}:${cursor ?? ""}:${refresh}`;
  const clearUrl = useCallback(() => { if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = null; }, []);
  const drain = useCallback(async function drainQueue() {
    if (running.current || !queued.current) return;
    const work = queued.current; queued.current = null; running.current = true;
    try { await work(); } finally { running.current = false; void drainQueue(); }
  }, []);
  // The element follows `open` (pre-flight M12): `showModal()` only while not already open — the
  // app router runs effects twice in development, and a second call throws — and never `close()`
  // from a cleanup, whose `close` event would call `onClose()` and shut the dialog as it opened.
  // Closing also abandons a render in flight; a change while open does not (the queue drains it).
  useEffect(() => {
    if (!open) controller.current?.abort();
    const el = dialogRef.current; if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);
  useEffect(() => {
    let live = true; const session = getBrowserDraftSession(); const ticket = session?.readAuthorizationTicket();
    setContextRead(""); setContextError(null); setDenied(false); setPreviewDenied(false);
    if (!open || !ordersAllowed || !session || !ticket) { listedQuery.current = null; return; }
    const delay = listedQuery.current !== null && listedQuery.current !== query ? 200 : 0; listedQuery.current = query;
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: query }); if (cursor) params.set("cursor", cursor);
      api<ContextPage>(`/api/parts/${partId}/process/preview-contexts?${params}`).then(result => {
        if (!live || !session.isReadAuthorized(ticket)) return;
        setContexts(result); setContextRead(listKey);
        // The first item — the newest order with its lowest load (Task 6) — is the default.
        setSelected(old => result.items.some(c => contextKeyOf(c) === old) ? old : result.items[0] ? contextKeyOf(result.items[0]) : "");
      }).catch(error => {
        if (!live || !session.isReadAuthorized(ticket)) return;
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) setDenied(true);
        else setContextError((error as Error).message);
      });
    }, delay);
    return () => { live = false; clearTimeout(timer); };
  }, [open, ordersAllowed, partId, query, cursor, refresh, authorizationRevision, listKey]);
  const target = resolvePreviewTarget({ ordersAllowed: ordersAllowed && !denied, error: contextError, listed: contextRead === listKey, items: contexts.items, selected, filtered: query !== "" || cursor !== null, query });
  // `null` asks the server for the SAMPLE header; `undefined` means there is nothing to ask for yet.
  const context: PreviewContext | null | undefined = target.kind === "order" ? target.context : target.kind === "sample" ? null : undefined;
  const payload = useMemo(() => document ? JSON.stringify(document) : "", [document]);
  // Content participates in the visible identity as well as the request generation, so a previous
  // PDF disappears in the same render as a keystroke, before effects run.
  const contextKey = `${listKey}:${context === undefined ? "" : context === null ? "sample" : contextKeyOf(context)}:${generation}:${payload}`;
  const available = previewAvailable({ open, viewAllowed, denied: previewDenied, target, hasDocument: !!document, unavailableReason });
  useEffect(() => {
    clearUrl(); queued.current = null; expected.current = null;
    const session = getBrowserDraftSession(); const ticket = session?.readAuthorizationTicket();
    if (!available || context === undefined || !session || !ticket) { renderedPayload.current = null; dispatch({ type: "unavailable" }); return; }
    const delay = renderedPayload.current !== null && renderedPayload.current !== payload ? 400 : 0; renderedPayload.current = payload;
    const identity = { generation: ++sequence.current, contextKey, authorizationRevision };
    expected.current = identity; dispatch({ type: "change", identity });
    const current = () => expected.current !== null && acceptPreview(expected.current, identity) && session.isReadAuthorized(ticket) && session.getReadAuthorizationRevision() === identity.authorizationRevision;
    const timer = setTimeout(() => {
      queued.current = async () => {
        if (!current()) return;
        const abort = new AbortController(); controller.current = abort;
        try {
          const response = await trackedFetch(`/api/parts/${partId}/process/preview`, { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...JSON.parse(payload), context, generation: identity.generation }), signal: abort.signal });
          if (!current()) return;
          const result = await readPreviewResponse(response, identity.generation);
          if (!current()) return;
          const url = URL.createObjectURL(result.blob);
          clearUrl(); objectUrl.current = url;
          dispatch({ type: "ready", identity, url, pages: result.pages, templateName: result.templateName, renderedAt: Date.now() });
        } catch (error) {
          if (!current()) return;
          if (error instanceof PreviewDenied) { setPreviewDenied(true); expected.current = null; dispatch({ type: "unavailable" }); return; }
          dispatch({ type: "error", identity, message: (error as Error).message });
        } finally { if (controller.current === abort) controller.current = null; }
      };
      void drain();
    }, delay);
    return () => { clearTimeout(timer); queued.current = null; expected.current = null; clearUrl(); };
  }, [available, context, payload, contextKey, authorizationRevision, partId, clearUrl, drain]);
  useEffect(() => () => { expected.current = null; queued.current = null; controller.current?.abort(); clearUrl(); }, [clearUrl]);
  const currentState = available && "identity" in state && state.identity.contextKey === contextKey && state.identity.authorizationRevision === authorizationRevision ? state : null;
  const picker = ordersAllowed && !denied;
  return <dialog ref={dialogRef} aria-label="Traveler preview" onClose={() => onClose()} className="m-auto w-[min(96vw,64rem)] max-w-none rounded-lg border bg-surface-0 p-0 text-ink-800 shadow-xl backdrop:bg-ink-900/50">
    <div className="p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Traveler preview</h3>
        <div className="flex flex-row-reverse items-center gap-2">
          <button type="button" onClick={() => onClose()} className={BUTTON_NEUTRAL_COMPACT}>Close</button>
          <button type="button" disabled={!viewAllowed} onClick={() => setRefresh(n => n + 1)} className={BUTTON_NEUTRAL_COMPACT}>{state.status === "error" || contextError ? "Retry preview" : "Refresh preview"}</button>
        </div>
      </div>
      <p className="mb-3 rounded border border-accent-400 bg-accent-50 p-2 text-xs font-semibold text-accent-600">DRAFT PROCESS PREVIEW - NOT FOR PRODUCTION</p>
      {!viewAllowed || previewDenied ? <p className="text-sm text-ink-500">{DENIED_REASON}</p> : <>
        {picker && <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs text-ink-500">Find existing order
            <input type="search" inputMode="numeric" value={query} onChange={e => { setQuery(e.target.value); setCursor(null); }} placeholder="Order number" className={`${INPUT_COMPACT} mt-1 w-full`} />
          </label>
          <label className="block text-xs text-ink-500">Order and load
            <select aria-label="Order and load" value={target.kind === "order" ? contextKeyOf(target.context) : ""} onChange={e => setSelected(e.target.value)} disabled={contextRead !== listKey || !contexts.items.length} className={`${INPUT_COMPACT} mt-1 w-full`}>
              {contextRead === listKey && contexts.items.map(c => <option key={contextKeyOf(c)} value={contextKeyOf(c)}>Order {c.orderNumber} · Load {c.loadNumber}</option>)}
            </select>
          </label>
          <div className="flex gap-3 text-xs sm:col-span-2">
            {cursor && <button type="button" onClick={() => setCursor(null)} className="underline">First orders</button>}
            {contextRead === listKey && contexts.nextCursor && <button type="button" onClick={() => setCursor(contexts.nextCursor)} className="underline">More orders</button>}
          </div>
        </div>}
        {contextError ? <p role="alert" className="mt-3 text-sm text-red-700">{contextError}</p>
          : target.kind === "pending" ? <p className="mt-3 text-sm text-ink-500">Checking preview contexts…</p>
          : target.kind === "none" ? <p className="mt-3 text-sm text-ink-500">{target.reason}</p>
          : target.kind === "sample" ? <p className="mt-3 text-sm text-ink-500">{target.reason}</p> : null}
        {unavailableReason && <p className="mt-3 text-sm text-ink-500">{unavailableReason}</p>}
        {available && <div className="mt-4" aria-live="polite">
          {!currentState || currentState.status === "updating" ? <p className="text-sm text-ink-500">Updating preview…</p>
            : currentState.status === "error" ? <p role="alert" className="text-sm text-red-700">{currentState.message}</p>
            : currentState.status === "ready" && <>
              <p className="text-sm font-medium">{currentState.pages} {currentState.pages === 1 ? "page" : "pages"}{currentState.pages > 1 ? " · Continues on additional pages" : " · Fits on one page"}</p>
              <p className="mb-3 text-xs leading-5 text-ink-500">{context ? `Order ${context.orderNumber} · Load ${context.loadNumber}` : "SAMPLE"} · Template: {currentState.templateName}<br />
                Rendered {new Date(currentState.renderedAt).toLocaleTimeString()}. {context ? "Fit depends on this order, load and template." : "Fit depends on this template; a real order may differ."} Refresh to check remote changes.</p>
              <iframe title="Draft process traveler PDF" src={`${currentState.url}#navpanes=0&view=FitH`} className="h-[70vh] w-full rounded border bg-surface-0" />
            </>}
        </div>}
      </>}
    </div>
  </dialog>;
}
