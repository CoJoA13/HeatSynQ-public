import { describe, it, expect } from "vitest";
import { jpegDataUri, pngDataUri, renderSheetGroups } from "@/server/pdf/render";
import {
  TINY_JPEG, alphaPng, danglingSMaskRefs, drawnPages, imageObjectCount, pageCount, paintedImageCounts,
  tinyAlphaPng,
} from "./helpers/pdf";

/**
 * #670 — `renderSheetGroups` renders each sheet group as its own pdfkit document and merges them
 * with pdf-lib, so an image every group places (a template's logo) arrived in the stored file once
 * per group: a 100-load traveler with a 512 KB logo stored 54 MB against 2.1 MB without, and a
 * 20-order ticket set 10.8 MB against 0.43 MB (measured 2026-11-07, `tests/logo-dedupe-measure.test.ts`).
 * The merge now keeps one copy of an image whose bytes, dictionary and mask are the same, and
 * points every page at it. Pure: no database, the house content readers on the merged bytes.
 */

const sheet = (image: string, text: string) => ({
  content: [{ text }, { image, width: 60 }],
});

describe("renderSheetGroups keeps one copy of an image the groups share (#670)", () => {
  it("the same alpha PNG in three groups is one image object with its mask, painted on every page", async () => {
    const logo = pngDataUri(tinyAlphaPng());
    const pdf = await renderSheetGroups([sheet(logo, "one"), sheet(logo, "two"), sheet(logo, "three")]);
    expect(pageCount(pdf)).toBe(3);
    expect(paintedImageCounts(pdf)).toEqual([1, 1, 1]);
    expect(imageObjectCount(pdf)).toBe(1);
    expect(danglingSMaskRefs(pdf)).toBe(0);
    expect(drawnPages(pdf).map((p) => p.trim())).toEqual(["one", "two", "three"]);
  });

  it("the same JPEG in two groups is one image object", async () => {
    const logo = jpegDataUri(TINY_JPEG);
    const pdf = await renderSheetGroups([sheet(logo, "one"), sheet(logo, "two")]);
    expect(paintedImageCounts(pdf)).toEqual([1, 1]);
    expect(imageObjectCount(pdf)).toBe(1);
  });

  it("images that differ stay apart: two pictures, each page painting its own", async () => {
    const pdf = await renderSheetGroups([
      sheet(pngDataUri(alphaPng(2, 2)), "one"), sheet(pngDataUri(alphaPng(3, 3)), "two"),
    ]);
    expect(paintedImageCounts(pdf)).toEqual([1, 1]);
    expect(imageObjectCount(pdf)).toBe(2);
    expect(danglingSMaskRefs(pdf)).toBe(0);
  });

  it("a group that paints the shared picture twice and one that paints it once both keep painting", async () => {
    const logo = pngDataUri(tinyAlphaPng());
    const pdf = await renderSheetGroups([
      { content: [{ text: "twice" }, { image: logo, width: 60 }, { image: logo, width: 30 }] },
      sheet(logo, "once"),
    ]);
    expect(paintedImageCounts(pdf)).toEqual([2, 1]);
    expect(imageObjectCount(pdf)).toBe(1);
  });
});
