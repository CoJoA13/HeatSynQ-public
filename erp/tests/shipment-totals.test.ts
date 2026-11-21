// erp/tests/shipment-totals.test.ts
import { describe, expect, it } from "vitest";
import type { TareRow, WeightInput } from "@/lib/net-weight";
import { orderTotals } from "@/lib/order-totals";
import {
  NO_REPORTS, SHIPMENT_TOTALS_CAPTION, SHIPMENT_TOTALS_COLUMNS, containersReport, linesReport, newShipmentTotalsInput,
  savedShipmentTotalsInput, shipmentTotals, totalsForCaption, withReport,
  type ContainersReport, type LinesReport, type ShipmentReports, type ShipmentTotalsOrder, type ShipmentTotalsView,
  type TotalsReport, type TotalsTableView,
} from "@/lib/shipment-totals";

// A shipment's totals tables (the weights design §12.2 and §12.3, T1 to T16), and their input on
// the two shipment pages. Hand-calculated shipments. A table is compared whole: its caption, its
// three cells, the line under it and its tag. How a figure is read from typed text is
// net-weight.test.ts's to hold. No server, no database and no renderer are needed.

const table = (
  caption: string, net: string, tare: string, gross: string, note: string | null = null, unsaved = false,
): TotalsTableView => ({ caption, net, tare, gross, note, unsaved });
const on = (label: string, lineWeights: WeightInput[], containers: TareRow[] = []): ShipmentTotalsOrder =>
  ({ label, lineWeights, containers });

/** The design's §12.1: order 1031 is 1,600.00 lb in 3 baskets at 42.50 lb, and order 1032 is
 *  450.00 lb with no container row. Order 1033 is 4,000.00 lb in 14 bins at 310 lb, as typed text. */
const BASKETS: TareRow = { count: 3, tareEach: 42.5 };
const O1031 = on("1031-1", [1600], [BASKETS]);
const O1032 = on("1032-1", [450]);
const O1033 = on("1033-1", ["4000.00"], [{ count: "14", tareEach: "310" }]);
const T1031 = table("Totals for 1031-1", "1,600.00", "127.50", "1,727.50");
const T1032 = table("Totals for 1032-1", "450.00", "Not entered", "Not available");
/** A shipment of the one order 1031-1: its table and the shipment's read the same. */
const alone = (net: string, tare: string, gross: string, note: string | null = null): ShipmentTotalsView => ({
  orders: [table("Totals for 1031-1", net, tare, gross, note)],
  shipment: table("Shipment totals", net, tare, gross, note),
});

describe("a shipment's totals tables: their words", () => {
  it("names the shipment's table and heads the three columns (T1, T4)", () => {
    expect(SHIPMENT_TOTALS_CAPTION).toBe("Shipment totals");
    expect(SHIPMENT_TOTALS_COLUMNS).toEqual(["Net (lb)", "Tare (lb)", "Gross (lb)"]);
  });

  it("names an order's table for the order: 1031-1 on a saved shipment, #1031 on the form (T2, T3)", () => {
    expect([totalsForCaption("1031-1"), totalsForCaption("#1031")]).toEqual(["Totals for 1031-1", "Totals for #1031"]);
  });
});

