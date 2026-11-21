import type { DraftSession } from "./draft-session";
import type { Adapter, Draft, EditorBinding, EditorKey, Outcome, Stamp, Submission } from "./draft-store";
import { contractFor, type TemplateConfig, type TemplateDocTypeString } from "./template-contracts";
import { canvasLayoutSchema } from "./template-contracts/canvas";
import { LABEL_SIZES } from "./template-contracts/types";
import { canvasSaveBlock, resolveSaveError, resolveSaveSettle, STALE_DRAFT_MESSAGE, widthBudgetError } from "./template-editor";

export type DocumentTemplateDetail = Readonly<{ id: string; docType: TemplateDocTypeString; name: string;
  draft: Readonly<{ versionNumber: number; config: TemplateConfig; updatedAt: string; logoMimeType: string | null }> | null }>;
export type DocumentTemplateBaseline = Readonly<{ templateId: string; docType: TemplateDocTypeString; versionNumber: number;
  config: TemplateConfig; updatedAt: string; permissions: readonly string[] }> &
  ({ source: "open"; status: "DRAFT"; logoMimeType: string | null } |
   { source: "historical"; status: "DRAFT" | "PUBLISHED" | "DISCARDED"; hasLogo: boolean });
export type DocumentTemplateDraft = Readonly<{ config: TemplateConfig; dirty: boolean; updatedAt: string; logoMimeType: string | null;
  epoch: number; stashed: TemplateConfig | null; conflict: string | null }>;
export type DocumentTemplatePayload = Readonly<{ config: TemplateConfig; updatedAt: string; epoch: number }>;
export type DocumentTemplateResponse =
  | { kind: "saved"; updatedAt: string }
  | { kind: "conflict"; rollback: { kind: "authorized"; baseline: DocumentTemplateBaseline } | { kind: "failed" } };
