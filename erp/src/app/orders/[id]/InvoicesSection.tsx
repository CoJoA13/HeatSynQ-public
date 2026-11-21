"use client";
import { formatDate, formatMoney } from "@/lib/format";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/fetcher";
import type { Gate } from "@/lib/permission-ui";
import { peekBrowserDraftSession } from "@/lib/draft-session";
import { useLatest } from "@/lib/use-latest";
import {
  INVOICE_KIND_LABELS, INVOICE_STATUS_LABELS,
  type InvoiceKindValue, type InvoiceStatusValue,
} from "@/lib/invoice-constants";
import type { OrderStatusValue } from "@/lib/order-constants";
import { askDiscard, captureDiscardNavigation } from "@/lib/use-unsaved-section";
import { BUTTON_PRIMARY_COMPACT, CARD, LINK, NOTICE } from "@/lib/ui-classes";

/** Local mirror of src/server/invoices.ts's `InvoiceListRow` — not imported from src/server/**
 *  (CLAUDE.md). Same shape `GET /api/orders/[id]/invoices` (`invoicesForOrder`, Task 16) and
 *  `/invoicing`'s own list share. */
type InvoiceRow = {
  id: string; kind: InvoiceKindValue; status: InvoiceStatusValue;
  orderId: string; orderNumber: number; documentNumber: string;
  customerId: string; customerCode: string; customerName: string;
  invoiceDate: string; total: number; finalizedAt: string | null; deletedAt: string | null;
};

/**
 * The hub's Invoices section (design spec §6/§11, Task 18): every invoice/credit ever raised
 * against this order — discarded drafts included, dimmed rather than hidden — the
 * ShipmentsSection.tsx precedent. Rows link to `/invoicing/[id]`; a Create invoice button appears
 * when the order is SHIPPED with no live invoice (`createInvoice`'s own refusal reasons, named
 * here proactively rather than left to a guaranteed-400 click — §5.16).
 */
