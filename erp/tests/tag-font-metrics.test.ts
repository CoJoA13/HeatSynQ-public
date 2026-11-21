import { describe, it, expect } from "vitest";
import { fontBytes, layOutSheetGroups, PDF_FONT_FACES, type RenderableDefinition } from "@/server/pdf/render";
import { FONT_FAMILIES, type FontFamily } from "@/lib/template-contracts/types";
import { TAG_FONT_METRICS, lineHeightOf, textWidthOf, type Face } from "@/lib/tag-font-metrics";
import { faceMetrics } from "../scripts/gen-tag-font-metrics";
import * as fontkit from "fontkit";

const FACES: Face[] = ["normal", "bold", "italics", "bolditalics"];

describe("tag font metrics", () => {
  it("the table is the vendored fonts' own metrics", { timeout: 120_000 }, () => {
    // each face is re-measured by the generator's own reader from the same vendored bytes.
    expect(Object.keys(TAG_FONT_METRICS).sort()).toEqual([...FONT_FAMILIES].sort());
    for (const family of FONT_FAMILIES) {
      for (const face of FACES) {
        const bytes = fontBytes(PDF_FONT_FACES[family][face]);
        expect(bytes, `${family} ${face}`).not.toBeNull();
        const metrics = faceMetrics(bytes!);
        expect(metrics.widths).toHaveLength(95);
        expect(Object.keys(metrics.extra)).toHaveLength(104);
        // #986: Roboto's four faces each kern 59 ASCII pairs wider than their advances; the other
        // families none.
        expect(Object.keys(metrics.pairs), `${family} ${face}`).toHaveLength(family === "Roboto" ? 59 : 0);
        expect(TAG_FONT_METRICS[family][face], `${family} ${face}`).toEqual(metrics);
      }
    }
  });

  it("lineHeightOf matches pdfmake's layout", async () => {
    for (const family of FONT_FAMILIES) {
      for (const face of FACES) {
        for (const size of [10, 20]) {
          const node = (id: string) => ({
            id,
            stack: [{
              text: "Hg", fontSize: size, font: family,
              ...(face === "bold" || face === "bolditalics" ? { bold: true } : {}),
              ...(face === "italics" || face === "bolditalics" ? { italics: true } : {}),
            }],
          });
          const def: RenderableDefinition = {
            pageSize: "LETTER", pageMargins: [36, 36, 36, 36], content: [node("a"), node("b")],
          };
          const [laid] = await layOutSheetGroups([def]);
          const top = (id: string) => laid.find((n) => n.id === id)!.top;
          expect(
            Math.abs(top("b") - top("a") - lineHeightOf(family as FontFamily, face, size)),
            `${family} ${face} ${size}`,
          ).toBeLessThan(0.01);
        }
      }
    }
  });

  // The final review's I3: a character outside 32..126 counts as the face's widest advance over every
  // glyph the font maps (its cmap) and its .notdef, so `textWidthOf` is never narrower than that
  // character's own advance (#984 measures Latin-1 and the common punctuation exactly, and #986 the
  // ASCII pairs that kern wider). Each face is read here from the vendored bytes by fontkit itself, not
  // through the generator.
  const advances = (family: FontFamily, face: Face) => {
    const font = fontkit.create(fontBytes(PDF_FONT_FACES[family][face])!) as unknown as {
      unitsPerEm: number; characterSet: number[];
      glyphForCodePoint(cp: number): { advanceWidth: number }; getGlyph(id: number): { advanceWidth: number };
    };
    return { font, em: (a: number) => a / font.unitsPerEm };
  };

  // #984: Latin-1's printable half and the punctuation the app prints are measured exactly, each at
  // its own glyph's advance (the .notdef's where the face maps none), rounded up. Restated here, not
  // read from the generator, so the set is pinned.
  const EXACT = [
    ...Array.from({ length: 96 }, (_, i) => 160 + i),
    0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2026,
  ];

  it("a character outside 32..126 and the exact set counts as the face's widest glyph", () => {
    for (const family of FONT_FAMILIES) {
      for (const face of FACES) {
        const { widest } = TAG_FONT_METRICS[family][face];
        // € (U+20AC) is in neither set.
        expect(textWidthOf("N€", family, face, 12)).toBeCloseTo(
          textWidthOf("N", family, face, 12) + widest * 12, 9,
        );
      }
    }
  });

  it("measures Latin-1 and the common punctuation at least at each glyph's own advance, and well under the widest", () => {
    for (const family of FONT_FAMILIES) {
      for (const face of FACES) {
        const { font, em } = advances(family, face);
        for (const cp of EXACT) {
          const real = em(font.glyphForCodePoint(cp).advanceWidth);
          const measured = textWidthOf(String.fromCodePoint(cp), family, face, 1);
          expect(measured, `${family} ${face} U+${cp.toString(16)}`).toBeGreaterThanOrEqual(real);
          // the kerning allowance (below) is a fraction of an em, never the widest-glyph slack.
          expect(measured - real, `${family} ${face} U+${cp.toString(16)}`).toBeLessThan(0.15);
        }
      }
    }
  });

  // pdfkit draws a run as fontkit lays it out (its default features, kerning among them), so a
  // measured width must not be under that layout's advance for text that mixes the exact characters.
  it("is never under the width pdfkit lays out for text with the exact characters", () => {
    const samples = [
      "WIDGET-100 × 100", "N° 5", "“Acme” ‘Heat’", "A—B – C", "• Item…", "Ça côte 12½",
      "AV×To—Ty", "×××××", "“A” “V” “T”", "Miller’s", "f’", "’h",
    ];
    for (const family of FONT_FAMILIES) {
      for (const face of FACES) {
        const { font } = advances(family, face);
        const layout = font as unknown as { layout(text: string): { advanceWidth: number } };
        for (const text of samples) {
          const drawn = layout.layout(text).advanceWidth / font.unitsPerEm;
          // the ASCII widths are rounded to the nearest 6th decimal, within 5e-7 a character.
          expect(textWidthOf(text, family, face, 1) + 5e-7 * [...text].length, `${family} ${face} ${text}`)
            .toBeGreaterThanOrEqual(drawn);
        }
      }
    }
  });

  it("widest is the face's widest advance over every mapped glyph and .notdef, rounded up", () => {
    for (const family of FONT_FAMILIES) {
      for (const face of FACES) {
        const { font, em } = advances(family, face);
        let max = em(font.getGlyph(0).advanceWidth);
        for (const cp of font.characterSet) max = Math.max(max, em(font.glyphForCodePoint(cp).advanceWidth));
        const { widest } = TAG_FONT_METRICS[family][face];
        expect(widest, `${family} ${face}`).toBeGreaterThanOrEqual(max);
        expect(widest - max, `${family} ${face}`).toBeLessThan(1e-6);
      }
    }
  });

  it("measures every character at least as wide as its glyph's own advance: Æ, the em dash and every mapped one", () => {
    for (const family of FONT_FAMILIES) {
      for (const face of FACES) {
        const { font, em } = advances(family, face);
        for (const ch of ["Æ", "—"]) {
          expect(textWidthOf(ch, family, face, 1), `${family} ${face} ${ch}`)
            .toBeGreaterThanOrEqual(em(font.glyphForCodePoint(ch.codePointAt(0)!).advanceWidth));
        }
        // An unmapped code point draws .notdef.
        expect(textWidthOf("\u{10FFFD}", family, face, 1)).toBeGreaterThanOrEqual(em(font.getGlyph(0).advanceWidth));
        for (const cp of font.characterSet) {
          const real = em(font.glyphForCodePoint(cp).advanceWidth);
          const measured = textWidthOf(String.fromCodePoint(cp), family, face, 1);
          // The ASCII widths are rounded to the nearest 6th decimal (within 5e-7 of the advance);
          // every other character's width is rounded up.
          expect(measured + 5e-7, `${family} ${face} U+${cp.toString(16)}`).toBeGreaterThanOrEqual(real);
        }
      }
    }
  });

  // The container tag #984 review: a bare advance under-measures a pair pdfkit kerns apart (Liberation
  // Sans `r’`, Liberation Serif italics `f’`, Roboto `’h`), so each exact character carries its largest
  // positive kern, on either side, against every character measured exactly. Every pair holding one is
  // laid out here as pdfkit lays it out (fontkit's default features), in every face.
  it("is never under pdfkit's kerned layout for any pair holding an exact character", () => {
    const measured = [...Array.from({ length: 95 }, (_, i) => 32 + i), ...EXACT];
    const exact = new Set(EXACT);
    for (const family of FONT_FAMILIES) {
      for (const face of FACES) {
        const { font } = advances(family, face);
        const layout = font as unknown as { layout(text: string): { advanceWidth: number } };
        for (const a of measured) {
          for (const b of measured) {
            if (!exact.has(a) && !exact.has(b)) continue;
            const text = String.fromCodePoint(a, b);
            const drawn = layout.layout(text).advanceWidth / font.unitsPerEm;
            // an ASCII width is rounded to the nearest 6th decimal, within 5e-7.
            expect(textWidthOf(text, family, face, 1) + 1e-6, `${family} ${face} U+${a.toString(16)} U+${b.toString(16)}`)
              .toBeGreaterThanOrEqual(drawn);
          }
        }
      }
    }
  }, 120_000);

  // #986 (owner ruling 2026-11-15, a pair table): an ASCII pair that pdfkit kerns wider than its two
  // advances (Roboto's `rt`, by 50 units of 2048) counts its kern exactly, wherever it appears, and only
  // there. Every ASCII pair, 32..126 x 32..126, is laid out here as pdfkit lays it out, in every face.
  it("measures every ASCII pair at least at pdfkit's kerned layout, and exactly where it kerns wider", () => {
    for (const family of FONT_FAMILIES) {
      for (const face of FACES) {
        const { font, em } = advances(family, face);
        const layout = font as unknown as { layout(text: string): { advanceWidth: number } };
        for (let a = 32; a <= 126; a++) {
          for (let b = 32; b <= 126; b++) {
            const text = String.fromCodePoint(a, b);
            const drawn = em(layout.layout(text).advanceWidth);
            const bare = em(font.glyphForCodePoint(a).advanceWidth + font.glyphForCodePoint(b).advanceWidth);
            const measured = textWidthOf(text, family, face, 1);
            // each ASCII width is rounded to the nearest 6th decimal, within 5e-7; a pair's kern up.
            expect(measured + 1e-6, `${family} ${face} ${JSON.stringify(text)}`).toBeGreaterThanOrEqual(drawn);
            // a pair that kerns narrower, or not at all, counts its two advances alone; one that kerns
            // wider counts its kern, rounded up within 1e-6, and nothing more.
            expect(Math.abs(measured - Math.max(drawn, bare)), `${family} ${face} ${JSON.stringify(text)}`)
              .toBeLessThan(2e-6);
          }
        }
      }
    }
  }, 120_000);

  it("holds no pair across a space, and counts a pair only between two ASCII characters", () => {
    for (const family of FONT_FAMILIES) {
      for (const face of FACES) {
        expect(Object.keys(TAG_FONT_METRICS[family][face].pairs).filter((k) => k.includes(" ")), `${family} ${face}`)
          .toEqual([]);
      }
    }
    const { widths, pairs, extra } = TAG_FONT_METRICS.Roboto.normal;
    const w = (ch: string) => widths[ch.codePointAt(0)! - 32];
    expect(pairs.rt).toBeGreaterThanOrEqual(50 / 2048);
    expect(pairs.rt - 50 / 2048).toBeLessThan(1e-6);
    expect(textWidthOf("rt", "Roboto", "normal", 1)).toBeCloseTo(w("r") + w("t") + pairs.rt, 9);
    // twice where it appears twice.
    expect(textWidthOf("rtrt", "Roboto", "normal", 1)).toBeCloseTo(2 * (w("r") + w("t") + pairs.rt), 9);
    // `rt` with an exact character between them is no pair: that character's allowance covers both sides.
    expect(textWidthOf("r×t", "Roboto", "normal", 1)).toBeCloseTo(w("r") + extra[0xd7] + w("t"), 9);
    // nor with a character measured at the widest glyph between them.
    expect(textWidthOf("r€t", "Roboto", "normal", 1)).toBeCloseTo(w("r") + TAG_FONT_METRICS.Roboto.normal.widest + w("t"), 9);
  });

  // pdfkit's EmbeddedFont.layout lays a run out in pieces, each ending after one space or tab (the
  // tag's `noWrap` line reaches it whole), so a pair across a space or tab is never kerned. The oracle
  // here cuts the text the same way, lays out each piece with fontkit's default features and adds them.
  it("is never under pdfkit's layout for longer ASCII runs", () => {
    const samples = [
      "Report", "Port", "Order #1031", "Work order number", "Work order number:", "Part", "PART-TYPE",
      "Effort", "Party's 'wrt'", "\"Wrt\" (Y) [V] {f}", "TT-1031-YV", "HX-200/ZA", "Rf-77", "Pty Ltd",
      "MAX-NX IA", "Az-Rt", "first fly", "Tyrrt", "YYYY", "LAVA FT ET", "art, port, sort; cart", "rt  rt\trt",
    ];
    for (const family of FONT_FAMILIES) {
      for (const face of FACES) {
        const { font, em } = advances(family, face);
        const layout = font as unknown as { layout(text: string): { advanceWidth: number } };
        for (const text of samples) {
          const drawn = (text.match(/[^ \t]*[ \t]|[^ \t]+$/g) ?? []).reduce((sum, piece) => sum + em(layout.layout(piece).advanceWidth), 0);
          expect(textWidthOf(text, family, face, 1) + 5e-7 * text.length, `${family} ${face} ${text}`)
            .toBeGreaterThanOrEqual(drawn);
        }
      }
    }
    // Roboto's `Port` at 100 pt drew 1.81 pt wider than it measured. It now counts `rt`'s kern, and is
    // over the paper by `Po`'s narrowing alone, which the measure leaves out.
    const { font, em } = advances("Roboto", "normal");
    const lay = (t: string) => em((font as unknown as { layout(t: string): { advanceWidth: number } }).layout(t).advanceWidth);
    const narrowing = lay("P") + lay("o") - lay("Po");
    expect(narrowing).toBeGreaterThan(0);
    expect(Math.abs(textWidthOf("Port", "Roboto", "normal", 100) - lay("Port") * 100 - narrowing * 100)).toBeLessThan(1e-3);
  });

  it("leaves the ASCII widths of text with no kerned pair as they were, and a part line's × measures well under the widest glyph", () => {
    expect(textWidthOf("Order #1031", "Roboto", "bold", 20)).toBeCloseTo(112.402, 2);
    const { extra, widest } = TAG_FONT_METRICS.Roboto.normal;
    expect(extra[0xd7]).toBeLessThan(0.6);
    expect(widest).toBeGreaterThan(1.1);
    expect(textWidthOf("WIDGET-100 × 100", "Roboto", "normal", 10)).toBeCloseTo(
      textWidthOf("WIDGET-100 ", "Roboto", "normal", 10) + extra[0xd7] * 10 + textWidthOf(" 100", "Roboto", "normal", 10), 9,
    );
  });
});
