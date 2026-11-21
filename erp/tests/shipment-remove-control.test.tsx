// #472 (R-Q1, R-Q2): Remove order is greyed up front, with the reason as its title.
// shipment-remove-gate.test.ts proves the decision. This file proves it reaches the rendered
// `disabled` and `title` attributes: on the button alone, then through the panel that mounts it.
// vitest has no DOM, so the click is the browser flows' to prove.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RemoveOrderButton, ShipmentOrderPanel } from "../src/app/shipping/[id]/ShipmentOrderPanel";
import { createBulkRecoveryAdapter, emptyBulkDraft, type BulkBaseline, type BulkRecoveryCustomization } from "../src/lib/bulk-grid-recovery";
import type { Gate } from "../src/lib/permission-ui";
import {
  shipmentBulkCustomization, shipmentContainersBaseline, shipmentLinesBaseline, shipmentSerialsBaseline,
} from "../src/lib/shipment-bulk-recovery";
import { removeOrderGate, removeOrderUnsavedSentence } from "../src/lib/shipment-gates";
import { NO_REPORTS, savedShipmentTotalsInput, shipmentTotals } from "../src/lib/shipment-totals";
import { shipmentOrderScope } from "../src/lib/unsaved-guard";
import { shipmentFixture } from "./helpers/remaining-bulk-fixtures";
import { openDraftHarness } from "./helpers/draft-store";

type Fields = Record<string, string>;
const seam = vi.hoisted(() => ({ views: [] as unknown[], index: 0, unsaved: [] as string[] }));
// Only the SSR subscription seam is supplied, in hook-call order (the shipment-recovery-access precedent).
vi.mock("../src/lib/use-recoverable-draft", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/use-recoverable-draft")>(),
  useRecoverableDraft: () => seam.views[seam.index++],
}));
// With no DOM the real hook can only give its server answer, which is always false. The panel's
// QUESTION is what is under test, so the answer is given here per scope. Every other export of the
// module is the real one, the SaveButton's registration included.
vi.mock("../src/lib/use-unsaved-section", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/use-unsaved-section")>(),
  useUnsavedInScope: (scope: string) => seam.unsaved.includes(scope),
}));
afterEach(() => { seam.views = []; seam.index = 0; seam.unsaved = []; });

const OPEN: Gate = { allowed: true, disabled: false, title: undefined };
const NO_EDIT: Gate = { allowed: false, disabled: true, title: "Requires shipping.edit" };
/** The server's sentence for printed paper on Packing List 5001. */
const PAPER = "Shipment paper covering this order has already printed (Packing List 5001) — void the shipment instead of removing it.";

/** The Remove order button's own opening tag, so `disabled` and `title` are read off the control
 *  and not off any attribute in the markup. Also asserts it is rendered, and rendered once: a
 *  grid row's button reads "Remove", never "Remove order". */
function removeTag(html: string): string {
  const tags: string[] = html.match(/<button\b[^>]*>(?=Remove order<\/button>)/g) ?? [];
  expect(tags).toHaveLength(1);
  return tags[0];
}
/** The attribute, not the word: React renders a true boolean attribute as `disabled=""`
 *  (shipment-reverse-control.test.tsx carries the reason). */
const isDisabled = (tag: string) => /\sdisabled=""/.test(tag);
/** React escapes an apostrophe inside an attribute, and the unsaved sentence carries one. */
const titleOf = (tag: string) => tag.match(/\stitle="([^"]*)"/)?.[1]?.replace(/&#x27;/g, "'");

const button = (gate: Gate) => removeTag(renderToStaticMarkup(<RemoveOrderButton gate={gate} onClick={() => {}} />));

const adapterFor = (kind: "lines" | "containers" | "serials") => createBulkRecoveryAdapter<Fields>(
  `shipment-${kind}`, `shipment-${kind}-v1`, shipmentBulkCustomization(kind) as BulkRecoveryCustomization<Fields>);
/** The saved page's panel over the fixture's one order: shipper order `so-1`, order `order-1`,
 *  label `101-1`, as markup. `removeRefusal` is left off the element when the argument is omitted. */
