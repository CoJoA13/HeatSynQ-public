// The row rules both shipment screens share (the weights design §12.2):
// src/lib/shipment-container-rows.ts. Every function there is pure, so each is run by value.
// What the screens do with them is held elsewhere: the grid view in
// shipment-containers-grid.test.tsx, the saved shipment's recovery in bulk-grid-recovery.test.ts
// and its save in remaining-bulk-callbacks.test.ts, the new-shipment form in
// new-shipment-recovery.test.tsx.
import { describe, expect, it } from "vitest";
import type { ContainerFields, ContainerRow } from "@/app/shipping/ShipmentGrids";
import type { BulkBaseline } from "@/lib/bulk-grid-recovery";
import {
  containerLabels, isKeptContainer, keptFirst, prefillContainerRow, settledContainersBaseline, shipmentContainerFields, shipmentContainersPayload,
  tareEachForSave,
} from "@/lib/shipment-container-rows";

/** A saved row of the grid: 3 containers at 42.5 lb each. */
const row = (over: Partial<ContainerRow> = {}): ContainerRow =>
  ({ key: "sc-1", isNew: false, orderContainerId: "oc-1", count: "3", tareEach: "42.5", ...over });

describe("shipmentContainerFields: a stored row as the grid's three fields", () => {
  it.each([
    [{ orderContainerId: "oc-1", count: 3, tareEach: 42.5 }, { orderContainerId: "oc-1", count: "3", tareEach: "42.5" }],
    [{ orderContainerId: "oc-2", count: 14, tareEach: 310 }, { orderContainerId: "oc-2", count: "14", tareEach: "310" }],
    [{ orderContainerId: "oc-3", count: 1, tareEach: 0 }, { orderContainerId: "oc-3", count: "1", tareEach: "0" }],
    [{ orderContainerId: null, count: 2, tareEach: null }, { orderContainerId: "", count: "2", tareEach: "" }],
  ])("%j reads %j", (stored, fields) => {
    expect(shipmentContainerFields(stored)).toEqual(fields);
  });

  it("names its fields orderContainerId, count, tareEach, in that order, for a stored row and for a row that is added", () => {
    expect(Object.keys(shipmentContainerFields({ orderContainerId: "oc-1", count: 3, tareEach: 42.5 })))
      .toEqual(["orderContainerId", "count", "tareEach"]);
    expect(Object.keys(prefillContainerRow({ id: "oc-1", count: 3, tareEach: 42.5 }))).toEqual(["orderContainerId", "count", "tareEach"]);
  });
});

describe("prefillContainerRow: what a row takes when it is added", () => {
  it.each([[42.5, "42.5"], [310, "310"], [0, "0"], [null, ""], [undefined, ""]] as const)(
    "an order row's tare each of %j fills the box with %j", (tareEach, text) => {
      expect(prefillContainerRow({ id: "oc-1", count: 3, ...(tareEach === undefined ? {} : { tareEach }) }))
        .toEqual({ orderContainerId: "oc-1", count: "3", tareEach: text });
    });
});

describe("a Tare each box: what it sends", () => {
  it.each([["", null], ["   ", null], [" 42.50 ", "42.50"], ["0", "0"], ["42.", "42."]] as const)("a box holding %j sends %j", (text, sent) => {
    expect(tareEachForSave(text)).toBe(sent);
  });
});

describe("containerLabels", () => {
  it("numbers the rows from 1, in the order given", () => {
    expect(containerLabels([row(), row({ key: "sc-2" }), row({ key: "new-1", isNew: true })])).toEqual(["Container 1", "Container 2", "Container 3"]);
  });
});

