import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReconciliationStrip, type StripOrder } from "@/app/orders/[id]/ReconciliationStrip";
import type { StripSection } from "@/lib/order-reconciliation";
import { LINK } from "@/lib/ui-classes";

// The reconciliation strip's markup (the quantity corrections design, §5, §10.2 and §10.5; the
// container figure's words are the weights design's §9.5, S2 to S5, and the weighed figure's are
// its §10.3, T1 to T3).
//
// What each piece figure says, whether it differs and where it links is the piece leaf's, and
// order-reconciliation.test.ts holds every sentence by value. The weighed figure's sentence is the
// totals leaf's, and order-totals.test.ts holds it. This file holds what the component adds: the
// group and its name, the separator between figures, which figure is plain text and which is a
// link, where a link points, how it looks, what a click hands on, and where the weighed figure
// goes and when it is absent.
//
// vitest has no DOM. The component has no hook and no state, so two things stand in for a browser:
// it is rendered to static markup, and it is called as a plain function so a link's own `onClick`
// can be run and what draws a link can be read. Only a browser proves the scroll and the layout.

const line = (id: string, position: number, qty: number, weight: number) => ({ id, position, qty, weight });
const serialsOn = (lineId: string, count: number) => Array.from({ length: count }, () => ({ lineId }));
/** A container row of 3 containers at 42.50 lb each, so 127.50 lb of tare, not weighed unless a
 *  scale gross is given. The piece figures read `pieces` alone. */
const row = (pieces: number | null, scaleGross: number | null = null, tareEach: number | null = 42.5) =>
  ({ pieces, count: 3, tareEach, scaleGross });

/** Every figure agrees with Parts: the first sentence of owner ruling Q6. 250 pieces, 1,600.00 lb. */
const AGREES: StripOrder = {
  lines: [line("a", 1, 250, 1600)],
  containers: [row(250)],
  loads: [{ qty: 120 }, { qty: 120 }, { qty: 10 }],
  serials: [],
};
/** Order 1004 of the demonstration dataset as the weights design's §9.1 restates it, which keeps
 *  the line's "2 over" under the row's new meaning: one row of baskets that holds 252 pieces,
 *  against 250 parts. */
const CONTAINERS_OVER: StripOrder = { ...AGREES, containers: [row(252)] };
/** Parts 250 over two lines, and every other figure differs, each as its design writes it (the
 *  weights design's S5; the quantity corrections design's S6 and S7): one container row of 84
 *  pieces and one with no Pieces, one load of 120 and one with no Qty, and 30 serials on a rider
 *  of 32. The lead has no serials, so it is not judged. No row is weighed. */
const ALL_DIFFER: StripOrder = {
  lines: [line("a", 1, 218, 1395.2), line("b", 2, 32, 204.8)],
  containers: [row(84), row(null, null, null)],
  loads: [{ qty: 120 }, { qty: null }],
  serials: serialsOn("b", 30),
};
/** Order 1004 weighed, the weights design's §10.3 example: its one row on a scale at 1,740.00 lb,
 *  so a weighed net of 1,612.50 lb against a Net of 1,600.00 lb. */
const WEIGHED: StripOrder = { ...CONTAINERS_OVER, containers: [row(252, 1740)] };

const render = (order: StripOrder) =>
  renderToStaticMarkup(<ReconciliationStrip order={order} onJump={() => {}} />);

/** The markup's text content: every tag taken out. No figure holds `&`, `<`, `>` or a quote, so
 *  React escapes nothing in it. */
const textOf = (html: string) => html.replace(/<[^>]*>/g, "");
/** One attribute of an opening tag's attribute text. */
const attribute = (attributes: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1];
/** How a link looks: amber for a figure that differs, the hub's plain link for Parts. */
function look(className: string | undefined): "amber" | "plain" | "other" {
  const classes = (className ?? "").split(" ");
  if (classes.includes("text-accent-600") && classes.some((c) => c.startsWith("bg-accent-"))) return "amber";
  return className === LINK ? "plain" : "other";
}
/** Every link in the markup, in order: where it points, its whole text and how it looks. */
function linksOf(html: string) {
  const links = [...html.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)]
    .map(([, attributes, text]) => ({ href: attribute(attributes, "href"), text, look: look(attribute(attributes, "class")) }));
  // A link this pattern cannot read (one with markup inside it) fails here, never passes unseen.
  expect(html.match(/<a\b/g) ?? []).toHaveLength(links.length);
  return links;
}
/** The text of every figure drawn as plain text, in order. */
const plainOf = (html: string) => [...html.matchAll(/<span\b[^>]*>([^<]*)<\/span>/g)].map(([, text]) => text);

type LinkProps = { href?: string; onClick?: (event: unknown) => void; children?: ReactNode };
/** Every element under `node` that carries an `href`, in order, whatever draws it: a plain `<a>`
 *  or a component such as next/link's. */
