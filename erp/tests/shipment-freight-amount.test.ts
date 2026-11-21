// A saved shipment's Freight amount box on blur (#517, owner answer 4): ShipmentDetail's own
// `commitFreightAmount`, lifted from the page's source and run over a hand-built environment
// (tests/helpers/source-lift.ts says why), so the function under test is the one the page runs.
// The edit guard hands it the typed text and the figure the box was given (`atFocus`); what the
// guard hands is held in tests/use-edit-guard.test.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { all, run } from "./helpers/source-lift";
import { jsxTags } from "./helpers/jsx-source";
import { decimalRefusal } from "../src/lib/decimal-entry";
import { FREIGHT_AMOUNT } from "../src/lib/shipment-boxes";

const PATH = fileURLToPath(new URL("../src/app/shipping/[id]/ShipmentDetail.tsx", import.meta.url));
const file = ts.createSourceFile(PATH, readFileSync(PATH, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const page = file.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "ShipmentDetail");
const commit = page && all(page, ts.isFunctionDeclaration).find((f) => f.name?.text === "commitFreightAmount");

type Shipper = { id: string; freightAmount: number | string | null; route: string };

/** One blur of the box: the typed `value`, the stored figure as the box was given it (`atFocus`),
 *  and the shipment as the page held it with the typed text in it. Returns what the page did. */
function blur(value: string, atFocus: string) {
  if (!commit) throw new Error("ShipmentDetail.commitFreightAmount is missing");
  let shipper: Shipper | null = { id: "ship-1", freightAmount: value, route: "R-1" };
  const setShipper = vi.fn((next: Shipper | null | ((cur: Shipper | null) => Shipper | null)) => {
    shipper = typeof next === "function" ? next(shipper) : next;
  });
  const setError = vi.fn(); const patchHeader = vi.fn(async () => true);
  const fn = run<(value: string, atFocus: string) => void>(commit.getText(file),
    { decimalRefusal, FREIGHT_AMOUNT, setShipper, setError, patchHeader });
  fn(value, atFocus);
  return { shipper, setShipper, setError, patchHeader };
}

describe("ShipmentDetail: the Freight amount box on blur", () => {
  it.each([
    ["-1", "125.5", "Freight amount: cannot be negative."],
    ["$12", "125.5", "Freight amount: enter a number without $ or commas, such as 0.36."],
    ["1e2", "", "Freight amount: enter a number without $ or commas, such as 0.36."],
    ["12.345", "0", "Freight amount: use at most 2 digits after the point."],
    ["10000000000", "125.5", "Freight amount: must be less than 10,000,000,000."],
  ])("refuses %j: the box goes back to the stored figure %j, the banner names it, and nothing is sent", (value, atFocus, error) => {
    const done = blur(value, atFocus);
    expect(done.patchHeader).not.toHaveBeenCalled();
    expect(done.setError.mock.calls).toEqual([[error]]);
    // One write of the page's state: the stored figure back in the box, every other field as it was.
    expect(done.setShipper).toHaveBeenCalledOnce();
    expect(done.shipper).toEqual({ id: "ship-1", freightAmount: atFocus, route: "R-1" });
  });

  it.each([[".36", ".36"], [" 125.50 ", "125.50"], ["0", "0"]])("saves %j as %j through patchHeader, and writes nothing else", (value, sent) => {
    const done = blur(value, "125.5");
    expect(done.patchHeader.mock.calls).toEqual([[{ freightAmount: sent }]]);
    expect(done.setError).not.toHaveBeenCalled();
    expect(done.setShipper).not.toHaveBeenCalled();
  });

  it("a blank box still clears the freight", () => {
    for (const value of ["", "   "]) {
      const done = blur(value, "125.5");
      expect(done.patchHeader.mock.calls).toEqual([[{ freightAmount: null }]]);
      expect(done.setError).not.toHaveBeenCalled();
    }
  });

  it("the box hands its blur to commitFreightAmount through the edit guard, which passes the figure the box was given", () => {
    // The guard's `onBlurSave` calls its commit with (typed text, newest snapshot): the page passes
    // the function itself, so the second argument reaches `atFocus` unchanged.
    const boxes = jsxTags("src/app/shipping/[id]/ShipmentDetail.tsx")
      .filter((tag) => tag.name === "input" && /\bfreightAmount:/.test(tag.attr("onChange") ?? ""));
    expect(boxes.map((tag) => [tag.attr("onFocus"), tag.attr("onBlur")])).toEqual([
      ['editGuard.onFocusField("freightAmount")', "(e) => editGuard.onBlurSave(e, commitFreightAmount)"]]);
  });
});
