import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareRelease } from "../scripts/release-prepare.mjs";
import { publishRelease, refreshReleaseRefs, captureCandidate, releaseFailureMessage } from "../scripts/publish-release.mjs";
import { gitlabApi, skopeoRegistry } from "../scripts/lib/release-publish.mjs";
import { NO_RELEASE_EXCEPTION_APPROVED } from "../scripts/lib/release-policy.mjs";

const registry = "registry.gitlab.com/synqsuite-group/heatsynq";
const digest = `sha256:${"b".repeat(64)}`;
const now = new Date("2026-09-22T13:28:06Z");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(root: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function fixture() {
  const repository = mkdtempSync(path.join(tmpdir(), "release-publish-")); roots.push(repository);
  mkdirSync(path.join(repository, "erp/security"), { recursive: true });
  mkdirSync(path.join(repository, "releases"));
  writeFileSync(path.join(repository, "erp/package.json"), '{"version":"0.1.0-rc.1"}');
  writeFileSync(path.join(repository, "erp/package-lock.json"), '{"version":"0.1.0-rc.1","packages":{"":{"version":"0.1.0-rc.1"}}}');
  writeFileSync(path.join(repository, "erp/security/audit-exception.json"), "null\n");
  writeFileSync(path.join(repository, "releases/v0.1.0-rc.1.md"), "# Committed private RC\n\nFor dev-test.\n");
  git(repository, "init", "-b", "main"); git(repository, "config", "user.name", "Test"); git(repository, "config", "user.email", "test@example.invalid");
  git(repository, "add", "."); git(repository, "commit", "-m", "source"); git(repository, "tag", "v0.1.0-rc.1");
  // A real local origin exercises fresh Git ref validation without network or maintained state.
  const origin = `${repository}-origin`; roots.push(origin); git(repository, "clone", "--bare", repository, origin);
  git(repository, "remote", "add", "origin", origin);
  const env = { CI_PIPELINE_SOURCE: "push", CI_COMMIT_TAG: "v0.1.0-rc.1", CI_COMMIT_SHA: git(repository, "rev-parse", "HEAD"), CI_COMMIT_REF_PROTECTED: "true",
    CI_PIPELINE_ID: "42", CI_JOB_ID: "43", CI_PROJECT_ID: "86201754", CI_DEFAULT_BRANCH: "main",
    CI_PROJECT_URL: "https://gitlab.com/synqsuite-group/HeatSynQ", CI_SERVER_URL: "https://gitlab.com", CI_API_V4_URL: "https://gitlab.com/api/v4",
    CI_REGISTRY: "registry.gitlab.com", CI_REGISTRY_IMAGE: registry, CI_JOB_TOKEN: "SECRET", CI_REGISTRY_USER: "gitlab-ci-token", CI_REGISTRY_PASSWORD: "SECRET" };
  const identity = prepareRelease({ repository, env, now });
  const candidate = { tag: identity.tag, sha: identity.sha, pipelineId: "42", dockerJobId: "43", image: `${registry}/candidates@${digest}` };
  const save = (file: string, value: unknown) => writeFileSync(path.join(repository, "release", file), JSON.stringify(value));
  save("candidate.json", candidate);
  const writes: string[] = [];
  const source = { Digest: digest, Os: "linux", Architecture: "amd64" };
  const state: { image: typeof source | null; metadata: string | null; release: Record<string, unknown> | null; fail: string; readback: boolean } =
    { image: null, metadata: null, release: null, fail: "", readback: false };
  const registryApi = {
    inspect: async (image: string) => image.includes("/candidates@") ? source : state.image,
    copy: async () => { writes.push("image"); state.image = { ...source }; if (state.fail === "image") throw new Error("transfer failed"); },
  };
  const api = {
    get: async (url: string) => {
      if (state.fail === "get") throw new Error("GitLab GET failed (403)");
      if (url.includes("/repository/tags/")) return JSON.stringify({ commit: { id: identity.sha } });
      if (url.includes("/packages/")) return state.readback && state.metadata ? "corrupt" : state.metadata;
      return state.release ? JSON.stringify(state.release) : null;
    },
    put: async (_url: string, bytes: string) => { writes.push("metadata"); state.metadata = bytes; if (state.fail === "metadata") throw new Error("upload failed"); },
    post: async (_url: string, bytes: string) => { writes.push("release"); state.release = { ...JSON.parse(bytes), commit: { id: identity.sha } }; if (state.fail === "release") throw new Error("response lost"); },
  };
  const run = (clock = now) => publishRelease({ repository, env, now: clock, clock: () => clock, registry: registryApi, api });
  return { repository, origin, env, identity, candidate, source, state, writes, save, run, registryApi, api };
}

describe("publication through real Git, policy and publisher sequence", () => {
  it("promotes the captured digest, verifies persistent deterministic metadata, and creates committed release notes", async () => {
    const f = fixture();
    await f.run();
    expect(f.writes).toEqual(["image", "metadata", "release"]);
    const bytes = readFileSync(path.join(f.repository, "release/release.json"), "utf8");
    expect(f.state.metadata).toBe(bytes);
    expect(JSON.parse(bytes)).toMatchObject({ image: `${registry}/app@${digest}`, commit: f.identity.sha, dockerJobId: "43", platform: "linux/amd64" });
    expect(f.state.release).toMatchObject({ tag_name: "v0.1.0-rc.1", name: "HeatSynQ v0.1.0-rc.1" });
    const description = String(f.state.release?.description);
    for (const text of ["# Committed private RC", f.identity.sha, digest, "/pipelines/42", "Temporary dependency policy deadline: none (no committed exception)."]) expect(description).toContain(text);
    expect(JSON.parse(bytes).policyExpiresAt).toBeNull();
    expect(f.state.release).not.toHaveProperty("ref");
    f.writes.length = 0; await f.run(); expect(f.writes).toEqual([]);
  });
  it.each(["tag", "sha", "pipelineId", "dockerJobId", "image"])("refuses candidate %s mismatch without publication writes", async (key) => {
    const f = fixture(); f.save("candidate.json", { ...f.candidate, [key]: "wrong" });
    await expect(f.run()).rejects.toThrow(/candidate|Docker job/); expect(f.writes).toEqual([]);
  });
  it("reads original prepared evidence before revalidation and refuses a different identity", async () => {
    const f = fixture(); const wrong = { ...f.identity, pipelineId: "99" }; f.save("prepared.json", wrong);
    await expect(f.run()).rejects.toThrow(/prepared/i); expect(f.writes).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(f.repository, "release/prepared.json"), "utf8"))).toEqual(wrong);
  });
  it.each(["Os", "Architecture"])("refuses a candidate with unsupported %s before any write", async key => {
    const f = fixture(); f.source[key as "Os" | "Architecture"] = "unsupported";
    await expect(f.run()).rejects.toThrow(/linux\/amd64/); expect(f.writes).toEqual([]);
  });
  it("refuses a source digest mismatch", async () => {
    const f = fixture(); f.source.Digest = `sha256:${"c".repeat(64)}`;
    await expect(f.run()).rejects.toThrow(/digest/); expect(f.writes).toEqual([]);
  });
  it.each(["image", "metadata", "release"])("preflights conflicting existing %s before any write", async kind => {
    const f = fixture();
    if (kind === "image") f.state.image = { ...f.source, Digest: `sha256:${"c".repeat(64)}` };
    if (kind === "metadata") f.state.metadata = "conflict";
    if (kind === "release") f.state.release = { tag_name: f.identity.tag, description: "conflict" };
    await expect(f.run()).rejects.toThrow(/conflict|digest/); expect(f.writes).toEqual([]);
  });
  it("refuses an invalid release clock before any write", async () => {
    const f = fixture(); await expect(f.run(new Date(NaN))).rejects.toThrow(/validation time/); expect(f.writes).toEqual([]);
  });
  it("refuses prepared evidence still carrying the retired policy deadline (#209)", async () => {
    const f = fixture(); f.save("prepared.json", { ...f.identity, policyExpiresAt: "2026-10-05T13:28:06.000Z" });
    await expect(f.run()).rejects.toThrow(/prepared/i); expect(f.writes).toEqual([]);
  });
  it("fails closed on non-404 API read errors", async () => {
    const f = fixture(); f.state.fail = "get"; await expect(f.run()).rejects.toThrow(/403/); expect(f.writes).toEqual([]);
  });
  it.each(["image", "metadata", "release"])("stops after a failed %s write and recovers an identical partial retry", async phase => {
    const f = fixture(); f.state.fail = phase;
    await expect(f.run()).rejects.toThrow(/failed|lost/);
    expect(f.writes).toEqual(["image", "metadata", "release"].slice(0, ["image", "metadata", "release"].indexOf(phase) + 1));
    f.state.fail = ""; await f.run();
    expect(f.writes).toEqual(["image", "metadata", "release"]);
  });
  it("does not create a release after metadata read-back mismatch", async () => {
    const f = fixture(); f.state.readback = true; await expect(f.run()).rejects.toThrow(/metadata/); expect(f.writes).toEqual(["image", "metadata"]);
  });
  it("does not upload metadata after destination verification fails", async () => {
    const f = fixture(); f.registryApi.copy = async () => { f.writes.push("image"); f.state.image = { ...f.source, Architecture: "arm64" }; };
    await expect(f.run()).rejects.toThrow(/linux\/amd64/); expect(f.writes).toEqual(["image"]);
  });
  it("refuses an existing release pointing at a different commit", async () => {
    const f = fixture(); await f.run(); f.writes.length = 0; f.state.release!.commit = { id: "c".repeat(40) };
    await expect(f.run()).rejects.toThrow(/release.*conflict/i); expect(f.writes).toEqual([]);
  });
  it("refreshes the actual remote tag and refuses its deletion instead of trusting a stale local tag", async () => {
    const f = fixture(); git(f.origin, "tag", "-d", f.identity.tag);
    await expect(f.run()).rejects.toThrow(/refresh/); expect(f.writes).toEqual([]);
  });
  it("refreshes moved remote tag and refuses a different commit", async () => {
    const f = fixture(); writeFileSync(path.join(f.repository, "marker"), "later"); git(f.repository, "add", "marker"); git(f.repository, "commit", "-m", "later");
    git(f.repository, "push", "origin", "HEAD:refs/tags/v0.1.0-rc.1", "--force"); git(f.repository, "reset", "--hard", f.identity.sha);
    await expect(f.run()).rejects.toThrow(/tag/); expect(f.writes).toEqual([]);
  });
});

