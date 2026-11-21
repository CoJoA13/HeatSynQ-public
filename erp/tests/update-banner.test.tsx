import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UpdateBannerView } from "@/components/UpdateBanner";

const NOW = new Date("2026-11-19T20:00:00Z");
const pending = {
  version: "1.4.0", publishedAt: "2026-11-19T10:00:00Z", firstSeenAt: "2026-11-19T10:00:00Z",
  databaseChanges: true, installAfter: "2026-11-20T10:00:00Z", state: "scheduled" as const, reason: null,
};
const NOT_HELD = { held: false, fromVersion: null, by: null, at: null };
const render = (view: Parameters<typeof UpdateBannerView>[0]["view"], extra = {}) =>
  renderToStaticMarkup(<UpdateBannerView view={view} now={NOW} {...extra} />);

describe("UpdateBannerView", () => {
  it("shows the approved wording with the version and time filled in", () => {
    const out = render({ pending, hold: NOT_HELD, canHold: true });
    expect(out).toContain("Tonight&#x27;s update, 1.4.0, changes the database.");
    expect(out).toContain("It installs at 4:00 AM on Friday, Nov 20.");
    expect(out).toContain("<strong>What happens:</strong> a full backup");
    expect(out).toContain("<strong>What could go wrong:</strong> if the update fails");
    expect(out).toContain("<strong>What to do:</strong> finish and save your work");
    expect(out).toContain("<strong>Bad timing?</strong> During a month-end close");
    expect(out).toContain("an admin can <strong>Hold</strong> the update.");
    expect(out).toContain('href="/admin/system"');
  });
  it("enables Hold only with canHold; without it the button is disabled and says why", () => {
    const on = render({ pending, hold: NOT_HELD, canHold: true });
    expect(on).toContain(">Hold</button>");
    expect(on).not.toContain("disabled");
    const off = render({ pending, hold: NOT_HELD, canHold: false });
    expect(off).toContain("disabled");
    expect(off).toContain('title="Requires admin.edit"');
  });
  it("a held release prints no install time and says who held it", () => {
    const out = render({ pending, hold: { held: true, fromVersion: "1.3.0", by: "Dana", at: "2026-11-19T15:00:00Z" }, canHold: false });
    expect(out).not.toContain("It installs at");
    expect(out).not.toContain("Tonight");
    expect(out).toContain("is held.");
    expect(out).toContain("Release hold");
    expect(out).toContain('title="Requires admin.edit"');
  });
  it("an agent-held release shows its reason", () => {
    const out = render({ pending: { ...pending, state: "held", reason: "Held for the month-end close." }, hold: NOT_HELD, canHold: true });
    expect(out).toContain("Held for the month-end close.");
    expect(out).not.toContain("It installs at");
  });
  it("shows Release hold and who held it when held", () => {
    const out = render({ pending, hold: { held: true, fromVersion: "1.3.0", by: "Dana", at: "2026-11-19T15:00:00Z" }, canHold: true });
    expect(out).toContain("Release hold");
    expect(out).toContain("Held by Dana since Nov 19, 9:00 AM.");
  });
  it("shows nothing for a manual state, an unflagged update, no pending or no view", () => {
    expect(render({ pending: { ...pending, state: "manual", reason: "needs a person" }, hold: NOT_HELD, canHold: true })).toBe("");
    expect(render({ pending: { ...pending, databaseChanges: false }, hold: NOT_HELD, canHold: true })).toBe("");
    expect(render({ pending: null, hold: null, canHold: false })).toBe("");
    expect(render(null)).toBe("");
  });
  it("shows a refusal in the panel message", () => {
    expect(render({ pending, hold: NOT_HELD, canHold: true }, { message: "There is no database update to hold." })).toContain('role="alert"');
  });
});

import { invalidateUpdates, shouldCommitUpdatesRead, updatesGeneration } from "@/lib/updates-client";

describe("a read an invalidation overtook (shouldCommitUpdatesRead)", () => {
  it("commits only when nothing was invalidated and the effect is live", () => {
    expect(shouldCommitUpdatesRead(3, 3, false)).toBe(true);
    expect(shouldCommitUpdatesRead(3, 4, false)).toBe(false);
    expect(shouldCommitUpdatesRead(3, 3, true)).toBe(false);
  });
  it("invalidateUpdates bumps the generation synchronously", () => {
    const before = updatesGeneration();
    invalidateUpdates();
    expect(updatesGeneration()).toBe(before + 1);
    expect(shouldCommitUpdatesRead(before, updatesGeneration(), false)).toBe(false);
  });
});
