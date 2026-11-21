"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { applySignatureMutation } from "./signature-mutation";
import { adoptTitle } from "./title-cell";
import { api } from "@/lib/fetcher";
import { invalidateSetupBanner } from "@/components/SetupBanner";
import { usePermissions } from "@/lib/use-permissions";
import { gateDo, type Gate } from "@/lib/permission-ui";
import { useLatest } from "@/lib/use-latest";
import { UserSignatureControl } from "@/components/UserSignatureControl";
import { PageHeader } from "@/components/PageHeader";
import { PanelMessage } from "@/components/PanelMessage";
import { RecordTabs } from "@/components/RecordTabs";
import { SavedMark } from "@/components/SavedMark";
import { useSavedMarks, type SavedMarks } from "@/lib/use-saved-marks";
import { enterBox, focusRecord, leaveBox, noteFocus, type BoxCommit } from "@/lib/focus-record";
import { focusWhenShown } from "@/lib/focus-when-shown";
import { yesNo } from "@/lib/format";
import { askPassword } from "@/lib/modal";
import { BUTTON_NEUTRAL_COMPACT, BUTTON_PRIMARY, BUTTON_PRIMARY_COMPACT, CARD, CARD_FLUSH, INPUT_COMPACT, LABEL, LINK, NOTICE, TABLE_CELL, TABLE_HEAD } from "@/lib/ui-classes";
import { NO_USER_SELECTED, USER_TAB_LABEL, signatureText, userTabs } from "@/lib/user-tabs";
import { oneShotHold } from "@/lib/single-flight";

type Role = { id: string; name: string };
// Hand-maintained mirror of listUsers' return shape (src/server/users.ts) — a "use client" file
// must not import from src/server/** (the Shell.tsx precedent). `hasSignature` is a boolean, never
// the bytes: see that function's comment and #160.
type User = {
  id: string; username: string; displayName: string; title: string; roleId: string | null;
  roleName: string | null; active: boolean; hasSignature: boolean;
  // Epoch millis of the stored signature's last change (#171), or null. The preview URL cache-busts
  // on it, so another admin's clear-and-replace retries here by construction. Never the bytes (#160).
  signatureRev: number | null;
  overrides: { permission: string; mode: "GRANT" | "DENY" }[];
};

/** A blur-save text box of the user: the signature title (Phase 6 ruling 14: prints on the quote
 *  and cert signature blocks; blank prints nothing), and Display name (owner, 2026-11-02, #827). Local
 *  draft, PATCHed when the box is left or Enter is pressed (owner ruling R7), only when actually
 *  changed — the page's other controls PATCH per interaction, and a keystroke-level PATCH would mint
 *  an audit entry per character. The cell keeps its identity across reloads (keyed by the user
 *  alone), so an Enter's reload never takes the cursor out of the box: a reloaded value is adopted
 *  unless the box is being edited and holds text typed since its record (`adoptTitle`), which stays
 *  the box's own until it is left.
 *  `gate`: the page's `gateDo(perms, "manage_users")` (§5.16 — disabled with the reason, never
 *  hidden; the UserSignatureControl precedent). */