describe("external adapters", () => {
  it.each([401, 403, 429, 500, 302])("API GET fails closed on HTTP %s without following redirects or exposing token", async status => {
    const calls: unknown[] = [];
    const api = gitlabApi({ apiUrl: "https://gitlab.com/api/v4", token: "SECRET", fetchImpl: async (_url, options) => {
      calls.push(options); return new Response("SECRET", { status, headers: { Location: "https://storage.invalid/signed?SECRET" } });
    } });
    await expect(api.get("https://gitlab.com/api/v4/projects/86201754/releases/v1.0.0")).rejects.toThrow(`GitLab GET failed (${status})`);
    expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ redirect: "manual", headers: { "JOB-TOKEN": "SECRET" } });
  });
  it("API GET recognizes only 404 absence", async () => {
    const api = gitlabApi({ apiUrl: "https://gitlab.com/api/v4", token: "SECRET", fetchImpl: async () => new Response("", { status: 404 }) });
    expect(await api.get("https://gitlab.com/api/v4/projects/86201754/releases/v1.0.0")).toBeNull();
  });
  it.each(["unauthorized: authentication required", "dial tcp: timeout", "manifest unknown: unauthorized", "name unknown: repository not found"])("registry refuses ambiguous failure %s", async stderr => {
    const r = skopeoRegistry({ authFile: "/private/auth.json", execute: () => ({ status: 1, stderr }) });
    await expect(r.inspect(`${registry}/app:v0.1.0-rc.1`)).rejects.toThrow("Registry inspection failed");
  });
  it("recognizes specific manifest absence, and uses authenticated digest-preserving copy", async () => {
    const calls: string[][] = [];
    const r = skopeoRegistry({ authFile: "/private/auth.json", execute: (_cmd: string, args: string[]) => { calls.push(args); return args[0] === "inspect" ? { status: 1, stderr: 'reading manifest v0.1.0-rc.1: manifest unknown: manifest unknown' } : { status: 0 }; } });
    expect(await r.inspect(`${registry}/app:v0.1.0-rc.1`)).toBeNull();
    await r.copy(`${registry}/candidates@${digest}`, `${registry}/app:v0.1.0-rc.1`);
    expect(calls[1]).toEqual(["copy", "--all", "--preserve-digests", "--authfile", "/private/auth.json", `docker://${registry}/candidates@${digest}`, `docker://${registry}/app:v0.1.0-rc.1`]);
  });
  it("sanitizes registry transfer and Git refresh diagnostics", async () => {
    const r = skopeoRegistry({ authFile: "/private/auth.json", execute: () => ({ status: 1, stderr: "SECRET" }) });
    await expect(r.copy("source", "target")).rejects.toThrow(/^Registry copy failed$/);
    const f = fixture(); git(f.repository, "remote", "set-url", "origin", "/absent/SECRET");
    expect(() => refreshReleaseRefs({ repository: f.repository, env: f.env })).toThrow(/^Unable to refresh release refs$/);
  });
});


