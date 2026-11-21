import { decimalRefusal } from "./decimal-entry";
import { READING_VALUE } from "./part-boxes";
import type { DraftSession } from "./draft-session";
import type { Adapter, EditorBinding, Submission } from "./draft-store";
import type { CertDetailData, CertRequirementRow } from "../app/certs/[id]/CertDetail";
import type { ReadingPayload } from "../app/certs/[id]/RequirementBlock";

export type CertReadingsRow = Readonly<{ key: number; value: string; overridden: boolean; passedChoice: "" | "pass" | "fail"; note: string }>;
export type CertReadingsDraft = Readonly<{ rows: readonly CertReadingsRow[]; nextKey: number; dirty: boolean }>;
export type CertReadingsBaseline = Readonly<{
  certId: string; printedAt: string | null; deletedAt: string | null; permissions: readonly string[];
  requirement: Readonly<CertRequirementRow & { inspectionCodeId: string; scaleId: string | null }>;
}>;
export type CertReadingsReadRequirements = Readonly<{ certId?: string; requirementId?: string }>;
export type CertReadingsBinding = EditorBinding<CertReadingsDraft, CertReadingsBaseline, ReadingPayload[], CertDetailData, never, CertReadingsReadRequirements>;
export type CapturedCertReadings = Readonly<{ binding: CertReadingsBinding; submission: Submission<CertReadingsDraft, CertReadingsBaseline, ReadingPayload[]> }>;

/** Only this requirement's writer context is retained, never the whole cert response. */
export function certReadingsBaselineFrom(cert: CertDetailData, requirementId: string, permissions: readonly string[]): CertReadingsBaseline | null {
  const requirement = cert.requirements.find(r => r.id === requirementId);
  if (!requirement) return null;
  return {
    certId: cert.id, printedAt: cert.printedAt, deletedAt: cert.deletedAt, permissions: [...permissions],
    requirement: {
      id: requirement.id, orderLineId: requirement.orderLineId, orderLineIdAtSeed: requirement.orderLineIdAtSeed,
      linePosition: requirement.linePosition, partNumber: requirement.partNumber, partName: requirement.partName,
      position: requirement.position, inspectionCodeId: requirement.inspectionCodeId, inspectionCodeName: requirement.inspectionCodeName,
      scaleId: requirement.scaleId, scaleName: requirement.scaleName, min: requirement.min, max: requirement.max,
      sampleQty: requirement.sampleQty, location: requirement.location,
      readings: requirement.readings.map(r => ({ id: r.id, position: r.position, value: r.value, passed: r.passed, overridden: r.overridden, note: r.note })),
    },
  };
}
/** Saved readings as the grid's rows; the block shows the parent's row through it until its own
 *  read lands (#701). */