export type DocumentTemplateOutcome = Outcome<DocumentTemplateResponse>;
export type DocumentTemplateSubmission = Submission<DocumentTemplateDraft, DocumentTemplateBaseline, DocumentTemplatePayload>;
export type DocumentTemplateReadRequirements = { templateId?: string; versionNumber?: number };
export type DocumentTemplateBinding = EditorBinding<DocumentTemplateDraft, DocumentTemplateBaseline, DocumentTemplatePayload, DocumentTemplateResponse, never, DocumentTemplateReadRequirements>;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const textOrNull = (value: unknown) => value === null || typeof value === "string";
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
function validConfig(value: unknown): value is TemplateConfig {
  if (!record(value) || !Array.isArray(value.sections) || !record(value.formats) || !record(value.fonts) || !record(value.textBlocks)
    || typeof value.pageFooter !== "boolean") return false;
  const fonts = value.fonts;
  return typeof fonts.family === "string" && finite(fonts.baseSize) && finite(fonts.headingSize) && finite(fonts.smallSize)
    && Object.values(value.textBlocks).every(v => typeof v === "string")
    && Object.entries(value.formats).every(([key, v]) => ["negativeStyle", "dateFormat"].includes(key) ? typeof v === "string" : key === "priceDecimals" ? finite(v) : key === "labelSize" ? (LABEL_SIZES as readonly unknown[]).includes(v) : key === "thousandsSeparator" && typeof v === "boolean")
    // A retained layout is read through the schema the server parses it with (ruling C34): a copy
    // whose item the designer cannot draw (no anchor, say) is refused here, before `DesignPanel`
    // would throw on it, so recovery refuses what the server would refuse.
    && (value.layout === undefined || value.layout === null || canvasLayoutSchema.safeParse(value.layout).success)
    && (value.logo === null || (record(value.logo) && typeof value.logo.placement === "string" && finite(value.logo.width)))
    && value.sections.every(s => record(s) && typeof s.key === "string" && typeof s.visible === "boolean" && Array.isArray(s.fields)
      && s.fields.every(f => record(f) && typeof f.key === "string" && typeof f.visible === "boolean" && textOrNull(f.label) && (f.width === null || finite(f.width))));
}
function copyConfig(config: TemplateConfig): TemplateConfig {
  return { sections: config.sections.map(s => ({ key: s.key, visible: s.visible, fields: s.fields.map(f => ({ key: f.key, visible: f.visible, label: f.label, width: f.width })) })),
    formats: { ...config.formats }, fonts: { family: config.fonts.family, baseSize: config.fonts.baseSize, headingSize: config.fonts.headingSize, smallSize: config.fonts.smallSize },
    textBlocks: { ...config.textBlocks }, logo: config.logo === null ? null : { placement: config.logo.placement, width: config.logo.width }, pageFooter: config.pageFooter,
    layout: config.layout === null || config.layout === undefined ? null : structuredClone(config.layout) };
}
function validBaseline(value: unknown): value is DocumentTemplateBaseline {
  if (!record(value) || typeof value.templateId !== "string" || typeof value.docType !== "string" || !Number.isSafeInteger(value.versionNumber)
    || Number(value.versionNumber) < 1 || typeof value.updatedAt !== "string" || !validConfig(value.config)
    || !Array.isArray(value.permissions) || !value.permissions.every(p => typeof p === "string")) return false;
  try { if (!contractFor(value.docType as TemplateDocTypeString)) return false; } catch { return false; }
  return value.source === "open" ? value.status === "DRAFT" && textOrNull(value.logoMimeType)
    : value.source === "historical" && ["DRAFT", "PUBLISHED", "DISCARDED"].includes(String(value.status)) && typeof value.hasLogo === "boolean";
}
function validData(value: unknown): value is DocumentTemplateDraft {
  return record(value) && validConfig(value.config) && typeof value.dirty === "boolean" && typeof value.updatedAt === "string" && textOrNull(value.logoMimeType)
    && Number.isSafeInteger(value.epoch) && Number(value.epoch) >= 0 && textOrNull(value.conflict) && (value.stashed === null || validConfig(value.stashed));
}
function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (!record(a) || !record(b)) return false;
  const keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && equal(a[k], b[k]));
}
export function documentTemplateBaselineFrom(detail: DocumentTemplateDetail, permissions: readonly string[]): DocumentTemplateBaseline | null {
  if (!detail?.draft || !validConfig(detail.draft.config)) return null;
  const baseline: DocumentTemplateBaseline = { source: "open", status: "DRAFT", templateId: detail.id, docType: detail.docType,
    versionNumber: detail.draft.versionNumber, config: copyConfig(detail.draft.config), updatedAt: detail.draft.updatedAt,
    logoMimeType: detail.draft.logoMimeType, permissions: [...permissions] };
  return validBaseline(baseline) ? baseline : null;
}
export function documentTemplateDraftFrom(baseline: DocumentTemplateBaseline): DocumentTemplateDraft {
  if (baseline.source !== "open") throw new Error("A historical version cannot seed an editable draft.");
  return { config: copyConfig(baseline.config), dirty: false, updatedAt: baseline.updatedAt, logoMimeType: baseline.logoMimeType, epoch: 0, stashed: null, conflict: null };
}
export function applyDocumentTemplate(data: DocumentTemplateDraft, change: (config: TemplateConfig) => TemplateConfig): DocumentTemplateDraft {
  return { ...data, config: change(data.config), dirty: true, epoch: data.epoch + 1, stashed: null, conflict: null };
}
export function reapplyDocumentTemplate(data: DocumentTemplateDraft): DocumentTemplateDraft {
  return data.stashed === null ? data : { ...data, config: data.stashed, dirty: true, stashed: null, conflict: null };
}
export function prepareDocumentTemplate(binding: DocumentTemplateBinding, requestId: string): DocumentTemplateSubmission | null {
  const view = binding.getSnapshot(); const current = view.current;
  if (view.mode !== "editing" || !current || current.baseline.source !== "open" || !validData(current.data)
    || widthBudgetError(contractFor(current.baseline.docType), current.data.config)
    || canvasSaveBlock(contractFor(current.baseline.docType), current.data.config)) return null;
  binding.change(data => ({ ...data, epoch: data.epoch + 1 }));
  const data = binding.getSnapshot().current?.data;
  return data ? binding.capture({ config: copyConfig(data.config), updatedAt: data.updatedAt, epoch: data.epoch }, requestId) : null;
}
export function settleDocumentTemplate({ current, submission, outcome }: { current: Draft<DocumentTemplateDraft, DocumentTemplateBaseline>;
  submission: DocumentTemplateSubmission; outcome: DocumentTemplateOutcome }) {
  const prior = current.data;
  const applyOutcome = resolveSaveSettle(prior.epoch !== submission.payload.epoch).applyOutcome;
  let data = prior; let baseline = current.baseline;
  if (outcome.kind === "persisted" && outcome.response.kind === "saved") {
    baseline = { ...baseline, config: copyConfig(submission.payload.config), updatedAt: outcome.response.updatedAt };
    data = { ...prior, updatedAt: outcome.response.updatedAt, dirty: applyOutcome ? false : prior.dirty, stashed: null, conflict: null };
  } else if (outcome.kind === "rejected" && outcome.response?.kind === "conflict") {
    const rollback = outcome.response.rollback;
    if (rollback.kind === "authorized" && rollback.baseline.source === "open" && validBaseline(rollback.baseline)
      && rollback.baseline.templateId === baseline.templateId && rollback.baseline.versionNumber === baseline.versionNumber) {
      baseline = rollback.baseline;
      data = { ...prior, updatedAt: baseline.updatedAt, logoMimeType: rollback.baseline.logoMimeType,
        config: applyOutcome ? copyConfig(baseline.config) : prior.config, dirty: applyOutcome ? false : prior.dirty,
        stashed: applyOutcome ? copyConfig(submission.payload.config) : null, conflict: applyOutcome ? STALE_DRAFT_MESSAGE : null };
    } else data = { ...prior, stashed: null, conflict: null };
  }
  return { kind: "keep" as const, data, baseline, needsRefresh: false };
}
export const documentTemplateRecoveryAdapter: Adapter<DocumentTemplateDraft, DocumentTemplateBaseline, DocumentTemplatePayload, DocumentTemplateResponse, never, DocumentTemplateReadRequirements> = {
  kind: "document-template", schema: "document-template-v1", allowRejectedFollowUp: true, allowEditRead: true,
  valid: (data, baseline) => validData(data) && validBaseline(baseline), dirty: data => data.dirty || data.stashed !== null,
  baselineEqual: (a, b) => equal({ ...a, permissions: [...a.permissions].sort() }, { ...b, permissions: [...b.permissions].sort() }),
  readRequirements: ({ current, reference, submitted }) => {
    const baseline = (current ?? reference ?? submitted)?.baseline;
    return baseline ? { templateId: baseline.templateId, versionNumber: baseline.versionNumber } : {};
  },
  reconcileRead: ({ current }) => ({ data: current.data, baseline: current.baseline }), settle: settleDocumentTemplate,
  cleanAfterDiscard: ({ clean, baseline }) => {
    if (baseline.source !== "open") throw new Error("Discard cannot seed a historical draft.");
    // An edit read advances the baseline but not the store's clean copy (#455), and the
    // next save sends the draft's updatedAt: take it and the logo type from the baseline.
    return { ...clean, updatedAt: baseline.updatedAt, logoMimeType: baseline.logoMimeType };
  },
  preview: (data, baseline) => {
    const contract = contractFor(baseline.docType);
    const describe = (config: TemplateConfig, prefix = "") => {
      const field = (label: string, value: string) => ({ label: `${prefix}${label}`, value });
      const fields = config.sections.flatMap(section => {
        const definition = contract.sections.find(s => s.key === section.key);
        return [field(`${definition?.name ?? "Section"} visibility`, section.visible ? "Shown" : "Hidden"), ...section.fields.flatMap(item => {
          const name = definition?.fields.find(f => f.key === item.key)?.name ?? "Field";
          return [field(`${name} label`, item.label ?? "Default"), field(`${name} visibility`, item.visible ? "Shown" : "Hidden"), field(`${name} width`, item.width === null ? "Default" : String(item.width))];
        })];
      });
      const formats = config.formats;
      const negative = { SIGN_AFTER_SYMBOL: "Sign after symbol", LEADING_MINUS: "Leading minus", PARENTHESES: "Parentheses" };
      return [...fields,
        ...Object.entries(config.textBlocks).map(([key, value]) => field(contract.textBlocks.find(block => block.key === key)?.name ?? "Text block", value)),
        field("Font family", config.fonts.family), field("Body (pt)", String(config.fonts.baseSize)),
        field("Heading (pt)", String(config.fonts.headingSize)), field("Small text (pt)", String(config.fonts.smallSize)),
        ...(formats.negativeStyle === undefined ? [] : [field("Negative style", negative[formats.negativeStyle] ?? formats.negativeStyle)]),
        ...(formats.priceDecimals === undefined ? [] : [field("Price decimals", String(formats.priceDecimals))]),
        ...(formats.thousandsSeparator === undefined ? [] : [field("Group thousands", formats.thousandsSeparator ? "Yes" : "No")]),
        ...(formats.dateFormat === undefined ? [] : [field("Date format", formats.dateFormat)]),
        field("Logo placement", config.logo ? config.logo.placement.replaceAll("-", " ") : "None"),
        ...(config.logo ? [field("Logo width", String(config.logo.width))] : []), field("Page footer", config.pageFooter ? "Shown" : "Hidden"),
        field("Layout", config.layout ? `Canvas (${config.layout.items.length} items)` : "Sections")];
    };
    return [...describe(data.config), ...(data.stashed ? describe(data.stashed, "Set-aside — ") : [])];
  },
};
/** A logo change's metadata read, projected onto this tab's copy: the server's updatedAt and logo
 *  type, never its config. `null` when the read is of another template or version. `"changed"`
 *  when the server's config is no longer the one this tab's baseline holds (#460, owner ruling
 *  2026-11-02): another admin saved it, and adopting their updatedAt over this tab's older config
 *  would let the next save pass the server's updatedAt check and overwrite their change. Nothing is
 *  adopted then, so that save meets the existing 409 and Re-apply my changes. */
