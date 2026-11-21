import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ProcessDocumentBaseline, ProcessDocumentResult } from "../lib/process-document";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate } from "./audit";
import { parseRecipeSnapshot, type RecipeSnapshotV1 } from "../lib/recipe-snapshot";
import type { StepFieldType } from "../lib/step-field-constants";
import { captureRecipeSnapshot } from "./recipe-snapshots";

/** `orderCount` (owner ruling 2026-09-26): orders that are not voided whose lead line saved this
 *  revision of the part, each counted once. */
export type RevisionSummary = { recipeNumber: string | null; revisionNumber: number; lockedAt: Date | null; stepCount: number; createdAt: Date; orderCount: number };
/** One part-owned parameter row (spec 2026-09-26 §3.1); `key` is its identity (§3.3). */
export type StepParameterRow = { key: string; label: string; type: StepFieldType; unit: string | null; position: number; value: string };
export type StepRow = { id: string; position: number; codeId: string; code: string; codeName: string; instruction: string; parameters: StepParameterRow[] };
export type RevisionDetail = { recipeNumber: string | null; recipeSnapshot: RecipeSnapshotV1 | null; revisionNumber: number; lockedAt: Date | null; steps: StepRow[] };

const RECIPE_NUMBER = z.object({
  recipeNumber: z.string().nullable(), expectedRecipeNumber: z.string().nullable(),
}).strict();

/** Claim before selecting a revision, even when none exists yet. The row-version write makes
 * Serializable waiters retry instead of choosing a revision from their pre-wait snapshot.
 * This changes no business field or updatedAt; claim-only writes have no audit entry.
 * Historical direct locks may name deleted parts; editor mutations require a live part. */
async function claimPart(partId: string, tx: Prisma.TransactionClient, live = true): Promise<void> {
  const count = live
    ? await tx.$executeRaw`UPDATE "Part" SET "id" = "id" WHERE "id" = ${partId} AND "deletedAt" IS NULL`
    : await tx.$executeRaw`UPDATE "Part" SET "id" = "id" WHERE "id" = ${partId}`;
  if (count === 0) throw new HttpError(404, "Part not found");
}

/** Always follows the part and revision claims. Permanent identities have no liveness filter. */
async function claimRecipe(partId: string, tx: Prisma.TransactionClient) {
  await tx.$queryRaw`SELECT "id" FROM "PartRecipe" WHERE "partId" = ${partId} FOR UPDATE`;
  return tx.partRecipe.findUnique({ where: { partId } });
}

export type RecipeNumberResult = {
  document?: ProcessDocumentResult;
  recipeNumber: string | null;
  revisionNumber: number | null;
  stepIdMap?: Record<string, string>;
};

