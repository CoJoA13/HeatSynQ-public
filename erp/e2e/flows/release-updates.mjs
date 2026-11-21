// Flow: release updates (PR 3 of the release-updates lane). The harness hands the server a throwaway
// update folder (UPDATES_DIR, `ctx.updatesDir`); this flow writes a scheduled status file into it,
// the file the host's update agent writes, and drives what the app does with it:
//   - as admin: What's new shows the running version's note once (Got it clears it), the banner for
//     a database-changing update shows, Hold writes hold.json held, "Held by ..." shows, Release hold
//     writes it not held;
//   - as the restricted user (no admin.view): no banner, What's new shows the running note once, and
//     Got it plus a reload makes it gone.
// The admin's What's new is dismissed first (Got it) so the dialog never covers the banner; it is
// asserted there too, since that is the same one-time dialog.
//
// It restores everything it touches before it ends, in a finally: the folder (status.json and
// hold.json), the UpdateHold row and the two users' last-seen version, so no flow after it can see
// a banner or a dialog (the same reset db-fixtures.ts runs for an interrupted run). The status
// file's shape is the contract's fixture (tests/fixtures/release-contracts/status-scheduled.json)
// with its times moved to now: plain node cannot load the contract's TypeScript parser, so the
// fixture's shape is kept exactly and the routes' own parse is what proves it.
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { login } from "../lib/auth.mjs";
import { assertNeverVisible } from "../lib/ui.mjs";

const FIXTURE = new URL("../../tests/fixtures/release-contracts/status-scheduled.json", import.meta.url);
const RUNNING_NOTE = "Earlier changes shown once.";

function statusFor(base, now) {
  const iso = (ms) => new Date(now + ms).toISOString();
  const hour = 3600_000;
  const pendingNote = base.notes.find((n) => n.version === base.pending.version);
  assert.ok(pendingNote, "the fixture carries a note for its pending version");
  return {
    ...base,
    writtenAt: iso(0),
    running: { version: base.running.version, at: iso(-240 * hour) },
    pending: {
      ...base.pending,
      publishedAt: iso(-2 * hour), firstSeenAt: iso(-2 * hour), installAfter: iso(10 * hour),
      databaseChanges: true, state: "scheduled", reason: null,
    },
    notes: [
      { version: base.running.version, publishedAt: iso(-240 * hour), databaseChanges: false, body: `- ${RUNNING_NOTE}` },
      { ...pendingNote, publishedAt: iso(-2 * hour), databaseChanges: true },
    ],
  };
}

/** Polls hold.json until it reads `held` (the app writes it just after the click answers). */
async function holdFileSays(dir, held) {
  const file = path.join(dir, "hold.json");
  let last = "not written";
  for (let i = 0; i < 40; i++) {
    try {
      const hold = JSON.parse(await readFile(file, "utf8"));
      if (hold.held === held) return hold;
      last = `held: ${hold.held}`;
    } catch { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.fail(`hold.json never read held: ${held} (last: ${last})`);
}

export async function run(page, shot, ctx) {
  const dir = ctx.updatesDir;
  const base = JSON.parse(await readFile(FIXTURE, "utf8"));
  const banner = page.getByRole("region", { name: "Update notice" });
  const whatsNew = page.getByRole("dialog", { name: "What's new" });
  try {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "status.json"), JSON.stringify(statusFor(base, Date.now())));

    // --- As admin: What's new once, then the banner. ---
    await page.goto(`${ctx.baseURL}/`);
    await whatsNew.waitFor({ state: "visible", timeout: 15000 });
    await whatsNew.getByText(RUNNING_NOTE).waitFor({ state: "visible" });
    await shot("admin-whats-new");
    await whatsNew.getByRole("button", { name: "Got it", exact: true }).click();
    await whatsNew.waitFor({ state: "hidden", timeout: 15000 });

    await banner.getByText("Tonight's update, 1.4.0, changes the database.").waitFor({ state: "visible", timeout: 15000 });
    await banner.getByText("What happens:").waitFor({ state: "visible" });
    await shot("admin-banner");

    // --- Hold, then Release hold; the file the agent reads follows each. ---
    await banner.getByRole("button", { name: "Hold", exact: true }).click();
    await banner.getByText(/^Held by E2E Admin User since /).waitFor({ state: "visible" });
    const held = await holdFileSays(dir, true);
    assert.equal(held.fromVersion, "1.4.0", "hold.json names the held release");
    assert.equal(held.by, "E2E Admin User", "hold.json names who held it");
    await shot("admin-held");

    await banner.getByRole("button", { name: "Release hold", exact: true }).click();
    await banner.getByRole("button", { name: "Hold", exact: true }).waitFor({ state: "visible" });
    const released = await holdFileSays(dir, false);
    assert.equal(released.fromVersion, null, "a released hold names no release");
    await banner.getByText(/^Held by /).waitFor({ state: "hidden", timeout: 15000 });

    // --- As the restricted user (no admin.view): no banner, What's new once. ---
    await login(page, ctx.baseURL, ctx.fixtures.restrictedUsername, ctx.fixtures.restrictedPassword);
    await whatsNew.waitFor({ state: "visible", timeout: 15000 });
    await whatsNew.getByText(RUNNING_NOTE).waitFor({ state: "visible" });
    await assertNeverVisible(banner, "a caller without admin.view sees no update banner");
    await shot("restricted-whats-new");
    await whatsNew.getByRole("button", { name: "Got it", exact: true }).click();
    await whatsNew.waitFor({ state: "hidden", timeout: 15000 });
    await page.reload();
    await page.getByRole("link", { name: "Parts" }).waitFor({ state: "visible" });
    await assertNeverVisible(whatsNew, "What's new does not come back after a reload");
    await assertNeverVisible(banner, "still no update banner for a caller without admin.view");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await ctx.resetUpdates();
  }
}
