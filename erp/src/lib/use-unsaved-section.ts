"use client";
// The React half of the unsaved-edit guard — the pure registry and predicates are in
// unsaved-guard.ts, which this keeps free of React so it stays unit-testable without a DOM
// (the use-latest.ts / use-edit-guard.ts split).
import { useEffect, useId, useSyncExternalStore } from "react";
import {
  markUnsaved, clearUnsaved, unsavedLabels, confirmMessage, subscribeUnsaved, unsavedCount,
  unsavedPresentExcluding, unsavedPresentInScope, recoverableUnsavedLabels,
} from "./unsaved-guard";
import { usePathname } from "next/navigation";
import { useDraftStoreAnswer } from "./use-recoverable-draft";
import { peekBrowserDraftSession } from "./draft-session";
import { createDiscardIntents } from "./draft-navigation";
import { createNavigationAttempts, type NavigationAttempt } from "./navigation-attempts";
import { writesInFlight } from "./in-flight-writes";
import { askConfirm } from "./modal";

/**
 * Declare that this section holds unsaved edits while `dirty` is true, named `label` in the
 * navigation prompt.
 *
 * Call it from any section whose edits need an explicit Save click — the grids on the order hub
 * (Containers, Serials, Charges, Loads) and their equivalents elsewhere. A blur-saving field needs
 * nothing while its saves land: the value is on its way to the server by the time focus leaves it,
 * which is exactly the asymmetry that made the silent loss so easy to walk into. A blur-save that
 * is REFUSED is the exception, wherever the field keeps the typed value on screen instead of
 * rolling back. The order hub's Lines section does that for Qty and Weight, so it registers
 * (label "Lines") while any of those boxes reads Not saved, or records a save the server did not
 * answer (`anyNotSaved` in line-field-saves.ts). It stops when the value is restored, saved, or
 * shown by the order; after a save the server did not answer, when a later save of that box
 * lands, and not before. A line that leaves the order stops counting either way. The section
 * registers under the same label while a line's Remove got no answer (`anyRemovalUnconfirmed` in
 * line-removals.ts, #475), until a payload no longer lists that line. The hub's Overview and Notes
 * fields roll back to the stored value on a refusal and register nothing.
 *
 * The key is a `useId`, so two instances of the same section on one page (a multi-order shipment
 * panel, say) register independently and one going clean cannot clear the other.
 *
 * `scope` NAMES THE ROWS, where the key merely separates registrations. The key is opaque and is
 * never surfaced, so it can distinguish two sections but cannot let a caller ASK about one of them;
 * that is the gap #293 fell through, since every line's serials editor registers the same label
 * under a different `useId`. Pass a scope wherever a control destroys this section's rows on their
 * own — `serials:<lineId>`, `shipment-order:<shipperOrderId>` — and that control can then refuse on
 * exactly these edits instead of on the whole page. It is in the dependency array with the rest, so
 * a section whose rows are re-identified re-registers rather than answering under a stale name.
 */
export function useUnsavedSection(dirty: boolean, label: string, scope?: string, { recoverable = false }: { recoverable?: boolean } = {}): void {
  const key = useId();
  useEffect(() => {
    if (dirty) markUnsaved(key, label, scope, recoverable);
    else clearUnsaved(key);
    // This registration describes mounted controls only. Retained drafts have their own
    // document registry and survive this component cleanup.
    return () => clearUnsaved(key);
  }, [key, dirty, label, scope, recoverable]);
}

