import { describe, it, expect, beforeEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Prisma } from "../prisma/generated/prisma/client";
import { prisma, truncateAll } from "./helpers/db";
import {
  withDbErrors, translatePrisma, retryOnSerializationConflict, isExpiredTransaction,
} from "@/server/db-errors";
import { HttpError } from "@/server/errors";
import { createRole, renameRole } from "@/server/roles";

describe("db error hygiene", () => {
  beforeEach(async () => await truncateAll());

  it("maps a unique violation to 400", async () => {
    await prisma.role.create({ data: { name: "Office" } });
    const boom = withDbErrors({ entity: "Role", conflictField: "name" }, () =>
      prisma.role.create({ data: { name: "Office" } }));
    await expect(boom).rejects.toThrow(HttpError);
    await expect(boom).rejects.toMatchObject({ status: 400 });
  });

  it("maps a missing record to 404", async () => {
    const boom = withDbErrors({ entity: "Role" }, () =>
      prisma.role.update({ where: { id: "does-not-exist" }, data: { name: "x" } }));
    await expect(boom).rejects.toMatchObject({ status: 404, message: "Role not found" });
  });

  // A serialization failure raised by a RAW query arrives as P2010 with the SQLSTATE buried in
  // the driver adapter's error, not as the P2034 a client-API call would produce. Same condition,
  // so it must reach the same 409 — without this it escaped as a 500. Reached in anger by
  // workingRevision's `SELECT … FOR UPDATE` (part-process-steps.ts), which is the only raw query
  // in the app that can lose a serialization race.
  it("maps a raw query's serialization failure to 409, same as P2034", async () => {
    const rawConflict = Object.assign(
      new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `40001`.", {
        code: "P2010", clientVersion: "test",
        meta: {
          driverAdapterError: {
            name: "DriverAdapterError",
            cause: { originalCode: "40001", kind: "TransactionWriteConflict" },
          },
        },
      }), {});

    expect(() => translatePrisma(rawConflict, { entity: "Process step" }))
      .toThrow(expect.objectContaining({ status: 409 }));
  });

  // #90: a deadlock victim (SQLSTATE 40P01) is the same condition one notch over — the transaction
  // was aborted, nothing was written, and a re-run is safe — so it gets the same 409 instead of
  // escaping as a 500. Raw queries wrap it as P2010 exactly like 40001.
  it("maps a raw query's deadlock failure (40P01) to 409, same as a serialization failure", async () => {
    const rawDeadlock = new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `40P01`.", {
      code: "P2010", clientVersion: "test",
      meta: {
        driverAdapterError: {
          name: "DriverAdapterError",
          cause: { originalCode: "40P01", kind: "TransactionWriteConflict" },
        },
      },
    });
    expect(() => translatePrisma(rawDeadlock, { entity: "Shipment" }))
      .toThrow(expect.objectContaining({ status: 409 }));
  });

  it("leaves a raw query failure that is not a serialization conflict alone", async () => {
    const otherRaw = new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `42703`.", {
      code: "P2010", clientVersion: "test",
      meta: { driverAdapterError: { cause: { originalCode: "42703" } } },
    });
    expect(() => translatePrisma(otherRaw, { entity: "Process step" })).toThrow(otherRaw);
  });

  it("lets unrelated errors through untouched", async () => {
    const boom = withDbErrors({ entity: "Role" }, async () => { throw new Error("kaboom"); });
    await expect(boom).rejects.toThrow("kaboom");
    await expect(boom).rejects.not.toBeInstanceOf(HttpError);
  });

  it("renameRole on a bogus id is a 404, not a 500", async () => {
    await expect(renameRole("nope", "Whatever")).rejects.toMatchObject({ status: 404 });
  });

  it("createRole survives a concurrent duplicate insert", async () => {
    const results = await Promise.allSettled([createRole("Race"), createRole("Race")]);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(HttpError);
    expect(await prisma.role.count({ where: { name: "Race" } })).toBe(1);
  });
});

