import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseReleaseManifest,
  parseUpdateHold,
  parseUpdateStatus,
} from "@/lib/release-contracts";

// The status and hold files the app reads, as the host's update agent writes them. The public source
// ships no release tooling, so it holds no release manifest fixture: the manifest's parser is checked
// here only against a non-object.
const DIR = join(__dirname, "fixtures", "release-contracts");
const FILES = readdirSync(DIR, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith(".json"))
  .map((e) => e.name)
  .sort();

const PREFIXES = [
  ["bad-status-", parseUpdateStatus, true],
  ["bad-hold-", parseUpdateHold, true],
  ["status-", parseUpdateStatus, false],
  ["hold-", parseUpdateHold, false],
] as const;

function route(name: string) {
  const hit = PREFIXES.find(([p]) => name.startsWith(p));
  if (!hit) throw new Error(`fixture ${name} matches no known prefix`);
  return { parse: hit[1] as (v: unknown) => unknown, bad: hit[2] };
}
const parserFor = (name: string) => route(name).parse;

const read = (name: string): unknown => JSON.parse(readFileSync(join(DIR, name), "utf8"));

describe("release contracts, shared fixtures", () => {
  it("has the required fixtures and routes every file", () => {
    const required = [
      "status-scheduled.json", "status-held.json", "status-empty.json", "hold-on.json", "hold-off.json",
      "bad-status-held-reason.json", "bad-status-scheduled-reason.json", "bad-status-notes.json",
      "bad-hold-from-null.json", "bad-hold-off-by.json", "bad-hold-at.json", "bad-hold-extra-key.json",
    ];
    for (const f of required) expect(FILES).toContain(f);
    for (const f of FILES) expect(() => route(f)).not.toThrow();
  });

  for (const name of FILES.filter((f) => !route(f).bad)) {
    it(`${name} parses to its own contents`, () => {
      expect(parserFor(name)(read(name))).toEqual(read(name));
    });
  }

  for (const name of FILES.filter((f) => route(f).bad)) {
    it(`${name} is refused`, () => {
      expect(parserFor(name)(read(name))).toBeNull();
    });
  }

  it("refuses non-objects and unknown keys", () => {
    expect(parseReleaseManifest(null)).toBeNull();
    expect(parseUpdateHold("x")).toBeNull();
    expect(parseUpdateHold({ ...(read("hold-off.json") as object), extra: 1 })).toBeNull();
  });

  it("refuses a bad timestamp", () => {
    expect(
      parseUpdateHold({ ...(read("hold-on.json") as object), at: "2026-11-18T10:00:00" }),
    ).toBeNull();
  });

  it("takes only UTC timestamps written out whole", () => {
    const at = (v: string) => parseUpdateHold({ ...(read("hold-on.json") as object), at: v });
    for (const ok of ["2026-11-18T10:00:00Z", "2026-11-18T10:00:00.5Z", "2026-11-18T10:00:00.123456Z"]) {
      expect(at(ok)).not.toBeNull();
    }
    for (const bad of ["2026Z", "1Z", "Tue Nov 18 2026Z", "2026-11-18T10:00:00+00:00", "2026-11-18T10:00Z",
      "2026-11-18T10:00:00.1234567Z", "2026-13-18T10:00:00Z", "2026-11-18T10:00:00Z\n"]) {
      expect(at(bad), bad).toBeNull();
    }
  });
});
