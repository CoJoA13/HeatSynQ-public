import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionMenu } from "@/components/ActionMenu";
import { itemTitle, type MenuItem } from "@/lib/action-menu";
import { BUTTON_NEUTRAL } from "@/lib/ui-classes";

/**
 * ActionMenu, the "More actions" popover (spec 2026-10-30 §4.3): a disabled item carries its
 * refusal reason as its title (refusals up front), an enabled one its sub-line; the title-row
 * danger action never lives here (ruling 8).
 */
const ITEMS: MenuItem[] = [
  { label: "Link another order", sub: "Same customer only", onSelect: () => {} },
  { label: "Unlink from group", onSelect: () => {}, disabled: true, title: "This order is not linked." },
  { label: "Export to Excel", onSelect: () => {}, danger: true },
];

// An `<a>` cannot be disabled, so the href form carries no `disabled` and no refusal `title`: a
// gated export is the button form (review of PR 8, Important 2). The compiler refuses the shape.
// @ts-expect-error — `disabled` is not on the href arm
const GATED_LINK: MenuItem = { label: "Export to Excel", href: "/api/x", disabled: true, title: "Requires customers.view" };
void GATED_LINK;

describe("itemTitle", () => {
  it("is the refusal while disabled, else the sub-line", () => {
    expect(itemTitle(ITEMS[1])).toBe("This order is not linked.");
    expect(itemTitle(ITEMS[0])).toBe("Same customer only");
    expect(itemTitle(ITEMS[2])).toBeUndefined();
  });
});

describe("ActionMenu", () => {
  const html = renderToStaticMarkup(<ActionMenu items={ITEMS} />);
  it("is a details element whose summary is a neutral button named More actions", () => {
    expect(html).toContain(`<summary aria-haspopup="menu" class="${BUTTON_NEUTRAL}">More actions</summary>`);
    expect(renderToStaticMarkup(<ActionMenu label="Order actions" items={ITEMS} />)).toContain(">Order actions</summary>");
  });
  it("draws an href item as a link that loads a document (PR 8: the customers list's Export to Excel)", () => {
    const link = renderToStaticMarkup(<ActionMenu items={[{ label: "Export to Excel", href: "/api/customers/export?search=x" }]} />);
    expect(link).toContain('<a role="menuitem" href="/api/customers/export?search=x"');
    expect(link).not.toContain("data-navigation"); // the opt-out is for anchors with no click handler (#275)
    expect(link).not.toContain("<button");
    expect(link.match(/role="menuitem"/g)).toHaveLength(1);
  });
  it("lists one menuitem per item, the disabled one titled with its reason, the danger one in red", () => {
    expect(html.match(/role="menuitem"/g)).toHaveLength(3);
    expect(html).toContain('disabled="" title="This order is not linked."');
    expect(html).toContain('title="Same customer only"');
    expect(html).toContain("Same customer only</span>");
    expect(html).toMatch(/class="[^"]*text-danger-600[^"]*"[^>]*>Export to Excel/);
  });
});
