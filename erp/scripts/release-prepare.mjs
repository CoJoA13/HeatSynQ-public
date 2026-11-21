import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateRelease, validateReleaseEnvironment } from "./lib/release-policy.mjs";

const defaultRepository = fileURLToPath(new URL("../../", import.meta.url));

function git(repository, args, label) {
  try {
    return execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(`Unable to read ${label} from the local Git repository`);
  }
}

function resolveMain(repository, branch) {
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
    const result = spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: repository,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0) return result.stdout.trim();
    if (result.error) throw new Error("Unable to inspect the local main reference");
  }
  throw new Error("The local main reference is unavailable; refusing release preparation without fetching");
}

function assertAncestor(repository, ancestor, descendant) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error("Unable to validate release ancestry in the local Git repository");
  }
  if (result.status === 1) throw new Error("Release commit is not contained in main");
}

function sourceFile(repository, sha, file) {
  return git(repository, ["show", `${sha}:${file}`], file);
}

function sourceJson(repository, sha, file) {
  const contents = sourceFile(repository, sha, file);
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error(`Invalid JSON in committed ${file}`);
  }
}

function sourceExists(repository, sha, file) {
  const result = spawnSync("git", ["cat-file", "-e", `${sha}:${file}`], {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) return true;
  if (!result.error && result.status === 128) return false;
  throw new Error(`Unable to inspect committed ${file}`);
}

/**
 * Revalidate the candidate against local Git state and bytes stored in its commit, then write the
 * deterministic identity consumed by the Docker and publication stages. This performs no fetches.
 * @param {{repository?: string, env?: Record<string, string | undefined>, now?: Date, writeEvidence?: boolean}} [options]
 */
export function prepareRelease({
  repository = defaultRepository,
  env = process.env,
  now = new Date(),
  writeEvidence = true,
} = {}) {
  const expected = validateReleaseEnvironment(env);
  const checkout = git(repository, ["rev-parse", "--verify", "HEAD^{commit}"], "checked-out commit");
  if (checkout !== expected.sha) throw new Error("Release checkout does not match CI_COMMIT_SHA");

  const tagged = git(repository, ["rev-parse", "--verify", `refs/tags/${expected.tag}^{commit}`], "release tag");
  if (tagged !== expected.sha) throw new Error("Release tag does not identify CI_COMMIT_SHA");

  const main = resolveMain(repository, expected.defaultBranch);
  assertAncestor(repository, expected.sha, main);

  const manifest = sourceJson(repository, expected.sha, "erp/package.json");
  const lock = sourceJson(repository, expected.sha, "erp/package-lock.json");
  const policyFile = "erp/security/audit-exception.json";
  const policy = sourceExists(repository, expected.sha, policyFile) ? sourceJson(repository, expected.sha, policyFile) : null;
  const notes = sourceFile(repository, expected.sha, `releases/${expected.tag}.md`);
  const identity = validateRelease({ env, manifest, lock, notes, policy, now });

  if (!writeEvidence) return identity;
  const releaseDirectory = path.join(repository, "release");
  const output = path.join(releaseDirectory, "prepared.json");
  const temporary = `${output}.tmp`;
  mkdirSync(releaseDirectory, { recursive: true });
  writeFileSync(temporary, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, output);
  return identity;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const identity = prepareRelease();
    console.log(`Prepared ${identity.tag} at ${identity.sha}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
