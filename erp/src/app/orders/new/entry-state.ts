import type { TravelerSelection } from "@/lib/traveler-selection";
import type { OrderTotalsInput } from "@/lib/order-totals";
import { entryTareEach, typeDefaultTare } from "@/lib/container-tare-prefill";
import { blankLoadAdjustment, isDraftEmpty, normalizeDraft, storedTravelerSelection,
  type ContainerDraft, type ContainerTypeOption, type OrderDraftState } from "./order-draft";

export type EntryTab = "details" | "parts" | "process";
export type DraftSaveState = {
  status: "idle" | "dirty" | "saving" | "saved" | "error";
  acknowledgedGeneration: number;
  message?: string;
};

export function isCurrentDraftSaved(currentGeneration: number, acknowledgedGeneration: number): boolean {
  return currentGeneration === acknowledgedGeneration;
}

export function changeLeadAdjustment(draft: OrderDraftState, newLeadId: string | null): {
  draft: OrderDraftState; notice: string | null;
} {
  const adjustment = draft.loadAdjustmentDraft;
  if (adjustment.leadPartId === newLeadId ||
      (!adjustment.enabled && adjustment.leadPartId === null)) return { draft, notice: null };
  return { draft: { ...draft, loadAdjustmentDraft: blankLoadAdjustment() },
    notice: "Lead part changed; order-only load adjustment was reset." };
}

export function reconcileTravelerSelection(selection: TravelerSelection, previousPlanKey: string | null,
  nextPlanKey: string | null): { selection: TravelerSelection; notice: string | null } {
  if (previousPlanKey !== nextPlanKey) {
    return { selection: { mode: "all" }, notice: "Load plan changed; all loads are selected." };
  }
  return { selection: storedTravelerSelection(selection), notice: null };
}

/** E1 of the weights design's §10.3: what order entry's Containers section says while the page's
 *  read of the container types has failed (owner ruling P3 of 2026-10-09). The owner's approved
 *  wording, word for word: do not reword it here. "Draft saved" is the word `DraftSaveStatus`
 *  (EntryWorkspace.tsx) shows once the draft is stored. */
export const CONTAINER_TYPES_NOT_LOADED =
  "Container types could not be loaded, so a row's Type shows blank and its Tare each is not filled in. Reload the page once it reads Draft saved, or type each Tare each.";

/**
 * What order entry hands `orderTotals` (src/lib/order-totals.ts) for the totals table under the
 * container rows (the weights design §10.2).
 *
 * `lines` is the page's checked lines, null for a line that is not complete. The table's line
 * figures are given only when there is at least one line and every line is complete, which is the
 * page's rule for its side summary's Quantity and Total weight.
 *
 * `lineParts` is every draft line's part with that part's each weight from `parts`, a line that is
 * not complete included: Implied pieces is judged by the parts the lines name (owner ruling W6; the
 * design's §10.7, point 3). A line with no part gives no part, and a part that `parts` does not
 * hold gives no each weight.
 *
 * A container row's Tare each is what its box shows, composed as `entryContainerBody` below
 * composes it: the type's default is in it, though the draft never stores one. Containers, Pieces
 * and Scale gross go as they were typed, for the leaf to read.
 */
export function entryTotalsInput(input: {
  draftLines: readonly { partId: string | null }[];
  lines: readonly ({ partId: string; qty: number; weight: number } | null)[];
  parts: readonly { id: string; eachWeight: number }[];
  containers: readonly ContainerDraft[];
  containerTypes: readonly ContainerTypeOption[];
}): OrderTotalsInput {
  const checked = input.lines.flatMap((line) => (line === null ? [] : [{ qty: line.qty, weight: line.weight }]));
  return {
    lines: checked.length > 0 && checked.length === input.lines.length ? checked : null,
    lineParts: input.draftLines.map((line) => ({
      partId: line.partId,
      eachWeight: input.parts.find((part) => part.id === line.partId)?.eachWeight ?? null,
    })),
    containers: input.containers.map((c) => ({
      count: c.count,
      pieces: c.pieces,
      tareEach: entryTareEach(c.tareEachOverride, typeDefaultTare(input.containerTypes, c.typeId)),
      scaleGross: c.scaleGross,
    })),
  };
}

/** One container row of the create body. Tare each is what its box shows: the operator's own text
 *  once the box was typed in, and until then the picked type's default. A blank box sends no tare
 *  each, a box the operator cleared included. The server stores what it is sent and applies no
 *  default of its own. */
export function entryContainerBody(c: ContainerDraft, containerTypes: readonly ContainerTypeOption[]): {
  typeId: string | null; count: number; pieces: number | null; tareEach: string | null;
  scaleGross: string | null; customerContainerId: string;
} {
  const tareEach = entryTareEach(c.tareEachOverride, typeDefaultTare(containerTypes, c.typeId)).trim();
  return {
    typeId: c.typeId,
    count: Number(c.count),
    pieces: c.pieces.trim() === "" ? null : Number(c.pieces),
    tareEach: tareEach === "" ? null : tareEach,
    scaleGross: c.scaleGross.trim() === "" ? null : c.scaleGross.trim(),
    customerContainerId: c.customerContainerId,
  };
}

