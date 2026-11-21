// What every shared Save button is handed (#483, #487). SaveButton titles its button from the gate
// first, so a grid's recovery beat reaches the button only through the gate it is handed: on the
// order hub and the saved shipment page that is `gridGate(pageGate, grid.mode)`
// (src/lib/shipment-gates.ts), and on the invoice page its own `recoveryGate` (owner answer 7,
// 2026-10-16). The button has no recovery flag of its own any more, so a site that hands it a raw
// page gate shows "No unsaved changes" over a grid that is still loading.
//
// Parsed from the source (tests/helpers/jsx-source.ts), walked from src/ rather than hand-listed,
// and compared against literals, so a reader that finds nothing fails here.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jsxTags } from "./helpers/jsx-source";

const ERP = fileURLToPath(new URL("../", import.meta.url));
/** Every `<SaveButton>` under src/, as [file, tag], in path order and then source order. */
const sites = (readdirSync(join(ERP, "src"), { recursive: true, encoding: "utf8" }) as string[])
  .filter((path) => path.endsWith(".tsx"))
  .sort()
  .flatMap((path) => {
    const file = join("src", path);
    return jsxTags(file).filter((tag) => tag.name === "SaveButton").map((tag) => [file, tag] as const);
  });
const HUB = "src/app/orders/[id]/";

describe("the shared Save button: what each of its eight sites hands it", () => {
  it("is used at exactly eight sites: the order hub's four grids, the shipment panel's three and the invoice's lines", () => {
    expect(sites.map(([file, tag]) => [file, tag.attr("label")])).toEqual([
      ["src/app/invoicing/[id]/InvoiceDetail.tsx", "Save lines"],
      [`${HUB}ChargesSection.tsx`, "Save charges"],
      [`${HUB}ContainersSection.tsx`, "Save containers"],
      [`${HUB}LoadsSection.tsx`, "Save loads"],
      [`${HUB}SerialsSection.tsx`, "Save serials"],
      ["src/app/shipping/[id]/ShipmentOrderPanel.tsx", "Save lines"],
      ["src/app/shipping/[id]/ShipmentOrderPanel.tsx", "Save containers"],
      ["src/app/shipping/[id]/ShipmentOrderPanel.tsx", "Save serials"],
    ]);
  });

  it("each grid's recovery beat reaches its Save through the gate: gridGate on the hub and the shipment panel, the invoice's own recoveryGate", () => {
    expect(sites.map(([, tag]) => tag.attr("gate"))).toEqual([
      "recoveryGate",
      "gridGate(editGate, grid.mode)",
      "gridGate(editGate, grid.mode)",
      "gridGate(editGate, grid.mode)",
      "gridGate(editGate, grid.mode)",
      "gridGate(saveGate, grid.mode)",
      "recoveryGate",
      "recoveryGate",
    ]);
  });

  it("no site hands it a recovery flag of its own", () => {
    expect(sites.filter(([, tag]) => tag.attr("recoveryReady") !== undefined).map(([file]) => file)).toEqual([]);
  });

  it("only the hub's Serials hands it work it cannot save, so the sentence for that work can name serials", () => {
    // `saveButtonTitle` answers ENTRY_NOT_ADDED ("Add or clear the typed serials first") for a
    // clean grid holding such work. A second site passing `alsoUnsaved` would be told to add serials.
    expect(sites.filter(([, tag]) => tag.attr("alsoUnsaved") !== undefined).map(([file, tag]) => [file, tag.attr("alsoUnsaved")]))
      .toEqual([[`${HUB}SerialsSection.tsx`, 'rangeInput !== ""']]);
  });
});
