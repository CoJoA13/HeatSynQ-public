import { prisma } from "./db";
import { HttpError } from "./errors";
import { PICKLIST_KINDS, type PickListKind } from "../lib/reference-constants";

export type PickListRow = { id: string; name: string; active: boolean };
/** A container type's row, the one kind that carries more than id, name and active. `tareEach` is
 *  the type's default tare each in pounds, as a number, or null when the type has none. */
export type ContainerTypePickRow = PickListRow & { tareEach: number | null };

type PickListDelegate = { findMany: (a: object) => Promise<PickListRow[]> };

/** Read-only, gated on a session alone (the route calling this owns that gate). Reference names
 *  are vocabulary, not secrets — materials and specifications are the language of the paperwork
 *  customers already receive. Create/edit/delete stay under `admin` on /api/admin/reference/*.
 *  A 13th permission area was considered and rejected: it would relocate the silent-empty-
 *  dropdown failure to a role misconfiguration instead of removing it.
 *
 *  One figure crosses this route beside the names: a container type's default tare each (weights
 *  design §9.4, put to the owner on 2026-10-09 and not objected to). Both order screens prefill a
 *  container row's Tare each from it, and any signed-in user can read it here. */
export async function listPickList(
  kind: "containerType", opts?: { includeInactive?: boolean },
): Promise<ContainerTypePickRow[]>;
export async function listPickList(
  kind: string, opts?: { includeInactive?: boolean },
): Promise<PickListRow[]>;
export async function listPickList(
  kind: string, opts?: { includeInactive?: boolean },
): Promise<PickListRow[]> {
  // `glAccount` is not in PICKLIST_KINDS (it's the one kind no data-entry screen reads, and
  // stays admin.view-only), so this same check 404s both an excluded kind and a genuinely
  // unknown one — the caller doesn't need to special-case glAccount.
  if (!(PICKLIST_KINDS as readonly string[]).includes(kind)) {
    throw new HttpError(404, `Unknown pick list: ${kind}`);
  }
  const where = { deletedAt: null, ...(opts?.includeInactive ? {} : { active: true }) };

  if (kind === "processStepCode") {
    const rows = await prisma.processStepCode.findMany({
      where, orderBy: { code: "asc" }, select: { id: true, code: true, name: true, active: true },
    });
    // Narrow projection on purpose: the GL account these carry never crosses this route.
    return rows.map((r) => ({ id: r.id, name: `${r.code} — ${r.name}`, active: r.active }));
  }

  if (kind === "containerType") {
    // The same filter and order as the generic branch at the foot of this function, with the one
    // extra column.
    const rows = await prisma.containerType.findMany({
      where, orderBy: { name: "asc" }, select: { id: true, name: true, active: true, tareEach: true },
    });
    // Prisma hands the figure back as a Decimal, and a Decimal serialises to a STRING. The row
    // promises a number. 0 is a figure, so the test is for null, never for a falsy value.
    return rows.map((r): ContainerTypePickRow => ({
      id: r.id, name: r.name, active: r.active,
      tareEach: r.tareEach === null ? null : r.tareEach.toNumber(),
    }));
  }

  // `PICKLIST_KINDS` today is `REFERENCE_KINDS` (minus glAccount) plus the one non-reference
  // exception above, so every other member is a genuine Prisma delegate sharing the reference
  // table's id/name/active/deletedAt shape. That's a fact about the current constant, not
  // something the type system enforces here — a future kind added to PICKLIST_KINDS without a
  // matching branch above would fall through to this cast and, unchecked, silently call
  // `.findMany` on `undefined`. Guard it explicitly so that failure is a loud, named error
  // instead of a runtime TypeError several stack frames away from its cause.
  const delegate = prisma[kind as Exclude<PickListKind, "processStepCode">] as unknown as
    PickListDelegate | undefined;
  if (!delegate || typeof delegate.findMany !== "function") {
    throw new Error(`listPickList: no Prisma delegate wired for pick-list kind "${kind}"`);
  }
  return delegate.findMany({
    where, orderBy: { name: "asc" }, select: { id: true, name: true, active: true },
  });
}
