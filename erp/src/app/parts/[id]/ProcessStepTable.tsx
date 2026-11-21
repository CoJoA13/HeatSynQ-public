"use client";
import { useEffect, useId, useRef, useState } from "react";
import { moveProcessStep, type ProcessDraftStep, type ProcessParameterInput } from "@/lib/process-document";
import type { ProcessEditorCode } from "@/lib/process-editor-catalog";
import { addParameter, emptyParameters, removeParameter, replaceStepAt, updateParameter } from "@/lib/process-table";
import { newId } from "@/lib/client-id";
import { INPUT_COMPACT } from "@/lib/ui-classes";

/** Where the section wants focus after a change it made: a row by client id, and a control in it. */
export type StepFocus = Readonly<{
  clientId: string;
  target: { kind: "instruction" } | { kind: "parameter"; index: number } | { kind: "parameter-name"; index: number } | { kind: "handle" };
}>;

function focusKey(focus: StepFocus): string {
  const t = focus.target;
  return `${focus.clientId}:${t.kind}${t.kind === "parameter" || t.kind === "parameter-name" ? `:${t.index}` : ""}`;
}

export type StepAction = "insert-above" | "insert-below" | "move-up" | "move-down" | "add-parameter" | "remove";

/** The private drag type a handle files `<table token> <row client id>` under (#366). A row knows a
 *  handle drag from the drag itself: `types` is readable while the drag is over a row, `getData`
 *  only at the drop. A ref set at dragstart went stale when the handle unmounted mid-drag (a save
 *  settling, a re-read), since React then delivers it no dragend, and the next native drop onto a
 *  row moved a step. That ref was per table, and the token keeps its scope: a saved step's client id
 *  is its step id, so the same part open in another window names rows here. Lower-case, as the
 *  browser files every format. It is the only format a handle files (#397): an editable field takes
 *  a dropped `text/plain` with no handler of its own, so a copy of the id under that type was typed
 *  into whichever field outside the table the handle was released over. Firefox did that. Chromium
 *  did not, only because its text drop is a copy and the handle allows `move` alone. */
export const STEP_DRAG_TYPE = "application/x-heatsynq-step";

/** The edge chips are inert and invisible until their row is hovered or the chip itself is focused,
 *  so they cost a keyboard user nothing and a mouse user no space (spec 2026-09-26 §4). A DISABLED
 *  chip must hide the same way, then show greyed with its reason (owner ruling 2026-09-27). The
 *  global `button:disabled` rule in globals.css is unlayered and sets `opacity: 1`, which beats
 *  every layered utility, so only the three opacity classes carry Tailwind's important modifier
 *  (`!`): the chip's visibility wins, and everything else the global rule mutes (colour, border,
 *  background, cursor) still applies. Excluding the chips from that rule would have taken the
 *  muting away from them too; this touches no other button. */
const CHIP = "opacity-0! pointer-events-none group-hover:opacity-100! group-hover:pointer-events-auto focus:opacity-100! focus:pointer-events-auto";
const CHIP_STYLE = `absolute z-10 rounded-full border border-line bg-surface-0 px-2 text-xs leading-5 text-ink-500 shadow-sm hover:bg-surface-50 ${CHIP}`;

/**
 * The row's ⋮ menu: every chip and handle action again, so a keyboard user reaches all of them
 * without hovering. Controlled by the table, which keeps one menu open at a time. Esc closes it
 * and returns focus to its button; ↑/↓ move between the items; an action closes the menu, restores
 * focus to the button and then runs, so `document.activeElement` names the opener when the
 * section reads it (the search cancel returns focus there).
 */
