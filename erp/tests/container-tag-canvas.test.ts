import { describe, it, expect } from "vitest";
import { buildContainerTagCanvas, fitToWidth } from "@/server/pdf/container-tag-canvas";
import { buildContainerTags, type ContainerTagData } from "@/server/pdf/container-tags";
import { renderPdf } from "@/server/pdf/render";
import { DEFAULT_CONFIG } from "@/lib/template-contracts/container-tag";
import type { CanvasItem, CanvasBox, CanvasTextStyle } from "@/lib/template-contracts/canvas";
import type { TemplateConfig } from "@/lib/template-contracts/types";
import {
  TINY_JPEG, pageCount, pageStreams, pageTops, pagesInOrder, paintedImages, parseObjects, runFonts, strokedLines,
} from "./helpers/pdf";
import { printedRuns } from "../e2e/lib/printed-page.mjs";

// Container tag PR 3, Task 4 (the container tag design of 2026-11-13 §7.3, R4, R7, R10): the tag's
// one-page canvas builder. Every case reads the rendered PDF back; the figures pinned are the ones the
// paper carries. A run's x is where pdfkit started it, its y the baseline's distance under the page's
// top (`printedRuns`); a line is the runs sharing one baseline, joined left to right.

const TAG_PAGE_TOP = 216;

function tag(overrides: Partial<ContainerTagData> = {}): ContainerTagData {
  return {
    orderNumber: "1031", customer: "Acme Steel Inc", poNumber: "4500123",
    parts: ["WIDGET-100 × 100", "BRACKET-7 × 20"], containersTotal: "5",
    received: "10/23/2026, 9:02 AM", ...overrides,
  };
}

const style = (size = 10, bold = false, align: CanvasTextStyle["align"] = "left"): CanvasTextStyle => ({ size, bold, align });
const common = (id: string, box: CanvasBox) => ({ id, box, anchor: { kind: "page-top" as const }, repeat: false });
const field = (id: string, key: string, box: CanvasBox, s = style(), label: string | null = null): CanvasItem =>
  ({ ...common(id, box), kind: "field", key, label, style: s });
const text = (id: string, value: string, box: CanvasBox, s = style()): CanvasItem =>
  ({ ...common(id, box), kind: "text", text: value, style: s });
const ORDER = (box: CanvasBox = { x: 14, y: 14, w: 260, h: 24 }, align: CanvasTextStyle["align"] = "left") =>
  field("o", "order_number", box, style(20, true, align));

function configWith(items: CanvasItem[]): TemplateConfig {
  return { ...structuredClone(DEFAULT_CONFIG), layout: { version: 1, items } };
}

type Line = { text: string; x: number; y: number };
/** Each page's printed lines: the runs sharing a baseline, left to right, the line's x its first run's. */
function linesOf(pdf: Buffer): Line[][] {
  const pages = printedRuns(pdf, { pages: pageCount(pdf), what: "the canvas tag" }) as { text: string; x: number; y: number }[][];
  return pages.map((runs) => {
    const byY = new Map<number, { text: string; x: number }[]>();
    for (const run of runs) {
      const key = Math.round(run.y * 100) / 100;
      byY.set(key, [...(byY.get(key) ?? []), { text: run.text, x: run.x }]);
    }
    return [...byY.entries()].sort((a, b) => a[0] - b[0]).map(([y, parts]) => {
      const sorted = parts.sort((a, b) => a.x - b.x);
      return { y, x: sorted[0].x, text: sorted.map((p) => p.text).join("").trimEnd() };
    });
  });
}
const lineOn = (lines: Line[], match: string | RegExp): Line => {
  const hit = lines.find((l) => (typeof match === "string" ? l.text === match : match.test(l.text)));
  if (!hit) throw new Error(`no printed line ${String(match)} among ${JSON.stringify(lines.map((l) => l.text))}`);
  return hit;
};

async function print(items: CanvasItem[], tags: ContainerTagData[] = [tag()], logo?: string) {
  const built = buildContainerTagCanvas(tags, configWith(items), logo);
  const pdf = await renderPdf(built.def);
  return { ...built, pdf, lines: linesOf(pdf) };
}

describe("fitToWidth", () => {
  it("answers the whole text, uncut, when it fits", () => {
    expect(fitToWidth("Acme", "Roboto", "bold", 12, 60)).toEqual({ text: "Acme", cut: false });
  });
  it("answers the longest prefix that fits, with no ellipsis, and says it cut", () => {
    expect(fitToWidth("Acme Heat Treating and Metal Finishing", "Roboto", "bold", 12, 60))
      .toEqual({ text: "Acme Heat", cut: true });
  });
});

