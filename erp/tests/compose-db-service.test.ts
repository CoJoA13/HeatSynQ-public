import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * #595: the `db` service's healthcheck crash-restarted Postgres. A shell-form check
 * (`CMD-SHELL pg_isready …`) runs as `sh -c`, and the image's dash forks pg_isready as its child.
 * When a check runs past its timeout, Docker kills only the shell. The orphan is reparented to
 * the container's PID 1, and with no init that is the postmaster. The postmaster handles a child
 * it does not track exiting with 2 as a crashed backend ("untracked child process … exited with
 * exit code 2") and restarts every connection. Either half below closes that alone; the owner
 * ruled both (2026-10-21).
 */
const compose = readFileSync("docker-compose.yml", "utf8");

function dbService(): string[] {
  const lines = compose.split("\n");
  const start = lines.indexOf("  db:");
  expect(start).toBeGreaterThan(-1);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {0,2}\S/.test(line));
  return end === -1 ? rest : rest.slice(0, end);
}

describe("the db service (#595)", () => {
  it("runs under an init, so docker-init reaps an orphan and the postmaster never sees it", () => {
    expect(dbService()).toContain("    init: true");
  });

  it("runs its healthcheck in exec form, so no shell is left to orphan pg_isready", () => {
    const tests = dbService().flatMap((line) => line.match(/^ {6}test: (\[.+\])$/)?.[1] ?? []);
    expect(tests).toHaveLength(1);
    expect(JSON.parse(tests[0])).toEqual(["CMD", "pg_isready", "-U", "erp"]);
  });
});