export function StepActionsMenu({ n, count, open, disabled, title, onOpen, onClose, onAction }: {
  n: number; count: number; open: boolean; disabled: boolean; title?: string;
  onOpen: () => void; onClose: () => void; onAction: (action: StepAction) => void;
}) {
  const menuId = useId();
  const button = useRef<HTMLButtonElement | null>(null); const menu = useRef<HTMLDivElement | null>(null);
  const items: { action: StepAction; label: string; blocked?: boolean; reason?: string }[] = [
    { action: "insert-above", label: "Insert step above" },
    { action: "insert-below", label: "Insert step below" },
    { action: "move-up", label: "Move up", blocked: n === 1, reason: `Step ${n} is already first` },
    { action: "move-down", label: "Move down", blocked: n === count, reason: `Step ${n} is already last` },
    { action: "add-parameter", label: "Add parameter" },
    { action: "remove", label: "Remove step" },
  ];
  const enabledItems = () => Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
  useEffect(() => { if (open) enabledItems()[0]?.focus(); }, [open]);
  function close() { onClose(); button.current?.focus(); }
  function act(action: StepAction) { close(); onAction(action); }
  return <div className="relative inline-block" onBlur={e => { if (open && !e.currentTarget.contains(e.relatedTarget as Node | null)) onClose(); }}>
    <button ref={button} type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} aria-label={`Step ${n} actions`}
      disabled={disabled} title={title} onClick={() => (open ? onClose() : onOpen())}
      onKeyDown={e => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); onOpen(); } }}
      className="rounded px-2 py-0.5 text-lg leading-none text-ink-500 hover:bg-surface-50 hover:text-ink-800">⋮</button>
    {open && <div ref={menu} id={menuId} role="menu" aria-label={`Step ${n} actions`}
      onKeyDown={e => {
        const list = enabledItems(); const at = list.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === "ArrowDown") { e.preventDefault(); list[(at + 1) % list.length]?.focus(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus(); }
        else if (e.key === "Home") { e.preventDefault(); list[0]?.focus(); }
        else if (e.key === "End") { e.preventDefault(); list[list.length - 1]?.focus(); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
        else if (e.key === "Tab") onClose();
      }}
      className="absolute right-0 z-20 mt-1 w-44 rounded border bg-surface-0 py-1 text-left text-sm shadow-lg">
      {items.map(item => <button key={item.action} type="button" role="menuitem" tabIndex={-1} disabled={disabled || item.blocked}
        title={disabled ? title : item.blocked ? item.reason : undefined} onClick={() => act(item.action)}
        className="block w-full px-3 py-1.5 text-left hover:bg-surface-50">{item.label}</button>)}
    </div>}
  </div>;
}

/**
 * The Process Steps table (spec 2026-09-26 §4): handle, #, Step, Instructions & parameters, the
 * greyed sign-off cue and a ⋮ menu per row. It holds no business logic — every edit goes through
 * the `process-table.ts` leaves and comes back through `onChange` — and no fetch. Focus requests
 * arrive as `focus`, keyed by client id, and are applied one frame after the rows render.
 */
