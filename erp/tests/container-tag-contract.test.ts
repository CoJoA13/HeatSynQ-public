import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  CONTAINER_TAG_CANVAS, CONTAINER_TAG_CONTRACT, DEFAULT_CONFIG, TAG_JOIN, assertTagFits, flowTagHeight, orderNumberWidth,
} from "@/lib/template-contracts/container-tag";
import {
  FONT_FAMILIES, TemplateConfigError, validateConfig, type FontFamily, type TemplateConfig,
} from "@/lib/template-contracts/index";
import { TAG_LABEL_SIZES } from "@/lib/template-contracts/canvas";
import { TAG_FONT_METRICS, lineHeightOf, textWidthOf } from "@/lib/tag-font-metrics";
import { previewRecordSpec } from "@/lib/template-editor";
import { CANVAS_RECORD_WORDS } from "@/lib/canvas-designer";
import { optionsFor } from "@/app/admin/templates/[id]/edit/PreviewPane";

/**
 * The container tag's contract (the container tag design of 2026-11-13, §5): its one section and six
 * fields, Order #'s lock (R6), the label rule, the two flow fit rules (R11, the height; R10, the order
 * number's width) and the editor controls it withholds.
 */

const R11 = "The tag's text sizes do not fit one 4 × 3 label; lower the base or heading size.";
const R10 = "The tag's heading size does not fit an order number on one 4 × 3 label; lower the heading size or shorten its label.";
const NO_LOGO = "The Container tag template prints no header logo.";
const NO_PAGE_LINE = "The Container tag template prints no page line.";

function withFonts(fonts: Partial<TemplateConfig["fonts"]>): TemplateConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.fonts = { ...config.fonts, ...fonts };
  return config;
}

