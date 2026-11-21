"use client";
import { BOARD_COLUMNS, type ColumnKey, type ColumnState } from "@/lib/board-columns";
import { moveGate } from "@/lib/reorder";

// Presentational only (#33's bounded slice): the column arrangement lives in the board page's
// state (src/app/page.tsx) — this file renders the show/reorder panel and reports clicks up.

type Props = {
  columns: ColumnState[];
  onToggleVisible: (key: ColumnKey) => void;
  onMove: (index: number, direction: -1 | 1) => void;
};

export function ColumnPicker({ columns, onToggleVisible, onMove }: Props) {
  return (
    <div className="mb-3 max-w-sm rounded border border-line bg-surface-50 p-3 text-sm">
      <div className="mb-2 font-medium">Show / reorder columns</div>
      {columns.map((c, i) => {
        const def = BOARD_COLUMNS.find((d) => d.key === c.key);
        if (!def) return null;
        return (
          <div key={c.key} className="flex items-center gap-2 border-b py-1 last:border-b-0">
            <label className="flex flex-1 items-center gap-2">
              <input type="checkbox" checked={c.visible} onChange={() => onToggleVisible(c.key)} />
              <span>{def.label}</span>
            </label>
            <button type="button" aria-label={`Move ${def.label} up`}
                    {...moveGate(null, i, columns.length, -1)} onClick={() => onMove(i, -1)}
                    className="text-sm text-ink-500 hover:text-ink-800">
              ↑
            </button>
            <button type="button" aria-label={`Move ${def.label} down`}
                    {...moveGate(null, i, columns.length, 1)} onClick={() => onMove(i, 1)}
                    className="text-sm text-ink-500 hover:text-ink-800">
              ↓
            </button>
          </div>
        );
      })}
    </div>
  );
}