// #40: on the Prisma 7 + @prisma/adapter-pg stack a P2002 carries NO `meta.target` and a P2003
// carries NO `meta.constraint` — the answer lives in `meta.driverAdapterError.cause.constraint`
// ({ fields } for 23505, { index } for 23503), with mixed-case identifiers arriving wrapped in
// literal double quotes (parsed from Postgres' DETAIL line). These tests pin the extraction:
// three through the real DB (the measured shapes), two synthetic (legacy-first ordering and the
// never-throws fallback). The legacy `meta.target` synthetic in the #90 describe below stays as
// the legacy-shape regression alongside these.
describe("P2002/P2003 field extraction on the driver-adapter stack (#40)", () => {
  beforeEach(async () => await truncateAll());

  it("names the conflicting field on a real P2002 without conflictField (Role.name)", async () => {
    await prisma.role.create({ data: { name: "Office" } });
    const boom = withDbErrors({ entity: "Role" }, () =>
      prisma.role.create({ data: { name: "Office" } }));
    await expect(boom).rejects.toMatchObject({
      status: 400, message: "A role with that name already exists",
    });
  });

  // Mixed-case identifiers arrive from the adapter as '"tokenHash"' — literal embedded double
  // quotes, parsed straight out of Postgres' DETAIL line. The extractor must strip them or the
  // user sees `that "tokenHash"`.
  it("strips the adapter's embedded quotes on a camelCase P2002 (Session.tokenHash)", async () => {
    const user = await prisma.user.create({
      data: { username: "u1", passwordHash: "x", displayName: "U One" },
    });
    const expiresAt = new Date(Date.now() + 3_600_000);
    await prisma.session.create({ data: { tokenHash: "tok-1", userId: user.id, expiresAt } });
    const boom = withDbErrors({ entity: "Session" }, () =>
      prisma.session.create({ data: { tokenHash: "tok-1", userId: user.id, expiresAt } }));
    await expect(boom).rejects.toMatchObject({ status: 400 });
    const message = await boom.catch((e: HttpError) => e.message);
    expect(message).toContain("tokenHash");
    expect(message).not.toContain('"');
  });

  // Calls the delegate directly: the service path (`createReference` → `assertRefExists`)
  // pre-checks the FK and would 400 before the constraint ever fires. The constraint is the
  // race-path backstop, and its message should name the field just like the pre-check does.
  it("names the missing reference on a real P2003 (PaymentType.glAccountId)", async () => {
    const boom = withDbErrors({ entity: "Payment type" }, () =>
      prisma.paymentType.create({ data: { name: "Check", glAccountId: "nope" } }));
    await expect(boom).rejects.toMatchObject({
      status: 400, message: "That gl account does not exist",
    });
  });

  // Legacy-first ordering (the isDuplicateClientRequestId precedent, orders.ts): `meta.target` /
  // `meta.constraint` are consulted BEFORE the adapter shape, so a future adapter that populates
  // them wins even when the driver-adapter cause disagrees.
  it("prefers the legacy meta shapes over the adapter shape (synthetic)", () => {
    const legacyP2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002", clientVersion: "test",
      meta: {
        target: ["name"],
        driverAdapterError: { cause: { constraint: { fields: ['"somethingElse"'] } } },
      },
    });
    expect(() => translatePrisma(legacyP2002, { entity: "Role" }))
      .toThrow(expect.objectContaining({ status: 400, message: "A role with that name already exists" }));

    const legacyStringTarget = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002", clientVersion: "test", meta: { target: "name" },
    });
    expect(() => translatePrisma(legacyStringTarget, { entity: "Role" }))
      .toThrow(expect.objectContaining({ status: 400, message: "A role with that name already exists" }));

    const legacyP2003 = new Prisma.PrismaClientKnownRequestError("FK constraint failed", {
      code: "P2003", clientVersion: "test",
      meta: {
        constraint: "PaymentType_glAccountId_fkey", modelName: "PaymentType",
        driverAdapterError: { cause: { constraint: { index: "PaymentType_nopeId_fkey" } } },
      },
    });
    expect(() => translatePrisma(legacyP2003, { entity: "Payment type" }))
      .toThrow(expect.objectContaining({ status: 400, message: "That gl account does not exist" }));
  });

  // Prisma 7.10.0's pg adapter replaced `constraint: { fields: ["name"] }` with
  // `constraint: { index: "Role_name_key" }`, which silently degraded EVERY unique-violation
  // message in the app from "with that name" to "with that value". The two real-error tests above
  // caught it on the bump; these pin the parse itself, so the branch cannot rot back out on a
  // stack where the adapter happens to send the older shape.
  it("reads the field out of the 7.10.0 index name (synthetic)", () => {
    const indexShape = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002", clientVersion: "test",
      meta: {
        modelName: "Role",
        driverAdapterError: { cause: { constraint: { index: "Role_name_key" } } },
      },
    });
    expect(() => translatePrisma(indexShape, { entity: "Role" }))
      .toThrow(expect.objectContaining({ message: "A role with that name already exists" }));
  });

  it("reads every column of a COMPOSITE unique out of the index name (synthetic)", () => {
    // `ClosePeriod_year_month_key` and its kind are real on this schema, and the caller joins the
    // list — so a composite must not collapse to one column or to "value".
    const composite = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002", clientVersion: "test",
      meta: {
        modelName: "ClosePeriod",
        driverAdapterError: { cause: { constraint: { index: "ClosePeriod_year_month_key" } } },
      },
    });
    expect(() => translatePrisma(composite, { entity: "Close period" }))
      .toThrow(expect.objectContaining({ message: "A close period with that year, month already exists" }));
  });

  it("falls back to the driver's message when even the index is missing (synthetic)", () => {
    // The last resort, and the one that carried `isDuplicateClientRequestId` unharmed through the
    // 7.10.0 change while `constraint.fields` disappeared underneath it.
    const messageOnly = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002", clientVersion: "test",
      meta: {
        modelName: "Session",
        driverAdapterError: {
          cause: {
            originalCode: "23505",
            originalMessage: 'duplicate key value violates unique constraint "Session_tokenHash_key"',
          },
        },
      },
    });
    expect(() => translatePrisma(messageOnly, { entity: "Session" }))
      .toThrow(expect.objectContaining({ message: "A session with that tokenHash already exists" }));
  });

  it("refuses to guess at an index name that does not follow the convention (synthetic)", () => {
    // A hand-named index, or one whose model does not prefix it, must fall through to "value"
    // rather than yield a nonsense column — the parse guesses at nothing.
    for (const index of ["some_hand_named_thing", "Role_name_idx", "Different_name_key"]) {
      const odd = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002", clientVersion: "test",
        meta: { modelName: "Role", driverAdapterError: { cause: { constraint: { index } } } },
      });
      expect(() => translatePrisma(odd, { entity: "Role" }), index)
        .toThrow(expect.objectContaining({ message: "A role with that value already exists" }));
    }
  });

  it("...and the convention actually holds on this schema", () => {
    // The parse splits on `_`, so a column containing an underscore would silently yield two
    // columns. `uniqueConflictFields`'s docstring claims that cannot happen here; this is the
    // claim, checked against the real migrations rather than believed.
    const dir = fileURLToPath(new URL("../prisma/migrations", import.meta.url));
    const names = readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith("migration.sql"))
      .flatMap((f) => [...readFileSync(join(dir, f), "utf8")
        .matchAll(/CREATE UNIQUE INDEX(?: IF NOT EXISTS)? "([^"]+)"/g)].map((m) => m[1]));
    expect(names.length, "found no unique indexes — the glob is wrong, not the schema")
      .toBeGreaterThan(40);
    const unconventional = [...new Set(names)]
      .filter((n) => !/^[A-Za-z]+(?:_[a-zA-Z][a-zA-Z0-9]*)+_key$/.test(n))
      .sort();
    expect(unconventional, "a unique index whose name the P2002 parse cannot read").toEqual([]);
  });

  // The adapter omits `constraint` entirely when Postgres sends no DETAIL line — the extractor
  // must fall back to "value", never throw.
  it("falls back to 'value' on a P2002 with neither shape (synthetic)", () => {
    const bare = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002", clientVersion: "test", meta: { modelName: "Role" },
    });
    expect(() => translatePrisma(bare, { entity: "Role" }))
      .toThrow(expect.objectContaining({ status: 400, message: "A role with that value already exists" }));

    const noDetail = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002", clientVersion: "test",
      meta: { modelName: "Role", driverAdapterError: { cause: { originalCode: "23505" } } },
    });
    expect(() => translatePrisma(noDetail, { entity: "Role" }))
      .toThrow(expect.objectContaining({ status: 400, message: "A role with that value already exists" }));
  });
});

