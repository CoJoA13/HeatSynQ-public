import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAudit } from "../scripts/audit-dependencies.mjs";
import { evaluateAudit, NO_EXCEPTION_APPROVED } from "../scripts/lib/dependency-audit-policy.mjs";
import { assertPatchedImageDecoder } from "../scripts/lib/image-decoder-policy.mjs";

const nextLeaf = {
  source: 1193676, name: "next", dependency: "next", severity: "critical",
  url: "https://github.com/advisories/GHSA-p293-qw3h-jr36", range: ">=16.0.0 <16.3.3",
};
const avif = {
  ...nextLeaf, source: 1193732,
  url: "https://github.com/advisories/GHSA-2xp9-vwfh-vxw4",
};
// The retired 16.2.12 exception file's shape (#209): what a stale or re-added file would look like.
const retiredPolicy = {
  advisories: [nextLeaf.url, avif.url], avifApprovedAt: "2026-09-21T13:28:06.000Z", package: "next", version: "16.2.12",
  approvedAt: "2026-09-21T13:28:06.000Z", expiresAt: "2026-10-05T13:28:06.000Z",
  deployment: { platform: "linux", runtime: "docker", dockerfileSha256: "a".repeat(64), composeSha256: "b".repeat(64) },
};
function input(via: unknown[] = [nextLeaf]) {
  return {
    report: {
      auditReportVersion: 2,
      vulnerabilities: { next: { name: "next", severity: "critical", via, nodes: ["node_modules/next"] } },
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 1, total: 1 } },
    },
    npmExitCode: 1,
    policy: null as unknown,
  };
}
function cleanInput() {
  const data = input();
  data.report.vulnerabilities = {} as typeof data.report.vulnerabilities;
  data.report.metadata.vulnerabilities = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  data.npmExitCode = 0;
  return data;
}
const refusal = /No dependency-audit exception is approved; security\/audit-exception\.json must be null\. A new exception needs an owner ruling\./;

