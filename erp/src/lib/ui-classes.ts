// The redesign's control classes, stated once (spec 2026-10-30-ux-redesign-design.md §4.3; the
// values are docs/execution/2026-10-30-figma-redesign/design-system.md §5). The shared components
// read these, and after PR 1b no page spells a button, card, table, input, chip or notice class of
// its own. tests/ui-classes.test.ts pins every string and refuses the scaffold palette inside this
// file. Import-free; client-safe.

const BUTTON_BASE = "inline-flex h-10 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium whitespace-nowrap";

/** Orange fill: the one primary action of a screen (Save & Print, Print N travelers, Add). */
export const BUTTON_PRIMARY = `${BUTTON_BASE} bg-accent-600 text-white`;
/** White with a line border: every other button. */
export const BUTTON_NEUTRAL = `${BUTTON_BASE} border border-line bg-surface-0 text-ink-800`;
/** Dark fill: the selected pill of a tab row or a saved-view row. */
export const BUTTON_SELECTED = `${BUTTON_BASE} border border-ink-900 bg-ink-900 text-white`;
/** Filled red: the modal's confirm button for a void, delete or reverse, and nothing else
 *  (ruling 8 keeps the title-row DangerButton red-bordered). */
export const BUTTON_DANGER_FILL = `${BUTTON_BASE} bg-danger-600 text-white`;

/** The compact forms (PR 1b, 2026-10-31): today's control heights, for the buttons that sit in rows
 *  and grids, so a dense screen does not reflow; a screen's one primary action is promoted to the
 *  full-size `BUTTON_PRIMARY` in its page PR. */
export const BUTTON_PRIMARY_COMPACT = "inline-flex items-center justify-center gap-1 rounded-md bg-accent-600 px-3 py-1.5 text-sm font-medium text-white";
export const BUTTON_NEUTRAL_COMPACT = "inline-flex items-center justify-center gap-1 rounded-md border border-line bg-surface-0 px-3 py-1.5 text-sm font-medium text-ink-800";
export const INPUT_COMPACT = "rounded-md border border-line bg-surface-0 px-2 py-1 text-sm text-ink-800";
/** A text link; a size utility rides beside it where the site had one. */
export const LINK = "text-link-700 underline";
/** The small pills: a warning (Unsaved changes, credit hold) and a danger (voided). */
export const BADGE_WARNING = "rounded-[5px] bg-accent-50 px-1.5 py-0.5 text-xs font-medium text-accent-600";
export const BADGE_DANGER = "rounded-[5px] bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-700";

export const PILL_ACTIVE = BUTTON_SELECTED;
export const PILL_IDLE = `${BUTTON_NEUTRAL} hover:bg-surface-50`;

export const CHIP = "inline-flex h-[26px] items-center rounded-[5px] bg-link-50 px-2 text-xs font-medium text-link-700";
export const CARD = "rounded-lg border border-line bg-surface-0 p-5";
/** The card with no padding, for a table that fills it (the board, PR 2). */
export const CARD_FLUSH = "rounded-lg border border-line bg-surface-0";
export const TABLE_HEAD = "bg-surface-50 text-[11px] font-medium text-ink-500";
export const TABLE_CELL = "px-2.5 py-3 text-xs text-ink-800";
export const INPUT = "rounded-lg border border-line bg-surface-0 px-3 py-2 text-sm text-ink-800";
export const LABEL = "text-xs font-medium text-ink-500";
export const TEXT_MUTED = "text-sm text-ink-500";

export type NoticeKind = "refusal" | "warning" | "info" | "success";

/** A refusal keeps the app's red (ruling 2); the other three are the design's own. */
export const NOTICE: Record<NoticeKind, string> = {
  refusal: "rounded-[5px] bg-red-50 p-3.5 text-xs text-red-700",
  warning: "rounded-[5px] bg-accent-50 p-3.5 text-xs text-accent-600",
  info: "rounded-[5px] bg-link-50 p-3.5 text-xs text-link-700",
  success: "rounded-[5px] bg-success-50 p-3.5 text-xs text-success-700",
};