// #90: the retry wrapper's scope. A P2002 is only a losing-Serializable-writer shape at ONE call
// site (closePeriod's year-month insert race); the allocation paths answer nonce P2002s by
// in-attempt replay and never retry (#115). Constraint discrimination IS possible since #40
// (`uniqueConflictFields` reads the adapter shape), but whether a P2002 means "a concurrent
// writer won — a re-run will see its row" is a fact about the call site's own insert semantics,
// not about which constraint fired — so the unique-conflict retry stays a per-call opt-in
// boolean, default off. Deadlock victims (40P01) join 40001 as always-retryable.
describe("retryOnSerializationConflict scope (#90)", () => {
  const p2002 = () => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002", clientVersion: "test", meta: { target: ["year", "month"] },
  });
  const rawDeadlock = () => new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `40P01`.", {
    code: "P2010", clientVersion: "test",
    meta: { driverAdapterError: { cause: { originalCode: "40P01" } } },
  });

  it("throws a P2002 on attempt 1 through the DEFAULT path — the unique retry is opt-in", async () => {
    let calls = 0;
    await expect(retryOnSerializationConflict(async () => { calls += 1; throw p2002(); }, 5))
      .rejects.toMatchObject({ code: "P2002" });
    expect(calls).toBe(1);
  });

  it("retries a P2002 up to `tries` through the opt-in path (closePeriod's year-month race)", async () => {
    let calls = 0;
    await expect(retryOnSerializationConflict(
      async () => { calls += 1; throw p2002(); }, 3, { retryUniqueConflict: true },
    )).rejects.toMatchObject({ code: "P2002" });
    expect(calls).toBe(3);
  });

  it("absorbs a raw deadlock victim (40P01) when the re-run succeeds", async () => {
    let calls = 0;
    const result = await retryOnSerializationConflict(async () => {
      calls += 1;
      if (calls === 1) throw rawDeadlock();
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });
});

