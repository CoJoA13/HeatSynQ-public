// Pure functions over the flat permission-key array /api/auth/me returns. Client-safe:
// no server imports (importing src/server/** would drag Prisma into the browser bundle).
import type { SpecialAction } from "./permission-constants";

export type Gate = { allowed: boolean; disabled: boolean; title: string | undefined };

function decide(held: string[] | undefined, key: string, label: string): Gate {
  const allowed = (held ?? []).includes(key);
  return { allowed, disabled: !allowed, title: allowed ? undefined : `Requires ${label}` };
}

/** Gate a control on an area permission, e.g. gate(me.permissions, "customers.delete"). */
export function gate(held: string[] | undefined, key: string): Gate {
  return decide(held, key, key);
}

/** Gate on a named special action. /api/auth/me keys these as `action.<name>`, but the tooltip
 *  names the action the way the roles screen does, without the prefix. */
export function gateDo(held: string[] | undefined, special: SpecialAction): Gate {
  return decide(held, `action.${special}`, special);
}

/** Whether the permission read is still out: no array has landed and no error has been reported
 *  (`usePermissions`, src/lib/use-permissions.ts). `gate()` reads that beat as no grants, so a
 *  page that would rather not render its controls in it asks this first. A failed read is not
 *  pending, so a page that waits on this answer does not wait for good after a failure: the saved
 *  shipment page then renders, and its banner can show the error (#483). */
export function permissionsPending(held: string[] | undefined, error: string | null): boolean {
  return held === undefined && error === null;
}
