import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The redesign's chrome in Shell.tsx (spec 2026-10-30 §4.2), pinned as text the way
 * tests/build-version.test.ts pins the build label: the Shell cannot be rendered under vitest
 * (its effects need a browser), so each decision is held by the source it must contain.
 */
const shell = readFileSync(join(process.cwd(), "src/components/Shell.tsx"), "utf8");

describe("Shell chrome (2026-10-30)", () => {
  it("folds the admin groups under a Settings & administration toggle that says its state", () => {
    expect(shell).toContain("aria-expanded={expanded}");
    expect(shell).toContain("aria-controls={adminId}");
    expect(shell).toContain("hidden={!expanded}");
    expect(shell).toContain("Settings &amp; administration");
    expect(shell).toContain("isAdminGroup");
  });
  it("draws the wordmark as text, not the logo image", () => {
    expect(shell).not.toContain("heatsynq-logo-dark");
    expect(shell).toContain('<span className="text-accent-400">Q</span>');
  });
  it("the header's search fills the width with the redesign's placeholder, Drafts, Help and the initials chip", () => {
    expect(shell).toContain('placeholder="Search order, PO, part, customer… or scan traveler"');
    expect(shell).not.toContain("max-w-xl");
    expect(shell).toContain('href="/manual.html" target="_blank" rel="noopener" data-navigation="document"');
    expect(shell).toContain("<DraftsInTab />");
    expect(shell).toContain("{initials(me.displayName)}");
  });
  it("Sign out and the build version sit in the rail foot, after the toggle", () => {
    const toggle = shell.indexOf("Settings &amp; administration");
    const signOut = shell.indexOf(">Sign out<");
    const build = shell.indexOf("Build Version:");
    const header = shell.indexOf("<header");
    expect(toggle).toBeGreaterThan(-1);
    expect(signOut).toBeGreaterThan(toggle);
    expect(build).toBeGreaterThan(signOut);
    expect(header).toBeGreaterThan(build);
  });
});
