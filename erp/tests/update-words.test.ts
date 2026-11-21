import { describe, it, expect } from "vitest";
import { bannerParts, heldLine, emptyLine, heldStatus, holdOffered, installsRow, installedNoteBody, pendingCard, pendingBlock } from "@/lib/update-words";
import {
  DATABASE_CHANGES_AFTER, DATABASE_CHANGES_HEADING, DATABASE_CHANGE_SECTIONS, HOLD_SECTION,
} from "@/lib/database-change-words";

// Friday Nov 20 2026, 4:00 AM America/Chicago (CST, UTC-6) = 10:00Z.
const INSTALL = "2026-11-20T10:00:00Z";
const pending = { version: "1.4.0", installAfter: INSTALL, databaseChanges: true, state: "scheduled" as const, reason: null };

describe("bannerParts", () => {
  it("says Tonight's when the install is within 24 hours", () => {
    const p = bannerParts(pending, new Date("2026-11-19T20:00:00Z"));
    expect(p.headline).toBe("Tonight's update, 1.4.0, changes the database.");
    expect(p.installs).toBe("It installs at 4:00 AM on Friday, Nov 20.");
  });
  it("names the day when the install is 30 hours out", () => {
    const p = bannerParts(pending, new Date("2026-11-19T04:00:00Z"));
    expect(p.headline).toBe("The update on Friday, Nov 20, 1.4.0, changes the database.");
  });
  it("carries the approved sections and the Hold line, verbatim", () => {
    const p = bannerParts(pending, new Date("2026-11-19T20:00:00Z"));
    expect(p.sections).toEqual([
      ...DATABASE_CHANGE_SECTIONS.map((x) => ({ label: `${x.label}:`, text: x.text })), HOLD_SECTION,
    ]);
    expect(p.sections[3].text).toContain("**Hold**");
  });
});

