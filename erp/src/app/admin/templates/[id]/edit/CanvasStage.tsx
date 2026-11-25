"use client";
// The Design tab's stage (PR C of #926, Task 4): page 1 of a canvas traveler, drawn at `scale` px
// per pt, every item at the box the leaf gives it (`stageBox`), the repeat band and the page-bottom
// band tinted, and the "(continued)" ghost where continuation pages print it. The geometry is the
// leaf's (`src/lib/canvas-designer.ts`, whose header states the drag contract); this component
// draws it and turns pointer and key events into ONE commit each:
// - a drag moves a local offset and, on pointer up, commits the leaf's `movedItem`: the box it
//   started at (`dragStart`: the stage box for an item that prints on page 1, its drawn box for one
//   that prints on another page, which the stage draws dashed at that box; rulings C8, C10, C13)
//   moved by the offset and dropped. A click that moves less than a grid step commits nothing, since
//   `dropBox` would re-infer the item's anchor, and neither does a move that leaves the item's box,
//   anchor and repeat as they were (ruling C33: an arrow against a margin); the drag is drawn at
//   `moveBox` clamped by `moveClampHeight` (the stored height for an item, the stage height for a
//   table), as `movedItem` clamps it (Ruling 8);
// - a handle's drag is drawn at the leaf's `resizedBox` and, on pointer up, commits its
//   `resizedItem` (Ruling 9): the item as `resizeStart` gives it (its stored box, at the height the
//   stage draws for a handle that moves a top or bottom edge) resized by the handle; a resize that
//   leaves that box as it was commits nothing;
// - an arrow key nudges through the drag's pipeline by `NUDGE_FINE` (with Shift, `NUDGE_COARSE`);
//   Delete and Backspace hand the item to `onRemove`, where the panel refuses the two required ones.
// Nothing here applies a change itself: every edit goes through `onCommit` or `onRemove`.
//
// The shipping ticket (ticket canvas PR 2b) adds three shapes: a field the profile boxes
// (`drawsBorder`, the Sold To and Ship To boxes) is drawn in a frame, as the paper prints it; a
// text block is drawn as its wording (`textBlocks`, the config's Wording texts), wrapped in its
// box, and its title muted while the wording is empty; a rows block (`tableSpec(...).rows`, the
// Totals) is drawn as its visible rows' labels with no column-header strip, above the hatch. A
// measured item is drawn at its measured height where that is taller than its box (`stageBox`), and
// a top or bottom handle's resize starts from that drawn height (`resizeStart`), so it commits the
// height it was seen at, while a side handle's keeps the stored height; a move keeps the stored size
// (`dropBox`).
//
// The bill of lading (BOL canvas PR 2) adds three more, each read from the profile through the leaf,
// never from a document type or a field key: a field the profile draws on a rule (`ruleOf`,
// `ruledFields`) is drawn as the form prints it, its label beside a rule under the rest of the box
// ("beside", the label cut where the box is narrow and the rule kept at least a grid step; the
// carrier's too since owner ruling R1 of 2026-11-24 retired the "under" drawing), or its label beside two rules
// its `column` long ("lines", the caption not drawn); a list block (`isListBlock`: the Consignee's
// ref/PO and TRV lists, and the shipping ticket's serial list, owner ruling (b) of 2026-11-10) as its
// heading and one line over the hatch, with no column-header strip; and a column table that keeps
// points beside its columns (`besideOf`, the freight block's sidebar) as its header strip in the
// drawn width less those points, beside a plain outline of them at its right edge, the hatch under
// the strip only. No table's strip draws a toggle (`tableSpec(...).toggles`, the Collect checkbox)
// as a column: the inspector gives it Show and Label and no width.
//
// The certification (cert canvas PR 2) adds two name fallbacks, read through the leaf as the rest
// are: a rows block's row whose label resolves to "" (`column.label ?? field.defaultLabel`: the
// requirements' and the signature's data-bound rows) draws the row's contract name muted, as a
// label-free field's name draws; and a list block with no heading (`tableHeadingKey` answers none:
// the statement and the freeform text) draws its block name (`itemTitle`) muted where the heading
// row would be, over its one line and the hatch. A typed label or heading draws as before. The live
// page draws the rest.
//
// #958 (owner ruling 2026-11-12, option 1): a table the picked record leaves empty (`printsNothing`,
// the leaf's: the measure holds it at 0 pt) is drawn at its drawn box (`stageBox`), its content
// replaced by one marking: a muted border hatched over the whole box with no fill, holding the words
// "Prints nothing for this record" (`DESIGNER_WORDS.printsNothing`), which also join its hover title
// after the refusal and the warnings. No heading, strip or rows: the paper prints none. Unselected,
// it is raised above every unselected item (`z-5`; the selected item keeps `z-10`), so a table that
// grew over its stored box, and the items the paper pulls up into it, show through the hatch and the
// block stays grabbable; the list's order is unchanged. Its list item carries `data-empty="true"`.
// That unselected item also multiplies (`mix-blend-multiply`, beside its `z-5`: the item is its own
// stacking context, so a blend on the marking would have nothing beneath it to multiply against), so
// the hatch's stripes darken nothing dark and no longer cut the borders and rules of the items
// beneath into dashes, the stage's later-page cue; on white the stripes still show. The app is
// light-only (#212, globals.css). A selected empty block (`z-10`) takes no blend, so its handles'
// white fill stays opaque; while one is selected the lines beneath its hatch read broken again.
import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import {
  DESIGNER_WORDS, NUDGE_COARSE, NUDGE_FINE, dragStart, drawsBorder, isRequired, itemTitle, moveBox, moveClampHeight, movedItem,
  printsNothing, resizedBox, resizedItem, ruleOf, stageBox, type Handle,
} from "@/lib/canvas-designer";
import {
  bandHeight, bandTop, besideOf, continuedBox, isListBlock, tableHeadingKey, tableSpec, topMargin, type CanvasMeasure,
  type CanvasWarning,
} from "@/lib/template-canvas";
import { CANVAS_GRID, CANVAS_PAGE, CONTINUED_FONT_SIZE, type CanvasBox, type CanvasPage, type CanvasItem, type CanvasLayout } from "@/lib/template-contracts/canvas";
import type { FontFamily, FontsConfig, TemplateConfig, TemplateContract } from "@/lib/template-contracts";