describe("candidate capture uses the tested local image", () => {
  function dockerFixture() {
    const f = fixture(); const events: string[] = [];
    const docker = {
      inspectLocal: async (image: string) => { events.push(`inspect:${image}`); return { Os: "linux", Architecture: "amd64" }; },
      tag: async (image: string, target: string) => { events.push(`tag:${image}:${target}`); },
      push: async (target: string) => { events.push(`push:${target}`); },
      repoDigests: async () => [f.candidate.image],
    };
    const run = (env = f.env) => captureCandidate({ repository: f.repository, env, now, clock: () => now, docker });
    return { ...f, docker, events, run };
  }
  it("tags and pushes exactly heatsynq-app:ci, then captures its repository digest", async () => {
    const f = dockerFixture(); expect(await f.run()).toEqual(f.candidate);
    expect(f.events).toEqual(["inspect:heatsynq-app:ci", `tag:heatsynq-app:ci:${registry}/candidates:p42-j43`, `push:${registry}/candidates:p42-j43`]);
    expect(JSON.parse(readFileSync(path.join(f.repository, "release/candidate.json"), "utf8"))).toEqual(f.candidate);
  });
  // The per-write deadline is inert with no exception (policyExpiresAt is always null); the clock
  // re-check it shares still runs at the same point, which is what an invalid clock proves.
  it.each(["inspection", "tagging"])("refuses candidate push if the clock becomes invalid during local %s", async phase => {
    const f = dockerFixture();
    let time = new Date("2026-10-05T13:28:05.999Z");
    const advance = () => { time = new Date(NaN); };
    if (phase === "inspection") {
      const inspect = f.docker.inspectLocal;
      f.docker.inspectLocal = async image => { const result = await inspect(image); advance(); return result; };
    } else {
      const tag = f.docker.tag;
      f.docker.tag = async (image, target) => { await tag(image, target); advance(); };
    }
    f.save("candidate.json", { sentinel: true });
    await expect(captureCandidate({ repository: f.repository, env: f.env, now: time, clock: () => time, docker: f.docker })).rejects.toThrow(/validation time/);
    expect(f.events.filter(event => event.startsWith("push:"))).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(f.repository, "release/candidate.json"), "utf8"))).toEqual({ sentinel: true });
  });
  it("refuses mismatched prepared identity before even tagging a local image", async () => {
    const f = dockerFixture(); f.save("prepared.json", { ...f.identity, sha: "c".repeat(40) });
    await expect(f.run()).rejects.toThrow(/prepared/); expect(f.events).toEqual([]);
  });
  it.each(["merge_request_event", "schedule", "web"])("refuses %s registry capture", async source => {
    const f = dockerFixture(); await expect(f.run({ ...f.env, CI_PIPELINE_SOURCE: source })).rejects.toThrow(/push tag/); expect(f.events).toEqual([]);
  });
  it("refuses branch capture without a tag", async () => {
    const f = dockerFixture(); await expect(f.run({ ...f.env, CI_COMMIT_TAG: "" })).rejects.toThrow(/tag/); expect(f.events).toEqual([]);
  });
  it("refuses push failure without replacing evidence", async () => {
    const f = dockerFixture(); f.save("candidate.json", { sentinel: true }); f.docker.push = async () => { throw new Error("push failed"); };
    await expect(f.run()).rejects.toThrow(/push failed/);
    expect(JSON.parse(readFileSync(path.join(f.repository, "release/candidate.json"), "utf8"))).toEqual({ sentinel: true });
  });
  it("refuses unsupported local platform before tag/push", async () => {
    const f = dockerFixture(); f.docker.inspectLocal = async () => ({ Os: "linux", Architecture: "arm64" });
    await expect(f.run()).rejects.toThrow(/linux\/amd64/); expect(f.events).toEqual([]);
  });
});

