// The build version at the foot of the nav rail (#542): "Build Version: MMDDYY · <short commit>",
// the commit's own date read in the plant's time zone (owner, 2026-10-15). The stamp comes from
// erp/build-stamp.txt, which `git archive` fills in (export-subst: the .182 deploy agent and the
// devtest rebuild build from an archive), or from git in a checkout; next.config.ts bakes the label.
// The archive case reads this repository's own git state, so the suite needs a git checkout with the
// stamp file and .gitattributes committed (it fails in an exported tree, where the stamp is filled).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildVersionLabel, parseBuildStamp, railVersion } from "@/lib/build-version";

const SHA = "0f5eb589430f021dd7af23ebac4d2648443ccbe6";

describe("parseBuildStamp", () => {
  it("reads a full commit and its ISO date, and keeps seven characters of the commit", () => {
    expect(parseBuildStamp(`${SHA} 2026-10-15T11:15:09-05:00`)).toEqual({ commit: "0f5eb58", date: "101526" });
  });
  it("dates a commit by the plant's calendar, not UTC: 9:30 PM Central on the 15th is the 15th", () => {
    expect(parseBuildStamp(`${SHA} 2026-10-16T02:30:00Z`)?.date).toBe("101526");
  });
  it("dates across the spring and fall clock changes in Central time", () => {
    expect(parseBuildStamp(`${SHA} 2026-03-08T07:30:00Z`)?.date).toBe("030826"); // 1:30 AM CST, 8 Mar
    expect(parseBuildStamp(`${SHA} 2026-03-08T08:30:00Z`)?.date).toBe("030826"); // 3:30 AM CDT, 8 Mar
    expect(parseBuildStamp(`${SHA} 2026-11-01T04:30:00Z`)?.date).toBe("103126"); // 11:30 PM CDT, 31 Oct
    expect(parseBuildStamp(`${SHA} 2026-11-01T06:30:00Z`)?.date).toBe("110126"); // 1:30 AM, 1 Nov
  });
  it("follows the clock change itself: a fixed UTC-6 or a fixed UTC-5 would each get one of these wrong", () => {
    expect(parseBuildStamp(`${SHA} 2026-07-01T05:30:00Z`)?.date).toBe("070126"); // 12:30 AM CDT; UTC-6 says 30 Jun
    expect(parseBuildStamp(`${SHA} 2026-01-15T05:30:00Z`)?.date).toBe("011426"); // 11:30 PM CST; UTC-5 says 15 Jan
  });
  it("reads a stamp with surrounding whitespace, as a file or git prints it", () => {
    expect(parseBuildStamp(`  ${SHA} 2026-10-15T11:15:09-05:00\n`)).toEqual({ commit: "0f5eb58", date: "101526" });
  });
  it.each([
    ["the placeholder git has not filled in", "$Format:%H %cI$"],
    ["an empty stamp", ""],
    ["a short commit", "0f5eb58 2026-10-15T11:15:09-05:00"],
    ["no date", SHA],
    ["a date that is no date", `${SHA} yesterday`],
  ])("gives none for %s", (_label, text) => {
    expect(parseBuildStamp(text)).toBeNull();
  });
});

describe("buildVersionLabel", () => {
  it("is MMDDYY, a middle dot and the short commit", () => {
    expect(buildVersionLabel(`${SHA} 2026-10-15T11:15:09-05:00`)).toBe("101526 · 0f5eb58");
  });
  it("says unknown when there is no stamp to read, rather than failing the build", () => {
    expect(buildVersionLabel(null)).toBe("unknown");
    expect(buildVersionLabel("$Format:%H %cI$")).toBe("unknown");
  });
});

describe("the stamp file is filled in by git archive (export-subst)", () => {
  const root = process.cwd();
  it("holds git's placeholder for the full commit and its ISO date", () => {
    expect(readFileSync(join(root, "build-stamp.txt"), "utf8").trim()).toBe("$Format:%H %cI$");
  });
  it("is marked export-subst", () => {
    expect(readFileSync(join(root, ".gitattributes"), "utf8")).toMatch(/^build-stamp\.txt export-subst$/m);
  });
  it("comes out of `git archive` of erp/ as this commit and its date, which the label reads", () => {
    const head = execFileSync("git", ["log", "-1", "--format=%H %cI"], { cwd: root, encoding: "utf8" }).trim();
    const archived = execFileSync("sh", ["-c", "git archive --format=tar HEAD build-stamp.txt | tar -xOf -"], {
      cwd: root, encoding: "utf8",
    }).trim();
    expect(archived).toBe(head);
    expect(buildVersionLabel(archived)).toMatch(/^\d{6} · [0-9a-f]{7}$/);
  });
});

describe("the nav rail shows it (source pin)", () => {
  const shell = readFileSync(join(process.cwd(), "src/components/Shell.tsx"), "utf8");
  const config = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
  it("next.config.ts bakes the label into NEXT_PUBLIC_BUILD_VERSION and the release into NEXT_PUBLIC_RELEASE_VERSION", () => {
    expect(config).toContain("NEXT_PUBLIC_BUILD_VERSION: buildVersionLabel(");
    expect(config).toContain("NEXT_PUBLIC_RELEASE_VERSION: releaseVersion()");
  });
  it("next.config.ts treats only a missing release-version.txt as no release and judges the text with readReleaseVersion", () => {
    expect(config).toContain('(e as NodeJS.ErrnoException).code === "ENOENT"');
    expect(config).toContain("throw e;");
    expect(config).toContain("return readReleaseVersion(text);");
  });
  it("the rail's release branch prints railVersion's text and its title", () => {
    expect(shell).toContain("{rail.text}");
    expect(shell).toContain("title={rail.title ?? undefined}");
  });
  it("the rail prints railVersion's text after the links, inside the scrolling wrapper, with unknown as the build fallback", () => {
    expect(shell).toContain('const build = process.env.NEXT_PUBLIC_BUILD_VERSION ?? "unknown";');
    expect(shell).toContain('railVersion(build, process.env.NEXT_PUBLIC_RELEASE_VERSION ?? null)');
    expect(shell).toContain('<>Build Version:{" "}<span className="whitespace-nowrap">{build}</span></>');
    const nav = shell.indexOf("</nav>");
    const label = shell.indexOf("railVersion(build");
    const wrapperEnd = shell.indexOf("</RailWrapper>");
    expect(nav).toBeGreaterThan(-1);
    expect(label).toBeGreaterThan(nav);
    expect(label).toBeLessThan(wrapperEnd);
  });
});

describe("railVersion", () => {
  it("shows the release with the build as its title", () => {
    expect(railVersion("111826 · abc1234", "1.4.0")).toEqual({ text: "HeatSynQ 1.4.0", title: "Build 111826 · abc1234" });
  });
  it("shows today's line with no release (null or empty)", () => {
    const today = { text: "Build Version: 111826 · abc1234", title: null };
    expect(railVersion("111826 · abc1234", null)).toEqual(today);
    expect(railVersion("111826 · abc1234", "")).toEqual(today);
  });
});
