// erp/tests/order-totals.test.ts
import { describe, expect, it } from "vitest";
import {
  ORDER_TOTALS_CAPTION, ORDER_TOTALS_COLUMNS, UNSAVED_TOTALS, orderTotals, savedOrderTotalsInput, statedPieces,
  weighedFigure, type OrderTotalsInput, type OrderTotalsView, type TotalsContainer, type WeighedOrder,
} from "@/lib/order-totals";
import type { OrderDetail } from "@/app/orders/[id]/page";
import type { ContainerFields } from "@/lib/order-bulk-recovery";

// The order totals table and the strip's weight figure (the weights design §10.2 and §10.3).
// Hand-calculated orders. The cells are compared as a whole view: twelve cells, the note and the
// weighed lines. The weighed lines are compared as a whole list. So a reworded cell, a figure in a
// cell the design leaves empty and a sentence that should not show each turn a named case red.
// No server, no database and no renderer are needed.

/** Order 1004 of the demonstration dataset as the weights design's §9.1 restates it: 250 pieces of
 *  one part at 6.4 lb each, 1,600.00 lb, in 3 baskets of 42.50 lb that hold 252 between them. */
const LINE = { qty: 250, weight: 1600 };
const PART = { partId: "p", eachWeight: 6.4 };
const BASKETS: TotalsContainer = { count: 3, pieces: 252, tareEach: 42.5, scaleGross: null };
const row = (over: Partial<TotalsContainer> = {}): TotalsContainer => ({ ...BASKETS, ...over });

/** Order 1004 with these container rows, unless told otherwise. */
function order(containers: readonly TotalsContainer[], over: Partial<OrderTotalsInput> = {}): OrderTotalsInput {
  return { lines: [LINE], lineParts: [PART], containers, ...over };
}

/** A whole view from the cells the design ever fills. The other five are always empty, and the
 *  Order row's Net and Tare are the two above them. */
function view(
  parts: string, net: string, inContainers: string, tare: string, gross: string,
  note: string | null = null, weighed: string[] = [],
): OrderTotalsView {
  return {
    rows: [
      { heading: "Parts", pieces: parts, net, tare: "", gross: "" },
      { heading: "Containers", pieces: inContainers, net: "", tare, gross: "" },
      { heading: "Order", pieces: "", net, tare, gross },
    ],
    note, weighed,
  };
}

const PAST_THE_CEILING = [{ qty: 1, weight: "9999999999.99" }, { qty: 1, weight: "0.01" }];

describe("the order totals table: its words", () => {
  it("names the table, its columns and its tag (B1, B2, U1)", () => {
    expect(ORDER_TOTALS_CAPTION).toBe("Order totals");
    expect(ORDER_TOTALS_COLUMNS).toEqual(["Pieces", "Net (lb)", "Tare (lb)", "Gross (lb)"]);
    expect(UNSAVED_TOTALS).toBe("Unsaved totals");
  });
});

describe("the Pieces a container row states", () => {
  it("reads a stored number and typed text as a save would send them", () => {
    expect([250, 1, 2147483647].map(statedPieces)).toEqual([250, 1, 2147483647]);
    // `Number` reads these, as both order screens' saves do (the design's §10.7, point 4).
    expect(["15", " 15 ", "15.0", "1e3", "2147483647"].map(statedPieces)).toEqual([15, 15, 15, 1000, 2147483647]);
  });

  it.each([
    ["no value", null], ["an absent value", undefined], ["a blank", ""], ["spaces", "  "],
    ["a typed 0", "0"], ["the number 0", 0], ["a negative", "-3"], ["a decimal", "2.5"],
    ["text", "abc"], ["one past the largest whole number a column holds", "2147483648"],
  ])("states none for %s", (_name, value) => {
    expect(statedPieces(value)).toBeNull();
  });
});

