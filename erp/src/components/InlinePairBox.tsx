"use client";
import { INPUT_COMPACT } from "@/lib/ui-classes";
import { SavedMark } from "@/components/SavedMark";

/**
 * One of Terms' two discount boxes on an existing row (owner ruling 2026-11-02, #680). The table
 * owns its text, because the two save together: `onCommit` runs when the box is left and when Enter
 * is pressed, and src/lib/terms-discount-pair.ts says what follows. `hint` is the Add row's own, shown
 * while this box waits for the other.
 */
export function InlinePairBox(props: {
  label: string;
  text: string;
  disabled: boolean;
  title?: string;
  numeric: boolean;
  hint?: string;
  saved: boolean;
  onType: (value: string) => void;
  onCommit: (value: string) => void;
}) {
  const { label, text, disabled, title, numeric, hint, saved, onType, onCommit } = props;
  return (
    <>
      <div className="flex items-center">
        <input aria-label={label} inputMode={numeric ? "numeric" : "decimal"} value={text}
               disabled={disabled} title={title}
               onChange={(e) => onType(e.target.value)}
               onBlur={(e) => onCommit(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter") onCommit(e.currentTarget.value); }}
               className={`${INPUT_COMPACT} w-full disabled:bg-surface-50`} />
        <SavedMark label={label} show={saved} />
      </div>
      {hint && <span className="mt-0.5 block text-xs text-ink-500">{hint}</span>}
    </>
  );
}
