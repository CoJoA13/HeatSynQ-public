"use client";
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import type { DraftStore, EditorBinding, EditorView } from "./draft-store";
import { EMPTY_DRAFT_SUMMARY, getBrowserDraftStore } from "./draft-session";
import { selectDraftCount, selectDraftIdentity } from "./draft-summary-select";
const emptyView = Object.freeze({ mode: "loading", canRestore: false, needsRefresh: false } as const);
const emptySubscribe = () => () => {};
const getEmptyView = () => emptyView;
const getEmptySummary = () => EMPTY_DRAFT_SUMMARY;

export function useRecoverableDraft<D, B, P, R, C, Q = never>(binding: EditorBinding<D, B, P, R, C, Q> | null): EditorView<D, B, C> {
  // useId is a supported stable per-instance lifetime token, including StrictMode replay.
  const lease = useId();
  useEffect(() => binding?.attach(lease), [binding, lease]);
  return useSyncExternalStore<EditorView<D, B, C>>(binding?.subscribe ?? emptySubscribe, binding?.getSnapshot ?? getEmptyView, getEmptyView);
}
function useDraftStoreHandle(): DraftStore | null {
  const [store, setStore] = useState<DraftStore | null>(null);
  useEffect(() => { setStore(getBrowserDraftStore()); }, []);
  return store;
}
/**
 * The whole summary, rows and all: this renders again on every keystroke in any recoverable editor
 * (#700). Only a reader that lists the rows takes it (the Drafts panel while open, the template
 * editor's retained-slot check); every other reader subscribes through one of the narrow hooks below.
 */
export function useBrowserDraftStore() {
  const store = useDraftStoreHandle();
  const summary = useSyncExternalStore(store?.subscribe ?? emptySubscribe, store?.getSnapshot ?? getEmptySummary, getEmptySummary);
  return { store, summary };
}
/** The store and its identity, rendering again only when the identity changes (#700). */
export function useDraftIdentity() {
  const store = useDraftStoreHandle();
  const { owner, identityReady } = useSyncExternalStore(store?.subscribe ?? emptySubscribe,
    () => selectDraftIdentity(store?.getSnapshot() ?? EMPTY_DRAFT_SUMMARY), () => selectDraftIdentity(EMPTY_DRAFT_SUMMARY));
  return { store, owner, identityReady };
}
/** The identity and the retained draft count, rendering again only when one of them changes (#700). */
export function useDraftCount() {
  const store = useDraftStoreHandle();
  return useSyncExternalStore(store?.subscribe ?? emptySubscribe,
    () => selectDraftCount(store?.getSnapshot() ?? EMPTY_DRAFT_SUMMARY), () => selectDraftCount(EMPTY_DRAFT_SUMMARY));
}
/**
 * One answer the store gives (`labelsForPath`, `hasScope`), asked again at every store change and
 * rendering again only when it changes (#700). `answer` must return a primitive: a new array or
 * object on every call would read as a new snapshot each time and loop.
 */
export function useDraftStoreAnswer<T extends boolean | number | string>(answer: (store: DraftStore) => T, fallback: T): T {
  const store = useDraftStoreHandle();
  return useSyncExternalStore(store?.subscribe ?? emptySubscribe, () => (store ? answer(store) : fallback), () => fallback);
}