describe("the order totals table: the cells and the note", () => {
  it.each<[string, OrderTotalsInput, OrderTotalsView]>([
    ["order 1004 from stored numbers: 250 and 1,600.00, 252 and 127.50, 1,727.50",
      order([BASKETS]), view("250", "1,600.00", "252", "127.50", "1,727.50")],
    ["order 1004 from typed text",
      order([{ count: "3", pieces: " 252 ", tareEach: "42.50", scaleGross: "" }]),
      view("250", "1,600.00", "252", "127.50", "1,727.50")],
    ["no container rows: Not entered twice, and no gross (W1)",
      order([]), view("250", "1,600.00", "Not entered", "Not entered", "Not available")],
    ["the owner's 14 bins at 310 lb: 4,340.00 of tare",
      order([{ count: 14, pieces: null, tareEach: 310, scaleGross: null }]),
      view("250", "1,600.00", "Not entered", "4,340.00", "5,940.00")],
    // The owner's example gives pieces, not pounds. The 450.00 lb is this case's own figure.
    ["the owner's 3 skids and 1 wire basket with no Tare each on either: Incomplete (point 1)",
      order([{ count: 3, pieces: 15, tareEach: "", scaleGross: "" }, { count: 1, pieces: 15, tareEach: null, scaleGross: null }],
        { lines: [{ qty: 30, weight: 450 }] }),
      view("30", "450.00", "30", "Incomplete", "Not available", "2 rows have no Tare each")],
    ["never a partial tare: a row with a Tare each beside a row without one (P1)",
      order([row({ pieces: 240 }), row({ count: 1, pieces: 10, tareEach: null })]),
      view("250", "1,600.00", "250", "Incomplete", "Not available", "1 row has no Tare each")],
    ["a row left out of Pieces though the sum equals Parts: the table still says so (N1)",
      order([row({ pieces: 250 }), row({ count: 2, pieces: "", tareEach: 60 })]),
      view("250", "1,600.00", "250", "247.50", "1,847.50", "1 row has no Pieces")],
    ["no row states Pieces: Not entered, and no count (point 2)",
      order([row({ pieces: "" }), row({ pieces: null })]),
      view("250", "1,600.00", "Not entered", "255.00", "1,855.00")],
    ["both notes, Pieces first (N3)",
      order([row({ pieces: 250 }), row({ pieces: "", tareEach: "" })]),
      view("250", "1,600.00", "250", "Incomplete", "Not available", "1 row has no Pieces · 1 row has no Tare each")],
    ["groups the counts of rows in both notes",
      order([row({ pieces: 250 }), ...Array.from({ length: 1200 }, () => row({ pieces: null, tareEach: null }))]),
      view("250", "1,600.00", "250", "Incomplete", "Not available", "1,200 rows have no Pieces · 1,200 rows have no Tare each")],
    ["Pieces that are not a figure are left out and counted (point 4)",
      order([row({ pieces: "15" }), row({ pieces: "abc" }), row({ pieces: "0" }), row({ pieces: "2.5" })]),
      view("250", "1,600.00", "15", "510.00", "2,110.00", "3 rows have no Pieces")],
    ["a Tare each typed as far as its decimal point is none (point 4)",
      order([row({ tareEach: "42." })]),
      view("250", "1,600.00", "252", "Incomplete", "Not available", "1 row has no Tare each")],
    ["a Tare each typed without a leading zero is a tare: .5 lb on 3 containers",
      order([row({ tareEach: ".5" })]), view("250", "1,600.00", "252", "1.50", "1,601.50")],
    ["a Tare each beside a blank Containers box: a dash, and no note",
      order([row({ count: "" })]), view("250", "1,600.00", "252", "—", "Not available")],
    ["a Tare each beside a Containers box typed as 3.0: a dash, and no note (point 14)",
      order([row({ count: "3.0" })]), view("250", "1,600.00", "252", "—", "Not available")],
    ["tare totals that together pass the ceiling: a dash",
      order([row({ count: 1, tareEach: "9999999999.99" }), row({ count: 1, tareEach: "0.01" })]),
      view("250", "1,600.00", "504", "—", "Not available")],
    ["a typed Tare each of 0 is a tare: gross equals net",
      order([row({ tareEach: "0" })]), view("250", "1,600.00", "252", "0.00", "1,600.00")],
    ["an empty order entry form: dashes, Not entered and no gross",
      { lines: null, lineParts: [], containers: [] },
      view("—", "—", "Not entered", "Not entered", "Not available")],
    ["order entry while a part line is not complete: dashes, and the tare is kept",
      order([BASKETS], { lines: null }), view("—", "—", "252", "127.50", "Not available")],
    ["a net past the ceiling: a dash, and the pieces are kept",
      order([row({ count: 1, pieces: 1, tareEach: 1 })], { lines: PAST_THE_CEILING }),
      view("2", "—", "1", "1.00", "Not available")],
    ["a net of the ceiling itself, 999,999,999,999 cents: 9,999,999,999.99 to the cent, in Net and in Gross",
      order([row({ count: 1, pieces: 1, tareEach: 0 })], { lines: [{ qty: 1, weight: "9999999999.99" }] }),
      view("1", "9,999,999,999.99", "1", "0.00", "9,999,999,999.99")],
    ["adds every line into Parts and Net, and hands no decimal weight to BigInt",
      order([BASKETS], { lines: [{ qty: 200, weight: 1280.5 }, { qty: 50, weight: "320.25" }] }),
      view("250", "1,600.75", "252", "127.50", "1,728.25")],
    ["groups thousands in both piece figures",
      order([row({ pieces: "1250" })], { lines: [{ qty: 1250, weight: 8000 }] }),
      view("1,250", "8,000.00", "1,250", "127.50", "8,127.50")],
  ])("%s", (_name, input, expected) => {
    expect(orderTotals(input)).toEqual(expected);
  });
});