type Drag = { id: string; pointerId: number; startX: number; startY: number; dx: number; dy: number; handle: Handle | null };

const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
/** Where each handle sits on its item's box, as fractions of the width and height. */
const HANDLE_AT: Record<Handle, { x: number; y: number; cursor: string }> = {
  nw: { x: 0, y: 0, cursor: "nwse-resize" }, n: { x: 0.5, y: 0, cursor: "ns-resize" },
  ne: { x: 1, y: 0, cursor: "nesw-resize" }, e: { x: 1, y: 0.5, cursor: "ew-resize" },
  se: { x: 1, y: 1, cursor: "nwse-resize" }, s: { x: 0.5, y: 1, cursor: "ns-resize" },
  sw: { x: 0, y: 1, cursor: "nesw-resize" }, w: { x: 0, y: 0.5, cursor: "ew-resize" },
};
const HANDLE_PX = 8;
/** A rule the paper prints: a ruled field's line, a list block's line. */
const RULE_LINE = "border-b border-ink-900";
/** The hatch the stage draws where a table's rows grow, and over a table that prints nothing (#958). */
const HATCH = "repeating-linear-gradient(45deg, var(--color-line) 0 1px, transparent 1px 6px)";
/** The grid the stage shows: a dot every quarter inch (the drag snaps to 1/16 in, too dense to draw). */
const DOT_PT = 18;

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

const at = (box: CanvasBox, scale: number): CSSProperties => ({
  left: box.x * scale, top: box.y * scale, width: box.w * scale, height: box.h * scale,
});

