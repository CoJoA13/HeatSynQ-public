// The words of the update screens (release-updates PR 3, Task 3.4): the banner's headline and
// install time, its sections (the owner-approved text lives once, in database-change-words.ts), the
// plant-clock times and an installed note's body. Client-safe and pure.
import {
  DATABASE_CHANGES_AFTER, DATABASE_CHANGES_HEADING, DATABASE_CHANGE_SECTIONS, HOLD_SECTION,
} from "./database-change-words";
import { PLANT_TIME_ZONE } from "./build-version";

export type PendingUpdate = {
  version: string; installAfter: string; databaseChanges: boolean;
  state: "scheduled" | "held" | "manual"; reason: string | null;
};

const DAY = Intl.DateTimeFormat;
const dayText = (d: Date) =>
  new DAY("en-US", { timeZone: PLANT_TIME_ZONE, weekday: "long", month: "short", day: "numeric" }).format(d);
const clockText = (d: Date) =>
  new DAY("en-US", { timeZone: PLANT_TIME_ZONE, hour: "numeric", minute: "2-digit" }).format(d);

/** "Friday, Nov 20" on the plant clock. */
export const plantDay = (iso: string): string => dayText(new Date(iso));
/** "4:00 AM" on the plant clock. */
export const plantClock = (iso: string): string => clockText(new Date(iso));
/** "Friday, Nov 20 at 4:00 AM" on the plant clock. */
export const plantDateTime = (iso: string): string => `${plantDay(iso)} at ${plantClock(iso)}`;

const TONIGHT_MS = 24 * 60 * 60 * 1000;

export type BannerParts = {
  headline: string;
  /** The "It installs at ..." sentence; null when the headline says it all (held, or overdue). */
  installs: string | null;
  sections: { label: string; text: string }[];
};

/** The banner's text: the approved wording with the version and the install time filled in. A held
 *  update says it is held and names no time; "Tonight's" means installAfter is in (now, now + 24 h]. */
export function bannerParts(pending: PendingUpdate, now: Date, held = false): BannerParts {
  const sections = [
    ...DATABASE_CHANGE_SECTIONS.map((s) => ({ label: `${s.label}:`, text: s.text })),
    { label: HOLD_SECTION.label, text: HOLD_SECTION.text },
  ];
  const plain = `The update ${pending.version}, which changes the database,`;
  if (held || pending.state === "held") return { headline: `${plain} is held.`, installs: null, sections };
  const ahead = Date.parse(pending.installAfter) - now.getTime();
  if (ahead <= 0) return { headline: `${plain} installs at the next 4:00 AM.`, installs: null, sections };
  const installs = `It installs at ${plantClock(pending.installAfter)} on ${plantDay(pending.installAfter)}.`;
  const headline = ahead <= TONIGHT_MS
    ? `Tonight's update, ${pending.version}, changes the database.`
    : `The update on ${plantDay(pending.installAfter)}, ${pending.version}, changes the database.`;
  return { headline, installs, sections };
}

/** The line under a held headline: who held it and when, or the agent's own reason. */
export function heldStatus(
  pending: PendingUpdate, hold: { held: boolean; by: string | null; at: string | null } | null,
): string | null {
  if (hold?.held) return heldLine(hold);
  return pending.state === "held" ? pending.reason : null;
}

/** "Held by Dana since Nov 20, 4:00 AM." on the plant clock. */
export function heldLine(hold: { by: string | null; at: string | null }): string {
  const who = hold.by ? ` by ${hold.by}` : "";
  const when = hold.at
    ? ` since ${new Intl.DateTimeFormat("en-US", { timeZone: PLANT_TIME_ZONE, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(hold.at))}`
    : "";
  return `Held${who}${when}.`;
}

/** An installed note as What's new shows it (ruling P8): a database-changing note's "Database
 *  changes" section, written in the future tense before the install, is replaced by the past-tense
 *  text; when the note has no such heading, the heading and text go at the top. */
