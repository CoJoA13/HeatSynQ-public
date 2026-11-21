import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/fetcher";
import { pruneCreateKeys, runInvoiceCreates, type CreateKeys } from "@/lib/invoice-create-keys";
import { callback } from "./helpers/lift-callback";

// #568, owner ruling 2026-10-19 ("List only"): the Invoicing list's Create invoices sends each
// ticked order's request key with it, keeps the key of an order whose Create got no answer, and
// re-sends it on the next run. tests/invoice-create-keys.test.ts proves the run's rules on the leaf;
// this file proves the page is wired to them. vitest has no DOM, so the page's own `createInvoices`
// is lifted out of its source (helpers/lift-callback) and run over the real leaf, with recording
// stand-ins for the page's request, reads and state. One lift serves every run of a case, so the
// `createKeys` ref is the same object between them, as the component's is between two clicks. The
// lifted function binds `ticked` once, so the tick set is one live Set: `setTicked` writes each next
// set into it in place, as a render would hand the next click the state the last run left, and a
// case ticks or unticks a row between runs the same way. A run with no tick returns at once.

const LIST = "app/invoicing/InvoicingList.tsx";

/** The page's Create invoices, `ticks` ticked (default `o1`, `o2`). `script` decides each run: the
 *  error the POST of an order throws (absent: it answers), and the order ids the candidates reload
 *  applies (null: the reload failed). `newId` counts: `c1`, `c2`, … */
function page(ticks: string[] = ["o1", "o2"]) {
  const script: { fail: Record<string, Error>; applied: Set<string> | null } = { fail: {}, applied: new Set(["o1", "o2"]) };
  const createKeys: { current: CreateKeys } = { current: new Map() };
  let minted = 0;
  const newId = vi.fn(() => `c${++minted}`);
  const api = vi.fn(async (_path: string, init: RequestInit) => {
    const { orderId } = JSON.parse(init.body as string) as { orderId: string };
    const error = script.fail[orderId];
    if (error) throw error;
    return { invoice: { id: `invoice-${orderId}` }, warnings: [] };
  });
  const ticked = new Set(ticks);
  const setTicked = vi.fn((next: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    const value = typeof next === "function" ? next(new Set(ticked)) : next;
    ticked.clear();
    for (const id of value) ticked.add(id);
  });
  /** The operator ticks (`true`) or unticks (`false`) rows between runs. */
  const tick = (on: boolean, ...orderIds: string[]) => {
    for (const id of orderIds) if (on) ticked.add(id); else ticked.delete(id);
  };
  const setCreateErrors = vi.fn();
  const createInvoices = callback<() => Promise<void>>(LIST, "InvoicingList", "createInvoices", {
    ticked, creating: false, setCreating: vi.fn(), createKeys,
    api, newId, runInvoiceCreates, pruneCreateKeys,
    loadCandidates: vi.fn(async () => script.applied), loadInvoicesRef: { current: async () => {} },
    setTicked, setCreateErrors,
  });
  /** Each POST the page sent, in order: its path, method and parsed body. */
  const posts = () => api.mock.calls.map(([path, init]) => ({
    path, method: init.method, body: JSON.parse(init.body as string) as unknown,
  }));
  return { script, ticked, tick, createInvoices, newId, posts, setCreateErrors };
}

const post = (orderId: string, clientRequestId: string) =>
  ({ path: "/api/invoices", method: "POST", body: { orderId, clientRequestId } });

describe("Invoicing list: Create invoices sends and keeps each order's request key", () => {
  it("posts each ticked order in tick order with its own key from newId", async () => {
    const p = page();
    await p.createInvoices();
    expect(p.posts()).toEqual([post("o1", "c1"), post("o2", "c2")]);
  });

  it("re-sends the key of an order answered 500 when the reload still lists it, minting none for it", async () => {
    const p = page();
    p.script.fail = { o1: new ApiError("x", 500) };
    p.script.applied = new Set(["o1"]);
    await p.createInvoices();
    expect(p.setCreateErrors).toHaveBeenLastCalledWith(new Map([["o1", "x"]]));
    expect(p.ticked).toEqual(new Set(["o1"]));
    p.script.fail = {};
    await p.createInvoices();
    expect(p.posts().slice(2)).toEqual([post("o1", "c1")]);
    expect(p.newId).toHaveBeenCalledTimes(2);
  });

  it("mints afresh for an order the reload no longer lists, ticked again once it is listed", async () => {
    const p = page();
    p.script.fail = { o1: new ApiError("x", 500) };
    p.script.applied = new Set();
    await p.createInvoices();
    expect(p.ticked).toEqual(new Set());
    p.script.fail = {};
    p.tick(true, "o1");
    await p.createInvoices();
    expect(p.posts().slice(2)).toEqual([post("o1", "c3")]);
  });

  it("keeps the key when the reload failed", async () => {
    const p = page();
    p.script.fail = { o1: new ApiError("x", 500) };
    p.script.applied = null;
    await p.createInvoices();
    expect(p.ticked).toEqual(new Set(["o1"]));
    p.script.fail = {};
    await p.createInvoices();
    expect(p.posts().slice(2)).toEqual([post("o1", "c1")]);
  });

  it("mints afresh after a success, though the reload still lists the order", async () => {
    const p = page();
    await p.createInvoices();
    expect(p.ticked).toEqual(new Set());
    p.tick(true, "o1", "o2");
    await p.createInvoices();
    expect(p.posts().slice(2)).toEqual([post("o1", "c3"), post("o2", "c4")]);
  });

  it("mints afresh after a refusal, though the reload still lists the order", async () => {
    const p = page();
    p.script.fail = { o1: new ApiError("Order #7 already has an invoice — discard its draft or credit the finalized one", 400) };
    await p.createInvoices();
    expect(p.ticked).toEqual(new Set(["o1"]));
    p.script.fail = {};
    await p.createInvoices();
    expect(p.posts().slice(2)).toEqual([post("o1", "c3")]);
  });

  it("keeps a key across a run that leaves its order out, while the reload still lists the order", async () => {
    const p = page(["o1"]);
    p.script.fail = { o1: new ApiError("x", 500) };
    await p.createInvoices();
    expect(p.ticked).toEqual(new Set(["o1"]));
    p.script.fail = {};
    p.script.applied = new Set(["o1"]);
    p.tick(false, "o1"); p.tick(true, "o2");
    await p.createInvoices();
    expect(p.ticked).toEqual(new Set());
    p.tick(true, "o1");
    await p.createInvoices();
    expect(p.posts()).toEqual([post("o1", "c1"), post("o2", "c2"), post("o1", "c1")]);
  });
});
