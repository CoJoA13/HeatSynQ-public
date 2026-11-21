"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/fetcher";
import { AREAS, CRUD_ACTIONS, SPECIAL_ACTIONS } from "@/lib/permission-constants";
import { askReason } from "@/lib/modal";
import { gateDo } from "@/lib/permission-ui";
import { ROLE_DELETE_REASON_REQUIRED } from "@/lib/role-delete-words";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest, useMutationGate } from "@/lib/use-latest";
import { DangerButton } from "@/components/DangerButton";
import { PageHeader } from "@/components/PageHeader";
import { PanelMessage } from "@/components/PanelMessage";
import { RecordTabs } from "@/components/RecordTabs";
import { focusWhenShown } from "@/lib/focus-when-shown";
import { NO_ROLE_SELECTED, ROLE_TAB_LABEL, deleteRoleGate, roleTabs, specialActionName } from "@/lib/role-tabs";
import { BUTTON_PRIMARY, BUTTON_PRIMARY_COMPACT, CARD, CARD_FLUSH, INPUT_COMPACT, LINK, NOTICE, TABLE_CELL, TABLE_HEAD } from "@/lib/ui-classes";
import { oneShotHold } from "@/lib/single-flight";

type Role = { id: string; name: string; permissions: string[]; userCount: number };

