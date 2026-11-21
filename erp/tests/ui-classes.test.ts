import { describe, expect, it } from "vitest";
import {
  BADGE_DANGER, BADGE_WARNING, BUTTON_DANGER_FILL, BUTTON_NEUTRAL, BUTTON_NEUTRAL_COMPACT, BUTTON_PRIMARY,
  BUTTON_PRIMARY_COMPACT, BUTTON_SELECTED, CARD, CARD_FLUSH, CHIP, INPUT, INPUT_COMPACT, LABEL, LINK,
  NOTICE, PILL_ACTIVE, PILL_IDLE, TABLE_CELL, TABLE_HEAD, TEXT_MUTED,
} from "@/lib/ui-classes";

/**
 * The redesign's control classes, stated once (spec 2026-10-30 §4.3) and pinned here the way
 * tests/tab-nav.test.tsx pins TabNav's pair: a changed string is a decision about every control
 * that reads it. The second block refuses the scaffold palette and the `disabled:` utilities
 * (#642) inside the leaf, so the old look cannot creep back through the one place it is written.
 */
const BASE = "inline-flex h-10 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium whitespace-nowrap";

describe("ui-classes", () => {
  it("buttons", () => {
    expect(BUTTON_PRIMARY).toBe(`${BASE} bg-accent-600 text-white`);
    expect(BUTTON_NEUTRAL).toBe(`${BASE} border border-line bg-surface-0 text-ink-800`);
    expect(BUTTON_SELECTED).toBe(`${BASE} border border-ink-900 bg-ink-900 text-white`);
    expect(BUTTON_DANGER_FILL).toBe(`${BASE} bg-danger-600 text-white`);
  });
  it("pills", () => {
    expect(PILL_ACTIVE).toBe(BUTTON_SELECTED);
    expect(PILL_IDLE).toBe(`${BUTTON_NEUTRAL} hover:bg-surface-50`);
  });
  it("chip, card, table, input, label, muted text", () => {
    expect(CHIP).toBe("inline-flex h-[26px] items-center rounded-[5px] bg-link-50 px-2 text-xs font-medium text-link-700");
    expect(CARD).toBe("rounded-lg border border-line bg-surface-0 p-5");
    expect(CARD_FLUSH).toBe("rounded-lg border border-line bg-surface-0");
    expect(TABLE_HEAD).toBe("bg-surface-50 text-[11px] font-medium text-ink-500");
    expect(TABLE_CELL).toBe("px-2.5 py-3 text-xs text-ink-800");
    expect(INPUT).toBe("rounded-lg border border-line bg-surface-0 px-3 py-2 text-sm text-ink-800");
    expect(LABEL).toBe("text-xs font-medium text-ink-500");
    expect(TEXT_MUTED).toBe("text-sm text-ink-500");
  });
  it("compact controls, link and badges (PR 1b: today's control heights for in-row and in-grid controls)", () => {
    expect(BUTTON_PRIMARY_COMPACT).toBe("inline-flex items-center justify-center gap-1 rounded-md bg-accent-600 px-3 py-1.5 text-sm font-medium text-white");
    expect(BUTTON_NEUTRAL_COMPACT).toBe("inline-flex items-center justify-center gap-1 rounded-md border border-line bg-surface-0 px-3 py-1.5 text-sm font-medium text-ink-800");
    expect(INPUT_COMPACT).toBe("rounded-md border border-line bg-surface-0 px-2 py-1 text-sm text-ink-800");
    expect(LINK).toBe("text-link-700 underline");
    expect(BADGE_WARNING).toBe("rounded-[5px] bg-accent-50 px-1.5 py-0.5 text-xs font-medium text-accent-600");
    expect(BADGE_DANGER).toBe("rounded-[5px] bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-700");
  });
  it("the four notice kinds", () => {
    expect(NOTICE.refusal).toBe("rounded-[5px] bg-red-50 p-3.5 text-xs text-red-700");
    expect(NOTICE.warning).toBe("rounded-[5px] bg-accent-50 p-3.5 text-xs text-accent-600");
    expect(NOTICE.info).toBe("rounded-[5px] bg-link-50 p-3.5 text-xs text-link-700");
    expect(NOTICE.success).toBe("rounded-[5px] bg-success-50 p-3.5 text-xs text-success-700");
  });
  it("spells no scaffold colour and no disabled: utility; red belongs to the refusal alone", () => {
    const all = [BUTTON_PRIMARY, BUTTON_NEUTRAL, BUTTON_SELECTED, BUTTON_DANGER_FILL, PILL_ACTIVE, PILL_IDLE,
      BUTTON_PRIMARY_COMPACT, BUTTON_NEUTRAL_COMPACT, INPUT_COMPACT, LINK, BADGE_WARNING, BADGE_DANGER,
      CHIP, CARD, CARD_FLUSH, TABLE_HEAD, TABLE_CELL, INPUT, LABEL, TEXT_MUTED, ...Object.values(NOTICE)];
    for (const s of all) expect(s).not.toMatch(/\b(?:slate|amber|blue|gray|zinc)-|disabled:/);
    for (const [kind, s] of Object.entries(NOTICE)) expect(/red-/.test(s)).toBe(kind === "refusal");
    for (const s of all.filter((x) => x !== NOTICE.refusal && x !== BADGE_DANGER)) expect(s).not.toMatch(/red-/);
  });
});
