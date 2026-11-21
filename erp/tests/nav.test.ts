import { describe, it, expect } from "vitest";
import { ADMIN_HEADINGS, NAV_GROUPS, NAV_ENTRIES, isAdminGroup, visibleGroups, navIsActive, canSeeEntry } from "@/lib/nav";

// The Shell's nav model, pulled into a pure client-safe module so three decisions are testable
// without rendering React (the permission-ui.ts precedent):
//   1. the rail's grouping, order and labels — the first navigation batch of the 2026-09-13 UI/UX
//      proposal (#303), which regrouped two flat lists into seven headed groups and renamed six
//      entries WITHOUT touching any route or gate, regrouped again on 2026-10-30 into the Figma
//      redesign's six (owner-accepted labels: Daily work, Billing, Reference; Parts & processes;
//      Process step codes under Configuration; Reports inside Reference), again touching no gate;
//   2. the permission-set → visible-groups decision — THE NAV DECISION (Task 16, spec §5.5) that
//      Document templates is gated on `templates.view` specifically, and the Phase 8C rule that
//      Backups is gated on the `manage_backups` ACTION; a heading renders only over a visible entry;
//   3. the active-entry rule ("/" exact, everything else by prefix).

const group = (heading: string | null) => NAV_GROUPS.find((g) => g.heading === heading);
const labels = (perms: string[] | undefined) =>
  visibleGroups(perms).map((g) => [g.heading, g.entries.map((e) => e.label)]);

describe("the rail's shape (the agreed grouping, order and labels)", () => {
  it("has the six groups in the agreed order, every one headed", () => {
    expect(NAV_GROUPS.map((g) => g.heading)).toEqual([
      "Daily work", "Billing", "Reference", "Configuration", "People", "System",
    ]);
  });

  it("names the three admin groups, which the rail folds under Settings & administration", () => {
    expect(NAV_GROUPS.filter(isAdminGroup).map((g) => g.heading)).toEqual(["Configuration", "People", "System"]);
    expect([...ADMIN_HEADINGS]).toEqual(["Configuration", "People", "System"]);
  });

  it("Daily work runs Orders → Quotes → Shipping → Certifications (Shipping before the certs it creates)", () => {
    expect(group("Daily work")!.entries.map((e) => e.label)).toEqual(["Orders", "Quotes", "Shipping", "Certifications"]);
  });

  it("Billing and Reference, Reports inside Reference", () => {
    expect(group("Billing")!.entries.map((e) => e.label)).toEqual(["Invoicing", "Receivables"]);
    expect(group("Reference")!.entries.map((e) => e.label)).toEqual([
      "Customers", "Parts & processes", "Reports",
    ]);
  });

  it("Configuration, People and System, with Setup checklist last in the rail", () => {
    expect(group("Configuration")!.entries.map((e) => e.label)).toEqual([
      "Settings", "Accounting", "Surcharges", "Pick lists", "Process step codes", "Part fields", "Document templates",
    ]);
    expect(group("People")!.entries.map((e) => e.label)).toEqual(["Users", "Roles"]);
    expect(group("System")!.entries.map((e) => e.label)).toEqual([
      "System", "Audit log", "Backups", "Practice data", "Setup checklist",
    ]);
    expect(NAV_ENTRIES[NAV_ENTRIES.length - 1].label).toBe("Setup checklist");
  });

  it("no href and no label appears twice", () => {
    expect(new Set(NAV_ENTRIES.map((e) => e.href)).size).toBe(NAV_ENTRIES.length);
    expect(new Set(NAV_ENTRIES.map((e) => e.label)).size).toBe(NAV_ENTRIES.length);
  });

  // The regrouping's one hard promise: every existing route keeps the one gate it declared before.
  // The renamed entries are keyed by their (unchanged) routes so a label change cannot hide a gate
  // change. Audit log stays on `admin.view` — the proposed `read_audit` action is NOT in this batch.
  it("every route keeps exactly the gate it had before the regrouping", () => {
    const gates = Object.fromEntries(NAV_ENTRIES.map((e) => [e.href, e.action ? `action.${e.action}` : `${e.area}.view`]));
    expect(gates).toEqual({
      "/": "orders.view",
      "/quotes": "quotes.view",
      "/shipping": "shipping.view",
      "/certs": "certs.view",
      "/invoicing": "invoicing.view",
      "/receivables": "receivables.view",
      "/customers": "customers.view",
      "/parts": "parts.view",
      "/admin/step-codes": "admin.view",
      "/reports": "reports.view",
      "/admin/settings": "admin.view",
      "/admin/billing": "admin.view",
      "/admin/surcharges": "admin.view",
      "/admin/reference": "admin.view",
      "/admin/part-fields": "admin.view",
      "/admin/templates": "templates.view",
      "/admin/users": "admin.view",
      "/admin/system": "admin.view",
      "/admin/roles": "admin.view",
      "/admin/audit": "admin.view",
      "/admin/backups": "action.manage_backups",
      "/practice": "admin.view",
      "/setup": "admin.view",
    });
  });

  it("the renamed entries point at their old routes", () => {
    const byLabel = Object.fromEntries(NAV_ENTRIES.map((e) => [e.label, e.href]));
    expect(byLabel["Accounting"]).toBe("/admin/billing");
    expect(byLabel["Pick lists"]).toBe("/admin/reference");
    expect(byLabel["Document templates"]).toBe("/admin/templates");
    expect(byLabel["Setup checklist"]).toBe("/setup");
    expect(byLabel["Practice data"]).toBe("/practice");
    expect(byLabel["Parts & processes"]).toBe("/parts");
  });
});

