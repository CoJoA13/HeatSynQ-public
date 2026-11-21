// The template editor's PDF viewer (owner ruling 2026-11-20): a page-shaped frame as tall as the
// window less a margin, never wider than its column, opened at the viewer's own whole-page fit; and
// the Design tab's live page beside the stage only where the panel holds that frame next to a
// usable stage. The arithmetic is the leaf's, `src/lib/preview-frame.ts`.
import { describe, expect, it } from "vitest";
import {
  DESIGN_INSPECTOR_PX, DESIGN_PALETTE_PX, DESIGN_GAP_PX, MIN_FRAME_HEIGHT, MIN_STAGE_SCALE, PAGE_FIT_FRAGMENT, PANE_CHROME_PX, PX_PER_PT,
  STAGE_FOOT_MARGIN_PX, VIEWER_INSET_PX, VIEWER_TOOLBAR_PX, WINDOW_MARGIN_PX, boundedStageScale, designGrid, liveBeside, pageFrame, stageRoom, viewerSrc,
} from "@/lib/preview-frame";
import { CANVAS_PAGE, canvasPageFor } from "@/lib/template-contracts/canvas";

const LETTER = CANVAS_PAGE;
const TAG = canvasPageFor("CONTAINER_TAG", "4x3-landscape");
/** The zoom the frame was sized for: the page's drawn height over its height in CSS px. */
const zoomOf = (frame: { height: number }, page: { height: number }) =>
  (frame.height - VIEWER_TOOLBAR_PX - 2 * VIEWER_INSET_PX) / (page.height * PX_PER_PT);

describe("viewerSrc", () => {
  it("opens the viewer at its whole-page fit with the thumbnails hidden, in Chrome's words and Firefox's", () => {
    expect(PAGE_FIT_FRAGMENT).toBe("#view=Fit&zoom=page-fit&navpanes=0&pagemode=none");
    expect(viewerSrc("blob:http://localhost:3000/abc")).toBe("blob:http://localhost:3000/abc#view=Fit&zoom=page-fit&navpanes=0&pagemode=none");
  });
});

describe("pageFrame", () => {
  it("is as tall as the window less the margin, and as wide as the page drawn at that height", () => {
    const frame = pageFrame(LETTER, 950);
    expect(frame.height).toBe(950 - WINDOW_MARGIN_PX);
    const zoom = (frame.height - VIEWER_TOOLBAR_PX - 2 * VIEWER_INSET_PX) / (LETTER.height * PX_PER_PT);
    expect(frame.width).toBe(Math.floor(LETTER.width * PX_PER_PT * zoom + 2 * VIEWER_INSET_PX));
    // A Letter page on a 1080p window reads at about 80%, which is legible.
    expect(zoomOf(frame, LETTER)).toBeGreaterThan(0.78);
    expect(zoomOf(frame, LETTER)).toBeLessThan(0.82);
  });
  it("grows with the window: about 115% on a 1440-line window, about 185% on 4K at 100% scaling", () => {
    expect(zoomOf(pageFrame(LETTER, 1310), LETTER)).toBeCloseTo(1.14, 1);
    expect(zoomOf(pageFrame(LETTER, 2030), LETTER)).toBeCloseTo(1.82, 1);
  });
  it("narrows to its column, keeping the page's shape, when the window-tall page is wider than the column", () => {
    const wide = pageFrame(LETTER, 1310);
    const frame = pageFrame(LETTER, 1310, 600);
    expect(wide.width).toBeGreaterThan(600);
    expect(frame.width).toBe(600);
    const zoom = (600 - 2 * VIEWER_INSET_PX) / (LETTER.width * PX_PER_PT);
    expect(frame.height).toBe(Math.floor(LETTER.height * PX_PER_PT * zoom + VIEWER_TOOLBAR_PX + 2 * VIEWER_INSET_PX));
    expect(frame.height).toBeLessThan(wide.height);
  });
  it("leaves a frame that fits its column alone", () => {
    expect(pageFrame(LETTER, 950, 2000)).toEqual(pageFrame(LETTER, 950));
  });
  it("takes the template's own page: a 4 x 3 in tag label is a wide frame", () => {
    const frame = pageFrame(TAG, 950);
    expect(frame.height).toBe(950 - WINDOW_MARGIN_PX);
    expect(frame.width).toBeGreaterThan(frame.height);
  });
  it("keeps a least height on a very short window", () => {
    expect(pageFrame(LETTER, 300).height).toBe(MIN_FRAME_HEIGHT);
  });
});

