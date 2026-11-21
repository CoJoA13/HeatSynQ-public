// Client-safe and pure: the build version shown at the foot of the nav rail (#542). The owner's
// form (2026-10-15) is "MMDDYY · <short commit>", for example "101526 · 0f5eb58", where the date is
// the commit's own date read on the plant's calendar (America/Chicago), so the same commit reads
// the same on every install. next.config.ts reads the stamp (erp/build-stamp.txt as `git archive`
// fills it in, or git itself in a checkout) and bakes the label in at build time.

/** The plant's time zone. Exported for the Invoice register PDF's date-times (#592,
 *  src/server/invoice-register.ts), read where it stands: next.config.ts imports this file by
 *  relative path, so it keeps no imports of its own. */
export const PLANT_TIME_ZONE = "America/Chicago";
const STAMP = /^([0-9a-f]{40})\s+(\S+)$/;

/** The commit's first seven characters and its date as MMDDYY on the plant's calendar, from
 *  "<full commit> <ISO date>" (git's `%H %cI`). None for anything else, including the
 *  `$Format:…$` placeholder a checkout's stamp file still holds. */
export function parseBuildStamp(text: string): { commit: string; date: string } | null {
  const match = STAMP.exec(text.trim());
  if (!match) return null;
  const when = new Date(match[2]);
  if (Number.isNaN(when.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PLANT_TIME_ZONE, month: "2-digit", day: "2-digit", year: "2-digit",
  }).formatToParts(when);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return { commit: match[1].slice(0, 7), date: `${part("month")}${part("day")}${part("year")}` };
}

/** "101526 · 0f5eb58", or "unknown" when there is no stamp to read. */
export function buildVersionLabel(stamp: string | null): string {
  // A runtime without time-zone data throws on the plant's zone: say unknown rather than fail the build.
  try {
    const parsed = stamp === null ? null : parseBuildStamp(stamp);
    return parsed ? `${parsed.date} · ${parsed.commit}` : "unknown";
  } catch {
    return "unknown";
  }
}

/** What the nav rail's foot says. A release build (erp/release-version.txt present at build time)
 *  reads "HeatSynQ 1.4.0" with the build label as its title; any other build keeps today's
 *  "Build Version: <build>" line with no title. */
export function railVersion(build: string, release: string | null): { text: string; title: string | null } {
  return release
    ? { text: `HeatSynQ ${release}`, title: `Build ${build}` }
    : { text: `Build Version: ${build}`, title: null };
}