describe("nav gating (visible groups per permission set)", () => {
  it("a templates.view-only user sees ONLY Configuration / Document templates (reaches it without admin.view)", () => {
    expect(labels(["templates.view"])).toEqual([["Configuration", ["Document templates"]]]);
  });

  it("an admin.view-only user sees the admin screens across their groups but NOT Document templates or Backups", () => {
    expect(labels(["admin.view"])).toEqual([
      ["Configuration", ["Settings", "Accounting", "Surcharges", "Pick lists", "Process step codes", "Part fields"]],
      ["People", ["Users", "Roles"]],
      ["System", ["System", "Audit log", "Practice data", "Setup checklist"]],
    ]);
  });

  it("a manage_backups-only holder sees System / Backups and nothing else", () => {
    expect(labels(["action.manage_backups"])).toEqual([["System", ["Backups"]]]);
  });

  it("both admin.view and templates.view → Document templates joins Configuration in its own slot", () => {
    const config = visibleGroups(["admin.view", "templates.view"]).find((g) => g.heading === "Configuration")!;
    expect(config.entries.map((e) => e.label)).toEqual([
      "Settings", "Accounting", "Surcharges", "Pick lists", "Process step codes", "Part fields", "Document templates",
    ]);
  });

  it("work-area users see only their own entries, and a group with no visible entry disappears with its heading", () => {
    expect(labels(["orders.view"])).toEqual([["Daily work", ["Orders"]]]);
    // processes.view alone reaches no rail entry: process steps live on the part page.
    expect(labels(["parts.view", "processes.view"])).toEqual([["Reference", ["Parts & processes"]]]);
    // Reports alone: Reference shows with the one entry.
    expect(labels(["reports.view"])).toEqual([["Reference", ["Reports"]]]);
    // A view grant on a different area never reaches an admin.view-gated entry in the same group.
    expect(labels(["parts.view"]).flatMap(([, l]) => l)).not.toContain("Process step codes");
  });

  it("nothing is visible while permissions are still loading, or with no grants at all", () => {
    expect(visibleGroups(undefined)).toEqual([]);
    expect(visibleGroups([])).toEqual([]);
  });

  it("canSeeEntry checks the ONE gate an entry declares — area as <area>.view, action as action.<name>", () => {
    const backups = NAV_ENTRIES.find((e) => e.href === "/admin/backups")!;
    const audit = NAV_ENTRIES.find((e) => e.href === "/admin/audit")!;
    expect(canSeeEntry(["action.manage_backups"], backups)).toBe(true);
    expect(canSeeEntry(["admin.view"], backups)).toBe(false);
    expect(canSeeEntry(["admin.view"], audit)).toBe(true);
    expect(canSeeEntry(["action.manage_backups"], audit)).toBe(false);
  });
});

describe("the active entry", () => {
  it("each entry's own href lights up exactly that entry", () => {
    for (const entry of NAV_ENTRIES) {
      const active = NAV_ENTRIES.filter((e) => navIsActive(e.href, entry.href)).map((e) => e.label);
      expect(active, `on ${entry.href}`).toEqual([entry.label]);
    }
  });

  it("detail and child routes light up their section, never Orders", () => {
    const activeOn = (pathname: string) => NAV_ENTRIES.filter((e) => navIsActive(e.href, pathname)).map((e) => e.label);
    expect(activeOn("/orders/abc123")).toEqual([]); // the order hub is not the board; nothing lights (unchanged)
    expect(activeOn("/customers/abc123")).toEqual(["Customers"]);
    expect(activeOn("/receivables/aging")).toEqual(["Receivables"]);
    expect(activeOn("/receivables/batches/abc123")).toEqual(["Receivables"]);
    expect(activeOn("/admin/templates/abc123/edit")).toEqual(["Document templates"]);
    expect(activeOn("/reports/backlog")).toEqual(["Reports"]);
    expect(activeOn("/admin/step-codes")).toEqual(["Process step codes"]);
    expect(activeOn("/setup")).toEqual(["Setup checklist"]);
    expect(activeOn("/practice")).toEqual(["Practice data"]);
    expect(activeOn("/login")).toEqual([]);
  });
});
