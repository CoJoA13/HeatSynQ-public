import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { prepareRelease } from "./release-prepare.mjs";
import { NO_RELEASE_EXCEPTION_APPROVED, validateCandidate, validateReleaseEnvironment } from "./lib/release-policy.mjs";
import { gitlabApi, publishArtifact, skopeoRegistry } from "./lib/release-publish.mjs";

const defaultRepository = fileURLToPath(new URL("../../", import.meta.url));
function command(repository, executable, args, label, input) {
  const result = spawnSync(executable, args, {
    cwd: repository, encoding: "utf8", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], input,
    timeout: 300000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(label);
  return result.stdout.trim();
}

/** @param {{repository?: string, env?: Record<string, string | undefined>}} [options] */
export function refreshReleaseRefs({ repository = defaultRepository, env = process.env } = {}) {
  const identity = validateReleaseEnvironment(env);
  if (env.CI_PIPELINE_SOURCE !== "push" || env.CI_COMMIT_BRANCH) throw new Error("Release requires a protected push tag pipeline");
  command(repository, "git", ["fetch", "--quiet", "--no-tags", "origin",
    `+refs/heads/${identity.defaultBranch}:refs/remotes/origin/${identity.defaultBranch}`,
    `+refs/tags/${identity.tag}:refs/tags/${identity.tag}`], "Unable to refresh release refs");
}
function evidence(repository, file) {
  try { return JSON.parse(readFileSync(path.join(repository, "release", file), "utf8")); }
  catch { throw new Error(`Unable to read release ${file}`); }
}
function writeEvidence(repository, file, bytes) {
  const directory = path.join(repository, "release"); mkdirSync(directory, { recursive: true });
  const output = path.join(directory, file);
  writeFileSync(`${output}.tmp`, bytes, { mode: 0o600 }); renameSync(`${output}.tmp`, output);
}
function revalidate(repository, env, now) {
  const prepared = evidence(repository, "prepared.json");
  refreshReleaseRefs({ repository, env });
  const identity = prepareRelease({ repository, env, now, writeEvidence: false });
  if (!isDeepStrictEqual(prepared, identity)) throw new Error("Original prepared release identity does not match");
  return identity;
}

/** Registry and API may be replaced in focused tests; all local Git and policy validation is real.
 * @param {{repository?: string, env?: Record<string, string | undefined>, now?: Date, clock?: () => Date, registry?: object, api?: object}} [options]
 */
export async function publishRelease({ repository = defaultRepository, env = process.env, now = new Date(), clock = () => new Date(), registry, api } = {}) {
  const identity = revalidate(repository, env, now);
  const candidate = evidence(repository, "candidate.json");
  validateCandidate(identity, candidate);
  const notes = command(repository, "git", ["show", `${identity.sha}:releases/${identity.tag}.md`], "Unable to read committed release notes");
  const publish = async adapter => {
    const bytes = await publishArtifact({ identity, candidate, notes, clock, registry: adapter, api: api ?? gitlabApi({ apiUrl: identity.apiUrl, token: env.CI_JOB_TOKEN }) });
    writeEvidence(repository, "release.json", bytes);
    return JSON.parse(bytes);
  };
  if (registry) return publish(registry);
  const auth = registryAuth(identity, env);
  try { return await publish(skopeoRegistry({ authFile: auth.file })); } finally { auth.cleanup(); }
}

function registryAuth(identity, env) {
  if (!env.CI_JOB_TOKEN) throw new Error("CI job token is required");
  const directory = mkdtempSync(path.join(tmpdir(), "heatsynq-registry-"));
  const file = path.join(directory, "config.json");
  writeFileSync(file, JSON.stringify({ auths: { [identity.registryHost]: { auth: Buffer.from(`gitlab-ci-token:${env.CI_JOB_TOKEN}`).toString("base64") } } }), { mode: 0o600 });
  return { file, directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

/** Called only after the existing Docker gate's decoder and boot checks of heatsynq-app:ci.
 * @param {{repository?: string, env?: Record<string, string | undefined>, now?: Date, clock?: () => Date, docker?: object}} [options]
 */
export async function captureCandidate({ repository = defaultRepository, env = process.env, now = new Date(), clock = () => new Date(), docker } = {}) {
  const identity = revalidate(repository, env, now);
  if (!/^[1-9]\d*$/.test(env.CI_JOB_ID ?? "") || String(env.CI_JOB_ID).includes("\n")) throw new Error("Invalid Docker job ID");
  const tag = `${identity.registry}/candidates:p${identity.pipelineId}-j${env.CI_JOB_ID}`;
  const capture = async adapter => {
    const local = await adapter.inspectLocal("heatsynq-app:ci");
    if (local.Os !== "linux" || local.Architecture !== "amd64") throw new Error("Candidate must be linux/amd64");
    await adapter.tag("heatsynq-app:ci", tag);
    const current = clock();
    if (!(current instanceof Date) || !Number.isFinite(current.getTime())) throw new Error("Invalid release validation time");
    if (identity.policyExpiresAt !== null && current.getTime() >= Date.parse(identity.policyExpiresAt)) {
      throw new Error(`Release policy expired at ${identity.policyExpiresAt}`);
    }
    await adapter.push(tag);
    const digests = await adapter.repoDigests(tag);
    const prefix = `${identity.registry}/candidates@`;
    const matches = digests.filter(value => value.startsWith(prefix));
    if (matches.length !== 1) throw new Error("Unable to identify pushed candidate digest");
    const candidate = { tag: identity.tag, sha: identity.sha, pipelineId: identity.pipelineId, dockerJobId: env.CI_JOB_ID, image: matches[0] };
    validateCandidate(identity, candidate);
    writeEvidence(repository, "candidate.json", `${JSON.stringify(candidate, null, 2)}\n`);
    return candidate;
  };
  if (docker) return capture(docker);
  const auth = registryAuth(identity, env);
  const run = args => command(repository, "docker", ["--config", auth.directory, ...args], "Docker candidate operation failed");
  try {
    return await capture({
      inspectLocal: image => JSON.parse(run(["image", "inspect", "--format", "{{json .}}", image])),
      tag: (image, target) => run(["tag", image, target]),
      push: target => run(["push", target]),
      repoDigests: image => JSON.parse(run(["image", "inspect", "--format", "{{json .RepoDigests}}", image])),
    });
  } finally { auth.cleanup(); }
}

/** Keep first-tag failures diagnosable without reflecting OS, JSON, network or signed-URL text. */
export function releaseFailureMessage(error) {
  const message = error instanceof Error ? error.message : "";
  const safe = new Set([
    "Unable to refresh release refs", "Original prepared release identity does not match",
    "Unable to read release prepared.json", "Unable to read release candidate.json",
    "Release requires a protected push tag pipeline", "Release tag must be protected",
    "Release checkout does not match CI_COMMIT_SHA", "Release tag does not identify CI_COMMIT_SHA",
    "Release commit is not contained in main", "Invalid release tag",
    "Release tag, package version and lockfile root version must agree",
    "Committed release notes are required", "Unable to read committed release notes",
    NO_RELEASE_EXCEPTION_APPROVED,
    "Registry command failed", "Registry inspection failed", "Registry copy failed",
    "Invalid registry inspection response", "Release image digest conflict", "Release image must be linux/amd64",
    "Existing release metadata conflict", "Persistent release metadata verification failed",
    "Existing release content conflict", "Existing release tag does not match source commit",
    "Unable to verify existing release tag", "CI job token is required",
    "Unsafe package download redirect", "Package download redirect limit exceeded",
    "Package download response failed", "Candidate must be linux/amd64", "Docker candidate operation failed",
    "Unable to identify pushed candidate digest", "Invalid Docker job ID",
  ]);
  if (safe.has(message) || /^GitLab (GET|PUT|POST) (request failed|response failed|failed \([1-5][0-9]{2}\))$/.test(message)) return message;
  return "Release operation refused; verify release identity, policy and publication evidence";
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2];
    if (mode === "--prepare") { refreshReleaseRefs(); prepareRelease(); }
    else if (mode === "--candidate") await captureCandidate();
    else if (mode === undefined) await publishRelease();
    else throw new Error("Unknown release command");
    console.log("Release operation completed");
  } catch (error) {
    console.error(releaseFailureMessage(error));
    process.exitCode = 1;
  }
}
