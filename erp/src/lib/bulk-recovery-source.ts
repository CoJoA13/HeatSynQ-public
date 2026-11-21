import { api } from "./fetcher";
import { getBrowserDraftSession } from "./draft-session";
import { sessionReadAuthorization, shareInFlight, type ReadAuthorization } from "./inflight-share";

export type BulkSourceSnapshot<R, A> = Readonly<{ record: R; access: A }>;
export type BulkRecoverySource<R, A> = ReturnType<typeof createBulkRecoverySource<R, A>>;
/** Dispatch provenance is captured while the view is attached. Only the parent
 * newest-applied gate calls accept. No response or catalog is cached here: `read()` is one flight
 * for every grid that asks while it is out under one read authorization (#608; `shareInFlight`),
 * forgotten the moment it settles, and `begin()`'s access read stays one per dispatch. */
export function createBulkRecoverySource<R, A>(readRecord: () => Promise<R>, readAccess: () => Promise<A>,
  auth: ReadAuthorization = sessionReadAuthorization()) {
  type Listener = () => ((snapshot: BulkSourceSnapshot<R, A> | null, isCurrent: () => boolean) => void) | null;
  const listeners = new Set<Listener>();
  let sequence = 0;
  let acceptedSequence = 0;
  const shared = shareInFlight(auth, async (): Promise<BulkSourceSnapshot<R, A>> => {
    const [record, access] = await Promise.all([readRecord(), readAccess()]);
    return { record, access };
  });
  return {
    register(listener: Listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    read: shared.read,
    begin() {
      // A mutation boundary: no read from here on joins a pre-save flight, and settlement
      // (`accept`, `unavailable`) retires a flight begun while the save was out too.
      shared.retire();
      const ticket = ++sequence;
      const acceptors = [...listeners].flatMap(listener => { const accept = listener(); return accept ? [accept] : []; });
      const access = acceptors.length ? readAccess().then(value => ({ value }), () => null) : Promise.resolve(null);
      const isCurrent = () => ticket === acceptedSequence;
      return {
        async accept(record: R) {
          shared.retire(); // settlement: no refresh from here on joins a during-save flight
          if (ticket <= acceptedSequence) return;
          acceptedSequence = ticket; // before auxiliary awaits, not after
          const result = await access;
          if (!isCurrent()) return;
          // ONE snapshot object for every acceptor of this dispatch (Codex on #738): the shipment
          // grids share their catalog read per snapshot object, so an object built per acceptor
          // would key three reads where one serves.
          const snapshot = result ? { record, access: result.value } : null;
          for (const accept of acceptors) accept(snapshot, isCurrent);
        },
        unavailable() {
          shared.retire();
          if (ticket <= acceptedSequence) return;
          acceptedSequence = ticket;
          for (const accept of acceptors) accept(null, isCurrent);
        },
      };
    },
  };
}
/** The surrounding hook also holds a read-authorization ticket across all reads.
 * This check associates /me's actual grants with this document's current owner. */
export async function readBulkPermissions(): Promise<string[]> {
  const me = await api<{ id: string; permissions: string[] }>("/api/auth/me");
  const identity = getBrowserDraftSession()?.store.getSnapshot();
  if (!identity?.identityReady || identity.owner?.userId !== me.id) throw new Error("Confirm your identity to access this editor.");
  return me.permissions;
}
