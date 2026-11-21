/**
 * PDF-byte decoding for content assertions — lifted verbatim from tests/render-primitives.test.ts
 * (Phase 7 Task 6's decoder, moved here by Task 7 the moment a second suite needed it, per the
 * Task 6 report's own note), plus the `endstream` guard the Task 6 review carried: a stream with
 * no terminator now fails NAMING the parse problem instead of feeding `-1` into
 * `subarray`/`indexOf` and producing confusing downstream assertion failures.
 *
 * WHY BYTES, NOT DEFINITIONS. Renderer-side callbacks (page footers, continuation headers) and
 * anything asserted "through the real print path" exist only in the RENDERED bytes — the house
 * `allText`-over-definition technique cannot see them, and CLAUDE.md forbids `Buffer.compare`
 * between fresh renders. pdfkit embeds each font as a subset whose text operators carry subset
 * glyph ids (never ASCII), but every embedded font also carries a ToUnicode CMap mapping those
 * ids back to Unicode — the same table a PDF viewer's copy-paste uses. `drawnPages` inflates
 * every FlateDecode stream, parses the CMaps, walks each page's content stream with `Tf` font
 * tracking, and decodes every TJ/Tj run through the ACTIVE font's map — per-page, exact, no
 * cross-font guessing. Declared Type1/WinAnsi fonts (pdf-lib's margin labels) instead use their
 * one-byte Windows-1252 encoding, so parity assertions can remove only the actual exact label. The `/Type /Pages /Count N` marker stays the page-count assertion
 * (traveler.test.ts's rule); nothing here ever compares two fresh renders byte-for-byte.
 *
 * PLAIN NODE LOADS THIS FILE. e2e/lib/printed-page.mjs, a module of the browser suite, which plain
 * node runs, imports it by its `.ts` name. Node strips the types and changes nothing else. So this
 * file keeps to syntax node can strip (annotations and type aliases: no enum, no namespace, no
 * parameter property), and names the ending of any relative file it imports a value from. One
 * case of tests/e2e-printed-page.test.ts holds that: it imports the reader under plain node.
 */
import zlib from "node:zlib";

/** The PDF's own page count, read off its uncompressed `/Type /Pages /Count N` object. */
export function pageCount(pdf: Buffer): number {
  const match = pdf.toString("latin1").match(/\/Type\s*\/Pages[^>]*\/Count\s+(\d+)/);
  if (!match) throw new Error("Could not find a /Type /Pages /Count marker in the rendered PDF");
  return Number(match[1]);
}

export type PdfObj = { body: string; stream: Buffer | null };

/**
 * Every `N 0 obj` in the file, keyed by number: its dict/body text plus its stream bytes,
 * inflated where FlateDecode'd. Parsed sequentially — after a stream the scan resumes past
 * `endstream`, so binary stream data can never be misread as an object header.
 */
