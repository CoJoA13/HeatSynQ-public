// The template editor's PDF viewer (owner ruling 2026-11-20): the Preview tab and the Design tab's
// live page show the rendered PDF in the browser's own viewer, in a frame shaped like the template's
// page and as tall as the window less a margin, never wider than its column, opened at the viewer's
// own whole-page fit. A Letter page then reads at about 80% on a 1080p window, about 115% on a
// 1440-line one and about 185% on 4K at 100% scaling; a 600 px frame had shown half a page at 100%,
// or the whole page at about 50%.
//
// The fit is the viewer's own, asked for in the URL fragment in both viewers' words: Chrome's
// `view=Fit` and `navpanes=0`, Firefox's `zoom=page-fit` and `pagemode=none`; each ignores the
// other's. Both keep their fit when the frame is resized, so nothing reloads on a window resize.
// The frame's width is worked out here from the page at the frame's height, so the fitted page fills
// it; the toolbar and inset are Chrome's (Firefox's toolbar is shorter, so its page is never cut).
//
// The Design tab's live page sits beside the stage only where the Design grid holds the palette, a
// usable stage, the inspector and that frame (`liveBeside`); below that it spans under the stage,
// and the palette scrolls within the stage's height so the page is not pushed below the palette's
// long list (`designGrid`). Pure, client-safe: no React, no DOM.
import type { CanvasPage } from "@/lib/template-contracts/canvas";

/** CSS pixels per point: a browser's 100% is 96 px to the inch. */
export const PX_PER_PT = 96 / 72;
/** Chrome's PDF toolbar, in CSS px. */
export const VIEWER_TOOLBAR_PX = 56;
/** The space the viewer keeps on each side of a fitted page. */
export const VIEWER_INSET_PX = 8;
/** What the frame leaves of the window's height, so it shows whole once scrolled to. */
export const WINDOW_MARGIN_PX = 32;
/** The least frame height, for a very short window. */
export const MIN_FRAME_HEIGHT = 480;
/** The fragment that opens the viewer at its whole-page fit with its thumbnails hidden. */
export const PAGE_FIT_FRAGMENT = "#view=Fit&zoom=page-fit&navpanes=0&pagemode=none";

/** The Design grid's fixed columns (12rem and 16rem) and its gap (`gap-4`), in px. */
export const DESIGN_PALETTE_PX = 192;
export const DESIGN_INSPECTOR_PX = 256;
export const DESIGN_GAP_PX = 16;
/** The least stage scale the live page may leave beside it: about 400 px for Letter, the stage the
 *  four-column layout was first sized for (ruling C28 of the traveler canvas lane). */
export const MIN_STAGE_SCALE = 0.65;
/** The preview pane around the frame: its padding (`p-3`, both sides) and its border. */
export const PANE_CHROME_PX = 26;

/** The PDF's URL with the whole-page fit asked for. */
export function viewerSrc(url: string): string {
  return url + PAGE_FIT_FRAGMENT;
}

/** The frame for `page`: as tall as `windowHeight` less the margin (never under the least height),
 *  as wide as the page drawn at that height, and, where that is wider than `maxWidth`, as wide as
 *  `maxWidth` and as tall as the page drawn at that width. */
export function pageFrame(page: Pick<CanvasPage, "width" | "height">, windowHeight: number, maxWidth = Infinity): { width: number; height: number } {
  const pageW = page.width * PX_PER_PT;
  const pageH = page.height * PX_PER_PT;
  const height = Math.max(MIN_FRAME_HEIGHT, windowHeight - WINDOW_MARGIN_PX);
  const zoom = (height - VIEWER_TOOLBAR_PX - 2 * VIEWER_INSET_PX) / pageH;
  const width = pageW * zoom + 2 * VIEWER_INSET_PX;
  if (width <= maxWidth) return { width: Math.floor(width), height };
  const narrowed = (maxWidth - 2 * VIEWER_INSET_PX) / pageW;
  return { width: Math.floor(maxWidth), height: Math.floor(pageH * narrowed + VIEWER_TOOLBAR_PX + 2 * VIEWER_INSET_PX) };
}

/** Whether the Design grid, `gridWidth` px wide, holds the live page's frame beside the palette, a
 *  stage at `MIN_STAGE_SCALE` and the inspector. */
export function liveBeside(gridWidth: number, frameWidth: number, page: Pick<CanvasPage, "width">): boolean {
  const least = DESIGN_PALETTE_PX + DESIGN_INSPECTOR_PX + 3 * DESIGN_GAP_PX + MIN_STAGE_SCALE * page.width + frameWidth + PANE_CHROME_PX;
  return gridWidth >= least;
}

/** The Design grid's columns: beside, a fourth column exactly the frame and its pane wide; under,
 *  three columns from `lg`, the page spanning them and the palette held to the stage's height. */
export function designGrid(beside: boolean, frameWidth: number): {
  className: string; style: { gridTemplateColumns: string } | undefined; pageClass: string; capPalette: boolean;
} {
  if (beside) {
    return {
      className: "mt-2 grid gap-4",
      style: { gridTemplateColumns: `12rem minmax(0,1fr) 16rem ${frameWidth + PANE_CHROME_PX}px` },
      pageClass: "min-w-0",
      capPalette: false,
    };
  }
  return { className: "mt-2 grid gap-4 lg:grid-cols-[12rem_minmax(0,1fr)_16rem]", style: undefined, pageClass: "min-w-0 lg:col-span-3", capPalette: true };
}

/** What the stage leaves below itself when it is bounded to the window. */
export const STAGE_FOOT_MARGIN_PX = 16;

/** The height, in CSS px, a window `windowHeight` tall leaves below a stage whose column starts
 *  `columnTop` px down the document, less the foot margin: the whole stage shows as the tab opens. */
export function stageRoom(windowHeight: number, columnTop: number): number {
  return windowHeight - columnTop - STAGE_FOOT_MARGIN_PX;
}

/** The stage's scale under its column's `fit`, bounded (owner ruling 2026-11-20, second) so the page
 *  fits `room` px when the live page is under the stage, never below `MIN_STAGE_SCALE` (the usable
 *  stage) and never above the fit; null `room` (the page beside the stage, or nothing measured yet)
 *  leaves the fit alone. */
export function boundedStageScale(fit: number, room: number | null, page: Pick<CanvasPage, "height">): number {
  if (room === null) return fit;
  return Math.min(fit, Math.max(MIN_STAGE_SCALE, room / page.height));
}
