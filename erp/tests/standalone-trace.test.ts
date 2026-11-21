import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FONT_DIRECTORY, expected, traceProblems } from "../scripts/lib/standalone-trace.mjs";

// The rule the required `ci` check applies to `.next/standalone` after `next build` (#334).
const FONTS = [`${FONT_DIRECTORY}roboto-mono/RobotoMono-Regular.ttf`, `${FONT_DIRECTORY}roboto-mono/OFL.txt`];
const SERVER = ["server.js", "package.json", ".next/BUILD_ID", ".next/server/app/page.js",
  "node_modules/next/package.json", ...FONTS];

describe("the standalone output", () => {
  it("is as expected when it holds the server, its node_modules and the vendored font directory", () => {
    expect(traceProblems(SERVER, FONTS)).toEqual([]);
  });

  it("may carry the two env files Next copies by design, and no other", () => {
    expect(traceProblems([...SERVER, ".env", ".env.production"], FONTS)).toEqual([]);
    for (const file of [".env.local", ".env.production.local", ".env.example", ".env.development", ".ENV",
      ".env.d/x", ".envrc/x", ".environment", "env", "nested/.env"]) {
      expect(expected(file), file).toBe(false);
      expect(traceProblems([...SERVER, file], FONTS), file).toHaveLength(1);
    }
  });

  it("names each place a whole-project trace put files, with how many", () => {
    const traced = [...SERVER, "tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts", "tests/d.test.ts",
      "tests/e.test.ts", "tests/helpers/db.ts", "e2e/run.mjs", "docker-compose.yml", "Dockerfile", "README.md",
      "public/logo.png", "scripts/build-manual.mjs", "src/server/backups.ts", "src/app/page.tsx",
      "src/server/pdf/render.ts", "prisma/schema.prisma"];
    expect(traceProblems(traced, FONTS)).toEqual([
      "not expected in the standalone output: Dockerfile",
      "not expected in the standalone output: README.md",
      "not expected in the standalone output: docker-compose.yml",
      "not expected in the standalone output: e2e/ (1 file)",
      "not expected in the standalone output: prisma/ (1 file)",
      "not expected in the standalone output: public/ (1 file)",
      "not expected in the standalone output: scripts/ (1 file)",
      "not expected in the standalone output: src/ (3 files)",
      "not expected in the standalone output: tests/ (6 files)",
    ]);
  });

  it("refuses a source file beside the fonts, and anything that only resembles an expected name", () => {
    for (const file of ["src/server/pdf/render.ts", "src/server/pdf/fonts.ts", "server.js.map", "package-lock.json",
      "node_modules", ".next", "nested/server.js", "nested/package.json", `nested/${FONT_DIRECTORY}a.ttf`,
      "x/node_modules/next/package.json", "x/.next/BUILD_ID"]) {
      expect(expected(file), file).toBe(false);
      expect(traceProblems([...SERVER, file], FONTS), file).toHaveLength(1);
    }
  });

  it("reports every file of the font directory the output lacks, whatever its kind, and a missing server", () => {
    expect(traceProblems(["package.json", ".next/BUILD_ID", FONTS[1]], FONTS)).toEqual([
      "missing from the standalone output: server.js",
      `missing from the standalone output: ${FONTS[0]}`,
    ]);
    expect(traceProblems(SERVER.filter((file) => file !== FONTS[1]), FONTS)).toEqual([
      `missing from the standalone output: ${FONTS[1]}`,
    ]);
  });

  it("does not take a copy elsewhere in the output for the file it requires", () => {
    expect(traceProblems([...SERVER.filter((file) => file !== FONTS[0]), `x/${FONTS[0]}`, "x/server.js"], FONTS)).toEqual([
      `missing from the standalone output: ${FONTS[0]}`,
      "not expected in the standalone output: x/ (2 files)",
    ]);
  });

  it("refuses a checkout with no vendored font to look for", () => {
    expect(traceProblems(SERVER, [])).toEqual([`no vendored font found under ${FONT_DIRECTORY}`]);
  });
});

// The script half: the walk of both directories, the refusal's exit status and what it prints.
describe("check-standalone-trace.mjs", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** A stand-in app root holding the given files, each relative to it. */
  function appRoot(files: string[]) {
    const root = mkdtempSync(path.join(os.tmpdir(), "standalone-trace-"));
    roots.push(root);
    for (const file of files) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), "");
    }
    return root;
  }
  const check = (root: string) =>
    spawnSync(process.execPath, ["scripts/check-standalone-trace.mjs", root], { encoding: "utf8" });
  const built = (extra: string[] = []) => appRoot([...FONTS, ...[...SERVER, ...extra].map((file) => `.next/standalone/${file}`)]);

  it("passes a build that holds the server alone", () => {
    const result = check(built([".env"]));
    expect([result.status, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toContain("nothing else");
  });

  it("fails a build that carries project files, at any depth, and names where", () => {
    const result = check(built(["tests/helpers/deep/a.ts", "src/app/orders/page.tsx", "docker-compose.yml"]));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("not expected in the standalone output: tests/ (1 file)");
    expect(result.stderr).toContain("not expected in the standalone output: src/ (1 file)");
    expect(result.stderr).toContain("not expected in the standalone output: docker-compose.yml");
  });

  it("fails a build that lacks a file of the checkout's font directory", () => {
    const root = built();
    rmSync(path.join(root, ".next/standalone", FONTS[1]));
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`missing from the standalone output: ${FONTS[1]}`);
  });

  it("fails when there is no standalone output to list", () => {
    const result = check(appRoot(FONTS));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("could not list the standalone output");
  });

  it("judges the files behind a symlinked directory under the link's path", () => {
    const root = built();
    const outside = appRoot(["a.ts"]);
    symlinkSync(outside, path.join(root, ".next/standalone/linked"));
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not expected in the standalone output: linked");
  });
});
