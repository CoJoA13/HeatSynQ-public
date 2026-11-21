import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldMark } from "@/app/orders/[id]/LineFieldStatus";
import type { FieldView } from "@/lib/line-field-saves";

// The mark beside an order hub Qty or Weight box (the quantity corrections design §4): Saved after
// a save lands, Not saved with a Restore control after one is refused. `FieldMark` holds no state
// and calls no hook, so vitest's "node" environment reaches all of it two ways: the markup through
// `renderToStaticMarkup`, and the two handlers by calling the component and reading the element it
// returns (static markup carries no handlers).

const QUIET: FieldView = { text: "32", mark: null, message: null, saving: false };
const SAVED: FieldView = { text: "40", mark: "saved", message: null, saving: false };
const NOT_SAVED: FieldView = {
  text: "20", mark: "not-saved", message: "Lead (ACME · P-100): cannot reduce qty below 30 already shipped", saving: false,
};
const RETRYING: FieldView = { ...NOT_SAVED, saving: true };

type Props = Parameters<typeof FieldMark>[0];
const props = (view: FieldView, over: Partial<Props> = {}): Props =>
  ({ fieldLabel: "Lead quantity", view, server: "32", onRestore: () => {}, ...over });
const markup = (view: FieldView, over: Partial<Props> = {}) => renderToStaticMarkup(<FieldMark {...props(view, over)} />);

type ButtonProps = { onClick?: () => void; onPointerDown?: (event: { preventDefault: () => void }) => void };
/** The one `<button>` in what the component returns. */
function restoreButton(node: ReactNode): ReactElement<ButtonProps> {
  const found: ReactElement<ButtonProps>[] = [];
  const walk = (child: ReactNode): void => {
    if (Array.isArray(child)) { child.forEach(walk); return; }
    if (!isValidElement<{ children?: ReactNode }>(child)) return;
    if (child.type === "button") found.push(child as ReactElement<ButtonProps>);
    walk(child.props.children);
  };
  walk(node);
  expect(found).toHaveLength(1);
  return found[0];
}

describe("FieldMark", () => {
  it("renders nothing for a box with no mark", () => {
    expect(markup(QUIET)).toBe("");
    expect(markup({ ...QUIET, saving: true })).toBe("");
  });

  it("Saved is a status named for its field, with no control beside it", () => {
    // Anchored at both ends: the span is everything a Saved box renders.
    expect(markup(SAVED)).toMatch(/^<span role="status" aria-label="Lead quantity saved"[^>]*>Saved<\/span>$/);
  });

  it("Not saved is an alert named for its field", () => {
    expect(markup(NOT_SAVED)).toMatch(/^<span role="alert" aria-label="Lead quantity not saved"[^>]*>Not saved<\/span><button/);
  });

  it("Restore names the stored value in its text and the field in its label", () => {
    const html = markup(NOT_SAVED);
    expect(html).toMatch(/<button type="button" aria-label="Restore Lead quantity to 32"[^>]*>Restore 32<\/button>$/);
    expect(markup(NOT_SAVED, { fieldLabel: "Line 2 weight", server: "48.5" }))
      .toMatch(/<button type="button" aria-label="Restore Line 2 weight to 48.5"[^>]*>Restore 48.5<\/button>$/);
  });

  it("Restore is enabled, with no title, while nothing is in flight", () => {
    const html = markup(NOT_SAVED);
    expect(html).not.toContain(' disabled=""');
    expect(html).not.toContain("title=");
  });

  it("Restore is disabled, and says why, while that field's save is in flight", () => {
    expect(markup(RETRYING)).toMatch(
      /<button type="button" disabled="" title="Wait for this save to finish before restoring" aria-label="Restore Lead quantity to 32"/);
  });

  it("no permission or void gate can disable Restore: it reads nothing but its own save", () => {
    // A voided order or a missing orders.edit must leave Restore usable (the DiscardButton rule):
    // where no save of the box went unanswered it sends nothing, and clears. Where it does send,
    // the server refuses that order or that caller, and the box stays Not saved; a gate would not
    // change that. The component takes no gate; these stand in for one handed to it anyway.
    const closed = { allowed: false, disabled: true, title: "Order is voided" };
    const gated = { ...props(NOT_SAVED), gate: closed, editGate: closed, disabled: true } as Props;
    const html = renderToStaticMarkup(<FieldMark {...gated} />);
    expect(html).not.toContain(' disabled=""');
    expect(html).not.toContain("Order is voided");
  });

  it("the pointer-down on Restore keeps focus in the box, and the click restores", () => {
    // Without the preventDefault the pointer-down blurs the input, the blur saves a retyped value,
    // and the button is disabled by that save before the click lands.
    const onRestore = vi.fn();
    const button = restoreButton(FieldMark(props(NOT_SAVED, { onRestore })));
    const event = { preventDefault: vi.fn() };
    button.props.onPointerDown?.(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(onRestore).not.toHaveBeenCalled();
    button.props.onClick?.();
    expect(onRestore).toHaveBeenCalledOnce();
  });
});
