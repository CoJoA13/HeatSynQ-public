// P6 step 5d: ruling R1 (owner, 2026-10-22) on the admin row actions. A pick list's Active or flag
// change, a decimal box's save and a delete report under their row, and Add under the Add row; a
// user's row writes under that user's row, and Add user under its form; a role's permission change
// in that role's panel, its delete under its row in the list, and Add role under the Add row. Each
// is drawn through the shared `PanelMessage`. The page's line is left to the list read, which
// clears it when a read lands (the pick lists) or a refresh after a write lands (users, roles).
//
// The handlers are run from the production source (`callback`, `runNode`), over an environment the
// test builds, so each slot is proved by what the handler writes, not by where the source puts it.
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/fetcher";
import { callback, runNode, source } from "./helpers/lift-callback";
import { oneShotHold } from "../src/lib/single-flight";
import { component, panelMessages, stateSlots } from "./helpers/panel-slots";

const fail = (message: string, status = 400) => () => Promise.reject(new ApiError(message, status));
const ok = () => Promise.resolve({});
/** What a recorded updater makes of `before`, or the value itself when it was not one. */
const applied = (setter: ReturnType<typeof vi.fn>, before: unknown) => {
  const next = setter.mock.calls.at(-1)![0];
  return typeof next === "function" ? (next as (b: unknown) => unknown)(before) : next;
};

const TABLE = "components/ReferenceTable.tsx";
const USERS = "app/admin/users/page.tsx";
const ROLES = "app/admin/roles/page.tsx";

describe("the slots are declared and drawn (R1, P6 step 5d)", () => {
  it("ReferenceTable: a row's message under its row, Add's under the Add row", () => {
    const { file, fn } = component(TABLE, "ReferenceTable");
    expect(stateSlots(fn, file)).toEqual(expect.arrayContaining([
      ["rowMessage", "setRowMessage"], ["addMessage", "setAddMessage"],
    ]));
    expect(panelMessages(fn, file)).toEqual(["rowMessage?.rowId === r.id ? rowMessage.message : null", "addMessage"]);
  });
  it("users: a user's message on Selected user, Add user's under the form", () => {
    const { file, fn } = component(USERS, "UsersPage");
    expect(stateSlots(fn, file)).toEqual(expect.arrayContaining([
      ["rowMessage", "setRowMessage"], ["addMessage", "setAddMessage"],
    ]));
    expect(panelMessages(fn, file)).toEqual(["addMessage", "rowMessage?.userId === u.id ? rowMessage.message : null"]);
  });
  it("roles: a delete above the tabs, Add under the Add row, a permission change in the selected role's panels", () => {
    const { file, fn } = component(ROLES, "RolesPage");
    expect(stateSlots(fn, file)).toEqual(expect.arrayContaining([
      ["permissionsMessage", "setPermissionsMessage"], ["deleteMessage", "setDeleteMessage"], ["addMessage", "setAddMessage"],
    ]));
    expect(panelMessages(fn, file)).toEqual([
      "selected && deleteMessage?.roleId === selected.id ? deleteMessage.message : null", "addMessage",
      "permissionsMessage?.roleId === selected.id ? permissionsMessage.message : null",
      "permissionsMessage?.roleId === selected.id ? permissionsMessage.message : null",
    ]);
  });
});