// #521 (owner ruling 2026-10-17): a traveler print whose claim expires, its 15-second budget spent
// before its last statement or its commit, is refused with the owner's sentence, and so is a shipping
// ticket print (#556, owner ruling 2026-10-18). `isExpiredTransaction` is the recognizer written for
// those two prints' catches: it must answer yes to Prisma's expired-transaction P2028 and no to every
// other P2028. The real cases run the installed runtime (a 50 ms timeout passed by a 200 ms delay),
// so a Prisma bump that changes the error's shape fails here. (h) pins the one known miss.
describe("isExpiredTransaction (#521)", () => {
  beforeEach(async () => await truncateAll());

  /** The query-phase expiry, as the installed runtime raises it. */
  const expiredAtQuery = (): Promise<unknown> =>
    prisma.$transaction(async (tx) => {
      await delay(200);
      await tx.role.count();
    }, { timeout: 50 }).catch((e: unknown) => e);

  const known = (err: unknown): Prisma.PrismaClientKnownRequestError => {
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    return err as Prisma.PrismaClientKnownRequestError;
  };

  const constructed = (message: string, code: string, meta: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: "test", meta });

  it("(a) recognises the expiry at a query, as the installed runtime raises it", async () => {
    const err = known(await expiredAtQuery());
    expect(err.code).toBe("P2028");
    expect(err.meta).toMatchObject({
      modelName: "Role", operation: "query", timeout: 50, timeTaken: expect.any(Number),
    });
    expect(err.message).toMatch(/A query cannot be executed on an expired transaction/);
    expect(isExpiredTransaction(err)).toBe(true);
  });

  it("(b) recognises the expiry at the commit, which names no model", async () => {
    const err = known(await prisma.$transaction(async () => {
      await delay(200);
    }, { timeout: 50 }).catch((e: unknown) => e));
    expect(err.code).toBe("P2028");
    expect(err.meta).toMatchObject({ operation: "commit", timeout: 50 });
    expect(err.meta).not.toHaveProperty("modelName");
    expect(isExpiredTransaction(err)).toBe(true);
  });

  it("(c) does not take a transaction client used after its commit for an expiry", async () => {
    const held: { tx?: Prisma.TransactionClient } = {};
    await prisma.$transaction(async (tx) => { held.tx = tx; });
    const err = known(await held.tx?.role.count().catch((e: unknown) => e));
    expect(err.code).toBe("P2028");
    expect(err.message).toMatch(/cannot be executed on a committed transaction/);
    expect(err.meta).toMatchObject({ modelName: "Role" });
    expect(err.meta).not.toHaveProperty("timeout");
    expect(isExpiredTransaction(err)).toBe(false);
  });

  it("(d) does not take a transaction client used after its callback threw for an expiry", async () => {
    const held: { tx?: Prisma.TransactionClient } = {};
    await prisma.$transaction(async (tx) => {
      held.tx = tx;
      throw new Error("the callback fails, so the transaction rolls back");
    }).catch(() => undefined);
    const err = known(await held.tx?.role.count().catch((e: unknown) => e));
    expect(err.code).toBe("P2028");
    expect(err.message).toMatch(/cannot be executed on a transaction that was rolled back/);
    expect(err.meta).toMatchObject({ modelName: "Role" });
    expect(err.meta).not.toHaveProperty("timeout");
    expect(isExpiredTransaction(err)).toBe(false);
  });

  it("(e) does not take any other failure for an expiry", () => {
    const expiredText = "Transaction API error: A query cannot be executed on an expired transaction. "
      + "The timeout for this transaction was 15000 ms, however 21840 ms passed since the start of the "
      + "transaction. Consider increasing the interactive transaction timeout or doing less work in the "
      + "transaction.";
    const others: [string, unknown][] = [
      ["P2028, start timeout",
        constructed("Transaction API error: Unable to start a transaction in the given time.", "P2028", {})],
      ["P2028, not found",
        constructed("Transaction API error: Transaction not found. Transaction ID is invalid, refers to an "
          + "old closed transaction Prisma doesn't have information about anymore, or was obtained before "
          + "disconnecting.", "P2028", {})],
      ["P2034",
        constructed("Transaction failed due to a write conflict or a deadlock. Please retry your "
          + "transaction", "P2034", {})],
      ["P2010, 40001",
        constructed("Raw query failed. Code: `40001`.", "P2010",
          { driverAdapterError: { cause: { originalCode: "40001" } } })],
      // The meta branch needs both keys, and the code is checked before either branch.
      ["P2028, timeout alone", constructed("An unrelated message", "P2028", { timeout: 15000 })],
      ["P2028, timeTaken alone", constructed("An unrelated message", "P2028", { timeTaken: 21840 })],
      ["P2034 carrying the expiry's meta and message",
        constructed(expiredText, "P2034", { timeout: 15000, timeTaken: 21840 })],
      ["a plain Error", new Error(expiredText)],
      // A lookalike carrying the code and meta of the real thing, so the `instanceof` guard is what
      // refuses it.
      ["a plain Error shaped like the real one",
        Object.assign(new Error(expiredText), { code: "P2028", meta: { timeout: 15000, timeTaken: 21840 } })],
    ];
    // Every verdict at once, so a failure names every input taken for an expiry.
    expect(Object.fromEntries(others.map(([name, err]) => [name, isExpiredTransaction(err)])))
      .toEqual(Object.fromEntries(others.map(([name]) => [name, false])));
  });

  it("(f) recognises the expiry by its meta alone, whatever the message says", () => {
    const metaOnly = constructed("An unrelated message", "P2028", { timeout: 15000, timeTaken: 21840 });
    expect(isExpiredTransaction(metaOnly)).toBe(true);
  });

  it("(f) recognises the expiry by its message alone, with the callsite prefix", () => {
    const messageOnly = constructed(
      "\nInvalid `tx.storedDocument.create()` invocation:\n\nTransaction API error: A query cannot be "
        + "executed on an expired transaction. The timeout for this transaction was 15000 ms, however "
        + "21840 ms passed since the start of the transaction. Consider increasing the interactive "
        + "transaction timeout or doing less work in the transaction.",
      "P2028", {});
    expect(isExpiredTransaction(messageOnly)).toBe(true);
  });

  it("(g) leaves translatePrisma and withDbErrors answering an expiry as before", async () => {
    const err = known(await expiredAtQuery());
    expect(isExpiredTransaction(err)).toBe(true);
    let thrown: unknown;
    try {
      translatePrisma(err, { entity: "Order" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(err);
    await expect(withDbErrors({ entity: "Order" }, () => Promise.reject(err))).rejects.toBe(err);
  });

  // Prisma keeps the last 100 closed transactions. Once 100 more close after the timer has run, the
  // expired one is gone from that list (the loop runs 101, one for margin), so its next query reads
  // "Transaction not found": not recognised, and a 500 where it is raised. Today's behaviour, pinned
  // as the known limit. (h) alone of these cases depends on the timer's ROLLBACK landing before the
  // loop starts: Prisma records the expired transaction as closed only once its ROLLBACK returns,
  // and it does not hold other transactions behind it, so a loop close recorded before it does not
  // count toward the 100. The 200 ms delay gives the ROLLBACK about 150 ms after the 50 ms timeout.
  it("(h) does not recognise an expiry Prisma has already forgotten", async () => {
    const err = known(await prisma.$transaction(async (tx) => {
      await delay(200);
      for (let i = 0; i < 101; i++) await prisma.$transaction(async () => undefined);
      await tx.role.count();
    }, { timeout: 50 }).catch((e: unknown) => e));
    expect(err.code).toBe("P2028");
    expect(err.message).toMatch(/Transaction not found/);
    expect(err.meta).not.toHaveProperty("timeout");
    expect(isExpiredTransaction(err)).toBe(false);
  });
});