describe("the order totals table: the weighed lines", () => {
  const OVER = ["Weighed net 1,612.50 lb · 12.50 lb over", "Implied pieces 252 · 2 over"];

  it("shows order 1004 weighed, whole: 1,740.00 on the scale is 12.50 lb and 2 pieces over (G1, G4)", () => {
    expect(orderTotals(order([{ count: "3", pieces: "252", tareEach: "42.5", scaleGross: "1740" }])))
      .toEqual(view("250", "1,600.00", "252", "127.50", "1,727.50", null, OVER));
  });

  it("says why above the line when every row is weighed and tare is incomplete (N2, G8)", () => {
    expect(orderTotals(order([row({ scaleGross: 1740 }), row({ tareEach: "", scaleGross: 12 })])))
      .toEqual(view("250", "1,600.00", "504", "Incomplete", "Not available", "1 row has no Tare each", ["Weighed net not available"]));
  });

  it.each<[string, OrderTotalsInput, string[]]>([
    ["under, and fewer pieces than the parts (G2, G5)",
      order([row({ scaleGross: 1715 })]), ["Weighed net 1,587.50 lb · 12.50 lb under", "Implied pieces 248 · 2 under"]],
    ["equal to the cent, and the same pieces (G3, G6)",
      order([row({ scaleGross: "1727.50" })]), ["Weighed net 1,600.00 lb", "Implied pieces 250"]],
    ["one cent over", order([row({ scaleGross: 1727.51 })]), ["Weighed net 1,600.01 lb · 0.01 lb over", "Implied pieces 250"]],
    ["one cent under", order([row({ scaleGross: "1727.49" })]), ["Weighed net 1,599.99 lb · 0.01 lb under", "Implied pieces 250"]],
    ["nothing with no container rows", order([]), []],
    ["nothing while no row is weighed", order([BASKETS, row({ scaleGross: "" })]), []],
    ["nothing for a Scale gross that is not a figure (point 4)", order([row({ scaleGross: "17." })]), []],
    ["partly weighed, one row without (G7)",
      order([row({ scaleGross: 1740 }), BASKETS]), ["Weighed net not available · 1 row has no Scale gross"]],
    ["partly weighed, two rows without, whatever their tare (G7)",
      order([row({ scaleGross: 1740 }), row({ tareEach: "" }), row({ scaleGross: "abc" })]),
      ["Weighed net not available · 2 rows have no Scale gross"]],
    ["every row weighed and a tare total that cannot be worked out (G8)",
      order([row({ count: "3.0", scaleGross: 1740 })]), ["Weighed net not available"]],
    ["scale grosses that together pass the ceiling (G8, point 6)",
      order([row({ count: 1, tareEach: 0, scaleGross: "9999999999.99" }), row({ count: 1, tareEach: 0, scaleGross: "0.01" })]),
      ["Weighed net not available"]],
    ["a Scale gross below the tare: shown as worked out, and no Implied pieces (point 5)",
      order([row({ scaleGross: 100 })]), ["Weighed net -27.50 lb · 1,627.50 lb under"]],
    ["a weighed net of exactly 0 (point 5)",
      order([row({ scaleGross: 127.5 })]), ["Weighed net 0.00 lb · 1,600.00 lb under", "Implied pieces 0 · 250 under"]],
    ["two parts: no Implied pieces, and Net is both lines (W6)",
      order([row({ scaleGross: 1740 })], { lines: [LINE, { qty: 10, weight: 50 }], lineParts: [PART, { partId: "q", eachWeight: 5 }] }),
      ["Weighed net 1,612.50 lb · 37.50 lb under"]],
    ["a lead line and a rider of one part (W6)",
      order([row({ scaleGross: 1740 })], { lines: [{ qty: 200, weight: 1280 }, { qty: 50, weight: 320 }], lineParts: [PART, PART] }),
      OVER],
    ["a line weight typed over: the weights agree and the pieces do not (W5 with W6)",
      order([row({ tareEach: 0, scaleGross: 1700 })], { lines: [{ qty: 250, weight: 1700 }] }),
      ["Weighed net 1,700.00 lb", "Implied pieces 266 · 16 over"]],
    ["groups an implied figure and both differences",
      order([row({ scaleGross: 1740 })], { lines: [{ qty: 2100, weight: 3150 }], lineParts: [{ partId: "p", eachWeight: 1.5 }] }),
      ["Weighed net 1,612.50 lb · 1,537.50 lb under", "Implied pieces 1,075 · 1,025 under"]],
    ["order entry, a part picked and its line not complete: both figures bare (point 3)",
      order([row({ scaleGross: "1740" })], { lines: null }), ["Weighed net 1,612.50 lb", "Implied pieces 252"]],
    ["order entry, a line with no part: the weighed net alone (point 3)",
      order([row({ scaleGross: "1740" })], { lines: null, lineParts: [{ partId: null, eachWeight: null }] }),
      ["Weighed net 1,612.50 lb"]],
    ["order entry, no part line at all: the weighed net alone (point 3)",
      order([row({ scaleGross: "1740" })], { lines: null, lineParts: [] }), ["Weighed net 1,612.50 lb"]],
    ["a net past the ceiling: no difference, and Implied pieces still held against the parts' (points 3 and 6)",
      order([{ count: 1, pieces: 1, tareEach: 1, scaleGross: 5 }],
        { lines: PAST_THE_CEILING, lineParts: [{ partId: "p", eachWeight: 1 }, { partId: "p", eachWeight: 1 }] }),
      ["Weighed net 4.00 lb", "Implied pieces 4 · 2 over"]],
    // Net is order 1004's 1,600.00 lb. The weighed net is 1.00 less 9,999,999,999.99. Of the three
    // figures this line reads, only their difference, 10,000,001,598.99 lb under, is past the ceiling.
    ["a difference past the ceiling though Net is not: the weighed net bare, as worked out (point 6)",
      order([{ count: 1, pieces: 1, tareEach: "9999999999.99", scaleGross: "1" }]),
      ["Weighed net -9,999,999,998.99 lb"]],
  ])("%s", (_name, input, weighed) => {
    expect(orderTotals(input).weighed).toEqual(weighed);
  });
});