export function readingRows(readings: CertReadingsBaseline["requirement"]["readings"]): CertReadingsRow[] {
  return readings.map((r, key) => ({ key, value: r.value === null ? "" : String(r.value), overridden: r.overridden,
    passedChoice: r.passed === true ? "pass" : r.passed === false ? "fail" : "", note: r.note }));
}
export function certReadingsDraftFrom(baseline: CertReadingsBaseline): CertReadingsDraft {
  return { rows: readingRows(baseline.requirement.readings), nextKey: baseline.requirement.readings.length, dirty: false };
}
export function editCertReading(data: CertReadingsDraft, key: number, patch: Partial<Omit<CertReadingsRow, "key">>): CertReadingsDraft {
  return { ...data, rows: data.rows.map(row => row.key === key ? { ...row, ...patch } : row), dirty: true };
}
export function addCertReading(data: CertReadingsDraft): CertReadingsDraft {
  return { rows: [...data.rows, { key: data.nextKey, value: "", overridden: false, passedChoice: "", note: "" }], nextKey: data.nextKey + 1, dirty: true };
}
export function removeCertReading(data: CertReadingsDraft, key: number): CertReadingsDraft {
  return { ...data, rows: data.rows.filter(row => row.key !== key), dirty: true };
}
export function prepareCertReadings(binding: CertReadingsBinding, requestId: string): { kind: "refused"; error: string } | { kind: "ready"; captured: CapturedCertReadings } {
  const view = binding.getSnapshot();
  if (view.mode !== "editing" || !view.current || view.needsRefresh) return { kind: "refused", error: "Confirm access and resolve retained readings before saving." };
  const rows = view.current.data.rows;
  // Every refusal is listed, in row order, so one Save names them all (#517). A refused value is not
  // blank, so the needs-a-value sentence cannot fire beside it, and a value that cannot be read
  // cannot be asked to pick a verdict for.
  const lines: string[] = [];
  for (const [i, row] of rows.entries()) {
    const raw = row.value.trim();
    const refusal = decimalRefusal(`Reading ${i + 1}, ${READING_VALUE.label}`, row.value, READING_VALUE.box);
    if (refusal) lines.push(refusal);
    if (row.note.length > 500) lines.push(`Reading ${i + 1}: the note is over 500 characters.`);
    if (row.overridden && raw === "") lines.push(`Reading ${i + 1}: an override needs a measurement value.`);
    if (row.overridden && raw !== "" && !refusal && row.passedChoice === "") lines.push(`Reading ${i + 1}: pick Pass or Fail for the override — an overridden reading cannot stay pending.`);
  }
  if (lines.length > 0) return { kind: "refused", error: lines.join("\n") };
  const payload = rows.map(row => ({ value: row.value.trim() === "" ? null : row.value.trim(),
    passed: row.overridden ? row.passedChoice === "pass" ? true : row.passedChoice === "fail" ? false : null : null,
    overridden: row.overridden, note: row.note }));
  return { kind: "ready", captured: { binding, submission: binding.capture(payload, requestId) } };
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
const strings = (value: Record<string, unknown>, keys: readonly string[]) => keys.every(key => typeof value[key] === "string");
const nullableString = (value: unknown) => value === null || typeof value === "string";
const nullableNumber = (value: unknown) => value === null || typeof value === "number" && Number.isFinite(value);
const verdict = (value: unknown) => value === null || typeof value === "boolean";
function validBaseline(value: unknown): boolean {
  if (!record(value) || typeof value.certId !== "string" || !nullableString(value.printedAt) || !nullableString(value.deletedAt)
    || !Array.isArray(value.permissions) || !value.permissions.every(p => typeof p === "string") || !record(value.requirement)) return false;
  const req = value.requirement;
  return strings(req, ["id", "orderLineIdAtSeed", "partNumber", "partName", "inspectionCodeId", "inspectionCodeName", "sampleQty", "location"])
    && nullableString(req.orderLineId) && nullableString(req.scaleId) && nullableString(req.scaleName)
    && Number.isSafeInteger(req.linePosition) && Number.isSafeInteger(req.position) && nullableNumber(req.min) && nullableNumber(req.max)
    && Array.isArray(req.readings) && req.readings.every(r => record(r) && strings(r, ["id", "note"])
      && Number.isSafeInteger(r.position) && nullableNumber(r.value) && verdict(r.passed) && typeof r.overridden === "boolean");
}
function validData(value: unknown): boolean {
  if (!record(value) || !Number.isSafeInteger(value.nextKey) || Number(value.nextKey) < 0 || typeof value.dirty !== "boolean" || !Array.isArray(value.rows)) return false;
  const keys = new Set<number>();
  return value.rows.every(row => {
    if (!record(row) || !Number.isSafeInteger(row.key) || Number(row.key) < 0 || Number(row.key) >= Number(value.nextKey) || keys.has(Number(row.key))
      || !strings(row, ["value", "note"]) || typeof row.overridden !== "boolean" || !(row.passedChoice === "" || row.passedChoice === "pass" || row.passedChoice === "fail")) return false;
    keys.add(Number(row.key)); return true;
  });
}
function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => equal(value, b[index]));
  if (!record(a) || !record(b)) return false;
  const keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}
