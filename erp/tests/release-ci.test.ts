import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { load } = createRequire(import.meta.url)("js-yaml") as { load: (text: string) => Record<string, unknown> };
type Step = { run?: string; uses?: string; with?: Record<string, unknown>; "continue-on-error"?: unknown };
type Job = { "runs-on"?: unknown; "timeout-minutes"?: unknown; "continue-on-error"?: unknown; if?: unknown; steps?: Step[]; container?: unknown };
type Workflow = Record<string, unknown> & { permissions?: unknown; jobs: Record<string, Job> };
const text = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const config = load(text) as Workflow;
// A step's commands, line by line, without the comment lines a gate could be moved into.
const commands = (job: Job): string[] =>
  (job.steps ?? []).flatMap(step => (step.run ?? "").split("\n")).filter(line => !/^\s*#/.test(line));

function contract(workflow: Workflow) {
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(Object.keys(workflow.jobs).sort()).toEqual(["ci", "docker", "e2e", "security-audit"]);
  for (const [name, gates] of Object.entries({
    ci: ["npm test", "tsc --noEmit", "npx eslint", "npm run build", "npm run manual:build", "db:bootstrap", "check-standalone-trace.mjs"],
    docker: ["docker build", "public-bootstrap.mjs", "image-decoder-policy.mjs", "api/health"],
    e2e: ["npm run test:e2e", "db:bootstrap", "npm run db:seed"],
    "security-audit": ["audit-dependencies.mjs"],
  })) {
    const job = workflow.jobs[name];
    expect(job, name).toBeDefined();
    expect(job["runs-on"], `${name} runs on a hosted runner`).toBe("ubuntu-latest");
    expect(job["continue-on-error"], name).toBeUndefined();
    expect(job.if, name).toBeUndefined();
    for (const step of job.steps ?? []) expect(step["continue-on-error"], name).toBeUndefined();
    const actual = commands(job).join("\n");
    expect(actual).not.toMatch(/publish-release|release-candidate/i);
    for (const gate of gates) expect(actual, `${name}: ${gate}`).toContain(gate);
  }
}

describe("public source CI boundaries", () => {
  it("runs the four source gates on hosted runners with a read-only token", () => contract(config));
  it("names no repository credential and no private runner anywhere in the file", () => {
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toMatch(/self-hosted/);
  });
  it("pins every action by commit", () => {
    const uses = Object.values(config.jobs).flatMap(job => (job.steps ?? []).flatMap(step => (step.uses ? [step.uses] : [])));
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) expect(use).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });
  it("rejects a gate changed to allow failure", () => {
    expect(() => contract({ ...config, jobs: { ...config.jobs, e2e: { ...config.jobs.e2e, "continue-on-error": true } } })).toThrow();
  });
  it("rejects a command moved into a comment", () => {
    const ci = config.jobs.ci;
    const steps = (ci.steps ?? []).map(step => (step.run ? { ...step, run: step.run.split("\n").map(line => (line.includes("tsc --noEmit") ? `# ${line.trim()}` : line)).join("\n") } : step));
    expect(() => contract({ ...config, jobs: { ...config.jobs, ci: { ...ci, steps } } })).toThrow();
  });
  it("rejects a job moved off the hosted runner", () => {
    expect(() => contract({ ...config, jobs: { ...config.jobs, e2e: { ...config.jobs.e2e, "runs-on": ["linux", "internal"] } } })).toThrow();
  });
  it("bounds the browser suite inside its job, and keeps the JUnit report and the retry evidence", () => {
    const e2e = config.jobs.e2e;
    expect(e2e["timeout-minutes"]).toBe(60);
    expect(commands(e2e).join("\n")).toContain("timeout 45m npm run test:e2e");
    expect(commands(e2e).join("\n")).toContain("granted=(e2e-artifacts/*__attempt-*)");
    expect(commands(e2e).join("\n")).toContain("grep -qE '^  RETRIED '");
    expect(commands(config.jobs.ci).join("\n")).toContain("--reporter=junit --outputFile.junit=test-results/vitest-junit.xml");
  });
});
