import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The committed manual, checked as an ARTIFACT (#169 fix round).
 *
 * `npm run manual:capture` and `npm run manual:build` were both unguarded: nothing in CI ran
 * either, and no test looked at what they had produced. The build's own ceiling check only fires
 * when someone runs the build, and the capture scale had no check at all — which is how
 * `DEVICE_SCALE` and `build-manual.mjs`'s display factor stayed silently coupled for a whole phase
 * (Task 5's report recorded that as "the untested half of a coupled pair").
 *
 * These are deliberately cheap: no browser, no database, no build. They read the committed bytes
 * in `docs/manual/` and the two source constants those bytes are supposed to satisfy. The third
 * guard — that a rebuild is a no-op diff — cannot be a unit test (it would rewrite a tracked file
 * mid-suite), so it lives in the `ci` job's `ops/github/ci/ci.sh` instead.
 */

const ERP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(ERP_ROOT, "..");
const MANUAL_DIR = path.join(REPO_ROOT, "docs", "manual");
const IMG_DIR = path.join(MANUAL_DIR, "img");

/** Pull a constant out of a harness that cannot be imported — both files run at module scope. */
function sourceConstant(file: string, re: RegExp): string {
  const src = readFileSync(path.join(ERP_ROOT, file), "utf8");
  const m = src.match(re);
  if (!m) throw new Error(`${file}: ${re} matched nothing — the constant was renamed or reshaped`);
  return m[1];
}

/** Intrinsic size straight out of a PNG's IHDR — the same 24-byte read `build-manual.mjs` does. */
function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  if (buf.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Figures allowed to be wider than the capture viewport, each with its reason and issue. This is an
 * EXEMPTION LIST, not a raised bound: an over-wide figure must be a decision, not a drift.
 *
 * Currently EMPTY, and that is the healthy state. Its one occupant, `invoicing-detail.png`, was the
 * #170 symptom — the invoice History panel printed raw snapshot JSON unwrapped, so the page
 * overflowed horizontally. #170 fixed the render (the diff value now wraps and scrolls in its own
 * box, `src/components/HistoryPanel.tsx`) and added the live capture-time guard pinned below, so the
 * re-captured figure came back at 1440 and the entry was deleted. An entry here is a standing
 * over-wide figure waiting to be fixed, not a resting place.
 */
const OVER_WIDE: Record<string, string> = {};

describe("the committed manual page", () => {
  it("is under the publishing ceiling build-manual.mjs states", () => {
    const limitMb = Number(
      sourceConstant("scripts/build-manual.mjs", /const PUBLISH_LIMIT = (\d+) \* 1024 \* 1024;/),
    );
    expect(limitMb).toBe(16);
    const limit = limitMb * 1024 * 1024;

    const bytes = statSync(path.join(ERP_ROOT, "public", "manual.html")).size;
    // Reported either way: the margin is the number to spend when adding figures, and a test that
    // only says "pass" tells whoever is adding one nothing.
    console.log(
      `manual.html: ${bytes.toLocaleString()} B of ${limit.toLocaleString()} ` +
        `(${((bytes / limit) * 100).toFixed(1)}%, ${(limit - bytes).toLocaleString()} B left)`,
    );
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(limit);
  });
});

describe("the committed manual figures", () => {
  const files = readdirSync(IMG_DIR).filter((f) => f.endsWith(".png")).sort();

  it("has figures at all — the width sweep below must not pass vacuously", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  /**
   * The capture-scale pin, taken from the ARTIFACT rather than from a browser. `manual:capture`
   * writes at `deviceScaleFactor` 1 on a 1440px viewport (#169), so a full-page shot is 1440
   * physical px wide. Put the scale back to 2 and every figure here becomes 2880 — which is
   * exactly the regression that pushed `manual.html` past the publish ceiling and made an
   * undocumented ImageMagick pass load-bearing.
   */
  it("were all captured at deviceScaleFactor 1 — no figure is wider than the viewport", () => {
    const viewportWidth = Number(
      sourceConstant("e2e/manual-capture.mjs", /const VIEWPORT = \{ width: (\d+),/),
    );
    expect(viewportWidth).toBe(1440);

    const tooWide: string[] = [];
    for (const f of files) {
      if (f in OVER_WIDE) continue;
      const size = pngSize(readFileSync(path.join(IMG_DIR, f)));
      expect(size, `${f} is not a readable PNG`).not.toBeNull();
      if (size!.width > viewportWidth) tooWide.push(`${f} (${size!.width}×${size!.height})`);
    }
    expect(
      tooWide,
      `wider than the ${viewportWidth}px capture viewport — re-capture with MANUAL_SCALE unset ` +
        `(#169), or add a documented entry to OVER_WIDE if the page genuinely overflows`,
    ).toEqual([]);
  });

  it("carries no stale over-wide exemption", () => {
    const viewportWidth = Number(
      sourceConstant("e2e/manual-capture.mjs", /const VIEWPORT = \{ width: (\d+),/),
    );
    for (const [name, reason] of Object.entries(OVER_WIDE)) {
      expect(files, `${name} is exempted but no longer exists — drop the entry`).toContain(name);
      const size = pngSize(readFileSync(path.join(IMG_DIR, name)));
      expect(
        size!.width,
        `${name} no longer exceeds ${viewportWidth}px — the exemption (${reason}) is stale, delete it`,
      ).toBeGreaterThan(viewportWidth);
    }
  });

  /**
   * The height-cap pin, the same shape as the width pin above and for the same reason: nothing
   * else checks that `MAX_SHOT_HEIGHT` is honoured. It was silently NOT honoured for phases — a
   * bare `clip` resolves against the viewport — and when the fix landed, the number itself had
   * never been priced (#169). Re-sizing it is now a decision that shows up here: lower it and this
   * stays green only after a re-capture, raise it and the figures it lets through are the ones
   * whoever raised it chose to pay for.
   */
  it("respects the capture harness's MAX_SHOT_HEIGHT", () => {
    const cap = Number(sourceConstant("e2e/manual-capture.mjs", /const MAX_SHOT_HEIGHT = (\d+);/));
    expect(cap).toBeGreaterThan(0);

    const tooTall: string[] = [];
    for (const f of files) {
      const size = pngSize(readFileSync(path.join(IMG_DIR, f)));
      expect(size, `${f} is not a readable PNG`).not.toBeNull();
      if (size!.height > cap) tooTall.push(`${f} (${size!.width}×${size!.height})`);
    }
    expect(
      tooTall,
      `taller than MAX_SHOT_HEIGHT (${cap}) — re-run npm run manual:capture, or change the ` +
        `constant deliberately and price it (its docstring carries the measurement)`,
    ).toEqual([]);
  });

  it("is captured by a harness whose scale default is still 1", () => {
    // Belt to the artifact's braces: this reds the moment someone changes the DEFAULT, before any
    // re-capture has happened, and names the file to look at.
    const scale = sourceConstant(
      "e2e/manual-capture.mjs",
      /const DEVICE_SCALE = Number\(process\.env\.MANUAL_SCALE \?\? (\d+)\);/,
    );
    expect(scale).toBe("1");
  });

  /**
   * The RUNTIME half of the width guard (#170). The two width tests above are the committed-bytes
   * backstop — they red only once an over-wide PNG has been captured AND committed. This pins the
   * live gate that stops such a PNG being produced in the first place: `shoot()` measures the page's
   * scrollWidth, marks the row `overWide` when it exceeds the viewport, and `statusOf` treats that
   * as a FAIL so the run exits non-zero. #170 (the invoice History panel's unwrapped JSON) reached
   * the published manual reported PASS precisely because no such live gate existed. A refactor that
   * drops any of the three pieces reds here, naming the file, rather than silently re-blinding the
   * capture to horizontal overflow.
   */
  it("gates the capture run on horizontal overflow, not just the committed artifact", () => {
    const src = readFileSync(path.join(ERP_ROOT, "e2e/manual-capture.mjs"), "utf8");
    // shoot() measures the page's own scroll width (not the viewport's clientWidth).
    expect(src, "shoot() must measure document scrollWidth").toContain(
      "width: document.documentElement.scrollWidth",
    );
    // The verdict is strict `>` against the same VIEWPORT.width the artifact pins use, so a fitting
    // page (exactly VIEWPORT.width) never trips it.
    expect(src, "the over-wide verdict must compare against VIEWPORT.width").toContain(
      "const overWide = width > VIEWPORT.width;",
    );
    // statusOf() must fold overWide into the FAIL condition, or the measurement gates nothing.
    const statusOf = src.match(/function statusOf\(row\)\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(statusOf, "statusOf() lost its body — the match reshaped").not.toBe("");
    expect(statusOf, "statusOf() must FAIL on row.overWide").toContain("row.overWide");
  });
});

/**
 * The capture tool's container row and its Pick lists picture (the weights design's §14.2), as far
 * as the tool's own text shows them. tests/manual-capture-steps.test.ts runs the three steps over a
 * stand-in page: those two, and the wait for the draft's status word (the design's §15.2), whose
 * place in the tool the last cases here hold. Nothing runs the tool in a check, and it cannot be
 * imported: it starts a server and a browser. So these cases read its source, as the cases above
 * read its constants, and each holds one thing that a run of the tool would otherwise be the first
 * to show.
 */
describe("the capture harness's container row and its Pick lists picture", () => {
  const src = readFileSync(path.join(ERP_ROOT, "e2e/manual-capture.mjs"), "utf8");
  /** One function of the tool, from its first line to the brace that closes it. */
  const fn = (firstLine: string): string => {
    const start = src.indexOf(firstLine);
    const end = src.indexOf("\n}\n", start);
    if (start < 0 || end < 0) throw new Error(`e2e/manual-capture.mjs: "${firstLine}" was not found. It was renamed or reshaped`);
    return src.slice(start, end + 2);
  };
  /** Where `text` sits in `body`. It must be there exactly once, or an order read off it means nothing. */
  const at = (body: string, text: string): number => {
    expect(body.split(text).length - 1, `${JSON.stringify(text)} must be in the function exactly once`).toBe(1);
    return body.indexOf(text);
  };
  const orderEntry = () => fn("async function captureOrderEntry(page, probe, ids, rows) {");
  const pickLists = () => fn("async function captureContainerTypes(page, probe, rows) {");

  it("arms the wait for the screen's container types before the filled form is opened", () => {
    const body = orderEntry();
    expect(at(body, "const offeredTypes = watchOfferedTypes(page);")).toBeLessThan(at(body, "await page.goto(url, "));
  });

  it("keys the container row after the quantity and before the first of the three pictures", () => {
    const body = orderEntry();
    const order = [
      'fill("30")',
      "await keyContainerRow(page, await offeredTypes())",
      'name: "Process & loads", exact: true }).click()',
      "Object.assign(row, await shoot(page, row.name));",
    ].map((text) => at(body, text));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("puts the step's notes on the filled row, and says a row is filled in only when one was keyed", () => {
    const body = orderEntry();
    expect(body).toContain("row.notes.push(...containerRow.notes);");
    expect(body).toContain("if (containerRow.keyed) row.label = CAPTURE_WORDS.filledWithRow;");
    expect(body).toContain('label: "Order entry with a customer and a part line filled in", notes: [],');
  });

  it("takes the Pick lists picture under the steps' own name and label, after the other interactions", () => {
    const body = pickLists();
    expect(body).toContain("const name = CONTAINER_TYPES_SHOT;");
    expect(body).toContain("label: CAPTURE_WORDS.containerTypes,");
    expect(body).toContain("Object.assign(row, await shoot(page, name));");
    const main = fn("async function main() {");
    expect(at(main, "await captureFilteredReport(page, probe, rows);"))
      .toBeLessThan(at(main, "await captureContainerTypes(page, probe, rows);"));
  });

  it("chooses the list through the step, and types in no box on Pick lists: a Tare each box there saves when it is left", () => {
    const body = pickLists();
    at(body, "const shown = await showContainerTypes(page);");
    // The last six are no typing: each unticks, presses, clears or sends an event.
    for (const typing of [".fill(", ".type(", ".press(", "keyboard", ".pressSequentially(", ".selectOption(", ".check(", ".setChecked(",
      ".uncheck(", ".click(", ".dblclick(", ".tap(", ".clear(", ".dispatchEvent("]) {
      expect(body, `captureContainerTypes must not hold ${typing}`).not.toContain(typing);
    }
  });

  it("refuses to type over a draft that was there first, and discards the draft its own typing saved", () => {
    const body = orderEntry();
    const refusal = "if (bannerAlreadyThere) {";
    const order = [
      "const bannerAlreadyThere = await visibleWithin(",
      refusal,
      "typed = true;",
      "await cust.fill(customerCode);",
      "if (typed) await discardOwnDraft(page, row);",
    ].map((text) => at(body, text));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // What the tool does when a draft was there first: the text up to the brace that closes the refusal.
    const refused = body.slice(order[1], body.indexOf("\n  }\n", order[1]));
    expect(refused.endsWith("return;"), "the refusal must end by leaving captureOrderEntry").toBe(true);
    for (const acting of [".fill(", ".click("]) {
      expect(refused, `the refusal must not hold ${acting}`).not.toContain(acting);
    }
  });

  it("imports from the steps file every name of that file it uses, and no name the file lacks", async () => {
    // Nothing else holds this: the tool is not type-checked, and the lint does not follow an import.
    const statement = src.match(/import \{([^}]*)\} from "\.\/lib\/manual-capture-steps\.mjs";\n/);
    if (!statement) throw new Error("e2e/manual-capture.mjs: its import of the steps file was not found");
    const imported = statement[1].split(",").map((name) => name.trim()).filter(Boolean);
    const steps: Record<string, unknown> = await import("../e2e/lib/manual-capture-steps.mjs");
    const rest = src.replace(statement[0], "");
    expect(imported.filter((name) => !(name in steps))).toEqual([]);
    expect(Object.keys(steps).filter((name) => new RegExp(`\\b${name}\\b`).test(rest) && !imported.includes(name))).toEqual([]);
  });

  it("leaves the first line of shoot() as e2e/manual-backup-folder.test.mjs cuts it", () => {
    expect(src).toContain("async function shoot(page, name, { tallWindow = false } = {}) {");
  });

  it("waits for the draft's status word after the tool's last keystroke, and before the wait for a quiet page and the first picture", () => {
    const body = orderEntry();
    const order = [
      'await page.getByLabel("PO number").first().fill("PO-DEMO-4471");',
      "const draftSaved = await waitForDraftSaved(page);",
      "const settled = await waitForContent(page, probe, []);",
      "Object.assign(row, await shoot(page, row.name));",
    ].map((text) => at(body, text));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("puts the wait's notes on the filled row", () => {
    at(orderEntry(), "row.notes.push(...draftSaved.notes);");
  });

  it("from the wait to the discard of its own draft, fills, types and picks nothing, and clicks only a tab", () => {
    const body = orderEntry();
    const rest = body.slice(at(body, "const draftSaved = await waitForDraftSaved(page);"), at(body, "if (typed) await discardOwnDraft(page, row);"));
    // The last five are no typing: each unticks, presses, clears or sends an event. A click is
    // counted below, apart.
    for (const typing of [".fill(", ".type(", ".press(", "keyboard", ".pressSequentially(", ".selectOption(", ".check(", ".setChecked(",
      ".uncheck(", ".dblclick(", ".tap(", ".clear(", ".dispatchEvent("]) {
      expect(rest, `after the wait, captureOrderEntry must not hold ${typing}`).not.toContain(typing);
    }
    expect(rest.split(".click(").length - 1, "one click after the wait").toBe(1);
    expect(rest).toContain('await page.getByRole("tab", { name: tab, exact: true }).click();');
  });
});