export function CanvasStage({
  layout, contract, scale, measure, selectedId, onSelect, onCommit, onRemove, refusal, warnings, fontCss, family, logoSrc,
  pageFooter, disabled, textBlocks, page = CANVAS_PAGE, fonts = contract.fonts,
}: {
  layout: CanvasLayout;
  contract: TemplateContract;
  /** Px per pt (`fitScale`). */
  scale: number;
  measure: CanvasMeasure | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** The whole changed item, once per drag, resize or nudge. */
  onCommit: (item: CanvasItem) => void;
  onRemove: (item: CanvasItem) => void;
  refusal: CanvasWarning | null;
  warnings: CanvasWarning[];
  /** The template family's `@font-face` rules (`fontFaceCss`). */
  fontCss: string;
  family: FontFamily;
  /** The draft's logo (`GET /api/templates/<id>/logo?v=…`), null when it has none. */
  logoSrc: string | null;
  pageFooter: boolean;
  /** Closed for editing: an item can still be selected, nothing commits. */
  disabled: boolean;
  /** The config's Wording texts, by text block key: a text block item draws its own. */
  textBlocks: TemplateConfig["textBlocks"];
  /** The template's page (`canvasPageFor`); Letter when the caller passes none. */
  page?: CanvasPage;
  /** The template's fonts (R12's line height reads them); the contract's when the caller passes none. */
  fonts?: FontsConfig;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  // The drag as the last event left it: a pointer up can land before the render its last move
  // asked for, so the commit reads this, never the render's copy.
  const dragRef = useRef<Drag | null>(null);
  // The page itself (`tabIndex={-1}`): a Delete moves focus here before the focused item goes, so
  // focus never falls back to the document.
  const list = useRef<HTMLDivElement>(null);
  const setLive = (next: Drag | null) => { dragRef.current = next; setDrag(next); };

  const fields = contract.sections.flatMap((section) => section.fields);
  const fieldOf = (key: string) => fields.find((f) => f.key === key);
  const options = { pageFooter, measure, page };
  const text = (style: { size: number; bold: boolean; align: "left" | "center" | "right" }): CSSProperties => ({
    fontFamily: `"${family}"`, fontSize: style.size * scale, fontWeight: style.bold ? 700 : 400, textAlign: style.align,
    lineHeight: 1.15, whiteSpace: "pre",
  });
  /** The contract's small size: a table's heading, strip and rows, an empty table's words. */
  const small = { fontFamily: `"${family}"`, fontSize: contract.fonts.smallSize * scale, lineHeight: 1.2 };

  function commitMove(item: CanvasItem, dx: number, dy: number) {
    const next = movedItem(layout, item, dx, dy, options);
    if (next !== null) onCommit(next);
  }

  function begin(e: PointerEvent<HTMLElement>, item: CanvasItem, handle: Handle | null) {
    if (e.button !== 0) return;
    onSelect(item.id);
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setLive({ id: item.id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, dx: 0, dy: 0, handle });
  }
  function move(e: PointerEvent<HTMLElement>, item: CanvasItem) {
    const live = dragRef.current;
    if (live === null || live.id !== item.id || live.pointerId !== e.pointerId) return;
    setLive({ ...live, dx: (e.clientX - live.startX) / scale, dy: (e.clientY - live.startY) / scale });
  }
  function end(e: PointerEvent<HTMLElement>, item: CanvasItem) {
    const live = dragRef.current;
    if (live === null || live.id !== item.id || live.pointerId !== e.pointerId) return;
    setLive(null);
    if (live.handle === null) {
      commitMove(item, live.dx, live.dy);
      return;
    }
    // The leaf's one commit (`resizedItem`); a handle clicked without a move commits nothing.
    const next = resizedItem(item, layout, measure, live.handle, live.dx, live.dy, contract, page, fonts);
    if (next !== null) onCommit(next);
  }
  function key(e: KeyboardEvent<HTMLElement>, item: CanvasItem) {
    if (e.target !== e.currentTarget) return;
    const arrow = ARROWS[e.key];
    if (arrow !== undefined) {
      e.preventDefault();
      if (disabled) return;
      const step = e.shiftKey ? NUDGE_COARSE : NUDGE_FINE;
      commitMove(item, arrow[0] * step, arrow[1] * step);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      if (disabled) return;
      if (!isRequired(item, contract)) list.current?.focus();
      onRemove(item);
    }
  }

  /** The box the item is drawn at now: where it rests, or where the drag in hand would leave it. */
  function shownBox(item: CanvasItem): CanvasBox {
    const start = dragStart(item, layout, measure, page);
    if (drag === null || drag.id !== item.id) return start;
    if (drag.handle === null) return moveBox(start, drag.dx, drag.dy, moveClampHeight(item, start), page);
    return resizedBox(item, layout, measure, drag.handle, drag.dx, drag.dy, contract, page, fonts);
  }

  /** `box` is the box the item is drawn at now (`shownBox`): a block's strip follows a resize. */
  function content(item: CanvasItem, box: CanvasBox): ReactNode {
    switch (item.kind) {
      case "field": {
        const field = fieldOf(item.key);
        const label = item.label ?? field?.defaultLabel ?? "";
        const ruled = ruleOf(item, contract);
        if (ruled !== null) {
          // A field the form prints on a rule. Its label (or its muted name) is cut where the box is
          // narrow; a rule beside it keeps at least a grid step, so it is always drawn.
          const words = label === "" ? (field?.name ?? item.key) : label;
          const tone = label === "" ? "text-ink-500 italic" : "text-ink-900";
          const line = item.style.size * 1.15 * scale;
          const shownLabel = <div className={`min-w-0 truncate ${tone}`} style={text(item.style)}>{words}</div>;
          if (ruled.draw === "lines") {
            const width = (ruled.column ?? 0) * scale;
            return (
              <div className="flex">
                {shownLabel}
                <div className="flex flex-none flex-col">
                  <span className={`block flex-none ${RULE_LINE}`} style={{ width, height: line }} />
                  <span className={`block flex-none ${RULE_LINE}`} style={{ width, height: line }} />
                </div>
              </div>
            );
          }
          return (
            <div className="flex">
              {shownLabel}
              <span className={`flex-1 ${RULE_LINE}`} style={{ minWidth: CANVAS_GRID * scale }} />
            </div>
          );
        }
        const shown = label === ""
          ? <div className="text-ink-500 italic" style={text(item.style)}>{field?.name ?? item.key}</div>
          : <div className="text-ink-900" style={text(item.style)}>{label}</div>;
        // A party box: the paper prints the field in a border.
        return drawsBorder(item, contract) ? <div className="h-full border border-ink-900">{shown}</div> : shown;
      }
      case "text":
        return <div className="text-ink-900" style={text(item.style)}>{item.text}</div>;
      case "textBlock": {
        // The wording, wrapped in the box as the paper wraps it; its title muted while it is empty.
        const wording = textBlocks[item.key] ?? "";
        return wording === ""
          ? <div className="text-ink-500 italic" style={{ ...text(item.style), whiteSpace: "pre-wrap" }}>{itemTitle(item, contract)}</div>
          : <div className="text-ink-900" style={{ ...text(item.style), whiteSpace: "pre-wrap" }}>{wording}</div>;
      }
      case "table": {
        const headingKey = tableHeadingKey(contract, item.key);
        const heading = headingKey === null ? null : item.heading ?? fieldOf(headingKey)?.defaultLabel ?? null;
        const spec = tableSpec(contract, item.key);
        const toggles = new Set(spec?.toggles ?? []);
        const visible = item.columns.filter((column) => column.visible);
        const labelOf = (column: (typeof visible)[number]) => column.label ?? fieldOf(column.key)?.defaultLabel ?? "";
        const headingRow = heading !== null && <div className="font-bold text-ink-900" style={small}>{heading}</div>;
        const hatch = (
          <div className="flex flex-1 items-center justify-center text-ink-500 italic"
               style={{ ...small, backgroundImage: HATCH }}>
            {DESIGNER_WORDS.rowsGrow}
          </div>
        );
        if (isListBlock(contract, item.key)) {
          // A list block: its heading and one line, as the paper prints the label and its list. One
          // with no heading (the certification's statement and freeform text) draws its block name
          // muted in the heading's place, so two such blocks never draw as the same wordless box.
          return (
            <div className="flex h-full flex-col border border-ink-500 bg-surface-0">
              {heading === null
                ? <div className="truncate text-ink-500 italic" style={small}>{itemTitle(item, contract)}</div>
                : headingRow}
              <div className={`flex-none ${RULE_LINE}`} style={{ height: small.fontSize * small.lineHeight }} />
              {hatch}
            </div>
          );
        }
        // A column table's header strip: its visible columns, never a toggle (which prints no column).
        const strip = (
          <div className="flex border-b border-ink-500 bg-surface-50 text-ink-800" style={small}>
            {visible.filter((column) => !toggles.has(column.key)).map((column) => {
              const width = column.width ?? fieldOf(column.key)?.column?.defaultWidth ?? "*";
              return (
                <div key={column.key} className="truncate border-r border-line px-0.5"
                     style={width === "*" ? { flex: 1 } : { width: width * scale, flex: "none" }}>
                  {labelOf(column)}
                </div>
              );
            })}
          </div>
        );
        const beside = besideOf(contract, item.key);
        if (beside > 0) {
          // The strip in the drawn width less what the block keeps beside it, the hatch under it, and
          // a plain outline of the sidebar at the right edge (the live page prints its wording). A box
          // narrower than the sidebar, which the rules refuse, draws the strip 0 wide.
          return (
            <div className="flex h-full">
              <div className="flex h-full flex-none flex-col overflow-hidden border border-ink-500 bg-surface-0"
                   style={{ width: Math.max(box.w - beside, 0) * scale }}>
                {headingRow}
                {strip}
                {hatch}
              </div>
              <div aria-hidden data-sidebar="true" className="h-full flex-none border border-l-0 border-ink-500 bg-surface-0" style={{ width: beside * scale }} />
            </div>
          );
        }
        return (
          <div className="flex h-full flex-col border border-ink-500 bg-surface-0">
            {headingRow}
            {spec?.rows === true
              // A rows block: its rows' labels one under another, with no column-header strip; a row
              // whose label is empty (the certification's data-bound rows) draws its name muted, as a
              // label-free field's name draws.
              ? visible.map((column) => {
                const label = labelOf(column);
                return label === ""
                  ? <div key={column.key} className="truncate px-0.5 text-ink-500 italic" style={small}>{fieldOf(column.key)?.name ?? column.key}</div>
                  : <div key={column.key} className="truncate px-0.5 text-ink-800" style={small}>{label}</div>;
              })
              : strip}
            {hatch}
          </div>
        );
      }
      case "logo":
        return logoSrc === null
          ? <div className="flex h-full items-center justify-center border border-dashed border-ink-300 text-xs text-ink-500">{itemTitle(item, contract)}</div>
          // A draft's own bytes behind the session (`GET /api/templates/<id>/logo`), drawn into a box
          // the user sizes: nothing for `next/image` to optimise (the `UserSignatureControl` precedent).
          // eslint-disable-next-line @next/next/no-img-element
          : <img src={logoSrc} alt={itemTitle(item, contract)} draggable={false} className="h-full w-full object-contain" />;
      case "barcode":
        return (
          <div className="flex h-full items-center justify-center border border-ink-500"
               style={{ backgroundImage: "repeating-linear-gradient(90deg, var(--color-ink-700) 0 2px, transparent 2px 5px)" }}>
            <span className="bg-surface-0 px-1 text-xs text-ink-800">{itemTitle(item, contract)}</span>
          </div>
        );
      case "box":
        return <div className="h-full w-full border-solid border-ink-900" style={{ borderWidth: item.weight * scale }} />;
      default: {
        // A line: a stroke along its one drawn axis, centred on it, and a wider band to grab.
        const stroke = Math.max(item.weight * scale, 1);
        const horizontal = item.box.h === 0;
        return (
          <>
            <span aria-hidden className="absolute"
                  style={horizontal ? { left: 0, right: 0, top: -4, height: 8 } : { top: 0, bottom: 0, left: -4, width: 8 }} />
            <span aria-hidden className="absolute bg-ink-900"
                  style={horizontal ? { left: 0, right: 0, top: -stroke / 2, height: stroke } : { top: 0, bottom: 0, left: -stroke / 2, width: stroke }} />
          </>
        );
      }
    }
  }

  /** A table the picked record leaves empty (#958): hatched over its whole box with no fill, muted,
   *  the words at its top-left (cut where a row floor leaves no room; the title carries them too). */
  function emptyMarking(): ReactNode {
    return (
      <div className="flex h-full items-start border border-ink-300 px-0.5 text-ink-500 italic"
           style={{ ...small, backgroundImage: HATCH }}>{DESIGNER_WORDS.printsNothing}</div>
    );
  }

  const refused = new Set(refusal?.itemIds ?? []);
  const continued = continuedBox(layout, page);
  const top = bandTop(layout, pageFooter, page);
  return (
    <>
      <style>{fontCss}</style>
      <div ref={list} role="list" aria-label={DESIGNER_WORDS.canvasItems} tabIndex={-1}
           className="relative shrink-0 touch-none select-none bg-surface-0 shadow-sm ring-1 ring-line"
           style={{
             width: page.width * scale, height: page.height * scale,
             backgroundImage: "radial-gradient(circle, var(--color-ink-200) 1px, transparent 1.5px)",
             backgroundSize: `${DOT_PT * scale}px ${DOT_PT * scale}px`,
           }}
           onPointerDown={(e) => { if (e.target === e.currentTarget) onSelect(null); }}>
        <div aria-hidden data-band="repeat" className="pointer-events-none absolute inset-x-0 bg-link-50 opacity-70"
             style={{ top: 0, height: topMargin(layout, page) * scale }} />
        <div aria-hidden data-band="bottom" className="pointer-events-none absolute inset-x-0 bg-accent-25"
             style={{ top: top * scale, height: bandHeight(layout, pageFooter, page) * scale }} />
        <div aria-hidden className="pointer-events-none absolute border border-dashed border-ink-200"
             style={at({ x: page.margin, y: page.margin, w: page.width - 2 * page.margin, h: page.height - 2 * page.margin }, scale)} />
        {continued !== null && (
          <div aria-hidden data-ghost="continued" className="pointer-events-none absolute text-ink-300"
               style={{ ...at(continued, scale), fontStyle: "italic", fontFamily: `"${family}"`, fontSize: CONTINUED_FONT_SIZE * scale, lineHeight: 1.25 }}>
            {DESIGNER_WORDS.continued}
          </div>
        )}
        {layout.items.map((item) => {
          const onPage = stageBox(item, layout, measure, page).page;
          // The leaf decides "empty"; such a table answers page 1 (`stageBox`), so it is never dashed.
          const empty = printsNothing(item, measure);
          const warned = warnings.filter((w) => w.itemIds.includes(item.id));
          const titles = [
            ...(refused.has(item.id) ? [refusal!.sentence] : []),
            ...warned.map((w) => w.sentence),
            ...(empty ? [DESIGNER_WORDS.printsNothing] : []),
            ...(onPage !== 1 ? [DESIGNER_WORDS.printsOnPage(onPage, contract.docType)] : []),
            ...(isRequired(item, contract) ? [DESIGNER_WORDS.required] : []),
          ];
          const outline = refused.has(item.id) ? " outline-2 outline-red-700" : warned.length > 0 ? " outline-2 outline-accent-600" : "";
          const selected = item.id === selectedId;
          const box = shownBox(item);
          return (
            <div key={item.id} role="listitem" aria-label={itemTitle(item, contract)} tabIndex={0}
                 aria-current={selected ? "true" : undefined} data-empty={empty ? "true" : undefined}
                 title={titles.length > 0 ? titles.join("\n") : undefined}
                 className={`absolute cursor-move${outline}${selected ? " z-10 ring-2 ring-link-700" : empty ? " z-5 mix-blend-multiply" : ""}${onPage !== 1 ? " opacity-60" : ""}`}
                 style={at(box, scale)}
                 onFocus={() => onSelect(item.id)}
                 onPointerDown={(e) => begin(e, item, null)}
                 onPointerMove={(e) => move(e, item)}
                 onPointerUp={(e) => end(e, item)}
                 onPointerCancel={(e) => end(e, item)}
                 onKeyDown={(e) => key(e, item)}>
              {item.kind === "line"
                ? content(item, box)
                : <div className="pointer-events-none absolute inset-0 overflow-hidden">{empty ? emptyMarking() : content(item, box)}</div>}
              {onPage !== 1 && <span aria-hidden className="pointer-events-none absolute inset-0 border border-dashed border-ink-500" />}
              {selected && !disabled && HANDLES.map((handle) => (
                <span key={handle} aria-hidden data-handle={handle}
                      className="absolute border border-link-700 bg-surface-0"
                      style={{
                        width: HANDLE_PX, height: HANDLE_PX, cursor: HANDLE_AT[handle].cursor,
                        left: `calc(${HANDLE_AT[handle].x * 100}% - ${HANDLE_PX / 2}px)`,
                        top: `calc(${HANDLE_AT[handle].y * 100}% - ${HANDLE_PX / 2}px)`,
                      }}
                      onPointerDown={(e) => { e.stopPropagation(); begin(e, item, handle); }} />
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}