export function parseObjects(pdf: Buffer): Map<number, PdfObj> {
  const s = pdf.toString("latin1"); // byte-for-byte, so string offsets are byte offsets
  const objs = new Map<number, PdfObj>();
  const re = /(\d+)\s+0\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const start = m.index + m[0].length;
    const endobjIdx = s.indexOf("endobj", start);
    if (endobjIdx === -1) break;
    const streamIdx = s.indexOf("stream", start);
    if (streamIdx !== -1 && streamIdx < endobjIdx) {
      const body = s.slice(start, streamIdx);
      let dataStart = streamIdx + 6;
      if (pdf[dataStart] === 0x0d) dataStart++;
      if (pdf[dataStart] === 0x0a) dataStart++;
      // The stream's byte length. PREFER the object's own DIRECT `/Length N` — the exact count a
      // real PDF reader uses — over scanning for the `endstream` keyword. The keyword scan is a
      // heuristic on BINARY data with two failure modes the byte-exact length sidesteps: a
      // FlateDecode stream's final byte is arbitrary, so ~1 render in 128 ends in a CR/LF byte, and
      // the old greedy trailing-EOL trim (`while … 0x0a || 0x0d`) ate that real data byte along
      // with the spec's single separator EOL — truncating the stream by a byte so `inflateSync`
      // threw, the whole page fell back to `Buffer.from(bytes)` garbage, and every text assertion
      // decoded to "" (the `/Length`-honoring inflate of the SAME bytes succeeds). The scan also
      // could (in theory) false-match on `endstream` bytes inside the compressed data. `/Length`
      // avoids both. An indirect length (`/Length 5 0 R`, rejected by the lookahead) or an absent
      // one falls back to the scan, now stripping only the SINGLE spec-mandated EOL, non-greedily.
      const lengthMatch = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(body);
      const searchFrom = lengthMatch !== null ? dataStart + Number(lengthMatch[1]) : dataStart;
      const endstreamIdx = s.indexOf("endstream", searchFrom);
      // The Task 6 review carry: a missing terminator must be a clear parse error, never a `-1`
      // silently fed into subarray/indexOf below.
      if (endstreamIdx === -1) {
        throw new Error(
          `PDF parse error: object ${m[1]} opens a stream at byte ${dataStart} with no endstream`);
      }
      let bytes: Buffer;
      if (lengthMatch !== null) {
        bytes = pdf.subarray(dataStart, dataStart + Number(lengthMatch[1]));
      } else {
        let e = endstreamIdx;
        // Strip exactly the one EOL (CRLF, LF or CR) the spec places before `endstream` — never
        // greedily, so a data byte that is coincidentally CR/LF survives.
        if (pdf[e - 1] === 0x0a) e--;
        if (pdf[e - 1] === 0x0d) e--;
        bytes = pdf.subarray(dataStart, Math.max(dataStart, e));
      }
      let stream: Buffer;
      try { stream = zlib.inflateSync(bytes); } catch { stream = Buffer.from(bytes); }
      objs.set(Number(m[1]), { body, stream });
      re.lastIndex = s.indexOf("endobj", endstreamIdx) + 6;
    } else {
      objs.set(Number(m[1]), { body: s.slice(start, endobjIdx), stream: null });
      re.lastIndex = endobjIdx + 6;
    }
  }
  return objs;
}

type Cmap = Map<number, string>;

/**
 * One embedded font's glyph-id → Unicode map, parsed from its ToUnicode CMap stream (bfchar
 * pairs, bfrange with an array, and sequential bfrange all handled).
 *
 * A destination is a UTF-16BE *string*, not one code point: pdfkit writes a LIGATURE's glyph as a
 * multi-code-point destination (`fl` → `<0066 006c>`), and inside a bfrange array those code
 * points arrive space-separated. Task 8 found this the hard way — a hex pattern that stopped at
 * the space matched no item at all for the ligature, so every LATER entry in the array shifted
 * down one glyph id and the page decoded as a consistent substitution cipher ("the" → "lfe").
 * Any fixture text containing fi/fl/ff hits it (the Task 8 overflow fixture's "Overflow Co" did),
 * so the hex classes below deliberately admit whitespace and `hexToUtf16` strips it.
 */
function parseCmap(buf: Buffer): Cmap {
  const s = buf.toString("latin1");
  const map: Cmap = new Map();
  const hexToUtf16 = (raw: string): string => {
    const hex = raw.replace(/\s+/g, "");
    let out = "";
    for (let i = 0; i + 4 <= hex.length; i += 4) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    }
    return out;
  };
  const bfchar = /beginbfchar([\s\S]*?)endbfchar/g;
  let m: RegExpExecArray | null;
  while ((m = bfchar.exec(s)) !== null) {
    const pairRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F\s]+)>/g;
    let p: RegExpExecArray | null;
    while ((p = pairRe.exec(m[1])) !== null) map.set(parseInt(p[1], 16), hexToUtf16(p[2]));
  }
  const bfrange = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfrange.exec(s)) !== null) {
    const entryRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[\s\S]*?\]|<[0-9a-fA-F\s]+>)/g;
    let e: RegExpExecArray | null;
    while ((e = entryRe.exec(m[1])) !== null) {
      const lo = parseInt(e[1], 16);
      if (e[3].startsWith("[")) {
        const items = [...e[3].matchAll(/<([0-9a-fA-F\s]+)>/g)].map((x) => x[1]);
        items.forEach((u, i) => map.set(lo + i, hexToUtf16(u)));
      } else {
        // A sequential range increments the destination's LAST code unit; anything before it is a
        // fixed prefix (the multi-code-point case again).
        const hex = e[3].slice(1, -1).replace(/\s+/g, "");
        const prefix = hexToUtf16(hex.slice(0, -4));
        const start = parseInt(hex.slice(-4), 16);
        const hi = parseInt(e[2], 16);
        for (let g = lo; g <= hi; g++) map.set(g, prefix + String.fromCharCode(start + (g - lo)));
      }
    }
  }
  return map;
}

