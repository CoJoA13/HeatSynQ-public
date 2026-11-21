import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NO_RELEASE_EXCEPTION_APPROVED, releaseManifest, releaseVersion, validateCandidate, validateRelease } from "../scripts/lib/release-policy.mjs";
import { prepareRelease } from "../scripts/release-prepare.mjs";

const sha = "a".repeat(40);
const digest = "sha256:" + "b".repeat(64);
const registry = "registry.gitlab.com/synqsuite-group/heatsynq";
function fixture() {
  return {
    env: { CI_COMMIT_TAG: "v0.1.0-rc.1", CI_COMMIT_REF_PROTECTED: "true", CI_COMMIT_SHA: sha,
      CI_PIPELINE_ID: "42", CI_PROJECT_ID: "86201754", CI_DEFAULT_BRANCH: "main",
      CI_PROJECT_URL: "https://gitlab.com/synqsuite-group/HeatSynQ", CI_SERVER_URL: "https://gitlab.com",
      CI_API_V4_URL: "https://gitlab.com/api/v4", CI_REGISTRY: "registry.gitlab.com", CI_REGISTRY_IMAGE: registry },
    manifest: { version: "0.1.0-rc.1" },
    lock: { version: "0.1.0-rc.1", packages: { "": { version: "0.1.0-rc.1" } } },
    notes: "# Private release candidate\n\nFor dev-test.",
    policy: null as unknown, now: new Date("2026-09-22T13:28:06Z"),
  };
}
function candidate() {
  return { tag: "v0.1.0-rc.1", sha, pipelineId: "42", dockerJobId: "43", image: `${registry}/candidates@${digest}` };
}

const repositories: string[] = [];
afterEach(() => {
  for (const repository of repositories.splice(0)) rmSync(repository, { recursive: true, force: true });
});