// Order 1004 as the saved order's page holds it, weighed at 1,740.00, and its one container row
// as the Containers grid's boxes hold it once the Scale gross is typed over as 1715. The
// annotations are the page's and the grid's own types, and both are handed to the leaf as they
// are. That they fit is `tsc`'s to hold: vitest checks no types.
const SAVED_1004: Pick<OrderDetail, "lines" | "containers"> = {
  lines: [{
    id: "l1", position: 1, partId: "p", revisionNumber: 1, qty: 250, weight: 1600,
    quoteLineId: null, quoteId: null, quoteNumber: null,
    part: { id: "p", partNumber: "HT-1004", name: "Pin", customer: { code: "ACME" }, serializationRequired: false, eachWeight: 6.4 },
  }],
  containers: [{
    id: "c1", position: 1, typeId: "t1", count: 3, pieces: 252, tareEach: 42.5, scaleGross: 1740,
    customerContainerId: "", type: { name: "Steel Basket" },
  }],
};
const TYPED_1004: ContainerFields[] = [
  { typeId: "t1", count: "3", pieces: "252", tareEach: "42.5", scaleGross: "1715", customerContainerId: "" },
];

describe("the table's input for a saved order", () => {
  it("gives each line's figures, and each line's part with that part's each weight, in order", () => {
    // The rider's weight was typed over: 60 lb for 10 pieces of a part at 5 lb each. So its stored
    // weight is not its quantity times the part's each weight, and that each weight is not its
    // weight over its quantity (owner rulings W5 and W6).
    const rider = { ...SAVED_1004.lines[0], id: "l2", position: 2, partId: "q", qty: 10, weight: 60, part: { ...SAVED_1004.lines[0].part, id: "q", eachWeight: 5 } };
    const input = savedOrderTotalsInput([SAVED_1004.lines[0], rider], SAVED_1004.containers);
    expect(input.lines).toEqual([{ qty: 250, weight: 1600 }, { qty: 10, weight: 60 }]);
    expect(input.lineParts).toEqual([{ partId: "p", eachWeight: 6.4 }, { partId: "q", eachWeight: 5 }]);
    expect(input.containers).toBe(SAVED_1004.containers);
  });

  it("reads the saved rows, and the grid's rows of typed text in their place", () => {
    expect(orderTotals(savedOrderTotalsInput(SAVED_1004.lines, SAVED_1004.containers)).weighed)
      .toEqual(["Weighed net 1,612.50 lb · 12.50 lb over", "Implied pieces 252 · 2 over"]);
    expect(orderTotals(savedOrderTotalsInput(SAVED_1004.lines, TYPED_1004)).weighed)
      .toEqual(["Weighed net 1,587.50 lb · 12.50 lb under", "Implied pieces 248 · 2 under"]);
  });
});