/** The page objects in true page order — the root /Pages object's /Kids array, flattened
 *  depth-first (both pdfkit's and pdf-lib's trees are flat, but recursion costs nothing). */
export function pagesInOrder(objs: Map<number, PdfObj>): PdfObj[] {
  const isPages = (o: PdfObj): boolean => /\/Type\s*\/Pages\b/.test(o.body);
  const kidRefs = (o: PdfObj): number[] => {
    const kids = /\/Kids\s*\[([\s\S]*?)\]/.exec(o.body);
    return kids ? [...kids[1].matchAll(/(\d+)\s+0\s+R/g)].map((r) => Number(r[1])) : [];
  };
  // The root: a /Pages object no other /Pages object lists as a kid.
  const pagesObjs = [...objs.entries()].filter(([, o]) => isPages(o));
  const listed = new Set(pagesObjs.flatMap(([, o]) => kidRefs(o)));
  const root = pagesObjs.find(([num]) => !listed.has(num));
  if (!root) throw new Error("No root /Pages object found");
  const out: PdfObj[] = [];
  const walk = (num: number): void => {
    const o = objs.get(num);
    if (!o) return;
    if (isPages(o)) kidRefs(o).forEach(walk);
    else if (/\/Type\s*\/Page\b/.test(o.body)) out.push(o);
  };
  kidRefs(root[1]).forEach(walk);
  return out;
}

/**
 * What each page actually draws, decoded exactly: for every page, its /Resources /Font dict maps
 * resource names to font objects, each font's ToUnicode CMap maps subset glyph ids to Unicode,
 * and the content stream is walked operator-by-operator — `Tf` selects the active font, each
 * TJ/Tj run decodes through THAT font's CMap (no cross-font guessing). pdfkit splits a line into
 * word-level runs that keep their trailing spaces, so concatenating a page's runs reassembles
 * its phrases exactly. Returns one string per page, in page order.
 */
export function drawnPages(pdf: Buffer): string[] {
  const objs = parseObjects(pdf);
  return pagesInOrder(objs).map((page) => {
    // Resources: inline dict or an indirect reference.
    const resRef = /\/Resources\s+(\d+)\s+0\s+R/.exec(page.body);
    const resources = resRef ? (objs.get(Number(resRef[1]))?.body ?? "") : page.body;
    const fontDict = /\/Font\s*<<([\s\S]*?)>>/.exec(resources)?.[1] ?? "";
    const fonts = new Map<string, Cmap | "WinAnsiEncoding">();
    for (const [, name, num] of fontDict.matchAll(/\/([\w-]+)\s+(\d+)\s+0\s+R/g)) {
      const fontObj = objs.get(Number(num));
      const toUni = fontObj && /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(fontObj.body);
      const cmapStream = toUni && objs.get(Number(toUni[1]))?.stream;
      if (cmapStream) fonts.set(name, parseCmap(cmapStream));
      else if (fontObj && /\/Subtype\s*\/Type1\b/.test(fontObj.body) &&
          /\/Encoding\s*\/WinAnsiEncoding\b/.test(fontObj.body)) {
        fonts.set(name, "WinAnsiEncoding");
      }
    }
    // Contents: a single ref or an array of refs.
    const contentsMatch = /\/Contents\s+(\[[\s\S]*?\]|\d+\s+0\s+R)/.exec(page.body);
    const contentRefs = contentsMatch
      ? [...contentsMatch[1].matchAll(/(\d+)\s+0\s+R/g)].map((r) => Number(r[1]))
      : [];
    const runs: string[] = [];
    for (const ref of contentRefs) {
      const content = objs.get(ref)?.stream?.toString("latin1") ?? "";
      const opRe = /\/([\w-]+)\s+[\d.]+\s+Tf|\[((?:<[0-9a-fA-F]+>|[-\d.\s])+)\]\s*TJ|<([0-9a-fA-F]+)>\s*Tj/g;
      let active: Cmap | "WinAnsiEncoding" | undefined;
      let m: RegExpExecArray | null;
      while ((m = opRe.exec(content)) !== null) {
        if (m[1] !== undefined) { active = fonts.get(m[1]); continue; }
        const hexes = [...(m[2] ?? `<${m[3]}>`).matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => x[1]);
        let text = "";
        for (const h of hexes) {
          if (active === "WinAnsiEncoding") {
            text += new TextDecoder("windows-1252").decode(Buffer.from(h, "hex"));
            continue;
          }
          for (let i = 0; i + 4 <= h.length; i += 4) {
            text += active?.get(parseInt(h.slice(i, i + 4), 16)) ?? "�";
          }
        }
        runs.push(text);
      }
    }
    return runs.join("");
  });
}

