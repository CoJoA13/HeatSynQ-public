// Client-safe: no src/server imports (CLAUDE.md: a client component pulling from there drags
// node:async_hooks and Prisma into the browser bundle). Deliberately no "use client" directive
// either: this is a plain shared function, and the directive would turn it into a client reference
// if a server component ever imported it.
//
// #348. Browsers expose `crypto.randomUUID()` ONLY in a secure context: HTTPS, or a loopback origin
// (`localhost`, `127.0.0.1`). Browsed over plain HTTP by LAN address or hostname, which is how the
// RC12 test installation is reached, it is `undefined`, and every client call site threw a
// `TypeError` on its first line. Add step silently did nothing on a part, and so did most editors.
// `crypto.getRandomValues()` has no such restriction, so the fallback builds the same RFC 4122
// version 4 UUID from it. Measured on 2026-09-25 in Playwright's Chromium
// (1.63.0 / chromium-1243): the production install's plain-HTTP LAN address (`.182`) had
// `isSecureContext === false`, `randomUUID === undefined` and `getRandomValues` present.
//
// Every E2E flow and `manual:capture` browse `http://localhost`, a secure context, and vitest runs
// in Node, where `randomUUID` always exists. So no gate could see the bug, which is why
// `tests/client-random-uuid-sweep.test.ts` refuses a direct `randomUUID` reference anywhere in
// `src/` outside `src/server/**` and this file, and `e2e/flows/insecure-origin.mjs` drives the
// reported controls on a real non-loopback HTTP origin.

/** What `newId` reads from a Web Crypto implementation. Both members are optional because an
 *  insecure browser context omits the first one, and a test passes a partial stub. */
export type IdSource = {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array<ArrayBuffer>) => unknown;
};

/**
 * A fresh RFC 4122 version 4 UUID, lowercase, in 8-4-4-4-12 form: exactly what
 * `crypto.randomUUID()` returns.
 *
 * The shape is load-bearing, not cosmetic. These values are idempotency keys and client row
 * identities, and stored ones are validated when read back: a draft's nonce against
 * `idempotent-save.ts`'s `V4_UUID`, which `new-shipment-recovery.ts` imports rather than copies,
 * and a print handoff's storage key against `order-print-intent.ts`'s own pattern, which is
 * case-SENSITIVE lowercase. `tests/client-id.test.ts` holds the fallback to `V4_UUID` directly and
 * to the storage-key pattern through that module's own store-and-take round trip.
 *
 * The native function is preferred whenever it exists. The fallback is used only when it does not.
 * If neither exists, this THROWS rather than reaching for `Math.random`: a colliding idempotency
 * key merges two operator actions into one server write, which is worse than a visible failure.
 *
 * `source` defaults to `globalThis.crypto`, read at CALL time, so every call site stays a bare
 * `newId()` and a test can inject a stub. Both functions are called as methods of `source`.
 * Browsers throw "Illegal invocation" if either is detached from its `Crypto` receiver.
 */
export function newId(source: IdSource | undefined = globalThis.crypto): string {
  if (typeof source?.randomUUID === "function") return source.randomUUID();
  if (typeof source?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    source.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4: the high nibble of time_hi_and_version
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx: the two high bits of clock_seq_hi
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error(
    "Cannot create a client ID: neither crypto.randomUUID nor crypto.getRandomValues is available " +
    "in this browser. Refusing to fall back to a non-cryptographic source for an idempotency key.",
  );
}