export async function saveRecipeNumber(
  partId: string,
  input: { recipeNumber: string | null; expectedRecipeNumber: string | null },
  readDocument?: (tx: Prisma.TransactionClient) => Promise<ProcessDocumentBaseline>,
): Promise<RecipeNumberResult> {
  const data = RECIPE_NUMBER.parse(input);
  const recipeNumber = data.recipeNumber === null ? null : data.recipeNumber.trim();
  if (recipeNumber !== null && !/^[A-Za-z0-9-]{1,20}$/.test(recipeNumber)) {
    throw new HttpError(400, "Recipe number must contain 1–20 letters, digits or hyphens");
  }
  const numberKey = recipeNumber === null ? null : recipeNumber.toUpperCase();
  return withDbErrors({ entity: "Recipe" }, async () => {
    try {
      return await prisma.$transaction(async (tx) => {
        // Read the acknowledgement before this transaction releases its claims. Callers
        // without process-view permission omit the reader and retain the existing shape.
        // A number save changes no parameter row: a cut copies every row with its key, so there are
        // no re-keyed rows to acknowledge and the client adopts none.
        const acknowledge = async (result: RecipeNumberResult): Promise<RecipeNumberResult> => readDocument
          ? { ...result, document: { baseline: await readDocument(tx), stepIdMap: result.stepIdMap ?? {}, parameterKeys: {} } }
          : result;
        await claimPart(partId, tx);
        const current = await tx.$queryRaw<{ id: string; revisionNumber: number }[]>`
          SELECT "id", "revisionNumber" FROM "PartProcessRevision"
          WHERE "partId" = ${partId} ORDER BY "revisionNumber" DESC LIMIT 1 FOR UPDATE`;
        const recipe = await claimRecipe(partId, tx);
        const saved = recipe?.number ?? null;
        // A retried successful request is harmless even when its baseline is now stale.
        if (saved === recipeNumber) {
          return acknowledge({ recipeNumber: saved, revisionNumber: current[0]?.revisionNumber ?? null });
        }
        if (saved !== data.expectedRecipeNumber) {
          throw new HttpError(409, "The recipe number changed — reload before saving");
        }
        if (recipe?.usedAt) {
          throw new HttpError(409, "A recipe number used by an order cannot be changed or removed");
        }
        const { rev, stepIdMap } = await workingRevision(partId, tx);
        await auditedUpdate("part", partId, () =>
          auditedUpdate("partProcessRevision", rev.id, async () => {
            if (recipeNumber === null) {
              // Only this unlocked working revision may release an unused identity.
              await tx.partProcessRevision.update({ where: { id: rev.id }, data: { recipeId: null } });
              await tx.partRecipe.delete({ where: { id: recipe!.id } });
            } else {
              const identity = recipe
                ? await tx.partRecipe.update({ where: { id: recipe.id }, data: { number: recipeNumber, numberKey: numberKey! } })
                : await tx.partRecipe.create({ data: { partId, number: recipeNumber, numberKey: numberKey! } });
              await tx.partProcessRevision.update({ where: { id: rev.id }, data: { recipeId: identity.id } });
            }
          }, { tx }), { tx });
        return acknowledge({ recipeNumber, revisionNumber: rev.revisionNumber, stepIdMap: asMapping(stepIdMap) });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (err) {
      // This service's installation-wide identity conflicts are 409, unlike the general
      // catalog translator's 400. The entire transaction (including cut/audit) has rolled back.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new HttpError(409, "That recipe number is already assigned to another part");
      }
      throw err;
    }
  });
}

/** Mirror of part-field-values.ts's validateValue, against StepFieldType (same four cases; TEXT
 *  max 500 here, not 2000 — step values are shorter than custom field text). Message-anchored on
 *  the row's own `label`: a parameter row carries its label and type (spec 2026-09-26 §3.1), so a
 *  row validates itself. */
export function validateStepValue(def: { label: string; type: string }, value: string): string {
  const v = value.trim();
  if (v === "") return "";
  switch (def.type) {
    case "NUMBER":
      if (!/^-?\d{1,12}(\.\d{1,6})?$/.test(v)) {
        throw new HttpError(400, `"${value}" is not a valid number for ${def.label}`);
      }
      return v;
    case "DATE": {
      // Mirror of part-field-values.ts's leap-year rollover guard: Date.parse alone silently
      // rolls a nonexistent calendar date (2025-02-29) over into the next valid one (March 1)
      // instead of rejecting it. Round-tripping through Date.UTC and re-reading the y/m/d back
      // out exposes any silent normalization.
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      if (!match) {
        throw new HttpError(400, `"${value}" is not a valid date (yyyy-mm-dd) for ${def.label}`);
      }
      const [, yStr, mStr, dStr] = match;
      const y = Number(yStr), m = Number(mStr), d = Number(dStr);
      const asUtc = new Date(Date.UTC(y, m - 1, d));
      const rolled = asUtc.getUTCFullYear() !== y || asUtc.getUTCMonth() !== m - 1 || asUtc.getUTCDate() !== d;
      if (Number.isNaN(asUtc.getTime()) || rolled) {
        throw new HttpError(400, `"${value}" is not a valid date (yyyy-mm-dd) for ${def.label}`);
      }
      return v;
    }
    case "CHECKBOX":
      if (v !== "true" && v !== "false") {
        throw new HttpError(400, `${def.label} must be true or false`);
      }
      return v;
    default:
      if (v.length > 500) throw new HttpError(400, `${def.label} is too long (500 max)`);
      return v;
  }
}

/**
 * THE revision-cut rule (spec §5). Resolves — and, when necessary, creates — the revision a
 * mutation should target, entirely inside the caller's own transaction:
 *
 *  - No revision yet: revision 1 is created lazily (§5.1) and returned.
 *  - The current (highest-numbered) revision is unlocked: amend in place (§5.3) — returned as-is.
 *  - The current revision is locked: cut N+1 first (§5.4) — every step and parameter row of the
 *    locked revision is copied into the new revision (position, code, instruction, and each row
 *    with its key, label, type, unit and value — spec 2026-09-26 §3.1: keys survive cuts), and a
 *    position-keyed map from the locked revision's step ids to their copies is returned so callers
 *    naming a step by its (now-superseded) id can resolve it against the new working revision.
 *
 * `stepIdMap` is `null` exactly when no cut happened this call — callers use that to tell "amend
 * in place" (resolve the caller's stepId directly against the returned revision) from "just cut"
 * (resolve it through the map first).
 *
 * CONCURRENCY (Codex, MR !22 — regression test "a lock landing mid-mutation cannot leave the
 * locked revision modified"). The current revision is claimed with `SELECT … FOR UPDATE` before
 * its `lockedAt` is read, because that read is what decides amend-vs-cut and the answer must not
 * be able to go stale between here and the child write. Serializable isolation is NOT the
 * guarantee here, even on both sides: `lockRevision`'s documented caller — Phase 3's order save —
 * holds it inside a Serializable transaction of its own (orders.ts:522), same as the mutators in
 * this file, but that pairing is never what's relied on. Postgres's serializable guarantees only
 * hold among transactions that stay ALL Serializable, a property no caller here is required to
 * preserve; what actually protects `lockedAt` is the row lock, which blocks at ANY caller
 * isolation regardless. Without it, a mutator could read `lockedAt: null`, let that lock commit,
 * then amend the now-locked revision's steps and commit clean, silently breaking §5's
 * immutability guarantee.
 *
 * A row lock is the right instrument precisely because both sides take it at any isolation
 * (`lockRevision`'s `updateMany` locks the same row). Whichever gets there first wins cleanly: a
 * mutator that wins amends in place and the lock follows it; a mutator that loses either sees
 * `lockedAt` set and cuts N+1, or is aborted with 40001, which `withDbErrors` already turns into
 * a 409 "try again" rather than a 500. There is no ordering in which the locked revision changes.
 */
async function workingRevision(partId: string, tx: Prisma.TransactionClient):
  Promise<{ rev: { id: string; revisionNumber: number }; stepIdMap: Map<string, string> | null }> {
  return ensureWorkingProcess(tx, await claimProcessForEdit(tx, partId));
}

export async function claimProcessForEdit(tx: Prisma.TransactionClient, partId: string) {
  await claimPart(partId, tx);
  // Raw because Prisma has no `FOR UPDATE`. Id only — the full row and its steps are read back
  // through the client below, once the lock is held, with the include tree the document projection
  // reads (`loadCurrentRevision`), so the save hands this read to it instead of reading the tree
  // again (#658).
  const claimed = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "PartProcessRevision"
    WHERE "partId" = ${partId}
    ORDER BY "revisionNumber" DESC
    LIMIT 1
    FOR UPDATE
  `;
  const current = claimed.length === 0 ? null : await loadRevisionWhere({ id: claimed[0].id }, tx);
  return { partId, current };
}

export async function ensureWorkingProcess(
  tx: Prisma.TransactionClient, claimed: Awaited<ReturnType<typeof claimProcessForEdit>>,
): Promise<{ rev: { id: string; revisionNumber: number }; stepIdMap: Map<string, string> | null }> {
  const { partId, current } = claimed;
  if (!current) {
    const rev = await auditedCreate("partProcessRevision", { partId, revisionNumber: 1 },
      () => tx.partProcessRevision.create({ data: { partId, revisionNumber: 1 } }), { tx });
    return { rev, stepIdMap: null };
  }
  if (!current.lockedAt) return { rev: current, stepIdMap: null };
  // locked current -> cut N+1: copy every step and parameter row (spec §5.4 — own-part continuity,
  // NOT copy-from-another-part). Keys travel with the rows (spec 2026-09-26 §3.3).
  const next = await auditedCreate("partProcessRevision", { partId, revisionNumber: current.revisionNumber + 1, recipeId: current.recipeId },
    () => tx.partProcessRevision.create({ data: { partId, revisionNumber: current.revisionNumber + 1, recipeId: current.recipeId } }), { tx });
  // The copies' ids are minted here, so the steps and their rows are two statements whatever the
  // step count (#658), where a nested create per step was two each.
  const stepIdMap = new Map(current.steps.map((s) => [s.id, randomUUID()]));
  if (current.steps.length > 0) {
    await tx.partProcessStep.createMany({ data: current.steps.map((s) => ({
      id: stepIdMap.get(s.id)!, revisionId: next.id, position: s.position, codeId: s.codeId, instruction: s.instruction,
    })) });
  }
  const rows = current.steps.flatMap((s) => s.parameters.map((p) => ({
    stepId: stepIdMap.get(s.id)!, position: p.position, key: p.key, label: p.label, type: p.type, unit: p.unit, value: p.value,
  })));
  if (rows.length > 0) await tx.partProcessStepParameter.createMany({ data: rows });
  return { rev: next, stepIdMap };
}

/** Replaces one step's parameter rows with `rows`, at positions 0..n-1 (spec 2026-09-26 §3.1: a
 *  step's rows are one ordered set). The caller (`saveProcessDocument`) has already resolved every
 *  key and validated every value, and holds the part and revision claims; this runs ON its `tx`,
 *  so a later failure in the same save rolls these writes back with the rest. It is called only
 *  for a kept step whose rows changed (#658); a new step's rows are inserted with the save's other
 *  new steps. A rollback test spies on this export by name. */
export async function replaceStepParameters(
  tx: Prisma.TransactionClient, stepId: string,
  rows: readonly { key: string; label: string; type: StepFieldType; unit: string | null; value: string }[],
): Promise<void> {
  await tx.partProcessStepParameter.deleteMany({ where: { stepId } });
  if (rows.length === 0) return;
  await tx.partProcessStepParameter.createMany({
    data: rows.map((r, position) => ({ stepId, position, key: r.key, label: r.label, type: r.type, unit: r.unit, value: r.value })),
  });
}

/** Newest first; 404 if the part is missing or soft-deleted. */
export async function getRevisions(partId: string): Promise<RevisionSummary[]> {
  // The picker prints each revision beside its order count, so both come from ONE read-only
  // RepeatableRead snapshot (CLAUDE.md: figures shown together are read together). Two autocommit
  // reads could show a working revision "on 1 order" or a locked one "on 0" while an order save
  // lands between them. A pure read: no claim, no audit, never Serializable.
  return prisma.$transaction(async (tx) => {
    const part = await tx.part.findFirst({ where: { id: partId, deletedAt: null }, select: { id: true } });
    if (!part) throw new HttpError(404, "Part not found");
    const revs = await tx.partProcessRevision.findMany({
      where: { partId },
      orderBy: { revisionNumber: "desc" },
      include: { recipe: { select: { number: true } }, _count: { select: { steps: true } } },
    });
    // Owner ruling 2026-09-26: orders that are not voided whose LEAD line (`position: 1`) saved this
    // revision of the part, each once. An order has one lead line (`@@unique([orderId, position])`),
    // so a count of lead lines is a count of orders; a rider line carrying this part never counts,
    // and a lead line saved before any revision was locked (`revisionNumber` null) belongs to none.
    const leads = await tx.orderLine.groupBy({
      by: ["revisionNumber"],
      where: { partId, position: 1, revisionNumber: { not: null }, order: { deletedAt: null } },
      _count: { _all: true },
    });
    const counts = new Map(leads.map((l) => [l.revisionNumber, l._count._all]));
    return revs.map((r) => ({
      recipeNumber: r.recipe?.number ?? null,
      revisionNumber: r.revisionNumber, lockedAt: r.lockedAt, stepCount: r._count.steps, createdAt: r.createdAt,
      orderCount: counts.get(r.revisionNumber) ?? 0,
    }));
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

/** The include tree both revision reads share: ordered steps, each with its live code and its own
 *  parameter rows in position order. */
async function loadRevision(partId: string, revisionNumber: number, db: Prisma.TransactionClient) {
  const rev = await loadRevisionWhere({ partId, revisionNumber }, db);
  if (!rev) throw new HttpError(404, "Revision not found");
  return rev;
}
/** The part's current (highest) revision with the same include tree, or null for a part with no
 *  revision; the document projection's ONE read of the rows it tokens and serves (#657). */
export async function loadCurrentRevision(partId: string, db: Prisma.TransactionClient) {
  return loadRevisionWhere({ partId }, db);
}
/** A step's live code and its own parameter rows in position order: the tree under each step,
 *  loaded with the revision (`loadRevisionWhere`) or for a row already read
 *  (`getRevisionContentUnchecked`). */
const STEP_INCLUDE = {
  code: { select: { code: true, name: true } },
  parameters: { orderBy: { position: "asc" } },
} satisfies Prisma.PartProcessStepInclude;

async function loadRevisionWhere(where: { partId: string; revisionNumber?: number } | { id: string }, db: Prisma.TransactionClient) {
  return db.partProcessRevision.findFirst({
    where, orderBy: { revisionNumber: "desc" },
    include: {
      recipe: { select: { number: true } },
      steps: { orderBy: { position: "asc" }, include: STEP_INCLUDE },
    },
  });
}

/** What `rowsDetail` reads of a revision: the row's own scalars, its recipe's number and its step
 *  tree. `loadRevision`'s include satisfies it, and so does the tree `getRevisionContentUnchecked`
 *  assembles around a row it read first (G1-6). */
type RevisionTree = {
  revisionNumber: number; lockedAt: Date | null;
  recipe: { number: string } | null;
  steps: Awaited<ReturnType<typeof loadRevision>>["steps"];
};

/** The rows as the part owns them: labels, types, units and values are the rows' own (spec
 *  2026-09-26 §3.1); only the code and its name join live (renames still propagate, §8). */
export function rowsDetail(rev: RevisionTree, recipeSnapshot: RecipeSnapshotV1 | null): RevisionDetail {
  return {
    recipeNumber: rev.recipe?.number ?? null, recipeSnapshot,
    revisionNumber: rev.revisionNumber,
    lockedAt: rev.lockedAt,
    steps: rev.steps.map((s) => ({
      id: s.id, position: s.position, codeId: s.codeId, code: s.code.code, codeName: s.code.name,
      instruction: s.instruction,
      parameters: s.parameters.map((p) => ({ key: p.key, label: p.label, type: p.type, unit: p.unit, position: p.position, value: p.value })),
    })),
  };
}

/**
 * The revision's own parameter rows, EVEN when it is locked and carries a captured snapshot — the
 * editor's baseline (`readProcessDocumentProjection`). A snapshot captured before part-owned rows
 * lists every field of the step's code, including ones never filled, and none of those has a row;
 * projecting it into the editor would make an unrelated edit save them as new blank parameters
 * and bring back captured labels (Codex, #361). The snapshot still rides along, parsed, for
 * display. Order and history reads want the captured projection instead: `getRevisionContentUnchecked`.
 */
export async function readRevisionRows(
  partId: string, revisionNumber: number, db: Prisma.TransactionClient = prisma,
): Promise<RevisionDetail> {
  return rowsDetailOf(await loadRevision(partId, revisionNumber, db));
}
/** `readRevisionRows` over a revision already loaded (the document projection's one read, #657). */
export function rowsDetailOf(rev: Awaited<ReturnType<typeof loadRevision>>): RevisionDetail {
  const captured = rev.lockedAt && rev.recipeSnapshot !== null ? parseRecipeSnapshot(rev.recipeSnapshot) : null;
  return rowsDetail(rev, captured);
}

/**
 * Full content of one revision: ordered steps, each with the live code (code/name — renames
 * propagate, spec §3.3) and its own parameter rows, or — for a locked revision that captured a
 * snapshot — the captured projection (each captured field as a row keyed by its captured
 * `fieldDefId`), which is what orders on that revision print and what history views show.
 * NOT part-liveness-gated — that gate is `getRevision`'s job (below), the general part-scoped
 * read. This is the shared include-tree + mapping the two callers split on: `getRevision` runs
 * its own liveness check first and then delegates here; `orders.ts`'s `getLockedRevision` calls
 * this directly, deliberately bypassing that gate.
 *
 * Fix-wave R2 finding 7: a part is deletable once every order referencing it is voided
 * (parts.ts's deletePart), but an order's own locked recipe (spec §5.3/§11 — the (partId,
 * revisionNumber) pair frozen onto the order's lead line at save time) has to stay readable
 * forever regardless — a voided order's paperwork is exactly the kind of record that must not
 * 404 just because the part it named has since been cleaned up. Restricted to callers already
 * anchored on a stored (partId, revisionNumber) pair they have independent authority to read
 * (i.e. they already resolved, and are allowed to see, the entity that captured it) — this is
 * NOT a general-purpose unchecked read, and must not be exposed as one.
 */
export async function getRevisionContentUnchecked(
  partId: string, revisionNumber: number, db: Prisma.TransactionClient = prisma,
): Promise<RevisionDetail> {
  // The revision row first, on its own (G1-6): a locked revision that captured a snapshot answers
  // from that column alone, and its step, code and parameter rows, which the hub's Process section
  // and every traveler print used to load and discard, are not read. Only a revision with no
  // snapshot loads its tree, in the same three statements as before, around this row.
  const rev = await db.partProcessRevision.findFirst({
    where: { partId, revisionNumber },
    select: { id: true, revisionNumber: true, lockedAt: true, recipeSnapshot: true, recipeId: true },
  });
  if (!rev) throw new HttpError(404, "Revision not found");
  if (rev.lockedAt && rev.recipeSnapshot !== null) {
    const captured = parseRecipeSnapshot(rev.recipeSnapshot);
    return {
      revisionNumber: rev.revisionNumber, lockedAt: rev.lockedAt,
      recipeNumber: captured.recipeNumber, recipeSnapshot: captured,
      steps: captured.steps.map((step) => ({
        id: step.stepId, position: step.position, codeId: step.codeId, code: step.code,
        codeName: step.codeName, instruction: step.instruction,
        parameters: step.fields.map((field) => ({
          key: field.fieldDefId, label: field.label, type: field.type, unit: field.unit,
          position: field.position, value: field.value === null ? "" : String(field.value),
        })),
      })),
    };
  }
  // Sequential, never `Promise.all`: `db` may be a transaction client, which runs one query at a time.
  const recipe = rev.recipeId === null ? null
    : await db.partRecipe.findFirst({ where: { id: rev.recipeId }, select: { number: true } });
  const steps = await db.partProcessStep.findMany({
    where: { revisionId: rev.id }, orderBy: { position: "asc" }, include: STEP_INCLUDE,
  });
  return rowsDetail({ revisionNumber: rev.revisionNumber, lockedAt: rev.lockedAt, recipe, steps }, null);
}

/** The general, part-scoped read: live-part-gated, then delegates to `getRevisionContentUnchecked`
 *  for the actual content.
 *
 *  `db` defaults to the top-level client, so every existing caller is unchanged; a caller already
 *  inside a transaction passes its own `tx` so BOTH reads join that transaction rather than
 *  taking a second pooled connection while the first is held (fix-wave R4 finding 8 —
 *  traveler.ts's print does exactly this). */
export async function getRevision(
  partId: string, revisionNumber: number, db: Prisma.TransactionClient = prisma,
): Promise<RevisionDetail> {
  const part = await db.part.findFirst({ where: { id: partId, deletedAt: null }, select: { id: true } });
  if (!part) throw new HttpError(404, "Part not found");
  return getRevisionContentUnchecked(partId, revisionNumber, db);
}

/** The old-step-id -> new-step-id mapping a revision cut produced, or `{}` when no cut happened.
 *  `saveRecipeNumber` returns it so the client can follow its unsaved ordered process draft across
 *  a cut, whose copies carry brand-new ids — without a mapping, an action that cut a locked
 *  revision silently discarded whatever the user had typed (Codex, MR !22). The process-document
 *  save builds its own map, keyed by the rows it was sent. Plain object rather than a Map: this
 *  crosses the wire as JSON. */
export type StepIdMapping = Record<string, string>;

const asMapping = (m: Map<string, string> | null): StepIdMapping =>
  m ? Object.fromEntries(m) : {};

/** Thrown by `lockRevision`'s own `doIt` to short-circuit `auditedUpdate`'s unconditional write
 *  when the atomic `updateMany` claimed zero rows — i.e. a concurrent caller already locked this
 *  revision first. Caught immediately below and turned into a silent, unaudited no-op; never
 *  escapes this function. */
class RevisionAlreadyLocked extends Error {}

/**
 * Sets `lockedAt` once (spec §5.5) — idempotent: a second call against an already-locked
 * revision is a silent no-op, not an error, and writes no audit entry. Exported for Phase 3's
 * order save to call inside the order's own transaction; nothing in this phase calls it.
 *
 * Concurrency contract: "already locked" is decided by the atomic `updateMany`'s own row count,
 * not by a prior JS-level read of `lockedAt` — a check-then-act shape (read `lockedAt`, branch,
 * then write) would let two overlapping callers both read `lockedAt: null`, both conclude "I'm
 * the one locking it", and both write an audit "update" entry, one of them with before===after
 * for a lock that never actually happened on the DB. Instead, the `updateMany`'s own
 * `lockedAt: null` guard runs as the mutation itself, inside `auditedUpdate`'s doIt — so the
 * before-snapshot is taken before it, and only the caller whose `updateMany` actually claims the
 * row (`count === 1`) reaches `auditedUpdate`'s write. The loser's `count === 0` throws
 * `RevisionAlreadyLocked`, which prevents `doIt` from returning normally and therefore prevents
 * `auditedUpdate` from ever calling `write()` — caught here and turned into the documented
 * silent no-op.
 */
export async function lockRevision(
  partId: string, revisionNumber: number, tx: Prisma.TransactionClient,
): Promise<void> {
  await claimPart(partId, tx, false);
  const [existing] = await tx.$queryRaw<{ id: string; recipeId: string | null }[]>`
    SELECT "id", "recipeId" FROM "PartProcessRevision"
    WHERE "partId" = ${partId} AND "revisionNumber" = ${revisionNumber} FOR UPDATE`;
  if (!existing) throw new HttpError(404, "Revision not found");
  const recipe = existing.recipeId ? await claimRecipe(partId, tx) : null;
  try {
    await auditedUpdate("partProcessRevision", existing.id, async () => {
      const { count } = await tx.partProcessRevision.updateMany({
        where: { id: existing.id, lockedAt: null }, data: { lockedAt: new Date() },
      });
      if (count === 0) throw new RevisionAlreadyLocked();
      await captureRecipeSnapshot(tx, existing.id);
      if (recipe && !recipe.usedAt) {
        await auditedUpdate("part", partId, () =>
          tx.partRecipe.update({ where: { id: recipe.id }, data: { usedAt: new Date() } }), { tx });
      }
    }, { tx });
  } catch (err) {
    if (err instanceof RevisionAlreadyLocked) return; // lost the race — no audit, no error
    throw err;
  }
}

/** Same claim SQL as workingRevision — this file is the only home of that `FOR UPDATE` (HANDOFF
 *  §4a: the row lock is the guarantee at ANY caller isolation, not the transaction's own level).
 *  Exported for Phase 3's order save to call inside its own Serializable transaction
 *  (orders.ts:522). The part claim precedes selection, so a waiting Serializable transaction
 *  retries instead of targeting a superseded revision from a pre-wait snapshot. */
export async function lockCurrentRevision(
  partId: string, tx: Prisma.TransactionClient,
): Promise<{ revisionNumber: number }> {
  await claimPart(partId, tx);
  const claimed = await tx.$queryRaw<{ id: string; revisionNumber: number }[]>`
    SELECT "id", "revisionNumber" FROM "PartProcessRevision"
    WHERE "partId" = ${partId} ORDER BY "revisionNumber" DESC LIMIT 1 FOR UPDATE`;
  if (claimed.length === 0) throw new HttpError(400, "This part has no process steps");
  const stepCount = await tx.partProcessStep.count({ where: { revisionId: claimed[0].id } });
  if (stepCount === 0) throw new HttpError(400, "This part has no process steps");
  await lockRevision(partId, claimed[0].revisionNumber, tx);
  return { revisionNumber: claimed[0].revisionNumber };
}