export function InvoicesSection({
  orderId, orderStatus, viewGate, createGate,
}: {
  orderId: string;
  orderStatus: OrderStatusValue;
  viewGate: Gate;
  createGate: Gate;
}) {
  const router = useRouter();
  const navigationLifetime = useRef<{ live: boolean; request?: object }>({ live: false });
  useEffect(() => {
    const token = { live: true };
    navigationLifetime.current = token;
    return () => { token.live = false; };
  }, [orderId]);
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  // A `loaded` flag distinct from "the array is empty" (HANDOFF §5.15 / Task 8's headline
  // defect, and this section's own Fix 1): a failed fetch must say so, never render as a
  // genuinely empty, healthy list — and must not leave `hasLiveInvoice` trusting an empty
  // `rows` it never actually got to fill. Mirrors InvoicingList.tsx's `loadCandidates`.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const allowed = viewGate.allowed;
  const latest = useLatest();
  // Ticket-gated on BOTH the success and the rejection path (InvoicingList.tsx precedent): a
  // stale response must never overwrite a newer one, in either direction. No `.catch(() => {})`
  // anywhere.
  const load = useCallback(async () => {
    if (!allowed) return;
    const t = latest.next();
    let data: InvoiceRow[];
    try {
      data = await api<InvoiceRow[]>(`/api/orders/${orderId}/invoices`);
    } catch (e) {
      if (latest.isCurrent(t)) {
        setError((e as Error).message);
        setLoaded(true);
      }
      return;
    }
    if (!latest.isCurrent(t)) return;
    setRows(data);
    setError(null);
    setLoaded(true);
  }, [orderId, allowed, latest]);
  useEffect(() => { void load(); }, [load]);

  // Trustworthy only once the load actually succeeded — an empty `rows` after a failed or
  // never-completed load says nothing about whether a live invoice exists.
  const hasLiveInvoice = loaded && !error && rows.some((r) => r.kind === "INVOICE" && r.deletedAt === null);
  const createTitle = !createGate.allowed
    ? createGate.title
    : orderStatus !== "SHIPPED"
      ? "Only a fully shipped order can be invoiced"
      : !loaded || error
        ? "Could not confirm this order's invoice status — reload the page to try again"
        : hasLiveInvoice
          ? "This order already has an invoice — open it below"
          : creating ? "Creating…" : undefined;

  async function createInvoice() {
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
    // The discard question through the modal (ruling 5): the answer lands a tick later, so the
    // attempt and the request are proved current again after it.
    if (!(await askDiscard())) { attempt.cancel(); return; }
    if (!attempt.isCurrent() || !ownRequest()) { attempt.cancel(); return; }
    setCreating(true);
    let res: { invoice: { id: string } };
    try {
      res = await api<{ invoice: { id: string } }>("/api/invoices", {
        method: "POST", body: JSON.stringify({ orderId }),
      });
    } catch (e) {
      if (ownRequest()) {
        if (attempt.isCurrent()) {
          setCreating(false);
          setError((e as Error).message);
        } else {
          // The create may have committed: read the list again, busy until the read settles (below).
          void load().then(() => { if (ownRequest()) setCreating(false); });
        }
      }
      attempt.cancel();
      return;
    }
    // Busy and the re-read belong to this local request, even if another caller cancelled its
    // departure. A cancelled departure reads the list again to show the invoice, and stays busy until
    // that read settles (`load` never rejects), so Create does not open over the rows read before the
    // create while the read is out. A routing error cannot turn this into a failed creation.
    if (!ownRequest()) return;
    if (!attempt.isCurrent()) { void load().then(() => { if (ownRequest()) setCreating(false); }); return; }
    setCreating(false);
    try {
      if (!attempt.attach(`/invoicing/${res.invoice.id}`)) return;
      router.push(`/invoicing/${res.invoice.id}`);
    } catch {
      if (ownRequest() && attempt.isCurrent()) {
        setError("Invoice created, but navigation failed. Reload the invoice list to open it.");
      }
      attempt.cancel();
    }
  }

  // §5.16: a caller without invoicing.view sees the section saying why, never a silently empty one.
  if (!viewGate.allowed) {
    return (
      <section className={`${CARD} mb-6`}>
        <h2 className="mb-2 font-medium">Invoices</h2>
        <p className="text-sm text-ink-500">{viewGate.title ?? "You do not have permission to view invoices."}</p>
      </section>
    );
  }

  return (
    <section className={`${CARD} mb-6`}>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-medium">Invoices</h2>
        <button onClick={() => void createInvoice()} disabled={createTitle !== undefined} title={createTitle}
                className={BUTTON_PRIMARY_COMPACT}>
          {creating ? "Creating…" : "Create invoice"}
        </button>
      </div>

      {error && <p className={`${NOTICE.refusal} mb-3`}>{error}</p>}

      {loaded && !error && rows.length === 0 ? (
        <p className="text-sm text-ink-500">No invoices raised against this order yet.</p>
      ) : rows.length > 0 ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-ink-500">
              <th className="py-1 font-medium">Document</th>
              <th className="font-medium">Kind</th>
              <th className="font-medium">Status</th>
              <th className="font-medium">Invoice date</th>
              <th className="text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={`border-t ${r.deletedAt ? "text-ink-500" : ""}`}>
                <td className="py-1 font-mono">
                  <Link href={`/invoicing/${r.id}`} className={LINK}>{r.documentNumber}</Link>
                  {r.deletedAt && <span className="ml-2 rounded bg-line px-1 text-xs text-ink-800">discarded</span>}
                </td>
                <td>{INVOICE_KIND_LABELS[r.kind]}</td>
                <td>{INVOICE_STATUS_LABELS[r.status]}</td>
                <td>{formatDate(r.invoiceDate)}</td>
                <td className="tabular-nums text-right">{formatMoney(r.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
