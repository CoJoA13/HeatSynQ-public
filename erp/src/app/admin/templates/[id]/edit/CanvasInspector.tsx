"use client";
// The Design tab's inspector (PR C of #926, Task 4): the selected item's anchor, repeat flag, box
// in inches and the knobs its kind has. Every change hands the whole changed item to `onChange`
// (the panel applies it through `replaceItem`), and an anchor change goes to `onAnchor` (the panel
// applies `setAnchor`, which keeps the item where it is drawn).
//
// The boxes save as they are typed (`onChange` alone, no blur-save: nothing here is sent anywhere;
// the template's Save draft sends the config). The inch boxes snap what is typed, so once one is
// left it drops its typed text and shows the stored, snapped figure (ruling C15): that onBlur is
// display only. A figure box keeps its own text while it is being
// typed and shows the item's figure again once the item changes under it (a drag, a nudge): its
// text is shown only while the item still holds the figure that text was read as. A text that is
// no figure (or a figure outside the schema's bounds) stays in its box, commits nothing and shows the
// panel's sentence (`onMessage`). The inch boxes read through the leaf's `readSize`, which also
// refuses a width or a height under one grid step with its own sentence, on every open side
// (ruling C31); a line's undrawn side (`zeroSide`) is a closed box titled `DESIGNER_WORDS.lineOneAxis`,
// since the schema refuses a line with both sides drawn.
//
// X and Y are the item's MODEL box, as the layout stores it: a NON-table item anchored below a
// table stores its Y as the offset from that table's bottom (`drawnBox` adds the bottom back), so
// its Y here is that offset, and a hint under the box says so (ruling C14). Typed inches are snapped whole to the grid (`snap(fromInches(text))`).
//
// A table lists its columns, each with a Show box, a Label box and a Width box; a rows block's rows
// and a toggle (`tableSpec(...).toggles`, the bill of lading's Collect checkbox) take Show and Label
// and no Width, and a block with no columns (a list block: the bill of lading's TRV and PO lists, the
// tickets' serials list) shows no Columns label at all.
import { useState } from "react";
import { DESIGNER_WORDS, isRequired, itemTitle, readSize, toInches, zeroSide } from "@/lib/canvas-designer";
import { spelledDecimal } from "@/lib/decimal-entry";
import { canvasProfile, drawnBox, tableHeadingKey, tableSpec, tablesByY } from "@/lib/template-canvas";
import type { TemplateContract } from "@/lib/template-contracts";
import type { CanvasAnchor, CanvasBox, CanvasItem, CanvasLayout, CanvasTextStyle } from "@/lib/template-contracts/canvas";
import { BUTTON_NEUTRAL_COMPACT, INPUT_COMPACT, LABEL, TEXT_MUTED } from "@/lib/ui-classes";

/** A text style's size and a stroke's weight, as the schema bounds them (`canvas.ts`). */
const SIZE = { min: 4, max: 72 };
const WEIGHT = { min: 0.25, max: 4 };

/** A box whose text is read as a figure (`read`): null when the text is no figure (the box shows
 *  `refusal`), or the sentence a figure it refuses is answered with. */
function FigureBox<V extends number | null>({
  label, value, read, show, onCommit, onMessage, refusal, disabled, title, placeholder, storedOnLeave = false,
}: {
  label: string;
  value: V;
  read: (text: string) => { value: V } | { refusal: string } | null;
  show: (value: V) => string;
  onCommit: (value: V) => void;
  onMessage: (message: string | null) => void;
  refusal: string;
  disabled: boolean;
  title: string | undefined;
  placeholder?: string;
  /** Drop the typed text when the box is left, so it shows the stored figure (ruling C15): a box
   *  whose figure is snapped shows what the item holds once the typing is done. */
  storedOnLeave?: boolean;
}) {
  // The typed text and the figure it was read as; null when the box holds none (shows `show(value)`).
  const [draft, setDraft] = useState<{ text: string; value: V } | null>(null);
  const text = draft !== null && draft.value === value ? draft.text : show(value);
  return (
    <input type="text" inputMode="decimal" aria-label={label} value={text} disabled={disabled} title={title}
           placeholder={placeholder} className={`${INPUT_COMPACT} w-full`}
           // Display only (ruling C15; listed in tests/enter-commit-census.test.ts): it drops the
           // typed text and sends nothing; the commit is onChange's.
           onBlur={() => { if (storedOnLeave) setDraft(null); }}
           onChange={(e) => {
             const typed = e.target.value;
             const figure = read(typed);
             if (figure === null || "refusal" in figure) {
               setDraft({ text: typed, value });
               onMessage(figure === null ? refusal : figure.refusal);
               return;
             }
             setDraft({ text: typed, value: figure.value });
             onMessage(null);
             if (figure.value !== value) onCommit(figure.value);
           }} />
  );
}