describe("a shipment of one order: every state of a table, the same in both", () => {
  it.each<[string, WeightInput[], TareRow[], ShipmentTotalsView]>([
    ["complete, from stored numbers (T5)", [1600], [BASKETS], alone("1,600.00", "127.50", "1,727.50")],
    ["every line and every row added up", [1000, "600.00"], [BASKETS, { count: "2", tareEach: "30" }], alone("1,600.00", "187.50", "1,787.50")],
    ["a kept row and the same containers added again count twice (issue #493)", [1600], [BASKETS, BASKETS], alone("1,600.00", "255.00", "1,855.00")],
    ["no container row (T7, T9)", [1600], [], alone("1,600.00", "Not entered", "Not available")],
    ["never a partial tare: a row with no Tare each beside a row with one (T8, T11)",
      [1600], [{ count: 3, tareEach: null }, { count: 2, tareEach: 30 }], alone("1,600.00", "Incomplete", "Not available", "1 row has no Tare each")],
    ["two rows with no Tare each, as on a shipment saved before the app kept one",
      [1600], [{ count: 3, tareEach: null }, { count: 2, tareEach: "" }], alone("1,600.00", "Incomplete", "Not available", "2 rows have no Tare each")],
    ["a Tare each typed as far as its point is none", [1600], [{ count: "3", tareEach: "42." }], alone("1,600.00", "Incomplete", "Not available", "1 row has no Tare each")],
    ["a number of containers typed as 3.0 beside a Tare each: a dash, and no line under (T10)", [1600], [{ count: "3.0", tareEach: "42.5" }], alone("1,600.00", "—", "Not available")],
    ["a tare total past the ceiling: a dash, and no line under", [1], [{ count: 2, tareEach: "9999999999.99" }], alone("1.00", "—", "Not available")],
    ["an empty Ship now net weight box: a dash, and the tare is kept (T10)", ["", "48"], [BASKETS], alone("—", "127.50", "Not available")],
    ["a Ship now net weight typed as far as its point", ["48."], [BASKETS], alone("—", "127.50", "Not available")],
    ["a figure below zero in a Ship now net weight box is added as typed", ["-5", "48"], [BASKETS], alone("43.00", "127.50", "170.50")],
    ["a net of the ceiling itself, to the cent", ["9999999999.99"], [{ count: 1, tareEach: 0 }], alone("9,999,999,999.99", "0.00", "9,999,999,999.99")],
    ["a net past the ceiling: a dash", ["9999999999.99", "0.01"], [BASKETS], alone("—", "127.50", "Not available")],
    ["no line: a Net of 0.00, and a Gross equal to the Tare (T14, answer 3)", [], [BASKETS], alone("0.00", "127.50", "127.50")],
    ["no line and no container row", [], [], alone("0.00", "Not entered", "Not available")],
    ["a reversal of one order (T15)", [-1850.5], [], alone("-1,850.50", "Not entered", "Not available")],
  ])("%s", (_name, lineWeights, containers, expected) => {
    const view = shipmentTotals([on("1031-1", lineWeights, containers)]);
    expect(view).toEqual(expected);
    // The order totals leaf words a Tare cell and a Gross cell in a branch of its own
    // (src/lib/order-totals.ts). Its Order row for the same line weights and container rows reads
    // the same three cells as this order's table.
    const order = orderTotals({
      lines: lineWeights.map((weight) => ({ qty: 1, weight })), lineParts: [],
      containers: containers.map((row) => ({ ...row, pieces: null, scaleGross: null })),
    }).rows[2];
    expect([view.orders[0].net, view.orders[0].tare, view.orders[0].gross]).toEqual([order.net, order.tare, order.gross]);
  });
});