export function documentTemplateMetadata(data: DocumentTemplateDraft, baseline: DocumentTemplateBaseline, fresh: DocumentTemplateBaseline): { data: DocumentTemplateDraft; baseline: DocumentTemplateBaseline } | "changed" | null {
  if (baseline.source !== "open" || fresh.source !== "open" || baseline.templateId !== fresh.templateId || baseline.versionNumber !== fresh.versionNumber) return null;
  if (!equal(baseline.config, fresh.config)) return "changed";
  return { data: { ...data, updatedAt: fresh.updatedAt, logoMimeType: fresh.logoMimeType },
    baseline: { ...baseline, updatedAt: fresh.updatedAt, logoMimeType: fresh.logoMimeType, permissions: [...fresh.permissions] } };
}
export function noteDocumentTemplateRejection(binding: DocumentTemplateBinding, submission: DocumentTemplateSubmission): boolean { return binding.noteRejectedSubmission(submission); }
function sameKey(a: EditorKey, b: EditorKey) { return a.owner.userId === b.owner.userId && a.owner.authGeneration === b.owner.authGeneration
  && a.record.kind === b.record.kind && a.record.id === b.record.id && a.editor === b.editor && a.entityVersion === b.entityVersion && a.childId === b.childId; }
function permitted(session: DraftSession, me: { id: string; permissions: string[] }) {
  return me.id === session.store.getSnapshot().owner?.userId && me.permissions.includes("templates.view");
}
export async function readDocumentTemplate(args: {
  binding: DocumentTemplateBinding; session: DraftSession; templateId: string; versionNumber: number;
  readDetail: () => Promise<DocumentTemplateDetail>; readIdentity: () => Promise<{ id: string; permissions: string[] }>;
  accepted: (readId: number) => void;
}): Promise<boolean> {
  const { binding, session } = args; const ticket = session.readAuthorizationTicket(); if (!ticket) return false;
  let readId = binding.beginRead();
  for (let attempt = 0; attempt < 2; attempt++) {
    const requirements = binding.readRequirements(readId); if (!requirements || !session.isReadAuthorized(ticket)) return false;
    let baseline: DocumentTemplateBaseline | null = null;
    try {
      if ((requirements.templateId && requirements.templateId !== args.templateId) || (requirements.versionNumber && requirements.versionNumber !== args.versionNumber)) throw new Error("Version mismatch.");
      // Sent together (#676); both are fresh (after beginRead) and checked after both land.
      const [detail, me] = await Promise.all([args.readDetail(), args.readIdentity()]);
      if (!session.isReadAuthorized(ticket)) return false;
      if (detail.id !== args.templateId || !permitted(session, me)) throw new Error("Access unavailable.");
      baseline = documentTemplateBaselineFrom(detail, me.permissions);
      if (!baseline || baseline.versionNumber !== args.versionNumber) throw new Error("Draft version changed.");
    } catch {
      baseline = null;
      if (!session.isReadAuthorized(ticket)) return false;
      if (binding.acceptRead({ kind: "unavailable", readId }, {} as never)) return false;
    }
    if (baseline && binding.acceptRead({ kind: "authorized", readId, baseline, editable: baseline.permissions.includes("templates.edit") }, documentTemplateDraftFrom(baseline))) {
      args.accepted(readId); return true;
    }
    if (attempt || !session.isReadAuthorized(ticket)) return false;
    const next = binding.restartReadAfterChange(readId); if (next === null) return false; readId = next;
  }
  return false;
}
export type DocumentTemplateSaveArgs = {
  binding: DocumentTemplateBinding; session: DraftSession; submission: DocumentTemplateSubmission; isLive: () => boolean;
  patch: () => Promise<{ updatedAt: string }>;
  readDetail: () => Promise<DocumentTemplateDetail>; readIdentity: () => Promise<{ id: string; permissions: string[] }>;
  onSaved: () => void; onConflict: () => void; onError: (error: unknown) => void;
};
export async function runDocumentTemplateSave(args: DocumentTemplateSaveArgs): Promise<void> {
  const { binding, session, submission } = args; const ticket = session.readAuthorizationTicket();
  if (!ticket || !binding.dispatched(submission)) return;
  let acknowledgement: { updatedAt: string } | undefined; let failure: unknown;
  try { acknowledgement = await args.patch(); } catch (error) { failure = error; }
  const publish = () => args.isLive() && session.isReadAuthorized(ticket)
    && binding.getSnapshot().current?.stamp.generation === submission.stamp.generation;
  if (acknowledgement) {
    binding.settle(submission, { kind: "persisted", response: { kind: "saved", updatedAt: acknowledgement.updatedAt } });
    if (publish()) args.onSaved(); return;
  }
  const status = record(failure) && typeof failure.status === "number" ? failure.status : null;
  const resolution = resolveSaveError(status, failure instanceof Error ? failure.message : String(failure));
  if (resolution.action !== "reload-then-conflict") {
    binding.settle(submission, status !== null && status >= 400 && status < 500 ? { kind: "rejected" } : { kind: "unknown" });
    if (publish()) args.onError(failure); return;
  }
  if (!binding.noteRejectedSubmission(submission)) return;
  let rollback: DocumentTemplateBaseline | null = null; let rollbackError: unknown = failure;
  try {
    const [detail, me] = await Promise.all([args.readDetail(), args.readIdentity()]); // together (#676)
    if (!session.isReadAuthorized(ticket)) throw new Error("Template authorization changed.");
    if (!permitted(session, me)) throw new Error("Access unavailable.");
    rollback = documentTemplateBaselineFrom(detail, me.permissions);
    if (!rollback || rollback.templateId !== submission.stamp.key.record.id || String(rollback.versionNumber) !== submission.stamp.key.entityVersion) throw new Error("Draft version changed.");
  } catch (error) { rollback = null; rollbackError = error; }
  binding.settle(submission, { kind: "rejected", response: { kind: "conflict", rollback: rollback ? { kind: "authorized", baseline: rollback } : { kind: "failed" } } });
  if (publish()) {
    if (!rollback) args.onError(rollbackError);
    else if (binding.getSnapshot().current?.data.epoch === submission.payload.epoch) args.onConflict();
  }
}
export type DocumentTemplateVersion = { versionNumber: number; status: "DRAFT" | "PUBLISHED" | "DISCARDED";
  config: TemplateConfig; updatedAt: string; hasLogo: boolean };
