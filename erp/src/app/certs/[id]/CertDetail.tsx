"use client";
// The certification page's body (design spec §11 "Cert page"): header (order link, scope and its
// subject, printed date, void), a prominent three-state pass/fail summary WITH the §3.21
// explanation (none of it prints), one requirement block per seeded `CertRequirement` grouped by
// part line (RequirementBlock.tsx), freeform + internal notes, the live print action (Task 19's
// POST /api/certs/[id]/print, wired at the fold-in), stored documents, and History. Remounted per
// id by page.tsx's `key={id}` (HANDOFF §5.12).
//
// THE BINDING STATE MODEL (the ShipmentDetail.tsx / order-hub precedent): notes PATCHes are
// optimistic with rollback-then-report on failure (§5.13 — reload BEFORE setting the error,
// never after); a readings save is non-optimistic (the block's draft is applied only through the
// server's own fresh response) and a FAILED save is also rollback-then-report — reload server
// truth, discard the block's draft (bumpReset remounts it), then show the error. Every mutating
// call on this page answers with the ENTIRE fresh CertDetail, so all of them share ONE monotonic
// mutation-ticket sequence (`useMutationGate`, fix-wave R4 finding 6).
import { formatDate, formatDateTime } from "@/lib/format";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, trackedFetch, UnreadableAnswerError } from "@/lib/fetcher";
import { gate, gateDo, type Gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { useMutationGate } from "@/lib/use-latest";
import { drainOtherKeys, makeWriteSignals, reReadAfter } from "@/lib/drain-queue";
import { useEditGuard } from "@/lib/use-edit-guard";
import { HistoryPanel, invalidateHistory } from "@/components/HistoryPanel";
import { DangerButton } from "@/components/DangerButton";
import { CERT_SCOPE_LABELS, type CertScopeValue } from "@/lib/cert-constants";
import { RequirementBlock, type ReadingPayload } from "./RequirementBlock";
import type { CapturedCertReadings } from "@/lib/cert-readings-recovery";
import { useUnsavedPresent } from "@/lib/use-unsaved-section";
import { ListStatus, PageStatus } from "@/components/PageStatus";
import { useStoredDocuments } from "@/lib/use-stored-documents";
import { askReason } from "@/lib/modal";
import { PageHeader } from "@/components/PageHeader";
import { RecordTabs } from "@/components/RecordTabs";
import { AtAGlance } from "@/components/AtAGlance";
import { CERT_TAB_LABEL, certTabs } from "@/lib/cert-tabs";
import { BUTTON_PRIMARY, CARD, INPUT_COMPACT, LINK, NOTICE } from "@/lib/ui-classes";

// ---------------------------------------------------------------------------------------------
// Types. Local mirrors of src/server/certs.ts's `CertDetail`/`CertRequirementDetail`/
// `CertReadingDetail` — not imported from src/server/** (CLAUDE.md: a client component pulling
// from there drags node:async_hooks and Prisma into the browser bundle). Dates cross the wire as
// ISO strings. Exported so RequirementBlock.tsx imports the ones it needs — the
// ShipmentDetail.tsx precedent.
// ---------------------------------------------------------------------------------------------

export type CertReadingRow = {
  id: string; position: number; value: number | null;
  passed: boolean | null; overridden: boolean; note: string;
};
export type CertRequirementRow = {
  id: string; orderLineId: string | null; orderLineIdAtSeed: string;
  linePosition: number; partNumber: string; partName: string;
  position: number; inspectionCodeId: string; inspectionCodeName: string; scaleId: string | null; scaleName: string | null;
  min: number | null; max: number | null; sampleQty: string; location: string;
  readings: CertReadingRow[];
};
export type CertDetailData = {
  id: string; orderId: string; orderNumber: number; sequence: number | null;
  customerCode: string; customerName: string; scope: CertScopeValue;
  loadNumber: number | null; shipperId: string | null; shipperNumber: number | null;
  printedAt: string | null; deletedAt: string | null;
  freeform: string; internalNotes: string;
  poNumber: string; material: string; receivedDate: string;
  requirements: CertRequirementRow[];
};

/** Slice of `GET /api/certs/[id]/documents`'s `DocumentMeta` (src/server/documents.ts). */
type StoredDoc = { id: string; kind: string; createdAt: string };
// `entity` since #153 — see the order hub's identical note: the single-record audit read is a
// union, so a row in it is not necessarily the cert's own.
type AuditEntry = { id: string; entity: string; action: string; reason: string | null };

/** Spec §3.19: a cert has no number of its own — its label is its order number, plus that
 *  order's shipment sequence for SHIPMENT scope (`#92036-3`), the CertList.tsx precedent. */
function certLabel(cert: CertDetailData): string {
  return cert.scope === "SHIPMENT" && cert.sequence !== null
    ? `#${cert.orderNumber}-${cert.sequence}`
    : `#${cert.orderNumber}`;
}

/** The scope's SUBJECT (task-16-brief.md Step 1): the load number or the packing-list number —
 *  ORDER scope carries neither, the CertList.tsx `loadOrShipment` precedent. */
function scopeSubject(cert: CertDetailData): string | null {
  if (cert.scope === "LOAD") return cert.loadNumber !== null ? `Load ${cert.loadNumber}` : null;
  if (cert.scope === "SHIPMENT") return cert.shipperNumber !== null ? `Packing List ${cert.shipperNumber}` : null;
  return null;
}

/** A voided cert is read-only everywhere (spec §5.6, the P3 voided-order shape) regardless of
 *  what the permission grid would otherwise allow — the ShipmentDetail.tsx `voidLocked`
 *  precedent. */
function voidLocked(g: Gate, voided: boolean): Gate {
  return voided ? { allowed: false, disabled: true, title: "Certification is voided" } : g;
}

/** The results-grid gate (§5.16 — a disabled control SAYS WHY): voided locks everything; then
 *  `certs.edit`; then, once `printedAt` is set, additionally the named special action. The
 *  after-print title names the missing permission the way `gateDo`'s own tooltip would. */
function resultsGateFor(perms: string[] | undefined, voided: boolean, printed: boolean): Gate {
  const edit = voidLocked(gate(perms, "certs.edit"), voided);
  if (!edit.allowed) return edit;
  if (printed) {
    const after = gateDo(perms, "edit_cert_results_after_print");
    if (!after.allowed) {
      return {
        allowed: false, disabled: true,
        title: "This certification has been printed — editing results requires edit_cert_results_after_print",
      };
    }
  }
  return edit;
}

/** The stored-documents list (spec §11) — `GET /api/certs/[id]/documents` (Task 16; no other
 *  HTTP caller existed for `listDocumentsForCert` before this page needed one). Not printing
 *  itself (Task 19 owns that); a plain link to the existing, already-gated
 *  `GET /api/documents/[id]` download route — the ShipmentDocumentsList precedent. */
function CertDocumentsList({ certId, scope, viewGate, refresh }: { certId: string; scope: string; viewGate: Gate; refresh: number }) {
  // The shared read and state (P6 step 3, #632): "Loading…" until a read lands, never the empty
  // sentence before then, and a read that lands clears an earlier failure.
  const { docs, error: err, status } = useStoredDocuments<StoredDoc>(`/api/certs/${certId}/documents`, viewGate.allowed, refresh);

  if (status !== "rows") return <ListStatus status={status} denied={viewGate.title} error={err} empty="Nothing printed yet." />;
  // Scope / Created / Open PDF (PR 5, the PR 4 shape): every row is this cert's own print, so the
  // Scope cell is the cert's scope and subject, handed down by the page.
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-ink-500">
          <th className="py-1 font-medium">Scope</th><th className="font-medium">Created</th><th className="font-medium"><span className="sr-only">Open</span></th>
        </tr>
      </thead>
      <tbody>
        {docs.map((d) => (
          <tr key={d.id} className="border-t">
            <td className="py-1">{d.kind === "CERT" ? scope : d.kind}</td>
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

export function CertDetail({ id }: { id: string }) {
  const { permissions: perms, error: permsError } = usePermissions();

  const [cert, setCert] = useState<CertDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // undefined = fetched but no reason could be resolved (missing admin.view, the fetch failed,
  // or the latest entry wasn't a delete); null = not applicable (cert isn't voided) — the
  // ShipmentDetail.tsx `voidReason` precedent.
  const [voidReason, setVoidReason] = useState<string | null | undefined>(null);
  // Per-requirement presentation counters: the captured binding outcome retires the draft;
  // bumping only the still-owned generation refreshes the block and re-seeds it
  // from server truth — after a successful save (fresh computed pass/fail comes back) and after
  // a FAILED save (rollback-then-report). Other blocks' keys are untouched, so their unsaved
  // drafts survive — the merge semantics of PUT …/results, mirrored client-side.
  const [blockResets, setBlockResets] = useState<Map<string, number>>(new Map());
  const bumpReset = useCallback((requirementId: string) => {
    setBlockResets((prev) => {
      const next = new Map(prev);
      next.set(requirementId, (next.get(requirementId) ?? 0) + 1);
      return next;
    });
  }, []);

  // ONE monotonic ticket sequence shared by every write and by `load`'s own refresh — every
  // mutating call here replaces the whole `cert` state, so overlapping calls race and the ticket
  // ensures the winner is whichever is genuinely newest (the ShipmentDetail.tsx precedent). A read
  // the server served before a write still out had committed holds the newer ticket, so it either
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
  // the same cert sent and still out (the cert left and opened again within one round trip;
  // page.tsx remounts on `key={id}`) is not in it. Nothing aborts that write on unmount, its answer
  // reaches only the unmounted instance, and no read of this mount is followed for it.
  const [writes] = useState(makeWriteSignals);
  // Every set-from-server-detail below routes through `editGuard.applyPayload` so an arriving detail —
  // a sibling field's PATCH response, or §5.13's rollback `load()` — never resets the notes field
  // the user is actively typing in (use-edit-guard.ts; the fix-wave notes-clobber trio, of which
  // ShipmentDetail.tsx and customers/[id]/page.tsx carry the same shape).
  const editGuard = useEditGuard();

  const load = useCallback(async () => {
    // #573 (owner ruling 2026-10-20, the hub's #550 "read now, re-read after"): the GET goes out at
    // once, as before. A write of this page that was out as it was sent (a notes PATCH, a readings
    // PUT: everything `applyMutation` registers) may commit after the server served it, and then
    // the payload predates that write: applied after the write's answer it reverts the write on
    // screen, and applied before it the answer, older-ticketed, is dropped. The two rollback reads
    // drain every other key first, so the read this exposed was the print's follow-up `load()`
    // (`printCertAction`): Print is not closed by a notes blur-save, so a notes PATCH out as the
    // print answered showed the old notes, or reverted to them, until the next payload. So when the
    // snapshot below holds a write, the page reads once more after every write in it has settled,
    // whether or not one was still out when this read landed, and whether or not this read was
    // accepted. Detached: `load` resolves with this read, and its caller (the mount effect, the two
    // rollback reads, the print's follow-up, Void's read) follows it without waiting on a write
    // (#276: `api()` has no timeout). The follow-up is this same read, applying the cert under its
    // own ticket taken as it is sent, so it is followed in turn when a write sent since was out as
    // it went; the chain ends at the first read sent with no write out. A read that fails applied
    // nothing and is followed by nothing. This page's `load` has no recovery read to mark and no
    // catch, so a follow-up that fails does nothing: it shows no message and is not retried, and
    // the page keeps what it shows until the next payload or a reload.
    const readCert = async (): Promise<CertDetailData> => {
      const ticket = mutations.next();
      // The writes out as this GET is sent. One sent after it holds a newer ticket, so the gate
      // already orders its answer against this read, and it is not waited for.
      const writesOut = writes.outstanding();
      const detail = await api<CertDetailData>(`/api/certs/${id}`);
      // Captured-session apply inside the accept branch (use-edit-guard.ts, the round-3 fixpoint).
      if (mutations.accept(ticket)) setCert(editGuard.applyPayload(detail));
      reReadAfter(writesOut, () => { void readCert().catch(() => {}); });
      return detail;
    };
    return readCert();
  }, [id, mutations, editGuard, writes]);
  useEffect(() => {
    load().then(() => setError(null)).catch((e) => setError((e as Error).message));
  }, [load]);

  const applyMutation = useCallback(async (run: () => Promise<CertDetailData>) => {
    const ticket = mutations.next();
    let detail: CertDetailData;
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
      detail = await request;
    } catch (error) {
      // #547 (owner ruling 2026-10-18): a 2xx whose answer could not be read committed its write, so
      // History is told here, as a landed save tells it (#158). On this page the two callers
      // (`patchNotes`, `saveReadings`) tell after a save that landed and never in their catch, so
      // for this error kind this branch is the only tell, and a landed save is still told once.
      // Nothing is applied and the cert itself is not read again here (no `load`; History reads its
      // own list, and the callers' existing rollback reads follow in their catch); the rejection
      // still reaches the caller, and the registry entry goes when the request settles, so a `load`
      // sent beside the write reads once more after it (#573). As of 6e42469 every thunk run through
      // here sends one write and no read (a census, not a guarantee).
      if (error instanceof UnreadableAnswerError) invalidateHistory();
      throw error;
    }
    if (mutations.accept(ticket)) setCert(editGuard.applyPayload(detail));
  }, [mutations, editGuard, writes]);

  const voided = (cert?.deletedAt ?? null) !== null;
  const printed = (cert?.printedAt ?? null) !== null;
  const auditGate = gate(perms, "admin.view");
  const docsGate = gate(perms, "certs.view");
  const notesGate = voidLocked(gate(perms, "certs.edit"), voided);
  const resultsGate = resultsGateFor(perms, voided, printed);
  const voidGate = voided
    ? { allowed: false, disabled: true, title: "Already voided" }
    : gate(perms, "certs.delete");
  // Print (Task 19's POST /api/certs/[id]/print, live since the fold-in). Gated certs.view like
  // the route — printing mutates nothing beyond the first-print printedAt fact and its own
  // audited archive. A voided cert refuses NEW prints forever (spec §5.6), which is the more
  // specific reason when both apply (§5.16 — disabled with a truthful title, never hidden).
  const printGate: Gate = voided
    ? { allowed: false, disabled: true, title: "Certification is voided — no new documents can be produced for it" }
    : gate(perms, "certs.view");

  // Any requirement block on this page holding unsaved readings — read for the Print button below.
  const unsavedReadings = useUnsavedPresent();

  // Voided banner's reason (ShipmentDetail.tsx precedent) — safe to key on `voided` alone: once
  // voided, no mutator can touch the cert again, so the delete entry is the cert's own newest.
  // Since #153 this read is a capped union over the parent's child sections, so it is found by
  // `entity`, not by position — see the order hub's fuller note on both points.
  useEffect(() => {
    if (!voided) { setVoidReason(null); return; }
    if (!auditGate.allowed) { setVoidReason(undefined); return; }
    api<{ rows: AuditEntry[]; hasMore: boolean }>(`/api/admin/audit?entity=cert&entityId=${id}`)
      .then(({ rows }) => {
        const latest = rows.find((e) => e.entity === "cert");
        setVoidReason(latest?.action === "delete" ? (latest.reason ?? undefined) : undefined);
      })
      .catch(() => setVoidReason(undefined));
  }, [voided, auditGate.allowed, id]);

  // ---- Notes: optimistic blur-save PATCH (ShipmentDetail.tsx `patchHeader` precedent) ----

  // Per-key request queue (Task 7 — the InvoiceDetail.tsx `serial` shape, which this page never
  // received): without it, two overlapping PATCHes to the same notes field (an ordinary
  // double-blur) can commit out of order server-side and leave the database holding the opposite
  // of the last thing the UI showed. Readings saves join the same queue under per-block keys
  // below, so two blocks still save in parallel while each block serializes with itself — and a
  // failing save drains the OTHER keys' in-flight requests before its §5.13 rollback load.
  // `serial` is a useCallback (unlike its siblings' plain functions) because `saveReadings`
  // lists it as a dep.
  const queue = useRef<Map<string, Promise<unknown>>>(new Map());
  const serial = useCallback(function run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = queue.current.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    queue.current.set(key, next.catch(() => {}));
    return next;
  }, []);
  // Per-key REQUEST-settled signals for the failure drains below (Task 7 fix round 1): the drain
  // must never await the queue's chain TAILS — a tail settles only after its own catch, drain
  // included, completes, so two keys' saves both failing while overlapping had each catch
  // awaiting the other's tail: a mutual deadlock. A signal settles with its key's dispatched
  // request — which IS the commit/failure the rollback GET must postdate — and never depends on
  // a drain, so no cycle is possible (drain-queue.ts carries the full story).
  const inFlight = useRef<Map<string, Promise<unknown>>>(new Map());

  // A keystroke into a guarded detail object types through this pure updater, never an object
  // built from the render's copy, so a server payload landing beside the keystroke is kept (#574).
  function patchDraft(patch: Partial<CertDetailData>) {
    setCert((cur) => (cur ? { ...cur, ...patch } : cur));
  }

  /** Optimistic: the field shows the typed value immediately; a rejection rolls back to server
   *  truth FIRST and only then reports why (§5.13 — a reload after the error is set would clear
   *  it, since the initial-load effect resets `error` on success but `load` itself never does). */
  async function patchNotes(patch: { freeform?: string; internalNotes?: string }): Promise<void> {
    setCert((cur) => (cur ? { ...cur, ...patch } : cur));
    // A multi-field patch's composite key would NOT serialize against its constituent
    // single-field keys — latent only: every caller PATCHes one field per save.
    const key = Object.keys(patch).sort().join(",");
    return serial(key, async () => {
      try {
        const req = applyMutation(() => api<CertDetailData>(
          `/api/certs/${id}`, { method: "PATCH", body: JSON.stringify(patch) }));
        inFlight.current.set(key, req.then(() => {}, () => {})); // request-settled signal, at dispatch
        await req;
        // #158 — success path, the instant the PATCH resolves (#124/!131 ordering). Every
        // mutation on this page writes a `cert` row (notes, readings, the first print's
        // `printedAt`, the void), which is exactly what the panel at the bottom shows.
        invalidateHistory();
        setError(null);
      } catch (e) {
        // §5.13 rollback-drain (Task 7): wait out every OTHER key's in-flight request before
        // the rollback GET — served before a sibling key's save commits, the newest-ticket GET
        // would revert that sibling's committed write on screen. Drains the request-settled
        // SIGNALS above, never the queue tails (fix round 1 — mutual deadlock; drain-queue.ts
        // has the story). The rollback read is `load`, which re-reads after any registered write
        // that was out as it was sent (#573): a drained sibling's registry entry is gone before the
        // GET snapshots it, so the drain keeps only its timing effect.
        await drainOtherKeys(inFlight.current, key);
        await load().catch(() => {});
        setError((e as Error).message);
      }
    });
  }

  // Blur-save guard and focused-field tracking are both `editGuard`'s (use-edit-guard.ts): the
  // no-op guard is unchanged, and the focus handler now also names which notes field is under the
  // cursor so `merge` above can preserve it.

  // ---- Readings: non-optimistic per-requirement save (merge semantics — only the named
  // requirement's readings are replaced; every other requirement is untouched server-side) ----

  // Queued per BLOCK (`readings:` prefixed so requirement-id keys can never collide with the
  // notes-field key space): two blocks still save in parallel, each block serializes with
  // itself, and the failure drain below covers every other key — notes and sibling blocks alike.
  const saveReadings = useCallback(async (requirementId: string, _readings: ReadingPayload[], captured: CapturedCertReadings) => {
    const { binding, submission } = captured;
    if (submission.stamp.key.record.id !== id || submission.stamp.key.childId !== requirementId) return;
    const key = `readings:${requirementId}`;
    return serial(key, async () => {
      // Capture was after local validation; dispatch belongs to the actual serial thunk.
      if (!binding.dispatched(submission)) return;
      let resetGeneration = false;
      const mayReset = () => {
        const current = binding.getSnapshot();
        // Check again after drain/rollback: a replacement could have appeared during either.
        return resetGeneration && current.needsRefresh && !current.current && !current.reference;
      };
      try {
        const req = applyMutation(async () => {
          let response: CertDetailData;
          try {
            response = await api<CertDetailData>(`/api/certs/${id}/results`, {
              method: "PUT", body: JSON.stringify({ requirements: [{ id: requirementId, readings: submission.payload }] }),
            });
          } catch (e) {
            resetGeneration = binding.getSnapshot().current?.stamp.generation === submission.stamp.generation;
            const rejected = typeof e === "object" && e !== null && "status" in e && typeof e.status === "number" && e.status >= 400 && e.status < 500;
            binding.settle(submission, { kind: rejected ? "rejected" : "unknown" });
            throw e;
          }
          resetGeneration = binding.getSnapshot().current?.stamp.generation === submission.stamp.generation;
          // Raw acknowledgement precedes mutation-ticket acceptance and all presentation.
          binding.settle(submission, { kind: "persisted", response });
          return response;
        });
        inFlight.current.set(key, req.then(() => {}, () => {})); // request-settled signal, at dispatch
        await req;
        invalidateHistory();
        setError(null);
        if (mayReset()) bumpReset(requirementId);
      } catch (e) {
        // These are request-settled signals, never serial queue tails. Raw outcome already
        // retired the submitted generation even if this rollback GET subsequently fails. The
        // rollback read is `load`, which re-reads after any registered write that was out as it
        // was sent (#573): a drained sibling's registry entry is gone before the GET snapshots it,
        // so the drain keeps only its timing effect.
        await drainOtherKeys(inFlight.current, key);
        await load().catch(() => {});
        if (mayReset()) bumpReset(requirementId);
        setError((e as Error).message);
      }
    });
  }, [id, serial, applyMutation, load, bumpReset]);

  // ---- Print: the ShipmentDetail.tsx `printDoc` pipeline (popup handling and error surfacing
  // shared shape; the x-print-warnings decode there is shipment-specific and has no counterpart
  // here — the cert route carries no warnings header). After a successful print the page reloads
  // server truth so the §5.16 post-print gate engages live (printedAt is now set), and the
  // Documents list refreshes to show the newly archived print. ----

  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const [docsRefresh, setDocsRefresh] = useState(0);

  const printCertAction = useCallback(async () => {
    setPrinting(true);
    setPrintError(null);
    try {
      const res = await trackedFetch(`/api/certs/${id}/print`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Print failed (${res.status})`);
      }
      // #158 — success path, the instant the print resolves. The FIRST print stamps `printedAt`
      // through `auditedUpdate("cert", …)` (certs.ts); a reprint writes no cert row, and an
      // invalidation that finds nothing new is one gated GET.
      invalidateHistory();
      const url = URL.createObjectURL(await res.blob());
      const opened = window.open(url, "_blank");
      if (opened) opened.opener = null;
      if (opened === null) {
        // Never silent (the DocumentsSection rule): the print HAPPENED and is archived — the
        // refreshed Documents list below is the escape hatch, and this message says so.
        setPrintError("The browser blocked the print window — the certification was archived and is in Documents & history.");
      }
      // Revoked on a delay either way — revoking immediately would race the new tab's own load
      // (the DocumentsSection precedent, fix-wave finding 6).
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setDocsRefresh((n) => n + 1);
      // printedAt is now set server-side (first print) — reload so the results-grid gate and the
      // header's Printed fact reflect it. A failed refresh must not read as a failed print.
      try {
        await load();
      } catch (e) {
        setPrintError(`Printed and archived, but the page could not be refreshed — reload to see the current state. (${(e as Error).message})`);
      }
    } catch (e) {
      setPrintError((e as Error).message);
    } finally {
      setPrinting(false);
    }
  }, [id, load]);

  // ---- Void: non-optimistic (ShipmentDetail.tsx `voidAction` precedent) ----

  async function voidAction() {
    if (!cert) return;
    // Through the modal (ruling 5 of 2026-10-30; PR 5): it holds the dialog open on a blank reason
    // with the sentence below and resolves null on Cancel.
    const reason = await askReason({
      question: `Void certification ${certLabel(cert)}?\n\n` +
        "Every control on this certification becomes read-only; its stored prints stay " +
        "reprintable forever, and this cannot be undone through the UI.",
      verb: "voiding", blankRefusal: "A reason is required to void a certification.",
    });
    if (reason === null) return; // cancelled
    // Two separate try/catches: DELETE returns `{ ok: true }`, not a fresh CertDetail, so
    // picking up deletedAt needs a follow-up `load()` — and if THAT fails, the void succeeded.
    try {
      await api(`/api/certs/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
    } catch (e) {
      // #547 (owner ruling 2026-10-18): a 2xx proves the void committed, and its answer holds only
      // `{ ok: true }`, so an answer that could not be read falls through to the success path below.
      // Any other failure shows its message and stops.
      if (!(e instanceof UnreadableAnswerError)) {
        setError((e as Error).message);
        return;
      }
    }
    // #158 — success path, before the follow-up load. The void is an `auditedSoftDelete("cert", …)`
    // carrying the typed reason, and this page stays mounted (read-only) to show it.
    invalidateHistory();
    setError(null);
    try {
      await load();
    } catch (e) {
      setError(`Certification voided, but the page could not be refreshed — reload to see the current state. (${(e as Error).message})`);
    }
  }

  if (!cert) return <PageStatus error={error ?? permsError} />;

  // Three explicit states over the actual readings — passed === true / failed === false /
  // pending === null. Never inferred by subtraction (the Task 15 review finding CertList.tsx's
  // own header comment records): a reading nobody has entered is PENDING, not a pass.
  const allReadings = cert.requirements.flatMap((r) => r.readings);
  const passedCount = allReadings.filter((r) => r.passed === true).length;
  const failCount = allReadings.filter((r) => r.passed === false).length;
  const pendingCount = allReadings.filter((r) => r.passed === null).length;

  // Requirement blocks grouped by part line (task-16-brief.md Step 2), preserving the cert's own
  // running `position` order within and across groups — requirements arrive position-ordered, so
  // consecutive grouping keeps both orders intact. Grouped on the FROZEN `linePosition` (round-4
  // finding): `orderLineId` goes null for every released line (snapshot + release), so two
  // removed riders would otherwise merge into one block under the first part's heading.
  const identityOf = (req: CertRequirementRow) => (req.orderLineIdAtSeed !== ""
    ? req.orderLineIdAtSeed
    : `${req.linePosition}\u0000${req.partNumber}\u0000${req.partName}`);
  const groups: { identity: string; linePosition: number; partNumber: string; partName: string; requirements: CertRequirementRow[] }[] = [];
  for (const req of cert.requirements) {
    const last = groups[groups.length - 1];
    // The never-reused seed-line identity (!57 review; the PDF groups the same way): positions
    // are freed and re-used by later riders, so no display-field composite can be the key.
    if (last && last.identity === identityOf(req)) {
      last.requirements.push(req);
    } else {
      groups.push({
        identity: identityOf(req), linePosition: req.linePosition,
        partNumber: req.partNumber, partName: req.partName, requirements: [req],
      });
    }
  }

  const subject = scopeSubject(cert);
  const scopeText = `${CERT_SCOPE_LABELS[cert.scope]}${subject ? ` — ${subject}` : ""}`;
  const resultsText = allReadings.length === 0
    ? "No readings yet"
    : `${passedCount} passed · ${failCount} failed · ${pendingCount} pending`;

  return (
    <div className="min-w-0 p-3 sm:p-6">
      {/* The title row (spec §4.3; PR 5): "Certification #N", the customer, scope and printed state
          under it; Print certificate in the header; Void stays in the title row (ruling 8). */}
      <PageHeader title={`Certification ${certLabel(cert)}`}
        subtitle={<span className="flex flex-wrap items-center gap-1 break-words">
          <span>{cert.customerCode} · {cert.customerName}</span>
          <span> · {CERT_SCOPE_LABELS[cert.scope]}{subject && <span className="text-ink-500"> — {subject}</span>}</span>
          <span> · {cert.printedAt ? `Printed ${formatDateTime(cert.printedAt)}` : "Not printed"}</span>
        </span>}
        actions={<>
          {/* §5.16: while a print is in flight the button is disabled for a reason the gate cannot
              name (printGate.title is undefined when allowed), so the in-progress state says why
              itself (fix-wave 2026-08-06). */}
          {/* Unsaved readings BLOCK the print, they do not merely warn (Codex P1, round 5). A print
              sends nothing local: it archives the readings the SERVER holds, permanently, under this
              cert's name. Printing over an unsaved requirement therefore produces paper that
              disagrees with the screen the operator is looking at — and on a FIRST print the reload
              afterwards can arm the after-print permission gate, leaving those local edits read-only
              and unsavable, so the disagreement becomes permanent in both directions. This is the one
              place the guard refuses rather than asks: a discarded edit can be retyped, a wrong
              certificate cannot be unissued. */}
          <button type="button" onClick={() => void printCertAction()}
                  disabled={printGate.disabled || printing || unsavedReadings}
                  title={printing
                    ? "A print is already in progress — wait for it to finish"
                    : unsavedReadings
                      ? "Save the readings first — a print archives what the server holds, not what is on screen"
                      : printGate.title}
                  className={BUTTON_PRIMARY}>
            {printing ? "Printing…" : "Print certificate"}
          </button>
          <DangerButton onClick={() => void voidAction()} disabled={voidGate.disabled} title={voidGate.title}>
            Void certification
          </DangerButton>
        </>} />

      {(error ?? permsError) && (
        <p className={`${NOTICE.refusal} mb-3`}>{error ?? permsError}</p>
      )}
      {voided && (
        <p className={`${NOTICE.refusal} mb-3 font-medium`}>
          Voided — {voidReason ?? "see History for the reason"}
        </p>
      )}

      <div className="flex flex-col gap-6 min-[1360px]:flex-row min-[1360px]:items-start">
      <div className="min-w-0 flex-1">
      {/* Three tabs over the mounted sections (spec §4.4; `src/lib/cert-tabs.ts`): the blocks'
          registry label badges Inspection results, and a tab switch is never a departure. */}
      <RecordTabs label={CERT_TAB_LABEL} tabs={certTabs()} panels={{
        results: (
      <div id="results">
      {/* ---- Pass/fail, prominently — with the §3.21 explanation (brief Step 2) ---- */}
      <section className={`${CARD} mb-4`}>
        <div className="flex flex-wrap items-baseline gap-x-6 text-lg font-semibold">
          {allReadings.length === 0 ? (
            <span className="text-ink-500">No readings yet</span>
          ) : (
            <>
              <span className="text-success-700">{passedCount} passed</span>
              <span className={failCount > 0 ? "text-red-700" : "text-ink-500"}>{failCount} failed</span>
              <span className={pendingCount > 0 ? "text-accent-600" : "text-ink-500"}>{pendingCount} pending</span>
            </>
          )}
        </div>
        <p className="mt-1 text-sm text-ink-500">
          Pass/fail is shown on screen only — it <b>never appears on the printed certification</b>,
          and neither do min/max, scale, or override marks. The printed document carries the bare
          reading values.
        </p>
      </section>

      {/* ---- Requirement blocks, grouped by part line (brief Step 2) ---- */}
      {groups.length === 0 && (
        <p className="mb-4 rounded border bg-surface-0 p-4 text-sm text-ink-500">
          No requirements were seeded for this certification — none of its order&apos;s parts had
          live inspection requirements when it was created.
        </p>
      )}
      {groups.map((group) => (
        <section key={group.identity} className={`${CARD} mb-4`}>
          <h2 className="mb-3 font-medium">
            Line {group.linePosition} — <span className="font-mono">{group.partNumber}</span>
            <span className="ml-2 font-normal text-ink-500">{group.partName}</span>
          </h2>
          {group.requirements.map((req) => (
            <RequirementBlock
              key={`${req.id}:${blockResets.get(req.id) ?? 0}`}
              certId={id} requirement={req} editGate={resultsGate} onSave={saveReadings}
            />
          ))}
        </section>
      ))}
      </div>
        ),
        wording: (
      /* ---- Notes (brief Step 3): blur-saved, labelled as the owner ruled (PR 5) ---- */
      <section id="notes" className={`${CARD} mb-4 text-sm`}>
        <h2 className="mb-2 font-medium">Notes</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block">
            <span>Certification text <span className="text-xs text-ink-500">(prints on the certification)</span></span>
            <textarea value={cert.freeform} rows={4} onFocus={editGuard.onFocusField("freeform")}
                      readOnly={!notesGate.allowed} title={notesGate.title}
                      onChange={(e) => patchDraft({ freeform: e.target.value })}
                      onBlur={(e) => editGuard.onBlurSave(e, (freeform) => void patchNotes({ freeform }))}
                      className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
          </label>
          <label className="block">
            <span>Internal notes <span className="text-xs text-ink-500">(never print)</span></span>
            <textarea value={cert.internalNotes} rows={4} onFocus={editGuard.onFocusField("internalNotes")}
                      readOnly={!notesGate.allowed} title={notesGate.title}
                      onChange={(e) => patchDraft({ internalNotes: e.target.value })}
                      onBlur={(e) => editGuard.onBlurSave(e, (internalNotes) => void patchNotes({ internalNotes }))}
                      className={`${INPUT_COMPACT} mt-1 w-full read-only:bg-surface-50`} />
          </label>
        </div>
      </section>
        ),
        documents: (
      <>
      {/* ---- Documents + History (brief Step 5) ---- */}
      <section id="documents" className={`${CARD} mb-4`}>
        <h2 className="mb-2 font-medium">Documents</h2>
        <CertDocumentsList certId={id} scope={scopeText} viewGate={docsGate} refresh={docsRefresh} />
      </section>

      <div id="history" className="mb-6">
        <HistoryPanel entity="cert" entityId={id} perms={perms} permsError={permsError} />
      </div>
      </>
        ),
      }} />
      </div>

      {/* The card reads the loaded record and the counts above, and holds the print sentence and
          message beside the header's controls. */}
      <AtAGlance rows={[
        { label: "Order", value: <Link href={`/orders/${cert.orderId}`} className={`${LINK} font-mono`}>#{cert.orderNumber}</Link> },
        { label: "Scope", value: scopeText },
        { label: "Results", value: resultsText },
        { label: "Printed", value: cert.printedAt ? formatDateTime(cert.printedAt) : "Not printed" },
        { label: "PO", value: cert.poNumber || "—" },
        { label: "Material", value: cert.material || "—" },
        { label: "Received", value: formatDate(cert.receivedDate) },
      ]}>
        <div className="mt-4 flex flex-col gap-2 text-xs text-ink-500">
          <span>
            {voided
              ? "This certification is voided — stored prints under Documents & history remain reprintable; new prints are refused."
              : "Prints with your signature, and is archived under Documents & history."}
          </span>
          {printError && <span className="text-red-700">{printError}</span>}
        </div>
      </AtAGlance>
      </div>
    </div>
  );
}
