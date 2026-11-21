import {
  headerFormFrom, headerPatch, lineFormsFrom, linesComparable, linesPayload, UNAVAILABLE_MATERIAL,
  type HeaderForm, type LineForm, type QuoteDetailData,
} from "../app/quotes/quote-form";
import { breakDraftStarted, dropBreakDrafts, priceKeysOf, retainBreakDrafts, type BreakDrafts } from "./break-drafts";
import type { Adapter, EditorBinding, Submission } from "./draft-store";
import { UnreadableAnswerError } from "./fetcher";

export type QuoteDraft = Readonly<{ header: HeaderForm; lines: LineForm[]; breakDrafts: BreakDrafts; seq: number }>;
type NamedOption = { id: string; name: string; active: boolean };
export type QuoteRecoveryCatalogs = Readonly<{
  permissions: readonly string[];
  contacts: readonly NamedOption[];
  users: readonly { id: string; displayName: string; active: boolean }[];
  statements: readonly NamedOption[];
  steps: readonly NamedOption[];
  parts: readonly { id: string; customerId: string; partNumber: string; name: string; active: boolean; materialId?: string | null; materialName?: string | null; eachWeight?: number }[];
  /** The Materials pick list (#541), or null when its read failed (the select greys; the page
   *  still loads). Display data for the select and the preview only: `comparison()` leaves it
   *  out, so a pick-list change elsewhere never sets a dirty draft aside. */
  materials: readonly NamedOption[] | null;
}>;
export type QuoteBaseline = Readonly<{
  id: string; customerId: string; status: QuoteDetailData["status"]; deletedAt: string | null;
  header: HeaderForm; lines: LineForm[];
  positions: readonly { id: string; position: number; linkedOrderCount: number; prices: readonly { id: string; position: number }[] }[];
  catalogs: QuoteRecoveryCatalogs;
}>;
export type QuoteReadRequirements = Readonly<{ quoteId?: string; customerId?: string }>;
export type QuoteBinding = EditorBinding<QuoteDraft, QuoteBaseline, Record<string, unknown>, QuoteDetailData, never, QuoteReadRequirements>;
export function quoteBaselineFrom(detail: QuoteDetailData, catalogs: QuoteRecoveryCatalogs): QuoteBaseline {
  return {
    id: detail.id, customerId: detail.customerId, status: detail.status, deletedAt: detail.deletedAt,
    header: headerFormFrom(detail), lines: lineFormsFrom(detail).map(l => ({ ...l, linkedOrders: l.linkedOrders.map(o => ({ id: o.id, orderNumber: o.orderNumber })) })),
    positions: detail.lines.map(l => ({ id: l.id, position: l.position, linkedOrderCount: l.linkedOrderCount, prices: l.prices.map(p => ({ id: p.id, position: p.position })) })),
    catalogs: { permissions: [...catalogs.permissions], contacts: catalogs.contacts.map(c => ({ id: c.id, name: c.name, active: c.active })),
      users: catalogs.users.map(c => ({ id: c.id, displayName: c.displayName, active: c.active })),
      statements: catalogs.statements.map(c => ({ id: c.id, name: c.name, active: c.active })), steps: catalogs.steps.map(c => ({ id: c.id, name: c.name, active: c.active })),
      parts: catalogs.parts.map(c => ({ id: c.id, customerId: c.customerId, partNumber: c.partNumber, name: c.name, active: c.active,
        ...(typeof c.eachWeight === "number" ? { eachWeight: c.eachWeight } : {}),
        ...(c.materialId === null || typeof c.materialId === "string" ? { materialId: c.materialId } : {}),
        ...(c.materialName === null || typeof c.materialName === "string" ? { materialName: c.materialName } : {}) })),
      materials: catalogs.materials === null ? null : catalogs.materials.map(c => ({ id: c.id, name: c.name, active: c.active })) },
  };
}
export function quoteDraftFrom(baseline: QuoteBaseline): QuoteDraft {
  return { header: baseline.header, lines: baseline.lines, breakDrafts: {}, seq: 0 };
}
export function quoteSaveDirty(data: QuoteDraft, baseline: QuoteBaseline): boolean {
  return Object.keys(headerPatch(data.header, baseline.header)).length > 0 || linesComparable(data.lines) !== linesComparable(baseline.lines);
}
// Retention compares editable raw values, independently of Save's null/whitespace
// normalization. Row identity/order matters; allocator and display metadata do not.
function rawLines(lines: LineForm[]) {
  return lines.map(l => ({
    id: l.id, key: l.key, partId: l.partId,
    partNumberText: l.partId === null ? l.partNumberText : "",
    partNameText: l.partId === null ? l.partNameText : "",
    partDescriptionText: l.partId === null ? l.partDescriptionText : "",
    // `?? null`: defence only (drafts live in memory, schema quote-v2), and `equal` tells undefined from null.
    materialId: l.partId === null ? l.materialId ?? null : null,
    materialText: l.partId === null ? l.materialText : "",
    eachWeight: l.partId === null ? l.eachWeight : "",
    quotedQty: l.quotedQty, quotedUnlimited: l.quotedUnlimited,
    prices: l.prices.map(p => ({
      id: p.id, key: p.key, processStepCodeId: p.processStepCodeId,
      setupCharge: p.setupCharge, unitPrice: p.unitPrice, minimumCharge: p.minimumCharge,
      pricePer: p.pricePer, notes: p.notes,
      breaks: p.breaks.map(b => ({ id: b.id, key: b.key, threshold: b.threshold, price: b.price })),
    })),
  }));
}
function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (!record(a) || !record(b)) return false;
  const keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && equal(a[k], b[k]));
}
function comparison(b: QuoteBaseline) {
  const optionIds = (rows: readonly { id: string; active: boolean }[]) => rows.map(r => ({ id: r.id, active: r.active })).sort((a, b) => a.id.localeCompare(b.id));
  return { id: b.id, customerId: b.customerId, status: b.status, deletedAt: b.deletedAt, header: b.header, positions: b.positions,
    lines: b.lines.map(l => ({ ...l, linkedOrders: l.linkedOrders.map(o => o.id).sort(), prices: l.prices.map(({ stepCode: _code, stepName: _name, ...p }) => { void _code; void _name; return p; }) })),
    catalogs: { permissions: [...b.catalogs.permissions].sort(), contacts: optionIds(b.catalogs.contacts), users: optionIds(b.catalogs.users),
      statements: optionIds(b.catalogs.statements), steps: optionIds(b.catalogs.steps),
      parts: b.catalogs.parts.map(p => ({ id: p.id, customerId: p.customerId, active: p.active })).sort((a, b) => a.id.localeCompare(b.id)) },
  };
}
function record(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }
const strings = (v: Record<string, unknown>, keys: readonly string[]) => keys.every(k => typeof v[k] === "string");
function headerValid(v: unknown): boolean { return record(v) && strings(v, ["contactId", "quoteDate", "effectiveDate", "expiryDate", "followUpDate", "rfqNumber", "quotedById", "endingStatementId", "notes", "internalNotes"]); }
function treeValid(value: unknown): value is LineForm[] {
  if (!Array.isArray(value)) return false;
  const keys = new Set<string>();
  const row = (v: unknown): v is Record<string, unknown> => {
    if (!record(v) || typeof v.key !== "string" || !v.key || keys.has(v.key) || !(v.id === undefined || typeof v.id === "string")) return false;
    keys.add(v.key); return true;
  };
  return value.every(l => row(l) && (l.partId === null || typeof l.partId === "string")
    && (l.materialId === undefined || l.materialId === null || typeof l.materialId === "string")
    && strings(l, ["partNumberText", "partNameText", "partDescriptionText", "materialText", "eachWeight", "quotedQty"])
    && typeof l.quotedUnlimited === "boolean" && Array.isArray(l.linkedOrders)
    && l.linkedOrders.every(o => record(o) && typeof o.id === "string" && typeof o.orderNumber === "number")
    && Array.isArray(l.prices) && l.prices.every(p => row(p)
      && strings(p, ["processStepCodeId", "stepCode", "stepName", "setupCharge", "unitPrice", "minimumCharge", "pricePer", "notes"])
      && Array.isArray(p.breaks) && p.breaks.every(b => row(b) && strings(b, ["threshold", "price"]))));
}
function catalogsValid(v: unknown): boolean {
  if (!record(v) || !Array.isArray(v.permissions) || !v.permissions.every(p => typeof p === "string")) return false;
  if (!(v.materials === null || Array.isArray(v.materials) && v.materials.every((r: unknown) => record(r)
    && typeof r.id === "string" && typeof r.active === "boolean" && typeof r.name === "string"))) return false;
  return ["contacts", "users", "statements", "steps", "parts"].every(key => Array.isArray(v[key]) && v[key].every((r: unknown) => record(r)
    && typeof r.id === "string" && typeof r.active === "boolean" && strings(r, key === "users" ? ["displayName"] : key === "parts" ? ["customerId", "partNumber", "name"] : ["name"])));
}
function baselineValid(v: unknown): v is QuoteBaseline {
  return record(v) && strings(v, ["id", "customerId"]) && (v.status === "OPEN" || v.status === "CLOSED")
    && (v.deletedAt === null || typeof v.deletedAt === "string") && headerValid(v.header) && treeValid(v.lines) && catalogsValid(v.catalogs)
    && Array.isArray(v.positions) && v.positions.every(p => record(p) && typeof p.id === "string" && Number.isFinite(p.position)
      && Number.isFinite(p.linkedOrderCount) && Array.isArray(p.prices) && p.prices.every(q => record(q) && typeof q.id === "string" && Number.isFinite(q.position)));
}
function dataValid(v: unknown): v is QuoteDraft {
  if (!record(v) || !headerValid(v.header) || !treeValid(v.lines) || !record(v.breakDrafts) || !Number.isSafeInteger(v.seq) || Number(v.seq) < 0) return false;
  if (!Object.values(v.breakDrafts).every(b => record(b) && strings(b, ["threshold", "price"]))) return false;
  return v.lines.flatMap(l => [l.key, ...l.prices.flatMap(p => [p.key, ...p.breaks.map(b => b.key)])]).every(k => !/^new-\d+$/.test(k) || Number(k.slice(4)) <= Number(v.seq));
}
function adopt(current: QuoteDraft, baseline: QuoteBaseline): QuoteDraft {
  return { header: baseline.header, lines: baseline.lines, seq: current.seq, breakDrafts: retainBreakDrafts(current.breakDrafts, priceKeysOf(baseline.lines)) };
}
export const quoteRecoveryAdapter: Adapter<QuoteDraft, QuoteBaseline, Record<string, unknown>, QuoteDetailData, never, QuoteReadRequirements> = {
  kind: "quote", schema: "quote-v2", valid: (d, b) => dataValid(d) && baselineValid(b),
  dirty: (data, baseline) => Object.keys(headerPatch(data.header, baseline.header)).length > 0
    || !equal(rawLines(data.lines), rawLines(baseline.lines)) || breakDraftStarted(data.breakDrafts),
  readRequirements: ({ current, submitted, reference }) => {
    const baseline = (current ?? submitted ?? reference)?.baseline;
    return baseline ? { quoteId: baseline.id, customerId: baseline.customerId } : {};
  },
  // A plain read hands back the baseline it compares against, so the two are often one object:
  // `equal` is reflexive, and building both comparisons would sort the whole parts catalog for
  // nothing on every keystroke (#703). A saved-against-fresh pair still compares in full.
  baselineEqual: (saved, fresh) => saved === fresh || equal(comparison(saved), comparison(fresh)),
  cleanAfterDiscard: ({ discarded, clean }) => ({ ...clean, seq: discarded.data.seq }),
  canBeginNativeRead: current => !quoteSaveDirty(current.data, current.baseline),
  reconcileNativeRead: ({ current, fresh }) => current.baseline.id === fresh.id && current.baseline.customerId === fresh.customerId
    ? { data: adopt(current.data, fresh), baseline: fresh } : null,
  reconcileRead: ({ current, fresh }) => ({ data: current.data, baseline: fresh }),
  settle({ current, outcome }) {
    if (outcome.kind !== "persisted") return { kind: "keep", data: current.data, baseline: current.baseline, needsRefresh: outcome.kind === "unknown" };
    const baseline = quoteBaselineFrom(outcome.response, current.baseline.catalogs);
    if (baseline.id !== current.baseline.id || baseline.customerId !== current.baseline.customerId) return { kind: "reference", data: current.data, baseline: current.baseline, needsRefresh: true };
    return { kind: "keep", data: adopt(current.data, baseline), baseline, needsRefresh: true };
  },
  preview(data, baseline) {
    const fields: { label: string; value: string }[] = [];
    const names = baseline.catalogs;
    const name = (id: string, options: readonly { id: string; name: string }[]) => !id ? "" : options.find(o => o.id === id)?.name ?? UNAVAILABLE_MATERIAL;
    const label: Record<keyof HeaderForm, string> = { contactId: "Contact", quoteDate: "Quote date", effectiveDate: "Effective date", expiryDate: "Expiry date", followUpDate: "Follow-up date",
      rfqNumber: "RFQ number", quotedById: "Quoted by", endingStatementId: "Ending statement", notes: "Notes", internalNotes: "Internal notes" };
    for (const key of Object.keys(label) as (keyof HeaderForm)[]) {
      const raw = data.header[key]; const value = key === "contactId" ? name(raw, names.contacts) : key === "endingStatementId" ? name(raw, names.statements)
        : key === "quotedById" ? name(raw, names.users.map(u => ({ id: u.id, name: u.displayName }))) : raw;
      fields.push({ label: label[key], value });
    }
    data.lines.forEach((l, i) => {
      const prefix = `Line ${i + 1}`;
      fields.push({ label: `${prefix} part`, value: l.partId ? name(l.partId, names.parts.map(p => ({ id: p.id, name: `${p.partNumber} — ${p.name}` }))) : l.partNumberText });
      for (const [key, title] of [["partNameText", "name"], ["partDescriptionText", "description"]] as const)
        fields.push({ label: `${prefix} ${title}`, value: l[key] });
      fields.push({ label: `${prefix} material`, value: l.materialId ? name(l.materialId, names.materials ?? []) : l.materialText });
      for (const [key, title] of [["eachWeight", "each weight"], ["quotedQty", "quoted quantity"]] as const)
        fields.push({ label: `${prefix} ${title}`, value: l[key] });
      fields.push({ label: `${prefix} unlimited quantity`, value: l.quotedUnlimited ? "Yes" : "No" });
      l.prices.forEach((p, j) => {
        const pp = `${prefix}, operation ${j + 1}`;
        fields.push({ label: pp, value: name(p.processStepCodeId, names.steps) });
        for (const [key, title] of [["setupCharge", "setup charge"], ["unitPrice", "unit price"], ["minimumCharge", "minimum charge"], ["pricePer", "price per"], ["notes", "notes"]] as const) fields.push({ label: `${pp} ${title}`, value: p[key] });
        p.breaks.forEach((b, n) => { fields.push({ label: `${pp}, break ${n + 1} threshold`, value: b.threshold }, { label: `${pp}, break ${n + 1} price`, value: b.price }); });
        const unadded = data.breakDrafts[p.key]; if (unadded) fields.push({ label: `Unadded ${pp} threshold`, value: unadded.threshold }, { label: `Unadded ${pp} price`, value: unadded.price });
      });
    });
    return fields;
  },
};
export type PreparedQuoteSave = { kind: "invalid"; error: string } | { kind: "empty" } | { kind: "ready"; submission: Submission<QuoteDraft, QuoteBaseline, Record<string, unknown>> };
export function prepareQuoteSave(binding: QuoteBinding, requestId: string): PreparedQuoteSave {
  const view = binding.getSnapshot(); if (view.mode !== "editing" || !view.current) return { kind: "empty" };
  const { data, baseline } = view.current;
  for (const [key, label] of [["quoteDate", "Quote date"], ["effectiveDate", "Effective date"], ["expiryDate", "Expiry date"]] as const)
    if (data.header[key] === "") return { kind: "invalid", error: `${label} is required.` };
  const payload = headerPatch(data.header, baseline.header);
  if (linesComparable(data.lines) !== linesComparable(baseline.lines)) {
    const result = linesPayload(data.lines); if (!result.ok) return { kind: "invalid", error: result.errors.join("\n") }; payload.lines = result.lines;
  }
  return Object.keys(payload).length ? { kind: "ready", submission: binding.capture(payload, requestId) } : { kind: "empty" };
}
export function addQuoteLine(data: QuoteDraft): QuoteDraft {
  const seq = data.seq + 1; return { ...data, seq, lines: [...data.lines, { key: `new-${seq}`, partId: null, partNumberText: "", partNameText: "", partDescriptionText: "", materialId: null, materialText: "",
    eachWeight: "", quotedQty: "", quotedUnlimited: false, prices: [], linkedOrders: [] }] };
}
export function addQuotePrice(data: QuoteDraft, lineKey: string, stepId: string, stepLabel: string): QuoteDraft {
  if (!data.lines.some(l => l.key === lineKey)) return data;
  const seq = data.seq + 1; return { ...data, seq, lines: data.lines.map(l => l.key !== lineKey ? l : { ...l, prices: [...l.prices, {
    key: `new-${seq}`, processStepCodeId: stepId, stepCode: stepLabel, stepName: "", setupCharge: "", unitPrice: "", minimumCharge: "", pricePer: "EACH", notes: "", breaks: [],
  }] }) };
}
export function addQuoteBreak(data: QuoteDraft, lineKey: string, priceKey: string): QuoteDraft {
  const draft = data.breakDrafts[priceKey]; if (!draft?.threshold || !draft.price || !data.lines.some(l => l.key === lineKey && l.prices.some(p => p.key === priceKey))) return data;
  const seq = data.seq + 1; return { ...data, seq, breakDrafts: dropBreakDrafts(data.breakDrafts, [priceKey]), lines: data.lines.map(l => l.key !== lineKey ? l : { ...l,
    prices: l.prices.map(p => p.key !== priceKey ? p : { ...p, breaks: [...p.breaks, { key: `new-${seq}`, threshold: draft.threshold, price: draft.price }] }) }) };
}
export function removeQuoteLine(data: QuoteDraft, lineKey: string): QuoteDraft {
  const line = data.lines.find(l => l.key === lineKey); if (!line) return data;
  return { ...data, lines: data.lines.filter(l => l.key !== lineKey), breakDrafts: dropBreakDrafts(data.breakDrafts, priceKeysOf([line])) };
}
export function removeQuotePrice(data: QuoteDraft, lineKey: string, priceKey: string): QuoteDraft {
  if (!data.lines.some(l => l.key === lineKey && l.prices.some(p => p.key === priceKey))) return data;
  return { ...data, lines: data.lines.map(l => l.key !== lineKey ? l : { ...l, prices: l.prices.filter(p => p.key !== priceKey) }), breakDrafts: dropBreakDrafts(data.breakDrafts, [priceKey]) };
}