/** All pages' drawn text, newline-joined — the whole-document containment assertion. */
export function drawnText(pdf: Buffer): string {
  return drawnPages(pdf).join("\n");
}

/**
 * Decoded text runs WITH their device-space positions, per page — what a reading-order/overlap
 * assertion needs (Task 9's tear-off reflow regression: "the strip must sit BELOW every part
 * row on the page they share", which plain `drawnPages` cannot see because stream order and
 * paper order diverge exactly when `absolutePosition` is involved).
 *
 * Coordinates: PDF device space, y from the page's BOTTOM edge — larger y is HIGHER on the
 * paper. pdfkit brackets every run as `q / 1 0 0 -1 0 792 cm / BT / a b c d x y Tm / Tf / TJ /
 * ET / Q` inside a stream whose OWN leading flip cm composes with that inner flip back to the
 * identity, so the Tm translation IS the run's device-space baseline position (verified against
 * a flowed node at the 24pt top margin decoding to y≈757 and an `absolutePosition: {y: 648}`
 * node to y≈133). Deliberately additive beside `drawnPages` — that decoder is load-bearing for
 * every content assertion in the suite, and this one's Tm tracking is pdfkit-shaped (no Td/TD
 * chasing, which pdfkit does not emit).
 */
export function textRunsWithY(pdf: Buffer): { text: string; x: number; y: number }[][] {
  const objs = parseObjects(pdf);
  return pagesInOrder(objs).map((page) => {
    const resRef = /\/Resources\s+(\d+)\s+0\s+R/.exec(page.body);
    const resources = resRef ? (objs.get(Number(resRef[1]))?.body ?? "") : page.body;
    const fontDict = /\/Font\s*<<([\s\S]*?)>>/.exec(resources)?.[1] ?? "";
    const fonts = new Map<string, Cmap | "WinAnsiEncoding">();
    for (const [, name, num] of fontDict.matchAll(/\/([\w-]+)\s+(\d+)\s+0\s+R/g)) {
      const fontObj = objs.get(Number(num));
      const toUni = fontObj && /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(fontObj.body);
      const cmapStream = toUni && objs.get(Number(toUni[1]))?.stream;
      if (cmapStream) fonts.set(name, parseCmap(cmapStream));
      else if (fontObj && /\/Subtype\s*\/Type1\b/.test(fontObj.body) &&
          /\/Encoding\s*\/WinAnsiEncoding\b/.test(fontObj.body)) {
        fonts.set(name, "WinAnsiEncoding");
      }
    }
    const contentsMatch = /\/Contents\s+(\[[\s\S]*?\]|\d+\s+0\s+R)/.exec(page.body);
    const contentRefs = contentsMatch
      ? [...contentsMatch[1].matchAll(/(\d+)\s+0\s+R/g)].map((r) => Number(r[1]))
      : [];
    const runs: { text: string; x: number; y: number }[] = [];
    for (const ref of contentRefs) {
      const content = objs.get(ref)?.stream?.toString("latin1") ?? "";
      const opRe =
        /\/([\w-]+)\s+[\d.]+\s+Tf|(?:[-\d.]+\s+){4}([-\d.]+)\s+([-\d.]+)\s+Tm|\[((?:<[0-9a-fA-F]+>|[-\d.\s])+)\]\s*TJ|<([0-9a-fA-F]+)>\s*Tj/g;
      let active: Cmap | "WinAnsiEncoding" | undefined;
      let x = 0;
      let y = 0;
      let m: RegExpExecArray | null;
      while ((m = opRe.exec(content)) !== null) {
        if (m[1] !== undefined) { active = fonts.get(m[1]); continue; }
        if (m[2] !== undefined) { x = Number(m[2]); y = Number(m[3]); continue; }
        const hexes = [...(m[4] ?? `<${m[5]}>`).matchAll(/<([0-9a-fA-F]+)>/g)].map((h) => h[1]);
        let text = "";
        for (const h of hexes) {
          if (active === "WinAnsiEncoding") {
            text += new TextDecoder("windows-1252").decode(Buffer.from(h, "hex"));
            continue;
          }
          for (let i = 0; i + 4 <= h.length; i += 4) {
            text += active?.get(parseInt(h.slice(i, i + 4), 16)) ?? "�";
          }
        }
        runs.push({ text, x, y });
      }
    }
    return runs;
  });
}

