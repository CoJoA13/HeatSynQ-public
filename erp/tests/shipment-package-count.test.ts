// A saved shipment's Package count box on blur (#653): ShipmentDetail's own `commitPackageCount`,
// lifted from the page's source and run over a hand-built environment (the
// shipment-freight-amount.test.ts shape), so the function under test is the one the page runs.
// A refused value used to stay in the box, unregistered, while the bill of lading printed the
// stored count: CLAUDE.md allows a blur-save to roll back and register nothing, or keep the value
// and register the section, and this box did neither. It now restores the STORED value, not the
// guard's `atFocus`: a null count's box shows the container sum, and restoring that text would
// turn a tracking null into a literal that stops following the container rows.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { all, run } from "./helpers/source-lift";
import { jsxTags } from "./helpers/jsx-source";

const RELATIVE = "src/app/shipping/[id]/ShipmentDetail.tsx";
const PATH = fileURLToPath(new URL(`../${RELATIVE}`, import.meta.url));
const text = readFileSync(PATH, "utf8");
const file = ts.createSourceFile(PATH, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const page = file.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "ShipmentDetail");
const commit = page && all(page, ts.isFunctionDeclaration).find((f) => f.name?.text === "commitPackageCount");

type Shipper = { id: string; packageCount: number | string | null; route: string };

/** One blur of the box: the typed `value`, with the server's last adopted count `stored` and the
 *  shipment as the page held it, the typed text in it. Returns what the page did. */
function blur(value: string, stored: number | null) {
  if (!commit) throw new Error("ShipmentDetail.commitPackageCount is missing");
  let shipper: Shipper | null = { id: "ship-1", packageCount: value, route: "R-1" };
  const setShipper = vi.fn((next: Shipper | null | ((cur: Shipper | null) => Shipper | null)) => {
    shipper = typeof next === "function" ? next(shipper) : next;
  });
  const setError = vi.fn(); const patchHeader = vi.fn(async () => true);
  const storedPackageCount = { current: stored };
  const fn = run<(value: string) => void>(commit.getText(file), {
    setShipper, setError, patchHeader, storedPackageCount,
    // What a blank box answers the guard's Enter (the container sum it then shows); not judged here.
    shipper: { orders: [] }, containerSumOf: () => 0,
  });
  fn(value);
  return { shipper, setShipper, setError, patchHeader };
}

describe("ShipmentDetail: the Package count box on blur", () => {
  it.each([["2.5", 3], ["-3", 3], ["abc", 0]])("refuses %j: the box goes back to the stored count %j, the banner says so, and nothing is sent", (value, stored) => {
    const done = blur(value, stored);
    expect(done.patchHeader).not.toHaveBeenCalled();
    expect(done.setError.mock.calls).toEqual([["Package count must be a whole number of at least 0."]]);
    expect(done.setShipper).toHaveBeenCalledOnce();
    expect(done.shipper).toEqual({ id: "ship-1", packageCount: stored, route: "R-1" });
  });

  it("a refused value over a null count restores the null, so the box shows the container sum again", () => {
    const done = blur("1.5", null);
    expect(done.patchHeader).not.toHaveBeenCalled();
    expect(done.shipper).toEqual({ id: "ship-1", packageCount: null, route: "R-1" });
  });

  it.each([["4", 4], [" 0 ", 0]])("saves %j as %j through patchHeader, and writes nothing else", (value, sent) => {
    const done = blur(value, 3);
    expect(done.patchHeader.mock.calls).toEqual([[{ packageCount: sent }]]);
    expect(done.setError).not.toHaveBeenCalled();
    expect(done.setShipper).not.toHaveBeenCalled();
  });

  it("a blank box clears the count", () => {
    const done = blur("  ", 3);
    expect(done.patchHeader.mock.calls).toEqual([[{ packageCount: null }]]);
  });

  it("the stored count is noted beside every applyPayload adoption of the shipment, and the box blurs through the guard", () => {
    const adoptions = text.split("setShipper(editGuard.applyPayload(res.shipper));").length - 1;
    const noted = text.split("storedPackageCount.current = res.shipper.packageCount;").length - 1;
    expect(adoptions).toBeGreaterThan(0);
    expect(noted).toBe(adoptions);
    const boxes = jsxTags(RELATIVE)
      .filter((tag) => tag.name === "input" && /\bpackageCount:/.test(tag.attr("onChange") ?? ""));
    expect(boxes.map((tag) => [tag.attr("onFocus"), tag.attr("onBlur")])).toEqual([
      ['editGuard.onFocusField("packageCount")', "(e) => editGuard.onBlurSave(e, commitPackageCount)"]]);
  });
});
