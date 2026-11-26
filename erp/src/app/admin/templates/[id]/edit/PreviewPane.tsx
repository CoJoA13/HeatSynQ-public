"use client";
// The live PREVIEW pane (Phase 7 Task 19, spec §5.5) — beside the editor panels. The user picks a
// REAL record of the template's docType (reusing the house list endpoints, so the picker only offers
// records they can view), and this pane POSTs the WORKING (possibly-unsaved) config to
// /api/templates/[id]/preview, which renders it against that record and streams PDF bytes with ZERO
// side effects. The rendered PDF shows in an <iframe>, so a config edit + re-preview reflects live.
//
// Client component: it reaches the guarded APIs, so it never imports src/server/** — the
// docType→record mapping (`previewRecordSpec`) is pure/client-safe (the TemplateEditor precedent).
//
// The Design tab's live page (PR C of #926, Task 6) is this pane under `autoRun`: it renders the
// config debounced 400 ms, and again when the record or All loads changes, from an effect rather
// than a click, so it shows no Generate preview; each answer hands the editor the canvas's measure
// (`X-Preview-Measure`, read by `parseMeasure`) and a failed render hands it null, so the stage
// draws its boxes as placed. Every run, clicked or automatic, takes a latest-gate ticket before it
// sends, and nothing of a superseded run lands: not its page, its measure, its refusal or its end.
//
// The page shows whole and readable (owner ruling 2026-11-20): the frame takes the template's page
// shape, as tall as the window less a margin and never wider than the pane, and the viewer opens at
// its own whole-page fit with its thumbnails hidden (`pageFrame`, `viewerSrc`,
// `src/lib/preview-frame.ts`). Until the pane is measured the frame keeps the old 600 px box.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DESIGNER_WORDS } from "@/lib/canvas-designer";
import { api, trackedFetch } from "@/lib/fetcher";
import type { CanvasMeasure } from "@/lib/template-canvas";
import { parseMeasure, previewListAccess, previewRecordSpec, withArticle, type PreviewRecordKind } from "@/lib/template-editor";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { makeLatestGate } from "@/lib/use-latest";
import type { TemplateConfig, TemplateDocTypeString } from "@/lib/template-contracts";
import { INPUT_COMPACT } from "@/lib/ui-classes";
import { pageFrame, viewerSrc } from "@/lib/preview-frame";
import { canvasPageFor } from "@/lib/template-contracts/canvas";
import { useMeasuredWidth, useWindowHeight } from "@/lib/use-viewer-size";
import { Combobox } from "@/components/Combobox";

/** A raw list row — the pane reads only the identity fields it labels, so it mirrors no server
 *  type (the client/server boundary). */
type RawRow = Record<string, unknown>;
/** `recordNumber` is an order's, a shipment's or a certification's printed label, an invoice's kind and number, a customer's code, or a quote's number (Design on a canvas names the record by it). */
type Option = { id: string; label: string; recordNumber?: string };

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

/** Turn a list-endpoint's rows into pickable options — the shipment kinds filter by order count
 *  (SHIPPER = single, MOS_SHIPPER = multi; BOL = any), and voided/soft-deleted rows drop out. */