/** The production Save callback's transport seam. Only write rejection is a
 * failed submission; history, refresh and presentation run after acknowledgement. */
export async function runQuoteSave<R extends QuoteDetailData>(args: {
  binding: QuoteBinding; requestId: string; write: (payload: Record<string, unknown>) => Promise<R>;
  rejected: (error: unknown) => boolean; persisted: (response: R) => void | Promise<void>;
}) {
  const prepared = prepareQuoteSave(args.binding, args.requestId);
  if (prepared.kind !== "ready") return prepared;
  if (!args.binding.dispatched(prepared.submission)) return { kind: "empty" } as const;
  let response: R;
  try { response = await args.write(prepared.submission.payload); }
  catch (error) {
    args.binding.settle(prepared.submission, { kind: args.rejected(error) ? "rejected" : "unknown" });
    return { kind: "failed", error } as const;
  }
  args.binding.settle(prepared.submission, { kind: "persisted", response });
  await args.persisted(response);
  return { kind: "persisted" } as const;
}
/** Native action acceptance uses the core's captured native ticket, never a
 * fabricated ordinary read after the response. Catalogs are fresh for each action. */
export async function runQuoteNative<R>(args: {
  binding: QuoteBinding; write: () => Promise<R>; detail: (response: R) => QuoteDetailData;
  catalogs: () => Promise<QuoteRecoveryCatalogs>; authorized: () => boolean;
  acknowledged: () => void; accepted: (response: R, baseline: QuoteBaseline) => void;
  rollback?: () => Promise<QuoteDetailData>; rolledBack?: (detail: QuoteDetailData, baseline: QuoteBaseline) => void;
}) {
  const expectedId = args.binding.getSnapshot().savedBaseline?.id;
  const readId = args.binding.beginNativeRead();
  if (readId === null || !args.authorized()) return { kind: "refused" } as const;
  const catalogs = args.catalogs().then(value => ({ value }), error => ({ error }));
  let response: R;
  try { response = await args.write(); }
  catch (error) {
    if (!args.rollback || !args.authorized()) return { kind: "failed", error } as const;
    let detail: QuoteDetailData;
    try { detail = await args.rollback(); }
    catch (reloadError) {
      return { kind: "failed", error: new Error(`${(error as Error).message} — and the page could not be refreshed (${(reloadError as Error).message}). Reload to see the current state.`) } as const;
    }
    const result = await catalogs;
    if (!args.authorized()) return { kind: "stale" } as const;
    if ("error" in result) {
      args.binding.acceptRead({ kind: "unavailable", readId }, {} as QuoteDraft);
      return { kind: "failed", error: new Error(`${(error as Error).message} — and the page could not be refreshed (${(result.error as Error).message}). Reload to see the current state.`) } as const;
    }
    if (!result.value.permissions.includes("quotes.view")) {
      args.binding.acceptRead({ kind: "unavailable", readId }, {} as QuoteDraft);
      return { kind: "failed", error: new Error("Requires quotes.view") } as const;
    }
    if (detail.id !== expectedId) return { kind: "failed", error: new Error("The quote response did not match this editor.") } as const;
    const baseline = quoteBaselineFrom(detail, result.value);
    const editable = result.value.permissions.includes("quotes.edit") && detail.status === "OPEN" && detail.deletedAt === null;
    // The rollback consumes the ORIGINAL ticket, not a new read minted after failure.
    if (!args.binding.acceptRead({ kind: "authorized", readId, baseline, editable }, quoteDraftFrom(baseline))) return { kind: "stale" } as const;
    args.rolledBack?.(detail, baseline);
    return { kind: "failed", error, readId } as const;
  }
  let acknowledgementError: unknown;
  let acknowledgementFailed = false;
  try { args.acknowledged(); }
  catch (error) { acknowledgementFailed = true; acknowledgementError = error; }
  const completionWarning = (refreshError?: unknown) => new Error(
    `Quote action completed, but history could not be refreshed: ${acknowledgementError instanceof Error ? acknowledgementError.message : String(acknowledgementError)}` +
    (refreshError === undefined ? "" : ` — and the saved record could not be refreshed: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`),
  );
  const result = await catalogs;
  if (!args.authorized()) return { kind: "stale" } as const;
  if ("error" in result) {
    const closed = args.binding.acceptRead({ kind: "unavailable", readId }, {} as QuoteDraft);
    if (!closed) return { kind: "stale" } as const;
    throw acknowledgementFailed ? completionWarning(result.error) : result.error;
  }
  if (!result.value.permissions.includes("quotes.view")) {
    const closed = args.binding.acceptRead({ kind: "unavailable", readId }, {} as QuoteDraft);
    if (!closed) return { kind: "stale" } as const;
    const error = new Error("Requires quotes.view");
    return { kind: "failed", error: acknowledgementFailed ? completionWarning(error) : error } as const;
  }
  const detail = args.detail(response);
  if (detail.id !== expectedId) throw new Error("The quote response did not match this editor.");
  const baseline = quoteBaselineFrom(detail, result.value);
  const editable = result.value.permissions.includes("quotes.edit") && detail.status === "OPEN" && detail.deletedAt === null;
  const accepted = args.binding.acceptRead({ kind: "authorized", readId, baseline, editable }, quoteDraftFrom(baseline));
  if (accepted) args.accepted(response, baseline);
  return { kind: accepted ? "accepted" : "stale", readId,
    ...(accepted && acknowledgementFailed ? { warning: completionWarning() } : {}),
  } as const;
}

export async function runQuoteDelete(args: {
  retire: (() => boolean) | null; remove: () => Promise<unknown>; deleted: () => void;
}) {
  try { await args.remove(); }
  catch (error) {
    // #547 (owner ruling 2026-10-18): a 2xx proves the delete committed, and its answer holds only
    // `{ ok: true }`, so an answer that could not be read goes on to the retirement and `deleted`
    // below. Every other failure reaches the caller.
    if (!(error instanceof UnreadableAnswerError)) throw error;
  }
  args.retire?.();
  args.deleted();
}
