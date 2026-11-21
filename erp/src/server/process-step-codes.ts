import { z, ZodError } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { readableMessage } from "./error-message";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { assertRefExists } from "./reference-guards";
import { STEP_FIELD_TYPES, type StepFieldType } from "../lib/step-field-constants";
import { suggestionNameKey } from "../lib/suggestion-names";
import { normalizeUnit } from "../lib/process-document";
import { TARGET_LABELS } from "../lib/reference-links";
import { findBlockers } from "./reference-blockers";
import { claimRecipeCodes } from "./recipe-catalog-claim";

export type StepFieldInput = { id?: string; label: string; type: StepFieldType; unit?: string | null; sort: number };
export type StepCode = {
  id: string; code: string; name: string; glAccountId: string | null;
  equipmentTag: string; defaultInstruction: string; active: boolean; needsGlAccount: boolean;
  fields: (StepFieldInput & { id: string })[];
};

// .strict(): an unrecognized key (e.g. a stale client sending a field the schema doesn't know)
// 400s instead of being silently dropped — see the `id` field below for the defect that being
// non-strict was masking (HANDOFF §6).
const FIELD = z.object({
  // Present only for a field that already exists — see setStepFields's diff-by-id rework. Absent
  // (or omitted) means "create a new field def." Not validated against the target code here;
  // syncStepFields 404s an id that isn't actually one of this code's own defs.
  id: z.string().optional(),
  // The name's own rules (trimmed, not blank, not one the code already has) need the stored rows,
  // so `syncStepFields` applies them, and only to a name the save adds or changes (#406).
  label: z.string().max(60),
  type: z.enum(STEP_FIELD_TYPES),
  unit: z.string().max(20).nullable().optional(),
  sort: z.number().int().min(0),
}).strict();

// `sort` drives both the on-screen field order and the printed traveler layout. Two fields
// sharing a `sort` would leave Postgres to tie-break `ORDER BY sort ASC` nondeterministically,
// so duplicates are rejected outright rather than silently accepted or auto-renumbered — a
// caller-supplied sort value is meaningful (see the "stores ordered field definitions" test,
// which relies on out-of-order input being placed by explicit `sort`, not array position).
const FIELDS_ARRAY = z.array(FIELD).superRefine((arr, ctx) => {
  const seen = new Set<number>();
  arr.forEach((f, i) => {
    if (seen.has(f.sort)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, "sort"], message: `Duplicate sort value: ${f.sort}` });
    }
    seen.add(f.sort);
  });
});

const CREATE = z.object({
  code: z.string().min(1).max(30),
  name: z.string().min(1).max(100),
  defaultInstruction: z.string().max(4000).optional(),
  glAccountId: z.string().nullable().optional(),
  equipmentTag: z.string().max(60).optional(),
}).strict();

/** `FIELDS_ARRAY.parse`, but a rejection (e.g. `.strict()`'s unrecognized-key error) becomes an
 *  ordinary `HttpError(400, ...)` instead of a raw `ZodError`. Routes never need this — `handle()`
 *  already maps `ZodError` to a 400 JSON response — but `setStepFields`/`updateStepCodeWithFields`
 *  are called directly by callers (and tests) that never pass through `handle()`, and every other
 *  refusal in this file already carries a `.status`; a field-payload rejection should too. */
function parseFields(fields: unknown): z.infer<typeof FIELDS_ARRAY> {
  try {
    return FIELDS_ARRAY.parse(fields);
  } catch (err) {
    if (err instanceof ZodError) throw new HttpError(400, readableMessage(err));
    throw err;
  }
}

export async function listStepCodes(opts?: { includeInactive?: boolean }): Promise<StepCode[]> {
  const rows = await prisma.processStepCode.findMany({
    where: { deletedAt: null, ...(opts?.includeInactive ? {} : { active: true }) },
    // Live suggestions only. A removed one stays in the table (syncStepFields soft-deletes it; see
    // its doc comment) because saveProcessDocument verifies a new step's copied keys against every
    // suggestion the code has had; no other reader shows it.
    include: { fields: { where: { deletedAt: null }, orderBy: { sort: "asc" } } },
    orderBy: { code: "asc" },
  });
  return rows.map((r) => ({
    id: r.id, code: r.code, name: r.name, glAccountId: r.glAccountId,
    equipmentTag: r.equipmentTag, defaultInstruction: r.defaultInstruction, active: r.active,
    // Surfaced in the UI and asserted by Phase 5 before any QBO export runs.
    needsGlAccount: r.glAccountId === null,
    fields: r.fields.map((f) => ({ id: f.id, label: f.label, type: f.type, unit: f.unit, sort: f.sort })),
  }));
}