describe("buildContainerTagCanvas: pages", () => {
  it("prints one 288 × 216 page per tag, each tag's text at the same place on its own page", async () => {
    const { pdf, lines } = await print([ORDER()], [tag(), tag({ orderNumber: "1032" }), tag({ orderNumber: "1033" })]);
    expect(pageCount(pdf)).toBe(3);
    expect(pageTops(pdf)).toEqual([216, 216, 216]);
    expect(pdf.toString("latin1").match(/\/MediaBox \[0 0 288 216\]/g)).toHaveLength(3);
    const firsts = ["Order #1031", "Order #1032", "Order #1033"].map((t, i) => lineOn(lines[i], t));
    for (const l of firsts) {
      expect(l.x).toBeCloseTo(14, 1);
      expect(l.y).toBeCloseTo(firsts[0].y, 2);
    }
    expect(lines.map((page) => page.length)).toEqual([1, 1, 1]);
  });
});

describe("buildContainerTagCanvas: positions", () => {
  it("prints each field at its box: its left at box.x, its baseline inside the box", async () => {
    const boxes: Record<string, CanvasBox> = {
      po: { x: 30, y: 60, w: 200, h: 12 }, ct: { x: 120, y: 90, w: 150, h: 12 }, rc: { x: 14, y: 150, w: 260, h: 12 },
    };
    const { lines } = await print([
      ORDER(), field("po", "po_number", boxes.po), field("ct", "containers_total", boxes.ct), field("rc", "received", boxes.rc),
    ]);
    for (const [id, want] of [["po", "PO 4500123"], ["ct", "Containers: 5"], ["rc", "Received 10/23/2026, 9:02 AM"]] as const) {
      const l = lineOn(lines[0], want);
      expect(Math.abs(l.x - boxes[id].x)).toBeLessThanOrEqual(0.5);
      expect(l.y).toBeGreaterThan(boxes[id].y);
      expect(l.y).toBeLessThanOrEqual(boxes[id].y + boxes[id].h);
    }
  });
});

describe("buildContainerTagCanvas: R7, a value cut at its box's edge", () => {
  const CUST: CanvasBox = { x: 40, y: 50, w: 60, h: 15 };
  it("prints the longest prefix of a long customer name that ends inside its box, and the measure says cut", async () => {
    const { lines, measure } = await print(
      [ORDER(), field("c", "customer", CUST, style(12, true))], [tag({ customer: "Acme Heat Treating and Metal Finishing" })]);
    const l = lineOn(lines[0], /^Acme/);
    expect(l.text).toBe("Acme Heat");
    expect(l.x).toBeCloseTo(40, 1);
    // "Acme Heat" at 12 pt bold is 59.49 pt by the metrics leaf, which never measures narrower than
    // pdfkit draws: its end, 99.49, is inside the box's right edge, 100 (with the next character, a
    // space, it would be 62.47 wide and pass it).
    expect(l.x + 59.49).toBeLessThanOrEqual(CUST.x + CUST.w);
    expect(measure.items.find((i) => i.id === "c")).toMatchObject({ cut: true });
  });
  it("prints a value that fits whole, and the measure says nothing of a cut", async () => {
    const { lines, measure } = await print([ORDER(), field("c", "customer", CUST, style(12, true))], [tag({ customer: "Acme" })]);
    expect(lineOn(lines[0], /^Acme/).text).toBe("Acme");
    expect(measure.items.find((i) => i.id === "c")).not.toHaveProperty("cut");
  });
  it("cuts a typed text item the same way", async () => {
    const box = { x: 20, y: 120, w: 50, h: 12 };
    const { lines, measure } = await print([ORDER(), text("t", "Handle with care at all times", box)]);
    expect(lineOn(lines[0], /^Handle/).text).toBe("Handle wit");
    expect(measure.items.find((i) => i.id === "t")).toMatchObject({ cut: true });
  });
});