describe("no dependency-audit exception is approved (#209)", () => {
  it("commits the exception file as exactly null", () => {
    expect(readFileSync(new URL("../security/audit-exception.json", import.meta.url), "utf8")).toBe("null\n");
    expect(NO_EXCEPTION_APPROVED).toMatch(refusal);
  });

  // The stale-file hole the review found: a clean report used to skip the exception entirely, so
  // any object at all passed. The refusal comes before the report is read.
  it.each([
    ["the retired 16.2.12 exception", retiredPolicy],
    ["an arbitrary object", { anything: 1 }],
    ["an empty object", {}],
    ["an array", []],
    ["false", false],
    ["zero", 0],
    ["a string", "null"],
    ["undefined (a missing key)", undefined],
  ])("refuses %s even on a clean report", (_label, policy) => {
    expect(() => evaluateAudit({ ...cleanInput(), policy })).toThrow(refusal);
  });

  it("refuses a non-null file on a report carrying the formerly excepted advisories, too", () => {
    expect(() => evaluateAudit({ ...input([nextLeaf, avif]), policy: retiredPolicy })).toThrow(refusal);
  });

  it("passes a clean report only with a null file", () => {
    expect(evaluateAudit(cleanInput())).toEqual({ passed: true, blocking: [] });
  });

  it("blocks both formerly excepted Next advisories, whatever the decoder or deployment", () => {
    expect(evaluateAudit(input([nextLeaf, avif]))).toEqual({ passed: false, blocking: [avif.url, nextLeaf.url] });
    // The retired exception's inputs no longer mean anything to the decision.
    expect(evaluateAudit({ ...input([avif]), decoder: { heif: "1.23.2" }, deployment: { platform: "linux", container: true } } as never))
      .toEqual({ passed: false, blocking: [avif.url] });
  });

  it("blocks the captured two-advisory report", () => {
    const report = JSON.parse(readFileSync(new URL("fixtures/audit-two-next-advisories.json", import.meta.url), "utf8"));
    expect(evaluateAudit({ ...input(), report })).toEqual({ passed: false, blocking: [avif.url, nextLeaf.url] });
  });

  it.each(["high", "critical"])("blocks an unrelated %s advisory", (severity) => {
    const data = input();
    Object.assign(data.report.vulnerabilities, {
      other: { name: "other", severity, via: [{ ...avif, url: "https://github.com/advisories/GHSA-other", name: "other", dependency: "other", severity }], nodes: ["node_modules/other"] },
    });
    data.report.metadata.vulnerabilities.total = 2;
    data.report.metadata.vulnerabilities[severity as "high" | "critical"]++;
    expect(evaluateAudit(data).blocking).toEqual(["https://github.com/advisories/GHSA-other", nextLeaf.url]);
  });

  it.each(["info", "low", "moderate"])("retains the existing threshold for %s advisories", (severity) => {
    const data = input([{ ...avif, severity }]);
    data.report.vulnerabilities.next.severity = severity;
    data.report.metadata.vulnerabilities.critical = 0;
    data.report.metadata.vulnerabilities[severity as "info" | "low" | "moderate"] = 1;
    data.npmExitCode = 0;
    expect(evaluateAudit(data)).toEqual({ passed: true, blocking: [] });
  });

  it("resolves indirect dependencies without hiding their severe advisory", () => {
    const data = input([avif]);
    Object.assign(data.report.vulnerabilities, { parent: { name: "parent", severity: "critical", via: ["next"], nodes: ["node_modules/parent"] } });
    data.report.metadata.vulnerabilities.critical = 2;
    data.report.metadata.vulnerabilities.total = 2;
    expect(evaluateAudit(data).blocking).toEqual([avif.url]);
  });

  it.each([["missing"], ["next"], []])("fails closed on unresolved, cyclic or empty severe via arrays: %j", (...via) => {
    expect(() => evaluateAudit(input(via))).toThrow(/advisory|reference|cycle/i);
  });

  it.each([undefined, {}, { error: { code: "ENOAUDIT" } }, { auditReportVersion: 3, vulnerabilities: {} }])("rejects incomplete/error audit reports", (report) => {
    expect(() => evaluateAudit({ ...input(), report })).toThrow(/report|audit/i);
  });

  it.each([null, 2, 127])("rejects npm execution failure %s even with a valid-looking report", (npmExitCode) => {
    expect(() => evaluateAudit({ ...input(), npmExitCode })).toThrow(/exit/i);
  });

  it("rejects unknown severities and report counts inconsistent with the advisory rows", () => {
    expect(() => evaluateAudit(input([{ ...nextLeaf, severity: "unknown" }]))).toThrow(/severity/i);
    const data = input(); data.report.metadata.vulnerabilities.critical = 0;
    expect(() => evaluateAudit(data)).toThrow(/count|metadata/i);
  });

  it("does not trust an exit status inconsistent with the reported audit threshold", () => {
    const data = input(); data.npmExitCode = 0;
    expect(() => evaluateAudit(data)).toThrow(/exit/i);
  });
});

// The built-image check the docker job streams into heatsynq-app:ci. It no longer gates the
// audit, so its version rule is proved directly here.
describe("patched image-decoder requirement", () => {
  it.each([undefined, {}, { heif: "1.23.1" }, { heif: "1.22.0" }, { heif: "1.23.2-rc.1" }, { heif: "bad" }, { heif: "1.23.2.0" }, { heif: "01.23.2" }, { heif: "1.23.2 " }, { heif: "0.99.0" }])("refuses an unpatched or malformed libheif: %j", (versions) => {
    expect(() => assertPatchedImageDecoder(versions)).toThrow(/decoder|libheif/i);
  });

  it.each(["1.23.2", "1.23.3", "1.24.0", "2.0.0"])("accepts patched stable libheif %s", (heif) => {
    expect(() => assertPatchedImageDecoder({ sharp: "0.35.4", heif })).not.toThrow();
  });
});