describe("shipmentContainersPayload: the body of Save containers", () => {
  it("sends every row's number of containers and its tare each, trimmed, a blank box as null, and no kept row", () => {
    expect(shipmentContainersPayload([
      row({ tareEach: " 42.50 " }),
      row({ key: "new-1", isNew: true, orderContainerId: "oc-2", count: " 14 ", tareEach: "  " }),
      row({ key: "sc-3", orderContainerId: "oc-3", count: "1", tareEach: "0" }),
    ])).toEqual({ ok: true, payload: {
      containers: [
        { orderContainerId: "oc-1", count: 3, tareEach: "42.50" },
        { orderContainerId: "oc-2", count: 14, tareEach: null },
        { orderContainerId: "oc-3", count: 1, tareEach: "0" },
      ],
      kept: [],
    } });
  });

  it.each(["", "0", "2.5", "-1", "many"])("refuses a number of containers of %j, naming the row by its label", (count) => {
    expect(shipmentContainersPayload([row(), row({ key: "sc-2", count })]))
      .toEqual({ ok: false, error: "Container 2: containers must be a whole number of at least 1." });
  });

  it.each([
    ["-1", "Container 1, Tare each (lb): cannot be negative."],
    ["heavy", "Container 1, Tare each (lb): enter a number without $ or commas, such as 0.36."],
    ["1e2", "Container 1, Tare each (lb): enter a number without $ or commas, such as 0.36."],
    ["42.555", "Container 1, Tare each (lb): use at most 2 digits after the point."],
    ["12345678901", "Container 1, Tare each (lb): must be less than 10,000,000,000."],
  ])("refuses a tare each of %j through the one rule, naming the row and the box", (tareEach, error) => {
    expect(shipmentContainersPayload([row({ tareEach })])).toEqual({ ok: false, error });
  });

  it("lists every refusal, one per line: rows in the order given, and within a row the number of containers before the tare each", () => {
    expect(shipmentContainersPayload([row({ count: "0", tareEach: "-1" })])).toEqual({ ok: false, error: [
      "Container 1: containers must be a whole number of at least 1.",
      "Container 1, Tare each (lb): cannot be negative.",
    ].join("\n") });
    expect(shipmentContainersPayload([row({ tareEach: "-1" }), row({ key: "sc-2", count: "0" })])).toEqual({ ok: false, error: [
      "Container 1, Tare each (lb): cannot be negative.",
      "Container 2: containers must be a whole number of at least 1.",
    ].join("\n") });
  });
});

describe("settledContainersBaseline: the baseline a save settles to", () => {
  const submitted: BulkBaseline<ContainerFields> = {
    rows: [{ id: "sc-1", fields: { orderContainerId: "oc-1", count: "3", tareEach: "42.5" } }],
    context: { shipperId: "ship-1", editable: true },
  };
  /** A container row of the save's answer. */
  const answered = (id: string, orderContainerId: string | null, count: number, tareEach: number | null) =>
    ({ id, orderContainerId, typeName: "Steel Basket", customerContainerId: "", count, tareEach, position: 1 });

  it("a save settles to every row of the answer, kept rows first, each with the answer's own figure, and keeps the submitted context", () => {
    expect(settledContainersBaseline(submitted, { containers: [
      answered("sc-9", "oc-1", 4, 40.25), answered("sc-k", null, 2, 30), answered("sc-8", "oc-2", 1, null),
    ] })).toEqual({
      rows: [
        { id: "sc-k", fields: { orderContainerId: "", count: "2", tareEach: "30" } },
        { id: "sc-9", fields: { orderContainerId: "oc-1", count: "4", tareEach: "40.25" } },
        { id: "sc-8", fields: { orderContainerId: "oc-2", count: "1", tareEach: "" } },
      ],
      context: { shipperId: "ship-1", editable: true },
    });
  });
});

// ---- kept container rows (the weights design §12.2 and §12.3: V2, A2, and V1's and V4's numbering) ----

