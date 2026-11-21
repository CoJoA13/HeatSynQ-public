// Client-safe and pure, no imports: release versions ("1.4.0", "1.4.0-rc.2"), as the release
// contracts name them. The accepted set is exactly the contracts' `version` regex
// (src/lib/release-contracts.ts keeps its own copy: next.config.ts loads this leaf at build time
// and the rail reads it, so it stays free of the contracts' zod schemas; tests/release-version.test.ts
// runs both against the same cases so they cannot drift).

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-rc\.[1-9]\d*)?$/;

export type ParsedVersion = { major: number; minor: number; patch: number; rc: number | null };

/** The parts of a version, or null for anything the pattern refuses (a `v` prefix, a leading
 *  zero, rc.0, whitespace). */
export function parseVersion(text: string): ParsedVersion | null {
  const m = VERSION.exec(text);
  if (!m) return null;
  return {
    major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]),
    rc: m[4] === undefined ? null : Number(m[4].slice(4)),
  };
}

/** Negative, 0 or positive. A release candidate sorts before its release (1.4.0-rc.2 < 1.4.0).
 *  Throws on a version `parseVersion` refuses. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x) throw new Error(`Not a release version: ${JSON.stringify(a)}`);
  if (!y) throw new Error(`Not a release version: ${JSON.stringify(b)}`);
  if (x.major !== y.major) return x.major - y.major;
  if (x.minor !== y.minor) return x.minor - y.minor;
  if (x.patch !== y.patch) return x.patch - y.patch;
  if (x.rc === y.rc) return 0;
  if (x.rc === null) return 1;
  if (y.rc === null) return -1;
  return x.rc - y.rc;
}

/** The version a release-version.txt holds: its text trimmed and checked. Throws, naming the file,
 *  for anything `parseVersion` refuses, so a bad file fails the build rather than label an install. */
export function readReleaseVersion(text: string): string {
  const version = text.trim();
  if (!parseVersion(version)) {
    throw new Error(
      `release-version.txt must hold one release version such as 1.4.0 or 1.4.0-rc.2, not ${JSON.stringify(version)}.`,
    );
  }
  return version;
}

/** True for a release candidate. Throws on a version `parseVersion` refuses. */
export function isPrerelease(version: string): boolean {
  const p = parseVersion(version);
  if (!p) throw new Error(`Not a release version: ${JSON.stringify(version)}`);
  return p.rc !== null;
}
