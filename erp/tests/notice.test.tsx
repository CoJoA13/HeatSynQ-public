import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Notice } from "@/components/Notice";
import { PageStatus } from "@/components/PageStatus";
import { UnsavedBadge } from "@/components/UnsavedBadge";
import { SavedMark } from "@/components/SavedMark";
import { DangerButton } from "@/components/DangerButton";
import { NOTICE } from "@/lib/ui-classes";

/**
 * The redesign's Notice (spec 2026-10-30 §4.3) and the shared controls that took its skin in PR 1a.
 * PanelMessage is deliberately NOT here: it keeps its text-only `<p role="alert">` form (ledger
 * ruling, Task 4), because the E2E refusal readers (e2e/lib/refusal-lines.mjs) tell a page banner
 * (`p.bg-red-50`) from a panel message (`p[role="alert"].whitespace-pre-line`) by that very class,
 * and tests/shipment-panel-messages.test.ts pins its markup.
 */
describe("Notice", () => {
  it("draws each kind with its class and the role it is given", () => {
    expect(renderToStaticMarkup(<Notice kind="warning" role="status">x</Notice>))
      .toBe(`<div role="status" class="${NOTICE.warning}">x</div>`);
    expect(renderToStaticMarkup(<Notice kind="info">x</Notice>)).toBe(`<div class="${NOTICE.info}">x</div>`);
  });
  it("appends a caller's class after the kind's", () => {
    expect(renderToStaticMarkup(<Notice kind="success" className="mb-3">x</Notice>))
      .toBe(`<div class="${NOTICE.success} mb-3">x</div>`);
  });
});

describe("the shared controls read the leaf's strings", () => {
  it("PageStatus's failed read is a refusal notice, still a <p role=alert> with no pre-line", () => {
    expect(renderToStaticMarkup(<PageStatus error="boom" />))
      .toBe(`<div class="p-6"><p role="alert" class="${NOTICE.refusal}">boom</p></div>`);
  });
  it("UnsavedBadge is the warning chip", () => {
    expect(renderToStaticMarkup(<UnsavedBadge dirty />))
      .toBe('<span class="rounded-[5px] bg-accent-50 px-1.5 py-0.5 text-xs font-medium text-accent-600">Unsaved changes</span>');
  });
  it("SavedMark is success green", () => {
    expect(renderToStaticMarkup(<SavedMark label="PO number" show />))
      .toBe('<span role="status" aria-label="PO number saved" class="ml-2 text-xs text-success-700">Saved</span>');
  });
  it("DangerButton stays red-bordered in the title row, in the danger token", () => {
    expect(renderToStaticMarkup(<DangerButton onClick={() => {}}>Void</DangerButton>))
      .toBe('<button type="button" class="rounded-md border border-danger-600 px-3 py-1.5 text-sm text-danger-600">Void</button>');
  });
});
