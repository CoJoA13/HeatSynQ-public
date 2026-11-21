import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTravelerPrintRecord, parseTravelerPrintRecord, recordLines, recordLoad,
  serializeTravelerPrintRecord, type PrintRecordOrder, type TravelerPrintRecord,
} from "@/lib/traveler-print-record";

// Lines and loads are given out of order on purpose: the record puts them in order itself.
const order: PrintRecordOrder = {
  lines: [
    { position: 2, partId: "part-rider", qty: 4, weight: 2.05 },
    { position: 1, partId: "part-lead", qty: 30, weight: 30 },
  ],
  loads: [
    { loadNumber: 3, qty: null, weight: 9.8 },
    { loadNumber: 1, qty: 12, weight: 12.25 },
    { loadNumber: 2, qty: 10, weight: null },
  ],
};

const LINES = [
  { partId: "part-lead", qty: 30, weightCents: 3000 },
  { partId: "part-rider", qty: 4, weightCents: 205 },
];
const LOAD_1 = { loadNumber: 1, qty: 12, weightCents: 1225 };
const LOAD_2 = { loadNumber: 2, qty: 10, weightCents: null };
const LOAD_3 = { loadNumber: 3, qty: null, weightCents: 980 };

describe("what a record holds", () => {
  it("records every line in position order, with its weight in whole cents", () => {
    expect(recordLines(order)).toStrictEqual(LINES);
    // The caller's order is not rearranged.
    expect(order.lines.map((line) => line.position)).toEqual([2, 1]);
  });

  it("rounds a float weight to its exact cents", () => {
    expect(2.05 * 100).not.toBe(205); // the reason the leaf rounds
    const summed = { lines: [{ position: 1, partId: "p", qty: 1, weight: 0.1 + 0.2 }], loads: [] };
    expect(recordLines(summed)).toStrictEqual([{ partId: "p", qty: 1, weightCents: 30 }]);
  });

  it("records a load's number, quantity and weight, and keeps what was not entered as null", () => {
    expect(recordLoad({ loadNumber: 1, qty: 12, weight: 12.25 })).toStrictEqual(LOAD_1);
    expect(recordLoad({ loadNumber: 2, qty: 10, weight: null })).toStrictEqual(LOAD_2);
    expect(recordLoad({ loadNumber: 3, qty: null, weight: 9.8 })).toStrictEqual(LOAD_3);
  });
});

describe("buildTravelerPrintRecord", () => {
  it("an all-loads print covers every load, ascending", () => {
    expect(buildTravelerPrintRecord(order, { mode: "all" }))
      .toStrictEqual({ v: 1, lines: LINES, loads: [LOAD_1, LOAD_2, LOAD_3] });
  });

  it("a one-load print covers that load alone, and still records every line", () => {
    expect(buildTravelerPrintRecord(order, { mode: "loads", loadNumbers: [2] }))
      .toStrictEqual({ v: 1, lines: LINES, loads: [LOAD_2] });
  });

  it("a selected-loads print covers the loads selected, ascending", () => {
    expect(buildTravelerPrintRecord(order, { mode: "loads", loadNumbers: [3, 1] }))
      .toStrictEqual({ v: 1, lines: LINES, loads: [LOAD_1, LOAD_3] });
  });

  it("lists only loads the order has", () => {
    expect(buildTravelerPrintRecord(order, { mode: "loads", loadNumbers: [2, 9] }).loads)
      .toStrictEqual([LOAD_2]);
  });

  it("an order with no loads records none", () => {
    expect(buildTravelerPrintRecord({ lines: order.lines, loads: [] }, { mode: "all" }))
      .toStrictEqual({ v: 1, lines: LINES, loads: [] });
  });
});

describe("the stored text", () => {
  const record = buildTravelerPrintRecord(order, { mode: "loads", loadNumbers: [1, 3] });

  it("is the record as JSON, weights as integers", () => {
    expect(serializeTravelerPrintRecord(record)).toBe(
      '{"v":1,"lines":[{"partId":"part-lead","qty":30,"weightCents":3000},'
      + '{"partId":"part-rider","qty":4,"weightCents":205}],'
      + '"loads":[{"loadNumber":1,"qty":12,"weightCents":1225},{"loadNumber":3,"qty":null,"weightCents":980}]}');
  });

  it("reads back as the record it was written from", () => {
    expect(parseTravelerPrintRecord(serializeTravelerPrintRecord(record))).toStrictEqual(record);
    const all = buildTravelerPrintRecord(order, { mode: "all" });
    expect(parseTravelerPrintRecord(serializeTravelerPrintRecord(all))).toStrictEqual(all);
  });
});

