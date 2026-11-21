// The Backups page's At a glance figures (the UX redesign PR 12, owner 2026-11-02 on #827). They only
// report what the page already holds: `lastRunAt`, the newest archive's integrity and the threshold.
// Nothing here is the green rule, which is `evaluateHealth`'s (backups.ts): a health of `unknown`
// says "Not confirmed" whatever the folder lists, so a missing status never reads as a pass (the
// file's Missing status frame; §6.2 "absence is failure"). Client-safe.
import type { ArchiveInfo, BackupHealth } from "./backup-constants";
import { formatDateTime } from "./format";

export function backupGlance(health: BackupHealth, archives: ArchiveInfo[]): { latestRun: string; integrity: string; staleThreshold: string } {
  const newest = archives[0]; // listArchives answers newest first
  return {
    latestRun: health.lastRunAt ? formatDateTime(health.lastRunAt) : "Unknown",
    integrity: health.state === "unknown" || !newest ? "Not confirmed" : newest.integrityOk ? "OK" : "CORRUPT",
    staleThreshold: `${health.staleHours} hours`,
  };
}
