import { describe, expect, it, vi } from "vitest";
import { batchedRead } from "../src/lib/batched-read";

// #701 (2026-10-22 review, G9-2): the cert page's requirement blocks each read the whole cert and
// then /me; a batched read sends ONE request for every caller of the same task (the blocks mount
// in one React commit) and never lets a caller join a flight already sent, which is what keeps
// every joiner's read after its own beginRead. Mutations: send on the first call instead of the
// next microtask and the first case reds; keep the batch open after the send and the second reds.
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

describe("batchedRead", () => {
  it("callers of one task share one read", async () => {
    const d = deferred<number>(); const read = vi.fn(() => d.promise);
    const shared = batchedRead(read);
    const a = shared(); const b = shared();
    expect(read).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    d.resolve(1); expect(await a).toBe(1); expect(await b).toBe(1);
  });
  it("a caller after the send gets its own flight, even while the first is still out", async () => {
    const first = deferred<number>(); const second = deferred<number>(); const flights = [first, second];
    const read = vi.fn(() => flights.shift()!.promise);
    const shared = batchedRead(read);
    const a = shared();
    await Promise.resolve(); await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    const b = shared();
    await Promise.resolve(); await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(2);
    second.resolve(2); first.resolve(1);
    expect(await a).toBe(1); expect(await b).toBe(2);
  });
  it("a rejected flight rejects every caller of its batch and the next call reads again", async () => {
    const read = vi.fn<() => Promise<number>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(3);
    const shared = batchedRead(read);
    const a = shared().catch(e => (e as Error).message); const b = shared().catch(e => (e as Error).message);
    expect(await a).toBe("offline"); expect(await b).toBe("offline");
    expect(await shared()).toBe(3);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