describe("parseTravelerPrintRecord reads anything else as no record", () => {
  const good: TravelerPrintRecord = { v: 1, lines: [LINES[0]], loads: [LOAD_1] };
  const text = (value: unknown) => JSON.stringify(value);

  it("accepts the smallest whole record, so the cases below fail for the reason they name", () => {
    expect(parseTravelerPrintRecord(text(good))).toStrictEqual(good);
    expect(parseTravelerPrintRecord(text({ v: 1, lines: [], loads: [] }))).toStrictEqual({ v: 1, lines: [], loads: [] });
  });

  it.each([
    ["null", null], ["undefined", undefined], ["a number", 5], ["the record itself, not its text", good],
    // JSON.parse turns a list into text before it reads it, so only the leaf's own check stops this one.
    ["a list holding a record's text", [text(good)]],
  ])("is null for a value that is not a string: %s", (_name, value) => {
    expect(parseTravelerPrintRecord(value)).toBeNull();
  });

  it.each(["", "{", "not json", '{"v":1,"lines":[],"loads":[]'])("is null for text that is not JSON: %j", (bad) => {
    expect(parseTravelerPrintRecord(bad)).toBeNull();
  });

  it.each(["null", "[]", "5", '"text"', "true"])("is null for JSON that is not an object: %s", (bad) => {
    expect(parseTravelerPrintRecord(bad)).toBeNull();
  });

  it.each([
    ["another version", { ...good, v: 2 }],
    ["the version as text", { ...good, v: "1" }],
    ["no version", { lines: good.lines, loads: good.loads }],
    ["no lines", { v: 1, loads: good.loads }],
    ["no loads", { v: 1, lines: good.lines }],
    ["lines that are not a list", { ...good, lines: { 0: LINES[0] } }],
    ["loads that are not a list", { ...good, loads: "none" }],
    ["a line that is null", { ...good, lines: [null] }],
    ["a line that is a list", { ...good, lines: [[]] }],
    ["a line with no part", { ...good, lines: [{ qty: 30, weightCents: 3000 }] }],
    ["a line whose part is not text", { ...good, lines: [{ ...LINES[0], partId: 7 }] }],
    ["a line with no quantity", { ...good, lines: [{ partId: "part-lead", weightCents: 3000 }] }],
    ["a line whose quantity is null", { ...good, lines: [{ ...LINES[0], qty: null }] }],
    ["a line whose quantity is text", { ...good, lines: [{ ...LINES[0], qty: "30" }] }],
    ["a line whose quantity is not whole", { ...good, lines: [{ ...LINES[0], qty: 1.5 }] }],
    ["a line with no weight", { ...good, lines: [{ partId: "part-lead", qty: 30 }] }],
    ["a line whose weight is text", { ...good, lines: [{ ...LINES[0], weightCents: "3000" }] }],
    ["a line whose weight is past a safe integer", { ...good, lines: [{ ...LINES[0], weightCents: 1e20 }] }],
    ["a load that is null", { ...good, loads: [null] }],
    ["a load that is text", { ...good, loads: ["1"] }],
    ["a load with no number", { ...good, loads: [{ qty: 12, weightCents: 1225 }] }],
    ["a load whose number is null", { ...good, loads: [{ ...LOAD_1, loadNumber: null }] }],
    ["a load with no quantity key", { ...good, loads: [{ loadNumber: 1, weightCents: 1225 }] }],
    ["a load whose quantity is not whole", { ...good, loads: [{ ...LOAD_1, qty: 0.5 }] }],
    ["a load with no weight key", { ...good, loads: [{ loadNumber: 1, qty: 12 }] }],
    ["a load whose weight is text", { ...good, loads: [{ ...LOAD_1, weightCents: "1225" }] }],
    ["one bad load after a good one", { ...good, loads: [LOAD_1, { ...LOAD_2, loadNumber: "2" }] }],
  ])("is null for %s", (_name, value) => {
    expect(parseTravelerPrintRecord(text(value))).toBeNull();
  });

  it("accepts a load whose quantity or weight was not entered", () => {
    const record = { v: 1, lines: [LINES[0]], loads: [LOAD_2, LOAD_3] };
    expect(parseTravelerPrintRecord(text(record))).toStrictEqual(record);
  });

  it("ignores a key it does not know, and answers with the known keys only", () => {
    const later = {
      v: 1, printedBy: "someone",
      lines: [{ ...LINES[0], revisionNumber: 3 }],
      loads: [{ ...LOAD_1, containers: 2 }],
    };
    expect(parseTravelerPrintRecord(text(later))).toStrictEqual(good);
  });
});

describe("the leaf", () => {
  it("is client-safe: its one import is a type", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/traveler-print-record.ts"), "utf8");
    expect(src.match(/^[ \t]*import\s.*$/gm)).toEqual(['import type { TravelerSelection } from "./traveler-selection";']);
  });
});
