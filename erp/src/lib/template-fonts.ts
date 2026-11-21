import type { FontFamily } from "@/lib/template-contracts/types";

/**
 * The files the template designer's stage loads as web fonts: the same regular and bold faces the
 * PDF renderer embeds for each family (`FONTS` in `src/server/pdf/render.ts`; Roboto's bold is
 * Medium). Client-safe, so it names files and builds CSS and reads no bytes; the bytes come from
 * `GET /api/templates/fonts/[file]`, which refuses any name not in `FONT_FILE_NAMES` and ignores the
 * `?v=` build version the URLs carry (`FONT_URL_VERSION`).
 * `tests/template-fonts.test.ts` proves the renderer holds every file named here.
 */
export const CANVAS_FONT_FACES: Record<FontFamily, { normal: string; bold: string }> = {
  Roboto: { normal: "Roboto-Regular.ttf", bold: "Roboto-Medium.ttf" },
  "Liberation Sans": { normal: "LiberationSans-Regular.ttf", bold: "LiberationSans-Bold.ttf" },
  "Liberation Serif": { normal: "LiberationSerif-Regular.ttf", bold: "LiberationSerif-Bold.ttf" },
  "Roboto Mono": { normal: "RobotoMono-Regular.ttf", bold: "RobotoMono-Bold.ttf" },
};

/** Every file name `CANVAS_FONT_FACES` holds. */
export const FONT_FILE_NAMES: ReadonlySet<string> = new Set(
  Object.values(CANVAS_FONT_FACES).flatMap((f) => [f.normal, f.bold]),
);

/** The build the page was built by (the nav rail's label, `next.config.ts`), carried by every font
 *  URL as `?v=`: the route answers `private, max-age=31536000, immutable`, so without it a browser
 *  would keep a replaced face until eviction; with it a replaced face takes on the next build. The
 *  route ignores the query. "unknown" in a build with no stamp, where the key never changes. */
export const FONT_URL_VERSION: string = process.env.NEXT_PUBLIC_BUILD_VERSION ?? "unknown";

/** The URL the stage loads one face from, versioned by the build. */
export function fontUrl(file: string, version: string = FONT_URL_VERSION): string {
  return `/api/templates/fonts/${file}?v=${encodeURIComponent(version)}`;
}

const rule = (family: FontFamily, file: string, weight: number, version: string): string =>
  `@font-face { font-family: "${family}"; src: url(${fontUrl(file, version)}) format("truetype"); ` +
  `font-weight: ${weight}; font-style: normal; }`;

/** Two `@font-face` rules (400 and 700) for one family, named as the contract names it. */
export function fontFaceCss(family: FontFamily, version: string = FONT_URL_VERSION): string {
  const faces = CANVAS_FONT_FACES[family];
  return `${rule(family, faces.normal, 400, version)}\n${rule(family, faces.bold, 700, version)}`;
}
