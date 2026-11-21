"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import type { DraftListRow, EditorKey } from "@/lib/draft-store";
import { peekBrowserDraftSession } from "@/lib/draft-session";
import { useBrowserDraftStore, useDraftCount } from "@/lib/use-recoverable-draft";
import { BUTTON_NEUTRAL, CARD } from "@/lib/ui-classes";

// Shared record kind vocabulary for all adapters. Identifiers are used only in endpoint paths.
const labelReaders: Record<string, (id: string, signal: AbortSignal) => Promise<unknown>> = {
  "order": (id, signal) => api<unknown>(`/api/orders/${encodeURIComponent(id)}`, { signal }),
  "shipment": (id, signal) => api<unknown>(`/api/shippers/${encodeURIComponent(id)}`, { signal }),
  "invoice": (id, signal) => api<unknown>(`/api/invoices/${encodeURIComponent(id)}`, { signal }),
  "quote": (id, signal) => api<unknown>(`/api/quotes/${encodeURIComponent(id)}`, { signal }),
  "part": (id, signal) => api<unknown>(`/api/parts/${encodeURIComponent(id)}`, { signal }),
  "cert": (id, signal) => api<unknown>(`/api/certs/${encodeURIComponent(id)}`, { signal }),
  "document-template": (id, signal) => api<unknown>(`/api/templates/${encodeURIComponent(id)}`, { signal }),
  "receipt-batch": (id, signal) => api<unknown>(`/api/receivables/batches/${encodeURIComponent(id)}`, { signal }),
  "payment": (id, signal) => api<unknown>(`/api/receivables/batches/${encodeURIComponent(id)}`, { signal }),
};
function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}
function labelFor(key: EditorKey, response: unknown): string | null {
  const body = object(response);
  const detail = key.record.kind === "shipment" ? object(body.shipper) : key.record.kind === "invoice" ? object(body.invoice) : body;
  if (key.record.kind === "document-template") {
    if (detail.id !== key.record.id || typeof detail.name !== "string" || !Array.isArray(detail.versions)) return null;
    const version = detail.versions.map(object).find(v => String(v.versionNumber) === key.entityVersion && Number.isSafeInteger(v.versionNumber));
    if (!version || !["DRAFT", "PUBLISHED", "DISCARDED"].includes(String(version.status))) return null;
    return `${detail.name} — version ${version.versionNumber} (${String(version.status).toLowerCase()})`;
  }
  if (key.record.kind === "payment" && (!Array.isArray(detail.payments) || !detail.payments.some(payment => object(payment).id === key.childId))) return null;
  const field: Record<string, string> = { order: "orderNumber", shipment: "shipperNumber", invoice: "documentNumber", quote: "quoteNumber", part: "partNumber", cert: "orderNumber", "document-template": "name", "receipt-batch": "batchNumber", payment: "batchNumber" };
  const value = detail[field[key.record.kind]];
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (key.record.kind === "cert") {
    const scope = typeof detail.scope === "string" ? detail.scope.toLowerCase() : "certification";
    const sequence = typeof detail.sequence === "number" ? ` ${detail.sequence}` : "";
    return `Order ${value} — ${scope}${sequence}`;
  }
  return `${value}`;
}
function AuthorizedRow({ row }: { row: DraftListRow }) {
  const [label, setLabel] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const editorKey = row.key;
  useEffect(() => {
    let live = true;
    setLabel(null);
    const session = peekBrowserDraftSession();
    const readLabel = labelReaders[editorKey.record.kind];
    if (!session || !readLabel) return;
    const ticket = session.readAuthorizationTicket();
    if (!ticket) return;
    const controller = new AbortController();
    readLabel(editorKey.record.id, controller.signal)
      .then(response => { if (live && session.isReadAuthorized(ticket)) setLabel(labelFor(editorKey, response)); })
      .catch(() => { if (live) setLabel(null); });
    return () => { live = false; controller.abort(); };
  }, [editorKey, retry]);
  return <li className="border-t border-line py-2">
    <span>{row.metadata.label}{label ? ` — ${label}` : ""}{row.pending ? row.submissionPhase === "rollback" ? " (Save rejected; refreshing draft)" : " (save pending)" : ""}</span>{" "}
    <Link href={row.metadata.href} onClick={() => { peekBrowserDraftSession()?.select(row.key); }} className="underline">Return to editor</Link>
    <button type="button" className="ml-2 underline" onClick={() => {
      const store = peekBrowserDraftSession()?.store;
      if (store?.getSnapshot().identityReady) store.discard(row.stamps);
    }}>Discard</button>
    {!label && labelReaders[row.key.record.kind] && <button type="button" className="ml-2 underline" onClick={() => setRetry(value => value + 1)}>Retry record label</button>}
  </li>;
}
export function DraftsInTab() {
  // The button needs only the count (#700): a keystroke in a recoverable editor publishes a new
  // summary without changing it, so the rail renders nothing for that keystroke.
  const { count } = useDraftCount();
  const [open, setOpen] = useState(false);
  return <div className="relative">
    <button type="button" aria-expanded={open} aria-label={`Drafts in this tab (${count})`} onClick={() => setOpen(value => !value)} className={BUTTON_NEUTRAL}>Drafts · {count}</button>
    {open && <DraftsPanel onClose={() => setOpen(false)} />}
  </div>;
}
/** Mounted only while open, so the whole summary (its rows, whose stamps Discard needs) is read
 *  only then, and every identity transition still renders it again. */
function DraftsPanel({ onClose }: { onClose: () => void }) {
  const { summary } = useBrowserDraftStore();
  // The store subscription also observes identity transitions. Including this revision in
  // row lifetime refreshes cached labels even when React batches checking and ready states.
  const authorizationRevision = peekBrowserDraftSession()?.getReadAuthorizationRevision() ?? 0;
  return <section aria-label="Drafts in this tab" className={`${CARD} absolute right-0 z-20 mt-2 max-h-96 w-80 overflow-auto text-sm shadow-lg`}>
    <p className="text-sm">Changes stay in this tab until you save, discard, sign out, or close it.</p>
    {!summary.identityReady ? <p role="status">Confirm your identity to view retained editors.</p> : summary.count === 0 ? <p>No unsaved drafts.</p> : <ul>{summary.rows.map(row => <AuthorizedRow key={`${authorizationRevision}:${JSON.stringify(row.key)}`} row={row} />)}</ul>}
    <button type="button" className="mt-2 underline" onClick={onClose}>Close</button>
  </section>;
}