describe("the pick lists' handlers write their row's or the Add row's slot, never the page's", () => {
  const row = { id: "ct-1", name: "Steel Basket", active: true };
  const env = (over: Record<string, unknown>) => {
    const setError = vi.fn(); const setRowMessage = vi.fn(); const setAddMessage = vi.fn(); const setBlocked = vi.fn();
    return {
      setError, setRowMessage, setAddMessage, setBlocked,
      env: {
        kind: "containerType", api: ok, load: ok, invalidateHistory: vi.fn(), invalidateSetupBanner: vi.fn(), addHold: oneShotHold(),
        READINESS_COUNTED_KINDS: new Set<string>(), ApiError, setError, setRowMessage, setAddMessage, setBlocked,
        clearRowMessage: (rowId: string) => setRowMessage((c: { rowId: string } | null) => (c?.rowId === rowId ? null : c)),
        ...over,
      },
    };
  };

  it("an Active change refused: under its row", async () => {
    const t = env({ api: fail("Requires admin.edit", 403) });
    await callback<(r: unknown, k: string) => Promise<void>>(TABLE, "ReferenceTable", "toggleFlag", t.env)(row, "active");
    expect(t.setRowMessage).toHaveBeenCalledWith({ rowId: "ct-1", message: "Requires admin.edit" });
    expect(t.setError).not.toHaveBeenCalled();
  });
  it("an Active change stored: clears its own row's message and leaves another row's", async () => {
    const t = env({});
    await callback<(r: unknown, k: string) => Promise<void>>(TABLE, "ReferenceTable", "toggleFlag", t.env)(row, "active");
    expect(applied(t.setRowMessage, { rowId: "ct-1", message: "x" })).toBeNull();
    expect(applied(t.setRowMessage, { rowId: "ct-2", message: "x" })).toEqual({ rowId: "ct-2", message: "x" });
    expect(t.setError).not.toHaveBeenCalled();
  });
  it("a delete refused with no blocker list: under its row", async () => {
    const t = env({ api: fail("Request failed (500)", 500), askConfirm: async () => true, labels: { singular: "Container type" } });
    await callback<(r: unknown) => Promise<void>>(TABLE, "ReferenceTable", "remove", t.env)(row);
    expect(t.setRowMessage).toHaveBeenCalledWith({ rowId: "ct-1", message: "Request failed (500)" });
    expect(t.setError).not.toHaveBeenCalled();
  });
  it("a delete refused whose blocker list could not be read: under its row, saying so", async () => {
    let calls = 0;
    const api = () => (++calls === 1 ? Promise.reject(new ApiError("In use", 400)) : Promise.reject(new Error("Failed to fetch")));
    const t = env({ api, askConfirm: async () => true, labels: { singular: "Container type" } });
    await callback<(r: unknown) => Promise<void>>(TABLE, "ReferenceTable", "remove", t.env)(row);
    expect(t.setRowMessage).toHaveBeenCalledWith({
      rowId: "ct-1", message: "In use — the list of what's using it could not be loaded (Failed to fetch). Try again.",
    });
    expect(t.setError).not.toHaveBeenCalled();
  });
  it("a delete refused with a blocker list: shows the list and clears its own row's message", async () => {
    let calls = 0;
    const api = () => (++calls === 1 ? Promise.reject(new ApiError("In use", 400)) : Promise.resolve([{ id: "o1" }]));
    const t = env({ api, askConfirm: async () => true, labels: { singular: "Container type" } });
    await callback<(r: unknown) => Promise<void>>(TABLE, "ReferenceTable", "remove", t.env)(row);
    expect(t.setBlocked).toHaveBeenCalledWith({ row, list: [{ id: "o1" }] });
    expect(applied(t.setRowMessage, { rowId: "ct-1", message: "x" })).toBeNull();
    expect(t.setError).not.toHaveBeenCalled();
  });
  it("Add refused by the server: under the Add row", async () => {
    const t = env({ api: fail("A container type with that name already exists"), extras: [], draft: { name: "Tote" }, buildPayload: () => ({}), setDraft: vi.fn() });
    await callback<() => Promise<void>>(TABLE, "ReferenceTable", "add", t.env)();
    expect(t.setAddMessage).toHaveBeenCalledWith("A container type with that name already exists");
    expect(t.setError).not.toHaveBeenCalled();
  });

  // The list read owns the page's line now that no row action writes it (HANDOFF's step-2 entry:
  // "the pick lists' table read stays in `error` until P6 5d splits that page").
  it("the list read owns the page's line: a failure lands there and a later read clears it", async () => {
    const file = source(TABLE); let found: ts.Node | undefined;
    const walk = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && n.name.getText(file) === "load" && n.initializer) found = n.initializer;
      ts.forEachChild(n, walk);
    };
    walk(file); expect(found).toBeDefined();
    const run = (api: () => Promise<unknown>) => {
      const setError = vi.fn();
      const load = runNode<() => Promise<void>>(found!, file, {
        useCallback: (fn: unknown) => fn, latest: { next: () => 1, isCurrent: () => true }, kind: "containerType",
        showInactiveNow: { current: false }, readsLanded: { current: 0 }, api, setRows: vi.fn(), setError,
      });
      return { load, setError };
    };
    const failed = run(fail("Request failed (503)", 503));
    await failed.load();
    expect(failed.setError.mock.calls).toEqual([["Request failed (503)"]]);
    const landed = run(() => Promise.resolve([]));
    await landed.load();
    expect(landed.setError.mock.calls).toEqual([[null]]);
  });
});