describe("Shipment totals over several orders", () => {
  const noTare = on("1031-1", [1600], [{ count: 3, tareEach: null }]);
  const T_NO_TARE = table("Totals for 1031-1", "1,600.00", "Incomplete", "Not available", "1 row has no Tare each");

  it.each<[string, ShipmentTotalsOrder[], ShipmentTotalsView]>([
    ["adds up every order's Net and Tare, typed text beside stored numbers (T6)", [O1031, O1033], {
      orders: [T1031, table("Totals for 1033-1", "4,000.00", "4,340.00", "8,340.00")],
      shipment: table("Shipment totals", "5,600.00", "4,467.50", "10,067.50"),
    }],
    ["has no Gross when an order has no containers, keeps the listed rows' Tare, and says so (T16, T12; answers 1 and 2)", [O1031, O1032], {
      orders: [T1031, T1032],
      shipment: table("Shipment totals", "2,050.00", "127.50", "Not available", "1 order has no containers"),
    }],
    ["counts the orders with no containers", [O1031, O1032, on("1034-1", [10])], {
      orders: [T1031, T1032, table("Totals for 1034-1", "10.00", "Not entered", "Not available")],
      shipment: table("Shipment totals", "2,060.00", "127.50", "Not available", "2 orders have no containers"),
    }],
    ["says the row sentence first when both show (T11 with T12)", [noTare, O1032], {
      orders: [T_NO_TARE, T1032],
      shipment: table("Shipment totals", "2,050.00", "Incomplete", "Not available", "1 row has no Tare each · 1 order has no containers"),
    }],
    ["counts the rows with no Tare each over every order, and each order's own under its table",
      [noTare, on("1033-1", [4000], [{ count: 14, tareEach: "" }, { count: 1, tareEach: 5 }])], {
        orders: [T_NO_TARE, table("Totals for 1033-1", "4,000.00", "Incomplete", "Not available", "1 row has no Tare each")],
        shipment: table("Shipment totals", "5,600.00", "Incomplete", "Not available", "2 rows have no Tare each"),
      }],
    ["says nothing under the table when no order has a container row", [on("1031-1", [1600]), O1032], {
      orders: [table("Totals for 1031-1", "1,600.00", "Not entered", "Not available"), T1032],
      shipment: table("Shipment totals", "2,050.00", "Not entered", "Not available"),
    }],
    ["an order just added, with no line and no container row, beside a complete one", [O1031, on("1040-1", [])], {
      orders: [T1031, table("Totals for 1040-1", "0.00", "Not entered", "Not available")],
      shipment: table("Shipment totals", "1,600.00", "127.50", "Not available", "1 order has no containers"),
    }],
    ["a reversal of two orders: each table its own figure", [on("1031-2", [-1600, -250.5]), on("1032-2", [-450])], {
      orders: [
        table("Totals for 1031-2", "-1,850.50", "Not entered", "Not available"),
        table("Totals for 1032-2", "-450.00", "Not entered", "Not available"),
      ],
      shipment: table("Shipment totals", "-2,300.50", "Not entered", "Not available"),
    }],
    ["a net past the ceiling over two orders that are each within it",
      [on("9-1", ["9999999999.99"], [{ count: 1, tareEach: 0 }]), on("9-2", ["0.01"], [{ count: 1, tareEach: 0 }])], {
        orders: [table("Totals for 9-1", "9,999,999,999.99", "0.00", "9,999,999,999.99"), table("Totals for 9-2", "0.01", "0.00", "0.01")],
        shipment: table("Shipment totals", "—", "0.00", "Not available"),
      }],
    ["no order: no table for the shipment", [], { orders: [], shipment: null }],
  ])("%s", (_name, orders, expected) => {
    expect(shipmentTotals(orders)).toEqual(expected);
  });

  it("groups the count of orders with no containers", () => {
    const bare = Array.from({ length: 1200 }, (_, index) => on(`${2000 + index}-1`, [1]));
    expect(shipmentTotals([O1031, ...bare]).shipment?.note).toBe("1,200 orders have no containers");
  });

  it("tags the order whose input says unsaved, and the shipment when any order's does (T13)", () => {
    // That an order which says nothing is not tagged is held by every whole table of this file.
    const typed = shipmentTotals([{ ...O1031, unsaved: true }, { ...O1032, unsaved: false }, O1033]);
    expect([...typed.orders.map((one) => one.unsaved), typed.shipment?.unsaved]).toEqual([true, false, false, true]);
  });
});