export async function readRetainedDocumentTemplate(args: {
  binding: DocumentTemplateBinding; session: DraftSession; templateId: string; versionNumber: number;
  readDetail: () => Promise<DocumentTemplateDetail & { versions: Array<{ versionNumber: number; status: DocumentTemplateVersion["status"] }> }>;
  readVersion: () => Promise<DocumentTemplateVersion>; readIdentity: () => Promise<{ id: string; permissions: string[] }>;
}): Promise<boolean> {
  const { binding, session } = args; const ticket = session.readAuthorizationTicket(); if (!ticket) return false;
  const row = session.store.getSnapshot().rows.find(r => r.key.record.kind === "document-template" && r.key.record.id === args.templateId && r.key.editor === documentTemplateRecoveryAdapter.kind && r.key.entityVersion === String(args.versionNumber));
  if (!row) return false;
  let generations = row.stamps.map(stamp => stamp.generation);
  const listed = () => session.store.getSnapshot().rows.find(r => sameKey(r.key, row.key));
  const stillRetained = () => { const now = listed(); return !!now && now.stamps.length === generations.length && now.stamps.every(stamp => generations.includes(stamp.generation)); };
  // #463 (owner ruling 2026-11-02): a row holds two copies after a conflict, Start fresh and
  // typing, and its version can then be published. When one of them is discarded from the Shell's
  // drafts panel during this read, the read goes on while every copy left is one it began with.
  // The store refuses its answer as changed (the discard moved the store's revision), and the read
  // then takes the row's copies again and restarts once, as after any refused read. A row whose
  // last copy is gone, or that holds a newer generation, ends the read as before.
  const kept = () => { const now = listed(); return !!now && now.stamps.every(stamp => generations.includes(stamp.generation)); };
  let readId = binding.beginRead();
  let attempt = 0;
  const restart = (): boolean => {
    if (attempt || !session.isReadAuthorized(ticket) || !kept()) return false;
    const next = binding.restartReadAfterChange(readId); if (next === null) return false;
    generations = listed()!.stamps.map(stamp => stamp.generation); readId = next; attempt++; return true;
  };
  while (attempt < 2) {
    const requirements = binding.readRequirements(readId);
    if (!requirements || (requirements.templateId && requirements.templateId !== args.templateId)
      || (requirements.versionNumber && requirements.versionNumber !== args.versionNumber) || !session.isReadAuthorized(ticket) || !stillRetained()) return false;
    let baseline: DocumentTemplateBaseline | null = null;
    try {
      const detail = await args.readDetail(); const version = await args.readVersion();
      if (!session.isReadAuthorized(ticket)) return false;
      const me = await args.readIdentity(); if (!session.isReadAuthorized(ticket)) return false;
      if (!kept()) return false;
      if (!permitted(session, me) || detail.id !== args.templateId || version.versionNumber !== args.versionNumber
        || !detail.versions.some(v => v.versionNumber === version.versionNumber && v.status === version.status) || !validConfig(version.config)) throw new Error("Historical version unavailable.");
      baseline = { source: "historical", templateId: detail.id, docType: detail.docType, versionNumber: version.versionNumber, status: version.status,
        config: copyConfig(version.config), updatedAt: version.updatedAt, hasLogo: version.hasLogo, permissions: [...me.permissions] };
      if (!validBaseline(baseline)) throw new Error("Historical version unavailable.");
    } catch {
      baseline = null;
      if (!session.isReadAuthorized(ticket)) return false;
      if (!kept()) return false;
      if (binding.acceptRead({ kind: "unavailable", readId }, {} as never)) return false;
    }
    if (baseline && kept() && binding.acceptRead({ kind: "authorized", readId, baseline, editable: false, recoveryAllowed: false }, () => { throw new Error("Historical reads must retain an existing copy."); })) return true;
    if (!restart()) return false;
  }
  return false;
}
export function consumeDocumentTemplateSelection(session: DraftSession, templateId: string): EditorKey | null {
  const summary = session.store.getSnapshot(); if (!summary.identityReady) return null;
  for (const row of summary.rows) if (row.key.record.kind === "document-template" && row.key.record.id === templateId && row.key.editor === documentTemplateRecoveryAdapter.kind && session.consumeSelection(row.key)) return row.key;
  return null;
}
export async function readDocumentTemplateMetadata(args: {
  binding: DocumentTemplateBinding; session: DraftSession; expectedStamp: Stamp;
  readDetail: () => Promise<DocumentTemplateDetail>; readIdentity: () => Promise<{ id: string; permissions: string[] }>;
}): Promise<boolean> {
  const { binding, session, expectedStamp } = args; const current = binding.getSnapshot().current;
  // The same copy, not the same keystroke (#459, owner ruling 2026-11-02): a stamp captured at the
  // render that started a logo upload is behind by every key typed in another panel since, which
  // must not stop the read. A discarded or replaced copy is a new generation and still stops it.
  if (!current || !sameKey(current.stamp.key, expectedStamp.key) || current.stamp.generation !== expectedStamp.generation) return false;
  const ticket = session.readAuthorizationTicket(); if (!ticket) return false;
  const readId = binding.beginEditRead(); if (readId === null) return false;
  const unavailable = () => {
    // Close only this admitted read's access; obsolete auth/read/lease/generation
    // completions have no authority to hide a newer editor.
    if (session.isReadAuthorized(ticket)) binding.acceptEditRead({ kind: "unavailable", readId }, () => null);
    return false;
  };
  try {
    const detail = await args.readDetail(); if (!session.isReadAuthorized(ticket)) return false;
    const me = await args.readIdentity(); if (!session.isReadAuthorized(ticket)) return false;
    if (!permitted(session, me)) return unavailable();
    const fresh = documentTemplateBaselineFrom(detail, me.permissions); if (!fresh || !me.permissions.includes("templates.edit")) return unavailable();
    const projected = documentTemplateMetadata(current.data, current.baseline, fresh); if (!projected) return unavailable();
    // Another admin's config (#460): adopt nothing and leave the copy editable. Only this read's
    // own answer could use its open edit read, and the next read replaces it.
    if (projected === "changed") return false;
    return binding.acceptEditRead({ kind: "authorized", readId, baseline: projected.baseline, editable: true }, latest => {
      const next = documentTemplateMetadata(latest.data, latest.baseline, fresh);
      return next === null || next === "changed" ? null : next.data;
    });
  } catch { return unavailable(); }
}
