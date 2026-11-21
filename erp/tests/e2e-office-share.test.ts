// #588: the E2E harness's own office share, the BACKUP_DIR precedent. invoice-shipped-order files a
// finalized print into a customer's folder on it, so the server must be handed the harness's share
// in both server modes, over any share a developer's own environment names, and the flow must be
// handed the same two values. Production mode reads `.env` here (`serverEnv`), so its case shows
// the harness's share winning over that file's too. Dev mode reads no `.env` here: `next dev` loads
// it itself, through `@next/env`, which keeps a value the process environment already holds, so
// there the harness's share wins over `.env` by Next's rule, which this file does not exercise.
// Setup, teardown and their order are pinned in tests/e2e-cancellation.test.ts; this file holds
// what the server and the flows are given.
//
// `e2e/run.mjs` is never imported (it starts a server and a browser at module scope). Its
// `startServer` and the two share constants are selected from its parsed source, whole, and run
// in a context whose only stand-ins are the process it would spawn and the files it would touch.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Script } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { devServerArgs, serverEnv } from "../e2e/lib/server-mode.mjs";
import { harnessRuntime, type AttemptResult } from "./helpers/e2e-harness-runtime";

const success: AttemptResult = {
  ok: true, error: null, kind: null, committed: 0, indeterminate: 0, netFailures: [],
};

const harnessPath = path.join(process.cwd(), "e2e/run.mjs");
const parsed = ts.createSourceFile(
  harnessPath, readFileSync(harnessPath, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS,
);
const wanted = new Set(["startServer", "OFFICE_SHARE_DIR", "OFFICE_SHARE_ROOT"]);
const selected = parsed.statements.flatMap((statement) => {
  if (ts.isFunctionDeclaration(statement) && statement.name && wanted.has(statement.name.text)) {
    return [{ name: statement.name.text, source: statement.getText(parsed) }];
  }
  if (ts.isVariableStatement(statement)) {
    const names = statement.declarationList.declarations
      .map((declaration) => declaration.name.getText(parsed)).filter((name) => wanted.has(name));
    if (names.length) {
      assert.equal(statement.declarationList.declarations.length, 1, "select a whole declaration");
      return [{ name: names[0], source: statement.getText(parsed) }];
    }
  }
  return [];
});
assert.deepEqual(new Set(selected.map(({ name }) => name)), wanted);
const script = new Script(
  `${selected.map(({ source }) => source).join("\n")}\n({ startServer, OFFICE_SHARE_DIR, OFFICE_SHARE_ROOT });`,
  { filename: harnessPath },
);

const ERP_ROOT = "/fixture/erp";
/** A developer's own share, in the shell and in `.env`: neither may reach the E2E server. Only the
 *  production arm reads this `.env` (the dev arm leaves `.env` to `next dev`). */
const developerEnv = { PATH: "/bin", OFFICE_SHARE_DIR: "/mnt/developer-share", OFFICE_SHARE_ROOT: "Q:\\", UPDATES_DIR: "/mnt/developer-updates" };
const developerDotenv = "OFFICE_SHARE_DIR=/mnt/dotenv-share\nOFFICE_SHARE_ROOT='Y:\\'\nDATABASE_URL=postgresql://fixture\n";

/** Runs run.mjs's own `startServer` in `mode` and gives what it spawned, with the two constants. */
function spawnedIn(mode: "dev" | "production") {
  const spawned: { command: string; args: string[]; cwd: string; env: Record<string, string> }[] = [];
  const quiet = { on: () => {} };
  const harness = script.runInNewContext({
    path,
    ERP_ROOT,
    SERVER_MODE: mode,
    PORT: 3100,
    DEV_BUNDLER: "turbopack",
    devServerArgs,
    serverEnv,
    BACKUP_DIR: `${ERP_ROOT}/e2e-backups`,
    UPDATES_DIR: `${ERP_ROOT}/e2e-updates`,
    DEV_SERVER_LOG: "/fixture/e2e-artifacts/dev-server.log",
    state: { standaloneDir: "/fixture/standalone" },
    process: { env: { ...developerEnv } },
    readFileSync: (file: string) => {
      expect(file).toBe(`${ERP_ROOT}/.env`);
      return developerDotenv;
    },
    createWriteStream: () => ({ on: () => {}, write: () => {}, end: (done?: () => void) => done?.() }),
    spawn: (command: string, args: string[], options: { cwd: string; env: Record<string, string> }) => {
      spawned.push({ command, args, cwd: options.cwd, env: options.env });
      return { stdout: quiet, stderr: quiet };
    },
  }) as { startServer: () => unknown; OFFICE_SHARE_DIR: string; OFFICE_SHARE_ROOT: string };
  harness.startServer();
  expect(spawned).toHaveLength(1);
  return { ...spawned[0], dir: harness.OFFICE_SHARE_DIR, root: harness.OFFICE_SHARE_ROOT };
}

describe("the E2E harness's office share (#588)", () => {
  it("is a folder of its own under the ERP root, ignored by git, with a mapped-drive root", () => {
    const { dir, root } = spawnedIn("dev");
    expect(dir).toBe(`${ERP_ROOT}/e2e-customer-folders`);
    expect(root).toBe("Z:\\");
    // The belt beside run.mjs's teardown, as for e2e-backups: a run killed before teardown leaves
    // nothing for `git status` to show.
    expect(readFileSync(path.join(process.cwd(), ".gitignore"), "utf8").split("\n")).toContain("/e2e-customer-folders");
  });

  it.each(["dev", "production"] as const)("%s mode hands the server the harness's share, over the developer's shell (and, in production mode, its .env)", (mode) => {
    const { command, cwd, env, dir, root } = spawnedIn(mode);
    // The arm that ran is the one named: next dev from the ERP root, or the standalone server.
    expect([command, cwd]).toEqual(mode === "dev" ? ["npx", ERP_ROOT] : ["node", "/fixture/standalone"]);
    expect(env.OFFICE_SHARE_DIR).toBe(dir);
    expect(env.OFFICE_SHARE_ROOT).toBe(root);
    // The update folder is the harness's too, over the developer's own value.
    expect(env.UPDATES_DIR).toBe(`${ERP_ROOT}/e2e-updates`);
    // The rest of the environment still reaches the server (only the share is the harness's).
    expect(env.PATH).toBe("/bin");
    if (mode === "production") expect(env.DATABASE_URL).toBe("postgresql://fixture");
  });

  it("hands each flow the same two values as ctx.officeShare", async () => {
    const runtime = harnessRuntime({ runAttempt: () => success });
    runtime.cleanup.resolve();
    await runtime.main();
    expect(runtime.flowContexts.length).toBeGreaterThan(0);
    for (const ctx of runtime.flowContexts) {
      expect((ctx as { officeShare: unknown }).officeShare).toEqual({ dir: "/fixture/e2e-customer-folders", root: "Z:\\" });
    }
  });
});
