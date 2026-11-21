import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { releaseManifest, validateCandidate } from "./release-policy.mjs";

function assertImage(image, digest) {
  if (!image || image.Digest !== digest) throw new Error("Release image digest conflict");
  if (image.Os !== "linux" || image.Architecture !== "amd64") throw new Error("Release image must be linux/amd64");
}

function assertRelease(bytes, expected, sha) {
  let actual;
  try { actual = JSON.parse(bytes); } catch { throw new Error("Existing release content conflict"); }
  const links = actual?.assets?.links?.map(({ name, url, link_type }) => ({ name, url, link_type }));
  if (actual?.commit?.id !== sha || actual?.tag_name !== expected.tag_name || actual?.name !== expected.name ||
      actual?.description !== expected.description || !isDeepStrictEqual(links, expected.assets.links)) {
    throw new Error("Existing release content conflict");
  }
}

/** The only injected boundaries are registry and GitLab transport. Every preflight precedes writes. */
export async function publishArtifact({ identity, candidate, notes, registry, api, clock }) {
  const assertDeadline = () => {
    const current = clock();
    if (!(current instanceof Date) || !Number.isFinite(current.getTime())) throw new Error("Invalid release validation time");
    if (identity.policyExpiresAt !== null && current.getTime() >= Date.parse(identity.policyExpiresAt)) {
      throw new Error(`Release policy expired at ${identity.policyExpiresAt}`);
    }
  };
  const valid = validateCandidate(identity, candidate);
  const manifest = releaseManifest(identity, candidate);
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const destination = `${identity.registry}/app:${identity.tag}`;
  const project = `${identity.apiUrl}/projects/${identity.projectId}`;
  const metadataUrl = `${project}/packages/generic/heatsynq-release/${identity.tag}/release.json`;
  const releaseUrl = `${project}/releases/${identity.tag}`;
  const expected = {
    name: `HeatSynQ ${identity.tag}`,
    tag_name: identity.tag,
    description: `${notes.trim()}\n\nImage: \`${manifest.image}\`\n\nSource: [${identity.sha}](${identity.projectUrl}/-/commit/${identity.sha})\n\nPipeline: [${identity.pipelineId}](${manifest.pipeline.url})\n\nTemporary dependency policy deadline: ${identity.policyExpiresAt ?? "none (no committed exception)"}.\n`,
    assets: { links: [{ name: "release.json", url: metadataUrl, link_type: "other" }] },
  };
  assertImage(await registry.inspect(valid.image), valid.digest);
  const existingImage = await registry.inspect(destination);
  if (existingImage !== null) assertImage(existingImage, valid.digest);
  const existingMetadata = await api.get(metadataUrl);
  if (existingMetadata !== null && existingMetadata !== bytes) throw new Error("Existing release metadata conflict");
  const existingRelease = await api.get(releaseUrl);
  if (existingRelease !== null) assertRelease(existingRelease, expected, identity.sha);
  const tagUrl = `${project}/repository/tags/${identity.tag}`;
  const assertRemoteTag = async () => {
    let tag;
    try { tag = JSON.parse(await api.get(tagUrl)); } catch { throw new Error("Unable to verify existing release tag"); }
    if (tag?.commit?.id !== identity.sha) throw new Error("Existing release tag does not match source commit");
  };
  await assertRemoteTag();

  if (existingImage === null) { assertDeadline(); await registry.copy(valid.image, destination); }
  assertImage(await registry.inspect(destination), valid.digest);
  if (existingMetadata === null) { assertDeadline(); await api.put(metadataUrl, bytes); }
  if (await api.get(metadataUrl) !== bytes) throw new Error("Persistent release metadata verification failed");
  if (existingRelease === null) {
    await assertRemoteTag();
    // Omitting ref prevents the Releases API from manufacturing a missing tag.
    assertDeadline();
    await api.post(`${project}/releases`, JSON.stringify(expected));
  }
  assertRelease(await api.get(releaseUrl), expected, identity.sha);
  return bytes;
}

/** Errors are deliberately generic: registry stderr may include credential-bearing URLs.
 * @param {{authFile: string, execute?: (command: string, args: string[], options: import("node:child_process").SpawnSyncOptionsWithStringEncoding) => {status: number | null, stderr?: string, stdout?: string, error?: Error}}} options
 */
export function skopeoRegistry({ authFile, execute = spawnSync }) {
  function run(args) {
    try {
      return execute("skopeo", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
    } catch { throw new Error("Registry command failed"); }
  }
  return {
    async inspect(image) {
      const result = run(["inspect", "--authfile", authFile, `docker://${image}`]);
      if (result.status !== 0 || result.error) {
        // Skopeo's containers/image Docker adapter emits this specific registry error for a
        // missing manifest. Repository absence, auth, transport and all ambiguous errors refuse.
        if (!result.error && result.status === 1 && /: manifest unknown: manifest unknown["\s]*$/.test(result.stderr ?? "")) return null;
        throw new Error("Registry inspection failed");
      }
      try { return JSON.parse(result.stdout); } catch { throw new Error("Invalid registry inspection response"); }
    },
    async copy(source, destination) {
      const result = run(["copy", "--all", "--preserve-digests", "--authfile", authFile, `docker://${source}`, `docker://${destination}`]);
      if (result.status !== 0 || result.error) throw new Error("Registry copy failed");
    },
  };
}

/** Only package GETs may follow signed HTTPS redirects; all follow-ups are credential-free. */
export function gitlabApi({ apiUrl, token, fetchImpl = fetch }) {
  if (!token) throw new Error("CI job token is required");
  async function request(method, url, body) {
    if (!url.startsWith(`${apiUrl}/projects/86201754/`) || !url.startsWith("https://gitlab.com/api/v4/")) {
      throw new Error("Invalid GitLab API destination");
    }
    const packageDownload = method === "GET" && url.startsWith(`${apiUrl}/projects/86201754/packages/generic/heatsynq-release/`);
    const signal = AbortSignal.timeout(30000);
    let target = url;
    let redirects = 0;
    while (true) {
      let response;
      try {
        response = await fetchImpl(target, {
          method, body, redirect: "manual", signal,
          headers: redirects > 0 ? {} : { "JOB-TOKEN": token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        });
      } catch { throw new Error(`GitLab ${method} request failed`); }
      if (packageDownload && [301, 302, 303, 307, 308].includes(response.status)) {
        if (redirects >= 3) throw new Error("Package download redirect limit exceeded");
        let next;
        try {
          const location = response.headers.get("location");
          if (!location) throw new Error();
          next = new URL(location, target);
        } catch { throw new Error("Unsafe package download redirect"); }
        if (next.protocol !== "https:" || next.username || next.password) throw new Error("Unsafe package download redirect");
        try { await response.body?.cancel(); } catch { throw new Error("Package download response failed"); }
        target = next.href;
        redirects++;
        continue;
      }
      // A storage 404 is a failed existing-object download, never a license to overwrite metadata.
      if (method === "GET" && redirects === 0 && response.status === 404) return null;
      if (!response.ok) throw new Error(`GitLab ${method} failed (${response.status})`);
      try { return await response.text(); } catch { throw new Error(`GitLab ${method} response failed`); }
    }
  }
  return {
    get: url => request("GET", url),
    put: (url, bytes) => request("PUT", url, bytes),
    post: (url, bytes) => request("POST", url, bytes),
  };
}