describe("the strip's weight figure", () => {
  const saved = (scaleGross: number | null, tareEach: number | null = 42.5): WeighedOrder =>
    ({ lines: [{ weight: 1600 }], containers: [{ count: 3, tareEach, scaleGross }] });

  it("reads the saved order's page payload as it is (T1, the owner's sentence)", () => {
    expect(weighedFigure(SAVED_1004)).toBe("Net 1,600.00 lb · weighed 1,612.50 lb · 12.50 lb over");
  });

  it.each<[string, WeighedOrder, string]>([
    ["under (T2)", saved(1715), "Net 1,600.00 lb · weighed 1,587.50 lb · 12.50 lb under"],
    ["equal to the cent (T3)", saved(1727.5), "Net 1,600.00 lb · weighed 1,600.00 lb"],
    ["one cent over", saved(1727.51), "Net 1,600.00 lb · weighed 1,600.01 lb · 0.01 lb over"],
    ["one cent under", saved(1727.49), "Net 1,600.00 lb · weighed 1,599.99 lb · 0.01 lb under"],
    ["below zero, as worked out (point 5)", saved(100), "Net 1,600.00 lb · weighed -27.50 lb · 1,627.50 lb under"],
    ["every line's weight in Net",
      { lines: [{ weight: 1600 }, { weight: 50 }], containers: saved(1740).containers },
      "Net 1,650.00 lb · weighed 1,612.50 lb · 37.50 lb under"],
  ])("words it %s", (_name, input, sentence) => {
    expect(weighedFigure(input)).toBe(sentence);
  });

  it.each<[string, WeighedOrder]>([
    ["with no container rows", { lines: [{ weight: 1600 }], containers: [] }],
    ["while no row is weighed", saved(null)],
    ["partly weighed", { lines: [{ weight: 1600 }], containers: [...saved(1740).containers, { count: 1, tareEach: 60, scaleGross: null }] }],
    ["weighed with no Tare each", saved(1740, null)],
    ["when Net is past the ceiling (point 6)", { lines: [{ weight: 9999999999.99 }, { weight: 0.01 }], containers: saved(1740).containers }],
    ["when the difference is past the ceiling (point 6)",
      { lines: [{ weight: 0.01 }], containers: [{ count: 1, tareEach: 9999999999.99, scaleGross: 0 }] }],
  ])("gives none %s", (_name, input) => {
    expect(weighedFigure(input)).toBeNull();
  });
});
