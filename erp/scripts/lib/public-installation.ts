import type { Prisma } from "../../prisma/generated/prisma/client";
import { PUBLIC_BASELINE, PUBLIC_LINEAGE, validateExpectedMigrations, type ExpectedMigration } from "./public-migrations";

export type { ExpectedMigration } from "./public-migrations";
export type RawDb = Pick<Prisma.TransactionClient, "$queryRaw">;
export type AdmissionOptions = { allowPending?: boolean };
type HistoryRow = {
  migration_name: string; checksum: string; finished_at: string | null;
  started_at: string; rolled_back_at: string | null; applied_steps_count: number; has_logs: boolean;
};
const REFUSAL = "Public installation admission refused: baseline completion or migration history is unsupported. Keep services stopped and inspect the installation.";
const refuse = (): never => { throw new Error(REFUSAL); };
/** The first public lineage. heatsynq-public-v2 replaced its baseline, and nothing upgrades a v1 install. */
export const PUBLIC_V1_LINEAGE = "heatsynq-public-v1";
export const PUBLIC_V1_REFUSAL = "This database was installed from the heatsynq-public-v1 baseline, and there is no upgrade path to heatsynq-public-v2. Install into an empty database.";
export const PUBLIC_COMMAND_REFUSAL = "Public command refused or failed. Keep services stopped and inspect installation history and completion.";

/** The one line a public command prints when it fails. Only the fixed v1 sentence, matched exactly,
 *  is shown as raised; any other message may hold a path or a row, and gets the general line. */
export function publicCommandRefusalLine(error: unknown): string {
  return error instanceof Error && error.message === PUBLIC_V1_REFUSAL ? PUBLIC_V1_REFUSAL : PUBLIC_COMMAND_REFUSAL;
}

function checkHistory(rows: HistoryRow[], expected: ExpectedMigration[], options: AdmissionOptions): void {
  // Only an absent known suffix can be pending. No failed/reverted/duplicate attempts are accepted.
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > expected.length
    || (!options.allowPending && rows.length !== expected.length)) refuse();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const started = Date.parse(row.started_at);
    const finished = row.finished_at === null ? NaN : Date.parse(row.finished_at);
    if (row.migration_name !== expected[i].name || row.checksum !== expected[i].sha256
      || row.rolled_back_at !== null || row.has_logs !== false
      || !Number.isInteger(row.applied_steps_count) || row.applied_steps_count < 1
      || !Number.isFinite(started) || !Number.isFinite(finished) || finished < started) refuse();
  }
}

/** Internal bootstrap check, before a completion marker exists. Strict history is mandatory. */
export async function assertPublicMigrationHistory(db: RawDb, manifest: ExpectedMigration[]): Promise<void> {
  const expected = validateExpectedMigrations(manifest);
  try {
    const [state] = await db.$queryRaw<{ schema: string | null; history: HistoryRow[] }[]>`
      SELECT current_schema() AS schema,
        COALESCE((SELECT jsonb_agg(h ORDER BY h.migration_name) FROM (
          SELECT migration_name, checksum, finished_at, started_at, rolled_back_at, applied_steps_count,
            (logs IS NOT NULL AND logs <> '') AS has_logs FROM public._prisma_migrations
        ) h), '[]'::jsonb) AS history`;
    if (state?.schema !== "public") refuse();
    checkHistory(state.history, expected, {});
  } catch { refuse(); }
}

/** Read-only admission; marker and ledger are observed in one PostgreSQL statement snapshot. */
export async function assertPublicInstallation(db: RawDb, manifest: ExpectedMigration[], options: AdmissionOptions = {}): Promise<void> {
  const expected = validateExpectedMigrations(manifest);
  // Decided inside the read and thrown after it, since the catch turns every other failure into REFUSAL.
  let installedFromV1 = false;
  try {
    const [state] = await db.$queryRaw<{
      schema: string | null; history: HistoryRow[];
      markers: { id: string; lineage: string; baselineMigration: string; completedAt: string }[];
    }[]>`
      SELECT current_schema() AS schema,
        COALESCE((SELECT jsonb_agg(m) FROM public."PublicInstallation" m), '[]'::jsonb) AS markers,
        COALESCE((SELECT jsonb_agg(h ORDER BY h.migration_name) FROM (
          SELECT migration_name, checksum, finished_at, started_at, rolled_back_at, applied_steps_count,
            (logs IS NOT NULL AND logs <> '') AS has_logs FROM public._prisma_migrations
        ) h), '[]'::jsonb) AS history`;
    if (state?.schema !== "public") refuse();
    // A v1 install keeps its marker, whose lineage CHECK allows no other value. It is refused in a
    // sentence of its own, without its history being judged; admission writes nothing either way.
    installedFromV1 = state.markers.some(m => m?.lineage === PUBLIC_V1_LINEAGE);
    if (!installedFromV1) {
      if (state.markers.length !== 1) refuse();
      const marker = state.markers[0];
      if (marker.id !== "singleton" || marker.lineage !== PUBLIC_LINEAGE
        || marker.baselineMigration !== PUBLIC_BASELINE || !Number.isFinite(Date.parse(marker.completedAt))) refuse();
      checkHistory(state.history, expected, options);
    }
  } catch { refuse(); }
  if (installedFromV1) throw new Error(PUBLIC_V1_REFUSAL);
}