export function installedNoteBody(note: { databaseChanges: boolean; body: string }): string {
  if (!note.databaseChanges) return note.body;
  const lines = note.body.split("\n");
  const at = lines.findIndex((l) => l.trim() === DATABASE_CHANGES_HEADING);
  if (at < 0) return `${DATABASE_CHANGES_HEADING}\n\n${DATABASE_CHANGES_AFTER}\n\n${note.body}`;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) if (lines[i].startsWith("## ")) { end = i; break; }
  const tail = lines.slice(end);
  return [...lines.slice(0, at + 1), "", DATABASE_CHANGES_AFTER, ...(tail.length ? ["", ...tail] : [])].join("\n");
}

/** What the System page shows for the pending update: the agent's note as written when there is
 *  one, else the approved wording (a database-changing update) or a plain statement. */
export function pendingBlock(pending: PendingUpdate, note: { body: string } | null): "note" | "wording" | "plain" {
  if (note) return "note";
  return pending.databaseChanges ? "wording" : "plain";
}

/** The System page's card heading and sentence for the pending update. A manual release shows its
 *  reason and no install time; a held one the hold line (hold.held first, then the agent's own
 *  reason); a scheduled one its install sentence, whether or not it changes the database. */
export function pendingCard(
  pending: PendingUpdate, hold: { held: boolean; by: string | null; at: string | null } | null, now: Date,
): { headline: string; detail: string | null } {
  const held = hold?.held === true || pending.state === "held";
  if (pending.state === "manual") {
    return {
      headline: pending.databaseChanges
        ? `The update ${pending.version}, which changes the database, will not install by itself.`
        : `The update ${pending.version} will not install by itself.`,
      detail: pending.reason,
    };
  }
  if (pending.databaseChanges) {
    const parts = bannerParts(pending, now, held);
    return { headline: parts.headline, detail: held ? heldStatus(pending, hold) : parts.installs };
  }
  const headline = `Update ${pending.version} does not change the database.`;
  if (held) return { headline, detail: heldStatus(pending, hold) };
  const ahead = Date.parse(pending.installAfter) - now.getTime();
  return {
    headline,
    detail: ahead <= 0 ? "It installs at the next 4:00 AM."
      : `It installs at ${plantClock(pending.installAfter)} on ${plantDay(pending.installAfter)}.`,
  };
}

/** Whether the System page draws the Hold control: Hold for a releasable database update (as the
 *  banner is gated), and Release hold whenever a hold stands, whatever the pending release now is. */
export function holdOffered(pending: PendingUpdate | null, hold: { held: boolean } | null): boolean {
  return hold?.held === true || (pending !== null && pending.databaseChanges && pending.state !== "manual");
}

/** The System page's Installs row, from the same rules as `pendingCard` so the two never disagree:
 *  a manual release shows its reason, a held one the hold line (or the agent's reason), a scheduled
 *  one its time, or "The next 4:00 AM" once that time has passed. */
export function installsRow(
  pending: PendingUpdate | null, hold: { held: boolean; by: string | null; at: string | null } | null, now: Date,
): string {
  if (!pending) return "\u2014";
  if (pending.state === "manual") return pending.reason ?? "Not scheduled";
  if (hold?.held === true || pending.state === "held") return heldStatus(pending, hold) ?? pending.reason ?? "Held";
  return Date.parse(pending.installAfter) - now.getTime() <= 0 ? "The next 4:00 AM" : plantDateTime(pending.installAfter);
}

/** The System page's line when there is no pending update to describe. Null means show none (a
 *  failed permission read shows its own error instead of a claim about the update). */
export function emptyLine(s: {
  viewLoaded: boolean; permsLoaded: boolean; permsFailed: boolean; canView: boolean; running: string | null;
}): string | null {
  if (s.permsFailed) return null;
  if (!s.viewLoaded || !s.permsLoaded) return "Loading\u2026";
  if (!s.canView) return "Update details need admin.view access.";
  if (s.running === null) return "No update information on this install.";
  return "No update is waiting to install.";
}
