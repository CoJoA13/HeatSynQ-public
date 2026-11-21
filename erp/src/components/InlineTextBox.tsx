"use client";
import type { InlineSave } from "@/lib/reference-inline-edit";
import { INPUT_COMPACT } from "@/lib/ui-classes";
import { useInlineBox } from "@/lib/use-inline-box";
import { SavedMark } from "@/components/SavedMark";

/**
 * A name, a text column or a whole number of an existing pick-list row, edited in place (owner
 * ruling R18, #680), on InlineDecimalBox's shape: `decide` says what leaving it sends, and
 * `src/lib/use-inline-box.ts` holds its rules. With `multiline` it is a textarea, which saves when
 * it is left and takes Enter as a new line.
 */
export function InlineTextBox(props: {
  label: string;
  stored: unknown;
  disabled: boolean;
  title?: string;
  decide: (stored: unknown, typed: string) => InlineSave<string | null>;
  onSave: (value: string | null) => Promise<boolean>;
  multiline?: boolean;
  numeric?: boolean;
}) {
  const { label, stored, disabled, title, decide, onSave, multiline = false, numeric = false } = props;
  const box = useInlineBox({ stored, decide, onSave });
  const shared = {
    "aria-label": label, value: box.shown, disabled, title,
    className: `${INPUT_COMPACT} w-full disabled:bg-surface-50`,
  };

  return (
    <div className="flex items-center">
      {multiline ? (
        <textarea {...shared} rows={2} onFocus={box.onFocus}
                  onChange={(e) => box.onType(e.target.value)}
                  onBlur={(e) => box.onLeave(e.target.value)} />
      ) : (
        <input {...shared} inputMode={numeric ? "numeric" : undefined} onFocus={box.onFocus}
               onChange={(e) => box.onType(e.target.value)}
               onBlur={(e) => box.onLeave(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter") box.onEnter(e.currentTarget.value); }} />
      )}
      <SavedMark label={label} show={box.saved} />
    </div>
  );
}
