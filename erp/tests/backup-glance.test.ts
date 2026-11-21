import { describe, expect, it } from "vitest";
import { backupGlance } from "@/lib/backup-glance";
import type { ArchiveInfo, BackupHealth } from "@/lib/backup-constants";
import { formatDateTime } from "@/lib/format";

/** The Backups page's At a glance card (PR 12, #827): a missing status never reads as a pass. */
const health = (over: Partial<BackupHealth> = {}): BackupHealth => ({
  state: "ok", lastSuccessAt: "2026-11-01T04:10:00.000Z", lastRunAt: "2026-11-01T04:10:00.000Z", lastRunOk: true,
  staleHours: 36, reason: "", ...over,
});
const archive = (integrityOk: boolean) => ({ name: "erp_2026-11-01_041000.sql.gz", integrityOk }) as ArchiveInfo;

describe("backupGlance", () => {
  it("reads a healthy install", () => {
    expect(backupGlance(health(), [archive(true), archive(false)])).toEqual({
      latestRun: formatDateTime("2026-11-01T04:10:00.000Z"), integrity: "OK", staleThreshold: "36 hours",
    });
  });

  it("reads the newest archive's integrity, an older good one no comfort", () => {
    expect(backupGlance(health({ state: "failed" }), [archive(false), archive(true)]).integrity).toBe("CORRUPT");
  });

  it("confirms nothing on a missing status, though the folder lists good archives", () => {
    expect(backupGlance(health({ state: "unknown", lastRunAt: null, lastRunOk: null }), [archive(true)]))
      .toEqual({ latestRun: "Unknown", integrity: "Not confirmed", staleThreshold: "36 hours" });
  });

  it("confirms nothing with no archive", () => {
    expect(backupGlance(health({ state: "stale" }), []).integrity).toBe("Not confirmed");
  });
});
