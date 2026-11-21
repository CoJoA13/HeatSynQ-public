import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { load } = createRequire(import.meta.url)("js-yaml") as { load: (text: string) => unknown };
type Ignore = { "dependency-name": string; "update-types"?: string[] };
type Group = { "applies-to"?: string; patterns?: string[]; "exclude-patterns"?: string[]; "update-types"?: string[] };
type Update = {
  "package-ecosystem": string;
  directory?: string;
  directories?: string[];
  "open-pull-requests-limit": number;
  cooldown?: { "default-days": number };
  "versioning-strategy"?: string;
  ignore?: Ignore[];
  groups?: Record<string, Group>;
};
type Config = { version: number; updates: Update[] };
const config = load(readFileSync(new URL("../../.github/dependabot.yml", import.meta.url), "utf8")) as Config;

// The public repository asks for version and security updates, bounded and cooled down, under the source
// tree's holds: no majors, next and eslint-config-next together, pdfmake at the renderer's version, Prisma
// in lockstep for both kinds of update.
function contract(value: Config) {
  expect(value.version).toBe(2);
  expect(value.updates).toHaveLength(1);
  const [npm] = value.updates;
  expect(npm["package-ecosystem"]).toBe("npm");
  expect(npm.directory).toBe("/erp");
  expect(npm.directories).toBeUndefined();
  expect(npm["open-pull-requests-limit"]).toBe(3);
  expect(npm.cooldown).toEqual({ "default-days": 3 });
  expect(npm["versioning-strategy"]).toBe("increase");
  const ignore = npm.ignore ?? [];
  expect(ignore.some((rule) => rule["dependency-name"] === "*" && rule["update-types"]?.includes("version-update:semver-major"))).toBe(true);
  const held = ignore.filter((rule) => !rule["update-types"]).map((rule) => rule["dependency-name"]).sort();
  expect(held).toEqual(["eslint-config-next", "next", "pdfmake"]);
  expect(npm.groups).toEqual({
    prisma: { patterns: ["prisma", "@prisma/*"] },
    "prisma-security": { "applies-to": "security-updates", patterns: ["prisma", "@prisma/*"] },
    "npm-minor-and-patch": { "update-types": ["minor", "patch"], "exclude-patterns": ["prisma", "@prisma/*"] },
  });
}

describe("public Dependabot policy", () => {
  it("raises version and security updates, with the source tree's holds", () => contract(config));
  const npm = config.updates[0];
  const variant = (change: Partial<Update>): Config => ({ ...config, updates: [{ ...npm, ...change }] });
  it("rejects version updates turned off", () => {
    expect(() => contract(variant({ "open-pull-requests-limit": 0 }))).toThrow();
  });
  it("rejects a dropped hold", () => {
    expect(() => contract(variant({ ignore: (npm.ignore ?? []).filter((rule) => rule["dependency-name"] !== "pdfmake") }))).toThrow();
  });
  it("rejects majors let through", () => {
    expect(() => contract(variant({ ignore: (npm.ignore ?? []).filter((rule) => rule["dependency-name"] !== "*") }))).toThrow();
  });
  it("rejects the cooldown dropped", () => {
    expect(() => contract(variant({ cooldown: undefined }))).toThrow();
  });
  it("rejects Prisma's security group dropped", () => {
    const { "prisma-security": _dropped, ...rest } = npm.groups ?? {};
    expect(() => contract(variant({ groups: rest }))).toThrow();
  });
});
