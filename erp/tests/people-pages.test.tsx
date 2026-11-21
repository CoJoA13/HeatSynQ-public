// The People & system pages' leaves and shapes (spec 2026-10-30-ux-redesign-design.md §4.3–§4.6; the
// UX redesign PR 12, owner 2026-11-02 on #827). Read as text, because vitest renders none of these
// pages; their handlers are lifted in tests/admin-panel-messages.test.ts and read-slot-owners.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tabForLocation } from "@/lib/record-tabs";
import { LAST_MANAGER_REFUSAL } from "@/server/last-manager";
import { setupStateWord } from "@/lib/setup-words";
import { NO_ROLE_DELETE, NO_ROLE_SELECTED, ROLE_TAB_LABEL, deleteRoleGate, roleTabs, specialActionName } from "@/lib/role-tabs";
import { NO_USER_SELECTED, USER_TAB_LABEL, signatureText, userTabs } from "@/lib/user-tabs";

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), "utf8");

describe("the Users page", () => {
  const src = read("app/admin/users/page.tsx");

  it("names its two tabs, none registering unsaved work", () => {
    expect(userTabs().map((t) => [t.key, t.label])).toEqual([["list", "User list"], ["selected", "Selected user"]]);
    expect(USER_TAB_LABEL).toBe("User sections");
    expect(userTabs().every((t) => t.sections.length === 0)).toBe(true);
    expect(tabForLocation(userTabs(), "", "#new-user")).toBe("list");
    expect(tabForLocation(userTabs(), "", "#selected-user")).toBe("selected");
  });

  it("reads the Signature flag and the empty sentence", () => {
    expect(signatureText(true)).toBe("Present");
    expect(signatureText(false)).toBe("Not set");
    expect(NO_USER_SELECTED).toBe("Select a user to view their details.");
  });

  it("takes the header, with Add user taking the cursor to the form", () => {
    expect(src).toContain('<PageHeader title="Users"');
    expect(src).not.toContain("<h1");
    expect(src).toMatch(/onClick=\{focusNewUser\}[^>]*>\s*Add user/);
    expect(src).toContain("focusWhenShown(() => usernameRef.current)");
    expect(src).not.toContain("reset…");
  });

  it("the list is read-only: its columns, no box in it, the row's one control the Username button", () => {
    const list = src.slice(src.indexOf('id="user-list"'), src.indexOf('id="new-user"'));
    for (const heading of ["Username", "Name", "Role", "Active", "Signature"]) expect(list).toContain(`>${heading}</th>`);
    expect(list).not.toContain(">Title</th>");
    expect(list).not.toContain("<input");
    expect(list).not.toContain("<select");
    expect(list).toContain('aria-current={selected === row.id ? "true" : undefined}');
    expect(list).toContain("after:absolute after:inset-0");
    expect(list).toContain("signatureText(row.hasSignature)");
  });

  it("holds the editing on Selected user, each write as it was", () => {
    const card = src.slice(src.indexOf('id="selected-user"'));
    expect(card).toContain('<TextCell key={u.id} user={u} field="displayName"');
    expect(card).toContain('<TextCell key={u.id} user={u} field="title"');
    expect(card).toContain("patch(u.id, { roleId: e.target.value || null })");
    expect(card).toContain("patch(u.id, { active: e.target.checked })");
    expect(card).toContain("<UserSignatureControl key={u.id}");
    expect(card).toContain("rowMessage?.userId === u.id ? rowMessage.message : null");
    expect(card).toMatch(/onClick=\{\(\) => setPassword\(u\)\}[^>]*>\s*Set password/);
  });

  it("opens the row through a fresh request, so the same row opens again", () => {
    expect(src).toContain("openRequests.current += 1");
    expect(src).toContain("setSelected(id);");
    expect(src).toContain('openPanel("selected-user");');
  });
});