/**
 * The shared discard confirmation. Returns true when clean or when the operator agrees to proceed.
 *
 * Lives here rather than in `unsaved-guard.ts` so that leaf stays pure and DOM-free: this is the
 * half that touches `window.confirm`.
 *
 * The Shell's own search/scan/sign-out paths and its capture click guard call it, because
 * `router.push` produces neither a click for that listener nor a document unload for
 * `beforeunload`, and each must answer before the browser acts. It is the Shell's alone
 * (`tests/modal-sites.test.ts`): every in-page question, a button that navigates after a mutation
 * included, is `askDiscard` below. **Ask BEFORE the request**, never after: cancelling a prompt that
 * appears once the invoice or reversal already exists cancels nothing, it just strands the user on
 * a page whose server state has already moved (Codex P1 on !272).
 *
 * While a write IS in flight the prompt says so, and says that leaving will not cancel it (#276).
 * That window is not rare and is not confined to one page: every editor's dirty flag stays set
 * until its own save lands, so before this the prompt offered to discard changes that were already
 * committing. The counter comes from `in-flight-writes.ts`, incremented by the one request helper
 * rather than registered per save, so no page has to remember to take part.
 *
 * In-page actions pass `askDiscard` a complete `action` question naming what they replace or
 * discard (#300). Omitting it preserves the navigation prompt. This changes wording only: the
 * registry and the caller's existing ask/refuse rule still decide whether anything needs
 * confirmation.
 */
export function currentUnsavedLabels(): string[] {
  return [...new Set([...unsavedLabels(), ...(peekBrowserDraftSession()?.store.labelsForPath(window.location.pathname) ?? [])])];
}
/** The current page's sections whose work a draft keeps after a departure (R24, #704): the draft
 *  store's labels for this path, and the registrations marked `recoverable`. */
export function currentRecoverableLabels(): string[] {
  return [...new Set([...recoverableUnsavedLabels(), ...(peekBrowserDraftSession()?.store.labelsForPath(window.location.pathname) ?? [])])];
}
export function confirmDiscard({ action, allDrafts = false }: { action?: string; allDrafts?: boolean } = {}): boolean {
  const labels = discardLabels(allDrafts);
  // The wording is decided in the pure leaf, which is where it can be exercised both ways without a
  // DOM; this half only reads the counter and hands `window.confirm` the sentence (#276). Sign-out
  // (`allDrafts`) resets the draft store, so there every section is discarded and none is named
  // recoverable; an `action` names its own loss.
  const recoverable = allDrafts || action ? [] : currentRecoverableLabels();
  return labels.length === 0 || window.confirm(confirmMessage(labels, writesInFlight() > 0, action, recoverable));
}

/**
 * The modal form of `confirmDiscard` (spec 2026-10-30 §4.3, ruling 5), for every in-page question
 * (load re-split, the hub's Create invoice, shipment reverse, raise credit, a new shipment's customer
 * change, the apply panel's Apply/Hide, the pick lists' list switch): the same labels and the same
 * `confirmMessage` sentence, asked through `src/lib/modal.ts` instead of `window.confirm`, a call
 * with no `action` naming the kept drafts as the leave prompt does. Resolves true without opening when nothing is
 * unsaved. `confirmDiscard` itself stays synchronous for the Shell's navigation guard, which must
 * answer before the browser acts. `tests/archival-gate-sweep.test.ts` accepts either name as the
 * ask, proved per control the same way.
 */
export async function askDiscard({ action, allDrafts = false }: { action?: string; allDrafts?: boolean } = {}): Promise<boolean> {
  const labels = discardLabels(allDrafts);
  if (labels.length === 0) return true;
  // A call with no `action` is a departure (Create invoice, Raise credit, Reverse, New shipment's
  // Back), so it reads the kept drafts as `confirmDiscard` does and says R24's sentence (owner
  // answer 2026-11-04). When every section named is kept, nothing is discarded: the question is
  // the leave alone, under a plain Leave button.
  const recoverable = allDrafts || action ? [] : currentRecoverableLabels();
  const nothingLost = labels.every((label) => recoverable.includes(label));
  return askConfirm({
    title: action ?? (nothingLost ? "Leave the page?" : "Discard unsaved changes?"),
    body: confirmMessage(labels, writesInFlight() > 0, action, recoverable),
    confirm: nothingLost ? "Leave" : "Discard",
    danger: !nothingLost,
  });
}

function discardLabels(allDrafts: boolean): string[] {
  const labels = currentUnsavedLabels();
  if (allDrafts && (peekBrowserDraftSession()?.store.getSnapshot().count ?? 0) > 0) labels.push("Drafts in this tab");
  return labels;
}

