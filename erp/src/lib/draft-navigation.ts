import type { Owner, Stamp } from "./draft-store";

export type DiscardIntent = Readonly<{
  operationId: string; owner: Owner; stamps: readonly Stamp[]; destination: string;
}>;

/** One caller-attributed departure; consumption returns consent, not authority to delete. */
export function createDiscardIntents(): {
  prepare(intent: DiscardIntent): void;
  attach(operationId: string, destination: string): void;
  consume(operationId: string, committedDestination: string): readonly Stamp[];
  invalidate(operationId?: string): void;
} {
  let pending: { intent: DiscardIntent; attached: boolean } | undefined;
  return {
    prepare(intent) {
      const owner = Object.freeze({ userId: intent.owner.userId, authGeneration: intent.owner.authGeneration });
      const stamps = intent.stamps
        .filter(stamp => stamp.key.owner.userId === owner.userId && stamp.key.owner.authGeneration === owner.authGeneration)
        .map(stamp => Object.freeze({
          key: Object.freeze({
            owner,
            record: Object.freeze({ kind: stamp.key.record.kind, id: stamp.key.record.id }),
            editor: stamp.key.editor,
            ...(stamp.key.childId === undefined ? {} : { childId: stamp.key.childId }),
            ...(stamp.key.entityVersion === undefined ? {} : { entityVersion: stamp.key.entityVersion }),
          }),
          generation: stamp.generation,
          version: stamp.version,
        }));
      pending = {
        intent: Object.freeze({ operationId: intent.operationId, owner, stamps: Object.freeze(stamps), destination: intent.destination }),
        attached: false,
      };
    },
    attach(operationId, destination) {
      if (pending?.intent.operationId === operationId && pending.intent.destination === destination) pending.attached = true;
    },
    consume(operationId, committedDestination) {
      if (!pending || pending.intent.operationId !== operationId) return [];
      if (pending.intent.destination !== committedDestination) {
        pending = undefined;
        return [];
      }
      if (!pending.attached) return [];
      const stamps = pending.intent.stamps;
      pending = undefined;
      return stamps;
    },
    invalidate(operationId) {
      if (operationId === undefined || pending?.intent.operationId === operationId) pending = undefined;
    },
  };
}