describe("liveBeside", () => {
  const least = (page: typeof LETTER, frameWidth: number) =>
    DESIGN_PALETTE_PX + DESIGN_INSPECTOR_PX + 3 * DESIGN_GAP_PX + MIN_STAGE_SCALE * page.width + frameWidth + PANE_CHROME_PX;
  it("puts the page beside the stage only where the grid holds the palette, a usable stage, the inspector and the frame", () => {
    const frameWidth = pageFrame(LETTER, 950).width;
    expect(liveBeside(least(LETTER, frameWidth), frameWidth, LETTER)).toBe(true);
    expect(liveBeside(least(LETTER, frameWidth) - 1, frameWidth, LETTER)).toBe(false);
  });
  it("puts it under the stage on a 1080p window, the frame being too wide beside a usable stage", () => {
    // A 1920 x 1080 window leaves the Design grid about 1,300 px.
    expect(liveBeside(1300, pageFrame(LETTER, 950).width, LETTER)).toBe(false);
  });
  it("puts it beside the stage on a 3440 x 1440 window", () => {
    // The rail and the Template status card take about 600 px of 3,440.
    expect(liveBeside(2800, pageFrame(LETTER, 1310).width, LETTER)).toBe(true);
  });
  it("answers under before the grid has been measured", () => {
    expect(liveBeside(0, pageFrame(LETTER, 950).width, LETTER)).toBe(false);
  });
});

describe("designGrid", () => {
  it("beside: a fourth column exactly the frame and its pane wide", () => {
    const grid = designGrid(true, 700);
    expect(grid.style).toEqual({ gridTemplateColumns: `12rem minmax(0,1fr) 16rem ${700 + PANE_CHROME_PX}px` });
    expect(grid.pageClass).toBe("min-w-0");
    expect(grid.capPalette).toBe(false);
  });
  it("under: three columns from lg, the page spanning them, and the palette held to the stage's height", () => {
    const grid = designGrid(false, 700);
    expect(grid.style).toBeUndefined();
    expect(grid.className).toContain("lg:grid-cols-[12rem_minmax(0,1fr)_16rem]");
    expect(grid.pageClass).toBe("min-w-0 lg:col-span-3");
    expect(grid.capPalette).toBe(true);
  });
  it("states the palette and inspector widths the columns use", () => {
    expect(DESIGN_PALETTE_PX).toBe(12 * 16);
    expect(DESIGN_INSPECTOR_PX).toBe(16 * 16);
    expect(DESIGN_GAP_PX).toBe(16);
  });
});

describe("boundedStageScale (owner ruling 2026-11-20, second: bound the stage)", () => {
  it("under the stage, fits the stage into the window height left below its own top", () => {
    // 1920 x 1080: a 993 px window, the stage's column 326 px down the document, a fit of 1.25.
    const room = stageRoom(993, 326);
    expect(room).toBe(993 - 326 - STAGE_FOOT_MARGIN_PX);
    const scale = boundedStageScale(1.25, room, LETTER);
    expect(scale).toBeCloseTo(room / LETTER.height, 6);
    expect(LETTER.height * scale).toBeLessThanOrEqual(room);
  });
  it("never drops below the usable stage the owner ruled (scale 0.65)", () => {
    // The laptop: an 842 px window leaves 500 px, which would be scale 0.63.
    expect(boundedStageScale(0.71, stageRoom(842, 326), LETTER)).toBe(MIN_STAGE_SCALE);
  });
  it("never grows the stage past its column's fit", () => {
    expect(boundedStageScale(0.7, stageRoom(2000, 326), LETTER)).toBe(0.7);
    // A fit already under the floor stays as the column gives it.
    expect(boundedStageScale(0.5, stageRoom(842, 326), LETTER)).toBe(0.5);
  });
  it("leaves the fit alone where there is no bound (the page beside the stage, or not yet measured)", () => {
    expect(boundedStageScale(1.25, null, LETTER)).toBe(1.25);
  });
});