describe("what a grid of a saved shipment hands up", () => {
  it("hands up nothing until the grid has a baseline", () => {
    expect([linesReport(false, [{ weight: 1000 }], [{ weight: "600" }], true), containersReport(false, [BASKETS], true)])
      .toEqual([null, null]);
  });

  it("hands up the kept lines' saved weights, then each row's weight box as typed", () => {
    expect(linesReport(true, [{ weight: 1000 }], [{ weight: "650" }, { weight: "" }], true))
      .toEqual({ lineWeights: [1000, "650", ""], unsaved: true });
  });

  it("hands up each container row's number of containers and tare each, and nothing more of the row", () => {
    const rows = [
      { key: "c1", orderContainerId: "oc-1", count: "5", tareEach: "42.5" },
      { key: "c2", orderContainerId: "", count: "3", tareEach: "" },
    ];
    expect(containersReport(true, rows, false))
      .toEqual({ containers: [{ count: "5", tareEach: "42.5" }, { count: "3", tareEach: "" }], unsaved: false });
  });

  it("hands up the grid's own unsaved flag, whichever it is", () => {
    expect([
      linesReport(true, [], [], false), linesReport(true, [], [], true),
      containersReport(true, [], false), containersReport(true, [], true),
    ]).toEqual([
      { lineWeights: [], unsaved: false }, { lineWeights: [], unsaved: true },
      { containers: [], unsaved: false }, { containers: [], unsaved: true },
    ]);
  });
});

describe("how the page keeps the grids' reports", () => {
  const LINES: LinesReport = { lineWeights: [1000, "650"], unsaved: true };
  const ROWS: ContainersReport = { containers: [{ count: "5", tareEach: "42.5" }], unsaved: false };
  const OTHER = { lines: { lineWeights: [450], unsaved: false } };
  const HELD: ShipmentReports = { "so-1": { lines: LINES, containers: ROWS }, "so-2": OTHER };

  it("puts a report in under its order, in a new object", () => {
    expect(withReport(NO_REPORTS, "so-1", { part: "lines", value: LINES })).toEqual({ "so-1": { lines: LINES } });
    expect(NO_REPORTS).toEqual({});
  });

  it("puts a second part beside the first, and keeps the other orders' reports", () => {
    expect(withReport({ "so-1": { lines: LINES }, "so-2": OTHER }, "so-1", { part: "containers", value: ROWS })).toEqual(HELD);
  });

  it.each<[string, TotalsReport]>([
    ["the lines' flag", { part: "lines", value: { lineWeights: [1000, "650"], unsaved: false } }],
    ["a line's weight", { part: "lines", value: { lineWeights: [1000, "651"], unsaved: true } }],
    ["a line more", { part: "lines", value: { lineWeights: [1000, "650", ""], unsaved: true } }],
    ["a line fewer", { part: "lines", value: { lineWeights: [1000], unsaved: true } }],
    ["the containers' flag", { part: "containers", value: { containers: [{ count: "5", tareEach: "42.5" }], unsaved: true } }],
    ["a row's number of containers", { part: "containers", value: { containers: [{ count: "6", tareEach: "42.5" }], unsaved: false } }],
    ["a row's tare each", { part: "containers", value: { containers: [{ count: "5", tareEach: "42.50" }], unsaved: false } }],
    ["a row more", { part: "containers", value: { containers: [{ count: "5", tareEach: "42.5" }, { count: "1", tareEach: "" }], unsaved: false } }],
    ["a row fewer", { part: "containers", value: { containers: [], unsaved: false } }],
  ])("takes a report that differs from the one held by %s", (_name, report) => {
    expect(withReport(HELD, "so-1", report)).toEqual({ "so-1": { ...HELD["so-1"], [report.part]: report.value }, "so-2": OTHER });
  });

  it.each<[string, string, TotalsReport]>([
    ["the same lines", "so-1", { part: "lines", value: { lineWeights: [1000, "650"], unsaved: true } }],
    ["the same container rows", "so-1", { part: "containers", value: { containers: [{ count: "5", tareEach: "42.5" }], unsaved: false } }],
    ["no report, for an order that has none", "so-3", { part: "lines", value: null }],
    ["no container rows, for an order that has reported its lines alone", "so-2", { part: "containers", value: null }],
  ])("answers the object it was handed when the report says what is already held: %s", (_name, orderKey, report) => {
    expect(withReport(HELD, orderKey, report)).toBe(HELD);
  });

  it("takes a part away on null, and the order's key with its last part", () => {
    const withoutLines = withReport(HELD, "so-1", { part: "lines", value: null });
    expect(withoutLines).toStrictEqual({ "so-1": { containers: ROWS }, "so-2": OTHER });
    expect(withReport(withoutLines, "so-1", { part: "containers", value: null })).toStrictEqual({ "so-2": OTHER });
  });
});

