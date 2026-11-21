"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/fetcher";
import { invalidateSetupBanner } from "@/components/SetupBanner";
import { usePermissions } from "@/lib/use-permissions";
import { useLatest } from "@/lib/use-latest";
import { gate } from "@/lib/permission-ui";
import { PageHeader } from "@/components/PageHeader";
import { RecordTabs } from "@/components/RecordTabs";
import { SavedMark } from "@/components/SavedMark";
import { HIDDEN_SETTING_KEYS, SETTINGS_TAB_LABEL, settingsTabs } from "@/lib/admin-tabs";
import { useSavedMarks } from "@/lib/use-saved-marks";
import { enterBox, focusRecord, leaveBox, noteFocus, type BoxCommit } from "@/lib/focus-record";
import { caughtUp } from "@/lib/settings-landed";
import { widgetKindFor, selectOptionsFor, selectLabelsFor, coerceForSubmit } from "@/lib/settings-ui";
import { CARD_FLUSH, INPUT_COMPACT, NOTICE } from "@/lib/ui-classes";

type Row = { key: string; label: string; group: string; value: unknown };

export default function SettingsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  // The one Saved mark (R7): a control reads Saved while it shows the value its newest landed save
  // carried (src/lib/saved-mark.ts), where a 1.5-second flash used to show. The text boxes are
  // uncontrolled, so what each shows is kept as it is typed.
  const savedMarks = useSavedMarks();
  const [typed, setTyped] = useState<Record<string, string>>({});
  const { permissions: perms, error: permsError } = usePermissions();
  // Every write here hits PUT /api/admin/settings, which requires admin.edit
  // (src/app/api/admin/settings/route.ts) — disabled with a tooltip, never hidden (§5.16).
  const canEdit = gate(perms, "admin.edit");

  // §5.13 stale-gate, both paths (F7) — #223 item 1: `save()` refires this per row interaction,
  // so overlapping loads used to land by ARRIVAL and could repaint a committed toggle with its
  // pre-save value (the step-codes/page.tsx saveQueue race, one screen over).
  const latest = useLatest();
  // Each box's newest landed write, ordered by save attempt per box (Codex on #812): `newest` is the
  // newest attempt of the box that has landed, never cleared, so an older write answering last
  // stands in for nothing; and an entry goes once the rows read hold its text, so a read that does
  // not reflect it (an older one, or one another box's save asked for) leaves it standing.
  const landed = useRef<Record<string, { text: string; attempt: number }>>({});
  const newest = useRef<Record<string, number>>({});
  const attempts = useRef(0);
  const load = useCallback(async () => {
    const t = latest.next();
    try {
      const r = await api<Row[]>("/api/admin/settings");
      if (latest.isCurrent(t)) { landed.current = caughtUp(landed.current, r); setRows(r); }
    } catch (e) {
      if (latest.isCurrent(t)) setError((e as Error).message);
    }
  }, [latest]);
  useEffect(() => { void load(); }, [load]);

  /** Answers whether the write landed; a blank number is refused before any request. */
  async function save(row: Row, raw: string | boolean): Promise<boolean> {
    const kind = widgetKindFor(row.key, row.value);
    if (kind === "number" && typeof raw === "string" && raw.trim() === "") {
      setError("Enter a value");
      void load();
      return false;
    }
    const value = coerceForSubmit(kind, raw);
    try {
      await api("/api/admin/settings", { method: "PUT", body: JSON.stringify({ key: row.key, value }) });
      // #110: a company name/address/phone save can complete the banner's `company` readiness
      // step — fired the instant the PUT resolves, before the reload (the #124/!131 ordering).
      // Unconditional across keys: settings edits are rare admin actions, and the banner's own
      // renders-nothing guard bounds the cost once setup is behind it.
      invalidateSetupBanner();
      savedMarks.mark(row.key, String(raw)); setError(null); void load();
      return true;
    } catch (e) { setError((e as Error).message); return false; }
  }

  // A text box's text at focus, and the text an accepted Enter sent (owner ruling R7: Enter commits
  // a single-line box as leaving it does, the cursor kept in it), in src/lib/focus-record.ts. The
  // boxes are uncontrolled, so the row's value lags what they show until `load` lands.
  const focus = useRef(focusRecord());
  // A box's text at focus is the value it last stored, not the text it shows: the boxes are
  // uncontrolled, so a write that failed leaves its text in the box, and leaving or Enter must still
  // send it once the write can land (Codex on #812). The newest landed write of a box stands in for
  // its row's value until `load` brings that value.
  const storedText = (row: Row) => (Object.hasOwn(landed.current, row.key) ? landed.current[row.key].text : String(row.value));
  function commitSetting(row: Row): BoxCommit {
    return (value) => {
      const attempt = ++attempts.current;
      return save(row, value).then((ok) => {
        if (!ok) return false;
        // An older write answering last stands in for nothing: a newer one of the box landed.
        if (!Object.hasOwn(newest.current, row.key) || newest.current[row.key] <= attempt) {
          newest.current[row.key] = attempt;
          landed.current[row.key] = { text: value, attempt };
        }
        return value;
      });
    };
  }
  function leaveSave(key: string, value: string, commit: BoxCommit) {
    leaveBox(focus.current, key, value, commit);
  }
  function enterSave(e: React.KeyboardEvent<HTMLInputElement>, key: string, commit: BoxCommit) {
    enterBox(e, focus.current, key, e.currentTarget.value, commit);
  }

  // The form's rows: two number settings issue no numbers, and leave the form (not the registry).
  const shown = rows.filter((r) => !HIDDEN_SETTING_KEYS.has(r.key));
  const groups = [...new Set(shown.map((r) => r.group))];
  const panels: Record<string, ReactNode> = {};
  for (const g of groups) {
    panels[g.toLowerCase()] = (
        <section key={g} className="mb-6 max-w-2xl">
          <h2 className="mb-2 font-medium">{g}</h2>
          <div className={CARD_FLUSH}>
                {shown.filter((r) => r.group === g).map((r) => {
                  const kind = widgetKindFor(r.key, r.value);
                  const shown = kind === "checkbox" ? String(Boolean(r.value))
                    : kind === "select" ? String(r.value)
                    : (Object.hasOwn(typed, r.key) ? typed[r.key] : String(r.value));
                  const labelText = (
                    <span>{r.label}<SavedMark label={r.label} show={savedMarks.shows(r.key, shown)} /></span>
                  );
                  const noteTyped = (e: React.FormEvent<HTMLInputElement | HTMLTextAreaElement>) => {
                    const text = e.currentTarget.value;
                    setTyped((t) => ({ ...t, [r.key]: text }));
                  };

                  // Multi-line text — stacked layout, full-width textarea. A single-line input
                  // swallows the line breaks AND writes the mangled value back on blur-save (#213).
                  // Serves company_address (printed as the multi-line letterhead) since 2026-08-25;
                  // the long standing-text settings it was built for retired into template text
                  // blocks in Phase 7 Task 14 (see settings-ui.ts).
                  if (kind === "textarea") {
                    return (
                      <div key={r.key} className="border-b p-2 text-sm last:border-0">
                        <label className="mb-1 block">{labelText}</label>
                        <textarea
                          defaultValue={String(r.value)}
                          rows={6}
                          onInput={noteTyped}
                          disabled={canEdit.disabled}
                          title={canEdit.title}
                          onFocus={() => noteFocus(focus.current, r.key, storedText(r))}
                          onBlur={(e) => leaveSave(r.key, e.target.value, commitSetting(r))}
                          className={`${INPUT_COMPACT} w-full disabled:cursor-not-allowed disabled:bg-surface-50`}
                        />
                      </div>
                    );
                  }

                  if (kind === "checkbox") {
                    return (
                      <label key={r.key} className="flex items-center justify-between border-b p-2 text-sm last:border-0">
                        {labelText}
                        <input
                          type="checkbox"
                          checked={Boolean(r.value)}
                          disabled={canEdit.disabled}
                          title={canEdit.title}
                          onChange={(e) => void save(r, e.target.checked)}
                        />
                      </label>
                    );
                  }

                  if (kind === "select") {
                    const options = selectOptionsFor(r.key) ?? [];
                    const labels = selectLabelsFor(r.key);
                    return (
                      <label key={r.key} className="flex items-center justify-between border-b p-2 text-sm last:border-0">
                        {labelText}
                        <select
                          value={String(r.value)}
                          disabled={canEdit.disabled}
                          title={canEdit.title}
                          onChange={(e) => void save(r, e.target.value)}
                          className={`${INPUT_COMPACT} w-56 disabled:cursor-not-allowed disabled:bg-surface-50`}
                        >
                          {options.map((o) => <option key={o} value={o}>{labels?.[o] ?? o}</option>)}
                        </select>
                      </label>
                    );
                  }

                  return (
                    <label key={r.key} className="flex items-center justify-between border-b p-2 text-sm last:border-0">
                      {labelText}
                      <input
                        type={kind === "number" ? "number" : "text"}
                        defaultValue={String(r.value)}
                        onInput={noteTyped}
                        disabled={canEdit.disabled}
                        title={canEdit.title}
                        aria-label={r.label}
                        onFocus={() => noteFocus(focus.current, r.key, storedText(r))}
                        onBlur={(e) => leaveSave(r.key, e.target.value, commitSetting(r))}
                        onKeyDown={(e) => enterSave(e, r.key, commitSetting(r))}
                        className={`${INPUT_COMPACT} w-56 disabled:cursor-not-allowed disabled:bg-surface-50`}
                      />
                    </label>
                  );
                })}
          </div>
        </section>
    );
  }
  return (
    <div className="min-w-0 p-3 sm:p-6">
      <PageHeader title="Settings" />
      {(error ?? permsError) && (
        <p className={`${NOTICE.refusal} mb-3`}>{error ?? permsError}</p>
      )}
      {/* The tabs read the first tab at mount, so they wait for the groups (src/lib/admin-tabs.ts).
          Every box stays mounted, with its blur-save and Saved mark. */}
      {groups.length > 0 && (
        <RecordTabs label={SETTINGS_TAB_LABEL} tabs={settingsTabs(groups)} panels={panels} />
      )}
      <p className="text-xs text-ink-500">Values save when changed. Invalid values are rejected with a message and nothing is stored.</p>
    </div>
  );
}
