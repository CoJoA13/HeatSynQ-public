import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Every route handler must authorize. A new route that forgets fails here, not in production. */
function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return entry === "route.ts" ? [full] : [];
  });
}

/** Every *.ts file under src, so a resurrected exception is caught even if no test targets it. */
function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return entry.endsWith(".ts") || entry.endsWith(".tsx") ? [full] : [];
  });
}

// A bare `.includes("requireUser")` matches the import line even when the call itself is
// never made (or is replaced by a fabricated user object) — proven by editing a route to keep
// the import but drop the call, which the old check let through silently. Requiring the actual
// invocation `requireUser()` closes that. Going further: every genuine call site in this
// codebase either feeds the result straight into `mustCan(...)`/`mustDo(...)` or binds it to a
// variable (`const user = requireUser()`), so require one of those two shapes rather than a
// bare, result-discarding `requireUser();` — cheap extra signal, not just "the token appears
// somewhere in the file". `\s*` (which matches newlines) keeps this from breaking if the call
// wraps across lines; it does not require any of it to be on one line.
const CALLS_REQUIRE_USER = /\b(?:mustCan|mustDo)\s*\(\s*requireUser\(\)|=\s*requireUser\(\)/;

// Same class of gap as above: a bare `.includes("mustCan")` matches an unused import. Require
// the actual call.
const CALLS_PERMISSION_GATE = /\b(?:mustCan|mustDo)\s*\(/;

const EXTERNAL_RECIPE_ROUTE = join(process.cwd(),
  "src/app/api/external/orders/[orderNumber]/loads/[loadNumber]/route.ts");
// #319 has a distinct integration credential: the session wrapper would refresh a session,
// violating the endpoint's no-write contract. Recognize only this route and a bound gate CALL,
// never its import or the entire external tree. external-load-route.test.ts proves denial
// before DB initialization (including a fresh-process trap and guard-removal mutation).
function callsExternalRecipeGate(file: string, source: string): boolean {
  return file === EXTERNAL_RECIPE_ROUTE
    && /\bconst\s+access\s*=\s*authorizeExternalRecipeRead\s*\(\s*request\s*\)/.test(source);
}

const CALLS_MUTATION = /\.(create|update|upsert|delete)(Many)?\s*\(/;
const CRYPTO_DIGEST_MODULES = new Set([
  "external-recipe-auth.ts",
  "order-entry-preview.ts",
  "traveler-identity.ts",
]);
function auditSweepSource(file: string, source: string): string {
  // These modules use Node crypto Hash.update for credential/preview/print digests.
  // Strip only that exact method token, never its arguments: a Prisma mutation
  // beside the hash or nested inside its input must remain visible to the sweep.
  return CRYPTO_DIGEST_MODULES.has(file)
    ? source.replace(/(\bcreateHash\("sha256"\))\.update(?=\()/g, "$1")
    : source;
}

describe("permission sweep", () => {
  it("every API route calls requireUser or its classified integration gate", () => {
    const offenders = routeFiles(join(process.cwd(), "src/app/api"))
      .filter((f) => {
        const source = readFileSync(f, "utf8");
        return !CALLS_REQUIRE_USER.test(source) && !callsExternalRecipeGate(f, source);
      })
      // The health probe and login are deliberately public. So is logout: it must clear a
      // stale cookie even when the session behind it has already expired or is invalid, so
      // gating it on requireUser would leave that cookie stuck client-side on a 401 instead
      // of being cleared — the same "must work without a prior valid session" reasoning that
      // exempts login.
      .filter((f) => !f.includes("api/health") && !f.includes("api/auth/login") && !f.includes("api/auth/logout"));
    expect(offenders).toEqual([]);
  });

  it("does not extend the integration classification to imports or new routes", () => {
    const call = "const access = authorizeExternalRecipeRead(request);";
    expect(callsExternalRecipeGate(EXTERNAL_RECIPE_ROUTE, call)).toBe(true);
    expect(callsExternalRecipeGate(EXTERNAL_RECIPE_ROUTE,
      'import { authorizeExternalRecipeRead } from "@/server/external-recipe-auth";')).toBe(false);
    expect(callsExternalRecipeGate(EXTERNAL_RECIPE_ROUTE,
      "authorizeExternalRecipeRead(request);")).toBe(false);
    expect(callsExternalRecipeGate(join(process.cwd(), "src/app/api/external/other/route.ts"), call))
      .toBe(false);
  });

  const digestModules = ["external-recipe-auth.ts", "order-entry-preview.ts", "traveler-identity.ts"];
  const prismaWrites = [
    "tx.part.create({ data })",
    "db.part.createMany({ data })",
    "tx.part.update({ where: { id }, data })",
    "db.part.updateMany({ where, data })",
    "delegate(kind).upsert({ where, create, update })",
    "tx.part.delete({ where: { id } })",
    "db.part.deleteMany({ where })",
  ];

  it.each(digestModules)("classifies only the digest method in %s", (file) => {
    for (const input of ["value", "canonicalPrintExpectation(input)", "JSON.stringify({ lines, limits })"]) {
      const source = `createHash("sha256").update(${input}).digest("hex")`;
      const classified = auditSweepSource(file, source);
      expect(classified).toContain(input);
      expect(CALLS_MUTATION.test(classified)).toBe(false);
    }
  });

  it.each(digestModules)("keeps adjacent aliased Prisma writes visible in %s", (file) => {
    const digest = 'createHash("sha256").update(value).digest();';
    for (const write of prismaWrites) {
      for (const source of [`${write};\n${digest}`, `${digest}\n${write};`]) {
        const classified = auditSweepSource(file, source);
        expect(classified).toContain(write);
        expect(CALLS_MUTATION.test(classified)).toBe(true);
      }
    }
  });

  it.each(digestModules)("keeps Prisma writes inside nested digest inputs visible in %s", (file) => {
    for (const write of prismaWrites) {
      const source = `createHash("sha256").update(JSON.stringify({ result: createHash("sha256").update(await ${write}).digest("hex") })).digest("hex")`;
      const classified = auditSweepSource(file, source);
      expect(classified).toContain(write);
      expect(CALLS_MUTATION.test(classified)).toBe(true);
    }
  });

  it("does not classify digest methods in unknown modules", () => {
    const digest = 'createHash("sha256").update(value).digest();';
    for (const file of ["unclassified-auth.ts", "other-preview.ts", "other-traveler-identity.ts"]) {
      expect(auditSweepSource(file, digest)).toBe(digest);
      expect(CALLS_MUTATION.test(auditSweepSource(file, digest))).toBe(true);
    }
  });

  it("does not classify other update receivers in registered digest modules", () => {
    for (const file of digestModules) {
      for (const source of ['createHash("sha512").update(value)', 'hash.update(value)', 'delegate(kind).update({ data })']) {
        expect(auditSweepSource(file, source)).toBe(source);
        expect(CALLS_MUTATION.test(auditSweepSource(file, source))).toBe(true);
      }
    }
  });

  it("every admin route gates on a permission", () => {
    const offenders = routeFiles(join(process.cwd(), "src/app/api/admin"))
      .filter((f) => !CALLS_PERMISSION_GATE.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  // Task 16: every invoicing route (money-adjacent, not under api/admin) also gates on a
  // permission — the same structural check as the admin sweep above, walked over both trees a
  // route can land under (src/app/api/invoices/** and the order-scoped
  // src/app/api/orders/[id]/invoices route). A route that slips through with only `requireUser()`
  // and no `mustCan`/`mustDo` fails here, not in production.
  it("every invoicing route gates on a permission", () => {
    const offenders = [
      ...routeFiles(join(process.cwd(), "src/app/api/invoices")),
      ...routeFiles(join(process.cwd(), "src/app/api/orders/[id]/invoices")),
    ].filter((f) => !CALLS_PERMISSION_GATE.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("no client component imports from src/server", () => {
    function tsx(dir: string): string[] {
      return readdirSync(dir).flatMap((e) => {
        const full = join(dir, e);
        if (statSync(full).isDirectory()) return tsx(full);
        return e.endsWith(".tsx") ? [full] : [];
      });
    }
    const offenders = [...tsx(join(process.cwd(), "src/components")), ...tsx(join(process.cwd(), "src/app"))]
      .filter((f) => { const s = readFileSync(f, "utf8"); return s.includes('"use client"') && /from "@\/server\//.test(s); });
    expect(offenders).toEqual([]);
  });

  // Task 4 retired settings.ts's documented exception to writing prisma.auditLog.create
  // directly; audit.ts is now the sole writer. This keeps that invariant from quietly
  // regressing — a new caller bypassing audit.ts would fail here, not in a missed audit trail.
  it("only src/server/audit.ts calls prisma.auditLog.create", () => {
    const offenders = tsFiles(join(process.cwd(), "src"))
      .filter((f) => !f.endsWith(join("src", "server", "audit.ts")))
      .filter((f) => readFileSync(f, "utf8").includes("prisma.auditLog.create"));
    expect(offenders).toEqual([]);
  });

  it("no service mutates Prisma outside an audit helper", () => {
    // Services call prisma.<model>.create/update INSIDE an audited* callback, so requiring an
    // audit* call somewhere in the same file is the cheap structural proxy. Pattern must match
    // auditSettingChange too — settings.ts upserts and audits through that helper, not audited*.
    // The mutation pattern deliberately does NOT require the literal token "prisma." — services
    // route through aliases too (customer-addresses.ts mutates via `db.customerAddress.*` and
    // `tx.customerAddress.*` inside a transaction; reference.ts mutates via `delegate(kind).*`,
    // with zero literal "prisma." occurrences in the file). Anchoring on "prisma." would make the
    // check vacuous for exactly the files that use those idioms — it would never see the mutation
    // at all, audited or not. Matching the method name regardless of receiver closes that.
    //
    // KNOWN LIMIT: this is a file-level proxy, not a call-level check. It only asks "does this
    // file contain a mutation call somewhere AND an audit call somewhere" — it does not tie a
    // specific mutation to the audit call guarding it. A service that mixes one audited mutation
    // and one unaudited mutation in the same file passes. That's an accepted gap: cheap enough to
    // catch a service written with zero audit discipline (the realistic failure mode when a new
    // service file is added and audit is simply forgotten), not a substitute for reviewing each
    // mutation individually.
    const EXCEPT = new Set([
      "audit.ts",    // owns the helpers; legitimately writes audit rows itself
      "db.ts",       // the client
      // sessions.ts: the sliding expiry, logout's delete and sign-in's sweep of the user's sessions
      // expired over a day ago (R27, #718) are not business mutations and write no audit row
      "sessions.ts",
      // order-drafts.ts — THE documented unaudited exception (design spec §4, Phase 3): drafts
      // are pre-entity scratch, the real order save is the audited event, and auditing a 2s
      // autosave cadence would flood the log with junk. Full authorization quote in the file's
      // own header comment.
      "order-drafts.ts",
      // practice-seed.ts (Phase 8B §5.3) — reseedSingletons RESTORES the by-construction singletons
      // + the eight Standard templates after a truncate (tests' truncateAll and the practice reset).
      // A truncate/reseed writes no audit trail by design — it is a reset to a valid baseline, not an
      // acknowledged history (§5.3 states this explicitly); it is the non-test-only home of exactly
      // the re-seed truncateAll always performed unaudited.
      "practice-seed.ts",
      // order-internals.ts (#33) — the SHARED support layer of the order services. Its only mutation
      // is `createSerials`' `tx.orderSerial.createMany`, and it is ALWAYS part of an order create or
      // update that the CALLER audits: `saveNewOrder` (order-create.ts) captures the serials in its
      // `auditedCreate` payload, and `addLine` (order-edit.ts) calls it INSIDE its `auditedUpdate`
      // callback. This file-level proxy cannot follow that cross-file call, so it would false-flag a
      // helper module that holds no `audited*` call of its own — the mutation IS audited, just not in
      // this file. (Before #33 the same write lived in orders.ts beside the audit wrappers, so the
      // proxy passed; the decomposition moved the shared writer out, not the audit discipline.)
      "order-internals.ts",
      // recipe-snapshots.ts (#319) — captureRecipeSnapshot is called only from lockRevision's
      // auditedUpdate("partProcessRevision", ...) callback in part-process-steps.ts, using the
      // same transaction. Its revision snapshot update is captured in that audit payload;
      // recipeSnapshotField.createMany is the snapshot's derived semantic-guard membership.
      // recipe-snapshots.test.ts covers capture audit and transaction rollback. This is the
      // same caller-audited helper boundary as order-internals.ts, not an unaudited write.
      "recipe-snapshots.ts",
    ]);
    const offenders = readdirSync(join(process.cwd(), "src/server"))
      .filter((f) => f.endsWith(".ts") && !EXCEPT.has(f))
      .filter((f) => {
        const source = readFileSync(join(process.cwd(), "src/server", f), "utf8");
        const s = auditSweepSource(f, source);
        const mutates = CALLS_MUTATION.test(s);
        const audits = /\baudit(ed)?[A-Z][A-Za-z]*\s*\(/.test(s);
        return mutates && !audits;
      });
    expect(offenders).toEqual([]);
  });
});