/**
 * Image paints per page, in page order: each `/Name Do` in a page's content stream(s) whose
 * resource entry is an image XObject counts once. SMask children never paint via `Do` (they are
 * referenced from an image's own dict), so like traveler-templates' `countImages` this counts
 * pictures ON the paper — but per page, which is what a continuation-header assertion needs
 * ("page two carries the barcode"). Survives the pdf-lib merge; the /XObject dict may arrive
 * inline (pdfkit) or as an indirect reference (pdf-lib copies), so both shapes resolve.
 */
export function paintedImageCounts(pdf: Buffer): number[] {
  const objs = parseObjects(pdf);
  return pagesInOrder(objs).map((page) => {
    const resRef = /\/Resources\s+(\d+)\s+0\s+R/.exec(page.body);
    const resources = resRef ? (objs.get(Number(resRef[1]))?.body ?? "") : page.body;
    const xobjRef = /\/XObject\s+(\d+)\s+0\s+R/.exec(resources);
    const xobjDict = xobjRef
      ? (objs.get(Number(xobjRef[1]))?.body ?? "")
      : (/\/XObject\s*<<([\s\S]*?)>>/.exec(resources)?.[1] ?? "");
    const imageNames = new Set<string>();
    for (const [, name, num] of xobjDict.matchAll(/\/(\w+)\s+(\d+)\s+0\s+R/g)) {
      if (/\/Subtype\s*\/Image/.test(objs.get(Number(num))?.body ?? "")) imageNames.add(name);
    }
    const contentsMatch = /\/Contents\s+(\[[\s\S]*?\]|\d+\s+0\s+R)/.exec(page.body);
    const contentRefs = contentsMatch
      ? [...contentsMatch[1].matchAll(/(\d+)\s+0\s+R/g)].map((r) => Number(r[1]))
      : [];
    let painted = 0;
    for (const ref of contentRefs) {
      const content = objs.get(ref)?.stream?.toString("latin1") ?? "";
      for (const [, name] of content.matchAll(/\/(\w+)\s+Do\b/g)) {
        if (imageNames.has(name)) painted++;
      }
    }
    return painted;
  });
}

/** Each page's content streams, joined, in page order: the raw operators a geometry reader walks. */
export function pageStreams(pdf: Buffer): string[] {
  const objs = parseObjects(pdf);
  return pagesInOrder(objs).map((page) => {
    const contents = /\/Contents\s+(\[[\s\S]*?\]|\d+\s+0\s+R)/.exec(page.body);
    const refs = contents ? [...contents[1].matchAll(/(\d+)\s+0\s+R/g)].map((r) => Number(r[1])) : [];
    return refs.map((ref) => objs.get(ref)?.stream?.toString("latin1") ?? "").join("\n");
  });
}

