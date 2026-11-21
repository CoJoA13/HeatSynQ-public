import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TravelerProvider } from "@/app/orders/[id]/DocumentsSection";
import { LoadsSection } from "@/app/orders/[id]/LoadsSection";
import { decimalRefusal, decimalSentence } from "@/lib/decimal-entry";
import { LOAD_NET_WEIGHT } from "@/lib/order-boxes";
import { createOrderBulkSource } from "@/lib/order-bulk-recovery";
import { jsxTags } from "./helpers/jsx-source";
import { headingRowsOf } from "./helpers/markup";
import { all, run } from "./helpers/source-lift";
vi.mock("next/navigation", () => ({ usePathname: () => "/orders/order-1", useRouter: () => ({ replace: () => {} }) }));
const recoverySource = createOrderBulkSource(async () => { throw new Error("SSR must not read recovery"); }, async () => { throw new Error("SSR must not read access"); });

// #41: the printed-traveler warning must be visible the moment the loads editor renders — it is
// derived from ORDER STATE (`OrderDetail.travelerPrinted`, computed server-side and pinned in
// orders.test.ts), not from a save's answer. The repo has no DOM test env (practice-banner
// .test.tsx's own precedent), so the section renders to static markup — initial hook state is all
// the notice depends on — and the assertion is on the element tree's text, not pixels.

const editGate = { allowed: true, disabled: false, title: undefined };
const applyMutation = async () => {};

function render(travelerPrinted: boolean, scannedLoad: string | null = null, scanStatus: "loading" | "ready" | "failed" = "ready"): string {
  return renderToStaticMarkup(
    <TravelerProvider orderId="order-1" loads={[]} voided={false} viewGate={editGate} autoPrint={false}><LoadsSection onRefresh={async () => {}} recoverySource={recoverySource}
      orderId="order-1"
      loads={[{ id: "load-1", loadNumber: 1, qty: 40, weight: 540 }]}
      travelerPrinted={travelerPrinted}
      scannedLoad={scannedLoad}
      scanStatus={scanStatus}
      editGate={editGate}
      applyMutation={applyMutation}
    /></TravelerProvider>,
  );
}

describe("LoadsSection (#41 — the printed-traveler notice)", () => {
  it("shows the reprint notice on first render when a traveler has already printed", () => {
    expect(render(true)).toContain("A traveler has already printed");
  });

  it("shows no notice when no traveler has printed", () => {
    expect(render(false)).not.toContain("A traveler has already printed");
  });
});

describe("LoadsSection #318 scan identity", () => {
  it("waits for recovery to supply the actual displayed row before claiming a match", () => {
    const html = render(false, "1");
    expect(html).not.toContain('aria-current="true"');
    expect(html).not.toContain("highlighted below");
    expect(html).toContain("Waiting for saved Load 1 in the editor");
  });
  it.each(["2", "0", "01", "1-extra"])("does not highlight a different load for %s", term => {
    const html = render(false, term);
    expect(html).not.toContain('aria-current="true"');
    expect(html).toMatch(/Invalid load number|no longer present/);
  });
  it.each(["loading", "failed"] as const)("does not identify cached rows while scan refresh is %s", status => {
    const html = render(false, "1", status);
    expect(html).not.toContain('aria-current="true"');
    expect(html).not.toContain("highlighted below");
  });
});

// The weight words of the Loads grid (the weights design §11.3: O9, G10 to G12, and the spoken
// names it keeps). Three kinds of proof, each as far as vitest reaches with no DOM.
// 1. The heading row is read from the static render. The first render draws the table's headings
//    and no row: the grid's rows come from the draft store, which a static render does not read.
// 2. So the boxes' spoken names are read from the section's source, as they are written there.
// 3. A static render runs no handler. `buildPayload` is lifted from the section's source by its
//    name and run over `rows` and `onError`, the two names of the component it reads.
const FILE = "src/app/orders/[id]/LoadsSection.tsx";

type LoadRow = { loadNumber: string; qty: string; weight: string };
/** Load 1 of 40 pieces and 540 lb, as the grid holds a row: the text of each box. */
const loadRow = (over: Partial<LoadRow> = {}): LoadRow => ({ loadNumber: "1", qty: "40", weight: "540", ...over });

