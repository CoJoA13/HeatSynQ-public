"use client";
import { BUTTON_PRIMARY_COMPACT, INPUT_COMPACT, LINK } from "@/lib/ui-classes";
import { inMenuOrder } from "@/lib/menu-order";

// Presentational only (#33's bounded slice): every piece of state and every handler stays in the
// board page (src/app/page.tsx) — this file receives values + callbacks as props and renders the
// views bar plus its save panel. Nothing here fetches, navigates, or owns a useState.

// Local mirror of src/server/saved-views.ts's SavedViewRow. `config` stays `unknown` — this file
// never trusts it directly, only through board-columns.ts's normalizers.
export type SavedViewRow = { id: string; name: string; config: unknown; isDefault: boolean; updatedAt: string };

type Props = {
  savedViews: SavedViewRow[];
  selectedViewId: string;
  saveOpen: boolean;
  saveName: string;
  saveDefault: boolean;
  /** True while a set-as-default PATCH is in flight — disables the checkbox so two clicks
   *  faster than the round trip cannot issue two unordered updates (#145). */
  settingDefault: boolean;
  /** R20 (#683): the live arrangement differs from the selected view's stored one, so the select
   *  names it "(changed)"; Update view writes the arrangement into it, one PATCH at a time, and
   *  its refusal shows here beside the control (ruling R1). The Default board takes no mark. */
  viewChanged: boolean;
  updatingView: boolean;
  viewError: string | null;
  onUpdateView: () => void;
  onApplyView: (id: string) => void;
  onSetSelectedDefault: (isDefault: boolean) => void;
  onOpenSave: () => void;
  onDeleteView: () => void;
  onSaveNameChange: (name: string) => void;
  onSaveDefaultChange: (isDefault: boolean) => void;
  onSaveView: () => void;
  /** True while Save view's POST is out (#720): its Save button is disabled, so a second click
   *  sends no second view of the same name. */
  savingView: boolean;
  onCancelSave: () => void;
};

export function SavedViewsBar({
  savedViews, selectedViewId, saveOpen, saveName, saveDefault, settingDefault,
  viewChanged, updatingView, viewError, onUpdateView,
  onApplyView, onSetSelectedDefault, onOpenSave, onDeleteView,
  onSaveNameChange, onSaveDefaultChange, onSaveView, savingView, onCancelSave,
}: Props) {
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded border bg-surface-0 p-2 text-sm">
        <label className="flex items-center gap-1">
          View:
          <select value={selectedViewId} onChange={(e) => onApplyView(e.target.value)}
                  className={INPUT_COMPACT}>
            <option value="">Default board</option>
            {/* By name, each digit run by value, so a view saved during the visit takes its place at
                once (#1056 rulings 3 and 4). */}
            {inMenuOrder(savedViews, (v) => v.name).map((v) => <option key={v.id} value={v.id}>{v.name}{v.id === selectedViewId && viewChanged ? " (changed)" : ""}</option>)}
          </select>
        </label>
        {selectedViewId && (
          <label className="flex items-center gap-1">
            <input type="checkbox"
                   checked={savedViews.find((v) => v.id === selectedViewId)?.isDefault ?? false}
                   disabled={settingDefault} title={settingDefault ? "Saving…" : undefined}
                   onChange={(e) => onSetSelectedDefault(e.target.checked)} />
            Set as default
          </label>
        )}
        {selectedViewId && (
          <button onClick={onUpdateView} disabled={updatingView} className={LINK}>
            {updatingView ? "Updating…" : "Update view"}
          </button>
        )}
        {viewError && <span role="alert" className="text-red-700">{viewError}</span>}
        <button onClick={onOpenSave} className={LINK}>Save view</button>
        <button onClick={onDeleteView} disabled={!selectedViewId}
                className="text-red-600">
          Delete view
        </button>
      </div>

      {saveOpen && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded border border-line bg-surface-50 p-3 text-sm">
          <input value={saveName} onChange={(e) => onSaveNameChange(e.target.value)}
                 placeholder="View name" className={INPUT_COMPACT} />
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={saveDefault} onChange={(e) => onSaveDefaultChange(e.target.checked)} />
            Set as default
          </label>
          <button onClick={onSaveView} disabled={savingView} className={BUTTON_PRIMARY_COMPACT}>Save</button>
          <button onClick={onCancelSave} className="text-ink-500">
            Cancel
          </button>
        </div>
      )}
    </>
  );
}
