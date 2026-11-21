// fontkit 2.0.4 (a transitive dependency of pdfkit) ships no types. Only the metrics generator
// (scripts/gen-tag-font-metrics.ts) and its test open a font with it; no app code does.
declare module "fontkit" {
  export interface Glyph {
    advanceWidth: number;
  }
  export interface Font {
    unitsPerEm: number;
    ascent: number;
    descent: number;
    glyphForCodePoint(codePoint: number): Glyph;
  }
  export function create(bytes: Buffer): Font;
}
