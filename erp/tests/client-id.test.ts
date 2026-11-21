// #348: `newId()` (src/lib/client-id.ts) is the only way client code mints an ID, because
// `crypto.randomUUID` is undefined outside a secure context. vitest runs in Node, where it always
// exists, so every case here passes an explicit source or stubs the global, and never relies on
// the ambient `crypto` taking the path under test.
import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newId, type IdSource } from "../src/lib/client-id";
import { V4_UUID, normalizeRequestNonce } from "../src/lib/idempotent-save";
import { storeOrderPrintIntent, takeOrderPrintIntent, type OrderPrintIntent } from "../src/lib/order-print-intent";

type Fill = (array: Uint8Array<ArrayBuffer>) => unknown;
/**
 * A source whose `getRandomValues` refuses a DETACHED call, exactly as a browser `Crypto` does
 * ("Illegal invocation"). Every fallback case builds its source here, so each one also proves the
 * fallback calls the function as a method of `source`: the insecure-context path is the one this
 * leaf exists for, and a detached call would break it in the browser while Node stayed green.
 * `fill` does the work (a `vi.fn` where a case counts calls); `extra` adds other members.
 */
function receiverChecked(fill: Fill, extra: IdSource = {}): IdSource {
  const source: IdSource = {
    ...extra,
    getRandomValues(this: unknown, array) {
      if (this !== source) throw new TypeError("Illegal invocation: getRandomValues detached from its source");
      return fill(array);
    },
  };
  return source;
}
/** The insecure-context shape: a real CSPRNG, no `randomUUID`. */
const cspRng: Fill = (array) => webcrypto.getRandomValues(array);
const insecure = (): IdSource => receiverChecked(cspRng);
/** A fixed-byte source, so the fallback's exact output is known. */
const bytes = (fill: (i: number) => number): IdSource => receiverChecked(
  (array) => { for (let i = 0; i < array.length; i++) array[i] = fill(i); return array; },
);

