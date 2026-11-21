// Client-safe leaf (the permission-ui.ts precedent: no src/server imports). Whether the History
// panel may send its read (#620). The audit route is gated on `admin.view` (a permission-model
// decision recorded in docs/HANDOFF.md §6, deliberately not revisited), so a panel on a record page
// whose viewer lacks it used to send a guaranteed 403 on every mount and after every write, and
// then read "History could not be loaded." for what is a missing permission. The decision lives
// here, pure, so tests/history-access.test.ts can pin it without a renderer; HistoryPanel asks it
// before its fetch effect and before it subscribes to invalidations.
import { gate, permissionsPending } from "./permission-ui";

export type HistoryAccess =
  /** The permission read is still out: show "Loading history…" and send nothing. `gate()` reads
   *  an unlanded array as no grants, so asking it now would flash "Requires admin.view" at an
   *  admin before `/api/auth/me` lands. */
  | { kind: "pending" }
  /** The permission read failed: the panel keeps its failure sentence, since a failed read is
   *  not a denial and the page's banner carries the error. */
  | { kind: "failed" }
  /** `admin.view` is not held: show the gate's own title and send nothing. */
  | { kind: "denied"; title: string }
  | { kind: "allowed" };

/** The order matters: a landed array decides, whatever error an earlier attempt left; with no
 *  array, an error is a failure and no error is a read still out. */
export function historyAccess(perms: string[] | undefined, error: string | null): HistoryAccess {
  if (perms !== undefined) {
    const g = gate(perms, "admin.view");
    return g.allowed ? { kind: "allowed" } : { kind: "denied", title: g.title ?? "Requires admin.view" };
  }
  if (permissionsPending(perms, error)) return { kind: "pending" };
  return { kind: "failed" };
}