function linkElements(node: ReactNode): ReactElement<LinkProps>[] {
  if (Array.isArray(node)) return node.flatMap(linkElements);
  if (!isValidElement<LinkProps>(node)) return [];
  return [...(typeof node.props.href === "string" ? [node] : []), ...linkElements(node.props.children)];
}
/** A Tailwind class that sets an element's display, behind a variant (`sm:flex`) or not. */
const SETS_DISPLAY = /(^|:)(block|inline-block|inline|flex|inline-flex|grid|inline-grid|contents|flow-root|hidden|table|inline-table|list-item)$/;

describe("the reconciliation strip", () => {
  it("is one group named Order quantities whose text is the four figures joined by the separator", () => {
    const html = render(AGREES);
    const root = /^<div\b([^>]*)>/.exec(html);
    expect(root).not.toBeNull();
    expect(attribute(root![1], "role")).toBe("group");
    expect(attribute(root![1], "aria-label")).toBe("Order quantities");
    expect(html.endsWith("</div>")).toBe(true);
    expect(html.match(/<div\b/g)).toHaveLength(1);
    expect(textOf(html)).toBe("Parts 250 pcs · Container pieces 250 · Loads 250 · Serials not entered");
  });

  it("draws every figure as plain text, with no link at all, when all agree", () => {
    const html = render(AGREES);
    expect(linksOf(html)).toEqual([]);
    expect(plainOf(html)).toEqual(["Parts 250 pcs", "Container pieces 250", "Loads 250", "Serials not entered"]);
  });

  it("draws a figure that differs as an amber link to its section, and Parts as a plain link to Lines", () => {
    const html = render(CONTAINERS_OVER);
    expect(textOf(html)).toBe("Parts 250 pcs · Container pieces 252 · 2 over · Loads 250 · Serials not entered");
    expect(linksOf(html)).toEqual([
      { href: "#lines", text: "Parts 250 pcs", look: "plain" },
      { href: "#containers", text: "Container pieces 252 · 2 over", look: "amber" },
    ]);
    expect(plainOf(html)).toEqual(["Loads 250", "Serials not entered"]);
  });

  it("links each figure that differs to its own section, and a link's whole text is its figure", () => {
    const html = render(ALL_DIFFER);
    expect(linksOf(html)).toEqual([
      { href: "#lines", text: "Parts 250 pcs", look: "plain" },
      { href: "#containers", text: "Container pieces 84 · 166 under · 1 row has no Pieces", look: "amber" },
      { href: "#loads", text: "Loads 120 · 130 under · 1 load has no Qty", look: "amber" },
      { href: "#serials", text: "Serials Line 2: 30 of 32 · 2 under", look: "amber" },
    ]);
    expect(plainOf(html)).toEqual([]);
    expect(textOf(html)).toBe("Parts 250 pcs · Container pieces 84 · 166 under · 1 row has no Pieces"
      + " · Loads 120 · 130 under · 1 load has no Qty · Serials Line 2: 30 of 32 · 2 under");
  });

  it("draws each link as a plain <a>, never through a component such as next/link", () => {
    // No hook and no state: calling the component is rendering it. Static markup cannot hold
    // this: next/link also renders an `<a>`, so every markup case here passes with it.
    const links = linkElements(ReconciliationStrip({ order: ALL_DIFFER, onJump: () => {} }));
    expect(links.map((link) => link.props.href)).toEqual(["#lines", "#containers", "#loads", "#serials"]);
    expect(links.map((link) => link.type)).toEqual(["a", "a", "a", "a"]);
  });

  it("leaves the figures in normal inline flow: no element of the strip sets a display of its own", () => {
    for (const order of [AGREES, CONTAINERS_OVER, ALL_DIFFER, WEIGHED]) {
      const html = render(order);
      const classes = [...html.matchAll(/\bclass="([^"]*)"/g)].flatMap(([, names]) => names.split(" "));
      // The root's own classes are read with the figures'.
      expect(classes).toContain("text-ink-800");
      // The root is a `div` whose children are text, `span` and `a`: left alone they run on as one
      // wrapping line of text, and the spaces round each separator are kept. A flex row or a grid
      // would make each separator a box of its own and drop those spaces.
      expect(classes.filter((name) => SETS_DISPLAY.test(name))).toEqual([]);
    }
  });

  it("hands a click and that link's own section to onJump", () => {
    const jumps: [unknown, StripSection][] = [];
    const tree = ReconciliationStrip({ order: ALL_DIFFER, onJump: (event, section) => { jumps.push([event, section]); } });
    const links = linkElements(tree);
    expect(links.map((link) => link.props.href)).toEqual(["#lines", "#containers", "#loads", "#serials"]);
    const clicks = links.map((_, index) => ({ click: index }));
    links.forEach((link, index) => link.props.onClick?.(clicks[index]));
    expect(jumps).toEqual([[clicks[0], "lines"], [clicks[1], "containers"], [clicks[2], "loads"], [clicks[3], "serials"]]);
  });

  it("holds nothing the page's flows find by role or tag: no paragraph, nav, heading or control", () => {
    for (const order of [AGREES, CONTAINERS_OVER, ALL_DIFFER, WEIGHED]) {
      const html = render(order);
      expect(html).not.toMatch(/<(p|nav|h[1-6]|button|input|select|textarea)\b/);
      // Three flows find the main menu's link by the exact name "Parts".
      expect(linksOf(html).map((link) => link.text)).not.toContain("Parts");
    }
  });
});