/** The section's own `buildPayload` run over `rows`: what it answers, and each thing it hands the banner. */
function saveCheck(rows: LoadRow[]): { payload: unknown; said: (string | null)[] } {
  const path = fileURLToPath(new URL(`../${FILE}`, import.meta.url));
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = all(source, ts.isFunctionDeclaration).filter((f) => f.name?.text === "buildPayload");
  if (found.length !== 1) throw new Error(`Expected one function buildPayload in ${FILE}, found ${found.length}`);
  const said: (string | null)[] = [];
  const payload = run<() => unknown>(found[0].getText(source), {
    rows, onError: (message: string | null) => { said.push(message); },
    decimalRefusal, decimalSentence, LOAD_NET_WEIGHT,
  })();
  return { payload, said };
}

describe("LoadsSection: the weight words (weights design §11)", () => {
  it("heads the grid Load #, Qty, Net weight (lb), Traveler, Actions", () => {
    expect(headingRowsOf(render(false))).toEqual([["Load #", "Qty", "Net weight (lb)", "Traveler", "Actions"]]);
  });

  it("draws its heading row and no load row on a first render", () => {
    // One <tr> in the whole section, the heading row: the fixture's load 1 is not drawn.
    expect(render(false).match(/<tr\b/g)).toHaveLength(1);
  });

  it("keeps each box's spoken name", () => {
    const names = jsxTags(FILE).filter((tag) => tag.name === "input").map((tag) => tag.attr("aria-label"));
    expect(names).toEqual(["`Load ${i + 1} number`", "`Load ${i + 1} quantity`", "`Load ${i + 1} weight`"]);
  });

  it.each<[string, LoadRow[], string]>([
    ["a load with no quantity whose weight is zero (G10)", [loadRow({ qty: "", weight: "0" })],
      "Load 1, Net weight (lb): must be greater than zero."],
    ["a load with a quantity whose weight is under zero (G11)", [loadRow({ weight: "-1" })],
      "Load 1, Net weight (lb): cannot be negative."],
    ["a second load with neither figure (G12)", [loadRow(), loadRow({ loadNumber: "2", qty: "", weight: "" })],
      "Load 2: needs a quantity, a net weight, or both."],
  ])("refuses %s with its whole sentence, and answers no payload", (_what, rows, sentence) => {
    expect(saveCheck(rows)).toEqual({ payload: null, said: [sentence] });
  });

  it.each<[string, LoadRow[], string]>([
    ["a weight that is not a number", [loadRow({ weight: "abc" })], "Load 1, Net weight (lb): enter a number without $ or commas, such as 0.36."],
    ["a weight with three decimals", [loadRow({ weight: "1.005" })], "Load 1, Net weight (lb): use at most 2 digits after the point."],
    ["a weight past the column", [loadRow({ weight: "10000000000" })], "Load 1, Net weight (lb): must be less than 10,000,000,000."],
    ["a weight with no quantity that is not a number", [loadRow({ qty: "", weight: "abc" })], "Load 1, Net weight (lb): enter a number without $ or commas, such as 0.36."],
    ["a weight under zero with no quantity", [loadRow({ qty: "", weight: "-1" })], "Load 1, Net weight (lb): cannot be negative."],
  ])("names the rule's own sentence for %s", (_what, rows, sentence) => {
    expect(saveCheck(rows)).toEqual({ payload: null, said: [sentence] });
  });

  it("lists every refusal of every load at once, each load's checks in field order, the numbering line last", () => {
    const { payload, said } = saveCheck([
      loadRow({ loadNumber: "0", qty: "1.5", weight: "-1" }),
      loadRow({ loadNumber: "2", qty: "", weight: "0" }),
      loadRow({ loadNumber: "2", qty: "", weight: "" }),
    ]);
    expect(payload).toBeNull();
    expect(said).toEqual([[
      "Load 1: load # must be a whole number of at least 1.",
      "Load 1: quantity must be a whole number of at least 1.",
      "Load 1, Net weight (lb): cannot be negative.",
      "Load 2, Net weight (lb): must be greater than zero.",
      "Load 3: needs a quantity, a net weight, or both.",
      "Load numbers must be 1..N with no gaps or repeats — try Renumber.",
    ].join("\n")]);
  });

  it("passes a load with a quantity and a weight, and hands the banner nothing", () => {
    expect(saveCheck([loadRow()])).toEqual({ payload: [{ loadNumber: 1, qty: 40, weight: "540" }], said: [] });
  });
});