describe("generic package signed-storage downloads", () => {
  const url = "https://gitlab.com/api/v4/projects/86201754/packages/generic/heatsynq-release/v0.1.0-rc.1/release.json";
  it("follows a signed HTTPS GET with no credentials and one shared deadline", async () => {
    const calls: { url: string; options?: RequestInit }[] = [];
    const api = gitlabApi({ apiUrl: "https://gitlab.com/api/v4", token: "SECRET", fetchImpl: async (target, options) => {
      calls.push({ url: String(target), options });
      return calls.length === 1 ? new Response("", { status: 302, headers: { Location: "https://storage.invalid/object?signature=PRIVATE" } }) : new Response("canonical bytes");
    } });
    expect(await api.get(url)).toBe("canonical bytes");
    expect(calls).toHaveLength(2);
    expect(calls[1].options).toMatchObject({ method: "GET", redirect: "manual" });
    expect(calls[1].options?.headers).toEqual({});
    expect(calls[1].options?.signal).toBe(calls[0].options?.signal);
  });
  it.each(["http://storage.invalid/object", "https://user:SECRET@storage.invalid/object"])("refuses unsafe storage target %s", async location => {
    let calls = 0;
    const api = gitlabApi({ apiUrl: "https://gitlab.com/api/v4", token: "SECRET", fetchImpl: async () => { calls++; return new Response("", { status: 302, headers: { Location: location } }); } });
    await expect(api.get(url)).rejects.toThrow(/^Unsafe package download redirect$/); expect(calls).toBe(1);
  });
  it("bounds redirect loops without logging signed URLs", async () => {
    let calls = 0;
    const api = gitlabApi({ apiUrl: "https://gitlab.com/api/v4", token: "SECRET", fetchImpl: async () => { calls++; return new Response("", { status: 302, headers: { Location: "https://storage.invalid/object?signature=PRIVATE" } }); } });
    await expect(api.get(url)).rejects.toThrow(/^Package download redirect limit exceeded$/); expect(calls).toBe(4);
  });
  it.each(["put", "post"] as const)("never redirects %s credentials or writes", async method => {
    let calls = 0;
    const api = gitlabApi({ apiUrl: "https://gitlab.com/api/v4", token: "SECRET", fetchImpl: async () => { calls++; return new Response("", { status: 307, headers: { Location: "https://storage.invalid/object" } }); } });
    await expect(api[method](url, "bytes")).rejects.toThrow(`GitLab ${method.toUpperCase()} failed (307)`); expect(calls).toBe(1);
  });
  it("does not treat a redirected storage 404 as permission to create a missing package", async () => {
    let calls = 0;
    const api = gitlabApi({ apiUrl: "https://gitlab.com/api/v4", token: "SECRET", fetchImpl: async () => {
      calls++; return calls === 1 ? new Response("", { status: 302, headers: { Location: "https://storage.invalid/object" } }) : new Response("", { status: 404 });
    } });
    await expect(api.get(url)).rejects.toThrow(/^GitLab GET failed \(404\)$/); expect(calls).toBe(2);
  });
});


