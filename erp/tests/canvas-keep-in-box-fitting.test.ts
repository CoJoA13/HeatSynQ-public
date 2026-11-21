import { afterAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTravelerDefinitions } from "@/server/traveler";
import { renderSheetGroups } from "@/server/pdf/render";
import { canvasRefusal } from "@/lib/template-canvas";
import { contractFor, defaultConfigFor, validateConfig, type TemplateConfig } from "@/lib/template-contracts/index";
import { canonical, digest, dumpCanvasPaper, type PaperCase } from "./helpers/canvas-paper-dump";
import { strokedLines } from "./helpers/pdf";
import { FITTING_CASES, FULL_W, LEFT, RIGHT, blockCase, outOfBox, travelerRecord } from "./helpers/keep-in-box-cases";

/**
 * Fitting canvas paper, recorded on `main` before #971's column clamp (the plan's Task 1; design
 * §8.2, the probe-g method). Every block in the fix's scope (design §5.3) on its document's standard
 * layout and one-page record (tests/helpers/keep-in-box-cases.ts), drawn at 564 from x 24 and at its
 * first fitting width (`FITTING_CASES`) both from x 24 and against the right margin (x = 588 − w),
 * with the page line off and on. Each case first proves it fits: nothing of the block prints past its
 * drawn right edge (`outOfBox`), so a case that stops fitting refuses to write. Its `digest` (the
 * oracle's: per page, the text runs, strokes, rects and images; the positions; the measure) is then
 * compared with the fixture, which the hook must leave byte-identical (design §3, §5.2).
 *
 * The fixture is written once, on the base, with `KEEP_IN_BOX_FITTING_WRITE=1`, which writes only
 * after every case ran and proved it fits.
 *
 * The second describe held the flow's overruns at their figures (design §8.4, report 1 §6) while the
 * fix was scoped to canvas blocks; since #991 the flow's tables take the clamp too, and it holds them
 * inside the page.
 */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "canvas-keep-in-box-fitting.json");
const WRITE = process.env.KEEP_IN_BOX_FITTING_WRITE === "1";
/** How far the x 24 cases' control moves the block, to tell its ink from the rest of the page. */
const SHIFT = 1;

const r2 = (n: number) => Math.round(n * 100) / 100;

type Case = { c: PaperCase; block: string; x: number; w: number };
const CASES: Case[] = [];
for (const { doc, block, w } of FITTING_CASES) {
  for (const pageFooter of [false, true]) {
    for (const at of [{ x: LEFT, w: FULL_W }, { x: LEFT, w }, { x: r2(RIGHT - w), w }]) {
      CASES.push({ c: blockCase(doc, block, at, pageFooter), block, x: at.x, w: at.w });
    }
  }
}

const frozen: Record<string, ReturnType<typeof digest>> = WRITE || !existsSync(FIXTURE)
  ? {} : JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, ReturnType<typeof digest>>;
const written: Record<string, ReturnType<typeof digest>> = {};

describe("fitting canvas paper is byte-identical (#971)", () => {
  it("holds three widths of every block, every name once", () => {
    expect(new Set(CASES.map(({ c }) => c.name)).size).toBe(CASES.length);
    expect(CASES.length).toBe(FITTING_CASES.length * 6);
    if (!WRITE) expect(Object.keys(frozen).sort(), "the fixture's cases").toEqual(CASES.map(({ c }) => c.name).sort());
  });

  for (const { c, block, x, w } of CASES) {
    it(c.name, async () => {
      expect(canvasRefusal(c.config.layout!, contractFor(c.doc), { pageFooter: c.config.pageFooter }), `${c.name}: refused`).toBeNull();
      const dump = await dumpCanvasPaper(c);
      // A block drawn short of the right margin is read against the same case with it moved over by
      // SHIFT: what moved is the block's ink.
      const shifted = x + w < RIGHT
        ? await dumpCanvasPaper(blockCase(c.doc, block, { x: x + SHIFT, w }, c.config.pageFooter))
        : undefined;
      const { past, inked } = outOfBox(dump, x, w, shifted);
      expect(inked, `${c.name}: no ink read`).toBeGreaterThan(0);
      expect(past, `${c.name}: printed past its drawn right edge ${x + w}`).toEqual([]);
      const got = digest(dump);
      if (WRITE) {
        written[c.name] = got;
        return;
      }
      const want = frozen[c.name];
      expect(want, `${c.name}: not in the fixture`).toBeDefined();
      expect(canonical(got), `${c.name}: moved`).toBe(canonical(want));
    }, 60_000);
  }

  afterAll(() => {
    if (!WRITE) return;
    const missing = CASES.filter(({ c }) => !(c.name in written)).map(({ c }) => c.name);
    if (missing.length > 0) throw new Error(`not written: ${missing.length} case(s) did not run or failed, first ${missing[0]}`);
    const ordered = Object.fromEntries(CASES.map(({ c }) => [c.name, written[c.name]]));
    writeFileSync(FIXTURE, `${JSON.stringify(ordered, null, 1)}\n`);
  });
});

/** The rightmost stroke the flow traveler prints, its default layout, on the one-page record. */
async function flowReach(mutate: (c: TemplateConfig) => void, containerType?: string): Promise<number> {
  const raw = structuredClone(defaultConfigFor("TRAVELER"));
  mutate(raw);
  const config = validateConfig("TRAVELER", raw);
  expect(config.layout, "a flow config").toBeNull();
  const pdf = await renderSheetGroups(buildTravelerDefinitions(travelerRecord(containerType), config));
  return Math.max(...strokedLines(pdf).flat().map((s) => Math.max(s.x1, s.x2)));
}

describe("a flow table that overran before #991 prints inside the page", () => {
  // Before #991 these were pinned at their overruns (#971 design §8.4, report 1 §6): rules to 606.797
  // and to 630.695. The flow's tables now take the column clamp (#991, design 2026-11-17 §4.1), so
  // the quantities' rules end at the right margin. tests/flow-tables-in-box.test.ts holds the rest.
  it("prints the quantities inside 588 with Order Qty 168 wide (606.797 before #991)", async () => {
    const reach = await flowReach((c) => {
      const field = c.sections.find((s) => s.key === "quantities")!.fields.find((f) => f.key === "order_qty")!;
      field.width = 168;
    });
    expect(reach).toBeLessThanOrEqual(588 + 0.001);
  });

  it("prints the quantities inside 588 with a 30-character unbroken container type (630.695 before #991)", async () => {
    expect(await flowReach(() => {}, "WIREMESHBASKETEXTRAHEAVYDUTY30")).toBeLessThanOrEqual(588 + 0.001);
  });
});