function panelMarkup(editGate: Gate, removeRefusal?: string | null): string {
  const fixture = shipmentFixture();
  const view = (kind: "lines" | "containers" | "serials", baseline: BulkBaseline<Fields>) =>
    openDraftHarness(adapterFor(kind), emptyBulkDraft<Fields>(), baseline).binding.getSnapshot();
  seam.views = [view("lines", shipmentLinesBaseline(fixture, "so-1")), view("containers", shipmentContainersBaseline(fixture, "so-1")),
    view("serials", shipmentSerialsBaseline(fixture, "so-1"))];
  seam.index = 0;
  const refusal = removeRefusal === undefined ? {} : { removeRefusal };
  return renderToStaticMarkup(<ShipmentOrderPanel shipperId="ship-1" order={fixture.shipper.orders[0]}
    recoverySource={{ read: async () => ({ record: fixture.shipper, access: fixture.permissions }), register: vi.fn(), begin: vi.fn() }}
    editGate={editGate} linesGate={OPEN} creditHoldReason="" applyMutation={async run => { await run(); }} onRemove={() => {}}
    {...refusal}
    printGate={OPEN} printing={false} certsGate={OPEN} onPrintTicket={() => {}} totals={shipmentTotals(savedShipmentTotalsInput(fixture.shipper.orders, NO_REPORTS)).orders[0]} onTotalsReport={() => {}} />);
}
/** That panel's Remove order button, as its opening tag. */
const panelButton = (editGate: Gate, removeRefusal?: string | null) => removeTag(panelMarkup(editGate, removeRefusal));

describe("the Remove order button (#472)", () => {
  it("renders open with no title when nothing refuses", () => {
    const tag = button(removeOrderGate(OPEN, null, false, "101-1"));
    expect(isDisabled(tag)).toBe(false);
    expect(titleOf(tag)).toBeUndefined();
  });

  it("renders greyed with the server's refusal as its title", () => {
    const tag = button(removeOrderGate(OPEN, PAPER, false, "101-1"));
    expect(isDisabled(tag)).toBe(true);
    expect(titleOf(tag)).toBe(PAPER);
  });

  it("renders greyed with the unsaved sentence, apostrophe and all", () => {
    const tag = button(removeOrderGate(OPEN, null, true, "101-1"));
    expect(isDisabled(tag)).toBe(true);
    expect(titleOf(tag)).toBe(removeOrderUnsavedSentence("101-1"));
  });

  it("keeps a closed page gate's own title", () => {
    const tag = button(removeOrderGate(NO_EDIT, PAPER, true, "101-1"));
    expect(isDisabled(tag)).toBe(true);
    expect(titleOf(tag)).toBe("Requires shipping.edit");
  });
});

describe("the order panel's Remove order button (#472)", () => {
  it("is open with no title when the page hands it no refusal, absent or null", () => {
    for (const tag of [panelButton(OPEN), panelButton(OPEN, null)]) {
      expect(isDisabled(tag)).toBe(false);
      expect(titleOf(tag)).toBeUndefined();
    }
  });

  it("is greyed with the refusal the page hands it", () => {
    const tag = panelButton(OPEN, PAPER);
    expect(isDisabled(tag)).toBe(true);
    expect(titleOf(tag)).toBe(PAPER);
  });

  it("asks about its own order's grids, by the shipper order's id", () => {
    seam.unsaved = [shipmentOrderScope("so-1")];
    const tag = panelButton(OPEN);
    expect(isDisabled(tag)).toBe(true);
    expect(titleOf(tag)).toBe(removeOrderUnsavedSentence("101-1"));
  });

  it("is not greyed by another order's unsaved grids, nor by a scope spelled with the order's id", () => {
    seam.unsaved = [shipmentOrderScope("so-2"), shipmentOrderScope("order-1")];
    const tag = panelButton(OPEN);
    expect(isDisabled(tag)).toBe(false);
    expect(titleOf(tag)).toBeUndefined();
  });

  it("puts the page's refusal above unsaved work", () => {
    seam.unsaved = [shipmentOrderScope("so-1")];
    expect(titleOf(panelButton(OPEN, PAPER))).toBe(PAPER);
  });

  it("keeps a closed page gate's own reason over both", () => {
    seam.unsaved = [shipmentOrderScope("so-1")];
    const tag = panelButton(NO_EDIT, PAPER);
    expect(isDisabled(tag)).toBe(true);
    expect(titleOf(tag)).toBe("Requires shipping.edit");
  });

  // The button and its message share one block at the right of the heading row. The row wraps, and
  // a long refusal puts the block on a row of its own. A lone flex item under `justify-between`
  // sits at the START of its row, so the block carries its own `ml-auto`: an auto margin takes the
  // row's free space whichever row the block is on. vitest lays nothing out, so what is pinned is
  // the class. Where the block lands is a browser's to show.
  it("sits in a block that keeps to the right edge of the heading row, also when it wraps onto a row of its own", () => {
    const html = panelMarkup(OPEN, PAPER);
    const rows = [...html.matchAll(/<div class="([^"]*)"><h3\b/g)].map((m) => m[1]);
    expect(rows).toEqual(["mb-3 flex flex-wrap items-center justify-between gap-2"]);
    const blocks = [...html.matchAll(/<div class="([^"]*)"><button\b[^>]*>Remove order<\/button>/g)].map((m) => m[1]);
    expect(blocks).toEqual(["ml-auto text-right"]);
  });
});