export async function createStepCode(input: z.input<typeof CREATE>): Promise<{ id: string }> {
  const data = CREATE.parse(input);

  // findFirst, NOT findUnique: `code` is unique only among live rows, but the generated client
  // still types it unique, so findUnique would compile and return the soft-deleted row.
  const existing = await prisma.processStepCode.findFirst({
    where: { code: data.code, deletedAt: null },
    select: { id: true },
  });
  if (existing) throw new HttpError(400, "A process step code with that code already exists");

  // Serializable is scoped to writes that actually assign the FK (spec §5.2) — a pure rename or
  // equipmentTag edit pays none of Serializable's abort-under-ordinary-concurrency cost. The
  // target is still validated on this transaction's own `tx` whenever it IS being assigned, for
  // the same reason as createCustomer's parentId/termsId checks (assertRefExists's doc comment
  // explains why the check must share the write's own transaction to close the writer-side
  // TOCTOU).
  const assignsGlAccount = data.glAccountId != null;
  const row = await withDbErrors({ entity: "Process step code", conflictField: "code" }, () =>
    prisma.$transaction(async (tx) => {
      if (data.glAccountId) await assertRefExists("glAccount", data.glAccountId, tx);
      return auditedCreate("processStepCode", data, () => tx.processStepCode.create({ data }), { tx });
    }, assignsGlAccount ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } : undefined));
  return { id: row.id };
}

export async function updateStepCode(id: string, input: Partial<z.input<typeof CREATE>> & { active?: boolean }) {
  const data = CREATE.partial().extend({ active: z.boolean().optional() }).strict().parse(input);
  // Same Serializable scoping as createStepCode above — see that comment. Clearing glAccountId
  // to null, or a patch that never touches it, needs neither the check nor Serializable.
  const assignsGlAccount = data.glAccountId != null;
  await withDbErrors({ entity: "Process step code", conflictField: "code" }, () =>
    prisma.$transaction(async (tx) => {
      await claimRecipeCodes(tx, [id]);
      if (data.glAccountId) await assertRefExists("glAccount", data.glAccountId, tx);
      await auditedUpdate("processStepCode", id, () => tx.processStepCode.update({ where: { id }, data }), { tx });
    }, assignsGlAccount ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } : undefined));
}

/**
 * `deleteReference`'s guarded shape (reference.ts), transplanted verbatim for the one
 * `BlockerTarget` that isn't a `ReferenceKind`: the blocker scan and the soft delete it guards
 * run inside one Serializable transaction, not two separate statements, for the same
 * writer-side TOCTOU reason documented on `deleteReference` — a concurrent process-document save
 * assigning this code's id to a new `partProcessStep` row (it claims and reads the code on its own
 * Serializable transaction, `saveProcessDocument`) forms the read-write cycle Postgres's SSI needs
 * to abort the race, rather than silently leaving a live row pointing at a code this call just
 * soft-deleted.
 *
 * Owner ruling (design spec §3.2 / §7): ANY live use blocks — a current-revision step or a locked
 * historical revision's step, both via the registry's `liveWhere`-filtered
 * `findBlockers("processStepCode", id, tx)` (Task 2). No `reason` parameter here — spec §5.17
 * excludes step codes from the required-reason delete prompt other entities carry.
 */