export default function RolesPage() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [selected, setSelected] = useState<Role | null>(null);
  const [newName, setNewName] = useState("");
  // The page's line is the list read's. A role's own writes report beside it (owner ruling R1, P6
  // step 5d), through the shared PanelMessage: a permission change in that role's panels, a delete
  // above the tabs, since its button is the title row's, each shown only while the role is selected,
  // and Add under the Add row. One of each at a time, keyed to the role it was raised for; a role's
  // success clears only its own.
  const [error, setError] = useState<string | null>(null);
  const [permissionsMessage, setPermissionsMessage] = useState<{ roleId: string; message: string } | null>(null);
  const [deleteMessage, setDeleteMessage] = useState<{ roleId: string; message: string } | null>(null);
  const [addMessage, setAddMessage] = useState<string | null>(null);
  // #720: Create's hold, so a second click while the POST is out sends nothing (it would be
  // refused as a duplicate name after the first landed).
  const [creating, setCreating] = useState(false);
  const [createHold] = useState(() => oneShotHold(setCreating));
  const { permissions: perms, error: permsError } = usePermissions();
  // Gated on the permission the routes enforce (spec §15: the UI gate must match the route). Under
  // ruling R8 (#648 part 2, #718) Add role, every permission tick and Delete unused role hit
  // routes requiring action.manage_users alone (src/app/api/admin/roles/route.ts,
  // .../roles/[id]/route.ts); the list this page reads stays on admin.view.
  const canEdit = gateDo(perms, "manage_users");
  const canDelete = canEdit;

  // Mirrors `roles` for save-time reads: a queued toggle must compose its payload from the
  // FRESHEST known role, not the one captured when the checkbox was clicked (the
  // step-codes/page.tsx `codesRef` precedent).
  const rolesRef = useRef<Role[]>([]);
  const latest = useLatest();
  // The rolesRef landing (the step-codes/page.tsx codesRefGate shape): the ref exists to hand a
  // QUEUED run the freshest server truth, not to gate what the user sees, so a superseded load
  // must still be allowed to land it — but landing on ARRIVAL order lets an older fetch resolving
  // after a newer one rewind the ref to a PRE-mutation permission set, and the next queued toggle
  // composes its ENTIRE array from the ref at run time, so it would persist the reverted set
  // server-side. The write is therefore applied-monotonic on the load ticket (makeMutationGate
  // semantics): an early finisher of a superseded load still lands, a straggler is dropped.
  const rolesRefGate = useMutationGate();
  // Answers whether this load was the current one and landed (the users page's shape): a handler
  // clears its message only after a refresh that landed (P6).
  const load = useCallback(async (): Promise<boolean> => {
    const ticket = latest.next();
    try {
      const data = await api<Role[]>("/api/admin/roles");
      if (rolesRefGate.accept(ticket)) rolesRef.current = data;
      if (!latest.isCurrent(ticket)) return false; // a slower, now-superseded load lost the state race
      setRoles(data);
      setSelected((cur) => (cur ? data.find((r) => r.id === cur.id) ?? null : null));
      return true;
    } catch (e) {
      // F7 (customers/page.tsx): a superseded load's rejection must not clobber current state.
      if (!latest.isCurrent(ticket)) return false;
      throw e;
    }
  }, [latest, rolesRefGate]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  // A row opens Area permissions, and opens it again after going back: each request takes a fresh
  // key, as the step codes' rows do.
  const [openTab, setOpenTab] = useState<{ id: string; key: string } | null>(null);
  const openRequests = useRef(0);
  function openPanel(id: string) {
    openRequests.current += 1;
    setOpenTab({ id, key: String(openRequests.current) });
  }
  function openRole(role: Role) {
    setSelected(role);
    openPanel("area-permissions");
  }
  const nameRef = useRef<HTMLInputElement>(null);
  function focusNewRole() {
    openPanel("new-role");
    focusWhenShown(() => nameRef.current);
  }

  async function create() {
    await createHold.run(async () => {
      try { await api("/api/admin/roles", { method: "POST", body: JSON.stringify({ name: newName }) }); }
      catch (e) { setAddMessage((e as Error).message); return; }
      setNewName(""); setAddMessage(null);
      // The refresh after the write: its failure is the page's line, and one that landed clears it.
      try { if (await load()) setError(null); } catch (e) { setError((e as Error).message); }
    });
  }

  // One at a time, composed inside the queued run (the surcharges/page.tsx saveQueue shape): each
  // PUT carries the role's ENTIRE permission array, so composing from click-time state let two
  // quick checks overlap — checking box A then box B before A's round trip landed made PUT#B
  // replace the array WITHOUT A, silently reverting the first grant server-side. The queued run
  // looks the role up from `rolesRef` at its OWN turn — after the previous save's load() has
  // landed the ref — so overlapping toggles accumulate instead of clobbering.
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  function toggle(roleId: string, permission: string): Promise<void> {
    const run = async () => {
      const role = rolesRef.current.find((r) => r.id === roleId);
      if (!role) return;
      const has = role.permissions.includes(permission);
      const next = has ? role.permissions.filter((p) => p !== permission) : [...role.permissions, permission];
      try {
        await api(`/api/admin/roles/${roleId}`, { method: "PUT", body: JSON.stringify({ permissions: next }) });
      } catch (e) {
        // The surcharges catch shape (§5.13: reload, then report): the reload also re-lands
        // rolesRef, so a PUT whose answer was lost after it committed cannot leave the next
        // queued toggle composing from a pre-PUT snapshot — the server-side revert this queue
        // exists to stop (Task 8 review, minor 1).
        await load().catch(() => {});
        setPermissionsMessage({ roleId, message: (e as Error).message });
        return;
      }
      setPermissionsMessage((current) => (current?.roleId === roleId ? null : current));
      // The refresh after the write: its failure is the page's line, and one that landed clears it.
      // It is awaited inside the queued run, so the next toggle composes from the ref it landed. A
      // refresh that fails is read once more before the queue moves on, as the catch above does:
      // otherwise the next toggle composes from the pre-PUT ref and undoes this one (Codex P1, #794).
      try { if (await load()) setError(null); }
      catch (e) { await load().catch(() => {}); setError((e as Error).message); }
    };
    saveQueue.current = saveQueue.current.then(run, run);
    return saveQueue.current;
  }

  async function remove(role: Role) {
    // null = cancelled. A blank answer holds the dialog open in the service's own sentence, so
    // nothing is sent (#636); the service still refuses a blank reason for any other caller.
    const reason = await askReason({ question: `Delete role "${role.name}"?`, verb: "deleting", blankRefusal: ROLE_DELETE_REASON_REQUIRED });
    if (reason === null) return;
    try {
      await api(`/api/admin/roles/${role.id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
    } catch (e) { setDeleteMessage({ roleId: role.id, message: (e as Error).message }); return; }
    setDeleteMessage((current) => (current?.roleId === role.id ? null : current));
    try { if (await load()) setError(null); } catch (e) { setError((e as Error).message); }
  }

  const removeGate = deleteRoleGate(canDelete, selected !== null);

  return (
    <div className="p-6">
      <PageHeader title="Roles" subtitle="Grant capabilities deliberately; keep special actions separate." actions={<>
        <button type="button" onClick={focusNewRole} disabled={canEdit.disabled} title={canEdit.title} className={BUTTON_PRIMARY}>
          Add role
        </button>
        <DangerButton disabled={removeGate.disabled} title={removeGate.title}
                      onClick={() => { if (selected) void remove(selected); }}>
          Delete unused role
        </DangerButton>
      </>} />
      {(error ?? permsError) && (
        <p className={`${NOTICE.refusal} mb-3`}>{error ?? permsError}</p>
      )}
      <PanelMessage message={selected && deleteMessage?.roleId === selected.id ? deleteMessage.message : null} />
      <RecordTabs label={ROLE_TAB_LABEL} tabs={roleTabs()} open={openTab} panels={{
        roles: (
          <>
            <div id="role-list" className={`${CARD_FLUSH} mb-3 overflow-x-auto`}>
              <table className="w-full text-sm">
                <thead><tr className="border-b text-left">
                  <th className={`${TABLE_HEAD} p-2`}>Role</th><th className={`${TABLE_HEAD} p-2`}>Users</th>
                </tr></thead>
                <tbody>
                  {roles.map((r) => (
                    /* The row's one control is the Role cell's button, stretched over the row by its
                       ::after (the step codes' table). */
                    <tr key={r.id} className={`relative border-t ${selected?.id === r.id ? "bg-link-50" : "hover:bg-surface-50"}`}>
                      <td className={TABLE_CELL}>
                        <button type="button" onClick={() => openRole(r)}
                                aria-current={selected?.id === r.id ? "true" : undefined}
                                className={`${LINK} cursor-pointer after:absolute after:inset-0`}>
                          {r.name}
                        </button>
                      </td>
                      <td className={TABLE_CELL}>{r.userCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div id="new-role" className={CARD}>
              <div className="flex max-w-md gap-2">
                <input ref={nameRef} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New role name"
                       disabled={canEdit.disabled} title={canEdit.title}
                       className={`${INPUT_COMPACT} w-full disabled:bg-surface-50`} />
                <button onClick={create} disabled={canEdit.disabled || creating} title={canEdit.title}
                        className={BUTTON_PRIMARY_COMPACT}>
                  Add
                </button>
              </div>
              <PanelMessage message={addMessage} />
            </div>
          </>
        ),
        area: (
          <div id="area-permissions" className={CARD}>
            {selected ? (
              <>
                <h2 className="mb-3 text-[17px] font-semibold text-ink-800">{selected.name} — permissions</h2>
                <PanelMessage message={permissionsMessage?.roleId === selected.id ? permissionsMessage.message : null} />
                <table className="w-full text-sm">
                  <thead><tr className="border-b">
                    <th className={`${TABLE_HEAD} p-2 text-left`}>Area</th>
                    {CRUD_ACTIONS.map((a) => <th key={a} className={`${TABLE_HEAD} p-2 capitalize`}>{a}</th>)}
                  </tr></thead>
                  <tbody>
                    {AREAS.map((area) => (
                      <tr key={area} className="border-t">
                        <td className={`${TABLE_CELL} capitalize`}>{area}</td>
                        {CRUD_ACTIONS.map((action) => {
                          const key = `${area}.${action}`;
                          return (
                            <td key={key} className={`${TABLE_CELL} text-center`}>
                              <input type="checkbox" checked={selected.permissions.includes(key)}
                                     aria-label={`${area} ${action}`}
                                     disabled={canEdit.disabled} title={canEdit.title}
                                     onChange={() => void toggle(selected.id, key)} />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <p className="text-sm text-ink-500">{NO_ROLE_SELECTED}</p>
            )}
          </div>
        ),
        special: (
          <div id="special-actions" className={CARD}>
            {selected ? (
              <>
                <h2 className="mb-3 text-[17px] font-semibold text-ink-800">{selected.name} — special actions</h2>
                <PanelMessage message={permissionsMessage?.roleId === selected.id ? permissionsMessage.message : null} />
                <table className="w-full max-w-xl text-sm">
                  <thead><tr className="border-b">
                    <th className={`${TABLE_HEAD} p-2 text-left`}>Action</th><th className={`${TABLE_HEAD} p-2`}>Granted</th>
                  </tr></thead>
                  <tbody>
                    {SPECIAL_ACTIONS.map((s) => {
                      const key = `action.${s}`;
                      return (
                        <tr key={key} className="border-t">
                          <td className={TABLE_CELL}>{specialActionName(s)}</td>
                          <td className={`${TABLE_CELL} text-center`}>
                            <input type="checkbox" checked={selected.permissions.includes(key)}
                                   aria-label={specialActionName(s)}
                                   disabled={canEdit.disabled} title={canEdit.title}
                                   onChange={() => void toggle(selected.id, key)} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </>
            ) : (
              <p className="text-sm text-ink-500">{NO_ROLE_SELECTED}</p>
            )}
          </div>
        ),
      }} />
    </div>
  );
}
