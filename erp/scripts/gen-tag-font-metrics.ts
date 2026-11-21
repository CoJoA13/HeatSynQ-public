// Regenerates the table in src/lib/tag-font-metrics.ts from the vendored fonts' own metrics.
// Run: npx tsx scripts/gen-tag-font-metrics.ts
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Up to the next 6th decimal: a figure never under the advance it stands for. */
const ceil6 = (n: number): number => Math.ceil(Math.round(n * 1e9) / 1e3) / 1e6;

type FaceTable = {
  lineHeight: number; widest: number; widths: number[]; extra: Record<number, number>; pairs: Record<string, number>;
};

/** The code points measured exactly beyond 32..126 (#984): Latin-1's printable half, 160..255 (× among
 *  them), and the punctuation the app prints: en and em dash, the four curly quotes, bullet, ellipsis. */
export const EXTRA_CODE_POINTS: readonly number[] = [
  ...Array.from({ length: 96 }, (_, i) => 160 + i),
  0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2026,
];

/** pdfmake's line height per 1 pt; the advance width per 1 pt of each code point 32..126; `extra`,
 *  per 1 pt and rounded UP, each of `EXTRA_CODE_POINTS`' width as fontkit lays it out alone (as pdfkit
 *  draws it, fontkit's default features on) or its glyph's advance, whichever is wider, plus its
 *  kerning allowance: its largest positive kern as
 *  the left character of a pair and as the right, against every code point in 32..126 and in
 *  `EXTRA_CODE_POINTS`, so a pair holding one is never measured under its kerned layout (#984 and its
 *  review); and `widest`, the widest advance per 1 pt
 *  over every glyph the font maps (its cmap) and its .notdef (what an unmapped character draws),
 *  rounded UP, which `textWidthOf` counts for any other character (the container tag PR 3 final
 *  review's I3); and `pairs`, per 1 pt and rounded UP, keyed by the two characters, every ASCII pair
 *  (32..126 x 32..126) that fontkit lays out wider than its two glyphs' advances, by that excess: its
 *  kern, counted exactly where the pair appears (#986, owner ruling 2026-11-15). A pair that kerns
 *  narrower is left out, so a measure is never narrower than the paper; a pair holding an `extra`
 *  character is covered by that character's allowance and is not listed. */
export function faceMetrics(bytes: Buffer): FaceTable {
  const font = fontkit.create(bytes) as unknown as {
    unitsPerEm: number; ascent: number; descent: number; characterSet: number[];
    glyphForCodePoint(cp: number): { advanceWidth: number }; getGlyph(id: number): { advanceWidth: number };
    layout(text: string): { advanceWidth: number };
  };
  const widths: number[] = [];
  for (let cp = 32; cp <= 126; cp++) {
    widths.push(round6(font.glyphForCodePoint(cp).advanceWidth / font.unitsPerEm));
  }
  const alone = (cp: number): number => font.layout(String.fromCodePoint(cp)).advanceWidth;
  const measured = [...Array.from({ length: 95 }, (_, i) => 32 + i), ...EXTRA_CODE_POINTS];
  const width = new Map(measured.map((cp) => [cp, alone(cp)]));
  const extra: Record<number, number> = {};
  for (const cp of EXTRA_CODE_POINTS) {
    let left = 0;
    let right = 0;
    for (const other of measured) {
      left = Math.max(left, font.layout(String.fromCodePoint(cp, other)).advanceWidth - width.get(cp)! - width.get(other)!);
      right = Math.max(right, font.layout(String.fromCodePoint(other, cp)).advanceWidth - width.get(other)! - width.get(cp)!);
    }
    // never under the glyph's own advance either: the soft hyphen (U+00AD) lays out at 0 alone.
    const base = Math.max(width.get(cp)!, font.glyphForCodePoint(cp).advanceWidth);
    extra[cp] = ceil6((base + left + right) / font.unitsPerEm);
  }
  const pairs: Record<string, number> = {};
  for (let a = 32; a <= 126; a++) {
    for (let b = 32; b <= 126; b++) {
      const excess = font.layout(String.fromCodePoint(a, b)).advanceWidth -
        font.glyphForCodePoint(a).advanceWidth - font.glyphForCodePoint(b).advanceWidth;
      if (excess > 0) pairs[String.fromCodePoint(a, b)] = ceil6(excess / font.unitsPerEm);
    }
  }
  let widest = font.getGlyph(0).advanceWidth;
  for (const cp of font.characterSet) widest = Math.max(widest, font.glyphForCodePoint(cp).advanceWidth);
  return {
    lineHeight: round6((font.ascent - font.descent) / font.unitsPerEm),
    widest: ceil6(widest / font.unitsPerEm),
    widths,
    extra,
    pairs,
  };
}

const BEGIN = "// BEGIN GENERATED TABLE";
const END = "// END GENERATED TABLE";

export async function renderTable(): Promise<string> {
  // render.ts reaches the database module at load; the generator reads only font files, never the
  // database, so a placeholder URL satisfies that module's presence check.
  process.env.DATABASE_URL ??= "postgresql://unused@localhost:5432/unused";
  const { fontBytes, PDF_FONT_FACES } = await import("../src/server/pdf/render");
  const out: Record<string, Record<string, FaceTable>> = {};
  for (const [family, faces] of Object.entries(PDF_FONT_FACES)) {
    out[family] = {};
    for (const [face, file] of Object.entries(faces)) {
      const bytes = fontBytes(file);
      if (bytes === null) throw new Error(`no bytes for ${file}`);
      out[family][face] = faceMetrics(bytes);
    }
  }
  const lines = ["export const TAG_FONT_METRICS: Record<FontFamily, Record<Face, FaceMetrics>> = {"];
  for (const [family, faces] of Object.entries(out)) {
    lines.push(`  ${JSON.stringify(family)}: {`);
    for (const [face, m] of Object.entries(faces)) {
      lines.push(`    ${face}: {`, `      lineHeight: ${m.lineHeight},`, `      widest: ${m.widest},`,
        `      widths: [${m.widths.join(", ")}],`,
        `      extra: { ${Object.entries(m.extra).map(([cp, w]) => `${cp}: ${w}`).join(", ")} },`,
        // a key may be a quote or a backslash, so each is written as a JSON string.
        `      pairs: {${Object.entries(m.pairs).map(([k, w]) => ` ${JSON.stringify(k)}: ${w}`).join(",")} },`, "    },");
    }
    lines.push("  },");
  }
  lines.push("};");
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}

async function main(): Promise<void> {
  const target = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/lib/tag-font-metrics.ts");
  const src = readFileSync(target, "utf8");
  const a = src.indexOf(BEGIN);
  const b = src.indexOf(END);
  if (a < 0 || b < a) throw new Error("table markers missing");
  writeFileSync(target, `${src.slice(0, a + BEGIN.length)}\n${await renderTable()}\n${src.slice(b)}`);
  console.log(`wrote ${target}`);
}
