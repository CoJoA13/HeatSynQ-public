import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `askDiscard` (spec 2026-10-30 §4.3): the modal form of `confirmDiscard`, for in-page questions
 * whose handlers can await. It resolves true without opening when nothing is unsaved, and
 * otherwise asks through the modal with the same `confirmMessage` sentence.
 */
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/lib/draft-session", () => ({ peekBrowserDraftSession: () => null, getBrowserDraftSession: () => null }));
vi.mock("@/lib/use-recoverable-draft", () => ({ useBrowserDraftStore: () => ({ summary: { count: 0 } }) }));

import { askDiscard } from "@/lib/use-unsaved-section";
import { answerModal, currentModal, _resetModalsForTests } from "@/lib/modal";
import { clearUnsaved, confirmMessage, DRAFTS_STAY, markUnsaved } from "@/lib/unsaved-guard";

beforeEach(() => { _resetModalsForTests(); clearUnsaved("k"); clearUnsaved("q"); });

describe("askDiscard", () => {
  it("resolves true without opening when nothing is unsaved", async () => {
    Object.defineProperty(globalThis, "window", { value: { location: { pathname: "/" } }, configurable: true });
    expect(await askDiscard()).toBe(true);
    expect(currentModal()).toBeNull();
  });

  it("asks with confirmMessage's sentence while a section is dirty, and resolves the answer", async () => {
    Object.defineProperty(globalThis, "window", { value: { location: { pathname: "/" } }, configurable: true });
    markUnsaved("k", "Containers");
    const p = askDiscard({ action: "Re-split the loads?" });
    expect(currentModal()).toMatchObject({ kind: "confirm", title: "Re-split the loads?", confirm: "Discard", danger: true, body: confirmMessage(["Containers"], false, "Re-split the loads?") });
    answerModal(currentModal()!.id, false);
    expect(await p).toBe(false);
  });

  // Owner answer 2026-11-04: a call with no `action` is a departure, so it names the kept drafts
  // as the leave prompt does (R24, #704). Mutation: hand `confirmMessage` no recoverable list and
  // the kept section is promised a discard under a Discard button.
  it("with no action, a kept section is told it stays, under a plain Leave button", async () => {
    Object.defineProperty(globalThis, "window", { value: { location: { pathname: "/" } }, configurable: true });
    markUnsaved("q", "Quote details", undefined, true);
    const p = askDiscard();
    expect(currentModal()).toMatchObject({
      kind: "confirm", title: "Leave the page?", confirm: "Leave", danger: false,
      body: `Quote details has unsaved changes. Leave the page? ${DRAFTS_STAY}`,
    });
    answerModal(currentModal()!.id, true);
    expect(await p).toBe(true);
  });

  it("with no action, a plain section beside a kept one is still discarded, under Discard", async () => {
    Object.defineProperty(globalThis, "window", { value: { location: { pathname: "/" } }, configurable: true });
    markUnsaved("k", "Lines");
    markUnsaved("q", "Quote details", undefined, true);
    const p = askDiscard();
    expect(currentModal()).toMatchObject({
      kind: "confirm", title: "Discard unsaved changes?", confirm: "Discard", danger: true,
      body: confirmMessage(["Lines", "Quote details"], false, undefined, ["Quote details"]),
    });
    const body = (currentModal() as { body: string }).body;
    expect(body).toContain("Lines has unsaved changes, and leaving discards them.");
    expect(body).toContain(DRAFTS_STAY);
    answerModal(currentModal()!.id, false);
    expect(await p).toBe(false);
  });

  it("with no action and only plain sections, the question is the discard it always was", async () => {
    Object.defineProperty(globalThis, "window", { value: { location: { pathname: "/" } }, configurable: true });
    markUnsaved("k", "Lines");
    const p = askDiscard();
    expect(currentModal()).toMatchObject({
      kind: "confirm", title: "Discard unsaved changes?", confirm: "Discard", danger: true,
      body: "Lines has unsaved changes. Leave the page and discard them?",
    });
    answerModal(currentModal()!.id, false);
    await p;
  });

  // An `action` names its own loss (the pick lists' list switch leaves no page), so a kept section
  // is not told it stays there.
  it("with an action, no section is named kept", async () => {
    Object.defineProperty(globalThis, "window", { value: { location: { pathname: "/" } }, configurable: true });
    markUnsaved("q", "Terms", undefined, true);
    const p = askDiscard({ action: "Choose another list and discard them?" });
    expect(currentModal()).toMatchObject({
      title: "Choose another list and discard them?", confirm: "Discard", danger: true,
      body: "Terms has unsaved changes. Choose another list and discard them?",
    });
    answerModal(currentModal()!.id, false);
    await p;
  });
});