function git(repository: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repositoryFixture() {
  const repository = mkdtempSync(path.join(tmpdir(), "heatsynq-release-policy-"));
  repositories.push(repository);
  mkdirSync(path.join(repository, "erp/security"), { recursive: true });
  mkdirSync(path.join(repository, "releases"), { recursive: true });
  writeFileSync(path.join(repository, "erp/package.json"), '{"version":"0.1.0-rc.1"}\n');
  writeFileSync(path.join(repository, "erp/package-lock.json"), '{"version":"0.1.0-rc.1","packages":{"":{"version":"0.1.0-rc.1"}}}\n');
  writeFileSync(path.join(repository, "erp/security/audit-exception.json"), "null\n");
  writeFileSync(path.join(repository, "releases/v0.1.0-rc.1.md"), "# Private release candidate\n\nFor dev-test.\n");
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Release Test");
  git(repository, "config", "user.email", "release-test@example.invalid");
  git(repository, "add", "erp/package.json", "erp/package-lock.json", "erp/security/audit-exception.json", "releases/v0.1.0-rc.1.md");
  git(repository, "commit", "-m", "release source");
  const commit = git(repository, "rev-parse", "HEAD");
  return { repository, commit };
}

function prepareInput(repository: string, commit: string) {
  const x = fixture();
  return { repository, env: { ...x.env, CI_COMMIT_SHA: commit }, now: x.now };
}

describe("release authorization and immutable artifact identity", () => {
  it("accepts the approved protected RC identity", () => {
    expect(validateRelease(fixture())).toEqual({
      tag: "v0.1.0-rc.1", version: "0.1.0-rc.1", sha, pipelineId: "42", registry,
      projectId: "86201754", defaultBranch: "main", projectUrl: "https://gitlab.com/synqsuite-group/HeatSynQ",
      serverUrl: "https://gitlab.com", apiUrl: "https://gitlab.com/api/v4", registryHost: "registry.gitlab.com",
      policyExpiresAt: null,
    });
  });
  it.each(["", "latest", "v01.1.0", "v1.0.0-rc.0", "v1.0.0-rc.01", "v1.0.0-beta.1", "v1.0.0+meta", "v1.0.0\n"])("refuses unsupported tag %j", (tag) => {
    const x=fixture(); x.env.CI_COMMIT_TAG=tag;
    expect(() => validateRelease(x)).toThrow(/tag/);
  });
  it("accepts a stable version only when every version agrees", () => {
    const x=fixture(); x.env.CI_COMMIT_TAG="v1.2.3"; x.manifest.version=x.lock.version=x.lock.packages[""].version="1.2.3";
    expect(validateRelease(x).version).toBe("1.2.3");
  });
  it.each(["v0.1.0-rc.1", "v12.34.56", "v12.34.56-rc.78"])("accepts supported version tag %s", (tag) => {
    const version = tag.slice(1);
    const x=fixture(); x.env.CI_COMMIT_TAG=tag; x.manifest.version=x.lock.version=x.lock.packages[""].version=version;
    expect(validateRelease(x).version).toBe(version);
  });
  it("rejects a final newline in a tag at the tag parser", () => {
    expect(() => releaseVersion("v1.2.3\n")).toThrow(/tag/);
  });
  it.each(["false", "", "TRUE"])("refuses unprotected refs %j", (value) => {
    const x=fixture(); x.env.CI_COMMIT_REF_PROTECTED=value;
    expect(() => validateRelease(x)).toThrow(/protected/);
  });
  it.each(["manifest", "lock", "root"])("refuses mismatched %s version", (field) => {
    const x=fixture();
    if(field==="manifest") x.manifest.version="0.2.0";
    else if(field==="lock") x.lock.version="0.2.0";
    else x.lock.packages[""].version="0.2.0";
    expect(() => validateRelease(x)).toThrow(/version/);
  });
  it("requires committed nonempty release notes", () => {
    expect(() => validateRelease({...fixture(), notes:" \n"})).toThrow(/notes/);
  });
  it.each(["CI_COMMIT_SHA", "CI_PIPELINE_ID", "CI_PROJECT_ID", "CI_DEFAULT_BRANCH"])("rejects malformed %s", (key) => {
    const x=fixture(); x.env[key as keyof typeof x.env]="../bad\n";
    expect(() => validateRelease(x)).toThrow();
  });
  it("rejects final newlines in SHA and numeric identifiers at their own guards", () => {
    const badSha=fixture(); badSha.env.CI_COMMIT_SHA=`${sha}\n`;
    expect(() => validateRelease(badSha)).toThrow(/SHA/);
    const badPipeline=fixture(); badPipeline.env.CI_PIPELINE_ID="42\n";
    expect(() => validateRelease(badPipeline)).toThrow(/pipeline ID/);
    const badProject=fixture(); badProject.env.CI_PROJECT_ID="86201754\n";
    expect(() => validateRelease(badProject)).toThrow(/project ID/);
  });
  it.each(["https://unrelated.invalid/api/v4", "http://gitlab.com/api/v4"])("refuses credential destination %s", (url) => {
    const x=fixture(); x.env.CI_API_V4_URL=url;
    expect(() => validateRelease(x)).toThrow(/API/);
  });
  it("refuses an unrelated registry image path", () => {
    const x=fixture(); x.env.CI_REGISTRY_IMAGE="evil.invalid/other/app";
    expect(() => validateRelease(x)).toThrow(/registry/);
  });
  // #209: the retired 16.2.12 window, and anything else, is refused rather than stamped into the
  // identity. Before the fix the committed file's own expiry passed and was published.
  it.each([
    ["the retired exception's exact expiry", { expiresAt: "2026-10-05T13:28:06.000Z" }],
    ["an arbitrary object", { anything: 1 }],
    ["an empty object", {}],
    ["false", false],
    ["undefined", undefined],
  ])("refuses a committed exception file holding %s", (_label, policy) => {
    expect(() => validateRelease({...fixture(), policy})).toThrow(NO_RELEASE_EXCEPTION_APPROVED);
  });
  it("accepts no exception with no deadline, at any clock", () => {
    for (const now of [new Date("2026-10-06T00:00:00Z"), new Date("2099-01-01T00:00:00Z"), new Date(NaN)]) {
      expect(validateRelease({...fixture(), now}).policyExpiresAt).toBeNull();
    }
  });
  it.each(["tag", "sha", "pipelineId", "dockerJobId", "image"])("refuses mismatched candidate %s", (key) => {
    const x=candidate(); x[key as keyof typeof x]="mismatch";
    expect(() => validateCandidate(validateRelease(fixture()), x)).toThrow();
  });
  it("requires a registry digest rather than a movable candidate tag", () => {
    expect(() => validateCandidate(validateRelease(fixture()), {...candidate(),image:`${registry}/candidates:p42-j43`})).toThrow(/digest/);
  });
  it("rejects a final newline in an otherwise valid digest", () => {
    expect(() => validateCandidate(validateRelease(fixture()), {...candidate(),image:`${registry}/candidates@${digest}\n`})).toThrow(/digest/);
  });
  it("records the promoted digest, source and gate pipeline deterministically", () => {
    const identity=validateRelease(fixture());
    expect(releaseManifest(identity,candidate())).toEqual({ schemaVersion:1, tag:"v0.1.0-rc.1", version:"0.1.0-rc.1", commit:sha,
      pipeline:{ id:"42", url:"https://gitlab.com/synqsuite-group/HeatSynQ/-/pipelines/42" },
      dockerJobId:"43", platform:"linux/amd64", image:`${registry}/app@${digest}`, policyExpiresAt:null });
  });
});

describe("release preparation from the checked source", () => {
  it("reads package, notes and policy bytes from the validated commit before writing evidence", () => {
    const { repository, commit } = repositoryFixture();
    git(repository, "tag", "v0.1.0-rc.1");
    writeFileSync(path.join(repository, "erp/package.json"), '{"version":"9.9.9"}\n');
    writeFileSync(path.join(repository, "releases/v0.1.0-rc.1.md"), "working-tree mutation\n");

    const identity = prepareRelease(prepareInput(repository, commit));

    expect(identity.version).toBe("0.1.0-rc.1");
    expect(JSON.parse(readFileSync(path.join(repository, "release/prepared.json"), "utf8"))).toEqual(identity);
  });

  it("can revalidate committed source for publication without overwriting prepared evidence", () => {
    const { repository, commit } = repositoryFixture();
    git(repository, "tag", "v0.1.0-rc.1");

    const identity = prepareRelease({ ...prepareInput(repository, commit), writeEvidence: false });

    expect(identity.sha).toBe(commit);
    expect(existsSync(path.join(repository, "release/prepared.json"))).toBe(false);
  });

  it("allows a commit whose exception file is absent", () => {
    const { repository } = repositoryFixture();
    git(repository, "rm", "erp/security/audit-exception.json");
    git(repository, "commit", "-m", "remove expired policy");
    git(repository, "tag", "v0.1.0-rc.1");
    const commit = git(repository, "rev-parse", "HEAD");

    const identity = prepareRelease(prepareInput(repository, commit));

    expect(identity.policyExpiresAt).toBeNull();
  });

  it("refuses a committed non-null exception file before writing evidence", () => {
    const { repository } = repositoryFixture();
    writeFileSync(path.join(repository, "erp/security/audit-exception.json"), '{"expiresAt":"2026-10-05T13:28:06.000Z"}\n');
    git(repository, "commit", "-am", "stale exception");
    git(repository, "tag", "v0.1.0-rc.1");
    const commit = git(repository, "rev-parse", "HEAD");

    expect(() => prepareRelease(prepareInput(repository, commit))).toThrow(NO_RELEASE_EXCEPTION_APPROVED);
    expect(existsSync(path.join(repository, "release/prepared.json"))).toBe(false);
  });

  it("refuses a checkout other than the candidate commit before writing evidence", () => {
    const { repository, commit } = repositoryFixture();
    git(repository, "tag", "v0.1.0-rc.1");
    writeFileSync(path.join(repository, "marker"), "later\n");
    git(repository, "add", "marker");
    git(repository, "commit", "-m", "later checkout");

    expect(() => prepareRelease(prepareInput(repository, commit))).toThrow(/checkout/);
    expect(existsSync(path.join(repository, "release/prepared.json"))).toBe(false);
  });

  it("refuses when the version tag names another commit before writing evidence", () => {
    const { repository } = repositoryFixture();
    git(repository, "tag", "v0.1.0-rc.1");
    writeFileSync(path.join(repository, "marker"), "later\n");
    git(repository, "add", "marker");
    git(repository, "commit", "-m", "later candidate");
    const commit = git(repository, "rev-parse", "HEAD");

    expect(() => prepareRelease(prepareInput(repository, commit))).toThrow(/tag/);
    expect(existsSync(path.join(repository, "release/prepared.json"))).toBe(false);
  });

  it("refuses a tagged commit not contained in main before writing evidence", () => {
    const { repository } = repositoryFixture();
    git(repository, "switch", "-c", "topic");
    writeFileSync(path.join(repository, "marker"), "topic\n");
    git(repository, "add", "marker");
    git(repository, "commit", "-m", "unmerged candidate");
    git(repository, "tag", "v0.1.0-rc.1");
    const commit = git(repository, "rev-parse", "HEAD");

    expect(() => prepareRelease(prepareInput(repository, commit))).toThrow(/main/);
    expect(existsSync(path.join(repository, "release/prepared.json"))).toBe(false);
  });
});