export function optionsFor(kind: PreviewRecordKind, rows: RawRow[]): Option[] {
  // Drop soft-deleted rows (shipments/certs/invoices carry `deletedAt`) AND voided orders (the
  // board row carries `voided`, not `deletedAt`) — a preview against a dead record is confusing;
  // `!undefined` leaves the other kinds untouched.
  const live = rows.filter((r) => !r.deletedAt && !r.voided);
  switch (kind) {
    case "order":
    case "tagOrder":
      // A container tag previews an order's first tag; the pane shows All loads for `order` alone.
      return live.map((r) => ({
        id: str(r.id), label: `#${str(r.orderNumber)} — ${str(r.customerCode)} — ${str(r.leadPartNumber)}`, recordNumber: str(r.orderNumber),
      }));
    case "shipment-single":
    case "shipment-multi":
    case "shipment": {
      const filtered = kind === "shipment-single" ? live.filter((r) => Number(r.orderCount) === 1)
        : kind === "shipment-multi" ? live.filter((r) => Number(r.orderCount) > 1)
        : live;
      return filtered.map((r) => ({
        id: str(r.id),
        label: `Shipment #${str(r.shipperNumber)} — ${str(r.customerCode)} (${str(r.orderCount)} order${Number(r.orderCount) === 1 ? "" : "s"})`,
        recordNumber: str(r.shipperNumber),
      }));
    }
    case "cert":
      // `recordNumber` restates readCertPdfData's `orderLabel` (src/server/certs.ts: the order number,
      // "-<sequence>" after it for a shipment certificate), with the load's number after it for a
      // load certificate, so two of one order's load certificates are named apart;
      // tests/cert-pdf.test.ts holds the two together.
      return live.map((r) => ({
        id: str(r.id), label: `Cert — order #${str(r.orderNumber)} — ${str(r.customerCode)} (${str(r.scope)})`,
        recordNumber: `${str(r.orderNumber)}${r.sequence === null || r.sequence === undefined ? "" : `-${str(r.sequence)}`}`
          + (r.scope === "LOAD" ? `, load ${str(r.loadNumber)}` : ""),
      }));
    case "invoice":
      // `recordNumber` is the paper's own title, lower-cased, before the list row's `documentNumber`
      // (invoiceDocumentNumber, src/lib/invoice-constants.ts: a credit's number, an invoice's order
      // number after the prefix); tests/invoice-pdf.test.ts holds it to readInvoicePdfData.
      return live.map((r) => ({
        id: str(r.id), label: `${r.kind === "CREDIT" ? "Credit" : "Invoice"} ${str(r.documentNumber)} — ${str(r.customerCode)}`,
        recordNumber: `${r.kind === "CREDIT" ? "credit" : "invoice"} ${str(r.documentNumber)}`,
      }));
    case "customer":
      // `recordNumber` is the customer's code, as the statement's Customer line prints it
      // (buildStatement's `customer.code`, src/server/statements.ts); tests/statements.test.ts holds
      // the two together.
      return live.map((r) => ({ id: str(r.id), label: `${str(r.code)} — ${str(r.name)}`, recordNumber: str(r.code) }));
    case "quote":
      // `recordNumber` is the quote's number, as its paper prints it (readQuotePdfData's
      // `quoteNumber`, src/server/quotes.ts); tests/quote-pdf.test.ts holds the two together.
      return live.map((r) => ({
        id: str(r.id), label: `Quote #${str(r.quoteNumber)} — ${str(r.customerCode)} (${str(r.status)})`, recordNumber: str(r.quoteNumber),
      }));
  }
}