describe("buildContainerTagCanvas: R10, Order # never cut", () => {
  it("prints an order number wider than its box whole from the box's left, and the measure says past", async () => {
    const { lines, measure } = await print([ORDER({ x: 14, y: 14, w: 40, h: 24 })], [tag({ orderNumber: "92036" })]);
    const l = lineOn(lines[0], "Order #92036");
    expect(l.x).toBeCloseTo(14, 1);
    expect(measure.items.find((i) => i.id === "o")).toMatchObject({ past: true });
    expect(measure.items.find((i) => i.id === "o")).not.toHaveProperty("cut");
  });
  it("moves a too-wide order number left so it ends at the label's right margin, never past it", async () => {
    // Started at the box's left (234), "Order #92036" (123.77 pt at 20 bold) would end at 357.77.
    const { lines } = await print([ORDER({ x: 234, y: 14, w: 40, h: 24 })], [tag({ orderNumber: "92036" })]);
    const l = lineOn(lines[0], "Order #92036");
    expect(l.x).toBeCloseTo(150.23, 1);
    expect(l.x + 123.77).toBeLessThanOrEqual(274.01);
  });
  it("never moves an order number left of the label's left margin", async () => {
    // 260.18 pt at 20 bold: wider than the content width, so the shift would start it at 13.82.
    const { lines } = await print([ORDER({ x: 234, y: 14, w: 40, h: 24 })], [tag({ orderNumber: "12345678901234567" })]);
    expect(lineOn(lines[0], "Order #12345678901234567").x).toBeCloseTo(14, 1);
  });
  it("gives a short number in a wide box the box's alignment: right-aligned ends at the box's right edge", async () => {
    const { lines, measure } = await print([ORDER({ x: 14, y: 14, w: 260, h: 24 }, "right")]);
    const l = lineOn(lines[0], "Order #1031");
    // 274 less "Order #1031"'s 112.40 pt.
    expect(l.x).toBeCloseTo(161.6, 1);
    expect(measure.items.find((i) => i.id === "o")).not.toHaveProperty("past");
  });
});

describe("buildContainerTagCanvas: R4, the part lines fill their box", () => {
  // Three lines of Roboto at 10 pt: 3 × 11.71875.
  const PARTS: CanvasBox = { x: 14, y: 100, w: 260, h: 35.157 };
  const five = ["A-1 × 1", "A-2 × 2", "A-3 × 3", "A-4 × 4", "A-5 × 5"];
  it("prints k − 1 parts and an italic more line when the parts outnumber the box's lines", async () => {
    const { lines, measure, pdf } = await print([ORDER(), field("p", "parts", PARTS)], [tag({ parts: five })]);
    const texts = lines[0].map((l) => l.text);
    expect(texts).toEqual(["Order #1031", "A-1 × 1", "A-2 × 2", "and 3 more parts"]);
    expect(measure.items.find((i) => i.id === "p")).toMatchObject({ parts: { shown: 2, total: 5 } });
    const more = runFonts(pdf).filter((r) => r.text.startsWith("and") || r.text.startsWith("more") || r.text.startsWith("parts"));
    expect(more.length).toBeGreaterThan(0);
    for (const r of more) expect(r.font).toBe("Roboto-Italic");
    const tops = lines[0].slice(1).map((l) => l.y);
    expect(tops[1] - tops[0]).toBeCloseTo(11.72, 1);
    expect(tops[2] - tops[1]).toBeCloseTo(11.72, 1);
  });
  it("prints the more line in bold italics on a bold item", async () => {
    const box = { ...PARTS, h: 2 * 14.0625 + 0.001 };
    const { pdf } = await print([ORDER(), field("p", "parts", box, style(12, true))], [tag({ parts: five })]);
    const more = runFonts(pdf).filter((r) => r.text.startsWith("and"));
    expect(more.map((r) => r.font)).toEqual(["Roboto-MediumItalic"]);
  });
  it("holds k lines in a box drawn exactly k lines tall, where the division falls a hair under k", async () => {
    // 3 × 15.826176 (Roboto Mono at 12) divided by 15.826176 is 2.9999999999999996 in floating point.
    const config = configWith([ORDER(), field("p", "parts", { x: 14, y: 100, w: 260, h: 3 * 15.826176 }, style(12))]);
    config.fonts = { ...config.fonts, family: "Roboto Mono" };
    const { def, measure } = buildContainerTagCanvas([tag({ parts: five.slice(0, 3) })], config);
    const pdf = await renderPdf(def);
    expect(linesOf(pdf)[0].map((l) => l.text)).toEqual(["Order #1031", "A-1 × 1", "A-2 × 2", "A-3 × 3"]);
    expect(measure.items.find((i) => i.id === "p")).toMatchObject({ parts: { shown: 3, total: 3 } });
  });
  it("prints every part and no more line when they fit", async () => {
    const { lines, measure } = await print([ORDER(), field("p", "parts", PARTS)], [tag({ parts: five.slice(0, 3) })]);
    expect(lines[0].map((l) => l.text)).toEqual(["Order #1031", "A-1 × 1", "A-2 × 2", "A-3 × 3"]);
    expect(measure.items.find((i) => i.id === "p")).toMatchObject({ parts: { shown: 3, total: 3 } });
  });
  it("prints nothing for an order with no parts, and the measure holds no parts item", async () => {
    const { lines, measure } = await print([ORDER(), field("p", "parts", PARTS)], [tag({ parts: [] })]);
    expect(lines[0].map((l) => l.text)).toEqual(["Order #1031"]);
    expect(measure.items.map((i) => i.id)).toEqual(["o"]);
  });
  it("prints a typed label as the first line, and it takes one of the box's lines", async () => {
    const { lines, measure } = await print(
      [ORDER(), field("p", "parts", PARTS, style(), "Parts:")], [tag({ parts: five })]);
    expect(lines[0].map((l) => l.text)).toEqual(["Order #1031", "Parts:", "A-1 × 1", "and 4 more parts"]);
    expect(measure.items.find((i) => i.id === "p")).toMatchObject({ parts: { shown: 1, total: 5 } });
  });
  // The final review's I2 (R4 outranks call 12 at one line): a box one line tall prints the more
  // line, naming every part, when the parts outnumber it, and the one part when there is one; a
  // typed label takes a line only from two lines up.
  const ONE: CanvasBox = { ...PARTS, h: 11.71875 + 0.001 };
  const TWO: CanvasBox = { ...PARTS, h: 2 * 11.71875 + 0.001 };
  it("at one line with a typed label and more parts than one, prints the more line alone, in italics", async () => {
    const { lines, measure, pdf } = await print(
      [ORDER(), field("p", "parts", ONE, style(), "Parts:")], [tag({ parts: five })]);
    expect(lines[0].map((l) => l.text)).toEqual(["Order #1031", "and 5 more parts"]);
    expect(measure.items.find((i) => i.id === "p")).toMatchObject({ parts: { shown: 0, total: 5 } });
    const more = runFonts(pdf).filter((r) => r.text.startsWith("and"));
    expect(more.map((r) => r.font)).toEqual(["Roboto-Italic"]);
  });
  it("at one line with a typed label and one part, prints that part and no label", async () => {
    const { lines, measure } = await print(
      [ORDER(), field("p", "parts", ONE, style(), "Parts:")], [tag({ parts: ["A-1 × 1"] })]);
    expect(lines[0].map((l) => l.text)).toEqual(["Order #1031", "A-1 × 1"]);
    expect(measure.items.find((i) => i.id === "p")).toMatchObject({ parts: { shown: 1, total: 1 } });
  });
  it("at two lines with a typed label, prints the label first and the more line under it", async () => {
    const { lines, measure } = await print(
      [ORDER(), field("p", "parts", TWO, style(), "Parts:")], [tag({ parts: five })]);
    expect(lines[0].map((l) => l.text)).toEqual(["Order #1031", "Parts:", "and 5 more parts"]);
    expect(measure.items.find((i) => i.id === "p")).toMatchObject({ parts: { shown: 0, total: 5 } });
  });
});

