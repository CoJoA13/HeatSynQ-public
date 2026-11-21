"use client";
import { inlineDecimalSave } from "@/lib/reference-inline-edit";
import { INPUT_COMPACT } from "@/lib/ui-classes";
import { useInlineBox } from "@/lib/use-inline-box";
import { SavedMark } from "@/components/SavedMark";

/**
 * One decimal figure of an existing pick-list row, edited in place (the weights design §9.4,
 * "Pick lists", and §9.9 point 17). It saves when it is left and when Enter is pressed. It has no
 * button and no unsaved state to register: `src/lib/reference-inline-edit.ts` says what leaving it
 * sends, a box nobody changed sends nothing, and `src/lib/use-inline-box.ts` holds its rules.
 */
export function InlineDecimalBox(props: {
  label: string;
  stored: unknown;
  disabled: boolean;
  title?: string;
  onSave: (value: string | null) => Promise<boolean>;
}) {
  const { label, stored, disabled, title, onSave } = props;
  const box = useInlineBox({ stored, decide: inlineDecimalSave, onSave, decimal: true });

  return (
    <div className="flex items-center">
      <input aria-label={label} inputMode="decimal" value={box.shown}
             disabled={disabled} title={title}
             onFocus={box.onFocus}
             onChange={(e) => box.onType(e.target.value)}
             onBlur={(e) => box.onLeave(e.target.value)}
             onKeyDown={(e) => { if (e.key === "Enter") box.onEnter(e.currentTarget.value); }}
             className={`${INPUT_COMPACT} w-full disabled:bg-surface-50`} />
      <SavedMark label={label} show={box.saved} />
    </div>
  );
}
