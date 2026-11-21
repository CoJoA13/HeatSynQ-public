/**
 * Settings' landed writes (owner ruling R7; Codex on #812). Settings' boxes are uncontrolled, so a
 * box's text at focus is the value it last stored: its newest landed write, until the rows read
 * hold that write's text. An entry goes only then, so a read that does not reflect it (an older
 * read, or one another box's save asked for) leaves it standing.
 */
export type LandedWrite = { text: string; attempt: number };

/** The landed writes still standing once rows are read: an entry goes when its row holds its text. */
export function caughtUp(
  landed: Record<string, LandedWrite>, rows: { key: string; value: unknown }[],
): Record<string, LandedWrite> {
  const next: Record<string, LandedWrite> = {};
  for (const [key, entry] of Object.entries(landed)) {
    const row = rows.find((r) => r.key === key);
    if (!row || String(row.value) !== entry.text) next[key] = entry;
  }
  return next;
}

