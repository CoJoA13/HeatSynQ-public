const RELEASE_TAG = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-rc\.(?:[1-9]\d*))?)$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const POSITIVE_ID = /^[1-9]\d*$/;
// #209: no dependency-audit exception is approved. The audit gate's wording, with the repository
// path and "or absent" (release-prepare.mjs reads a missing file as null). Allow-listed in
// publish-release.mjs so the refusal stays diagnosable in CI.
export const NO_RELEASE_EXCEPTION_APPROVED =
  "No dependency-audit exception is approved; erp/security/audit-exception.json must be null or absent. A new exception needs an owner ruling.";
const PROJECT = Object.freeze({
  id: "86201754",
  defaultBranch: "main",
  url: "https://gitlab.com/synqsuite-group/HeatSynQ",
  serverUrl: "https://gitlab.com",
  apiUrl: "https://gitlab.com/api/v4",
  registryHost: "registry.gitlab.com",
  registry: "registry.gitlab.com/synqsuite-group/heatsynq",
});

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value, expected, label) {
  if (value !== expected) fail(`Invalid release ${label}`);
  return value;
}

function positiveId(value, label) {
  const match = typeof value === "string" ? POSITIVE_ID.exec(value) : null;
  if (!match || match[0] !== value) fail(`Invalid release ${label}`);
  return value;
}

export function releaseVersion(tag) {
  const match = typeof tag === "string" ? RELEASE_TAG.exec(tag) : null;
  if (!match || match[0] !== tag) fail("Invalid release tag");
  return match[1];
}

/** Validate CI-controlled destinations and identifiers before using them in Git or network operations. */
export function validateReleaseEnvironment(env) {
  if (!isObject(env)) fail("Invalid release environment");
  const tag = env.CI_COMMIT_TAG;
  const version = releaseVersion(tag);
  if (env.CI_COMMIT_REF_PROTECTED !== "true") fail("Release tag must be protected");
  const sha = env.CI_COMMIT_SHA;
  if (typeof sha !== "string" || sha.length !== 40 || !COMMIT_SHA.test(sha)) fail("Invalid release commit SHA");
  const pipelineId = positiveId(env.CI_PIPELINE_ID, "pipeline ID");
  const projectId = positiveId(env.CI_PROJECT_ID, "project ID");
  exact(projectId, PROJECT.id, "project ID");
  const defaultBranch = exact(env.CI_DEFAULT_BRANCH, PROJECT.defaultBranch, "default branch");
  const projectUrl = exact(env.CI_PROJECT_URL, PROJECT.url, "project URL");
  const serverUrl = exact(env.CI_SERVER_URL, PROJECT.serverUrl, "server URL");
  const apiUrl = exact(env.CI_API_V4_URL, PROJECT.apiUrl, "API URL");
  const registryHost = exact(env.CI_REGISTRY, PROJECT.registryHost, "registry host");
  const registry = exact(env.CI_REGISTRY_IMAGE, PROJECT.registry, "registry image");
  return {
    tag, version, sha, pipelineId, registry,
    projectId, defaultBranch, projectUrl, serverUrl, apiUrl, registryHost,
  };
}

/** Validate the complete CI identity before any release operation is allowed to write. */
export function validateRelease({ env, manifest, lock, notes, policy } = {}) {
  if (!isObject(manifest) || !isObject(lock)) fail("Invalid release input");
  const identity = validateReleaseEnvironment(env);
  if (manifest.version !== identity.version || lock.version !== identity.version || lock.packages?.[""]?.version !== identity.version) {
    fail("Release tag, package version and lockfile root version must agree");
  }
  if (typeof notes !== "string" || notes.trim().length === 0) fail("Committed release notes are required");

  // null is both a committed `null` file and an absent one (release-prepare.mjs). Anything else
  // is refused rather than stamped into the identity: a stale file must never authorize a release.
  if (policy !== null) fail(NO_RELEASE_EXCEPTION_APPROVED);

  // Always null now. The field stays so the prepared.json/release.json formats are unchanged
  // (ops/releases/README.md); retiring it and the per-write deadline checks is a release-format
  // change for the #316 review.
  return {
    ...identity,
    policyExpiresAt: null,
  };
}

/** Bind Docker-gate evidence to the already validated release identity. */
export function validateCandidate(identity, candidate) {
  if (!isObject(identity) || !isObject(candidate)) fail("Invalid release candidate");
  for (const key of ["tag", "sha", "pipelineId"]) {
    if (candidate[key] !== identity[key]) fail(`Release candidate ${key} does not match`);
  }
  const dockerJobId = positiveId(candidate.dockerJobId, "Docker job ID");
  const prefix = `${identity.registry}/candidates@`;
  if (typeof candidate.image !== "string" || !candidate.image.startsWith(prefix)) {
    fail("Release candidate must use the project candidate registry digest");
  }
  const digest = candidate.image.slice(prefix.length);
  if (digest.length !== 71 || !/^sha256:[0-9a-f]{64}$/.test(digest)) fail("Release candidate image must use a sha256 digest");
  return {
    tag: candidate.tag,
    sha: candidate.sha,
    pipelineId: candidate.pipelineId,
    dockerJobId,
    image: candidate.image,
    digest,
  };
}

/** Canonical metadata is intentionally deterministic: it contains no publication timestamp. */
export function releaseManifest(identity, candidate) {
  const valid = validateCandidate(identity, candidate);
  return {
    schemaVersion: 1,
    tag: identity.tag,
    version: identity.version,
    commit: identity.sha,
    pipeline: { id: identity.pipelineId, url: `${identity.projectUrl}/-/pipelines/${identity.pipelineId}` },
    dockerJobId: valid.dockerJobId,
    platform: "linux/amd64",
    image: `${identity.registry}/app@${valid.digest}`,
    policyExpiresAt: identity.policyExpiresAt,
  };
}