export const certReadingsRecoveryAdapter: Adapter<CertReadingsDraft, CertReadingsBaseline, ReadingPayload[], CertDetailData, never, CertReadingsReadRequirements> = {
  kind: "cert-readings", schema: "cert-readings-v1", valid: (data, baseline) => validData(data) && validBaseline(baseline), dirty: data => data.dirty,
  readRequirements: ({ current, submitted, reference }) => {
    const baseline = (current ?? submitted ?? reference)?.baseline;
    return baseline ? { certId: baseline.certId, requirementId: baseline.requirement.id } : {};
  },
  baselineEqual: (saved, fresh) => equal({ ...saved, permissions: [...saved.permissions].sort() }, { ...fresh, permissions: [...fresh.permissions].sort() }),
  reconcileRead: ({ current, fresh }) => ({ data: current.data, baseline: fresh }),
  // Existing certification rollback semantics intentionally retire even unknown outcomes.
  settle: () => ({ kind: "retire" }),
  preview: data => data.rows.flatMap((row, index) => [
    { label: `Reading ${index + 1} value`, value: row.value },
    { label: `Reading ${index + 1} override`, value: row.overridden ? "Yes" : "No" },
    { label: `Reading ${index + 1} chosen verdict`, value: row.passedChoice === "pass" ? "Pass" : row.passedChoice === "fail" ? "Fail" : "Pending" },
    { label: `Reading ${index + 1} note`, value: row.note },
  ]),
};

/** Block-owned reads use the existing ordinary read family; no parent payload cache. */
export async function readCertReadings(args: {
  binding: CertReadingsBinding; session: DraftSession; certId: string; requirementId: string;
  readCert: () => Promise<CertDetailData>;
  readIdentity: () => Promise<{ id: string; permissions: string[] }>;
  accepted: (readId: number) => void;
}): Promise<boolean> {
  const { binding, session } = args; const ticket = session.readAuthorizationTicket();
  if (!ticket) return false;
  let readId = binding.beginRead();
  // Only the core's exact source-change marker can authorize one additional read.
  // A second change stays blocked for explicit retry; never reuse either response.
  for (let attempt = 0; attempt < 2; attempt++) {
    const requirements = binding.readRequirements(readId);
    if (!requirements || !session.isReadAuthorized(ticket)) return false;
    let baseline: CertReadingsBaseline | null = null;
    try {
      if ((requirements.certId !== undefined && requirements.certId !== args.certId)
        || (requirements.requirementId !== undefined && requirements.requirementId !== args.requirementId)) throw new Error("Certification identity did not match this editor.");
      const cert = await args.readCert();
      if (!session.isReadAuthorized(ticket)) return false;
      if (cert.id !== args.certId) throw new Error("Certification response did not match this editor.");
      const me = await args.readIdentity();
      if (!session.isReadAuthorized(ticket)) return false;
      if (me.id !== session.store.getSnapshot().owner?.userId || !me.permissions.includes("certs.view")) throw new Error("Certification access is unavailable.");
      baseline = certReadingsBaselineFrom(cert, args.requirementId, me.permissions);
      if (!baseline) throw new Error("Certification requirement is unavailable.");
    } catch {
      if (!session.isReadAuthorized(ticket)) return false;
      // An unavailable result is still a result of this exact pre-await source.
      // If settlement superseded it, use the same qualified continuation as success.
      if (binding.acceptRead({ kind: "unavailable", readId }, {} as never)) return false;
    }
    if (baseline) {
      const editable = baseline.deletedAt === null && baseline.permissions.includes("certs.edit")
        && (baseline.printedAt === null || baseline.permissions.includes("action.edit_cert_results_after_print"));
      if (binding.acceptRead({ kind: "authorized", readId, baseline, editable }, certReadingsDraftFrom(baseline))) {
        args.accepted(readId); return true;
      }
    }
    if (attempt !== 0 || !session.isReadAuthorized(ticket)) return false;
    const restarted = binding.restartReadAfterChange(readId);
    if (restarted === null) return false;
    readId = restarted;
  }
  return false;
}