describe("the tables' input on a saved shipment", () => {
  /** The page's saved rows, with more than the tables read of each. */
  const SAVED = [
    {
      id: "so-1", label: "1031-1",
      lines: [{ id: "l1", qty: 150, weight: 1000 }, { id: "l2", qty: 100, weight: 600 }],
      containers: [{ id: "c1", orderContainerId: "oc-1", typeName: "Steel Basket", count: 3, tareEach: 42.5 }],
    },
    { id: "so-2", label: "1032-1", lines: [{ id: "l3", qty: 30, weight: 450 }], containers: [] },
  ];

  it.each<[string, ShipmentReports]>([
    ["for a grid that has reported nothing", NO_REPORTS],
    ["and not a report under a key no order has", { "so-9": { lines: { lineWeights: ["1"], unsaved: true } } }],
  ])("reads the page's saved rows %s", (_name, reports) => {
    expect(savedShipmentTotalsInput(SAVED, reports)).toEqual([
      { label: "1031-1", lineWeights: [1000, 600], containers: [{ count: 3, tareEach: 42.5 }], unsaved: false },
      { label: "1032-1", lineWeights: [450], containers: [], unsaved: false },
    ]);
  });

  it.each<[string, ShipmentReports, ShipmentTotalsOrder]>([
    ["the Lines grid's report in place of the saved lines", { "so-1": { lines: { lineWeights: [1000, "650"], unsaved: true } } },
      { label: "1031-1", lineWeights: [1000, "650"], containers: [{ count: 3, tareEach: 42.5 }], unsaved: true }],
    ["the Containers grid's report in place of the saved rows", { "so-1": { containers: { containers: [{ count: "5", tareEach: "42.5" }], unsaved: true } } },
      { label: "1031-1", lineWeights: [1000, 600], containers: [{ count: "5", tareEach: "42.5" }], unsaved: true }],
    ["both reports, a grid emptied of its rows among them, and neither unsaved",
      { "so-1": { lines: { lineWeights: ["1600"], unsaved: false }, containers: { containers: [], unsaved: false } } },
      { label: "1031-1", lineWeights: ["1600"], containers: [], unsaved: false }],
  ])("reads %s", (_name, reports, first) => {
    expect(savedShipmentTotalsInput(SAVED, reports)[0]).toEqual(first);
  });

  it("gives the saved page's tables as typed: the kept line counted, and the tag on the order and on the shipment", () => {
    const lines = withReport(NO_REPORTS, "so-1", { part: "lines", value: linesReport(true, [{ weight: 1000 }], [{ weight: "650" }], true) });
    const both = withReport(lines, "so-1", { part: "containers", value: containersReport(true, [{ count: "5", tareEach: "42.5" }], false) });
    expect(shipmentTotals(savedShipmentTotalsInput(SAVED, both))).toEqual({
      orders: [table("Totals for 1031-1", "1,650.00", "212.50", "1,862.50", null, true), T1032],
      shipment: table("Shipment totals", "2,100.00", "212.50", "Not available", "1 order has no containers", true),
    });
  });
});

describe("the tables' input on the new-shipment form", () => {
  it("labels each picked order with # and its number, reads each line's weight box and each row's two boxes, and marks nothing unsaved", () => {
    /** A picked order as the form holds it, with more than the tables read of it. */
    const selected = [{
      orderId: "o-1", orderNumber: 1031,
      lines: [{ key: "l1", orderLineId: "ol-1", qty: "250", weight: "1600.00", lineComplete: "false" }],
      containers: [{ key: "c1", orderContainerId: "oc-1", count: "3", tareEach: "42.5" }],
    }];
    // Strict: an `unsaved` key, or a key of the row beyond the two, fails here.
    expect(newShipmentTotalsInput(selected)).toStrictEqual([
      { label: "#1031", lineWeights: ["1600.00"], containers: [{ count: "3", tareEach: "42.5" }] },
    ]);
  });
});
