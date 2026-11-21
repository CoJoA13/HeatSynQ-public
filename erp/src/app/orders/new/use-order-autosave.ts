"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { api, UnreadableAnswerError } from "@/lib/fetcher";
import { blankDraft, compactDraft } from "./order-draft";
import { createOrderAutosaveController, type DraftPrompt } from "./entry-state";

/** A draft write that resolves when its 2xx answer could not be read, and rejects as it always has
 *  otherwise. */
async function stored(write: Promise<unknown>): Promise<unknown> {
  try {
    return await write;
  } catch (error) {
    if (error instanceof UnreadableAnswerError) return undefined;
    throw error;
  }
}

/** The page's draft transport. #547 (the owner's answer of 2026-10-18 to the plan's question 8):
 *  the PUT and the DELETE answer only `{ ok: true }`, which the controller never reads, and a 2xx
 *  proves the draft was stored or cleared, so one whose answer could not be read resolves. Without
 *  this the autosave read as failed and New order stayed registered unsaved over a stored draft, and
 *  Discard kept its prompt over a cleared one. Anything else still rejects. The read is unchanged:
 *  its answer is the draft. The rule lives here, so `entry-state.ts` stays free of the fetcher.
 *  The PUT carries the compact draft shape (`compactDraft`, #663). */
export function orderDraftTransport(): Parameters<typeof createOrderAutosaveController>[1] {
  return {
    read: () => api<DraftPrompt | null>("/api/order-drafts"),
    put: payload => stored(api("/api/order-drafts", { method: "PUT", body: JSON.stringify({ payload: compactDraft(payload) }) })),
    clear: () => stored(api("/api/order-drafts", { method: "DELETE" })),
  };
}

/** All lifecycle/queue decisions live in the pure controller exercised by the race tests. */
export function useOrderAutosave() {
  const [controller] = useState(() => createOrderAutosaveController(blankDraft(), orderDraftTransport()));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    void controller.start();
    return () => controller.stop();
  }, [controller]);
  return { ...snapshot, setDraft: controller.setDraft, resumeDraft: controller.resumeDraft,
    discardDraft: controller.discardDraft, beginSave: controller.beginSave,
    saveSucceeded: controller.saveSucceeded, saveFailed: controller.saveFailed };
}