/**
 * Whether anything on screen is holding unsaved edits — for gating a DESTRUCTIVE or IRREVERSIBLE
 * control, not for navigation (the Shell already guards that).
 *
 * The point is that some actions are worse than losing the edits: printing a certification archives
 * the readings the SERVER has, and finalizing an invoice freezes the lines the SERVER has, so
 * running either over an unsaved editor produces permanent paper that disagrees with what the
 * operator is looking at. A parent cannot see its child grid's dirty flag, and this registry is the
 * bridge that already exists.
 *
 * SCOPE, stated because it is a real caveat rather than a guarantee: the registry is app-wide. It
 * reads as "this page's editors" only because exactly one page is mounted at a time — true of this
 * app, but a property of the router, not of this hook. Use it for gating a control on the page whose
 * editors are registered, never as a global "is the app busy".
 */
export function useUnsavedPresent(ignoreLabels?: readonly string[]): boolean {
  const pathname = usePathname();
  const retained = useDraftStoreAnswer((store) => store.labelsForPath(pathname, ignoreLabels).length > 0, false);
  const legacy = useSyncExternalStore(
    subscribeUnsaved,
    // A boolean, so `useSyncExternalStore`'s snapshot identity is stable even though this closure
    // is not. Pass a module-level constant for `ignoreLabels`, never an inline array.
    () => (ignoreLabels === undefined ? unsavedCount() > 0 : unsavedPresentExcluding(ignoreLabels)),
    () => false,
  );
  return legacy || retained;
}

/**
 * Whether the rows registered under exactly `scope` are holding unsaved edits — for gating a control
 * that destroys THAT region and nothing else.
 *
 * The narrow counterpart to `useUnsavedPresent`, and the two are not interchangeable. A print
 * archives what the SERVER holds, so any unsaved editor on the page can make the paper disagree
 * with the screen and the page-wide question is the right one. `removeLine` and
 * `removeOrderFromShipper` destroy one line's serials and one order's three grids respectively, so
 * the page-wide question would refuse them over sections the write cannot reach — and a refusal the
 * operator cannot explain is the one they learn to work around.
 *
 * Same `useSyncExternalStore` shape and the same reason: a boolean snapshot is referentially stable
 * where an array would read as a new snapshot on every render and loop.
 */
export function useUnsavedInScope(scope: string): boolean {
  const pathname = usePathname();
  const retained = useDraftStoreAnswer((store) => store.hasScope(pathname, scope), false);
  const legacy = useSyncExternalStore(
    subscribeUnsaved,
    () => unsavedPresentInScope(scope),
    () => false,
  );
  return legacy || retained;
}

// Initialized only by a browser event. The holder retains bounded metadata, never these
// local lifetime/session callbacks or raw editor values.
let navigationAttempts: ReturnType<typeof createNavigationAttempts> | null = null;
export function captureDiscardNavigation(isLive: () => boolean): NavigationAttempt | null {
  if (typeof window === "undefined") return null;
  navigationAttempts?.invalidate();
  const session = peekBrowserDraftSession();
  const summary = session?.store.getSnapshot();
  if (!session || !summary?.identityReady || !summary.owner || !isLive()) return null;
  const owner = summary.owner;
  navigationAttempts ??= createNavigationAttempts(createDiscardIntents());
  const attempt = navigationAttempts.capture({ owner, stamps: session.store.stampsForPath(window.location.pathname) });
  const isCurrent = () => {
    const present = peekBrowserDraftSession();
    const fresh = present?.store.getSnapshot();
    return isLive() && present === session && fresh?.identityReady === true &&
      fresh.owner?.userId === owner.userId && fresh.owner.authGeneration === owner.authGeneration && attempt.isCurrent();
  };
  return { isCurrent, attach: destination => isCurrent() && attempt.attach(destination), cancel: attempt.cancel };
}
/** Public route observations cannot identify an operation's successful landing. */
export function invalidateDiscardNavigation(): void {
  if (typeof window !== "undefined") navigationAttempts?.invalidate();
}