export async function deleteStepCode(id: string): Promise<void> {
  const label = TARGET_LABELS.processStepCode;
  await withDbErrors({ entity: "Process step code" }, () =>
    prisma.$transaction(async (tx) => {
      await claimRecipeCodes(tx, [id]);
      const blockers = await findBlockers("processStepCode", id, tx);
      if (blockers.length) {
        throw new HttpError(400, `That ${label} is still in use by ${blockers.length} record(s)`);
      }
      await auditedSoftDelete("processStepCode", id, undefined, tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/**
 * Diffs `parsed` against `codeId`'s LIVE suggested parameters (ProcessStepFieldDef) by id, inside
 * the caller's own `tx`: an item carrying an `id` updates that suggestion's label and sort in
 * place; an item with no `id` creates a new suggestion; a live suggestion the payload omits is
 * soft-deleted (`deletedAt`), never removed from the table.
 *
 * A new step copies its code's suggestions once, keyed by their IDs, and nothing links the rows
 * back to them (spec 2026-09-26 §3.2), so nothing here counts part rows or captured revisions.
 * What remains is §3.3's rule: one key always means one type and one unit, so a suggestion's type
 * and unit never change in place (a 400: remove it and add a new one), whether or not anything
 * copied it. An update writes only `label` and `sort`, so a label edit never rewrites a stored
 * unit either. Units compare through `normalizeUnit` (trimmed, empty is none), the one unit rule
 * the save keys by, and a new suggestion is stored already normalized.
 *
 * Removal is soft because an open editor may hold a new step copied from a suggestion before it
 * was removed, and removing a suggestion never changes a draft (§3.2). The process-document save
 * verifies a new step's keys against every suggestion its code has had, removed ones included,
 * and a removed suggestion's type and unit can never change, so its ID stays verifiable. Every
 * other reader shows live suggestions only: the admin list, the editor catalog and the code's
 * audit image.
 *
 * The lookup below reads live suggestions only, so a stale payload naming a removed suggestion's
 * id meets the 404 and rolls the whole save back. Unfiltered, it would relabel the removed row
 * and soft-delete every newer live suggestion the stale payload omits (Codex, #361).
 *
 * Names (#406). A name the save adds or changes is trimmed, must not be blank, and must not read
 * the same (`suggestionNameKey`) as any other name in the payload, which is the code's whole live
 * set after the save. A suggestion sent back with the name it is stored under is not judged and
 * its name is not changed: names saved before this rule (blank, padded, or two that now read the
 * same) are left as they are, so such a code is still edited one row at a time. The unique index compares
 * names exactly, and a save can still meet it in passing: an entry taking a name that a row later
 * in the payload carries until its own turn (two suggestions swapping names). Every write below is
 * to a suggestion, so a unique violation is that, and is said as that; left to the caller's
 * wrapper it reads as a duplicate step CODE.
 */
async function syncStepFields(
  tx: Prisma.TransactionClient, codeId: string, parsed: z.infer<typeof FIELDS_ARRAY>,
): Promise<void> {
  const existing = await tx.processStepFieldDef.findMany({ where: { codeId, deletedAt: null } });
  const existingById = new Map(existing.map((d) => [d.id, d]));
  const keptIds = new Set(parsed.flatMap((f) => (f.id !== undefined ? [f.id] : [])));
  // Not one of this code's live suggestions (a stale id, a removed suggestion, or one from another
  // code entirely): fail loudly, and before any name is judged, so a stale payload is answered as
  // stale wherever its row is listed.
  for (const keptId of keptIds) {
    if (!existingById.has(keptId)) throw new HttpError(404, "Suggested parameter not found");
  }

  // Before the creates below: labels are unique among live suggestions only, so a removed label
  // can come back in the same save as a new suggestion with its own ID.
  const removedAt = new Date();
  for (const def of existing) {
    if (keptIds.has(def.id)) continue;
    await tx.processStepFieldDef.update({ where: { id: def.id }, data: { deletedAt: removedAt } });
  }

  // Each entry with the name it will be stored under. `judged` is false for a suggestion sent back
  // under its stored name.
  const entries = parsed.map((f) => {
    const def = f.id !== undefined ? existingById.get(f.id) : undefined;
    const judged = def === undefined || def.label !== f.label;
    return { ...f, label: judged ? f.label.trim() : f.label, judged };
  });
  entries.forEach((entry, i) => {
    if (!entry.judged) return;
    if (entry.label === "") throw new HttpError(400, "A suggested parameter needs a name");
    const key = suggestionNameKey(entry.label);
    // Of two added or changed names that read the same, the later one is the one refused.
    if (entries.some((other, j) => j !== i && (j < i || !other.judged) && suggestionNameKey(other.label) === key)) {
      throw new HttpError(400, `A suggested parameter named "${entry.label}" already exists`);
    }
  });

  try {
    await writeStepFields(tx, codeId, entries, existingById);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new HttpError(400, "A suggested parameter with that name already exists");
    }
    throw err;
  }
}

async function writeStepFields(
  tx: Prisma.TransactionClient, codeId: string, parsed: z.infer<typeof FIELDS_ARRAY>,
  existingById: Map<string, { id: string; label: string; type: StepFieldType; unit: string | null }>,
): Promise<void> {
  for (const f of parsed) {
    if (f.id !== undefined) {
      const def = existingById.get(f.id);
      // `syncStepFields` has already answered a stale id; this is the belt to it, never a create
      // that drops the caller's intended id.
      if (!def) throw new HttpError(404, "Suggested parameter not found");
      if (def.type !== f.type || normalizeUnit(def.unit) !== normalizeUnit(f.unit)) {
        // One key always means one type and one unit (spec 2026-09-26 §3.3): a part row copied from
        // this suggestion carries its ID as the key, so the suggestion itself can never be retyped.
        throw new HttpError(400, `The type and unit of a suggested parameter cannot change. Remove "${def.label}" and add a new one.`);
      }
      await tx.processStepFieldDef.update({
        where: { id: def.id },
        data: { label: f.label, sort: f.sort },
      });
    } else {
      await tx.processStepFieldDef.create({
        data: { codeId, label: f.label, type: f.type, unit: normalizeUnit(f.unit), sort: f.sort },
      });
    }
  }
}

/** Applies the field-definition diff described on `syncStepFields`. */
export async function setStepFields(id: string, fields: StepFieldInput[]): Promise<void> {
  const parsed = parseFields(fields);
  await withDbErrors({ entity: "Process step code" }, () =>
    prisma.$transaction(async (tx) => {
      await claimRecipeCodes(tx, [id]);
      return auditedUpdate("processStepCode", id, async () => {
        // syncStepFields alone would silently no-op against a nonexistent codeId when `fields` is
        // empty (nothing to remove, nothing to create), so without this check a bad id would
        // report success and write a useless before=null/after=null audit row instead of 404ing
        // the way updateStepCode does via Prisma's P2025.
        const exists = await tx.processStepCode.findUnique({ where: { id }, select: { id: true } });
        if (!exists) throw new HttpError(404, "Process step code not found");
        await syncStepFields(tx, id, parsed);
      }, { tx });
    },
    // Serializable: a `fields` payload replaces the code's WHOLE suggestion set from the array the
    // caller built it from. Under Read Committed a second replace racing this one would re-read
    // after the code claim and then commit its stale array over the winner's additions, a lost
    // update the admin page's own save queue prevents inside one browser but not across two.
    // Under Serializable the loser's row-version claim aborts (40001 → 409, `withDbErrors`).
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

export type StepCodeUpdateInput = Partial<z.input<typeof CREATE>> & { active?: boolean; fields?: StepFieldInput[] };

/**
 * Applies scalar column changes and a field-definition replacement as a single atomic
 * transaction backed by exactly one audit row. Used by the PUT route, which can carry both
 * kinds of change in one request: without this, a valid `fields` array committed ahead of a
 * rejected scalar change (e.g. a bad `glAccountId`) would leave the code with new fields but
 * stale scalar values — one logical request, partially applied, and two audit rows for what
 * the caller experienced as a single PUT. `setStepFields` and `updateStepCode` stay as they
 * are for callers that only ever touch one side.
 */
export async function updateStepCodeWithFields(id: string, input: StepCodeUpdateInput): Promise<void> {
  const { fields, ...rest } = input;
  const data = CREATE.partial().extend({ active: z.boolean().optional() }).strict().parse(rest);
  const parsedFields = fields === undefined ? undefined : parseFields(fields);

  // Same Serializable scoping as createStepCode above — see that comment. `parsedFields` adds a
  // second, independent reason: a request carrying `fields` replaces the code's whole suggestion
  // set (see setStepFields), so it needs the same isolation even when it never touches glAccountId.
  const assignsGlAccount = data.glAccountId != null;
  const needsSerializable = assignsGlAccount || parsedFields !== undefined;
  await withDbErrors({ entity: "Process step code", conflictField: "code" }, () =>
    prisma.$transaction(async (tx) => {
      await claimRecipeCodes(tx, [id]);
      // Runs first, on this transaction's own `tx`: a bad glAccountId is rejected here before
      // any field statement runs, and the transaction rolls the whole batch back on any failure,
      // so the field definitions are left untouched either way.
      if (data.glAccountId) await assertRefExists("glAccount", data.glAccountId, tx);
      await auditedUpdate("processStepCode", id, async () => {
        // `deletedAt: null` in the WHERE, not a prior read: it is evaluated as part of the UPDATE
        // itself, so a concurrent soft delete either loses the row or wins it outright — and a
        // stale tab whose code was deleted long ago gets the same answer. Without it the update
        // matched on id alone, so scalars and (via syncStepFields below) field definitions were
        // mutated under a soft-deleted code and audited as an update after its own delete entry,
        // describing a change to a row nothing can ever see again (Codex, MR !22). No match is
        // P2025, which withDbErrors turns into the 404 this deserves; throwing here also stops
        // auditedUpdate from writing anything.
        await tx.processStepCode.update({ where: { id, deletedAt: null }, data });
        if (parsedFields !== undefined) await syncStepFields(tx, id, parsedFields);
      }, { tx });
    }, needsSerializable ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } : undefined));
}
