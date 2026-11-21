import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const compose = readFileSync("docker-compose.yml", "utf8");

function service(name: string): string[] {
  const lines = compose.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  expect(start).toBeGreaterThan(-1);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {0,2}\S/.test(line));
  return end === -1 ? rest : rest.slice(0, end);
}

describe("the update folder mount", () => {
  it("gives app the env and the mount", () => {
    expect(service("app")).toContain("      UPDATES_DIR: /updates");
    expect(service("app")).toContain("      - ./updates:/updates");
  });
  it("gives app-practice neither, not even in a non-comment line", () => {
    const code = service("app-practice").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).not.toMatch(/UPDATES_DIR|\/updates/);
  });
  it("ignores the folder in git and the image context, and keeps release-version.txt in the context", () => {
    expect(readFileSync(".gitignore", "utf8").split("\n")).toContain("/updates");
    expect(readFileSync(".gitignore", "utf8").split("\n")).toContain("/release-version.txt");
    const docker = readFileSync(".dockerignore", "utf8").split("\n");
    expect(docker).toContain("updates");
    expect(docker.join("\n")).not.toMatch(/release-version/);
  });
});