class MemoryStorage implements Storage {
  private entries = new Map<string, string>();
  get length() { return this.entries.size; }
  clear() { this.entries.clear(); }
  key(index: number) { return [...this.entries.keys()][index] ?? null; }
  getItem(key: string) { return this.entries.get(key) ?? null; }
  setItem(key: string, value: string) { this.entries.set(key, value); }
  removeItem(key: string) { this.entries.delete(key); }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("newId (#348)", () => {
  it("uses the native randomUUID when present, called on its own receiver, and never the fallback", () => {
    // A browser `Crypto` throws "Illegal invocation" when `randomUUID` is detached from it, so the
    // stub refuses a call whose `this` is not the source.
    const getRandomValues = vi.fn();
    const source = {
      getRandomValues,
      randomUUID(this: unknown) {
        expect(this).toBe(source);
        return "native-value";
      },
    };
    expect(newId(source)).toBe("native-value");
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it("reads globalThis.crypto at call time, so a bare newId() takes the fallback in an insecure context", () => {
    // Exactly what a call site does in production: no argument. Stubbed AFTER the module loaded,
    // so a default captured at import time would still see Node's native randomUUID and fail here.
    const getRandomValues = vi.fn(cspRng);
    vi.stubGlobal("crypto", receiverChecked(getRandomValues));
    const id = newId();
    expect(id).toMatch(V4_UUID);
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });

  it("calls the fallback's getRandomValues on its own receiver, as a browser Crypto requires", () => {
    // The receiver checks in `receiverChecked` guard every fallback case; this one names the
    // rule, and pins that the check itself refuses a detached call rather than passing vacuously.
    const source = insecure();
    expect(newId(source)).toMatch(V4_UUID);
    const detached = source.getRandomValues!;
    expect(() => detached(new Uint8Array(16))).toThrow(/Illegal invocation/);
  });

  it.each([
    ["absent", {}],
    ["undefined", { randomUUID: undefined }],
    ["not a function", { randomUUID: "not callable" as unknown as () => string }],
  ])("falls back to getRandomValues when randomUUID is %s", (_label, shape) => {
    const getRandomValues = vi.fn(cspRng);
    const id = newId(receiverChecked(getRandomValues, shape));
    expect(getRandomValues).toHaveBeenCalledTimes(1);
    expect(getRandomValues.mock.calls[0][0]).toBeInstanceOf(Uint8Array);
    expect(getRandomValues.mock.calls[0][0]).toHaveLength(16);
    expect(id).toMatch(V4_UUID);
  });

  it("formats the fallback bytes as lowercase 8-4-4-4-12 hex with the version and variant bits set", () => {
    // The two extremes pin both halves of each mask: all-zero bytes prove the OR (a missing
    // version/variant bit would leave a 0), all-0xff bytes prove the AND (an unmasked byte would
    // leave an f). The exact strings also pin lowercase, which order-print-intent.ts's
    // case-sensitive storage-key pattern requires.
    expect(newId(bytes((i) => i))).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
    expect(newId(bytes(() => 0x00))).toBe("00000000-0000-4000-8000-000000000000");
    expect(newId(bytes(() => 0xff))).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    for (const id of [newId(bytes((i) => i)), newId(bytes(() => 0x00)), newId(bytes(() => 0xff))]) {
      expect(id).toMatch(V4_UUID);
    }
  });

  it("satisfies idempotent-save's V4_UUID on every fallback draw, so a stored nonce is kept rather than re-minted", () => {
    // Asserted against the consumer's own exported pattern, never a copy, so the two cannot drift.
    const source = insecure();
    for (let i = 0; i < 2000; i++) {
      const id = newId(source);
      expect(id).toMatch(V4_UUID);
      expect(id).toMatch(/^[0-9a-f-]{36}$/); // lowercase; V4_UUID itself is case-insensitive
      expect(normalizeRequestNonce(id)).toBe(id);
    }
  });

  it("mints order-print-intent keys that its own case-sensitive key pattern accepts back", () => {
    // order-print-intent.ts keeps its own lowercase key pattern, which this suite cannot import.
    // So it is held through the module's public round trip, on a bare newId() in an insecure
    // context, with fixed bytes covering all four variant nibbles and a real random run.
    const storage = new MemoryStorage();
    const intent: OrderPrintIntent = {
      version: 1, orderId: "order-1", selection: { mode: "all" }, expectedPrintFingerprint: "a".repeat(64),
    };
    const sources = [0x00, 0x5f, 0xaf, 0xff].map((b) => bytes(() => b));
    for (let i = 0; i < 50; i++) sources.push(insecure());
    const variants = new Set<string>();
    for (const source of sources) {
      vi.stubGlobal("crypto", source);
      const key = storeOrderPrintIntent(storage, intent);
      variants.add(key.slice(-17, -16));
      expect(takeOrderPrintIntent(storage, key, intent.orderId), key).toEqual(intent);
    }
    expect([...variants].sort()).toEqual(["8", "9", "a", "b"]);
  });

  it("sets the version nibble to 4 and the variant nibble to 8, 9, a or b across many draws", () => {
    const source = insecure();
    const variants = new Set<string>();
    for (let i = 0; i < 4000; i++) {
      const id = newId(source);
      expect(id[14]).toBe("4");
      expect("89ab").toContain(id[19]);
      variants.add(id[19]);
    }
    // Non-vacuous: the draws really exercised the variant range rather than one fixed value.
    expect([...variants].sort()).toEqual(["8", "9", "a", "b"]);
  });

  it("produces unique IDs across many fallback draws", () => {
    const source = insecure();
    const count = 20000;
    const seen = new Set<string>();
    for (let i = 0; i < count; i++) seen.add(newId(source));
    expect(seen.size).toBe(count);
  });

  it("fails loudly, naming both functions, when neither exists, and never uses Math.random", () => {
    const random = vi.spyOn(Math, "random");
    for (const source of [{}, { randomUUID: undefined, getRandomValues: undefined }]) {
      let thrown: unknown;
      try { newId(source); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("crypto.randomUUID");
      expect((thrown as Error).message).toContain("crypto.getRandomValues");
    }
    // The same refusal when a browser exposes no `crypto` object at all.
    vi.stubGlobal("crypto", undefined);
    expect(() => newId()).toThrow(/crypto\.randomUUID.*crypto\.getRandomValues/);
    // And the fallback path does not consult it either.
    newId(insecure());
    expect(random).not.toHaveBeenCalled();
  });
});