describe("the Roles page", () => {
  const src = read("app/admin/roles/page.tsx");

  it("names its three tabs, none registering unsaved work", () => {
    expect(roleTabs().map((t) => [t.key, t.label])).toEqual([["roles", "Roles"], ["area", "Area permissions"], ["special", "Special actions"]]);
    expect(ROLE_TAB_LABEL).toBe("Role sections");
    expect(roleTabs().every((t) => t.sections.length === 0)).toBe(true);
    expect(tabForLocation(roleTabs(), "", "#new-role")).toBe("roles");
    expect(tabForLocation(roleTabs(), "", "#special-actions")).toBe("special");
  });

  it("closes Delete unused role until a role is picked, the permission's reason winning", () => {
    const open = { disabled: false, title: undefined };
    const denied = { disabled: true, title: "Requires manage_users" };
    expect(NO_ROLE_DELETE).toBe("Select a role first.");
    expect(deleteRoleGate(open, false)).toEqual({ disabled: true, title: NO_ROLE_DELETE });
    expect(deleteRoleGate(denied, false)).toEqual(denied);
    expect(deleteRoleGate(denied, true)).toEqual(denied);
    expect(deleteRoleGate(open, true)).toEqual(open);
  });

  // Ruling R8 (#648 part 2, #718): the page gates every write on the routes' own permission, as
  // spec §15's "the UI gate must match the route" asks. Mutation: put either gate back on its
  // admin permission and this reds.
  it("gates Add role, every tick and Delete unused role on manage_users, as the routes do", () => {
    expect(src).toContain('const canEdit = gateDo(perms, "manage_users");');
    expect(src).toContain("const canDelete = canEdit;");
    expect(src).not.toMatch(/gate\(perms, "admin\.(edit|delete)"\)/);
  });

  it("spaces a special action's name, and keeps the empty sentence", () => {
    expect(specialActionName("override_credit_hold")).toBe("override credit hold");
    expect(NO_ROLE_SELECTED).toBe("Select a role to view its permissions.");
  });

  it("takes the header: Add role and the title-row danger button on the selected role", () => {
    expect(src).toContain('<PageHeader title="Roles" subtitle="Grant capabilities deliberately; keep special actions separate."');
    expect(src).not.toContain("<h1");
    expect(src).toMatch(/onClick=\{focusNewRole\}[^>]*>\s*Add role/);
    expect(src).toContain("focusWhenShown(() => nameRef.current)");
    expect(src).toContain("<DangerButton disabled={removeGate.disabled} title={removeGate.title}");
    expect(src).toContain("if (selected) void remove(selected);");
    expect(src).toMatch(/>\s*Delete unused role\s*</);
  });

  it("the Roles table's columns; the row's one control its Role button, no delete in it", () => {
    const list = src.slice(src.indexOf('id="role-list"'), src.indexOf('id="new-role"'));
    for (const heading of ["Role", "Users"]) expect(list).toContain(`>${heading}</th>`);
    expect(list).toContain('aria-current={selected?.id === r.id ? "true" : undefined}');
    expect(list).toContain("after:absolute after:inset-0");
    expect(list).toContain("{r.userCount}");
    expect(list).not.toContain("remove(");
  });

  it("every tick on both tabs goes through the one queue", () => {
    const area = src.slice(src.indexOf('id="area-permissions"'), src.indexOf('id="special-actions"'));
    const special = src.slice(src.indexOf('id="special-actions"'));
    expect(area).toContain("toggle(selected.id, key)");
    expect(special).toContain("toggle(selected.id, key)");
    expect(area).toContain("CRUD_ACTIONS.map");
    expect(special).toContain("SPECIAL_ACTIONS.map");
    for (const heading of ["Action", "Granted"]) expect(special).toContain(`>${heading}</th>`);
    expect(area).toContain("{selected.name} — permissions");
    expect(special).toContain("{selected.name} — special actions");
  });
});

describe("the last-manager sentence (#827)", () => {
  it("is the owner's", () => {
    expect(LAST_MANAGER_REFUSAL).toBe("At least one active user must retain the ability to manage users.");
  });
});