function withField(key: string, patch: { visible?: boolean; label?: string | null }): TemplateConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  const field = config.sections[0].fields.find((f) => f.key === key)!;
  Object.assign(field, patch);
  return config;
}

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(TemplateConfigError);
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("the container tag's contract", () => {
  it("has one section, tag, neither hideable nor reorderable, of six fields in the Standard's order", () => {
    expect(CONTAINER_TAG_CONTRACT.docType).toBe("CONTAINER_TAG");
    expect(CONTAINER_TAG_CONTRACT.name).toBe("Container tag");
    expect(CONTAINER_TAG_CONTRACT.sections).toHaveLength(1);
    const [section] = CONTAINER_TAG_CONTRACT.sections;
    expect(section.key).toBe("tag");
    expect(section.name).toBe("Tag");
    expect(section.hideable).toBe(false);
    expect(section.reorderable).toBe(false);
    expect(section.lockReason).toBe("A tag is one stack, and it holds the order number, which cannot be hidden.");
    expect(section.fields.map((f) => [f.key, f.defaultLabel])).toEqual([
      ["order_number", "Order #"],
      ["customer", ""],
      ["po_number", "PO"],
      ["containers_total", "Containers:"],
      ["received", "Received"],
      ["parts", ""],
    ]);
    const [orderNumber, ...rest] = section.fields;
    expect(orderNumber.removable).toBe(false);
    expect(orderNumber.lockReason).toBe("A tag exists to say which work order a container belongs to.");
    for (const field of rest) {
      expect(field.removable, field.key).toBe(true);
      expect(field.column, field.key).toBeUndefined();
    }
  });

  it("declares one format knob, the label size, its fonts, its withheld controls, its canvas profile, and no text block or page line", () => {
    expect(CONTAINER_TAG_CONTRACT.formats).toEqual({ labelSize: "4x3-landscape" });
    expect(CONTAINER_TAG_CONTRACT.fonts).toEqual({ family: "Roboto", baseSize: 10, headingSize: 20, smallSize: 10 });
    expect(CONTAINER_TAG_CONTRACT.withholds).toEqual(["logo", "pageFooter", "smallSize"]);
    expect(CONTAINER_TAG_CONTRACT.textBlocks).toEqual([]);
    expect(CONTAINER_TAG_CONTRACT.canvas).toBe(CONTAINER_TAG_CANVAS);
    expect(CONTAINER_TAG_CONTRACT.tableBudgets).toBeUndefined();
    expect(CONTAINER_TAG_CONTRACT.pageFooter ?? false).toBe(false);
    expect(DEFAULT_CONFIG.pageFooter).toBe(false);
    expect(DEFAULT_CONFIG.logo).toBeNull();
    expect(DEFAULT_CONFIG.layout).toBeNull();
    expect(TAG_LABEL_SIZES).toEqual({ "4x3-landscape": { name: "4 × 3", width: 288, height: 216, margin: 14 } });
  });

  it("validates the Standard as it is, and backfills the label size on a config that leaves it out", () => {
    expect(validateConfig("CONTAINER_TAG", DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
    const config = structuredClone(DEFAULT_CONFIG) as { formats: Record<string, unknown> };
    delete config.formats.labelSize;
    expect(validateConfig("CONTAINER_TAG", config).formats).toEqual({ labelSize: "4x3-landscape" });
    expect(() => validateConfig("CONTAINER_TAG", { ...DEFAULT_CONFIG, formats: { labelSize: "6x4" } })).toThrow(ZodError);
  });

  it("refuses to hide Order # with its lock reason, and lets every other field be hidden", () => {
    expect(refusal(() => validateConfig("CONTAINER_TAG", withField("order_number", { visible: false }))))
      .toBe("\"Order number\" cannot be hidden: A tag exists to say which work order a container belongs to.");
    let config = structuredClone(DEFAULT_CONFIG);
    for (const key of ["customer", "po_number", "containers_total", "received", "parts"]) {
      config.sections[0].fields.find((f) => f.key === key)!.visible = false;
    }
    config = validateConfig("CONTAINER_TAG", config);
    expect(config.sections[0].fields.filter((f) => f.visible).map((f) => f.key)).toEqual(["order_number"]);
  });
});

describe("TAG_JOIN, the label rule", () => {
  it("joins a label ending in # with no space, any other with one, and a blank label not at all", () => {
    expect(TAG_JOIN("Order #", "1234")).toBe("Order #1234");
    expect(TAG_JOIN("PO", "5531")).toBe("PO 5531");
    expect(TAG_JOIN("WO", "1234")).toBe("WO 1234");
    expect(TAG_JOIN("", "ACME")).toBe("ACME");
  });
});

describe("R11: the flow fits one label", () => {
  /** The height worked by hand from the metrics, the brief's own sum, for the Standard's six fields. */
  function byHand(family: FontFamily, base: number, heading: number): number {
    const line = (face: "normal" | "bold" | "italics", size: number) => lineHeightOf(family, face, size);
    return line("bold", heading)
      + 2 + line("bold", base + 2)
      + 4 + line("normal", base)
      + line("normal", base) + line("normal", base)
      + 6 + 6 * line("normal", base) + line("italics", base);
  }

  it("works the Standard out at about 166.4 pt of the label's 188", () => {
    const { height, margin } = TAG_LABEL_SIZES["4x3-landscape"];
    expect(height - 2 * margin).toBe(188);
    expect(Math.abs(flowTagHeight(DEFAULT_CONFIG) - 166.4)).toBeLessThan(0.5);
    expect(flowTagHeight(DEFAULT_CONFIG)).toBeCloseTo(byHand("Roboto", 10, 20), 9);
  });

  it("accepts the Standard's sizes in each of the four families", () => {
    for (const family of FONT_FAMILIES) {
      const config = withFonts({ family });
      expect(flowTagHeight(config), family).toBeCloseTo(byHand(family, 10, 20), 9);
      expect(flowTagHeight(config), family).toBeLessThanOrEqual(188);
      expect(() => assertTagFits(config), family).not.toThrow();
      expect(() => validateConfig("CONTAINER_TAG", config), family).not.toThrow();
    }
  });

  it("refuses a base size of 12 in the R11 sentence, through the registry too", () => {
    const config = withFonts({ baseSize: 12 });
    expect(flowTagHeight(config)).toBeGreaterThan(188);
    expect(orderNumberWidth(config)).toBeLessThanOrEqual(260);
    expect(refusal(() => assertTagFits(config))).toBe(R11);
    expect(refusal(() => validateConfig("CONTAINER_TAG", config))).toBe(R11);
  });

  it("counts only the fields a config shows, in its order: hiding the parts lets a base size of 12 fit", () => {
    const config = withFonts({ baseSize: 12 });
    config.sections[0].fields.find((f) => f.key === "parts")!.visible = false;
    expect(flowTagHeight(config)).toBeLessThanOrEqual(188);
    expect(() => validateConfig("CONTAINER_TAG", config)).not.toThrow();
  });

  it("runs on a flow config alone: a canvas tag's items carry their own sizes", () => {
    // Since PR 3 Task 5 the tag's canvas prints, so a canvas config at a base size R11 refuses on the
    // flow is accepted: its one item, the Order #, carries its own size and fits the label.
    const layout = { version: 1 as const, items: [{
      id: "o", kind: "field" as const, key: "order_number", label: null, style: { size: 20, bold: true, align: "left" as const },
      box: { x: 14, y: 14, w: 260, h: 24 }, anchor: { kind: "page-top" as const }, repeat: false,
    }] };
    const config = { ...withFonts({ baseSize: 12 }), layout };
    expect(() => assertTagFits(config)).toThrow();
    expect(validateConfig("CONTAINER_TAG", config).layout).toEqual(layout);
  });
});

describe("R10: an order number fits the label's width", () => {
  const widestDigit = (family: FontFamily) => {
    const { widths } = TAG_FONT_METRICS[family].bold;
    let best = "0";
    for (let d = 0; d <= 9; d++) if (widths[48 + d - 32] > widths[best.charCodeAt(0) - 32]) best = String(d);
    return best;
  };

  it("measures the effective label joined to seven of the face's widest digit, bold, at the heading size", () => {
    for (const family of FONT_FAMILIES) {
      const config = withFonts({ family });
      const digits = widestDigit(family).repeat(7);
      expect(orderNumberWidth(config), family)
        .toBeCloseTo(textWidthOf(`Order #${digits}`, family, "bold", 20), 9);
      expect(orderNumberWidth(config), family).toBeLessThanOrEqual(260);
    }
    const typed = withField("order_number", { label: "WO" });
    expect(orderNumberWidth(typed)).toBeCloseTo(textWidthOf(`WO ${widestDigit("Roboto").repeat(7)}`, "Roboto", "bold", 20), 9);
    const blank = withField("order_number", { label: "" });
    expect(orderNumberWidth(blank)).toBeCloseTo(textWidthOf(widestDigit("Roboto").repeat(7), "Roboto", "bold", 20), 9);
  });

  // #984: ° is measured at its own advance; a character outside ASCII, Latin-1 and the common
  // punctuation (€) still counts as the face's widest advance over all its glyphs.
  it("measures a label N° at the degree sign's own advance, and N€ by the widest-glyph rule", () => {
    const { widest, extra } = TAG_FONT_METRICS.Roboto.bold;
    const digits = textWidthOf(` ${widestDigit("Roboto").repeat(7)}`, "Roboto", "bold", 20);
    const n = textWidthOf("N", "Roboto", "bold", 20);
    expect(orderNumberWidth(withField("order_number", { label: "N°" }))).toBeCloseTo(n + extra[0xb0] * 20 + digits, 9);
    expect(extra[0xb0]).toBeLessThan(widest);
    expect(orderNumberWidth(withField("order_number", { label: "N€" }))).toBeCloseTo(n + widest * 20 + digits, 9);
  });

  it("refuses a heading size of 48 in Roboto in the R10 sentence (the width is read before the height)", () => {
    const config = withFonts({ headingSize: 48 });
    expect(orderNumberWidth(config)).toBeCloseTo(textWidthOf(`Order #${widestDigit("Roboto").repeat(7)}`, "Roboto", "bold", 48), 9);
    expect(orderNumberWidth(config)).toBeGreaterThan(260);
    expect(refusal(() => assertTagFits(config))).toBe(R10);
    expect(refusal(() => validateConfig("CONTAINER_TAG", config))).toBe(R10);
  });

  it("refuses a heading size of 36 in Roboto, which fits the label's height, in the R10 sentence", () => {
    const config = withFonts({ headingSize: 36 });
    expect(flowTagHeight(config)).toBeLessThanOrEqual(188);
    expect(orderNumberWidth(config)).toBeGreaterThan(260);
    expect(refusal(() => validateConfig("CONTAINER_TAG", config))).toBe(R10);
  });
});

describe("the controls a tag withholds", () => {
  it("refuses a header logo in the withheld-logo sentence", () => {
    const config = { ...DEFAULT_CONFIG, logo: { placement: "header-left" as const, width: 100 } };
    expect(refusal(() => validateConfig("CONTAINER_TAG", config))).toBe(NO_LOGO);
  });

  it("refuses a page line in the page-line sentence", () => {
    expect(refusal(() => validateConfig("CONTAINER_TAG", { ...DEFAULT_CONFIG, pageFooter: true }))).toBe(NO_PAGE_LINE);
  });

  it("withholds nothing from any other type", () => {
    expect(() => validateConfig("QUOTE", {
      ...validateConfig("QUOTE", {}), logo: { placement: "header-left", width: 100 }, pageFooter: true,
    })).not.toThrow();
  });
});

describe("the container tag's editor words (the preview picker and the designer's record)", () => {
  it("picks an order from the orders list, under orders.view, as the tagOrder kind", () => {
    expect(previewRecordSpec("CONTAINER_TAG")).toEqual({
      kind: "tagOrder", listPath: "/api/orders", listPermission: "orders.view", noun: "order",
    });
  });

  it("offers an order's options as the order kind does, voided rows left out", () => {
    const rows = [
      { id: "o1", orderNumber: 92036, customerCode: "ACME", leadPartNumber: "WIDGET-100" },
      { id: "o2", orderNumber: 92037, customerCode: "ACME", leadPartNumber: "WIDGET-200", voided: true },
    ];
    expect(optionsFor("tagOrder", rows)).toEqual(optionsFor("order", rows));
    expect(optionsFor("tagOrder", rows)).toEqual([{ id: "o1", label: "#92036 — ACME — WIDGET-100", recordNumber: "92036" }]);
  });

  it("names the record by its order's first tag", () => {
    const words = CANVAS_RECORD_WORDS.CONTAINER_TAG;
    expect(words.pick).toBe("Pick an order in Preview first");
    expect(words.subject(92036)).toBe("order #92036's first tag");
    expect(words.prints).toBe("for this order");
  });
});