describe("users and roles: a row's write under its row, Add under its form, never the page's line", () => {
  it("users: a refused row write lands under that user", async () => {
    const setError = vi.fn(); const setRowMessage = vi.fn();
    await callback<(id: string, body: object) => Promise<void>>(USERS, "UsersPage", "patch", {
      api: fail("Cannot deactivate the last user who can manage users"), load: ok, invalidateSetupBanner: vi.fn(), setError, setRowMessage,
    })("u1", { active: false });
    expect(setRowMessage).toHaveBeenCalledWith({ userId: "u1", message: "Cannot deactivate the last user who can manage users" });
    expect(setError).not.toHaveBeenCalled();
  });
  it("users: a refused password stays with the dialog that asked, off the page's slots", async () => {
    const setError = vi.fn(); const setRowMessage = vi.fn(); const onRefusal = vi.fn();
    const landed = await callback<(id: string, body: object, opts: object) => Promise<boolean>>(USERS, "UsersPage", "patch", {
      api: fail("Password must be at least 8 characters"), load: ok, invalidateSetupBanner: vi.fn(), setError, setRowMessage,
    })("u1", { password: "x" }, { invalidatesSetup: true, onRefusal });
    expect(landed).toBe(false);
    expect(onRefusal).toHaveBeenCalledWith("Password must be at least 8 characters");
    expect(setRowMessage).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });
  it("users: a stored row write clears its own user's message and leaves another's", async () => {
    const setRowMessage = vi.fn();
    await callback<(id: string, body: object) => Promise<void>>(USERS, "UsersPage", "patch", {
      api: ok, load: () => Promise.resolve(true), invalidateSetupBanner: vi.fn(), setError: vi.fn(), setRowMessage,
    })("u1", { title: "x" });
    expect(applied(setRowMessage, { userId: "u1", message: "x" })).toBeNull();
    expect(applied(setRowMessage, { userId: "u2", message: "x" })).toEqual({ userId: "u2", message: "x" });
  });
  it("users: a refused Add lands under the form, and keeps what was typed", async () => {
    const setError = vi.fn(); const setAddMessage = vi.fn(); const setForm = vi.fn();
    await callback<() => Promise<void>>(USERS, "UsersPage", "create", {
      api: fail("A user with that username already exists"), load: ok, form: { roleId: "" }, setForm, setError, setAddMessage, createHold: oneShotHold(),
    })();
    expect(setAddMessage).toHaveBeenCalledWith("A user with that username already exists");
    expect(setForm).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });
  it("roles: a refused permission change lands in that role's panel", async () => {
    const setError = vi.fn(); const setPermissionsMessage = vi.fn();
    await callback<(roleId: string, permission: string) => Promise<void>>(ROLES, "RolesPage", "toggle", {
      api: fail("Cannot remove manage users from the last role that holds it"), load: ok,
      saveQueue: { current: Promise.resolve() }, rolesRef: { current: [{ id: "r1", permissions: [] }] }, setError, setPermissionsMessage,
    })("r1", "action.manage_users");
    expect(setPermissionsMessage).toHaveBeenCalledWith({ roleId: "r1", message: "Cannot remove manage users from the last role that holds it" });
    expect(setError).not.toHaveBeenCalled();
  });
  // Codex P1 on #794: a stored tick whose refresh fails must read the list again before the queue
  // moves on, or the next queued tick composes its whole permission array from the pre-PUT
  // snapshot and undoes this one. The read's failure is the page's line.
  it("roles: a stored tick whose refresh fails reads again before the next queued tick runs", async () => {
    const setError = vi.fn(); const reads: string[] = [];
    let n = 0;
    const load = () => { n += 1; reads.push(`read ${n}`); return n === 1 ? Promise.reject(new Error("Request failed (503)")) : Promise.resolve(true); };
    await callback<(roleId: string, permission: string) => Promise<void>>(ROLES, "RolesPage", "toggle", {
      api: ok, load, saveQueue: { current: Promise.resolve() }, rolesRef: { current: [{ id: "r1", permissions: [] }] },
      setError, setPermissionsMessage: vi.fn(),
    })("r1", "orders.view");
    expect(reads).toEqual(["read 1", "read 2"]);
    expect(setError).toHaveBeenCalledWith("Request failed (503)");
  });
  it("roles: a refused delete lands in its own slot, keyed to the role", async () => {
    const setError = vi.fn(); const setDeleteMessage = vi.fn();
    await callback<(role: unknown) => Promise<void>>(ROLES, "RolesPage", "remove", {
      api: fail("Role is assigned to 2 users"), load: ok, askReason: async () => "cleanup", ROLE_DELETE_REASON_REQUIRED: "", setError, setDeleteMessage,
    })({ id: "r1", name: "Clerk" });
    expect(setDeleteMessage).toHaveBeenCalledWith({ roleId: "r1", message: "Role is assigned to 2 users" });
    expect(setError).not.toHaveBeenCalled();
  });
  it("roles: a refused Add lands under the Add row, and keeps what was typed", async () => {
    const setError = vi.fn(); const setAddMessage = vi.fn(); const setNewName = vi.fn();
    await callback<() => Promise<void>>(ROLES, "RolesPage", "create", {
      api: fail("A role with that name already exists"), load: ok, newName: "Clerk", setNewName, setError, setAddMessage, createHold: oneShotHold(),
    })();
    expect(setAddMessage).toHaveBeenCalledWith("A role with that name already exists");
    expect(setNewName).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });
});