/**
 * Every painted XObject's drawn box per page, in page order, from the `a b c d e f cm` immediately
 * before its `/Name Do` (moved here from tests/traveler-canvas.test.ts, PR C of #926, for the browser
 * suite's reader). pdfkit draws an image as `q w 0 0 -h x y+h cm /Ix Do Q` inside the page's own
 * top-down flip, so `|a|` and `|d|` are the drawn width and height and `(e, f − |d|)` the drawn
 * top-left in TOP-DOWN page coordinates: points from the page's top-left corner, y growing down (the
 * frame `strokedLines` reports in). Every XObject a traveler paints is an image (the house
 * `paintedImageCounts` checks the subtype; this reader trusts that count beside it).
 */
export function paintedImages(pdf: Buffer): { x: number; y: number; w: number; h: number }[][] {
  const cm = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+cm\s+\/\w+\s+Do\b/g;
  return pageStreams(pdf).map((stream) => [...stream.matchAll(cm)].map((m) => {
    const [a, , , d, e, f] = m.slice(1, 7).map(Number);
    return { x: e, y: d < 0 ? f + d : f, w: Math.abs(a), h: Math.abs(d) };
  }));
}

/** Each page's top edge in points, in page order: the upper y (`ury`) of its own `/MediaBox
 *  [llx lly urx ury]`, in the general form (a lower y need not be zero). Device space puts y from
 *  the bottom, so `top − y` is a point's distance under the page's top edge. A page without its own
 *  box (one inherited from its /Pages parent, which pdfkit and pdf-lib do not write) raises. */
export function pageTops(pdf: Buffer): number[] {
  return pagesInOrder(parseObjects(pdf)).map((page, index) => {
    const box = /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/.exec(page.body);
    if (!box) throw new Error(`page ${index + 1} has no /MediaBox`);
    return Number(box[4]);
  });
}

export type StrokedLine = { x1: number; y1: number; x2: number; y2: number; width: number };

/**
 * Every stroked straight LINE segment drawn on each page (an `m`/`l` moveto/lineto pair), in page
 * order, in the content stream's OWN coordinates — pdfkit wraps a page in a leading
 * `1 0 0 -1 0 <height> cm` that flips once to top-down (y grows toward the bottom of the paper),
 * so the raw `m`/`l` numbers ARE top-down page coordinates already; no further flip is needed
 * (contrast `textRunsWithY`, whose `Tm` matrices carry a SECOND, inner flip that composes back to
 * bottom-up device space — there is no such inner flip for a plain stroked path). A stroke's `y`
 * is pdfkit's own centreline coordinate — the same "distance between centres of drawn rules" a
 * printed-geometry assertion wants. Out of scope: a stroked or filled RECTANGLE (the `re`
 * operator, which a pdfmake `canvas` `rect` such as the traveler footer's checkboxes emits) is
 * never returned. A canvas `line` emits `m`/`l` and is returned like a table rule; a multi-point
 * canvas `polyline` would return only its first segment.
 *
 * Handles exactly the shapes pdfmake/pdfkit tables draw for rules: a `width w` (`w` operator)
 * then a two-point path (one `m` move, one `l` line — no curves, no multi-segment polylines).
 * pdfkit sets the line width before EVERY stroke, not only when it changes — verified against a
 * real render: one traveler page carried 216 `w` operators against 214 `m`/`l` pairs, the two
 * extra `w`s preceding non-line strokes (a rectangle border's `re`) this function does not
 * collect — so a preceding `w` is the normal case for a line, and the carried-forward `width`
 * below is defensive slack for the rare line that omitted its own. Does not look for the paint
 * operator (`S`/`s`); every `m ... l` pair pdfmake emits for a table rule is stroked, never
 * filled, so that op is not needed to tell a rule apart from anything else. Does not handle a
 * `q`/`Q` state push between `w` and `m`/`l` (pdfkit does not nest one there for a table rule) or
 * a line missing its own preceding `w` entirely (see above).
 */
