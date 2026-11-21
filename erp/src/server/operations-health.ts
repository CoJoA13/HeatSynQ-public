import { prisma } from "./db";
import { backupHealth } from "./backups";
import { PRACTICE_DB_NAME } from "./practice-mode";
import type { BackupHealth } from "@/lib/backup-constants";

type OperationsHealth = {
  ok: boolean;
  db: boolean;
  backups: BackupHealth["state"] | "not_applicable";
};
let pending: Promise<OperationsHealth> | undefined;

// Concurrent monitor requests share work, including archive integrity verification. There is no
// success cache: the next completed polling cycle observes the current backup policy/evidence.
export function readOperationsHealth(): Promise<OperationsHealth> {
  return pending ??= read().finally(() => { pending = undefined; });
}

async function read(): Promise<OperationsHealth> {
  let name: string;
  try {
    const rows = await prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    name = rows[0]?.name ?? "";
    if (!name) return { ok: false, db: false, backups: "unknown" };
  } catch {
    return { ok: false, db: false, backups: "unknown" };
  }
  // Database identity is authoritative. Practice intentionally has no backup mount/responsibility.
  if (name === PRACTICE_DB_NAME) return { ok: true, db: true, backups: "not_applicable" };
  try {
    const { state } = await backupHealth();
    return { ok: state === "ok", db: true, backups: state };
  } catch {
    return { ok: false, db: true, backups: "unknown" };
  }
}
