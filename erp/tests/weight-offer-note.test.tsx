import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WeightOfferNote } from "@/components/WeightOfferNote";
import type { WeightOffer } from "@/lib/net-weight";

// The offered weight as one line of screen (the quantity corrections design §4): the sum, one
// control to accept it, and, when the order line cannot take the figure, why. The order hub and the
// shipment Lines grid both render this component. It holds no state and calls no hook, so vitest's
// "node" environment reaches all of it two ways: the markup through `renderToStaticMarkup`, and the
// two handlers by calling the component and reading the element it returns (static markup carries
// no handlers). The figures themselves are the leaf's (net-weight.test.ts).

const OFFER: WeightOffer = { quantity: 32, eachWeight: 1.5, pounds: 48, belowShipped: null };
const BLOCKED: WeightOffer = { ...OFFER, belowShipped: 95 };
const LARGE: WeightOffer = { quantity: 1200, eachWeight: 1.25, pounds: 1500, belowShipped: 2400.5 };

type Props = Parameters<typeof WeightOfferNote>[0];
const props = (over: Partial<Props> = {}): Props => ({ offer: OFFER, disabled: false, onUse: () => {}, ...over });
const markup = (over: Partial<Props> = {}) => renderToStaticMarkup(<WeightOfferNote {...props(over)} />);
/** The one `<button …>` opening tag in the markup. */
function control(html: string): string {
  const tags: string[] = html.match(/<button\b[^>]*>/g) ?? [];
  expect(tags).toHaveLength(1);
  return tags[0];
}
/** The text of every element in the markup, in order. */
const texts = (html: string) => [...html.matchAll(/>([^<]+)</g)].map((m) => m[1]);

type ButtonProps = { onClick?: () => void; onPointerDown?: (event: { preventDefault: () => void }) => void };
/** The one `<button>` in what the component returns. */
function offerButton(node: ReactNode): ReactElement<ButtonProps> {
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

describe("WeightOfferNote", () => {
  it("shows the sum, then one control named for the figure, and nothing else", () => {
    // Anchored at both ends: a span and a button are everything an offer that is not blocked renders.
    expect(markup()).toMatch(/^<span[^>]*>32 × 1\.5000 lb = 48\.00 lb<\/span><button type="button"[^>]*>Use 48\.00 lb<\/button>$/);
    expect(texts(markup())).toEqual(["32 × 1.5000 lb = 48.00 lb", "Use 48.00 lb"]);
  });

  it("words all three figures as the leaf does, thousands grouped", () => {
    expect(texts(markup({ offer: LARGE }))).toEqual([
      "1,200 × 1.2500 lb = 1,500.00 lb", "Use 1,500.00 lb", "Below the 2,400.50 lb already shipped",
    ]);
  });

  it("the control is enabled, with no title, when the caller allows it and nothing blocks the figure", () => {
    const button = control(markup());
    expect(button).not.toContain(' disabled=""');
    expect(button).not.toContain("title=");
  });

  it("the caller disables the control, and the caller's title says why", () => {
    const button = control(markup({ disabled: true, title: "Requires orders.edit" }));
    expect(button).toContain(' disabled=""');
    expect(button).toContain('title="Requires orders.edit"');
    // The caller's reason is a title only: nothing is added to the line.
    expect(texts(markup({ disabled: true, title: "Requires orders.edit" }))).toEqual(["32 × 1.5000 lb = 48.00 lb", "Use 48.00 lb"]);
  });

  it("an enabled control carries the caller's title too", () => {
    const button = control(markup({ title: "Fills the weight box" }));
    expect(button).not.toContain(' disabled=""');
    expect(button).toContain('title="Fills the weight box"');
  });

  it("a figure below what has shipped is shown with the reason as text after the control", () => {
    const html = markup({ offer: BLOCKED });
    expect(html).toMatch(/<\/button><span[^>]*>Below the 95\.00 lb already shipped<\/span>$/);
    expect(texts(html)).toEqual(["32 × 1.5000 lb = 48.00 lb", "Use 48.00 lb", "Below the 95.00 lb already shipped"]);
  });

  it("a figure below what has shipped disables the control even when the caller allows it", () => {
    expect(control(markup({ offer: BLOCKED, disabled: false }))).toContain(' disabled=""');
  });

  it("a blocked control's title is the same sentence, in place of the caller's", () => {
    expect(control(markup({ offer: BLOCKED }))).toContain('title="Below the 95.00 lb already shipped"');
    const both = control(markup({ offer: BLOCKED, disabled: true, title: "Requires orders.edit" }));
    expect(both).toContain('title="Below the 95.00 lb already shipped"');
    expect(both).not.toContain("Requires orders.edit");
  });

  it("the word Save never appears: the control is not a save button", () => {
    // The control accepts a figure. On the shipment grid it saves nothing: Save lines and Save
    // shipment do, and flows and operators find those by that word.
    for (const html of [markup(), markup({ offer: BLOCKED }), markup({ offer: LARGE }), markup({ disabled: true })]) {
      expect(html).not.toMatch(/save/i);
    }
  });

  it("no element's whole text is Restore", () => {
    // Flows count and click the draft recovery notice by the exact name Restore.
    for (const html of [markup(), markup({ offer: BLOCKED }), markup({ disabled: true, title: "Requires orders.edit" })]) {
      expect(texts(html).map((text) => text.trim())).not.toContain("Restore");
    }
  });

  it("the pointer-down on the control keeps focus where it was, and the click uses the figure", () => {
    // On the order hub the Qty and Weight boxes save on blur. Without the preventDefault the
    // pointer-down blurs a weight box that holds typed text, that blur saves the typed text, the
    // hub disables this control while that save is out, and the click never lands: the operator
    // pressed Use 48.00 lb and the order took the other weight.
    const onUse = vi.fn();
    const button = offerButton(WeightOfferNote(props({ onUse })));
    const event = { preventDefault: vi.fn() };
    button.props.onPointerDown?.(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(onUse).not.toHaveBeenCalled();
    button.props.onClick?.();
    expect(onUse).toHaveBeenCalledOnce();
  });
});
