import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { prisma, truncateAll } from "./helpers/db";
import { readOperationsHealth } from "@/server/operations-health";
import { BACKUP_STATUS_FILENAME, RETENTION_STATUS_FILENAME } from "@/lib/backup-constants";

let dir: string;
let archive: string;
beforeEach(async () => {
  await truncateAll();
  dir = await mkdtemp(path.join(tmpdir(), "heatsynq-monitor-test-"));
  vi.stubEnv("BACKUP_DIR", dir);
  archive = path.join(dir, "erp_2026-09-09_120000.sql.gz");
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
async function backup() {
  await writeFile(archive, gzipSync("-- synthetic backup fixture"));
  await writeFile(path.join(dir, BACKUP_STATUS_FILENAME), JSON.stringify({ lastRunAt: new Date().toISOString(), ok: true, source: "nightly", error: null }));
}

describe("operations health reads the real backup policy", () => {
  it("reports missing evidence as unknown", async () => {
    expect(await readOperationsHealth()).toEqual({ ok: false, db: true, backups: "unknown" });
  });
  it("reports an intact recent archive with successful status as healthy", async () => {
    await backup();
    expect(await readOperationsHealth()).toEqual({ ok: true, db: true, backups: "ok" });
  });
  it("checks archive integrity instead of trusting success metadata", async () => {
    await backup(); await writeFile(archive, "corrupt archive");
    expect(await readOperationsHealth()).toEqual({ ok: false, db: true, backups: "stale" });
  });
  it("uses the configured threshold, not a second monitoring policy", async () => {
    await backup();
    await prisma.setting.upsert({ where: { key: "backup_stale_hours" }, update: { value: 1 }, create: { key: "backup_stale_hours", value: 1 } });
    const old = new Date(Date.now() - 2 * 3600_000); await utimes(archive, old, old);
    expect(await readOperationsHealth()).toEqual({ ok: false, db: true, backups: "stale" });
  });
  it("retains nightly retention failures after a successful backup and redacts errors", async () => {
    await backup();
    await writeFile(path.join(dir, RETENTION_STATUS_FILENAME), JSON.stringify({ lastRunAt: new Date().toISOString(), ok: false, error: "/private/archive failure" }));
    expect(await readOperationsHealth()).toEqual({ ok: false, db: true, backups: "failed" });
  });
  it("uses database identity to exempt practice from backup responsibility", async () => {
    vi.spyOn(prisma, "$queryRaw").mockResolvedValue([{ name: "erp_practice" }]);
    expect(await readOperationsHealth()).toEqual({ ok: true, db: true, backups: "not_applicable" });
  });
  it("does not let an environment flag exempt a non-practice database", async () => {
    vi.stubEnv("PRACTICE_MODE", "true");
    expect(await readOperationsHealth()).toEqual({ ok: false, db: true, backups: "unknown" });
  });
  it("does not leak database failures", async () => {
    vi.spyOn(prisma, "$queryRaw").mockRejectedValue(new Error("private database connection"));
    expect(await readOperationsHealth()).toEqual({ ok: false, db: false, backups: "unknown" });
  });
  it("coalesces concurrent work and reads again after completion", async () => {
    let finish!: (value: { name: string }[]) => void;
    const query = vi.spyOn(prisma, "$queryRaw").mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }) as ReturnType<typeof prisma.$queryRaw>);
    const a = readOperationsHealth(); const b = readOperationsHealth();
    expect(query).toHaveBeenCalledTimes(1);
    finish([{ name: "erp_test" }]);
    await Promise.all([a, b]);
    await readOperationsHealth();
    expect(query).toHaveBeenCalledTimes(2);
  });
});