describe("kept container rows in the row rules", () => {
  /** A kept row as the grid holds it: the shipment row's own id as its key, and no order container. */
  const kept = (key: string, tareEach: string, count = "3"): ContainerRow => ({ key, isNew: false, orderContainerId: "", count, tareEach });
  const linked = (key: string, orderContainerId: string, count: string, tareEach: string): ContainerRow =>
    ({ key, isNew: false, orderContainerId, count, tareEach });

  it("a kept row is the row with no order container", () => {
    expect([isKeptContainer({ orderContainerId: "" }), isKeptContainer({ orderContainerId: "oc-1" })]).toEqual([true, false]);
  });

  it("keptFirst lists the stored rows with no order container first, each kind in the order given", () => {
    const stored = [{ id: "a", orderContainerId: "oc-1" }, { id: "b", orderContainerId: null }, { id: "c", orderContainerId: "oc-2" }, { id: "d", orderContainerId: null }];
    expect(keptFirst(stored).map((row) => row.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("each kind is numbered apart, so the first row that is not kept is Container 1 wherever it stands", () => {
    expect(containerLabels([{ orderContainerId: "" }, { orderContainerId: "oc-1" }, { orderContainerId: "" }, { orderContainerId: "oc-2" }]))
      .toEqual(["Kept container 1", "Container 1", "Kept container 2", "Container 2"]);
  });

  it("Save containers sends every kept row by the shipment row's id with its tare each alone, a blank as null", () => {
    expect(shipmentContainersPayload([kept("sc-9", " 42.5 "), kept("sc-8", ""), linked("sc-1", "oc-1", "2", "30")])).toEqual({ ok: true, payload: {
      containers: [{ orderContainerId: "oc-1", count: 2, tareEach: "30" }],
      kept: [{ id: "sc-9", tareEach: "42.5" }, { id: "sc-8", tareEach: null }],
    } });
  });

  it("a kept row's number of containers is not typed, so it is not checked", () => {
    expect(shipmentContainersPayload([kept("sc-9", "42.5", "0")])).toEqual({ ok: true, payload: { containers: [], kept: [{ id: "sc-9", tareEach: "42.5" }] } });
  });

  it.each([
    ["a kept row's tare each below zero, before a later row's number of containers",
      [kept("sc-9", "-1"), linked("sc-1", "oc-1", "0", "30")],
      "Kept container 1, Tare each (lb): cannot be negative.\nContainer 1: containers must be a whole number of at least 1."],
    ["a second kept row's tare each that is not a number",
      [kept("sc-9", "42.5"), kept("sc-8", "x")], "Kept container 2, Tare each (lb): enter a number without $ or commas, such as 0.36."],
    ["a kept row's tare each with three decimals",
      [kept("sc-9", "42.555")], "Kept container 1, Tare each (lb): use at most 2 digits after the point."],
    ["the first row that is not kept, drawn under a kept row: its number of containers",
      [kept("sc-9", "42.5"), linked("sc-1", "oc-1", "0", "30")], "Container 1: containers must be a whole number of at least 1."],
    ["the same row: its tare each",
      [kept("sc-9", "42.5"), linked("sc-1", "oc-1", "2", "-3")], "Container 1, Tare each (lb): cannot be negative."],
  ])("refuses %s", (_what, rows, error) => {
    expect(shipmentContainersPayload(rows)).toEqual({ ok: false, error });
  });

  it("lists every refusal of a grid holding kept rows, each kind named by its own label, in the order drawn", () => {
    expect(shipmentContainersPayload([
      kept("sc-9", "1e2", "0"), kept("sc-8", "42.5"), linked("sc-1", "oc-1", "2.5", "30.125"), linked("sc-2", "oc-2", "1", "-0.01"),
    ])).toEqual({ ok: false, error: [
      "Kept container 1, Tare each (lb): enter a number without $ or commas, such as 0.36.",
      "Container 1: containers must be a whole number of at least 1.",
      "Container 1, Tare each (lb): use at most 2 digits after the point.",
      "Container 2, Tare each (lb): cannot be negative.",
    ].join("\n") });
  });
});