export type DraftPrompt = { payload: unknown; updatedAt: string };
export type OrderAutosaveSnapshot = {
  draft: OrderDraftState;
  generation: number;
  draftReady: boolean;
  draftPrompt: DraftPrompt | null;
  draftPromptError: string | null;
  draftPromptBusy: boolean;
  saveState: DraftSaveState;
};
type DraftTransport = {
  read: () => Promise<DraftPrompt | null>;
  put: (draft: OrderDraftState) => Promise<unknown>;
  clear: () => Promise<unknown>;
};

/** The page's single-flight queue and save barrier, independent of React/DOM for race tests.
 * Draft changes enter synchronously, so acknowledgements cannot race a delayed render/effect.
 * Only typed state lives in this controller; previews and active tabs stay with their UI. */
export function createOrderAutosaveController(initialDraft: OrderDraftState, transport: DraftTransport) {
  let snapshot: OrderAutosaveSnapshot = {
    draft: initialDraft, generation: 0, draftReady: false, draftPrompt: null,
    draftPromptError: null, draftPromptBusy: false,
    saveState: { status: "idle", acknowledgedGeneration: 0 },
  };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  let active = false;
  let lifecycle = 0;
  let saving = false;
  let saved = false;
  let hasEverBeenNonEmpty = false;

  function publish(patch: Partial<OrderAutosaveSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  }
  function cancelTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  function schedule() {
    cancelTimer();
    if (!active || !snapshot.draftReady || saving || saved) return;
    const { draft, generation } = snapshot;
    const empty = isDraftEmpty(draft);
    if (empty && !hasEverBeenNonEmpty) return;
    timer = setTimeout(() => {
      timer = null;
      chain = chain.then(async () => {
        if (generation === snapshot.generation) {
          publish({ saveState: { ...snapshot.saveState, status: "saving" } });
        }
        try {
          if (empty) await transport.clear();
          else await transport.put(draft);
          // A's success covers A only, even if B was typed while A was in flight.
          publish({ saveState: {
            status: isCurrentDraftSaved(snapshot.generation, generation) ? "saved" : "dirty",
            acknowledgedGeneration: generation,
          } });
        } catch (error) {
          publish({ saveState: {
            status: generation === snapshot.generation ? "error" : "dirty",
            acknowledgedGeneration: snapshot.saveState.acknowledgedGeneration,
            message: `Draft autosave failed: ${error instanceof Error ? error.message : "Unknown error"}`,
          } });
        }
      });
    }, 2000);
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async start() {
      active = true;
      const epoch = ++lifecycle;
      if (snapshot.draftReady || snapshot.draftPrompt) { schedule(); return; }
      try {
        const row = await transport.read();
        if (!active || epoch !== lifecycle) return;
        if (row && row.payload !== null) publish({ draftPrompt: row });
        else publish({ draftReady: true });
      } catch (error) {
        if (!active || epoch !== lifecycle) return;
        // Preserve entry's existing recovery behavior: report the read failure and allow entry.
        publish({ draftPromptError: error instanceof Error ? error.message : "Could not load draft",
          draftReady: true });
      }
    },
    stop() {
      active = false;
      ++lifecycle;
      cancelTimer();
    },
    setDraft(update: OrderDraftState | ((draft: OrderDraftState) => OrderDraftState)) {
      if (!snapshot.draftReady || saved) return;
      const draft = typeof update === "function" ? update(snapshot.draft) : update;
      if (draft === snapshot.draft) return;
      if (!isDraftEmpty(draft)) hasEverBeenNonEmpty = true;
      publish({ draft, generation: snapshot.generation + 1,
        saveState: { ...snapshot.saveState, status: "dirty" } });
      schedule();
    },
    resumeDraft() {
      if (!snapshot.draftPrompt || snapshot.draftPromptBusy || saved) return;
      const draft = normalizeDraft(snapshot.draftPrompt.payload);
      // Even a stored blank draft must be cleared; it is not an untouched first visit.
      hasEverBeenNonEmpty = true;
      publish({ draft, generation: snapshot.generation + 1, draftPrompt: null,
        draftReady: true, draftPromptError: null,
        saveState: { ...snapshot.saveState, status: "dirty" } });
      schedule();
    },
    async discardDraft() {
      if (!snapshot.draftPrompt || snapshot.draftPromptBusy || saved) return;
      publish({ draftPromptBusy: true });
      try {
        await transport.clear();
        publish({ draftPrompt: null, draftReady: true, draftPromptError: null });
      } catch (error) {
        publish({ draftPromptError: error instanceof Error ? error.message : "Could not discard draft" });
      } finally {
        publish({ draftPromptBusy: false });
      }
    },
    beginSave() {
      saving = true;
      cancelTimer();
      // Includes every already-enqueued request. Create must not overtake any of them.
      return chain;
    },
    saveSucceeded() {
      saved = true;
      cancelTimer();
    },
    saveFailed() {
      saving = false;
      // Retry recovery even when there was no further typing after the cancelled debounce.
      schedule();
    },
    // The same settlement barrier is exposed to deterministic callers; no test-only queue.
    settled: () => chain,
  };
}