describe("CI diagnostic redaction", () => {
  it("preserves allow-listed refusal labels without printing arbitrary exception text", () => {
    expect(releaseFailureMessage(new Error("Unable to refresh release refs"))).toBe("Unable to refresh release refs");
    expect(releaseFailureMessage(new Error("GitLab GET failed (403)"))).toBe("GitLab GET failed (403)");
    expect(releaseFailureMessage(new Error("Registry copy failed"))).toBe("Registry copy failed");
    // #209: the no-exception refusal replaced the retired expiry message in the allow-list.
    expect(releaseFailureMessage(new Error(NO_RELEASE_EXCEPTION_APPROVED))).toBe(NO_RELEASE_EXCEPTION_APPROVED);
    expect(releaseFailureMessage(new Error("Release policy expired at 2026-10-05T13:28:06.000Z")))
      .toBe("Release operation refused; verify release identity, policy and publication evidence");
    for (const error of [new Error("fetch https://storage.invalid/?signature=SECRET"), new Error("GitLab GET failed (403) SECRET"), new Error("SECRET"), { message: "SECRET" }]) {
      expect(releaseFailureMessage(error)).toBe("Release operation refused; verify release identity, policy and publication evidence");
    }
  });
});


describe("fresh release clock at each publication write", () => {
  it.each(["copy", "metadata readback"])("refuses later writes when the clock becomes invalid during %s", async phase => {
    const f = fixture(); let time = new Date("2026-10-05T13:28:05.999Z");
    const advance = () => { time = new Date(NaN); };
    if (phase === "copy") {
      const copy = f.registryApi.copy;
      f.registryApi.copy = async () => { await copy(); advance(); };
    } else {
      const get = f.api.get;
      f.api.get = async url => { const result = await get(url); if (url.includes("/packages/") && f.state.metadata) advance(); return result; };
    }
    await expect(publishRelease({ repository: f.repository, env: f.env, now: time, clock: () => time, registry: f.registryApi, api: f.api })).rejects.toThrow(/validation time/);
    expect(f.writes).toEqual(phase === "copy" ? ["image"] : ["image", "metadata"]);
  });
});