describe("the Audit log", () => {
  const src = read("app/admin/audit/page.tsx");
  it("states the limit, Search in the header, the filters in a card", () => {
    expect(src).toContain('<PageHeader title="Audit log" subtitle="Newest 200 matching events."');
    expect(src).not.toContain("<h1");
    expect(src).toMatch(/onClick=\{load\}[^>]*>Search</);
    expect(src).toContain(">Filters</h2>");
  });
  it("keeps the short id, the full one on hover", () => {
    expect(src).toContain("title={e.entityId}");
    expect(src).toContain("e.entityId.slice(0, 8)");
  });
});

describe("Backups", () => {
  const src = read("app/admin/backups/page.tsx");
  it("takes the header with Back up now, and no Administration", () => {
    expect(src).toContain('<PageHeader title="Backups" subtitle="Production archives and current backup health."');
    expect(src).not.toContain("<h1");
    expect(src).not.toContain("Administration");
    expect(src).toContain("disabled={runDisabled}");
  });
  it("keeps the red banner, the folder and the filename column", () => {
    expect(src).toContain('"border-red-300 bg-red-50 text-red-900"');
    expect(src).toContain("Backup folder:");
    expect(src).toContain(">Archive</th>");
    expect(src).toContain("{a.name}");
  });
  it("reads the card from the leaf, and only over a health it holds", () => {
    expect(src).toContain("const glance = health ? backupGlance(health, view?.archives ?? []) : null;");
    expect(src).toMatch(/\{glance && \(\s*<AtAGlance/);
    for (const label of ["Latest run", "Integrity", "Stale threshold"]) expect(src).toContain(`label: "${label}"`);
  });
});

describe("Practice data", () => {
  const page = read("app/practice/page.tsx");
  const control = read("app/practice/PracticeResetControl.tsx");
  it("takes the header on both copies, the production notice unchanged", () => {
    expect(page).toContain('<PageHeader title="Practice data" subtitle="A separate installation and database, never a live-mode toggle." />');
    expect(page).not.toContain("<h1");
    expect(page).toContain("This is the production system.");
  });
  it("keeps the green line, the automatic sign-out and the red button", () => {
    expect(control).toContain("Signing you out — sign back in with admin / admin.");
    expect(control).toContain('window.location.href = "/login"');
    expect(control).toContain("BUTTON_DANGER_FILL");
  });
});

describe("the Setup checklist", () => {
  const src = read("app/setup/SetupChecklist.tsx");
  const readiness = read("server/install-readiness.ts");

  it("reads a step's state", () => {
    expect(setupStateWord({ key: "company", complete: true, blocking: true })).toBe("Complete");
    expect(setupStateWord({ key: "numbers", complete: true, blocking: false })).toBe("Complete");
    expect(setupStateWord({ key: "numbers", complete: false, blocking: false })).toBe("Needs confirmation");
    expect(setupStateWord({ key: "company", complete: false, blocking: true })).toBe("Required");
    expect(setupStateWord({ key: "parts", complete: false, blocking: false })).toBe("Not done");
  });

  it("names the eight steps in the owner's words", () => {
    for (const label of ["Administrator password", "Company identity", "Chart of accounts", "Process codes & surcharges",
      "Reference lists", "First customers", "First parts", "Starting document numbers"]) {
      expect(readiness).toContain(`label: "${label}"`);
    }
  });

  it("is a table, with Mark confirmed, the link and Dismiss kept and no header button", () => {
    for (const heading of ["Item", "State", "Where"]) expect(src).toContain(`>${heading}</th>`);
    expect(src).not.toContain("<ul");
    expect(src).toContain("Mark confirmed");
    expect(src).toContain(">Set up</Link>");
    expect(src).toContain("<DismissChecklistView");
    expect(src).toContain("setupStateWord(s)");
    expect(src).not.toContain("<h1");
    expect(src.match(/<PageHeader title="Setup checklist"/g)).toHaveLength(2);
  });
});