export function strokedLines(pdf: Buffer): StrokedLine[][] {
  const objs = parseObjects(pdf);
  return pagesInOrder(objs).map((page) => {
    const contentsMatch = /\/Contents\s+(\[[\s\S]*?\]|\d+\s+0\s+R)/.exec(page.body);
    const contentRefs = contentsMatch
      ? [...contentsMatch[1].matchAll(/(\d+)\s+0\s+R/g)].map((r) => Number(r[1]))
      : [];
    const segments: StrokedLine[] = [];
    // Carried forward defensively (see the docstring): pdfkit sets `w` before every stroke in
    // practice, so this rarely if ever needs to reach back past the immediately preceding one.
    let width: number | null = null;
    let cur: { x: number; y: number } | null = null;
    for (const ref of contentRefs) {
      const content = objs.get(ref)?.stream?.toString("latin1") ?? "";
      // The three table-rule operators, matched as whole tokens: the mandatory `\s+` before each
      // single-letter op means a same-named suffix glued to a preceding letter (the "m" inside
      // "cm", the "l" inside a hypothetical multi-char op) can never match — only a token that is
      // ACTUALLY just "w"/"m"/"l" on its own, preceded by whitespace, does.
      const opRe = /([\d.]+)\s+w\b|([\d.-]+)\s+([\d.-]+)\s+m\b|([\d.-]+)\s+([\d.-]+)\s+l\b/g;
      let m: RegExpExecArray | null;
      while ((m = opRe.exec(content)) !== null) {
        if (m[1] !== undefined) { width = Number(m[1]); continue; }
        if (m[2] !== undefined) { cur = { x: Number(m[2]), y: Number(m[3]) }; continue; }
        if (cur !== null && width !== null) {
          segments.push({ x1: cur.x, y1: cur.y, x2: Number(m[4]), y2: Number(m[5]), width });
        }
        cur = null;
      }
    }
    return segments;
  });
}

// A real 2×2 JPEG (PIL-generated for the Task 6 suite; SOI + JFIF + SOF0, 633 bytes) — pdfkit
// parses the marker structure, so the fixture must be a genuine JPEG, not just magic bytes.
// Exported beside the decoder because every suite that embeds a JPEG (render primitives, the
// traveler's template logo) needs the same genuine fixture.
export const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEi" +
  "MEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7" +
  "Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcI" +
  "CQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRol" +
  "JicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ip" +
  "qrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAA" +
  "AAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLR" +
  "ChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaX" +
  "mJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEA" +
  "PwDmaKKK8g/RD//Z",
  "base64");

/**
 * Image XObjects that are pictures on the paper: every `/Subtype /Image` object less the /SMask
 * children an alpha PNG embeds beside its image. Counted over the whole file, not per page, so a
 * merged print that stores one picture per sheet group shows it (#670); `paintedImageCounts`
 * above answers the per-page question.
 */
export function imageObjectCount(pdf: Buffer): number {
  const objs = parseObjects(pdf);
  const smasks = new Set<number>();
  for (const o of objs.values()) {
    for (const m of o.body.matchAll(/\/SMask\s+(\d+)\s+0\s+R/g)) smasks.add(Number(m[1]));
  }
  return [...objs.entries()]
    .filter(([num, o]) => /\/Subtype\s*\/Image/.test(o.body) && !smasks.has(num)).length;
}

/** `/SMask N 0 R` references whose object N is not in the file: an image dedupe that deletes a
 *  kept picture's mask leaves one, and a viewer then shows the picture without its transparency. */
