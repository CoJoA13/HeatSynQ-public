import { describe, expect, it } from "vitest";
import { compareVersions, isPrerelease, parseVersion, readReleaseVersion } from "@/lib/release-version";
import { releaseManifestSchema } from "@/lib/release-contracts";

describe("parseVersion", () => {
  it("reads a release and a release candidate", () => {
    expect(parseVersion("1.4.0")).toEqual({ major: 1, minor: 4, patch: 0, rc: null });
    expect(parseVersion("1.4.0-rc.2")).toEqual({ major: 1, minor: 4, patch: 0, rc: 2 });
  });
  it.each(["1.02.0", "v1.0.0", "1.0.0-rc.0", "1.0", "1.0.0-rc.01", "1.0.0-beta.1", " 1.0.0", "1.0.0\n", ""])(
    "refuses %j", (text) => expect(parseVersion(text)).toBeNull());
});

describe("compareVersions", () => {
  it("orders rc before release and numerically", () => {
    const shuffled = ["1.10.0", "1.2.0", "1.2.0-rc.1", "1.2.0-rc.10", "1.2.0-rc.2"];
    expect([...shuffled].sort(compareVersions)).toEqual(["1.2.0-rc.1", "1.2.0-rc.2", "1.2.0-rc.10", "1.2.0", "1.10.0"]);
    expect(compareVersions("1.2.0", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.0", "1.2.0-rc.9")).toBeGreaterThan(0);
  });
  it("throws on an unparsable version", () => {
    expect(() => compareVersions("v1.0.0", "1.0.0")).toThrow(/Not a release version/);
    expect(() => compareVersions("1.0.0", "x")).toThrow(/Not a release version/);
  });
});

describe("isPrerelease", () => {
  it("is true only for an rc", () => {
    expect(isPrerelease("1.0.0-rc.1")).toBe(true);
    expect(isPrerelease("1.0.0")).toBe(false);
    expect(() => isPrerelease("1.0")).toThrow();
  });
});

describe("agrees with the release contracts' version pattern", () => {
  const cases = ["1.4.0", "0.0.0", "1.4.0-rc.1", "1.4.0-rc.12", "1.02.0", "v1.0.0", "1.0.0-rc.0", "1.0.0-rc.01",
    "1.0", "01.0.0", "1.0.0-rc", "1.0.0+x", " 1.0.0", "1.0.0\n", ""];
  const manifestWith = (version: string) => ({
    version, tag: `v${version}`, prerelease: /-rc\.\d+$/.test(version),
  });
  it.each(cases)("%j", (text) => {
    const contract = releaseManifestSchema.safeParse({ ...manifestWith(text) });
    const versionIssue = !contract.success && contract.error.issues.some((i) => i.path[0] === "version");
    expect(parseVersion(text) !== null).toBe(!versionIssue);
  });
});

describe("readReleaseVersion", () => {
  it("trims the file's text", () => {
    expect(readReleaseVersion("1.4.0\n")).toBe("1.4.0");
    expect(readReleaseVersion("  1.4.0-rc.2 \r\n")).toBe("1.4.0-rc.2");
  });
  it.each(["", "\n", "v1.4.0", "1.4", "1.4.0\n1.4.1", "latest"])("throws, naming the file, for %j", (text) => {
    expect(() => readReleaseVersion(text)).toThrow(/release-version\.txt must hold one release version/);
  });
});