function TextCell({ user, field, label, gate, onSave, marks }: {
  user: User; field: "title" | "displayName"; label: string; gate: Gate;
  onSave: (value: string) => Promise<boolean>; marks: SavedMarks;
}) {
  const stored = user[field];
  const [draft, setDraft] = useState(stored);
  // The box's text at focus, and the text an accepted Enter sent (owner ruling R7: Enter commits
  // the box as leaving it does, the cursor kept in it), in src/lib/focus-record.ts.
  const focus = useRef(focusRecord());
  const box = useRef<HTMLInputElement>(null);
  // The box's text at focus is the value it last stored, not the text it shows: a refused save
  // leaves its text in the box with no reload, and leaving it or Enter must still send that text
  // once the save can land (Codex on #812). The newest landed save stands in for the user's value
  // until the list is read again.
  // Ordered by save attempt: an older save that finishes last (its reload was slower) must not
  // replace a newer landed value (Codex on #812).
  const landed = useRef<{ text: string; attempt: number } | null>(null);
  const attempts = useRef(0);
  function commit(value: string): ReturnType<BoxCommit> {
    const attempt = ++attempts.current;
    return onSave(value).then((ok) => {
      if (!ok) return false;
      if (!landed.current || landed.current.attempt <= attempt) landed.current = { text: value, attempt };
      return value;
    });
  }
  useEffect(() => {
    // The reloaded value is the stored one now; a save sent before this point that finishes later
    // is older than it.
    landed.current = { text: stored, attempt: attempts.current };
    const el = box.current;
    if (!el) return;
    const editing = el === document.activeElement;
    const recorded = Object.hasOwn(focus.current.at, field) ? focus.current.at[field] : null;
    const next = adoptTitle(el.value, stored, editing, recorded, Object.hasOwn(focus.current.held, field));
    // A value adopted under the cursor is the box's text at focus from now on, so leaving it sends
    // nothing.
    if (editing && next === stored) noteFocus(focus.current, field, stored);
    setDraft(next);
  }, [stored, field]);
  return (
    <>
      <input ref={box} value={draft} placeholder={field === "title" ? "— none —" : undefined}
             aria-label={`${label} for ${user.username}`}
             disabled={gate.disabled} title={gate.title}
             onFocus={() => noteFocus(focus.current, field, landed.current?.text ?? stored)}
             onChange={(e) => setDraft(e.target.value)}
             onBlur={(e) => leaveBox(focus.current, field, e.target.value, commit)}
             onKeyDown={(e) => enterBox(e, focus.current, field, e.currentTarget.value, commit)}
             className={`${INPUT_COMPACT} w-56`} />
      <SavedMark label={label} show={marks.shows(`${field}:${user.id}`, draft)} />
    </>
  );
}

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  // The page's line is the list read's (on mount, after each write, after a signature change). A
  // user's own write reports on the Selected user card, and Add user under its form (owner ruling
  // R1, P6 step 5d), through the shared PanelMessage: one user's message at a time, and a user's
  // success clears only its own.
  const [error, setError] = useState<string | null>(null);
  const [rowMessage, setRowMessage] = useState<{ userId: string; message: string } | null>(null);
  const savedMarks = useSavedMarks();
  const [addMessage, setAddMessage] = useState<string | null>(null);
  const [form, setForm] = useState({ username: "", displayName: "", password: "", roleId: "" });
  // #720: Create's hold, so a second click while the POST is out sends nothing (it would be
  // refused as a duplicate username after the first landed).
  const [creating, setCreating] = useState(false);
  const [createHold] = useState(() => oneShotHold(setCreating));
  const { permissions: perms, error: permsError } = usePermissions();
  // Every route this page calls — list/create (api/admin/users), per-user PUT, and every verb on
  // the signature route — requires this same special action, so ONE gate covers the whole page:
  // each row control and the Add form disable with the reason, never hide (§5.16; #100 item 4).
  const manageUsersGate = gateDo(perms, "manage_users");

  // Ticket-gated load (the surcharges/page.tsx load shape): patch()/create() refire this per row
  // interaction, so overlapping loads used to land in arrival order — a toggled checkbox visibly
  // reverted while the server held the new value. ONE ticket covers BOTH fetches (Promise.all),
  // so users and roles can never tear across two loads' snapshots either.
  const latest = useLatest();
  // Answers whether this load was the current one and landed: a superseded load returns false on
  // either path, so a handler clears its message only after a refresh that landed (P6; a
  // straggler's clear would hide a newer refresh's failure over a stale table).
  const load = useCallback(async (): Promise<boolean> => {
    const ticket = latest.next();
    try {
      const [u, r] = await Promise.all([
        api<User[]>("/api/admin/users"),
        api<Role[]>("/api/admin/roles"),
      ]);
      if (!latest.isCurrent(ticket)) return false; // a slower, now-superseded load lost the state race
      setUsers(u); setRoles(r);
      return true;
    } catch (e) {
      // F7 (customers/page.tsx): a superseded load's rejection must not surface an error over
      // state a newer load has already refreshed.
      if (!latest.isCurrent(ticket)) return false;
      throw e;
    }
  }, [latest]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  // A row opens Selected user, and opens it again after going back: each request takes a fresh key,
  // as the step codes' rows do.
  const [selected, setSelected] = useState<string | null>(null);
  const [openTab, setOpenTab] = useState<{ id: string; key: string } | null>(null);
  const openRequests = useRef(0);
  function openPanel(id: string) {
    openRequests.current += 1;
    setOpenTab({ id, key: String(openRequests.current) });
  }
  function openUser(id: string) {
    setSelected(id);
    openPanel("selected-user");
  }
  const usernameRef = useRef<HTMLInputElement>(null);
  function focusNewUser() {
    openPanel("new-user");
    focusWhenShown(() => usernameRef.current);
  }

  async function create() {
    await createHold.run(async () => {
      try {
        await api("/api/admin/users", {
          method: "POST",
          body: JSON.stringify({ ...form, roleId: form.roleId || undefined }),
        });
      } catch (e) { setAddMessage((e as Error).message); return; }
      setForm({ username: "", displayName: "", password: "", roleId: "" });
      setAddMessage(null);
      // The refresh after the write: its failure is the page's line, and one that landed clears it.
      try {
        if (await load()) setError(null);
      } catch (e) { setError((e as Error).message); }
    });
  }

  /** Answers whether the write landed; the text cells read it. `onRefusal` takes a refusal the
   *  page's slot would not show: Set password's, which stays in its dialog. */
  async function patch(id: string, body: object, opts?: { invalidatesSetup?: boolean; onRefusal?: (message: string) => void }): Promise<boolean> {
    try {
      await api(`/api/admin/users/${id}`, { method: "PUT", body: JSON.stringify(body) });
    } catch (e) {
      const message = (e as Error).message;
      if (opts?.onRefusal) opts.onRefusal(message);
      else setRowMessage({ userId: id, message });
      return false;
    }
    setRowMessage((current) => (current?.userId === id ? null : current));
    // #110: fired for the PASSWORD mutation only (`setPassword` below passes the flag) —
    // it is the one PATCH here that moves the banner's readiness signal (install-readiness.ts
    // argon2-verifies the admin row's password; title/role/active touch nothing it reads), and
    // invalidating on every title blur would spend a server-side argon2 verify per field edit
    // for nothing. Before load(), the #124/!131 ordering.
    if (opts?.invalidatesSetup) invalidateSetupBanner();
    // The refresh after the write: its failure is the page's line, and one that landed clears it.
    try {
      if (await load()) setError(null);
    } catch (e) { setError((e as Error).message); }
    return true;
  }

  /** Set password's dialog (owner, 2026-11-02, #827): it stays open on a refusal, in the server's
   *  sentence, and closes once the write lands. */
  function setPassword(user: User) {
    void askPassword({
      title: `Set password for ${user.username}`, label: "New password", confirm: "Set password",
      submit: async (password) => {
        let refusal: string | null = null;
        await patch(user.id, { password }, { invalidatesSetup: true, onRefusal: (message) => { refusal = message; } });
        return refusal;
      },
    });
  }

  const u = users.find((row) => row.id === selected) ?? null;

  return (
    <div className="p-6">
      <PageHeader title="Users" actions={
        <button type="button" onClick={focusNewUser} disabled={manageUsersGate.disabled} title={manageUsersGate.title}
                className={BUTTON_PRIMARY}>
          Add user
        </button>} />
      {(error ?? permsError) && (
        <p className={`${NOTICE.refusal} mb-3`}>{error ?? permsError}</p>
      )}
      <RecordTabs label={USER_TAB_LABEL} tabs={userTabs()} open={openTab} panels={{
        list: (
          <>
            <div id="user-list" className={`${CARD_FLUSH} mb-3 overflow-x-auto`}>
              <table className="w-full text-sm">
                <thead><tr className="border-b text-left">
                  <th className={`${TABLE_HEAD} p-2`}>Username</th><th className={`${TABLE_HEAD} p-2`}>Name</th>
                  <th className={`${TABLE_HEAD} p-2`}>Role</th><th className={`${TABLE_HEAD} p-2`}>Active</th>
                  <th className={`${TABLE_HEAD} p-2`}>Signature</th>
                </tr></thead>
                <tbody>
                  {users.map((row) => (
                    /* The row's one control is the Username cell's button, stretched over the row by
                       its ::after (the step codes' table). */
                    <tr key={row.id} className={`relative border-t ${selected === row.id ? "bg-link-50" : "hover:bg-surface-50"}`}>
                      <td className={TABLE_CELL}>
                        <button type="button" onClick={() => openUser(row.id)}
                                aria-current={selected === row.id ? "true" : undefined}
                                className={`${LINK} cursor-pointer after:absolute after:inset-0`}>
                          {row.username}
                        </button>
                      </td>
                      <td className={TABLE_CELL}>{row.displayName}</td>
                      <td className={TABLE_CELL}>{row.roleName ?? "—"}</td>
                      <td className={TABLE_CELL}>{yesNo(row.active)}</td>
                      <td className={TABLE_CELL}>{signatureText(row.hasSignature)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div id="new-user" className={`${CARD} mb-3`}>
              <h2 className="mb-2 font-medium">Add user</h2>
              <div className="flex flex-wrap items-end gap-2 text-sm">
                <input ref={usernameRef} placeholder="Username" value={form.username}
                       disabled={manageUsersGate.disabled} title={manageUsersGate.title}
                       onChange={(e) => setForm({ ...form, username: e.target.value })}
                       className={`${INPUT_COMPACT} disabled:cursor-not-allowed`} />
                <input placeholder="Display name" value={form.displayName}
                       disabled={manageUsersGate.disabled} title={manageUsersGate.title}
                       onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                       className={`${INPUT_COMPACT} disabled:cursor-not-allowed`} />
                <input placeholder="Password" type="password" value={form.password}
                       disabled={manageUsersGate.disabled} title={manageUsersGate.title}
                       onChange={(e) => setForm({ ...form, password: e.target.value })}
                       className={`${INPUT_COMPACT} disabled:cursor-not-allowed`} />
                <select value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })}
                        disabled={manageUsersGate.disabled} title={manageUsersGate.title}
                        className={`${INPUT_COMPACT} disabled:cursor-not-allowed`}>
                  <option value="">— no role —</option>
                  {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
                <button onClick={create} disabled={manageUsersGate.disabled || creating} title={manageUsersGate.title}
                        className={BUTTON_PRIMARY_COMPACT}>
                  Add
                </button>
              </div>
              <PanelMessage message={addMessage} />
            </div>
            {/* P3b (#239): the roadmap half of this sentence is gone. It promised a per-user override
                editor arriving in some future phase and named an API the reader cannot reach from
                here — which tells an administrator nothing about what THIS screen does while sending
                them looking for a control that does not exist. What remains is true on this page.
                The removed wording is deliberately not quoted here: tests/admin-screens.test.tsx
                refuses it by substring over this whole file (the board-search-scan precedent). */}
            <p className="text-xs text-ink-500">
              Users are never deleted — deactivate instead (audit history must keep resolving their names).
              This screen assigns each user a role; what a role may do is edited under Roles.
            </p>
          </>
        ),
        selected: (
          <div id="selected-user" className={CARD}>
            {u ? (
              <>
                <h2 className="mb-3 text-[17px] font-semibold text-ink-800">{u.username} — {u.displayName}</h2>
                <PanelMessage message={rowMessage?.userId === u.id ? rowMessage.message : null} />
                <div className="grid max-w-xl grid-cols-[10rem_1fr] items-center gap-x-4 gap-y-3 text-sm">
                  <span className={LABEL}>Display name</span>
                  <span className="flex items-center gap-1">
                    {/* key re-baselines the draft when another user is picked. */}
                    <TextCell key={u.id} user={u} field="displayName" label="Display name" gate={manageUsersGate} marks={savedMarks}
                              onSave={(displayName) => patch(u.id, { displayName }).then((ok) => {
                                if (ok) savedMarks.mark(`displayName:${u.id}`, displayName);
                                return ok;
                              })} />
                  </span>
                  <span className={LABEL}>Title</span>
                  <span className="flex items-center gap-1">
                    <TextCell key={u.id} user={u} field="title" label="Title" gate={manageUsersGate} marks={savedMarks}
                              onSave={(title) => patch(u.id, { title }).then((ok) => {
                                if (ok) savedMarks.mark(`title:${u.id}`, title);
                                return ok;
                              })} />
                  </span>
                  <span className={LABEL}>Role</span>
                  <select value={u.roleId ?? ""} onChange={(e) => patch(u.id, { roleId: e.target.value || null })}
                          aria-label={`Role for ${u.username}`}
                          disabled={manageUsersGate.disabled} title={manageUsersGate.title}
                          className={`${INPUT_COMPACT} w-56 disabled:cursor-not-allowed`}>
                    <option value="">— none —</option>
                    {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                  <span className={LABEL}>Active</span>
                  <input type="checkbox" checked={u.active} aria-label={`Active for ${u.username}`}
                         disabled={manageUsersGate.disabled} title={manageUsersGate.title}
                         className="justify-self-start disabled:cursor-not-allowed"
                         onChange={(e) => patch(u.id, { active: e.target.checked })} />
                  <span className={LABEL}>Signature</span>
                  {/* THIS PAGE owns the signature flag; the control keeps no copy of it and reports
                      every change back here (#160, three Codex rounds — its docblock carries why two
                      copies reconciled by a rule kept being wrong). Keyed by the user alone: a reload
                      must not remount it, which would throw away its error, busy and cache-bust state,
                      genuinely its own; but those belong to one user, not to the next one picked. */}
                  <UserSignatureControl key={u.id}
                    userId={u.id} hasSignature={u.hasSignature} signatureRev={u.signatureRev}
                    gate={manageUsersGate}
                    onSignatureChange={(next) => {
                      // Apply optimistically, then RELOAD — do not merely cancel (#3/#15 class,
                      // Codex rounds 3 and 4). The signature route has already committed, so this
                      // value is the server's; showing it at once is honest, not a guess.
                      //
                      // The reload is what makes it safe, and it does two jobs at once. `load()`
                      // takes its own `latest` ticket, so an OLDER in-flight load — one that read
                      // before this upload committed and would otherwise still count as current —
                      // is discarded rather than putting the row back to the pre-upload flag. And
                      // because it then re-reads, the OTHER half of that discarded load is not lost:
                      // `load()` fetches users AND roles together, so a concurrent title/role/active
                      // edit's refreshed data arrives here instead of being cancelled with it.
                      //
                      // An earlier fix called `latest.next()` alone. That closed the clobber and
                      // opened a quieter hole — the shared refresh was thrown away while only
                      // `hasSignature` was written, so a just-saved role could sit visibly stale.
                      //
                      // `applySignatureMutation` also advances `signatureRev` on an upload, so the
                      // preview URL cache-busts at once even if the reload below fails (#171 review).
                      setUsers((prev) => prev.map(
                        (row) => (row.id === u.id ? applySignatureMutation(row, next, Date.now()) : row),
                      ));
                      load().catch((e) => setError(e.message));
                    }} />
                  <span className={LABEL}>Password</span>
                  <button type="button" onClick={() => setPassword(u)} disabled={manageUsersGate.disabled} title={manageUsersGate.title}
                          className={`${BUTTON_NEUTRAL_COMPACT} justify-self-start`}>
                    Set password
                  </button>
                </div>
              </>
            ) : (
              <p className="text-sm text-ink-500">{NO_USER_SELECTED}</p>
            )}
          </div>
        ),
      }} />
    </div>
  );
}
