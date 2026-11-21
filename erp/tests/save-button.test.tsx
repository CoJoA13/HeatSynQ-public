import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SaveButton } from "@/components/SaveButton";
import { DiscardButton } from "@/components/DiscardButton";
import type { Gate } from "@/lib/permission-ui";
import { CHECKING_ACCESS } from "@/lib/draft-recovery-words";
import { DRAFT_RECOVERY_TITLE, gridGate } from "@/lib/shipment-gates";
import { ENTRY_NOT_ADDED } from "@/lib/waiting-titles";

// vitest has no DOM, so nothing here clicks Save. A save in flight is injected through the
// `useState` seam below (the lines-section-repick-gate.test.tsx precedent): SaveButton's one piece
// of state is `saving`, begun false, and nothing else it renders calls `useState` (`useUnsavedSection`
// calls `useId` and `useEffect`, `DiscardButton` no hook). The seam is off unless a case turns it on.
const seam = vi.hoisted(() => ({ saving: false }));
vi.mock("react", async (original) => {
  const real = await original<typeof import("react")>();
  return { ...real, useState: (initial: unknown) => {
    const state = real.useState(initial);
    return seam.saving && initial === false ? [true, state[1]] : state;
  } };
});

const ALLOWED: Gate = { allowed: true, disabled: false, title: undefined };
const DENIED: Gate = { allowed: false, disabled: true, title: "Requires orders.edit" };
const save = async () => {};
const discard = () => {};

function render(dirty: boolean, alsoUnsaved = false, gate = ALLOWED) {
  return renderToStaticMarkup(
    <SaveButton label="Save serials" section="Serials" gate={gate} dirty={dirty}
      alsoUnsaved={alsoUnsaved} onSave={save} onDiscard={discard} />,
  );
}

function discardTag(html: string): string {
  const matches = html.match(/<button\b[^>]*aria-label="Discard changes to serials"[^>]*>/g) ?? [];
  expect(matches, "the section must offer its own Discard control").toHaveLength(1);
  return matches[0]!;
}

// The rendered attributes matter: a Tailwind `disabled:*` class exists on ENABLED controls too.
const disabled = (tag: string) => /\sdisabled=""/.test(tag);
/** The Save button's own opening tag: the first button the component renders. */
const saveTag = (html: string) => html.match(/<button\b[^>]*>/)![0];
const titleOf = (tag: string) => tag.match(/\stitle="([^"]*)"/)?.[1];

describe("#309 shared grid discard control", () => {
  it("does not offer Discard when neither the grid nor an entry field holds unsaved work", () => {
    const html = render(false);
    expect(html).not.toContain("Discard");
    expect(disabled(html.match(/<button\b[^>]*>/)![0])).toBe(true);
  });

  it.each([ALLOWED, DENIED])("lets local edits be discarded regardless of the write gate: %j", (gate) => {
    const html = render(true, false, gate);
    expect(disabled(discardTag(html))).toBe(false);
    expect(disabled(html.match(/<button\b[^>]*>/)![0])).toBe(!gate.allowed);
  });

  it("offers Discard for a typed-but-unadded serial range while Save remains disabled", () => {
    const html = render(false, true);
    expect(disabled(discardTag(html))).toBe(false);
    expect(disabled(html.match(/<button\b[^>]*>/)![0])).toBe(true);
    expect(html).not.toContain("Unsaved changes");
    // Save says why it is closed, and never that nothing is unsaved while the range text waits.
    expect(titleOf(saveTag(html))).toBe(ENTRY_NOT_ADDED);
    expect(html).not.toContain("No unsaved changes");
  });

  it("keeps a clean sibling free of Discard when another grid is dirty", () => {
    const html = renderToStaticMarkup(<>
      <SaveButton label="Save serials" section="Serials" gate={ALLOWED} dirty
        onSave={save} onDiscard={discard} />
      <SaveButton label="Save containers" section="Containers" gate={ALLOWED} dirty={false}
        onSave={save} onDiscard={discard} />
    </>);
    expect(disabled(discardTag(html))).toBe(false);
    expect(html).not.toContain('aria-label="Discard changes to containers"');
  });

  it("disables Discard for its own pending save and explains why", () => {
    const html = renderToStaticMarkup(
      <DiscardButton section="Serials" dirty pending onDiscard={discard} />,
    );
    const tag = discardTag(html);
    expect(disabled(tag)).toBe(true);
    expect(tag).toContain('title="Wait for this save to finish before discarding"');
  });

  it("dispatches only the supplied local reset", () => {
    let resets = 0;
    const control = DiscardButton({ section: "Serials", dirty: true, onDiscard: () => { resets++; } });
    expect(control).not.toBeNull();
    control!.props.onClick();
    expect(resets).toBe(1);
  });
});

describe("#487 the Save button's title: the gate first, then whether there is anything to save", () => {
  it("a clean grid under an open gate: disabled, and says there is nothing to save", () => {
    const tag = saveTag(render(false));
    expect([disabled(tag), titleOf(tag)]).toEqual([true, "No unsaved changes"]);
  });

  it("a dirty grid under an open gate: enabled, with no title attribute at all", () => {
    const tag = saveTag(render(true));
    expect(disabled(tag)).toBe(false);
    expect(tag).not.toContain("title=");
  });

  it("a clean grid under a closed gate keeps the gate's reason", () => {
    const tag = saveTag(render(false, false, DENIED));
    expect([disabled(tag), titleOf(tag)]).toEqual([true, "Requires orders.edit"]);
  });

  it("a grid whose first read is in flight reads the notice's own sentence through gridGate, clean or dirty", () => {
    for (const dirty of [false, true]) {
      const tag = saveTag(render(dirty, false, gridGate(ALLOWED, "loading")));
      expect([disabled(tag), titleOf(tag)]).toEqual([true, CHECKING_ACCESS]);
    }
  });

  it("a grid holding a retained draft names draft recovery through gridGate, clean or dirty", () => {
    for (const dirty of [false, true]) {
      const tag = saveTag(render(dirty, false, gridGate(ALLOWED, "offer")));
      expect([disabled(tag), titleOf(tag)]).toEqual([true, DRAFT_RECOVERY_TITLE]);
    }
  });
});

// A grid's dirty flag clears when its draft store settles the save, inside the save callback, so a
// grid can read clean while its Save still reads "Saving…". These cases render the button's own
// `saving` state through the seam, so a button that handed `saveButtonTitle` a literal
// `saving: false` fails the first of them: its clean grid would say "No unsaved changes".
describe("#487 the Save button while its save is in flight: its \"Saving…\" label, and no title (owner answer 9, 2026-10-16)", () => {
  afterEach(() => { seam.saving = false; });
  /** The Save button's own text: the first button the component renders. */
  const saveText = (html: string) => html.match(/<button\b[^>]*>([^<]*)<\/button>/)![1];

  it.each([
    ["already clean", false, false],
    ["dirty", true, false],
    ["already clean, holding an entry", false, true],
  ])("under an open gate, %s: disabled, labelled Saving…, with no title attribute at all", (_state, dirty, alsoUnsaved) => {
    seam.saving = true;
    const html = render(dirty, alsoUnsaved);
    const tag = saveTag(html);
    expect([saveText(html), disabled(tag)]).toEqual(["Saving…", true]);
    expect(tag).not.toContain("title=");
  });

  it("under a closed gate it keeps the gate's reason", () => {
    seam.saving = true;
    const html = render(false, false, DENIED);
    const tag = saveTag(html);
    expect([saveText(html), disabled(tag), titleOf(tag)]).toEqual(["Saving…", true, "Requires orders.edit"]);
  });
});
