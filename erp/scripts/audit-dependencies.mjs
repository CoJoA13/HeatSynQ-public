import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evaluateAudit, NO_EXCEPTION_APPROVED } from "./lib/dependency-audit-policy.mjs";
import { readImageDecoder } from "./lib/image-decoder-policy.mjs";

const defaultAppDir = fileURLToPath(new URL("../", import.meta.url));
const readJSON = (file) => JSON.parse(readFileSync(file, "utf8"));
const POLICY_FILE = "security/audit-exception.json";

// A missing file fails in readFileSync, whose error carries the path. Text that is not JSON must
// name the file too: a bare parse error reads exactly like a broken manifest, lockfile or npm output.
function readPolicy(appDir) {
  const text = readFileSync(path.join(appDir, POLICY_FILE), "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${POLICY_FILE} (${error instanceof Error ? error.message : String(error)}). ${NO_EXCEPTION_APPROVED}`);
  }
}

export function runAudit({ appDir = defaultAppDir } = {}) {
  const outputDir = path.join(appDir, "audit-artifacts");
  mkdirSync(outputDir, { recursive: true });
  const save = (name, value) => writeFileSync(path.join(outputDir, name), `${JSON.stringify(value, null, 2)}\n`);
  // Always query the registry; a cached report is not evidence. Keep the unmodified output before
  // trying to parse or classify it.
  const args = ["audit", "--omit=dev", "--audit-level=high", "--json"];
  const startedAt = new Date().toISOString();
  const execution = spawnSync("npm", args, {
    cwd: appDir, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  });
  writeFileSync(path.join(outputDir, "npm-audit.json"), execution.stdout ?? "");
  writeFileSync(path.join(outputDir, "npm-audit.stderr.log"), execution.stderr ?? "");
  save("execution.json", {
    command: "npm", args, startedAt, finishedAt: new Date().toISOString(),
    status: execution.status, signal: execution.signal,
    error: execution.error ? { message: execution.error.message, code: execution.error.code } : null,
  });
  try {
    if (execution.error || execution.signal) throw new Error("npm audit execution failed or was interrupted; see execution.json");
    const manifest = readJSON(path.join(appDir, "package.json"));
    const lock = readJSON(path.join(appDir, "package-lock.json"));
    const installed = readJSON(path.join(appDir, "node_modules/next/package.json"));
    const versions = {
      manifest: manifest.dependencies?.next,
      lockRoot: lock.packages?.[""]?.dependencies?.next,
      lockInstalled: lock.packages?.["node_modules/next"]?.version,
      installed: installed.version,
    };
    if (lock.lockfileVersion !== 3 || typeof versions.manifest !== "string" ||
        !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(versions.manifest) ||
        Object.values(versions).some((version) => version !== versions.manifest)) {
      throw new Error("Next manifest/lockfile/installed version mismatch; audit a clean npm ci tree");
    }
    // The file must exist and parse (readPolicy fails otherwise, naming it) and must be null:
    // evaluateAudit refuses any other value (#209). Recorded in scope.json first, so a refused
    // value is still evidence.
    const policy = readPolicy(appDir);
    // Evidence only. The audit no longer consults the decoder; the docker job's built-image
    // check (image-decoder-policy.mjs) is the enforcement.
    let decoder;
    let decoderError;
    try { decoder = readImageDecoder(appDir); } catch (error) { decoderError = String(error); }
    save("scope.json", { versions, decoder, decoderError, policy });
    const decision = evaluateAudit({ report: JSON.parse(execution.stdout), npmExitCode: execution.status, policy });
    save("decision.json", decision);
    for (const advisory of decision.blocking) console.error(`BLOCKING ADVISORY: ${advisory}`);
    console.log(`Production dependency audit policy: ${decision.passed ? "PASS" : "FAIL"}; raw evidence in audit-artifacts/`);
    return decision.passed ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    save("decision.json", { passed: false, error: message });
    console.error(`Production dependency audit policy: FAIL — ${message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = runAudit();
}