describe("audit runner execution and evidence", () => {
  // Only the external registry process is replaced. The runner really spawns npm from PATH,
  // reads project/installed files and writes artifacts, so these assert the gate's own boundary.
  function fixture(reportText: string, exitCode: number, extra = "", policyText: string | null = "null\n") {
    const dir = mkdtempSync(path.join(tmpdir(), "audit-policy-test-"));
    const appDir = path.join(dir, "erp");
    const bin = path.join(dir, "bin");
    for (const part of [bin, path.join(appDir, "node_modules/next/node_modules/sharp"), path.join(appDir, "node_modules/next/dist/server"), path.join(appDir, "security")]) mkdirSync(part, { recursive: true });
    writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ dependencies: { next: "16.3.6" } }));
    writeFileSync(path.join(appDir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { next: "16.3.6" } }, "node_modules/next": { version: "16.3.6" } } }));
    writeFileSync(path.join(appDir, "node_modules/next/dist/server/image-optimizer.js"), "// Resolution fixture\n");
    writeFileSync(path.join(appDir, "node_modules/next/package.json"), JSON.stringify({ version: "16.3.6" }));
    writeFileSync(path.join(appDir, "node_modules/next/node_modules/sharp/index.js"), 'exports.versions = { sharp: "0.35.4", heif: "1.23.2" };\n');
    if (policyText !== null) writeFileSync(path.join(appDir, "security/audit-exception.json"), policyText);
    writeFileSync(path.join(bin, "npm"), `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.writeFileSync('npm-args.json', JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(${JSON.stringify(reportText)});\nprocess.stderr.write('registry diagnostic\\n');\n${extra}\nprocess.exit(${exitCode});\n`, { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath}`;
    return {
      appDir,
      read: (name: string) => readFileSync(path.join(appDir, "audit-artifacts", name), "utf8"),
      cleanup: () => { process.env.PATH = previousPath; rmSync(dir, { recursive: true, force: true }); },
    };
  }

  const clean = JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } });

  it("runs the production high/critical audit and persists raw evidence on success", () => {
    const f = fixture(clean, 0);
    try {
      expect(runAudit({ appDir: f.appDir })).toBe(0);
      expect(JSON.parse(readFileSync(path.join(f.appDir, "npm-args.json"), "utf8"))).toEqual(["audit", "--omit=dev", "--audit-level=high", "--json"]);
      expect(f.read("npm-audit.json")).toBe(clean);
      expect(f.read("npm-audit.stderr.log")).toBe("registry diagnostic\n");
      expect(JSON.parse(f.read("execution.json")).status).toBe(0);
      expect(JSON.parse(f.read("decision.json")).passed).toBe(true);
      const scope = JSON.parse(f.read("scope.json"));
      expect(scope.decoder).toEqual({ sharp: "0.35.4", heif: "1.23.2" });
      expect(scope.policy).toBeNull();
      // The deployment fingerprints existed only to scope the retired exception (#209).
      expect(Object.hasOwn(scope, "deployment")).toBe(false);
    } finally { f.cleanup(); }
  });

  it.each([
    ["the retired exception", JSON.stringify(retiredPolicy)],
    ["an arbitrary object", '{"anything":1}\n'],
  ])("refuses a clean audit when the committed file holds %s, recording it as evidence", (_label, text) => {
    const f = fixture(clean, 0, "", text);
    try {
      expect(runAudit({ appDir: f.appDir })).toBe(1);
      expect(JSON.parse(f.read("decision.json"))).toEqual({ passed: false, error: NO_EXCEPTION_APPROVED });
      expect(JSON.parse(f.read("scope.json")).policy).toEqual(JSON.parse(text));
    } finally { f.cleanup(); }
  });

  // Review round 2 (#209): a file that is not JSON already failed closed, but nothing proved it and
  // the error was the bare parse text. Each case must refuse, name the file and state the rule.
  it.each([
    ["empty", ""],
    ["a truncated null", "nul"],
    ["an unclosed object", "{"],
    ["an upper-case NULL", "NULL"],
    ["two values", "null null"],
    ["a byte-order mark before null", "﻿null\n"],
  ])("refuses a clean audit when the committed file is %s, naming the file", (_label, text) => {
    const f = fixture(clean, 0, "", text);
    try {
      expect(runAudit({ appDir: f.appDir })).toBe(1);
      const decision = JSON.parse(f.read("decision.json"));
      expect(decision.passed).toBe(false);
      expect(decision.error).toMatch(/^Invalid JSON in security\/audit-exception\.json \(/);
      expect(decision.error).toContain(NO_EXCEPTION_APPROVED);
    } finally { f.cleanup(); }
  });

  it("still requires the committed file to exist", () => {
    const f = fixture(clean, 0, "", null);
    try {
      expect(runAudit({ appDir: f.appDir })).toBe(1);
      expect(JSON.parse(f.read("decision.json")).error).toMatch(/audit-exception\.json/);
    } finally { f.cleanup(); }
  });

  it("fails when npm reports a high/critical advisory, naming it", () => {
    const report = readFileSync(new URL("fixtures/audit-two-next-advisories.json", import.meta.url), "utf8");
    const f = fixture(report, 1);
    try {
      expect(runAudit({ appDir: f.appDir })).toBe(1);
      expect(JSON.parse(f.read("decision.json"))).toEqual({ passed: false, blocking: [avif.url, nextLeaf.url] });
    } finally { f.cleanup(); }
  });

  it("checks Next's resolved decoder through Docker's stdin command", () => {
    const f = fixture(clean, 0);
    const verifier = readFileSync(new URL("../scripts/lib/image-decoder-policy.mjs", import.meta.url), "utf8");
    // Root sharp is patched: only checking the nested copy used by Next catches the regression.
    mkdirSync(path.join(f.appDir, "node_modules/sharp"));
    writeFileSync(path.join(f.appDir, "node_modules/sharp/index.js"), 'exports.versions = { heif: "1.23.2" };');
    try {
      for (const [heif, expected] of [["1.23.2", 0], ["1.23.1", 1], ["1.23.2-rc.1", 1], ["bad", 1]] as const) {
        writeFileSync(path.join(f.appDir, "node_modules/next/node_modules/sharp/index.js"), `exports.versions = { sharp: "0.35.4", heif: ${JSON.stringify(heif)} };`);
        const result = spawnSync(process.execPath, ["--input-type=module", "-"], { cwd: f.appDir, input: verifier, encoding: "utf8" });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(expected);
        expect(result.stdout).toContain(heif);
      }
      writeFileSync(path.join(f.appDir, "node_modules/next/node_modules/sharp/index.js"), 'throw new Error("native binary unavailable");');
      expect(spawnSync(process.execPath, ["--input-type=module", "-"], { cwd: f.appDir, input: verifier }).status).toBe(1);
    } finally { f.cleanup(); }
  });

  it.each([
    ["not JSON", 0],
    [JSON.stringify({ error: { code: "ENOAUDIT", summary: "registry unavailable" } }), 1],
    [clean, 2],
    [clean, 127],
  ])("fails closed while retaining failed audit output", (raw, code) => {
    const f = fixture(raw, code);
    try {
      expect(runAudit({ appDir: f.appDir })).toBe(1);
      expect(f.read("npm-audit.json")).toBe(raw);
      expect(JSON.parse(f.read("execution.json")).status).toBe(code);
      expect(JSON.parse(f.read("decision.json"))).toMatchObject({ passed: false, error: expect.any(String) });
    } finally { f.cleanup(); }
  });

  it("rejects a signalled npm process even when it printed a clean report", () => {
    const f = fixture(clean, 0, "process.kill(process.pid, 'SIGTERM');");
    try {
      expect(runAudit({ appDir: f.appDir })).toBe(1);
      expect(JSON.parse(f.read("execution.json"))).toMatchObject({ status: null, signal: "SIGTERM" });
      expect(JSON.parse(f.read("decision.json")).passed).toBe(false);
    } finally { f.cleanup(); }
  });

  it("rejects a mismatched installed tree even if npm reports no vulnerabilities", () => {
    const f = fixture(clean, 0);
    writeFileSync(path.join(f.appDir, "node_modules/next/package.json"), JSON.stringify({ version: "16.3.5" }));
    try {
      expect(runAudit({ appDir: f.appDir })).toBe(1);
      expect(JSON.parse(f.read("decision.json")).error).toMatch(/version/i);
    } finally { f.cleanup(); }
  });
});