describe("buildContainerTagCanvas: the measure", () => {
  it("holds one entry per printed item at its drawn box, on page 1, with no tables or regions", async () => {
    const items: CanvasItem[] = [
      ORDER(), field("c", "customer", { x: 14, y: 40, w: 260, h: 15 }, style(12, true)),
      { ...common("ln", { x: 14, y: 60, w: 260, h: 0 }), kind: "line", weight: 1 },
      { ...common("lg", { x: 200, y: 150, w: 60, h: 40 }), kind: "logo" },
    ];
    const { measure } = buildContainerTagCanvas([tag(), tag()], configWith(items));
    expect(measure).toEqual({
      pages: 1, tables: [], regions: [],
      items: [
        { id: "o", page: 1, left: 14, top: 14, height: 24 },
        { id: "c", page: 1, left: 14, top: 40, height: 15 },
        { id: "ln", page: 1, left: 14, top: 60, height: 0 },
      ],
    });
  });
});

describe("buildContainerTagCanvas: line, box and logo", () => {
  it("strokes a line and a box at their boxes", async () => {
    const { pdf } = await print([
      ORDER(),
      { ...common("ln", { x: 14, y: 60, w: 260, h: 0 }), kind: "line", weight: 1 },
      { ...common("bx", { x: 20, y: 80, w: 100, h: 50 }), kind: "box", weight: 2 },
    ]);
    expect(strokedLines(pdf)[0]).toContainEqual({ x1: 14, y1: 60, x2: 274, y2: 60, width: 1 });
    expect(pageStreams(pdf)[0]).toMatch(/\b2 w\s+\[\] 0 d\s+0 j\s+0 J\s+20 80 100 50 re\s+\/DeviceRGB CS\s+0 0 0 SCN\s+\/Gs\d+ gs\s+S\b/);
  });
  it("prints a Logo item's bytes fitted to its box, and nothing without them", async () => {
    const logo = { ...common("lg", { x: 200, y: 150, w: 60, h: 40 }), kind: "logo" as const };
    const uri = `data:image/jpeg;base64,${TINY_JPEG.toString("base64")}`;
    const withBytes = await print([ORDER(), logo], [tag()], uri);
    expect(paintedImages(withBytes.pdf)[0]).toEqual([{ x: 200, y: 150, w: 40, h: 40 }]);
    expect(withBytes.measure.items.map((i) => i.id)).toEqual(["o", "lg"]);
    const without = await print([ORDER(), logo]);
    expect(paintedImages(without.pdf)[0]).toEqual([]);
    expect(without.measure.items.map((i) => i.id)).toEqual(["o"]);
  });
});

