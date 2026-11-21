import type { Owner, Stamp } from "./draft-store";
import type { createDiscardIntents } from "./draft-navigation";

export type NavigationAttempt = Readonly<{
  isCurrent(): boolean;
  attach(destination: string): boolean;
  cancel(): void;
}>;

/** One pre-destination operation; the supplied ledger alone owns discard intents. */
export function createNavigationAttempts(intents: ReturnType<typeof createDiscardIntents>): {
  capture(snapshot: Readonly<{ owner: Owner; stamps: readonly Stamp[] }>): NavigationAttempt;
  invalidate(): void;
} {
  let sequence = 0;
  let current: { operationId: string; owner: Owner; stamps: readonly Stamp[]; attached: boolean } | null = null;
  return {
    capture(snapshot) {
      intents.invalidate();
      const operationId = `navigation-${++sequence}`;
      current = {
        operationId, owner: Object.freeze({ userId: snapshot.owner.userId, authGeneration: snapshot.owner.authGeneration }),
        stamps: Object.freeze(snapshot.stamps.map(stamp => Object.freeze({
          key: Object.freeze({
            owner: Object.freeze({ userId: stamp.key.owner.userId, authGeneration: stamp.key.owner.authGeneration }),
            record: Object.freeze({ kind: stamp.key.record.kind, id: stamp.key.record.id }),
            editor: stamp.key.editor,
            ...(stamp.key.childId !== undefined ? { childId: stamp.key.childId } : {}),
            ...(stamp.key.entityVersion !== undefined ? { entityVersion: stamp.key.entityVersion } : {}),
          }),
          generation: stamp.generation, version: stamp.version,
        }))), attached: false,
      };
      // Old handles keep only their identifier, not another copy of retained metadata.
      const isCurrent = () => current?.operationId === operationId;
      return {
        isCurrent,
        attach(destination) {
          if (!current || current.operationId !== operationId || current.attached) return false;
          current.attached = true;
          intents.prepare({ operationId, owner: current.owner, stamps: current.stamps, destination });
          intents.attach(operationId, destination);
          return true;
        },
        cancel() {
          if (!isCurrent()) return;
          current = null;
          intents.invalidate(operationId);
        },
      };
    },
    invalidate() {
      current = null;
      intents.invalidate();
    },
  };
}