describe("bannerParts timing edges", () => {
  const at = (ms: number) => new Date(Date.parse(INSTALL) - ms);
  const H = 3600_000;
  it("24 hours out is tonight; 24 hours and a minute is not", () => {
    expect(bannerParts(pending, at(24 * H)).headline).toMatch(/^Tonight's/);
    expect(bannerParts(pending, at(24 * H + 60_000)).headline).toMatch(/^The update on Friday, Nov 20/);
  });
  it("a past installAfter while scheduled reads the next 4:00 AM, with no time sentence", () => {
    const p = bannerParts(pending, at(-H));
    expect(p.headline).toBe("The update 1.4.0, which changes the database, installs at the next 4:00 AM.");
    expect(p.installs).toBeNull();
  });
  it("a held update says held and prints no install time", () => {
    for (const p of [bannerParts(pending, at(H), true), bannerParts({ ...pending, state: "held", reason: "r" }, at(H))]) {
      expect(p.headline).toBe("The update 1.4.0, which changes the database, is held.");
      expect(p.installs).toBeNull();
    }
  });
});

describe("heldStatus", () => {
  it("is the hold line, else the agent's reason when held by the agent, else null", () => {
    expect(heldStatus(pending, { held: true, by: "Dana", at: INSTALL })).toBe("Held by Dana since Nov 20, 4:00 AM.");
    expect(heldStatus({ ...pending, state: "held", reason: "waiting" }, null)).toBe("waiting");
    expect(heldStatus(pending, null)).toBeNull();
  });
});

describe("heldLine", () => {
  it("names who and when on the plant clock", () => {
    expect(heldLine({ by: "Dana", at: INSTALL })).toBe("Held by Dana since Nov 20, 4:00 AM.");
  });
});

describe("installedNoteBody", () => {
  it("passes an unflagged note through", () => {
    expect(installedNoteBody({ databaseChanges: false, body: "## Database changes\n\nx" })).toBe("## Database changes\n\nx");
  });
  it("replaces the content of the Database changes section, keeping the heading and later sections", () => {
    const body = `intro\n\n${DATABASE_CHANGES_HEADING}\n\nold text\nmore\n\n## Other\n\nkept`;
    const out = installedNoteBody({ databaseChanges: true, body });
    expect(out).toBe(`intro\n\n${DATABASE_CHANGES_HEADING}\n\n${DATABASE_CHANGES_AFTER}\n\n## Other\n\nkept`);
    expect(out).not.toContain("old text");
  });
  it("replaces to the end when the section is last", () => {
    const out = installedNoteBody({ databaseChanges: true, body: `${DATABASE_CHANGES_HEADING}\n\nold` });
    expect(out).toBe(`${DATABASE_CHANGES_HEADING}\n\n${DATABASE_CHANGES_AFTER}`);
  });
  it("puts the heading and text at the top when the heading is absent", () => {
    const out = installedNoteBody({ databaseChanges: true, body: "- a" });
    expect(out.startsWith(`${DATABASE_CHANGES_HEADING}\n\n${DATABASE_CHANGES_AFTER}`)).toBe(true);
    expect(out.endsWith("- a")).toBe(true);
  });
});

describe("pendingBlock", () => {
  it("shows the note as written when present, else the wording or a plain statement", () => {
    expect(pendingBlock(pending, { body: "x" })).toBe("note");
    expect(pendingBlock(pending, null)).toBe("wording");
    expect(pendingBlock({ ...pending, databaseChanges: false }, null)).toBe("plain");
  });
});

describe("pendingCard", () => {
  const at = (ms: number) => new Date(Date.parse(INSTALL) - ms);
  const manual = { ...pending, state: "manual" as const, reason: "Needs a person to install it." };
  it("a manual release shows its reason and no install time, future or past", () => {
    for (const now of [at(3600_000), at(-3600_000)]) {
      const c = pendingCard(manual, null, now);
      expect(c.detail).toBe("Needs a person to install it.");
      expect(c.headline).toContain("will not install by itself");
      expect(`${c.headline} ${c.detail}`).not.toMatch(/installs at/);
    }
  });
  it("hold.held wins over the agent's reason; an agent hold alone shows its reason", () => {
    const both = { ...pending, state: "held" as const, reason: "agent reason" };
    expect(pendingCard(both, { held: true, by: "Dana", at: INSTALL }, at(3600_000)).detail).toBe("Held by Dana since Nov 20, 4:00 AM.");
    expect(pendingCard(both, { held: false, by: null, at: null }, at(3600_000)).detail).toBe("agent reason");
  });
  it("a scheduled release that does not change the database shows its install sentence, or the past form", () => {
    const plain = { ...pending, databaseChanges: false };
    expect(pendingCard(plain, null, at(3600_000)).detail).toBe("It installs at 4:00 AM on Friday, Nov 20.");
    expect(pendingCard(plain, null, at(-3600_000)).detail).toBe("It installs at the next 4:00 AM.");
  });
  it("a database release shows the banner headline and install sentence", () => {
    const c = pendingCard(pending, null, at(3600_000));
    expect(c.headline).toMatch(/^Tonight's/);
    expect(c.detail).toBe("It installs at 4:00 AM on Friday, Nov 20.");
  });
});

describe("holdOffered", () => {
  const NOT = { held: false };
  it("offers Hold only for a releasable database update", () => {
    expect(holdOffered(pending, NOT)).toBe(true);
    expect(holdOffered({ ...pending, state: "manual", reason: "r" }, NOT)).toBe(false);
    expect(holdOffered({ ...pending, databaseChanges: false }, NOT)).toBe(false);
    expect(holdOffered(null, NOT)).toBe(false);
  });
  it("offers Release hold whenever a hold stands, whatever the pending release is", () => {
    const held = { held: true };
    expect(holdOffered(null, held)).toBe(true);
    expect(holdOffered({ ...pending, state: "manual", reason: "r" }, held)).toBe(true);
    expect(holdOffered({ ...pending, databaseChanges: false }, held)).toBe(true);
  });
});

describe("installsRow", () => {
  const at = (ms: number) => new Date(Date.parse(INSTALL) - ms);
  it("agrees with pendingCard in every state", () => {
    const manual = { ...pending, state: "manual" as const, reason: "Needs a person." };
    expect(installsRow(manual, { held: true, by: "Dana", at: INSTALL }, at(3600_000))).toBe("Needs a person.");
    expect(pendingCard(manual, { held: true, by: "Dana", at: INSTALL }, at(3600_000)).detail).toBe("Needs a person.");
    expect(installsRow(pending, null, at(3600_000))).toBe("Friday, Nov 20 at 4:00 AM");
    expect(installsRow(pending, null, at(-3600_000))).toBe("The next 4:00 AM");
    expect(installsRow(pending, { held: true, by: "Dana", at: INSTALL }, at(3600_000))).toBe("Held by Dana since Nov 20, 4:00 AM.");
    expect(installsRow({ ...pending, state: "held", reason: "agent" }, null, at(3600_000))).toBe("agent");
    expect(installsRow(null, null, at(0))).toBe("\u2014");
  });
});

describe("emptyLine", () => {
  const ok = { viewLoaded: true, permsLoaded: true, permsFailed: false, canView: true, running: "1.3.0" };
  it("waits for both reads, and says nothing after a failed permission read", () => {
    expect(emptyLine({ ...ok, viewLoaded: false })).toBe("Loading\u2026");
    expect(emptyLine({ ...ok, permsLoaded: false })).toBe("Loading\u2026");
    expect(emptyLine({ ...ok, permsLoaded: false, permsFailed: true })).toBeNull();
  });
  it("tells no access, no information and nothing waiting apart", () => {
    expect(emptyLine({ ...ok, canView: false })).toBe("Update details need admin.view access.");
    expect(emptyLine({ ...ok, running: null })).toBe("No update information on this install.");
    expect(emptyLine(ok)).toBe("No update is waiting to install.");
  });
});