export function PreviewPane({
  templateId, docType, config, perms, recordId, onRecordId, allLoads, onAllLoads, asOf, onAsOf, combineFamily, onCombineFamily,
  autoRun = false, onMeasure,
}: {
  templateId: string;
  docType: TemplateDocTypeString;
  config: TemplateConfig;
  /** The editor's own permission read (#678), undefined until it has answered: the pane trusts the
   *  same /me the editor does and sends none of its own. */
  perms: readonly string[] | undefined;
  /** The picked record, the editor's (ruling C2 of PR C, #926): Design on a canvas seeds from it.
   *  `onRecordId` reports the picked option's label and, for an order, a shipment or a certification, its printed label, or an
   *  invoice's kind and number, or a customer's code, or a quote's number, with its id ("" and
   *  "" for none). */
  recordId: string;
  onRecordId: (id: string, label: string, recordNumber: string | undefined) => void;
  /** TRAVELER only: the preview is the order's first load unless this is ticked (ruling R17, #674). */
  allLoads: boolean;
  onAllLoads: (value: boolean) => void;
  /** STATEMENT only: the statement's as-of date ("" for today) and Combine family, the editor's as
   *  All loads is (since statement canvas PR 2), so the Design panel's live page renders the
   *  statement the Preview tab shows. */
  asOf: string;
  onAsOf: (value: string) => void;
  combineFamily: boolean;
  onCombineFamily: (value: boolean) => void;
  /** The Design tab's live page (Task 6): renders itself after each settled change, with no button. */
  autoRun?: boolean;
  /** The live page's measure after each answer, null after a failed render (ruling C1's setter). */
  onMeasure?: (measure: CanvasMeasure | null) => void;
}) {
  const spec = useMemo(() => previewRecordSpec(docType), [docType]);
  const access = previewListAccess(perms, spec.listPermission);

  const [options, setOptions] = useState<Option[] | null>(null);

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The picker read's own line (P6: a read owns its line): a run clears `error`, the run's, on every
  // settled edit under autoRun, so a list failure must not share it.
  const [listError, setListError] = useState<string | null>(null);
  // Keep the current object URL so it can be revoked before the next render / on unmount (the
  // Statements.tsx print precedent — a blob URL leaks until revoked).
  const urlRef = useRef<string | null>(null);
  // One ticket per run (the F7 rule): a run lands only while it is the newest.
  const gate = useRef(makeLatestGate());
  const debouncedConfig = useDebouncedValue(config, 400);
  // The frame's box: the pane's own width and the window's height, read against the template's page.
  const [frameBox, boxWidth] = useMeasuredWidth();
  const windowHeight = useWindowHeight();
  const page = canvasPageFor(docType, config.formats.labelSize);
  const frame = boxWidth === null || windowHeight === null ? null : pageFrame(page, windowHeight, boxWidth);

  // The picker's choices — fetched once the caller is known to hold the list permission (never a
  // silent-empty dropdown: the reason is named below when it's missing — §5.16).
  useEffect(() => {
    if (access !== "allowed") { setOptions(null); return; }
    let live = true;
    api<RawRow[]>(spec.listPath)
      .then((rows) => { if (live) { setOptions(optionsFor(spec.kind, rows)); setListError(null); } })
      .catch((e) => { if (live) setListError((e as Error).message); });
    return () => { live = false; };
  }, [spec, access]);

  // Revoke the outstanding blob URL when the pane unmounts, and retire the run that may still be
  // out, so it reports no measure after the canvas is set aside.
  useEffect(() => {
    const runs = gate.current;
    return () => {
      runs.next();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  const runPreview = useCallback(async (renderConfig: TemplateConfig) => {
    const ticket = gate.current.next();
    if (!recordId) { setRendering(false); return; }
    setRendering(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { recordId, config: renderConfig };
      if (spec.kind === "customer") { // STATEMENT — the only type with preview params
        if (asOf) body.asOf = asOf;
        body.combineFamily = combineFamily;
      }
      if (spec.kind === "order" && allLoads) body.allLoads = true;
      const res = await trackedFetch(`/api/templates/${templateId}/preview`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err: unknown = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? `Preview failed (${res.status})`);
      }
      const blob = await res.blob();
      if (!gate.current.isCurrent(ticket)) return;
      const url = URL.createObjectURL(blob);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      setPreviewUrl(url);
      onMeasure?.(parseMeasure(res.headers.get("X-Preview-Measure")));
    } catch (e) {
      if (!gate.current.isCurrent(ticket)) return;
      setError((e as Error).message);
      onMeasure?.(null);
    } finally {
      if (gate.current.isCurrent(ticket)) setRendering(false);
    }
  }, [recordId, spec.kind, asOf, combineFamily, allLoads, templateId, onMeasure]);

  // The live page: the settled config, the record, All loads, the as-of date and Combine family each
  // run it (`runPreview` changes with the last four); a keystroke waits out the debounce.
  useEffect(() => {
    if (!autoRun) return;
    void runPreview(debouncedConfig);
  }, [autoRun, debouncedConfig, runPreview]);

  // A cleared record leaves no page of another order, and no failure of one, beside the stage
  // (ruling C19): the run above has already retired any run still out, and the editor clears the
  // measure.
  useEffect(() => {
    if (!autoRun || recordId) return;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setPreviewUrl(null);
    setError(null);
  }, [autoRun, recordId]);

  return (
    <section className="rounded border border-line p-3 lg:col-span-2" aria-label="Preview">
      <h2 className="mb-2 text-sm font-semibold text-ink-800">Preview record</h2>
      <p className="mb-2 text-xs text-ink-500">
        Renders the current draft — including unsaved edits — against a real {spec.noun}. Nothing is
        saved, printed, or archived.
      </p>

      {access === "pending" ? (
        <p className="text-xs text-ink-500">Loading…</p>
      ) : access === "denied" ? (
        <p className="rounded bg-surface-50 p-2 text-xs text-ink-500">
          Picking {withArticle(spec.noun)} to preview requires the <code>{spec.listPermission}</code> permission.
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-ink-500">
            <span className="mr-1">Preview against:</span>
            {/* The records in the order their list reads them, newest first (customers by code): an
                order on purpose (#1056 ruling 3). Typing filters on any part of the label. */}
            <Combobox ariaLabel="Preview record" value={recordId}
                      options={[
                        { value: "", label: `— pick ${withArticle(spec.noun)} —` },
                        ...(options ?? []).map((o) => ({ value: o.id, label: o.label })),
                      ]}
                      onSelect={(id) => {
                        const picked = (options ?? []).find((o) => o.id === id);
                        onRecordId(id, picked?.label ?? "", picked?.recordNumber);
                      }}
                      className="inline-block w-96 align-middle" />
          </label>

          {spec.kind === "customer" && (
            <>
              <label className="text-xs text-ink-500">
                <span className="mr-1">As of:</span>
                <input aria-label="Statement as-of date" type="date" value={asOf}
                       onChange={(e) => onAsOf(e.target.value)} className={INPUT_COMPACT} />
              </label>
              <label className="flex items-center gap-1 text-xs text-ink-500">
                <input aria-label="Combine family" type="checkbox" checked={combineFamily}
                       onChange={(e) => onCombineFamily(e.target.checked)} />
                Combine family
              </label>
            </>
          )}

          {spec.kind === "order" && (
            <label className="flex items-center gap-1 text-xs text-ink-500">
              <input aria-label="All loads" type="checkbox" checked={allLoads}
                     onChange={(e) => onAllLoads(e.target.checked)} />
              All loads
            </label>
          )}

          {!autoRun && (
            <button type="button" onClick={() => void runPreview(config)}
                    disabled={!recordId || rendering}
                    className="rounded bg-ink-700 px-3 py-1.5 text-sm text-white">
              {rendering ? "Rendering…" : "Generate preview"}
            </button>
          )}
        </div>
      )}

      {options !== null && options.length === 0 && access === "allowed" && (
        <p className="mt-2 text-xs text-ink-500">No {spec.noun}s to preview against yet.</p>
      )}
      {listError && <p className="mt-2 rounded bg-red-50 p-2 text-xs text-red-700" role="alert">{listError}</p>}
      {error && <p className="mt-2 rounded bg-red-50 p-2 text-xs text-red-700" role="alert">{error}</p>}
      {autoRun && rendering && <p role="status" className="mt-2 text-xs text-ink-500">{DESIGNER_WORDS.rendering}</p>}

      <div ref={frameBox} data-preview-frame="" className="mt-3">
        {previewUrl && (
          <iframe title={autoRun ? DESIGNER_WORDS.livePage : "Template preview"} src={viewerSrc(previewUrl)}
                  className={`block rounded border border-line ${frame === null ? "h-[600px] w-full" : ""}`}
                  style={frame === null ? undefined : { width: frame.width, height: frame.height }} />
        )}
      </div>
    </section>
  );
}
