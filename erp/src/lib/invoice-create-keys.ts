// Client-safe and pure: the Invoicing list's Create invoices run, and the request key it sends with
// each order's Create (#568, owner ruling 2026-10-19, "List only"). No src/server imports (CLAUDE.md:
// a client component pulling from there drags node:async_hooks and Prisma into the browser bundle).
// Its imports are `ApiError` and `unansweredStatus`, the one rule for whether a failed request got an
// answer, so a Create reads a lost answer as the order hub's Qty and Net weight boxes do.
//
// The server (`createInvoice`, src/server/invoices.ts) answers a Create whose `clientRequestId`
// matches the order's live invoice as that request's own result, `deduped: true`, and refuses any
// other Create of an order that has one. So the key is the run's memory of an order's Create that
// may have been committed. It is made at the order's first Create in a run, written into the map
// before the request goes, and kept until an answer lands: kept after a 5xx, a dropped connection or
// an answer that could not be read (R13, as #547 extended it), so the next run sends it again and a
// Create that was committed is answered as a success while its order is still Shipped and its
// invoice live. Once another session has finalized that invoice, voided the order or corrected it
// off Shipped, the re-sent key is refused 400; once it has discarded the invoice, the key is
// answered with the discarded invoice as a success (HANDOFF §4's #568 residuals). A key is dropped
// after a success or a refusal, so the next run makes a fresh one. The candidates reload after a
// run drops the key of an order it no longer lists (`pruneCreateKeys`). The page holds the map in a
// ref, so a remount starts with none.
//
// It lives in src/lib for line-field-saves.ts's reason: vitest has no component renderer, so decided
// inline in InvoicingList none of this could be proven by mutation.

import { ApiError } from "./fetcher";
import { unansweredStatus } from "./line-field-saves";

/** Order id → the key of its Create that got no answer the list can trust. */
export type CreateKeys = Map<string, string>;

/**
 * Creates each order's invoice through `post`, and returns each failed order's message.
 *
 * Task 11's create is per-order and independent: each ticked order POSTs on its own turn, and a
 * failure on one must never abort the run or hide behind one shared banner — it is reported BESIDE
 * that order's own row (task-17-brief.md). Sequential ("in turn"), not Promise.all, so several
 * ticked orders never race each other into `allocateNumber`'s shared counter for no reason.
 *
 * An order's kept key is sent again; an order without one gets `mint()`'s, written into `keys`
 * before `post` is awaited. `keys` is written in place. A `mint` that throws (`newId()` does when
 * the browser has neither crypto function) is that order's failure, and it leaves no key.
 */
export async function runInvoiceCreates(
  orderIds: readonly string[],
  keys: CreateKeys,
  post: (orderId: string, clientRequestId: string) => Promise<unknown>,
  mint: () => string,
): Promise<Map<string, string>> {
  const failures = new Map<string, string>();
  for (const orderId of orderIds) {
    try {
      let key = keys.get(orderId);
      if (key === undefined) {
        key = mint();
        keys.set(orderId, key);
      }
      await post(orderId, key);
      keys.delete(orderId);
    } catch (e) {
      failures.set(orderId, (e as Error).message);
      if (!unansweredStatus(e instanceof ApiError ? e.status : null)) keys.delete(orderId);
    }
  }
  return failures;
}

/** After the run's candidates reload: drops, in place, the key of each order `applied` no longer
 *  lists. `null` (the reload failed or was superseded, so nothing was applied) keeps every key. */
export function pruneCreateKeys(keys: CreateKeys, applied: ReadonlySet<string> | null): void {
  if (applied === null) return;
  for (const orderId of [...keys.keys()]) if (!applied.has(orderId)) keys.delete(orderId);
}