export function ProcessStepTable({ rows, catalog, disabled, title, focus, onChange, onInsertAt, onRemove }: {
  rows: readonly ProcessDraftStep[]; catalog: readonly ProcessEditorCode[];
  disabled: boolean; title?: string; focus: StepFocus | null;
  onChange: (rows: ProcessDraftStep[], focus?: StepFocus) => void;
  onInsertAt: (index: number) => void; onRemove: (index: number) => void;
}) {
  const [announcement, setAnnouncement] = useState("");
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [dragScope] = useState(newId); // this mount's token (STEP_DRAG_TYPE)
  const targets = useRef(new Map<string, HTMLElement>());
  const register = (key: string) => (node: HTMLElement | null) => { if (node) targets.current.set(key, node); else targets.current.delete(key); };
  // Keyed on the request's identity (pre-flight M6): the same request is applied once, so a
  // re-render while the operator types never steals focus back to the requested control.
  useEffect(() => {
    if (!focus) return;
    const frame = requestAnimationFrame(() => targets.current.get(focusKey(focus))?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focus]);
  function move(from: number, to: number) {
    if (disabled || from === to || to < 0 || to >= rows.length) return;
    const id = rows[from].clientId;
    onChange(moveProcessStep(rows, from, to)); setAnnouncement(`Step ${from + 1} moved to position ${to + 1}`);
    requestAnimationFrame(() => targets.current.get(`${id}:handle`)?.focus());
  }
  function update(index: number, step: ProcessDraftStep) { if (!disabled) onChange(replaceStepAt(rows, index, step)); }
  function patch(index: number, i: number, p: Partial<Pick<ProcessParameterInput, "label" | "unit" | "value">>) { update(index, updateParameter(rows[index], i, p)); }
  function addParameterTo(index: number) {
    if (disabled) return;
    const step = rows[index];
    onChange(replaceStepAt(rows, index, addParameter(step, `new:${newId()}`)), { clientId: step.clientId, target: { kind: "parameter-name", index: step.parameters.length } });
  }
  function run(index: number, action: StepAction) {
    if (action === "insert-above") onInsertAt(index);
    else if (action === "insert-below") onInsertAt(index + 1);
    else if (action === "move-up") move(index, index - 1);
    else if (action === "move-down") move(index, index + 1);
    else if (action === "add-parameter") addParameterTo(index);
    else onRemove(index);
  }
  return <>
    <p className="mb-2 text-xs text-ink-500">Drag a handle or press Alt + ↑ / ↓ on it to reorder. Hover a row for + Insert and + Parameter, or open its ⋮ menu.</p>
    <table id="process-steps-table" className="w-full table-fixed text-sm">
      <thead>
        <tr className="border-b text-left text-xs font-medium text-ink-500">
          <th scope="col" className="w-8 py-2"><span className="sr-only">Reorder</span></th>
          <th scope="col" className="w-8 py-2">#</th>
          <th scope="col" className="w-32 py-2">Step</th>
          <th scope="col" className="py-2">Instructions &amp; parameters</th>
          <th aria-hidden="true" className="hidden w-28 py-2 lg:table-cell"></th>
          <th scope="col" className="w-10 py-2"><span className="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {!rows.length && <tr><td colSpan={6} className="px-2 py-6 text-center text-sm text-ink-500">No steps yet. Search for a code below to add the first step.</td></tr>}
        {rows.map((step, index) => {
          const n = index + 1; const code = catalog.find(c => c.id === step.codeId); const blanks = emptyParameters(step);
          return <tr key={step.clientId} data-step-id={step.clientId} className="group relative border-b border-line align-top"
            onDragOver={e => { if (!disabled && e.dataTransfer.types.includes(STEP_DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } }}
            // Only a drag carrying the handle's type is the table's; any other (text into an input)
            // stays native. One whose token is another table's (another window, even of this part)
            // or whose row is gone moves nothing, and its drop is still prevented.
            onDrop={e => { if (!e.dataTransfer.types.includes(STEP_DRAG_TYPE)) return; e.preventDefault(); const payload = e.dataTransfer.getData(STEP_DRAG_TYPE); const from = payload.startsWith(`${dragScope} `) ? rows.findIndex(r => r.clientId === payload.slice(dragScope.length + 1)) : -1; if (from >= 0) move(from, index); }}>
            <td className="py-2">
              <button type="button" ref={register(`${step.clientId}:handle`)} draggable={!disabled} disabled={disabled} title={title} aria-label={`Move step ${n}`}
                className="cursor-grab select-none rounded px-1 text-ink-500 hover:text-ink-800"
                onDragStart={e => { if (disabled) { e.preventDefault(); return; } e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData(STEP_DRAG_TYPE, `${dragScope} ${step.clientId}`); }}
                onKeyDown={e => { if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); move(index, index + (e.key === "ArrowUp" ? -1 : 1)); } }}>⠿</button>
            </td>
            <td className="py-2 text-ink-500 tabular-nums">{n}</td>
            <td className="break-words py-2 pr-2">
              <div className="font-semibold">{code?.name ?? step.codeId}</div>
              <div className="text-xs text-ink-500">{code?.code}</div>
            </td>
            <td className="relative break-words py-2 pr-2">
              <button type="button" aria-label={`Insert a step above step ${n}`} disabled={disabled} title={title}
                onClick={e => { e.currentTarget.focus(); onInsertAt(index); }} className={`-top-3 left-0 ${CHIP_STYLE}`}>+ Insert</button>
              {step.parameters.map((p, i) => {
                const label = p.label.trim(); const who = label || `parameter ${i + 1}`;
                const valueName = label ? `Step ${n} ${label}` : `Step ${n} parameter ${i + 1} value`;
                const unitName = label ? `Step ${n} ${label} unit` : `Step ${n} parameter ${i + 1} unit`;
                const empty = blanks[i] ? "ring-1 ring-accent-400" : "";
                return <div key={p.key} className="mb-1 flex min-w-0 flex-wrap items-center gap-1">
                  <input type="text" aria-label={`Step ${n} parameter ${i + 1} name`} value={p.label} maxLength={60} placeholder="Name" disabled={disabled} title={title}
                    ref={register(`${step.clientId}:parameter-name:${i}`)} onChange={e => patch(index, i, { label: e.target.value })}
                    className={`${INPUT_COMPACT} w-28 min-w-0 disabled:bg-surface-50`} />
                  <span className="text-ink-500">:</span>
                  {p.type === "CHECKBOX"
                    ? <>
                      <input type="checkbox" aria-label={valueName} checked={p.value === "true"} disabled={disabled} title={title}
                        ref={register(`${step.clientId}:parameter:${i}`)} onChange={e => patch(index, i, { value: e.target.checked ? "true" : "false" })} className={`h-4 w-4 ${empty}`} />
                      <button type="button" aria-label={`Clear ${who} for step ${n}`} disabled={disabled || p.value === ""} title={disabled ? title : p.value === "" ? "Nothing to clear" : undefined}
                        onClick={() => patch(index, i, { value: "" })} className="text-xs text-ink-500 underline hover:text-ink-800">Clear</button>
                    </>
                    : <input type={p.type === "DATE" ? "date" : "text"} inputMode={p.type === "NUMBER" ? "decimal" : undefined} aria-label={valueName} value={p.value} maxLength={500}
                      disabled={disabled} title={title} ref={register(`${step.clientId}:parameter:${i}`)} onChange={e => patch(index, i, { value: e.target.value })}
                      className={`${INPUT_COMPACT} min-w-16 flex-1 disabled:bg-surface-50 ${empty}`} />}
                  <input type="text" aria-label={unitName} value={p.unit ?? ""} maxLength={20} placeholder="unit" disabled={disabled} title={title}
                    onChange={e => patch(index, i, { unit: e.target.value === "" ? null : e.target.value })} className={`${INPUT_COMPACT} w-14 min-w-0 disabled:bg-surface-50`} />
                  <button type="button" aria-label={`Remove ${who} from step ${n}`} disabled={disabled} title={title} onClick={() => update(index, removeParameter(step, i))}
                    className="px-1 text-sm text-ink-500 hover:text-red-600">✕</button>
                </div>;
              })}
              <textarea aria-label={`Step ${n} instructions`} placeholder="Instruction" value={step.instruction} maxLength={4000} disabled={disabled} title={title}
                ref={register(`${step.clientId}:instruction`)} onChange={e => update(index, { ...step, instruction: e.target.value })}
                className={`${INPUT_COMPACT} [field-sizing:content] min-h-10 w-full resize-y leading-6 disabled:bg-surface-50`} />
              <button type="button" aria-label={`Add a parameter to step ${n}`} disabled={disabled} title={title}
                onClick={() => addParameterTo(index)} className={`right-2 -bottom-3 ${CHIP_STYLE}`}>+ Parameter</button>
            </td>
            <td aria-hidden="true" className="hidden lg:table-cell py-2 text-xs text-ink-500">EQ# · OP · Date</td>
            <td className="py-1 text-right">
              <StepActionsMenu n={n} count={rows.length} open={openMenu === step.clientId} disabled={disabled} title={title}
                onOpen={() => setOpenMenu(step.clientId)} onClose={() => setOpenMenu(current => (current === step.clientId ? null : current))}
                onAction={action => run(index, action)} />
            </td>
          </tr>;
        })}
      </tbody>
    </table>
    <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
  </>;
}
