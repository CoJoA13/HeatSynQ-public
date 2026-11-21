import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach } from "vitest";
import { truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { FONT_FAMILIES } from "@/lib/template-contracts/types";
import { CANVAS_FONT_FACES, FONT_FILE_NAMES, FONT_URL_VERSION, fontFaceCss, fontUrl } from "@/lib/template-fonts";
import { fontBytes } from "@/server/pdf/render";
import { GET as fontRoute } from "@/app/api/templates/fonts/[file]/route";

const TTF_MAGIC = [0x00, 0x01, 0x00, 0x00];
const get = (file: string, cookie?: string) =>
  fontRoute(
    new Request(`http://t/api/templates/fonts/${encodeURIComponent(file)}`, {
      headers: cookie ? { cookie } : {},
    }),
    { params: Promise.resolve({ file }) },
  );

describe("template-fonts leaf", () => {
  it("names two files per family, eight in all", () => {
    expect(FONT_FILE_NAMES.size).toBe(8);
    for (const f of FONT_FAMILIES) {
      expect(FONT_FILE_NAMES.has(CANVAS_FONT_FACES[f].normal)).toBe(true);
      expect(FONT_FILE_NAMES.has(CANVAS_FONT_FACES[f].bold)).toBe(true);
    }
    expect(CANVAS_FONT_FACES.Roboto).toEqual({ normal: "Roboto-Regular.ttf", bold: "Roboto-Medium.ttf" });
  });

  it("fontFaceCss states both rules with the contract's family name", () => {
    const css = fontFaceCss("Roboto");
    expect(css.match(/@font-face/g)).toHaveLength(2);
    expect(css).toContain('font-family: "Roboto"');
    const v = encodeURIComponent(FONT_URL_VERSION);
    expect(css).toContain(`url(/api/templates/fonts/Roboto-Regular.ttf?v=${v}) format("truetype")`);
    expect(css).toContain(`url(/api/templates/fonts/Roboto-Medium.ttf?v=${v}) format("truetype")`);
    expect(css).toContain("font-weight: 400");
    expect(css).toContain("font-weight: 700");
  });

  it("the font URLs carry the build version, so a replaced face takes on the next build despite immutable", () => {
    // The route answers `private, max-age=31536000, immutable`; without a version in the URL a
    // browser would keep a replaced face until eviction. The label is the nav rail's build version.
    expect(fontUrl("Roboto-Regular.ttf", "110826 · 7639914")).toBe("/api/templates/fonts/Roboto-Regular.ttf?v=110826%20%C2%B7%207639914");
    expect(fontFaceCss("Roboto Mono", "110826 · 7639914")).toContain("RobotoMono-Bold.ttf?v=110826%20%C2%B7%207639914)");
    expect(fontUrl("Roboto-Regular.ttf")).toBe(`/api/templates/fonts/Roboto-Regular.ttf?v=${encodeURIComponent(FONT_URL_VERSION)}`);
    expect(FONT_URL_VERSION).toBe(process.env.NEXT_PUBLIC_BUILD_VERSION ?? "unknown");
  });

  it("every file the leaf names is a TTF the renderer holds", () => {
    for (const f of FONT_FAMILIES) {
      for (const file of [CANVAS_FONT_FACES[f].normal, CANVAS_FONT_FACES[f].bold]) {
        const buf = fontBytes(file);
        expect(buf, file).not.toBeNull();
        expect([...buf!.subarray(0, 4)]).toEqual(TTF_MAGIC);
      }
    }
    expect(fontBytes("../x")).toBeNull();
    expect(fontBytes("Roboto-Bold.ttf")).toBeNull();
  });
});

describe("the leaf's faces are the renderer's", () => {
  const src = readFileSync("src/server/pdf/render.ts", "utf8");
  const block = src.slice(src.indexOf("export const PDF_FONT_FACES = {"));
  it.each([...FONT_FAMILIES])("%s: PDF_FONT_FACES names the leaf's normal and bold", (family) => {
    const at = block.indexOf(`${family.includes(" ") ? `"${family}"` : family}: {`);
    expect(at, `${family} in PDF_FONT_FACES`).toBeGreaterThan(-1);
    const face = block.slice(at, block.indexOf("}", at));
    expect(face, `${family} normal`).toContain(`normal: "${CANVAS_FONT_FACES[family].normal}"`);
    expect(face, `${family} bold`).toContain(`bold: "${CANVAS_FONT_FACES[family].bold}"`);
  });
});

describe("GET /api/templates/fonts/[file]", () => {
  let bare: string;
  beforeEach(async () => {
    await truncateAll();
    bare = await signInWith([], "font-bare");
  });

  it("401 without a session", async () => {
    expect((await get("Roboto-Regular.ttf")).status).toBe(401);
  });

  it("ignores the URL's version query, which only busts the browser's cache", async () => {
    const res = await fontRoute(
      new Request("http://t/api/templates/fonts/Roboto-Regular.ttf?v=110826%20%C2%B7%207639914", { headers: { cookie: bare } }),
      { params: Promise.resolve({ file: "Roboto-Regular.ttf" }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
  });

  it("200 font/ttf for a bare session", async () => {
    const res = await get("LiberationSerif-Bold.ttf", bare);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/ttf");
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.subarray(0, 4)]).toEqual(TTF_MAGIC);
  });

  it("404 for a traversal and for a face the renderer does not have", async () => {
    expect((await get("../x", bare)).status).toBe(404);
    expect((await get("Roboto-Bold.ttf", bare)).status).toBe(404);
  });

  it("404 for a file the renderer holds but the leaf omits (the guard runs ahead of the read)", async () => {
    expect(fontBytes("Roboto-Italic.ttf")).not.toBeNull();
    expect(FONT_FILE_NAMES.has("Roboto-Italic.ttf")).toBe(false);
    const res = await get("Roboto-Italic.ttf", bare);
    expect(res.status).toBe(404);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.subarray(0, 4)]).not.toEqual(TTF_MAGIC);
  });
});
