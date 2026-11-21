import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import nextConfig from "../next.config";

const execute = promisify(execFile);
const baseline = "20261120000000_public_baseline_v2";

describe("public migration artifact deployment roots", () => {
  it("loads and verifies shipped artifacts from cwd after the loader is bundled into a server chunk", async () => {
    const root = await mkdtemp(join(tmpdir(), "public-artifact-root-"));
    try {
      const artifacts = join(root, "prisma");
      await mkdir(artifacts);
      for (const name of ["public-migrations.json", "public-baseline-templates.json", "migrations"]) {
        await cp(resolve("prisma", name), join(artifacts, name), { recursive: true });
      }
      // Model the relocation performed by both server bundling and CLI packaging.
      // The emitted module's directory deliberately is not the app's artifact root.
      const chunk = join(root, ".next/server/chunks/public-migrations.mjs");
      await build({ entryPoints: [resolve("scripts/lib/public-migrations.ts")], outfile: chunk,
        bundle: true, platform: "node", target: "node26", format: "esm", packages: "external" });
      const code = `
        const { loadPublicMigrations, loadPublicBaselineTemplates } = await import(${JSON.stringify(pathToFileURL(chunk).href)});
        const directory = process.argv[1];
        const migrations = await loadPublicMigrations(directory);
        const templates = await loadPublicBaselineTemplates(directory);
        process.stdout.write(JSON.stringify({ migrations, docTypes: templates.map(row => row.docType).sort() }));
      `;
      const run = (cwd: string, directory?: string) => execute(process.execPath,
        ["--input-type=module", "-e", code, ...(directory ? [directory] : [])],
        { cwd, env: { ...process.env, DATABASE_URL: "postgresql://offline:offline@127.0.0.1:1/offline" }, timeout: 5000 });
      const result = JSON.parse((await run(root)).stdout);
      expect(result.migrations).toEqual([{ name: baseline, sha256: "e1246256bd4b46cf95e97d81253f939fbe248fcbfcab8e3e78b5ee6e217fd715" }]);
      expect(result.docTypes).toEqual(["BOL", "CERT", "CONTAINER_TAG", "INVOICE", "MOS_SHIPPER", "QUOTE", "SHIPPER", "STATEMENT", "TRAVELER"]);
      const otherCwd = join(root, "other-cwd");
      await mkdir(otherCwd);
      // Explicit directory seams used by upgrades remain independent of cwd.
      expect(JSON.parse((await run(otherCwd, artifacts)).stdout)).toEqual(result);
      await expect(run(otherCwd)).rejects.toMatchObject({ code: 1,
        stderr: expect.stringContaining("Public migration files or manifest failed integrity validation") });
      await writeFile(join(artifacts, "migrations", baseline, "migration.sql"), "SELECT 1;\n");
      await expect(run(root)).rejects.toMatchObject({ code: 1,
        stderr: expect.stringContaining("Public migration files or manifest failed integrity validation") });
      await cp(resolve("prisma/migrations", baseline, "migration.sql"), join(artifacts, "migrations", baseline, "migration.sql"));
      await writeFile(join(artifacts, "public-baseline-templates.json"), "[]\n");
      await expect(run(root)).rejects.toMatchObject({ code: 1,
        stderr: expect.stringContaining("Public baseline template defaults failed integrity validation") });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15_000);

  it("explicitly traces the manifest, frozen templates and migration SQL into standalone output", () => {
    expect(nextConfig.output).toBe("standalone");
    expect(nextConfig.outputFileTracingIncludes?.["/**"]).toEqual(expect.arrayContaining([
      "./prisma/public-migrations.json", "./prisma/public-baseline-templates.json", "./prisma/migrations/**",
    ]));
  });
});