export function danglingSMaskRefs(pdf: Buffer): number {
  const objs = parseObjects(pdf);
  let dangling = 0;
  for (const o of objs.values()) {
    for (const m of o.body.matchAll(/\/SMask\s+(\d+)\s+0\s+R/g)) {
      if (!objs.has(Number(m[1]))) dangling++;
    }
  }
  return dangling;
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * An 8-bit RGBA PNG of `width` × `height` pseudo-random pixels, built by hand so the suite needs no
 * image encoder. pdfkit embeds it as an image plus an /SMask, which is what the alpha cases
 * exercise; the IDAT is stored (deflate level 0), so a large one is as large as it looks, which
 * the #670 measurement wants.
 */
export function alphaPng(width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let seed = 0x2545f491;
  for (let i = 0; i < raw.length; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    raw[i] = i % (width * 4 + 1) === 0 ? 0 : seed >>> 24;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // bit depth 8, colour type 6 (RGBA)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 0 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The 2×2 alpha PNG the logo cases place. */
export const tinyAlphaPng = (): Buffer => alphaPng(2, 2);

/** Page 1's text runs, each with its font's base name (a subset prefix stripped: `Roboto-Medium` is
 *  Roboto's bold) and size, read with `textRunsWithY`'s own operator walk so the two line up (moved
 *  here from tests/bol-canvas.test.ts for the bill of lading seed's golden; `x` added). */
export function runFonts(pdf: Buffer): { text: string; x: number; y: number; font: string; size: number }[] {
  const objs = parseObjects(pdf);
  const page = pagesInOrder(objs)[0];
  const resRef = /\/Resources\s+(\d+)\s+0\s+R/.exec(page.body);
  const resources = resRef ? (objs.get(Number(resRef[1]))?.body ?? "") : page.body;
  const fontDict = /\/Font\s*<<([\s\S]*?)>>/.exec(resources)?.[1] ?? "";
  const names = new Map<string, string>();
  for (const [, name, num] of fontDict.matchAll(/\/([\w-]+)\s+(\d+)\s+0\s+R/g)) {
    const base = /\/BaseFont\s*\/([\w+-]+)/.exec(objs.get(Number(num))?.body ?? "")?.[1] ?? "";
    names.set(name, base.replace(/^[A-Z]{6}\+/, ""));
  }
  const contentsMatch = /\/Contents\s+(\[[\s\S]*?\]|\d+\s+0\s+R)/.exec(page.body);
  const refs = contentsMatch ? [...contentsMatch[1].matchAll(/(\d+)\s+0\s+R/g)].map((r) => Number(r[1])) : [];
  const shown: { font: string; size: number }[] = [];
  for (const ref of refs) {
    const content = objs.get(ref)?.stream?.toString("latin1") ?? "";
    const opRe =
      /\/([\w-]+)\s+([\d.]+)\s+Tf|(?:[-\d.]+\s+){4}([-\d.]+)\s+([-\d.]+)\s+Tm|\[((?:<[0-9a-fA-F]+>|[-\d.\s])+)\]\s*TJ|<([0-9a-fA-F]+)>\s*Tj/g;
    let font = "";
    let size = 0;
    let m: RegExpExecArray | null;
    while ((m = opRe.exec(content)) !== null) {
      if (m[1] !== undefined) { font = names.get(m[1]) ?? ""; size = Number(m[2]); continue; }
      if (m[3] !== undefined) continue;
      shown.push({ font, size });
    }
  }
  const runs = textRunsWithY(pdf)[0];
  if (runs.length !== shown.length) throw new Error(`runFonts: ${runs.length} runs, ${shown.length} shows`);
  return runs.map((r, i) => ({ text: r.text.trim(), x: r.x, y: r.y, ...shown[i] }));
}

/**
 * The text of each page as printed LINES: `textRunsWithY`'s runs grouped by their baseline (pdfkit
 * writes a word per run), left to right, their texts joined and the spacing collapsed. A party
 * block's stacked lines (#671) are told apart by exact line text where word runs cannot be.
 */
export function textLinesWithY(pdf: Buffer): { text: string; y: number }[][] {
  return textRunsWithY(pdf).map((runs) => {
    const byLine = new Map<number, { text: string; x: number }[]>();
    for (const run of runs) {
      const key = Math.round(run.y * 2) / 2;
      const line = byLine.get(key) ?? [];
      line.push({ text: run.text, x: run.x });
      byLine.set(key, line);
    }
    return [...byLine.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([y, parts]) => ({
        y,
        text: parts.sort((a, b) => a.x - b.x).map((p) => p.text).join("").replace(/\s+/g, " ").trim(),
      }));
  });
}