describe("the reconciliation strip: the weighed figure", () => {
  // The weights design, §4.5 and §10.2; owner ruling W10 (2026-10-09). Shown only when the saved
  // order has a weighed net: every container row with a scale gross and a tare total.
  const FOUR = "Parts 250 pcs · Container pieces 250 · Loads 250 · Serials not entered";
  /** AGREES with its one row weighed. Its tare total is 127.50 lb and its Net 1,600.00 lb. */
  const weighedAt = (scaleGross: number): StripOrder => ({ ...AGREES, containers: [row(250, scaleGross)] });

  it.each<[string, number, string]>([
    ["over (T1)", 1740, "Net 1,600.00 lb · weighed 1,612.50 lb · 12.50 lb over"],
    ["under (T2)", 1715, "Net 1,600.00 lb · weighed 1,587.50 lb · 12.50 lb under"],
    ["equal to the cent (T3)", 1727.5, "Net 1,600.00 lb · weighed 1,600.00 lb"],
  ])("ends with Net against the weighed net, %s: the last figure, after one separator", (_form, scaleGross, figure) => {
    const html = render(weighedAt(scaleGross));
    expect(textOf(html)).toBe(`${FOUR} · ${figure}`);
    expect(plainOf(html)).toEqual(["Parts 250 pcs", "Container pieces 250", "Loads 250", "Serials not entered", figure]);
  });

  it("draws it as plain text with no class: never amber, never a link, and Parts stays plain text beside it", () => {
    // W10: a scale seldom agrees with a calculated weight to the cent, so 12.50 lb over is not a
    // mismatch. The four piece figures agree here, so nothing on the line is amber or a link.
    const html = render(weighedAt(1740));
    expect(linksOf(html)).toEqual([]);
    expect(html).not.toContain("accent");
    const spans = [...html.matchAll(/<span\b([^>]*)>([^<]*)<\/span>/g)].map(([, attributes, text]) => ({ attributes, text }));
    expect(spans.at(-1)).toEqual({ attributes: "", text: "Net 1,600.00 lb · weighed 1,612.50 lb · 12.50 lb over" });
  });

  it("leaves a piece figure that differs as it was, amber and a link, with the weight after it", () => {
    const html = render(WEIGHED);
    expect(linksOf(html)).toEqual([
      { href: "#lines", text: "Parts 250 pcs", look: "plain" },
      { href: "#containers", text: "Container pieces 252 · 2 over", look: "amber" },
    ]);
    expect(plainOf(html)).toEqual(["Loads 250", "Serials not entered", "Net 1,600.00 lb · weighed 1,612.50 lb · 12.50 lb over"]);
  });

  it("takes an order written whole as an object literal, its line and its row too: order 1004 weighed, by value", () => {
    // `tsc` reads this literal against `StripOrder`, the line and the row as written. It is what
    // holds how that type is spelled: see its docblock. The fixtures above build theirs through
    // `line` and `row`.
    const order: StripOrder = {
      lines: [{ id: "a", position: 1, qty: 250, weight: 1600 }],
      containers: [{ pieces: 252, count: 3, tareEach: 42.5, scaleGross: 1740 }],
      loads: [{ qty: 120 }, { qty: 120 }, { qty: 10 }],
      serials: [],
    };
    expect(order).toEqual(WEIGHED);
    expect(textOf(render(order))).toBe("Parts 250 pcs · Container pieces 252 · 2 over · Loads 250 · Serials not entered"
      + " · Net 1,600.00 lb · weighed 1,612.50 lb · 12.50 lb over");
  });

  it.each<[string, StripOrder, string]>([
    ["a row has no Scale gross", { ...AGREES, containers: [row(125, 1740), row(125)] }, FOUR],
    ["a weighed row has no Tare each", { ...AGREES, containers: [row(250, 1740, null)] }, FOUR],
    ["the order has no container rows", { ...AGREES, containers: [] },
      "Parts 250 pcs · Container pieces not entered · Loads 250 · Serials not entered"],
  ])("shows no weight when %s: the line is the four figures and ends there", (_why, order, text) => {
    expect(textOf(render(order))).toBe(text);
  });
});