/** A figure inside the schema's bounds; one outside them is refused as a non-figure is (its text
 *  kept, the bounds' sentence shown), never clamped, so the box never shows a figure the item does
 *  not hold. */
const readBounded = ({ min, max }: { min: number; max: number }) => (text: string) => {
  const read = spelledDecimal(text);
  return read === null || read.value < min || read.value > max ? null : { value: read.value };
};
const readColumnWidth = (text: string): { value: number | null } | null => {
  if (text.trim() === "") return { value: null };
  const read = spelledDecimal(text);
  return read === null || !(read.value > 0) ? null : { value: read.value };
};

function anchorValue(anchor: CanvasAnchor): string {
  return anchor.kind === "below-table" ? `below:${anchor.table}` : anchor.kind;
}

export function CanvasInspector({ item, layout, contract, onChange, onAnchor, onRemove, onMessage, disabled, editTitle }: {
  item: CanvasItem;
  layout: CanvasLayout;
  contract: TemplateContract;
  onChange: (next: CanvasItem) => void;
  onAnchor: (anchor: CanvasAnchor) => void;
  onRemove: (item: CanvasItem) => void;
  onMessage: (message: string | null) => void;
  disabled: boolean;
  editTitle: string | undefined;
}) {
  // One label (a container tag): page top only, nothing repeats.
  const oneLabel = canvasProfile(contract).oneLabel !== undefined;
  const fields = contract.sections.flatMap((section) => section.fields);
  const gate = { disabled, title: editTitle };
  const figure = { onMessage, ...gate };
  const setBox = (patch: Partial<CanvasBox>) => onChange({ ...item, box: { ...item.box, ...patch } });
  const closedSide = zeroSide(item);

  // The tables an item can hang below: each whose drawn bottom is at or above the item's drawn top
  // (a table under it would store a negative offset), and the one it hangs below now.
  const top = drawnBox(item, layout).y;
  const belowTable = item.kind !== "table" && item.anchor.kind === "below-table";
  const below = tablesByY(layout).filter((table) =>
    table.box.y + table.box.h <= top || (item.anchor.kind === "below-table" && item.anchor.table === table.key));

  const style = (s: CanvasTextStyle, set: (next: CanvasTextStyle) => void) => (
    <>
      <label className="block">
        <span className={LABEL}>{DESIGNER_WORDS.size}</span>
        <FigureBox label={DESIGNER_WORDS.size} value={s.size} read={readBounded(SIZE)} show={String}
                   onCommit={(size) => set({ ...s, size })} refusal={DESIGNER_WORDS.notASize} {...figure} />
      </label>
      <label className="flex items-center gap-2 text-sm text-ink-800">
        <input type="checkbox" aria-label={DESIGNER_WORDS.bold} checked={s.bold} {...gate}
               onChange={(e) => set({ ...s, bold: e.target.checked })} />
        {DESIGNER_WORDS.bold}
      </label>
      <label className="block">
        <span className={LABEL}>{DESIGNER_WORDS.align}</span>
        <select aria-label={DESIGNER_WORDS.align} value={s.align} className={`${INPUT_COMPACT} w-full`} {...gate}
                onChange={(e) => set({ ...s, align: e.target.value as CanvasTextStyle["align"] })}>
          <option value="left">{DESIGNER_WORDS.alignLeft}</option>
          <option value="center">{DESIGNER_WORDS.alignCenter}</option>
          <option value="right">{DESIGNER_WORDS.alignRight}</option>
        </select>
      </label>
    </>
  );

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-ink-900">{itemTitle(item, contract)}</h3>

      {item.kind === "table" ? (
        <p className={TEXT_MUTED}>{DESIGNER_WORDS.stacksWithTables}</p>
      ) : (
        <>
          <label className="block">
            <span className={LABEL}>{DESIGNER_WORDS.anchor}</span>
            <select aria-label={DESIGNER_WORDS.anchor} value={anchorValue(item.anchor)} className={`${INPUT_COMPACT} w-full`} {...gate}
                    onChange={(e) => {
                      const value = e.target.value;
                      const table = below.find((t) => value === `below:${t.key}`);
                      onAnchor(table !== undefined ? { kind: "below-table", table: table.key }
                        : value === "page-bottom" ? { kind: "page-bottom" } : { kind: "page-top" });
                    }}>
              <option value="page-top">{DESIGNER_WORDS.anchorPageTop}</option>
              {!oneLabel && below.map((table) => (
                <option key={table.key} value={`below:${table.key}`}>{DESIGNER_WORDS.anchorBelow(itemTitle(table, contract))}</option>
              ))}
              {!oneLabel && <option value="page-bottom">{DESIGNER_WORDS.anchorPageBottom}</option>}
            </select>
          </label>
          {!oneLabel && <label className="flex items-center gap-2 text-sm text-ink-800">
            {/* Closed below a table, never hidden (ruling C14): the validator refuses a repeating
                below-table item, and the title says why. */}
            <input type="checkbox" aria-label={DESIGNER_WORDS.repeat} checked={item.repeat && !belowTable}
                   disabled={disabled || belowTable} title={belowTable ? DESIGNER_WORDS.repeatBelowTable : editTitle}
                   onChange={(e) => onChange({ ...item, repeat: e.target.checked })} />
            {DESIGNER_WORDS.repeat}
          </label>}
        </>
      )}

      <div className="grid grid-cols-2 gap-2">
        {(["x", "y", "w", "h"] as const).map((side) => {
          const label = { x: DESIGNER_WORDS.x, y: DESIGNER_WORDS.y, w: DESIGNER_WORDS.width, h: DESIGNER_WORDS.height }[side];
          const closed = side === closedSide;
          return (
            <label key={side} className="block">
              <span className={LABEL}>{label}</span>
              <FigureBox label={label} value={item.box[side]} read={readSize(side)} show={toInches} storedOnLeave
                         onCommit={(pt) => setBox({ [side]: pt })} refusal={DESIGNER_WORDS.notAFigure} onMessage={onMessage}
                         disabled={disabled || closed} title={closed ? DESIGNER_WORDS.lineOneAxis : editTitle} />
              {side === "y" && belowTable && <span className="mt-0.5 block text-xs text-ink-500">{DESIGNER_WORDS.yBelowTable}</span>}
            </label>
          );
        })}
      </div>

      {item.kind === "field" && (() => {
        const field = fields.find((f) => f.key === item.key);
        return (
          <>
            <label className="block">
              <span className={LABEL}>{DESIGNER_WORDS.label}</span>
              <input type="text" aria-label={DESIGNER_WORDS.label} value={item.label ?? ""} placeholder={field?.defaultLabel}
                     className={`${INPUT_COMPACT} w-full`} {...gate}
                     onChange={(e) => onChange({ ...item, label: e.target.value === "" ? null : e.target.value })} />
            </label>
            {style(item.style, (next) => onChange({ ...item, style: next }))}
          </>
        );
      })()}

      {item.kind === "text" && (
        <>
          <label className="block">
            <span className={LABEL}>{DESIGNER_WORDS.text}</span>
            <textarea aria-label={DESIGNER_WORDS.text} value={item.text} rows={3} className={`${INPUT_COMPACT} w-full`} {...gate}
                      onChange={(e) => onChange({ ...item, text: e.target.value })} />
          </label>
          {style(item.style, (next) => onChange({ ...item, style: next }))}
        </>
      )}

      {(item.kind === "line" || item.kind === "box") && (
        <label className="block">
          <span className={LABEL}>{DESIGNER_WORDS.weight}</span>
          <FigureBox label={DESIGNER_WORDS.weight} value={item.weight} read={readBounded(WEIGHT)} show={String}
                     onCommit={(weight) => onChange({ ...item, weight })} refusal={DESIGNER_WORDS.notAWeight} {...figure} />
        </label>
      )}

      {item.kind === "table" && (() => {
        const headingKey = tableHeadingKey(contract, item.key);
        const headingField = headingKey === null ? undefined : fields.find((f) => f.key === headingKey);
        // A rows block's rows take no width: each prints across the block; nor does a toggle the
        // block's profile entry names (the bill of lading's Collect checkbox), which is no column and
        // prints inside the block (`CanvasTableSpec.toggles`; the validator refuses a toggle's width).
        const spec = tableSpec(contract, item.key);
        const rows = spec?.rows === true;
        const toggles = new Set(spec?.toggles ?? []);
        return (
          <>
            {headingField !== undefined && (
              <label className="block">
                <span className={LABEL}>{DESIGNER_WORDS.heading}</span>
                <input type="text" aria-label={DESIGNER_WORDS.heading} value={item.heading ?? ""} placeholder={headingField.defaultLabel}
                       className={`${INPUT_COMPACT} w-full`} {...gate}
                       onChange={(e) => onChange({ ...item, heading: e.target.value === "" ? null : e.target.value })} />
              </label>
            )}
            {/* A block with no columns (a list block: the bill of lading's TRV and PO lists, the tickets'
                serials list) shows no Columns label: an empty list under a heading reads as a missing control. */}
            {item.columns.length > 0 && (
              <div>
                <span className={LABEL}>{DESIGNER_WORDS.columns}</span>
                <ul className="mt-1 space-y-2">
                  {item.columns.map((column, i) => {
                    const field = fields.find((f) => f.key === column.key);
                    const name = field?.name ?? column.key;
                    const width = field?.column?.defaultWidth;
                    const set = (patch: Partial<typeof column>) =>
                      onChange({ ...item, columns: item.columns.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
                    const locked = field !== undefined && !field.removable;
                    const labelBox = (
                      <input type="text" aria-label={DESIGNER_WORDS.columnLabel(name)} value={column.label ?? ""}
                             placeholder={field?.defaultLabel} className={`${INPUT_COMPACT} w-full`} {...gate}
                             onChange={(e) => set({ label: e.target.value === "" ? null : e.target.value })} />
                    );
                    return (
                      <li key={column.key} className={`space-y-1 text-sm ${column.visible ? "text-ink-800" : "text-ink-500"}`}>
                        <label className="flex items-center gap-2">
                          <input type="checkbox" aria-label={DESIGNER_WORDS.columnShown(name)} checked={column.visible}
                                 disabled={disabled || locked} title={locked ? field?.lockReason : editTitle}
                                 onChange={(e) => set({ visible: e.target.checked })} />
                          <span className="truncate">{name}</span>
                        </label>
                        {rows || toggles.has(column.key) ? labelBox : (
                          <div className="grid grid-cols-2 gap-2">
                            {labelBox}
                            <FigureBox<number | null> label={DESIGNER_WORDS.columnWidth(name)} value={column.width}
                                       read={readColumnWidth} show={(w) => (w === null ? "" : String(w))}
                                       placeholder={width === undefined || width === "*" ? undefined : String(width)}
                                       onCommit={(w) => set({ width: w })} refusal={DESIGNER_WORDS.notPoints} {...figure} />
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </>
        );
      })()}

      {/* Closed with its reason on the items the profile requires (the traveler's two, §5.16); the stage's Delete
          key answers the same sentence through the panel's message. */}
      <button type="button" onClick={() => onRemove(item)} disabled={disabled || isRequired(item, contract)}
              title={disabled ? editTitle : isRequired(item, contract) ? DESIGNER_WORDS.cannotRemove(contract) ?? undefined : undefined}
              className={BUTTON_NEUTRAL_COMPACT}>
        {DESIGNER_WORDS.remove}
      </button>
    </div>
  );
}
