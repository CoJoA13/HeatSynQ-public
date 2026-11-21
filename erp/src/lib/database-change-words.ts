// The owner-approved wording (2026-11-18) for a release that changes the database, in ONE copy: the
// release script (plain node, erp/scripts/lib/release-notes.mjs) and the app's banner and What's new
// both read it. Keep this file import-free and erasable (plain `export const` with literals and type
// annotations only), so node can load it without a build.

export const DATABASE_CHANGES_HEADING: string = "## Database changes";

export const DATABASE_CHANGE_SECTIONS: readonly { label: string; text: string }[] = [
  {
    label: "What happens",
    text: "a full backup of the database is taken first, then the update changes how some information is stored.",
  },
  {
    label: "What could go wrong",
    text: "if the update fails after the database has changed, HeatSynQ is stopped and stays down until your administrator restores it from that backup. It won't come back by itself.",
  },
  {
    label: "What to do",
    text: "finish and save your work before you leave. If HeatSynQ is down in the morning, or something looks wrong after the update, stop entering data and tell your administrator.",
  },
];

export const HOLD_SECTION: { label: string; text: string } = {
  label: "Bad timing?",
  text: "During a month-end close or a big shipping day, an admin can **Hold** the update. It waits until an admin releases it.",
};

export const NOTES_LEAD: string =
  "This update changes the database. It installs at the first 4:00 AM at least 12 hours after the release is published.";

export const DATABASE_CHANGES_AFTER: string =
  "**This update changed the database.** A full backup was taken right before it. If anything looks wrong — missing or changed records, totals that don't add up — stop entering data and tell your administrator, who can restore that backup.";