describe("buildContainerTagCanvas: marks and the definition", () => {
  it("puts one hidden mark per printed item on every tag, filled at opacity 0", async () => {
    const { pdf } = await print(
      [ORDER(), field("c", "customer", { x: 14, y: 40, w: 260, h: 15 })], [tag(), tag()]);
    // Each mark: a 0 × 0 rect at its item's box, filled under a graphics state whose fill opacity is 0.
    const objs = parseObjects(pdf);
    const pages = pagesInOrder(objs);
    pageStreams(pdf).forEach((stream, index) => {
      const resRef = /\/Resources\s+(\d+)\s+0\s+R/.exec(pages[index].body);
      const resources = resRef ? (objs.get(Number(resRef[1]))?.body ?? "") : pages[index].body;
      const states = /\/ExtGState\s*<<([\s\S]*?)>>/.exec(resources)?.[1] ?? "";
      const opacity = (name: string) => {
        const ref = new RegExp(`/${name}\\s+(\\d+)\\s+0\\s+R`).exec(states);
        return ref ? /\/ca\s+([\d.]+)/.exec(objs.get(Number(ref[1]))?.body ?? "")?.[1] : undefined;
      };
      const marks = [...stream.matchAll(/([\d.]+) ([\d.]+) 0 0 re\s+\/DeviceRGB cs\s+0 0 0 scn\s+\/(Gs\d+) gs\s+f\b/g)];
      expect(marks.map((m) => [Number(m[1]), Number(m[2]), opacity(m[3])])).toEqual([[14, 14, "0"], [14, 40, "0"]]);
    });
  });
  it("carries no pageOrientation, footer or unbreakable, its ids on canvas nodes alone", () => {
    const { def } = buildContainerTagCanvas([tag(), tag()], configWith([
      ORDER(), field("p", "parts", { x: 14, y: 100, w: 260, h: 40 }), text("t", "Hi", { x: 14, y: 150, w: 100, h: 12 }),
    ]));
    expect(def).not.toHaveProperty("pageOrientation");
    expect(def).not.toHaveProperty("footer");
    expect(def.pageMargins).toEqual([0, 0, 0, 0]);
    expect(JSON.stringify(def)).not.toContain("unbreakable");
    const ids: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node || typeof node !== "object") return;
      const o = node as Record<string, unknown>;
      if (typeof o.id === "string") {
        expect(o).not.toHaveProperty("text");
        expect(o).toHaveProperty("canvas");
        ids.push(o.id);
      }
      Object.values(o).forEach(walk);
    };
    walk(def.content);
    expect(ids).toEqual(["canvas:item:o", "canvas:item:p", "canvas:item:t", "canvas:item:o", "canvas:item:p", "canvas:item:t"]);
  });
});

describe("buildContainerTags branches on the layout", () => {
  it("prints the canvas when the config holds a layout, and the flow when it holds none", async () => {
    const canvas = await renderPdf(buildContainerTags([tag()], configWith([ORDER({ x: 100, y: 100, w: 174, h: 24 })])));
    const l = lineOn(linesOf(canvas)[0], "Order #1031");
    expect(l.x).toBeCloseTo(100, 1);
    expect(linesOf(canvas)[0]).toHaveLength(1);
    const flow = await renderPdf(buildContainerTags([tag()], DEFAULT_CONFIG));
    expect(linesOf(flow)[0].map((x) => x.text)).toContain("PO 4500123");
    expect(TAG_PAGE_TOP).toBe(pageTops(flow)[0]);
  });
});
